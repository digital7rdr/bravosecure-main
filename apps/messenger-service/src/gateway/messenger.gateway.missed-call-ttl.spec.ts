/**
 * SYNC-5 (B-121 / NA-GATE-6) — missed-call marker TTL + reconnect burst cap.
 *
 *  - `MISSED_CALL_MARKER_TTL_SEC` is env-tunable (7-day default) and
 *    HARD-clamped to min(RELAY_DWELL_SECONDS, 30d): the marker is the one
 *    place the relay holds a cleartext callee→caller tuple, so it must never
 *    outlive an actual envelope. Floored at 60s so a typo'd env can't
 *    disable the feature.
 *  - The 45s SDP-bearing pending-offer payload TTL is UNCHANGED.
 *  - The connect-time `call.missed` / `sfu.ring.missed` drain emits at most
 *    the NEWEST `MISSED_CALL_DRAIN_EMIT_CAP` (50) markers, oldest-first;
 *    overflow is settled (deleted) in the same pass — gone, not deferred.
 *  - `clearPendingCallArtifacts` `{keepMarker}` semantics are untouched
 *    (P1-15 / P2-13 regression guard) so a longer TTL cannot resurrect an
 *    answered/declined call.
 *
 * Same harness style as messenger.gateway.calls.spec.ts: handlers invoked
 * off the prototype with a hand-built `this` and a Map-backed fake ioredis.
 * The TTL constant is module-private and resolved at load, so the env cases
 * use `jest.resetModules()` + a fresh `require` per case and assert
 * indirectly via `handleCallOffer`'s Redis writes.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import type {Socket} from 'socket.io';
import {MessengerGateway} from './messenger.gateway';

const proto: any = MessengerGateway.prototype;

const CALLER = {userId: 'A', deviceId: 1};
const CALLEE = {userId: 'B', deviceId: 7};

const DAY_SEC = 24 * 3600;
const DEFAULT_TTL_SEC = 7 * DAY_SEC;

function fakeClient(sub = 'A', deviceId = 1, connected = true): Socket & {emit: jest.Mock} {
  return {
    id:   `sock-${sub}`,
    data: {claims: {sub}, signalDeviceId: deviceId, sessionId: `s-${sub}`},
    connected,
    emit: jest.fn(),
    join: jest.fn(async () => undefined),
  } as unknown as Socket & {emit: jest.Mock};
}

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
    // WI-6.3 — the artifact CLEAR paths now ride one MULTI. Forward the
    // chained commands into the same kv/sets stores so every existing
    // settle/keepMarker assertion keeps observing identical state.
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

// ─── env-tunable, dwell-clamped TTL (resolved at module load) ────────────

describe('SYNC-5 — MISSED_CALL_MARKER_TTL_SEC env parsing + dwell clamp', () => {
  const ENV_KEYS = ['MISSED_CALL_MARKER_TTL_SEC', 'RELAY_DWELL_SECONDS'] as const;
  const saved: Record<string, string | undefined> = {};
  let logSpy: jest.SpyInstance;

  beforeAll(() => { for (const k of ENV_KEYS) saved[k] = process.env[k]; });
  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  function freshProto(env: Partial<Record<(typeof ENV_KEYS)[number], string>>): any {
    jest.resetModules();
    for (const k of ENV_KEYS) {
      const v = env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('./messenger.gateway') as {MessengerGateway: typeof MessengerGateway};
    return mod.MessengerGateway.prototype as any;
  }

  /** Drive handleCallOffer and return the Redis writes the marker TTL rides on. */
  async function offerWrites(p: any) {
    const redisClient: any = {
      set:    jest.fn(async () => 'OK'),
      sadd:   jest.fn(async () => 1),
      expire: jest.fn(async () => 1),
    };
    // AUDIT Phase-0 item 5 — the offer-queue writes ride ONE MULTI now;
    // forward each chained command into the same recorders so the TTL
    // assertions keep reading identical arg shapes.
    redisClient.multi = () => {
      const chain: any = {
        set:    (...a: unknown[]) => { void redisClient.set(...a);    return chain; },
        sadd:   (...a: unknown[]) => { void redisClient.sadd(...a);   return chain; },
        expire: (...a: unknown[]) => { void redisClient.expire(...a); return chain; },
        exec:   async () => [],
      };
      return chain;
    };
    // B-596: the handler registers the session before the gate and reads it
    // back after — carry the real session bookkeeping.
    const self = {
      rateGate:        () => null,
      privacy:         {isBlockedEither: jest.fn(async () => false)},
      callSessions:    new Map(),
      socketCalls:     new WeakMap(),
      gcCallTombstones:    p.gcCallTombstones,
      untrackCallSilently: p.untrackCallSilently,
      privacyGateBounded:  p.privacyGateBounded,
      trackCallStart:  jest.fn(p.trackCallStart),
      forwardToDevice: jest.fn(async () => undefined),
      push:            {sendVoipWake: jest.fn(async () => ({sent: 1, stubbed: false}))},
      redis:           {client: redisClient},
    };
    await p.handleCallOffer.call(
      self,
      {callId: 'call-ttl-1', to: {userId: CALLEE.userId, deviceId: CALLEE.deviceId}, sdp: 'v=0', kind: 'voice', auth: {v: 1}},
      fakeClient('A', 1),
    );
    const setCalls    = redisClient.set.mock.calls as unknown as unknown[][];
    const expireCalls = redisClient.expire.mock.calls as unknown as unknown[][];
    const offerSet  = setCalls.find(c => String(c[0]).startsWith('pending-call-offer:'));
    const markerSet = setCalls.find(c => String(c[0]).startsWith('missed-call-marker:'));
    const idxExpire = expireCalls.find(c => String(c[0]).startsWith('pending-call-offer-idx:'));
    return {offerSet, markerSet, idxExpire};
  }

  it('default (no env): marker + index take the 7-day default', async () => {
    const {markerSet, idxExpire} = await offerWrites(freshProto({}));
    expect(markerSet!.slice(2)).toEqual(['EX', DEFAULT_TTL_SEC]);
    expect(idxExpire![1]).toBe(DEFAULT_TTL_SEC);
  });

  it('an explicit 14d env value is honoured', async () => {
    const {markerSet} = await offerWrites(freshProto({MISSED_CALL_MARKER_TTL_SEC: '1209600'}));
    expect(markerSet!.slice(2)).toEqual(['EX', 1209600]);
  });

  it('a >30d env value is clamped to 30d', async () => {
    const {markerSet} = await offerWrites(freshProto({MISSED_CALL_MARKER_TTL_SEC: '99999999'}));
    expect(markerSet!.slice(2)).toEqual(['EX', 30 * DAY_SEC]);
  });

  // The key assertion: the marker can never outlive relay dwell.
  it('RELAY_DWELL_SECONDS hard-clamps the marker TTL', async () => {
    const {markerSet, idxExpire} = await offerWrites(freshProto({
      RELAY_DWELL_SECONDS:        '86400',
      MISSED_CALL_MARKER_TTL_SEC: '604800',
    }));
    expect(markerSet!.slice(2)).toEqual(['EX', 86400]);
    expect(idxExpire![1]).toBe(86400);
  });

  it.each(['abc', '0', '-5'])('malformed env %p falls back to the 7-day default (never <= 0)', async raw => {
    const {markerSet} = await offerWrites(freshProto({MISSED_CALL_MARKER_TTL_SEC: raw}));
    expect(markerSet!.slice(2)).toEqual(['EX', DEFAULT_TTL_SEC]);
    expect(markerSet![3] as number).toBeGreaterThan(0);
  });

  it('the 45s SDP-bearing pending-offer payload TTL is UNCHANGED', async () => {
    const {offerSet} = await offerWrites(freshProto({MISSED_CALL_MARKER_TTL_SEC: '1209600'}));
    expect(offerSet!.slice(2)).toEqual(['EX', 45]);
  });
});

