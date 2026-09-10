/**
 * B-331 — a `call.offer` arriving while NO incoming-call handler is
 * registered must be CACHED, never dropped.
 *
 * The killed-app headless drain (B-324/B-325) connects the WS from a VM
 * where MainNavigator never mounts, so `onIncoming` (and the S7 verifier)
 * are null there. The gateway has already delivered the offer live to that
 * socket — its Redis parked-offer replay only fires on a NEW socket
 * connect, so a dropped offer is gone for good and the notification
 * Accept starves at CallScreen's `incomingSdpKey` gate ("Answering…"
 * forever). Caching into `incomingCallCache` lets the Accept navigation's
 * `resolveIncomingCallRoute` hydrate the SDP from the same process.
 *
 * Contract pinned here:
 *  1. verifier passes + no handler  → payload cached WITH the SDP
 *  2. no verifier + no handler (legacy rollout branch) → same
 *  3. handler registered → handler receives the offer; the dispatcher
 *     itself writes nothing (the handler owns caching, as before)
 *  4. verifier rejects → nothing cached (forged offers stay dead)
 *  5. tombstoned callId (declined / peer-hung-up) → set refused, stays null
 */
import {
  dispatchCallFrame,
  setIncomingCallHandler,
  setCallOfferVerifier,
} from '../webrtc/callDispatcher';
import * as cache from '../push/incomingCallCache';

const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0));

function offerFrame(callId: string, sdp = 'v=0 offer-sdp'): never {
  return {
    event: 'call.offer',
    data: {
      callId,
      from: {userId: 'caller-uid', deviceId: 3},
      sdp,
      kind: 'video',
      auth: {certB64: 'x', sigB64: 'y', signedAtMs: 1},
    },
  } as never;
}

beforeEach(() => {
  setIncomingCallHandler(null);
  setCallOfferVerifier(null);
  cache._resetIncomingCallCacheForTests();
});

afterEach(() => {
  setIncomingCallHandler(null);
  setCallOfferVerifier(null);
});

describe('B-331 — call.offer with no handler is cached, not dropped', () => {
  it('verified offer with NO handler lands in incomingCallCache with its SDP', async () => {
    setCallOfferVerifier(async () => ({ok: true}));
    expect(dispatchCallFrame(offerFrame('b331-verified'))).toBe(true);
    await flush();
    const p = cache.getIncomingCallPayload('b331-verified');
    expect(p).not.toBeNull();
    expect(p?.incomingSdp).toBe('v=0 offer-sdp');
    expect(p?.fromUserId).toBe('caller-uid');
    expect(p?.remoteDeviceId).toBe(3);
    expect(p?.kind).toBe('video');
  });

  it('legacy no-verifier branch with NO handler also caches (rollout parity)', async () => {
    expect(dispatchCallFrame(offerFrame('b331-legacy'))).toBe(true);
    await flush();
    const p = cache.getIncomingCallPayload('b331-legacy');
    expect(p).not.toBeNull();
    expect(p?.incomingSdp).toBe('v=0 offer-sdp');
  });

  it('cache write MERGES with a prior push-wake entry (NA-01: wake name kept, SDP added)', async () => {
    // The FCM voip-wake lane seeds the same callId first — no SDP, but a
    // resolved display name. The dispatcher's write must not clobber it.
    cache.setIncomingCallPayload({
      callId: 'b331-merge', callerName: 'Alice', kind: 'video', fromUserId: 'caller-uid',
    } as never);
    setCallOfferVerifier(async () => ({ok: true}));
    dispatchCallFrame(offerFrame('b331-merge'));
    await flush();
    const p = cache.getIncomingCallPayload('b331-merge');
    expect(p?.incomingSdp).toBe('v=0 offer-sdp');
    expect(p?.callerName).toBe('Alice');
  });

  it('with a handler registered, the handler gets the offer and the dispatcher caches nothing', async () => {
    const handler = jest.fn();
    setIncomingCallHandler(handler);
    setCallOfferVerifier(async () => ({ok: true}));
    dispatchCallFrame(offerFrame('b331-handled'));
    await flush();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({callId: 'b331-handled'});
    expect(cache.getIncomingCallPayload('b331-handled')).toBeNull();
  });

  it('a REJECTED offer is never cached (S7 stays fail-closed)', async () => {
    setCallOfferVerifier(async () => ({ok: false, reason: 'bad-cert'}));
    dispatchCallFrame(offerFrame('b331-forged'));
    await flush();
    expect(cache.getIncomingCallPayload('b331-forged')).toBeNull();
  });

  it('a tombstoned callId (declined earlier) is never repopulated', async () => {
    cache.clearIncomingCallPayload('b331-dead'); // tombstones the id
    setCallOfferVerifier(async () => ({ok: true}));
    dispatchCallFrame(offerFrame('b331-dead'));
    await flush();
    expect(cache.getIncomingCallPayload('b331-dead')).toBeNull();
  });
});
