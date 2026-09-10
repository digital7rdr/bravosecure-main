import React, {useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  StatusBar,
  TextInput,
  Linking,
  ActivityIndicator,
} from 'react-native';
import {Alert} from '@utils/alert';
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
import {useAuthStore} from '@store/authStore';
import {apiErrCode} from '@/modules/messenger/vault/vaultPinSession';

// B-696 Phase C (VAULT_DURABILITY_DESIGN_2026-08-29 §5) — the REAL reset
// flow the audit-S2 stub was waiting for ("re-enabled when auth-service
// ships a real vault-reset endpoint" — it now has, under /auth/vault-pin).
//
// Every S2 leg is gone by construction:
//   - NO free-text identity: the reset is bound to the signed-in account
//     (JWT); the OTP goes to the ACCOUNT's phone, chosen server-side.
//   - The ACCOUNT PASSWORD gates the OTP send. Someone holding the unlocked
//     phone can read the SMS on it — the password is the factor they lack.
//   - The code is verified SERVER-side (next screen), and the new PIN rides
//     a single-use 5-minute server token. Nothing here trusts the client.
// Files are KEPT through a reset — the PIN is a gate, not a key.

type Nav = NativeStackNavigationProp<MessengerStackParamList, 'VaultForgot'>;

/** Client-side display mask; the server response replaces it post-submit. */
function maskPhoneForDisplay(e164: string | null | undefined): string | null {
  if (!e164 || e164.length <= 7) {return e164 ?? null;}
  return e164.slice(0, 5) + '•'.repeat(Math.max(0, e164.length - 8)) + e164.slice(-3);
}

