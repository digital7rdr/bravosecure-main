/**
 * Phase 6 server hardening — ring lifecycle + reconcile:
 *
 *   WI-6.2 — WS `sfu.ring.decline` parity with the HTTP decline: clears the
 *            decliner's queued group-ring artifacts + collapses their other
 *            devices' rings, AFTER the byte-identical C2/C3 authority gate.
 *            (And the HTTP group branch gains the cancel push it was missing.)
 *   WI-6.3 — the artifact CLEAR paths are one atomic MULTI (writer parity),
 *            with per-command error inspection; keep-marker keeps the index.
 *   WI-6.6 — `call.sync` reconcile query: ringing/active/ended for a
 *            participant, `unknown` for a nonexistent call AND for a
 *            non-participant (no existence oracle).
 *   WI-6.7 — per-ring cancel: `sfu.ring` acks its ringId; `sfu.ring.cancel`
 *            threads it into the cancelled frame, the cancel push and a
 *            ring-scoped artifact clear that spares a NEWER queued ring.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import type {Socket} from 'socket.io';
import {MessengerGateway} from './messenger.gateway';

const proto: any = MessengerGateway.prototype;

const ME   = 'me-user';
const HOST = 'host-user';
const ROOM = 'room-lifecycle-1';

function fakeClient(sub = ME, deviceId = 7): Socket & {emit: jest.Mock} {
  return {
    id:   `sock-${sub}`,
    data: {claims: {sub}, signalDeviceId: deviceId, sessionId: `s-${sub}`},
    connected: true,
    emit: jest.fn(),
  } as unknown as Socket & {emit: jest.Mock};
}

/** Recording multi() fake: captures the chained commands and their args. */
function fakeMultiRedis(opts: {execResult?: 'ok' | 'partial' | 'reject'} = {}) {
  const client: any = {
    calls: [] as Array<{cmd: string; args: unknown[]}>,
    multiCount: 0,
    sequential: [] as string[],  // any NON-multi write is a regression
    mgetResult: [null, null] as Array<string | null>,
    del:  jest.fn(async (...a: unknown[]) => { client.sequential.push('del');  return 1; }),
    srem: jest.fn(async (...a: unknown[]) => { client.sequential.push('srem'); return 1; }),
    mget: jest.fn(async () => client.mgetResult),
  };
  client.multi = () => {
    client.multiCount += 1;
    const chained: Array<{cmd: string; args: unknown[]}> = [];
    const chain: any = {
      del:  (...a: unknown[]) => { chained.push({cmd: 'del',  args: a}); return chain; },
      srem: (...a: unknown[]) => { chained.push({cmd: 'srem', args: a}); return chain; },
      exec: async () => {
        client.calls.push(...chained);
        if (opts.execResult === 'reject') throw new Error('redis gone');
        if (opts.execResult === 'partial') {
          return chained.map((_, i) => (i === 1 ? [new Error('WRONGTYPE'), null] : [null, 1]));
        }
        return chained.map(() => [null, 1]);
      },
    };
    return chain;
  };
  return client;
}

// ─── WI-6.3: clearPendingCallArtifacts is one MULTI ─────────────────────────

