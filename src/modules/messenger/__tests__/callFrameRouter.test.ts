import {
  isCallFrame,
  CALL_FRAME_EVENTS,
  isGroupRingFrame,
  GROUP_RING_FRAME_EVENTS,
} from '../runtime/callFrameRouter';
import {GROUP_RING_FRAME_EVENTS as DISPATCHER_RING_EVENTS} from '../webrtc/groupCallRingDispatcher';

/**
 * Regression for the mid-call upgrade hang: the runtime's
 * `handleServerFrame` dispatcher gate was missing `call.reoffer` and
 * `call.reanswer`, so voice → video upgrades stalled ~8 s then rolled
 * back (the reanswer never reached the dispatcher). The gateway and
 * callDispatcher both already handled the events; only the runtime
 * gate was wrong.
 */
describe('isCallFrame — runtime dispatcher gate', () => {
  describe('initial 1:1 call lifecycle', () => {
    it.each([
      'call.offer',
      'call.answer',
      'call.ice',
      'call.hangup',
    ])('routes %s through the call dispatcher', (eventName) => {
      expect(isCallFrame(eventName)).toBe(true);
    });
  });

  describe('mid-call control / renegotiation', () => {
    it('routes call.media-state (BS-021 peer mute/camera advisory)', () => {
      expect(isCallFrame('call.media-state')).toBe(true);
    });

    it('REGRESSION — routes call.reoffer for voice→video upgrade', () => {
      // Was missing → upgrade hang.
      expect(isCallFrame('call.reoffer')).toBe(true);
    });

    it('REGRESSION — routes call.reanswer for voice→video upgrade', () => {
      // Was missing → upgrade hang.
      expect(isCallFrame('call.reanswer')).toBe(true);
    });
  });

  describe('non-call frames must NOT be routed', () => {
    it.each([
      'envelope.deliver',
      'envelope.accepted',
      'envelope.delivered',
      'envelope.ack',
      'pong',
      'presence',
      'typing',
      'read-receipt',
      // SFU events route through a separate dispatcher.
      'sfu.new-producer',
      'sfu.participant.joined',
      'sfu.participant.left',
      // Bogus / unknown
      'totally.fake.event',
      '',
    ])('does not route %s', (eventName) => {
      expect(isCallFrame(eventName)).toBe(false);
    });
  });

  it('exports the call frame set for callers that want to enumerate', () => {
    expect(CALL_FRAME_EVENTS instanceof Set).toBe(true);
    // Lock in the exact membership so a future delete is caught.
    expect(Array.from(CALL_FRAME_EVENTS).sort()).toEqual([
      'call.answer',
      'call.hangup',
      'call.ice',
      'call.media-state',
      'call.missed',   // SFU-12 — missed-call record on expired offer
      'call.offer',
      'call.reanswer',
      'call.reoffer',
    ]);
  });
});

/**
 * B-602 — the LIVE group-ring frames must bypass the runtime's depsReady
 * buffer exactly like 1:1 call frames do (they only navigate/dedup/ack — no
 * SQLCipher deps). `sfu.ring.missed` is NOT one of them (it writes a bubble,
 * needs the store, stays buffered). The productionRuntime buffer gate that
 * consumes `isGroupRingFrame` is pinned by a source scan (no test can import
 * productionRuntime) — see groupRingDepsReadyBypass.test.ts.
 */
describe('isGroupRingFrame — group-ring depsReady bypass eligibility (B-602)', () => {
  it.each([
    'sfu.ring.incoming',
    'sfu.ring.cancelled',
    'sfu.ring.declined',
  ])('exempts the live ring frame %s from the buffer', (eventName) => {
    expect(isGroupRingFrame(eventName)).toBe(true);
  });

  it.each([
    // The missed-call writer needs the store — it must STAY buffered.
    'sfu.ring.missed',
    // Room-scoped SFU frames route through sfuDispatcher, not here.
    'sfu.new-producer',
    'sfu.participant.joined',
    'sfu.muted',
    // 1:1 call frames are a different predicate.
    'call.offer',
    // Non-call frames must stay buffered until deps are ready.
    'envelope.deliver',
    'presence',
    'totally.fake.event',
    '',
  ])('does NOT exempt %s', (eventName) => {
    expect(isGroupRingFrame(eventName)).toBe(false);
  });

  it('locks in the exact live-ring membership', () => {
    expect(Array.from(GROUP_RING_FRAME_EVENTS).sort()).toEqual([
      'sfu.ring.cancelled',
      'sfu.ring.declined',
      'sfu.ring.incoming',
    ]);
  });

  it('the group-ring dispatcher routes on the SAME set — single source, no drift', () => {
    // groupCallRingDispatcher re-exports the set from callFrameRouter; if a
    // future edit re-inlines its own copy, this identity check fails.
    expect(DISPATCHER_RING_EVENTS).toBe(GROUP_RING_FRAME_EVENTS);
  });
});