export default function VaultForgotScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<RouteProp<MessengerStackParamList, 'VaultForgot'>>();
  const insets = useSafeAreaInsets();
  const accountPhone = useAuthStore(s => s.user?.phone_e164);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const maskedPhone = maskPhoneForDisplay(accountPhone);

  const sendOTP = async () => {
    if (!password.trim() || busy) {return;}
    setBusy(true);
    setError('');
    try {
      const {authApi} = require('@/services/api') as typeof import('@/services/api');
      const res = await authApi.requestVaultPinReset({password});
      navigation.navigate('VaultOTPVerify', {
        ...(route.params?.next ? {next: route.params.next} : {}),
        maskedPhone: res.maskedPhone,
      });
    } catch (e) {
      const codeVal = apiErrCode(e);
      if (codeVal === 'reset_unavailable') {
        Alert.alert(
          'Reset unavailable',
          'Your account has no phone number on file, so we cannot send a verification code. Contact support to recover your vault PIN.',
          [
            {text: 'Cancel', style: 'cancel'},
            {
              text: 'Contact support',
              onPress: () => { void Linking.openURL('mailto:support@bravosecure.app?subject=Vault%20PIN%20reset'); },
            },
          ],
        );
      } else if (codeVal === 'otp_send_rate_limited') {
        setError('Too many codes requested — try again in an hour.');
      } else if (codeVal === null) {
        setError('Can’t reach the server — check your connection.');
      } else {
        // Uniform for wrong password AND lockout (the server keeps them
        // byte-identical on purpose — do not un-blur that here).
        setError('Wrong account password. Try again.');
      }
    } finally {
      setBusy(false);
      setPassword('');
    }
  };

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => goBackOnce(navigation)} activeOpacity={0.7} hitSlop={{top: 4, bottom: 4, left: 4, right: 4}}>
          <Icon name="arrow-left" size={20} color="rgba(229,233,242,0.62)" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Reset PIN</Text>
        <View style={styles.backBtn} />
      </View>

      <KeyboardAvoidingScreen
        contentContainerStyle={[styles.scroll, {paddingBottom: insets.bottom + 24}]}>

        {/* Icon + title */}
        <View style={styles.iconSection}>
          <View style={styles.iconWrap}>
            <Icon name="lock-reset" size={28} color="#5B8DEF" />
          </View>
          <Text style={styles.title}>Forgot Your PIN?</Text>
          <Text style={styles.sub}>
            Confirm your account password and we’ll text a code to{'\n'}
            {maskedPhone ?? 'your registered phone number'}.
          </Text>
        </View>

        {/* Account password field — the factor a phone-holder doesn't have */}
        <View style={styles.fieldGroup}>
          <Text style={styles.fieldLabel}>Account Password</Text>
          <View style={styles.fieldRow}>
            <Icon name="shield-key-outline" size={18} color="rgba(180,188,204,0.45)" />
            <TextInput
              style={styles.fieldInput}
              placeholder="Your Bravo Secure password"
              placeholderTextColor="rgba(180,188,204,0.45)"
              secureTextEntry
              autoCapitalize="none"
              value={password}
              onChangeText={t => { setPassword(t); setError(''); }}
            />
          </View>
        </View>

        {!!error && <Text style={styles.errorText}>{error}</Text>}

        {/* Info note */}
        <View style={styles.infoNote}>
          <Icon name="information-outline" size={16} color="#5B8DEF" />
          <Text style={styles.infoText}>
            Resetting your PIN never touches the files in your vault. The code
            goes to the phone number on your account — it cannot be changed here.
          </Text>
        </View>

        {/* Send OTP */}
        <TouchableOpacity
          style={[styles.sendBtn, (!password.trim() || busy) && {opacity: 0.5}]}
          onPress={() => { void sendOTP(); }}
          disabled={busy}
          activeOpacity={0.85}>
          {busy
            ? <ActivityIndicator color="#FFF" />
            : <Text style={styles.sendBtnText}>Send Code</Text>}
        </TouchableOpacity>

        {/* Back link */}
        <TouchableOpacity style={styles.backLink} onPress={() => goBackOnce(navigation)} activeOpacity={0.7}>
          <Text style={styles.backLinkText}>Back to Vault Login</Text>
        </TouchableOpacity>

      </KeyboardAvoidingScreen>
    </View>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: Colors.background},

  header: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: 'rgba(91,141,239,0.1)'},
  backBtn: {width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center'},
  headerTitle: {fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 2, color: 'rgba(229,233,242,0.62)'},

  scroll: {paddingHorizontal: 20, paddingTop: 24},

  iconSection: {alignItems: 'center', marginBottom: 24},
  iconWrap: {width: 56, height: 56, borderRadius: 16, backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.2)', alignItems: 'center', justifyContent: 'center', marginBottom: 12},
  title: {fontSize: 18, fontWeight: '800', color: '#F2F4F8', marginBottom: 4},
  sub: {fontSize: 11, color: 'rgba(180,188,204,0.45)', textAlign: 'center', lineHeight: 18},

  fieldGroup: {marginBottom: 16},
  fieldLabel: {fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 2, color: '#5B8DEF', marginBottom: 6},
  fieldRow: {flexDirection: 'row', alignItems: 'center', height: 44, paddingHorizontal: 12, gap: 8, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)', borderRadius: 12},
  fieldInput: {flex: 1, fontSize: 13, fontWeight: '500', color: '#F2F4F8'},

  errorText: {fontSize: 11, fontWeight: '600', color: '#D50000', marginBottom: 12, textAlign: 'center'},

  infoNote: {flexDirection: 'row', alignItems: 'flex-start', gap: 8, backgroundColor: 'rgba(91,141,239,0.07)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.15)', borderRadius: 12, padding: 12, marginBottom: 24},
  infoText: {flex: 1, fontSize: 11, color: 'rgba(229,233,242,0.62)', lineHeight: 17},

  sendBtn: {backgroundColor: '#5B8DEF', borderRadius: 12, height: 44, alignItems: 'center', justifyContent: 'center', marginBottom: 16},
  sendBtnText: {fontSize: 13, fontWeight: '800', color: '#FFF', textTransform: 'uppercase', letterSpacing: 2},

  backLink: {alignItems: 'center', paddingVertical: 8},
  backLinkText: {fontSize: 12, color: 'rgba(180,188,204,0.45)', fontWeight: '500'},
}));
