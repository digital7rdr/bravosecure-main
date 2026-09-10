/**
 * AgencyAcceptedScreen (BUILD_RUNBOOK Step 19) — the "an agency accepted your detail" reveal.
 * Fetches the coarse provider (GET /bookings/:id/provider): name + call-sign + ★rating +
 * missions completed, shown with the shared TrustBadgeRow, then the MissionStepper at step 2
 * ("Accepted · assigning team", D7 — the agency now picks crew). Continue → BookingConfirmation.
 * SOS stays reachable. No precise location is shown (LB1 — that's agency-only post-accept).
 */
import React, {useCallback, useEffect, useState} from 'react';
import {View, Text, StyleSheet, TouchableOpacity, StatusBar, ActivityIndicator, BackHandler} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useBottomInset} from '@hooks/useBottomInset';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import type {BookingStackParamList} from '@navigation/types';
import {bookingApi} from '@services/api';
import MissionStepper from '@components/mission/MissionStepper';
import TrustBadgeRow from '@components/ui/TrustBadgeRow';
import {UI} from '@components/ui/tokens';
import {scaleTextStyles} from '@utils/scaling';

type Nav = NativeStackNavigationProp<BookingStackParamList>;
interface Provider {display_name: string | null; call_sign: string | null; rating: number | null; jobs_total: number}

