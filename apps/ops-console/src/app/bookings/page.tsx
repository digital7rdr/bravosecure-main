'use client';

import {useMemo, useRef, useState} from 'react';
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {Shell} from '@/components/Shell';
import {useBookings, type BookingStatus} from '@/lib/api';
import {useScrollRestoration} from '@/lib/useScrollRestoration';
import {formatDateTimeShortUtc, utcDayDelta} from '@/lib/datetime';

const STATUS_FILTERS: Array<{label: string; value?: BookingStatus; color?: string}> = [
  {label: 'ALL'},
  {label: 'Pending Ops',     value: 'PENDING_OPS',     color: 'var(--warn)'},
  {label: 'Ops Approved',    value: 'OPS_APPROVED',    color: 'var(--info)'},
  {label: 'Payment Pending', value: 'PAYMENT_PENDING', color: 'var(--warn)'},
  // SK-04 — the auto-dispatch pipeline state + its two stall outcomes.
  {label: 'Dispatching',     value: 'DISPATCHING',     color: 'var(--info)'},
  {label: 'Confirmed',       value: 'CONFIRMED',       color: 'var(--ok)'},
  {label: 'Live',            value: 'LIVE',            color: 'var(--act)'},
  {label: 'Completed',       value: 'COMPLETED',       color: 'var(--tx-3)'},
  {label: 'No Provider',     value: 'NO_PROVIDER',     color: 'var(--warn)'},
  {label: 'Agency No-Show',  value: 'AGENCY_NO_SHOW',  color: 'var(--err)'},
  {label: 'Cancelled',       value: 'CANCELLED',       color: 'var(--err)'},
];

const REGIONS = ['AE', 'SA', 'BD', 'GB', 'US'];

