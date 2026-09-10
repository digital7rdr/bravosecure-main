# Bravo Secure â€” Group-Call Bug-Fix Playbook (2026-06-07 QA Session)

## 1. Situation summary

On **2026-06-07** a 3-emulator QA session (BlueStacks/Samsung SM-S908E images on adb ports `:5555`, `:5565`, `:5575`; users **itsirajul/shirajul/fahim**) ran the full call matrix â€” messaging (~14:41â€“14:48), audio Calls Aâ€“H (~14:57â€“15:04), and video Calls 1/1b/2 (~15:14â€“15:29) â€” plus an earlier raw-logcat capture window (~12:00â€“12:07) of a single sustained group video call. **Headline result:** a healthy ~5-minute, 30 fps group video call died at **12:05:24â€“25** when `sfu.producers failed: 'transport not open'` fired on all three PIDs within ~170 ms; ICE disconnected ~5 s later, ice-restart was attempted over the already-dead WebSocket (`ack_timeout:sfu.transport.restartIce`), and both transports reached `connectionState=failed` by 12:05:40â€“41 with **no auto-reconnect**. Separately, the call-by-call matrix exposed a **P0 security defect**: when a **non-admin** hosts a call in a **real named group**, the client mints a fresh ad-hoc key and **overwrites the real group's local master key + owner field** (B-15 / "owner poison"). Many client fixes already exist at repo HEAD; the single server-side fix (SFU keyframe-on-resume) is **in the repo but NOT deployed** to staging. This document is self-contained: deploy state, what is already fixed, every open bug with a step-by-step fix, and how to verify.

---

## 2. Environment & deploy state

| Environment                                      | What it runs (current)                                                                                                                                      | How code gets there                                        | Key gap                                                                                                                                                                                                                  |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Repo HEAD**                                    | branch `release/1.0.35-audit-fixes`, HEAD `b44be93`                                                                                                         | git                                                        | Contains ALL client fixes + the SFU keyframe fix (`fe78c09`).                                                                                                                                                            |
| **Staging messenger-service (SFU + WS gateway)** | Docker image on Contabo `94.136.184.52` (`relay.94-136-184-52.sslip.io`), reportedly **built ~2026-06-07 11:42 +06, BEFORE `fe78c09` (committed 11:55:59)** | Manual / CI                                                | **SFU keyframe-on-resume NOT deployed.** `WS_HEARTBEAT_GRACE` still default `10000`. ad20d0f Redis-fanout deploy status **needs verification** (server-side; not on `main`).                                             |
| **Test APK (what the 3 emulators ran)**          | self-labeled **"v1046" = versionName 1.0.46**; exact `versionCode` (60â€“68) and git SHA **NOT captured**                                                   | `npm run release` â†’ Firebase App Distribution (qa group) | **APK provenance unknown** â€” cannot confirm which client fixes shipped. `app.json` version (1.0.41) is stale; `android/app/build.gradle:108-109` is authoritative (`versionCode 68` / `versionName "1.0.46"` at HEAD). |
| **auth-service / messenger-service CI deploy**   | `.github/workflows/deploy-messenger.yml` triggers **only on push to `main`** touching `apps/messenger-service/**`; tags image `github.sha`                  | GitHub Actions                                             | `fe78c09` and `ad20d0f` are **NOT reachable from `main`** (`git branch --contains` â†’ only `release/1.0.35-audit-fixes`); local `main` HEAD `7239761` dated 2026-05-27. So CI **could not** have auto-shipped them.     |

### How to deploy the server fix (manual â€” required for `fe78c09`/`ad20d0f`)

```
# from a workstation with SSH access to Contabo
rsync -az ./apps/messenger-service/ admin@94.136.184.52:~/bravo/apps/messenger-service/
ssh admin@94.136.184.52 'cd ~/bravo && docker compose build messenger-service && docker compose up -d messenger-service'
# confirm boot banner:  [messenger-service] Listening on :3100 (socket.io at /ws, redis-adapter attached)
```

_(Exact remote path `~/bravo` and compose service name **need verification** against the actual host layout.)_

### How QA gets a new APK

`npm run release` (assembleRelease bakes `.env.production` â†’ `https://relay.94-136-184-52.sslip.io`) â†’ upload to **Firebase App Distribution**, "qa" group. **Capture the `versionCode` and `git rev-parse HEAD` at build time** and record them with the build so provenance is never unknown again.

---

## 3. Already fixed â€” do NOT re-fix

