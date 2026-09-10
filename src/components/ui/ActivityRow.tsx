/**
 * ActivityRow (Step 18 / B3) — one durable row in the ActivityCenter feed: a tinted icon,
 * a title + subtitle, a relative timestamp, an unread dot, and (for an actionable offer) a
 * live CountdownPill bound to expires_at. Renders ONLY non-sensitive metadata — no message
 * body, no key material (honours the no-plaintext rule). Scale-aware; pressable.
 */
import React from 'react';
import {View, Text, StyleSheet, TouchableOpacity} from 'react-native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import CountdownPill from './CountdownPill';
import {UI} from './tokens';
import {scaleTextStyles} from '@utils/scaling';

interface Props {
  icon: string;
  tint?: string;
  title: string;
  subtitle?: string;
  timeLabel?: string;
  unread?: boolean;
  expiresAt?: string;
  onPress?: () => void;
}

export default function ActivityRow({icon, tint = UI.accentSoft, title, subtitle, timeLabel, unread, expiresAt, onPress}: Props) {
  return (
    <TouchableOpacity activeOpacity={onPress ? 0.7 : 1} disabled={!onPress} onPress={onPress}
      style={[s.row, unread && s.rowUnread]}>
      <View style={[s.iconWrap, {backgroundColor: `${tint}14`}]}>
        <Icon name={icon as never} size={18} color={tint} />
      </View>
      <View style={{flex: 1, minWidth: 0}}>
        <View style={s.titleRow}>
          <Text style={s.title} numberOfLines={1}>{title}</Text>
          {!!timeLabel && <Text style={s.time}>{timeLabel}</Text>}
        </View>
        {!!subtitle && <Text style={s.subtitle} numberOfLines={2}>{subtitle}</Text>}
        {!!expiresAt && <View style={{marginTop: 6}}><CountdownPill expiresAt={expiresAt} label="Expires in" /></View>}
      </View>
      {unread && <View style={s.dot} />}
    </TouchableOpacity>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  row: {flexDirection: 'row', gap: 12, alignItems: 'flex-start', padding: 13, borderRadius: 14,
    backgroundColor: UI.surface, borderWidth: 1, borderColor: UI.hair},
  rowUnread: {borderColor: 'rgba(91,141,239,0.30)', backgroundColor: 'rgba(91,141,239,0.05)'},
  iconWrap: {width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center'},
  titleRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8},
  title: {flex: 1, fontFamily: UI.fBold, fontSize: 14, color: UI.text},
  time: {fontFamily: UI.fSans, fontSize: 11, color: UI.textMute},
  subtitle: {fontFamily: UI.fSans, fontSize: 12.5, lineHeight: 18, color: UI.textDim, marginTop: 2},
  dot: {width: 8, height: 8, borderRadius: 4, backgroundColor: UI.accent, marginTop: 6},
}));
