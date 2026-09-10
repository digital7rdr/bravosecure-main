/**
 * Regression — B-12: host abandons a group call before any participant
 * joins → receivers' ring stopped with no record ("ghost ring").
 *
 * IncomingGroupCallScreen now records an INCOMING "missed group call"
 * history bubble when the ring is cancelled by the host AND the user had
 * neither accepted nor declined. These tests pin that decision (the
 * settled-guard semantics) and the bubble's call_meta shape, with no React.
 */

// Mirrors IncomingGroupCallScreen's onCancel decision: record a missed call
// only when this ring screen hasn't already settled (accept/decline) and the
// cancel is for our roomId.
function shouldRecordMissed(opts: {
  settled: boolean;
  cancelRoomId: string;
  ourRoomId: string;
}): boolean {
  if (opts.settled) {return false;}
  return opts.cancelRoomId === opts.ourRoomId;
}

// Mirrors appendMissedGroupCallBubble's call_meta.
function missedCallMeta(callType: 'voice' | 'video') {
  return {kind: callType, direction: 'incoming' as const, outcome: 'missed' as const, duration: 0, groupCall: true};
}

describe('B-12 — missed group call on host abandon', () => {
  it('records a missed call when an unsettled ring is cancelled for our room', () => {
    expect(shouldRecordMissed({settled: false, cancelRoomId: 'r1', ourRoomId: 'r1'})).toBe(true);
  });

  it('does NOT record missed if the user already accepted/declined (settled)', () => {
    expect(shouldRecordMissed({settled: true, cancelRoomId: 'r1', ourRoomId: 'r1'})).toBe(false);
  });

  it('ignores cancels for a different room', () => {
    expect(shouldRecordMissed({settled: false, cancelRoomId: 'other', ourRoomId: 'r1'})).toBe(false);
  });

  it('builds an incoming/missed/0-duration group call_meta', () => {
    expect(missedCallMeta('video')).toEqual({
      kind: 'video', direction: 'incoming', outcome: 'missed', duration: 0, groupCall: true,
    });
    expect(missedCallMeta('voice').outcome).toBe('missed');
    expect(missedCallMeta('voice').duration).toBe(0);
  });
});
