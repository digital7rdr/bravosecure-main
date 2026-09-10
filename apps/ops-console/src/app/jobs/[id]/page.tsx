'use client';

import { Shell } from '@/components/Shell';
import Link from 'next/link';
import { use, useState } from 'react';
import { useJobDetail, useOpsMe, opsApi, type ApplicationRow } from '@/lib/api';
import { canShortlistAgent, canDispatchBooking, canRejectApplication } from '@/lib/rbac';
import { formatDateTimeUtc } from '@/lib/datetime';
import { bcFromAed } from '@/lib/bc';

type ActionKind = 'shortlist' | 'assign' | 'reject';
type BusyState = {id: string; action: ActionKind} | null;

/**
 * One applicant-row action button. While its own action is in flight it shows
 * a spinner + "WORKING…" and the whole row is frozen (rowBusy) so a second
 * mutation can't race the first. Terminal applicants (assigned/rejected/
 * withdrawn) and RBAC-gated roles stay disabled.
 */
function ActionBtn({
  label, cls, enabled, terminal, busy, appId, action, onRun,
}: {
  label: string; cls: string; enabled: boolean; terminal: boolean;
  busy: BusyState; appId: string; action: ActionKind; onRun: () => void;
}) {
  const rowBusy = busy?.id === appId;
  const thisBusy = rowBusy && busy?.action === action;
  return (
    <button
      className={`btn btn-sm ${cls}${thisBusy ? ' btn-busy' : ''}`}
      disabled={!enabled || terminal || rowBusy}
      onClick={onRun}>
      {thisBusy && <span className="spinner" />}
      {thisBusy ? 'WORKING…' : label}
    </button>
  );
}

function fitClass(fit: number | null): string {
  if (fit == null) return 'fit-md';
  if (fit >= 75) return 'fit-hi';
  if (fit >= 50) return 'fit-md';
  return 'fit-lo';
}

function statusPill(status: ApplicationRow['status']): {cls: string; label: string} {
  switch (status) {
    case 'ASSIGNED':    return {cls: 'pill-ok',   label: 'ON TEAM'};
    case 'SHORTLISTED': return {cls: 'pill-info', label: 'SHORTLISTED'};
    case 'REJECTED':    return {cls: 'pill-err',  label: 'NOT SELECTED'};
    case 'WITHDRAWN':   return {cls: 'pill',      label: 'WITHDRAWN'};
    default:            return {cls: 'pill-warn', label: 'PENDING'};
  }
}

