/**
 * B-596 / B-597 — the server half of B-273 (audit Step 1).
 *
 * BEFORE: `handleCallOffer` awaited `privacy.isBlockedEither` (Supabase, 60 s
 * cache) BEFORE `trackCallStart`. The client's B-273 gate flushes every
 * buffered candidate the instant the offer frame is emitted, so the
 * candidates were dispatched while the offer handler was parked at that
 * await — `handleCallIce` → `authorizeCallFrame` found no session and
 * silently `{ignore}`d them. Live-confirmed in the staging relay log
 * (cids 30538aee / e35bd9d0 / d56201cf: `[CALL] ICE` lines precede the
 * `[CALL] OFFER` line for the same cid).
 *
 * AFTER (Step 1): the session is registered synchronously at the top of the
 * handler and marked `offerPending`; candidates for it are HELD (cap 64,
 * drop-oldest) and flushed BEHIND the offer frame once it has been forwarded;
 * an offer-pending session is NOT LIVE for any other consumer (answer /
 * media-state / reoffer / reanswer ignore it; hangup and disconnect end it
 * silently — nothing forwarded, pushed or probed); a blocked pair leaves no
 * session at all (untracked silently — no tombstone, no `duplicate_call_id`
 * oracle); a hangup inside the await window cancels the forward; a throw
 * releases the hold; the block-check is deadline-bounded and on deadline uses
 * the last CACHED verdict (even stale) before failing open for a never-seen
 * pair. The first test below was the DOCUMENTS pin for the broken behaviour
 * and is now the FIXED assertion.
 *
 * Write-up: docs/audits/CALL_JOIN_LATENCY_AUDIT_2026-08-20.md §2 B-596/B-597, §7 Step 1.
 */
import type {Socket} from 'socket.io';
import {MessengerGateway} from './messenger.gateway';

const proto: any = MessengerGateway.prototype;

const CALLER = 'caller-user-b596';
const CALLEE = 'callee-user-b596';
const THIRD  = 'third-user-b596';

function fakeClient(sub = CALLER, deviceId = 1): Socket {
  return {
    id:        `sock-${sub}`,
    data:      {claims: {sub}, signalDeviceId: deviceId, sessionId: `s-${sub}`},
    connected: true,
    emit:      jest.fn(),
    join:      jest.fn(async () => undefined),
  } as unknown as Socket;
}

type Forwarded = {event: string; to: {userId: string; deviceId: number}; frame: unknown};

/**
 * A gateway `this` with the REAL session bookkeeping (trackCallStart /
 * trackCallEnd / authorizeCallFrame / gcCallTombstones / untrackCallSilently /
 * clearOfferHold / privacyGateBounded bound to real maps) and a recording
 * forwardToDevice. `privacy` is a function so a test can make it slow,
 * blocked, or hang; `peek` seeds the stale-cache verdict.
 */
function harness(opts: {
  privacy?: (a: string, b: string) => Promise<boolean>;
  peek?: (a: string, b: string) => boolean | undefined;
  forwardResult?: (event: string) => unknown;
  forwardThrows?: (event: string) => Error | undefined;
}) {
  const redisExec = jest.fn(async () => [[null, 'OK'], [null, 'OK'], [null, 1], [null, 1]]);
  const redisClient: any = {
    set:    jest.fn(async () => 'OK'),
    sadd:   jest.fn(async () => 1),
    expire: jest.fn(async () => 1),
  };
  redisClient.multi = () => {
    const chain: any = {
      set:    () => chain,
      sadd:   () => chain,
      expire: () => chain,
      exec:   redisExec,
    };
    return chain;
  };
  const forwarded: Forwarded[] = [];
  const self: any = {
    rateGate: () => null,
    privacy:  {
      isBlockedEither: jest.fn((a: string, b: string) =>
        (opts.privacy ?? (() => new Promise<boolean>(r => setTimeout(() => r(false), 5))))(a, b)),
      peekBlockedEither: jest.fn((a: string, b: string) => opts.peek?.(a, b)),
    },
    callSessions:        new Map(),
    socketCalls:         new WeakMap(),
    trackCallStart:      proto.trackCallStart,
    trackCallEnd:        proto.trackCallEnd,
    gcCallTombstones:    proto.gcCallTombstones,
    authorizeCallFrame:  proto.authorizeCallFrame,
    untrackCallSilently: proto.untrackCallSilently,
    clearOfferHold:      proto.clearOfferHold,
    privacyGateBounded:  proto.privacyGateBounded,
    clearPendingCallArtifacts: jest.fn(async () => undefined),
    forwardToDevice: jest.fn(async (
      _client: unknown,
      to: {userId: string; deviceId: number},
      _volatile: unknown,
      build: (from: {userId: string; deviceId: number}) => {event: string},
    ) => {
      const frame = build({userId: CALLER, deviceId: 1});
      const err = opts.forwardThrows?.(frame.event);
      if (err) throw err;
      forwarded.push({event: frame.event, to, frame});
      return opts.forwardResult ? opts.forwardResult(frame.event) : undefined;
    }),
    push:  {
      sendVoipWake:   jest.fn(async () => ({sent: 1, stubbed: false})),
      sendCallCancel: jest.fn(async () => ({sent: 1})),
    },
    redis: {client: redisClient},
  };
  return {self, forwarded, redisClient, redisExec};
}

