/**
 * B-213 — the "waiting for this group's encryption key" banner
 * (`useMessengerStore.error`, surfaced via chatStatusLabel) is a single
 * GLOBAL field, not scoped to the group that triggered it. Founder
 * screenshot: messages and calls were working fine in a mission Ops
 * Room, yet the chat still showed the red "Error: Waiting for this
 * group's encryption key — the message will appear once it syncs."
 * banner — because nothing ever cleared `store.error` once the stash
 * that set it actually drained. `drainPendingGroupInner` must clear it
 * (only when it's still exactly that message — a real, unrelated error
 * that landed in between must survive) once a group's stash resolves.
 *
 * `productionRuntime.ts` can't be imported by any test project (see
 * CLAUDE.md's message-pipeline rule), so this is pinned by reading the
 * source — same pattern as the other static scans in this suite.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const RUNTIME = join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts');

function source(): string {
  return readFileSync(RUNTIME, 'utf8').replace(/\r\n/g, '\n');
}
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
/** The body of drainPendingGroupInner, CODE only. */
function drainInnerBody(): string {
  const src = stripComments(source());
  const start = src.indexOf('async function drainPendingGroupInner(');
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('\nasync function replayGroupSealedDecode(', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe("B-213 — the stale 'waiting for group key' banner clears once its stash drains (static source scan)", () => {
  it('defines one shared constant for the banner text (setter and clearer can never drift apart)', () => {
    const matches = stripComments(source()).match(/GROUP_KEY_PENDING_RECEIVE_ERROR\s*=/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('the no_key stash setError call uses the shared constant, not a re-typed literal', () => {
    const src = stripComments(source());
    expect(src).toMatch(/setError\(GROUP_KEY_PENDING_RECEIVE_ERROR\)/);
  });

  it('drainPendingGroupInner clears store.error whenever the group is no longer key-blocked', () => {
    const body = drainInnerBody();
    // FOLLOW-UP TO B-213 (owner re-reported it with a fresh CPO screenshot).
    // The original fix gated the clear on `rows.length > 0 && !stillKeyBlocked`
    // — it only fired when the drain had actually REPLAYED something. But once
    // the key lands and messages decode LIVE the stash is empty, so every later
    // drain found rows.length === 0, skipped the clear, and the banner outlived
    // the sync forever while messages rendered fine underneath it. "No longer
    // key-blocked" is equally true with an empty stash, so the row count must
    // not be part of the condition.
    expect(body).not.toMatch(/rows\.length > 0 && !stillKeyBlocked/);
    expect(body).toMatch(/if \(!stillKeyBlocked\) \{/);
    expect(body).toMatch(/store\.error === GROUP_KEY_PENDING_RECEIVE_ERROR/);
    expect(body).toMatch(/store\.setError\(null\)/);
  });

  it('an empty stash still REACHES the clear — no early return above it', () => {
    // The clear is dead code if a `rows.length === 0` guard returns first,
    // which is exactly the case this fix exists for.
    const body = drainInnerBody();
    const clearAt = body.indexOf('if (!stillKeyBlocked) {');
    expect(clearAt).toBeGreaterThan(-1);
    expect(body.slice(0, clearAt)).not.toMatch(/if \(rows\.length === 0\)\s*\{?\s*return/);
  });

  it('a DIFFERENT real error that landed in between survives', () => {
    // Widening the clear made it fire far more often, so the string equality
    // is now the ONLY thing stopping it from stomping an unrelated failure the
    // user still needs to see. The setError(null) must stay INSIDE that check.
    const body = drainInnerBody();
    const clearAt = body.indexOf('if (!stillKeyBlocked) {');
    const guardAt = body.indexOf('store.error === GROUP_KEY_PENDING_RECEIVE_ERROR', clearAt);
    const nullAt  = body.indexOf('store.setError(null)', clearAt);
    expect(guardAt).toBeGreaterThan(clearAt);
    expect(nullAt).toBeGreaterThan(guardAt);   // guarded, not unconditional
  });
});
