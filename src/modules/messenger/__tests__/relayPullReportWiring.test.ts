/**
 * B-703 MR-1 — source scan for the drain/report BRIDGE inside
 * productionRuntime.ts.
 *
 * Why a scan: no test imports `productionRuntime.ts` (it pulls react-native and
 * dies in the node project), which is precisely how B-125's data loss shipped on
 * a green suite. `relayPullReport.test.ts` pins the pure rule and
 * `headlessDrainNotify.test.ts` pins the lane against a HAND-BUILT report, so
 * without this file the only genuinely new logic in the runtime — the per-page
 * id accounting and the sequence guard — has no coverage at all.
 *
 * House traps respected: comments are stripped before every ordering/absence
 * assertion (prose containing a banned token is the classic false result), the
 * file is CRLF so nothing anchors on a bare \n, and each window is sliced
 * INSIDE the executing closure rather than trusting a file-wide lastIndexOf
 * (the B-596..604 lesson: a sibling function matched and the pin passed
 * vacuously).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const SRC = join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts');

/** Strip block + line comments so prose can never satisfy a code assertion. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map(l => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

const code = stripComments(readFileSync(SRC, 'utf8'));

/** The body of `async function drainRelay(` up to the next top-level function. */
function drainBody(): string {
  const start = code.indexOf('async function drainRelay(');
  expect(start).toBeGreaterThan(-1);
  const end = code.indexOf('\nfunction convoIdFor(', start);
  expect(end).toBeGreaterThan(start);
  return code.slice(start, end);
}

/** The body of the `pullEnvelopes:` runtime method only. */
function pullEnvelopesBody(): string {
  const start = code.indexOf('pullEnvelopes: async (');
  expect(start).toBeGreaterThan(-1);
  // The next runtime method key ends the closure.
  const end = code.indexOf('loadLinkMessages:', start);
  expect(end).toBeGreaterThan(start);
  return code.slice(start, end);
}

