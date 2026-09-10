/**
 * 2026-07-10 audit-wave gateway call fixes:
 *  - P1-11    block (M-07) enforced on calls: call.offer silent-drop +
 *             sfu.ring target filtering (no forward, no queue, no VoIP wake)
 *  - P1-14    callee DECLINE clears the DECLINER's queued Redis artifacts,
 *             not data.to (the caller)
 *  - P1-15/P2-13  clearPendingCallArtifacts keeps the pending-offer index
 *             entry when keeping the missed-marker (reconnect drain reachable)
 *  - P1-BR-5  active 1:1 calls get a disconnect grace window; ringing
 *             sessions keep the immediate bye; reconnect cancels the timer
 *  - P2-3     sfu.ring is rate-limited
 *  - P2-BR-8  1:1 VoIP wake reads data.kind (callType fallback)
 *  - P3-P-1   sfu.join fails CLOSED in production when the room-token
 *             secret is unset
 *  - P1-BR-3  declineCallViaHttp fan-out (backs POST /calls/:callId/decline)
 *
 * Same harness style as the privacy/sfu-auth specs: handlers invoked off the
 * prototype with a hand-built `this`, or a fully-constructed gateway with
 * stubbed deps where the path touches constructor wiring.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import type {Socket} from 'socket.io';
import {ConfigService} from '@nestjs/config';
import {Logger} from '@nestjs/common';
import {MessengerGateway} from './messenger.gateway';
import {RoomTokenService} from '../sfu/room-token.service';

const proto: any = MessengerGateway.prototype;

const ME = 'me-user';
const PEER = 'peer-user';

// SRV-03 — `connected` matters now: the non-destructive drains stop emitting
// (and stop removing) the moment the target socket is no longer live.
function fakeClient(sub = ME, deviceId = 7, connected = true): Socket & {emit: jest.Mock; join: jest.Mock} {
  return {
    id:   `sock-${sub}`,
    data: {claims: {sub}, signalDeviceId: deviceId, sessionId: `s-${sub}`},
    connected,
    emit: jest.fn(),
    join: jest.fn(async () => undefined),
  } as unknown as Socket & {emit: jest.Mock; join: jest.Mock};
}

// ─── P1-11: call.offer block enforcement + P2-BR-8 wake kind ─────────────

describe('P1-11 — handleCallOffer block enforcement (M-07 on calls)', () => {
  function offerThis(opts: {blocked: boolean}) {
    const redisClient: any = {
      set:    jest.fn(async () => 'OK'),
      sadd:   jest.fn(async () => 1),
      expire: jest.fn(async () => 1),
    };
    // AUDIT Phase-0 item 5 — offer-queue writes ride ONE MULTI; forward the
    // chained commands into the same recorders so `set`/`sadd` call
    // assertions (both the not-called blocked case and the called cases)
    // keep observing identical shapes. `execResult` is overridable per test
    // (the partial-failure pin below); default = 4 clean [null, reply] pairs
    // matching the real shape. multiCalled pins that the writes actually
    // ride a MULTI (reverting to sequential awaits must fail loudly).
    redisClient.multiCalled = false;
    redisClient.execResult = [[null, 'OK'], [null, 'OK'], [null, 1], [null, 1]];
    redisClient.multi = () => {
      redisClient.multiCalled = true;
      const chain: any = {
        set:    (...a: unknown[]) => { void redisClient.set(...a);    return chain; },
        sadd:   (...a: unknown[]) => { void redisClient.sadd(...a);   return chain; },
        expire: (...a: unknown[]) => { void redisClient.expire(...a); return chain; },
        exec:   async () => redisClient.execResult,
      };
      return chain;
    };
    const push = {sendVoipWake: jest.fn(async () => ({sent: 1, stubbed: false}))};
    // B-596 (audit Step 1): the offer handler now registers the session BEFORE
    // the privacy await and reads it back after, so the harness carries the
    // REAL session bookkeeping (a bare jest.fn for trackCallStart would leave
    // the map empty and the handler would treat the call as hung up).
    const self: any = {
      rateGate:        () => null,
      privacy:         {isBlockedEither: jest.fn(async () => opts.blocked)},
      callSessions:    new Map(),
      socketCalls:     new WeakMap(),
      gcCallTombstones:    proto.gcCallTombstones,
      untrackCallSilently: proto.untrackCallSilently,
      privacyGateBounded:  proto.privacyGateBounded,
      trackCallStart:  jest.fn(proto.trackCallStart),
      forwardToDevice: jest.fn(async () => undefined),
      push,
      redis: {client: redisClient},
    };
    return {self, redisClient, push};
  }

  const offer = (kind?: string, extra: Record<string, unknown> = {}) => ({
    callId: 'call-0001',
    to:     {userId: PEER, deviceId: 1},
    sdp:    'v=0',
    kind,
    auth:   {v: 1} as never,
    ...extra,
  });

  it('silent-drops when blocked: no error, no track, no forward, no queue, no wake', async () => {
    const {self, redisClient, push} = offerThis({blocked: true});
    const ret = await proto.handleCallOffer.call(self, offer('voice'), fakeClient());
    expect(ret).toBeUndefined();                       // no block oracle to the caller
    // B-596: the session is registered BEFORE the gate (so ICE cannot outrun
    // it) and untracked SILENTLY on a blocked pair — no session remains, no
    // tombstone, so a retried callId is a never-seen one (no duplicate oracle).
    expect(self.callSessions.size).toBe(0);
    expect(self.forwardToDevice).not.toHaveBeenCalled();
    expect(redisClient.set).not.toHaveBeenCalled();    // no pending offer, no marker
    expect(redisClient.sadd).not.toHaveBeenCalled();
    expect(push.sendVoipWake).not.toHaveBeenCalled();  // killed device never rings
    expect(self.privacy.isBlockedEither).toHaveBeenCalledWith(ME, PEER);
  });

  it('unblocked offer still forwards, queues, and wakes', async () => {
    const {self, redisClient, push} = offerThis({blocked: false});
    await proto.handleCallOffer.call(self, offer('voice'), fakeClient());
    expect(self.trackCallStart).toHaveBeenCalled();
    expect(self.forwardToDevice).toHaveBeenCalled();
    expect(redisClient.set).toHaveBeenCalled();
    expect(push.sendVoipWake).toHaveBeenCalled();
    // rev-2 (O6): the queue writes must ride a MULTI — sequential awaits
    // reintroduce torn offer/index/marker state on a blip.
    expect(redisClient.multiCalled).toBe(true);
  });

  it('REV-2 (critic): a PARTIAL in-EXEC failure must NOT suppress peer_offline (queued stays false)', async () => {
    // ioredis exec() RESOLVES with per-command [err, reply] pairs; only
    // queue-time/connection errors reject. Pre-fix, `queued` was set true
    // unconditionally after exec — so a failed sadd left the offer invisible
    // to the reconnect drain while the caller sat in "calling…" forever.
    const offline = {event: 'error', data: {code: 'peer_offline', message: 'callee not connected'}};

    // Clean exec → queued → suppressed (the designed offline-queue flow).
    const ok = offerThis({blocked: false});
    ok.self.forwardToDevice = jest.fn(async () => offline) as never;
    const suppressed = await proto.handleCallOffer.call(ok.self, offer('voice'), fakeClient());
    expect(suppressed).toBeUndefined();

    // sadd fails INSIDE exec → queued=false → peer_offline surfaces.
    const bad = offerThis({blocked: false});
    bad.self.forwardToDevice = jest.fn(async () => offline) as never;
    bad.redisClient.execResult = [[null, 'OK'], [null, 'OK'], [new Error('WRONGTYPE'), null], [null, 1]];
    const surfaced = await proto.handleCallOffer.call(bad.self, offer('voice'), fakeClient());
    expect((surfaced as {data: {code: string}}).data.code).toBe('peer_offline');

    // exec resolves null (EXECABORT shape) → also NOT success.
    const aborted = offerThis({blocked: false});
    aborted.self.forwardToDevice = jest.fn(async () => offline) as never;
    aborted.redisClient.execResult = null;
    const surfaced2 = await proto.handleCallOffer.call(aborted.self, offer('voice'), fakeClient());
    expect((surfaced2 as {data: {code: string}}).data.code).toBe('peer_offline');
  });

  it('REV-2 (edge O5): ONLY the ICE leg skips the online probe (source pin)', () => {
    // The D-4 behavioural tests drive forwardToDevice directly, so a one-token
    // edit wiring skipOnlineProbe onto the offer/answer/hangup legs would
    // pass them. Pin at the source: exactly ONE skip site, inside call.ice.
    // Comments stripped FIRST (CLAUDE.md: strip before any ordering/absence
    // assertion — a prose mention of `event: 'call.ice'` near a site must not
    // be able to satisfy the presence half, nor a mention of `call.offer`
    // falsely trip the absence half).
    const src = (require('node:fs').readFileSync(
      require('node:path').join(__dirname, 'messenger.gateway.ts'), 'utf8') as string)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\r\n]*/g, '');
    // B-596 (audit Step 1) widened this from ONE site to TWO: the second is
    // handleCallOffer's flush of candidates HELD while the offer was in flight
    // — still `call.ice` frames. The invariant is unchanged ("only ICE frames
    // skip the probe"): every occurrence must sit on a `call.ice` builder.
    const occurrences = [...src.matchAll(/skipOnlineProbe: true/g)].map(m => m.index ?? -1);
    expect(occurrences).toHaveLength(2);
    for (const at of occurrences) {
      const window = src.slice(Math.max(0, at - 300), at);
      expect(window).toContain("event: 'call.ice'");
      expect(window).not.toContain("event: 'call.offer'");
      expect(window).not.toContain("event: 'call.answer'");
      expect(window).not.toContain("event: 'call.hangup'");
    }
    const iceStart = src.indexOf("@SubscribeMessage('call.ice')");
    const nextHandler = src.indexOf('@SubscribeMessage', iceStart + 10);
    const iceBody = src.slice(iceStart, nextHandler);
    expect(iceBody).toContain('skipOnlineProbe: true');
  });

  it('P2-BR-8: wake kind comes from data.kind — video offer wakes as video', async () => {
    const {self, push} = offerThis({blocked: false});
    await proto.handleCallOffer.call(self, offer('video'), fakeClient());
    expect(push.sendVoipWake).toHaveBeenCalledWith(PEER, 'call-0001', ME, undefined, 'video');
  });

  it('P2-BR-8: voice offer wakes as voice; legacy callType still honoured', async () => {
    const {self, push} = offerThis({blocked: false});
    await proto.handleCallOffer.call(self, offer('voice'), fakeClient());
    expect(push.sendVoipWake).toHaveBeenCalledWith(PEER, 'call-0001', ME, undefined, 'voice');

    const {self: s2, push: p2} = offerThis({blocked: false});
    await proto.handleCallOffer.call(s2, offer(undefined, {callType: 'video'}), fakeClient());
    expect(p2.sendVoipWake).toHaveBeenCalledWith(PEER, 'call-0001', ME, undefined, 'video');
  });

  // SRV-06 (F4) — a budget-denied wake is surfaced in the [CALL] stream but
  // must never alter call setup: the offer is still queued, the handler's
  // return shape is unchanged, and no unhandled rejection escapes.
  it('SRV-06 — a budget-denied wake is log-only: offer return unchanged, deny logged', async () => {
    const {self, redisClient, push} = offerThis({blocked: false});
    push.sendVoipWake.mockResolvedValueOnce(
      {sent: 0, stubbed: false, reason: 'pair_budget_exhausted'} as never,
    );
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ret = await proto.handleCallOffer.call(self, offer('voice'), fakeClient());
      expect(ret).toBeUndefined();                     // queued-offer return shape unchanged
      expect(self.forwardToDevice).toHaveBeenCalled();
      expect(redisClient.set).toHaveBeenCalled();      // pending offer + marker still queued
      await new Promise(res => setImmediate(res));     // let the fire-and-forget .then() land
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('wake-throttled'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('pair_budget_exhausted'));
    } finally {
      warn.mockRestore();
    }
  });

  it('SRV-06 — a delivered wake (no reason field) logs nothing extra', async () => {
    const {self, push} = offerThis({blocked: false});
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await proto.handleCallOffer.call(self, offer('voice'), fakeClient());
      await new Promise(res => setImmediate(res));
      expect(push.sendVoipWake).toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

// ─── P1-15 / P2-13: srem stays inside the keepMarker guard ───────────────

describe('P1-15/P2-13 — clearPendingCallArtifacts keepMarker keeps the index', () => {
  function clearThis() {
    const del  = jest.fn(async () => 1);
    const srem = jest.fn(async () => 1);
    // WI-6.3 — the clear rides one MULTI now; forward the chain into the
    // same recorders so the keepMarker/index assertions observe identically.
    const client: any = {del, srem};
    client.multi = () => {
      const queued: Array<() => Promise<unknown>> = [];
      const chain: any = {
        del:  (k: string) => { queued.push(() => client.del(k)); return chain; },
        srem: (k: string, m: string) => { queued.push(() => client.srem(k, m)); return chain; },
        exec: async () => { const out: Array<[null, unknown]> = []; for (const op of queued) out.push([null, await op()]); return out; },
      };
      return chain;
    };
    return {self: {redis: {client}, logger: {log: jest.fn(), warn: jest.fn()}}, del, srem};
  }

  it('keepMarker: deletes ONLY the offer payload — marker AND index survive', async () => {
    const {self, del, srem} = clearThis();
    await proto.clearPendingCallArtifacts.call(self, 'u1', 2, 'c1', {keepMarker: true});
    expect(del).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith('pending-call-offer:u1:2:c1');
    // The reconnect call.missed drain enumerates ONLY the index — it must
    // stay reachable while the marker is kept.
    expect(srem).not.toHaveBeenCalled();
  });

  it('default: deletes payload + marker + index entry', async () => {
    const {self, del, srem} = clearThis();
    await proto.clearPendingCallArtifacts.call(self, 'u1', 2, 'c1');
    expect(del).toHaveBeenCalledWith('pending-call-offer:u1:2:c1');
    expect(del).toHaveBeenCalledWith('missed-call-marker:u1:2:c1');
    expect(srem).toHaveBeenCalledWith('pending-call-offer-idx:u1:2', 'c1');
  });
});

// ─── P1-14: decline clears the DECLINER's keys, not data.to ──────────────

describe('P1-14 — handleCallHangup targets the ringing callee\'s artifacts', () => {
  const CALLER = 'caller-user';
  const CALLEE = 'callee-user';

  function hangupThis(state: 'ringing' | 'active') {
    const session = {
      callId:    'c1',
      caller:    {userId: CALLER, deviceId: 3},
      callee:    {userId: CALLEE, deviceId: 7},
      state,
      createdAt: Date.now(),
    };
    const clearPendingCallArtifacts = jest.fn(async () => undefined);
    const push = {sendCallCancel: jest.fn(async () => 0)};
    const self = {
      rateGate:           () => null,
      callSessions:       new Map([[session.callId, session]]),
      authorizeCallFrame: proto.authorizeCallFrame,
      trackCallEnd:       proto.trackCallEnd,
      gcCallTombstones:   proto.gcCallTombstones,
      clearPendingCallArtifacts,
      forwardToDevice:    jest.fn(async () => undefined),
      push,
    };
    return {self, session, clearPendingCallArtifacts, push};
  }

  it('callee DECLINE clears the callee\'s own keys (keepMarker=false) — not the caller\'s', async () => {
    const {self, clearPendingCallArtifacts, push} = hangupThis('ringing');
    // Decline: FROM the callee, addressed TO the caller (data.to = caller).
    await proto.handleCallHangup.call(
      self,
      {callId: 'c1', to: {userId: CALLER, deviceId: 3}, reason: 'declined'},
      fakeClient(CALLEE, 7),
    );
    // Pre-fix this hit (CALLER, 3) — the caller's non-existent keys — leaving
    // the callee's 6h marker + index alive → phantom "Missed call" + ghost ring.
    expect(clearPendingCallArtifacts).toHaveBeenCalledWith(
      CALLEE, 7, 'c1', {keepMarker: false},
    );
    // KO-2 (B-566) — a decline is not a caller-gave-up, so it must never
    // fan a MISSED cancel — but the decliner's OTHER devices are still
    // ringing from the VoIP wake, and only the HTTP decline lane used to
    // collapse them. The WS lane now sends the same missed=false cancel.
    expect(push.sendCallCancel).toHaveBeenCalledTimes(1);
    expect(push.sendCallCancel).toHaveBeenCalledWith(CALLEE, 'c1', CALLER, 'voice', /*missed*/ false);
    expect(self.forwardToDevice).toHaveBeenCalled(); // hangup still relayed
  });

  it('caller gives up on unanswered ring: callee keys cleared with keepMarker + cancel push to callee', async () => {
    const {self, clearPendingCallArtifacts, push} = hangupThis('ringing');
    await proto.handleCallHangup.call(
      self,
      {callId: 'c1', to: {userId: CALLEE, deviceId: 7}, reason: 'cancelled'},
      fakeClient(CALLER, 3),
    );
    expect(clearPendingCallArtifacts).toHaveBeenCalledWith(
      CALLEE, 7, 'c1', {keepMarker: true},
    );
    expect(push.sendCallCancel).toHaveBeenCalledWith(CALLEE, 'c1', CALLER, 'voice', true);
  });

  it('hangup of an ACTIVE call clears the callee\'s keys without keeping a marker', async () => {
    const {self, clearPendingCallArtifacts, push} = hangupThis('active');
    await proto.handleCallHangup.call(
      self,
      {callId: 'c1', to: {userId: CALLER, deviceId: 3}, reason: 'ended'},
      fakeClient(CALLEE, 7),
    );
    expect(clearPendingCallArtifacts).toHaveBeenCalledWith(
      CALLEE, 7, 'c1', {keepMarker: false},
    );
    expect(push.sendCallCancel).not.toHaveBeenCalled();
  });
});

// ─── P1-BR-5: disconnect grace for ACTIVE calls ──────────────────────────

describe('P1-BR-5 — disconnect grace for connected 1:1 calls (B-58 server half)', () => {
  const GRACE_MS = 12_000;

  function disconnectThis(state: 'ringing' | 'active') {
    const emit = jest.fn();
    const session = {
      callId:    'c1',
      caller:    {userId: ME, deviceId: 7},
      callee:    {userId: PEER, deviceId: 1},
      state,
      createdAt: Date.now(),
    };
    const client = fakeClient(ME, 7);
    const socketCalls = new WeakMap<object, Set<string>>();
    socketCalls.set(client, new Set(['c1']));
    const self = {
      registry:                  {remove: jest.fn(() => true)},
      clearTypingTimersFrom:     jest.fn(),
      sfuSocketTags:             new WeakMap(),
      sfuLeaveGrace:             new Map(),
      socketCalls,
      callSessions:              new Map([[session.callId, session]]),
      callDisconnectGrace:       new Map(),
      scheduleCallDisconnectBye: proto.scheduleCallDisconnectBye,
      cancelCallDisconnectByes:  proto.cancelCallDisconnectByes,
      trackCallEnd:              proto.trackCallEnd,
      hub: {
        deviceRoom: (a: {userId: string; deviceId: number}) => `u:${a.userId}:${a.deviceId}`,
        server:     {to: () => ({emit})},
      },
      presence: {onDisconnect: jest.fn(async () => false), set: jest.fn()},
      logger:   {log: () => {}, warn: () => {}, error: () => {}},
    };
    return {self, client, emit, session};
  }

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('ACTIVE call: no immediate bye; bye fires after the grace window', async () => {
    const {self, client, emit, session} = disconnectThis('active');
    await proto.handleDisconnect.call(self, client);
    expect(emit).not.toHaveBeenCalled();               // survives the blip
    expect(session.state).toBe('active');              // not tombstoned yet
    expect(self.callDisconnectGrace.size).toBe(1);

    jest.advanceTimersByTime(GRACE_MS);
    expect(emit).toHaveBeenCalledWith('call.hangup', {
      callId: 'c1', from: {userId: ME, deviceId: 7}, reason: 'failed',
    });
    expect(session.state).toBe('ended');
    expect(self.callDisconnectGrace.size).toBe(0);
  });

  it('same-device reconnect within grace cancels the bye — call survives', async () => {
    const {self, client, emit, session} = disconnectThis('active');
    await proto.handleDisconnect.call(self, client);
    // handleConnection runs this for the reconnecting (user, device).
    proto.cancelCallDisconnectByes.call(self, ME, 7);
    jest.advanceTimersByTime(GRACE_MS * 2);
    expect(emit).not.toHaveBeenCalled();
    expect(session.state).toBe('active');
    expect(self.callDisconnectGrace.size).toBe(0);
  });

  it('peer hangup during grace makes the deferred bye a no-op', async () => {
    const {self, client, emit, session} = disconnectThis('active');
    await proto.handleDisconnect.call(self, client);
    proto.trackCallEnd.call(self, 'c1');               // peer ended it meanwhile
    emit.mockClear();
    jest.advanceTimersByTime(GRACE_MS);
    expect(emit).not.toHaveBeenCalled();               // no duplicate bye
    expect(session.state).toBe('ended');
  });

  it('RINGING call keeps the immediate bye (no grace)', async () => {
    const {self, client, emit, session} = disconnectThis('ringing');
    await proto.handleDisconnect.call(self, client);
    expect(emit).toHaveBeenCalledWith('call.hangup', {
      callId: 'c1', from: {userId: ME, deviceId: 7}, reason: 'failed',
    });
    expect(session.state).toBe('ended');
    expect(self.callDisconnectGrace.size).toBe(0);
  });
});

// ─── P1-BR-3: declineCallViaHttp fan-out ─────────────────────────────────

describe('P1-BR-3 — declineCallViaHttp (POST /calls/:callId/decline backing)', () => {
  const CALLER = 'caller-user';

  function declineThis(opts: {host?: string | null; withSession?: boolean} = {}) {
    const emits: Array<{room: string; event: string; data: unknown}> = [];
    const session = {
      callId:    'c1',
      caller:    {userId: CALLER, deviceId: 3},
      callee:    {userId: ME, deviceId: 7},
      state:     'ringing' as const,
      createdAt: Date.now(),
    };
    const clearPendingCallArtifacts = jest.fn(async () => undefined);
    const clearPendingGroupRingArtifacts = jest.fn(async () => undefined);
    const push = {sendCallCancel: jest.fn(async () => 0)};
    const self = {
      hub: {
        userRoom: (uid: string) => `u:${uid}`,
        server: {
          to: (room: string) => ({
            emit: (event: string, data: unknown) => emits.push({room, event, data}),
          }),
        },
      },
      sfu:          {hostOf: () => opts.host ?? null},
      callSessions: new Map(opts.withSession === false ? [] : [[session.callId, session]]),
      trackCallEnd: proto.trackCallEnd,
      clearPendingCallArtifacts,
      clearPendingGroupRingArtifacts,
      push,
    };
    return {self, emits, session, clearPendingCallArtifacts, clearPendingGroupRingArtifacts, push};
  }

  it('direct: hangup{declined} to the caller, artifacts cleared for the DECLINER, cancel push to own devices', async () => {
    const {self, emits, session, clearPendingCallArtifacts, push} = declineThis();
    await proto.declineCallViaHttp.call(
      self, {userId: ME, deviceId: 7}, 'c1', {peerUserId: CALLER, kind: 'direct'},
    );
    expect(emits).toContainEqual({
      room:  `u:${CALLER}`,
      event: 'call.hangup',
      data:  {callId: 'c1', from: {userId: ME, deviceId: 7}, reason: 'declined'},
    });
    expect(session.state).toBe('ended');               // in-flight frames stop relaying
    // P1-14 addressing — the decliner's own keys, marker dropped.
    expect(clearPendingCallArtifacts).toHaveBeenCalledWith(ME, 7, 'c1');
    expect(push.sendCallCancel).toHaveBeenCalledWith(ME, 'c1', CALLER, 'voice', false);
  });

  it('direct: idempotent when the call is already gone (no session, no throw)', async () => {
    const {self, emits} = declineThis({withSession: false});
    await expect(proto.declineCallViaHttp.call(
      self, {userId: ME, deviceId: 7}, 'ghost-call', {peerUserId: CALLER},
    )).resolves.toBeUndefined();
    expect(emits).toContainEqual(expect.objectContaining({event: 'call.hangup'}));
  });

  it('group: ring-declined to the host + member ring artifacts cleared', async () => {
    const {self, emits, clearPendingGroupRingArtifacts} = declineThis({host: 'host-user'});
    await proto.declineCallViaHttp.call(
      self, {userId: ME, deviceId: 7}, 'room-1', {kind: 'group', roomId: 'room-1'},
    );
    expect(emits).toContainEqual({
      room:  'u:host-user',
      event: 'sfu.ring.declined',
      data:  {roomId: 'room-1', conversationId: '', from: {userId: ME, deviceId: 7}},
    });
    expect(clearPendingGroupRingArtifacts).toHaveBeenCalledWith(ME, 'room-1');
  });

  it('group: room already gone (no host) → artifacts still cleared, no emit, no throw', async () => {
    const {self, emits, clearPendingGroupRingArtifacts} = declineThis({host: null});
    await proto.declineCallViaHttp.call(
      self, {userId: ME, deviceId: 7}, 'room-1', {kind: 'group'},
    );
    expect(emits).toEqual([]);
    expect(clearPendingGroupRingArtifacts).toHaveBeenCalledWith(ME, 'room-1'); // roomId falls back to callId
  });
});

// ─── Fully-constructed gateway: sfu.ring block filter, rate limit, join gate ──

const SECRET = 'sfu-room-token-secret-at-least-32-chars-long';

function tokenService(secret: string): RoomTokenService {
  const cfg: Partial<ConfigService> = {
    get: (k: string) => (k === 'sfu.roomTokenSecret' ? secret : undefined) as unknown,
  };
  return new RoomTokenService(cfg as ConfigService);
}

function makeGateway(opts: {
  host?:    string | null;
  secret?:  string;
  blocked?: (uid: string) => boolean;
  joinRoom?: jest.Mock;
  isParticipantUser?: (roomId: string, uid: string) => boolean;
  redis?:   unknown;
}) {
  const emits: Array<{room: string; event: string; data: unknown}> = [];
  const hub = {
    server: {
      to: (room: string) => ({
        emit: (event: string, data: unknown) => emits.push({room, event, data}),
      }),
    },
    userRoom: (uid: string) => `u:${uid}`,
  };
  const wakes: Array<{uid: string; kind?: string; conversationId?: string}> = [];
  const push = {
    sendVoipWake:   jest.fn(async (uid: string, _cid: string, _from: string, _tok?: string, kind?: string, conversationId?: string) => {
      wakes.push({uid, kind, conversationId});
      return {sent: 1, stubbed: false};
    }),
    sendCallCancel: jest.fn(async () => 0),
  };
  const sfu = {
    bindFanout: () => { /* no-op */ },
    hostOf:     () => opts.host ?? null,
    joinRoom:   opts.joinRoom ?? jest.fn(async () => ({participantTag: 'tag-1'})),
    // B-238 — ring-cancel reaps a still-empty room so a member redial can't
    // hit the not_host corpse; the real service guards emptiness itself.
    endRoomIfEmptyByHost: jest.fn(),
    // handleSfuRing now asks this PER RECIPIENT, to avoid ringing someone
    // who is already in the room. It used to be reachable only via the
    // `mayRing` gate, which `host === callerId` short-circuits — so these
    // host-caller tests never needed it and the stub omitted it. Default
    // false: nobody in these fixtures is a participant.
    isParticipantUser: opts.isParticipantUser ?? (() => false),
  };
  const gw = new MessengerGateway(
    /* jwt        */ {} as never,
    /* registry   */ {} as never,
    /* hub        */ hub as never,
    /* presence   */ {} as never,
    /* envelopes  */ {} as never,
    /* push       */ push as never,
    /* sfu        */ sfu as never,
    // rev-3 (critic): `{} as never` made the ENTIRE ring-queue lane inert —
    // multi() threw into the best-effort catch and DELETING the lane ran
    // 535/535 green. Callers that assert queue state pass a ring-capable
    // fake via opts.redis.
    /* redis      */ (opts.redis ?? {}) as never,
    /* roomToken  */ tokenService(opts.secret ?? SECRET),
    /* privacy    */ {isBlockedEither: async (_a: string, b: string) => opts.blocked?.(b) ?? false} as never,
  );
  (gw as unknown as {logger: Logger}).logger = {
    log: () => {}, warn: () => {}, error: () => {}, debug: () => {}, verbose: () => {},
  } as unknown as Logger;
  // clearInterval the P0-6 recheck so Jest doesn't leak the handle.
  gw.onModuleDestroy();
  return {gw, emits, push, wakes, sfu};
}

describe('P1-11 — handleSfuRing filters blocked targets (WS ring + VoIP wake)', () => {
  it('rings only unblocked members; blocked user gets neither frame nor wake', async () => {
    const {gw, emits, wakes} = makeGateway({
      host:    'user-host',
      blocked: uid => uid === 'user-blocked',
    });
    const result = await gw.handleSfuRing(
      {
        roomId:           'room-aaa',
        conversationId:   'conv-1',
        callType:         'voice',
        callerName:       'Host',
        recipientUserIds: ['user-blocked', 'user-ok'],
      },
      fakeClient('user-host', 1),
    );
    expect(result).toEqual({ok: true, ringId: expect.any(String)});
    const rings = emits.filter(e => e.event === 'sfu.ring.incoming');
    expect(rings).toHaveLength(1);
    expect(rings[0].room).toBe('u:user-ok');
    expect(wakes.map(w => w.uid)).toEqual(['user-ok']);
  });

  it('all-blocked recipient list is a silent no-op success', async () => {
    const {gw, emits, wakes} = makeGateway({host: 'user-host', blocked: () => true});
    const result = await gw.handleSfuRing(
      {
        roomId:           'room-aaa',
        conversationId:   'conv-1',
        callType:         'voice',
        callerName:       'Host',
        recipientUserIds: ['user-blocked'],
      },
      fakeClient('user-host', 1),
    );
    expect(result).toEqual({ok: true});                // no oracle
    expect(emits.filter(e => e.event === 'sfu.ring.incoming')).toHaveLength(0);
    expect(wakes).toEqual([]);
  });
});

describe('P2-3 — sfu.ring is rate-limited per socket', () => {
  it('rejects with rate_limited once the burst budget is spent', async () => {
    const {gw} = makeGateway({host: 'user-host'});
    const client = fakeClient('user-host', 1);
    const frame = {
      roomId:           'room-aaa',
      conversationId:   'conv-1',
      callType:         'voice' as const,
      callerName:       'Host',
      recipientUserIds: [] as string[],               // no fan-out side effects
    };
    for (let i = 0; i < 5; i++) {
      expect(await gw.handleSfuRing(frame, client)).toEqual({ok: true});
    }
    expect(await gw.handleSfuRing(frame, client)).toEqual({
      ok: false, data: {code: 'sfu_error', message: 'rate_limited'},
    });
  });
});

describe('P3-P-1 — sfu.join fails CLOSED in production without a token secret', () => {
  const OLD_ENV = process.env.NODE_ENV;
  afterEach(() => { process.env.NODE_ENV = OLD_ENV; });

  it('production + unset secret → tokenless join rejected, never admitted', async () => {
    process.env.NODE_ENV = 'production';
    const joinRoom = jest.fn(async () => ({participantTag: 'tag-1'}));
    const {gw} = makeGateway({secret: '', joinRoom});
    const result = await gw.handleSfuJoin({roomId: 'room-aaa'}, fakeClient('user-bob', 1));
    expect(result).toEqual({
      ok: false, data: {code: 'room_token_required', message: 'room_token_required'},
    });
    expect(joinRoom).not.toHaveBeenCalled();
  });

  it('non-prod + unset secret still admits (dev/legacy compat)', async () => {
    process.env.NODE_ENV = 'test';
    const joinRoom = jest.fn(async () => ({participantTag: 'tag-1'}));
    const {gw} = makeGateway({secret: '', joinRoom});
    const result = await gw.handleSfuJoin({roomId: 'room-aaa'}, fakeClient('user-bob', 1));
    expect(joinRoom).toHaveBeenCalledWith('room-aaa', 'user-bob');
    expect(result).toEqual({participantTag: 'tag-1'});
  });

  it('secret set + missing token stays a hard reject (regression guard)', async () => {
    const joinRoom = jest.fn(async () => ({participantTag: 'tag-1'}));
    const {gw} = makeGateway({joinRoom});
    const result = await gw.handleSfuJoin({roomId: 'room-aaa'}, fakeClient('user-bob', 1));
    expect(result).toEqual({
      ok: false, data: {code: 'room_token_required', message: 'room_token_required'},
    });
    expect(joinRoom).not.toHaveBeenCalled();
  });
});

// ─── P2-15: host cancel sends the cancel push + clears queued rings ──────

describe('P2-15 — sfu.ring.cancel cancel-push parity for killed devices', () => {
  it('host cancel fans the WS frame AND the N-02-style cancel push per target', () => {
    const rts = tokenService(SECRET);
    const {token} = rts.issue('room-aaa', 'user-host');
    const {gw, emits, push} = makeGateway({host: 'user-host'});
    const result = gw.handleSfuRingCancel(
      {
        roomId:           'room-aaa',
        conversationId:   'conv-1',
        recipientUserIds: ['user-a', 'user-b'],
        roomToken:        token,
      },
      fakeClient('user-host', 1),
    );
    expect(result).toEqual({ok: true});
    expect(emits.filter(e => e.event === 'sfu.ring.cancelled')).toHaveLength(2);
    expect(push.sendCallCancel).toHaveBeenCalledTimes(2);
    expect(push.sendCallCancel).toHaveBeenCalledWith('user-a', 'room-aaa', 'user-host', 'voice', false, undefined);
    expect(push.sendCallCancel).toHaveBeenCalledWith('user-b', 'room-aaa', 'user-host', 'voice', false, undefined);
  });
});

// ─── SRV-04: the group VoIP wake carries the ring conversationId ─────────

describe('SRV-04 — group VoIP wake carries the ring conversationId', () => {
  it('passes conversationId as the 6th arg of sendVoipWake', async () => {
    const {gw, emits, push, wakes} = makeGateway({host: 'user-host'});
    const result = await gw.handleSfuRing(
      {
        roomId:           'room-aaa',
        conversationId:   'conv-1',
        callType:         'video',
        callerName:       'Host',
        recipientUserIds: ['user-ok'],
      },
      fakeClient('user-host', 1),
    );
    expect(result).toEqual({ok: true, ringId: expect.any(String)});
    expect(wakes).toEqual([{uid: 'user-ok', kind: 'group-video', conversationId: 'conv-1'}]);
    // positional — an arity slip must fail here
    expect(push.sendVoipWake.mock.calls[0][5]).toBe('conv-1');
    const ring = emits.find(e => e.event === 'sfu.ring.incoming');
    expect((ring?.data as {conversationId?: string}).conversationId).toBe('conv-1');
  });

  it('carries the same conversationId to every fan-out target', async () => {
    const {gw, wakes} = makeGateway({host: 'user-host'});
    await gw.handleSfuRing(
      {
        roomId:           'room-aaa',
        conversationId:   'conv-1',
        callType:         'voice',
        callerName:       'Host',
        recipientUserIds: ['user-a', 'user-b'],
      },
      fakeClient('user-host', 1),
    );
    expect(wakes).toEqual([
      {uid: 'user-a', kind: 'group-voice', conversationId: 'conv-1'},
      {uid: 'user-b', kind: 'group-voice', conversationId: 'conv-1'},
    ]);
  });

  it('drops an oversize conversationId from the wake but keeps the WS frame intact', async () => {
    const huge = 'x'.repeat(200);
    const {gw, emits, push, wakes} = makeGateway({host: 'user-host'});
    await gw.handleSfuRing(
      {
        roomId:           'room-aaa',
        conversationId:   huge,
        callType:         'voice',
        callerName:       'Host',
        recipientUserIds: ['user-ok'],
      },
      fakeClient('user-host', 1),
    );
    expect(wakes).toEqual([{uid: 'user-ok', kind: 'group-voice', conversationId: undefined}]);
    expect(push.sendVoipWake.mock.calls[0][5]).toBeUndefined();
    const ring = emits.find(e => e.event === 'sfu.ring.incoming');
    expect((ring?.data as {conversationId?: string}).conversationId).toBe(huge);
  });
});

// ─── GW-3 / SRV-06: a throttled group wake is surfaced, never disruptive ──

describe('SRV-06 — group wake-throttle deny is log-only', () => {
  it('a denied wake logs [SFU] wake-throttled and the ring still succeeds', async () => {
    const {gw, emits, push} = makeGateway({host: 'user-host'});
    const warn = jest.fn();
    (gw as any).logger.warn = warn;
    push.sendVoipWake.mockResolvedValueOnce(
      {sent: 0, stubbed: false, reason: 'pair_budget_exhausted'} as never,
    );
    const result = await gw.handleSfuRing(
      {
        roomId:           'room-aaa',
        conversationId:   'conv-1',
        callType:         'voice',
        callerName:       'Host',
        recipientUserIds: ['user-ok'],
      },
      fakeClient('user-host', 1),
    );
    expect(result).toEqual({ok: true, ringId: expect.any(String)});                                       // ring unaffected
    expect(emits.filter(e => e.event === 'sfu.ring.incoming')).toHaveLength(1); // WS frame still fans
    await new Promise(res => setImmediate(res));       // let the fire-and-forget .then() land
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('wake-throttled'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('pair_budget_exhausted'));
  });
});

// ─── GW-2 shared drain harness (SRV-02 + SRV-03) ─────────────────────────
//
// Map-backed fake ioredis: enough of the surface for the peek/emit/remove
// drains plus `runWithReplicaLock`'s `SET … EX … NX` claim.

const CALLER = {userId: 'A', deviceId: 1};
const CALLEE = {userId: 'B', deviceId: 7};

function makeFakeRedis() {
  const kv   = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const client = {
    async smembers(key: string) { return [...(sets.get(key) ?? [])]; },
    async mget(...keys: string[]) { return keys.map(k => (kv.has(k) ? kv.get(k)! : null)); },
    async get(key: string) { return kv.has(key) ? kv.get(key)! : null; },
    async del(key: string) { const had = kv.delete(key) || sets.delete(key); return had ? 1 : 0; },
    async sadd(key: string, ...members: string[]) {
      let s = sets.get(key);
      if (!s) { s = new Set(); sets.set(key, s); }
      for (const m of members) s.add(m);
      return members.length;
    },
    async srem(key: string, ...members: string[]) {
      const s = sets.get(key);
      if (!s) return 0;
      let n = 0;
      for (const m of members) { if (s.delete(m)) n++; }
      if (s.size === 0) sets.delete(key);
      return n;
    },
    async set(key: string, val: string, ...args: unknown[]) {
      if (args.includes('NX') && kv.has(key)) return null;
      kv.set(key, val);
      return 'OK';
    },
    async expire(_key: string, _ttl: number) { return 1; },
    // WI-6.3 — the artifact CLEAR paths ride one MULTI; forward the chained
    // commands into the same kv/sets stores so the survival assertions keep
    // observing real state.
    multi() {
      const queued: Array<() => Promise<unknown>> = [];
      const chain = {
        del:  (k: string) => { queued.push(() => client.del(k)); return chain; },
        srem: (k: string, ...m: string[]) => { queued.push(() => client.srem(k, ...m)); return chain; },
        set:  (k: string, v: string, ...a: unknown[]) => { queued.push(() => client.set(k, v, ...a)); return chain; },
        sadd: (k: string, ...m: string[]) => { queued.push(() => client.sadd(k, ...m)); return chain; },
        expire: (k: string, t: number) => { queued.push(() => client.expire(k, t)); return chain; },
        async exec() {
          const out: Array<[null, unknown]> = [];
          for (const op of queued) out.push([null, await op()]);
          return out;
        },
      };
      return chain;
    },
  };
  return {kv, sets, client};
}

function offerRecord(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    callId: 'call-1', from: CALLER, sdp: 'v=0', kind: 'voice',
    at: Date.now(), auth: {v: 1, sig: 'sig-b64'},
    ...over,
  });
}

