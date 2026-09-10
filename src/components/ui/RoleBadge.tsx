/**
 * RoleBadge (Step 18 / B3) — a small pill labelling the actor's role (Client / Agency /
 * Guard / Lead). Tinted per role. Text-scale-aware.
 */
import React from 'react';
import {View, Text, StyleSheet} from 'react-native';
import {UI} from './tokens';
import {scaleTextStyles} from '@utils/scaling';

export type Role = 'client' | 'agency' | 'cpo' | 'lead';

const META: Record<Role, {label: string; tint: string}> = {
  client: {label: 'CLIENT', tint: UI.accentSoft},
  agency: {label: 'AGENCY', tint: UI.accent},
  cpo:    {label: 'GUARD',  tint: UI.signal},
  lead:   {label: 'LEAD',   tint: UI.amber},
};

export default function RoleBadge({role, label}: {role: Role; label?: string}) {
  const m = META[role];
  return (
    <View style={[s.pill, {borderColor: `${m.tint}44`, backgroundColor: `${m.tint}12`}]}>
      <Text style={[s.text, {color: m.tint}]}>{label ?? m.label}</Text>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  pill: {alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1},
  text: {fontFamily: UI.fBold, fontSize: 9, letterSpacing: 1},
}));
