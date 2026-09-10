/**
 * WI-5.5 (transport G4) — inbound call frames are serialized PER CALLID.
 *
 * `dispatchCallFrame` is synchronous by contract, but `call.offer` for an
 * unregistered callId runs an ASYNC verifier (Audit S7, XEd25519 chain) and
 * used to fire-and-forget it — so a `call.answer`/`call.ice`/`call.hangup`
 * that followed the offer ON THE WIRE could be fully processed before the
 * offer finished verifying. The answer then found no registered signalling,
 * got queued, and drained only when/if the offer's screen registered — or a
 * hangup tore ring state down BEFORE the verified offer presented it,
 * resurrecting the ring for a call the caller had already abandoned.
 *
 * Fix: a per-callId promise chain (mirror of the outbound `callIdQueues`).
 * The offer's verification is the chain head; later frames for the SAME
 * callId append behind it and run in wire order. Frames for OTHER callIds
 * never touch the chain — no cross-call serialization, and the no-chain
 * path stays exactly the old synchronous one.
 */

jest.mock('../push/callNotification', () => ({
  dismissCallNotif:    jest.fn(async () => {}),
  showMissedCallNotif: jest.fn(async () => {}),
}));
jest.mock('../push/callKitBridge', () => ({
  reportEnded: jest.fn(),
}));
jest.mock('../push/fcmBootstrap', () => ({
  notifyCallEnded:            jest.fn(),
  wasCallExplicitlyAccepted:  jest.fn(() => false),
}));
jest.mock('../store/messengerStore', () => ({
  useMessengerStore: {getState: () => ({conversations: {}, appendMessage: jest.fn()})},
}));
jest.mock('../runtime/callRegistry', () => ({
  getActiveCall: () => null,
  endActiveCall: jest.fn(() => 'ended'),
  wasRecentlyEnded: () => false,
}));

import {
  dispatchCallFrame,
  registerSignalling,
  setIncomingCallHandler,
  setCallOfferVerifier,
  clearAllCallDispatchState,
} from '../webrtc/callDispatcher';
import type {ServerFrame} from '@bravo/messenger-core';

type Sig = {ingest: jest.Mock};
function fakeSig(): Sig {
  return {ingest: jest.fn()};
}

const offer = (callId: string): ServerFrame => ({
  event: 'call.offer',
  data:  {callId, from: {userId: 'peer-1', deviceId: 1}, sdp: 'sdp-offer', kind: 'voice'},
} as never);
const answer = (callId: string): ServerFrame => ({
  event: 'call.answer',
  data:  {callId, from: {userId: 'peer-1', deviceId: 1}, sdp: 'sdp-answer'},
} as never);
const ice = (callId: string): ServerFrame => ({
  event: 'call.ice',
  data:  {callId, from: {userId: 'peer-1', deviceId: 1}, candidate: 'c', sdpMid: '0', sdpMLineIndex: 0},
} as never);
const hangup = (callId: string): ServerFrame => ({
  event: 'call.hangup',
  data:  {callId, from: {userId: 'peer-1', deviceId: 1}, reason: 'ended'},
} as never);

const flush = async (): Promise<void> => {
  // The chain has several microtask hops per link (epoch wrapper + the
  // verify race + the tail cleanup) — drain generously.
  for (let i = 0; i < 10; i++) { await Promise.resolve(); }
};

beforeEach(() => {
  clearAllCallDispatchState();
});