describe('WI-6.3 — clearPendingCallArtifacts atomicity', () => {
  function clearThis(execResult?: 'ok' | 'partial' | 'reject') {
    const redisClient = fakeMultiRedis({execResult});
    const self: any = {redis: {client: redisClient}, logger: {log: jest.fn(), warn: jest.fn()}};
    return {self, redisClient};
  }

  it('full clear rides ONE MULTI: del payload, del marker, srem index — no sequential writes', async () => {
    const {self, redisClient} = clearThis();
    await proto.clearPendingCallArtifacts.call(self, ME, 7, 'cid-1');
    expect(redisClient.multiCount).toBe(1);
    expect(redisClient.sequential).toEqual([]); // reverting to awaits fails here
    expect(redisClient.calls.map((c: any) => c.cmd)).toEqual(['del', 'del', 'srem']);
    expect(redisClient.calls[0].args[0]).toBe(`pending-call-offer:${ME}:7:cid-1`);
    expect(redisClient.calls[1].args[0]).toBe(`missed-call-marker:${ME}:7:cid-1`);
    expect(redisClient.calls[2].args).toEqual([`pending-call-offer-idx:${ME}:7`, 'cid-1']);
  });

  it('keepMarker keeps the marker AND the index entry (P1-15) — MULTI holds only the payload DEL', async () => {
    const {self, redisClient} = clearThis();
    await proto.clearPendingCallArtifacts.call(self, ME, 7, 'cid-1', {keepMarker: true});
    expect(redisClient.calls.map((c: any) => c.cmd)).toEqual(['del']);
    expect(redisClient.calls[0].args[0]).toBe(`pending-call-offer:${ME}:7:cid-1`);
  });

  it('a partial in-EXEC failure is surfaced (logger.warn), not silent', async () => {
    const {self} = clearThis('partial');
    await proto.clearPendingCallArtifacts.call(self, ME, 7, 'cid-1');
    expect(self.logger.warn).toHaveBeenCalledWith(expect.stringContaining('clear-artifacts MULTI partial failure'));
  });

  it('an exec rejection is swallowed (best-effort contract preserved)', async () => {
    const {self} = clearThis('reject');
    await expect(proto.clearPendingCallArtifacts.call(self, ME, 7, 'cid-1')).resolves.toBeUndefined();
  });
});

// ─── WI-6.3 + WI-6.7: group clear — atomic AND ring-scoped ─────────────────

describe('WI-6.3/WI-6.7 — clearPendingGroupRingArtifacts', () => {
  function groupClearThis() {
    const redisClient = fakeMultiRedis();
    const self: any = {redis: {client: redisClient}, logger: {log: jest.fn(), warn: jest.fn()}};
    return {self, redisClient};
  }
  const ring   = (ringId?: string) => JSON.stringify({roomId: ROOM, ringId, at: Date.now()});
  const marker = (ringId?: string) => JSON.stringify({roomId: ROOM, ringId, at: Date.now()});

  it('unconditional clear: one MULTI with del payload, del marker, srem index', async () => {
    const {self, redisClient} = groupClearThis();
    await proto.clearPendingGroupRingArtifacts.call(self, ME, ROOM);
    expect(redisClient.multiCount).toBe(1);
    expect(redisClient.sequential).toEqual([]);
    expect(redisClient.calls.map((c: any) => c.cmd)).toEqual(['del', 'del', 'srem']);
    expect(redisClient.mget).not.toHaveBeenCalled(); // no read cost on the common path
  });

  it('onlyRingId matching BOTH artifacts → full clear', async () => {
    const {self, redisClient} = groupClearThis();
    redisClient.mgetResult = [ring('ring-A'), marker('ring-A')];
    await proto.clearPendingGroupRingArtifacts.call(self, ME, ROOM, {onlyRingId: 'ring-A'});
    expect(redisClient.calls.map((c: any) => c.cmd)).toEqual(['del', 'del', 'srem']);
  });

  it('onlyRingId with a NEWER queued ring → nothing is touched', async () => {
    const {self, redisClient} = groupClearThis();
    redisClient.mgetResult = [ring('ring-B'), marker('ring-B')];
    await proto.clearPendingGroupRingArtifacts.call(self, ME, ROOM, {onlyRingId: 'ring-A'});
    expect(redisClient.multiCount).toBe(0);
    expect(redisClient.calls).toEqual([]);
  });

  it('mixed: payload is the old ring, marker already the newer → payload DEL only, index SURVIVES', async () => {
    const {self, redisClient} = groupClearThis();
    redisClient.mgetResult = [ring('ring-A'), marker('ring-B')];
    await proto.clearPendingGroupRingArtifacts.call(self, ME, ROOM, {onlyRingId: 'ring-A'});
    expect(redisClient.calls.map((c: any) => c.cmd)).toEqual(['del']);
    expect(redisClient.calls[0].args[0]).toBe(`pending-group-ring:${ME}:${ROOM}`);
    // No srem: the surviving marker must stay reachable through the index.
  });

  it('pre-WI-6.7 rows (no stored ringId) are cleared by a named cancel (legacy fallback)', async () => {
    const {self, redisClient} = groupClearThis();
    redisClient.mgetResult = [ring(undefined), marker(undefined)];
    await proto.clearPendingGroupRingArtifacts.call(self, ME, ROOM, {onlyRingId: 'ring-A'});
    expect(redisClient.calls.map((c: any) => c.cmd)).toEqual(['del', 'del', 'srem']);
  });
});

