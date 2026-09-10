/**
 * FindingDetailScreen (BUILD_RUNBOOK Step 19) — the auto-dispatch "Searching for your
 * detail…" state (booking DISPATCHING). Polls GET /bookings/:id every 5s (5-min hard cap)
 * and routes on the status flip: CONFIRMED → AgencyAccepted, NO_PROVIDER → NoDetail,
 * CANCELLED → home. Trust line makes the charge model honest ("you won't be charged until a
 * detail accepts" — escrow opens on accept, D2). SOS is one tap away throughout (LB13).
 * Obsidian + cobalt, matching the shared component library.
 */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {View, Text, StyleSheet, TouchableOpacity, StatusBar, Animated, Easing} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useBottomInset} from '@hooks/useBottomInset';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import type {BookingStackParamList} from '@navigation/types';
import {bookingApi} from '@services/api';
import MissionStepper from '@components/mission/MissionStepper';
import {UI} from '@components/ui/tokens';
import {scaleTextStyles} from '@utils/scaling';

type Nav = NativeStackNavigationProp<BookingStackParamList>;
const POLL_MS = 5_000;
// LM-U1 — after the 5-min cap the poll used to STOP entirely, so an accept at
// minute 6 left the client on a dead spinner forever. Now the cap only surfaces
// the "taking longer" copy and the poll continues at a slower cadence.
const SLOW_POLL_MS = 15_000;
const HARD_CAP_MS = 5 * 60_000;

