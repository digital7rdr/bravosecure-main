/**
 * Singleton dispatcher that routes inbound call.* frames from the
 * messenger transport to the right surface.
 *
 *   • Active CallSignalling instances register themselves on mount
 *     so call.answer / call.ice / call.hangup frames are delivered
 *     to the running call (matched by callId).
 *   • An incoming `call.offer` with no matching signalling triggers
 *     the `incomingOffer` callback so the host (navigation root) can
 *     wake up the CallScreen with direction='incoming'.
 *
 * Kept tiny — anything more elaborate belongs in a real signalling
 * server, which is the messenger-service's job, not the client's.
 */
import type {
  ServerCallOffer, ServerCallAnswer, ServerCallIce, ServerCallHangup,
  ServerCallMediaState, ServerCallReOffer, ServerCallReAnswer, ServerFrame,
} from '@bravo/messenger-core';
import type {CallSignalling} from './signallingClient';

/**
 * WI-2.5(b) — `opts.reassert` marks the offer-REPLAY re-assert, which must
 * navigate ONLY. The full handler also raises Telecom and re-seeds the
 * incoming-call cache (MainNavigator's W4.2 block); re-running those for a
 * call the user is already answering hands `displayIncomingCall` a uuid that
 * already has a connection, orphaning it so the later `reportEnded` ends the
 * wrong one and strands a system call.
 */
type IncomingHandler = (offer: ServerCallOffer['data'], opts?: {reassert?: boolean}) => boolean | void;

/**
 * Audit S7 — caller-identity verifier. Wired by the navigation root
 * (which holds the live runtime + authority pubkey) so the dispatcher
 * can synchronously gate any inbound `call.offer` on the signed AAD
 * BEFORE waking the CallScreen. Returns a promise so the caller can
 * await verifySenderCert (XEd25519 over Curve25519 — async).
 *
 *   { ok: true }    — verification passed (or rolled-out fail-open).
 *   { ok: false }   — verification failed; offer is rejected and a
 *                     `call.hangup{reason:'failed'}` is fired back.
 *
 * When unset (e.g. before MainNavigator wires it on boot), inbound
 * offers fall through to the legacy unauthenticated path. This is
 * intentional during the rollout window so the app boots even if the
 * authority key env var is missing in a dev build; production builds
 * MUST install a verifier.
 */
type CallOfferVerifier = (offer: ServerCallOffer['data']) => Promise<{ok: true} | {ok: false; reason: string}>;

const active = new Map<string, CallSignalling>();
let onIncoming: IncomingHandler | null = null;
/**
 * WI-2.5(b) — callIds whose accept has already been re-asserted. The server
 * replays the offer on every reconnect drain, so without this the re-assert
 * navigates once per reconnect for the whole ring window. Cleared alongside
 * the rest of the dispatcher state on logout/teardown.
 */
const reassertedCallIds = new Set<string>();
let verifyOfferAuth: CallOfferVerifier | null = null;

// ── Pre-registration frame queue ───────────────────────────────────
// For INCOMING calls, the timeline is:
//   T0:        call.offer arrives → onIncoming fires → CallScreen mounts
//   T0+10ms:   call.ice candidates start arriving from the offerer
//   T0+~500ms: useCall finishes getUserMedia and calls registerSignalling()
// All ICE candidates that land between T0+10ms and T0+500ms have nowhere
// to go — there's no signalling registered for this callId yet. Without
// this queue they were silently dropped here, so the answerer's engine
// never received the offerer's remote candidates, never started ICE
// checks, and the call hung in 'have-remote-offer' until the user
// hung up. Coturn's view: offerer sends binding requests via TURN
// (peer rp > 0 on answerer's session), answerer never responds (sp=0).
//
// Fix: queue any non-offer frame for an unknown callId, drain into the
// signalling the moment it registers. TTL guards against leaks if the
// signalling never registers (e.g., user dismisses the incoming offer).
import {DISPATCH_FRAME_TTL_MS as FRAME_TTL_MS, OFFER_VERIFY_DEADLINE_MS} from './callDeadlines';
type QueuedFrame = {frame: ServerFrame; at: number};
const pending = new Map<string, QueuedFrame[]>();

function gcExpiredPending(): void {
  const cutoff = Date.now() - FRAME_TTL_MS;
  for (const [callId, frames] of pending) {
    const fresh = frames.filter(q => q.at >= cutoff);
    if (fresh.length === 0) {pending.delete(callId);}
    else if (fresh.length !== frames.length) {pending.set(callId, fresh);}
  }
}

