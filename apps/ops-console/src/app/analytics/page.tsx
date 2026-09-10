'use client';

import {useState} from 'react';
import {Shell} from '@/components/Shell';
import {useAnalytics} from '@/lib/api';

const WINDOWS = [
  {label: '7D', days: 7},
  {label: '30D', days: 30},
  {label: '90D', days: 90},
] as const;
const REGIONS = ['ALL', 'AE', 'SA', 'BD', 'GB', 'US'] as const;
type Region = (typeof REGIONS)[number];

const POSITIVE_FLOWS = new Set(['topup', 'refund', 'escrow_release']);

function humanizeDuration(s: number | null | undefined): string {
  if (!s || s <= 0) return '—';
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function Kpi({cap, num, suffix, color}: {cap: string; num: string | number; suffix?: string; color: string}) {
  return (
    <div className="kpi">
      <div className="kpi-accent" style={{background: color}} />
      <div className="kpi-cap">{cap}</div>
      <div className="kpi-num" style={{fontSize: 22}}>
        {num}
        {suffix && <span className="kpi-num-sub">{suffix}</span>}
      </div>
    </div>
  );
}

function GmvBarChart({rows}: {rows: Array<{day: string; bookings: number; gmv_bc: string}>}) {
  const W = 800;
  const H = 160;
  const chartH = H - 16;
  const max = Math.max(...rows.map(r => Number(r.gmv_bc)), 1);
  const slot = W / rows.length;
  const barW = Math.max(2, slot * 0.7);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="GMV by day">
      {rows.map((r, i) => {
        const v = Number(r.gmv_bc);
        const h = v > 0 ? Math.max(2, (v / max) * (chartH - 8)) : 0;
        const x = i * slot + (slot - barW) / 2;
        return (
          <rect key={r.day} x={x} y={chartH - h} width={barW} height={h} rx={1.5} fill="#8FB0F7" fillOpacity={0.7}>
            <title>{`${r.day.slice(0, 10)} · ${Math.round(v).toLocaleString()} BC · ${r.bookings} bookings`}</title>
          </rect>
        );
      })}
      <line x1={0} y1={chartH + 0.5} x2={W} y2={chartH + 0.5} stroke="#3f3f46" strokeWidth={1} />
      <text x={0} y={H - 3} fontSize={10} fill="#8B95A8">{rows[0].day.slice(0, 10)}</text>
      <text x={W} y={H - 3} fontSize={10} fill="#8B95A8" textAnchor="end">{rows[rows.length - 1].day.slice(0, 10)}</text>
    </svg>
  );
}

