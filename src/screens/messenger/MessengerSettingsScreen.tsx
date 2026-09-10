import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput,
  Switch, StatusBar, AppState,
} from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {MessengerStackParamList} from '@navigation/types';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {Colors} from '@theme/index';
import {UsersHttpClient, type Me, type BlockedUser} from '@bravo/messenger-core';
import {API_BASE_URL} from '@utils/constants';
import {tokenStore} from '@services/api';
import KeyboardAvoidingScreen from '@components/KeyboardAvoidingScreen';
import {setReadReceiptsEnabled as cacheReadReceiptsEnabled} from '@/modules/messenger/store/privacySettings';
import {setBlockedPeers, removeBlockedPeer} from '@/modules/messenger/runtime/blockedPeers';
import {readBackupEnabledSource} from '@/modules/messenger/backup/backupFlags';
import {useVaultStore, vaultHydrated, vaultPersistApi} from '@/modules/messenger/vault';
import {findNavigatorWithRoute, navigateVia} from '@navigation/departmentalEntry';
import {useAuthStore} from '@store/authStore';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';
import LoadingView from '@components/LoadingView';

/**
 * Messenger profile + privacy + blocked-users pane. Pulls `/users/me`
 * on mount, lets the user edit display name / bio / avatar URL, flip
 * last-seen + read-receipt visibility, and unblock previously-blocked
 * users. Block is initiated from ChatInfoScreen; unblock lives here
 * so it's never more than two taps away.
 */
type Nav = NativeStackNavigationProp<MessengerStackParamList, 'MessengerSettings'>;

type PrivacyField = 'lastSeenVisible' | 'readReceiptsEnabled';

/**
 * Latest-wins sequencer for optimistic toggles. `begin(fields)` bumps a
 * per-field request seq and returns an `isLatest()` probe; a request may
 * commit or revert its fields only while it is still the newest one.
 */
// Why: SET-08 — burst taps race their HTTP round-trips; an older response
// resolving late clobbered the newest tap's optimistic state.
export function createLatestWins<K extends string>(): (fields: K[]) => () => boolean {
  const seq = new Map<K, number>();
  return fields => {
    const mine = fields.map(f => {
      const n = (seq.get(f) ?? 0) + 1;
      seq.set(f, n);
      return [f, n] as const;
    });
    return () => mine.every(([f, n]) => seq.get(f) === n);
  };
}

/** What the hardware probe below decided; `unknown` = it has not answered yet. */
type VaultBioProbe = 'unknown' | 'none' | 'weak' | 'available';

/** A probe that never settles must read as UNAVAILABLE, not leave the row
 *  permanently undecided (and therefore permanently un-turn-off-able). */
const VAULT_BIO_PROBE_TIMEOUT_MS = 4000;

/**
 * `getEnrolledLevelAsync`, NOT `hasHardwareAsync` + `isEnrolledAsync`.
 *
 * On Android that pair is `canAuthenticate(BIOMETRIC_WEAK) == SUCCESS`, so an
 * Android LOCKOUT (5 failed attempts), HW_UNAVAILABLE and
 * SECURITY_UPDATE_REQUIRED all read as "this device has no biometrics" — see
 * the long note in BiometricGate.tsx, where that misreading was a fail-OPEN.
 * Here it would be a fail-STUCK: the row disabled at exactly the moment a user
 * whose biometric just broke wants to turn it off.
 *
 * `SECRET` counts as UNAVAILABLE here, unlike BiometricGate's reading of the
 * same enum. BiometricGate asks "does this device hold any secret at all",
 * because it will happily accept the screen-lock code. This row arms a
 * BIOMETRIC unlock: a screen-lock-only device (and an Android biometric in
 * LOCKOUT, which also reads SECRET) would take the flag and then be unable to
 * serve the keypad's fingerprint key, which is the dead-switch class. The
 * enrol hint is the truthful answer there.
 */
async function probeVaultBiometric(): Promise<Exclude<VaultBioProbe, 'unknown'>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const level = await Promise.race([
      LocalAuthentication.getEnrolledLevelAsync(),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), VAULT_BIO_PROBE_TIMEOUT_MS); }),
    ]);
    if (level === null
        || level === LocalAuthentication.SecurityLevel.NONE
        || level === LocalAuthentication.SecurityLevel.SECRET) {return 'none';}
    if (level === LocalAuthentication.SecurityLevel.BIOMETRIC_WEAK) {return 'weak';}
    return 'available';
  } catch {
    return 'none';
  } finally {
    // A race settles the PROMISE, not the loser. Without this the timeout keeps
    // running once per focus AND once per foreground — a 4-second wake-up each,
    // for a value nobody will read.
    if (timer !== undefined) {clearTimeout(timer);}
  }
}

