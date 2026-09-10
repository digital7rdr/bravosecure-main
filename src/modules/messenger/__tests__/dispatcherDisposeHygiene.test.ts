/**
 * WI-5.7 (transport G6) — dispatcher state clears on EVERY runtime disposal
 * path, and the clear preserves the app-level registrations.
 *
 * `clearAllCallDispatchState` ran only on signOut. The restore rebuild, the
 * backup-setup rebuild, and the account switch all pass `disposeLiveRuntime`
 * — where NOTHING dropped the dispatcher's queued frames or registered
 * signalling. The epoch fence stops NEW frames after a switch; frames
 * already QUEUED pre-registration drained into whatever signalling later
 * registered the same callId, across the account boundary, inside the 30 s
 * TTL.
 *
 * The clear must NOT touch `onIncoming` / `verifyOfferAuth`: both are
 * MainNavigator-owned (installed on `[user?.id]`) and are NOT re-installed
 * on a mid-session rebuild. Clearing the handler kills incoming 1:1 calls
 * after every restore; clearing the verifier drops offers to the legacy
 * UNVERIFIED fallback in the dispose→rebuild gap.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

jest.mock('../push/callNotification', () => ({
  dismissCallNotif:    jest.fn(async () => {}),
  showMissedCallNotif: jest.fn(async () => {}),
}));
jest.mock('../push/callKitBridge', () => ({reportEnded: jest.fn()}));
jest.mock('../push/fcmBootstrap', () => ({
  notifyCallEnded:           jest.fn(),
  wasCallExplicitlyAccepted: jest.fn(() => false),
}));
jest.mock('../store/messengerStore', () => ({
  useMessengerStore: {getState: () => ({conversations: {}, appendMessage: jest.fn()})},
}));
let mockActiveCall: {callId: string} | null = null;
jest.mock('../runtime/callRegistry', () => ({
  getActiveCall: () => mockActiveCall,
  endActiveCall: jest.fn(() => 'ended'),
  wasRecentlyEnded: () => false,
}));

import {
  dispatchCallFrame,
  registerSignalling,
  setIncomingCallHandler,
  setCallOfferVerifier,
  clearAllCallDispatchState,
  clearCallDispatchTransients,
} from '../webrtc/callDispatcher';
import type {ServerFrame} from '@bravo/messenger-core';

const answer = (callId: string): ServerFrame => ({
  event: 'call.answer',
  data:  {callId, from: {userId: 'peer-1', deviceId: 1}, sdp: 'sdp-answer'},
} as never);
const offer = (callId: string): ServerFrame => ({
  event: 'call.offer',
  data:  {callId, from: {userId: 'peer-1', deviceId: 1}, sdp: 'sdp', kind: 'voice'},
} as never);

const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\r\n]*/g, '');
}

beforeEach(() => {
  mockActiveCall = null;
  clearAllCallDispatchState();
});

describe('WI-5.7 — clearCallDispatchTransients', () => {
  it('a frame queued before the dispose can NEVER drain into a later registration', () => {
    dispatchCallFrame(answer('c-cross')); // queued — no signalling yet
    clearCallDispatchTransients();        // the dispose path

    const sig = {ingest: jest.fn()};
    registerSignalling('c-cross', sig as never); // next session, reused callId
    expect(sig.ingest).not.toHaveBeenCalled();
  });

  it('PRESERVES the incoming handler — calls still present after a restore rebuild', async () => {
    const presented: string[] = [];
    setIncomingCallHandler(() => { presented.push('ring'); return true; });
    setCallOfferVerifier(async () => ({ok: true} as never));

    clearCallDispatchTransients(); // restore rebuild disposes; MainNavigator does NOT re-install

    dispatchCallFrame(offer('c-after'));
    await flush();
    expect(presented).toEqual(['ring']);
  });

  it('PRESERVES the verifier — the dispose→rebuild gap never downgrades to the unverified fallback', async () => {
    const presented: string[] = [];
    setIncomingCallHandler(() => { presented.push('ring'); return true; });
    setCallOfferVerifier(async () => ({ok: false, reason: 'sig'} as never));

    clearCallDispatchTransients();

    dispatchCallFrame(offer('c-forged'));
    await flush();
    // A cleared verifier would have taken the legacy fallback and PRESENTED.
    expect(presented).toEqual([]);
  });

  it('signOut still clears everything including the handler + verifier', async () => {
    const presented: string[] = [];
    setIncomingCallHandler(() => { presented.push('ring'); return true; });
    setCallOfferVerifier(async () => ({ok: true} as never));

    clearAllCallDispatchState();

    dispatchCallFrame(offer('c-signout'));
    await flush();
    expect(presented).toEqual([]); // no handler → cached, not presented
  });
});