// ─── reconnect burst cap: 1:1 drain ──────────────────────────────────────

const IDX_KEY = `pending-call-offer-idx:${CALLEE.userId}:${CALLEE.deviceId}`;
const markerKeyOf = (cid: string) => `missed-call-marker:${CALLEE.userId}:${CALLEE.deviceId}:${cid}`;

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
  self.clearPendingCallArtifacts = jest.fn((...a: any[]) => proto.clearPendingCallArtifacts.apply(self, a));
  self.clearPendingGroupRingArtifacts = jest.fn((...a: any[]) => proto.clearPendingGroupRingArtifacts.apply(self, a));
  return self;
}

describe('SYNC-5 — 1:1 reconnect call.missed burst cap', () => {
  const BASE_AT = 1_700_000_000_000;

  function seedMarkers(n: number) {
    const redis = makeFakeRedis();
    const ids = new Set<string>();
    for (let i = 0; i < n; i++) {
      const cid = `call-${String(i).padStart(3, '0')}`;
      ids.add(cid);
      // Ascending `at`: call-000 is the OLDEST, call-(n-1) the newest.
      redis.kv.set(markerKeyOf(cid), JSON.stringify({
        callId: cid, from: CALLER, kind: 'voice', at: BASE_AT + i * 1000,
      }));
    }
    redis.sets.set(IDX_KEY, ids);
    return redis;
  }

  it('120 queued markers → exactly the newest 50 emit, ascending by at', async () => {
    const redis = seedMarkers(120);
    const self  = drainThis(redis);
    const client = fakeClient('B', 7);

    await proto.deliverPendingCallOffer.call(self, client, CALLEE);

    const emits = client.emit.mock.calls.filter(c => c[0] === 'call.missed');
    expect(emits).toHaveLength(50);
    const ats = emits.map(c => c[1].at as number);
    // Newest 50 = indexes 70..119.
    expect(Math.min(...ats)).toBe(BASE_AT + 70 * 1000);
    expect(Math.max(...ats)).toBe(BASE_AT + 119 * 1000);
    // Oldest-first so the client's chronological splice does no extra work.
    expect(ats).toEqual([...ats].sort((a, b) => a - b));
  });

  it('every marker is settled — including the 70 that never emitted (no Redis leak)', async () => {
    const redis = seedMarkers(120);
    const self  = drainThis(redis);

    await proto.deliverPendingCallOffer.call(self, fakeClient('B', 7), CALLEE);

    const leftoverMarkers = [...redis.kv.keys()].filter(k => k.startsWith('missed-call-marker:'));
    expect(leftoverMarkers).toEqual([]);
    expect(redis.sets.has(IDX_KEY)).toBe(false);
  });

  it('a single marker still emits one frame with the exact legacy shape', async () => {
    const redis = seedMarkers(1);
    const self  = drainThis(redis);
    const client = fakeClient('B', 7);

    await proto.deliverPendingCallOffer.call(self, client, CALLEE);

    const emits = client.emit.mock.calls.filter(c => c[0] === 'call.missed');
    expect(emits).toHaveLength(1);
    expect(emits[0][1]).toEqual({callId: 'call-000', from: CALLER, kind: 'voice', at: BASE_AT});
  });
});

