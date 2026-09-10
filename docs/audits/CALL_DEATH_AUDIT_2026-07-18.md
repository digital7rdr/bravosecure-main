# B-100 — Calls die at 10–16 minutes (WhatsApp-parity = unlimited) — full-stack audit

**Date:** 2026-07-18 · **Status:** ROOT-CAUSED, fixes NOT applied (audit-only per founder ask)

> **⚠️ ERRATUM + COMBINED REGISTER (same day):** finding **F-4 cites the wrong file** — `src/modules/messenger/transport/client.ts` is a stale unused mirror; the runtime client is `packages/messenger-core/src/transport/client.ts` (aliased via `tsconfig.json:26` / `babel.config.js:21`), which DOES reconnect on `io server disconnect` (B-14 branch) — but that reconnect is `setTimeout`-gated and RN freezes timers while the screen is locked, which is the real defect (LC-1). Root cause, timeline, and fix directions A–C stand; direction D is superseded. Full lifecycle picture + combined fix plan: [`CALL_LIFECYCLE_CONTINUITY_AUDIT_2026-07-18.md`](CALL_LIFECYCLE_CONTINUITY_AUDIT_2026-07-18.md) (B-101).
> **Symptom:** live 1:1 and group calls consistently fail at ~10 or ~16 minutes. WhatsApp on the same devices/network survives indefinitely.

---

## 1. Verdict

The death is **not a media/WebRTC failure and not a hard call-duration cap** (none exists anywhere in the stack). It is a **time-based auth expiry**: the WS signalling socket is force-disconnected by the server when the access token's JTI allowlist key disappears from Redis, and the disconnect's downstream machinery then terminates the call. The variance ("16 min or 10 min") is exactly `15 min − (token age when the call started)` plus up to 60 s of sweep latency — a fixed **expiry wall**, not a duration.

## 2. Root-cause chain (every link verified by direct code read)

1. **Access tokens live 15 min** — `JWT_ACCESS_TTL` default `'15m'`, not overridden on the staging box (`apps/auth-service/src/config/configuration.ts:37`; `auth.service.ts:71`).
2. **The JTI allowlist key dies with the token — or earlier.** `storeJti(jti, 900)` → `SET jti:<jti> '1' EX 900` (`auth.service.ts:92`, `redis.service.ts:38-40`). Nothing renews it while a socket stays connected. It vanishes **two ways**:
   - natural TTL expiry 15 min after issue, or
   - **instantly on any token refresh** — `issueSession()` revokes the previous JTI (`auth.service.ts:91` `revokeJti(prev.current_jti)`), which is the very JTI the live call socket is still bound to. Any 401-triggered refresh anywhere in the app kills the in-call socket's key on the spot.
3. **The P0-6 sweep hard-kills the socket.** Every 60 s, `recheckAllJtis()` pipelines `EXISTS jti:<jti>` for every connected socket; on miss it emits `error{token_revoked}` then `sock.disconnect(true)` (`apps/messenger-service/src/gateway/messenger.gateway.ts:392-423`). The sweep cannot distinguish "remotely revoked" from "naturally expired but the session is alive and refreshable" — the P0-6 design goal was remote-logout promptness; killing healthy in-call sockets is collateral.
4. **The disconnect terminates the call:**
   - **1:1** — media is P2P and keeps flowing, but `handleDisconnect` arms the B-58 deferred bye: after `CALL_DISCONNECT_GRACE_MS = 12_000` the peer receives `call.hangup {reason:'failed'}` unless the same (user, device) reconnects within 12 s (`messenger.gateway.ts:267, 824-830, 2406-2427`, cancel at `:507-509`).
   - **Group** — `SFU_LEAVE_GRACE_MS = 10_000`: the participant's mediasoup transports are closed 10 s after the drop (`messenger.gateway.ts:229, 786-800`); recovery requires a full `attemptSfuRejoin` (`groupCallReconnect.ts:99-137`) with a hard multi-second media interruption, failing to `'failed'` if the rejoin throws.
5. **Client recovery is unreliable by construction:**
   - Recovery depends on the `error{token_revoked}` frame arriving: the handler refreshes and re-opens with a fresh token. But the server emits the frame and calls `disconnect(true)` back-to-back — if the frame loses that close race, the client's `'io server disconnect'` branch **deliberately does not reconnect** (`src/modules/messenger/transport/client.ts:405-417`) and the socket sits dead holding an expired token.
   - **No proactive token refresh exists anywhere** — the client ignores `expiresIn` entirely; refresh is only reactive (HTTP 401 interceptor / WS auth-reject). Nothing pre-empts the 15-min wall.
   - In a 1:1 call, **either peer's** wall kills the call (independent token clocks → doubled exposure).

## 3. Ruled out (with evidence)

