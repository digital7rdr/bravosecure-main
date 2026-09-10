import {Test} from '@nestjs/testing';
import {ConfigModule} from '@nestjs/config';
import RedisMock from 'ioredis-mock';
import {RedisService} from '../redis/redis.service';
import {PushService, VOIP_WAKE_PAIR_CAP, VOIP_WAKE_RECIPIENT_CAP} from './push.service';
import configuration from '../config/configuration';

/**
 * Audit P0-C5 — per-(sender, recipient) VoIP wake budget.
 *
 * The budget gate is the cheap, perimeter-side defence against a
 * stolen JWT (or single misbehaving authed account) pumping
 * `call.offer` / `sfu.ring` at the WS limiter's full capacity to
 * ring-spam a chosen victim. The test contract:
 *
 *   1. fresh budget admits up to the per-pair cap (VOIP_WAKE_PAIR_CAP/min)
 *   2. one over → pair_budget_exhausted
 *   3. budget is scoped per (sender, recipient) — another sender
 *      against the same recipient gets their own bucket
 *   4. the global per-recipient cap (VOIP_WAKE_RECIPIENT_CAP/min) catches
 *      a distributed attack from many senders against one victim
 *
 * SRV-06 additions: the charge is deduped per distinct callId (bounded free
 * retries) and committed only once sendVoipWake knows a push is genuinely
 * dispatchable — an unreachable recipient no longer spends a unit.
 */

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
  // PushService.onModuleInit tries to wire FCM + pub/sub. We don't want
  // those side effects in unit tests, so construct the service directly
  // bypassing onModuleInit.
  return new PushService(redis);
}

// WI-6.5 — the pair/recipient counters are TIME-BUCKETED (fixed 60s windows,
// suffix = floor(now/60s)); mirror the SUT's key derivation. Time is frozen
// per test (and advanced explicitly) so a window boundary can never flake an
// assertion mid-test.
const BUDGET_WINDOW_SEC = 60;
const bucketOf = () => Math.floor(Date.now() / 1000 / BUDGET_WINDOW_SEC);
const pairKey  = (s: string, r: string) => `push-voip-budget:pair:${s}:${r}:${bucketOf()}`;
const recipKey = (r: string) => `push-voip-budget:recipient:${r}:${bucketOf()}`;