export default function FindingDetailScreen() {
  const insets = useSafeAreaInsets();
  const {bottomPad} = useBottomInset();
  const navigation = useNavigation<Nav>();
  const {bookingId} = useRoute<RouteProp<BookingStackParamList, 'FindingDetail'>>().params;
  const [gaveUp, setGaveUp] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const pulse = useRef(new Animated.Value(0)).current;

  // Radar pulse.
  useEffect(() => {
    const anim = Animated.loop(Animated.timing(pulse, {toValue: 1, duration: 1800, easing: Easing.out(Easing.ease), useNativeDriver: true}));
    anim.start();
    return () => anim.stop();
  }, [pulse]);

  // Status poll → route on terminal flips. Self-contained (polls getById into no state;
  // we only branch on status). 5-min cap then surface a "taking longer" affordance.
  useEffect(() => {
    if (!bookingId) {return undefined;}
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const startedAt = Date.now();
    const tick = async () => {
      let status = '';
      try {
        const {data} = await bookingApi.getById(bookingId);
        status = (data?.status ?? '').toString().toUpperCase();
      } catch { /* transient — retry next tick */ }
      if (cancelled) {return;}
      if (status === 'CONFIRMED') { navigation.replace('AgencyAccepted', {bookingId}); return; }
      if (status === 'NO_PROVIDER') { navigation.replace('NoDetail', {bookingId}); return; }
      if (status === 'CANCELLED') { navigation.popToTop(); return; }
      const overCap = Date.now() - startedAt > HARD_CAP_MS;
      if (overCap) { setGaveUp(true); }
      timer = setTimeout(() => { void tick(); }, overCap ? SLOW_POLL_MS : POLL_MS);
    };
    void tick();
    return () => { cancelled = true; if (timer) {clearTimeout(timer);} };
  }, [bookingId, navigation]);

  const doCancel = useCallback(async () => {
    setCancelling(true);
    try {
      const {data} = await bookingApi.cancel(bookingId);
      // The search may have ended on its own (NO_PROVIDER) a beat before the tap —
      // the server answers idempotent-success with the real status; route like the
      // poll would instead of pretending we cancelled.
      if (data.already_ended && data.status === 'NO_PROVIDER') {
        navigation.replace('NoDetail', {bookingId});
        return;
      }
      navigation.popToTop();
    } catch {
      // Defensive: re-read the truth — if the booking is already terminal, route
      // instead of surfacing a raw error for a search that's over anyway.
      try {
        const {data} = await bookingApi.getById(bookingId);
        const status = (data?.status ?? '').toString().toUpperCase();
        if (status === 'NO_PROVIDER') { navigation.replace('NoDetail', {bookingId}); return; }
        if (status === 'CANCELLED') { navigation.popToTop(); return; }
      } catch { /* fall through to the alert */ }
      setCancelling(false);
      Alert.alert('Could not cancel', 'Please try again.');
    }
  }, [bookingId, navigation]);

  // QA 2026-07-10 — cancel is destructive; a stray tap on the searching screen used
  // to fire it straight away. Confirm first.
  const onCancel = useCallback(() => {
    Alert.alert('Cancel search?', 'Stop looking for a protection detail? You have not been charged.', [
      {text: 'Keep searching', style: 'cancel'},
      {text: 'Yes, cancel', style: 'destructive', onPress: () => void doCancel()},
    ]);
  }, [doCancel]);

  const ringScale = pulse.interpolate({inputRange: [0, 1], outputRange: [0.6, 1.8]});
  const ringOpacity = pulse.interpolate({inputRange: [0, 1], outputRange: [0.45, 0]});

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={UI.bg} />
      <TouchableOpacity style={[s.sosBtn, {top: insets.top + 10}]} activeOpacity={0.8}
        hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
        accessibilityRole="button" accessibilityLabel="Emergency SOS"
        onPress={() => navigation.navigate('SOSScreen', {bookingId})}>
        <Icon name="alarm-light" size={18} color="#fff" />
        <Text style={s.sosText}>SOS</Text>
      </TouchableOpacity>

      <View style={s.center}>
        <View style={s.radarWrap}>
          <Animated.View style={[s.ring, {transform: [{scale: ringScale}], opacity: ringOpacity}]} />
          <View style={s.radarCore}><Icon name="radar" size={40} color={UI.accentSoft} importantForAccessibility="no" /></View>
        </View>
        <Text style={s.title}>{gaveUp ? 'Still searching…' : 'Finding your detail'}</Text>
        <Text style={s.sub}>
          {gaveUp
            ? 'This is taking longer than usual. You can keep waiting or cancel — you have not been charged.'
            : 'We’re offering your request to the nearest available agency.'}
        </Text>
        <View style={s.trust}>
          <Icon name="shield-check" size={15} color={UI.signal} importantForAccessibility="no" />
          <Text style={s.trustText}>You won’t be charged until a detail accepts.</Text>
        </View>
      </View>

      <View style={[s.footer, {paddingBottom: bottomPad(16)}]}>
        <View style={s.stepperWrap}>
          <MissionStepper booking={{status: 'DISPATCHING'}} mission={undefined} />
        </View>
        <TouchableOpacity style={s.cancelBtn} activeOpacity={0.85} disabled={cancelling}
          accessibilityRole="button" accessibilityState={{disabled: cancelling}} onPress={onCancel}>
          <Text style={s.cancelText}>{cancelling ? 'Cancelling…' : 'Cancel search'}</Text>
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
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 34, gap: 14},
  radarWrap: {width: 120, height: 120, alignItems: 'center', justifyContent: 'center', marginBottom: 8},
  ring: {position: 'absolute', width: 96, height: 96, borderRadius: 48, borderWidth: 2, borderColor: UI.accent},
  radarCore: {width: 84, height: 84, borderRadius: 42, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.30)'},
  title: {fontFamily: UI.fBold, fontSize: 22, color: UI.text, letterSpacing: -0.3, textAlign: 'center'},
  sub: {fontFamily: UI.fSans, fontSize: 14, lineHeight: 21, color: UI.textDim, textAlign: 'center'},
  trust: {flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 4, paddingHorizontal: 13, paddingVertical: 8,
    borderRadius: 999, backgroundColor: 'rgba(74,222,128,0.08)', borderWidth: 1, borderColor: 'rgba(74,222,128,0.22)', maxWidth: '100%'},
  trustText: {fontFamily: UI.fSemi, fontSize: 12, color: UI.signal, flexShrink: 1},
  footer: {paddingHorizontal: 22, gap: 16},
  stepperWrap: {paddingHorizontal: 4},
  cancelBtn: {height: 50, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: UI.hair},
  cancelText: {fontFamily: UI.fBold, fontSize: 14.5, color: UI.textDim, letterSpacing: 0.2},
}));
