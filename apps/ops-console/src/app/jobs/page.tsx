'use client';

import { Shell } from '@/components/Shell';
import Link from 'next/link';
import { useJobs, type JobRow, type JobStatus } from '@/lib/api';
import { formatDateTimeShortUtc } from '@/lib/datetime';

const COLUMNS: Array<{label: string; status: JobStatus; dot: string}> = [
  {label: 'Published',           status: 'PUBLISHED',  dot: 'var(--warn)'},
  {label: 'Review Applications', status: 'REVIEW',     dot: 'var(--info)'},
  {label: 'Assigned',            status: 'ASSIGNED',   dot: 'var(--act)'},
  {label: 'Dispatched',          status: 'DISPATCHED', dot: 'var(--ok)'},
];

function timeRemaining(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'NOW';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}h ${m.toString().padStart(2,'0')}m`;
}

export default function Jobs() {
  const { data: jobs, isLoading, error } = useJobs();

  const grouped: Record<JobStatus, JobRow[]> = {
    PUBLISHED: [], REVIEW: [], ASSIGNED: [], DISPATCHED: [], CANCELLED: [],
  };
  (jobs ?? []).forEach(j => { (grouped[j.status] ?? []).push(j); });

  // Audit PAGE-21 — a job whose status isn't one of the known buckets used
  // to push into a throwaway array and vanish from the board with no trace.
  // Surface the count + the unrecognized statuses so a newly-added backend
  // status is visible instead of silently dropped.
  const KNOWN_STATUSES = new Set<string>(['PUBLISHED', 'REVIEW', 'ASSIGNED', 'DISPATCHED', 'CANCELLED']);
  const unknownJobs = (jobs ?? []).filter(j => !KNOWN_STATUSES.has(j.status));
  const unknownStatuses = Array.from(new Set(unknownJobs.map(j => j.status)));

  const total = (jobs ?? []).filter(j => j.status !== 'CANCELLED').length;

  return (
    <Shell>
      <div className="page-head">
        <div><div className="page-crumbs">Ops · Job Feed</div><h2>Job Pipeline</h2></div>
        <div className="page-head-right">
          {unknownJobs.length > 0 && (
            <span className="pill pill-warn" title={`Statuses not shown on the board: ${unknownStatuses.join(', ')}`}>
              ⚠ {unknownJobs.length} OTHER ({unknownStatuses.join(', ')})
            </span>
          )}
          <span className="pill pill-info">● {total} OPEN</span>
        </div>
      </div>

      {isLoading && (
        <div style={{flex:1, display:'flex', alignItems:'center', justifyContent:'center', gap:12, color:'var(--tx-3)', fontSize:12}}>
          <span className="spinner spinner-lg" />
          Loading jobs…
        </div>
      )}
      {error && (
        <div style={{padding:32,color:'var(--err)'}}>Failed to load jobs · {String((error as Error).message)}</div>
      )}

      {!isLoading && !error && (
        <div style={{display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:12, flex:1, minHeight:0}}>
          {COLUMNS.map(col => {
            const cards = grouped[col.status] ?? [];
            return (
              <div key={col.status} className="kb-col">
                <div className="kb-col-head">
                  <div className="kb-col-head-title">
                    <span className="kb-col-dot" style={{background:col.dot}}/>
                    {col.label}
                  </div>
                  <span className="kb-col-cnt">{cards.length}</span>
                </div>
                <div className="kb-body">
                  {cards.length === 0 && (
                    <div style={{padding:16,color:'var(--tx-3)',fontSize:11,textAlign:'center'}}>—</div>
                  )}
                  {cards.map(j => {
                    const remColour =
                      col.status === 'REVIEW'     ? 'var(--info)' :
                      col.status === 'DISPATCHED' ? 'var(--ok)'   :
                      undefined;
                    const remLabel =
                      col.status === 'REVIEW'     ? 'READY'   :
                      col.status === 'DISPATCHED' ? '● LIVE'  :
                      timeRemaining(j.dispatch_at);
                    return (
                      <Link key={j.id} href={`/jobs/${j.id}`} style={{textDecoration:'none', display:'block'}}>
                        <div className="kb-card">
                          <div className="kb-card-id">
                            {j.short_code}
                            <span className="kb-card-rem" style={remColour ? {color:remColour} : undefined}>{remLabel}</span>
                          </div>
                          <div className="kb-card-route">{j.route_label}</div>
                          <div className="kb-card-meta">
                            <span>{formatDateTimeShortUtc(j.dispatch_at)}</span>
                            <span><b>CPO×{j.cpo_slots}</b></span>
                            <span>{j.region_code}</span>
                          </div>
                          <div className="kb-card-foot">
                            <div className="kb-card-apps">
                              <b>{j.slots_filled}</b>/<b>{j.cpo_slots}</b> filled
                            </div>
                          </div>
                        </div>
                      </Link>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Shell>
  );
}
