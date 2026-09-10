/**
 * UTC-everywhere date formatting for the ops console.
 *
 * Why (Audit PAGE-09): operators sit in different timezones, but a given
 * event must read as the same wall-clock everywhere, and a timestamp must
 * never disagree with the badge or bucket next to it. Roughly half the
 * console rendered dates via `toLocale*` (viewer-local) while the other
 * half used `getUTC*`; day-bucketing was computed in local time too, so a
 * `22:00Z · 6 JUL` booking badged "TOMORROW" for a UTC+4 operator. Every
 * date the console shows now goes through here, in UTC, mirroring the
 * mobile client's `@utils/datetime`.
 */

const MON_UPPER = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const MON_TITLE = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad2 = (n: number): string => n.toString().padStart(2, '0');

type DateInput = string | number | Date | null | undefined;

/** Parse to a Date; returns null on invalid input so callers show a dash. */
function toDate(input: DateInput): Date | null {
  if (input == null) return null;
  const d = input instanceof Date ? input : new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "14:23" (UTC). */
export function formatTimeUtc(input: DateInput): string {
  const d = toDate(input);
  return d ? `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}` : '—';
}

/** "14:23 · 6 JUL" (UTC) — the bookings-queue timestamp style. */
export function formatDateTimeShortUtc(input: DateInput): string {
  const d = toDate(input);
  return d
    ? `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} · ${d.getUTCDate()} ${MON_UPPER[d.getUTCMonth()]}`
    : '—';
}

/** "6 Jul 2026" (UTC). */
export function formatDateUtc(input: DateInput): string {
  const d = toDate(input);
  return d ? `${d.getUTCDate()} ${MON_TITLE[d.getUTCMonth()]} ${d.getUTCFullYear()}` : '—';
}

/** "6 Jul 2026, 14:23 UTC" — a drop-in for `Date#toLocaleString`. */
export function formatDateTimeUtc(input: DateInput): string {
  const d = toDate(input);
  return d
    ? `${d.getUTCDate()} ${MON_TITLE[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`
    : '—';
}

/**
 * Whole-day delta between an event's UTC calendar day and today's UTC
 * calendar day. Positive = future, 0 = today, negative = past. Used for
 * Today/Upcoming/Past bucketing and TODAY/TOMORROW badges so they agree
 * with the UTC timestamp shown alongside them.
 */
export function utcDayDelta(input: DateInput, now: Date = new Date()): number {
  const d = toDate(input);
  if (!d) return 0;
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((day - today) / 86_400_000);
}
