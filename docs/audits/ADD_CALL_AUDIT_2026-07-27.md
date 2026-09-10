# Add-Call Feature Audit — 2026-07-27

**Scope:** every surface involved in adding a participant to a live call — the 1:1 → group
escalation ("Add" on CallScreen), the mid-group invite ("Add" on GroupCallScreen), the ring
fan-out, the receiver's answer path, and the server gateway.
**Method:** full-path code read (client + server) cross-checked against a **two-device live
session** (Pixel 6a host + OPPO CPH2577 peer, both v1.0.178/vc209, dual logcat capture,
3 escalation runs — 2 succeeded, 1 reproduced the founder-reported failure).
**Prior art:** B-297..B-305 (fixed earlier today, sqa.md EOF entries); the 53-agent root-cause
workflow of the 2026-07-27 morning session; `docs/runbooks/CALL_KNOWN_GOOD_BASELINE.md`.

---

## 1. Feature map

| #   | Surface                  | File                                                                              | Role                                                                                                                               |
| --- | ------------------------ | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Escalation (1:1 → group) | `CallScreen.tsx` `escalateToGroupCall` (~:1819)                                   | Gates (B-111-A FrameCryptor, B-301 transport pre-flight), route handover (B-302), live-call handover (B-301 `pendingDirectCallId`) |
| 2   | Escalated boot + ring    | `useGroupCall.ts` boot step 3a (key: `ensureCallGroupKey`) + step 11 (`sfu.ring`) | Keys ALL `recipientUserIds`, rings after join, `sentRingRef` retry-safe                                                            |
| 3   | Mid-group invite         | `GroupCallScreen.tsx` `inviteCandidates` (~:1100) + `handleInvite` (~:1218)       | Roster-scoped candidates (B-260), optimistic 30s countdown                                                                         |
| 4   | Invite sender            | `useGroupCall.ts` `inviteUsers` (~:4098)                                          | B-300 keys union roster BEFORE ring; B-299 throws when not ready; `reRing` for expiry                                              |
| 5   | 1:1 retire on join       | `GroupCallScreen.tsx` (~:320)                                                     | `endActiveCall` gated on `call.state === 'joined'` + `pendingDirectCallId` match                                                   |
| 6   | Ring dispatch (client)   | `groupCallRingDispatcher.ts`                                                      | Multi-subscriber pub-sub; **once-ever dedup per roomId (60s TTL)**                                                                 |
| 7   | Ring → UI routing        | `MainNavigator.tsx` (~:754) + `groupCallRegistry.shouldNavigateForRing`           | Navigates `IncomingGroupCallScreen`; guards consider **group state only**                                                          |
| 8   | Answer UI                | `IncomingGroupCallScreen.tsx`                                                     | Ringtone, Accept (B-111-A gate), self-dismiss on cancel/decline                                                                    |
| 9   | Push lane                | `fcmBootstrap.ts` (~:1580) + `callNotification.ts`                                | `bravo-call-<callId>` card + Telecom/CallKit, dedup by callId                                                                      |
| 10  | Busy handling            | `callWaiting.ts`                                                                  | **1:1-arrives-while-busy ONLY** — no group-ring-while-on-1:1 model                                                                 |
| 11  | Server gateway           | `messenger.gateway.ts` `handleSfuRing` (:2012)                                    | host-only, rate-limited (socket + cluster/user 20), fan-out cap 250, block-filter, self-strip                                      |

Server side is in good shape: authority anchor (host-only), two-level rate limits, bounded
fan-out, block filtering with no oracle, payload bounds. No server findings.

---

## 2. Status of this morning's fixes (device evidence)