describe('PushService — audit P0-C5 VoIP wake budget', () => {
  let mock: InstanceType<typeof RedisMock>;
  let push: PushService;
  let nowMs: number;

  beforeEach(async () => {
    mock = new RedisMock();
    push = await setup(mock);
    nowMs = 1_755_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await mock.flushall();
    await mock.quit();
  });

  it('admits up to the per-pair cap then rejects', async () => {
    const sender = 'user-attacker';
    const recipient = 'user-victim';
    // cap admitted
    for (let i = 0; i < VOIP_WAKE_PAIR_CAP; i++) {
      const r = await push.consumeVoipWakeBudget(sender, recipient);
      expect(r.ok).toBe(true);
    }
    // one over the cap
    const denied = await push.consumeVoipWakeBudget(sender, recipient);
    expect(denied).toEqual({ok: false, reason: 'pair_budget_exhausted'});
  });

  it('buckets are scoped per (sender, recipient) pair', async () => {
    const victim = 'user-victim';
    // sender-A exhausts their pair budget against victim
    for (let i = 0; i < VOIP_WAKE_PAIR_CAP; i++) {
      const r = await push.consumeVoipWakeBudget('sender-A', victim);
      expect(r.ok).toBe(true);
    }
    // sender-B against the same victim gets a fresh pair bucket
    const senderB = await push.consumeVoipWakeBudget('sender-B', victim);
    expect(senderB.ok).toBe(true);
  });

  it('global recipient cap catches distributed attack', async () => {
    const victim = 'user-victim';
    // Distinct senders each fire one wake — each succeeds per-pair
    // but the last saturates the recipient-wide bucket.
    for (let i = 0; i < VOIP_WAKE_RECIPIENT_CAP; i++) {
      const r = await push.consumeVoipWakeBudget(`sender-${i}`, victim);
      expect(r.ok).toBe(true);
    }
    // One more sender should hit the recipient cap, not the pair cap
    const denied = await push.consumeVoipWakeBudget('sender-over', victim);
    expect(denied).toEqual({ok: false, reason: 'recipient_budget_exhausted'});
  });

  it('empty sender or recipient is rejected (defensive)', async () => {
    expect(await push.consumeVoipWakeBudget('', 'recipient')).toEqual({
      ok: false, reason: 'pair_budget_exhausted',
    });
    expect(await push.consumeVoipWakeBudget('sender', '')).toEqual({
      ok: false, reason: 'pair_budget_exhausted',
    });
  });

  // Row #7 — sendVoipWake itself must consult the budget. Previously the
  // function existed but no caller invoked it; now the check is internal
  // so both gateway callsites (`call.offer` peer-offline + `sfu.ring`)
  // are protected without each site having to remember to call it.
  it('sendVoipWake refuses past the per-pair cap with reason surfaced', async () => {
    const sender    = 'user-attacker';
    const recipient = 'user-victim';
    // Exhaust the pair bucket via the same code path the wake will use.
    for (let i = 0; i < VOIP_WAKE_PAIR_CAP; i++) {
      const r = await push.consumeVoipWakeBudget(sender, recipient);
      expect(r.ok).toBe(true);
    }
    // The next wake from this sender must short-circuit BEFORE we look up
    // device tokens. The recipient has no VoIP tokens registered in the
    // mock, but if the budget weren't consulted we'd return the no-tokens
    // path (sent:0, stubbed:false, no reason). The budget check returns
    // a reason field — assert that's what we got.
    const result = await push.sendVoipWake(recipient, 'call-id', sender);
    expect(result).toEqual({sent: 0, stubbed: false, reason: 'pair_budget_exhausted'});
  });

  // SRV-06 — same-callId dedupe: a group re-ring (sfu.ring reuses roomId as
  // callId) or a same-call retry must not drain the pair bucket.
  it('SRV-06 — the same callId is charged once inside the window', async () => {
    const results: Array<{ok: boolean}> = [];
    for (let i = 0; i < VOIP_WAKE_PAIR_CAP + 2; i++) {
      results.push(await push.consumeVoipWakeBudget('s', 'r', 'call-x'));
    }
    for (const r of results) expect(r.ok).toBe(true);
    // First charge + charges after the bounded free-retry allowance (3) —
    // the pair bucket is NOT exhausted by a same-call loop.
    expect(Number(await mock.get(pairKey('s', 'r')))).toBe(
      1 + Math.max(0, (VOIP_WAKE_PAIR_CAP + 2) - 1 - 3),
    );
  });

  it('SRV-06 — distinct callIds still each cost a unit (perimeter intact)', async () => {
    for (let i = 0; i < VOIP_WAKE_PAIR_CAP; i++) {
      const r = await push.consumeVoipWakeBudget('s', 'r', `c-${i}`);
      expect(r.ok).toBe(true);
    }
    expect(await push.consumeVoipWakeBudget('s', 'r', 'c-last')).toEqual({
      ok: false, reason: 'pair_budget_exhausted',
    });
  });

  it('SRV-06 — free same-callId retries are bounded', async () => {
    const results: Array<{ok: boolean}> = [];
    for (let i = 0; i < 40; i++) {
      results.push(await push.consumeVoipWakeBudget('s', 'r', 'c-loop'));
    }
    // A same-callId loop cannot buy unlimited wakes: 3 free retries total,
    // every later admit is charged, denied once the pair cap is spent.
    expect(results[results.length - 1]).toEqual({ok: false, reason: 'pair_budget_exhausted'});
    expect(results.filter(r => r.ok)).toHaveLength(VOIP_WAKE_PAIR_CAP + 3);
    expect(Number(await mock.get(pairKey('s', 'r')))).toBeGreaterThanOrEqual(VOIP_WAKE_PAIR_CAP);
  });

  it('SRV-06 — a wake with no dispatchable device does not charge', async () => {
    const r = await push.sendVoipWake('u-no-tokens', 'c1', 's1');
    expect(r).toEqual({sent: 0, stubbed: false});
    expect(await mock.exists(pairKey('s1', 'u-no-tokens'))).toBe(0);
    expect(await mock.exists(recipKey('u-no-tokens'))).toBe(0);
  });

  it('SRV-06 — an FCM-not-ready wake does not charge', async () => {
    await push.registerVoipToken({
      userId: 'u9', deviceId: 'd9', platform: 'android', token: 'tok', updatedAt: Date.now(),
    });
    const r = await push.sendVoipWake('u9', 'c2', 's2');
    expect(r).toEqual({sent: 0, stubbed: true}); // records found, FCM creds absent in unit tests
    expect(await mock.exists(pairKey('s2', 'u9'))).toBe(0);
  });

  it('SRV-06 — the deny still short-circuits before any token work', async () => {
    const sender    = 'user-attacker';
    const recipient = 'user-victim';
    // Exhaust the bucket with DISTINCT callIds (each owes a unit).
    for (let i = 0; i < VOIP_WAKE_PAIR_CAP; i++) {
      const r = await push.consumeVoipWakeBudget(sender, recipient, `c-${i}`);
      expect(r.ok).toBe(true);
    }
    expect(await push.sendVoipWake(recipient, 'call-id', sender)).toEqual({
      sent: 0, stubbed: false, reason: 'pair_budget_exhausted',
    });
  });
});

