/**
 * Booking · Step 09 — Live Operations
 *
 * Live tracking of an active mission. Mapbox WebView shows origin →
 * vehicle → destination polyline with a pulsing vehicle dot and ETA.
 * Segmented Route / Team / Chat tabs switch the lower panel. Emergency
 * CTA at the bottom routes to the SOS screen.
 *
 * For Phase 1, vehicle telemetry is simulated from a short canned
 * track. Once TelemetryService + WebSocket gateway land, swap the
 * `useSimulatedTelemetry` hook for the live stream.
 */
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, StatusBar, Platform,
  AppState, Modal, Image } from 'react-native';
import {Alert} from '@utils/alert';
import Geolocation from 'react-native-geolocation-service';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useBottomInset} from '@hooks/useBottomInset';
import {WebView, type WebViewMessageEvent} from 'react-native-webview';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Imagery} from '@theme/imagery';
import ImageryBackdrop from '@components/ui/ImageryBackdrop';
import {useNavigation, useRoute, useIsFocused, type RouteProp, type CompositeNavigationProp} from '@react-navigation/native';
import MissionStepper from '@components/mission/MissionStepper';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {BottomTabNavigationProp} from '@react-navigation/bottom-tabs';
import type {BookingStackParamList, MainTabParamList} from '@navigation/types';
import {Colors} from '@theme/colors';
import {BravoFont} from '@theme/bravo';
import {buildLiveRouteHtml} from '../../modules/booking/bravoLiveRouteMapHtml';
import {useMapReload} from '@/modules/maps/useMapReload';
import {MapFailedOverlay} from '@/modules/maps/MapFailedOverlay';
import {fetchDirections, splitRouteAtProgress, remainingRouteM, offRouteDistanceM, type DirectionsRoute, type LngLat} from '@utils/mapboxDirections';
import {shortPlaceLabel, placeWithContext} from '@utils/placeLabel';
import {missionProgress} from '@utils/missionProgress';
import {launchCall} from '@modules/messenger/webrtc/launchCall';
import {navigationRef} from '@navigation/navigationRef';
import {navigateToMessengerScreen, type MessengerTarget} from '@navigation/messengerDeepLink';
import {
  assignmentApi,
  bookingApi,
  telemetryApi,
  type AssignedCpoDto,
  type AssignedVehicleDto,
} from '@services/api';
import {useBookingStore} from '@store/bookingStore';
import {useMissionEvents} from '../../modules/messenger/runtime/useMissionEvents';
import {getLiveTransport, onTransport} from '../../modules/messenger/runtime/transportRegistry';
import type {TransportClient} from '@bravo/messenger-core';
import {scaleTextStyles, useContentWidth} from '@utils/scaling';
import {MAPBOX_TOKEN, MAPBOX_TOKEN_MISSING} from '@/modules/maps/mapToken';
import {mapHtmlSource} from '@/modules/maps/mapWebViewSource';
import {acceptGpsFix} from '@utils/gpsPlausibility';
import {ensureLiveLocationAccess, isServicesOffError, promptEnableLocationServices} from '@utils/locationPermission';
import {goBackOnce} from '@navigation/tapGuard';

// B-213 — composite nav so the CHAT tab can hop to MessengerTab.Chat
// (Chat lives on MessengerStackParamList, not BookingStack), same
// pattern as OpsMissionDetailScreen's mission-group hop.
type Nav = CompositeNavigationProp<
  NativeStackNavigationProp<BookingStackParamList, 'LiveTracking'>,
  BottomTabNavigationProp<MainTabParamList>
>;
type Rt  = RouteProp<BookingStackParamList, 'LiveTracking'>;

type Tab = 'route' | 'team' | 'chat';

interface TimelineEvent {
  id: string;
  ts: string;
  /**
   * Epoch ms this row actually happened / is predicted for, when known.
   * Rows with no real time (an event that has not occurred) leave it
   * undefined and simply keep their narrative position.
   */
  at?: number;
  title: string;
  sub?: string;
  kind: 'done' | 'current' | 'future';
}

interface MapPoint {lng: number; lat: number; label?: string}

// B-89 MG-07 — the simulated straight-line "telemetry" (buildTrack +
// useSimulatedTelemetry) is GONE: it animated a fake dot with an invented
// ETA whenever no real fix had arrived, which read as live protection
// motion. Pre-first-fix the dot now freezes at pickup under an honest
// "AWAITING LIVE GPS" chip; real fixes drive everything else.

// Poll `/telemetry/:id/latest` with audit-fix-3.3 exponential backoff.
// Base cadence is 5s; on consecutive failures back off up to 60s, with
// jitter to spread retries across the fleet. When the endpoint has no
// fix yet (mission hasn't started, agent hasn't checked in, server
// unreachable), the hook reports `hasLive = false` so callers can fall
// back to the simulated track without a visual jump.
const LIVE_POLL_BASE_MS = 5000;
const LIVE_POLL_MAX_MS  = 60_000;
function withJitter(ms: number): number {
  // ±25% jitter so a thundering herd of clients all reconnecting from
  // a network blip don't sync up on the next tick.
  return Math.round(ms * (0.75 + Math.random() * 0.5));
}
function useLiveTelemetry(bookingId: string | undefined, vehicleLabel: string) {
  const [fix, setFix] = useState<{lng: number; lat: number; etaMin: number; etaClock: string; recordedAt: string} | null>(null);
  const lastAcceptedRef = useRef<{lat: number; lng: number; recordedAt: string} | null>(null);

  useEffect(() => {
    if (!bookingId) {return;}
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let backoff = LIVE_POLL_BASE_MS;
    const poll = async () => {
      try {
        const {data} = await telemetryApi.latest(bookingId);
        if (cancelled) {return;}
        // Reset backoff on any successful round-trip — even a "no latest fix
        // yet" 200 OK is healthy server behaviour.
        backoff = LIVE_POLL_BASE_MS;
        // MG-13 — plausibility gate: reject null-island/teleport fixes
        // instead of letting the marker jump (the map's snap used to HIDE
        // genuine teleports rather than reject them).
        if (data.latest && acceptGpsFix(lastAcceptedRef.current, {
          lat: data.latest.lat, lng: data.latest.lng, recordedAt: data.latest.recorded_at,
        })) {
          lastAcceptedRef.current = {lat: data.latest.lat, lng: data.latest.lng, recordedAt: data.latest.recorded_at};
          const etaMin = data.latest.eta_minutes ?? 0;
          const eta = new Date(Date.now() + etaMin * 60_000);
          setFix({
            lng: data.latest.lng,
            lat: data.latest.lat,
            etaMin,
            etaClock: `${eta.getHours().toString().padStart(2, '0')}:${eta.getMinutes().toString().padStart(2, '0')}`,
            recordedAt: data.latest.recorded_at,
          });
        }
      } catch {
        // Exponential ramp on consecutive errors — capped at LIVE_POLL_MAX_MS.
        backoff = Math.min(backoff * 2, LIVE_POLL_MAX_MS);
      } finally {
        if (!cancelled) {timer = setTimeout(() => { void poll(); }, withJitter(backoff));}
      }
    };
    void poll();
    return () => { cancelled = true; if (timer) {clearTimeout(timer);} };
  }, [bookingId]);

  if (!fix) {return {hasLive: false as const};}
  return {
    hasLive: true as const,
    vehicle: {lng: fix.lng, lat: fix.lat, label: vehicleLabel},
    etaMin: fix.etaMin,
    etaClock: fix.etaClock,
    recordedAt: fix.recordedAt,
  };
}

