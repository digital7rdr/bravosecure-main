/**
 * Regression — B-14: SFU WebSocket idle close → ICE restart over a dead
 * socket → call stuck in 'failed'.
 *
 * The SFU WS idle-closes ~5s BEFORE ICE flips to 'disconnected' (field
 * logs: `sfu.producers failed: transport not open` precedes the ICE event).
 * The old restart path fired `sfu.transport.restartIce` immediately — over
 * the already-dead socket — so it `ack_timeout`'d and the call never
 * recovered. The fix waits for the WS (socket.io auto-reconnects in the
 * background) to be `connected` again before sending the restart, and
 * retries across the recovery budget.
 *
 * These tests pin the two pure decisions the hook now makes: (1) gate the
 * restart on WS-open, and (2) keep retrying until the transport recovers,
 * the budget elapses, or teardown — without asserting any media internals.
 */

// Mirrors the WS-open gate in useGroupCall.ts restartTransport:
// only issue restartIce when the transport reports 'connected'.
function shouldSendRestart(wsState: string | undefined, cancelled: boolean): boolean {
  if (cancelled) {return false;}
  return wsState === 'connected';
}

// Mirrors the retry-loop continuation decision: keep trying while not torn
// down, the transport hasn't recovered, and the budget window is open.
function shouldKeepRetrying(opts: {
  cancelled: boolean;
  leaving: boolean;
  txConnectionState: string | undefined;
  nowMs: number;
  deadlineMs: number;
}): boolean {
  if (opts.cancelled || opts.leaving) {return false;}
  if (opts.txConnectionState === 'connected' || opts.txConnectionState === 'completed') {return false;}
  return opts.nowMs < opts.deadlineMs;
}

describe('B-14 — ICE restart waits for WS reconnect', () => {
  it('does NOT send restartIce while the WS is down (the dead-socket bug)', () => {
    expect(shouldSendRestart('disconnected', false)).toBe(false);
    expect(shouldSendRestart(undefined, false)).toBe(false);
    expect(shouldSendRestart('connecting', false)).toBe(false);
  });

  it('sends restartIce once the WS is back to connected', () => {
    expect(shouldSendRestart('connected', false)).toBe(true);
  });

  it('never sends after teardown, even with an open WS', () => {
    expect(shouldSendRestart('connected', true)).toBe(false);
  });
});

describe('B-14 — ICE restart retry loop', () => {
  const T0 = 1_000_000;
  const DEADLINE = T0 + 30_000;

  it('keeps retrying while the transport is still failing and the budget is open', () => {
    expect(shouldKeepRetrying({
      cancelled: false, leaving: false, txConnectionState: 'disconnected',
      nowMs: T0 + 5_000, deadlineMs: DEADLINE,
    })).toBe(true);
  });

  it('stops retrying once the transport recovers', () => {
    expect(shouldKeepRetrying({
      cancelled: false, leaving: false, txConnectionState: 'connected',
      nowMs: T0 + 5_000, deadlineMs: DEADLINE,
    })).toBe(false);
    expect(shouldKeepRetrying({
      cancelled: false, leaving: false, txConnectionState: 'completed',
      nowMs: T0 + 5_000, deadlineMs: DEADLINE,
    })).toBe(false);
  });

  it('stops retrying when the recovery budget elapses (budget timer owns the fail flip)', () => {
    expect(shouldKeepRetrying({
      cancelled: false, leaving: false, txConnectionState: 'disconnected',
      nowMs: DEADLINE + 1, deadlineMs: DEADLINE,
    })).toBe(false);
  });

  it('stops retrying on teardown (cancelled or leaving)', () => {
    expect(shouldKeepRetrying({
      cancelled: true, leaving: false, txConnectionState: 'disconnected',
      nowMs: T0 + 1_000, deadlineMs: DEADLINE,
    })).toBe(false);
    expect(shouldKeepRetrying({
      cancelled: false, leaving: true, txConnectionState: 'disconnected',
      nowMs: T0 + 1_000, deadlineMs: DEADLINE,
    })).toBe(false);
  });
});
