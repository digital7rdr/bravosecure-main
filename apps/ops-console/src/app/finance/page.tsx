'use client';

import {useMemo, useState} from 'react';
import Link from 'next/link';
import {Shell} from '@/components/Shell';
import {
  ApiError, opsApi, opsDataApi, useOpsMe,
  useDisputes, useFinanceEscrows, useFinanceInvoices, useFinancePayouts,
  useFinancePromos, useFinanceTransactions, useWalletOverview,
  type FinanceTxRow,
} from '@/lib/api';
import {canAdjustWallet, canResolveDispute} from '@/lib/rbac';
import {formatDateTimeUtc} from '@/lib/datetime';
import {roleLabel} from '@/lib/format';
import {downloadCsv} from '@/lib/csv';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CREDITS_MAX = 100_000;

const TABS = ['LEDGER', 'ESCROW', 'PAYOUTS', 'DISPUTES', 'INVOICES', 'PROMOS', 'ADJUST'] as const;
type Tab = (typeof TABS)[number];

const TX_TYPES = ['all', 'topup', 'payment', 'refund', 'payout', 'expire', 'escrow_hold', 'escrow_refund', 'escrow_release'] as const;
// SK-03 — the real escrow_hold_status enum (20260620000002_escrow_integrity.sql);
// 'SPLIT' was never a value, so its chip could only ever show an empty list.
const ESCROW_STATUSES = ['all', 'HELD', 'PENDING_RELEASE', 'RELEASED', 'REFUNDED', 'PARTIAL', 'DISPUTED'] as const;

const fmt = formatDateTimeUtc;

function errText(e: unknown): string {
  if (e instanceof ApiError && e.status === 403) return 'Requires SUPERVISOR or ADMIN role.';
  return (e as Error).message;
}

function creditsClass(type: string, amount: number): string {
  if (type === 'topup' || type === 'refund' || type === 'escrow_refund') return 'text-ok';
  if (amount < 0 || type === 'payment' || type === 'escrow_hold' || type === 'expire') return 'text-err';
  return 'text-t2';
}

// CA-14 — csvEscape/downloadCsv moved to @/lib/csv with formula-injection
// hardening (leading = + - @ neutralised); shared with the audit page.

/** IS-13 — shared export button: client-side over the rows currently loaded. */
function ExportCsvButton({disabled, onClick}: {disabled: boolean; onClick: () => void}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title="Exports the loaded rows only"
      className="rounded-md border border-bd1 px-3 py-1.5 text-xs font-semibold text-t2 hover:bg-s1 disabled:cursor-not-allowed disabled:opacity-40">
      EXPORT CSV
    </button>
  );
}

const stamp = () => new Date().toISOString().slice(0, 10);

const th = 'px-3 py-2';
const tableWrap = 'overflow-x-auto rounded-xl border border-bd2';
const thead = 'bg-s2 text-left text-xs uppercase text-t3';
const chip = (on: boolean) =>
  `rounded-md px-3 py-1.5 text-xs font-semibold ${on ? 'bg-bd1 text-t1' : 'border border-bd1 text-t3 hover:bg-s1'}`;

function Panel({loading, error, empty, children}: {
  loading: boolean; error: unknown; empty: boolean; children: React.ReactNode;
}) {
  if (loading) return <p className="text-sm text-t3">Loading…</p>;
  if (error)   return <p className="text-sm text-err">{errText(error)}</p>;
  if (empty)   return <p className="text-sm text-t3">Nothing here yet.</p>;
  return <>{children}</>;
}

