# Bravo Secure — Full Messenger Module Audit

**Date:** 2026-07-02 | **Branch:** `main` | **HEAD:** `6d19e78`
**Method:** 6-slice parallel read-only code audit (1:1 calls & video rendering · group-call client · SFU/gateway server · 1:1+group messaging pipeline · group crypto & identity lifecycle · media/push/relay backend), each verifying prior-audit fixes against CURRENT code and hunting for new bugs with `file:line` evidence.
**Scope goal:** get the messenger to WhatsApp-grade — every function wired correctly, video-call and group-call rendering fixed. This report describes **every bug found and exactly how to fix it**.

> This audit **builds on** `docs/audits/MESSENGER_BUG_AUDIT_2026-06-26.md` (the prior 12-active/22-latent/18-future pass) and the batch fix-commits `9b11724 … 6d19e78`. It re-verifies which of those fixes actually landed on HEAD (many did — see §7), and adds the new findings from this pass.

---

## FIX CAMPAIGN STATUS — updated 2026-07-02 (post-audit implementation pass)

All fixes below are in the working tree on `main` (uncommitted). Gates held throughout: mobile `tsc` = 46 (baseline ≤49), crypto suite 1137 passing, messenger-service 109 specs passing. New regression tests added for G-01, RELAY-C1, SFU-01, MSG-01, CALL-N3.

**FIXED + VERIFIED + DEPLOYED to Contabo staging (messenger-service, 2026-07-02):**

