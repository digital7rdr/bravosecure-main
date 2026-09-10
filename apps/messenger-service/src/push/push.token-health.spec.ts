import {Test} from '@nestjs/testing';
import {ConfigModule} from '@nestjs/config';
import RedisMock from 'ioredis-mock';
import {RedisService} from '../redis/redis.service';
import {PushService} from './push.service';
import configuration from '../config/configuration';

/**
 * B-239 — ring token blackout visibility.
 *
 * A group member whose device never registered a VoIP token simply does not
 * ring when killed, with nothing anywhere saying so. The server-side fixes
 * pinned here:
 *
 *  1. `tokenHealth(userId)` — the self-scoped probe behind
 *     GET /push/token-health. Presence METADATA only: deviceId, platform,
 *     age. It must NEVER return the token material itself, and it is
 *     deliberately self-scoped — a cross-user variant would hand any authed
 *     user a "which victims are unreachable" oracle.
 *  2. The APNs env probe runs at BOOT (onModuleInit → ensureApnsClient), not
 *     lazily on the first iOS wake — which was exactly when the warning was
 *     already too late.
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
  return new PushService(redis);
}

describe('B-239 — tokenHealth probe', () => {
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

  it('reports per-channel presence for the caller devices', async () => {
    await push.registerDeviceToken(
      {userId: 'u1', deviceId: 'd1', platform: 'android', token: 'tok-data-android', updatedAt: Date.now()},
      'jti-1',
    );
    await push.registerVoipToken(
      {userId: 'u1', deviceId: 'd1', platform: 'android', token: 'tok-voip-android', updatedAt: Date.now()},
      {jti: 'jti-1'},
    );
    const health = await push.tokenHealth('u1');
    expect(health.data).toHaveLength(1);
    expect(health.voip).toHaveLength(1);
    expect(health.data[0]).toMatchObject({deviceId: 'd1', platform: 'android'});
    expect(typeof health.data[0].ageMs).toBe('number');
  });

  it('a token-less user reads as empty on both channels (the blackout signature)', async () => {
    const health = await push.tokenHealth('u-ghost');
    expect(health.data).toEqual([]);
    expect(health.voip).toEqual([]);
  });

  it('NEVER leaks token material through the probe', async () => {
    await push.registerDeviceToken(
      {userId: 'u1', deviceId: 'd1', platform: 'android', token: 'SECRET-FCM-TOKEN-XYZ', updatedAt: Date.now()},
      'jti-1',
    );
    await push.registerVoipToken(
      {userId: 'u1', deviceId: 'd1', platform: 'ios', token: 'SECRET-VOIP-TOKEN-ABC', updatedAt: Date.now()},
      {jti: 'jti-1'},
    );
    const health = await push.tokenHealth('u1');
    const serialized = JSON.stringify(health);
    expect(serialized).not.toContain('SECRET-FCM-TOKEN-XYZ');
    expect(serialized).not.toContain('SECRET-VOIP-TOKEN-ABC');
    expect(serialized).not.toContain('token');
  });

  it('surfaces the delivery-lane config state (fcmReady / apnsConfigured)', async () => {
    const health = await push.tokenHealth('u1');
    // Unit env has neither Firebase creds nor APNS_VOIP_* set.
    expect(health.fcmReady).toBe(false);
    expect(health.apnsConfigured).toBe(false);
  });
});
