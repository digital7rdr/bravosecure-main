/**
 * Audit row #5 (C1/C2/C3 + #6) — SFU + call.offer authority unit tests.
 *
 * The gateway is heavy to bring up fully (mediasoup workers, Redis
 * adapter, real socket.io server) so these tests stub the deps the
 * authority paths actually touch:
 *   - RoomTokenService.issue/verify   (HMAC binding)
 *   - SfuService.hostOf               (cancel/ring host check)
 *   - SfuService.bindFanout           (constructor side effect only)
 *
 * Scope:
 *   - sfu.ring rejects non-host                                  (C3)
 *   - sfu.ring rejects too-many recipients                       (C3)
 *   - sfu.ring.cancel rejects non-host                           (C2)
 *   - sfu.ring.decline rejects when secret-set + no token        (C2)
 *   - sfu.ring.decline admits valid (roomId, callerId) token     (C2)
 *   - call.offer rejects when `auth` is missing                  (#6)
 */
import {ConfigService} from '@nestjs/config';
import {Logger} from '@nestjs/common';
import {MessengerGateway} from './messenger.gateway';
import {RoomTokenService} from '../sfu/room-token.service';

const SECRET = 'sfu-room-token-secret-at-least-32-chars-long';

// Minimal SfuService stub — covers only what the authority gates need.
function stubSfu(opts: {
  host?: string | null;
  participants?: string[];
  tagOwners?: Record<string, {roomId: string; userId: string}>;
}) {
  return {
    bindFanout:          () => { /* no-op */ },
    hostOf:              () => opts.host ?? null,
    participantsInRoom:  () => [] as string[],
    // B-334 — the ring gate admits current room participants, not only the host.
    isParticipantUser:   (_rid: string, uid: string) => (opts.participants ?? []).includes(uid),
    // B-238 — an admitted ring-cancel ends the (empty) room.
    endRoomIfEmptyByHost: jest.fn(() => false),
    // Only consulted for tags parked in the post-disconnect leave grace.
    resolveParticipantUser: (tag: string) => (opts.tagOwners ?? {})[tag] ?? null,
    // Reached only by the ordinary tag path of handleSfuLeave (a caller who
    // really is in the room); the orphan-reap branch never gets here.
    leaveRoom: jest.fn(async (tag: string) => ({removedTags: [tag]})),
  } as unknown as import('../sfu/sfu.service').SfuService;
}

// Minimal hub stub — emits are recorded so we can assert ring fan-out
// when authority passes, OR is empty when it fails.
function stubHub() {
  const emits: Array<{room: string; event: string; data: unknown}> = [];
  const server = {
    to: (room: string) => ({
      emit: (event: string, data: unknown) => emits.push({room, event, data}),
    }),
  };
  return {
    obj:   {server, userRoom: (uid: string) => `u:${uid}`} as unknown as import('./socket-hub').SocketHub,
    emits,
  };
}

function stubPush() {
  return {
    sendVoipWake:   async () => ({sent: 0, stubbed: false}),
    // P2-15 — sfu.ring.cancel now fires a cancel push per target.
    sendCallCancel: async () => 0,
  } as unknown as import('../push/push.service').PushService;
}

function tokenService(secret: string = SECRET): RoomTokenService {
  const cfg: Partial<ConfigService> = {
    get: (k: string) => (k === 'sfu.roomTokenSecret' ? secret : undefined) as unknown,
  };
  return new RoomTokenService(cfg as ConfigService);
}

// Construct a gateway with the stubs above. We only test the public
// handlers — JwtService, ConnectionRegistry, EnvelopeService, Redis
// are never reached by the authority paths under test.
function makeGateway(opts: {
  host?:         string | null;
  secret?:       string;
  participants?: string[];
  tagOwners?:    Record<string, {roomId: string; userId: string}>;
}): {
  gw: MessengerGateway;
  emits: Array<{room: string; event: string; data: unknown}>;
  sfu: import('../sfu/sfu.service').SfuService;
} {
  const hub = stubHub();
  const rts = tokenService(opts.secret ?? SECRET);
  const sfu = stubSfu({
    host:         opts.host ?? null,
    participants: opts.participants,
    tagOwners:    opts.tagOwners,
  });
  const gw = new MessengerGateway(
    /* jwt        */ {} as never,
    /* registry   */ {} as never,
    /* hub        */ hub.obj,
    /* presence   */ {} as never,
    /* envelopes  */ {} as never,
    /* push       */ stubPush(),
    /* sfu        */ sfu,
    /* redis      */ {} as never,
    /* roomToken  */ rts,
    // P1-11 — handleSfuRing now block-filters targets; default: nobody blocked.
    /* privacy    */ {isBlockedEither: async () => false} as never,
  );
  // Silence the gateway logger so test output stays clean.
  (gw as unknown as {logger: Logger}).logger = {
    log:   () => {}, warn: () => {}, error: () => {}, debug: () => {}, verbose: () => {},
  } as unknown as Logger;
  return {gw, emits: hub.emits, sfu};
}

