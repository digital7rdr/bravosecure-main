/**
 * M-06 / M-07 / F7 — gateway privacy-enforcement tests.
 *
 * Like the B-05 ping spec, handlers are invoked off the prototype with a
 * hand-built `this` so we don't have to stand up the full gateway DI graph
 * (Redis, SFU, push, …). Covers:
 *  - typing frames are dropped silently when the pair is blocked (M-07)
 *  - read receipts are dropped silently when the pair is blocked (M-07)
 *  - read receipts are emitted DURABLY (not volatile) to a live socket (F7)
 *  - read receipts are queued when the target device has no socket or the
 *    emit path throws (F7)
 *  - presence.subscribe: blocked subjects are not watched and snapshot as
 *    plain offline; last_seen_visible=false strips lastSeenMs (M-06/M-07)
 */
import type {Socket} from 'socket.io';
import {MessengerGateway} from './messenger.gateway';

const ME = 'me-user';
const PEER = 'peer-user';
const TO = {userId: PEER, deviceId: 1};

function fakeClient() {
  return {
    data: {claims: {sub: ME}, signalDeviceId: 7, sessionId: 's-1'},
    emit: jest.fn(),
    join: jest.fn(async () => undefined),
  } as unknown as Socket & {emit: jest.Mock; join: jest.Mock};
}

function fakePrivacy(opts: {blocked?: boolean; lastSeenVisible?: boolean} = {}) {
  return {
    isBlockedEither:   jest.fn(async () => opts.blocked ?? false),
    isLastSeenVisible: jest.fn(async () => opts.lastSeenVisible ?? true),
  };
}

function fakeHub(online: boolean) {
  const emit = jest.fn();
  const volatileEmit = jest.fn();
  return {
    emit,
    volatileEmit,
    hub: {
      deviceRoom: (a: {userId: string; deviceId: number}) => `u:${a.userId}:${a.deviceId}`,
      deviceIsOnline: jest.fn(async () => online),
      server: {to: () => ({emit, volatile: {emit: volatileEmit}})},
    },
  };
}

describe('M-07 — typing block enforcement', () => {
  const handleTyping = MessengerGateway.prototype['handleTyping'];

  function typingThis(blocked: boolean, online = true) {
    const {hub, emit, volatileEmit} = fakeHub(online);
    return {
      self: {
        rateGate: () => null,
        privacy:  fakePrivacy({blocked}),
        hub,
        typingTimers: new Map<string, ReturnType<typeof setTimeout>>(),
      },
      emit, volatileEmit,
    };
  }

  afterEach(() => jest.clearAllTimers());

  it('drops the frame silently (no emit, no error) when blocked', async () => {
    const {self, emit, volatileEmit} = typingThis(true);
    const ret = await handleTyping.call(self, {to: TO, state: 'start'}, fakeClient());
    expect(ret).toBeUndefined();                 // silent — no block oracle
    expect(volatileEmit).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(self.typingTimers.size).toBe(0);      // no auto-stop timer armed
    expect(self.privacy.isBlockedEither).toHaveBeenCalledWith(ME, PEER);
  });

  it('still forwards (volatile) when not blocked', async () => {
    const {self, volatileEmit} = typingThis(false);
    await handleTyping.call(self, {to: TO, state: 'stop'}, fakeClient());
    expect(volatileEmit).toHaveBeenCalledWith('typing', {
      from: {userId: ME, deviceId: 7}, state: 'stop',
    });
  });
});

