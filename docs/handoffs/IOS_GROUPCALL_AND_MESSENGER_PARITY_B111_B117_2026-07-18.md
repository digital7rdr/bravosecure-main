# B-111 … B-117 — iOS group-call gaps + messenger parity features: root causes, fix directions, per-item loops

**Date:** 2026-07-18 · **Status:** PLAN (every claim below file:line-verified in code before writing) · fixes follow AFTER this doc per founder instruction.
**Numbering:** continues sqa.md after B-110. Companion: `docs/handoffs/CALL_BUGS_B102_B109_FIX_PLAN_2026-07-18.md` (same loop discipline: fix → gates → device rows → sqa log → own commit; never trust a fix without its loop).

---

## Item index

| #     | Symptom                                                                                                                                                                                                                                                                                                            | Kind               | Severity               |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ | ---------------------- |
| P-0   | STAGING PREREQ: every group-call join rejected `token_secret_unset_prod` since the B-101 deploy                                                                                                                                                                                                                    | Server env         | 🔴 blocks all group QA |
| P-1   | STAGING PREREQ: `APNS_VOIP_*` env unset on messenger-service → iOS VoIP wakes skipped entirely (locked-screen iOS calls never ring). Steps + the mandatory 5s-contract device test: `docs/runbooks/IOS_CALLKIT_VOIP.md` (also needs the org-team explicit App ID — `docs/runbooks/IOS_README.md` action items 2-4) | Server env + Apple | 🔴 blocks iOS ring QA  |
| B-111 | iOS group calls fail 100% at the S6 FrameCryptor gate (by design — gate must NOT be relaxed)                                                                                                                                                                                                                       | iOS project        | 🔴 P0                  |
| B-112 | iOS VoIP push payload lacks callKind/roomToken/conversationId/fromUserId (Android parity)                                                                                                                                                                                                                          | Server             | 🟠 P1                  |
| B-113 | iOS never receives call-cancel push → CallKit keeps ringing after host cancels                                                                                                                                                                                                                                     | Server (+client)   | 🟠 P1                  |
| B-114 | iOS group-call audio routes to earpiece (chooseAudioRoute is Android-only, silent no-op)                                                                                                                                                                                                                           | Client             | 🟡 P2                  |
| B-115 | Names sometimes render as raw id fragments ("encrypted code") instead of the person's name                                                                                                                                                                                                                         | Client (+fetch)    | 🟠 P1                  |
| B-116 | Group "seen by" (who has seen a message) — WhatsApp message-info parity                                                                                                                                                                                                                                            | Feature            | 🟠 P1                  |
| B-117 | "X is typing…" indicator (1:1 + group) — WhatsApp parity                                                                                                                                                                                                                                                           | Feature            | 🟠 P1                  |

**Fix order:** P-0 → B-112 → B-113 → B-114 → B-111-A (interim UX) → B-115 → B-117 → B-116 → B-111-B (the FrameCryptor project, Mac-gated).

---

## P-0 — STAGING PREREQUISITE: `SFU_ROOM_TOKEN_SECRET` unset → all group joins rejected

**Diagnosed live 2026-07-18:** `bravo-staging-msgr` logs show every `sfu.join` since the B-100/B-101 deploy rejected with `[SFU] join rejected … reason=token_secret_unset_prod`. The P3-P-1 hardening (`messenger.gateway.ts:1586-1593`) correctly FAILS CLOSED in `NODE_ENV=production` when the secret is missing — and the box's compose msgr env (verified) has `NODE_ENV: production` and NO `SFU_ROOM_TOKEN_SECRET`. Pre-deploy the server silently open-admitted; the QA team's "group call failed" today is THIS (both platforms), layered on top of B-111 for iOS.
**The client is ready for the secret:** host self-token from `POST /sfu/rooms` (`useGroupCall.ts:229-238`), per-recipient tokens on the ring (`messenger.gateway.ts:1891-1913`), F7 re-mint retry (`groupCallReconnect.ts:107-137`, HTTP `GET /sfu/rooms/by-conversation/:id` at `useGroupCall.ts:412-425`).
**Fix (30 s of msgr downtime; NOT yet applied — SSH config-edit was permission-blocked, awaiting founder go-ahead):**

