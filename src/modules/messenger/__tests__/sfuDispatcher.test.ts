import {
  registerSfuHandler,
  dispatchSfuFrame,
  clearAllSfuHandlers,
  SFU_FRAME_EVENTS,
} from '@/modules/messenger/webrtc/sfuDispatcher';

/**
 * BS-ROSTER — the dispatcher must fan a per-room SFU frame to EVERY live
 * handler for that room, not just the most-recently-registered one.
 *
 * useGroupCall registers a handler from two places for the same roomId:
 * the boot hook (owns recvTransport + the real consumeProducer — the
 * only handler that consumes sfu.new-producer) and the minimize→restore
 * resume hook (an intentionally partial handler). With the old single-
 * slot Map, a GroupCallScreen remount had the second registration
 * silently overwrite the first, so sfu.new-producer frames routed to a
 * handler that couldn't consume them and a peer's tile never appeared
 * on that device — the "three devices disagree on who's in the call"
 * symptom. These tests pin the multi-handler contract.
 */

const ROOM = 'room-aaa';
const ROOM_B = 'room-bbb';

function newProducer(roomId: string): {event: string; data: {roomId: string; producerId: string}} {
  return {event: 'sfu.new-producer', data: {roomId, producerId: 'p1'}};
}

describe('sfuDispatcher — BS-ROSTER multi-handler fanout', () => {
  beforeEach(() => {
    clearAllSfuHandlers();
  });

  it('fans a frame to BOTH handlers registered for the same room', () => {
    // The core regression: on `main` the second registerSfuHandler
    // replaced the first, so only the second handler fired.
    const a = jest.fn();
    const b = jest.fn();
    registerSfuHandler(ROOM, a);
    registerSfuHandler(ROOM, b);

    const handled = dispatchSfuFrame(newProducer(ROOM));

    expect(handled).toBe(true);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('unregister removes only its own handler, leaving siblings live', () => {
    const a = jest.fn();
    const b = jest.fn();
    registerSfuHandler(ROOM, a);
    const unregB = registerSfuHandler(ROOM, b);

    unregB();
    dispatchSfuFrame(newProducer(ROOM));

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
  });

  it('is room-isolated — a frame for room A never reaches a room-B handler', () => {
    const a = jest.fn();
    const b = jest.fn();
    registerSfuHandler(ROOM, a);
    registerSfuHandler(ROOM_B, b);

    dispatchSfuFrame(newProducer(ROOM));

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
  });

  it('is safe when a handler unregisters itself mid-dispatch', () => {
    // sfu.kicked / sfu.room.ended call leaveInternal → cleanup →
    // unregister, all synchronously inside the dispatch loop. The
    // snapshot-before-iterate must keep the sibling firing.
    const sibling = jest.fn();
    let unregSelf: (() => void) | null = null;
    const selfRemover = jest.fn(() => { unregSelf?.(); });

    unregSelf = registerSfuHandler(ROOM, selfRemover);
    registerSfuHandler(ROOM, sibling);

    expect(() => dispatchSfuFrame(newProducer(ROOM))).not.toThrow();
    expect(selfRemover).toHaveBeenCalledTimes(1);
    expect(sibling).toHaveBeenCalledTimes(1);

    // The self-removed handler is gone on the next dispatch; the
    // sibling still fires.
    dispatchSfuFrame(newProducer(ROOM));
    expect(selfRemover).toHaveBeenCalledTimes(1);
    expect(sibling).toHaveBeenCalledTimes(2);
  });

  it('one throwing handler does not block its siblings', () => {
    const thrower = jest.fn(() => { throw new Error('boom'); });
    const ok = jest.fn();
    registerSfuHandler(ROOM, thrower);
    registerSfuHandler(ROOM, ok);

    expect(() => dispatchSfuFrame(newProducer(ROOM))).not.toThrow();
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it('returns false for an unknown room and for a frame with no roomId', () => {
    registerSfuHandler(ROOM, jest.fn());
    expect(dispatchSfuFrame(newProducer('room-nope'))).toBe(false);
    expect(dispatchSfuFrame({event: 'sfu.new-producer', data: {}})).toBe(false);
    expect(dispatchSfuFrame({event: 'sfu.new-producer'})).toBe(false);
  });

  it('clearAllSfuHandlers drops every handler in every room', () => {
    const a = jest.fn();
    const b = jest.fn();
    registerSfuHandler(ROOM, a);
    registerSfuHandler(ROOM_B, b);

    clearAllSfuHandlers();

    expect(dispatchSfuFrame(newProducer(ROOM))).toBe(false);
    expect(dispatchSfuFrame(newProducer(ROOM_B))).toBe(false);
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });
});

describe('sfuDispatcher — camera-toggle peer-sync events are routed', () => {
  // The runtime frame loop forwards a frame to dispatchSfuFrame ONLY when
  // SFU_FRAME_EVENTS.has(frame.event). The peer-side camera-toggle sync
  // (swap remote tile to avatar on pause / back to live video on resume)
  // depends on these two events surviving that gate. They were missing
  // from the set, so the runtime silently dropped them and the remote
  // tile froze on the last decoded frame — pin them here so a future
  // edit to the set can't regress the fix.
  it('SFU_FRAME_EVENTS includes producer-paused and producer-resumed', () => {
    expect(SFU_FRAME_EVENTS.has('sfu.producer-paused')).toBe(true);
    expect(SFU_FRAME_EVENTS.has('sfu.producer-resumed')).toBe(true);
  });
});
