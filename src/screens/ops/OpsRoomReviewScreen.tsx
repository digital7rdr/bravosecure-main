/**
 * Booking · Step 06 — Ops Room Review
 *
 * After the client submits their booking (DRAFT → PENDING_OPS), they
 * land here while the ops team decides. Spinning hourglass, booking
 * summary, locked CTA. Auto-advances on approval:
 *   - enough Bravo Credits → create booking + go straight to Confirmation
 *   - short on credits      → CreditPaywall (top-up → payment)
 * There is NO dedicated booking-flow payment screen — all payment
 * interaction is routed through the top-up module.
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, StatusBar, Animated, Easing, BackHandler,
  Modal, Pressable, ActivityIndicator,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useBottomInset} from '@hooks/useBottomInset';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useRoute, useFocusEffect, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {BookingStackParamList} from '@navigation/types';
import {Colors} from '@theme/colors';
import {BravoFont} from '@theme/bravo';
import LoadingView from '@components/LoadingView';
import {useBookingStore} from '@store/bookingStore';
import {useWalletStore} from '@store/walletStore';
import {bookingApi} from '@services/api';
import {isInsufficientCreditsError, humanCreditMessage} from '@screens/booking/creditErrors';
import {buildBookingSummaryRows} from '@screens/booking/bookingSummaryRows';
import {Alert} from '@utils/alert';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';

type Nav = NativeStackNavigationProp<BookingStackParamList, 'OpsRoomReview'>;
type Rt  = RouteProp<BookingStackParamList, 'OpsRoomReview'>;
// B-405 — 'scheduled' is the approved-and-parked state of an auto 'later'
// booking: ops approved it, the matchmaker starts ~15 min before pickup, and
// NOTHING is owed from the client (escrow charges at CPO accept). Without it
// an approved future booking rendered exactly like an un-approved one and the
// founder cancelled a live booking believing the approval never landed.
type StateKey = 'pending' | 'approved' | 'rejected' | 'scheduled';
type PayState = 'idle' | 'countdown' | 'paying' | 'paid' | 'insufficient' | 'error';

const POLL_EVERY_MS = 4000;
const COUNTDOWN_SECONDS = 5;
const PAID_HOLD_MS = 2200;

export default function OpsRoomReviewScreen() {
  const insets = useSafeAreaInsets();
  const {bottomPad, contentBottom} = useBottomInset();
  const navigation = useNavigation<Nav>();
  const route = useRoute<Rt>();

  const bookingId = route.params?.bookingId;
  const {draft, loadActiveBooking, activeBooking} = useBookingStore();
  const balance = useWalletStore(s => s.balance);
  const loadBalance = useWalletStore(s => s.loadBalance);

  const [state, setState] = useState<StateKey>('pending');
  const [payState, setPayState] = useState<PayState>('idle');
  const [countdown, setCountdown] = useState<number>(COUNTDOWN_SECONDS);
  const [payError, setPayError] = useState<string | null>(null);
  // Snapshot of balance BEFORE the debit, so the success screen can show
  // "Was 224 → −224 = 0" math even after `balance` updates.
  const [paidSnapshot, setPaidSnapshot] = useState<{before: number; charged: number; after: number} | null>(null);

  useEffect(() => { void loadBalance(); }, [loadBalance]);

  const spin = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 10_000,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [spin]);

  // Real ops review — booking is already created (PENDING_OPS) by the
  // previous screen. We poll /bookings/:id every POLL_EVERY_MS and react
  // when ops flips the status to OPS_APPROVED or CANCELLED.
  const advancing = useRef(false);

  const advance = useCallback(async () => {
    if (advancing.current || !bookingId) {return;}
    advancing.current = true;
    setState('approved');
    await loadBalance();
    setCountdown(COUNTDOWN_SECONDS);
    setPayState('countdown');
  }, [bookingId, loadBalance]);

  // B-405 — go-now missions and parked reservations coexist, so the store's
  // activeBooking singleton may hold a DIFFERENT booking than this screen's
  // param (3-agent review). Every read below must go through the id-guarded
  // view; the raw singleton is never trusted for money, lock, or routing.
  const abForThis = activeBooking?.id === bookingId ? activeBooking : null;
  // Until the first poll lands, fall back to the already-loaded list row so a
  // 'later' reservation opened from the upcoming card is never back-locked
  // even offline (the list was loaded to render that card).
  const listRow = useBookingStore(
    s => (bookingId ? s.bookings.find(b => b.id === bookingId) : undefined),
  );
  const isLaterBooking =
    (abForThis?.booking_mode ?? listRow?.booking_mode) === 'later';

  // Cost is the booking's actual server-side total — works after cold
  // restart where the in-memory draft is empty.
  const chargeBc = Math.round(abForThis?.total_eur ?? draft.estimated_price ?? 0);
  const haveBc = balance?.bravo_credits ?? 0;
  const afterBc = haveBc - chargeBc;

  // Audit fix 3.4 — clear the success-hold setTimeout on unmount.
  // The previous code fired-and-forgot, so navigating away during the
  // 1.6s celebration window (PAID_HOLD_MS) left a `navigation.replace`
  // pending after the screen tore down — RN Navigation logs a warning
  // and the replace silently no-ops on a stale reference.
  const paidHoldTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (paidHoldTimer.current) {clearTimeout(paidHoldTimer.current);}
  }, []);

  // Audit fix — `runCharge` reads `chargeBc` and the pre/post balances
  // via store-getter so the callback identity stays stable. Previously
  // its deps included `haveBc` (a hook subscription), so every wallet
  // refresh re-built the function — and the countdown effect (which
  // lists `runCharge` in deps) reset its 1s timer mid-tick. Net effect:
  // the visible countdown could stall on the same number for as long
  // as the balance was refreshing. Keep deps minimal and use getState.
  const runCharge = useCallback(async () => {
    if (!bookingId) {return;}
    const before = useWalletStore.getState().balance?.bravo_credits ?? 0;
    const ab = useBookingStore.getState().activeBooking;
    // B-405 — never price the debit off a different booking (the singleton is
    // shared; see abForThis above). Bail to 'insufficient', whose auto-retry
    // re-fires once the right booking loads.
    if (!ab || ab.id !== bookingId) {
      setPayState('insufficient');
      return;
    }
    const cost = Math.round(ab?.total_eur ?? 0);
    if (cost <= 0) {
      // Server-side total isn't in yet (cold restart, slow first poll).
      // Bail back to insufficient so the user isn't shown a "Deducting
      // 0 BC" sheet; the auto-retry effect will re-trigger once the
      // booking finishes loading.
      setPayState('insufficient');
      return;
    }
    setPayState('paying');
    setPayError(null);
    try {
      await bookingApi.payWithCredits(bookingId);
      await loadBalance();
      const after = useWalletStore.getState().balance?.bravo_credits ?? Math.max(0, before - cost);
      setPaidSnapshot({before, charged: cost, after});
      setPayState('paid');
      paidHoldTimer.current = setTimeout(() => {
        navigation.replace('BookingConfirmation', {
          bookingId,
          amountPaid: cost,
          currency: 'BC',
          paymentMethod: 'bravo_credits',
          creditsAwarded: 0,
        });
      }, PAID_HOLD_MS);
    } catch (e: unknown) {
      const err = e as {response?: {data?: {message?: string | string[]; code?: string}}; message?: string};
      const rawMsg = (Array.isArray(err.response?.data?.message)
        ? err.response?.data?.message?.join(' ')
        : err.response?.data?.message) ?? err.message ?? '';
      // Issue 25 — one shared rule for every error shape (see creditErrors.ts);
      // this screen used to carry its own hand-rolled copy of the check.
      const isInsufficient = isInsufficientCreditsError(e);
      // Server also rejects double-charge of an already-CONFIRMED
      // booking (lost-200 retry case): land on success rather than
      // showing PAYMENT FAILED. The booking is paid; just route on.
      const isAlreadyPaid =
        typeof rawMsg === 'string' && /already|state CONFIRMED|already_confirmed/i.test(rawMsg);
      if (isAlreadyPaid) {
        navigation.replace('BookingConfirmation', {
          bookingId,
          amountPaid: cost,
          currency: 'BC',
          paymentMethod: 'bravo_credits',
          creditsAwarded: 0,
        });
        return;
      }
      if (isInsufficient) {
        // Re-fetch balance before surfacing the insufficient state — a
        // delayed top-up settlement may have landed between the request
        // start and now, in which case the auto-retry effect will pick
        // it up immediately rather than the user re-tapping TOP UP NOW
        // and minting a second PaymentIntent.
        await loadBalance().catch(() => undefined);
        setPayState('insufficient');
      } else {
        // B-380 — raw codes (family_spend_limit_exceeded) must never render.
        const human = typeof rawMsg === 'string' ? humanCreditMessage(rawMsg) : undefined;
        setPayError(human ?? (typeof rawMsg === 'string' && rawMsg ? rawMsg : 'Payment failed'));
        setPayState('error');
      }
    }
  }, [bookingId, loadBalance, navigation]);

  // Countdown ticker — drives the auto-debit at 0.
  useEffect(() => {
    if (payState !== 'countdown') {return;}
    if (countdown <= 0) {
      void runCharge();
      return;
    }
    const t = setTimeout(() => setCountdown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [payState, countdown, runCharge]);

  // Auto-retry after a successful top-up. When the user comes back from
  // CreditPaywall (`payState` still 'insufficient') and the freshly-loaded
  // wallet now covers the charge, kick the debit again automatically so
  // they don't have to manually re-tap "TOP UP NOW".
  // Why: without this the modal stays stuck on the insufficient state
  // even though the wallet has the funds.
  useFocusEffect(
    useCallback(() => {
      void loadBalance();
    }, [loadBalance]),
  );
  useEffect(() => {
    if (payState !== 'insufficient') {return;}
    // Don't auto-retry until the server has confirmed the real charge
    // amount. Without this guard, a momentary `activeBooking === null`
    // race (the polling tick re-fetched) makes `chargeBc === 0` and
    // `haveBc >= 0` always true → countdown fires → server rejects with
    // a non-insufficient error → endless retry loop.
    // B-405 — id-guarded: THIS booking must be loaded, not just any booking.
    if (!abForThis) {return;}
    if (chargeBc <= 0) {return;}
    if (haveBc < chargeBc) {return;}
    setCountdown(COUNTDOWN_SECONDS);
    setPayState('countdown');
  }, [payState, haveBc, chargeBc, abForThis]);

  // Audit fix 3.4 — declared up here so `lockBack` below can read it.
  // Set inside the polling effect when wall-clock exceeds HARD_CAP_MS.
  const [pollGaveUp, setPollGaveUp] = useState(false);

  // B-92 — the client must be able to WITHDRAW a request that ops hasn't
  // acted on (it can sit PENDING_OPS for days). Server-side this is always
  // allowed pre-commitment (booking.service cancel: PENDING_OPS is in the
  // pre-commitment list, idempotent if it already ended), so this is purely
  // the missing UI escape hatch on a screen that otherwise locks back.
  const [cancelling, setCancelling] = useState(false);
  const cancelRequest = useCallback(() => {
    if (!bookingId || cancelling) {return;}
    Alert.alert(
      'Cancel this request?',
      'Your booking will be withdrawn from ops review. Nothing has been charged.',
      [
        {text: 'Keep Waiting', style: 'cancel'},
        {
          text: 'Cancel Request',
          style: 'destructive',
          onPress: () => {
            setCancelling(true);
            // Stop the poll from racing us into approved/confirmed routing
            // while the cancel is in flight.
            advancing.current = true;
            useBookingStore.getState().cancelBooking(bookingId)
              .then(() => {
                navigation.popToTop();
              })
              .catch((e: unknown) => {
                advancing.current = false;
                setCancelling(false);
                const err = e as {response?: {data?: {message?: string | string[]}}; message?: string};
                const raw = err.response?.data?.message;
                const msg = Array.isArray(raw) ? raw.join(' · ') : raw ?? err.message ?? 'Could not cancel — try again.';
                Alert.alert('Cancel failed', msg);
              });
          },
        },
      ],
    );
  }, [bookingId, cancelling, navigation]);

  // Block hardware back / gesture while the booking is in-flight: ops
  // review pending OR auto-pay countdown / debit in progress. The user can
  // still switch tabs (Home/Messenger/Profile) via the bottom nav.
  // Audit fix 3.4 — once `pollGaveUp` is true (polling hit the 5-min cap)
  // release the lock so the user can navigate away to support / home.
  // Otherwise we'd be holding them on a screen we've stopped polling.
  // B-405 — a 'later' reservation NEVER locks the client in: they were sent
  // home at submit and only re-enter this screen by choice (upcoming card /
  // notification tap). The payment lock still applies once a legacy 'later'
  // booking enters the auto-pay window (payState below covers it).
  // isLaterBooking is derived above from the id-guarded booking / list row.
  const lockBack =
    !pollGaveUp && (
      (state === 'pending' && !isLaterBooking) ||
      payState === 'countdown' ||
      payState === 'paying' ||
      payState === 'paid'
    );
  useFocusEffect(
    useCallback(() => {
      if (!lockBack) {return undefined;}
      navigation.setOptions({gestureEnabled: false});
      const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
      return () => {
        navigation.setOptions({gestureEnabled: true});
        sub.remove();
      };
    }, [navigation, lockBack]),
  );

  // Audit fix 3.4 — cap polling at 5 minutes total and surface a
  // "still waiting? contact support" affordance after that. Lowercase
  // status comparison (`.toUpperCase()` then exact match) was already
  // partly there — pin all four branches the same way so a backend
  // sending `confirmed` lowercase doesn't silently drop the user into
  // a stuck screen. Re-enable lockBack only while polling is healthy
  // (not after the cap), so a cap-hit user can navigate away.
  useEffect(() => {
    if (!bookingId) {return;}
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let backoff = POLL_EVERY_MS;
    // B-405 — while parked on the approved/scheduled state, keep polling (the
    // T-15 sweep or an ops cancel must still route) but at a calm cadence and
    // WITHOUT the 5-minute give-up: a stale "APPROVED" after an ops cancel is
    // the same class of misinformation this bug was opened for.
    let parked = false;
    const PARKED_POLL_MS = 30_000;
    const startedAt = Date.now();
    const HARD_CAP_MS = 5 * 60_000;
    // B-405 — this screen instance can be re-targeted at a DIFFERENT booking
    // (push tap / upcoming card while already mounted). All routing state
    // belongs to the previous booking — reset it or booking B renders A's
    // verdict (3-agent review).
    advancing.current = false;
    setState('pending');
    setPayState('idle');
    setPollGaveUp(false);
    const tick = async () => {
      // loadActiveBooking never throws (it reports via its return flag), so
      // drive backoff off the flag — the old try/catch here was dead code.
      const ok = await loadActiveBooking(bookingId);
      backoff = ok ? POLL_EVERY_MS : Math.min(backoff * 2, 30_000);
      if (cancelled) {return;}
      const ab = useBookingStore.getState().activeBooking;
      // B-405 — the singleton may hold another booking when this poll's own
      // load failed (go-now + reservations coexist now). Never route this
      // screen off another booking's status — skip the tick and retry.
      if (!ab || ab.id !== bookingId) {
        timer = setTimeout(() => { void tick(); }, backoff);
        return;
      }
      // Audit fix 3.4 — normalize status case so a future change to
      // serializing it lowercase doesn't silently break the routing.
      const status = (ab?.status ?? '').toUpperCase();
      // Ops-gated auto dispatch: an AUTO booking parks here PENDING_OPS too, but its
      // approval hands it to the matchmaker (escrow-charged at accept) — it must never
      // enter the auto-pay countdown. 'now' flips to DISPATCHING moments after approval
      // (→ Finding screen); 'later' stays OPS_APPROVED until the cron starts the search.
      const isAuto = ab?.dispatch_mode === 'auto';
      if (status === 'DISPATCHING') {
        if (!advancing.current) {
          advancing.current = true;
          navigation.replace('FindingDetail', {bookingId});
          return;
        }
      } else if ((status === 'OPS_APPROVED' || status === 'PAYMENT_PENDING') && !isAuto) {
        void advance();
      } else if (status === 'OPS_APPROVED' && isAuto && ab?.booking_mode === 'later') {
        // B-405 — approved auto 'later' booking: show the scheduled state and
        // KEEP polling — the T-15 sweep flips it DISPATCHING (→ Finding), and
        // an ops cancel must still route to rejected.
        parked = true;
        setState('scheduled');
      } else if (status === 'CONFIRMED') {
        if (!advancing.current) {
          advancing.current = true;
          const total = ab?.total_eur ?? 0;
          navigation.replace('BookingConfirmation', {
            bookingId,
            amountPaid: Math.round(total),
            currency: 'BC',
            paymentMethod: 'bravo_credits',
            creditsAwarded: 0,
          });
          return;
        }
      } else if (status === 'LIVE') {
        if (!advancing.current) {
          advancing.current = true;
          navigation.replace('LiveTracking', {bookingId});
          return;
        }
      } else if (status === 'CANCELLED') {
        setState('rejected');
        return;
      } else if (status === 'NO_PROVIDER') {
        // B-405 — the T-15 search can exhaust between ticks while the user
        // watches the scheduled state; a terminal booking must never keep
        // rendering "approved" with a live CANCEL affordance.
        if (!advancing.current) {
          advancing.current = true;
          navigation.replace('NoDetail', {bookingId});
          return;
        }
      } else if (status === 'COMPLETED' || status === 'AGENCY_NO_SHOW') {
        // Stale re-entry (old reminder/notification tap) on a finished or
        // refunded booking → its receipt, not a fake review state.
        if (!advancing.current) {
          advancing.current = true;
          navigation.replace('TripSummary', {bookingId});
          return;
        }
      }
      if (!parked && Date.now() - startedAt > HARD_CAP_MS) {
        setPollGaveUp(true);
        return;
      }
      timer = setTimeout(() => { void tick(); }, parked ? PARKED_POLL_MS : backoff);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) {clearTimeout(timer);}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookingId]);

  // B-405 — abForThis (id-guarded) first, then the already-loaded list row
  // (confirmBooking unshifts the created booking, so it is there before the
  // first poll lands). NEVER the draft: it is cleared at submit, so its values
  // are the DEFAULTS ("4 hrs", no pickup, 0 BC) and can already belong to a
  // NEW booking by the time an upcoming reservation is re-opened.
  const summaryBooking = abForThis ?? listRow ?? null;
  const availableAddOns = useBookingStore(s => s.availableAddOns);
  const summaryRows = useMemo(() => {
    const addOnLabels: Record<string, string> = {};
    for (const a of availableAddOns) {addOnLabels[a.id] = a.label;}
    return buildBookingSummaryRows(summaryBooking, {addOnLabels});
  }, [summaryBooking, availableAddOns]);

  const rotate = spin.interpolate({inputRange: [0, 1], outputRange: ['0deg', '360deg']});

  // B-405 — 'scheduled' renders with the approved styling everywhere the
  // tri-state pill/row asks "is this approved?".
  const approvedish = state === 'approved' || state === 'scheduled';

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      <View style={s.nav}>
        {lockBack ? (
          // Issue 32 — back is suppressed while ops review is in flight, but
          // `s.back` carries a background + border, so the empty spacer painted
          // a blank rounded square that reads as a missing icon asset. Reserve
          // the width only.
          // B-370 — gate on lockBack (not state === 'pending'): the lock also
          // covers the auto-pay countdown/debit window, where the visible
          // arrow bypassed the very lock that blocks hardware back and the
          // swipe gesture — on iOS it was the primary affordance. Bonus: after
          // the 5-min poll cap releases the lock (pollGaveUp), the arrow now
          // reappears instead of staying hidden on a screen we stopped polling.
          <View style={s.backSpacer} />
        ) : (
          <TouchableOpacity style={s.back} onPress={() => goBackOnce(navigation)} activeOpacity={0.7}>
            <Icon name="chevron-left" size={18} color={Colors.textPrimary} />
          </TouchableOpacity>
        )}
        <Text style={s.navTitle}>BRAVO CONTROL SYSTEM REVIEW</Text>
        <View style={[s.stepPill, approvedish ? s.stepPillOk : state === 'rejected' ? s.stepPillErr : s.stepPillWarn]}>
          <Text style={[s.stepPillText, approvedish ? s.stepPillTextOk : state === 'rejected' ? s.stepPillTextErr : s.stepPillTextWarn]}>
            {approvedish ? 'Approved' : state === 'rejected' ? 'Rejected' : 'Pending'}
          </Text>
        </View>
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={{paddingBottom: contentBottom(20), gap: 10, paddingTop: 4}}
        showsVerticalScrollIndicator={false}>

        {/* Hourglass hero — or the B-405 approved/scheduled hero once ops
            approve a future reservation. */}
        <View style={[s.reviewHero, state === 'scheduled' && {borderColor: 'rgba(0,200,83,0.35)'}]}>
          <View style={[s.heroTopLine, state === 'scheduled' && {backgroundColor: Colors.success}]} />
          {state === 'scheduled' ? (
            <View style={[s.hourglass, {backgroundColor: 'rgba(0,200,83,0.12)'}]}>
              <Icon name="calendar-check" size={36} color={Colors.success} />
            </View>
          ) : (
            <View style={s.hourglass}>
              {!pollGaveUp && (
                <Animated.View style={[s.hourglassRing, {transform: [{rotate}]}]} />
              )}
              <Icon name={pollGaveUp ? 'timer-sand-empty' : 'timer-sand'} size={36} color={Colors.warning} />
            </View>
          )}
          <Text style={s.heroTitle}>
            {state === 'scheduled' ? 'APPROVED — DETAIL SCHEDULED' : 'AWAITING BRAVO CONTROL SYSTEM APPROVAL'}
          </Text>
          {state === 'scheduled' ? (
            <Text style={s.heroDesc}>
              The Bravo Control System approved your booking. Your protection
              detail is assigned shortly before start time — we'll remind you{' '}
              <Text style={s.heroDescB}>1 hour before</Text>. Nothing is charged
              until a protection officer accepts.
            </Text>
          ) : pollGaveUp ? (
            // The 5-minute cap used to add a SECOND full-width waiting panel
            // above this one, which kept spinning and still promised "2-5
            // minutes" — two large panels telling the same, now contradictory,
            // story. One panel, one status (deck page 4).
            <Text style={s.heroDesc}>
              Auto-refresh paused after 5 minutes. Review can take longer during
              peak hours — <Text style={s.heroDescB}>contact support</Text> if this
              is still pending.
            </Text>
          ) : (
            <Text style={s.heroDesc}>
              Your booking is being reviewed by the operations team. Typically{' '}
              <Text style={s.heroDescB}>2–5 minutes</Text>.
            </Text>
          )}
        </View>

        {/* Summary */}
        <View style={s.sumBox}>
          <Text style={s.sumHd}>BOOKING SUMMARY</Text>
          {summaryRows.length === 0 ? (
            <Text style={s.sumEmpty}>Booking details are not available yet.</Text>
          ) : (
            summaryRows.map(r => (
              <SumRow key={r.label} k={r.label} v={r.value} highlight={r.highlight} />
            ))
          )}
        </View>

      </ScrollView>

      {/* Booking controls — ONE consistent slot. The cancel affordance lives
          here rather than inside the status hero so it sits in the same place
          at every stage, directly under the note saying when it expires. The
          old locked "waiting" bar was removed: the hero + nav pill already
          carry that status, and it kept reading "waiting" on bookings ops had
          already approved. */}
      <View style={[s.ctaWrap, {paddingBottom: bottomPad(12)}]}>
        {state === 'rejected' ? (
          <TouchableOpacity
            style={[s.ctaLocked, {backgroundColor: Colors.danger, borderColor: Colors.danger}]}
            onPress={() => navigation.popToTop()}
            activeOpacity={0.85}>
            <Icon name="close-circle-outline" size={14} color="#fff" />
            <Text style={[s.ctaLockedText, {color: '#fff'}]}>BOOKING REJECTED · TAP TO RESTART</Text>
          </TouchableOpacity>
        ) : state === 'approved' ? (
          // Approved, wallet debit outstanding. Dismissing the auto-pay sheet
          // used to drop the user back onto a bar that still said "waiting for
          // approval" — state the real next action and let them resume it.
          <TouchableOpacity
            style={s.ctaLocked}
            onPress={() => { setCountdown(COUNTDOWN_SECONDS); setPayState('countdown'); }}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel="Approved — pay now">
            <Icon name="check-decagram" size={14} color={Colors.success} />
            <Text style={[s.ctaLockedText, {color: Colors.success}]}>APPROVED · PAY NOW</Text>
          </TouchableOpacity>
        ) : (
          <>
            {state === 'scheduled' && (
              // B-405 — the reservation is parked until the T-15 dispatch
              // sweep; hand the user back to home instead of a dead bar.
              <TouchableOpacity
                style={[s.ctaLocked, {marginBottom: 10}]}
                onPress={() => navigation.popToTop()}
                activeOpacity={0.85}
                accessibilityRole="button"
                accessibilityLabel="Back to home">
                <Icon name="home-outline" size={14} color={Colors.textPrimary} />
                <Text style={s.ctaLockedText}>APPROVED · BACK TO HOME</Text>
              </TouchableOpacity>
            )}
            {(state === 'pending' || state === 'scheduled') && (
              <Text style={s.cancelNote}>
                {state === 'scheduled'
                  ? 'Free to cancel until a protection officer accepts — nothing has been charged.'
                  : 'Last chance to cancel. Once the Bravo Control System assigns your detail, this booking can no longer be cancelled.'}
              </Text>
            )}
            {/* B-92 — escape hatch while the request sits in the ops queue; a
                scheduled reservation stays freely cancellable too (server-side
                this is pre-commitment: full stop, nothing charged). */}
            {(state === 'pending' || state === 'scheduled') && (
              <TouchableOpacity
                style={[s.cancelBtn, cancelling && {opacity: 0.55}]}
                activeOpacity={0.8}
                disabled={cancelling}
                accessibilityRole="button"
                accessibilityLabel="Cancel this request"
                onPress={cancelRequest}>
                {cancelling ? (
                  <ActivityIndicator size="small" color="#FF8B8B" />
                ) : (
                  <>
                    <Icon name="close-circle-outline" size={16} color="#FF8B8B" />
                    <Text style={s.cancelBtnText}>CANCEL REQUEST</Text>
                  </>
                )}
              </TouchableOpacity>
            )}
          </>
        )}
      </View>

      <Modal
        visible={payState !== 'idle'}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => { /* gated below by payState */ }}>
        <View style={s.sheetBg}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => { /* dismiss disabled */ }} />
          <View style={s.sheet}>
            <View style={s.sheetHandle} />
            {(payState === 'countdown' || payState === 'paying') && (
              <>
                <View style={s.sheetIconWrap}>
                  {payState === 'paying'
                    ? <LoadingView compact />
                    : <Text style={s.countdownNum}>{countdown}</Text>}
                </View>
                <Text style={s.sheetTitle}>AUTO-PAYING WITH BRAVO CREDITS</Text>
                <Text style={s.sheetSub}>
                  {payState === 'paying'
                    ? 'Charging your wallet…'
                    : `Charging in ${countdown}s · cancel to pay later`}
                </Text>
                <View style={s.mathBox}>
                  <PayRow k="YOU HAVE"     v={`${haveBc.toLocaleString()} BC`} />
                  <PayRow k="DEDUCTING"    v={`− ${chargeBc.toLocaleString()} BC`} accent />
                  <View style={s.mathDivider} />
                  <PayRow k="REMAINING"    v={`${Math.max(0, afterBc).toLocaleString()} BC`} bold big />
                </View>
                <TouchableOpacity
                  style={[s.sheetBtnGhost, payState === 'paying' && {opacity: 0.4}]}
                  disabled={payState === 'paying'}
                  onPress={() => setPayState('idle')}
                  activeOpacity={0.8}>
                  <Text style={s.sheetBtnGhostText}>CANCEL · I'LL PAY LATER</Text>
                </TouchableOpacity>
              </>
            )}

            {payState === 'paid' && paidSnapshot && (
              <>
                <View style={[s.sheetIconWrap, {backgroundColor: 'rgba(0,200,83,0.15)'}]}>
                  <Icon name="check-bold" size={40} color={Colors.success} />
                </View>
                <Text style={[s.sheetTitle, {color: Colors.success}]}>PAYMENT CAPTURED</Text>
                <Text style={s.sheetSub}>
                  Booking confirmed · sending you to the dashboard.
                </Text>
                <View style={s.mathBox}>
                  <PayRow k="WAS"        v={`${paidSnapshot.before.toLocaleString()} BC`} />
                  <PayRow k="DEDUCTED"   v={`− ${paidSnapshot.charged.toLocaleString()} BC`} accent />
                  <View style={s.mathDivider} />
                  <PayRow k="NEW BALANCE" v={`${paidSnapshot.after.toLocaleString()} BC`} bold big />
                </View>
              </>
            )}

            {payState === 'insufficient' && (
              <>
                <View style={[s.sheetIconWrap, {backgroundColor: 'rgba(255,193,7,0.12)'}]}>
                  <Icon name="alert-circle-outline" size={36} color={Colors.warning} />
                </View>
                <Text style={s.sheetTitle}>INSUFFICIENT BRAVO CREDITS</Text>
                <Text style={s.sheetSub}>
                  Top up to confirm your booking. We'll keep it reserved as{' '}
                  <Text style={{color: Colors.warning, fontWeight: '700'}}>Payment Pending</Text>.
                </Text>
                <View style={s.mathBox}>
                  <PayRow k="You have"  v={`${haveBc.toLocaleString()} BC`} />
                  <PayRow k="Need"      v={`${chargeBc.toLocaleString()} BC`} />
                  <View style={s.mathDivider} />
                  <PayRow k="Short"     v={`${Math.max(0, chargeBc - haveBc).toLocaleString()} BC`} bold accent />
                </View>
                <TouchableOpacity
                  style={s.sheetBtnPrimary}
                  onPress={() => {
                    if (!bookingId) {return;}
                    // Use push (not replace) so returning from the paywall
                    // lands the user back on OpsRoomReview with `payState`
                    // still set to 'insufficient'; the balance-watch effect
                    // below auto-retries the charge once the wallet covers
                    // the cost.
                    navigation.navigate('CreditPaywall', {
                      bookingId,
                      source: 'opsroom',
                      amountDue: chargeBc,
                    });
                  }}
                  activeOpacity={0.85}>
                  <Icon name="wallet-plus-outline" size={16} color="#fff" />
                  <Text style={s.sheetBtnPrimaryText}>TOP UP NOW</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={s.sheetBtnGhost}
                  onPress={() => setPayState('idle')}
                  activeOpacity={0.8}>
                  <Text style={s.sheetBtnGhostText}>I'LL TOP UP LATER</Text>
                </TouchableOpacity>
              </>
            )}

            {payState === 'error' && (
              <>
                <View style={[s.sheetIconWrap, {backgroundColor: 'rgba(244,67,54,0.12)'}]}>
                  <Icon name="alert-octagon-outline" size={36} color={Colors.danger} />
                </View>
                <Text style={s.sheetTitle}>PAYMENT FAILED</Text>
                <Text style={s.sheetSub}>{payError ?? 'Could not charge your wallet. Please retry.'}</Text>
                <TouchableOpacity
                  style={s.sheetBtnPrimary}
                  onPress={() => { setCountdown(COUNTDOWN_SECONDS); setPayState('countdown'); }}
                  activeOpacity={0.85}>
                  <Icon name="refresh" size={16} color="#fff" />
                  <Text style={s.sheetBtnPrimaryText}>RETRY</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={s.sheetBtnGhost}
                  onPress={() => setPayState('idle')}
                  activeOpacity={0.8}>
                  <Text style={s.sheetBtnGhostText}>CLOSE</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

function PayRow({k, v, bold, big, accent}: {k: string; v: string; bold?: boolean; big?: boolean; accent?: boolean}) {
  return (
    <View style={s.payRow}>
      <Text style={s.payK}>{k}</Text>
      <Text style={[s.payV, bold && s.payVBold, big && s.payVBig, accent && {color: Colors.warning}]}>{v}</Text>
    </View>
  );
}

function SumRow({k, v, highlight}: {k: string; v: string; highlight?: boolean}) {
  return (
    <View style={s.sumRow}>
      <Text style={s.sumK}>{k}</Text>
      <Text style={[s.sumV, highlight && s.sumVAcc]} numberOfLines={2}>{v}</Text>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: Colors.background},

  nav: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 12, gap: 12,
    borderBottomWidth: 1, borderBottomColor: Colors.surfaceBorder,
  },
  back: {
    width: 32, height: 32, borderRadius: 8,
    backgroundColor: Colors.surfaceElevated, borderWidth: 1, borderColor: Colors.surfaceBorder,
    alignItems: 'center', justifyContent: 'center',
  },
  // Issue 32 — same footprint as `back`, no chrome.
  backSpacer: {width: 32, height: 32},
  navTitle: {
    flex: 1,
    fontFamily: BravoFont.semiBold, fontSize: 13, letterSpacing: 1.5,
    color: Colors.textPrimary,
  },
  stepPill: {
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999,
    borderWidth: 1,
    backgroundColor: Colors.surfaceElevated,
  },
  stepPillWarn: {borderColor: Colors.warning},
  stepPillOk:   {borderColor: Colors.success},
  stepPillErr:  {borderColor: Colors.danger},
  stepPillText: {fontSize: 10, fontWeight: '700', letterSpacing: 1.2},
  stepPillTextWarn: {color: Colors.warning},
  stepPillTextOk:   {color: Colors.success},
  stepPillTextErr:  {color: Colors.danger},

  scroll: {flex: 1, paddingHorizontal: 16},

  reviewHero: {
    padding: 16, borderRadius: 12,
    backgroundColor: Colors.surfaceElevated, borderWidth: 1, borderColor: Colors.surfaceBorder,
    alignItems: 'center', overflow: 'hidden', position: 'relative',
  },
  heroTopLine: {
    position: 'absolute', top: 0, left: '15%', right: '15%', height: 1,
    backgroundColor: Colors.warning, opacity: 0.7,
  },
  hourglass: {
    width: 60, height: 60, borderRadius: 30,
    backgroundColor: 'rgba(255,193,7,0.12)',
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 10,
  },
  hourglassRing: {
    position: 'absolute', width: 64, height: 64, borderRadius: 32,
    borderWidth: 1, borderColor: 'rgba(255,193,7,0.35)',
    borderStyle: 'dashed',
  },
  heroTitle: {
    fontFamily: BravoFont.bold, fontSize: 13, letterSpacing: 1.2,
    color: Colors.textPrimary, marginBottom: 6,
  },
  heroDesc: {
    fontSize: 12, color: Colors.textSecondary,
    lineHeight: 17, textAlign: 'center', paddingHorizontal: 8,
  },
  heroDescB: {color: Colors.warning, fontWeight: '700'},
  cancelBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    alignSelf: 'stretch', height: 44, borderRadius: 12,
    backgroundColor: 'rgba(255,93,93,0.08)', borderWidth: 1, borderColor: 'rgba(255,93,93,0.3)',
  },
  cancelBtnText: {color: '#FF8B8B', fontSize: 11.5, fontWeight: '800', letterSpacing: 1.6},
  cancelNote: {
    fontSize: 11, lineHeight: 15, color: Colors.textMuted,
    textAlign: 'center', paddingHorizontal: 4, marginBottom: 8,
  },

  sumBox: {
    padding: 12, borderRadius: 10,
    backgroundColor: Colors.surfaceElevated, borderWidth: 1, borderColor: Colors.surfaceBorder,
  },
  sumHd: {
    fontFamily: BravoFont.semiBold, fontSize: 10,
    color: Colors.textMuted, letterSpacing: 1.5, marginBottom: 10,
  },
  sumRow: {
    flexDirection: 'row', justifyContent: 'space-between', gap: 10,
    paddingVertical: 6,
    borderTopWidth: 1, borderTopColor: Colors.surfaceBorder,
  },
  sumK: {
    fontFamily: BravoFont.medium, fontSize: 12,
    color: Colors.textMuted,
  },
  sumV: {
    flex: 1, textAlign: 'right',
    fontFamily: BravoFont.bold, fontSize: 11.5,
    color: Colors.textPrimary, letterSpacing: 0.2,
  },
  sumVAcc: {color: Colors.accent},
  sumEmpty: {fontSize: 12, color: Colors.textMuted, paddingVertical: 6},

  ctaWrap: {
    paddingHorizontal: 16, paddingTop: 12,
    borderTopWidth: 1, borderTopColor: Colors.surfaceBorder,
    backgroundColor: Colors.background,
  },
  ctaLocked: {
    height: 48, borderRadius: 8,
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.borderDefault,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  ctaLockedText: {
    fontFamily: BravoFont.bold, fontSize: 12.5, color: Colors.textPrimary,
    letterSpacing: 1.2,
  },

  // Auto-pay countdown sheet
  sheetBg: {
    flex: 1, justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.65)',
  },
  sheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingHorizontal: 20, paddingTop: 10, paddingBottom: 28,
    borderTopWidth: 1, borderTopColor: Colors.surfaceBorder,
    alignItems: 'center', gap: 12,
  },
  sheetHandle: {
    width: 36, height: 4, borderRadius: 2,
    backgroundColor: Colors.borderDefault, marginBottom: 8,
  },
  sheetIconWrap: {
    width: 80, height: 80, borderRadius: 40,
    backgroundColor: 'rgba(37,99,235,0.12)',
    alignItems: 'center', justifyContent: 'center',
  },
  countdownNum: {
    fontFamily: BravoFont.bold, fontSize: 40,
    color: Colors.primary, letterSpacing: -1,
  },
  sheetTitle: {
    fontFamily: BravoFont.bold, fontSize: 13, letterSpacing: 1.4,
    color: Colors.textPrimary, marginTop: 4, textAlign: 'center',
  },
  sheetSub: {
    fontSize: 12, color: Colors.textSecondary,
    lineHeight: 17, textAlign: 'center', paddingHorizontal: 4,
  },

  mathBox: {
    width: '100%',
    padding: 14, borderRadius: 10,
    backgroundColor: Colors.surfaceElevated,
    borderWidth: 1, borderColor: Colors.surfaceBorder,
    gap: 8, marginTop: 4,
  },
  mathDivider: {height: 1, backgroundColor: Colors.surfaceBorder, marginVertical: 2},
  payRow: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'},
  payK: {fontSize: 11, color: Colors.textMuted, letterSpacing: 1.2, fontWeight: '700'},
  payV: {fontSize: 15, color: Colors.textPrimary, fontWeight: '700'},
  payVBold: {fontFamily: BravoFont.bold},
  payVBig: {fontSize: 22, color: Colors.success, letterSpacing: -0.3},

  sheetBtnPrimary: {
    width: '100%', height: 48, borderRadius: 10,
    backgroundColor: Colors.primary,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    marginTop: 6,
  },
  sheetBtnPrimaryText: {
    fontFamily: BravoFont.bold, fontSize: 12.5, color: '#fff',
    letterSpacing: 1.2,
  },
  sheetBtnGhost: {
    width: '100%', height: 44, borderRadius: 10,
    borderWidth: 1, borderColor: Colors.borderDefault,
    alignItems: 'center', justifyContent: 'center',
  },
  sheetBtnGhostText: {
    fontFamily: BravoFont.semiBold, fontSize: 11.5,
    color: Colors.textMuted, letterSpacing: 1.2,
  },
}));