```
cd ~/bravo
cp docker-compose.staging.yml docker-compose.staging.yml.bak-sfutoken-20260718
SECRET=$(openssl rand -hex 32)
sed -i "/SFU_RTC_MAX_PORT:/a\      SFU_ROOM_TOKEN_SECRET: \"$SECRET\"" docker-compose.staging.yml
sudo docker compose -f docker-compose.staging.yml up -d messenger-service
```

```
LOOP P-0:
  1. Apply the env + recreate msgr (same compose file/env — no JWT-drift; msgr-only recreate).
  2. VERIFY boot: container healthy; `docker logs` shows NO token_secret_unset_prod after restart.
  3. DEVICE: Android↔Android group call (BlueStacks pair or QA devices) — host creates, invitee
     rings + joins; logs show token-verified joins (no room_token_required for tokened clients).
  4. REGRESSION: 1:1 call unaffected; old-APK clients (pre-token echo) would fail — confirm the
     QA fleet is on builds ≥ the row-#5 token echo (all 2026-07 builds are).
  5. Log outcome in sqa.md; keep the .bak for rollback.
```

---

## B-111 — iOS group calls fail 100% at the S6 FrameCryptor gate 🔴

**Root cause (verified):** `frameCryptorTransport.ts:63-70` — `isAvailable()` returns false when `Platform.OS !== 'android'` (:64) before even probing `NativeModules.BravoFrameCryptor`. That trips the S6/P0-C1 kill site `useGroupCall.ts:1408-1415`: after a SUCCESSFUL `sfu.join` the client logs "FrameCryptor unavailable on this build — refusing to start unencrypted group call (S6)", sets `'failed'`, and sends `sfu.leave`. Deterministic, 100%, looks like flakiness to peers because the iOS user flashes into the roster then vanishes.
**Why the gate is CORRECT and stays:** the SFU terminates DTLS-SRTP — without SFrame/FrameCryptor the server would see plaintext media. Relaxing S6 is an explicit CLAUDE.md security stop-condition. **No fix may touch this check.** (Already registered as 🔴 Critical in sqa.md §Known-Bugs: "No iOS FrameCryptor implementation → group calls refuse to start".)
**Why iOS lacks it:** Android gets FrameCryptor from the `react-native-webrtc` patch swapping in `io.getstream:stream-webrtc-android` + the native Kotlin module `BravoFrameCryptorModule.kt`; iOS runs the stock JitsiWebRTC pod, which does not expose FrameCryptor, and no Swift/ObjC counterpart exists.

### Phase A — interim honesty UX (ship now, small)

Today the iOS user sees a generic "failed" AND disturbs the room (join→leave flash). Fix direction: gate at the ENTRY POINTS, before any join:

- Where group calls start/accept on iOS (`launchCall.ts` group branch, `IncomingGroupCallScreen` accept, CallScreen Add-escalation, GroupCallScreen boot), check `frameCryptorOrchestratorAvailable()` FIRST; if unavailable → branded alert "Group calls aren't available on iOS yet — one-to-one calls work normally", never `sfu.join`. Incoming group rings on iOS: show the ring? Better: auto-decline via `sfu.ring.decline` + the same alert if tapped — the caller sees the member as unreachable instead of a ghost join/leave.
- Tell the testers now (this doc + sqa.md): iOS = 1:1 only until Phase B.

```
LOOP B-111-A:
  1. IMPLEMENT the entry-point gates (client only; S6 kill site untouched — diff must show zero
     changes in useGroupCall.ts:1403-1415 and frameCryptorTransport.ts).
  2. STATIC: crypto suite + tsc ≤ baseline; grep proves the S6 site byte-identical.
  3. ANDROID REGRESSION (BlueStacks): group call start/accept unaffected (gate returns available).
  4. iOS DEVICE (Mac QA member): start group call → immediate friendly alert, NO sfu.join in server
     logs, no roster flash on Android peers; incoming group ring → declined cleanly.
  5. sqa.md log; own commit.
```

### Phase B — the real project: FrameCryptor on iOS (Mac-gated, architecture-reviewed)

Not a patch — a genuine workstream. Engineering plan, every angle:

