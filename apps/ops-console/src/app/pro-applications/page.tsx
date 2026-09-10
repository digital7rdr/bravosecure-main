'use client';

/**
 * Bravo Secure Pro applications — the review queue. New applications appear as
 * cards without a refresh (POLL_MSN cadence, same "real-time feel" as the
 * dispatch monitor). Click-through to the detail/proposal builder.
 * IS-08/CA-10: actionable tabs (NEW / REVISION) arrive oldest-first from the
 * server; LOAD MORE raises the window; the search box filters loaded rows and
 * every tab chip carries a live count from the loaded 'all' set.
 */
import {useRouter} from 'next/navigation';
import {useMemo, useState} from 'react';
import {Shell} from '@/components/Shell';
import {useProApplications} from '@/lib/api';
import {durationLabel, intendedUseLabel, proStatusTone} from '@/lib/proapps';
import {formatDateTimeShortUtc, formatDateUtc} from '@/lib/datetime';

const TABS: Array<{key: string; label: string}> = [
  {key: 'PENDING_PROPOSAL', label: 'NEW'},
  {key: 'REVISION_REQUESTED', label: 'REVISION'},
  {key: 'PROPOSAL_CREATED', label: 'PROPOSAL SENT'},
  {key: 'ACCEPTED', label: 'ACCEPTED'},
  {key: 'ACTIVE', label: 'ACTIVE'},
  {key: 'EXPIRED', label: 'EXPIRED'},
  {key: 'REJECTED', label: 'REJECTED'},
  {key: 'CANCELLED', label: 'CANCELLED'},
  {key: 'all', label: 'ALL'},
];

const PAGE = 50;
const MAX_LIMIT = 200;

export default function ProApplicationsPage() {
  const router = useRouter();
  const [tab, setTab] = useState('PENDING_PROPOSAL');
  const [limit, setLimit] = useState(PAGE);
  const [query, setQuery] = useState('');
  const {data, error, isLoading} = useProApplications(tab, limit);
  // Counts source — the loaded 'all' window (no dedicated count endpoint yet).
  const {data: allData} = useProApplications('all', MAX_LIMIT);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const row of allData?.applications ?? []) {
      c[row.status] = (c[row.status] ?? 0) + 1;
      c.all = (c.all ?? 0) + 1;
    }
    return c;
  }, [allData]);

  const q = query.trim().toLowerCase();
  const rows = (data?.applications ?? []).filter(row => !q ||
    row.id.toLowerCase().includes(q) ||
    (row.client_name ?? '').toLowerCase().includes(q) ||
    (row.client_email ?? '').toLowerCase().includes(q));

  return (
    <Shell>
      <div className="page-head">
        <div>
          <div className="page-crumbs">OPERATIONS · BRAVO SECURE PRO</div>
          <h1>Pro Applications</h1>
        </div>
      </div>

      <div style={{display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12}}>
        {TABS.map(t => (
          <button
            key={t.key}
            className={`filter-ch${tab === t.key ? ' on' : ''}`}
            onClick={() => { setTab(t.key); setLimit(PAGE); }}>
            {t.label}{counts[t.key] ? ` · ${counts[t.key]}` : ''}
          </button>
        ))}
      </div>

      <div className="card" style={{padding: '8px 14px', marginBottom: 14}}>
        <input
          style={{background: 'transparent', border: 'none', outline: 'none', color: 'var(--tx-1)', width: '100%', fontFamily: 'Manrope', fontSize: 13}}
          placeholder="Filter loaded — client name, email, application id…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          spellCheck={false}
        />
      </div>

      {error ? (
        <div role="alert" style={{
          background: 'rgba(220,38,38,0.1)', border: '1px solid var(--err)',
          color: '#FFB4B4', borderRadius: 10, padding: '10px 14px',
          fontSize: 12.5, marginBottom: 14,
        }}>
          API ERROR · {(error as Error).message}
        </div>
      ) : null}

      {rows.length === 0 && !isLoading ? (
        <div className="card" style={{padding: 28, textAlign: 'center', color: 'var(--tx-3)', fontSize: 13}}>
          {q ? 'No loaded application matches the filter.' : 'No applications in this bucket.'}
        </div>
      ) : (
        <div style={{display: 'grid', gap: 10}}>
          {rows.map(row => (
            <div
              key={row.id}
              className="card"
              role="button"
              tabIndex={0}
              onClick={() => router.push(`/pro-applications/${row.id}`)}
              onKeyDown={e => { if (e.key === 'Enter') router.push(`/pro-applications/${row.id}`); }}
              style={{
                padding: '14px 16px', cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 16,
              }}>
              <div style={{flex: '1 1 220px', minWidth: 0}}>
                <div style={{
                  fontWeight: 700, fontSize: 13.5, color: 'var(--tx-1)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {row.client_name || row.client_email}
                </div>
                <div style={{
                  fontSize: 11, color: 'var(--tx-3)', marginTop: 3,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {intendedUseLabel(row)} · {durationLabel(row)} · from {formatDateUtc(row.start_date)}
                </div>
              </div>

              <div style={{flex: '1 1 180px', minWidth: 0, fontSize: 11.5, color: 'var(--tx-2)'}}>
                <div style={{overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>
                  {row.cpo_count} CPO · {row.driver_count} DRV · {row.support_staff_count} SUP
                </div>
                <div style={{
                  color: 'var(--tx-3)', marginTop: 3,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {row.coverage_area}
                </div>
              </div>

              <div style={{textAlign: 'right', flexShrink: 0}}>
                {row.total_credits ? (
                  <div style={{fontSize: 12.5, fontWeight: 700, color: 'var(--acc)'}}>
                    {Number(row.total_credits).toLocaleString()} BC<span style={{color: 'var(--tx-3)', fontWeight: 400}}> total</span>
                    {row.proposal_version && row.proposal_version > 1 ? (
                      <span style={{color: 'var(--tx-3)', fontWeight: 400}}> · v{row.proposal_version}</span>
                    ) : null}
                  </div>
                ) : (
                  <div style={{fontSize: 11, color: 'var(--tx-3)'}}>no proposal yet</div>
                )}
                {/* SK-01 — ACTIVE plans show the LAST COVERED DAY, never the
                    exclusive period end. */}
                {row.status === 'ACTIVE' && (row.covered_until ?? row.current_period_end) ? (
                  <div style={{fontSize: 10.5, color: 'var(--ok)', marginTop: 3}}>
                    covered until {formatDateUtc((row.covered_until ?? row.current_period_end)!)}
                  </div>
                ) : null}
                <div style={{fontSize: 10.5, color: 'var(--tx-3)', marginTop: 3}}>
                  {formatDateTimeShortUtc(row.submitted_at)}
                </div>
              </div>

              <span className={`pill pill-${proStatusTone(row.status)}`} style={{flexShrink: 0}}>
                ● {row.status.replace(/_/g, ' ')}
              </span>
            </div>
          ))}
          {!q && (data?.applications?.length ?? 0) >= limit && limit < MAX_LIMIT ? (
            <div style={{textAlign: 'center', padding: '6px 0'}}>
              <button className="btn btn-sm btn-ghost" onClick={() => setLimit(l => Math.min(l + PAGE, MAX_LIMIT))}>
                LOAD MORE ({data?.applications?.length ?? 0} loaded)
              </button>
            </div>
          ) : null}
        </div>
      )}
    </Shell>
  );
}