export default function JobApplications({ params }: { params: Promise<{ id: string }> }) {
  const { id: jobId } = use(params);
  const { data, error, isLoading, mutate } = useJobDetail(jobId);
  const { data: me } = useOpsMe();
  const role = me?.admin.role;
  const canAct = canShortlistAgent(role);     // shortlist open to OPS+
  const canAssign = canDispatchBooking(role);  // assign is a heavier mutation → SUPERVISOR+
  const canReject = canRejectApplication(role); // CA-06 — server requires SUPERVISOR+

  // Track BOTH the row (application id) and which action is in flight so we
  // can freeze the whole row but show the spinner only on the clicked button.
  const [busy, setBusy] = useState<BusyState>(null);
  const [err, setErr] = useState<string | null>(null);

  const job = data?.job;
  const apps = (data?.applications ?? [])
    .slice()
    .sort((a, b) => (b.fit_score ?? -1) - (a.fit_score ?? -1));

  const act = async (id: string, action: ActionKind, fn: () => Promise<unknown>) => {
    // Guard: ignore a second click while any action is still resolving. The
    // disabled buttons normally prevent this, but a fast double-tap can fire
    // before React re-renders the disabled state.
    if (busy) return;
    setErr(null);
    setBusy({id, action});
    try {
      await fn();
      await mutate();
    } catch (e) {
      // Inline banner (no toast system in the console). Stays until the next
      // action so the operator can read why an assign/reject failed.
      setErr((e as Error).message || 'Action failed — please retry.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Shell>
      <div className="page-head">
        <div>
          <div className="page-crumbs">Ops · Job Feed · <span style={{color:'var(--tx-2)'}}>{job?.short_code ?? jobId}</span></div>
          <h2>Applications — <span className="mono" style={{color:'var(--acc)'}}>{job?.short_code ?? jobId}</span></h2>
        </div>
        <div className="page-head-right">
          <Link href="/jobs" className="btn btn-ghost">← BACK TO FEED</Link>
          {job?.booking_id && (
            <Link href={`/bookings/${job.booking_id}`} className="btn btn-sec">OPEN BOOKING →</Link>
          )}
        </div>
      </div>

      {isLoading && <div style={{padding:32,color:'var(--tx-3)'}}>Loading applications…</div>}
      {error && <div style={{padding:32,color:'var(--err)'}}>Failed to load job · {String((error as Error).message)}</div>}

      {!isLoading && !error && job && (
        <div style={{flex:1, display:'flex', flexDirection:'column', minHeight:0, gap:16}}>
          {/* Job summary + slot progress */}
          <div style={{display:'grid', gridTemplateColumns:'1.5fr 1fr', gap:16, flexShrink:0}}>
            <div className="card">
              <div className="card-header"><div className="card-header-title"><span className="bar"/>Job Requirements</div></div>
              <div style={{display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:12, padding:14}}>
                {[
                  ['Route', job.route_label],
                  ['Crew', `${job.cpo_slots}× CPO`],
                  ['Duration', `${job.duration_hours}h`],
                  ['Region', job.region_code],
                ].map(([l,v]) => (
                  <div key={l} style={{padding:10, background:'var(--surf-3)', border:'1px solid var(--bd-2)', borderRadius:8}}>
                    <div style={{fontFamily:'JetBrains Mono',fontSize:9,color:'var(--tx-3)',letterSpacing:1.2,textTransform:'uppercase'}}>{l}</div>
                    <div style={{fontFamily:'JetBrains Mono',fontSize:15,color:'var(--act)',fontWeight:800,marginTop:4}}>{v}</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="card">
              <div className="card-header"><div className="card-header-title"><span className="bar"/>Slot Fill Status</div></div>
              <div style={{padding:14, display:'flex', flexDirection:'column', justifyContent:'space-between'}}>
                <div style={{fontFamily:'JetBrains Mono',fontSize:22,fontWeight:800,color:'var(--tx-1)',letterSpacing:-1}}>
                  {job.slots_filled}<span style={{color:'var(--tx-3)',fontSize:14,fontWeight:500}}> / {job.cpo_slots} filled</span>
                </div>
                <div>
                  <div style={{height:10,borderRadius:6,background:'var(--surf-3)',border:'1px solid var(--bd-2)',overflow:'hidden',marginTop:10}}>
                    <div style={{height:'100%',width:`${job.cpo_slots ? Math.min(100, (job.slots_filled/job.cpo_slots)*100) : 0}%`,background:'linear-gradient(90deg,var(--act),var(--acc))',boxShadow:'0 0 10px rgba(91,141,239,0.4)'}}/>
                  </div>
                  <div style={{display:'flex',justifyContent:'space-between',fontFamily:'JetBrains Mono',fontSize:10,color:'var(--tx-3)',letterSpacing:0.6,marginTop:6}}>
                    <span>{apps.filter(a => a.status === 'ASSIGNED').length} assigned</span>
                    <span>{apps.filter(a => a.status === 'PENDING' || a.status === 'SHORTLISTED').length} open applicants</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Inline action error — replaces the old alert(). Dismissible;
              auto-clears when the next action starts. */}
          {err && (
            <div role="alert" style={{
              flexShrink:0, display:'flex', alignItems:'center', justifyContent:'space-between', gap:12,
              padding:'10px 14px', borderRadius:8,
              background:'rgba(220,38,38,0.1)', border:'1px solid rgba(220,38,38,0.35)',
              color:'var(--err)', fontFamily:'Manrope', fontSize:12, fontWeight:600,
            }}>
              <span>⚠ {err}</span>
              <button className="btn btn-sm btn-ghost" onClick={() => setErr(null)}>DISMISS</button>
            </div>
          )}

          {/* Applications table */}
          <div className="dt-wrap" style={{flex:1, overflow:'auto'}}>
            <table className="dt">
              <thead>
                <tr>
                  <th style={{width:40}}>Rank</th>
                  <th>Agent</th>
                  <th style={{width:90}}>Status</th>
                  <th style={{width:90}}>Distance</th>
                  <th className="num" style={{width:100}}>Rate/hr</th>
                  <th style={{width:120}}>Fit Score</th>
                  <th style={{width:160}}/>
                </tr>
              </thead>
              <tbody>
                {apps.length === 0 && (
                  <tr><td colSpan={7} style={{padding:24,textAlign:'center',color:'var(--tx-3)'}}>No applications yet — agents see this job in the marketplace and apply live.</td></tr>
                )}
                {apps.map((a, i) => {
                  const pill = statusPill(a.status);
                  const terminal = a.status === 'REJECTED' || a.status === 'WITHDRAWN' || a.status === 'ASSIGNED';
                  return (
                    <tr key={a.id}>
                      <td><div className={`rank ${i === 0 ? 'rank-1' : ''}`}>{i + 1}</div></td>
                      <td>
                        <div className="dt-client">
                          <div className="dt-client-av">{a.agent_call_sign.slice(-2)}</div>
                          <div>
                            <div className="dt-client-name">{a.agent_call_sign}</div>
                            <div className="dt-client-sub">{a.dress_pledge ? `pledged: ${a.dress_pledge}` : `applied ${formatDateTimeUtc(a.applied_at)}`}</div>
                          </div>
                        </div>
                      </td>
                      <td><span className={`pill ${pill.cls}`}>{pill.label}</span></td>
                      <td><span style={{fontFamily:'JetBrains Mono',fontSize:11,color:'var(--tx-2)'}}>{a.distance_km ? `${a.distance_km} km` : '—'}</span></td>
                      {/* Audit PAGE-20 — show BC (like the agents pages) instead of raw AED. */}
                      <td className="num">{a.rate_per_hour ? (a.rate_ccy === 'AED' ? `${bcFromAed(Number(a.rate_per_hour))} BC` : `${a.rate_ccy} ${a.rate_per_hour}`) : '—'}</td>
                      <td>
                        <div className={`fit ${fitClass(a.fit_score)}`}>
                          <div className="fit-bar"><div className="fit-fill" style={{width:`${a.fit_score ?? 0}%`}}/></div>
                          <div className="fit-v">{a.fit_score ?? '—'}</div>
                        </div>
                      </td>
                      <td>
                        <div style={{display:'flex',gap:6}}>
                          <ActionBtn
                            label="SHORTLIST" cls="btn-ghost"
                            enabled={canAct} terminal={terminal} busy={busy} appId={a.id} action="shortlist"
                            onRun={() => act(a.id, 'shortlist', () => opsApi.shortlistApp(a.id))}/>
                          <ActionBtn
                            label="ASSIGN" cls="btn-ok"
                            enabled={canAssign} terminal={terminal} busy={busy} appId={a.id} action="assign"
                            onRun={() => act(a.id, 'assign', () => opsApi.assignApp(a.id))}/>
                          <ActionBtn
                            label="REJECT" cls="btn-danger"
                            enabled={canReject} terminal={terminal} busy={busy} appId={a.id} action="reject"
                            onRun={() => act(a.id, 'reject', () => opsApi.rejectApp(a.id))}/>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Shell>
  );
}
