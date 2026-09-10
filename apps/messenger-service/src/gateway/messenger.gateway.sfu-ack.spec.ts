/**
 * Audit SFU-01 (2026-07-02) — SFU handler error returns MUST be event-less
 * so the NestJS socket.io adapter invokes the ack callback instead of
 * emitting a WsResponse. An `{event:'sfu.error'}` return is emitted-not-
 * acked, so the client's emitWithAck times out (15s) and can never learn
 * the real reason — this is what made the group video-toggle
 * (sfu.producer.pause/resume) failure impossible to diagnose across three
 * device sessions.
 *
 * These handlers use only `this.firstTagFor`, so we invoke them off the
 * prototype with a stub `this` — no need to build the full gateway.
 */
import {MessengerGateway} from './messenger.gateway';

const fakeClient = () => ({}) as never;

describe('SFU-01 — producer pause/resume error returns are event-less (ackable)', () => {
  it('handleSfuProducerPause returns {ok:false} with NO event key when there is no active participant', async () => {
    const ret = await MessengerGateway.prototype.handleSfuProducerPause.call(
      {firstTagFor: () => undefined, rateGate: () => null},
      {roomId: 'room-1', producerId: 'p-1'},
      fakeClient(),
    ) as Record<string, unknown>;
    expect(ret.event).toBeUndefined();       // must NOT be WsResponse-shaped
    expect(ret.ok).toBe(false);
    expect((ret.data as {message: string}).message).toBe('no_active_participant');
  });

  it('handleSfuProducerResume returns {ok:false} with NO event key when there is no active participant', async () => {
    const ret = await MessengerGateway.prototype.handleSfuProducerResume.call(
      {firstTagFor: () => undefined, rateGate: () => null},
      {roomId: 'room-1', producerId: 'p-1'},
      fakeClient(),
    ) as Record<string, unknown>;
    expect(ret.event).toBeUndefined();
    expect(ret.ok).toBe(false);
    expect((ret.data as {message: string}).message).toBe('no_active_participant');
  });

  it('handleSfuProducerPause acks {ok:true} on success', async () => {
    const setProducerPaused = jest.fn().mockResolvedValue(undefined);
    const ret = await MessengerGateway.prototype.handleSfuProducerPause.call(
      {firstTagFor: () => 'tag-1', sfu: {setProducerPaused}, rateGate: () => null},
      {roomId: 'room-1', producerId: 'p-1'},
      fakeClient(),
    ) as Record<string, unknown>;
    expect(ret).toEqual({ok: true});
    expect(setProducerPaused).toHaveBeenCalledWith('tag-1', 'p-1', true);
  });
});
