/**
 * EmptyState (Step 18 / B3) — a calm, honest empty/placeholder block: icon + title + body +
 * optional CTA. Used for empty feeds, "no active mission", the NO_PROVIDER fallback, etc.
 * Scale-aware.
 */
import React from 'react';
import {View, Text, StyleSheet, TouchableOpacity} from 'react-native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {UI} from './tokens';
import {scaleTextStyles} from '@utils/scaling';

interface Props {
  icon: string;
  title: string;
  body?: string;
  ctaLabel?: string;
  onCta?: () => void;
  tint?: string;
}

export default function EmptyState({icon, title, body, ctaLabel, onCta, tint = UI.accentSoft}: Props) {
  return (
    <View style={s.wrap}>
      <View style={[s.iconWrap, {backgroundColor: `${tint}14`}]}>
        <Icon name={icon as never} size={34} color={tint} />
      </View>
      <Text style={s.title}>{title}</Text>
      {!!body && <Text style={s.body}>{body}</Text>}
      {!!ctaLabel && !!onCta && (
        <TouchableOpacity activeOpacity={0.85} onPress={onCta} style={s.cta}>
          <Text style={s.ctaText}>{ctaLabel}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  wrap: {alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, paddingVertical: 28, gap: 11},
  iconWrap: {width: 78, height: 78, borderRadius: 24, alignItems: 'center', justifyContent: 'center', marginBottom: 2},
  title: {fontFamily: UI.fBold, fontSize: 18, color: UI.text, letterSpacing: -0.2, textAlign: 'center'},
  body: {fontFamily: UI.fSans, fontSize: 13.5, lineHeight: 20, color: UI.textDim, textAlign: 'center'},
  cta: {marginTop: 6, height: 48, paddingHorizontal: 26, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
    backgroundColor: UI.accent, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)'},
  ctaText: {fontFamily: UI.fBold, fontSize: 14.5, color: '#fff', letterSpacing: 0.3},
}));