function markerRecord(over: Record<string, unknown> = {}) {
  return JSON.stringify({callId: 'call-1', from: CALLER, kind: 'voice', at: Date.now() - 60_000, ...over});
}

/** `this` for the 1:1 drain — real drain/rehydrate/gc, spied removal. */
function drainThis(redis: ReturnType<typeof makeFakeRedis>, callSessions = new Map<string, any>()) {
  const self: any = {
    redis:                    {client: redis.client},
    logger:                   {log: jest.fn(), warn: jest.fn()},
    callSessions,
    socketCalls:              new WeakMap<object, Set<string>>(),
    gcCallTombstones:         proto.gcCallTombstones,
    rehydrateCallSession:     proto.rehydrateCallSession,
    drainPendingCallOffers:   proto.drainPendingCallOffers,
    drainPendingGroupRings:   proto.drainPendingGroupRings,
  };
  // Delegate to the REAL removal helpers so index/marker survival is asserted
  // against actual Redis state, not just against the spy.
  self.clearPendingCallArtifacts = jest.fn((...a: any[]) => proto.clearPendingCallArtifacts.apply(self, a));
  self.clearPendingGroupRingArtifacts = jest.fn((...a: any[]) => proto.clearPendingGroupRingArtifacts.apply(self, a));
  return self;
}

