import React, {useEffect, useRef, useState} from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Animated,
  ScrollView,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {LinearGradient} from 'expo-linear-gradient';
import Svg, {Path, Rect, Circle} from 'react-native-svg';
import BravoMark from '@components/BravoMark';
import * as LocalAuthentication from 'expo-local-authentication';
import {useAuthStore} from '@store/authStore';
import {pendingTier} from '@store/pendingTier';
import {tokenStore} from '@services/api';
import type {AuthScreenProps} from '@navigation/types';
import {useKeyboardOverlap} from '@hooks/useKeyboardLayout';
import {scaleTextStyles} from '@utils/scaling';

type Props = AuthScreenProps<'Login'>;

// ── Design tokens (Bravo handoff — obsidian / platinum-cobalt) ──────────
// Why: ported verbatim from the Claude Design bundle (src/tokens.jsx) so this
// screen matches the premium "Welcome back" sign-in mock, matching the sibling
// Onboarding / RoleSelection screens rather than the older Command-Navy palette.
const T = {
  bg:         '#07090D',
  text:       '#F2F4F8',
  textDim:    'rgba(229,233,242,0.62)',
  textMute:   'rgba(180,188,204,0.45)',
  textFaint:  'rgba(180,188,204,0.28)',
  hair:       'rgba(255,255,255,0.06)',
  hair2:      'rgba(255,255,255,0.09)',
  accent:     '#5B8DEF',
  accentDeep: '#2F5BE0',
  accentGlow: 'rgba(91,141,239,0.35)',
  signal:     '#4ADE80',
  danger:     '#FF8B8B',
} as const;

// ── Icons (exact paths from the design's vbg-signin.jsx) ────────────────
function IcMail({c}: {c: string}) {
  return (
    <Svg width={19} height={19} viewBox="0 0 24 24" fill="none">
      <Rect x={3.5} y={5.5} width={17} height={13} rx={2.6} stroke={c} strokeWidth={1.6} />
      <Path d="M4.5 7.5l7.5 5 7.5-5" stroke={c} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}
function IcLock({c}: {c: string}) {
  return (
    <Svg width={19} height={19} viewBox="0 0 24 24" fill="none">
      <Rect x={5} y={10.5} width={14} height={9.5} rx={2.4} stroke={c} strokeWidth={1.6} />
      <Path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" stroke={c} strokeWidth={1.6} strokeLinecap="round" />
      <Circle cx={12} cy={15} r={1.4} fill={c} />
    </Svg>
  );
}
function IcEye({c, off}: {c: string; off?: boolean}) {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
      <Path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" stroke={c} strokeWidth={1.5} strokeLinejoin="round" />
      <Circle cx={12} cy={12} r={2.6} stroke={c} strokeWidth={1.5} />
      {off && <Path d="M4 4l16 16" stroke={c} strokeWidth={1.5} strokeLinecap="round" />}
    </Svg>
  );
}
function IcArrow({c, s = 19}: {c: string; s?: number}) {
  return (
    <Svg width={s} height={s} viewBox="0 0 24 24" fill="none">
      <Path d="M4 12h15M13 6l6 6-6 6" stroke={c} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}
function IcFaceId({c}: {c: string}) {
  // Exact face/scan glyph from vbg-signin.jsx biometric button.
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 3c-1.6 0-3 .9-3.6 2.2M12 3c1.6 0 3 .9 3.6 2.2M5.5 9c0-1.2.5-2.4 1.3-3.2M5.5 9v3.5c0 4 2 7 6.5 9 4.5-2 6.5-5 6.5-9V9M8 13c.6 2 1.8 3.5 4 4.5M12 9.5v4"
        stroke={c}
        strokeWidth={1.5}
        strokeLinecap="round"
      />
    </Svg>
  );
}
function IcLockSmall({c}: {c: string}) {
  return (
    <Svg width={13} height={14} viewBox="0 0 14 14" fill="none">
      <Rect x={2.5} y={6} width={9} height={6} rx={1.3} stroke={c} strokeWidth={1.3} />
      <Path d="M4.5 6V4a2.5 2.5 0 0 1 5 0v2" stroke={c} strokeWidth={1.3} strokeLinecap="round" />
    </Svg>
  );
}
function IcAlert({c}: {c: string}) {
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24" fill="none">
      <Circle cx={12} cy={12} r={9} stroke={c} strokeWidth={1.6} />
      <Path d="M12 7.5v5.5M12 16.2v.3" stroke={c} strokeWidth={1.8} strokeLinecap="round" />
    </Svg>
  );
}

