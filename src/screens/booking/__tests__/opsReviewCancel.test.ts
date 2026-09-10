import * as fs from 'fs';
import * as path from 'path';

/**
 * B-92 — source-level lock (navigatorConfig idiom: rendering the screen would
 * pull the whole booking tree into Jest).
 *
 * A PENDING_OPS request can sit in the ops queue for days, and the review
 * screen deliberately blocks hardware back while pending — so the CANCEL
 * REQUEST escape hatch is the client's ONLY way out. Lock the invariants:
 *
 *   1. The pending state renders a cancel affordance.
 *   2. It cancels through the store action (which also flips the local list
 *      row), not a raw one-off API call.
 *   3. It confirms first (destructive action) and unwinds the wizard stack
 *      to the booking home on success.
 */
const SRC = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'ops', 'OpsRoomReviewScreen.tsx'),
  'utf8',
);

describe('B-92 — ops-review pending state offers a cancel escape hatch', () => {
  it('renders the CANCEL REQUEST control in the pending state (and B-405 scheduled)', () => {
    expect(SRC).toContain('CANCEL REQUEST');
    // B-405 widened the gate: an approved-and-parked 'later' reservation keeps
    // the same pre-commitment escape hatch as a pending one.
    expect(SRC).toMatch(/\(state === 'pending' \|\| state === 'scheduled'\) && \(\s*<TouchableOpacity/);
  });

  it('cancels via the store action and unwinds to the booking home', () => {
    expect(SRC).toContain('.cancelBooking(bookingId)');
    expect(SRC).toContain('navigation.popToTop()');
  });

  it('confirms before withdrawing (destructive pattern with a keep-waiting path)', () => {
    expect(SRC).toContain("'Cancel this request?'");
    expect(SRC).toContain("text: 'Keep Waiting', style: 'cancel'");
    expect(SRC).toMatch(/text: 'Cancel Request',\s*\n\s*style: 'destructive'/);
  });
});
