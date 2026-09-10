import {NotFoundException} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {SfuService} from './sfu.service';
import type {SfuWorkerPool} from './sfuWorkerPool';

/**
 * Offscreen-tile bandwidth control (10-person calls) — the recipient
 * pauses their OWN consumer so the SFU stops forwarding that RTP
 * stream to them. Contract under test:
 *
 *   1. Ownership is structural: only a consumer in the CALLER's own
 *      consumer map can be paused (a foreign/unknown consumerId is a
 *      404, never a cross-participant mutation).
 *   2. The mediasoup consumer is actually paused server-side.
 *   3. No fanout — pausing your own consumer is private (nothing is
 *      broadcast to the room; the producer and other recipients are
 *      unaffected).
 *   4. resumeConsumer round-trips: after pause, resume still works and
 *      requests the keyframe the decoder needs on scroll-back.
 */
describe('SfuService.pauseConsumer (offscreen-tile bandwidth control)', () => {
  function makeService(): {svc: SfuService; toRoom: jest.Mock} {
    const pool = {} as unknown as SfuWorkerPool;
    const cfg = {get: () => undefined} as unknown as ConfigService;
    const svc = new SfuService(pool, cfg);
    const toRoom = jest.fn();
    (svc as unknown as {broadcastToRoom: unknown}).broadcastToRoom = toRoom;
    return {svc, toRoom};
  }

  type FakeConsumer = {
    id: string;
    kind: 'audio' | 'video';
    paused: boolean;
    pause: jest.Mock<Promise<void>, []>;
    resume: jest.Mock<Promise<void>, []>;
    requestKeyFrame: jest.Mock<Promise<void>, []>;
  };

  function makeConsumer(id: string, kind: 'audio' | 'video'): FakeConsumer {
    const c: FakeConsumer = {
      id, kind, paused: false,
      pause:           jest.fn().mockImplementation(async () => { c.paused = true; }),
      resume:          jest.fn().mockImplementation(async () => { c.paused = false; }),
      requestKeyFrame: jest.fn().mockResolvedValue(undefined),
    };
    return c;
  }

  function seedParticipant(svc: SfuService, tag: string, consumers: FakeConsumer[]): void {
    const participants = (svc as unknown as {
      participants: Map<string, {tag: string; roomId: string; consumers: Map<string, FakeConsumer>}>;
    }).participants;
    participants.set(tag, {
      tag,
      roomId: 'room-1',
      consumers: new Map(consumers.map(c => [c.id, c])),
    });
  }

  it('pauses the caller\'s own consumer server-side, with NO room fanout', async () => {
    const {svc, toRoom} = makeService();
    const c = makeConsumer('cid-video', 'video');
    seedParticipant(svc, 'self-tag', [c]);

    await svc.pauseConsumer('self-tag', 'cid-video');

    expect(c.pause).toHaveBeenCalledTimes(1);
    expect(c.paused).toBe(true);
    expect(toRoom).not.toHaveBeenCalled();
  });

  it('404s on a consumerId that is not in the caller\'s own map (foreign consumer untouched)', async () => {
    const {svc} = makeService();
    const mine = makeConsumer('cid-mine', 'video');
    const theirs = makeConsumer('cid-theirs', 'video');
    seedParticipant(svc, 'self-tag', [mine]);
    seedParticipant(svc, 'other-tag', [theirs]);

    await expect(svc.pauseConsumer('self-tag', 'cid-theirs')).rejects.toThrow(NotFoundException);
    expect(theirs.pause).not.toHaveBeenCalled();
  });

  it('404s for an unknown participant', async () => {
    const {svc} = makeService();
    await expect(svc.pauseConsumer('ghost-tag', 'cid-x')).rejects.toThrow(NotFoundException);
  });

  it('pause → resume round-trip: resume un-pauses and requests the scroll-back keyframe', async () => {
    const {svc} = makeService();
    const c = makeConsumer('cid-video', 'video');
    seedParticipant(svc, 'self-tag', [c]);

    await svc.pauseConsumer('self-tag', 'cid-video');
    await svc.resumeConsumer('self-tag', 'cid-video');

    expect(c.paused).toBe(false);
    expect(c.requestKeyFrame).toHaveBeenCalledTimes(1);
  });
});