// ── Floating-label field (from vbg-signin.jsx Field) ────────────────────
function Field({
  Icon,
  label,
  value,
  onChangeText,
  focused,
  onFocus,
  onBlur,
  secureTextEntry,
  keyboardType,
  autoCapitalize,
  autoCorrect,
  autoComplete,
  textContentType,
  returnKeyType,
  onSubmitEditing,
  hasError,
  trailing,
  inputRef,
}: {
  Icon: (p: {c: string}) => React.ReactElement;
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  focused: boolean;
  onFocus: () => void;
  onBlur: () => void;
  secureTextEntry?: boolean;
  keyboardType?: 'email-address' | 'default';
  autoCapitalize?: 'none' | 'sentences';
  autoCorrect?: boolean;
  autoComplete?: 'email' | 'password';
  textContentType?: 'emailAddress' | 'password';
  returnKeyType?: 'next' | 'done';
  onSubmitEditing?: () => void;
  hasError?: boolean;
  trailing?: React.ReactNode;
  inputRef?: React.RefObject<TextInput | null>;
}) {
  const active = focused || !!value;
  // Animate the label between resting (inside field) and floated (small caps).
  const anim = useRef(new Animated.Value(active ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(anim, {
      toValue: active ? 1 : 0,
      duration: 170,
      useNativeDriver: false,
    }).start();
  }, [active, anim]);

  const iconColor = focused ? '#A9C5FF' : T.textMute;
  const borderColor = hasError
    ? 'rgba(255,93,93,0.5)'
    : focused
      ? 'rgba(91,141,239,0.5)'
      : T.hair2;

  return (
    <View
      style={[
        styles.field,
        {borderColor},
        focused && styles.fieldFocused,
      ]}>
      {/* top edge light */}
      <LinearGradient
        colors={['transparent', focused ? 'rgba(120,160,255,0.35)' : 'rgba(255,255,255,0.10)', 'transparent']}
        start={{x: 0, y: 0}}
        end={{x: 1, y: 0}}
        style={styles.fieldEdge}
      />
      {focused && (
        <LinearGradient
          colors={['rgba(91,141,239,0.10)', 'rgba(255,255,255,0.02)']}
          start={{x: 0.5, y: 0}}
          end={{x: 0.5, y: 1}}
          style={StyleSheet.absoluteFill}
        />
      )}

      <View style={styles.fieldIcon}>
        <Icon c={iconColor} />
      </View>

      <View style={styles.fieldInputWrap}>
        <Animated.Text
          pointerEvents="none"
          style={[
            styles.fieldLabel,
            {
              color: focused ? '#A9C5FF' : T.textMute,
              transform: [
                {translateY: anim.interpolate({inputRange: [0, 1], outputRange: [0, -13]})},
              ],
              fontSize: anim.interpolate({inputRange: [0, 1], outputRange: [15, 9]}),
              letterSpacing: anim.interpolate({inputRange: [0, 1], outputRange: [0, 1.4]}),
            },
          ]}>
          {label}
        </Animated.Text>
        <TextInput
          ref={inputRef}
          style={[styles.fieldInput, active && styles.fieldInputActive]}
          value={value}
          onChangeText={onChangeText}
          onFocus={onFocus}
          onBlur={onBlur}
          secureTextEntry={secureTextEntry}
          keyboardType={keyboardType}
          autoCapitalize={autoCapitalize}
          autoCorrect={autoCorrect}
          autoComplete={autoComplete}
          textContentType={textContentType}
          returnKeyType={returnKeyType}
          onSubmitEditing={onSubmitEditing}
          selectionColor={T.accent}
        />
      </View>

      {trailing}
    </View>
  );
}

