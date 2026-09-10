import {ForbiddenException, NotFoundException} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {SfuService} from './sfu.service';
import type {SfuWorkerPool} from './sfuWorkerPool';

/**
 * Group-call camera toggle — the owner pauses/resumes their OWN
 * producer so peers can swap the tile to its avatar placeholder
 * instead of freezing on the last decoded frame. Contract under test:
 *
 *   1. Ownership is structural: only a producer in the CALLER's own
 *      producer map can be touched (a foreign producerId is a 404,
 *      never a cross-participant mutation).
 *   2. The server-side mediasoup producer is actually paused/resumed
 *      (stops forwarding stale RTP, drives consumer.producerPaused).
 *   3. The room is notified via sfu.producer-paused / -resumed with
 *      the owner excluded from the fanout.
 *   4. S6 host-mute guard: a producer the HOST paused via
 *      sfu.mute-target cannot be self-resumed (unmute bypass).
 *   5. The reconcile snapshot carries the authoritative paused flag.
 */
describe('SfuService.setProducerPaused', () => {
  function makeService(): {svc: SfuService; toRoom: jest.Mock} {
    const pool = {} as unknown as SfuWorkerPool;
    const cfg = {get: () => undefined} as unknown as ConfigService;
    const svc = new SfuService(pool, cfg);
    const toRoom = jest.fn();
    (svc as unknown as {broadcastToRoom: unknown}).broadcastToRoom = toRoom;
    return {svc, toRoom};
  }

  type FakeProducer = {
    id: string;
    kind: 'audio' | 'video';
    paused: boolean;
    pause: jest.Mock<Promise<void>, []>;
    resume: jest.Mock<Promise<void>, []>;
  };

  function makeProducer(id: string, kind: 'audio' | 'video', paused = false): FakeProducer {
    const p: FakeProducer = {
      id, kind, paused,
      pause:  jest.fn().mockImplementation(async () => { p.paused = true; }),
      resume: jest.fn().mockImplementation(async () => { p.paused = false; }),
    };
    return p;
  }

  function seedParticipant(svc: SfuService, tag: string, producers: FakeProducer[]): void {
    const participants = (svc as unknown as {
      participants: Map<string, {tag: string; roomId: string; producers: Map<string, FakeProducer>}>;
    }).participants;
    participants.set(tag, {
      tag,
      roomId: 'room-1',
      producers: new Map(producers.map(p => [p.id, p])),
    });
  }

  it('pauses the owner\'s producer and fans sfu.producer-paused to the room (owner excluded)', async () => {
    const {svc, toRoom} = makeService();
    const prod = makeProducer('vid-1', 'video');
    seedParticipant(svc, 'self-tag', [prod]);

    await svc.setProducerPaused('self-tag', 'vid-1', true);

    expect(prod.pause).toHaveBeenCalledTimes(1);
    expect(toRoom).toHaveBeenCalledWith('room-1', {
      event: 'sfu.producer-paused',
      data: {roomId: 'room-1', producerId: 'vid-1', participantTag: 'self-tag', kind: 'video'},
    }, 'self-tag');
  });

  it('resumes and fans sfu.producer-resumed', async () => {
    const {svc, toRoom} = makeService();
    const prod = makeProducer('vid-1', 'video', true);
    seedParticipant(svc, 'self-tag', [prod]);

    await svc.setProducerPaused('self-tag', 'vid-1', false);

    expect(prod.resume).toHaveBeenCalledTimes(1);
    expect(toRoom).toHaveBeenCalledWith('room-1', expect.objectContaining({
      event: 'sfu.producer-resumed',
    }), 'self-tag');
  });

  it('refuses a producerId the caller does not own (no cross-participant mutation)', async () => {
    const {svc, toRoom} = makeService();
    const foreign = makeProducer('foreign-vid', 'video');
    seedParticipant(svc, 'self-tag', []);
    seedParticipant(svc, 'peer-tag', [foreign]);

    await expect(svc.setProducerPaused('self-tag', 'foreign-vid', true))
      .rejects.toThrow(NotFoundException);
    expect(foreign.pause).not.toHaveBeenCalled();
    expect(toRoom).not.toHaveBeenCalled();
  });

  it('S6 — refuses to resume a producer the HOST paused (unmute bypass)', async () => {
    const {svc, toRoom} = makeService();
    const prod = makeProducer('aud-1', 'audio', true);
    seedParticipant(svc, 'self-tag', [prod]);
    (svc as unknown as {
      mutedProducerIdsByTag: Map<string, Set<string>>;
    }).mutedProducerIdsByTag.set('self-tag', new Set(['aud-1']));

    await expect(svc.setProducerPaused('self-tag', 'aud-1', false))
      .rejects.toThrow(ForbiddenException);
    expect(prod.resume).not.toHaveBeenCalled();
    expect(toRoom).not.toHaveBeenCalled();
    // Pausing under host-mute stays allowed — it can't leak anything.
    await expect(svc.setProducerPaused('self-tag', 'aud-1', true)).resolves.toBeUndefined();
  });

  it('listProducers snapshot carries the authoritative paused flag', () => {
    const {svc} = makeService();
    const live   = makeProducer('vid-live', 'video', false);
    const paused = makeProducer('vid-off',  'video', true);
    seedParticipant(svc, 'self-tag', []);
    seedParticipant(svc, 'peer-tag', [live, paused]);
    (svc as unknown as {
      rooms: Map<string, {participantTags: Set<string>}>;
    }).rooms.set('room-1', {participantTags: new Set(['self-tag', 'peer-tag'])});

    const out = svc.listProducers('self-tag', 'room-1');

    expect(out).toEqual(expect.arrayContaining([
      expect.objectContaining({producerId: 'vid-live', paused: false}),
      expect.objectContaining({producerId: 'vid-off',  paused: true}),
    ]));
  });
});
