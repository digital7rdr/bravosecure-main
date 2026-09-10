'use client';

import {Shell} from '@/components/Shell';
import {BravoMap} from '@/components/BravoMapLazy';
import {useDashboard, useMissions, useBookings} from '@/lib/api';
import {formatDateTimeShortUtc} from '@/lib/datetime';
import Link from 'next/link';

export default function Dashboard() {
  const {data: dash, error: dashErr} = useDashboard();
  const {data: missions}              = useMissions();
  const {data: pending}               = useBookings('PENDING_OPS');

  const live = dashErr === undefined && dash !== undefined;
  const kpis = dash?.kpis;
  const activity = dash?.activity ?? [];
  const approvals = (pending ?? []).slice(0, 5).map(b => ({
    id: b.id,
    client: b.region_label,
    from: (b.pickup_address ?? '').split(',')[0],
    to:   (b.dropoff_address ?? '—').split(',')[0],
    meta: `CPO×${b.cpo_count} · ${Number(b.total_eur).toLocaleString()} BC`,
    // CA-17/IS-18 — date component included; an HH:MMZ-only stamp was
    // ambiguous the moment a booking aged past midnight.
    time: formatDateTimeShortUtc(b.created_at),
  }));

  // Translate missions → map markers (only live missions with GPS lock).
  // Use explicit null checks, not truthiness — a fix at lat/lng exactly 0
  // is a valid coordinate and must not be filtered out.
  const markers = (missions ?? []).filter(m => m.current_lat != null && m.current_lng != null).map(m => ({
    id: m.id,
    lat: m.current_lat as number,
    lng: m.current_lng as number,
    label: `${m.short_code} · ${m.status}`,
    type: m.status === 'SOS' ? 'sos' as const : 'live' as const,
  }));

  return (
    <Shell>
      <div className="page-head">
        <div>
          <div className="page-crumbs">Ops · Home</div>
          <h2>Today at a Glance</h2>
        </div>
        <div className="page-head-right">
          <span className="pill pill-live">● LIVE</span>
          <span className="pill">{live ? 'API ONLINE' : 'API OFFLINE'}</span>
        </div>
      </div>

      {/* KPI row — pulled from /ops/dashboard. */}
      <div className="kpi-row">
        <Kpi cap="Pending Approval" num={kpis?.pending_approval ?? 0} color="#A9C5FF" prim/>
        <Kpi cap="Active Missions"  num={kpis?.active_missions  ?? 0} color="#00C853"/>
        <Kpi cap="Agents On Duty"   num={`${kpis?.agents_on_duty ?? 0}`} denom={`/${kpis?.agents_total ?? 0}`} color="#FFC107"/>
        <Kpi cap="Open Jobs"        num={kpis?.open_jobs        ?? 0} color="#3BA6FF"/>
        {/* IS-14 — the Pro pipeline is part of "today", not a hidden tab. */}
        <Kpi cap="Pro Apps Pending"  num={kpis?.pro_pending  ?? 0} color="#B78BFA"/>
        <Kpi cap="Pro Date Requests" num={kpis?.pro_requests ?? 0} color="#FF8A65"/>
        <Kpi cap="Today's GMV" num={`${(kpis?.gmv_today_bc ?? 0).toLocaleString()}`} suffix=" BC" color="#5B8DEF" small/>
      </div>

      <div style={{display:'grid', gridTemplateColumns:'1.2fr 1.3fr 0.9fr', gap:16, flex:1, minHeight:0}}>
        {/* Approval queue */}
        <div className="card" style={{display:'flex', flexDirection:'column', overflow:'hidden'}}>
          <div className="card-header">
            <div className="card-header-title"><span className="bar"/>Approval Queue</div>
            <Link href="/bookings" className="card-header-act">VIEW ALL · {kpis?.pending_approval ?? 0} →</Link>
          </div>
          <div style={{flex:1, overflow:'auto'}}>
            {approvals.length === 0 && (
              <div style={{padding:24, color:'var(--tx-3)', fontSize:11.5, textAlign:'center'}}>
                No bookings awaiting approval.
              </div>
            )}
            {approvals.map(a => (
              <Link key={a.id} href={`/bookings/${a.id}`} style={{textDecoration:'none', display:'block'}}>
                <div className="aq-row">
                  <div className="aq-id">{a.id.slice(-12).toUpperCase()}<span className="aq-id-sub">{a.time}</span></div>
                  <div>
                    <div className="aq-client">{a.client}</div>
                    <div className="aq-route"><b>{a.from}</b> → <b>{a.to}</b></div>
                    <div className="aq-meta"><span>{a.meta}</span></div>
                  </div>
                  {/* IS-19 — the ✓/✗ here never fired anything (the whole row
                      is a Link); fake affordances removed, the open chevron
                      honestly describes what a click does. */}
                  <div className="aq-actions">
                    <div className="aq-ico" title="Open">
                      <svg width="12" height="12" viewBox="0 0 12 12"><path d="M4 2l4 4-4 4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/></svg>
                    </div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>

        {/* Live ops map — Mapbox */}
        <div className="card" style={{display:'flex', flexDirection:'column', overflow:'hidden'}}>
          <div className="card-header">
            <div className="card-header-title"><span className="bar"/>Live Ops Map</div>
            <div className="card-header-act">
              {kpis?.active_missions ?? 0} ACTIVE · {kpis?.sos_active ?? 0} SOS
            </div>
          </div>
          <BravoMap
            markers={markers}
            center={[55.272, 25.208]}
            zoom={11}
            style={{flex:1}}
          />
        </div>

        {/* Activity feed */}
        <div className="card" style={{display:'flex', flexDirection:'column', overflow:'hidden'}}>
          <div className="card-header">
            <div className="card-header-title"><span className="bar"/>Activity</div>
            {/* N-35 — this card refreshes on a poll, not a live stream; label it honestly. */}
            <div className="card-header-act" style={{color:'var(--muted)'}}>RECENT</div>
          </div>
          <div style={{flex:1, overflow:'auto'}}>
            {activity.length === 0 && (
              <div style={{padding:24, color:'var(--tx-3)', fontSize:11.5, textAlign:'center'}}>
                No recent activity.
              </div>
            )}
            {activity.map(ev => (
              <div key={ev.id} className={`af-row${ev.severity === 'err' ? ' sos' : ''}`}>
                <div className="af-ts">{formatDateTimeShortUtc(ev.created_at)}</div>
                <div className="af-msg">{ev.message}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Shell>
  );
}

function Kpi({
  cap, num, denom, suffix, color, prim, small,
}: {
  cap: string; num: string | number; denom?: string; suffix?: string;
  color: string; prim?: boolean; small?: boolean;
}) {
  // Why: the sparkline was a hardcoded fake polyline (identical fabricated
  // trend on every KPI). The /ops/dashboard API carries no per-KPI
  // history, so there's nothing real to plot — removed rather than show
  // invented data. A left accent bar keeps the per-KPI colour cue.
  return (
    <div className={`kpi ${prim ? 'kpi-prim' : ''}`}>
      <div className="kpi-accent" style={{background: color}} />
      <div className="kpi-cap">{cap}</div>
      <div className="kpi-num" style={small ? {fontSize:22} : undefined}>
        {num}
        {denom && <span className="kpi-num-sub">{denom}</span>}
        {suffix && <span className="kpi-num-sub">{suffix}</span>}
      </div>
    </div>
  );
}