export default function LoginScreen({navigation}: Props) {
  const insets = useSafeAreaInsets();
  // B-84 / KB-17 — KAV had no Android behavior and there was no scroll
  // fallback: on small devices / large fontScale the password field sat
  // under the IME. kb padding + ScrollView keep it visible everywhere.
  const keyboardOverlap = useKeyboardOverlap();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [focus, setFocus] = useState<'email' | 'pw' | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [bioAvailable, setBioAvailable] = useState(false);
  const {login, verifyOtp, completeAuth, biometricSignIn, isLoading} = useAuthStore();
  const pwRef = useRef<TextInput>(null);

  // Show the biometric shortcut only when BOTH:
  //   1. A refresh token is on disk (user has signed in before on this
  //      device and hasn't explicitly signed out)
  //   2. The device has biometric hardware AND is enrolled
  // Otherwise the shortcut would be a dead button.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [refresh, hasHw, hasCreds] = await Promise.all([
          tokenStore.getRefresh(),
          LocalAuthentication.hasHardwareAsync(),
          LocalAuthentication.isEnrolledAsync(),
        ]);
        if (!cancelled) {setBioAvailable(!!refresh && hasHw && hasCreds);}
      } catch {
        if (!cancelled) {setBioAvailable(false);}
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleBiometric = async () => {
    setErrorMsg(null);
    const ok = await biometricSignIn();
    if (!ok) {
      // Could be cancelled, no saved session, or refresh token expired.
      // Password form stays visible for manual sign-in.
      setErrorMsg('Biometric sign-in unavailable. Use your password instead.');
    }
    // On success, RootNavigator swaps to Main on the next render.
  };

  const handleEmailChange = (t: string) => {
    setEmail(t);
    if (errorMsg) {setErrorMsg(null);}
  };
  const handlePasswordChange = (t: string) => {
    setPassword(t);
    if (errorMsg) {setErrorMsg(null);}
  };

  const handleSubmit = async () => {
    const trimmedEmail = email.trim().toLowerCase();
    const trimmedPassword = password.trim();
    if (!trimmedEmail || !trimmedPassword) {
      setErrorMsg('Enter your email and password.');
      return;
    }
    setErrorMsg(null);
    try {
      // M1A — logging into an EXISTING account is not the signup funnel: a
      // stale tier pick from an abandoned signup must not paywall this user.
      void pendingTier.clear();
      const res = await login({email: trimmedEmail, password: trimmedPassword});
      if (!res.userId) {
        setErrorMsg('Invalid email or password.');
        return;
      }
      // Staging (OTP_DEV_BYPASS) returns devOtpCode — auto-verify so dev/QA
      // logins land on the Dashboard directly, exactly as before.
      if (res.devOtpCode) {
        await verifyOtp(res.userId, res.devOtpCode);
        await completeAuth();
        // RootNavigator flips to Main → Dashboard once isAuthenticated + role are set.
        return;
      }
      // IDN-12/28 — live Twilio OTP: no code comes back, the user must
      // type the one sent to their phone.
      navigation.navigate('OtpVerify', {userId: res.userId, phoneHint: res.phone ?? undefined});
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Sign in failed. Please try again.';
      setErrorMsg(msg);
    }
  };

  const canSubmit = !!email.trim() && !!password.trim() && !isLoading;

  return (
    <View style={styles.root}>
      {/* Ambient obsidian + cobalt hero glow */}
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <LinearGradient
          colors={['rgba(91,141,239,0.16)', 'rgba(91,141,239,0)']}
          start={{x: 0.5, y: 0}}
          end={{x: 0.5, y: 1}}
          style={styles.heroGlow}
        />
      </View>

      {/* B-184 — one rule: the scroll frame shrinks by the true IME overlap
          so the password field can always be scrolled clear of the keyboard. */}
      <View style={[styles.flex, {paddingBottom: keyboardOverlap}]}>
        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.scrollBody}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          bounces={false}>
        <View style={[styles.body, {paddingTop: insets.top + 56, paddingBottom: insets.bottom + 24}]}>

          {/* ── Brand + header ── */}
          <View style={styles.header}>
            <View style={styles.brandTile}>
              <LinearGradient
                colors={['rgba(91,141,239,0.26)', 'rgba(20,28,46,0.6)']}
                start={{x: 0.1, y: 0}}
                end={{x: 0.9, y: 1}}
                style={StyleSheet.absoluteFill}
              />
              <BravoMark size={38} primary="#FFFFFF" accent="#5B8DEF" />
            </View>
            <Text style={styles.eyebrow}>Sign In</Text>
            <Text style={styles.title}>Welcome back</Text>
            <Text style={styles.subtitle}>Sign in to your Bravo Secure account</Text>
          </View>

          {/* ── Form ── */}
          <View style={styles.form}>
            <Field
              Icon={IcMail}
              label="Email address"
              value={email}
              onChangeText={handleEmailChange}
              focused={focus === 'email'}
              onFocus={() => setFocus('email')}
              onBlur={() => setFocus(null)}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              textContentType="emailAddress"
              returnKeyType="next"
              onSubmitEditing={() => pwRef.current?.focus()}
              hasError={!!errorMsg}
            />
            <Field
              Icon={IcLock}
              label="Password"
              value={password}
              onChangeText={handlePasswordChange}
              focused={focus === 'pw'}
              onFocus={() => setFocus('pw')}
              onBlur={() => setFocus(null)}
              secureTextEntry={!showPw}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="password"
              textContentType="password"
              returnKeyType="done"
              onSubmitEditing={() => { void handleSubmit(); }}
              hasError={!!errorMsg}
              inputRef={pwRef}
              trailing={
                <TouchableOpacity
                  onPress={() => setShowPw(v => !v)}
                  hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}
                  style={styles.eyeBtn}
                  accessibilityRole="button"
                  accessibilityLabel={showPw ? 'Hide password' : 'Show password'}>
                  <IcEye c={showPw ? '#A9C5FF' : T.textMute} off={showPw} />
                </TouchableOpacity>
              }
            />

            {/* Forgot password */}
            <View style={styles.forgotRow}>
              <Text style={styles.forgot}>Forgot password?</Text>
            </View>

            {errorMsg ? (
              <View style={styles.errorBox}>
                <IcAlert c={T.danger} />
                <Text style={styles.errorText}>{errorMsg}</Text>
              </View>
            ) : null}

            {/* Primary CTA */}
            <TouchableOpacity
              activeOpacity={0.9}
              onPress={() => { void handleSubmit(); }}
              disabled={!canSubmit}
              style={!canSubmit && styles.ctaDisabled}>
              <LinearGradient
                colors={['#6E9BF5', T.accent, T.accentDeep]}
                start={{x: 0.5, y: 0}}
                end={{x: 0.5, y: 1}}
                style={styles.cta}>
                <Text style={styles.ctaText}>{isLoading ? 'Signing in…' : 'Sign in'}</Text>
                {!isLoading && <IcArrow c="#fff" s={19} />}
              </LinearGradient>
            </TouchableOpacity>

            {/* Biometric — wired to the real biometricSignIn(); only shown when a
                prior session + enrolled biometric exist, so it's never a dead button. */}
            {bioAvailable && (
              <>
                <View style={styles.orRow}>
                  <View style={styles.orLine} />
                  <Text style={styles.orText}>or</Text>
                  <View style={styles.orLine} />
                </View>
                <TouchableOpacity
                  activeOpacity={0.85}
                  onPress={() => { void handleBiometric(); }}
                  disabled={isLoading}
                  style={styles.bioBtn}
                  accessibilityRole="button"
                  accessibilityLabel="Sign in with biometric">
                  <IcFaceId c={T.textDim} />
                  <Text style={styles.bioBtnText}>Use Face ID</Text>
                </TouchableOpacity>
              </>
            )}
          </View>

          <View style={styles.spacer} />

          {/* ── Footer ── */}
          <View style={styles.footer}>
            <View style={styles.footerRegisterRow}>
              <Text style={styles.footerRegisterText}>Don't have an account?</Text>
              <TouchableOpacity onPress={() => navigation.navigate('Register')} activeOpacity={0.7}>
                <Text style={styles.footerRegisterLink}>Create account</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.footerDivider} />
            <View style={styles.sealRow}>
              <IcLockSmall c={T.signal} />
              <Text style={styles.sealText}>
                All communications protected by{' '}
                <Text style={styles.sealAccent}>Signal Protocol</Text>
              </Text>
            </View>
          </View>

        </View>
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: T.bg},
  flex: {flex: 1},
  heroGlow: {position: 'absolute', top: -100, left: '8%', right: '8%', height: 340, borderRadius: 500},

  body: {flexGrow: 1, paddingHorizontal: 26},
  scrollBody: {flexGrow: 1},

  // Header
  header: {alignItems: 'center'},
  brandTile: {
    width: 64, height: 64, borderRadius: 19,
    borderWidth: 1, borderColor: 'rgba(91,141,239,0.45)',
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  eyebrow: {fontFamily: 'monospace', color: T.accent, fontSize: 12, fontWeight: '700', letterSpacing: 3, textTransform: 'uppercase', marginTop: 26, marginBottom: 10},
  title: {color: T.text, fontSize: 34, fontWeight: '700', letterSpacing: -1, lineHeight: 36},
  subtitle: {color: T.textDim, fontSize: 14.5, letterSpacing: -0.1, marginTop: 11},

  // Form
  form: {marginTop: 38, gap: 13},
  field: {
    height: 60, borderRadius: 16, overflow: 'hidden',
    flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16,
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1,
  },
  fieldFocused: {
    shadowColor: '#143A5A', shadowOffset: {width: 0, height: 8},
    shadowOpacity: 0.25, shadowRadius: 12, elevation: 4,
  },
  fieldEdge: {position: 'absolute', top: 0, left: 16, right: 16, height: 1},
  fieldIcon: {flexShrink: 0},
  // Why: alignSelf:'stretch', never height:'100%' — survives a future fixed→minHeight
  // conversion on `field` (the B-682 orphaned-percentage class).
  fieldInputWrap: {flex: 1, minWidth: 0, alignSelf: 'stretch', justifyContent: 'center'},
  fieldLabel: {
    position: 'absolute', left: 0,
    fontFamily: 'monospace', fontWeight: '600', textTransform: 'uppercase',
    includeFontPadding: false,
  },
  fieldInput: {
    width: '100%', padding: 0, fontSize: 15, color: T.text, letterSpacing: 0.2,
    includeFontPadding: false,
  },
  fieldInputActive: {paddingTop: 14},
  eyeBtn: {flexShrink: 0, padding: 4},

  forgotRow: {flexDirection: 'row', justifyContent: 'flex-end', marginTop: -2},
  forgot: {color: T.textMute, fontSize: 12.5, fontWeight: '500', letterSpacing: -0.05},

  errorBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: 'rgba(255,93,93,0.10)', borderRadius: 12,
    paddingVertical: 10, paddingHorizontal: 12,
    borderWidth: 1, borderColor: 'rgba(255,93,93,0.25)',
  },
  errorText: {flex: 1, fontSize: 13, color: T.danger, fontWeight: '500'},

  // CTA
  cta: {
    height: 58, borderRadius: 17, marginTop: 8,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
  },
  ctaDisabled: {opacity: 0.55},
  ctaText: {color: '#fff', fontSize: 16.5, fontWeight: '700', letterSpacing: 0.2},

  // Biometric
  orRow: {flexDirection: 'row', alignItems: 'center', gap: 12, marginVertical: 4},
  orLine: {flex: 1, height: 1, backgroundColor: T.hair},
  orText: {fontFamily: 'monospace', color: T.textFaint, fontSize: 9, letterSpacing: 1.4, textTransform: 'uppercase'},
  bioBtn: {
    height: 52, borderRadius: 15,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: T.hair2,
  },
  bioBtnText: {color: T.textDim, fontSize: 14, fontWeight: '600', letterSpacing: -0.05},

  spacer: {flex: 1, minHeight: 24},

  // Footer
  footer: {alignItems: 'center', gap: 18},
  footerRegisterRow: {flexDirection: 'row', alignItems: 'center', gap: 7},
  footerRegisterText: {color: T.textMute, fontSize: 13.5, letterSpacing: -0.05},
  footerRegisterLink: {color: T.accent, fontSize: 13.5, fontWeight: '700'},
  footerDivider: {width: '100%', height: 1, backgroundColor: T.hair},
  sealRow: {flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16},
  sealText: {fontFamily: 'monospace', color: T.textMute, fontSize: 9.5, letterSpacing: 0.5, textAlign: 'center'},
  sealAccent: {color: T.signal},
}));
