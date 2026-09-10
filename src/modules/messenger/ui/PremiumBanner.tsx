import React from 'react';
import {View, Text, StyleSheet} from 'react-native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Bravo, BravoFont} from '@/theme/bravo';

/**
 * Tonally-themed banner used on Messenger + Chat headers (E2E
 * encryption / loopback mode / encrypted-channel state). Matches the
 * `Banner` component from the design handoff: soft gradient tint +
 * border matching the tone, top edge-light, mono-caps label on the
 * left and mono detail text on the right.
 */
type Tone = 'signal' | 'amber' | 'alert';

interface Props {
  tone:   Tone;
  label:  string;
  detail?: string;
  icon?:  keyof typeof Icon.glyphMap;
}

export function PremiumBanner({tone, label, detail, icon}: Props) {
  const map = {
    signal: {bg: 'rgba(74,222,128,0.07)', bd: 'rgba(74,222,128,0.2)',  fg: Bravo.signal},
    amber:  {bg: 'rgba(245,181,68,0.07)', bd: 'rgba(245,181,68,0.22)', fg: Bravo.amber},
    alert:  {bg: 'rgba(255,93,93,0.07)',  bd: 'rgba(255,93,93,0.22)',  fg: Bravo.alert},
  }[tone];
  const fallbackIcon: keyof typeof Icon.glyphMap = tone === 'signal'
    ? 'lock'
    : tone === 'amber' ? 'information-outline' : 'alert-circle-outline';
  return (
    <View style={[styles.wrap, {backgroundColor: map.bg, borderColor: map.bd}]}>
      <View style={[styles.edgeLight, {backgroundColor: map.bd}]} />
      <Icon name={icon ?? fallbackIcon} size={13} color={map.fg} />
      <Text style={[styles.label, {color: map.fg}]} numberOfLines={1}>{label}</Text>
      {detail ? (
        <Text style={styles.detail} numberOfLines={1}>{detail}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 14, paddingVertical: 9,
    borderRadius: 10, borderWidth: 1, overflow: 'hidden',
  },
  edgeLight: {position: 'absolute', top: 0, left: 14, right: 14, height: 1, opacity: 0.8},
  label: {
    flex: 1,
    minWidth: '40%',
    fontFamily:   BravoFont.mono,
    fontSize:     10,
    fontWeight:   '600',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  detail: {
    flexShrink: 1,
    minWidth: 0,
    fontFamily:   BravoFont.mono,
    fontSize:     9.5,
    letterSpacing: 0.6,
    color:        'rgba(255,255,255,0.5)',
  },
});
