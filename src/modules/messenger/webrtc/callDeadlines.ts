/**
 * WI-2.3 — every call-lifecycle deadline, in one place.
 *
 * WHY: these eleven numbers are a system, not eleven independent knobs, and
 * they were scattered across six files with no single place to see the
 * relationships. The ANSWER-STALL post-mortem is exactly that failure: the
 * signalling layer retried `call.answer` for 40 s while the connecting
 * watchdog killed the call at 20 s, so answering from a notification on a cold
 * socket died every time. Two correct numbers, in two files, that nobody had
 * ever read side by side. Bug ids: the ANSWER-STALL entry (sqa.md, logged as
 * B-130 — note the historical collision with MESSAGE_LOOP's own B-130) plus
 * B-62, B-108, B-110/F-1, PUSH-B5 and CALL-N15.
 *
 * This module is the SOURCE OF TRUTH. It does not replace the existing
 * exports: each owning module now imports its value from here and re-exports
 * the name it already published, so no consumer changed and no pin moved. The
 * point is drift prevention, not churn — `callDeadlines.test.ts` asserts the
 * ORDERING relationships that the scattered numbers could silently break.
 *
 * Tier A: zero imports, pure constants, node-loadable by the messenger-crypto
 * project. Do not add it to `runtime/index.ts`. It lives in `webrtc/` (with
 * the other pure call siblings — `callRingState.ts`, `pipLayout.ts`) rather
 * than `runtime/`, per the spec's WI-2.3 naming.
 *
 * BEFORE CHANGING A NUMBER HERE, read the relationship it participates in
 * below. Several are product invariants, not tunables.
 */

// ── Ring window ─────────────────────────────────────────────────────
/**
 * How long a call rings before it is a missed call. 45 s.
 *
 * PRODUCT INVARIANT, not a tunable. The same 45 s is the notifee card's
 * `timeoutAfter`, the native ringtone module's self-expiry, the server's
 * pending-offer TTL, and the accept-intent TTL below. PUSH-B5 pins "ring stops
 * at 45 s and a missed-call notification posts".
 */
export const RING_TIMEOUT_MS = 45_000;

/**
 * How long a queued accept intent stays answerable. MUST equal the ring
 * window: past it the caller has already given up, and answering fires
 * `call.answer` at a peer that is gone (B-110's ghost auto-answer — a call
 * that connected ~35 s after its offer with zero user action).
 */
export const ACCEPT_INTENT_TTL_MS = RING_TIMEOUT_MS;

// ── Setup / answer delivery ─────────────────────────────────────────
/**
 * How long the signalling layer keeps retrying a call-setup frame across a WS
 * reconnect. 40 s.
 */
export const CALL_SETUP_SEND_BUDGET_MS = 40_000;

/**
 * The watchdog budget that covers the answer-DELIVERY window. 50 s.
 *
 * MUST exceed `CALL_SETUP_SEND_BUDGET_MS`, or the watchdog kills a call whose
 * answer is still being legitimately retried — the ANSWER-STALL bug. Applies
 * ONLY while delivery is pending; NA-05 re-arms the short clock below the
 * moment the frame reaches the socket.
 */
export const ANSWER_DELIVERY_WATCHDOG_MS = 50_000;

/**
 * The post-delivery 'connecting' watchdog. 20 s. Armed by the accepted
 * transition into `connecting` (B-62), which is why a wedged answer reaches a
 * terminal state at all.
 *
 * MUST stay short. Widening this trades the ANSWER-STALL bug for calls that
 * hang: a genuinely stuck ICE negotiation would go uncaught for however long
 * this is. The ceiling is pinned, not just the ordering.
 */
export const CONNECTING_WATCHDOG_MS = 20_000;

/**
 * Hard ceiling on TURN-credential acquisition, after which the call boots
 * STUN-only. 6 s. B-110/F-1: the fetch had no ceiling, so after a background
 * window it rode a dead socket into a 15 s HTTP timeout + refresh + retry
 * (~35 s observed), `iceServers` stayed null, and the queued accept then fired
 * into a dead offer. Call boot never waits on TURN.
 */
export const TURN_FETCH_CEILING_MS = 6_000;