function LedgerTab() {
  const [type, setType] = useState<string>('all');
  const [limit, setLimit] = useState(50);
  const {data, isLoading, error} = useFinanceTransactions({type: type === 'all' ? undefined : type, limit});
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {TX_TYPES.map(t => (
          <button key={t} onClick={() => setType(t)} className={chip(type === t)}>{t.replace(/_/g, ' ')}</button>
        ))}
        <div className="flex-1" />
        <ExportCsvButton
          disabled={(data?.length ?? 0) === 0}
          onClick={() => data && downloadCsv(
            `wallet_ledger_${stamp()}.csv`,
            ['created_at', 'user', 'user_id', 'type', 'status', 'credits', 'fiat_cents', 'fiat_ccy', 'description', 'booking_id', 'settled_at'],
            data.map(r => [r.created_at, r.display_name, r.user_id, r.type, r.status, r.amount_credits, r.amount_fiat_cents, r.fiat_currency, r.description, r.booking_id, r.settled_at]),
          )}
        />
      </div>
      <Panel loading={isLoading} error={error} empty={(data?.length ?? 0) === 0}>
        <div className={tableWrap}>
          <table className="w-full text-sm">
            <thead className={thead}>
              <tr>
                <th className={th}>Time</th><th className={th}>User</th><th className={th}>Type</th>
                <th className={th}>Status</th><th className={`${th} text-right`}>Credits</th>
                <th className={th}>Fiat</th><th className={th}>Description</th><th className={th}>Booking</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-bd2">
              {(data ?? []).map((r: FinanceTxRow) => (
                <tr key={r.id} className="text-t2">
                  <td className={`${th} whitespace-nowrap text-t3`}>{fmt(r.created_at)}</td>
                  <td className={th}>
                    <div>{r.display_name ?? '—'}</div>
                    <div className="font-mono text-[10px] text-t3">{r.user_id.slice(0, 8)}</div>
                  </td>
                  <td className={`${th} font-mono text-xs`}>{r.type}</td>
                  <td className={`${th} text-xs ${r.status === 'succeeded' ? 'text-ok' : r.status === 'failed' ? 'text-err' : 'text-warn'}`}>{r.status}</td>
                  <td className={`${th} text-right font-mono font-semibold ${creditsClass(r.type, r.amount_credits)}`}>
                    {r.amount_credits.toLocaleString()} BC
                  </td>
                  <td className={`${th} text-xs text-t3`}>
                    {r.amount_fiat_cents != null ? `${(r.amount_fiat_cents / 100).toFixed(2)} ${r.fiat_currency ?? ''}` : '—'}
                  </td>
                  <td className={`${th} max-w-[260px] truncate text-t3`} title={r.description ?? ''}>{r.description ?? '—'}</td>
                  <td className={th}>
                    {r.booking_id
                      ? <Link href={`/bookings/${r.booking_id}`} className="font-mono text-xs text-acc hover:underline">{r.booking_id.slice(0, 8)}</Link>
                      : <span className="text-t3">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {(data?.length ?? 0) >= limit && limit < 200 && (
          <button onClick={() => setLimit(l => Math.min(l + 50, 200))}
            className="rounded-md border border-bd1 px-3 py-1.5 text-xs font-semibold text-t2 hover:bg-s1">
            LOAD MORE
          </button>
        )}
      </Panel>
    </div>
  );
}

function EscrowTab() {
  const [status, setStatus] = useState<string>('all');
  const {data, isLoading, error} = useFinanceEscrows(status === 'all' ? undefined : status);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {ESCROW_STATUSES.map(s => <button key={s} onClick={() => setStatus(s)} className={chip(status === s)}>{s}</button>)}
        <div className="flex-1" />
        <ExportCsvButton
          disabled={(data?.length ?? 0) === 0}
          onClick={() => data && downloadCsv(
            `escrows_${stamp()}.csv`,
            ['held_at', 'booking_id', 'booking_status', 'region', 'client', 'provider', 'gross_credits', 'to_provider', 'to_client', 'platform_fee', 'status', 'review_required', 'settled_at'],
            data.map(r => [r.held_at, r.booking_id, r.booking_status, r.region_code, r.client_name, r.provider_name, r.gross_credits, r.to_provider_credits, r.to_client_credits, r.platform_fee_credits, r.status, r.review_required, r.settled_at]),
          )}
        />
      </div>
      <Panel loading={isLoading} error={error} empty={(data?.length ?? 0) === 0}>
        <div className={tableWrap}>
          <table className="w-full text-sm">
            <thead className={thead}>
              <tr>
                <th className={th}>Held</th><th className={th}>Booking</th><th className={th}>Region</th>
                <th className={th}>Client</th><th className={th}>Provider</th>
                <th className={`${th} text-right`}>Gross</th><th className={`${th} text-right`}>Split P/C/Fee</th>
                <th className={th}>Status</th><th className={th}>Settled</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-bd2">
              {(data ?? []).map(r => (
                <tr key={r.id} className={`text-t2 ${r.review_required && !r.settled_at ? 'bg-warn/5' : ''}`}>
                  <td className={`${th} whitespace-nowrap text-t3`}>{fmt(r.held_at)}</td>
                  <td className={th}>
                    <Link href={`/bookings/${r.booking_id}`} className="font-mono text-xs text-acc hover:underline">{r.booking_id.slice(0, 8)}</Link>
                    <div className="text-[10px] text-t3">{r.booking_status}</div>
                  </td>
                  <td className={th}>{r.region_code}</td>
                  <td className={`${th} text-t3`}>{r.client_name ?? '—'}</td>
                  <td className={`${th} text-t3`}>{r.provider_name ?? '—'}</td>
                  <td className={`${th} text-right font-mono font-semibold`}>{r.gross_credits.toLocaleString()} BC</td>
                  <td className={`${th} text-right font-mono text-xs text-t3`}>
                    {r.settled_at ? `${r.to_provider_credits ?? 0}/${r.to_client_credits ?? 0}/${r.platform_fee_credits ?? 0}` : '—'}
                  </td>
                  <td className={th}>
                    <span className={r.status === 'HELD' || r.status === 'PENDING_RELEASE' ? 'text-warn' : r.status === 'REFUNDED' || r.status === 'DISPUTED' ? 'text-err' : 'text-ok'}>{r.status}</span>
                    {r.review_required && !r.settled_at && <span className="ml-2 rounded bg-warn/15 px-1.5 py-0.5 text-[10px] font-bold text-warn">REVIEW</span>}
                  </td>
                  <td className={`${th} whitespace-nowrap text-t3`}>{r.settled_at ? fmt(r.settled_at) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

function PayoutsTab() {
  const {data, isLoading, error} = useFinancePayouts();
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <ExportCsvButton
          disabled={(data?.length ?? 0) === 0}
          onClick={() => data && downloadCsv(
            `payouts_${stamp()}.csv`,
            ['decided_at', 'payee', 'call_sign', 'mission', 'region', 'proposed_credits', 'paid_credits', 'deduction_credits', 'deduction_reason'],
            data.map(r => [r.decided_at, r.payee_name, r.call_sign, r.mission_short_code, r.region_code, r.proposed_credits, r.paid_credits, r.deduction_credits, r.deduction_reason]),
          )}
        />
      </div>
      <Panel loading={isLoading} error={error} empty={(data?.length ?? 0) === 0}>
      <div className={tableWrap}>
        <table className="w-full text-sm">
          <thead className={thead}>
            <tr>
              <th className={th}>Decided</th><th className={th}>Payee</th><th className={th}>Mission</th>
              <th className={th}>Region</th><th className={`${th} text-right`}>Proposed</th>
              <th className={`${th} text-right`}>Paid</th><th className={th}>Deduction</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-bd2">
            {(data ?? []).map(r => (
              <tr key={r.id} className="text-t2">
                <td className={`${th} whitespace-nowrap text-t3`}>{r.decided_at ? fmt(r.decided_at) : '—'}</td>
                <td className={th}>
                  <div>{r.payee_name ?? r.call_sign ?? '—'}</div>
                  <div className="font-mono text-[10px] text-t3">{r.call_sign ?? ''}</div>
                </td>
                <td className={th}>
                  {r.mission_short_code && r.mission_id
                    ? <Link href={`/live/${r.mission_id}`} className="font-mono text-xs text-acc hover:underline">{r.mission_short_code}</Link>
                    : <span className="text-t3">—</span>}
                </td>
                <td className={th}>{r.region_code ?? '—'}</td>
                <td className={`${th} text-right font-mono text-t3`}>{r.proposed_credits?.toLocaleString() ?? '—'}</td>
                <td className={`${th} text-right font-mono font-semibold text-ok`}>{r.paid_credits?.toLocaleString() ?? '—'} BC</td>
                <td className={`${th} text-xs text-t3`}>
                  {r.deduction_credits ? `−${r.deduction_credits} · ${r.deduction_reason ?? ''}` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </Panel>
    </div>
  );
}

interface DisputeDraft {
  id: string;
  bookingId: string;
  gross: number | null;
  toClient: string;
  toProvider: string;
  resolution: string;
}

function DisputesTab({canResolve}: {canResolve: boolean}) {
  const {data, isLoading, error, mutate} = useDisputes();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  // CA-13/IS-05 — structured resolution modal replaces the three window.prompts.
  const [draft, setDraft] = useState<DisputeDraft | null>(null);

  const gross = draft?.gross ?? null;
  const tc = Number(draft?.toClient ?? '');
  const tp = Number(draft?.toProvider ?? '');
  const splitsOk = Number.isInteger(tc) && Number.isInteger(tp) && tc >= 0 && tp >= 0;
  const withinGross = gross == null || (splitsOk && tc + tp <= gross);
  const remainder = gross != null && splitsOk ? gross - tc - tp : null;
  const draftValid = splitsOk && withinGross && (draft?.resolution.trim().length ?? 0) >= 3;

  const submitResolve = async () => {
    if (!draft || !draftValid) return;
    setBusy(draft.id); setMsg(null);
    try {
      await opsDataApi.resolveDispute(draft.id, {to_client: tc, to_provider: tp, resolution: draft.resolution.trim()});
      setMsg('Dispute resolved.');
      setDraft(null);
      await mutate();
    } catch (e) { setMsg(`Failed: ${errText(e)}`); }
    finally { setBusy(null); }
  };

  const modalInput = 'w-full rounded-lg border border-bd1 bg-s2 px-3 py-2 font-mono text-sm text-t1 placeholder:text-t3';
  const modalLabel = 'mb-1.5 text-[10px] font-bold uppercase tracking-widest text-t3';

  return (
    <div className="space-y-3">
      {msg && <p role="alert" className={`text-sm ${msg.startsWith('Failed:') ? 'text-err' : 'text-t2'}`}>{msg}</p>}
      <div className="flex justify-end">
        <ExportCsvButton
          disabled={(data?.length ?? 0) === 0}
          onClick={() => data && downloadCsv(
            `disputes_${stamp()}.csv`,
            ['created_at', 'booking_id', 'region', 'raised_by', 'category', 'reason', 'escrow_status', 'gross_credits', 'status', 'to_client', 'to_provider', 'decided_at'],
            data.map(r => [r.created_at, r.booking_id, r.region_code, r.raised_by_name, r.category, r.reason, r.escrow_status, r.gross_credits, r.status, r.to_client_credits, r.to_provider_credits, r.decided_at]),
          )}
        />
      </div>
      <Panel loading={isLoading} error={error} empty={(data?.length ?? 0) === 0}>
        <div className={tableWrap}>
          <table className="w-full text-sm">
            <thead className={thead}>
              <tr>
                <th className={th}>Raised</th><th className={th}>Booking</th><th className={th}>Region</th>
                <th className={th}>By</th><th className={th}>Category</th><th className={th}>Reason</th>
                <th className={th}>Escrow</th><th className={th}>Status</th><th className={`${th} text-right`}>Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-bd2">
              {(data ?? []).map(r => (
                <tr key={r.id} className={`text-t2 ${r.status === 'OPEN' ? 'bg-err/5' : ''}`}>
                  <td className={`${th} whitespace-nowrap text-t3`}>{fmt(r.created_at)}</td>
                  <td className={th}>
                    <Link href={`/bookings/${r.booking_id}`} className="font-mono text-xs text-acc hover:underline">{r.booking_id.slice(0, 8)}</Link>
                  </td>
                  <td className={th}>{r.region_code}</td>
                  <td className={`${th} text-t3`}>{r.raised_by_name ?? '—'}</td>
                  <td className={`${th} capitalize`}>{r.category?.replace(/_/g, ' ') ?? '—'}</td>
                  <td className={`${th} max-w-[220px] truncate text-t3`} title={r.reason ?? ''}>{r.reason ?? '—'}</td>
                  <td className={`${th} font-mono text-xs text-t3`}>
                    {r.escrow_status ?? '—'}{r.gross_credits != null ? ` · ${r.gross_credits} BC` : ''}
                  </td>
                  <td className={th}>
                    <span className={r.status === 'OPEN' ? 'font-semibold text-err' : 'text-ok'}>{r.status}</span>
                    {r.decided_at && <div className="text-[10px] text-t3">{fmt(r.decided_at)}</div>}
                  </td>
                  <td className={`${th} text-right`}>
                    {r.status === 'OPEN' && canResolve ? (
                      <button disabled={busy === r.id}
                        onClick={() => setDraft({id: r.id, bookingId: r.booking_id, gross: r.gross_credits, toClient: '0', toProvider: '0', resolution: ''})}
                        className="rounded-md bg-ok px-3 py-1.5 text-xs font-semibold text-canvas hover:bg-ok/80 disabled:opacity-50">
                        Resolve
                      </button>
                    ) : <span className="text-xs text-t3">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {draft && (
        <div
          onClick={() => !busy && setDraft(null)}
          className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div
            onClick={e => e.stopPropagation()}
            className="w-full max-w-lg rounded-xl border border-ok/40 bg-canvas shadow-2xl">
            <div className="border-b border-bd2 px-5 py-4">
              <div className="text-xs font-bold uppercase tracking-widest text-t3">Bravo Ops · Resolve Dispute</div>
              <div className="mt-1 text-lg font-bold text-t1">Split the held escrow</div>
              <div className="mt-2 text-sm text-t3">
                Booking <span className="font-mono text-xs text-acc">{draft.bookingId.slice(0, 8)}</span> · escrow gross{' '}
                <b className="text-t1">{gross != null ? `${gross.toLocaleString()} BC` : 'unknown'}</b>.
                Anything not returned or paid out stays with the platform.
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4 px-5 py-4">
              <div>
                <div className={modalLabel}>To client (BC)</div>
                <input className={modalInput} inputMode="numeric" value={draft.toClient}
                  onChange={e => setDraft(d => d && {...d, toClient: e.target.value.replace(/[^\d]/g, '')})} />
              </div>
              <div>
                <div className={modalLabel}>To provider (BC)</div>
                <input className={modalInput} inputMode="numeric" value={draft.toProvider}
                  onChange={e => setDraft(d => d && {...d, toProvider: e.target.value.replace(/[^\d]/g, '')})} />
              </div>
              <div className="col-span-2">
                <div className={modalLabel}>Resolution note (required, client + provider visible in audit)</div>
                <textarea className={`${modalInput} min-h-[64px] resize-y font-sans`} value={draft.resolution}
                  onChange={e => setDraft(d => d && {...d, resolution: e.target.value})}
                  placeholder="What was decided and why…" />
              </div>
              <div className="col-span-2 rounded-lg border border-bd2 bg-s2 px-3 py-2 text-sm">
                {!splitsOk ? (
                  <span className="text-err">Splits must be non-negative integers.</span>
                ) : !withinGross ? (
                  <span className="text-err">
                    Split exceeds the escrow — {`${(tc + tp).toLocaleString()} > ${gross?.toLocaleString()}`} BC.
                  </span>
                ) : (
                  <span className="text-t2">
                    Client ← <b className="text-ok">{tc.toLocaleString()}</b> ·
                    Provider ← <b className="text-ok">{tp.toLocaleString()}</b>
                    {remainder != null && <> · Platform keeps <b className="text-t1">{remainder.toLocaleString()}</b> BC</>}
                  </span>
                )}
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-bd2 px-5 py-3.5">
              <button disabled={busy === draft.id} onClick={() => setDraft(null)}
                className="rounded-md border border-bd1 px-3 py-1.5 text-xs font-semibold text-t2 hover:bg-s1 disabled:opacity-50">
                CANCEL
              </button>
              <button disabled={busy === draft.id || !draftValid} onClick={() => void submitResolve()}
                className="rounded-md bg-ok px-3 py-1.5 text-xs font-semibold text-canvas hover:bg-ok/80 disabled:opacity-50">
                {busy === draft.id ? 'RESOLVING…' : 'CONFIRM RESOLUTION'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function InvoicesTab() {
  const {data, isLoading, error} = useFinanceInvoices();
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <ExportCsvButton
          disabled={(data?.length ?? 0) === 0}
          onClick={() => data && downloadCsv(
            `invoices_${stamp()}.csv`,
            ['invoice_number', 'issued_at', 'kind', 'region', 'booking_id', 'subtotal_credits', 'tax_credits', 'total_credits', 'currency'],
            data.map(r => [r.invoice_number, r.issued_at, r.kind, r.region_code, r.booking_id, r.subtotal_credits, r.tax_credits, r.total_credits, r.currency]),
          )}
        />
      </div>
      <Panel loading={isLoading} error={error} empty={(data?.length ?? 0) === 0}>
      <div className={tableWrap}>
        <table className="w-full text-sm">
          <thead className={thead}>
            <tr>
              <th className={th}>Number</th><th className={th}>Issued</th><th className={th}>Kind</th>
              <th className={th}>Region</th><th className={th}>Booking</th>
              <th className={`${th} text-right`}>Subtotal</th><th className={`${th} text-right`}>Tax</th>
              <th className={`${th} text-right`}>Total</th><th className={th}>PDF</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-bd2">
            {(data ?? []).map(r => (
              <tr key={r.id} className="text-t2">
                <td className={`${th} font-mono text-xs text-acc`}>{r.invoice_number}</td>
                <td className={`${th} whitespace-nowrap text-t3`}>{fmt(r.issued_at)}</td>
                <td className={`${th} text-xs uppercase`}>{r.kind}</td>
                <td className={th}>{r.region_code ?? '—'}</td>
                <td className={th}>
                  {r.booking_id
                    ? <Link href={`/bookings/${r.booking_id}`} className="font-mono text-xs text-acc hover:underline">{r.booking_id.slice(0, 8)}</Link>
                    : '—'}
                </td>
                <td className={`${th} text-right font-mono`}>{r.subtotal_credits.toLocaleString()}</td>
                <td className={`${th} text-right font-mono text-t3`}>{r.tax_credits.toLocaleString()}</td>
                <td className={`${th} text-right font-mono font-semibold`}>{r.total_credits.toLocaleString()} {r.currency}</td>
                <td className={th}>
                  {r.pdf_url ? <a href={r.pdf_url} target="_blank" rel="noreferrer" className="text-xs text-acc hover:underline">open</a> : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </Panel>
    </div>
  );
}

function PromosTab() {
  const {data, isLoading, error} = useFinancePromos();
  return (
    <Panel loading={isLoading} error={error} empty={(data?.length ?? 0) === 0}>
      <div className={tableWrap}>
        <table className="w-full text-sm">
          <thead className={thead}>
            <tr>
              <th className={th}>Code</th><th className={`${th} text-right`}>Credits</th>
              <th className={`${th} text-right`}>Redemptions</th><th className={th}>Expires</th>
              <th className={th}>Active</th><th className={th}>Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-bd2">
            {(data ?? []).map(r => (
              <tr key={r.id} className="text-t2">
                <td className={`${th} font-mono font-semibold text-acc`}>{r.code}</td>
                <td className={`${th} text-right font-mono`}>{r.credits.toLocaleString()} BC</td>
                <td className={`${th} text-right font-mono text-t3`}>{r.redeemed_count}{r.max_redemptions ? ` / ${r.max_redemptions}` : ''}</td>
                <td className={`${th} text-t3`}>{r.expires_at ? fmt(r.expires_at) : '—'}</td>
                <td className={th}>{r.active ? <span className="text-ok">yes</span> : <span className="text-t3">no</span>}</td>
                <td className={`${th} whitespace-nowrap text-t3`}>{fmt(r.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function AdjustTab({canAdjust}: {canAdjust: boolean}) {
  const [userId, setUserId] = useState('');
  const [credits, setCredits] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{balance: number; txId: string} | null>(null);

  const validUuid = UUID_RE.test(userId.trim());
  // Why: the DC-01 fix — the adjust form gets ledger context, so credits are
  // never moved against a wallet the operator hasn't just looked at.
  const {data: overview, error: overviewErr} = useWalletOverview(validUuid ? userId.trim() : null);

  const creditsNum = Number(credits);
  const creditsOk = credits.trim() !== '' && Number.isInteger(creditsNum) &&
    creditsNum !== 0 && Math.abs(creditsNum) <= CREDITS_MAX;
  const valid = validUuid && creditsOk && reason.trim().length >= 3;

  async function submit() {
    if (busy || !valid) return;
    const verb = creditsNum > 0 ? 'CREDIT' : 'DEDUCT';
    const prep = creditsNum > 0 ? 'to' : 'from';
    const who = overview ? `${overview.user.display_name ?? 'user'} (${overview.balance.bravo_credits.toLocaleString()} BC now)` : userId.trim();
    if (!window.confirm(
      `${verb} ${Math.abs(creditsNum).toLocaleString()} BC ${prep} wallet of\n${who}\n\nReason: ${reason.trim()}\n\nThis writes to the wallet ledger immediately and cannot be undone from here.`,
    )) return;
    setBusy(true); setErr(null); setDone(null);
    try {
      const r = await opsApi.adjustWallet(userId.trim(), {credits: creditsNum, reason: reason.trim()});
      setDone({balance: r.balance.bravo_credits, txId: r.transaction_id});
      setCredits(''); setReason('');
    } catch (e) { setErr(errText(e)); }
    finally { setBusy(false); }
  }

  if (!canAdjust) {
    return <p className="text-sm text-t3">Credit adjustments require SUPERVISOR or ADMIN.</p>;
  }

  const input = 'w-full rounded-lg border border-bd1 bg-s2 px-3 py-2 font-mono text-xs text-t1 placeholder:text-t3';
  const label = 'mb-1.5 text-[10px] font-bold uppercase tracking-widest text-t3';

  return (
    <div className="flex flex-wrap items-start gap-4">
      <div className="w-[420px] space-y-3 rounded-xl border border-bd2 p-4">
        <div>
          <div className={label}>User ID (UUID)</div>
          <input className={input} value={userId} onChange={e => setUserId(e.target.value)}
            placeholder="00000000-0000-0000-0000-000000000000" spellCheck={false} />
        </div>
        <div>
          <div className={label}>Credits (± integer, max {CREDITS_MAX.toLocaleString()})</div>
          <input className={input} value={credits} onChange={e => setCredits(e.target.value)}
            placeholder="e.g. 500 or -250" inputMode="numeric" />
        </div>
        <div>
          <div className={label}>Reason (required)</div>
          <textarea className={`${input} min-h-[64px] resize-none font-sans`} value={reason}
            onChange={e => setReason(e.target.value)} placeholder="Why this adjustment is being made…" />
        </div>
        <button disabled={busy || !valid} onClick={() => void submit()}
          className="w-full rounded-md bg-ok px-3 py-2 text-xs font-bold text-canvas hover:bg-ok/80 disabled:opacity-50">
          {busy ? 'ADJUSTING…' : 'APPLY ADJUSTMENT'}
        </button>
        {err && <p className="text-xs text-err">✗ {err}</p>}
        {done && (
          <div className="rounded-lg border border-ok/40 bg-s2 px-3 py-2 text-xs text-t2">
            ✓ Applied. New balance <b className="text-t1">{done.balance.toLocaleString()} BC</b>
            <div className="font-mono text-[10px] text-t3">{done.txId}</div>
          </div>
        )}
        <p className="text-[10px] leading-relaxed text-t3">
          Every adjustment is written to the wallet ledger with the acting admin and reason — there are no silent balance changes.
        </p>
      </div>

      <div className="min-w-[380px] flex-1 rounded-xl border border-bd2 p-4">
        {!validUuid ? <p className="text-sm text-t3">Enter a user UUID to see their wallet before adjusting.</p>
          : overviewErr ? <p className="text-sm text-err">{errText(overviewErr)}</p>
          : !overview ? <p className="text-sm text-t3">Loading wallet…</p>
          : (
            <div className="space-y-3">
              <div className="flex items-baseline justify-between">
                <div>
                  <div className="text-sm font-semibold text-t1">{overview.user.display_name ?? '—'}</div>
                  <div className="text-xs text-t3">{roleLabel(overview.user.role)} · KYC {overview.user.kyc_status} · {overview.user.subscription_tier}</div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-lg font-bold text-ok">{overview.balance.bravo_credits.toLocaleString()} BC</div>
                  <div className="text-[10px] text-t3">{overview.balance.updated_at ? fmt(overview.balance.updated_at) : ''}</div>
                </div>
              </div>
              <div>
                <div className={label}>Recent ledger</div>
                <div className="divide-y divide-bd2 rounded-lg border border-bd2">
                  {overview.transactions.length === 0 && <p className="px-3 py-2 text-xs text-t3">No transactions.</p>}
                  {overview.transactions.slice(0, 10).map(t => (
                    <div key={t.id} className="flex items-center justify-between px-3 py-1.5 text-xs">
                      <span className="text-t3">{fmt(t.created_at)}</span>
                      <span className="font-mono text-t3">{t.type}</span>
                      <span className={`font-mono font-semibold ${creditsClass(t.type, t.amount_credits)}`}>{t.amount_credits.toLocaleString()} BC</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
      </div>
    </div>
  );
}

export default function Finance() {
  const {data: me} = useOpsMe();
  const role = me?.admin.role;
  const canAdjust = canAdjustWallet(role);
  const canResolve = canResolveDispute(role);
  const [tab, setTab] = useState<Tab>('LEDGER');

  const tabs = useMemo(() => TABS, []);

  return (
    <Shell>
      <div className="space-y-6 p-6">
        <div>
          <h1 className="text-xl font-bold text-t1">Finance</h1>
          <p className="text-sm text-t3">
            Wallet ledger, escrow settlement, payouts, disputes, invoices and promos — read straight from the money tables.
            Ledger reads require SUPERVISOR+.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {tabs.map(t => <button key={t} onClick={() => setTab(t)} className={chip(tab === t)}>{t}</button>)}
        </div>

        {tab === 'LEDGER'   && <LedgerTab />}
        {tab === 'ESCROW'   && <EscrowTab />}
        {tab === 'PAYOUTS'  && <PayoutsTab />}
        {tab === 'DISPUTES' && <DisputesTab canResolve={canResolve} />}
        {tab === 'INVOICES' && <InvoicesTab />}
        {tab === 'PROMOS'   && <PromosTab />}
        {tab === 'ADJUST'   && <AdjustTab canAdjust={canAdjust} />}
      </div>
    </Shell>
  );
}
