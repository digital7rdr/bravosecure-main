import {EventEmitter} from 'node:events';
import {ConfigService} from '@nestjs/config';
import {SfuService} from './sfu.service';
import type {SfuWorkerPool} from './sfuWorkerPool';

/**
 * 2026-08-12 group-call entry defects, root-caused from a 3-device capture.
 *
 * Two founder symptoms traced to this file:
 *
 *  - "only the admin's call rings; when anyone else starts a call nobody
 *    gets rung". The client decided ring-vs-join from whether the server
 *    returned a room ID at all. But `findRoomForConversation` deliberately
 *    hands out a room with ZERO participants for a 30s grace (so a host
 *    whose join is still in flight can come back to it), and a boot that
 *    dies before `sfu.join` leaves exactly that corpse behind. The second
 *    caller was handed the corpse, concluded a call was already live, and
 *    entered SILENTLY — ringing nobody. `roomHasParticipants` is the fact
 *    they actually needed, kept separate so the grace itself is unchanged.
 *
 *  - a lone joiner reported `isHost=false` with `existingProducers=0`
 *    (device 5556, room ee03300d). Host was pinned to whoever POSTed
 *    /sfu/rooms, so an abandoned creator stayed "host" of a room they were
 *    never in. `isHost` gates the call-key mint and the ring-cancel, so the
 *    one device that intended the call could neither key the people it rang
 *    nor dismiss their ringing screens.
 *
 * The reaping rules are NOT under test here and must not change — the
 * simultaneous-tap dedup they provide is pinned by
 * `sfu.service.stale-room.spec.ts`.
 */
describe('SfuService — call-entry liveness and host election', () => {
  type FakeRouter = {
    id: string;
    rtpCapabilities: {codecs: unknown[]; headerExtensions: unknown[]};
    observer: EventEmitter;
    closed: boolean;
    close: jest.Mock;
    createWebRtcTransport: jest.Mock;
  };

  function makeRouter(): FakeRouter {
    const observer = new EventEmitter();
    let txSeq = 0;
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
      createWebRtcTransport: jest.fn(async () => ({
        id:             `tx-${router.id}-${txSeq++}`,
        iceParameters:  {usernameFragment: 'u', password: 'p', iceLite: true},
        iceCandidates:  [],
        dtlsParameters: {role: 'auto', fingerprints: []},
        close:          jest.fn(),
        on:             jest.fn(),
        setMaxIncomingBitrate: jest.fn(async () => undefined),
      })),
    };
    return router;
  }

  function makeService(created: FakeRouter[]): SfuService {
    const cfg = {get: () => undefined} as unknown as ConfigService;
    const pool = {
      createRouter: jest.fn(async () => {
        const r = makeRouter();
        created.push(r);
        return r;
      }),
    } as unknown as SfuWorkerPool;
    const svc = new SfuService(pool, cfg);
    (svc as unknown as {broadcastToRoom: unknown}).broadcastToRoom = jest.fn();
    return svc;
  }

  function rooms(svc: SfuService): Map<string, {participantTags: Set<string>}> {
    return (svc as unknown as {rooms: Map<string, {participantTags: Set<string>}>}).rooms;
  }

  describe('roomHasParticipants — "a room exists" is not "a call is live"', () => {
    it('is FALSE for a created-but-unjoined room that the probe still hands out', async () => {
      const created: FakeRouter[] = [];
      const svc = makeService(created);

      const {roomId} = await svc.createRoom({conversationId: 'cid-1', hostUserId: 'host'});

      // THE divergence that produced the silent join: inside the fresh-room
      // grace the probe still resolves this room (that behaviour is
      // deliberate and must not change) — but nobody is in it, so a caller
      // who takes "resolved" to mean "live" rings nobody.
      expect(svc.findRoomForConversation('cid-1')).toBe(roomId);
      expect(svc.roomHasParticipants(roomId)).toBe(false);
    });

    it('is TRUE once somebody has actually joined', async () => {
      const created: FakeRouter[] = [];
      const svc = makeService(created);

      const {roomId} = await svc.createRoom({conversationId: 'cid-1', hostUserId: 'host'});
      await svc.joinRoom(roomId, 'host');

      expect(svc.roomHasParticipants(roomId)).toBe(true);
    });

    it('is FALSE for an unknown room rather than throwing', () => {
      const svc = makeService([]);
      expect(svc.roomHasParticipants('no-such-room')).toBe(false);
    });
  });

  describe('host election — the host is whoever is FIRST ACTUALLY IN the room', () => {
    it('promotes a lone joiner over a recorded host who never arrived', async () => {
      const created: FakeRouter[] = [];
      const svc = makeService(created);

      // 'ghost' POSTed /sfu/rooms and then died at media acquisition — it
      // never calls joinRoom. This is device 5555's create-then-fail cycle.
      const {roomId} = await svc.createRoom({conversationId: 'cid-1', hostUserId: 'ghost'});
      expect(svc.hostOf(roomId)).toBe('ghost');

      // 'member' is handed that room and joins it alone.
      const joined = await svc.joinRoom(roomId, 'member');

      expect(joined.existingProducers).toHaveLength(0);
      // Was FALSE before the fix — the exact ack device 5556 logged.
      expect(joined.isHost).toBe(true);
      expect(svc.hostOf(roomId)).toBe('member');
    });

    it('does NOT demote a host who is genuinely in the room', async () => {
      const created: FakeRouter[] = [];
      const svc = makeService(created);

      const {roomId} = await svc.createRoom({conversationId: 'cid-1', hostUserId: 'host'});
      const hostJoin = await svc.joinRoom(roomId, 'host');
      expect(hostJoin.isHost).toBe(true);

      const memberJoin = await svc.joinRoom(roomId, 'member');

      // The second arrival is a guest, and the live host keeps authority.
      expect(memberJoin.isHost).toBe(false);
      expect(svc.hostOf(roomId)).toBe('host');
    });

    it('still elects the first joiner when the room was created with no host at all', async () => {
      const created: FakeRouter[] = [];
      const svc = makeService(created);

      // The legacy path the old `if (!room.hostUserId)` existed for — it
      // must keep working.
      const {roomId} = await svc.createRoom({conversationId: 'cid-1'});
      const joined = await svc.joinRoom(roomId, 'first');

      expect(joined.isHost).toBe(true);
      expect(svc.hostOf(roomId)).toBe('first');
    });

    it('hands host to a rejoining user who is the only one left, not to a ghost tag', async () => {
      const created: FakeRouter[] = [];
      const svc = makeService(created);

      const {roomId} = await svc.createRoom({conversationId: 'cid-1', hostUserId: 'ghost'});
      // A member joins, then rejoins after a lost ack. The stale-supersede
      // loop drops their first tag before the host check runs, so the room
      // is momentarily empty — they must still end up host, and there must
      // be exactly one tag for them afterwards.
      await svc.joinRoom(roomId, 'member');
      const rejoin = await svc.joinRoom(roomId, 'member');

      expect(rejoin.isHost).toBe(true);
      expect(svc.hostOf(roomId)).toBe('member');
      expect(rooms(svc).get(roomId)!.participantTags.size).toBe(1);
    });
  });
});