// ── Mid-call recovery ───────────────────────────────────────────────
/**
 * Total wall-clock budget for mid-call ICE-restart recovery. 30 s.
 * Budget expiry is the ONLY terminal authority during reconnect (B-108) — a
 * repeated ICE failure while already reconnecting must not extend it.
 *
 * WI-3.1 added ONE extension, on a different trigger: an SFU rejoin that is
 * actively rebuilding the room defers the expiry by one window, because that
 * rebuild IS the recovery and failing underneath it is the G6 stomp. A
 * repeated ICE failure still does not extend anything.
 */
export const RECONNECT_BUDGET_MS = 30_000;

/** How often the ICE-restart reoffer is re-fired while reconnecting. 4 s. */
export const RESTART_RETRY_MS = 4_000;

/**
 * WI-5.6 (transport G2/G3) — how long a buffered outbound trickle-ICE
 * candidate may wait for the socket to reopen before it is dropped. 5 s.
 *
 * Trickle ICE was fire-and-forget: every candidate produced during a
 * disconnected/reopening socket was silently lost (the transport's send()
 * throws before socket.io could ever buffer), and there is no server-side
 * replay lane — a 1–3 s WS blip during setup stranded the handshake.
 * MUST stay well under CALL_SETUP_SEND_BUDGET_MS: the candidates only
 * matter while their offer/answer is still being applied, and a socket
 * that has been down longer than this window is the ICE-restart path's
 * problem, not the trickle buffer's.
 */
export const ICE_WAIT_OPEN_MS = 5_000;

/**
 * Round 1 P2 (WI-5.5) — hard ceiling on one offer's identity verification.
 * The verify is now the head of the per-callId inbound chain, so a verifier
 * that never settles would wedge EVERY later frame for that callId (the old
 * fire-and-forget lost only the offer). XEd25519 verification is CPU-bound
 * milliseconds; 10 s is pure paranoia margin. On timeout the offer is
 * DROPPED (fail closed — never present unverified) and the chain proceeds.
 * MUST stay under DISPATCH_FRAME_TTL_MS so chained frames cannot outlive
 * their queue window waiting on it.
 */
export const OFFER_VERIFY_DEADLINE_MS = 10_000;

// ── Dispatch / launch / registry ────────────────────────────────────
/**
 * How long the dispatcher holds a frame that arrived before its signalling
 * registered. 30 s. Must comfortably exceed a cold boot's
 * runtime-up-to-registerSignalling window, and stay under the ring window so a
 * frame cannot outlive the call it belongs to.
 */
export const DISPATCH_FRAME_TTL_MS = 30_000;

/** Double-tap latch release for an outgoing 1:1 launch (CALL-17). 10 s. */
export const ONE_TO_ONE_LAUNCH_WATCHDOG_MS = 10_000;

/**
 * Worst-case wall-clock ceiling for ONE group-call `rejoinRoom`. 90 s.
 *
 * WI-3.3. Two separate guards need the same number and used to disagree:
 * the rejoin hub's stuck-claim takeover (`beginGroupCallRejoin`) and the
 * attempt-lifecycle's in-flight expiry. Both exist because a rejoin can ride
 * an ack that NEVER settles — the ack's reject timer is a `setTimeout`, frozen
 * while the screen is locked — so neither may latch on a boolean alone.
 *
 * The hub's old 30 s was routinely exceeded by a real 4-peer rejoin, which
 * meant a second `onReconnect` took over a rejoin that was still working. That
 * is now survivable (the attempt generation makes the loser a no-op) but it is
 * still waste: the healthy in-flight rejoin is abandoned and restarted.
 *
 * This number is deliberately PESSIMISTIC, because being wrong here is
 * expensive: a takeover abandons a rejoin that was working and starts over.
 * A realistic 4-peer rebuild is a TURN fetch (TURN_FETCH_CEILING_MS, 6 s), two
 * produce round-trips and ~8 consume round-trips over a socket that has just
 * reconnected — call it 15 s. 90 s is that with a large margin, and still far
 * under the SFU's own zombie-room grace, so a takeover happens long before the
 * server has forgotten the participant.
 *
 * Do NOT read 90 s as "a rebuild may take 90 s" — see
 * GROUP_REBUILD_MARK_CEILING_MS, which is sized for the rebuild itself and is
 * deliberately much shorter.
 */
export const GROUP_REJOIN_CEILING_MS = 90_000;