export default function LiveTrackingScreen() {
  const insets = useSafeAreaInsets();
  const {bottomPad} = useBottomInset();
  const navigation = useNavigation<Nav>();
  const route = useRoute<Rt>();
  const webRef = useRef<WebView>(null);
  // MONITOR-MAP (#10) — cached real A→B route + fetch throttle for the two-tone
  // progress line (drawn via window.setNavRoute).
  const navRouteRef = useRef<DirectionsRoute | null>(null);
  const navKeyRef = useRef('');
  const navInFlightRef = useRef(false);
  const navFetchAtRef = useRef(0);

  const bookingId = route.params.bookingId;
  const activeBooking = useBookingStore(s => s.activeBooking);
  const loadActiveBooking = useBookingStore(s => s.loadActiveBooking);

  // Audit fix 5.1 — subscribe to mission lifecycle events via the
  // messenger WS so status / team / telemetry changes arrive via push
  // instead of waiting for the next polling tick. Polling loops below
  // remain as fallback (WS down, transport not booted yet, etc).
  const [transport, setTransport] = useState<TransportClient | null>(() => getLiveTransport());
  useEffect(() => onTransport(setTransport), []);

  const [tab, setTab] = useState<Tab>('route');
  // B-213 — fullscreen map toggle. The SAME WebView (same webRef/key) just
  // moves between the inline box and a fullscreen Modal; it is never
  // duplicated, so there is only ever one live map instance to keep in sync.
  const [mapExpanded, setMapExpanded] = useState(false);
  // Mirrored from the one mounted VerifyGuardCard so the fullscreen map can show
  // the same code without a second fetch or a second rotation clock.
  const [verifyCode, setVerifyCode] = useState<string | null>(null);
  // Drop the mirrored code the moment the identity changes, so the fullscreen
  // map can never show the previous booking's number while the new one loads.
  useEffect(() => { setVerifyCode(null); }, [bookingId]);
  /** Route tab: tap the destination row to reveal the full stored address. */
  const [destExpanded, setDestExpanded] = useState(false);
  // Deck page 7 — "do not let the map or control panel become off-center on
  // different screen sizes". Everything on this screen was width:'100%' with
  // fixed gutters, so on a tablet or an unfolded fold the map stretched to a
  // very wide, short band and the panels ran edge to edge. One centred content
  // column, the same helper the foldable work already uses elsewhere.
  const {contentMaxWidth, isLargeScreen} = useContentWidth();
  const contentCol = {maxWidth: contentMaxWidth, width: '100%' as const, alignSelf: 'center' as const};
  // B-77 — WebView map recovery: watchdog + auto-remount + RETRY overlay so a
  // failed Mapbox load never leaves a silent blank. `webReady` derives from the
  // health status, so the existing route/marker push effects keep working.
  const map = useMapReload();
  const webReady = map.status === 'ready';
  // B-214 — the Modal boundary mounts a BRAND NEW WebView that boots from
  // buildLiveRouteHtml's hardcoded default center (Dubai) until it gets its
  // first live push. `map.status` is driven only by explicit onReady()/
  // onError() calls, not by "a new WebView mounted" — it was already
  // 'ready' from the box's WebView, so `webReady` never flips false→true
  // again and the push effects below (gated + deduped on webReady) never
  // re-fire for the new instance, leaving it stuck on the wrong city
  // (founder-reported: "expand shows other country"). Routing the toggle
  // through map.retry() forces a genuine loading→ready cycle — the same
  // recovery path B-77's crash-remount already exercises — so the push
  // effects correctly wait for the NEW WebView's real `ready` signal
  // instead of firing too early (or never) against the stale status.
  const toggleMapExpanded = (next: boolean) => {
    setMapExpanded(next);
    map.retry();
  };

  // Audit remediation (mapbox H-3) — every polling loop + the GPS watch on this
  // screen is gated on "screen focused AND app foregrounded". Pushing SOS/Chat
  // on top or backgrounding the app used to leave ~5 timers and a high-accuracy
  // GPS watch running indefinitely.
  const isFocused = useIsFocused();
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', st => setAppActive(st === 'active'));
    return () => sub.remove();
  }, []);
  const screenActive = isFocused && appActive;

  // Audit remediation (mapbox M-1) — the WS telemetry push now feeds the map
  // directly instead of only triggering another HTTP poll. MG-14: the frame
  // now also carries eta/accuracy, so the panel + confidence circle update
  // sub-second without waiting for the poll.
  const [wsFix, setWsFix] = useState<{lng: number; lat: number; recordedAt: string; etaMin?: number; accuracyM?: number} | null>(null);
  const [team, setTeam] = useState<{cpos: AssignedCpoDto[]; vehicle: AssignedVehicleDto | null}>({
    cpos: [],
    vehicle: null,
  });

  // Hydrate the active booking so we can drive the map from real
  // pickup/dropoff coords instead of a canned DIFC→Palm route.
  // Audit fix 3.3 — exponential backoff + 30-minute hard cap.
  // After 30 min the screen stops auto-polling and the user can use
  // the "REFRESH" pull-down (or just navigate away/back) to retry.
  // The previous fixed 5s loop ran forever, draining battery if the
  // app was left open in the background.
  const [pollCapped, setPollCapped] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  useEffect(() => {
    if (!bookingId || !screenActive) {return;}
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let backoff = 5_000;
    let fails = 0;
    let capped = false;
    const startedAt = Date.now();
    const HARD_CAP_MS = 30 * 60_000;
    const SLOW_CAP_MS = 30_000;
    const tick = async () => {
      // LB-ST4 — loadActiveBooking never throws (it catches internally), so the
      // old try/catch backoff was dead code and a failing poll hammered every 5s.
      // Drive backoff + a reconnecting state off the returned success flag instead.
      const ok = await loadActiveBooking(bookingId);
      if (cancelled) {return;}
      if (ok) {
        backoff = 5_000; fails = 0;
        setReconnecting(false);
      } else {
        fails += 1;
        backoff = Math.min(backoff * 2, 60_000);
        // LB-API2 — after a few consecutive misses, say so instead of silently
        // freezing on a stale frame (which reads as "the API stopped working").
        if (fails >= 3) {setReconnecting(true);}
      }
      const ab = useBookingStore.getState().activeBooking;
      // B-405 — a go-now mission and parked future reservations now coexist,
      // so the store singleton can hold a DIFFERENT booking (an upcoming card
      // was viewed, then this poll's own load failed and left it in place).
      // Never drive THIS screen's terminal navigations off another booking's
      // status — skip the tick and retry.
      if (!ab || ab.id !== bookingId) {
        timer = setTimeout(() => { void tick(); }, capped ? SLOW_CAP_MS : withJitter(backoff));
        return;
      }
      const status = (ab?.status ?? '').toUpperCase();
      const ms = (ab?.mission_status ?? '').toUpperCase();
      // Auto-dispatch: the booking flips to COMPLETED on lead-Finish, but also bail out if
      // the mission itself reports COMPLETED (covers a lagging booking-status poll).
      // F2 — land on the completion moment (rate + invoice), not silently home.
      if (status === 'COMPLETED' || ms === 'COMPLETED') {
        navigation.replace('MissionComplete', {bookingId});
        return;
      }
      // Ops aborted the mission mid-flight. Bail out to the trip summary
      // so the user doesn't keep seeing "LIVE OPERATION" + an active SOS
      // button against a dead booking. Safety-critical: the SOS path must
      // not be reachable from a CANCELLED mission.
      if (status === 'CANCELLED') {
        navigation.replace('TripSummary', {bookingId});
        return;
      }
      // LM-U3 — the crew was stood down (mission ABORTED) but the booking is
      // being re-dispatched (DISPATCHING) or was closed some other way. The old
      // code only branched on COMPLETED/CANCELLED, parking the client on a dead
      // live map with an armed EMERGENCY button and frozen telemetry.
      if (ms === 'ABORTED') {
        if (status === 'DISPATCHING') {
          navigation.replace('FindingDetail', {bookingId});   // replacement search running
        } else if (status === 'AGENCY_NO_SHOW' || status === 'NO_PROVIDER') {
          navigation.replace('TripSummary', {bookingId});
        } else {
          navigation.replace('BookingConfirmation', {bookingId}); // stood down, booking still open
        }
        return;
      }
      if (status === 'AGENCY_NO_SHOW') {
        navigation.replace('TripSummary', {bookingId});
        return;
      }
      // LB-ST3 — after 30 min DON'T stop: the terminal navigations above live
      // inside this loop, so stopping also stranded a mission that completes late
      // (it never reached MissionComplete). Slow to a 30s cadence and keep going.
      // Flip the banner state only ONCE (on first crossing) so a manual "refresh
      // now" tap that clears it doesn't get re-shown on the next slow tick.
      if (Date.now() - startedAt > HARD_CAP_MS && !capped) {
        capped = true;
        setPollCapped(true);
      }
      timer = setTimeout(() => { void tick(); }, capped ? SLOW_CAP_MS : withJitter(backoff));
    };
    void tick();
    return () => { cancelled = true; if (timer) {clearTimeout(timer);} };
  }, [bookingId, loadActiveBooking, navigation, screenActive]);

  // ── Principal GPS push ─────────────────────────────────────────────
  // While this screen is mounted AND the booking is LIVE, push the
  // user's foreground GPS to the backend every 10s so ops can render
  // the principal marker on /live alongside the CPO Lead. Gated on
  // `activeBooking.status === 'LIVE'` — pushing GPS while CONFIRMED
  // (ops hasn't dispatched yet) is a privacy/battery regression.
  // Permission is handled inline (Android); iOS prompts on first watch
  // call. Failures are silent — if the user denies location, the live
  // screen still works (the principal marker just stays in "AWAITING"
  // state on ops).
  // B-405 — id-guard the singleton: never let a DIFFERENT live booking arm
  // this screen's GPS push (privacy gate — see the poll's id-guard above).
  const abOwn = activeBooking?.id === bookingId ? activeBooking : null;
  // Deck page 10 — the legend promises a "You" dot, but this was armed only at
  // LIVE, so through DISPATCHED and PICKUP the client had no "you are here" at
  // all: exactly the approach leg they are watching to see the officer arrive.
  // Armed for the whole assigned window instead; the same watcher already runs
  // for the server push, so there is no extra permission or battery cost.
  const liveForGps = ['DISPATCHED', 'PICKUP', 'LIVE', 'SOS']
    .includes((abOwn?.mission_status ?? '').toUpperCase())
    || (abOwn?.status ?? '').toUpperCase() === 'LIVE';
  // B-214 — the client's own position was pushed to the server (for ops'
  // /live view) but never shown on the client's OWN map. Same watcher,
  // no extra permission/battery cost: mirror each fix into local state so
  // the push effect below can draw a "you are here" marker too.
  const [selfPos, setSelfPos] = useState<{lat: number; lng: number} | null>(null);
  useEffect(() => {
    if (!bookingId) {return;}
    if (!liveForGps || !screenActive) {return;}
    let cancelled = false;
    let watchId: number | null = null;

    const start = async () => {
      if (Platform.OS === 'android') {
        // B-89 + founder requirement — on a LIVE mission, if access is
        // missing ASK AGAIN (branded rationale → re-request → Settings
        // when blocked) instead of the old silent return. Re-runs on
        // every screen refocus while live. Approximate-only grants are
        // accepted for the principal ping but flagged by the helper.
        const grant = await ensureLiveLocationAccess({
          title: 'Share live location with ops',
          message: 'Bravo Secure shares your position with ops while a mission is active so the protective detail can find and reach you.',
        });
        if (grant === 'denied' || grant === 'blocked') {return;}
      } else if (Platform.OS === 'ios') {
        // Audit fix 3.3 — was missing. iOS' Geolocation.watchPosition will
        // throw "Location services are disabled" on first call without
        // an explicit authorization request. `whenInUse` matches the
        // Info.plist usage description (we only push GPS while the
        // screen is foregrounded).
        const auth = await Geolocation.requestAuthorization('whenInUse');
        if (auth !== 'granted') {return;}
      }
      if (cancelled) {return;}

      // Throttle pushes to ~10s even if the watcher fires faster.
      let lastPush = 0;
      watchId = Geolocation.watchPosition(
        pos => {
          // B-214 — local marker updates every real fix (distanceFilter
          // already caps the rate); only the SERVER push stays throttled.
          setSelfPos({lat: pos.coords.latitude, lng: pos.coords.longitude});
          const now = Date.now();
          if (now - lastPush < 9000) {return;}
          lastPush = now;
          telemetryApi
            .clientPing(bookingId, {lat: pos.coords.latitude, lng: pos.coords.longitude})
            .catch(() => { /* keep watching; transient network blips are fine */ });
        },
        err => {
          // MG-05 — location services off used to fail SILENTLY (frozen
          // marker on ops, no explanation). Nudge once per session with a
          // jump to the system location settings.
          if (isServicesOffError(err)) {
            promptEnableLocationServices('Ops can’t see your position during the mission.');
          }
        },
        {
          enableHighAccuracy: true,
          distanceFilter: 10,        // metres
          interval: 10_000,          // android only
          fastestInterval: 5_000,    // android only
          // MG-05 — let the OS offer its "turn on location" resolution
          // dialog instead of suppressing it.
          showLocationDialog: true,
        },
      );
    };
    void start();
    return () => {
      cancelled = true;
      if (watchId !== null) {
        Geolocation.clearWatch(watchId);
        watchId = null;
      }
      // B-214 — drop the marker when the watcher stops (mission no longer
      // LIVE, screen unfocused) rather than leaving a stale dot on the map.
      setSelfPos(null);
    };
  }, [bookingId, liveForGps, screenActive]);

  // Audit fix 5.1 — wire push events into the same callbacks the
  // polling loops call. The hook resubscribes whenever the transport
  // ref flips (post-login, post-reconnect). bookingId is the room
  // key on the server (mission.service emits to both mission:<missionId>
  // and mission:<bookingId>).
  useMissionEvents(transport, bookingId, {
    onStatus: () => { void loadActiveBooking(bookingId); },
    onTeam:   () => { void assignmentApi.getTeam(bookingId).then(r => setTeam(r.data)).catch(() => undefined); },
    onTelemetry: (fix) => {
      // Apply the pushed fix immediately (sub-second vehicle updates).
      // MG-13 — same plausibility gate as the poll path: reject
      // null-island / teleport / hopeless-accuracy fixes.
      setWsFix(prev => {
        if (!acceptGpsFix(prev, {lat: fix.lat, lng: fix.lng, recordedAt: fix.recordedAt, accuracyM: fix.accuracy_m})) {
          return prev;
        }
        return {
          lng: fix.lng, lat: fix.lat, recordedAt: fix.recordedAt,
          etaMin: fix.eta_minutes, accuracyM: fix.accuracy_m,
        };
      });
    },
  });

  // Re-poll the team — ops may finish assignment after the user enters
  // the live screen, especially for cpo_count > pool-immediate-fill.
  // Audit fix 3.3 — exponential backoff with jitter; stops as soon as
  // the team is filled (no rescheduling on success-with-data).
  useEffect(() => {
    if (!bookingId || !screenActive) {return;}
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let backoff = 5_000;
    const schedule = () => { timer = setTimeout(() => { void tick(); }, withJitter(backoff)); };
    const tick = async () => {
      try {
        const res = await assignmentApi.getTeam(bookingId);
        if (cancelled) {return;}
        setTeam(res.data);
        backoff = 5_000;
        if (res.data.cpos.length === 0) {schedule();}
      } catch {
        backoff = Math.min(backoff * 2, 60_000);
        if (!cancelled) {schedule();}
      }
    };
    void tick();
    return () => { cancelled = true; if (timer) {clearTimeout(timer);} };
  }, [bookingId, screenActive]);

  // Real pickup / dropoff from the booking. If dropoff is null (timeslot
  // mission with no fixed B-point), we centre the map on pickup and treat
  // it as a stationary detail — origin == dest.
  type PickupShape = {address?: string; latitude?: number; longitude?: number} | null | undefined;
  const pickupAny = (activeBooking as unknown as {pickup?: PickupShape})?.pickup ?? null;
  const dropoffAny = (activeBooking as unknown as {dropoff?: PickupShape})?.dropoff ?? null;
  const origin: MapPoint = useMemo(
    () => ({
      lng: pickupAny?.longitude ?? 55.2806,
      lat: pickupAny?.latitude  ?? 25.2132,
      // Short name only — the full address used to be drawn on the map and
      // stretched a black bar across the route (deck page 16).
      label: `A · ${shortPlaceLabel(pickupAny?.address) || 'Pickup'}`,
    }),
    [pickupAny],
  );
  const dest: MapPoint = useMemo(
    () => ({
      lng: dropoffAny?.longitude ?? origin.lng,
      lat: dropoffAny?.latitude  ?? origin.lat,
      label: `B · ${shortPlaceLabel(dropoffAny?.address) || 'On-site detail'}`,
    }),
    [dropoffAny, origin.lng, origin.lat],
  );
  /** The destination as stored (full address) and as displayed (short name). */
  const dropoffFull = (dropoffAny?.address ?? '').trim();
  const destShort = placeWithContext(dropoffFull) || 'On-site detail';
  const vehicleLabel = team.vehicle?.call_sign ?? '—';
  // B-405 id-guard, same rule the poll and the GPS arm already use (abOwn above):
  // bookingStore.loadActiveBooking overwrites ONE global slot, and four other
  // screens call it. Reading the raw singleton here meant another booking's
  // status could drive this screen — which silently unmounted the verify-code
  // card and destroyed the code the client is meant to read aloud.
  const bookingStatus = (abOwn?.status ?? '').toUpperCase();
  // The booking FSM stays CONFIRMED while the mission advances, so drive the live view off
  // the mission status (surfaced by GET /bookings/:id). LIVE on either is "protection active".
  const missionStatus = (abOwn?.mission_status ?? '').toUpperCase();
  /** The identity handshake is live from dispatch until the detail ends. */
  const showVerify = ['DISPATCHED', 'PICKUP', 'LIVE', 'SOS'].includes(missionStatus);
  const isLive = missionStatus === 'LIVE' || bookingStatus === 'LIVE';
  // CLIENT-TRACKING (#13) — the headline must track the REAL mission state, not
  // only LIVE, or DISPATCHED/PICKUP wrongly read 'Awaiting Dispatch' while the
  // stepper advances (the "status not changing" perception).
  const dispatched = isLive || missionStatus === 'DISPATCHED' || missionStatus === 'PICKUP' || missionStatus === 'SOS';
  const headerText =
    (bookingStatus === 'COMPLETED' || missionStatus === 'COMPLETED') ? 'MISSION COMPLETE'
    : missionStatus === 'SOS' ? 'SOS ACTIVE'
    : isLive ? 'PROTECTION ACTIVE'
    : missionStatus === 'PICKUP' ? 'EN ROUTE TO PICKUP'
    : missionStatus === 'DISPATCHED' ? 'TEAM DISPATCHED'
    : (bookingStatus === 'CANCELLED' || missionStatus === 'ABORTED') ? 'MISSION ENDED'
    : 'AWAITING DISPATCH';
  const headerPill =
    (bookingStatus === 'COMPLETED' || missionStatus === 'COMPLETED') ? 'Done'
    : isLive ? 'Live'
    : missionStatus === 'PICKUP' ? 'Pickup'
    : missionStatus === 'DISPATCHED' ? 'Dispatched'
    : 'Confirmed';
  const live = useLiveTelemetry(isLive && screenActive ? bookingId : undefined, vehicleLabel);
  // MG-07 — real fixes ONLY. Until the first one arrives the dot freezes at
  // pickup under an honest "AWAITING LIVE GPS" chip; no fake motion, no
  // invented ETA. The WS-pushed fix wins over the polled one when newer.
  const wsNewer = !!wsFix && (!live.hasLive || !live.recordedAt
    || Date.parse(wsFix.recordedAt) >= Date.parse(live.recordedAt));
  const realFix = isLive
    ? (wsFix && wsNewer
        ? wsFix
        : live.hasLive ? {lng: live.vehicle.lng, lat: live.vehicle.lat, recordedAt: live.recordedAt} : null)
    : null;
  const hasRealFix = realFix !== null;
  const awaitingLiveFix = isLive && !hasRealFix;
  const vehicle  = realFix
    ? {lng: realFix.lng, lat: realFix.lat, label: vehicleLabel}
    // Deck page 11 — with no real fix the officer's marker is parked on the
    // PICKUP coordinates. Labelling it with the call sign (or '—') drew a
    // phantom officer sitting on the pickup pin; say what is actually true.
    : {lng: origin.lng, lat: origin.lat, label: 'Awaiting GPS'};
  // ETA: WS frame value when it rode the newest fix, else the poll's; never invented.
  const etaMin   = hasRealFix
    ? ((wsFix && wsNewer ? wsFix.etaMin : undefined) ?? (live.hasLive ? live.etaMin : 0))
    : 0;
  const etaClock = hasRealFix && etaMin > 0
    ? (() => {
        const t = new Date(Date.now() + etaMin * 60_000);
        return `${t.getHours().toString().padStart(2, '0')}:${t.getMinutes().toString().padStart(2, '0')}`;
      })()
    : '—';
  const vehicleAccuracyM = hasRealFix && wsFix && wsNewer ? (wsFix.accuracyM ?? null) : null;

  // Audit remediation (mapbox L-8) — surface telemetry staleness instead of
  // showing a confidently "live" dot on minutes-old data.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (!isLive || !screenActive) {return;}
    const t = setInterval(() => setNowTick(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [isLive, screenActive]);
  const fixAgeSec = realFix?.recordedAt
    ? Math.max(0, Math.round((nowTick - Date.parse(realFix.recordedAt)) / 1000))
    : null;
  const telemetryStale = fixAgeSec !== null && Number.isFinite(fixAgeSec) && fixAgeSec > 45;

  const html = useMemo(() => buildLiveRouteHtml(MAPBOX_TOKEN), []);
  // Why: a fresh {html} object every render relies on the WebView's internal
  // string diff to avoid a full map reload — keep the source identity stable.
  const webSource = useMemo(() => mapHtmlSource(html), [html]);

  // Push route updates whenever the vehicle moves OR the web becomes
  // ready after a late render. Audit fix 3.3 — depend on the primitive
  // fields, not the literal `vehicle` / `origin` / `dest` objects. Those
  // are recreated every render, which made the previous effect re-fire
  // on every parent re-render and spam injectJavaScript dozens of
  // times per second.
  useEffect(() => {
    if (!webReady || !screenActive) {return;}
    const payload = JSON.stringify({
      origin,
      dest,
      vehicle,
      etaLabel: awaitingLiveFix
        ? 'AWAITING LIVE GPS'
        : hasRealFix && etaMin > 0 ? `ETA ${etaClock} · ${etaMin} MIN` : 'LIVE',
    });
    webRef.current?.injectJavaScript(
      `try { window.setRoute(${payload}); } catch(e){} true;`,
    );
    // MG-14 — confidence circle when the newest fix carried its accuracy;
    // cleared when it didn't (review m-4 — a stale circle frozen behind a
    // moving dot reads as a second vehicle).
    if (vehicleAccuracyM !== null && vehicleAccuracyM !== undefined && vehicleAccuracyM > 0) {
      webRef.current?.injectJavaScript(
        `try { window.setVehicleAccuracy && window.setVehicleAccuracy(${vehicle.lng}, ${vehicle.lat}, ${Math.round(vehicleAccuracyM)}); } catch(e){} true;`,
      );
    } else {
      webRef.current?.injectJavaScript(
        'try { window.clearVehicleAccuracy && window.clearVehicleAccuracy(); } catch(e){} true;',
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    webReady, screenActive,
    vehicle.lng, vehicle.lat,
    origin.lng,  origin.lat,
    dest.lng,    dest.lat,
    etaClock,    etaMin,
    awaitingLiveFix, hasRealFix, vehicleAccuracyM,
  ]);

  // MONITOR-MAP (#10) — draw the REAL shortest road route A(pickup)→B(dropoff) and
  // a two-tone traveled/remaining progress line that fills as the vehicle moves.
  // Fetches once per A/B (cached); re-splits at the live vehicle on each fix. If
  // Directions is unavailable (no token / offline) it keeps setRoute's straight
  // fallback rather than blanking the safety-critical map.
  useEffect(() => {
    if (!webReady || !screenActive) {return;}
    const key = `${origin.lng.toFixed(4)},${origin.lat.toFixed(4)}|${dest.lng.toFixed(4)},${dest.lat.toFixed(4)}`;
    const veh: LngLat = {lng: vehicle.lng, lat: vehicle.lat};
    const apply = (rt: DirectionsRoute) => {
      const {traveled, remaining} = splitRouteAtProgress(rt.coordinates, veh);
      const toArr = (cs: LngLat[]) => cs.map(c => [c.lng, c.lat]);
      webRef.current?.injectJavaScript(
        `try { window.setNavRoute(${JSON.stringify({traveled: toArr(traveled), ahead: toArr(remaining)})}); } catch(e){} true;`,
      );
      const remM = remainingRouteM(rt.coordinates, veh);
      // Deck page 16 — "progress must update consistently and be linked to
      // pickup and drop-off mission states". The old pill was a bare percentage
      // to "B" that read 0% for the entire approach leg, which is neither
      // actionable nor tied to the stage. Say the remaining distance and which
      // leg it belongs to. MG-07 still holds: only a REAL fix moves it, and the
      // pill says so plainly instead of showing a false 0%.
      // Deck pages 11/16/17 — one stage-aware function, unit-tested at the leg
      // boundaries (missionProgress), rather than an inline expression that
      // nothing could verify.
      const progressLabel = missionProgress({
        missionStatus,
        bookingStatus,
        remainingM: remM,
        hasRealFix,
      }).label;
      webRef.current?.injectJavaScript(
        `try { window.setProgress(${JSON.stringify(progressLabel)}); } catch(e){} true;`,
      );
    };
    // Audit remediation (mapbox H-2) — off-route detection. Re-split the cached
    // route while the real vehicle stays within 60 m of it; on deviation,
    // reroute (throttled) from the live fix to the destination. Only a REAL
    // fix can trigger a reroute — the simulated straight-line track is
    // off-road by construction and would refetch forever.
    const cached = navKeyRef.current === key ? navRouteRef.current : null;
    const offM = cached && hasRealFix ? offRouteDistanceM(cached.coordinates, veh) : 0;
    const needsReroute = !!cached && offM > 60;
    if (cached) {
      apply(cached);
      if (!needsReroute) {return;}
    }
    if (navInFlightRef.current || Date.now() - navFetchAtRef.current < 6000) {return;}
    navInFlightRef.current = true;
    navFetchAtRef.current = Date.now();
    const from: LngLat = needsReroute ? veh : {lng: origin.lng, lat: origin.lat};
    void fetchDirections(from, {lng: dest.lng, lat: dest.lat})
      .then(rt => {
        navInFlightRef.current = false;
        if (rt && rt.coordinates.length >= 2) {
          navRouteRef.current = rt;
          navKeyRef.current = key;
          apply(rt);
        }
      })
      .catch(() => { navInFlightRef.current = false; });
  }, [webReady, screenActive, isLive, hasRealFix, missionStatus, bookingStatus, vehicle.lng, vehicle.lat, origin.lng, origin.lat, dest.lng, dest.lat]);

  // B-214 — "you are here": the client's own position, previously pushed
  // only to the server (for ops' /live view), was never drawn on the
  // client's own map. Mirrors setVehicleAccuracy's set/clear pair.
  useEffect(() => {
    if (!webReady || !screenActive) {return;}
    if (selfPos) {
      webRef.current?.injectJavaScript(
        `try { window.setSelf && window.setSelf(${selfPos.lng}, ${selfPos.lat}); } catch(e){} true;`,
      );
    } else {
      webRef.current?.injectJavaScript('try { window.clearSelf && window.clearSelf(); } catch(e){} true;');
    }
  }, [webReady, screenActive, selfPos]);

  // Deck pages 10 + 14 — the collapsed box is only ~328x252, so it sheds the
  // secondary chrome; and every size change re-frames the map so the expanded
  // view actually fits the whole route and every mission marker, rather than
  // relying on the remount's incidental first-fit.
  useEffect(() => {
    if (!webReady) {return;}
    webRef.current?.injectJavaScript(
      `try { window.setCompact && window.setCompact(${!mapExpanded}); } catch(e){} true;`,
    );
    webRef.current?.injectJavaScript(
      'try { window.refit && window.refit(); } catch(e){} true;',
    );
    // The fullscreen verify-code bar is an RN overlay the WebView cannot see.
    // Report the room it takes so the legend and the style segment sit BELOW it
    // rather than underneath — otherwise the marker key we just added is hidden
    // by the code bar in the very view the founder was in.
    const guard = mapExpanded && showVerify ? 60 : 10;
    webRef.current?.injectJavaScript(
      `try { window.setTopGuard && window.setTopGuard(${guard}); } catch(e){} true;`,
    );
  }, [webReady, mapExpanded, showVerify]);

  // Deck page 7 — Track Up becomes the default once protection is ACTIVE ("during
  // active navigation"); before that the client is waiting, and rotating a
  // watcher's map is disorienting. Either way the control is one tap away.
  useEffect(() => {
    if (!webReady) {return;}
    const mode = missionStatus === 'LIVE' || missionStatus === 'SOS' ? 'track' : 'north';
    webRef.current?.injectJavaScript(
      `try { window.setNavCamera && window.setNavCamera({mode: ${JSON.stringify(mode)}}); } catch(e){} true;`,
    );
  }, [webReady, missionStatus]);

  /**
   * Ring the whole mission group (ops + assigned officers). Uses the SAME
   * exported launchCall the driver tracker uses — no second call path.
   * isGroup is required: without it launchCall mis-routes a conversation the
   * store has not hydrated down the 1:1 path and the call silently fails.
   */
  const callMissionGroup = (conversationId: string, callType: 'voice' | 'video') => {
    if (!navigationRef.isReady()) {
      Alert.alert('Not ready', 'Try again in a moment.');
      return;
    }
    const rootNav = {
      navigate: (screen: string, params?: Record<string, unknown>) => {
        navigateToMessengerScreen(navigationRef as never, screen as MessengerTarget, params ?? {});
      },
    };
    launchCall(rootNav, {conversationId, callType, isGroup: true});
  };

  const onMessage = (e: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(e.nativeEvent.data) as {type?: string; where?: string; msg?: string; tReadyMs?: number; glMs?: number; glCached?: boolean | null; styleMs?: number; tiles?: number; netKb?: number};
      if (msg.type === 'ready') {
        // [MAPPERF] one line per map boot; console.warn survives release
        // builds (babel strips log, keeps warn), so SQA's logcat carries it.
        console.warn('[MAPPERF] client ready=' + msg.tReadyMs + 'ms gl=' + msg.glMs
          + 'ms cached=' + msg.glCached + ' style=' + msg.styleMs + 'ms tiles='
          + msg.tiles + ' net=' + msg.netKb + 'kB');
        map.onReady();
      }
      // MG-11 — fast-fail the watchdog ONLY on definitely-fatal boot
      // errors (WebGL init, token 401/403). GL also fires `error` for
      // recoverable pre-load tile blips — escalating those would burn the
      // one auto-retry on a load that was about to succeed (review m-2).
      const fatal = msg.type === 'gl-unsupported'
        || (msg.type === 'err' && (msg.where === 'init'
            || /401|403|unauthorized|forbidden|access token/i.test(String(msg.msg ?? ''))));
      if (fatal) {map.onError();}
    } catch { /* ignore */ }
  };

  const timeline: TimelineEvent[] = useMemo(() => {
    // UTC so the timeline matches the backend start_time / ops view.
    const fmt = (d: Date) =>
      `${d.getUTCHours().toString().padStart(2, '0')}:${d.getUTCMinutes().toString().padStart(2, '0')}Z`;
    const startIso = (activeBooking as unknown as {start_time?: string})?.start_time;
    const start = startIso ? new Date(startIso) : new Date();
    // MG-07 — "arrived" used to advance with the SIMULATED track; it now
    // tracks the real mission FSM only.
    const arrived = missionStatus === 'COMPLETED' || bookingStatus === 'COMPLETED';
    // Deck page 13 — the rows must describe what actually happened. "Departed"
    // was hard-coded done, so it claimed a departure while the booking was still
    // only CONFIRMED and no vehicle had been assigned.
    const departed = ['DISPATCHED', 'PICKUP', 'LIVE', 'SOS', 'COMPLETED']
      .includes(missionStatus);
    const items: TimelineEvent[] = [
      {
        id: 'depart',
        // A time is only shown once the thing has happened; the scheduled start
        // is not evidence of a departure.
        ts: departed ? fmt(start) : '—',
        at: departed ? start.getTime() : undefined,
        title: departed
          ? `Departed ${origin.label?.replace(/^A · /, '') ?? 'pickup'}`
          : `Departing ${origin.label?.replace(/^A · /, '') ?? 'pickup'}`,
        kind: departed ? 'done' : 'future',
      },
      {
        id: 'enroute',
        // Deck page 9 — this was a HARD-CODED `start + 6 minutes`: a timestamp
        // for an event that never happened, ungated and unmarked, and literally
        // the 06:06 in the founder's circled 06:00 / 06:06 / 05:59 sequence. The
        // client is never sent real mission timestamps (getById returns only
        // mission_status), so the honest answer is to show none.
        ts: '—',
        title: arrived ? 'Route complete' : 'En route',
        sub: vehicleLabel === '—' ? 'Vehicle assigned by ops'
          : hasRealFix ? `${vehicleLabel} · live telemetry` : `${vehicleLabel} · awaiting live GPS`,
        kind: arrived ? 'done' : 'current',
      },
    ];
    if (origin.lat !== dest.lat || origin.lng !== dest.lng) {
      items.push({
        id: 'arrive',
        // A PREDICTED time, marked as one. Rendered bare it sorted visually
        // against the past rows and produced the 06:00 / 06:06 / 05:59 sequence
        // the founder circled.
        ts: arrived
          ? fmt(new Date(Date.now()))
          : (hasRealFix && etaMin > 0 ? `~${fmt(new Date(Date.now() + etaMin * 60_000))}` : '—'),
        at: arrived
          ? Date.now()
          : (hasRealFix && etaMin > 0 ? Date.now() + etaMin * 60_000 : undefined),
        title: arrived
          ? `Arrived at ${dest.label?.replace(/^B · /, '') ?? 'destination'}`
          : `Approaching ${dest.label?.replace(/^B · /, '') ?? 'destination'}`,
        sub: arrived ? 'Mission detail begins' : (hasRealFix && etaMin > 0 ? `ETA ${etaMin} min` : 'ETA —'),
        kind: arrived ? 'done' : 'future',
      });
    }
    // Deck page 9 — "correct event ordering and timestamps". Ordering used to be
    // whatever order the builder happened to push rows in, which is how a
    // predicted arrival could print above an earlier real event. Enforce it:
    // rows that KNOW their time sort by it (stable, so equal times keep their
    // narrative order), and rows with no real time hold their position.
    const withTime = items
      .map((ev, i) => ({ev, i}))
      .filter(x => typeof x.ev.at === 'number')
      .sort((a, b) => ((a.ev.at as number) - (b.ev.at as number)) || (a.i - b.i));
    let cursor = 0;
    const ordered = items.map(ev =>
      typeof ev.at === 'number' ? withTime[cursor++].ev : ev,
    );
    return ordered;
  }, [activeBooking, etaMin, origin, dest, vehicleLabel, missionStatus, bookingStatus, hasRealFix]);

  const goEmergency = () => {
    navigation.navigate('SOSScreen', {bookingId});
  };

  // B-213 — shared between the inline collapsed box and the fullscreen
  // Modal (only one of which is ever mounted at a time, per mapExpanded)
  // so there is exactly one WebView JSX definition, never two live maps.
  const mapContent = MAPBOX_TOKEN_MISSING ? (
    // MG-04 — a tokenless build can never load GL; mounting the
    // WebView would just loop the watchdog. Say so instead.
    <MapFailedOverlay onRetry={() => {}} variant="misconfigured" />
  ) : (
    <>
      <WebView
        key={`live-map-${map.reloadKey}`}
        ref={webRef}
        source={webSource}
        onMessage={onMessage}
        style={s.web}
        javaScriptEnabled
        domStorageEnabled
        mixedContentMode="compatibility"
        originWhitelist={['*']}
        androidLayerType={Platform.OS === 'android' ? 'hardware' : undefined}
        scrollEnabled={false}
        bounces={false}
        onRenderProcessGone={map.retry}
        onContentProcessDidTerminate={map.retry}
      />
      {map.status === 'loading' && <MapFailedOverlay onRetry={map.retry} variant="loading" />}
      {map.status === 'failed' && <MapFailedOverlay onRetry={map.retry} />}
    </>
  );

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      <View style={s.nav}>
        {/* B-98b G3 — pushed live screen previously had no back control at all
            (escape was edge-swipe/hardware-back only). */}
        <TouchableOpacity
          onPress={() => goBackOnce(navigation)}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}
          activeOpacity={0.7}
          style={{paddingRight: 10}}>
          <Icon name="chevron-left" size={24} color={Colors.textPrimary} />
        </TouchableOpacity>
        <View style={s.navTitleRow}>
          <View style={[s.liveDot, !dispatched && {backgroundColor: Colors.warning, shadowColor: Colors.warning}]} />
          <Text style={s.navTitle}>{headerText}</Text>
        </View>
        <View style={[s.stepPill, !dispatched && {borderColor: Colors.warning}]}>
          <Text style={[s.stepPillText, !dispatched && {color: Colors.warning}]}>
            {headerPill}
          </Text>
        </View>
      </View>

      {/* B-213 — pinned directly below the header, OUTSIDE the ScrollView.
          This card carries the panic "This isn't my guard" control (F3) and
          used to live as the first scrollable item, so on any scroll it
          rode up flush against the fixed header with no consistent gap —
          reads as "the button is stuck up in the wrong place". As a fixed
          sibling of the header it now always sits in the same spot with
          the same breathing room, and never moves under scroll. */}
      {showVerify && bookingId && (
        <View style={[s.verifyCardPinned, contentCol]}>
          {/* Keyed on the booking: the code IS the identity handshake, so a card
              that kept another booking's code while the new one loads would have
              the client match a face against the wrong number. */}
          <VerifyGuardCard
            key={bookingId}
            bookingId={bookingId}
            vehicle={team.vehicle}
            onCode={setVerifyCode}
          />
        </View>
      )}

      <ScrollView
        style={s.scroll}
        contentContainerStyle={[{paddingBottom: 24, gap: 12, paddingTop: 4}, contentCol]}
        showsVerticalScrollIndicator={false}>

        {/* Step 18 shared stepper — same 6-step bar the agency + CPO see. CONFIRMED-awaiting
            reads step 2; LIVE reads step 5 (Protection active). */}
        <View style={{paddingHorizontal: 12, paddingVertical: 4}}>
          <MissionStepper booking={{status: bookingStatus}} mission={missionStatus ? {status: missionStatus} : undefined} />
        </View>

        {/* Executive Protection — the hour-by-hour record: the lead confirms each elapsed
            hour; the client sees the confirmations land here in real time. */}
        {activeBooking?.service === 'executive_protection' && (activeBooking?.duration_hours ?? 0) > 0 && (
          <View style={s.execHoursCard}>
            <View style={{flexDirection: 'row', alignItems: 'center', gap: 8}}>
              <Icon name="shield-crown" size={15} color="#A9C5FF" />
              <Text style={s.execHoursTitle}>
                Hourly check-ins · {(activeBooking?.hourly_checkins ?? []).length}/{activeBooking?.duration_hours}
              </Text>
            </View>
            {(activeBooking?.hourly_checkins ?? []).length === 0 ? (
              <Text style={s.execHoursEmpty}>
                Your team confirms each protected hour once it elapses — confirmations appear here.
              </Text>
            ) : (
              (activeBooking?.hourly_checkins ?? []).map(h => (
                <View key={h.hour_index} style={s.execHourRow}>
                  <Icon
                    name={h.status === 'ISSUE' ? 'alert-circle' : 'check-circle'}
                    size={14}
                    color={h.status === 'ISSUE' ? '#F5C76B' : '#4ADE80'}
                  />
                  <Text style={s.execHourText}>
                    Hour {h.hour_index} — {h.status === 'ISSUE' ? 'issue reported' : 'all smooth'}
                  </Text>
                  {!!h.comment && <Text style={s.execHourComment} numberOfLines={2}>{h.comment}</Text>}
                </View>
              ))
            )}
          </View>
        )}

        {!isLive && (
          <View style={s.dispatchBanner}>
            <Icon name="timer-sand" size={18} color={Colors.warning} />
            <View style={{flex: 1}}>
              <Text style={s.dispatchBannerTitle}>Awaiting Dispatch</Text>
              <Text style={s.dispatchBannerSub}>
                Your booking is confirmed. Ops is selecting your CPO team and vehicle — live telemetry begins on dispatch.
              </Text>
            </View>
          </View>
        )}

        {/* LB-API2 — a few consecutive poll misses: say we're reconnecting instead
            of silently freezing on a stale frame (reads as "the API stopped"). */}
        {reconnecting && (
          <View style={s.dispatchBanner} accessibilityLiveRegion="polite">
            <Icon name="wifi-alert" size={18} color={Colors.warning} />
            <View style={{flex: 1}}>
              <Text style={s.dispatchBannerTitle}>Reconnecting…</Text>
              <Text style={s.dispatchBannerSub}>
                We're having trouble reaching Bravo. Your detail is still active — retrying automatically.
              </Text>
            </View>
          </View>
        )}

        {/* LB-ST3 — after 30 min the poll SLOWS (30s) rather than stopping, so a
            late completion still routes. This banner just lets the user force an
            immediate refresh. */}
        {pollCapped && (
          <TouchableOpacity
            style={s.dispatchBanner}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel="Refresh now"
            onPress={() => {
              setPollCapped(false);
              void loadActiveBooking(bookingId);
            }}>
            <Icon name="refresh" size={18} color={Colors.warning} />
            <View style={{flex: 1}}>
              <Text style={s.dispatchBannerTitle}>Still waiting?</Text>
              <Text style={s.dispatchBannerSub}>
                Updates slowed after 30 minutes. Tap to refresh now, or contact support if dispatch is taking longer than expected.
              </Text>
            </View>
          </TouchableOpacity>
        )}

        {/* Telemetry staleness — be honest when the last fix is old. */}
        {isLive && telemetryStale && (
          <View style={s.dispatchBanner}>
            <Icon name="signal-off" size={18} color={Colors.warning} />
            <View style={{flex: 1}}>
              <Text style={s.dispatchBannerTitle}>Telemetry delayed</Text>
              <Text style={s.dispatchBannerSub}>
                Last vehicle fix {fixAgeSec}s ago — the map may lag the vehicle's true position.
              </Text>
            </View>
          </View>
        )}

        {/* MG-07 — honest pre-first-fix state (mission LIVE, no GPS yet). */}
        {awaitingLiveFix && (
          <View style={s.dispatchBanner}>
            <Icon name="crosshairs-gps" size={18} color={Colors.warning} />
            <View style={{flex: 1}}>
              <Text style={s.dispatchBannerTitle}>Awaiting live GPS</Text>
              <Text style={s.dispatchBannerSub}>
                Your protection team is live — the vehicle marker will move as soon as their first GPS fix arrives.
              </Text>
            </View>
          </View>
        )}

        {/* Mapbox live route. B-213 — collapsed box only; the fullscreen
            Modal below owns the WebView while expanded so there is never
            more than one live map instance mounted at once. */}
        {!mapExpanded && (
          <View style={[s.mapWrap, isLargeScreen && {aspectRatio: 16 / 9}]}>
            {mapContent}
            {!MAPBOX_TOKEN_MISSING && (
              <TouchableOpacity
                style={s.mapExpandBtn}
                activeOpacity={0.8}
                onPress={() => toggleMapExpanded(true)}
                accessibilityRole="button"
                accessibilityLabel="Expand map to full screen">
                <Icon name="arrow-expand" size={20} color={Colors.textPrimary} />
              </TouchableOpacity>
            )}
          </View>
        )}

        {/* Segmented tabs */}
        <View style={s.tabs}>
          {(['route', 'team', 'chat'] as Tab[]).map(t => (
            <TouchableOpacity
              key={t}
              style={s.tab}
              onPress={() => setTab(t)}
              activeOpacity={0.75}>
              <Text style={[s.tabText, tab === t && s.tabTextOn]}>
                {t.toUpperCase()}
              </Text>
              {tab === t && <View style={s.tabUnderline} />}
            </TouchableOpacity>
          ))}
        </View>

        {/* Tab content */}
        {tab === 'route' && (
          <View style={s.timeline}>
            {/* Deck page 9 — his handwriting was a question mark next to the
                rows: "destination?". The tab listed events but never named
                where the detail is actually going. Full address on tap. */}
            <TouchableOpacity
              style={s.destRow}
              activeOpacity={0.75}
              accessibilityRole="button"
              accessibilityLabel={`Destination ${dropoffFull || destShort}. Tap for the full address`}
              onPress={() => setDestExpanded(v => !v)}>
              <Icon name="flag-checkered" size={14} color={Colors.success} />
              <View style={{flex: 1, minWidth: 0}}>
                <Text style={s.destLabel}>DESTINATION</Text>
                <Text style={s.destName} numberOfLines={destExpanded ? 4 : 1}>
                  {destExpanded ? (dropoffFull || destShort) : destShort}
                </Text>
              </View>
              <Icon
                name={destExpanded ? 'chevron-up' : 'chevron-down'}
                size={16}
                color={Colors.textMuted}
              />
            </TouchableOpacity>
            {timeline.map(ev => (
              <View key={ev.id} style={s.tlEv}>
                <Text style={s.tlTs}>{ev.ts}</Text>
                <View style={s.tlBody}>
                  <View
                    style={[
                      s.tlDot,
                      ev.kind === 'done' && s.tlDotOk,
                      ev.kind === 'current' && s.tlDotCurrent,
                    ]}
                  />
                  <View style={{flex: 1}}>
                    <Text style={[s.tlMsg, ev.kind === 'current' && s.tlMsgCurrent]}>
                      {ev.title}
                    </Text>
                    {ev.sub && <Text style={s.tlSub}>{ev.sub}</Text>}
                  </View>
                </View>
              </View>
            ))}
          </View>
        )}

        {tab === 'team' && (
          <View style={s.panel}>
      <ImageryBackdrop source={Imagery.proLiveMap} variant="card" radius={10} />
            {team.cpos.length === 0 && !team.vehicle ? (
              <View style={s.teamPlaceholder}>
                <Icon name="account-search-outline" size={20} color={Colors.textMuted} />
                <Text style={s.teamPlaceholderTitle}>Awaiting team assignment</Text>
                <Text style={s.teamPlaceholderSub}>
                  Ops is selecting your CPOs and vehicle. This view updates automatically.
                </Text>
              </View>
            ) : (
              <>
                {team.cpos.map(c => (
                  <CrewRow
                    key={c.call_sign}
                    initials={crewInitials(c.display_name)}
                    name={`${c.call_sign} · ${c.display_name}`}
                    role={c.role}
                    photo={c.avatar_url}
                    company={c.company}
                    verified={c.verified}
                    available={c.accepted}
                  />
                ))}
                {team.vehicle && (
                  <CrewRow
                    key={team.vehicle.id}
                    initials="VH"
                    name={`${team.vehicle.call_sign} · ${team.vehicle.make_model}`}
                    role={team.vehicle.armored
                      ? `Armored · ${team.vehicle.armor_grade ?? 'B-grade'} · ${team.vehicle.plate}`
                      : team.vehicle.plate}
                  />
                )}
              </>
            )}
          </View>
        )}

        {tab === 'chat' && (
          <View style={s.panel}>
            {(() => {
              const convId = (activeBooking as unknown as {conversation_id?: string | null} | null)?.conversation_id;
              if (!convId) {
                return (
                  <Text style={s.chatEmpty}>
                    Mission chat opens here once ops dispatches the team. Members get auto-added on dispatch.
                  </Text>
                );
              }
              const memberCount = team.cpos.length + 1; // CPOs + ops admin
              const missionLabel =
                `Mission BS-${(activeBooking as {id?: string} | null)?.id?.replace(/-/g, '').slice(-8).toUpperCase() ?? ''}`;
              return (
                <View style={{gap: 10}}>
                  <View style={{flexDirection: 'row', alignItems: 'center', gap: 8}}>
                    <Icon name="account-group" size={16} color={Colors.success} />
                    <Text style={[s.crewName, {color: Colors.textPrimary}]}>
                      Mission group · {memberCount} member{memberCount === 1 ? '' : 's'}
                    </Text>
                  </View>
                  <Text style={s.chatEmpty}>
                    Encrypted group messenger with ops + assigned CPOs. Group disappears when ops closes the mission.
                  </Text>
                  {/* B-213 — this used to just tell the user to go hunt for the
                      chat manually from the Messenger tab; now it opens it
                      directly. Chat lives on MessengerStackParamList, not
                      BookingStack, so the composite Nav type hops tabs — same
                      pattern OpsMissionDetailScreen already uses for this
                      exact mission-group hop (B-85: `initial: false` is
                      LOAD-BEARING so back-from-Chat doesn't fall out of the
                      tab). */}
                  <TouchableOpacity
                    style={s.verifyRetry}
                    activeOpacity={0.85}
                    onPress={() => navigation.navigate('MessengerTab', {
                      screen: 'Chat',
                      initial: false,
                      params: {conversationId: convId, name: missionLabel, isGroup: true},
                    })}
                    accessibilityRole="button"
                    accessibilityLabel="Open mission chat">
                    <Icon name="message-text-outline" size={14} color="#A9C5FF" />
                    <Text style={s.verifyRetryText}>Open mission chat</Text>
                  </TouchableOpacity>
                  {/* Deck page 19 — the client had NO way to call their detail
                      from this screen; the only route was two navigations away
                      through the messenger. Same group call the crew uses. */}
                  <TouchableOpacity
                    style={s.verifyRetry}
                    activeOpacity={0.85}
                    onPress={() => callMissionGroup(convId, 'voice')}
                    accessibilityRole="button"
                    accessibilityLabel="Call all — ops and your officer">
                    <Icon name="phone" size={14} color="#A9C5FF" />
                    <Text style={s.verifyRetryText}>Call all · ops and your officer</Text>
                  </TouchableOpacity>
                </View>
              );
            })()}
          </View>
        )}
      </ScrollView>

      <View style={[s.ctaWrap, {paddingBottom: bottomPad(12)}]}>
        {/* LM-U9 — the panic control must be reachable by assistive tech. */}
        <TouchableOpacity style={s.ctaDanger} onPress={goEmergency} activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel="Emergency. Opens the SOS panic screen.">
          <Icon name="alert-octagon" size={16} color="#FFF" />
          <Text style={s.ctaText}>EMERGENCY</Text>
        </TouchableOpacity>
      </View>

      {/* B-213/B-214 — fullscreen map. Same webRef/onMessage/reloadKey as the
          collapsed box (mapContent is shared, defined once above); map.retry()
          in toggleMapExpanded forces a genuine loading→ready cycle so the
          push effects wait for THIS WebView's real ready signal instead of
          firing too early against a stale status. */}
      <Modal visible={mapExpanded} animationType="fade" onRequestClose={() => toggleMapExpanded(false)}>
        <View style={[s.mapFullscreen, {paddingTop: insets.top}]}>
          <StatusBar barStyle="light-content" backgroundColor={Colors.background} />
          <View style={s.mapFullscreenMap}>{mapContent}</View>
          {/* The verification code must survive expanding the map. The pinned
              card is a sibling of the header, so the fullscreen Modal used to
              cover it completely — tapping the expand control made the code the
              client is meant to read aloud disappear ("when I got in cpo, code
              gone"). This mirrors the SAME code (lifted from the one mounted
              card, so there is no second fetch and no second rotation). */}
          {showVerify && (
            <View style={[s.fsVerify, {top: insets.top + 12}]} pointerEvents="none">
              <Icon name="shield-account" size={13} color="#A9C5FF" />
              <Text style={s.fsVerifyLabel}>VERIFY</Text>
              <Text style={s.fsVerifyCode}>{verifyCode ?? '· · · · · ·'}</Text>
            </View>
          )}
          <TouchableOpacity
            style={[s.mapCollapseBtn, {top: insets.top + 12}]}
            activeOpacity={0.8}
            onPress={() => toggleMapExpanded(false)}
            accessibilityRole="button"
            accessibilityLabel="Collapse map">
            <Icon name="arrow-collapse" size={16} color={Colors.textPrimary} />
          </TouchableOpacity>
        </View>
      </Modal>
    </View>
  );
}

