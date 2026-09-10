/**
 * OR-5/SRV-07 — SessionAwareRedisAdapter unit tests.
 *
 * This adapter is only installed when WS_SESSION_RECOVERY=true, and when it
 * is, it overrides `broadcast()` for EVERY WS event in the service. It shipped
 * with zero coverage, so these tests pin the three things that matter before
 * anyone flips the flag:
 *
 *   1. the broadcast offset contract (append exactly one trailing string, and
 *      never for ack packets or volatile frames),
 *   2. the restore window (unknown pid / expired session / unknown offset all
 *      fall back to a fresh session), and
 *   3. the Audit P0-6 jti gate — socket.io flushes `missedPackets` inside the
 *      Socket constructor, BEFORE the handshake auth middleware runs, so a
 *      session revoked while the device was offline must not be restorable.
 *      An unreachable Redis fails CLOSED.
 *
 * The RedisAdapter base class is stubbed: these are unit tests of this file's
 * own logic, not of @socket.io/redis-adapter's pub/sub plumbing.
 */
jest.mock('@socket.io/redis-adapter', () => {
  const superBroadcast = jest.fn();
  class FakeRedisAdapter {
    constructor(
      public readonly nsp: unknown,
      public readonly pubClient: unknown,
      public readonly subClient: unknown,
      public readonly opts: unknown,
    ) {}
    broadcast(packet: unknown, opts: unknown): void {
      superBroadcast(packet, opts);
    }
  }
  return {__esModule: true, RedisAdapter: FakeRedisAdapter, __superBroadcast: superBroadcast};
});

import type {Namespace} from 'socket.io';
import type Redis from 'ioredis';
import type {BroadcastOptions, Session} from 'socket.io-adapter';
import {SessionAwareRedisAdapter, createSessionAwareRedisAdapter} from './session-aware-redis-adapter';

const superBroadcast = (jest.requireMock('@socket.io/redis-adapter') as {__superBroadcast: jest.Mock})
  .__superBroadcast;

const WINDOW_MS = 120_000;

interface Harness {
  adapter: SessionAwareRedisAdapter;
  exists:  jest.Mock;
}

function makeHarness(): Harness {
  const exists = jest.fn().mockResolvedValue(1);
  const nsp = {
    name:   '/',
    server: {opts: {connectionStateRecovery: {maxDisconnectionDuration: WINDOW_MS}}},
  } as unknown as Namespace;
  const adapter = new SessionAwareRedisAdapter(
    nsp,
    {exists} as unknown as Redis,
    {} as unknown as Redis,
  );
  return {adapter, exists};
}

function makeSession(pid: string, rooms: string[], jti?: string): Session {
  return {
    sid:           `sid-${pid}`,
    pid,
    rooms,
    data:          jti ? {claims: {jti}, signalDeviceId: 1, sessionId: 'sess'} : {},
    missedPackets: [],
  };
}

/** Broadcasts one event packet and returns the offset the adapter appended. */
function emit(
  adapter: SessionAwareRedisAdapter,
  rooms:   string[] = [],
  except:  string[] = [],
): string {
  const data: unknown[] = ['typing', {conversationId: 'c1'}];
  const opts: BroadcastOptions = {rooms: new Set(rooms), except: new Set(except)};
  adapter.broadcast({type: 2, data}, opts);
  return data[data.length - 1] as string;
}

beforeEach(() => {
  superBroadcast.mockClear();
});