// ─── WI-6.2: WS decline parity ──────────────────────────────────────────────

describe('WI-6.2 — sfu.ring.decline clears artifacts + collapses other devices', () => {
  function declineThis(opts: {verifyFails?: boolean; host?: string | null} = {}) {
    const emitted: Array<{room: string; event: string; data: unknown}> = [];
    const self: any = {
      rateGate: () => null,
      sfu: {hostOf: jest.fn(() => (opts.host === undefined ? HOST : opts.host))},
      hub: {
        userRoom: (u: string) => `user:${u}`,
        server: {to: (room: string) => ({emit: (event: string, data: unknown) => emitted.push({room, event, data})})},
      },
      roomToken: {
        // No token supplied + issue() THROWS = "secret not configured" → admit
        // (the C2 gate's documented dev/legacy path). verify() drives the
        // token-carrying refusal case.
        issue:  jest.fn(() => { throw new Error('no secret'); }),
        verify: jest.fn(() => (opts.verifyFails ? {ok: false, reason: 'expired'} : {ok: true})),
      },
      logger: {log: jest.fn(), warn: jest.fn()},
      push:   {sendCallCancel: jest.fn(() => Promise.resolve(1))},
      clearPendingGroupRingArtifacts: jest.fn(async () => undefined),
    };
    self.verifySfuRingAuthority = proto.verifySfuRingAuthority.bind(self);
    return {self, emitted};
  }
  const frame = (roomToken?: string) => ({roomId: ROOM, conversationId: 'conv-1', roomToken});

  it('a passing decline notifies the host AND clears the decliner artifacts AND cancel-pushes their other devices', () => {
    const {self, emitted} = declineThis();
    const ret = proto.handleSfuRingDecline.call(self, frame(), fakeClient(ME));
    expect(ret).toEqual({ok: true});
    expect(emitted).toEqual([{room: `user:${HOST}`, event: 'sfu.ring.declined',
      data: {roomId: ROOM, conversationId: 'conv-1', from: {userId: ME, deviceId: 7}}}]);
    expect(self.clearPendingGroupRingArtifacts).toHaveBeenCalledWith(ME, ROOM);
    expect(self.push.sendCallCancel).toHaveBeenCalledWith(ME, ROOM, HOST, 'voice', false);
  });

  it('an authority refusal clears NOTHING and pushes nothing (the C2 gate stays first)', () => {
    const {self, emitted} = declineThis({verifyFails: true});
    const ret = proto.handleSfuRingDecline.call(self, frame('a-token'), fakeClient(ME));
    expect(ret).toEqual({ok: false, data: expect.objectContaining({message: 'room_token_expired'})});
    expect(emitted).toEqual([]);
    expect(self.clearPendingGroupRingArtifacts).not.toHaveBeenCalled();
    expect(self.push.sendCallCancel).not.toHaveBeenCalled();
  });

  it('a hostless room (host hung up first) still clears + collapses for the decliner', () => {
    const {self, emitted} = declineThis({host: null});
    const ret = proto.handleSfuRingDecline.call(self, frame(), fakeClient(ME));
    expect(ret).toEqual({ok: true});
    expect(emitted).toEqual([]); // nobody to notify
    expect(self.clearPendingGroupRingArtifacts).toHaveBeenCalledWith(ME, ROOM);
    expect(self.push.sendCallCancel).toHaveBeenCalledWith(ME, ROOM, ME, 'voice', false);
  });

  it('HTTP group decline (declineCallViaHttp) now collapses other devices too — lane parity', async () => {
    const {self} = declineThis();
    await proto.declineCallViaHttp.call(self, {userId: ME, deviceId: 7}, ROOM, {kind: 'group'});
    expect(self.clearPendingGroupRingArtifacts).toHaveBeenCalledWith(ME, ROOM);
    expect(self.push.sendCallCancel).toHaveBeenCalledWith(ME, ROOM, HOST, 'voice', false);
  });

  it('round 2 (F3) — a rate-limited decline does nothing: no clear, no push, no host emit', () => {
    const {self, emitted} = declineThis();
    self.rateGate = jest.fn(() => ({event: 'error', data: {code: 'rate_limited', message: ''}}));
    const ret = proto.handleSfuRingDecline.call(self, frame(), fakeClient(ME));
    expect(ret).toEqual({ok: false, data: expect.objectContaining({message: 'rate_limited'})});
    expect((ret as {event?: string}).event).toBeUndefined(); // ack-able, never a stray frame
    expect(emitted).toEqual([]);
    expect(self.clearPendingGroupRingArtifacts).not.toHaveBeenCalled();
    expect(self.push.sendCallCancel).not.toHaveBeenCalled();
  });
});

