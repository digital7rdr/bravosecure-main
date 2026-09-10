/**
 * BackupRestoreScreen — entered after login when an existing backup
 * is found AND the local Signal store has no identity.
 *
 * Flow:
 *   1. GET /backup/identity/header → know if a backup exists, get
 *      lockout state.
 *   2. User enters their backup password.
 *   3. restoreBackup() — reinstall identity into the local store.
 *      • Wrong password → server bumps counter; UI shows attempts left.
 *      • 5 wrong → server returns 423; UI shows cool-down timer.
 *   4. restoreAllMessages() — rehydrate conversation list + messages.
 *   5. Navigate to MessengerHome.
 *
 * "Forgot password" → confirms wipe → DELETE /backup → user proceeds
 * with a fresh empty store, matching WhatsApp's "permanently lost" UX.
 */
import React, {useEffect, useState, useCallback, useRef} from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, StatusBar,
  ActivityIndicator, BackHandler,
  ScrollView,
} from 'react-native';
import {Alert} from '@utils/alert';
import RestoreProgressOverlay, {type RestoreProgressState} from './RestoreProgressOverlay';
import {useFocusEffect} from '@react-navigation/native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {runBackupBiometricGate} from '@/modules/messenger/backup/backupBiometricGate';
import type {MessengerScreenProps} from '@navigation/types';
import {restoreBackup} from '@/modules/messenger/backup/identityBackup';
import {setMirrorKey} from '@/modules/messenger/backup/messageMirror';
import {clearRestoreState} from '@/modules/messenger/backup/restoreResume';
import {startBackgroundRestore, stopBackgroundRestore} from '@/modules/messenger/backup/restoreBackground';
import {clearBackupEnabled} from '@/modules/messenger/backup/backupFlags';
import {setRestoreModeActive} from '@/modules/messenger/backup/restoreMode';
import {humanizeBackupError} from '@/modules/messenger/backup/backupErrorCopy';
import {backupClient, BackupError} from '@/modules/messenger/backup/backupClient';
import {getOwnCryptoStore, getMessengerRuntime} from '@/modules/messenger/runtime';
import {useAuthStore} from '@store/authStore';
import {useKeyboardOverlap, useRevealOnKeyboard} from '@hooks/useKeyboardLayout';
import {BACKUP_BASE} from './backupPalette';

type Props = MessengerScreenProps<'BackupRestore'>;

const C = {...BACKUP_BASE, ok: '#00C853'};

const MAX_ATTEMPTS = 5;