describe('broadcast — offset contract', () => {
  test('appends exactly one trailing string offset and still delegates to RedisAdapter', () => {
    const {adapter} = makeHarness();
    const data: unknown[] = ['typing', {conversationId: 'c1'}];
    const opts: BroadcastOptions = {rooms: new Set(['r1'])};

    adapter.broadcast({type: 2, data}, opts);

    expect(data).toHaveLength(3);
    expect(typeof data[2]).toBe('string');
    expect(superBroadcast).toHaveBeenCalledWith({type: 2, data}, opts);
  });

  test('does not append for an ack packet (packet.id set)', () => {
    const {adapter} = makeHarness();
    const data: unknown[] = ['typing', {conversationId: 'c1'}];

    adapter.broadcast({type: 2, data, id: 7}, {rooms: new Set(['r1'])});

    expect(data).toHaveLength(2);
    expect(superBroadcast).toHaveBeenCalledTimes(1);
  });

  test('does not append for a volatile frame', () => {
    const {adapter} = makeHarness();
    const data: unknown[] = ['presence', {online: true}];

    adapter.broadcast({type: 2, data}, {rooms: new Set(['r1']), flags: {volatile: true}});

    expect(data).toHaveLength(2);
    expect(superBroadcast).toHaveBeenCalledTimes(1);
  });

  test('does not append for a non-event packet type', () => {
    const {adapter} = makeHarness();
    const data: unknown[] = ['ignored'];

    adapter.broadcast({type: 4, data}, {rooms: new Set(['r1'])});

    expect(data).toHaveLength(1);
  });

  test('every offset is unique even within the same millisecond', () => {
    const {adapter} = makeHarness();
    const ids = [emit(adapter), emit(adapter), emit(adapter), emit(adapter)];
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('restoreSession — window + packet selection', () => {
  test('returns the packets emitted after the offset, filtered by rooms and except', async () => {
    const {adapter} = makeHarness();
    const o1 = emit(adapter, ['r1']);
    adapter.persistSession(makeSession('pid1', ['r1'], 'jti-1'));
    emit(adapter, ['r1']);          // included
    emit(adapter, ['r2']);          // other room → excluded
    emit(adapter, [], ['r1']);      // broadcast-to-all but excepting r1 → excluded

    const restored = await adapter.restoreSession('pid1', o1);

    expect(restored).not.toBeNull();
    expect(restored.pid).toBe('pid1');
    expect(restored.missedPackets).toHaveLength(1);
  });

  test('returns null for an unknown pid', async () => {
    const {adapter} = makeHarness();
    const o1 = emit(adapter, ['r1']);
    expect(await adapter.restoreSession('never-seen', o1)).toBeNull();
  });

  test('returns null and evicts once the disconnect window has elapsed', async () => {
    const {adapter} = makeHarness();
    const o1 = emit(adapter, ['r1']);
    adapter.persistSession(makeSession('pid1', ['r1'], 'jti-1'));

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + WINDOW_MS + 1);
    try {
      expect(await adapter.restoreSession('pid1', o1)).toBeNull();
    } finally {
      nowSpy.mockRestore();
    }
    // evicted — even back inside the window the pid is gone
    expect(await adapter.restoreSession('pid1', o1)).toBeNull();
  });

  test('returns null for an empty offset (first connect / post-install)', async () => {
    const {adapter} = makeHarness();
    adapter.persistSession(makeSession('pid1', ['r1'], 'jti-1'));
    expect(await adapter.restoreSession('pid1', '')).toBeNull();
  });

  test('returns null for an offset older than the retention window', async () => {
    const {adapter} = makeHarness();
    adapter.persistSession(makeSession('pid1', ['r1'], 'jti-1'));
    emit(adapter, ['r1']);
    expect(await adapter.restoreSession('pid1', 'long-since-gc-ed')).toBeNull();
  });
});

describe('Audit P0-6 — revoked jti cannot restore a buffered session', () => {
  test('jti still in the allowlist → session restored, checked against jti:<jti>', async () => {
    const {adapter, exists} = makeHarness();
    const o1 = emit(adapter, ['r1']);
    adapter.persistSession(makeSession('pid1', ['r1'], 'jti-1'));
    emit(adapter, ['r1']);

    const restored = await adapter.restoreSession('pid1', o1);

    expect(restored).not.toBeNull();
    expect(exists).toHaveBeenCalledWith('jti:jti-1');
  });

  test('jti revoked while offline → null and the pid is evicted', async () => {
    const {adapter, exists} = makeHarness();
    exists.mockResolvedValue(0);
    const o1 = emit(adapter, ['r1']);
    adapter.persistSession(makeSession('pid1', ['r1'], 'jti-1'));
    emit(adapter, ['r1']);

    expect(await adapter.restoreSession('pid1', o1)).toBeNull();

    // evicted — a later allowlist hit must not resurrect the buffered session
    exists.mockResolvedValue(1);
    expect(await adapter.restoreSession('pid1', o1)).toBeNull();
  });

  test('redis throwing fails CLOSED', async () => {
    const {adapter, exists} = makeHarness();
    exists.mockRejectedValue(new Error('ECONNREFUSED'));
    const o1 = emit(adapter, ['r1']);
    adapter.persistSession(makeSession('pid1', ['r1'], 'jti-1'));
    emit(adapter, ['r1']);

    expect(await adapter.restoreSession('pid1', o1)).toBeNull();
  });

  test('a session with no claims.jti is never restorable', async () => {
    const {adapter, exists} = makeHarness();
    const o1 = emit(adapter, ['r1']);
    adapter.persistSession(makeSession('pid1', ['r1']));
    emit(adapter, ['r1']);

    expect(await adapter.restoreSession('pid1', o1)).toBeNull();
    expect(exists).not.toHaveBeenCalled();
  });
});

describe('diagnostics', () => {
  test('persist + restore emit no console output', async () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const {adapter} = makeHarness();
      const o1 = emit(adapter, ['r1']);
      adapter.persistSession(makeSession('pid1', ['r1'], 'jti-1'));
      emit(adapter, ['r1']);
      await adapter.restoreSession('pid1', o1);
      await adapter.restoreSession('unknown', o1);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('createSessionAwareRedisAdapter', () => {
  test('matches createAdapter\'s factory shape (nsp → adapter instance)', () => {
    const nsp = {
      name:   '/',
      server: {opts: {connectionStateRecovery: {maxDisconnectionDuration: WINDOW_MS}}},
    } as unknown as Namespace;
    const factory = createSessionAwareRedisAdapter({} as unknown as Redis, {} as unknown as Redis);
    expect(factory(nsp)).toBeInstanceOf(SessionAwareRedisAdapter);
  });
});