/**
 * How long the "a rejoin is rebuilding this room" mark is believed. 30 s.
 *
 * Review round 1 split this from GROUP_REJOIN_CEILING_MS: one constant was
 * serving two guards that want OPPOSITE things.
 *
 *   • the hub's stuck-claim takeover wants a LONG window — abandoning a
 *     healthy 4-peer rejoin and restarting it is pure waste (that is why it
 *     went 30 s -> 90 s);
 *   • the rebuild mark wants a SHORT one — while it is held, the 4 s producer
 *     reconcile, the resume reconcile and the early-producer buffer ALL stand
 *     down, so a wedged rejoin blinds the only backstop that heals a missed
 *     tile. At 90 s a peer who turned their camera on during a rejoin whose
 *     ack never settled would have no tile for a minute and a half; the
 *     backstop exists to fix that in 4 s.
 *
 * Sized for the rebuild ITSELF (~15 s realistic, see above), not for the
 * takeover's pessimistic margin. The asymmetry is deliberate: being wrong here
 * only resumes an idempotent backstop against a rebuild that is nearly done,
 * whereas being wrong about the takeover throws away healthy work.
 *
 * It must also stay <= RECONNECT_BUDGET_MS. That is what bounds
 * `onBudgetExpiry`: a wedged rebuild can defer the budget by at most one
 * window, because the next expiry is a full budget later and the mark is
 * certain to have expired by then.
 */
export const GROUP_REBUILD_MARK_CEILING_MS = 30_000;

/**
 * How long a just-ended callId is remembered. 120 s.
 *
 * MUST exceed the ring window: CALL-N15's ghost-redial guard and FIX-14's
 * stale-ring sweep both read this, and a restore navigation carrying an ended
 * callId can arrive any time inside the caller's ring window.
 */
export const RECENTLY_ENDED_WINDOW_MS = 120_000;

// ── Incoming payload / cold-launch routing (WI-4.8) ─────────────────
/**
 * How long a killed/cold Answer path polls for the navigator before
 * abandoning the route. 20 s (P1-BR-2: cold-launch nav can take 10–25 s).
 *
 * Was FOUR separate inline `20000` literals in fcmBootstrap — the Telecom
 * answer, the notifee answer, the msg-wake body tap and the missed-call tap
 * each owned a copy, which is the WI-2.3 drift shape verbatim.
 */
export const NAV_READY_WAIT_MS = 20_000;

/**
 * How long an un-answered incoming-call payload survives. 90 s.
 *
 * MUST exceed RING_TIMEOUT_MS + NAV_READY_WAIT_MS: a ring answered at its
 * very last second, on a cold launch whose navigator takes the full wait,
 * hydrates its route (SDP / deviceId / conversationId) from this cache at
 * t≈65 s. The old private 60 s literal expired underneath exactly that
 * answer and starved it into the B-102 A1 stall.
 *
 * The TTL applies to a call nobody answered. The LIVE call's entry is exempt
 * (incomingCallCache's gc probes the registries) — `onEnd`'s branch order
 * depends on "an answered call keeps its payload for the whole call", which
 * a wall-clock TTL cannot honour.
 */
export const INCOMING_PAYLOAD_TTL_MS = 90_000;

/**
 * How long a consumed callId's tombstone is believed. 120 s.
 *
 * MUST exceed INCOMING_PAYLOAD_TTL_MS — the tombstone's whole job is to
 * cover the window between "consumed" and "expired" so a delayed rewake for
 * the same callId cannot repopulate the slot with stale SDP. The margin is
 * the same +30 s the original 90/60 pair carried.
 *
 * Kept deliberately TIGHT (review round 1): group rings reuse the roomId as
 * the callId, and a declined/cancelled group ring's tombstone blocks the FCM
 * lane's re-ring of that room for this whole window ("they didn't pick up —
 * ring again"). That window pre-dates Phase 4 at 90 s; do not widen it
 * without checking that flow.
 */
export const INCOMING_TOMBSTONE_TTL_MS = 120_000;

/**
 * WI-4.9 — how long a displayed "Missed call" banner may age before the
 * boot/foreground sweep retires it. 24 h.
 *
 * Deliberately generous: the banner is the user's only record of the miss
 * until they open the app, so it must survive a night. But a banner from
 * days ago is stale clutter the user has demonstrably not acted on, and
 * every ACTED-ON path (opened the thread, called back, the peer called
 * again, tapped it) already dismisses it explicitly.
 */
export const MISSED_NOTIF_MAX_AGE_MS = 24 * 60 * 60 * 1000;
