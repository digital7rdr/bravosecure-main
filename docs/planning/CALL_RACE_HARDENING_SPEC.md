# Bravo Secure — WhatsApp-Level Calling: Race, State-Machine & Edge-Case Hardening

> **Build spec, 2026-08-16.** Written for the implementing session (Opus 5). Read this whole
> document before writing code. It is the behavioural/race companion to
> `docs/planning/CALL_UI_WHATSAPP_PARITY.md` (UI parity) and composes with `LOOP.md`,
> `CLAUDE.md` (messenger regression gate + security stop-conditions) and
> `docs/runbooks/MESSAGE_LOOP.md` (call→message seam). §12 lists the repo gotchas that have
> burned previous sessions.
>
> **This spec was produced from a six-lane architecture audit of the current `main`
> (060f5d40): 1:1 client controller, group/SFU client, server gateway+SFU, notification/
> lifecycle path, WS transport, and the complete call bug history in `sqa.md` + memory.
> Every file:line below was correct at audit time but WILL rot — re-grep the symbol before
> editing, never trust a stamped line.**

---

## 0. One-paragraph summary

Calling works, and it carries ~150 shipped race fixes — but it is **not one deterministic
system**. There is no transition table (only a terminal-absorbing guard), no
generation/stateVersion primitive anywhere (identity is `callId` alone), the two client call
registries accept **unkeyed** writes and teardowns (any stale async continuation can mutate or
destroy a _newer_ call), teardown is spread across **six** entry points (one of them
re-entrant), the server has **no answer arbitration** ("answered elsewhere" keeps other
devices ringing 45 s), the group WS-decline leaks ghost-ring artifacts, and the killed-app
ring path seeds nothing but a notification. The task is to install a small number of
**structural primitives** (identity-keyed registry ops, a per-call generation, a legal-
transition table, single-owner cleanup, server answer atomicity) and then close ~35 audited
gaps against them — WITHOUT regressing any of the ~150 pinned guards inventoried in §4.
**Do not treat this as a bug list. Install the spine first (Phase 1); most later items
become one-line checks against it.**

---

## 1. Architecture as-built (what you are hardening)

### 1.1 The 1:1 lifecycle (client)

```
CallState = 'idle' | 'calling' | 'ringing' | 'connecting' | 'connected'
          | 'reconnecting' | 'ended' | 'failed'

OUTGOING: idle → calling ──(call.answer)──► connecting ──(ICE connected + DTLS)──► connected
INCOMING: idle → ringing ──(accept())────► connecting ──(ICE connected + DTLS)──► connected
MID-CALL: connected ⇄ reconnecting  (ICE disconnected/failed → restart budget 30 s)
TERMINAL: ended | failed  (absorbing — the ONLY enforced rule today, CallController.setState)
```

Key modules (all under `src/modules/messenger/` unless noted):

| Layer      | Module                                                            | Role                                                                                                                                                                             |
| ---------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Controller | `webrtc/callController.ts`                                        | One instance per call. PC lifecycle, ICE gates (B-273 outbound, pendingIce inbound), ring timer (`webrtc/callRingState.ts`), connecting watchdog, reconnect budget, DTLS verify. |
| Signalling | `webrtc/signallingClient.ts`                                      | Per-callId outbound send queue (`enqueueForCall` + `waitOpenThenSend`, 40 s setup budget), `cancelledCalls`, multi-subscriber inbound handler arrays.                            |
| Dispatch   | `webrtc/callDispatcher.ts`                                        | WS frame → registered `CallSignalling` or `onIncoming`; pre-registration frame queue (30 s TTL); B-331 unhandled-offer cache; B-64 zombie-end.                                   |
| Registry   | `runtime/callRegistry.ts`                                         | **Cross-surface source of truth** (`active` singleton: controller, streams, state, `keepAlive`, `isMinimized`); `recentlyEnded` (2 min); audio-session flags.                    |
| Hook       | `webrtc/useCall.ts`                                               | Boots/adopts the controller, mirrors registry, owns stats poll + AppState notify.                                                                                                |
| Screens    | `src/screens/messenger/CallScreen.tsx`, `FloatingCallOverlay.tsx` | UI + accept/dismiss latches. `VoiceCallScreen.tsx` is a `__DEV__` demo — NOT part of the system.                                                                                 |
| Launch     | `webrtc/launchCall.ts`                                            | The only outgoing entry: role gate, combined 1:1+group busy gate (B-320), double-tap latch (CALL-17).                                                                            |

### 1.2 The group lifecycle (client)

```
GroupCallState = idle → creating (host POST /sfu/rooms) → joining (sfu.join) → joined
                        ⇅ reconnecting (ICE restart | WS-reopen rejoin | rejoinRoom)
terminal: left | ended-by-host (auto-pop) | kicked | failed | full | unavailable (blocker card)
```

State holders: `useGroupCall.ts` React state (per mount), `runtime/groupCallRegistry.ts`
singleton (11 writer files), `liveSfuHandlesByRoom` module Map (minimize/restore stash),
`webrtc/groupCallRejoinHub.ts` (ONE global handler slot + wall-clock rejoin claim),
`webrtc/sfuDispatcher.ts` (roomId → Set of handlers), `webrtc/groupCallIdentityRegistry.ts`,
`webrtc/groupCallRingDispatcher.ts` (`(roomId,ringId)` dedup), `push/pendingGroupRing.ts`
(park slot, 45 s TTL).

### 1.3 Server (apps/messenger-service)

- **1:1**: `gateway/messenger.gateway.ts` holds `callSessions: Map<callId, CallSession>`
  (`ringing|active|ended` + 60 s tombstones) — **in-memory, per replica, no DB row ever**.
  Redis holds signaling _artifacts_ only: `pending-call-offer:*` (45 s), `missed-call-marker:*`,
  `pending-call-answer:*` (15 s). Events: `call.offer/answer/ice/hangup/media-state/reoffer/
reanswer` + server-only `call.missed`. There is NO `call.ring/accept/reject/cancel` — reject
  and cancel are both `call.hangup{reason}`. `authorizeCallFrame` is the universal gate
  (unknown/ended callId → silent `{ignore:true}`; wrong party → `auth_failed`).
  `trackCallEnd` runs BEFORE the hangup forward (in-flight duplicate frames die at the gate).
- **Group**: no call-session object at all — the mediasoup room IS the call
  (`sfu/sfu.service.ts` rooms/participants maps, 10-cap, zombie-room sweeper, worker-death
  broadcast). Ring lane: `sfu.ring` → per-recipient `sfu.ring.incoming` with per-fan-out
  `ringId` (B-336); Redis `pending-group-ring:*` per **user** (not per device).
- **Push**: every 1:1 offer ALWAYS produces WS frame + Redis-queued replay + `sendVoipWake`
  to ALL callee devices (N-01: zombie sockets look online ~55 s). Cancel push
  `sendCallCancel` on caller-gave-up / HTTP decline. Data-only FCM; HMAC-signed
  `voip-wake`; collapse keys `voip-wake:<callId>` / `voip-cancel:<callId>` (300 s).
- **Reconnect**: `handleConnection` = rooms → registry supersede → cancel disconnect-byes →
  flush pending answers → presence → envelope flush → drain pending offers → drain group
  rings (peek→emit→settle under a replica lock). `active` calls get a 12 s disconnect-bye
  grace; `ringing` gets an immediate bye. In-place `auth.refresh` swaps claims on the socket
  (B-100/101) and never touches call state.

### 1.4 Transport (client)

One `TransportClient` (`packages/messenger-core/src/transport/client.ts`), constructed only
by `productionRuntime.ts`, published via `runtime/transportRegistry.ts`. Old
`src/modules/messenger/transport/*` files are tombstones (pinned by `deadForkLock.test.ts`;
B-152 `transportSingleSource.test.ts`). Inbound: `socket.onAny` → epoch gate → (call frames
exempt from the depsReady buffer) → `handleServerFrame` → `callDispatcher` /
`sfuDispatcher` / `groupCallRingDispatcher`. Reconnect: single-flight `open()` with
`connectGeneration`, teardown-before-reopen (RELAY-C1), in-place `auth.refresh` off the
Manager ping, immediate reopen when `hasLiveCall()`. `send()` THROWS when closed — nothing
buffers; `call.ice` has no queue, no retry, no replay.

### 1.5 Incoming-call delivery lanes (Android)

Eleven lanes converge (WS offer foreground; WS offer no-handler → B-331 cache; group WS
ring; FCM warm-background rich handler; FCM killed/headless slim handler; FCM foreground
group rescue; full-screen notifee card + native ringtone; Telecom self-managed
`reportIncomingCall`; notifee actions (rich + slim `onBackgroundEvent` owners); cold-start
`getInitialNotification()`; boot/foreground `sweepStaleCallNotifications`). Convergence
keys: `incomingCallCache` (merge semantics NA-01, tombstones NA-02, 60 s TTL), notifee id
`bravo-call-<callId>`, Telecom uuid = callId, accept latch (`acceptedCallIds` +
`explicitAcceptIds`), `(roomId,ringId)` group dedup.

---

## 2. The diagnosis — five structural defects (fix these, not symptoms)

**D1 — No identity-keyed writes.** `patchActiveCall` / `endActiveCall`
(`callRegistry.ts`) and `patchActiveGroupCall` (`groupCallRegistry.ts`) take **no
callId/roomId**. ~40 call sites mutate "whatever is active". Any stale continuation (late
ring expiry, queued hangup ack, ICE-failed on a closing PC, a 4 s reconcile tick from a
kept-alive previous call) can mutate or **tear down a newer call**. This is the single
highest-leverage defect.

**D2 — No generation primitive.** Identity is callId-only. Two hook instances for the SAME
callId (minimize→restore, permission-dialog remount) are indistinguishable — the code
documents that frozen first-mount callbacks keep firing into dead React state and mitigates
by mirroring instead of invalidating. Group calls have the same hole (state has ~10 writers;
`'failed'` and `'joined'` can land in either order after a rejoin).

**D3 — No transition table.** The only enforced rule is terminal-absorbing.
`connected → connecting` regression is live (1:1 `handleAnswer` after a fast ICE connect),
and it re-arms the 20 s connecting watchdog against a healthy call.

**D4 — Cleanup has six owners, one re-entrant.** `CallController.end` (idempotent, correct),
`callRegistry.endActiveCall` (idempotent but **re-entrant** — it calls `controller.hangup`
which synchronously re-enters `endActiveCall` via `useCall.onState`, double-running
unregister/audio-stop/notify/CallKit-report), `useCall` boot cleanup, `useCall.onState`
terminal, `CallScreen` audio effect cleanup, `CallScreen` user-intent paths. Group:
`endActiveGroupCall` nulls the registry slot BEFORE awaiting `leave()`, opening a window
where busy-guards see "no call" while transports are still closing.

**D5 — The server does not arbitrate.** `trackCallAnswer` is `if ringing → active` — no
double-answer rejection, no record of which device answered, no "answered elsewhere" cancel
to other ringing devices, and artifacts are cleared for the answering device only. Group WS
decline (`handleSfuRingDecline`) clears nothing (ghost re-ring + phantom missed call). The
1:1 client has no way to reconcile state with the server (no `call.sync`).

Everything in §5 hangs off these five.

---

## 3. Hard constraints — the spec is void where it conflicts with these

1. **M4 (call-key namespace) is ARCH-GATED.** `GroupState` is a cross-device shape; do NOT
   implement `isCallGroup`/separate `callKeys`. Escalate only. (MESSAGE_LOOP §10.)
2. **B-100 directions B (revocation grace) and C (exempt in-call sockets) are FORBIDDEN**
   (`docs/architecture/MESSENGER_BACKEND.md` "instant kill"). Only in-place re-auth.
3. **SFrame group-key gate stays FAIL-CLOSED.** Widen waits if needed; never relax the gate.
4. **No changes** to wire stamp, sender-cert verify order, AAD binding, group master-key
   distribution/rekey/epoch — stop conditions. B-334's C3 anti-spam anchor (unknown room →
   `not_host`) must survive any server edits.
5. **Never weaken** `verifySenderCert`/`verifySealedAad`/`authorizeCallFrame`/biometric gates;
   never log plaintext/key material (`logAudit.test.ts` scans the call paths).