describe('drainRelay reports what it actually ingested', () => {
  it('EVERY return in the page loop is the report — not merely "at least three of them"', () => {
    // Scoped to the page loop: `drainTotals` is declared above it and legitimately
    // returns the built report. Counting `return drainTotals();` occurrences would
    // let a NEW early exit returning something else slip in beside the known ones,
    // so enumerate every return the loop can take instead.
    const b = drainBody();
    const loop = b.slice(b.indexOf('for (let iter = 0;'));
    expect(loop.length).toBeGreaterThan(500); // the slice really found the loop
    const returns = loop.match(/\breturn\b[^;\n]*;/g) ?? [];
    expect(returns.length).toBeGreaterThanOrEqual(3);
    for (const r of returns) {expect(r).toBe('return drainTotals();');}
  });

  it('accounting is BY ID (sets), not by count — re-pulled pages must be idempotent', () => {
    const b = drainBody();
    expect(b).toMatch(/const pulledIds\s*=\s*new Set<string>\(\);/);
    expect(b).toMatch(/const ackedIds\s*=\s*new Set<string>\(\);/);
    expect(b).toMatch(/const skippedIds\s*=\s*new Set<string>\(\);/);
    // The count-based fold this replaced must not come back: a page that does
    // not fill its limit is re-pulled, so `+= envelopes.length` inflates and a
    // re-acked envelope can mask a stuck one.
    expect(b).not.toMatch(/totalPulled\s*\+=/);
    expect(b).not.toMatch(/pulled:\s*envelopes\.length/);
  });

  it('every pulled envelope is recorded UNCONDITIONALLY, before the in-flight hold', () => {
    const b = drainBody();
    const lines = b.split('\n').map(l => l.trim());
    // The whole trimmed line, not a substring: `if (env.ackToken) {pulledIds
    // .add(env.envelopeId);}` would satisfy an indexOf and silently drop
    // envelopes out of the accounting entirely.
    expect(lines).toContain('pulledIds.add(env.envelopeId);');
    const add  = b.indexOf('pulledIds.add(env.envelopeId);');
    const hold = b.indexOf('const drainHold = tryAcquireEnvelope(');
    expect(hold).toBeGreaterThan(add); // recorded first, or a busy skip is never "pulled"
  });

  it('the busy skip — the one exit ABOVE the try/finally — records its own id', () => {
    const b = drainBody();
    const busy = b.slice(b.indexOf("if (drainHold === 'busy')"), b.indexOf("if (drainHold === 'busy')") + 160);
    expect(busy).toMatch(/skippedIds\.add\(env\.envelopeId\);/);
  });

  it('the ack snapshot is PER-ENVELOPE — the single line the whole fix rests on', () => {
    const b = drainBody();
    const perEnv = b.slice(b.indexOf('for (const env of envelopes) {'));
    expect(perEnv.length).toBeGreaterThan(500); // the slice really found the loop
    // `const ackedBefore = 0;` reads as an obvious simplification (equivalent to
    // hoisting the snapshot to page scope) and previously survived a 100%-green
    // gate. It turns the verdict into `pageProgressed > 0`, so on any page where
    // ANYTHING acked earlier — an alreadySeen dedup ack, an unwrap-fail discard,
    // a cert-reject discard — every later envelope is recorded as acked,
    // including the stuck one. leftOnRelay collapses to 0 and the wake goes
    // silent: the founder's P0, restored invisibly.
    expect(perEnv.split('\n').map(l => l.trim())).toContain('const ackedBefore = pageProgressed;');
    expect(perEnv.indexOf('const ackedBefore = pageProgressed;'))
      .toBeLessThan(perEnv.indexOf('const drainHold = tryAcquireEnvelope('));
  });

  it('the per-envelope verdict rides the SAME finally as the release, AFTER it', () => {
    const b = drainBody();
    const fin = b.slice(b.indexOf('} finally {'));
    const release  = fin.indexOf('releaseEnvelope(env.envelopeId, drainHold);');
    const classify = fin.indexOf('if (pageProgressed > ackedBefore) {ackedIds.add(env.envelopeId);}');
    expect(release).toBeGreaterThan(-1);
    expect(classify).toBeGreaterThan(release); // never above it — see inFlightGuardParity
    // Derived from the counter the page-progress rule already keeps, so a new
    // leave-on-relay branch lands in "left behind" by construction.
  });

  it('a skip is only trusted when the concurrent pass actually ingested it', () => {
    const b = drainBody();
    // Critic G2: the WS lane has its own leave-on-relay arms, so "another pass
    // holds it" does not imply "it was ingested". An unseen skip must degrade
    // to left-on-relay or the wake reports a clean drain and goes silent.
    const totals = b.slice(b.indexOf('const drainTotals = async'), b.indexOf('for (let iter = 0;'));
    expect(totals.length).toBeGreaterThan(200); // the slice really found the helper
    expect(totals).toMatch(/skippedIds\.delete\(id\);/);
    // W8 / M5 D1: the read resolves into a local flag inside the try — never
    // inline in the `if` — so a throwing dedup store degrades this one envelope
    // to "not ingested" instead of unwinding the whole report.
    expect(totals).toMatch(/ingestedElsewhere = await seenEnvelopes\.wasSeen\(id\);/);
    expect(totals).toMatch(/if \(!ingestedElsewhere\) \{skippedIds\.delete\(id\);\}/);
    expect(totals).not.toMatch(/if\s*\([^)]*await\s+seenEnvelopes\.wasSeen\(/);
    // ...and a pass that is STILL HOLDING the envelope is trusted: `markSeen`
    // commits only at the end of its receive txn, so re-checking mid-flight
    // would demote a healthy concurrent deliver and make this wake post a
    // generic banner that gags the named one that pass is about to draw.
    const holdIdx = totals.indexOf('if (isEnvelopeInFlight(id)) {continue;}');
    expect(holdIdx).toBeGreaterThan(-1);
    expect(holdIdx).toBeLessThan(totals.indexOf('await seenEnvelopes.wasSeen(id)'));
    // The consultation must be REACHABLE — guarded only by the store existing.
    // A tightened guard (`&& skippedIds.size > 999`) would neuter the whole
    // rule while leaving every token above present and green.
    const lines = totals.split('\n').map(l => l.trim());
    expect(lines).toContain('if (seenEnvelopes) {');
  });

  it('the report is BUILT from the three sets — not hand-assembled', () => {
    const b = drainBody();
    const totals = b.slice(b.indexOf('const drainTotals = async'), b.indexOf('for (let iter = 0;'));
    // Without this pin, `return {ok:true, pulled: pulledIds.size, acked:
    // pulledIds.size, skipped: 0, leftOnRelay: 0};` keeps every other scan and
    // every suite green while making leftOnRelay permanently 0 — the founder's
    // exact P0, restored invisibly.
    const lines = totals.split('\n').map(l => l.trim());
    expect(lines).toContain(
      'return pullReportFromIds({pulled: pulledIds, acked: ackedIds, skipped: skippedIds});',
    );
  });
});

describe('pullEnvelopes reports instead of swallowing (B-703 MR-1)', () => {
  it('still never throws — five UI/push callers depend on that', () => {
    const b = pullEnvelopesBody();
    expect(b).toMatch(/try \{/);
    expect(b).toMatch(/await coalescedDrain\(\);/);
    expect(b).toMatch(/catch \(e\)/);
    expect(b).not.toMatch(/\bthrow\b/);
  });

  it('a failed drain returns the FAILED report, it is not swallowed into success', () => {
    const b = pullEnvelopesBody();
    const cat = b.slice(b.indexOf('catch (e)'));
    expect(cat).toMatch(/return failedPullReport\(\);/);
  });

  it('the sequence is snapshotted BEFORE the await, and a stale report is refused', () => {
    const b = pullEnvelopesBody();
    const snap  = b.indexOf('const seqBefore = pullReportSeq;');
    const drain = b.indexOf('await coalescedDrain();');
    const guard = b.indexOf('pullReportSeq === seqBefore');
    expect(snap).toBeGreaterThan(-1);
    expect(drain).toBeGreaterThan(snap);   // snapshot first, or the guard proves nothing
    expect(guard).toBeGreaterThan(drain);  // checked after the drain settles
    // The FULL predicate, not a substring in a window: flipping `||` to `&&`
    // reads almost identically and would hand back a PREVIOUS drain's report
    // whenever this call's drain never ran — the exact hazard the guard exists
    // for, and invisible to a looser scan.
    const lines = b.split('\n').map(l => l.trim());
    expect(lines).toContain(
      'if (pullReportSeq === seqBefore || !lastPullReport) {return failedPullReport();}',
    );
  });

  it('B-703 MR-5 — flushAcks AWAITS the queue; the shared drain path stays fire-and-forget', () => {
    // Sliced to the NEXT method, not a fixed char window: a 400-char window
    // runs past this ~110-char body into its neighbour, so a sibling that
    // happened to contain the same call would satisfy the pin vacuously
    // (the B-596..604 anchoring lesson this file's header cites).
    const start = code.indexOf('flushAcks: async (');
    expect(start).toBeGreaterThan(-1);
    const end = code.indexOf('loadLinkMessages:', start);
    expect(end).toBeGreaterThan(start);
    expect(code.slice(start, end)).toMatch(/await flushAckQueue\(relay\);/);
    // The foreground path must NOT await it: putting a network round-trip on
    // the chat-open path is the jank B-279/B-691 fought. `void` is deliberate.
    const coalesced = code.slice(code.indexOf('const coalescedDrain ='),
                                code.indexOf('void transport.connect()'));
    expect(coalesced).toMatch(/void flushAckQueue\(relay\);/);
  });

  it('the pump stamps the report and bumps the sequence INSIDE the coalesced body', () => {
    const pump = code.slice(code.indexOf('const drainPump = createRerunCoalescer('),
                            code.indexOf('const publishSyncState'));
    const assign = pump.indexOf('lastPullReport = report;');
    const bump   = pump.indexOf('pullReportSeq += 1;');
    expect(assign).toBeGreaterThan(-1);
    expect(bump).toBeGreaterThan(assign);
    // Both must sit inside the awaited body, i.e. after the drainRelay call, so
    // a caller awaiting the shared promise cannot observe a half-written report.
    expect(assign).toBeGreaterThan(pump.indexOf('await drainRelay('));
  });
});
