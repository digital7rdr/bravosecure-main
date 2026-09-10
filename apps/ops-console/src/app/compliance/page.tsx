'use client';

import {useState} from 'react';
import Link from 'next/link';
import {Shell} from '@/components/Shell';
import {ConfirmReasonModal} from '@/components/ConfirmReasonModal';
import {useCompliancePending, useOpsMe, opsApi, opsDataApi, type CompliancePendingRow} from '@/lib/api';
import {canReviewCompliance} from '@/lib/rbac';

// Audit PAGE-18 — floor, not round: a doc that expired up to 12h ago used
// to round to 0 and render amber "0d" instead of red "expired".
function daysToExpiry(iso: string): number {
  return Math.floor((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

export default function CompliancePage() {
  const {data, isLoading, error, mutate} = useCompliancePending();
  const {data: me} = useOpsMe();
  const canReview = canReviewCompliance(me?.admin.role);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  // IS-15 — validated reject modal replaces window.prompt.
  const [rejectFor, setRejectFor] = useState<CompliancePendingRow | null>(null);

  const act = async (id: string, fn: () => Promise<unknown>, label: string) => {
    setBusy(id); setMsg(null);
    try { await fn(); setMsg(`${label} done.`); await mutate(); }
    catch (e) { setMsg(`Failed: ${(e as Error).message}`); }
    finally { setBusy(null); }
  };

  // DC-03 — armed permits live on armed_authorizations and use their own
  // verify/reject endpoints; credential rows keep the compliance ones.
  const verify = (id: string, armed: boolean) =>
    void act(id, () => (armed ? opsDataApi.verifyArmed(id) : opsApi.verifyCompliance(id)), 'Verify');

  const confirmReject = (reason: string) => {
    const r = rejectFor;
    setRejectFor(null);
    if (!r) return;
    void act(r.id, () => (r.armed ? opsDataApi.rejectArmed(r.id, reason) : opsApi.rejectCompliance(r.id, reason)), 'Reject');
  };

  return (
    <Shell>
      <div className="space-y-6 p-6">
        <div>
          <h1 className="text-xl font-bold text-t1">Compliance Review</h1>
          <p className="text-sm text-t3">Verify provider licence / insurance / armed-permit docs. A provider is NOT dispatch-eligible until verified.</p>
        </div>
        {/* Audit PAGE-18 — colour failures red so a failed verify isn't missed. */}
        {msg && <p role="alert" className={`text-sm ${msg.startsWith('Failed:') ? 'text-err' : 'text-t2'}`}>{msg}</p>}
        {!canReview && (
          <p className="text-xs text-t3">Read-only — verifying / rejecting compliance docs requires Supervisor or Admin.</p>
        )}

        {isLoading ? <p className="text-sm text-t3">Loading…</p>
          : error ? <p className="text-sm text-err">{(error as Error).message}</p>
          : (data?.length ?? 0) === 0 ? <p className="text-sm text-t3">No pending compliance docs. 🎉</p>
          : (
            <div className="overflow-hidden rounded-xl border border-bd2">
              <table className="w-full text-sm">
                <thead className="bg-s2 text-left text-xs uppercase text-t3">
                  <tr>
                    <th className="px-3 py-2">Type</th><th className="px-3 py-2">Provider</th>
                    <th className="px-3 py-2">Region</th><th className="px-3 py-2">Ref</th>
                    <th className="px-3 py-2">Doc</th>
                    <th className="px-3 py-2">Expires</th><th className="px-3 py-2 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-bd2">
                  {data!.map(r => {
                    const dte = daysToExpiry(r.expires_at);
                    return (
                      <tr key={r.id} className="text-t2">
                        <td className="px-3 py-2 font-semibold uppercase text-warn">
                          {r.doc_type}
                          {r.armed && <span className="ml-2 rounded bg-err/15 px-1.5 py-0.5 text-[10px] font-bold text-err">ARMED</span>}
                        </td>
                        {/* IS-06 — the reviewer sees WHO submitted, linked to the agent record. */}
                        <td className="px-3 py-2">
                          <Link href={`/agents/${r.subject_user_id}`} className="text-acc hover:underline">
                            {r.provider_name ?? r.subject_user_id.slice(0, 8)}
                          </Link>
                          <div className="font-mono text-[10px] text-t3">{r.subject_user_id.slice(0, 8)}</div>
                        </td>
                        <td className="px-3 py-2">{r.region_code}</td>
                        <td className="px-3 py-2 text-t3">{r.reference ?? '—'}</td>
                        <td className="px-3 py-2">
                          {r.file_url ? (
                            <a href={r.file_url} target="_blank" rel="noreferrer"
                              className="text-xs font-semibold text-acc hover:underline">
                              VIEW DOC
                            </a>
                          ) : (
                            <span className="text-xs text-t3">—</span>
                          )}
                        </td>
                        <td className={`px-3 py-2 ${dte < 0 ? 'text-err' : dte < 30 ? 'text-warn' : 'text-t3'}`}>
                          {dte < 0 ? 'expired' : `${dte}d`}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {/* Audit PAGE-18 — hide verify/reject from OPS-tier (server is SUPERVISOR+). */}
                          {canReview ? (
                            <>
                              <button disabled={busy === r.id}
                                onClick={() => verify(r.id, r.armed)}
                                className="mr-2 rounded-md bg-ok px-3 py-1.5 text-xs font-semibold text-canvas hover:bg-ok/80 disabled:opacity-50">
                                Verify
                              </button>
                              <button disabled={busy === r.id} onClick={() => setRejectFor(r)}
                                className="rounded-md border border-bd1 px-3 py-1.5 text-xs font-semibold text-t2 hover:bg-s1 disabled:opacity-50">
                                Reject
                              </button>
                            </>
                          ) : (
                            <span className="text-xs text-t3">—</span>
                          )}
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
        open={rejectFor !== null}
        title={`Reject this ${rejectFor?.doc_type ?? 'document'}?`}
        description={rejectFor ? `${rejectFor.provider_name ?? rejectFor.subject_user_id.slice(0, 8)} · ${rejectFor.region_code}. The provider sees this reason and stays dispatch-ineligible.` : undefined}
        reasonLabel="Reject reason"
        reasonPlaceholder="e.g. Document illegible; licence number mismatch…"
        confirmLabel="REJECT DOC"
        danger
        busy={busy !== null}
        onConfirm={confirmReject}
        onCancel={() => setRejectFor(null)}
      />
    </Shell>
  );
}
