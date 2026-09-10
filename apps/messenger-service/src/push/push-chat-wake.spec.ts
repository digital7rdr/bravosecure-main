/**
 * P2-14 / P2-BR-4 (background-reliability audit 2026-07-10) — chat-wake
 * debounce correctness + FCM TTL parity with the relay dwell.
 *
 * firebase-admin is module-mocked here (unlike push.service.spec.ts, which
 * exercises the credential-less stub paths) so the tests can drive the REAL
 * send branch: assert the FCM message shape (ttl) and simulate send failures.
 *
 * Contracts under test:
 *   1. P2-BR-4 — the chat wake ships with ttl = 28 days (FCM max), not 24 h,
 *      so a device offline >24 h still gets woken within the 30-day dwell.
 *   2. P2-14(a) — a leading wake whose FCM send FAILS must not arm the 6 s
 *      debounce (previously a failed send blacked out every retry in-window).
 *   3. P2-14(b) — messages arriving INSIDE the debounce window schedule
 *      exactly ONE trailing wake at window end (previously they produced
 *      zero notification on the killed-app banner-only path).
 *   4. P1-15 note — the N-02 call-cancel push TTL is 300 s, not 60 s.
 */

jest.mock('firebase-admin', () => ({
  apps: [],
  credential: {cert: jest.fn()},
  initializeApp: jest.fn(),
  messaging: jest.fn(),
}));

import {Test} from '@nestjs/testing';
import {ConfigModule} from '@nestjs/config';
import RedisMock from 'ioredis-mock';
import * as admin from 'firebase-admin';
import {RedisService} from '../redis/redis.service';
import {PushService, voipSign} from './push.service';
import configuration from '../config/configuration';

async function setup(mock: InstanceType<typeof RedisMock>): Promise<PushService> {
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({isGlobal: true, load: [configuration]})],
    providers: [
      RedisService,
      PushService,
      {provide: 'IORedisClient', useValue: mock},
    ],
  }).compile();

  const redis = moduleRef.get(RedisService);
  Object.defineProperty(redis, 'client', {value: mock, configurable: true});
  // Construct directly (no onModuleInit) — no FCM init / GC timer side effects.
  return new PushService(redis);
}

type MulticastArg = {
  tokens: string[];
  data: Record<string, string>;
  android: {priority: string; collapseKey: string; ttl: number};
  apns?: {headers: Record<string, string>; payload: {aps: Record<string, unknown>}};
};

