/**
 * WI-2.5(b) — an offer REPLAY for a registered, still-ringing call that the
 * user has explicitly accepted must re-assert the acceptance, not be swallowed.
 *
 * The hole: `dispatchCallFrame`'s `call.offer` case routes a replay for a
 * REGISTERED callId straight to `sig.ingest(f)` and returns. `CallController`
 * never subscribes `onOffer`, so the frame dies there — and because the offer
 * never reaches `onIncoming`, B-102 A1's `autoAccept` re-assert (which lives
 * inside that handler) is unreachable the moment the hook has registered. The
 * user answered from the notification; the replay lands second; the accept
 * flag is gone and the ring screen comes back on a call they already answered.
 *
 * This is deliberately ADDITIVE to A1 — it re-enters the very same handler,
 * rather than growing a second re-assert mechanism that could drift from it.
 *
 * Security shape, per B-331: the dispatcher may act on an offer ONLY inside
 * the S7-verified `.then`. The registered-`sig` branch runs BEFORE the
 * verifier, so a forged replay reaches it — acting on that unverified would
 * hand an attacker an accept trigger.
 */
import {
  dispatchCallFrame,
  setIncomingCallHandler,
  setCallOfferVerifier,
  registerSignalling,
  clearAllCallDispatchState,
} from '../webrtc/callDispatcher';
import * as cache from '../push/incomingCallCache';
import * as reg from '../runtime/callRegistry';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

jest.mock('../push/fcmBootstrap', () => ({
  __esModule: true,
  wasCallExplicitlyAccepted: (id: string) => mockAccepted.has(id),
}));
const mockAccepted = new Set<string>();

const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0));

const CALL = 'cid-replay';
const PEER = {userId: 'caller-uid', deviceId: 3};

function offerFrame(callId = CALL, sdp = 'v=0 offer-sdp'): never {
  return {
    event: 'call.offer',
    data: {callId, from: PEER, sdp, kind: 'video', auth: {certB64: 'x', sigB64: 'y', signedAtMs: 1}},
  } as never;
}

/** A minimal CallSignalling stand-in — the dispatcher only calls `ingest`. */
function fakeSig() {
  const ingested: unknown[] = [];
  return {sig: {ingest: (f: unknown) => ingested.push(f)} as never, ingested};
}

function seedRingingCall(callId = CALL): void {
  reg.setActiveCall({
    callId, conversationId: `direct:${PEER.userId}`, peer: PEER, peerName: '',
    kind: 'video', direction: 'incoming', controller: null, signalling: null,
    unregister: null, localStream: null, remoteStream: null, audioTrack: null,
    videoTrack: null, state: 'ringing', isMinimized: false, keepAlive: false,
    connectedAtMs: null,
  });
}

let unregister: (() => void) | null = null;

// The re-assert latch is module state keyed by callId, and every case here
// uses the same id — without this reset the first test latches it and the rest
// are silently swallowed.
beforeEach(() => {
  clearAllCallDispatchState();
  setIncomingCallHandler(null);
  setCallOfferVerifier(null);
  cache._resetIncomingCallCacheForTests();
  mockAccepted.clear();
  reg.setActiveCall(null);
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  unregister?.(); unregister = null;
  setIncomingCallHandler(null);
  setCallOfferVerifier(null);
  reg.setActiveCall(null);
  jest.restoreAllMocks();
});

// ────────────────────────────────────────────────────────────────────
describe('WI-2.5(b) — the replay re-asserts an explicit accept', () => {
  it('re-enters the incoming handler when the call is ringing AND explicitly accepted', async () => {
    const {sig, ingested} = fakeSig();
    unregister = registerSignalling(CALL, sig);
    seedRingingCall();
    mockAccepted.add(CALL);
    const seen: Array<{callId: string}> = [];
    setIncomingCallHandler(d => { seen.push(d as {callId: string}); return true; });
    setCallOfferVerifier(async () => ({ok: true}));

    dispatchCallFrame(offerFrame());
    await flush();

    // The registered signalling still gets the frame — that path is unchanged.
    expect(ingested).toHaveLength(1);
    // …and the accept is re-asserted through A1's own handler.
    expect(seen.map(d => d.callId)).toEqual([CALL]);
  });

  it('logs the re-assert on the [CALLSM] lane', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const {sig} = fakeSig();
    unregister = registerSignalling(CALL, sig);
    seedRingingCall();
    mockAccepted.add(CALL);
    setIncomingCallHandler(() => true);
    setCallOfferVerifier(async () => ({ok: true}));

    dispatchCallFrame(offerFrame());
    await flush();

    const lines = warn.mock.calls.map(c => String(c[0]));
    expect(lines.some(l => l.includes('[CALLSM]') && l.includes('offer-replay accept re-assert'))).toBe(true);
  });
});