// ─── WI-6.7: sfu.ring.cancel threads ringId ────────────────────────────────

describe('WI-6.7 — per-ring cancel threading', () => {
  function cancelThis() {
    const emitted: Array<{room: string; event: string; data: unknown}> = [];
    const self: any = {
      rateGate: () => null,
      verifySfuRingAuthority: jest.fn(() => null), // authority is WI-6.2's concern
      sfu: {endRoomIfEmptyByHost: jest.fn(() => false)},
      hub: {
        userRoom: (u: string) => `user:${u}`,
        server: {to: (room: string) => ({emit: (event: string, data: unknown) => emitted.push({room, event, data})})},
      },
      push: {sendCallCancel: jest.fn(() => Promise.resolve(1))},
      clearPendingGroupRingArtifacts: jest.fn(async () => undefined),
      logger: {log: jest.fn(), warn: jest.fn()},
    };
    return {self, emitted};
  }
  const cancel = (ringId?: unknown) => ({
    roomId: ROOM, conversationId: 'conv-1', recipientUserIds: ['peer-1'], ringId,
  });

  it('a named cancel carries ringId on the WS frame, the push and the ring-scoped clear', () => {
    const {self, emitted} = cancelThis();
    const ret = proto.handleSfuRingCancel.call(self, cancel('ring-A'), fakeClient(HOST));
    expect(ret).toEqual({ok: true});
    expect(emitted[0].data).toEqual({roomId: ROOM, conversationId: 'conv-1', ringId: 'ring-A'});
    expect(self.push.sendCallCancel).toHaveBeenCalledWith('peer-1', ROOM, HOST, 'voice', false, 'ring-A');
    expect(self.clearPendingGroupRingArtifacts).toHaveBeenCalledWith('peer-1', ROOM, {onlyRingId: 'ring-A'});
  });

  it('an old client (no ringId) keeps the historical roomId-wide behaviour', () => {
    const {self, emitted} = cancelThis();
    proto.handleSfuRingCancel.call(self, cancel(undefined), fakeClient(HOST));
    expect((emitted[0].data as {ringId?: string}).ringId).toBeUndefined();
    expect(self.push.sendCallCancel).toHaveBeenCalledWith('peer-1', ROOM, HOST, 'voice', false, undefined);
    expect(self.clearPendingGroupRingArtifacts).toHaveBeenCalledWith('peer-1', ROOM, {onlyRingId: undefined});
  });

  it('a garbage ringId (wrong type / oversized) is dropped, not forwarded', () => {
    const {self, emitted} = cancelThis();
    proto.handleSfuRingCancel.call(self, cancel({evil: true}), fakeClient(HOST));
    proto.handleSfuRingCancel.call(self, cancel('x'.repeat(65)), fakeClient(HOST));
    for (const e of emitted) {
      expect((e.data as {ringId?: string}).ringId).toBeUndefined();
    }
  });
});