| Commit                  | What it fixed                                                                                                                                                                                                                                                                 | Side            | Deploy status                                               | How to confirm                                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `fe78c09` (06-07 11:55) | **Black remote video** â€” SFU now calls `c.requestKeyFrame()` after `resumeConsumer` for video (`sfu.service.ts:491-494`)                                                                                                                                                    | server          | **fixed-NOT-deployed**                                      | Confirm running image build SHA â‰¥ `fe78c09`; live: resumed remote tile paints <1 s.                                             |
| `ad20d0f` (06-04)       | **Multi-pod `sfu.new-producer` fanout via Redis**; `iceTransportPolicy 'relay'â†’'all'`; 4 s `sfu.producers` reconcile backstop                                                                                                                                               | server + client | **server part NOT confirmed deployed**; client part in repo | Confirm image SHA â‰¥ `ad20d0f`; check `iceTransportPolicy:'all'` in WebRTC config; on multi-pod, all participants see all tiles. |
| `d435697` (06-06 20:38) | **B-01** client black-video (pin measured slot height in `FlexibleVideoTile`/`groupCallLayout`); **B-02** real-group key lookup (resolve real `conversationId` then `direct:<host>`); **B-04** skip ghost "Call" inbox row when `name==='Call'` (`productionRuntime.ts:4437`) | client          | in repo (HEAD); **in test APK = unknown**                   | `groupCallLayout.test.ts` BS-GC-BLACKVIDEO cases; manual: no "Call" rows in inbox.                                                |
| `25eb8f0` (06-06 20:38) | **Ad-hoc call key to escalated 1:1 joiner** via `direct:<hostUserId>`; owner-equality resync gate (`productionRuntime.ts:2593`). **CAUTION: this gate's false-branch is the B-15 trigger â€” do not "simplify" it away.**                                                     | client          | in repo; test APK unknown                                   | `adhocCallKeyLookup.test.ts`; joiner acquires key in window.                                                                      |
| `9056c3a` (06-06 20:38) | Bake Contabo staging URLs into release via `.env.production` (NODE_ENV=production)                                                                                                                                                                                            | build/config    | in repo; test APK unknown                                   | Release build hits `relay.94-136-184-52.sslip.io`, not `127.0.0.1`.                                                               |
| `e113b3c` (06-06 20:38) | Resync group master key on every call (host always re-broadcasts owned key); joiner key-wait window. **NOTE: introduced an echo regression later reverted by `5dbf2d9`.**                                                                                                     | client          | in repo; test APK unknown                                   | Joiner gets key; no "no group master key".                                                                                        |
| `5dbf2d9` (06-06)       | **1:1** fixes: screen-off on voiceâ†’video upgrade (`CallScreen.tsx`), echo revert to bare `audio:true` (`peerConnectionFactory.ts`), choppy-audio idempotence guard in `pickAudioRouteNative`                                                                                | client          | in repo; test APK unknown                                   | 1:1 only â€” lower relevance to GROUP-call QA.                                                                                    |
| `b492876`/`e3a52fb`     | Identity-rotation Signal session-reset wiring                                                                                                                                                                                                                                 | client          | in repo                                                     | May reduce but not eliminate MSG-01 (verify coverage of group path).                                                              |

**Stale / closed:** **B-03** ("`frameCryptorOrchestrator.ts` missing from repo") is **STALE** â€” the file exists at `src/modules/messenger/webrtc/frameCryptorOrchestrator.ts` and is what `useGroupCall.ts` imports. No Android action. (iOS still lacks a native FrameCryptor impl â€” separate platform gap.)

---

## 4. Open bugs (by priority)

> **Device/user mapping (authoritative, per `sqa.md` line 5):** `:5555` = **itsirajul** (PID 2861), `:5565` = **shirajul** (PID 2784), `:5575` = **fahim** (PID 2849). The raw-logcat readers and the task brief used the REVERSE â€” per-user attributions in those sections are mislabeled, but the WS failure is room-wide so conclusions hold. Use this table for all per-user claims below.
> **Group â†’ admin/owner:** `f956b212` = shirajul, `3cb79cb1` = fahim, `4100833d` = itsirajul.

---

### B-15 â€” Non-admin host mints ad-hoc key for a REAL group, poisoning local owner + master key **[P0, unfixed, SECURITY]**

