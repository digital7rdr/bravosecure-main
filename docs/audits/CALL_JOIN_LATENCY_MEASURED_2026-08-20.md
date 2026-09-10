# Call join latency — MEASURED (Step 0 of `CALL_JOIN_LATENCY_AUDIT_2026-08-20.md`)

**Date:** 2026-08-20 · **Build:** staging release APK built from the working tree of `feat/call-race-hardening-phase-5` @ `ec1a4dd1` + the uncommitted Step 0 instrumentation (see §0) · **Status:** INSTRUMENTATION LANDED; measurement runs recorded in §3 as they are captured.

This document is the companion of the audit: the audit explained the join chain from the code, this one turns it into numbers from release logcat. Everything here comes from `[CALLLAT]` rows (new in Step 0) plus the pre-existing `[CALLDIAG]`/`[CALLSM]`/`[LAGDIAG]` lanes and the staging relay's `[CALL]`/`[SFU]` lines.

---

## 0. What Step 0 shipped (the instrument)

- **`[CALLLAT]` lane** — `src/modules/messenger/runtime/callDiag.ts` `logCallLat(lane, id, step, fields, opts)` → `console.warn('[CALLLAT] lane=<1to1-in|1to1-out|grp-host|grp-join> cid=<8> step=<name> t=<ms since the lane clock started> dt=<ms since the PREVIOUS row of ANY kind on this lane> …ids only')`. One clock per lane+id (module map, 5-min TTL, pinned to one time axis for its life); `reset` restarts it (host start, launch tap); `freshAfterMs` continues a young clock but restarts a stale one (the "first sight" rows). The 1:1 lane ends on `state:ended|failed` (lane latched at claim time — not derived from the descriptor, which `end()` nulls first); the group lane ends on any terminal state (`left|failed|kicked|ended-by-host|unavailable`).
- **Markers** (all `console.warn`, release-visible): see the scan `src/modules/messenger/__tests__/callLatMarkers.test.ts` for the authoritative per-file list with counts. Lanes:
  - **1to1-in**: `offer:received {kind, reassert}` (MainNavigator — the offer/SDP reached this device), `notif:answer-tap {src, action}` / `nav:ready {waitMs}` (fcmBootstrap — Telecom + notifee lanes), `transport:live` (CallScreen — the runtime's transport object exists; NOT "socket connected"), `turn:start/ok/fail {ms}`, `controller:ready`, `tap:accept`, `accept:invoke {auto}`, `accept:wait-controller`, `pc:built`, `remote-offer:applied`, `pending-ice:drained {n}`, `media:start/ok`, `media:attached`, `answer:created {sdpLen}`, `answer:emitted {waitMs}` (socket-open wait only; the per-callId send queue is not in `waitMs` but IS in `dt`), `ice:gate-open {held}`, `ice:first-local {type}`, `ice:<state>`, `state:<next> {src}`, `dtls:ok {i}`, `audio-session:start`, `audio:first-inbound {bytes}` (one-shot per call, from the 1 Hz stats poller), renegotiation `reoffer:*`/`reanswer:*`, `js-stall {driftMs}`.
  - **1to1-out**: `launch {kind}` (reset), `turn:*`, `media:start/ok`, `controller:ready`, `pc:built`, `media:attached`, `offer:created {sdpLen}`, `offer:auth {signed}` (cert-cache hit vs miss is the `offer:created→offer:auth` gap: ms = hit, an HTTPS RTT = miss), `offer:emitted {waitMs}`, `ice:*`, `answer:applied`, `pending-ice:drained`, `state:*`, `dtls:ok`, `audio:first-inbound`, `audio-session:start`.
  - **grp-host / grp-join** (keyed by `conversationId`): `ring:received {room, replayed}` (MainNavigator, invitee origin), `notif:answer-tap`/`nav:ready`, `boot {dir, room}` (host: reset; invitee: continues the ring/tap clock — **`boot` is NOT t=0 on grp-join**), `turn:start`, `turn:resolved {ms, n}`, `room:created|existing {room}`, `media:start/ok {ms}`, `join:sent`, `join:ack {ms, existing, host}`, `key:ensure-start`/`key:ensured {ms}` (host), `key:wait-start`/`key:arrived {ms}` (invitee), `ring:send {n}`/`ring:ack {ms}` (host), `device:load-start`/`device:loaded {ms}`, `turn:awaited {waitMs, n}`, `transports:created`, `produce:start`, `produce:audio-ok {ms}`, `produce:video-ok {ms}` (**cumulative from produce:start — video-only cost is the dt between the two**), `consume:start {n}`, per producer `consume:ack/sdp/cryptor/resumed {ms since that producer's consume started, kind, tag, batch}`, `consume:done`, `presence:start {n}`/`presence:done {ms}`, `state:joined`, `audio-session:wait-bt` (one-shot per room), `audio-session:start {video}`, `audio:first-inbound {bytes}` (one-shot per boot), `state:<terminal>`, `js-stall`.
- **Relay**: `[CALL] OFFER recv …` now prints BEFORE the privacy await (wire order is visible), `[CALL] ICE ignored cid= reason=no_session|<state>` (console.warn) makes the B-596 drop countable, `[SFU] join.ack|transport.connect|produce|consume|consumer.resume rid= … ms=` handler durations (join's clock starts at the handler's first line, before the Redis rate counter), mediasoup `[SFU] tx.ice|tx.dtls rid= tag= send|recv state=` events.
- **Tools**: `scripts/calllat-capture.sh clear|dump <label>` (per-device logcat slice → `calllat-runs/`), `scripts/calllat-waterfall.mjs <logs…>` (per-call waterfalls split into segments + per-lane median/max tables).
- **Pins**: `callLatLane.test.ts` (clock semantics: t/dt/reset/freshAfterMs/end/TTL/axis pinning/js-stall liveness), `callLatMarkers.test.ts` (per-site counts, single-line rule, banned fields, latch, ms rows, relay lines), `messenger.gateway.offer-ordering.spec.ts` (B-596 DOCUMENTS + the ordered recv→ignored→OFFER log).

## 1. How to read the numbers (rules that keep the tables honest)

1. **Every step in a table is a named PAIR** `t(end) − t(start)` of two rows on the same lane; `dt` alone is "since the previous row of ANY kind" and is only quoted when the previous row IS the pair's start. Rows that carry their own `ms=`/`waitMs=` are quoted from that field.
2. **Lane origins**: 1to1-in = `offer:received` (warm lane) or `notif:answer-tap` (notification/killed lanes — whichever came first owns t0; the later one continues). 1to1-out = `launch`. grp-host = `boot` (reset). grp-join = `ring:received` or `notif:answer-tap`. The user-relative origin for the answerer is `tap:accept` / `notif:answer-tap`; ring→tap is reaction time and is reported separately.
3. **Same-conversation group calls** share a lane key; the waterfall script splits segments at a clock reset, a host `launch`/`boot dir=outgoing`, or a repeated non-replayed `ring:received`/`offer:received`. A rejoin within 90 s of the ring continues the same clock (intended — it is the same call).
4. **`transport:live`** means the screen obtained the runtime's transport object, not that the socket is connected; `transport:live → offer:received` brackets "socket up + replay" on the killed lane; `answer:emitted waitMs` is the socket wait on the answer itself. `transport:live` re-fires on every WS reconnect (large `t`).
5. **`[CALL] ICE ignored reason=no_session`** counts as a B-596 drop only when the same cid has an `OFFER recv` within ~1 s; `reason=ended` is benign late ICE; after the 60 s tombstone a late candidate also reads `no_session`.
6. **`js-stall {driftMs}`** rows come from `jsThreadWatchdog` (suppressed while the app is not `active` — the notification/killed lanes cannot see stalls before the app is foreground) and never count as lane liveness.
7. **Permission prompt**: the existing `[CALLDIAG] [bravo.callmedia] waiting on permission prompt` warn brackets a first-call dialog inside `media:start→media:ok`.
8. **Interleaving caveats**: a stale hook instance after minimize→restore can stamp the live clock (log-only); an 8-char id collision between lanes is theoretical (`direct:<uuid>` conversation ids collapse to `direct:X` — sequential calls reset anyway).

## 2. Device matrix and protocol

| Device                      | Role                 | Serial                           | Notes                                                                                               |
| --------------------------- | -------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------- |
| BlueStacks Rvc64 (SM-S908E) | caller / host        | `127.0.0.1:5555`                 | x86_64; camera HAL wedges (B-355) — voice runs preferred for the camera-dependent rows              |
| BlueStacks Pie64 (SM-G998B) | answerer / invitee   | `127.0.0.1:5556`                 | x86_64                                                                                              |
| Redmi 2201116SG             | real-device answerer | wireless adb (mDNS port rotates) | **not reachable this session** — `192.168.1.8:37979` refused; Wireless debugging must be re-enabled |

Protocol per run: `scripts/calllat-capture.sh clear` → perform the scenario → `scripts/calllat-capture.sh dump <label>` → pull the relay minute: `ssh -i ~/.ssh/bravo-deploy-ci admin@94.136.184.52 "docker logs -t --since 10m bravo-staging-msgr | grep -a '\[CALL\]\|\[SFU\]'"`. Interleave scenarios (A/B rule). Scenarios: 1:1 voice + video answered in-app; answered from the notification with the app backgrounded; answered with the app killed; group start (host) with 2 invitees; group join into a room of 3; killed invitee join.

## 3. Runs

_(filled in as runs are captured — one table per lane: step | median ms | max ms | n; plus the slowest run's waterfall)_

### 3.1 Build / install record

- APK: `android/app/build/outputs/apk/release/app-release.apk` (514,553,141 B, 2026-08-20 20:21 local) — built with `gradlew.bat assembleRelease` launched detached from PowerShell with the `apk:staging` env exported (the `npm run apk:staging`/`expo run:android` wrappers could not be used: `node_modules/.bin` was being restored, and `expo run:android --device` does not accept an adb serial). JS bundle verified to contain `CALLLAT`.
- Installed 20:23 with `adb install -r -t` → `Success` on **127.0.0.1:5555** (SM-S908E, lastUpdateTime 20:23:04) and **127.0.0.1:5556** (SM-G998B, 20:23:37).
- **Marker presence (founder rule — seen in a post-install release log): YES.** First rows from 5556's logcat after launch+call: `08-20 20:25:00.389 [CALLLAT] lane=1to1-out cid=d56201cf step=launch t=0 dt=0 kind=voice` … `step=offer:emitted t=567 dt=1 waitMs=0` (full waterfall below). `[LAGDIAG]` lines (8) also present → the watchdog is live on the build.
- Measurement limitation this session: 5555 stayed on the **Welcome / Sign In** screen (no account), and the relay showed only 5556's account (`1350939f`) online — so the **answerer lane (`1to1-in`) and both group lanes could not be exercised yet**. The three caller runs below rang an offline peer (`cf0a3de1`, "Smilee") and therefore stop at the offer/ICE stage (45 s ring → `state:ended`).

### 3.2 1:1 — answering phone (`1to1-in`)

| step (pair)                                                      | median ms | max ms |   n |
| ---------------------------------------------------------------- | --------: | -----: | --: |
| _not yet exercised — needs a second signed-in device (see §3.1)_ |           |        |     |

### 3.3 1:1 — calling phone (`1to1-out`) — BlueStacks 5556 (SM-G998B, x86_64), voice, warm app, callee offline, n=3

| step (pair)                                                       | median ms |  max ms |   n | notes                                                                                                                      |
| ----------------------------------------------------------------- | --------: | ------: | --: | -------------------------------------------------------------------------------------------------------------------------- |
| `launch → transport:live`                                         |        45 |      54 |   3 | CallScreen mounted with a live transport                                                                                   |
| `turn:start → turn:ok` (**TURN credential fetch**, own `ms=`)     |   **300** | **442** |   3 | 164 / 300 / 442 ms — **46–76 % of the time to the offer**; warm socket, same LAN; per-mount, never cached                  |
| `turn:ok → media:start`                                           |        12 |      17 |   3 | the hook bails until `iceServers` resolve, then boots                                                                      |
| `media:start → media:ok` (getUserMedia, mic only)                 |         6 |      35 |   3 | BlueStacks mic; a real camera will be far larger                                                                           |
| `media:ok → controller:ready`                                     |         0 |       1 |   3 |                                                                                                                            |
| `state:calling → pc:built`                                        |         4 |      27 |   3 |                                                                                                                            |
| `pc:built → media:attached`                                       |         3 |      15 |   3 |                                                                                                                            |
| `media:attached → offer:created`                                  |        32 |      45 |   3 | createOffer + setLocalDescription                                                                                          |
| `offer:created → offer:auth` (**buildOfferAuth**, cert-cache HIT) |    **78** |      80 |   3 | XEd25519 sign + cert read; a MISS would add an HTTPS RTT                                                                   |
| `offer:auth → offer:emitted`                                      |         1 |       3 |   3 | `waitMs` 0 / 0 / 3 — socket already open                                                                                   |
| `offer:emitted → ice:gate-open`                                   |         0 |       0 |   3 | `held=0` every run                                                                                                         |
| `ice:gate-open → ice:first-local`                                 |         0 |       2 |   3 | **the first host candidate is gathered in the same millisecond as the offer emit** — it rides the same TCP read (see §3.5) |
| **`launch → offer:emitted` (total)**                              |   **567** | **580** |   3 | 356 / 567 / 580 ms — TURN is the only big row                                                                              |
| `audio-session:start`                                             |      t=95 |      95 |   3 | fires at `state=idle` on the outgoing lane (InCallManager started before the controller exists)                            |
| `offer:emitted → state:ended`                                     |    45 010 |  45 016 |   3 | the 45 s ring window, callee offline (`OFFER result ERR=peer_offline`)                                                     |

### 3.4 Group — host (`grp-host`) and invitee (`grp-join`)

| step (pair) | median ms | max ms |   n |
| ----------- | --------: | -----: | --: |
| _pending_   |           |        |     |

### 3.5 Relay (staging)

| item                                                                                   | value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `[CALL] ICE ignored reason=no_session` per call (with `OFFER recv` in the same second) | _the Step 0 server lines are NOT deployed yet_ — but the pre-existing log ORDER already shows the drop on the test calls: cid `d56201cf` — `[CALL] ICE … candLen=114` (the host candidate) at 18:25:01.1101 **before** `[CALL] OFFER from=` at 18:25:01.1103 (0.26 ms apart = same TCP read); the three later candidates (.1215, .3720, .5304) came after the session existed. Client side the same call shows `ice:first-local type=host` at the SAME ms as `offer:emitted` with `held=0`. → **B-596 reproduced on 1 of 1 calls inspected; the dropped candidate is the host one.** |
| `[SFU] join.ack ms` / `consume ms` / `consumer.resume ms`                              | _pending the server deploy (staging runs the pre-Phase-6/7 build; no `[SFU] join` lines exist there)_                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

## 4. Answers the audit asked Step 0 to settle

(a) getUserMedia(video) > 500 ms on these devices? — _not yet measured_ (the caller runs were voice; BlueStacks mic open = 6–35 ms; the camera rows need a real device — B-355 makes the BlueStacks HAL unreliable for it) · (b) TURN fetch warm vs post-background — **warm, same-LAN, socket open: 164 / 300 / 442 ms (median 300)**, i.e. already the largest single row before the offer; post-background not yet exercised · (c) `ICE ignored` lines per call — server lines not deployed; the log order shows **1 host candidate per call outran its session** (see §3.5) · (d) the 5.0 s re-answer gap — _needs a connected call_ · (e) killed lane — _needs a signed-in second device_.

## 5. Where the time actually goes (ranked, with the audit's defect ids) — caller lane only so far

1. **TURN credential fetch on the critical path — ~300 ms median of a ~570 ms launch→offer, per mount, uncached (B-601 / B-598 class).** Everything else on the caller before the offer is ≤ 80 ms.
2. **`buildOfferAuth` ~78 ms** on a cert-cache hit (sign + cert read) — and it holds the ICE gate; a miss would add an HTTPS RTT.
3. **B-596 confirmed live**: the first (host) candidate is gathered in the same ms the offer is emitted and reaches the relay inside the offer handler's await window — the relay drops it.
4. Audio session starts at `state=idle` for outgoing (95 ms after launch) — fine, but it means InCallManager is up before the call exists; worth a look when the audio-route rows are reviewed.
   _(answerer + group lanes pending a second signed-in device.)_
