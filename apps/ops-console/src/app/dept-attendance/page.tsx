'use client';

import {useState} from 'react';
import {Shell} from '@/components/Shell';
import {opsApi, useProOrgs, type DeptAttendanceSummary} from '@/lib/api';

const STAT_ORDER: {key: string; label: string; cls: string}[] = [
  {key: 'present', label: 'Present', cls: 'text-ok'},
  {key: 'late', label: 'Late', cls: 'text-warn'},
  {key: 'absent', label: 'Absent', cls: 'text-err'},
  {key: 'early_checkout', label: 'Early out', cls: 'text-warn'},
  {key: 'leave', label: 'Leave', cls: 'text-acc'},
  {key: 'sick_leave', label: 'Sick', cls: 'text-acc'},
  {key: 'off_duty', label: 'Off duty', cls: 'text-t3'},
  {key: 'pending_review', label: 'Pending', cls: 'text-warn'},
];

// Minimal CSV parser for the server's quote-wrapped export (PDF report source).
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { cell += ch; }
    } else if (ch === '"') { inQuotes = true; }
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') { i++; }
      row.push(cell); cell = '';
      if (row.some(c => c !== '')) { rows.push(row); }
      row = [];
    } else { cell += ch; }
  }
  row.push(cell);
  if (row.some(c => c !== '')) { rows.push(row); }
  return rows;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const MANUAL = '__manual__';