export default function MessengerSettingsScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const client = useMemo(
    () => new UsersHttpClient({
      baseUrl:      API_BASE_URL,
      getToken:     () => tokenStore.get(),
      // Round 2: drive the single-flight refresh chain on 401 mid-session.
      refreshToken: () => require('@/services/api').refreshAccessTokenShared() as Promise<void>,
    }),
    [],
  );

  const [me, setMe]       = useState<Me | null>(null);
  const [blocked, setBlocked] = useState<BlockedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio]                 = useState('');
  const [avatarUrl, setAvatarUrl]     = useState('');
  const [backupEnabled, setBackupEnabled] = useState(false);
  // P3-B-2 — canonical owner (email ?? phone ?? id), same scoping the
  // keychain + backup boot gate use for owner-keyed flags.
  const ownerKey = useAuthStore(s => s.user?.email ?? s.user?.phone_e164 ?? s.user?.id ?? null);
  // N-16 — message-content preview in notifications is a privacy choice; OFF by
  // default (name-only banner) so plaintext never leaves the runtime into a
  // notification. Opt-in here.
  const [notifPreview, setNotifPreview] = useState(true); // B-65 — default ON

  // ── FILE VAULT · biometric unlock (B-459 follow-up: the off-ramp) ──────────
  // The file's FIRST store-backed Switch: `value` and visibility read the vault
  // store through selectors, with no local mirror and no optimistic flip. The
  // write is synchronous and local, so there is nothing to be optimistic about
  // — and a mirror would drift the moment anything ELSE wrote the flag
  // (setupPin, verifyPin's malformed-record branch, sign-out's reset()).
  const vaultBiometricOn = useVaultStore(s => s.biometricEnabled);
  const vaultHasPin      = useVaultStore(s => s.hasPin());
  const [vaultReady, setVaultReady]   = useState(() => vaultHydrated());
  const [vaultBioProbe, setVaultBioProbe] = useState<VaultBioProbe>('unknown');
  const bioProofPending = useRef(false);
  const bioAlertPending = useRef(false);
  const vaultBioSeq = useRef(createLatestWins<'vaultBiometric'>()).current;

  // The same LOAD-BEARING hydration rule FilesScreen/VaultScreen run: until the
  // AsyncStorage record lands, `pinHash` is initialState's null — which is
  // indistinguishable from "this user has no PIN" and would hide the row from
  // precisely the users who own the flag.
  useEffect(() => {
    if (vaultReady) {return;}
    const p = vaultPersistApi();
    if (!p?.onFinishHydration || p.hasHydrated?.() === true) {setVaultReady(true); return;}
    return p.onFinishHydration(() => setVaultReady(true));
  }, [vaultReady]);

  // The probe is bounded but still async, so it can outlive the focus that
  // started it — or the screen itself. Every start claims a token and writes
  // only while that token is still current; BOTH effect cleanups below (blur
  // and unmount) bump it, so a late answer is dropped instead of repainting a
  // row nobody is looking at.
  const bioProbeToken = useRef(0);
  // Reads the ref at CALL time, not at effect-setup time. That is the whole
  // point — a snapshot captured when the effect ran would fail to supersede a
  // probe started after it, and let the stale answer through.
  const invalidateBioProbe = useCallback(() => { bioProbeToken.current++; }, []);
  const refreshVaultBioProbe = useCallback(() => {
    const mine = ++bioProbeToken.current;
    void probeVaultBiometric().then(p => {
      if (bioProbeToken.current === mine) {setVaultBioProbe(p);}
    });
  }, []);
  // Focus AND AppState-active. `useFocusEffect` does NOT fire on
  // background→foreground, and "delete your fingerprints in device settings and
  // come back" is exactly a background round trip — the user would otherwise
  // arm the toggle against a stale "available". FilesScreen/VaultScreen pair
  // the same two listeners for the same reason. The result is CACHED so no
  // probe ever sits on the ON write path.
  useFocusEffect(useCallback(() => {
    refreshVaultBioProbe();
    return invalidateBioProbe;
  }, [refreshVaultBioProbe, invalidateBioProbe]));
  useEffect(() => {
    const sub = AppState.addEventListener('change', st => {
      if (st === 'active') {refreshVaultBioProbe();}
    });
    return () => { sub.remove(); invalidateBioProbe(); };
  }, [refreshVaultBioProbe, invalidateBioProbe]);

  const vaultBioUsable = vaultBioProbe === 'available' || vaultBioProbe === 'weak';
  // ASYMMETRIC by design: a failed probe disables the row only while the flag
  // is OFF. With it ON the row stays LIVE — the OFF direction must always work,
  // and "the biometric vanished from this device" is exactly when it is needed.
  const vaultBioRowDisabled = !vaultBioUsable && !vaultBiometricOn;
  const vaultBioHint = vaultBioProbe === 'unknown'
    // Neutral while the probe is out. The row is disabled in this state, and
    // pairing a disabled switch with copy that describes what it WOULD do reads
    // as a broken control rather than a pending one.
    ? 'Checking device biometrics…'
    : vaultBioProbe === 'none'
      ? (vaultBiometricOn
        ? 'Biometric is no longer available on this device — turn this off, or re-enrol.'
        : 'Add a fingerprint or face in your device settings first.')
      // Arming demands a real biometric (the capability proof below passes
      // `disableDeviceFallback: true`), but the UNLOCK lane still accepts the
      // device credential — so the copy separates the two instead of implying
      // a screen lock can turn this on.
      : `Open the vault with your fingerprint or face instead of typing the PIN.${
        vaultBioProbe === 'weak' ? " This device's biometric is low-security." : ''
      } Once it is on, your device screen lock can open the vault too. This is separate from Biometric Lock in your profile, which locks the whole app.`;

  // Reflect whether encrypted backup is already on so the row's subtitle
  // is status-aware instead of always showing the first-time setup hint.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // P3-B-2 — owner-scoped flag with the legacy-global fallback so a
        // pre-migration enable still renders as "on" for a status hint.
        const source = await readBackupEnabledSource(ownerKey ?? '');
        if (!cancelled) {setBackupEnabled(source !== null);}
      } catch {
        // Non-fatal — fall back to the setup hint.
      }
      try {
        // B-65 — default ON (Telegram/WhatsApp parity); only an explicit '0'
        // opt-out disables. Must match backgroundMessageNotifier's read.
        const p = await AsyncStorage.getItem('bravo:notif-content-preview');
        if (!cancelled) {setNotifPreview(p !== '0');}
      } catch { /* default on */ }
    })();
    return () => { cancelled = true; };
  }, [ownerKey]);

  const toggleNotifPreview = async (v: boolean) => {
    setNotifPreview(v);
    try { await AsyncStorage.setItem('bravo:notif-content-preview', v ? '1' : '0'); } catch { /* best-effort */ }
    try {
      const {setContentPreviewEnabled} = require('@/modules/messenger/push/backgroundMessageNotifier') as
        typeof import('@/modules/messenger/push/backgroundMessageNotifier');
      setContentPreviewEnabled(v); // apply live without a restart
    } catch { /* module not loaded — picked up on next notifier start */ }
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [m, b] = await Promise.all([client.me(), client.listBlocked()]);
        if (cancelled) {return;}
        setMe(m);
        setBlocked(b);
        // M-07 — refresh the local block set from the authoritative server list
        // so the receive path drops blocked peers even after a reinstall.
        void setBlockedPeers(b.map(u => u.userId));
        setDisplayName(m.displayName);
        setBio(m.bio ?? '');
        setAvatarUrl(m.avatarUrl ?? '');
        // Audit P1-T3 — refresh the local privacy cache from the
        // server's authoritative value so the runtime's `markRead`
        // gate matches what the user sees in this screen.
        void cacheReadReceiptsEnabled(m.readReceiptsEnabled);
      } catch (e) {
        if (!cancelled) {
          Alert.alert('Could not load settings', e instanceof Error ? e.message : 'Unknown error');
        }
      } finally {
        if (!cancelled) {setLoading(false);}
      }
    })();
    return () => { cancelled = true; };
  }, [client]);

  const save = async () => {
    if (!me) {return;}
    setSaving(true);
    try {
      const next = await client.updateMe({
        displayName,
        bio,
        avatarUrl: avatarUrl.trim() ? avatarUrl.trim() : null,
      });
      setMe(next);
      Alert.alert('Saved', 'Profile updated.');
    } catch (e) {
      Alert.alert('Save failed', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setSaving(false);
    }
  };

  const privacySeq = useRef(createLatestWins<PrivacyField>()).current;

  const togglePrivacy = async (patch: {lastSeenVisible?: boolean; readReceiptsEnabled?: boolean}) => {
    if (!me) {return;}
    const fields = (Object.keys(patch) as PrivacyField[]).filter(f => patch[f] !== undefined);
    const isLatest = privacySeq(fields);
    // Optimistic: flip UI first, revert on failure. Privacy toggles are
    // latency-sensitive (user wants to SEE the switch flip) and the
    // server-side effect is idempotent.
    setMe(cur => (cur ? {...cur, ...patch} : cur));
    // Audit P1-T3 — write-through the read-receipts flag so the
    // runtime's `markRead` gate honours the new value on the very
    // next read without a screen re-mount.
    if (patch.readReceiptsEnabled !== undefined) {
      void cacheReadReceiptsEnabled(patch.readReceiptsEnabled);
    }
    try {
      const next = await client.updatePrivacy(patch);
      if (!isLatest()) {return;}
      // Why: merge only this request's fields — a full setMe(next) could
      // clobber a newer optimistic flip on the other toggle mid-flight.
      setMe(cur => {
        if (!cur) {return next;}
        const merged = {...cur};
        for (const f of fields) {merged[f] = next[f];}
        return merged;
      });
      if (patch.readReceiptsEnabled !== undefined) {
        void cacheReadReceiptsEnabled(next.readReceiptsEnabled);
      }
    } catch (e) {
      if (!isLatest()) {return;}
      // Why: revert by flipping the patch on CURRENT state — the captured
      // `me` may predate other toggles and would restore stale values.
      const revert: Partial<Me> = {};
      for (const f of fields) {revert[f] = !patch[f];}
      setMe(cur => (cur ? {...cur, ...revert} : cur));
      // Revert the cache too — leaving it on the optimistic value
      // would silently disable receipts even though the server still
      // has the old setting.
      if (patch.readReceiptsEnabled !== undefined) {
        void cacheReadReceiptsEnabled(!patch.readReceiptsEnabled);
      }
      Alert.alert('Could not update', e instanceof Error ? e.message : 'Unknown error');
    }
  };

  /**
   * Capability proof — a WORKS-check, run AFTER the flag is already true.
   *
   * It is NOT the security control (the PIN-fresh anchor above is); it only
   * catches "the sensor cannot actually serve this unlock", and reverts with
   * honest copy when it cannot.
   *
   * Two hardening rules, both learned elsewhere in this repo:
   *   - the native module keeps ONE promise, so a second `authenticateAsync`
   *     over a pending one gets the FIRST one's late result (BiometricGate's
   *     `authenticating` ref). Refuse instead.
   *   - the revert may write only while it is still the latest request for the
   *     field (SET-08): ON → OFF → ON with a stale `user_cancel` landing last
   *     would otherwise revert the newer, successful ON.
   */
  const proveVaultBiometricWorks = async (isLatest: () => boolean) => {
    if (bioProofPending.current) {return;}
    bioProofPending.current = true;
    try {
      const res = await LocalAuthentication.authenticateAsync({
        promptMessage:         'Confirm to turn on vault biometric unlock',
        cancelLabel:           'Cancel',
        // TRUE here and ONLY here. This is a works-check for a BIOMETRIC, so
        // satisfying it with the device passcode proves nothing about the
        // affordance being armed — a screen-lock-only device would sail through
        // and then find the keypad's fingerprint key can never appear.
        // STRENGTHENING a check, never weakening one: VaultLockScreen's unlock
        // lane keeps `disableDeviceFallback: false` untouched, so no unlock path
        // changes and no architecture stop-condition is engaged.
        disableDeviceFallback: true,
      });
      if (res.success) {return;}
      if (!isLatest()) {return;}
      useVaultStore.getState().setBiometricEnabled(false);
      Alert.alert(
        'Not turned on',
        'That check did not pass, so biometric unlock stays off. Your vault PIN is unchanged.',
      );
    } catch {
      if (!isLatest()) {return;}
      useVaultStore.getState().setBiometricEnabled(false);
    } finally {
      bioProofPending.current = false;
    }
  };

  const toggleVaultBiometric = (on: boolean) => {
    // Every deliberate tap claims the field, so a capability result that lands
    // after a newer tap can no longer write.
    const isLatest = vaultBioSeq(['vaultBiometric']);
    const vault = useVaultStore.getState();
    if (!on) {
      // OFF removes an unlock method, so it is NEVER gated — not on the probe,
      // not on PIN freshness, not on a round trip. Synchronous, unconditional.
      vault.setBiometricEnabled(false);
      return;
    }
    if (vault.biometricEnabled) {return;}
    // A prompt already in flight owns this decision. Arming again behind it
    // would write `true` for a proof that is about to answer for the PREVIOUS
    // tap — the flag would then stand on a result nobody actually checked.
    if (bioProofPending.current) {return;}
    // The anchor is a PIN typed in the last 60 seconds, NOT the 5-minute unlock
    // window: that window is also opened by `unlockWithBiometric`, and even a
    // PIN-opened one survives handing the phone to somebody who then enrols
    // their own finger. NOTHING async sits between this read and the write
    // below — the probe value is the cached focus/AppState one — so a relock, a
    // burst tap or sign-out's reset() cannot interleave.
    if (!vault.pinFresh()) {
      // One Alert at a time — a burst tap otherwise queues a second copy behind
      // the first (the host queues FIFO), so answering one leaves another
      // waiting over a decision already made. Cleared on EVERY exit path the
      // host defines: both buttons AND `onDismiss`, because back/backdrop does
      // NOT call the button handlers — a marker that can stick would be the
      // dead-switch class this round exists to kill.
      if (bioAlertPending.current) {return;}
      bioAlertPending.current = true;
      Alert.alert(
        'Confirm your vault PIN',
        'Confirm your vault PIN to enable biometric unlock. Your vault will lock so you can enter it.',
        [
          {text: 'Cancel', style: 'cancel', onPress: () => { bioAlertPending.current = false; }},
          {text: 'Enter PIN', onPress: () => {
            bioAlertPending.current = false;
            // The lock is what GUARANTEES the keypad. VaultLock forwards on
            // focus whenever `isUnlocked()`, and that 5-minute window is
            // exactly what `pinFresh` refuses — so a vault still inside it
            // bounced the user straight back here with nothing typed, and the
            // next tap re-raised this same Alert. A loop with no way out until
            // the window died on its own.
            //
            // Relocking is not a side effect here, it IS the declared intent:
            // the user chose "Enter PIN". Nothing else reacts to it either —
            // the vault gates (FilesScreen / VaultScreen / BiometricGate)
            // re-check on focus, and by the time the user reaches one of them
            // the window this discards would have expired anyway.
            // RESOLVE FIRST, LOCK SECOND. A dropped dispatch has to be a plain
            // no-op: locking and then discovering no navigator registers the
            // route would leave the user holding a freshly LOCKED vault with no
            // keypad in front of them — a destructive dead tap, strictly worse
            // than the stale window it was clearing.
            const lockNav = findNavigatorWithRoute(navigation, 'VaultLock');
            if (!lockNav) {return;}
            useVaultStore.getState().lock();
            navigateVia(lockNav, 'VaultLock', {next: 'MessengerSettings'});
          }},
        ],
        {onDismiss: () => { bioAlertPending.current = false; }},
      );
      return;
    }
    vault.setBiometricEnabled(true);
    void proveVaultBiometricWorks(isLatest);
  };

  // NAV-17 (2026-08-26 audit) — per-user in-flight guard: a mash fired one
  // unblock call per queued tap.
  const unblockingRef = useRef<Set<string>>(new Set());
  const unblock = async (userId: string) => {
    if (unblockingRef.current.has(userId)) {return;}
    unblockingRef.current.add(userId);
    try {
      await client.unblock(userId);
      setBlocked(list => list.filter(b => b.userId !== userId));
      // M-07 — clear the local block so this peer's messages deliver again.
      void removeBlockedPeer(userId);
    } catch (e) {
      Alert.alert('Unblock failed', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      unblockingRef.current.delete(userId);
    }
  };

  if (loading) {
    return (
      <View style={[styles.root, {alignItems:'center', justifyContent:'center', paddingTop: insets.top}]}>
        <LoadingView label="Loading settings…" />
      </View>
    );
  }

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => goBackOnce(navigation)} activeOpacity={0.7} hitSlop={{top: 6, bottom: 6, left: 6, right: 6}}>
          <Icon name="arrow-left" size={20} color="#F2F4F8" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Settings</Text>
      </View>

      <KeyboardAvoidingScreen contentContainerStyle={{paddingBottom: insets.bottom + 48}}>
        <Text style={styles.sectionLabel}>Profile</Text>
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Display name</Text>
          <TextInput
            style={styles.input}
            value={displayName}
            onChangeText={setDisplayName}
            placeholder="Your name"
            placeholderTextColor="rgba(180,188,204,0.45)"
            maxLength={80}
          />
        </View>
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Bio</Text>
          <TextInput
            style={[styles.input, {minHeight: 64}]}
            value={bio}
            onChangeText={setBio}
            placeholder="Something about yourself…"
            placeholderTextColor="rgba(180,188,204,0.45)"
            maxLength={280}
            multiline
          />
        </View>
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Avatar URL</Text>
          <TextInput
            style={styles.input}
            value={avatarUrl}
            onChangeText={setAvatarUrl}
            placeholder="https://…"
            placeholderTextColor="rgba(180,188,204,0.45)"
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>
        <TouchableOpacity
          style={[styles.saveBtn, saving && {opacity: 0.5}]}
          onPress={() => { void save(); }}
          disabled={saving}
          activeOpacity={0.85}>
          <Text style={styles.saveBtnText}>{saving ? 'SAVING…' : 'SAVE PROFILE'}</Text>
        </TouchableOpacity>

        <Text style={styles.sectionLabel}>Privacy</Text>
        <View style={styles.row}>
          <View style={{flex:1}}>
            <Text style={styles.rowTitle}>Show last seen</Text>
            <Text style={styles.rowHint}>Contacts can see when you were last online.</Text>
          </View>
          <Switch
            value={me?.lastSeenVisible ?? true}
            onValueChange={v => togglePrivacy({lastSeenVisible: v})}
            trackColor={{false: 'rgba(255,255,255,0.09)', true: '#5B8DEF'}}
          />
        </View>
        <View style={styles.row}>
          <View style={{flex:1}}>
            <Text style={styles.rowTitle}>Send read receipts</Text>
            <Text style={styles.rowHint}>Let senders know when you've read their messages.</Text>
          </View>
          <Switch
            value={me?.readReceiptsEnabled ?? true}
            onValueChange={v => togglePrivacy({readReceiptsEnabled: v})}
            trackColor={{false: 'rgba(255,255,255,0.09)', true: '#5B8DEF'}}
          />
        </View>

        <Text style={styles.sectionLabel}>Notifications</Text>
        <View style={styles.row}>
          <View style={{flex:1}}>
            <Text style={styles.rowTitle}>Show message preview</Text>
            <Text style={styles.rowHint}>Show the sender and a message preview in notifications. Off keeps banners to the sender's name only.</Text>
          </View>
          <Switch
            value={notifPreview}
            onValueChange={toggleNotifPreview}
            trackColor={{false: 'rgba(255,255,255,0.09)', true: '#5B8DEF'}}
          />
        </View>

        <Text style={styles.sectionLabel}>Chat Backup</Text>
        <TouchableOpacity
          style={styles.row}
          activeOpacity={0.75}
          onPress={() => navigation.navigate('BackupSetup')}>
          <View style={styles.backupIconWrap}>
            <Icon name="shield-key-outline" size={20} color="#5B8DEF" />
          </View>
          <View style={{flex:1}}>
            <Text style={styles.rowTitle}>End-to-end encrypted backup</Text>
            <Text style={styles.rowHint}>
              {backupEnabled
                ? 'On · chats are backed up.'
                : 'Set a password so chats survive reinstall + new device.'}
            </Text>
          </View>
          <Icon name="chevron-right" size={20} color="rgba(180,188,204,0.45)" />
        </TouchableOpacity>

        {/* Hidden until the vault store has hydrated AND the user actually has
            a PIN: there is no biometric preference to express before either. */}
        {vaultReady && vaultHasPin ? (
          <>
            <Text style={styles.sectionLabel}>File Vault</Text>
            <View style={styles.row}>
              <View style={{flex:1}}>
                <Text style={styles.rowTitle}>Unlock vault with biometric</Text>
                <Text style={styles.rowHint}>{vaultBioHint}</Text>
              </View>
              <Switch
                value={vaultBiometricOn}
                onValueChange={toggleVaultBiometric}
                disabled={vaultBioRowDisabled}
                trackColor={{false: 'rgba(255,255,255,0.09)', true: '#5B8DEF'}}
              />
            </View>
          </>
        ) : null}

        <Text style={styles.sectionLabel}>Blocked · {blocked.length}</Text>
        {blocked.length === 0 ? (
          <View style={styles.emptyBlock}>
            <Icon name="shield-check-outline" size={28} color="rgba(180,188,204,0.45)" />
            <Text style={styles.emptyBlockText}>You haven't blocked anyone.</Text>
          </View>
        ) : (
          blocked.map(b => (
            <View key={b.userId} style={styles.row}>
              <View style={styles.blockAv}>
                <Text style={styles.blockAvText}>{initials(b.displayName)}</Text>
              </View>
              <View style={{flex:1}}>
                <Text style={styles.rowTitle}>{b.displayName}</Text>
              </View>
              <TouchableOpacity onPress={() => { void unblock(b.userId); }} activeOpacity={0.8} style={styles.unblockBtn}>
                <Text style={styles.unblockBtnText}>UNBLOCK</Text>
              </TouchableOpacity>
            </View>
          ))
        )}
      </KeyboardAvoidingScreen>
    </View>
  );
}