function fakeClient(callerId: string): import('socket.io').Socket {
  return {
    id:   'sock-1',
    data: {
      claims:         {sub: callerId},
      signalDeviceId: 1,
    },
    // Only the ordinary (has-a-tag) leave path touches socket rooms; the
    // orphan-reap branch returns before this. No-ops so both are reachable.
    join:  () => {},
    leave: () => {},
  } as unknown as import('socket.io').Socket;
}

// ─── C3: sfu.ring host check + recipient cap ──────────────────────────

describe('MessengerGateway.handleSfuRing — audit row #5 (C3)', () => {
  it('rejects non-host caller with not_host', async () => {
    const {gw, emits} = makeGateway({host: 'user-real-host'});
    const result = await gw.handleSfuRing(
      {
        roomId:           'room-aaa',
        conversationId:   'conv-1',
        callType:         'voice',
        callerName:       'Eve',
        recipientUserIds: ['user-victim'],
      },
      fakeClient('user-attacker'),
    );
    // sfuError() helper wraps the symbolic code into `message` and
    // uses a generic `code: 'sfu_error'` envelope. The discriminator
    // for the actual rejection reason is the `message` field.
    expect(result).toEqual({ok: false, data: {code: 'sfu_error', message: 'not_host'}});
    expect(emits).toEqual([]); // no fanout
  });

  it('rejects when hostOf returns null (unknown / reaped room)', async () => {
    const {gw, emits} = makeGateway({host: null});
    const result = await gw.handleSfuRing(
      {
        roomId:           'room-ghost',
        conversationId:   'conv-1',
        callType:         'voice',
        callerName:       'Anyone',
        recipientUserIds: ['user-someone'],
      },
      fakeClient('user-anyone'),
    );
    expect(result).toEqual({ok: false, data: {code: 'sfu_error', message: 'not_host'}});
    expect(emits).toEqual([]);
  });

  it('rejects too_many_targets when recipient list exceeds 250', async () => {
    const {gw, emits} = makeGateway({host: 'user-host'});
    const big = Array.from({length: 251}, (_, i) => `user-${i}`);
    const result = await gw.handleSfuRing(
      {
        roomId:           'room-aaa',
        conversationId:   'conv-1',
        callType:         'voice',
        callerName:       'Host',
        recipientUserIds: big,
      },
      fakeClient('user-host'),
    );
    expect(result).toEqual({
      ok:   false,
      data: {code: 'sfu_error', message: 'too_many_targets'},
    });
    expect(emits).toEqual([]);
  });

  it('B-334 — admits a CURRENT PARTICIPANT (non-host) so in-call members can add people', async () => {
    // Founder repro 2026-07-29 (relay log): two in-room participants pressed
    // "Add" and got not_host — the invitee's phone never rang. A participant
    // only EXISTS because the host's ring admitted them (per-recipient HMAC
    // room token), so ring authority still descends from the host: the C3
    // anti-spam anchor is preserved, outsiders below stay rejected.
    const {gw, emits} = makeGateway({host: 'user-host', participants: ['user-member']});
    const result = await gw.handleSfuRing(
      {
        roomId:           'room-aaa',
        conversationId:   'conv-1',
        callType:         'voice',
        callerName:       'Member',
        recipientUserIds: ['user-invitee'],
      },
      fakeClient('user-member'),
    );
    expect(result).toEqual({ok: true, ringId: expect.any(String)}); // WI-6.7 — the fan-out acks its id
    expect(emits.filter(e => e.event === 'sfu.ring.incoming')).toHaveLength(1);
  });

  it('B-334 — an OUTSIDER (not host, not participant) is still rejected (C3 preserved)', async () => {
    const {gw, emits} = makeGateway({host: 'user-host', participants: ['user-member']});
    const result = await gw.handleSfuRing(
      {
        roomId:           'room-aaa',
        conversationId:   'conv-1',
        callType:         'voice',
        callerName:       'Eve',
        recipientUserIds: ['user-victim'],
      },
      fakeClient('user-outsider'),
    );
    expect(result).toEqual({ok: false, data: {code: 'sfu_error', message: 'not_host'}});
    expect(emits).toEqual([]);
  });

  it('never rings a member who is ALREADY IN the room', async () => {
    /**
     * 2026-08-12 — a caller who taps Call now rings even when they were
     * handed an existing room (previously only the room's creator rang, once
     * at boot). That makes "ring somebody already in the call" reachable two
     * ordinary ways: two people tapping Call inside the room's setup grace,
     * and a client whose relay predates the `live` field treating every
     * entry as a fresh call.
     *
     * For a member sitting in the call with the app foregrounded the stray
     * ring is invisible — the client suppresses a ring for the room it is
     * already in. But a MINIMIZED member gets a VoIP wake and a full-screen
     * incoming-call notification for the call they are on, and the fan-out
     * also writes a missed-call marker that nothing clears on join, so they
     * later get a "missed group call" for a call they answered.
     *
     * The relay is the only party that knows the room's real occupancy, so
     * the filter has to live here.
     */
    const {gw, emits} = makeGateway({host: 'user-host', participants: ['user-host', 'user-bob']});
    const result = await gw.handleSfuRing(
      {
        roomId:           'room-aaa',
        conversationId:   'conv-1',
        callType:         'voice',
        callerName:       'Host',
        // bob is already in the call; carol is not.
        recipientUserIds: ['user-bob', 'user-carol'],
      },
      fakeClient('user-host'),
    );
    expect(result).toEqual({ok: true, ringId: expect.any(String)}); // WI-6.7 — the fan-out acks its id
    const rings = emits.filter(e => e.event === 'sfu.ring.incoming');
    expect(rings).toHaveLength(1);
    expect(rings[0].room).toBe('u:user-carol');
  });

  it('STILL rings a member whose socket dropped, even though their tag lingers', async () => {
    /**
     * The counterweight to the filter above, and the more dangerous half.
     *
     * On a socket disconnect the mediasoup participant is deliberately held
     * for SFU_LEAVE_GRACE_MS (10s) so a fast reconnect keeps media alive
     * (SFU-04). For those ten seconds someone whose phone just dropped off
     * Wi-Fi still reads as "in the room" — so a naive
     * `isParticipantUser` filter would make the host's Re-ring or Add return
     * `{ok: true}` while that member is never rung. A relay reporting a
     * successful fan-out to a user whose phone stayed silent is exactly
     * B-336, the worst failure shape this subsystem has.
     */
    const {gw, emits} = makeGateway({
      host:         'user-host',
      participants: ['user-host', 'user-bob'],
      tagOwners:    {'tag-bob': {roomId: 'room-aaa', userId: 'user-bob'}},
    });
    // Bob's socket died; his tag is parked in the grace map awaiting teardown.
    (gw as unknown as {sfuLeaveGrace: Map<string, unknown>})
      .sfuLeaveGrace.set('tag-bob', setTimeout(() => {}, 0));

    const result = await gw.handleSfuRing(
      {
        roomId:           'room-aaa',
        conversationId:   'conv-1',
        callType:         'voice',
        callerName:       'Host',
        recipientUserIds: ['user-bob'],
      },
      fakeClient('user-host'),
    );
    expect(result).toEqual({ok: true, ringId: expect.any(String)}); // WI-6.7 — the fan-out acks its id
    const rings = emits.filter(e => e.event === 'sfu.ring.incoming');
    expect(rings).toHaveLength(1);
    expect(rings[0].room).toBe('u:user-bob');
  });

  it('admits host caller within the cap', async () => {
    const {gw, emits} = makeGateway({host: 'user-host'});
    const result = await gw.handleSfuRing(
      {
        roomId:           'room-aaa',
        conversationId:   'conv-1',
        callType:         'voice',
        callerName:       'Host',
        recipientUserIds: ['user-bob', 'user-carol'],
      },
      fakeClient('user-host'),
    );
    expect(result).toEqual({ok: true, ringId: expect.any(String)}); // WI-6.7 — the fan-out acks its id
    // Two recipients → two ring fanouts.
    expect(emits.filter(e => e.event === 'sfu.ring.incoming')).toHaveLength(2);
  });
});

