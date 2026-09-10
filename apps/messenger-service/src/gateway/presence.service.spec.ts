import {Test} from '@nestjs/testing';
import {ConfigModule} from '@nestjs/config';
import RedisMock from 'ioredis-mock';
import {RedisService} from '../redis/redis.service';
import {UserPrivacyService} from '../users/user-privacy.service';
import {PresenceService} from './presence.service';
import {SocketHub} from './socket-hub';
import configuration from '../config/configuration';

/**
 * PresenceService is the source of truth for "who is online". Tests
 * cover the four things UI actually relies on:
 *  1. multi-device counter — user stays online while any device is up
 *  2. snapshot via getMany — subscribers paint immediately on join
 *  3. watcher fan-out via SocketHub.server.to(watchRoom).emit
 *  4. P2-BR-10 — liveness lease expiry self-heals ungraceful pod death
 *     (no permanent "online" pin, counter drift reset, sweep reaps)
 */

interface EmittedFrame {room: string; event: string; data: unknown}

class SpyHub extends SocketHub {
  emits: EmittedFrame[] = [];

  constructor() {
    super();
    const emits = this.emits;
    // Stand in a fake socket.io Server whose `to(room).volatile.emit`
    // records into `emits`. Just enough shape for PresenceService to
    // call into without wiring a real Redis adapter.
    const chain = (room: string) => ({
      volatile: {
        emit: (event: string, data: unknown) => { emits.push({room, event, data}); },
      },
      emit: (event: string, data: unknown) => { emits.push({room, event, data}); },
    });
    this.server = {to: (room: string) => chain(room)} as unknown as SocketHub['server'];
  }
}

async function setup(mock: InstanceType<typeof RedisMock>) {
  // M-06 — stub privacy flags; individual tests flip `lastSeenVisible`.
  const flags = {lastSeenVisible: true};
  const privacy = {
    ...flags,
    isLastSeenVisible: jest.fn(async (): Promise<boolean> => privacy.lastSeenVisible),
    isBlockedEither:   jest.fn(async () => false),
  };
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({isGlobal: true, load: [configuration]})],
    providers: [
      RedisService,
      {provide: SocketHub, useClass: SpyHub},
      {provide: UserPrivacyService, useValue: privacy},
      PresenceService,
    ],
  })
    .overrideProvider(RedisService)
    .useValue({client: mock} as unknown as RedisService)
    .compile();

  return {
    presence: moduleRef.get(PresenceService),
    hub:      moduleRef.get(SocketHub) as SpyHub,
    redis:    mock,
    privacy,
  };
}