const IDX_KEY     = 'pending-call-offer-idx:B:7';
const OFFER_KEY   = 'pending-call-offer:B:7:call-1';
const MARKER_KEY  = 'missed-call-marker:B:7:call-1';

// ─── SRV-02: a replayed offer is answerable ──────────────────────────────

describe('SRV-02 — replayed offers are answerable', () => {
  function seedFreshOffer() {
    const redis = makeFakeRedis();
    redis.sets.set(IDX_KEY, new Set(['call-1']));
    redis.kv.set(OFFER_KEY, offerRecord());
    redis.kv.set(MARKER_KEY, markerRecord());
    return redis;
  }

  it('the replay re-registers the in-memory session from the persisted offer', async () => {
    const redis = seedFreshOffer();
    const self = drainThis(redis);
    const client = fakeClient('B', 7);

    await proto.deliverPendingCallOffer.call(self, client, CALLEE);

    expect(self.callSessions.get('call-1')).toEqual({
      callId: 'call-1', caller: CALLER, callee: CALLEE,
      state: 'ringing', createdAt: expect.any(Number), rehydrated: true,
    });
    const offerEmit = client.emit.mock.calls.find(c => c[0] === 'call.offer');
    expect(offerEmit).toBeDefined();
    // S7 auth block replayed verbatim.
    expect(offerEmit![1].auth).toEqual({v: 1, sig: 'sig-b64'});
  });

  it('the answer that follows a replay is forwarded (was silently dropped)', async () => {
    const redis = seedFreshOffer();
    const drain = drainThis(redis);
    await proto.deliverPendingCallOffer.call(drain, fakeClient('B', 7), CALLEE);

    const answerSelf: any = {
      rateGate:                 () => null,
      gcCallTombstones:         proto.gcCallTombstones,
      authorizeCallFrame:       proto.authorizeCallFrame,
      trackCallAnswer:          proto.trackCallAnswer,
      callSessions:             drain.callSessions,       // SAME map
      socketCalls:              new WeakMap<object, Set<string>>(),
      clearPendingCallArtifacts: jest.fn(async () => undefined),
      forwardToDevice:          jest.fn(async () => undefined),
      queuePendingAnswer:       jest.fn(),
      push:                     {sendCallCancel: jest.fn(() => Promise.resolve(1))},
    };
    await proto.handleCallAnswer.call(
      answerSelf, {callId: 'call-1', to: CALLER, sdp: 'v=0'}, fakeClient('B', 7),
    );
    expect(answerSelf.forwardToDevice).toHaveBeenCalled();
    expect(answerSelf.forwardToDevice.mock.calls[0][1]).toEqual(CALLER);
  });

  it('pre-fix shape: with no session the answer is dropped and never forwarded', async () => {
    const answerSelf: any = {
      rateGate:                 () => null,
      gcCallTombstones:         proto.gcCallTombstones,
      authorizeCallFrame:       proto.authorizeCallFrame,
      trackCallAnswer:          proto.trackCallAnswer,
      callSessions:             new Map(),                 // session lost to the restart
      socketCalls:              new WeakMap<object, Set<string>>(),
      clearPendingCallArtifacts: jest.fn(async () => undefined),
      forwardToDevice:          jest.fn(async () => undefined),
      queuePendingAnswer:       jest.fn(),
      push:                     {sendCallCancel: jest.fn(() => Promise.resolve(1))},
    };
    const ret = await proto.handleCallAnswer.call(
      answerSelf, {callId: 'call-1', to: CALLER, sdp: 'v=0'}, fakeClient('B', 7),
    );
    expect(ret).toBeUndefined();
    expect(answerSelf.forwardToDevice).not.toHaveBeenCalled();
  });

  it('never clobbers a live session', async () => {
    const redis = seedFreshOffer();
    const sessions = new Map<string, any>([['call-1', {
      callId: 'call-1', caller: CALLER, callee: CALLEE, state: 'active', createdAt: 123,
    }]]);
    const self = drainThis(redis, sessions);
    await proto.deliverPendingCallOffer.call(self, fakeClient('B', 7), CALLEE);
    expect(sessions.get('call-1')!.state).toBe('active');
    expect(sessions.get('call-1')!.createdAt).toBe(123);
  });

  it('an ended tombstone skips the replay AND keeps the missed-marker', async () => {
    const redis = seedFreshOffer();
    const sessions = new Map<string, any>([['call-1', {
      callId: 'call-1', caller: CALLER, callee: CALLEE,
      state: 'ended', createdAt: Date.now(), endedAt: Date.now(),
    }]]);
    const self = drainThis(redis, sessions);
    const client = fakeClient('B', 7);

    await proto.deliverPendingCallOffer.call(self, client, CALLEE);

    expect(client.emit.mock.calls.find(c => c[0] === 'call.offer')).toBeUndefined();
    expect(sessions.get('call-1')!.state).toBe('ended');
    // The tombstone path must not settle the entry — settling would delete the
    // marker and destroy the missed-call record.
    expect(self.clearPendingCallArtifacts).not.toHaveBeenCalled();
    expect(redis.kv.has(MARKER_KEY)).toBe(true);
  });

  it('rehydration does NOT link socketCalls (no new disconnect-bye path)', async () => {
    const redis = seedFreshOffer();
    const self = drainThis(redis);
    const client = fakeClient('B', 7);
    await proto.deliverPendingCallOffer.call(self, client, CALLEE);
    expect(self.socketCalls.has(client as unknown as object)).toBe(false);
  });

  // A rehydrated session has NO owning socket, so `handleDisconnect` (which is
  // driven entirely by socketCalls) can never end it. Without an age ceiling an
  // ignored replayed ring would sit in `callSessions` for the process lifetime.
  describe('an owner-less rehydrated ring cannot leak forever', () => {
    function gcThis(sessions: Map<string, any>) {
      return {callSessions: sessions} as any;
    }

    it('a stale rehydrated ringing session is tombstoned, then reclaimed', () => {
      const sessions = new Map<string, any>([['call-1', {
        callId: 'call-1', caller: CALLER, callee: CALLEE,
        state: 'ringing', createdAt: Date.now() - 10 * 60_000, rehydrated: true,
      }]]);
      const self = gcThis(sessions);

      proto.gcCallTombstones.call(self);
      expect(sessions.get('call-1')!.state).toBe('ended');

      // Once tombstoned it rides the normal 60s tombstone sweep out of the map.
      sessions.get('call-1')!.endedAt = Date.now() - 61_000;
      proto.gcCallTombstones.call(self);
      expect(sessions.has('call-1')).toBe(false);
    });

    it('a fresh rehydrated ring is left alone', () => {
      const sessions = new Map<string, any>([['call-1', {
        callId: 'call-1', caller: CALLER, callee: CALLEE,
        state: 'ringing', createdAt: Date.now(), rehydrated: true,
      }]]);
      proto.gcCallTombstones.call(gcThis(sessions));
      expect(sessions.get('call-1')!.state).toBe('ringing');
    });

    it('a socket-owned ringing session is never aged out (only rehydrated ones are)', () => {
      const sessions = new Map<string, any>([['call-1', {
        callId: 'call-1', caller: CALLER, callee: CALLEE,
        state: 'ringing', createdAt: Date.now() - 60 * 60_000,
      }]]);
      proto.gcCallTombstones.call(gcThis(sessions));
      expect(sessions.get('call-1')!.state).toBe('ringing');
    });

    it('an answered (active) rehydrated session is never aged out', () => {
      const sessions = new Map<string, any>([['call-1', {
        callId: 'call-1', caller: CALLER, callee: CALLEE,
        state: 'active', createdAt: Date.now() - 60 * 60_000, rehydrated: true,
      }]]);
      proto.gcCallTombstones.call(gcThis(sessions));
      expect(sessions.get('call-1')!.state).toBe('active');
    });
  });

  it('a peer_offline answer is held, not leaked back to the callee', async () => {
    const answerSelf: any = {
      rateGate:                 () => null,
      authorizeCallFrame:       () => ({ok: true, session: {callId: 'call-1', caller: CALLER, callee: CALLEE, state: 'ringing', createdAt: 0}}),
      trackCallAnswer:          jest.fn(),
      clearPendingCallArtifacts: jest.fn(async () => undefined),
      forwardToDevice:          jest.fn(async () => ({event: 'error', data: {code: 'peer_offline', message: 'x'}})),
      queuePendingAnswer:       jest.fn(),
      push:                     {sendCallCancel: jest.fn(() => Promise.resolve(1))},
    };
    const ret = await proto.handleCallAnswer.call(
      answerSelf, {callId: 'call-1', to: CALLER, sdp: 'v=0'}, fakeClient('B', 7),
    );
    expect(ret).toBeUndefined();
    expect(answerSelf.queuePendingAnswer).toHaveBeenCalledWith(
      CALLER, {callId: 'call-1', from: CALLEE, sdp: 'v=0'},
    );
  });

  it('a non-peer_offline error is still returned verbatim and never queued', async () => {
    const err = {event: 'error', data: {code: 'rate_limited', message: 'slow down'}};
    const answerSelf: any = {
      rateGate:                 () => null,
      authorizeCallFrame:       () => ({ok: true, session: {callId: 'call-1', caller: CALLER, callee: CALLEE, state: 'ringing', createdAt: 0}}),
      trackCallAnswer:          jest.fn(),
      clearPendingCallArtifacts: jest.fn(async () => undefined),
      forwardToDevice:          jest.fn(async () => err),
      queuePendingAnswer:       jest.fn(),
      push:                     {sendCallCancel: jest.fn(() => Promise.resolve(1))},
    };
    const ret = await proto.handleCallAnswer.call(
      answerSelf, {callId: 'call-1', to: CALLER, sdp: 'v=0'}, fakeClient('B', 7),
    );
    expect(ret).toBe(err);
    expect(answerSelf.queuePendingAnswer).not.toHaveBeenCalled();
  });

  describe('queued answers flush on the caller\'s reconnect', () => {
    beforeEach(() => { jest.useFakeTimers(); });
    afterEach(() => { jest.useRealTimers(); });

    /**
     * FIX-07 — `call.answer` is no longer only an in-process Map; it has a
     * Redis twin so a service restart or a reconnect landing on ANOTHER replica
     * still delivers it. The holder therefore needs a redis stub and the real
     * durable drain, or the flush is testing half the function.
     */
    function answerHolder(sessionState?: string, redisStore?: Map<string, string>) {
      const callSessions = new Map<string, any>();
      if (sessionState) {
        callSessions.set('call-1', {callId: 'call-1', caller: CALLER, callee: CALLEE, state: sessionState, createdAt: Date.now()});
      }
      const store = redisStore ?? new Map<string, string>();
      const sets = new Map<string, Set<string>>();
      const client = {
        pipeline: () => {
          const ops: Array<() => void> = [];
          const p: any = {
            set: (k: string, v: string) => { ops.push(() => store.set(k, v)); return p; },
            sadd: (k: string, m: string) => {
              ops.push(() => { const s = sets.get(k) ?? new Set(); s.add(m); sets.set(k, s); });
              return p;
            },
            expire: () => p,
            exec: async () => { ops.forEach(op => op()); return []; },
          };
          return p;
        },
        smembers: async (k: string) => Array.from(sets.get(k) ?? []),
        get: async (k: string) => store.get(k) ?? null,
        del: async (k: string) => { store.delete(k); },
        srem: async (k: string, m: string) => { sets.get(k)?.delete(m); },
      };
      return {
        pendingAnswers: new Map(),
        callSessions,
        socketCalls: new Map(),
        logger: {log: jest.fn(), warn: jest.fn()},
        redis: {client},
        flushDurablePendingAnswers: proto.flushDurablePendingAnswers,
        trackCallAnswer: proto.trackCallAnswer,
        __store: store,
        __sets: sets,
      } as any;
    }

    it('a live session gets the answer once, and the slot is released', () => {
      const self = answerHolder('ringing');
      proto.queuePendingAnswer.call(self, CALLER, {callId: 'call-1', from: CALLEE, sdp: 'v=0'});
      expect(self.pendingAnswers.size).toBe(1);

      const caller = fakeClient('A', 1);
      proto.flushPendingAnswers.call(self, caller, CALLER);
      const emitted = caller.emit.mock.calls.filter(c => c[0] === 'call.answer');
      expect(emitted).toHaveLength(1);
      expect(emitted[0][1]).toEqual({callId: 'call-1', from: CALLEE, sdp: 'v=0'});
      expect(self.pendingAnswers.size).toBe(0);
    });

    it('an ended session drops the answer but still releases the slot', () => {
      const self = answerHolder('ended');
      proto.queuePendingAnswer.call(self, CALLER, {callId: 'call-1', from: CALLEE, sdp: 'v=0'});
      const caller = fakeClient('A', 1);
      proto.flushPendingAnswers.call(self, caller, CALLER);
      expect(caller.emit.mock.calls.filter(c => c[0] === 'call.answer')).toHaveLength(0);
      expect(self.pendingAnswers.size).toBe(0);
    });

    it('another device of the same user does not steal the answer', () => {
      const self = answerHolder('ringing');
      proto.queuePendingAnswer.call(self, CALLER, {callId: 'call-1', from: CALLEE, sdp: 'v=0'});
      const other = fakeClient('A', 2);
      proto.flushPendingAnswers.call(self, other, {userId: 'A', deviceId: 2});
      expect(other.emit).not.toHaveBeenCalled();
      expect(self.pendingAnswers.size).toBe(1);
    });

    it('the hold expires after PENDING_ANSWER_TTL_MS', () => {
      const self = answerHolder('ringing');
      proto.queuePendingAnswer.call(self, CALLER, {callId: 'call-1', from: CALLEE, sdp: 'v=0'});
      jest.advanceTimersByTime(15_000);
      expect(self.pendingAnswers.size).toBe(0);
    });

    /**
     * FIX-07 — the durable half. Every OTHER recoverable call event
     * (call.offer, call.missed, the group ring) is Redis-backed; call.answer
     * alone lived in a per-process Map, so a service restart or a reconnect
     * that landed on a different replica silently dropped it and the caller
     * rang on against a call the callee had already picked up.
     */
    describe('FIX-07 — the answer survives a restart / another replica', () => {
      it('persists the answer to Redis, not just the in-process map', async () => {
        const self = answerHolder('ringing');
        proto.queuePendingAnswer.call(self, CALLER, {callId: 'call-1', from: CALLEE, sdp: 'v=0'});
        await Promise.resolve(); await Promise.resolve();

        expect(self.__store.get('pending-call-answer:A:1:call-1')).toBeTruthy();
        expect(Array.from(self.__sets.get('pending-call-answer-idx:A:1') ?? [])).toEqual(['call-1']);
      });

      it('a FRESH replica with an empty map still delivers the queued answer', async () => {
        const shared = new Map<string, string>();
        const queuing = answerHolder('ringing', shared);
        proto.queuePendingAnswer.call(queuing, CALLER, {callId: 'call-1', from: CALLEE, sdp: 'v=0'});
        await Promise.resolve(); await Promise.resolve();

        // Stand up a second gateway over the SAME redis — no in-process slot,
        // exactly what a restart or a second replica looks like.
        const other = answerHolder('ringing', shared);
        other.__sets.set('pending-call-answer-idx:A:1', new Set(['call-1']));
        const caller = fakeClient('A', 1);

        await proto.flushDurablePendingAnswers.call(other, caller, CALLER, new Set());

        const emitted = caller.emit.mock.calls.filter(c => c[0] === 'call.answer');
        expect(emitted).toHaveLength(1);
        expect(emitted[0][1]).toEqual({callId: 'call-1', from: CALLEE, sdp: 'v=0'});
      });

      it('a replica with NO in-memory session REHYDRATES it and still delivers (restart case)', async () => {
        // The audit found the first cut of this drain checked callSessions and
        // settled-without-emitting when the session was absent — but
        // callSessions is in-process and EMPTY after a restart, so the drain
        // deleted the answer in exactly the scenario it was built for. The
        // offer lane already solves this with rehydrateCallSession; the answer
        // lane must do the same (the caller's next frames also need the
        // session to pass authorizeCallFrame).
        const shared = new Map<string, string>();
        const queuing = answerHolder('ringing', shared);
        proto.queuePendingAnswer.call(queuing, CALLER, {callId: 'call-1', from: CALLEE, sdp: 'v=0'});
        await Promise.resolve(); await Promise.resolve();

        const fresh = answerHolder(undefined, shared);   // empty callSessions
        fresh.rehydrateCallSession = proto.rehydrateCallSession;
        fresh.gcCallTombstones = proto.gcCallTombstones;
        fresh.trackCallAnswer = proto.trackCallAnswer;
        fresh.socketCalls = new Map();
        fresh.__sets.set('pending-call-answer-idx:A:1', new Set(['call-1']));
        const caller = fakeClient('A', 1);

        await proto.flushDurablePendingAnswers.call(fresh, caller, CALLER, new Set());

        const emitted = caller.emit.mock.calls.filter(c => c[0] === 'call.answer');
        expect(emitted).toHaveLength(1);
        // The session must exist afterwards or the caller's ICE frames die in
        // authorizeCallFrame as unknown-callId.
        expect(fresh.callSessions.get('call-1')).toBeTruthy();
        // Audit round 2 — 'ringing'+rehydrated is NOT enough: gcCallTombstones
        // force-ends a rehydrated ringing session at REHYDRATED_RING_TTL_MS
        // (300s), which killed the LIVE call five minutes in — hangups stopped
        // reaching the peer and ICE restarts died in authorizeCallFrame. The
        // delivered answer must promote the session to 'active' and link the
        // caller's socket so a drop still fires the disconnect bye.
        expect(fresh.callSessions.get('call-1').state).toBe('active');
        expect(fresh.socketCalls.get(caller)?.has('call-1')).toBe(true);
        // And it was settled — delivered answers must not replay forever.
        expect(fresh.__store.get('pending-call-answer:A:1:call-1')).toBeUndefined();
      });

      it('settles the durable entry after a successful emit', async () => {
        const shared = new Map<string, string>();
        const self = answerHolder('ringing', shared);
        proto.queuePendingAnswer.call(self, CALLER, {callId: 'call-1', from: CALLEE, sdp: 'v=0'});
        await Promise.resolve(); await Promise.resolve();

        await proto.flushDurablePendingAnswers.call(self, fakeClient('A', 1), CALLER, new Set());

        expect(self.__store.get('pending-call-answer:A:1:call-1')).toBeUndefined();
        expect(Array.from(self.__sets.get('pending-call-answer-idx:A:1') ?? [])).toEqual([]);
      });

      it('does not double-emit an answer the in-process pass already sent', async () => {
        const self = answerHolder('ringing');
        proto.queuePendingAnswer.call(self, CALLER, {callId: 'call-1', from: CALLEE, sdp: 'v=0'});
        await Promise.resolve(); await Promise.resolve();
        const caller = fakeClient('A', 1);

        proto.flushPendingAnswers.call(self, caller, CALLER);
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

        expect(caller.emit.mock.calls.filter(c => c[0] === 'call.answer')).toHaveLength(1);
        // …and the durable copy is still cleaned up.
        expect(self.__store.get('pending-call-answer:A:1:call-1')).toBeUndefined();
      });

      it('never resurrects an answer for a call that already ended', async () => {
        const shared = new Map<string, string>();
        const queuing = answerHolder('ringing', shared);
        proto.queuePendingAnswer.call(queuing, CALLER, {callId: 'call-1', from: CALLEE, sdp: 'v=0'});
        await Promise.resolve(); await Promise.resolve();

        const other = answerHolder('ended', shared);
        other.__sets.set('pending-call-answer-idx:A:1', new Set(['call-1']));
        const caller = fakeClient('A', 1);

        await proto.flushDurablePendingAnswers.call(other, caller, CALLER, new Set());

        expect(caller.emit.mock.calls.filter(c => c[0] === 'call.answer')).toHaveLength(0);
        expect(other.__store.get('pending-call-answer:A:1:call-1')).toBeUndefined();
      });

      it('drops an entry whose payload expired past the ring window', async () => {
        const self = answerHolder('ringing');
        // Index survives, payload TTL'd away — a stale answer must not ring.
        self.__sets.set('pending-call-answer-idx:A:1', new Set(['call-1']));
        const caller = fakeClient('A', 1);

        await proto.flushDurablePendingAnswers.call(self, caller, CALLER, new Set());

        expect(caller.emit).not.toHaveBeenCalled();
        expect(Array.from(self.__sets.get('pending-call-answer-idx:A:1') ?? [])).toEqual([]);
      });

      it('a Redis outage while queueing does not lose the same-replica answer', async () => {
        const self = answerHolder('ringing');
        self.redis.client.pipeline = () => { throw new Error('redis down'); };

        proto.queuePendingAnswer.call(self, CALLER, {callId: 'call-1', from: CALLEE, sdp: 'v=0'});
        await Promise.resolve(); await Promise.resolve();

        // The in-process slot is the fallback — losing an answer to a Redis
        // blip would be a regression on the lane this is hardening.
        const caller = fakeClient('A', 1);
        proto.flushPendingAnswers.call(self, caller, CALLER);
        expect(caller.emit.mock.calls.filter(c => c[0] === 'call.answer')).toHaveLength(1);
      });
    });
  });
});

