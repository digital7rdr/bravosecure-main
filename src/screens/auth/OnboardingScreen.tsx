import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  StatusBar,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {LinearGradient} from 'expo-linear-gradient';
import Svg, {Defs, LinearGradient as SvgGradient, Stop, Path, Rect, Circle, Text as SvgText} from 'react-native-svg';
import BravoMark from '@components/BravoMark';
import type {AuthScreenProps} from '@navigation/types';
import {useProductStore, type BravoProduct} from '@store/productStore';
import {scaleTextStyles} from '@utils/scaling';

type Props = AuthScreenProps<'Onboarding'>;

// ── Design tokens (Bravo handoff — obsidian / platinum-cobalt) ──────────
// Why: ported verbatim from the Claude Design bundle (src/tokens.jsx) so this
// screen matches the premium "Welcome to Bravo" mock exactly, rather than the
// older Command-Navy palette. Mirrors the sibling RoleSelectionScreen, which
// is the next step in the same onboarding flow.
const T = {
  bg:         '#07090D',
  text:       '#F2F4F8',
  textDim:    'rgba(229,233,242,0.62)',
  textMute:   'rgba(180,188,204,0.45)',
  hair:       'rgba(255,255,255,0.06)',
  hair2:      'rgba(255,255,255,0.09)',
  accent:     '#5B8DEF',
  accentDeep: '#2F5BE0',
  accentGlow: 'rgba(91,141,239,0.35)',
  signal:     '#4ADE80',
} as const;

// ── Gradient wordmark ("Bravo") ────────────────────────────────────────
// Why: the design renders "Bravo" with a cobalt→violet gradient fill. We use
// an SVG <Text> gradient (react-native-svg is already a dependency) instead
// of MaskedView, avoiding a new native module + rebuild. The SVG box is sized
// tight to the glyphs (no extra vertical padding) so it sits flush on its own
// heading line — matching the design, where "Bravo" wraps below "Welcome to".
function GradientWord({text, fontSize = 38}: {text: string; fontSize?: number}) {
  const w = text.length * fontSize * 0.64;
  const h = fontSize; // cap height ≈ font size; baseline placed inside
  return (
    <Svg width={w} height={h}>
      <Defs>
        <SvgGradient id="bravoWord" x1="0" y1="0" x2={w} y2="0" gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor="#7FA8FF" />
          <Stop offset="0.55" stopColor="#5B8DEF" />
          <Stop offset="1" stopColor="#A78BFA" />
        </SvgGradient>
      </Defs>
      <SvgText
        x={0}
        y={fontSize * 0.78}
        fill="url(#bravoWord)"
        fontSize={fontSize}
        fontWeight="700"
        letterSpacing={-1.3}>
        {text}
      </SvgText>
    </Svg>
  );
}