export default function Bookings() {
  const router = useRouter();
  const [status, setStatus] = useState<BookingStatus | undefined>(undefined);
  const [region, setRegion] = useState<string | undefined>(undefined);
  const [bucket, setBucket] = useState<TimeBucket | undefined>(undefined);
  // DC-17 — the search box and service chips were dead decoration; both now
  // filter the loaded rows client-side (the set is server-filtered already).
  const [query, setQuery] = useState('');
  const [service, setService] = useState<string | undefined>(undefined);
  // DC-09 — load-more against the server limit (was a silent 50-row cap).
  const [limit, setLimit] = useState(50);
  // Mobile only — the filter rail collapses behind a toggle (CSS shows
  // the button and hides the rail below the 900px breakpoint).
  const [filtersOpen, setFiltersOpen] = useState(false);
  const {data, error, isLoading} = useBookings(status, region, limit);

  // The table scrolls inside .dt-wrap, not the window, so Next's native
  // back/forward restoration never sees it. Restore once rows are in.
  const tableRef = useRef<HTMLDivElement>(null);
  useScrollRestoration(tableRef, !isLoading && !error);

  // Tally each time bucket across the (status/region-filtered) result so
  // the operator sees future load at a glance — "1 today, 1 upcoming".
  const all = data ?? [];
  const counts = all.reduce(
    (acc, b) => { acc[bucketOf(b.pickup_time)]++; return acc; },
    {past: 0, today: 0, upcoming: 0} as Record<TimeBucket, number>,
  );

  const services = useMemo(
    () => Array.from(new Set((data ?? []).map(b => b.service).filter(Boolean))).sort(),
    [data],
  );

  const q = query.trim().toLowerCase();
  const rows = all
    .filter(b => !bucket || bucketOf(b.pickup_time) === bucket)
    .filter(b => !service || b.service === service)
    .filter(b => !q ||
      b.id.toLowerCase().includes(q) ||
      (b.client_name ?? '').toLowerCase().includes(q) ||
      (b.region_label ?? '').toLowerCase().includes(q) ||
      (b.service ?? '').toLowerCase().includes(q) ||
      (b.pickup_address ?? '').toLowerCase().includes(q) ||
      (b.dropoff_address ?? '').toLowerCase().includes(q))
    // Soonest-first within the active view so an operator reads the
    // timeline top-to-bottom: now → later this week → next week.
    .sort((a, b) => new Date(a.pickup_time).getTime() - new Date(b.pickup_time).getTime())
    .map(b => ({
      id: b.id,
      status: b.status,
      statusType: statusTone(b.status),
      // IS-11 — the client cell shows the CLIENT, region rides the sub-line.
      client: b.client_name ?? '—',
      clientSub: [
        b.region_label ?? '',
        b.service ?? '',
        b.payer_name ? `UNDER ${b.payer_name.toUpperCase()}` : '',
      ].filter(Boolean).join(' · '),
      from: (b.pickup_address ?? '').split(',')[0],
      to:   (b.dropoff_address ?? '—').split(',')[0],
      when: formatDate(b.pickup_time),
      rel:  relativeWhen(b.pickup_time),
      crew: `CPO×${b.cpo_count} · VEH×${b.vehicle_count}`,
      val: `${Number(b.total_eur).toLocaleString()} BC`,
    }));

  // Approve from the list still requires a dress brief — bounce ops to
  // the booking detail where the modal forces it instead of silently
  // publishing without one.
  function quickApprove(id: string) {
    router.push(`/bookings/${id}`);
  }
  // Audit PAGE-13 — route reject through the detail page's validated reason
  // modal (min-length + inline error surfacing), same as quickApprove. The
  // old inline path used window.prompt (bypassing the 8-char validation the
  // detail page enforces) and swallowed any failure with no feedback.
  function quickReject(id: string) {
    router.push(`/bookings/${id}`);
  }

  return (
    <Shell>
      <div className="page-head">
        <div>
          <div className="page-crumbs">Ops · Bookings Queue</div>
          <h2>Bookings</h2>
        </div>
        <div className="page-head-right">
          <span className="pill">{error ? 'API OFFLINE' : 'API LIVE'}</span>
        </div>
      </div>

      <div className="bk-layout">
        {/* Filter rail */}
        <div className={`card bk-filter-card ${filtersOpen ? 'open' : ''}`}>
          <div className="filter-rail">
            <div className="filter-h">When</div>
            {([
              {label: 'All dates', value: undefined,    count: all.length},
              {label: 'Today',     value: 'today'    as const, count: counts.today,    color: 'var(--act)'},
              {label: 'Upcoming',  value: 'upcoming' as const, count: counts.upcoming, color: 'var(--info)'},
              {label: 'Past',      value: 'past'     as const, count: counts.past,     color: 'var(--tx-3)'},
            ]).map(f => (
              <div
                key={f.label}
                className={`filter-ch ${(f.value === bucket) ? 'on' : ''}`}
                onClick={() => setBucket(f.value)}>
                <span style={{display:'flex', alignItems:'center', gap:8}}>
                  {f.color && <span style={{width:6, height:6, borderRadius:'50%', background:f.color, display:'inline-block'}}/>}
                  {f.label}
                </span>
                <span style={{fontFamily:'JetBrains Mono', fontSize:10.5, color:'var(--tx-3)'}}>{f.count}</span>
              </div>
            ))}

            <div className="filter-h">Status</div>
            {STATUS_FILTERS.map(f => (
              <div
                key={f.label}
                className={`filter-ch ${(f.value === status || (!f.value && !status)) ? 'on' : ''}`}
                onClick={() => setStatus(f.value)}>
                <span style={{display:'flex', alignItems:'center', gap:8}}>
                  {f.color && <span style={{width:6, height:6, borderRadius:'50%', background:f.color, display:'inline-block'}}/>}
                  {f.label}
                </span>
              </div>
            ))}

            <div className="filter-h">Region</div>
            <div className="region-grid">
              {REGIONS.map(r => (
                <div
                  key={r}
                  className={`region-chip ${region === r ? 'on' : ''}`}
                  onClick={() => setRegion(region === r ? undefined : r)}>
                  {r}
                </div>
              ))}
            </div>

            <div className="filter-h">Service</div>
            <div
              className={`filter-ch ${!service ? 'on' : ''}`}
              onClick={() => setService(undefined)}>
              <span>All services</span>
            </div>
            {services.map(s => (
              <div
                key={s}
                className={`filter-ch ${service === s ? 'on' : ''}`}
                onClick={() => setService(service === s ? undefined : s)}>
                <span>{s}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Table */}
        <div className="bk-main">
          <div className="bk-toolbar">
            <button className="btn btn-sm btn-ghost bk-filter-toggle" onClick={() => setFiltersOpen(o => !o)}>
              FILTERS {filtersOpen ? '▴' : '▾'}
            </button>
            <input
              className="bk-search"
              style={{background:'transparent', border:'none', outline:'none', color:'var(--tx-1)'}}
              placeholder="Filter — booking #, client, region, service, address…"
              value={query}
              onChange={e => setQuery(e.target.value)}
              spellCheck={false}
            />
            <div className="bk-toolbar-stats">
              <span><b style={{color:'var(--act)'}}>{counts.today}</b> today</span>
              <span><b style={{color:'var(--info)'}}>{counts.upcoming}</b> upcoming</span>
              <span>Showing <b style={{color:'var(--tx-1)'}}>{rows.length}</b></span>
            </div>
          </div>
          <div className="dt-wrap" ref={tableRef} style={{flex:1, overflow:'auto'}}>
            <table className="dt">
              <thead>
                <tr>
                  <th style={{width:180}}>Booking #</th>
                  <th style={{width:160}}>Status</th>
                  <th>Client</th>
                  <th>Route</th>
                  <th style={{width:130}}>When</th>
                  <th style={{width:140}}>Crew</th>
                  <th className="num" style={{width:120}}>Value</th>
                  <th style={{width:140}}/>
                </tr>
              </thead>
              <tbody>
                {isLoading && (
                  <tr><td colSpan={8} style={{padding:24,textAlign:'center',color:'var(--tx-3)'}}>Loading…</td></tr>
                )}
                {error && (
                  <tr><td colSpan={8} style={{padding:24,textAlign:'center',color:'var(--err)'}}>
                    Failed to load · {String((error as Error).message)}
                  </td></tr>
                )}
                {!isLoading && !error && rows.length === 0 && (
                  <tr><td colSpan={8} style={{padding:24,textAlign:'center',color:'var(--tx-3)'}}>
                    No bookings match the current filter.
                  </td></tr>
                )}
                {rows.map(b => (
                  // router.push (not window.location.assign) keeps the nav
                  // client-side, so coming back is instant and the scroll
                  // restoration above has a position to return to.
                  <tr key={b.id} style={{cursor:'pointer'}} onClick={() => router.push(`/bookings/${b.id}`)}>
                    <td className="dt-idcell">
                      {b.id.length > 14 ? b.id.slice(-12).toUpperCase() : b.id}
                    </td>
                    <td>
                      <span className={`pill ${b.statusType ? `pill-${b.statusType}` : ''}`}>● {b.status.replace(/_/g, ' ')}</span>
                    </td>
                    <td>
                      <div className="dt-client">
                        <div className="dt-client-av">{b.client.slice(0, 2).toUpperCase()}</div>
                        <div><div className="dt-client-name">{b.client}</div><div className="dt-client-sub">{b.clientSub}</div></div>
                      </div>
                    </td>
                    <td>
                      <span className="dt-route">{b.from}<span className="dt-route-arrow">→</span>{b.to}</span>
                    </td>
                    <td>
                      <div style={{display:'flex', flexDirection:'column', gap:3}}>
                        <span style={{
                          alignSelf:'flex-start',
                          fontFamily:'JetBrains Mono', fontSize:9.5, fontWeight:700, letterSpacing:0.4,
                          padding:'1px 6px', borderRadius:5, textTransform:'uppercase',
                          color: whenColor(b.rel.tone),
                          background: whenBg(b.rel.tone),
                          border: `1px solid ${whenBg(b.rel.tone)}`,
                        }}>{b.rel.label}</span>
                        <span className="dt-when">{b.when}</span>
                      </div>
                    </td>
                    <td>
                      <span className="dt-crew">{b.crew}</span>
                    </td>
                    <td className="num">
                      <span className="dt-val">{b.val}</span>
                    </td>
                    {/* Action cell must not bubble into the row nav — a REJECT
                        click would otherwise also open the booking. */}
                    <td onClick={e => e.stopPropagation()}>
                      {b.status === 'PENDING_OPS' ? (
                        <div style={{display:'flex', gap:4, justifyContent:'flex-end'}}>
                          <button className="btn btn-sm btn-ok" onClick={() => quickApprove(b.id)}>
                            APPROVE
                          </button>
                          <button className="btn btn-sm btn-danger" onClick={() => quickReject(b.id)}>
                            REJECT
                          </button>
                        </div>
                      ) : (
                        <Link href={`/bookings/${b.id}`} className="btn btn-sm btn-ghost" style={{float:'right'}}>OPEN →</Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!isLoading && !error && all.length >= limit && limit < 500 && (
              <div style={{padding:'10px 0', textAlign:'center'}}>
                <button className="btn btn-sm btn-ghost" onClick={() => setLimit(l => Math.min(l + 100, 500))}>
                  LOAD MORE ({all.length} loaded)
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </Shell>
  );
}

function statusTone(s: BookingStatus): string {
  if (s === 'CONFIRMED' || s === 'COMPLETED')     return 'ok';
  if (s === 'LIVE')                               return 'live'; // pulsing live indicator, not static error red
  if (s === 'OPS_APPROVED' || s === 'DISPATCHING') return 'info';
  if (s === 'CANCELLED' || s === 'AGENCY_NO_SHOW') return 'err';
  return 'warn';
}

const formatDate = formatDateTimeShortUtc;

type TimeBucket = 'past' | 'today' | 'upcoming';

function whenColor(tone: 'today' | 'soon' | 'future' | 'past'): string {
  if (tone === 'today')  return 'var(--act)';
  if (tone === 'soon')   return 'var(--warn)';
  if (tone === 'future') return 'var(--info)';
  return 'var(--tx-3)';
}
function whenBg(tone: 'today' | 'soon' | 'future' | 'past'): string {
  if (tone === 'today')  return 'color-mix(in srgb, var(--act) 16%, transparent)';
  if (tone === 'soon')   return 'color-mix(in srgb, var(--warn) 16%, transparent)';
  if (tone === 'future') return 'color-mix(in srgb, var(--info) 16%, transparent)';
  return 'color-mix(in srgb, var(--tx-3) 14%, transparent)';
}

/**
 * Whole-day delta between the booking's pickup day and today, computed in
 * UTC (Audit PAGE-09) so the bucket/badge agrees with the UTC timestamp
 * rendered next to it.
 */
const dayDelta = (iso: string): number => utcDayDelta(iso);

function bucketOf(iso: string): TimeBucket {
  const delta = dayDelta(iso);
  if (delta < 0) return 'past';
  if (delta === 0) return 'today';
  return 'upcoming';
}

/**
 * Human "when" badge so an operator scanning the queue instantly sees
 * which bookings are future ("I have one now, but next week there's a
 * future booking"). Today/past/near-future all read at a glance.
 */
function relativeWhen(iso: string): {label: string; tone: 'today' | 'soon' | 'future' | 'past'} {
  const delta = dayDelta(iso);
  if (delta === 0)  return {label: 'TODAY',          tone: 'today'};
  if (delta === 1)  return {label: 'TOMORROW',       tone: 'soon'};
  if (delta === -1) return {label: 'YESTERDAY',      tone: 'past'};
  if (delta < 0)    return {label: `${-delta}d ago`, tone: 'past'};
  if (delta <= 7)   return {label: `in ${delta} days`,  tone: 'soon'};
  if (delta <= 14)  return {label: 'NEXT WEEK',      tone: 'future'};
  const weeks = Math.round(delta / 7);
  if (delta <= 60)  return {label: `in ${weeks} wks`, tone: 'future'};
  const d = new Date(iso);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return {label: `${months[d.getUTCMonth()]} ${d.getUTCDate()}`, tone: 'future'};
}
