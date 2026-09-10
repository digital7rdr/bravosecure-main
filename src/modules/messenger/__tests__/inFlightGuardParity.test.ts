import {readFileSync} from 'node:fs';
import {join} from 'node:path';

/**
 * W22a / M5 D2 — the in-flight envelope guard is taken at the same point on both
 * receive paths.
 *
 * WS takes it in its OUTERMOST wrapper, before dedup, unwrap and cert-verify.
 * The drain used to take it ~150 lines lower — after `unwrapOuter`, after the
 * `wasSeen` dedup and after the entire v3 cert pre-verify block — so a WS deliver
 * and an HTTP drain of the same envelope could concurrently unwrap it, verify the
 * cert, and fire `refreshPeerIdentityIfRotated`: a duplicate keys-service fetch
 * and a duplicate identity write. Only `handleIncoming` was serialised, so the
 * cost was duplicated WORK — never a double-ratchet, never message loss.
 *
 * WHY THIS ITEM WAS DEFERRED THREE TIMES, and why the shape below is not
 * negotiable: moving the acquire to the top means every `continue` in the unwrap,
 * dedup and cert blocks — which previously ran BEFORE the acquire and so owed no
 * release — now owes one. Hand-auditing them is how you miss one, and a missed
 * release strands that envelope: both receive paths silently skip every
 * redelivery of it until the registry's stale deadline evicts the hold.
 *
 * The only safe construction is ONE `try { …entire body… } finally { release }`.
 * A `continue` inside a `try` still runs the `finally`, so exhaustiveness is
 * guaranteed by the language rather than by review. These tests pin that shape.
 *
 * B-126 retarget (2026-07-22): the raw module-level `inFlightEnvelopes` Set these
 * tests originally named was replaced by the token-based registry in
 * `runtime/inflightEnvelopes.ts` (tryAcquireEnvelope / releaseEnvelope, with
 * stale eviction so a wedged frame cannot make redelivery a permanent no-op).
 * That construct is strictly stronger; the assertions below are the SAME
 * ordering + exhaustiveness contract re-keyed onto its symbols, plus one new
 * assertion that the 'busy' early-out owns no hold and therefore owes no release.
 *
 * See docs/runbooks/MESSAGE_LOOP.md W22a.
 */

const RUNTIME = join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts');

function src(): string {
  return readFileSync(RUNTIME, 'utf8');
}