| Bug                        | Fix                              | Device verdict (3-run session)                                                                                                                                          |
| -------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B-301 escalation atomicity | no hangup before join            | **VERIFIED** — no `InCallManager stop()` between 1:1 start and group boot in any run; 1:1 PC closed only after join; run-2 invitee joined a call whose 1:1 leg survived |
| B-297 dead device seed     | removed                          | **VERIFIED** — no `Can not select … available []` at any escalation                                                                                                     |
| B-302 route handover       | `initialAudioRoute` param        | Held (no route flap at escalation); the explicit-SPEAKER case not re-exercised this run                                                                                 |
| B-300 mid-group-add keying | key-before-ring in `inviteUsers` | **NOT exercised** — all 3 runs used the escalation BOOT ring (step 11), not `inviteUsers`. Needs a dedicated test: Add from inside an already-running group call        |
| B-299 phantom ring         | throw when not ready             | Failure path not triggered (good); code+test only                                                                                                                       |
| B-303 watchdog clock       | monotonic                        | Running; stall values plausible                                                                                                                                         |
| B-305 chrome auto-hide     | idle-timer                       | **NOT IN vc209** — landed after the bundle; ships next build                                                                                                            |

---

## 3. New findings

### AC-1 / B-306 — the receiver has NO escalation handoff: ring vs. 1:1-teardown race, and the loser is unrecoverable ⚠️ **P0** · OPEN · device-confirmed

**Founder symptom (run 3):** _"oppo screen was freeze, no new call come."_

**Device evidence (OPPO, 14:22–14:23):**

```
14:22:41  OPPO calls Pixel (1:1, cid=f49be4b0)          — OPPO is the CALLER this run
14:22:57  Pixel taps Add → [groupcall.boot]
14:23:00.696  OPPO: iceConnectionState=disconnected      ← host's 1:1 PC retired on join
14:23:00.699  OPPO: InCallManager stop()                 ← local teardown
14:23:01.206  OPPO: ice-restart threw: "Failed to set local offer sdp:
              Called in wrong state: closed"             ← AC-2
   …no ringtone, no IncomingGroupCallScreen, no group boot — ever…
14:23:27  OPPO: NOTIFEE removes bravo-call-<roomId>      ← ring card EXISTED (FCM lane),
                                                            removed by the host's cancel
```

Contrast run 2: the OPPO was **idle** when rung → answered → joined in ~5s. The failing case is
exactly _the busy 1:1 peer_.

**Mechanism (three code facts that compose into the failure):**

1. **CallScreen's ended auto-dismiss is a 50ms-delayed `navigation.goBack()`**
   (`CallScreen.tsx` ~:1617) — it pops **whatever is on top**. If the ring handler's navigate has
   already pushed `IncomingGroupCallScreen`, the goBack pops the _ring screen_, not CallScreen.
2. **`shouldNavigateForRing` knows nothing about a live/ending 1:1**
   (`groupCallRegistry.ts` :131+) — it checks only active-group-room and current-group-route. No
   `callRegistry.getActiveCall()` consultation anywhere in the ring path. `callWaiting.ts`
   models "call arrives while busy" for a second _1:1_ only.
3. **The ring is deduped once-ever per roomId** (`groupCallRingDispatcher.ts` :82–95, 60s TTL) —
   dedup marks _seen_, not _presented_. If the first delivery loses the navigation race, the
   server's reconnect replay is swallowed and there is **no second chance**. The FCM card is the
   only survivor — and a card on a foregrounded app does not full-screen.

**Interaction with B-301 (honest note):** before B-301 the host hung up _first_, so the receiver
was already idle when the ring arrived and this race was unreachable from the escalation flow.
B-301 (correct in itself, device-verified on the host) moved the receiver's hangup to join-time —
landing it in the same instant as the ring and exposing this pre-existing gap. The gap itself
predates B-301 (any group ring during any 1:1 could always hit it); escalation just makes it
deterministic.

**Fix shape (minimal, mirrors existing patterns):**

- In MainNavigator's `onIncoming`: if `callRegistry.getActiveCall()` is live, do NOT push over
  CallScreen — park the ring as a _pending group ring_ (the `incomingOneToOneBanner` pattern in
  reverse) and let CallScreen consume it: on reaching a terminal state, `navigation.replace` into
  `IncomingGroupCallScreen` instead of `goBack()`. No race, no pop-over.
- Change dispatcher dedup semantics from "seen" to "presented": only mark the roomId once a
  handler reports it surfaced UI; a swallowed ring stays eligible for the replay.
- Keep 60s TTL and cancel/decline clearing as-is.