describe('WI-5.5 — a slow offer verification holds later frames for ITS callId', () => {
  it('a sig that registers MID-VERIFY takes delivery directly — offer then answer, wire order, no re-present (F-1)', async () => {
    const order: string[] = [];
    let releaseVerify: () => void = () => undefined;
    setCallOfferVerifier(() => new Promise(r => { releaseVerify = () => r({ok: true} as never); }));
    setIncomingCallHandler(() => { order.push('offer-presented'); return true; });

    // Wire order: offer (slow verify) then answer.
    dispatchCallFrame(offer('c-1'));
    dispatchCallFrame(answer('c-1'));
    await flush();

    // The answer must NOT have been processed yet — its offer is unverified.
    expect(order).toEqual([]);

    // The screen registers while the verify is still pending (fast user —
    // e.g. the cache-path notification answer mounted CallScreen already).
    const sig = fakeSig();
    registerSignalling('c-1', sig as never);

    releaseVerify();
    await flush();

    // Round 2 F-1 — the verified offer goes to the REGISTERED sig (the
    // replay/re-assert lane), never through the full present handler:
    // reportIncomingCall for a uuid with a live connection orphans the
    // CXCall. The chained answer follows, wire order intact.
    expect(order).toEqual([]);
    const ingested = sig.ingest.mock.calls.map(c => (c[0] as {event: string}).event);
    expect(ingested).toEqual(['call.offer', 'call.answer']);
  });

  it('a hangup behind a slow verify does not tear ring state down early', async () => {
    const order: string[] = [];
    let releaseVerify: () => void = () => undefined;
    setCallOfferVerifier(() => new Promise(r => { releaseVerify = () => r({ok: true} as never); }));
    setIncomingCallHandler(() => { order.push('presented'); return true; });

    dispatchCallFrame(offer('c-2'));
    dispatchCallFrame(hangup('c-2'));
    await flush();

    // Pre-fix the hangup's no-sig teardown ran immediately (tombstone +
    // reportEnded) while the offer was still verifying — the verified offer
    // then presented a ring for a call that had already been torn down.
    const {reportEnded} = require('../push/callKitBridge') as {reportEnded: jest.Mock};
    expect(reportEnded).not.toHaveBeenCalled();

    releaseVerify();
    await flush();

    expect(order).toEqual(['presented']);
    expect(reportEnded).toHaveBeenCalled(); // the hangup ran AFTER, wire order
  });

  it('frames for an UNRELATED callId are not serialized behind the slow verify', async () => {
    setCallOfferVerifier(() => new Promise(() => { /* never resolves */ }));
    setIncomingCallHandler(() => true);

    dispatchCallFrame(offer('c-slow'));

    const sig = fakeSig();
    registerSignalling('c-other', sig as never);
    dispatchCallFrame(answer('c-other'));
    dispatchCallFrame(ice('c-other'));

    // Synchronous, exactly the old path — no chain involvement.
    expect(sig.ingest).toHaveBeenCalledTimes(2);
  });

  it('with no pending verify, dispatch stays synchronous (the fast path is untouched)', () => {
    const sig = fakeSig();
    registerSignalling('c-sync', sig as never);
    dispatchCallFrame(answer('c-sync'));
    expect(sig.ingest).toHaveBeenCalledTimes(1);
  });

  it('a REJECTED verification drops the offer and the chained frames still run after it', async () => {
    const presented: string[] = [];
    let rejectVerify: () => void = () => undefined;
    setCallOfferVerifier(() => new Promise(r => { rejectVerify = () => r({ok: false, reason: 'sig'} as never); }));
    setIncomingCallHandler(() => { presented.push('presented'); return true; });

    dispatchCallFrame(offer('c-forged'));
    dispatchCallFrame(hangup('c-forged'));
    await flush();

    rejectVerify();
    await flush();

    expect(presented).toEqual([]); // forged offer never presented
    const {reportEnded} = require('../push/callKitBridge') as {reportEnded: jest.Mock};
    expect(reportEnded).toHaveBeenCalled(); // the hangup still processed
  });

  it('the chain is cleaned up — a later frame for the same callId is synchronous again', async () => {
    let releaseVerify: () => void = () => undefined;
    setCallOfferVerifier(() => new Promise(r => { releaseVerify = () => r({ok: true} as never); }));
    setIncomingCallHandler(() => true);

    dispatchCallFrame(offer('c-clean'));
    await flush(); // the verifier is invoked a tick later — let it capture release
    releaseVerify();
    await flush();
    await flush();

    const sig = fakeSig();
    registerSignalling('c-clean', sig as never);
    dispatchCallFrame(ice('c-clean'));
    expect(sig.ingest).toHaveBeenCalledTimes(1); // sync — no chain left
  });
});