// ─── WI-6.6: call.sync ──────────────────────────────────────────────────────

describe('WI-6.6 — call.sync reconcile query', () => {
  function syncThis() {
    const self: any = {
      rateGate: jest.fn(() => null),
      callSessions: new Map(),
      socketCalls: new WeakMap(),
      logger: {log: jest.fn(), warn: jest.fn()},
      redis: {client: {mget: jest.fn(async () => [null, null])}},
    };
    self.gcCallTombstones = proto.gcCallTombstones.bind(self);
    self.trackCallStart   = proto.trackCallStart.bind(self);
    self.trackCallAnswer  = proto.trackCallAnswer.bind(self);
    self.trackCallEnd     = proto.trackCallEnd.bind(self);
    return self;
  }
  const CID = 'sync-call-1';
  function seed(self: any): void {
    self.trackCallStart(fakeClient('caller-x', 2), CID,
      {userId: 'caller-x', deviceId: 2}, {userId: ME, deviceId: 7});
  }

  it('a participant sees ringing → active → ended across the lifecycle', async () => {
    const self = syncThis();
    seed(self);
    expect(await proto.handleCallSync.call(self, {callId: CID}, fakeClient(ME))).toEqual({ok: true, state: 'ringing'});
    self.trackCallAnswer(fakeClient(ME, 7), CID, {userId: ME, deviceId: 7});
    expect(await proto.handleCallSync.call(self, {callId: CID}, fakeClient(ME))).toEqual({ok: true, state: 'active'});
    self.trackCallEnd(CID);
    expect(await proto.handleCallSync.call(self, {callId: CID}, fakeClient(ME))).toEqual({ok: true, state: 'ended'});
    // The caller side is a participant too.
    expect(await proto.handleCallSync.call(self, {callId: CID}, fakeClient('caller-x', 2))).toEqual({ok: true, state: 'ended'});
  });

  it('a nonexistent callId is unknown (relay restart → the client hard-ends)', async () => {
    const self = syncThis();
    expect(await proto.handleCallSync.call(self, {callId: 'never-seen'}, fakeClient(ME))).toEqual({ok: true, state: 'unknown'});
  });

  it('a NON-participant gets exactly the nonexistent answer — no existence oracle', async () => {
    const self = syncThis();
    seed(self);
    const probe = await proto.handleCallSync.call(self, {callId: CID}, fakeClient('snoop-user'));
    const absent = await proto.handleCallSync.call(self, {callId: 'never-seen'}, fakeClient('snoop-user'));
    expect(probe).toEqual(absent);
    expect(probe).toEqual({ok: true, state: 'unknown'});
  });

  it('bad input and rate limits get event-less ack errors (never a stray error frame)', async () => {
    const self = syncThis();
    expect(await proto.handleCallSync.call(self, {callId: 42}, fakeClient(ME)))
      .toEqual({ok: false, data: expect.objectContaining({message: 'bad_request'})});
    expect(await proto.handleCallSync.call(self, {callId: 'x'.repeat(129)}, fakeClient(ME)))
      .toEqual({ok: false, data: expect.objectContaining({message: 'bad_request'})});
    self.rateGate = jest.fn(() => ({event: 'error', data: {code: 'rate_limited', message: ''}}));
    const limited = await proto.handleCallSync.call(self, {callId: 'cid'}, fakeClient(ME));
    expect(limited).toEqual({ok: false, data: expect.objectContaining({message: 'rate_limited'})});
    expect((limited as {event?: string}).event).toBeUndefined();
  });

  it('a GC-expired rehydrated session answers ended, not a phantom ringing', async () => {
    const self = syncThis();
    self.rehydrateCallSession = proto.rehydrateCallSession.bind(self);
    self.rehydrateCallSession(CID, {userId: 'caller-x', deviceId: 2}, {userId: ME, deviceId: 7});
    // Age the rehydrated ring past REHYDRATED_RING_TTL_MS (300s).
    self.callSessions.get(CID).createdAt = Date.now() - 301_000;
    expect(await proto.handleCallSync.call(self, {callId: CID}, fakeClient(ME))).toEqual({ok: true, state: 'ended'});
  });
});