// ─── reconnect burst cap: group drain ────────────────────────────────────

describe('SYNC-5 — group reconnect sfu.ring.missed burst cap', () => {
  const G_IDX = `pending-group-ring-idx:${CALLEE.userId}`;
  const gMarkerKeyOf = (rid: string) => `missed-group-call-marker:${CALLEE.userId}:${rid}`;
  const BASE_AT = 1_700_000_000_000;

  function seedGroupMarkers(n: number) {
    const redis = makeFakeRedis();
    const ids = new Set<string>();
    for (let i = 0; i < n; i++) {
      const rid = `room-${String(i).padStart(3, '0')}`;
      ids.add(rid);
      redis.kv.set(gMarkerKeyOf(rid), JSON.stringify({
        roomId: rid, conversationId: `conv-${i}`, from: CALLER, callType: 'voice', at: BASE_AT + i * 1000,
      }));
    }
    redis.sets.set(G_IDX, ids);
    return redis;
  }

  it('120 queued group markers → newest 50 emit ascending; the rest are settled', async () => {
    const redis = seedGroupMarkers(120);
    const self  = drainThis(redis);
    const client = fakeClient('B', 7);

    await proto.deliverPendingGroupRing.call(self, client, {userId: CALLEE.userId});

    const emits = client.emit.mock.calls.filter(c => c[0] === 'sfu.ring.missed');
    expect(emits).toHaveLength(50);
    const ats = emits.map(c => c[1].at as number);
    expect(Math.min(...ats)).toBe(BASE_AT + 70 * 1000);
    expect(Math.max(...ats)).toBe(BASE_AT + 119 * 1000);
    expect(ats).toEqual([...ats].sort((a, b) => a - b));
    expect([...redis.kv.keys()].filter(k => k.startsWith('missed-group-call-marker:'))).toEqual([]);
    expect(redis.sets.has(G_IDX)).toBe(false);
  });

  it('a fresh ring (<45s) still replays live as sfu.ring.incoming — and now WAITS for the ack', async () => {
    const redis = seedGroupMarkers(1);
    redis.kv.set(`pending-group-ring:${CALLEE.userId}:room-000`, JSON.stringify({
      roomId: 'room-000', conversationId: 'conv-0', callType: 'voice', from: CALLER,
      callerName: 'Alice', roomToken: 'tok', roomTokenExp: 123, at: Date.now(),
    }));
    const self  = drainThis(redis);
    const client = fakeClient('B', 7);

    await proto.deliverPendingGroupRing.call(self, client, {userId: CALLEE.userId});

    expect(client.emit.mock.calls.filter(c => c[0] === 'sfu.ring.incoming')).toHaveLength(1);
    expect(client.emit.mock.calls.filter(c => c[0] === 'sfu.ring.missed')).toHaveLength(0);
    // B-479 — the marker SURVIVES the replay now. It used to be deleted in the
    // same pass as the emit, so a queued ring got exactly one chance to land:
    // a client that could not present it at that instant lost the call with no
    // ring, no replay and no missed-call record. The client's `sfu.ring.ack`
    // is what clears it, once it has taken responsibility.
    expect(redis.kv.has(gMarkerKeyOf('room-000'))).toBe(true);
  });
});

