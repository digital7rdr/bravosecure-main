/**
 * P1-BR-4 (B-58) — the AppState-resume path and the WS send-ack watchdog
 * must NOT forceReconnect() a socket that a live call's foreground service
 * kept alive: the gateway reads the disconnect as a call drop and fans out
 * call.hangup{failed} to the peer. The guard is centralised in
 * callResumeGuard.ts so both forceReconnect sites — and this test — share
 * one source of truth. The registries are `import type`-only modules, so
 * this exercises the REAL hasLiveCall against the REAL registries.
 */

import {hasLiveCall, decideResumeAction} from '../runtime/callResumeGuard';
import {setActiveCall} from '../runtime/callRegistry';
import {setActiveGroupCall} from '../runtime/groupCallRegistry';
import type {ActiveCallSeed} from '../runtime/callRegistry';
import type {ActiveGroupCallSeed} from '../runtime/groupCallRegistry';
import type {CallState} from '../webrtc/types';
import type {GroupCallState} from '../webrtc/useGroupCall';

function oneToOne(state: CallState): ActiveCallSeed {
  return {
    callId: 'c1', conversationId: 'conv1',
    peer: {userId: 'bob', deviceId: 1}, peerName: 'Bob',
    kind: 'voice', direction: 'outgoing',
    controller: null, signalling: null, unregister: null,
    localStream: null, remoteStream: null, audioTrack: null, videoTrack: null,
    state, isMinimized: false, keepAlive: false, connectedAtMs: null,
  };
}
function group(state: GroupCallState): ActiveGroupCallSeed {
  return {
    roomId: 'r1', conversationId: 'conv2', conversationName: 'Team',
    callType: 'voice', isHost: false, selfTag: null, state,
    localStream: null, remoteTiles: [], identityByTag: {}, audioLevels: {},
    audioTrack: null, videoTrack: null, isMuted: false, isVideoOff: false,
    isMinimized: false, keepAlive: false, leave: null, toggleMute: null,
    toggleVideo: null, joinedAtMs: null,
  };
}

afterEach(() => { setActiveCall(null); setActiveGroupCall(null); });

describe('P1-BR-4 — hasLiveCall (live-call guard for the resume/watchdog)', () => {
  it('false when there is no call', () => {
    expect(hasLiveCall()).toBe(false);
  });

  it('true for a non-terminal 1:1 call (connected / connecting / reconnecting)', () => {
    for (const st of ['calling', 'connecting', 'connected', 'reconnecting'] as CallState[]) {
      setActiveCall(oneToOne(st));
      expect(hasLiveCall()).toBe(true);
    }
  });

  it('false once the 1:1 call is terminal (ended / failed)', () => {
    setActiveCall(oneToOne('ended'));
    expect(hasLiveCall()).toBe(false);
    setActiveCall(oneToOne('failed'));
    expect(hasLiveCall()).toBe(false);
  });

  it('true for a live group call (creating / joining / joined / reconnecting)', () => {
    for (const st of ['creating', 'joining', 'joined', 'reconnecting'] as GroupCallState[]) {
      setActiveGroupCall(group(st));
      expect(hasLiveCall()).toBe(true);
    }
  });

  it('false for a terminal group call (left / failed / kicked / ended-by-host)', () => {
    for (const st of ['left', 'failed', 'kicked', 'ended-by-host', 'unavailable', 'idle'] as GroupCallState[]) {
      setActiveGroupCall(group(st));
      expect(hasLiveCall()).toBe(false);
    }
  });
});

describe('P1-BR-4 — decideResumeAction', () => {
  it('drains when the pong is fresh (socket genuinely live)', () => {
    expect(decideResumeAction(true, false)).toBe('drain');
    expect(decideResumeAction(true, true)).toBe('drain');
  });

  it('PROBES (never tears down) when the pong is stale but a call is live', () => {
    expect(decideResumeAction(false, true)).toBe('probe');
  });

  it('reconnects when the pong is stale and no call is live', () => {
    expect(decideResumeAction(false, false)).toBe('reconnect');
  });
});
