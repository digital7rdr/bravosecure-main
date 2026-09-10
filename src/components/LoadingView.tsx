import React, {useEffect, useRef, useState} from 'react';
import {View, Text, StyleSheet, Animated, Easing, ActivityIndicator, Platform} from 'react-native';
import Svg, {Circle, Path} from 'react-native-svg';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/**
 * Palette for the loading / secure-access surface — obsidian + cobalt secure
 * access look (design-system tokens, matches the VBG/obsidian surface).
 */
const T = {
  bg:        '#07090D',
  accent:    '#5B8DEF',
  signal:    '#4ADE80',
  text:      '#F2F4F8',
  textDim:   'rgba(229,233,242,0.62)',
  textMute:  'rgba(180,188,204,0.45)',
  textFaint: 'rgba(180,188,204,0.28)',
  hair2:     'rgba(255,255,255,0.09)',
  blue:      '#A9C5FF',
} as const;

const FONT = {
  sans:  'Manrope_400Regular',
  med:   'Manrope_500Medium',
  semi:  'Manrope_600SemiBold',
  bold:  'Manrope_700Bold',
  extra: 'Manrope_800ExtraBold',
  mono:  Platform.select({ios: 'Menlo', android: 'monospace', default: 'monospace'}) ?? 'monospace',
} as const;

/** One staged security check shown in the loading checklist. */
export interface LoadingStep {
  /** Row headline, e.g. "Establishing secure channel". */
  label: string;
  /** Mono sub-line, e.g. "TLS 1.3 · end-to-end handshake". */
  sub?: string;
}

interface Props {
  /** Status headline, e.g. "Verifying session…". Keep it specific, not generic. */
  label?: string;
  /** Subtitle below the headline (used when no `steps` are supplied). */
  hint?: string;
  /** When true, renders as a full-screen overlay with the Bravo Secure brand title. */
  fullscreen?: boolean;
  /**
   * Optional staged checklist. When provided, the steps auto-advance and the
   * badge ring fills with progress (holding on the last step until this
   * view unmounts — a loader never fakes a "done" it can't observe).
   */
  steps?: LoadingStep[];
  /** Override the accent color (defaults to the cobalt secure-access accent). */
  accent?: string;
  /**
   * Milliseconds each staged step holds before the next lights up. Default 850
   * suits an open-ended wait. The cold-start intro runs on a FIXED 1.5 s budget
   * (client request), so it passes a shorter interval — otherwise only two of
   * its four checks would ever appear on screen.
   */
  stepMs?: number;
  /**
   * Smaller badge + type for content-area loading (list bodies, sheets)
   * — the founder's rule is that EVERY loading state shows the Bravo shield,
   * and full size overwhelms an inline body area.
   */
  compact?: boolean;
}

/**
 * The circular Bravo shield badge — THE loading identity (founder 2026-08-08:
 * every loading screen must be the "Bravo Secure / Verifying identity…"
 * screen). Exported so surfaces with their own interaction (BiometricGate's
 * lock screen) compose the exact same badge instead of drawing a sibling.
 */
export function BravoShieldBadge({size = 96, accent = T.accent}: {size?: number; accent?: string}) {
  return (
    <View
      style={{
        width: size, height: size, borderRadius: size / 2,
        backgroundColor: 'rgba(91,141,239,0.12)',
        borderWidth: 1, borderColor: 'rgba(91,141,239,0.35)',
        alignItems: 'center', justifyContent: 'center',
      }}>
      <Icon name="shield-lock" size={Math.round(size * 0.54)} color={accent} />
    </View>
  );
}