// ── WI-5.5 (transport G4) — per-callId INBOUND chain ────────────────
// `dispatchCallFrame` stays synchronous by contract, but `call.offer` for an
// unregistered callId runs an ASYNC verifier and used to fire-and-forget it:
// an answer/ice/hangup that followed the offer ON THE WIRE could be fully
// processed before the offer finished verifying (a hangup tore ring state
// down, then the verified offer presented a ring for a dead call). Mirror of
// the outbound `callIdQueues` in signallingClient: the verify is the chain
// head, later frames for the SAME callId append behind it in wire order, and
// a callId with no chain takes the old synchronous path untouched — no
// cross-call serialization, no added latency on the healthy path.
const inboundChains = new Map<string, Promise<void>>();
// Round 1 HIGH (edge B / critic P1-3) — clearing the chain MAP does not cancel
// already-scheduled chain WORK: continuations constructed before a session
// clear would run after it and re-populate `pending` (or present a previous
// session's offer through the preserved handler). Every append captures the
// epoch; the clear bumps it; stale work is a no-op.
let dispatchEpoch = 0;

function appendToInboundChain(callId: string, work: () => void | Promise<void>): void {
  const epoch = dispatchEpoch;
  const prev = inboundChains.get(callId) ?? Promise.resolve();
  const next = prev.then(() => {
    if (epoch !== dispatchEpoch) {return;} // session cleared under us — dead work
    return work();
  }).catch(e => {
    console.warn('[bravo.callDispatcher] chained frame failed:', (e as Error).message);
  });
  inboundChains.set(callId, next);
  void next.then(() => {
    if (inboundChains.get(callId) === next) {inboundChains.delete(callId);}
  });
}

/** Chain behind a pending verify for this callId, else run synchronously. */
function inWireOrder(callId: string, work: () => void): void {
  if (inboundChains.has(callId)) {
    appendToInboundChain(callId, work);
  } else {
    work();
  }
}

export function registerSignalling(callId: string, sig: CallSignalling): () => void {
  // Refuse silent overwrite. If a prior CallSignalling was registered
  // for this callId (legitimate cause: a fast remount of CallScreen
  // before the old hook's cleanup ran, or a defensive re-register after
  // accept) we'd otherwise leave two CallSignalling instances both
  // listening to the SAME frames — both their controllers fight for
  // the same call and the call enters a permanently confused state.
  // Warn loudly so this shows up in production logs, then run any
  // teardown the previous one exposes (none today, but the path is
  // there for the future).
  const prev = active.get(callId);
  if (prev && prev !== sig) {
    console.warn(`[bravo.callDispatcher] registerSignalling overwriting existing entry callId=${callId.slice(0, 8)} — possible double-mount of CallScreen`);
    const prevWithTeardown = prev as unknown as {teardown?: () => void};
    if (typeof prevWithTeardown.teardown === 'function') {
      try { prevWithTeardown.teardown(); } catch { /* ignore */ }
    }
  }
  active.set(callId, sig);
  // Drain any frames that arrived during the setup window.
  const queued = pending.get(callId);
  if (queued && queued.length > 0) {
    pending.delete(callId);
    for (const q of queued) {
      try { sig.ingest(q.frame); } catch { /* one bad frame must not block the rest */ }
    }
  }
  return () => { if (active.get(callId) === sig) {active.delete(callId);} };
}

export function setIncomingCallHandler(h: IncomingHandler | null): void {
  onIncoming = h;
}

/**
 * Audit S7 — install the caller-identity verifier. MainNavigator calls
 * this once the messenger runtime is built (so the verifier has access
 * to the live identity store + cert authority pubkey).
 */
export function setCallOfferVerifier(v: CallOfferVerifier | null): void {
  verifyOfferAuth = v;
}

/** SYNC-5 — notify only for misses newer than this; older ones are log-only. */
const MISSED_CALL_NOTIF_MAX_AGE_MS = 6 * 60 * 60 * 1000;