### AC-2 / B-307 — `disconnected` → ICE-restart races a remote teardown; the controller can wedge in a non-terminal state ⚠️ P1 · OPEN · device-evidence

`callController.ts` (~:1199–1300, restart at ~:1402): on `iceConnectionState='disconnected'` the
controller enters `'reconnecting'` and sends a reoffer with `iceRestart: true`. In run 3 the
restart fired against a PC the teardown had already closed:
`ice-restart threw: Failed to set local offer sdp: Called in wrong state: closed`.

Why it matters beyond the log line: while `'reconnecting'`, CallScreen renders the **full-screen
ReconnectingOverlay**, and the BackHandler treats `'reconnecting'` as live → back **minimizes**
instead of popping (`CallScreen.tsx` :418). If the ended transition is lost in the race, the user
is left on a permanent overlay they cannot back out of — a frozen screen. B-301 makes the
interleaving (`disconnected` a beat before the hangup frame) the _normal_ receiver experience of
an escalation, so this needs to be deterministic: a hangup arriving in any restart phase must
land the controller in `'ended'`, and `restartIce` must no-op on a closed/closing PC.

### AC-3 — the WS full-screen lane and the FCM card lane don't coordinate ⚠️ P2 · OPEN

Run 3 proves the lanes can disagree: the FCM lane delivered (card posted, later cancelled — so
ring _and_ cancel parity worked end-to-end) while the WS lane produced no UI. Nothing reconciles
"card exists but no full-screen was ever presented" on a foregrounded app. After AC-1's
presented-semantics change, the card path should check: app foreground + no ring UI surfaced →
re-dispatch through the dispatcher rather than trusting the WS lane already did it.

### AC-4 — `inviteCandidates` never recomputes when the name backfill lands ⚠️ P3 · OPEN

`GroupCallScreen.tsx` ~:1100 — the group branch reads `groupMemberNames`/`directoryNames` via
`useMessengerStore.getState()` inside a `useMemo` whose deps are
`[conversations, conversationId, ownerUserId, call.identityByTag]`. The `ensureDirectoryNames`
backfill it itself triggers can therefore never re-render the sheet: rows show **"Member"** for
the life of the modal. Subscribe to the two name maps (the B-226 `hostNameSignal` pattern in
`IncomingGroupCallScreen` is the in-repo precedent).

### AC-5 — 1:1 Add picker is direct-conversations-only ⚠️ P3 · OPEN (UX)

`CallScreen.tsx` ~:793 — candidates = existing `direct:` conversations. No directory search, no
group-roster source. Anyone you have never DM'd cannot be added from a 1:1.

### AC-6 — the entire add-call/ring path is invisible in release builds ⚠️ P2 · OPEN

Every diagnostic on the path is `console.log` (stripped by `transform-remove-console`). Run 3's
diagnosis required _inferring_ the receiver's ring handling from an absence of InCallManager
lines. Minimum `[CALLDIAG]` `console.warn` set (all cheap, all metadata-only, no plaintext):
ring frame received (dispatcher, + dedup verdict), `shouldNavigateForRing` decision,
`IncomingGroupCallScreen` mount/dismiss reason, boot-ring sent / `inviteUsers` ring sent (ack or
error). This single gap cost most of today's two device sessions.

---

## 4. Recommended order

1. **AC-1/B-306** — pending-ring handoff + presented-semantics dedup (P0; completes the
   escalation story B-299/300/301/302 started; without it the receiver leg of Add is a coin-flip).
2. **AC-2/B-307** — teardown-wins rule in the controller + closed-PC guard on restart.
3. **AC-6** — `[CALLDIAG]` warns (do this WITH 1–2 so the next device run verifies them one-shot).
4. **B-305** ships in the next build automatically (already fixed).
5. AC-3, then AC-4/AC-5.
6. Dedicated device test for **B-300's actual path**: Add from inside a running group call
   (3 devices) — still never exercised on hardware.

---

\_Log evidence: session scratchpad `logs/p2\__.log`, `p3\__.log` (Pixel host + OPPO peer, dual
capture). sqa.md carries B-306/B-307 stubs pointing here.\_
