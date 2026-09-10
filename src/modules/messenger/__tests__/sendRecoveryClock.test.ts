/**
 * OR-2 — the send-recovery clock constants + throttle.
 */

import {
  shouldDrainOnServerSignal,
  SIGNAL_DRAIN_MIN_INTERVAL_MS,
  DRAIN_STUCK_MS,
} from '../runtime/sendRecoveryClock';
import {TRANSPORT_TIMEOUT_MS} from '@bravo/messenger-core';

describe('OR-2 — shouldDrainOnServerSignal', () => {
  it('a cold start drains immediately', () => {
    expect(shouldDrainOnServerSignal(0, 0)).toBe(true);
  });

  it('throttles inside the window, allows at the boundary', () => {
    const t = 1_800_000_000_000;
    expect(shouldDrainOnServerSignal(t, t + SIGNAL_DRAIN_MIN_INTERVAL_MS - 1)).toBe(false);
    expect(shouldDrainOnServerSignal(t, t + SIGNAL_DRAIN_MIN_INTERVAL_MS)).toBe(true);
  });
});

describe('OR-2 — invariants', () => {
  it('DRAIN_STUCK_MS exceeds the transport timeout (a slow POST is not a wedge)', () => {
    // If either constant is retuned to break this, one slow-but-alive relay
    // POST would be superseded mid-flight and rows double-shipped.
    expect(DRAIN_STUCK_MS).toBeGreaterThan(TRANSPORT_TIMEOUT_MS);
  });
});
