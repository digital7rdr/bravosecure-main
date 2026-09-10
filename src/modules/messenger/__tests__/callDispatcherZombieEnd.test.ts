/**
 * B-64 — server-declared-dead calls must tear down a live-but-wedged
 * registry session. The 2026-07-10 Pixel-7a zombie: the killed-app answer
 * path built a controller + FGS, `call.answer` never registered
 * server-side, and the caller's give-up (`call.missed` push / unmatched
 * `call.hangup`) left the session and its unclearable ongoing-call
 * notification running forever.
 */

import {dispatchCallFrame} from '../webrtc/callDispatcher';
import {getActiveCall, setActiveCall, type ActiveCallState} from '../runtime/callRegistry';
import type {ServerFrame} from '@bravo/messenger-core';

const PEER = {userId: 'caller-1', deviceId: 1};

function seedActiveCall(state: ActiveCallState['state'], callId = 'cid-zombie'): void {
  setActiveCall({
    callId,
    conversationId: 'conv-1',
    peer:           PEER,
    peerName:       'Caller One',
    kind:           'voice',
    direction:      'incoming',
    controller:     null,
    signalling:     null,
    unregister:     null,
    localStream:    null,
    remoteStream:   null,
    audioTrack:     null,
    videoTrack:     null,
    state,
    isMinimized:    false,
    keepAlive:      false,
    connectedAtMs:  null,
  });
}

afterEach(() => { setActiveCall(null); });

describe('B-64 — zombie session teardown on server-dead call', () => {
  it('call.missed for the live callId ends the wedged session', () => {
    seedActiveCall('connecting');
    dispatchCallFrame({
      event: 'call.missed',
      data:  {callId: 'cid-zombie', from: PEER, kind: 'voice'},
    } as unknown as ServerFrame);
    expect(getActiveCall()).toBeNull();
  });

  it('unmatched call.hangup for the live callId ends the wedged session', () => {
    seedActiveCall('connecting');
    dispatchCallFrame({
      event: 'call.hangup',
      data:  {callId: 'cid-zombie', from: PEER, reason: 'ended'},
    } as unknown as ServerFrame);
    expect(getActiveCall()).toBeNull();
  });

  it('call.missed for a DIFFERENT callId leaves the live session alone', () => {
    seedActiveCall('connecting');
    dispatchCallFrame({
      event: 'call.missed',
      data:  {callId: 'cid-other', from: PEER, kind: 'voice'},
    } as unknown as ServerFrame);
    expect(getActiveCall()?.callId).toBe('cid-zombie');
  });

  it('terminal sessions are not re-ended (no double teardown)', () => {
    seedActiveCall('ended');
    dispatchCallFrame({
      event: 'call.missed',
      data:  {callId: 'cid-zombie', from: PEER, kind: 'voice'},
    } as unknown as ServerFrame);
    // Slot untouched — endActiveCall was not invoked for a terminal state.
    expect(getActiveCall()?.callId).toBe('cid-zombie');
  });
});