// ─── WI-6.7: the fan-out acks its ringId; the marker carries it ─────────────

describe('WI-6.7 — sfu.ring mints and returns the fan-out id', () => {
  function ringThis() {
    const emitted: Array<{room: string; event: string; data: any}> = [];
    const multiWrites: Array<{cmd: string; args: unknown[]}> = [];
    const redisClient: any = {
      multi: () => {
        const chain: any = {
          set:    (...a: unknown[]) => { multiWrites.push({cmd: 'set', args: a}); return chain; },
          sadd:   (...a: unknown[]) => { multiWrites.push({cmd: 'sadd', args: a}); return chain; },
          expire: (...a: unknown[]) => { multiWrites.push({cmd: 'expire', args: a}); return chain; },
          exec:   async () => [[null, 'OK'], [null, 'OK'], [null, 1], [null, 1]],
        };
        return chain;
      },
    };
    const self: any = {
      rateGate: () => null,
      userRateExceeded: jest.fn(async () => false),
      sfu: {hostOf: () => HOST, isParticipantUser: () => false},
      isReachableParticipant: () => false,
      privacy: {isBlockedEither: jest.fn(async () => false)},
      privacyGateBounded: proto.privacyGateBounded,   // B-597 — the ring lane's bounded gate (real method over the mocked privacy)
      roomToken: {issue: jest.fn(() => { throw new Error('no secret'); })},
      redis: {client: redisClient},
      push: {sendVoipWake: jest.fn(async () => ({sent: 1, stubbed: false}))},
      hub: {
        userRoom: (u: string) => `user:${u}`,
        server: {to: (room: string) => ({emit: (event: string, data: unknown) => emitted.push({room, event, data})})},
      },
      logger: {log: jest.fn(), warn: jest.fn()},
    };
    return {self, emitted, multiWrites};
  }
  const ringFrame = {
    roomId: ROOM, conversationId: 'conv-1', callType: 'voice' as const,
    callerName: 'Host', recipientUserIds: ['peer-1'],
  };

  it('the ack returns the SAME ringId the WS frame, the wake and the queued copies carry', async () => {
    const {self, emitted, multiWrites} = ringThis();
    const ret = await proto.handleSfuRing.call(self, ringFrame, fakeClient(HOST));
    expect(ret).toMatchObject({ok: true, ringId: expect.any(String)});
    const ringId = (ret as {ringId: string}).ringId;
    // WS frame
    expect(emitted[0].event).toBe('sfu.ring.incoming');
    expect(emitted[0].data.ringId).toBe(ringId);
    // VoIP wake (8th arg is the ringId)
    expect(self.push.sendVoipWake.mock.calls[0][6]).toBe(ringId);
    // Queued pending ring AND the missed marker both persist it
    const sets = multiWrites.filter(w => w.cmd === 'set');
    expect(sets).toHaveLength(2);
    for (const w of sets) {
      expect((JSON.parse(w.args[1] as string) as {ringId?: string}).ringId).toBe(ringId);
    }
  });

  it('B-597 — a target whose block-check HANGS cannot hold the fan-out: the WS ring goes out by the deadline (never-seen pair fails open; a cached verdict is honoured)', async () => {
    const {self, emitted} = ringThis();
    self.privacy.isBlockedEither = jest.fn(() => new Promise(() => { /* hangs */ }));
    self.privacy.peekBlockedEither = jest.fn((_a: string, b: string) => (b === 'peer-cached-blocked' ? true : undefined));
    process.env.PRIVACY_CALL_GATE_DEADLINE_MS = '30';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const t0 = Date.now();
      const ret = await proto.handleSfuRing.call(
        self, {...ringFrame, recipientUserIds: ['peer-1', 'peer-cached-blocked']}, fakeClient(HOST),
      );
      expect(Date.now() - t0).toBeLessThan(1_000);
      expect(ret).toMatchObject({ok: true, ringId: expect.any(String)});
      const rings = emitted.filter(e => e.event === 'sfu.ring.incoming');
      expect(rings.map(r => r.room)).toEqual(['user:peer-1']);          // cached-blocked target NOT rung
    } finally {
      warn.mockRestore();
      delete process.env.PRIVACY_CALL_GATE_DEADLINE_MS;
    }
  });

  it('an empty target list mints nothing (no phantom ringId to cancel)', async () => {
    const {self} = ringThis();
    const ret = await proto.handleSfuRing.call(
      self, {...ringFrame, recipientUserIds: [HOST]}, fakeClient(HOST),
    );
    expect(ret).toEqual({ok: true});
  });
});