/**
 * Audit P0-N2 (verify-all) — orphan push-token GC, revoke-tombstone model.
 *
 * Contract: when auth-service genuinely revokes a session (logout, password
 * change, /auth/session DELETE, single-device takeover) it writes a
 * `push-revoke:<userId>:<deviceId>` tombstone. The next GC tick MUST drop
 * every push artifact for that (userId, deviceId) — so the next user on the
 * same physical FCM/APNs slot inherits nothing — and then delete the
 * tombstone. Crucially, NATURAL access-token expiry (no tombstone) must NOT
 * reap a token: that was the bug where a KILLED app lost all background
 * notifications ~15 min after going quiet (the bound 15-min access jti
 * expired and the old GC mistook expiry for revocation).
 */
describe('PushService — audit P0-N2 orphan-push-token GC', () => {
  let mock: InstanceType<typeof RedisMock>;
  let push: PushService;

  beforeEach(async () => {
    mock = new RedisMock();
    push = await setup(mock);
  });

  afterEach(async () => {
    await mock.flushall();
    await mock.quit();
  });

  it('drops all push artifacts when a revoke tombstone exists, then clears it', async () => {
    await push.registerDeviceToken({
      userId: 'u1', deviceId: 'd1', platform: 'android',
      token: 'fcm-token-1', updatedAt: Date.now(),
    }, 'jti-1');
    await push.registerVoipToken({
      userId: 'u1', deviceId: 'd1', platform: 'android',
      token: 'fcm-token-1', updatedAt: Date.now(),
    }, {jti: 'jti-1'});

    // Sanity — all three keys land.
    expect(await mock.exists('push-token:u1:d1')).toBe(1);
    expect(await mock.exists('push-voip-token:u1:d1')).toBe(1);
    expect(await mock.exists('push-jti:u1:d1')).toBe(1);

    // No tombstone yet — GC must NOT reap (this is the killed-app case the
    // old jti-expiry GC got wrong).
    expect(await push.gcOrphanPushTokens()).toEqual({scanned: 0, dropped: 0});
    expect(await mock.exists('push-token:u1:d1')).toBe(1);

    // Auth-service revokes the session — writes the tombstone.
    await mock.set('push-revoke:u1:d1', '1');

    // Next GC tick reaps every artifact AND the tombstone itself.
    expect(await push.gcOrphanPushTokens()).toEqual({scanned: 1, dropped: 1});
    expect(await mock.exists('push-token:u1:d1')).toBe(0);
    expect(await mock.exists('push-voip-token:u1:d1')).toBe(0);
    expect(await mock.exists('push-voip-wake-key:u1:d1')).toBe(0);
    expect(await mock.exists('push-jti:u1:d1')).toBe(0);
    expect(await mock.exists('push-revoke:u1:d1')).toBe(0);
  });

  it('leaves tokens with no revoke tombstone untouched (natural expiry is not a revoke)', async () => {
    await push.registerDeviceToken({
      userId: 'u2', deviceId: 'd2', platform: 'android',
      token: 'fcm-token-2', updatedAt: Date.now(),
    }, 'jti-2');
    // Even though no `jti:*` allowlist entry exists for this token's bound
    // jti, the token MUST survive — only an explicit tombstone reaps it.
    expect(await push.gcOrphanPushTokens()).toEqual({scanned: 0, dropped: 0});
    expect(await mock.exists('push-token:u2:d2')).toBe(1);
    expect(await mock.exists('push-jti:u2:d2')).toBe(1);
  });

  it('GC is a no-op when there are no revoke tombstones', async () => {
    expect(await push.gcOrphanPushTokens()).toEqual({scanned: 0, dropped: 0});
  });

  it('unregisterDeviceToken keeps the JTI binding alive if voip still registered', async () => {
    // (userId, deviceId) with BOTH channels registered. Unregistering
    // just the data channel must leave the JTI binding in place so
    // the surviving voip channel stays GC-protected.
    const jti = 'jti-pair-survives';
    await mock.set(`jti:${jti}`, '1');
    await push.registerDeviceToken({
      userId: 'u3', deviceId: 'd3', platform: 'android',
      token: 'tok', updatedAt: Date.now(),
    }, jti);
    await push.registerVoipToken({
      userId: 'u3', deviceId: 'd3', platform: 'android',
      token: 'tok', updatedAt: Date.now(),
    }, {jti});

    await push.unregisterDeviceToken('u3', 'd3');
    expect(await mock.exists('push-token:u3:d3')).toBe(0);
    expect(await mock.exists('push-voip-token:u3:d3')).toBe(1);
    // Binding survives because the voip channel still needs GC coverage.
    expect(await mock.exists('push-jti:u3:d3')).toBe(1);

    await push.unregisterVoipToken('u3', 'd3');
    // Both channels gone — binding finally drops.
    expect(await mock.exists('push-jti:u3:d3')).toBe(0);
  });
});

