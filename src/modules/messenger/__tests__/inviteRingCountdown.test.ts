/**
 * B-341 — the invite row's "Ringing… 1s" stuck forever on every unanswered
 * invite (founder: "the add button it stuck in 1sec remaining").
 *
 * Mechanism: the GroupCallScreen ticker gated its work on "some entry is
 * still in the future" — but the prune that removes expired entries lived
 * BELOW that gate. Final second of an unanswered invite: the last active
 * tick renders ceil(remaining)=1s, the next tick sees nothing unexpired and
 * early-returns, so the prune never runs, nowTick freezes, and the row
 * renders a permanent disabled "Ringing… 1s" (always exactly 1s: the last
 * bump lands inside the final second). Only a screen remount cleared it.
 *
 * Rule pinned here: the ticker must do its bump+prune pass whenever the map
 * is NON-EMPTY — "all entries expired" is precisely the state that needs one
 * final tick to clear. The decision is a pure helper so this project can
 * test it; a source scan pins the screen to the helper.
 */
import * as fs from 'fs';
import * as path from 'path';
import {inviteRingTickPlan} from '../runtime/groupCallRegistry';

describe('B-341 — inviteRingTickPlan', () => {
  test('empty map → null (ticker idles)', () => {
    expect(inviteRingTickPlan({}, 1_000)).toBeNull();
  });

  test('future entry survives and the ticker runs', () => {
    const plan = inviteRingTickPlan({alice: 31_000}, 1_000);
    expect(plan).not.toBeNull();
    expect(plan!.next).toEqual({alice: 31_000});
  });

  test('REGRESSION (the stuck-1s bug): an all-expired map still ticks once and prunes to empty', () => {
    const plan = inviteRingTickPlan({alice: 30_000}, 30_400);
    expect(plan).not.toBeNull();          // the old gate returned early here
    expect(plan!.next).toEqual({});       // ...so this entry lived forever
  });

  test('mixed map prunes only the expired entry', () => {
    const plan = inviteRingTickPlan({alice: 10_000, bob: 90_000}, 30_000);
    expect(plan!.next).toEqual({bob: 90_000});
  });
});

describe('B-341 — GroupCallScreen ticker is wired to the helper', () => {
  const SCREEN = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'screens', 'messenger', 'GroupCallScreen.tsx'), 'utf8');
  const stripped = SCREEN
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

  test('the interval consults inviteRingTickPlan', () => {
    expect(stripped).toMatch(/inviteRingTickPlan\(/);
  });

  test('the buggy gate shape is gone (no unexpired-scan early-return before the prune)', () => {
    // The defective pattern: a `v > now`-style active scan guarding the tick.
    expect(stripped).not.toMatch(/let active = false;/);
  });
});