describe('M-07 + F7 — read-receipt block + durable forward', () => {
  const handleReadReceipt = MessengerGateway.prototype['handleReadReceipt'];

  function receiptThis(opts: {blocked?: boolean; online?: boolean; probeThrows?: boolean}) {
    const {hub, emit, volatileEmit} = fakeHub(opts.online ?? true);
    if (opts.probeThrows) {
      (hub.deviceIsOnline as jest.Mock).mockRejectedValue(new Error('adapter down'));
    }
    const envelopes = {queueReadReceipt: jest.fn(async () => undefined)};
    return {
      self: {rateGate: () => null, privacy: fakePrivacy(opts), hub, envelopes},
      emit, volatileEmit, envelopes,
    };
  }

  const payload = {to: TO, envelopeIds: ['e-1', 'e-2']};
  const expectedFrame = {from: {userId: ME, deviceId: 7}, envelopeIds: ['e-1', 'e-2']};

  it('drops silently when blocked — no emit, no queue', async () => {
    const {self, emit, envelopes} = receiptThis({blocked: true});
    const ret = await handleReadReceipt.call(self, payload, fakeClient());
    expect(ret).toBeUndefined();
    expect(emit).not.toHaveBeenCalled();
    expect(envelopes.queueReadReceipt).not.toHaveBeenCalled();
  });

  it('emits DURABLY (never volatile) AND enqueues when the target socket is live (P2-BR-11)', async () => {
    const {self, emit, volatileEmit, envelopes} = receiptThis({online: true});
    await handleReadReceipt.call(self, payload, fakeClient());
    expect(emit).toHaveBeenCalledWith('read-receipt', expectedFrame);
    expect(volatileEmit).not.toHaveBeenCalled();  // F7 — volatile path removed
    // P2-BR-11 — a ≤55s zombie socket counts as "online" but never receives
    // the emit; the receipt must ALWAYS land in the durable queue too (the
    // drain is idempotent by (envelopeId, reader) on the client).
    expect(envelopes.queueReadReceipt).toHaveBeenCalledWith(TO, expectedFrame);
  });

  it('queues on the offline-receipt machinery when no socket is live', async () => {
    const {self, emit, envelopes} = receiptThis({online: false});
    const ret = await handleReadReceipt.call(self, payload, fakeClient());
    expect(ret).toBeUndefined();                  // no peer_offline error
    expect(emit).not.toHaveBeenCalled();
    expect(envelopes.queueReadReceipt).toHaveBeenCalledWith(TO, expectedFrame);
  });

  it('queues as fallback when the emit path throws', async () => {
    const {self, envelopes} = receiptThis({probeThrows: true});
    await handleReadReceipt.call(self, payload, fakeClient());
    expect(envelopes.queueReadReceipt).toHaveBeenCalledWith(TO, expectedFrame);
  });
});

describe('M-06 + M-07 — presence.subscribe snapshot', () => {
  const handleSubscribe = MessengerGateway.prototype['handlePresenceSubscribe'];

  function subscribeThis(opts: {
    blocked?: (uid: string) => boolean;
    visible?: (uid: string) => boolean;
  }) {
    return {
      rateGate: () => null,
      privacy: {
        isBlockedEither:   jest.fn(async (_me: string, uid: string) => opts.blocked?.(uid) ?? false),
        isLastSeenVisible: jest.fn(async (uid: string) => opts.visible?.(uid) ?? true),
      },
      presence: {
        watchRoom: (uid: string) => `watch:${uid}`,
        getMany: jest.fn(async (ids: string[]) =>
          Object.fromEntries(ids.map(id => [id, {state: 'online', lastSeenMs: 12345}]))),
      },
    };
  }

  it('sends lastSeenMs for visible subjects and joins their watch rooms', async () => {
    const self = subscribeThis({});
    const client = fakeClient();
    await handleSubscribe.call(self, {userIds: [PEER]}, client);
    expect(client.join).toHaveBeenCalledWith(['watch:' + PEER]);
    expect(client.emit).toHaveBeenCalledWith('presence',
      {userId: PEER, state: 'online', lastSeenMs: 12345});
  });

  it('M-06: strips lastSeenMs when the subject hides last seen (state kept)', async () => {
    const self = subscribeThis({visible: () => false});
    const client = fakeClient();
    await handleSubscribe.call(self, {userIds: [PEER]}, client);
    const [, data] = client.emit.mock.calls[0];
    expect(data).toEqual({userId: PEER, state: 'online'});
    expect('lastSeenMs' in data).toBe(false);
  });

  it('M-07: blocked subject → plain offline, no lastSeenMs, no watch room', async () => {
    const self = subscribeThis({blocked: uid => uid === PEER});
    const client = fakeClient();
    await handleSubscribe.call(self, {userIds: [PEER]}, client);
    expect(client.join).not.toHaveBeenCalled();       // never watches the room
    const [, data] = client.emit.mock.calls[0];
    expect(data).toEqual({userId: PEER, state: 'offline'});
    expect(self.presence.getMany).toHaveBeenCalledWith([]); // real state never read
  });

  it('M-07: mixed list — blocked entries masked, others untouched', async () => {
    const other = 'friendly-user';
    const self = subscribeThis({blocked: uid => uid === PEER});
    const client = fakeClient();
    await handleSubscribe.call(self, {userIds: [PEER, other]}, client);
    expect(client.join).toHaveBeenCalledWith(['watch:' + other]);
    const frames = client.emit.mock.calls.map(c => c[1]);
    expect(frames).toContainEqual({userId: PEER, state: 'offline'});
    expect(frames).toContainEqual({userId: other, state: 'online', lastSeenMs: 12345});
  });
});