// ─── C2: sfu.ring.cancel host gate + token verify ─────────────────────

describe('MessengerGateway.handleSfuLeave — orphan-room reap (2026-08-12)', () => {
  /**
   * A group-call boot creates the room at step 1 and joins at step 3. Any
   * failure in between leaves a room whose host is this user and whose
   * participant set is empty, and NOTHING reaped it: `sfu.leave` matched no
   * participant tag, so the handler returned early. The relay then advertised
   * that corpse to every other member for the fresh-room grace, and the next
   * person to tap Call was routed into a dead room.
   *
   * These were previously untested territory — `handleSfuLeave` had no spec
   * at all.
   */
  it('reaps a never-joined room for the caller who created it', async () => {
    const {gw, sfu} = makeGateway({host: 'user-host'});
    const client = fakeClient('user-host');
    // No tags on this socket at all — the boot died before sfu.join. This is
    // precisely why the reap must sit ABOVE the `if (!tags) return` guard.
    await gw.handleSfuLeave({roomId: 'room-aaa'}, client);

    expect(sfu.endRoomIfEmptyByHost).toHaveBeenCalledWith('room-aaa', 'user-host');
  });

  it('does NOT attempt a reap for a caller who is in the room', async () => {
    const {gw, sfu} = makeGateway({
      host:      'user-host',
      tagOwners: {'tag-host': {roomId: 'room-aaa', userId: 'user-host'}},
    });
    const client = fakeClient('user-host');
    (gw as unknown as {sfuSocketTags: Map<unknown, Set<string>>})
      .sfuSocketTags.set(client, new Set(['tag-host']));

    await gw.handleSfuLeave({roomId: 'room-aaa'}, client);

    // A real participant leaving takes the ordinary tag path — which runs
    // hostTerminatesRoom. Routing it through the orphan branch as well would
    // double-handle the teardown.
    expect(sfu.endRoomIfEmptyByHost).not.toHaveBeenCalled();
  });

  it('leaves the authority decision to the service — a non-host is refused there', async () => {
    /**
     * The gateway does not re-implement the check. `endRoomIfEmptyByHost`
     * independently requires `hostUserId === byUserId` AND an empty room, so
     * a non-host's leave reaches it and is refused. Asserting the call (not a
     * gateway-side gate) is what keeps the two from drifting apart.
     */
    const {gw, sfu} = makeGateway({host: 'user-host'});
    await gw.handleSfuLeave({roomId: 'room-aaa'}, fakeClient('user-someone-else'));

    expect(sfu.endRoomIfEmptyByHost).toHaveBeenCalledWith('room-aaa', 'user-someone-else');
    // The stub reports refusal, mirroring the real guard.
    expect((sfu.endRoomIfEmptyByHost as jest.Mock).mock.results[0].value).toBe(false);
  });

  it('does nothing when the frame carries no roomId', async () => {
    const {gw, sfu} = makeGateway({host: 'user-host'});
    await gw.handleSfuLeave({} as never, fakeClient('user-host'));
    expect(sfu.endRoomIfEmptyByHost).not.toHaveBeenCalled();
  });
});

