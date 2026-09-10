/**
 * Booking · Step 08 — Booking Confirmed
 *
 * Success screen after payment captures. Shows the confirmation code,
 * assigned team (CPOs + vehicle), and two primary actions: Invoice +
 * Track. Navigates to LiveTracking on Track, back to Dashboard on
 * the secondary CTA.
 */
import React, {useEffect, useMemo, useState} from 'react';
import {View, Text, StyleSheet, ScrollView, TouchableOpacity, StatusBar, AppState, ActivityIndicator, BackHandler} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useBottomInset} from '@hooks/useBottomInset';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import FitLine from '@components/ui/FitLine';
import {Imagery} from '@theme/imagery';
import ImageryBackdrop from '@components/ui/ImageryBackdrop';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {BookingStackParamList} from '@navigation/types';
import {UI} from '@components/ui/tokens';
import {BravoFont} from '@theme/bravo';
import {useBookingStore} from '@store/bookingStore';
import {assignmentApi, bookingApi, type AssignedCpoDto, type AssignedVehicleDto} from '@services/api';
import MissionStepper from '@components/mission/MissionStepper';
import {buildBookingSummaryRows} from '@screens/booking/bookingSummaryRows';
import {scaleTextStyles} from '@utils/scaling';

type Nav = NativeStackNavigationProp<BookingStackParamList, 'BookingConfirmation'>;
type Rt  = RouteProp<BookingStackParamList, 'BookingConfirmation'>;

const HARD_CAP_MS = 30 * 60_000;

interface CrewMember {
  key: string;
  initials: string;
  name: string;
  role: string;
  online: boolean;
  avGradient: boolean;
}