/**
 * F3 — on-arrival identity handshake. Shows the rotating verify code (the lead
 * shows the SAME code from their app — compare face-to-face) and the
 * "This isn't my guard" panic press (stamps the marker + raises a booking SOS).
 */
function VerifyGuardCard(
  {bookingId, vehicle, onCode}: {
    bookingId: string;
    vehicle: AssignedVehicleDto | null;
    /** Reports the live code up so the fullscreen map can mirror it. */
    onCode?: (code: string | null) => void;
  },
) {
  const [code, setCode] = useState<string | null>(null);
  // FRAUD-2 / P0 — the arrival code the principal SHOWS the guard to type back.
  const [arrivalCode, setArrivalCode] = useState<string | null>(null);
  const [lead, setLead] = useState<string | null>(null);
  const [panicking, setPanicking] = useState(false);
  // LB-OTP2 — explicit phase so we never paint the same silent dots for
  // "loading", "no crew yet", and a hard failure. 'ready' sticks through a
  // transient blip so a valid code isn't blanked on one bad poll.
  const [phase, setPhase] = useState<'loading' | 'awaiting' | 'error' | 'ready'>('loading');
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let backoff = 5_000;
    const pull = async () => {
      try {
        const {data} = await bookingApi.getVerifyCode(bookingId);
        if (!alive) {return;}
        setCode(data.code);
        setArrivalCode(data.arrival_code ?? null);
        onCode?.(data.code);
        setLead(data.lead?.display_name ?? data.lead?.call_sign ?? null);
        setPhase('ready');
        backoff = 5_000;
        const ms = Math.max(5_000, new Date(data.rotates_at).getTime() - Date.now());
        timer = setTimeout(() => { void pull(); }, Math.min(ms, 60_000));
      } catch (e: unknown) {
        if (!alive) {return;}
        // 400 no_crew_assigned / 404 = expected before a lead is assigned — keep
        // waiting quietly. 5xx / network = a real fault — surface it + let the user
        // retry, with a bounded backoff instead of an infinite silent 15s loop.
        const status = (e as {response?: {status?: number}})?.response?.status;
        const awaiting = status === 400 || status === 404;
        setPhase(prev => (prev === 'ready' ? 'ready' : awaiting ? 'awaiting' : 'error'));
        const wait = awaiting ? 10_000 : backoff;
        if (!awaiting) {backoff = Math.min(backoff * 2, 60_000);}
        timer = setTimeout(() => { void pull(); }, wait);
      }
    };
    void pull();
    return () => { alive = false; if (timer) {clearTimeout(timer);} };
  }, [bookingId, retryNonce, onCode]);

  const notMyGuard = () => {
    Alert.alert('This isn’t my guard?',
      'This immediately alerts the crew and Bravo ops, and flags the booking. Use it if the arriving person cannot show the matching code.',
      [{text: 'Back', style: 'cancel'},
       {text: 'Raise alert', style: 'destructive', onPress: () => {
         setPanicking(true);
         bookingApi.notMyGuard(bookingId)
           .then(() => Alert.alert('Alert raised', 'Ops and the crew have been alerted. Stay somewhere safe.'))
           .catch((e: unknown) => Alert.alert('Could not raise', (e as Error).message ?? 'Use the EMERGENCY button below.'))
           .finally(() => setPanicking(false));
       }}]);
  };

  return (
    <View style={s.verifyCard}>
      <View style={{flexDirection: 'row', alignItems: 'center', gap: 8}}>
        <Icon name="shield-account" size={16} color="#A9C5FF" />
        <Text style={s.verifyTitle}>Verify your detail{lead ? ` · ${lead}` : ''}</Text>
      </View>
      {phase === 'error' ? (
        <>
          <Text style={s.verifySub}>Couldn’t load your verify code — check your connection.</Text>
          <TouchableOpacity style={s.verifyRetry} activeOpacity={0.85}
            accessibilityRole="button" accessibilityLabel="Retry loading your verify code"
            onPress={() => { setPhase('loading'); setRetryNonce(n => n + 1); }}>
            <Icon name="refresh" size={14} color="#A9C5FF" />
            <Text style={s.verifyRetryText}>Retry</Text>
          </TouchableOpacity>
        </>
      ) : phase === 'awaiting' ? (
        <>
          <Text style={s.verifySub}>Waiting for your lead officer to be assigned…</Text>
          <Text style={s.verifyCode}>· · · · · ·</Text>
        </>
      ) : (
        <>
          <Text style={s.verifySub}>
            Ask the arriving officer for their code — it must match yours:
          </Text>
          <Text style={s.verifyCode}>{code ?? '· · · · · ·'}</Text>
          {/* FRAUD-2 / P0 — the arrival code the principal HANDS to the guard, who
              types it into their app so the server can prove they actually arrived.
              Green (give-this-out) to distinguish from the blue compare-code above. */}
          {arrivalCode && (
            <View style={s.verifyArrivalWrap}>
              <Text style={s.verifySub}>
                Then read this arrival code to your officer so they can confirm you on their app:
              </Text>
              <Text style={s.verifyArrivalCode}>{arrivalCode}</Text>
            </View>
          )}
        </>
      )}
      {/* Issue 30 — the client could verify the OFFICER but not the CAR. The
          data was already on /bookings/:id/team; it was only rendered inside
          the TEAM tab, not on the surface used to identify the arriving unit.
          Rendered only once a vehicle is actually assigned. */}
      {vehicle && (
        <View style={s.verifyVehicle}>
          <Icon name="car-estate" size={15} color="#A9C5FF" />
          <View style={{flex: 1, minWidth: 0}}>
            <Text style={s.verifyVehicleTitle} numberOfLines={1}>
              {[vehicle.colour, vehicle.make_model].filter(Boolean).join(' ')}
            </Text>
            <Text style={s.verifyVehicleSub} numberOfLines={1}>
              {vehicle.call_sign} · {vehicle.armored ? `Armored ${vehicle.armor_grade ?? ''}`.trim() : 'Standard'}
            </Text>
          </View>
          <Text style={s.verifyPlate} numberOfLines={1}>{vehicle.plate}</Text>
        </View>
      )}
      <TouchableOpacity style={s.verifyPanic} activeOpacity={0.85} disabled={panicking} onPress={notMyGuard}
        accessibilityRole="button" accessibilityLabel="This is not my guard. Raises an alert.">
        <Icon name="account-alert" size={14} color="#FF5D5D" />
        <Text style={s.verifyPanicText}>{panicking ? 'Raising…' : 'This isn’t my guard'}</Text>
      </TouchableOpacity>
    </View>
  );
}