describe('MessengerGateway.handleSfuRingCancel — audit row #5 (C2)', () => {
  it('rejects non-host with not_host', () => {
    const {gw, emits} = makeGateway({host: 'user-real-host'});
    const result = gw.handleSfuRingCancel(
      {
        roomId:           'room-aaa',
        conversationId:   'conv-1',
        recipientUserIds: ['user-victim'],
      },
      fakeClient('user-attacker'),
    );
    expect(result).toEqual({ok: false, data: {code: 'sfu_error', message: 'not_host'}});
    expect(emits).toEqual([]);
  });

  it('rejects host with mismatched token (binding to wrong room)', () => {
    const rts = tokenService();
    const {token} = rts.issue('room-OTHER', 'user-host');
    const {gw, emits} = makeGateway({host: 'user-host'});
    const result = gw.handleSfuRingCancel(
      {
        roomId:           'room-aaa',
        conversationId:   'conv-1',
        recipientUserIds: ['user-victim'],
        roomToken:        token,
      },
      fakeClient('user-host'),
    );
    expect('ok' in result && result.ok).toBe(false);
  });

  it('admits host with valid token + fans cancel to recipients', () => {
    const rts = tokenService();
    const {token} = rts.issue('room-aaa', 'user-host');
    const {gw, emits} = makeGateway({host: 'user-host'});
    const result = gw.handleSfuRingCancel(
      {
        roomId:           'room-aaa',
        conversationId:   'conv-1',
        recipientUserIds: ['user-victim-a', 'user-victim-b'],
        roomToken:        token,
      },
      fakeClient('user-host'),
    );
    expect(result).toEqual({ok: true});
    expect(emits.filter(e => e.event === 'sfu.ring.cancelled')).toHaveLength(2);
  });

  it('admitted cancel ends the empty room so a call-back creates fresh (B-238)', () => {
    const rts = tokenService();
    const {token} = rts.issue('room-aaa', 'user-host');
    const {gw} = makeGateway({host: 'user-host'});
    const endRoom = (gw as unknown as {sfu: {endRoomIfEmptyByHost: jest.Mock}}).sfu.endRoomIfEmptyByHost;
    const result = gw.handleSfuRingCancel(
      {
        roomId:           'room-aaa',
        conversationId:   'conv-1',
        recipientUserIds: ['user-victim'],
        roomToken:        token,
      },
      fakeClient('user-host'),
    );
    expect(result).toEqual({ok: true});
    expect(endRoom).toHaveBeenCalledWith('room-aaa', 'user-host');
  });

  it('rejected cancel never touches the room (B-238)', () => {
    const {gw} = makeGateway({host: 'user-real-host'});
    const endRoom = (gw as unknown as {sfu: {endRoomIfEmptyByHost: jest.Mock}}).sfu.endRoomIfEmptyByHost;
    gw.handleSfuRingCancel(
      {
        roomId:           'room-aaa',
        conversationId:   'conv-1',
        recipientUserIds: ['user-victim'],
      },
      fakeClient('user-attacker'),
    );
    expect(endRoom).not.toHaveBeenCalled();
  });
});

