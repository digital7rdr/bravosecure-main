'use client';

import {useState} from 'react';
import useSWR from 'swr';
import {Shell} from '@/components/Shell';
import {useDispatchMonitor, useOpsMe, opsApi, type FireTestDispatchArgs} from '@/lib/api';
import {canCancelDispatch, canForceAssign, canFlipKillswitch, type AdminRole} from '@/lib/rbac';

const REGIONS = [
  {code: 'AE', label: 'UAE — Dubai', lat: 25.2048, lng: 55.2708},
  {code: 'SA', label: 'Saudi — Riyadh', lat: 24.7136, lng: 46.6753},
  {code: 'BD', label: 'Bangladesh — Dhaka', lat: 23.8103, lng: 90.4125},
  {code: 'GB', label: 'UK — London', lat: 51.5074, lng: -0.1278},
];

function Countdown({expiresAt}: {expiresAt: string}) {
  const ms = new Date(expiresAt).getTime() - Date.now();
  const s = Math.max(0, Math.round(ms / 1000));
  return <span className={s > 0 ? 'text-warn' : 'text-t3'}>{s > 0 ? `${s}s` : 'expired'}</span>;
}

function offerTint(status: string): string {
  if (status === 'ACCEPTED') return 'text-ok';
  if (status === 'OFFERED') return 'text-warn';
  if (status === 'REJECTED' || status === 'EXPIRED') return 'text-t3';
  return 'text-t3';
}