// ─── KO-1 (B-566): call.sync is rescue-aware after a relay restart ─────────

describe('KO-1 — call.sync consults the asker\'s own durable rescue lanes on a session miss', () => {
  function syncKoThis(store: Map<string, string>) {
    const self: any = {
      rateGate: () => null,
      callSessions: new Map(),
      logger: {log: jest.fn(), warn: jest.fn()},
      redis: {client: {
        mget: jest.fn(async (...keys: string[]) => keys.map(k => store.get(k) ?? null)),
      }},
    };
    self.gcCallTombstones = proto.gcCallTombstones.bind(self);
    return self;
  }
  const CID = 'sync-rescue-1';

  it('a queued FIX-07 answer on the asker lane answers active, not unknown', async () => {
    const store = new Map([[`pending-call-answer:${ME}:7:${CID}`, JSON.stringify({callId: CID})]]);
    const self = syncKoThis(store);
    expect(await proto.handleCallSync.call(self, {callId: CID}, fakeClient(ME)))
      .toEqual({ok: true, state: 'active'});
  });

  it('a still-live queued offer answers ringing; an expired one stays unknown', async () => {
    const live = new Map([[`pending-call-offer:${ME}:7:${CID}`, JSON.stringify({callId: CID, at: Date.now() - 10_000})]]);
    expect(await proto.handleCallSync.call(syncKoThis(live), {callId: CID}, fakeClient(ME)))
      .toEqual({ok: true, state: 'ringing'});
    const dead = new Map([[`pending-call-offer:${ME}:7:${CID}`, JSON.stringify({callId: CID, at: Date.now() - 46_000})]]);
    expect(await proto.handleCallSync.call(syncKoThis(dead), {callId: CID}, fakeClient(ME)))
      .toEqual({ok: true, state: 'unknown'});
  });

  it('the lanes are the ASKER\'S own — another user\'s queued state is invisible (no oracle widening)', async () => {
    const store = new Map([[`pending-call-offer:other-user:7:${CID}`, JSON.stringify({callId: CID, at: Date.now()})]]);
    const self = syncKoThis(store);
    expect(await proto.handleCallSync.call(self, {callId: CID}, fakeClient(ME)))
      .toEqual({ok: true, state: 'unknown'});
    expect(self.redis.client.mget).toHaveBeenCalledWith(
      `pending-call-offer:${ME}:7:${CID}`, `pending-call-answer:${ME}:7:${CID}`,
    );
  });

  it('a Redis blip degrades to the pre-KO-1 answer (unknown), never a throw', async () => {
    const self = syncKoThis(new Map());
    self.redis.client.mget = jest.fn(async () => { throw new Error('redis gone'); });
    expect(await proto.handleCallSync.call(self, {callId: CID}, fakeClient(ME)))
      .toEqual({ok: true, state: 'unknown'});
  });

  it('a live in-memory session still wins — the rescue lanes are only consulted on a miss', async () => {
    const self = syncKoThis(new Map());
    self.trackCallStart = proto.trackCallStart.bind(self);
    self.socketCalls = new WeakMap();
    self.trackCallStart(fakeClient('caller-x', 2), CID,
      {userId: 'caller-x', deviceId: 2}, {userId: ME, deviceId: 7});
    expect(await proto.handleCallSync.call(self, {callId: CID}, fakeClient(ME)))
      .toEqual({ok: true, state: 'ringing'});
    expect(self.redis.client.mget).not.toHaveBeenCalled();
  });
});

