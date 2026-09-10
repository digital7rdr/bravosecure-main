/**
 * The mission-start readiness gate (founder 2026-08-11).
 *
 * Shown to whichever side is not device-ready. It names the EXACT missing
 * requirement rather than a generic "permissions needed", offers Settings, and
 * re-checks by itself when the app returns to the foreground — the user never
 * has to restart. When this side is ready but the other is not, it stops asking
 * for anything and simply says who is being waited on (edge cases 3, 4, 11).
 */
import React from 'react';
import {View, Text, StyleSheet, TouchableOpacity, ActivityIndicator} from 'react-native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {
  requirementLabel, requirementHint, blockedByText,
  type ReadinessRequirement,
} from '@utils/protectionReadiness';

const D = {
  text:     '#F2F4F8',
  textDim:  'rgba(229,233,242,0.62)',
  textMute: 'rgba(180,188,204,0.45)',
  hair:     'rgba(255,255,255,0.09)',
  accent:   '#5B8DEF',
  accentSoft: '#A9C5FF',
  warn:     '#F5A524',
  fSans: 'Manrope_500Medium',
  fSemi: 'Manrope_600SemiBold',
  fBold: 'Manrope_700Bold',
};

export interface ReadinessGateProps {
  /** 'customer' → "Protection Setup Required"; 'cpo' → "Mission Not Ready". */
  role: 'customer' | 'cpo';
  missing: ReadinessRequirement[];
  checking: boolean;
  /** Server's verdict on BOTH sides — drives the "waiting for them" state. */
  blockedBy: string[];
  onOpenSettings: () => void;
  onRecheck: () => void;
}

export default function ReadinessGate({
  role, missing, checking, blockedBy, onOpenSettings, onRecheck,
}: ReadinessGateProps) {
  const mine = role === 'customer' ? 'customer' : 'cpo';
  const iAmBlocking = missing.length > 0 || blockedBy.includes(mine);
  const otherSide = blockedBy.filter(b => b !== mine);

  // This device is fine; the mission is simply waiting on the other participant.
  if (!iAmBlocking && otherSide.length > 0) {
    return (
      <View style={s.wrap}>
        <View style={[s.badge, {borderColor: 'rgba(91,141,239,0.35)'}]}>
          <ActivityIndicator color={D.accent} />
        </View>
        <Text style={s.title}>Almost ready</Text>
        <Text style={s.sub}>{blockedByText(otherSide)}</Text>
        <Text style={s.note}>You are all set — nothing else to do on this device.</Text>
      </View>
    );
  }

  return (
    <View style={s.wrap}>
      <View style={s.badge}>
        <Icon name="shield-alert-outline" size={26} color={D.warn} />
      </View>
      <Text style={s.title}>
        {role === 'customer' ? 'Protection Setup Required' : 'Mission Not Ready'}
      </Text>
      <Text style={s.sub}>
        {role === 'customer'
          ? 'Please enable the required permissions so your CPO can provide protection.'
          : 'Please enable the required permissions before starting this mission.'}
      </Text>

      <View style={s.list}>
        {missing.map(r => (
          <View key={r} style={s.row}>
            <Icon name="close-circle-outline" size={16} color={D.warn} />
            <View style={{flex: 1, minWidth: 0}}>
              <Text style={s.rowLabel}>{requirementLabel(r)}</Text>
              <Text style={s.rowHint}>{requirementHint(r)}</Text>
            </View>
          </View>
        ))}
      </View>

      <TouchableOpacity
        onPress={onOpenSettings}
        style={s.primary}
        activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityLabel="Open Settings">
        <Text style={s.primaryText}>Open Settings</Text>
      </TouchableOpacity>

      <TouchableOpacity
        onPress={onRecheck}
        disabled={checking}
        style={s.secondary}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel="Check again"
        accessibilityState={{disabled: checking}}>
        {checking
          ? <ActivityIndicator color={D.accentSoft} size="small" />
          : <Text style={s.secondaryText}>Check again</Text>}
      </TouchableOpacity>

      <Text style={s.note}>We re-check automatically when you come back.</Text>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {alignItems: 'center', paddingHorizontal: 26, paddingVertical: 28},
  badge: {
    width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(245,165,36,0.35)', backgroundColor: 'rgba(245,165,36,0.08)',
  },
  title: {color: D.text, fontFamily: D.fBold, fontSize: 19, textAlign: 'center', marginTop: 14},
  sub: {color: D.textDim, fontFamily: D.fSans, fontSize: 13, lineHeight: 19, textAlign: 'center', marginTop: 8},
  list: {alignSelf: 'stretch', marginTop: 18, gap: 12},
  row: {flexDirection: 'row', alignItems: 'flex-start', gap: 10},
  rowLabel: {color: D.text, fontFamily: D.fSemi, fontSize: 13.5},
  rowHint: {color: D.textMute, fontFamily: D.fSans, fontSize: 11.5, lineHeight: 16, marginTop: 2},
  primary: {
    alignSelf: 'stretch', marginTop: 22, paddingVertical: 13, borderRadius: 14,
    backgroundColor: D.accent, alignItems: 'center',
  },
  primaryText: {color: '#FFFFFF', fontFamily: D.fSemi, fontSize: 14},
  secondary: {
    alignSelf: 'stretch', marginTop: 10, paddingVertical: 12, borderRadius: 14,
    borderWidth: 1, borderColor: D.hair, alignItems: 'center', minHeight: 44, justifyContent: 'center',
  },
  secondaryText: {color: D.accentSoft, fontFamily: D.fSemi, fontSize: 13},
  note: {color: D.textMute, fontFamily: D.fSans, fontSize: 11, textAlign: 'center', marginTop: 14},
});
