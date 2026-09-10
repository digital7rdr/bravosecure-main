/**
 * Agent Dashboard — the home screen for an active partner (CPO side).
 *
 * Premium redesign (Bravo "Agent Dashboard" design handoff): obsidian/cobalt
 * palette matching the client booking flow. Glowing on-duty profile card with
 * a real duty toggle, stat tiles, a "Next on Ops" active-mission / empty state,
 * and tinted navigation rows. A profile/settings drawer slides from the left.
 *
 * All data is real: /agents/me on mount, active-mission polling, mandatory
 * location permission + on-mission location reporting. The ON DUTY toggle
 * calls PATCH /agents/me/duty, which flips `agents.on_duty` AND the cpo_pool
 * availability so ops dispatch actually sees the agent (agent.service.setDuty).
 */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  Animated, Modal, TouchableWithoutFeedback,
  View, Text, ScrollView, TouchableOpacity, Image, ActivityIndicator,
  StatusBar, StyleSheet, RefreshControl,
  Platform, PermissionsAndroid, Linking, AppState,
  type ImageSourcePropType,
} from 'react-native';
import {Alert} from '@utils/alert';
import Geolocation from 'react-native-geolocation-service';
import {navigateOnce} from '@navigation/tapGuard';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import FitLine from '@components/ui/FitLine';
import {Imagery} from '@theme/imagery';
import ImageryBackdrop from '@components/ui/ImageryBackdrop';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {AgentStackParamList} from '@navigation/types';
import {agentApi, orgApi, dispatchApi, attendanceApi, incidentApi, type AgentPortalState, type OrgMissionDto} from '@services/api';
import {bcFromAed} from '@screens/booking/pricing';
import {startOnDutyHeartbeat, stopOnDutyHeartbeat, isLocatable} from '@services/onDutyHeartbeat';
import {drainDispatchRoomIntents, isOpsRoomKeyAuthority} from '@/modules/messenger/orgWorkspace/dispatchRoomIntents';
import {pickInitials} from './agentFlowHelpers';
import {useAuthStore} from '@store/authStore';
import {useAvatarPicker} from '@modules/profile/useAvatarPicker';
import {AvatarPhotoSheet} from '@modules/profile/AvatarPhotoSheet';
import {DEPT_CHAT_V2} from '@utils/constants';
import {regionName} from '@utils/regions';
import {MapPrewarm} from '@/modules/booking/MapPrewarm';
import {scaleTextStyles} from '@utils/scaling';
import ActivityBell from '@components/ActivityBell';

type IconName = React.ComponentProps<typeof Icon>['name'];

// Design tokens (Bravo "Agent Dashboard" handoff — obsidian/cobalt premium).
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
  accentGlow: 'rgba(91,141,239,0.35)',
  accentSoft: '#A9C5FF',
  signal:     '#4ADE80',
  amber:      '#F5C76B',
  alert:      '#F58B97',
  fSans:    'Manrope_500Medium',
  fSemi:    'Manrope_600SemiBold',
  fBold:    'Manrope_700Bold',
  fMono:    'monospace',
};

// Tinted nav-row palette (icon tile bg/border/fg per row).
const NAV_TINT = {
  amber:  {fg: '#F5C76B', bg: 'rgba(245,181,68,0.12)',  bd: 'rgba(245,181,68,0.34)'},
  signal: {fg: '#7FE6A8', bg: 'rgba(74,222,128,0.12)',  bd: 'rgba(74,222,128,0.32)'},
  red:    {fg: '#F58B97', bg: 'rgba(245,72,90,0.12)',   bd: 'rgba(245,72,90,0.32)'},
  blue:   {fg: '#A9C5FF', bg: 'rgba(91,141,239,0.14)',  bd: 'rgba(91,141,239,0.34)'},
} as const;

const AGENT_MENU: {icon: IconName; label: string; divider?: boolean}[] = [
  {icon: 'account-outline',          label: 'My Profile'},
  {icon: 'chart-line',               label: 'Earnings'},
  {icon: 'earth',                    label: 'Coverage Regions', divider: true},
  {icon: 'message-text-outline',     label: 'Messenger'},
  {icon: 'newspaper-variant-outline',label: 'Bravo Feed', divider: true},
  {icon: 'shield-lock-outline',      label: 'Security Settings'},
  {icon: 'help-circle-outline',      label: 'Help & Support'},
];

type Nav = NativeStackNavigationProp<AgentStackParamList>;

// The active-mission row the dashboard renders. The API types these fields as
// non-null strings, but the payload is server-controlled and unvalidated — a
// drifted / partial row (missing booking join, legacy data) could carry a null
// where the type promises a string. Any such field is then dereferenced during
// RENDER (e.g. pickup_address.split()), which throws and bubbles to the root
// ErrorBoundary ("Something went wrong"). normalizeMission() is the single
// choke point: it coerces every field to a safe value so NO consumer of
// activeMission can crash on a malformed field, regardless of which ingestion
// path (load / poll tick) produced it.
type ActiveMission = {
  mission_id: string; short_code: string; status: string;
  is_lead: boolean; role: string;
  pickup_address: string; dropoff_address: string | null;
  pickup_time: string; region_label: string | null;
};

function normalizeMission(raw: unknown): ActiveMission | null {
  if (!raw || typeof raw !== 'object') {return null;}
  const m = raw as Record<string, unknown>;
  // A mission with no id is unusable (can't open AgentLiveTracker), so treat
  // it as "no active mission" rather than rendering a broken card.
  if (typeof m.mission_id !== 'string' || m.mission_id === '') {return null;}
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const nullableStr = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  return {
    mission_id:     m.mission_id,
    short_code:     str(m.short_code),
    status:         str(m.status),
    is_lead:        m.is_lead === true,
    role:           str(m.role),
    pickup_address: str(m.pickup_address),
    dropoff_address: nullableStr(m.dropoff_address),
    pickup_time:    str(m.pickup_time),
    region_label:   nullableStr(m.region_label),
  };
}

// Step 20 — one cell of the agency capacity strip.
function CapStat({value, label, tint}: {value: string; label: string; tint: string}) {
  return (
    <View style={{flex: 1, alignItems: 'center', gap: 2}}>
      <Text style={{fontFamily: D.fBold, fontSize: 19, color: tint, letterSpacing: -0.3}}>{value}</Text>
      <Text style={{fontFamily: D.fSemi, fontSize: 9, letterSpacing: 1, color: D.textMute}}>{label}</Text>
    </View>
  );
}

