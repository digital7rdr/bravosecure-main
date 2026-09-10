/**
 * Audit P0-C5 — ring timeout + missed-call state machine.
 *
 * Threat / UX model: the offerer's `call.offer` waits forever for an
 * answer if the callee never picks up. Today there is no caller-side
 * cap, no callee-side cap, and no "missed call" record on either side.
 * The screen sits in `calling` / `ringing` until the user manually
 * hangs up — which they may not do for hours.
 *
 * Fix:
 *  - Caller-side: after sending `call.offer`, start RING_TIMEOUT_MS
 *    (default 45 s). On expiry, fire `onExpire('outgoing')` and let
 *    the caller emit `call.hangup` + mark a `missed_call_outgoing`
 *    record.
 *  - Callee-side: matching timer started on `handleIncomingOffer`.
 *    On expiry, fire `onExpire('incoming')`; receiver marks
 *    `missed_call_incoming` and emits `call.hangup`.
 *  - Answer / accept / decline / hangup all cancel the timer.
 *
 * Extracted into a standalone module so the controller stays thin and
 * a unit test can drive it without standing up a fake PC.
 */

import {CallRingState, DEFAULT_RING_TIMEOUT_MS} from '../webrtc/callRingState';

describe('Audit P0-C5 — CallRingState (ring timeout + missed-call)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('exposes the documented 45s default', () => {
    expect(DEFAULT_RING_TIMEOUT_MS).toBe(45_000);
  });

  it('fires onExpire("outgoing") after RING_TIMEOUT_MS when armed for caller', () => {
    const onExpire = jest.fn();
    const s = new CallRingState({onExpire, timeoutMs: 1000});
    s.armOutgoing('cid-1');
    expect(onExpire).not.toHaveBeenCalled();
    jest.advanceTimersByTime(999);
    expect(onExpire).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledWith({callId: 'cid-1', direction: 'outgoing'});
  });

  it('fires onExpire("incoming") after RING_TIMEOUT_MS when armed for callee', () => {
    const onExpire = jest.fn();
    const s = new CallRingState({onExpire, timeoutMs: 500});
    s.armIncoming('cid-2');
    jest.advanceTimersByTime(500);
    expect(onExpire).toHaveBeenCalledWith({callId: 'cid-2', direction: 'incoming'});
  });

  it('cancel() before expiry suppresses the callback', () => {
    const onExpire = jest.fn();
    const s = new CallRingState({onExpire, timeoutMs: 1000});
    s.armOutgoing('cid-3');
    jest.advanceTimersByTime(500);
    s.cancel('cid-3');
    jest.advanceTimersByTime(10_000);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('cancel() for a different callId does not clear the active timer', () => {
    const onExpire = jest.fn();
    const s = new CallRingState({onExpire, timeoutMs: 1000});
    s.armOutgoing('cid-4');
    s.cancel('cid-other');
    jest.advanceTimersByTime(1000);
    expect(onExpire).toHaveBeenCalledWith({callId: 'cid-4', direction: 'outgoing'});
  });

  it('arming a second callId implicitly cancels the first (one call per controller)', () => {
    const onExpire = jest.fn();
    const s = new CallRingState({onExpire, timeoutMs: 1000});
    s.armOutgoing('cid-a');
    s.armIncoming('cid-b');
    jest.advanceTimersByTime(1000);
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(onExpire).toHaveBeenCalledWith({callId: 'cid-b', direction: 'incoming'});
  });

  it('does not re-fire after expiry (single-shot)', () => {
    const onExpire = jest.fn();
    const s = new CallRingState({onExpire, timeoutMs: 100});
    s.armOutgoing('cid-5');
    jest.advanceTimersByTime(100);
    jest.advanceTimersByTime(10_000);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('cancel() AFTER expiry is a no-op (no throw)', () => {
    const onExpire = jest.fn();
    const s = new CallRingState({onExpire, timeoutMs: 100});
    s.armOutgoing('cid-6');
    jest.advanceTimersByTime(100);
    expect(() => s.cancel('cid-6')).not.toThrow();
  });

  it('cancelAll() clears any armed timer regardless of callId', () => {
    const onExpire = jest.fn();
    const s = new CallRingState({onExpire, timeoutMs: 1000});
    s.armIncoming('cid-7');
    s.cancelAll();
    jest.advanceTimersByTime(5000);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('isArmed reflects the current state', () => {
    const onExpire = jest.fn();
    const s = new CallRingState({onExpire, timeoutMs: 1000});
    expect(s.isArmed()).toBe(false);
    s.armOutgoing('cid-8');
    expect(s.isArmed()).toBe(true);
    s.cancel('cid-8');
    expect(s.isArmed()).toBe(false);
  });

  it('uses DEFAULT_RING_TIMEOUT_MS when no timeoutMs is provided', () => {
    const onExpire = jest.fn();
    const s = new CallRingState({onExpire});
    s.armOutgoing('cid-9');
    jest.advanceTimersByTime(DEFAULT_RING_TIMEOUT_MS - 1);
    expect(onExpire).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledWith({callId: 'cid-9', direction: 'outgoing'});
  });

  it('onExpire callback throwing does not crash the state machine', () => {
    const onExpire = jest.fn(() => {throw new Error('boom');});
    const s = new CallRingState({onExpire, timeoutMs: 50});
    s.armOutgoing('cid-10');
    expect(() => jest.advanceTimersByTime(50)).not.toThrow();
    // After throw the timer is consumed — re-arming still works.
    s.armOutgoing('cid-11');
    jest.advanceTimersByTime(50);
    expect(onExpire).toHaveBeenCalledTimes(2);
  });
});
