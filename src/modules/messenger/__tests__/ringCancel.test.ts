import {shouldSendRingCancel} from '@/modules/messenger/webrtc/ringCancelDecision';

/**
 * B-12 — when the host leaves before anyone joins, the still-ringing
 * invitees must be told to stop ringing. The decision was previously
 * gated on `ringStartedAt` (only set AFTER the sfu.ring ack lands), so a
 * host who tapped End between "sendTx connected" and the ring ack landing
 * left invitees ringing the full 30s window. These tests pin the pure
 * predicate leaveInternal consults: an outgoing host who RANG (or
 * attempted to) cancels even when ringStartedAt is still null.
 */

const base = {
  isHost:           true,
  direction:        'outgoing' as const,
  sentRing:         true,
  ringStartedAt:    null as number | null,
  recipientCount:   2,
  stillRingingCount: 2,
};

describe('shouldSendRingCancel — B-12 host-leaves-before-join gap', () => {
  it('(a) cancels for an outgoing host who rang even when ringStartedAt is null and 0 joined', () => {
    expect(shouldSendRingCancel({...base})).toBe(true);
  });

  it('(b) cancels for an outgoing host once ringStartedAt is set', () => {
    expect(shouldSendRingCancel({...base, sentRing: false, ringStartedAt: Date.now()})).toBe(true);
  });

  it('(c) does NOT cancel for a non-host', () => {
    expect(shouldSendRingCancel({...base, isHost: false})).toBe(false);
  });

  it('(d) does NOT cancel for an incoming participant', () => {
    expect(shouldSendRingCancel({...base, direction: 'incoming'})).toBe(false);
  });

  it('(e) does NOT cancel when the host never rang and the ring never started', () => {
    expect(shouldSendRingCancel({...base, sentRing: false, ringStartedAt: null})).toBe(false);
  });

  it('(f) does NOT cancel when nobody is still ringing (all joined)', () => {
    expect(shouldSendRingCancel({...base, stillRingingCount: 0})).toBe(false);
  });

  it('(g) does NOT cancel when there were no recipients to ring', () => {
    expect(shouldSendRingCancel({...base, recipientCount: 0, stillRingingCount: 0})).toBe(false);
  });
});
