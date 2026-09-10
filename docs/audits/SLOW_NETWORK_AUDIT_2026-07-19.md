# Slow-Network Audit — Messaging & Calling

**Date:** 2026-07-19 · **Build:** v1.0.117 / vc145 · **Scope:** 1:1 + group messaging, attachments,
1:1 + group calling, WS transport, HTTP client
**Method:** 8 parallel code-tracing lanes → cross-lane dedup → 18 adversarial verification passes
**Hypothesis under test:** _"Calls and messages are not network-friendly — on slower networks
messages take a long time to send and calls perform poorly."_

---

## 1. Verdict

**The hypothesis is half right, and the half that is right has a different cause than assumed.**

The assumption behind the hypothesis is that the app is naive about bandwidth — that it pushes
full-size media and high-bitrate video down a thin pipe. **That is largely false.** Bandwidth
adaptation in this codebase is genuinely well built (§3), in several places to a standard
comparable with WhatsApp.

The real defect class is **timeout discipline**, and it splits two ways:

|       | Pattern                                             | Effect on a slow link                                                                                           |
| ----- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **A** | **Unbounded waits** — no timeout at all             | A stalled request hangs for minutes; the user sees "sending…" forever with no failure and no retry              |
| **B** | **Fixed short deadlines that don't scale with RTT** | The app declares failure while the network is still working — and in the worst cases _actively degrades itself_ |

Pattern B is the important discovery, because it is **counterintuitive and self-inflicted**: several
mechanisms built to protect against bad networks _make slow networks worse_. The 5s send-ack
watchdog tears down a healthy-but-slow socket and re-handshakes (≈4 RTTs) on links where 5s is a
normal ack time. The 6s TURN ceiling strips relay candidates from exactly the cellular/CGNAT
networks that require them. The 60s download wall makes a large attachment fail at the _same_ point
on every retry.

So: **messages are not slow because bytes are too big. They are slow (or silently stuck) because
the app's deadlines are miscalibrated for high-RTT links, and its recovery paths have no deadlines
at all.**

---

## 2. Confidence & Method

65 findings were produced by 8 independent lanes tracing the actual code paths. The 18 highest-rated
were then handed to adversarial reviewers instructed to **refute** them and to hunt for compensating
code the finder missed.

| Verification outcome                          | Count |
| --------------------------------------------- | ----- |
| CONFIRMED (survived unchanged)                | 1     |
| PARTIALLY (mechanism real, impact overstated) | 17    |
| REFUTED (mechanism not real)                  | **0** |
| Severity downgraded after review              | 12    |

**Every mechanism reported here exists in the code.** Nothing was invented. But the first-pass
severities were systematically inflated, and the calibrated ratings below are the ones to trust.
The single P0 was downgraded to P1 because the failure self-heals when the device reaches a better
link — deterministic and bad, but not release-blocking by this repo's own P0 bar (B-75 txnChain
deadlock, B-100 call death).

**Independently re-verified by hand** (not just agent-reported): the 60s download abort, the dead
`xhr.timeout`, the 5s watchdog + `forceReconnect`, `MAX_ATTEMPTS=10` with `dueRows` selecting only
`pending`, the absence of `AbortController` in `relayClient.ts`, and the presence of group simulcast.

**Final severity distribution:** 6 P1 · 33 P2 · 12 P3 · 14 lower/duplicate.

---

## 3. What Already Works — Do Not "Fix" These

Stated first because the hypothesis assumed the opposite, and because a fix campaign that disturbs
this machinery would cause regressions.

**Messaging is architecturally sound for bad networks.**

- **Fully optimistic UI** — the bubble is appended and the input cleared _before_ any crypto or
  network await (`productionRuntime.ts:2705-2732`). A slow send never blocks typing.
- **Durable kill-surviving outbox** — every envelope is persisted to SQLCipher _before_ transport
  (`:2810-2823`), replayed on boot, on every WS reconnect, and on a 60s timer.
- **Idempotent by construction** — the relay dedupes on `(recipient, clientMsgId)`
  (`envelope.service.ts:157-176`), so WS+HTTP double-submission and manual retries are safe.