> **⚠️ Blast radius:** the pod swap replaces the media stack for **ALL iOS calls, 1:1 included** — not just groups. And the iOS build was only just stabilised (static frameworks + 6 patch-package patches, `docs/runbooks/IOS_BUILD.md`); swapping the WebRTC pod (currently stock JitsiWebRTC **124.0.2**) will likely break the build for a while. Budget for that, and re-verify every patch in `patches/` against the new pod.
> **⚠️ Interop bar:** key derivation + frame framing must match Android **byte-for-byte**. Slightly-off interop means calls CONNECT and then fail to decrypt — strictly worse than today's clean refusal. The cross-platform decrypt matrix in the loop below is the gate, not an option.

1. **Pod sourcing decision (do FIRST, spike):** the stock JitsiWebRTC pod exposes no FrameCryptor. Options, in preference order:
   a. **Stream's iOS WebRTC build** (mirror of the Android choice — `stream-webrtc-android`'s sibling; keeps vendor symmetry and their FrameCryptor API shape matches the Kotlin module we mirror);
   b. LiveKit's WebRTC pod (actively maintained, FrameCryptor exposed for their E2EE);
   c. custom libwebrtc build (last resort — owns the whole maintenance burden).
   Spike deliverable: a bare test app on the Mac proving `RTCFrameCryptor` attach on sender/receiver with the chosen pod + RN-WebRTC compatibility (the pod must still satisfy react-native-webrtc's headers — check the `@config-plugins/react-native-webrtc` interplay and the existing iOS patches in `patches/`).
2. **Swift module mirroring `BravoFrameCryptorModule.kt`:** same JS contract as `frameCryptorTransport.ts` expects (`isAvailable`, attach per-sender/per-receiver, key provider with ratchet/epoch semantics identical to Android — pull the exact method list from the Kotlin module; the JS layer must not fork by platform beyond the existing native-module indirection).
3. **Key/epoch parity:** SFrame key derivation + epoch rotation must match Android bit-for-bit (`frameCryptorOrchestrator.ts` drives both; epoch rotation on membership change only). Cross-platform test: Android↔iOS group call decrypts both directions after a member add/remove rekey.
4. **Remove the platform short-circuit LAST:** `frameCryptorTransport.ts:64` flips from platform-gate to capability-probe only when the native module reports available — S6 semantics unchanged (unavailable ⇒ still refuse).
5. **Architecture review BEFORE code:** group master key handling + E2EE media = CLAUDE.md stop-condition territory; the design (pod choice + key provider surface) goes past the System Architecture Documentation owner first.

```
LOOP B-111-B (per milestone, on the Mac):
  1. Spike sign-off → arch review sign-off → module skeleton w/ isAvailable false-path tests.
  2. Unit: key-provider parity vectors shared with Android (same inputs → same key schedule).
  3. DEVICE MATRIX (needs 1 iPhone + 1 Android minimum): iOS↔Android group voice; group video;
     member add mid-call (rekey); member remove (rekey + old member cannot decrypt); iOS
     backgrounded mid-call; 3-party with 2×iOS when hardware allows.
  4. SECURITY: verify the SFU NEVER sees plaintext (packet capture on staging SFU: payloads
     remain SFrame-wrapped); S6 refusal still fires when the module is deliberately disabled.
  5. Regression: Android group calls byte-identical behavior; 1:1 untouched.
  6. sqa.md + release notes; only then flip any default.
```

---

## B-112 — iOS VoIP push payload parity 🟠

**Root cause (verified):** `push.service.ts:1114-1121` — the APNs VoIP body carries only `{kind, callId, nonce, exp, sig}` per the ORIGINAL P1-N2 minimal-payload rule. The Android wake was later allowed richer fields under the **Ranak-approved 2026-07-05 §5-parity relaxation** (pseudonymous caller UUID + call kind + roomToken + conversationId ride the wake — see `messenger.gateway.ts:1917-1928` and the Android FCM branch), so the iOS branch is lagging an approved decision, not awaiting a new one.
**Effect:** group video rings as voice, CallKit shows "Bravo contact" instead of the local contact name (the client resolves names locally from the UUID — no display name crosses the wire), killed-app answer cannot route (no roomToken/conversationId).
**Fix direction:** mirror the Android field set EXACTLY into the APNs body (`callKind`, `fromUserId` (pseudonymous UUID), `roomToken`, `roomTokenExp`, `conversationId`) — nothing beyond what Android already ships (no display names, keeping the spirit of P1-N2); consume them in `withVoipCallKit.js`'s PushKit handler (callerName resolution stays client-side) + `voipPush.ts`.

```
LOOP B-112:
  1. IMPLEMENT server field parity + client consumption. Unit: extend the push.service spec to
     assert the APNs body fields mirror the FCM data fields for 1:1 + group wakes.
  2. STATIC: msgr-service jest green; service tsc clean. Confirm NO new field beyond the
     Android set (diff review — P1-N2 relaxation scope).
  3. DEPLOY staging msgr (with P-0 already applied).
  4. iOS DEVICE (Mac QA): killed-app group-video ring shows video UI + local contact name;
     answer routes into the right room (roomToken present). Android regression: wake unchanged.
  5. sqa.md log; own commit.
```

---

## B-113 — iOS never receives call-cancel 🟠

**Root cause (verified):** `push.service.ts:812-818` — `sendCallCancel` filters `platform === 'android'` and logs `no-tokens` for iOS-only users; there is no APNs branch. When the caller cancels, a killed/locked iPhone's CallKit ring keeps ringing until its own timeout.
**Fix direction (mind the 5-second contract):** a VoIP push on iOS MUST report a CallKit call within ~5 s (`IOS_CALLKIT_VOIP.md`; the AppDelegate handler reports unconditionally — `withVoipCallKit.js` PUSHKIT_METHODS). So the cancel must NOT ride a bare VoIP push unless the handler is taught to recognise `kind:'call-cancel'` and, instead of reporting a new call, call `RNCallKeep.reportEndCallWithUUID(callId, REMOTE_ENDED/UNANSWERED)`. That is the correct design: extend the AppDelegate PushKit handler with a cancel branch (report-then-immediately-end also acceptable per Apple, but direct end of the EXISTING ringing uuid is cleaner since the ring was started by an earlier VoIP push with the same callId=uuid). Server: add the APNs branch to `sendCallCancel` mirroring the FCM data payload.
**Watch:** entitlement risk — a malformed cancel handler that fails to report anything on a push is the revocation class the runbook warns about; the cancel branch must be try/catch-hardened with a fallback report+end.

```
LOOP B-113:
  1. IMPLEMENT server APNs cancel branch + AppDelegate cancel branch (withVoipCallKit plugin).
  2. UNIT: push.service spec — cancel fans to BOTH platforms; plugin transform test — the
     generated Swift contains the cancel branch and the unconditional-report fallback.
  3. DEPLOY staging msgr.
  4. iOS DEVICE (Mac QA): A rings locked iPhone, A cancels ≤5 s → CallKit ring stops ≤2 s,
     missed-call marker still lands; repeat with app killed. Regression: Android cancel path
     unchanged; iOS ring-answer flow unaffected (cancel branch only fires on kind=call-cancel).
  5. sqa.md log; own commit.
```

---

## B-114 — iOS group-call audio route 🟡

**Root cause (verified):** `GroupCallScreen.tsx:254-271` — the route defaults use `chooseAudioRoute?.('SPEAKER_PHONE'|'EARPIECE')`, an Android-only InCallManager API that is `undefined` on iOS → optional-chain silently no-ops → iOS group audio follows AVAudioSession defaults (earpiece for video calls).
**Fix direction:** platform-branch the default route: iOS uses `InCallManager.setForceSpeakerphoneOn(true)` for video / `(false)` for voice (and release the force on teardown so 1:1 and system audio aren't left forced); Android path untouched. Check the same pattern in 1:1 `CallScreen`'s route logic while there (it uses `pickAudioRouteNative` — audit its iOS behavior in the same loop, fix only if the same no-op class).

```
LOOP B-114:
  1. IMPLEMENT the iOS branch (+ teardown release). STATIC: tsc ≤ baseline.
  2. ANDROID REGRESSION (BlueStacks): group voice=earpiece / video=speaker defaults + route
     picker unchanged.
  3. iOS DEVICE (Mac QA): group video → speaker by default; group voice → earpiece, flip to
     speaker via picker works; after call ends, ringtones/media play on the normal route
     (force released). 1:1 unaffected.
  4. sqa.md log; own commit. (Blocked on B-111-A/B for real iOS group calls — until then this
     is verifiable only up to the route-force call firing in logs.)
```

---

## B-115 — Names must always be human (no raw-id "encrypted code" labels) 🟠

**Root cause (recon-verified):** the app has THREE name sources — address-book contact sweep (`useDiscoveredContacts.ts:88`, phone-paired peers only), the B-79 directory backfill (`useRegisteredNames.ts` → `getProfilesByIds`, **direct chats only and only while MessengerHomeScreen is mounted**), and the manual-only `groupMemberNames` map (written just by ChatInfo admin overrides + dept rosters). Everything not covered falls to raw-id fragments. Verified leak sites: `messengerStore.ts:610-614` (`Bravo · <hex8>`), `ChatScreen.tsx:2531` (`resolveSenderName` → `slice(0,8)` — checks contacts but NOT `groupMemberNames`), `CallsLogScreen.tsx:94`, `ChatInfoScreen.tsx:87`, `DepartmentChatScreen.tsx:232,427`, `GroupCallScreen.tsx:908` + `labelFor:1464-1467` (`tag.slice(0,6)`), `FloatingCallOverlay.tsx:389`, `IncomingGroupCallScreen.tsx:301`, `MainNavigator.tsx:519,606` (incoming-call stamp). **Smoking gun:** `ChatInfoScreen.tsx:295-300` already fetches `getProfilesByIds` and DISCARDS `displayName`, keeping only avatarUrl.

**Fix direction (no protocol change — the directory endpoint exists):**

1. Stop discarding: `ChatInfoScreen.tsx:295` also writes `displayName` into the member-name store map (admin overrides must still win — write only when no manual entry).
2. Group analogue of `useRegisteredNames`: a hook/sweep that collects the member userIds a screen is about to label as `slice(0,…)` (group threads, group call tiles, incoming group ring), batch-fetches `getProfilesByIds`, writes into the same store map `ChatScreen.tsx:1275` + `GroupCallScreen.labelFor` already read. Precedence: user custom name > address-book contact > directory displayName > hex fragment (last resort, unchanged).
3. Un-gate the existing direct backfill from Home-only: run the same one-shot on ChatScreen mount + on the MainNavigator incoming-call stamp (`:606`) so a cold-contact call ring upgrades to the real name within a beat.
4. `resolveSenderName` (`ChatScreen.tsx:2531`) consults the member-name map before falling back.

```
LOOP B-115:
  1. IMPLEMENT 1-4 + unit tests: precedence order pinned; discard-fix writes only when no
     manual override; hex fallback still works offline.
  2. STATIC: crypto suite + tsc ≤ baseline (store map changes touch messengerStore — run its suites).
  3. DEVICE (BlueStacks pair): cold contact calls → ring + thread + calls-log show the real name
     (no hex) after ≤1 fetch; group chat bubbles show member names; group-call tiles named;
     airplane-mode cold contact → hex fallback renders (no crash), upgrades when online.
  4. REGRESSION: is_custom_name renames survive sweeps (pinned test exists); dept rosters win
     over directory; log-audit test still green (names are fine to log per existing policy —
     do NOT add new PII logging anyway).
  5. sqa.md log; own commit.
```

---

## B-116 — Group "seen by" (message info) — WhatsApp parity 🟠

**Current state (recon-verified):** read receipts are a dedicated batched frame `{from, envelopeIds}` (`protocol.ts:289-292/:506-509`) with durable queue + live emit on the gateway (`messenger.gateway.ts:2207-2240`); the client sender flips own bubbles and honours the privacy toggle (`productionRuntime.ts:4393-4454`); inbound receipts advance own-sent bubbles by `envelope_id` (`:5052-5101`). **For groups there is NO per-member tracking**: `status` is a single scalar and the handler flips a group message to `'read'` on the FIRST member's receipt — WhatsApp semantics are "blue only when ALL have read". No `seenBy` anywhere.

**Fix direction (no protocol change — `from` already rides the frame):**

1. Add optional `receipts?: Record<userId, {status: 'delivered'|'read'; ts: number}>` to `LocalMessage`; populate keyed by `frame.data.from.userId` in the `read-receipt` handler AND the `envelope.delivered` handler.
2. Aggregate semantics fix: for group messages the scalar flips to `'read'` only when receipts cover ALL other members (and `'delivered'` likewise); 1:1 unchanged. This changes tick timing for groups — deliberate WhatsApp alignment, note in release log.
3. UI: long-press an own group message → "Message info" sheet — Read-by / Delivered-to lists with names (B-115 map) + timestamps.
4. Privacy: senders with receipts OFF already don't emit; the sheet must show "—" for members whose receipts never arrive (indistinguishable from offline — same as WhatsApp).
5. Persistence: receipts ride the message row (SQLCipher write-through + backup mirror serialize LocalMessage) — verify the mirror/restore round-trips the new optional field WITHOUT touching the Merkle write side (additive JSON field only; BACKUP_LOOP §2 check).

```
LOOP B-116:
  1. IMPLEMENT store field + both handler populations + aggregation. Unit tests FIRST:
     partial receipts don't flip the group scalar; full coverage does; 1:1 unchanged;
     duplicate receipts idempotent; receipts from non-members rejected (existing
     readReceiptAccepted guard keeps gating).
  2. STATIC: crypto suite (receipt tests live there) + tsc; backup suites (additive field
     must not break mirror encode/decode).
  3. DEVICE (3 accounts): A sends to group; B reads → A's tick stays single-grey/delivered,
     info sheet shows B read w/ timestamp; C reads → tick flips read; member with receipts
     OFF shows delivered-only. Kill/restart A → sheet still populated (persistence).
  4. REGRESSION: 1:1 ticks unchanged; unread badges unchanged; restore round-trip keeps
     receipts (or degrades gracefully to scalar — state which in sqa).
  5. sqa.md log; own commit.
```

---

## B-117 — "X is typing…" (1:1 named + group named) — WhatsApp parity 🟠

**Current state (recon-verified):** 1:1 typing is complete end-to-end (`ClientTyping` `protocol.ts:285-288`; gateway volatile relay + 6s auto-stop `messenger.gateway.ts:2163-2205`; `ChatScreen.tsx:587-602` sender; `TypingBubble` at `:1162`). Groups are EMULATED client-side: pairwise sends to ≤8 members (`TYPING_FANOUT_MAX_PEERS`, `ChatScreen.tsx:579`), and the receiver collapses everything to ONE anonymous boolean per conversation (`productionRuntime.ts:5103-5145`, `messengerStore.ts:109`) — a nameless "typing…" bubble, fully suppressed in groups >8. The architecture's "gateway typing fan-out" is aspirational — server only relays 1:1.

**Fix direction (client-only first; keep the pairwise transport):**

1. Store shape: `typing: Record<convId, boolean>` → `Record<convId, Record<userId, expiryTs>>` with a sweep that expires entries (mirror the server's 6s auto-stop); populate from `frame.data.from.userId` (already on the frame).
2. `TypingBubble` renders names via the B-115 map: "Alina is typing…", "Alina and Rafi are typing…", "Alina +2 typing…".
3. 1:1 keeps identical behavior (single-entry map).
4. The >8 suppression stays for now (documented); lifting it = server-side group fan-out (new `typing` group frame + membership check on the gateway) — flagged as follow-up, NOT in this pass (protocol addition = review).

```
LOOP B-117:
  1. IMPLEMENT map + expiry sweep + named bubble. Unit tests: entry expires ≤6s without stop;
     stop clears; two typers render both names; inbound message clears the sender's entry
     (existing :691 behavior preserved per-user).
  2. STATIC: crypto suite + tsc.
  3. DEVICE (3 accounts): 1:1 typing unchanged (bubble + auto-stop); group: B types → A sees
     "Callee QA is typing…" with the name; B and C together → both names; stop/expiry clears.
  4. REGRESSION: >8-member group still silent (no crash); blocked pairs still silent (M-07
     server drop untouched); rate limiter untouched.
  5. sqa.md log; own commit.
```

---

## Cross-item notes

- **Dependency spine:** P-0 unblocks ALL group-call QA (both platforms). P-1 + Apple App ID unblock iOS ring QA. B-115's name map is consumed by B-116's sheet and B-117's bubble — land B-115 first.
- **Security:** S6 untouched (B-111); no protocol/frame changes anywhere in B-115/116/117 pass 1; receipts stay privacy-gated; no new plaintext logging (log-audit test enforces).
- **iPhone rows** in every loop go to the Mac QA member; Android rows run on the BlueStacks pair. Mark skipped rows skipped — never passed.
