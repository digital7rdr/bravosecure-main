import {EventEmitter} from 'node:events';
import {ConfigService} from '@nestjs/config';
import {SfuService} from './sfu.service';
import type {SfuWorkerPool} from './sfuWorkerPool';

/**
 * B-238 — stale/ended room leaking into the new-call path.
 *
 * Repro (founder-visible as "I call back and nothing happens"): the HOST
 * hangs up while ringing, BEFORE completing sfu.join. The client fires
 * `sfu.ring.cancel` + `sfu.leave`, but with zero participants the leave
 * matches no tag server-side, so the room survives with `hostUserId`
 * pointing at the departed host. A MEMBER calling back then resolves the
 * corpse — via the by-conversation index or the createRoom idempotency
 * check — joins it as a non-host, and their own `sfu.ring` is refused
 * with `not_host`.
 *
 * Contract under test:
 *   1. A member's createRoom must yield a room THEY host once the
 *      previous room is dead (host-cancelled, or 0-participant past the
 *      fresh-room setup grace).
 *   2. Idempotent reuse is UNCHANGED for live rooms (participants > 0)
 *      and for fresh rooms inside the setup grace (simultaneous-tap
 *      dedup) — the fix only stops DEAD rooms from being handed out.
 */
describe('SfuService — stale-room resolution after host hang-up (B-238)', () => {
  type FakeRouter = {
    id: string;
    rtpCapabilities: {codecs: unknown[]; headerExtensions: unknown[]};
    observer: EventEmitter;
    closed: boolean;
    close: jest.Mock;
  };

  function makeRouter(): FakeRouter {
    const observer = new EventEmitter();
    const router: FakeRouter = {
      id: 'router-' + Math.random().toString(16).slice(2),
      rtpCapabilities: {codecs: [], headerExtensions: []},
      observer,
      closed: false,
      close: jest.fn(() => {
        if (router.closed) return;
        router.closed = true;
        observer.emit('close');
      }),
    };
    return router;
  }

  function makePool(created: FakeRouter[]): SfuWorkerPool {
    return {
      createRouter: jest.fn(async () => {
        const r = makeRouter();
        created.push(r);
        return r;
      }),
    } as unknown as SfuWorkerPool;
  }

  function makeService(created: FakeRouter[]): SfuService {
    const cfg = {get: () => undefined} as unknown as ConfigService;
    const svc = new SfuService(makePool(created), cfg);
    (svc as unknown as {broadcastToRoom: unknown}).broadcastToRoom = jest.fn();
    return svc;
  }

  function rooms(svc: SfuService): Map<string, {participantTags: Set<string>; createdAt: number}> {
    return (svc as unknown as {rooms: Map<string, {participantTags: Set<string>; createdAt: number}>}).rooms;
  }

  function backdate(svc: SfuService, roomId: string, byMs: number): void {
    const room = rooms(svc).get(roomId)!;
    room.createdAt -= byMs;
  }

  function seedTag(svc: SfuService, roomId: string, tag: string, userId: string): void {
    const participants = (svc as unknown as {participants: Map<string, unknown>}).participants;
    participants.set(tag, {tag, userId, roomId, producers: new Map(), consumers: new Map()});
    rooms(svc).get(roomId)!.participantTags.add(tag);
  }

  it('member createRoom after the host-abandoned room passes setup grace yields a fresh room they host', async () => {
    const created: FakeRouter[] = [];
    const svc = makeService(created);

    const first = await svc.createRoom({conversationId: 'cid-1', hostUserId: 'host'});
    // Host hung up mid-ring without ever joining — sfu.leave matched no
    // tag, so nothing tore the room down. The member calls back after
    // the 30s fresh-room setup grace has elapsed.
    backdate(svc, first.roomId, 31_000);

    const second = await svc.createRoom({conversationId: 'cid-1', hostUserId: 'member'});

    expect(second.roomId).not.toBe(first.roomId);
    expect(svc.hostOf(second.roomId)).toBe('member');
    // The corpse was reaped, not left to leak.
    expect(rooms(svc).has(first.roomId)).toBe(false);
    expect(created[0].close).toHaveBeenCalled();
  });

  it('member start after the host cancelled the ring (hung up before joining) creates a fresh room they host', async () => {
    const created: FakeRouter[] = [];
    const svc = makeService(created);

    const first = await svc.createRoom({conversationId: 'cid-1', hostUserId: 'host'});
    // Host taps End while ringing — the gateway's admitted sfu.ring.cancel
    // path ends the still-empty room.
    expect(svc.endRoomIfEmptyByHost(first.roomId, 'host')).toBe(true);

    // The by-conversation probe no longer resolves the ended room…
    expect(svc.findRoomForConversation('cid-1')).toBeNull();
    expect(rooms(svc).has(first.roomId)).toBe(false);
    expect(created[0].close).toHaveBeenCalled();

    // …so the member's call-back creates a fresh room where THEY are host
    // (their subsequent sfu.ring passes the C3 host check).
    const second = await svc.createRoom({conversationId: 'cid-1', hostUserId: 'member'});
    expect(second.roomId).not.toBe(first.roomId);
    expect(svc.hostOf(second.roomId)).toBe('member');
  });

  it('endRoomIfEmptyByHost refuses non-hosts, live rooms, and unknown rooms', async () => {
    const created: FakeRouter[] = [];
    const svc = makeService(created);

    const {roomId} = await svc.createRoom({conversationId: 'cid-1', hostUserId: 'host'});

    // Only the host may end their (empty) room.
    expect(svc.endRoomIfEmptyByHost(roomId, 'member')).toBe(false);
    expect(rooms(svc).has(roomId)).toBe(true);

    // A room with participants is a LIVE call — a partial ring-cancel
    // (host in-call, cancelling one outstanding ringee) must not end it.
    seedTag(svc, roomId, 'tag-host', 'host');
    expect(svc.endRoomIfEmptyByHost(roomId, 'host')).toBe(false);
    expect(rooms(svc).has(roomId)).toBe(true);
    expect(svc.hostOf(roomId)).toBe('host');

    expect(svc.endRoomIfEmptyByHost('no-such-room', 'host')).toBe(false);
  });

  it('keeps idempotent reuse while the call is LIVE — a member create returns the host\'s room', async () => {
    const created: FakeRouter[] = [];
    const svc = makeService(created);

    const first = await svc.createRoom({conversationId: 'cid-1', hostUserId: 'host'});
    seedTag(svc, first.roomId, 'tag-host', 'host');
    backdate(svc, first.roomId, 31_000); // liveness comes from participants, not age

    const second = await svc.createRoom({conversationId: 'cid-1', hostUserId: 'member'});

    expect(second.roomId).toBe(first.roomId);
    expect(svc.hostOf(first.roomId)).toBe('host'); // host authority unchanged
    expect(created).toHaveLength(1);
  });

  it('keeps idempotent reuse inside the setup grace — simultaneous-tap dedup returns the same room', async () => {
    const created: FakeRouter[] = [];
    const svc = makeService(created);

    const first = await svc.createRoom({conversationId: 'cid-1', hostUserId: 'host'});
    const second = await svc.createRoom({conversationId: 'cid-1', hostUserId: 'member'});

    expect(second.roomId).toBe(first.roomId);
    expect(svc.hostOf(first.roomId)).toBe('host');
    expect(created).toHaveLength(1);
  });
});