6. **Group-call tile pager stays `useNativeDriver:false`** (mixed-driver throw + SurfaceView
   detach). **Reanimated is unusable** (worklets babel plugin absent). **Never re-key RTCView
   trees** (Fix #13 EGL identity).
7. **B-32 FGS DO-NOT-CHANGE list**: `runtime/callForegroundService.ts`, its start/stop call
   sites, permission-gating effects, `AndroidManifest.xml`, channel semantics — hands off
   except where a work item below explicitly names an adjacent seam.
8. **No timer-based recovery for backgrounded calls** — RN Android freezes JS timers when the
   activity pauses. Wall-clock expiring guards, Manager-`ping`-driven renewal,
   `msSinceServerSignal()` only. **No boolean in-flight latches** for anything whose ack can
   be lost while locked (a `.finally()`-cleared flag dies with the promise).
9. **Bare `InCallManager.stop()` banned** (B-243 scan) — only `stopSharedAudioSession(owner)`.
   Any route apply reached from `onAudioDeviceChanged` must call `invalidateAppliedRoute()`
   first. Telecom mirrors (CallKeep vocabulary: `'Bluetooth'`/`'Headset'`/`'Speaker'`), never
   diverges.
10. **Never import `Alert` from react-native** (B-88; use `@utils/alert`). **Keyboard: only
    `useKeyboardLayout`** (B-184).
11. **B-430 ordering constraints** (load-bearing, found in review): boot-failure room reap
    AFTER ring-cancel; reap only when never-joined; reap immediately or not at all (never via
    `wsRequest`); `room_not_found` retry outgoing-only (P1-BR-1).
12. **DOCUMENTS pins are sacred** — never delete one to green a run; a fix flips its
    assertion (B-461, B-298, B-150 pattern).
13. **`useGroupCall.ts` cannot load in the node Jest project** (mediasoup import). Every
    testable helper goes in its own pure module (the `groupCallLayout.ts` /
    `callAudioRoute.ts` / `groupCallKeyWait.ts` pattern).
14. **Do not re-propose anything in the DO-NOT-RE-PROPOSE table** (§11).

---

## 4. What already exists — guard inventory (do not re-implement, do not regress)

The full inventory is ~150 guards. The classes below are each pinned by the named test —
**run the pins for any area you touch, and read the pin before changing its subject**:

**1:1 controller/protocol**: terminal-absorbing setState; `cancelled || !pc || isClosed()`
teardown-wins at every await (×14, `callControllerTeardownWins.test.ts`); callId + peer-
identity drop on every inbound frame (P1-N5); S7 offer-auth verify (`callOfferAuth.test.ts`);
inbound pendingIce queue + B-273 outbound ICE gate; renegotiation single-flight + glare
rollback; B-62/NA-05 two-stage connecting watchdog with missed-ICE re-probe
(`callController.connectingWatchdog.test.ts`); B-108 `everConnected` gate
(`iceFailedReconnect.test.ts`); P2-BR-6 wall-clock reconnect budget + notifyForeground/
Background (`callBackgroundReliability.test.ts`); B-274 accept-two-honest-outcomes; ring
state single-slot timer (`callRingState.test.ts`, `callController.ringTimeout.test.ts`).

**Dispatch/signalling**: pre-registration frame queue + TTL; registerSignalling overwrite
warn; B-64 zombie-end (`callDispatcherZombieEnd.test.ts`); no-controller hangup teardown;
per-callId send queue + `cancelledCalls` (SN-05); B-331 unhandled-offer cache
(`callOfferNoHandlerCache.test.ts`); missed-call 6 h age gate (`missedCallNotifAge.test.ts`).

**Registry/hook/screen**: CALL-N15 `recentlyEnded` ghost-redial guard; CALL-N1 adopt-before-
SDP-bail; keepAlive minimize contract (`callMinimizeRestorePins.test.ts`); B-243/CALL-N5
shared-audio arbitration (`callAudioSessionArbitration.test.ts`); B-319 `controllerReady`
gate + latch release (`callAnswerStuck.test.ts`); B-102 A1/A2 accept latch + null-controller
decline (`callAcceptLatch.test.ts`); B-110 accept-intent TTL + dead-offer watchdog
(`CallScreen.deadOffer.test.ts`); CALL-17 launch latch (`launchCallDoubleTap.test.ts`);
B-320 combined busy gate (`callEdgeGuards.test.ts`); B-238-CW call-waiting banner
(`callWaiting.test.ts`); B-322 mounted-route belt; CALL-07/B-367 back/swipe-declines-ring;
B-306 single navigation actor + parked group ring (`pendingGroupRing.test.ts`,
`escalationRingHandoff.test.ts`); B-460 `confirmRestored`; P1-BR-4 `callResumeGuard`
(`callResumeGuard.test.ts`); role gate (`launchCallRoleGate.test.ts`).

**Group**: `(roomId,ringId)` dedup + B-306 mark-only-when-handled; `settledRef`/
`cancelledRef` one-shot ring latches; rejoin hub single-subscription + wall-clock claim;
`shouldAttemptRejoin` / `groupCallIsLive` gates; F7 token re-mint; `transportsAlive` adopt
gate; `staleLeavePromise` before `sfu.join`; B-343 stale-end before getUserMedia;
`inFlightConsumes` + `consumedProducerIds` dedup; early-producer buffer; B-13 batch flush;
B-17 `computeTilePrune` supersede/debounce (`groupCallTilePrune.test.ts`,
`groupCallTileReconcile.test.ts`); B-15 video-stall watchdog; B-14/B-05 ICE-restart-waits-
for-WS; B-101 LC-5 budget; GC-06 `withTrackBlanked` + B-123 latch repair; P0-C3 strict tag
binding; B-124 `callKeyRegistry` (root fix c13eb55 — do not touch); B-320/B-343/B-428/
B-429/B-430/B-431 launch/room-lifecycle set; logout reset sweep.

**Server**: `authorizeCallFrame` + tombstones + end-before-forward; duplicate-callId
perimeter; N-01 always-queue-always-wake; N-02 ghost-ring purge; P1-14 wrong-party clear;
SRV-03 peek→emit→settle drains under replica lock; FIX-07 answer double-emit ordering;
rehydration + `REHYDRATED_RING_TTL_MS`; P1-BR-5 12 s disconnect-bye grace; B-189 presence
re-assert; SFU-05 stale-tag supersede; SFU leave grace + B-336 `isReachableParticipant`;
B-238 corpse-room reap; C2/C3 ring authority; P1-BR-3 idempotent HTTP decline; SYNC-5 drain
cap.

**Notification/lifecycle**: NA-01 cache merge (`incomingCallCacheMerge.test.ts`); NA-02
tombstones; NA-03 handler-install-first; NA-04 `bringAppToForeground` before navigate
(`callSystemUiAnswerForeground.test.ts`, `callForegroundBringToFront.test.ts`); B-109 RC-3
Telecom onEnd probes live registry first; B-228 cold-cache decline fallback; B-331; W4.2
busy gate; B-107 restore gates; B-256 FGS arbitration (`callForegroundArbitration.test.ts`);
B-58 resume probe; FIX-14 stale-ring sweep; PUSH-B5 45 s bounds; B-27 vibration validation
(`callNotifActionContract.test.ts` pins the action contract).

**Transport**: single-flight `open()` + `connectGeneration` (P1-12); teardown-before-reopen
(RELAY-C1); Manager-ping listener swap (`socketReauth.test.ts`); wall-clock guards; B-11
superseded terminal; network park with live-call veto; owner-epoch fence; call-frame
exemption from depsReady buffer; per-callId outbound queue; B-152/`deadForkLock` tombstones.

---

## 5. The work plan

Ordered phases. Within a phase, items are independent unless noted. For EVERY item:
re-grep the named symbols first (lines rot); write the failing test FIRST (mutation-prove by
reverting); run the §7 gates. Findings marked **(verify)** were established by static
reading — confirm the behaviour with a quick trace/test before building the fix.

### Phase 1 — the identity spine (client) — P0, do this first

**WI-1.1 — Key the 1:1 registry by `{callId, gen}`.**
`runtime/callRegistry.ts`: add `gen: number` to `ActiveCallState`, minted from a module
monotonic counter in `setActiveCall`. Change `patchActiveCall(patch)` →
`patchActiveCall(key, patch)` and `endActiveCall(reason, source)` →
`endActiveCall(key, reason, source)` where `key = {callId, gen}` (accept a plain callId
where the caller genuinely cannot know the gen — e.g. `endZombieSession` — but then require
callId match). Mismatch → drop + `[CALLSM]` warn. Update every writer:
`useCall.ts` (`onState`, ontrack, `connectedAtMs`, media-state, stats self-heal, camera
recovery, adopt), `CallScreen.tsx` (`conversationId/peerName` patch, keepAlive patch, video
toggles, endCall/declineCall/dead-offer), `FloatingCallOverlay.tsx`, `callWaiting.ts`,
`callDispatcher.endZombieSession`. The adopted instance inherits the SAME gen (adoption is
continuation, not a new call).
Fixes: 1:1 G1 (stale terminal tears down new call), G3 (generation primitive), and provides
the primitive every later phase checks against.
Tests: new `callRegistryIdentity.test.ts` (node project) — stale-key patch dropped,
stale-key end dropped, same-gen adopt allowed, new `setActiveCall` bumps gen.

**WI-1.2 — Make `endActiveCall` non-re-entrant and record `recentlyEnded`.**
In `endActiveCall`: (a) snapshot-and-null or set an `ending` latch BEFORE calling
`active.controller?.hangup(reason)` so the synchronous re-entry from `useCall.onState`
terminal (`endActiveCall(s)`) hits the null/latch and returns — exactly one unregister /
`stopSharedAudioSession` / notify / CallKit report / cache tombstone / FGS stop. Keep the
external behaviour: listeners see ONE null transition. (b) Record the callId into
`recentlyEnded` inside `endActiveCall` — today only `setActiveCall` records, so the dominant
end path misses CALL-N15 and FIX-14 entirely (1:1 G4, G5).
Tests: extend `callRegistryIdentity.test.ts` — re-entrant end runs side-effects once
(spy `stopSharedAudioSession` / `unregister`); `wasRecentlyEnded` true after
`endActiveCall`.

**WI-1.3 — Fix the adopt-branch cross-call 'ended' flip.**
`useCall.ts` adopt mirror maps "registry null OR different callId" → `setState('ended')`.
A NEW call's `setActiveCall` therefore flips a still-mounted older hook to `'ended'` while
its controller lives (1:1 G8). Change to: mirror only when `st.callId === callId`; when the
slot holds a DIFFERENT callId, end OUR call through the keyed `endActiveCall` (two live 1:1
calls is invalid — B-320/B-322 should prevent it, so also emit a `[CALLSM]` anomaly warn),
and when the slot is null, consult our controller's `currentState` before declaring ended.
Tests: extend `useCall.test.tsx`.

**WI-1.4 — Stop `onMediaState` handler accumulation across restores.**
Adopt registers a new handler each restore and never removes the prior instance's (1:1 G9).
Have `signallingClient` return the unregister from `onMediaState` and make the adopt branch
call the previous one (store it on the registry entry), or make registration replace-by-key.
Test: node test on `CallSignalling` — N registrations after N adopts == 1 live handler.

**WI-1.5 — Key the GROUP registry by roomId.**
`runtime/groupCallRegistry.ts`: `patchActiveGroupCall(roomId, patch)` — refuse when
`active.roomId !== roomId` (today only 1 of 29 call sites checks; group G1). Update all
writers in `useGroupCall.ts` (frame handlers, consume/reconcile writes, camera writes,
identity write) + the other 10 writer files. Mint a `gen` here too (same counter pattern)
for WI-3.2's use.
Tests: extend `groupCallRegistry` tests (node) — stale-room patch dropped.

**WI-1.6 — `endActiveGroupCall` must not null-before-await.**
Today: `active = null; notify(); await leave()` — busy guards (`launchCall`,
`useGroupCall` boot `existing` check) see "no call" while transports still close, admitting
a boot that races `sfu.join` (group G10, the `transport_id_in_use` class). Change to: mark
the entry `ending: true` (busy guards treat `ending` as busy), await `leave()`, THEN null +
notify; expose the in-flight promise the same way `staleLeavePromise` is consumed so the
next boot awaits it (bounded ≤3 s, matching Fix #8).
Tests: node test on the registry; extend `callEdgeGuards.test.ts` for the busy-guard
`ending` semantics.

### Phase 2 — the 1:1 state machine proper — P0/P1

**WI-2.1 — Legal-transition table in `CallController.setState`.**
Add `const LEGAL: Record<CallState, CallState[]>` and reject (warn + drop) anything else:

```
idle        → calling | ringing
calling     → connecting | connected | ended | failed        (connected: missed-answer fast ICE)
ringing     → connecting | ended | failed
connecting  → connected | reconnecting | ended | failed
connected   → reconnecting | ended | failed                  (NEVER back to connecting)
reconnecting→ connected | ended | failed
ended/failed→ (absorbing — keep the existing guard)
```

This mechanically closes 1:1 G2: `handleAnswer`'s late `setState('connecting')` after a
fast ICE `connected` currently regresses the state and re-arms the 20 s watchdog against a
live call. Keep the existing watchdog arm/clear side-effect keyed off the ACCEPTED
transition only. Every rejected transition logs `[CALLSM] illegal <prev>→<next> src=<caller>`.
Tests: extend `callControllerTeardownWins`-style node tests — simulate answer-processing
finishing after ICE-connected; assert state stays `connected` and the watchdog is not armed.
**(verify)** the `calling → connected` row: trace whether an outgoing call can legitimately
skip `connecting` (answer applied + ICE up inside one task); include the row only if real.

**WI-2.2 — Kill the controller-reuse ambiguity.**
`end()` "clean slate" resets + `startOutgoing`'s `state === 'idle'` requirement imply reuse,
but terminal-absorbing makes reuse impossible — and a reused instance would inherit
`everConnected = true`, faking a 30 s reconnect on a fresh call's TURN failure (1:1 G7,
G15, the B-41 class). Declare **one controller = one call**: delete the misleading reset
block (or reduce to comments-free minimal nulling for GC), have `startOutgoing` /
`handleIncomingOffer` throw if the instance was ever used. No behaviour change intended —
this is removing a trap.
Tests: node — second `startOutgoing` on a used instance throws.

**WI-2.3 — Centralize call deadlines with ordering asserts.**
New pure module `webrtc/callDeadlines.ts` exporting the 11 constants currently scattered
(ring 45 s, connecting 20 s, answer-delivery 50 s, reconnect budget 30 s, restart retry 4 s,
setup send budget 40 s, accept-intent TTL 45 s, dispatcher frame TTL 30 s, recently-ended
120 s, TURN ceiling 6 s, launch watchdog 10 s). A static test pins the ordering invariants
(e.g. `ANSWER_DELIVERY ≥ SETUP_SEND_BUDGET`, `ACCEPT_INTENT_TTL === RING_TIMEOUT`,
server pending-offer TTL 45 s === client ring — note the server pair in a comment; the
ANSWER-STALL post-mortem is exactly this drift) (1:1 G11).

**WI-2.4 — Screen/overlay timer hygiene.**
`CallScreen.tsx`: (a) the 1.5 s autoAccept retry — clear on unmount, read live state from a
ref not the render closure, and verify the controller identity via the WI-1.1 key before
calling `accept()`/`hangup()` (1:1 G6); (b) clear the two 800 ms pop watchdogs and the
350 ms route re-apply on unmount; (c) initialize `liveCallStateRef` from the actual current
state, not the literal `'connecting'` — today the first back press on an incoming ring can
take the minimize branch instead of CALL-07 decline (1:1 G13). `FloatingCallOverlay.tsx`:
`confirmRestored`'s fallback must check the callId it armed for before re-minimizing
(1:1 G6); compute `orphanedLive` from a nav-state subscription instead of reading
`navigationRef.getCurrentRoute()` during render (1:1 G14) — keep the existing render
output identical.
Tests: `callMinimizeRestorePins.test.ts` extension + a new static/DOCUMENTS-style pin where
render-mount is unreachable in node.

**WI-2.5 — Duplicate-offer handling for a registered call.**
Today an offer replay for a registered callId goes to `sig.ingest` → `offerHandlers` → and
is dropped because `CallController` never subscribes `onOffer` (1:1 G10) — which also makes
the B-102 A1 `autoAccept` re-assert dead once the hook has registered. And
`handleIncomingOffer`'s busy-bounce has no same-callId carve-out, so any future wiring
would answer the caller `busy` and kill the call (1:1 G16). Do BOTH: (a) add the carve-out
`if (offer.callId === this.descriptor?.callId) return;` to `handleIncomingOffer`; (b) in
`callDispatcher.dispatchCallFrame`, when a `call.offer` arrives for a REGISTERED, still-
ringing call whose callId is in `wasCallExplicitlyAccepted`, re-fire the accept nudge (log
`[CALLSM] offer-replay accept re-assert`) instead of silently swallowing.
Tests: extend `callAcceptLatch.test.ts` + a controller node test for the carve-out.

### Phase 3 — group-call identity + rejoin serialization — P0/P1

**WI-3.1 — Per-attempt generation in `useGroupCall`.**
Add `attemptGenRef`, bumped at boot and at every `rejoinRoom` entry. Check it after every
`await` inside `rejoinRoom` and at EVERY `setState` site (`onBudgetExpiry`'s
`setState('failed')`, `attemptSfuRejoin`'s `.then` failed-writes, `rejoinRoom`'s final
`setState('joined')`). This closes group G6 (`failed`/`joined` stomping each other in either
order) and G3's duplicate-producer half (a superseded rejoin's `producersRef.push` /
`sendTxRef` overwrite / `consumedProducerIdsRef.clear()` all become no-ops).
Tests: pure-module extraction — put the gen-check decision in a tiny
`webrtc/groupCallAttemptGen.ts` (constraint §3.13) and unit-test the stale-attempt rejection
matrix.

**WI-3.2 — Serialize `rejoinRoom` against the reconcile tick and early-producer buffer.**
Set `rejoinInProgressRef` for the whole of `rejoinRoom`; the 4 s `reconcileProducers` tick,
`attemptConsume`, and the early-producer buffer's `isReady` probe all bail while it holds
(group G4 — today they consume onto a half-built `reRecvTx` and re-insert tiles the rejoin
just cleared). Buffer `sfu.new-producer` frames during the window (the existing early-
producer buffer is the right vehicle) and drain after `setState('joined')`.
Tests: `groupCallReconnect.test.ts` extension.

**WI-3.3 — Rejoin-hub ownership tokens.**
`setGroupCallRejoinHandler(token, ws, fn)` / `clearGroupCallRejoinHandler(token)` where
token = roomId+gen. An old instance's un-awaited `leaveInternal` (fired by `launchCall`'s
`void staleLeave()` or `endActiveGroupCall`) can currently clear the NEW call's handler,
silently killing WS-reopen recovery for its whole lifetime (group G2). Also raise the claim
问题: `REJOIN_STUCK_MS = 30 s` is routinely exceeded by a real 4-peer rejoin, letting a
second `onReconnect` start a concurrent `rejoinRoom` — with WI-3.1's gen the loser now
no-ops, but ALSO bump the takeover to a value derived from the worst-case rejoin budget and
log a `[CALLSM]` warn on takeover (group G3).
Tests: `groupCallRejoinHub.test.ts` extension — stale-token clear is a no-op.

**WI-3.4 — Stash the consume-dedup sets across minimize/restore.**
Add `inFlightConsumes` + `consumedProducerIds` to `LiveSfuHandles` (or derive
`consumedProducerIds` from `consumersByPid` keys on adopt). Today the restore branch starts
them empty while `consumersByPid` is populated, so `consumeMissingAfterRestore` re-consumes
a consumed-but-tileless producer and `recv.consume` throws "consumer already exists"
(group G5 — the exact B-17 class the reconcile exists to fix).
Tests: node test on the stash shape + adopt derivation.