// Why: B-331 — with no handler registered (headless drain VM, or the
// pre-MainNavigator boot window) a live-delivered offer used to be DROPPED,
// and the gateway's parked-offer replay only fires on a NEW socket connect —
// so the notification Accept starved forever at CallScreen's incomingSdpKey
// gate. Cache it instead: resolveIncomingCallRoute already hydrates the
// Accept navigation from this cache, and setIncomingCallPayload merges with
// the voip-wake's entry (NA-01) and refuses tombstoned callIds.
function cacheUnhandledOffer(d: ServerCallOffer['data']): void {
  try {
    const cache = require('../push/incomingCallCache') as typeof import('../push/incomingCallCache');
    const stored = cache.setIncomingCallPayload({
      callId:         d.callId,
      callerName:     '', // the wake/notification lane owns the display name
      kind:           d.kind === 'video' ? 'video' : 'voice',
      fromUserId:     d.from.userId,
      remoteDeviceId: d.from.deviceId,
      incomingSdp:    d.sdp,
    });
    // Why: warn-level so it SURVIVES release builds (transform-remove-console
    // strips log, keeps warn) — this line is the device-verify marker for B-331.
    console.warn(`[CALLDIAG] call.offer cached (no handler, B-331) cid=${d.callId.slice(0, 8)} stored=${stored}`);
  } catch { /* cache unavailable (tests) — degrades to the old drop */ }
}

/**
 * CALL-16 — idempotent "Missed call" chat-bubble append, shared by the
 * `call.missed` replay path and the no-controller `call.hangup` path
 * (caller cancelled while we were still ringing via notifee/CallKit).
 * The stable `missed-<callId>` id makes appendMessage's dedup
 * idempotent across a reconnect replay. Returns the conversation id on
 * success so callers can look up the convo (e.g. for the notif name),
 * or null when the store isn't available (tests / early boot).
 */
function appendMissedCallBubble(d: {
  callId: string;
  from:   {userId: string; deviceId: number};
  kind?:  'voice' | 'video';
  at?:    number;
}): string | null {
  try {
    const store = require('../store/messengerStore') as typeof import('../store/messengerStore');
    const state = store.useMessengerStore.getState();
    const convoId = store.resolveDirectConversationIdFromState(state, d.from.userId);
    // M11 — a missed call from a cold contact used to manufacture its chat row
    // as a SIDE EFFECT of appendMessage's shadow-create. Mint it explicitly so
    // the intent is auditable and the row can never depend on which branch of
    // the append happened to fire. Same placeholder shape the store would have
    // produced, so the name still backfills (the `Bravo · ` prefix is what
    // useRegisteredNames looks for) and the visible result is unchanged.
    // Its own try/catch on purpose: the BUBBLE is the thing the user sees, and
    // it must never be lost because the row upsert failed. Worst case we fall
    // back to the store's shadow-create, i.e. exactly the old behaviour.
    try {
      if (convoId.startsWith('direct:') && !state.conversations[convoId]) {
        state.upsertConversation(store.directPlaceholderConversation(
          convoId, d.from.userId, d.from, new Date(d.at ?? Date.now()).toISOString(),
        ));
      }
    } catch { /* best-effort — the append below still lands the bubble */ }
    state.appendMessage(convoId, {
      id:              `missed-${d.callId}`,
      conversation_id: convoId,
      sender_id:       d.from.userId,
      type:            'call',
      content:         '',
      status:          'delivered',
      is_encrypted:    true,
      created_at:      new Date(d.at ?? Date.now()).toISOString(),
      peer:            d.from,
      call_meta:       {kind: d.kind === 'video' ? 'video' : 'voice', direction: 'incoming', outcome: 'missed', duration: 0},
    });
    return convoId;
  } catch {
    return null;
  }
}

/**
 * B-64 — hard-end a live registry session the server has declared dead.
 * Covers the 2026-07-10 zombie: the killed-app answer path builds a
 * controller + starts the FGS, the answer never registers server-side,
 * and when the caller gives up the resulting `call.missed` / unmatched
 * `call.hangup` used to leave the wedged session (and its unclearable
 * ongoing-call notification) running forever. No-op when the callIds
 * don't match or the session is already terminal.
 */
function endZombieSession(callId: string, via: string): void {
  try {
    const reg = require('../runtime/callRegistry') as typeof import('../runtime/callRegistry');
    const live = reg.getActiveCall();
    if (live && live.callId === callId && live.state !== 'ended' && live.state !== 'failed') {
      console.warn(`[bravo.callDispatcher] ${via} for a live call cid=${callId.slice(0, 8)} state=${live.state} — ending zombie session`);
      // WI-1.1 — the weak (callId) ref, and legitimately so: a server frame
      // carries no generation. The id equality checked just above is what
      // keeps it from ending an unrelated call.
      reg.endActiveCall(callId, 'failed', 'remote');
    }
  } catch { /* registry unavailable (tests) — best effort */ }
}

