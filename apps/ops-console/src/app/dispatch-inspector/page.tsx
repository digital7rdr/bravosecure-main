'use client';

import {useState} from 'react';
import {useRouter} from 'next/navigation';
import {Shell} from '@/components/Shell';
import {useDispatchRequests} from '@/lib/api';

const FILTERS: Array<{label: string; value?: string}> = [
  {label: 'All'},
  {label: 'Dispatching', value: 'DISPATCHING'},
  {label: 'Confirmed', value: 'CONFIRMED'},
  {label: 'Live', value: 'LIVE'},
  {label: 'Completed', value: 'COMPLETED'},
  {label: 'No provider', value: 'NO_PROVIDER'},
  {label: 'No-show', value: 'AGENCY_NO_SHOW'},
  {label: 'Cancelled', value: 'CANCELLED'},
];

function tone(s: string): string {
  if (s === 'CONFIRMED' || s === 'COMPLETED') { return 'ok'; }
  if (s === 'DISPATCHING') { return 'warn'; }
  if (s === 'LIVE') { return 'live'; }
  if (s === 'NO_PROVIDER' || s === 'AGENCY_NO_SHOW' || s === 'CANCELLED') { return 'err'; }
  return 'info';
}

function shortTs(ts: string | null): string {
  if (!ts) { return '—'; }
  return ts.replace('T', ' ').slice(0, 16).replace(/-/g, '/');
}

export default function DispatchInspectorPage() {
  const router = useRouter();
  const [status, setStatus] = useState<string | undefined>(undefined);
  const {data, error, isLoading} = useDispatchRequests(status);
  const rows = data ?? [];

  return (
    <Shell>
      <div className="page-head">
        <div>
          <div className="page-crumbs">Ops · Dispatch Inspector</div>
          <h2>Dispatch Requests</h2>
        </div>
        <div className="page-head-right">
          <span className="pill">{error ? 'API OFFLINE' : `${rows.length} SHOWN`}</span>
        </div>
      </div>

      <div style={{display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14}}>
        {FILTERS.map(f => {
          const active = status === f.value;
          return (
            <button key={f.label} onClick={() => setStatus(f.value)}
              style={{
                cursor: 'pointer', fontSize: 11, fontFamily: 'JetBrains Mono', letterSpacing: 0.3,
                padding: '5px 11px', borderRadius: 999,
                border: `1px solid ${active ? 'var(--act)' : 'var(--bd-2)'}`,
                background: active ? 'rgba(91,141,239,0.14)' : 'transparent',
                color: active ? 'var(--tx-1)' : 'var(--tx-3)',
              }}>
              {f.label}
            </button>
          );
        })}
      </div>

      <div className="dt-wrap" style={{flex: 1, overflow: 'auto'}}>
        <table className="dt">
          <thead>
            <tr>
              <th style={{width: 160}}>Booking #</th>
              <th style={{width: 150}}>Status</th>
              <th>Region</th>
              <th style={{width: 80}}>Crew</th>
              <th style={{width: 70}}>Offers</th>
              <th>Accepting agency</th>
              <th style={{width: 110}}>Escrow</th>
              <th style={{width: 150}}>Last activity</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && !data && (
              <tr><td colSpan={8} style={{padding: 24, textAlign: 'center', color: 'var(--tx-3)'}}>Loading…</td></tr>
            )}
            {error && (
              <tr><td colSpan={8} style={{padding: 24, textAlign: 'center', color: 'var(--err)'}}>
                Failed to load · {String((error as Error).message)}
              </td></tr>
            )}
            {!isLoading && !error && rows.length === 0 && (
              <tr><td colSpan={8} style={{padding: 24, textAlign: 'center', color: 'var(--tx-3)'}}>
                No dispatch requests yet.
              </td></tr>
            )}
            {rows.map(r => (
              <tr key={r.booking_id} style={{cursor: 'pointer'}}
                  onClick={() => router.push(`/dispatch-inspector/${r.booking_id}`)}>
                <td className="dt-idcell">{r.booking_id.slice(-12).toUpperCase()}</td>
                <td><span className={`pill pill-${tone(r.status)}`}>● {r.status.replace(/_/g, ' ')}</span></td>
                <td><span className="dt-route">{r.region_label} · {r.region_code}{r.armed_required ? ' · armed' : ''}</span></td>
                <td><span className="dt-crew">{r.crew_count}/{r.cpo_count}</span></td>
                <td><span className="dt-crew">{r.offers_count}</span></td>
                <td><span className="dt-route">{r.accepting_agency_name ?? r.accepting_agency_call_sign ?? '—'}</span></td>
                <td><span className="dt-crew">{r.escrow_status ?? '—'}</span></td>
                <td><span className="dt-when">{shortTs(r.last_activity_at)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}
