/**
 * CountdownPill (Step 18 / B3) — live countdown to an `expiresAt` ISO timestamp, bound to
 * the server's authoritative TTL (e.g. a dispatch offer's expires_at). Ticks once a second
 * and turns to an urgent tint under 10s; renders "Expired" at zero. Text-scale-aware.
 */
import React, {useEffect, useState} from 'react';
import {View, Text, StyleSheet} from 'react-native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {UI} from './tokens';
import {scaleTextStyles} from '@utils/scaling';

function remainingSec(expiresAt: string): number {
  return Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000));
}

export default function CountdownPill({expiresAt, label}: {expiresAt: string; label?: string}) {
  const [sec, setSec] = useState(() => remainingSec(expiresAt));
  useEffect(() => {
    setSec(remainingSec(expiresAt));
    const t = setInterval(() => setSec(remainingSec(expiresAt)), 1000);
    return () => clearInterval(t);
  }, [expiresAt]);

  const expired = sec <= 0;
  const urgent = !expired && sec <= 10;
  const tint = expired ? UI.textMute : urgent ? UI.alert : UI.accentSoft;
  const mm = Math.floor(sec / 60).toString();
  const ss = (sec % 60).toString().padStart(2, '0');

  return (
    <View style={[s.pill, {borderColor: `${tint}44`, backgroundColor: `${tint}12`}]}>
      <Icon name={expired ? 'timer-off-outline' : 'timer-outline'} size={13} color={tint} />
      <Text style={[s.text, {color: tint}]}>
        {label ? `${label} ` : ''}{expired ? 'Expired' : `${mm}:${ss}`}
      </Text>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  pill: {flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start',
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, borderWidth: 1},
  text: {fontFamily: UI.fBold, fontSize: 12, letterSpacing: 0.3, fontVariant: ['tabular-nums']},
}));
