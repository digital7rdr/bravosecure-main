/**
 * VerificationBadge (Step 18 / B3) — a compact "verified" affordance (e.g. an agency with a
 * VERIFIED licence + insurance). `state` tints it: verified (green), pending (amber),
 * unverified (mute). Text-scale-aware.
 */
import React from 'react';
import {View, Text, StyleSheet} from 'react-native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {UI} from './tokens';
import {scaleTextStyles} from '@utils/scaling';

type State = 'verified' | 'pending' | 'unverified';

const META: Record<State, {icon: string; tint: string; label: string}> = {
  verified:   {icon: 'check-decagram', tint: UI.signal,   label: 'Verified'},
  pending:    {icon: 'clock-outline',  tint: UI.amber,    label: 'Pending'},
  unverified: {icon: 'shield-alert-outline', tint: UI.textMute, label: 'Unverified'},
};

export default function VerificationBadge({state = 'verified', label}: {state?: State; label?: string}) {
  const m = META[state];
  return (
    <View style={[s.pill, {borderColor: `${m.tint}40`, backgroundColor: `${m.tint}12`}]}>
      <Icon name={m.icon as never} size={13} color={m.tint} />
      <Text style={[s.text, {color: m.tint}]}>{label ?? m.label}</Text>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  pill: {flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start',
    paddingHorizontal: 8, paddingVertical: 4, borderRadius: 7, borderWidth: 1},
  text: {fontFamily: UI.fSemi, fontSize: 11},
}));
