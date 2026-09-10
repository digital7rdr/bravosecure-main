import {ForbiddenException} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {SfuService} from './sfu.service';
import type {SfuWorkerPool} from './sfuWorkerPool';

/**
 * Room participant cap — raised 6 → 10 (2026-07). Contract under test:
 *
 *   1. The 11th distinct user is refused with a typed `room_full`
 *      ForbiddenException (the gateway surfaces it verbatim; the client
 *      maps it to the 'full' blocking state).
 *   2. The 10th distinct user is admitted — the cap is >= not >.
 *   3. Audit SFU-05 ordering holds at the new cap: a rejoin by a user
 *      who already holds a slot supersedes their stale participant
 *      BEFORE the cap check, so a legit rejoin at cap is never
 *      rejected as full and the room never exceeds the cap.
 */
describe('SfuService.joinRoom participant cap', () => {
  const CAP = 10;

  type FakeTransport = {
    id: string;
    iceParameters: object;
    iceCandidates: unknown[];
    dtlsParameters: object;
    close: jest.Mock;
  };

  function makeTransport(id: string): FakeTransport {
    return {id, iceParameters: {}, iceCandidates: [], dtlsParameters: {}, close: jest.fn()};
  }

  function makeService(): {svc: SfuService; toRoom: jest.Mock} {
    const pool = {} as unknown as SfuWorkerPool;
    const cfg = {get: () => undefined} as unknown as ConfigService;
    const svc = new SfuService(pool, cfg);
    const toRoom = jest.fn();
    (svc as unknown as {broadcastToRoom: unknown}).broadcastToRoom = toRoom;
    let txSeq = 0;
    (svc as unknown as {createWebRtcTransport: () => Promise<FakeTransport>}).createWebRtcTransport =
      jest.fn(async () => makeTransport(`tx-${++txSeq}`));
    return {svc, toRoom};
  }

  function seedRoom(svc: SfuService, roomId: string, tags: string[]): void {
    const rooms = (svc as unknown as {
      rooms: Map<string, {router: object; participantTags: Set<string>; hostUserId?: string; createdAt: number}>;
    }).rooms;
    rooms.set(roomId, {
      router: {rtpCapabilities: {codecs: []}},
      participantTags: new Set(tags),
      hostUserId: 'host-user',
      createdAt: 0,
    });
  }

  function seedParticipant(svc: SfuService, tag: string, userId: string, roomId: string): void {
    const participants = (svc as unknown as {
      participants: Map<string, object>;
    }).participants;
    participants.set(tag, {
      tag,
      userId,
      roomId,
      sendTransport: makeTransport(`${tag}-send`),
      recvTransport: makeTransport(`${tag}-recv`),
      producers: new Map(),
      consumers: new Map(),
    });
  }

  function tags(n: number): string[] {
    return Array.from({length: n}, (_, i) => `tag-${i}`);
  }

  it(`refuses the ${CAP + 1}th distinct user with room_full`, async () => {
    const {svc} = makeService();
    seedRoom(svc, 'room-1', tags(CAP));

    await expect(svc.joinRoom('room-1', 'user-new')).rejects.toThrow(ForbiddenException);
    await expect(svc.joinRoom('room-1', 'user-new')).rejects.toThrow('room_full');
  });

  it(`admits the ${CAP}th distinct user`, async () => {
    const {svc} = makeService();
    seedRoom(svc, 'room-1', tags(CAP - 1));

    const res = await svc.joinRoom('room-1', 'user-new');

    expect(res.participantTag).toEqual(expect.any(String));
    const rooms = (svc as unknown as {rooms: Map<string, {participantTags: Set<string>}>}).rooms;
    expect(rooms.get('room-1')!.participantTags.size).toBe(CAP);
  });

  it('supersedes a stale same-user slot before the cap check (rejoin at cap succeeds)', async () => {
    const {svc, toRoom} = makeService();
    seedRoom(svc, 'room-1', tags(CAP));
    seedParticipant(svc, 'tag-0', 'user-rejoin', 'room-1');

    const res = await svc.joinRoom('room-1', 'user-rejoin');

    expect(res.participantTag).not.toBe('tag-0');
    const rooms = (svc as unknown as {rooms: Map<string, {participantTags: Set<string>}>}).rooms;
    expect(rooms.get('room-1')!.participantTags.size).toBe(CAP);
    expect(rooms.get('room-1')!.participantTags.has('tag-0')).toBe(false);
    expect(toRoom).toHaveBeenCalledWith('room-1', {
      event: 'sfu.participant.left',
      data: {roomId: 'room-1', participantTag: 'tag-0'},
    }, 'tag-0');
  });
});