/**
 * CRIT-1 — per-user device-id index replaces the whole-keyspace SCAN on the
 * push hot path. Contract:
 *   1. register* adds the deviceId to the channel index SET
 *   2. unregister* / GC removes it
 *   3. a lookup with an EMPTY index falls back to ONE scoped SCAN, backfills
 *      the index, and marks the user migrated so it never SCANs again
 *   4. a genuinely token-less user is marked migrated after one empty scan
 */
describe('PushService — CRIT-1 per-user push-token index', () => {
  let mock: InstanceType<typeof RedisMock>;
  let push: PushService;

  beforeEach(async () => {
    mock = new RedisMock();
    push = await setup(mock);
  });

  afterEach(async () => {
    await mock.flushall();
    await mock.quit();
  });

  it('register/unregister maintain the DATA and VOIP indexes', async () => {
    await push.registerDeviceToken({
      userId: 'u1', deviceId: 'dA', platform: 'android', token: 'tA', updatedAt: Date.now(),
    });
    await push.registerDeviceToken({
      userId: 'u1', deviceId: 'dB', platform: 'android', token: 'tB', updatedAt: Date.now(),
    });
    await push.registerVoipToken({
      userId: 'u1', deviceId: 'dA', platform: 'android', token: 'tA', updatedAt: Date.now(),
    });

    expect((await mock.smembers('push-index-data:u1')).sort()).toEqual(['dA', 'dB']);
    expect(await mock.smembers('push-index-voip:u1')).toEqual(['dA']);

    await push.unregisterDeviceToken('u1', 'dA');
    expect(await mock.smembers('push-index-data:u1')).toEqual(['dB']);
    // VOIP index untouched by a DATA unregister.
    expect(await mock.smembers('push-index-voip:u1')).toEqual(['dA']);

    await push.unregisterVoipToken('u1', 'dA');
    expect(await mock.smembers('push-index-voip:u1')).toEqual([]);
  });

  it('GC revoke removes the device from both indexes', async () => {
    await push.registerDeviceToken({
      userId: 'u2', deviceId: 'dX', platform: 'android', token: 'tX', updatedAt: Date.now(),
    });
    await push.registerVoipToken({
      userId: 'u2', deviceId: 'dX', platform: 'android', token: 'tX', updatedAt: Date.now(),
    });
    await mock.set('push-revoke:u2:dX', '1');
    await push.gcOrphanPushTokens();
    expect(await mock.smembers('push-index-data:u2')).toEqual([]);
    expect(await mock.smembers('push-index-voip:u2')).toEqual([]);
  });

  it('backfills the index from a scoped SCAN for pre-index tokens, then marks migrated', async () => {
    // Simulate a token registered before the index existed: the token key
    // is present but the index SET is not.
    await mock.set('push-token:legacy:dOld', JSON.stringify({
      userId: 'legacy', deviceId: 'dOld', platform: 'android', token: 'tOld', updatedAt: Date.now(),
    }));
    expect(await mock.smembers('push-index-data:legacy')).toEqual([]);

    // sendToUser triggers the index resolution → one SCAN + backfill.
    const r = await push.sendToUser('legacy');
    expect(r.sent).toBe(1);
    expect(await mock.smembers('push-index-data:legacy')).toEqual(['dOld']);
    // Migration marker present so subsequent empty-index lookups don't SCAN.
    expect(await mock.exists('push-index-mig:push-index-data:legacy')).toBe(1);
  });

  it('marks a token-less user migrated so it never re-scans', async () => {
    const r = await push.sendToUser('ghost');
    expect(r.sent).toBe(0);
    expect(await mock.exists('push-index-mig:push-index-data:ghost')).toBe(1);
  });
});

