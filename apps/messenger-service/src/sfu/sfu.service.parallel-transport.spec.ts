import {ConfigService} from '@nestjs/config';
import {SfuService} from './sfu.service';
import type {SfuWorkerPool} from './sfuWorkerPool';

/**
 * Audit Step 4.1 (B-604) — the join's two WebRtcTransports are created
 * CONCURRENTLY (Promise.allSettled), not one-await-after-the-other, and a
 * failed create still CLOSES the sibling that succeeded (no ICE-port / FD leak).
 *
 * Two independent properties, each mutation-proved:
 *   1. Parallelism: with a factory that hangs, BOTH creates are dispatched
 *      before either resolves. A serial `await; await` issues only one.
 *   2. Leak-free rollback: when one create rejects and the other resolves, the
 *      resolved transport's close() is called. A naive `const [s,r] = await
 *      Promise.all(...)` never assigns the resolved transport on rejection, so
 *      the sequential-catch's `s?.close()` would see undefined and leak it.
 */
describe('Audit Step 4.1 (B-604) — parallel transport creation in joinRoom', () => {
  type FakeTx = {
    id: string;
    iceParameters: object;
    iceCandidates: unknown[];
    dtlsParameters: object;
    close: jest.Mock;
  };
  const tick = () => new Promise<void>(r => setImmediate(r));

  function makeService(): SfuService {
    const pool = {} as unknown as SfuWorkerPool;
    const cfg = {get: () => undefined} as unknown as ConfigService;
    const svc = new SfuService(pool, cfg);
    (svc as unknown as {broadcastToRoom: unknown}).broadcastToRoom = jest.fn();
    return svc;
  }

  function seedRoom(svc: SfuService, roomId: string): void {
    const rooms = (svc as unknown as {
      rooms: Map<string, {router: object; participantTags: Set<string>; hostUserId?: string; createdAt: number}>;
    }).rooms;
    rooms.set(roomId, {
      router: {rtpCapabilities: {codecs: []}},
      participantTags: new Set<string>(),
      hostUserId: undefined,
      createdAt: 0,
    });
  }

  it('dispatches BOTH createWebRtcTransport calls before either resolves (serial would issue one)', async () => {
    const releases: Array<() => void> = [];
    let calls = 0;
    const createMock = jest.fn(() => new Promise<FakeTx>(resolve => {
      const id = `tx-${++calls}`;
      releases.push(() => resolve({id, iceParameters: {}, iceCandidates: [], dtlsParameters: {}, close: jest.fn()}));
    }));
    const svc = makeService();
    (svc as unknown as {createWebRtcTransport: unknown}).createWebRtcTransport = createMock;
    seedRoom(svc, 'room-p');

    const p = svc.joinRoom('room-p', 'user-A');
    await tick(); // both creates should be in flight now; neither released
    expect(createMock).toHaveBeenCalledTimes(2); // MUTATION: serial `await;await` → 1

    releases.forEach(r => r());
    const res = await p;
    expect(res.participantTag).toEqual(expect.any(String));
  });

  it('a failed create CLOSES the sibling that succeeded — no leak (allSettled, not Promise.all)', async () => {
    const sendClose = jest.fn();
    let calls = 0;
    const createMock = jest.fn(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve<FakeTx>({
          id: 'send', iceParameters: {}, iceCandidates: [], dtlsParameters: {}, close: sendClose,
        });
      }
      return Promise.reject(new Error('worker died'));
    });
    const svc = makeService();
    (svc as unknown as {createWebRtcTransport: unknown}).createWebRtcTransport = createMock;
    seedRoom(svc, 'room-x');

    await expect(svc.joinRoom('room-x', 'user-A')).rejects.toThrow('worker died');

    // The transport that DID come up must have been closed — MUTATION: a naive
    // `const [s,r] = await Promise.all([...])` leaks it (sendClose never fires).
    expect(sendClose).toHaveBeenCalledTimes(1);

    // …and the reservation is rolled back, so the slot is reusable.
    const rooms = (svc as unknown as {
      rooms: Map<string, {participantTags: Set<string>; pendingJoins?: Map<string, unknown>}>;
    }).rooms;
    expect(rooms.get('room-x')!.pendingJoins?.size ?? 0).toBe(0);
    expect(rooms.get('room-x')!.participantTags.size).toBe(0);
  });

  it('the symmetric case: recv succeeds, send fails — the recv transport is closed too', async () => {
    const recvClose = jest.fn();
    let calls = 0;
    const createMock = jest.fn(() => {
      calls += 1;
      if (calls === 1) { return Promise.reject(new Error('send worker died')); }
      return Promise.resolve<FakeTx>({
        id: 'recv', iceParameters: {}, iceCandidates: [], dtlsParameters: {}, close: recvClose,
      });
    });
    const svc = makeService();
    (svc as unknown as {createWebRtcTransport: unknown}).createWebRtcTransport = createMock;
    seedRoom(svc, 'room-y');

    await expect(svc.joinRoom('room-y', 'user-A')).rejects.toThrow('send worker died');
    expect(recvClose).toHaveBeenCalledTimes(1);
  });
});
