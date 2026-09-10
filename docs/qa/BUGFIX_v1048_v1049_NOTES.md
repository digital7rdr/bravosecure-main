# Bug-fix notes — v1.0.48 & v1.0.49 (2026-06-08 QA session)

**Branch:** `release/1.0.35-audit-fixes`
**Source reports:** `Bravo_Bugs_2026-06-08.md` (v1.0.46/47 QA), `Bravo_Secure_Bug_Report_2026-06-08_v1.0.48.md` + `docs/qa/analysis.md` (v1.0.48 QA)
**Builds:** **1.0.47 (vc 69)** → **1.0.48 (vc 71)** → **1.0.49 (vc 72)**

This session ran in two rounds. Round 1 shipped in **v1.0.48** and was independently confirmed by QA. Round 2 (this set) ships in **v1.0.49** and addresses what v1.0.48 testing surfaced, plus a reported call-minimize regression.

---

## ⭐ Quick summary (shareable)

| Bug               | Issue                                                 | Status                                   |
| ----------------- | ----------------------------------------------------- | ---------------------------------------- |
| **B-11**          | 2nd device stuck "Offline"; user looked always-online | ✅ Fixed — _v1.0.48, QA confirmed_       |
| **B-12**          | Group-call joiner never got the key                   | ✅ Fixed — _v1.0.48_                     |
| **B-14**          | Messaging went dead after a server drop               | ✅ Fixed — _v1.0.48_                     |
| **B-16**          | 1:1 video: first to enable saw only themselves        | ✅ Fixed — _v1.0.48_                     |
| **B-13**          | Non-owner-hosted group call failed for joiners        | ✅ Fixed — _v1.0.48_                     |
| **B-01**          | Group video host saw black tiles                      | ✅ Fixed — _v1.0.48, QA confirmed_       |
| Group text        | Group messages didn't render                          | ✅ Fixed — _v1.0.48, QA confirmed_       |
| **B-18**          | Incoming 1:1 text never appeared on receiver          | ✅ Fixed — _v1.0.49_                     |
| **Call minimize** | Back / Home **cut** the call instead of minimizing    | ✅ Fixed — _v1.0.49_                     |
| **B-17**          | Group-call joiner showed a blank/extra tile           | ✅ Fixed — _v1.0.49_                     |
| **B-05**          | Server WS drop kills every call (15/15)               | ⚠️ Mitigated — **needs server redeploy** |
| **B-19**          | Video shown in wrong tile                             | ⏳ Needs physical devices to confirm     |

**Legend:** ✅ fixed & in a build · ⚠️ needs a server-side step · ⏳ needs more testing

---

## 1. Status summary

| Bug                                   | Title                                             | Layer       | Status                                                           | Build           | Commit               |
| ------------------------------------- | ------------------------------------------------- | ----------- | ---------------------------------------------------------------- | --------------- | -------------------- |
| **B-11**                              | 2nd device goes offline (`signalDeviceId=1`)      | Frontend    | ✅ Fixed — _QA confirmed_                                        | 1.0.48          | `2b21ac3`            |
| **B-12**                              | Group-call joiner never gets key                  | Frontend    | ✅ Fixed (cascade of B-11/B-13)                                  | 1.0.48          | —                    |
| **B-14**                              | Post-call transport dead                          | Frontend    | ✅ Fixed                                                         | 1.0.48          | `75f804e`            |
| **B-16**                              | 1:1 audio→video: first enabler sees only self     | Frontend    | ✅ Fixed                                                         | 1.0.48          | `6918497`            |
| **B-13**                              | Non-owner host skips group-key broadcast          | Frontend    | ✅ Fixed (joiner side; host side impossible by design)           | 1.0.48          | `7a14983`            |
| **B-17**                              | Group-call joiner shows a blank/missing tile      | Frontend    | ✅ Fixed (rebuild + prune)                                       | 1.0.48 / 1.0.49 | `c265867`, `8ec1928` |
| Group text render, **B-01**           | Group msg / host black tiles                      | Frontend    | ✅ Fixed — _QA confirmed_                                        | 1.0.48          | (merged `aede318`)   |
| **B-18**                              | 1:1 inbound text decrypts but never renders       | Frontend    | ✅ Fixed                                                         | 1.0.49          | `0933d8a`            |
| **Call minimize**                     | Back/Home **cuts** the call instead of minimizing | Frontend    | ✅ Fixed                                                         | 1.0.49          | `c0a4e36`            |
| **B-05**                              | Server WS drop kills every active call            | **Backend** | ⚠️ Mitigated — **needs server redeploy** (+ crash investigation) | 1.0.49          | `f536781`            |
| **B-19**                              | Video → wrong/duplicate tile                      | Frontend    | ⏳ Inconclusive — needs physical devices                         | —               | —                    |
| **B-07/08/09/10**                     | (various)                                         | Frontend    | ⏳ Not retested                                                  | —               | —                    |
| Incoming-1:1-video → receiver restart | —                                                 | Frontend    | ⏳ Watch-item (1 occurrence)                                     | —               | —                    |

