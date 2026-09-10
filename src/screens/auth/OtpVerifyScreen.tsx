import React, {useState, useRef, useEffect} from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
  Animated,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {LinearGradient} from 'expo-linear-gradient';
import Svg, {Path, Rect, Circle} from 'react-native-svg';
import * as Clipboard from 'expo-clipboard';
import {scaleTextStyles} from '@utils/scaling';
import {useAuthStore} from '@store/authStore';
import type {AuthScreenProps} from '@navigation/types';
import {goBackOnce} from '@navigation/tapGuard';

type Props = AuthScreenProps<'OtpVerify'>;

const OTP_LENGTH = 6;

// ── Design tokens (Bravo handoff — obsidian / platinum-cobalt) ──────────
// Why: same tokens as the sibling Login / OTPVerification screens so the
// login OTP step is visually indistinguishable from the signup one.
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
  danger:     '#FF8B8B',
} as const;

// ── Glyphs (same paths as OTPVerificationScreen) ────────────────────────
function IcBack({c}: {c: string}) {
  return (
    <Svg width={9} height={15} viewBox="0 0 9 15" fill="none">
      <Path d="M8 1L1.5 7.5 8 14" stroke={c} strokeWidth={1.8} fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}
function IcLockTile({c}: {c: string}) {
  return (
    <Svg width={26} height={26} viewBox="0 0 24 24" fill="none">
      <Rect x={4.5} y={10} width={15} height={11} rx={2.6} stroke={c} strokeWidth={1.7} />
      <Path d="M8 10V7a4 4 0 0 1 8 0v3" stroke={c} strokeWidth={1.7} strokeLinecap="round" />
      <Circle cx={12} cy={15.4} r={1.6} fill={c} />
    </Svg>
  );
}
function IcCheck({c}: {c: string}) {
  return (
    <Svg width={19} height={19} viewBox="0 0 24 24" fill="none">
      <Path d="M5 12.5l4.5 4.5L19 7.5" stroke={c} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}
function IcPaste({c}: {c: string}) {
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
      <Rect x={6} y={4} width={12} height={16} rx={2.2} stroke={c} strokeWidth={1.6} />
      <Path d="M9 4.2V3.4A1.4 1.4 0 0 1 10.4 2h3.2A1.4 1.4 0 0 1 15 3.4v.8" stroke={c} strokeWidth={1.6} />
      <Path d="M9 11h6M9 14.5h4" stroke={c} strokeWidth={1.6} strokeLinecap="round" />
    </Svg>
  );
}
function IcBackspace({c}: {c: string}) {
  return (
    <Svg width={24} height={24} viewBox="0 0 24 24" fill="none">
      <Path d="M9 5.5h10a1.5 1.5 0 0 1 1.5 1.5v10a1.5 1.5 0 0 1-1.5 1.5H9L3 12l6-6.5Z" stroke={c} strokeWidth={1.6} strokeLinejoin="round" />
      <Path d="M11 9.5l4 5M15 9.5l-4 5" stroke={c} strokeWidth={1.6} strokeLinecap="round" />
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

// ── OTP cell — edge-lit, glowing ring + blinking caret when active ──────
function OtpCell({value, active, caret}: {value: string; active: boolean; caret: Animated.Value}) {
  const filled = value !== '';
  return (
    <View style={[s.cell, filled && s.cellFilled, active && s.cellActive]}>
      {filled && (
        <LinearGradient
          colors={['rgba(22,28,44,0.9)', 'rgba(14,19,30,0.85)']}
          start={{x: 0.5, y: 0}}
          end={{x: 0.5, y: 1}}
          style={StyleSheet.absoluteFill}
        />
      )}
      {filled ? (
        <Text style={s.cellDigit}>{value}</Text>
      ) : active ? (
        <Animated.View style={[s.cellCaret, {opacity: caret}]} />
      ) : (
        <View style={s.cellDot} />
      )}
    </View>
  );
}

// ── Keypad key — dark glass, cobalt press state ─────────────────────────
function Key({label, icon, onPress, accessibilityLabel}: {
  label?: string;
  icon?: React.ReactNode;
  onPress: () => void;
  accessibilityLabel: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({pressed}) => [s.key, pressed && s.keyDown]}>
      {icon ?? <Text style={s.keyText}>{label}</Text>}
    </Pressable>
  );
}

/**
 * IDN-12/28 — LOGIN OTP entry. Reached only when /auth/login did NOT
 * return a devOtpCode (live Twilio delivery). Verifies via the same
 * verifyOtp store action the staging auto-verify path uses.
 *
 * No Resend here: auth-service has no login-OTP resend endpoint —
 * re-submitting credentials on the login screen issues a fresh code,
 * which is what the "Back to sign in" link is for.
 */
export default function OtpVerifyScreen({navigation, route}: Props) {
  const {userId, phoneHint} = route.params;
  const insets = useSafeAreaInsets();
  const [code, setCode] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const {verifyOtp, completeAuth, isLoading} = useAuthStore();

  // Blinking caret — steps(1) on/off, like the mock's CSS keyframe
  const caret = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(caret, {toValue: 1, duration: 0, useNativeDriver: true}),
        Animated.delay(525),
        Animated.timing(caret, {toValue: 0, duration: 0, useNativeDriver: true}),
        Animated.delay(525),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [caret]);

  const press = (d: string) => {
    if (busy || isLoading) {return;}
    setErrorMsg(null);
    setCode(c => (c.length >= OTP_LENGTH ? c : c + d));
  };
  const backspace = () => {
    setErrorMsg(null);
    setCode(c => c.slice(0, -1));
  };
  const paste = async () => {
    const text = await Clipboard.getStringAsync();
    const found = (text.match(/\d/g) ?? []).join('').slice(0, OTP_LENGTH);
    if (found) {
      setErrorMsg(null);
      setCode(found);
    }
  };

  const handleVerify = async () => {
    if (code.length < OTP_LENGTH || busy) {return;}
    setBusy(true);
    setErrorMsg(null);
    try {
      await verifyOtp(userId, code);
      await completeAuth();
      // RootNavigator swaps to Main once isAuthenticated flips.
    } catch (e: unknown) {
      // Surface the server's message (wrong code / expired / too many
      // attempts) inline; clear the cells so the retry starts fresh.
      const msg = e instanceof Error ? e.message : 'Invalid code. Please try again.';
      setErrorMsg(typeof msg === 'string' ? msg : 'Invalid code. Please try again.');
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  const maskedPhone = phoneHint
    ? phoneHint.replace(/(\+\d{3})\d+(\d{4})/, '$1 ** *** $2')
    : null;
  const isComplete = code.length === OTP_LENGTH;
  const activeIdx = code.length;
  const verifying = isLoading || busy;

  return (
    <View style={s.root}>
      {/* Ambient obsidian + cobalt hero glow */}
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <LinearGradient
          colors={['rgba(91,141,239,0.16)', 'rgba(91,141,239,0)']}
          start={{x: 0.5, y: 0}}
          end={{x: 0.5, y: 1}}
          style={s.heroGlow}
        />
      </View>

      {/* ── Top bar: back to login ── */}
      <View style={[s.topRow, {marginTop: insets.top + 12}]}>
        <TouchableOpacity
          style={s.backBtn}
          onPress={() => goBackOnce(navigation)}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Back to sign in">
          <IcBack c={T.text} />
        </TouchableOpacity>
      </View>

      <ScrollView
        style={s.flex}
        contentContainerStyle={s.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}>

        {/* ── Title block ── */}
        <View style={s.lockTile}>
          <LinearGradient
            colors={['rgba(91,141,239,0.22)', 'rgba(47,91,224,0.05)']}
            start={{x: 0.2, y: 0}}
            end={{x: 0.8, y: 1}}
            style={StyleSheet.absoluteFill}
          />
          <IcLockTile c="#A9C5FF" />
        </View>
        <Text style={s.title}>Two-factor check</Text>
        <Text style={s.subtitle}>
          Enter the {OTP_LENGTH}-digit code we sent to{' '}
          {maskedPhone
            ? <Text style={s.phone}>{maskedPhone}</Text>
            : 'your registered phone number'}
        </Text>

        {/* ── OTP cells ── */}
        <View style={s.otpRow}>
          {Array.from({length: OTP_LENGTH}).map((_, i) => (
            <OtpCell key={i} value={code[i] ?? ''} active={i === activeIdx} caret={caret} />
          ))}
        </View>

        {/* ── Server error (wrong / expired / attempts) ── */}
        {errorMsg ? (
          <View style={s.errorBox}>
            <IcAlert c={T.danger} />
            <Text style={s.errorText}>{errorMsg}</Text>
          </View>
        ) : null}

        {/* ── Back to sign in (re-signing in issues a fresh code) ── */}
        <View style={s.resendRow}>
          <Text style={s.resendHint}>Didn't get the code?</Text>
          <TouchableOpacity onPress={() => goBackOnce(navigation)} activeOpacity={0.7}>
            <Text style={s.resendActive}>Back to sign in</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      {/* ── Verify button ── */}
      <View style={s.footer}>
        <TouchableOpacity
          activeOpacity={0.9}
          onPress={() => { void handleVerify(); }}
          disabled={!isComplete || verifying}
          style={[s.ctaWrap, isComplete && !verifying && s.ctaGlow]}>
          {isComplete ? (
            <LinearGradient
              colors={['#6E9BF5', T.accent, T.accentDeep]}
              start={{x: 0.5, y: 0}}
              end={{x: 0.5, y: 1}}
              style={s.cta}>
              {verifying ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <>
                  <IcCheck c="#fff" />
                  <Text style={s.ctaText}>Verify & Sign In</Text>
                </>
              )}
            </LinearGradient>
          ) : (
            <View style={[s.cta, s.ctaIdle]}>
              <Text style={[s.ctaText, s.ctaTextIdle]}>Verify & Sign In</Text>
            </View>
          )}
        </TouchableOpacity>
      </View>

      {/* ── Custom in-app numeric keypad ── */}
      <View style={[s.keypad, {paddingBottom: insets.bottom + 22}]}>
        <LinearGradient
          colors={['rgba(11,14,20,0)', 'rgba(11,14,20,0.6)', 'rgba(9,11,16,0.92)']}
          locations={[0, 0.3, 1]}
          start={{x: 0.5, y: 0}}
          end={{x: 0.5, y: 1}}
          style={StyleSheet.absoluteFill}
        />
        {[['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9']].map(row => (
          <View key={row[0]} style={s.keyRow}>
            {row.map(d => (
              <Key key={d} label={d} onPress={() => press(d)} accessibilityLabel={`Digit ${d}`} />
            ))}
          </View>
        ))}
        <View style={s.keyRow}>
          <Key icon={<IcPaste c={T.textMute} />} onPress={() => { void paste(); }} accessibilityLabel="Paste code" />
          <Key label="0" onPress={() => press('0')} accessibilityLabel="Digit 0" />
          <Key icon={<IcBackspace c={T.danger} />} onPress={backspace} accessibilityLabel="Delete digit" />
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: T.bg},
  flex: {flex: 1},
  heroGlow: {position: 'absolute', top: -110, left: '8%', right: '8%', height: 340, borderRadius: 500},

  // Top bar
  topRow: {flexDirection: 'row', alignItems: 'center', minHeight: 42, paddingHorizontal: 22},
  backBtn: {
    width: 42, height: 42, borderRadius: 21,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1, borderColor: T.hair2,
    alignItems: 'center', justifyContent: 'center',
  },

  content: {flexGrow: 1, paddingHorizontal: 22},

  // Title block
  lockTile: {
    width: 56, height: 56, borderRadius: 17, marginTop: 26, marginBottom: 20, marginLeft: 4,
    borderWidth: 1, borderColor: 'rgba(91,141,239,0.34)',
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
    shadowColor: T.accent, shadowOffset: {width: 0, height: 10},
    shadowOpacity: 0.22, shadowRadius: 15, elevation: 8,
  },
  title: {fontSize: 32, fontWeight: '700', letterSpacing: -1, color: T.text, lineHeight: 34, paddingHorizontal: 4},
  subtitle: {fontSize: 14.5, color: T.textDim, marginTop: 12, letterSpacing: -0.1, lineHeight: 21, paddingHorizontal: 4},
  phone: {fontFamily: 'monospace', fontWeight: '600', color: T.text, letterSpacing: 0.2},

  // OTP cells
  otpRow: {flexDirection: 'row', gap: 9, marginTop: 28},
  cell: {
    flex: 1, minHeight: 64, borderRadius: 16, overflow: 'hidden',
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.022)',
    borderWidth: 1.5, borderColor: T.hair2,
  },
  cellFilled: {borderColor: 'rgba(91,141,239,0.32)'},
  cellActive: {
    borderColor: T.accent,
    shadowColor: T.accent, shadowOffset: {width: 0, height: 4},
    shadowOpacity: 0.4, shadowRadius: 10, elevation: 6,
  },
  cellDigit: {fontSize: 27, fontWeight: '700', color: T.text, letterSpacing: -0.5},
  cellCaret: {width: 2, height: 28, borderRadius: 2, backgroundColor: T.accent},
  cellDot: {width: 7, height: 7, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.10)'},

  // Error box — same pattern as LoginScreen
  errorBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16,
    backgroundColor: 'rgba(255,93,93,0.10)', borderRadius: 12,
    paddingVertical: 10, paddingHorizontal: 12,
    borderWidth: 1, borderColor: 'rgba(255,93,93,0.25)',
  },
  errorText: {flex: 1, fontSize: 13, color: T.danger, fontWeight: '500'},

  // Back-to-login row
  resendRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 20, paddingHorizontal: 4},
  resendHint: {fontSize: 13, color: T.textMute, letterSpacing: -0.05},
  resendActive: {fontSize: 13.5, fontWeight: '700', color: T.accent, letterSpacing: 0.2},

  // Verify button
  footer: {paddingHorizontal: 22, paddingBottom: 16},
  // Why: shadow/elevation live on this OUTER wrapper, not on the
  // LinearGradient — Android elevation needs a solid-background host.
  ctaWrap: {borderRadius: 18, overflow: 'hidden'},
  ctaGlow: {
    shadowColor: T.accent, shadowOffset: {width: 0, height: 12},
    shadowOpacity: 0.35, shadowRadius: 19, elevation: 10,
  },
  cta: {
    height: 58, borderRadius: 18,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
  },
  ctaIdle: {backgroundColor: 'rgba(255,255,255,0.04)', borderColor: T.hair2},
  ctaText: {fontSize: 16.5, fontWeight: '700', letterSpacing: 0.2, color: '#fff'},
  ctaTextIdle: {color: T.textMute},

  // Keypad
  keypad: {paddingHorizontal: 16, paddingTop: 16, borderTopWidth: 1, borderTopColor: T.hair},
  keyRow: {flexDirection: 'row', gap: 9, marginBottom: 9},
  key: {
    flex: 1, height: 56, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.035)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)',
  },
  keyDown: {backgroundColor: 'rgba(91,141,239,0.16)', borderWidth: 1.5, borderColor: T.accentGlow},
  keyText: {fontSize: 24, fontWeight: '600', color: T.text},
}));
