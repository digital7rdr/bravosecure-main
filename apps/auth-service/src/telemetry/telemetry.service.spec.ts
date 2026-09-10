import {TelemetryService} from './telemetry.service';
import type {DatabaseService} from '../database/database.service';
import type {RedisService} from '../redis/redis.service';

function mockDb() {
  return {q: jest.fn(), qOne: jest.fn()} as unknown as DatabaseService & {
    q: jest.Mock; qOne: jest.Mock;
  };
}

function mockRedis() {
  const client = {
    xadd: jest.fn().mockResolvedValue('1-0'),
    expire: jest.fn().mockResolvedValue(1),
    xrevrange: jest.fn().mockResolvedValue([]),
  };
  return {client} as unknown as RedisService & {client: typeof client};
}

function mockCfg(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    'telemetry.streamMaxLen': 500,
    'telemetry.streamTtlSec': 86_400,
    ...overrides,
  };
  return {get: (k: string) => values[k]} as never;
}

describe('TelemetryService', () => {
  describe('ping', () => {
    it('rejects when the booking does not exist', async () => {
      const db = mockDb();
      db.qOne.mockResolvedValueOnce(null);
      const svc = new TelemetryService(mockRedis(), db, mockCfg());
      await expect(
        svc.ping('missing', {lat: 25, lng: 55}),
      ).rejects.toMatchObject({message: 'booking_not_found'});
    });

    it('writes both Redis Stream + Postgres last-fix with MAXLEN cap', async () => {
      const db = mockDb();
      db.qOne.mockResolvedValueOnce({id: 'b1'});
      const redis = mockRedis();
      const svc = new TelemetryService(redis, db, mockCfg());

      await svc.ping('b1', {lat: 25, lng: 55, heading_deg: 90, speed_kph: 40, eta_minutes: 12});

      expect(redis.client.xadd).toHaveBeenCalledWith(
        'telemetry:b1',
        'MAXLEN', '~', '500', '*',
        'lat', '25',
        'lng', '55',
        'recorded_at', expect.any(String),
        'source', 'agent',
        'heading_deg', '90',
        'speed_kph', '40',
        'eta_minutes', '12',
      );
      expect(redis.client.expire).toHaveBeenCalledWith('telemetry:b1', 86_400);

      const upsert = db.q.mock.calls.find(c =>
        typeof c[0] === 'string' && c[0].includes('INSERT INTO mission_telemetry_last'),
      );
      expect(upsert).toBeTruthy();
      expect(upsert?.[1][0]).toBe('b1');
      expect(upsert?.[1][1]).toBe(25);
      expect(upsert?.[1][2]).toBe(55);
    });

    it('falls back to Postgres when Redis XADD throws', async () => {
      const db = mockDb();
      db.qOne.mockResolvedValueOnce({id: 'b1'});
      const redis = mockRedis();
      redis.client.xadd = jest.fn().mockRejectedValue(new Error('redis down'));
      const svc = new TelemetryService(redis, db, mockCfg());
      await expect(svc.ping('b1', {lat: 25, lng: 55})).resolves.toMatchObject({lat: 25});
      // Postgres upsert still happened.
      expect(db.q).toHaveBeenCalled();
    });
  });

  describe('latest', () => {
    it('returns the Redis Stream tip when present', async () => {
      const db = mockDb();
      const redis = mockRedis();
      redis.client.xrevrange = jest.fn().mockResolvedValue([
        ['42-0', ['lat', '25.1', 'lng', '55.2', 'recorded_at', '2026-04-23T12:00:00Z', 'source', 'agent', 'eta_minutes', '7']],
      ]);
      const svc = new TelemetryService(redis, db, mockCfg());
      const fix = await svc.latest('b1');
      expect(fix?.lat).toBe(25.1);
      expect(fix?.eta_minutes).toBe(7);
      expect(db.qOne).not.toHaveBeenCalled();
    });

    it('falls back to Postgres when Redis is empty', async () => {
      const db = mockDb();
      db.qOne.mockResolvedValueOnce({
        lat: '25.3', lng: '55.4', heading_deg: null, speed_kph: null,
        eta_minutes: 4, recorded_at: new Date('2026-04-23T12:05:00Z'), source: 'agent',
      });
      const redis = mockRedis();
      const svc = new TelemetryService(redis, db, mockCfg());
      const fix = await svc.latest('b1');
      expect(fix?.lat).toBeCloseTo(25.3, 1);
      expect(fix?.eta_minutes).toBe(4);
    });

    it('returns null when neither Redis nor Postgres have a fix', async () => {
      const db = mockDb();
      db.qOne.mockResolvedValueOnce(null);
      const svc = new TelemetryService(mockRedis(), db, mockCfg());
      expect(await svc.latest('b1')).toBeNull();
    });
  });

  describe('recent', () => {
    it('returns fixes in chronological order (oldest → newest)', async () => {
      const db = mockDb();
      const redis = mockRedis();
      // xrevrange returns newest-first; the service reverses to chronological.
      redis.client.xrevrange = jest.fn().mockResolvedValue([
        ['3-0', ['lat', '3', 'lng', '3', 'recorded_at', 't3', 'source', 'agent']],
        ['2-0', ['lat', '2', 'lng', '2', 'recorded_at', 't2', 'source', 'agent']],
        ['1-0', ['lat', '1', 'lng', '1', 'recorded_at', 't1', 'source', 'agent']],
      ]);
      const svc = new TelemetryService(redis, db, mockCfg());
      const fixes = await svc.recent('b1', 3);
      expect(fixes.map(f => f.lat)).toEqual([1, 2, 3]);
    });

    it('caps the requested count at 200', async () => {
      const redis = mockRedis();
      const svc = new TelemetryService(redis, mockDb(), mockCfg());
      await svc.recent('b1', 10_000);
      const [, , , , countArg] = (redis.client.xrevrange as jest.Mock).mock.calls[0];
      expect(countArg).toBe(200);
    });
  });
});
