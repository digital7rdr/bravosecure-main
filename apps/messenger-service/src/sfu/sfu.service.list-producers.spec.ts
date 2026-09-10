import {ForbiddenException, NotFoundException} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {SfuService} from './sfu.service';
import type {SfuWorkerPool} from './sfuWorkerPool';

/**
 * BS-MEDIA — `listProducers` is the reconcile query the client polls to
 * recover a missed `sfu.new-producer` frame or a retry-exhausted consume.
 * It's pure map logic (no mediasoup), so we drive it by injecting room +
 * participant state directly. The shape MUST stay identical to the
 * join-time `existingProducers` payload — both flow through the private
 * `snapshotProducers`, and the client diffs one against the other.
 */
describe('SfuService.listProducers (reconcile)', () => {
  function makeService(): SfuService {
    // listProducers never touches the worker pool or config — stub both.
    const pool = {} as unknown as SfuWorkerPool;
    const cfg = {get: () => undefined} as unknown as ConfigService;
    return new SfuService(pool, cfg);
  }

  // Seed the private maps the way joinRoom + produce would, without
  // standing up real mediasoup transports/producers.
  function seedRoom(svc: SfuService): {
    roomId: string;
    selfTag: string;
    peerTag: string;
    peerAudioPid: string;
    peerVideoPid: string;
  } {
    const roomId = 'room-1';
    const selfTag = 'self-tag';
    const peerTag = 'peer-tag';
    const peerAudioPid = 'pid-audio';
    const peerVideoPid = 'pid-video';

    const rooms: Map<string, {participantTags: Set<string>}> =
      (svc as unknown as {rooms: Map<string, {participantTags: Set<string>}>}).rooms;
    const participants: Map<string, unknown> =
      (svc as unknown as {participants: Map<string, unknown>}).participants;

    rooms.set(roomId, {participantTags: new Set([selfTag, peerTag])});
    participants.set(selfTag, {tag: selfTag, roomId, producers: new Map()});
    participants.set(peerTag, {
      tag: peerTag,
      roomId,
      producers: new Map<string, {kind: string}>([
        [peerAudioPid, {kind: 'audio'}],
        [peerVideoPid, {kind: 'video'}],
      ]),
    });
    return {roomId, selfTag, peerTag, peerAudioPid, peerVideoPid};
  }

  it('returns every peer producer except the caller’s own', () => {
    const svc = makeService();
    const {roomId, selfTag, peerTag, peerAudioPid, peerVideoPid} = seedRoom(svc);

    const out = svc.listProducers(selfTag, roomId);

    expect(out).toHaveLength(2);
    expect(out).toEqual(
      expect.arrayContaining([
        {producerId: peerAudioPid, participantTag: peerTag, kind: 'audio'},
        {producerId: peerVideoPid, participantTag: peerTag, kind: 'video'},
      ]),
    );
    // Never includes the caller's own tag.
    expect(out.every(p => p.participantTag !== selfTag)).toBe(true);
  });

  it('omits the caller’s own producers from the snapshot', () => {
    const svc = makeService();
    const {roomId, selfTag} = seedRoom(svc);
    // Give self a producer too — it must NOT appear in self's reconcile.
    const participants = (svc as unknown as {participants: Map<string, {producers: Map<string, {kind: string}>}>}).participants;
    participants.get(selfTag)!.producers.set('pid-self', {kind: 'audio'});

    const out = svc.listProducers(selfTag, roomId);

    expect(out.find(p => p.producerId === 'pid-self')).toBeUndefined();
  });

  it('rejects a caller who is not a participant', () => {
    const svc = makeService();
    const {roomId} = seedRoom(svc);
    expect(() => svc.listProducers('ghost-tag', roomId)).toThrow(NotFoundException);
  });

  it('rejects a participant querying a room they are not in', () => {
    const svc = makeService();
    const {selfTag} = seedRoom(svc);
    expect(() => svc.listProducers(selfTag, 'other-room')).toThrow(ForbiddenException);
  });

  it('returns an empty list when the caller is the only one in the room', () => {
    const svc = makeService();
    const roomId = 'solo-room';
    const tag = 'solo-tag';
    const rooms = (svc as unknown as {rooms: Map<string, {participantTags: Set<string>}>}).rooms;
    const participants = (svc as unknown as {participants: Map<string, unknown>}).participants;
    rooms.set(roomId, {participantTags: new Set([tag])});
    participants.set(tag, {tag, roomId, producers: new Map()});

    expect(svc.listProducers(tag, roomId)).toEqual([]);
  });
});