const CALL_ID = 'call-b596-0001';
const offer = {
  callId: CALL_ID,
  to:     {userId: CALLEE, deviceId: 1},
  sdp:    'v=0',
  kind:   'voice',
  auth:   {v: 1} as never,
};
// No real address — the relay never parses the candidate string.
const ice = (n = 0) => ({
  callId:        CALL_ID,
  to:            {userId: CALLEE, deviceId: 1},
  candidate:     `candidate:${n} 1 udp 1 0.0.0.0 0 typ host`,
  sdpMid:        '0',
  sdpMLineIndex: 0,
});
const hangup = {callId: CALL_ID, to: {userId: CALLEE, deviceId: 1}, reason: 'ended'};

const events = (f: Forwarded[]) => f.map(x => x.event);

describe('B-596 — call.ice arriving while handleCallOffer awaits the block-check', () => {
  afterEach(() => { delete process.env.PRIVACY_CALL_GATE_DEADLINE_MS; });

  it('FIXED — candidates that arrive during the await are held and flushed BEHIND the offer, in order', async () => {
    const {self, forwarded} = harness({});
    const client = fakeClient();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const offerDone = proto.handleCallOffer.call(self, offer, client);   // parks at the privacy await
      // The client's B-273 gate flushed three candidates right behind the offer
      // frame; socket.io dispatches them while the offer handler is parked.
      const r1 = await proto.handleCallIce.call(self, ice(1), client);
      const r2 = await proto.handleCallIce.call(self, ice(2), client);
      const r3 = await proto.handleCallIce.call(self, ice(3), client);
      expect([r1, r2, r3]).toEqual([undefined, undefined, undefined]);     // silent hold, no error
      expect(forwarded).toEqual([]);                                       // NOTHING before the offer
      await offerDone;
      expect(events(forwarded)).toEqual(['call.offer', 'call.ice', 'call.ice', 'call.ice']);
      const cands = forwarded.slice(1).map(x => (x.frame as {data: {candidate: string}}).data.candidate);
      expect(cands).toEqual([ice(1).candidate, ice(2).candidate, ice(3).candidate]);
      const s = self.callSessions.get(CALL_ID);
      expect(s?.state).toBe('ringing');
      expect(s?.offerPending).toBe(false);
      expect(s?.heldIce).toBeUndefined();
      // The Step 0 counter goes to zero: no candidate was IGNORED.
      expect(warn.mock.calls.map(c => String(c[0])).filter(l => l.startsWith('[CALL] ICE ignored'))).toEqual([]);
    } finally { warn.mockRestore(); }
  });

  it('the session exists from the handler\'s FIRST line (before the first await) — a candidate is authorised immediately', async () => {
    const {self} = harness({privacy: () => new Promise(() => { /* never resolves inside the test */ })});
    process.env.PRIVACY_CALL_GATE_DEADLINE_MS = '50';
    const client = fakeClient();
    const offerDone = proto.handleCallOffer.call(self, offer, client);
    expect(self.callSessions.get(CALL_ID)?.offerPending).toBe(true);
    const auth = proto.authorizeCallFrame.call(self, CALLER, CALL_ID);
    expect(auth.ok).toBe(true);
    await offerDone;
  });

  it('after the offer, a candidate is forwarded immediately (the hold is released exactly once)', async () => {
    const {self, forwarded} = harness({});
    const client = fakeClient();
    await proto.handleCallOffer.call(self, offer, client);
    await proto.handleCallIce.call(self, ice(9), client);
    expect(events(forwarded)).toEqual(['call.offer', 'call.ice']);
  });

  it('a CONCURRENT duplicate offer for the same cid inside the window is rejected the same way for any pair (no block oracle)', async () => {
    const {self, forwarded} = harness({});
    const client = fakeClient();
    const first = proto.handleCallOffer.call(self, offer, client);
    const dup = await proto.handleCallOffer.call(self, offer, client);
    expect((dup as {data: {code: string}}).data.code).toBe('duplicate_call_id');
    await first;
    expect(events(forwarded)).toEqual(['call.offer']);                    // the first offer still goes out once
  });

  it('BLOCKED pair: no forward, no held ICE forwarded, no queue, no wake, no error — and NO session remains (no oracle)', async () => {
    const {self, forwarded, redisExec} = harness({privacy: async () => true});
    const client = fakeClient();
    const offerDone = proto.handleCallOffer.call(self, offer, client);
    await proto.handleCallIce.call(self, ice(1), client);                // held during the window…
    const ret = await offerDone;
    expect(ret).toBeUndefined();
    expect(forwarded).toEqual([]);                                       // …and never forwarded
    expect(redisExec).not.toHaveBeenCalled();                            // no pending-offer MULTI
    expect(self.push.sendVoipWake).not.toHaveBeenCalled();
    expect(self.callSessions.has(CALL_ID)).toBe(false);                  // untracked silently
    // A retried offer with the SAME callId is a never-seen one — no duplicate_call_id oracle.
    const again = await proto.handleCallOffer.call(self, offer, client);
    expect(again).toBeUndefined();
    expect(self.callSessions.has(CALL_ID)).toBe(false);
    // A third party probing the cid learns nothing either way.
    expect(proto.authorizeCallFrame.call(self, THIRD, CALL_ID)).toEqual({ok: false, ignore: true});
  });

  describe('an offer-pending session is NOT LIVE for any sibling handler (nothing may reach the callee before the offer)', () => {
    it('handleCallHangup inside the window: ends the session silently — no forward, no cancel push, no artifact clear', async () => {
      const {self, forwarded, redisExec} = harness({privacy: () => new Promise(r => setTimeout(() => r(false), 15))});
      const client = fakeClient();
      const offerDone = proto.handleCallOffer.call(self, offer, client);
      await proto.handleCallIce.call(self, ice(1), client);
      const ret = await proto.handleCallHangup.call(self, hangup, client);   // the REAL handler
      expect(ret).toBeUndefined();
      expect(self.callSessions.get(CALL_ID)?.state).toBe('ended');
      expect(self.push.sendCallCancel).not.toHaveBeenCalled();              // no phantom "Missed call"
      expect(self.clearPendingCallArtifacts).not.toHaveBeenCalled();
      expect(forwarded).toEqual([]);                                         // no hangup frame to a callee that never rang
      await offerDone;
      expect(forwarded).toEqual([]);                                         // and the parked offer + held ICE are dropped
      expect(redisExec).not.toHaveBeenCalled();
      expect(self.push.sendVoipWake).not.toHaveBeenCalled();
    });

    it('handleCallHangup AFTER the offer went out behaves as before (forward + cancel push)', async () => {
      const {self, forwarded} = harness({});
      const client = fakeClient();
      await proto.handleCallOffer.call(self, offer, client);
      await proto.handleCallHangup.call(self, hangup, client);
      expect(events(forwarded)).toEqual(['call.offer', 'call.hangup']);
      expect(self.push.sendCallCancel).toHaveBeenCalled();
    });

    for (const [name, fn, frame] of [
      ['handleCallMediaState', 'handleCallMediaState', {callId: CALL_ID, to: {userId: CALLEE, deviceId: 1}, cameraOff: true, micOff: false}],
      ['handleCallReOffer',    'handleCallReOffer',    {callId: CALL_ID, to: {userId: CALLEE, deviceId: 1}, sdp: 'v=0'}],
      ['handleCallReAnswer',   'handleCallReAnswer',   {callId: CALL_ID, to: {userId: CALLEE, deviceId: 1}, sdp: 'v=0'}],
    ] as const) {
      it(`${name} inside the window is ignored (no forward, no probe)`, async () => {
        const {self, forwarded} = harness({privacy: () => new Promise(r => setTimeout(() => r(false), 15))});
        const client = fakeClient();
        const offerDone = proto.handleCallOffer.call(self, offer, client);
        const ret = await proto[fn].call(self, frame, client);
        expect(ret).toBeUndefined();
        expect(forwarded).toEqual([]);
        await offerDone;
        expect(events(forwarded)).toEqual(['call.offer']);
      });
    }

    it('handleCallAnswer inside the window is ignored (no arbitration, no forward)', async () => {
      const {self, forwarded} = harness({privacy: () => new Promise(r => setTimeout(() => r(false), 15))});
      const caller = fakeClient();
      const callee = fakeClient(CALLEE, 1);
      const offerDone = proto.handleCallOffer.call(self, offer, caller);
      const ret = await proto.handleCallAnswer.call(self, {callId: CALL_ID, to: {userId: CALLER, deviceId: 1}, sdp: 'v=0'}, callee);
      expect(ret).toBeUndefined();
      expect(forwarded).toEqual([]);
      expect(self.callSessions.get(CALL_ID)?.state).toBe('ringing');
      await offerDone;
    });

    it('population pin — every authorizeCallFrame consumer and the disconnect sweep handle offerPending', () => {
      const fs = require('node:fs') as typeof import('node:fs');
      const path = require('node:path') as typeof import('node:path');
      const src = fs.readFileSync(path.join(__dirname, 'messenger.gateway.ts'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\r\n]*/g, '');
      const sites = [...src.matchAll(/this\.authorizeCallFrame\(/g)].map(m => m.index ?? -1);
      expect(sites.length).toBe(6);                                          // answer, ice, hangup, media-state, reoffer, reanswer
      for (const at of sites) {
        const handlerStart = src.lastIndexOf('@SubscribeMessage', at);
        const handlerEnd   = src.indexOf('@SubscribeMessage', at);
        const body = src.slice(handlerStart, handlerEnd === -1 ? undefined : handlerEnd);
        expect(body).toContain('offerPending');
      }
      const disc = src.indexOf('const ownedCalls = this.socketCalls.get(client);');
      expect(disc).toBeGreaterThan(-1);
      expect(src.slice(disc, disc + 600)).toContain('if (session.offerPending) { this.trackCallEnd(callId); continue; }');
    });
  });

  it('a hangup that lands DURING the forward await: nothing more goes out — except the hangup the ringing callee would otherwise never get', async () => {
    let releaseForward: () => void = () => undefined;
    const {self, forwarded, redisExec} = harness({
      privacy: async () => false,
    });
    // Make the OFFER forward park until we release it (the probe await).
    self.forwardToDevice = jest.fn(async (_c: unknown, to: {userId: string; deviceId: number}, _v: unknown, build: (from: {userId: string; deviceId: number}) => {event: string}) => {
      const frame = build({userId: CALLER, deviceId: 1});
      if (frame.event === 'call.offer') {await new Promise<void>(r => { releaseForward = r; });}
      forwarded.push({event: frame.event, to, frame});
      return undefined;
    });
    const client = fakeClient();
    const offerDone = proto.handleCallOffer.call(self, offer, client);
    await new Promise(r => setTimeout(r, 10));                                   // past the gate, parked in the forward
    expect(self.callSessions.get(CALL_ID)?.offerPending).toBe(true);
    await proto.handleCallHangup.call(self, hangup, client);                      // silent in-window end
    releaseForward();
    await offerDone;
    // The offer frame left (the forward resolved OK) → the callee gets the hangup it missed.
    expect(events(forwarded)).toEqual(['call.offer', 'call.hangup']);
    expect(redisExec).not.toHaveBeenCalled();                                      // no queued replay
    expect(self.push.sendVoipWake).not.toHaveBeenCalled();                         // no wake
  });

  it('a THROWING forward releases the hold (later candidates are not black-holed)', async () => {
    const {self, forwarded} = harness({forwardThrows: ev => (ev === 'call.offer' ? new Error('fetchSockets timeout') : undefined)});
    const client = fakeClient();
    const offerDone = proto.handleCallOffer.call(self, offer, client);
    await proto.handleCallIce.call(self, ice(1), client);
    await expect(offerDone).rejects.toThrow('fetchSockets timeout');
    const s = self.callSessions.get(CALL_ID);
    expect(s?.offerPending).toBe(false);
    expect(s?.heldIce).toBeUndefined();
    await proto.handleCallIce.call(self, ice(2), client);                        // now forwarded directly
    expect(events(forwarded)).toEqual(['call.ice']);
  });

  it('held candidates are DISCARDED when the offer does not reach the callee (peer_offline) — never sent ahead of a replay', async () => {
    const offline = {event: 'error', data: {code: 'peer_offline', message: 'callee not connected'}};
    const {self, forwarded} = harness({forwardResult: ev => (ev === 'call.offer' ? offline : undefined)});
    const client = fakeClient();
    const offerDone = proto.handleCallOffer.call(self, offer, client);
    await proto.handleCallIce.call(self, ice(1), client);
    await offerDone;
    expect(events(forwarded)).toEqual(['call.offer']);
    expect(self.callSessions.get(CALL_ID)?.heldIce).toBeUndefined();
  });

  it('the hold is bounded: 64 candidates, drop-oldest', async () => {
    const {self, forwarded} = harness({privacy: () => new Promise(r => setTimeout(() => r(false), 20))});
    const client = fakeClient();
    const offerDone = proto.handleCallOffer.call(self, offer, client);
    for (let i = 0; i < 70; i++) {await proto.handleCallIce.call(self, ice(i), client);}
    await offerDone;
    const cands = forwarded.filter(f => f.event === 'call.ice').map(x => (x.frame as {data: {candidate: string}}).data.candidate);
    expect(cands).toHaveLength(64);
    expect(cands[0]).toBe(ice(6).candidate);                             // 0..5 dropped
    expect(cands[63]).toBe(ice(69).candidate);
  });

  it('B-597 — a hung lookup cannot hold the offer: on deadline a NEVER-SEEN pair fails open (probe-error semantics)', async () => {
    process.env.PRIVACY_CALL_GATE_DEADLINE_MS = '30';
    const {self, forwarded} = harness({privacy: () => new Promise(() => { /* hangs */ })});
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const t0 = Date.now();
      await proto.handleCallOffer.call(self, offer, fakeClient());
      expect(Date.now() - t0).toBeLessThan(1_000);
      expect(events(forwarded)).toEqual(['call.offer']);
      expect(warn.mock.calls.map(c => String(c[0]))).toContainEqual(expect.stringContaining('privacy gate deadline lane=offer'));
      expect(warn.mock.calls.map(c => String(c[0]))).toContainEqual(expect.stringContaining('verdict=open(never-seen)'));
    } finally { warn.mockRestore(); }
  });

  it('B-597 — on deadline a pair with a CACHED (even stale) "blocked" verdict stays BLOCKED', async () => {
    process.env.PRIVACY_CALL_GATE_DEADLINE_MS = '30';
    const {self, forwarded} = harness({privacy: () => new Promise(() => { /* hangs */ }), peek: () => true});
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const ret = await proto.handleCallOffer.call(self, offer, fakeClient());
      expect(ret).toBeUndefined();
      expect(forwarded).toEqual([]);
      expect(self.callSessions.has(CALL_ID)).toBe(false);
      expect(warn.mock.calls.map(c => String(c[0]))).toContainEqual(expect.stringContaining('verdict=cached(true)'));
    } finally { warn.mockRestore(); }
  });

  it('B-597 — a BLOCKED verdict that arrives inside the deadline still drops (the bound never widens the gate)', async () => {
    process.env.PRIVACY_CALL_GATE_DEADLINE_MS = '200';
    const {self, forwarded} = harness({privacy: () => new Promise(r => setTimeout(() => r(true), 10))});
    const ret = await proto.handleCallOffer.call(self, offer, fakeClient());
    expect(ret).toBeUndefined();
    expect(forwarded).toEqual([]);
    expect(self.callSessions.has(CALL_ID)).toBe(false);
  });

  it('Step 0 marker — a candidate for a cid with NO session is still countable as reason=no_session', async () => {
    const {self} = harness({});
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await proto.handleCallIce.call(self, {...ice(0), callId: 'never-offered'}, fakeClient());
      expect(warn.mock.calls.map(c => String(c[0]))).toContain('[CALL] ICE ignored cid=never-of reason=no_session');
    } finally { warn.mockRestore(); }
  });

  describe('B-597 — privacyGateBounded (offer + ring lanes)', () => {
    const gate = (privacy: () => Promise<boolean>, lane: 'offer' | 'ring' = 'ring', peek?: () => boolean | undefined) =>
      proto.privacyGateBounded.call({privacy: {isBlockedEither: privacy, peekBlockedEither: peek ?? (() => undefined)}}, 'a', 'b', lane) as Promise<boolean>;

    it('resolves the real verdict when it arrives inside the deadline (blocked stays blocked)', async () => {
      process.env.PRIVACY_CALL_GATE_DEADLINE_MS = '200';
      await expect(gate(() => new Promise(r => setTimeout(() => r(true), 5)))).resolves.toBe(true);
      await expect(gate(() => Promise.resolve(false))).resolves.toBe(false);
    });
    it('on deadline: stale cached verdict first, fail-open only for a never-seen pair; logs the lane + verdict source', async () => {
      process.env.PRIVACY_CALL_GATE_DEADLINE_MS = '25';
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const t0 = Date.now();
        await expect(gate(() => new Promise(() => { /* hangs */ }), 'ring')).resolves.toBe(false);
        await expect(gate(() => new Promise(() => { /* hangs */ }), 'ring', () => true)).resolves.toBe(true);
        await expect(gate(() => new Promise(() => { /* hangs */ }), 'ring', () => false)).resolves.toBe(false);
        expect(Date.now() - t0).toBeLessThan(1_000);
        const lines = warn.mock.calls.map(c => String(c[0]));
        expect(lines).toContainEqual(expect.stringContaining('privacy gate deadline lane=ring'));
        expect(lines).toContainEqual(expect.stringContaining('verdict=cached(true)'));
        expect(lines).toContainEqual(expect.stringContaining('verdict=open(never-seen)'));
      } finally { warn.mockRestore(); }
    });
    it('0 / non-numeric disables the bound (the raw lookup is awaited)', async () => {
      process.env.PRIVACY_CALL_GATE_DEADLINE_MS = '0';
      await expect(gate(() => new Promise(r => setTimeout(() => r(true), 15)))).resolves.toBe(true);
      process.env.PRIVACY_CALL_GATE_DEADLINE_MS = 'abc';
      await expect(gate(() => new Promise(r => setTimeout(() => r(true), 15)))).resolves.toBe(true);
    });
    it('default is 500 ms when unset', () => {
      delete process.env.PRIVACY_CALL_GATE_DEADLINE_MS;
      const fs = require('node:fs') as typeof import('node:fs');
      const path = require('node:path') as typeof import('node:path');
      const src = fs.readFileSync(path.join(__dirname, 'messenger.gateway.ts'), 'utf8');
      expect(src).toContain('process.env.PRIVACY_CALL_GATE_DEADLINE_MS ?? 500');
    });
    it('static pin — the group ring fan-out uses the bounded gate, and the messaging lanes do NOT', () => {
      const fs = require('node:fs') as typeof import('node:fs');
      const path = require('node:path') as typeof import('node:path');
      const src = fs.readFileSync(path.join(__dirname, 'messenger.gateway.ts'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\r\n]*/g, '');
      const ringStart = src.indexOf("@SubscribeMessage('sfu.ring')");
      const ringEnd   = src.indexOf('@SubscribeMessage', ringStart + 10);
      expect(src.slice(ringStart, ringEnd)).toContain("this.privacyGateBounded(callerId, uid, 'ring')");
      // Exactly the two CALL lanes (offer, ring) are bounded; every other
      // isBlockedEither caller (typing / receipts / messaging) keeps the raw await.
      const bounded = [...src.matchAll(/this\.privacyGateBounded\(/g)].length;
      expect(bounded).toBe(2);
      expect(src).toMatch(/this\.privacy\.isBlockedEither\(ctx\.claims\.sub, data\.to\.userId\)/); // a messaging lane, unbounded
    });
  });

  it('static pin — in handleCallOffer, trackCallStart precedes the first await', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const src = fs.readFileSync(path.join(__dirname, 'messenger.gateway.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\r\n]*/g, '');
    const start = src.indexOf("@SubscribeMessage('call.offer')");
    const end   = src.indexOf('@SubscribeMessage', start + 10);
    const body  = src.slice(start, end);
    const trackAt = body.indexOf('this.trackCallStart(');
    const awaitAt = body.indexOf('await ');
    expect(trackAt).toBeGreaterThan(-1);
    expect(awaitAt).toBeGreaterThan(-1);
    expect(trackAt).toBeLessThan(awaitAt);
    expect(body).toContain('privacyGateBounded(');
    expect(body).toContain('untrackCallSilently(');
    expect(body).toContain('clearOfferHold(');
  });
});