// ── per-step status pip ───────────────────────────────────────────────────
function StepPip({state, acc, spin}: {state: 'done' | 'active' | 'pending'; acc: string; spin: Animated.Value}) {
  const rotate = spin.interpolate({inputRange: [0, 1], outputRange: ['0deg', '360deg']});
  if (state === 'done') {
    return (
      <View style={[styles.pip, {backgroundColor: 'rgba(74,222,128,0.14)', borderColor: 'rgba(74,222,128,0.4)'}]}>
        <Svg width={13} height={13} viewBox="0 0 24 24" fill="none">
          <Path d="M5 12.5l4.2 4.2L19 7" stroke={T.signal} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" />
        </Svg>
      </View>
    );
  }
  if (state === 'active') {
    return (
      <View style={[styles.pip, {borderColor: 'transparent'}]}>
        <Animated.View style={[StyleSheet.absoluteFill, {transform: [{rotate}]}]}>
          <Svg width={26} height={26} viewBox="0 0 26 26" fill="none">
            <Circle cx={13} cy={13} r={10} stroke="rgba(255,255,255,0.08)" strokeWidth={2.4} fill="none" />
            <Circle cx={13} cy={13} r={10} stroke={acc} strokeWidth={2.4} strokeLinecap="round" strokeDasharray="62.8" strokeDashoffset={44} fill="none" />
          </Svg>
        </Animated.View>
        <View style={{width: 6, height: 6, borderRadius: 3, backgroundColor: acc}} />
      </View>
    );
  }
  return (
    <View style={[styles.pip, {backgroundColor: 'rgba(255,255,255,0.03)', borderColor: T.hair2}]}>
      <View style={{width: 5, height: 5, borderRadius: 2.5, backgroundColor: T.textFaint}} />
    </View>
  );
}

function StepRow({step, state, acc, spin}: {step: LoadingStep; state: 'done' | 'active' | 'pending'; acc: string; spin: Animated.Value}) {
  const active = state === 'active', done = state === 'done';
  return (
    <View
      style={[
        styles.stepRow,
        active && {backgroundColor: 'rgba(20,28,46,0.7)', borderColor: 'rgba(91,141,239,0.28)'},
        state === 'pending' && {opacity: 0.42},
      ]}>
      <StepPip state={state} acc={acc} spin={spin} />
      <View style={{flex: 1, minWidth: 0}}>
        <Text
          numberOfLines={1}
          style={{
            fontFamily: active || done ? FONT.bold : FONT.med,
            fontSize: 14,
            letterSpacing: -0.2,
            color: active ? T.text : done ? T.textDim : T.textMute,
          }}>
          {step.label}
        </Text>
        {step.sub ? (
          <Text numberOfLines={1} style={{fontFamily: FONT.mono, fontSize: 9.5, letterSpacing: 0.4, marginTop: 3, color: active ? T.blue : T.textMute}}>
            {step.sub}
          </Text>
        ) : null}
      </View>
      {done ? <Text style={{fontFamily: FONT.mono, fontSize: 9, fontWeight: '700', letterSpacing: 1, color: T.signal}}>OK</Text> : null}
    </View>
  );
}

// Ring geometry for the staged progress ring (drawn around the 96 badge).
const RING_BOX = 124;
const RING_R = 56;
const C = 2 * Math.PI * RING_R;

/**
 * Branded loading screen — the founder-approved "Bravo Secure / Verifying
 * identity…" composition: circular shield badge, brand title (fullscreen),
 * a status line specific to what is loading, and a small spinner. With
 * `steps` the badge gains a progress ring and a staged checklist.
 * Use whenever a surface is waiting on async work.
 */
