/**
 * Deck page 5 (screen 02) — the founder struck out CANCEL BOOKING with "no
 * cancel option": "remove or restrict cancellation once the booking has reached
 * the assigned/active stage".
 *
 * The gate was `!dispatchedLive`, and `dispatchedLive` is only booking LIVE or
 * mission LIVE / SOS. Mission DISPATCHED and PICKUP were NOT covered, so the
 * client could still cancel while a crew was already assigned and driving to the
 * pickup. Server-side that cancel is accepted and, in one transaction, aborts the
 * mission, stands the crew down, deletes the mission room — and today refunds in
 * full, because the dispatch cancel-fee percentage defaults to zero.
 *
 * The B-405 constraint this must not break: the five pre-commitment states
 * (DRAFT / DISPATCHING / PENDING_OPS / OPS_APPROVED / PAYMENT_PENDING) stay
 * unconditionally cancellable with no time window — a scheduled 'later'
 * reservation can legitimately sit parked for days with zero escrow and zero
 * crew. Gating on mission_status is safe precisely because a mission_status only
 * exists once crew has accepted.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

function code(rel: string[]): string {
  const src = readFileSync(join(process.cwd(), ...rel), 'utf8').replace(/\r\n/g, '\n');
  const out: string[] = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (inBlock) {
      if (t.includes('*/')) {inBlock = false;}
      continue;
    }
    if (t.startsWith('/*') || t.startsWith('{/*')) {
      if (!t.includes('*/')) {inBlock = true;}
      continue;
    }
    if (t.startsWith('*') || t.startsWith('//')) {continue;}
    out.push(line.replace(/([^:'"`])\/\/.*$/, '$1'));
  }
  return out.join('\n');
}

const SCREEN = code(['src', 'screens', 'booking', 'BookingConfirmationScreen.tsx']);

describe('cancel disappears once a crew is committed', () => {
  it('the gate covers DISPATCHED and PICKUP, not only LIVE/SOS', () => {
    expect(SCREEN).toMatch(
      /const crewCommitted = \['DISPATCHED', 'PICKUP', 'LIVE', 'SOS'\]\.includes\(missionStatus\)/,
    );
    expect(SCREEN).toContain('const canCancel = !dispatchedLive && !crewCommitted;');
  });

  it('also covers the ASSIGNED window, before any mission_status exists', () => {
    // team.cpos populates while the booking is still CONFIRMED with
    // mission_status '' — the screenshot state: crew rows on screen with
    // CANCEL BOOKING underneath them.
    expect(SCREEN).toContain('|| team.cpos.length > 0;');
  });

  it('the control is still driven by that one flag', () => {
    expect(SCREEN).toMatch(/\{canCancel && \(/);
  });
});

describe('the pre-commitment states B-405 relies on stay cancellable', () => {
  it('the gate keys on mission_status, which only exists after crew accept', () => {
    // Gating on BOOKING status instead would have caught OPS_APPROVED, which is
    // exactly where a scheduled 'later' reservation parks — for days.
    expect(SCREEN).toMatch(/const missionStatus = \(activeBooking\?\.mission_status \?\? ''\)\.toUpperCase\(\);/);
    expect(SCREEN).not.toMatch(/crewCommitted = \[[^\]]*'OPS_APPROVED'/);
    expect(SCREEN).not.toMatch(/crewCommitted = \[[^\]]*'PENDING_OPS'/);
    expect(SCREEN).not.toMatch(/crewCommitted = \[[^\]]*'DISPATCHING'/);
  });
});
