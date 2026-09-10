/**
 * B-382 — resolve the DAY of an executive transfer pickup from a clock-time
 * pick. The server window is [start − 2h, start + block]; the time picker only
 * chooses hours:minutes, and stamping them onto the start DAY made any
 * next-day transfer (overnight blocks) unexpressible — create() 400'd
 * `exec_transport_time_out_of_window` at the LAST wizard step.
 *
 * Pure and dependency-free so the booking Jest project can pin the window
 * math directly (the screen imports this).
 */

export const TRANSFER_WINDOW_BEFORE_MS = 2 * 3600_000;

/** Try start-day −1 / start-day / start-day +1; keep the in-window candidate
 *  nearest the start. Falls back to the raw start-day stamp when NO candidate
 *  fits (the screen then blocks Continue with an inline explanation). */
export function resolveTransferTime(
  start: Date,
  durationHours: number,
  hours: number,
  minutes: number,
): Date {
  const windowStartMs = start.getTime() - TRANSFER_WINDOW_BEFORE_MS;
  const windowEndMs = start.getTime() + durationHours * 3600_000;
  const base = new Date(start);
  base.setHours(hours, minutes, 0, 0);
  // setDate, not ±86_400_000 ms: across a DST boundary a fixed-ms day shifts the
  // LOCAL clock time by an hour, so the user's 01:00 would store as 00:00/02:00.
  const candidates = [-1, 0, 1].map(dd => {
    const c = new Date(base);
    c.setDate(c.getDate() + dd);
    return c;
  });
  const valid = candidates.filter(c => c.getTime() >= windowStartMs && c.getTime() <= windowEndMs);
  if (valid.length === 0) {return base;}
  valid.sort((a, b) =>
    Math.abs(a.getTime() - start.getTime()) - Math.abs(b.getTime() - start.getTime()));
  return valid[0];
}

/** True when a stored transfer time falls outside the server window — the
 *  screen blocks Continue on this (create() would reject it anyway; failing at
 *  the LAST wizard step with a raw code was the B-382 dead-end). */
export function transferTimeOutOfWindow(
  transferIso: string,
  start: Date,
  durationHours: number,
): boolean {
  const t = new Date(transferIso).getTime();
  return t < start.getTime() - TRANSFER_WINDOW_BEFORE_MS
      || t > start.getTime() + durationHours * 3600_000;
}
