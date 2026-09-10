/**
 * NA-01 — the WS `call.offer` and the FCM voip-wake seed the SAME callId while
 * the app is backgrounded, and the wake carries no SDP / caller deviceId /
 * conversationId. The setter used to replace, so the wake erased everything the
 * offer had delivered and the Answer tap hydrated an empty payload ("Answering…"
 * stall, decline routed to device 1, call log in a synthetic thread).
 *
 * Covers the merge-preserving setter and fcmBootstrap.resolveIncomingCallRoute,
 * which reads the same three fields back before navigating.
 */

const mockStore = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem:    async (k: string) => mockStore.get(k) ?? null,
    setItem:    async (k: string, v: string) => { mockStore.set(k, v); },
    removeItem: async (k: string) => { mockStore.delete(k); },
  },
}));
jest.mock('react-native', () => ({
  Platform: {OS: 'android'},
  PermissionsAndroid: {request: jest.fn(), PERMISSIONS: {}, RESULTS: {}},
  NativeModules: {},
}));
jest.mock('@react-native-firebase/messaging', () => ({
  __esModule: true,
  default: () => ({
    setBackgroundMessageHandler: jest.fn(),
    getToken: jest.fn(async () => 'tok'),
    onTokenRefresh: jest.fn(() => () => {}),
    onMessage: jest.fn(() => () => {}),
    requestPermission: jest.fn(async () => 1),
  }),
}));
jest.mock('@utils/constants', () => ({MSG_BASE_URL: 'http://test.local'}));
jest.mock('../push/callNotification', () => ({
  dismissCallNotif: jest.fn(async () => {}),
}));
jest.mock('@/modules/messenger/runtime/transportRegistry', () => ({
  getLiveTransport: () => null,
}));

import * as cache from '../push/incomingCallCache';
import {resolveIncomingCallRoute} from '../push/fcmBootstrap';

const OFFER = {
  callId:         'c1',
  callerName:     'Alice',
  kind:           'video',
  fromUserId:     'alice',
  remoteDeviceId: 7,
  incomingSdp:    'v=0 offer',
  conversationId: 'convo-uuid',
};
const WAKE = {callId: 'c1', callerName: 'Bravo contact', kind: 'voice', fromUserId: 'alice'};

beforeEach(() => {
  cache._resetIncomingCallCacheForTests();
});

describe('NA-01 — incomingCallCache merge-preserve', () => {
  it('keeps the offer SDP / deviceId / conversationId when the wake lands second', () => {
    expect(cache.setIncomingCallPayload(OFFER)).toBe(true);
    expect(cache.setIncomingCallPayload(WAKE)).toBe(true);

    const entry = cache.getIncomingCallPayload('c1');
    expect(entry).not.toBeNull();
    expect(entry!.incomingSdp).toBe('v=0 offer');
    expect(entry!.remoteDeviceId).toBe(7);
    expect(entry!.conversationId).toBe('convo-uuid');
    // The unsigned wake must not downgrade the authoritative label/kind.
    expect(entry!.callerName).toBe('Alice');
    expect(entry!.kind).toBe('video');
  });

  it('lets the offer fill in everything when it lands second (wake-then-WS)', () => {
    cache.setIncomingCallPayload(WAKE);
    cache.setIncomingCallPayload(OFFER);

    const entry = cache.getIncomingCallPayload('c1')!;
    expect(entry.incomingSdp).toBe('v=0 offer');
    expect(entry.remoteDeviceId).toBe(7);
    expect(entry.conversationId).toBe('convo-uuid');
    expect(entry.callerName).toBe('Alice');
    expect(entry.kind).toBe('video');
  });

  it('preserves group room fields across a later partial set', () => {
    cache.setIncomingCallPayload({
      callId: 'g1', callerName: 'Host', kind: 'group-video',
      roomId: 'g1', roomToken: 'tok', conversationId: 'gconvo',
    });
    cache.setIncomingCallPayload({callId: 'g1', callerName: 'x', kind: 'group-video'});

    const entry = cache.getIncomingCallPayload('g1')!;
    expect(entry.roomId).toBe('g1');
    expect(entry.roomToken).toBe('tok');
    expect(entry.conversationId).toBe('gconvo');
  });

  it('never resurrects a tombstoned slot (merge happens AFTER the guard)', () => {
    cache.setIncomingCallPayload({...OFFER, callId: 'c2'});
    cache.clearIncomingCallPayload('c2');

    expect(cache.setIncomingCallPayload({...OFFER, callId: 'c2'})).toBe(false);
    expect(cache.getIncomingCallPayload('c2')).toBeNull();
  });

  it('leaves a first write exactly as given (no phantom fields)', () => {
    cache.setIncomingCallPayload({callId: 'c3', callerName: 'Solo', kind: 'voice'});
    const entry = cache.getIncomingCallPayload('c3')!;
    expect(entry).toMatchObject({callId: 'c3', callerName: 'Solo', kind: 'voice'});
    expect(entry.incomingSdp).toBeUndefined();
    expect(entry.remoteDeviceId).toBeUndefined();
    expect(entry.conversationId).toBeUndefined();
  });

  it('does not make merged entries immortal (the shared payload TTL still applies)', () => {
    // WI-4.8 — the TTL moved to callDeadlines (INCOMING_PAYLOAD_TTL_MS) and
    // was raised so a last-second answer on a cold navigator still hydrates.
    // Immortality is still a bug: an un-answered merged entry must expire.
    const {INCOMING_PAYLOAD_TTL_MS} = require('../webrtc/callDeadlines') as typeof import('../webrtc/callDeadlines');
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      cache.setIncomingCallPayload(OFFER);
      cache.setIncomingCallPayload(WAKE);
      nowSpy.mockReturnValue(1_000_000 + INCOMING_PAYLOAD_TTL_MS + 1_000);
      expect(cache.getIncomingCallPayload('c1')).toBeNull();
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe('NA-01 — resolveIncomingCallRoute', () => {
  it('hydrates SDP / deviceId / conversationId from the WS-seeded cache', () => {
    cache.setIncomingCallPayload(OFFER);
    expect(resolveIncomingCallRoute('c1', {fromUserId: 'alice'})).toEqual({
      conversationId: 'convo-uuid',
      remoteDeviceId: 7,
      incomingSdp:    'v=0 offer',
    });
  });

  it('falls back to today\'s defaults with an empty cache', () => {
    expect(resolveIncomingCallRoute('c1', {fromUserId: 'alice'})).toEqual({
      conversationId: 'direct:alice',
      remoteDeviceId: 1,
      incomingSdp:    undefined,
    });
  });

  it('prefers the notification data when it carries the fields', () => {
    cache.setIncomingCallPayload(OFFER);
    expect(resolveIncomingCallRoute('c1', {
      fromUserId:     'alice',
      remoteDeviceId: '3',
      conversationId: 'from-notif',
      incomingSdp:    'v=0 notif',
    })).toEqual({
      conversationId: 'from-notif',
      remoteDeviceId: 3,
      incomingSdp:    'v=0 notif',
    });
  });

  it('never returns NaN for a garbage remoteDeviceId', () => {
    expect(resolveIncomingCallRoute('nope', {fromUserId: 'alice', remoteDeviceId: 'abc'}).remoteDeviceId).toBe(1);
  });
});
