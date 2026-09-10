/**
 * IncomingOfferScreen (BUILD_RUNBOOK Step 20) — the full-screen agency interrupt for a live
 * dispatch offer. The countdown binds to the SERVER `expires_at` (offerCountdown helpers),
 * never a local 0-start timer. Shows COARSE data only (LB1: region + bucketed distance +
 * when/pay/headcount/requirements — NEVER an exact pickup/dropoff address pre-accept).
 *
 * Accept → server charges the client into escrow + flips CONFIRMED → land on the missions
 * board to crew it. Decline → cascades to the next agency. On a 400 `offer_not_available`,
 * a zeroed countdown, or the offer vanishing from getCurrentOffer → neutral "passed to
 * another detail" (no fault). Obsidian + cobalt, matching AgentDashboard.
 */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {View, Text, StyleSheet, TouchableOpacity, StatusBar, ActivityIndicator} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useBottomInset} from '@hooks/useBottomInset';
import {useFocusEffect, useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import type {AgentStackParamList} from '@navigation/types';
import {dispatchApi, type CoarseOffer} from '@services/api';
import {offerRemainingSeconds, OFFER_TTL_SECONDS} from './offerCountdown';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';
import LoadingView from '@components/LoadingView';

type Nav = NativeStackNavigationProp<AgentStackParamList>;

const D = {
  bg: '#07090D', text: '#F2F4F8', textDim: 'rgba(229,233,242,0.62)', textMute: 'rgba(180,188,204,0.45)',
  hair: 'rgba(255,255,255,0.09)', accent: '#5B8DEF', accentSoft: '#A9C5FF', signal: '#4ADE80',
  amber: '#F5C76B', alert: '#FF5D5D',
  fSans: 'Manrope_500Medium', fSemi: 'Manrope_600SemiBold', fBold: 'Manrope_700Bold',
};

function isOfferGoneError(e: unknown): boolean {
  const msg = (e as {response?: {data?: {message?: string}}})?.response?.data?.message ?? (e as Error)?.message ?? '';
  return /offer_not_available|offer_not_found|offer_state_changed/.test(String(msg));
}

export default function IncomingOfferScreen() {
  const insets = useSafeAreaInsets();
  const {bottomPad} = useBottomInset();
  const navigation = useNavigation<Nav>();
  // Issue 40 — a dispatch-offer push tap arrives with NO offer id: the server
  // wake (booking-push-bridge) carries only a bookingId. Destructuring `.params`
  // blind threw a TypeError that the ErrorBoundary rendered as "Something went
  // wrong" before the watcher's poll re-navigated with the id. So: read
  // defensively, then adopt the id from the poll below.
  const routeParams = useRoute<RouteProp<AgentStackParamList, 'IncomingOffer'>>().params ?? {};
  const [offerId, setOfferId] = useState<string | undefined>(routeParams.offerId);
  const [offer, setOffer] = useState<CoarseOffer | null>(null);
  const [phase, setPhase] = useState<'loading' | 'live' | 'busy' | 'passed'>('loading');
  const [nowMs, setNowMs] = useState(() => Date.now());
  const dismissed = useRef(false);

  // NAV-08 follow-up (critic) — the watcher re-`navigate`s to this MOUNTED
  // route with a new offerId on a cascade, which updates params rather than
  // pushing. offerId was seeded from the initial params only, so the card
  // kept exact-matching the OLD id and rendered a stale "passed" state for a
  // live offer. Adopt the new id and reset to a fresh decision.
  useEffect(() => {
    const pid = routeParams.offerId;
    if (pid && pid !== offerId) {
      dismissed.current = false;
      setOfferId(pid);
      setOffer(null);
      setPhase('loading');
    }
  }, [routeParams.offerId, offerId]);

  // 1s tick for the countdown (bound to expires_at, never a local 0-start timer).
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Poll the truth: confirm this offer is still ours + live. If it vanished or another
  // agency won it, surface the neutral "passed" state rather than a stale card.
  useEffect(() => {
    let alive = true;
    const fetchOne = async () => {
      try {
        const {data} = await dispatchApi.getCurrentOffer();
        if (!alive || dismissed.current) {return;}
        // Issue 40 — with no id yet (push tap) adopt whichever live offer this
        // provider currently holds. With an id, still require an exact match so a
        // cascade to a DIFFERENT offer can't silently swap the card mid-decision.
        // `data === null` (expired / withdrawn) falls through to 'passed', which
        // is the controlled status the flow already renders.
        if (data && (offerId === undefined || data.offer_id === offerId)) {
          if (offerId === undefined) {setOfferId(data.offer_id);}
          setOffer(data);
          setPhase(p => (p === 'busy' ? p : 'live'));
        } else {
          setPhase('passed');
        }
      } catch { /* transient — keep last known */ }
    };
    void fetchOne();
    const t = setInterval(() => { void fetchOne(); }, 3000);
    return () => { alive = false; clearInterval(t); };
  }, [offerId]);

  const remaining = offer ? offerRemainingSeconds(offer.expires_at, nowMs) : 0;
  // Countdown reaching zero (and we still think it's live) → passed.
  useEffect(() => {
    if (phase === 'live' && offer && remaining <= 0) {setPhase('passed');}
  }, [phase, offer, remaining]);

  // Auto-dismiss the terminal "passed" state after a brief beat. Without this the screen
  // stays mounted forever and the global IncomingOfferWatcher (which suppresses navigation
  // while an IncomingOffer screen is open) would SWALLOW the next cascade offer. Dismissing
  // frees the watcher to surface the new one. The manual Dismiss button still works.
  // NAV-08 (2026-08-26 audit) — useFocusEffect, and the timer only runs while
  // FOCUSED. The plain-useEffect version fired once from a buried screen; the
  // first correction (skip when blurred) then never re-armed, parking the
  // screen on 'passed' forever — which re-created the watcher-swallow this
  // auto-dismiss exists to prevent. Focus-scoped, it re-arms on every return
  // and can never dispatch a GO_BACK from a blurred route (the B-261
  // stale-source mechanism, from a timer instead of a tap).
  useFocusEffect(useCallback(() => {
    if (phase !== 'passed') {return undefined;}
    const t = setTimeout(() => {
      if (!dismissed.current) { dismissed.current = true; navigation.goBack(); }
    }, 2800);
    return () => clearTimeout(t);
  }, [phase, navigation]));

  const accept = useCallback(async () => {
    // Issue 40 — the render already gates the CTAs behind `!offer`, so this is a
    // belt-and-braces guard: never post an undefined id (a 400 that would read
    // to the user as a server fault).
    if (!offerId) {return;}
    setPhase('busy');
    try {
      await dispatchApi.accept(offerId);
      dismissed.current = true;
      // Land on the missions board — the booking now sits under "Needs crew" to be crewed.
      navigation.replace('OrgMissions');
    } catch (e: unknown) {
      if (isOfferGoneError(e)) { setPhase('passed'); return; }
      // A lost-200 may have already won (accept is idempotency-keyed). Freeze the poll
      // (dismissed) so it can't flip the card to "passed" under the dialog, then let the
      // user re-fetch truth on the missions board.
      dismissed.current = true;
      setPhase('live');
      Alert.alert('Could not confirm', 'We couldn’t confirm the accept. Check the missions board — if it’s there, it’s yours.',
        [{text: 'Go to missions', onPress: () => navigation.replace('OrgMissions')},
         {text: 'Stay', style: 'cancel', onPress: () => { dismissed.current = false; }}]);
    }
  }, [offerId, navigation]);

  const declineWith = useCallback(async (reason?: string) => {
    if (!offerId) {return;}
    setPhase('busy');
    try {
      await dispatchApi.reject(offerId, reason);
      dismissed.current = true;
      navigation.goBack();
    } catch {
      // A FAILED reject leaves the offer live + assigned to us until its TTL (it does NOT
      // cascade). Stay so the user can retry; the watcher re-surfaces an unresolved live
      // offer after a short snooze (LM-A2).
      setPhase('live');
      Alert.alert('Could not decline', 'Check your connection and try again.');
    }
  }, [offerId, navigation]);

  // LM-A3 — capture WHY the fleet passed (the API always supported a reason; the UI
  // never asked). Feeds dispatch analytics + the NO_PROVIDER exclusion counters.
  const decline = useCallback(() => {
    Alert.alert('Decline offer', 'Why are you passing? (optional)', [
      {text: 'No guards free', onPress: () => void declineWith('no_capacity')},
      {text: 'Requirements unmet', onPress: () => void declineWith('requirements_unmet')},
      {text: 'Too far / region', onPress: () => void declineWith('distance')},
      {text: 'Just decline', style: 'destructive', onPress: () => void declineWith()},
      {text: 'Keep offer', style: 'cancel'},
    ]);
  }, [declineWith]);

  // ── Passed state ──
  if (phase === 'passed') {
    return (
      <View style={[s.root, {paddingTop: insets.top}]}>
        <StatusBar barStyle="light-content" backgroundColor={D.bg} />
        <View style={s.center}>
          <View style={[s.ring, {borderColor: D.hair}]}><Icon name="arrow-right-top" size={40} color={D.textMute} /></View>
          <Text style={s.title}>Passed to another detail</Text>
          <Text style={s.sub}>This job was taken or expired. We’ll surface the next one.</Text>
        </View>
        <View style={[s.footer, {paddingBottom: bottomPad(16)}]}>
          <TouchableOpacity style={s.secondaryBtn} activeOpacity={0.85} onPress={() => goBackOnce(navigation)}>
            <Text style={s.secondaryText}>Dismiss</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  if (phase === 'loading' || !offer) {
    return (
      <View style={[s.root, {paddingTop: insets.top}]}>
        <StatusBar barStyle="light-content" backgroundColor={D.bg} />
        <View style={s.center}><LoadingView label="Loading offer…" /></View>
      </View>
    );
  }

  const ringTint = remaining <= 5 ? D.alert : remaining <= 15 ? D.amber : D.accent;
  const reqChips: string[] = [];
  if (offer.requirements?.armed) {reqChips.push('Armed');}
  if (offer.requirements?.driver_only) {reqChips.push('Driver only');}
  (offer.requirements?.add_ons ?? []).forEach(a => reqChips.push(a));

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={D.bg} />
      <View style={s.headerRow}>
        <View style={s.accentBar} />
        <Text style={s.kicker}>INCOMING DETAIL</Text>
      </View>

      <View style={s.center}>
        <View style={[s.ring, {borderColor: ringTint}]}>
          <Text style={[s.ringNum, {color: ringTint}]}>{remaining}</Text>
          <Text style={s.ringUnit}>sec</Text>
        </View>
        <View style={s.track}>
          <View style={[s.trackFill, {width: `${(remaining / OFFER_TTL_SECONDS) * 100}%`, backgroundColor: ringTint}]} />
        </View>

        <Text style={s.region}>{offer.region_label}</Text>
        <Text style={s.service}>
          {offer.service.replace(/_/g, ' ')}
        </Text>

        <View style={s.grid}>
          <Stat icon="map-marker-distance" label="Distance" value={offer.distance_bucket} />
          <Stat icon="clock-outline" label="Pickup" value={`${new Date(offer.pickup_time).toLocaleString('en-GB', {hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric', timeZone: 'UTC'})}Z`} />
          <Stat icon="timer-sand" label="Duration" value={`${offer.duration_hours}h`} />
          <Stat icon="account-group" label="Guards" value={`${offer.cpo_count} needed`} />
          <Stat icon="cash" label="Pay" value={offer.price?.eur !== undefined && offer.price?.eur !== null ? `${Math.round(Number(offer.price.eur)).toLocaleString()} BC` : '—'} />
          {offer.vehicle_count > 0 && <Stat icon="car" label="Vehicles" value={`${offer.vehicle_count}`} />}
          {offer.service === 'executive_protection' && (
            <Stat
              icon="shield-crown"
              label="Task"
              value={(offer.task_type ?? 'site protection').replace(/_/g, ' ')}
            />
          )}
          {offer.service === 'executive_protection' && offer.has_transport && (
            <Stat icon="car-estate" label="Transfer" value="Included" />
          )}
        </View>

        {reqChips.length > 0 && (
          <View style={s.chips}>
            {reqChips.map(c => <View key={c} style={s.chip}><Text style={s.chipText}>{c}</Text></View>)}
          </View>
        )}
      </View>

      <View style={[s.footer, {paddingBottom: bottomPad(16)}]}>
        <TouchableOpacity style={s.declineBtn} activeOpacity={0.85} disabled={phase === 'busy'} onPress={decline}>
          <Text style={s.declineText}>Decline</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.acceptBtn, phase === 'busy' && {opacity: 0.6}]} activeOpacity={0.85} disabled={phase === 'busy'} onPress={() => void accept()}>
          {phase === 'busy' ? <ActivityIndicator color="#fff" /> : <Text style={s.acceptText}>Accept detail</Text>}
        </TouchableOpacity>
      </View>
    </View>
  );
}

