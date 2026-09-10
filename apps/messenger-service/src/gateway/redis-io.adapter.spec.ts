/**
 * SRV-07/OR-5 — `connectionStateRecovery` must be advertised ONLY when
 * SessionAwareRedisAdapter is actually installed, and the switch must come
 * from config (ws.sessionRecovery → ctor arg), not a bare process.env read.
 *
 * With the stock RedisAdapter, `restoreSession` inherits the base Adapter's
 * `return null`, so advertising the option only made socket.io mint a pid
 * per socket that the mobile transport then persisted and re-presented for
 * nothing.
 */
jest.mock('ioredis', () => {
  class MockRedis {
    connect = jest.fn().mockResolvedValue(undefined);
    quit    = jest.fn().mockResolvedValue('OK');
    duplicate(): MockRedis {
      return new MockRedis();
    }
  }
  return {__esModule: true, default: MockRedis};
});
jest.mock('@socket.io/redis-adapter', () => ({
  __esModule:    true,
  createAdapter: jest.fn(() => 'stock-adapter'),
}));
jest.mock('./session-aware-redis-adapter', () => ({
  __esModule:                     true,
  createSessionAwareRedisAdapter: jest.fn(() => 'session-aware-adapter'),
}));

import {IoAdapter} from '@nestjs/platform-socket.io';
import type {INestApplicationContext} from '@nestjs/common';
import type {ServerOptions} from 'socket.io';
import {createAdapter} from '@socket.io/redis-adapter';
import {createSessionAwareRedisAdapter} from './session-aware-redis-adapter';
import {RedisIoAdapter} from './redis-io.adapter';

const stockFactory       = createAdapter as unknown as jest.Mock;
const sessionAwareFactory = createSessionAwareRedisAdapter as unknown as jest.Mock;

function build(sessionRecovery = false): RedisIoAdapter {
  return new RedisIoAdapter(
    {} as INestApplicationContext,
    'redis://127.0.0.1:6379',
    30_000,
    25_000,
    262_144,
    [],
    sessionRecovery,
  );
}

describe('SRV-07 — connectionStateRecovery is coupled to the adapter flag', () => {
  let spy: jest.SpyInstance;

  beforeEach(() => {
    spy = jest
      .spyOn(IoAdapter.prototype, 'createIOServer')
      .mockReturnValue({adapter: jest.fn()} as never);
  });
  afterEach(() => {
    spy.mockRestore();
  });

  function mergedOpts(sessionRecovery: boolean): Partial<ServerOptions> {
    build(sessionRecovery).createIOServer(0);
    return spy.mock.calls[0][1] as Partial<ServerOptions>;
  }

  test('flag off → option absent (the stock adapter cannot restore)', () => {
    expect(mergedOpts(false).connectionStateRecovery).toBeUndefined();
  });

  test('flag on → option present with a 2-min window and middlewares ON', () => {
    expect(mergedOpts(true).connectionStateRecovery).toEqual({
      maxDisconnectionDuration: 120_000,
      skipMiddlewares:          false,
    });
  });

  test('unrelated transport options are unchanged in both states', () => {
    for (const flag of [false, true]) {
      spy.mockClear();
      const opts = mergedOpts(flag);
      expect(opts.pingInterval).toBe(30_000);
      expect(opts.pingTimeout).toBe(25_000);
      expect(opts.maxHttpBufferSize).toBe(262_144);
      expect(opts.transports).toEqual(['websocket']);
    }
  });
});

describe('OR-5 — adapter selection reads the ctor flag, not process.env', () => {
  const prev = process.env.WS_SESSION_RECOVERY;

  beforeEach(() => {
    stockFactory.mockClear();
    sessionAwareFactory.mockClear();
  });
  afterEach(async () => {
    if (prev === undefined) delete process.env.WS_SESSION_RECOVERY;
    else process.env.WS_SESSION_RECOVERY = prev;
  });

  test('flag off → stock createAdapter, even with WS_SESSION_RECOVERY=true in the env', async () => {
    process.env.WS_SESSION_RECOVERY = 'true';
    const adapter = build(false);
    await adapter.connectToRedis();

    expect(stockFactory).toHaveBeenCalledTimes(1);
    expect(sessionAwareFactory).not.toHaveBeenCalled();
    await adapter.dispose();
  });

  test('flag on → SessionAware adapter, even with the env var absent', async () => {
    delete process.env.WS_SESSION_RECOVERY;
    const adapter = build(true);
    await adapter.connectToRedis();

    expect(sessionAwareFactory).toHaveBeenCalledTimes(1);
    expect(stockFactory).not.toHaveBeenCalled();
    await adapter.dispose();
  });
});