/**
 * Called from the runtime's WS frame handler. Anything that isn't a
 * call.* frame is ignored; everything else is routed to the matching
 * registered signalling, or — for offers without a match — punted to
 * the global incoming handler.
 */
/**
 * WI-2.5(b) — re-assert an explicit accept when a replayed offer lands on a
 * call whose signalling is ALREADY registered.
 *
 * Deliberately additive: it re-enters `onIncoming`, which is where B-102 A1's
 * `autoAccept` re-assert already lives, rather than growing a second mechanism
 * that could drift from it. RN6's `navigate` replaces params on the mounted
 * CallScreen, which is exactly what A1 is built for.
 *
 * SYNCHRONOUS by contract — verification is fire-and-forget. An `await` in the
 * `call.offer` switch case would reorder that case against every other frame
 * class (MESSAGE_LOOP trap 12).
 *
 * Every guard has to hold, and the verify one is a security boundary: the
 * registered-`sig` branch runs BEFORE the S7 verifier, so a forged replay
 * reaches it. Acting on an unverified offer would hand an attacker an accept
 * trigger on a call they do not own. B-331 fixed the no-handler path by
 * putting its write inside the verified `.then`; this is the same rule on the
 * handler path.
 */
function maybeReassertAccept(f: ServerCallOffer): void {
  const handler = onIncoming;
  // Headless: no UI, no handler, nothing to re-assert. B-331's lesson is that
  // a live socket can be owned by a VM where MainNavigator never mounts.
  if (!handler) {return;}
  const callId = f.data.callId;

  // The server replays the offer on EVERY reconnect drain, so without a latch
  // this re-navigates once per reconnect for the life of the ring window.
  if (reassertedCallIds.has(callId)) {return;}

  /**
   * Re-evaluated INSIDE the verified `.then` as well as here.
   *
   * Checking synchronously and acting asynchronously is its own race: the S7
   * verify is an XEd25519 chain, and the ring can expire (or the user can
   * decline) inside it. Acting on guards that were true a moment ago would
   * navigate + auto-accept a call the caller has already abandoned — the
   * B-110 ghost-auto-answer shape. The early copy is only a cheap bail.
   */
  const guardsHold = (): boolean => {
    let accepted = false;
    try {
      const fb = require('../push/fcmBootstrap') as typeof import('../push/fcmBootstrap');
      accepted = fb.wasCallExplicitlyAccepted(callId);
    } catch { return false; }   // push layer not booted — nothing was accepted
    if (!accepted) {return false;}
    // Still OUR call and still ringing. Past 'ringing' the accept already
    // landed and re-navigating would fight the live screen.
    try {
      const reg = require('../runtime/callRegistry') as typeof import('../runtime/callRegistry');
      const live = reg.getActiveCall();
      if (!live || live.callId !== callId || live.state !== 'ringing') {return false;}
    } catch { return false; }
    // Never resurrect a tombstoned call (declined, or the peer hung up).
    try {
      const cache = require('../push/incomingCallCache') as typeof import('../push/incomingCallCache');
      if (cache.isIncomingCallDead(callId)) {return false;}
    } catch { /* cache unavailable — the guards above still apply */ }
    return true;
  };

  if (!guardsHold()) {return;}

  const fire = (): void => {
    if (!guardsHold()) {return;}          // re-checked post-verify — see above
    console.warn(`[CALLSM] offer-replay accept re-assert cid=${callId.slice(0, 8)}`);
    // `reassert` keeps this to a NAVIGATE. The full handler also raises Telecom
    // and re-seeds the incoming-call cache; doing that for a call already being
    // answered orphans the live system connection.
    // Latch only on a handler that actually navigated. Spending it up-front
    // meant any early return inside the handler burned the callId forever, so
    // the reconnect replay — the very recovery this exists to consume — was
    // swallowed and the call rang out. (The handler discards its own navigate
    // boolean at the B-460 call site; that is why it has to tell us.)
    try {
      if (handler(f.data, {reassert: true}) === true) {reassertedCallIds.add(callId);}
    } catch (e) {
      console.warn('[bravo.callDispatcher] offer-replay re-assert threw:', (e as Error).message);
    }
  };

  const verifier = verifyOfferAuth;
  if (!verifier) { fire(); return; }   // legacy rollout branch, as elsewhere
  void verifier(f.data)
    .then(result => { if (result.ok) {fire();} })
    .catch(() => { /* verifier threw — drop, same as the no-handler path */ });
}