- **Steady-state warm 1:1 send costs ZERO HTTP round-trips** — one WS round-trip to single-tick.
  The sender cert is cached ~1h (single-flight, 10-min refresh margin); peer identity is cached 8 min.
- **Group fan-out is parallel**, not serial (`Promise.allSettled`, Fix #10) — the old 20×RTT cost
  was already fixed.

**Transport is tuned for flaky links.**

- Infinite reconnection, 500ms → 30s jittered backoff, websocket-only (no polling bloat).
- Server `pingTimeout` deliberately raised 10s → 25s so latency spikes don't reap calls (B-05).
  At 2000ms RTT the connection does **not** flap on heartbeats.
- NetInfo-driven reconnect, damped by pong-recency to suppress false alarms.

**Media is compressed and preview-first.**

- Camera/library photos compressed to 1920px / q0.8 before encrypt+upload (G10) — explicitly done
  because full-resolution was "the single biggest send+receive latency cost."
- A ≤48KB blurred thumbnail rides _inside the sealed envelope_, so the recipient sees a recognizable
  preview with **zero extra round-trips**.
- 200MB LRU ciphertext cache; forwards re-ship the existing object with no re-upload.

**Call media adaptation is real and good.**

- Capture is 480p@30 (max 720p) — never pegged at the sensor's 1080p mode.
- 1:1 video capped at **600kbps** with `degradationPreference='maintain-framerate'`; audio pinned to
  **32kbps** with `networkPriority='high'` (`useCall.ts:751-781`).
- Group video is genuine **3-layer simulcast** — 150k / 500k / 1.2M with `scaleResolutionDownBy`
  4/2/1 (`useGroupCall.ts:2084-2087`) — plus a conservative 200k start bitrate so TWCC measures real
  capacity before flooding the modem.
- Group audio is Opus mono 32k with **in-band FEC** (reconstructs a lost packet with no NACK
  round-trip — directly targets the lossy profile) and **DTX** (~5kbps in silence).
- Offscreen tiles are paused server-side; a getStats freeze-watchdog escalates keyframe → rebuild.

> **Correction to an earlier assumption in this investigation:** group calls were initially believed
> to lack bitrate caps. That was wrong — the simulcast ladder above is present and well-tuned.

---

## 4. Root Cause A — Unbounded Waits

RN's Android stack applies **no read timeout** (OkHttp defaults to 0 = infinite). A black-holed
connection — routine on 2G handover, NAT rebind, or "Wi-Fi with dead upstream" — therefore hangs
the promise for **minutes**, not seconds.

The codebase already knows this. `backupClient.ts:54` carries the fix and the reasoning
("H-14 — bound every request with an AbortController timeout. RN `fetch` can hang for minutes on a
black-holed connection"). `mediaClient` bounds at 60s, `linkPreview` at 5s. **The send path is the
sole outlier**, and it was never given the same treatment.

Unbounded call sites (verified — zero `AbortController` matches in `packages/messenger-core/src`):

| File                          | Line        | Path                                              |
| ----------------------------- | ----------- | ------------------------------------------------- |
| `relayClient.ts`              | 203         | message send / ack                                |
| `keysClient.ts`               | 168         | prekey bundle fetch                               |
| `senderCertClient.ts`         | 48, 95, 121 | cert issue / revoke / revocation list             |
| `api.ts` (`fetchWithRefresh`) | 199         | all messenger HTTP incl. group TURN, `/sfu/rooms` |

**Amplifier:** `drainOutbox` holds a global inflight guard and iterates rows **serially**
(`productionRuntime.ts:7290-7296`). One hung `relay.send` freezes _every_ queued retry to _every_
peer while the 60s ticks no-op. A 10-second blip becomes a multi-minute total send freeze.

**Why group is worse than 1:1:** the 1:1 hot path is WS with a 5s ack watchdog, so the unbounded
HTTP leg is only the _recovery_ path. **Group fan-out always uses HTTP by design**
(`:2580`) — so group sends are fully exposed, with no bounded leg at all.

---

## 5. Root Cause B — Fixed Deadlines That Fight the Network

These are the counterintuitive ones. Each was built as a safety net; each misfires on high RTT.

| Mechanism           | Value                    | Misfire                                                                                                                                                                                  |
| ------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Send-ack watchdog   | fixed **5s**             | Fires on routine sends at 1-2s RTT; each firing calls `forceReconnect()` — a full teardown + ~4-RTT rehandshake — losing all other pending acks, arming more watchdogs. Sustained churn. |
| Attachment download | fixed **60s** wall-clock | Non-streaming body, no Range resume, retry restarts at byte 0 → identical failure every attempt on the same link.                                                                        |
| TURN acquisition    | **6s** ceiling           | On 2G the fetch routinely exceeds it → call runs STUN-only for its entire life, on exactly the networks that need relay. Never re-fetched.                                               |
| `waitOpenThenSend`  | **4s**                   | Then drops the frame (see §6.1).                                                                                                                                                         |
| Outbox retry budget | **10 attempts**          | Offline fast-fails burn attempts in milliseconds; ~30-40 min offline exhausts the budget permanently.                                                                                    |

The app **already measures RTT** (`rttRegistry`) and does not feed it into any of these thresholds.

---

## 6. Calibrated P1 Findings

### 6.1 — 1:1 call offer/answer silently dropped when WS is down >4s ★ CONFIRMED

The only finding that survived adversarial review **unchanged**. The reviewer found _corroborating_
evidence rather than a compensator.

`waitOpenThenSend` (`signallingClient.ts:155`) polls for 4000ms, then falls through to `safeSend`,
which calls `transport.send()` — which **throws** `'transport not open'` when `!socket.connected`
(`client.ts:319`). The frame is logged and **dropped**. There is no re-send on reconnect.

**The code comment at `:180` is factually wrong.** It claims "socket.io buffers+flushes" — but
socket.io's `sendBuffer` only engages if `socket.emit()` is _reached_, and the wrapper's connected
guard throws first. Two tests pin this behavior (`transportBestEffort.test.ts:68`,
`transportClientWs.test.ts:81`).

**Compensators ruled out:** the reconnect re-send hub is group-call only (`groupCallRejoinHub.ts:88`
gates on `groupCallIsLive()`); chat sends get a 5s watchdog + HTTP fallback, but `call.*` frames have
**no HTTP path at all**.

**Impact:** a dropped `call.offer` leaves the caller at "Calling…" for the full 45s ring timeout while
_the callee never rings_. A dropped `call.answer` wedges the callee until the 20s watchdog fails the
call. The sharpest exposure is the **push-answered path**: app boots from Doze/kill, WS handshake
mid-flight, user taps Accept fast. `callController.ts:110-117` documents this exact field symptom
already — "both notification-answered calls sat in 'connecting' forever (caller rang out)". The 20s
watchdog was added to convert that hang into a failure; **it treated the symptom while the drop
survived.**

**Fix:** subscribe to the transport's `onStateChange` inside `waitOpenThenSend` rather than a 4s cap
(keep 1.5s for hangup), or re-send undelivered offer/answer from the per-`callId` queue on the next
`connected` transition while the ring timer is still armed. — _effort: day_

### 6.2 — 60s download wall makes large attachments unreceivable on a slow link _(was P0)_

`mediaClient.ts:231-232` aborts the blob GET after a hard-coded 60s with no size or progress
awareness. RN's fetch is XHR-backed (whatwg-fetch 3.6.20, resolves on full body), so the timer
genuinely covers the entire transfer. No Range resume; the cache fills only after a complete
`arrayBuffer()`, so partial bytes are discarded and **every retry replays the identical failure from
byte 0**.

The threshold is ≈bandwidth×60s: ~750KB at 100kbps, ~375KB at 50kbps. The code comment claiming
"60s covers a 50MB blob on slow cellular" implies 6.7 Mbps — wrong by ~2 orders of magnitude.

**Made worse by two things the finder missed:** `ChatScreen.tsx:2279` renders the `error` branch
_before_ the `thumbUri` branch, so the abort **replaces the blurred preview the app already holds**
with a broken-image icon. And `useAttachmentUri.ts:54` permits 4 concurrent resolves, splitting a
100kbps link ~4 ways during thread auto-load.

**Downgraded from P0** because it self-heals on a better link; it is only permanent if the R2 object
is purged first (30-day dwell / disappearing TTL).

**Fix:** replace the wall-clock timer with an **inactivity watchdog** (`onprogress` resets a 30s
no-bytes timer), or scale by the size hint already in `media_meta`. Render the thumbnail on error
instead of the broken-image icon. — _effort: hours_

### 6.3 — Outbox re-ships envelopes with an expired sender cert; group/media silently lost

Sender certs have a 1h TTL. Outbox rows store the **fully-sealed** envelope, and `drainOutbox`
re-ships those bytes unchanged — so a row queued >1h carries a cert the receiver hard-rejects
(+120s tolerance), and the receiver **destroys** the envelope.

Recovery exists **only for 1:1 text** (B-46 auto-resend, budget 1). 1:1 media flips to
`undelivered`; **group rows have no resend path at all** — while the drain has already flipped the
bubble to **"sent"**.

**Impact:** messages composed during a >1h gap (overnight dead zone, flight, tunnel commute) get
relay-accepted on reconnect and show a tick, but every recipient destroys them. Silent loss with a
success indicator is the worst possible failure shape.

**Fix:** at drain time, if the embedded cert expires within ~2 min, **re-seal** instead of
re-shipping. The `resealDeferredGroupRow` machinery already exists — extend it to stale 1:1/group
rows. — _effort: days_

### 6.4 — Group fan-out: ~115KB and 19 HTTP requests for one 1KB message to 20 members

There are **no Signal sender keys** — each group message is sealed N times
(`groupClient.ts:27-50`, deferred as architecture work). Per-copy amplification is ~6× (double
base64 + the sender cert embedded **twice**: once in `sealPayload`, again in the ECIES v3 outer
header), and the relay accepts **one envelope per request** — no batch route exists.

At ~50kbps up, one 1KB group text is **18-25s of pure upload**, and the 19 parallel POSTs saturate
the link, delaying heartbeats, receipts, and any queued 1:1 sends behind them.

**Fix (smallest diff):** add `POST /envelopes/batch` and ship one request. Stop double-shipping the
cert. Sender Keys remain the real fix. — _effort: days_

### 6.5 — Group key material sent fire-and-forget; rekey silently lost

All admin fan-outs (create / rekey / reshare) count `transport.send()` — a **buffered, unacked**
socket.io emit — as successful delivery, persist **no outbox row**, and fall back to HTTP only if
the emit throws _synchronously_. `removeGroupMember` then rotates the local key regardless.

**Impact:** a half-dead socket buffers and drops the rekey; the sender's epoch advances anyway;
members who missed it hit `no_key` on every subsequent message. Recovery is the self-heal
key-request loop (20s + 15s cooldowns, 2+ extra round-trips) — **a group can be unreadable for
minutes per key event.** This matches the recurring "group key missing" family QA keeps reproducing.

The text path was already fixed this way (`:2582` — "half-dead sockets would fool us"); **the admin
paths never got the same treatment.**

**Fix:** mirror the group-text path — enqueue a per-peer outbox row before shipping and use
`relay.send` (real 200) or track the `envelope.accepted` ack before counting delivered.
— _effort: day_

### 6.6 — No timeout on relay/keys HTTP (group path fully exposed)

See §4. Kept at P1 **for the group lane specifically** because group fan-out has no bounded WS leg;
the same defect on the 1:1 lane calibrates to P2 because WS + the 5s watchdog guard the hot path.

**Fix:** a shared `fetchWithTimeout` (AbortController, 15-20s) in `relayClient` / `keysClient` /
`senderCertClient`, mirroring `backupClient`'s H-14 pattern. Treat `AbortError` as transient
(`recordAttempt` + backoff) — server-side dedup already makes retry safe. — _effort: hours_

---

## 7. Notable P2 Findings

- **5s ack watchdog is not RTT-adaptive** — force-reconnects a healthy socket; matches B-72's
  observed 60-90s WS flapping with pending-flush re-loops. _Fix: `max(5000, 4×lastRttMs)` from the
  existing `rttRegistry`; HTTP-only on first miss, reconnect only after N consecutive misses._
- **Outbox budget exhausts in ~30-40 min offline**, then **nothing auto-sends** — `dueRows` selects
  only `status='pending'`, and offline fast-fails burn attempts in milliseconds. _Fix: don't count
  network-unreachable errors against the budget, or reset on a NetInfo `connected` transition._
- **Upload has no timeout at all** — `xhr.ontimeout` is registered but `xhr.timeout` is **never
  assigned** anywhere in the repo (verified), so it is dead code. A stalled upload hangs at e.g. 90%
  forever and blocks the serial media queue behind it.
- **Single-shot PUT with zero resume** — a disconnect at 99% wastes the whole transfer _and_ the UI
  state; the retry chip refuses ("re-attach and send the file again"). _Smallest fix: persist the
  source URI on the failed row so retry can re-upload without re-picking._
- **Videos upload raw** — only photos are compressed; a 1080p clip is 20-40MB → 45-90 min at 100kbps
  in one unresumable PUT, and unreceivable at the other end (§6.2).
- **6s TURN ceiling** → STUN-only for the call's whole life on high-RTT links; cross-NAT then gathers
  zero working pairs and dies at the 20s watchdog (~26s after dialing). _Fix: keep the boot ceiling
  but continue the fetch in background and hot-patch `iceServers` / ICE-restart when creds land._
- **No app-level degrade-to-audio** — stats are polled every 1s (1:1) / 500ms (group) and consumed
  **for display color only**. All plumbing exists (stats, `setParameters`, producer pause, banner
  host); only the hysteresis rule is missing.
- **Group-call boot has no wait/retry on any `sfu.*` step** — tapping call during a 1-3s socket gap
  gives an instant "Call failed" though the transport reconnects within ~500ms-2s. The 1:1 path has
  `waitOpenThenSend`; the group path has no equivalent.
- **Group-call host serializes 7-10 round-trips before recipients ring** — `sfu.ring` is the _last_
  boot step. _Fix: ring immediately after the `sfu.join` ack; recipients already tolerate
  key-in-flight via the 25s key wait._
- **`connectionStateRecovery` is inert in every deployment** — `WS_SESSION_RECOVERY` is unset
  everywhere, so the client's pid/offset machinery is dead weight. Consequence is narrower than first
  claimed (receipts and presence **do** have durable replay paths); already logged as **LC-7**.
- **Login errors surface raw axios strings** — the `/auth/login` 5-per-10-min throttle renders as
  _"Request failed with status code 429"_. `RegisterScreen.tsx:441-483` already has the correct
  mapping; login never got it. **This is the most likely explanation for the "network error on
  login" report** that opened this investigation — the backend was verified healthy
  (`/health` 200 in 0.6s, `POST /auth/login` returning a proper 400).
- **`completeAuth` swallows `/auth/me` failure** — after a _successful_ OTP verify, a 15s timeout
  leaves the user stranded on the OTP screen with no message and a now-consumed code. Only an app
  restart recovers. _A slow network is converted into an apparent login failure._

---

## 8. Recommended Fix Order

Ordered by user-visible value per unit of effort. The first four are **hours each** and remove the
majority of the "it just hangs" class.

| #   | Fix                                                                                                                   | Effort | Kills                                     |
| --- | --------------------------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------- |
| 1   | `fetchWithTimeout` (AbortController 15-20s) in `relayClient` / `keysClient` / `senderCertClient` / `fetchWithRefresh` | hours  | §6.6 + the drain-freeze amplifier         |
| 2   | Make the 5s ack watchdog RTT-adaptive; HTTP-only on first miss                                                        | hours  | The self-inflicted reconnect churn        |
| 3   | Download: inactivity watchdog instead of the 60s wall; render thumbnail on error                                      | hours  | §6.2                                      |
| 4   | Upload: assign `xhr.timeout` / progress-inactivity abort                                                              | hours  | Infinite 90%-hang + queue block           |
| 5   | Don't count unreachable-network failures against `MAX_ATTEMPTS`                                                       | day    | Permanent "failed" backlog                |
| 6   | `waitOpenThenSend` → state-change subscribe + offer/answer re-send                                                    | day    | §6.1 ★                                    |
| 7   | Group admin envelopes → outbox + real ack                                                                             | day    | §6.5                                      |
| 8   | Shared `httpErrorCopy` helper wired into Login/OTP screens                                                            | day    | The 429/"network error" confusion         |
| 9   | Re-seal stale outbox rows near cert expiry                                                                            | days   | §6.3 silent loss                          |
| 10  | `POST /envelopes/batch` for group fan-out                                                                             | days   | §6.4                                      |
| 11  | Degrade-to-audio hysteresis off the existing stats poll                                                               | days   | Sustained audio breakup on 2G video calls |

---

## 9. Limits of This Audit

- **No device testing was performed.** No device was connected via ADB; everything here is
  code-path analysis plus adversarial code review. Thresholds (e.g. "fails below ~100kbps") are
  computed from the code, not measured.
- **8 findings rated P0/P1 by their lane were not put through verification** (the verify pass was
  capped at 18). These are the four `known-history` items (B-119, B-100/B-101 device-verification
  debt, B-72 ordering residual, F-3 TURN recovery) and four `http-client` items (no transient retry
  interceptor, `completeAuth` swallow, login error copy, `fetchWithRefresh` timeout). Treat their
  severities as **unconfirmed**.
- **B-119 (1:1 video ICE never establishes) is open and rig-only.** If it reproduces on a real
  device behind a restrictive NAT, it is a direct confirmation of the "calls perform poorly" report
  and outranks everything in §8. **Verify this first.**
- **Which build produced the original report is unknown.** B-100/B-101 (calls dying at 10-16 min)
  shipped client-side only in v1.0.117/vc145 on 2026-07-19. If the complaints predate that build,
  a meaningful share of "calls perform poorly" may already be fixed and merely unverified on device.

---

## 10. Reproduce

```bash
# Unbounded send-path fetches (expect: no matches → no timeouts exist)
grep -rn "AbortController\|AbortSignal" packages/messenger-core/src/transport/

# Dead upload timeout (expect: no matches → ontimeout can never fire)
grep -rn "xhr.timeout" src/

# Fixed deadlines
grep -n "}, 5000)"        src/modules/messenger/runtime/productionRuntime.ts   # ack watchdog
grep -n "60_000"          src/modules/messenger/media/mediaClient.ts           # download wall
grep -n "timeoutMs = 4000" src/modules/messenger/webrtc/signallingClient.ts    # offer/answer drop
grep -n "MAX_ATTEMPTS"    src/modules/messenger/store/sqlOutboxStore.ts        # retry budget

# Confirm the good parts are real
grep -n "maxBitrate" src/modules/messenger/webrtc/useGroupCall.ts              # simulcast ladder
grep -n "WS_SESSION_RECOVERY" -r . --exclude-dir=node_modules                  # inert everywhere
```

---

## 11. Suggested `sqa.md` Entries

The following warrant bug IDs (next free: **B-120**):

| Proposed | Title                                                                                  | Sev |
| -------- | -------------------------------------------------------------------------------------- | --- |
| B-120    | 1:1 call offer/answer dropped when WS down >4s; no re-send                             | P1  |
| B-121    | 60s fixed download wall makes large attachments unreceivable on slow links             | P1  |
| B-122    | Outbox re-ships expired-cert envelopes; group/media silently lost while showing "sent" | P1  |
| B-123    | Group key material fire-and-forget over WS — rekey lost, group unreadable              | P1  |
| B-124    | No timeout on relay/keys/cert HTTP; one stall freezes the whole outbox drain           | P1  |
| B-125    | 5s ack watchdog not RTT-adaptive — force-reconnects healthy sockets (B-72 flapping)    | P2  |
| B-126    | Outbox retry budget exhausts offline; queued messages never auto-send again            | P2  |
| B-127    | Upload has no timeout (`xhr.timeout` never assigned) — infinite 90% hang               | P2  |
| B-128    | Login/OTP surface raw axios strings; 429 throttle unexplained to the user              | P2  |
