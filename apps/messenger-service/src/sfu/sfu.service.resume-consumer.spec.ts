import {NotFoundException} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {SfuService} from './sfu.service';
import type {SfuWorkerPool} from './sfuWorkerPool';

/**
 * BS-GC-KEYFRAME — a consumer is created paused (consume(): paused:true), so
 * after `sfu.consumer.resume` the receiver only gets whatever the producer
 * sends next. For VIDEO that is undecodable until a keyframe arrives, and the
 * next NATURAL simulcast keyframe can be many seconds out → the remote tile
 * renders black for the whole call. resumeConsumer must therefore request a
 * keyframe right after resuming a video consumer (and must NOT for audio,
 * which needs none). A keyframe-request rejection (consumer closed in the
 * race) must never fail the resume.
 */
describe('SfuService.resumeConsumer (keyframe on resume)', () => {
  function makeService(): SfuService {
    const pool = {} as unknown as SfuWorkerPool;
    const cfg = {get: () => undefined} as unknown as ConfigService;
    return new SfuService(pool, cfg);
  }

  type FakeConsumer = {
    id: string;
    kind: 'audio' | 'video';
    resume: jest.Mock<Promise<void>, []>;
    requestKeyFrame: jest.Mock<Promise<void>, []>;
  };

  function seedConsumer(svc: SfuService, kind: 'audio' | 'video', opts?: {
    keyFrameRejects?: boolean;
  }): {tag: string; consumer: FakeConsumer} {
    const tag = 'self-tag';
    const consumer: FakeConsumer = {
      id: `cid-${kind}`,
      kind,
      resume: jest.fn().mockResolvedValue(undefined),
      requestKeyFrame: opts?.keyFrameRejects
        ? jest.fn().mockRejectedValue(new Error('consumer closed'))
        : jest.fn().mockResolvedValue(undefined),
    };
    const participants = (svc as unknown as {
      participants: Map<string, {tag: string; roomId: string; consumers: Map<string, FakeConsumer>}>;
    }).participants;
    participants.set(tag, {
      tag,
      roomId: 'room-1',
      consumers: new Map([[consumer.id, consumer]]),
    });
    return {tag, consumer};
  }

  it('requests a keyframe after resuming a VIDEO consumer', async () => {
    const svc = makeService();
    const {tag, consumer} = seedConsumer(svc, 'video');

    await svc.resumeConsumer(tag, consumer.id);

    expect(consumer.resume).toHaveBeenCalledTimes(1);
    expect(consumer.requestKeyFrame).toHaveBeenCalledTimes(1);
    // Keyframe is requested AFTER resume (a paused consumer can't emit one).
    expect(consumer.resume.mock.invocationCallOrder[0])
      .toBeLessThan(consumer.requestKeyFrame.mock.invocationCallOrder[0]);
  });

  it('does NOT request a keyframe for an AUDIO consumer', async () => {
    const svc = makeService();
    const {tag, consumer} = seedConsumer(svc, 'audio');

    await svc.resumeConsumer(tag, consumer.id);

    expect(consumer.resume).toHaveBeenCalledTimes(1);
    expect(consumer.requestKeyFrame).not.toHaveBeenCalled();
  });

  it('does not fail the resume if requestKeyFrame rejects (consumer closed in the race)', async () => {
    const svc = makeService();
    const {tag, consumer} = seedConsumer(svc, 'video', {keyFrameRejects: true});

    await expect(svc.resumeConsumer(tag, consumer.id)).resolves.toBeUndefined();
    expect(consumer.resume).toHaveBeenCalledTimes(1);
    expect(consumer.requestKeyFrame).toHaveBeenCalledTimes(1);
  });

  it('throws when the consumer id is unknown', async () => {
    const svc = makeService();
    const {tag} = seedConsumer(svc, 'video');

    await expect(svc.resumeConsumer(tag, 'nope')).rejects.toThrow(NotFoundException);
  });
});