/**
 * WI-6.4 — GENUINELY CONCURRENT joins. The old spec was sequential-only,
 * which is exactly why the cap/host races shipped: the check and the
 * `participantTags.add` were separated by two awaited createWebRtcTransport
 * calls, so two joins interleaved between them. The service now RESERVES the
 * slot (room.pendingJoins) before any await, and rolls the reservation (and a
 * claimed host) back on transport failure.
 */
describe('WI-6.4 — concurrent join-cap and host election', () => {
  const CAP = 10;

  type Gate = {resolve: () => void; fail: (e: Error) => void};

  /**
   * Service whose transports hang until the test releases them. Each join
   * creates its SEND gate immediately and its RECV gate only after the send
   * resolves, so `pump` runs release rounds until no new gates appear —
   * failing the gate indexes the test names and resolving the rest.
   */
  function makeGatedService(): {svc: SfuService; gates: Gate[]; pump: (failIdxs?: number[]) => Promise<void>} {
    const pool = {} as unknown as SfuWorkerPool;
    const cfg = {get: () => undefined} as unknown as ConfigService;
    const svc = new SfuService(pool, cfg);
    (svc as unknown as {broadcastToRoom: unknown}).broadcastToRoom = jest.fn();
    const gates: Gate[] = [];
    let txSeq = 0;
    (svc as unknown as {createWebRtcTransport: () => Promise<unknown>}).createWebRtcTransport =
      jest.fn(() => new Promise((resolve, reject) => {
        const id = `tx-${++txSeq}`;
        gates.push({
          resolve: () => resolve({id, iceParameters: {}, iceCandidates: [], dtlsParameters: {}, close: jest.fn()}),
          fail:    (e: Error) => reject(e),
        });
      }));
    let cursor = 0;
    const pump = async (failIdxs: number[] = []): Promise<void> => {
      const fails = new Set(failIdxs);
      for (let round = 0; round < 30; round++) {
        while (cursor < gates.length) {
          const i = cursor++;
          if (fails.has(i)) {gates[i].fail(new Error('worker died'));} else {gates[i].resolve();}
        }
        await tick();
      }
    };
    return {svc, gates, pump};
  }

  function seedRoom(svc: SfuService, roomId: string, tags: string[], hostUserId?: string): void {
    const rooms = (svc as unknown as {
      rooms: Map<string, {router: object; participantTags: Set<string>; hostUserId?: string; createdAt: number}>;
    }).rooms;
    rooms.set(roomId, {
      router: {rtpCapabilities: {codecs: []}},
      participantTags: new Set(tags),
      hostUserId,
      createdAt: 0,
    });
    const participants = (svc as unknown as {participants: Map<string, object>}).participants;
    for (const tag of tags) {
      participants.set(tag, {
        tag, userId: `seed-${tag}`, roomId,
        sendTransport: {close: jest.fn()}, recvTransport: {close: jest.fn()},
        producers: new Map(), consumers: new Map(),
      });
    }
  }

  const tick = () => new Promise<void>(r => setImmediate(r));

  it('two concurrent joins at the last slot: the second is refused room_full BEFORE the first resolves', async () => {
    const {svc, gates, pump} = makeGatedService();
    seedRoom(svc, 'room-c', Array.from({length: CAP - 1}, (_, i) => `t-${i}`), 'seed-t-0');

    const a = svc.joinRoom('room-c', 'user-A');
    await tick(); // A has reserved and is awaiting its transports
    // B must be refused NOW — pre-fix both passed at size CAP-1.
    await expect(svc.joinRoom('room-c', 'user-B')).rejects.toThrow('room_full');

    await pump();
    const resA = await a;
    expect(resA.participantTag).toEqual(expect.any(String));
    const rooms = (svc as unknown as {rooms: Map<string, {participantTags: Set<string>}>}).rooms;
    expect(rooms.get('room-c')!.participantTags.size).toBe(CAP);
  });

  it('a failed join rolls its reservation back — the slot is reusable', async () => {
    const {svc, gates, pump} = makeGatedService();
    seedRoom(svc, 'room-r', Array.from({length: CAP - 1}, (_, i) => `t-${i}`), 'seed-t-0');

    const a = svc.joinRoom('room-r', 'user-A');
    a.catch(() => { /* pre-attach: the rejection fires inside pump, before the expect */ });
    await tick();
    await pump([0]);
    await expect(a).rejects.toThrow('worker died');

    const rooms = (svc as unknown as {rooms: Map<string, {participantTags: Set<string>; pendingJoins?: Map<string, string>}>}).rooms;
    expect(rooms.get('room-r')!.pendingJoins?.size ?? 0).toBe(0);

    // The freed slot admits the next joiner.
    const b = svc.joinRoom('room-r', 'user-B');
    await pump();
    await expect(b).resolves.toMatchObject({participantTag: expect.any(String)});
  });

  it('two simultaneous FIRST joiners: only the first reserver claims host', async () => {
    const {svc, gates, pump} = makeGatedService();
    seedRoom(svc, 'room-h', []);

    const a = svc.joinRoom('room-h', 'user-A');
    await tick();
    const b = svc.joinRoom('room-h', 'user-B');
    await tick();
    await pump();
    const [resA, resB] = await Promise.all([a, b]);
    expect(resA.isHost).toBe(true);
    expect(resB.isHost).toBe(false);
    expect(svc.hostOf('room-h')).toBe('user-A');
  });

  it('a failed host-claiming join hands the claim to the concurrent second joiner', async () => {
    const {svc, gates, pump} = makeGatedService();
    seedRoom(svc, 'room-f', []);

    const a = svc.joinRoom('room-f', 'user-A'); // claims host, reserves
    a.catch(() => { /* pre-attach — rejection fires inside pump */ });
    await tick();
    const b = svc.joinRoom('room-f', 'user-B'); // defers to A's claim
    await tick();
    // A's transports die; B's succeed.
    await pump([0]);
    await expect(a).rejects.toThrow('worker died');
    const resB = await b;

    // Server-side authority lands on B — the room is never hostless (which
    // would kill the call-key mint and the ring-cancel authority outright).
    expect(svc.hostOf('room-f')).toBe('user-B');
    // Honest residual: B's OWN ack said isHost:false when the claim was
    // still A's — a documented client/server divergence, strictly better
    // than a hostless room. Pin the current truth so a change is loud.
    expect(resB.isHost).toBe(true); // B completed AFTER the handoff, so the ack is right here
  });

  it('a lone failed first joiner leaves the room hostless for a clean re-election', async () => {
    const {svc, gates, pump} = makeGatedService();
    seedRoom(svc, 'room-l', []);

    const a = svc.joinRoom('room-l', 'user-A');
    a.catch(() => { /* pre-attach — rejection fires inside pump */ });
    await tick();
    await pump([0]);
    await expect(a).rejects.toThrow('worker died');
    expect(svc.hostOf('room-l')).toBeNull();

    // Next joiner elects cleanly.
    const b = svc.joinRoom('room-l', 'user-B');
    await pump();
    await expect(b).resolves.toMatchObject({isHost: true});
    expect(svc.hostOf('room-l')).toBe('user-B');
  });

  it('endRoomIfEmptyByHost refuses while a reservation is in flight', async () => {
    const {svc, gates, pump} = makeGatedService();
    seedRoom(svc, 'room-e', [], 'host-x');

    const join = svc.joinRoom('room-e', 'user-J');
    await tick();
    expect(svc.endRoomIfEmptyByHost('room-e', 'host-x')).toBe(false); // mid-admission

    await pump();
    await join;
    expect(svc.endRoomIfEmptyByHost('room-e', 'host-x')).toBe(false); // now occupied
  });
});

