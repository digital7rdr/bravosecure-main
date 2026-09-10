/**
 * Agent Live Tracker Screen
 *
 * Map-first companion to MissionLeadConsoleScreen. The agent is
 * moving — chrome is minimal, the map and incoming comms are the
 * entire surface.
 *
 *   • Mapbox WebView (bravoAgentTrackerMapHtml) renders pickup,
 *     dropoff, route polyline, the agent's CPO marker (with heading
 *     cone + ripple ring) and the principal marker.
 *   • On-map speech bubbles render every new mission-group message
 *     directly above the sender's marker — fade in 200ms, hold 6s,
 *     fade out 180ms. Stack max 2; older bubbles collapse into a +N
 *     chip. System events render as square info-blue bubbles
 *     anchored to waypoints (not markers).
 *   • Mini-status strip auto-updates as waypoints fire / ETA changes
 *     so the agent always sees the latest event without scanning chat.
 *   • Message dock: typed text SENDS directly into the mission Ops Room
 *     (runtime.sendText, same encryption/receipts model ChatScreen uses —
 *     B-212, previously this just navigated to Chat with the text prefilled,
 *     requiring a second manual send). Call buttons launch the group SFU
 *     call directly too, via the app-root navigationRef so it works from
 *     every mode's nested stack. Tapping a bubble/chip (not the dock) still
 *     opens the full Chat screen to read history (mission.comms_channel_id).
 *   • Right-edge slide handle opens the legacy MissionLeadConsole
 *     (with manual mark buttons) as a horizontal slide-in panel —
 *     swipe right or tap the close button to dismiss.
 *   • Mission complete → MissionSummary screen handles the post-mortem.
 *
 * Backend feed: polls agentApi.getMissionDeployment every 4s. The
 * waypoint list, coordinates, and short-code are the source of truth.
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  View, Text, StyleSheet, StatusBar, TouchableOpacity, TextInput,
  Platform, Animated, PanResponder, Modal, AppState, useWindowDimensions,
  AccessibilityInfo, ActivityIndicator,
} from 'react-native';
import {Alert} from '@utils/alert';
import {WebView, type WebViewMessageEvent} from 'react-native-webview';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useMapReload} from '@/modules/maps/useMapReload';
import {MapFailedOverlay} from '@/modules/maps/MapFailedOverlay';
import BravoMap from '@/modules/maps/BravoMap';
import type {
  BravoMapHandle,
  CpoPayload,
  NavRoutePayload,
  RoutePayload,
} from '@/modules/maps/BravoMap';
import type {PushBubbleInput, PushSystemInput} from '@/modules/maps/bubbleStacks';
import {NATIVE_MAP_ENABLED} from '@/modules/maps/nativeMapbox';
import {useNavigation, useRoute, useIsFocused} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {AgentStackParamList} from '@navigation/types';
import {agentApi, orgApi} from '@services/api';
import MissionLeadConsoleScreen from './MissionLeadConsoleScreen';
import {useMessengerStore} from '@modules/messenger/store/messengerStore';
import {useShallow} from 'zustand/react/shallow';
// B-659 — resolves mission-room sender ids to real profile names.
import {ensureDirectoryNames} from '@/modules/messenger/contacts/directoryNames';
import {useAuthStore} from '@store/authStore';
import NetworkLatencyChip from '@components/NetworkLatencyChip';
import MissionStepper from '@components/mission/MissionStepper';
import {launchCall} from '@modules/messenger/webrtc/launchCall';
import {useMessenger} from '@modules/messenger/hooks';
import {navigationRef} from '@navigation/navigationRef';
import {navigateToMessengerScreen, type MessengerTarget} from '@navigation/messengerDeepLink';
import {haptics} from '@utils/haptics';
import {useKeyboardLayout} from '@hooks/useKeyboardLayout';
import {scaleTextStyles} from '@utils/scaling';
import {
  fetchDirections, splitRouteAtProgress, nextManeuver, formatDistance, offRouteDistanceM,
  remainingRouteM, nearestIndexOnRoute, haversineM, speedLimitAtKph, currentRoadName,
  type DirectionsRoute, type LngLat,
} from '@utils/mapboxDirections';

import {subscribeOwnPosition} from '@services/ownPositionBus';
import {missionActionView, missionActionConfirm} from '@screens/cpo/missionAction';
import {useMissionAdvance} from '@screens/cpo/useMissionAdvance';
import {pickAnnouncement, routeVoiceId} from '@utils/navVoice';
import {getActiveCall} from '@modules/messenger/runtime/callRegistry';
import {getActiveGroupCall} from '@modules/messenger/runtime/groupCallRegistry';
import {MAPBOX_TOKEN, MAPBOX_TOKEN_MISSING} from '@/modules/maps/mapToken';
import {mapHtmlSource} from '@/modules/maps/mapWebViewSource';
import {goBackOnce} from '@navigation/tapGuard';

type Nav = NativeStackNavigationProp<AgentStackParamList>;

// The same map-first tracker serves the assigned agent ('agent'), the managed
// CPO ('cpo', mounted in CpoNavigator), and the org manager desk monitor
// ('monitor', Step 32 — reads the org-scoped live endpoint, SOS hidden). The
// mode steers the data source, terminal navigation, and comms hand-off.
type TrackerMode = 'agent' | 'cpo' | 'monitor';

// How long an own-device fix keeps ownership of the driver's marker before the
// server's (slower) copy is allowed back in. Comfortably longer than the 1 Hz
// watch, short enough that a genuinely dead GPS falls back within one poll.
const OWN_FIX_TTL_MS = 15_000;

/**
 * How close the vehicle must be to the pickup point for the checkpoint to read as
 * a normal confirmation. Beyond it the control stays VISIBLE but becomes an
 * explicit override that names the distance — the founder's deck asks for
 * "visible only when the assigned team is at or near the pickup point, with an
 * operational override if required", and hiding the control outright strands a
 * driver whose GPS is poor or whose pickup pin is wrong.
 *
 * This is a CLIENT-side emphasis rule only. The server's geofence stays a warning
 * to ops and must never become a block.
 */
const PICKUP_RADIUS_M = 150;

function checkpointIcon(action: string): IconName {
  if (action === 'start') {return 'map-marker-check';}
  if (action === 'go-live') {return 'account-check';}
  return 'flag-checkered';
}

/**
 * expo-speech is a NATIVE module. Resolving it lazily keeps a build where it
 * is not linked (an older APK, a bare debug client) from throwing during module
 * initialisation and taking down the whole agent/CPO navigator — navigation
 * degrades to silent instead of crashing. Same lazy-require idiom the map HTML
 * already uses below.
 */
type SpeechLike = {
  speak: (text: string, opts?: {language?: string}) => void;
  stop: () => Promise<void>;
};
const SILENT_SPEECH: SpeechLike = {speak: () => undefined, stop: () => Promise.resolve()};
let speechMod: SpeechLike | null = null;
function speech(): SpeechLike {
  if (!speechMod) {
    try {
      speechMod = require('expo-speech') as SpeechLike;
    } catch {
      speechMod = SILENT_SPEECH;
    }
  }
  return speechMod;
}
type TrackerParams = {missionId: string; mode?: TrackerMode};

// Tokens — Brand Kit v4 (mirrors the design HTML exactly)
const C = {
  chrome:   '#07090D',
  depth:    '#05070B',
  surf1:    '#1B3A66',
  surf2:    '#162F54',
  surf3:    '#122747',
  bd1:      '#244C82',
  bd2:      '#1C3B66',
  act:      '#1E88FF',
  acc:      '#00A3FF',
  glow:     '#7ED6FF',
  tx1:      '#FFFFFF',
  tx2:      '#B8C7E0',
  tx3:      '#7E8AA6',
  ok:       '#00C853',
  warn:     '#FFC107',
  err:      '#FF3B3B',
  info:     '#4CC2FF',
};

type StyleId = 'dark' | 'light' | 'sat' | '3d';

interface Waypoint {
  seq: number; tag: string; event: string; state: string;
  settled_at: string | null; marked_via: string | null;
}

type IconName = React.ComponentProps<typeof Icon>['name'];

// B-408 — dock touch targets. The row is a fixed 50dp pill (48dp inside the
// border) on a screen that must survive 320dp, so the controls cannot simply
// grow to 48x48 — DESIGN_REVIEW_LOOP §3.4 sanctions hitSlop for exactly this.
// Every slop is capped at HALF the adjacent gap: a larger value would make
// neighbouring hit areas overlap, and RN awards the shared region to the later
// sibling, which turns "call" into "video" near the seam. Vertical slop is
// free (the pill has spare height), so every control clears 48dp tall.
const HIT_CALL = {top: 8, bottom: 8, left: 2, right: 2};   // 32 -> 36x48, gap 4
const HIT_ICON = {top: 8, bottom: 8, left: 3, right: 3};   // 32 -> 38x48, gap 6
const HIT_PRIMARY = {top: 2, bottom: 2, left: 3, right: 3}; // 44 -> 50x48
const HIT_GRAB = {top: 12, bottom: 12, left: 48, right: 48}; // 24 -> 136x48

// MaterialCommunityIcons glyph for the next-maneuver banner.
function maneuverIcon(modifier: string | null, type: string): IconName {
  if (type === 'arrive') {return 'map-marker-check';}
  const m = (modifier ?? '').toLowerCase();
  if (m.includes('uturn')) {return 'arrow-u-left-top';}
  if (m.includes('left')) {return 'arrow-top-left';}
  if (m.includes('right')) {return 'arrow-top-right';}
  return 'arrow-up';
}

