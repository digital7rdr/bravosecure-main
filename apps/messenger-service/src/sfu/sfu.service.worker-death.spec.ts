import {EventEmitter} from 'node:events';
import {ServiceUnavailableException} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {SfuService} from './sfu.service';
import type {SfuWorkerPool} from './sfuWorkerPool';

/**
 * P2-1 / P3(announced-ip) / P3(transport-leak) — SFU crash-recovery &
 * boot-safety hardening. All three are pure orchestration logic (no real
 * mediasoup C++ worker), so we drive them with fake Routers/Transports and
 * inject config directly.
 *
 *   • P2-1        — a dead mediasoup Worker closes every Router on it out
 *                   from under us; the room registry must self-reconcile
 *                   (via router.observer 'close') so a rejoin rebuilds a
 *                   FRESH room on a healthy worker instead of hitting a
 *                   corpse whose createWebRtcTransport throws.
 *   • announced   — a NAT deploy with no SFU_ANNOUNCED_IP announces
 *                   unroutable ICE candidates → 100% cross-NAT call
 *                   failure. In production the plane must fail closed.
 *   • transport   — joinRoom must not leak the send transport when the
 *                   recv transport creation throws.
 */
describe('SfuService — worker-death reconciliation & boot safety', () => {
  type FakeRouter = {
    id: string;
    rtpCapabilities: {codecs: unknown[]; headerExtensions: unknown[]};
    observer: EventEmitter;
    closed: boolean;
    close: jest.Mock;
    createWebRtcTransport?: jest.Mock;
  };

  function makeRouter(): FakeRouter {
    const observer = new EventEmitter();
    const router: FakeRouter = {
      id: 'router-' + Math.random().toString(16).slice(2),
      rtpCapabilities: {codecs: [], headerExtensions: []},
      observer,
      closed: false,
      close: jest.fn(() => {
        // Mirror mediasoup: close() fires the observer 'close' event.
        if (router.closed) return;
        router.closed = true;
        observer.emit('close');
      }),
    };
    return router;
  }

  function makeCfg(map: Record<string, unknown> = {}): ConfigService {
    return {get: (k: string) => map[k]} as unknown as ConfigService;
  }

  /** Pool that mints a fresh fake Router per createRouter() call, tracked. */
  function makePool(created: FakeRouter[]): SfuWorkerPool {
    return {
      createRouter: jest.fn(async () => {
        const r = makeRouter();
        created.push(r);
        return r;
      }),
    } as unknown as SfuWorkerPool;
  }

  function withBroadcast(svc: SfuService): jest.Mock {
    const toRoom = jest.fn();
    (svc as unknown as {broadcastToRoom: unknown}).broadcastToRoom = toRoom;
    return toRoom;
  }

  function seedParticipant(svc: SfuService, roomId: string, tag: string, userId: string): void {
    const participants = (svc as unknown as {participants: Map<string, unknown>}).participants;
    const rooms = (svc as unknown as {rooms: Map<string, {participantTags: Set<string>}>}).rooms;
    participants.set(tag, {tag, userId, roomId, producers: new Map(), consumers: new Map()});
    rooms.get(roomId)!.participantTags.add(tag);
  }

  // ── P2-1: worker death purges the room so rejoin rebuilds ────────────

  it('purges the room + participants and fans sfu.room.ended(worker_died) when the router dies', async () => {
    const created: FakeRouter[] = [];
    const svc = new SfuService(makePool(created), makeCfg());
    const toRoom = withBroadcast(svc);

    const {roomId} = await svc.createRoom({conversationId: 'cid-1', hostUserId: 'u1'});
    seedParticipant(svc, roomId, 'tag-a', 'u1');
    seedParticipant(svc, roomId, 'tag-b', 'u2');

    // Worker dies → mediasoup closes the router → observer 'close' fires.
    created[0].observer.emit('close');

    const rooms = (svc as unknown as {rooms: Map<string, unknown>}).rooms;
    const participants = (svc as unknown as {participants: Map<string, unknown>}).participants;
    expect(rooms.has(roomId)).toBe(false);
    expect(participants.has('tag-a')).toBe(false);
    expect(participants.has('tag-b')).toBe(false);
    expect(toRoom).toHaveBeenCalledWith(roomId, {
      event: 'sfu.room.ended',
      data:  {roomId, reason: 'worker_died'},
    });
  });

  it('drops the conversation index so a rejoin creates a FRESH room on a healthy worker', async () => {
    const created: FakeRouter[] = [];
    const svc = new SfuService(makePool(created), makeCfg());
    withBroadcast(svc);

    const first = await svc.createRoom({conversationId: 'cid-1', hostUserId: 'u1'});
    seedParticipant(svc, first.roomId, 'tag-a', 'u1');

    // Kill the worker backing the first room.
    created[0].observer.emit('close');

    // The stale room must NOT be handed back to the next caller.
    expect(svc.findRoomForConversation('cid-1')).toBeNull();

    // A rejoin creates a brand-new room on a fresh (healthy) router.
    const second = await svc.createRoom({conversationId: 'cid-1', hostUserId: 'u1'});
    expect(second.roomId).not.toEqual(first.roomId);
    expect(created).toHaveLength(2);
    const rooms = (svc as unknown as {rooms: Map<string, {router: FakeRouter}>}).rooms;
    expect(rooms.get(second.roomId)!.router).toBe(created[1]);
  });

  it('is idempotent — an intentional last-participant leave does not fire worker_died', async () => {
    const created: FakeRouter[] = [];
    const svc = new SfuService(makePool(created), makeCfg());
    const toRoom = withBroadcast(svc);

    const {roomId} = await svc.createRoom({conversationId: 'cid-1', hostUserId: 'u1'});
    // Seed a full participant with closable resources for leaveRoom.
    const participants = (svc as unknown as {participants: Map<string, unknown>}).participants;
    const rooms = (svc as unknown as {rooms: Map<string, {participantTags: Set<string>}>}).rooms;
    participants.set('tag-a', {
      tag: 'tag-a', userId: 'u1', roomId,
      producers: new Map(), consumers: new Map(),
      sendTransport: {close: jest.fn()},
      recvTransport: {close: jest.fn()},
    });
    rooms.get(roomId)!.participantTags.add('tag-a');

    // Intentional leave deletes the room BEFORE closing the router, so the
    // resulting observer 'close' is a no-op (room already gone).
    await svc.leaveRoom('tag-a');

    expect(rooms.has(roomId)).toBe(false);
    expect(created[0].close).toHaveBeenCalledTimes(1);
    // No worker_died frame — the leave was intentional.
    const firedWorkerDied = toRoom.mock.calls.some(
      ([, frame]) => (frame as {data?: {reason?: string}})?.data?.reason === 'worker_died',
    );
    expect(firedWorkerDied).toBe(false);
  });

  // ── P3: announced-IP boot validation (fail closed in prod) ───────────

  it('fails closed in production when SFU_ANNOUNCED_IP is unset', async () => {
    const prev = process.env['SFU_ALLOW_UNANNOUNCED'];
    delete process.env['SFU_ALLOW_UNANNOUNCED'];
    try {
      const svc = new SfuService(makePool([]), makeCfg({nodeEnv: 'production', 'sfu.announcedIp': undefined}));
      svc.onModuleInit();
      await expect(svc.createRoom({conversationId: 'c', hostUserId: 'u1'}))
        .rejects.toThrow(ServiceUnavailableException);
      svc.onModuleDestroy();
    } finally {
      if (prev === undefined) delete process.env['SFU_ALLOW_UNANNOUNCED'];
      else process.env['SFU_ALLOW_UNANNOUNCED'] = prev;
    }
  });

  it('fails closed in production when SFU_ANNOUNCED_IP is 0.0.0.0', async () => {
    const prev = process.env['SFU_ALLOW_UNANNOUNCED'];
    delete process.env['SFU_ALLOW_UNANNOUNCED'];
    try {
      const svc = new SfuService(makePool([]), makeCfg({nodeEnv: 'production', 'sfu.announcedIp': '0.0.0.0'}));
      svc.onModuleInit();
      await expect(svc.createRoom()).rejects.toThrow(ServiceUnavailableException);
      svc.onModuleDestroy();
    } finally {
      if (prev === undefined) delete process.env['SFU_ALLOW_UNANNOUNCED'];
      else process.env['SFU_ALLOW_UNANNOUNCED'] = prev;
    }
  });

  it('SFU_ALLOW_UNANNOUNCED=1 keeps the plane enabled in production (host-network override)', async () => {
    const prev = process.env['SFU_ALLOW_UNANNOUNCED'];
    process.env['SFU_ALLOW_UNANNOUNCED'] = '1';
    try {
      const created: FakeRouter[] = [];
      const svc = new SfuService(makePool(created), makeCfg({nodeEnv: 'production', 'sfu.announcedIp': undefined}));
      withBroadcast(svc);
      svc.onModuleInit();
      await expect(svc.createRoom({hostUserId: 'u1'})).resolves.toMatchObject({roomId: expect.any(String)});
      svc.onModuleDestroy();
    } finally {
      if (prev === undefined) delete process.env['SFU_ALLOW_UNANNOUNCED'];
      else process.env['SFU_ALLOW_UNANNOUNCED'] = prev;
    }
  });

  it('a routable announced IP in production enables the plane normally', async () => {
    const created: FakeRouter[] = [];
    const svc = new SfuService(makePool(created), makeCfg({nodeEnv: 'production', 'sfu.announcedIp': '203.0.113.7'}));
    withBroadcast(svc);
    svc.onModuleInit();
    await expect(svc.createRoom({hostUserId: 'u1'})).resolves.toMatchObject({roomId: expect.any(String)});
    svc.onModuleDestroy();
  });

  it('non-production tolerates an unset announced IP (dev/test)', async () => {
    const svc = new SfuService(makePool([]), makeCfg({nodeEnv: 'development', 'sfu.announcedIp': undefined}));
    withBroadcast(svc);
    svc.onModuleInit();
    await expect(svc.createRoom({hostUserId: 'u1'})).resolves.toMatchObject({roomId: expect.any(String)});
    svc.onModuleDestroy();
  });

  // ── P3: joinRoom must not leak the send transport on recv failure ────

  it('closes the send transport when the recv transport creation throws', async () => {
    const svc = new SfuService(makePool([]), makeCfg());
    const roomId = 'room-x';
    const sendT = {id: 'send-tx', iceParameters: {}, iceCandidates: [], dtlsParameters: {}, close: jest.fn()};
    const recvErr = new Error('recv transport boom');
    const router = makeRouter();
    router.createWebRtcTransport = jest.fn()
      .mockResolvedValueOnce(sendT)
      .mockRejectedValueOnce(recvErr);

    (svc as unknown as {rooms: Map<string, unknown>}).rooms.set(roomId, {
      router,
      participantTags: new Set<string>(),
      createdAt: Date.now(),
    });

    await expect(svc.joinRoom(roomId, 'u1')).rejects.toThrow('recv transport boom');
    // The already-built send transport is torn down, not leaked.
    expect(sendT.close).toHaveBeenCalledTimes(1);
    // And no half-built participant is left registered.
    expect((svc as unknown as {participants: Map<string, unknown>}).participants.size).toBe(0);
  });
});
