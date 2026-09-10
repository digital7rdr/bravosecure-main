/**
 * Executive Protection — the consolidated Booking dashboard (Wave 5c, PDF-2).
 *
 * The 7-screen wizard collapsed into ONE scrollable dashboard, grown IN PLACE on
 * this screen (it already owns confirmBooking + the consent gate + the credit-
 * error call site + the status routing). The earlier six steps fold in as
 * sections that write the SAME bookingStore draft fields — no field renamed, no
 * value changed:
 *   1. Duration   (from ExecDurationScreen)   → duration_hours (grid over EXEC_DURATIONS)
 *   2. Schedule   (from ExecScheduleScreen)   → mode / start_time, rebases
 *                                               transport_pickup_time (B-382)
 *   3. Task       (from ExecTaskScreen)        → pickup (service location, pushed
 *                                               LocationPicker) / task_type / notes
 *   4. Transport  (from ExecTransportScreen)   → transport_mode + legs, progressive
 *                                               disclosure preserved
 *   5. Team       (from ExecTeamScreen)        → cpo_count / vehicle_count /
 *                                               driver_only / addon_switches /
 *                                               selected_add_ons / estimated_price
 *   6. Consent + Calculation + Submit          → the current ExecReview body +
 *                                               confirmBooking(), status routing and
 *                                               the CreditPaywall branch, verbatim.
 *
 * Submit mirrors the Lite review exactly (same store call + routing):
 * DISPATCHING → FindingDetail · NO_PROVIDER → NoDetail · legacy →
 * OpsRoomReview · insufficient_credits → CreditPaywall.
 */
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, StatusBar,
  ActivityIndicator, Switch, TextInput, Platform, Modal, Pressable, Animated,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useBottomInset} from '@hooks/useBottomInset';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import FitLine from '@components/ui/FitLine';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import DateTimePicker, {type DateTimePickerEvent} from '@react-native-community/datetimepicker';
import {openAndroidDatePicker} from '@components/booking/androidPicker';
import type {BookingStackParamList} from '@navigation/types';
import {useBookingStore, type BookingMode} from '@store/bookingStore';
import {useAuthStore} from '@store/authStore';
import {useWalletStore} from '@store/walletStore';
import {bookingApi} from '@services/api';
import {isInsufficientCreditsError, creditShortfallFrom, shortfallFor, humanCreditMessage} from '@screens/booking/creditErrors';
import {MIN_LEAD_HOURS} from '@screens/booking/scheduleGate';
import {vehiclesForPassengers, maxCposForClientVehicle, MAX_CPOS} from '@screens/booking/pricing';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';
import {Alert} from '@utils/alert';
import TimeDropdownField from '@components/booking/TimeDropdownField';
import {formatTime12h, roundUpToMinuteStep} from '@components/booking/time12h';
import {resolveTransferTime, transferTimeOutOfWindow} from './transferTime';
import {
  EXEC_DURATIONS, EXEC_TASK_TYPES, EXEC_TRANSPORT_MODES, execTaskLabel,
  type ExecTransportMode,
} from './executiveProduct';
import {EXEC_ADDONS, execAddOnsBcPerHour, execRateBcPerHour, execTotalBc} from './executivePricing';
import {execPriceLines, execPriceSummary} from './execPriceSummary';
import {useServicePricingStore} from '@store/servicePricingStore';

type Nav = NativeStackNavigationProp<BookingStackParamList, 'ExecReview'>;
type Rt  = RouteProp<BookingStackParamList, 'ExecReview'>;

const NOTES_MAX = 500;

const MODE_LABELS: Record<ExecTransportMode, string> = {
  one_way: 'One Way', return: 'Return', both_ways: 'Both Ways',
};

// Design tokens — obsidian/cobalt premium (mirrors the executive/Lite wizard).
const D = {
  bg:         '#07090D',
  text:       '#F2F4F8',
  textDim:    'rgba(229,233,242,0.62)',
  textMute:   'rgba(180,188,204,0.45)',
  textFaint:  'rgba(180,188,204,0.28)',
  hair:       'rgba(255,255,255,0.06)',
  hair2:      'rgba(255,255,255,0.09)',
  accent:     '#5B8DEF',
  accentDeep: '#2F5BE0',
  accentSoft: '#A9C5FF',
  amber:      '#F5C76B',
  signal:     '#4ADE80',
  fSans:    'Manrope_500Medium',
  fSemi:    'Manrope_600SemiBold',
  fBold:    'Manrope_700Bold',
  fMono:    'monospace',
};

/** Earliest bookable "later" start = now + lead, rounded up to 5 min. */
function earliestLater(): Date {
  return roundUpToMinuteStep(new Date(Date.now() + MIN_LEAD_HOURS * 3600_000), 5);
}

