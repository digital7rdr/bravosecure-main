/**
 * OR-1 / OM-07 / GF-1 — the outbox must be kicked (un-parked, then drained) on
 * every reachability edge, throttled so a socket.io flap storm can't turn into a
 * drain loop; and one sweep must be bounded in wall time.
 *
 * productionRuntime.ts cannot be imported under the messenger-crypto project
 * (it pulls in @react-native-firebase/crashlytics — see bootGroupStashDrain.test.ts),
 * so the wiring is pinned statically, same approach as resumeOutboxKick.test.ts.
 */
import {readFileSync} from 'fs';
import {join} from 'path';

const SRC = readFileSync(
  join(__dirname, '..', 'runtime', 'productionRuntime.ts'),
  'utf8',
);

function slice(from: string, to: string): string {
  const start = SRC.indexOf(from);
  expect(start).toBeGreaterThan(-1);
  const end = SRC.indexOf(to, start);
  expect(end).toBeGreaterThan(start);
  return SRC.slice(start, end);
}

function kickHelper(): string {
  return slice('function kickAndDrainOutbox(', 'function scheduleTransientRedrain(');
}

describe('OR-1 — throttled kick+drain helper', () => {
  it('declares the throttle interval and BOTH budgets', () => {
    expect(SRC).toMatch(/const OUTBOX_KICK_MIN_INTERVAL_MS = 15_000;/);
    expect(SRC).toMatch(/let lastOutboxKickAt = 0;/);
    expect(SRC).toMatch(/let lastOutboxUnparkAt = 0;/);
    expect(SRC).toMatch(/function kickAndDrainOutbox\(/);
  });

  it('un-parks pending rows and only clears the soft backoff on an unpark kick', () => {
    const body = kickHelper();
    expect(body).toContain('outbox.kickPending()');
    expect(body).toMatch(/if \(doUnpark\)[\s\S]{0,200}?clearUnreachableBackoff\(\)/);
    expect(body).toMatch(/if \(doKick\)[\s\S]{0,200}?kickPending\(\)/);
  });

  it('the un-park has its OWN budget — an unrelated kick cannot deny it', () => {
    const body = kickHelper();
    const unparkGuard = /const doUnpark = .*/.exec(body)?.[0] ?? '';
    expect(unparkGuard).toContain('opts?.unpark === true');
    expect(unparkGuard).toContain('now - lastOutboxUnparkAt >= OUTBOX_KICK_MIN_INTERVAL_MS');
    // The regression: reading the SHARED kick timestamp here lets an AppState /
    // NetInfo kick seconds before the WS handshake swallow the un-park, leaving
    // a saturated soft ladder parked for up to 2 min under a live socket.
    expect(unparkGuard).not.toContain('lastOutboxKickAt');
    // ...and the un-park budget must be re-armed only by an un-park.
    expect(body).toMatch(/if \(doUnpark\) \{ lastOutboxUnparkAt = now; \}/);
    expect(body).toMatch(/if \(doKick\) \{ lastOutboxKickAt = now; \}/);
  });

  it('drains on BOTH the throttled and un-throttled paths', () => {
    const body = kickHelper();
    // One shared closure, invoked from the throttled early return AND from the
    // finally of the un-throttled path.
    expect(body).toMatch(/const drain = \(\): void => \{/);
    // B-703 MR-12 re-point: every kick now routes through the hydration gate
    // (drainOutboxWhenReady), so a drain cannot ship before the message map
    // exists and silently lose the send's status + envelope id. The rule pinned
    // here is unchanged — both paths drain.
    expect(body).toMatch(/drainOutboxWhenReady\(outbox, relay, isOurEpoch, reseal\)/);
    expect(body).toMatch(/if \(!doUnpark && !doKick\) \{\s*\r?\n\s*drain\(\);/);
    expect(body).toContain('.finally(drain);');
  });

  it('compares against the interval and only re-arms on the un-throttled path', () => {
    const body = kickHelper();
    expect(body).toContain('now - lastOutboxKickAt >= OUTBOX_KICK_MIN_INTERVAL_MS');
    const guardAt = body.indexOf('OUTBOX_KICK_MIN_INTERVAL_MS');
    const assignAt = body.indexOf('lastOutboxKickAt = now;');
    expect(assignAt).toBeGreaterThan(guardAt);
  });
});

describe('OR-1 — every reachability edge kicks the outbox', () => {
  it('WS connected un-parks (OM-07) and no longer calls drainOutbox raw', () => {
    // Anchored on the onStateChange handler's exact `if` — a bare
    // "state === 'connected'" also matches the boot bundle-publish retry's
    // `transportRef?.state === 'connected'` (notif-latency E1), which sits
    // EARLIER in the file and made this slice span the wrong region.
    const block = slice("if (state === 'connected') {", 'flushPendingReadReceipts();');
    expect(block).toMatch(
      /kickAndDrainOutbox\(sqlOutbox, relay, isOurEpoch, resealOutboxRow, \{unpark: true\}\)/,
    );
    expect(block).not.toMatch(/void drainOutbox\(sqlOutbox/);
  });

  it('NetInfo regain kicks AFTER the pongFresh and live-call guards', () => {
    const block = slice('NetInfo.addEventListener', 'catch (e) {');
    const kickAt = block.indexOf('kickAndDrainOutbox(');
    const netChangeAt = block.indexOf('notifyNetworkChange()');
    const pongAt = block.indexOf('if (pongFresh) {return;}');
    expect(kickAt).toBeGreaterThan(-1);
    expect(kickAt).toBeGreaterThan(netChangeAt);
    expect(kickAt).toBeGreaterThan(pongAt);
  });

  it('AppState active kicks before branching on resumeAction', () => {
    // OR-2 (leg A) added a legitimate raw drain to the BACKGROUND branch, so
    // the no-raw-drain pin is scoped to the ACTIVE branch only.
    const block = slice("AppState.addEventListener('change'", "} else if (s === 'background'");
    const kickAt = block.indexOf('kickAndDrainOutbox(');
    const branchAt = block.indexOf("if (resumeAction === 'drain')");
    expect(kickAt).toBeGreaterThan(-1);
    expect(kickAt).toBeLessThan(branchAt);
    expect(block).not.toMatch(/void drainOutbox\(sqlOutbox/);
  });

  it('OR-2 leg A — backgrounding flushes the durable outbox over HTTP', () => {
    const block = slice("} else if (s === 'background'", 'liveAppStateSub = appStateSub');
    // Gated on 'background' only — iOS fires 'inactive' for every banner.
    expect(block).toMatch(/if \(s === 'background' && sqlOutbox\)/);
    // B-703 MR-12 re-point: gated kick, same rule.
    expect(block).toMatch(/void drainOutboxWhenReady\(sqlOutbox, relay, isOurEpoch, resealOutboxRow\)/);
    expect(block).toContain('flushAckQueue(relay)');
  });

  it('teardown resets both throttles, the re-drain timer and the send pacer', () => {
    const block = slice('export function disposeLiveRuntime', 'if (liveSweeper)');
    expect(block).toContain('lastOutboxKickAt = 0;');
    expect(block).toContain('lastOutboxUnparkAt = 0;');
    expect(block).toContain('clearTimeout(transientRedrainTimer)');
    expect(block).toContain('resetRelaySendPacer();');
  });
});

describe('GF-1 — the relay client shares one send budget', () => {
  it('wires withRelaySendSlot as the sendGate', () => {
    expect(SRC).toMatch(/import \{withRelaySendSlot, resetRelaySendPacer\} from '\.\/relaySendPacer';/);
    const block = slice('const relay = new RelayHttpClient({', '});');
    expect(block).toMatch(/sendGate:\s+withRelaySendSlot,/);
  });
});

describe('OM-07 / XO-3 — the sweep is bounded and yields to backpressure', () => {
  it('imports and applies the drain budget', () => {
    expect(SRC).toMatch(/import \{shouldStopDrain\} from '\.\/outboxDrainBudget';/);
    const drain = slice('async function drainOutboxPass', 'async function drainRelay');
    expect(drain).toContain('shouldStopDrain({startedAtMs, unreachableStreak})');
    expect(drain).toContain('unreachableStreak = 0;');
  });

  it('the streak actually escalates and resets — not just declared', () => {
    const drain = slice('async function drainOutboxPass', 'async function drainRelay');
    // RT-3 moved the per-row work into shipRow; the loop reads its outcome.
    // Without the increment, shouldStopDrain can never return 'unreachable' and
    // OUTBOX_DRAIN_UNREACHABLE_STREAK is dead code.
    expect(drain).toMatch(/return f\.kind === 'unreachable' \? 'unreachable' : 'rejected';/);
    expect(drain).toMatch(/if \(outcome === 'unreachable'\) \{ unreachableStreak \+= 1; \}/);
    // ...and a delivered row must clear it, or two unreachable peers anywhere
    // in the sweep abort it. shipRow answers 'ok' after markDelivered, and any
    // non-skip outcome other than unreachable resets the streak.
    // B-703 MR-6 re-point. This was a proximity window (`markDelivered(` within
    // N chars of `return 'ok';`) and the wrap + backoff pushed it past N twice,
    // each time inviting a bigger N that pins less. The RULE it owns is
    // structural, so assert that instead: every delivered row marks the pass
    // and answers 'ok' — which is what clears the unreachable streak below.
    const shipSites = drain.match(/shippedThisPass\.add\(row\.clientMsgId\);\s*return 'ok';/g) ?? [];
    expect(shipSites).toHaveLength(2); // the key-material row and the message row
    expect(drain).toContain('markDelivered(');
    expect(drain).toMatch(/else if \(outcome !== 'skipped'\) \{ unreachableStreak = 0; \}/);
  });

  it('checks the budget INSIDE the lane worker, so the 30s wall really binds', () => {
    // GF-6 replaced the serial `for (const row of rows)` loop with per-peer
    // lanes; the budget check must sit inside the worker, before every ship.
    const drain = slice('async function drainOutboxPass', 'async function drainRelay');
    const lanesAt = drain.indexOf('await runOutboxLanes(lanes, OUTBOX_DRAIN_LANE_LIMIT');
    expect(lanesAt).toBeGreaterThan(-1);
    const stopAt = drain.indexOf('shouldStopDrain({startedAtMs, unreachableStreak})', lanesAt);
    const shipAt = drain.indexOf('await shipRow(row)', lanesAt);
    expect(stopAt).toBeGreaterThan(lanesAt);
    expect(shipAt).toBeGreaterThan(-1);
    expect(stopAt).toBeLessThan(shipAt);
    expect(drain).toMatch(/if \(stop !== 'continue'\)[\s\S]{0,340}?return 'stop';/);
  });

  it('stops the sweep and books an early re-drain on a server-transient failure', () => {
    const drain = slice('async function drainOutboxPass', 'async function drainRelay');
    expect(drain).toMatch(
      /if \(f\.kind === 'server-transient'\)[\s\S]{0,400}?scheduleTransientRedrain\([\s\S]{0,200}?return 'transient';/,
    );
    expect(drain).toMatch(/if \(outcome === 'transient'\) \{ return 'stop'; \}/);
  });

  it('anti-regression — the boolean unreachable classifier is fully replaced', () => {
    expect(SRC).not.toContain('isUnreachableError');
  });
});