// ─── keepMarker semantics stay exactly as-is (P1-15 / P2-13) ─────────────

describe('SYNC-5 — clearPendingCallArtifacts {keepMarker} regression', () => {
  const OFFER_KEY  = `pending-call-offer:${CALLEE.userId}:${CALLEE.deviceId}:call-1`;
  const MARKER_KEY = markerKeyOf('call-1');

  function seed() {
    const redis = makeFakeRedis();
    redis.kv.set(OFFER_KEY, JSON.stringify({callId: 'call-1', from: CALLER, sdp: 'v=0', kind: 'voice', at: Date.now()}));
    redis.kv.set(MARKER_KEY, JSON.stringify({callId: 'call-1', from: CALLER, kind: 'voice', at: Date.now()}));
    redis.sets.set(IDX_KEY, new Set(['call-1']));
    return redis;
  }

  it('keepMarker: true purges the payload but keeps marker + index entry', async () => {
    const redis = seed();
    await proto.clearPendingCallArtifacts.call(
      {redis: {client: redis.client}}, CALLEE.userId, CALLEE.deviceId, 'call-1', {keepMarker: true},
    );
    expect(redis.kv.has(OFFER_KEY)).toBe(false);
    expect(redis.kv.has(MARKER_KEY)).toBe(true);
    expect(redis.sets.get(IDX_KEY)!.has('call-1')).toBe(true);
  });

  it('default purges payload, marker and index entry (answered/declined cannot resurrect)', async () => {
    const redis = seed();
    await proto.clearPendingCallArtifacts.call(
      {redis: {client: redis.client}}, CALLEE.userId, CALLEE.deviceId, 'call-1',
    );
    expect(redis.kv.has(OFFER_KEY)).toBe(false);
    expect(redis.kv.has(MARKER_KEY)).toBe(false);
    expect(redis.sets.has(IDX_KEY)).toBe(false);
  });
});
