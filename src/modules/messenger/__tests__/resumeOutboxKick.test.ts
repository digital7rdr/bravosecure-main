/**
 * OR-6 — a foreground resume onto a HEALTHY socket must kick the durable
 * outbox, not just the receive-side drain. productionRuntime.ts is too heavy to
 * import under jest (see bootGroupStashDrain.test.ts), so pin the wiring
 * statically — same approach as groupCallConsumeOrder.test.ts.
 */
import {readFileSync} from 'fs';
import {join} from 'path';

const SRC = readFileSync(
  join(__dirname, '..', 'runtime', 'productionRuntime.ts'),
  'utf8',
);

function appStateActiveBlock(): string {
  const start = SRC.indexOf("AppState.addEventListener('change'");
  expect(start).toBeGreaterThan(-1);
  const end = SRC.indexOf('liveAppStateSub = appStateSub', start);
  expect(end).toBeGreaterThan(start);
  return SRC.slice(start, end);
}

describe('OR-6 — AppState resume kicks the durable outbox', () => {
  it('calls drainOutbox inside the AppState-active handler', () => {
    expect(appStateActiveBlock()).toMatch(/kickAndDrainOutbox\(\s*sqlOutbox\s*,/);
  });

  it('kicks the outbox BEFORE branching on resumeAction, so drain/probe are covered', () => {
    const block = appStateActiveBlock();
    const kickAt = block.indexOf('kickAndDrainOutbox(');
    const branchAt = block.indexOf("if (resumeAction === 'drain')");
    expect(kickAt).toBeGreaterThan(-1);
    expect(branchAt).toBeGreaterThan(-1);
    expect(kickAt).toBeLessThan(branchAt);
  });

  it('guards on sqlOutbox and threads the reseal callback (fresh sender cert)', () => {
    // RT-2/OR-1 replaced the raw kick with the throttled kick+drain helper.
    expect(appStateActiveBlock()).toMatch(
      /if\s*\(sqlOutbox\)\s*\{\s*kickAndDrainOutbox\(sqlOutbox, relay, isOurEpoch, resealOutboxRow\)/,
    );
  });

  it('still drains the receive side on resume (no regression of the original behaviour)', () => {
    expect(appStateActiveBlock()).toMatch(/coalescedDrain\(\)/);
  });
});

describe('OR-4 — both drains use the re-run coalescer', () => {
  it('imports createRerunCoalescer', () => {
    expect(SRC).toMatch(/import \{createRerunCoalescer, MAX_COALESCER_RERUNS, type CoalescerRunCtx\} from '\.\/rerunCoalescer';/);
  });

  it('has no plain mutex flags left', () => {
    expect(SRC).not.toMatch(/let drainInflight/);
    expect(SRC).not.toMatch(/let drainOutboxInflight/);
  });

  it('wires the receive drain through the pump', () => {
    expect(SRC).toMatch(/const drainPump = createRerunCoalescer\(/);
    // SRV-05 — the drain pass now flushes coalesced acks as it settles.
    expect(SRC).toMatch(/return drainPump\(\)\.finally\(/);
  });

  it('wires the send drain through the pump and re-reads args at pass start', () => {
    expect(SRC).toMatch(/const drainOutboxPump = createRerunCoalescer\(/);
    // The `!` is load-bearing: an inverted guard returns on every pass and the
    // durable outbox never ships again. Tolerant of the `!a || !a.` ⇄ `!a?.`
    // spelling, strict about the negation.
    expect(SRC).toMatch(
      /const a = drainOutboxArgs;[\s\S]{0,80}?if \(!a(\?\.|\s*\|\|\s*!a\.)isOurEpoch\(\)\) \{return;\}/,
    );
    expect(SRC).toMatch(/return drainOutboxPump\(\);/);
  });
});
