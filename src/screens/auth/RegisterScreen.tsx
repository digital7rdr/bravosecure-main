import React, {useEffect, useRef, useState} from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Modal,
  Pressable,
  Animated,
} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {LinearGradient} from 'expo-linear-gradient';
import Svg, {
  Defs,
  LinearGradient as SvgGradient,
  Stop,
  Path,
  Rect,
  Circle,
  Text as SvgText,
} from 'react-native-svg';
import {useAuthStore} from '@store/authStore';
import {DIAL_CODES, type DialCode} from '@utils/constants';
import {CountryPicker} from '@components/CountryPicker';
import KeyboardAvoidingScreen from '@components/KeyboardAvoidingScreen';
import type {AuthScreenProps} from '@navigation/types';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';

type Props = AuthScreenProps<'Register'>;

// ── Design tokens (Bravo handoff — obsidian / platinum-cobalt) ──────────
// Why: ported verbatim from the Claude Design bundle (src/tokens.jsx) so this
// screen matches the premium "Create Account" mock exactly, matching the
// sibling Onboarding / RoleSelection / Login screens rather than the older
// Command-Navy palette.
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
  amber:      '#F5B544',
  danger:     '#FF8B8B',
} as const;

// ── Gradient heading ("secure account") ────────────────────────────────
// Why: the design renders the second title line with a cobalt→violet gradient
// fill. We use an SVG <Text> gradient (react-native-svg is already a
// dependency) instead of MaskedView, avoiding a new native module + rebuild —
// same approach proven in OnboardingScreen's GradientWord.
function GradientWord({text, fontSize = 38}: {text: string; fontSize?: number}) {
  const w = text.length * fontSize * 0.56;
  const h = fontSize;
  return (
    <Svg width={w} height={h}>
      <Defs>
        <SvgGradient id="caWord" x1="0" y1="0" x2={w} y2="0" gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor="#7FA8FF" />
          <Stop offset="0.55" stopColor="#5B8DEF" />
          <Stop offset="1" stopColor="#A78BFA" />
        </SvgGradient>
      </Defs>
      <SvgText
        x={0}
        y={fontSize * 0.78}
        fill="url(#caWord)"
        fontSize={fontSize}
        fontWeight="700"
        letterSpacing={-0.9}>
        {text}
      </SvgText>
    </Svg>
  );
}

// ── Icons (exact paths from the design's vbg-create-account.jsx) ────────
function IcBack({c}: {c: string}) {
  return (
    <Svg width={9} height={15} viewBox="0 0 9 15" fill="none">
      <Path d="M8 1L1.5 7.5 8 14" stroke={c} strokeWidth={1.8} fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}
function IcUser({c}: {c: string}) {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
      <Circle cx={12} cy={8} r={3.6} stroke={c} strokeWidth={1.6} />
      <Path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6" stroke={c} strokeWidth={1.6} strokeLinecap="round" />
    </Svg>
  );
}
function IcPhone({c}: {c: string}) {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
      <Path
        d="M6.5 4h3l1.5 4-2 1.4a11 11 0 0 0 5.6 5.6L16 17l4 1.5v3a1.5 1.5 0 0 1-1.6 1.5C10.6 22.5 4.5 16.4 4 8.6A1.5 1.5 0 0 1 5.5 7"
        stroke={c}
        strokeWidth={1.6}
        strokeLinejoin="round"
      />
    </Svg>
  );
}
function IcMail({c}: {c: string}) {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
      <Rect x={3.5} y={5.5} width={17} height={13} rx={2.6} stroke={c} strokeWidth={1.6} />
      <Path d="M4.5 7.5l7.5 5 7.5-5" stroke={c} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}
