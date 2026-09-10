import {readFileSync} from 'node:fs';
import {join} from 'node:path';

/**
 * B-602 — source scan for the runtime's depsReady-buffer gate: the LIVE
 * group-ring frames must be exempted the same way 1:1 call frames are, so a
 * cold-boot ring is not buffered behind the SQLCipher hydrate (which stranded
 * the B-479 restore-mode park/ack lane while 1:1 calls rang through).
 *
 * `productionRuntime.ts` is ~8k lines and NO test can import it (B-125: a
 * green suite is not evidence for that file), so the bypass is pinned here as
 * a source scan — same idiom as notifLatencyBootInvariants / stashDrainGateParity.
 * The file is CRLF: every assertion is index-based on comment-stripped source,
 * never `\n`-anchored. If one fails, do NOT relax it — re-establish the gate.
 */
const RUNTIME = join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts');

/** Strip comments so a scan sees CODE, not the prose that explains it. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('B-602 — group-ring frames bypass the depsReady buffer', () => {
  const src = stripComments(readFileSync(RUNTIME, 'utf8'));

  it('imports isGroupRingFrame from the pure predicate module', () => {
    // Same module as isCallFrame — one eager import, no lazy require in the
    // hot onFrame path.
    expect(src).toMatch(/import\s*\{[^}]*\bisGroupRingFrame\b[^}]*\}\s*from\s*['"]\.\/callFrameRouter['"]/);
  });

  it('the buffer gate exempts BOTH call frames and group-ring frames', () => {
    // Anchor on the buffer push, then look at the guarding condition just
    // above it. Both predicates must be negated in the same gate.
    const pushIdx = src.indexOf('pendingFrames.push(frame)');
    expect(pushIdx).toBeGreaterThan(-1);
    // The condition sits in the ~400 chars before the push.
    const gate = src.slice(Math.max(0, pushIdx - 400), pushIdx);
    expect(gate).toMatch(/!\s*depsReady/);
    expect(gate).toMatch(/!\s*isCallFrame\(/);
    expect(gate).toMatch(/!\s*isGroupRingFrame\(/);
  });

  it('the Phase-5 epoch gate still runs BEFORE the buffer gate (out-of-epoch rings are dropped, not exempted)', () => {
    // Anchor to the onFrame handler so this pins THIS gate's epoch check — not
    // some other isOurEpoch() elsewhere in the 8k-line file (dispatchFrame's
    // .catch has one just above). indexOf-from-onFrame finds the FIRST epoch
    // check inside onFrame; if it were deleted, the next isOurEpoch at/after
    // `onFrame:` is onStateChange's — which sits AFTER the buffer gate → RED.
    const onFrameIdx = src.indexOf('onFrame:');
    expect(onFrameIdx).toBeGreaterThan(-1);
    const pushIdx = src.indexOf('pendingFrames.push(frame)', onFrameIdx);
    const gateStart = src.lastIndexOf('if (', pushIdx);
    const epochIdx = src.indexOf('if (!isOurEpoch())', onFrameIdx);
    expect(epochIdx).toBeGreaterThan(-1);
    expect(epochIdx).toBeGreaterThan(onFrameIdx);
    expect(epochIdx).toBeLessThan(gateStart);
    // …and it actually EARLY-RETURNS (an empty `if (!isOurEpoch()) {}` would
    // satisfy the ordering above but not drop the stale-epoch frame).
    expect(src.slice(epochIdx, epochIdx + 60)).toMatch(/return/);
  });
});
