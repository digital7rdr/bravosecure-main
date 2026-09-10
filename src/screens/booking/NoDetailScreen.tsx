/**
 * NoDetailScreen (BUILD_RUNBOOK Step 19) — the NO_PROVIDER dead-end, rendered as a CALM
 * safety fallback (NOT a red error): nobody could take the detail right now, the client was
 * never charged, and they're given real options — call the safety hotline, escalate, or try
 * again. Reads the server `no_provider_fallback` block (Step 16) + uses POST /escalate. The
 * client may be a threatened person, so SOS stays one tap away. Obsidian + cobalt.
 */
import React, {useCallback, useEffect, useState} from 'react';
import {View, Text, StyleSheet, TouchableOpacity, StatusBar, Linking, ScrollView} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useBottomInset} from '@hooks/useBottomInset';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import type {BookingStackParamList} from '@navigation/types';
import {bookingApi} from '@services/api';
import {UI} from '@components/ui/tokens';
import {scaleTextStyles} from '@utils/scaling';
import {recordEmergencyCall} from '@store/emergencyCallLog';

type Nav = NativeStackNavigationProp<BookingStackParamList>;
type Fallback = {hotline_e164: string; can_widen: boolean; can_escalate: boolean};

export default function NoDetailScreen() {
  const insets = useSafeAreaInsets();
  const {bottomPad} = useBottomInset();
  const navigation = useNavigation<Nav>();
  const {bookingId} = useRoute<RouteProp<BookingStackParamList, 'NoDetail'>>().params;
  const [fallback, setFallback] = useState<Fallback | null>(null);
  const [escalated, setEscalated] = useState(false);

  useEffect(() => {
    let alive = true;
    void bookingApi.getById(bookingId)
      .then(({data}) => { if (alive) {setFallback((data as {no_provider_fallback?: Fallback}).no_provider_fallback ?? null);} })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [bookingId]);

  const callHotline = useCallback(() => {
    const num = fallback?.hotline_e164;
    if (!num) { Alert.alert('Hotline unavailable', 'No safety hotline is configured. Use SOS for an emergency.'); return; }
    // PDF item 08. Sanitised here for the first time — this site used to hand
    // the raw stored value straight to the dialler, so the log would otherwise
    // record a different string from the one dialled.
    const sanitised = num.replace(/[^\d+]/g, '');
    recordEmergencyCall({sanitised, label: 'Safety hotline', source: 'quick-dial'});
    void Linking.openURL(`tel:${sanitised}`);
  }, [fallback]);

  const escalate = useCallback(async () => {
    try {
      const {data} = await bookingApi.escalate(bookingId);
      setEscalated(true);
      Alert.alert('Escalated', data?.hotline_e164
        ? `Our team has been notified. For an immediate need, call ${data.hotline_e164}.`
        : 'Our team has been notified and will reach out.');
    } catch (e: unknown) {
      Alert.alert('Could not escalate', (e as Error).message ?? 'Try again.');
    }
  }, [bookingId]);

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={UI.bg} />
      <TouchableOpacity style={[s.sosBtn, {top: insets.top + 10}]} activeOpacity={0.8}
        hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
        accessibilityRole="button" accessibilityLabel="Send SOS emergency alert"
        onPress={() => navigation.navigate('SOSScreen', {bookingId})}>
        <Icon name="alarm-light" size={18} color="#fff" />
        <Text style={s.sosText}>SOS</Text>
      </TouchableOpacity>

      <ScrollView style={{flex: 1}} contentContainerStyle={{flexGrow: 1, justifyContent: 'center'}}>
        <View style={s.center}>
          <View style={s.iconWrap}><Icon name="account-search-outline" size={40} color={UI.amber} /></View>
          <Text style={s.title}>No detail available right now</Text>
          <Text style={s.sub}>
            We couldn’t reach an available agency for your request. This can happen at busy
            times or outside coverage hours.
          </Text>
          <View style={s.assure}>
            <Icon name="shield-check" size={15} color={UI.signal} />
            <Text style={s.assureText}>You were not charged.</Text>
          </View>
        </View>
      </ScrollView>

      <View style={[s.footer, {paddingBottom: bottomPad(16)}]}>
        {(fallback?.can_escalate ?? true) && (
          <TouchableOpacity style={[s.primaryBtn, escalated && {opacity: 0.6}]} activeOpacity={0.85}
            accessibilityRole="button" accessibilityState={{disabled: escalated}}
            accessibilityLabel={escalated ? 'Escalated' : 'Escalate to our team'}
            disabled={escalated} onPress={() => void escalate()}>
            <Icon name="lifebuoy" size={18} color="#fff" />
            <Text style={s.primaryText} numberOfLines={1} ellipsizeMode="tail">{escalated ? 'Escalated' : 'Escalate to our team'}</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity style={s.secondaryBtn} activeOpacity={0.85}
          accessibilityRole="button" accessibilityLabel="Call the safety hotline" onPress={callHotline}>
          <Icon name="phone" size={17} color={UI.accentSoft} />
          <Text style={s.secondaryText} numberOfLines={1} ellipsizeMode="tail">Call the safety hotline</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.tertiaryBtn} activeOpacity={0.85}
          accessibilityRole="button" accessibilityLabel="Try again" onPress={() => navigation.popToTop()}>
          <Text style={s.tertiaryText}>Try again</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: UI.bg},
  sosBtn: {position: 'absolute', right: 20, zIndex: 10, flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 13, paddingVertical: 8, borderRadius: 999, backgroundColor: UI.alert},
  sosText: {fontFamily: UI.fBold, fontSize: 12, letterSpacing: 0.5, color: '#fff'},
  center: {alignItems: 'center', justifyContent: 'center', paddingHorizontal: 34, gap: 13},
  iconWrap: {width: 88, height: 88, borderRadius: 28, alignItems: 'center', justifyContent: 'center', marginBottom: 4,
    backgroundColor: 'rgba(245,199,107,0.10)', borderWidth: 1, borderColor: 'rgba(245,199,107,0.30)'},
  title: {fontFamily: UI.fBold, fontSize: 21, color: UI.text, letterSpacing: -0.2, textAlign: 'center'},
  sub: {fontFamily: UI.fSans, fontSize: 14, lineHeight: 21, color: UI.textDim, textAlign: 'center'},
  assure: {flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 4, paddingHorizontal: 13, paddingVertical: 8,
    borderRadius: 999, backgroundColor: 'rgba(74,222,128,0.08)', borderWidth: 1, borderColor: 'rgba(74,222,128,0.22)'},
  assureText: {fontFamily: UI.fSemi, fontSize: 12, color: UI.signal},
  footer: {paddingHorizontal: 22, gap: 11},
  primaryBtn: {flexDirection: 'row', gap: 8, height: 52, borderRadius: 15, alignItems: 'center', justifyContent: 'center',
    backgroundColor: UI.accent, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)'},
  primaryText: {fontFamily: UI.fBold, fontSize: 15, color: '#fff', letterSpacing: 0.3},
  secondaryBtn: {flexDirection: 'row', gap: 8, height: 50, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.10)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.28)'},
  secondaryText: {fontFamily: UI.fBold, fontSize: 14.5, color: UI.accentSoft},
  tertiaryBtn: {height: 46, alignItems: 'center', justifyContent: 'center'},
  tertiaryText: {fontFamily: UI.fSemi, fontSize: 14, color: UI.textMute},
}));
