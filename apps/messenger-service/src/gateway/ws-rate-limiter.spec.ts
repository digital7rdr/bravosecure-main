import {WsRateLimiter, DEFAULT_WS_LIMITS, type ClockSource} from './ws-rate-limiter';

/**
 * Audit P0-5 — WS rate limiter unit tests. Covers:
 *  - Below-capacity bursts are accepted up to the bucket size.
 *  - At-capacity calls return `{ok: false, retryAfterMs}` until refill.
 *  - Refill replenishes tokens linearly with elapsed time.
 *  - Buckets are scoped per (socket, event); cross-talk is impossible.
 *  - DEFAULT_WS_LIMITS covers every event name the gateway gates on.
 */

class FakeClock implements ClockSource {
  ms = 0;
  now(): number { return this.ms; }
  advance(by: number): void { this.ms += by; }
}

function fakeSocket(): object {
  // The limiter only uses the socket as a WeakMap key, so any object
  // shape works. Plain object keeps the test independent of socket.io.
  return {};
}

describe('WsRateLimiter (audit P0-5)', () => {
  it('accepts up to capacity in a burst', () => {
    const clock = new FakeClock();
    const limiter = new WsRateLimiter(clock);
    const sock = fakeSocket();
    const limit = {refillPerSec: 1, capacity: 5};
    for (let i = 0; i < 5; i++) {
      const r = limiter.consume(sock, 'envelope.send', limit);
      expect(r.ok).toBe(true);
    }
  });

  it('rejects the (capacity + 1)th call with a retry hint', () => {
    const clock = new FakeClock();
    const limiter = new WsRateLimiter(clock);
    const sock = fakeSocket();
    const limit = {refillPerSec: 2, capacity: 3};
    for (let i = 0; i < 3; i++) limiter.consume(sock, 'envelope.send', limit);
    const r = limiter.consume(sock, 'envelope.send', limit);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // refillPerSec=2 means 500ms for one token. We just consumed 3
      // immediately, so the bucket is at 0 — wait ~500ms for the next.
      expect(r.retryAfterMs).toBeGreaterThan(0);
      expect(r.retryAfterMs).toBeLessThanOrEqual(500);
    }
  });

  it('refills linearly with elapsed time', () => {
    const clock = new FakeClock();
    const limiter = new WsRateLimiter(clock);
    const sock = fakeSocket();
    const limit = {refillPerSec: 10, capacity: 10};
    // Drain the bucket.
    for (let i = 0; i < 10; i++) limiter.consume(sock, 'evt', limit);
    expect(limiter.consume(sock, 'evt', limit).ok).toBe(false);
    // Advance 200ms → 2 tokens regen.
    clock.advance(200);
    expect(limiter.consume(sock, 'evt', limit).ok).toBe(true);
    expect(limiter.consume(sock, 'evt', limit).ok).toBe(true);
    expect(limiter.consume(sock, 'evt', limit).ok).toBe(false);
  });

  it('refill is clamped at capacity (no infinite credit hoarding)', () => {
    const clock = new FakeClock();
    const limiter = new WsRateLimiter(clock);
    const sock = fakeSocket();
    const limit = {refillPerSec: 5, capacity: 3};
    // First consume creates the bucket at full capacity.
    limiter.consume(sock, 'evt', limit);
    // Sit idle for an hour.
    clock.advance(3_600_000);
    // We still only get capacity (3) consecutive accepts even though
    // 3600 * 5 = 18000 tokens would have theoretically regenerated.
    expect(limiter.consume(sock, 'evt', limit).ok).toBe(true);
    expect(limiter.consume(sock, 'evt', limit).ok).toBe(true);
    expect(limiter.consume(sock, 'evt', limit).ok).toBe(true);
    // 4th call: capacity was 3, the previous-consume reset bucket
    // back to 3 then we drained 3, so it's empty now.
    expect(limiter.consume(sock, 'evt', limit).ok).toBe(false);
  });

  it('buckets are scoped per socket', () => {
    const clock = new FakeClock();
    const limiter = new WsRateLimiter(clock);
    const sockA = fakeSocket();
    const sockB = fakeSocket();
    const limit = {refillPerSec: 1, capacity: 2};
    expect(limiter.consume(sockA, 'evt', limit).ok).toBe(true);
    expect(limiter.consume(sockA, 'evt', limit).ok).toBe(true);
    expect(limiter.consume(sockA, 'evt', limit).ok).toBe(false);
    // Different socket → independent bucket.
    expect(limiter.consume(sockB, 'evt', limit).ok).toBe(true);
    expect(limiter.consume(sockB, 'evt', limit).ok).toBe(true);
  });

  it('buckets are scoped per event on the same socket', () => {
    const clock = new FakeClock();
    const limiter = new WsRateLimiter(clock);
    const sock = fakeSocket();
    const limit = {refillPerSec: 1, capacity: 2};
    expect(limiter.consume(sock, 'evt-a', limit).ok).toBe(true);
    expect(limiter.consume(sock, 'evt-a', limit).ok).toBe(true);
    expect(limiter.consume(sock, 'evt-a', limit).ok).toBe(false);
    // Different event on the same socket → its own bucket.
    expect(limiter.consume(sock, 'evt-b', limit).ok).toBe(true);
  });

  it('DEFAULT_WS_LIMITS covers every gated event', () => {
    // Regression-lock: if a new SubscribeMessage gets a rateGate(…)
    // call without a default limit, the gateway silently no-ops.
    const required = [
      'envelope.send', 'envelope.ack',
      'call.offer', 'call.answer', 'call.reoffer', 'call.reanswer',
      'call.ice', 'call.hangup', 'call.media-state',
      'mission.subscribe', 'mission.unsubscribe',
    ];
    for (const k of required) {
      expect(DEFAULT_WS_LIMITS[k]).toBeDefined();
      expect(DEFAULT_WS_LIMITS[k]!.capacity).toBeGreaterThan(0);
      expect(DEFAULT_WS_LIMITS[k]!.refillPerSec).toBeGreaterThan(0);
    }
  });
});