// ─── SRV-03: connect-time drains are non-destructive ─────────────────────

describe('SRV-03 — connect-time ring drain is non-destructive', () => {
  function seed(over: {offer?: string | null; marker?: string | null} = {}) {
    const redis = makeFakeRedis();
    redis.sets.set(IDX_KEY, new Set(['call-1']));
    const offer  = over.offer  === undefined ? offerRecord()  : over.offer;
    const marker = over.marker === undefined ? markerRecord() : over.marker;
    if (offer)  redis.kv.set(OFFER_KEY, offer);
    if (marker) redis.kv.set(MARKER_KEY, marker);
    return redis;
  }

  it('a dead socket keeps the ring, the marker and the index', async () => {
    const redis = seed();
    const self  = drainThis(redis);
    const client = fakeClient('B', 7, /* connected */ false);

    await proto.deliverPendingCallOffer.call(self, client, CALLEE);

    expect(client.emit).not.toHaveBeenCalled();
    expect(redis.sets.get(IDX_KEY)!.has('call-1')).toBe(true);
    expect(redis.kv.has(OFFER_KEY)).toBe(true);
    expect(redis.kv.has(MARKER_KEY)).toBe(true);
    expect(self.clearPendingCallArtifacts).not.toHaveBeenCalled();
  });

  it('an emit throw keeps the ring; the next connect delivers it exactly once', async () => {
    const redis = seed();
    const self  = drainThis(redis);
    const dying = fakeClient('B', 7);
    dying.emit.mockImplementationOnce(() => { throw new Error('socket dead'); });

    await proto.deliverPendingCallOffer.call(self, dying, CALLEE);
    expect(redis.sets.get(IDX_KEY)!.has('call-1')).toBe(true);
    expect(redis.kv.has(OFFER_KEY)).toBe(true);
    expect(redis.kv.has(MARKER_KEY)).toBe(true);

    const healthy = fakeClient('B', 7);
    await proto.deliverPendingCallOffer.call(self, healthy, CALLEE);
    expect(healthy.emit.mock.calls.filter(c => c[0] === 'call.offer')).toHaveLength(1);
    expect(redis.sets.has(IDX_KEY)).toBe(false);
    expect(redis.kv.has(OFFER_KEY)).toBe(false);
    expect(redis.kv.has(MARKER_KEY)).toBe(false);
  });

  it('happy path emits then removes exactly the three artifacts', async () => {
    const redis = seed();
    const self  = drainThis(redis);
    const client = fakeClient('B', 7);

    await proto.deliverPendingCallOffer.call(self, client, CALLEE);

    const offerEmit = client.emit.mock.calls.find(c => c[0] === 'call.offer');
    expect(offerEmit![1]).toEqual({
      callId: 'call-1', from: CALLER, sdp: 'v=0', kind: 'voice', auth: {v: 1, sig: 'sig-b64'},
    });
    expect(self.clearPendingCallArtifacts).toHaveBeenCalledWith('B', 7, 'call-1');
    expect(redis.sets.has(IDX_KEY)).toBe(false);
  });

  it('an expired payload with a surviving marker emits call.missed, then settles', async () => {
    const redis = seed({offer: null});
    const self  = drainThis(redis);
    const client = fakeClient('B', 7);

    await proto.deliverPendingCallOffer.call(self, client, CALLEE);

    const missed = client.emit.mock.calls.find(c => c[0] === 'call.missed');
    expect(missed![1]).toEqual({callId: 'call-1', from: CALLER, kind: 'voice', at: expect.any(Number)});
    expect(self.clearPendingCallArtifacts).toHaveBeenCalledWith('B', 7, 'call-1');
    expect(redis.kv.has(MARKER_KEY)).toBe(false);
  });

  it('an entry with neither payload nor marker settles without emitting', async () => {
    const redis = seed({offer: null, marker: null});
    const self  = drainThis(redis);
    const client = fakeClient('B', 7);

    await proto.deliverPendingCallOffer.call(self, client, CALLEE);

    expect(client.emit).not.toHaveBeenCalled();
    expect(self.clearPendingCallArtifacts).toHaveBeenCalledWith('B', 7, 'call-1');
    expect(redis.sets.has(IDX_KEY)).toBe(false);
  });

  it('a malformed payload cannot wedge the index', async () => {
    const redis = seed({offer: 'not-json{', marker: null});
    const self  = drainThis(redis);
    const client = fakeClient('B', 7);

    await proto.deliverPendingCallOffer.call(self, client, CALLEE);

    expect(client.emit).not.toHaveBeenCalled();
    expect(self.clearPendingCallArtifacts).toHaveBeenCalledWith('B', 7, 'call-1');
    expect(redis.sets.has(IDX_KEY)).toBe(false);
  });

  // A rejected read tells us nothing about the entry — settling it would DEL a
  // ring and its missed-call marker the drain never even looked at.
  it('a transient Redis read failure keeps the ring, the marker and the index', async () => {
    const redis = seed();
    const self  = drainThis(redis);
    const client = fakeClient('B', 7);
    redis.client.mget = jest.fn(async () => {
      throw new Error('Reached the max retries per request limit');
    }) as unknown as typeof redis.client.mget;

    await proto.deliverPendingCallOffer.call(self, client, CALLEE);

    expect(client.emit).not.toHaveBeenCalled();
    expect(self.clearPendingCallArtifacts).not.toHaveBeenCalled();
    expect(redis.sets.get(IDX_KEY)!.has('call-1')).toBe(true);
    expect(redis.kv.has(OFFER_KEY)).toBe(true);
    expect(redis.kv.has(MARKER_KEY)).toBe(true);
  });

  it('a held drain claim defers the drain instead of destroying it', async () => {
    const redis = seed();
    redis.kv.set('pending-call-offer-drain:B:7', 'someone-else');
    const self  = drainThis(redis);
    const client = fakeClient('B', 7);

    await proto.deliverPendingCallOffer.call(self, client, CALLEE);

    expect(client.emit).not.toHaveBeenCalled();
    expect(self.clearPendingCallArtifacts).not.toHaveBeenCalled();
    expect(redis.sets.get(IDX_KEY)!.has('call-1')).toBe(true);
    expect(redis.kv.has(OFFER_KEY)).toBe(true);
  });

  // ── group analogue ──

  const G_IDX    = 'pending-group-ring-idx:B';
  const G_RING   = 'pending-group-ring:B:room-1';
  const G_MARKER = 'missed-group-call-marker:B:room-1';

  function seedGroup(over: {ring?: string | null; marker?: string | null} = {}) {
    const redis = makeFakeRedis();
    redis.sets.set(G_IDX, new Set(['room-1']));
    const ring = over.ring === undefined ? JSON.stringify({
      roomId: 'room-1', conversationId: 'conv-1', callType: 'video', from: CALLER,
      callerName: 'Alice', roomToken: 'tok', roomTokenExp: 12345, at: Date.now(),
    }) : over.ring;
    const marker = over.marker === undefined ? JSON.stringify({
      roomId: 'room-1', conversationId: 'conv-1', from: CALLER, callType: 'video', at: Date.now() - 60_000,
    }) : over.marker;
    if (ring)   redis.kv.set(G_RING, ring);
    if (marker) redis.kv.set(G_MARKER, marker);
    return redis;
  }

  it('a dead socket keeps a queued group ring', async () => {
    const redis = seedGroup({ring: null});
    const self  = drainThis(redis);
    const client = fakeClient('B', 7, false);

    await proto.deliverPendingGroupRing.call(self, client, {userId: 'B'});

    expect(client.emit).not.toHaveBeenCalled();
    expect(redis.sets.get(G_IDX)!.has('room-1')).toBe(true);
    expect(redis.kv.has(G_MARKER)).toBe(true);
    expect(self.clearPendingGroupRingArtifacts).not.toHaveBeenCalled();
  });

  it('a live socket gets sfu.ring.missed, then the entry is removed', async () => {
    const redis = seedGroup({ring: null});
    const self  = drainThis(redis);
    const client = fakeClient('B', 7);

    await proto.deliverPendingGroupRing.call(self, client, {userId: 'B'});

    const missed = client.emit.mock.calls.find(c => c[0] === 'sfu.ring.missed');
    expect(missed![1]).toEqual({
      roomId: 'room-1', conversationId: 'conv-1', from: CALLER, callType: 'video', at: expect.any(Number),
    });
    expect(self.clearPendingGroupRingArtifacts).toHaveBeenCalledWith('B', 'room-1');
    expect(redis.sets.has(G_IDX)).toBe(false);
  });

  it('a live group ring replays with every field intact, and is MARKED as a replay', async () => {
    const redis = seedGroup();
    const self  = drainThis(redis);
    const client = fakeClient('B', 7);

    await proto.deliverPendingGroupRing.call(self, client, {userId: 'B'});

    const ring = client.emit.mock.calls.find(c => c[0] === 'sfu.ring.incoming');
    expect(ring![1]).toEqual({
      roomId: 'room-1', conversationId: 'conv-1', callType: 'video', from: CALLER,
      callerName: 'Alice', roomToken: 'tok', roomTokenExp: 12345,
      // B-479 — the client acks a REPLAY, and only a replay: a live fan-out
      // frame's queued artifacts carry the days-long missed-call marker, so
      // clearing those the moment a ring is shown would cost the user their
      // missed-call record for a call they never answered.
      replayed: true,
    });
  });

  /**
   * B-479 — the replay is no longer DESTRUCTIVE.
   *
   * It used to emit and delete in the same pass, so a queued ring got exactly
   * one chance to land. A client that could not present it at that instant lost
   * the call outright — no ring, no replay, no missed-call record. The sharpest
   * case is a socket coming up mid backup-restore, which the restore flow does
   * twice while its own suppression flag is still armed.
   */
  it('a live group ring is NOT cleared on emit — it waits for the ack', async () => {
    const redis = seedGroup();
    const self  = drainThis(redis);
    const client = fakeClient('B', 7);

    await proto.deliverPendingGroupRing.call(self, client, {userId: 'B'});

    expect(client.emit.mock.calls.some(c => c[0] === 'sfu.ring.incoming')).toBe(true);
    expect(self.clearPendingGroupRingArtifacts).not.toHaveBeenCalled();
    expect(redis.kv.has(G_RING)).toBe(true);
    expect(redis.sets.get(G_IDX)!.has('room-1')).toBe(true);
  });

  it('an unacked ring is replayed AGAIN on the next connect', async () => {
    // The whole point: a client that could not take it the first time gets
    // another chance instead of losing the call.
    const redis = seedGroup();
    const self  = drainThis(redis);

    await proto.deliverPendingGroupRing.call(self, fakeClient('B', 7), {userId: 'B'});
    const second = fakeClient('B', 7);
    await proto.deliverPendingGroupRing.call(self, second, {userId: 'B'});

    expect(second.emit.mock.calls.some(c => c[0] === 'sfu.ring.incoming')).toBe(true);
  });

  it('the missed-marker path still settles immediately (unchanged)', async () => {
    // Only the LIVE lane waits for an ack. A missed record is idempotent on the
    // client (stableId), and holding it would re-emit it every reconnect for
    // the marker's multi-day TTL.
    const redis = seedGroup({ring: null});
    const self  = drainThis(redis);

    await proto.deliverPendingGroupRing.call(self, fakeClient('B', 7), {userId: 'B'});

    expect(self.clearPendingGroupRingArtifacts).toHaveBeenCalledWith('B', 'room-1');
  });

  it('a transient Redis read failure keeps a queued group ring', async () => {
    const redis = seedGroup();
    const self  = drainThis(redis);
    const client = fakeClient('B', 7);
    redis.client.mget = jest.fn(async () => {
      throw new Error('Reached the max retries per request limit');
    }) as unknown as typeof redis.client.mget;

    await proto.deliverPendingGroupRing.call(self, client, {userId: 'B'});

    expect(client.emit).not.toHaveBeenCalled();
    expect(self.clearPendingGroupRingArtifacts).not.toHaveBeenCalled();
    expect(redis.sets.get(G_IDX)!.has('room-1')).toBe(true);
    expect(redis.kv.has(G_RING)).toBe(true);
    expect(redis.kv.has(G_MARKER)).toBe(true);
  });
});

