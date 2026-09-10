import React, {useEffect, useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  StatusBar,
  Vibration,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import * as LocalAuthentication from 'expo-local-authentication';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Alert} from '@utils/alert';
import {Colors} from '@theme/index';
import {useNavigation, useRoute} from '@react-navigation/native';
import type {RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {MessengerStackParamList} from '@navigation/types';
import {useVaultStore} from '@/modules/messenger/vault';
import {syncPinToServer, takeProvenPin, apiErrCode} from '@/modules/messenger/vault/vaultPinSession';
import {goBackOnce} from '@navigation/tapGuard';
import {findNavigatorWithRoute, navigateVia} from '@navigation/departmentalEntry';

type Nav = NativeStackNavigationProp<MessengerStackParamList, 'VaultNewPin'>;

const KEYPAD = [
  [{num: '1', sub: ''}, {num: '2', sub: 'ABC'}, {num: '3', sub: 'DEF'}],
  [{num: '4', sub: 'GHI'}, {num: '5', sub: 'JKL'}, {num: '6', sub: 'MNO'}],
  [{num: '7', sub: 'PQRS'}, {num: '8', sub: 'TUV'}, {num: '9', sub: 'WXYZ'}],
];

type Step = 'new' | 'confirm';

/**
 * B-696 (VAULT_DURABILITY_DESIGN §4.2/§5) — this screen now has three modes:
 *   'create'  — the pre-B-696 behavior, unchanged: first setup, or a PIN
 *               change reached through the lock (hasPin ? changePin : setupPin).
 *   'readopt' — fresh install, but the SERVER says this account already has a
 *               vault PIN: ask for it ONCE, verify server-side, re-mint the
 *               local gate from the typed plaintext. The PIN follows the
 *               person. Entered only on a positive server answer — an
 *               offline probe falls through to 'create' (today's UX), and the
 *               server's current_pin_required rule makes that fail-safe.
 *   'reset'   — arrived from the Forgot-PIN flow carrying a single-use
 *               resetToken; the server swaps the verifier, the local gate
 *               re-mints, and the FILES ARE KEPT (the PIN is a gate, not a
 *               key — setupPin never touches the file index).
 */
type Mode = 'create' | 'readopt' | 'reset';

export default function VaultNewPinScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<RouteProp<MessengerStackParamList, 'VaultNewPin'>>();
  const insets = useSafeAreaInsets();
  const setupPin = useVaultStore(s => s.setupPin);
  const hasPin   = useVaultStore(s => s.hasPin());
  const changePin = useVaultStore(s => s.changePin);
  const setBiometricEnabled = useVaultStore(s => s.setBiometricEnabled);
  const resetToken = route.params?.resetToken;
  const [mode, setMode] = useState<Mode>(resetToken ? 'reset' : 'create');
  const [step, setStep] = useState<Step>('new');
  const [newPin, setNewPin] = useState('');
  const [entered, setEntered] = useState('');
  const [status, setStatus] = useState<{text: string; color: string} | null>(null);
  const [dotState, setDotState] = useState<'normal' | 'success' | 'error'>('normal');
  const [busy, setBusy] = useState(false);

  // Review F3 — the probe below must not yank a user who already started
  // typing. The async callback's closure is mount-stale, so it reads the
  // LIVE entry state through this render-synced ref instead.
  const entryRef = React.useRef({entered: '', step: 'new' as Step, newPin: ''});
  entryRef.current = {entered, step, newPin};

  // B-696 re-adopt probe — only when there is no local PIN and we are not in
  // the reset lane. A positive answer flips to 'readopt'; anything else
  // (absent, offline, refused) leaves 'create' — the pre-B-696 experience.
  useEffect(() => {
    if (hasPin || resetToken) {return;}
    let cancelled = false;
    void (async () => {
      try {
        const {authApi} = require('@/services/api') as typeof import('@/services/api');
        const {exists} = await authApi.getVaultPinStatus();
        // Review F3 — flip only while the keypad is pristine. A slow probe
        // on a fast typist simply leaves them in create mode; the server's
        // current_pin_required refusal keeps that fail-safe.
        const live = entryRef.current;
        if (!cancelled && exists && live.entered === '' && live.step === 'new' && live.newPin === '') {
          setMode('readopt');
          setStatus(null);
        }
      } catch { /* offline — stay in create mode */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only probe; hasPin/resetToken are fixed for this screen's lifetime
  }, []);

  const press = (digit: string) => {
    if (entered.length >= 6) {return;}
    Vibration.vibrate(8);
    const next = entered + digit;
    setEntered(next);
    if (next.length === 6) {
      setTimeout(() => handleComplete(next), 120);
    }
  };

  const backspace = () => {
    Vibration.vibrate(6);
    setEntered(p => p.slice(0, -1));
    setStatus(null);
  };

  /**
   * B-459 — `setBiometricEnabled` had ZERO call sites, so `biometricEnabled`
   * was permanently false and the lock screen's auto-prompt could never fire.
   * Audit fix #36 made biometric opt-IN and named this screen as the place the
   * consent prompt belongs; the prompt was simply never built.
   *
   * Deliberately non-blocking: it never gates entry to the vault, so a device
   * that hangs or throws inside the LocalAuthentication probe still lands the
   * user where the PIN flow was taking them. Consent only ever turns the flag
   * ON — the PIN keeps working either way, so declining costs nothing.
   *
   * The COPY is load-bearing, and it has now been wrong twice. The original
   * promised a reversal the product could not honour. The B-459 fix replaced
   * that with "change your PIN to enable it later", which was true only while
   * this flow was the sole door. Messenger Settings → FILE VAULT now owns a
   * real toggle, so the prompt points at it — and the copy pin and the
   * toggle-existence scan in vaultBiometricOptIn.test.ts sit side by side on
   * purpose: flipping a promise pin without enforcing the promise is exactly
   * the defect B-459 was.
   */
  const offerBiometricUnlock = async () => {
    try {
      const [hasHardware, isEnrolled] = await Promise.all([
        LocalAuthentication.hasHardwareAsync(),
        LocalAuthentication.isEnrolledAsync(),
      ]);
      // No sensor, or no fingerprint/face registered: offering it would be a
      // dead switch that silently does nothing at the lock screen.
      if (!hasHardware || !isEnrolled) {return;}
      Alert.alert(
        'Unlock with fingerprint or face?',
        'Open your vault with the biometric you already use to unlock this device, instead of typing the PIN every time. Your PIN keeps working. You can turn this off any time in Settings.',
        [
          {text: 'Not now', style: 'cancel'},
          {text: 'Enable', onPress: () => setBiometricEnabled(true)},
        ],
      );
    } catch { /* probe unavailable — stay PIN-only, never block the user */ }
  };

  /**
   * The Settings lane's return leg. Reachable because VaultLock's no-PIN
   * redirect forwards `route.params` whole: a malformed legacy hash nulls
   * `pinHash` mid-flow and drops a Settings-lane user here. RESOLVED rather
   * than bare-navigated for the same Issues-18/19 reason as the lock screen,
   * and `navigate` rather than `replace` so the user lands back on the LIVE
   * Settings instance with their unsaved edits intact.
   */
  const returnToSettings = () => {
    const target = findNavigatorWithRoute(navigation, 'MessengerSettings');
    if (target) {navigateVia(target, 'MessengerSettings');}
    else {navigation.replace('VaultScreen');}
  };

  /** Shared success tail: consent offer + land where the gate was opened from. */
  const finishUnlocked = (savedText: string) => {
    setDotState('success');
    setStatus({text: savedText, color: '#00C853'});
    // B-459 — offered whenever the flow completes and biometric is still
    // OFF, PIN change included. Gating it on first creation made this the
    // only door in the app and then bricked it: a user who tapped "Not
    // now" once could never turn biometric on again, because there is no
    // settings toggle and the prompt never returned. Someone who already
    // enabled it is never re-asked.
    // Read at CALL time, not render time. This runs behind an awaited
    // Argon2 hash (~300ms) and there is now a Settings toggle that can
    // flip the flag from another surface, so a render-time capture can be
    // stale by the time it is consulted — and the stale value re-offers a
    // consent prompt for something the user already turned on.
    if (!useVaultStore.getState().biometricEnabled) {void offerBiometricUnlock();}
    // B-453 — a user who was gated on the on-device Files browser must
    // land back on it, not in a Cloud Vault they may not be entitled to.
    // Absent (openVault's own first-run path) still means the vault.
    const next = route.params?.next;
    setTimeout(() => {
      if (next === 'Files') {navigation.replace('Files');}
      else if (next === 'MessengerHome') {navigation.replace('MessengerHome');}
      else if (next === 'MessengerSettings') {returnToSettings();}
      else {navigation.replace('VaultScreen');}
    }, 700);
  };

  const failEntry = (text: string, thenReset: boolean) => {
    Vibration.vibrate(50);
    setDotState('error');
    setStatus({text, color: '#D50000'});
    setTimeout(() => {
      setDotState('normal');
      setEntered('');
      if (thenReset) {
        setStep('new');
        setNewPin('');
        setStatus(null);
      }
    }, 600);
  };

  /**
   * B-696 readopt — the server verifier confirms the typed PIN belongs to
   * this account, then the LOCAL gate re-mints from the same plaintext.
   * Wrong PIN burns a server-side attempt (Redis lockout, uniform errors),
   * never a local one — there is no local hash to attempt against yet.
   */
  const handleReadopt = async (pin: string) => {
    setBusy(true);
    setStatus({text: 'Checking your PIN…', color: '#5B8DEF'});
    try {
      const {authApi} = require('@/services/api') as typeof import('@/services/api');
      await authApi.verifyVaultPin({pin});
      await setupPin(pin);
      // Server just proved it holds THIS pin — any recorded sync debt is paid.
      useVaultStore.getState().setPinSyncState({pending: false, diverged: false});
      finishUnlocked('PIN restored — unlocking vault');
    } catch (e) {
      const codeVal = apiErrCode(e);
      if (codeVal === 'vault_pin_not_set') {
        // Raced a reset elsewhere — fall through to fresh setup.
        setMode('create');
        setEntered('');
        setStatus({text: 'No PIN on record — set a new one', color: '#5B8DEF'});
      } else if (codeVal === null) {
        failEntry('Can’t reach the server — check your connection', false);
      } else {
        failEntry('Wrong PIN — try again, or tap Forgot PIN', false);
      }
    } finally {
      setBusy(false);
    }
  };

  /** B-696 reset — the single-use token authorizes the verifier swap; the
   *  files are untouched (setupPin never touches the index). */
  const handleResetComplete = async (pin: string) => {
    setBusy(true);
    setStatus({text: 'Saving your new PIN…', color: '#5B8DEF'});
    try {
      const {authApi} = require('@/services/api') as typeof import('@/services/api');
      await authApi.completeVaultPinReset({resetToken: resetToken!, pin});
      await setupPin(pin);
      // The server verifier was just SET to this pin — both sides agree.
      useVaultStore.getState().setPinSyncState({pending: false, diverged: false});
      finishUnlocked('PIN reset — unlocking vault');
    } catch (e) {
      const codeVal = apiErrCode(e);
      if (codeVal === null) {
        failEntry('Can’t reach the server — check your connection', true);
      } else {
        // Token expired/spent — the only honest way forward is a fresh OTP.
        setStatus({text: 'Reset link expired — start again from Forgot PIN', color: '#D50000'});
        setDotState('error');
        setTimeout(() => navigation.replace('VaultForgot', route.params?.next ? {next: route.params.next} : undefined), 1200);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleComplete = (pin: string) => {
    if (busy) {return;}
    if (mode === 'readopt') {
      void handleReadopt(pin);
      return;
    }
    if (step === 'new') {
      setNewPin(pin);
      setEntered('');
      setStep('confirm');
      setStatus({text: 'PIN set — now confirm it', color: '#5B8DEF'});
    } else {
      if (pin === newPin) {
        if (mode === 'reset') {
          void handleResetComplete(pin);
          return;
        }
        // First-time setup: seed the PIN, then jump straight into the
        // vault (the act of confirming counts as an unlock). Re-using
        // this screen for a PIN change route is just `changePin` — we
        // don't land on VaultLock afterwards.
        //
        // Audit fix #35 — setupPin/changePin are now async (Argon2id
        // takes ~300 ms on a mid-tier Android). Await them so the
        // success UI doesn't flash before the hash actually lands.
        // Audit fix #36 — biometric is no longer auto-enabled here;
        // the setup screen should show a separate "Enable Face ID?"
        // prompt and call setBiometricEnabled(true) on consent.
        const wasChange = hasPin;
        const apply = wasChange ? changePin(pin) : setupPin(pin);
        void apply.then(() => {
          // B-696 — push the verifier server-side, best-effort (local-first:
          // a failure never blocks the vault). The change lane authorizes
          // the replace with the OLD pin the lock screen just proved
          // (single-take holder, never persisted); the server refuses a
          // bare replace, which is what makes an offline fresh setup unable
          // to clobber the account verifier.
          void syncPinToServer(pin, wasChange ? (takeProvenPin() ?? undefined) : undefined);
          finishUnlocked('PIN saved — unlocking vault');
        }).catch((e) => {
          Vibration.vibrate(50);
          setDotState('error');
          setStatus({text: `PIN setup failed: ${(e as Error).message}`, color: '#D50000'});
        });
      } else {
        failEntry('PINs do not match. Try again.', true);
      }
    }
  };

  const isConfirm = step === 'confirm';
  const isReadopt = mode === 'readopt';

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => goBackOnce(navigation)} activeOpacity={0.7} hitSlop={{top: 4, bottom: 4, left: 4, right: 4}}>
          <Icon name="arrow-left" size={20} color="rgba(229,233,242,0.62)" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>
          {isReadopt ? 'Vault PIN' : isConfirm ? 'Confirm PIN' : mode === 'reset' ? 'Reset PIN' : 'New PIN'}
        </Text>
        <View style={styles.backBtn} />
      </View>

      {/* Icon + title */}
      <View style={styles.iconSection}>
        <View style={styles.iconWrap}>
          <Icon name={isReadopt || isConfirm ? 'lock' : 'lock-open-variant'} size={24} color="#5B8DEF" />
        </View>
        <Text style={styles.title}>
          {isReadopt ? 'Enter Your Vault PIN' : isConfirm ? 'Confirm New PIN' : 'Set New PIN'}
        </Text>
        <Text style={styles.sub}>
          {isReadopt
            ? 'Your account already has a vault PIN — the one you used before'
            : isConfirm ? 'Re-enter your 6-digit PIN' : 'Enter a new 6-digit PIN'}
        </Text>
      </View>

      {/* PIN dots */}
      <View style={styles.dotsRow}>
        {Array.from({length: 6}).map((_, i) => (
          <View
            key={i}
            style={[
              styles.dot,
              i < entered.length && dotState === 'normal' && styles.dotFilled,
              i < entered.length && dotState === 'success' && styles.dotSuccess,
              i < entered.length && dotState === 'error' && styles.dotError,
            ]}
          />
        ))}
      </View>

      {/* Status message */}
      <Text style={[styles.statusMsg, {color: status?.color ?? 'transparent'}]}>
        {status?.text ?? '–'}
      </Text>

      {/* B-696 — the re-adopt lane's recovery door. Only here: create/reset
          modes have nothing to forget yet. */}
      {isReadopt && (
        <TouchableOpacity
          style={styles.forgotBtn}
          onPress={() => navigation.navigate('VaultForgot', route.params?.next ? {next: route.params.next} : undefined)}
          activeOpacity={0.7}>
          <Text style={styles.forgotText}>Forgot PIN?</Text>
        </TouchableOpacity>
      )}

      {/* Keypad. Bottom-most element, so it owes the bottom inset — see the
          matching comment in VaultLockScreen. */}
      <View style={[styles.keypad, {paddingBottom: insets.bottom + 16}]}>
        {KEYPAD.map((row, ri) => (
          <View key={ri} style={styles.keyRow}>
            {row.map(k => (
              <TouchableOpacity
                key={k.num}
                style={styles.keyBtn}
                onPress={() => press(k.num)}
                activeOpacity={0.7}>
                <Text style={styles.keyNum}>{k.num}</Text>
                {!!k.sub && <Text style={styles.keySub}>{k.sub}</Text>}
              </TouchableOpacity>
            ))}
          </View>
        ))}
        <View style={styles.keyRow}>
          <View style={styles.keyBtnEmpty} />
          <TouchableOpacity style={styles.keyBtn} onPress={() => press('0')} activeOpacity={0.7}>
            <Text style={styles.keyNum}>0</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.keyBtn} onPress={backspace} activeOpacity={0.7}>
            <Icon name="backspace-outline" size={22} color="rgba(229,233,242,0.62)" />
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: Colors.background},

  header: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: 'rgba(91,141,239,0.1)'},
  backBtn: {width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center'},
  headerTitle: {fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 2, color: 'rgba(229,233,242,0.62)'},

  iconSection: {alignItems: 'center', paddingTop: 16, paddingBottom: 8},
  iconWrap: {width: 48, height: 48, borderRadius: 16, backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.2)', alignItems: 'center', justifyContent: 'center', marginBottom: 8},
  title: {fontSize: 16, fontWeight: '800', color: '#F2F4F8', marginBottom: 2},
  sub: {fontSize: 11, color: 'rgba(180,188,204,0.45)'},

  dotsRow: {flexDirection: 'row', justifyContent: 'center', gap: 16, marginTop: 12, marginBottom: 4},
  dot: {width: 12, height: 12, borderRadius: 6, borderWidth: 2, borderColor: 'rgba(255,255,255,0.06)', backgroundColor: 'transparent'},
  dotFilled: {backgroundColor: '#5B8DEF', borderColor: '#5B8DEF'},
  dotSuccess: {backgroundColor: '#00C853', borderColor: '#00C853'},
  dotError: {backgroundColor: '#D50000', borderColor: '#D50000'},

  statusMsg: {textAlign: 'center', fontSize: 11, fontWeight: '600', minHeight: 16, marginBottom: 8},
  forgotBtn: {alignSelf: 'center', paddingVertical: 6, paddingHorizontal: 12},
  forgotText: {fontSize: 12, fontWeight: '700', color: '#5B8DEF'},

  keypad: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 24},
  keyRow: {flexDirection: 'row', gap: 20},
  keyBtn: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: 'rgba(91,141,239,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyBtnEmpty: {width: 58, height: 58},
  keyNum: {fontSize: 19, fontWeight: '700', color: '#F2F4F8', lineHeight: 22},
  keySub: {fontSize: 7, fontWeight: '600', color: 'rgba(180,188,204,0.45)', letterSpacing: 1.5, marginTop: 1},
});