/**
 * B-48 (2026-07-05) — killed-app notification blackout.
 *
 * Two server-side contracts:
 *   1. A token FCM flags `registration-token-not-registered` is dead for
 *      BOTH channels (same physical FCM token on Android) — cleanup must
 *      reap the twin keyspace copy too, not leave a half-alive device
 *      where messages log `no-tokens` while calls fire into the void.
 *   2. sendChatWake falls back to the user's android VOIP-channel token
 *      when the DATA copy is missing (failed /push/register, pre-fix
 *      asymmetric cleanup) instead of silently skipping the wake.
 */
describe('PushService — B-48 dead-token twin reap + chat-wake VOIP fallback', () => {
  let mock: InstanceType<typeof RedisMock>;
  let push: PushService;

  // Private-method access mirrors push-events.opacity.spec.ts.
  type CleanupFn = (
    userId: string,
    resp: {responses: Array<{success: boolean; error?: {code: string}}>},
    tokens: string[],
    keyPrefix: 'push-token:' | 'push-voip-token:',
  ) => Promise<void>;
  const cleanup = (): CleanupFn =>
    (push as unknown as {cleanupBadTokens: CleanupFn}).cleanupBadTokens.bind(push);
  const deadResp = {responses: [{success: false, error: {code: 'messaging/registration-token-not-registered'}}]};

  beforeEach(async () => {
    mock = new RedisMock();
    push = await setup(mock);
  });

  afterEach(async () => {
    // P2-14 — clear any trailing chat-wake timer the debounce tests armed so
    // it can't fire against the quit mock after the test completes.
    push.onModuleDestroy();
    await mock.flushall();
    await mock.quit();
  });

  it('reaps the VOIP twin when a DATA-scanned token is dead (android shared token)', async () => {
    await push.registerDeviceToken({
      userId: 'u1', deviceId: 'd1', platform: 'android', token: 'tok-dead', updatedAt: Date.now(),
    });
    await push.registerVoipToken({
      userId: 'u1', deviceId: 'd1', platform: 'android', token: 'tok-dead', updatedAt: Date.now(),
    });

    await cleanup()('u1', deadResp, ['tok-dead'], 'push-token:');

    expect(await mock.exists('push-token:u1:d1')).toBe(0);
    expect(await mock.exists('push-voip-token:u1:d1')).toBe(0);
    expect(await mock.smembers('push-index-data:u1')).toEqual([]);
    expect(await mock.smembers('push-index-voip:u1')).toEqual([]);
  });

  it('reaps the DATA twin when a VOIP-scanned token is dead', async () => {
    await push.registerDeviceToken({
      userId: 'u2', deviceId: 'd2', platform: 'android', token: 'tok-dead', updatedAt: Date.now(),
    });
    await push.registerVoipToken({
      userId: 'u2', deviceId: 'd2', platform: 'android', token: 'tok-dead', updatedAt: Date.now(),
    });

    await cleanup()('u2', deadResp, ['tok-dead'], 'push-voip-token:');

    expect(await mock.exists('push-token:u2:d2')).toBe(0);
    expect(await mock.exists('push-voip-token:u2:d2')).toBe(0);
  });

  it('does NOT touch a twin holding a DIFFERENT token (iOS: APNs VoIP ≠ FCM)', async () => {
    await push.registerDeviceToken({
      userId: 'u3', deviceId: 'd3', platform: 'ios', token: 'fcm-dead', updatedAt: Date.now(),
    });
    await push.registerVoipToken({
      userId: 'u3', deviceId: 'd3', platform: 'ios', token: 'apns-voip-alive', updatedAt: Date.now(),
    });

    await cleanup()('u3', deadResp, ['fcm-dead'], 'push-token:');

    expect(await mock.exists('push-token:u3:d3')).toBe(0);
    // Different token value — must survive.
    expect(await mock.exists('push-voip-token:u3:d3')).toBe(1);
    expect(await mock.smembers('push-index-voip:u3')).toEqual(['d3']);
  });

  it('leaves other devices of the same user untouched', async () => {
    await push.registerDeviceToken({
      userId: 'u4', deviceId: 'dDead', platform: 'android', token: 'tok-dead', updatedAt: Date.now(),
    });
    await push.registerDeviceToken({
      userId: 'u4', deviceId: 'dAlive', platform: 'android', token: 'tok-alive', updatedAt: Date.now(),
    });

    await cleanup()('u4', deadResp, ['tok-dead'], 'push-token:');

    expect(await mock.exists('push-token:u4:dDead')).toBe(0);
    expect(await mock.exists('push-token:u4:dAlive')).toBe(1);
    expect(await mock.smembers('push-index-data:u4')).toEqual(['dAlive']);
  });

  // FCM is not initialised in tests, so the observable contract is which
  // branch sendChatWake exits through: token records found → fcm-not-ready
  // stub {sent:0, stubbed:true}; no records anywhere → {sent:0, stubbed:false}.
  it('sendChatWake falls back to an android VOIP token when DATA is missing', async () => {
    await push.registerVoipToken({
      userId: 'u5', deviceId: 'd5', platform: 'android', token: 'tok-voip', updatedAt: Date.now(),
    });
    // Half-alive state: VOIP present, DATA absent (the live itsirajul case).
    expect(await mock.exists('push-token:u5:d5')).toBe(0);

    const r = await push.sendChatWake('u5', {senderUserId: 'sender'});
    expect(r).toEqual({sent: 0, stubbed: true}); // records FOUND, stubbed only by missing FCM creds
  });

  it('sendChatWake does NOT fall back to an iOS VoIP token', async () => {
    await push.registerVoipToken({
      userId: 'u6', deviceId: 'd6', platform: 'ios', token: 'apns-voip', updatedAt: Date.now(),
    });

    const r = await push.sendChatWake('u6', {senderUserId: 'sender'});
    expect(r).toEqual({sent: 0, stubbed: false}); // genuinely no usable token
  });

  it('sendChatWake still reports no-tokens when neither channel is registered', async () => {
    const r = await push.sendChatWake('u7', {senderUserId: 'sender'});
    expect(r).toEqual({sent: 0, stubbed: false});
  });

  it('N-32 — sendChatWake debounces a rapid second wake from the same sender', async () => {
    // A registered android DATA token means the FIRST wake proceeds past the
    // token lookup (and is only stubbed by missing FCM creds → stubbed:true).
    await push.registerDeviceToken({
      userId: 'u8', deviceId: 'd8', platform: 'android', token: 'fcm-a', updatedAt: Date.now(),
    });

    const first = await push.sendChatWake('u8', {senderUserId: 'burst-sender'});
    expect(first.stubbed).toBe(true); // reached FCM path (no creds → stubbed)
    // The first wake set the debounce key (NX) with a short TTL.
    expect(await mock.get('push-chat-debounce:u8:burst-sender')).toBe('1');
    const ttl = await mock.ttl('push-chat-debounce:u8:burst-sender');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(6);

    // A second wake within the window short-circuits BEFORE the token lookup —
    // distinguishable from the first because it returns stubbed:false.
    const second = await push.sendChatWake('u8', {senderUserId: 'burst-sender'});
    expect(second).toEqual({sent: 0, stubbed: false});

    // A DIFFERENT sender to the same recipient is NOT debounced (own bucket).
    await push.sendChatWake('u8', {senderUserId: 'other-sender'});
    expect(await mock.get('push-chat-debounce:u8:other-sender')).toBe('1');
  });
});