// ─── C2: sfu.ring.decline token gate ──────────────────────────────────

describe('MessengerGateway.handleSfuRingDecline — audit row #5 (C2)', () => {
  it('rejects missing token when secret is configured', () => {
    const {gw} = makeGateway({});
    const result = gw.handleSfuRingDecline(
      {roomId: 'room-aaa', conversationId: 'conv-1'},
      fakeClient('user-bob'),
    );
    expect('ok' in result && result.ok).toBe(false);
    expect(result).toMatchObject({data: {code: 'sfu_error', message: 'room_token_required'}});
  });

  it('rejects token bound to a different user (borrowed token)', () => {
    const rts = tokenService();
    // Alice's ring token, replayed by Bob.
    const {token} = rts.issue('room-aaa', 'user-alice');
    const {gw} = makeGateway({});
    const result = gw.handleSfuRingDecline(
      {roomId: 'room-aaa', conversationId: 'conv-1', roomToken: token},
      fakeClient('user-bob'),
    );
    expect('ok' in result && result.ok).toBe(false);
  });

  it('admits the actual ring recipient with their valid token', () => {
    const rts = tokenService();
    const {token} = rts.issue('room-aaa', 'user-bob');
    const {gw} = makeGateway({});
    const result = gw.handleSfuRingDecline(
      {roomId: 'room-aaa', conversationId: 'conv-1', roomToken: token},
      fakeClient('user-bob'),
    );
    expect(result).toEqual({ok: true});
  });
});

// ─── Row #6: call.offer rejects missing auth ──────────────────────────

describe('MessengerGateway.handleCallOffer — audit row #6', () => {
  it('rejects missing offer.auth with missing_offer_auth', async () => {
    const {gw} = makeGateway({});
    // call.offer requires several Socket harness internals (rate limit
    // gate, trackCallStart, forwardToDevice). We stub the parts that
    // would run BEFORE / AFTER the new auth check so the test exercises
    // only the new branch. rateGate is private; bypass by stubbing.
    (gw as unknown as {rateGate: () => null}).rateGate = () => null;
    const result = await gw.handleCallOffer(
      {
        callId:  'call-1',
        to:      {userId: 'user-victim', deviceId: 1},
        sdp:     'v=0...',
        kind:    'voice',
        // auth: undefined  ← the gap row #6 closed
      } as never,
      fakeClient('user-attacker'),
    );
    expect(result).toEqual({
      event: 'error',
      data:  {code: 'missing_offer_auth', message: 'call.offer requires auth block'},
    });
  });
});
