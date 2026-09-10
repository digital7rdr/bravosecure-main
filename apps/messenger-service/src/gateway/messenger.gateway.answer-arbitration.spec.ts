/**
 * WI-6.1 — ANSWER ARBITRATION: first answer wins, system-wide.
 *
 * Contract under test:
 *   1. The FIRST `call.answer` forwards, promotes the session to 'active',
 *      and records `answeredBy {userId, deviceId}`.
 *   2. A SECOND answer for the active session — another device OR a
 *      same-device retry — is NOT forwarded. It returns the idempotent
 *      success shape (undefined, exactly what a clean forward returns).
 *   3. The first answer clears the queued-offer artifacts on BOTH lanes:
 *      the answering socket's own (user, device) and the session's PINNED
 *      callee address (the lane `handleCallOffer` actually queued on) —
 *      deduped when they coincide.
 *   4. The first answer fans ONE answered-elsewhere cancel push
 *      (missed=false) so the callee's other devices collapse their rings.
 *   5. The durable-answer drain records `answeredBy` from the flushed
 *      frame's `from`, so a late duplicate answer after a restart-flush is
 *      dropped by the same gate.
 *
 * Harness style: prototype methods on a hand-built `this` (same as the
 * privacy/calls specs).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import type {Socket} from 'socket.io';
import {MessengerGateway} from './messenger.gateway';

const proto: any = MessengerGateway.prototype;

const CALLER = 'caller-user';
const CALLEE = 'callee-user';
const CID = 'call-arb-0001';

function fakeClient(sub: string, deviceId: number): Socket & {emit: jest.Mock} {
  return {
    id:   `sock-${sub}-${deviceId}`,
    data: {claims: {sub}, signalDeviceId: deviceId, sessionId: `s-${sub}`},
    connected: true,
    emit: jest.fn(),
  } as unknown as Socket & {emit: jest.Mock};
}

function arbThis() {
  const self: any = {
    rateGate:     () => null,
    callSessions: new Map(),
    socketCalls:  new WeakMap(),
    logger:       {log: jest.fn(), warn: jest.fn()},
    push:         {sendCallCancel: jest.fn(async () => 1)},
    forwardToDevice: jest.fn(async () => undefined),
    queuePendingAnswer: jest.fn(),
    clearPendingCallArtifacts: jest.fn(async () => undefined),
  };
  self.authorizeCallFrame   = proto.authorizeCallFrame.bind(self);
  self.trackCallAnswer      = proto.trackCallAnswer.bind(self);
  self.trackCallStart       = proto.trackCallStart.bind(self);
  self.trackCallEnd         = proto.trackCallEnd.bind(self);
  self.gcCallTombstones     = proto.gcCallTombstones.bind(self);
  self.rehydrateCallSession = proto.rehydrateCallSession.bind(self);
  return self;
}

/** Seed a ringing session the way handleCallOffer does. */
function seedRinging(self: any, calleeDeviceId = 1): void {
  const err = self.trackCallStart(
    fakeClient(CALLER, 2), CID,
    {userId: CALLER, deviceId: 2},
    {userId: CALLEE, deviceId: calleeDeviceId},
  );
  expect(err).toBeUndefined();
}

const answerFrame = (deviceId: number) => ({
  callId: CID,
  to:     {userId: CALLER, deviceId: 2},
  sdp:    'v=0-answer',
});