export default function BackupRestoreScreen({navigation}: Props) {
  const insets = useSafeAreaInsets();
  // B-84 / KB-01 — edge-to-edge nulls adjustResize and the previous KAV
  // had no Android behavior, so the keyboard covered the password field.
  // ChatScreen pattern: manual kb padding + reveal once the IME is up.
  const scrollRef = useRef<ScrollView>(null);
  const keyboardOverlap = useKeyboardOverlap();
  const revealField = useRevealOnKeyboard(scrollRef);
  const ownerUserId = useAuthStore(s => s.user?.id ?? null);
  // Key-storage owner — MUST match the runtime's persistence identity
  // (MainNavigator passes `email ?? phone ?? id` as ownerKey to both
  // configureMessengerRuntime and runBackupBoot). The keychain DB key,
  // mirror key, and boot RESTORE gate are all scoped on this. Using the
  // bare UUID here writes the mirror key under a service no reader ever
  // checks → mirror never auto-resumes + boot re-enters RESTORE.
  // Why: distinct from ownerUserId (the Signal UUID) which restore still
  // needs for peer/self address matching against conversation members.
  const ownerKey = useAuthStore(s => s.user?.email ?? s.user?.phone_e164 ?? s.user?.id ?? null);
  const [pwd, setPwd] = useState('');
  const [busy, setBusy] = useState(false);
  const [headerLoading, setHeaderLoading] = useState(true);
  const [attemptsLeft, setAttemptsLeft] = useState(MAX_ATTEMPTS);
  const [lockedUntil, setLockedUntil] = useState<string | null>(null);
  // B-44 — legacy pre-verifier row (P0-1 hard cut). The server 409s every
  // proof for these, so NO password can restore; showing the form is a
  // dead end. When set, the password UI is replaced by a start-fresh panel.
  const [legacyBackup, setLegacyBackup] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Finding 5 — forces a 1s re-render while locked so the countdown ticks.
  const [, setNowTick] = useState(0);
  // Premium full-screen restore overlay. null = not shown (password
  // input visible); any state value = overlay covers the screen.
  const [overlay, setOverlay] = useState<RestoreProgressState | null>(null);
  // Round 5 UX-fix: show/hide eye toggle so the user can verify what
  // they actually typed (especially critical given Android's autofill
  // can substitute the saved account password into a secure field).
  const [showPwd, setShowPwd] = useState(false);

  const refreshHeader = useCallback(async () => {
    setHeaderLoading(true);
    try {
      const h = await backupClient.getIdentityHeader();
      setAttemptsLeft(Math.max(0, MAX_ATTEMPTS - h.failedAttempts));
      setLockedUntil(h.lockedUntil);
      setLegacyBackup(h.verifierMissing === true);
    } catch (e) {
      if (e instanceof BackupError && e.kind === 'no_backup') {
        // No backup — should never reach here, but degrade gracefully.
        navigation.replace('MessengerHome');
        return;
      }
      setErr(`header_fetch_failed: ${(e as Error).message}`);
    } finally {
      setHeaderLoading(false);
    }
  }, [navigation]);

  // BKRES-19 — refetch on every focus, not just mount, so a backup wiped
  // or changed while this screen was unfocused (e.g. from another device)
  // is picked up instead of serving a stale header until remount.
  useFocusEffect(
    useCallback(() => { void refreshHeader(); }, [refreshHeader]),
  );

  // Round 7 / back-button audit fix #1 — trap the Android hardware back
  // button. Without this, the user can press back and pop the screen,
  // which exits the restore flow with a freshly-installed Signal
  // identity already written by `getMessengerRuntime('production')`
  // inside handleRestore. Subsequent runtime boots see `localKeyExists`
  // and skip the restore branch, permanently losing every previously
  // mirrored conversation. Instead: prompt the user for explicit
  // confirmation; the only legitimate way out is "Forgot password —
  // start fresh" (which already wipes the server backup intentionally)
  // or successfully restoring.
  // Shared back-press guard used by BOTH the Android hardware back button
  // AND the header back arrow. Previously only the hardware button was
  // trapped; the visible arrow called navigation.goBack() directly, so a
  // single tap on it was the exact data-loss path (fresh identity written,
  // mirrored history stranded) the trap was built to prevent.
  const handleBackPress = useCallback((): boolean => {
    if (busy) {
      // While restore is in flight, swallow back entirely — popping
      // mid-restore corrupts the SQL store and leaves a half-built
      // identity. The user can only wait or cancel from the overlay.
      return true;
    }
    Alert.alert(
      'Skip restore?',
      'Going back without restoring leaves you on a fresh empty account. Your encrypted backup stays on our servers until you wipe it from this screen.',
      [
        {text: 'Stay', style: 'cancel'},
        // BB-3 (2026-08-15 back audit) — the fresh-install restore lane
        // cold-mounts this screen as the stack's only route, where goBack()
        // no-ops: Skip restore was the ONE exit in this file not shaped as
        // replace('MessengerHome'), and it was dead exactly there.
        {text: 'Skip restore', style: 'destructive', onPress: () => (
          navigation.canGoBack() ? navigation.goBack() : navigation.replace('MessengerHome'))},
      ],
    );
    return true;
  }, [busy, navigation]);

  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener('hardwareBackPress', handleBackPress);
      return () => sub.remove();
    }, [handleBackPress]),
  );

  const lockedRemainingSec = (() => {
    if (!lockedUntil) {return 0;}
    const ms = new Date(lockedUntil).getTime() - Date.now();
    return Math.max(0, Math.ceil(ms / 1000));
  })();

  // Finding 5 — the lockout countdown was computed once per render but
  // nothing re-rendered, so "Try again in Xm Ys" froze and the form
  // stayed hidden even after the cool-down elapsed. Tick every second
  // while locked; when it reaches zero, clear the lock and re-fetch the
  // header so the password form reappears without leaving the screen.
  useEffect(() => {
    if (!lockedUntil) {return;}
    const id = setInterval(() => {
      if (new Date(lockedUntil).getTime() - Date.now() <= 0) {
        setLockedUntil(null);
        void refreshHeader();
      } else {
        setNowTick(t => (t + 1) % 1_000_000);
      }
    }, 1_000);
    return () => clearInterval(id);
  }, [lockedUntil, refreshHeader]);

  // B-107 — for the WHOLE time this screen is mounted (the pre-password
  // RESTORE gate, the restore run, and the B-81 repair retry) incoming
  // calls are busy-rejected and push-layer runtime boots are deferred
  // (restoreMode.ts). Unmount clears it on every exit path — success
  // navigation, forgot-password wipe, back-out — and the flag is
  // in-memory, so a crash/restart can never leave the user unreachable.
  useEffect(() => {
    setRestoreModeActive(true);
    return () => setRestoreModeActive(false);
  }, []);

  /**
   * Audit P1-B1 — second-factor gate before the password unlock fires.
   * Requires a fresh biometric / device-passcode prompt right BEFORE we
   * even start the Argon2 derive, so an attacker who recovered the
   * backup password (shoulder-surf, phish, found-on-a-sticky-note)
   * still needs the user's actual device unlock to complete the restore.
   *
   * Soft-fails when the device has no biometric hardware OR no
   * enrolled credential — restoring a backup on a brand-new device
   * that hasn't yet been enrolled is a legitimate first-boot flow we
   * don't want to brick. The password-only path is unchanged in that
   * case (matches the legacy behaviour pre-P1-B1).
   */
  const requireBiometricUnlock = useCallback(
    () => runBackupBiometricGate('Confirm to restore backup'),
    [],
  );

  const handleRestore = async (): Promise<void> => {
    // BR-1 — the B-81 repair-and-retry now lives inside the background
    // restore runner, so no re-entrant path needs to bypass this guard.
    if (busy) {return;}
    if (!pwd) {return;}
    if (lockedRemainingSec > 0) {return;}
    if (!ownerUserId) { setErr('not_logged_in'); return; }
    setBusy(true);
    setErr(null);
    // Audit P1-B1 — biometric gate. Fires BEFORE Argon2 so a wrong
    // password attempt costs the attacker the biometric prompt too.
    const bio = await requireBiometricUnlock();
    if (!bio.ok) {
      setBusy(false);
      setErr('Biometric verification required');
      // B-81 — the post-repair retry re-enters under the "Repairing backup
      // integrity…" progress overlay; clear it so a cancelled biometric
      // doesn't strand a full-screen spinner over the real error.
      setOverlay(null);
      return;
    }
    try {
      // Step 1 — boot the messenger runtime if it hasn't been booted
      // yet (the RESTORE branch in backupBoot.ts skips runtime init,
      // because installIdentity() would overwrite the bundle we're
      // about to recover). This call:
      //   • generates a fresh SQLCipher key + opens the encrypted DB
      //   • runs installIdentity which writes a NEW Signal identity
      //     (we deliberately overwrite this in step 2)
      //   • opens the WebSocket, primes sender cert, etc.
      // Step 2 (restoreBackup) then re-installs the OLD identity from
      // the wrapped bundle on top, so the X3DH session keys our peers
      // hold remain valid.
      //
      // Round 8 — defer the bundle upload until AFTER restoreBackup
      // installs the recovered identity. Without the defer, the fresh
      // installIdentity bundle gets uploaded to auth-service first;
      // the rotation detector then WIPES every server-side OPK public
      // (peers built sessions against). End result: peers can't decrypt
      // anything they send to us until they re-fetch our bundle.
      console.log('[bravo.restore] booting runtime (bundle publish deferred)');
      setOverlay({kind: 'progress', step: 'Preparing secure store…'});
      const {setDeferBundlePublish, publishOwnBundleAfterRestore} =
        require('@/modules/messenger/runtime/productionRuntime') as
        typeof import('@/modules/messenger/runtime/productionRuntime');
      setDeferBundlePublish(true);
      try {
        await getMessengerRuntime('production');
      } catch (e) {
        setDeferBundlePublish(false);
        throw e;
      }
      const store = getOwnCryptoStore();
      if (!store) {
        // BUG-1 (audit 2026-07-23) — this early return used to leave
        // deferBundlePublish=true for the rest of the session, so the
        // fresh identity was never published and peers kept sealing to
        // the dead pre-reinstall bundle (silent inbound loss until the
        // next cold start). Reset on EVERY exit from the deferred window.
        setDeferBundlePublish(false);
        setErr('messenger_not_ready'); setBusy(false); return;
      }

      console.log('[bravo.restore] verifying password + unwrapping identity');
      setOverlay({kind: 'progress', step: 'Verifying password…'});
      let restored: Awaited<ReturnType<typeof restoreBackup>>;
      try {
        restored = await restoreBackup(store, pwd);
      } catch (e) {
        // BUG-1 — wrong password / locked / network throws land here with
        // the publish still deferred; without the reset, a "Skip restore"
        // or "Wipe & Start Fresh" exit strands an unpublished identity.
        setDeferBundlePublish(false);
        throw e;
      }
      const {masterKey, identity, rawB64} = restored;
      // BUG-8 (audit 2026-07-23) — the identity is now irreversibly the
      // restored one, but the H-2 marker used to be armed only when the
      // message walk started, seconds of publish/rebuild/keychain work
      // later. A kill in that span left a restorable backup stranded on
      // the plain RESUME boot path. Arm it NOW; a completed background
      // restore clears it.
      try {
        const {markRestoreIncomplete} = require('@/modules/messenger/backup/restoreResume') as
          typeof import('@/modules/messenger/backup/restoreResume');
        await markRestoreIncomplete(ownerUserId);
      } catch { /* marker is belt-and-braces — never block the restore */ }
      // Round 8 — NOW publish the recovered bundle. The deferred
      // initial upload from getMessengerRuntime is replaced with this
      // one, which carries the OLD identity restored from the backup.
      // The auth-service rotation detector sees the SAME identity it
      // had on file, treats it as a no-op upsert, and DOES NOT wipe
      // any OPK pool. Peer sessions remain intact.
      try {
        await publishOwnBundleAfterRestore();
      } catch (e) {
        console.warn('[bravo.restore] publishOwnBundleAfterRestore failed:', (e as Error).message);
      } finally {
        setDeferBundlePublish(false);
      }
      // Why: the runtime was booted earlier (line ~203) BEFORE restoreBackup
      // overwrote the SQLCipher identity row with the recovered one. The
      // live SessionManager + SenderCertCache + cached ownIdentity pubKey
      // are still keyed off the FRESH identity that installIdentity wrote
      // before we replaced it. Any send from this stale runtime issues
      // certs bound to the wrong identity → receiver's verifySenderCert
      // fails → red "sender identity key mismatch" banner on MessengerHome.
      // Force-closing + relaunching used to be the only fix because that
      // rebuilt the runtime fresh from the restored SQLCipher state.
      // Tear down the stale runtime + rebuild it now so MessengerHome
      // mounts against the restored identity.
      try {
        const {disposeLiveRuntime} = require('@/modules/messenger/runtime/productionRuntime') as
          typeof import('@/modules/messenger/runtime/productionRuntime');
        // BS-RESTORE — keep the production config that MainNavigator already
        // set. The full _resetMessengerRuntime() nulled it, so the rebuild
        // below threw "requires configureMessengerRuntime(cfg) first" and
        // MessengerHome showed the red error bar until a manual close+reopen.
        const {_resetMessengerRuntimeKeepConfig} = require('@/modules/messenger/runtime') as
          typeof import('@/modules/messenger/runtime');
        console.log('[bravo.restore] rebuilding runtime against restored identity');
        setOverlay({kind: 'progress', step: 'Finalising secure session…'});
        disposeLiveRuntime();
        _resetMessengerRuntimeKeepConfig();
        await getMessengerRuntime('production');
      } catch (e) {
        console.warn('[bravo.restore] runtime rebuild failed:', (e as Error).message);
      }
      setMirrorKey(masterKey);
      // Persist the raw key in the OS keychain so the mirror auto-resumes
      // on the next cold start without re-prompting for the password.
      try {
        const {saveMirrorMasterKey} = require('@/modules/messenger/runtime/keychain') as
          typeof import('@/modules/messenger/runtime/keychain');
        await saveMirrorMasterKey(ownerKey ?? ownerUserId, rawB64);
      } catch (e) {
        console.warn('[bravo.restore] saveMirrorMasterKey failed:', (e as Error).message);
      }
      // B-696 Phase D — the mirror key just became available on this device,
      // which is the moment the E2E vault index becomes decryptable. Pull it
      // (fire-and-forget; no-ops when the index is non-empty or the sync is
      // not armed yet — the MainNavigator owner effect re-fires it then).
      // Deliberately OUTSIDE the message-mirror machinery (see M-11 below):
      // this is one opaque blob on its own lane, never a mirror row.
      try {
        const {maybeRestoreVaultIndex} = require('@/modules/messenger/vault') as
          typeof import('@/modules/messenger/vault');
        void maybeRestoreVaultIndex();
      } catch { /* vault module unavailable — vault index stays empty */ }
      // M-11 — the mirror subscription is intentionally NOT started here.
      // Starting it before restoreAllMessages would treat every restored
      // row as "new" and re-upload the ENTIRE history (re-encrypting each
      // row + invalidating the Merkle commit). We start it AFTER the full
      // restore below, seeded from the restored store, so only genuinely
      // new post-restore messages mirror.

      // BR-1 — identity phase done: the Signal identity, runtime, and
      // mirror key are live. Everything that used to run inline from here
      // (ratchet-snapshot apply → message walk → archive drain → B-94
      // ledger seed → mirror hand-off) now runs in the background runner
      // so the user lands on MessengerHome immediately and watches the
      // history stream in batch-by-batch (RestoreActivityBanner shows
      // progress; the runner auto-resumes P2-B-6 windows without another
      // password prompt; the B-81 repair-and-retry lives inside it too).
      //
      // Round 5 / Security S8 — the identity pub/priv keys still gate the
      // walk: verifyMerkleCommit runs before any durable write exactly as
      // before. The pub key authenticates the signed commit; the priv key
      // enables the additive-prefix self-heal.
      const idPubBytes = Buffer.from(identity.identityKey.pub, 'base64');
      const idPubAb = idPubBytes.buffer.slice(idPubBytes.byteOffset, idPubBytes.byteOffset + idPubBytes.byteLength);
      const idPrivBytes = Buffer.from(identity.identityKey.priv, 'base64');
      const idPrivAb = idPrivBytes.buffer.slice(idPrivBytes.byteOffset, idPrivBytes.byteOffset + idPrivBytes.byteLength);
      console.log('[bravo.restore] identity phase complete — handing off to background restore');
      startBackgroundRestore({
        masterKey,
        ownerUserId,
        ownerKey,
        identityPubKey:  idPubAb as ArrayBuffer,
        identityPrivKey: idPrivAb as ArrayBuffer,
      });
      navigation.replace('MessengerHome');
    } catch (e) {
      // Tear down the splash on error so the user can read what went
      // wrong on the inline form (and retry without restarting).
      // Wrong-password / locked errors render naturally on the password
      // form; other failures bubble through the overlay's error state
      // so the user gets a styled message instead of just a tiny red line.
      setOverlay(null);
      if (e instanceof BackupError) {
        if (e.kind === 'unauthorized') {
          setErr('Wrong password');
          await refreshHeader();
        } else if (e.kind === 'verify_required') {
          // BUG-K — the password was CORRECT; the single-use verify token
          // expired/was consumed. Inline retry, never "Wrong password"
          // (which steers users toward the permanent wipe).
          setErr(humanizeBackupError('verify_required'));
          await refreshHeader();
        } else if (e.kind === 'locked') {
          setErr(null);
          await refreshHeader();
        } else if (e.kind === 'verifier_missing') {
          // B-44 — the header probe missed it (race / cached state) but the
          // restore path hit the legacy row. Flip to the hard-cut panel
          // instead of a generic error the user can't act on.
          setErr(null);
          setLegacyBackup(true);
        } else if (e.kind === 'no_backup') {
          // BKRES-19 — the backup was deleted after this screen loaded
          // (e.g. wiped from another device). Same handling as the
          // mount-time probe: nothing left to restore, so inform + move
          // on instead of a generic error overlay the user can only retry.
          setErr(null);
          Alert.alert(
            'No backup found',
            'Your backup no longer exists on the server. You can set up a new one later from Settings → Chat Backup.',
            [{text: 'OK', onPress: () => navigation.replace('MessengerHome')}],
          );
        } else {
          // BKRES-27 — humanize the wrapped kind now so a known code
          // (e.g. nonce_expired) keeps its dedicated copy in BOTH the
          // inline error and the overlay, instead of collapsing into
          // the generic 'Restore failed' prefix match.
          const msg = humanizeBackupError(`Restore failed: ${e.kind}`);
          setErr(msg);
          setOverlay({kind: 'error', message: msg});
        }
      } else {
        const msg = `Restore failed: ${(e as Error).message}`;
        setErr(msg);
        setOverlay({kind: 'error', message: msg});
      }
    } finally {
      setBusy(false);
    }
  };

  const handleForgot = (): void => {
    Alert.alert(
      'Backup permanently lost?',
      'Without your password we cannot decrypt your backup. Continuing wipes the encrypted backup from our servers and starts you fresh — your old messages cannot be recovered.',
      [
        {text: 'Cancel', style: 'cancel'},
        {text: 'Wipe & Start Fresh', style: 'destructive', onPress: () => {
          void (async () => {
            try {
              await backupClient.forget();
              // BUG-6/B-3 (audit 2026-07-23) — stop any background restore
              // still walking the wiped mirror, and tear down the live
              // mirror key/queues so nothing keeps flushing into a server
              // mirror that can never be restored.
              stopBackgroundRestore();
              try {
                const {resetMirrorForWipe} = require('@/modules/messenger/backup/messageMirror') as
                  typeof import('@/modules/messenger/backup/messageMirror');
                resetMirrorForWipe();
              } catch { /* mirror module unavailable — nothing to tear down */ }
              // M-17 — clear ALL local backup/restore state so a later
              // fresh setup can't inherit a stale resume cursor (which
              // would silently skip rows at/before it) or a dangling
              // enabled flag / keychain key from the wiped backup.
              try {
                if (ownerUserId) { await clearRestoreState(ownerUserId); }
                // P3-B-2 — clears the owner-scoped AND legacy enabled flags.
                await clearBackupEnabled((ownerKey ?? ownerUserId ?? '') as string);
                const {clearMirrorMasterKey} = require('@/modules/messenger/runtime/keychain') as
                  typeof import('@/modules/messenger/runtime/keychain');
                if (ownerKey ?? ownerUserId) { await clearMirrorMasterKey((ownerKey ?? ownerUserId) as string); }
                // B-94 — the server mirror is gone; a stale flush ledger
                // would make a future sweep skip rows the server no longer
                // holds (silent restore data loss). Purge it with the rest.
                const {clearFlushedForOwner} = require('@/modules/messenger/backup/mirrorLedger') as
                  typeof import('@/modules/messenger/backup/mirrorLedger');
                if (ownerUserId) { await clearFlushedForOwner(ownerUserId); }
              } catch (e) {
                console.warn('[bravo.restore] forget local-state cleanup failed:', (e as Error).message);
              }
              // Boot the runtime now so MessengerHome has a working
              // CryptoStore + WS connection to operate against. The
              // RESTORE branch in backupBoot.ts deferred this exact
              // step, expecting either restore or wipe to complete it.
              try { await getMessengerRuntime('production'); } catch { /* surfaced later */ }
              Alert.alert('Backup wiped', 'You can set up a new backup later from Settings → Chat Backup.', [
                {text: 'OK', onPress: () => navigation.replace('MessengerHome')},
              ]);
            } catch (e) {
              Alert.alert('Could not wipe backup', (e as Error).message);
            }
          })();
        }},
      ],
    );
  };

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />
      {/* Top bar — same shape as BackupSetup so the two screens read
          as siblings in the same flow rather than two unrelated UIs. */}
      <View style={s.topBar}>
        <TouchableOpacity
          style={s.iconBtn}
          onPress={() => { handleBackPress(); }}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          activeOpacity={0.7}>
          <Icon name="arrow-left" size={22} color={C.tx1} />
        </TouchableOpacity>
        <Text style={s.title}>RESTORE BACKUP</Text>
        <View style={{width: 38}} />
      </View>
      {/* KB-01 / B-184 — the restore password gate. One rule on both
          platforms: this box shrinks by the true IME overlap. */}
      <View style={{flex: 1, paddingBottom: keyboardOverlap}}>
        <ScrollView
          ref={scrollRef}
          // Same rule as BackupSetupScreen: the wrapper lifts by the IME
          // overlap, the resting bottom inset is owed here.
          contentContainerStyle={[s.body, {paddingBottom: insets.bottom + 40}]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}>
          {legacyBackup ? (
            /* B-44 — P0-1 hard cut. No password can unlock a pre-verifier
               backup (the server rejects every proof), and Settings is
               unreachable behind this gate — so don't render a form that
               can only fail. The single way forward is the existing wipe. */
            <>
              <View style={s.heroIconWrap}>
                <Icon name="shield-alert-outline" size={56} color={C.warn} />
              </View>
              <Text style={s.h1}>This backup can't be unlocked</Text>
              <Text style={s.p}>
                It was created before a security upgrade that changed how
                backup passwords are verified, so it can no longer be
                restored — with any password.
              </Text>
              <View style={[s.notice, {borderColor: C.warn}]}>
                <Icon name="alert-circle-outline" size={18} color={C.warn} />
                <Text style={[s.noticeTxt, {color: C.warn}]}>
                  Your old backed-up messages cannot be recovered.
                </Text>
              </View>
              <View style={s.bullet}>
                <Icon name="lock-check-outline" size={18} color={C.ok} />
                <Text style={s.bulletTxt}>
                  Start fresh, then set a new backup password from Settings →
                  Chat Backup. New backups use the upgraded protection.
                </Text>
              </View>
              <TouchableOpacity
                style={s.primaryBtn}
                onPress={handleForgot}
                activeOpacity={0.85}>
                <Text style={s.primaryBtnTxt}>START FRESH</Text>
              </TouchableOpacity>
            </>
          ) : (
          <>
          <View style={s.heroIconWrap}>
            <Icon name="cloud-download-outline" size={56} color={C.act} />
          </View>
          <Text style={s.h1}>Restore your chats</Text>
          <Text style={s.p}>
            We found an encrypted backup on your account. Enter the password
            you set when you enabled chat backup.
          </Text>

          <View style={s.bullet}>
            <Icon name="lock-check-outline" size={18} color={C.ok} />
            <Text style={s.bulletTxt}>argon2id key derivation — server can't read your messages.</Text>
          </View>
          <View style={s.bullet}>
            <Icon name="cloud-download-outline" size={18} color={C.ok} />
            <Text style={s.bulletTxt}>Restoring re-installs your Signal identity, then pulls every mirrored message back.</Text>
          </View>
          <View style={s.bullet}>
            <Icon name="alert-circle-outline" size={18} color={C.warn} />
            <Text style={s.bulletTxt}>5 wrong attempts triggers a 1-hour cool-down.</Text>
          </View>

          {headerLoading ? (
            <ActivityIndicator color={C.tx2} style={{marginVertical: 16}} />
          ) : lockedRemainingSec > 0 ? (
            <View style={[s.notice, {borderColor: C.err}]}>
              <Icon name="lock-clock" size={18} color={C.err} />
              <Text style={[s.noticeTxt, {color: C.err}]}>
                Too many wrong attempts. Try again in {formatDuration(lockedRemainingSec)}.
              </Text>
            </View>
          ) : (
            <>
              <Text style={s.label}>BACKUP PASSWORD</Text>
              <View style={s.pwdRow}>
                <TextInput
                  style={[s.input, s.pwdInput]}
                  value={pwd}
                  onChangeText={setPwd}
                  placeholder="Enter your backup password"
                  placeholderTextColor={C.tx3}
                  secureTextEntry={!showPwd}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                  textContentType="oneTimeCode"
                  importantForAutofill="no"
                  editable={!busy}
                  onFocus={revealField}
                />
                <TouchableOpacity
                  style={s.eyeBtn}
                  onPress={() => setShowPwd(v => !v)}
                  accessibilityRole="button"
                  accessibilityLabel={showPwd ? 'Hide password' : 'Show password'}
                  activeOpacity={0.7}>
                  <Icon name={showPwd ? 'eye-off-outline' : 'eye-outline'} size={20} color={C.tx2} />
                </TouchableOpacity>
              </View>
              {attemptsLeft < MAX_ATTEMPTS && attemptsLeft > 0 && (
                <Text style={[s.warn, {color: attemptsLeft <= 2 ? C.err : C.warn}]}>
                  {attemptsLeft} {attemptsLeft === 1 ? 'attempt' : 'attempts'} left.
                </Text>
              )}
              {err && <Text style={s.err} accessibilityLiveRegion="polite">{humanizeBackupError(err)}</Text>}
              <TouchableOpacity
                style={[s.primaryBtn, (busy || !pwd) && s.primaryBtnDisabled]}
                disabled={busy || !pwd}
                onPress={() => { void handleRestore(); }}
                activeOpacity={0.85}>
                <Text style={s.primaryBtnTxt}>RESTORE</Text>
              </TouchableOpacity>
            </>
          )}

          <TouchableOpacity style={s.linkBtn} onPress={handleForgot} activeOpacity={0.7}>
            <Text style={s.linkBtnTxt}>Forgot password — start fresh</Text>
          </TouchableOpacity>
          </>
          )}
        </ScrollView>
      </View>
      {/* Full-screen overlay during/after restore. While `overlay`
          is set the password input is hidden behind a premium splash;
          on success or error the overlay owns the hand-off action. */}
      {overlay && (
        <RestoreProgressOverlay
          state={overlay}
          onContinue={() => navigation.replace('MessengerHome')}
          onClose={() => setOverlay(null)}
        />
      )}
    </View>
  );
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m === 0) {return `${s}s`;}
  return `${m}m ${s}s`;
}

