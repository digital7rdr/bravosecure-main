'use client';

import {use, useState, useEffect, useCallback, useMemo, useRef} from 'react';
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {Shell} from '@/components/Shell';
import {BravoMap, type BravoMarker, type BravoRouteOption, type BravoMapStyleId} from '@/components/BravoMapLazy';
import {ApiError, useMissionDetail, useMissionMessages, useMissionTelemetry, opsApi, useOpsMe, type MissionStatus} from '@/lib/api';
import {canAbortMission, canCompleteMission, canReroute, canAckSos, canResolveSos} from '@/lib/rbac';
import {decodePolyline} from '@/lib/polyline';
import {formatTimeUtc, formatDateTimeShortUtc, formatDateTimeUtc} from '@/lib/datetime';
import {bookingServiceLabel} from '@/lib/format';
import {Redacted} from '@/components/Redacted';
import {CopyId} from '@/components/CopyId';
import {MissionGroupPanel} from '@/components/messenger/MissionGroupPanel';

type RouteOption = {
  key: string; distance_m: number; duration_s: number;
  polyline: string | null; is_current: boolean;
};

const ROUTE_COLORS = ['#5B8DEF', '#7ED321', '#FFC107'];

export default function MissionDetailPage({params}: {params: Promise<{id: string}>}) {
  const {id} = use(params);
  const router = useRouter();
  const {data, mutate, isLoading, error} = useMissionDetail(id);
  // Audit H4 — role for UI gating of destructive mission controls. Backend
  // @RequireRoles is the real gate; this just hides buttons an OPS-tier
  // admin can't use so they don't try-and-fail into a red 403 banner.
  const {data: me} = useOpsMe();
  const role = me?.admin.role;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Audit L2 — replace window.prompt (no validation, pollutes the audit
  // trail with empty/huge/newline reasons) with a styled, validated modal.
  // One modal drives both the abort reason and the SOS resolution note.
  const [reasonModal, setReasonModal] = useState<null | {
    kind: 'abort' | 'resolve';
    title: string;
    label: string;
    placeholder: string;
    minLen: number;
    confirmLabel: string;
    danger?: boolean;
  }>(null);
  const [reasonText, setReasonText] = useState('');

  // Route alternatives are now ALWAYS visible on the map — fetched on
  // mission load and re-fetched when the mission's polyline changes (i.e.
  // ops committed a new route). The RE-ROUTE button just toggles the
  // selection picker on/off; visibility no longer depends on it. This
  // matches the user's "show 2-3 possible routes from pickup to drop"
  // brief — the admin can see options at a glance without clicking.
  const [routePickerOpen, setRoutePickerOpen] = useState(false);
  const [routeOptions, setRouteOptions] = useState<RouteOption[] | null>(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [routeSelectedKey, setRouteSelectedKey] = useState<string | null>(null);
  const [routeSubmitting, setRouteSubmitting] = useState(false);

  const loadRouteOptions = useCallback(async () => {
    setRouteLoading(true);
    setRouteError(null);
    try {
      const res = await opsApi.getRouteOptions(id);
      setRouteOptions(res.options);
      const current = res.options.find(o => o.is_current);
      setRouteSelectedKey(current?.key ?? res.options[0]?.key ?? null);
    } catch (e) {
      setRouteError((e as Error).message || 'Failed to load route options');
    } finally {
      setRouteLoading(false);
    }
  }, [id]);

  // Auto-fetch on mount + on mission id change so a hot refresh after
  // dispatch shows the alternatives without a manual click.
  useEffect(() => { void loadRouteOptions(); }, [loadRouteOptions]);

  const openRoutePicker = useCallback(() => {
    setRoutePickerOpen(true);
    // If we already have options cached, keep them; otherwise refetch.
    if (!routeOptions) void loadRouteOptions();
  }, [routeOptions, loadRouteOptions]);

  const closeRoutePicker = useCallback(() => {
    setRoutePickerOpen(false);
    setRouteError(null);
    // Keep the loaded options + selection so the always-on overlay
    // remains visible on the map after the picker closes.
  }, []);

  const commitRouteSelection = useCallback(async () => {
    if (!routeOptions || !routeSelectedKey) return;
    const chosen = routeOptions.find(o => o.key === routeSelectedKey);
    if (!chosen?.polyline) {
      setRouteError('Selected route has no polyline (Mapbox token missing?)');
      return;
    }
    setRouteSubmitting(true);
    setRouteError(null);
    try {
      await opsApi.selectRoute(id, {
        polyline:   chosen.polyline,
        distance_m: chosen.distance_m,
        duration_s: chosen.duration_s,
      });
      await mutate();
      // Audit PAGE-05 — refetch the options so `is_current` reflects the
      // just-committed route (else the old option keeps its ACTIVE dot and
      // the new one still shows "→ DISPATCH", re-committable).
      await loadRouteOptions();
      closeRoutePicker();
    } catch (e) {
      setRouteError((e as Error).message || 'Failed to update route');
    } finally {
      setRouteSubmitting(false);
    }
  }, [id, routeOptions, routeSelectedKey, mutate, closeRoutePicker, loadRouteOptions]);

  // Per-mission deployment checks.
  type DeployRow = {user_id: string; check_key: string; state: string; signed_at: string | null};
  type CrewRow   = {agent_id: string; call_sign: string; role: string};
  const [deployData, setDeployData] = useState<{crew: CrewRow[]; checks: DeployRow[]} | null>(null);
  const [deployErr, setDeployErr] = useState<string | null>(null);
  const [deployBusy, setDeployBusy] = useState<string | null>(null);

  // CA-09 — one fetch per page-load left the checklist frozen while agents
  // signed off from their phones; and every failure read as "no checks yet".
  // Poll on the dashboard cadence and keep 404/no-checks (pane absent)
  // distinct from a fetch failure (small error line).
  const refreshDeploy = useCallback(async () => {
    try {
      setDeployData(await opsApi.getMissionDeployment(id));
      setDeployErr(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        setDeployData(null);
        setDeployErr(null);
      } else {
        setDeployErr((e as Error).message || 'deployment fetch failed');
      }
    }
  }, [id]);

  useEffect(() => {
    void refreshDeploy();
    const t = setInterval(() => { void refreshDeploy(); }, 5000);
    return () => clearInterval(t);
  }, [refreshDeploy]);

  const DEPLOY_LABELS: Record<string, string> = {
    dress: 'Dress Inspection', vehicle: 'Vehicle Collection',
    equip: 'Equipment Check',  briefing: 'Ops Briefing',
  };

  async function signoff(agentId: string, checkKey: string, state: 'passed' | 'failed') {
    const key = `${agentId}-${checkKey}`;
    setDeployBusy(key);
    try {
      await opsApi.signoffMissionDeploy(id, agentId, checkKey, state);
      await refreshDeploy();
    } catch (e) {
      // Audit PAGE-16 — actually surface the failure instead of silently
      // re-enabling the button with the check still "pending".
      setErr((e as Error).message);
    } finally { setDeployBusy(null); }
  }

  const m        = data?.mission;
  const booking  = data?.booking ?? null;
  const vehicle  = data?.vehicle ?? null;
  const status   = m?.status ?? 'LIVE';
  const isSos    = status === 'SOS';
  // Audit PAGE-01 — track the SOS that is not yet RESOLVED (not merely
  // un-acknowledged). The old `!acknowledged_at` selector made the
  // RESOLVE button — gated on `activeSos.acknowledged_at` — unreachable,
  // so an acknowledged SOS mission could never be resolved from here.
  const activeSos = data?.sos?.find(s => !s.resolved_at);

  const routeLabel = booking
    ? `${(booking.pickup_address ?? '—').split(',')[0].trim()} → ${(booking.dropoff_address ?? '—').split(',')[0].trim()}`
    : isLoading ? 'Loading…' : 'Route unavailable';

  // Live progress = (route_distance - current_to_dropoff) / route_distance.
  let progressPct: number | null = null;
  let routeKm: number | null = null;
  if (m?.route_distance_m && m.route_distance_m > 0) {
    routeKm = Math.round(m.route_distance_m / 100) / 10;
    const curLat = m.current_lat;
    const curLng = m.current_lng;
    const dropLat = Number(booking?.dropoff_lat);
    const dropLng = Number(booking?.dropoff_lng);
    // Audit fix — require every coord to be FINITE (not just non-null) so a
    // corrupt GPS fix (NaN) can't propagate into a "NaN%" progress bar.
    if (
      curLat != null && curLng != null &&
      Number.isFinite(curLat) && Number.isFinite(curLng) &&
      Number.isFinite(dropLat) && Number.isFinite(dropLng)
    ) {
      const φ1 = (curLat * Math.PI) / 180;
      const φ2 = (dropLat * Math.PI) / 180;
      const Δφ = ((dropLat - curLat) * Math.PI) / 180;
      const Δλ = ((dropLng - curLng) * Math.PI) / 180;
      const a  = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
      const distToDropoff = 2 * 6371000 * Math.asin(Math.sqrt(a));
      progressPct = Math.max(0, Math.min(100, Math.round(100 * (1 - distToDropoff / m.route_distance_m))));
    }
  }

  function abort() {
    // Audit L2 — open the validated reason modal instead of window.prompt.
    setReasonText('');
    setReasonModal({
      kind: 'abort',
      title: `Abort mission ${m?.short_code ?? id.slice(0, 8)}?`,
      label: 'Reason for aborting (required, min 8 chars)',
      placeholder: 'e.g. severe weather — route unsafe, standing down crew',
      minLen: 8,
      confirmLabel: 'ABORT MISSION',
      danger: true,
    });
  }

  // Audit L2 — single submit path for the validated reason modal. Trims +
  // length-checks before firing, so the audit trail can't be polluted with
  // empty or junk reasons.
  async function submitReason() {
    const modal = reasonModal;
    if (!modal) return;
    const text = reasonText.trim();
    if (text.length < modal.minLen) {
      setErr(`Please enter at least ${modal.minLen} characters.`);
      return;
    }
    setBusy(true); setErr(null);
    try {
      if (modal.kind === 'abort') {
        await opsApi.abortMission(id, text);
        setReasonModal(null);
        await mutate();
        router.push('/live');
        return;
      }
      // resolve
      if (activeSos) {
        await opsApi.resolveSos(activeSos.id, text);
      }
      setReasonModal(null);
      await mutate();
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  }

  // In-place mission completion. Calls the booking's complete endpoint
  // with no payout overrides → even-split mode. The page stays mounted
  // and SWR.mutate() refetches the mission detail so the status badge,
  // pill colour, and route polyline all flip to COMPLETED automatically
  // — no manual refresh, no navigation away. For partial payouts /
  // deduction reasons, ops still uses /bookings/[id] which has the full
  // payout review modal. The confirm dialog gives ops a back-out before
  // the irreversible payout fires.
  async function completeMission() {
    if (!booking) return;
    if (typeof window !== 'undefined' &&
        !window.confirm(
          `Close this mission and pay out the team?\n\n` +
          `Mission: ${m?.short_code ?? id.slice(0, 8)}\n` +
          `Escrow:  ${Math.round(Number(booking.total_eur))} BC → split evenly across crew.\n\n` +
          `For partial payouts or deductions, use the booking page instead.`,
        )) {
      return;
    }
    setBusy(true); setErr(null);
    try {
      await opsApi.completeBooking(booking.id);
      await mutate();
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  }

  async function ackSos() {
    if (!activeSos) return;
    setBusy(true); setErr(null);
    try {
      await opsApi.ackSos(activeSos.id);
      await mutate();
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  }

  function resolveSos() {
    if (!activeSos) return;
    // Audit L2 — validated modal instead of window.prompt.
    setReasonText('');
    setReasonModal({
      kind: 'resolve',
      title: 'Resolve SOS',
      label: 'Resolution note (required, min 4 chars)',
      placeholder: 'e.g. false alarm — tail was unrelated, principal safe',
      minLen: 4,
      confirmLabel: 'RESOLVE SOS',
    });
  }

  // Map markers from real booking coords + live mission position.
  const leadCallSign = data?.crew.find(c => c.is_lead)?.call_sign ?? 'CPO LEAD';
  const principalName = data?.principals[0]?.display_name ?? 'PRINCIPAL';
  const pickupLat  = booking?.pickup_lat  ? Number(booking.pickup_lat)  : null;
  const pickupLng  = booking?.pickup_lng  ? Number(booking.pickup_lng)  : null;
  const dropoffLat = booking?.dropoff_lat ? Number(booking.dropoff_lat) : null;
  const dropoffLng = booking?.dropoff_lng ? Number(booking.dropoff_lng) : null;

  const hasCpoFix       = m?.current_lat != null && m?.current_lng != null;
  const hasPrincipalFix = m?.client_lat  != null && m?.client_lng  != null;

  // B-89 MG-15 — lost-signal staleness: missions.updated_at is bumped on
  // every CPO telemetry push, so its age on an ACTIVE mission means the
  // feed stopped. >90 s = warn badge, >5 min = treat the marker as stale.
  // The 15 s tick is LOAD-BEARING: a stopped feed means SWR's payload stops
  // changing, so nothing else re-renders — exactly the case the badge is
  // for (review M-1; the mobile screen uses the same pattern).
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  // CA-15 — server-vs-client clock offset. A sample is only trusted when
  // updated_at CHANGES between polls (a telemetry write just landed, so
  // updated_at ≈ server "now" at receipt and the difference ≈ skew); the
  // first payload is never sampled, so a mission stale from the start
  // can't poison the estimate. Max over samples converges on the real
  // skew (each sample is skew minus up-to-one poll interval). Without
  // this, a client clock minutes fast badged healthy missions LOST
  // SIGNAL, and a slow one masked real losses.
  const clockSkewMs = useRef<number | null>(null);
  const prevUpdatedAt = useRef<string | null>(null);
  useEffect(() => {
    if (!m?.updated_at) return;
    if (prevUpdatedAt.current !== null && prevUpdatedAt.current !== m.updated_at) {
      const sample = Date.parse(m.updated_at) - Date.now();
      if (clockSkewMs.current === null || sample > clockSkewMs.current) {
        clockSkewMs.current = sample;
      }
    }
    prevUpdatedAt.current = m.updated_at;
  }, [m?.updated_at]);
  const activeStatuses = new Set(['DISPATCHED', 'PICKUP', 'LIVE', 'SOS']);
  const fixAgeSec = hasCpoFix && m?.updated_at && activeStatuses.has(m.status)
    ? Math.max(0, Math.round((nowTick + (clockSkewMs.current ?? 0) - Date.parse(m.updated_at)) / 1000))
    : null;
  const signalStale = fixAgeSec !== null && fixAgeSec > 90;
  const signalLost  = fixAgeSec !== null && fixAgeSec > 300;
  const staleLabel = fixAgeSec === null ? ''
    : fixAgeSec >= 3600 ? `${Math.floor(fixAgeSec / 3600)}h`
    : fixAgeSec >= 60 ? `${Math.floor(fixAgeSec / 60)}m`
    : `${fixAgeSec}s`;

  const markers: BravoMarker[] = [];
  if (pickupLat != null && pickupLng != null) {
    markers.push({id:'pick', lat:pickupLat, lng:pickupLng, label:'A · PICKUP', type:'pickup'});
  }
  if (dropoffLat != null && dropoffLng != null) {
    markers.push({id:'drop', lat:dropoffLat, lng:dropoffLng, label:'B · DROPOFF', type:'dropoff'});
  }
  // CPO LEAD — real position when telemetry is flowing; staged at pickup
  // with a "standby" style otherwise so ops can see who/where is expected.
  if (hasCpoFix) {
    markers.push({
      id: 'cpo-' + m!.id,
      lat: m!.current_lat!, lng: m!.current_lng!,
      // MG-15 — a LIVE mission on minutes-old data must not render as a
      // confident live dot: badge the age, grey the marker once lost.
      label: signalStale
        ? `${leadCallSign} · LOST SIGNAL ${staleLabel}`
        : `${leadCallSign} · ${m!.status}`,
      type: m!.status === 'SOS' ? 'sos' : signalLost ? 'standby' : 'lead',
    });
  } else if (pickupLat != null && pickupLng != null) {
    markers.push({
      id: 'cpo-stage',
      lat: pickupLat + 0.0006, lng: pickupLng + 0.0006,
      label: `${leadCallSign} · AWAITING GPS`,
      type: 'standby',
    });
  }
  // PRINCIPAL — only real if client app pushed; otherwise stage at pickup.
  if (hasPrincipalFix) {
    markers.push({
      id: 'pri',
      lat: m!.client_lat!, lng: m!.client_lng!,
      label: `${principalName} · LIVE`,
      type: 'principal',
    });
  } else if (pickupLat != null && pickupLng != null) {
    markers.push({
      id: 'pri-stage',
      lat: pickupLat - 0.0006, lng: pickupLng - 0.0006,
      label: `${principalName} · AWAITING GPS`,
      type: 'standby',
    });
  }

  // Decode the precomputed Mapbox Directions polyline (set at dispatch in
  // ops.service.ts via MapboxDirectionsService). Empty array → BravoMap
  // simply skips the route layer. Memoized so the 2s SWR poll doesn't hand
  // BravoMap a fresh array every render.
  const route = useMemo(
    () => (m?.route_polyline ? decodePolyline(m.route_polyline) : []),
    [m?.route_polyline],
  );

  // Alternative routes overlay — now ALWAYS visible whenever options are
  // loaded, so the admin can compare paths at a glance. Click-to-select
  // is only wired when the picker is open (otherwise clicks are no-ops).
  // Memoized so BravoMap's alt-route layers aren't torn down + rebuilt on
  // every poll re-render.
  const altRoutes: BravoRouteOption[] | undefined = useMemo(() => routeOptions
    ? routeOptions
        .filter(o => o.polyline)
        .map((o, i) => ({
          key:      o.key,
          coords:   decodePolyline(o.polyline as string),
          color:    ROUTE_COLORS[i] ?? '#A9C5FF',
          selected: o.key === routeSelectedKey,
          onClick:  routePickerOpen ? () => setRouteSelectedKey(o.key) : undefined,
        }))
    : undefined, [routeOptions, routeSelectedKey, routePickerOpen]);

  // Map style cycler — Dark / Streets / Satellite. Mirrors the mobile
  // location-picker FAB so ops can switch to "street view" (the standard
  // road map) or imagery without leaving the live page.
  const [mapStyleId, setMapStyleId] = useState<BravoMapStyleId>('dark');
  const cycleMapStyle = useCallback(() => {
    setMapStyleId(prev =>
      prev === 'dark' ? 'light' : prev === 'light' ? 'streets' : prev === 'streets' ? 'satellite' : 'dark',
    );
  }, []);

  // OC-11 — telemetry breadcrumb overlay. useMissionTelemetry existed since
  // the DC-16 pass but had no consumer; the TRAIL toggle draws the recorded
  // GPS track over the map. Fetch is lazy (null key while off) so the page
  // costs nothing until an operator asks for it.
  const [showTrail, setShowTrail] = useState(false);
  const {data: telemetry} = useMissionTelemetry(showTrail ? id : null);
  const trailOption: BravoRouteOption | null = useMemo(() => {
    const pts = telemetry?.points ?? [];
    if (!showTrail || pts.length < 2) return null;
    return {
      key: 'telemetry-trail',
      coords: pts.map(pt => [pt.lng, pt.lat] as [number, number]),
      color: 'rgba(91,141,239,0.55)',
    };
  }, [showTrail, telemetry]);

  // Map center. Audit PAGE-06 — frame the mission ONCE when the first real
  // position is known, then never recenter on subsequent GPS polls. The
  // live marker keeps moving (via the `markers` prop) but the camera stays
  // put, so the operator can pan/zoom to inspect without being yanked back
  // (and zoom reset) every ~2s. Re-frames when the mission id changes.
  const [mapCenter, setMapCenter] = useState<[number, number]>([55.17, 25.12]);
  const centeredForId = useRef<string | null>(null);
  useEffect(() => {
    if (centeredForId.current === id) return;
    const lng = m?.current_lng ?? (booking?.pickup_lng != null ? Number(booking.pickup_lng) : null);
    const lat = m?.current_lat ?? (booking?.pickup_lat != null ? Number(booking.pickup_lat) : null);
    if (lat != null && lng != null && Number.isFinite(lat) && Number.isFinite(lng)) {
      setMapCenter([lng, lat]);
      centeredForId.current = id;
    }
  }, [id, m?.current_lat, m?.current_lng, booking?.pickup_lat, booking?.pickup_lng]);

  const principals = data?.principals ?? [];
  const crew       = data?.crew ?? [];
  const waypoints  = data?.waypoints ?? [];
  const audit      = data?.audit ?? [];
  // Executive Protection — no waypoints; the lead's hourly "all smooth" record instead.
  // CA-07/SK-09 — fields are on MissionDetail now; the inline casts are gone.
  const isExec = booking?.service === 'executive_protection';
  const execDuration = Number(booking?.duration_hours ?? 0);
  const hourlyCheckins = data?.hourly_checkins ?? [];

  return (
    <Shell>
      {/* Page heading */}
      <div className="page-head" style={{marginBottom:12}}>
        <div>
          <div className="page-crumbs">Ops · Live Ops · Mission {m?.short_code ?? id}</div>
          <h2 style={{display:'flex', alignItems:'center', gap:10}}>
            Mission <span className="mono" style={{color:'var(--acc)'}}>{m?.short_code ?? id.slice(0,8).toUpperCase()}<CopyId value={id} title="Copy mission id" /></span>
            <span className={`pill ${isSos ? 'pill-err pill-live' : `pill-${statusPill(status)}`}`}>
              ● {isLoading
                  ? 'LOADING'
                  : error && !m
                    ? 'UNKNOWN'  /* Audit PAGE-12 — don't show LIVE for a mission that failed to load */
                    : isSos
                      ? 'LIVE · SOS'
                      : status /* COMPLETED / ABORTED / LIVE / DISPATCHED / PICKUP */}
            </span>
          </h2>
        </div>
        <div className="page-head-right">
          <Link href="/live" className="btn btn-ghost">← BACK</Link>
          {/* Audit H4 — RE-ROUTE gated by role + non-terminal status. */}
          {canReroute(role) && (
            <button
              className="btn btn-sec"
              onClick={routePickerOpen ? closeRoutePicker : openRoutePicker}
              disabled={status === 'COMPLETED' || status === 'ABORTED'}>
              {routePickerOpen ? 'CLOSE PICKER' : 'RE-ROUTE'}
            </button>
          )}
          {isSos && activeSos && !activeSos.acknowledged_at && canAckSos(role) && (
            <button className="btn" style={{background:'var(--warn)', color:'#3B2D00', fontWeight:800, border:'none'}} disabled={busy} onClick={ackSos}>
              ACK SOS
            </button>
          )}
          {isSos && activeSos && activeSos.acknowledged_at && canResolveSos(role) && (
            <button className="btn btn-sec" disabled={busy} onClick={resolveSos}>
              RESOLVE SOS
            </button>
          )}
          {(status === 'LIVE' || status === 'PICKUP' || status === 'DISPATCHED') && booking && canCompleteMission(role) && (
            <button
              onClick={completeMission}
              disabled={busy}
              className="btn btn-ok"
              style={{fontWeight:800, border:'none'}}
              title="Close mission and even-split the escrow. For deductions, use the booking page.">
              {busy ? 'CLOSING…' : 'END MISSION → PAYOUT'}
            </button>
          )}
          {/* When ops needs partial payouts / deduction reasons, fall through
              to the booking page's full review modal. Hidden during the
              first second of busy so the buttons don't shimmy. */}
          {(status === 'LIVE' || status === 'PICKUP' || status === 'DISPATCHED') && booking && !busy && canCompleteMission(role) && (
            <Link
              href={`/bookings/${booking.id}`}
              className="btn btn-ghost"
              style={{fontSize:10, letterSpacing:1, fontWeight:700}}
              title="Open the booking page to dock pay or review crew payouts individually.">
              REVIEW PAYOUTS
            </Link>
          )}
          {/* Audit H4 — ABORT now (a) only renders for a non-terminal
              mission, so it can't be clicked on an already-COMPLETED/ABORTED
              one, and (b) is gated by role. Backend still enforces both. */}
          {m && status !== 'COMPLETED' && status !== 'ABORTED' && canAbortMission(role) && (
            <button
              className="btn"
              style={{background:'var(--err)', color:'#fff', fontWeight:800, border:'none'}}
              disabled={busy}
              onClick={abort}>
              {busy ? '…' : 'ABORT MISSION'}
            </button>
          )}
        </div>
      </div>

      {/* Audit PAGE-12 — a failed mission fetch must not read as a healthy
          live mission; surface it distinctly instead of the default LIVE pill. */}
      {error && !m && !isLoading && (
        <div style={{padding:'10px 14px', background:'rgba(220,38,38,0.1)', border:'1px solid var(--err)', borderRadius:8, color:'#FFB4B4', marginBottom:12, fontFamily:'JetBrains Mono', fontSize:11}}>
          API ERROR · failed to load mission — {(error as Error).message}. <button onClick={() => void mutate()} style={{background:'none',border:'none',color:'var(--glow)',cursor:'pointer',textDecoration:'underline',padding:0,font:'inherit'}}>Retry</button>
        </div>
      )}
      {err && (
        <div style={{padding:'10px 14px', background:'rgba(220,38,38,0.1)', border:'1px solid var(--err)', borderRadius:8, color:'#FFB4B4', marginBottom:12, fontFamily:'JetBrains Mono', fontSize:11}}>
          API ERROR · {err}
        </div>
      )}

      <div style={{display:'grid', gridTemplateColumns:'320px 1fr 340px', gap:16, flex:1, minHeight:0, overflow:'hidden'}}>

        {/* ── LEFT ── */}
        <div style={{display:'flex', flexDirection:'column', gap:12, overflowY:'auto', minHeight:0, height:'100%', paddingBottom:4}}>
          {/* Hero */}
          <div className="card" style={{padding:16, background:'linear-gradient(180deg,rgba(91,141,239,0.12),var(--surf-2))', border:'1px solid var(--act)'}}>
            <div style={{fontFamily:'JetBrains Mono', fontSize:11, color:'var(--glow)', letterSpacing:1.5, fontWeight:700}}>
              {m?.short_code ?? 'MSN-…'} · {(booking?.id ?? m?.booking_id)?.slice(-12).toUpperCase() ?? '—'}
            </div>
            <div style={{fontFamily:'Manrope', fontSize:18, fontWeight:800, letterSpacing:-0.2, marginTop:6, lineHeight:1.2}}>
              {routeLabel}
            </div>
            <div style={{display:'flex', gap:6, marginTop:10, flexWrap:'wrap'}}>
              <span className="pill pill-live">● {status}</span>
              {isSos && activeSos && <span className="pill pill-warn">SOS {formatDateTimeShortUtc(activeSos.triggered_at)}</span>}
              {booking && <span className="pill pill-info">{booking.region_label}</span>}
              <span className="pill">{crew.length} CREW</span>
              {booking && <span className="pill">{booking.cpo_count}× CPO · {booking.vehicle_count}× VEH</span>}
            </div>
          </div>

          {/* Client */}
          {booking && (
            <Pane title="Client">
              <div style={{padding:'12px 14px', display:'flex', alignItems:'center', gap:12}}>
                <div style={{width:38,height:38,borderRadius:10,background:'linear-gradient(135deg,var(--acc),var(--act))',display:'flex',alignItems:'center',justifyContent:'center',fontFamily:'Manrope',fontWeight:800,color:'#fff',fontSize:13}}>
                  {(booking.client_display_name ?? '?').slice(0,2).toUpperCase()}
                </div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontFamily:'Manrope',fontWeight:800,fontSize:14,color:'var(--tx-1)'}}>
                    {booking.client_display_name ?? '—'}
                  </div>
                  {/* Audit PAGE-15 — mask client contact with a reveal-audit
                      trail (was plaintext + unaudited here). */}
                  <div style={{fontFamily:'JetBrains Mono',fontSize:10,color:'var(--tx-3)',marginTop:2,letterSpacing:0.5}}>
                    <Redacted value={booking.client_email} kind="email" subject={id} />
                    {booking.client_phone ? <> · <Redacted value={booking.client_phone} kind="phone" subject={id} /></> : ''}
                  </div>
                </div>
              </div>
              <div style={{padding:'10px 14px', display:'grid', gridTemplateColumns:'80px 1fr', gap:6, borderTop:'1px solid var(--bd-2)', fontFamily:'JetBrains Mono', fontSize:10.5}}>
                <span style={{color:'var(--tx-3)',letterSpacing:1.2,fontWeight:700,textTransform:'uppercase'}}>Pickup</span>
                <span style={{color:'var(--tx-1)'}}>{booking.pickup_address}</span>
                <span style={{color:'var(--tx-3)',letterSpacing:1.2,fontWeight:700,textTransform:'uppercase'}}>Dropoff</span>
                <span style={{color:'var(--tx-1)'}}>{booking.dropoff_address ?? '—'}</span>
                <span style={{color:'var(--tx-3)',letterSpacing:1.2,fontWeight:700,textTransform:'uppercase'}}>Service</span>
                <span style={{color:'var(--tx-1)'}}>{bookingServiceLabel(booking.service)}</span>
                <span style={{color:'var(--tx-3)',letterSpacing:1.2,fontWeight:700,textTransform:'uppercase'}}>Pickup Time</span>
                <span style={{color:'var(--tx-1)'}}>{formatDateTimeUtc(booking.pickup_time)}</span>
                <span style={{color:'var(--tx-3)',letterSpacing:1.2,fontWeight:700,textTransform:'uppercase'}}>Total</span>
                <span style={{color:'var(--acc)',fontWeight:700}}>{Number(booking.total_eur).toLocaleString()} BC</span>
              </div>
            </Pane>
          )}

          {/* Dress instructions */}
          {booking?.dress_instructions && (
            <Pane title="Dress Instructions">
              <div style={{padding:'12px 14px', fontFamily:'Manrope', fontSize:12.5, color:'var(--tx-1)', lineHeight:1.5, whiteSpace:'pre-wrap'}}>
                {booking.dress_instructions}
              </div>
            </Pane>
          )}

          {/* Principals */}
          {principals.length > 0 && (
            <Pane title={`Principals · VIP · ${principals.length}`}>
              {principals.map((p, i) => (
                <div key={i} className="person">
                  <div className="person-av" style={{background:'linear-gradient(135deg,#8FB0F7,#A9C5FF)', color:'#07090D'}}>
                    {initials(p.display_name)}
                    <span className="person-av-status status-ok"/>
                  </div>
                  <div style={{flex:1}}>
                    <div className="person-name">{p.display_name}</div>
                    <div className="person-sub">{p.sub_label ?? 'ONBOARD'}</div>
                  </div>
                  <div className="person-right">
                    {p.phone ?? '—'}
                  </div>
                </div>
              ))}
            </Pane>
          )}

          {/* Crew */}
          <Pane title={`Crew Roster · Assigned · ${crew.length}`}>
            {crew.length === 0 ? (
              <div style={{padding:'14px 14px', color:'var(--tx-3)', fontFamily:'JetBrains Mono', fontSize:11}}>
                No crew assigned yet.
              </div>
            ) : crew.map(c => (
              <div
                key={c.agent_id + c.call_sign}
                className="person"
                style={c.is_lead ? {borderLeft:'3px solid var(--act)', background:'rgba(91,141,239,0.04)'} : undefined}>
                <div className="person-av" style={{
                  background: c.is_lead
                    ? 'linear-gradient(135deg,var(--act),var(--acc))'
                    : 'linear-gradient(135deg,var(--act-dim),var(--act))',
                }}>
                  {c.call_sign.slice(-2)}
                  <span className={`person-av-status status-${c.status === 'sos' ? 'warn' : 'ok'}`}/>
                </div>
                <div style={{flex:1}}>
                  <div className="person-name">
                    {c.is_lead && <span style={{color:'var(--act)', fontWeight:800, marginRight:6}}>★</span>}
                    {c.call_sign}
                  </div>
                  <div className="person-sub">
                    {c.is_lead ? 'TEAM LEAD' : c.role} · {c.armed ? 'ARMED' : 'UNARMED'}
                  </div>
                </div>
                <div className="person-right">
                  CH {c.comms_ch}
                  <div style={{color:'var(--tx-3)', fontSize:9, marginTop:2}}>{c.mic_hot ? 'MIC HOT' : 'ACTIVE'}</div>
                </div>
              </div>
            ))}
          </Pane>

          {/* Pre-Departure Deployment Checklist */}
          {deployErr && (
            <div style={{padding:'8px 12px', border:'1px solid var(--err)', borderRadius:8, color:'#FFB4B4', fontFamily:'JetBrains Mono', fontSize:10}}>
              Deployment checklist unavailable · {deployErr}
            </div>
          )}
          {deployData && deployData.crew.length > 0 && (
            <Pane title={`Pre-Departure Checklist · ${deployData.checks.filter(c=>c.state==='passed').length}/${deployData.checks.length} Passed`}>
              {deployData.crew.map(agent => {
                const agentChecks = deployData.checks.filter(c => c.user_id === agent.agent_id);
                const allPassed   = agentChecks.every(c => c.state === 'passed');
                return (
                  <div key={agent.agent_id} style={{borderBottom:'1px solid var(--bd-2)', padding:'10px 14px'}}>
                    <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8}}>
                      <div style={{fontFamily:'JetBrains Mono', fontSize:10, color:'var(--acc)', fontWeight:700, letterSpacing:0.8}}>
                        {agent.call_sign} · {agent.role}
                      </div>
                      {allPassed && <span style={{fontFamily:'JetBrains Mono', fontSize:9, color:'var(--ok)', fontWeight:700}}>✓ CLEARED</span>}
                    </div>
                    <div style={{display:'flex', flexDirection:'column', gap:6}}>
                      {(['dress','vehicle','equip','briefing'] as const).map(key => {
                        const chk = agentChecks.find(c => c.check_key === key);
                        const st  = chk?.state ?? 'pending';
                        const bk  = `${agent.agent_id}-${key}`;
                        return (
                          <div key={key} style={{display:'flex', alignItems:'center', gap:8}}>
                            <div style={{flex:1, fontFamily:'JetBrains Mono', fontSize:9.5,
                              color: st==='passed' ? 'var(--ok)' : st==='failed' ? 'var(--err)' : 'var(--tx-2)',
                              letterSpacing:0.5}}>
                              {st === 'passed' ? '✓' : st === 'failed' ? '✗' : '○'} {DEPLOY_LABELS[key]}
                            </div>
                            {st === 'pending' && (
                              <div style={{display:'flex', gap:4}}>
                                <button className="btn btn-sm btn-ok" disabled={deployBusy === bk}
                                  style={{fontSize:8, padding:'2px 7px'}}
                                  onClick={() => signoff(agent.agent_id, key, 'passed')}>
                                  {deployBusy === bk ? '…' : 'PASS'}
                                </button>
                                <button className="btn btn-sm btn-danger" disabled={deployBusy === bk}
                                  style={{fontSize:8, padding:'2px 7px'}}
                                  onClick={() => signoff(agent.agent_id, key, 'failed')}>
                                  FAIL
                                </button>
                              </div>
                            )}
                            {st !== 'pending' && chk?.signed_at && (
                              <span style={{fontFamily:'JetBrains Mono', fontSize:8, color:'var(--tx-3)'}}>
                                {formatTimeUtc(chk.signed_at)}
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </Pane>
          )}

          {/* Vehicle */}
          <Pane title="Vehicle · Specs">
            <div style={{display:'grid', gridTemplateColumns:'1fr 1fr'}}>
              {[
                ['Call Sign', vehicle?.call_sign ?? '—'],
                ['Model',     vehicle?.make_model ?? m?.vehicle_model ?? '—'],
                ['Plate',     vehicle?.plate ?? m?.vehicle_plate ?? '—'],
                ['Armour',    vehicle?.armored ? `${vehicle.armor_grade ?? 'B'} CERT` : (m?.vehicle_armour ?? 'Soft-skin')],
                ['Capacity',  vehicle?.capacity != null ? `${vehicle.capacity} pax` : '—'],
                ['Speed',     m?.speed_kph != null ? `${Math.round(m.speed_kph)} km/h` : '—'],
                ['Heading',   m?.heading_deg != null ? `${Math.round(m.heading_deg)}°` : '—'],
                ['Comms',     `${m?.comms_pct ?? 100}%`],
              ].map(([lbl, v]) => {
                const armorOk = lbl === 'Armour' && typeof v === 'string' && v.endsWith('CERT');
                return (
                  <div key={lbl} style={{padding:'10px 14px', borderRight:'1px solid var(--bd-2)', borderBottom:'1px solid var(--bd-2)'}}>
                    <div style={{fontFamily:'JetBrains Mono', fontSize:9, color:'var(--tx-3)', letterSpacing:1.2, textTransform:'uppercase', fontWeight:700}}>{lbl}</div>
                    <div style={{fontFamily:'JetBrains Mono', fontSize:12.5, color: armorOk ? 'var(--ok)' : 'var(--tx-1)', fontWeight:700, marginTop:4}}>{v}</div>
                  </div>
                );
              })}
            </div>
          </Pane>
        </div>

        {/* ── CENTER — Mapbox + waypoints ── */}
        <div style={{display:'flex', flexDirection:'column', gap:12, minHeight:0, height:'100%', overflow:'hidden'}}>
          <div className="card" style={{flex:'0 0 45%', overflow:'hidden', position:'relative', minHeight:0}}>
            <BravoMap
              markers={markers}
              // Suppress the precomputed single-line route whenever the
              // alternatives overlay is visible — the "current" alternative
              // is already highlighted in altRoutes, so drawing both
              // produces a double-line on the same road.
              route={altRoutes && altRoutes.length > 0 ? [] : route}
              alternativeRoutes={
                trailOption ? [...(altRoutes ?? []), trailOption] : altRoutes
              }
              styleId={mapStyleId}
              center={mapCenter}
              zoom={12}
              style={{position:'absolute', inset:0}}
            />

            {/* RE-ROUTE picker overlay */}
            {routePickerOpen && (
              <div style={{
                position:'absolute', top:50, right:14, width:300,
                background:'rgba(4,16,31,0.96)',
                border:`1px solid ${ROUTE_COLORS[Math.max(0, (routeOptions ?? []).findIndex(o => o.key === routeSelectedKey))] ?? 'var(--bd-1)'}`,
                borderRadius:10, padding:0, zIndex:5, overflow:'hidden',
                boxShadow:'0 14px 38px rgba(0,0,0,0.6), 0 0 0 1px rgba(126,214,255,0.08)',
              }}>
                {/* Header */}
                <div style={{
                  display:'flex', justifyContent:'space-between', alignItems:'center',
                  padding:'10px 14px', borderBottom:'1px solid var(--bd-2)',
                  background:'linear-gradient(180deg, rgba(91,141,239,0.10), transparent)',
                }}>
                  <span style={{fontFamily:'JetBrains Mono', fontSize:10, color:'var(--glow)', letterSpacing:1.6, fontWeight:800, textTransform:'uppercase'}}>
                    ◆ Pick Route
                  </span>
                  <button onClick={closeRoutePicker} aria-label="Close picker"
                    style={{background:'none', border:'none', color:'var(--tx-3)', cursor:'pointer', fontSize:18, padding:0, lineHeight:1}}>
                    ×
                  </button>
                </div>

                {/* Body */}
                <div style={{padding:12}}>
                  {routeLoading && (
                    <div style={{padding:'12px 0', fontFamily:'JetBrains Mono', fontSize:11, color:'var(--tx-3)'}}>
                      Fetching alternatives…
                    </div>
                  )}
                  {routeError && (
                    <div style={{padding:'8px 10px', background:'rgba(220,38,38,0.12)', border:'1px solid var(--err)', borderRadius:6, color:'#FFB4B4', fontFamily:'JetBrains Mono', fontSize:10, marginBottom:10}}>
                      {routeError}
                    </div>
                  )}
                  {routeOptions && routeOptions.length === 0 && !routeLoading && (
                    <div style={{padding:'8px 0', fontFamily:'JetBrains Mono', fontSize:10, color:'var(--tx-3)'}}>
                      Mapbox returned no driving routes for this pair.
                    </div>
                  )}

                  {routeOptions && routeOptions.length > 0 && (() => {
                    const sortedOpts = routeOptions
                      .map((o, i) => ({...o, _color: ROUTE_COLORS[i] ?? '#A9C5FF', _idx: i}))
                      .filter(o => o.polyline);
                    const selected = sortedOpts.find(o => o.key === routeSelectedKey) ?? sortedOpts[0];
                    const labelOf = (i: number) => (i === 0 ? 'FASTEST' : `ALT ${i}`);
                    return (
                      <>
                        {/* Tab strip — one per option */}
                        <div style={{
                          display:'grid',
                          gridTemplateColumns:`repeat(${sortedOpts.length}, 1fr)`,
                          gap:6, marginBottom:12,
                        }}>
                          {sortedOpts.map(o => {
                            const sel = o.key === selected?.key;
                            return (
                              <button
                                key={o.key}
                                onClick={() => setRouteSelectedKey(o.key)}
                                style={{
                                  position:'relative', padding:'8px 6px', borderRadius:6,
                                  background: sel ? o._color : 'var(--surf-2)',
                                  color:      sel ? '#07090D' : 'var(--tx-2)',
                                  border:     `1.5px solid ${sel ? o._color : 'var(--bd-2)'}`,
                                  fontFamily:'JetBrains Mono', fontSize:10, fontWeight:800,
                                  letterSpacing:1.2, cursor:'pointer', textTransform:'uppercase',
                                  boxShadow: sel ? `0 0 14px ${hexA(o._color, 0.5)}` : 'none',
                                  transition: 'all 0.12s',
                                }}>
                                {labelOf(o._idx)}
                                {o.is_current && (
                                  <span style={{
                                    position:'absolute', top:-5, right:-5,
                                    width:8, height:8, borderRadius:'50%',
                                    background:'var(--ok)', boxShadow:`0 0 6px var(--ok)`,
                                    border:'1px solid #07090D',
                                  }}/>
                                )}
                              </button>
                            );
                          })}
                        </div>

                        {/* Big metric for the selected option */}
                        {selected && (
                          <div style={{
                            padding:'12px 14px', borderRadius:8, marginBottom:12,
                            background:`linear-gradient(180deg, ${hexA(selected._color, 0.12)}, transparent)`,
                            border:`1px solid ${hexA(selected._color, 0.45)}`,
                          }}>
                            <div style={{display:'flex', alignItems:'baseline', gap:14}}>
                              <span style={{
                                fontFamily:'JetBrains Mono', fontSize:26, fontWeight:800,
                                color: selected._color, letterSpacing:-0.5, lineHeight:1,
                              }}>
                                {(selected.distance_m / 1000).toFixed(1)}
                                <span style={{fontSize:11, marginLeft:4, color:'var(--tx-3)', letterSpacing:1, fontWeight:600}}>KM</span>
                              </span>
                              <span style={{
                                fontFamily:'JetBrains Mono', fontSize:22, fontWeight:800,
                                color:'var(--tx-1)', letterSpacing:-0.5, lineHeight:1,
                              }}>
                                {Math.round(selected.duration_s / 60)}
                                <span style={{fontSize:11, marginLeft:4, color:'var(--tx-3)', letterSpacing:1, fontWeight:600}}>MIN</span>
                              </span>
                            </div>
                            {selected.is_current && (
                              <div style={{marginTop:6, fontFamily:'JetBrains Mono', fontSize:9, color:'var(--ok)', letterSpacing:1, fontWeight:700}}>
                                ● ACTIVE ROUTE
                              </div>
                            )}
                          </div>
                        )}

                        {/* Compare row — small numbers per option, dim if not selected */}
                        <div style={{display:'flex', flexDirection:'column', gap:4, marginBottom:12, padding:'8px 10px', background:'var(--surf-2)', borderRadius:6, border:'1px solid var(--bd-2)'}}>
                          {sortedOpts.map(o => {
                            const sel = o.key === selected?.key;
                            return (
                              <div key={o.key} style={{
                                display:'flex', alignItems:'center', justifyContent:'space-between',
                                opacity: sel ? 1 : 0.55,
                                fontFamily:'JetBrains Mono', fontSize:10,
                              }}>
                                <span style={{display:'flex', alignItems:'center', gap:6, color:'var(--tx-2)'}}>
                                  <span style={{
                                    width: sel ? 12 : 8, height: sel ? 4 : 2.5,
                                    background: o._color, borderRadius:1,
                                    boxShadow: sel ? `0 0 6px ${hexA(o._color, 0.7)}` : 'none',
                                  }}/>
                                  <b style={{color:'var(--tx-1)', letterSpacing:1, fontWeight:700}}>{labelOf(o._idx)}</b>
                                </span>
                                <span style={{color:'var(--tx-1)', fontWeight:700}}>
                                  {(o.distance_m / 1000).toFixed(1)} km · {Math.round(o.duration_s / 60)} min
                                </span>
                              </div>
                            );
                          })}
                        </div>

                        {/* Commit button — full-width, color-matched to selected */}
                        <button
                          onClick={commitRouteSelection}
                          disabled={routeSubmitting || !selected?.polyline || selected.is_current}
                          style={{
                            width:'100%', padding:'10px 12px', borderRadius:8,
                            background: selected?.is_current ? 'var(--surf-3)' : selected?._color ?? 'var(--act)',
                            color:      selected?.is_current ? 'var(--tx-3)'  : '#07090D',
                            border:'none',
                            fontFamily:'Manrope', fontSize:12, fontWeight:800, letterSpacing:1.5,
                            textTransform:'uppercase',
                            cursor: selected?.is_current ? 'not-allowed' : 'pointer',
                            opacity: routeSubmitting ? 0.6 : 1,
                            boxShadow: selected?._color && !selected?.is_current
                              ? `0 4px 16px ${hexA(selected._color, 0.4)}`
                              : 'none',
                          }}>
                          {routeSubmitting ? '…' :
                           selected?.is_current ? '✓ USING THIS ROUTE' :
                           `→ DISPATCH ${labelOf(selected?._idx ?? 0)}`}
                        </button>
                      </>
                    );
                  })()}
                </div>
              </div>
            )}
            <div style={{position:'absolute', top:14, left:14, right:14, display:'flex', justifyContent:'space-between', fontFamily:'JetBrains Mono', fontSize:10, color:'var(--tx-3)', letterSpacing:1, textTransform:'uppercase', pointerEvents:'none'}}>
              <span><b style={{color:'var(--glow)'}}>LIVE FEED</b> · {m?.short_code ?? 'MSN'} · GPS {m?.gps_rtk_lock ? 'LOCK' : '—'}</span>
              <span style={{color:'var(--err)', display:'flex', alignItems:'center', gap:6, fontWeight:700}}>
                <span style={{width:6, height:6, borderRadius:'50%', background:'var(--err)', display:'inline-block', boxShadow:'0 0 8px var(--err)'}}/>
                LIVE
              </span>
            </div>
            {/* Map legend — colour key for the markers */}
            <div style={{position:'absolute', bottom:12, left:12, display:'flex', gap:10, padding:'6px 10px', background:'rgba(5,7,10,0.78)', border:'1px solid var(--bd-2)', borderRadius:6, fontFamily:'JetBrains Mono', fontSize:9.5, color:'var(--tx-2)', letterSpacing:0.6}}>
              <LegendDot color="#00C853" label="PICKUP"/>
              <LegendDot color="#FFC107" label="DROPOFF"/>
              <LegendDot color="#5B8DEF" label="CPO LEAD"/>
              <LegendDot color="#A9C5FF" label="PRINCIPAL"/>
              <LegendDot color="#8B95A8" label="AWAITING"/>
            </div>
            {/* OC-11 — telemetry trail toggle (draws the recorded GPS track). */}
            <button
              type="button"
              onClick={() => setShowTrail(v => !v)}
              title={showTrail ? 'Hide the recorded GPS trail' : 'Show the recorded GPS trail'}
              style={{
                position:'absolute', top:14, right:118, zIndex:5,
                display:'flex', alignItems:'center', gap:6,
                padding:'6px 10px', borderRadius:6,
                background: showTrail ? 'rgba(91,141,239,0.25)' : 'rgba(5,7,10,0.92)',
                border: showTrail ? '1px solid #5B8DEF' : '1px solid var(--bd-1)',
                color:'var(--tx-1)', cursor:'pointer',
                fontFamily:'JetBrains Mono', fontSize:10, fontWeight:700,
                letterSpacing:0.8, textTransform:'uppercase',
              }}>
              TRAIL{showTrail && telemetry ? ` · ${telemetry.points.length}` : ''}
            </button>
            {/* Style cycler FAB — Dark / Streets / Satellite. Mirrors the
                mobile location-picker cycler so the admin can flip to
                street view or imagery without leaving the page. */}
            <button
              type="button"
              onClick={cycleMapStyle}
              title={`Map style: ${mapStyleId.toUpperCase()} (click to cycle)`}
              style={{
                position:'absolute', top:14, right:14, zIndex:5,
                display:'flex', alignItems:'center', gap:6,
                padding:'6px 10px', borderRadius:6,
                background:'rgba(5,7,10,0.92)',
                border:'1px solid var(--bd-1)',
                color:'var(--tx-1)', cursor:'pointer',
                fontFamily:'JetBrains Mono', fontSize:10, fontWeight:700,
                letterSpacing:0.8, textTransform:'uppercase',
              }}>
              <span style={{
                width:8, height:8, borderRadius:2,
                background: mapStyleId === 'dark' ? '#5B8DEF'
                          : mapStyleId === 'light' ? '#E8EAEE'
                          : mapStyleId === 'streets' ? '#7ED320'
                          : '#FFC107',
                boxShadow:`0 0 8px ${
                  mapStyleId === 'dark' ? '#5B8DEF'
                : mapStyleId === 'light' ? '#E8EAEE'
                : mapStyleId === 'streets' ? '#7ED320'
                : '#FFC107'}`,
              }}/>
              {mapStyleId === 'dark' ? 'DARK' : mapStyleId === 'light' ? 'LIGHT' : mapStyleId === 'streets' ? 'STREETS' : 'SAT'}
            </button>
            {/* Status overlay shown when neither party has pushed GPS yet */}
            {!hasCpoFix && !hasPrincipalFix && (
              <div style={{position:'absolute', bottom:12, right:12, padding:'6px 10px', background:'rgba(120,90,0,0.30)', border:'1px solid var(--warn)', borderRadius:6, fontFamily:'JetBrains Mono', fontSize:10, color:'var(--warn)', letterSpacing:0.8, fontWeight:700}}>
                ⏳ AWAITING TELEMETRY · CPO + PRINCIPAL
              </div>
            )}
            {!hasCpoFix && hasPrincipalFix && (
              <div style={{position:'absolute', bottom:12, right:12, padding:'6px 10px', background:'rgba(120,90,0,0.30)', border:'1px solid var(--warn)', borderRadius:6, fontFamily:'JetBrains Mono', fontSize:10, color:'var(--warn)', letterSpacing:0.8, fontWeight:700}}>
                ⏳ AWAITING CPO TELEMETRY
              </div>
            )}
            {hasCpoFix && !hasPrincipalFix && (
              <div style={{position:'absolute', bottom:12, right:12, padding:'6px 10px', background:'rgba(120,90,0,0.30)', border:'1px solid var(--warn)', borderRadius:6, fontFamily:'JetBrains Mono', fontSize:10, color:'var(--warn)', letterSpacing:0.8, fontWeight:700}}>
                ⏳ AWAITING PRINCIPAL TELEMETRY
              </div>
            )}
          </div>

          <div className="card" style={{flex:1, overflow:'auto'}}>
            {isExec ? (
              <>
                <div className="pane-h">
                  Hourly Check-ins <span style={{color:'var(--tx-3)', fontSize:9}}>
                    {hourlyCheckins.length} OF {execDuration || '—'}
                  </span>
                </div>
                <div style={{padding:'10px 14px'}}>
                  {hourlyCheckins.length === 0 && (
                    <div style={{fontFamily:'Manrope', fontSize:11.5, color:'var(--tx-3)', padding:'6px 0'}}>
                      Executive Protection detail — the lead confirms each elapsed hour once the mission is live.
                    </div>
                  )}
                  {hourlyCheckins.map((h, i) => {
                    // SK-10 — an ISSUE hour must not wear the green ✓ of an
                    // "all smooth" one.
                    const issue = h.status === 'ISSUE';
                    return (
                      <div key={h.hour_index} style={{display:'grid', gridTemplateColumns:'22px 90px 1fr', gap:10, padding:'9px 0', borderBottom: i < hourlyCheckins.length-1 ? '1px solid var(--bd-2)' : 'none', alignItems:'flex-start'}}>
                        <div style={{width:18, height:18, borderRadius:'50%', display:'flex', alignItems:'center', justifyContent:'center', fontFamily:'JetBrains Mono', fontSize:8.5, fontWeight:800, background: issue ? 'var(--err)' : 'var(--ok)', color: issue ? '#fff' : '#07090D'}}>
                          {issue ? '!' : '✓'}
                        </div>
                        <div style={{fontFamily:'JetBrains Mono', fontSize:10, color:'var(--tx-2)', fontWeight:600}}>
                          {formatTimeUtc(h.created_at)}
                        </div>
                        <div>
                          <div style={{fontSize:11.5, color: issue ? 'var(--warn)' : 'var(--tx-1)'}}>
                            Hour {h.hour_index} — {issue ? 'issue reported' : 'all smooth'}
                          </div>
                          {h.comment && <div style={{fontFamily:'JetBrains Mono', fontSize:9.5, color:'var(--tx-3)', marginTop:2}}>{h.comment}</div>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : (
            <>
            <div className="pane-h">
              Waypoint Timeline <span style={{color:'var(--tx-3)', fontSize:9}}>
                {waypoints.filter(w => (w as {state: string}).state === 'done').length} OF {waypoints.length}
              </span>
            </div>
            <div style={{padding:'10px 14px'}}>
              {waypoints.map((wp, i) => {
                const w = wp as {id?: number; seq: number; tag: string; event: string; sub: string | null; state: string; planned_at?: string | null; settled_at?: string | null};
                const done = w.state === 'done';
                const cur  = w.state === 'current' || w.state === 'sos';
                return (
                  <div key={w.id ?? i} style={{display:'grid', gridTemplateColumns:'22px 90px 1fr auto', gap:10, padding:'9px 0', borderBottom: i < waypoints.length-1 ? '1px solid var(--bd-2)' : 'none', alignItems:'flex-start'}}>
                    <div style={{width:18, height:18, borderRadius:'50%', display:'flex', alignItems:'center', justifyContent:'center', fontFamily:'JetBrains Mono', fontSize:8.5, fontWeight:800, background: done ? 'var(--ok)' : cur ? 'var(--act)' : 'var(--surf-3)', color: done ? '#07090D' : cur ? '#fff' : 'var(--tx-3)', border: cur ? 'none' : '1px solid var(--bd-1)', boxShadow: cur ? '0 0 0 3px rgba(91,141,239,0.25)' : 'none'}}>
                      {done ? '✓' : w.seq}
                    </div>
                    <div style={{fontFamily:'JetBrains Mono', fontSize:10, color: done || cur ? 'var(--tx-2)' : 'var(--tx-3)', fontWeight:600}}>
                      {formatTimeUtc(w.settled_at)}
                    </div>
                    <div>
                      <div style={{fontSize:11.5, color: done || cur ? 'var(--tx-1)' : 'var(--tx-3)'}}>{w.event}</div>
                      {w.sub && <div style={{fontFamily:'JetBrains Mono', fontSize:9.5, color:'var(--tx-3)', marginTop:2}}>{w.sub}</div>}
                    </div>
                    <div style={{fontFamily:'JetBrains Mono', fontSize:9, color: cur ? 'var(--act)' : 'var(--glow)', letterSpacing:0.8, textTransform:'uppercase'}}>{w.tag}</div>
                  </div>
                );
              })}
            </div>
            </>
            )}
          </div>
        </div>

        {/* ── RIGHT ── */}
        <div style={{display:'flex', flexDirection:'column', gap:12, overflowY:'auto', minHeight:0, height:'100%', paddingBottom:4}}>
          <Pane title="Mission Vitals">
            <div className="vitals">
              {[
                {k:'Elapsed',  v: m?.started_at ? elapsed(m.started_at) : '—'},
                {k:'Route',    v: routeKm != null ? `${routeKm.toFixed(1)} km` : '—'},
                {k:'Progress', v: progressPct != null ? `${progressPct}%` : '—', cls: progressPct != null && progressPct >= 80 ? 'vital-v-ok' : ''},
                {k:'Speed',    v: m?.speed_kph ? `${Math.round(m.speed_kph)} km/h` : '—', cls:'vital-v-ok'},
                {k:'Risk',     v: m?.risk_level ?? 'LOW', cls: m?.risk_level === 'HIGH' ? 'vital-v-warn' : ''},
                {k:'Comms',    v: `${m?.comms_pct ?? 100}%`, cls:'vital-v-ok'},
                {k:'GPS RTK',  v: m?.gps_rtk_lock === false ? '—' : 'LOCK', cls:'vital-v-ok'},
                {k:'SOS',      v: (data?.sos?.filter(s => !s.resolved_at).length ?? 0).toString(), cls: activeSos ? 'vital-v-warn' : ''},
              ].map(vi => (
                <div key={vi.k} className="vital">
                  <div className="vital-k">{vi.k}</div>
                  <div className={`vital-v ${vi.cls ?? ''}`}>{vi.v}</div>
                </div>
              ))}
            </div>
            {progressPct != null && (
              <div style={{padding:'10px 14px', borderTop:'1px solid var(--bd-2)'}}>
                <div style={{fontFamily:'JetBrains Mono', fontSize:9, color:'var(--tx-3)', letterSpacing:1.2, fontWeight:700, marginBottom:6}}>
                  PICKUP → DROPOFF
                </div>
                <div style={{position:'relative', height:6, background:'var(--surf-3)', borderRadius:3, overflow:'hidden'}}>
                  <div style={{
                    position:'absolute', left:0, top:0, bottom:0,
                    width:`${progressPct}%`,
                    background:'linear-gradient(90deg, var(--act), var(--acc))',
                    boxShadow: progressPct >= 80 ? '0 0 8px var(--act)' : 'none',
                  }}/>
                  {/* Checkpoint markers at 50% and 80% */}
                  {[50, 80].map(p => (
                    <div key={p} style={{
                      position:'absolute', left:`${p}%`, top:-2, bottom:-2,
                      width:1, background:'var(--bd-1)',
                    }}/>
                  ))}
                </div>
                <div style={{display:'flex', justifyContent:'space-between', marginTop:4, fontFamily:'JetBrains Mono', fontSize:9, color:'var(--tx-3)'}}>
                  <span>0%</span>
                  <span>CHKPT 01</span>
                  <span>CHKPT 02</span>
                  <span>100%</span>
                </div>
              </div>
            )}
          </Pane>

          {/* SOS section */}
          {data?.sos && data.sos.length > 0 && (
            <Pane title={`SOS Events · ${data.sos.length}`}>
              {data.sos.map(s => (
                <div key={s.id} style={{padding:'10px 14px', borderBottom:'1px solid var(--bd-2)'}}>
                  <div style={{display:'flex', justifyContent:'space-between'}}>
                    <span style={{fontFamily:'JetBrains Mono', fontSize:10, color: s.acknowledged_at ? 'var(--warn)' : 'var(--err)'}}>
                      {s.acknowledged_at ? '✓ ACKNOWLEDGED' : '● UNACK'}
                    </span>
                    <span style={{fontFamily:'JetBrains Mono', fontSize:10, color:'var(--tx-3)'}}>{formatDateTimeShortUtc(s.triggered_at)}</span>
                  </div>
                  <div style={{fontFamily:'Manrope', fontSize:12, fontWeight:700, color:'var(--tx-1)', marginTop:4}}>
                    {s.reason}
                  </div>
                  <div style={{fontFamily:'JetBrains Mono', fontSize:10, color:'var(--tx-3)', marginTop:2}}>
                    {s.agent_call_sign ?? '—'}
                  </div>
                </div>
              ))}
            </Pane>
          )}

          {/* Ops ↔ CPO chat (plaintext system broadcasts) */}
          <OpsChat missionId={id} />

          {/* Mission group — E2E encrypted (libsignal) */}
          <MissionGroupPanel
            conversationId={m?.comms_channel_id ?? null}
            missionShortCode={m?.short_code}
          />

          {/* Audit */}
          <Pane title={`Audit · Last ${audit.length}`}>
            {audit.length === 0 ? (
              <div style={{padding:'14px 14px', color:'var(--tx-3)', fontFamily:'JetBrains Mono', fontSize:11}}>
                No audit events yet.
              </div>
            ) : audit.map((a, i) => {
              const md = (a.metadata ?? {}) as {reason?: string};
              return (
                <div key={a.id ?? i} className="tl-ev">
                  <div className="tl-ts">{formatDateTimeShortUtc(a.created_at)}</div>
                  <div className="tl-who">{a.actor_call ?? a.actor_role ?? '—'}</div>
                  <div className="tl-msg">
                    <b>{a.action}</b>
                    {md.reason && <span style={{color:'var(--tx-3)'}}> · {md.reason}</span>}
                  </div>
                </div>
              );
            })}
          </Pane>
        </div>
      </div>

      {/* Audit L2 — validated reason modal (abort reason / SOS resolution).
          Replaces window.prompt: trims, enforces a minimum length, and is
          dismissible without firing. */}
      {reasonModal && (
        <div
          onClick={() => { if (!busy) setReasonModal(null); }}
          style={{
            position:'fixed', inset:0, zIndex:1000,
            background:'rgba(2,8,20,0.72)', backdropFilter:'blur(2px)',
            display:'flex', alignItems:'center', justifyContent:'center',
          }}>
          <div
            onClick={e => e.stopPropagation()}
            style={{
              width:'min(440px, 92vw)', background:'var(--surf-2)',
              border:`1px solid ${reasonModal.danger ? 'rgba(220,38,38,0.5)' : 'var(--bd-2)'}`,
              borderRadius:12, padding:18, boxShadow:'0 20px 60px rgba(0,0,0,0.5)',
            }}>
            <h3 style={{margin:'0 0 4px', fontSize:15, fontWeight:800, color: reasonModal.danger ? 'var(--err)' : 'var(--tx-1)'}}>
              {reasonModal.title}
            </h3>
            <label style={{display:'block', fontFamily:'JetBrains Mono', fontSize:10, letterSpacing:0.8, color:'var(--tx-3)', margin:'12px 0 6px'}}>
              {reasonModal.label}
            </label>
            <textarea
              autoFocus
              value={reasonText}
              onChange={e => { setReasonText(e.target.value); if (err) setErr(null); }}
              placeholder={reasonModal.placeholder}
              maxLength={500}
              rows={3}
              style={{
                width:'100%', resize:'vertical', boxSizing:'border-box',
                background:'var(--surf-3)', border:'1px solid var(--bd-2)', borderRadius:8,
                padding:'10px 12px', color:'var(--tx-1)', fontFamily:'JetBrains Mono', fontSize:12,
              }}
            />
            <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginTop:6}}>
              <span style={{fontFamily:'JetBrains Mono', fontSize:9.5, color:'var(--tx-3)'}}>
                {reasonText.trim().length}/{500}
              </span>
              {err && <span style={{fontFamily:'JetBrains Mono', fontSize:10, color:'var(--err)'}}>{err}</span>}
            </div>
            <div style={{display:'flex', gap:10, justifyContent:'flex-end', marginTop:14}}>
              <button className="btn btn-ghost" disabled={busy} onClick={() => setReasonModal(null)}>CANCEL</button>
              <button
                className="btn"
                disabled={busy || reasonText.trim().length < reasonModal.minLen}
                onClick={submitReason}
                style={{
                  fontWeight:800, border:'none', color:'#fff',
                  background: reasonModal.danger ? 'var(--err)' : 'var(--act)',
                  opacity: (busy || reasonText.trim().length < reasonModal.minLen) ? 0.5 : 1,
                }}>
                {busy ? '…' : reasonModal.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </Shell>
  );
}

function Pane({title, children}: {title: string; children: React.ReactNode}) {
  return (
    <div className="card" style={{overflow:'hidden'}}>
      <div className="pane-h">{title}</div>
      {children}
    </div>
  );
}

function LegendDot({color, label}: {color: string; label: string}) {
  return (
    <span style={{display:'inline-flex', alignItems:'center', gap:4}}>
      <span style={{width:8, height:8, borderRadius:'50%', background:color, boxShadow:`0 0 6px ${color}`, display:'inline-block'}}/>
      {label}
    </span>
  );
}

/**
 * OpsChat — mission-scoped two-way text channel between ops and the
 * CPO/principal. Messages are stored as system_broadcasts on the
 * mission's comms_channel_id, so CPOs see every message inline in their
 * messenger feed alongside the encrypted envelopes. Polls every few
 * seconds via useMissionMessages.
 */
function OpsChat({missionId}: {missionId: string}) {
  const {data, mutate, isLoading} = useMissionMessages(missionId);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const messages = data?.messages ?? [];

  // Auto-scroll to bottom when new messages arrive — but only if the
  // operator is already near the bottom (Audit PAGE-24), so reading back
  // through SOS history isn't yanked away on every 2s poll. Always snaps on
  // the first paint with content so the pane still opens at the latest msg.
  const didInitialChatScroll = useRef(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (!didInitialChatScroll.current || nearBottom) {
      el.scrollTop = el.scrollHeight;
      if (el.scrollHeight > 0) didInitialChatScroll.current = true;
    }
  }, [messages.length]);

  async function send() {
    const t = text.trim();
    if (!t) return;
    setSending(true); setErr(null);
    try {
      const r = await opsApi.sendMissionMessage(missionId, t);
      if (!r.ok) {
        setErr(r.reason === 'no_ops_room'
          ? 'Mission has no ops room yet — dispatch must complete first.'
          : 'Send failed');
        return;
      }
      setText('');
      await mutate();
    } catch (e) {
      setErr((e as Error).message || 'Send failed');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="card" style={{overflow:'hidden', display:'flex', flexDirection:'column', maxHeight:340}}>
      <div className="pane-h">
        Ops Comms · {messages.length}
        {data?.conversation_id == null && !isLoading && (
          <span style={{marginLeft:8, color:'var(--warn)', fontSize:9}}>· NO OPS ROOM</span>
        )}
      </div>
      <div ref={scrollRef} style={{flex:1, overflowY:'auto', padding:'8px 12px', display:'flex', flexDirection:'column', gap:8, minHeight:120}}>
        {isLoading && messages.length === 0 && (
          <div style={{color:'var(--tx-3)', fontFamily:'JetBrains Mono', fontSize:11}}>Loading…</div>
        )}
        {!isLoading && messages.length === 0 && (
          <div style={{color:'var(--tx-3)', fontFamily:'JetBrains Mono', fontSize:11}}>
            No messages yet. Send the first one to the crew below.
          </div>
        )}
        {messages.map(msg => {
          const isOps    = msg.kind === 'ops_message';
          const isSystem = !isOps;
          const sender   = msg.payload?.sender_label ?? (isSystem ? 'SYSTEM' : 'OPS');
          const sev      = msg.severity;
          const accent   =
            sev === 'err'  ? 'var(--err)'  :
            sev === 'warn' ? 'var(--warn)' :
            sev === 'ok'   ? 'var(--ok)'   : 'var(--act)';
          return (
            <div key={msg.id} style={{
              borderLeft: `2px solid ${accent}`,
              paddingLeft: 8,
              opacity: isSystem ? 0.85 : 1,
            }}>
              <div style={{
                fontFamily:'JetBrains Mono', fontSize:9, color:'var(--tx-3)',
                letterSpacing:0.6, textTransform:'uppercase', display:'flex',
                justifyContent:'space-between', gap:8,
              }}>
                <span style={{color: isOps ? 'var(--act)' : 'var(--tx-2)', fontWeight:700}}>
                  {sender}
                </span>
                <span>{formatDateTimeShortUtc(msg.created_at)}</span>
              </div>
              <div style={{fontFamily:'Manrope', fontSize:12.5, color:'var(--tx-1)', marginTop:2, whiteSpace:'pre-wrap', lineHeight:1.35}}>
                {msg.body}
              </div>
            </div>
          );
        })}
      </div>
      {err && (
        <div style={{padding:'6px 12px', background:'rgba(220,38,38,0.1)', borderTop:'1px solid var(--err)', color:'#FFB4B4', fontFamily:'JetBrains Mono', fontSize:10}}>
          {err}
        </div>
      )}
      <div style={{display:'flex', gap:6, padding:8, borderTop:'1px solid var(--bd-2)', background:'var(--surf-2)'}}>
        <input
          type="text"
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
          placeholder="Message the crew…"
          disabled={sending}
          style={{
            flex:1, background:'var(--surf-3)', border:'1px solid var(--bd-1)',
            borderRadius:6, padding:'7px 10px',
            fontFamily:'Manrope', fontSize:12.5, color:'var(--tx-1)', outline:'none',
          }}
        />
        <button
          className="btn btn-sec"
          disabled={sending || !text.trim()}
          onClick={() => { void send(); }}
          style={{padding:'7px 14px', fontWeight:700}}>
          {sending ? '…' : 'SEND'}
        </button>
      </div>
    </div>
  );
}

function initials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).map(p => p[0]).join('').toUpperCase();
}

function elapsed(fromIso: string): string {
  const ms = Date.now() - new Date(fromIso).getTime();
  if (ms < 0) return '00:00';
  const mins = Math.floor(ms / 60_000);
  const hh = Math.floor(mins / 60).toString().padStart(2, '0');
  const mm = (mins % 60).toString().padStart(2, '0');
  return `${hh}:${mm}`;
}

function statusPill(s: MissionStatus): 'ok' | 'warn' | 'err' | 'act' {
  if (s === 'SOS') return 'err';
  if (s === 'COMPLETED') return 'ok';
  if (s === 'ABORTED') return 'err';
  return 'act';
}

/** #RRGGBB → rgba(r,g,b,a). Used for tinted backgrounds and glow shadows
 *  on the route picker so the selected option's color cascades through
 *  the card without us having to hand-author N variant hex codes. */
function hexA(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 0xff}, ${(n >> 8) & 0xff}, ${n & 0xff}, ${alpha})`;
}

