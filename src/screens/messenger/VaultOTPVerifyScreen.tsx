import React, {useState, useRef, useEffect} from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  StatusBar,
  TextInput,
  ActivityIndicator,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Colors} from '@theme/index';
import {useNavigation, useRoute} from '@react-navigation/native';
import type {RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {MessengerStackParamList} from '@navigation/types';
import KeyboardAvoidingScreen from '@components/KeyboardAvoidingScreen';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';
import {apiErrCode} from '@/modules/messenger/vault/vaultPinSession';

// B-696 Phase C (VAULT_DURABILITY_DESIGN_2026-08-29 §5) — the live half of
// the audit-S2 closure. The old stub's `^\d{6}$` client-side "verification"
// is gone for good: the code below is checked by auth-service against the
// Twilio Verify challenge it actually sent (POST /auth/vault-pin/reset/verify),
// and a pass hands back a SINGLE-USE 5-minute reset token that the next
// screen exchanges for the new verifier. Nothing on this screen is trusted.
//
// ONE code, not the old email+phone pair: the server texts the ACCOUNT's
// phone (no free-text identities anywhere in this lane), whose masked form
// arrives as a route param from the request step.

type Nav = NativeStackNavigationProp<MessengerStackParamList, 'VaultOTPVerify'>;

export default function VaultOTPVerifyScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<RouteProp<MessengerStackParamList, 'VaultOTPVerify'>>();
  const insets = useSafeAreaInsets();
  const [code, setCode] = useState(['', '', '', '', '', '']);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [countdown, setCountdown] = useState(45);
  const [expired, setExpired] = useState(false);

  const refs = useRef<(TextInput | null)[]>([]);

  useEffect(() => {
    const iv = setInterval(() => {
      setCountdown(s => {
        if (s <= 1) {
          clearInterval(iv);
          setExpired(true);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(iv);
  }, []);

  const handleBox = (i: number, val: string) => {
    const digit = val.replace(/\D/g, '').slice(-1);
    const next = [...code];
    next[i] = digit;
    setCode(next);
    setError('');
    if (digit && i < 5) {refs.current[i + 1]?.focus();}
  };

  const handleBackspace = (i: number) => {
    if (code[i] === '' && i > 0) {
      refs.current[i - 1]?.focus();
    } else {
      const next = [...code];
      next[i] = '';
      setCode(next);
    }
  };

  const joined = code.join('');
  const complete = joined.length === 6;

  const verify = async () => {
    if (!complete || busy) {return;}
    setBusy(true);
    setError('');
    try {
      const {authApi} = require('@/services/api') as typeof import('@/services/api');
      const {resetToken} = await authApi.verifyVaultPinReset({code: joined});
      navigation.replace('VaultNewPin', {
        resetToken,
        ...(route.params?.next ? {next: route.params.next} : {}),
      });
    } catch (e) {
      const codeVal = apiErrCode(e);
      if (codeVal === null) {
        setError('Can’t reach the server — check your connection.');
      } else {
        // Uniform for wrong/expired code AND lockout — the server keeps
        // those byte-identical on purpose.
        setError('That code didn’t work. Check it, or request a new one.');
        setCode(['', '', '', '', '', '']);
        refs.current[0]?.focus();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => goBackOnce(navigation)} activeOpacity={0.7}>
          <Icon name="arrow-left" size={20} color="rgba(229,233,242,0.62)" />
        </TouchableOpacity>
      </View>

      {/* KeyboardAvoidingScreen lifts by the IME overlap but does NOT add the
          resting bottom inset — that is the caller's, and every other caller in
          this module already does it. Without it the Verify button sits under
          the gesture pill / home indicator. */}
      <KeyboardAvoidingScreen contentContainerStyle={[styles.main, {paddingBottom: insets.bottom + 24}]}>
        <Text style={styles.heading}>Verify your identity</Text>
        <Text style={styles.sub}>
          Enter the 6-digit code we texted to{' '}
          <Text style={styles.subStrong}>{route.params?.maskedPhone ?? 'your registered phone'}</Text>.
        </Text>

        {/* The one code that matters */}
        <View style={styles.otpBlock}>
          <View style={styles.otpLabelRow}>
            <Icon name="phone-outline" size={15} color="#5B8DEF" />
            <Text style={styles.otpLabel}>Verification code</Text>
          </View>
          <View style={styles.boxRow}>
            {code.map((val, i) => (
              <TextInput
                key={i}
                ref={el => { refs.current[i] = el; }}
                style={[styles.otpBox, !!error && styles.otpBoxError, val && styles.otpBoxFilled]}
                value={val}
                onChangeText={v => handleBox(i, v)}
                onKeyPress={({nativeEvent}) => {
                  if (nativeEvent.key === 'Backspace') {handleBackspace(i);}
                }}
                keyboardType="number-pad"
                maxLength={1}
                selectTextOnFocus
              />
            ))}
          </View>
          <Text style={[styles.errorText, !error && {opacity: 0}]}>{error || ' '}</Text>
        </View>

        {/* Resend = go back and prove the password again. The code send is
            password-gated by design (audit S2), so there is no password-less
            resend endpoint to call from here. */}
        <View style={styles.resendRow}>
          {expired ? (
            <TouchableOpacity onPress={() => goBackOnce(navigation)} activeOpacity={0.7}>
              <Text style={styles.resendActive}>Didn’t get it? Request a new code</Text>
            </TouchableOpacity>
          ) : (
            <Text style={styles.resendLabel}>
              Code sent · request another in <Text style={styles.resendTimer}>0:{String(countdown).padStart(2, '0')}</Text>
            </Text>
          )}
        </View>

        {/* Verify */}
        <View style={styles.btnWrap}>
          <TouchableOpacity
            style={[styles.verifyBtn, (!complete || busy) && styles.verifyBtnDisabled]}
            onPress={() => { void verify(); }}
            disabled={!complete || busy}
            activeOpacity={0.85}>
            {busy
              ? <ActivityIndicator color="#FFF" />
              : <Text style={styles.verifyBtnText}>Verify & Continue</Text>}
          </TouchableOpacity>
        </View>

        <Text style={styles.footHint}>
          Your vault files are untouched by a PIN reset.
        </Text>
      </KeyboardAvoidingScreen>
    </View>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: Colors.background},

  header: {paddingHorizontal: 16, paddingBottom: 8},
  backBtn: {width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center'},

  main: {paddingHorizontal: 20, paddingBottom: 24, flexGrow: 1},
  heading: {fontSize: 24, fontWeight: '700', color: '#F2F4F8', marginBottom: 4},
  sub: {fontSize: 14, color: 'rgba(229,233,242,0.62)', lineHeight: 20, marginBottom: 20},
  subStrong: {color: '#F2F4F8', fontWeight: '700'},

  otpBlock: {marginBottom: 4},
  otpLabelRow: {flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8},
  otpLabel: {fontSize: 12, fontWeight: '600', color: 'rgba(229,233,242,0.62)', textTransform: 'uppercase', letterSpacing: 1.5},

  boxRow: {flexDirection: 'row', gap: 8},
  otpBox: {
    flex: 1,
    height: 52,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    borderRadius: 10,
    textAlign: 'center',
    fontSize: 18,
    fontWeight: '800',
    color: '#F2F4F8',
  },
  otpBoxFilled: {borderColor: '#5B8DEF', borderWidth: 2},
  otpBoxError: {borderColor: '#D50000', borderWidth: 2},
  errorText: {fontSize: 12, color: '#f87171', fontWeight: '600', marginTop: 4, minHeight: 16},

  resendRow: {alignItems: 'center', marginBottom: 16, marginTop: 4},
  resendLabel: {fontSize: 14, color: 'rgba(229,233,242,0.62)'},
  resendTimer: {color: '#5B8DEF', fontWeight: '700'},
  resendActive: {fontSize: 14, color: '#5B8DEF', fontWeight: '700'},

  btnWrap: {marginTop: 'auto'},
  verifyBtn: {backgroundColor: '#5B8DEF', borderRadius: 12, paddingVertical: 16, alignItems: 'center'},
  verifyBtnDisabled: {backgroundColor: 'rgba(255,255,255,0.09)', opacity: 0.6},
  verifyBtnText: {fontSize: 15, fontWeight: '700', color: '#FFF'},

  footHint: {textAlign: 'center', fontSize: 11, color: 'rgba(180,188,204,0.45)', marginTop: 12},
}));