---

## 2. Round 1 — fixed in v1.0.48 (QA-confirmed)

### B-11 — 2nd device goes offline ⚠️ CRITICAL — `2b21ac3`

**Root:** Phase-1 single-device design — every device registers with `signalDeviceId=1`, so the connection registry keys both on `${userId}:1` and the newer socket supersedes the older. The server emitted `error{code:'superseded'}` first, but the client ignored it and, on the following `io server disconnect`, gave up permanently (no reconnect, no distinct UI).
**Decision:** keep the documented single-device model (newest session wins). _Full multi-device is a Phase-2 lift and a security-gated change — explicitly out of scope._
**Fix:** new `'superseded'` `TransportState`; the client surfaces "Active on another device" and does NOT reconnect (no ping-pong); a genuine reconnect clears the takeover memory. Server: `ConnectionRegistry.add()` reports supersession so the gateway skips the presence INCR that was leaking the per-user counter (the "permanently online" half).
**Files:** `packages/messenger-core/src/transport/client.ts` (the LIVE transport — the `src/modules/.../transport` copy is dead), `ConnectionBanner.tsx`, `messengerStore.ts`, `connection-registry.ts`, `messenger.gateway.ts`.
**QA result (v1.0.48):** all 3 devices online simultaneously, **0 supersession events** (was 100%).

### B-14 — post-call transport dead ⚠️ HIGH — `75f804e`

**Root:** socket.io does not auto-reconnect on a server-initiated `io server disconnect` (restart / idle reap / crash). The client parked in `disconnected` forever.
**Fix:** the non-takeover `io server disconnect` branch now drives a capped exponential-backoff reconnect (1s→30s) via `forceReconnect()` (re-reads the token, so an expired one self-heals); reset on connect, cancelled on user-close, and the B-11 takeover path still parks in `'superseded'`.

### B-16 — 1:1 audio→video, first enabler sees only self ⚠️ HIGH — `6918497`

**Root:** the first party to enable video already had `isVideoUI=true` from their own track, so the remote `<RTCView>` was already mounted on the audio-era stream; the peer's later video track (same MediaStream id → unchanged `streamURL`) never rebound the native SurfaceView.
**Fix:** a `remoteHasVideo` flag driven off `ontrack`'s real track list **keys** (remounts) the remote `<RTCView>` the moment remote video arrives. Applied in `CallScreen` and the `FloatingCallOverlay` 1:1 path.

### B-13 — non-owner host key resolution ⚠️ CRITICAL — `7a14983`

**Root:** two prior fixes drifted out of sync. The B-15 owner-poison guard made a non-owner host **reuse** the real group key under the real `conversationId` (it can't mint/broadcast over a group it doesn't own), but the joiner's `resolveKeyId` still forced the ad-hoc `direct:<host>` slot and waited 25s for a key that's never minted.
**Fix:** scope the force-the-ad-hoc-slot rule to genuine `direct:*` (escalated-1:1) calls only; for a real group the joiner resolves the real key it already holds as a member. See §4 for the host-side assessment.

