/**
 * EncryptionPill (Step 18 / B3) — a STATIC "end-to-end encrypted" affordance for Ops-Room /
 * comms surfaces. Purely decorative reassurance: it renders no key material, no message
 * body, nothing sensitive (honours the static log-audit / no-plaintext rule). Scale-aware.
 */
import React from 'react';
import {View, Text, StyleSheet} from 'react-native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {UI} from './tokens';
import {scaleTextStyles} from '@utils/scaling';

export default function EncryptionPill({label = 'End-to-end encrypted'}: {label?: string}) {
  return (
    <View style={s.pill}>
      <Icon name="lock-check" size={12} color={UI.accentSoft} />
      <Text style={s.text}>{label}</Text>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  pill: {flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start',
    paddingHorizontal: 9, paddingVertical: 4, borderRadius: 999,
    backgroundColor: 'rgba(91,141,239,0.10)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.26)'},
  text: {fontFamily: UI.fSemi, fontSize: 10.5, letterSpacing: 0.2, color: UI.accentSoft},
}));