export default function ExecReviewScreen() {
  // Live ops-editable pricing (founder 2026-08-26): subscribe so a
  // hydration re-renders the quote; load is single-flight + fail-open.
  useServicePricingStore(st => st.overrides);
  const loadServicePricing = useServicePricingStore(st => st.load);
  useEffect(() => { void loadServicePricing(); }, [loadServicePricing]);

  const insets = useSafeAreaInsets();
  const {bottomPad} = useBottomInset();
  const navigation = useNavigation<Nav>();
  const route = useRoute<Rt>();
  const startExecutiveDraft = useBookingStore(st => st.startExecutiveDraft);
  const updateDraft = useBookingStore(st => st.updateDraft);
  const confirmBooking = useBookingStore(st => st.confirmBooking);
  const draft = useBookingStore(st => st.draft);
  const walletCredits = useWalletStore(st => st.balance?.bravo_credits);
  const consentRequired = useAuthStore(st => st.user?.auto_dispatch_enabled === true);

  const [submitting, setSubmitting] = useState(false);

  // Every entry path (the ServiceType "Executive Protection" card, a deep link)
  // funnels through this mount — the one place the executive draft is seeded.
  // Idempotent while an executive draft is in progress (execDraftSeed pins it), so
  // a re-entry never wipes in-progress selections.
  useEffect(() => { startExecutiveDraft(); }, [startExecutiveDraft]);

  // ── Schedule state (folded from ExecScheduleScreen) ──────────────────────────
  const earliest = useMemo(earliestLater, []);
  const [mode, setMode] = useState<BookingMode>(draft.mode ?? 'now');
  const [laterDate, setLaterDate] = useState<Date>(() => {
    const prev = draft.start_time ? new Date(draft.start_time) : null;
    return prev && !Number.isNaN(prev.getTime()) && prev.getTime() >= earliest.getTime()
      ? prev
      : earliest;
  });
  const [dateOpen, setDateOpen] = useState(false);
  const [leadError, setLeadError] = useState<string | null>(null);

  const slide = useRef(new Animated.Value(mode === 'now' ? 0 : 1)).current;
  useEffect(() => {
    Animated.timing(slide, {toValue: mode === 'now' ? 0 : 1, duration: 220, useNativeDriver: true}).start();
  }, [mode, slide]);
  const [toggleTrackW, setToggleTrackW] = useState(0);
  const pillWidth = Math.max(0, (toggleTrackW - 12) / 2);
  const pillX = slide.interpolate({inputRange: [0, 1], outputRange: [0, pillWidth]});

  // Write mode + start_time together (as ExecSchedule.handleContinue did), and
  // rebase a custom transfer time onto the new start DAY through the SAME resolver
  // the transport section uses (B-382) — a hand-rolled same-day stamp collapsed a
  // next-day (overnight-block) transfer and silently wiped it.
  useEffect(() => {
    const start = mode === 'now' ? new Date() : new Date(laterDate);
    let transferRebase: {transport_pickup_time: string} | null = null;
    if (draft.transport_pickup_time) {
      const prev = new Date(draft.transport_pickup_time);
      if (Number.isNaN(prev.getTime())) {
        transferRebase = {transport_pickup_time: ''};
      } else {
        const rebased = resolveTransferTime(start, draft.duration_hours, prev.getHours(), prev.getMinutes());
        const ok = !transferTimeOutOfWindow(rebased.toISOString(), start, draft.duration_hours);
        transferRebase = {transport_pickup_time: ok ? rebased.toISOString() : ''};
      }
    }
    updateDraft({mode, start_time: start.toISOString(), ...transferRebase});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, laterDate, draft.duration_hours]);

  // Date pick and time pick both land here: snap UP to the next 5-minute boundary,
  // then the lead rule.
  const commitLater = (picked: Date) => {
    const d = roundUpToMinuteStep(picked, 5);
    const floor = Date.now() + MIN_LEAD_HOURS * 3600_000;
    if (d.getTime() < floor) {
      // Reject + auto-correct inline, never silently book a different time.
      const fixed = earliestLater();
      setLaterDate(fixed);
      setLeadError(
        `Scheduled bookings need a ${MIN_LEAD_HOURS}-hour lead. Earliest start: ` +
        `${fixed.toLocaleDateString(undefined, {weekday: 'short', day: '2-digit', month: 'short'})} · ${formatTime12h(fixed.getHours(), fixed.getMinutes())}.`,
      );
    } else {
      setLaterDate(d);
      setLeadError(null);
    }
  };

  // iOS spinner only — Android goes through openDate() below. 'set' is the only
  // action that commits: the library's dismiss path hands back the ORIGINAL date,
  // so checking `d` alone would treat Cancel as a pick.
  const onLaterDateChange = (ev: DateTimePickerEvent, d?: Date) => {
    if (ev.type !== 'set' || !d) {return;}
    commitLater(d);
  };

  const onLaterTimeChange = (h: number, m: number) => {
    const next = new Date(laterDate);
    next.setHours(h, m, 0, 0);
    commitLater(next);
  };

  // Android opens the native dialog IMPERATIVELY from the gesture; a declarative
  // mount re-opens and resets it on every re-render (see androidDatePicker.ts).
  const openDate = () => {
    if (Platform.OS !== 'android') {setDateOpen(true); return;}
    openAndroidDatePicker({
      value: laterDate,
      minimumDate: new Date(Date.now() + MIN_LEAD_HOURS * 3600_000),
      // No auto-chain into the time picker: the founder removed the ref, and a
      // second dialog springing up on its own is what made Cancel feel like a
      // loop (B-643). The user taps the time field when they want it.
      onPicked: commitLater,
    });
  };

  const scheduleValid = mode === 'now'
    || laterDate.getTime() >= Date.now() + MIN_LEAD_HOURS * 3600_000;

  // ── Task + Transport shared location picker (folded from Exec Task/Transport) ──
  // The picker returns only its `kind` (pickup/dropoff); the dashboard hosts THREE
  // location slots — the service pickup and the transfer pickup are BOTH `pickup` —
  // so a per-open ref names the slot the merged pick belongs to (the instance
  // survives the picker round-trip, same as ExecTask's autoOpened ref).
  const pendingSlot = useRef<'service' | 'transfer_pickup' | 'transfer_dropoff' | null>(null);

  useEffect(() => {
    const p = route.params;
    if (!p?.pickedAt || typeof p.pickedLat !== 'number' || typeof p.pickedLng !== 'number') {return;}
    const loc = {address: p.pickedAddress ?? 'Selected location', latitude: p.pickedLat, longitude: p.pickedLng};
    const slot = pendingSlot.current ?? (p.pickedKind === 'dropoff' ? 'transfer_dropoff' : 'service');
    if (slot === 'service') {
      updateDraft({pickup: {...loc, label: 'Service location'}});
    } else if (slot === 'transfer_pickup') {
      updateDraft({transport_pickup: {...loc, label: 'Transfer pick-up'}});
    } else {
      updateDraft({transport_dropoff: {...loc, label: 'Transfer drop-off'}});
    }
    pendingSlot.current = null;
    navigation.setParams({
      pickedAt: undefined, pickedAddress: undefined,
      pickedLat: undefined, pickedLng: undefined, pickedKind: undefined,
    } as never);
  }, [route.params, navigation, updateDraft]);

  const openServicePicker = () => {
    pendingSlot.current = 'service';
    const init = draft.pickup
      ? {latitude: draft.pickup.latitude, longitude: draft.pickup.longitude, address: draft.pickup.address}
      : undefined;
    navigation.navigate('LocationPicker', {
      kind: 'pickup', countryCode: draft.zone_code || 'AE', initial: init, onPickRouteKey: 'ExecReview',
    });
  };

  const openTransferPicker = (kind: 'pickup' | 'dropoff') => {
    pendingSlot.current = kind === 'pickup' ? 'transfer_pickup' : 'transfer_dropoff';
    const current = kind === 'pickup' ? draft.transport_pickup : draft.transport_dropoff;
    const init = current ?? draft.pickup; // fall back to the service location's country
    navigation.navigate('LocationPicker', {
      kind, countryCode: draft.zone_code || 'AE',
      initial: init ? {latitude: init.latitude, longitude: init.longitude, address: init.address} : undefined,
      onPickRouteKey: 'ExecReview',
    });
  };

  const [typeOpen, setTypeOpen] = useState(false);
  const pickupReady = !!draft.pickup;

  // ── Transport section derived state (folded from ExecTransportScreen) ─────────
  const enabled = draft.transport_mode !== 'none';
  const startDate = draft.start_time ? new Date(draft.start_time) : new Date();
  const startLabel = formatTime12h(startDate.getHours(), startDate.getMinutes());
  const durationH = draft.duration_hours || 3;

  const setTransportEnabled = (on: boolean) => {
    if (on) {
      updateDraft({
        transport_mode: 'one_way',
        vehicle_count: Math.max(1, vehiclesForPassengers(draft.passengers)),
      });
    } else {
      updateDraft({transport_mode: 'none', vehicle_count: 0, driver_only: false});
    }
  };

  const setPassengers = (n: number) => {
    const passengers = Math.max(1, Math.min(12, n));
    updateDraft({
      passengers,
      vehicle_count: draft.driver_only ? 0 : Math.max(1, vehiclesForPassengers(passengers)),
      ...(draft.driver_only
        ? {cpo_count: Math.max(1, Math.min(draft.cpo_count, maxCposForClientVehicle(passengers)))}
        : null),
    });
  };

  const onTransferTimeChange = (h: number, m: number) => {
    updateDraft({transport_pickup_time: resolveTransferTime(startDate, durationH, h, m).toISOString()});
  };
  const transferPickerSeed = draft.transport_pickup_time ? new Date(draft.transport_pickup_time) : startDate;

  const transferOutOfWindow = enabled && !!draft.transport_pickup_time
    && transferTimeOutOfWindow(draft.transport_pickup_time, startDate, durationH);
  const legsMissing = enabled && (!draft.transport_pickup || !draft.transport_dropoff);

  const transferTimeLabel = draft.transport_pickup_time
    ? (() => {
        const t = new Date(draft.transport_pickup_time);
        const dayDelta = Math.round(
          (new Date(t).setHours(0, 0, 0, 0) - new Date(startDate).setHours(0, 0, 0, 0)) / 86_400_000);
        const daySuffix = dayDelta === 1 ? ' (next day)' : dayDelta === -1 ? ' (day before)' : '';
        return `${formatTime12h(t.getHours(), t.getMinutes())}${daySuffix}`;
      })()
    : `Same as start time (${startLabel})`;

  // ── Team section (folded from ExecTeamScreen) ────────────────────────────────
  const hasTransport = enabled;
  const minVehicles = hasTransport && !draft.driver_only
    ? Math.max(1, vehiclesForPassengers(draft.passengers))
    : 0;
  const maxCpos = draft.driver_only ? maxCposForClientVehicle(draft.passengers) : MAX_CPOS;

  // Keep the team consistent when the transport section shrinks the seat cap or the
  // vehicle floor — the rate card, the calculation and the server must price the
  // same team.
  useEffect(() => {
    if (draft.cpo_count > maxCpos) {updateDraft({cpo_count: Math.max(1, maxCpos)});}
    if (!draft.driver_only && hasTransport && draft.vehicle_count < minVehicles) {
      updateDraft({vehicle_count: minVehicles});
    }
  }, [draft.cpo_count, draft.vehicle_count, draft.driver_only, maxCpos, minVehicles, hasTransport, updateDraft]);

  const selectedAddOns = useMemo(
    () => EXEC_ADDONS.filter(a => draft.addon_switches[a.id]),
    [draft.addon_switches],
  );
  const selectedAddOnIds = useMemo(() => selectedAddOns.map(a => a.id), [selectedAddOns]);

  const [serverTotal, setServerTotal] = useState<number | null>(null);
  const estimateSeq = useRef(0);

  useEffect(() => {
    const seq = ++estimateSeq.current;
    setServerTotal(null);
    const t = setTimeout(() => {
      void (async () => {
        try {
          const {data} = await bookingApi.estimatePrice({
            type: 'timeslot',
            service: 'executive_protection',
            duration_hours: draft.duration_hours,
            add_ons: selectedAddOnIds,
            region: draft.region,
            cpo_count: draft.cpo_count,
            vehicle_count: draft.vehicle_count,
            driver_only: draft.driver_only,
            passengers: draft.passengers,
            pickup_time: draft.start_time || undefined,
          });
          if (estimateSeq.current === seq) {setServerTotal(data.total);}
        } catch {
          // Offline / transient — the local mirror stays on screen.
        }
      })();
    }, 400);
    return () => clearTimeout(t);
  }, [draft.cpo_count, draft.vehicle_count, draft.driver_only, draft.duration_hours,
    draft.region, draft.start_time, draft.passengers, selectedAddOnIds]);

  const hours = draft.duration_hours;
  const localRate = execRateBcPerHour({
    cpoCount: draft.cpo_count,
    vehicleCount: draft.vehicle_count,
    driverOnly: draft.driver_only,
    addOnsBcPerHour: execAddOnsBcPerHour(selectedAddOnIds),
  });
  const totalBc = serverTotal ?? execTotalBc(localRate, hours);

  const setCpos = (n: number) => updateDraft({cpo_count: Math.max(1, Math.min(maxCpos, n))});
  const setVehicles = (n: number) => updateDraft({vehicle_count: Math.max(minVehicles, Math.min(4, n))});
  const setDriverOnly = (on: boolean) => {
    if (on) {
      updateDraft({
        driver_only: true,
        vehicle_count: 0,
        cpo_count: Math.min(draft.cpo_count, maxCposForClientVehicle(draft.passengers)),
      });
    } else {
      updateDraft({driver_only: false, vehicle_count: Math.max(1, vehiclesForPassengers(draft.passengers))});
    }
  };
  const toggleAddOn = (id: string) => {
    const switches = {...draft.addon_switches, [id]: !draft.addon_switches[id]};
    updateDraft({
      addon_switches: switches,
      selected_add_ons: EXEC_ADDONS.filter(a => switches[a.id]).map(a => a.id),
    });
  };

  // ── Calculation lines (folded from the current ExecReview body) ──────────────
  // Same lines as before, now tagged base / transfer so the card can show the two
  // subtotals above the total (the total itself is untouched).
  const lines = useMemo(() => execPriceLines({
    cpoCount: draft.cpo_count,
    vehicleCount: draft.vehicle_count,
    driverOnly: draft.driver_only,
    selectedAddOns,
  }), [draft.cpo_count, draft.vehicle_count, draft.driver_only, selectedAddOns]);
  const {baseBc, transferBc} = execPriceSummary(lines, hours);
  // Why: the subtotals are the LOCAL catalogue split, while the total row shows
  // the server estimate once it lands. If the two ever disagree (catalogue
  // drift), a split that does not add up to the total on the same card is
  // worse than no split — so the split is shown only while it is consistent.
  const splitConsistent = serverTotal === null || Math.abs(serverTotal - (baseBc + transferBc)) < 0.5;

  const consentGiven = draft.location_consent === true;
  const ctaBlocked =
    submitting ||
    (consentRequired && !consentGiven) ||
    !pickupReady ||
    !scheduleValid ||
    legsMissing ||
    transferOutOfWindow;

  const gateHint =
    !pickupReady ? 'Confirm your service location to continue.'
    : !scheduleValid ? (leadError ?? `Scheduled bookings need a ${MIN_LEAD_HOURS}-hour lead.`)
    : legsMissing ? (!draft.transport_pickup ? 'Add the transfer pickup location to continue.' : 'Add the transfer drop-off location to continue.')
    : transferOutOfWindow ? 'Pick a transfer time inside the allowed window (or reset it to the start time).'
    : (consentRequired && !consentGiven) ? 'Confirm the consent above to continue.'
    : null;

  // ── Submit (the current ExecReview handleSubmit, verbatim below confirmBooking) ─
  const handleSubmit = async () => {
    if (ctaBlocked) {return;}
    // Pin the resolved add-ons + the live escrow total the way ExecTeam did before
    // navigating here — same values, same timing relative to confirmBooking().
    updateDraft({selected_add_ons: selectedAddOnIds, estimated_price: totalBc});
    setSubmitting(true);
    try {
      const booking = await confirmBooking();
      const st = (booking.status ?? '').toString().toUpperCase();
      if (st === 'DISPATCHING') {
        navigation.navigate('FindingDetail', {bookingId: booking.id});
      } else if (st === 'NO_PROVIDER') {
        navigation.navigate('NoDetail', {bookingId: booking.id});
      } else if (booking.booking_mode === 'later') {
        // B-405 — scheduled executive details go home too: upcoming card on
        // BookingHome; approval + T-60 reminder arrive as pushes.
        navigation.popToTop();
        Alert.alert(
          'Booking scheduled',
          'Your request is with the Bravo Control System for approval. ' +
          "We'll notify you when it's approved and remind you 1 hour before start. " +
          'You can keep using the app in the meantime — and book another service while this one waits.',
        );
      } else {
        navigation.navigate('OpsRoomReview', {bookingId: booking.id});
      }
    } catch (e) {
      const direct = e as {code?: string; amountDue?: number; bookingId?: string};
      if (isInsufficientCreditsError(e)) {
        navigation.navigate('CreditPaywall', {
          source: 'booking-flow',
          amountDue: creditShortfallFrom(e) ?? shortfallFor(totalBc, walletCredits),
        });
        return;
      }
      if (direct?.code === 'consent_required') {
        Alert.alert('Consent required', 'Please confirm location-sharing consent to find an agency.');
        return;
      }
      const msg = (e as {response?: {data?: {code?: string; booking_id?: string; message?: string}}})?.response?.data;
      const activeId = msg?.booking_id ?? direct?.bookingId;
      if ((msg?.code ?? direct?.code) === 'active_booking_exists' && activeId) {
        navigation.navigate('OpsRoomReview', {bookingId: activeId});
        return;
      }
      // B-380 — raw server codes (family_spend_limit_exceeded) must never render.
      const rawMsg = msg?.message ?? (e as Error).message ?? '';
      Alert.alert(
        'Booking failed',
        humanCreditMessage(rawMsg) ?? (rawMsg || 'Could not submit booking. Please try again.'),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={D.bg} />
      <View pointerEvents="none" style={s.ambient} />

      {/* ── Header ── */}
      <View style={s.header}>
        <TouchableOpacity
          style={s.back}
          onPress={() => goBackOnce(navigation)}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
          <Icon name="chevron-left" size={20} color={D.text} />
        </TouchableOpacity>
        <View style={{flex: 1, minWidth: 0}}>
          <Text style={s.headerTitle} numberOfLines={1} ellipsizeMode="tail">Executive Protection</Text>
          <FitLine style={s.headerSub} text={'BUILD & CONFIRM YOUR DETAIL'} />
        </View>
      </View>

      <ScrollView
        style={{flex: 1}}
        contentContainerStyle={{paddingHorizontal: 20, paddingBottom: 180, paddingTop: 4, gap: 16}}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}>

        {/* ── 1 · Duration (folded from ExecDurationScreen) ── */}
        <View>
          <Text style={s.fieldLabel}>DURATION</Text>
          <View style={s.grid}>
            {EXEC_DURATIONS.map(h => {
              const selected = draft.duration_hours === h;
              return (
                <TouchableOpacity
                  key={h}
                  activeOpacity={0.85}
                  onPress={() => updateDraft({duration_hours: h})}
                  accessibilityRole="button"
                  accessibilityLabel={`${h} hours`}
                  accessibilityState={{selected}}
                  style={[s.cell, selected ? s.cellSelected : s.cellIdle]}>
                  {selected && <View style={s.cellTopLight} />}
                  <Text style={[s.cellText, selected && s.cellTextSelected]}>{h} hrs</Text>
                  <View style={[s.cellCheck, !selected && s.cellCheckHidden]}>
                    <Icon name="check" size={13} color="#fff" />
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
          {/* Long-term upsell — beyond 24 h is a Bravo Secure Pro plan (same copy +
              target as the skipped ExecDuration step). */}
          <TouchableOpacity
            style={s.proCard}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel="Need cover for longer than 24 hours? Explore Bravo Secure Pro"
            onPress={() => navigation.navigate('SecureServices')}>
            <View style={s.proIcon}>
              <Icon name="star-four-points" size={16} color={D.accentSoft} />
            </View>
            <View style={{flex: 1, minWidth: 0}}>
              <Text style={s.proTitle}>Need cover for longer than 24 hours?</Text>
              <Text style={s.proSub}>Explore Bravo Secure Pro for Long-Term Bookings.</Text>
            </View>
            <Icon name="chevron-right" size={20} color={D.textMute} />
          </TouchableOpacity>
        </View>

        {/* ── 2 · Schedule (folded from ExecScheduleScreen) ── */}
        <View style={{gap: 14}}>
          <Text style={s.fieldLabel}>SCHEDULE · START TIME</Text>

          <View style={s.toggle} onLayout={e => setToggleTrackW(e.nativeEvent.layout.width)}>
            {toggleTrackW > 0 && (
              <Animated.View style={[s.togglePillWrap, {width: pillWidth, transform: [{translateX: pillX}]}]}>
                <LinearGradient
                  colors={['#6E9BF5', D.accent, D.accentDeep]}
                  locations={[0, 0.6, 1]}
                  start={{x: 0, y: 0}}
                  end={{x: 0, y: 1}}
                  style={s.togglePill}
                />
              </Animated.View>
            )}
            <TouchableOpacity
              style={s.toggleSeg}
              onPress={() => { setMode('now'); setLeadError(null); }}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityState={{selected: mode === 'now'}}>
              <Text style={[s.toggleT, mode === 'now' && s.toggleTOn]} numberOfLines={1}>Book Now</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={s.toggleSeg}
              onPress={() => { setMode('later'); setLeadError(null); }}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityState={{selected: mode === 'later'}}>
              <Text style={[s.toggleT, mode === 'later' && s.toggleTOn]} numberOfLines={1}>Book Later</Text>
            </TouchableOpacity>
          </View>

          {mode === 'now' ? (
            <View style={s.nowCard}>
              <View style={s.nowIcon}>
                <Icon name="flash" size={18} color={D.signal} />
              </View>
              <Text style={s.nowText}>
                Your protection detail is dispatched <Text style={s.nowStrong}>immediately</Text> after
                booking — the {draft.duration_hours}-hour block starts when the team goes live at your location.
              </Text>
            </View>
          ) : (
            <>
              <View>
                <Text style={s.subLabel}>DATE</Text>
                <TouchableOpacity
                  style={s.pickRow}
                  onPress={openDate}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                  accessibilityLabel="Choose date">
                  <View style={s.pickIcon}><Icon name="calendar" size={16} color={D.accent} /></View>
                  <Text style={s.pickText} numberOfLines={1}>
                    {laterDate.toLocaleDateString(undefined, {weekday: 'short', day: '2-digit', month: 'short', year: 'numeric'})}
                  </Text>
                  <Icon name="chevron-right" size={16} color={D.textMute} />
                </TouchableOpacity>
              </View>
              <View>
                <Text style={s.subLabel}>START TIME</Text>
                <TimeDropdownField
                  hour={laterDate.getHours()}
                  minute={laterDate.getMinutes()}
                  onChange={onLaterTimeChange}
                  minuteStep={5}
                  title="START TIME"
                  accessibilityLabel="Choose start time"
                />
              </View>
              {(() => {
                const live = earliestLater();
                const dayWord = live.getDate() === new Date().getDate() ? 'today' : 'tomorrow';
                return (
                  <View style={[s.alertWarn, leadError !== null && s.alertWarnHot]}>
                    <Icon name="alert" size={18} color={D.amber} style={{marginTop: 1}} />
                    <Text style={s.alertText}>
                      {leadError ?? (
                        <>
                          <Text style={s.alertBold}>Minimum {MIN_LEAD_HOURS}-hour lead time</Text> for all
                          scheduled bookings. Earliest available time {dayWord} is{' '}
                          {formatTime12h(live.getHours(), live.getMinutes())}.
                        </>
                      )}
                    </Text>
                  </View>
                );
              })()}
            </>
          )}
        </View>

        {/* ── 3 · Task (folded from ExecTaskScreen) ── */}
        <View>
          <Text style={s.fieldLabel}>SERVICE LOCATION</Text>
          <TouchableOpacity
            style={[s.locRow, draft.pickup ? s.locRowFilled : s.locRowIdle]}
            onPress={openServicePicker}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel={draft.pickup ? `Service location: ${draft.pickup.address}. Edit` : 'Select service location'}>
            <View style={[s.locPin, draft.pickup ? s.locPinFilled : s.locPinIdle]}>
              <Icon name={draft.pickup ? 'map-marker' : 'map-marker-outline'} size={16} color={draft.pickup ? D.accent : D.textMute} />
            </View>
            <Text style={[s.locText, draft.pickup ? s.locTextFilled : s.locTextPlaceholder]} numberOfLines={2}>
              {draft.pickup?.address ?? 'Select service location…'}
            </Text>
            <Text style={s.locEdit}>{draft.pickup ? 'Edit' : ''}</Text>
            <Icon name="chevron-right" size={16} color={D.textMute} />
          </TouchableOpacity>
        </View>

        <View>
          <Text style={s.fieldLabel}>TASK TYPE</Text>
          <TouchableOpacity
            style={s.typeRow}
            onPress={() => setTypeOpen(o => !o)}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityState={{expanded: typeOpen}}
            accessibilityLabel={`Task type: ${execTaskLabel(draft.task_type)}`}>
            <View style={s.typeIcon}>
              <Icon name={EXEC_TASK_TYPES.find(t => t.key === draft.task_type)?.icon ?? 'shield-account'} size={16} color={D.accentSoft} />
            </View>
            <Text style={s.typeText} numberOfLines={1}>{execTaskLabel(draft.task_type)}</Text>
            <Icon name={typeOpen ? 'chevron-up' : 'chevron-down'} size={18} color={D.textMute} />
          </TouchableOpacity>
          {typeOpen && (
            <View style={s.typeList}>
              {EXEC_TASK_TYPES.map((t, i) => {
                const selected = t.key === draft.task_type;
                return (
                  <TouchableOpacity
                    key={t.key}
                    style={[s.typeOption, i > 0 && s.typeOptionDivider]}
                    onPress={() => { updateDraft({task_type: t.key}); setTypeOpen(false); }}
                    activeOpacity={0.8}
                    accessibilityRole="button"
                    accessibilityState={{selected}}>
                    <Icon name={t.icon} size={16} color={selected ? D.accentSoft : D.textMute} />
                    <Text style={[s.typeOptionText, selected && s.typeOptionTextOn]} numberOfLines={1}>{t.label}</Text>
                    {selected && <Icon name="check" size={16} color={D.accent} />}
                  </TouchableOpacity>
                );
              })}
            </View>
          )}
        </View>

        <View>
          <Text style={s.fieldLabel}>FURTHER DESCRIPTION (OPTIONAL)</Text>
          <TextInput
            style={s.notes}
            value={draft.notes}
            onChangeText={t => updateDraft({notes: t.slice(0, NOTES_MAX)})}
            placeholder="e.g. Event support at hotel, access control at site entrance, discreet presence, etc."
            placeholderTextColor={D.textFaint}
            multiline
            textAlignVertical="top"
            maxLength={NOTES_MAX}
            accessibilityLabel="Further description"
          />
          <Text style={s.notesCount}>{draft.notes.length}/{NOTES_MAX}</Text>
        </View>

        {/* ── 4 · Transport (folded from ExecTransportScreen — progressive disclosure) ── */}
        <View style={{gap: 14}}>
          <Text style={s.fieldLabel}>TRANSPORT SUPPORT (OPTIONAL)</Text>
          <View style={s.toggleCard}>
            <View style={s.toggleIcon}><Icon name="car-estate" size={18} color={D.accentSoft} /></View>
            <View style={{flex: 1, minWidth: 0}}>
              <Text style={s.toggleTitle}>Add Secure Transfer</Text>
              <Text style={s.toggleSub}>to this booking</Text>
            </View>
            <Switch
              value={enabled}
              onValueChange={setTransportEnabled}
              trackColor={{false: 'rgba(255,255,255,0.12)', true: D.accentDeep}}
              thumbColor={enabled ? D.accentSoft : '#8B93A5'}
              accessibilityLabel="Add secure transfer to this booking"
            />
          </View>

          {!enabled ? (
            <View style={s.optionalCard}>
              <View style={s.optionalIcon}><Icon name="information-outline" size={16} color={D.accentSoft} /></View>
              <View style={{flex: 1, minWidth: 0}}>
                <Text style={s.optionalTitle}>Transport is optional</Text>
                <Text style={s.optionalText}>
                  Add transfers if required. You can continue without adding transport — your
                  protection detail operates at the service location.
                </Text>
              </View>
            </View>
          ) : (
            <>
              <View>
                <Text style={s.subLabel}>TRANSFER TYPE</Text>
                <View style={s.modeRow}>
                  {EXEC_TRANSPORT_MODES.map(m => {
                    const on = draft.transport_mode === m;
                    return (
                      <TouchableOpacity
                        key={m}
                        style={[s.modeChip, on ? s.modeChipOn : s.modeChipIdle]}
                        onPress={() => updateDraft({transport_mode: m})}
                        activeOpacity={0.85}
                        accessibilityRole="button"
                        accessibilityState={{selected: on}}>
                        <Text style={[s.modeChipText, on && s.modeChipTextOn]}>{MODE_LABELS[m]}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>

              <LocationRow
                label="PICKUP LOCATION"
                address={draft.transport_pickup?.address}
                placeholder="Search or enter pickup location…"
                filled={!!draft.transport_pickup}
                onPress={() => openTransferPicker('pickup')}
              />
              <LocationRow
                label="DROP-OFF LOCATION"
                address={draft.transport_dropoff?.address}
                placeholder="Search or enter drop-off location…"
                filled={!!draft.transport_dropoff}
                onPress={() => openTransferPicker('dropoff')}
              />
              {legsMissing && (
                <Text style={s.gateHintInline}>
                  {!draft.transport_pickup
                    ? 'Add the transfer pickup location to continue.'
                    : 'Add the transfer drop-off location to continue.'}
                </Text>
              )}

              <View>
                <Text style={s.subLabel}>PICKUP TIME</Text>
                <View style={s.timeRow}>
                  <TimeDropdownField
                    style={{flex: 1}}
                    hour={transferPickerSeed.getHours()}
                    minute={transferPickerSeed.getMinutes()}
                    onChange={onTransferTimeChange}
                    minuteStep={5}
                    title="TRANSFER PICKUP TIME"
                    displayText={transferTimeLabel}
                    accessibilityLabel="Transfer pickup time"
                  />
                  {!!draft.transport_pickup_time && (
                    <TouchableOpacity
                      style={s.timeReset}
                      onPress={() => updateDraft({transport_pickup_time: ''})}
                      activeOpacity={0.8}
                      accessibilityRole="button"
                      accessibilityLabel="Reset to same as start time">
                      <Icon name="restore" size={16} color={D.textMute} />
                    </TouchableOpacity>
                  )}
                </View>
                {transferOutOfWindow && (
                  <Text style={s.gateHintInline}>
                    The transfer must fall between 2 hours before the start and the end of the
                    protection block. Pick a time inside that window (or reset to the start time).
                  </Text>
                )}
              </View>

              <View>
                <Text style={s.subLabel}>NUMBER OF PASSENGERS</Text>
                <View style={s.counter}>
                  <View style={s.counterLeft}>
                    <View style={s.counterIcon}><Icon name="account" size={17} color={D.accent} /></View>
                    <View style={{flex: 1, minWidth: 0}}>
                      <Text style={s.counterLabel} numberOfLines={2}>Passengers</Text>
                      <Text style={s.counterSub} numberOfLines={2}>Excluding CPO and driver</Text>
                    </View>
                  </View>
                  <View style={s.counterCtrl}>
                    <TouchableOpacity
                      style={s.counterBtn}
                      onPress={() => setPassengers(draft.passengers - 1)}
                      activeOpacity={0.7}
                      accessibilityRole="button"
                      accessibilityLabel="Remove passenger"
                      hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                      <Icon name="minus" size={16} color={D.textDim} />
                    </TouchableOpacity>
                    <Text style={s.counterVal}>{draft.passengers}</Text>
                    <TouchableOpacity
                      onPress={() => setPassengers(draft.passengers + 1)}
                      activeOpacity={0.85}
                      accessibilityRole="button"
                      accessibilityLabel="Add passenger"
                      hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                      <LinearGradient colors={['#6E9BF5', D.accentDeep]} start={{x: 0, y: 0}} end={{x: 0, y: 1}} style={s.counterBtnPri}>
                        <Icon name="plus" size={16} color="#fff" />
                      </LinearGradient>
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
            </>
          )}
        </View>

        {/* ── 5 · Team & add-ons (folded from ExecTeamScreen) ── */}
        <View>
          <Text style={s.fieldLabel}>TEAM COMPOSITION</Text>
          <View style={s.teamCard}>
            <View style={s.teamRow}>
              <View style={{flex: 1, minWidth: 0}}>
                <Text style={s.teamLabel}>CPOs</Text>
                <Text style={s.teamSub}>Close Protection Officers · 86 BC/hr each</Text>
              </View>
              <Stepper
                value={draft.cpo_count}
                unit="CPO"
                onMinus={() => setCpos(draft.cpo_count - 1)}
                onPlus={() => setCpos(draft.cpo_count + 1)}
                minusDisabled={draft.cpo_count <= 1}
                plusDisabled={draft.cpo_count >= maxCpos}
              />
            </View>
            <View style={s.teamDivider} />
            <View style={s.teamRow}>
              <View style={{flex: 1, minWidth: 0}}>
                <Text style={[s.teamLabel, !hasTransport && s.teamLabelDim]}>Vehicles &amp; Drivers</Text>
                <Text style={s.teamSub}>
                  {hasTransport
                    ? (draft.driver_only ? 'Using your own vehicle' : '30 BC/hr each · min ' + minVehicles + ' for your party')
                    : 'Only if transport added'}
                </Text>
              </View>
              <Stepper
                value={draft.vehicle_count}
                unit="vehicle"
                onMinus={() => setVehicles(draft.vehicle_count - 1)}
                onPlus={() => setVehicles(draft.vehicle_count + 1)}
                minusDisabled={!hasTransport || draft.driver_only || draft.vehicle_count <= minVehicles}
                plusDisabled={!hasTransport || draft.driver_only || draft.vehicle_count >= 4}
              />
            </View>
          </View>
        </View>

        <View style={[s.driverCard, !hasTransport && s.cardDisabled]}>
          <View style={s.driverIcon}><Icon name="steering" size={18} color={hasTransport ? D.accentSoft : D.textFaint} /></View>
          <View style={{flex: 1, minWidth: 0}}>
            <Text style={[s.teamLabel, !hasTransport && s.teamLabelDim]}>Driver Only (Client Vehicle)</Text>
            <Text style={s.teamSub}>
              {hasTransport
                ? 'You provide the vehicle — Bravo driver only · +20 BC/hr'
                : 'Available when transport is added'}
            </Text>
          </View>
          <Switch
            value={draft.driver_only}
            onValueChange={setDriverOnly}
            disabled={!hasTransport}
            trackColor={{false: 'rgba(255,255,255,0.12)', true: D.accentDeep}}
            thumbColor={draft.driver_only ? D.accentSoft : '#8B93A5'}
            accessibilityLabel="Driver only — client vehicle"
          />
        </View>

        <View>
          <Text style={s.fieldLabel}>OPTIONAL ADD-ONS</Text>
          <View style={s.addonsCard}>
            {EXEC_ADDONS.map((a, i) => {
              const on = !!draft.addon_switches[a.id];
              return (
                <View key={a.id} style={[s.addonRow, i > 0 && s.teamDivider2]}>
                  <View style={[s.addonIcon, on && s.addonIconOn]}>
                    <Icon name={a.icon as never} size={16} color={on ? D.accentSoft : D.textMute} />
                  </View>
                  <View style={{flex: 1, minWidth: 0}}>
                    <Text style={s.teamLabel} numberOfLines={1}>{a.label}</Text>
                    <View style={s.addonPriceChip}><Text style={s.addonPriceText}>+{a.bcPerHour} BC/hr</Text></View>
                  </View>
                  <Switch
                    value={on}
                    onValueChange={() => toggleAddOn(a.id)}
                    trackColor={{false: 'rgba(255,255,255,0.12)', true: D.accentDeep}}
                    thumbColor={on ? D.accentSoft : '#8B93A5'}
                    accessibilityLabel={`${a.label}, ${a.bcPerHour} BC per hour`}
                  />
                </View>
              );
            })}
          </View>
          <Text style={s.ratesNote}>Rates are per hour and will be applied to the total duration.</Text>
        </View>

        {/* ── 6 · Calculation (from the current ExecReview body, verbatim) ── */}
        <View>
          <Text style={s.fieldLabel}>CALCULATION</Text>
          <View style={s.card}>
            {lines.map((l, i) => (
              <View key={l.label} style={[s.calcRow, i > 0 && s.calcDivider]}>
                <Text style={s.calcLabel} numberOfLines={2}>{l.label}</Text>
                <View style={{alignItems: 'flex-end', flexShrink: 0}}>
                  <Text style={s.calcAmount}>{Math.round(l.perHour * hours)} BC</Text>
                  <Text style={s.calcPerHour}>{l.perHour} BC/hr × {hours}h</Text>
                </View>
              </View>
            ))}
            {splitConsistent && (
              <>
                <View style={[s.calcRow, s.calcSubtotalRow]}>
                  <Text style={s.calcSubtotalLabel}>Base Protection</Text>
                  <Text style={s.calcAmount}>{Math.round(baseBc)} BC</Text>
                </View>
                {hasTransport && (
                  <View style={[s.calcRow, s.calcDivider]}>
                    <Text style={s.calcSubtotalLabel}>Secure Transfer</Text>
                    <Text style={s.calcAmount}>{Math.round(transferBc)} BC</Text>
                  </View>
                )}
              </>
            )}
            <View style={[s.calcRow, s.calcTotalRow]}>
              <Text style={s.calcTotalLabel}>ESTIMATED TOTAL{serverTotal === null ? ' (EST.)' : ''}</Text>
              <Text style={s.calcTotalValue}>{Math.round(totalBc)} BC</Text>
            </View>
          </View>
          <Text style={s.escrowNote}>
            Charged from your Bravo Credits when an agency accepts — held in escrow and released on completion.
          </Text>
        </View>

        {/* ── Consent (auto path only) ── */}
        {consentRequired && (
          <TouchableOpacity
            style={s.consentRow}
            onPress={() => updateDraft({location_consent: !consentGiven})}
            activeOpacity={0.8}
            accessibilityRole="checkbox"
            accessibilityState={{checked: consentGiven}}
            accessibilityLabel="Consent to sharing my live location during the active booking">
            <View style={[s.checkbox, consentGiven && s.checkboxOn]}>
              {consentGiven && <Icon name="check" size={14} color="#fff" />}
            </View>
            <Text style={s.consentText}>
              I consent to sharing my live location during the active booking where required for
              operational coordination, and accept the Dispatch Terms.
            </Text>
          </TouchableOpacity>
        )}
      </ScrollView>

      {/* Native DATE picker (schedule Book-Later) — times are the 12-hour dropdowns
          above. Android has no mount here on purpose: openDate() opens the dialog
          imperatively so a re-render cannot re-open and reset it. */}
      {Platform.OS === 'ios' && dateOpen && (
        <Modal visible transparent animationType="slide" onRequestClose={() => setDateOpen(false)}>
          <Pressable style={s.iosBackdrop} onPress={() => setDateOpen(false)}>
            <Pressable style={s.iosCard} onPress={() => {}}>
              <DateTimePicker
                value={laterDate}
                mode="date"
                display="spinner"
                minimumDate={new Date(Date.now() + MIN_LEAD_HOURS * 3600_000)}
                textColor={D.text}
                onChange={onLaterDateChange}
              />
              <TouchableOpacity activeOpacity={0.9} onPress={() => setDateOpen(false)}>
                <LinearGradient colors={['#6E9BF5', D.accent, D.accentDeep]} locations={[0, 0.55, 1]} start={{x: 0, y: 0}} end={{x: 0, y: 1}} style={s.iosDone}>
                  <Text style={s.iosDoneText}>Done</Text>
                </LinearGradient>
              </TouchableOpacity>
            </Pressable>
          </Pressable>
        </Modal>
      )}

      {/* ── Footer CTA ── */}
      <LinearGradient
        colors={['rgba(7,9,13,0)', 'rgba(7,9,13,1)']}
        locations={[0, 0.5]}
        style={[s.ctaWrap, {paddingBottom: bottomPad(12)}]}>
        {gateHint && <Text style={s.gateHint}>{gateHint}</Text>}
        <TouchableOpacity
          activeOpacity={ctaBlocked ? 1 : 0.9}
          disabled={ctaBlocked}
          onPress={() => { void handleSubmit(); }}
          accessibilityRole="button"
          accessibilityState={{disabled: ctaBlocked, busy: submitting}}>
          <LinearGradient
            colors={ctaBlocked ? ['#27324A', '#1C2436'] : ['#6E9BF5', D.accent, D.accentDeep]}
            locations={[0, 0.55, 1]}
            start={{x: 0, y: 0}}
            end={{x: 0, y: 1}}
            style={[s.cta, ctaBlocked && s.ctaDisabled]}>
            {submitting ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <>
                <Text style={s.ctaText}>Confirm &amp; Book</Text>
                <Icon name="arrow-right" size={19} color="#fff" importantForAccessibility="no" />
              </>
            )}
          </LinearGradient>
        </TouchableOpacity>
      </LinearGradient>
    </View>
  );
}

function Stepper({value, unit, onMinus, onPlus, minusDisabled, plusDisabled}: {
  value: number; unit: string; onMinus: () => void; onPlus: () => void;
  minusDisabled?: boolean; plusDisabled?: boolean;
}) {
  return (
    <View style={s.stepCtrl}>
      <TouchableOpacity
        style={[s.stepBtn, minusDisabled && s.stepBtnDisabled]}
        onPress={onMinus}
        disabled={minusDisabled}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={`Remove ${unit}`}
        hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
        <Icon name="minus" size={16} color={minusDisabled ? D.textFaint : D.textDim} />
      </TouchableOpacity>
      <Text style={s.stepVal}>{value}</Text>
      <TouchableOpacity
        onPress={onPlus}
        disabled={plusDisabled}
        activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityLabel={`Add ${unit}`}
        hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
        <LinearGradient
          colors={plusDisabled ? ['#27324A', '#1C2436'] : ['#6E9BF5', D.accentDeep]}
          start={{x: 0, y: 0}}
          end={{x: 0, y: 1}}
          style={s.stepBtnPri}>
          <Icon name="plus" size={16} color={plusDisabled ? D.textFaint : '#fff'} />
        </LinearGradient>
      </TouchableOpacity>
    </View>
  );
}

function LocationRow({label, address, placeholder, filled, onPress}: {
  label: string; address?: string; placeholder: string; filled: boolean; onPress: () => void;
}) {
  return (
    <View>
      <Text style={s.subLabel}>{label}</Text>
      <TouchableOpacity
        style={[s.locRow, filled ? s.locRowFilled : s.locRowIdle]}
        onPress={onPress}
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityLabel={filled ? `${label}: ${address}. Edit` : placeholder}>
        <View style={[s.locPin, filled ? s.locPinFilled : s.locPinIdle]}>
          <Icon name={filled ? 'map-marker' : 'map-marker-outline'} size={16} color={filled ? D.accent : D.textMute} />
        </View>
        <Text style={[s.locText, filled ? s.locTextFilled : s.locTextPlaceholder]} numberOfLines={2}>
          {filled ? address : placeholder}
        </Text>
        <Icon name="chevron-right" size={16} color={D.textMute} />
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: D.bg, overflow: 'hidden'},

  ambient: {
    position: 'absolute', top: -100, alignSelf: 'center',
    width: 460, height: 260, borderRadius: 230,
    backgroundColor: 'rgba(91,141,239,0.07)',
  },

  header: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    paddingHorizontal: 20, paddingTop: 12, paddingBottom: 14,
  },
  back: {
    width: 40, height: 40, borderRadius: 12, flexShrink: 0,
    backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: D.hair2,
    alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: {fontFamily: D.fBold, fontSize: 21, letterSpacing: -0.5, color: D.text, lineHeight: 24},
  headerSub: {fontFamily: D.fMono, fontSize: 9.5, fontWeight: '600', letterSpacing: 1.6, color: D.textMute, marginTop: 5},

  fieldLabel: {
    fontFamily: D.fMono, fontSize: 9.5, fontWeight: '700',
    letterSpacing: 1.8, color: D.textDim, marginBottom: 9, paddingLeft: 2,
  },
  subLabel: {
    fontFamily: D.fMono, fontSize: 9.5, fontWeight: '700',
    letterSpacing: 1.8, color: D.textDim, marginBottom: 9, paddingLeft: 2,
  },

  // Duration grid
  grid: {flexDirection: 'row', flexWrap: 'wrap', gap: 12},
  cell: {
    flexGrow: 1, flexBasis: '44%', minHeight: 54,
    borderRadius: 16, overflow: 'hidden',
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  cellIdle: {backgroundColor: 'rgba(255,255,255,0.022)', borderWidth: 1, borderColor: D.hair2},
  cellSelected: {
    backgroundColor: 'rgba(16,26,46,0.92)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.55)',
    shadowColor: '#14285A', shadowOpacity: 0.4, shadowRadius: 14, shadowOffset: {width: 0, height: 10}, elevation: 7,
  },
  cellTopLight: {position: 'absolute', top: 0, left: 14, right: 14, height: 1, backgroundColor: 'rgba(120,160,255,0.4)'},
  cellText: {fontFamily: D.fSemi, fontSize: 15.5, letterSpacing: -0.2, color: D.textDim},
  cellTextSelected: {fontFamily: D.fBold, color: D.text},
  cellCheck: {width: 20, height: 20, borderRadius: 10, backgroundColor: D.accent, alignItems: 'center', justifyContent: 'center'},
  cellCheckHidden: {opacity: 0},

  // ">24 h → Bravo Secure Pro" nudge (mirrors ExecDurationScreen.proCard)
  proCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    marginTop: 14, padding: 14, borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.022)', borderWidth: 1, borderColor: D.hair2,
  },
  proIcon: {
    width: 34, height: 34, borderRadius: 11, flexShrink: 0,
    backgroundColor: 'rgba(91,141,239,0.10)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.28)',
    alignItems: 'center', justifyContent: 'center',
  },
  proTitle: {fontFamily: D.fBold, fontSize: 13.5, letterSpacing: -0.2, color: D.text},
  proSub: {fontFamily: D.fSans, fontSize: 11.5, lineHeight: 16, color: D.textMute, marginTop: 3},

  // Schedule toggle
  toggle: {
    flexDirection: 'row', padding: 5, borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.035)', borderWidth: 1, borderColor: D.hair2,
  },
  togglePillWrap: {position: 'absolute', top: 5, bottom: 5, left: 5},
  togglePill: {
    flex: 1, borderRadius: 14, borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
    shadowColor: D.accent, shadowOpacity: 0.5, shadowRadius: 18, shadowOffset: {width: 0, height: 8}, elevation: 8,
  },
  toggleSeg: {flex: 1, paddingVertical: 14, paddingHorizontal: 8, alignItems: 'center'},
  toggleT: {fontFamily: D.fBold, fontSize: 15, letterSpacing: 0.2, color: D.textDim},
  toggleTOn: {color: '#fff'},

  nowCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 16,
    backgroundColor: 'rgba(74,222,128,0.05)', borderWidth: 1, borderColor: 'rgba(74,222,128,0.22)',
  },
  nowIcon: {
    width: 38, height: 38, borderRadius: 12, flexShrink: 0,
    backgroundColor: 'rgba(74,222,128,0.10)', borderWidth: 1, borderColor: 'rgba(74,222,128,0.3)',
    alignItems: 'center', justifyContent: 'center',
  },
  nowText: {flex: 1, minWidth: 0, fontFamily: D.fSans, fontSize: 12.5, lineHeight: 18, color: D.textDim},
  nowStrong: {fontFamily: D.fSemi, color: D.signal},

  pickRow: {
    minHeight: 56, borderRadius: 16, flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 14, backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair2,
  },
  pickIcon: {
    width: 30, height: 30, borderRadius: 9, flexShrink: 0,
    backgroundColor: 'rgba(91,141,239,0.14)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.32)',
    alignItems: 'center', justifyContent: 'center',
  },
  pickText: {flex: 1, fontFamily: D.fSemi, fontSize: 14.5, letterSpacing: -0.1, color: D.text},

  alertWarn: {
    flexDirection: 'row', alignItems: 'center', gap: 11, padding: 14, borderRadius: 13,
    backgroundColor: 'rgba(245,181,68,0.07)', borderWidth: 1, borderColor: 'rgba(245,181,68,0.26)',
  },
  alertWarnHot: {backgroundColor: 'rgba(245,181,68,0.12)', borderColor: 'rgba(245,181,68,0.45)'},
  alertText: {flex: 1, fontFamily: D.fSans, fontSize: 11.5, color: D.textDim, lineHeight: 16},
  alertBold: {fontFamily: D.fSemi, color: D.amber},

  // Location rows (Task + Transport)
  locRow: {
    minHeight: 58, borderRadius: 16, flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 14, paddingVertical: 10,
  },
  locRowFilled: {backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2},
  locRowIdle: {backgroundColor: 'rgba(255,255,255,0.022)', borderWidth: 1, borderColor: D.hair},
  locPin: {width: 30, height: 30, borderRadius: 9, flexShrink: 0, alignItems: 'center', justifyContent: 'center'},
  locPinFilled: {backgroundColor: 'rgba(91,141,239,0.14)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.32)'},
  locPinIdle: {backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2},
  locText: {flex: 1, minWidth: 0, fontSize: 13.5, letterSpacing: -0.1, lineHeight: 18},
  locTextFilled: {fontFamily: D.fSemi, color: D.text},
  locTextPlaceholder: {fontFamily: D.fSans, color: D.textFaint},
  locEdit: {fontFamily: D.fSemi, fontSize: 12, color: D.accentSoft},

  // Task type accordion
  typeRow: {
    minHeight: 56, borderRadius: 16, flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 14, backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair2,
  },
  typeIcon: {
    width: 30, height: 30, borderRadius: 9, flexShrink: 0,
    backgroundColor: 'rgba(91,141,239,0.14)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.32)',
    alignItems: 'center', justifyContent: 'center',
  },
  typeText: {flex: 1, minWidth: 0, fontFamily: D.fSemi, fontSize: 14.5, letterSpacing: -0.1, color: D.text},
  typeList: {
    marginTop: 8, borderRadius: 16, overflow: 'hidden',
    backgroundColor: 'rgba(16,26,46,0.6)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.22)',
  },
  typeOption: {minHeight: 50, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14},
  typeOptionDivider: {borderTopWidth: 1, borderTopColor: D.hair},
  typeOptionText: {flex: 1, minWidth: 0, fontFamily: D.fSans, fontSize: 13.5, color: D.textDim},
  typeOptionTextOn: {fontFamily: D.fSemi, color: D.text},

  notes: {
    minHeight: 110, borderRadius: 16, padding: 14, paddingTop: 12,
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair2,
    fontFamily: D.fSans, fontSize: 13.5, lineHeight: 19, color: D.text,
  },
  notesCount: {fontFamily: D.fMono, fontSize: 10, color: D.textMute, textAlign: 'right', marginTop: 6, paddingRight: 2},

  // Transport toggle + optional card
  toggleCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 16,
    backgroundColor: 'rgba(16,26,46,0.6)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.22)',
  },
  toggleIcon: {
    width: 38, height: 38, borderRadius: 12, flexShrink: 0,
    backgroundColor: 'rgba(91,141,239,0.14)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.4)',
    alignItems: 'center', justifyContent: 'center',
  },
  toggleTitle: {fontFamily: D.fBold, fontSize: 14.5, letterSpacing: -0.2, color: D.text},
  toggleSub: {fontFamily: D.fSans, fontSize: 11.5, color: D.textMute, marginTop: 2},
  optionalCard: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 12, padding: 16, borderRadius: 16,
    borderWidth: 1, borderColor: D.hair2, borderStyle: 'dashed', backgroundColor: 'rgba(255,255,255,0.015)',
  },
  optionalIcon: {
    width: 30, height: 30, borderRadius: 9, flexShrink: 0,
    backgroundColor: 'rgba(91,141,239,0.10)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.28)',
    alignItems: 'center', justifyContent: 'center',
  },
  optionalTitle: {fontFamily: D.fSemi, fontSize: 13.5, color: D.text},
  optionalText: {fontFamily: D.fSans, fontSize: 12, lineHeight: 17, color: D.textMute, marginTop: 4},

  modeRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 10},
  modeChip: {flexGrow: 1, flexBasis: '28%', minHeight: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10},
  modeChipIdle: {backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair2},
  modeChipOn: {backgroundColor: 'rgba(91,141,239,0.16)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.5)'},
  modeChipText: {fontFamily: D.fSemi, fontSize: 12.5, color: D.textDim},
  modeChipTextOn: {color: D.text},

  timeRow: {flexDirection: 'row', gap: 10, alignItems: 'center'},
  timeReset: {
    width: 44, height: 50, borderRadius: 12, flexShrink: 0,
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair2,
    alignItems: 'center', justifyContent: 'center',
  },

  counter: {
    minHeight: 60, paddingVertical: 10, borderRadius: 16, flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', paddingLeft: 14, paddingRight: 12,
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair2,
  },
  counterLeft: {flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1, minWidth: 0, paddingRight: 8},
  counterIcon: {
    width: 30, height: 30, borderRadius: 9, flexShrink: 0,
    backgroundColor: 'rgba(91,141,239,0.14)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.32)',
    alignItems: 'center', justifyContent: 'center',
  },
  counterLabel: {fontFamily: D.fSemi, fontSize: 14, color: D.text, letterSpacing: -0.1},
  counterSub: {fontFamily: D.fSans, fontSize: 10.5, color: D.textMute, marginTop: 2},
  counterCtrl: {flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0},
  counterBtn: {
    width: 38, height: 38, borderRadius: 11,
    backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: D.hair2,
    alignItems: 'center', justifyContent: 'center',
  },
  counterBtnPri: {
    width: 38, height: 38, borderRadius: 11, borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center', justifyContent: 'center',
    shadowColor: D.accent, shadowOpacity: 0.5, shadowRadius: 12, shadowOffset: {width: 0, height: 6}, elevation: 6,
  },
  counterVal: {width: 34, textAlign: 'center', fontFamily: D.fBold, fontSize: 20, color: D.text},

  // Team
  teamCard: {borderRadius: 16, paddingHorizontal: 14, backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair2},
  teamRow: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 13},
  teamDivider: {height: 1, backgroundColor: D.hair},
  teamDivider2: {borderTopWidth: 1, borderTopColor: D.hair},
  teamLabel: {fontFamily: D.fSemi, fontSize: 14, color: D.text, letterSpacing: -0.1},
  teamLabelDim: {color: D.textMute},
  teamSub: {fontFamily: D.fSans, fontSize: 10.5, color: D.textMute, marginTop: 3},

  stepCtrl: {flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0},
  stepBtn: {
    width: 38, height: 38, borderRadius: 11,
    backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: D.hair2,
    alignItems: 'center', justifyContent: 'center',
  },
  stepBtnDisabled: {opacity: 0.4},
  stepBtnPri: {
    width: 38, height: 38, borderRadius: 11, borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center', justifyContent: 'center',
  },
  stepVal: {width: 30, textAlign: 'center', fontFamily: D.fBold, fontSize: 18, color: D.text},

  driverCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair2,
  },
  cardDisabled: {opacity: 0.55},
  driverIcon: {
    width: 34, height: 34, borderRadius: 11, flexShrink: 0,
    backgroundColor: 'rgba(91,141,239,0.10)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.28)',
    alignItems: 'center', justifyContent: 'center',
  },

  addonsCard: {borderRadius: 16, paddingHorizontal: 14, backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair2},
  addonRow: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12},
  addonIcon: {
    width: 32, height: 32, borderRadius: 10, flexShrink: 0,
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2,
    alignItems: 'center', justifyContent: 'center',
  },
  addonIconOn: {backgroundColor: 'rgba(91,141,239,0.14)', borderColor: 'rgba(91,141,239,0.4)'},
  addonPriceChip: {
    alignSelf: 'flex-start', marginTop: 4, paddingVertical: 2, paddingHorizontal: 7, borderRadius: 6,
    backgroundColor: 'rgba(91,141,239,0.10)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.26)',
  },
  addonPriceText: {fontFamily: D.fMono, fontSize: 9.5, fontWeight: '600', letterSpacing: 0.3, color: D.accentSoft},
  ratesNote: {fontFamily: D.fSans, fontSize: 10.5, color: D.textMute, marginTop: 9, paddingLeft: 2},

  // Calculation
  card: {
    borderRadius: 16, paddingHorizontal: 14, paddingVertical: 4,
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair2,
  },
  calcRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 11},
  calcDivider: {borderTopWidth: 1, borderTopColor: D.hair},
  calcLabel: {flex: 1, minWidth: 0, fontFamily: D.fSans, fontSize: 12.5, color: D.textDim},
  calcAmount: {fontFamily: D.fSemi, fontSize: 13.5, color: D.text},
  calcPerHour: {fontFamily: D.fMono, fontSize: 9, color: D.textMute, marginTop: 2},
  calcSubtotalRow: {borderTopWidth: 1, borderTopColor: D.hair2, marginTop: 2},
  calcSubtotalLabel: {flex: 1, minWidth: 0, fontFamily: D.fSemi, fontSize: 12.5, color: D.text},
  calcTotalRow: {borderTopWidth: 1, borderTopColor: 'rgba(91,141,239,0.3)', marginTop: 2, paddingTop: 13},
  calcTotalLabel: {fontFamily: D.fMono, fontSize: 10, fontWeight: '700', letterSpacing: 1.4, color: D.textDim, flexShrink: 1},
  calcTotalValue: {fontFamily: D.fBold, fontSize: 20, letterSpacing: -0.4, color: D.accentSoft},
  escrowNote: {fontFamily: D.fSans, fontSize: 10.5, lineHeight: 15, color: D.textMute, marginTop: 9, paddingLeft: 2},

  // Consent
  consentRow: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 12, padding: 14, borderRadius: 16,
    backgroundColor: 'rgba(16,26,46,0.6)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.22)',
  },
  checkbox: {
    width: 22, height: 22, borderRadius: 7, marginTop: 1, flexShrink: 0,
    borderWidth: 1.5, borderColor: D.hair2, alignItems: 'center', justifyContent: 'center',
  },
  checkboxOn: {backgroundColor: D.accent, borderColor: D.accentSoft},
  consentText: {flex: 1, minWidth: 0, fontFamily: D.fSans, fontSize: 12, lineHeight: 17, color: D.textDim},

  gateHint: {fontFamily: D.fSans, fontSize: 11.5, color: D.amber, textAlign: 'center', marginBottom: 8},
  gateHintInline: {fontFamily: D.fSans, fontSize: 11.5, color: D.amber, textAlign: 'center', marginTop: 2},

  iosBackdrop: {flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(2,6,15,0.72)'},
  iosCard: {
    backgroundColor: '#0E1320', borderTopLeftRadius: 22, borderTopRightRadius: 22,
    paddingTop: 10, paddingHorizontal: 16, borderTopWidth: 1, borderTopColor: D.hair2,
  },
  iosDone: {
    height: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
    marginTop: 10, marginBottom: 20, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
  },
  iosDoneText: {fontFamily: D.fBold, fontSize: 15, color: '#fff', letterSpacing: 0.3},

  ctaWrap: {position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20, paddingTop: 28},
  cta: {
    minHeight: 58, borderRadius: 18,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 11,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
    shadowColor: D.accent, shadowOpacity: 0.5, shadowRadius: 24, shadowOffset: {width: 0, height: 14}, elevation: 10,
  },
  ctaDisabled: {borderColor: D.hair2, shadowOpacity: 0, elevation: 0},
  ctaText: {fontFamily: D.fBold, fontSize: 16, letterSpacing: 0.3, color: '#fff'},
}));