export default function DispatchMonitorPage() {
  const {data, isLoading, error, mutate} = useDispatchMonitor();
  const me = useOpsMe();
  const role = me.data?.admin.role as AdminRole | undefined;
  const ks = useSWR('dispatch-killswitch', () => opsApi.killswitchState(), {refreshInterval: 5000});
  const [region, setRegion] = useState(REGIONS[0]);
  const [cpoCount, setCpoCount] = useState(1);
  const [armed, setArmed] = useState(false);
  const [firing, setFiring] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const runAction = async (id: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(id); setMsg(null);
    try { await fn(); setMsg(ok); await mutate(); }
    catch (e) { setMsg(`Failed: ${(e as Error).message}`); }
    finally { setBusy(null); }
  };

  const flipKillswitch = async (enabled: boolean) => {
    if (!window.confirm(`${enabled ? 'Enable' : 'KILL'} auto-dispatch globally?`)) {return;}
    await runAction('ks', () => opsApi.setKillswitch(enabled), `Auto-dispatch ${enabled ? 'enabled' : 'killed'}.`);
    await ks.mutate();
  };

  const fire = async () => {
    setFiring(true); setMsg(null);
    try {
      const args: FireTestDispatchArgs = {
        region_code: region.code, region_label: region.label,
        pickup_lat: region.lat, pickup_lng: region.lng,
        cpo_count: cpoCount, armed,
      };
      const r = await opsApi.fireTestDispatch(args);
      setMsg(`Fired → booking ${r.booking_id.slice(0, 8)} is now DISPATCHING.`);
      await mutate();
    } catch (e) {
      setMsg(`Failed: ${(e as Error).message}`);
    } finally {
      setFiring(false);
    }
  };

  return (
    <Shell>
      <div className="space-y-6 p-6">
        <div>
          <h1 className="text-xl font-bold text-t1">Auto-Dispatch Monitor</h1>
          <p className="text-sm text-t3">Fire a test booking through the matchmaker and watch it offer the nearest eligible agency. Polls every 2s.</p>
        </div>

        {/* Runtime kill switch */}
        <div className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4 ${
          ks.data?.enabled ? 'border-ok/40 bg-ok/10' : 'border-err/40 bg-err/10'}`}>
          <div className="text-sm">
            <span className="font-semibold text-t2">Auto-dispatch is </span>
            <span className={ks.data?.enabled ? 'font-bold text-ok' : 'font-bold text-err'}>
              {ks.data ? (ks.data.enabled ? 'LIVE' : 'OFF (legacy flow)') : '…'}
            </span>
            <span className="ml-2 font-mono text-xs text-t3">runtime={ks.data?.runtime ?? '…'}</span>
          </div>
          {canFlipKillswitch(role) && ks.data && (
            <button onClick={() => void flipKillswitch(!ks.data!.enabled)} disabled={busy === 'ks'}
              className={`rounded-md px-4 py-2 text-sm font-semibold disabled:opacity-50 ${
                ks.data.enabled ? 'bg-err-solid text-white hover:bg-err-solid/80' : 'bg-ok text-canvas hover:bg-ok/80'}`}>
              {busy === 'ks' ? '…' : ks.data.enabled ? 'Kill auto-dispatch' : 'Enable auto-dispatch'}
            </button>
          )}
        </div>

        {/* Fire test dispatch */}
        <div className="rounded-xl border border-bd2 bg-s2 p-4">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-t3">Fire test dispatch</h2>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs text-t3">
              Region
              <select className="rounded-md border border-bd1 bg-s1 px-3 py-2 text-sm text-t1"
                value={region.code} onChange={e => setRegion(REGIONS.find(r => r.code === e.target.value) ?? REGIONS[0])}>
                {REGIONS.map(r => <option key={r.code} value={r.code}>{r.label}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-t3">
              CPOs
              <input type="number" min={1} max={4} value={cpoCount}
                onChange={e => setCpoCount(Math.max(1, Math.min(4, Number(e.target.value) || 1)))}
                className="w-20 rounded-md border border-bd1 bg-s1 px-3 py-2 text-sm text-t1" />
            </label>
            <label className="flex items-center gap-2 pb-2 text-sm text-t2">
              <input type="checkbox" checked={armed} onChange={e => setArmed(e.target.checked)} /> Armed
            </label>
            {/* Audit PAGE-17 — fire-test is SUPERVISOR/ADMIN server-side; hide
                the button for OPS-tier so they don't try-and-fail into a 403. */}
            {canForceAssign(role) ? (
              <button onClick={() => void fire()} disabled={firing}
                className="rounded-md bg-act px-4 py-2 text-sm font-semibold text-white hover:bg-act-hov disabled:opacity-50">
                {firing ? 'Firing…' : 'Fire dispatch'}
              </button>
            ) : (
              <span className="self-center text-xs text-t3">Fire requires Supervisor/Admin</span>
            )}
          </div>
          {/* Audit PAGE-12 — colour failures red so a failed cancel/force-assign isn't missed. */}
          {msg && <p role="alert" className={`mt-3 text-sm ${msg.startsWith('Failed:') ? 'text-err' : 'text-t2'}`}>{msg}</p>}
          <p className="mt-2 text-xs text-t3">
            No offer appearing? The nearest eligible agency needs: a matching <code>region_code</code>, a VERIFIED
            non-expired licence + insurance, ≥1 active CPO, on-duty with a fresh location near the pickup.
          </p>
        </div>

        {/* DISPATCHING now */}
        <div>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-t3">Dispatching now</h2>
          {isLoading ? <p className="text-sm text-t3">Loading…</p>
            : error ? <p className="text-sm text-err">{(error as Error).message}</p>
            : (data?.dispatching.length ?? 0) === 0 ? <p className="text-sm text-t3">No active dispatches. Fire one above.</p>
            : (
              <div className="space-y-3">
                {data!.dispatching.map(b => (
                  <div key={b.booking_id} className="rounded-xl border border-bd2 bg-s2 p-4">
                    <div className="flex items-center justify-between">
                      <div className="text-sm text-t2">
                        <span className="font-mono text-warn">DISPATCHING</span>{' '}
                        · {b.region_code} · {b.cpo_count} CPO{b.cpo_count > 1 ? 's' : ''}{b.armed_required ? ' · armed' : ''}
                        <span className="ml-2 font-mono text-xs text-t3">{b.booking_id.slice(0, 8)}</span>
                      </div>
                      <span className="flex items-center gap-3">
                        <span className="text-xs text-t3">{b.offers.length} offer(s)</span>
                        {canCancelDispatch(role) && (
                          <button onClick={() => {
                            // Audit PAGE-08 — confirm before cancelling a live customer booking.
                            if (!window.confirm(`Cancel dispatch for booking ${b.booking_id.slice(0, 8)}?\n\nThis stops all offers for a live customer booking.`)) {return;}
                            void runAction(`cancel-${b.booking_id}`,
                              () => opsApi.cancelDispatch(b.booking_id), 'Booking cancelled.');
                          }}
                            disabled={busy === `cancel-${b.booking_id}`}
                            className="rounded-md border border-err/40 px-2.5 py-1 text-xs font-semibold text-err hover:bg-err/10 disabled:opacity-50">
                            Cancel
                          </button>
                        )}
                        {canForceAssign(role) && b.offers.some(o => o.status === 'OFFERED') && (
                          <button onClick={() => {
                            // Audit PAGE-08 — force-assign runs the real accept saga and charges escrow.
                            if (!window.confirm(`Force-assign booking ${b.booking_id.slice(0, 8)} to the live offer?\n\nThis runs the real accept saga and charges escrow to the provider.`)) {return;}
                            void runAction(`force-${b.booking_id}`,
                              () => opsApi.forceAssign(b.booking_id), 'Force-assigned to the live offer.');
                          }}
                            disabled={busy === `force-${b.booking_id}`}
                            className="rounded-md border border-act/40 px-2.5 py-1 text-xs font-semibold text-acc hover:bg-act/10 disabled:opacity-50">
                            Force-assign
                          </button>
                        )}
                      </span>
                    </div>
                    <div className="mt-3 space-y-1">
                      {b.offers.length === 0 ? (
                        <p className="text-sm text-t3">No eligible agency matched yet (or NO_PROVIDER).</p>
                      ) : b.offers.map(o => (
                        <div key={o.offer_id} className="flex items-center justify-between rounded-md bg-s1 px-3 py-2 text-sm">
                          <span className="text-t2">#{o.rank} {o.provider_email ?? o.provider_user_id.slice(0, 8)}{o.distance_km ? ` · ${Number(o.distance_km).toFixed(1)}km` : ''}</span>
                          <span className="flex items-center gap-3">
                            <span className={offerTint(o.status)}>{o.status}</span>
                            {o.status === 'OFFERED' && <Countdown expiresAt={o.expires_at} />}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
        </div>

        {/* Recently settled */}
        <div>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-t3">Recently settled (auto)</h2>
          {(data?.recent.length ?? 0) === 0 ? <p className="text-sm text-t3">None yet.</p> : (
            <div className="overflow-hidden rounded-xl border border-bd2">
              <table className="w-full text-sm">
                <thead className="bg-s2 text-left text-xs uppercase text-t3">
                  <tr><th className="px-3 py-2">Booking</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Region</th><th className="px-3 py-2">Agency</th></tr>
                </thead>
                <tbody className="divide-y divide-bd2">
                  {data!.recent.map(r => {
                    // Money-taken / no-mission watch: a CONFIRMED booking has been charged
                    // into escrow on accept but has no mission/crew yet — flag it amber.
                    const charged = r.status === 'CONFIRMED';
                    return (
                      <tr key={r.booking_id} className={charged ? 'bg-warn/10 text-warn' : 'text-t2'}>
                        <td className="px-3 py-2 font-mono text-xs">{r.booking_id.slice(0, 8)}</td>
                        <td className="px-3 py-2">{r.status}{charged ? ' · charged, awaiting crew' : ''}</td>
                        <td className="px-3 py-2">{r.region_code}</td>
                        <td className="px-3 py-2">{r.provider_email ?? '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </Shell>
  );
}