function code(): string {
  return src().replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** The drain's envelope loop, brace-matched. */
function drainLoopBody(): string {
  const lines = code().split('\n');
  const start = lines.findIndex(l => l.trim() === 'for (const env of envelopes) {');
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  for (let j = start; j < lines.length; j++) {
    depth += (lines[j].match(/\{/g) ?? []).length - (lines[j].match(/\}/g) ?? []).length;
    if (depth <= 0) {return lines.slice(start, j + 1).join('\n');}
  }
  throw new Error('unterminated drain loop');
}

describe('W22a — the drain takes the in-flight guard FIRST', () => {
  it('the guard is the first statement in the loop body', () => {
    const body = drainLoopBody();
    const guard = body.indexOf('tryAcquireEnvelope(env.envelopeId)');
    const unwrap = body.indexOf('await unwrapOuter(');
    const wasSeen = body.indexOf('seenEnvelopes.wasSeen(');
    expect(guard).toBeGreaterThan(-1);
    expect(unwrap).toBeGreaterThan(-1);
    // Both the unwrap and the dedup read must now happen INSIDE the guard —
    // that is the concurrent duplicate work the item is about.
    expect(guard).toBeLessThan(unwrap);
    if (wasSeen > -1) {expect(guard).toBeLessThan(wasSeen);}
  });

  it('the cert pre-verify runs inside the guard, not before it', () => {
    // refreshPeerIdentityIfRotated is the expensive duplicate: a keys-service
    // fetch plus an identity write, fired twice for one envelope.
    const body = drainLoopBody();
    const guard = body.indexOf('tryAcquireEnvelope(env.envelopeId)');
    const refresh = body.indexOf('refreshPeerIdentityIfRotated');
    if (refresh > -1) {expect(guard).toBeLessThan(refresh);}
  });
});

describe('W22a — the release is exhaustive by construction', () => {
  it('the whole loop body sits in ONE try whose finally releases', () => {
    const body = drainLoopBody();
    // acquire → 'busy' early-out → `try {`, with nothing else between. The
    // early-out is the ONLY exit that owes no release, because it never took
    // the hold. Anything else in that gap means some exit path can skip the
    // release.
    expect(body).toMatch(
      /const drainHold = tryAcquireEnvelope\(env\.envelopeId\);\s*if \(drainHold === 'busy'\) \{[^{}]*continue;\s*\}\s*try \{/,
    );

    // The release must be the LAST thing the body does, i.e. the finally closes
    // the loop. Asserting on the tail rather than one big regex, because the
    // exact brace/indent run between the final statement and the finally is
    // incidental — what matters is that nothing follows the release except the
    // loop's own closing brace.
    //
    // B-703 MR-1 re-point: the finally now also classifies the envelope for the
    // drain report. The release is pinned as the FIRST statement of the finally
    // — the original shape's real guarantee, that NOTHING can run before it and
    // therefore nothing can throw before it. (A statement need not contain the
    // token `throw` to throw; an earlier cut of this re-point allowed
    // bookkeeping above the release and would have accepted exactly that.)
    const lines = body.trimEnd().split('\n').filter(l => l.trim() !== '');
    const finallyIdx = lines.findIndex(l => l.trim() === '} finally {');
    expect(finallyIdx).toBeGreaterThan(-1);
    expect(lines[finallyIdx + 1].trim()).toBe('releaseEnvelope(env.envelopeId, drainHold);');

    // Nothing after the release may exit the block early or yield, or a later
    // envelope's accounting could be skipped mid-loop.
    expect(lines[lines.length - 1].trim()).toBe('}');   // closes the for-loop
    expect(lines[lines.length - 2].trim()).toBe('}');   // closes finally
    const afterRelease = lines.slice(finallyIdx + 2, lines.length - 2).join('\n');
    expect(afterRelease).not.toMatch(/\b(return|throw|continue|await)\b/);
  });

  it('there is exactly ONE acquire and ONE release in the drain loop', () => {
    // The pre-W22a code had the acquire in the middle plus its own inner
    // finally. Two of either means a path releases twice or not at all.
    const body = drainLoopBody();
    expect((body.match(/tryAcquireEnvelope\(/g) ?? [])).toHaveLength(1);
    expect((body.match(/releaseEnvelope\(/g) ?? [])).toHaveLength(1);
  });

  it('the only `continue` between the acquire and the try is the busy early-out', () => {
    const body = drainLoopBody();
    const acquire = body.indexOf('tryAcquireEnvelope(env.envelopeId)');
    const tryAt = body.indexOf('try {', acquire);
    expect(tryAt).toBeGreaterThan(acquire);
    const gap = body.slice(acquire, tryAt);
    // Exactly one `continue` in the gap, and it belongs to the 'busy' branch —
    // the branch that never acquired the hold. Any OTHER continue here would
    // leave the loop holding an envelope it never releases.
    expect((gap.match(/\bcontinue\b/g) ?? [])).toHaveLength(1);
    expect(gap).toMatch(/if \(drainHold === 'busy'\)[^\n]*\bcontinue\b/);
  });

  it('the drain and WS paths both guard on envelopeId', () => {
    // M5 parity: same key, or the two paths cannot see each other's marker and
    // the guard does nothing at all.
    const s = code();
    expect(s).toMatch(/tryAcquireEnvelope\(envId\)/);          // WS wrapper
    expect(s).toMatch(/tryAcquireEnvelope\(env\.envelopeId\)/); // drain
    // Release is keyed on the same id + the ownership token on both paths.
    expect(s).toMatch(/releaseEnvelope\(envId, hold\)/);
    expect(s).toMatch(/releaseEnvelope\(env\.envelopeId, drainHold\)/);
  });
});