/**
 * WI-6.5 — un-brickable wake budget.
 *
 * The old shape was `INCR` then conditional `EXPIRE`: a crash / Redis error
 * between the two left a TTL-LESS, ever-growing counter that permanently
 * denied the pair's wakes at the cap (the class D-5 fixed for the rate
 * limiter). The fix is structural: pair/recipient counters are keyed by a
 * fixed 60s time bucket, so a counter whose EXPIRE never lands simply stops
 * being READ one window later. Time is frozen and advanced manually — the
 * frozen clock is exactly the "EXPIRE never fires" world, which is the point.
 */
describe('WI-6.5 — bucketed budget cannot brick', () => {
  let mock: InstanceType<typeof RedisMock>;
  let push: PushService;
  let nowMs: number;

  beforeEach(async () => {
    mock = new RedisMock();
    push = await setup(mock);
    nowMs = 1_755_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await mock.flushall();
    await mock.quit();
  });

  it('commits land on the BUCKETED key, not the legacy unbucketed one', async () => {
    await push.consumeVoipWakeBudget('s', 'r');
    expect(await mock.exists(pairKey('s', 'r'))).toBe(1);
    expect(await mock.exists(recipKey('r'))).toBe(1);
    expect(await mock.exists('push-voip-budget:pair:s:r')).toBe(0);
    expect(await mock.exists('push-voip-budget:recipient:r')).toBe(0);
  });

  it('an exhausted counter whose EXPIRE never fires stops mattering next window', async () => {
    for (let i = 0; i < VOIP_WAKE_PAIR_CAP; i++) {
      expect((await push.consumeVoipWakeBudget('s', 'r')).ok).toBe(true);
    }
    expect(await push.consumeVoipWakeBudget('s', 'r')).toEqual({ok: false, reason: 'pair_budget_exhausted'});
    const staleKey = pairKey('s', 'r');

    // Cross the window boundary. The frozen clock means the stale counter's
    // TTL can never have elapsed — the pre-fix world would still read it and
    // deny forever.
    nowMs += 61_000;
    expect(await mock.exists(staleKey)).toBe(1);           // still there, never expired
    expect((await push.consumeVoipWakeBudget('s', 'r')).ok).toBe(true); // ...and irrelevant
  });

  it('the recipient-wide counter self-heals the same way', async () => {
    for (let i = 0; i < VOIP_WAKE_RECIPIENT_CAP; i++) {
      expect((await push.consumeVoipWakeBudget(`s-${i}`, 'victim')).ok).toBe(true);
    }
    expect(await push.consumeVoipWakeBudget('s-over', 'victim'))
      .toEqual({ok: false, reason: 'recipient_budget_exhausted'});
    nowMs += 61_000;
    expect((await push.consumeVoipWakeBudget('s-over', 'victim')).ok).toBe(true);
  });

  it('the per-call dedup key gets its TTL atomically with the INCR (no TTL-less leak)', async () => {
    await push.consumeVoipWakeBudget('s', 'r', 'call-ttl');
    const ttl = await mock.ttl('push-voip-budget:call:s:r:call-ttl');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it('bucketed counters carry a hygiene TTL of two windows', async () => {
    await push.consumeVoipWakeBudget('s', 'r');
    const ttl = await mock.ttl(pairKey('s', 'r'));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(120);
  });
});