function crewInitials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {return '--';}
  if (parts.length === 1) {return parts[0].slice(0, 2).toUpperCase();}
  return `${parts[0][0]}.${parts[parts.length - 1][0]}`.toUpperCase();
}

function CrewRow(
  {initials, name, role, photo, company, verified, available}:
  {
    initials: string; name: string; role: string; photo?: string | null;
    company?: string | null;
    /** Vetting complete — shown as a badge beside the name. */
    verified?: boolean;
    /** Has accepted this assignment. Undefined = not an officer row (vehicle). */
    available?: boolean;
  },
) {
  return (
    <View style={s.crew}>
      {/* Deck page 12 — "onboard photo of worker, guard, cpo, employee". The
          client is asked to match a face against a rotating code at handover,
          so initials alone were never enough to identify who is arriving.
          Initials remain the fallback when an officer has no photo. */}
      {photo ? (
        <Image source={{uri: photo}} style={s.avPhoto} accessibilityIgnoresInvertColors />
      ) : (
        <View style={s.av}><Text style={s.avText}>{initials}</Text></View>
      )}
      <View style={{flex: 1, minWidth: 0}}>
        <View style={s.crewNameRow}>
          <Text style={s.crewName} numberOfLines={1}>{name}</Text>
          {verified && (
            <Icon name="check-decagram" size={13} color={Colors.success} />
          )}
        </View>
        {/* Deck page 12 — role, company and live availability, not just a name. */}
        <Text style={s.crewRole} numberOfLines={1}>
          {[role, company].filter(Boolean).join(' · ')}
        </Text>
      </View>
      {available !== undefined && (
        <Text style={[s.crewAvail, available && {color: Colors.success}]}>
          {available ? 'ON TASK' : 'ASSIGNED'}
        </Text>
      )}
      <View
        style={[
          s.crewStatus,
          // Was hard-coded green for every officer, always — including one who
          // had not accepted yet.
          available === false && {backgroundColor: Colors.warning},
        ]}
      />
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
  navTitleRow: {flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8},
  liveDot: {
    width: 6, height: 6, borderRadius: 3, backgroundColor: Colors.danger,
    shadowColor: Colors.danger, shadowOpacity: 0.8, shadowRadius: 8,
    shadowOffset: {width: 0, height: 0}, elevation: 4,
  },
  navTitle: {
    fontFamily: BravoFont.semiBold, fontSize: 13, letterSpacing: 1.5,
    color: Colors.textPrimary,
  },
  stepPill: {
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999,
    backgroundColor: Colors.surfaceElevated,
    borderWidth: 1, borderColor: Colors.danger,
  },
  stepPillText: {
    fontSize: 10, fontWeight: '700', letterSpacing: 1.2,
    color: Colors.danger,
  },

  scroll: {flex: 1, paddingHorizontal: 16},
  // B-213 — verify-guard card, pinned below the header (see usage site).
  // paddingHorizontal matches `scroll`'s own 16 so the card keeps the same
  // total gutter (+ verifyCard's own marginHorizontal:12) it had inside it.
  verifyCardPinned: {paddingTop: 12, paddingHorizontal: 16},

  dispatchBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    padding: 12, borderRadius: 10,
    backgroundColor: 'rgba(255,193,7,0.08)',
    borderWidth: 1, borderColor: 'rgba(255,193,7,0.4)',
  },
  dispatchBannerTitle: {
    fontFamily: BravoFont.bold, fontSize: 12.5, color: Colors.warning,
    letterSpacing: 0.4, marginBottom: 2,
  },
  dispatchBannerSub: {
    fontSize: 11, color: Colors.textSecondary, lineHeight: 15,
  },
  // F3 — verify-your-guard card
  verifyVehicle: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    marginTop: 12, paddingTop: 12,
    borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.08)',
  },
  verifyVehicleTitle: {fontFamily: BravoFont.bold, fontSize: 13, color: '#E9EEF8'},
  verifyVehicleSub: {fontFamily: BravoFont.regular, fontSize: 11, color: 'rgba(180,188,204,0.62)', marginTop: 1},
  verifyPlate: {
    fontFamily: BravoFont.mono, fontSize: 13, fontWeight: '800', letterSpacing: 1.5,
    color: '#A9C5FF', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6,
    borderWidth: 1, borderColor: 'rgba(91,141,239,0.35)', backgroundColor: 'rgba(91,141,239,0.10)',
  },
  verifyCard: {
    marginHorizontal: 12, padding: 14, borderRadius: 12, gap: 8,
    backgroundColor: 'rgba(91,141,239,0.08)',
    borderWidth: 1, borderColor: 'rgba(91,141,239,0.28)',
  },
  verifyTitle: {fontFamily: BravoFont.bold, fontSize: 13, fontWeight: '700', color: Colors.textPrimary},
  verifySub: {fontFamily: BravoFont.regular, fontSize: 11, color: Colors.textSecondary, lineHeight: 15},
  verifyCode: {fontFamily: BravoFont.mono, fontSize: 26, fontWeight: '800', letterSpacing: 6, color: '#A9C5FF', textAlign: 'center', paddingVertical: 4},
  verifyArrivalWrap: {marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: 'rgba(91,141,239,0.20)', gap: 4},
  verifyArrivalCode: {fontFamily: BravoFont.mono, fontSize: 26, fontWeight: '800', letterSpacing: 6, color: '#7FD1A6', textAlign: 'center', paddingVertical: 4},
  verifyPanic: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 9, borderRadius: 10,
    backgroundColor: 'rgba(255,93,93,0.08)', borderWidth: 1, borderColor: 'rgba(255,93,93,0.30)',
  },
  verifyPanicText: {fontFamily: BravoFont.bold, fontSize: 12, fontWeight: '700', color: '#FF5D5D'},
  verifyRetry: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 9, borderRadius: 10,
    backgroundColor: 'rgba(91,141,239,0.10)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.30)',
  },
  verifyRetryText: {fontFamily: BravoFont.bold, fontSize: 12, fontWeight: '700', color: '#A9C5FF'},

  mapWrap: {
    width: '100%', aspectRatio: 1.3 / 1,
    borderRadius: 12, overflow: 'hidden',
    backgroundColor: Colors.backgroundDepth,
    borderWidth: 1, borderColor: Colors.surfaceBorder,
  },
  web: {flex: 1, backgroundColor: Colors.backgroundDepth},
  // B-213 — map expand/collapse
  mapExpandBtn: {
    // Deck page 17, "over sat function". This RN button sat at top:10/right:10 —
    // the EXACT coordinates of the WebView's own DARK/LIGHT/SAT segment
    // (.styleseg in bravoLiveRouteMapHtml), which RN cannot see or lay out
    // around. It covered the SAT option. Dropped below that row instead; keep
    // these two in step if the segment's height ever changes.
    position: 'absolute', top: 42, right: 10,
    // 44dp minimum touch target — it was a 30dp icon-only button, under the
    // platform floor and easy to miss (deck page 7, "must be obvious").
    width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(5,7,11,0.65)',
    borderWidth: 1, borderColor: Colors.surfaceBorder,
  },
  mapFullscreen: {flex: 1, backgroundColor: Colors.background},
  mapFullscreenMap: {flex: 1, backgroundColor: Colors.backgroundDepth},
  mapCollapseBtn: {
    position: 'absolute', right: 12,
    width: 34, height: 34, borderRadius: 17,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(5,7,11,0.75)',
    borderWidth: 1, borderColor: Colors.surfaceBorder,
  },
  // The verify code, mirrored into the fullscreen map. Left-anchored so it
  // never runs into the collapse control on the right.
  fsVerify: {
    position: 'absolute', left: 12, right: 58,
    flexDirection: 'row', alignItems: 'center', gap: 7,
    paddingHorizontal: 10, paddingVertical: 7, borderRadius: 10,
    backgroundColor: 'rgba(5,7,11,0.82)',
    borderWidth: 1, borderColor: Colors.surfaceBorder,
  },
  fsVerifyLabel: {
    fontFamily: BravoFont.semiBold, fontSize: 9, letterSpacing: 1.4,
    color: Colors.textMuted,
  },
  fsVerifyCode: {
    flex: 1, textAlign: 'right',
    fontFamily: BravoFont.mono, fontSize: 17, fontWeight: '800',
    letterSpacing: 3.5, color: '#A9C5FF',
  },

  tabs: {
    flexDirection: 'row',
    borderBottomWidth: 1, borderBottomColor: Colors.surfaceBorder,
  },
  tab: {flex: 1, paddingVertical: 10, alignItems: 'center', position: 'relative'},
  tabText: {
    fontFamily: BravoFont.bold, fontSize: 11,
    color: Colors.textMuted, letterSpacing: 1.2,
  },
  tabTextOn: {color: Colors.textPrimary},
  tabUnderline: {
    position: 'absolute', left: '15%', right: '15%', bottom: -1,
    height: 2, backgroundColor: Colors.primary, borderRadius: 2,
    shadowColor: Colors.primary, shadowOpacity: 0.5, shadowRadius: 8,
    shadowOffset: {width: 0, height: 0}, elevation: 2,
  },

  timeline: {flexDirection: 'column', gap: 2, paddingTop: 6},
  tlEv: {flexDirection: 'row', gap: 10, paddingVertical: 8},
  tlTs: {
    fontFamily: BravoFont.semiBold, fontSize: 10.5,
    color: Colors.textMuted, width: 42, letterSpacing: 0.3,
  },
  tlBody: {flex: 1, flexDirection: 'row', gap: 8, alignItems: 'flex-start'},
  tlDot: {
    width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.primary,
    marginTop: 4,
    shadowColor: Colors.primary, shadowOpacity: 0.5, shadowRadius: 6,
    shadowOffset: {width: 0, height: 0}, elevation: 2,
  },
  tlDotOk:      {backgroundColor: Colors.success, shadowColor: Colors.success},
  tlDotCurrent: {backgroundColor: Colors.warning, shadowColor: Colors.warning, shadowOpacity: 0.8},
  tlMsg: {fontSize: 11.5, color: Colors.textPrimary, lineHeight: 15, fontWeight: '500'},
  tlMsgCurrent: {fontWeight: '700'},
  tlSub: {fontSize: 10.5, color: Colors.textMuted, marginTop: 2, lineHeight: 14},

  panel: {
    padding: 12, borderRadius: 10,
    backgroundColor: Colors.surfaceElevated, borderWidth: 1, borderColor: Colors.surfaceBorder,
    gap: 8,
  },
  teamPlaceholder: {
    alignItems: 'center', justifyContent: 'center',
    paddingVertical: 18, paddingHorizontal: 12, gap: 6,
  },
  teamPlaceholderTitle: {
    fontFamily: BravoFont.bold, fontSize: 12, color: Colors.textPrimary,
    letterSpacing: 0.4,
  },
  teamPlaceholderSub: {
    fontSize: 11, color: Colors.textMuted, textAlign: 'center', lineHeight: 16,
  },
  crew: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    padding: 10, borderRadius: 8,
    backgroundColor: Colors.surfaceOverlay, borderWidth: 1, borderColor: Colors.surfaceBorder,
  },
  av: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.borderDefault,
    alignItems: 'center', justifyContent: 'center',
  },
  destRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, marginBottom: 10,
    backgroundColor: Colors.surfaceElevated,
    borderWidth: 1, borderColor: Colors.surfaceBorder,
  },
  destLabel: {
    fontFamily: BravoFont.semiBold, fontSize: 9, letterSpacing: 1.4,
    color: Colors.textMuted, marginBottom: 2,
  },
  destName: {
    fontFamily: BravoFont.bold, fontSize: 13, lineHeight: 18, color: Colors.textPrimary,
  },
  crewNameRow: {flexDirection: 'row', alignItems: 'center', gap: 5},
  crewAvail: {
    fontFamily: BravoFont.semiBold, fontSize: 8.5, letterSpacing: 1,
    color: Colors.textMuted,
  },
  avPhoto: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.borderDefault,
  },
  avText: {
    fontFamily: BravoFont.bold, fontSize: 11,
    color: Colors.textSecondary, letterSpacing: 0.3,
  },
  crewName: {
    fontFamily: BravoFont.bold, fontSize: 12, color: Colors.textPrimary,
    letterSpacing: -0.1,
  },
  crewRole: {fontSize: 10.5, color: Colors.textMuted, marginTop: 2},
  crewStatus: {
    width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.success,
    shadowColor: Colors.success, shadowOpacity: 0.6, shadowRadius: 6,
    shadowOffset: {width: 0, height: 0}, elevation: 2,
  },

  chatEmpty: {fontSize: 11.5, color: Colors.textSecondary, lineHeight: 16},

  ctaWrap: {
    paddingHorizontal: 16, paddingTop: 12,
    borderTopWidth: 1, borderTopColor: Colors.surfaceBorder,
    backgroundColor: Colors.background,
  },
  ctaDanger: {
    height: 48, borderRadius: 8, backgroundColor: '#FF3B3B',
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    shadowColor: '#FF3B3B', shadowOpacity: 0.35, shadowRadius: 14,
    shadowOffset: {width: 0, height: 6}, elevation: 8,
  },
  ctaText: {
    fontFamily: BravoFont.bold, fontSize: 13, color: '#FFF',
    letterSpacing: 1.2,
  },

  // Executive Protection — hourly check-in timeline (client view)
  execHoursCard: {
    marginHorizontal: 12, padding: 14, borderRadius: 14, gap: 9,
    backgroundColor: 'rgba(91,141,239,0.07)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.24)',
  },
  execHoursTitle: {fontFamily: BravoFont.semiBold, fontSize: 12.5, color: '#F2F4F8'},
  execHoursEmpty: {fontFamily: BravoFont.medium, fontSize: 11.5, lineHeight: 16, color: 'rgba(180,188,204,0.6)'},
  execHourRow: {flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap'},
  execHourText: {fontFamily: BravoFont.semiBold, fontSize: 12, color: '#E5E9F2'},
  execHourComment: {flexBasis: '100%', fontFamily: BravoFont.medium, fontSize: 11, lineHeight: 15, color: 'rgba(180,188,204,0.6)', paddingLeft: 22},
}));