// ─── AUDIT-2026-08-13 D-4 — trickle ICE skips the per-frame online probe ──
//
// `deviceIsOnline` costs a cluster `fetchSockets` round-trip and trickle ICE
// ships dozens of frames per call setup. The offer/answer legs keep the
// probe (their callers act on `peer_offline`); ICE emits into the room
// unconditionally — an empty room is a no-op and ICE is self-healing.
// WHO CONSUMED THE REMOVED ERROR: see the corrected record at the call.ice
// handler in messenger.gateway.ts — Nest's adapter emitted the handler
// return as an `error` FRAME, consumed by productionRuntime's 'error' case
// → gatewayErrorPolicy auto-clear toast, one per candidate to an offline
// callee (a toast storm that defeated handleCallOffer's own deliberate
// peer_offline suppression). An earlier "fire-and-forget, no consumer"
// claim here was wrong (critic-verified); D-4 removes the storm too.
// ─── AUDIT D-3 rev-3 (critic) — the ring-queue lane must be PINNED ────────
//
// The critic deleted the entire pendingGroupRing MULTI lane and 535/535
// stayed green: makeGateway's `{} as never` redis made multi() throw into
// the best-effort catch, so P2-BR-9's offline-member ring queue had zero
// write-side coverage and the rev-2 partial-failure warn had NEVER executed.
describe('AUDIT D-3 — sfu.ring queues the offline-member trio via ONE MULTI', () => {
  function ringRedis(failAt?: number) {
    const kv = new Map<string, string>();
    const sets = new Map<string, Set<string>>();
    let multiCalls = 0;
    const client = {
      multi() {
        multiCalls++;
        const staged: Array<{err: Error | null; run: () => void}> = [];
        let cmdIdx = 0;
        const chain: any = {
          set: (key: string, val: string) => {
            const err = failAt === cmdIdx++ ? new Error('WRONGTYPE') : null;
            staged.push({err, run: () => kv.set(key, val)});
            return chain;
          },
          sadd: (key: string, member: string) => {
            const err = failAt === cmdIdx++ ? new Error('WRONGTYPE') : null;
            staged.push({err, run: () => {
              let s = sets.get(key); if (!s) { s = new Set(); sets.set(key, s); }
              s.add(member);
            }});
            return chain;
          },
          expire: () => {
            const err = failAt === cmdIdx++ ? new Error('WRONGTYPE') : null;
            staged.push({err, run: () => undefined});
            return chain;
          },
          exec: async () => staged.map(({err, run}) => {
            if (!err) {run();}
            return [err, err ? null : 'OK'] as [Error | null, unknown];
          }),
        };
        return chain;
      },
    };
    return {kv, sets, client, multiCalled: () => multiCalls > 0};
  }

  const frame = {
    roomId: 'room-d3', conversationId: 'conv-1', callType: 'voice',
    recipientUserIds: ['user-target'], callerName: 'Host',
  } as any;

  it('an unblocked target gets ring + marker + index written atomically (multi used)', async () => {
    const redis = ringRedis();
    const {gw} = makeGateway({host: 'user-host', redis: {client: redis.client}});
    const client = fakeClient('user-host', 1);
    const res = await gw.handleSfuRing(frame, client);
    expect(res).toEqual({ok: true, ringId: expect.any(String)});
    expect(redis.multiCalled()).toBe(true);
    expect(redis.kv.has('pending-group-ring:user-target:room-d3')).toBe(true);
    expect(redis.kv.has('missed-group-call-marker:user-target:room-d3')).toBe(true);
    expect(redis.sets.get('pending-group-ring-idx:user-target')?.has('room-d3')).toBe(true);
  });

  it('a per-command failure inside EXEC surfaces the [SFU] partial-failure warn', async () => {
    const redis = ringRedis(2); // the sadd fails inside exec
    const {gw} = makeGateway({host: 'user-host', redis: {client: redis.client}});
    const warn = jest.fn();
    (gw as unknown as {logger: {warn: jest.Mock}}).logger = {
      log: jest.fn(), warn, error: jest.fn(), debug: jest.fn(), verbose: jest.fn(),
    } as never;
    await gw.handleSfuRing(frame, fakeClient('user-host', 1));
    expect(warn.mock.calls.map(c => String(c[0])).filter(m => m.includes('pending-ring MULTI partial failure'))).toHaveLength(1);
  });
});

