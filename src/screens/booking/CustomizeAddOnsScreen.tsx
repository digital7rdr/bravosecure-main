/**
 * Booking · Step 05 — Team & Add-ons
 *
 * Premium redesign (Bravo "Team Add-ons" design handoff): obsidian/cobalt
 * palette matching the rest of the booking flow. Team composition steppers
 * (CPOs, Vehicles), a "Driver Only (Client Vehicle)" toggle, a Control-Room
 * approval notice, and optional add-on rows with live +BC/hr pricing. A rate
 * bar shows the live BC/hr total; CTA submits for Ops review.
 *
 * Pricing mirrors the server (pricing.ts → pricing.service.ts): 86 BC base,
 * +25% per extra CPO/vehicle, 0.65× driver-only. Driver-only means the client
 * supplies the vehicle — Bravo dispatches a security driver but no Bravo
 * vehicle, so the vehicle stepper is locked to "Client vehicle".
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, StatusBar, TextInput,
  Platform, Modal, Pressable, Animated,
} from 'react-native';
import {Alert} from '@utils/alert';
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
import {useBookingStore} from '@store/bookingStore';
import {bookingApi} from '@services/api';
import TimeDropdownField from '@components/booking/TimeDropdownField';
import {formatTime12h, roundUpToMinuteStep} from '@components/booking/time12h';
import {rateBcPerHour, vehiclesForPassengers, maxCposForClientVehicle, MAX_CPOS, BASE_RATE_BC} from './pricing';
import {canAdvanceSchedule, MIN_LEAD_HOURS} from './scheduleGate';
import {isInsufficientCreditsError, creditShortfallFrom, shortfallFor} from './creditErrors';
import {scaleTextStyles} from '@utils/scaling';
import {useAuthStore} from '@store/authStore';
import {useWalletStore} from '@store/walletStore';
import {goBackOnce} from '@navigation/tapGuard';
import {useServicePricingStore} from '@store/servicePricingStore';

type Nav = NativeStackNavigationProp<BookingStackParamList, 'CustomizeAddOns'>;
type Rt  = RouteProp<BookingStackParamList, 'CustomizeAddOns'>;
type IconName = React.ComponentProps<typeof Icon>['name'];

/** Earliest bookable start = now + lead, rounded up to the next 5-min boundary. */
function earliestStart(): Date {
  return roundUpToMinuteStep(new Date(Date.now() + MIN_LEAD_HOURS * 3600_000), 5);
}

// Wave 5b — the two launched operating zones, folded in from ZoneMapScreen's
// REGION_SEED (founder 2026-08-01: only UAE + South Africa are selectable). The
// `name` mirrors ZoneMap's so the draft's `zone_label` (→ create() region_label)
// stays identical whichever surface set the zone.
interface ZoneDef {code: string; label: string; name: string}
const ZONES: ZoneDef[] = [
  {code: 'AE', label: 'UAE', name: 'UAE — Dubai, Abu Dhabi, Sharjah'},
  {code: 'ZA', label: 'SA',  name: 'South Africa — Johannesburg, Cape Town'},
];

// Design tokens (Bravo "Team Add-ons" handoff — obsidian/cobalt premium).
// Issue 29 — matches nothing server-side today; a generous cap that keeps a
// paste-bomb out of the booking row.
const NOTES_MAX = 500;

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
  fSans:    'Manrope_500Medium',
  fSemi:    'Manrope_600SemiBold',
  fBold:    'Manrope_700Bold',
  fMono:    'monospace',
};

interface AddOnDef {
  key: string;
  title: string;
  desc: string;
  icon: IconName;
  /** Per-hour price in BC (1:1 with EUR in Phase 1). */
  priceHourly: number;
}

// Offline fallback ONLY — the live catalogue (`/bookings/add-ons`) is authoritative
// and ops-editable. These prices mirror the LITE seed in
// 20260423113000_booking_module.sql; they used to carry the EXECUTIVE table
// (120/100/90/75), which over-stated every Lite add-on ~4× whenever the fetch failed.
const ADDONS: AddOnDef[] = [
  {key: 'female_cpo', title: 'Female CPO Team', desc: 'Female close protection officer(s)', icon: 'account',       priceHourly: 30},
  {key: 'recon',      title: 'Recon Team',      desc: 'Area sweep & route assessment',      icon: 'radar',         priceHourly: 25},
  {key: 'medical',    title: 'Medical Support', desc: 'Paramedic on standby',               icon: 'medical-bag',   priceHourly: 22},
  {key: 'comms',      title: 'Comms / SIGINT',  desc: 'Encrypted comms specialist',         icon: 'cellphone-key', priceHourly: 18},
];

