/**
 * CALL-17 — launchCall 1:1 double-tap / concurrent-dial guard.
 *
 * launchCall mints a fresh callId per invocation, so before the latch a
 * fast double-tap on the dial button navigated twice with TWO callIds —
 * the peer rang twice and the two controllers fought over media. These
 * tests exercise the REAL launchCall entry (not a mirrored predicate):
 * second tap blocked, registry hand-off, release on call end, and the
 * watchdog release for aborted boots.
 */

const mockNavigate = jest.fn();
const mockAlert    = jest.fn();

// B-88 — launchCall now alerts through the branded shim, not RN's Alert.
jest.mock('@utils/alert', () => ({Alert: {alert: (...a: unknown[]) => mockAlert(...a)}}));
jest.mock('../store/messengerStore', () => ({
  useMessengerStore: {
    getState: () => ({
      conversations: {
        'convo-1': {id: 'convo-1', type: 'direct', peer: {userId: 'bob'}, participants: ['me', 'bob']},
      },
    }),
  },
}));
jest.mock('@store/authStore', () => ({
  useAuthStore: {getState: () => ({user: {id: 'me', role: 'individual'}})},
}), {virtual: true});
jest.mock('@utils/constants', () => ({MSG_BASE_URL: 'http://test.invalid'}), {virtual: true});
jest.mock('../runtime/groupCallRegistry', () => ({
  getActiveGroupCall: () => null,
  setActiveGroupCall: jest.fn(),
}));
jest.mock('../webrtc/groupCallIdentityRegistry', () => ({clearRoomIdentities: jest.fn()}));

import {launchCall, releaseOneToOneLaunchLatch, isOneToOneLaunchBlocked} from '../webrtc/launchCall';
import {setActiveCall, type ActiveCallSeed} from '../runtime/callRegistry';

const nav = {navigate: (...a: unknown[]) => mockNavigate(...a)};

function fakeActiveCall(callId: string): ActiveCallSeed {
  return {
    callId,
    conversationId: 'convo-1',
    peer: {userId: 'bob', deviceId: 1},
    peerName: 'Bob',
    kind: 'voice',
    direction: 'outgoing',
    controller: null,
    signalling: null,
    unregister: null,
    localStream: null,
    remoteStream: null,
    audioTrack: null,
    videoTrack: null,
    state: 'calling',
    isMinimized: false,
    keepAlive: false,
    connectedAtMs: null,
  };
}

describe('CALL-17 — launchCall 1:1 double-tap latch', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockAlert.mockClear();
    setActiveCall(null);
    releaseOneToOneLaunchLatch();
  });
  afterEach(() => {
    setActiveCall(null);
    releaseOneToOneLaunchLatch();
  });

  it('a double-tap navigates ONCE — the second tap is rejected with a visible reason', () => {
    launchCall(nav, {conversationId: 'convo-1', callType: 'voice'});
    launchCall(nav, {conversationId: 'convo-1', callType: 'voice'});

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    const [screen, params] = mockNavigate.mock.calls[0] as [string, Record<string, unknown>];
    expect(screen).toBe('CallScreen');
    expect(params.remoteUserId).toBe('bob');
    expect(typeof params.callId).toBe('string');
    expect(mockAlert).toHaveBeenCalledWith('Call in progress', expect.any(String));
  });

  it('rejects when a live/pending call already exists in the callRegistry (no latch involved)', () => {
    setActiveCall(fakeActiveCall('call-live'));
    launchCall(nav, {conversationId: 'convo-1', callType: 'voice'});
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockAlert).toHaveBeenCalledWith('Call in progress', expect.any(String));
  });

  it('registry registration hands blocking over to the registry; clearing the slot re-enables dialing', () => {
    launchCall(nav, {conversationId: 'convo-1', callType: 'voice'});
    expect(mockNavigate).toHaveBeenCalledTimes(1);

    // useCall boot registers the call → latch released, registry blocks.
    setActiveCall(fakeActiveCall('call-1'));
    expect(isOneToOneLaunchBlocked()).toBe(true);
    launchCall(nav, {conversationId: 'convo-1', callType: 'voice'});
    expect(mockNavigate).toHaveBeenCalledTimes(1);

    // Call ends → slot cleared → dialing works again with a NEW callId.
    setActiveCall(null);
    expect(isOneToOneLaunchBlocked()).toBe(false);
    launchCall(nav, {conversationId: 'convo-1', callType: 'voice'});
    expect(mockNavigate).toHaveBeenCalledTimes(2);
    const id1 = (mockNavigate.mock.calls[0][1] as {callId: string}).callId;
    const id2 = (mockNavigate.mock.calls[1][1] as {callId: string}).callId;
    expect(id1).not.toBe(id2);
  });

  it('watchdog releases an aborted boot (call never registered) so future dials are not wedged', () => {
    jest.useFakeTimers();
    try {
      launchCall(nav, {conversationId: 'convo-1', callType: 'voice'});
      expect(isOneToOneLaunchBlocked()).toBe(true);

      // Boot never registers (permission denied / instant back).
      jest.advanceTimersByTime(10_000);
      expect(isOneToOneLaunchBlocked()).toBe(false);

      launchCall(nav, {conversationId: 'convo-1', callType: 'voice'});
      expect(mockNavigate).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('an unresolvable peer does NOT arm the latch (nothing will ever register)', () => {
    launchCall(nav, {conversationId: 'unknown-convo', callType: 'voice'});
    // Navigates (CallScreen owns the error surface for a missing peer)…
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    // …but a retry is not blocked.
    expect(isOneToOneLaunchBlocked()).toBe(false);
  });
});
