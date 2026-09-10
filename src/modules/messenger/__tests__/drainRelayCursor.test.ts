/**
 * B-315 — the HTTP drain must be able to step past a stuck head page.
 *
 * `drainRelay` always pulled from the head (`after` never sent → server
 * afterTs=0) and only an ACK removes an envelope. Every leave-on-relay branch
 * (cert clock-window, LeaveOnRelayError, transient SQL, identity-refresh)
 * `continue`s without acking — correctly leaving the envelope for retry — so
 * one page of stuck envelopes made everything BEHIND it unreachable until the
 * 30-day dwell, and the B-126 zero-progress abort ended the whole drain with
 * no scheduled retry. That is the founder's 2026-07-27 "page made no
 * progress" line, and the delayed/lost-message symptom on offline catch-up.
 *
 * The fix: an in-run cursor. A zero-progress page advances `cursorTs` past
 * itself (stuck envelopes STAY on the relay — leave-on-relay semantics are
 * untouched; the next run starts from 0 and retries them) and the drain
 * continues to the envelopes behind it. The abort remains ONLY as the
 * cannot-advance safety net (malformed page with no usable timestamps).
 *
 * Source scan: `drainRelay` lives in productionRuntime.ts, which the node
 * project cannot import. CRLF-safe, comments stripped.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const src = readFileSync(
  join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts'), 'utf8',
)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\r\n]*/g, '');

function drainBody(): string {
  const at = src.indexOf('const HARD_CAP_ITERATIONS = 10;');
  expect(at).toBeGreaterThan(-1);
  const end = src.indexOf('hard cap of', at);
  expect(end).toBeGreaterThan(at);
  return src.slice(at, end);
}

describe('B-315 — drainRelay in-run paging cursor', () => {
  it('the pull carries the cursor', () => {
    const b = drainBody();
    expect(b).toMatch(/relay\.pull\(\{\r?\n\s*after:\s+cursorTs,/);
  });

  it('the cursor is declared before the page loop', () => {
    const b = drainBody();
    const decl = b.indexOf('let cursorTs = 0;');
    const loop = b.indexOf('for (let iter = 0;');
    expect(decl).toBeGreaterThan(-1);
    expect(loop).toBeGreaterThan(decl);
  });

  it('a zero-progress page steps the cursor past itself and continues', () => {
    const b = drainBody();
    const block = b.slice(b.indexOf('pageProgressed === 0'));
    expect(block).toMatch(/cursorTs = maxTs;/);
    // The advance must CONTINUE the loop, not return.
    const advance = block.indexOf('cursorTs = maxTs;');
    const next = block.slice(advance, advance + 120);
    expect(next).toMatch(/continue;/);
  });

  it('the abort survives ONLY as the cannot-advance safety net', () => {
    const b = drainBody();
    const block = b.slice(b.indexOf('pageProgressed === 0'), b.indexOf('cursorTs = maxTs;'));
    // Inside the zero-progress branch, the only `return` is guarded by the
    // cursor failing to advance.
    // B-703 MR-1 re-point: drainRelay now REPORTS its totals, so every exit
    // returns `drainTotals()` instead of bare. The rule this pins is unchanged
    // — the abort still exists only under the cannot-advance guard.
    expect(block).toMatch(/maxTs <= cursorTs/);
    expect(block).toMatch(/return drainTotals\(\);/);
  });

  it('the stuck-head step is loud and tagged', () => {
    const b = drainBody();
    expect(b).toMatch(/stepping past stuck head/);
    expect(b).toMatch(/B-315/);
  });
});
