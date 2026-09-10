/**
 * Developer feedback, August 2026 — screen 01 of 19 ("Approval and
 * cancellation layout"), founder's annotated device screenshots.
 *
 * Three corrections were required on OpsRoomReviewScreen:
 *
 *   1. "Avoid duplicating the same waiting status in multiple large panels."
 *      The screen told the SAME pending status four times: the nav pill, the
 *      hourglass hero, a decorative Pending|Approved|Rejected tri-state row,
 *      and a locked "WAITING FOR BRAVO CONTROL SYSTEM" footer bar. Only the
 *      first two survive — the pill (compact) and the hero (the one panel).
 *
 *   2. "Move the cancellation action to a consistent, easy-to-find position
 *      near the booking controls." CANCEL REQUEST was buried at the bottom of
 *      the status hero, so it moved with the hero's content. It now lives in
 *      the fixed bottom controls slot, below the ScrollView.
 *
 *   3. "Keep the pending approval status clear." Handwritten on the shot:
 *      "last screen chance to cancel request — after this no more cancel".
 *      That expectation is now stated in the UI instead of being folklore.
 *
 * A fourth defect fell out of the rework: dismissing the auto-pay sheet on an
 * APPROVED booking dropped the user back onto a bar reading "WAITING FOR
 * BRAVO CONTROL SYSTEM" — i.e. the screen claimed the booking was still
 * un-reviewed when ops had already approved it. The approved state now offers
 * the real next action.
 *
 * Source scan (the navigatorConfig idiom): rendering this screen would pull
 * the whole booking tree into Jest. Comments are stripped line-wise and the
 * file is read CRLF-normalised — both are CLAUDE.md scan traps.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const SCREEN = join(process.cwd(), 'src', 'screens', 'ops', 'OpsRoomReviewScreen.tsx');

/** Code only — comments stripped line-wise, CRLF-safe. */
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

describe('dev-feedback screen 01 — the waiting status is told ONCE', () => {
  it('does not re-add the locked "waiting" footer bar', () => {
    // The hero and the nav pill already carry this. A fourth panel repeating
    // it is exactly what the founder struck out.
    expect(code()).not.toContain('WAITING FOR BRAVO CONTROL SYSTEM');
  });

  it('does not re-add the decorative Pending/Approved/Rejected tri-state row', () => {
    const src = code();
    expect(src).not.toMatch(/statusRow/);
    expect(src).not.toMatch(/statusBtn/);
    // The map that painted the three cells is gone with it.
    expect(src).not.toMatch(/\['pending', 'approved', 'rejected'\]/);
  });

  it('keeps the two survivors — the compact nav pill and the single status hero', () => {
    const src = code();
    expect(src).toContain('BRAVO CONTROL SYSTEM REVIEW');
    expect(src).toContain('AWAITING BRAVO CONTROL SYSTEM APPROVAL');
    // The pill still renders all three verdicts from one expression.
    expect(src).toMatch(/approvedish \? 'Approved' : state === 'rejected' \? 'Rejected' : 'Pending'/);
  });
});

describe('dev-feedback screen 01 — cancel sits in the booking controls slot', () => {
  it('renders CANCEL REQUEST below the ScrollView, not inside the status hero', () => {
    const src = code();
    const scrollEnd = src.indexOf('</ScrollView>');
    const cancel = src.indexOf('CANCEL REQUEST');
    expect(scrollEnd).toBeGreaterThan(-1);
    expect(cancel).toBeGreaterThan(-1);
    // The whole point of the move: the control is in the fixed bottom slot,
    // so it is in the same place at every stage instead of scrolling with
    // the hero's content.
    expect(cancel).toBeGreaterThan(scrollEnd);
  });

  it('renders the cancel control exactly once', () => {
    // It used to live in the hero; a copy left behind would put two cancel
    // buttons on the pending screen.
    expect(code().match(/CANCEL REQUEST/g)).toHaveLength(1);
  });

  it('states when cancellation expires, next to the control', () => {
    const src = code();
    expect(src).toContain('Last chance to cancel');
    expect(src).toContain('Bravo Control System assigns your detail');
    expect(src).toContain('can no longer be cancelled');
    // The note must sit ABOVE the button it describes.
    expect(src.indexOf('Last chance to cancel')).toBeLessThan(src.indexOf('CANCEL REQUEST'));
  });

  it('B-405 — a scheduled reservation gets honest copy, not the last-chance warning', () => {
    // An approved-and-parked 'later' booking stays freely cancellable until a
    // CPO accepts, so the pending screen's warning would be a lie there.
    const src = code();
    expect(src).toMatch(/state === 'scheduled'\s*\n?\s*\? 'Free to cancel until a protection officer accepts/);
  });
});

describe('dev-feedback screen 01 — the approved state states its real next action', () => {
  it('offers PAY NOW rather than a bar claiming the booking is still under review', () => {
    const src = code();
    expect(src).toMatch(/state === 'approved' \?/);
    expect(src).toContain('APPROVED · PAY NOW');
  });

  it('PAY NOW resumes the auto-debit countdown', () => {
    // Dismissing the sheet sets payState 'idle'; this is the way back in.
    expect(code()).toMatch(
      /setCountdown\(COUNTDOWN_SECONDS\); setPayState\('countdown'\);[\s\S]{0,400}APPROVED · PAY NOW/,
    );
  });
});
