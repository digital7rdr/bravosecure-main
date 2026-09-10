/**
 * BS-MEDIA (multi-pod) — the SFU frame fanout must route through socket.io
 * ROOMS (`sfu:<roomId>` / `sfutag:<tag>`), not raw in-memory Socket refs,
 * so the Redis adapter delivers frames to participants on any pod. These
 * tests capture the closures the gateway hands to `SfuService.bindFanout`
 * in its constructor and assert they emit to the right rooms with the
 * right `.except()` exclusion.
 */
import {Logger} from '@nestjs/common';
import {MessengerGateway} from './messenger.gateway';

type FanoutOpts = {
  toParticipant: (tag: string, frame: unknown) => void;
  toRoom:        (roomId: string, frame: unknown, exceptTag?: string) => void;
};

// Records every server.to(room)[.except(other)].emit(event, data) call so
// we can assert routing. Mirrors the real socket.io emitter chain shape.
function recordingHub() {
  const emits: Array<{room: string; except?: string; event: string; data: unknown}> = [];
  const server = {
    to: (room: string) => ({
      emit: (event: string, data: unknown) => { emits.push({room, event, data}); },
      except: (other: string) => ({
        emit: (event: string, data: unknown) => { emits.push({room, except: other, event, data}); },
      }),
    }),
  };
  return {
    obj:   {server} as unknown as import('./socket-hub').SocketHub,
    emits,
  };
}

// Captures the fanout closures the gateway constructor registers.
function capturingSfu(): {captured: {opts?: FanoutOpts}} {
  const captured: {opts?: FanoutOpts} = {};
  const stub = {
    bindFanout: (opts: FanoutOpts) => { captured.opts = opts; },
  } as unknown as import('../sfu/sfu.service').SfuService;
  return {captured, sfu: stub} as unknown as {captured: {opts?: FanoutOpts}; sfu: import('../sfu/sfu.service').SfuService};
}

function makeGateway() {
  const hub = recordingHub();
  const cap = capturingSfu() as unknown as {captured: {opts?: FanoutOpts}; sfu: import('../sfu/sfu.service').SfuService};
  const gw = new MessengerGateway(
    /* jwt        */ {} as never,
    /* registry   */ {} as never,
    /* hub        */ hub.obj,
    /* presence   */ {} as never,
    /* envelopes  */ {} as never,
    /* push       */ {} as never,
    /* sfu        */ cap.sfu,
    /* redis      */ {} as never,
    /* roomToken  */ {} as never,
    /* privacy    */ {} as never,
  );
  (gw as unknown as {logger: Logger}).logger = {
    log: () => {}, warn: () => {}, error: () => {}, debug: () => {}, verbose: () => {},
  } as unknown as Logger;
  return {emits: hub.emits, fanout: cap.captured.opts!};
}

describe('MessengerGateway SFU fanout — multi-pod routing (BS-MEDIA)', () => {
  it('toParticipant emits to the target tag room', () => {
    const {emits, fanout} = makeGateway();
    fanout.toParticipant('tag-abc', {event: 'sfu.muted', data: {roomId: 'r1'}});
    expect(emits).toEqual([
      {room: 'sfutag:tag-abc', event: 'sfu.muted', data: {roomId: 'r1'}},
    ]);
  });

  it('toRoom broadcasts to the room and excludes the originator tag', () => {
    const {emits, fanout} = makeGateway();
    fanout.toRoom('r1', {event: 'sfu.new-producer', data: {producerId: 'p1'}}, 'tag-self');
    expect(emits).toEqual([
      {room: 'sfu:r1', except: 'sfutag:tag-self', event: 'sfu.new-producer', data: {producerId: 'p1'}},
    ]);
  });

  it('toRoom with no exceptTag broadcasts to the whole room', () => {
    const {emits, fanout} = makeGateway();
    fanout.toRoom('r1', {event: 'sfu.room.ended', data: {roomId: 'r1'}});
    expect(emits).toEqual([
      {room: 'sfu:r1', event: 'sfu.room.ended', data: {roomId: 'r1'}},
    ]);
  });

  it('falls back to an empty data object when the frame omits data', () => {
    const {emits, fanout} = makeGateway();
    fanout.toParticipant('tag-x', {event: 'sfu.kicked'});
    expect(emits).toEqual([
      {room: 'sfutag:tag-x', event: 'sfu.kicked', data: {}},
    ]);
  });
});