/**
 * KO-3/4/5/6 (B-566) — the reservation lifecycle hardening:
 * leaveRoom counts reservations as occupancy; a wedged reservation ages out
 * (TTL) instead of pinning the room or a cap slot; a same-user retry
 * supersedes the old reservation and the superseded join SELF-ABORTS at its
 * post-transport re-check; a host handoff notifies the room.
 */
describe('KO-3/4/5/6 — reservation lifecycle (B-566)', () => {
  const CAP = 10;
  const tick = () => new Promise<void>(r => setImmediate(r));

  function makeGated() {
    const pool = {} as unknown as SfuWorkerPool;
    const cfg = {get: () => undefined} as unknown as ConfigService;
    const svc = new SfuService(pool, cfg);
    const toRoom = jest.fn();
    (svc as unknown as {broadcastToRoom: unknown}).broadcastToRoom = toRoom;
    const gates: Array<{resolve: () => void; fail: (e: Error) => void}> = [];
    let txSeq = 0;
    (svc as unknown as {createWebRtcTransport: () => Promise<unknown>}).createWebRtcTransport =
      jest.fn(() => new Promise((resolve, reject) => {
        const id = `tx-${++txSeq}`;
        gates.push({
          resolve: () => resolve({id, iceParameters: {}, iceCandidates: [], dtlsParameters: {}, close: jest.fn()}),
          fail:    (e: Error) => reject(e),
        });
      }));
    let cursor = 0;
    const pump = async (failIdxs: number[] = []): Promise<void> => {
      const fails = new Set(failIdxs);
      for (let round = 0; round < 30; round++) {
        while (cursor < gates.length) {
          const i = cursor++;
          if (fails.has(i)) {gates[i].fail(new Error('worker died'));} else {gates[i].resolve();}
        }
        await tick();
      }
    };
    return {svc, toRoom, pump};
  }

  function seedRoom(svc: SfuService, roomId: string, tagNames: string[], hostUserId?: string): void {
    const rooms = (svc as unknown as {
      rooms: Map<string, {router: object; participantTags: Set<string>; hostUserId?: string; createdAt: number; pendingJoins?: Map<string, {userId: string; at: number}>}>;
    }).rooms;
    rooms.set(roomId, {
      router: {rtpCapabilities: {codecs: []}, close: jest.fn()},
      participantTags: new Set(tagNames),
      hostUserId,
      createdAt: 0,
    });
    const participants = (svc as unknown as {participants: Map<string, object>}).participants;
    for (const tag of tagNames) {
      participants.set(tag, {
        tag, userId: `seed-${tag}`, roomId,
        sendTransport: {close: jest.fn()}, recvTransport: {close: jest.fn()},
        producers: new Map(), consumers: new Map(),
      });
    }
  }
  const roomsOf = (svc: SfuService) =>
    (svc as unknown as {rooms: Map<string, {participantTags: Set<string>; pendingJoins?: Map<string, {userId: string; at: number}>; hostUserId?: string}>}).rooms;

  it('KO-3 — the last participant leaving does NOT delete a room with a reservation in flight', async () => {
    const {svc, pump} = makeGated();
    seedRoom(svc, 'room-k3', ['t-old'], 'seed-t-old');

    const joining = svc.joinRoom('room-k3', 'user-new'); // reserves, hangs on transports
    await tick();
    await svc.leaveRoom('t-old'); // last ESTABLISHED participant leaves
    expect(roomsOf(svc).has('room-k3')).toBe(true); // survives for the joiner

    await pump();
    await joining; // completes into the surviving room
    expect(roomsOf(svc).get('room-k3')!.participantTags.size).toBe(1);
  });

  it('KO-4 — a wedged reservation ages out at the next join instead of holding room_full', async () => {
    const {svc, pump} = makeGated();
    seedRoom(svc, 'room-k4', Array.from({length: CAP - 1}, (_, i) => `t-${i}`), 'seed-t-0');
    let nowMs = 1_755_000_000_000;
    const spy = jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
    try {
      const wedged = svc.joinRoom('room-k4', 'user-wedge'); // reserves the last slot, never settles
      wedged.catch(() => { /* aborts later — pre-attach */ });
      await tick();
      await expect(svc.joinRoom('room-k4', 'user-b')).rejects.toThrow('room_full'); // slot genuinely held

      nowMs += 31_000; // past RESERVATION_TTL_MS
      const b = svc.joinRoom('room-k4', 'user-b'); // prune frees the slot
      await pump();
      await expect(b).resolves.toMatchObject({participantTag: expect.any(String)});
      // The wedged join's transports finally settle → its re-check self-aborts.
      await expect(wedged).rejects.toThrow('join_superseded');
      expect(roomsOf(svc).get('room-k4')!.participantTags.size).toBe(CAP);
    } finally {
      spy.mockRestore();
    }
  });

  it('KO-5 — a same-user retry supersedes the old reservation; the superseded join self-aborts', async () => {
    const {svc, pump} = makeGated();
    seedRoom(svc, 'room-k5', [], undefined);

    const first = svc.joinRoom('room-k5', 'user-r'); // reserves + claims host, hangs
    first.catch(() => { /* aborts below — pre-attach */ });
    await tick();
    const retry = svc.joinRoom('room-k5', 'user-r'); // supersedes the reservation
    await tick();
    expect(roomsOf(svc).get('room-k5')!.pendingJoins!.size).toBe(1); // ONE slot, not two

    await pump();
    await expect(first).rejects.toThrow('join_superseded');
    const res = await retry;
    expect(res.isHost).toBe(true); // same user keeps the claim
    expect(roomsOf(svc).get('room-k5')!.participantTags.size).toBe(1);
  });

  it('KO-6 — a failed host-claiming join broadcasts sfu.host-changed when the claim moves', async () => {
    const {svc, toRoom, pump} = makeGated();
    seedRoom(svc, 'room-k6', [], undefined);

    const a = svc.joinRoom('room-k6', 'user-A'); // claims host
    a.catch(() => { /* fails below — pre-attach */ });
    await tick();
    const b = svc.joinRoom('room-k6', 'user-B'); // defers
    await tick();
    await pump([0]); // A's send transport dies; B completes
    await expect(a).rejects.toThrow('worker died');
    await b;

    expect(svc.hostOf('room-k6')).toBe('user-B');
    expect(toRoom).toHaveBeenCalledWith('room-k6', {
      event: 'sfu.host-changed',
      data:  {roomId: 'room-k6', hostUserId: 'user-B'},
    });
  });

  it('KO-6 — no broadcast when the claim simply clears (lone failed first joiner)', async () => {
    const {svc, toRoom, pump} = makeGated();
    seedRoom(svc, 'room-k6b', [], undefined);
    const a = svc.joinRoom('room-k6b', 'user-A');
    a.catch(() => { /* pre-attach */ });
    await tick();
    await pump([0]);
    await expect(a).rejects.toThrow('worker died');
    expect(svc.hostOf('room-k6b')).toBeNull();
    expect(toRoom).not.toHaveBeenCalledWith('room-k6b', expect.objectContaining({event: 'sfu.host-changed'}));
  });
});