| Mechanism                              | Evidence                                                                                                                                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TURN credential expiry                 | TTL = 24 h (`turn.service.ts:55`); coturn `--stale-nonce=0`; 96 h of coturn logs: authenticated session closes = 54 client-closed + 54 allocation-timeout (post-death), **zero** auth/expiry closes |
| Hard call-duration cap                 | No match for any duration/timeout cap in the call path (both engines swept)                                                                                                                         |
| SFrame/frameCryptor rotation timer     | Epoch rotation only on membership change; zero timers (`frameCryptorOrchestrator.ts:116-160`, `sframeTransport.ts`)                                                                                 |
| SFU zombie sweeper reaping live rooms  | Reaps only `participantTags.size === 0` rooms (`sfu.service.ts:159-186`)                                                                                                                            |
| mediasoup transport/router lifetime    | None configured (`sfu.service.ts:909-922`); mediasoup has no default transport lifetime                                                                                                             |
| Room-access-token TTL                  | 30 min, only checked at `sfu.join`, F7 re-mint exists (`room-token.service.ts:57`, `groupCallReconnect.ts:118-133`)                                                                                 |
| Socket.io heartbeat as the fixed timer | ping 30 s / grace 25 s defaults — seconds-scale, not 10–16 min (but see F-2)                                                                                                                        |
| Redis TTLs on SFU room state           | Rooms/participants are in-process Maps, not Redis                                                                                                                                                   |

In-repo precedent confirming the mechanism class: `redis.service.ts:56-59` comment — the old push-token GC keyed liveness off the same 15-min JTI and "reaped ~15 min after going quiet" (B-48/B-52 family).

## 4. Contributing findings (not the killer, but weaken long calls)

- **F-2 — box config regression:** staging compose pins `WS_HEARTBEAT_GRACE: "10000"`, silently overriding the B-05 fix (`f536781`) whose code default is now 25000 (`configuration.ts:26`). A >10 s pong stall kills the socket → same downstream as the root cause. Also `WS_HEARTBEAT_MS` pinned 25000 vs default 30000.
- **F-3 — no TURN allocation recovery:** TURN creds are fetched once per call; ICE restart re-gathers against the same `iceServers` and nothing re-fetches/re-allocates if the relay allocation dies (`callController.ts:1374-1378`, `peerConnection.ts:220-226`). Survivable when non-relay pairs exist; unrecoverable on relay-only paths.
- **F-4 — stranded-socket branch:** `'io server disconnect'` never attempts recovery client-side (`transport/client.ts:415-417`) — correct for supersession, wrong as the _only_ behavior when the error frame is lost.

## 5. Why WhatsApp survives

No short-TTL server-side allowlist sweep runs against live sockets; signalling reconnects are transparent with in-place re-auth; media never depends on an auth token's 15-minute clock.

## 6. Fix directions (NOT applied — **architecture-gated**)

⚠️ CLAUDE.md security stop-condition: auth tokens / session storage changes must be verified against the System Architecture Documentation before implementation. Ranked by parity value:

- **A. In-place socket re-auth (WhatsApp-parity, primary):** new WS frame (e.g. `auth.refresh` carrying the fresh access token); server verifies and swaps `ctx.claims`/JTI on the live socket — no disconnect ever needed for a healthy refresh. Client refreshes proactively at ~12 min (finally using `expiresIn`).
- **B. Refresh must not orphan live sockets:** on refresh, delay `revokeJti(prev)` by a short grace (60–90 s) instead of instant DEL (`auth.service.ts:91`) so the socket can re-auth before the sweep sees a miss. (Brief two-valid-JTI window — needs security sign-off.)
- **C. Sweep grace for in-call sockets:** `recheckAllJtis` defers (not skips) disconnect for sockets with an active call/SFU participant, re-checking at call end — preserves remote-logout promptness for everything else.
- **D. Resilience (do regardless):** fix the stranded `'io server disconnect'` branch to attempt one refresh+reopen when not superseded/user-closed; restore `WS_HEARTBEAT_GRACE=25000` on the box (or delete the compose override so code defaults rule).

## 7. Verification plan (for whoever fixes)

1. **Repro first (proves the diagnosis):** connect a device, note token issue time, start a call, wait — expect `[P0-6] disconnecting revoked socket` in msgr logs at token-age 15:00–16:00 and call death ≤12 s later (1:1) / ≤10 s (group). The current staging container was restarted 2026-07-18 and will accumulate P0-6 lines from ambient sockets as evidence.
2. **Post-fix soak:** 2-device 1:1 call ≥45 min and group call ≥45 min; assert zero P0-6 kills of in-call sockets, call survives a mid-call token refresh, and remote-logout (evictOtherDevices) still disconnects within 60 s when genuinely revoked.
3. Regression: B-58 grace behavior, B-71 (token_revoked loop), supersession/takeover, messenger-service gateway suites.