describe('PushService — P2-14 chat-wake debounce + P2-BR-4 wake TTL', () => {
  let mock: InstanceType<typeof RedisMock>;
  let push: PushService;
  let sendEachForMulticast: jest.Mock;

  beforeEach(async () => {
    mock = new RedisMock();
    push = await setup(mock);
    sendEachForMulticast = jest.fn();
    (admin.messaging as unknown as jest.Mock).mockReturnValue({
      sendEachForMulticast,
      sendEach: jest.fn(),
    });
    (push as unknown as {fcmReady: boolean}).fcmReady = true;
    await push.registerDeviceToken({
      userId: 'u1', deviceId: 'd1', platform: 'android', token: 'tok-1', updatedAt: Date.now(),
    });
  });

  afterEach(async () => {
    push.onModuleDestroy(); // clears any pending trailing chat-wake timers
    jest.useRealTimers();
    await mock.flushall();
    await mock.quit();
  });

  it('P2-BR-4 — chat wake ships with the 28-day FCM ttl (relay-dwell parity, was 24h)', async () => {
    sendEachForMulticast.mockResolvedValue({successCount: 1, responses: [{success: true}]});

    const r = await push.sendChatWake('u1', {senderUserId: 'sender-a'});
    expect(r.sent).toBe(1);

    expect(sendEachForMulticast).toHaveBeenCalledTimes(1);
    const arg = sendEachForMulticast.mock.calls[0][0] as MulticastArg;
    expect(arg.android.ttl).toBe(2_419_200 * 1000); // FCM max = 28 days
    expect(arg.android.priority).toBe('high');
    // PERMANENT RULE sanity — wake hint only, never content. `sentAtMs` is
    // display-only send-time metadata the relay already holds (accept time);
    // the client stamps it on the banner so a Doze-delayed notification reads
    // the time the message was SENT, not drawn (B-323).
    expect(Object.keys(arg.data).sort()).toEqual(['conversationId', 'kind', 'senderUserId', 'sentAtMs']);
  });

  it('B-323 — the wake carries a numeric-string sentAtMs close to now', async () => {
    sendEachForMulticast.mockResolvedValue({successCount: 1, responses: [{success: true}]});

    const before = Date.now();
    await push.sendChatWake('u1', {senderUserId: 'sender-a'});
    const after = Date.now();

    const arg = sendEachForMulticast.mock.calls[0][0] as MulticastArg;
    expect(arg.data.sentAtMs).toMatch(/^\d+$/);
    const ts = Number(arg.data.sentAtMs);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('OR-3 — the iOS chat wake carries a VISIBLE alert (content-available alone never draws)', async () => {
    await push.registerDeviceToken({
      userId: 'u1', deviceId: 'd2', platform: 'ios', token: 'ios-tok-1', updatedAt: Date.now(),
    });
    sendEachForMulticast.mockResolvedValue({successCount: 1, responses: [{success: true}]});

    await push.sendChatWake('u1', {senderUserId: 'sender-a'});

    const iosCall = sendEachForMulticast.mock.calls
      .map(c => c[0] as MulticastArg)
      .find(a => a.tokens.includes('ios-tok-1'));
    expect(iosCall).toBeDefined();
    const aps = iosCall!.apns!.payload.aps;
    expect(aps['content-available']).toBe(1); // still wakes JS when resident
    expect(aps.alert).toEqual({title: 'Bravo Secure', body: 'New secure message'});
    expect(aps.sound).toBe('default');
    // PERMANENT RULE — every aps value is a CONSTANT: no sender, no
    // conversation, no content. thread-id included (the spec draft derived it
    // from conversationId/senderUserId — rejected, aps must stay opaque).
    expect(aps['thread-id']).toBe('msg-wake');
    expect(JSON.stringify(aps)).not.toContain('sender-a');
    // B-323 — sentAtMs is display-only send-time metadata, kept out of aps.
    expect(Object.keys(iosCall!.data).sort()).toEqual(['conversationId', 'kind', 'senderUserId', 'sentAtMs']);
  });

  // B-710 — `sendEachForMulticast` RESOLVES for per-token failures; it only
  // THROWS on a transport/auth error. The old guard keyed on the throw, so every
  // per-token rejection class left the window armed and coalesced the rest of the
  // burst behind a wake that reached nobody: one lost message became the whole
  // burst lost.
  it('B-710 — a zero-success multicast releases the debounce window', async () => {
    sendEachForMulticast.mockResolvedValue({
      successCount: 0,
      responses: [{success: false, error: {code: 'messaging/quota-exceeded'}}],
    });

    const r = await push.sendChatWake('u1', {senderUserId: 'sender-a'});
    expect(r.sent).toBe(0);
    // The window must NOT be left armed for a send that notified nobody.
    expect(await mock.get('push-chat-debounce:u1:sender-a')).toBeNull();

    // ...so the very next message gets a real leading wake rather than being
    // silently coalesced.
    sendEachForMulticast.mockResolvedValue({successCount: 1, responses: [{success: true}]});
    const r2 = await push.sendChatWake('u1', {senderUserId: 'sender-a'});
    expect(r2.sent).toBe(1);
  });

  it('B-710 — a fully successful send still ARMS the window (the coalescer must survive)', async () => {
    sendEachForMulticast.mockResolvedValue({successCount: 1, responses: [{success: true}]});
    await push.sendChatWake('u1', {senderUserId: 'sender-a'});
    expect(await mock.get('push-chat-debounce:u1:sender-a')).toBe('1');
  });

  // B-710 — the trailing wake used to stamp `Date.now()` at FIRE time, because
  // `sentAtMs` had been dropped from `scheduleTrailingChatWake`'s signature. That
  // is the only orderable field in the payload, so messages 2..N of a burst all
  // carried the same invented time, ~2 s after the fact.
  it('B-710 — the trailing wake carries a REAL send time, not its own fire time', async () => {
    // Same timer shape as the P2-14(b) case below: only setTimeout is faked, so
    // Date stays real and the async chain can be flushed with real immediates.
    jest.useFakeTimers({
      doNotFake: [
        'nextTick', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval',
        'queueMicrotask', 'Date', 'performance', 'hrtime',
      ],
    });
    sendEachForMulticast.mockResolvedValue({successCount: 1, responses: [{success: true}]});

    await push.sendChatWake('u1', {senderUserId: 'sender-a'}); // leading edge

    // A second message inside the window: debounced, and it schedules the trailing wake.
    const beforeSecond = Date.now();
    const r2 = await push.sendChatWake('u1', {senderUserId: 'sender-a'});
    const afterSecond = Date.now();
    expect(r2.sent).toBe(0);

    sendEachForMulticast.mockClear();
    await mock.del('push-chat-debounce:u1:sender-a'); // simulate the TTL expiring
    jest.advanceTimersByTime(6_000);
    for (let i = 0; i < 25; i++) {await new Promise(r => setImmediate(r));}

    expect(sendEachForMulticast).toHaveBeenCalledTimes(1);
    const trailingAt = Number((sendEachForMulticast.mock.calls[0][0] as MulticastArg).data.sentAtMs);
    // The SCHEDULING message's accept time — not the moment the timer fired,
    // which by now is at least 6 s later.
    expect(trailingAt).toBeGreaterThanOrEqual(beforeSecond);
    expect(trailingAt).toBeLessThanOrEqual(afterSecond);
  });

  it('P1-15 note — N-02 call-cancel push ttl raised from 60s to 300s', async () => {
    sendEachForMulticast.mockResolvedValue({successCount: 1, responses: [{success: true}]});

    const sent = await push.sendCallCancel('u1', 'call-1', 'from-1', 'voice', true);
    expect(sent).toBe(1);

    const arg = sendEachForMulticast.mock.calls[0][0] as MulticastArg;
    expect(arg.android.ttl).toBe(300 * 1000);
  });

  it('P2-14(a) — a FAILED leading FCM send does not arm the 6s debounce blackout', async () => {
    sendEachForMulticast.mockRejectedValueOnce(new Error('FCM 503'));

    const first = await push.sendChatWake('u1', {senderUserId: 'sender-a'});
    expect(first.sent).toBe(0);
    // The failed leading wake released its debounce window.
    expect(await mock.get('push-chat-debounce:u1:sender-a')).toBeNull();

    // An immediate retry is a fresh leading edge and actually delivers.
    sendEachForMulticast.mockResolvedValueOnce({successCount: 1, responses: [{success: true}]});
    const second = await push.sendChatWake('u1', {senderUserId: 'sender-a'});
    expect(second.sent).toBe(1);
    expect(sendEachForMulticast).toHaveBeenCalledTimes(2);
  });

  it('P2-14(a) — a SUCCESSFUL leading send keeps the debounce armed (burst still coalesced)', async () => {
    sendEachForMulticast.mockResolvedValue({successCount: 1, responses: [{success: true}]});

    await push.sendChatWake('u1', {senderUserId: 'sender-a'});
    expect(await mock.get('push-chat-debounce:u1:sender-a')).toBe('1');

    const second = await push.sendChatWake('u1', {senderUserId: 'sender-a'});
    expect(second).toEqual({sent: 0, stubbed: false});
    expect(sendEachForMulticast).toHaveBeenCalledTimes(1);
  });

  it('P2-14(b) — in-window messages schedule exactly ONE trailing wake that delivers at window end', async () => {
    jest.useFakeTimers({
      doNotFake: [
        'nextTick', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval',
        'queueMicrotask', 'Date', 'performance', 'hrtime',
      ],
    });
    sendEachForMulticast.mockResolvedValue({successCount: 1, responses: [{success: true}]});

    const first = await push.sendChatWake('u1', {senderUserId: 'sender-a'}); // leading edge
    expect(first.sent).toBe(1);

    const second = await push.sendChatWake('u1', {senderUserId: 'sender-a'}); // inside window
    expect(second).toEqual({sent: 0, stubbed: false});
    const third = await push.sendChatWake('u1', {senderUserId: 'sender-a'});  // inside window
    expect(third).toEqual({sent: 0, stubbed: false});

    // NX marker de-dupes: two in-window arrivals armed exactly one timer.
    const timers = (push as unknown as {trailingTimers: Set<unknown>}).trailingTimers;
    expect(timers.size).toBe(1);
    expect(await mock.get('push-chat-trailing:u1:sender-a')).toBe('1');

    // Window end: the leading debounce key would have expired by then. Date is
    // real in this test (fake timers only cover setTimeout), so simulate the
    // Redis TTL expiry manually.
    await mock.del('push-chat-debounce:u1:sender-a');

    jest.advanceTimersByTime(6_000);
    // Flush the async chain the fired timer kicked off (real immediates).
    for (let i = 0; i < 25; i++) await new Promise(r => setImmediate(r));

    // The trailing wake delivered a second real FCM send and cleaned up.
    expect(sendEachForMulticast).toHaveBeenCalledTimes(2);
    expect(timers.size).toBe(0);
  });

  it('P2-14(b) — no trailing wake is scheduled when the window saw no follow-up messages', async () => {
    sendEachForMulticast.mockResolvedValue({successCount: 1, responses: [{success: true}]});

    await push.sendChatWake('u1', {senderUserId: 'sender-a'});
    const timers = (push as unknown as {trailingTimers: Set<unknown>}).trailingTimers;
    expect(timers.size).toBe(0);
    expect(await mock.exists('push-chat-trailing:u1:sender-a')).toBe(0);
  });

  // ── B-715 — the trailing wake's own latency ────────────────────────────────
  // The trailing wake is the ONLY notification a killed-app recipient gets for
  // a message that landed inside a debounce window, so the delay chosen here is
  // that message's end-to-end notification latency. It used to be a flat
  // CHAT_DEBOUNCE_SEC measured from the SCHEDULING moment, which overshoots the
  // window end by however far into the window the message arrived — measured on
  // staging at up to 2087 ms of pure server-side hold (2026-08-31 06:49:54.395
  // accepted → 06:49:56.482 pushed, window ended 06:49:54.461).
  it('B-715 — the trailing wake is scheduled for the WINDOW END, not a full window later', async () => {
    sendEachForMulticast.mockResolvedValue({successCount: 1, responses: [{success: true}]});
    await push.sendChatWake('u1', {senderUserId: 'sender-a'}); // leading edge arms the window

    // Stand in for "1.8 s of the 2 s window has already elapsed". Date is real
    // in these tests, so drive the remaining TTL directly rather than sleeping.
    await mock.pexpire('push-chat-debounce:u1:sender-a', 200);

    const delays: number[] = [];
    const spy = jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      return {unref: () => undefined} as unknown as NodeJS.Timeout; // never fires
    }) as unknown as typeof global.setTimeout);
    try {
      const second = await push.sendChatWake('u1', {senderUserId: 'sender-a'}); // inside the window
      expect(second).toEqual({sent: 0, stubbed: false});
    } finally {
      spy.mockRestore();
    }

    expect(delays).toHaveLength(1);
    // The window remainder (~200 ms, minus the few ms of real time the PTTL read
    // costs) PLUS the 100 ms guard. The pre-fix value was a flat 2000: an order
    // of magnitude of avoidable notification delay.
    //
    // The lower bound pins TRAILING_WAKE_GUARD_MS specifically. An earlier cut of
    // this test asserted only `> 100 && <= 400`, which a guard-less
    // `delayMs = pttl` (~200) also satisfied — so the constant whose docblock
    // calls itself load-bearing had no test at all, and a revision that deleted
    // it stayed green. Deleting the guard now fails here.
    expect(delays[0]).toBeGreaterThan(250);
    expect(delays[0]).toBeLessThanOrEqual(320);
  });

  it('B-715 — an already-expired window schedules the trailing wake at the guard, not a full window later', async () => {
    sendEachForMulticast.mockResolvedValue({successCount: 1, responses: [{success: true}]});
    // Reached directly on purpose: with no debounce key the public path takes a
    // leading edge and never schedules a trailing wake, so the PTTL=-2 branch is
    // unreachable through `sendChatWake`. It IS reachable in production, as the
    // race where the window expires between the marker claim and the PTTL read.
    const delays: number[] = [];
    const spy = jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      return {unref: () => undefined} as unknown as NodeJS.Timeout; // never fires
    }) as unknown as typeof global.setTimeout);
    try {
      await (push as unknown as {
        scheduleTrailingChatWake: (u: string, o: {senderUserId: string}) => Promise<void>;
      }).scheduleTrailingChatWake('u1', {senderUserId: 'sender-a'});
    } finally {
      spy.mockRestore();
    }
    // Exactly the guard. Pins TRAILING_WAKE_GUARD_MS to its value, and pins that
    // a gone window does NOT fall through to the 2000 ms default — the same
    // cliff `pttl >= 0` (rather than `> 0`) removes at the sub-millisecond
    // boundary, where Redis clamps the remainder to 0.
    expect(delays).toEqual([100]);
  });

  it('B-715 — a PTTL of exactly 0 takes the remainder branch, not the 2 s fallback', async () => {
    sendEachForMulticast.mockResolvedValue({successCount: 1, responses: [{success: true}]});
    // Redis clamps a sub-millisecond remainder to 0, so this is the real boundary
    // case, not a synthetic one. Under `pttl > 0` it fell through to the full
    // 2000 ms default — a 2 s latency cliff at exactly the point this change
    // exists to remove. Driven through a stubbed reply because a sub-ms window
    // cannot be timed reliably from a test.
    const pttlSpy = jest.spyOn(mock, 'pttl').mockResolvedValue(0 as never);
    const delays: number[] = [];
    const timeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      return {unref: () => undefined} as unknown as NodeJS.Timeout;
    }) as unknown as typeof global.setTimeout);
    try {
      await (push as unknown as {
        scheduleTrailingChatWake: (u: string, o: {senderUserId: string}) => Promise<void>;
      }).scheduleTrailingChatWake('u1', {senderUserId: 'sender-a'});
    } finally {
      timeoutSpy.mockRestore();
      pttlSpy.mockRestore();
    }
    expect(delays).toEqual([100]); // 0 remainder + the guard, NOT 2000
  });

  it('B-715 — a fired trailing wake releases its marker, so the window it arms can schedule its own', async () => {
    jest.useFakeTimers({
      doNotFake: [
        'nextTick', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval',
        'queueMicrotask', 'Date', 'performance', 'hrtime',
      ],
    });
    sendEachForMulticast.mockResolvedValue({successCount: 1, responses: [{success: true}]});

    await push.sendChatWake('u1', {senderUserId: 'sender-a'});          // leading edge
    await push.sendChatWake('u1', {senderUserId: 'sender-a'});          // inside window → schedules trailing
    const timers = (push as unknown as {trailingTimers: Set<unknown>}).trailingTimers;
    expect(timers.size).toBe(1);

    // Window end (Date is real here, so expire the leading key by hand).
    await mock.del('push-chat-debounce:u1:sender-a');
    jest.advanceTimersByTime(3_000);
    for (let i = 0; i < 25; i++) await new Promise(r => setImmediate(r));

    expect(sendEachForMulticast).toHaveBeenCalledTimes(2); // the trailing wake delivered
    // The marker is HANDED BACK. Without this the trailing wake's own fresh
    // window inherits a live marker, and the next in-window message schedules
    // NOTHING — the tail of a sustained burst gets no notification at all.
    expect(await mock.exists('push-chat-trailing:u1:sender-a')).toBe(0);

    // Prove it end-to-end: a message inside the newly-armed window arms a second
    // trailing wake rather than being silently dropped.
    const third = await push.sendChatWake('u1', {senderUserId: 'sender-a'});
    expect(third).toEqual({sent: 0, stubbed: false});
    expect(timers.size).toBe(1);
  });

  it('P1-BR-1 — sendVoipWake carries conversationId UNSIGNED (HMAC canonical form unchanged)', async () => {
    const {wakeKeyB64} = await push.registerVoipToken({
      userId: 'u1', deviceId: 'd1', platform: 'android', token: 'tok-1', updatedAt: Date.now(),
    });
    const sendEach = jest.fn().mockResolvedValue({successCount: 1, responses: [{success: true}]});
    (admin.messaging as unknown as jest.Mock).mockReturnValue({sendEachForMulticast, sendEach});

    const r = await push.sendVoipWake('u1', 'call-1', 'sender-a', 'room-tok', 'group-voice', 'grp:c-9');
    expect(r.sent).toBe(1);

    const msg = (sendEach.mock.calls[0][0] as Array<{data: Record<string, string>}>)[0];
    expect(msg.data.conversationId).toBe('grp:c-9');
    expect(msg.data.roomToken).toBe('room-tok');
    expect(msg.data.callKind).toBe('group-voice');
    // The sig still verifies over kind|callId|nonce|exp ONLY — the new field
    // rides unsigned so old APKs keep verifying wakes that carry it.
    expect(msg.data.sig).toBe(voipSign(wakeKeyB64, {
      kind: 'voip-wake', callId: 'call-1', nonce: msg.data.nonce, exp: Number(msg.data.exp),
    }));
  });

  it('P1-BR-1 — sendVoipWake omits conversationId from the wire when not provided (1:1 path unchanged)', async () => {
    await push.registerVoipToken({
      userId: 'u1', deviceId: 'd1', platform: 'android', token: 'tok-1', updatedAt: Date.now(),
    });
    const sendEach = jest.fn().mockResolvedValue({successCount: 1, responses: [{success: true}]});
    (admin.messaging as unknown as jest.Mock).mockReturnValue({sendEachForMulticast, sendEach});

    await push.sendVoipWake('u1', 'call-2', 'sender-a');
    const msg = (sendEach.mock.calls[0][0] as Array<{data: Record<string, string>}>)[0];
    expect('conversationId' in msg.data).toBe(false);
    expect('roomToken' in msg.data).toBe(false);
  });
});