describe('round 1 — the epoch fence kills chain WORK the map clear cannot reach (edge B)', () => {
  it('a frame CHAINED behind a slow verify cannot survive the session clear', async () => {
    let releaseVerify: () => void = () => undefined;
    setCallOfferVerifier(() => new Promise(r => { releaseVerify = () => r({ok: true} as never); }));
    const presented: string[] = [];
    setIncomingCallHandler(() => { presented.push('prev-session-ring'); return true; });

    dispatchCallFrame(offer('reused-id'));  // chain head: verify pending
    await flush();                          // verifier invoked, capture release
    dispatchCallFrame(answer('reused-id')); // CHAINED behind the verify

    clearCallDispatchTransients();          // the session ends mid-verify

    releaseVerify();
    await flush();
    await flush();

    // Neither the offer's presentation nor the chained answer's queueing may
    // survive: the epoch fence makes the scheduled work a no-op.
    expect(presented).toEqual([]);
    const sig = {ingest: jest.fn()};
    registerSignalling('reused-id', sig as never); // next session, reused id
    expect(sig.ingest).not.toHaveBeenCalled();
  });
});

describe('round 1 — the LIVE call\'s signalling survives a mid-session rebuild (edge C)', () => {
  it('a minimized call\'s registration + queued frames are preserved; everything else is purged', () => {
    mockActiveCall = {callId: 'c-live'};
    const liveSig = {ingest: jest.fn()};
    registerSignalling('c-live', liveSig as never);
    const deadSig = {ingest: jest.fn()};
    registerSignalling('c-dead', deadSig as never);
    dispatchCallFrame(answer('c-queued')); // unrelated queued frame

    clearCallDispatchTransients();

    // The live call still hears its frames — a minimized call has no hook
    // mounted to re-register, and deafening it dropped the peer's hangup.
    dispatchCallFrame(answer('c-live'));
    expect(liveSig.ingest).toHaveBeenCalledTimes(1);
    // The rest of the previous session is gone.
    dispatchCallFrame(answer('c-dead'));
    expect(deadSig.ingest).not.toHaveBeenCalled();
    const sig = {ingest: jest.fn()};
    registerSignalling('c-queued', sig as never);
    expect(sig.ingest).not.toHaveBeenCalled();
  });

  it('signOut clears even the live call\'s entry (the registry is emptied first there)', () => {
    // authStore ends the active call BEFORE clearing, so getActiveCall() is
    // null on that lane — modelled here by the mock default.
    const liveSig = {ingest: jest.fn()};
    registerSignalling('c-was-live', liveSig as never);
    clearAllCallDispatchState();
    dispatchCallFrame(answer('c-was-live'));
    expect(liveSig.ingest).not.toHaveBeenCalled();
  });
});

describe('WI-5.7 — disposeLiveRuntime reaches the transients clear (source scan)', () => {
  it('the dispose body calls clearCallDispatchTransients, guarded-lazily', () => {
    const src = stripComments(readFileSync(
      join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts'), 'utf8',
    ));
    const at = src.indexOf('export function disposeLiveRuntime');
    expect(at).toBeGreaterThan(-1);
    // The dispose body runs to the next exported symbol; the clear must sit
    // inside it (same anchoring style as runtimeRebuildDispose's pin).
    const end = src.indexOf('export function', at + 10);
    const body = src.slice(at, end);
    expect(body).toMatch(/clearCallDispatchTransients\(\);/);
  });
});