export function dispatchCallFrame(frame: ServerFrame): boolean {
  // Audit SFU-12 (2026-07-02): `call.missed` isn't in the typed ServerFrame
  // union (it's a dynamic server event), so handle it BEFORE the typed switch.
  // A 1:1 offer expired while we were offline (the caller gave up); there's no
  // live call to route, so append a "Missed call" record to the caller's
  // thread instead of losing it silently. Stable id makes appendMessage's
  // dedup idempotent across a reconnect replay.
  if ((frame as {event: string}).event === 'call.missed') {
    const f = frame as unknown as {data: {callId: string; from: {userId: string; deviceId: number}; kind?: 'voice' | 'video'; at?: number}};
    // B-64 — the server just declared this call dead. If a live-but-wedged
    // session still exists for it (2026-07-10 zombie: answer lost, controller
    // stuck in 'connecting', FGS notification unclearable), hard-end it so
    // the FGS notif, InCallManager, and registry all clear.
    // WI-5.5 — behind any pending verify for this callId: a missed-frame
    // teardown must not run while the offer it retires is still verifying.

    inWireOrder(f.data.callId, () => {
      endZombieSession(f.data.callId, 'call.missed');
      const convoId = appendMissedCallBubble(f.data);
      // SYNC-5 — the server marker now survives days, so a reconnect after a long
      // offline stretch can replay stale markers. The Calls-log row is always
      // written; only recent misses get a notification, otherwise waking from a
      // weekend offline spams one banner per old call.
      const missedAgeMs = Date.now() - (f.data.at ?? 0);
      if (convoId && missedAgeMs < MISSED_CALL_NOTIF_MAX_AGE_MS) {
        // Post a persistent "Missed call" notification so a backgrounded user
        // sees it after the ring auto-dismisses (WhatsApp/Signal parity).
        try {
          const store = require('../store/messengerStore') as typeof import('../store/messengerStore');
          const convo = store.useMessengerStore.getState().conversations[convoId];
          const cn = require('../push/callNotification') as typeof import('../push/callNotification');
          void cn.showMissedCallNotif({
            callId: f.data.callId,
            callerName: convo?.name,
            kind: f.data.kind === 'video' ? 'video' : 'voice',
            // B-229 — carry the caller so the missed-call tap deep-links the 1:1
            // thread (P1-7 call-back affordance) instead of degrading to CallsLog.
            fromUserId: f.data.from.userId,
            // WI-4.9 — carry the thread too, so opening it retires this banner.
            conversationId: convoId,
          });
        } catch { /* notifee unavailable — best effort */ }
      }
    });
    return true;
  }
  switch (frame.event) {
    case 'call.offer': {
      const f = frame as ServerCallOffer;
      const sig = active.get(f.data.callId);
      if (sig) {
        sig.ingest(f);
        // WI-2.5(b) — the ingest above is where an offer REPLAY for a
        // registered call dies: `CallController` never subscribes `onOffer`.
        // That also kills B-102 A1's `autoAccept` re-assert, because A1 lives
        // inside `onIncoming` and a registered call never reaches it — so a
        // user who answered from the notification gets the ring screen back on
        // a call they already accepted. Re-assert, additively and verified.
        maybeReassertAccept(f);
        return true;
      }
      // Audit S7 — caller-identity verification BEFORE waking the host.
      // Verifier is async (XEd25519 verify chain); we fire-and-forget
      // here because dispatchCallFrame must stay sync to match the
      // transport's frame loop. On verification failure we log + drop;
      // the caller times out on their watchdog and the user never
      // sees a forged incoming call surface.
      if (verifyOfferAuth) {
        const verifier = verifyOfferAuth;
        const handler  = onIncoming;
        const callIdLog = f.data.callId.slice(0, 8);
        const fromLog   = `${f.data.from.userId.slice(0, 8)}/${f.data.from.deviceId}`;
        // WI-5.5 — the verify is the chain HEAD for this callId: frames that
        // follow the offer on the wire append behind it instead of racing it.
        // Edge B — captured at dispatch time: the pre-work epoch check in
        // appendToInboundChain covers work that has not STARTED, but the
        // verify is async and can be IN FLIGHT when the session clears; the
        // post-await re-check below is what stops a previous session's offer
        // from presenting through the preserved handler.
        const bornEpoch = dispatchEpoch;
        appendToInboundChain(f.data.callId, async () => {
          try {
            // Round 1 P2 — the verify is the chain head now, so it gets a
            // hard deadline: a hung verifier must not wedge every later
            // frame for this callId. Timeout = drop (fail closed).
            const result = await Promise.race([
              verifier(f.data),
              new Promise<{ok: false; reason: string}>(resolve => {
                const t = setTimeout(() => resolve({ok: false, reason: 'verify-timeout'}), OFFER_VERIFY_DEADLINE_MS);
                (t as unknown as {unref?: () => void}).unref?.();
              }),
            ]);
            if (bornEpoch !== dispatchEpoch) {return;} // session cleared during the verify
            if (!result.ok) {
              console.warn(`[bravo.callDispatcher] call.offer REJECTED cid=${callIdLog} from=${fromLog} reason=${result.reason}`);
              return;
            }
            // Round 2 F-1 — a sig that registered DURING the verify takes
            // delivery directly, mirroring the five sibling classes'
            // process-time lookup. Running the FULL handler here would raise
            // reportIncomingCall for a uuid whose connection is already live
            // (the exact orphaning the reassert flag exists to prevent); the
            // replay re-assert lane is the correct one for a registered call.
            const sigNow = active.get(f.data.callId);
            if (sigNow) {
              sigNow.ingest(f);
              maybeReassertAccept(f);
              return;
            }
            if (handler) {handler(f.data);} else {cacheUnhandledOffer(f.data);}
          } catch (err) {
            console.warn(`[bravo.callDispatcher] call.offer verifier threw cid=${callIdLog} — dropping:`, (err as Error).message);
          }
        });
        return true;
      }
      // No verifier installed — legacy fallback (rollout window).
      if (onIncoming) {onIncoming(f.data);} else {cacheUnhandledOffer(f.data);}
      return true;
    }
    case 'call.answer': {
      const f = frame as ServerCallAnswer;
      // WI-5.5 — the sig lookup happens at PROCESS time (behind any
      // pending verify for this callId), so a screen that registered
      // while the offer was verifying receives this frame directly.
      // Edge D — the TTL stamps WIRE arrival, not process time: a frame
      // chained behind a slow verify must not earn a fresh 30 s lifetime.
      const arrivedAt = Date.now();
      inWireOrder(f.data.callId, () => {
        const sig = active.get(f.data.callId);
        if (sig) { sig.ingest(f); return; }
        gcExpiredPending();
        const arr = pending.get(f.data.callId) ?? [];
        arr.push({frame: f, at: arrivedAt});
        pending.set(f.data.callId, arr);
      });
      return true;
    }
    case 'call.ice': {
      const f = frame as ServerCallIce;
      // WI-5.5 — the sig lookup happens at PROCESS time (behind any
      // pending verify for this callId), so a screen that registered
      // while the offer was verifying receives this frame directly.
      // Edge D — the TTL stamps WIRE arrival, not process time: a frame
      // chained behind a slow verify must not earn a fresh 30 s lifetime.
      const arrivedAt = Date.now();
      inWireOrder(f.data.callId, () => {
        const sig = active.get(f.data.callId);
        if (sig) { sig.ingest(f); return; }
        gcExpiredPending();
        const arr = pending.get(f.data.callId) ?? [];
        arr.push({frame: f, at: arrivedAt});
        pending.set(f.data.callId, arr);
      });
      return true;
    }
    case 'call.hangup': {
      const f = frame as ServerCallHangup;
      // WI-5.5 — the whole no-controller teardown chains behind a pending
      // verify for this callId: a hangup that followed the offer on the wire
      // must not tear ring surfaces down while the offer is still verifying
      // (the verified offer would then re-present a ring for a dead call).

      inWireOrder(f.data.callId, () => {
        const sig = active.get(f.data.callId);
        if (sig) { sig.ingest(f); return; }
        // No controller registered yet — the call is still RINGING via
        // notifee / CallKit (the offer woke them but the user hasn't
        // accepted, so useCall never mounted). The caller cancelled (or
        // another device picked up). Without dismissing here, the looping
        // full-screen notifee ring keeps firing until its TTL and tapping
        // Answer would mount a CallScreen for a peer who already left.
        // Tear down both surfaces + the cached payload.
        const cid = f.data.callId;
        try {
          const cn = require('../push/callNotification') as typeof import('../push/callNotification');
          void cn.dismissCallNotif(cid);
        } catch { /* notifee unavailable (tests / iOS) */ }
        try {
          const {reportEnded} = require('../push/callKitBridge') as typeof import('../push/callKitBridge');
          reportEnded(cid, f.data.reason === 'failed' ? 'failed' : 'remoteEnded');
        } catch { /* bridge inactive */ }
        // B-64 — a controller can exist in the registry even when no signalling
        // is registered with the dispatcher (accept wedged mid-boot on the
        // killed-app answer path). The hangup would otherwise never reach it.
        endZombieSession(cid, 'call.hangup');
        // The caller cancelled while we were still ringing (no controller had
        // mounted) → a genuine missed call. If a ring payload was cached, post a
        // persistent "Missed call" notification. Read defensively and in its own
        // try so it can never interfere with the critical cache teardown below.
        try {
          const cache = require('../push/incomingCallCache') as typeof import('../push/incomingCallCache');
          const payload = typeof cache.getIncomingCallPayload === 'function'
            ? cache.getIncomingCallPayload(cid)
            : null;
          if (payload && f.data.reason !== 'declined') {
            const cn = require('../push/callNotification') as typeof import('../push/callNotification');
            void cn.showMissedCallNotif?.({
              callId: cid,
              callerName: payload.callerName,
              kind: payload.kind as import('../push/callNotification').CallNotifKind,
              // B-229 — both sources are in scope; prefer the ring-cached caller,
              // fall back to the hangup frame, so the tap deep-links the thread.
              fromUserId: payload.fromUserId ?? f.data.from?.userId,
              // WI-4.9 — carry the thread so opening it retires the banner.
              conversationId: payload.conversationId,
            });
            // CALL-16 — the notification alone left the chat thread with
            // no trace of the missed call (the bubble only landed on the
            // offline `call.missed` replay path). Same idempotent
            // missed-<callId> record, same gating as the notification.
            appendMissedCallBubble({
              callId: cid,
              from:   f.data.from,
              kind:   payload.kind === 'video' ? 'video' : 'voice',
            });
          }
        } catch { /* missed-call notif best-effort */ }
        try {
          const cache = require('../push/incomingCallCache') as typeof import('../push/incomingCallCache');
          cache.clearIncomingCallPayload(cid);
        } catch { /* cache unavailable */ }
        try {
          const {notifyCallEnded} = require('../push/fcmBootstrap') as typeof import('../push/fcmBootstrap');
          notifyCallEnded(cid);
        } catch { /* fcmBootstrap not loaded in tests */ }
        // Drop pending frames for this call — the call ended before any
        // controller registered, no point queueing.
        pending.delete(cid);
      });
      return true;
    }
    case 'call.media-state': {
      // BS-021 — peer-mute / peer-camera-off advisory. Route to the
      // active signalling for this callId; queue when no controller is
      // registered yet (same TTL window as ICE) so a media-state that
      // arrives during the answerer's getUserMedia setup window is
      // delivered once the hook calls registerSignalling. If no
      // controller ever registers it ages out — purely advisory, no
      // call invariants are tied to it.
      const f = frame as ServerCallMediaState;
      // WI-5.5 — behind any pending verify for this callId, wire order.
      // Edge D — the TTL stamps WIRE arrival, not process time: a frame
      // chained behind a slow verify must not earn a fresh 30 s lifetime.
      const arrivedAt = Date.now();
      inWireOrder(f.data.callId, () => {
        const sig = active.get(f.data.callId);
        if (sig) { sig.ingest(f); return; }
        gcExpiredPending();
        const arr = pending.get(f.data.callId) ?? [];
        arr.push({frame: f, at: arrivedAt});
        pending.set(f.data.callId, arr);
      });
      return true;
    }
    case 'call.reoffer': {
      // Mid-call SDP renegotiation — voice→video upgrade. The peer is
      // already in a live call so a registered signalling MUST exist
      // by the time this lands. If it somehow doesn't (e.g. CallScreen
      // is in the middle of a remount via the resume-from-registry
      // path), queue with the same TTL so the controller picks it up
      // when registerSignalling fires. We don't drop unmatched reoffers
      // because the initiator is sitting on a half-applied addTrack
      // waiting for our reanswer — silently discarding here would leave
      // them hung until their watchdog rolls back ~8 s later.
      const f = frame as ServerCallReOffer;
      // WI-5.5 — behind any pending verify for this callId, wire order.
      // Edge D — the TTL stamps WIRE arrival, not process time: a frame
      // chained behind a slow verify must not earn a fresh 30 s lifetime.
      const arrivedAt = Date.now();
      inWireOrder(f.data.callId, () => {
        const sig = active.get(f.data.callId);
        if (sig) { sig.ingest(f); return; }
        gcExpiredPending();
        const arr = pending.get(f.data.callId) ?? [];
        arr.push({frame: f, at: arrivedAt});
        pending.set(f.data.callId, arr);
      });
      return true;
    }
    case 'call.reanswer': {
      // Mid-call renegotiation reply. Same queue-on-miss rationale as
      // reoffer above — though in practice the initiator's signalling
      // is the one that's been live for the duration of the call so
      // an unmatched reanswer is a real anomaly worth surfacing.
      const f = frame as ServerCallReAnswer;
      // WI-5.5 — behind any pending verify for this callId, wire order.
      // Edge D — the TTL stamps WIRE arrival, not process time: a frame
      // chained behind a slow verify must not earn a fresh 30 s lifetime.
      const arrivedAt = Date.now();
      inWireOrder(f.data.callId, () => {
        const sig = active.get(f.data.callId);
        if (sig) { sig.ingest(f); return; }
        gcExpiredPending();
        const arr = pending.get(f.data.callId) ?? [];
        arr.push({frame: f, at: arrivedAt});
        pending.set(f.data.callId, arr);
      });
      return true;
    }
    default:
      return false;
  }
}