// ─── KO-2 (B-566): the 1:1 WS decline collapses the decliner's other devices ─

describe('KO-2 — callee WS decline fans the other-device cancel push (HTTP-lane parity)', () => {
  function hangupThis() {
    const self: any = {
      rateGate: () => null,
      callSessions: new Map(),
      socketCalls: new WeakMap(),
      logger: {log: jest.fn(), warn: jest.fn()},
      push: {sendCallCancel: jest.fn(() => Promise.resolve(1))},
      forwardToDevice: jest.fn(async () => undefined),
      clearPendingCallArtifacts: jest.fn(async () => undefined),
    };
    self.gcCallTombstones = proto.gcCallTombstones.bind(self);
    self.authorizeCallFrame = proto.authorizeCallFrame.bind(self);
    self.trackCallStart = proto.trackCallStart.bind(self);
    self.trackCallAnswer = proto.trackCallAnswer.bind(self);
    self.trackCallEnd = proto.trackCallEnd.bind(self);
    return self;
  }
  const CID = 'decline-cid-1';
  const CALLER = {userId: 'caller-w', deviceId: 2};
  const CALLEE = {userId: ME, deviceId: 7};
  function seed(self: any): void {
    self.trackCallStart(fakeClient(CALLER.userId, 2), CID, CALLER, CALLEE);
  }

  it('callee declines a RINGING call → cancel push to the CALLEE\'s other devices, missed=false', async () => {
    const self = hangupThis();
    seed(self);
    await proto.handleCallHangup.call(
      self, {callId: CID, to: CALLER, reason: 'declined'}, fakeClient(ME, 7),
    );
    expect(self.push.sendCallCancel).toHaveBeenCalledWith(ME, CID, CALLER.userId, 'voice', false);
  });

  it('caller gives up on an unanswered ring → the missed=true cancel (unchanged lane)', async () => {
    const self = hangupThis();
    seed(self);
    await proto.handleCallHangup.call(
      self, {callId: CID, to: CALLEE, reason: 'cancelled'}, fakeClient(CALLER.userId, 2),
    );
    expect(self.push.sendCallCancel).toHaveBeenCalledWith(ME, CID, CALLER.userId, 'voice', true);
    expect(self.push.sendCallCancel).toHaveBeenCalledTimes(1);
  });

  it('hangup of an ACTIVE call fans no cancel at all (nothing is ringing)', async () => {
    const self = hangupThis();
    seed(self);
    self.trackCallAnswer(fakeClient(ME, 7), CID, CALLEE);
    await proto.handleCallHangup.call(
      self, {callId: CID, to: CALLER, reason: 'ended'}, fakeClient(ME, 7),
    );
    expect(self.push.sendCallCancel).not.toHaveBeenCalled();
  });
});
