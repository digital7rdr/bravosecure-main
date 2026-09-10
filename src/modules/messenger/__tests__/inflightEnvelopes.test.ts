/**
 * B-126 — in-flight envelope registry: keeps the L16 double-decrypt
 * guard but bounds it, so a wedged receive frame can no longer make
 * every redelivery of its envelope a silent no-op forever.
 */

import {
  tryAcquireEnvelope,
  releaseEnvelope,
  resetInflightRegistry,
  isEnvelopeInFlight,
  INFLIGHT_STALE_MS,
} from '../runtime/inflightEnvelopes';

beforeEach(() => resetInflightRegistry());

describe('inflightEnvelopes (B-126)', () => {
  it('acquire → busy while held → free after release', () => {
    const t0 = 1_000_000;
    const hold = tryAcquireEnvelope('env-1', t0);
    expect(typeof hold).toBe('number');
    expect(tryAcquireEnvelope('env-1', t0 + 1000)).toBe('busy');
    releaseEnvelope('env-1', hold as number);
    expect(typeof tryAcquireEnvelope('env-1', t0 + 2000)).toBe('number');
  });

  it('a hold older than the stale deadline is evicted and re-acquired', () => {
    const t0 = 1_000_000;
    tryAcquireEnvelope('env-1', t0);
    const again = tryAcquireEnvelope('env-1', t0 + INFLIGHT_STALE_MS + 1);
    expect(typeof again).toBe('number'); // stale hold evicted, new attempt owns it
  });

  it('a zombie release cannot free the hold a newer attempt owns', () => {
    const t0 = 1_000_000;
    const zombie = tryAcquireEnvelope('env-1', t0) as number;
    const fresh = tryAcquireEnvelope('env-1', t0 + INFLIGHT_STALE_MS + 1) as number;
    // The wedged frame's finally fires late — must be a no-op now.
    releaseEnvelope('env-1', zombie);
    expect(tryAcquireEnvelope('env-1', t0 + INFLIGHT_STALE_MS + 2000)).toBe('busy');
    releaseEnvelope('env-1', fresh);
    expect(typeof tryAcquireEnvelope('env-1', t0 + INFLIGHT_STALE_MS + 3000)).toBe('number');
  });

  it('holds are per-envelope', () => {
    const t0 = 1_000_000;
    tryAcquireEnvelope('env-1', t0);
    expect(typeof tryAcquireEnvelope('env-2', t0)).toBe('number');
  });

  describe('isEnvelopeInFlight (B-703 MR-1) — "is a LIVE pass still holding this?"', () => {
    it('true while held, false once released', () => {
      const t0 = 2_000_000;
      const hold = tryAcquireEnvelope('env-h', t0) as number;
      expect(isEnvelopeInFlight('env-h', t0)).toBe(true);
      releaseEnvelope('env-h', hold);
      expect(isEnvelopeInFlight('env-h', t0)).toBe(false);
    });

    it('false for an envelope nobody ever held', () => {
      expect(isEnvelopeInFlight('never', 2_000_000)).toBe(false);
    });

    it('a WEDGED hold is NOT trusted past the stale window', () => {
      // The drain's report trusts a still-held skip ("that pass owns it"). If a
      // leaked hold stayed "in flight" forever, the skip could never be demoted
      // to left-on-relay and the wake would report a clean drain and go silent —
      // the B-126 wedge class re-armed inside the notification lane.
      const t0 = 3_000_000;
      tryAcquireEnvelope('env-wedged', t0);
      expect(isEnvelopeInFlight('env-wedged', t0 + INFLIGHT_STALE_MS)).toBe(true);
      expect(isEnvelopeInFlight('env-wedged', t0 + INFLIGHT_STALE_MS + 1)).toBe(false);
    });
  });

  it('the stale deadline outlives the chain watchdog force-advance', () => {
    const {CHAIN_FRAME_FORCE_MS} = require('../runtime/receiveTransaction') as
      typeof import('../runtime/receiveTransaction');
    // Invariant: the chain must be unwedged BEFORE a stale eviction lets a
    // redelivery re-enter it, or the fresh attempt queues behind the wedge.
    expect(INFLIGHT_STALE_MS).toBeGreaterThan(CHAIN_FRAME_FORCE_MS);
  });
});