function Stat({icon, label, value}: {icon: string; label: string; value: string}) {
  return (
    <View style={s.stat}>
      <Icon name={icon as never} size={16} color={D.accentSoft} />
      <Text style={s.statLabel}>{label}</Text>
      <Text style={s.statValue} numberOfLines={1}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: D.bg},
  headerRow: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 22, paddingVertical: 16},
  accentBar: {width: 3, height: 16, borderRadius: 2, backgroundColor: D.accent},
  kicker: {fontFamily: D.fBold, fontSize: 12, letterSpacing: 2.4, color: D.text},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24, gap: 8},
  ring: {width: 110, height: 110, borderRadius: 55, borderWidth: 4, alignItems: 'center', justifyContent: 'center', marginBottom: 6},
  ringNum: {fontFamily: D.fBold, fontSize: 40, letterSpacing: -1, fontVariant: ['tabular-nums']},
  ringUnit: {fontFamily: D.fSemi, fontSize: 11, color: D.textMute, marginTop: -4, letterSpacing: 1},
  track: {width: '72%', maxWidth: 220, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.08)', overflow: 'hidden', marginBottom: 10},
  trackFill: {height: 4, borderRadius: 2},
  region: {fontFamily: D.fBold, fontSize: 22, color: D.text, letterSpacing: -0.3},
  service: {fontFamily: D.fSemi, fontSize: 13, color: D.accentSoft, textTransform: 'capitalize', marginTop: 1},
  grid: {flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 10, marginTop: 16},
  stat: {width: 100, alignItems: 'center', gap: 3, paddingVertical: 12, borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.025)', borderWidth: 1, borderColor: D.hair},
  statLabel: {fontFamily: D.fSemi, fontSize: 9, letterSpacing: 1, color: D.textMute, marginTop: 2},
  statValue: {fontFamily: D.fBold, fontSize: 13, color: D.text, paddingHorizontal: 4},
  chips: {flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 7, marginTop: 14},
  chip: {paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999,
    backgroundColor: 'rgba(91,141,239,0.10)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.30)'},
  chipText: {fontFamily: D.fSemi, fontSize: 11, color: D.accentSoft, textTransform: 'capitalize'},
  title: {fontFamily: D.fBold, fontSize: 21, color: D.text, textAlign: 'center'},
  sub: {fontFamily: D.fSans, fontSize: 13.5, lineHeight: 20, color: D.textDim, textAlign: 'center'},
  footer: {flexDirection: 'row', gap: 12, paddingHorizontal: 22, paddingTop: 12, borderTopWidth: 1, borderTopColor: D.hair},
  declineBtn: {flex: 1, height: 52, borderRadius: 15, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair},
  declineText: {fontFamily: D.fBold, fontSize: 15, color: D.textDim},
  acceptBtn: {flex: 2, height: 52, borderRadius: 15, alignItems: 'center', justifyContent: 'center',
    backgroundColor: D.accent, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)'},
  acceptText: {fontFamily: D.fBold, fontSize: 15, color: '#fff', letterSpacing: 0.3},
  secondaryBtn: {flex: 1, height: 50, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair},
  secondaryText: {fontFamily: D.fBold, fontSize: 14.5, color: D.textDim},
}));
