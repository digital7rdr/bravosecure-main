/**
 * MX-09 — determinate upload ring overlaid on a sending media bubble.
 * Re-renders at most every 2% (uploadProgress quantises), so plain
 * prop-driven SVG is cheap — no Animated needed.
 */
import React from 'react';
import {View, Text, StyleSheet} from 'react-native';
import Svg, {Circle} from 'react-native-svg';

const ACCENT = '#5B8DEF';

export function UploadProgressRing({fraction, size = 44}: {
  /** 0..1 */
  fraction: number;
  size?:    number;
}) {
  const stroke = 3.5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(1, fraction));
  return (
    <View
      style={styles.scrim}
      pointerEvents="none"
      accessibilityLabel={`Uploading, ${Math.round(clamped * 100)} percent`}>
      <View style={[styles.ringWrap, {width: size, height: size}]}>
        <Svg width={size} height={size}>
          <Circle
            cx={size / 2} cy={size / 2} r={r}
            stroke="rgba(255,255,255,0.22)" strokeWidth={stroke} fill="none"
          />
          <Circle
            cx={size / 2} cy={size / 2} r={r}
            stroke={ACCENT} strokeWidth={stroke} fill="none"
            strokeLinecap="round"
            strokeDasharray={`${c}`}
            strokeDashoffset={c * (1 - clamped)}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        </Svg>
        <Text style={styles.pct}>{Math.round(clamped * 100)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  scrim: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(4,6,10,0.35)',
    borderRadius: 12,
  },
  ringWrap: {alignItems: 'center', justifyContent: 'center'},
  pct: {position: 'absolute', color: '#FFF', fontSize: 10, fontWeight: '800'},
});
