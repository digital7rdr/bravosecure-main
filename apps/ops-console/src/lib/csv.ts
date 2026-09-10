/**
 * CA-14 (audit 2026-08-07) — hardened client-side CSV building.
 *
 * Spreadsheet apps execute a cell that begins with = + - or @ as a formula,
 * so a user-controlled value like `=HYPERLINK(...)` in a display name would
 * run on the operator's machine when they open an export. Neutralise by
 * prefixing a single quote (the OWASP-recommended mitigation) before the
 * usual quote-wrap. Every console CSV export must route through here.
 */
export function csvEscape(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  // Real numbers can't carry formulas — don't mangle negative credit amounts.
  if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function downloadCsv(filename: string, header: string[], rows: unknown[][]): void {
  const body = [header, ...rows].map(r => r.map(csvEscape).join(',')).join('\r\n');
  const blob = new Blob([body], {type: 'text/csv;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}
