/**
 * B-382 — executive transfer pickup day-resolution + window gate.
 *
 * The picker chooses only a CLOCK TIME. The old code stamped it onto the start
 * DAY unconditionally, so overnight blocks (e.g. 22:00 + 6 h) could never
 * express a next-day transfer — create() 400'd `exec_transport_time_out_of_window`
 * at the LAST wizard step. These pins fail against that behavior.
 *
 * All dates are constructed in LOCAL time — the resolver mirrors the screen,
 * where the user picks local clock times against a local start Date.
 */
import {resolveTransferTime, transferTimeOutOfWindow} from '../../executive/transferTime';

// Local-time constructor (month is 0-based).
const local = (h: number, m = 0) => new Date(2026, 7, 10, h, m, 0, 0);

describe('B-382 · resolveTransferTime', () => {
  it('rolls a next-day time onto the next day for an overnight block (the B-382 dead-end)', () => {
    // Start 22:00 + 6h → window [20:00 d0, 04:00 d1]. Picking 01:00 must mean d1.
    const start = local(22);
    const r = resolveTransferTime(start, 6, 1, 0);
    expect(r.getTime() - start.getTime()).toBe(3 * 3600_000); // 01:00 next day
    expect(transferTimeOutOfWindow(r.toISOString(), start, 6)).toBe(false);
  });

  it('keeps a same-day in-window time on the start day', () => {
    const start = local(22);
    const r = resolveTransferTime(start, 6, 23, 0);
    expect(r.getTime() - start.getTime()).toBe(3600_000); // 23:00 same day
  });

  it('supports pre-positioning up to 2 h before the start', () => {
    const start = local(22);
    const r = resolveTransferTime(start, 3, 20, 30);
    expect(start.getTime() - r.getTime()).toBe(1.5 * 3600_000);
    expect(transferTimeOutOfWindow(r.toISOString(), start, 3)).toBe(false);
  });

  it('prefers the candidate nearest the start when two days are both valid (24 h block)', () => {
    // Start 01:00 + 24h → window [23:00 d-1, 01:00 d+1]. 00:30 fits d0 (pre-position)
    // AND d1 (23.5 h later) — nearest-to-start wins: d0.
    const start = local(1);
    const r = resolveTransferTime(start, 24, 0, 30);
    expect(start.getTime() - r.getTime()).toBe(30 * 60_000);
  });

  it('returns the raw start-day stamp when NO day fits (screen blocks Continue)', () => {
    // Start 22:00 + 3h → window [20:00, 01:00 d1]. 12:00 fits no day.
    const start = local(22);
    const r = resolveTransferTime(start, 3, 12, 0);
    expect(r.getHours()).toBe(12);
    expect(r.getDate()).toBe(start.getDate());
    expect(transferTimeOutOfWindow(r.toISOString(), start, 3)).toBe(true);
  });
});

describe('B-382 · transferTimeOutOfWindow boundaries', () => {
  const start = local(22);
  it('start − 2h is INSIDE (inclusive)', () => {
    expect(transferTimeOutOfWindow(new Date(start.getTime() - 2 * 3600_000).toISOString(), start, 3)).toBe(false);
  });
  it('start + block is INSIDE (inclusive)', () => {
    expect(transferTimeOutOfWindow(new Date(start.getTime() + 3 * 3600_000).toISOString(), start, 3)).toBe(false);
  });
  it('1 minute beyond either edge is OUTSIDE', () => {
    expect(transferTimeOutOfWindow(new Date(start.getTime() - 2 * 3600_000 - 60_000).toISOString(), start, 3)).toBe(true);
    expect(transferTimeOutOfWindow(new Date(start.getTime() + 3 * 3600_000 + 60_000).toISOString(), start, 3)).toBe(true);
  });
});
