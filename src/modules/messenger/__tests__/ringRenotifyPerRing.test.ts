/**
 * B-336 — a DELIBERATE re-ring (mid-call "Add", or the host's Re-ring) must
 * present, even though it reuses the SAME roomId.
 *
 * Founder report (2026-07-29, both 1:1-escalated and group calls): "I add
 * another person in the call, that person is not rung." The relay proved it
 * fanned the ring out and delivered the push:
 *
 *   [GROUP-CALL] ring rid=9afc41c7 … → 1 user(s)
 *   push.voip.delivered sub=… sent=1/1
 *
 * …and the RECIPIENT's own log showed the client throwing it away:
 *
 *   17:02:51 [ring.dispatch] incoming room= 9afc41c7   ← first ring, presented
 *   17:03:24 [ring.dispatch] dedup-suppressed room= 9afc41c7  ← the re-ring
 *
 * `dispatchGroupRingFrame` deduped on roomId alone for a 60 s TTL, cleared
 * only by cancel/decline. A recipient who simply never answered kept the
 * marker, so every re-ring inside that minute was swallowed — silently, with
 * the server believing it had rung them.
 *
 * The fix gives each ring FAN-OUT its own `ringId` (server-minted, carried by
 * the WS frame, the FCM wake, and the queued reconnect-replay copy) and
 * dedups on (roomId, ringId). That keeps every replay-suppression property
 * B-306 / Finding #8(b) pinned — a replay carries the SAME ringId — while a
 * genuinely new ring gets through.
 *
 * Back-compat: a frame with NO ringId dedups on roomId exactly as before, so
 * an old relay keeps today's behaviour rather than double-ringing.
 */
import {
  clearAllGroupCallRingHandlers,
  dispatchGroupRingFrame,
  setGroupCallRingHandler,
  type GroupCallRingPayload,
} from '../webrtc/groupCallRingDispatcher';

function frame(roomId: string, ringId?: string): {event: string; data: GroupCallRingPayload} {
  return {
    event: 'sfu.ring.incoming',
    data: {
      roomId,
      conversationId: `conv-${roomId}`,
      callType:       'voice',
      from:           {userId: 'host-uuid', deviceId: 1},
      callerName:     'Host',
      ...(ringId ? {ringId} : {}),
    } as GroupCallRingPayload,
  };
}

function register(): {incoming: string[]} {
  const incoming: string[] = [];
  setGroupCallRingHandler({
    // WI-3.6 — `true` = "I presented this ring". The dedup marker is now burned
    // on the handler's verdict rather than on its mere existence, so a fake
    // that stays silent would model a DECLINING handler and never dedup.
    onIncoming: r => { incoming.push(r.roomId); return true; },
    onCancel:   () => {},
    onDecline:  () => {},
  });
  return {incoming};
}

beforeEach(() => {
  clearAllGroupCallRingHandlers();
});

describe('B-336 — a new ring fan-out presents even on the same roomId', () => {
  it('THE BUG: an unanswered first ring must not swallow the mid-call re-ring', () => {
    const {incoming} = register();
    // Host's boot ring — presented, user never answers (no cancel, no decline).
    dispatchGroupRingFrame(frame('room-live', 'ring-1'));
    // Someone in the call presses "Add" → server mints a NEW fan-out.
    dispatchGroupRingFrame(frame('room-live', 'ring-2'));
    expect(incoming).toEqual(['room-live', 'room-live']);
  });

  it('B-306 / #8(b) PRESERVED: the same fan-out replayed is still deduped', () => {
    const {incoming} = register();
    dispatchGroupRingFrame(frame('room-same', 'ring-1'));
    // WS frame + FCM wake copy + reconnect replay all carry ring-1.
    dispatchGroupRingFrame(frame('room-same', 'ring-1'));
    dispatchGroupRingFrame(frame('room-same', 'ring-1'));
    expect(incoming).toEqual(['room-same']);
  });

  it('BACK-COMPAT: with no ringId at all, roomId dedup behaves exactly as before', () => {
    const {incoming} = register();
    dispatchGroupRingFrame(frame('room-legacy'));
    dispatchGroupRingFrame(frame('room-legacy'));
    expect(incoming).toEqual(['room-legacy']);
  });

  it('a ringId ring dispatched into a handler GAP still does not burn its slot', () => {
    expect(dispatchGroupRingFrame(frame('room-gap', 'ring-1'))).toBe(false);
    const {incoming} = register();
    dispatchGroupRingFrame(frame('room-gap', 'ring-1'));
    expect(incoming).toEqual(['room-gap']);
  });

  it('cancel re-arms the room for ANY subsequent ringId', () => {
    const {incoming} = register();
    dispatchGroupRingFrame(frame('room-c', 'ring-1'));
    dispatchGroupRingFrame({
      event: 'sfu.ring.cancelled',
      data:  {roomId: 'room-c', conversationId: 'c'} as unknown as GroupCallRingPayload,
    });
    dispatchGroupRingFrame(frame('room-c', 'ring-1'));
    expect(incoming).toEqual(['room-c', 'room-c']);
  });
});