export default function BookingConfirmationScreen() {
  const insets = useSafeAreaInsets();
  const {bottomPad} = useBottomInset();
  const navigation = useNavigation<Nav>();
  const route = useRoute<Rt>();

  const {bookingId, paymentMethod, amountPaid, currency} = route.params;
  const draft = useBookingStore(st => st.draft);
  const activeBooking = useBookingStore(st => st.activeBooking);
  // Summary source is id-guarded (the singleton can hold another booking —
  // B-405) with the already-loaded list row as the pre-poll fallback; never
  // the draft, which is cleared at submit.
  const listRow = useBookingStore(
    st => (bookingId ? st.bookings.find(b => b.id === bookingId) : undefined),
  );
  const availableAddOns = useBookingStore(st => st.availableAddOns);
  const summaryBooking = (activeBooking?.id === bookingId ? activeBooking : null) ?? listRow ?? null;
  const summaryRows = useMemo(() => {
    const addOnLabels: Record<string, string> = {};
    for (const a of availableAddOns) {addOnLabels[a.id] = a.label;}
    return buildBookingSummaryRows(summaryBooking, {addOnLabels});
  }, [summaryBooking, availableAddOns]);

  // BB-9 (2026-08-15 back audit) — the wizard is PUSHED beneath this screen
  // and its "Confirm & Book" step stays live: hardware back from a PAID
  // booking landed there, offering to confirm the same booking again. Back
  // leaves the flow (BookingHome) instead; the swipe gesture is disabled at
  // the route. Cold notification mounts make popToTop a no-op-safe call.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      try { navigation.popToTop(); } catch { /* already at root */ }
      return true;
    });
    return () => sub.remove();
  }, [navigation]);

  const [team, setTeam] = useState<{cpos: AssignedCpoDto[]; vehicle: AssignedVehicleDto | null}>({
    cpos: [],
    vehicle: null,
  });

  // Poll the booking + team until ops dispatches the mission. Booking sits
  // at CONFIRMED with no team until ops manually picks CPOs + vehicle and
  // hits Dispatch on the console — at which point status flips to LIVE.
  //
  // Bounded by:
  //   1. Wall-clock cap of 30 min — if ops doesn't dispatch in that window,
  //      stop polling and let the user check back via Recent Bookings.
  //   2. AppState gate — pause when backgrounded, resume on next active.
  //      Without this the 5s interval ran forever even when the screen
  //      wasn't visible, draining battery and hammering the API.
  const loadActiveBooking = useBookingStore(s => s.loadActiveBooking);
  const [pollGaveUp, setPollGaveUp] = useState(false);
  useEffect(() => {
    if (!bookingId) {return;}
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let backoff = 5000;
    const startedAt = Date.now();
    const schedule = () => { timer = setTimeout(() => { void tick(); }, backoff); };
    const tick = async () => {
      if (AppState.currentState !== 'active') {
        // Backgrounded — re-arm short delay; the AppState listener below
        // will kick a fresh tick on resume.
        schedule();
        return;
      }
      try {
        const [teamRes] = await Promise.all([
          assignmentApi.getTeam(bookingId),
          loadActiveBooking(bookingId).catch(() => undefined),
        ]);
        if (cancelled) {return;}
        setTeam(teamRes.data);
        backoff = 5000;
        const status = (useBookingStore.getState().activeBooking?.status ?? '').toUpperCase();
        const settled = (status === 'LIVE' || status === 'COMPLETED') && teamRes.data.cpos.length > 0;
        if (settled) {return;}
        if (Date.now() - startedAt > HARD_CAP_MS) { setPollGaveUp(true); return; }
        schedule();
      } catch {
        if (cancelled) {return;}
        backoff = Math.min(backoff * 2, 30_000);
        if (Date.now() - startedAt > HARD_CAP_MS) { setPollGaveUp(true); return; }
        schedule();
      }
    };
    const appStateSub = AppState.addEventListener('change', state => {
      if (state === 'active' && !cancelled && !timer) {void tick();}
    });
    void tick();
    return () => {
      cancelled = true;
      if (timer) {clearTimeout(timer);}
      appStateSub.remove();
    };
  }, [bookingId, loadActiveBooking]);

  const liveStatus = (activeBooking?.status ?? '').toUpperCase();
  // MISSION-CANCEL (#14) — for auto-dispatch the booking stays CONFIRMED while
  // the mission goes LIVE, so read mission_status too (matches LiveTrackingScreen).
  // Once protection is active the Cancel button must hide even though the booking
  // is still CONFIRMED.
  const missionStatus = (activeBooking?.mission_status ?? '').toUpperCase();
  const dispatchedLive = liveStatus === 'LIVE' || missionStatus === 'LIVE' || missionStatus === 'SOS';

  // Mission closed while the user sits on this screen — F2: land on the
  // completion moment (rate + invoice) instead of silently popping home.
  useEffect(() => {
    if (liveStatus === 'COMPLETED' && bookingId) {
      navigation.replace('MissionComplete', {bookingId});
    }
  }, [liveStatus, navigation, bookingId]);

  // Mission cancelled by ops (or by the new PAYMENT_PENDING expiry cron)
  // while sitting on this screen — surface the trip summary so the user
  // sees the cancellation reason rather than a stale "Paid" header with
  // a disabled TRACK button.
  useEffect(() => {
    if (liveStatus === 'CANCELLED' && bookingId) {
      navigation.replace('TripSummary', {bookingId});
    }
  }, [liveStatus, navigation, bookingId]);

  // LB-OTP1 / LB-ST2 — the moment a mission exists (crew assigned → DISPATCHED,
  // then PICKUP / LIVE) auto-advance to the live tracker, mirroring
  // AgencyAcceptedScreen. Without this the client is stranded here through the
  // whole en-route/arrival window — Track disabled, and the verify-guard (team)
  // code, which only renders on LiveTracking, is unreachable. This is also the
  // destination a booking notification tap resolves to via the resume gate.
  useEffect(() => {
    if (bookingId && ['DISPATCHED', 'PICKUP', 'LIVE', 'SOS'].includes(missionStatus)) {
      navigation.replace('LiveTracking', {bookingId});
    }
  }, [missionStatus, navigation, bookingId]);

  const crew: CrewMember[] = useMemo(() => {
    const rows: CrewMember[] = team.cpos.map(c => ({
      // Audit H5 — key on the public call sign; the agent's internal id is
      // no longer sent to clients.
      key: c.call_sign,
      initials: initialsFor(c.display_name),
      name: `${c.call_sign} · ${c.display_name}`,
      role: c.role,
      online: true,
      avGradient: true,
    }));
    if (team.vehicle) {
      const v = team.vehicle;
      rows.push({
        key: v.id,
        initials: 'VH',
        name: `${v.call_sign} · ${v.make_model}`,
        role: v.armored
          ? `Armored · ${v.armor_grade ?? 'B-grade'} · ${v.plate}`
          : v.plate,
        online: true,
        avGradient: false,
      });
    }
    return rows;
  }, [team]);

  const shortCode = useMemo(() => {
    const id = bookingId ?? activeBooking?.id ?? '';
    const tail = id.replace(/-/g, '').slice(-4).toUpperCase();
    return `BS-2026-${tail || '4821'}`;
  }, [bookingId, activeBooking]);

  const startIso = activeBooking?.start_time ?? draft.start_time;
  const whenLabel = useMemo(() => {
    if (!startIso) {return 'Booking time TBC';}
    const d = new Date(startIso);
    // UTC so the booked time matches the backend/ops value on every device.
    return (
      d.toLocaleDateString('en-GB', {weekday: 'long', day: '2-digit', month: 'long', timeZone: 'UTC'}) +
      ` · ${d.getUTCHours().toString().padStart(2, '0')}:${d.getUTCMinutes().toString().padStart(2, '0')}Z` +
      ` · Est. ${activeBooking?.duration_hours ?? draft.duration_hours ?? 4} hrs`
    );
  }, [startIso, activeBooking, draft]);

  const goTrack = () => {
    if (!bookingId || !dispatchedLive) {return;}
    navigation.replace('LiveTracking', {bookingId});
  };

  const goDashboard = () => navigation.popToTop();

  const [cancelling, setCancelling] = useState(false);

  // Client-initiated cancel. The backend FSM allows this before approval
  // (PENDING_OPS) and after (OPS_APPROVED / PAYMENT_PENDING / CONFIRMED),
  // refunds captured credits, and releases the CPO + vehicle back to pool.
  const handleCancel = () => {
    if (!bookingId || cancelling) {return;}
    Alert.alert(
      'Cancel this booking?',
      'Your assigned team will be released. Any credits you paid are refunded automatically.',
      [
        {text: 'Keep booking', style: 'cancel'},
        {
          text: 'Cancel booking',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              setCancelling(true);
              try {
                const {data} = await bookingApi.cancel(bookingId);
                const refunded = (data as {refunded_credits?: number} | undefined)?.refunded_credits;
                await loadActiveBooking(bookingId).catch(() => undefined);
                Alert.alert(
                  'Booking cancelled',
                  refunded && refunded > 0
                    ? `${refunded.toLocaleString()} BC have been refunded to your wallet.`
                    : 'Your booking has been cancelled.',
                  [{text: 'OK', onPress: () => navigation.popToTop()}],
                );
              } catch (e) {
                const msg = e instanceof Error ? e.message : '';
                if (/protection.*active|cancel_blocked_protection_active/i.test(msg)) {
                  Alert.alert('Protection is active', 'This mission is already live — contact support to end it.');
                } else if (/window|cancel_window_expired/i.test(msg)) {
                  Alert.alert('Cancellation window passed', msg || 'Cancellation is only allowed shortly after booking. Contact support.');
                } else {
                  Alert.alert('Could not cancel', msg || 'Please try again.');
                }
              } finally {
                setCancelling(false);
              }
            })();
          },
        },
      ],
    );
  };

  // Cancellable only while the mission hasn't gone live. Once LIVE, the user
  // must contact ops (mission abort) — mirrors the backend FSM (CANCELLABLE
  // stops at CONFIRMED).
  // Deck page 5 — "remove or restrict cancellation once the booking has reached
  // the assigned/active stage". `dispatchedLive` only covers LIVE/SOS, so cancel
  // was still offered while a crew was already dispatched and driving to the
  // pickup (mission DISPATCHED / PICKUP). Cancelling there aborts the mission,
  // stands the crew down and tears down the mission room, so the moment a crew
  // is committed the client is directed to the mission rather than a button.
  //
  // A mission_status only EXISTS once crew has accepted, so this cannot touch the
  // pre-commitment states B-405 depends on (DRAFT / DISPATCHING / PENDING_OPS /
  // OPS_APPROVED / PAYMENT_PENDING) — a parked 'later' reservation stays freely
  // cancellable for as long as it is parked.
  // `team.cpos` populates from assignmentApi.getTeam as soon as officers are
  // assigned — which happens while the booking is still CONFIRMED and
  // mission_status is still ''. So the screenshot state (crew rows visible,
  // CANCEL BOOKING beneath them) was NOT covered by the status list alone.
  const crewCommitted = ['DISPATCHED', 'PICKUP', 'LIVE', 'SOS'].includes(missionStatus)
    || team.cpos.length > 0;
  const canCancel = !dispatchedLive && !crewCommitted;

  // Deck page 5 — "the dispatch state and next action must be unambiguous".
  // The screen used to tell three different stories at once: a nav pill
  // hard-coded to the literal string 'Paid' that never reflected state, a
  // stepper driven by journeyStep(), and a TRACK button driven by a THIRD
  // predicate (LIVE/SOS only). At mission DISPATCHED the stepper said "Team
  // dispatched" while the button said AWAITING DISPATCH and was disabled.
  // One derived state now drives the pill and the action together.
  const canTrack = dispatchedLive || crewCommitted;
  const statePill = liveStatus === 'CANCELLED' ? 'Cancelled'
    : liveStatus === 'COMPLETED' ? 'Completed'
    : missionStatus === 'SOS' ? 'SOS'
    : dispatchedLive ? 'Protection active'
    : crewCommitted ? 'Team dispatched'
    : 'Paid';

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={UI.bg} />

      <View style={s.nav}>
        <View style={{width: 32}} />
        <View style={s.navTitleRow}>
          <Icon name="check-circle" size={14} color={UI.signal} />
          <Text style={s.navTitle} numberOfLines={1}>BOOKING CONFIRMED</Text>
        </View>
        <View style={s.stepPill}>
          <Text style={s.stepPillText} numberOfLines={1}>{statePill}</Text>
        </View>
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={{paddingBottom: 24, gap: 14, paddingTop: 6}}
        showsVerticalScrollIndicator={false}>

        <View style={s.successHero}>
      <ImageryBackdrop source={Imagery.heroMissionActive} variant="hero" radius={12} />
          <View style={s.heroTopLine} />
          <View style={s.checkBadge}>
            <View style={s.checkInner}>
              <Icon name="check-bold" size={28} color="#FFF" />
            </View>
          </View>
          <Text style={s.code}>BOOKING #{shortCode}</Text>
          <Text style={s.when}>{whenLabel}</Text>
        </View>

        {/* Step 18 shared stepper. LB-ST2 — feed the live mission_status so the bar
            advances through Team dispatched → En route → Protection active instead of
            freezing at step 2 ("assigning team") for the whole DISPATCHED/PICKUP window. */}
        <View style={{paddingHorizontal: 4}}>
          <MissionStepper
            booking={{status: activeBooking?.status}}
            mission={missionStatus ? {status: missionStatus} : undefined}
          />
        </View>

        <View style={s.assigned}>
          <Text style={s.assignedHd}>ASSIGNED TEAM</Text>
          {crew.length === 0 ? (
            <View style={s.teamPlaceholder}>
              <Icon
                name={pollGaveUp ? 'pause-circle-outline' : 'account-search-outline'}
                size={20}
                color={UI.textMute}
              />
              <Text style={s.teamPlaceholderTitle}>
                {pollGaveUp ? 'Still awaiting dispatch' : 'Awaiting team assignment'}
              </Text>
              <Text style={s.teamPlaceholderSub}>
                {pollGaveUp
                  ? 'Auto-refresh paused after 30 minutes. Check back from Recent Bookings or contact support.'
                  : 'Ops is selecting your CPOs and vehicle. This view updates automatically.'}
              </Text>
            </View>
          ) : (
            crew.map(c => (
              <View key={c.key} style={s.crew}>
                <View style={[s.av, c.avGradient ? s.avGradient : s.avPlain]}>
                  <Text style={s.avText}>{c.initials}</Text>
                </View>
                <View style={s.crewInfo}>
                  <Text style={s.crewName} numberOfLines={1} ellipsizeMode="tail">{c.name}</Text>
                  <Text style={s.crewRole} numberOfLines={1} ellipsizeMode="tail">{c.role}</Text>
                </View>
                <View style={[s.crewStatus, !c.online && s.crewStatusOff]} />
              </View>
            ))
          )}
        </View>

        <View style={s.actionPair}>
          {/* F1 — was a dead button with no onPress. The invoice issues once the
              detail completes; before that the screen explains itself. */}
          <TouchableOpacity style={s.btnSec} activeOpacity={0.85}
            accessibilityRole="button" accessibilityLabel="View invoice"
            onPress={() => bookingId && navigation.navigate('Invoice', {bookingId})}>
            <Icon name="receipt" size={14} color={UI.accent} />
            <Text style={s.btnSecText}>INVOICE</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.btnTrack, !canTrack && s.btnTrackWait]}
            onPress={goTrack}
            disabled={!canTrack}
            accessibilityRole="button"
            accessibilityState={{disabled: !canTrack}}
            accessibilityLabel={canTrack ? 'Track your detail' : 'Awaiting dispatch'}
            activeOpacity={0.85}>
            <Icon
              name={canTrack ? 'crosshairs-gps' : 'timer-sand'}
              size={14}
              color={canTrack ? UI.bg : UI.signal}
            />
            <FitLine
              style={[s.btnTrackText, !canTrack && s.btnTrackTextWait, {textAlign: 'center'}]}
              floorScale={0.8}
              text={canTrack ? 'TRACK' : 'AWAITING DISPATCH'}
            />
          </TouchableOpacity>
        </View>

        {summaryRows.length > 0 && (
          <View style={s.sumBox}>
            <Text style={s.sumHd}>BOOKING SUMMARY</Text>
            {summaryRows.map(r => (
              <View key={r.label} style={s.sumRow}>
                <Text style={s.sumK}>{r.label}</Text>
                <Text style={[s.sumV, r.highlight && s.sumVAcc]} numberOfLines={2}>{r.value}</Text>
              </View>
            ))}
          </View>
        )}

        {typeof amountPaid === 'number' && (
          <View style={s.paidRow}>
            <Text style={s.paidK}>PAID</Text>
            <Text style={s.paidV} numberOfLines={1} ellipsizeMode="tail">
              {amountPaid.toLocaleString()} {currency ?? 'BC'} · {paymentMethod ?? 'card'}
            </Text>
          </View>
        )}

        <Text style={s.confirmSent}>CONFIRMATION SENT · ops@bravo.secure</Text>
      </ScrollView>

      <View style={[s.ctaWrap, {paddingBottom: bottomPad(12)}]}>
        {canCancel && (
          <TouchableOpacity
            style={s.ctaCancel}
            onPress={handleCancel}
            disabled={cancelling}
            accessibilityRole="button"
            accessibilityState={{disabled: cancelling}}
            accessibilityLabel="Cancel booking"
            activeOpacity={0.85}>
            {cancelling
              ? <ActivityIndicator color="#FCA5A5" />
              : <Text style={s.ctaCancelText} numberOfLines={1}>CANCEL BOOKING</Text>}
          </TouchableOpacity>
        )}
        <TouchableOpacity style={s.ctaOutline} onPress={goDashboard} activeOpacity={0.85}
          accessibilityRole="button" accessibilityLabel="Return to dashboard">
          <Text style={s.ctaOutlineText} numberOfLines={1}>RETURN TO DASHBOARD</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function initialsFor(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {return '--';}
  if (parts.length === 1) {return parts[0].slice(0, 2).toUpperCase();}
  return `${parts[0][0]}.${parts[parts.length - 1][0]}`.toUpperCase();
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: UI.bg},

  nav: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 12, gap: 12,
    borderBottomWidth: 1, borderBottomColor: UI.hair,
  },
  navTitleRow: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
  },
  navTitle: {
    flexShrink: 1, minWidth: 0,
    fontFamily: BravoFont.semiBold, fontSize: 13, letterSpacing: 1.5,
    color: UI.signal,
  },
  stepPill: {
    flexShrink: 0, maxWidth: '38%',
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.045)',
    borderWidth: 1, borderColor: UI.signal,
  },
  stepPillText: {
    fontSize: 10, fontWeight: '700', letterSpacing: 1.2,
    color: UI.signal,
  },

  scroll: {flex: 1, paddingHorizontal: 16},

  successHero: {
    padding: 22, borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.045)',
    borderWidth: 1, borderColor: 'rgba(74,222,128,0.35)',
    alignItems: 'center', overflow: 'hidden', position: 'relative',
  },
  heroTopLine: {
    position: 'absolute', top: 0, left: '15%', right: '15%', height: 1,
    backgroundColor: UI.signal, opacity: 0.7,
  },
  checkBadge: {
    width: 80, height: 80, borderRadius: 40,
    backgroundColor: 'rgba(74,222,128,0.18)',
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 14,
  },
  checkInner: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: UI.signal,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: UI.signal, shadowOpacity: 0.5, shadowRadius: 16,
    shadowOffset: {width: 0, height: 0}, elevation: 8,
  },
  code: {
    fontFamily: BravoFont.bold, fontSize: 13, color: UI.text,
    letterSpacing: 1, marginBottom: 6,
  },
  when: {
    fontSize: 11, color: UI.textDim, lineHeight: 16, textAlign: 'center',
  },

  assigned: {
    padding: 12, borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.045)', borderWidth: 1, borderColor: UI.hair,
  },
  teamPlaceholder: {
    alignItems: 'center', justifyContent: 'center',
    paddingVertical: 18, paddingHorizontal: 12, gap: 6,
  },
  teamPlaceholderTitle: {
    fontFamily: BravoFont.bold, fontSize: 12, color: UI.text,
    letterSpacing: 0.4,
  },
  teamPlaceholderSub: {
    fontSize: 11, color: UI.textMute, textAlign: 'center', lineHeight: 16,
  },
  assignedHd: {
    fontFamily: BravoFont.semiBold, fontSize: 10,
    color: UI.textMute, letterSpacing: 1.5, marginBottom: 10,
  },
  crew: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    padding: 10, borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: UI.hair,
    marginBottom: 6,
  },
  av: {
    width: 32, height: 32, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: UI.hair,
  },
  avGradient: {backgroundColor: 'rgba(91,141,239,0.14)'},
  avPlain:    {backgroundColor: 'rgba(255,255,255,0.06)'},
  avText: {
    fontFamily: BravoFont.bold, fontSize: 11,
    color: UI.textDim, letterSpacing: 0.3,
  },
  crewInfo: {flex: 1, minWidth: 0},
  crewName: {
    fontFamily: BravoFont.bold, fontSize: 12, color: UI.text,
    letterSpacing: -0.1,
  },
  crewRole: {fontSize: 10.5, color: UI.textMute, marginTop: 2},
  crewStatus: {
    width: 8, height: 8, borderRadius: 4, backgroundColor: UI.signal,
    shadowColor: UI.signal, shadowOpacity: 0.6, shadowRadius: 6,
    shadowOffset: {width: 0, height: 0}, elevation: 2,
  },
  crewStatusOff: {backgroundColor: UI.textMute, shadowOpacity: 0},

  actionPair: {flexDirection: 'row', gap: 10},
  btnSec: {
    flex: 1, minHeight: 44, borderRadius: 8,
    borderWidth: 1, borderColor: UI.accent, backgroundColor: 'transparent',
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
  },
  btnSecText: {
    fontFamily: BravoFont.bold, fontSize: 12, color: UI.accent,
    letterSpacing: 1.2,
  },
  btnTrack: {
    flex: 1, minHeight: 44, borderRadius: 8, paddingHorizontal: 10,
    borderWidth: 1, borderColor: UI.signal,
    backgroundColor: UI.signal,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    shadowColor: UI.signal, shadowOpacity: 0.3, shadowRadius: 12,
    shadowOffset: {width: 0, height: 4}, elevation: 6,
  },
  // Waiting for dispatch: outlined, constructed exactly like INVOICE next to it,
  // so the pair reads as one set. A solid primary fill that cannot be pressed
  // reads as enabled, and the old blanket opacity 0.5 put dark text on dimmed
  // green — the label was the least readable thing on the screen.
  btnTrackWait: {
    backgroundColor: 'rgba(74,222,128,0.10)',
    shadowOpacity: 0, elevation: 0,
  },
  btnTrackText: {
    flexShrink: 1,
    fontFamily: BravoFont.bold, fontSize: 12, color: UI.bg,
    letterSpacing: 1.2,
  },
  btnTrackTextWait: {color: UI.signal, letterSpacing: 0.8},

  sumBox: {
    padding: 12, borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.045)', borderWidth: 1, borderColor: UI.hair,
  },
  sumHd: {
    fontFamily: BravoFont.semiBold, fontSize: 10,
    color: UI.textMute, letterSpacing: 1.5, marginBottom: 10,
  },
  sumRow: {
    flexDirection: 'row', justifyContent: 'space-between', gap: 10,
    paddingVertical: 6,
    borderTopWidth: 1, borderTopColor: UI.hair,
  },
  sumK: {fontFamily: BravoFont.medium, fontSize: 12, color: UI.textMute, flexShrink: 1, minWidth: 0},
  sumV: {
    flex: 1, textAlign: 'right',
    fontFamily: BravoFont.bold, fontSize: 11.5,
    color: UI.text, letterSpacing: 0.2,
  },
  sumVAcc: {color: UI.accent},

  paidRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 4,
  },
  paidK: {
    fontFamily: BravoFont.semiBold, fontSize: 10,
    color: UI.textMute, letterSpacing: 1.5,
  },
  paidV: {
    fontFamily: BravoFont.bold, fontSize: 11,
    color: UI.text, letterSpacing: 0.3,
    flexShrink: 1, textAlign: 'right', marginLeft: 12,
  },

  confirmSent: {
    textAlign: 'center', fontSize: 10.5, color: UI.textMute,
    letterSpacing: 0.6,
  },

  ctaWrap: {
    paddingHorizontal: 16, paddingTop: 8,
    backgroundColor: UI.bg,
  },
  ctaCancel: {
    minHeight: 48, borderRadius: 8, marginBottom: 10,
    backgroundColor: 'rgba(239,68,68,0.08)',
    borderWidth: 1, borderColor: 'rgba(239,68,68,0.35)',
    alignItems: 'center', justifyContent: 'center',
  },
  ctaCancelText: {
    fontFamily: BravoFont.bold, fontSize: 12.5, color: '#FCA5A5', letterSpacing: 1,
  },
  ctaOutline: {
    minHeight: 48, borderRadius: 8,
    backgroundColor: 'transparent',
    borderWidth: 1, borderColor: UI.hair,
    alignItems: 'center', justifyContent: 'center',
  },
  ctaOutlineText: {
    fontFamily: BravoFont.bold, fontSize: 12.5, color: UI.textDim,
    letterSpacing: 1.2,
  },
}));
