# Bug-fix pass — QA report v1046

Fixes for the 7 bugs in `BUG_REPORT_v1046.md` (B-10, B-12, B-13, B-14, B-15, MSG-01).
All changes are **client-side** (React Native app). The two CRITICAL bugs (B-10,
B-14) are fully resolved on the client; B-14/B-12 have _optional_ server-side
hardening noted at the bottom.

---

## What changed (client)

### B-10 — Non-admin host poisoned the real group master key (Critical, crypto)

WhatsApp model kept: **anyone can start a group call.** The bug was that a
non-admin host aliased the throwaway ad-hoc "Call" key over the real
`conversationId`, overwriting the persistent group's `masterKeyB64` + `owner`,
and receivers keyed real-group calls off the (now stale) real id → 0 frames.

- `runtime/productionRuntime.ts` `ensureCallGroupKey` — the minted ad-hoc key is
  now filed under its own id **and** `direct:<owner>` **only**. The alias over
  the real `conversationId` is removed. The persistent group key is never touched.
- `webrtc/useGroupCall.ts` `resolveKeyId` — when the ring's host is **not** the
  group's admin/owner, the receiver keys off the ad-hoc `direct:<host>` slot
  (and waits for it if in-flight) instead of the stale real key. Admin-hosted
  calls are unchanged (real id). The host keys off the id `ensureCallGroupKey`
  returned (`keyConvoId`), not `resolveKeyId()`.
- Tests: `__tests__/adhocCallKeyLookup.test.ts` (extended).
- **Architecture:** compliant with `ARCHITECTURE_AMENDMENT_SFRAME.md` — no change
  to cipher/key-length/distribution channel; only _which id_ the existing key is
  resolved under. The drop-on-no-key fail-closed gate is preserved.

### B-14 — WS idle close → ICE restart over dead socket → stuck call (Critical)

- `webrtc/useGroupCall.ts` `restartTransport` — now **waits for the WS to
  reconnect** (socket.io auto-reconnects) before sending
  `sfu.transport.restartIce`, and **retries** across the 30 s recovery budget
  instead of one-shotting over a dead socket.
- Added a **20 s app-level keepalive `ping`** while a call is live
  (joining/joined/reconnecting). The server already answers `ping`→`pong`; this
  keeps idle-timeout intermediaries from reaping the connection and surfaces a
  dead WS sooner.
- Tests: `__tests__/groupCallIceRestartWait.test.ts`.

### B-13 — Late joiner saw 2 tiles instead of 3 (High)

- `webrtc/useGroupCall.ts` — the step=9 consume burst now **batches** all
  consumers' tiles into a single `setRemoteTiles` after the loop (dedup by
  consumerId), so the layout computes once at the final count and never freezes
  at the intermediate 1-tile state when `recvTx` flips to connected.
- Tests: `__tests__/groupCallTileBatch.test.ts`.

### B-15 — No "video unavailable" indicator on a frameless tile (Low)

- `webrtc/useGroupCall.ts` — the existing stats poller now also tracks
  `framesDecoded` per tag and flags a tag stalled when an **unpaused** video
  consumer decodes 0 frames for >3 s (`videoStalledTags`).
- `screens/messenger/GroupCallScreen.tsx` — overlays "Video unavailable" on a
  live-but-frameless tile (distinct from the camera-off placeholder).
- Tests: `__tests__/groupCallVideoStall.test.ts`.

### B-12 — Host abandons before join → ghost ring, no record (Medium)

- The host already sends `sfu.ring.cancel` on teardown (verified). The gap was
  receiver UX: the ring vanished with no record.
- `screens/messenger/IncomingGroupCallScreen.tsx` — on `onCancel` (host
  cancelled before accept/decline), append an **incoming "missed group call"**
  history bubble (`appendMissedGroupCallBubble` in `useGroupCall.ts`).
- Tests: `__tests__/groupCallMissedRing.test.ts`.

### MSG-01 — Silent inner-group tamper drop (Medium)

- `runtime/productionRuntime.ts` group-recv — the fail-closed **drop is kept**
  (security contract). Now non-silent: a clearer, actionable user message plus a
  durable `crashLog` breadcrumb (peer + group + env id) so desyncs are traceable.
- **Not done (needs architecture sign-off):** auto group-rekey on integrity
  failure — that's a key-distribution change and is abusable as a
  rekey-amplification vector. Left out deliberately.

---

## Verification

- `npm run test:crypto` → 880 pass (incl. 38 new bug-fix tests).
- `npm test --selectProjects=app` → pass.
- `npm run typecheck` → 53 errors, under the 84 baseline; net delta non-positive.
- **Not verifiable on this host (native):** FrameCryptor key agreement, ICE
  restart, frame-decode stats. Needs on-device smoke:
  1. Non-admin starts a group call on a named group → all parties see/hear each
     other (B-10), and the group's text messages still decrypt afterward.
  2. Long video call (>3 min) survives a WS blip / reconnects (B-14).
  3. Join a call already in progress with ≥2 video participants → all tiles
     appear (B-13).

---

## Optional server-side hardening (messenger-service) — NOT required for the fix

The client fixes stand alone. If you want belt-and-braces on the backend:

- **B-14 idle timeout:** `WS_HEARTBEAT_MS` (default 30 000) drives socket.io
  `pingInterval`; `connectionStateRecovery` already buffers 2 min. If field
  devices still idle-drop, lower `WS_HEARTBEAT_MS` to ~20 000 to match the new
  client keepalive cadence, and double-check the TURN allocation TTL outlives a
  typical call. No code change needed — env only.
- **B-12 missed-call fan-out:** the host's `sfu.ring.cancel` already reaches
  ringing recipients. If you want a _missed-call push_ (app backgrounded), have
  the gateway emit a `GROUP_CALL_PRESENCE { state: 'ended' }` to invitees that
  never joined, on host teardown — the client already records the missed bubble
  on the in-app cancel path.