export default function AgencyAcceptedScreen() {
  const insets = useSafeAreaInsets();
  const {bottomPad} = useBottomInset();
  const navigation = useNavigation<Nav>();
  const {bookingId} = useRoute<RouteProp<BookingStackParamList, 'AgencyAccepted'>>().params;
  const [provider, setProvider] = useState<Provider | null>(null);
  const [loading, setLoading] = useState(true);
  // LM-U2 — crew-assign SLA is 15 min server-side; past it, tell the client the
  // agency is slow instead of an unexplained forever-wait.
  const [longWait, setLongWait] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  // BB-9 (2026-08-15 back audit) — same stale-wizard hazard as
  // BookingConfirmation: back from an ACCEPTED booking landed on a live
  // "Confirm Booking" step for that same booking. Back leaves the flow.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      try { navigation.popToTop(); } catch { /* already at root */ }
      return true;
    });
    return () => sub.remove();
  }, [navigation]);

  useEffect(() => {
    let alive = true;
    void bookingApi.getProvider(bookingId)
      .then(({data}) => { if (alive) {setProvider(data);} })
      .catch(() => undefined)
      .finally(() => { if (alive) {setLoading(false);} });
    return () => { alive = false; };
  }, [bookingId]);

  // Auto-advance to live tracking the moment the agency crews the mission — a mission_status
  // appears on GET /bookings/:id (DISPATCHED) — so the client watches the live 6-step bar
  // (team dispatched → en route → protection active → completed) instead of being parked on
  // "assigning team". The manual Continue below stays for reviewing the booking first.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const startedAt = Date.now();
    const tick = async () => {
      try {
        const {data} = await bookingApi.getById(bookingId);
        if (!alive) {return;}
        const ms = (data?.mission_status ?? '').toUpperCase();
        const bs = (data?.status ?? '').toUpperCase();
        if (ms || bs === 'LIVE' || bs === 'COMPLETED') {
          navigation.replace('LiveTracking', {bookingId});
          return;
        }
        if (bs === 'CANCELLED' || bs === 'AGENCY_NO_SHOW') { navigation.popToTop(); return; }
        // JOB_PORTAL_MARKETPLACE_SPEC §3 — the agency WITHDREW pre-crew: the booking
        // relisted to DISPATCHING (client keeps the hold, never re-charged). Without
        // this branch the client stays parked on "agency accepted" forever; route
        // back to the searching screen, same as a re-dispatch.
        if (bs === 'DISPATCHING' || bs === 'NO_PROVIDER') {
          navigation.replace(bs === 'DISPATCHING' ? 'FindingDetail' : 'NoDetail', {bookingId});
          return;
        }
      } catch { /* transient — retry next tick */ }
      // LM-U2 — surface the "agency is slow" copy past the crew-assign SLA. The
      // server's crew-SLA watchdog will refund + terminate at its own deadline;
      // this just keeps the client informed (and the cancel is right below).
      if (alive && Date.now() - startedAt > 15 * 60_000) {setLongWait(true);}
      if (alive) {timer = setTimeout(() => { void tick(); }, 5_000);}
    };
    timer = setTimeout(() => { void tick(); }, 5_000);
    return () => { alive = false; if (timer) {clearTimeout(timer);} };
  }, [bookingId, navigation]);

  // LM-U2 — this screen had NO cancel affordance: an agency that accepted but
  // never crewed left the client parked here with only SOS and Continue.
  const onCancel = useCallback(() => {
    Alert.alert('Cancel booking?', 'The agency has accepted but not yet assigned a team. Cancelling now refunds you in full.', [
      {text: 'Keep waiting', style: 'cancel'},
      {text: 'Cancel booking', style: 'destructive', onPress: () => {
        setCancelling(true);
        bookingApi.cancel(bookingId)
          .then(() => navigation.popToTop())
          .catch((e: unknown) => {
            setCancelling(false);
            Alert.alert('Could not cancel', (e as Error).message ?? 'Try again.');
          });
      }},
    ]);
  }, [bookingId, navigation]);

  const name = provider?.display_name?.trim() || (provider?.call_sign ? `Unit ${provider.call_sign}` : 'Your detail');

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={UI.bg} />
      <TouchableOpacity style={[s.sosBtn, {top: insets.top + 10}]} activeOpacity={0.8}
        hitSlop={{top: 8, bottom: 8, left: 8, right: 8}} accessibilityRole="button" accessibilityLabel="SOS, open emergency"
        onPress={() => navigation.navigate('SOSScreen', {bookingId})}>
        <Icon name="alarm-light" size={18} color="#fff" />
        <Text style={s.sosText}>SOS</Text>
      </TouchableOpacity>

      <View style={s.center}>
        <View style={s.tick} importantForAccessibility="no" accessibilityElementsHidden><Icon name="check-decagram" size={40} color={UI.signal} /></View>
        <Text style={s.kicker}>AGENCY ACCEPTED</Text>
        <Text style={s.title} numberOfLines={2} ellipsizeMode="tail">{name}</Text>
        {provider?.call_sign && <Text style={s.callSign}>{provider.call_sign}</Text>}

        <View style={s.trustWrap}>
          {loading
            ? <ActivityIndicator color={UI.accent} />
            : <TrustBadgeRow rating={provider?.rating ?? undefined} jobsTotal={provider?.jobs_total ?? undefined} verified />}
        </View>

        <Text style={s.note} accessibilityLiveRegion="polite">
          {longWait
            ? 'The agency is taking longer than usual to assign your team. You can keep waiting or cancel for a full refund.'
            : 'Your detail is being assigned. You’ll see the team the moment it’s crewed.'}
        </Text>
      </View>

      <View style={[s.footer, {paddingBottom: bottomPad(16)}]}>
        <View style={s.stepperWrap}>
          <MissionStepper booking={{status: 'CONFIRMED'}} mission={undefined} />
        </View>
        <TouchableOpacity style={s.continueBtn} activeOpacity={0.85}
          onPress={() => navigation.replace('BookingConfirmation', {bookingId})}>
          <Text style={s.continueText}>Continue</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.cancelBtn} activeOpacity={0.85} disabled={cancelling} onPress={onCancel}>
          <Text style={s.cancelText}>{cancelling ? 'Cancelling…' : 'Cancel booking'}</Text>
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
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 34, gap: 8},
  tick: {width: 88, height: 88, borderRadius: 28, alignItems: 'center', justifyContent: 'center', marginBottom: 8,
    backgroundColor: 'rgba(74,222,128,0.10)', borderWidth: 1, borderColor: 'rgba(74,222,128,0.30)'},
  kicker: {fontFamily: UI.fSemi, fontSize: 10, letterSpacing: 2, color: UI.textMute},
  title: {fontFamily: UI.fBold, fontSize: 24, color: UI.text, letterSpacing: -0.4, textAlign: 'center', marginTop: 2},
  callSign: {fontFamily: UI.fSemi, fontSize: 13, color: UI.accentSoft, letterSpacing: 1, marginTop: 1},
  trustWrap: {marginTop: 12, minHeight: 26, alignItems: 'center', justifyContent: 'center'},
  note: {fontFamily: UI.fSans, fontSize: 13.5, lineHeight: 20, color: UI.textDim, textAlign: 'center', marginTop: 14},
  footer: {paddingHorizontal: 22, gap: 16},
  stepperWrap: {paddingHorizontal: 4},
  continueBtn: {height: 52, borderRadius: 15, alignItems: 'center', justifyContent: 'center',
    backgroundColor: UI.accent, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)'},
  continueText: {fontFamily: UI.fBold, fontSize: 15, color: '#fff', letterSpacing: 0.3},
  cancelBtn: {height: 46, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: UI.hair},
  cancelText: {fontFamily: UI.fBold, fontSize: 14, color: UI.textDim, letterSpacing: 0.2},
}));