describe('WI-2.5(b) — every guard that must hold', () => {
  it('does NOTHING when the call was never explicitly accepted', async () => {
    const {sig} = fakeSig();
    unregister = registerSignalling(CALL, sig);
    seedRingingCall();
    // mockAccepted deliberately empty — a plain ring must keep its ring UI.
    const seen: unknown[] = [];
    setIncomingCallHandler(d => { seen.push(d); return true; });
    setCallOfferVerifier(async () => ({ok: true}));

    dispatchCallFrame(offerFrame());
    await flush();
    expect(seen).toHaveLength(0);
  });

  it('does NOTHING once the call is past ringing', async () => {
    const {sig} = fakeSig();
    unregister = registerSignalling(CALL, sig);
    seedRingingCall();
    reg.patchActiveCall(CALL, {state: 'connected'});
    mockAccepted.add(CALL);
    const seen: unknown[] = [];
    setIncomingCallHandler(d => { seen.push(d); return true; });
    setCallOfferVerifier(async () => ({ok: true}));

    dispatchCallFrame(offerFrame());
    await flush();
    expect(seen).toHaveLength(0);
  });

  it('does NOTHING for a tombstoned callId (declined / peer hung up)', async () => {
    const {sig} = fakeSig();
    unregister = registerSignalling(CALL, sig);
    seedRingingCall();
    mockAccepted.add(CALL);
    cache.clearIncomingCallPayload(CALL);   // tombstones the id
    const seen: unknown[] = [];
    setIncomingCallHandler(d => { seen.push(d); return true; });
    setCallOfferVerifier(async () => ({ok: true}));

    dispatchCallFrame(offerFrame());
    await flush();
    expect(seen).toHaveLength(0);
  });

  it('SECURITY — a FORGED replay never triggers the re-assert', async () => {
    // The registered-`sig` branch runs before the verifier, so this frame
    // reaches the dispatcher unverified. Acting on it would hand an attacker
    // an accept trigger on a call they do not own.
    const {sig, ingested} = fakeSig();
    unregister = registerSignalling(CALL, sig);
    seedRingingCall();
    mockAccepted.add(CALL);
    const seen: unknown[] = [];
    setIncomingCallHandler(d => { seen.push(d); return true; });
    setCallOfferVerifier(async () => ({ok: false, reason: 'bad-sig'}));

    dispatchCallFrame(offerFrame());
    await flush();

    expect(ingested).toHaveLength(1);   // ingest is unchanged
    expect(seen).toHaveLength(0);       // but nothing acted on it
  });

  it('is a NO-OP in the headless shape (no incoming handler registered)', async () => {
    // B-331's lesson: the seam suites do not model a live socket owned by a VM
    // with no UI. `onIncoming` is null there, and this must simply not fire.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const {sig, ingested} = fakeSig();
    unregister = registerSignalling(CALL, sig);
    seedRingingCall();
    mockAccepted.add(CALL);
    setIncomingCallHandler(null);
    setCallOfferVerifier(async () => ({ok: true}));

    expect(() => dispatchCallFrame(offerFrame())).not.toThrow();
    await flush();
    expect(ingested).toHaveLength(1);
    // Discriminating assertion: "it did not throw" is NOT evidence — the
    // re-assert's own try/catch would swallow a null-handler call and this
    // test would pass with the guard deleted. The [CALLSM] line is emitted
    // BEFORE the handler runs, so its absence proves the guard fired.
    const lines = warn.mock.calls.map(c => String(c[0]));
    expect(lines.some(l => l.includes('offer-replay accept re-assert'))).toBe(false);
  });

  it('does NOTHING when the registry holds a DIFFERENT call', async () => {
    const {sig} = fakeSig();
    unregister = registerSignalling(CALL, sig);
    seedRingingCall('some-other-call');
    mockAccepted.add(CALL);
    const seen: unknown[] = [];
    setIncomingCallHandler(d => { seen.push(d); return true; });
    setCallOfferVerifier(async () => ({ok: true}));

    dispatchCallFrame(offerFrame());
    await flush();
    expect(seen).toHaveLength(0);
  });
});

describe('WI-2.5(b) — the case stays synchronous (MESSAGE_LOOP trap 12)', () => {
  it('dispatchCallFrame returns true synchronously for a registered replay', () => {
    // Adding an `await` inside a switch case reorders that case against every
    // other frame class. The verification must be fire-and-forget.
    const {sig} = fakeSig();
    unregister = registerSignalling(CALL, sig);
    seedRingingCall();
    mockAccepted.add(CALL);
    setIncomingCallHandler(() => true);
    setCallOfferVerifier(async () => ({ok: true}));

    const out = dispatchCallFrame(offerFrame());
    expect(out).toBe(true);   // a Promise here would mean the case went async
  });
});