export default function LoadingView({label, hint, fullscreen, steps, accent, compact, stepMs = 850}: Props) {
  const acc = accent ?? T.accent;
  const stepList = steps ?? [];
  const staged = stepList.length > 0;

  const spin = useRef(new Animated.Value(0)).current;   // active-pip rotation
  const prog = useRef(new Animated.Value(0)).current;   // staged progress (0..1)

  const [activeIdx, setActiveIdx] = useState(0);

  useEffect(() => {
    if (!staged) {return;}
    const loop = Animated.loop(Animated.timing(spin, {toValue: 1, duration: 700, easing: Easing.linear, useNativeDriver: true}));
    loop.start();
    return () => loop.stop();
  }, [staged, spin]);

  // Auto-advance the staged checklist; hold on the last step.
  useEffect(() => {
    const list = steps ?? [];
    if (list.length === 0) {return;}
    setActiveIdx(0);
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (let i = 1; i < list.length; i++) {
      timers.push(setTimeout(() => setActiveIdx(i), stepMs * i));
    }
    return () => timers.forEach(clearTimeout);
  }, [steps, stepMs]);

  // Animate the progress ring on each step change.
  useEffect(() => {
    const list = steps ?? [];
    if (list.length === 0) {return;}
    const p = Math.min(1, (activeIdx + 0.5) / list.length);
    Animated.timing(prog, {toValue: p, duration: 500, easing: Easing.out(Easing.ease), useNativeDriver: false}).start();
  }, [activeIdx, steps, prog]);

  const dashoffset = prog.interpolate({inputRange: [0, 1], outputRange: [C, 0]});

  const statusLine = staged ? (stepList[activeIdx]?.label ?? '') : label;
  const stepState = (i: number): 'done' | 'active' | 'pending' =>
    i < activeIdx ? 'done' : i === activeIdx ? 'active' : 'pending';

  const badgeSize = fullscreen ? 96 : compact ? 64 : 84;

  return (
    <View style={[styles.root, compact && styles.rootCompact, fullscreen && styles.fullscreen]} pointerEvents="none">
      {/* ── shield badge (+ progress ring when staged) ── */}
      {staged ? (
        <View style={styles.ringBox}>
          <Svg width={RING_BOX} height={RING_BOX} viewBox={`0 0 ${RING_BOX} ${RING_BOX}`} style={[StyleSheet.absoluteFill as object, {transform: [{rotate: '-90deg'}]}]}>
            <Circle cx={RING_BOX / 2} cy={RING_BOX / 2} r={RING_R} stroke="rgba(255,255,255,0.07)" strokeWidth={3} fill="none" />
            <AnimatedCircle
              cx={RING_BOX / 2} cy={RING_BOX / 2} r={RING_R} stroke={acc} strokeWidth={3} strokeLinecap="round" fill="none"
              strokeDasharray={C} strokeDashoffset={dashoffset}
            />
          </Svg>
          <BravoShieldBadge size={96} accent={acc} />
        </View>
      ) : (
        <BravoShieldBadge size={badgeSize} accent={acc} />
      )}

      {/* ── brand title (full screens) + status line ── */}
      <View style={[styles.statusWrap, compact && styles.statusWrapCompact]}>
        {fullscreen ? <Text style={styles.title}>Bravo Secure</Text> : null}
        {statusLine ? <Text style={[styles.subtitle, compact && styles.subtitleCompact]}>{statusLine}</Text> : null}
        {!staged && hint ? <Text style={[styles.hint, compact && styles.subtitleCompact]}>{hint}</Text> : null}
      </View>

      {/* ── small spinner, exactly like the reference lock screen ── */}
      {!staged ? <ActivityIndicator color={acc} style={compact ? styles.spinnerCompact : styles.spinner} /> : null}

      {/* ── staged checklist ── */}
      {staged ? (
        <View style={styles.steps}>
          {stepList.map((s, i) => (
            <StepRow key={s.label} step={s} state={stepState(i)} acc={acc} spin={spin} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {alignItems: 'center', justifyContent: 'center', paddingVertical: 40, gap: 0},
  rootCompact: {paddingVertical: 20},
  fullscreen: {...StyleSheet.absoluteFillObject, backgroundColor: T.bg, paddingVertical: 0, zIndex: 999},

  ringBox: {width: RING_BOX, height: RING_BOX, alignItems: 'center', justifyContent: 'center'},

  statusWrap: {alignItems: 'center', paddingHorizontal: 32, marginTop: 24},
  statusWrapCompact: {marginTop: 12},
  title: {fontFamily: FONT.extra, fontSize: 24, letterSpacing: -0.3, color: T.text, textAlign: 'center', marginBottom: 8},
  subtitle: {fontFamily: FONT.sans, fontSize: 14, lineHeight: 20, color: T.textDim, textAlign: 'center'},
  subtitleCompact: {fontSize: 12.5, lineHeight: 17},
  hint: {fontFamily: FONT.sans, fontSize: 12, lineHeight: 17, color: T.textMute, textAlign: 'center', marginTop: 4},

  spinner: {marginTop: 26},
  spinnerCompact: {marginTop: 14},

  steps: {width: '100%', maxWidth: 360, paddingHorizontal: 26, gap: 2, marginTop: 18},
  stepRow: {flexDirection: 'row', alignItems: 'center', gap: 13, paddingVertical: 11, paddingHorizontal: 13, borderRadius: 14, borderWidth: 1, borderColor: 'transparent'},
  pip: {width: 26, height: 26, borderRadius: 13, borderWidth: 1, alignItems: 'center', justifyContent: 'center'},
});