export default function AgentDashboardScreen() {
  const insets     = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const {signOut, user, recheckMembership}  = useAuthStore();
  // Step 22 (G3) — dept-chat MANAGER surfaces gate on "can manage" = a service-
  // provider company OR a delegated manager (both resolve to account_kind
  // 'agency'), NOT on agent.type==='company' which is false for a delegated
  // manager and wrongly hid the manager experience. Company-only surfaces
  // (Missions/Compliance/Roster) keep using isOrg (agent.type==='company') below.
  const canManage = user?.is_org_manager ?? (user?.role === 'service_provider' || user?.account_kind === 'agency');

  const [me, setMe]                 = useState<AgentPortalState | null>(null);
  const [activeMission, setActiveMission] = useState<ActiveMission | null>(null);
  const [onDuty, setOnDuty]         = useState(false);
  const [dutyBusy, setDutyBusy]     = useState(false);
  const [dutyErr, setDutyErr]       = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [locStatus, setLocStatus]   = useState<'granted'|'denied'|'blocked'|'unknown'>('unknown');
  const watchIdRef                  = useRef<number | null>(null);
  const [heartbeatAt, setHeartbeatAt] = useState<number | null>(null);
  const [nowTick, setNowTick]         = useState(() => Date.now());
  // Step 20 — agency capacity strip + live-offer banner (org only).
  const [cap, setCap] = useState<{guards_total: number; guards_free: number; guards_on_duty: number; active_missions: number; org_rating: number | null; org_jobs_total: number} | null>(null);
  const [liveOffer, setLiveOffer] = useState<{offer_id: string; region_label: string} | null>(null);
  // B-215 — NEXT ON OPS previously only ever showed the VIEWER's own personal
  // mission (agentApi.getActiveMission), which is right for an individual CPO
  // but wrong for an org account: the owner/manager isn't personally crewed,
  // so it always read "No active mission" even with a full board running.
  // Compact preview of the agency's own board (same source OrgMissionsScreen
  // uses) so this slot shows something real instead of a dead placeholder.
  const [orgMissions, setOrgMissions] = useState<{needs_crew: OrgMissionDto[]; active: OrgMissionDto[]; recent: OrgMissionDto[]} | null>(null);
  // Dept Chat v2 (Step 13) — inline today's-shift cue + role-gated alert badges.
  const [deptBadges, setDeptBadges] = useState<{attendance?: string; adminAtt?: string; incQueue?: string}>({});

  // ── Who is looking at this dashboard ─────────────────────────
  // ONE derivation, declared before the effects that need it. It was written
  // out by hand in three places (org-data fetch, layout, module filter) and
  // all three drifted to the same wrong test — so a manager failed every one
  // of them at once: no org data fetched, solo-CPO layout, no module filter.
  const managedOrg = user?.managed_org ?? null;
  const isPromotedManager = !!managedOrg;

  // ── Profile photo ────────────────────────────────────────────
  const picker = useAvatarPicker();
  const [photoSheet, setPhotoSheet] = useState(false);

  // ── Sidebar drawer ───────────────────────────────────────────
  const [drawerOpen, setDrawerOpen]   = useState(false);
  const drawerSlide = useRef(new Animated.Value(-320)).current;

  const openDrawer = useCallback(() => {
    setDrawerOpen(true);
    Animated.spring(drawerSlide, {toValue: 0, useNativeDriver: true, bounciness: 4}).start();
  }, [drawerSlide]);

  const closeDrawer = useCallback(() => {
    Animated.timing(drawerSlide, {toValue: -320, duration: 260, useNativeDriver: true}).start(
      () => setDrawerOpen(false),
    );
  }, [drawerSlide]);

  const handleMenuPress = useCallback((label: string) => {
    closeDrawer();
    setTimeout(() => {
      // NAV-08 — a back press inside the 280 ms drawer-close window must not
      // let this timer navigate on the popped screen's behalf.
      if (!navigation.isFocused()) {return;}
      switch (label) {
        case 'My Profile':     navigateOnce(navigation, 'AgentProfile'); break;
        case 'Messenger':      navigateOnce(navigation, 'MessengerHome'); break;
        case 'Bravo Feed':     navigateOnce(navigation, 'IntelFeed'); break;
        case 'Earnings':       navigateOnce(navigation, 'Earnings'); break;
        // Coverage Regions → the agency operating-region setting (company accounts only).
        case 'Coverage Regions':
          if (me?.agent.type === 'company') {navigateOnce(navigation, 'OrgRegion');}
          break;
        default: break;
      }
    }, 280);
  }, [closeDrawer, navigation, me]);

  const load = useCallback(async () => {
    // Step 12 → B-416 — drain pending Ops-Room membership intents so
    // newly-crewed CPOs are rekeyed into the booking's E2EE room (and
    // removed ones rekeyed out). HOISTED OUT of the getMe try-block: a pure
    // delegated manager has NO agents row, so getMe throws for them and the
    // old in-try `agent.type === 'company'` check made this trigger
    // unreachable for exactly the accounts B-416 admits. The shared
    // predicate gates the call; per-room safety is the drain's server claim.
    if (isOpsRoomKeyAuthority(useAuthStore.getState().user)) {
      void drainDispatchRoomIntents().catch(() => {});
    }
    try {
      const {data} = await agentApi.getMe();
      setMe(data);
      setOnDuty(data.agent.on_duty);
    } catch { /* graceful degradation */ }
    // Active mission is independent of /me — fetch separately so a
    // failure in one doesn't blank the other.
    try {
      const {data} = await agentApi.getActiveMission();
      setActiveMission(normalizeMission(data));
    } catch { setActiveMission(null); }
  }, []);

  // Refresh active mission on focus and on a short interval so a fresh
  // dispatch from ops shows up without manual pull-to-refresh. Paused
  // when the app is backgrounded so the agent's idle phone isn't firing
  // 8s polls for nothing.
  useEffect(() => {
    let t: ReturnType<typeof setInterval> | null = null;
    const tick = () => {
      agentApi.getActiveMission()
        .then(({data}) => setActiveMission(normalizeMission(data)))
        .catch(() => { /* keep last known state */ });
    };
    const start = () => { if (!t) {t = setInterval(tick, 8000);} };
    const stop  = () => { if (t)  { clearInterval(t); t = null; } };
    if (AppState.currentState === 'active') {start();}
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') { tick(); start(); } else {stop();}
    });
    return () => { stop(); sub.remove(); };
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Location is mandatory for agents — check on every mount and re-ask if missing.
  useEffect(() => {
    void (async () => {
      try {
        if (Platform.OS === 'android') {
          const already = await PermissionsAndroid.check(
            PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
          );
          if (already) { setLocStatus('granted'); return; }

          const result = await PermissionsAndroid.request(
            PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
            {
              title:          'Location Required',
              message:        'Bravo Secure needs your location to track your position during missions and dispatch jobs to you.',
              buttonPositive: 'Allow',
              buttonNegative: 'Not now',
            },
          );
          if (result === PermissionsAndroid.RESULTS.GRANTED) {
            setLocStatus('granted');
          } else if (result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) {
            setLocStatus('blocked');
          } else {
            setLocStatus('denied');
          }
        } else {
          const auth = await Geolocation.requestAuthorization('always');
          setLocStatus(auth === 'granted' ? 'granted' : auth === 'denied' ? 'denied' : 'blocked');
        }
      } catch {
        setLocStatus('denied');
      }
    })();
  }, []);

  const onRefresh = async () => {
    setRefreshing(true);
    // A demote (manager → CPO) must take effect on the very next pull-to-
    // refresh, not wait for a background/foreground cycle — recheckMembership
    // re-fetches is_org_manager from /auth/me; resolveAuthedRoute picks up
    // the change on the next render and swaps this whole shell for CpoNavigator.
    await Promise.all([load(), recheckMembership()]);
    setRefreshing(false);
  };

  // Mission state — gates both location reporting and the duty-toggle guard.
  const missionStatus = (activeMission?.status ?? '').toUpperCase();
  const missionActive = missionStatus === 'DISPATCHED'
    || missionStatus === 'PICKUP'
    || missionStatus === 'LIVE'
    || missionStatus === 'SOS';

  // Start/stop live location reporting based on duty + permission + active
  // mission. Gating on an active mission restricts the push to the window
  // when ops actually need the agent on the live map.
  useEffect(() => {
    if (locStatus !== 'granted' || !onDuty || !missionActive) {
      if (watchIdRef.current !== null) {
        Geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
      return;
    }
    // Throttled: this posts on every fix, and the shared native location
    // stream is retuned to navigation cadence (~1 Hz) whenever the driver has
    // the live tracker open. Without this the dashboard would POST a location
    // update every second for the whole mission.
    let lastSentAt = 0;
    const send = (lat: number, lng: number) => {
      const now = Date.now();
      if (now - lastSentAt < 10_000) {return;}
      lastSentAt = now;
      agentApi.updateLocation(lat, lng).catch(() => {});
    };
    Geolocation.getCurrentPosition(
      p => send(p.coords.latitude, p.coords.longitude),
      err => { console.warn('[agent-loc] seed fix failed, code=', err?.code); },
      {enableHighAccuracy: true, timeout: 10000},
    );
    watchIdRef.current = Geolocation.watchPosition(
      p => send(p.coords.latitude, p.coords.longitude),
      err => { console.warn('[agent-loc] watch error, code=', err?.code); },
      {enableHighAccuracy: true, interval: 30000, fastestInterval: 15000, distanceFilter: 20},
    );
    return () => {
      if (watchIdRef.current !== null) {
        Geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
    };
  }, [locStatus, onDuty, missionActive]);

  // On-duty location heartbeat — gated on DUTY, not on a mission (unlike the
  // live-map watcher above). Reports location while Online so the dispatch pool
  // can rank this agency even with no active mission (LB16). Background-survival
  // caveat lives in onDutyHeartbeat.ts.
  useEffect(() => {
    if (onDuty && locStatus === 'granted') {
      startOnDutyHeartbeat({onPush: setHeartbeatAt});
      return () => stopOnDutyHeartbeat();
    }
    // Off-duty or permission lost: stop and forget the last fix so the dot can't
    // briefly read a pre-offline "Locatable" on a fast Online→Offline→Online.
    stopOnDutyHeartbeat();
    setHeartbeatAt(null);
    return undefined;
  }, [onDuty, locStatus]);

  // Slow ticker so the "locatable" dot can go stale on screen between pushes.
  useEffect(() => {
    if (!onDuty) { return undefined; }
    const t = setInterval(() => setNowTick(Date.now()), 20_000);
    return () => clearInterval(t);
  }, [onDuty]);

  // Step 20 — agency capacity + live-offer poll (company orgs only; the endpoints are
  // OrgManagerGuard-gated so an individual officer gets null and the strip stays hidden).
  useEffect(() => {
    // A promoted manager is routed into this same owner shell but their own
    // `agents` row stays type='cpo', so gating the org poll on it left them
    // with the SELF numbers below. Condition inlined rather than reusing the
    // `isOrg` const, which is declared further down this component (TDZ).
    // /org/summary is OrgManagerGuard-gated, so a plain officer still gets
    // nothing and the strip stays hidden.
    // B-215 — `deriveAccountKind` (account-kind.ts) gives a delegated MANAGER
    // account_kind 'agency', not 'cpo' (isActiveManager routes into the same
    // branch as isCompanyAgent) — this checked the wrong string, so a manager
    // ALWAYS failed orgScoped and silently fell back to their own personal
    // agents-row rating/jobs_total instead of the agency's (same B-210 class
    // of bug: is_org_manager alone can't distinguish owner from manager,
    // `org` can — null for the owner, non-null for a delegated manager).
    const orgScoped = me?.agent.type === 'company' || isPromotedManager;
    if (!orgScoped) { setCap(null); setLiveOffer(null); setOrgMissions(null); return undefined; }
    let alive = true;
    const tick = async () => {
      const [sum, off, missions] = await Promise.all([
        orgApi.getSummary().then(r => r.data).catch(() => null),
        dispatchApi.getCurrentOffer().then(r => r.data).catch(() => null),
        orgApi.listMissions().then(r => r.data).catch(() => null),
      ]);
      if (!alive) { return; }
      if (sum) { setCap(sum); }
      setLiveOffer(off ? {offer_id: off.offer_id, region_label: off.region_label} : null);
      if (missions) { setOrgMissions(missions); }
    };
    void tick();
    const t = setInterval(() => { void tick(); }, 12_000);
    return () => { alive = false; clearInterval(t); };
  }, [me?.agent.type, isPromotedManager]);

  // Dept Chat v2 (Step 13) — flag-gated badges. Member: a "today's shift" cue;
  // manager (company): pending-review + open-incident counts (role-gated alerts).
  // All endpoints 404 when the flag is off → caught, badges stay empty.
  useEffect(() => {
    if (!DEPT_CHAT_V2) {return undefined;}
    let alive = true;
    const org = canManage;
    void (async () => {
      const next: {attendance?: string; adminAtt?: string; incQueue?: string} = {};
      try { const {data} = await attendanceApi.myTodayShift(); if (data) {next.attendance = 'TODAY';} } catch { /* flag off / none */ }
      if (org) {
        try { const {data} = await attendanceApi.orgSummary(); if (data.pendingReview > 0) {next.adminAtt = String(data.pendingReview);} } catch { /* none */ }
        try {
          const {data} = await incidentApi.queue();
          const open = data.filter(i => i.status !== 'closed' && i.status !== 'resolved').length;
          if (open > 0) {next.incQueue = String(open);}
        } catch { /* none */ }
      }
      if (alive) {setDeptBadges(next);}
    })();
    return () => { alive = false; };
  }, [canManage]);

  const locatable = isLocatable(onDuty, heartbeatAt, nowTick);

  // Persist the on-duty flip to the server (real: flips agents.on_duty +
  // cpo_pool availability). Optimistic with rollback + surfaced error.
  const commitDuty = useCallback(async (next: boolean) => {
    setDutyBusy(true);
    setDutyErr(null);
    setOnDuty(next);
    try {
      await agentApi.setDuty(next);
      // Re-sync from the server so the toggle reflects the authoritative
      // pool state (e.g. an on-mission agent can't actually go available).
      try {
        const {data} = await agentApi.getMe();
        setMe(data);
        setOnDuty(data.agent.on_duty);
      } catch { /* keep optimistic value */ }
    } catch {
      setOnDuty(!next);
      setDutyErr('Could not update duty status. Check your connection and try again.');
    } finally {
      setDutyBusy(false);
    }
  }, []);

  const toggleDuty = useCallback(() => {
    if (dutyBusy) {return;}
    const next = !onDuty;
    // Going OFF while mid-mission is ambiguous — ops still expects the agent
    // on the active detail. Confirm before committing (the backend keeps the
    // pool 'on_mission' regardless, but the agent should understand that).
    if (!next && missionActive) {
      Alert.alert(
        'Go off duty?',
        'You have an active mission. Going off duty stops new dispatches but does NOT release you from the current mission — ops still expects you on it.',
        [
          {text: 'Stay on duty', style: 'cancel'},
          {text: 'Go off duty', style: 'destructive', onPress: () => { void commitDuty(false); }},
        ],
      );
      return;
    }
    void commitDuty(next);
  }, [dutyBusy, onDuty, missionActive, commitDuty]);

  // ─── Derived values from real API ─────────────────────────────
  // B-90 T-10 — legacy agent rows have display_name NULL (create never sent
  // one); fall back to the signed-in user's real name before the generic label.
  const displayName = (me?.agent.display_name ?? user?.full_name ?? 'Agent').toUpperCase();
  const callSign    = me?.agent.call_sign ?? '—';
  const tier        = me?.agent.tier ?? 0;
  const initials    = pickInitials(displayName);
  const dutyHrs     = me?.agent.duty_hours_mtd ?? 0;
  const rate        = me?.agent.rate_aed_per_hour
    ? `${bcFromAed(Number(me!.agent.rate_aed_per_hour))} BC`
    : '—';
  // Prefer the ORG aggregate: `rating` is only ever written against the
  // provider user id (booking rating roll-up) and `jobs_total` counts crewed
  // missions for a CPO but completed bookings for the org — so a manager
  // reading /agents/me saw a null rating and their personal mission count
  // instead of the agency's. Falls back to the self row for a lone officer.
  const orgRating   = cap?.org_rating ?? null;
  const rating      = orgRating !== null ? orgRating.toFixed(2)
    : me?.agent.rating ? Number(me.agent.rating).toFixed(2) : '—';
  const jobsTotal   = cap ? cap.org_jobs_total : (me?.agent.jobs_total ?? 0);

  const activeCoverage = me?.profile.coverage?.countries
    ?.filter(c => c.on)
    .map(c => c.code)

    .join(' · ') || '—';

  const hasActiveJob = activeMission !== null;
  // pickup_address/dropoff_address are guaranteed safe strings here because
  // activeMission only ever comes from normalizeMission(). The `?? '—'` on
  // dropoff is just its nullable-by-design fallback.
  const activeRouteLabel = activeMission
    ? `${activeMission.pickup_address.split(',')[0].trim()} → ${(activeMission.dropoff_address ?? '—').split(',')[0].trim()}`
    : '';

  // ─── Nav rows (real destinations) ──────────────────────────────
  // A service-provider org (type 'company') manages a roster + applies as the
  // org, so it gets Roster / Attendance entry points instead of the solo-CPO's
  // personal Earnings-first layout. An individual CPO ('cpo') still gets their
  // own Attendance card.
  // A promoted manager's OWN agent record is still type 'cpo' (they were
  // seeded as a managed CPO before promotion) — treat them as isOrg too so
  // they see the org rows their permitted_modules gate below, not the solo
  // personal layout meant for an unaffiliated individual CPO.
  // isPromotedManager is SERVER-COMPUTED (`managed_org`, hoisted above),
  // because every client-side derivation of it has been wrong.
  // account_kind==='agency' && org (B-215) was false for the real thing: a
  // manager is a promoted CPO, so `agents.managed_by_org_id` is set and
  // ACCOUNT_KIND_SQL's deliberate cpo precedence pins account_kind='cpo'.
  // Verified against production — the manager reads {account_kind:'cpo',
  // org:'Agent Due'} and the OWNER reads {account_kind:'agency', org:null}, so
  // that test was false for BOTH and the manager kept landing on the solo-CPO
  // personal layout. Not `is_org_manager` either: true for the owner (B-210).
  const isOrg = me?.agent.type === 'company' || isPromotedManager;
  // B-215/B-216 — NEXT ON OPS compact preview for org accounts (owner/
  // manager): missions actually IN PROGRESS (needs_crew + active) so the
  // slot shows the agency's real live board instead of the personal-
  // mission empty state, which never applies to an org viewer (they
  // aren't personally crewed). Founder correction — a FINISHED mission is
  // not "next on ops"; it must NOT show here even when nothing is
  // currently running (falls through to the empty state instead). Capped
  // — this is a preview, not the full board; "View all" below routes to
  // the existing Missions screen, which does show finished missions.
  // Only a genuine promoted manager is filtered — the true owner always sees
  // every row. Founder rule: the owner decides, absolutely. A manager the
  // owner granted nothing (or never configured — the column defaults to NULL
  // and the server reports both as []) gets NO modules, not a consolation set.
  // There is deliberately no always-visible bypass: every row key is grantable
  // from Manager Permissions, so a hidden row is always the owner's choice and
  // is always one toggle away from coming back.
  const permittedModules = isPromotedManager
    ? new Set(user?.permitted_modules ?? [])
    : null;
  const canSee = (key: string) => !permittedModules || permittedModules.has(key);
  const ORG_OPS_PREVIEW_MAX = 4;
  // Gated by the SAME 'jobs' grant as the Missions row it previews — otherwise
  // revoking Missions would still leave the live board, client names and all,
  // on the manager's home screen.
  const orgOpsInProgress = orgMissions && canSee('jobs')
    ? [...orgMissions.needs_crew, ...orgMissions.active] : [];
  const orgOpsPreview: OrgMissionDto[] = orgOpsInProgress.slice(0, ORG_OPS_PREVIEW_MAX);
  const orgOpsPreviewMore = Math.max(0, orgOpsInProgress.length - orgOpsPreview.length);
  const navRows: {
    key: string; tint: keyof typeof NAV_TINT; icon: IconName;
    title: string; sub: string; badge?: string | null; locked?: boolean; onPress?: () => void;
    /** Founder drop 2026-08-31 - brand art behind the row. `row`-plated by the
     *  imagery pipeline so the subject sits to the RIGHT of the copy instead of
     *  being band-cropped out of a 4.8:1 box. */
    img?: ImageSourcePropType;
  }[] = [
    // Bug 5+6 — an agency/company is never itself crew, so its first card is the Missions board
    // (crew your accepted jobs), NOT a dead permanently-locked "Job Assigned" card. An individual
    // CPO keeps the Job-Assigned card: locked until ops crews them onto a mission (no self-serve
    // marketplace; `hasActiveJob` from /agents/me/active-mission unlocks it live on dispatch).
    isOrg
      ? {key: 'jobs', tint: 'amber', icon: 'shield-account-outline', title: 'Missions', sub: 'Crew & dispatch your accepted jobs', img: Imagery.agentMissions, onPress: () => navigateOnce(navigation, 'OrgMissions')}
      : hasActiveJob && activeMission
        ? {key: 'jobs', tint: 'amber', icon: 'shield-check', title: 'Job Assigned', sub: activeRouteLabel || 'Tap to open your assigned mission', badge: 'ASSIGNED', img: Imagery.agentMissions, onPress: () => navigateOnce(navigation, 'AgentLiveTracker', {missionId: activeMission.mission_id})}
        : {key: 'jobs', tint: 'amber', icon: 'lock-outline', title: 'Job Assigned', sub: 'Assigned when ops places you on a mission', img: Imagery.agentJobStandby, locked: true},
    ...(isOrg ? [
      // JOB_PORTAL_MARKETPLACE_SPEC Fix B — the open-jobs marketplace gets its own
      // top-level entry (it used to be buried at the bottom of the Missions board).
      {key: 'portal',     tint: 'amber'  as const, icon: 'briefcase-search-outline' as IconName, title: 'Job Portal', sub: 'Browse open jobs · first to accept wins', img: Imagery.agentJobPortal, onPress: () => navigateOnce(navigation, 'JobPortal')},
      {key: 'compliance', tint: 'signal' as const, icon: 'shield-check-outline'   as IconName, title: 'Compliance',     sub: 'Licence & insurance · get verified',   img: Imagery.agentCompliance, onPress: () => navigateOnce(navigation, 'OrgCompliance')},
      {key: 'roster',     tint: 'blue'   as const, icon: 'account-group-outline' as IconName, title: 'CPO Roster',     sub: 'Add & manage your officers',          img: Imagery.agentRoster, onPress: () => navigateOnce(navigation, 'OrgRoster')},
      {key: 'orgChart',   tint: 'blue'   as const, icon: 'sitemap-outline'      as IconName, title: 'Org Chart',      sub: 'Owner · managers · officers',         img: Imagery.agentOrgChart, onPress: () => navigateOnce(navigation, 'OrgHierarchy')},
    ] : []),
    // Dept Chat v2 (Step 19) — ONE "Departmental" entry → the dedicated 5-tab
    // module (Home · Channels · Attend · Incident · Vault). For a company/manager
    // it opens role-branched on the manager roots (Admin Attendance, Incident
    // Queue); for a member on the member roots (Attendance, Report Incident). This
    // replaces the old scattered attendance/incident/admin rows. Dark behind the
    // flag until rollout; the combined badge surfaces the most urgent cue.
    ...(DEPT_CHAT_V2 ? [
      {key: 'dept', tint: 'blue' as const, icon: 'office-building-outline' as IconName, title: 'Departmental',
        sub: canManage ? 'Attendance review · incidents · channels' : 'Attendance · report incident · channels',
        badge: deptBadges.adminAtt ?? deptBadges.incQueue ?? deptBadges.attendance,
        img: Imagery.agentDepartmental,
        // Land on the Channels tab (the channel LIST/dashboard) so a user with multiple
        // channels sees them all, instead of the Home tab's single announcement card.
        onPress: () => navigateOnce(navigation, 'Departmental', {screen: 'Channels'})},
    ] : []),
    {key: 'msg',    tint: 'signal', icon: 'message-text-outline',      title: 'Messenger',        sub: 'Secure comms · end-to-end encrypted', onPress: () => navigateOnce(navigation, 'MessengerHome')},
    {key: 'intel',  tint: 'red',    icon: 'newspaper-variant-outline', title: 'Bravo Feed',       sub: 'Security news · threat alerts', img: Imagery.agentIntelFeed, onPress: () => navigateOnce(navigation, 'IntelFeed')},
    isOrg
      ? {key: 'region', tint: 'blue' as const, icon: 'map-marker-radius-outline' as IconName, title: 'Region',
         sub: me?.agent.region_code ? `Operating in ${regionName(me.agent.region_code)} · tap to change` : 'Set your dispatch region · tap to choose',
         img: Imagery.agentRegion,
         onPress: () => navigateOnce(navigation, 'OrgRegion')}
      : {key: 'region', tint: 'blue' as const, icon: 'earth' as IconName, title: 'Coverage Regions', sub: `Active zone · ${activeCoverage}`, img: Imagery.agentRegion},
    // F6 — the org row now opens the org ROLL-UP (it used to reuse the
    // individual-CPO earnings screen, i.e. personal wallet + personal stats).
    {key: 'earn',   tint: 'blue',   icon: 'chart-line',                title: isOrg ? 'Org Earnings' : 'Earnings', sub: isOrg ? 'Consolidated payouts · escrow splits' : 'View your earnings history', img: Imagery.agentEarnings, onPress: () => navigateOnce(navigation, isOrg ? 'OrgEarnings' : 'Earnings')},
    // Owner-exclusive — grant/revoke each manager's dashboard modules. Never
    // shown to a promoted manager (only the true owner can reach this, D5),
    // and never itself subject to the permittedModules filter below.
    ...(isOrg && !isPromotedManager ? [
      {key: 'managerPerms', tint: 'blue' as const, icon: 'account-key-outline' as IconName, title: 'Manager Permissions',
        sub: 'Choose what each manager can access', img: Imagery.agentManagerPerms, onPress: () => navigateOnce(navigation, 'ManagerPermissions')},
    ] : []),
  ];

  // A promoted manager sees EXACTLY the modules the owner granted — no more,
  // and no baseline. Granted means full access, the same as the owner has for
  // that area. The owner's own dashboard is never filtered.
  const visibleNavRows = navRows.filter(r => canSee(r.key));

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={D.bg} />
      <View pointerEvents="none" style={s.ambient} />

      {/*
        Map warm-up for the CREW lane. MapPrewarm was only ever mounted on
        BookingHomeScreen (the client booking lane), so an agent/CPO never
        passed through it — their navigation map cold-loaded mapbox-gl.js,
        the CSS and the style JSON from the CDN on every single mission.
        Same shared assets, so warming here populates the exact cache the
        tracker needs. The one-attempt-per-session latch lives in the
        module, so mounting it in a second lane cannot double-run.
      */}
      <MapPrewarm />

      {/* ── Header ── */}
      <View style={s.header}>
        <View style={s.headerLeft}>
          <LinearGradient
            colors={[D.accent, D.accentDeep]}
            start={{x: 0, y: 0}} end={{x: 0, y: 1}}
            style={s.accentBar}
          />
          <Text style={s.headerTitle} numberOfLines={1}>
            {isPromotedManager ? 'Manager Dashboard' : 'Agent Dashboard'}
          </Text>
        </View>
        {/* N-18/GAP-3 — the durable-inbox bell, finally mounted. */}
        <ActivityBell onPress={() => navigateOnce(navigation, 'ActivityCenter')} />
        <TouchableOpacity onPress={openDrawer} activeOpacity={0.8} style={s.headerAvatarWrap}>
          {user?.avatar_url ? (
            <Image source={{uri: user.avatar_url}} style={s.headerAvatar} />
          ) : (
            <LinearGradient
              colors={[D.accent, D.accentDeep]}
              start={{x: 0.2, y: 0}} end={{x: 0.9, y: 1}}
              style={s.headerAvatar}>
              <Text style={s.headerAvatarText}>{initials}</Text>
            </LinearGradient>
          )}
          <View style={[s.headerDot, {backgroundColor: onDuty ? D.signal : D.textMute}]} />
        </TouchableOpacity>
      </View>

      {/* Mandatory location banner — shown until permission is granted */}
      {locStatus !== 'granted' && locStatus !== 'unknown' && (
        <TouchableOpacity
          style={s.locBanner}
          activeOpacity={0.85}
          onPress={() => {
            if (locStatus === 'blocked') {
              Alert.alert(
                'Location Blocked',
                'Location permission is permanently denied. Open Settings to re-enable it — this is required for missions.',
                [
                  {text: 'Cancel', style: 'cancel'},
                  {text: 'Open Settings', onPress: () => { void Linking.openSettings(); }},
                ],
              );
            } else {
              void (async () => {
                if (Platform.OS === 'android') {
                  const result = await PermissionsAndroid.request(
                    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
                    {
                      title:          'Location Required',
                      message:        'Your location is needed for mission dispatch and live tracking.',
                      buttonPositive: 'Allow',
                      buttonNegative: 'Not now',
                    },
                  );
                  if (result === PermissionsAndroid.RESULTS.GRANTED) {setLocStatus('granted');}
                  else if (result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) {setLocStatus('blocked');}
                } else {
                  const auth = await Geolocation.requestAuthorization('always');
                  if (auth === 'granted') {setLocStatus('granted');}
                }
              })();
            }
          }}>
          <Icon name="map-marker-alert" size={18} color={D.alert} />
          <View style={{flex: 1}}>
            <Text style={s.locTitle}>Location required</Text>
            <Text style={s.locSub}>
              {locStatus === 'blocked'
                ? 'Tap to open Settings and re-enable'
                : 'Tap to allow location access — needed for dispatch'}
            </Text>
          </View>
          <Icon name="chevron-right" size={16} color={D.alert} />
        </TouchableOpacity>
      )}

      <ScrollView
        style={{flex: 1}}
        contentContainerStyle={s.scroll}
        showsVerticalScrollIndicator={false}
        // Why: removeClippedSubviews defaults to true on Android. This screen
        // swaps conditional subtrees (NEXT ON OPS empty↔active, location banner,
        // duty error) inside the scroll body while the 8s active-mission poll
        // and async permission checks land during the first post-boot layout
        // passes. Under Fabric that races the clip/unclip pass and crashes
        // natively with "addViewAt: child already has a parent"
        // (ReactClippingViewManager.addView) — not JS-catchable. The list is
        // short, so disabling clipping has no perf cost and removes the race.
        removeClippedSubviews={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => { void onRefresh(); }} tintColor={D.accent} />
        }>

        {/* ── Profile / duty card ── */}
        <View style={s.dutyCard}>
      <ImageryBackdrop source={Imagery.cpoStandby} variant="hero" radius={22} />
          <View style={s.cardTopLight} />
          <View style={s.dutyRow}>
            {/* T-10 — duty-card avatar opens the same photo sheet as the
                drawer avatar so the upload path is actually discoverable. */}
            <TouchableOpacity
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel="Change profile photo"
              onPress={() => setPhotoSheet(true)}>
              {user?.avatar_url ? (
                <Image source={{uri: user.avatar_url}} style={s.dutyAvatar} />
              ) : (
                <LinearGradient
                  colors={[D.accent, D.accentDeep]}
                  start={{x: 0.2, y: 0}} end={{x: 0.9, y: 1}}
                  style={s.dutyAvatar}>
                  <Text style={s.dutyAvatarText}>{initials}</Text>
                </LinearGradient>
              )}
            </TouchableOpacity>
            <View style={{flex: 1, minWidth: 0}}>
              {/* Which org this account manages — a manager is a delegate, and
                  with several agencies on one device the name is the only way
                  to tell whose board you are looking at. */}
              <FitLine
                style={s.dutyKicker}
                floorScale={0.7}
                text={isPromotedManager && managedOrg?.name
                  ? `MANAGER · ${managedOrg.name.toUpperCase()}`
                  : isPromotedManager ? 'MANAGER' : 'PARTNER AGENT'}
              />
              <Text style={s.dutyName} numberOfLines={1}>
                {`${displayName} (${isPromotedManager ? 'Manager' : 'AGENT'})`}
              </Text>
              <View style={s.tierRow}>
                {tier > 0 && (
                  <View style={s.tierBadge}>
                    <Text style={s.tierText}>TIER {tier}</Text>
                  </View>
                )}
                <Text style={s.tierMeta}>{callSign}</Text>
              </View>
            </View>
            <View style={s.dutyToggleWrap}>
              <Text style={[s.dutyStatus, {color: onDuty ? D.signal : D.textMute}]}>
                {onDuty ? 'ON DUTY' : 'OFF DUTY'}
              </Text>
              <TouchableOpacity
                onPress={toggleDuty}
                disabled={dutyBusy}
                activeOpacity={0.85}
                style={[s.dutyTrack, onDuty ? s.dutyTrackOn : s.dutyTrackOff, dutyBusy && {opacity: 0.6}]}>
                {onDuty ? (
                  <LinearGradient
                    colors={['#4ADE80', '#22A85A']}
                    start={{x: 0, y: 0}} end={{x: 0, y: 1}}
                    style={StyleSheet.absoluteFill as never}
                  />
                ) : null}
                <View style={[s.dutyThumb, onDuty && s.dutyThumbOn]} />
              </TouchableOpacity>
            </View>
          </View>
          {dutyErr && (
            <View style={s.dutyErrRow}>
              <Icon name="alert-circle-outline" size={13} color={D.alert} />
              <Text style={s.dutyErrText}>{dutyErr}</Text>
            </View>
          )}
          {onDuty && (
            <View style={s.dutyErrRow}>
              <View style={[s.locDot, {backgroundColor: locatable ? D.signal : D.amber}]} />
              <Text style={[s.dutyErrText, {color: locatable ? D.textDim : D.amber}]}>
                {locatable
                  ? 'Locatable — you can receive jobs'
                  : 'Not receiving jobs — keep Bravo open with location on (availability pauses when the app is closed)'}
              </Text>
            </View>
          )}
        </View>

        {/* ── Stat tiles ── */}
        <View style={s.stats}>
          <Stat cap="Duty"   value={`${dutyHrs}`} unit="hrs" sub="This month" />
          <Stat cap="Rate"   value={rate}                    sub="Per hour" />
          <Stat cap="Rating" value={rating}      star        sub={`${jobsTotal} jobs`} />
        </View>

        {/* ── Next on Ops ── */}
        <Text style={s.sectionLabel}>NEXT ON OPS</Text>
        {/* Why: keep this slot a SINGLE stable host view. When the 8s poll
            flips activeMission, only the children inside swap — the slot's
            position/type in the ScrollView never changes, so Fabric never
            reparents the neighbouring scroll children (the native
            "child already has a parent" crash). Pairs with
            removeClippedSubviews={false} on the ScrollView. */}
        <View>
          {hasActiveJob && activeMission ? (
            <>
              <TouchableOpacity
                style={s.featured}
                activeOpacity={0.85}
                onPress={() => navigateOnce(navigation, 'AgentLiveTracker', {missionId: activeMission.mission_id})}>
                <View style={s.cardTopLight} />
                <View style={s.featuredIcon}>
                  <Icon name="shield-check" size={18} color={D.accentSoft} />
                </View>
                <View style={{flex: 1, minWidth: 0}}>
                  <Text style={s.featuredTitle} numberOfLines={1}>
                    {activeMission.short_code} · {activeMission.status}
                    {activeMission.is_lead ? ' · LEAD' : ''}
                  </Text>
                  <Text style={s.featuredSub} numberOfLines={1}>{activeRouteLabel}</Text>
                </View>
                <Icon name="chevron-right" size={15} color={D.textMute} />
              </TouchableOpacity>
              <View style={s.miniActions}>
                <TouchableOpacity
                  activeOpacity={0.85}
                  style={{flex: 1}}
                  onPress={() => navigateOnce(navigation, 'AgentLiveTracker', {missionId: activeMission.mission_id})}>
                  <LinearGradient
                    colors={['#6E9BF5', D.accent, D.accentDeep]}
                    locations={[0, 0.55, 1]}
                    start={{x: 0, y: 0}} end={{x: 0, y: 1}}
                    style={s.miniBtnPri}>
                    <Icon name="crosshairs-gps" size={14} color="#fff" />
                    <Text style={s.miniBtnTextPri}>TRACK</Text>
                  </LinearGradient>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[s.miniBtn, {flex: 1}]}
                  activeOpacity={0.85}
                  onPress={() => navigateOnce(navigation, 'MessengerHome')}>
                  <Icon name="message-text-outline" size={14} color={D.text} />
                  <Text style={s.miniBtnText}>COMMS</Text>
                </TouchableOpacity>
              </View>
            </>
          ) : isOrg && orgOpsPreview.length > 0 ? (
            <View style={{gap: 8}}>
              {orgOpsPreview.map(job => {
                const lead = job.crew.find(c => c.is_lead);
                const statusLabel = job.mission_status ?? job.booking_status;
                return (
                  <TouchableOpacity
                    key={job.booking_id}
                    style={s.opsRow}
                    activeOpacity={0.85}
                    onPress={() => navigateOnce(navigation, 'OrgMissionDetail', {job})}>
                    <View style={s.opsRowIcon}>
                      <Icon name={job.mission_status === 'SOS' ? 'alarm-light' : 'shield-account-outline'}
                        size={16} color={job.mission_status === 'SOS' ? D.alert : D.accentSoft} />
                    </View>
                    <View style={{flex: 1, minWidth: 0}}>
                      {/* B-215 — mission + lead + status on ONE line, per founder ask. */}
                      <Text style={s.opsRowText} numberOfLines={1}>
                        {job.short_code ?? job.service}
                        {lead ? ` · ${lead.call_sign ?? 'Lead'}` : job.crew.length > 0 ? ` · ${job.crew.length} crew` : ''}
                        {` · ${statusLabel}`}
                      </Text>
                    </View>
                    <Icon name="chevron-right" size={14} color={D.textMute} />
                  </TouchableOpacity>
                );
              })}
              {orgOpsPreviewMore > 0 && (
                <TouchableOpacity activeOpacity={0.85} onPress={() => navigateOnce(navigation, 'OrgMissions')} style={s.opsViewAll}>
                  <Text style={s.opsViewAllText}>View all missions ({orgOpsPreviewMore} more) →</Text>
                </TouchableOpacity>
              )}
            </View>
          ) : (
            <View style={s.emptyOps}>
              <View style={s.emptyOpsIcon}>
                <Icon name="shield-outline" size={24} color={D.textMute} />
              </View>
              <Text style={s.emptyOpsText}>No active mission</Text>
              <Text style={s.emptyOpsSub}>
                {isOrg ? 'Missions your agency runs will appear here' : "You'll see your job here once ops assigns you"}
              </Text>
            </View>
          )}
        </View>

        {/* Step 20 — live incoming-offer banner (org). The IncomingOfferWatcher auto-
            surfaces the full-screen interrupt; this is the manual re-entry if it was backed out. */}
        {isOrg && liveOffer && (
          <TouchableOpacity activeOpacity={0.9} onPress={() => navigateOnce(navigation, 'IncomingOffer', {offerId: liveOffer.offer_id})}
            style={{flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 8, padding: 14, borderRadius: 16,
              backgroundColor: 'rgba(245,199,107,0.10)', borderWidth: 1, borderColor: 'rgba(245,199,107,0.34)'}}>
            <Icon name="bell-ring" size={20} color={D.amber} />
            <View style={{flex: 1}}>
              <Text style={{fontFamily: D.fBold, fontSize: 14, color: D.text}}>Incoming detail</Text>
              <Text style={{fontFamily: D.fSans, fontSize: 12, color: D.textDim, marginTop: 1}}>{liveOffer.region_label} · tap to review</Text>
            </View>
            <Icon name="chevron-right" size={18} color={D.amber} />
          </TouchableOpacity>
        )}

        {/* Step 20 — agency capacity strip ("X of Y guards free"). */}
        {isOrg && cap && (
          <TouchableOpacity activeOpacity={0.85} onPress={() => navigateOnce(navigation, 'OrgMissions')}
            style={{flexDirection: 'row', marginTop: 8, padding: 14, borderRadius: 16,
              backgroundColor: 'rgba(255,255,255,0.025)', borderWidth: 1, borderColor: D.hair2}}>
            <CapStat value={`${cap.guards_free}/${cap.guards_total}`} label="GUARDS FREE" tint={cap.guards_free > 0 ? D.signal : D.amber} />
            <View style={{width: 1, backgroundColor: D.hair2, marginHorizontal: 4}} />
            <CapStat value={`${cap.guards_on_duty}`} label="ON DUTY" tint={D.accentSoft} />
            <View style={{width: 1, backgroundColor: D.hair2, marginHorizontal: 4}} />
            <CapStat value={`${cap.active_missions}`} label="ACTIVE" tint={D.accentSoft} />
          </TouchableOpacity>
        )}

        {/* ── Nav rows ── */}
        <View style={{gap: 10, marginTop: 6}}>
          {visibleNavRows.map(row => {
            const tint = NAV_TINT[row.tint];
            const tappable = !!row.onPress && !row.locked;
            return (
              <TouchableOpacity
                key={row.key}
                onPress={tappable ? row.onPress : undefined}
                disabled={!tappable}
                activeOpacity={tappable ? 0.85 : 1}
                style={[s.navRow, row.locked && s.navRowLocked]}>
                {!!row.img && <ImageryBackdrop source={row.img} variant="art" radius={17} />}
                <View style={s.cardTopLight} />
                <View style={[
                  s.navIcon,
                  {backgroundColor: tint.bg, borderColor: tint.bd},
                  row.locked && s.navIconLocked,
                ]}>
                  <Icon name={row.icon} size={22} color={row.locked ? D.textMute : tint.fg} />
                </View>
                {/* The art plate occupies the right ~40% of the row. The `art`
                    scrim is horizontal, so it does NOT protect copy that runs
                    that far — it protects the obsidian field on the LEFT. So the
                    copy column is bounded here instead: a long single-line sub
                    ellipsises before the artwork rather than sitting on it.
                    Only applied when the row actually has art. */}
                <View style={[{flex: 1, minWidth: 0}, !!row.img && s.navCopyInset]}>
                  <View style={s.navTitleRow}>
                    <Text style={s.navTitle} numberOfLines={1}>{row.title}</Text>
                    {row.badge && (
                      <View style={[s.navBadge, {backgroundColor: tint.bg, borderColor: tint.bd}]}>
                        <Text style={[s.navBadgeText, {color: tint.fg}]}>{row.badge}</Text>
                      </View>
                    )}
                  </View>
                  <Text style={s.navSub} numberOfLines={1}>{row.sub}</Text>
                </View>
                {row.locked
                  ? <Icon name="lock-outline" size={15} color={D.textFaint} />
                  : tappable && <Icon name="chevron-right" size={15} color={D.textMute} />}
              </TouchableOpacity>
            );
          })}
        </View>
      </ScrollView>

      {/* ── Profile / Settings Drawer ────────────────────────── */}
      <Modal visible={drawerOpen} transparent animationType="none" onRequestClose={closeDrawer} statusBarTranslucent>
        <View style={sd.overlay}>
          <TouchableWithoutFeedback onPress={closeDrawer}>
            <View style={StyleSheet.absoluteFill} />
          </TouchableWithoutFeedback>

          <Animated.View style={[sd.drawer, {transform: [{translateX: drawerSlide}]}]}>
            <View style={[sd.profile, {paddingTop: insets.top + 20}]}>
              <TouchableOpacity style={sd.avatarWrap} activeOpacity={0.85} onPress={() => setPhotoSheet(true)}>
                {user?.avatar_url ? (
                  <Image source={{uri: user.avatar_url}} style={sd.avatar} />
                ) : (
                  <LinearGradient
                    colors={[D.accent, D.accentDeep]}
                    start={{x: 0.2, y: 0}} end={{x: 0.9, y: 1}}
                    style={sd.avatar}>
                    <Text style={sd.avatarText}>{initials}</Text>
                  </LinearGradient>
                )}
                {picker.busy ? (
                  <View style={sd.avatarBusy}><ActivityIndicator color="#fff" /></View>
                ) : null}
                <View style={sd.cameraBadge}><Icon name="camera" size={11} color="#fff" /></View>
                <View style={[sd.dot, {backgroundColor: onDuty ? D.signal : D.textMute}]} />
              </TouchableOpacity>
              <View style={{flex: 1}}>
                <View style={sd.nameRow}>
                  <Text style={sd.name} numberOfLines={1}>{displayName}</Text>
                  {tier > 0 && (
                    <View style={sd.tierBadge}>
                      <Text style={sd.tierText}>T{tier}</Text>
                    </View>
                  )}
                </View>
                <Text style={sd.callSign}>{callSign}</Text>
                <View style={sd.statusRow}>
                  <View style={[sd.statusDot, {backgroundColor: onDuty ? D.signal : D.textMute}]} />
                  <Text style={[sd.statusText, {color: onDuty ? D.signal : D.textMute}]}>
                    {onDuty ? 'On Duty' : 'Off Duty'}
                  </Text>
                </View>
              </View>
            </View>

            <ScrollView style={sd.menu} showsVerticalScrollIndicator={false}>
              {AGENT_MENU.map(item => (
                <React.Fragment key={item.label}>
                  <TouchableOpacity
                    style={sd.menuItem}
                    activeOpacity={0.7}
                    onPress={() => handleMenuPress(item.label)}>
                    <View style={sd.menuLeft}>
                      <Icon name={item.icon} size={19} color={D.accentSoft} />
                      <Text style={sd.menuLabel} numberOfLines={1}>{item.label}</Text>
                    </View>
                    <Icon name="chevron-right" size={16} color={D.textMute} />
                  </TouchableOpacity>
                  {item.divider && <View style={sd.divider} />}
                </React.Fragment>
              ))}
            </ScrollView>

            <View style={[sd.bottom, {paddingBottom: insets.bottom + 8}]}>
              <TouchableOpacity
                style={sd.logout}
                activeOpacity={0.7}
                onPress={() => { closeDrawer(); setTimeout(() => { void signOut(); }, 300); }}>
                <Icon name="logout" size={19} color={D.alert} />
                <Text style={sd.logoutText}>Log Out</Text>
              </TouchableOpacity>
              <View style={sd.version}>
                <Text style={sd.versionStudio}>OmniDevX Studio</Text>
                <Text style={sd.versionNum}>v1.0.0</Text>
              </View>
            </View>
          </Animated.View>
        </View>
      </Modal>

      <AvatarPhotoSheet
        visible={photoSheet}
        onClose={() => setPhotoSheet(false)}
        hasPhoto={picker.hasPhoto}
        onLibrary={() => { void picker.pickFromLibrary(); }}
        onCamera={() => { void picker.takePhoto(); }}
        onRemove={() => { void picker.removePhoto(); }}
      />
    </View>
  );
}

