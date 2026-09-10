import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  StatusBar,
  Vibration,
  BackHandler,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import * as LocalAuthentication from 'expo-local-authentication';
import {Colors} from '@theme/index';
import {useFocusEffect, useNavigation, useRoute} from '@react-navigation/native';
import type {RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {MessengerStackParamList} from '@navigation/types';
import {findNavigatorWithRoute, isInDepartmentalShell, navigateVia} from '@navigation/departmentalEntry';
import {goBackOnce} from '@navigation/tapGuard';
import {useVaultStore} from '@/modules/messenger/vault';

type Nav = NativeStackNavigationProp<MessengerStackParamList, 'VaultLock'>;

const PIN_LENGTH = 6;

/**
 * Is the route DIRECTLY beneath this one the messenger Settings pane?
 *
 * Guard 2 of the Settings-lane cancel. Read off the live navigation state
 * rather than trusted from `route.params.next`, which is caller data.
 */
function settingsSitsBeneath(
  nav: {getState?: () => {index?: number; routes?: Array<{name?: string}>} | undefined},
): boolean {
  try {
    const st = nav.getState?.();
    const idx = st?.index;
    if (typeof idx !== 'number' || idx < 1) {return false;}
    return st?.routes?.[idx - 1]?.name === 'MessengerSettings';
  } catch {
    return false;
  }
}

const KEYS = [
  [{num: '1', alpha: ''}, {num: '2', alpha: 'ABC'}, {num: '3', alpha: 'DEF'}],
  [{num: '4', alpha: 'GHI'}, {num: '5', alpha: 'JKL'}, {num: '6', alpha: 'MNO'}],
  [{num: '7', alpha: 'PQRS'}, {num: '8', alpha: 'TUV'}, {num: '9', alpha: 'WXYZ'}],
];

/**
 * Vault unlock screen.
 *
 * Flow (matches Signal / WhatsApp vault UX):
 *   1. On mount — if biometric is enabled AND the device has biometric
 *      hardware/enrollment, auto-prompt biometric ONCE.
 *   2. If that succeeds, the vault unlocks and we forward to VaultScreen.
 *   3. If the user cancels / fails / biometric is unavailable, the PIN
 *      pad stays available as a fallback.
 *   4. PIN entry is validated locally against the stored SHA-256 hash
 *      (see `vaultStore.ts`). The PIN never leaves the device; access
 *      to server-side vault data is gated separately by the stateless
 *      HS256 action-token minted by auth-service (see `vaultClient.ts`).
 */
export default function VaultLockScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<RouteProp<MessengerStackParamList, 'VaultLock'>>();
  const insets = useSafeAreaInsets();
  const verifyPin        = useVaultStore(s => s.verifyPin);
  const unlockWithBio    = useVaultStore(s => s.unlockWithBiometric);
  const biometricEnabled = useVaultStore(s => s.biometricEnabled);
  const pinHash          = useVaultStore(s => s.pinHash);

  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [isError, setIsError] = useState(false);
  const [bioAvailable, setBioAvailable] = useState(false);
  const autoPromptedRef = useRef(false);

  // Why: VAULT-24/32 parity — leaving the lock screen must always reset
  // to MessengerHome. The header arrow used plain goBack(), which could
  // pop to a still-mounted unlocked VaultScreen below; hardware back
  // already resets (see the back-button audit fix below).
  //
  // B-453 — EXCEPT inside the workspace Vault tab, where the route literally
  // named 'MessengerHome' IS FilesScreen (see DepartmentalNavigator) and is
  // itself now gated: resetting onto it re-fires the guard and bounces
  // straight back here, a lock↔files loop with no way out. There the exit is
  // "leave the tab" — the parent tab navigator's Home — which is the same
  // "back out of the secret view" intent, one level up. The lock itself is
  // untouched: gestures stay disabled and hardware back still routes here.
  const inDeptShell = isInDepartmentalShell(navigation);
  const exitToHome = useCallback(() => {
    if (inDeptShell) {
      const parent = navigation.getParent();
      if (parent) {
        (parent.navigate as unknown as (name: string) => void)('Home');
        return;
      }
    }
    navigation.reset({index: 0, routes: [{name: 'MessengerHome'}]});
  }, [navigation, inDeptShell]);

  // B-453 — the gate now guards the on-device Files browser as well as the
  // cloud vault, so the destination is whatever asked for the unlock. Absent
  // (openVault, VaultScreen's own relock) still means the vault.
  const returnTo = route.params?.next;

  /**
   * The Settings lane's return leg (biometric toggle → "Enter PIN" → here).
   *
   * RESOLVED, never bare-navigated: this screen runs in three shells and a
   * hard-coded name that one of them does not register compiles and silently
   * no-ops (Issues 18/19). W1 registers `MessengerSettings` in all three, so
   * `null` is unreachable in practice — the `exitToHome` fallback exists so a
   * restored state or a deep link cannot strand the user on the keypad.
   *
   * `navigate`, NOT `replace`: the StackRouter pops back to the LIVE Settings
   * instance, so the user's unsaved profile edits (and the pane's `client.me()`
   * fetch) survive the round trip.
   */
  const forwardToSettings = useCallback(() => {
    const target = findNavigatorWithRoute(navigation, 'MessengerSettings');
    if (target) {navigateVia(target, 'MessengerSettings');}
    else {exitToHome();}
  }, [navigation, exitToHome]);

  const forwardToVault = useCallback(() => {
    if (returnTo === 'Files') {navigation.replace('Files');}
    else if (returnTo === 'MessengerHome') {navigation.replace('MessengerHome');}
    else if (returnTo === 'MessengerSettings') {forwardToSettings();}
    else {navigation.replace('VaultScreen');}
  }, [navigation, returnTo, forwardToSettings]);

  /**
   * Cancelling the lock. Everywhere except the Settings lane this is
   * `exitToHome` verbatim — the anti-leak reset is untouched.
   *
   * In the Settings lane the user came from a screen that is NOT the vault, so
   * resetting them to MessengerHome throws away the pane (and its unsaved
   * edits) for no security gain. Both preconditions are CHECKED, because
   * `next` is caller data that survives deep links and restored state:
   *   1. `canGoBack()` — a `goBack()` that no-ops while the hardware-back
   *      handler still returns true leaves the user HARD-STUCK on the lock,
   *      which is worse than the data loss it was avoiding.
   *   2. the route directly beneath really is `MessengerSettings`.
   * Either one false ⇒ the original exit. `goBackOnce`, not raw `goBack`, so a
   * double tap cannot bubble a pop to the parent navigator (B-261).
   */
  const cancelLock = useCallback(() => {
    if (returnTo === 'MessengerSettings'
        && navigation.canGoBack()
        && settingsSitsBeneath(navigation)) {
      goBackOnce(navigation);
      return;
    }
    exitToHome();
  }, [returnTo, navigation, exitToHome]);

  const tryBiometric = useCallback(async () => {
    try {
      const [hasHw, hasCreds] = await Promise.all([
        LocalAuthentication.hasHardwareAsync(),
        LocalAuthentication.isEnrolledAsync(),
      ]);
      if (!hasHw || !hasCreds) {
        setBioAvailable(false);
        return;
      }
      setBioAvailable(true);
      const res = await LocalAuthentication.authenticateAsync({
        promptMessage:         'Unlock Bravo Vault',
        fallbackLabel:         'Use PIN',
        cancelLabel:           'Cancel',
        disableDeviceFallback: false,
      });
      if (res.success) {
        unlockWithBio();
        forwardToVault();
      }
    } catch {
      // Fall through to the PIN keypad silently — UX preserves entry.
    }
  }, [unlockWithBio, forwardToVault]);

  // Round 7 / back-button audit fix #4 — trap the Android hardware back
  // button so it CANNOT bypass the lock. Previously, hardware back
  // simply popped this screen and revealed whatever was below it; if
  // VaultScreen was kept warm in the stack (freezeOnBlur), the user
  // could see the unlocked vault contents without unlocking. Route
  // back to MessengerHome instead — match the WhatsApp chat-lock
  // pattern where back exits to the chat list, not to the secret view.
  useFocusEffect(
    useCallback(() => {
      const onBack = () => {
        cancelLock();
        return true;
      };
      const sub = BackHandler.addEventListener('hardwareBackPress', onBack);
      return () => sub.remove();
    }, [cancelLock]),
  );

  // Issue 20 — a PIN keypad is meaningless with no PIN set. openVault() already
  // branches on hasPin(), but this screen is also a registered route in four
  // navigators, so a deep link or a restored navigation state can land here
  // directly. Redirect to setup rather than asking for a code that cannot exist.
  //
  // Keyed on `pinHash` rather than run once on mount: `verifyPin` NULLS the hash
  // when it finds a malformed record (a pre-Argon2 bare SHA-256, see
  // vaultStore's B-456 note), which strands the user on a keypad that can never
  // accept anything. Subscribed, so that lands on setup immediately.
  //
  // `route.params` is forwarded whole — the destination the caller asked for
  // (`next`) has to survive the hop, or a Files-gated user who turns out to have
  // no PIN sets one and is dropped into the cloud vault instead of the browser
  // they tapped.
  useEffect(() => {
    if (pinHash === null) {
      navigation.replace('VaultNewPin', route.params);
    }
  }, [navigation, pinHash, route.params]);

  // A warm VaultLock can outlive the lock it guards: inside the Departmental
  // Vault tab this screen stays in the stack, so unlocking anywhere else (the
  // personal stack's own lock, a biometric prompt) left the user staring at a
  // keypad for a vault that is already open. Forward on focus instead.
  useFocusEffect(
    useCallback(() => {
      if (useVaultStore.getState().isUnlocked()) {forwardToVault();}
    }, [forwardToVault]),
  );

  // Auto-prompt biometric once per mount when enabled. Mirrors the
  // "instant unlock" behaviour of WhatsApp / Signal's chat lock.
  useEffect(() => {
    if (autoPromptedRef.current) {return;}
    autoPromptedRef.current = true;
    if (biometricEnabled) {
      void tryBiometric();
    } else {
      void (async () => {
        const [hasHw, hasCreds] = await Promise.all([
          LocalAuthentication.hasHardwareAsync(),
          LocalAuthentication.isEnrolledAsync(),
        ]);
        setBioAvailable(hasHw && hasCreds);
      })();
    }
  }, [biometricEnabled, tryBiometric]);

  const press = (digit: string) => {
    if (pin.length >= PIN_LENGTH) {return;}
    Vibration.vibrate(8); // crisp tap — mirrors the Bravo chat send haptic
    const next = pin + digit;
    setPin(next);
    setError('');
    setIsError(false);
    if (next.length === PIN_LENGTH) {
      // Schedule the verify after the paint so the 6th dot fills before
      // we either forward or flash red. The setTimeout callback is
      // intentionally non-async; we kick the async work off via a void
      // IIFE so the setTimeout signature stays Promise-free (lint rule
      // @typescript-eslint/no-misused-promises).
      setTimeout(() => {
        void (async () => {
          // Audit fix #34/#35 — verifyPin is now async and returns a
          // discriminated union so we can surface lockout state to the
          // user. We only branch on `ok` here; the screen could later
          // render the remaining-attempts / msUntilRetry counts to
          // match WhatsApp's lockout UX.
          const result = await verifyPin(next);
          if (result.ok) {
            // B-696 — two fire-and-forget notes off a successful unlock:
            // the single-take holder authorizes a change-lane server
            // replace (the NewPin screen never sees the old plaintext),
            // and reconcileServerPin settles the account verifier — minting
            // it when absent (self-heals every pre-B-696 install on its
            // first unlock) and retrying any recorded sync debt (review
            // F1). Neither ever blocks the vault. The 'diverged-new' edge
            // fires EXACTLY ONCE per divergence: the server holds a
            // different PIN and S2 makes Forgot-PIN the only overwrite
            // door, so the user gets told once, not nagged per unlock.
            try {
              const {notePinProven, reconcileServerPin} =
                require('@/modules/messenger/vault/vaultPinSession') as
                  typeof import('@/modules/messenger/vault/vaultPinSession');
              notePinProven(next);
              void reconcileServerPin(next).then(outcome => {
                if (outcome !== 'diverged-new') {return;}
                const {Alert} = require('@utils/alert') as typeof import('@utils/alert');
                Alert.alert(
                  'Vault PIN out of sync',
                  'The PIN on this phone is different from the one saved to your account '
                  + '(it was changed while offline, or set on another device). Your phone '
                  + 'PIN keeps working here. To make your account match this phone — so a '
                  + 'reinstall asks for THIS PIN — use “Forgot PIN?” on the vault lock '
                  + 'screen and confirm with your account password.',
                );
              }).catch(() => { /* fire-and-forget */ });
            } catch { /* module unavailable — local unlock is unaffected */ }
            forwardToVault();
            setPin('');
          } else {
            Vibration.vibrate(50);
            setIsError(true);
            if (result.reason === 'lockout') {
              const sec = Math.ceil(result.msUntilRetry / 1000);
              setError(`Too many attempts. Try again in ${sec}s.`);
            } else {
              setError('Incorrect PIN. Try again.');
            }
            setTimeout(() => {
              setPin('');
              setIsError(false);
            }, 600);
          }
        })();
      }, 80);
    }
  };

  const backspace = () => {
    Vibration.vibrate(6);
    setPin(prev => prev.slice(0, -1));
    setError('');
    setIsError(false);
  };

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={cancelLock}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Leave vault lock"
          hitSlop={{top: 4, bottom: 4, left: 4, right: 4}}>
          <Icon name="arrow-left" size={20} color="rgba(229,233,242,0.62)" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>SECURE VAULT</Text>
        <View style={{width: 36}} />
      </View>

      {/* Lock icon + title */}
      <View style={styles.lockSection}>
        <View style={styles.lockIcon}>
          <Icon name="lock" size={24} color="#5B8DEF" />
        </View>
        <Text style={styles.lockTitle}>Enter Vault PIN</Text>
        <Text style={styles.lockSub}>
          {biometricEnabled && bioAvailable
            ? 'Use biometric or enter your 6-digit PIN'
            : 'Enter your 6-digit security code'}
        </Text>
      </View>

      {/* PIN dots */}
      <View style={styles.dotsRow}>
        {Array.from({length: PIN_LENGTH}).map((_, i) => (
          <View
            key={i}
            style={[
              styles.dot,
              i < pin.length && styles.dotFilled,
              isError && i < pin.length && styles.dotError,
            ]}
          />
        ))}
      </View>

      {/* Error */}
      <Text style={styles.errorText}>{error}</Text>

      {/* Keypad. It is the bottom-most element, so it owes the bottom inset:
          without it the fingerprint / 0 / backspace row sits on the screen
          edge under the gesture pill, where the touch targets compete with the
          system back-swipe. The root only ever applied insets.top. */}
      <View style={[styles.keypad, {paddingBottom: insets.bottom + 16}]}>
        {KEYS.map((row, ri) => (
          <View key={ri} style={styles.keyRow}>
            {row.map(k => (
              <TouchableOpacity
                key={k.num}
                style={styles.keyBtn}
                onPress={() => press(k.num)}
                activeOpacity={0.7}>
                <Text style={styles.keyNum}>{k.num}</Text>
                {k.alpha ? <Text style={styles.keyAlpha}>{k.alpha}</Text> : null}
              </TouchableOpacity>
            ))}
          </View>
        ))}
        <View style={styles.keyRow}>
          {/* Biometric unlock is HARD OPT-IN: the key exists only when the user
              turned it on AND the device can serve it. A dimmed-but-present key
              advertised an unlock path the user declined, and tapping it fired
              the OS prompt — which on a device with a co-worker's fingerprint
              enrolled is somebody else's finger opening this vault. Hidden, not
              disabled; a spacer keeps the 0 key centred. */}
          {biometricEnabled && bioAvailable ? (
            <TouchableOpacity
              style={styles.keyBtn}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Unlock with biometrics"
              onPress={() => { void tryBiometric(); }}>
              <Icon name="fingerprint" size={24} color="#5B8DEF" />
            </TouchableOpacity>
          ) : (
            <View style={styles.keyBtnSpacer} />
          )}
          <TouchableOpacity style={styles.keyBtn} onPress={() => press('0')} activeOpacity={0.7}>
            <Text style={styles.keyNum}>0</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.keyBtn} onPress={backspace} activeOpacity={0.7}>
            <Icon name="backspace-outline" size={22} color="rgba(229,233,242,0.62)" />
          </TouchableOpacity>
        </View>
      </View>

      {/* Forgot PIN. B-696 — carries the gate's `next` so the reset lane can
          land the user back where the lock stopped them. */}
      <TouchableOpacity
        style={styles.forgotBtn}
        activeOpacity={0.7}
        onPress={() => navigation.navigate('VaultForgot', route.params?.next ? {next: route.params.next} : undefined)}>
        <Text style={styles.forgotText}>Forgot PIN?</Text>
      </TouchableOpacity>

      <View style={styles.spacer} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: Colors.background},

  header: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: 'rgba(91,141,239,0.1)'},
  backBtn: {width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center'},
  headerTitle: {fontSize: 12, fontWeight: '700', color: 'rgba(229,233,242,0.62)', letterSpacing: 3, textTransform: 'uppercase'},

  lockSection: {alignItems: 'center', paddingTop: 24, paddingBottom: 16},
  lockIcon: {width: 48, height: 48, borderRadius: 16, backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.2)', alignItems: 'center', justifyContent: 'center', marginBottom: 8},
  lockTitle: {fontSize: 16, fontWeight: '800', color: 'rgba(229,233,242,0.62)', marginBottom: 4},
  lockSub: {fontSize: 11, color: 'rgba(180,188,204,0.45)', textAlign: 'center', paddingHorizontal: 32},

  dotsRow: {flexDirection: 'row', justifyContent: 'center', gap: 16, marginBottom: 8},
  dot: {width: 12, height: 12, borderRadius: 6, borderWidth: 2, borderColor: 'rgba(255,255,255,0.06)', backgroundColor: 'transparent'},
  dotFilled: {backgroundColor: '#5B8DEF', borderColor: '#5B8DEF'},
  dotError: {backgroundColor: '#D50000', borderColor: '#D50000'},

  errorText: {fontSize: 11, color: '#f87171', fontWeight: '600', textAlign: 'center', minHeight: 16, marginBottom: 8},

  keypad: {alignItems: 'center', gap: 8, paddingHorizontal: 24},
  keyRow: {flexDirection: 'row', gap: 20},
  keyBtn: {width: 58, height: 58, borderRadius: 29, backgroundColor: 'rgba(91,141,239,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)', alignItems: 'center', justifyContent: 'center'},
  // Holds the biometric key's place so hiding it does not shift 0 off centre.
  keyBtnSpacer: {width: 58, height: 58},
  keyNum: {fontSize: 19, fontWeight: '700', color: '#F2F4F8', lineHeight: 22},
  keyAlpha: {fontSize: 7, fontWeight: '600', color: 'rgba(180,188,204,0.45)', letterSpacing: 1.5, marginTop: 1},

  forgotBtn: {alignItems: 'center', marginTop: 12},
  forgotText: {fontSize: 12, color: 'rgba(180,188,204,0.45)', fontWeight: '500'},
  spacer: {flex: 1},
});