export default function AgentLiveTrackerScreen() {
  const route = useRoute();
  const {missionId, mode = 'agent'} = (route.params ?? {}) as TrackerParams;
  const navigation = useNavigation<Nav>();
  // B-658 — the old cross-navigator  escape hatch is gone: openChat and
  // onCall both route through the shell-aware resolver now.
  // B-212 — the runtime this screen needs to SEND a message directly (instead of
  // navigating away to ChatScreen just to prefill a composer the CPO then has to
  // tap send on AGAIN).
  const {runtime} = useMessenger();
  const insets = useSafeAreaInsets();
  // B-84 / KB-04 — Android keyboard covered the bottom message dock (KAV
  // has no Android behavior; adjustResize is dead under edge-to-edge).
  // kbHeight replaces insets.bottom while the IME is up: the keyboard
  // spans the gesture-nav area, so stacking both would double-pad.
  const {bottomPad} = useKeyboardLayout();

  const webRef = useRef<WebView>(null);
  // B-77 — WebView map recovery: watchdog + auto-remount + RETRY overlay. On an
  // OS-initiated WebView process kill the page must reset (audit M-6) — map.retry
  // handles that. `webReady` derives from the health status so the existing
  // marker/route/bubble push effects keep working unchanged.
  const map = useMapReload();
  const webReady = map.status === 'ready';
  const [styleId, setStyleId] = useState<StyleId>('dark');
  // Style picker expansion while navigating — see STYLE_TOGGLE_H below.
  const [styleOpen, setStyleOpen] = useState(false);

  // ── Mission state (polled) ──────────────────────────────
  const [shortCode, setShortCode] = useState('');
  const [missionStatus, setMissionStatus] = useState('LIVE');
  // Audit C4 — connection confidence. The poll previously swallowed every
  // error, so a network blip across an ops ABORT left the CPO staring at a
  // confident "LIVE" indefinitely, still able to fire SOS on a dead
  // mission. We now count consecutive poll failures and, past a threshold,
  // surface an explicit "status unconfirmed" state so the CPO stops
  // trusting the stale LIVE and the SOS button reflects the uncertainty.
  const consecutiveFailures = useRef(0);
  const [statusStale, setStatusStale] = useState(false);
  const STALE_AFTER_FAILURES = 3; // ~12s at the 4s poll cadence
  const [waypoints, setWaypoints] = useState<Waypoint[]>([]);
  const [pickupCoord, setPickupCoord] = useState<{lat: number; lng: number} | null>(null);
  const [dropoffCoord, setDropoffCoord] = useState<{lat: number; lng: number} | null>(null);
  const [polyline, setPolyline] = useState<string | null>(null);
  const [currentLat, setCurrentLat] = useState<number | null>(null);
  const [currentLng, setCurrentLng] = useState<number | null>(null);
  const [currentHeading, setCurrentHeading] = useState<number | null>(null);
  // Step 30 — the principal's (client's) own live position, pushed by their
  // app via telemetryApi.clientPing and surfaced on the crew-gated deployment
  // read (Step 29). Drives the second "Principal" marker so the map shows BOTH
  // the CPO leader and the user being protected.
  const [principalLat, setPrincipalLat] = useState<number | null>(null);
  const [principalLng, setPrincipalLng] = useState<number | null>(null);
  const [callSign, setCallSign] = useState<string>('CPO · YOU');
  const [commsChannelId, setCommsChannelId] = useState<string | null>(null);
  const [hasFix, setHasFix] = useState(false);

  // Mini-status content (auto-rewrites from waypoint events).
  const [statusLabel, setStatusLabel] = useState('Standby · GPS Acquiring');
  const [statusEvent, setStatusEvent] = useState('Awaiting first fix from device');
  const [etaText, setEtaText] = useState<string>('—:—');

  // ── Turn-by-turn navigation (Step 31) ───────────────────
  // Live driving route from the guard's fix to the active target (pickup while
  // heading to the principal, dropoff once LIVE), rendered Google-Maps style.
  // The route is held in refs so re-splitting on every fix doesn't churn
  // renders; only the rendered maneuver banner is component state.
  const navRouteRef = useRef<DirectionsRoute | null>(null);
  const navRouteTargetRef = useRef(''); // which target the cached route is for (P:/D:)
  const desiredTargetKeyRef = useRef(''); // the target wanted right now (staleness guard)
  const navFetchAtRef = useRef(0);
  const navInFlightRef = useRef(false);
  const wasOffRouteRef = useRef(false); // rising-edge gate for the "Re-routing" bubble
  // Throttles for the 1 Hz own-GPS cadence — see apply() below.
  const lastSplitRef = useRef<{idx: number; at: LngLat; key: string} | null>(null);
  const navBannerSigRef = useRef('');

  // Latest fix as a REF. Effects that merely need "where are we right now" as a
  // fallback anchor must not take the position as a dependency: own-GPS fixes
  // arrive at ~1 Hz, and an effect keyed on them re-runs every second. That is
  // how the route pusher below ended up rebuilding the pickup/drop-off markers
  // once a second.
  const posRef = useRef<{lat: number | null; lng: number | null}>({lat: null, lng: null});
  useEffect(() => {
    posRef.current = {lat: currentLat, lng: currentLng};
  }, [currentLat, currentLng]);
  const [navBanner, setNavBanner] = useState<
    {primary: string; secondary: string | null; distanceLabel: string; icon: IconName; roadName: string | null} | null
  >(null);
  // Navigation.docx — the Waze reference pair: legal limit (red ring) beside
  // the vehicle's own speed. Limit comes from the route's maxspeed annotation
  // (null where the region has no data — show nothing, never a guess); speed
  // comes from the SAME GPS fix that moves the puck.
  const [speedKph, setSpeedKph] = useState<number | null>(null);
  const [limitKph, setLimitKph] = useState<number | null>(null);
  const [navUnavailable, setNavUnavailable] = useState(false);

  // Remaining distance along the LIVE route (not straight-line) — a driver
  // needs a real unit next to the ETA.
  const [remainingLabel, setRemainingLabel] = useState<string | null>(null);

  // Own-GPS navigation cadence. 'monitor' is a remote observer with no own
  // fix, so it keeps reading the server's copy.
  const isDriver = mode !== 'monitor';
  const isFocused = useIsFocused();
  const ownFixAtRef = useRef(0);

  // The mission checkpoint. Everyone assigned sees the same stage and the same
  // next step; only the lead can actually advance it (the server enforces
  // `lead_only`, so showing a tappable control to a non-lead would just produce
  // a 400). isLead rides on the poll we already make — no extra request.
  const [isLead, setIsLead] = useState(false);

  // Render and navigate from the driver's OWN fixes. This is what makes the
  // camera, the maneuver distance and off-route detection track reality
  // instead of a server round trip. The existing telemetry push to ops is a
  // separate concern and is untouched.
  // Gated on FOCUS, not just mount: this screen stays mounted underneath Chat,
  // the call screen and the lead console, and a 1 Hz high-accuracy watch has no
  // business running while the driver is looking at something else. App
  // backgrounding is deliberately NOT a stop condition — the mission foreground
  // service exists precisely so guidance survives a screen-off leg.
  useEffect(() => {
    if (!isDriver || !isFocused) {return undefined;}
    return subscribeOwnPosition(fix => {
      // Freshness is measured on OUR clock (see OwnFix.receivedAt): the
      // provider's timestamp can be skewed, which would make the fallback TTL
      // below either never fire or fire constantly.
      ownFixAtRef.current = fix.receivedAt;
      setCurrentLat(fix.lat);
      setCurrentLng(fix.lng);
      // Only overwrite the heading when the OS actually has a course; a
      // stationary vehicle reports none, and null would drop the marker cone.
      if (fix.headingDeg !== null) {setCurrentHeading(fix.headingDeg);}
      // Rounded km/h → a stable primitive, so React bails on the setState
      // whenever the displayed number hasn't changed (fixes land at 1 Hz).
      setSpeedKph(
        fix.speedMps !== null && fix.speedMps !== undefined && Number.isFinite(fix.speedMps) && fix.speedMps >= 0
          ? Math.round(fix.speedMps * 3.6)
          : null,
      );
      setHasFix(true);
    });
  }, [isDriver, isFocused]);

  // Track Up rotates the map to the direction of travel and is the default
  // during active navigation; North Up is the explicit opt-out. A remote
  // observer is not driving, so their map stays north-up — rotating someone
  // else's map to a vehicle's heading is disorienting, not helpful.
  const [navCamMode, setNavCamMode] = useState<'course' | 'north'>(
    isDriver ? 'course' : 'north',
  );

  // Spoken guidance. The DECISION of what to say and when is pure and lives in
  // navVoice; this side only performs it. Cue keys are namespaced per route so
  // a reroute re-announces its turns instead of being silenced by history.
  const [voiceOn, setVoiceOn] = useState(true);
  const voiceOnRef = useRef(true);
  useEffect(() => { voiceOnRef.current = voiceOn; }, [voiceOn]);
  const spokenCuesRef = useRef<Set<string>>(new Set());
  const voiceRouteIdRef = useRef('');

  // Returns whether the cue was actually spoken. The caller only records a cue
  // as delivered when it was: recording a cue that was suppressed (muted, or a
  // call in progress) would permanently swallow that maneuver's guidance, so
  // un-muting mid-approach would leave the driver in silence through the turn.
  const speakNav = useCallback((text: string): boolean => {
    if (!voiceOnRef.current || !text) {return false;}
    // Never talk over a live call — the driver is on the phone to ops, and
    // guidance stays on screen regardless.
    if (getActiveCall() || getActiveGroupCall()) {return false;}
    try {
      // Drop any half-spoken older cue: the newest instruction is the only
      // one that is still true.
      speech().stop().catch(() => undefined);
      speech().speak(text, {language: 'en-GB'});
      return true;
    } catch {
      // No TTS engine on this build/device — navigation stays visual.
      return false;
    }
  }, []);

  // Stop talking the moment the screen goes away or voice is muted.
  useEffect(() => {
    if (!voiceOn) {
      try { speech().stop().catch(() => undefined); } catch { /* no engine */ }
    }
  }, [voiceOn]);
  useEffect(() => () => {
    try { speech().stop().catch(() => undefined); } catch { /* no engine */ }
  }, []);

  // Track which waypoints have already been broadcast as system bubbles
  // so the polling loop doesn't spam them.
  const seenWaypoints = useRef<Set<string>>(new Set());

  // CPO panic. Confirmation prompt before the destructive action so a
  // pocket-tap doesn't fire SOS. Server-side IdempotencyInterceptor +
  // 60s bucketed key collapses frantic multi-taps.
  const [sosInFlight, setSosInFlight] = useState(false);
  const onSosPress = useCallback(() => {
    if (sosInFlight) {return;}
    // Audit C4 — don't fire SOS on a mission we KNOW is terminal (ops
    // aborted/completed it). The server rejects it anyway with a confusing
    // 4xx; catch it client-side with a clear message instead. When status
    // is merely unconfirmed (statusStale), we still allow SOS — in a real
    // emergency the CPO must be able to escalate even mid-blackout, and the
    // server is the final arbiter.
    if (missionStatus === 'COMPLETED' || missionStatus === 'ABORTED' || missionStatus === 'CANCELLED') {
      Alert.alert('Mission closed', 'This mission is no longer active. Contact Ops directly if you need help.');
      return;
    }
    Alert.alert(
      'Raise SOS?',
      'Ops will be paged immediately and the principal will be alerted. Use only if you are in or near a real threat.',
      [
        {text: 'Cancel', style: 'cancel'},
        {
          text: 'RAISE SOS',
          style: 'destructive',
          onPress: () => {
            setSosInFlight(true);
            void agentApi
              .raiseSos(missionId, {
                reason: 'CPO triggered from live tracker',
                lat: currentLat ?? undefined,
                lng: currentLng ?? undefined,
              })
              .then(() => {
                Alert.alert('SOS raised', 'Ops have been notified. Stay on-scene if safe.');
              })
              .catch(e => {
                const msg = (e as {response?: {data?: {message?: string}}; message?: string})?.response?.data?.message
                  ?? (e as {message?: string})?.message
                  ?? 'Unknown error';
                Alert.alert('SOS failed', String(msg));
              })
              .finally(() => setSosInFlight(false));
          },
        },
      ],
    );
  }, [sosInFlight, missionId, currentLat, currentLng, missionStatus]);

  const refresh = useCallback(async () => {
    try {
      // 'monitor' (org manager, off-scene) reads the org-scoped live endpoint;
      // crew (agent/cpo) read the crew-gated deployment. Same response shape.
      const {data} = mode === 'monitor'
        ? await orgApi.getMissionLive(missionId)
        : await agentApi.getMissionDeployment(missionId);
      // Audit C4 — a successful poll clears the stale-status state.
      consecutiveFailures.current = 0;
      if (statusStale) {setStatusStale(false);}
      setShortCode(data.mission?.short_code ?? '');
      const status = (data.mission?.status ?? 'LIVE').toString().toUpperCase();
      setMissionStatus(status);

      // Terminal-state nav. Without this, ops aborting or completing a
      // mission while the CPO is on this screen leaves them watching
      // stale "LIVE" data with no exit — same regression we just fixed
      // on the principal's LiveTrackingScreen.
      if (status === 'COMPLETED') {
        // 'agent' lives in AgentNavigator (MissionSummary exists there); the CPO
        // tracker is pushed over the CpoNavigator tabs, so it just pops back to
        // the Mission tab which renders the final state.
        if (mode === 'agent') {navigation.replace('MissionSummary', {bookingId: data.mission?.booking_id ?? ''});}
        else {navigation.goBack();}
        return;
      }
      if (status === 'ABORTED' || status === 'CANCELLED') {
        if (mode === 'agent') {navigation.replace('AgentDashboard');}
        else {navigation.goBack();}
        return;
      }

      // The driver's own marker is driven by their own GPS at navigation
      // cadence (ownPositionBus). The server's copy of it is a ~10 s-throttled
      // telemetry push read back on a 4 s poll, so letting it win here would
      // drag the marker hundreds of metres backwards at speed. A remote
      // observer has no own-device fix and always uses the server value.
      const ownFresh = isDriver && Date.now() - ownFixAtRef.current < OWN_FIX_TTL_MS;
      if (!ownFresh) {
        setCurrentLat(data.mission?.current_lat ?? null);
        setCurrentLng(data.mission?.current_lng ?? null);
        setCurrentHeading(data.mission?.current_heading_deg ?? null);
      }
      setPrincipalLat(data.mission?.client_lat ?? null);
      setPrincipalLng(data.mission?.client_lng ?? null);
      setPolyline(data.mission?.route_polyline ?? null);
      setCommsChannelId(data.mission?.comms_channel_id ?? null);
      setCallSign(data.crew_role?.call_sign ?? 'CPO · YOU');
      setIsLead(data.crew_role?.is_lead === true);
      setHasFix(
        ownFresh || (
          data.mission?.current_lat !== null && data.mission?.current_lat !== undefined &&
          data.mission?.current_lng !== null && data.mission?.current_lng !== undefined
        ),
      );
      if (data.booking?.pickup_lat && data.booking?.pickup_lng) {
        setPickupCoord({lat: Number(data.booking.pickup_lat), lng: Number(data.booking.pickup_lng)});
      }
      if (data.booking?.dropoff_lat && data.booking?.dropoff_lng) {
        setDropoffCoord({lat: Number(data.booking.dropoff_lat), lng: Number(data.booking.dropoff_lng)});
      }

      const wps = data.waypoints as Waypoint[];
      setWaypoints(wps);
      // Executive Protection — no waypoint timeline; the legacy lead console (all
      // waypoint-mark controls) must not be reachable on these missions.
      setIsExecMission(data.booking?.service === 'executive_protection');

      // Find the latest settled waypoint so the mini-status reads it.
      const latest = [...wps].reverse().find(w => w.state === 'done' && !!w.settled_at);
      const upcoming = wps.find(w => w.state === 'pending' || w.state === 'current');
      if (latest) {
        setStatusLabel(`${latest.tag} cleared`);
        setStatusEvent(latest.event || `${latest.tag} settled`);
      } else if (data.booking?.service === 'executive_protection') {
        const confirmed = (data.hourly_checkins ?? []).length;
        const block = data.booking?.duration_hours ?? 0;
        setStatusLabel('Protection detail');
        setStatusEvent(confirmed > 0 ? `Hour ${confirmed}/${block} confirmed — all smooth` : 'Hourly check-ins on the Mission tab');
      } else {
        setStatusLabel('En Route');
        setStatusEvent('Holding for first checkpoint');
      }

      // Recompute a coarse ETA from the booking pickup time + any
      // pacing the lead pushed in (route_duration_s on the mission).
      // We don't have a precise live-ETA endpoint yet, so we render
      // dispatch_at + route_duration as a reasonable upper bound.
      if (data.mission?.route_duration_s !== null && data.mission?.route_duration_s !== undefined && data.booking?.pickup_lat) {
        // Approximate: now + remaining seconds (decays as real fixes come in).
        const remainingS = Math.max(0, Math.floor(data.mission.route_duration_s));
        const eta = new Date(Date.now() + remainingS * 1000);
        setEtaText(eta.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}));
      }

      // Push system bubbles for any newly-settled waypoints we
      // haven't broadcast yet.
      if (webReady) {
        const point = upcoming
          ? null
          : (latest && data.booking?.pickup_lat ? {
              lat: Number(data.booking.pickup_lat),
              lng: Number(data.booking.pickup_lng),
            } : null);
        wps.forEach(w => {
          if (w.state === 'done' && !seenWaypoints.current.has(w.tag)) {
            // Anchor the system bubble on the agent's current fix when
            // we have one, falling back to the pickup so it lands
            // somewhere visible on the route.
            const lng = data.mission?.current_lng ?? data.booking?.pickup_lng;
            const lat = data.mission?.current_lat ?? data.booking?.pickup_lat;
            if (lat !== null && lat !== undefined && lng !== null && lng !== undefined) {
              // Why: mark seen only once actually bubbled — marking before the
              // coord check permanently dropped waypoints that arrived before
              // the first fix.
              seenWaypoints.current.add(w.tag);
              webRef.current?.injectJavaScript(
                `window.pushSystem(${JSON.stringify({
                  id: `wp-${w.tag}-${w.settled_at ?? ''}`,
                  label: 'Waypoint',
                  preview: `${w.tag} · ${w.event ?? 'cleared'}`,
                  lat: Number(lat), lng: Number(lng),
                  ttl: 8000,
                })}); true;`,
              );
            }
          }
        });
        // suppress unused-var lint when point isn't used in current branch
        void point;
      }
    } catch {
      // Audit C4 — do NOT silently keep showing a confident "LIVE". A
      // single blip is transient (keep last good state), but sustained
      // failure means we can't confirm the mission is still active — ops
      // may have aborted it while we were blind. Surface that explicitly.
      consecutiveFailures.current += 1;
      if (consecutiveFailures.current >= STALE_AFTER_FAILURES && !statusStale) {
        setStatusStale(true);
      }
    }
  }, [missionId, mode, isDriver, webReady, navigation, statusStale]);

  // ── Mission checkpoint (Arrived at pickup → Client Picked Up → Dropped off) ──
  // The transition runs through the SAME hook the CPO Mission tab uses, so there
  // is exactly one caller of the FSM endpoints in the app.
  const av = missionActionView(missionStatus, isLead);
  const {acting, runAction} = useMissionAdvance(missionId, refresh);

  /** Straight-line metres to the pickup point, or null when either end is unknown. */
  const distToPickupM = useMemo<number | null>(() => {
    if (currentLat === null || currentLng === null || !pickupCoord) {return null;}
    return haversineM(
      {lng: currentLng, lat: currentLat},
      {lng: pickupCoord.lng, lat: pickupCoord.lat},
    );
  }, [currentLat, currentLng, pickupCoord]);

  // Only the approach to the pickup has a proximity meaning; the drop-off has its
  // own confirmation and its own destination.
  const farFromPickup = av.action !== 'finish'
    && distToPickupM !== null
    && distToPickupM > PICKUP_RADIUS_M;

  /** What the LEAD's next step is, so a non-lead sees the same stage. */
  const leadNext = missionActionView(missionStatus, true);

  const onAdvance = useCallback(() => {
    if (av.action === 'none') {return;}
    const copy = missionActionConfirm(av.action);
    const far = av.action !== 'finish'
      && distToPickupM !== null
      && distToPickupM > PICKUP_RADIUS_M;
    // An in-radius action with no confirmation of its own (Arrived at pickup)
    // stays a single tap; everything else states what is being attested to.
    if (!copy && !far) {
      void runAction(av.action);
      return;
    }
    const overrideLine = far
      ? `You are ${formatDistance(distToPickupM as number)} from the pickup point.`
      : '';
    Alert.alert(
      copy?.title ?? `${av.label}?`,
      [copy?.body, overrideLine].filter(Boolean).join('\n\n'),
      [
        {text: 'Cancel', style: 'cancel'},
        {
          text: copy?.cta ?? av.label,
          style: copy?.destructive ? 'destructive' : 'default',
          onPress: () => { void runAction(av.action); },
        },
      ],
    );
  }, [av, distToPickupM, runAction]);

  useEffect(() => {
    void refresh();
    let id: ReturnType<typeof setInterval> | null = null;
    const start = () => { if (!id) {id = setInterval(() => { void refresh(); }, 4000);} };
    const stop  = () => { if (id) { clearInterval(id); id = null; } };
    if (AppState.currentState === 'active') {start();}
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') { void refresh(); start(); } else {stop();}
    });
    return () => { stop(); sub.remove(); };
  }, [refresh]);

  // ── Map injection helpers ───────────────────────────────
  const inject = useCallback((js: string) => {
    webRef.current?.injectJavaScript(js + ' true;');
  }, []);

  // ── Native map migration (2026-08-23) ───────────────────
  // The map is moving from Mapbox GL JS in a WebView to the native SDK. BOTH
  // paths ship, chosen by EXPO_PUBLIC_NATIVE_MAP, because this is the screen a
  // CPO drives a live protection mission from — a one-way swap with no way
  // back is not something to hand testers.
  //
  // Every map command goes through `mapCmd` rather than being rewritten at 13
  // call sites twice (once to migrate, once to revert). The dispatcher is the
  // single place the two renderers differ; the call sites read the same for both.
  const nativeMapRef = useRef<BravoMapHandle>(null);
  const useNativeMap = NATIVE_MAP_ENABLED;

  const mapCmd = useMemo(
    () => ({
      setRoute: (p: RoutePayload) =>
        useNativeMap
          ? nativeMapRef.current?.setRoute(p)
          : inject(`window.setRoute(${JSON.stringify(p)});`),
      setNavRoute: (p: NavRoutePayload) =>
        useNativeMap
          ? nativeMapRef.current?.setNavRoute(p)
          : inject(`window.setNavRoute(${JSON.stringify(p)});`),
      setCpo: (p: CpoPayload) =>
        useNativeMap
          ? nativeMapRef.current?.setCpo(p)
          : inject(`window.setCpo(${JSON.stringify(p)});`),
      setPrincipal: (p: {lat: number; lng: number} | null) =>
        useNativeMap
          ? nativeMapRef.current?.setPrincipal(p)
          : inject(`window.setPrincipal(${p === null ? 'null' : JSON.stringify(p)});`),
      setStyle: (id: StyleId) =>
        useNativeMap
          ? nativeMapRef.current?.setStyle(id)
          : inject(`window.setStyle(${JSON.stringify(id)});`),
      setNavCamera: (p: {mode: 'course' | 'north'}) =>
        useNativeMap
          ? nativeMapRef.current?.setNavCamera(p)
          : inject(`window.setNavCamera(${JSON.stringify(p)});`),
      pushBubble: (p: PushBubbleInput) =>
        useNativeMap
          ? nativeMapRef.current?.pushBubble(p)
          : inject(`window.pushBubble(${JSON.stringify(p)});`),
      pushSystem: (p: PushSystemInput) =>
        useNativeMap
          ? nativeMapRef.current?.pushSystem(p)
          : inject(`window.pushSystem(${JSON.stringify(p)});`),
      setSysTopGuard: (px: number) =>
        useNativeMap
          ? nativeMapRef.current?.setSysTopGuard(px)
          : inject(`window.setSysTopGuard && window.setSysTopGuard(${Math.round(px)});`),
    }),
    [useNativeMap, inject],
  );

  // Issue 42 — keep the in-map ⌖ Follow pill clear of the RN bottom dock. A CSS
  // custom property is used rather than rebuilding the HTML, because changing
  // `source` remounts the WebView and would tear down the live map on every
  // layout pass (keyboard open, rail growth, rotation).
  const [dockHeight, setDockHeight] = useState(0);
  // Founder 2026-08-23 — "the navigation must be big like Waze or Google Maps".
  // While turn-by-turn is live the dock collapses to the composer row alone and
  // the read-only rails (stepper + protection detail) go behind the grab
  // handle, which is what takes the map from ~42% of the screen to ~76%. Only
  // the NAVIGATING case collapses; with no route the full dock is still the
  // right default, so this is opt-out, not a new permanent layout.
  const [dockExpanded, setDockExpanded] = useState(false);
  // B-407 — the measured dock INCLUDES the keyboard inset (bottomPad), so with
  // the IME open the raw value launched the FOLLOW pill most of the way up the
  // screen and straight through the style-toggle column. Collapsing the dock
  // on focus fixes the common case; this cap is the backstop for a small
  // screen / tall IME / large fontScale, keeping the pill in the lower half
  // where a thumb can reach it and away from the top chrome.
  const {height: winH} = useWindowDimensions();
  useEffect(() => {
    // The native map positions its own recenter pill in RN, so this CSS var
    // is WebView-only. Injecting it into a WebView that is not mounted is a
    // silent no-op, but gating reads as the intent.
    if (useNativeMap || dockHeight <= 0 || map.status !== 'ready') {return;}
    const bottom = Math.min(Math.round(dockHeight) + 12, Math.round(winH * 0.45));
    inject(
      `document.documentElement.style.setProperty('--recenter-bottom', '${bottom}px');`,
    );
  }, [dockHeight, map.status, inject, winH, useNativeMap]);


  // ── Live message subscription (sub-second bubble delivery) ──
  //
  // The 4-second poll above only covers waypoint events. Real chat
  // messages flow through the messenger gateway: the WebSocket runtime
  // decrypts envelopes and appends them to messengerStore.messages.
  // Subscribing to that slice gives bubble delivery within a frame of
  // the inbound `envelope.deliver` event — no polling, no jitter.
  const ownUserId   = useAuthStore(s => s.user?.id);
  const groupMsgs   = useMessengerStore(s => commsChannelId ? s.messages[commsChannelId] : undefined);
  const memberNames = useMessengerStore(s => commsChannelId ? s.groupMemberNames[commsChannelId] : undefined);
  /**
   * B-659 — the directory profile names, the source `groupMemberNames` lacks
   * for a mission Ops Room. `useShallow` so an unrelated directory write does
   * not re-run the bubble effect below.
   */
  const directoryNames = useMessengerStore(useShallow(s => s.directoryNames));
  const seenMsgIds  = useRef<Set<string>>(new Set());

  /**
   * B-659 — fetch the profile names this room's senders need.
   *
   * Without this the lookup above can only ever hit names some OTHER surface
   * happened to fetch, so a mission Ops Room — whose members are typically an
   * agency, a client and a CPO the device has never opened a 1:1 with — would
   * sit on the neutral fallback forever. `ensureDirectoryNames` is debounced,
   * batched and self-deduping, and its store write re-renders the bubbles with
   * the real names.
   *
   * Driven off the CONVERSATION's participants, not the message list, so a
   * member who has not spoken yet is still named the moment they do.
   */
  const roomParticipants = useMessengerStore(
    useShallow(s => (commsChannelId ? s.conversations[commsChannelId]?.participants : undefined)),
  );
  useEffect(() => {
    const ids = (roomParticipants ?? []).filter(
      (id): id is string => typeof id === 'string' && id.length > 0 && id !== 'self' && id !== ownUserId,
    );
    if (ids.length === 0) {return;}
    try { ensureDirectoryNames(ids); } catch { /* offline / pre-auth — the fallback stands */ }
  }, [roomParticipants, ownUserId]);

  // Prime the dedupe set with whatever's already in the store when the
  // conversation rotates. Historical messages aren't bubble-worthy —
  // only sub-second future deliveries from the gateway are.
  useEffect(() => {
    seenMsgIds.current = new Set();
    const snapshot = commsChannelId
      ? useMessengerStore.getState().messages[commsChannelId]
      : undefined;
    if (snapshot) {for (const m of snapshot) {seenMsgIds.current.add(m.id);}}
  }, [commsChannelId]);

  useEffect(() => {
    if (!webReady || !groupMsgs || groupMsgs.length === 0) {return;}
    // Walk forward through the array — newest is last.
    for (const m of groupMsgs) {
      if (seenMsgIds.current.has(m.id)) {continue;}
      seenMsgIds.current.add(m.id);

      // Don't echo our own messages back as bubbles.
      const isSelf = m.sender_id === 'self' || (ownUserId !== undefined && m.sender_id === ownUserId);
      if (isSelf) {continue;}

      const text = (m.content ?? '').trim();
      if (!text) {continue;}

      // System broadcasts ride the existing `system` MessageType.
      // Anchor them at the agent's current fix (or pickup as fallback)
      // so they land on the visible portion of the route.
      if (m.type === 'system') {
        const lat = posRef.current.lat ?? pickupCoord?.lat;
        const lng = posRef.current.lng ?? pickupCoord?.lng;
        if (lat !== null && lat !== undefined && lng !== null && lng !== undefined) {
          mapCmd.pushSystem({
            id: `msg-sys-${m.id}`,
            label: 'Ops',
            preview: text,
            lat, lng, ttl: 8000,
          });
        }
        continue;
      }

      // SOS — body prefix or explicit kind. Keeps the red bubble usable
      // before the messenger adds a first-class SOS message type.
      const isSos = /^\[SOS\]/i.test(text) || text.toLowerCase().startsWith('sos:');
      /**
       * B-659 — the sender's REAL name, not a raw-id fragment.
       *
       * This read `groupMemberNames` only, which is populated by the
       * department-chat surfaces and the rename modal — and is EMPTY for a
       * mission Ops Room. So every bubble fell through to `U-3F5E`, which is
       * unreadable and, on a protection detail, actively unsafe: the CPO could
       * not tell the principal from the crew.
       *
       * Same chain ChatScreen's `resolveSenderName` uses: the admin alias wins
       * (a rename must reflect live), then the directory profile name. A miss
       * queues a debounced batch fetch whose store write re-renders this with
       * the real name — so the id fragment is gone for good, and the last
       * resort is a neutral word rather than a fake identifier.
       */
      const sender = memberNames?.[m.sender_id]
        ?? directoryNames?.[m.sender_id]
        ?? 'Crew';

      mapCmd.pushBubble({
        id: `msg-${m.id}`,
        kind: isSos ? 'sos' : 'msg',
        sender,
        preview: isSos ? text.replace(/^\[SOS\]\s*/i, '').replace(/^sos:\s*/i, '') : text,
        anchor: 'cpo', // sender mapping (client→principal) lands when we
                       // attach role metadata to messages — for now,
                       // every chat message anchors to the agent.
        ttl: isSos ? null : 6000,
      });
    }
  }, [webReady, groupMsgs, ownUserId, memberNames, directoryNames, pickupCoord, mapCmd]);

  // Push pickup/dropoff/route once we have them + the WebView is ready.
  // Also detects ops re-routes (polyline change) and surfaces a system
  // bubble so the agent has a visible signal — not just a silent redraw.
  const lastPolyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!webReady || !pickupCoord || !dropoffCoord) {return;}
    mapCmd.setRoute({
      pickup: pickupCoord, dropoff: dropoffCoord, polyline,
    });
    const prev = lastPolyRef.current;
    if (prev !== null && polyline !== null && prev !== polyline) {
      // Anchor the bubble on the agent's own marker (or pickup as
      // fallback) so it lands on the visible portion of the map.
      const lat = posRef.current.lat ?? pickupCoord.lat;
      const lng = posRef.current.lng ?? pickupCoord.lng;
      mapCmd.pushSystem({
        id: `reroute-${Date.now()}`,
        label: 'Route Updated',
        preview: 'Ops re-routed — follow the new polyline',
        lat, lng, ttl: 8000,
      });
      // Also reflect in the mini-status so it's not lost on bubble unmount.
      setStatusLabel('Route Updated');
      setStatusEvent('Ops re-routed — new polyline active');
    }
    lastPolyRef.current = polyline;
  }, [webReady, pickupCoord, dropoffCoord, polyline, mapCmd]);

  // Push CPO marker as fixes arrive. heading_deg flows through when the
  // deployment read provides it (rotates the HTML heading cone).
  useEffect(() => {
    if (!webReady || currentLat === null || currentLng === null) {return;}
    mapCmd.setCpo({
      lat: currentLat, lng: currentLng,
      callsign: callSign,
      ...(currentHeading !== null ? {heading_deg: currentHeading} : {}),
    });
  }, [webReady, currentLat, currentLng, currentHeading, callSign, mapCmd]);

  // Push the principal (user) marker as their fixes arrive — clearing it when
  // the client stops pinging so a stale dot doesn't linger. This is the visible
  // half of "show both" (Step 30): the CPO leader + the protected person.
  useEffect(() => {
    if (!webReady) {return;}
    if (principalLat === null || principalLng === null) {
      mapCmd.setPrincipal(null);
      return;
    }
    mapCmd.setPrincipal({
      lat: principalLat, lng: principalLng,
    });
  }, [webReady, principalLat, principalLng, mapCmd]);

  // ── Turn-by-turn driving (Step 31) ──────────────────────
  // Active target: the pickup while heading to the principal; the dropoff once
  // protection is LIVE (mirrors the mission FSM).
  const activeTarget = useMemo<LngLat | null>(() => {
    const c = missionStatus === 'LIVE' ? dropoffCoord : pickupCoord;
    return c ? {lng: c.lng, lat: c.lat} : null;
  }, [missionStatus, dropoffCoord, pickupCoord]);

  useEffect(() => {
    if (!webReady || currentLat === null || currentLng === null || !activeTarget) {return;}
    const cpo: LngLat = {lng: currentLng, lat: currentLat};
    const targetKey = `${missionStatus === 'LIVE' ? 'D' : 'P'}:${activeTarget.lng.toFixed(4)},${activeTarget.lat.toFixed(4)}`;

    // Re-split the line at the guard's fix + refresh the maneuver banner + ETA.
    const apply = (rt: DirectionsRoute) => {
      // Own-GPS fixes arrive at ~1 Hz, and the split payload is the WHOLE
      // route geometry — serialising it across the bridge every second would
      // dominate the JS thread on a long leg. Re-send only when the split has
      // actually moved: a new vertex, a meaningful advance, or a new route.
      // Key on ROUTE identity, not the leg target: a reroute to the same
      // destination produces a byte-identical targetKey, and the cached index
      // then refers to the ABANDONED geometry — so a fresh route whose index
      // happened to match would never be drawn and the map would keep showing
      // the route the driver just left.
      const rid = routeVoiceId(rt, targetKey);
      const splitIdx = nearestIndexOnRoute(rt.coordinates, cpo);
      const prevSplit = lastSplitRef.current;
      const movedM = prevSplit ? haversineM(prevSplit.at, cpo) : Infinity;
      if (!prevSplit || prevSplit.key !== rid || prevSplit.idx !== splitIdx || movedM > 20) {
        lastSplitRef.current = {idx: splitIdx, at: cpo, key: rid};
        const {traveled, remaining} = splitRouteAtProgress(rt.coordinates, cpo);
        mapCmd.setNavRoute({
          traveled: traveled.map(c => [c.lng, c.lat]),
          ahead: remaining.map(c => [c.lng, c.lat]),
        });
      }
      // Navigation.docx — the legal limit HERE. A primitive setState, so the
      // 1 Hz cadence only re-renders when the limit actually changes.
      setLimitKph(speedLimitAtKph(rt, cpo));
      const nm = nextManeuver(rt, cpo);
      if (nm) {
        const primary = nm.step.bannerPrimary || nm.step.instruction || 'Continue';
        const secondary = nm.step.bannerSecondary;
        const distanceLabel = formatDistance(nm.distanceM);
        const icon = maneuverIcon(nm.step.modifier, nm.step.maneuverType);
        const roadName = currentRoadName(rt, nm.index);
        // Only re-render the banner when what it SHOWS changes: at 1 Hz an
        // always-new object would re-render this screen every second.
        const sig = `${primary}|${secondary ?? ''}|${distanceLabel}|${icon}|${roadName ?? ''}`;
        if (sig !== navBannerSigRef.current) {
          navBannerSigRef.current = sig;
          setNavBanner({primary, secondary, distanceLabel, icon, roadName});
        }
        // Spoken guidance. A reroute (or a leg flip) mints a new route id,
        // which clears the spoken history so the new turns are announced.
        const vid = rid;
        if (vid !== voiceRouteIdRef.current) {
          voiceRouteIdRef.current = vid;
          spokenCuesRef.current = new Set();
        }
        const say = pickAnnouncement({
          route: rt,
          stepIndex: nm.index,
          distanceToManeuverM: nm.distanceM,
          spoken: spokenCuesRef.current,
          routeId: vid,
        });
        // Record ONLY what was actually said. If voice is muted or a call is
        // up, the cue stays pending, so un-muting mid-approach still gets the
        // driver the turn instead of silence.
        if (say && speakNav(say.text)) {
          spokenCuesRef.current.add(say.key);
          for (const k of say.superseded) { spokenCuesRef.current.add(k); }
        }
      } else {
        navBannerSigRef.current = '';
        setNavBanner(null);
        setLimitKph(null);
      }
      // Live ETA that counts DOWN: scale the route duration by the fraction of
      // the route still AHEAD of the guard — not the full original trip time
      // (which would slide forward and never converge to arrival).
      const remainM = remainingRouteM(rt.coordinates, cpo);
      setRemainingLabel(formatDistance(remainM));
      const frac = rt.distanceM > 0 ? Math.min(1, remainM / rt.distanceM) : 1;
      const remainS = Math.max(0, Math.floor(rt.durationS * frac));
      const eta = new Date(Date.now() + remainS * 1000);
      setEtaText(eta.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}));
    };

    // A leg flip (pickup → dropoff) invalidates everything derived from the
    // previous leg. Without this the "LEFT" chip kept showing the distance to
    // the pickup while the driver was already navigating to the drop-off.
    if (desiredTargetKeyRef.current && desiredTargetKeyRef.current !== targetKey) {
      setRemainingLabel(null);
      navBannerSigRef.current = '';
    }
    desiredTargetKeyRef.current = targetKey;
    // Only reuse the cached route if it's for the CURRENT target; a pickup→dropoff
    // (LIVE) flip must refetch and never render the stale leg.
    const existing = navRouteRef.current && navRouteTargetRef.current === targetKey
      ? navRouteRef.current
      : null;
    const offRoute = existing ? offRouteDistanceM(existing.coordinates, cpo) > 60 : true;
    const now = Date.now();
    const throttleOk = now - navFetchAtRef.current > 6000;
    const needFetch = !existing || (offRoute && throttleOk);

    if (needFetch && !navInFlightRef.current) {
      navInFlightRef.current = true;
      navFetchAtRef.current = now;
      const fetchKey = targetKey;
      // Fire the "Re-routing" bubble only on the rising edge of a deviation
      // (entering off-route), never repeatedly while we keep refetching.
      const deviated = !!existing && offRoute && !wasOffRouteRef.current;
      void fetchDirections(cpo, activeTarget)
        .then(rt => {
          navInFlightRef.current = false;
          if (rt) {
            navRouteRef.current = rt;
            navRouteTargetRef.current = fetchKey;
            // Drop a late result whose target is no longer wanted (mission went
            // LIVE mid-flight) so we never paint the stale pickup leg.
            if (fetchKey !== desiredTargetKeyRef.current) {return;}
            setNavUnavailable(false);
            if (deviated) {
              mapCmd.pushSystem({
                id: `reroute-${now}`, label: 'Re-routing', preview: 'New route — follow the line',
                lat: currentLat, lng: currentLng, ttl: 6000,
              });
            }
            apply(rt);
          } else if (!existing) {
            setNavUnavailable(true);
            // No route means no honest remaining distance.
            setRemainingLabel(null);
            // MG-08 — Directions unavailable for a NEW leg: push an EMPTY
            // nav frame so the HTML un-latches navActive and redraws the
            // base route line, instead of leaving the previous leg's
            // turn-by-turn on screen under the "Navigation unavailable"
            // banner (review m-3: the un-latch was unreachable without this).
            if (fetchKey === desiredTargetKeyRef.current) {
              mapCmd.setNavRoute({traveled: [], ahead: []});
            }
          }
        })
        .catch(() => { navInFlightRef.current = false; });
    } else if (existing) {
      apply(existing);
    }
    wasOffRouteRef.current = offRoute;
  }, [webReady, currentLat, currentLng, activeTarget, missionStatus, mapCmd, speakNav]);

  // Push style swaps.
  useEffect(() => {
    if (!webReady) {return;}
    mapCmd.setStyle(styleId);
  }, [webReady, styleId, mapCmd]);


  // Push the camera orientation. Track Up is the default; the map only
  // actually rotates once turn-by-turn is driving the line.
  useEffect(() => {
    if (!webReady) {return;}
    mapCmd.setNavCamera({mode: navCamMode});
  }, [webReady, navCamMode, mapCmd]);

  const onMessage = (e: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(e.nativeEvent.data) as {type?: string; id?: string; where?: string; msg?: string; tReadyMs?: number; glMs?: number; glCached?: boolean | null; styleMs?: number; tiles?: number; netKb?: number};
      if (msg.type === 'ready') {
        // [MAPPERF] one line per map boot; console.warn survives release
        // builds (babel strips log, keeps warn), so SQA's logcat carries it.
        console.warn('[MAPPERF] crewnav ready=' + msg.tReadyMs + 'ms gl=' + msg.glMs
          + 'ms cached=' + msg.glCached + ' style=' + msg.styleMs + 'ms tiles='
          + msg.tiles + ' net=' + msg.netKb + 'kB');
        map.onReady();
      }
      // MG-11 — fast-fail ONLY on definitely-fatal boot errors (WebGL
      // init, token 401/403); recoverable pre-load tile blips must not
      // burn the auto-retry (review m-2).
      const fatal = msg.type === 'gl-unsupported'
        || (msg.type === 'err' && (msg.where === 'init'
            || /401|403|unauthorized|forbidden|access token/i.test(String(msg.msg ?? ''))));
      if (fatal) {map.onError();}
      if (msg.type === 'bubble.tap' || msg.type === 'chip.tap') {openChat();}
    } catch { /* ignore */ }
  };

  const html = useMemo(() => {
    // Lazy-require so the heavy template literal only loads when this
    // screen mounts.

    const {buildAgentTrackerHtml} = require('@modules/booking/bravoAgentTrackerMapHtml') as {
      buildAgentTrackerHtml: (t: string) => string;
    };
    return buildAgentTrackerHtml(MAPBOX_TOKEN);
  }, []);
  // Why: a stable source identity avoids leaning on the WebView's internal
  // html string diff to prevent a full map reload on unrelated re-renders.
  const webSource = useMemo(() => mapHtmlSource(html), [html]);

  // ── Message dock + keyboard ─────────────────────────────
  const [draft, setDraft] = useState('');
  const [focused, setFocused] = useState(false);

  const openChat = useCallback((prefilled?: string) => {
    if (!commsChannelId) {
      Alert.alert('Mission group not ready', 'Ops will provision the group chat shortly.');
      return;
    }
    /**
     * B-658 — a CPO now lands on the mission THREAD, not the chat list.
     *
     * The CPO branch used to `navigate('CpoTabs', {screen: 'CpoComms'})` and
     * RETURN — dropping the user on the conversation LIST and never opening the
     * room. That is a large part of the founder's "the agent can't message the
     * client": on the agency dispatch lane the client IS already a member of
     * this room, so nothing was blocking the message except that the one-tap
     * route never arrived at the thread.
     *
     * The old comment's premise was right (Chat is not on the CpoRootStack that
     * hosts this tracker, so a bare navigate no-ops) — the conclusion was too
     * blunt. `onCall` below already solved the identical problem with the
     * shell-aware resolver, which emits the flat action for agency and the
     * CpoTabs→CpoComms→Chat nesting for CPO. Use the same door.
     */
    if (mode === 'cpo') {
      if (!navigationRef.isReady()) {
        Alert.alert('Not ready', 'Try again in a moment.');
        return;
      }
      navigateToMessengerScreen(navigationRef as never, 'Chat', {
        conversationId: commsChannelId,
        name: shortCode || 'Mission',
        isGroup: true,
        draft: prefilled,
      });
      return;
    }
    navigation.navigate('Chat', {
      conversationId: commsChannelId,
      name: shortCode || 'Mission',
      isGroup: true,
      draft: prefilled,
    });
  }, [mode, commsChannelId, shortCode, navigation]);

  const onCall = useCallback((callType: 'voice' | 'video') => {
    if (!commsChannelId) {
      Alert.alert('Mission group not ready', 'Ops will provision the channel shortly.');
      return;
    }
    // B-212 → Ops-Room call fix (2026-08-09): the B-212 comment's claim that
    // "GroupCallScreen is registered on RootStackParamList for every mode"
    // was a TYPE-level claim and FALSE at runtime for CPO — CpoRootStack
    // registers neither call screen, so the flat root-ref navigate bubbled
    // to nothing and dropped silently (gatekeeper review, statically
    // proven). Route the shim through the shell-aware resolver instead —
    // agency emits the identical flat action it does today; CPO gains the
    // CpoTabs→CpoComms nesting it actually needs.
    if (!navigationRef.isReady()) {
      Alert.alert('Not ready', 'Try again in a moment.');
      return;
    }
    const rootNav = {
      navigate: (screen: string, params?: Record<string, unknown>) => {
        navigateToMessengerScreen(navigationRef as never, screen as MessengerTarget, params ?? {});
      },
    };
    // LIVE-MONITOR-CHAT (area 8 #4) — the mission Ops Room is always a group; pass
    // the explicit hint so the call routes to the group/SFU path even on a cold
    // open where messengerStore hasn't materialized the conversation yet (without
    // it, shouldRouteCallViaSfu() returns false → broken 1:1 route → "call failed").
    launchCall(rootNav, {conversationId: commsChannelId, callType, isGroup: true});
  }, [commsChannelId]);

  const sendDraft = () => {
    const trimmed = draft.trim();
    if (!trimmed) {return;}
    /**
     * B-658 — never swallow a typed message.
     *
     * This used to bail silently when the room or runtime was not ready, so a
     * CPO who typed and hit send watched the text vanish with no feedback and
     * no sent message — indistinguishable from "the client is ignoring me",
     * and a plausible second source of the founder's "the agent can't message
     * the client" report. The draft is now KEPT (not cleared) so the message
     * can still be sent once the room lands.
     */
    if (!commsChannelId || !runtime) {
      Alert.alert(
        'Mission group not ready',
        'This mission\'s secure group is still being set up. Your message has been kept — try again in a moment.',
      );
      return;
    }
    // B-212 — actually SEND from here instead of navigating to ChatScreen just
    // to re-prefill a composer the CPO then had to tap send on AGAIN. Same
    // entry point ChatScreen's own composer uses (runtime.sendText), so this
    // stays on the existing encryption + receipts model — no new send path.
    setDraft('');
    haptics.tap();
    void (async () => {
      try {
        await runtime.sendText(commsChannelId, trimmed, {isGroup: true});
      } catch (e) {
        useMessengerStore.getState().setError(e instanceof Error ? e.message : 'Send failed');
      }
    })();
  };

  // ── Slide-in overlay (the lead-console panel) ───────────
  const SLIDE_W = 360;
  const slideX = useRef(new Animated.Value(SLIDE_W)).current;
  const [overlayOpen, setOverlayOpen] = useState(false);
  // Executive Protection — the legacy lead console is 100% waypoint-driven; every mark
  // control would 404 (waypoint_not_found) on an executive mission. Hide its entries.
  const [isExecMission, setIsExecMission] = useState(false);

  const openOverlay = () => {
    setOverlayOpen(true);
    Animated.timing(slideX, {toValue: 0, duration: 260, useNativeDriver: true}).start();
  };
  const closeOverlay = useCallback(() => {
    Animated.timing(slideX, {toValue: SLIDE_W, duration: 220, useNativeDriver: true})
      .start(() => setOverlayOpen(false));
  }, [slideX]);

  // Swipe-right on the panel dismisses it.
  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => g.dx > 12 && Math.abs(g.dy) < 24,
      onPanResponderMove: (_, g) => { if (g.dx >= 0) {slideX.setValue(g.dx);} },
      onPanResponderRelease: (_, g) => {
        if (g.dx > SLIDE_W * 0.35 || g.vx > 0.4) {closeOverlay();}
        else {Animated.spring(slideX, {toValue: 0, useNativeDriver: true, bounciness: 0}).start();}
      },
    }),
  ).current;

  // Hide chrome that conflicts with the keyboard while the input is focused.
  const showAwaiting = !hasFix && !focused;
  // Turn-by-turn banner pushes the style toggle + slide handle down so nothing
  // overlaps the next-maneuver card.
  // B-406 — MEASURED, not the old hardcoded 76. The driver-grade card is taller
  // and grows further at fontScale ≥ 1.3, and a constant offset put the style
  // toggle straight through it. `navHeight + 12` reproduces the previous 26px
  // clearance exactly at the old 64pt height, so nothing else shifts.
  const navShown = hasFix && (!!navBanner || navUnavailable);
  const [navHeight, setNavHeight] = useState(0);

  // The collapsed nav dock. `focused` already collapses the rails for the IME
  // (B-407), so this only has to add the navigating case — writing it as one
  // flag keeps the two reasons the rails hide from drifting apart.
  // Why the draft check: collapsing swaps the composer out for the ETA
  // readout, so an unsent draft would be hidden with no way to see it was
  // still there. A pending message keeps the field on screen.
  const navCompact = navShown && !dockExpanded && !focused && draft.trim().length === 0;

  // B-406 — the right-edge controls are anchored to the DOCK, not to the top.
  // They used to hang off `insets.top + N + navOffset`, and the taller card
  // pushed them down THROUGH the dock: on 320x568 / 360x640 at fontScale 1.3
  // the style column overlapped the mission stepper by 62-74dp and the slide
  // handle the ETA row by 108-120dp (both mandated cells in DESIGN_REVIEW_LOOP
  // §2 / gate G6). Clamping the top offset is NOT the fix — the clamp computes
  // lower than the old constant and drags the column under the zIndex-14
  // banner instead. Anchoring off the measured dock removes the coupling to
  // the banner's height entirely; each control then renders only if the band
  // between the banner and the dock can actually hold it, so a screen with no
  // vertical budget drops chrome instead of burying the live mission data.
  // PDF page 20/22 — "map style controls should be secondary and should not
  // interfere with navigation". The 4-segment column is a permanently expanded
  // 154dp block in the right-hand map gutter; while navigating it collapses to a
  // single layers button and expands on demand. STYLE_TOGGLE_H keeps its name but
  // is now DERIVED from what is actually rendered, so the band gate below still
  // reserves exactly the height in use.
  const STYLE_FULL_H = 154;     // 4 segments x 38 + border
  const STYLE_MINI_H = 40;
  const SLIDE_HANDLE_H = 64;
  const styleExpanded = !navShown || styleOpen;
  const STYLE_TOGGLE_H = styleExpanded ? STYLE_FULL_H : STYLE_MINI_H;

  // Navigation starting re-collapses the picker: it is secondary chrome the
  // moment there is a route to follow, and leaving it open hands the map gutter
  // to a control the driver is not using.
  useEffect(() => {
    if (navShown) {setStyleOpen(false);}
  }, [navShown]);
  const bandTop    = insets.top + 50 + (navShown ? (navHeight || 112) : 0) + 8;
  const bandBottom = winH - (dockHeight || 0) - 12;
  const band       = bandBottom - bandTop;

  // B-406 — speak a NEW maneuver once. The first cut made the card an
  // accessibilityLiveRegion whose label embedded the distance; that label
  // changes on essentially every 4s telemetry poll (distance rounds to 10m,
  // and 50km/h covers ~55m per poll), so TalkBack re-read the whole card
  // continuously — unusable, and Android-only besides (iOS ignores the prop,
  // and neither View was `accessible`, so VoiceOver got nothing). Announcing
  // on the instruction key works on both platforms and fires when it matters.
  const spokenRef = useRef('');
  useEffect(() => {
    if (!navBanner) { spokenRef.current = ''; return; }
    const key = `${navBanner.primary}|${navBanner.secondary ?? ''}`;
    if (key === spokenRef.current) {return;}
    spokenRef.current = key;
    AccessibilityInfo.announceForAccessibility(
      `In ${navBanner.distanceLabel}, ${navBanner.primary}` +
      (navBanner.secondary ? `, ${navBanner.secondary}` : ''),
    );
  }, [navBanner]);

  // B-406 — the mirror of --recenter-bottom for the TOP edge. The WebView
  // cannot see the RN maneuver banner, so the map's own guard was a constant
  // calibrated to the OLD 64pt card: at insets.top 24-59 with a ~115-140 card,
  // system cards were admitted into the covered band and then sat invisible
  // BEHIND an opaque banner, still burning one of the two slots (3-agent
  // review). navBanner sits at `insets.top + 50` and mapWrap is a sibling
  // absolute fill, so WebView CSS px map 1:1 onto these dp from one origin.
  // Declared here, after navShown/navHeight — referencing them from the
  // dock effect above would hit the TDZ during the deps evaluation.
  useEffect(() => {
    if (map.status !== 'ready') {return;}
    const guard = navShown
      ? insets.top + 50 + (navHeight || 112) + 8
      : insets.top + 46;
    mapCmd.setSysTopGuard(guard);
  }, [navShown, navHeight, insets.top, map.status, mapCmd]);
  // Audit H5 — terminal mission → SOS unavailable (button greyed + guarded).
  const isMissionTerminal =
    missionStatus === 'COMPLETED' || missionStatus === 'ABORTED' || missionStatus === 'CANCELLED';

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={C.depth} />

      {/* ── Map ─────────────────────────────────────── */}
      <View style={s.mapWrap}>
        {MAPBOX_TOKEN_MISSING ? (
          // MG-04 — tokenless build: honest state instead of a watchdog loop.
          <MapFailedOverlay onRetry={() => {}} variant="misconfigured" />
        ) : useNativeMap ? (
          // Native Mapbox SDK. onReady drives the SAME useMapReload state the
          // WebView path uses, so the loading/failed overlays and every
          // `map.status !== 'ready'` guard on this screen keep working
          // unchanged across both renderers.
          <>
            <BravoMap
              ref={nativeMapRef}
              detail="rich"
              onReady={map.onReady}
              fallback={<MapFailedOverlay onRetry={map.retry} variant="misconfigured" />}
            />
            {map.status === 'loading' && <MapFailedOverlay onRetry={map.retry} variant="loading" />}
          </>
        ) : (
          <>
            <WebView
              key={`agent-map-${map.reloadKey}`}
              ref={webRef}
              originWhitelist={['*']}
              source={webSource}
              style={s.web}
              onMessage={onMessage}
              javaScriptEnabled
              domStorageEnabled
              allowsInlineMediaPlayback
              androidLayerType="hardware"
              onRenderProcessGone={map.retry}
              onContentProcessDidTerminate={map.retry}
            />
            {map.status === 'loading' && <MapFailedOverlay onRetry={map.retry} variant="loading" />}
            {map.status === 'failed' && <MapFailedOverlay onRetry={map.retry} />}
          </>
        )}
      </View>

      {/* ── Top bar ─────────────────────────────────── */}
      <View style={[s.topBar, {top: insets.top + 4}]}>
        <TouchableOpacity style={s.iconBtn} onPress={() => goBackOnce(navigation)} activeOpacity={0.7}>
          <Icon name="chevron-left" size={20} color={C.tx1} />
        </TouchableOpacity>
        <View style={s.codePill}>
          <View style={s.liveChip}>
            <View style={s.liveDot} />
            {/* Audit C4 — when polls have been failing, stop asserting LIVE;
                show that the status is unconfirmed so the CPO doesn't trust
                a stale state that ops may have aborted. */}
            <Text style={s.liveTxt}>{statusStale ? 'RECONNECTING…' : (missionStatus || 'LIVE')}</Text>
          </View>
          <Text style={s.codeTxt} numberOfLines={1}>{shortCode || `MSN-${missionId.slice(0, 8).toUpperCase()}`}</Text>
        </View>
        <NetworkLatencyChip compact />
        {!isExecMission && (
          <TouchableOpacity style={s.iconBtn} activeOpacity={0.7} onPress={openOverlay}>
            <Icon name="dots-vertical" size={20} color={C.tx1} />
          </TouchableOpacity>
        )}
      </View>

      {/* ── Turn-by-turn maneuver banner (Step 31) ──── */}
      {navShown && (
        navBanner ? (
          // B-406 — driver-grade hierarchy: the DISTANCE is the glanceable
          // element (mono, 34pt), the maneuver the strong second. Previously
          // 16/14pt sat almost equal, so nothing read at a glance at speed.
          // Focusable with a composed label; the SPEAKING is done once per
          // maneuver by the effect above, never per distance tick.
          <View
            style={[s.navBanner, {top: insets.top + 50}]}
            onLayout={e => setNavHeight(e.nativeEvent.layout.height)}
            accessible
            accessibilityLabel={
              `In ${navBanner.distanceLabel}, ${navBanner.primary}` +
              (navBanner.secondary ? `, ${navBanner.secondary}` : '') +
              (navBanner.roadName ? `. Driving on ${navBanner.roadName}` : '')
            }>
            <View style={s.navIcon}><Icon name={navBanner.icon} size={42} color="#FFFFFF" /></View>
            <View style={{flex: 1, minWidth: 0}}>
              <Text style={s.navDist} numberOfLines={1}>{navBanner.distanceLabel}</Text>
              {/* Two lines: a truncated street name is a missed turn. */}
              <Text style={s.navPrimary} numberOfLines={2}>{navBanner.primary}</Text>
              {!!navBanner.secondary && <Text style={s.navSecondary} numberOfLines={1}>{navBanner.secondary}</Text>}
              {/* Navigation.docx — the road being driven ON right now. */}
              {!!navBanner.roadName && <Text style={s.navRoad} numberOfLines={1}>ON {navBanner.roadName.toUpperCase()}</Text>}
            </View>
            {/* Orientation + voice live INSIDE the banner: they only apply
                while navigating, and the map edge is reserved for the route. */}
            <View style={s.navCtrls}>
              <TouchableOpacity
                style={[s.navCtrl, navCamMode === 'course' && s.navCtrlOn]}
                onPress={() => setNavCamMode(m => (m === 'course' ? 'north' : 'course'))}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel={
                  navCamMode === 'course'
                    ? 'Track up. Tap for north up'
                    : 'North up. Tap for track up'
                }>
                <Icon
                  name={navCamMode === 'course' ? 'navigation' : 'compass-outline'}
                  size={17}
                  color={navCamMode === 'course' ? '#FFFFFF' : 'rgba(255,255,255,0.72)'}
                />
                <Text style={[s.navCtrlTxt, navCamMode === 'course' && s.navCtrlTxtOn]}>
                  {navCamMode === 'course' ? 'TRACK' : 'NORTH'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.navCtrl, voiceOn && s.navCtrlOn]}
                onPress={() => setVoiceOn(v => !v)}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel={
                  voiceOn ? 'Voice guidance on. Tap to mute' : 'Voice guidance muted. Tap to unmute'
                }>
                <Icon
                  name={voiceOn ? 'volume-high' : 'volume-off'}
                  size={17}
                  color={voiceOn ? '#FFFFFF' : 'rgba(255,255,255,0.72)'}
                />
                <Text style={[s.navCtrlTxt, voiceOn && s.navCtrlTxtOn]}>
                  {voiceOn ? 'VOICE' : 'MUTED'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <View
            style={[s.navBanner, s.navBannerIdle, {top: insets.top + 50}]}
            onLayout={e => setNavHeight(e.nativeEvent.layout.height)}
            accessible
            accessibilityLabel="Navigation unavailable. Showing the last known route.">
            <View style={s.navIcon}><Icon name="map-marker-off" size={30} color={C.tx3} /></View>
            <View style={{flex: 1, minWidth: 0}}>
              <Text style={s.navPrimary} numberOfLines={2}>Navigation unavailable</Text>
              <Text style={s.navSecondary} numberOfLines={2}>Showing the last known route</Text>
            </View>
          </View>
        )
      )}

      {/* Navigation.docx — Waze pair: legal limit in a red ring, the vehicle's
          own speed beside it. Bottom-LEFT, mirroring the checkpoint button on
          the right, both anchored off the measured dock. Limit renders only
          where the route annotation actually knows it (coverage varies by
          region — never a guessed number on a protection detail). */}
      {navShown && isDriver && (speedKph !== null || limitKph !== null) && (
        <View
          style={[s.speedCluster, {bottom: (dockHeight || 0) + 12}]}
          pointerEvents="none"
          accessible
          accessibilityLabel={
            `Speed ${speedKph ?? 'unknown'} kilometres per hour` +
            (limitKph !== null ? `, limit ${limitKph}` : '')
          }>
          {limitKph !== null && (
            <View style={s.speedLimit}>
              <Text style={s.speedLimitTxt}>{limitKph}</Text>
            </View>
          )}
          <View style={[
            s.speedCur,
            limitKph !== null && speedKph !== null && speedKph > limitKph + 2 && s.speedCurOver,
          ]}>
            <Text style={s.speedCurTxt}>{speedKph ?? '--'}</Text>
            <Text style={s.speedCurUnit}>km/h</Text>
          </View>
        </View>
      )}

      {/* ── Mission checkpoint — the ONE contextual action ──────────
          PDF page 21: "the primary mission action must change contextually,
          including Client Picked Up at pickup." Anchored off the MEASURED dock
          like every other overlay (never appended to it, which would grow
          dockHeight and silently unmount the style column on a short screen),
          and inset on the right so it clears the WebView FOLLOW pill and the
          slide handle. */}
      {!focused && av.action !== 'none' && (
        <TouchableOpacity
          style={[
            s.checkpoint,
            {bottom: (dockHeight || 0) + 12},
            farFromPickup && s.checkpointFar,
            acting && {opacity: 0.6},
          ]}
          disabled={acting}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel={farFromPickup && distToPickupM !== null
            ? `${av.label}. Not there yet — ${formatDistance(distToPickupM)} from the pickup point`
            : av.label}
          onPress={onAdvance}>
          {acting ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <>
              <Icon
                name={farFromPickup ? 'map-marker-distance' : checkpointIcon(av.action)}
                size={19}
                color="#fff"
              />
              <Text style={s.checkpointTxt} numberOfLines={1}>{av.label.toUpperCase()}</Text>
              {/* The range is on the button, not only in the confirm — an officer
                  must be able to see it is gated BEFORE tapping. */}
              {farFromPickup && distToPickupM !== null && (
                <View style={s.checkpointRangePill}>
                  <Text style={s.checkpointRangeTxt}>{formatDistance(distToPickupM)}</Text>
                </View>
              )}
            </>
          )}
        </TouchableOpacity>
      )}
      {/* Everyone assigned sees the SAME stage and the same next step; the server
          enforces lead_only, so a non-lead gets the state, not a dead button. */}
      {!focused && av.action === 'none' && !isLead && leadNext.action !== 'none' && (
        <View style={[s.checkpoint, s.checkpointRead, {bottom: (dockHeight || 0) + 12}]}>
          <Icon name="shield-account-outline" size={17} color={C.tx2} />
          <Text style={[s.checkpointTxt, {color: C.tx2}]} numberOfLines={1}>
            LEAD CONFIRMS · {leadNext.label.toUpperCase()}
          </Text>
        </View>
      )}

      {/* ── Style toggle ──────────────────────────────
          B-407 — hidden while the composer has focus: it is a map control, and
          with the IME up it just crowds the sliver of map that is left (and is
          exactly what the WebView's FOLLOW pill was riding up into). */}
      {!focused && band >= SLIDE_HANDLE_H + 12 + STYLE_TOGGLE_H && (
      <View style={[s.styleToggle, {bottom: (dockHeight || 0) + 12 + SLIDE_HANDLE_H + 12}]}>
        {styleExpanded ? (
          (['dark', 'light', 'sat', '3d'] as StyleId[]).map(k => (
            <TouchableOpacity
              key={k}
              onPress={() => { setStyleId(k); if (navShown) {setStyleOpen(false);} }}
              activeOpacity={0.7}
              style={[s.styleSeg, styleId === k && s.styleSegOn]}>
              <Text style={[s.styleSegTxt, styleId === k && s.styleSegTxtOn]}>{k.toUpperCase()}</Text>
            </TouchableOpacity>
          ))
        ) : (
          <TouchableOpacity
            onPress={() => setStyleOpen(true)}
            activeOpacity={0.7}
            style={s.styleSeg}
            accessibilityRole="button"
            accessibilityLabel={`Map style: ${styleId}. Tap to change`}>
            <Icon name="layers-outline" size={17} color={C.glow} />
          </TouchableOpacity>
        )}
      </View>
      )}

      {/* ── Slide handle (right edge — opens lead console) ── */}
      {!isExecMission && !focused && band >= SLIDE_HANDLE_H && (
        <TouchableOpacity
          style={[s.slideHandle, {bottom: (dockHeight || 0) + 12}]}
          onPress={openOverlay}
          activeOpacity={0.85}>
          <View style={s.slideBar} />
          <View style={s.slideBar} />
          <View style={s.slideBar} />
        </TouchableOpacity>
      )}

      {/* ── Awaiting telemetry pill ─────────────────── */}
      {showAwaiting && (
        <View style={[s.awaiting, {bottom: 220 + insets.bottom}]}>
          <View style={s.spinner} />
          <Text style={s.awaitingTxt}>Awaiting Telemetry</Text>
        </View>
      )}

      {/* ── Bottom dock + mini-status (keyboard-aware) ──
          Issue 42 — the map's ⌖ Follow pill lives INSIDE the WebView, which
          cannot see this overlay. Measure it and lift the pill above it, rather
          than the hard-coded 150px that covered journey steps 5 and 6. */}
      <View
        style={[s.kbWrap, {paddingBottom: bottomPad()}]}
        onLayout={e => setDockHeight(e.nativeEvent.layout.height)}>
        {/* Grab handle — the only affordance that the rails still exist while
            navigating. Rendered for BOTH states so the control that opens the
            detail is the control that closes it. */}
        {navShown && !focused && (
          <TouchableOpacity
            style={s.grab}
            onPress={() => setDockExpanded(v => !v)}
            activeOpacity={0.7}
            hitSlop={HIT_GRAB}
            accessibilityRole="button"
            accessibilityState={{expanded: dockExpanded}}
            accessibilityLabel={dockExpanded ? 'Hide mission detail' : 'Show mission detail'}>
            <View style={s.grabBar} />
          </TouchableOpacity>
        )}

        {/* Message dock */}
        <View style={s.msgDock}>
          <View style={s.callBtns}>
            {/* Deck page 19, "agent call all". This DOES ring the whole assigned
                mission group (ops + crew) and always did — but as a bare 16px
                phone glyph it read as a generic call button, which is why the
                feature was reported missing. The word is the feature. */}
            <TouchableOpacity
              style={[s.callBtn, s.callAllBtn]} activeOpacity={0.7} onPress={() => onCall('voice')}
              hitSlop={HIT_CALL}
              accessibilityRole="button" accessibilityLabel="Call all — ops and crew">
              <Icon name="phone" size={15} color={C.glow} />
              <Text style={s.callAllTxt}>ALL</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.callBtn, s.callBtnVideo]} activeOpacity={0.7} onPress={() => onCall('video')}
              hitSlop={HIT_CALL}
              accessibilityRole="button" accessibilityLabel="Video call ops and crew">
              <Icon name="video" size={16} color={C.glow} />
            </TouchableOpacity>
          </View>
          <View style={s.callBtnsDivider} />
          {/* Collapsed nav dock: the composer's slot carries the two numbers a
              driver actually steers by (Google Maps keeps exactly these), and
              tapping it opens the full dock. The buttons either side are
              rendered ONCE for both states — duplicating this row to build a
              separate nav bar would have meant a second SOS call site, which
              is the shape B-408 was. */}
          {navCompact ? (
            <TouchableOpacity
              style={s.navEta}
              onPress={() => setDockExpanded(true)}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={
                `Arriving ${etaText}${remainingLabel ? `, ${remainingLabel} remaining` : ''}. ` +
                'Tap for mission detail'
              }>
              <Text style={s.navEtaV} numberOfLines={1}>{etaText}</Text>
              {!!remainingLabel && (
                <>
                  <View style={s.navEtaDot} />
                  <Text style={s.navEtaL} numberOfLines={1}>{remainingLabel}</Text>
                </>
              )}
            </TouchableOpacity>
          ) : (
            <TextInput
              style={s.field}
              /**
               * B-640/B-658 - names the CONTAINER, not the roster.
               *
               * "Message ops or crew" was wrong three ways: there is no
               * recipient CHOICE (one composer, one destination - the whole
               * room); on the agency dispatch lane the CLIENT is a member and
               * the word omitted them, which told a CPO the principal was NOT
               * present while they were reading every word; and it clipped.
               *
               * "Mission group" is the only phrasing TRUE on both live
               * provisioning lanes - the agency lane seats client + agency +
               * managers + crew, the ops-console lane seats ops admin + crew.
               * It also matches this screen's own two Alerts ("Mission group
               * not ready") and the client screen's "Mission group - N
               * members", so the vocabulary is already established.
               */
              placeholder="Message mission group…"
              placeholderTextColor={C.tx3}
              value={draft}
              onChangeText={setDraft}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              returnKeyType="send"
              onSubmitEditing={sendDraft}
            />
          )}
          {/* B-408 — the swap is emoji <-> send ONLY. SOS used to live inside
              this ternary, so the panic control vanished the instant the CPO
              typed a character. Both states still carry exactly four buttons,
              so the composer keeps the width it has today even at 320dp. */}
          {draft.trim().length > 0 ? (
            <TouchableOpacity
              style={s.send}
              onPress={sendDraft}
              activeOpacity={0.85}
              hitSlop={HIT_PRIMARY}
              accessibilityRole="button"
              accessibilityLabel="Send message">
              <Icon name="send" size={18} color="#fff" />
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={s.icBtn}
              onPress={() => openChat()}
              activeOpacity={0.7}
              hitSlop={HIT_ICON}
              accessibilityRole="button"
              accessibilityLabel="Open mission chat">
              <Icon name="emoticon-outline" size={18} color={C.tx2} />
            </TouchableOpacity>
          )}
          {/* Audit H5 — grey out + disable SOS on a known-terminal
              mission so the CPO can't tap into a confusing server 4xx.
              onSosPress also guards this; the disabled state makes the
              unavailability visible. SOS is hidden in 'monitor' mode — the
              off-scene manager isn't crew and raiseSos is crew-gated. */}
          {mode !== 'monitor' && (
            <TouchableOpacity
              style={[s.sos, (sosInFlight || isMissionTerminal) && {opacity: 0.4}]}
              activeOpacity={0.7}
              disabled={sosInFlight || isMissionTerminal}
              hitSlop={HIT_PRIMARY}
              accessibilityRole="button"
              accessibilityLabel="Raise SOS"
              accessibilityHint="Alerts ops and your crew. Asks you to confirm first."
              accessibilityState={{disabled: sosInFlight || isMissionTerminal}}
              onPress={onSosPress}>
              <Icon name="alert-octagon" size={20} color={C.err} />
            </TouchableOpacity>
          )}
        </View>

        {/* B-407 — the whole dock rides up as ONE block when the IME opens, so
            with the stepper + status card attached it swallowed ~40% of the
            screen and buried the map the CPO is driving by. Neither is
            actionable while typing (both are read-only status), so the dock
            collapses to the composer until the field blurs. This also shrinks
            the measured dockHeight, which is what was launching the map's
            FOLLOW pill up into the style column. */}
        {!focused && !navCompact && (
          <>
            {/* Step 20 — shared mission stepper (same 6-step bar the client + CPO see). */}
            <View style={{paddingHorizontal: 12, paddingVertical: 8}}>
              <MissionStepper booking={{status: 'CONFIRMED'}} mission={{status: missionStatus}} />
            </View>

            {/* Mini-status — auto-rewrites from waypoint events */}
            <View style={s.miniStatus}>
              <View style={s.wpIc}>
                <Icon name={hasFix ? 'check-bold' : 'clock-outline'} size={14} color={C.ok} />
              </View>
              <View style={{flex: 1, minWidth: 0}}>
                <Text style={s.miniLbl} numberOfLines={1}>{statusLabel}</Text>
                <Text style={s.miniEv}  numberOfLines={1}>{statusEvent}</Text>
              </View>
              {/* Remaining distance in real units — a percentage to "B" was
                  not something a driver could act on. */}
              {!!remainingLabel && (
                <View style={s.eta}>
                  <Text style={s.etaK}>LEFT</Text>
                  <Text style={s.etaV} numberOfLines={1}>{remainingLabel}</Text>
                </View>
              )}
              <View style={s.eta}>
                <Text style={s.etaK}>ETA</Text>
                <Text style={s.etaV} numberOfLines={1}>{etaText}</Text>
              </View>
            </View>
          </>
        )}

        {/* Attribution — render only when not focused so the keyboard
            push doesn't double-stack the line. */}
        {!focused && (
          <Text style={s.attrib}>© Mapbox · OSM · Bravo · {missionStatus}</Text>
        )}
      </View>

      {/* ── Slide-in overlay: legacy MissionLeadConsole ── */}
      <Modal visible={overlayOpen} transparent animationType="fade" onRequestClose={closeOverlay}>
        <View style={s.overlayBackdrop}>
          <Animated.View
            style={[s.overlayPanel, {width: SLIDE_W, transform: [{translateX: slideX}]}]}
            {...pan.panHandlers}>
            {/* Issue 43 — the close control sits under the status bar without
                the inset, and the embedded console must not add a second back
                chevron beneath it. */}
            <View style={[s.overlayHandleArea, {top: insets.top + 8}]} pointerEvents="box-none">
              <TouchableOpacity style={s.overlayClose} onPress={closeOverlay} activeOpacity={0.85}>
                <Icon name="chevron-right" size={22} color={C.tx1} />
              </TouchableOpacity>
            </View>
            <View style={{flex: 1, paddingTop: insets.top}}>
              <MissionLeadConsoleScreen embedded />
            </View>
          </Animated.View>
          <TouchableOpacity style={s.overlayDismiss} onPress={closeOverlay} activeOpacity={1} />
        </View>
      </Modal>

      {/* Waypoints debug count helps verify polling — invisible padding. */}
      <View style={{height: 0, opacity: 0}} pointerEvents="none">
        <Text>{waypoints.length}</Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: C.depth},
  mapWrap: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0},
  web: {flex: 1, backgroundColor: C.depth},

  // Top bar
  topBar: {
    position: 'absolute', left: 14, right: 14,
    flexDirection: 'row', alignItems: 'center', gap: 10,
    zIndex: 15,
  },
  iconBtn: {
    width: 38, height: 38, borderRadius: 10,
    backgroundColor: 'rgba(22,47,84,0.85)',
    borderWidth: 1, borderColor: C.bd2,
    alignItems: 'center', justifyContent: 'center',
  },
  codePill: {
    flex: 1, height: 38, borderRadius: 10,
    paddingHorizontal: 12, gap: 8,
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(22,47,84,0.85)',
    borderWidth: 1, borderColor: C.bd2,
  },
  liveChip: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingVertical: 3, paddingHorizontal: 7, borderRadius: 5,
    backgroundColor: 'rgba(0,200,83,0.12)',
    borderWidth: 1, borderColor: 'rgba(0,200,83,0.3)',
  },
  liveDot: {width: 5, height: 5, borderRadius: 2.5, backgroundColor: C.ok},
  liveTxt: {color: C.ok, fontSize: 9.5, fontWeight: '800', letterSpacing: 1.4, fontFamily: Platform.select({ios: 'Menlo', default: 'monospace'})},
  codeTxt: {flex: 1, color: C.tx1, fontSize: 11.5, fontWeight: '700', letterSpacing: 0.6, fontFamily: Platform.select({ios: 'Menlo', default: 'monospace'})},

  // Turn-by-turn maneuver banner — B-406 driver-grade sizing.
  // Read at arm's length, in motion, in one glance. minHeight (never height)
  // so it still grows at fontScale 1.3 instead of clipping the instruction.
  // Founder 2026-08-23 — "bold for visibility", then the Mapbox Navigation SDK
  // reference: a SOLID cobalt slab with white type, not a translucent navy
  // card. The levers are SIZE, CONTRAST and LIFT, never fontWeight — this is
  // already '800' and Manrope ships 300-700, so a heavier number buys a
  // synthesised face at best. #1E88FF is the blue this screen already uses for
  // the checkpoint pill; no new token is introduced.
  //
  // Contrast: white on #1E88FF is 3.49:1, which clears WCAG's 3:1 LARGE-text
  // bar but not the 4.5:1 body bar. navDist (40) and navPrimary (22) are large
  // outright; navSecondary is held at 700 weight so 14.5pt bold also qualifies
  // as large. Dropping that weight silently makes this row non-compliant.
  navBanner: {
    position: 'absolute', left: 12, right: 12,
    minHeight: 112, borderRadius: 18,
    backgroundColor: '#1E88FF',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.22)',
    flexDirection: 'row', alignItems: 'center', gap: 14,
    paddingHorizontal: 16, paddingVertical: 14, zIndex: 14,
    shadowColor: '#000', shadowOpacity: 0.45, shadowRadius: 16,
    shadowOffset: {width: 0, height: 8}, elevation: 10,
  },
  navIcon: {
    width: 68, height: 68, borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.38)',
    alignItems: 'center', justifyContent: 'center',
  },
  navDist: {color: '#FFFFFF', fontSize: 40, lineHeight: 44, fontWeight: '800', letterSpacing: 0.2, fontFamily: Platform.select({ios: 'Menlo', default: 'monospace'})},
  navPrimary: {color: '#FFFFFF', fontSize: 22, lineHeight: 27, fontWeight: '800', marginTop: 2},
  navSecondary: {color: 'rgba(255,255,255,0.92)', fontSize: 14.5, lineHeight: 19, fontWeight: '700', marginTop: 2},
  // Navigation.docx — current-road line: quiet caps under the maneuver text.
  navRoad: {color: 'rgba(255,255,255,0.62)', fontSize: 11, lineHeight: 15, fontWeight: '700', letterSpacing: 1.2, marginTop: 3},

  // Navigation.docx — speed cluster (bottom-left, mirrors the checkpoint).
  speedCluster: {position: 'absolute', left: 12, flexDirection: 'row', alignItems: 'center', gap: 8, zIndex: 20},
  // Legal limit: the road-sign shape — white disc, thick red ring, black number.
  speedLimit: {
    width: 54, height: 54, borderRadius: 27, backgroundColor: '#FFFFFF',
    borderWidth: 6, borderColor: '#DC2626', alignItems: 'center', justifyContent: 'center',
    elevation: 4, shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 6, shadowOffset: {width: 0, height: 2},
  },
  speedLimitTxt: {color: '#0B0E14', fontSize: 18, fontWeight: '800', fontVariant: ['tabular-nums']},
  speedCur: {
    minWidth: 62, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14,
    backgroundColor: 'rgba(11,14,20,0.88)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)',
    alignItems: 'center', justifyContent: 'center',
    elevation: 4, shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 6, shadowOffset: {width: 0, height: 2},
  },
  speedCurOver: {backgroundColor: 'rgba(220,38,38,0.92)', borderColor: '#DC2626'},
  speedCurTxt: {color: '#FFFFFF', fontSize: 19, lineHeight: 22, fontWeight: '800', fontVariant: ['tabular-nums']},
  speedCurUnit: {color: 'rgba(255,255,255,0.66)', fontSize: 9, fontWeight: '700', letterSpacing: 1, marginTop: 1},

  // "Call all" — the group-call control, labelled so it reads as one.
  callAllBtn: {flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 7, width: undefined},
  callAllTxt: {
    color: C.glow, fontSize: 9, fontWeight: '800', letterSpacing: 0.8,
    fontFamily: Platform.select({ios: 'Menlo', default: 'monospace'}),
  },

  // The mission checkpoint pill. right:96 clears the WebView FOLLOW pill
  // (right:12) and the RN slide handle, neither of which RN can lay out around.
  checkpoint: {
    position: 'absolute', left: 14, right: 96, height: 52, borderRadius: 14,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9,
    paddingHorizontal: 12, zIndex: 13,
    backgroundColor: '#1E88FF', borderWidth: 1, borderColor: 'rgba(255,255,255,0.20)',
    shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 12,
    shadowOffset: {width: 0, height: 6}, elevation: 6,
  },
  // Out of radius: still offered (GPS drift must never strand an officer who HAS
  // arrived), but it must not read as the live action. Founder 2026-08-24 saw
  // ARRIVED AT PICKUP 12 km out and could not tell it was gated — the old
  // treatment only darkened the same solid fill, which on a dark map is just a
  // primary button. Now it is outlined, and the button itself carries the range.
  checkpointFar: {
    backgroundColor: 'rgba(30,136,255,0.14)',
    borderColor: 'rgba(120,170,255,0.45)',
    shadowOpacity: 0, elevation: 0,
  },
  checkpointRangePill: {
    paddingHorizontal: 7, paddingVertical: 3, borderRadius: 6,
    backgroundColor: 'rgba(255,255,255,0.10)', borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)', flexShrink: 0,
  },
  checkpointRangeTxt: {
    color: '#CFE0FF', fontSize: 10, fontWeight: '800', letterSpacing: 0.6,
    fontFamily: Platform.select({ios: 'Menlo', default: 'monospace'}),
  },
  checkpointRead: {backgroundColor: 'rgba(22,47,84,0.92)', borderColor: C.bd2, elevation: 0},
  checkpointTxt: {
    color: '#fff', fontSize: 13, fontWeight: '800', letterSpacing: 1.1, flexShrink: 1,
    fontFamily: Platform.select({ios: 'Menlo', default: 'monospace'}),
  },

  // Orientation + voice, docked inside the maneuver banner.
  navCtrls: {gap: 6},
  // On the solid cobalt slab these read as white-on-blue chips; the old navy
  // fill disappeared into nothing once the banner stopped being navy.
  navCtrl: {
    width: 46, paddingVertical: 5, borderRadius: 9,
    alignItems: 'center', justifyContent: 'center', gap: 1,
    backgroundColor: 'rgba(255,255,255,0.16)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.28)',
  },
  navCtrlOn: {borderColor: 'rgba(255,255,255,0.70)', backgroundColor: 'rgba(255,255,255,0.30)'},
  navCtrlTxt: {
    color: 'rgba(255,255,255,0.78)', fontSize: 7.5, fontWeight: '800', letterSpacing: 0.8,
    fontFamily: Platform.select({ios: 'Menlo', default: 'monospace'}),
  },
  navCtrlTxtOn: {color: '#FFFFFF'},

  // The "navigation unavailable" fallback shares the banner's geometry but
  // must NOT wear the active-guidance blue — a cobalt slab that says guidance
  // is dead is the screen contradicting itself. Applied after s.navBanner.
  navBannerIdle: {
    backgroundColor: 'rgba(10,31,63,0.97)',
    borderColor: C.bd2,
  },

  // Style toggle
  styleToggle: {
    position: 'absolute', right: 14,
    width: 38, borderRadius: 10, overflow: 'hidden',
    backgroundColor: 'rgba(22,47,84,0.85)',
    borderWidth: 1, borderColor: C.bd2, zIndex: 12,
  },
  styleSeg: {height: 38, alignItems: 'center', justifyContent: 'center', borderBottomWidth: 1, borderBottomColor: C.bd2},
  styleSegOn: {backgroundColor: 'rgba(30,136,255,0.18)'},
  styleSegTxt: {fontSize: 9, fontWeight: '800', color: C.tx3, letterSpacing: 1, fontFamily: Platform.select({ios: 'Menlo', default: 'monospace'})},
  styleSegTxtOn: {color: C.glow},

  // Right-edge slide handle
  slideHandle: {
    position: 'absolute', right: 0, width: 22, height: 64, borderRadius: 8,
    backgroundColor: 'rgba(22,47,84,0.85)',
    borderTopLeftRadius: 14, borderBottomLeftRadius: 14,
    borderWidth: 1, borderRightWidth: 0, borderColor: C.bd2,
    alignItems: 'center', justifyContent: 'center', gap: 4, zIndex: 12,
  },
  slideBar: {width: 2, height: 14, borderRadius: 1, backgroundColor: C.glow, opacity: 0.7},

  // Awaiting pill
  awaiting: {
    position: 'absolute', alignSelf: 'center',
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 16, paddingVertical: 9, borderRadius: 20,
    backgroundColor: 'rgba(255,193,7,0.12)',
    borderWidth: 1, borderColor: 'rgba(255,193,7,0.45)', zIndex: 12,
    left: '50%', transform: [{translateX: -90}],
  },
  spinner: {
    width: 12, height: 12, borderRadius: 6,
    borderWidth: 2, borderColor: 'rgba(255,193,7,0.3)', borderTopColor: C.warn,
  },
  awaitingTxt: {color: C.warn, fontSize: 10.5, fontWeight: '800', letterSpacing: 1.6, fontFamily: Platform.select({ios: 'Menlo', default: 'monospace'})},

  // Bottom dock keyboard wrap
  kbWrap: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    paddingHorizontal: 14, paddingTop: 8, gap: 8,
  },

  // Message dock
  msgDock: {
    height: 50, borderRadius: 25,
    backgroundColor: 'rgba(10,31,63,0.94)',
    borderWidth: 1, borderColor: C.bd2,
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingLeft: 8, paddingRight: 6,
  },
  callBtns: {flexDirection: 'row', gap: 4, alignItems: 'center'},
  callBtnsDivider: {width: 1, height: 22, backgroundColor: C.bd2, marginHorizontal: 4},
  callBtn: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: 'rgba(30,136,255,0.12)',
    borderWidth: 1, borderColor: 'rgba(30,136,255,0.3)',
    alignItems: 'center', justifyContent: 'center',
  },
  callBtnVideo: {
    backgroundColor: 'rgba(126,214,255,0.10)',
    borderColor: 'rgba(126,214,255,0.28)',
  },
  field: {flex: 1, color: C.tx1, fontSize: 12.5, fontWeight: '500', minWidth: 0, paddingVertical: 4},

  // Collapsed-dock grab handle. 24pt tall for the visual, HIT_GRAB takes the
  // real target to 136x48 — the bar itself is far under the 48dp minimum.
  grab: {alignSelf: 'center', paddingVertical: 10, alignItems: 'center', justifyContent: 'center'},
  grabBar: {width: 40, height: 4, borderRadius: 2, backgroundColor: C.tx3, opacity: 0.7},

  // ETA + distance in the composer's slot while navigating. minWidth:0 on the
  // row AND flexShrink on both labels: "16:39" must never be pushed out by a
  // long distance string at 320dp / fontScale 1.3.
  navEta: {flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4},
  navEtaV: {
    color: C.tx1, fontSize: 17, fontWeight: '800', letterSpacing: 0.4, flexShrink: 0,
    fontFamily: Platform.select({ios: 'Menlo', default: 'monospace'}),
  },
  navEtaDot: {width: 3, height: 3, borderRadius: 1.5, backgroundColor: C.tx3, flexShrink: 0},
  navEtaL: {
    color: C.tx2, fontSize: 13.5, fontWeight: '700', letterSpacing: 0.3, flexShrink: 1, minWidth: 0,
    fontFamily: Platform.select({ios: 'Menlo', default: 'monospace'}),
  },
  icBtn: {
    width: 32, height: 32, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
  },
  // B-408 — the two primary actions reach the 44pt floor visually (they fit:
  // the pill is 48dp inside its border) and 48dp tall with hitSlop.
  send: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: C.act,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: C.act, shadowOffset: {width: 0, height: 4}, shadowOpacity: 0.6, shadowRadius: 12, elevation: 6,
  },
  // B-408 — was `ptt`: an inherited push-to-talk button, painted with the
  // SUCCESS token (rgba of C.ok #00C853) and carrying a red glyph. A panic
  // control that reads green is a semantic bug as much as a design-system one;
  // it now uses the danger token it always should have.
  sos: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: 'rgba(255,59,59,0.15)',
    borderWidth: 1, borderColor: 'rgba(255,59,59,0.45)',
    alignItems: 'center', justifyContent: 'center',
  },

  // Mini-status strip
  miniStatus: {
    height: 54, borderRadius: 14,
    backgroundColor: 'rgba(22,47,84,0.92)',
    borderWidth: 1, borderColor: C.bd2,
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 14,
  },
  wpIc: {
    width: 30, height: 30, borderRadius: 8,
    backgroundColor: 'rgba(0,200,83,0.15)',
    borderWidth: 1, borderColor: 'rgba(0,200,83,0.4)',
    alignItems: 'center', justifyContent: 'center',
  },
  miniLbl: {color: C.ok, fontSize: 9, fontWeight: '800', letterSpacing: 1.5, fontFamily: Platform.select({ios: 'Menlo', default: 'monospace'})},
  miniEv:  {color: C.tx1, fontSize: 13, fontWeight: '600', marginTop: 1},
  eta: {alignItems: 'flex-end', paddingLeft: 12, borderLeftWidth: 1, borderLeftColor: C.bd2},
  etaK: {color: C.tx3, fontSize: 9, fontWeight: '700', letterSpacing: 1.4, fontFamily: Platform.select({ios: 'Menlo', default: 'monospace'})},
  etaV: {color: C.tx1, fontSize: 14.5, fontWeight: '800', letterSpacing: 0.5, fontFamily: Platform.select({ios: 'Menlo', default: 'monospace'})},

  attrib: {
    color: C.tx3, fontSize: 9, alignSelf: 'flex-start',
    marginTop: 2, paddingLeft: 4,
    fontFamily: Platform.select({ios: 'Menlo', default: 'monospace'}),
  },

  // Slide-in overlay
  overlayBackdrop: {flex: 1, backgroundColor: 'rgba(4,16,31,0.55)', flexDirection: 'row'},
  overlayDismiss: {flex: 1},
  overlayPanel: {
    backgroundColor: C.depth,
    borderLeftWidth: 1, borderLeftColor: C.bd1,
    shadowColor: '#000', shadowOffset: {width: -8, height: 0}, shadowOpacity: 0.5, shadowRadius: 18, elevation: 18,
  },
  overlayHandleArea: {
    position: 'absolute', top: 12, left: 8, zIndex: 30,
  },
  overlayClose: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: 'rgba(22,47,84,0.85)',
    borderWidth: 1, borderColor: C.bd2,
    alignItems: 'center', justifyContent: 'center',
  },
}));