function Stat({cap, value, unit, sub, star}: {
  cap: string; value: string; unit?: string; sub: string; star?: boolean;
}) {
  const dash = value === '—';
  return (
    <View style={s.stat}>
      <View style={s.cardTopLight} />
      <Text style={s.statCap}>{cap}</Text>
      <View style={s.statValRow}>
        <Text style={[s.statVal, dash && {color: D.textMute}]}>{value}</Text>
        {!dash && unit && <Text style={s.statUnit}>{unit}</Text>}
        {!dash && star && <Icon name="star" size={13} color={D.amber} style={{marginLeft: 2}} />}
      </View>
      <Text style={s.statSub}>{sub}</Text>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: D.bg, overflow: 'hidden'},
  ambient: {
    position: 'absolute', top: -100, alignSelf: 'center',
    width: 460, height: 270, borderRadius: 235,
    backgroundColor: 'rgba(91,141,239,0.08)',
  },
  scroll: {paddingHorizontal: 20, paddingTop: 16, paddingBottom: 32, gap: 16},

  cardTopLight: {position: 'absolute', top: 0, left: 16, right: 16, height: 1, backgroundColor: 'rgba(255,255,255,0.08)'},

  // Header
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingTop: 14, paddingBottom: 4,
  },
  headerLeft: {flexDirection: 'row', alignItems: 'center', gap: 11, flex: 1, minWidth: 0},
  accentBar: {width: 4, height: 22, borderRadius: 3},
  headerTitle: {fontFamily: D.fBold, fontSize: 19, letterSpacing: 0.4, color: D.text},
  headerAvatarWrap: {position: 'relative'},
  headerAvatar: {
    width: 42, height: 42, borderRadius: 21,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center', justifyContent: 'center',
  },
  headerAvatarText: {fontFamily: D.fBold, fontSize: 14, color: '#fff', letterSpacing: 0.4},
  headerDot: {
    position: 'absolute', bottom: 0, right: 0, width: 11, height: 11,
    borderRadius: 6, borderWidth: 2, borderColor: D.bg,
  },

  // Location banner
  locBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 11,
    marginHorizontal: 20, marginTop: 10,
    padding: 13, borderRadius: 14,
    backgroundColor: 'rgba(245,72,90,0.08)', borderWidth: 1, borderColor: 'rgba(245,72,90,0.36)',
  },
  locTitle: {fontFamily: D.fBold, fontSize: 12.5, color: '#F58B97', letterSpacing: 0.2},
  locSub: {fontFamily: D.fMono, fontSize: 9.5, color: D.textMute, marginTop: 2, letterSpacing: 0.3},

  // Duty card
  dutyCard: {
    position: 'relative', overflow: 'hidden', borderRadius: 22, padding: 18,
    backgroundColor: 'rgba(20,32,56,0.9)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.3)',
    shadowColor: '#14285A', shadowOpacity: 0.32, shadowRadius: 18, shadowOffset: {width: 0, height: 14}, elevation: 9,
  },
  dutyRow: {flexDirection: 'row', alignItems: 'center', gap: 14},
  dutyAvatar: {
    width: 56, height: 56, borderRadius: 16, flexShrink: 0,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center', justifyContent: 'center',
  },
  dutyAvatarText: {fontFamily: D.fBold, fontSize: 19, color: '#fff'},
  dutyKicker: {fontFamily: D.fMono, fontSize: 9, fontWeight: '700', letterSpacing: 2, color: D.textMute},
  dutyName: {fontFamily: D.fBold, fontSize: 21, letterSpacing: -0.3, color: D.text, marginTop: 4},
  tierRow: {flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 7},
  tierBadge: {
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6,
    backgroundColor: 'rgba(91,141,239,0.14)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.32)',
  },
  tierText: {fontFamily: D.fMono, fontSize: 9, fontWeight: '700', letterSpacing: 1, color: D.accentSoft},
  tierMeta: {fontFamily: D.fMono, fontSize: 9.5, fontWeight: '600', letterSpacing: 1, color: D.textMute},

  dutyToggleWrap: {alignItems: 'flex-end', gap: 9},
  dutyStatus: {fontFamily: D.fMono, fontSize: 9, fontWeight: '700', letterSpacing: 1.2},
  dutyTrack: {
    width: 50, height: 28, borderRadius: 999, overflow: 'hidden', justifyContent: 'center',
  },
  dutyTrackOn: {borderWidth: 1, borderColor: 'rgba(255,255,255,0.25)'},
  dutyTrackOff: {backgroundColor: 'rgba(255,255,255,0.1)', borderWidth: 1, borderColor: D.hair2},
  dutyThumb: {
    position: 'absolute', left: 2.5, width: 22, height: 22, borderRadius: 11, backgroundColor: '#fff',
    shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 5, shadowOffset: {width: 0, height: 2}, elevation: 3,
  },
  dutyThumbOn: {left: 24},
  dutyErrRow: {flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 13},
  locDot: {width: 8, height: 8, borderRadius: 4},
  dutyErrText: {flex: 1, fontFamily: D.fSans, fontSize: 11, color: D.alert, lineHeight: 15},

  // Stat tiles
  stats: {flexDirection: 'row', gap: 11},
  stat: {
    flex: 1, position: 'relative', overflow: 'hidden', paddingVertical: 14, paddingHorizontal: 12,
    borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair2,
    alignItems: 'center',
  },
  statCap: {fontFamily: D.fMono, fontSize: 8.5, fontWeight: '700', letterSpacing: 1.4, color: D.textMute, textTransform: 'uppercase'},
  statValRow: {flexDirection: 'row', alignItems: 'baseline', justifyContent: 'center', marginTop: 9},
  statVal: {fontFamily: D.fBold, fontSize: 22, letterSpacing: -0.5, color: D.text},
  statUnit: {fontFamily: D.fMono, fontSize: 10, fontWeight: '600', color: D.textDim, marginLeft: 3},
  statSub: {fontFamily: D.fSans, fontSize: 10.5, color: D.textMute, marginTop: 7},

  // Section label
  sectionLabel: {fontFamily: D.fMono, fontSize: 10, fontWeight: '600', letterSpacing: 2, color: D.textDim, marginLeft: 2, marginBottom: -6},

  // Featured (active mission)
  featured: {
    position: 'relative', overflow: 'hidden',
    flexDirection: 'row', alignItems: 'center', gap: 13, padding: 15, borderRadius: 18,
    backgroundColor: 'rgba(20,32,56,0.9)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.45)',
  },
  featuredIcon: {
    width: 44, height: 44, borderRadius: 13, flexShrink: 0,
    backgroundColor: 'rgba(91,141,239,0.16)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.4)',
    alignItems: 'center', justifyContent: 'center',
  },
  featuredTitle: {fontFamily: D.fBold, fontSize: 14, color: D.text, letterSpacing: -0.2},
  featuredSub: {fontFamily: D.fMono, fontSize: 10.5, color: D.textMute, marginTop: 3, letterSpacing: 0.3},

  miniActions: {flexDirection: 'row', gap: 10, marginTop: -6},
  miniBtnPri: {
    height: 44, borderRadius: 13, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
    shadowColor: D.accent, shadowOpacity: 0.4, shadowRadius: 16, shadowOffset: {width: 0, height: 8}, elevation: 6,
  },
  miniBtn: {
    height: 44, borderRadius: 13, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2,
  },
  miniBtnText: {fontFamily: D.fMono, fontSize: 10, fontWeight: '700', color: D.text, letterSpacing: 1},
  miniBtnTextPri: {fontFamily: D.fMono, fontSize: 10, fontWeight: '700', color: '#fff', letterSpacing: 1},

  // Empty ops
  emptyOps: {
    borderRadius: 20, paddingVertical: 30, paddingHorizontal: 20, alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.018)', borderWidth: 1.5, borderColor: D.hair2, borderStyle: 'dashed',
  },
  emptyOpsIcon: {
    width: 52, height: 52, borderRadius: 26,
    backgroundColor: 'rgba(91,141,239,0.08)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.24)',
    alignItems: 'center', justifyContent: 'center',
  },
  emptyOpsText: {fontFamily: D.fBold, fontSize: 17, letterSpacing: -0.2, color: D.text, marginTop: 14},
  emptyOpsSub: {fontFamily: D.fSans, fontSize: 12.5, color: D.textMute, marginTop: 6},

  // B-215 — NEXT ON OPS compact org-mission preview
  opsRow: {
    flexDirection: 'row', alignItems: 'center', gap: 11, padding: 12, borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.025)', borderWidth: 1, borderColor: D.hair2,
  },
  opsRowIcon: {
    width: 32, height: 32, borderRadius: 10, flexShrink: 0,
    backgroundColor: 'rgba(91,141,239,0.14)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.32)',
    alignItems: 'center', justifyContent: 'center',
  },
  opsRowText: {fontFamily: D.fSemi, fontSize: 12.5, color: D.text, letterSpacing: -0.1},
  opsViewAll: {alignItems: 'center', paddingVertical: 8},
  opsViewAllText: {fontFamily: D.fSemi, fontSize: 12, color: D.accentSoft},

  // Nav rows
  navRow: {
    position: 'relative', overflow: 'hidden',
    flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14, paddingHorizontal: 15,
    borderRadius: 17, backgroundColor: 'rgba(20,25,36,0.6)', borderWidth: 1, borderColor: D.hair,
  },
  navRowLocked: {opacity: 0.55},
  // Keeps the copy clear of the art plate (PLATE_MAX_W 0.40 + a 4.5% right
  // margin in scripts/optimize-imagery.py, less the plate's feathered left
  // edge, which is effectively obsidian).
  navCopyInset: {marginRight: '24%'},
  navIcon: {
    width: 46, height: 46, borderRadius: 13, flexShrink: 0, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
  },
  navIconLocked: {backgroundColor: 'rgba(255,255,255,0.03)', borderColor: D.hair2},
  navTitleRow: {flexDirection: 'row', alignItems: 'center', gap: 9},
  navTitle: {flexShrink: 1, minWidth: 0, fontFamily: D.fBold, fontSize: 15.5, letterSpacing: -0.2, color: D.text},
  navBadge: {flexShrink: 0, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999, borderWidth: 1},
  navBadgeText: {fontFamily: D.fMono, fontSize: 8.5, fontWeight: '700', letterSpacing: 0.8},
  navSub: {fontFamily: D.fSans, fontSize: 11.5, color: D.textMute, marginTop: 4, letterSpacing: -0.05},
}));