describe('AUDIT D-4 — forwardToDevice online-probe semantics', () => {
  const proto = MessengerGateway.prototype as any;

  function forwardSelf() {
    const emit = jest.fn();
    const hub = {
      deviceIsOnline: jest.fn(async () => false),   // OFFLINE peer
      deviceRoom:     (a: {userId: string; deviceId: number}) => `dev:${a.userId}:${a.deviceId}`,
      server:         {to: jest.fn(() => ({emit, volatile: {emit: jest.fn()}}))},
    };
    return {self: {hub}, hub, emit};
  }

  const frame = (from: {userId: string; deviceId: number}) => ({event: 'call.ice', data: {from}});

  it('skipOnlineProbe: NO fetchSockets probe, frame still emitted into the room', async () => {
    const {self, hub, emit} = forwardSelf();
    const res = await proto.forwardToDevice.call(
      self, fakeClient('A', 1), {userId: 'B', deviceId: 1}, false, frame, {skipOnlineProbe: true},
    );
    expect(hub.deviceIsOnline).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('call.ice', expect.anything());
    expect(res).toBeUndefined();                    // no peer_offline error
  });

  it('default (offer/answer/hangup path): the probe still runs and an offline peer errors', async () => {
    const {self, hub, emit} = forwardSelf();
    const res = await proto.forwardToDevice.call(
      self, fakeClient('A', 1), {userId: 'B', deviceId: 1}, false, frame,
    );
    expect(hub.deviceIsOnline).toHaveBeenCalledTimes(1);
    expect(emit).not.toHaveBeenCalled();
    expect((res as {data: {code: string}}).data.code).toBe('peer_offline');
  });
});