### B-17 — group-call joiner blank/missing tile (part 1) — `c265867`

**Root:** the reconcile keyed on `consumedProducerIds` ("do I have a _consumer_?") not "do I have a _tile_?", so a consumed-but-tileless producer (lost to a boot-batch flush race) was never recovered.
**Fix:** reconcile on **tiles** — rebuild a tile from the live consumer when one exists but the tile is gone. (Part 2 in §3.)

---

## 3. Round 2 — shipped in v1.0.49

### B-18 — 1:1 inbound text decrypts but never renders ⚠️ HIGH — `0933d8a`

**Symptom (v1.0.48):** incoming 1:1 messages decrypt (`handled=true`, no banner) but no bubble appears — the receiver's thread shows only its own sent messages. Group text render was fixed; the direct path was not.
**Root:** a 1:1 thread's history can be **split** across two store slots — the synthetic `direct:<peer>` key and a server-UUID row. The canonical slot (`resolveDirectConversationIdFromState`, used by both `sendText` and the inbound append) flips to the UUID the moment `/conversations/mine` syncs a row. So a message sent before the sync lands in the synthetic slot (renders) while one received after lands in the UUID slot — but ChatScreen is pinned to its route-param id, so the inbound side is invisible. (Canonicalizing alone would instead hide the earlier outbound.)
**Fix:** new `directConversationSlots(state, conversationId)` returns every direct slot mapping to the peer. ChatScreen's message selector merges them (deduped by id, sorted by `created_at`) via `useShallow` — a single-slot chat returns the store array verbatim (stable ref, no extra renders); groups are untouched. `markRead` covers all slots too so the unread badge clears.
**Files:** `ChatScreen.tsx`, `messengerStore.ts`, `productionRuntime.ts`.
**Tests:** `directConversationSlots` (5) in `resolveDirectConversationId.test.ts`.

### Call minimize — Back/Home cuts the call instead of minimizing — `c0a4e36`

**Symptom (user report):** during any call (1:1 or group, audio or video), pressing **Back** — or swiping back — **ends** the call instead of minimizing. Expected (WhatsApp): the call keeps running, a status bar shows at the top, tapping it restores full screen.
**Root:** the minimize infra already existed (`FloatingCallOverlay` + the registry `isMinimized` flag; the audio bar already renders `Calling…` / `Ringing…` / `Connecting…` / `On call`), but both call screens only minimized when fully **connected/joined** — every earlier phase hung up / tore down on back.
**Fix:**

- `CallScreen` (1:1): hardware-back AND the swipe-back `beforeRemove` now minimize for every live state (`calling`, `ringing`, `connecting`, `connected`, `reconnecting`). No implicit hangup on a dialling/ringing call — cancelling is the explicit End button.
- `GroupCallScreen`: minimize for `joining` / `joined` / `reconnecting` (was joined-only; minimizing during joining keeps the half-built SFU alive via `keepAlive` instead of tearing it down — which also avoids the phantom-tile teardown). Only the brief pre-SFU `creating` phase still tears down (no room/overlay to keep).
- The overlay auto-dismisses on a terminal state, so a never-answered call can't strand a floating bar.

### B-17 — phantom tile prune (part 2) — `8ec1928`

**Symptom (v1.0.48):** a joiner still showed an **extra BLANK cell** next to the real participants ("SH + FA + 1 blank") even though both remote producers were consumed.
**Two findings from the itsirajul logcat:**

1. The part-1 reconcile (`c265867`) **never ran** — every `sfu.producers` call failed with `ack_timeout` / "transport not open" because the WS was unstable (B-05). The B-05 grace bump should let it run again.
2. The blank cell is an **extra/phantom** tile, not a missing one — the reconcile only _added_ tiles, never _pruned_ stale ones (a boot-race room recreation, B-08, or a producer that closed without `sfu.participant.left`).
   **Fix:** make the reconcile **bidirectional**. The server snapshot is authoritative — a producer still producing is ALWAYS listed — so a tile whose `producerId` is absent from `PRUNE_MISS_THRESHOLD` (3) consecutive **successful** snapshots is pruned (tile removed, consumer closed, `producerId` freed). Debounced + gated on a successful fetch, so a transient/partial snapshot can never drop a live tile.
   **Tests:** `planPrune` (4) — never prunes a snapshot-present tile, prunes a phantom only after the threshold, resets on reappearance, skips in-flight.

