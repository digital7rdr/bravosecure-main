/**
 * SYNC-6 (B-121 / NA-GATE-7) — typing-indicator conversation scope.
 *
 * The gateway accepts an OPAQUE 16-lowercase-hex `convTag` on the typing
 * frame and forwards it VERBATIM to the recipient:
 *  - never parsed beyond shape validation, never stored, never in Redis,
 *    never logged (the raw conversationId on the frame stays FORBIDDEN);
 *  - a malformed tag is dropped — the forwarded frame is exactly the
 *    legacy `{from, state}` (back-compat proof for old receivers);
 *  - the auto-stop timer is keyed per-tag so typing in a group and in the
 *    1:1 with the same peer arms two independent timers;
 *  - the M-07 blocked-pair silent-drop stays ahead of the pass-through.
 *
 * Harness copied from messenger.gateway.privacy.spec.ts (prototype
 * invocation with a hand-built `this`). The tagless back-compat frame is
 * ALSO asserted there (privacy spec :79-85) and must stay untouched.
 */
import type {Socket} from 'socket.io';
import {MessengerGateway} from './messenger.gateway';

const ME = 'me-user';
const PEER = 'peer-user';
const TO = {userId: PEER, deviceId: 1};
const TAG = 'a1b2c3d4e5f60718';

function fakeClient() {
  return {
    data: {claims: {sub: ME}, signalDeviceId: 7, sessionId: 's-1'},
    emit: jest.fn(),
    join: jest.fn(async () => undefined),
  } as unknown as Socket & {emit: jest.Mock; join: jest.Mock};
}

function fakeHub() {
  const emit = jest.fn();
  const volatileEmit = jest.fn();
  return {
    emit,
    volatileEmit,
    hub: {
      deviceRoom: (a: {userId: string; deviceId: number}) => `u:${a.userId}:${a.deviceId}`,
      server: {to: () => ({emit, volatile: {emit: volatileEmit}})},
    },
  };
}

const handleTyping = MessengerGateway.prototype['handleTyping'];

function typingThis(blocked = false) {
  const {hub, emit, volatileEmit} = fakeHub();
  const redis = {
    client: {
      set: jest.fn(), get: jest.fn(), del: jest.fn(),
      sadd: jest.fn(), srem: jest.fn(), expire: jest.fn(),
    },
  };
  const logger = {log: jest.fn(), warn: jest.fn(), error: jest.fn()};
  const self = {
    rateGate: () => null,
    privacy:  {isBlockedEither: jest.fn(async () => blocked)},
    hub,
    redis,
    logger,
    typingTimers: new Map<string, ReturnType<typeof setTimeout>>(),
  };
  return {self, emit, volatileEmit, redis, logger};
}

afterEach(() => jest.clearAllTimers());

describe('SYNC-6 — convTag passthrough', () => {
  it('a valid 16-hex tag is forwarded VERBATIM on the volatile frame', async () => {
    const {self, volatileEmit} = typingThis();
    const ret = await handleTyping.call(self, {to: TO, state: 'start', convTag: TAG}, fakeClient());
    expect(ret).toBeUndefined();
    expect(volatileEmit).toHaveBeenCalledWith('typing', {
      from: {userId: ME, deviceId: 7}, state: 'start', convTag: TAG,
    });
  });

  it.each(['NOT-HEX', 'a1b2', 123, 'A1B2C3D4E5F60718', 'a1b2c3d4e5f607181', null, {}] as unknown[])(
    'malformed tag %p is dropped — forwarded frame is exactly {from, state}',
    async bad => {
      const {self, volatileEmit} = typingThis();
      await handleTyping.call(self, {to: TO, state: 'start', convTag: bad as never}, fakeClient());
      expect(volatileEmit).toHaveBeenCalledTimes(1);
      const [, data] = volatileEmit.mock.calls[0];
      expect(data).toEqual({from: {userId: ME, deviceId: 7}, state: 'start'});
      expect('convTag' in data).toBe(false);
    },
  );

  it('a tagless frame forwards exactly {from, state} (legacy sender back-compat)', async () => {
    const {self, volatileEmit} = typingThis();
    await handleTyping.call(self, {to: TO, state: 'stop'}, fakeClient());
    const [, data] = volatileEmit.mock.calls[0];
    expect(data).toEqual({from: {userId: ME, deviceId: 7}, state: 'stop'});
    expect('convTag' in data).toBe(false);
  });
});

describe('SYNC-6 — auto-stop timer carries the tag', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('the 6s auto-stop re-emits with the SAME tag', async () => {
    const {self, volatileEmit} = typingThis();
    await handleTyping.call(self, {to: TO, state: 'start', convTag: TAG}, fakeClient());
    volatileEmit.mockClear();

    jest.advanceTimersByTime(6_000);

    expect(volatileEmit).toHaveBeenCalledWith('typing', {
      from: {userId: ME, deviceId: 7}, state: 'stop', convTag: TAG,
    });
    expect(self.typingTimers.size).toBe(0);
  });

  it('two starts to the same peer with DIFFERENT tags arm two independent timers', async () => {
    const {self} = typingThis();
    await handleTyping.call(self, {to: TO, state: 'start', convTag: TAG}, fakeClient());
    await handleTyping.call(self, {to: TO, state: 'start', convTag: '0123456789abcdef'}, fakeClient());
    expect(self.typingTimers.size).toBe(2);
  });

  it('a tagged stop clears only its own timer slot', async () => {
    const {self} = typingThis();
    await handleTyping.call(self, {to: TO, state: 'start', convTag: TAG}, fakeClient());
    await handleTyping.call(self, {to: TO, state: 'start', convTag: '0123456789abcdef'}, fakeClient());
    await handleTyping.call(self, {to: TO, state: 'stop', convTag: TAG}, fakeClient());
    expect(self.typingTimers.size).toBe(1);
  });
});

describe('SYNC-6 — invariants: block gate, no storage, no logging', () => {
  it('a blocked pair still silent-drops even with a tag (M-07), no timer armed', async () => {
    const {self, emit, volatileEmit} = typingThis(true);
    const ret = await handleTyping.call(self, {to: TO, state: 'start', convTag: TAG}, fakeClient());
    expect(ret).toBeUndefined();
    expect(volatileEmit).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(self.typingTimers.size).toBe(0);
  });

  it('the tag never reaches Redis and never reaches a log line', async () => {
    const {self, redis, logger} = typingThis();
    const consoleSpies = (['log', 'warn', 'error'] as const).map(m =>
      jest.spyOn(console, m).mockImplementation(() => {}),
    );
    try {
      await handleTyping.call(self, {to: TO, state: 'start', convTag: TAG}, fakeClient());

      for (const fn of Object.values(redis.client)) {
        expect(fn).not.toHaveBeenCalled();
      }
      const logged = [
        ...Object.values(logger).flatMap(fn => (fn as jest.Mock).mock.calls.flat()),
        ...consoleSpies.flatMap(s => s.mock.calls.flat()),
      ];
      expect(logged.some(arg => typeof arg === 'string' && arg.includes(TAG))).toBe(false);
    } finally {
      consoleSpies.forEach(s => s.mockRestore());
    }
  });
});