// ────────────────────────────────────────────────────────────────────
describe('WI-2.5(b) — findings from the Phase-2 adversarial review', () => {
  it('P1 — the re-assert NAVIGATES ONLY; it must not re-run the ring presentation', async () => {
    // The full `onIncoming` also raises Telecom (`reportIncomingCall`) and
    // re-seeds the incoming-call cache. Re-running that for a call the user is
    // already answering hands `displayIncomingCall` a uuid that already has a
    // connection: RNCallKeep replaces its map entry, the original connection is
    // orphaned, and the later `reportEnded` ends the wrong one — a stuck system
    // call. The handler must be told this is a re-assert.
    const {sig} = fakeSig();
    unregister = registerSignalling(CALL, sig);
    seedRingingCall();
    mockAccepted.add(CALL);
    const opts: Array<{reassert?: boolean} | undefined> = [];
    setIncomingCallHandler((_d, o) => { opts.push(o); return true; });
    setCallOfferVerifier(async () => ({ok: true}));

    dispatchCallFrame(offerFrame());
    await flush();

    expect(opts).toEqual([{reassert: true}]);
  });

  it('F2 — guards are RE-CHECKED after the async verify, not only before it', async () => {
    // The S7 verify is an XEd25519 chain. The ring can expire, or the user can
    // decline, inside it. Acting on guards that were true a moment ago would
    // navigate + auto-accept a call the caller already abandoned — the B-110
    // ghost-auto-answer shape.
    const {sig} = fakeSig();
    unregister = registerSignalling(CALL, sig);
    seedRingingCall();
    mockAccepted.add(CALL);
    const seen: unknown[] = [];
    setIncomingCallHandler(d => { seen.push(d); return true; });

    let releaseVerify!: () => void;
    const gate = new Promise<void>(r => { releaseVerify = r; });
    setCallOfferVerifier(async () => { await gate; return {ok: true}; });

    dispatchCallFrame(offerFrame());
    await flush();
    expect(seen).toHaveLength(0);        // still verifying

    // The ring expires mid-verify — exactly what the 45 s server replay window
    // makes routine.
    reg.setActiveCall(null);
    releaseVerify();
    await flush();

    expect(seen).toHaveLength(0);
  });

  it('the re-assert fires at most ONCE per callId', async () => {
    // The server replays the offer on every reconnect drain; without a latch
    // this re-navigates once per reconnect for the whole ring window.
    const {sig} = fakeSig();
    unregister = registerSignalling(CALL, sig);
    seedRingingCall();
    mockAccepted.add(CALL);
    const seen: unknown[] = [];
    setIncomingCallHandler(d => { seen.push(d); return true; });
    setCallOfferVerifier(async () => ({ok: true}));

    dispatchCallFrame(offerFrame());
    await flush();
    dispatchCallFrame(offerFrame());
    await flush();
    dispatchCallFrame(offerFrame());
    await flush();

    expect(seen).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────────────────────
describe('WI-2.5(b) — review round 3', () => {
  it('a handler whose navigate did NOT land must not burn the latch', async () => {
    // `onIncoming` discards its own navigate boolean at the B-460 call site,
    // and the resolver returns false when React Navigation silently drops an
    // unresolvable nested navigate (the product-gate / product-switch hold
    // windows). Latching up-front meant that replay spent the callId forever,
    // so the reconnect replay — the recovery this whole mechanism exists to
    // consume — was swallowed and the call rang out to a missed call.
    const {sig} = fakeSig();
    unregister = registerSignalling(CALL, sig);
    seedRingingCall();
    mockAccepted.add(CALL);
    setCallOfferVerifier(async () => ({ok: true}));

    let landed = false;
    const seen: unknown[] = [];
    setIncomingCallHandler(d => { seen.push(d); return landed; });

    dispatchCallFrame(offerFrame());          // navigate dropped
    await flush();
    expect(seen).toHaveLength(1);

    landed = true;                            // the reconnect replay
    dispatchCallFrame(offerFrame());
    await flush();
    expect(seen).toHaveLength(2);             // NOT swallowed

    dispatchCallFrame(offerFrame());          // now latched
    await flush();
    expect(seen).toHaveLength(2);
  });

  it('a truthy-but-not-true return does not latch', () => {
    // `seen.push(d)` returns a number. Latching on truthiness rather than
    // `=== true` would make every array-push test double silently latch.
    const src = readFileSync(
      join(process.cwd(), 'src', 'modules', 'messenger', 'webrtc', 'callDispatcher.ts'), 'utf8',
    );
    expect(src).toContain('=== true) {reassertedCallIds.add(callId);}');
  });
});