// ── Drawer styles (obsidian) ─────────────────────────────────────────────────
const sd = StyleSheet.create(scaleTextStyles({
  overlay: {flex: 1, flexDirection: 'row', backgroundColor: 'rgba(2,6,15,0.65)'},
  drawer: {
    width: '82%', maxWidth: 320, backgroundColor: '#0B0E14',
    borderRightWidth: 1, borderRightColor: D.hair2, flexDirection: 'column',
    shadowColor: '#000', shadowOffset: {width: 4, height: 0}, shadowOpacity: 0.55, shadowRadius: 24, elevation: 24,
  },
  profile: {
    paddingHorizontal: 20, paddingBottom: 20,
    borderBottomWidth: 1, borderBottomColor: D.hair2,
    flexDirection: 'row', alignItems: 'center', gap: 14,
  },
  avatarWrap: {position: 'relative'},
  avatar: {
    width: 56, height: 56, borderRadius: 28, borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center', justifyContent: 'center',
  },
  avatarText: {color: '#fff', fontSize: 18, fontFamily: D.fBold},
  avatarBusy: {...StyleSheet.absoluteFillObject, borderRadius: 28, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.45)'},
  cameraBadge: {
    position: 'absolute', top: -2, right: -2, width: 22, height: 22, borderRadius: 11,
    backgroundColor: D.accent, borderWidth: 2, borderColor: '#0B0E14', alignItems: 'center', justifyContent: 'center',
  },
  dot: {
    position: 'absolute', bottom: 1, right: 1, width: 13, height: 13,
    borderRadius: 7, borderWidth: 2, borderColor: '#0B0E14',
  },
  nameRow: {flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2},
  name: {color: D.text, fontSize: 14, fontFamily: D.fBold, flex: 1},
  callSign: {color: D.accentSoft, fontSize: 10, fontFamily: D.fMono, letterSpacing: 0.8, marginBottom: 4},
  tierBadge: {backgroundColor: 'rgba(91,141,239,0.18)', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1, borderWidth: 1, borderColor: 'rgba(91,141,239,0.34)'},
  tierText: {color: D.accentSoft, fontSize: 9, fontFamily: D.fBold, letterSpacing: 0.5},
  statusRow: {flexDirection: 'row', alignItems: 'center', gap: 5},
  statusDot: {width: 7, height: 7, borderRadius: 4},
  statusText: {fontSize: 11, fontFamily: D.fMono, letterSpacing: 0.4},

  menu: {flex: 1, paddingHorizontal: 16, paddingTop: 8},
  menuItem: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 46, paddingHorizontal: 12, borderRadius: 12},
  menuLeft: {flexDirection: 'row', alignItems: 'center', gap: 12},
  menuLabel: {color: D.text, fontSize: 13, fontFamily: D.fSemi},
  divider: {height: 1, backgroundColor: D.hair, marginVertical: 4, marginHorizontal: 12},

  bottom: {padding: 16, borderTopWidth: 1, borderTopColor: D.hair},
  logout: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 12, backgroundColor: 'rgba(245,72,90,0.08)'},
  logoutText: {color: D.alert, fontSize: 13, fontFamily: D.fBold},
  version: {alignItems: 'center', marginTop: 10, opacity: 0.4},
  versionStudio: {color: D.textMute, fontSize: 11, fontFamily: D.fSemi},
  versionNum: {color: D.textFaint, fontSize: 10},
}));
