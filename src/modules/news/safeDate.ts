/**
 * Defensive date parsing for the intel feed.
 *
 * Upstream sources (RSS pubDate, Reddit/HN timestamps) occasionally carry
 * malformed or empty date strings. `new Date(bad).toISOString()` THROWS
 * (RangeError: Invalid time value), and a raw `getTime()` yields NaN that
 * poisons age formatting ("NaND AGO") and sort comparators (NaN compares
 * false → unstable order). These helpers fail soft instead.
 */

/** Parse to epoch ms, or null when the input isn't a valid date. */
export function parseDateMs(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined || input === '') {return null;}
  const ms = new Date(input).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Coerce any date-ish input to an ISO string. Invalid input falls back to
 * `fallback` (default: now), so callers never throw on `.toISOString()`.
 */
export function safeIso(
  input: string | number | null | undefined,
  fallback: number = Date.now(),
): string {
  const ms = parseDateMs(input);
  return new Date(ms ?? fallback).toISOString();
}