function initials(s: string): string {
  return s.split(/\s+/).slice(0, 2).map(p => p[0] ?? '').join('').toUpperCase() || '·';
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex:1, backgroundColor:Colors.background},
  header: {flexDirection:'row', alignItems:'center', gap:12, paddingHorizontal:16, paddingTop:8, paddingBottom:12, borderBottomWidth:1, borderBottomColor:'rgba(255,255,255,0.06)'},
  backBtn: {width:32, height:32, borderRadius:16, alignItems:'center', justifyContent:'center'},
  headerTitle: {flex:1, color:'#F2F4F8', fontSize:13, fontWeight:'800', letterSpacing:3, textTransform:'uppercase'},

  sectionLabel: {color:'rgba(180,188,204,0.45)', fontSize:9, fontWeight:'800', letterSpacing:3, textTransform:'uppercase', paddingHorizontal:16, paddingTop:16, paddingBottom:8},

  field: {paddingHorizontal:16, paddingVertical:8},
  fieldLabel: {color:'rgba(229,233,242,0.62)', fontSize:10, fontWeight:'700', letterSpacing:1, marginBottom:4},
  input: {color:'#FFFFFF', fontSize:13, backgroundColor:'#0C1018', borderRadius:10, paddingHorizontal:12, paddingVertical:10, borderWidth:1, borderColor:'rgba(255,255,255,0.09)'},

  saveBtn: {marginHorizontal:16, marginTop:16, height:44, borderRadius:10, backgroundColor:'#5B8DEF', alignItems:'center', justifyContent:'center'},
  saveBtnText: {color:'#FFF', fontSize:12, fontWeight:'800', letterSpacing:2},

  row: {flexDirection:'row', alignItems:'center', gap:12, paddingHorizontal:16, paddingVertical:12, borderTopWidth:1, borderTopColor:'rgba(255,255,255,0.06)'},
  rowTitle: {color:'#F2F4F8', fontSize:13, fontWeight:'700'},
  rowHint:  {color:'rgba(229,233,242,0.62)', fontSize:10.5, marginTop:2},

  emptyBlock: {alignItems:'center', paddingVertical:28, gap:8},
  emptyBlockText: {color:'rgba(180,188,204,0.45)', fontSize:12},

  backupIconWrap: {width:36, height:36, borderRadius:10, backgroundColor:'rgba(91,141,239,0.12)', borderWidth:1, borderColor:'rgba(91,141,239,0.3)', alignItems:'center', justifyContent:'center'},
  blockAv: {width:36, height:36, borderRadius:18, backgroundColor:'#18202F', alignItems:'center', justifyContent:'center'},
  blockAvText: {color:'#F2F4F8', fontSize:11, fontWeight:'800'},
  unblockBtn: {paddingHorizontal:12, paddingVertical:8, borderRadius:14, backgroundColor:'rgba(91,141,239,0.12)', borderWidth:1, borderColor:'rgba(91,141,239,0.3)'},
  unblockBtnText: {color:'#5B8DEF', fontSize:10, fontWeight:'800', letterSpacing:1.5},
}));
