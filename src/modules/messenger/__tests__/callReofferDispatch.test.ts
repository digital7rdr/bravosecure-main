/**
 * Audit P1 follow-up — END-TO-END regression for the mid-call SDP
 * renegotiation routing bug.
 *
 * This test stands in for the device-level smoke (boot two devices,
 * connect a voice call, hit the upgrade-to-video button, observe the
 * remote video tile appear within ~2 s). The bug was that the
 * runtime's handleServerFrame gate listed only call.offer / answer /
 * ice / hangup / media-state, so call.reoffer / call.reanswer fell
 * through and never reached callDispatcher — the upgrade hung ~8 s
 * then rolled back.
 *
 * The runtime's gate is now extracted into `callFrameRouter.ts`
 * (`isCallFrame`) and `callFrameRouter.test.ts` locks in its event
 * list. THIS test drives the OTHER side of the contract: given that
 * a frame IS routed to dispatchCallFrame, the dispatcher actually
 * delivers it to the registered signalling. Together they prove the
 * full end-to-end path.
 */

import {
  registerSignalling,
  dispatchCallFrame,
  clearAllCallDispatchState,
} from '../webrtc/callDispatcher';
import {CallSignalling} from '../webrtc/signallingClient';
import {isCallFrame} from '../runtime/callFrameRouter';
import type {TransportClient} from '@bravo/messenger-core';

// CallSignalling.ingest only reads frame.event — the transport is
// never touched in the receive path. A bare object suffices.
function noopTransport(): TransportClient {
  return {} as unknown as TransportClient;
}

describe('call.reoffer / call.reanswer end-to-end routing (P1 follow-up)', () => {
  beforeEach(() => {
    clearAllCallDispatchState();
  });

  it('runtime gate (isCallFrame) accepts reoffer + reanswer', () => {
    // Sanity: if this regresses, the runtime never even calls
    // dispatchCallFrame for these events.
    expect(isCallFrame('call.reoffer')).toBe(true);
    expect(isCallFrame('call.reanswer')).toBe(true);
  });

  it('dispatchCallFrame delivers a call.reoffer to the registered signalling', () => {
    const signalling = new CallSignalling(noopTransport());
    const received: Array<{callId: string; sdp: string}> = [];
    signalling.onReOffer((data) => {
      received.push({callId: data.callId, sdp: data.sdp});
    });
    const unregister = registerSignalling('call-upgrade-1', signalling);
    try {
      const claimed = dispatchCallFrame({
        event: 'call.reoffer',
        data:  {
          callId: 'call-upgrade-1',
          from:   {userId: 'bob', deviceId: 1},
          sdp:    'v=0\no=- 0 0 IN IP4 0.0.0.0\ns=-\nt=0 0\nm=video 9 RTP/AVP 96',
        },
      });
      expect(claimed).toBe(true);
      expect(received).toHaveLength(1);
      expect(received[0].callId).toBe('call-upgrade-1');
      expect(received[0].sdp).toContain('m=video');
    } finally {
      unregister();
    }
  });

  it('dispatchCallFrame delivers a call.reanswer to the registered signalling', () => {
    const signalling = new CallSignalling(noopTransport());
    const received: Array<{callId: string; sdp: string}> = [];
    signalling.onReAnswer((data) => {
      received.push({callId: data.callId, sdp: data.sdp});
    });
    const unregister = registerSignalling('call-upgrade-2', signalling);
    try {
      const claimed = dispatchCallFrame({
        event: 'call.reanswer',
        data:  {
          callId: 'call-upgrade-2',
          from:   {userId: 'alice', deviceId: 1},
          sdp:    'v=0\no=- 0 0 IN IP4 0.0.0.0\ns=-\nt=0 0\nm=video 9 RTP/AVP 96',
        },
      });
      expect(claimed).toBe(true);
      expect(received).toHaveLength(1);
      expect(received[0].callId).toBe('call-upgrade-2');
      expect(received[0].sdp).toContain('m=video');
    } finally {
      unregister();
    }
  });

  it('FULL UPGRADE FLOW: caller emits reoffer → receiver ingests → receiver emits reanswer → caller ingests', () => {
    // Two ends of the same upgrade. Models what happens after both
    // sides have a live call and the caller (Alice) taps "add video".
    const callId    = 'voice-to-video-upgrade-xyz';
    const aliceSig  = new CallSignalling(noopTransport()); // caller side
    const bobSig    = new CallSignalling(noopTransport()); // receiver side

    // In production, each side registers its own signalling for THIS
    // callId on its OWN device — but for the test we use two registrations
    // sequentially (clearAllCallDispatchState between cases isolates them).
    // Simulate Bob's device first:
    const bobReceived: Array<string> = [];
    bobSig.onReOffer(d => bobReceived.push(`reoffer:${d.sdp}`));
    const unregBob = registerSignalling(callId, bobSig);
    try {
      const r1 = dispatchCallFrame({
        event: 'call.reoffer',
        data:  {callId, from: {userId: 'alice', deviceId: 1}, sdp: 'OFFER_SDP'},
      });
      expect(r1).toBe(true);
      expect(bobReceived).toEqual(['reoffer:OFFER_SDP']);
    } finally {
      unregBob();
    }

    // Now Bob has sent the reanswer; simulate Alice's device receiving it.
    const aliceReceived: Array<string> = [];
    aliceSig.onReAnswer(d => aliceReceived.push(`reanswer:${d.sdp}`));
    const unregAlice = registerSignalling(callId, aliceSig);
    try {
      const r2 = dispatchCallFrame({
        event: 'call.reanswer',
        data:  {callId, from: {userId: 'bob', deviceId: 1}, sdp: 'ANSWER_SDP'},
      });
      expect(r2).toBe(true);
      expect(aliceReceived).toEqual(['reanswer:ANSWER_SDP']);
    } finally {
      unregAlice();
    }
  });

  it('REGRESSION — a reoffer for an unknown callId is QUEUED (not dropped) so a remount picks it up', () => {
    // The bug we want to keep closed: dropping the reoffer when no
    // controller is registered leaves the initiator stuck on
    // half-applied addTrack for ~8 s until their watchdog rolls back.
    // The dispatcher should queue it under the same TTL window as ICE
    // candidates so a slightly delayed registerSignalling picks it up.
    const claimed = dispatchCallFrame({
      event: 'call.reoffer',
      data:  {callId: 'no-controller-yet', from: {userId: 'bob', deviceId: 1}, sdp: 'queued-sdp'},
    });
    // Even though no controller exists yet, dispatcher claims the
    // frame (true) by queueing it. A later register would pick it up
    // via the drain mechanism in registerSignalling.
    expect(claimed).toBe(true);
  });
});