const s = StyleSheet.create({
  root: {flex: 1, backgroundColor: C.bg},
  // flexGrow (not flex:1) so the ScrollView content fills the viewport
  // when short but can still scroll when the keyboard shrinks it —
  // otherwise the password input + RESTORE button hide behind the keyboard.
  body: {flexGrow: 1, padding: 20, gap: 12, paddingBottom: 40},
  heroIconWrap: {alignItems: 'center', paddingVertical: 20},
  h1: {color: C.tx1, fontSize: 18, fontWeight: '800', textAlign: 'center'},
  p:  {color: C.tx2, fontSize: 13, lineHeight: 19, textAlign: 'center'},
  label: {color: C.tx3, fontSize: 11, fontWeight: '700', letterSpacing: 0.8, marginTop: 16},
  input: {
    backgroundColor: C.surf2, borderWidth: 1, borderColor: C.bd,
    borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12,
    color: C.tx1, fontSize: 14,
  },
  // Round 5 UX: see BackupSetupScreen for full reasoning.
  pwdRow: {position: 'relative'},
  pwdInput: {paddingRight: 44},
  eyeBtn: {
    position: 'absolute', right: 4, top: 0, bottom: 0,
    width: 40, alignItems: 'center', justifyContent: 'center',
  },
  warn: {color: C.warn, fontSize: 12, marginTop: 4},
  err:  {color: C.err,  fontSize: 12, marginTop: 4},
  notice: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    padding: 14, borderRadius: 10, borderWidth: 1,
    backgroundColor: C.surf2, marginTop: 10,
  },
  noticeTxt: {fontSize: 13, fontWeight: '600', flex: 1},
  primaryBtn: {
    marginTop: 18, paddingVertical: 14, borderRadius: 12,
    alignItems: 'center', backgroundColor: C.act,
  },
  primaryBtnDisabled: {opacity: 0.4},
  primaryBtnTxt: {color: '#FFF', fontSize: 13, fontWeight: '800', letterSpacing: 1},
  linkBtn: {paddingVertical: 14, alignItems: 'center', marginTop: 8},
  linkBtnTxt: {color: C.tx3, fontSize: 13, fontWeight: '600', textDecorationLine: 'underline'},
  topBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingVertical: 10,
  },
  iconBtn: {
    width: 38, height: 38, borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)',
    alignItems: 'center', justifyContent: 'center',
  },
  title: {color: C.tx1, fontSize: 13, fontWeight: '700', letterSpacing: 1.4},
  bullet: {
    flexDirection: 'row', gap: 10, alignItems: 'flex-start',
    backgroundColor: '#0C1018', borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)',
    borderRadius: 10, padding: 12,
  },
  bulletTxt: {color: C.tx2, fontSize: 12, lineHeight: 17, flex: 1},
});