describe('WI-6.1 — first answer wins', () => {
  it('first answer forwards, promotes to active, records answeredBy', async () => {
    const self = arbThis();
    seedRinging(self);
    const ret = await proto.handleCallAnswer.call(self, answerFrame(7), fakeClient(CALLEE, 7));
    expect(ret).toBeUndefined();
    expect(self.forwardToDevice).toHaveBeenCalledTimes(1);
    const s = self.callSessions.get(CID);
    expect(s.state).toBe('active');
    expect(s.answeredBy).toEqual({userId: CALLEE, deviceId: 7});
  });

  it('a second answer from ANOTHER device is not forwarded and returns idempotent success', async () => {
    const self = arbThis();
    seedRinging(self);
    const winner = fakeClient(CALLEE, 7);
    const loser  = fakeClient(CALLEE, 8);
    await proto.handleCallAnswer.call(self, answerFrame(7), winner);
    const ret = await proto.handleCallAnswer.call(self, answerFrame(8), loser);
    expect(ret).toBeUndefined();                            // same shape as a clean forward
    expect(self.forwardToDevice).toHaveBeenCalledTimes(1);  // only the winner forwarded
    // The winner stays the winner.
    expect(self.callSessions.get(CID).answeredBy).toEqual({userId: CALLEE, deviceId: 7});
    // Round 2 (critic F1) — the loser gets a DIRECT verdict on its own
    // socket (its push-cancel copy is ignored by its own accept latch);
    // without this it strands at "Answering…" and its watchdog's authorized
    // hangup could tombstone the LIVE call. Directed: the winner's socket
    // must see nothing (a room emit would reach it — shared deviceRoom).
    expect(loser.emit).toHaveBeenCalledWith('call.hangup', {
      callId: CID, from: {userId: CALLER, deviceId: 2}, reason: 'ended',
    });
    expect(winner.emit).not.toHaveBeenCalled();
  });

  it('a same-device duplicate answer is dropped too (no second SDP at the caller)', async () => {
    const self = arbThis();
    seedRinging(self);
    await proto.handleCallAnswer.call(self, answerFrame(7), fakeClient(CALLEE, 7));
    const ret = await proto.handleCallAnswer.call(self, answerFrame(7), fakeClient(CALLEE, 7));
    expect(ret).toBeUndefined();
    expect(self.forwardToDevice).toHaveBeenCalledTimes(1);
  });

  it('the loser gets no pendingAnswer queue entry either', async () => {
    const self = arbThis();
    seedRinging(self);
    // Make the FIRST forward hit peer_offline so the winner's answer queues.
    self.forwardToDevice = jest.fn(async () => ({event: 'error', data: {code: 'peer_offline', message: ''}}));
    await proto.handleCallAnswer.call(self, answerFrame(7), fakeClient(CALLEE, 7));
    expect(self.queuePendingAnswer).toHaveBeenCalledTimes(1);
    await proto.handleCallAnswer.call(self, answerFrame(8), fakeClient(CALLEE, 8));
    expect(self.queuePendingAnswer).toHaveBeenCalledTimes(1); // loser never queues
  });
});