/**
 * Round 2 fix: tear down ALL dispatcher state. Wired into authStore.signOut
 * so a logout doesn't leak the previous user's active call signalling
 * map, the queued-frame `pending` map (TTL'd 30 s but the entries are
 * still reachable), or the global `onIncoming` handler (which would
 * fire incoming-call banners on the next user's home screen if a stray
 * offer frame arrived during the logout transition).
 */
export function clearAllCallDispatchState(): void {
  clearCallDispatchTransients();
  onIncoming = null;
  // Audit S7 — also drop the verifier so a logout-then-relogin doesn't
  // leave the previous user's verifier wired up.
  verifyOfferAuth = null;
}

/**
 * WI-5.7 (transport G6) — the RUNTIME-LIFECYCLE half of the teardown, wired
 * into `disposeLiveRuntime` so EVERY disposal path (restore rebuild, backup
 * setup rebuild, account switch via the build-top dispose — not just signOut)
 * drops the previous session's queued frames and registered signalling. The
 * epoch fence stops NEW frames after a switch, but frames already queued
 * pre-registration would otherwise drain into a signalling registered by the
 * NEXT session for a reused callId.
 *
 * Deliberately PRESERVES `onIncoming` and `verifyOfferAuth`: both are
 * APP-LEVEL registrations owned by MainNavigator effects (installed on
 * `[user?.id]`, NOT re-installed after a mid-session runtime rebuild).
 * Clearing the handler here would leave incoming 1:1 calls dead after every
 * restore; clearing the verifier would drop offers to the legacy
 * UNVERIFIED fallback in the dispose→rebuild gap — a security downgrade.
 * signOut still clears both via `clearAllCallDispatchState`.
 */