// ─── B-479: sfu.ring.ack — the recipient confirms a replayed ring ────────
//
// The reconnect replay used to be destructive: emit + delete in one pass, so a
// queued ring had exactly ONE chance to land. A client that could not present
// it at that instant lost the call entirely — no ring, no replay, no
// missed-call record. The sharpest case is a socket coming up mid
// backup-restore, which the restore flow does twice while its own suppression
// flag is still armed. The drain now leaves the artifacts queued and this ack
// is what removes them.

describe('B-479 — handleSfuRingAck', () => {
  const ACKER = 'acker-user';

  function ackThis(opts: {tokenOk?: boolean; secretSet?: boolean; ctx?: boolean} = {}) {
    const clearPendingGroupRingArtifacts = jest.fn(async () => undefined);
    const verify = jest.fn(() => (opts.tokenOk === false
      ? {ok: false as const, reason: 'invalid'}
      : {ok: true as const}));
    const self = {
      logger:      {log: jest.fn(), warn: jest.fn()},
      rateGate:    jest.fn(() => null),
      roomToken:   {verify, issue: jest.fn(() => ({token: 't', exp: 1}))},
      clearPendingGroupRingArtifacts,
    };
    const client = {
      data: opts.ctx === false ? undefined : {claims: {sub: ACKER}, signalDeviceId: 7},
    };
    return {self, client, clearPendingGroupRingArtifacts, verify};
  }

  it('clears the CALLER OWN queued ring', async () => {
    const {self, client, clearPendingGroupRingArtifacts} = ackThis();
    const res = await proto.handleSfuRingAck.call(self, {roomId: 'room-1'}, client);
    expect(res).toEqual({ok: true});
    // Namespaced by the authenticated sub — this is the whole authority story:
    // a caller can only ever discard their own queued ring, which they can
    // already do by declining.
    expect(clearPendingGroupRingArtifacts).toHaveBeenCalledWith(ACKER, 'room-1', {onlyRingId: undefined});
  });

  it('rejects an unauthenticated socket', async () => {
    const {self, client, clearPendingGroupRingArtifacts} = ackThis({ctx: false});
    const res = await proto.handleSfuRingAck.call(self, {roomId: 'room-1'}, client);
    expect(res).toEqual({ok: false, data: expect.objectContaining({message: 'unauthenticated'})});
    expect(clearPendingGroupRingArtifacts).not.toHaveBeenCalled();
  });

  it('is rate-limited', async () => {
    // An unmetered verb is a free Redis-write loop.
    const {self, client, clearPendingGroupRingArtifacts} = ackThis();
    self.rateGate = jest.fn(() => ({event: 'error', data: {code: 'rate_limited', message: 'x'}})) as never;
    const res = await proto.handleSfuRingAck.call(self, {roomId: 'room-1'}, client);
    expect(res).toEqual({ok: false, data: expect.objectContaining({message: 'rate_limited'})});
    expect(clearPendingGroupRingArtifacts).not.toHaveBeenCalled();
  });

  it('rejects a missing roomId rather than clearing something else', async () => {
    const {self, client, clearPendingGroupRingArtifacts} = ackThis();
    const res = await proto.handleSfuRingAck.call(self, {roomId: '   '}, client);
    expect(res).toEqual({ok: false, data: expect.objectContaining({message: 'bad_request'})});
    expect(clearPendingGroupRingArtifacts).not.toHaveBeenCalled();
  });

  it('VERIFIES a supplied room token, and refuses on a bad one', async () => {
    const {self, client, clearPendingGroupRingArtifacts, verify} = ackThis({tokenOk: false});
    const res = await proto.handleSfuRingAck.call(self, {roomId: 'room-1', roomToken: 'nope'}, client);
    expect(verify).toHaveBeenCalledWith('nope', 'room-1', ACKER);
    expect(res).toEqual({ok: false, data: expect.objectContaining({message: 'room_token_invalid'})});
    // Refusing leaves the ring QUEUED, which is the safe direction: it is
    // replayed again rather than silently dropped.
    expect(clearPendingGroupRingArtifacts).not.toHaveBeenCalled();
  });

  it('does NOT require a token — the FCM rescue lane may not carry one', async () => {
    // Requiring it would leave those rings queued forever without protecting
    // anything: the keys are already namespaced to the caller.
    const {self, client, clearPendingGroupRingArtifacts, verify} = ackThis();
    const res = await proto.handleSfuRingAck.call(self, {roomId: 'room-1'}, client);
    expect(verify).not.toHaveBeenCalled();
    expect(res).toEqual({ok: true});
    expect(clearPendingGroupRingArtifacts).toHaveBeenCalledWith(ACKER, 'room-1', {onlyRingId: undefined});
  });
});

