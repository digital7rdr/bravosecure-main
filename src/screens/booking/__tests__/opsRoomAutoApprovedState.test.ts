/**
 * B-405 — an approved auto/'later' booking must be visibly APPROVED on the
 * client (founder repro, 2026-08-09; fixed same day).
 *
 * Original defect: booking 79779a68 (auto + 'later', pickup 3 days out) was
 * ops-approved at 06:03:49Z yet OpsRoomReviewScreen kept rendering the pending
 * hero — the poll only advanced auto bookings on DISPATCHING, which for a
 * 'later' booking is days away (T-15 sweep). The founder concluded the
 * approval never happened and cancelled a live booking at 06:11:03Z.
 *
 * The fix adds a 'scheduled' state: OPS_APPROVED + auto + 'later' renders the
 * approved hero (nothing charged until CPO accept), keeps CANCEL REQUEST, and
 * never locks back for 'later' bookings. Not-paying stays BY DESIGN for auto
 * bookings — escrow charges at CPO accept, so the !isAuto pay guard must stay.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const SCREEN = join(process.cwd(), 'src', 'screens', 'ops', 'OpsRoomReviewScreen.tsx');

/** Code only — comments stripped line-wise, CRLF-safe (CLAUDE.md scan traps). */
function code(): string {
  const src = readFileSync(SCREEN, 'utf8').replace(/\r\n/g, '\n');
  const out: string[] = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    const trimmed = line.trim();
    if (inBlock) {
      if (trimmed.includes('*/')) {inBlock = false;}
      continue;
    }
    if (trimmed.startsWith('/*') || trimmed.startsWith('{/*')) {
      if (!trimmed.includes('*/')) {inBlock = true;}
      continue;
    }
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) {continue;}
    out.push(line.replace(/([^:'"`])\/\/.*$/, '$1'));
  }
  return out.join('\n');
}

describe('B-405 — OpsRoomReview renders the approved state for scheduled auto bookings', () => {
  it('keeps the by-design guard: an auto booking never enters the auto-pay countdown', () => {
    // Escrow charges at CPO accept; approval must NOT trigger payWithCredits
    // for dispatch_mode='auto'. This half was always correct and must stay.
    expect(code()).toMatch(
      /\(status === 'OPS_APPROVED' \|\| status === 'PAYMENT_PENDING'\) && !isAuto/,
    );
  });

  it('the poll flips an approved auto later booking into the scheduled state', () => {
    // The decision site: OPS_APPROVED + auto + 'later' → setState('scheduled').
    expect(code()).toMatch(
      /status === 'OPS_APPROVED' && isAuto && ab\?\.booking_mode === 'later'/,
    );
    expect(code()).toMatch(/setState\('scheduled'\)/);
  });

  it('the scheduled state renders approved copy, not the pending hero', () => {
    const src = code();
    expect(src).toContain('APPROVED — DETAIL SCHEDULED');
    // Charged-at-accept honesty line — the founder expected a pay prompt;
    // the screen must say why there is none.
    expect(src).toMatch(/Nothing is charged\s*[\s\S]{0,40}until a protection officer accepts/);
    // And the pending hero still exists for genuinely pending bookings.
    expect(src).toContain('AWAITING BRAVO CONTROL SYSTEM APPROVAL');
  });

  it("a 'later' reservation never locks the client in", () => {
    // lockBack must exempt later bookings in the pending phase — the client
    // was sent home at submit and re-enters this screen only by choice.
    expect(code()).toMatch(/state === 'pending' && !isLaterBooking/);
  });

  it('cancel stays available in the scheduled state (pre-commitment escape hatch)', () => {
    expect(code()).toMatch(/\(state === 'pending' \|\| state === 'scheduled'\) &&/);
  });
});