_(Was reader-#6 "B-10 OWNER POISON" / "B-10 CASCADING". Distinct from `sqa.md` B-10 epoch bug â€” see B-10 below.)_

**Symptom.** Every call where the group's real **admin** hosts PASSES; every **non-admin**-hosted call FAILS (5/8 audio calls failed; remote video black on receivers due to key mismatch).

- Call G: `[call-adhoc-key:runtime] key distributed delivered=3 keyConvo=0a99b93fâ€¦` â€” fahim (non-admin) hosting itsirajul's group `4100833d` overwrites `masterKeyB64` AND sets `owner=fahim` on fahim's device.
- Call H: shirajul (also non-admin) mints another fresh key `de3dcd3d` ~30 s later â€” group key rotated **twice in 30 s**; any message sent between is unrecoverable.
- Receiver tile: `EglRenderer Frames received: 0` (black) on key mismatch.

**Root cause (source-verified).**

- `launchCall.ts:155-193` routes a real-group call as `direction='outgoing'` with `conversationId =` the **REAL** group id and `recipientUserIds = otherMembers`.
- `useGroupCall.ts:816` **unconditionally** calls `rt.ensureCallGroupKey({conversationId: realGroupId, recipientUserIds})` â€” **no host-is-owner/admin check**.
- Inside `ensureCallGroupKey` (`productionRuntime.ts:2570`) the ONLY guard is line **2593**: `if (existing?.masterKeyB64 && existing.owner === ownAddress.userId)` â†’ resync. When a non-owner hosts, `existing.owner = peer !== self`, the guard is **false**, and execution **falls through to the mint path** (2629â€“2685): `makeNewGroup({name:'Call', owner:self})`, then `store.setGroupState(state)` (2641) and **critically** `setGroupState({...state, groupId: conversationId})` at **2642**. `setGroupState` is a **full overwrite** (`messengerStore.ts:742-744`), so the host's REAL-group state at the real `conversationId` is replaced with `owner=self`, `name='Call'`, epoch reset to 0, fresh master key â€” and that new key is fanned out to recipients.
- The recipient `owner===sender` forgery guard (`productionRuntime.ts:4384`) does **NOT** catch it: the non-owner mints with `owner=self` and signs as self, so `owner===sender` passes.

**Exact fix plan (SECURITY-SENSITIVE â€” design against `docs/ARCHITECTURE_AMENDMENT_SFRAME.md` + System Architecture Documentation BEFORE coding).**

1. **Split conversation classes inside `ensureCallGroupKey` (`productionRuntime.ts:2570`).** Determine whether `conversationId` is a **REAL server group** (a stored group row with `masterKeyB64` owned by someone) vs an **ad-hoc/escalated** target (`direct:*` / no real group row).
2. **REAL group, non-owner host:** do **NOT** mint and do **NOT** `setGroupState`-overwrite the real `conversationId`. Either (a) reuse the stored real `masterKeyB64` (resync only, no rotation), or (b) **block hosting** if this device lacks the real key. Preserve `existing.owner`, `existing.epoch`, `existing.masterKeyB64`.
3. **Scope the line-2642 alias write** so it only writes to **ad-hoc** ids (`name==='Call'` / `direct:*`), never to a real `conversationId` slot.
4. Add the owner/admin gate at the call-start site (`useGroupCall.ts:816`) **or** inside `ensureCallGroupKey` such that it **never writes to a real `conversationId` slot owned by another user**.
5. Keep the existing `existing.owner === ownAddress.userId` resync gate intact for the ad-hoc/escalated path (it is also the forgery-relevant gate from `25eb8f0`).

**What NOT to break.** Do not weaken or remove the owner-equality resync gate (2593), the recipient owner===sender forgery guard (4384), `verifyGroupCreateSignature`, or sealed fan-out. Do not add a "skip in dev" branch. The escalated-1:1 ad-hoc mint path (`25eb8f0`) must keep working for `direct:*` targets.

**Verify by.**

- Add/extend `src/modules/messenger/__tests__/adhocCallKeyLookup.test.ts` (or a new productionRuntime test): `ensureCallGroupKey` with a real-group `conversationId` whose stored `owner !== self` must **NOT** call `setGroupState` with `owner=self`/`name='Call'` and must **NOT** alter `groups[realConversationId].masterKeyB64`/`owner`/`epoch`.
- `npm run test:crypto`.
- Manual (3 emulators): group owned by A; have B (non-owner) host a call on A's group; assert A/B/C all keep the original `masterKeyB64`, and a non-call group message round-trips after the call (no tamper-drop). Watch for **absence** of `[call-adhoc-key:runtime] key distributed â€¦ keyConvo=<realGroupId>` on a non-owner real-group host.

---

### B-05 â€” Server WebSocket drops mid-call; ICE-restart over dead WS; no auto-reconnect â†’ call stuck FAILED **[P0, needs-info]**

_(= readers' B-14 / FR-1; root-cause crash-vs-heartbeat is BLOCKED-ON-SERVER-LOGS.)_

**Symptom.** All 3 devices lose the WS within ~170 ms; call never recovers.

- `[bravo.groupcall.reconcile] sfu.producers failed: 'transport not open'` â€” Device 5555 line **1117** (12:05:25.062), Device 5565 line **3025** (12:05:24.930), Device 5575 line **4783** (12:05:24.891).
- `recvTx/sendTx ice-restart failed: ack_timeout:sfu.transport.restartIce` â€” 5555 lines **1151/1152**; 5565 **3064/3065**; 5575 **4818**.
- `connectionState=failed` both transports â€” 5555 lines **1155/1172** (12:05:39.931/40.173); 5565 **3068/3081**; 5575 **4821**. Then only `CameraStatistics: Camera fps: 30` to end (UI frozen).

**Root cause â€” TWO candidates, UNRESOLVED without server logs.**

- **Candidate A (process crash/restart):** Node dies â†’ socket.io drops every connection at once; the 171 ms simultaneity favors this.
- **Candidate B (heartbeat-grace kick):** `configuration.ts:16-17` defaults `WS_HEARTBEAT_MS=30000`, `WS_HEARTBEAT_GRACE=10000`; `redis-io.adapter.ts:70-71` maps these to socket.io `pingInterval`/`pingTimeout`. **IMPORTANT correction:** socket.io's kill window is **~pingInterval + pingTimeout (~40 s)** of silence, NOT a flat 10 s. A single 2.6 s spike cannot trip it, and 3 clients aligning within 171 ms from independent pong latency is implausible â€” so Candidate B as "one 2.6 s spike" is unlikely; A is circumstantially favored but **not proven**.
- **No disconnect-reason logging exists on either side.** Server `handleDisconnect` (`messenger.gateway.ts:623`) logs only `ws close sub=â€¦ signalDev=â€¦` (`:692`), never the socket.io reason. Client `client.ts:392-406` distinguishes `io server disconnect` vs network drop but only `setState()` â€” no console log. So device logs cannot break the tie.

**Client-side gap is real regardless:** there is **no** socket.io `reconnect` â†’ auto-rejoin handler, and the client attempts `restartIce` over a known-dead WS.

**Exact fix plan â€” two parts.**

- **CLIENT (P1, in repo):** In `useGroupCall.ts`, add a transport/socket `reconnect` handler that, while `state==='joined' && roomId && !isLeaving`, calls `attemptRejoin(roomId)` within the SFU's 60 s window (`sfu.service.ts:52` `ZOMBIE_ROOM_GRACE_MS=60000`). Do **not** attempt `restartIce` when the WS is known-closed â€” reconnect the socket first. Emit a new log line e.g. `[bravo.groupcall] reconnect -> rejoin`.
- **SERVER/CONFIG (P0, ops):** Raise `WS_HEARTBEAT_GRACE 10000 â†’ 25000` in `apps/messenger-service/src/config/configuration.ts:17` (or via env), confirm `pingTimeout` picks it up, add a PM2/watchdog + uptime monitor on `relay.94-136-184-52.sslip.io`. **Root cause (A vs B) still needs server logs.**

**What NOT to break.** Reconnect/rejoin must re-establish through the existing signalling path; do not bypass sealed-sender, sender-cert verification, or relay dwell semantics. Raising the grace is a config change only â€” do not alter heartbeat _content_.

**Verify by.**

- **NEEDS server logs** (BLOCKED-ON-SERVER-LOGS) to choose A vs B. Ops greps on `94.136.184.52` for the **12:04:30â€“12:06:00** window:
  - Restart/uptime: `pm2 describe messenger-service | grep -Ei "restarts|uptime|status"` (restart count incremented â‡’ A).
  - Crash/OOM: `journalctl -u messenger-service --since "2026-06-07 12:04:30" --until "2026-06-07 12:06:00" | grep -Ei "exit|killed|oom|uncaught|unhandledRejection|FATAL|heap"`; `dmesg -T | grep -Ei "oom|killed process|node"`.
  - Restart fingerprint (proves A at ~12:05:24): grep for `Listening on :` and `socket.io redis adapter connected`.
  - Mass-disconnect fingerprint: grep `ws close sub=` in the window â€” 3 clustered with continuous uptime + clean re-opens â‡’ B.
  - **Decision rule:** restart_time incremented OR boot banner at ~12:05:24 â†’ **A** (fix = watchdog + crash-cause). No restart + continuous uptime + ~3 clustered `ws close` â†’ **B** (fix = grace bump). Neither signal â†’ inconclusive; do not guess.
- **Client fix:** `useGroupCall` test simulating a transport `reconnect` event in joined state asserts `attemptRejoin` is invoked once with the active `roomId`. Manual: kill+restart the WS mid-call â†’ tile grid restores within 60 s; watch for `[bravo.groupcall] reconnect -> rejoin`.

---

### MSG-01 â€” Group message ACKed (delivered) but silently dropped as tamper **[P1, partially-fixed]**

**Symptom.** `W [group:recv] tamper detected â€” dropping envelope from fe4ddc14` while the relay ACKs the same envelope (`ACK ok envId=9f4935e9 handled=true`). User never sees the message (3/4 displayed in QA). Real occurrence **14:43:07**, log lines **6530-6531** and **6885-6886** (shirajul drops one group text from fahim during the messaging test).

**Root cause (source-verified â€” corrects the log's "Signal session" framing).** The tamper is a **GROUP MASTER-KEY mismatch**, not a Signal-ratchet desync. The outer Signal-session decrypt **already succeeded** (`productionRuntime.ts:4289-4293`) before `parseGroupMessage` runs; `parseGroupMessage` (`groupClient.ts:291-299`) returns `reason:'tamper'` **only** when `groupDecrypt(masterKeyB64, outer)` throws â€” i.e. the receiver's stored `groups[groupId].masterKeyB64` differs from the sender's encrypt key. The relay ACKs on delivery (by design â€” relay stores no content), so the message is lost silently. **Receivers can diverge for reasons unrelated to B-15** (missed create/rekey fan-out â€” the resync at 2579-2593 exists for exactly this; out-of-order admin delivery / stale-epoch no-op at 4466-4517; removed-member/late-text races).

**Exact fix plan (SECURITY-ADJACENT â€” verify against architecture doc).** On a group-recv `'tamper'` (at `productionRuntime.ts:4311-4314`), do **not** silently drop-and-ack as final. Instead trigger a **key/state resync** (request the owner's current create/rekey, or stash like the existing `no_key` branch at 4316-4337) so a key-diverged receiver can recover, AND surface a user-visible "couldn't decrypt one message â€” re-syncing" indicator. Keep relay ACK-on-delivery / dwell rules unchanged. Confirm whether `b492876`'s session-reset already covers the group path.

**What NOT to break.** Do not change the tamper-drop itself to fail-open â€” fail-closed is correct. Do not alter relay ACK-on-delivery / 30-day dwell. Resync must go through sealed fan-out + signature verification.

**Verify by.** Determine reproducibility outside the restart-heavy harness (**needs verification** â€” was the QA desync a genuine bug or a test-harness artifact?). Add a test: a group decrypt-failure surfaces a recoverable state (re-request or visible "undecryptable") rather than a silent drop. Manual: force a key divergence; recipient recovers or shows a decrypt-failure marker.

---

### B-10 â€” Group key epoch mismatch / tamper-drop after call teardown+recreation **[P1, needs-info â€” INDEPENDENT of B-15]**

_(`sqa.md` B-10 = failure-report FR-3e. NOT the owner-poison bug.)_

**Symptom.** After a call tears down and a new call is created, the host sends a group message under an **advanced epoch** while recipients hold the **old epoch** â†’ `[group:recv] tamper detected â€” dropping envelope`. Original FR-3e trace ~11:35:42 (host `3165d0e1`, a different earlier capture, not this session's three users) â€” **same code mechanism** as MSG-01 (group-key divergence at `groupClient.ts:299`).

**Root cause (gap-fill resolved: INDEPENDENT, not a downstream symptom of B-15).** Temporal proof: the only real tamper drops this session fired at **14:43:07** (messaging test), ~14 min **before** the first owner-poison opportunity (Call B at 14:59:26). No call ran before 14:43. The genuine "epoch-advance-without-redistribution before host's next message" risk lives in the **admin add/remove rekey flows** (`productionRuntime.ts:2342-2380` remove+rekey, `2517-2560` add+rekey): if a rekey fan-out reaches **0 peers** (code only warns, e.g. 2558-2560, and rotates locally anyway), or a receiver no-ops the rekey due to a stale epoch (4466-4517), the host's next group text decrypts only locally and drops as tamper on the lagging peer. The call path's only real-group write is the B-15 line-2642 alias (epoch reset to 0, not an advance) â€” so **fixing B-15 does NOT close B-10**.

**Exact fix plan (SECURITY-SENSITIVE â€” verify against architecture doc).** This largely overlaps MSG-01's recovery path. Ensure that whenever any path **advances/rotates the group epoch**, the new epoch key is **redistributed to all members BEFORE** the host sends any message under it, and receivers accept the new epoch. If a rekey fan-out delivered to 0 peers, do not silently proceed â€” surface/retry. Do **not** change the tamper-drop (fail-closed is correct); fix the **distribution ordering**.

**What NOT to break.** Same as MSG-01 â€” fail-closed tamper handling, sealed fan-out, signature verification, dwell semantics.

**Verify by.** After the MSG-01 recovery fix, re-run the Call-Gâ†’Call-H sequence on 3 emulators; confirm no `[group:recv] tamper detected` and a post-call group message displays on all 3. Add/extend a groupBroadcast/epoch test in `packages/messenger-core/__tests__` asserting epoch-advance triggers redistribution **before** the first message under the new epoch.

---

### B-06 â€” Missing video tiles: `sfu.new-producer` arrives before frame handler registered **[P2, partially-fixed]**

**Symptom.** A tile can stay missing the whole call. `[bravo.groupcall.reconcile] sfu.producers failed: ack_timeout:sfu.producers` (5565 line 3060, 5575 line 4815) â€” the 4 s reconcile backstop itself ack_timeouts under Contabo latency.

**Root cause.** In `useGroupCall` boot, the `sfu.new-producer` handler registers at **step 7**, after `sfu.join` at **step 3**. Producer events in that window are dropped. The 4 s `sfu.producers` reconcile (added `ad20d0f`) is the recovery, but it also ack_timeouts under high latency. Multi-pod fanout was a separate cause, addressed by `ad20d0f` Redis fan-out.

**Exact fix plan.** Move `sfu.new-producer` handler registration to **before** `sfu.join` (step 7 â†’ before step 3). Buffer any producer events received before `recvTransport` is ready, draining on connect. Keep the 4 s reconcile as backstop only. Latency that makes reconcile fail is mitigated by B-16.

**What NOT to break.** Consume path still goes through the SFrame attach/decrypt; do not consume before the group key/encryptor is ready.

**Verify by.** Extend `src/modules/messenger/__tests__/groupCallConsumeOrder.test.ts`: new-producer events received before recvTransport-ready are buffered and drained (no dropped tile). Manual: last-joiner into a 4-producer room shows all tiles; no producer left unconsumed after the first 4 s reconcile.

---

### B-08 â€” Boot race: 2nd `GROUP_CALL_PRESENCE` during in-progress `sfu.join` unmounts GroupCallScreen â†’ join aborts **[P2, unfixed]**

**Symptom.** `11:34:56.820 sfu.join started` then `11:34:56.952 [bravo.groupcall.leave] tearing down` (132 ms later) â€” device never joins.

**Root cause.** A 2nd `GROUP_CALL_PRESENCE` envelope navigated to the incoming-call screen, unmounting the in-progress `GroupCallScreen`, whose `useEffect` cleanup calls `leaveInternal()` on the very room being joined. `GROUP_CALL_PRESENCE` is handled in `productionRuntime.ts`.

**Exact fix plan.** In the `GROUP_CALL_PRESENCE` handler (`productionRuntime.ts`), before navigating to `IncomingGroupCallScreen`, check whether a boot/join is already in progress for the same `roomId`/`conversationId`; if so, **suppress** the navigation (treat as the same call).

**What NOT to break.** Genuinely distinct incoming calls must still ring; only same-room duplicates are suppressed.

**Verify by.** Test: a `GROUP_CALL_PRESENCE` for a `roomId` currently mid-join does not trigger navigation/unmount. Manual: two near-simultaneous presence frames for the same room must not abort the join; `tearing down` must NOT follow `sfu.join started` within ~150 ms.

---

### B-12 â€” Ghost ring: host abandons room right after connecting; invitees keep ringing, no cancel signal **[P2, unfixed]**

**Symptom.** Host (itsirajul) leaves room `cfd14090` immediately after `sendTx connected`, before any invitee joins. Invitees keep ringing ~2.7â€“5 s with no cancellation, no "call cancelled" UI.

**Root cause.** No `sfu.ring.cancel`/`sfu.ring.cancelled` fan-out when the host leaves before anyone joins.

**Exact fix plan.** When the host leaves before anyone joins, emit a call-cancel/teardown (`sfu.ring.cancel` exists in the WS protocol per `sqa.md` Â§9 â€” **verify the exact event name**). Client: on `sfu.ring.cancelled`, stop the receiver ringtone and show a "call cancelled" notice. Server: fan-out the cancel to invitees.

**What NOT to break.** Cancel fan-out must not carry message content; route through existing WS presence/signalling.

**Verify by.** Test: host-leave-before-join emits a ring-cancel and invitees clear the ring. Manual: host starts then immediately ends â†’ invitees' ringtone stops within ~1 s with a cancelled-call indicator.

---

### B-09 â€” All group calls boot as `callType=voice` (video=false) **[P3, unfixed]**

**Symptom.** All 3 devices log `step=2 acquiring local media (video=false)` / `getLocalMedia video=false tracks=audio`. Every call starts audio-only; video depends on a fragile post-join `toggleVideo()`.

**Root cause.** `callType` is not propagated to the initial `getUserMedia`. `opts.callType` IS passed at `launchCall.ts:181`, but `useGroupCall` step=2 does not use it to request a video track.

**Exact fix plan.** Trace `callType` from `launchCall.ts:181` through `GroupCallScreen` into `useGroupCall` step=2 `getLocalMedia`; acquire a video track at boot when `callType==='video'` instead of deferring to `toggleVideo`. Verify against the SFrame attach ordering so the key/encryptor is ready before the video track is produced.

**What NOT to break.** Do not produce a video track before the SFrame encryptor/group key is ready (that is the B-07 failure mode).

**Verify by.** `useGroupCall` test: a video-type call requests `getUserMedia` with `video:true` at step=2. Manual: video call shows local camera live at join (`video=true tracks=audio,video`) without a manual toggle.

---

### B-13 â€” Last-joiner 2-tile layout race **[P2, unfixed â€” but mechanism as described is UNSUPPORTED by code]**

**Symptom (claimed).** Last joiner with `existingProducers=4` sees only 2 tiles instead of 3+.

**Root cause â€” CORRECTED.** The gap-fill traced the layout pipeline and found the analyst's stated mechanism ("the FIRST `recvTx 'connected'` triggers a re-render that freezes `paginateOthers` at 2 tiles") is **NOT supported by code**:

- `paginateOthers` is invoked from exactly one site (`GroupCallScreen.tsx:473-476`), a `useMemo` keyed only on `[call.remoteTiles, call.audioLevels]` â€” no `recvTx` coupling.
- The `recvTx` `connected` handler `onTxState` (`useGroupCall.ts:1091-1127`) never calls `setRemoteTiles`/`patchActiveGroupCall({remoteTiles})` â€” it only calls `dumpSelectedPair` and a `reconnectingâ†’joined` `setState`.
- Tiles are appended incrementally per successful consumer (`useGroupCall.ts:1533-1543`); `retainedRef` only **adds** tags; the `merged` cache cannot suppress a new tag (the signature includes the tag list). **No freeze mechanism exists.**
- The log's "frozen at 2 tiles" lines (6062, 6071, 7104, 7113) are **`â†³` inference annotations, not captured output**. All 4 consumers attached successfully (lines 6064-6070).

**Best hypothesis.** A blank/black tile (not a missing slot) is a **frame-delivery/decode** symptom â€” emulator **shared BlueStacks virtual camera** (sparse frames on all 3 instances) and/or the not-deployed SFU keyframe fix (`fe78c09`) and B-15 key mismatch â€” NOT a `paginateOthers` race.

**Exact fix plan.** Do **not** implement the analyst's "defer recvTx-connected handling" fix â€” it targets a coupling that does not exist. First **reproduce on real devices** (not BlueStacks shared camera). If a real layout race is found, batch the layout commit until all `existingProducers` are consumed (in the `useGroupCall.ts` step=9 loop + `groupCallLayout.ts`). Otherwise close as emulator artifact and prioritize deploying `fe78c09` + fixing B-15.

**Verify by.** Add a case to `groupCallLayout.test.ts` asserting a re-render after only 1-of-N consumes does not lock the tile count below N (will likely pass already, confirming the race is not in layout code). Manual on **real devices**: join last into a 4-party call and confirm all tiles appear.

---

### B-16 â€” `emitWithAck` default timeout 8000 ms too tight for Contabo latency **[P3, unfixed]**

**Symptom.** Amplifies B-05/B-06: `ack_timeout:sfu.producers` and `ack_timeout:sfu.transport.restartIce` once latency spikes.

**Root cause (source-verified).** `packages/messenger-core/src/transport/client.ts:151` â€” `emitWithAck<T>(event, data, timeoutMs = 8_000)`. At measured 2601 ms ping spikes that is ~3 round-trips before giving up.

**Exact fix plan.** Raise the default to `15_000` at `client.ts:151` (~5 RTT at 2601 ms). Low risk; pair with B-05.

**What NOT to break.** Confirm no caller hard-depends on the 8 s value for fail-fast UX.

**Verify by.** Grep callers of `emitWithAck`; run `npm run test:crypto` / transport tests. Manual: under simulated high latency, `sfu.producers`/`restartIce` succeed where they previously ack_timeout'd.

---

### B-07 â€” `toggleVideo` silently refuses when SFrame encryptor/rtpSender null **[P4, unfixed â€” UI feedback only]**

**Symptom.** User taps video and nothing happens; only a `console.warn`. (The key-DELIVERY bugs behind the null encryptor were already fixed by `e113b3c`/`25eb8f0`/`d435697`; only the missing UI feedback remains.)

**Root cause.** `useGroupCall.ts:~1928` returns silently when `(!enc || !rtpSender)` â€” i.e. the group master key hasn't arrived yet.

**Exact fix plan.** Replace the silent return with a visible toast ("Waiting for call encryption â€” try again in a moment") and a one-shot retry that re-attempts `toggleVideo` when the key lands (subscribe to the group key store like the joiner wait at `useGroupCall.ts:847`).

**What NOT to break.** Do not enable video before the encryptor is non-null (that is the whole point of the guard) â€” only add feedback + retry.

**Verify by.** `useGroupCall`/`GroupCallScreen` test: `toggleVideo` with null `enc` surfaces a user-visible message and retries on key arrival. Manual: tap video before the key lands â†’ toast appears, then video enables when key arrives.

---

## 5. Contradictions & uncertainties (re-verify before coding)

| #   | Open question                                                          | Status / what to do                                                                                                                                                                                                                                                                                                                                                 |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Was the 12:05:24 WS drop a crash (A) or heartbeat kick (B)?**        | **BLOCKED-ON-SERVER-LOGS.** No disconnect-reason logging on client or server. Circumstantial 171 ms simultaneity leans A, NOT proven. Run the B-05 grep set on `94.136.184.52` before choosing the root-cause fix (watchdog vs grace bump). The client reconnect fix is needed either way.                                                                          |
| 2   | **Test APK provenance (versionCode + git SHA)?**                       | **BLOCKED-ON-ARTIFACT.** Self-labeled v1046 = 1.0.46, versionCode 60â€“68; exact integer + SHA never captured (compounded by stale B-03 working tree). Cannot confirm which client fixes shipped. **Capture at every future build.** versionCodeâ†’SHA landmarks: `25eb8f0`â†’68, `9056c3a`â†’67, `e113b3c`â†’66, `b492876`â†’62, `6898fe3`â†’61, `49f02a5`â†’60.   |
| 3   | **Is the staging Docker image SHA â‰¥ `fe78c09`/`ad20d0f`?**           | **BLOCKED-ON-ARTIFACT.** Not captured; both commits are server-side and **not on `main`**, so CI could not auto-deploy. `fe78c09` was committed 11:55:59 and the call died 12:05:24 â€” only ~10 min later; a manual rebuild in that window is required for it to have been live, with no evidence it happened. **Read `docker images` / image label on the host.** |
| 4   | **Is B-10 closed by fixing B-15?**                                     | **No (gap-fill resolved).** B-10 is independent (14:43:07 tamper predates first poison by ~14 min). B-10 needs its own redistribution-ordering / recovery fix (shared with MSG-01).                                                                                                                                                                                 |
| 5   | **B-13 layout race real or emulator artifact?**                        | **Likely emulator artifact** (shared BlueStacks camera) + not-deployed `fe78c09` + B-15 key mismatch. The analyst's recvTx-coupling mechanism is **not in the code**. Reproduce on real devices before writing any layout fix.                                                                                                                                      |
| 6   | **MSG-01 reproducible outside the restart-heavy harness?**             | **Needs verification.** May be a stale-counter test artifact vs a genuine field bug.                                                                                                                                                                                                                                                                                |
| 7   | **`sfu.ring.cancel` exact event name (B-12)?**                         | **Needs verification** against the WS protocol types in `packages/messenger-core` before wiring.                                                                                                                                                                                                                                                                    |
| 8   | **Black video: client (`d435697`) vs server (`fe78c09`) attribution.** | Both can be true: the "pretty perfect" call benefited from the CLIENT tile-height fix while the SERVER keyframe fix was absent. Black-video was reduced but not provably eliminated until `fe78c09` is deployed.                                                                                                                                                    |

---

## 6. Suggested execution order

1. **OPS FIRST â€” pull server logs** for 12:04:30â€“12:06:00 on `94.136.184.52` (B-05 grep set) to settle crash-vs-heartbeat. **Capture the running Docker image SHA/label.** This unblocks the B-05 root-cause decision and confirms whether `fe78c09`/`ad20d0f` are live.
2. **OPS â€” deploy the server fix:** rebuild + redeploy `messenger-service` from a tree â‰¥ `fe78c09` (SFU keyframe) and `ad20d0f` (Redis fanout + iceTransportPolicy). Raise `WS_HEARTBEAT_GRACE 10000â†’25000` (`configuration.ts:17`). Add PM2/watchdog + uptime monitor. Confirm boot banner.
3. **CODE â€” B-15 (P0 security) first.** Design against the architecture doc, then implement the conversation-class split + admin/owner gate so a non-owner real-group host never mints/overwrites. Gate: write the failing `adhocCallKeyLookup.test.ts` case first â†’ fix â†’ `npm run test:crypto`.
4. **CODE â€” B-05 client reconnect â†’ auto-rejoin** in `useGroupCall.ts` (P1). Test with a simulated reconnect event.
5. **CODE â€” B-16** (`emitWithAck` 8000â†’15000) â€” low-risk, amplifier for B-05/B-06. Grep callers; `npm run test:crypto`.
6. **CODE â€” MSG-01 + B-10** (P1, group-key recovery + epoch redistribution ordering). Design against architecture doc. Then re-run Call-Gâ†’Call-H.
7. **CODE â€” B-06, B-08, B-12, B-09** (P2/P3) in that order. Each: targeted test first.
8. **CODE â€” B-07** (P4 UI feedback). **B-13:** reproduce on real devices before touching layout; likely close as emulator artifact.
9. **Regression gates (every change):**
   - `npm run test:crypto` (for any group-key/sealed-sender/call-key change).
   - `npm run typecheck` (mobile) and `cd apps/ops-console && npm run typecheck` â€” must NOT exceed baseline (mobile baseline **96**, `.tsc-baseline.json`).
   - `npm test` broad suite before declaring done.
   - For messenger-service changes: `cd apps/messenger-service && npm test`.
10. **3-emulator re-test matrix** (after deploy + B-15): re-run **Audio Calls Aâ€“H** rotating host across all three groups, then **Video Calls 1/1b/2**. Acceptance: every non-admin-hosted call now keeps the real master key (no owner poison); no `[group:recv] tamper detected` after a re-call; remote tiles paint (no multi-second black); a mid-call WS kill restores within 60 s.
11. **Do not commit on a red gate; do not use `--no-verify`.** Branch off â€” do not push to `main` directly.

---

## 7. Appendix

### A. Device / user / group mapping (authoritative)

| Emulator port | User          | App PID | Notes                                       |
| ------------- | ------------- | ------- | ------------------------------------------- |
| `:5555`       | **itsirajul** | 2861    | Raw-logcat readers mislabeled as fahim.     |
| `:5565`       | **shirajul**  | 2784    | Consistent across sources.                  |
| `:5575`       | **fahim**     | 2849    | Raw-logcat readers mislabeled as itsirajul. |

| Group id   | Owner / admin |
| ---------- | ------------- |
| `f956b212` | shirajul      |
| `3cb79cb1` | fahim         |
| `4100833d` | itsirajul     |

| Ad-hoc/call ids seen | Meaning                                          |
| -------------------- | ------------------------------------------------ |
| `0a99b93f`           | Call G minted key (fahim poisons `4100833d`)     |
| `de3dcd3d`           | Call H minted key (shirajul, cascade rotation)   |
| `cfd14090`           | Ghost-ring room (B-12)                           |
| `9f4935e9`           | envId of the silently-dropped group msg (MSG-01) |

### B. Key log signatures to grep

| Signature                                                                        | Meaning                                                                           | Refs                                      |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------- |
| `sfu.producers failed: 'transport not open'`                                     | WS drop / SFU transport dead (B-05)                                               | 5555:1117, 5565:3025, 5575:4783           |
| `ack_timeout:sfu.transport.restartIce`                                           | ICE-restart over dead WS (B-05)                                                   | 5555:1151-1152, 5565:3064-3065, 5575:4818 |
| `ack_timeout:sfu.producers`                                                      | reconcile timed out under latency (B-06/B-16)                                     | 5565:3060, 5575:4815                      |
| `connectionState=failed`                                                         | both transports dead, no rejoin (B-05)                                            | 5555:1155/1172, 5565:3068/3081, 5575:4821 |
| `EglRenderer â€¦ Frames received: 0`                                             | black/frozen remote tile                                                          | 5555:1131, 5565:3054, 5575:4792           |
| `[call-adhoc-key:runtime] key distributed delivered= â€¦ keyConvo=<realGroupId>` | **B-15 poison fired** (should NOT appear for non-owner real-group host after fix) | Call G `0a99b93f`, Call H `de3dcd3d`      |
| `[group:recv] tamper detected â€” dropping envelope`                             | group master-key divergence (MSG-01 / B-10)                                       | 6530-6531, 6885-6886 (14:43:07)           |
| `ACK ok envId=â€¦ handled=true`                                                  | relay ACKed despite client tamper-drop (MSG-01)                                   | envId `9f4935e9`                          |
| `sfu.join started` then `[bravo.groupcall.leave] tearing down` within ~150 ms    | boot-race join abort (B-08)                                                       | 11:34:56.820 â†’ 11:34:56.952             |
| `step=2 acquiring local media (video=false)`                                     | call boots audio-only (B-09)                                                      | all 3 devices                             |
| `[bravo.groupcall] reconnect -> rejoin`                                          | **new** log line to add for the B-05 client fix                                   | (after fix)                               |

### C. Source anchors verified during synthesis

- `productionRuntime.ts:2570` `ensureCallGroupKey`; `:2593` owner-equality resync gate; `:2629-2685` mint path; **`:2642` the poison alias write**; `:4311-4314` tamper drop+ack; `:4384` owner===sender forgery guard; `:4437` ghost-"Call" row skip; `:4466-4517` stale-epoch no-op/stash.
- `useGroupCall.ts:816` unconditional `ensureCallGroupKey` (no admin check); `:847` joiner key-wait; `:1091-1127` `onTxState` (no tile write); `:1533-1543` incremental `setRemoteTiles`; `:~1928` `toggleVideo` silent return.
- `launchCall.ts:155-193` real-group routing; `:181` `callType` passed.
- `groupClient.ts:291-299` `parseGroupMessage` â†’ `'tamper'`; `:508-538` `makeNewGroup`.
- `messengerStore.ts:742-744` `setGroupState` full overwrite.
- `sfu.service.ts:491-494` keyframe-on-resume (present, **not deployed**); `:52` `ZOMBIE_ROOM_GRACE_MS=60000`.
- `client.ts:151` `emitWithAck â€¦ timeoutMs = 8_000`; `:392-406` disconnect handler (no log).
- `configuration.ts:16-17` `WS_HEARTBEAT_MS=30000` / `WS_HEARTBEAT_GRACE=10000`; `redis-io.adapter.ts:70-71` â†’ socket.io `pingInterval`/`pingTimeout`; `main.ts:29-30,40` wiring.
- `GroupCallScreen.tsx:419-460` `merged` useMemo; `:473-476` sole `paginateOthers` call; `groupCallLayout.ts:170-193` pure layout.
- `android/app/build.gradle:108-109` `versionCode 68` / `versionName "1.0.46"`; `app.json:6` stale `1.0.41`; `.env.production` / `eas.json:26-27` Contabo URLs.
- `.github/workflows/deploy-messenger.yml:21-25` (push-to-`main` trigger only), `:41` (image tag `github.sha`). `fe78c09`/`ad20d0f` not reachable from `main`; local `main` HEAD `7239761` (2026-05-27).

---

## ADDENDUM (2026-06-07 evening) — status after the fix operation

1. **All 9 playbook bugs implemented locally** (working tree, NOT committed): B-15, B-05-client (reconnect->rejoin), B-16, MSG-01+B-10 (stash+resync notice), B-06, B-08, B-12, B-09, B-07. 12 files changed +999/-195, 10 new test files (119 tests), full suite 1037 pass, typecheck 55 <= 84 baseline.
2. **B-05 root cause CORRECTED via server logs**: not crash (container restarts=0) and not heartbeat. At exactly 06:05:24Z the gateway logged `[P0-6] disconnecting revoked socket` for all 3 QA subs — the revoked-JWT enforcement kicked them. Client fix (fresh-token reconnect + auto-rejoin) implemented; P0-6 itself untouched.
3. **Device-verified live** (Redmi Note 11, Metro): B-09 (`step=2 acquiring local media (video=true)`, `tracks=audio,video`) and B-06 (`step=1b sfu frame handler registered (pre-join)`).
4. **B-03 REOPENED — corrected**: the earlier "stale" verdict only checked the TS half. The NATIVE half `android/app/src/main/java/com/bravosecure/app/BravoFrameCryptorModule.kt` (+ package registration + io.getstream:stream-webrtc-android gradle dep) was NEVER committed. Not in git history, not in patches/, not in any clone on this PC. Group calls on any fresh-built APK fail closed at step=3: `FrameCryptor unavailable on this build (S6)`. The v1.0.46 QA APK works, so the source exists on whoever built it. RECOVERY OPTIONS: (a) get the file from the v1.0.46 build machine; (b) reimplement against the interface documented in frameCryptorTransport.ts + docs/ARCHITECTURE_AMENDMENT_SFRAME.md; (c) decompile the v1.0.46 APK from Firebase to confirm/reference.
5. **Still pending**: staging messenger-service redeploy (fe78c09 keyframe fix not live); 3-device QA matrix re-test for the multi-device fixes; B-05 minimize-restore gap; commit decision (everything is uncommitted by user order).
