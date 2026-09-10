import {readFileSync} from 'node:fs';
import {join} from 'node:path';

/**
 * Static source-scan for M15 — the stash-drain replay must apply the SAME gates
 * as the live receive path.
 *
 * A group envelope that arrives before its master key is stashed in
 * `pendingGroupEnvelopes` and replayed later by `replayGroupSealedDecode`. That
 * replay is a THIRD implementation of "decide whether this message may render",
 * alongside the WS and HTTP paths that M5 covers — and it only ever grew the
 * membership gate (P1-N4). The live path drops on three more conditions that the
 * replay did not check at all:
 *
 *   expiry              `:6478`  — a disappearing message whose TTL already ran out
 *   isRestoreTombstoned `:7223`  — a message the user deleted before reinstalling
 *   isPeerBlocked       `:7231`  — a sender the user blocked
 *
 * The blocked-peer hole is the sharp one: BLOCKING A PEER DID NOT STOP THEIR
 * STASHED MESSAGE FROM RENDERING. Block someone whose group message is sitting in
 * the stash, and the next key arrival drains it straight onto the screen. The
 * live path has suppressed that since P2-9; the replay never did.
 *
 * Expiry is the one most likely to fire in practice, and the stash makes it
 * MORE likely than on the live path, not less: an envelope only lands in the
 * stash because a key was missing, so it sits there — by definition — for an
 * unbounded time before the drain runs. A 5-minute disappearing message stashed
 * for an hour is expired long before anyone sees it.
 *
 * WHY THESE MUST BE `return`, NEVER `throw` (drainPendingGroup `:6073-6097`):
 * the caller deletes the stash row only when the replay returns cleanly. A throw
 * is caught, bumps `attempts`, and re-runs the whole replay —
 * `PENDING_GROUP_MAX_ATTEMPTS` times, re-doing the group parse each pass — before
 * finally deleting the row anyway. A deliberate drop is not an error, so it must
 * complete normally.
 *
 * `productionRuntime.ts` is ~8k lines and no test can import it (see
 * bootGroupStashDrain.test.ts:12), so this pins the parity by reading source, the
 * same way receivePathParity.test.ts pins M5.
 *
 * If this fails, do NOT relax it. See docs/runbooks/MESSAGE_LOOP.md M15 / W8b.
 */

const RUNTIME = join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts');

/** Strip comments so a scan sees CODE, not the prose that explains it. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** The body of `replayGroupSealedDecode`, CODE only. */
function replayBody(): string {
  const src = readFileSync(RUNTIME, 'utf8');
  const start = src.indexOf('async function replayGroupSealedDecode(');
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('\nasync function ', start + 1);
  expect(end).toBeGreaterThan(start);
  return stripComments(src.slice(start, end));
}

describe('M15 — the stash-drain replay applies the live path\'s gates', () => {
  const GATES: ReadonlyArray<[string, RegExp]> = [
    ['blocked peer (P2-9)', /isPeerBlocked\(\s*peer\.userId\s*\)/],
    ['restore tombstone (M-08)', /isRestoreTombstoned\(/],
    ['already-expired payload (M7)', /expiresAtSec\b/],
  ];

  it.each(GATES)('drops on %s', (_label, pattern) => {
    expect(replayBody()).toMatch(pattern);
  });

  it.each(GATES)('checks %s BEFORE opening the write txn', (_label, pattern) => {
    // A gate below `runWithRatchetTxn` would still append the row and then
    // undo it, which is both a wasted write and a window where the message is
    // in the store. Drop before the txn opens.
    const body = replayBody();
    const txn = body.indexOf('runWithRatchetTxn(');
    expect(txn).toBeGreaterThan(-1);
    const gate = body.search(pattern);
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(txn);
  });

  it('keeps the membership gate it already had (P1-N4)', () => {
    // Regression guard: the three new drops must not have displaced this one.
    expect(replayBody()).toMatch(/isGroupMember\(existing,\s*peer\.userId\)/);
  });

  it('every deliberate drop returns cleanly — a `throw` would retry the row', () => {
    // drainPendingGroup deletes the stash row ONLY on a clean return; a throw is
    // caught, bumps attempts, and replays up to PENDING_GROUP_MAX_ATTEMPTS times
    // (re-parsing the group payload each pass) before deleting it anyway.
    const body = replayBody();
    // Everything from the first gate onward is the drop region; the throws above
    // it (missing master key, parse failure) are GENUINE errors and must stay.
    const firstGate = body.search(/isPeerBlocked\(|isRestoreTombstoned\(|expiresAtSec\b/);
    expect(firstGate).toBeGreaterThan(-1);
    const txn = body.indexOf('runWithRatchetTxn(');
    expect(body.slice(firstGate, txn)).not.toMatch(/\bthrow\b/);
  });

  it('the gate caches are loaded BEFORE the boot stash drain is wired', () => {
    // Both caches FAIL OPEN — a failed load leaves an empty set, so
    // isPeerBlocked/isRestoreTombstoned silently answer "no" and the gates above
    // become no-ops. The boot drain (B-31) replays envelopes stashed in a PRIOR
    // session, so if it were wired ahead of the loads, the two gates would do
    // nothing on exactly the path that matters most — the one draining a backlog
    // the user may have blocked someone over. Today `await loadBlockedPeers` /
    // `await loadRestoreTombstones` sit at :444-445 and the drain at :~1735; this
    // pins that relative order, which no type or unit test can see.
    const src = stripComments(readFileSync(RUNTIME, 'utf8'));
    const loadBlocked = src.indexOf('await loadBlockedPeers(');
    const loadTombs = src.indexOf('await loadRestoreTombstones(');
    const bootDrain = src.indexOf('selectGroupIdsToDrain(');
    expect(loadBlocked).toBeGreaterThan(-1);
    expect(loadTombs).toBeGreaterThan(-1);
    expect(bootDrain).toBeGreaterThan(-1);
    expect(loadBlocked).toBeLessThan(bootDrain);
    expect(loadTombs).toBeLessThan(bootDrain);
  });

  it('the genuine error paths still throw (the drops did not soften them)', () => {
    // `return` is "drop this row for good"; these two are "could not process,
    // retry" and must NOT be converted into silent drops.
    const body = replayBody();
    expect(body).toMatch(/replay: master key still missing post-drain/);
    expect(body).toMatch(/throw new Error\(`replay: parse/);
  });
});