// ── Service icons (exact paths from vbg-welcome.jsx) ────────────────────
function IcChat({c}: {c: string}) {
  return (
    <Svg width={24} height={24} viewBox="0 0 24 24" fill="none">
      <Path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-4 3.5V17H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" stroke={c} strokeWidth={1.7} strokeLinejoin="round" />
      <Path d="M8 10h8M8 13h5" stroke={c} strokeWidth={1.7} strokeLinecap="round" />
    </Svg>
  );
}
function IcShield({c}: {c: string}) {
  return (
    <Svg width={24} height={24} viewBox="0 0 24 24" fill="none">
      <Path d="M12 3l7 2.5V11c0 4.2-2.9 7.6-7 8.8C7.9 18.6 5 15.2 5 11V5.5L12 3Z" stroke={c} strokeWidth={1.7} strokeLinejoin="round" />
      <Path d="M9.2 11.8l2 2 3.6-4.2" stroke={c} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}
function IcBot({c}: {c: string}) {
  return (
    <Svg width={24} height={24} viewBox="0 0 24 24" fill="none">
      <Rect x={5} y={8} width={14} height={11} rx={3.2} stroke={c} strokeWidth={1.7} />
      <Path d="M12 5.5V8M9 4.5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 0 0-3 0Z" stroke={c} strokeWidth={1.7} strokeLinejoin="round" />
      <Circle cx={9.5} cy={13} r={1.2} fill={c} />
      <Circle cx={14.5} cy={13} r={1.2} fill={c} />
      <Path d="M2.8 12v3M21.2 12v3" stroke={c} strokeWidth={1.7} strokeLinecap="round" />
    </Svg>
  );
}
function IcArrow({c, s = 18}: {c: string; s?: number}) {
  return (
    <Svg width={s} height={s} viewBox="0 0 24 24" fill="none">
      <Path d="M4 12h15M13 6l6 6-6 6" stroke={c} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}
function IcLock({c}: {c: string}) {
  return (
    <Svg width={11} height={12} viewBox="0 0 14 14" fill="none">
      <Rect x={2.5} y={6} width={9} height={6} rx={1.3} stroke={c} strokeWidth={1.3} />
      <Path d="M4.5 6V4a2.5 2.5 0 0 1 5 0v2" stroke={c} strokeWidth={1.3} strokeLinecap="round" />
    </Svg>
  );
}

// ── Per-service tint (from vbg-welcome.jsx SVC_TINT) ────────────────────
type Tint = {
  ic: string;
  tile: [string, string];
  bd: string;
  glow: string;
};
const TINTS: Record<'blue' | 'signal' | 'indigo', Tint> = {
  blue:   {ic: '#A9C5FF', tile: ['rgba(91,141,239,0.26)', 'rgba(47,91,224,0.07)'], bd: 'rgba(91,141,239,0.4)', glow: 'rgba(91,141,239,0.3)'},
  signal: {ic: '#8FE9B4', tile: ['rgba(74,222,128,0.2)', 'rgba(74,222,128,0.05)'], bd: 'rgba(74,222,128,0.34)', glow: 'rgba(74,222,128,0.24)'},
  indigo: {ic: '#B7BEFF', tile: ['rgba(129,140,248,0.24)', 'rgba(79,70,229,0.06)'], bd: 'rgba(129,140,248,0.38)', glow: 'rgba(129,140,248,0.26)'},
};

type Service = {
  key: string;
  tint: keyof typeof TINTS;
  Icon: (p: {c: string}) => React.ReactElement;
  title: string;
  desc: string;
  badge?: string;
};

const SERVICES: Service[] = [
  {key: 'messenger', tint: 'blue', Icon: IcChat, title: 'Messenger', desc: 'Secure encrypted communications, team chats, calls & news.'},
  {key: 'services', tint: 'signal', Icon: IcShield, title: 'Secure Services', desc: 'On-demand security, transfers & executive protection.'},
  {key: 'vb', tint: 'indigo', Icon: IcBot, title: 'Virtual Bodyguard', desc: 'AI-powered personal safety monitoring & risk intelligence.', badge: 'AI'},
];

// B-91 M0 — selector card → the standalone product it opens after signup.
const SERVICE_PRODUCT: Record<Service['key'], BravoProduct> = {
  messenger: 'messenger',
  services: 'secure',
  vb: 'vbg',
};

function ServiceCard({service, onPress}: {service: Service; onPress: () => void}) {
  const t = TINTS[service.tint];
  const {Icon} = service;
  return (
    <TouchableOpacity activeOpacity={0.85} onPress={onPress} style={styles.cardWrap}>
      <LinearGradient
        colors={['rgba(22,28,40,0.78)', 'rgba(15,20,29,0.72)']}
        start={{x: 0.5, y: 0}}
        end={{x: 0.5, y: 1}}
        style={styles.card}>

        {/* top edge light */}
        <LinearGradient
          colors={['transparent', 'rgba(255,255,255,0.13)', 'transparent']}
          start={{x: 0, y: 0}}
          end={{x: 1, y: 0}}
          style={styles.edgeLight}
        />
        {/* faint left accent glow */}
        <View style={[styles.cardGlow, {backgroundColor: t.glow}]} />

        {/* icon tile */}
        <View style={[styles.tile, {borderColor: t.bd}]}>
          <LinearGradient
            colors={t.tile}
            start={{x: 0.1, y: 0}}
            end={{x: 0.9, y: 1}}
            style={StyleSheet.absoluteFill}
          />
          <Icon c={t.ic} />
        </View>

        {/* body */}
        <View style={styles.cardBody}>
          <View style={styles.cardTitleRow}>
            <Text style={styles.cardTitle} numberOfLines={1}>{service.title}</Text>
            {service.badge && (
              <LinearGradient
                colors={['#9F8CFB', '#6D5AE0']}
                start={{x: 0.5, y: 0}}
                end={{x: 0.5, y: 1}}
                style={styles.aiBadge}>
                <Text style={styles.aiBadgeText}>{service.badge}</Text>
              </LinearGradient>
            )}
          </View>
          <Text style={styles.cardDesc}>{service.desc}</Text>
        </View>

        {/* arrow affordance */}
        <View style={[styles.cardArrow, {opacity: 0.85}]}>
          <IcArrow c={t.ic} s={18} />
        </View>
      </LinearGradient>
    </TouchableOpacity>
  );
}

export default function OnboardingScreen({navigation}: Props) {
  const insets = useSafeAreaInsets();

  // B-91 M0 — the tapped card decides which product the account lands in
  // after signup (adopted by the client shell on first authed mount).
  const handlePath = (key: Service['key']) => {
    useProductStore.getState().setPendingProduct(SERVICE_PRODUCT[key]);
    navigation.navigate('RoleSelection');
  };
  const handleSignIn = () => navigation.navigate('Login');

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={T.bg} />

      {/* Ambient obsidian + cobalt hero glow */}
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <LinearGradient
          colors={['rgba(91,141,239,0.16)', 'rgba(91,141,239,0)']}
          start={{x: 0.5, y: 0}}
          end={{x: 0.5, y: 1}}
          style={styles.heroGlow}
        />
        <LinearGradient
          colors={['rgba(47,91,224,0.06)', 'rgba(47,91,224,0)']}
          start={{x: 0.5, y: 1}}
          end={{x: 0.5, y: 0}}
          style={styles.bottomGlow}
        />
      </View>

      {/* Brand lockup */}
      <View style={[styles.brand, {paddingTop: insets.top + 22}]}>
        <View style={styles.brandTile}>
          <LinearGradient
            colors={['rgba(91,141,239,0.22)', 'rgba(20,28,46,0.6)']}
            start={{x: 0.1, y: 0}}
            end={{x: 0.9, y: 1}}
            style={StyleSheet.absoluteFill}
          />
          <BravoMark size={32} primary="#FFFFFF" accent="#5B8DEF" />
        </View>
        <View>
          <Text style={styles.brandName}>BRAVO</Text>
          <Text style={styles.brandSub}>SECURE</Text>
        </View>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}>

        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.eyebrow}>Welcome</Text>
          <View style={styles.titleBlock}>
            <Text style={styles.title}>Welcome to</Text>
            <GradientWord text="Bravo" fontSize={38} />
          </View>
          <Text style={styles.subtitle}>Choose how you'd like to get started.</Text>
        </View>

        {/* Service cards */}
        <View style={styles.cards}>
          {SERVICES.map(s => (
            <ServiceCard key={s.key} service={s} onPress={() => handlePath(s.key)} />
          ))}
        </View>

        {/* Trust strip */}
        <View style={styles.trust}>
          {['End-to-end encrypted', '24/7 operations'].map(label => (
            <View key={label} style={styles.trustItem}>
              <IcLock c={T.signal} />
              <Text style={styles.trustText}>{label}</Text>
            </View>
          ))}
        </View>
      </ScrollView>

      {/* Footer — Sign In */}
      <LinearGradient
        colors={['rgba(7,9,13,0)', 'rgba(7,9,13,1)']}
        start={{x: 0.5, y: 0}}
        end={{x: 0.5, y: 0.55}}
        style={[styles.footer, {paddingBottom: insets.bottom + 24}]}>
        <View style={styles.divider} />
        <View style={styles.footerRow}>
          <Text style={styles.footerText}>Already have an account?</Text>
          <TouchableOpacity onPress={handleSignIn} activeOpacity={0.7} style={styles.signInBtn}>
            <Text style={styles.signIn}>Sign In</Text>
            <IcArrow c={T.accent} s={15} />
          </TouchableOpacity>
        </View>
      </LinearGradient>
    </View>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: T.bg},

  heroGlow: {position: 'absolute', top: -120, left: '8%', right: '8%', height: 360, borderRadius: 500},
  bottomGlow: {position: 'absolute', bottom: -200, left: -60, right: -60, height: 400, borderRadius: 500},

  // Brand lockup
  brand: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 26},
  brandTile: {
    width: 50, height: 50, borderRadius: 15,
    borderWidth: 1, borderColor: 'rgba(91,141,239,0.4)',
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  brandName: {fontFamily: 'monospace', color: T.text, fontSize: 14, fontWeight: '700', letterSpacing: 5},
  brandSub: {fontFamily: 'monospace', color: '#A9C5FF', fontSize: 9, fontWeight: '600', letterSpacing: 4.5, marginTop: 2},

  scroll: {flex: 1},
  scrollContent: {paddingHorizontal: 22, paddingBottom: 24},

  // Header
  header: {paddingTop: 34, paddingBottom: 26, paddingHorizontal: 4},
  eyebrow: {fontFamily: 'monospace', color: T.textMute, fontSize: 10.5, fontWeight: '600', letterSpacing: 3, textTransform: 'uppercase', marginBottom: 14},
  titleBlock: {marginBottom: 13},
  title: {color: T.text, fontSize: 38, fontWeight: '700', letterSpacing: -1.3, lineHeight: 40},
  subtitle: {color: T.textDim, fontSize: 14.5, lineHeight: 21, letterSpacing: -0.1, maxWidth: 300},

  // Cards
  cards: {gap: 13},
  cardWrap: {borderRadius: 20},
  card: {
    flexDirection: 'row', alignItems: 'center', gap: 15,
    paddingVertical: 17, paddingHorizontal: 16,
    borderRadius: 20, overflow: 'hidden',
    borderWidth: 1, borderColor: T.hair,
  },
  edgeLight: {position: 'absolute', top: 0, left: 18, right: 18, height: 1},
  cardGlow: {position: 'absolute', left: -30, top: '50%', marginTop: -45, width: 90, height: 90, borderRadius: 45, opacity: 0.5},
  tile: {
    width: 52, height: 52, borderRadius: 15, flexShrink: 0,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, overflow: 'hidden',
  },
  cardBody: {flex: 1, minWidth: 0},
  cardTitleRow: {flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 5},
  cardTitle: {color: T.text, fontSize: 15.5, fontWeight: '700', letterSpacing: -0.3, flexShrink: 1},
  cardDesc: {color: T.textDim, fontSize: 12, lineHeight: 17, letterSpacing: -0.05},
  aiBadge: {paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5, flexShrink: 0},
  aiBadgeText: {fontFamily: 'monospace', color: '#fff', fontSize: 8, fontWeight: '800', letterSpacing: 1},
  cardArrow: {flexShrink: 0},

  // Trust strip
  trust: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 18, marginTop: 19},
  trustItem: {flexDirection: 'row', alignItems: 'center', gap: 7},
  trustText: {fontFamily: 'monospace', color: T.textMute, fontSize: 9, letterSpacing: 0.4},

  // Footer
  footer: {position: 'absolute', bottom: 0, left: 0, right: 0, paddingHorizontal: 26, paddingTop: 28},
  divider: {height: 1, backgroundColor: T.hair, marginBottom: 18},
  footerRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8},
  footerText: {color: T.textMute, fontSize: 13.5, letterSpacing: -0.05},
  signInBtn: {flexDirection: 'row', alignItems: 'center', gap: 5},
  signIn: {color: T.accent, fontSize: 14, fontWeight: '700'},
}));
