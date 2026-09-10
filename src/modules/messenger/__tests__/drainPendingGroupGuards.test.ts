/**
 * sqa.md bug register — this suite pins: B-142.
 *
 * B-142 (the live group-stash drain swallowed every failure silently — the boot call site
 * attached a .catch, the live one fired after every admin create/rekey did not, so a
 * rejected void-ed promise was an unhandled rejection with no log) is pinned by the W25
 * cases, together with the in-flight guard shape choices: the guard lives INSIDE
 * drainPendingGroup, not duplicated at the two call sites, and releases in a finally.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

/**
 * W25 — the two guards on the group stash drain.
 *
 * `drainPendingGroup` is a module-private function inside an 8k-line file no
 * test can import, so this pins its structure by reading source. Both guards
 * were absent and each has a concrete failure behind it:
 *
 *  1. **The live call site had no `.catch()`** while the boot call site did. A
 *     `void`ed promise that rejects is an unhandled rejection — no diagnostic at
 *     all — and it was missing on the LIVE path, the one that fires after every
 *     admin create/rekey. So the common path was the silent one.
 *
 *  2. **No in-flight guard.** A burst of admin commits for one group (create
 *     then rekey, or several adds) fires one drain per commit, and they
 *     interleave over the SAME stash rows: every pass re-parses the same
 *     envelopes under the group master key and all but one lose the `delete`
 *     race. The txn chain serialises the writes so this was wasted work rather
 *     than corruption — still worth not doing.
 *
 * The guard is deliberately INSIDE the function rather than at the two call
 * sites: both callers are fire-and-forget, so a call-site guard means writing it
 * twice and the second copy drifting. That is the exact failure mode behind
 * B-124, B-128 and B-141 in this same file.
 *
 * See docs/runbooks/MESSAGE_LOOP.md W25.
 */

const RUNTIME = join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts');

function code(): string {
  return readFileSync(RUNTIME, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('W25 — every drainPendingGroup call site handles rejection', () => {
  it('both `void drainPendingGroup(...)` calls carry a .catch', () => {
    const src = code();
    const calls = src.match(/void drainPendingGroup\(/g) ?? [];
    expect(calls).toHaveLength(2);

    // Each call must be followed by a .catch before the next statement. A void'd
    // rejection is invisible; that is the whole bug.
    const guarded = src.match(/void drainPendingGroup\([\s\S]{0,300}?\)\s*\.catch\(/g) ?? [];
    expect(guarded).toHaveLength(2);
  });
});

describe('W25 — the in-flight guard', () => {
  it('drainPendingGroup short-circuits when a drain for that group is running', () => {
    const src = code();
    // `return false`, not a bare `return`: GF-3 made drainPendingGroup return
    // `Promise<boolean>` (stillKeyBlocked), so a bare `return` is a type error.
    // `false` is also the only correct answer here — the drain already running
    // owns the still-key-blocked verdict and reports it to its own caller.
    // Returning `true` would fire a duplicate divergence key-resync off a drain
    // this call never observed.
    expect(src).toMatch(/if \(drainsInFlight\.has\(groupId\)\)\s*\{\s*return false;\s*\}/);
    expect(src).toMatch(/drainsInFlight\.add\(groupId\)/);
  });

  it('releases the guard in a `finally`, never after the await', () => {
    // A throw between add() and delete() would wedge this groupId permanently:
    // no stashed envelope for that group would ever drain again for the life of
    // the process. That is strictly worse than the duplicate work the guard
    // exists to prevent, so the release has to be unconditional.
    const src = code();
    expect(src).toMatch(/finally\s*\{\s*drainsInFlight\.delete\(groupId\);\s*\}/);
  });

  it('the guard wraps the whole body — the inner worker is a separate function', () => {
    // Guard-then-delegate, so there is exactly one entry point to protect and no
    // early `return` inside the worker can skip the release.
    const src = code();
    expect(src).toMatch(/async function drainPendingGroupInner\(/);
    expect(src).toMatch(/await drainPendingGroupInner\(/);
  });

  it('the guard is inside the function, not duplicated at the call sites', () => {
    // Two fire-and-forget callers; a call-site guard would be written twice and
    // the second copy would drift. Exactly one add() and one delete().
    const src = code();
    expect((src.match(/drainsInFlight\.add\(/g) ?? [])).toHaveLength(1);
    expect((src.match(/drainsInFlight\.delete\(/g) ?? [])).toHaveLength(1);
  });
});
