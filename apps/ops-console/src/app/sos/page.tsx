'use client';

import {useState} from 'react';
import Link from 'next/link';
import {Shell} from '@/components/Shell';
import {ConfirmReasonModal} from '@/components/ConfirmReasonModal';
import {opsApi, useOpsMe, useSosEvents, type SosEventRow} from '@/lib/api';
import {formatDateTimeUtc} from '@/lib/datetime';

const STATUSES = ['active', 'resolved', 'all'] as const;
type SosFilter = (typeof STATUSES)[number];

const ESCALATE_TARGETS = ['POLICE', 'EMBASSY', 'CLIENT_FAMILY', 'OTHER'] as const;

type SosState = 'RESOLVED' | 'ESCALATED' | 'ACKED' | 'UNACKED';

function stateOf(r: SosEventRow): SosState {
  if (r.resolved_at) return 'RESOLVED';
  if (r.escalated_at) return 'ESCALATED';
  if (r.acknowledged_at) return 'ACKED';
  return 'UNACKED';
}

const STATE_CLASS: Record<SosState, string> = {
  RESOLVED: 'text-ok',
  ESCALATED: 'text-err',
  ACKED: 'text-acc',
  UNACKED: 'animate-pulse text-err',
};

export default function SosPage() {
  const [status, setStatus] = useState<SosFilter>('active');
  const {data, isLoading, error, mutate} = useSosEvents(status);
  const {data: me} = useOpsMe();
  const supervisor = me?.admin.role === 'SUPERVISOR' || me?.admin.role === 'ADMIN';
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [escalateTo, setEscalateTo] = useState<Record<string, string>>({});
  // IS-15 — validated resolution modal replaces window.prompt.
  const [resolveFor, setResolveFor] = useState<SosEventRow | null>(null);

  async function run(id: string, fn: () => Promise<unknown>) {
    if (busyId) return;
    setBusyId(id);
    setActionErr(null);
    try {
      await fn();
      await mutate();
    } catch (e) {
      setActionErr((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  function escalate(r: SosEventRow) {
    const target = escalateTo[r.id] ?? 'POLICE';
    if (!window.confirm(`Escalate this SOS to ${target}?`)) return;
    void run(r.id, () => opsApi.escalateSos(r.id, target));
  }

  function confirmResolve(resolution: string) {
    const r = resolveFor;
    setResolveFor(null);
    if (!r) return;
    void run(r.id, () => opsApi.resolveSos(r.id, resolution));
  }

  return (
    <Shell>
      <div className="space-y-6 p-6">
        <div>
          <h1 className="text-xl font-bold text-t1">SOS Event Log</h1>
          <p className="text-sm text-t3">
            Every SOS on the platform — including mission-less client/VBG panic events which have no
            mission drill-down. Unacknowledged events pulse red until an operator acks them.
          </p>
        </div>

        <div className="flex gap-2">
          {STATUSES.map(s => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold uppercase ${
                status === s ? 'bg-bd1 text-t1' : 'border border-bd1 text-t3 hover:bg-s1'
              }`}>
              {s}
            </button>
          ))}
        </div>

        {actionErr && <p className="text-sm text-err">{actionErr}</p>}

        {isLoading ? <p className="text-sm text-t3">Loading…</p>
          : error ? <p className="text-sm text-err">{(error as Error).message}</p>
          : (data?.length ?? 0) === 0 ? <p className="text-sm text-t3">No SOS events in this view.</p>
          : (
            <div className="overflow-hidden rounded-xl border border-bd2">
              <table className="w-full text-sm">
                <thead className="bg-s2 text-left text-xs uppercase text-t3">
                  <tr>
                    <th className="px-3 py-2">Triggered</th><th className="px-3 py-2">Who</th>
                    <th className="px-3 py-2">Reason</th><th className="px-3 py-2">Mission</th>
                    <th className="px-3 py-2">Region</th><th className="px-3 py-2">Position</th>
                    <th className="px-3 py-2">State</th><th className="px-3 py-2">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-bd2">
                  {data!.map(r => {
                    const state = stateOf(r);
                    return (
                      <tr key={r.id} className="text-t2">
                        <td className="px-3 py-2 text-t3">{formatDateTimeUtc(r.triggered_at)}</td>
                        <td className="px-3 py-2 text-t1">{r.agent_call_sign ?? r.user_display_name ?? '—'}</td>
                        <td className="px-3 py-2 text-t3">{r.reason ?? '—'}</td>
                        <td className="px-3 py-2">
                          {r.mission_id ? (
                            <Link href={`/live/${r.mission_id}`} className="font-mono text-xs text-acc hover:underline">
                              {r.mission_short_code ?? r.mission_id.slice(0, 8)}
                            </Link>
                          ) : (
                            <span className="rounded bg-warn/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-warn">
                              PANIC
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-t3">{r.region_label ?? '—'}</td>
                        <td className="px-3 py-2 font-mono text-xs text-t3">
                          {r.lat != null && r.lng != null ? `${r.lat.toFixed(4)}, ${r.lng.toFixed(4)}` : '—'}
                        </td>
                        <td className={`px-3 py-2 font-semibold ${STATE_CLASS[state]}`}>{state}</td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2">
                            {!r.acknowledged_at && (
                              <button
                                onClick={() => void run(r.id, () => opsApi.ackSos(r.id))}
                                disabled={busyId === r.id}
                                className="rounded-md border border-act/40 px-2 py-1 text-[10px] font-semibold text-acc hover:bg-act/10 disabled:opacity-50">
                                ACK
                              </button>
                            )}
                            {supervisor && r.acknowledged_at && !r.escalated_at && !r.resolved_at && (
                              <>
                                <select
                                  value={escalateTo[r.id] ?? 'POLICE'}
                                  onChange={e => setEscalateTo(p => ({...p, [r.id]: e.target.value}))}
                                  className="rounded-md border border-bd1 bg-s2 px-1.5 py-1 text-[10px] text-t2">
                                  {ESCALATE_TARGETS.map(t => <option key={t} value={t}>{t}</option>)}
                                </select>
                                <button
                                  onClick={() => escalate(r)}
                                  disabled={busyId === r.id}
                                  className="rounded-md border border-err/40 px-2 py-1 text-[10px] font-semibold text-err hover:bg-err/10 disabled:opacity-50">
                                  ESCALATE
                                </button>
                              </>
                            )}
                            {supervisor && !r.resolved_at && (
                              <button
                                onClick={() => setResolveFor(r)}
                                disabled={busyId === r.id}
                                className="rounded-md border border-ok/40 px-2 py-1 text-[10px] font-semibold text-ok hover:bg-ok/10 disabled:opacity-50">
                                RESOLVE
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
      </div>

      <ConfirmReasonModal
        open={resolveFor !== null}
        title="Resolve this SOS?"
        description={resolveFor ? `${resolveFor.agent_call_sign ?? resolveFor.user_display_name ?? 'Event'} · triggered ${formatDateTimeUtc(resolveFor.triggered_at)}` : undefined}
        reasonLabel="Resolution note"
        reasonPlaceholder="What happened and how it was closed out…"
        confirmLabel="RESOLVE SOS"
        busy={busyId !== null}
        onConfirm={confirmResolve}
        onCancel={() => setResolveFor(null)}
      />
    </Shell>
  );
}
