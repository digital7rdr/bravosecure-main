/**
 * CN-09 — debounced "poor connection" pill for the in-call screens.
 *
 * The classifier + debounce live in runtime/callQuality (pure, node-tested);
 * this file is the thin React half: a hook that feeds the gate from the
 * screen's existing 1 Hz stats and a pill styled on the obsidian surface.
 * Transitions (not ticks) log under `[bravo.callquality]` via console.warn so
 * the signal survives release builds.
 */
import React, {useEffect, useRef, useState} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {createQualityGate, type CallQualitySample} from '../runtime/callQuality';

export function useCallQualityVisible(
  sample: CallQualitySample | null | undefined,
  active: boolean,
): boolean {
  const gateRef = useRef<ReturnType<typeof createQualityGate> | null>(null);
  if (!gateRef.current) {gateRef.current = createQualityGate();}
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!active) {
      gateRef.current?.reset();
      setVisible(false);
      return;
    }
    if (!sample) {return;}
    const v = gateRef.current!.next(sample);
    setVisible(prev => {
      if (prev !== v) {
        console.warn(
          `[bravo.callquality] banner ${v ? 'SHOW' : 'HIDE'} rtt=${sample.rttMs ?? '-'} jitter=${sample.jitterMs ?? '-'} loss=${sample.packetLossPct ?? '-'}`,
        );
      }
      return v;
    });
  }, [sample, active]);
  return visible;
}

export function CallQualityBanner({visible}: {visible: boolean}): React.JSX.Element | null {
  if (!visible) {return null;}
  return (
    <View style={s.wrap} pointerEvents="none">
      <View style={s.pill}>
        <View style={s.dot} />
        <Text style={s.txt}>Poor connection — audio may cut out</Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {alignItems: 'center'},
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(12,16,24,0.92)',
    borderColor: 'rgba(255,193,7,0.45)',
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
  },
  dot: {width: 8, height: 8, borderRadius: 4, backgroundColor: '#FFC107'},
  txt: {color: '#FFC107', fontSize: 13, fontWeight: '600'},
});