**WI-3.5 — `IncomingGroupCallScreen` param-reuse correctness.**
The screen supports a NEW ring re-using the mounted instance (`settledRef` resets on
`roomId`), but: the 45 s ring timer is a `[]`-deps one-shot (not re-armed for ring #2, and
ring #1's timer can fire with ring #1's `conversationId`, writing a wrong-conversation
missed bubble and dismissing ring #2), and `cancelledRef` NEVER resets, so a cancel for
ring #1 permanently poisons Accept for ring #2 (group G7). Re-key the timer effect on
`roomId`, cancel the prior timer, reset `cancelledRef` alongside `settledRef`.
Tests: extract the timer/latch decision into a pure helper + unit-test; extend the
autopop-adjacent source-scan if render tests can't mount it.

**WI-3.6 — Don't burn the ring-dedup marker on suppressed rings.**
`dispatchGroupRingFrame` marks `(roomId,ringId)` as seen as soon as handlers exist — a ring
dropped by restore-mode (or any suppressing branch) still burns the marker, so the server's
reconnect replay AND the FCM rescue copy are dedup-suppressed for 60 s (group G8). Move the
mark to "a handler actually presented or parked the ring" (return a verdict from the
handler chain, mirroring the B-306 mark-only-when-handlers-exist fix one level deeper).
Tests: `groupCallRingFanout.test.ts` / ring-dispatcher node tests.

**WI-3.7 — Room-scope the surviving unguarded timers.**
`rebuildVideoConsumer` (stall watchdog), the +5 s `dumpSelectedPair`, and the screen's
duration tick (`getActiveGroupCall()?.joinedAtMs` with no room comparison) each get a
roomId/gen check (group G9). With WI-1.5 the registry reads become keyed for free.

### Phase 4 — notification & lifecycle — P1

**WI-4.1 — Seed real state from the killed-app (headless) ring.**
`push/fcmHeadless.ts` today only shows the notifee card: no `setIncomingCallPayload`, no
Telecom `reportIncomingCall`, no busy/restore/tombstone checks — so in that VM a system-UI
Answer is impossible (Telecom never told) and `handleSystemUiAnswer` early-returns on the
empty cache (notif gap 1). Bring the headless lane up to the warm-background lane's
contract: verify → tombstone check → cache seed (merge semantics) → Telecom report → card.
Keep it dependency-light (no runtime boot — B-354's `bg:'1'` lane is separate and stays).
Also: headless `call-cancel` must tombstone (`clearIncomingCallPayload`) + clear the accept
latch, not just dismiss (notif gap 10).
Tests: extend `incomingCallCacheMerge.test.ts` + a new `fcmHeadlessSeed.test.ts` (node,
mock notifee/callkeep the way `callAcceptLatch.test.ts` does).

**WI-4.2 — One owner for `notifee.onBackgroundEvent`.**
Two registrars exist (slim `installSlimNotifeeBgHandler` at bundle entry; rich
`installNotifeeHandlers` in `startFcmBootstrap`) — last-write-wins, and which one owns a
given Answer press depends on incidental module evaluation order; the slim owner dismisses
the ring, latches nothing, navigates nowhere (notif gap 2). Make ONE funnel: the slim
module keeps the registration but delegates to the rich handler when
`fcmBootstrap` is loaded, and otherwise records the press durably (module var + the
`getInitialNotification` replay already covers cold start) so the rich handler can replay
it on boot. **(verify)** the exact evaluation-order matrix on device before choosing the
delegation shape.
Tests: contract test pinning "exactly one behavioural owner" (spy both paths).

**WI-4.3 — Nav-timeout abandon must not eat the answer.**
On the 20 s `waitReady` timeout the code clears `explicitAcceptIds` and returns — but the
ring card + ringtone were already killed, and clearing the latch means the WS offer replay
navigates WITHOUT `autoAccept`: the user answered and gets nothing (notif gap 4). Keep the
explicit-accept latch on timeout (it has its own 5-min scrub), log `[CALLSM]`, and re-try
the navigate once when the nav ref becomes ready (subscribe once, no polling loop beyond
the existing).
Tests: extend `callAcceptLatch.test.ts`.

**WI-4.4 — Body tap must not burn the accept dedup.**
`markAccepted` runs for body taps too, so body-tap → Telecom Answer for the same call is
dropped as "already accepted" — a real answer press does nothing (notif gap 5). Only accept
ACTIONS latch `acceptedCallIds`; body taps navigate without latching.
Tests: `callAcceptLatch.test.ts` extension (this is squarely its subject).

**WI-4.5 — Group answer/end must clear its ring surfaces and tombstone.**
No group path calls `dismissCallNotif`/ringtone-stop on in-app answer, so a wake-drawn card

- native ringtone survive into the joined room for up to 45 s (notif gap 6); and
  `endActiveGroupCall` never tombstones the roomId, so `isIncomingCallDead(roomId)` is
  forever false — the dead-call guard and stale-ring sweep have no group death signal (notif
  gap 7). Add `dismissCallNotif(roomId)` + `stopIncomingRingtone` on group accept
  (IncomingGroupCallScreen accept + autoAccept), and `clearIncomingCallPayload(roomId)` in
  `endActiveGroupCall` (inside WI-1.6's ordered teardown).
  Tests: node tests on the registry end path; notif-side spies.

**WI-4.6 — Group explicit-accept re-assert parity.**
The RN6 param-replacement re-assert (`wasCallExplicitlyAccepted` → re-add `autoAccept`)
exists only on the 1:1 offer navigation; the group WS ring landing after an FCM Answer
navigate re-navigates WITHOUT `autoAccept` (notif gap 8). Mirror the 1:1 re-assert in the
`MainNavigator` group-ring handler.
Tests: `callAcceptLatch.test.ts` / navigator contract extension.

**WI-4.7 — `accept()` consults the tombstone.**
Between a caller-cancel tombstone and the next 1 Hz dead-offer watchdog tick, an
auto-accept can still fire `call.answer` at a gone peer (notif gap 9; the watchdog is also
armed only after an accept intent). Add `if (isIncomingCallDead(callId))` refusal at the
top of `useCall.accept` (loud `[CALLSM]` + return false so the B-319 latch-release path
runs).
Tests: `callAnswerLifecycle.test.ts` extension.

**WI-4.8 — Align `incomingCallCache` TTL with its consumers.**
Live payload TTL is 60 s while `acceptedCallIds` lives 5 min and `recentlyEnded` 2 min; the
comment says the payload is kept "for the whole call" but the TTL erases it — and the
Telecom `onEnd` fallthrough then lands in branches that can send `call.hangup{declined}` on
a call the user is answering (notif gap 11). Refresh the live entry's TTL while the callId
matches the live registry (or pin-until-terminal), and make the Telecom `onEnd`
"payload-present + registry-empty" branch consult the accept latch before declining.
Tests: `incomingCallCacheMerge.test.ts` + `callAcceptLatch.test.ts` extensions.

**WI-4.9 — Missed-call notification lifecycle.**
`bravo-missed-<callId>` is never cancelled on calling back or reading the thread, and the
sweep only matches `bravo-call-*` (notif gap 12). Cancel on: opening the caller's thread,
a new call to/from that peer, and add `bravo-missed-*` aging to
`sweepStaleCallNotifications`.
Tests: extend `missedCallNotifAge.test.ts`.

**WI-4.10 — (P2) 1:1 foreground FCM rescue parity.** `onMessage` re-dispatches only GROUP
wakes; a foregrounded device whose WS offer was lost has no 1:1 rescue (notif gap 14).
Synthesize the 1:1 equivalent (cache seed + `onIncoming`) — the dedup keys already make it
idempotent. Tests: rescue-path node test.

### Phase 5 — transport — P1

**WI-5.1 — Fix the double-`token_revoked` stranding (messenger-core).**
In `TransportClient`'s inline `error{unauthorized|token_revoked}` interception: when
`handleAuthReject()` returns false because a refresh is in flight, the code falls through
to `closedByUser = true; setState('unauthorized'); disconnect()` — the resolving refresh
then bails at `doOpen`'s `closedByUser` check: terminal strand, mid-call death at the
grace timer (transport G1). The `connect_error` sibling path is correct (benign
`reconnecting` fallback) — make the inline path match it. NOTE: the RN pin
`transportClientSocketIo.test.ts` documents this as an open defect and asserts core "fixed
it properly" — **that claim is currently false**; flip the pin to assert the fixed
behaviour (DOCUMENTS→fixed pattern).
Tests: `packages/messenger-core/__tests__/` — double-reject during in-flight refresh ends
in `reconnecting`, not `unauthorized`.

**WI-5.2 — `close()` hygiene.**
`close()` leaves `frameListeners`/`reconnectListeners`/`hasConnectedOnce` intact; a stale
holder calling `forceReconnect()` revives the corpse with old listeners attached and
immediately fires `reconnectListeners` (a group rejoin against a new session) (transport
G7). Clear all three in `close()`.
Tests: messenger-core unit.

**WI-5.3 — No stale transport captures in call modules.**
After `disposeLiveRuntime()` → new transport: `groupCallRejoinHub` stays bound to the DEAD
client until the next `setGroupCallRejoinHandler`; `CallSignalling` captures the transport
in its constructor; `useGroupCall` keeps `transportRef.current = oldWs` — all sends then
throw-and-swallow silently (transport G5). Fix: `CallSignalling` resolves the transport
lazily per send via `getLiveTransport()` (keep the constructor param as fallback for
tests); the rejoin hub subscribes to `transportRegistry.onTransport` and re-binds
(compose with WI-3.3's tokens).
Tests: node — swap the live transport, assert sends reach the new one.

**WI-5.4 — Push-lane call control gets the durable fallback it already has.**
`fcmBootstrap`'s `tx.send({event:'call.hangup'|'sfu.ring.decline'})` sites are guarded only
on `tx` truthiness; a disconnected transport throws inside `send()`, the catch logs, and
the `enqueuePendingAction` branch is never reached — the decline is lost, the caller keeps
ringing (transport G9). Wrap each site: try send, on ANY failure enqueue the durable
action.
Tests: extend the pendingActions tests.

**WI-5.5 — Serialize inbound call-frame dispatch per callId.**
`dispatchFrame` does `void handleServerFrame(...)` per frame; `dispatchCallFrame` awaits
async offer verification, so a `call.answer`/`call.ice`/`call.hangup` can be processed
before the offer that precedes it on the wire finishes verifying (transport G4). Add a
per-callId promise chain inside `callDispatcher.dispatchCallFrame` (same pattern as the
outbound `callIdQueues`). Keep non-call frames untouched.
Tests: node — offer(slow verify)+answer arrive in order; answer processed after.

**WI-5.6 — Bound-buffer outbound ICE across reconnect windows.**
Trickle `sendIce` uses fire-and-forget `safeSend`; every candidate during a
disconnected/reopening socket is silently lost, with no replay lane server-side (transport
G2/G3). Route non-restart ICE through the per-callId queue with a small wait-open budget
(reuse `waitOpenThenSend`, cap ~5 s, drop-oldest at 64 mirroring the inbound queue), so a
1–3 s WS blip during setup doesn't strand the handshake. Do NOT try to replay ICE
server-side (out of scope; ICE restart is the mid-call recovery).
Tests: signalling node test — candidates queued while closed, flushed on open, dropped
past cap.

**WI-5.7 — Clear dispatcher state on logout/teardown, and floor `forceReconnect`.**
Verify `clearAllCallDispatchState()` is reached on every `disposeLiveRuntime` path (not
only signOut), and that already-queued pre-registration frames can't drain into a
signalling registered after an account switch (transport G6 — the epoch fence stops new
frames only). Add the missing wall-clock floor to `forceReconnect` when
`state !== 'connected'` (transport G8).
Tests: dispatcher node test + messenger-core unit.

### Phase 6 — server — P1/P2 (single-replica fixes now; multi-pod explicitly deferred)

**WI-6.1 — Answer arbitration + "answered elsewhere".**
`trackCallAnswer`: record `answeredBy {userId, deviceId}` on first answer; a second
`call.answer` for an `active` session is NOT forwarded (return the idempotent-ok shape,
log). On first answer: clear pending-offer artifacts for **ALL** the callee's devices (not
just the answering one — today another device's reconnect can drain a live replay of an
answered call) and `sendCallCancel(..., missed=false)` to the callee's OTHER devices so
their ring UIs collapse ("answered elsewhere"; reuse the existing cancel-push client
handling — `handleCallCancel` already dismisses + tombstones) (server G2).
Tests: new gateway spec `messenger.gateway.answer-arbitration.spec.ts` — double answer
forwarded once; artifacts cleared across devices; cancel push fanned to non-answering
devices only.

**WI-6.2 — WS group decline parity with HTTP decline.**
`handleSfuRingDecline` verifies authority and emits to the host — and clears NOTHING:
the decliner's queued ring survives (ghost re-ring on reconnect, phantom "missed group
call" for an explicitly declined call, other devices keep ringing) (server G3). Mirror
`declineCallViaHttp`: `clearPendingGroupRingArtifacts` + `sendCallCancel` to the
decliner's other devices. Keep C2/C3 authority checks byte-identical.
Tests: extend the sfu-auth/ring gateway specs.

**WI-6.3 — Make the artifact CLEAR paths atomic like their writers.**
`clearPendingCallArtifacts` / `clearPendingGroupRingArtifacts` are three sequential awaits;
a failure between them leaves marker+index with no payload — which the drain classifies as
a missed call **for a call that was answered** (server G4). Convert both to one `MULTI`
with per-command error inspection (the exact Phase-0 item 5 / D-3 pattern already used by
the writers).
Tests: gateway spec with a failing-redis fake asserting all-or-nothing.

**WI-6.4 — Close the SFU join-cap / host-election await window.**
Cap check and `participantTags.add` are separated by two `await createWebRtcTransport`
calls — two concurrent joins both pass at size 9; same shape for the `size === 0` host
election (server G5). Reserve the slot (add the tag / claim host) BEFORE the awaits and
roll back on failure, or re-check-and-reject after. Preserve the SFU-05 ordering (stale
same-user supersede before the cap check).
Tests: extend `sfu.service.join-cap.spec.ts` with genuinely concurrent joins (the current
spec is sequential-only).

**WI-6.5 — Un-brickable VoIP wake budget.**
`commitVoipWakeBudget`'s `INCR` then conditional `EXPIRE` can leave a TTL-less,
ever-growing counter (crash/Redis error between them) that permanently denies that
sender→recipient pair's wakes at the cap — the exact class D-5 fixed for the rate limiter
(server G6). Same fix: `MULTI().incr().expire()` or bucket-suffixed keys.
Tests: push spec.

**WI-6.6 — 1:1 `call.sync` reconcile query.**
There is no way for a client to ask "is callId X still alive?" — the SFU has
`sfu.producers` as its reconcile primitive; 1:1 has nothing, so a client that missed a
hangup (or hit any divergence) waits out its own timers (server G10). Add a read-only WS
event `call.sync {callId}` → `{state: 'ringing'|'active'|'ended'|'unknown'}` gated by
`authorizeCallFrame`-equivalent membership. Client: on resume-with-live-call (the
`callResumeGuard` `probe` branch) and on reconnect-with-live-call, query and hard-end the
local call if the server says `ended`/`unknown` (through the keyed
`endActiveCall`). This turns every "zombie call UI" class into a ≤1-round-trip heal.
Tests: gateway spec + client node test on the probe wiring.

**WI-6.7 — (P2) per-ring cancel semantics for groups.** Cancel/missed push reuses `roomId`
as the id, so a second ring for the same room can't be cancelled independently despite
`ringId` existing (server G9). Thread `ringId` through `sendCallCancel` for group rings and
key the client dismiss on it.

**WI-6.8 — DEFERRED (document, do not build): multi-pod call state.**
`callSessions`, disconnect-bye grace, in-process pending answers, SFU leave grace and the
session-aware adapter are all per-replica; every 1:1 guard is void across pods (server G1,
G7, G8). Staging/production run a single messenger-service replica today, so this is
NOT a live bug — but it IS a scaling landmine. Deliverable: a short
`docs/architecture/CALL_STATE_SCALING.md` note stating the constraint (pin caller+callee
to one pod via sticky sessions, or promote `callSessions` to Redis with 5-min expiry — the
field comment's own plan), plus a startup warn if a replica count > 1 is ever configured.
Do not attempt the Redis promotion in this pass.

### Phase 7 — observability — do alongside every phase

**WI-7.1 — Structured call-state logging that survives release.**
One helper (e.g. `runtime/callDiag.ts`): `logCallTransition({callId, gen, prev, next,
event, source})` → `console.warn('[CALLSM] ...')` single-line, greppable, NO SDP/keys/names
(logAudit-safe). Wire it into: `CallController.setState` (accepted AND rejected
transitions), the keyed registry ops (accepted AND dropped writes), group `setState` sites,
`endActiveCall`/`endActiveGroupCall`, the accept latch, and the notification funnels.
`console.warn` survives release builds (the strip keeps `warn`); this is how every
[CALLDIAG]/[LAGDIAG] probe already works. The entire call lifecycle must be
reconstructable from logcat `ReactNativeJS` warns.

**WI-7.2 — Server SFU/call logging.**
`SfuService` currently logs NOTHING on a successful join — B-346 could not be triaged from
server logs. Add structured single-line logs on: room create/reap, join/leave (tag,
userId, roomId, participant count), ring fan-out summary, decline, worker death, and on
every `callSessions` transition (callId, prev→next, source event). No payload contents.
Tests: none required beyond compile; keep log volume O(events).

---

## 6. Invariants — the contract this work must establish (and how each is pinned)

| #   | Invariant                                                                       | Enforced by                                                                                         | Pin                                                 |
| --- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| I1  | One active call session ⇒ one PeerConnection (1:1) / one transport pair (group) | controller one-shot (WI-2.2); rejoin gen (WI-3.1); serialize rejoin (WI-3.2)                        | controller node tests; `groupCallAttemptGen` tests  |
| I2  | A terminal call never returns to an active state                                | existing absorbing guard + WI-2.1 table; group attempt-gen                                          | transition-table test                               |
| I3  | Events from an old call cannot mutate a newer call                              | keyed registry ops + gen (WI-1.1/1.5); frame callId+peer gates (existing)                           | `callRegistryIdentity.test.ts`                      |
| I4  | Answer succeeds at most once, system-wide                                       | client accept latch (existing) + server arbitration (WI-6.1)                                        | `callAcceptLatch.test.ts` + answer-arbitration spec |
| I5  | End is safe to call repeatedly                                                  | `end()` absorbing (existing) + non-re-entrant `endActiveCall` (WI-1.2) + ordered group end (WI-1.6) | registry identity tests                             |
| I6  | UI mount/unmount neither creates nor ends calls (keepAlive contract)            | existing keepAlive + WI-2.4 timer hygiene + WI-1.3                                                  | `callMinimizeRestorePins.test.ts`                   |
| I7  | Background/foreground cannot duplicate calls                                    | existing resume probe (B-58) + WI-3.4 stash dedup                                                   | `callResumeGuard.test.ts`                           |
| I8  | WS reconnect cannot duplicate listeners or calls                                | existing RELAY-C1/P1-12 + WI-5.2/5.3 + WI-3.3 tokens                                                | messenger-core + rejoin-hub tests                   |
| I9  | Push + WS + cold start resolve to ONE incoming call                             | existing cache merge/dedup + WI-4.1/4.2                                                             | `incomingCallCacheMerge` + headless seed tests      |
| I10 | Cleanup is idempotent and complete (no zombie PC/timer/listener/notif)          | WI-1.2/1.6 single-owner + WI-2.4/3.7 timer scoping + WI-4.5/4.9 notif lifecycle                     | per-item tests + §7 device pass                     |

---

## 7. Gates & verification protocol

**Automated (every phase, before commit AND before push):**

```bash
npx jest --selectProjects messenger-crypto        # run TWICE (flake rule B-126/B-153)
npx jest --selectProjects app --testPathPattern "screens/messenger"
npm run typecheck                                  # baseline ≤ 47; release gate reads the PLAIN .tsc-baseline
cd apps/messenger-service && npm test              # for any Phase-6 change
```

Rules that have burned sessions: one red `test:crypto` run is not evidence (moving flake) —
but never dismiss a REPEATED same-test failure as flake; `npx jest --clearCache` before
blaming a commit for `expo/virtual/env` parse errors; tests under
`src/modules/messenger/__tests__/` belong to `messenger-crypto`, NOT `app`; mutation-prove
every new pin RED-first by reverting the fix (and verify the mutation actually applied —
prefer a node script over inline perl); source scans must strip comments and handle CRLF
(`\r?\n`).

**Device matrix (release APK — `console.log` is stripped, key on `[CALLSM]`/`[CALLDIAG]`
warns + native logcat `org.webrtc / WebRTCModule / InCallManager / GCM`):**

Minimum per-phase device passes, drawn from the founder-priority scenarios:

1. Rapid: call→cancel→call again ×5; double-tap Answer/End/mute; call→immediate kill.
2. Answer-from-notification: warm, backgrounded, killed (WI-4.1 target), Answer×2,
   Answer + simultaneous caller cancel, Answer with WS down (offer replay path).
3. Minimize⇄restore ×20 (1:1 and group), lock/unlock mid-call, back-gesture on ring
   (must decline — CALL-07), duration and peer name stable throughout.
4. End-race grid: caller-hangup+answer, cancel+answer, timeout+answer, both-end — each
   must resolve deterministically with exactly one cleanup (`[CALLSM]` log inspect).
5. Second call: 1:1 over 1:1 (banner), group ring over 1:1 (park), answer B after A ends;
   answered-elsewhere collapse on a two-device account (WI-6.1).
6. Network: Wi-Fi⇄mobile mid-call (reconnecting→connected, no second session), airplane
   30 s, WS kill (server restart) mid-call → rejoin/ICE-restart, `call.sync` heal
   (WI-6.6): kill server mid-call, restart, resume app → local call ends ≤ one probe.

Device constraints: BlueStacks pair for signaling races ONLY — **never diagnose group
VIDEO on emulators** (broken camera HAL wedges RN-webrtc's single executor, B-355);
`am force-stop` breaks FCM testability (use real kill/reboot flows on the Pixels); restart
messenger-service after any emulator crash before the next call QA. iOS is out of scope
this pass (PushKit lane is skeleton; B-122 blocked on certs).

**sqa.md contract:** every new bug found while implementing gets an sqa.md entry (claim the
number by pushing FIRST — the header reservation block; beware the historical **B-130
collision**: MESSAGE_LOOP's B-130 is the txnChain deadlock, sqa.md's B-130 is the
notification-answer stall). Every fix ships with its RED-first regression test per the
B-143+ contract.

---

## 8. What NOT to change (measured / rejected — see also §3)

- The eight measured lag dead-ends (shadows/gradients/hooks/bubbles/composer/modal-gating/
  windowSize/runAfterInteractions) — all eliminated by measurement; one made it 2× worse.
- `upgradeToVideo`'s `state === 'connected'` guard — correct; B-389 gated the UI instead.
- The `direct:` alias at `ensureCallGroupKey` — deleting it re-opens B-106.
- Timer-based renewal, `socket.onAny`-driven renewal, boolean in-flight latches — all
  refuted with device evidence (locked-screen behaviour).
- Server-side blame for "ping 2000+/call failed" displays — that number is WS heartbeat
  RTT, not media.
- `setGroupState` split, `runtime.ts` send adoption, `SqlMessageStore.wipe()` wiring,
  outer-`chainOp` drop — MESSAGE_LOOP §10 rejections, all adjacent to the call seam.

---

## 9. Explicitly deferred (do not silently attempt)

| Item                                                                           | Why deferred                                                | Where tracked              |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------- | -------------------------- |
| M4 call-key namespace                                                          | arch-gated cross-device shape                               | MESSAGE_LOOP §10           |
| B-237 epoch-fork heal / master-key redistribution                              | security stop-condition; owner-heal failed in field         | sqa.md B-237               |
| Multi-pod call state (Redis promotion)                                         | single replica today; WI-6.8 documents it                   | this spec                  |
| iOS killed-app calls (PushKit/CallKit)                                         | org App ID + APNs VoIP cert (B-122)                         | sqa.md                     |
| Hold semantics (CA-06), system PiP (CL-03), group Telecom registration (CL-07) | product/feature scale, not race fixes                       | edge-case audit 2026-07-28 |
| B-239 ops half (VoIP token registration + APNs env)                            | ops task, not code                                          | sqa.md B-239               |
| B-461 zOrder overlay fix                                                       | needs a device check first (wrong zOrder = invisible video) | DOCUMENTS pin              |

---

## 10. Deliverables checklist for the implementing session

1. State-machine table landed in code (WI-2.1) + this spec's §1.1/§1.2 updated if reality
   differs.
2. Per-gap outcome table: every WI → fixed / deferred-with-reason, appended to this file.
3. New/extended pins listed in `CLAUDE.md`'s bug-regression table where they guard a
   B-numbered bug.
4. `[CALLSM]` log lane documented (one line in `docs/qa/` log-capture section).
5. §7 device matrix results (per row: PASS/FAIL/not-exercised + why) — honest reporting;
   "not exercised" is acceptable, silence is not.
6. sqa.md entries for every new bug found; runbook sync per the standing rule
   (`docs/planning/BUILD_RUNBOOK.md`).
7. Self-diff review per CLAUDE.md rule 8 (enumerate live consumers of anything deleted or
   re-keyed — the WI-1.1/1.5 signature changes touch ~40 call sites; run the MESSAGE_LOOP
   §5 caller-completeness sweep for each).

---

## 11. DO-NOT-RE-PROPOSE (verbatim carries from prior sessions)

Suppressing the group stamp for device-local ids (AAD mismatch destroys messages) · adding
a `kind` field to the signed group-create (security-gated) · re-keying/remounting RTCView
tiles · `useNativeDriver:true` on the pager · React.memo-ing the tile layer (deferred,
freeze risk) · deleting DOCUMENTS tests · "hardware cryptor" / participantTag-mismatch
theories (refuted) · un-fixing measured lag dead-ends · revocation grace / in-call sweep
exemption · weakening the SFrame gate or any verify.

---

## 12. Repo gotchas that have burned sessions (operational)

- **Push masking**: never `git push | tail` (rejected push reads exit 0); verify with
  `git ls-remote` after every push.
- `release-apk.ps1`: needs `$env:NODE_ENV='production'`; dies under PS5.1 with `2>&1`; an
  aborted run still consumes the version bump.
- Gradle background builds: `GRADLE_OPTS=-Dorg.gradle.workers.max=3` or ninja 0xc0000142.
- `android/` is gitignored — native files need `git add -f`.
- GitHub Actions dead (billing) — deploys are manual SSH tar-overlay
  (`scripts/deploy-staging.sh` pattern); staging can carry uncommitted drift (B-346's
  server fix lived only on the box for two days — always diff the box against git before
  server work).
- Backtick-in-comment inside template literals breaks SQL strings; `@ts-expect-error` in
  prose is a live directive; CRLF kills `\n`-anchored scans.
- sqa.md line numbers rot (~170 rows off in old entries) — anchor on symbols.
- Metro on Wi-Fi is blocked by AP isolation — USB only.
- Device clocks are UTC+6 vs server UTC — normalize before correlating logs.

---

## 13. Phase 1 outcome table — the identity spine (implemented 2026-08-16)

Every Phase-1 work item, what actually landed, and what pins it. Read this before
starting Phase 2: three items changed shape from the spec text, and the reasons are
load-bearing.

| WI     | Outcome | What landed                                                                                                                                                                                                                                                                                                   | Pinned by                                                        |
| ------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| WI-1.1 | FIXED   | `gen` on `ActiveCallState`, minted per `setActiveCall` from a module counter. `CallKey {callId,gen}`; `CallRef = CallKey \| string`. `patchActiveCall(ref,patch)` / `setMinimized(ref,min)` / `endActiveCall(ref,reason,source)`. Mismatch drops + warns. All writers migrated. Adoption inherits the gen.    | `callRegistryIdentity.test.ts` (30 tests) — 6 mutations, all RED |
| WI-1.2 | FIXED   | Slot nulled BEFORE `controller.hangup()` (the mechanism) plus an `endInProgress` latch (the belt, for re-entry via a `notify()` listener). `recentlyEnded` recorded inside `endActiveCall`. Each side effect exactly once. EXTRA: the FGS stop is skipped when a listener claimed the slot during `notify()`. | `callRegistryIdentity.test.ts`                                   |
| WI-1.3 | FIXED   | Adopt-mirror: a null slot consults `controller.currentState` before declaring ended; a foreign callId emits a `[CALLSM]` anomaly, hangs up OUR controller and unregisters, leaving the newer entry untouched.                                                                                                 | `useCall.test.tsx` (app project)                                 |
| WI-1.4 | FIXED   | `CallSignalling.onMediaStateOwned(owner,h)` — replace-by-owner with an identity-guarded disposer. Boot AND adopt both register under `useCall:<callId>`, so N adoptions leave exactly one live handler.                                                                                                       | `callRegistryIdentity.test.ts` (WI-1.4 block)                    |
| WI-1.5 | FIXED   | `patchActiveGroupCall(roomId,patch)` and `setGroupCallMinimized(roomId,min)` keyed; `gen` on `ActiveGroupCallState`. All 30 writers migrated.                                                                                                                                                                 | `groupCallRegistryIdentity.test.ts` (29) — 9 mutations, all RED  |
| WI-1.6 | FIXED   | `ending: true` for the whole leave, under the existing 3 s bound, THEN null + notify. `groupLeaveInFlight()` exposed and awaited by the boot before `sfu.join`. Busy guards updated.                                                                                                                          | `groupCallRegistryIdentity.test.ts` + the reader source-scan     |

### Three deviations from the spec text, and why

**1. `endActiveCall`'s `reason`/`source` are now REQUIRED, not defaulted.** With `ref`
leading the argument list, an un-migrated `endActiveCall('ended')` would have
type-checked as "end the call whose id is the literal string 'ended'" — a silent no-op
that reads as wired. Making both mandatory turns every missed call site into a compile
error, which is what caught the last four writers.

**2. The group room-id rewrite got its own function, `renameActiveGroupCallRoom(from,to)`.**
The spec's `patchActiveGroupCall(roomId, patch)` cannot express it. At `useGroupCall.ts`'s
`room_not_found` re-create, `rid` has ALREADY moved to the new room while the registry
still holds the old one, so `patchActiveGroupCall(rid, {roomId: rid})` is a silent no-op
that strands the entry on the reaped room — and a stranded id makes `leaveInternal` skip
teardown while `launchCall`'s busy guard blocks calls in OTHER conversations with "Call in
progress". A separate call also keeps `patchActiveGroupCall` structurally unable to change
identity, matching the 1:1 rule. `roomIdRef.current` is NOT a usable key there: it is fed
by an effect off `setRoomId` and lags a React commit.

**3. WI-1.3's "keyed-end OUR call" is a controller hangup, not `endActiveCall`.** In the
branch where the registry holds a DIFFERENT callId, running the registry teardown would
stop the shared audio session and the foreground service out from under the call that now
owns them. Our controller is hung up and our signalling unregistered; the newer entry is
not touched.

### The `ending` rule (WI-1.6) — stated once, so new call sites can be checked against it

- **Launch/join side** (anything that would create a competing session): `ending` is
  **BUSY**. The transports are still closing. Applies to `launchCall`'s busy gate (and it
  is excluded from the `rejoiningOwnGroup` escape hatch) and `useGroupCall`'s adopt gate.
- **Everything else** (resume, rejoin, ring presentation, UI): `ending` is **NOT LIVE**.
  It is a corpse, not a call to return to. Applies to `callResumeGuard.hasLiveCall`,
  `groupCallRejoinHub.groupCallIsLive`, `callAudioSession.otherStackHasLiveCall`,
  `MainNavigator`'s ring dedup and its 1:1 waiting banner, `fcmBootstrap`'s W4.2 system-ring
  gate, and `FloatingCallOverlay`'s group bar.

`callAudioSession.otherStackHasLiveCall` is the one that would have bitten silently: the
slot used to be null by the time `stopSharedAudioSession('group')` ran, so counting an
`ending` entry newly REFUSES the 1:1 audio stop for the whole leave window and pins the
device in `MODE_IN_COMMUNICATION` — a CALL-N5 regression that had no test of its own until
this pass.

### The `[CALLSM]` log lane (WI-7.1, started here)

`runtime/callDiag.ts` exports `logCallSm(event, fields)`, which emits one
`console.warn('[CALLSM] ...')` line. `console.warn` survives the release build
(`babel-plugin-transform-remove-console` strips `log` and keeps `warn`), and release is
the only build worth measuring. IDs and enums only — never a name, SDP, media, or key
material (`logAudit.test.ts` scans this directory).

Events so far: `registry.set`, `registry.cleared`, `registry.end`,
`registry.end.reentered`, `registry.end.fgs-skipped`, `registry.{patch,minimize,end}.dropped`
(with `why=stale-key|no-active|no-key`), `adopt.slot-cleared-while-live`,
`adopt.foreign-call-in-slot`, `group.set`, `group.cleared`, `group.rename`, `group.end`,
`group.end.already-ending`, `group.end.slot-taken`, `group.{patch,minimize,rename}.dropped`
(with `why=stale-room|...`).

Volume is bounded per call: a successful write does NOT log — only lifecycle edges and
dropped writes do. Capture with `adb logcat -s ReactNativeJS | grep CALLSM`.

### Not done in Phase 1, by design

- ~~`endActiveGroupCall` is still UNKEYED.~~ **Superseded during review.** It now takes an
  optional `roomId` and returns `GroupEndOutcome`. Review showed the asymmetry was itself
  a defect: an End tap on a stale bubble tore down the call that had taken the slot, and
  a `void` return turned "await the teardown, then navigate" into "navigate now" with the
  call fully live. Only signOut is unkeyed now, documented as "names no room".
- Phase 2's WI-2.4 timer hygiene is untouched EXCEPT where the WI-1.1 signature change
  made it unavoidable: `FloatingCallOverlay`'s `confirmRestored` fallback and
  `CallScreen`'s back / swipe-back minimise are now keyed, which is WI-2.4's own ask for
  those two sites.

### What the review loop changed (3 rounds, 2 independent reviewers)

Phase 1 was NOT correct when the suites first went green. Two P0s survived a green
507-suite run, and one of them was **caused** by this work. Both were found by review, and
one was proved by executing the code rather than by reading it. Recorded here because the
mechanism matters more than the fix.

**P0 — WI-1.6 silently killed the group audio-session and FGS stops on the DOMINANT path.**
`endActiveGroupCall` decided "is the slot still literally ours" after awaiting `leave()`.
But `leave()` IS `useGroupCall.leaveInternal`, whose Fix-#14 tail nulls the registry itself
and has no `await` before it — so on every end `active` was already `null`, which the code
read as "somebody superseded me" and returned early. Measured against the real shape:
`stopSharedAudioSession('group')` **0 calls**, `stopCallForegroundService('group')` **0
calls**, where HEAD ran both unconditionally. That is the CALL-N5 mirror (device pinned in
`MODE_IN_COMMUNICATION`, "no call audio" on the next call) plus B-256 (a permanently
stranded "Bravo Secure call · Hang up" notification) re-opened together, on exactly the
path with no screen mounted to clean up after it: End on the minimized bubble.

The test was green throughout **because its `leave` mock did not null the slot.** That is
the "verify mocks against shipped native source" class from the 2026-08-15 batch, in a new
costume. The suite now has `productionShapedLeave(roomId)` — a leave that nulls the slot
exactly like `leaveInternal` — and the ownership test is `successor.gen !== entry.gen`,
i.e. "did a genuinely NEWER entry claim the slot", never "is it still literally mine".

**P0 — `endActiveCall`'s boolean return was backwards on the local-hangup path.** The slot
is dropped before `controller.hangup()`, so the synchronous `useCall.onState` re-entry
always found it empty, always read "the registry does not own this call", and always ran
its fallback CallKit/cache/notif teardown — while the registry was running the same work
up-stack. Probe output: `reportEnded` twice, `['call-re','remoteEnded']` **then**
`['call-re','declined']`. `callKitBridge.reportEnded` has no dedupe and CallKit is
first-write-wins, so **a user-initiated End was reported to CallKit/Telecom as
REMOTE_ENDED** — wrong iOS Recents glyph, wrong Android call-log row. WI-1.2's "exactly one
CallKit report / cache tombstone" was not met by the first implementation.

Fixed by replacing the boolean with `EndCallOutcome = 'ended' | 'ending' | 'refused'` and
moving the re-entrancy check ABOVE the slot lookup, so "my own teardown is in flight" is
distinguishable from "somebody else's call". The first pin for this was NOT discriminating
— it only covered a REMOTE hangup, where both branches behave identically. The pin that
matters drives a LOCAL end and asserts `reportEnded` exactly once with `'declined'`.

**Other defects the review loop closed:** the group teardown was unkeyed in the same commit
that keyed its 1:1 twin (an End tap on a stale bubble tore down the call that had taken the
slot); a `refused` group end returned `void`, turning "await the teardown, then navigate"
into "navigate now" with the call fully live; ownership comparing `roomId` as well as `gen`
would have read a `renameActiveGroupCallRoom` as a successor and wedged `ending: true`
forever with no recovery short of a restart; the 3 s leave bound leaked its timer on the
winning path (the B-304 flake shape, now that the code logs on those continuations);
`groupKeyRef` was not inherited on adopt, so the generation guard silently degraded to the
id-only test for exactly the instance most likely to overlap a same-room successor; the
adopt-mirror's null-slot branch could report a live state for a call the registry had
forgotten, stranding the screen with an End button that was a keyed no-op.

**One proposed fix was withdrawn after review.** `launchCall` briefly deferred a blocked
launch behind the in-flight leave and retried. That fixes a 3 s "Call in progress" lie by
introducing a worse class: the retry navigates seconds later with no way to cancel, and
neither the CALL-17 latch (1:1 only — the group branch returns before it) nor the group
branch dedups deferred launches, so N taps inside the window would each fire
`ringRecipients` and a navigate. It now just tells the truth ("Ending the previous call —
try again in a moment") and lets the user tap again.

**One reported defect was NOT taken, with reasons.** The adopt-mirror's foreign-slot branch
was flagged for skipping `markRecentlyEnded`. Tracing showed nothing can move the slot from
A to B without `setActiveCall` (which marks the entry it displaces) or `endActiveCall`
(which marks the one it ends), and `patchActiveCall` cannot change identity — so the mark
had always already run. `noteCallEnded` was added anyway so the branch does not depend on
an invariant living in another function, and its comment says "belt" rather than claiming
to close a gap.

---

## 14. Phase 3 outcome table — group rejoin identity + serialization (implemented 2026-08-16)

Every Phase-3 work item, what actually landed, and what pins it. **Four items changed shape
from the spec text, and one instruction in the spec is actively wrong** — read the deviations
below before starting Phase 4. Bug log: `sqa.md` B-469..B-481.

| WI     | Outcome | What landed                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Pinned by                                                                |
| ------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| WI-3.1 | FIXED   | `webrtc/groupCallAttemptGen.ts` — a MODULE-LEVEL, ROOM-KEYED generation (not a `useRef`, see deviation 1). `attemptVerdict` returns `proceed \| superseded \| leaving \| cancelled`; `abortStaleAttempt` routes `superseded` to the release-visible lane and the teardown verdicts to the quiet one. `rejoinRoom(rejoined, attemptGen)` guards every write after every await. The generation is taken in `onJoined` (deviation 2), and the boot holds NONE (deviation 3). | `groupCallAttemptGen.test.ts` (28) + `groupCallRejoinRace.test.ts` (10)  |
| WI-3.2 | FIXED   | A room-keyed in-flight mark (`markAttemptRunning` / `endAttemptRunning` / `runningAttemptGen`) held for the whole rebuild. The 4 s reconcile tick, `consumeMissingAfterRestore` and the early-producer buffer's `isReady` all stand down while it holds. `consumeProducer` gained an `attemptGen` param and PARKS into the buffer for another attempt (deviation 4). The mark EXPIRES rather than latching, and its release is generation-checked.                        | `groupCallRejoinRace.test.ts` + `groupCallAttemptGen.test.ts`            |
| WI-3.3 | FIXED   | `setGroupCallRejoinHandler(token, ws, fn)` / `releaseGroupCallRejoinHandler(token)` with a refusal warn; `clearGroupCallRejoinHandler()` survives as the unconditional logout reset. Takeover raised to `GROUP_REJOIN_CEILING_MS` (90 s) and now logs. EXTRA: `beginGroupCallRejoin()` returns a CLAIM and `endGroupCallRejoin(claim)` refuses a stale one — it was unguarded while its twin was not.                                                                     | `groupCallRejoinHub.test.ts` (22)                                        |
| WI-3.4 | FIXED   | `inFlightConsumes` + `consumedProducerIds` are REQUIRED fields on `LiveSfuHandles` (so a missed stash site is a compile error), adopted on restore, PLUS a backfill deriving "consumed" from the adopted `consumersByPid` that skips CLOSED consumers. The two mechanisms are redundant by design and cover different gaps.                                                                                                                                               | `groupCallRejoinRace.test.ts` (pins the PAIR — see the note in the test) |
| WI-3.5 | PARTIAL | `cancelledRef` resets alongside `settledRef`; the `autoAccept` and `roomMissing` effects gained `roomId` deps; the 45 s fallback moved to its OWN `roomId`-keyed effect. The tone/vibration/ownership effect deliberately stays `[]` — re-keying it caused a silent-ring regression (deviation 5). NA-06's stale binding is left open as B-480.                                                                                                                           | `groupRingScreenReuse.test.ts` (10, source scan)                         |
| WI-3.6 | FIXED   | `onIncoming` returns `boolean \| void`; `ringAlreadySeen` split into `ringRecentlySeen` (read) + `markRingSeen` (write); the mark burns AFTER the handler chain and only on a literal `true`. `MainNavigator` reports `true` at the park site and returns its navigate result at the navigate site; suppressing branches stay silent.                                                                                                                                     | `ringDedupPresented.test.ts` (13, incl. a MainNavigator scan)            |
| WI-3.7 | FIXED   | The `+5 s dumpSelectedPair` re-snapshot and `rebuildVideoConsumer` compare against the room they were armed for; `CallDurationTimer` takes a `roomId` prop and holds its last value rather than painting a successor call's clock.                                                                                                                                                                                                                                        | `groupCallRoomScopedTimers.test.ts` (8, source scan)                     |

### Five deviations from the spec text, and why

**1. The generation is MODULE-LEVEL and ROOM-KEYED, not the `attemptGenRef` the spec asks
for.** `rejoinRoom` is stashed in `liveSfuHandlesByRoom` and ADOPTED by the hook instance
that mounts after a minimize→restore, so the adopted closure reads the ORIGINAL instance's
refs. A restored instance bumping its own ref would be comparing against a counter the
adopted closure never sees — every check would read live or superseded by accident.
`useGroupCall` had already reached this conclusion for the rejoin in-flight guard, which is
why that lives in `groupCallRejoinHub` and not in a ref.

**2. The generation is taken inside `onJoined`, not when the reconnect handler fires — AND
the ack must still hold the hub claim.** The obvious placement — bump on entry, so the
`.then(outcome === 'failed')` branch can share the number — is wrong: a rejoin that never
reaches `onJoined` (the server refuses the join, the state is no longer joinable, the socket
dies again first) would still have superseded everything else, which is what stranded the
budget timer. The handler holds `let attemptGen: number | null` and the failure branch falls
back to the ORIGINAL teardown guards when no rebuild ever started.

But minting on ack arrival orders generations by ACK, not by attempt start, and that is only
safe while attempts are serialised — which the 90 s stuck-claim takeover exists precisely to
break, on the explicit premise that the first attempt's ack can arrive LATE. Without a second
check the ABANDONED attempt's late ack mints the HIGHER generation and tears down the
transports its replacement just built: the exact interleaving the generation exists to
prevent, on the one path where two attempts are guaranteed to overlap. So `onJoined` refuses
when `rejoinClaim !== currentGroupCallRejoinClaim()` before minting. Both halves are needed;
each alone is a defect.

**3. THE SPEC IS WRONG ABOUT BUMPING "AT BOOT". Do not re-add it.** It produced a P0 and a
P1, both found independently by two reviewers (`sqa.md` B-476):

- the generation is minted against the room known at step 1, and the B-08 `room_not_found`
  re-create RE-POINTS `rid` at a freshly minted room without re-minting it — so the boot's
  own terminal guard compared a generation from the reaped room against a room with no
  counter, read `superseded`, and returned. The second person to tap Call got a
  fully-connected call behind a screen stuck on "Connecting…", with the BS-LEAK stash and
  `setActiveGroupCall` skipped and the whole mediasoup pipeline leaked;
- the boot's generation never moves, so guarding `onBudgetExpiry` with it made the guard
  permanently true after the first rejoin of a call's life — silently retiring B-108's
  documented contract that the budget is "the only terminal authority", and leaving a call
  whose ICE later died stuck in `reconnecting` forever.

The boot now holds no generation. It protected nothing anyway: no `await` separates
`rejoinRoomRef.current = rejoinRoom` from the terminal `setState`, so no rejoin can
interleave there. `onBudgetExpiry` instead asks "is a rebuild running RIGHT NOW?"
(`isAttemptRunning`), which hands authority back the moment the rebuild finishes, and it
RE-ARMS rather than returning so the foreground probe cannot be left re-arming a dead
deadline.

**4. The rebuild guard compares GENERATIONS, not a boolean, because the rejoin re-consumes
through the same funnel.** `rejoinRoom` calls `consumeProducer` for every entry in
`rejoined.existingProducers`, so a guard phrased as "stand down whenever a rejoin is
running" makes the rejoin stand down from its own work and rebuild a room with no remote
tiles in it — every peer black and silent, permanently, with the reconcile backstop also
standing down. Hence `runningAttemptGen(roomId)` rather than `isAttemptRunning` at that one
site. Mutation testing found this; neither reviewer did.

**5. WI-3.5's "re-key the timer effect on `roomId`" must NOT be applied to the whole ring
effect.** Doing so also re-runs the tone lifecycle, and that loses a race: React runs the
cleanup before the re-run, `stopRingtone()` synchronously puts the tone slot into
`'stopping'`, and the new run's `bindInAppRingOwnership` calls `startRingtone()`
synchronously inside bind — which refuses because the slot is not `'idle'`. Ring #2
vibrated in silence. Only the 45 s fallback is re-keyed; the tone effect stays `[]`. The
cost is that NA-06's ownership binding still holds ring #1's roomId (B-480), which needs the
tone slot to grow a restart-safe transition before it can be fixed.

### What the review loop found that the implementation did not

Three rounds with a critical reviewer and an edge-case reviewer. Both found the same two
top defects independently, which is the strongest signal in the whole exercise. Worth
recording, because none of them was reachable by any test that existed:

- **Two P0/P1s came from following the spec text literally** (see deviation 3 above). The
  boot generation broke the `room_not_found` re-create and silently retired B-108.
- **One P1 came from the FIX for those** — minting the generation on ack arrival inverted
  the ordering after a takeover (deviation 2). A fix that introduces a defect one layer out
  is the recurring shape in this codebase, which is why both reviewers were re-run against
  the fixes rather than only against the original diff.
- **Three pre-existing defects surfaced only because Phase 3 made them load-bearing:**
  `withTrackBlanked` could permanently disable the mic when two rejoins nested (its
  `wasEnabled` capture is per-call, so the inner one records "was off" and declines to
  restore); `consumeProducer`'s `finally` deleted from a set the rejoin had since replaced,
  switching the Fix-#12 in-flight dedup off; and `consumeMissingAfterRestore` guarded only
  on entry while its `sfu.producers` await is a full WS round-trip wide.
- **Mutation testing found what neither reviewer did:** a boolean "stand down while a rejoin
  runs" guard makes the rejoin stand down from its own re-consume (deviation 4).

Five findings were confirmed and deliberately NOT fixed — each needs a change outside this
phase. They are logged as `sqa.md` B-477..B-481, and B-478 carries a `DOCUMENTS` test
pinning the current broken behaviour per the CLAUDE.md bug-regression contract.

### Two constants, not one

`GROUP_REJOIN_CEILING_MS` (90 s) and `GROUP_REBUILD_MARK_CEILING_MS` (30 s) look like they
should be the same number and must not be. The hub's takeover wants a LONG window —
abandoning a healthy 4-peer rejoin and restarting it is pure waste, which is why it went
30 s → 90 s. The rebuild mark wants a SHORT one — while it is held the tile-reconcile
backstop is blind, so a wedged rejoin at 90 s leaves a peer who turned their camera on with
no tile for a minute and a half. Sharing one constant traded one bug for another.

### Verification actually performed

- `messenger-crypto`: **515 suites, all green** — full clean runs observed repeatedly through
  the phase (6234 tests, then 6246 as pins were added), including two consecutive clean runs
  after review round 1.
- `app` project, `screens/messenger`: 42 suites / 574 tests green.
- `npm run typecheck`: **44** (baseline 47).
- Lint: 0 errors on every touched file.
- **53 mutations across the phase and its three review rounds, all RED**, each verified
  applied on disk first. Survivors were real test weaknesses and were fixed rather than
  argued away: a WI-3.4 assertion that passed with BOTH mechanisms removed (the tile-clearing
  setup was being undone by the still-mounted instance), a missing suite for the
  rejoin-lifecycle API, and source scans whose windows were wide enough to match straight
  through the mutation.

**On the suite flake — read this before trusting a red run.** `messenger-crypto` fails
intermittently with a MOVING test name across completely unrelated suites
(`productionRuntimeGroupSend`, `blockedPeers`, the MD-08 free-space suites, `backupFlags`,
`stopSharedAudioSession`, `batteryOptimization` were all seen). Every one passes in isolation,
repeatedly. This is B-126 / B-153. Two things learned this session worth carrying forward:
clearing the Jest cache does **not** fix it, so the stale-transform-cache theory recorded
earlier is at best incomplete; and the affected suites share a shape — module-level persisted
stores — which points at cross-worker state rather than at compilation. **One red run is not
evidence.** Re-run, and if the failing test name moves, it is the flake.

### NOT device-verified

Nothing in Phase 1, 2 or 3 has been exercised on hardware. The §7 matrix rows that matter
most for this phase: minimize⇄restore during a WS bounce, two group rings back-to-back on
one mounted ring screen, and a ring arriving during a backup restore.

---

## 15. Phase 3 follow-ups CLOSED (2026-08-17)

All seven findings §14 recorded as deferred (`sqa.md` B-477..B-483) are fixed, plus one
discovered while fixing them (B-484). Full write-ups are in `sqa.md`; this is the index and
the two design notes worth carrying into Phase 4.

| Finding | Landed                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B-477   | The stash gained a change signal. `rejoinRoom` republishes and then calls `notifyLiveSfuHandles(rid)`; every mounted hook for the room re-adopts through one shared `adoptLiveHandles`. Closes the adopted-closure ref drift AND the Set-replacement exception, which were a pair.                                                                                                                            |
| B-478   | Both parked-ring consume sites keep the resolver's verdict and re-park on refusal. The DOCUMENTS pin was inverted into a fix assertion.                                                                                                                                                                                                                                                                       |
| B-479   | `restoreMode` gained `subscribeRestoreMode`; MainNavigator parks the ring instead of dropping it and re-presents on restore exit. **Server half also done (2026-08-17):** the gateway no longer clears a queued ring on emit — it marks the frame `replayed` and waits for the client's `sfu.ring.ack`, so a replay the client could not take is re-offered on the next reconnect instead of being destroyed. |
| B-480   | `bravoTones` queues a start that arrives mid-teardown; the group ring screen's tone effect is re-keyed per ring.                                                                                                                                                                                                                                                                                              |
| B-481   | An unconsumed park expiry re-arms the room's dedup markers via a new `clearGroupRingDedup`. A CONSUMED park deliberately does not.                                                                                                                                                                                                                                                                            |
| B-482   | `attemptConsume` returns the consumer id; the consumed mark is gated on that consumer still being live.                                                                                                                                                                                                                                                                                                       |
| B-483   | `onTxState` takes its source transport (required param) and drops events from a superseded one.                                                                                                                                                                                                                                                                                                               |
| B-484   | NEW — `startSlot`'s load-race guard restores `'idle'` and drains the queue. It never did, so a stop landing in the load window left the tone slot bricked for the whole process.                                                                                                                                                                                                                              |

### Two notes for Phase 4

**1. "Deferred because it needs a change outside this phase" was right about the shape and
wrong about the cost.** Five of the seven were one-to-three lines once the enabling mechanism
existed. What actually blocked them was a MISSING SEAM, not scope: B-477 needed the stash to
be able to say "I changed", B-479 needed the restore flag to be able to say "I'm done", and
B-480 needed the tone slot to tolerate a restart. Each seam is a handful of lines and unblocks
its finding immediately. When a finding is deferred, name the seam it is waiting on.

**2. B-484 is the shape to look for next.** It is a state machine whose async tail can exit a
transitional state WITHOUT restoring a terminal one, on a branch that another function
deliberately delegates to it. `stopSlot` returns early from `'starting'` on the explicit
premise that "the start handler will unload the sound when it resolves" — and the start
handler did unload, but never wrote the state back. The two halves were individually
reasonable and jointly a permanent brick. The same question is worth asking of every
delegated-teardown pair in the call stack: **if A hands cleanup to B, does B restore the state
A left behind on EVERY exit path, including its early ones?**

---

## 16. Phase 2 outcome table — the 1:1 state machine (implemented 2026-08-16, written up 2026-08-17)

Phase 2 shipped between Phases 1 and 3 and was the only part of the campaign without an
outcome section. Bug log: `sqa.md` B-485..B-489.

| WI     | Outcome | What landed                                                                                                                                                                                                                                           | Pinned by                          |
| ------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| WI-2.1 | FIXED   | `LEGAL_TRANSITIONS` in `callController.ts`, enforced in `setState`. Terminal absorption is a separate branch ABOVE the table; a self-transition short-circuits. A refused move leaves the state UNCHANGED and warns with the source site.             | `callStateMachine.test.ts`         |
| WI-2.2 | FIXED   | All twelve `setState` call sites labelled with a `src`, so `[CALLSM] illegal a→b src=x` names the culprit rather than the symptom.                                                                                                                    | `callStateMachine.test.ts`         |
| WI-2.3 | FIXED   | `webrtc/callDeadlines.ts` — eleven call deadlines in one Tier-A pure module, with the ORDERING relationships asserted (a delivery watchdog that outlives its send budget, a TURN ceiling under the connecting watchdog, …) plus an anti-drift scan.   | `callDeadlines.test.ts`            |
| WI-2.4 | FIXED   | CallScreen timer ownership: every deferred callback captures its callId at ARM time and re-checks the registry when it fires. The unmount sweep clears the two timers that must not outlive the screen; the route re-apply is exempt and self-guards. | `callScreenTimerOwnership.test.ts` |
| WI-2.5 | FIXED   | (a) `claimForOneCall` — a controller instance serves exactly one callId, ever. (b) Offer-replay accept re-assert, verified before it fires, re-checked after the verify, latched only on a handler that actually navigated.                           | `callOfferReplayReassert.test.ts`  |

### Three deviations from the spec text, and why

**1. The spec's draft transition table was WRONG about `connected → connecting`.** It listed
the transition as legal. Writing the table down and then tracing what the code actually did
showed it firing on the dominant outgoing path and re-arming the 20 s connecting watchdog
against an already-healthy call, which then killed it (`sqa.md` B-485). The table must be
derived from the machine's real shape, not adopted from the spec.

**2. `ringing → connected` had to be ADDED.** The draft assumed the callee has no
PeerConnection before `'connecting'`. It does — `acceptInner` builds it — so a fast ICE
completion can land `'connected'` straight out of `'ringing'`. The edge-case reviewer traced
this; the original table would have refused a legitimate transition on a working call.

**3. `handleIncomingOffer` answers `busy` for a different callId — it does NOT throw.** An
early draft of the test asserted a throw. B-320 / call-waiting requires the busy answer, and
the same-callId carve-out has to sit ABOVE the busy bounce so an offer REPLAY for the call in
progress is not busied against itself.

### The trap this phase is a standing reminder of

`end()`'s reset block looks redundant and is not: it carries B-273's `outboundSignalled` reset,
P1-BR-6's `dtlsVerified` reset, and a load-bearing unsub-before-`setState` ordering. It was
deliberately kept. Removing "dead" resets in this file has a history.

### NOT device-verified

Phase 2 is in the same position as Phases 1 and 3: fully test-verified, never exercised on
hardware. Its §7 rows that matter most are answer-from-notification (warm / backgrounded /
killed, Answer ×2, Answer + simultaneous cancel) and minimize⇄restore ×20 with a back-gesture
decline on the ring.

---

## 17. Phase 4 outcome table — notification & background delivery (implemented 2026-08-17)

Bug log: `sqa.md` B-490..B-503. The central invariant — **WS + FCM + Telecom + Notifee +
cold start → ONE logical incoming call** — now holds in both directions: no call presents
twice, and no real call presents zero times.

| WI      | Outcome | What landed                                                                                                                                                                                                                                                                                                     | Pinned by                                        |
| ------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| WI-4.1  | FIXED   | The headless voip-wake lane mirrors the warm lane's exact order: verify → restore gate → busy gate → cache seed (merge) → tombstone refusal skips ALL presentation → Telecom → card. Headless cancel is a full teardown. No runtime boot — leaf modules only.                                                   | `fcmHeadlessCallSeed.test.ts`                    |
| WI-4.2  | FIXED   | ONE `notifee.onBackgroundEvent` registration, owned by `callNotification`; the rich handler is a DELEGATE (`setNotifeeBgHandlerDelegate`), slim behaviour serves until it arrives. Evaluation order was verified first: slim owned the whole pre-login window, rich displaced it post-login by last-write-wins. | `notifeeBgSingleOwner.test.ts`                   |
| WI-4.3  | FIXED   | The two 20 s nav-wait abandons release ONLY the navigate dedupes (`releaseAcceptDedupe`); the Answer INTENT (`explicitAcceptIds`) survives for the Telecom/offer-replay follow-ups. Terminal lanes still clear everything.                                                                                      | `answerIntentSurvival.test.ts`                   |
| WI-4.4  | FIXED   | Body taps own a separate dedupe (`bodyTapNavIds`); only the Answer branch consults/burns the answer dedupe; `autoAccept = isAnswerAction \|\| wasCallExplicitlyAccepted(callId)` so an FSI body press after the Answer re-asserts instead of un-answering.                                                      | `answerIntentSurvival`, `pushNavigateParamSweep` |
| WI-4.5  | FIXED   | Group answer/end/decline clean card + native ringtone + payload + latch. `endActiveGroupCall` cleans at the single owner point (after the three refusals, before the gate — WI-1.6 ordering untouched); a refused end touches nothing.                                                                          | `groupRingCleanup.test.ts`                       |
| WI-4.6  | FIXED   | All three `IncomingGroupCallScreen` navigate sites re-assert `autoAccept` from the latch — bounded to ONE ring window (`wasCallExplicitlyAcceptedWithin(roomId, RING_TIMEOUT_MS)`), because group roomIds are reused.                                                                                           | `groupRingCleanup`, `pushNavigateParamSweep`     |
| WI-4.7  | FIXED   | `accept()` consults `isIncomingCallDead` after the B-319 bail, BEFORE the CallKit bridge calls; refusal returns `false` and the watchdog's own probe goes terminal within a tick.                                                                                                                               | `acceptTombstoneGate.test.ts`                    |
| WI-4.8  | FIXED   | TTLs promoted to `callDeadlines` with ordering asserted (payload 90 s > ring 45 s + nav wait 20 s; tombstone 120 s > payload); gc exempts the LIVE call's entry; `onEnd` never declines while the Answer intent is in-flight (age-bounded to `NAV_READY_WAIT_MS + TURN_FETCH_CEILING_MS`).                      | `incomingPayloadLifetime`, `callDeadlines`       |
| WI-4.9  | FIXED   | Missed banners die on thread-open, call-back, re-ring (all card lanes via the funnel + both WS navigate sites) and a 24 h sweep age-out. Conversation identity wins over ringer identity when both sides carry one.                                                                                             | `missedCallLifecycle.test.ts`                    |
| WI-4.10 | FIXED   | The foreground 1:1 rescue — HMAC-verified (real `selfUserId`, stronger than the headless lane's), gated in the bg lane's order, deduped by route/registry/tombstone/card-id.                                                                                                                                    | `fcmForeground1to1Rescue.test.ts`                |

### Deviations from the spec text, and why

**1. WI-4.2's premise was half wrong and the fix is a delegate, not a re-ordering.** The
spec said "verify actual evaluation order before final implementation" — done, and the
order was already deterministic (notifee holds ONE bg-handler slot; last write wins; the
rich handler displaced the slim one post-login). The defect was that the displacement was
an undocumented accident spread across two files. The fix gives `callNotification` the
single registration and makes the rich handler an explicit delegate — ownership is a
module contract, not a race.

**2. WI-4.5's "tombstone" item is deliberately NOT satisfied at group END.** Tombstoning
the roomId at END made a member who left a live group call unreachable on the FCM lane —
the only lane a killed app has — for the whole tombstone TTL, because the gateway reuses
roomIds across fan-outs (B-334/B-336 Add-member). Both reviewers independently flagged it
(sqa B-502). END drops the payload without a tombstone and marks `consumedGroupRooms`
instead (self-healed by any fresh seed); decline/cancel still tombstone, and their
tombstones are per-RING (the B-336 `ringId`), so a genuine re-ring supersedes them —
including tombstones with NO captured identity (the WS/foreground lanes never seed the
cache, so their clears cannot record one; a ringId-carrying GROUP seed on such an id is a
different fan-out by construction; the kind gate keeps 1:1 tombstones structurally
un-supersedable, since ringId rides unsigned).

**3. WI-4.8's "prevent Telecom onEnd from declining a valid answer" is an age-bounded
no-op, not a teardown.** A real user End and the spurious system ring-teardown End are
indistinguishable at that event; acting on it tombstones the call and the WI-4.7 gate
then kills the accept the user just made (the B-109 regression through a new door).
Inside the plausible accept-in-flight window (26 s) the End is swallowed — one ignored
press, the in-app End works a second later. Past the window it declines exactly as at
HEAD.

### DO NOT RE-ADD / RE-PROPOSE (Phase 4 additions)

| Idea                                                                         | Why it is wrong                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tombstone the roomId in `endActiveGroupCall`                                 | Reused group roomIds → the FCM lane refuses the re-invite's card for the whole TTL; killed-app member is silently unreachable (B-502). It is now blocked TWICE over (the stale-card gate would also eat the Answer). |
| Write `recentlyEnded` (`noteCallEnded`) from the group teardown              | Same regression one layer out: the stale-card gate reads `wasRecentlyEnded`, so a legitimate re-invite's Answer tap would be dropped for 120 s. The consumed-room marker + seed self-heal is the correct shape.      |
| Make the `onEnd` answered-branch tear down (reportEnded + tombstone)         | Kills the accept the user just made when the End is the system's own ring teardown — the B-109 class. The branch is age-bounded instead.                                                                             |
| A registry-liveness check in the notifee stale-card gate                     | An on-screen accept of a WS-delivered re-ring is legitimate while the same roomId carries an older decline's tombstone; that flow never passes the notifee handler, so the gate must stay card-scoped.               |
| `await` the missed-banner dismiss BEFORE the card in `showIncomingCallNotif` | A Doze-budgeted killed-app wake pays a bridge round-trip before ringing. It runs after card + ringtone.                                                                                                              |

### Known-open (recorded, not fixed here)

- ~~The group FOREGROUND re-dispatch (AC-3) presents without HMAC verification~~ —
  **FIXED same day as B-504**: one verification gate at the top of the onMessage
  voip-wake branch covers both kinds; the 1:1 rescue's inner verify removed as
  redundant; a throwing verifier fails closed.
- **The moving crypto flake** reproduced repeatedly during review — `attachmentUriPipeline`
  (half-mocked free-space probe) and `callAudioSessionArbitration` (virtual doMock +
  resetModules, dual-specifier registry resolution). Both pass isolated every time; one
  ticket for both.
- The nav-abandon path leaves no user-visible surface (card dismissed at handler entry,
  Telecom connection un-ended until the caller's cancel) — the INTENT survives and both
  follow-ups work; re-presenting a surface on abandon is future work.

### NOT device-verified

Same standing position as Phases 1–3. The §7 rows this phase most needs: killed-app
Answer (cold launch), body-tap-then-Answer, Telecom End during answer, group
leave→re-invite (both lanes, inside 120 s), decline→re-ring (killed), missed-banner
lifecycle.

---

## 18. Phase 5 outcome table — transport (implemented 2026-08-17)

Bug log: `sqa.md` B-546..B-553. Transport stayed a SINGLE source of truth
(`packages/messenger-core`; the `src/modules/messenger/transport/*` tombstone and
`deadForkLock` untouched), and the preserve-list held: `connectGeneration`,
teardown-before-reopen (RELAY-C1), the owner epoch, the call-frame exemption, and every
pre-existing wall-clock guard.

| WI     | Outcome | What landed                                                                                                                                                                                                                                                                                                                                                               | Pinned by                                                    |
| ------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| WI-5.1 | FIXED   | `handleAuthReject` OWNS the in-flight-refresh reject (benign `'reconnecting'`, drop the socket, return true), wall-clock bounded by `UNAUTH_REFRESH_STUCK_MS` so a hung refresh falls through to a fresh counted attempt. The RN DOCUMENTS pin flipped per its own WHEN-FIXED note.                                                                                       | `transportClientSocketIo` (flipped), `transportCloseHygiene` |
| WI-5.2 | FIXED   | `close()` clears `frameListeners`, `reconnectListeners`, `hasConnectedOnce`, and armed `onceConnected` one-shots — a revived corpse carries nothing of the previous session.                                                                                                                                                                                              | `transportCloseHygiene`                                      |
| WI-5.3 | FIXED   | `CallSignalling.liveTransport()` (lazy registry resolve, constructor fallback); the rejoin hub follows `onTransport` re-binds AND arms `onceConnected` on each fresh client (a first connect is not a reconnect — B-05); refused up-edge fires retry on claim release; `useGroupCall` closures live-resolve + the ref follows the registry.                               | `transportSwapFollows`                                       |
| WI-5.4 | FIXED   | `sendCallControlDurable` — ANY send failure (null transport or thrown send) lands the durable decline; the headless notifee sites AWAIT the enqueue (notifee kills the task when the handler settles); `'failed'`/non-declined reasons never masquerade as declines.                                                                                                      | `pushDeclineDurability`                                      |
| WI-5.5 | FIXED   | Per-callId inbound chain: the offer's verify (deadline-raced, fail-closed) heads it; later frames for the SAME callId run in wire order at PROCESS-time lookups; wire-time TTL stamps; a mid-verify registration takes the ingest+re-assert lane, never a second full present.                                                                                            | `callFrameInboundOrder`                                      |
| WI-5.6 | FIXED   | Failed trickle sends buffer per-callId (drop-oldest at 64), one drainer on the per-callId queue under a SINGLE `ICE_WAIT_OPEN_MS` deadline; the immediate path stays first; hangup is never delayed (cancel bail).                                                                                                                                                        | `iceOutboundBuffer`                                          |
| WI-5.7 | FIXED   | `clearCallDispatchTransients` (queues + signalling + chains + re-assert latch; `dispatchEpoch` bump kills in-flight chain WORK) on every `disposeLiveRuntime`; PRESERVES `onIncoming`, the offer verifier, and the LIVE call's registration; `forceReconnect` publicly floored while not connected (internal recovery unfloored via `reopenNow`, floor reset on connect). | `dispatcherDisposeHygiene`, `transportCloseHygiene`          |

### Deviations and adjudications

**1. WI-5.1's benign fallback lives INSIDE `handleAuthReject`, not at the caller.** An
existing pin asserts the no-refresh-hook case stays terminal `'unauthorized'`; owning the
in-flight case inside the shared helper fixes both callers without touching that
contract, and `false` now means exactly one thing.

**2. WI-5.7 preserves three things a naive clear would destroy.** `onIncoming` and the
offer verifier are MainNavigator-owned (`[user?.id]` effects — never re-installed on a
mid-session rebuild): clearing the handler kills incoming calls after every restore;
clearing the verifier downgrades offers to the UNVERIFIED legacy fallback in the
dispose→rebuild gap. And the LIVE registry call's registration + queued frames survive —
a minimized call's owner deliberately skips its unregister, so the entry has exactly the
same "nobody re-installs it" property. signOut still clears everything (it ends the
active call first, synchronously).

**3. The cross-session-socket residual is documented, not epoch-gated.** Refusing the
registry substitute on an owner-epoch mismatch would defeat WI-5.3 outright — the
substitution exists FOR the post-rebuild epoch change. The correct discriminator would be
a session/user identity on the transport, which `TransportClient` does not carry today;
the live guards are signOut ending calls + navigation reset cancelling setup before
dispose. Recorded as "no session identity on the substitute".

**4. One review finding was closed by DELETING code.** The suggested post-cancel ICE gate
was redundant under mutation (the drain's `cancelledCalls` bail owns the pre-drain
window; post-drain, no marker exists for ANY gate at that site) — removed together with
its decorative test, residual documented.

### DO NOT RE-ADD / RE-PROPOSE (Phase 5 additions)

| Idea                                                                            | Why it is wrong                                                                                                                                                                 |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Floor the INTERNAL reconnect paths (ladder / notifyNetworkChange / SEC-1)       | The B-14 ladder's retry is only re-armed by connection events — flooring it strands the transport in `'reconnecting'` with no recovery. Only the public surface is floored.     |
| A bare-boolean in-flight guard anywhere in the reject/refresh lanes             | The file's own REAUTH_STUCK_MS comment is the law: an ack/refresh lost while locked never settles, and a latched flag becomes a permanent invisible strand. Wall-clock, always. |
| Clearing `onIncoming`/verifier/live-call registration in the dispose-path clear | Kills incoming calls after every restore / downgrades offers to unverified / deafens minimized calls. The signOut lane is where full clears belong.                             |
| Clearing chain MAPS without an epoch bump                                       | Scheduled chain WORK survives the map clear and re-populates session state (edge-reproduced). The epoch fence is load-bearing, including the post-await re-check.               |
| Epoch-gating `liveTransport()`'s registry substitute                            | The substitute exists FOR the epoch change (same-user rebuild survival). See adjudication 3.                                                                                    |
| Alias-mapped mutant harnesses (`moduleNameMapper` on `@/...`)                   | babel `module-resolver` rewrites the alias BEFORE jest's mapper — every mutant runs pristine code and reports GREEN. Resolve mutants by direct require/copy.                    |

### Known-open (recorded, not fixed here)

- **No session identity on the transport substitute** (adjudication 3).
- `reopenNow` on the immediate-reopen path resets the unauthorized-refresh budget, so
  "exactly one refresh" can become two under a live call — pre-existing, bounded by the
  cap (critic round-2 note R2-4 / scenario-4 caveat).
- A stale-flag takeover re-stamps the refresh clock while the old refresh is pending —
  one extra counted attempt, bounded by `MAX_UNAUTH_REFRESH`.
- The moving crypto flake gained nothing new; the four NAMED suites carry it
  (`attachmentUriPipeline`, `callAudioSessionArbitration`, `backupFlags`,
  `productionRuntimeGroupSend`) — one ticket recommended since Phase 4.

### NOT device-verified

Same standing position as Phases 1–4. Highest-value §7 rows for this phase:
token-revoked double-reject during a live call; a 1–3 s WS blip during setup; restore
rebuild with a minimized 1:1 AND a minimized group call; account switch mid-ring.

---

## 19. Phase 6 outcome table — server (implemented 2026-08-18)

Bug log: `sqa.md` B-554..B-565. Three adversarial rounds (CRITIC attack list +
EDGE simulation list per the phase mandate) to dual sign-off — round 3 caught
B-565 inside the round-2 hardening itself. WI-6.8 was deliberately NOT built.

| WI     | Outcome               | What landed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Pinned by                                                                          |
| ------ | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| WI-6.1 | FIXED                 | First answer wins, system-wide: `answeredBy` recorded synchronously before the first await; later answers idempotent-dropped AND given a DIRECTED `call.hangup{'ended'}` on their own socket (round 2 — the push-cancel alone provably never reached the loser); both artifact lanes cleared; ONE answered-elsewhere cancel push; the client preserves the winner (latch + past-ring registry states) while actively collapsing a bare in-app ring (keyed teardown, `missed!=='1'`-scoped).                                                                                                         | `messenger.gateway.answer-arbitration.spec`, `groupRingCancelIdentity` guard scans |
| WI-6.2 | FIXED                 | WS group decline = HTTP decline: clear + other-device cancel push after the BYTE-IDENTICAL C2 gate (verified vs git HEAD — zero hunks in `verifySfuRingAuthority`, gate order unchanged); the HTTP group branch gained the cancel push its own 1:1 branch always had.                                                                                                                                                                                                                                                                                                                               | ring-lifecycle spec                                                                |
| WI-6.3 | FIXED                 | Both artifact clears are ONE MULTI with per-command inspection (`[CALL]`/`[SFU]` partial-failure warns); keep-marker keeps marker+index (P1-15); rejected exec stays silent by design (leaves all artifacts → replay, never a false missed).                                                                                                                                                                                                                                                                                                                                                        | ring-lifecycle + calls-spec settle/keepMarker assertions                           |
| WI-6.4 | FIXED                 | `pendingJoins` reservation before the awaited transport creation; cap + host election count reservations (checks and reserve in one synchronous stretch); rollback frees the slot and hands a claimed host to `firstUserOf`; `endRoomIfEmptyByHost`/zombie sweep treat reservations as occupancy; SFU-05 ordering untouched.                                                                                                                                                                                                                                                                        | join-cap spec concurrent describe                                                  |
| WI-6.5 | FIXED                 | Pair/recipient budgets TIME-BUCKETED (60 s windows) — a lost EXPIRE stops mattering next window (un-brickable by construction); hygiene EXPIRE ×2-window + INCRs in one MULTI; per-call dedup key INCR+EXPIRE one MULTI (leak closed).                                                                                                                                                                                                                                                                                                                                                              | push spec WI-6.5 describe                                                          |
| WI-6.6 | FIXED                 | `call.sync {callId}` → ack `{ok, state}`; non-participant ≡ nonexistent = `unknown` (no oracle); rate bucket + `WS_PAYLOAD_SPECS` entry (the AUDIT #16 gate caught the omission). Client `runCallSyncProbe`: keyed hard-end on `ended`/`unknown` only, keep-on-error, post-await `{callId, gen}` re-check; wired at the `connected` branch (hasLiveCall-gated) + the resume probe branch. Round 2 (B-566 KO-1): a session miss consults the ASKER'S own durable rescue lanes before answering `unknown`; (§20 round-2 arch P3-6): an outbound unanswered ring is exempt from the `unknown` verdict. | ring-lifecycle, `callSyncProbe.test` (unit + wiring scans)                         |
| WI-6.7 | FIXED                 | ringId end-to-end: ring ack returns it; cancel frame/push/scoped artifact clear carry it; the missed marker stores it; every client consumer (screen, park, dedup re-arm, both push lanes) matches ring identity with room-wide fallback. Round 2: the host cancel names a ring ONLY for single-fan-out calls (`mintedRingIdsRef` — a cancel-all with disjoint fan-outs must be unscoped).                                                                                                                                                                                                          | ring-lifecycle, `groupRingCancelIdentity`                                          |
| WI-6.8 | DEFERRED (as specced) | NOT built. Single-replica constraint documented in `docs/architecture/CALL_STATE_SCALING.md` (new: per-pod state inventory, sticky-session vs Redis-promotion vs hybrid); enforcement already exceeds the "startup warning" ask — `replica-guard.service.ts` refuses to boot a competing replica (`REPLICA_GUARD=off` = the logged warning form).                                                                                                                                                                                                                                                   | replica-guard spec (existing)                                                      |

### Round-2 deltas (all mutation-proven)

1. **Directed loser verdict** — the duplicate-answer drop emits
   `call.hangup{'ended'}` on the answering socket only (`client.emit`; the
   deviceRoom is shared under signalDeviceId=1, a room emit would kill the
   winner). Loser path traced end-to-end by the critic: inbound hangup →
   silent `end()` → registry re-entry no-ops — no echo.
2. **Guard narrowing + keyed ring collapse** — the client cancel guard no
   longer shields bare `'ringing'`; `handleCallCancel` ends a registry-mounted
   ring through the keyed teardown (`missed!=='1'`-scoped).
3. **Rate buckets** on `sfu.ring.decline`/`sfu.ring.cancel` (new push-sending
   frames; a 30-min ring token was an unmetered push cannon).
4. **Per-ring screen keys** — the settle latch and the 45 s clock re-key on
   `[roomId, ringId]` (the B-473 pin in `groupRingScreenReuse` widened
   accordingly).
5. **`mintedRingIdsRef`** — cancel-all never names one fan-out of several.
6. **`endSilently` (advisory, both reviewers converged on the seam; RE-KEYED
   round 3 — B-565)** — an end acting on a verdict the far side already
   issued suppresses the wire hangup (`callController.endSilently`:
   ringState.cancel + silent end, no onMissedCall), keyed on the EXPLICIT
   `endActiveCall(..., {silentWire: true})` opt-in. Round 2 keyed it on
   `source==='remote'` and the critic's round-3 caller sweep proved that
   field glyph-coupled: three semantically-local live-call ends
   (Telecom/system-UI End, logout) carry 'remote' for the CallKit glyph while
   RELYING on the wire hangup — key-on-source removed the peer's only
   "Call ended" at all three. Opt-in population: exactly the ring collapse +
   the call.sync verdict; pinned by the inverse glyph-class contract test AND
   a per-file population scan.

### DO NOT RE-ADD / RE-PROPOSE (Phase 6 additions)

| Idea                                                                              | Why it is wrong                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Fan the answered-elsewhere collapse over the deviceRoom (or any WS room)          | Every device of a user shares deviceRoom (signalDeviceId=1) — the winner receives its own kill. The collapse is a DIRECTED emit on the losing socket + the push lane.                                                                                        |
| Shield `'ringing'` in the client cancel guard                                     | A ring surface is exactly what a cancel collapses; shielding it re-creates the 45 s ghost ring whose expiry hangup is AUTHORIZED against the live session (B-561). The accept window belongs to the 20 s latch.                                              |
| Key wire-silence on `source === 'remote'` (or widen the `silentWire` opt-in)      | B-565: `source` picks the CallKit GLYPH — the Telecom/system-UI End and logout sites are 'remote'-labelled LOCAL ends whose wire hangup is the peer's only "Call ended". The opt-in exists at exactly two remote-verdict sites, pinned by a population scan. |
| Send the wire hangup from a remote-VERDICT end (the collapse / call.sync)         | The far side already issued the verdict; under the shared deviceId a live sibling transport relays an authorized kill into the winner's ACTIVE session. Those two sites go through `endSilently` via `{silentWire: true}`.                                   |
| Name a ringId on a cancel-ALL with multiple fan-outs (latest-wins ref)            | Disjoint-recipient fan-outs mean the other ring's holders correctly ignore the mismatched cancel and ring a withdrawn call (B-564). Exactly-one minted → named; else unscoped.                                                                               |
| Remove the directed loser hangup because a same-device double-emit could self-end | The double emit is app-level only and latch-guarded (B-109); removing the verdict re-opens the loser-strand→watchdog-kill lane. Residual recorded instead.                                                                                                   |
| "Fix" the scoped-clear TOCTOU with WATCH                                          | Shared ioredis client — WATCH is unusable here. The window is one RTT, documented; a Lua compare-and-del is the closer if it ever matters.                                                                                                                   |
| Roll the budget back to rolling-from-first-use keys with INCR+EXPIRE              | That is the brickable shape (B-558): one lost EXPIRE = a permanent TTL-less denial counter. Bucketed keys age out of RELEVANCE by construction.                                                                                                              |
| Count only `participantTags` for the SFU cap / host election                      | The await window between check and add is the race (B-557). Reservations are part of occupancy EVERYWHERE — cap, election, endRoomIfEmptyByHost, the zombie sweep, and (B-566 KO-3) leaveRoom's last-one-out delete.                                         |

### Known-open (recorded, not fixed here)

- ~~Probe-vs-rehydration race on relay restart~~ → FIXED (B-566 KO-1, §20):
  `call.sync` consults the asker's own durable lanes on a session miss.
- ~~1:1 WS decline lacks the other-device cancel push~~ → FIXED (B-566 KO-2, §20).
- ~~SFU: reservation-blind `leaveInternal` delete; reservations without TTL;
  same-user concurrent double-reserve~~ → FIXED (B-566 KO-3/4/5, §20). Residual:
  a never-settling claimer pruned while a second user completed under it can
  strand `hostUserId` at a ghost until the next size-0 election (pathological).
- ~~Host-handoff client/server `isHost` divergence~~ → FIXED (B-566 KO-6 +
  B-567, §20): `sfu.host-changed` broadcast, allowlisted, consumed promote-only.
- `answeredBy` stamped through a zombie caller socket forfeits the accidental
  re-answer recovery (directed hangup is the compensating verdict).
- ~~Cancel-all targets `opts.recipientUserIds` only~~ → NARROWED (B-566 KO-7,
  §20): every user THIS hook instance rang is covered; an invitee rung by a
  DIFFERENT participant remains uncovered (bounded by `sfu.room.ended` + 45 s).
- Multi-pod call state (WI-6.8) — boot-guarded; `CALL_STATE_SCALING.md`.

### NOT device-verified

Standing position, Phases 1–6. This phase's highest-value §7 rows:
two-device answer race; decline with a sibling Dozed; Add-then-cancel ring
identity; relay kill → resume → call.sync hard-end; loser-collapse UX.

---

## 20. Phase 7 outcome — observability + known-open closure + FULL SYSTEM REVIEW (2026-08-18)

Bug log: `sqa.md` B-566..B-568. Three-perspective full-system review
(architecture critic / race-edge timelines / security-regression constraints)
across Phases 1–7; two rounds to CLEAN×3.

| WI / item          | Outcome                              | What landed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Pinned by                                                                                                                      |
| ------------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| WI-7.1             | DONE                                 | `logCallTransition({callId, gen, prev, next, event, source})` in `runtime/callDiag.ts` — single-line release-surviving `[CALLSM] transition …`. Wired: `CallController.setState` ACCEPTED transitions (rejected forms keep their long-standing pinned shapes); `patchActiveGroupCall` state changes (one funnel covers every group writer — round-2 arch P3-3); the accept latch (`latch.accept`) and the cancel funnel's APPLY (`notif.cancel.apply`). Registry keyed/dropped writes + both teardowns were already on the lane (Phases 1/3). Reference: `docs/qa/CALL_DIAG_LOGGING.md`. | `callDiagTransition.test`, `callStateMachine`, `logAudit`                                                                      |
| WI-7.2             | DONE                                 | Server lifecycle logs: `[SFU]` room.create/join/leave/room.close(reason)/room.reap promoted or added (the B-346 silent-join gap closed), ring-decline + host-handoff lines; `[CALL] session` transitions at trackCallStart/rehydrate/trackCallAnswer(+winner)/trackCallEnd. O(lifecycle events); ids only.                                                                                                                                                                                                                                                                               | service suites (incidental) + the log-hygiene audit                                                                            |
| B-566              | FIXED                                | The Phase-6 known-open ledger closed: KO-1 rescue-aware `call.sync`, KO-2 1:1 WS-decline sibling collapse, KO-3/4/5 reservation lifecycle (occupancy at leaveRoom, 30 s TTL, same-user supersede + post-transport self-abort), KO-6 `sfu.host-changed` handoff broadcast + promote-only client consumption, KO-7 `rungUsersRef` cancel-all union. §19's stale rows annotated in place.                                                                                                                                                                                                   | ring-lifecycle KO describes, join-cap KO describes, `callSyncProbe.test`, `callDiagTransition.test`, `groupRingCancelIdentity` |
| B-567              | FIXED (review round 1, race F1 — P1) | KO-6's client half was DEAD CODE: `sfu.host-changed` was missing from `SFU_FRAME_EVENTS`, the third instance of the allowlist class in that very set (SFU-08, producer-paused). Entry added; the pin now requires the ROUTING SET membership, not just handler existence (the vacuous-pin class killed).                                                                                                                                                                                                                                                                                 | `callDiagTransition.test` B-567 routability pin; MUT-Q RED                                                                     |
| B-568              | FIXED (review round 1, race F2 — P2) | An ANSWERED group ring left a days-long phantom missed marker (no join-time clear — the 1:1 lane has had one since N-02). `handleSfuJoin` now clears the joiner's own artifacts + fans the answered-elsewhere cancel (host boot-join exempt from the push).                                                                                                                                                                                                                                                                                                                              | calls.spec B-568 describe; MUT-R2 RED                                                                                          |
| Round-2 arch items | FIXED                                | `sfu.ring.cancel`/`sfu.ring.ack` payload specs carry `ringId`; the ACK settle is ring-scoped end-to-end (frame field → dispatcher → runtime sender → `{onlyRingId}` clear) closing the ack-vs-newer-ring TOCTOU; `callSyncProbe` exempts an outbound unanswered ring from the `unknown` verdict (positive `ended` still ends). The DECLINE clear stays deliberately room-wide — a decline is the user's verdict on the ROOM's call.                                                                                                                                                      | calls.spec ack-scope describe, probe P3-6 tests                                                                                |

### Review record (round 1 → round 2)

- **Security/regression agent:** CLEAN round 1 (all 15 constraints; C2/C3
  byte-identical; no DOCUMENTS pin deleted — the WI-5.1 flip is per its own
  WHEN-FIXED note; `silentWire` unreachable from any frame; log hygiene
  verified live). Re-verified the round-2 hunks.
- **Architecture critic:** no P0/P1; P2-1 (B-566 unlogged — landed), P3-2
  (§19 stale — annotated), P3-3 (WI-7.1 group gap — wired), P3-4/5 (payload
  specs + ack scoping — landed; decline documented-deliberate), P3-6 (probe
  outbound exemption — landed), P3-7 (recorded residual).
- **Race/edge agent:** F1 (B-567), F2 (B-568), F3 (=P2-1); all other
  timelines — stale callbacks/timers/transport/controller/group cross-talk,
  every concurrency and surface pairing, restart-vs-probe both orderings —
  verified CORRECT against the tree.

### Residuals carried forward (recorded, deliberate)

- Ghost `hostUserId` after a never-settling claimer is pruned while a second
  user completed under it (pathological; next size-0 election heals).
- `rungUsersRef` is per-hook-instance: an invitee rung by a DIFFERENT
  participant is outside the host's cancel-all union (bounded by
  `sfu.room.ended` + the 45 s ring-out).
- The zombie-socket `answeredBy` trade-off; the scoped-clear MGET→MULTI
  TOCTOU (Lua blocked by ioredis-mock fidelity); the WI-6.5 fixed-window ≤2×
  straddle; WI-6.8 multi-pod state (boot-guarded; mandate-excluded).
- The ring-expiry hangup takes the decline branch's marker semantics
  (pre-existing P1-14 shape; race-agent-verified no regression).

### NOT device-verified

Standing position, Phases 1–7 — nothing in this campaign has been exercised
on hardware. The §7 device matrix is entirely NOT EXERCISED.

## 21. Call-join LATENCY — Step 0 outcome (instrumentation, 2026-08-20)

Companion campaign: `docs/audits/CALL_JOIN_LATENCY_AUDIT_2026-08-20.md` (diagnosis + the eight
step prompts) and `docs/audits/CALL_JOIN_LATENCY_MEASURED_2026-08-20.md` (the numbers). Step 0 is
observability only — no behaviour change — and landed after a 3-round Builder/Edge/Critic loop.

### 21.0 Campaign index (Steps 0–6)

Every step ran the Builder/Edge/Critic consensus loop to dual AGREE; each shipped its RED-first
pin(s) and its own `§21.x` outcome table + DO-NOT-RE-ADD list below. Client steps were committed

- pushed; the two server steps were also deployed to staging.

| Step | Shipped (B-number)                                                                                 | Commit   | Deploy  | §    |
| ---- | -------------------------------------------------------------------------------------------------- | -------- | ------- | ---- |
| 0    | `[CALLLAT]` lane instrumentation (no behaviour change)                                             | 78d52576 | —       | 21   |
| 1    | relay registers the call session BEFORE the await (B-596) + bounded block-check (B-597)            | 18a76a98 | staging | 21.1 |
| 2    | 1:1 client TURN cache + prewarm, single-flight, epoch-fenced (B-601 client half)                   | bbd10d58 | —       | 21.2 |
| 3a   | group boot low-risk half: ceiling'd TURN (B-598), void presence, audio at 'joining' off BT (B-600) | 54f1d948 | —       | 21.3 |
| 3b.1 | group client parallel `consumeProducer` (B-599 slice)                                              | e7be1657 | —       | 21.4 |
| 4.1  | SFU join creates send+recv transports with `allSettled` (B-604)                                    | 161381ad | staging | 21.5 |
| 5    | group ring bypasses depsReady buffer (B-602) + killed-lane headless TURN prewarm (B-601)           | 83491bbe | —       | 21.6 |
| 6    | pins + spec §21 + sqa flips (this section) — **A/B device sign-off (6.4) OWED** (founder-deferred) | —        | —       | 21.0 |

**Measured before/after per lane: OWED (Step 6.4).** Step 0 captured the caller lane on device
(TURN fetch 164/300/442 ms = 46–76 % of launch→offer; B-596 reproduced live on staging). The
answerer / group / killed-lane waterfalls and the A/B (old-vs-new APK, interleaved) medians are
NOT yet captured — 5555 was logged out and device-verify is founder-deferred. Acceptance criteria
(audit Step 6.4): (a) 1:1 warm accept→connected < 1.5 s voice / < 2.5 s video on the Redmi; (b) no
`[CALL] ICE ignored` for a healthy call; (c) invitee join-ack → last audio consumer live < 1.5 s
for 3 peers; (d) notification answer shows `turn ok` before the tap. Do not soften a criterion —
if one is unmet, name which step's assumption failed.

**Deferred-OPEN sub-items** (all device-number-gated or a founder decision): 2.2/2.4 (1:1 pre-built
PC + press-handler accept), 4.2/4.3/4.4 (audio-unpaused + `sfu.consume.batch` + join-ack-consumers,
a coordinated client+server follow-up), 5.2/5.6/5.7 (killed-lane boot reorders), 5.3 (killed-lane
progress UI), 5.4 (lean-runtime decision).

| Item                                     | Outcome                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------- | --------------------------------------------------------------------------------------------- |
| `[CALLLAT]` lane (`runtime/callDiag.ts`) | `logCallLat(lane, id, step, fields, {reset, freshAfterMs})` → `console.warn('[CALLLAT] lane= cid= step= t= dt= …')`; per-lane clocks (5-min TTL, one time axis for life); 1:1 lane latched at claim time (`latLane`) and ended on `state:ended                                                                                                                                         | failed`; group lane ended on any terminal state; `markJsStallOnActiveLanes`from`jsThreadWatchdog` (a stall row never counts as liveness). |
| Markers                                  | every row of the audit's §1 tables across callController / signallingClient / useCall / launchCall / useGroupCall / CallScreen / GroupCallScreen / fcmBootstrap / MainNavigator (incl. `offer:received`, `ring:received`, `notif:answer-tap`, `nav:ready`, `transport:live`, renegotiation `reoffer:*`/`reanswer:*`, group `audio:first-inbound`, interval rows with their own `ms=`). |
| Relay                                    | `[CALL] OFFER recv` BEFORE the privacy await; `[CALL] ICE ignored cid= reason=` (warn); `[SFU] join.ack                                                                                                                                                                                                                                                                                | transport.connect                                                                                                                         | produce | consume | consumer.resume … ms=`; mediasoup `tx.ice`/`tx.dtls` state lines (guarded). **Not deployed.** |
| Pins                                     | `callLatLane.test.ts`, `callLatMarkers.test.ts` (per-site counts, single-line rule, banned fields, latch, ms rows, relay order), `messenger.gateway.offer-ordering.spec.ts` (DOCUMENTS B-596 + ordered recv→ignored→OFFER); `escalationRingHandoff.test.ts` window 3000→3400 (assertion unchanged).                                                                                    |
| Measured so far                          | caller lane ×3 on BlueStacks 5556 (voice, callee offline): `launch→offer:emitted` 356/567/580 ms, TURN fetch 164/300/442 ms (46–76 %), `buildOfferAuth` ~78 ms; **B-596 reproduced** on the test call (relay logged the host ICE 0.26 ms before the OFFER line). Answerer / notification / killed / group lanes owed (second device not signed in).                                    |
| Review-round lessons                     | (1) `end()` nulls the descriptor BEFORE its terminal `setState` — never derive a lane/id from the descriptor there (latch at claim); (2) a self-emitted diagnostic row must never count as liveness; (3) pin marker sites by COUNT and require single-line marker calls; (4) "zero behaviour change" means eslint-disable + Why, never a widened deps array.                           |

### DO-NOT-RE-ADD (Step 0)

| Idea                                                                                   | Why not                                                                                                                        |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Derive the `[CALLLAT]` lane from `this.descriptor` in `setState`                       | `end()` nulls it first — incoming calls' closing rows land on the caller lane and the answerer clock never ends (R1 headline). |
| Let `js-stall` rows refresh `clock.touched`                                            | a finished lane under recurring stalls re-arms itself forever and defeats the GC (R2 Edge row 31).                             |
| Add `callId`/`isIncoming`/`direction`/`latG` to effect deps to satisfy exhaustive-deps | changes effect cadence (TURN re-fetch, sampler restart) under a "zero behaviour change" label — use Why + disable.             |
| Key the group lane by `roomId`                                                         | the host learns it only at step 1 and it is reused per fan-out; `conversationId` + `freshAfterMs` is the stable key.           |

### 21.1 Step 1 outcome — the relay's session-before-await fix (B-596) + bounded call-lane block-check (B-597), 2026-08-20

| Item          | Outcome                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B-596         | `handleCallOffer` registers the session SYNCHRONOUSLY (before the privacy await) and marks it `offerPending`; `handleCallIce` HOLDS candidates for it (cap 64, drop-oldest) and `handleCallOffer` flushes them BEHIND the offer frame once forwarded, or discards them on a failed forward; an offer-pending session is NOT LIVE for any other consumer (answer/media-state/reoffer/reanswer ignore; hangup/disconnect end silently; hangup during the forward await suppresses replay+wake and forwards the late hangup); throwing gate/forward releases the hold; blocked pair → `untrackCallSilently` (no session, no tombstone, no oracle). |
| B-597         | `privacyGateBounded` on the 1:1 offer and the group ring (per target): `PRIVACY_CALL_GATE_DEADLINE_MS` default 500, `0`/NaN = unbounded; on deadline use the LAST CACHED verdict (even expired, `peekBlockedEither`) and fail open only for a never-seen pair (= the service's existing probe-error semantics). Founder-visible trade-off recorded in sqa.md B-597.                                                                                                                                                                                                                                                                             |
| Pins          | `messenger.gateway.offer-ordering.spec.ts` (26, incl. population scan over all 6 `authorizeCallFrame` consumers + the disconnect sweep, the static `trackCallStart < first await` order pin, the 2-site `skipOnlineProbe` pin comment-stripped in `calls.spec.ts`), `ring-lifecycle.spec.ts` hanging-target ring test, harnesses carry the real session map. Mutation: inverting the hold → 6 RED.                                                                                                                                                                                                                                              |
| Review rounds | R1: Critic OBJECT (sibling handlers forwarded to a blocked callee + online oracle in the gate window; Step 0 scan anchor) / Edge OBJECT (in-window hangup → phantom missed-call push; throw leaves the hold armed; unstripped pin; fail-open deadline needs founder sign-off; pre-existing queue/wake-after-hangup race). R2: dual AGREE (all P1s closed: sibling handlers, throw-releases-hold, hangup-during-forward, stale-cache peek, wake-skip, peek pin mutation-proved).                                                                                                                                                                 |
| Deploy        | staging messenger-service via tar overlay (`docker compose -f docker-compose.staging.yml build/up messenger-service`) — PENDING (this session).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

#### DO-NOT-RE-ADD (Step 1)

| Idea                                                                                           | Why not                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create the session AFTER the privacy await (the pre-Step-1 order)                              | the client's B-273 gate flushes its candidates at offer emit; they arrive inside the await window and `authorizeCallFrame` bins them (B-596, live on staging). |
| Let an offer-pending session be LIVE for hangup/media-state/reoffer/reanswer/answer/disconnect | they forward frames, probes (= callee online state) and a "Missed call" push to a callee that may be a blocked pair (R1 headline).                             |
| Tombstone a blocked pair's session (`trackCallEnd`) instead of `untrackCallSilently`           | a retried callId would read `duplicate_call_id … (ended)` — a block oracle; M-07 promises silence.                                                             |
| Forward held ICE when the offer forward errored                                                | the pre-Step-1 behaviour emitted them into an empty room; the replay lane never carried early candidates — keep the discard symmetric.                         |
| Fail open on deadline WITHOUT the stale-cache peek                                             | a pair once known as blocked would be rung under a Supabase stall; the peek keeps known verdicts enforced (Edge row 13).                                       |
| A single `skipOnlineProbe: true` site pin                                                      | the held-ICE flush is a second legitimate `call.ice` site; pin "every site is a `call.ice` builder", comment-stripped.                                         |

### 21.2 Step 2 outcome — 1:1 client TURN cache + prewarm (B-601 client half), 2026-08-20

| Item                 | Outcome                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1 TURN cache       | new `webrtc/turnCredentials.ts` — session-wide `getIceServers({ceilingMs})` (fresh > 30 min, single-flight, ceiling→STUN-not-cached), `prewarmIceServers()` at the ring / group-ring / foreground / both voip-wake verifies, `invalidateIceServers()` (signOut) with an EPOCH FENCE so a signOut→signIn never serves the prior user's in-flight creds. CallScreen's raw fetch retired. |
| 2.3a permission skip | `getLocalMedia` only prompts when `check()` proves a perm missing; fails SAFE (a check() throw seeds all-pending → still prompts).                                                                                                                                                                                                                                                     |
| en route             | `ensureLocalMedia` made single-flight — a latent double-camera-open (caught by CALL-N1).                                                                                                                                                                                                                                                                                               |
| DEFERRED             | 2.2 (pre-built PC at ring) + 2.4 (press-handler accept) — payoff ~10-50 ms/1-frame vs the teardown/double-fire risk in B-274/B-319/B-339 code; 2.2's spec keeps the build-at-accept fallback, so deferral is safe by construction.                                                                                                                                                     |
| Review               | 1 round OBJECT (3 P1: unfenced invalidate → cross-user creds; vacuous 2.3a pin; check()-throws fail-open) + 1 fix round → AGREE (all 3 mutation-proved).                                                                                                                                                                                                                               |

#### DO-NOT-RE-ADD (Step 2)

| Idea                                                  | Why not                                                                                                                 |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Cache TURN creds without an epoch fence on invalidate | a signOut→signIn hands the previous user's in-flight creds (attribution-tied `${exp}:${opaqueId}`) to the next session. |
| Skip `requestMultiple` when `check()` THREW           | fails open into the B-340 racing-prompt "device not available" on a first-ever call; seed `pending` to all perms.       |
| Memoise only the RESULT of getUserMedia               | two concurrent callers open the camera twice (CALL-N1); single-flight the in-flight promise.                            |
| Pre-acquire mic/camera at ring                        | product/privacy decision, deliberately NOT taken (audit §5); mic/camera light only after Accept.                        |

### 21.3 Step 3a outcome — group boot de-serialization, low-risk half (B-598/B-600 + a B-599 slice), 2026-08-20

| Item               | Outcome                                                                                                                                                                                                               |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3a.1 (B-598)       | `fetchTurnCredentials` delegates to the shared ceiling'd cache `getIceServers({ceilingMs: TURN_FETCH_CEILING_MS})` — removes the unbounded await + the duplicate fetch; rejoin reuses the cache.                      |
| 3a.2 (B-599 slice) | the step-10 presence broadcast is `void`-ed — `setState('joined')` no longer awaits the pairwise fan-out. Pinned by a mutation-proof hook test + a step-10-anchored source scan.                                      |
| 3a.3 (B-600)       | group audio session starts at `'joining'` with mic-only, off the BT-prompt gate (BT = later route selection). OWED: an executable screen test (`InCallManager.start` at `state==='joining'`, `btPermResolved=false`). |
| DEFERRED           | 3a.4 (media‖join), 3a.5 (produce a‖v), 3a.6 (host navigate immediately), 3a.7 (void ring ack — `ringId`→WI-6.7 + `rungUsersRef`→B-342 boot-fail cancel, NOT gates-nothing).                                           |
| Review             | 1 round OBJECT (P1: the 3a.2 pin anchored on the pre-existing B-365b void → decorative; P2: 3a.3 executable test) + fix → AGREE.                                                                                      |

#### DO-NOT-RE-ADD (Step 3a)

| Idea                                                                  | Why not                                                                                                                           |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Fetch group TURN without a ceiling / cache                            | a background/Doze window hangs the whole boot on a dead socket (B-598); use the shared getIceServers.                             |
| Await the presence broadcast before 'joined'                          | delays "in the room" for a fan-out nothing downstream consumes (B-599).                                                           |
| Gate the group audio session on btPermResolved or on 'joined'         | a first call sits silent behind a BT dialog unrelated to audio (B-600); mic-only at 'joining' is enough.                          |
| Void the sfu.ring ack                                                 | its ringId is consumed for WI-6.7 per-ring cancel and rungUsersRef feeds B-342's boot-failure cancel — not a gates-nothing await. |
| Anchor a "void presence" scan on the FIRST broadcastGroupCallPresence | that's the pre-existing B-365b roster-heal void — the scan passes on a revert; anchor on the step-10 `opts.recipientUserIds` arg. |

### 21.4 Step 3b.1 outcome — group client parallel consume (B-599 slice), 2026-08-20

| Item              | Outcome                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3b.1 (B-599)      | the step-9 boot burst went from `for (const ep of existingProducers) { await consumeProducer(ep) }` (2N serial WS acks) to `await Promise.all(ordered.map(ep => consumeProducer(ep, …, /* batch */ true)))` with an **audio-before-video** sort.                                                                                                                                                                                                                                                                                                              |
| Safety            | verified from mediasoup source: `ReactNative106.receive()`→`setupTransport()` fires `@connect` (→`sfu.transport.connect`) inside `if (!_transportReady)` and sets the flag, so the DTLS connect runs EXACTLY ONCE; the shared `_awaitQueue` drains `recv.consume` SDP munging strictly serially (no corruption) while only the WS acks overlap. Dedup guards (`inFlightConsumes` + `consumedProducerIdsRef`) make a duplicated producerId atomic; a rejoin mid-burst parks each lane via the attemptGen check; B-482 superseded-transport backstop unchanged. |
| Failure isolation | `Promise.all` never rejects — `consumeProducer` swallows into its retry loop and resolves; a single failing consume does not sink the siblings. Property holds by the callee's no-throw contract (not by the array combinator).                                                                                                                                                                                                                                                                                                                               |
| Pins              | `groupBootStep3aWiring` (Promise.all + audio-first sort + dedup-guards-intact; mutation-proved RED on a serial-loop revert). 35 group suites / 520 tests green; reviewer re-ran 7 suites / 127 tests twice (flake rule).                                                                                                                                                                                                                                                                                                                                      |
| DEFERRED          | 3b.2 (overlap `waitForGroupCallKey` with `device.load`/transport creation — crosses the S6 fail-closed E2EE boundary), 3b.3 (module-level `getLoadedDevice` caps-hash cache — additive). Stay OPEN under B-599.                                                                                                                                                                                                                                                                                                                                               |
| Review            | 1 round, combined edge+critic, dual AGREE. Non-blocking P2s left open (not defects): a behavioral concurrency hook test for failure-isolation (folded into the B-604 follow-up); `Promise.allSettled` to make isolation structural.                                                                                                                                                                                                                                                                                                                           |

#### DO-NOT-RE-ADD (Step 3b.1)

| Idea                                                        | Why not                                                                                                                                           |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Serialize the boot burst (`for … await consumeProducer`)    | peer #3's audio waits behind peer #1's video — 2N serial WS acks (B-599). The awaitQueue already serializes the only unsafe part (SDP munging).   |
| Fear a double `sfu.transport.connect` from parallel consume | `@connect` is `_transportReady`-guarded in mediasoup-client — it fires exactly once regardless of concurrency.                                    |
| Drop the audio-before-video sort                            | audio is the latency-critical stream; dispatch its `sfu.consume` first so it is not queued behind video.                                          |
| Convert `consumeProducer` to throw on failure               | `Promise.all` would then sink every sibling on one bad producer; keep the no-throw/resolve contract (or move to `allSettled` before changing it). |

### 21.5 Step 4.1 outcome — group SFU parallel transport creation (B-604), 2026-08-20

| Item            | Outcome                                                                                                                                                                                                                                                                                        |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4.1 (B-604)     | `SfuService.joinRoom` creates the send + recv `WebRtcTransport`s with `Promise.allSettled([create, create])` instead of `await; await`. ~2 mediasoup worker RTT → ~1 on the join critical path.                                                                                                |
| Leak-free       | **allSettled, NOT Promise.all**: on a one-sided rejection Promise.all rejects while the other create is still in flight, leaking the resolved transport's ICE ports/FDs (never assigned, never closed). allSettled captures both outcomes → the UNCHANGED catch closes whichever succeeded.    |
| Invariants held | Every WI-6.4 / KO-3..6 (B-566) property untouched: cap check, `pendingJoins` reservation + rollback, host election/handoff (`sfu.host-changed`), the KO-5 post-transport re-check, the observability `tx.on(icestatechange/dtlsstatechange)` loop — only the two awaits fused into one settle. |
| No wire change  | 4.1 adds no WS event and no payload spec — nothing for old/new clients to feature-detect (unlike 4.3). No security stop-condition touched (transport creation only); no new log line.                                                                                                          |
| Pins            | `sfu.service.parallel-transport.spec.ts` (3, mutation-proved): parallelism (serial → RED); leak-free close both directions (naive Promise.all → RED). `sfu.service.join-cap` (14 WI-6.4/KO cases) still green; full service 53 suites/694 tests green.                                         |
| DEFERRED        | 4.2 (audio consumers unpaused), 4.3 (`sfu.consume.batch`), 4.4 (join-ack-carries-consumers) — a coordinated client+server follow-up; none is safe/useful server-only. Stay OPEN under B-604.                                                                                                   |
| Review          | 1 round, edge (Opus 5) + critic (Fable 5), dual AGREE.                                                                                                                                                                                                                                         |

#### DO-NOT-RE-ADD (Step 4.1)

| Idea                                                             | Why not                                                                                                                                                                       |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Serialize the two transport creates (`await; await`)             | two worker RTTs on the join critical path for no reason; they are independent.                                                                                                |
| "Optimize" allSettled → `const [s,r] = await Promise.all([...])` | a one-sided reject leaks the sibling transport (resolves after the reject, never assigned, never closed) — the exact FD/ICE-port leak the ordered sequential close prevented. |
| Ship audio-unpaused (4.2) server-only                            | the round-trip saving needs the client to skip resume; server-only it only moves when RTP arrives vs the FrameCryptor attach — needs the client step + Critic sign-off.       |
| Add `sfu.consume.batch` (4.3) before a client calls it           | dead code + an un-negotiated protocol surface; ship it with its client consumer and the `capabilities` feature-detect in the join ack.                                        |

### 21.6 Step 5 outcome — notification / killed lanes, device-independent half (B-602 + B-601 headless), 2026-08-20

Step 5 is HIGH-risk; its core boot-reordering items are prerequisite-gated on Step 0's killed-lane
device numbers, which were NOT captured (5555 logged out; device-verify founder-deferred). Shipped
the two device-independent items; deferred the number-gated reorderings (a blind productionRuntime
boot reorder is the B-125 trap).

| Item            | Outcome                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5.8 (B-602)     | the runtime's `onFrame` depsReady buffer now exempts group ring frames (`isGroupRingFrame`) the same way it exempts 1:1 call frames (`isCallFrame`), so a cold-boot ring isn't stranded behind the SQLCipher hydrate (the B-479 restore-mode park/ack lane). `dispatchGroupRingFrame` is DB-free (navigate/dedup/ack only), so it genuinely doesn't need the buffered deps.                                 |
| Single source   | `GROUP_RING_FRAME_EVENTS` {incoming, cancelled, declined} moved to the pure `callFrameRouter` module (eager-importable, unit-testable — same home as `isCallFrame`) and re-exported from `groupCallRingDispatcher` for its existing consumer; the buffer-bypass eligibility and the dispatch routing can never drift. `sfu.ring.missed` is NOT exempt (writes a bubble → needs the store → stays buffered). |
| Epoch first     | the Phase-5 `if (!isOurEpoch()) return` runs BEFORE the buffer gate — an out-of-epoch ring is dropped, never fast-pathed. Pinned by an onFrame-anchored source scan, mutation-proved RED under BOTH deleting AND reordering the epoch gate.                                                                                                                                                                 |
| Behavior change | a live WS ring copy landing in a handler gap (headless/pre-auth) is now dispatched immediately rather than buffered; if no handler is registered it is not re-buffered — recovery leans on the B-479 reconnect replay + the FCM rescue copy (the WI-3.6/B-479 contract).                                                                                                                                    |
| 5.1 (B-601)     | the KILLED-app headless voip-wake lane (`fcmHeadless.ts`) now `prewarmIceServers()` after HMAC verify, before presenting the ring — the last un-warmed wake lane (the foreground/both fcmBootstrap voip-wake lanes + MainNavigator were already warmed in Step 2). Same-process only; UI-boot fetch is the fallback for a reaped VM.                                                                        |
| Pins            | `callFrameRouter.test.ts` (isGroupRingFrame membership + exclusions + identity drift-guard), `groupRingDepsReadyBypass.test.ts` (onFrame-anchored source scan), `turnPrewarmWiring.test.ts` (headless site). All mutation-proved. crypto 6654 ×2 green; app screens 611; typecheck 46≤47.                                                                                                                   |
| DEFERRED (OPEN) | 5.2 call-lane-first boot, 5.6 pre-boot on voip-wake, 5.7 route-notification-earlier — number-gated productionRuntime/nav reorders; 5.4 lean-runtime decision (a spec task); 5.3 killed-lane progress text (UI, needs DESIGN_REVIEW_LOOP). Device evidence owed (killed-lane waterfall on the Redmi).                                                                                                        |
| Review          | 2 rounds — edge (Fable) AGREE R1 + nit N1; critic (Fable) OBJECT R1 (vacuous epoch pin + missing sqa record, both test/doc-side) → both FIXED → dual AGREE R2.                                                                                                                                                                                                                                              |

#### DO-NOT-RE-ADD (Step 5)

| Idea                                                                     | Why not                                                                                                                                                          |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Buffer group ring frames behind depsReady                                | a cold-boot ring waits out the whole SQLCipher hydrate while 1:1 calls ring through (B-602); the dispatcher is DB-free.                                          |
| Exempt `sfu.ring.missed` too                                             | it writes a missed-call bubble via appendMessage — it genuinely needs the store; it must stay buffered.                                                          |
| Re-inline a second copy of the ring event set in the dispatcher          | drift between the buffer-bypass eligibility and the dispatch routing; keep the single source in callFrameRouter + re-export (pinned by an identity drift-guard). |
| Put the epoch gate after the buffer gate / drop it                       | an out-of-epoch (post-logout) ring would be fast-pathed past the epoch fence; the epoch gate must precede the buffer gate (onFrame-anchored pin).                |
| Ship the number-gated boot reorders (5.2/5.6/5.7) without device numbers | a blind productionRuntime boot reorder is the B-125 trap (no test imports it); each move needs the Step 0 lane number that shows it on the critical path.        |