// ─── B-566 round 2 — the ring-ack settle is RING-SCOPED ────────────────────

describe('B-566 round 2 — sfu.ring.ack settles only the fan-out it owns', () => {
  function ackScopedThis() {
    const clearPendingGroupRingArtifacts = jest.fn(async () => undefined);
    const self: any = {
      rateGate: () => null,
      roomToken: {verify: jest.fn(() => ({ok: true}))},
      logger: {log: jest.fn(), warn: jest.fn()},
      clearPendingGroupRingArtifacts,
    };
    return {self, clearPendingGroupRingArtifacts};
  }

  it('an ack carrying the replay ringId scopes the clear to that ring', async () => {
    const {self, clearPendingGroupRingArtifacts} = ackScopedThis();
    const res = await proto.handleSfuRingAck.call(
      self, {roomId: 'room-1', ringId: 'ring-A'}, fakeClient('acker-user', 7),
    );
    expect(res).toEqual({ok: true});
    expect(clearPendingGroupRingArtifacts).toHaveBeenCalledWith('acker-user', 'room-1', {onlyRingId: 'ring-A'});
  });

  it('garbage ringId (wrong type / oversized) degrades to the room-wide settle', async () => {
    const {self, clearPendingGroupRingArtifacts} = ackScopedThis();
    await proto.handleSfuRingAck.call(self, {roomId: 'room-1', ringId: {evil: 1}}, fakeClient('acker-user', 7));
    await proto.handleSfuRingAck.call(self, {roomId: 'room-1', ringId: 'x'.repeat(65)}, fakeClient('acker-user', 7));
    for (const call of clearPendingGroupRingArtifacts.mock.calls as unknown[][]) {
      expect(call[2]).toEqual({onlyRingId: undefined});
    }
  });
});

// ─── B-568 — a JOIN is an answer: the joiner's queued ring artifacts clear ──

describe('B-568 — sfu.join clears the joiner\'s queued ring + collapses their other devices', () => {
  function joinThis(opts: {host?: string | null} = {}) {
    const clearPendingGroupRingArtifacts = jest.fn(async () => undefined);
    const push = {sendCallCancel: jest.fn(() => Promise.resolve(1))};
    const self: any = {
      rateGate: () => null,
      userRateExceeded: jest.fn(async () => false),
      // NODE_ENV=test → the tokenless non-prod admit path (issue() throws).
      roomToken: {issue: jest.fn(() => { throw new Error('no secret'); }), verify: jest.fn(() => ({ok: true}))},
      tokenlessSfuAdmitLogged: true, // silence the one-shot warn
      sfu: {
        joinRoom: jest.fn(async () => ({participantTag: 'tag-new', isHost: false, existingProducers: []})),
        hostOf: jest.fn(() => (opts.host === undefined ? 'host-user' : opts.host)),
      },
      sfuTagToSocket: new Map(),
      sfuSocketTags: new WeakMap(),
      logger: {log: jest.fn(), warn: jest.fn(), error: jest.fn()},
      clearPendingGroupRingArtifacts,
      push,
    };
    return {self, clearPendingGroupRingArtifacts, push};
  }

  it('a member join clears THEIR artifacts and fans the answered-elsewhere cancel (missed=false)', async () => {
    const {self, clearPendingGroupRingArtifacts, push} = joinThis();
    const res = await proto.handleSfuJoin.call(self, {roomId: 'room-j'}, fakeClient('member-user', 7));
    expect(res).toMatchObject({participantTag: 'tag-new'});
    // The days-long missed marker dies at answer time — no phantom
    // "Missed group call" on any later reconnect for an answered call.
    expect(clearPendingGroupRingArtifacts).toHaveBeenCalledWith('member-user', 'room-j');
    expect(push.sendCallCancel).toHaveBeenCalledWith('member-user', 'room-j', 'host-user', 'voice', false);
  });

  it('the HOST\'s own boot-join clears but never fans a pointless cancel multicast', async () => {
    const {self, clearPendingGroupRingArtifacts, push} = joinThis({host: 'host-user'});
    await proto.handleSfuJoin.call(self, {roomId: 'room-j'}, fakeClient('host-user', 7));
    expect(clearPendingGroupRingArtifacts).toHaveBeenCalledWith('host-user', 'room-j');
    expect(push.sendCallCancel).not.toHaveBeenCalled();
  });

  it('a FAILED join clears nothing (the ring is still live for this user)', async () => {
    const {self, clearPendingGroupRingArtifacts, push} = joinThis();
    self.sfu.joinRoom = jest.fn(async () => { throw new Error('room_full'); });
    const res = await proto.handleSfuJoin.call(self, {roomId: 'room-j'}, fakeClient('member-user', 7));
    expect(res).toMatchObject({ok: false});
    expect(clearPendingGroupRingArtifacts).not.toHaveBeenCalled();
    expect(push.sendCallCancel).not.toHaveBeenCalled();
  });
});
