/**
 * NetworkLatencyChip — small RTT badge driven by the messenger
 * runtime's heartbeat ping. Drop it on any chrome row to surface
 * connection quality without dragging the user into a settings page.
 *
 *   <NetworkLatencyChip />        // tiny pill, picks color by RTT
 *   <NetworkLatencyChip compact /> // dot only, for tight headers
 *
 * Tiers (Brand Kit v4):
 *   < 80ms   → ok     (#00C853 — Excellent)
 *   80–200   → warn   (#FFC107 — OK)
 *   > 200    → err    (#FF3B3B — Poor)
 *   null     → muted  (—)
 */
import React, {useMemo} from 'react';
import {View, Text, StyleSheet, Platform} from 'react-native';
import {useTransportRtt} from '@hooks/useTransportRtt';

interface Props {
  compact?: boolean;
  /** Override the surface color (defaults to a translucent navy). */
  background?: string;
}

const C = {
  ok:    '#00C853',
  warn:  '#FFC107',
  err:   '#FF3B3B',
  muted: '#7E8AA6',
  bg:    'rgba(22,47,84,0.85)',
  bd:    '#1C3B66',
};

const MONO = Platform.select({ios: 'Menlo', default: 'monospace'});

function tier(rtt: number | null): {color: string; label: string} {
  if (rtt == null)   return {color: C.muted, label: '—'};
  if (rtt < 80)      return {color: C.ok,    label: `${rtt}ms`};
  if (rtt <= 200)    return {color: C.warn,  label: `${rtt}ms`};
  return {color: C.err, label: `${rtt}ms`};
}

export default function NetworkLatencyChip({compact, background}: Props) {
  const rtt = useTransportRtt();
  const t   = useMemo(() => tier(rtt), [rtt]);

  if (compact) {
    return (
      <View style={[s.dotWrap, {backgroundColor: background ?? C.bg, borderColor: C.bd}]}>
        <View style={[s.dot, {backgroundColor: t.color}]} />
        <Text style={[s.dotTxt, {color: t.color}]}>{t.label}</Text>
      </View>
    );
  }

  return (
    <View style={[s.pill, {backgroundColor: background ?? C.bg, borderColor: C.bd}]}>
      <View style={[s.dot, {backgroundColor: t.color}]} />
      <Text style={s.lbl}>NET</Text>
      <Text style={[s.val, {color: t.color}]}>{t.label}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 10, paddingVertical: 5,
    borderRadius: 99, borderWidth: 1,
  },
  dotWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 7, paddingVertical: 3,
    borderRadius: 99, borderWidth: 1,
  },
  dot: {width: 6, height: 6, borderRadius: 3},
  lbl: {color: '#7E8AA6', fontSize: 9, fontWeight: '700', letterSpacing: 1.4, fontFamily: MONO},
  val: {fontSize: 11, fontWeight: '800', letterSpacing: 0.4, fontFamily: MONO},
  dotTxt: {fontSize: 10, fontWeight: '800', letterSpacing: 0.4, fontFamily: MONO},
});