export default function AnalyticsPage() {
  const [days, setDays] = useState<number>(30);
  const [region, setRegion] = useState<Region>('ALL');
  const {data, isLoading, error} = useAnalytics(days, region === 'ALL' ? undefined : region);

  const bookingsTotal = (data?.bookings_by_day ?? []).reduce((s, d) => s + d.bookings, 0);
  const gmvTotal = (data?.bookings_by_day ?? []).reduce((s, d) => s + Number(d.gmv_bc), 0);
  const offersTotal = (data?.dispatch_offers ?? []).reduce((s, o) => s + o.count, 0);
  const offersAccepted = (data?.dispatch_offers ?? [])
    .filter(o => o.status.toLowerCase() === 'accepted')
    .reduce((s, o) => s + o.count, 0);
  const acceptPct = offersTotal > 0 ? `${Math.round((offersAccepted / offersTotal) * 100)}%` : '—';
  const maxStatusCount = Math.max(...(data?.bookings_by_status ?? []).map(s => s.count), 1);

  return (
    <Shell>
      <div className="space-y-6 p-6">
        <div>
          <h1 className="text-xl font-bold text-t1">Analytics</h1>
          <p className="text-sm text-t3">Booking, mission, dispatch and wallet rollups from /ops/analytics.</p>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <div className="flex gap-2">
            {WINDOWS.map(w => (
              <button
                key={w.label}
                onClick={() => setDays(w.days)}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold ${
                  days === w.days ? 'bg-bd1 text-t1' : 'border border-bd1 text-t3 hover:bg-s1'
                }`}>
                {w.label}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            {REGIONS.map(r => (
              <button
                key={r}
                onClick={() => setRegion(r)}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold ${
                  region === r ? 'bg-bd1 text-t1' : 'border border-bd1 text-t3 hover:bg-s1'
                }`}>
                {r}
              </button>
            ))}
          </div>
        </div>

        {isLoading ? <p className="text-sm text-t3">Loading…</p>
          : error ? <p className="text-sm text-err">{(error as Error).message}</p>
          : !data ? <p className="text-sm text-t3">No analytics available.</p>
          : (
            <>
              <div className="kpi-row" style={{gridTemplateColumns: 'repeat(6, 1fr)', marginBottom: 0}}>
                <Kpi cap="Bookings" num={bookingsTotal.toLocaleString()} color="#A9C5FF" />
                <Kpi cap="GMV" num={Math.round(gmvTotal).toLocaleString()} suffix=" BC" color="#5B8DEF" />
                <Kpi cap="Missions Completed" num={data.missions?.completed ?? 0} color="#00C853" />
                <Kpi cap="Avg Mission" num={humanizeDuration(data.missions?.avg_duration_s)} color="#FFC107" />
                <Kpi cap="SOS Events" num={data.missions?.sos_events ?? 0} color="#FF5252" />
                <Kpi cap="Dispatch Accept" num={acceptPct} color="#3BA6FF" />
              </div>

              <div className="rounded-xl border border-bd2 p-4">
                <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-t3">GMV by Day</div>
                {data.bookings_by_day.length === 0
                  ? <p className="text-sm text-t3">No bookings in this window.</p>
                  : <GmvBarChart rows={data.bookings_by_day} />}
              </div>

              <div className="grid gap-6 lg:grid-cols-2">
                <div className="rounded-xl border border-bd2 p-4">
                  <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-t3">Bookings by Status</div>
                  {data.bookings_by_status.length === 0
                    ? <p className="text-sm text-t3">No bookings in this window.</p>
                    : (
                      <div className="space-y-2">
                        {data.bookings_by_status.map(s => (
                          <div key={s.status} className="flex items-center gap-3">
                            <div className="w-40 truncate text-xs text-t3">{s.status}</div>
                            <div className="h-4 flex-1 overflow-hidden rounded bg-s2">
                              <div className="h-full rounded bg-act/40" style={{width: `${(s.count / maxStatusCount) * 100}%`}} />
                            </div>
                            <div className="w-12 text-right font-mono text-xs text-t2">{s.count}</div>
                          </div>
                        ))}
                      </div>
                    )}
                </div>

                <div className="rounded-xl border border-bd2 p-4">
                  <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-t3">Wallet Flows</div>
                  {data.wallet_flows.length === 0
                    ? <p className="text-sm text-t3">No wallet activity in this window.</p>
                    : (
                      <table className="w-full text-sm">
                        <thead className="text-left text-xs uppercase text-t3">
                          <tr>
                            <th className="py-1.5 pr-3">Type</th><th className="py-1.5 pr-3">Count</th>
                            <th className="py-1.5 text-right">Credits</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-bd2">
                          {data.wallet_flows.map(f => (
                            <tr key={f.type} className="text-t2">
                              <td className="py-1.5 pr-3 font-mono text-xs">{f.type}</td>
                              <td className="py-1.5 pr-3 font-mono text-xs text-t3">{f.count}</td>
                              <td className={`py-1.5 text-right font-mono text-xs ${
                                POSITIVE_FLOWS.has(f.type) ? 'text-ok' : 'text-t3'
                              }`}>
                                {Number(f.credits).toLocaleString()}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                </div>

                <div className="rounded-xl border border-bd2 p-4">
                  <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-t3">Regions</div>
                  {data.regions.length === 0
                    ? <p className="text-sm text-t3">No regional bookings in this window.</p>
                    : (
                      <table className="w-full text-sm">
                        <thead className="text-left text-xs uppercase text-t3">
                          <tr>
                            <th className="py-1.5 pr-3">Region</th><th className="py-1.5 pr-3">Bookings</th>
                            <th className="py-1.5 text-right">GMV BC</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-bd2">
                          {data.regions.map(r => (
                            <tr key={r.region_code} className="text-t2">
                              <td className="py-1.5 pr-3 font-mono text-xs">{r.region_code}</td>
                              <td className="py-1.5 pr-3 font-mono text-xs text-t3">{r.bookings}</td>
                              <td className="py-1.5 text-right font-mono text-xs">{Math.round(Number(r.gmv_bc)).toLocaleString()}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                </div>

                <div className={`rounded-xl border p-4 ${
                  data.signal_prekeys.low === 0 ? 'border-ok/30 bg-ok/5' : 'border-warn/30 bg-warn/5'
                }`}>
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-t3">Signal Prekey Health</div>
                  {data.signal_prekeys.low === 0 ? (
                    <p className="text-sm font-semibold text-ok">
                      All {data.signal_prekeys.total_devices} devices healthy
                    </p>
                  ) : (
                    <p className="text-sm font-semibold text-warn">
                      {data.signal_prekeys.low} of {data.signal_prekeys.total_devices} devices low on one-time prekeys (&lt;10)
                    </p>
                  )}
                  <p className="mt-1 text-xs text-t3">
                    Devices that exhaust their one-time prekeys degrade X3DH session setup for new conversations until they upload a fresh batch.
                  </p>
                </div>
              </div>
            </>
          )}
      </div>
    </Shell>
  );
}