export default function DeptAttendancePage() {
  // SK-13 — a picker over the orgs the platform actually knows, instead of a
  // blind UUID box (a typo'd UUID just 404'd). The orgs list endpoint is
  // open to every admin tier, same as this page. Manual UUID stays as an
  // escape hatch for orgs outside that listing.
  const {data: orgData, error: orgListError} = useProOrgs();
  const [picked, setPicked] = useState('');
  const [manualId, setManualId] = useState('');
  const orgId = picked === MANUAL ? manualId : picked;
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [summary, setSummary] = useState<DeptAttendanceSummary | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Audit PAGE-10 — build both bounds in UTC. A bare date string parses as
  // UTC midnight but `${to}T23:59:59` (no offset) parses as LOCAL, so in
  // UTC+4 the range ended at 19:59:59Z and silently dropped the last ~4h
  // of the "To" day from the summary + audited export. Pin both to Z.
  const range = () => ({
    from: from ? new Date(`${from}T00:00:00Z`).toISOString() : undefined,
    to: to ? new Date(`${to}T23:59:59Z`).toISOString() : undefined,
  });

  const load = async () => {
    if (!orgId.trim()) {return;}
    setBusy(true); setMsg(null);
    try {
      const r = range();
      setSummary(await opsApi.deptAttendanceSummary(orgId.trim(), r.from, r.to));
    } catch (e) { setSummary(null); setMsg(`Failed: ${(e as Error).message}`); }
    finally { setBusy(false); }
  };

  const fetchCsv = async (): Promise<string> => {
    const r = range();
    return opsApi.deptAttendanceExport(orgId.trim(), r.from, r.to);
  };

  const exportCsv = async () => {
    if (!orgId.trim()) {return;}
    setBusy(true); setMsg(null);
    try {
      const csv = await fetchCsv();
      const url = URL.createObjectURL(new Blob([csv], {type: 'text/csv'}));
      const a = document.createElement('a');
      a.href = url;
      a.download = `attendance-${orgId.trim().slice(0, 8)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      setMsg('Export downloaded (biometric-free).');
    } catch (e) {
      // Audit PAGE-14 — only attribute the failure to permissions on a real
      // 403; a 500/network error read as "requires Supervisor/Admin" during
      // an outage and wasted escalation time.
      const status = (e as {status?: number}).status;
      const hint = status === 403 ? ' — export requires Supervisor/Admin.' : '';
      setMsg(`Export failed: ${(e as Error).message}${hint}`);
    } finally { setBusy(false); }
  };

  // PDF export (PDF spec p.10): rendered client-side from the same audited CSV
  // endpoint — a print-formatted report window; the browser's Save-as-PDF does
  // the rest. No extra dependency, and the server audit row still records the
  // export (who/when/filters).
  const exportPdf = async () => {
    if (!orgId.trim()) {return;}
    setBusy(true); setMsg(null);
    try {
      const csv = await fetchCsv();
      const rows = parseCsv(csv);
      const header = rows[0] ?? [];
      const body = rows.slice(1);
      const rangeLabel = from || to ? `${from || 'start'} → ${to || 'now'}` : 'All dates';
      const win = window.open('', '_blank');
      if (!win) { setMsg('Popup blocked — allow popups to generate the PDF report.'); return; }
      win.document.write(`<!DOCTYPE html>
<html><head><title>Attendance Report</title>
<style>
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; color: #111; margin: 32px; }
  h1 { font-size: 20px; margin: 0 0 2px; }
  .meta { color: #555; font-size: 12px; margin-bottom: 18px; }
  table { border-collapse: collapse; width: 100%; font-size: 11px; }
  th { text-align: left; background: #0b1220; color: #fff; padding: 6px 8px; }
  td { padding: 5px 8px; border-bottom: 1px solid #ddd; }
  tr:nth-child(even) td { background: #f6f7f9; }
  .foot { margin-top: 16px; color: #777; font-size: 10px; }
  @media print { .noprint { display: none; } }
</style></head><body>
<h1>Bravo Secure — Attendance Report</h1>
<div class="meta">Org ${escapeHtml(orgId.trim())} · ${escapeHtml(rangeLabel)} · Generated ${new Date().toLocaleString()} · ${body.length} session(s)</div>
<table>
<thead><tr>${header.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
<tbody>${body.map(r => `<tr>${r.map(c => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody>
</table>
<div class="foot">Biometric-free export · verification results only · this export is audit-logged.</div>
<script>window.onload = () => window.print();</script>
</body></html>`);
      win.document.close();
      setMsg('PDF report opened — use the print dialog to save as PDF.');
    } catch (e) {
      // Audit PAGE-14 — only attribute the failure to permissions on a real
      // 403; a 500/network error read as "requires Supervisor/Admin" during
      // an outage and wasted escalation time.
      const status = (e as {status?: number}).status;
      const hint = status === 403 ? ' — export requires Supervisor/Admin.' : '';
      setMsg(`Export failed: ${(e as Error).message}${hint}`);
    } finally { setBusy(false); }
  };

  return (
    <Shell>
      <div className="space-y-6 p-6">
        <div>
          <h1 className="text-xl font-bold text-t1">Attendance Oversight</h1>
          <p className="text-sm text-t3">
            Per-org attendance summary + controlled PDF/CSV export. Exports exclude all biometric data and are
            audit-logged.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={picked}
            onChange={e => setPicked(e.target.value)}
            className="w-72 rounded-md border border-bd1 bg-s2 px-3 py-2 text-xs text-t2">
            <option value="">Select organisation…</option>
            {(orgData?.orgs ?? []).map(o => (
              <option key={o.id} value={o.id}>{o.display_name}{o.internal ? ' (internal)' : ''}</option>
            ))}
            <option value={MANUAL}>Manual UUID…</option>
          </select>
          {picked === MANUAL && (
            <input
              value={manualId}
              onChange={e => setManualId(e.target.value)}
              placeholder="Org user id (UUID)"
              className="w-80 rounded-md border border-bd1 bg-s2 px-3 py-2 font-mono text-xs text-t2 placeholder-t3"
            />
          )}
          {orgListError != null && picked !== MANUAL && (
            <span className="text-xs text-warn">Org list unavailable — use Manual UUID.</span>
          )}
          <label className="flex items-center gap-1 text-xs text-t3">
            From
            <input
              type="date"
              value={from}
              onChange={e => setFrom(e.target.value)}
              className="rounded-md border border-bd1 bg-s2 px-2 py-2 text-xs text-t2"
            />
          </label>
          <label className="flex items-center gap-1 text-xs text-t3">
            To
            <input
              type="date"
              value={to}
              onChange={e => setTo(e.target.value)}
              className="rounded-md border border-bd1 bg-s2 px-2 py-2 text-xs text-t2"
            />
          </label>
          <button
            disabled={busy || !orgId.trim()}
            onClick={() => void load()}
            className="rounded-md bg-act px-3 py-2 text-xs font-semibold text-white hover:bg-act-hov disabled:opacity-50">
            Load summary
          </button>
          <button
            disabled={busy || !orgId.trim()}
            onClick={() => void exportCsv()}
            className="rounded-md border border-bd1 px-3 py-2 text-xs font-semibold text-t2 hover:bg-s1 disabled:opacity-50">
            Export CSV
          </button>
          <button
            disabled={busy || !orgId.trim()}
            onClick={() => void exportPdf()}
            className="rounded-md border border-bd1 px-3 py-2 text-xs font-semibold text-t2 hover:bg-s1 disabled:opacity-50">
            Export PDF
          </button>
        </div>

        {msg && <p className="text-sm text-t2">{msg}</p>}

        {summary && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {STAT_ORDER.filter(s => (summary.counts[s.key] ?? 0) > 0 || s.key === 'present').map(s => (
                <div key={s.key} className="rounded-xl border border-bd2 bg-s2 p-4">
                  <div className={`text-2xl font-bold ${s.cls}`}>{summary.counts[s.key] ?? 0}</div>
                  <div className="mt-1 text-xs uppercase tracking-wide text-t3">{s.label}</div>
                </div>
              ))}
            </div>
            <p className="text-sm text-t3">
              {summary.total} session(s) · <span className="text-warn">{summary.pendingReview} pending review</span>
            </p>
          </div>
        )}
      </div>
    </Shell>
  );
}
