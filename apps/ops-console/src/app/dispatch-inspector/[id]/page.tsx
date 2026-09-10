'use client';

import {use} from 'react';
import Link from 'next/link';
import {Shell} from '@/components/Shell';
import {useDispatchRequest} from '@/lib/api';

function tone(s: string): string {
  if (s === 'CONFIRMED' || s === 'COMPLETED') { return 'ok'; }
  if (s === 'DISPATCHING') { return 'warn'; }
  if (s === 'LIVE') { return 'live'; }
  if (s === 'NO_PROVIDER' || s === 'AGENCY_NO_SHOW' || s === 'CANCELLED') { return 'err'; }
  return 'info';
}

function offerColor(s: string): string {
  if (s === 'ACCEPTED') { return 'var(--ok)'; }
  if (s === 'OFFERED') { return 'var(--warn)'; }
  if (s === 'REJECTED' || s === 'EXPIRED') { return 'var(--err)'; }
  return 'var(--tx-3)';
}

function shortTs(ts: string | null): string {
  if (!ts) { return ''; }
  return ts.replace('T', ' ').slice(0, 19);
}

export default function DispatchInspectorDetailPage({params}: {params: Promise<{id: string}>}) {
  const {id} = use(params);
  const {data, isLoading, error} = useDispatchRequest(id);
  const b = data?.booking;
  const escrow = data?.escrow ?? null;
  const mission = data?.mission ?? null;

  return (
    <Shell>
      <div className="page-head">
        <div>
          <div className="page-crumbs">Ops · Dispatch Inspector · {id.slice(-12)}</div>
          <h2 style={{display: 'flex', alignItems: 'center', gap: 10}}>
            <span className="mono" style={{color: 'var(--acc)'}}>{id.slice(-12).toUpperCase()}</span>
            {b && <span className={`pill pill-${tone(b.status)}`}>● {b.status.replace(/_/g, ' ')}</span>}
          </h2>
        </div>
        <div className="page-head-right">
          <Link href="/dispatch-inspector" className="btn btn-ghost">← BACK</Link>
        </div>
      </div>

      {error && (
        <div className="card" style={{padding: 14, color: 'var(--err)', marginBottom: 12}}>
          Failed to load · {String((error as Error).message)}
        </div>
      )}
      {isLoading && !data && (
        <div className="card" style={{padding: 14, color: 'var(--tx-3)'}}>Loading…</div>
      )}

      {b && (
        <div className="bk-detail-layout">
          {/* LEFT — offer cascade + timeline */}
          <div className="card bk-detail-left">
            <div className="card-header">
              <div className="card-header-title"><span className="bar" />Offer Cascade</div>
              <div className="card-header-act">{data?.offers.length ?? 0} OFFERS</div>
            </div>
            <div style={{padding: 14, display: 'flex', flexDirection: 'column', gap: 6}}>
              {(data?.offers ?? []).map(o => (
                <div key={o.offer_id} style={{display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--bd-2)'}}>
                  <span style={{fontFamily: 'JetBrains Mono', fontSize: 11, color: 'var(--tx-2)'}}>
                    #{o.rank} {o.agency_name ?? o.agency_call_sign ?? o.agency_email ?? o.provider_user_id.slice(0, 8)}
                    {o.distance_km !== null ? ` · ≈${Number(o.distance_km).toFixed(1)}km` : ''}
                  </span>
                  <span style={{fontFamily: 'JetBrains Mono', fontSize: 10.5, color: offerColor(o.status), textAlign: 'right'}}>
                    {o.status}{o.reject_reason ? ` · ${o.reject_reason}` : ''}
                  </span>
                </div>
              ))}
              {(data?.offers ?? []).length === 0 && (
                <div style={{color: 'var(--tx-3)', fontSize: 11.5}}>No offers were made.</div>
              )}
            </div>

            <div className="card-header" style={{borderTop: '1px solid var(--bd-2)'}}>
              <div className="card-header-title"><span className="bar" />Timeline</div>
              <div className="card-header-act">{data?.timeline.length ?? 0} EVENTS</div>
            </div>
            {(data?.timeline ?? []).map((t, i) => (
              <div key={i} className="tl-ev">
                <div className="tl-ts">{shortTs(t.at)}</div>
                <div className="tl-who">{t.actor_call ?? t.actor_role ?? t.source}</div>
                <div className="tl-msg">{t.label.replace(/_/g, ' ')}</div>
              </div>
            ))}
            {(data?.timeline ?? []).length === 0 && (
              <div style={{padding: '12px 14px', color: 'var(--tx-3)', fontSize: 11.5}}>No timeline events.</div>
            )}
          </div>

          {/* RIGHT — request, agency, crew, escrow, mission */}
          <div className="bk-detail-right">
            <div className="card">
              <div className="card-header"><div className="card-header-title"><span className="bar" />Request</div></div>
              <div style={{padding: 14, fontSize: 12.5, color: 'var(--tx-2)', lineHeight: 1.7}}>
                <div style={{color: 'var(--tx-1)'}}>{b.service} · {b.region_label} ({b.region_code})</div>
                <div>CPO ×{b.cpo_count}{b.armed_required ? ' · armed' : ''}{b.duration_hours ? ` · ${b.duration_hours}h` : ''}</div>
                {b.pickup_address && <div style={{color: 'var(--tx-3)', fontSize: 11.5}}>{b.pickup_address}</div>}
                <div style={{fontFamily: 'JetBrains Mono', fontSize: 11, marginTop: 4}}>
                  total {b.total_eur ?? '—'} BC
                </div>
              </div>
            </div>

            <div className="card">
              <div className="card-header"><div className="card-header-title"><span className="bar" />Accepting Agency</div></div>
              <div style={{padding: 14, fontSize: 12.5, color: 'var(--tx-1)'}}>
                {b.agency_name ?? b.agency_call_sign ?? '— not yet accepted —'}
                {b.agency_rating !== null ? <span style={{color: 'var(--tx-3)'}}> · ★ {Number(b.agency_rating).toFixed(1)}</span> : null}
                {b.agency_email ? <div style={{color: 'var(--tx-3)', fontSize: 11, marginTop: 2}}>{b.agency_email}</div> : null}
              </div>
            </div>

            <div className="card">
              <div className="card-header">
                <div className="card-header-title"><span className="bar" />Assigned Crew</div>
                <div className="card-header-act">{data?.crew.length ?? 0}/{b.cpo_count} CPO</div>
              </div>
              <div style={{padding: 14, display: 'flex', flexDirection: 'column', gap: 5}}>
                {(data?.crew ?? []).map(c => (
                  <div key={c.agent_id} style={{fontSize: 12.5, color: 'var(--tx-1)'}}>
                    {c.is_lead ? '★ ' : '· '}{c.call_sign || c.agent_name || c.agent_id.slice(0, 8)}
                    <span style={{color: 'var(--tx-3)'}}> — {c.role}{c.armed ? ' · armed' : ''} ({c.status})</span>
                  </div>
                ))}
                {(data?.crew ?? []).length === 0 && (
                  <div style={{color: 'var(--tx-3)', fontSize: 11.5}}>No crew assigned yet.</div>
                )}
              </div>
            </div>

            {escrow && (
              <div className="card">
                <div className="card-header">
                  <div className="card-header-title"><span className="bar" />Escrow</div>
                  <div className="card-header-act">{escrow.status}{escrow.review_required ? ' · ⚠' : ''}</div>
                </div>
                <div style={{padding: 14, fontFamily: 'JetBrains Mono', fontSize: 11.5, color: 'var(--tx-2)', lineHeight: 1.8}}>
                  gross {escrow.gross_credits} BC<br />
                  → provider {escrow.to_provider_credits ?? '—'} · fee {escrow.platform_fee_credits ?? '—'} · client {escrow.to_client_credits ?? '—'}
                  {escrow.basis ? <><br />basis {escrow.basis}</> : null}
                </div>
              </div>
            )}

            {mission && (
              <div className="card">
                <div className="card-header">
                  <div className="card-header-title"><span className="bar" />Mission</div>
                  <div className="card-header-act">{mission.status}</div>
                </div>
                <div style={{padding: 14}}>
                  <div style={{fontFamily: 'JetBrains Mono', fontSize: 11, color: 'var(--tx-3)', marginBottom: 8, lineHeight: 1.7}}>
                    {mission.pickup_at ? `pickup ${shortTs(mission.pickup_at)}` : 'awaiting pickup'}
                    {mission.live_at ? <><br />live {shortTs(mission.live_at)}</> : null}
                    {mission.ended_at ? <><br />ended {shortTs(mission.ended_at)}{mission.end_reason ? ` · ${mission.end_reason}` : ''}</> : null}
                  </div>
                  <Link href={`/live/${mission.mission_id}`} className="btn btn-sec">{mission.short_code} · OPEN →</Link>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </Shell>
  );
}