describe('PresenceService', () => {
  let sharedRedis: InstanceType<typeof RedisMock>;

  beforeAll(() => { sharedRedis = new RedisMock(); });
  beforeEach(async () => { await sharedRedis.flushall(); });

  it('returns offline by default and reads back what it sets', async () => {
    const {presence} = await setup(sharedRedis);
    expect((await presence.get('alice')).state).toBe('offline');

    const rec = await presence.set('alice', 'online');
    expect(rec.state).toBe('online');
    expect(rec.lastSeenMs).toBeGreaterThan(0);

    const roundTrip = await presence.get('alice');
    expect(roundTrip.state).toBe('online');
  });

  it('getMany returns records for requested ids, offline for unknowns', async () => {
    const {presence} = await setup(sharedRedis);
    await presence.set('alice', 'active');
    await presence.set('bob',   'away');
    const snap = await presence.getMany(['alice', 'bob', 'carol']);
    expect(snap['alice'].state).toBe('active');
    expect(snap['bob'].state).toBe('away');
    expect(snap['carol'].state).toBe('offline');
  });

  it('emits to watch:<userId> on every set()', async () => {
    const {presence, hub} = await setup(sharedRedis);
    await presence.set('alice', 'online');
    await presence.set('alice', 'active');
    const toAliceWatch = hub.emits.filter(e => e.room === 'watch:alice');
    expect(toAliceWatch).toHaveLength(2);
    expect(toAliceWatch[0].event).toBe('presence');
    expect((toAliceWatch[1].data as {state: string}).state).toBe('active');
  });

  it('M-06: broadcast carries lastSeenMs when the subject shows last seen', async () => {
    const {presence, hub} = await setup(sharedRedis);
    await presence.set('alice', 'online');
    const frame = hub.emits.find(e => e.room === 'watch:alice')!;
    expect((frame.data as {lastSeenMs?: number}).lastSeenMs).toBeGreaterThan(0);
  });

  it('M-06: broadcast omits lastSeenMs when last_seen_visible=false', async () => {
    const {presence, hub, privacy} = await setup(sharedRedis);
    privacy.lastSeenVisible = false;
    await presence.set('alice', 'online');
    const frame = hub.emits.find(e => e.room === 'watch:alice')!;
    const data = frame.data as {userId: string; state: string; lastSeenMs?: number};
    expect(data.state).toBe('online');           // presence itself stays
    expect('lastSeenMs' in data).toBe(false);    // last seen stripped
    // Redis still stores the real record — enforcement is emit-side only.
    expect((await presence.get('alice')).lastSeenMs).toBeGreaterThan(0);
  });

  it('onConnect returns true only for the first device (multi-device)', async () => {
    const {presence} = await setup(sharedRedis);
    expect(await presence.onConnect('alice')).toBe(true);   // phone
    expect(await presence.onConnect('alice')).toBe(false);  // tablet
    expect(await presence.onConnect('alice')).toBe(false);  // laptop
  });

  it('onDisconnect returns true only when the last device drops', async () => {
    const {presence} = await setup(sharedRedis);
    await presence.onConnect('alice');   // phone
    await presence.onConnect('alice');   // tablet
    expect(await presence.onDisconnect('alice')).toBe(false); // phone gone, tablet left
    expect(await presence.onDisconnect('alice')).toBe(true);  // tablet gone, last device
  });

  it('onDisconnect without a prior connect self-heals to "last-device" (true)', async () => {
    const {presence} = await setup(sharedRedis);
    expect(await presence.onDisconnect('ghost')).toBe(true);
  });

  describe('touch (heartbeat liveness refresh — WS-MED false-offline fix)', () => {
    it('refreshes the counter TTL for a connected user', async () => {
      const {presence, redis} = await setup(sharedRedis);
      await presence.onConnect('dave');
      // Simulate TTL decay toward expiry.
      await redis.expire('presence:count:dave', 30);
      expect(await redis.ttl('presence:count:dave')).toBeLessThanOrEqual(30);
      await presence.touch('dave');
      // Bumped back to the 6h counter TTL, so a long-lived socket isn't reaped.
      expect(await redis.ttl('presence:count:dave')).toBeGreaterThan(1000);
    });

    it('refreshes the liveness lease TTL (P2-BR-10 heartbeat path)', async () => {
      const {presence, redis} = await setup(sharedRedis);
      await presence.onConnect('dave');
      await redis.expire('presence:live:dave', 5);
      expect(await redis.ttl('presence:live:dave')).toBeLessThanOrEqual(5);
      await presence.touch('dave');
      expect(await redis.ttl('presence:live:dave')).toBeGreaterThan(60);
    });

    it('does not resurrect a missing counter or lease (offline user)', async () => {
      const {presence, redis} = await setup(sharedRedis);
      await presence.touch('nobody');
      expect(await redis.exists('presence:count:nobody')).toBe(0);
      expect(await redis.exists('presence:live:nobody')).toBe(0);
    });
  });

  describe('sweepStale (false-active reaper)', () => {
    it('flips state to offline + broadcasts when the lease is gone but state stays online', async () => {
      const {presence, hub} = await setup(sharedRedis);
      // Simulate the crash scenario: state was set to online, but the
      // disconnect handler never ran. The 120s lease expires while the
      // 30d state TTL persists.
      await presence.set('alice', 'online');
      // Lease only set if onConnect ran — for the stale case it doesn't exist.
      expect((await presence.get('alice')).state).toBe('online');
      hub.emits.length = 0;

      const {scanned, reaped} = await presence.sweepStale();
      expect(reaped).toBe(1);
      expect(scanned).toBeGreaterThanOrEqual(1);
      expect((await presence.get('alice')).state).toBe('offline');
      const offlineFrames = hub.emits.filter(e => e.room === 'watch:alice');
      expect(offlineFrames).toHaveLength(1);
      expect((offlineFrames[0].data as {state: string}).state).toBe('offline');
    });

    it('skips users whose lease is still live (connected device)', async () => {
      const {presence} = await setup(sharedRedis);
      await presence.onConnect('bob');           // counter=1 + lease
      await presence.set('bob', 'online');
      const {reaped} = await presence.sweepStale();
      expect(reaped).toBe(0);
      expect((await presence.get('bob')).state).toBe('online');
    });

    it('skips users already at offline (no-op, no spurious broadcast)', async () => {
      const {presence, hub} = await setup(sharedRedis);
      await presence.set('carol', 'offline');
      hub.emits.length = 0;
      const {reaped} = await presence.sweepStale();
      expect(reaped).toBe(0);
      expect(hub.emits.filter(e => e.room === 'watch:carol')).toHaveLength(0);
    });
  });

  describe('P2-BR-10 — ungraceful pod death self-heals via lease expiry', () => {
    it('reaps a user whose counter leaked (+1) but whose lease expired — no permanent pin', async () => {
      const {presence, redis} = await setup(sharedRedis);
      // Pod A: user connects, flips online. Pod dies (kill -9) — no
      // onDisconnect, counter stays at 1.
      await presence.onConnect('alice');
      await presence.set('alice', 'online');
      expect(await redis.get('presence:count:alice')).toBe('1');
      // Lease expiry is the only thing a dead pod "does".
      await redis.del('presence:live:alice');

      const {reaped} = await presence.sweepStale();
      expect(reaped).toBe(1);
      expect((await presence.get('alice')).state).toBe('offline');
      // Drift cleaned: the leaked counter is gone, next connect counts from 0.
      expect(await redis.exists('presence:count:alice')).toBe(0);
    });

    it('daily-active reconnect after crash resets the leaked counter (first-device edge fires again)', async () => {
      const {presence, redis} = await setup(sharedRedis);
      // Crash leaks counter=1; lease expires overnight.
      await presence.onConnect('eve');
      await redis.del('presence:live:eve');
      // Next morning: reconnect. Old behavior: INCR → 2, pinned online
      // forever. New behavior: lease gone ⇒ counter reset ⇒ first device.
      expect(await presence.onConnect('eve')).toBe(true);
      expect(await redis.get('presence:count:eve')).toBe('1');
      // Graceful disconnect flips offline immediately, no drift left.
      expect(await presence.onDisconnect('eve')).toBe(true);
      expect(await redis.exists('presence:live:eve')).toBe(0);
    });

    it('fast reconnect within the lease window: drift heals via sweep after the last disconnect', async () => {
      const {presence, redis} = await setup(sharedRedis);
      await presence.onConnect('frank');          // pod A, then kill -9
      // Client reconnects within 120s — lease still alive, so the leaked
      // +1 survives and this disconnect can't flip offline (count 2→1)…
      await presence.onConnect('frank');
      expect(await presence.onDisconnect('frank')).toBe(false);
      expect((await presence.set('frank', 'online')).state).toBe('online');
      // …but with no live socket nothing refreshes the lease; it expires,
      // and the sweep both reaps the user AND deletes the drifted counter.
      await redis.del('presence:live:frank');
      const {reaped} = await presence.sweepStale();
      expect(reaped).toBe(1);
      expect((await presence.get('frank')).state).toBe('offline');
      expect(await redis.exists('presence:count:frank')).toBe(0);
      // Next session behaves like a clean first device.
      expect(await presence.onConnect('frank')).toBe(true);
    });

    it('multi-device: lease survives one disconnect, is deleted with the last', async () => {
      const {presence, redis} = await setup(sharedRedis);
      await presence.onConnect('gina');   // phone
      await presence.onConnect('gina');   // tablet
      expect(await presence.onDisconnect('gina')).toBe(false);
      expect(await redis.exists('presence:live:gina')).toBe(1);
      expect(await presence.onDisconnect('gina')).toBe(true);
      expect(await redis.exists('presence:live:gina')).toBe(0);
    });

    it('reassertLocalLeases recreates the lease for local connections (covers non-pinging clients)', async () => {
      const {presence, redis} = await setup(sharedRedis);
      await presence.onConnect('hana');
      // Simulate lease loss mid-session (Redis restart / stalled refresh).
      await redis.del('presence:live:hana');
      await presence.reassertLocalLeases();
      expect(await redis.exists('presence:live:hana')).toBe(1);
      expect(await redis.ttl('presence:live:hana')).toBeGreaterThan(60);
      // A sweep now (correctly) leaves the connected user alone.
      await presence.set('hana', 'online');
      const {reaped} = await presence.sweepStale();
      expect(reaped).toBe(0);
    });

    it('reassertLocalLeases stops refreshing once the user disconnects (pod bookkeeping)', async () => {
      const {presence, redis} = await setup(sharedRedis);
      await presence.onConnect('ivan');
      await presence.onDisconnect('ivan');
      await redis.del('presence:live:ivan');
      await presence.reassertLocalLeases();
      // No local connection ⇒ no resurrection ⇒ sweep can reap normally.
      expect(await redis.exists('presence:live:ivan')).toBe(0);
    });
  });
});