describe('WI-6.1 — first-answer artifact clear + answered-elsewhere collapse', () => {
  it('clears BOTH the answering lane and the session-pinned callee lane when they differ', async () => {
    const self = arbThis();
    seedRinging(self, /*calleeDeviceId*/ 1); // offer was queued on (CALLEE, 1)
    await proto.handleCallAnswer.call(self, answerFrame(7), fakeClient(CALLEE, 7));
    const lanes = self.clearPendingCallArtifacts.mock.calls.map((c: unknown[]) => [c[0], c[1], c[2]]);
    expect(lanes).toContainEqual([CALLEE, 7, CID]); // answering socket's lane
    expect(lanes).toContainEqual([CALLEE, 1, CID]); // the lane the offer was QUEUED on
  });

  it('clears exactly once when the lanes coincide (no duplicate DELs)', async () => {
    const self = arbThis();
    seedRinging(self, /*calleeDeviceId*/ 7);
    await proto.handleCallAnswer.call(self, answerFrame(7), fakeClient(CALLEE, 7));
    expect(self.clearPendingCallArtifacts).toHaveBeenCalledTimes(1);
  });

  it('fans ONE answered-elsewhere cancel push (missed=false), only on the first answer', async () => {
    const self = arbThis();
    seedRinging(self);
    await proto.handleCallAnswer.call(self, answerFrame(7), fakeClient(CALLEE, 7));
    await proto.handleCallAnswer.call(self, answerFrame(8), fakeClient(CALLEE, 8));
    expect(self.push.sendCallCancel).toHaveBeenCalledTimes(1);
    expect(self.push.sendCallCancel).toHaveBeenCalledWith(
      CALLEE, CID, CALLER, 'voice', /*missed*/ false,
    );
  });

  it('a losing answer clears nothing (its artifacts were already cleared by the winner)', async () => {
    const self = arbThis();
    seedRinging(self);
    await proto.handleCallAnswer.call(self, answerFrame(7), fakeClient(CALLEE, 7));
    const clearsAfterFirst = self.clearPendingCallArtifacts.mock.calls.length;
    await proto.handleCallAnswer.call(self, answerFrame(8), fakeClient(CALLEE, 8));
    expect(self.clearPendingCallArtifacts.mock.calls.length).toBe(clearsAfterFirst);
  });

  it('an answer for an ended (tombstoned) call is silently ignored — no forward, no clear, no push', async () => {
    const self = arbThis();
    seedRinging(self);
    self.trackCallEnd(CID);
    const ret = await proto.handleCallAnswer.call(self, answerFrame(7), fakeClient(CALLEE, 7));
    expect(ret).toBeUndefined();
    expect(self.forwardToDevice).not.toHaveBeenCalled();
    expect(self.clearPendingCallArtifacts).not.toHaveBeenCalled();
    expect(self.push.sendCallCancel).not.toHaveBeenCalled();
  });
});

describe('WI-6.1 — the durable-answer drain records the winner', () => {
  function drainThis() {
    const self = arbThis();
    const store = new Map<string, string>();
    const sets  = new Map<string, Set<string>>();
    self.redis = {client: {
      smembers: jest.fn(async (k: string) => Array.from(sets.get(k) ?? [])),
      get:      jest.fn(async (k: string) => store.get(k) ?? null),
      del:      jest.fn(async (k: string) => { store.delete(k); return 1; }),
      srem:     jest.fn(async (k: string, m: string) => { sets.get(k)?.delete(m); return 1; }),
    }};
    return {self, store, sets};
  }

  it('flushDurablePendingAnswers stamps answeredBy from the frame.from', async () => {
    const {self, store, sets} = drainThis();
    seedRinging(self);
    const idxKey = `pending-call-answer-idx:${CALLER}:2`;
    const payloadKey = `pending-call-answer:${CALLER}:2:${CID}`;
    sets.set(idxKey, new Set([CID]));
    store.set(payloadKey, JSON.stringify({
      callId: CID, from: {userId: CALLEE, deviceId: 7}, sdp: 'v=0-answer',
    }));
    const callerSock = fakeClient(CALLER, 2);
    await proto.flushDurablePendingAnswers.call(self, callerSock, {userId: CALLER, deviceId: 2}, new Set());
    expect(callerSock.emit).toHaveBeenCalledWith('call.answer', expect.objectContaining({callId: CID}));
    const s = self.callSessions.get(CID);
    expect(s.state).toBe('active');
    expect(s.answeredBy).toEqual({userId: CALLEE, deviceId: 7});
    // ...and the gate now drops a late duplicate answer instead of forwarding.
    const ret = await proto.handleCallAnswer.call(self, answerFrame(8), fakeClient(CALLEE, 8));
    expect(ret).toBeUndefined();
    expect(self.forwardToDevice).not.toHaveBeenCalled();
  });

  it('first writer wins: a live answer that landed first is not overwritten by the drain', async () => {
    const self = arbThis();
    seedRinging(self);
    self.trackCallAnswer(fakeClient(CALLEE, 7), CID, {userId: CALLEE, deviceId: 7});
    self.trackCallAnswer(fakeClient(CALLER, 2), CID, {userId: CALLEE, deviceId: 9});
    expect(self.callSessions.get(CID).answeredBy).toEqual({userId: CALLEE, deviceId: 7});
  });
});
