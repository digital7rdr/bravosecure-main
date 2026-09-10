/**
 * PermissionPrimer (Step 18 / B3) — a soft pre-permission card (icon + title + body + Allow)
 * shown before the OS prompt, so the user understands WHY a permission is needed. Reused by
 * the CPO activation flow and any screen that gates on location / notifications. Scale-aware.
 */
import React from 'react';
import {View, Text, StyleSheet, TouchableOpacity} from 'react-native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {UI} from './tokens';
import {scaleTextStyles} from '@utils/scaling';

interface Props {
  icon: string;
  title: string;
  body: string;
  granted?: boolean;
  required?: boolean;
  onAllow: () => void;
}

export default function PermissionPrimer({icon, title, body, granted, required, onAllow}: Props) {
  return (
    <View style={[s.card, granted && s.cardOn]}>
      <View style={[s.iconWrap, granted && {backgroundColor: 'rgba(74,222,128,0.12)'}]}>
        <Icon name={icon as never} size={18} color={granted ? UI.signal : UI.accentSoft} />
      </View>
      <View style={{flex: 1}}>
        <View style={s.titleRow}>
          <Text style={s.title}>{title}</Text>
          {required && !granted && <Text style={s.req}>REQUIRED</Text>}
        </View>
        <Text style={s.body}>{body}</Text>
      </View>
      {granted ? (
        <Icon name="check-circle" size={22} color={UI.signal} />
      ) : (
        <TouchableOpacity style={s.allow} onPress={onAllow} activeOpacity={0.8}>
          <Text style={s.allowText}>Allow</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  card: {flexDirection: 'row', gap: 12, alignItems: 'center', padding: 14, borderRadius: 16,
    backgroundColor: UI.surface, borderWidth: 1, borderColor: UI.hair},
  cardOn: {borderColor: 'rgba(74,222,128,0.30)', backgroundColor: 'rgba(74,222,128,0.05)'},
  iconWrap: {width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.10)'},
  titleRow: {flexDirection: 'row', alignItems: 'center', gap: 7},
  title: {fontFamily: UI.fBold, fontSize: 14.5, color: UI.text},
  req: {fontFamily: UI.fBold, fontSize: 8, letterSpacing: 0.8, color: UI.alert,
    paddingHorizontal: 5, paddingVertical: 2, borderRadius: 4,
    backgroundColor: 'rgba(255,93,93,0.14)', borderWidth: 1, borderColor: 'rgba(255,93,93,0.34)'},
  body: {fontFamily: UI.fSans, fontSize: 12.5, lineHeight: 18, color: UI.textMute, marginTop: 2},
  allow: {paddingHorizontal: 14, paddingVertical: 8, borderRadius: 11, backgroundColor: UI.accent},
  allowText: {fontFamily: UI.fBold, fontSize: 12.5, color: '#fff'},
}));