### B-05 — server WS drop kills every call ⚠️ CRITICAL (BACKEND) — `f536781`

**Symptom (v1.0.48):** every active call (15/15 this session, all types) died to a server-side WS drop — all participants kicked within ~1s of each other (one server event).
**Fix (config):** `WS_HEARTBEAT_GRACE` default 10s → **25s** (feeds socket.io `pingTimeout`). At 10s a late pong under variable Contabo/TURN latency got the socket reaped mid-call.
**Pairs with:** B-14's client keepalive + reconnect-on-server-drop (already shipped) — the client now rides out a blip and re-establishes.
**⚠️ IMPORTANT — scope:**

- This only helps if the drops are **heartbeat-timeout kicks**.
- If the simultaneous disconnects are a **messenger-service crash/restart**, the grace does nothing — the server still needs a crash investigation + a PM2 watchdog on `94.136.184.52` (host access required).
- **Requires a `messenger-service` redeploy** to take effect. Default-only change; `WS_HEARTBEAT_GRACE` env override still wins.

---

## 4. Architectural assessment — B-13 host side

The v1.0.48 report asked for the non-owner host to **broadcast** the group key for joiners that lack it. **This is impossible without weakening a security invariant** and is therefore _not_ changed:

The receive-side group-create check (`productionRuntime.ts` `group-create:recv`, S4) requires BOTH:

1. `action.state.owner === peer.userId` (sender must be the owner), and
2. `verifyGroupCreateSignature` against the **sender's** identity key.

A non-owner relaying the owner's signed create fails both. So a non-owner host genuinely cannot distribute the real group master key — by design (prevents forged group creates).

**Conclusion:** the joiner-side `resolveKeyId` fix (`7a14983`) is the correct, architecturally-compliant fix and is exactly the report's recommended alternative. It covers the common case (joiner already holds the real key — QA confirmed calls work). The remaining edge — a joiner that **never received** the real key — needs a group resync from the real owner (outside the call flow) and is a key-distribution change requiring architecture sign-off.

---

## 5. Verification

- **Automated:** `npm run test:crypto` + app suite — **1033 tests pass**. New tests: `transportSupersession` (5), `transportServerReconnect` (4), `directConversationSlots` (5), `groupCallTileReconcile` rebuild+prune (10), `adhocCallKeyLookup` B-13 (updated). Typecheck **52 ≤ 84 baseline**; lint clean.
- **Not unit-testable (native / device-only) — needs on-device smoke:**
  - B-16 / B-17 — `RTCView` SurfaceView remount + tile reconcile.
  - B-18 — 1:1 render across split slots (open a chat via push/incoming-call entry; exchange both directions).
  - Call minimize — Back/Home at ringing AND connected, 1:1 + group, audio + video; tap the bar to restore.
- **Server-side (not runnable locally — workspace deps not installed):** `connection-registry` superseded-return + the `WS_HEARTBEAT_GRACE` default run in CI / after `npm install` in `apps/messenger-service`.

---

## 6. Required follow-up outside the app

1. **Deploy `messenger-service`** to `94.136.184.52` so the B-05 grace bump (and thus the B-17 reconcile) takes effect.
2. **Investigate the WS drops at the server** — `pm2 logs messenger-service` / `journalctl -u messenger-service` / `pm2 list` at the drop timestamps to confirm crash/restart vs heartbeat timeout; add a PM2 watchdog + uptime monitor.
3. **Re-test on physical devices** with distinct cameras for B-19 (tile↔stream binding) and the incoming-1:1-video receiver-restart watch-item.

---

_All work is on `release/1.0.35-audit-fixes` (local, unpushed). Per-bug detail in the commit messages referenced above._