function IcLock({c}: {c: string}) {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
      <Rect x={5} y={10.5} width={14} height={9.5} rx={2.4} stroke={c} strokeWidth={1.6} />
      <Path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" stroke={c} strokeWidth={1.6} strokeLinecap="round" />
      <Circle cx={12} cy={15} r={1.4} fill={c} />
    </Svg>
  );
}
function IcLockCheck({c}: {c: string}) {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
      <Rect x={5} y={10.5} width={14} height={9.5} rx={2.4} stroke={c} strokeWidth={1.6} />
      <Path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" stroke={c} strokeWidth={1.6} strokeLinecap="round" />
      <Path d="M9.5 15l1.7 1.7 3.3-3.6" stroke={c} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}
function IcCheckCircle({c}: {c: string}) {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
      <Circle cx={12} cy={12} r={9} stroke={c} strokeWidth={1.6} />
      <Path d="M8 12.2l2.6 2.6L16 9" stroke={c} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}
function IcEye3({c, off}: {c: string; off?: boolean}) {
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
function IcChevDown({c}: {c: string}) {
  return (
    <Svg width={12} height={12} viewBox="0 0 16 16" fill="none">
      <Path d="M3.5 6L8 10.5 12.5 6" stroke={c} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" />
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
function IcShieldAccount({c}: {c: string}) {
  return (
    <Svg width={30} height={30} viewBox="0 0 24 24" fill="none">
      <Path d="M12 3l7 2.5V11c0 4.2-2.9 7.6-7 8.8C7.9 18.6 5 15.2 5 11V5.5L12 3Z" stroke={c} strokeWidth={1.6} strokeLinejoin="round" />
      <Circle cx={12} cy={10} r={2} stroke={c} strokeWidth={1.5} />
      <Path d="M8.5 15.5c.6-1.6 1.9-2.4 3.5-2.4s2.9.8 3.5 2.4" stroke={c} strokeWidth={1.5} strokeLinecap="round" />
    </Svg>
  );
}

// ── Field label (mono caps, above the input) ────────────────────────────
function FieldLabel({label, hint}: {label: string; hint?: string}) {
  return (
    <Text style={styles.fieldLabel}>
      {label}
      {hint ? <Text style={styles.fieldHint}>{`  ·  ${hint}`}</Text> : null}
    </Text>
  );
}

// ── Floating-label input (CAField) ──────────────────────────────────────
function CAField({
  Icon,
  ValidIcon,
  placeholder,
  value,
  onChangeText,
  focused,
  onFocus,
  onBlur,
  valid,
  secureTextEntry,
  keyboardType,
  autoCapitalize,
  autoCorrect,
  returnKeyType,
  onSubmitEditing,
  maxLength,
  trailing,
  inputRef,
  flatLeft,
}: {
  Icon: (p: {c: string}) => React.ReactElement;
  ValidIcon?: (p: {c: string}) => React.ReactElement;
  placeholder: string;
  value: string;
  onChangeText: (t: string) => void;
  focused: boolean;
  onFocus: () => void;
  onBlur: () => void;
  valid?: boolean;
  secureTextEntry?: boolean;
  keyboardType?: 'email-address' | 'phone-pad' | 'default';
  autoCapitalize?: 'none' | 'words' | 'sentences';
  autoCorrect?: boolean;
  returnKeyType?: 'next' | 'done';
  onSubmitEditing?: () => void;
  maxLength?: number;
  trailing?: React.ReactNode;
  inputRef?: React.RefObject<TextInput | null>;
  flatLeft?: boolean;
}) {
  const active = focused || !!value;
  const anim = useRef(new Animated.Value(active ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(anim, {
      toValue: active ? 1 : 0,
      duration: 170,
      useNativeDriver: false,
    }).start();
  }, [active, anim]);

  const showValid = !!valid && !!ValidIcon;
  const iconColor = showValid ? T.signal : focused ? '#A9C5FF' : T.textMute;
  const borderColor = valid
    ? 'rgba(74,222,128,0.34)'
    : focused
      ? 'rgba(91,141,239,0.5)'
      : T.hair2;

  return (
    <View
      style={[
        styles.field,
        flatLeft && styles.fieldFlatLeft,
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
        {showValid && ValidIcon ? <ValidIcon c={T.signal} /> : <Icon c={iconColor} />}
      </View>

      <View style={styles.fieldInputWrap}>
        <Animated.Text
          pointerEvents="none"
          style={[
            styles.fieldFloatLabel,
            {
              color: focused ? '#A9C5FF' : T.textMute,
              transform: [
                {translateY: anim.interpolate({inputRange: [0, 1], outputRange: [0, -13]})},
              ],
              fontSize: anim.interpolate({inputRange: [0, 1], outputRange: [15, 9]}),
              letterSpacing: anim.interpolate({inputRange: [0, 1], outputRange: [0, 1.4]}),
            },
          ]}>
          {placeholder}
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
          returnKeyType={returnKeyType}
          onSubmitEditing={onSubmitEditing}
          maxLength={maxLength}
          selectionColor={T.accent}
        />
      </View>

      {trailing}
    </View>
  );
}

// ── Password strength (4-factor score) ──────────────────────────────────
function passwordScore(pw: string): {score: number; label: string; color: string} {
  let n = 0;
  if (pw.length >= 8) {n += 1;}
  if (/[A-Z]/.test(pw)) {n += 1;}
  if (/[0-9]/.test(pw)) {n += 1;}
  if (/[^A-Za-z0-9]/.test(pw)) {n += 1;}
  const meta = [
    {label: '', color: T.amber},
    {label: 'Weak', color: T.amber},
    {label: 'Fair', color: T.amber},
    {label: 'Strong', color: T.accent},
    {label: 'Excellent', color: T.signal},
  ];
  return {score: n, ...meta[n]};
}

function StrengthBar({pw}: {pw: string}) {
  const {score, label, color} = passwordScore(pw);
  return (
    <View style={styles.strengthRow}>
      <View style={styles.strengthBars}>
        {[1, 2, 3, 4].map(i => (
          <View
            key={i}
            style={[
              styles.strengthSeg,
              {backgroundColor: i <= score ? color : T.hair2},
            ]}
          />
        ))}
      </View>
      <Text style={[styles.strengthText, {color}]}>{label}</Text>
    </View>
  );
}

export default function RegisterScreen({navigation, route}: Props) {
  const insets = useSafeAreaInsets();
  const role = route.params?.role ?? 'individual';
  const tier = route.params?.tier ?? 'lite';

  const [fullName, setFullName]               = useState('');
  const [email, setEmail]                     = useState('');
  const [password, setPassword]               = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [phone, setPhone]                     = useState('');
  const [dialCode, setDialCode]               = useState<DialCode>(DIAL_CODES[0]);
  const [pickerOpen, setPickerOpen]           = useState(false);
  const [showPassword, setShowPassword]       = useState(false);
  const [showConfirm, setShowConfirm]         = useState(false);
  const [existsModal, setExistsModal]         = useState(false);
  const [focus, setFocus]                     = useState<'name' | 'phone' | 'email' | 'pw' | 'confirm' | null>(null);
  const {register, isLoading} = useAuthStore();

  // `phone` stores only digits (stripped + capped on every keystroke below).
  const phoneValid     = phone.length === dialCode.digits;
  const emailValid     = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const confirmMatches = confirmPassword.length > 0 && password === confirmPassword;
  const canSubmit      =
    fullName.trim().length > 0 &&
    phoneValid &&
    emailValid &&
    password.length >= 6 &&
    confirmPassword === password;

  // Header role/tier badges reflect the real route params.
  const roleBadge =
    role === 'individual'
      ? {text: 'INDIVIDUAL', cobalt: true}
      : {text: 'CORPORATE', cobalt: true};
  const tierBadge = tier.toUpperCase();

  const handleSubmit = async () => {
    if (!fullName.trim()) {
      Alert.alert('Missing info', 'Please enter your full name.');
      return;
    }
    if (!phoneValid) {
      Alert.alert(
        'Invalid phone',
        `Enter a ${dialCode.digits}-digit number for ${dialCode.label} (${dialCode.dial}). You entered ${phone.length} digit(s).`,
      );
      return;
    }
    if (!email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      Alert.alert('Invalid email', 'Enter a valid email address.');
      return;
    }
    if (password.length < 6) {
      Alert.alert('Weak password', 'Password must be at least 6 characters.');
      return;
    }
    if (password !== confirmPassword) {
      Alert.alert('Passwords do not match', 'Please re-enter the same password in both fields.');
      return;
    }
    const fullPhone = dialCode.dial + phone;
    try {
      await register({
        email: email.trim(),
        password,
        fullName: fullName.trim(),
        phoneE164: fullPhone,
        role,
        tier,
      });
      navigation.navigate('OTPVerification', {
        phone: fullPhone,
        mode: 'register',
        email: email.trim(),
        password,
        fullName: fullName.trim(),
        role,
        tier,
      });
    } catch (e: unknown) {
      const err = e as {response?: {status?: number; data?: {message?: unknown}}; message?: string};
      const status = err?.response?.status;
      // Nest class-validator sometimes returns an array — coerce to string
      // so Alert.alert (which requires a string body) never explodes.
      const rawMsg = err?.response?.data?.message;
      const apiMsg: string | undefined = Array.isArray(rawMsg)
        ? rawMsg.join(' · ')
        : typeof rawMsg === 'string'
          ? rawMsg
          : undefined;

      if (status === 409 || apiMsg === 'already_exists') {
        setExistsModal(true);
        return;
      }
      if (status === 429 || apiMsg === 'otp_rate_limited') {
        Alert.alert(
          'Too many OTP requests',
          'You\'ve requested OTPs to this number too many times. Please wait about 10 minutes, then try again — or use a different phone number.',
        );
        return;
      }
      if (apiMsg === 'otp_number_blocked') {
        Alert.alert(
          'Number temporarily blocked',
          'The SMS provider has temporarily blocked this phone number or region. Please try a different number.',
        );
        return;
      }
      if (apiMsg === 'otp_unverified_number') {
        Alert.alert(
          'Number not authorized',
          'This number isn\'t authorized for OTPs yet. Please use a number that\'s already been verified in the SMS provider.',
        );
        return;
      }
      if (!status) {
        Alert.alert('No connection', 'Could not reach the server. Check your internet and try again.');
        return;
      }
      const body = apiMsg ?? err.message ?? 'Something went wrong. Please try again.';
      Alert.alert('Registration failed', String(body));
    }
  };

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

      <KeyboardAvoidingScreen
        style={styles.scroll}
        contentContainerStyle={[
          styles.content,
          {paddingTop: insets.top + 12, paddingBottom: insets.bottom + 32},
        ]}>

        {/* ── Top bar: back + step indicator ── */}
        <View style={styles.topRow}>
          <TouchableOpacity
            style={styles.backBtn}
            onPress={() => goBackOnce(navigation)}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Go back">
            <IcBack c={T.text} />
          </TouchableOpacity>

          <View style={styles.stepWrap}>
            <View style={styles.stepDots}>
              {[0, 1, 2, 3].map(i => {
                const current = i === 2;
                const filled = i < 2;
                if (current) {
                  return (
                    <LinearGradient
                      key={i}
                      colors={['#6E9BF5', T.accent, T.accentDeep]}
                      start={{x: 0, y: 0}}
                      end={{x: 1, y: 0}}
                      style={styles.stepPill}
                    />
                  );
                }
                if (filled) {
                  return (
                    <LinearGradient
                      key={i}
                      colors={['#6E9BF5', T.accentDeep]}
                      start={{x: 0, y: 0}}
                      end={{x: 1, y: 0}}
                      style={styles.stepDot}
                    />
                  );
                }
                return <View key={i} style={[styles.stepDot, styles.stepDotIdle]} />;
              })}
            </View>
            <Text style={styles.stepCount}>
              <Text style={styles.stepCountCur}>02</Text>
              <Text style={styles.stepCountTotal}>/04</Text>
            </Text>
          </View>
        </View>

        {/* ── Header ── */}
        <View style={styles.header}>
          <View style={styles.badgeRow}>
            <View style={styles.badgeCobalt}>
              <Text style={styles.badgeCobaltText}>{roleBadge.text}</Text>
            </View>
            <View style={styles.badgeMuted}>
              <Text style={styles.badgeMutedText}>{tierBadge}</Text>
            </View>
          </View>

          <View style={styles.titleBlock}>
            <Text style={styles.titleWhite}>Create your</Text>
            <GradientWord text="secure account" fontSize={30} />
          </View>

          <View style={styles.encNote}>
            <IcLockSmall c={T.signal} />
            <Text style={styles.encNoteText}>All fields are end-to-end encrypted at rest.</Text>
          </View>
        </View>

        {/* ── Form ── */}
        <View style={styles.form}>
          {/* Full Name */}
          <View style={styles.fieldGroup}>
            <FieldLabel label="FULL NAME" />
            <CAField
              Icon={IcUser}
              placeholder="John Doe"
              value={fullName}
              onChangeText={setFullName}
              focused={focus === 'name'}
              onFocus={() => setFocus('name')}
              onBlur={() => setFocus(null)}
              autoCapitalize="words"
              returnKeyType="next"
            />
          </View>

          {/* Mobile Number */}
          <View style={styles.fieldGroup}>
            <FieldLabel label="MOBILE NUMBER" hint={`${dialCode.digits} digits`} />
            <View style={styles.phoneRow}>
              <TouchableOpacity
                style={styles.dialBox}
                onPress={() => setPickerOpen(true)}
                activeOpacity={0.75}
                accessibilityRole="button"
                accessibilityLabel="Select country dial code">
                <Text style={styles.flagText}>{dialCode.flag}</Text>
                <Text style={styles.dialText}>{dialCode.dial}</Text>
                <IcChevDown c={T.textMute} />
              </TouchableOpacity>
              <View style={styles.phoneField}>
                <CAField
                  Icon={IcPhone}
                  placeholder="Phone number"
                  value={phone}
                  onChangeText={t => {
                    // Strip non-digits + any leading zeros, then cap at country length.
                    const clean = t.replace(/\D/g, '').replace(/^0+/, '').slice(0, dialCode.digits);
                    setPhone(clean);
                  }}
                  focused={focus === 'phone'}
                  onFocus={() => setFocus('phone')}
                  onBlur={() => setFocus(null)}
                  valid={phoneValid}
                  ValidIcon={IcCheckCircle}
                  keyboardType="phone-pad"
                  returnKeyType="next"
                  maxLength={dialCode.digits}
                  flatLeft
                />
              </View>
            </View>
          </View>

          {/* Email */}
          <View style={styles.fieldGroup}>
            <FieldLabel label="EMAIL ADDRESS" />
            <CAField
              Icon={IcMail}
              ValidIcon={IcCheckCircle}
              placeholder="you@example.com"
              value={email}
              onChangeText={setEmail}
              focused={focus === 'email'}
              onFocus={() => setFocus('email')}
              onBlur={() => setFocus(null)}
              valid={emailValid}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="next"
            />
          </View>

          {/* Password */}
          <View style={styles.fieldGroup}>
            <FieldLabel label="SECURE PASSWORD" />
            <CAField
              Icon={IcLock}
              placeholder="Create a password"
              value={password}
              onChangeText={setPassword}
              focused={focus === 'pw'}
              onFocus={() => setFocus('pw')}
              onBlur={() => setFocus(null)}
              secureTextEntry={!showPassword}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="next"
              trailing={
                <TouchableOpacity
                  onPress={() => setShowPassword(v => !v)}
                  hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}
                  style={styles.eyeBtn}
                  accessibilityRole="button"
                  accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}>
                  <IcEye3 c={showPassword ? '#A9C5FF' : T.textMute} off={showPassword} />
                </TouchableOpacity>
              }
            />
            {password.length > 0 && <StrengthBar pw={password} />}
          </View>

          {/* Confirm Password */}
          <View style={styles.fieldGroup}>
            <FieldLabel label="CONFIRM PASSWORD" />
            <CAField
              Icon={IcLockCheck}
              ValidIcon={IcCheckCircle}
              placeholder="Re-enter password"
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              focused={focus === 'confirm'}
              onFocus={() => setFocus('confirm')}
              onBlur={() => setFocus(null)}
              valid={confirmMatches}
              secureTextEntry={!showConfirm}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={() => { void handleSubmit(); }}
              trailing={
                <TouchableOpacity
                  onPress={() => setShowConfirm(v => !v)}
                  hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}
                  style={styles.eyeBtn}
                  accessibilityRole="button"
                  accessibilityLabel={showConfirm ? 'Hide password' : 'Show password'}>
                  <IcEye3 c={showConfirm ? '#A9C5FF' : T.textMute} off={showConfirm} />
                </TouchableOpacity>
              }
            />
            {confirmPassword.length > 0 && password !== confirmPassword && (
              <Text style={styles.mismatchText}>Passwords do not match</Text>
            )}
          </View>

          {/* CTA */}
          <TouchableOpacity
            activeOpacity={0.9}
            onPress={() => { void handleSubmit(); }}
            disabled={isLoading || !canSubmit}
            style={[styles.ctaWrap, (isLoading || !canSubmit) && styles.ctaDisabled]}>
            <LinearGradient
              colors={['#6E9BF5', T.accent, T.accentDeep]}
              start={{x: 0.5, y: 0}}
              end={{x: 0.5, y: 1}}
              style={styles.cta}>
              {isLoading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <>
                  <IcMail c="#fff" />
                  <Text style={styles.ctaText}>Send OTP</Text>
                  <IcArrow c="#fff" s={19} />
                </>
              )}
            </LinearGradient>
          </TouchableOpacity>

          {/* Sign In */}
          <View style={styles.signinRow}>
            <Text style={styles.signinText}>Already have an account?</Text>
            <TouchableOpacity onPress={() => navigation.navigate('Login')} activeOpacity={0.7}>
              <Text style={styles.signinLink}>Sign In</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingScreen>

      <CountryPicker
        visible={pickerOpen}
        onSelect={c => {
          setDialCode(c);
          setPickerOpen(false);
        }}
        onClose={() => setPickerOpen(false)}
      />

      {/* ── "Account already exists" modal ── */}
      <Modal
        visible={existsModal}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => setExistsModal(false)}>
        <Pressable style={styles.mBackdrop} onPress={() => setExistsModal(false)}>
          <Pressable style={styles.mCard} onPress={() => {}}>
            <LinearGradient
              colors={['transparent', 'rgba(120,160,255,0.30)', 'transparent']}
              start={{x: 0, y: 0}}
              end={{x: 1, y: 0}}
              style={styles.mEdge}
            />
            <View style={styles.mIconWrap}>
              <LinearGradient
                colors={['rgba(91,141,239,0.28)', 'rgba(47,91,224,0.08)']}
                start={{x: 0.2, y: 0}}
                end={{x: 0.9, y: 1}}
                style={StyleSheet.absoluteFill}
              />
              <IcShieldAccount c="#A9C5FF" />
            </View>
            <Text style={styles.mTitle}>Account already exists</Text>
            <Text style={styles.mBody}>
              An account with this phone number or email is already registered. Sign in to continue.
            </Text>
            <TouchableOpacity
              style={styles.mPrimaryWrap}
              activeOpacity={0.9}
              onPress={() => {
                setExistsModal(false);
                navigation.navigate('Login');
              }}>
              <LinearGradient
                colors={['#6E9BF5', T.accent, T.accentDeep]}
                start={{x: 0.5, y: 0}}
                end={{x: 0.5, y: 1}}
                style={styles.mPrimaryBtn}>
                <Text style={styles.mPrimaryText}>Log in instead</Text>
              </LinearGradient>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.mSecondaryBtn}
              activeOpacity={0.7}
              onPress={() => setExistsModal(false)}>
              <Text style={styles.mSecondaryText}>Use different details</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: T.bg},
  heroGlow: {position: 'absolute', top: -110, left: '8%', right: '8%', height: 340, borderRadius: 500},

  scroll: {flex: 1},
  content: {paddingHorizontal: 22},

  // Top bar
  topRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 42},
  backBtn: {
    width: 42, height: 42, borderRadius: 21,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1, borderColor: T.hair2,
    alignItems: 'center', justifyContent: 'center',
  },
  stepWrap: {flexDirection: 'row', alignItems: 'center', gap: 11},
  stepDots: {flexDirection: 'row', alignItems: 'center', gap: 6},
  stepDot: {width: 10, height: 5, borderRadius: 3},
  stepDotIdle: {backgroundColor: T.hair2},
  stepPill: {
    width: 22, height: 5, borderRadius: 3,
    shadowColor: T.accent, shadowOffset: {width: 0, height: 0},
    shadowOpacity: 0.8, shadowRadius: 6, elevation: 4,
  },
  stepCount: {fontFamily: 'monospace', fontSize: 11, letterSpacing: 0.5},
  stepCountCur: {color: '#A9C5FF', fontWeight: '700'},
  stepCountTotal: {color: T.textFaint},

  // Header
  header: {paddingTop: 24, paddingBottom: 22, paddingHorizontal: 2},
  badgeRow: {flexDirection: 'row', gap: 8, marginBottom: 18},
  badgeCobalt: {
    paddingVertical: 3, paddingHorizontal: 8, borderRadius: 6,
    backgroundColor: 'rgba(91,141,239,0.12)',
    borderWidth: 1, borderColor: 'rgba(91,141,239,0.3)',
  },
  badgeCobaltText: {fontFamily: 'monospace', color: '#A9C5FF', fontSize: 9.5, letterSpacing: 1.8, fontWeight: '700'},
  badgeMuted: {
    paddingVertical: 3, paddingHorizontal: 8, borderRadius: 6,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1, borderColor: T.hair2,
  },
  badgeMutedText: {fontFamily: 'monospace', color: T.textMute, fontSize: 9.5, letterSpacing: 1.8, fontWeight: '700'},

  titleBlock: {marginBottom: 14},
  titleWhite: {color: T.text, fontSize: 30, fontWeight: '700', letterSpacing: -0.9, lineHeight: 32},

  encNote: {flexDirection: 'row', alignItems: 'center', gap: 8},
  encNoteText: {color: T.textDim, fontSize: 12.5, letterSpacing: -0.05},

  // Form
  form: {gap: 18},
  fieldGroup: {gap: 9},
  fieldLabel: {fontFamily: 'monospace', color: T.textDim, fontSize: 9.5, letterSpacing: 1.8, fontWeight: '600', textTransform: 'uppercase'},
  fieldHint: {color: T.textFaint, letterSpacing: 1.8},

  field: {
    minHeight: 58, borderRadius: 15, overflow: 'hidden',
    flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16,
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1,
  },
  fieldFlatLeft: {flex: 1},
  fieldFocused: {
    shadowColor: T.accent, shadowOffset: {width: 0, height: 0},
    shadowOpacity: 0.35, shadowRadius: 8, elevation: 5,
  },
  fieldEdge: {position: 'absolute', top: 0, left: 16, right: 16, height: 1},
  fieldIcon: {flexShrink: 0},
  // Why: alignSelf:'stretch', never height:'100%' — `field` is minHeight-driven
  // since B-680, so a percentage here has no definite anchor (B-682 class).
  fieldInputWrap: {flex: 1, minWidth: 0, alignSelf: 'stretch', justifyContent: 'center'},
  fieldFloatLabel: {
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

  // Phone row
  phoneRow: {flexDirection: 'row', alignItems: 'stretch', gap: 10},
  dialBox: {
    minHeight: 58, paddingHorizontal: 13, borderRadius: 15,
    flexDirection: 'row', alignItems: 'center', gap: 7,
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderWidth: 1, borderColor: T.hair2,
  },
  flagText: {fontSize: 18},
  dialText: {color: T.text, fontSize: 14.5, fontWeight: '600', letterSpacing: 0.2},
  phoneField: {flex: 1},

  // Strength bar
  strengthRow: {flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 2},
  strengthBars: {flexDirection: 'row', gap: 5, flex: 1},
  strengthSeg: {flex: 1, height: 4, borderRadius: 2},
  strengthText: {fontFamily: 'monospace', fontSize: 9.5, fontWeight: '700', letterSpacing: 1.2, textTransform: 'uppercase', minWidth: 62, textAlign: 'right'},

  mismatchText: {fontFamily: 'monospace', color: T.amber, fontSize: 10.5, letterSpacing: 0.6, marginTop: 2},

  // CTA
  // Why: shadow/elevation live on this OUTER wrapper, not on the LinearGradient.
  // On Android, `elevation` applied directly to a gradient surface composites a
  // dark inner rectangle inside the button; keeping the gradient elevation-free
  // (matching LoginScreen's CTA) paints it cleanly while the wrapper carries the glow.
  ctaWrap: {
    borderRadius: 17, marginTop: 6,
    shadowColor: T.accent, shadowOffset: {width: 0, height: 8},
    shadowOpacity: 0.4, shadowRadius: 16, elevation: 8,
  },
  cta: {
    height: 58, borderRadius: 17,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
  },
  ctaDisabled: {opacity: 0.55},
  ctaText: {color: '#fff', fontSize: 16.5, fontWeight: '700', letterSpacing: 0.2},

  signinRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, marginTop: 14},
  signinText: {color: T.textMute, fontSize: 13.5, letterSpacing: -0.05},
  signinLink: {color: T.accent, fontSize: 13.5, fontWeight: '700'},

  // ── "Account already exists" modal ──
  mBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(3,5,10,0.85)',
    alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 28,
  },
  mCard: {
    width: '100%',
    backgroundColor: 'rgba(17,21,29,0.98)',
    borderRadius: 22,
    paddingTop: 28, paddingBottom: 16, paddingHorizontal: 24,
    borderWidth: 1, borderColor: T.hair2,
    alignItems: 'center', overflow: 'hidden',
    shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 24, shadowOffset: {width: 0, height: 12},
    elevation: 24,
  },
  mEdge: {position: 'absolute', top: 0, left: 24, right: 24, height: 1},
  mIconWrap: {
    width: 64, height: 64, borderRadius: 19,
    borderWidth: 1, borderColor: 'rgba(91,141,239,0.4)',
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
    marginBottom: 18,
  },
  mTitle: {color: T.text, fontSize: 20, fontWeight: '700', letterSpacing: -0.3, marginBottom: 10, textAlign: 'center'},
  mBody: {color: T.textDim, fontSize: 14, lineHeight: 20, textAlign: 'center', marginBottom: 22, paddingHorizontal: 4},
  mPrimaryWrap: {width: '100%', marginBottom: 6},
  mPrimaryBtn: {
    width: '100%', height: 52, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
  },
  mPrimaryText: {color: '#fff', fontSize: 15, fontWeight: '700', letterSpacing: 0.2},
  mSecondaryBtn: {width: '100%', height: 48, alignItems: 'center', justifyContent: 'center'},
  mSecondaryText: {color: T.textMute, fontSize: 13.5, fontWeight: '600', letterSpacing: -0.05},
}));