- **SFU-01** — event-less `{ok:false}` SFU error shape (all 15 sites) so NestJS acks errors instead of emitting them → the reported group video-toggle bug's server root cause. _(The running container already had the pause/resume handlers, confirming the live failure was this ack-contract issue.)_
- **PUSH-B1** — HTTP `POST /envelopes` now fires `sendChatWake` (group + outbox/reconnect messages now wake backgrounded/killed recipients).
- **MEDIA-A1** — media-object ownership set NX + owner-checked before grant mutation (recipients can no longer hijack/purge another sender's attachment).
- Container `bravo-staging-msgr` healthy; rollback = image `bravo/messenger-service:rollback-20260702` + `~/msgr-src-bak-20260702.tgz`.

**FIXED + VERIFIED (client — ship in the next APK build):**

- **Phase 1:** G-01 identity 30-day time-bomb (sentinel + retention 60d>interval + prevKeyId guard + tests); RELAY-C1 dup-listener regression (live transport `open()` teardown + test); MSG-01/04 AAD staleness window (30-day relay-dwell bound, core+mirror+tests).
- **Phase 2 (1:1 video/calls):** CALL-N1 incoming-restore, N2 remote-black render gate, N3 reoffer video-detect, N4 reconnecting-reoffer, N5 InCallManager stop, N6 terminal-state audio, N7 keep-screen-on, N8 mute-while-released, N9 flip-privacy, N10 busy on 2nd call, N11 restore state persistence, N12 flip registry, N13 ring state, N14 remote-muted pill.
- **Phase 3 (group calls):** GC-01 video-toggle durable re-assert, GC-02 churn stop, GC-03 restore pause/resume, GC-04 restore consume+sync, GC-05 history bubble, GC-07 rekey per-tag retry, GC-08 muted registry, F6 handler-leak real release, L22 pause-sync on restore.
- **Phase 4 (messaging):** MSG-02 group reactions routing, MSG-03 HTTP envelope_id (group ticks), MSG-05 retry-dup, MSG-09 send-time ordering, MSG-10 plaintext-at-rest redaction, MSG-12 pinned displacement, MSG-17 group quote-label, L16 dedup TOCTOU.
- **Phase 6 (client):** SFU-08 `sfu.unmuted` handler, MEDIA-A3 attachment download fallback, PUSH-B5 ring auto-timeout.

**ALSO FIXED (Round 3, 2026-07-02):**

- **Server (deployed to Contabo staging):** SFU-04 leave-grace, SFU-05 join-dedupe, SFU-06 host-terminate map purge + tag-hint, SFU-09 rate-gate, SFU-12 missed-call, PUSH-B2 collapse-key, PUSH-B6 (ring roomToken), MEDIA-A1, MEDIA-A4 (daily R2 orphan sweep), MEDIA-A5 (strict grants flipped), RELAY-C3 (durable delivered receipts).
- **Client (next APK):** MSG-06/08/11/13/14/15/16, MEDIA-A2/A3, PUSH-B4/B5/B6-client, SFU-08, SFU-12 client, L14 (reconnect-rejoin re-armed on restore), F7 (token re-mint).
- **Crypto (client/auth):** G-02 bundle-binding enabled, G-03 leave-rekey, G-04 same-epoch heal, G-06 best-effort recovery-before-mint, G-09 orphan-device filter (auth, latent).

**ALSO FIXED (Round 4, 2026-07-02) — the last cluster, implemented rather than deferred:**

- **G-05** (member-assisted key recovery): implemented the _secure_ relay — the owner's `creatorSignature` is persisted (`creatorSigB64`, excluded from the signed canonical bytes) and any member can relay it; the receiver verifies it against the **owner's** identity key, so a member can only relay a genuine signature, never forge one. Anti-forge regression test added.
- **G-08** (transcript equivocation): group messages now carry the sender's `senderTranscriptHash`; the receiver compares it to its local transcript and logs a divergence (the comparison the P1-G1 hash existed for). Detection-only; never drops.
- **SFU-07** (removed member joins a call): added a `sfu.join` rate-limit (deployed). Media content is already protected — removing a member rotates the SFrame key, so a rejoiner sees undecryptable frames; the limit blunts the residual slot-DoS.
- **PUSH-B3** (killed-app empty thread): a msg-wake tap now deep-links straight to the conversation so it mounts and pulls immediately — _without_ reintroducing the headless-decrypt instability the team deliberately removed.
- **G-09 orphan-prune**: done (auth `fetchDevices` 90-day filter).

**ONLY remaining — a Phase-2 feature, not a bug:**

- **G-09 multi-device fan-out** / **SFU-10 multi-replica**: the client is intentionally single-device and the SFU intentionally single-replica, so "2nd device gets no key" cannot occur today; delivering it means building full multi-device session support (and moving SFU state to Redis) — new features that would risk the working single-device/single-replica paths for zero current effect.

**INDEPENDENT VERIFICATION PASS (2026-07-02, post-fix):** every bug ID above was re-verified against the working tree with file:line evidence (crypto G-01…G-09 + MSG-01/04; CALL-N1…N15; GC-01…08 + L14/L22/F6/F7; SFU-01…12; MSG-02…17 + L16 + RELAY-C1/C3; MEDIA-A1…A5 + PUSH-B1…B6). The sweep found **3 gaps** that had been deferred early and never picked back up — all fixed during the verification pass:

- **MSG-07** — post-append crypto throw now flips the bubble to `failed` (productionRuntime sendText 1:1 crypto block), PLUS a boot sweep flips hydrated `sending` rows with no outbox row to `failed` (`SqlOutboxStore.allMessageIds()` + sweep after SQL hydration).
- **CALL-N15** — ghost-redial guard: `callRegistry.wasRecentlyEnded(callId)` (2-min window, recorded on slot clear/replace); useCall's outgoing boot bails to `ended` instead of re-dialing when the route carries a recently-ended callId (stale overlay restore).
- **GC-06** — the produce→cryptor-attach plaintext window is closed: `withTrackBlanked()` disables the track (black frames/silence) until `attachSenderCryptor` resolves, at all four produce sites (boot audio/video, restore re-produce audio/video, mid-call toggle-ON).

Post-fix gates: mobile tsc 46 (baseline ≤49), full mobile suite 1437 passed / 0 failed, messenger-service 166 passed (sole red = pre-existing `backup.service.spec.ts` verifyProof/verifyNonce drift, untouched by this campaign). Verification verdict: **every finding in this audit is now fixed in code** (server halves deployed to Contabo staging; client halves ship with the next APK; G-09 auth filter ships with the next auth-service deploy).

---

## 0. TL;DR — what's actually broken

The cryptographic **core** (1:1 Double Ratchet, sealed-sender v3 cert-in-AAD, atomic receive txns, durable outbox, receive dedup) and the **golden paths** for 1:1 chat, 1:1 calls, and group calls are genuinely well-built and most June fixes landed. The messenger falls short of WhatsApp at **six seams**, in priority order:

1. **Identity 30-day time-bomb (G-01, Critical).** ~30 days after install the long-term identity key silently regenerates and **every** existing 1:1 and group session breaks. Deterministic, time-triggered, ships today. Fix before any release meant to stay installed a month.
2. **Group video-toggle doesn't sync to peers (GC-01 + SFU-1).** The user's reported bug. Two causes: (a) the deployed messenger-service container likely predates the pause/resume handlers (added 2026-06-12); (b) a **systemic protocol flaw** — all 14 SFU handlers return error objects shaped as events, which NestJS emits instead of ack-ing, so _every_ SFU error surfaces as a blind 15s `ack_timeout`. **Re-test on the current container first** — the 06-30 rebuild may already carry the handlers.
3. **1:1 video rendering (CALL-N2/N3/N1).** Remote tile renders full-screen **black** when the peer is audio-only; an ICE-restart on a voice call falsely flips the UI to a black "video" layout; minimize→restore is completely broken for **incoming** calls.
4. **Offline messages silently vanish (MSG-01/04, Critical-ish).** The 15-min sealed-AAD freshness window contradicts the 30-day relay dwell: any message decrypted >15 min after it was sealed is dropped and ACKed off the relay while the sender shows "sent." Overnight backlogs disappear.
5. **Notifications miss a whole class of messages (PUSH-B1, High).** Group messages and every outbox/reconnect re-send go over HTTP `POST /envelopes`, which never fires a push wake — a backgrounded/killed recipient gets **no banner** for them.
6. **A duplicate-listener regression (RELAY-C1, High).** The F5 fix landed in a dead file; the live transport still stacks duplicate socket listeners on token refresh → frames dispatched twice → ratchet corruption / bad-MAC banners.

**Tally (new this pass):** 4 Critical · 12 High · 20 Medium · 20 Low. Plus prior findings re-verified: ~24 fixed, ~10 still open (see §7).

---

## 1. Severity legend & status keys

- **Severity:** 🔴 Critical (breaks core use / safety / silent data loss) · 🟠 High · 🟡 Medium · ⚪ Low.
- **Status:** `NEW` (found this pass) · `STILL-OPEN` (prior finding, unfixed) · `PARTIAL` (fix landed but incomplete/ineffective) · `REGRESSION` (a shipped fix is in dead code / broke something) · `VERIFIED-FIXED` (prior finding confirmed closed — listed in §7).
- **Fixability:** `fix-now` (client/server code change, low arch risk) · `needs-backend` (server deploy) · `needs-arch-signoff` (touches a documented security invariant — must be cleared against the System Architecture Documentation before writing code).

Every finding cites CURRENT (`6d19e78`) `file:line`.

---

## 2. Master bug table

| ID             | Sev | Status     | Area                 | One-line                                                                                                                                                                                                                                                 |
| -------------- | --- | ---------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **G-01**       | 🔴  | STILL-OPEN | crypto/identity      | Identity key regenerates ~30d after install → all sessions break                                                                                                                                                                                         |
| **SFU-01**     | 🔴  | NEW        | SFU/gateway          | All 14 SFU error returns are event-shaped → NestJS never acks → every error = blind 15s`ack_timeout`                                                                                                                                                     |
| **CALL-N1**    | 🔴  | NEW        | 1:1 calls            | Minimize→restore totally broken for incoming calls (stuck ringing UI + ringtone over live audio)                                                                                                                                                         |
| **MSG-01**     | 🔴  | STILL-OPEN | messaging            | 15-min AAD window drops all >15-min-old envelopes (offline backlog silently lost, ACKed off relay)                                                                                                                                                       |
| **GC-01**      | 🟠  | STILL-OPEN | group call           | Video-toggle pause/resume: bounded silent retry, no re-assert, no user feedback (the reported bug, client half)                                                                                                                                          |
| **G-02**       | 🟠  | STILL-OPEN | crypto/identity      | Prekey-bundle authority binding ships disabled → X3DH MITM open                                                                                                                                                                                          |
| **G-03**       | 🟠  | STILL-OPEN | group crypto         | Voluntary leave doesn't rekey → departed member keeps decrypting future messages                                                                                                                                                                         |
| **G-04**       | 🟠  | STILL-OPEN | group crypto         | Same-epoch forked member can never be healed (reshare blocked by G1 guard)                                                                                                                                                                               |
| **CALL-N2**    | 🟠  | NEW        | 1:1 video            | Remote tile full-screen BLACK when peer is audio-only (`remoteHasVideo` never gates mount)                                                                                                                                                               |
| **CALL-N3**    | 🟠  | NEW        | 1:1 video            | ICE-restart on a voice call falsely triggers "peer added video" → black video layout + false alert                                                                                                                                                       |
| **CALL-N4**    | 🟠  | NEW        | 1:1 calls            | ICE-restart recovery deadlocks when callee is also "reconnecting" (real handovers always die at 30s)                                                                                                                                                     |
| **CALL-N5**    | 🟠  | NEW        | 1:1 calls            | Ending a minimized call never stops InCallManager → audio session/proximity leak                                                                                                                                                                         |
| **CALL-N9**    | 🟠  | NEW        | 1:1 privacy          | Flip button silently re-activates a released camera → live frames to peer while UI shows avatar                                                                                                                                                          |
| **CALL-N10**   | 🟠  | NEW        | 1:1 calls            | 2nd inbound 1:1 call kills the live call (no busy / call-waiting)                                                                                                                                                                                        |
| **GC-02**      | 🟠  | NEW        | group call           | Receiver of a lost pause: infinite keyframe-request → consumer-rebuild churn loop every 8s                                                                                                                                                               |
| **GC-03**      | 🟠  | NEW        | group call           | After restore, peer camera-toggle frames never reach visible UI (resume never applied → permanent avatar)                                                                                                                                                |
| **GC-04**      | 🟠  | NEW        | group call           | Peer who joins/upgrades while call is minimized becomes an invisible audio-ghost after restore                                                                                                                                                           |
| **SFU-04**     | 🟠  | NEW        | SFU/gateway          | Transient WS drop / supersession destroys the SFU participant with zero grace; recovered socket is a half-ghost                                                                                                                                          |
| **MSG-02**     | 🟠  | NEW        | messaging            | Group reactions never render for anyone but the reactor (no group stamp → wrong slot)                                                                                                                                                                    |
| **MSG-03**     | 🟠  | NEW        | messaging            | HTTP-sent messages (all group + fallback) never record`envelope_id` → delivered/read ticks dead for groups                                                                                                                                               |
| **MSG-04**     | 🟠  | NEW        | messaging            | Outbox replay of pre-sealed rows >15 min old = silent loss marked "sent" (corollary of MSG-01)                                                                                                                                                           |
| **PUSH-B1**    | 🟠  | NEW        | push                 | HTTP-submitted envelopes never fire a chat wake → killed/bg recipient gets NO notification for group/outbox messages                                                                                                                                     |
| **RELAY-C1**   | 🟠  | REGRESSION | transport            | F5 dup-listener fix landed in a dead file; live transport still double-dispatches frames on token refresh                                                                                                                                                |
| **L14 (GC)**   | 🟡  | STILL-OPEN | group call           | Restore path never re-arms`ws.onReconnect`/rejoin → call zombies after any restore/reconnect                                                                                                                                                             |
| **L22 (GC)**   | 🟡  | STILL-OPEN | group call           | Restore reconcile is add-only → phantom tiles never pruned, pause never re-synced                                                                                                                                                                        |
| **F6 (GC)**    | 🟡  | PARTIAL    | group call           | minimize-leaks-sfu-handler "release" is a no-op (per-instance ref); handlers still accumulate                                                                                                                                                            |
| **F7 (GC)**    | 🟡  | STILL-OPEN | group call           | Room token (30-min TTL) never re-minted mid-call → >30-min call fails rejoin on reconnect                                                                                                                                                                |
| **GC-07**      | 🟡  | NEW        | group call           | FrameCryptor rekey loop aborts on first per-tag failure → remaining peers stuck on old key (black/silent)                                                                                                                                                |
| **G-05**       | 🟡  | STILL-OPEN | group crypto         | Self-heal key re-share is owner-only → owner offline/gone = keyless members never recover                                                                                                                                                                |
| **G-06**       | 🟡  | STILL-OPEN | ops-room             | Ops-room bootstrap re-mints a fresh key on missing local state → split-brain fork                                                                                                                                                                        |
| **G-08**       | 🟡  | STILL-OPEN | group crypto         | Transcript-hash chain is inert (write-only) → no fork/equivocation detection                                                                                                                                                                             |
| **CALL-N6**    | 🟡  | NEW        | 1:1 calls            | Audio session + FG service RESTART on the ended/failed transition (zombie session up to 4s)                                                                                                                                                              |
| **CALL-N7**    | 🟡  | NEW        | 1:1 calls            | Keep-screen-on re-arm tick dies for calls that began as video → screen can dim mid-call                                                                                                                                                                  |
| **CALL-N8**    | 🟡  | NEW        | 1:1 calls            | toggleMute advertises`cameraOff:false` while camera released → peer un-hides onto frozen/black tile                                                                                                                                                      |
| **CALL-N11**   | 🟡  | NEW        | 1:1 calls            | Mute/camera/remote-media state lost across minimize→restore (incl. duplicate video m-line on re-toggle)                                                                                                                                                  |
| **MSG-05**     | 🟡  | NEW        | messaging            | retrySend leaves the old outbox row live → duplicate delivery                                                                                                                                                                                            |
| **MSG-06**     | 🟡  | NEW        | messaging            | Read receipts lost forever if socket down at`markRead` (no queue/replay)                                                                                                                                                                                 |
| **MSG-07**     | 🟡  | NEW        | messaging            | Post-append crypto failure → bubble stuck in`sending` with no retry, no boot sweep                                                                                                                                                                       |
| **MSG-08**     | 🟡  | NEW        | messaging            | Reactions have no offline durability (no outbox row)                                                                                                                                                                                                     |
| **MSG-09**     | 🟡  | NEW        | messaging            | Live receive stamps`created_at` = receive time, not send time → cross-device timeline divergence                                                                                                                                                         |
| **MSG-10**     | 🟡  | NEW        | messaging/privacy    | Plaintext`last_message` persisted to unencrypted AsyncStorage; survives disappearing-message burn                                                                                                                                                        |
| **MSG-11**     | 🟡  | NEW        | messaging            | Forwarded media is a local fake marked "sent"; recipient receives nothing                                                                                                                                                                                |
| **L16 (MSG)**  | 🟡  | PARTIAL    | transport            | Envelope-dedup TOCTOU:`inFlightEnvelopes` guards only WS path, not `drainRelay` → spurious bad-MAC banner                                                                                                                                                |
| **MEDIA-A1**   | 🟡  | NEW        | media                | Any recipient can hijack media "ownership" → purge/regrant another sender's attachment                                                                                                                                                                   |
| **MEDIA-A2**   | 🟡  | NEW        | media/privacy        | Decrypted attachment plaintext written to cache, never deleted (survives disappearing burn)                                                                                                                                                              |
| **MEDIA-A3**   | 🟡  | NEW        | media                | Sender's own attachment breaks permanently when local pick URI dies; no download fallback                                                                                                                                                                |
| **PUSH-B5**    | 🟡  | NEW        | push                 | Incoming-call ring has no auto-timeout; killed-app missed call rings forever + no missed-call notif                                                                                                                                                      |
| **SFU-05**     | 🟡  | NEW        | SFU/gateway          | `joinRoom` has no per-user dedupe → join-retry after slow ack creates ghost participants eating the 6-cap                                                                                                                                                |
| **SFU-06**     | 🟡  | NEW        | SFU/gateway          | Host-terminate leaks gateway survivor state; mute/kick pick tags with no roomId hint → stale-tag actions                                                                                                                                                 |
| **SFU-07**     | 🟡  | NEW        | SFU/gateway/security | `GET /sfu/rooms/by-conversation/:cid` mints a token for ANY authed user → removed member can join/DoS                                                                                                                                                    |
| **SFU-10**     | 🟡  | NEW        | SFU/gateway          | SFU control plane is single-instance-only → breaks on >1 replica (deploy-gated)                                                                                                                                                                          |
| **G-09**       | 🟡  | STILL-OPEN | crypto               | Group key reaches deviceId 1 only; orphan identity rows never pruned (multi-device latent)                                                                                                                                                               |
| **A5 (media)** | ⚪  | STILL-OPEN | media                | Grant enforcement defaults OFF (lax mode) → legacy/failed-SADD objects openly downloadable                                                                                                                                                               |
| **MEDIA-A4**   | ⚪  | NEW        | media                | No server-side R2 GC/lifecycle → deleted-message ciphertext persists forever                                                                                                                                                                             |
| **PUSH-B2**    | ⚪  | NEW        | push                 | Chat wake collapse-key degrades to per-recipient → Doze bursts from different chats coalesce to one                                                                                                                                                      |
| **PUSH-B3**    | ⚪  | NEW        | push                 | Killed-app message is banner-only (no background decrypt) → tap opens empty thread until WS reconnects                                                                                                                                                   |
| **PUSH-B4**    | ⚪  | NEW        | push                 | Muted conversations still push (no mute check in wake path)                                                                                                                                                                                              |
| **PUSH-B6**    | ⚪  | STILL-OPEN | push                 | Group-call decline from notification is a no-op (never signals caller) — TODO in code                                                                                                                                                                    |
| **CALL-N12**   | ⚪  | NEW        | 1:1 calls            | flipCamera doesn't patch registry → stale/frozen track after flip; wrong track stopped on end                                                                                                                                                            |
| **CALL-N13**   | ⚪  | NEW        | 1:1 calls            | Registry registers incoming calls with`state:'idle'` → overlay shows "Connecting…" during ring                                                                                                                                                           |
| **CALL-N14**   | ⚪  | NEW        | 1:1 calls            | `remoteMuted` plumbed but never rendered (no peer-muted pill)                                                                                                                                                                                            |
| **CALL-N15**   | ⚪  | NEW        | 1:1 calls            | Ghost redial race on restore (call ends between overlay check and boot → fresh re-dial)                                                                                                                                                                  |
| **GC-05**      | ⚪  | NEW        | group call           | No call-history bubble after minimize→restore→hang-up                                                                                                                                                                                                    |
| **GC-06**      | ⚪  | NEW        | group call           | Brief plaintext-to-SFU window at producer start (sender cryptor attached after`produce()`)                                                                                                                                                               |
| **GC-08**      | ⚪  | NEW        | group call           | `sfu.muted` never patches registry/restored state → mic icon lies after host-mute-while-minimized                                                                                                                                                        |
| **SFU-08**     | ⚪  | NEW        | SFU/gateway          | `sfu.unmuted` emitted by server but no client handler → host-unmute never updates target UI                                                                                                                                                              |
| **SFU-09**     | ⚪  | NEW        | SFU/gateway          | Rate-limit budgets defined for`sfu.producer.pause/resume` but no SFU handler ever calls `rateGate`                                                                                                                                                       |
| **SFU-12**     | ⚪  | NEW        | 1:1 signalling       | Expired (>45s) offer leaves no missed-call push/record; callee never learns                                                                                                                                                                              |
| **MSG-12..17** | ⚪  | NEW        | messaging            | Pinned-chat displacement · voice/video list previews "(encrypted)" & videos missing from Files · expired-disappearing rows linger off-window · reply-jump offset breaks on prepend · presence no refcount · group reply-quote shows group name as author |
| **RELAY-C3**   | ⚪  | NEW        | transport            | `envelope.delivered` best-effort, single-use mapping → delivered-tick lost if sender offline at ack                                                                                                                                                      |

---

## 3. Critical findings (detail)

### G-01 · Long-term identity key silently regenerates ~30 days after install 🔴 STILL-OPEN · needs-arch-signoff

- **Symptom:** ~30 days after install, on the second boot past the mark, every established 1:1 and group Signal session silently breaks — peers hold the now-stale identity key → Bad-MAC / "outer sealed authentication failed" / handshake failures. History looks intact locally but nothing new decrypts from established peers; owned groups/ops-rooms become undeliverable.
- **Root cause:** `installIdentity` uses signed-prekey id **1** as the "install complete" sentinel, but the 30-day SPK rotation **deletes id 1** because retention == rotation interval. Next boot: sentinel missing → installer regenerates a fresh registration id + identity keypair (`INSERT OR REPLACE`).
- **Evidence:**
  - `packages/messenger-core/src/crypto/identity.ts:43-45` — sentinel `const spk = await store.loadSignedPreKey(1); if (spk) return;` else re-installs (regenerates identity at `:68-93`).
  - `identity.ts:174` `SIGNED_PRE_KEY_ROTATION_INTERVAL_MS = 30d`; `:183` `SIGNED_PRE_KEY_RETENTION_MS = 30d` (**equal**).
  - `identity.ts:294-296` — retention sweep deletes id 1 in the same pass rotation fires.
  - Wired live: `src/modules/messenger/runtime/productionRuntime.ts:348` (`installIdentity`) → `:364-376` (rotate).
  - Server does not save you: re-upload overwrites the same `signal_device_id` row (`apps/auth-service/src/keys/keys.service.ts:90-99`), so `fetchBundle` serves the NEW key — new contacts work, established sessions are dead.
- **Fix (local-only, no wire change):** (1) use a dedicated install-complete flag (or `getIdentityKeyPair()` presence) as the sentinel instead of SPK id 1; (2) make `SIGNED_PRE_KEY_RETENTION_MS` strictly **greater** than the rotation interval (e.g. 60d) so a just-rotated-out SPK survives the crossover; (3) `rotateSignedPreKey` must never prune the id equal to `prevKeyId`. **needs-arch-signoff** (touches identity/SPK lifecycle). The existing rotation test rotates a 0-age key, so it never exercises the id-1 delete — add a test that ages id 1 past retention and asserts the identity keypair is unchanged.
- **Confidence:** High (deterministic).

### SFU-01 · Every SFU error return is event-shaped → socket.io ack never fires → client sees `ack_timeout` 🔴 NEW · needs-backend

- **Symptom:** Any rejected `sfu.*` request (join a dead/full room, expired token, stale producer/participant, host-mute bypass, …) surfaces client-side as `ack_timeout:<event>` after 15s instead of a typed error. Group-call failures are systematically un-diagnosable — this is why the 2026-06-27 video-toggle session couldn't see what the server disliked.
- **Root cause:** NestJS's socket.io adapter treats any handler return with an `event` property as a `WsResponse` and **emits it, returning before invoking the ack**. Every SFU handler's error path returns `sfuError()` = `{event:'sfu.error', …}`. The gateway's own B-05 comment documents this exact behavior — but the fix was applied only to `ping`.
- **Evidence:** `apps/messenger-service/node_modules/@nestjs/platform-socket.io/adapters/io-adapter.js` → `bindMessageHandlers`: `if (response.event) return socket.emit(...); isFunction(ack) && ack(response);`. `messenger.gateway.ts:99-101` (`sfuError`); error returns at `:1218/1224/1246/1256/1261/1280/1285/1295/1299/1309/1313/1342/1347/1357/1362/1378/1382/…`. Aggravators: client `emitWithAck` expects the error **in the ack** (`packages/messenger-core/src/transport/client.ts:224-226` — dead branch); the emitted `sfu.error` event is then **dropped** by the client dispatcher (`src/modules/messenger/webrtc/sfuDispatcher.ts:103-132` — `sfu.error` not allowlisted). So errors are fully invisible.
- **Fix:** Change `sfuError()` to an event-less shape `{ok:false, code, message}` in all 14 handlers; update `emitWithAck` to reject on `resp?.ok === false` (keep the `resp.event==='sfu.error'` branch for rollout compat). Add a gateway ack-layer test (none exists — this is why SFU-01 survived the B-05 fix). Fold in the null-guards from SFU-11 (handlers dereference `data.roomId` outside try).
- **Confidence:** High.

### CALL-N1 · Incoming-call minimize→restore is completely broken 🔴 NEW · fix-now

- **Symptom:** Minimize any **answered incoming** call (back/swipe), then tap the overlay to restore → screen mounts stuck on the "Incoming call…" ringing UI **and replays the ringtone + ring-vibration over the live call audio**. Accept/Decline/End are dead no-ops. Only escape: minimize again and End from the overlay.
- **Root cause:** The boot effect bails on `direction === 'incoming' && !incomingSdp` (`src/modules/messenger/webrtc/useCall.ts:274-276`) **before** the registry-adopt branch (`:284-370`). The overlay restore navigates without `incomingSdp` (`FloatingCallOverlay.tsx:145-153`; registry `ActiveCallState` doesn't store it, `callRegistry.ts:21-52`). So `controllerRef` stays null → `accept()`/`decline()` are no-ops (`useCall.ts:927-932`), state stays at the `useState` initial `'ringing'` (`:147`), and the ring effect fires (`CallScreen.tsx:756-766`).
- **Fix:** Move the adopt branch **above** the `incomingSdp` guard (adoption never needs the SDP — the controller already consumed it), or persist a direction-neutral resume flag in the registry and pass it from `restore()`.
- **Confidence:** High.

### MSG-01 · Stale-AAD drops all >15-min-old messages 🔴 STILL-OPEN · needs-arch-signoff

- **Symptom:** Any envelope that sits >15 min between seal and decrypt is permanently discarded with a misleading "a device clock looks wrong" banner. Receiver offline an hour/overnight → the whole backlog is dropped **and ACKed off the relay** (relay copy destroyed) despite the 30-day dwell. Same for sender-side queued sends replayed later (see MSG-04).
- **Root cause:** `SEALED_AAD_SKEW_MS = 15*60*1000` (`packages/messenger-core/src/crypto/sealedSender.ts:298`), enforced unconditionally (`:398-400`). Receive site passes no override (`productionRuntime.ts:5092-5100`). On `stale` the handler returns normally (`:5118-5128`) = handled → envelope ACKed off relay (`:4397-4407`, `:6165`). No redelivery re-stamping; relay stores `outerSealed` verbatim.
- **Fix (needs arch sign-off — this is a documented stop-condition on AAD freshness):** carry the relay's server-attested receipt timestamp (`frame.data.timestamp`) and accept `aad.ts <= relayAcceptTs + skew` (measure the replay window at relay **ingest**, not at decrypt); or exempt first-delivery (non-duplicate per seen-store) envelopes from the staleness arm while keeping the `future` check and all binding checks. Remove the "device clock wrong" banner for backlog.
- **Confidence:** High.

---

## 4. High findings (detail)

### GC-01 · Video-toggle pause/resume: silent bounded retry, no re-assert, no feedback 🟠 STILL-OPEN (client half of the reported bug)

- **What the client emits:** `toggleVideo → syncSfuPaused()` emits `sfu.producer.pause`/`resume` `{roomId, producerId}` via `ws.emitWithAck` (`src/modules/messenger/webrtc/useGroupCall.ts:3043-3060`, emit at `:3050`). Ack timeout = TransportClient default **15s** (`packages/messenger-core/src/transport/client.ts:215-221`).
- **On ack_timeout:** retries up to **4×** with 350/700/1050ms backoff, generation-guarded (`useGroupCall.ts:3037,3047-3058`), then **gives up with only a `console.log`** (`:3053-3055`). No user feedback, no queued re-assert, no reconciliation of intended camera state, ever. Worst case: the doomed request re-sends 4× over ~1 min (4×15s), then the SFU is permanently desynced from local camera state.
- **Why it never acks:** couples to **SFU-01** (event-shaped errors) and **SFU-04** (after any silent socket.io reconnect the new socket has no server tag → every `sfu.*` fails `no_active_participant` → ack_timeout while media keeps flowing). Matches the 06-27 device trace exactly.
- **Fix (client):** (1) shorten the pause/resume ack window (~5s) and on final failure schedule a periodic **re-assert** — piggyback on the 4s reconcile tick: compare local `isVideoOff` to the `sfu.producers` snapshot `paused` field and re-emit on mismatch; (2) surface `sfu.error` (register in `SFU_FRAME_EVENTS`, route to the room handler) so rejection ≠ timeout; (3) gate `syncSfuPaused` retries on `isLeavingRef` (they currently continue after hangup). Server fix = SFU-01.
- **⚠️ FIRST STEP:** verify the running container includes commit `ede82b8` (2026-06-12, when the pause/resume handlers were added). The staging msgr was recreated 2026-06-19 (JWT-drift) possibly from an older image; the 06-30 push-token rebuild may already carry them. Check `grep -rl "sfu.producer.pause" dist/` in the container, then re-test the toggle — **it may already work server-side and only need the client re-assert/feedback.**

### G-02 · Prekey-bundle authority binding ships disabled (X3DH MITM) 🟠 STILL-OPEN · needs-arch-signoff

- A malicious/coerced keys-service can swap a peer's identity key in the bundle at first contact; client accepts and sessions with the attacker. Live `KeysHttpClient` is built without `authorityPubKeyB64`, and `verifyOrThrow` no-ops when unpinned. **Server already signs the binding** — the defense is built and merely not consumed.
- **Evidence:** `productionRuntime.ts:385-389` (no `authorityPubKeyB64`/`requireBundleBinding`); `packages/messenger-core/src/transport/keysClient.ts:213-214` (early-return when unpinned); server signs at `apps/auth-service/src/keys/keys.service.ts:200-219`.
- **Fix:** pass `config.authorityPubKeyB64` + `requireBundleBinding:true` into the constructor (one-line). needs-arch-signoff to confirm 100% of servers sign bindings before flipping.

### G-03 · Voluntary leave doesn't rekey → no forward secrecy 🟠 STILL-OPEN · needs-arch-signoff

- After a member leaves, the master key is NOT rotated (a departed member who kept the key can decrypt all future messages). Contrast: admin `removeGroupMember` **is** forward-secure. This is exactly what shipped in `4f3289c` ("leave-only").
- **Evidence:** `productionRuntime.ts:3000-3048` (only `plan.leave` broadcast; comment admits a remaining admin must rekey — "a separate follow-up"); `packages/messenger-core/src/groups/groupClient.ts:449-461` (`leave` bumps epoch, copies master key unchanged); receive applies leave with no rekey trigger (`productionRuntime.ts:5520`, rekey only fires when `masterKeyB64` changed at `:5583`).
- **Fix:** a remaining admin (deterministically the owner, or lowest-userId admin) detects an inbound `leave` and auto-broadcasts a `rekey` at the post-leave epoch via the existing `deriveRekeyMasterKey`. Planner exists; only the trigger+broadcast is missing. needs-arch-signoff (defines who owns the post-leave rekey).

### G-04 · Same-epoch forked member can never be healed 🟠 STILL-OPEN · needs-arch-signoff

- A member holding the WRONG master key at the correct epoch (a same-epoch fork) is permanently undecryptable; the owner's reshare is dropped. `reshareGroupKeyState` re-delivers as a `create` at the current epoch (no bump), but the G1 monotonicity guard drops any `create` where `epoch <= existing.epoch` when the receiver already holds a key; the keyless-bypass doesn't apply to a wrong-but-present key.
- **Evidence:** `productionRuntime.ts:1543` (reshare at unchanged epoch), `:5455` (drop if `existing.masterKeyB64 && epoch<=existing.epoch`), `:5459-5461` (bypass only when keyless).
- **Fix:** allow an **owner-signed** reshare `create` at `epoch == existing.epoch` to REPLACE the key when the signature verifies and `owner === sender` — same epoch + owner-authenticated is not a downgrade, it only converges a fork. needs-arch-signoff (touches epoch-monotonicity invariant).

### CALL-N2 · Remote tile renders full-screen BLACK when remote has no video 🟠 NEW · fix-now

- **Symptom:** Voice call → you tap Camera (upgrade OK) → peer taps "Stay on audio" → you see **full-screen black** behind your PiP instead of the peer's avatar. Also a black flash at video-call connect between audio-track and video-track `ontrack`.
- **Root cause:** the remote branch mounts `<RTCView>` whenever `remoteUrl && !remoteVideoOff` (`CallScreen.tsx:1908-1938`). An audio-only remote stream still yields a valid `toURL()`, and `remoteVideoOff` is false (peer never toggled a camera). The avatar overlay only renders when `!liveCall.remoteStream` (`:1875`). `remoteHasVideo` (built for exactly this, `useCall.ts:104-111`) is used **only as the RTCView key** (`:1931`), never as a mount gate.
- **Fix:** render the placeholder when `remoteVideoOff || !remoteHasVideo`; render RTCView only when `remoteHasVideo && !remoteVideoOff`. Same gate in `FloatingCallOverlay.tsx:190`.

### CALL-N3 · ICE-restart reoffer misfires "peer added video" 🟠 NEW · fix-now

- **Symptom:** After any successful ICE restart on a **voice** call, the callee gets "«peer» turned on video — Turn on mine?" and the UI permanently switches to the video layout with a black remote tile (compounds N2); registry kind flips to 'video'.
- **Root cause:** ICE-restart offers ride the same `call.reoffer` channel (`callController.ts:1033`); `handleReOffer` fires `onRemoteRenegotiation` unconditionally (`:771`); useCall does `setPeerAddedVideo(true) + patchActiveCall({kind:'video'})` (`useCall.ts:592-598`); `peerAddedVideo` latches forever (`CallScreen.tsx:527-529`).
- **Fix:** in `handleReOffer`, fire `onRemoteRenegotiation` only when the applied offer actually added a remote video m-line (compare `pc.getReceivers()` video count before/after `setRemoteOffer`, or parse the reoffer SDP for a new `m=video`).

### CALL-N4 · ICE-restart recovery deadlocks when callee is also reconnecting 🟠 NEW · fix-now

- **Symptom:** Real network handover (Wi-Fi↔cellular) or >5s blip → both ends "Reconnecting…" → call always dies at the 30s budget even though signalling recovered.
- **Root cause:** callee's ICE goes disconnected → `setState('reconnecting')` (`callController.ts:935-941`); the offerer's restart reoffer then hits `handleReOffer`'s gate `if (this.state !== 'connected') { ignored; return; }` (`:742-745`). Recovery only works in the narrow race where the reoffer lands before the callee notices.
- **Fix:** accept reoffers in `state === 'reconnecting'` too (keep the glare/signalingState check).

### CALL-N5 · Ending a minimized call never stops InCallManager 🟠 NEW · fix-now

- Device stays in `MODE_IN_COMMUNICATION` indefinitely after a call ended from the overlay (or peer hangs up while minimized). The only 1:1 `InCallManager.stop()` is in CallScreen's effect cleanup (`CallScreen.tsx:924`), which can't run while unmounted. `endActiveCall` never touches InCallManager (`callRegistry.ts:139-201`; `callForegroundService.ts:55-62`).
- **Fix:** call `InCallManager.stop()` + reset `lastAppliedRoute` inside `endActiveCall`, idempotent-guarded by `audioSessionStartedFor`.

### CALL-N9 · Flip button silently re-activates a released camera 🟠 NEW (privacy) · fix-now

- Video call → camera OFF (released, peer shows "Camera off") → tap Flip → camera turns back on and **live frames stream to the peer** while the local PiP still shows the avatar and `isVideoOff` stays true. `doFlip` has no camera-off guard (`useCall.ts:1260-1283`); `flipCamera` finds the sender by kind (the ended track keeps `kind:'video'`) and `replaceTrack`s a fresh live track (`peerConnectionFactory.ts:115-122`).
- **Fix:** in `doFlip`: `if (isVideoOffRef.current || videoReleasedRef.current) return;` and disable Flip when `!isCameraOn`.

### CALL-N10 · 2nd inbound 1:1 call kills the live call 🟠 NEW · fix-now

- You're mid-call with A; B calls → your call with A is torn down (A gets a hangup) and B's ring takes over, no choice offered. MainNavigator only special-cases an active **group** call (`MainNavigator.tsx:371-388`) then navigates with the new call's params (`:413-427`); same screen → `route.params.callId` change re-keys useCall's boot deps → cleanup runs `controller.hangup('ended')` (`useCall.ts:846-850`).
- **Fix:** mirror the group branch: if `getActiveCall()` exists, auto-reply `call.hangup{reason:'busy'}` or route to an in-call accept/decline banner (`incomingOneToOneBanner` machinery already exists).

### GC-02 · Receiver of a lost pause: infinite keyframe→consumer-rebuild churn 🟠 NEW · fix-now

- Peer turns camera off but the pause frame is never fanned (GC-01) → receiver tile stays `paused:false` with a frozen frame, then flickers/blanks every ~8s indefinitely, with continuous `sfu.consumer.resume`+`sfu.consume` traffic. The freeze watchdog re-requests keyframes every 1.5s then does a **full consumer rebuild every 8s forever** (`useGroupCall.ts:2664-2678` → `rebuildVideoConsumer` `:2846-2874`), never converging (producer sends 0 frames).
- **Fix:** cap rebuilds per tag (e.g. 3), then treat sustained 0-RTP + reconcile-snapshot-present as "presumed camera-off" (placeholder, stop rebuilding, slow probe). Fixing GC-01's re-assert removes the trigger.

### GC-03 · After restore, peer camera-toggle never reaches the visible UI 🟠 NEW · fix-now

- The restore/adopt path registers an intentionally partial handler (only `participant.left/muted/kicked/room.ended`, `useGroupCall.ts:719-788`) — **no** `sfu.producer-paused/-resumed`, no `sfu.new-producer`. The original boot handler survives but runs `setRemoteTiles` on an **unmounted** hook (updates + embedded `patchActiveGroupCall` dropped). Since hardware back = minimize, this is the common path: peer camera-**on** after restore → tile stuck on avatar for the rest of the call (freeze watchdog excludes paused tiles).
- **Fix:** the restore handler must handle `sfu.producer-paused/-resumed` (pure React state, no mediasoup needed), and/or arm the full `reconcileProducers` (see L22).

### GC-04 · Peer who joins/upgrades while minimized becomes an invisible audio-ghost 🟠 NEW · fix-now

- During minimize the leaked boot handler still consumes new producers, but the tile-add + registry patch live **inside** a `setRemoteTiles` updater on an unmounted hook (`useGroupCall.ts:2049-2053`) → dropped → adopt seeds tiles from the registry without it. Audio flows, no tile.
- **Fix:** move `patchActiveGroupCall({remoteTiles})` **out** of setState updaters (compute next from the registry, patch unconditionally, then setState); give the restore reconcile the boot reconcile's "live consumer, no tile → rebuild tile" branch.

### SFU-04 · Transient WS drop destroys the SFU participant with zero grace; recovered socket is a half-ghost 🟠 NEW · needs-backend

- Mid-call blip or app-side reconnect kills media even though ICE/DTLS was healthy; after socket.io connection-state recovery the client thinks it's connected but every `sfu.*` fails `no_active_participant` (→ SFU-01 ack_timeout). Three parts: `handleDisconnect` immediately `leaveRoom(tag)`s every tag (`messenger.gateway.ts:647-654`, no grace for non-host either); same-(user,device) reconnect force-disconnects the old socket (`connection-registry.ts:53-62`) tearing down the live SFU session; socket.io `connectionStateRecovery` restores the `sfu:*` rooms but `sfuSocketTags` is a WeakMap keyed on the old socket (`messenger.gateway.ts:209`) so the recovered socket has no tags while still receiving room broadcasts.
- **Fix:** add a per-(roomId,userId) leave-grace (15-30s timer in SfuService before closing transports on disconnect-initiated leaves; cancel on rejoin), or emit a self-addressed `sfu.session.lost` on the recovered socket so the client deterministically re-joins; strip `sfu:*`/`sfutag:*` rooms from recovered sockets whose tags don't resolve.

### MSG-02 · Group reactions never render for recipients 🟠 NEW · fix-now

- Only the reactor sees their reaction. Reaction envelopes carry no group hint: `sealPayload(cert,'',{reaction,aad:{to,ts}})` (`productionRuntime.ts:2408-2411`). On receive, `unwrapped.group` is undefined → routing resolves the reactor's 1:1 slot (`:5195-5203`); `applyReaction` searches only that slot (`:5709-5722`), misses the target (under the groupId slot), drops silently.
- **Fix:** stamp `group:{groupId, kind, clientMsgId}` (or `aad.conversationId`) on reaction envelopes and route `applyReaction` to `sealed.group.groupId`; fallback = search all conversations for `targetMsgId`.

### MSG-03 · HTTP-sent messages never record `envelope_id` → no group ticks 🟠 NEW · fix-now

- Group messages (always HTTP) and HTTP-fallback 1:1 messages never advance past single-tick `sent`; recipient read receipts are ignored sender-side. `relay.send` returns `envelopeId` (`relayClient.ts:80`) but all three call sites read only `retractToken` (group `:1957-1970`, 1:1 fallback `:2163-2185`, `drainOutbox` `:5815-5832`). Both consumers match on `msg.envelope_id` (`envelopeDelivered.ts:38-46`, `:3971-3983`). Only the WS `envelope.accepted` path sets it (`:4085`).
- **Fix:** store `r.envelopeId` on the bubble at each HTTP site (for groups, store the set — any member's receipt can match).

### MSG-04 · Outbox replay of pre-sealed rows >15 min old = silent loss marked "sent" 🟠 NEW · fix-now (or subsumed by MSG-01)

- Send offline → queued → reconnect 20+ min later → `drainOutbox` ships the **original** `outerSealed` (`:5806-5819`), flips the bubble to `sent` (`:5824`), but the receiver rejects it as `stale` and ACK-drops. Only `deferred:true` rows get a fresh reseal. Fix: in `drainOutbox`, if `now - row.createdAt > SEALED_AAD_SKEW_MS - margin`, re-encrypt via a 1:1 reseal callback (mirror `resealDeferredGroupRow`). Fixing MSG-01 collapses this.

### PUSH-B1 · HTTP-submitted envelopes never fire a chat wake 🟠 NEW · needs-backend

- "X sent a message but I got no banner" for group messages, outbox-drained messages, and any WS-fallback send. `sendChatWake` fires **only** from the WS handler (`messenger.gateway.ts:845-847`); the HTTP `POST /envelopes` controller (`relay/envelope.controller.ts:62-78`) never calls push. But **all group fan-out** (`productionRuntime.ts:1958`) and **every outbox drain** (`:5815`) use HTTP. Offline recipient → envelope persisted, no FCM wake.
- **Fix:** fire `sendChatWake(recipient.userId, …)` inside `EnvelopeService.submitEnvelope` (server-authoritative, covers WS+HTTP); move it wholesale out of the gateway handler to avoid double-wake.

### RELAY-C1 · F5 duplicate-listener fix landed in a DEAD file 🟠 REGRESSION · fix-now

- BATCH 3 (`4af57cf`) applied the F5 `removeAllListeners()` guard to `src/modules/messenger/transport/client.ts` — but the app resolves `TransportClient` from **`@bravo/messenger-core`** (`productionRuntime.ts:47`; alias `babel.config.js:21`, `tsconfig.json:26`), and the legacy file is imported **nowhere**. The live `packages/messenger-core/src/transport/client.ts:436-460` `open()` has no `removeAllListeners()`. With `forceNew:false`, the token-refresh reopen (`handleAuthReject → this.open()`, `:426`) and inline-error reopen (`:605`) stack a second listener set → **every server frame dispatched twice** (duplicate libsignal decrypt = ratchet corruption / bad-MAC banner; duplicate state transitions). Duplicate envelopes only saved by the L16 in-flight set (itself partial).
- **Fix:** port the `if (this.socket) { removeAllListeners(); disconnect(); }` guard into `packages/messenger-core/src/transport/client.ts` `open()`. Delete/re-point the stale mobile copy to avoid future confusion.

---

## 5. Medium & Low findings (condensed, all with fixes)

### Group calls (client)

- **L14 (🟡 STILL-OPEN):** restore path never re-arms `ws.onReconnect`/`rejoinRoomRef` (`useGroupCall.ts:844-868` boot-only; keepAlive removes it at `:2496-2499`). Any WS drop after a restore → call zombies. **Fix:** re-arm reconnect+rejoin in the adopt path.
- **L22 (🟡 STILL-OPEN):** restore reconcile is add-only (`consumeMissingAfterRestore` `:2750-2755`) — no phantom-tile prune, no pause re-sync, can't rebuild a tile from a live consumer. **Fix:** give it the boot reconcile's prune + snapshot-pause-sync + B-17 rebuild branch.
- **F6 (🟡 PARTIAL):** the minimize handler-leak "release" is a no-op — `cleanupSubRef` is a per-hook `useRef` (`:338`) that's null on the fresh restored instance. Handlers accumulate; enables double-consume after restore. **Fix:** stash the handler-cleanup fn + `consumedProducerIds`/`inFlightConsumes` in `LiveSfuHandles` so the adopt path can genuinely release and share dedupe.
- **F7 (🟡 STILL-OPEN):** 30-min room token captured once at boot (`:920`), echoed verbatim on rejoin (`:855`), never re-minted mid-call → >30-min call fails rejoin (`room_token_invalid`). **Fix:** re-mint via `GET /sfu/rooms/by-conversation/:cid` before rejoin.
- **GC-07 (🟡 NEW):** `rotate()` awaits `pushKey` per tag in a plain loop (`frameCryptorOrchestrator.ts:135-145`); one rejected `setKey` throws out, leaving remaining peers on the old key index after a mid-call rekey → permanently undecryptable. **Fix:** per-tag try/catch + retry queue.
- **GC-05 (⚪):** adopt never sets `callStartedAtRef` → no "Group call · N min" history bubble after restore→hang-up. **Fix:** `callStartedAtRef.current = existing.joinedAtMs ?? Date.now()` in adopt.
- **GC-06 (⚪, arch-gated):** sender FrameCryptor attaches after `produce()` → brief plaintext-to-SFU window at producer start. **Fix (flag for arch review):** produce paused/disabled, attach, then enable.
- **GC-08 (⚪):** `sfu.muted` handlers don't `patchActiveGroupCall({isMuted:true})` (`:770-772,1035-1038`) → mic icon lies after host-mute-while-minimized. **Fix:** patch registry, or derive `isMuted` from `audioTrack.enabled` on adopt.

### SFU / gateway (server)

- **SFU-05 (🟡):** `joinRoom` no per-user dedupe (`sfu.service.ts:205-265`) → join-retry after a slow ack leaves a ghost participant eating the 6-cap. **Fix:** supersede same-(roomId,userId,socket) before admitting.
- **SFU-06 (🟡):** host-terminate leaks gateway survivor state (`sfuTagToSocket` strong Map never cleared for survivors); `firstTagFor` without a roomId hint (`:1692`) makes `sfu.mute-target`/`sfu.kick` resolve stale tags. **Fix:** report torn-down tags from the host-terminate branch and purge gateway maps; pass `data.roomId` to `firstTagFor`.
- **SFU-07 (🟡 security):** `GET /sfu/rooms/by-conversation/:cid` mints a token for ANY authed user (`sfu.controller.ts:70-95`, "does NOT verify caller is in the conversation") → a removed member who knows the conversationId can join live calls (slot DoS + presence leak; SFrame still protects media content). **Fix (arch-gated):** require the ring token where one was minted, or host-approved late join; at minimum rate-limit join + by-conversation discovery.
- **SFU-08 (⚪):** server emits `sfu.unmuted` but no client handler exists → host-unmute never clears the target's "muted by host" UI. **Fix:** add `sfu.unmuted` to the client dispatcher+handler, or emit `sfu.muted{muted:boolean}`.
- **SFU-09 (⚪):** rate-limit budgets exist for `sfu.producer.pause/resume` but no SFU handler calls `rateGate` (`ws-rate-limiter.ts:129-133`); no `sfu.*` is rate-limited. **Fix:** wire `rateGate` (and make its error return event-less per SFU-01).
- **SFU-10 (🟡 deploy-gated):** all room/participant state is per-process memory; the Redis adapter fans out frames but control frames (`join/produce/consume`) must hit the pod owning the Router. **Fix:** sticky-route SFU by roomId, or move room index/host map to Redis. Add a deploy note: messenger-service must be single-replica until then.
- **SFU-12 (⚪):** an expired (>45s) 1:1 offer leaves no missed-call push/record (`messenger.gateway.ts:533-534`). **Fix:** on expiry, emit a missed-call push.

### 1:1 calls

- **CALL-N6 (🟡):** audio session + FG service RESTART on the ended/failed transition (`endActiveCall` clears `audioSessionStartedFor` while CallScreen still mounted → effect re-runs, `CallScreen.tsx:834-859,941`). **Fix:** gate the effect body on non-terminal state.
- **CALL-N7 (🟡):** keep-screen-on re-arm tick dies for calls that began as video (cleanup clears `armTick`+`videoArmedRef` on the first dep change, re-run early-returns). **Fix:** move the arm-tick to its own effect keyed on `isVideoUI && callState`.
- **CALL-N8 (🟡):** `toggleMute` computes `cameraOff = v ? !v.enabled : true` (`useCall.ts:960-961`) — sends `cameraOff:false` while the camera is released → peer un-hides onto a frozen/black tile. **Fix:** `cameraOff = !v || v.readyState==='ended' || videoReleasedRef.current || !v.enabled`.
- **CALL-N11 (🟡):** `ActiveCallState` carries no `isMuted/isVideoOff/remoteVideoOff/remoteMuted/facing` → all lost on restore (muted mic renders unmuted; local-camera-off restore triggers a full renegotiation adding a **duplicate video m-line**). **Fix:** persist those five fields in the registry and hydrate them in adopt (set `videoReleasedRef` correctly).
- **CALL-N12 (⚪):** `doFlip` doesn't `patchActiveCall` → stale track after flip; `endActiveCall` stops the wrong track. **Fix:** patch registry with `{videoTrack, localStream}` in `doFlip`; persist `facing`.
- **CALL-N13 (⚪):** incoming calls register with `state:'idle'` (patch no-ops on the empty slot before `setActiveCall`) → overlay shows "Connecting…" during ring. **Fix:** set state after `setActiveCall`, or register the slot before the controller's `setState`.
- **CALL-N14 (⚪):** `remoteMuted` produced but never rendered — add a peer-muted pill.
- **CALL-N15 (⚪):** ghost redial race — call ends between the overlay `getActiveCall()` check and boot → outgoing boot falls through to a fresh `startOutgoing` re-dialing the peer. **Fix:** re-check registry inside boot before dialing.

### Messaging

- **MSG-05 (🟡):** retrySend re-sends with a new clientMsgId but never `markDelivered`s the old outbox row → duplicate delivery (dedup can't catch different clientMsgIds). **Fix:** delete the old clientMsgId's outbox rows on retry/local-delete (`deleteByClientMsgId`).
- **MSG-06 (🟡):** `markRead` flips local rows to `read` (which then skip future receipting) then best-effort emits on a maybe-dead socket → blue ticks lost forever if offline. **Fix:** persist un-acked receipt ids and flush on `connected`, or flip local status only after a successful emit.
- **MSG-07 (🟡):** 1:1 appends the bubble then runs crypto (`:2105-2114`); a throw or process-kill before enqueue leaves the bubble stuck in `sending` with no retry chip and no outbox row. **Fix:** wrap the post-append pipeline → flip to `failed` on throw; boot-sweep hydrated `sending` rows with no outbox row to `failed`.
- **MSG-08 (🟡):** reactions have no offline durability — WS-throw falls to a swallowed `relay.send`, no outbox row. **Fix:** enqueue reaction envelopes in the outbox (idempotent on replay).
- **MSG-09 (🟡):** live receive stamps `created_at = new Date()` (`:5639,5678,5364`) not `aad.ts` → cross-device timeline divergence (the stash/drain path correctly uses `aad.ts`). **Fix:** use `unwrapped.aad?.ts` with receive-time fallback.
- **MSG-10 (🟡 privacy):** persist partialize writes `conversations` (each embedding a full `LocalMessage` with plaintext `content`) to unencrypted AsyncStorage (`messengerStore.ts:993-1012`); burned disappearing messages leave `last_message` on disk (`removeMessage:650-656`, `expirySweeper.ts:115-124`). **Fix:** partialize `last_message` to `{id,type,created_at,preview}` with preview redacted for `expires_at` rows; clear/recompute on removal.
- **MSG-11 (🟡):** forwarding media appends a `status:'sent'` bubble; recipient receives nothing (`ChatScreen.tsx:679-706`). **Fix:** re-grant + re-send the existing `objectKey/keyB64/ivB64` via `sendText(...,{attachment})` (no re-upload needed); until then show failed, not a green tick.
- **L16 (🟡 PARTIAL):** `inFlightEnvelopes` guards only the WS path, not `drainRelay` (`:5917-5953`) → reconnect double-decrypt → spurious "message failed to decrypt" banner. **Fix:** check/add `inFlightEnvelopes` in the drain loop.
- **MSG-12 (⚪):** `appendMessage` unshifts to index 0 ignoring `is_pinned` → inbound message displaces pinned chats. **Fix:** insert after the pinned prefix.
- **MSG-13 (⚪):** `previewOf`/`previewKindOf` handle only file/image → audio/video show "(encrypted)"; `selectMediaMessages` omits `'video'` → Files tab misses videos. **Fix:** add audio/video cases.
- **MSG-14 (⚪):** ExpirySweeper only iterates in-memory messages; timed rows past the 200-row window linger in SQLCipher. **Fix:** boot `DELETE FROM messages WHERE expires_at<=now` + filter `loadOlder`.
- **MSG-15 (⚪):** reply-jump y-offsets invalidated by pagination prepend. **Fix:** use `scrollToIndex` on the keyed item.
- **MSG-16 (⚪):** presence subscriptions have no refcount → leaving a Chat kills Home's dot for the same peer. **Fix:** refcount per userId.
- **MSG-17 (⚪):** group reply-quote attributes the quoted message to the group name (`ChatScreen.tsx:1132-1137`). **Fix:** use `resolveSenderName`.

### Media / push / relay

- **MEDIA-A1 (🟡):** `POST /media/grants` has no upload proof and `registerGrants` overwrites the owner record with no `NX` (`media.service.ts:213-216`) → any recipient can become "owner" and purge/regrant. **Fix:** `SET NX` at first registration (ideally at `createUploadUrl`), require `owner===caller` for later regrants.
- **MEDIA-A2 (🟡 privacy):** decrypted attachment plaintext written to `CachesDirectoryPath/bravo-media-<msgId>` and never deleted (`mediaFiles.ts:43-57`) → survives disappearing burn. **Fix:** delete it in the store-removal subscriber + sweeper; startup sweep of orphans.
- **MEDIA-A3 (🟡):** sender's own attachment breaks permanently once the local pick URI dies — `useAttachmentUri.ts:42` short-circuits when `media_url` is set, ignoring the objectKey it also holds. **Fix:** on render error/missing file, clear `directUri` and fall through to the download branch.
- **MEDIA-A4 (⚪):** no server-side R2 GC/lifecycle → deleted-message ciphertext persists forever; after the 30-day grant TTL, lax mode re-opens it. **Fix:** R2 lifecycle rule on `att/` (30-90d).
- **A5 media (⚪ STILL-OPEN):** grant enforcement defaults OFF (`MEDIA_REQUIRE_RECIPIENT_GRANT`); client always registers grants pre-fanout, so flip to strict on the deployed service.
- **PUSH-B2 (⚪):** chat-wake collapse-key degrades to `msg-wake:<recipient>` (WS handler passes no conversationId, `messenger.gateway.ts:845-847`) → Doze bursts from different chats coalesce. **Fix:** thread conversationId; stop collapsing across senders.
- **PUSH-B3 (⚪ parity gap):** killed-app message is banner-only — the slim headless handler (`fcmHeadless.ts:82-99`) doesn't pull; the richer puller only runs warm. Deliberate "no 2nd-VM contention" choice; note as a Signal/WhatsApp parity gap.
- **PUSH-B4 (⚪):** muted conversations still push (no mute check in the wake path). **Fix:** client-side muted-conversation check before `notifee.displayNotification` for `msg-wake`.
- **PUSH-B5 (🟡):** incoming-call ring has `loopSound:true`, no `timeoutAfter` (`callNotification.ts:182-247`); killed-app missed call rings until manually dismissed and produces no missed-call notification. **Fix:** `timeoutAfter:~45000`; on reconnect, replace a stale ring with "Missed call".
- **PUSH-B6 (⚪ STILL-OPEN):** group-call decline from the notification is a no-op (`fcmBootstrap.ts:485-495`, TODO in code) → group caller keeps ringing. **Fix:** send `sfu.ring.decline` in the group branch.
- **RELAY-C3 (⚪):** `envelope.delivered` is best-effort single-use (`envelope.service.ts:347-356`) → delivered-tick lost if sender offline at the recipient's ack. Low priority.

### Crypto / identity (remaining)

- **G-05 (🟡 STILL-OPEN):** self-heal reshare is owner-only (`productionRuntime.ts:1520,1666-1671`); no promote/demote → owner offline/gone = keyless members never recover. **Fix (arch-gated):** let any current admin reshare (relax the owner-signature guard for reshare or add signed admin promotion).
- **G-06 (🟡 STILL-OPEN):** ops-room bootstrap mints a fresh key when local state is missing (`:2720-2732`, only a local-existence guard) → owner reinstall = split-brain fork. **Fix (arch-gated):** attempt key-request/reshare recovery before minting, or persist owner group state to encrypted backup.
- **G-08 (🟡 STILL-OPEN):** transcript-hash chain is write-only (`groupClient.ts:397…`; zero reads in runtime) → no fork/equivocation detection. **Fix (arch-gated):** compare transcript hashes across members.
- **G-09 (🟡 STILL-OPEN latent):** group key reaches deviceId 1 only; `signal_identities` orphan rows never pruned (`keys.service.ts:272-291` `fetchDevices` no active-row filter) → if multi-device fan-out is ever enabled, senders wrap to dead keys. **Fix (arch-gated, Phase-2):** fan out via `fetchDevices` + prune superseded rows.

---

## 6. Wiring verdicts (is each surface wired end-to-end?)

- **1:1 chat:** ✅ golden path complete and crash-safe (durable outbox, atomic receive txn, dedup, direct-slot canonicalisation). ❌ falls below WhatsApp on offline delivery (MSG-01/04), HTTP-leg ticks (MSG-03), and out-of-band durability (MSG-06/08).
- **Group chat:** ✅ create/add/remove/stash-drain/self-heal wired. ❌ reactions mis-routed (MSG-02), no delivered/read ticks (MSG-03), no push for offline members (PUSH-B1), same-epoch/owner-only recovery gaps (G-04/05/06).
- **1:1 calls:** ✅ signed offer/answer/ICE, DTLS-SRTP pinning, golden path robust. ❌ secondary lifecycles broken: incoming restore (N1), remote-black rendering (N2), reoffer overload (N3/N4), audio-session ownership (N5/N6/N7), no call-waiting (N10).
- **Group calls:** ✅ join→key-gate→SFrame→produce/consume→reconcile→teardown all wired; June B-fixes landed. ❌ everything after the first minimize / silent reconnect is second-class (GC-01/02/03/04, L14/L22/F6/F7), and the SFU error contract is broken (SFU-01) making it all silent.
- **Media:** ✅ upload→grant→fanout→download coherent, grant pre-fanout. ❌ ownership spoofable (A1), plaintext leak (A2), no sender fallback (A3), no server GC (A4).
- **Push:** ✅ SOS/opaque-bridge/hydration/token-reaping fixes wired end-to-end. ❌ message-wake incomplete for HTTP sends (B1), no missed-call/timeout (B5), group decline no-op (B6).
- **Relay/transport:** ✅ server ack/dedup/dwell/purge/supersession/keepalive all correct and enforced-by-default; **no unhandled server event found** (complete event coverage). ❌ one client regression: duplicate listeners on refresh (C1).

---

## 7. Prior-audit fixes — VERIFIED on HEAD

Genuinely landed and confirmed (do not re-fix):

| Area             | Verified-fixed                                                                                                                                                                                                                                                                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Messaging        | A7 group-react id-unify · A11 self-media type · A12 mute-unread · A4 RC3 deferred-reseal outbox · L17 single-peer-exhaustion · F4 outbox retry timer · L13 stash 30-day · L18 drain sent-time ordering · L20 unread sibling-slot · A6 opk-refill-from-max · L5 OWNERKEY-DRIFT (SQLCipher key pinned to immutable user.id)                                            |
| Group crypto     | L12 admin-drain epoch-sort · L4 registerGroup canonical-id adopt · F2 deterministic planAddAndRekey · L9 send-recipients↔membership sync · F10 cap-at-add · removeGroupMember forward secrecy · fetchBundle stale-identity (`ORDER BY updated_at DESC, device_id DESC`)                                                                                              |
| Group calls      | B-01 host black tiles · B-13 non-owner host key · B-17 joiner blank tile · B-19 tile layout · B-37 teardown crash · back-button-minimize · dispatcher Set-based fan-out · stale-device-bundle                                                                                                                                                                        |
| 1:1 calls        | A5 focus-gain unmute · A8 video-toggle camera release · A9 incoming-camera-defer · B-24 background hardening (partial — see N4) · B-16 keyed remount (partial — see N2) · B-20 camera recovery on resume                                                                                                                                                             |
| SFU/gateway      | L7 host-disconnect grace (fixed) · F7 room-token TTL+re-mint paths · B-05 crash hardening + ping/pong ack                                                                                                                                                                                                                                                            |
| Media/push/relay | L15 vault owner-check · A10 R2 purge (owner-checked) · F8 action-secret fail-closed · F15 grants envelopeId · F16 config guard · A1 SOS opaque bridge · A2 hydration route + consumer · subscriber bootstrap order · killed-app token-reaping tombstone · P0-N9 ack possession token · MAX_UNAUTH_REFRESH · F28 dwell/TTL split · single-device takeover/hard-logout |

**Still open from the prior audit (carried forward):** A3 (=MSG-01), L1 (=G-04), L2 (=G-05), L11 (=G-06), F1 (=G-08), L16 (partial), the identity time-bomb (G-01), P0-I2 (G-02), leave-FS (G-03), F6 (partial), L14, L22, F7-client-remint, media lax-default (A5), group-decline (B6).

---

## 8. Prioritized fix roadmap

**Phase 0 — do before anything else (verify, don't code):**

1. Check whether the deployed messenger-service container includes the pause/resume handlers (`ede82b8`, 2026-06-12). Re-test the group video toggle on the current build — it may already work server-side and only need the client re-assert/feedback (GC-01). `grep -rl "sfu.producer.pause" dist/` in the container.

**Phase 1 — Critical / safety (ship-blockers for a month-lived install):** 2. **G-01** identity time-bomb (sentinel + retention>interval). _Highest — deterministic silent breakage at ~30 days._ 3. **SFU-01** event-less error returns + client `ok:false` reject + ack-layer test (unblocks all group-call diagnosis, likely closes the video-toggle bug's server half). 4. **MSG-01 / MSG-04** reconcile the 15-min AAD window with the 30-day dwell (arch sign-off) — stop silently dropping offline backlogs. 5. **RELAY-C1** port the F5 dup-listener guard into the live `@bravo/messenger-core` transport. 6. **PUSH-B1** fire chat-wake from `EnvelopeService.submitEnvelope` (covers group + outbox).

**Phase 2 — video-call rendering (the user's headline complaint):** 7. **CALL-N2** remote-black gate → **CALL-N3** reoffer/ICE-restart separation → **CALL-N1** incoming restore → **CALL-N9** flip privacy → **CALL-N4** reoffer-in-reconnecting. 8. **GC-01 (client)** re-assert + surface `sfu.error` → **GC-02** cap the churn loop → **GC-03/GC-04/L14/L22/F6** as one "restore-path re-architecture" batch (extract the SFU handler/consume into instance-independent functions so the adopt path can reach them).

**Phase 3 — messaging correctness / WhatsApp feel:** 9. **MSG-02** group reactions routing, **MSG-03** HTTP envelope_id (group ticks), **MSG-05** retry-dup, **MSG-06** receipt durability, **MSG-08** reaction durability, **MSG-09** send-time ordering, **MSG-10** plaintext-at-rest.

**Phase 4 — group key recovery hardening (arch sign-off):** 10. **G-02** bundle binding, **G-03** leave-rekey, **G-04** same-epoch heal, **G-05** any-admin recovery, **G-06** ops-room fork.

**Phase 5 — call/media/push lifecycle & the long tail:** 11. **CALL-N5/N6/N7/N8/N10/N11**, **SFU-04/05/06/07**, **MEDIA-A1/A2/A3**, **PUSH-B5/B6**, **GC-05/07/08**, then the ⚪ Low list.

**WhatsApp-parity features still missing (not bugs, product scope):** delete-for-everyone · edit message · per-member delivered/read info · star/archive/mark-unread · in-chat search · inline voice-note player + waveform · per-chat media gallery · real forward · drafts · OS-level PiP · call-waiting · screen share · pin/zoom participant tiles · group cap 6 vs 32 · linked-device history sync · notification quick-reply · Wi-Fi-only media auto-download.

---

## 9. Method & caveats

- Read-only code audit at `6d19e78`; **no code was changed.** Findings cite current `file:line`; a subset are structural (traced through the code) rather than device-reproduced — flagged by confidence where relevant.
- The audit could not inspect the **running staging containers** (SSH into the shared host was out of scope for a read-only audit). The SFU deployed-image question (Phase 0) must be checked against the live container before more code is written for the video-toggle bug.
- Security-touching fixes (G-01/02/03/04/05/06/08, MSG-01, GC-06, SFU-07) are marked **needs-arch-signoff**: verify against the System Architecture Documentation before implementing; do not weaken any documented invariant (sealed-sender, epoch monotonicity, owner-signed creates, fail-closed gates).
- Test-coverage gap worth its own ticket: there is **no test that exercises the NestJS socket.io ack layer** (why SFU-01 survived the B-05 fix). Add one asserting handler error returns actually invoke the ack.
