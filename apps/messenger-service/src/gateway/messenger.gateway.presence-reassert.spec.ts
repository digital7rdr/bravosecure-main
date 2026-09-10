/**
 * sqa.md bug register — this suite pins: B-189.
 *
 * B-189 (P2, ⚠️ SERVER) — the owner's presence dot flickered green/grey while they
 * were genuinely online.
 *
 * `handleConnection` re-asserted `presence.set(uid, 'online')` only when
 * `!superseded && onConnect() === first-device`. Nothing else in the system can move
 * a state key back UP: `touch` only bumps TTLs, `reassertLocalLeases` only rewrites
 * the lease, and `sweepStale` is strictly online→offline. So any moment the key went
 * stale-`offline` while the socket was genuinely up — a sweep racing a momentarily
 * missing lease, or an underflow `onDisconnect` after the counter was reset — the
 * user was painted grey until they happened to background/foreground the app.
 *
 * And because the client pins `signalDeviceId = 1`, EVERY reconnect that raced the
 * previous socket's teardown landed in the `superseded` branch and skipped the
 * re-assert — so this was reachable on a single device, with no second device
 * involved. That is why it read as a flicker rather than a rare multi-device edge.
 *
 * The fix DECOUPLES two concerns that had been fused:
 *   1. the device COUNTER still skips on a takeover (B-11 — the evicted socket
 *      already counted this (user, device) slot and its `onDisconnect` is skipped,
 *      so a second INCR leaks the counter and pins the user online forever), and
 *   2. the STATE key is re-asserted on EVERY authenticated connect.
 *
 * WHY A SOURCE SCAN: `messenger.gateway.ts` is a Nest gateway with a large
 * constructor graph (registry, presence, redis, push, sfu, jwt, config …). The rule
 * at stake is an ORDERING/GATING property of one method, not a behaviour reachable
 * through a cheap unit seam — the same situation the mobile repo solves with
 * `messageTopologyInvariants` / `receivePersistenceInvariants`. Comments are
 * stripped before every assertion because the fix's own explanatory prose in this
 * method quotes the banned gating (`onConnect`, `superseded`) verbatim, which is the
 * classic false-positive for this technique.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const GATEWAY = join(__dirname, 'messenger.gateway.ts');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\r\n]*/g, '');
}

/**
 * The presence block of `handleConnection`, CODE only — from the registry add
 * that computes `superseded` to the `onAny` liveness hook that closes the block.
 */
function presenceBlock(): string {
  const src = stripComments(readFileSync(GATEWAY, 'utf8'));
  const start = src.indexOf('const superseded = this.registry.add(conn);');
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('client.onAny(', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('B-189 — a live socket always re-asserts presence `online`', () => {
  it('the block under test is non-empty (the scan is not vacuous)', () => {
    // CRLF/anchor guard: if either anchor ever moves, fail loudly here rather
    // than let every assertion below pass against an empty string.
    const block = presenceBlock();
    expect(block.length).toBeGreaterThan(80);
    expect(block).toContain('this.presence');
  });

  it('presence.set(online) is NOT gated on `superseded`', () => {
    const block = presenceBlock();
    const setIdx = block.indexOf("this.presence.set(claims.sub, 'online')");
    expect(setIdx).toBeGreaterThan(-1);

    // Everything between the guarded counter and the state write must not
    // reopen a conditional. The regression shape was:
    //   if (!superseded) { await this.presence.onConnect(...); await this.presence.set(...); }
    // i.e. the set() living INSIDE the counter's guard.
    const counterIdx = block.indexOf('this.presence.onConnect(');
    expect(counterIdx).toBeGreaterThan(-1);
    expect(counterIdx).toBeLessThan(setIdx);

    const between = block.slice(counterIdx, setIdx);
    expect(between).not.toMatch(/if\s*\(\s*!?\s*superseded/);
  });

  it("the state write's ONLY gate is the B-354 background flag — never superseded/firstDevice", () => {
    const block = presenceBlock();
    // B-354 evolved B-189's "bare statement" rule: a self-declared BACKGROUND
    // socket (killed-app headless drain) must NOT assert 'online' — its
    // connect says nothing about the user. For every interactive socket the
    // B-189 property is unchanged: the write runs on EVERY authenticated
    // connect, gated on nothing connection-lifecycle-shaped. So the exact
    // guarded shape is pinned, and the B-189 regression shapes (gating on
    // superseded / firstDevice) stay banned via the assertions around it.
    expect(block).toMatch(/if \(!ctx\.presenceBg\) \{\s*await this\.presence\.set\(claims\.sub, 'online'\);/);
    // The bg branch may only ever write DOWN (stale-record repair), never up.
    const bgBranch = /else if \(firstDevice\) \{[\s\S]{0,300}?\}/.exec(block)?.[0] ?? '';
    expect(bgBranch).toContain("set(claims.sub, 'offline')");
    expect(bgBranch).not.toContain("'online'");
    expect(bgBranch).not.toContain("'active'");
  });

  it('the device COUNTER is still skipped on a takeover (B-11 is not undone)', () => {
    // The decoupling must not become "re-assert everything": a second INCR on a
    // single-device takeover leaks the counter and pins the user online forever,
    // because the evicted socket's onDisconnect is deliberately skipped.
    // B-354 reshaped the statement into a ternary (the bg repair branch needs
    // the first-device verdict) — the skip-on-takeover semantics are identical.
    expect(presenceBlock()).toMatch(/superseded \? false : await this\.presence\.onConnect\(/);
  });

  it('the counter and the state key are separate calls, not one helper', () => {
    // Fusing them again is exactly how this bug existed in the first place.
    const block = presenceBlock();
    expect(block).toContain('this.presence.onConnect(');
    expect(block).toContain("this.presence.set(claims.sub, 'online')");
  });
});