export default function CustomizeAddOnsScreen() {
  // Live ops-editable pricing (founder 2026-08-26): subscribe so a
  // hydration re-renders the quote; load is single-flight + fail-open.
  useServicePricingStore(st => st.overrides);
  const loadServicePricing = useServicePricingStore(st => st.load);
  useEffect(() => { void loadServicePricing(); }, [loadServicePricing]);

  const insets = useSafeAreaInsets();
  const {bottomPad} = useBottomInset();
  const navigation = useNavigation<Nav>();
  const route = useRoute<Rt>();
  const updateDraft = useBookingStore(st => st.updateDraft);
  const draft = useBookingStore(st => st.draft);
  const confirmBooking = useBookingStore(st => st.confirmBooking);
  const availableAddOns = useBookingStore(st => st.availableAddOns);
  const loadAddOns = useBookingStore(st => st.loadAddOns);
  const [submitting, setSubmitting] = useState(false);

  // B-385 — the catalogue is OPS-EDITABLE (lite_booking_add_ons) and the server
  // now REJECTS an id it can't resolve, so the screen must both take live prices
  // AND drop de-listed rows. Merging alone left a de-listed add-on selectable and
  // turned the wizard into a dead end at submit. The catalogue is region-scoped
  // server-side, so fetch with the SAME region create() validates against.
  const addOnRegion = draft.region || draft.zone_code || 'AE';
  useEffect(() => { void loadAddOns(addOnRegion).catch(() => undefined); }, [loadAddOns, addOnRegion]);
  const liveAddOns = useMemo(() => {
    const byId = new Map(availableAddOns.map(a => [a.id, a]));
    // Offline / failed fetch → keep the compiled list (better than an empty screen).
    if (byId.size === 0) {return ADDONS;}
    return ADDONS.filter(a => byId.has(a.key)).map(a => {
      const livePrice = Number(byId.get(a.key)?.price_eur_per_hour);
      return Number.isFinite(livePrice) && livePrice > 0 ? {...a, priceHourly: livePrice} : a;
    });
  }, [availableAddOns]);

  // A row that vanished from the catalogue must not stay silently selected —
  // create() would 400 `unknown_add_on` on a toggle the user can no longer see.
  useEffect(() => {
    const selected = Object.entries(draft.addon_switches ?? {}).filter(([, v]) => v).map(([k]) => k);
    if (selected.length === 0) {return;}
    const allowed = new Set(liveAddOns.map(a => a.key));
    const stale = selected.filter(k => !allowed.has(k));
    if (stale.length === 0) {return;}
    const next = {...(draft.addon_switches ?? {})};
    for (const k of stale) {delete next[k];}
    updateDraft({addon_switches: next});
  }, [liveAddOns, draft.addon_switches, updateDraft]);

  const {cpo_count, vehicle_count, driver_only, addon_switches, passengers} = draft;

  // Passengers set the vehicle floor (1 per 3 pax). The user can add vehicles
  // but not drop below what the party physically needs.
  const minVehicles = vehiclesForPassengers(passengers);

  // Driver-only (client vehicle): passengers + CPOs all share the client's car,
  // so CPOs are capped to the free seats. With Bravo vehicles CPOs ride in
  // Bravo cars, so the full MAX_CPOS is available.
  const maxCpos = driver_only ? maxCposForClientVehicle(passengers) : MAX_CPOS;

  const setCount = (k: 'cpo_count' | 'vehicle_count', d: number) => {
    const cur = (draft[k] as number) ?? 1;
    const floor = k === 'vehicle_count' ? minVehicles : 1;
    const ceil = k === 'cpo_count' ? maxCpos : 4;
    const next = Math.max(floor, Math.min(ceil, cur + d));
    updateDraft({[k]: next} as never);
  };

  // Keep vehicle_count at the passenger-derived floor and CPOs within the
  // client-vehicle seat limit on entry / when inputs change upstream.
  useEffect(() => {
    if (!driver_only && (vehicle_count ?? 1) < minVehicles) {
      updateDraft({vehicle_count: minVehicles});
    }
    if (cpo_count > maxCpos) {
      updateDraft({cpo_count: maxCpos});
    }
  }, [minVehicles, vehicle_count, driver_only, cpo_count, maxCpos, updateDraft]);

  // Driver-only (client vehicle): the client supplies the car, so Bravo assigns
  // no vehicle. Restore the passenger-derived count when toggled off; clamp CPOs
  // to the client-car seat limit when toggled on.
  const toggleDriverOnly = () => {
    const next = !driver_only;
    updateDraft({
      driver_only: next,
      vehicle_count: next ? 0 : minVehicles,
      cpo_count: next ? Math.min(cpo_count, maxCposForClientVehicle(passengers)) : cpo_count,
    });
  };

  const toggleAddon = (k: string) =>
    updateDraft({addon_switches: {...addon_switches, [k]: !addon_switches?.[k]}});

  const rateBc = useMemo(() => {
    const addOnsBcPerHour = liveAddOns.reduce(
      (sum, a) => (addon_switches?.[a.key] ? sum + a.priceHourly : sum),
      0,
    );
    return rateBcPerHour({
      cpoCount: cpo_count,
      vehicleCount: vehicle_count,
      driverOnly: driver_only,
      addOnsBcPerHour,
    });
  }, [cpo_count, vehicle_count, driver_only, addon_switches, liveAddOns]);

  // LM-M1 — the AUTHORITATIVE quote. The escrow charge is the TOTAL (rate ×
  // hours + server surcharges), but this screen previously stored the PER-HOUR
  // rate as `estimated_price`, so the paywall under-asked ~4× and the "PAID"
  // line lied. Fetch the server estimate (debounced) and always carry a TOTAL.
  const durationHours = Math.max(1, draft.duration_hours ?? 4);
  const [serverTotal, setServerTotal] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    setServerTotal(null);
    const t = setTimeout(() => {
      const selected = Object.entries(addon_switches ?? {}).filter(([, v]) => v).map(([k]) => k);
      bookingApi.estimatePrice({
        type: 'transfer',
        region: draft.region,
        duration_hours: durationHours,
        add_ons: selected,
        cpo_count,
        vehicle_count,
        driver_only,
        passengers,
        pickup_time: draft.start_time || undefined,
      })
        .then(({data}) => { if (alive && typeof data?.total === 'number') {setServerTotal(data.total);} })
        .catch(() => undefined); // offline → the local rate×hours fallback below
    }, 400);
    return () => { alive = false; clearTimeout(t); };
  }, [cpo_count, vehicle_count, driver_only, passengers, addon_switches, durationHours, draft.region, draft.start_time]);
  const totalBc = serverTotal ?? rateBc * durationHours;

  const selectedCount = Object.values(addon_switches ?? {}).filter(Boolean).length;
  const needsOpsApproval = cpo_count > 1 || (!driver_only && vehicle_count > 1);
  // Step 22 — the auto path shares the client's live location with the assigned
  // agency, so the CTA is gated on an explicit, opt-in consent. Legacy ops-mediated
  // bookings keep their existing implicit flow (no gate).
  // Bug 1: server-driven auto-dispatch flag (replaces build-time AUTO_DISPATCH). Reactive selector.
  const consentRequired = useAuthStore(s => s.user?.auto_dispatch_enabled === true);
  const consentGiven = draft.location_consent === true;
  // The 3h-lead gate, reused verbatim: a transfer needs both ends; an hourly
  // detail needs only a pickup. Blocks the money path until the schedule is set.
  const scheduleReady = canAdvanceSchedule(draft.type, draft.pickup, draft.dropoff);
  const ctaBlocked = submitting || (consentRequired && !consentGiven) || !scheduleReady;
  // Issue 25 — used only to compute the top-up shortfall when the server's
  // rejection didn't carry one (legacy flat 400).
  const walletCredits = useWalletStore(st => st.balance?.bravo_credits);
  const referralCode = useBookingStore(st => st.draft.referral_code);
  const notes = useBookingStore(st => st.draft.notes);
  // Issue 29 — an hourly detail has no destination, so the brief matters more.
  const isHourly = useBookingStore(st => st.draft.type) !== 'transfer';

  // ── Schedule (folded from BookingDateTimeScreen) ─────────────────────────────
  // Book-Now / Later, pick-up + drop-off (LocationPicker modal, unchanged), the
  // time picker and passengers. pickup/dropoff/mode/passengers/start_time all
  // write the SAME draft fields the old Schedule step wrote; the store owns the
  // zone-change pickup/dropoff clear, so the location rows read straight off the
  // draft and re-prompt automatically when the zone section changes zone.
  const mode = draft.mode ?? 'now';

  // Earliest bookable time = now + 3h, rounded up to the next 5-min boundary.
  const earliest = useMemo(earliestStart, []);
  const [hour, setHour] = useState<number>(earliest.getHours());
  const [minute, setMinute] = useState<number>(earliest.getMinutes());
  const [laterDate, setLaterDate] = useState<Date>(earliest);
  const [dateOpen, setDateOpen] = useState(false);
  const [leadHint, setLeadHint] = useState<string | null>(null);

  // Sliding pill for the Book Now / Book Later segmented toggle.
  const slide = useRef(new Animated.Value(mode === 'now' ? 0 : 1)).current;
  useEffect(() => {
    Animated.timing(slide, {toValue: mode === 'now' ? 0 : 1, duration: 220, useNativeDriver: true}).start();
  }, [mode, slide]);
  const [toggleTrackW, setToggleTrackW] = useState(0);
  const pillWidth = Math.max(0, (toggleTrackW - 12) / 2);
  const pillX = slide.interpolate({inputRange: [0, 1], outputRange: [0, pillWidth]});

  // When LocationPicker navigates back (merge:true) with a picked spot, write it
  // straight to the draft — the SAME {pickedAddress,pickedLat,pickedLng,
  // pickedKind,pickedAt} contract BookingDateTimeScreen used.
  useEffect(() => {
    const p = route.params;
    if (!p?.pickedAt || typeof p.pickedLat !== 'number' || typeof p.pickedLng !== 'number') {return;}
    const address = p.pickedAddress ?? 'Selected location';
    if (p.pickedKind === 'pickup') {
      updateDraft({pickup: {address, latitude: p.pickedLat, longitude: p.pickedLng, label: 'Pick-up'}});
    } else if (p.pickedKind === 'dropoff') {
      updateDraft({dropoff: {address, latitude: p.pickedLat, longitude: p.pickedLng, label: 'Drop-off'}});
    }
    // Clear the params so a re-render doesn't reapply the same pick.
    navigation.setParams({
      pickedAt: undefined, pickedAddress: undefined,
      pickedLat: undefined, pickedLng: undefined, pickedKind: undefined,
    } as never);
  }, [route.params, navigation, updateDraft]);

  const computeStartTime = useCallback(() => {
    let start: Date;
    if (mode === 'now') {
      start = new Date();
      start.setHours(hour, minute, 0, 0);
      if (start.getTime() < Date.now() + MIN_LEAD_HOURS * 3600_000) {
        start.setDate(start.getDate() + 1);
      }
    } else {
      start = new Date(laterDate);
    }
    return start;
  }, [mode, hour, minute, laterDate]);

  // Keep the draft's start_time current so the debounced estimate can factor the
  // peak-hour surcharge — exactly as it did when the old Schedule step wrote it
  // before navigating here. It is recomputed fresh at submit (a stale 'now' rolls
  // to the next day).
  useEffect(() => {
    updateDraft({start_time: computeStartTime().toISOString()});
  }, [computeStartTime, updateDraft]);

  const openPicker = (kind: 'pickup' | 'dropoff') => {
    // Prefer this slot's existing pin; the drop-off falls back to the pickup so
    // the picker opens in the right country (search scoped from frame 1).
    const cur = kind === 'pickup' ? draft.pickup : (draft.dropoff ?? draft.pickup);
    navigation.navigate('LocationPicker', {
      kind,
      countryCode: draft.zone_code || 'AE',
      initial: cur ? {latitude: cur.latitude, longitude: cur.longitude, address: cur.address} : undefined,
      // Return to THIS dashboard route (merge-navigate), not the old Schedule screen.
      onPickRouteKey: 'CustomizeAddOns',
    });
  };

  // Book Later — date pick and time pick both land here: snap UP to the next
  // 5-minute boundary, never under the lead (auto-correct to the earliest start
  // and say so, rather than silently booking a different time).
  const commitLater = (picked: Date) => {
    const snapped = roundUpToMinuteStep(picked, 5);
    if (snapped.getTime() < Date.now() + MIN_LEAD_HOURS * 3600_000) {
      const fixed = earliestStart();
      setLaterDate(fixed);
      setLeadHint(
        `Bookings need a ${MIN_LEAD_HOURS}-hour lead · earliest ` +
        `${fixed.toLocaleDateString(undefined, {weekday: 'short', day: '2-digit', month: 'short'})} · ${formatTime12h(fixed.getHours(), fixed.getMinutes())}.`,
      );
    } else {
      setLaterDate(snapped);
      setLeadHint(null);
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

  // Android opens the native dialog IMPERATIVELY from the gesture. A declarative
  // mount re-opens it on every re-render (see androidDatePicker.ts) and this
  // screen re-renders on its own debounced estimate, which snapped the calendar
  // back to `laterDate` under the user's finger.
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

  // Zone section (folded from ZoneMapScreen.handleContinue). The store clears
  // pickup/dropoff when zone_code changes (bookingStore.ts) — the location rows
  // read draft.pickup/dropoff, so they visibly re-prompt.
  const selectZone = (z: ZoneDef) => {
    updateDraft({zone_code: z.code, zone_label: z.name, region: z.code});
  };

  const setPassengers = (delta: number) =>
    updateDraft({passengers: Math.min(12, Math.max(1, passengers + delta))});

  const laterLabel =
    laterDate.toLocaleDateString(undefined, {weekday: 'short', day: '2-digit', month: 'short'}) +
    ` · ${formatTime12h(laterDate.getHours(), laterDate.getMinutes())}`;

  const handleSubmit = async () => {
    if (submitting) {return;}
    // Schedule must be complete before the money path runs (the old Confirm-
    // Schedule gate, folded in): a transfer needs both ends, else just a pickup.
    if (!scheduleReady) {return;}
    // Finalise the schedule into the draft confirmBooking() reads. start_time is
    // recomputed fresh here; vehicle_count keeps the passenger-derived floor the
    // old Schedule step pinned (the team effect already holds it, re-pinned here).
    updateDraft({
      mode,
      passengers,
      vehicle_count: Math.max(draft.vehicle_count ?? 1, minVehicles),
      start_time: computeStartTime().toISOString(),
    });

    const selectedList = Object.entries(addon_switches ?? {})
      .filter(([, v]) => v)
      .map(([k]) => k);
    // LM-M1 — estimated_price is the TOTAL the escrow will hold, never the hourly rate.
    updateDraft({selected_add_ons: selectedList, estimated_price: totalBc});

    setSubmitting(true);
    try {
      // Persist server-side BEFORE navigating, so re-entering the Secure tab
      // resumes into the right screen rather than a purely client-side one.
      const booking = await confirmBooking();
      // Step 19 — route by the returned status: an auto request comes back DISPATCHING
      // (→ Finding) or NO_PROVIDER (→ NoDetail); the legacy flow stays → OpsRoomReview.
      const st = (booking.status ?? '').toString().toUpperCase();
      if (st === 'DISPATCHING') {
        navigation.navigate('FindingDetail', {bookingId: booking.id});
      } else if (st === 'NO_PROVIDER') {
        navigation.navigate('NoDetail', {bookingId: booking.id});
      } else if (booking.booking_mode === 'later') {
        // B-405 — a FUTURE reservation must not park the client on the locked
        // review screen (founder, 2026-08-09): back to home, where it shows as
        // an upcoming card; approval + the T-60 reminder arrive as pushes.
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
      // Issue 25 — a short balance is NOT a booking failure. One check covers
      // every shape: the auto soft-check's typed throw, the structured 400, the
      // legacy flat 400, and the store's normalised re-throw. Previously only
      // the first matched, so a server-side rejection fell through to the
      // generic alert and leaked the raw `insufficient_credits` code.
      if (isInsufficientCreditsError(e)) {
        navigation.navigate('CreditPaywall', {
          source: 'booking-flow',
          // The server's exact shortfall when it sent one; otherwise our own
          // estimate-minus-balance. Never under-ask — the paywall's own
          // fallback is the full estimate.
          amountDue: creditShortfallFrom(e) ?? shortfallFor(totalBc, walletCredits),
        });
        return;
      }
      if (direct?.code === 'consent_required') {
        Alert.alert('Consent required', 'Please confirm location-sharing consent to find an agency.');
        return;
      }
      const msg = (e as {response?: {data?: {code?: string; booking_id?: string; message?: string}}; message?: string})?.response?.data;
      // The store normalises `code`/`bookingId` onto the re-thrown error; the
      // raw body is only present when a caller reaches the API directly.
      const activeId = msg?.booking_id ?? direct?.bookingId;
      if ((msg?.code ?? direct?.code) === 'active_booking_exists' && activeId) {
        navigation.navigate('OpsRoomReview', {bookingId: activeId});
        return;
      }
      Alert.alert(
        'Booking failed',
        msg?.message ?? (e as Error).message ?? 'Could not submit booking. Please try again.',
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
          <Text style={s.headerTitle} numberOfLines={1} ellipsizeMode="tail">Secure Transfer</Text>
          <FitLine style={s.headerSub} text={'BUILD & CONFIRM YOUR DETAIL'} />
        </View>
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={{paddingHorizontal: 20, paddingBottom: 160, paddingTop: 4, gap: 14}}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled">

        {/* ── Operating zone (folded from ZoneMapScreen) ── */}
        <View>
          <Text style={s.sectionLabel}>OPERATING ZONE</Text>
          <View style={s.zoneRow}>
            {ZONES.map(z => {
              const on = z.code === draft.zone_code;
              return (
                <TouchableOpacity
                  key={z.code}
                  style={[s.zoneChip, on && s.zoneChipOn]}
                  onPress={() => selectZone(z)}
                  activeOpacity={0.85}
                  accessibilityRole="button"
                  accessibilityState={{selected: on}}
                  accessibilityLabel={z.name}>
                  {on && <View style={s.cardTopLightSm} />}
                  <View style={[s.zoneCode, on && s.zoneCodeOn]}>
                    <Text style={[s.zoneCodeText, on && s.zoneCodeTextOn]}>{z.label}</Text>
                  </View>
                  <Text style={[s.zoneName, on && s.zoneNameOn]} numberOfLines={2}>{z.name}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* ── Schedule (folded from BookingDateTimeScreen) ── */}
        <View style={s.schSection}>
          <Text style={s.sectionLabel}>SCHEDULE</Text>

          {/* Mode toggle — sliding gradient pill */}
          <View style={s.schToggle} onLayout={e => setToggleTrackW(e.nativeEvent.layout.width)}>
            {toggleTrackW > 0 && (
              <Animated.View style={[s.schTogglePillWrap, {width: pillWidth, transform: [{translateX: pillX}]}]}>
                <LinearGradient
                  colors={['#6E9BF5', D.accent, D.accentDeep]}
                  locations={[0, 0.6, 1]}
                  start={{x: 0, y: 0}}
                  end={{x: 0, y: 1}}
                  style={s.schTogglePill}
                />
              </Animated.View>
            )}
            <TouchableOpacity style={s.schToggleSeg} onPress={() => updateDraft({mode: 'now'})} activeOpacity={0.85}>
              <Text style={[s.schToggleT, mode === 'now' && s.schToggleTOn]} numberOfLines={1}>Book Now</Text>
              <Text style={[s.schToggleS, mode === 'now' && s.schToggleSOn]} numberOfLines={1}>
                Earliest {formatTime12h(earliest.getHours(), earliest.getMinutes())}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.schToggleSeg} onPress={() => updateDraft({mode: 'later'})} activeOpacity={0.85}>
              <Text style={[s.schToggleT, mode === 'later' && s.schToggleTOn]} numberOfLines={1}>Book Later</Text>
              <Text style={[s.schToggleS, mode === 'later' && s.schToggleSOn]} numberOfLines={1}>Choose date &amp; time</Text>
            </TouchableOpacity>
          </View>

          {/* Min lead warning (Book Now only) */}
          {mode === 'now' && (
            <View style={s.alertWarn}>
              <Icon name="alert" size={18} color={D.amber} style={{marginTop: 1}} />
              <Text style={s.alertText}>
                <Text style={s.alertBold}>Minimum 3-hour lead time</Text> for all bookings · earliest{' '}
                {formatTime12h(earliest.getHours(), earliest.getMinutes())} today.
              </Text>
            </View>
          )}

          {/* Pickup / Drop-off — the LocationPicker modal, unchanged */}
          <LocationRow
            label="PICK-UP LOCATION"
            address={draft.pickup?.address}
            placeholder="Select pick-up…"
            filled={!!draft.pickup}
            onPress={() => openPicker('pickup')}
          />
          <LocationRow
            label="DROP-OFF LOCATION"
            address={draft.dropoff?.address}
            placeholder="Select destination…"
            filled={!!draft.dropoff}
            onPress={() => openPicker('dropoff')}
          />

          {!scheduleReady && (
            <Text style={s.gateHint}>
              {!draft.pickup ? 'Add a pick-up location to continue.' : 'Add a drop-off location to continue.'}
            </Text>
          )}

          {/* Time picker — now vs later */}
          {mode === 'now' ? (
            <View>
              <Text style={s.fieldLabel}>PICK-UP TIME</Text>
              <TimeDropdownField
                hour={hour}
                minute={minute}
                onChange={(h, m) => { setHour(h); setMinute(m); }}
                minuteStep={5}
                title="PICK-UP TIME"
                accessibilityLabel="Pick-up time"
              />
            </View>
          ) : (
            <View>
              <Text style={s.fieldLabel}>MISSION START</Text>
              <View style={s.laterBox}>
                <View style={s.laterRow}>
                  <TouchableOpacity
                    style={s.laterBtn}
                    onPress={openDate}
                    activeOpacity={0.8}
                    accessibilityRole="button"
                    accessibilityLabel="Choose date">
                    <Icon name="calendar" size={15} color={D.accent} />
                    <Text style={s.laterBtnText} numberOfLines={1} ellipsizeMode="tail">
                      {laterDate.toLocaleDateString(undefined, {weekday: 'short', day: '2-digit', month: 'short', year: 'numeric'})}
                    </Text>
                  </TouchableOpacity>
                  <TimeDropdownField
                    style={{flex: 1}}
                    hour={laterDate.getHours()}
                    minute={laterDate.getMinutes()}
                    onChange={onLaterTimeChange}
                    minuteStep={5}
                    title="MISSION START TIME"
                    accessibilityLabel="Choose start time"
                  />
                </View>
                <Text style={s.laterHint}>{laterLabel}</Text>
                {leadHint && <Text style={s.gateHint}>{leadHint}</Text>}
              </View>
            </View>
          )}

          {/* Passengers */}
          <View>
            <Text style={s.fieldLabel}>PASSENGERS</Text>
            <View style={s.counter}>
              <View style={s.counterTopLight} />
              <View style={s.counterLeft}>
                <View style={s.counterIcon}>
                  <Icon name="account" size={17} color={D.accent} />
                </View>
                <View style={{flex: 1, minWidth: 0}}>
                  <Text style={s.counterLabel} numberOfLines={2}>Number of passengers</Text>
                  <Text style={s.counterSub} numberOfLines={2}>Excluding CPO and driver</Text>
                </View>
              </View>
              <View style={s.counterCtrl}>
                <TouchableOpacity
                  style={s.counterBtn}
                  onPress={() => setPassengers(-1)}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel="Remove passenger"
                  hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                  <Icon name="minus" size={16} color={D.textDim} />
                </TouchableOpacity>
                <Text style={s.counterVal}>{passengers}</Text>
                <TouchableOpacity
                  onPress={() => setPassengers(+1)}
                  activeOpacity={0.85}
                  accessibilityRole="button"
                  accessibilityLabel="Add passenger"
                  hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                  <LinearGradient
                    colors={['#6E9BF5', D.accentDeep]}
                    start={{x: 0, y: 0}}
                    end={{x: 0, y: 1}}
                    style={s.counterBtnPri}>
                    <Icon name="plus" size={16} color="#fff" />
                  </LinearGradient>
                </TouchableOpacity>
              </View>
            </View>
          </View>

          <View style={s.schHint}>
            <Icon name="information-outline" size={16} color={D.accentSoft} style={{marginTop: 1}} />
            <Text style={s.schHintText}>
              Each vehicle carries up to 3 passengers (CPO and driver occupy 1 seat each).{' '}
              {passengers > 3 ? (
                <Text style={s.schHintStrong}>
                  {vehiclesForPassengers(passengers)} vehicles will be assigned — adjust below.
                </Text>
              ) : '1 vehicle covers this party.'}
            </Text>
          </View>
        </View>

        {/* ── Baseline package (folded from BaselinePackageScreen — writes nothing) ── */}
        <View style={s.baseCard}>
          <View style={s.baseTopLight} />
          <View style={{flex: 1, minWidth: 0}}>
            <Text style={s.baseCap}>BASELINE PACKAGE · ALWAYS INCLUDED</Text>
            <Text style={s.baseInc}>1 CPO · 1 Vehicle · 1 Driver · encrypted comms · live GPS · ops handler</Text>
          </View>
          <View style={s.baseAmtRow}>
            <Text style={s.baseAmt}>{BASE_RATE_BC}</Text>
            <Text style={s.baseBc}>BC/hr</Text>
          </View>
        </View>

        {/* ── Team composition ── */}
        <View style={s.teamCard}>
          <View style={s.cardTopLight} />
          <Text style={s.sectionLabel}>TEAM COMPOSITION</Text>
          <View style={s.teamCols}>
            <TeamCell
              cap="CPOs"
              value={cpo_count}
              minusDisabled={cpo_count <= 1}
              plusDisabled={cpo_count >= maxCpos}
              onMinus={() => setCount('cpo_count', -1)}
              onPlus={() => setCount('cpo_count', +1)}
            />
            {driver_only ? (
              <View style={s.teamCell}>
                <Text style={s.teamCellCap}>VEHICLES</Text>
                <View style={s.clientVehicle}>
                  <Icon name="car-key" size={18} color={D.accentSoft} />
                  <Text style={s.clientVehicleText}>Client</Text>
                </View>
              </View>
            ) : (
              <TeamCell
                cap="VEHICLES + DRIVERS"
                value={vehicle_count}
                minusDisabled={vehicle_count <= minVehicles}
                onMinus={() => setCount('vehicle_count', -1)}
                onPlus={() => setCount('vehicle_count', +1)}
              />
            )}
          </View>
          <Text style={s.teamNote}>
            {driver_only
              ? `Client vehicle seats ${passengers} passengers + ${maxCpos} CPO${maxCpos === 1 ? '' : 's'} (driver takes 1 seat).`
              : passengers > 3
              ? `${passengers} passengers require at least ${minVehicles} vehicles · 3 per vehicle.`
              : 'Each vehicle carries up to 3 passengers · 3 per vehicle.'}
          </Text>
        </View>

        {/* ── Driver Only toggle ── */}
        <TouchableOpacity
          style={[s.driverRow, driver_only && s.driverRowOn]}
          onPress={toggleDriverOnly}
          activeOpacity={0.85}>
          {driver_only && <View style={s.cardTopLightSm} />}
          <View style={{flex: 1, minWidth: 0}}>
            <Text style={s.driverTitle}>Driver Only (Client Vehicle)</Text>
            <Text style={s.driverDesc}>Client provides vehicle — Bravo driver only</Text>
          </View>
          <Toggle on={driver_only} onPress={toggleDriverOnly} label="Driver only" />
        </TouchableOpacity>

        {/* ── Approval notice ── */}
        {needsOpsApproval && (
          <View style={s.alertWarn}>
            <Icon name="alert" size={18} color={D.amber} style={{marginTop: 1}} />
            <Text style={s.alertText}>
              Selecting more than baseline (1 CPO + 1 Vehicle) requires{' '}
              <Text style={s.alertBold}>Bravo Control System approval</Text> and a minimum 3-hour additional lead time.
            </Text>
          </View>
        )}

        {/* ── Optional add-ons ── */}
        <View style={s.sectionRow}>
          <Text style={s.sectionLabel}>OPTIONAL ADD-ONS</Text>
          <Text style={s.sectionMeta}>{selectedCount} SELECTED</Text>
        </View>

        <View style={{gap: 10}}>
          {liveAddOns.map(a => (
            <AddonRow
              key={a.key}
              icon={a.icon}
              title={a.title}
              desc={a.desc}
              price={a.priceHourly}
              on={!!addon_switches?.[a.key]}
              onToggle={() => toggleAddon(a.key)}
            />
          ))}
        </View>

        {/* ── Location-sharing consent (auto path only) ── */}
        {consentRequired && (
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={() => updateDraft({location_consent: !consentGiven})}
            style={[s.consentRow, consentGiven && s.consentRowOn]}
            accessibilityRole="checkbox"
            accessibilityState={{checked: consentGiven}}>
            <View style={[s.checkbox, consentGiven && s.checkboxOn]}>
              {consentGiven && <Icon name="check" size={14} color="#fff" />}
            </View>
            <Text style={s.consentText}>
              I consent to sharing my live location with the assigned agency for the duration of
              this detail, and I accept the{' '}
              <Text style={s.consentLink}>Dispatch Terms</Text>.
            </Text>
          </TouchableOpacity>
        )}

        {/* ── Rate bar ── */}
        <View style={s.rateBar}>
          <View style={s.rateBarTopLight} />
          <View>
            <Text style={s.rateCap}>CURRENT RATE</Text>
            <Text style={s.rateSub}>Bravo Credits / hour</Text>
          </View>
          <View style={s.rateAmtRow}>
            <Text style={s.rateAmt}>{rateBc.toLocaleString()}</Text>
            <Text style={s.rateUnit}>BC</Text>
          </View>
        </View>
        {/* LM-M1 — the number escrow will actually hold, shown BEFORE submit. */}
        {/* Issue 29 — free-text instructions. The PDF names event support and
            meeting attendance: an hourly detail has no route to infer intent
            from, so the brief has to be stated. Persisted as `notes`, which the
            booking API already carried but no screen ever exposed. */}
        <View style={s.refWrap}>
          <Text style={s.refLabel}>
            {isHourly ? 'Brief for the team (optional)' : 'Anything the team should know? (optional)'}
          </Text>
          <TextInput
            style={[s.refInput, s.notesInput]}
            value={notes}
            onChangeText={t => updateDraft({notes: t.slice(0, NOTES_MAX)})}
            placeholder={isHourly
              ? 'e.g. Event support at the Hilton, 3 guests, discreet dress'
              : 'e.g. Meet at the north entrance'}
            placeholderTextColor={D.textMute}
            multiline
            maxLength={NOTES_MAX}
            textAlignVertical="top"
            accessibilityLabel="Instructions for the security team, optional"
          />
          <Text style={s.refNote}>{notes.length}/{NOTES_MAX} · Sent to the Bravo Control System with your request.</Text>
        </View>

        {/* Issue 28 — optional partner / preferred-provider code, captured
            before final submission. Attribution only: the server validates and
            records it, and it never bypasses availability, licensing or
            operator approval. */}
        <View style={s.refWrap}>
          <Text style={s.refLabel}>Provider / referral code (optional)</Text>
          <TextInput
            style={s.refInput}
            value={referralCode}
            onChangeText={t => updateDraft({referral_code: t.toUpperCase().replace(/[^A-Z0-9-]/g, '').replace(/^-+/, '')})}
            placeholder="e.g. TRAVELCO-01"
            placeholderTextColor={D.textMute}
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={32}
            accessibilityLabel="Provider or referral code, optional"
          />
          <Text style={s.refNote}>
            From a partner or travel agent. It records who referred you — it does not
            change availability or who is assigned.
          </Text>
        </View>

        <View style={s.totalRow}>
          <Text style={s.totalCap} numberOfLines={1} ellipsizeMode="tail">ESTIMATED TOTAL · {durationHours}H</Text>
          <Text style={s.totalAmt}>{Math.round(totalBc).toLocaleString()} BC</Text>
        </View>
      </ScrollView>

      {/* Native DATE picker (Book Later) — the time is the 12-hour dropdown above.
          Android has no mount here on purpose: openDate() opens the dialog
          imperatively so a re-render cannot re-open and reset it. */}
      {Platform.OS === 'ios' && dateOpen && (
        <Modal
          visible
          transparent
          animationType="slide"
          onRequestClose={() => setDateOpen(false)}>
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
                <LinearGradient
                  colors={['#6E9BF5', D.accent, D.accentDeep]}
                  locations={[0, 0.55, 1]}
                  start={{x: 0, y: 0}}
                  end={{x: 0, y: 1}}
                  style={s.iosDone}>
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
        <TouchableOpacity
          activeOpacity={ctaBlocked ? 1 : 0.9}
          onPress={() => { void handleSubmit(); }}
          disabled={ctaBlocked}>
          <LinearGradient
            colors={ctaBlocked ? ['#27324A', '#1C2436'] : ['#6E9BF5', D.accent, D.accentDeep]}
            locations={[0, 0.55, 1]}
            start={{x: 0, y: 0}}
            end={{x: 0, y: 1}}
            style={[s.cta, ctaBlocked && s.ctaDisabled]}>
            <Text style={s.ctaText}>
              {submitting ? 'Submitting…' : consentRequired ? 'Confirm Booking' : 'Submit for Ops Review'}
            </Text>
            {!submitting && <Icon name="arrow-right" size={19} color="#fff" />}
          </LinearGradient>
        </TouchableOpacity>
      </LinearGradient>
    </View>
  );
}

// Pick-up / drop-off row (folded from BookingDateTimeScreen). Reads its address
// off the draft; a zone change empties the draft (store invariant) so it falls
// back to the placeholder and the user is re-prompted.
function LocationRow({
  label, address, placeholder, filled, onPress,
}: {
  label: string;
  address?: string;
  placeholder: string;
  filled: boolean;
  onPress: () => void;
}) {
  return (
    <View>
      <Text style={s.fieldLabel}>{label}</Text>
      <TouchableOpacity
        style={[s.locRow, filled ? s.locRowFilled : s.locRowIdle]}
        onPress={onPress}
        activeOpacity={0.8}>
        <View style={s.locTopLight} />
        <View style={[s.locPin, filled ? s.locPinFilled : s.locPinIdle]}>
          <Icon
            name={filled ? 'map-marker' : 'map-marker-outline'}
            size={16}
            color={filled ? D.accent : D.textMute}
          />
        </View>
        <Text
          style={[s.locText, filled ? s.locTextFilled : s.locTextPlaceholder]}
          numberOfLines={1}>
          {filled ? address : placeholder}
        </Text>
        <Icon name="chevron-right" size={16} color={D.textMute} />
      </TouchableOpacity>
    </View>
  );
}

function Toggle({on, onPress, label}: {on: boolean; onPress: () => void; label: string}) {
  return (
    <TouchableOpacity
      activeOpacity={0.8}
      onPress={onPress}
      style={[s.toggle, on && s.toggleOn]}
      accessibilityRole="switch"
      accessibilityState={{checked: on}}
      accessibilityLabel={label}
      hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
      {on ? (
        <LinearGradient
          colors={['#6E9BF5', D.accentDeep]}
          start={{x: 0, y: 0}}
          end={{x: 0, y: 1}}
          style={StyleSheet.absoluteFill as never}
        />
      ) : null}
      <View style={[s.toggleThumb, on && s.toggleThumbOn]} />
    </TouchableOpacity>
  );
}

interface TeamCellProps {
  cap: string;
  value: number;
  minusDisabled?: boolean;
  plusDisabled?: boolean;
  onMinus: () => void;
  onPlus: () => void;
}

function TeamCell({cap, value, minusDisabled, plusDisabled, onMinus, onPlus}: TeamCellProps) {
  return (
    <View style={s.teamCell}>
      <Text style={s.teamCellCap}>{cap}</Text>
      <View style={s.teamCellRow}>
        <TouchableOpacity
          style={[s.stepBtn, minusDisabled && s.stepBtnDisabled]}
          onPress={onMinus}
          disabled={minusDisabled}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={`Decrease ${cap}`}
          hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
          <Icon name="minus" size={15} color={minusDisabled ? D.textFaint : D.textDim} />
        </TouchableOpacity>
        <Text style={s.stepVal}>{value}</Text>
        <TouchableOpacity
          onPress={onPlus}
          disabled={plusDisabled}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel={`Increase ${cap}`}
          hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
          <LinearGradient
            colors={plusDisabled ? ['#27324A', '#1C2436'] : ['#6E9BF5', D.accentDeep]}
            start={{x: 0, y: 0}}
            end={{x: 0, y: 1}}
            style={[s.stepBtnPri, plusDisabled && s.stepBtnDisabled]}>
            <Icon name="plus" size={15} color={plusDisabled ? D.textFaint : '#fff'} />
          </LinearGradient>
        </TouchableOpacity>
      </View>
    </View>
  );
}

interface AddonRowProps {
  icon: IconName;
  title: string;
  desc: string;
  price: number;
  on: boolean;
  onToggle: () => void;
}

function AddonRow({icon, title, desc, price, on, onToggle}: AddonRowProps) {
  return (
    <TouchableOpacity style={[s.addon, on ? s.addonOn : s.addonIdle]} onPress={onToggle} activeOpacity={0.85}>
      {on && <View style={s.cardTopLightSm} />}
      <View style={[s.addonIc, on ? s.addonIcOn : s.addonIcIdle]}>
        <Icon name={icon} size={21} color={on ? D.accentSoft : D.textMute} />
      </View>
      <View style={s.addonBody}>
        <View style={s.addonTitleRow}>
          <Text style={s.addonTitle} numberOfLines={1}>{title}</Text>
          <Text style={[s.addonPrice, on && s.addonPriceOn]}>+{price} BC/hr</Text>
        </View>
        <Text style={s.addonDesc} numberOfLines={2}>{desc}</Text>
      </View>
      <Toggle on={on} onPress={onToggle} label={title} />
    </TouchableOpacity>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: D.bg, overflow: 'hidden'},

  ambient: {
    position: 'absolute', top: -100, alignSelf: 'center',
    width: 460, height: 260, borderRadius: 230,
    backgroundColor: 'rgba(91,141,239,0.07)',
  },

  // Header
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

  scroll: {flex: 1},

  cardTopLight: {position: 'absolute', top: 0, left: 18, right: 18, height: 1, backgroundColor: 'rgba(255,255,255,0.1)'},
  cardTopLightSm: {position: 'absolute', top: 0, left: 16, right: 16, height: 1, backgroundColor: 'rgba(120,160,255,0.34)'},

  sectionLabel: {fontFamily: D.fMono, fontSize: 10, fontWeight: '600', letterSpacing: 2, color: D.textDim},

  // Team composition
  teamCard: {
    position: 'relative', overflow: 'hidden',
    borderRadius: 20, padding: 16,
    backgroundColor: 'rgba(18,24,36,0.7)', borderWidth: 1, borderColor: D.hair2,
  },
  teamCols: {flexDirection: 'row', gap: 12, marginTop: 14},
  /**
   * Founder 2026-08-08 — "please align this, it seems skew".
   *
   * The two cells stretch to a common height (teamCols leaves alignItems at
   * its `stretch` default), but their CONTENT was top-aligned — and the caps
   * are not the same height: "CPOs" is one line, "VEHICLES + DRIVERS" is two.
   * So the taller cap pushed its stepper down a full line while the shorter
   * one stayed put, and the two steppers sat on different baselines.
   *
   * Fixed twice over, because either alone has a hole:
   *   - `justifyContent: space-between` bottom-anchors the stepper, so the two
   *     line up no matter how many lines a cap takes — this is the one that
   *     survives fontScale 1.3+, where a cap can wrap to three lines;
   *   - `minHeight` on the cap reserves two lines even for the one-line "CPOs",
   *     so in the ordinary case both cells share the same internal rhythm
   *     rather than one having a visible gap under its cap.
   */
  teamCell: {
    flex: 1, paddingVertical: 13, paddingHorizontal: 12, borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair2,
    alignItems: 'center', justifyContent: 'space-between',
  },
  teamCellCap: {
    fontFamily: D.fMono, fontSize: 9, fontWeight: '700', letterSpacing: 1.4,
    color: D.textMute, marginBottom: 11,
    // Two lines' worth. `textAlign` because the cell centres the Text BOX but
    // not the lines inside it, so a wrapped cap rendered ragged-left inside a
    // centred block.
    lineHeight: 12, minHeight: 24, textAlign: 'center',
  },
  teamCellRow: {flexDirection: 'row', alignItems: 'center', gap: 9},
  stepBtn: {
    width: 36, height: 36, borderRadius: 11,
    backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: D.hair2,
    alignItems: 'center', justifyContent: 'center',
  },
  stepBtnDisabled: {opacity: 0.4},
  stepBtnPri: {
    width: 36, height: 36, borderRadius: 11,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center', justifyContent: 'center',
    shadowColor: D.accent, shadowOpacity: 0.5, shadowRadius: 12, shadowOffset: {width: 0, height: 6}, elevation: 6,
  },
  stepVal: {minWidth: 38, textAlign: 'center', fontFamily: D.fBold, fontSize: 22, color: D.text},
  clientVehicle: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 7, paddingHorizontal: 12, borderRadius: 11,
    backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.32)',
    // Matches `stepBtn`'s 36 so the Driver-Only branch, which swaps the stepper
    // for this chip, still lines up with the CPO stepper beside it — the same
    // skew one state over.
    minHeight: 36,
  },
  clientVehicleText: {fontFamily: D.fSemi, fontSize: 14, color: D.accentSoft},
  teamNote: {fontFamily: D.fSans, fontSize: 11.5, letterSpacing: -0.05, color: D.textMute, marginTop: 13, textAlign: 'center'},

  // Driver-only row
  driverRow: {
    position: 'relative', overflow: 'hidden',
    flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16, borderRadius: 17,
    backgroundColor: 'rgba(255,255,255,0.022)', borderWidth: 1, borderColor: D.hair,
  },
  driverRowOn: {backgroundColor: 'rgba(20,32,56,0.9)', borderColor: 'rgba(91,141,239,0.45)'},
  driverTitle: {fontFamily: D.fBold, fontSize: 15.5, letterSpacing: -0.2, color: D.text},
  driverDesc: {fontFamily: D.fSans, fontSize: 11.5, letterSpacing: -0.05, color: D.textMute, marginTop: 4},

  // Toggle
  toggle: {
    width: 48, height: 28, borderRadius: 999, flexShrink: 0, overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: D.hair2,
    justifyContent: 'center',
  },
  toggleOn: {borderColor: 'rgba(255,255,255,0.2)'},
  toggleThumb: {
    position: 'absolute', left: 2.5, width: 22, height: 22, borderRadius: 11, backgroundColor: '#fff',
    shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 5, shadowOffset: {width: 0, height: 2}, elevation: 3,
  },
  toggleThumbOn: {left: 22},

  // Approval notice
  alertWarn: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 11, padding: 14, borderRadius: 14,
    backgroundColor: 'rgba(245,181,68,0.07)', borderWidth: 1, borderColor: 'rgba(245,181,68,0.26)',
  },
  alertText: {flex: 1, fontFamily: D.fSans, fontSize: 11.5, color: D.textDim, lineHeight: 17},
  alertBold: {fontFamily: D.fSemi, color: D.amber},

  // Section row
  sectionRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 2},
  sectionMeta: {fontFamily: D.fMono, fontSize: 9, letterSpacing: 1, color: D.textMute},

  // Add-on rows
  addon: {
    position: 'relative', overflow: 'hidden',
    flexDirection: 'row', alignItems: 'center', gap: 14, padding: 15, borderRadius: 17,
  },
  addonIdle: {backgroundColor: 'rgba(255,255,255,0.022)', borderWidth: 1, borderColor: D.hair},
  addonOn: {
    backgroundColor: 'rgba(20,32,56,0.9)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.45)',
    shadowColor: D.accentDeep, shadowOpacity: 0.28, shadowRadius: 16, shadowOffset: {width: 0, height: 10}, elevation: 7,
  },
  addonIc: {
    width: 44, height: 44, borderRadius: 13, flexShrink: 0,
    alignItems: 'center', justifyContent: 'center',
  },
  addonIcIdle: {backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2},
  addonIcOn: {
    backgroundColor: 'rgba(91,141,239,0.16)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.4)',
    shadowColor: D.accent, shadowOpacity: 0.24, shadowRadius: 16, shadowOffset: {width: 0, height: 0}, elevation: 4,
  },
  addonBody: {flex: 1, minWidth: 0},
  addonTitleRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  addonTitle: {flex: 1, minWidth: 0, fontFamily: D.fBold, fontSize: 15, letterSpacing: -0.2, color: D.text},
  addonPrice: {flexShrink: 0, fontFamily: D.fMono, fontSize: 8.5, fontWeight: '600', letterSpacing: 0.4, color: D.textMute},
  addonPriceOn: {color: D.accentSoft},
  addonDesc: {fontFamily: D.fSans, fontSize: 11.5, letterSpacing: -0.05, color: D.textMute, marginTop: 4},

  // Rate bar
  rateBar: {
    position: 'relative', overflow: 'hidden',
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    padding: 16, borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair2,
  },
  rateBarTopLight: {position: 'absolute', top: 0, left: 16, right: 16, height: 1, backgroundColor: 'rgba(255,255,255,0.08)'},
  rateCap: {fontFamily: D.fMono, fontSize: 10, fontWeight: '600', letterSpacing: 1.5, color: D.textDim},
  rateSub: {fontFamily: D.fSans, fontSize: 10.5, color: D.textMute, marginTop: 4},
  rateAmtRow: {flexDirection: 'row', alignItems: 'baseline', gap: 5},
  rateAmt: {fontFamily: D.fBold, fontSize: 24, letterSpacing: -0.5, color: D.text},
  rateUnit: {fontFamily: D.fBold, fontSize: 14, color: D.accentSoft},
  // Issue 28 — partner / referral code field.
  refWrap: {marginTop: 14, gap: 6},
  notesInput: {height: 88, paddingTop: 10, letterSpacing: 0},
  refLabel: {fontFamily: D.fSemi, fontSize: 11.5, color: D.textDim},
  refInput: {
    minHeight: 44, borderRadius: 10, borderWidth: 1, borderColor: D.hair2,
    backgroundColor: 'rgba(255,255,255,0.03)', paddingHorizontal: 12,
    fontFamily: D.fSans, fontSize: 14, color: D.text, letterSpacing: 1,
  },
  refNote: {fontFamily: D.fSans, fontSize: 10.5, color: D.textMute, lineHeight: 14},

  // LM-M1 — estimated-total strip under the rate bar.
  totalRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12, marginTop: -6,
    backgroundColor: 'rgba(91,141,239,0.08)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.22)'},
  totalCap: {flexShrink: 1, fontFamily: D.fSemi, fontSize: 10, letterSpacing: 1.4, color: D.textMute},
  totalAmt: {flexShrink: 0, fontFamily: D.fBold, fontSize: 16, color: D.accentSoft},

  // Consent (auto path)
  consentRow: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 12,
    padding: 14, borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair2,
  },
  consentRowOn: {borderColor: 'rgba(91,141,239,0.45)', backgroundColor: 'rgba(91,141,239,0.08)'},
  checkbox: {
    width: 22, height: 22, borderRadius: 7, marginTop: 1,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: D.textMute, backgroundColor: 'transparent',
  },
  checkboxOn: {backgroundColor: D.accent, borderColor: D.accent},
  consentText: {flex: 1, fontFamily: D.fSans, fontSize: 12.5, lineHeight: 18, color: D.textDim},
  consentLink: {fontFamily: D.fSemi, color: D.accentSoft},

  // CTA
  ctaWrap: {position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20, paddingTop: 28},
  cta: {
    minHeight: 58, borderRadius: 18,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 11,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
    shadowColor: D.accent, shadowOpacity: 0.5, shadowRadius: 24, shadowOffset: {width: 0, height: 14}, elevation: 10,
  },
  ctaDisabled: {borderColor: D.hair2, shadowOpacity: 0, elevation: 0},
  ctaText: {fontFamily: D.fBold, fontSize: 16, letterSpacing: 0.3, color: '#fff'},

  // ── Zone section (folded from ZoneMapScreen) ──
  zoneRow: {flexDirection: 'row', gap: 10, marginTop: 12},
  zoneChip: {
    flex: 1, position: 'relative', overflow: 'hidden',
    padding: 13, borderRadius: 16, gap: 10,
    backgroundColor: 'rgba(255,255,255,0.022)', borderWidth: 1, borderColor: D.hair,
  },
  zoneChipOn: {backgroundColor: 'rgba(16,26,46,0.9)', borderColor: 'rgba(91,141,239,0.5)'},
  zoneCode: {
    width: 40, height: 40, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2,
  },
  zoneCodeOn: {backgroundColor: 'rgba(91,141,239,0.16)', borderColor: 'rgba(91,141,239,0.4)'},
  zoneCodeText: {fontFamily: D.fBold, fontSize: 13, letterSpacing: 0.5, color: D.textMute},
  zoneCodeTextOn: {color: D.accentSoft},
  zoneName: {fontFamily: D.fSemi, fontSize: 12, letterSpacing: -0.1, color: D.textDim},
  zoneNameOn: {color: D.text},

  // ── Schedule section (folded from BookingDateTimeScreen) ──
  schSection: {gap: 14},
  fieldLabel: {
    fontFamily: D.fMono, fontSize: 9.5, fontWeight: '700',
    letterSpacing: 1.8, color: D.textDim, marginBottom: 9, paddingLeft: 2,
  },
  schToggle: {
    flexDirection: 'row', padding: 5, borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.035)', borderWidth: 1, borderColor: D.hair2,
  },
  schTogglePillWrap: {position: 'absolute', top: 5, bottom: 5, left: 5},
  schTogglePill: {
    flex: 1, borderRadius: 14, borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
    shadowColor: D.accent, shadowOpacity: 0.5, shadowRadius: 18, shadowOffset: {width: 0, height: 8}, elevation: 8,
  },
  schToggleSeg: {flex: 1, paddingVertical: 12, paddingHorizontal: 8, alignItems: 'center'},
  schToggleT: {fontFamily: D.fBold, fontSize: 15, letterSpacing: 0.2, color: D.textDim},
  schToggleTOn: {color: '#fff'},
  schToggleS: {fontFamily: D.fMono, fontSize: 9.5, letterSpacing: 0.4, color: D.textMute, marginTop: 4},
  schToggleSOn: {color: 'rgba(255,255,255,0.8)'},

  // Location rows
  locRow: {
    position: 'relative', overflow: 'hidden',
    minHeight: 58, borderRadius: 16, flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 14,
  },
  locRowFilled: {backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2},
  locRowIdle: {backgroundColor: 'rgba(255,255,255,0.022)', borderWidth: 1, borderColor: D.hair},
  locTopLight: {position: 'absolute', top: 0, left: 14, right: 14, height: 1, backgroundColor: 'rgba(255,255,255,0.08)'},
  locPin: {
    width: 30, height: 30, borderRadius: 9, flexShrink: 0,
    alignItems: 'center', justifyContent: 'center',
  },
  locPinFilled: {backgroundColor: 'rgba(91,141,239,0.14)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.32)'},
  locPinIdle: {backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2},
  locText: {flex: 1, fontSize: 14.5, letterSpacing: -0.1},
  locTextFilled: {fontFamily: D.fSemi, color: D.text},
  locTextPlaceholder: {fontFamily: D.fSans, color: D.textFaint},
  gateHint: {fontFamily: D.fSans, fontSize: 11.5, color: D.amber, textAlign: 'center', marginTop: 2, marginBottom: 6},

  // Book Later
  laterBox: {
    padding: 14, borderRadius: 16, gap: 10,
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair2,
  },
  laterRow: {flexDirection: 'row', gap: 10},
  laterBtn: {
    flex: 1, paddingVertical: 13, borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2,
    flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'center',
  },
  laterBtnText: {fontFamily: D.fSemi, fontSize: 12.5, color: D.text, letterSpacing: 0.2},
  laterHint: {fontFamily: D.fMono, fontSize: 11, color: D.textMute, textAlign: 'center'},

  // Passenger stepper
  counter: {
    position: 'relative', overflow: 'hidden',
    minHeight: 60, paddingVertical: 10, borderRadius: 16, flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', paddingLeft: 14, paddingRight: 12,
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair2,
  },
  counterTopLight: {position: 'absolute', top: 0, left: 14, right: 14, height: 1, backgroundColor: 'rgba(255,255,255,0.08)'},
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
    width: 38, height: 38, borderRadius: 11,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center', justifyContent: 'center',
    shadowColor: D.accent, shadowOpacity: 0.5, shadowRadius: 12, shadowOffset: {width: 0, height: 6}, elevation: 6,
  },
  counterVal: {minWidth: 34, textAlign: 'center', fontFamily: D.fBold, fontSize: 20, color: D.text},

  // Schedule info hint
  schHint: {
    flexDirection: 'row', gap: 10, padding: 13, borderRadius: 13,
    backgroundColor: 'rgba(91,141,239,0.07)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.2)',
  },
  schHintText: {flex: 1, fontFamily: D.fSans, fontSize: 11, color: D.textDim, lineHeight: 16},
  schHintStrong: {fontFamily: D.fSemi, color: D.accentSoft},

  // iOS picker modal
  iosBackdrop: {flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(2,6,15,0.72)'},
  iosCard: {
    backgroundColor: '#0E1320', borderTopLeftRadius: 22, borderTopRightRadius: 22,
    paddingTop: 10, paddingHorizontal: 16,
    borderTopWidth: 1, borderTopColor: D.hair2,
  },
  iosDone: {
    height: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
    marginTop: 10, marginBottom: 20, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
  },
  iosDoneText: {fontFamily: D.fBold, fontSize: 15, color: '#fff', letterSpacing: 0.3},

  // ── Baseline card (folded from BaselinePackageScreen) ──
  baseCard: {
    position: 'relative', overflow: 'hidden',
    flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16, borderRadius: 18,
    backgroundColor: 'rgba(20,32,56,0.6)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.28)',
  },
  baseTopLight: {position: 'absolute', top: 0, left: 16, right: 16, height: 1, backgroundColor: 'rgba(120,160,255,0.34)'},
  baseCap: {fontFamily: D.fMono, fontSize: 9.5, fontWeight: '700', letterSpacing: 1.4, color: D.accentSoft},
  baseInc: {fontFamily: D.fSans, fontSize: 11.5, letterSpacing: -0.05, color: D.textMute, marginTop: 5},
  baseAmtRow: {flexDirection: 'row', alignItems: 'baseline', gap: 4, flexShrink: 0},
  baseAmt: {fontFamily: D.fBold, fontSize: 22, letterSpacing: -0.5, color: D.text},
  baseBc: {fontFamily: D.fBold, fontSize: 12, color: D.accentSoft},
}));