export function clearCallDispatchTransients(): void {
  // Round 1 MED (edge C / critic P2-10) — a MINIMIZED call's signalling must
  // SURVIVE a mid-session rebuild: useCall's cleanup deliberately skips the
  // unregister while minimized (that is how the call keeps receiving frames
  // with no hook mounted), and nothing re-registers it afterwards — clearing
  // it deafened the live call to hangup/ice/reoffer and re-opened the B-486
  // restore-busy shape (a replayed offer took the !sig branch WITHOUT
  // reassert). Same property as the preserved onIncoming/verifier: owned by
  // a lifecycle that does not re-install on rebuild. The signOut lane ends
  // active calls BEFORE clearing, so nothing user-scoped leaks through this.
  const keep = new Map<string, CallSignalling>();
  const keepPending = new Map<string, QueuedFrame[]>();
  try {
    const reg = require('../runtime/callRegistry') as typeof import('../runtime/callRegistry');
    const live = reg.getActiveCall();
    if (live) {
      const sig = active.get(live.callId);
      if (sig) {keep.set(live.callId, sig);}
      const q = pending.get(live.callId);
      if (q) {keepPending.set(live.callId, q);}
    }
  } catch { /* registry unavailable — clear everything */ }
  active.clear();
  pending.clear();
  for (const [k, v] of keep) {active.set(k, v);}
  for (const [k, v] of keepPending) {pending.set(k, v);}
  // WI-5.5 — pending verify chains are session-scoped; the epoch bump also
  // kills already-scheduled chain WORK (edge B), which the map clear alone
  // could not reach.
  inboundChains.clear();
  dispatchEpoch += 1;
  // WI-2.5(b) — an account switch must not carry the previous user's
  // re-assert latch, or the first replay for a re-used callId is swallowed.
  reassertedCallIds.clear();
}
