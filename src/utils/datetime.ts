// Why: every booking/job/mission/offer timestamp is stored as UTC (timestamptz)
// on the backend, and the ops console renders it in UTC. The mobile app used to
// render the same instants in the viewer's *device* timezone (toLocale*), so a
// pickup stored as 14:00Z showed "18:00" on a Gulf phone and "14:00Z" in ops —
// the two never matched and read as "out of sync with the backend".
//
// These helpers format operational timestamps in UTC everywhere, with an
// explicit 'Z' label, so mobile and ops show the exact same wall clock as the
// stored value regardless of the device's timezone. Implemented with getUTC*
// (not Intl) so the output is deterministic and engine-independent.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const pad = (n: number): string => n.toString().padStart(2, '0');

function toDate(iso: string | number | Date | null | undefined): Date | null {
  if (iso === null || iso === undefined || iso === '') {return null;}
  const d = iso instanceof Date ? iso : new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "14:00Z" — 24h UTC time with an explicit zone label. */
export function fmtTimeUtc(iso: string | number | Date | null | undefined): string {
  const d = toDate(iso);
  if (!d) {return '—';}
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`;
}

/** "Tue 23 Jun" — short weekday + day + month, in UTC. */
export function fmtDateUtc(iso: string | number | Date | null | undefined): string {
  const d = toDate(iso);
  if (!d) {return '—';}
  return `${DAYS[d.getUTCDay()]} ${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]}`;
}

/** "23 Jun" — day + month only, in UTC (compact card use). */
export function fmtDayMonthUtc(iso: string | number | Date | null | undefined): string {
  const d = toDate(iso);
  if (!d) {return '—';}
  return `${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]}`;
}

/** "Tue 23 Jun · 14:00Z" — full date + time, in UTC. */
export function fmtDateTimeUtc(iso: string | number | Date | null | undefined): string {
  const d = toDate(iso);
  if (!d) {return '—';}
  return `${fmtDateUtc(d)} · ${fmtTimeUtc(d)}`;
}

const DAY_MS = 86400000;

export interface FormatDateRangesOptions {
  /**
   * Optional status word that turns the range into a sentence (client wording
   * "Booked from 01 Sep 2026 to 05 Sep 2026"): one multi-day run → "<prefix>
   * from A to B", one day → "<prefix> on A", several runs → "<prefix> for
   * R1 · R2". Blank/absent → the bare range, unchanged.
   */
  prefix?: string;
}

/**
 * "01 Sep 2026 to 05 Sep 2026 · 10 Sep 2026" — a set of dates rendered as
 * clean "DD Mon YYYY" ranges instead of raw ISO. Sorts ascending, dedupes,
 * groups CONSECUTIVE UTC-calendar days into runs (length 1 → the single date,
 * length > 1 → "start to end"), and joins the runs with " · ". Endpoints reuse
 * fmtDayMonthUtc + the UTC year so the wall-clock day is timezone-independent
 * like every other helper here. Empty/all-invalid input → "—" (prefix or not).
 */
export function formatDateRanges(isoDates: string[], opts?: FormatDateRangesOptions): string {
  const days = Array.from(
    new Set(
      isoDates
        .map(toDate)
        .filter((d): d is Date => d !== null)
        .map(d => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())),
    ),
  ).sort((a, b) => a - b);
  if (days.length === 0) {return '—';}

  const endpoint = (ms: number): string => {
    const d = new Date(ms);
    return `${fmtDayMonthUtc(d)} ${d.getUTCFullYear()}`;
  };

  const runs: Array<{start: number; end: number}> = [];
  let start = days[0];
  let prev = days[0];
  for (let i = 1; i <= days.length; i++) {
    if (i < days.length && days[i] - prev === DAY_MS) {
      prev = days[i];
      continue;
    }
    runs.push({start, end: prev});
    if (i < days.length) {
      start = days[i];
      prev = days[i];
    }
  }
  const body = runs
    .map(r => (r.start === r.end ? endpoint(r.start) : `${endpoint(r.start)} to ${endpoint(r.end)}`))
    .join(' · ');

  const prefix = opts?.prefix?.trim();
  if (!prefix) {return body;}
  if (runs.length > 1) {return `${prefix} for ${body}`;}
  return runs[0].start === runs[0].end ? `${prefix} on ${body}` : `${prefix} from ${body}`;
}
