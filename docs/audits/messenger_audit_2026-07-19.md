# B-121 — Messenger Reliability: Audit + Remediation Handoff

> **This document is a COLD-START HANDOFF.** It is written for a reader (human or AI) with zero
> prior context. Read §0 in full before touching code. Part I is the live remediation state.
> Part II is the preserved original audit (diagnosis — still accurate, evidence still valid).
>
> Original audit date **2026-07-19**. Handoff rewritten **2026-07-20**.

---

# PART I — CURRENT STATE (start here)

## 0. STATUS

### 0.1 Where this work is

|                             |                                                                                                                                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Branch**                  | `fix/messenger-audit-b121`                                                                                                                                                                                                      |
| **Base**                    | `main` @ `512a7f0` (includes the same-day slow-network merge `b65f145`, SN-01..SN-11)                                                                                                                                           |
| **Wave 1**                  | **committed as `c9728f9`** — "fix(messenger): B-121 wave 1 — 23 reliability findings across client + relay" (65 files, +4431/−486), 12 file-disjoint work items                                                                 |
| **Wave 2**                  | **committed as `6f5f5de`** — RT-2, CALL-D, GW-2 (9 findings)                                                                                                                                                                    |
| **Waves 3+4**               | **committed as `67888e9`** (2026-07-21) — RT-3 + G3/OM-05 fold-in, RELAY-2, GW-3, RT-4, PUSH-1 (9 findings)                                                                                                                     |
| **Wave 5**                  | **committed as `eeceec2`** — RT-5 (GF-5 fail-closed group send)                                                                                                                                                                 |
| **Wave 6**                  | **committed as `4d21cd3`** — RT-6 (OM-02 ordering clamp, SYNC-7 durable reactions; SCHEMA_VERSION 15→16)                                                                                                                        |
| **Waves 7–8**               | **not started** (RT-7 receipts map + schema v17 · RT-8 ack coalescing/lock-screen recovery, needs RELAY-2 ✅)                                                                                                                   |
| **G2 (gate item)**          | **not started** — the recommended G2-before-RT-4 insertion was NOT taken; RT-4 landed first (the handoff's documented workable alternative — GF-3 did not touch `sendKeyRequest`/`reshareGroupKeyState`, so G2 rebases cleanly) |
| **B-122 (new, 2026-07-21)** | tap-to-retry silent no-op fixed as `7896108` (fresh wire id over relay dedup + freshSession for undelivered + group resetFailed rider) — see sqa.md B-122                                                                       |
| **Architecture gates**      | all 7 **APPROVED 2026-07-20** by the founder → 6 new work items to schedule (§5.3)                                                                                                                                              |
| **Findings**                | 50 total: 0 P0 · 13 P1 · 19 P2 · 18 P3                                                                                                                                                                                          |
| **Device verification**     | **none performed for any of this work** (§9)                                                                                                                                                                                    |
| **Client build context**    | Pixel 6a / Android 17; installed release build **v1.0.117 / vc145** is **not debuggable** (JS logs stripped, no `run-as`)                                                                                                       |

Authoritative planning artefacts, all in-repo:

- `docs/audits/b121-specs/PLAN.md` — the implementation plan (8 waves, 25 work items, FORBIDDEN
  table, duplicates table, "where the audit was wrong" roll-up, cross-cutting execution notes).
- `docs/audits/b121-specs/<FINDING-ID>.md` — one spec per finding (50 files): verdict, mechanism
  with current-tree evidence, exact fix with code anchors, blast radius, tests, risk.
- **this document** — status, forbidden list, gate decisions, resume instructions, and the
  original audit's diagnosis.

### 0.2 ⛔ FORBIDDEN — READ BEFORE WRITING ANY CODE

The original audit (Part II) is a **good diagnosis and a dangerous prescription**. Several of its
proposed remedies violate the Sealed Sender contract and would ship a compliance breach. The
original §7 "Prioritized fix plan" has been **deleted** for that reason (see §II.7).

Reproduced verbatim from `PLAN.md` §3. Reject these if anyone re-proposes them — including
"just for staging", "behind a flag", or "temporarily".

| Proposal                                                                                                         | Origin (which audit finding proposed it)                                         | Why it is forbidden                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /envelopes/batch` (N per-recipient envelopes in one request)                                               | GF-1 + SRV-01 audit remedy (§II.3.3, §II.3.8)                                    | Binds N ciphertexts the relay is contractually blind to → hands it a membership set. `MESSENGER_SPEC_COVERAGE.md:66/69`, `MESSENGER_BACKEND.md:162`. A fan-out-aware _throttle_ is the same signal and equally forbidden. **Blind flat raise only** (shipped as RELAY-1).            |
| `submitter: {userId, deviceId}` on `POST /envelopes`                                                             | OM-03 + SYNC-3 + SRV-08 + XO-1 audit remedy (§II.3.1, §II.3.2, §II.3.6, §II.3.8) | `MESSENGER_BACKEND.md:137/156`, `SIGNAL_PROTOCOL_IMPLEMENTATION.md:514`. **Anonymous capability handle only** — see NA-GATE-1 (§4.1), which was approved in the compliant form.                                                                                                      |
| WorkManager + `BOOT_COMPLETED` 2nd-process SQLCipher drain                                                       | OR-1 audit remedy (§II.3.7)                                                      | Arch memo §12 NOT-COVERED; the docs record this exact approach failing and being removed (2nd JS VM fought the SQLCipher lock). Relaxing keychain accessibility to enable it is **FORBIDDEN outright**. The boot receiver is also redundant (androidx.work 2.8.0 already merges it). |
| Headless minimal pull on FCM msg-wake                                                                            | OR-3 audit remedy (§II.3.7)                                                      | Same 2nd-VM class, plus a headless access-token refresh (B-71 revocation-loop class).                                                                                                                                                                                                |
| New top-level `SealedPayload` key (`sentAtMs`, `callEvent`, and `redact` **without** a staged rollout)           | OM-05, SYNC-5, SYNC-4 (§II.3.1, §II.3.6)                                         | `isSealedPayload`'s strict allow-list → old receivers throw → the drain acks **`discarded`** → the message is **destroyed on the relay**, not deferred.                                                                                                                              |
| Raw `conversationId` on the typing frame                                                                         | SYNC-6 audit remedy (§II.3.6)                                                    | Group clustering signal. Opaque **per-recipient** tag only — see NA-GATE-7 (§4.7).                                                                                                                                                                                                   |
| Weakening `verifySealedAad`, `verifySenderCert`, or the call-offer freshness check to make any of the above work | several                                                                          | CLAUDE.md "Never weaken transitions".                                                                                                                                                                                                                                                |
| `git commit --no-verify` / `npm run tsc:rebaseline` to get past a gate                                           | —                                                                                | CLAUDE.md change-safety rules.                                                                                                                                                                                                                                                       |

**Additional non-negotiables carried from `PLAN.md` §0:**

1. **You own exactly the files listed in your work item.** Do not touch any other production file.
   File-ownership sets are the mutual-exclusion key that lets items run concurrently.
2. `npm run typecheck` must stay **≤ 47** (`.tsc-baseline.json`). Never run `npm run tsc:rebaseline`.
3. `packages/messenger-core/__tests__/logAudit.test.ts` must stay green. No new log line may carry
   a body, reaction, payload, key bytes, retract/ack token, or plaintext.
4. **SCHEMA_VERSION is claimed, not chosen** (§5.4). Every new `ALTER` goes **after** the v7
   rebuild block.
5. `docs/runbooks/BACKUP_LOOP.md` is mandatory for RT-6 and RT-7 (they write `messages` rows /
   add serialized columns) — see the hard gate on RT-7 (§5.2).
6. Never import `Alert` from `react-native` (use `@utils/alert`). No `react-native-reanimated`
   (the worklets babel plugin is absent).
7. Anything touching `packages/messenger-core/**` must also pass
   `cd apps/ops-console && npm run typecheck` (shared consumer via the `@bravo/messenger-core`
   path alias → `packages/messenger-core/src`).
8. If your spec's fix collides with reality (anchor text moved, another item already refactored
   the region), **stop and report** — do not improvise a merge.

### 0.3 HOW TO RESUME

**The exact next actions are: G4, then G5 (ops-console redeploy first).** G1-RT + G7-RT client halves landed 2026-07-21 (same-day as this update) — they remain DEPLOY-GATED: the messenger-service overlay (G1-SRV/G6/G7-GW) must reach staging BEFORE any APK carrying them is distributed. Waves 2–8 + G2 are landed (see §0.1). The table below is the historical wave-2 brief, kept for reference:

| Item       | Findings                                                     | Owns (exclusive)                                                                                                                                                        | Depends on                                             |
| ---------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **RT-2**   | OM-07, XO-3, XO-5, GF-1, SRV-01, OR-1 _(runtime call sites)_ | `src/modules/messenger/runtime/productionRuntime.ts`                                                                                                                    | **STORE-1** (hard, landed in `c9728f9`), RT-1 (landed) |
| **CALL-D** | NA-02                                                        | `src/screens/messenger/CallScreen.tsx`, `src/modules/messenger/push/fcmBootstrap.ts`, `src/modules/messenger/push/incomingCallCache.ts`                                 | **CALL-A**, **CALL-B** (both landed)                   |
| **GW-2**   | SRV-02, SRV-03                                               | `apps/messenger-service/src/gateway/messenger.gateway.ts`, `apps/messenger-service/src/relay/envelope.service.ts`, `apps/messenger-service/src/relay/envelope.store.ts` | GW-1 (landed)                                          |

Full scope, test commands and per-item gotchas are in §5.1. **Before starting RT-2, read §6 —
three Wave-1 residuals are RT-2's responsibility and one of them (the `allMessageIds` boot sweep)
leaves a shipped fix inert until it is done.**

**Procedure for every item:**

1. Read `docs/audits/b121-specs/PLAN.md` §0 (rules) and the section for your item.
2. Read the per-finding spec(s) for every finding your item owns.
3. Read this document's §4 (gate decisions) if your item touches a gated area.
4. Implement **only** inside your file-ownership set.
5. Run your item's targeted Jest command → then the broad gates (§7).
6. Record what you could **not** device-verify (§9). Do not claim device verification you did not do.

**Precedence rule — memorise this:**

> **`PLAN.md` overrides the individual specs, which override the original audit §II.3 remedies.**
> Where this handoff and `PLAN.md` disagree, this handoff is newer (it carries the 2026-07-20 gate
> approvals); everything else in `PLAN.md` still stands.

---

## 1. Verdict summary

Every one of the 50 findings was **independently re-verified against the current tree** during the
spec pass (one spec per finding, each re-establishing the failure path from source, not from the
audit text).

|                                                                         | Count  |
| ----------------------------------------------------------------------- | ------ |
| CONFIRMED                                                               | **37** |
| CONFIRMED-WITH-DRIFT (mechanism exact, line numbers and/or scope moved) | **13** |
| REFUTED                                                                 | **0**  |
| Already fixed / no-op                                                   | **0**  |

The 4 findings the original audit marked **⚠ UNVERIFIED** (its verifier agents hit API
stream/session-limit errors overnight) — **GCV-3, SYNC-5, SYNC-6, SYNC-7** — are now **all
confirmed** in the current tree. The ⚠ markers in Part II are historical; ignore them.

Six findings are **duplicates** of another finding and must not be opened as separate work
(`PLAN.md` §4): OM-01≡XO-1, OM-07⊂XO-3, OR-6⊂OR-1, SRV-07≡OR-5, SYNC-2≡GF-2,
SRV-08≡OM-03≡SYNC-3. One further finding (NA-05) is half already-implemented.

Per-finding verdict text lives at the top of each `docs/audits/b121-specs/<ID>.md`.

---

## 2. Master status table — all 50 findings

**Status legend**

- `DONE c9728f9` — fully landed in Wave 1.
- `PARTIAL c9728f9` — one half landed in Wave 1; the finding is **not yet live** until the named
  follow-up item ships. See §6.
- `PENDING` — no code written.
- `CLOSED-WONTFIX` — recommended for closure, not implementation.

**Wave column** = `PLAN.md` §1 wave number. §5.3 proposes inserting the gate item **G2** at wave 4,
which shifts RT-4…RT-8 down one wave; the numbers below are the un-shifted `PLAN.md` numbers.

| Finding    | Sev         | Owning work item                 | Wave      | Status                                       | Note                                                                                                                                                        |
| ---------- | ----------- | -------------------------------- | --------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OM-01**  | P1          | RT-3                             | 3         | **DONE `67888e9`**                           | Literally the same fix as XO-1 — ONE change, not two.                                                                                                       |
| **OM-02**  | P1          | RT-6                             | 6         | **DONE `4d21cd3`**                           | **Future-only** clamp (not the audit's symmetric clamp). Schema v16.                                                                                        |
| **OM-03**  | P2          | **G1** (gate)                    | gate      | **DONE** (srv `f0a4dec` + client 2026-07-21) | G1-RT client half landed: `receipt: true` on 1:1 HTTP submits + `httpReceiptReconcile` poll on reconnect/60 s tick. APK ships only after the server deploy. |
| **OM-04**  | P2          | **G4** (gate)                    | gate      | PENDING                                      | Approved as a decrypt-free AsyncStorage stage only, §4.4.                                                                                                   |
| **OM-05**  | P3          | RT-3 (fold-in)                   | 3         | **DONE `67888e9`**                           | Gate NA-GATE-3 approved §4.3; folds into RT-3's re-seal rewrite.                                                                                            |
| **OM-06**  | P3          | MS-1                             | 1         | **DONE `c9728f9`**                           | Recency-guarded `last_message` + MRU.                                                                                                                       |
| **OM-07**  | P3          | STORE-1 → **RT-2**               | 1 → 2     | **DONE `6f5f5de`**                           | Store layer + `soft_attempts` landed; **no call site adopts it yet**.                                                                                       |
| **XO-1**   | P1          | RT-3                             | 3         | **DONE `67888e9`**                           | The only fully-silent 1:1 loss class. Second half (HTTP submitter) is FORBIDDEN → G1.                                                                       |
| **XO-2**   | P2          | RT-3                             | 3         | **DONE `67888e9`**                           | Deferred outbox row on cert-prep failure.                                                                                                                   |
| **XO-3**   | P2          | STORE-1 → **RT-2**               | 1 → 2     | **DONE `6f5f5de`**                           | `classifyOutboxFailure` etc. exist and are **unused**.                                                                                                      |
| **XO-4**   | P3          | MS-1                             | 1         | **DONE `c9728f9`**                           | Monotonic status ladder.                                                                                                                                    |
| **XO-5**   | P3          | STORE-1 → **RT-2**               | 1 → 2     | **DONE `6f5f5de`**                           | Store half landed; `productionRuntime.ts:2932` still flips the bubble to `'failed'`.                                                                        |
| **GF-1**   | P1          | RELAY-1 + STORE-1 → **RT-2**     | 1 → 2     | **DONE `6f5f5de`**                           | Server throttle raised 30/10 s → 300/60 s; the client pacer is **not wired** (`sendGate` unused).                                                           |
| **GF-2**   | P1          | **G2** (gate)                    | gate      | **DONE `cb7ff4f`**                           | ≡ SYNC-2. Approved §4.2 in the **GF-2 shape**.                                                                                                              |
| **GF-3**   | P1          | RT-4                             | 4         | **DONE `67888e9`**                           | Divergence-flagged key resync + stash-attempt discipline.                                                                                                   |
| **GF-4**   | P2          | GRP-1                            | 1         | **DONE `c9728f9`**                           | Prefers local crypto membership — **not** the audit's union.                                                                                                |
| **GF-5**   | P2          | RT-5                             | 5         | **DONE `eeceec2`**                           | Fail closed on a missing group key.                                                                                                                         |
| **GF-6**   | P3          | RT-4                             | 4         | **DONE `67888e9`**                           | Per-peer drain lanes.                                                                                                                                       |
| **NA-01**  | P1 (was P0) | CALL-A                           | 1         | **DONE `c9728f9`**                           | Field-wise merge in `setIncomingCallPayload`. Device-verify owed.                                                                                           |
| **NA-02**  | P1          | **CALL-D**                       | **2**     | **DONE `6f5f5de`**                           | **Next action.**                                                                                                                                            |
| **NA-03**  | P2          | CALL-A                           | 1         | **DONE `c9728f9`**                           | Handlers install before push registration; registers bounded.                                                                                               |
| **NA-04**  | P2          | CALL-A                           | 1         | **DONE `c9728f9`**                           | **Native Kotlin change → APK rebuild required.** Device-verify owed.                                                                                        |
| **NA-05**  | P2          | CALL-C                           | 1         | **DONE `c9728f9`**                           | Budget 12 s → 40 s + terminality gate (the audit's own remedy was already in the tree).                                                                     |
| **NA-06**  | P3          | CALL-B                           | 1         | **DONE `c9728f9`**                           | Native-ring ownership — **not** the audit's `AppState` gate.                                                                                                |
| **GCV-1**  | P1          | VID-1                            | 1         | **DONE `c9728f9`**                           | `localVideoConstraints()` at all 5 `getUserMedia` sites. Device-verify owed.                                                                                |
| **GCV-2**  | P2          | VID-2                            | 1         | **DONE `c9728f9`**                           | Dead adaptive-aspect machinery deleted; `objectFit` prop; self tile `contain`.                                                                              |
| **GCV-3**  | P2          | ~~PATCH-1~~                      | —         | **CLOSED-WONTFIX**                           | See the rationale immediately below this table.                                                                                                             |
| **GCV-4**  | P3          | VID-2                            | 1         | **DONE `c9728f9`**                           | Mirror follows the lens. React key deliberately unchanged.                                                                                                  |
| **GCV-5**  | P3          | VID-2                            | 1         | **DONE `c9728f9`**                           | `useWindowDimensions()` + live page geometry.                                                                                                               |
| **SYNC-1** | P1          | RT-7                             | 7         | **DONE `bcff917`**                           | Per-recipient envelope-id map. Schema v17 + **hard backup gate**.                                                                                           |
| **SYNC-2** | P1          | **G2** (gate)                    | gate      | **DONE `cb7ff4f`**                           | Duplicate of GF-2 — ONE PR.                                                                                                                                 |
| **SYNC-3** | P2          | **G1** (gate)                    | gate      | **DONE** (with OM-03)                        | Duplicate of OM-03 — closed by the same G1-RT client half.                                                                                                  |
| **SYNC-4** | P2          | **G5** (gate)                    | gate      | PENDING                                      | Approved §4.5 as a FULL single release.                                                                                                                     |
| **SYNC-5** | P3          | **G6** (gate)                    | gate      | **DONE `1f158c1`**                           | Approved §4.6 — 7-day env-tunable TTL.                                                                                                                      |
| **SYNC-6** | P3          | **G7** (gate)                    | gate      | **DONE** (srv `1f158c1` + client 2026-07-21) | G7-RT client half landed: per-pair `convTag` on send, scoped receive w/ legacy fan-out fallback. Server-first deploy rule holds.                            |
| **SYNC-7** | P3          | RT-6                             | 6         | **DONE `4d21cd3`**                           | Durable pending-reaction stash + the missing `sqlMessages.upsert`.                                                                                          |
| **OR-1**   | P2 (was P1) | STORE-1 → **RT-2**               | 1 → 2     | **DONE `6f5f5de`**                           | STORE-1 landed the enabling primitive (`kickPending()`), unused. WorkManager remedy is FORBIDDEN.                                                           |
| **OR-2**   | P1          | RT-8                             | 8         | **DONE `f86ec3a`**                           | The audit's `fetchWithTimeout` target is unfixable in JS.                                                                                                   |
| **OR-3**   | P2          | PUSH-1                           | 4         | **DONE `67888e9`**                           | Ships the audit's _fallback_ (iOS banner), not its headless pull.                                                                                           |
| **OR-4**   | P2          | RT-1                             | 1         | **DONE `c9728f9`**                           | `createRerunCoalescer` on both drains.                                                                                                                      |
| **OR-5**   | P3          | WS-1                             | 1         | **DONE `c9728f9`** (code)                    | Flag stays `false`; the staging flip is a separate ops action (§8).                                                                                         |
| **OR-6**   | P3          | RT-1                             | 1         | **DONE `c9728f9`**                           | `productionRuntime.ts:1452` resume kick. RT-2 replaces it with the throttled kick.                                                                          |
| **SRV-01** | P1          | RELAY-1 + STORE-1 → **RT-2**     | 1 → 2     | **DONE `6f5f5de`**                           | Server half done; client pacer inert.                                                                                                                       |
| **SRV-02** | P2 (was P1) | **GW-2**                         | **2**     | **DONE `6f5f5de`**                           | Rehydrate-from-existing-offer (needs no new Redis state → no gate).                                                                                         |
| **SRV-03** | P2          | **GW-2**                         | **2**     | **DONE `6f5f5de`**                           | peek → emit → remove-what-emitted.                                                                                                                          |
| **SRV-04** | P2          | GW-1                             | 1         | **DONE `c9728f9`**                           | `conversationId` finally passed as arg 6.                                                                                                                   |
| **SRV-05** | P3          | RELAY-1 (A) + RELAY-2 (C) + RT-8 | 1 → 3 → 8 | **DONE `f86ec3a`**                           | Throttles + /envelopes/ack-batch + client coalescer all landed.                                                                                             |
| **SRV-06** | P3          | GW-3                             | 3         | **DONE `67888e9`**                           | Charge once per callId when dispatchable — **not** the audit's per-callId bucket.                                                                           |
| **SRV-07** | P3          | WS-1                             | 1         | **DONE `c9728f9`**                           | Same diff as OR-5; `connectionStateRecovery` now gated + jti check added.                                                                                   |
| **SRV-08** | P3          | **G1** (gate)                    | gate      | **DONE** (with OM-03)                        | Duplicate of OM-03 — closed by the same G1-RT client half.                                                                                                  |

**Totals (2026-07-21, post G1-RT + G7-RT):** 47 DONE (OM-03/SYNC-3/SRV-08 + SYNC-6 closed by the client halves) · 2 PENDING (OM-04 = G4 · SYNC-4 = G5) · 1 CLOSED-WONTFIX (GCV-3).

**Deploy gate: SATISFIED 2026-07-21.** messenger-service (G1-SRV/G6/G7-GW) deployed to Contabo staging and verified in the running container; v1.0.120/vc148 shipped after it. **Device-verified same day on Pixel 6a** (`29271JEGR00258`, see sqa.md "DEVICE VERIFICATION — v1.0.120"): G1-RT proven end-to-end on real infrastructure — an offline→online send drained over HTTP and parked `rcpt:2f8be404…` in staging Redis holding a **64-char SHA-256 digest with no submitter identity** (the OM-03 §Risk #1 sealed-sender lock, confirmed in production); `POST /envelopes/receipts` answers 401 not 404, so the client's unsupported-latch can never trip. **Still owed:** the final `pending → delivered` flip (needs the peer to ack) and the G7-RT typing-scope smoke (needs a second device).

### GCV-3 — recommended CLOSE, not implement

The audit claims the fork's `onFrameResolutionChanged` sends unrotated dims to JS so "the tile
renders 90°-wrong". **The pixels are never rendered 90° wrong** — `SurfaceViewRenderer` applies the
rotation itself. Only the _aspect number_ delivered to JS is transposed. That number's sole consumer
was the `onDimensionsChange` prop, which **VID-2 deleted in `c9728f9`**, and the native emitter stays
off. The patch would therefore be correct-but-unused parity hygiene that fixes **none** of the
"dramatic zoom" complaints (those are GCV-1/GCV-2, both landed).

It is also **not verifiable without a device**: `PLAN.md` requires a temporary `Log.d` in
`onFrameResolutionChanged` printing `640x480 rot=90` — if it prints `480x640 rot=90` the fix is
inverted and must be deleted. With no device attached, shipping it is an unverifiable native change.
**Recommendation: close.** If a future device session wants it, `PLAN.md` PATCH-1 has the full spec.

---

## 3. Where the ORIGINAL audit was WRONG

The spec pass rejected or materially rewrote the audit's proposed remedy in **17 of 50** findings.
Reproduced and expanded from `PLAN.md` §5. Cross-references point at the finding's original text in
Part II, which now carries a matching ⚠ banner.

| #   | Finding (Part II §)                                           | The original audit said                                                                | Reality                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | What is implemented instead                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **OM-02** (§II.3.1)                                           | Clamp ordering ts when `\|aad.ts − serverTs\|` exceeds a skew — a **symmetric** clamp. | Symmetric would revert MSG-01 and L18: legitimately store-and-forwarded envelopes are arbitrarily _older_ than the reference, and clamping them forward corrupts real history.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | **Future-only** clamp (2-min skew) in a new `orderingClock.ts`, threaded as an optional `serverTsMs`. `SEALED_AAD_*` constants asserted unchanged. → RT-6                                                                                                                                                                                                                                               |
| 2   | **OM-03 / SYNC-3 / SRV-08 / XO-1** (§II.3.1, .6, .8, .2)      | Pass `{userId, deviceId}` submitter on the HTTP POST.                                  | **FORBIDDEN.** `MESSENGER_BACKEND.md:137/156` ("JWT is rate-limit only — we do NOT persist submitter identity"), `SIGNAL_PROTOCOL_IMPLEMENTATION.md:514`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Anonymous capability handle: retract-token-gated `POST /envelopes/receipts` poll. → **G1**, §4.1                                                                                                                                                                                                                                                                                                        |
| 3   | **OM-04** (§II.3.1)                                           | Headless wake delivers + acks + moves the sender's tick.                               | **Not achievable.** The ack is decrypt-gated, and a headless runtime boot is blocked by the fresh-install restore-probe ordering plus `installIdentity`/`publishOwnBundle` side effects.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Bounded, decrypt-free prefetch **stage** only, consumed when `relay.pull` fails. → **G4**, §4.4                                                                                                                                                                                                                                                                                                         |
| 4   | **OM-05** (§II.3.1)                                           | Add a `sentAtMs` field to the outbox payload / seal.                                   | **Fleet-breaking** if it becomes a `SealedPayload` key — the strict allow-list makes old receivers throw, and the drain acks `discarded`, destroying the message on the relay.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Reinterpret `SealedAad.ts` as compose time, clamped **inside** the existing unmodified accept window. → RT-3 fold-in, §4.3                                                                                                                                                                                                                                                                              |
| 5   | **OM-06** (§II.3.1)                                           | A stale insert makes the thread "jump to the top".                                     | Home re-sorts by `last_message.created_at`, so a stale insert makes the thread **sink**. The move-to-front is only visible in ChatScreen's raw-order list.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Symptom wording corrected; the recency guard shipped. → MS-1 (**DONE**)                                                                                                                                                                                                                                                                                                                                 |
| 6   | **OM-07** (§II.3.1)                                           | Index the backoff ladder correctly (add an unreachable-streak counter).                | **Incomplete.** Without `clearUnreachableBackoff()` on reconnect it trades a battery bug for minutes-late sends — rows stay parked past the moment the network returns.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `soft_attempts` + a real ladder + the mandatory unpark. Also: **one** column, not OM-07's `unreachable_attempts` _and_ XO-3's `soft_attempts`. → STORE-1 (**PARTIAL**) + RT-2                                                                                                                                                                                                                           |
| 7   | **GF-1 / SRV-01** (§II.3.3, .8)                               | Server `POST /envelopes/batch`, or a fan-out-aware throttle.                           | **Both FORBIDDEN** — a batch binds N per-recipient ciphertexts into one request and a fan-out-aware throttle carries the identical signal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | A **blind flat raise** is the entire compliant server surface: `SEND_THROTTLE = 300/60 s` so one `MAX_GROUP_FANOUT = 250` burst fits a window. → RELAY-1 (**DONE**) + client pacer in STORE-1/RT-2                                                                                                                                                                                                      |
| 8   | **GF-4** (§II.3.3)                                            | Union the server roster with `Object.keys(groups[gid].members)`.                       | **WRONG** — a union resurrects a _removed_ member on non-adder devices (the P1-5 privacy defect) and revives a union that was deliberately reverted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Prefer local crypto membership when local group state exists; server roster as fallback. → GRP-1 (**DONE**)                                                                                                                                                                                                                                                                                             |
| 9   | **GCV-3** (§II.3.5)                                           | Pixels render 90°-wrong; causes the zoom complaints.                                   | Pixels are never wrong (the renderer rotates them); only the aspect _number_ transposes, and after VID-2 it is **inert** — no consumer, emitter off.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | **CLOSE.** → §2                                                                                                                                                                                                                                                                                                                                                                                         |
| 10  | **GCV-2** (§II.3.5)                                           | `aspectRatio` is inert in _measured_ slots.                                            | **Stronger than audited** — inert in **every** slot. Also: do **not** letterbox the hero (trades a 38 % crop for a 38 % dead band), and do **not** unpin the wrapper height (re-opens BS-GC-BLACKVIDEO).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Delete the dead machinery, keep the `minWidth/minHeight: 1` floor, add an `objectFit` prop, self tile `contain`. → VID-2 (**DONE**)                                                                                                                                                                                                                                                                     |
| 11  | **SYNC-1** (§II.3.6)                                          | Match read receipts by `clientMsgId`.                                                  | Would require adding `clientMsgId` to the read-receipt WS frame — a reader↔message correlator that breaks relay group-blindness and needs an architecture amendment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Persist a per-recipient `envelope_ids` map + a pure `readReceiptEnvelopeMatch` with a scalar fallback. → RT-7                                                                                                                                                                                                                                                                                           |
| 12  | **SYNC-2** (§II.3.6)                                          | "Server-side twin" of GF-2, in `apps/messenger-service`.                               | **Wrong file hint** — nothing in the relay changes; the entire fix is client-side.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Same PR as GF-2. → **G2**, §4.2                                                                                                                                                                                                                                                                                                                                                                         |
| 13  | **SYNC-5** (§II.3.6)                                          | Call bubbles have no restore path; mint missed calls as real E2EE envelopes.           | Bubbles **do** ride the E2EE backup mirror, so restore-time reconciliation already exists. The E2EE option is **BLOCKED**: a new `callEvent` key makes old receivers throw inside the receive txn → rollback → 30-day relay redelivery **poison pill**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Raise `MISSED_CALL_MARKER_TTL_SEC` to an env-tunable 7 days, clamped to dwell. → **G6**, §4.6                                                                                                                                                                                                                                                                                                           |
| 14  | **SYNC-6** (§II.3.6)                                          | Put an optional `conversationId` on the typing frame.                                  | **Not shippable** — hands the relay a stable cross-member group id (`MESSENGER_SPEC_COVERAGE.md:69`, `MESSENGER_BACKEND.md:162`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Opaque 16-hex `convTag`, **different for every recipient**. → **G7**, §4.7                                                                                                                                                                                                                                                                                                                              |
| 15  | **NA-04** (§II.3.4)                                           | Call `bringAppToForeground()` unconditionally at the top of `onAnswer`.                | **Insufficient.** CallKeep's `backToForeground()` warm branch sends a bare launcher intent, so `MainActivity.isCallLaunch` is false and `setCallLaunchFlags(false)` actively **clears** `showWhenLocked`/`turnScreenOn` — the lock-screen case stays behind the keyguard.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | A native `BravoCallForegroundModule.bringCallUiToForeground()` carrying `MainActivity.EXTRA_CALL_LAUNCH`, with CallKeep as fallback. → CALL-A (**DONE**, native)                                                                                                                                                                                                                                        |
| 16  | **NA-05** (§II.3.4)                                           | Buffer the pending answer/offer and re-send on the next `connected`.                   | **Already implemented** — `signallingClient.ts` re-sends on reconnect via a 100 ms transport-state poll.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | The real defects: the 12 s setup budget and the watchdog arm point. Budget → 40 s, abandon gated on terminality, watchdog re-armed at answer-delivery. → CALL-C (**DONE**)                                                                                                                                                                                                                              |
| 17  | **OR-1 / OR-2 / OR-3 / OR-5 / SRV-02 / SRV-06** (§II.3.7, .8) | See each finding.                                                                      | **OR-1**: WorkManager + `BOOT_COMPLETED` is arch-gated _and_ redundant (androidx.work 2.8.0 merges the receiver). **OR-2**: the `fetchWithTimeout` abort is **unfixable in JS** — no timer fires while the screen is locked; bounding the caller is the only lever, and `httpFallback` is an unreachable per-send closure so `drainOutbox` is the right target. **OR-3**: headless pull rejected (2nd-VM + B-71 token class). **OR-5**: "env/ops change only" is **wrong** — flipping the flag activates ~225 lines of never-unit-tested code that overrides `broadcast()` for every WS event; SRV-07's "just set it true" is unsafe without the jti gate. **SRV-02**: persisting new ringing-state in Redis is arch-gated and **unnecessary**. **SRV-06**: a per-callId bucket cannot help redials — a redial mints a _fresh_ callId and the gateway rejects duplicates — and would delete the anti-spam perimeter. | OR-1 → foreground-lifecycle kicks (RT-2). OR-2 → `onServerSignal` off the Manager `'ping'` clock + background drain (RT-8). OR-3 → iOS banner lane (PUSH-1). OR-5/SRV-07 → config routing + jti gate, flag stays `false` (WS-1, **DONE**). SRV-02 → rehydrate from the already-persisted offer, **no new Redis state** (GW-2). SRV-06 → charge once per callId only when a push is dispatchable (GW-3). |

**One more correction, not in `PLAN.md` §5:** **NA-06** — the audit's `AppState === 'active'` gate
was **not** implemented, because it silences the legitimate foreground-ring-then-Home case. CALL-B
shipped native-ring ownership instead (`isNativeRingActive` + `bindInAppRingOwnership`).

---

## 4. Architecture gate decisions — ALL 7 APPROVED (2026-07-20, founder)

Ten findings were held out of the wave plan pending an architecture ruling. **All seven gates were
approved on 2026-07-20 in the specific, constrained forms below.** The approval is for _these_
designs — not for the audit's original proposals, which remain forbidden (§0.2).

Sources: `PLAN.md` §2 and the architecture-memo verdicts quoted inside each finding spec.
`docs/architecture/ARCHITECTURE_AMENDMENT_SFRAME.md` defines the written-amendment + sign-off
process if any of these needs to change shape again.

### 4.1 NA-GATE-1 — Delivery receipts for HTTP-submitted envelopes → **design (A)**

- **Findings:** OM-03 + SYNC-3 + SRV-08 (one defect, three competing designs — **implement one**).
- **Blast if unfixed:** every group send, every outbox drain, every WS-ack-timeout fallback and
  every B-46 auto-resend is permanently stuck at a single tick, and B-46 auto-recovery is dead.
- **APPROVED design (A) — retract-token-gated poll.** Rejected: design (B) (SYNC-3's anonymous
  socket.io receipt room + a new `receipt.subscribe` WS frame).
  - Relay stores `rcpt:{envelopeId}` = **`sha256(retractToken)|outcome`** at ack time.
  - New **`POST /envelopes/receipts`**, authed **only by the retract token** the sender already
    persists — no `@CurrentCaller`, same capability model as `POST /envelopes/retract`
    (`MESSENGER_SPEC_COVERAGE.md:140`).
  - Client reconciles on reconnect/foreground through the **existing, unchanged**
    `applyEnvelopeDelivered` / `applyEnvelopeUndeliverable` / `resendUndeliverable`.
- **Constraints that ride with the approval:**
  - **No SQLCipher schema bump.** The retract token doubles as the receipt-read capability
    precisely so no new column is needed — a new column would change `serializeMessage`, change
    `versionHash` for every row, and trigger a whole-history backup re-mirror (the B-94
    `root_mismatch` factory).
  - **No gateway change**, no new WS frame.
  - The `if (submitter)` branch in `EnvelopeService.ack` stays byte-identical; the new work is an
    additive `else`/best-effort block, so `envelope.delivered` can never double-fire.
  - Group ticks remain first-recipient-only until RT-7 lands — say so in the PR.
- **Naming note (unresolved, pick one):** OM-03's spec calls the new client module
  `httpReceiptReconcile.ts`; SRV-08's calls it `receiptReconcile.ts`. Either is fine; **pick one and
  do not create both.**

### 4.2 NA-GATE-2 — Durable group key/state fan-out → **APPROVED, GF-2 shape**

- **Findings:** GF-2 + SYNC-2 (same fix — **ONE PR**).
- **Blast if unfixed:** a zombie socket silently swallows every key frame while the sender counts it
  delivered; the fail-closed epoch rotate then strands that member permanently.
- **APPROVED shape: GF-2** — a new `deliverGroupAdminEnvelope` helper **inside
  `productionRuntime.ts` only**. **Rejected: SYNC-2's variant** (an additive `BroadcastDeliverMeta`
  4th arg on `broadcastToGroup` in `packages/messenger-core`) — cleaner in isolation, but it widens
  the shared package for no functional gain.
- **Constraints that ride with the approval** (all five arch-memo §4 constraints, documented as met
  in the specs):
  1. One sealed **pairwise** envelope per recipient — byte-identical to what group _text_ already
     sends on the same lane.
  2. **No new server endpoint and no new server table.** Nothing in the relay changes.
  3. `create` and `key-request` remain the only unwrapped kinds.
  4. Key material lives only in SQLCipher and is never logged. The outbox row stores only the ECIES
     `outerSealed`, **never** the group key.
  5. Epoch monotonicity and the B-42 epoch guard are untouched; the fail-closed rotate stays.
- **Accepted regression:** group admin ops get slower on large rosters (N HTTP RTTs instead of N
  fire-and-forget emits). Group text already pays this. Previously-dark failures now surface as
  error banners — that is the bug becoming honest, not a new defect.
- **Sequencing:** must land **after RELAY-1** (already in `c9728f9`, needs deploying — it converts
  key fan-out into N HTTP submits) and **before RT-4**, because RT-4's GF-3 edits the same two
  functions (`sendKeyRequest`, `reshareGroupKeyState`). See §5.3.

### 4.3 NA-GATE-3 — Compose timestamp as `aad.ts` on re-seal → **APPROVED (narrowing reinterpretation)**

- **Finding:** OM-05.
- **APPROVED:** `SealedAad.ts` may be reinterpreted from _"when this seal ran"_ to _"when the sender
  composed this message"_, carried through a clamp helper.
- **Hard constraints:**
  - The clamped value must stay **INSIDE the existing, unmodified `verifySealedAad` window**
    (`SEALED_AAD_MAX_AGE_MS` minus a safety margin, never in the future). The change strictly
    **narrows** the accept window.
  - **`SEALED_AAD_MAX_AGE_MS` must NEVER be widened.** Widening it to make this work is FORBIDDEN
    (CLAUDE.md AAD-binding stop condition).
  - The re-seal still fetches a **fresh** sender cert.
  - **Do not counter-propose** the memo's "doc-safe" option (carry compose time as a new
    `SealedPayload` field). It is fleet-breaking: `isSealedPayload` rejects unknown top-level keys,
    the rejection throws out of `unsealPayload`, and the drain acks **`discarded`** — every message
    from an upgraded sender to a not-yet-upgraded receiver is **destroyed on the relay**.
- **Interaction with RT-6 (OM-02):** RT-6's clamp must be a clamp **ON** the `aad.ts`-derived value,
  not a replacement, or it silently reverts OM-05. RT-6's future-only clamp is compatible; the
  audit's symmetric clamp would have fought it.

### 4.4 NA-GATE-4 — Headless FCM prefetch → **APPROVED (bounded, decrypt-free)**

- **Finding:** OM-04.
- **APPROVED:** a bounded, **key-free and decrypt-free** AsyncStorage stage written from the
  headless FCM VM.
  - **Bounds: 100 entries / 1 MB / 24 h.**
  - **Stored fields are exactly `{envelopeId, outerSealed, timestamp, ts}`** — no `ackToken`, no
    `senderUserId`, no recipient.
  - Owner-scoped; consumed inside `drainRelay` **only when `relay.pull` fails** (i.e. the app is
    open but offline).
- **Explicitly NOT approved / not attempted:** no ack, no schema change, no wire change, **no
  SQLCipher**, no keychain access, no `installIdentity`/`publishOwnBundle`, no runtime boot in the
  headless VM. The audit's headline outcome (delivery + ack + sender tick with no app open) is
  **not achievable** and is not being attempted.
- Land it as the **outermost** change in `drainRelay` so the loop body stays mergeable.

### 4.5 NA-GATE-5 — Delete-for-everyone (`redact` directive) → **APPROVED as a FULL single release**

- **Finding:** SYNC-4.
- **APPROVED:** an additive optional **inner** `redact?: {targetMsgId}` field on `SealedPayload`,
  fanned out per-recipient on the existing `sendReaction` machinery (durable outbox, group stamp,
  `trackPending`, HTTP fallback). **Zero server change** — the relay sees one more opaque pairwise
  ciphertext; the server-side copy is still purged only via the capability token.
- **Approved as a FULL single release: receivers + emitters + UI together** (rather than the
  two-release tolerant-receivers-first rollout the spec offered as an option).
- **Ordering constraint that rides with the approval:**

  > **Deploy ops-console BEFORE shipping the mobile build that emits redacts.**

  `apps/ops-console` consumes the _same_ `packages/messenger-core/src/crypto/sealedSender.ts` via
  the `@bravo/messenger-core` path alias (`apps/ops-console/tsconfig.json:19`). An un-redeployed
  ops-console is therefore a **strict** receiver whose `isSealedPayload` rejects the new key — and a
  shape rejection acks `discarded`, destroying the envelope on the relay.

- **Authorship binding (required):** an owner-scoped `redactRegistry` binds each tombstone to the
  claimed **author**, so a redact arriving _before_ its target cannot let a group member suppress
  someone else's message.
- **Coupling:** SYNC-5's blocked option hits the identical `SEALED_PAYLOAD_KEYS` wall. If the
  allow-list is touched, touch it **once**, on one release train.
- Scope of this increment is **delete-for-everyone only**. Edits are a sibling field on the same
  machinery, deliberately deferred.

### 4.6 NA-GATE-6 — Missed-call marker TTL → **APPROVED (7 days, env-tunable, dwell-clamped)**

- **Finding:** SYNC-5.
- **APPROVED:** raise `MISSED_CALL_MARKER_TTL_SEC` from 6 h to an **env-tunable 7-day default**,
  **hard-clamped to `min(RELAY_DWELL_SECONDS, 30d)`**.
- **Why it needed sign-off:** it lengthens a cleartext callee→caller metadata window in Redis.
- **Constraints that ride with the approval:**
  - Server-only change plus one small client gate. All four `MISSED_CALL_MARKER_TTL_SEC` read sites
    (1:1 offer queue and group ring queue) take the longer value — the two lanes must stay symmetric.
  - Cap the reconnect `call.missed` burst at the newest 50.
  - Gate the client-side missed-call **notification** (not the log row) to misses < 6 h old.
  - `clearPendingCallArtifacts` and its `{keepMarker}` semantics stay exactly as-is, so a longer TTL
    cannot resurrect an answered/declined call.
  - **Rejected (BLOCKED, not merely unapproved):** minting the missed call as a real E2EE envelope.
    A new `callEvent` key makes old receivers throw inside the receive txn → rollback → 30-day relay
    redelivery **poison pill**.
- **Sequencing:** conflicts with GW-2's `deliverPendingCallOffer` rewrite — land **after GW-2**.

### 4.7 NA-GATE-7 — Typing-indicator conversation scope → **APPROVED (opaque 16-hex `convTag`)**

- **Finding:** SYNC-6.
- **APPROVED:** an opaque **16-hex `convTag` = `sha256(domain | convKey | sortedPair)`** that is
  **different for every recipient** (so the relay cannot cluster group members), forwarded verbatim
  by the gateway, **never stored, never logged, never in Redis**, with a legacy fan-out fallback when
  the tag is absent.
- **Constraints:**
  - The raw `conversationId` on the frame stays **FORBIDDEN** (§0.2).
  - Back-compat must hold in all four sender/server/receiver version combinations.
  - Deploy **server-first**.
  - 1:1 uses a `DIRECT_CONVERSATION_KEY` on both sides so it is insensitive to the
    `direct:<uid>` vs UUID mismatch (BS-TY1) — verify this path specifically, it is the most used.
  - Accepted transient: during a mixed-version rollout a legacy-fanout `start` followed by a tagged
    `stop` can leave a stale `typingUsers` entry for ~8 s; the BS-TY2 watchdog clears it.

---

## 5. Remaining work plan

### 5.1 Wave 2 — the next action (3 items, file-disjoint)

#### RT-2 — outbox call-site adoption _(productionRuntime chain link 2)_

- **Findings:** OM-07, XO-3, XO-5, GF-1, SRV-01, OR-1 _(runtime call sites)_
- **Files (exclusive):** `src/modules/messenger/runtime/productionRuntime.ts`
- **Dependencies:** **STORE-1** (hard — landed), RT-1 (landed)
- **Scope:** wire `sendGate` into the `RelayHttpClient` construction; classify failures with
  `classifyOutboxFailure` at the drain and at the 1:1 catch; **XO-5** — keep the 1:1 bubble
  `'sending'` and return without throwing when `recordAttempt` reports `queued`, flipping to
  `'failed'` only on no-row / semantic rejection / budget exhaustion; **OR-1** — a throttled
  `kickAndDrainOutbox()` wired into AppState-`active` (replacing RT-1's raw OR-6 kick), the NetInfo
  regain branch and the WS `connected` transition, plus `clearUnreachableBackoff()` on `connected`;
  **OM-07** — a `shouldStopDrain` budget (30 s wall / 2 consecutive unreachable) in the drain loop;
  **GF-1/SRV-01** — book an early re-drain on `Retry-After` instead of waiting for the 60 s tick,
  and no red bubble on an HTTP-fallback 429. **Tighten the MSG-07 boot sweep to
  `pendingMessageIds`** (see §6).
- **Test:** `npx jest --selectProjects=messenger-crypto queuedSendBubbleState outboxKickThrottle sqlOutboxStore outboxDrainBudget relaySendPacer` → `npm run test:crypto` → `npm test` → `npm run typecheck`

#### CALL-D — dead-offer terminal state

- **Findings:** NA-02
- **Files (exclusive):** `src/screens/messenger/CallScreen.tsx`,
  `src/modules/messenger/push/fcmBootstrap.ts`, `src/modules/messenger/push/incomingCallCache.ts`
- **Dependencies:** **CALL-A** (incomingCallCache, fcmBootstrap), **CALL-B** (CallScreen) — both landed
- **Scope:** a 1 s-interval watchdog exiting on either `ACCEPT_INTENT_TTL_MS` or a new
  `incomingCallCache.isIncomingCallDead(callId)` tombstone probe; a terminal `deadOffer` flag showing
  "Couldn't connect · missed call"; reuse `declineIncomingCallBestEffort(callId, 'failed')` for
  teardown, then pop and let the unmount effect file the leg as `'missed'`.
- **Test:** `npx jest --selectProjects=app CallScreen.deadOffer` → `npx jest --selectProjects=messenger-crypto callAcceptLatch callHangupWhileRinging callDispatcherZombieEnd callRingState callResumeGuard callController.ringTimeout` → `npm run test:crypto` → `npm run typecheck`

#### GW-2 — call continuity + non-destructive drains

- **Findings:** SRV-02, SRV-03 _(SRV-02 first — both edit `deliverPendingCallOffer`)_
- **Files (exclusive):** `apps/messenger-service/src/gateway/messenger.gateway.ts`,
  `apps/messenger-service/src/relay/envelope.service.ts`,
  `apps/messenger-service/src/relay/envelope.store.ts`
- **Dependencies:** GW-1 (same gateway file — landed)
- **Scope:** (a) `rehydrateCallSession(callId, parsed.from, address)` in the replay loop — the
  persisted offer already carries caller + callee + callId, so there is **no new Redis state**, which
  is exactly what keeps this out of the architecture gate — plus an ended-tombstone skip and a 15 s
  in-memory `peer_offline` answer hold flushed on the caller's reconnect; (b) convert
  `deliverPendingCallOffer`, `deliverPendingGroupRing` and `flushPendingDelivered` to
  **peek → emit → remove-what-emitted**, reusing `runWithReplicaLock` as the short-TTL claim in place
  of the up-front index `DEL`.
- **Test:** `cd apps/messenger-service && npx jest src/gateway/messenger.gateway.calls.spec.ts src/relay/envelope.service.spec.ts && npm test && npm run typecheck` → root `npm run test:crypto` → root `npm run typecheck`

### 5.2 Waves 3–8 (unchanged from `PLAN.md` §1)

#### Wave 3 — RT-3, RELAY-2, GW-3

**RT-3 — cert metadata + deferred outbox** _(chain link 3)_

- **Findings:** OM-01, XO-1 _(the same fix — ONE change)_, XO-2 · **plus OM-05** (fold-in, §4.3)
- **Files (exclusive):** `src/modules/messenger/runtime/productionRuntime.ts`,
  `src/modules/messenger/runtime/outboxCertFreshness.ts`,
  `src/modules/messenger/runtime/deferredOutbox.ts` _(new)_,
  `src/modules/messenger/store/sqlOutboxStore.ts`
  · **with the OM-05 fold-in, add** `src/modules/messenger/runtime/outboxResealTimestamp.ts` _(new)_
- **Dependencies:** RT-2 (chain), STORE-1 (sqlOutboxStore)
- **Scope:** persist `certExpSec` + re-seal inputs (`resealKind`, `body`, `replyTo`, `reaction`) at
  the 1:1 and reaction enqueue sites via `certCache.getIssued()`; rename `resealDeferredGroupRow` →
  `resealOutboxRow` with direct/reaction/group branches reproducing each send path's AAD
  byte-for-byte; enqueue a **deferred** row (bubble stays `'sending'`) on pre-ship crypto failure in
  both lanes and move the group cert fetch **out of** the admin lock.
- **Hard instruction:** XO-1 proposes `resolveSealedOutboxAction()` and XO-2 proposes
  `planOutboxDrain()`. Produce exactly **ONE** router — `planOutboxDrain(row, payload, nowSec)` in
  `deferredOutbox.ts` returning `'ship' | 'reseal' | 'drop' | 'fail'` — and keep the drain's per-row
  work as a single `shipRow(row)` lambda, because RT-4's lane scheduler depends on that shape.
- **No schema bump** (payload is opaque `TEXT` JSON; cert-less legacy rows keep the pre-fix path).
- **Why OM-05 folds in here:** OM-05 edits the same four re-seal sites that RT-3 is already
  rewriting. Doing it separately guarantees a textual conflict. If RT-3 has already landed by the
  time you read this, OM-05 needs its own chain link instead.
- **Test:** `npx jest --selectProjects=messenger-crypto outboxCertFreshness deferredOutbox sqlOutboxStore outboxEnqueueCertMetadata` → `npm run test:crypto` → `npm test` → `npm run typecheck`

**RELAY-2 — ack batching (server)**

- **Findings:** SRV-05 (part C, server half)
- **Files (exclusive):** `apps/messenger-service/src/relay/envelope.controller.ts`,
  `apps/messenger-service/src/relay/envelope.service.ts`,
  `apps/messenger-service/src/relay/dto/ack-batch.dto.ts` _(new)_
- **Dependencies:** RELAY-1 (controller), GW-2 (envelope.service)
- **Scope:** `AckBatchDto` (≤ 100 items) + `EnvelopeService.ackBatch` that **loops the existing
  `ack()`** so the per-envelope P0-N9 possession proof stays byte-identical.
- **Test:** `cd apps/messenger-service && npx jest src/relay && npm test && npm run typecheck`

**GW-3 — VoIP wake budget**

- **Findings:** SRV-06
- **Files (exclusive):** `apps/messenger-service/src/gateway/messenger.gateway.ts`,
  `apps/messenger-service/src/push/push.service.ts`
- **Dependencies:** GW-2 (gateway). **Blocks PUSH-1** (push.service.ts).
- **Scope:** charge **once per callId** with bounded free retries; commit the charge only once a push
  is dispatchable (after the token lookup and the `fcmReady` check); raise the pair cap 6 → 10; leave
  the recipient-wide 30/min ceiling intact. Export `VOIP_WAKE_PAIR_CAP` / `VOIP_WAKE_RECIPIENT_CAP`.
- **Test:** `cd apps/messenger-service && npx jest src/push src/gateway && npm test && npm run typecheck` → root `npm run test:crypto`

#### Wave 4 — RT-4, PUSH-1

**RT-4 — drain lanes + group self-heal** _(chain link 4)_

- **Findings:** GF-6, GF-3
- **Files (exclusive):** `src/modules/messenger/runtime/productionRuntime.ts`,
  `src/modules/messenger/runtime/outboxLanes.ts` _(new)_,
  `src/modules/messenger/runtime/groupConversationUpsert.ts`,
  `src/modules/messenger/runtime/bootGroupStashDrain.ts`
- **Dependencies:** RT-3 (must rebase onto its `shipRow` lambda) · **and G2 if §5.3's ordering is
  adopted** (G2 edits the same two functions GF-3 edits)
- **Scope:** (a) `groupRowsByPeer` keyed `${peerUserId}.${peerDeviceId}` (byte-identical to
  SessionManager's per-address ratchet mutex key) + `runOutboxLanes` with
  `OUTBOX_DRAIN_LANE_LIMIT = 4`, a `shippedThisPass` set, and a stop-on-429 backoff; (b) thread a
  `divergence` flag from the tamper/key-divergence site into `selectKeyResyncCandidates` so a
  keyed-but-diverged group can still ask for a key, and spend a stash attempt **only** for structural
  replay failures or when the drain actually followed a key install (`ReplayNeedsKeyError` +
  `shouldBumpStashAttempt`, `keyChanged: false` on the boot path).
- **Constraint (arch memo §5):** keep the per-group 20 s cooldown, the signed key-request, and the
  responder-side roster/owner gates — the heal must not become a fan-out amplifier, and a failed
  decrypt must **not** relax `verifySealedAad` / `verifySenderCert`.
- **Test:** `npx jest --selectProjects=messenger-crypto outboxLanes groupConversationUpsert bootGroupStashDrain tamperKeyDivergenceStash groupSelfHeal groupRekeyConverge groupCreateEpochBootstrap pendingGroupEnvelopeStore sqlOutboxStore outboxCertFreshness groupBroadcast firstMessageDrop envelopeDelivered` → `npm run test:crypto` → `npm test` → `npm run typecheck`
- **Watch:** if the B-75 "backup got slow" symptom (txnChain pressure) appears on device, drop the
  lane limit to 3 — **never** bypass the chain.

**PUSH-1 — iOS banner lane**

- **Findings:** OR-3
- **Files (exclusive):** `apps/messenger-service/src/push/push.service.ts`,
  `src/modules/messenger/push/fcmBootstrap.ts`
- **Dependencies:** GW-3 (push.service.ts), CALL-D (fcmBootstrap.ts)
- **Scope:** add a **constant-string** `aps.alert` (+ thread-id/sound) to the iOS chat wake and
  request iOS notification authorization client-side; every client draw path stays Android-only so
  exactly one banner exists in every state including force-quit. The `aps` block must contain **no
  `senderUserId`**.
- **Test:** `cd apps/messenger-service && npx jest src/push && npm test` → `npx jest --selectProjects=messenger-crypto or3IosBannerLane fcmHeadlessRouting backgroundMessageNotifier` → `npm run test:crypto` → `npm run typecheck`

#### Wave 5 — RT-5 — fail closed on a missing group key _(chain link 5)_

- **Findings:** GF-5
- **Files (exclusive):** `src/modules/messenger/runtime/productionRuntime.ts`,
  `src/modules/messenger/runtime/messagingLogic.ts`, `src/screens/messenger/ChatScreen.tsx`
- **Dependencies:** **RT-4** (GF-3's self-heal must exist first — this converts silent corruption
  into a visible "can't send yet" dead-end), GRP-1 (ChatScreen)
- **Scope:** a pure `groupSendBlockedReason` helper; **throw**, not fall back, in the group send prep
  when `masterKeyB64` is falsy; a rate-limited `requestGroupKeyResync` fired from the catch
  **outside** the admin lock; a pre-upload gate in `sendMedia`; ChatScreen composer/banner gate.
- **Arch note (memo §6 — ALLOWED, this is a strengthening):** preserve the documented exception —
  `create` and `key-request` are legitimately unwrapped; do **not** fail those closed or key
  distribution deadlocks.
- **Test:** `npx jest --selectProjects=messenger-crypto messagingLogic groupSendKeyGate groupPlaintextReject groupBroadcast groupConversationUpsert bootGroupStashDrain adhocCallKeyLookup groupCallKeyWait` → `npx jest --selectProjects=app sendErrorText` → `npm run test:crypto` → `npm test -- --selectProjects=app` → `npm run typecheck`

#### Wave 6 — RT-6 — receive-path ordering + durable reactions _(chain link 6)_

- **Findings:** OM-02, SYNC-7
- **Files (exclusive):** `src/modules/messenger/runtime/productionRuntime.ts`,
  `src/modules/messenger/runtime/orderingClock.ts` _(new)_,
  `src/modules/messenger/runtime/reactionMerge.ts` _(new)_,
  `src/modules/messenger/store/pendingReactionStore.ts` _(new)_,
  `src/modules/messenger/store/sqlMessageStore.ts`,
  `src/modules/messenger/crypto/db.ts` ← **claims SCHEMA_VERSION 15 → 16**
- **Dependencies:** STORE-1 (db.ts v15 — landed), RT-5 (chain)
- **Scope:** (a) `orderingClock.ts` clamps the **ordering** timestamp to the server/receive reference
  **only in the impossible FUTURE direction** (2-min skew), threaded as an optional `serverTsMs`
  param into `handleIncoming` / `doHandleIncoming` / `replayGroupSealedDecode`; (b) `applyReaction`
  becomes async with a three-tier resolve (store window → `findReactionTarget` → durable
  `pending_reactions` stash) and **persists on every tier** (`sqlMessages.upsert` — missing today,
  which is why reactions vanish on every cold boot), replayed after each of the 4 inbound upsert
  sites plus a boot sweep, with the M-07 blocked-peer gate re-applied at drain.
- **Hard constraints:**
  - **Display/ordering only.** The clamp must never be fed into `verifySealedAad`, `seenEnvelopes`
    dedup, or `expires_at`. `SEALED_AAD_FUTURE_MS` / `MAX_AGE_MS` / `SKEW_MS` must be **unchanged**
    (assert this in the test).
  - **Do NOT implement the audit's symmetric clamp** (§3 row 1).
  - **SYNC-7 must not touch** `sendReaction`'s outbox enqueue hunk — RT-3 owns it.
  - Must be a clamp **ON** the `aad.ts`-derived value, or it reverts OM-05 (§4.3).
- **Test:** `npx jest --selectProjects=messenger-crypto orderingClock appendMessageDedup reactionMerge pendingReactionStore pendingReactionApply receiveTransaction blockedPeersAndTombstones bootGroupStashDrain groupInboundBody sqlMessageStoreResend firstMessageDrop` → **BACKUP_LOOP §4:** `npx jest --selectProjects=messenger-crypto backupMerkle messageMirrorMerkleFlush mirrorLedgerBootSweep backupRepairCommit wipeAtRest` → `npm run test:crypto` → `npm test` → `npm run typecheck`

#### Wave 7 — RT-7 — per-recipient envelope ids for group read receipts _(chain link 7)_

- **Findings:** SYNC-1
- **Files (exclusive):** `src/modules/messenger/runtime/productionRuntime.ts`,
  `src/modules/messenger/store/types.ts`, `src/modules/messenger/store/messengerStore.ts`,
  `src/modules/messenger/runtime/messagingLogic.ts`,
  `src/modules/messenger/runtime/envelopeDelivered.ts`,
  `src/modules/messenger/crypto/db.ts` ← **claims SCHEMA_VERSION 16 → 17**,
  `src/modules/messenger/store/sqlMessageStore.ts`
- **Dependencies:** RT-6 (db.ts, sqlMessageStore.ts), RT-5 (messagingLogic.ts), MS-1 (messengerStore.ts)
- **Scope:** persist an `envelope_ids` map (recipientUserId → envelopeId) via a widened
  `updateMessageEnvelopeId(…, recipientUserId?)`; match receipts through a pure
  `readReceiptEnvelopeMatch` (strict per-recipient binding, scalar fallback for legacy/1:1 rows); add
  `envelope_ids_json` + `receipts_json` columns.
- **🔴 HARD BACKUP GATE (B-94 `root_mismatch` class):** `messageMirror.ts` computes `versionHash`
  over `JSON.stringify(serializeMessage(msg))`. If `envelope_ids_json` or `receipts_json` enters
  `serializeMessage`, **every row's hash changes and the next boot re-mirrors the entire history.**
  Either keep both fields **out of** `serializeMessage`, or get explicit sign-off for a full
  re-mirror. Run `docs/runbooks/BACKUP_LOOP.md` §4 gates **and** the §5 idle-boot silence probe
  before declaring done.
- **Rejected alternative:** the audit's "match receipts by `clientMsgId`" (§3 row 11).
- **Test:** `npx jest --selectProjects=messenger-crypto messagingLogic groupReadReceipts groupReceiptEnvelopeSet envelopeDelivered sqlMessageStoreResend appendMessageDedup messageStatusMonotonic` → **BACKUP_LOOP §4:** `npx jest --selectProjects=messenger-crypto backupMerkle messageMirrorMerkleFlush mirrorLedgerBootSweep backupRepairCommit` → `npm run test:crypto` → `npm test` → `npm run typecheck`

#### Wave 8 — RT-8 — ack coalescing + lock-screen send recovery _(chain link 8)_

- **Findings:** SRV-05 (parts B + C, client half), OR-2
- **Files (exclusive):** `src/modules/messenger/runtime/productionRuntime.ts`,
  `packages/messenger-core/src/transport/relayClient.ts`,
  `src/modules/messenger/transport/ackQueue.ts` _(new)_,
  `src/modules/messenger/runtime/sendRecoveryClock.ts` _(new)_,
  `packages/messenger-core/src/transport/client.ts`
- **Dependencies:** **RELAY-2** (the `/envelopes/ack-batch` route must exist), STORE-1 (relayClient),
  RT-7 (chain)
- **Scope:** (a) `RelayHttpClient.ackBatch` + a 100-item / 200 ms client coalescer that falls back to
  per-envelope acks on a 404 from an un-upgraded relay, and **skip the ack entirely when there is no
  `ackToken`** (archive-replay frames currently POST an ack that can only 403 while burning budget);
  (b) drain the durable outbox over HTTP on AppState `background`; add an optional `onServerSignal`
  to `TransportClient` fired from the Manager `'ping'` + `onAny` (the only clock that survives a
  locked screen — proven by B-100/B-101) and hang a throttled `drainOutbox` off it; **upgrade RT-1's
  coalescer in-flight guard to wall-clock ownership** (`DRAIN_STUCK_MS > TRANSPORT_TIMEOUT_MS`) so
  one wedged POST cannot swallow every later drain — do **not** add a second guard; optionally extend
  the immediate-reopen gate with `hasPendingOutbound`.
- **Test:** `npx jest --selectProjects=app ackQueue` → `npx jest --selectProjects=messenger-crypto sendRecoveryClock transportServerSignal socketReauth transportServerReconnect transportSingleFlight sqlOutboxStore callResumeGuard archiveReplayDrain` → `npm run test:crypto` → `npm test` → `npm run typecheck` → `cd apps/ops-console && npm run typecheck`

### 5.3 NEW work items created by the 7 approved gates

Six new items (plus one fold-in). **Item IDs `G1`…`G7` are introduced by this handoff — they do not
appear in `PLAN.md`.** They obey the same rule as every other item: **exactly one
`productionRuntime.ts` holder per wave.**

| Item       | Gate      | Findings                                | Owns (exclusive)                                                                                                                                                                                                                                                                                                                                               | Depends on                                                                  | Test                                                                                                                                                                                                                                      |
| ---------- | --------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **G1-SRV** | NA-GATE-1 | OM-03 / SYNC-3 / SRV-08 _(server half)_ | `apps/messenger-service/src/relay/envelope.controller.ts`, `…/envelope.service.ts`, `…/envelope.store.ts`, `…/envelope.types.ts`, `…/dto/send-envelope.dto.ts`, new receipts DTO                                                                                                                                                                               | RELAY-2 (controller + service), GW-2 (envelope.service, envelope.store)     | `cd apps/messenger-service && npx jest src/relay && npm test && npm run typecheck`                                                                                                                                                        |
| **G1-RT**  | NA-GATE-1 | same _(client half)_ — **chain link**   | `src/modules/messenger/runtime/productionRuntime.ts`, `src/modules/messenger/runtime/httpReceiptReconcile.ts` _(new — pick ONE name, §4.1)_, `packages/messenger-core/src/transport/relayClient.ts` + its `index.ts`                                                                                                                                           | **G1-SRV deployed**, RT-8 (chain + relayClient)                             | `npx jest --selectProjects=messenger-crypto receiptReconcile envelopeDelivered undeliverableResend` → `npm run test:crypto` → `npm run typecheck` → `cd apps/ops-console && npm run typecheck`                                            |
| **G2**     | NA-GATE-2 | GF-2, SYNC-2 — **chain link**           | `src/modules/messenger/runtime/productionRuntime.ts` **only**                                                                                                                                                                                                                                                                                                  | **RELAY-1 deployed**; must land **before RT-4**                             | `npx jest --selectProjects=messenger-crypto groupBroadcast groupRekeyConverge groupCreateEpochBootstrap groupSelfHeal sqlOutboxStore` → `npm run test:crypto` → `npm test` → `npm run typecheck`                                          |
| **G3**     | NA-GATE-3 | OM-05                                   | **FOLD INTO RT-3** + new `src/modules/messenger/runtime/outboxResealTimestamp.ts`                                                                                                                                                                                                                                                                              | RT-3                                                                        | RT-3's command + `npx jest --selectProjects=messenger-crypto outboxResealTimestamp`                                                                                                                                                       |
| **G4**     | NA-GATE-4 | OM-04 — **chain link**                  | `src/modules/messenger/push/prefetchedEnvelopes.ts` _(new)_, `src/modules/messenger/push/headlessPrefetch.ts` _(new)_, `src/modules/messenger/push/mutedLookup.ts`, `src/modules/messenger/push/fcmHeadless.ts`, `src/modules/messenger/runtime/productionRuntime.ts` (`drainRelay` only), `src/modules/messenger/runtime/wipeAtRest.ts`                       | PUSH-1 / CALL-D (push lane), any RT chain link                              | `npx jest --selectProjects=messenger-crypto headlessPrefetch prefetchedEnvelopes fcmHeadlessRouting wipeAtRest drainRelay` → `npm run test:crypto` → `npm run typecheck`                                                                  |
| **G5**     | NA-GATE-5 | SYNC-4 — **chain link**                 | `packages/messenger-core/src/crypto/sealedSender.ts`, `src/modules/messenger/crypto/sealedSender.ts` (legacy mirror), `src/modules/messenger/runtime/redactRegistry.ts` _(new)_, `src/modules/messenger/runtime/productionRuntime.ts`, `src/modules/messenger/runtime/runtime.ts`, `src/screens/messenger/ChatScreen.tsx`                                      | RT-5 (ChatScreen), any RT chain link. **ops-console redeploy first** (§4.5) | `npx jest --selectProjects=messenger-crypto sealedSender redactRegistry redactApply appendMessageDedup blockedPeersAndTombstones` → `npm run test:crypto` → `npm test` → `npm run typecheck` → `cd apps/ops-console && npm run typecheck` |
| **G6**     | NA-GATE-6 | SYNC-5                                  | `apps/messenger-service/src/gateway/messenger.gateway.ts` + the client `call.missed` age gate in the call-dispatcher module                                                                                                                                                                                                                                    | **GW-2** (same gateway function), GW-3                                      | `cd apps/messenger-service && npx jest src/gateway && npm test && npm run typecheck` → root `npm run test:crypto`                                                                                                                         |
| **G7-GW**  | NA-GATE-7 | SYNC-6 _(server half)_                  | `apps/messenger-service/src/gateway/messenger.gateway.ts`, `apps/messenger-service/src/gateway/protocol.ts`                                                                                                                                                                                                                                                    | G6 (same gateway file)                                                      | `cd apps/messenger-service && npx jest src/gateway && npm test && npm run typecheck`                                                                                                                                                      |
| **G7-RT**  | NA-GATE-7 | SYNC-6 _(client half)_ — **chain link** | `packages/messenger-core/src/transport/protocol.ts`, `src/modules/messenger/transport/protocol.ts`, `src/modules/messenger/runtime/messagingLogic.ts`, `src/modules/messenger/runtime/productionRuntime.ts`, `src/modules/messenger/runtime/runtime.ts`, `src/screens/messenger/ChatScreen.tsx`, _(optional)_ `apps/ops-console/src/lib/messenger/protocol.ts` | **G7-GW deployed**, RT-5 (messagingLogic, ChatScreen), G5 (ChatScreen)      | `npx jest --selectProjects=messenger-crypto messagingLogic typingConvTag` → `npm run test:crypto` → `npm test` → `npm run typecheck` → `cd apps/ops-console && npm run typecheck`                                                         |

**Recommended chain order** (one `productionRuntime.ts` holder per wave):

`RT-1` (w1, done) → `RT-2` (w2) → `RT-3`+G3 (w3) → **`G2` (w4, inserted)** → `RT-4` (w5) →
`RT-5` (w6) → `RT-6` (w7) → `RT-7` (w8) → `RT-8` (w9) → `G1-RT` (w10) → `G4` (w11) →
`G5` (w12) → `G7-RT` (w13).

> **The one ordering decision a resuming agent must make:** G2 (GF-2) and RT-4 (GF-3) both edit
> `sendKeyRequest` and `reshareGroupKeyState`. The GF-2 spec says sequence **G2 first** (it only
> replaces the `deliver` closure body; GF-3 then changes trigger/cooldown logic), and `PLAN.md` §2
> says NA-GATE-2 must land "before/with RT-4". Inserting G2 at wave 4 shifts RT-4…RT-8 down one wave
> — that is the recommendation. The alternative (land G2 after RT-4) is workable but guarantees a
> manual merge in two functions.

Server items are otherwise wave-free — they slot in wherever their dependency is met, subject to §8.

### 5.4 Schema-version single-writer chain

`SCHEMA_VERSION` is **claimed, not chosen.** Read the current constant in
`src/modules/messenger/crypto/db.ts` before editing; if it is not what this table says, **stop and
report**.

| Version     | Claimed by  | Change                                                 | State                                                                     |
| ----------- | ----------- | ------------------------------------------------------ | ------------------------------------------------------------------------- |
| 14 → **15** | **STORE-1** | `outbox.soft_attempts`                                 | **SHIPPED in `c9728f9`** (`db.ts:59` is now `const SCHEMA_VERSION = 15;`) |
| 15 → **16** | **RT-6**    | `pending_reactions` table                              | **SHIPPED in `4d21cd3`** (`db.ts` is now `const SCHEMA_VERSION = 16;`)    |
| 16 → **17** | **RT-7**    | `messages.envelope_ids_json`, `messages.receipts_json` | **SHIPPED in `bcff917`** (kept OUT of serializeMessage — no re-mirror)    |

No other item may bump it. Every new `ALTER` goes **after** the v7 rebuild block. There is **no
migration harness in the repo** — the v15/v16/v17 `ALTER`s can only be verified by an in-place APK
upgrade on a device (§9).

---

## 6. Wave 1 residuals — MUST DO IN WAVE 2

Three known gaps left by `c9728f9`. All three are RT-2's responsibility.

**(a) `allMessageIds()` → `pendingMessageIds()` in the MSG-07 boot sweep.**
`productionRuntime.ts:1644` still calls `sqlOutbox.allMessageIds()`. STORE-1 added
`pendingMessageIds()` (`sqlOutboxStore.ts:201` — "every message_id that still has a **RETRIABLE**
outbox row") specifically for this site. Until RT-2 switches it:

- **XO-5's boot-sweep half stays inert** — a hydrated `'sending'` bubble whose row has already gone
  terminal is not flipped to `'failed'`, because `allMessageIds()` still counts it.
- `pendingMessageIds()` stays dead code and will be flagged by `npm run deadcode`.

**(b) RT-2 must pass `{transient, deferMs}` into `recordAttempt`, NOT `retryAfterMs`.**
The two names are different layers and mixing them is a **TypeScript excess-property error**:

- `RelayHttpError.retryAfterMs` (`packages/messenger-core/src/transport/relayClient.ts:72`) is the
  parsed `Retry-After` value **on the error object**.
- `recordAttempt(clientMsgId, peerUserId, peerDeviceId, opts?)` accepts exactly
  `{unreachable?, transient?, deferMs?, permanent?}` (`sqlOutboxStore.ts:316`) and returns
  `{attempts, failed, queued}`.
- The correct wiring is: classify → if transient, `recordAttempt(…, {transient: true, deferMs:
err.retryAfterMs})`. `deferMs` overrides the computed backoff and is clamped to 300 s.

**(c) `npm run deadcode` (knip) will flag STORE-1's new exports until RT-2 adopts them — expected.**
Verified unused in production code as of `c9728f9`: `pendingMessageIds`, `kickPending`,
`clearUnreachableBackoff`, `classifyOutboxFailure`, `isPermanentRelayRejection`,
`isBackpressureError`, and the whole of `relaySendPacer.ts` / `outboxDrainBudget.ts`
(`productionRuntime.ts` imports neither, and constructs `RelayHttpClient` without a `sendGate`).
This is by design: STORE-1 was written to be additive and back-compatible so the tree stays green at
zero adoption. **Do not "clean up" these exports — RT-2 consumes them.**

> **Consequence for anyone reading `c9728f9`'s commit message:** it says the XO-3/OM-07
> classification, XO-5's bubble state and GF-1/SRV-01's client pacing are fixed. The _layer_ exists;
> **no call site uses it**, so on-device behaviour for those five findings is unchanged until RT-2
> lands. `productionRuntime.ts` still calls `recordAttempt(…, {unreachable: isUnreachableError(e)})`
> at all three sites, and `:2932` still flips the 1:1 bubble to `'failed'`. That is why they are
> **PARTIAL** in §2, not DONE.

---

## 7. Baseline gates + how to verify

| Gate                  | Command                                                                                           | Threshold                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Mobile typecheck      | `npx tsc --noEmit 2>&1 \| grep -c "error TS"`                                                     | **≤ 47** (`.tsc-baseline.json`). **Never run `npm run tsc:rebaseline`.** |
| Crypto suite          | `npm run test:crypto`                                                                             | all green                                                                |
| Messenger service     | `cd apps/messenger-service && npm test`                                                           | all green                                                                |
| Log audit             | `npx jest packages/messenger-core/__tests__/logAudit.test.ts` (also inside `npm run test:crypto`) | green — no body/reaction/payload/key/token/plaintext in any log line     |
| Ops-console typecheck | `cd apps/ops-console && npm run typecheck`                                                        | required for any `packages/messenger-core/**` change                     |
| Dead code             | `npm run deadcode`                                                                                | see §6(c) — expected findings until RT-2                                 |
| Backup gates          | `docs/runbooks/BACKUP_LOOP.md` §4 + §5                                                            | **mandatory** for RT-6 and RT-7                                          |

**Post-Wave-1 recorded numbers (`c9728f9`):**

- **tsc: 47 errors = 47 baseline.** Zero new errors, but the gate is **AT the ceiling** — the next
  regression breaks it.
- **messenger-crypto: 1924 / 1924 tests green, 211 suites.**
  ⚠ **Known flake:** 1–2 suites intermittently fail _to run_ under parallel Jest workers — a Jest
  transform-cache race, not an assertion failure. They pass in isolation. **This is not a
  regression.** Re-run the named suite alone before investigating.
- **messenger-service: 34 suites / 338 tests green.**
- **Device verification: none.** See §9.

---

## 8. Deploy ordering

**Server first, client after.** Every client change in this batch is deliberately safe against the
**old** server (the pacer is over-conservative, `ackBatch` falls back on a 404, `Retry-After` is
already emitted today), but the reverse is not guaranteed.

1. **Server sequence:** `RELAY-1` → `GW-1` → `GW-2` → `RELAY-2` / `GW-3` → `PUSH-1` (server half)
   → then the gate servers: `G1-SRV`, `G6`, `G7-GW`.
   _(RELAY-1 and GW-1 are already committed in `c9728f9` and still need deploying to staging.)_
2. **Client after:** the `RT` chain in wave order.
3. **`RELAY-1` must reach staging before STORE-1/RT-2 ship to devices** — the client pacer is sized
   against the deployed cap (`RELAY_SEND_WINDOW_MS = 60_000`, `BUDGET = 240` = 80 % of the deployed
   300/60 s).
4. **`G2` must land after `RELAY-1` is deployed** — it converts key fan-out into N HTTP submits.
5. **Redeploy `apps/ops-console` BEFORE the mobile build that emits redacts (`G5`).** It shares
   `packages/messenger-core` via the `@bravo/messenger-core` alias, so an un-redeployed console is a
   strict receiver that destroys the envelope (§4.5).
6. **`G7-GW` deploys before `G7-RT`** ships (server-first, §4.7).

**`WS_SESSION_RECOVERY` — do not flip it in a commit.**
It is `false` in every committed file and must stay that way:
`apps/messenger-service/.env.example:32`, `infra/env/messenger.env.example:30`,
`docker-compose.yml:46` (`'${WS_SESSION_RECOVERY:-false}'`),
`apps/messenger-service/src/config/configuration.ts:33` (defaults to `'false'`).
Flipping it **activates ~225 lines of never-unit-tested code that overrides `broadcast()` for every
WS event.** The staging flip is a **separate ops action on single-replica staging only**, after
merge, verified against `docs/qa/MESSENGER_TEST_PLAN.csv` NET-29 / `TEST_PLAN.md` F2.

**Builds:** CALL-A (native Kotlin module, landed) and PATCH-1 (patch-package, **not** landed —
GCV-3 closed) require an **APK rebuild**. `android/` is `.gitignore`d → the Kotlin file was added
with `git add -f`; do the same for any further native change. Everything else is JS/TS.

---

## 9. Device-verification debt

**Nothing in Wave 1 was device-verified.** There is no device attached in the implementation
environment. Build context: **Pixel 6a, Android 17**; the installed release build **v1.0.117 /
vc145 is NOT debuggable** (JS telemetry stripped, no `run-as`), so all verification must key on
native logcat + screenshots.

**State this explicitly in every sign-off. Do not claim a device check you did not run.**

### 🔴 Highest-priority owed check — schema v14 → v15

`outbox.soft_attempts` (STORE-1, shipped in `c9728f9`) has **never been exercised by an in-place APK
upgrade.** There is **no migration harness in the repo**, so a device is the only thing that can
prove the `ALTER` runs. Required probe:

- Install the pre-v15 release build, queue outbox rows, then install the new build **in place**
  (not a fresh install).
- Assert **no `no such column: soft_attempts`** anywhere in logcat.
- Assert the queued rows still drain.

The same probe is owed for v16 (RT-6) and v17 (RT-7) when they land.

### Owed per item

| Item                            | Owed device test                                                                                                                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CALL-A** (NA-01/03/04)        | Killed / locked-screen call answer with **two-way audio** and `startForeground ok type=132/196` in logcat. Plus the NA-01 repro: background the app with a healthy WS, receive a call, confirm the FCM wake no longer erases the SDP. |
| **CALL-B** (NA-06)              | A **single** ringtone across all three ring states (foreground, warm background, killed).                                                                                                                                             |
| **STORE-1 / RT-2 / RT-3**       | Airplane mode → 70-minute queue → all rows drain and **nothing** reaches `'failed'`.                                                                                                                                                  |
| **RELAY-1 + RT-4**              | ≥ 10-member group burst with **no bubble parked in `'sending'`**; and a > 30-member group receiving one message fully.                                                                                                                |
| **VID-1 / VID-2** (GCV-1/2/4/5) | 3-device group video: logcat capture stays **640×480** across a voice→video upgrade and a camera flip; rear-camera self tile is **not** mirrored.                                                                                     |
| **RT-6** (SYNC-7)               | Force-stop → relaunch: reactions survive.                                                                                                                                                                                             |
| **RT-6 / RT-7**                 | `BACKUP_LOOP.md` §5 **idle-boot silence** probe (an idle boot must upload nothing).                                                                                                                                                   |
| **WS-1** (OR-5/SRV-07)          | Multi-client reconnect verification on single-replica staging **before** the flag flip.                                                                                                                                               |
| **GCV-3** (if ever revived)     | Temporary `Log.d` in `onFrameResolutionChanged` must print `640x480 rot=90`; `480x640 rot=90` means the patch is inverted and must be deleted.                                                                                        |

Additional matrix rows carried from the original audit's §II Phase E (clock-skew pair, reboot with a
queued outbox, answer-during-deploy) remain owed.

---

## 10. NEW finding — sealed-sender compliance gap (pre-existing, OUT OF SCOPE)

**This is not in the original audit and was NOT introduced by any B-121 work.** Three independent
specs (OM-03, SYNC-3, SRV-08) surfaced it while designing NA-GATE-1, because the architecture memo's
premise — that the WS submitter binding is "an in-memory socket binding that dies with the
connection" — is **factually wrong in the current tree**.

**Verified in the current tree:**

- `apps/messenger-service/src/relay/envelope.store.ts:316-326` — `storeSubmitter()` writes
  `submitter:{envelopeId}` = `"{userId}:{deviceId}"` into **Redis**, with a caller-supplied TTL.
  The only call site is `envelope.service.ts:235`
  (`await this.store.storeSubmitter(envelopeId, input.submitter, effectiveTtl)`), and `effectiveTtl`
  defaults to `dwellSeconds` — `relay.dwellSeconds ?? 30 * 24 * 3600` (`envelope.service.ts:39-40`).
  So the linkage can persist **up to 30 days**.
- `envelope.store.ts:373-386` — `addPendingDelivered()` writes `delivered-pending:{senderUserId}`
  sets with a **7-day** TTL (`PENDING_DELIVERED_TTL_SEC = 7 * 24 * 3600`, `:367`).
- Both were shipped as **previously-approved audit fix P0-T6** (and RELAY-C3 for the pending-delivered
  queue), and are documented in-code as sealed-sender-preserving because the mapping "evaporates the
  moment the ack is processed".

**Why it is a finding:** that is a **persisted sender↔envelope linkage at rest**, which contradicts
the architecture contract:

- `docs/architecture/MESSENGER_BACKEND.md:156` — _"Sender user id | **No** (after JWT rate-limit
  check, not stored) | Sealed Sender"_ (and `:137` — _"JWT verified (rate-limit only — we do NOT
  persist submitter identity)"_).
- `docs/architecture/SIGNAL_PROTOCOL_IMPLEMENTATION.md:514` — the relay _"**deliberately drops
  submitter identity before storage** to preserve sealed sender."_

Between submit and ack (which can be the full dwell window if the recipient never comes online),
Redis holds a direct sender→envelope mapping, and `delivered-pending:{senderUserId}` holds a
sender→envelope-set mapping for up to 7 days regardless of ack.

**Disposition: OUT OF SCOPE for this fix batch, needs its own triage decision.** It is pre-existing
and owner-approved under a different audit, and removing it would break the WS lane's
delivered/undeliverable receipts that NA-GATE-1 is separately trying to _extend_ to HTTP. It does
**not** license extending the linkage to the HTTP lane (two wrongs) — NA-GATE-1's approved design (A)
deliberately uses an anonymous capability handle instead.

**Ask the architecture owner:** should the `submitter:{envelopeId}` TTL be reduced to a short
receipt window (rather than full dwell), and should `delivered-pending:{senderUserId}` be re-keyed
off an anonymous handle? File as its own finding before touching it.

---

---

# PART II — ORIGINAL AUDIT (2026-07-19), PRESERVED

> **Read Part II for diagnosis, evidence and file:line citations — they were independently
> re-verified and are still accurate (modulo the line drift noted per-spec).**
>
> **Do NOT implement Part II's remedies without checking Part I §3 and §0.2 first.** Findings whose
> remedy was superseded carry a ⚠ banner. The original §7 fix plan has been **deleted** (§II.7).

**Mandate (founder, details.md):** WhatsApp/Signal-grade reliability across 1:1 messaging, group
messaging, voice/video calling, notifications, synchronization, and cross-platform behavior —
zero loss, zero duplicates, zero out-of-order delivery, exactly-once processing, reliable
notification call-answer, correct group-call self-view, perfect Android↔iPhone sync, full
offline recovery.

**Audited tree:** `main` @ `512a7f0` (includes the same-day slow-network merge `b65f145`,
SN-01..SN-11). Client build context: v1.0.117 / vc145 (Firebase qa, uploaded 2026-07-19) with the
@livekit/react-native-webrtc 125.0.12 + webrtc-sdk M125 stack swap. Server: staging Contabo
messenger-service with B-100/B-101 `auth.refresh`, P-0 `SFU_ROOM_TOKEN_SECRET`, B-112/B-113 live.

**Method:** 76-agent workflow (`messenger-reliability-audit`, run `wf_13a10abb-f05`) — 3 context
agents (same-day fix scope, iOS↔Android interop state, device-log mining), 8 parallel audit
dimensions, then one adversarial verifier per finding (Opus) + a second impact/prior-art verifier
for every P0/P1. **Original verdicts: 50 findings — 46 CONFIRMED, 4 UNVERIFIED (marked ⚠ below),
0 refuted.** _(Superseded: the 2026-07-20 spec pass re-verified all 50 — 37 CONFIRMED, 13
CONFIRMED-WITH-DRIFT, 0 refuted; all four ⚠ findings are now confirmed. See Part I §1.)_

**Result: 0 P0 · 13 P1 · 19 P2 · 18 P3.** No unconditional message-loss defect exists on the
happy path — the outbox/dedup/ack core is genuinely strong (§II.5). The founder's five complaints
are all real and all root-caused (§II.1). The single biggest reliability lever is the
group-fan-out vs relay-throttle collision (GF-1/SRV-01); the single most user-visible call bug is
the notification-Answer cache clobber (NA-01).

---

## II.1 Verdict per founder complaint

| #   | Complaint                                                    | Verdict                                        | Primary root causes                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------ | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 1:1 messages out of order / delayed / very late              | **CONFIRMED — 4 mechanisms**                   | OM-02 (sender-clock ordering: skewed peer visibly reorders the thread), OM-03 (HTTP-submitted sends produce **no delivered tick** → "delayed" perception), XO-1/OM-01 (rows queued >1h ship a dead sender-cert → **silent loss behind a 'sent' tick**), OR-2 (every send-recovery timer freezes while locked → stuck until unlock)                                                                                           |
| 2   | Group messages reach members at different times / much later | **CONFIRMED — deterministic**                  | GF-1/SRV-01 (30-per-10s relay throttle vs per-member HTTP fan-out: >30 envelopes in 10s → tail 429s → those members wait for the 60s drain tick; >30-member groups can NEVER deliver fully live), GF-2/SYNC-2 (key-material fan-out is fire-and-forget → missed rekey forks a member off the key), GF-3 (the key self-heal for stale-key members is dead code + stash deleted after 3 boots → **permanent per-member loss**) |
| 3   | Notification call accept occasionally fails to establish     | **CONFIRMED — 3 independent killers**          | NA-01 (FCM bg-wake overwrites the SDP-bearing call cache → Answer sticks at "Answering…" — deterministic when WS offer beats the push), SRV-02 (call.answer silently dropped after any gateway restart — staging auto-deploys on every push), NA-04 (Telecom answer never foregrounds the app → background-FGS mic denial; matches 2026-07-10 device logs)                                                                   |
| 4   | Group-call self video tile zoomed / mis-scaled               | **CONFIRMED — capture + layout**               | GCV-1 (camera re-acquisition drops the 640×480 constraint → fork defaults to 1280×720 → cover-crop jumps to 21–39%), GCV-2 (all tiles are fixed-rect + objectFit 'cover'; the adaptive-aspect tile component is inert), GCV-4 (self tile stays mirrored on rear camera)                                                                                                                                                      |
| 5   | Android ↔ iPhone not perfectly synchronized                  | **CONFIRMED — but NOT a sync-protocol defect** | Zero platform gates exist in ticks/receipts/typing/reactions/presence code. Divergence = iOS notification surfacing entirely gated off (IOSMSG-1/2/3, open) + TestFlight build skew (143/144 vs vc145) + missing delete-for-everyone/edit protocol (SYNC-4) + per-device-only call history (SYNC-5 ⚠)                                                                                                                        |

**Expected-behavior scorecard (details.md acceptance criteria):**

| Expectation                                   | Status                                                                                                         |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Zero message loss                             | ✗ three loss classes: XO-1 (stale cert >1h), GF-3 (stash deletion), SYNC-7 ⚠ (reactions)                       |
| Zero silent failures                          | ✗ XO-1, GF-2, SRV-02, SRV-03 all fail silently today                                                           |
| Zero duplicates                               | ✓ server SET-NX + durable seen-envelopes + in-flight guard (§II.5) — only XO-5 invites _user-typed_ duplicates |
| Zero out-of-order                             | ✗ OM-02 (clock skew), OM-05 (reseal re-stamps time), OM-06 (chat-list preview regresses)                       |
| Immediate delivery when network available     | ◐ GF-1 throttle staggering; OR-6 (60s wait after resume); OR-4 (swallowed drain trigger)                       |
| Automatic retry until success                 | ◐ SN-04 fixed offline; XO-3 still burns budget on 5xx/429 → permanent 'failed'                                 |
| Eventual delivery after reconnection          | ◐ works foreground; OR-1 (no background/reboot drain), OR-2 (locked = frozen)                                  |
| Exactly-once processing                       | ✓ (§II.5 receive-side dedup is transactional and durable)                                                      |
| Persistent outgoing queue                     | ✓ SQLCipher outbox, enqueue-before-send — but XO-2 (cold cert cache bypasses it)                               |
| Reliable acknowledgements                     | ◐ WS lane ✓; HTTP lane has no submitter mapping → no delivered/undeliverable at all (OM-03/SYNC-3/SRV-08)      |
| Reliable server fan-out / per-recipient retry | ✓ server side (§II.5); throttle chokes it (SRV-01)                                                             |
| Notification accept always connects           | ✗ NA-01/NA-02/NA-04/SRV-02                                                                                     |
| Correct self-view scaling / grid              | ✗ GCV-1/2/3/4; grid math itself ✓ (B-17/B-19 fixes hold)                                                       |
| Offline recovery matrix                       | ◐ reconnect/restart ✓; reboot ✗ (no receiver), background ✗ (OR-1/OR-2), Wi-Fi↔mobile ◐ (OR-4)                 |

---

## II.2 What was already fixed the same day (do not re-report)

The `b65f145` merge (slow-network audit) verified **in the tree** by the context pass:

- **SN-01** `fetchWithTimeout` (20s AbortController) on all messenger-core HTTP clients — a stalled
  request no longer freezes the serial drain forever.
- **SN-02** media transfers: inactivity-watchdog (30s stall) instead of 60s wall-clock; upload
  timeout actually armed.
- **SN-03** RTT-adaptive WS ack watchdog (clamp 4×RTT, 5–20s) + reconnect only on ≥40s server
  silence — B-72 flapping closed.
- **SN-04** offline sends no longer burn the outbox budget (`recordAttempt({unreachable})`).
- **SN-05** offer/answer send loop truthful w/ 12s budget + cancellation guard (residual → NA-05).
- **SN-06** group outbox rows re-seal expired sender-certs at drain (residual → XO-1: 1:1/reactions
  not covered).
- **SN-07** group-call boot `waitForTransportOpen` (10s) on all sfu.\* steps.
- **SN-08..11** group add-member error codes + multi-select UI + "X added Y" system line.

Still open from that audit (untouched by the merge): fan-out amplification/no batch endpoint
(§6.4 → now SRV-01), key-material fire-and-forget (§6.5/B-123 → now GF-2/SYNC-2), unbounded
`fetchWithRefresh` in `src/services/api.ts`, TURN 6s STUN-only-for-life, B-128 login copy,
`WS_SESSION_RECOVERY` unset (→ OR-5/SRV-07).

---

## II.3 Findings by dimension

Severity = post-verification final. Verdict = adversarial verifier (Opus) + impact verifier for
P1s. ⚠ = verifier errored at audit time — **all four ⚠ findings were subsequently confirmed**
(Part I §1).

### II.3.1 · 1:1 ordering + latency (complaint 1) — 7 findings

**[OM-01 · P1 · CONFIRMED]** 1:1 and reaction outbox rows lack SN-06 cert metadata — a row queued

> ~1h ships with an expired cert over HTTP (no submitter mapping) → recipient destroys it, sender
> keeps a permanent 'sent' tick. _Prior: SN-06/B-122 residual × MSG-03._
> `productionRuntime.ts:2867-2874` (1:1 enqueue: `{outerSealed, expiresAtSec}` only), `:3332-3339`
> (reaction: `{outerSealed}` only) vs `:2619-2626` (group, complete); `outboxCertFreshness.ts:37`
> (undefined ⇒ fresh). **Fix:** mirror the group fix — persist `certExpSec` + reseal inputs at both
> enqueue sites + 1:1 reseal callback. Receiver-side `verifySenderCert` untouched (stop-condition).

> **⚠ SUPERSEDED REMEDY — see Part I §3 (row 2); implement RT-3, and note OM-01 is a DUPLICATE of
> XO-1 (one change, not two). The "no submitter mapping" half is FORBIDDEN — see NA-GATE-1 (§4.1).**

**[OM-02 · P1 · CONFIRMED]** Transcript order keyed on the **sender's wall clock** (`aad.ts`,
accepted up to 24h future / 30d past) — a peer with a 3-min-fast clock pins their messages below
the fold and every reply splices _above_ the question. Own messages use the local clock
(`productionRuntime.ts:2385`), inbound uses sender `aad.ts` verbatim (`:7293`, `:7232`,
`:6204-6207`), splice strictly by `created_at` (`messengerStore.ts:553-565`); no clamp against
the server envelope timestamp that already rides the wire (`messenger.gateway.ts:738`). _Prior:
new._ **Fix:** clamp the ORDERING timestamp to serverTs when |aad.ts − serverTs| exceeds a small
skew — display-only; `verifySealedAad` and its windows untouched (stop-condition). Signal/WhatsApp
order on server receive time.

> **⚠ SUPERSEDED REMEDY — see Part I §3 (row 1); implement a FUTURE-ONLY clamp in RT-6. The
> symmetric clamp proposed here would revert MSG-01 and L18.**

**[OM-03 · P2 · CONFIRMED]** Every HTTP-submitted 1:1 envelope (ack-watchdog fallback + all outbox
drains) produces **no `envelope.delivered`** — bubbles stick at single-tick until read; and
`envelope.undeliverable` is unroutable. `envelope.controller.ts:74-83` (submitter deliberately
omitted), `envelope.service.ts:376-392`. Precisely the messages sent under degraded conditions
lose their delivery signal — a large share of complaint 1's _perceived_ latency. _Prior: MSG-03._
**Fix:** pass `{userId, deviceId}` submitter on the HTTP POST (same transient TTL-bounded mapping
the WS lane already uses; architecture check first — no verifier weakened).

> **⚠ SUPERSEDED REMEDY — the proposed fix is ⛔ FORBIDDEN (Part I §0.2). Implement NA-GATE-1
> design (A): retract-token-gated `POST /envelopes/receipts` poll (§4.1, items G1-SRV + G1-RT).**

**[OM-04 · P2 · CONFIRMED]** Killed-app FCM message wake banners but never pulls
(`fcmHeadless.ts:150-155` banner-only by design; warm-path pull can't boot the runtime headless,
`fcmBootstrap.ts:1608-1611`) — delivery, ack and the sender's tick wait for a manual app open.
_Prior: known residual (2026-07-03 handoff), still true._ **Fix:** bounded headless catch-up
(fetch+persist sealed, no decrypt) or short FGS boot; keep the no-decrypt-in-headless-VM rule.

> **⚠ SUPERSEDED REMEDY — the headline outcome (delivery + ack + sender tick with no app open) is
> NOT achievable; see Part I §3 (row 3). Implement NA-GATE-4's bounded decrypt-free stage only
> (§4.4, item G4). A "short FGS boot" / headless runtime boot is out.**

**[OM-05 · P3 · CONFIRMED]** Drain-time reseal re-mints `aad.ts = Date.now()`
(`productionRuntime.ts:797`) — receivers order deferred/re-sealed messages at drain time, sender
keeps compose time; both ends permanently disagree on transcript order. **Fix:** carry original
`sentAtMs` in the outbox payload / reuse as aad.ts after arch check.

> **⚠ SUPERSEDED REMEDY — a new `SealedPayload` field is ⛔ FORBIDDEN (fleet-breaking; Part I §0.2).
> Implement NA-GATE-3's narrowing reinterpretation of `SealedAad.ts` (§4.3), folded into RT-3.
> Scope correction: there are FOUR re-seal sites, not just "deferred messages".**

**[OM-06 · P3 · CONFIRMED]** `appendMessage` unconditionally overwrites `conversation.last_message`
(`messengerStore.ts:686`, no recency guard unlike the B-18 merge path `:472`) — a late-spliced
older message regresses the chat-list preview and jumps the thread to the top. **Fix:** recency
guard + skip reorder for stale inserts.

> **⚠ SYMPTOM CORRECTED — Home re-sorts by `last_message.created_at`, so a stale insert makes the
> thread SINK, not jump to the top (Part I §3 row 5). Fix shipped in `c9728f9` (MS-1).**

**[OM-07 · P3 · CONFIRMED]** SN-04 'unreachable' reschedule never grows its backoff
(`sqlOutboxStore.ts:235-244` indexes `BACKOFF_MS[attempts]` but never increments attempts → frozen
at 1s) — dead-zone rows retried every 60s sweep, each can burn the full 20s timeout serially;
young rows wait behind stuck old ones. **Fix:** separate unreachable-streak counter capped at 5min

- bound per-sweep wall time.

> **⚠ SUPERSEDED REMEDY — incomplete without `clearUnreachableBackoff()` on reconnect (Part I §3
> row 6). OM-07 is SUBSUMED BY XO-3 and must not be implemented independently: ONE column
> (`soft_attempts`), not OM-07's `unreachable_attempts` as well. Store half in `c9728f9`; call
> sites in RT-2.**

### II.3.2 · Exactly-once + zero-loss + persistent queue — 5 findings

**[XO-1 · P1 · CONFIRMED×2]** The 1:1/reaction stale-cert silent-loss path end-to-end (the
send-side of OM-01, double-verified): offline >1h → drain ships dead cert → recipient
`verifySenderCert` destroys pre-decrypt → acks 'discarded' → HTTP submit has no submitter mapping
→ **no undeliverable signal → permanent 'sent' tick, message gone.** This is the only fully-silent
1:1 loss class in the tree. **Fix:** as OM-01 + MSG-03 (converts residual loss into a red
'undelivered' icon).

> **⚠ SUPERSEDED REMEDY (second half) — the "+ MSG-03 HTTP submitter mapping" is ⛔ FORBIDDEN.
> RT-3 (cert metadata + reseal, §5.2) is the ONLY compliant remedy for the stale-cert loss class;
> the red-icon honesty half arrives separately with NA-GATE-1 (§4.1).**

**[XO-2 · P2 · CONFIRMED]** Messages composed while the sender-cert cache is cold/stale fail-fast
to 'failed' with **no outbox row** — the persistent queue never engages for offline-composed sends
after an offline app launch (`certCache.ts:26` memory-only; cert fetch inside the try that flips
'failed' _before_ enqueue: `productionRuntime.ts:2796-2840` 1:1, `:2461-2491` group). Violates
"persistent outgoing queue" directly. **Fix:** on cert-prep failure enqueue an A4-style deferred
row (plaintext intent) and keep 'sending'; drain re-mints when connectivity returns.

**[XO-3 · P2 · CONFIRMED]** Server rejections — transient 5xx during a deploy, the relay's own
429 throttle (hit by the drain itself), local `no_token` — **burn the 10-attempt budget**; rows
flip 'failed' and auto-retry stops permanently (`sqlOutboxStore.ts:71-75` exempts only
network-unreachable). A ~35min relay outage kills every queued message into tap-per-bubble
recovery. **Fix:** classify by status — 5xx/429/no_token reschedule without burning (honor
Retry-After); budget reserved for semantic 4xx; pace the drain under the throttle.

> **⚠ PARTIALLY SHIPPED — the store layer landed in `c9728f9` (STORE-1) but NO call site adopts it.
> RT-2 must wire it (Part I §6).**

**[XO-4 · P3 · CONFIRMED]** Late-draining outbox row rewinds a 'delivered'/'read' bubble back to
'sent' (`productionRuntime.ts:7485-7487` unconditional; `messengerStore.ts:730-741` no monotonic
rank). **Fix:** monotonic status rank in `updateMessageStatus`.

**[XO-5 · P3 · CONFIRMED]** Post-SN-04 state split: bubble shows 'failed' while its row is still
'pending' and will auto-send later (`productionRuntime.ts:2919` vs `:2926-2930`) — invites re-type
duplicates the dedup can't coalesce (different clientMsgId). **Fix:** keep bubble in
'sending'/'queued' for unreachable errors; 'failed' only on budget exhaustion/semantic rejection.

> **⚠ PARTIALLY SHIPPED — store half in `c9728f9`; the bubble still flips to `'failed'` in
> `productionRuntime.ts`, and the boot-sweep half is inert until RT-2 switches the MSG-07 sweep to
> `pendingMessageIds()` (Part I §6a).**

### II.3.3 · Group fan-out timing + completeness (complaint 2) — 6 findings

**[GF-1 · P1 · CONFIRMED×2]** Per-user **30-per-10s POST /envelopes throttle** collides with
per-member parallel HTTP fan-out (`envelope.controller.ts:67`; `productionRuntime.ts:2632-2644`,
`:2686`). A 10-member group absorbs ~3 messages/10s from one sender; bursts 429 the tail; a

> 30-member group can **never** deliver one message fully live. 429 is a budget-burning rejection
> (XO-3) and the real retry cadence is the 60s drain tick — _exactly_ "some members receive
> noticeably later". Sustained bursts can exhaust a member's budget → that member **never** gets the
> message. **Fix:** server batch endpoint (`POST /envelopes/batch`, already spec'd in slow-network
> §6.4) or fan-out-aware throttle shaping; client treats 429 as non-budget + Retry-After + prompt
> re-drain.

> **⚠ SUPERSEDED REMEDY — `POST /envelopes/batch` AND fan-out-aware throttle shaping are BOTH
> ⛔ FORBIDDEN (Part I §0.2). A BLIND FLAT RAISE is the entire compliant server surface; it shipped
> in `c9728f9` as RELAY-1 (300/60 s). The client 429/Retry-After half is correct but is still
> unwired — RT-2.**

**[GF-2 · P1 · CONFIRMED×2]** **All group key-material fan-out (create/add/remove/rekey/reshare/
key-request) is fire-and-forget WS** — no ack, no outbox, no retry; `transport.send` only throws
when `socket.connected === false` (`client.ts:319-326`), so a zombie socket swallows the frame
while `delivered += 1` counts it (`productionRuntime.ts:3627-3637`, `:3869-3876`, `:4134-4141`,
`:4028-4032`, `:2178-2179`, `:2099-2100`, `:4361-4362`). Only a 0-total-delivered rekey retries
once. A missed rekey silently forks a member off the group key. _Prior: B-123, confirmed still
open._ **Fix:** route key-material through the durable path text uses (HTTP relay 200 / WS with
accepted-watchdog + per-recipient outbox rows). This is key _distribution transport_ reliability,
not key derivation — but touches master-key distribution: **verify against the architecture doc
before implementing** (stop-condition adjacent). Do not weaken the B-42 epoch guard or fail-closed
rotate.

> **⚠ ARCHITECTURE-GATED — the gate was APPROVED 2026-07-20 in the GF-2 shape (new
> `deliverGroupAdminEnvelope` in `productionRuntime.ts` only). See §4.2 and item G2. GF-2 ≡ SYNC-2 —
> ONE PR.**

**[GF-3 · P1 · CONFIRMED×2]** Stale-key self-heal is **dead code**: `requestGroupKeyResyncImpl`
skips any group that still holds _any_ (old) master key (`productionRuntime.ts:2130
if (store.groups[gid]?.masterKeyB64) continue`) — which is precisely the key-divergence case that
triggered it (`:6660-6685` returns `{kind:'request-group-key'}`); and the boot stash drain deletes
stashed messages after 3 launches (`pendingGroupEnvelopeStore` max-attempts). Composed with GF-2:
after one lost rekey, the member's thread goes silent forever and their stash is **permanently
deleted** — messages other members saw as delivered. **Fix:** pass a 'divergence' flag from the
`:6685` site through to the resync impl (rate-limited by the existing 20s cooldown); stop burning
stash attempts while no NEW key has arrived. Owner reshare path already signature-verified.

**[GF-4 · P2 · CONFIRMED]** Non-adder members' Home sync shrinks `participants` back to the stale
server roster (`resolveRosterOverwrite` guard is adder-local AsyncStorage only,
`MessengerHomeScreen.tsx:180-186`, `pendingRosterIntents.ts:52-53`) — a just-added member is
excluded from other members' fan-out until the adder's roster write lands. **Fix:** union server
roster with `Object.keys(groups[gid].members)` (crypto membership is source of truth).

> **⚠ SUPERSEDED REMEDY — the literal union is WRONG: it resurrects a removed member on non-adder
> devices (the P1-5 privacy defect) and revives a deliberately reverted union (Part I §3 row 8).
> Shipped in `c9728f9` as "prefer local crypto membership, server roster as fallback".**

**[GF-5 · P2 · CONFIRMED]** A keyless ('syncing') member can SEND into the group: the message goes
only to the single placeholder participant AND ships the inner envelope without group-key wrap
(`groupConversationUpsert.ts:74-84` participants=[stashSender]; no composer gate
`ChatScreen.tsx:1559`; masterKey-undefined fallback `productionRuntime.ts:2478-2480`). **Fix:**
gate/queue the composer while `masterKeyB64` absent; drop the plaintext-inner fallback for
group-typed conversations (fail closed); keep the ops/mission legacy _receive_ path.

**[GF-6 · P3 · CONFIRMED]** `drainOutbox` is fully serial across all rows/conversations, up to 20s
each (`productionRuntime.ts:7406-7481`) — one flaky recipient head-of-line-blocks every queued
message. **Fix:** bounded concurrency (3-4) grouped per recipient to preserve per-peer order.

### II.3.4 · Notification call accept (complaint 3) — 6 findings

**[NA-01 · P1 (was P0) · CONFIRMED×2]** **FCM bg-wake handler overwrites the SDP-bearing
`incomingCallCache` entry** — when the app is backgrounded with a healthy WS (the common case),
the WS `call.offer` seeds the cache WITH SDP (`MainNavigator.tsx:539-547`), then the FCM wake
1-3s later replaces it WITHOUT SDP (`fcmBootstrap.ts:1493-1501`; `incomingCallCache.ts:85` is a
full replace, not a merge). Answer tap → B-102 A1 hydration finds no SDP → deterministic
"Answering…" stall; caller rings out to missed. Downgraded from P0 only because the full-screen
ring surface (app foregrounded) doesn't traverse the clobbered path. _Prior: extends B-102 A1._
**Fix:** make `setIncomingCallPayload` merge-preserve (never let an SDP-less payload erase
`incomingSdp`/`remoteDeviceId`/`conversationId`) + regression test seeding SDP → bg-wake set →
assert SDP survives.

**[NA-02 · P1 · CONFIRMED×2]** Dead-offer answer path has **no terminal state**: when the offer
SDP never arrives (cold boot ate the 45s replay window; caller cancelled while callee WS down),
`useCall` bails pre-controller (`useCall.ts:433-435`), the 45s accept-expiry only `console.warn`s
(`CallScreen.tsx:802-805`), and the screen sits on "Answering…" forever — no watchdog, no
'call ended', no missed-call feedback. _Prior: B-102c (never device-verified) + B-110 residual._
**Fix:** drive a terminal 'failed' + "Couldn't connect — missed call" + auto-pop from accept-intent
expiry and from FCM call-cancel on a mounted screen.

**[NA-03 · P2 · CONFIRMED]** Cold-start Answer routing is serialized behind **unbounded
push-register network I/O** — `startFcmBootstrap` awaits `getToken()` + two bare-fetch registers
(`fcmBootstrap.ts:218`, `:226-229`, `:1338` no timeout) _before_ `installNotifeeHandlers()`
(`:266`) which owns `getInitialNotification` routing. On a dribbling connection the killed-app
Answer tap burns 20-40s before CallScreen even mounts → NA-02 dead-end. **Fix:** install handlers
first; wrap registers in `fetchWithTimeout` (SN-01 pattern).

> **⚠ RIDER ADDED — the hoist makes the rich `onBackgroundEvent` displace the slim one earlier, and
> `notifee.onBackgroundEvent` is last-wins, so the durable pending-decline had to be enqueued in the
> rich handler too. Shipped in `c9728f9` (CALL-A).**

**[NA-04 · P2 · CONFIRMED]** Telecom/system-UI Answer with cached payload **never brings the app
to the foreground** (`bringAppToForeground()` only in the no-payload branch,
`fcmBootstrap.ts:379-399`) — CallScreen mounts backgrounded and the FGS start leans entirely on
the phoneCall-type exemption; where that rung is denied, callee is silent (mic blocked). This is
the mechanism in the 2026-07-10 device logs (“Foreground service started from background can not
have location/camera/microphone access”, `bravo_call_log_20260710_112445.txt:144-150`). _Prior:
B-66/B-70 family._ **Fix:** unconditional `bringAppToForeground()` at the top of onAnswer +
device-matrix row asserting `startForeground` lands type 4|128.

> **⚠ SUPERSEDED REMEDY — insufficient as written: CallKeep's warm branch sends a bare launcher
> intent that CLEARS `showWhenLocked`, so the lock-screen case stays behind the keyguard (Part I §3
> row 15). Shipped in `c9728f9` as a NATIVE `bringCallUiToForeground()` carrying
> `EXTRA_CALL_LAUNCH`. Requires an APK rebuild; still device-unverified.**

**[NA-05 · P2 · CONFIRMED]** `call.answer` dropped after 12s of WS-down with **no re-send on
reconnect** (`signallingClient.ts:42,276-290`; SN-05's ideal fix deliberately not implemented) —
callee accepted, frame never sent, callee fails at the 20s watchdog while caller keeps ringing.
**Fix:** buffer the pending answer/offer, re-send once on the next 'connected' while the
controller is non-terminal.

> **⚠ SUPERSEDED REMEDY — the buffer + re-send is ALREADY IMPLEMENTED (Part I §3 row 16). The real
> defects were the 12 s budget and the watchdog arm point; shipped in `c9728f9` (CALL-C).**

**[NA-06 · P3 · CONFIRMED]** Warm-background ring plays **two ringtones simultaneously**
(CallScreen `bravoTones` effect has no AppState gate `CallScreen.tsx:865-875` + notifee native
ringtone `callNotification.ts:448-453`). **Fix:** gate the in-app ringtone on
`AppState === 'active'` or skip the native one when the in-app surface owns the callId.

> **⚠ SUPERSEDED REMEDY — the `AppState === 'active'` gate silences the legitimate
> foreground-ring-then-Home case. Shipped in `c9728f9` as native-ring ownership
> (`isNativeRingActive` + `bindInAppRingOwnership`).**

### II.3.5 · Group-call self-view + grid (complaint 4) — 5 findings

**[GCV-1 · P1 · CONFIRMED×2]** **Camera re-acquisition drops the 640×480 constraint** — boot
capture pins `{width:{ideal:640},height:{ideal:480}}` (`peerConnectionFactory.ts:81-83`) but all
four re-acquisition sites pass `{video:{facingMode}}` only (group toggleVideo/voice→video upgrade
`useGroupCall.ts:3694`; `switchCameraForCall` `peerConnectionFactory.ts:115`; `recoverCameraTrack`
`:169`; `recoverGroupCamera` `:211`), and the @livekit fork normalizes missing dims to
**1280×720** (`RTCUtil.js:75-`). Self-source aspect flips 0.75→0.5625 mid-call; objectFit 'cover'
crop jumps from ~0-5% to ~21-25% (self tile) and up to ~39% as another member's hero — **the
"zoomed" self tile**, and it differs by how video was started. Matches the device-log 640×480 ↔
1280×720 flip-flop (evidence §II.4). **Fix:** shared `LOCAL_VIDEO_CONSTRAINTS` passed at all four
sites; verify on device that capture stays 640×480 across voice→video upgrade.

> **Shipped in `c9728f9` (VID-1) — at all FIVE `getUserMedia` sites (boot included, so the literal
> cannot drift). Device verification still owed.**

**[GCV-2 · P2 · CONFIRMED]** `FlexibleVideoTile`'s adaptive-aspect design is **inert** in every
measured slot (wrapper pinned to slot rect per the BS-GC-BLACKVIDEO fix, inner containers 100%) —
all tiles are fixed-rect + cover, so hero slots structurally crop 18-39% of a portrait source;
emulator landscape sources crop ~44% ("dramatic zoom on some devices, fine on others"). **Fix:**
pick a policy: (a) keep cover + pin capture portrait-matching everywhere (GCV-1) and delete the
dead adaptive machinery, or (b) self tile only → `objectFit:'contain'`. Must NOT unpin the wrapper
height (re-opens the black-tile class).

> **⚠ STRONGER THAN AUDITED — `aspectRatio` is inert in EVERY slot, not just measured ones. Do NOT
> letterbox the hero (Part I §3 row 10). Shipped in `c9728f9` (VID-2): dead machinery deleted,
> `objectFit` prop added, self tile `contain`, wrapper height still pinned.**

**[GCV-3 · P2 · ⚠ UNVERIFIED]** Fork's `onFrameResolutionChanged` dispatches **unrotated** capture
dims to JS (`WebRTCView.java:270-286` vs the rotation-aware native layout `:331-332`) — portrait
640×480@rot90 reaches JS as landscape 1.333, so wherever aspectRatio still governs (pre-measure
window, fallback rects) the tile renders 90°-wrong and crops ~44%. Also an emulator-vs-device
divergence source. **Fix:** extend `patches/react-native-webrtc+125.0.12.patch` to emit
rotation-adjusted dims. _(Verifier errored — re-verify against the patch before implementing.)_

> **⚠ REASONING WRONG + RECOMMENDED CLOSE-WONTFIX. Pixels are NEVER rendered 90° wrong — the
> renderer rotates them; only the aspect NUMBER transposes, and after VID-2 deleted
> `onDimensionsChange` it has no consumer and the native emitter stays off. It fixes none of the
> zoom complaints, and it is unverifiable without a device inversion check. See Part I §2.**

**[GCV-4 · P3 · CONFIRMED]** Self tile stays **mirrored after flipping to the rear camera**
(`mirror={isSelf}` unconditional, `GroupCallScreen.tsx:1620`; CallScreen does it right at
`CallScreen.tsx:2268`). **Fix:** `mirror={isSelf && call.isFrontCamera}` — one line.

**[GCV-5 · P3 · CONFIRMED]** `PAGE_W`/`SCREEN_W` frozen at module load (`GroupCallScreen.tsx:121`,
`:123`, StyleSheet `:2704`) — rotation/foldable/split-screen mid-call keeps stale geometry.
**Fix:** `useWindowDimensions()` + per-render PAGE_W + inline grid width.

### II.3.6 · Synchronization surfaces (complaint 5) — 7 findings

Per-surface verdicts: delivery ticks 1:1 **SYNCED**(WS)/**PARTIAL**(HTTP lanes); group ticks
**BROKEN** (SYNC-1+SYNC-3); read receipts 1:1 **SYNCED**, group **BROKEN**; typing **SYNCED**
(B-117 confirmed; scoping wrinkle SYNC-6 ⚠); reactions **SYNCED** golden-path (loss modes SYNC-7
⚠); **edits MISSING** (no protocol at all); deletes **PARTIAL** (local-only, SYNC-4; disappearing
SYNCED); media **SYNCED**; call history **PARTIAL** (per-device, SYNC-5 ⚠); missed calls SYNCED
within 6h marker TTL; group state **PARTIAL** (GF-2); presence **SYNCED**. **Zero new iOS gates
found in any sync-surface code** — cross-platform divergence is the known iOS notification gates

- build skew, not sync logic.

**[SYNC-1 · P1 · CONFIRMED×2]** **Group read ticks can never complete**: fan-out mints a distinct
envelopeId per recipient but the author's row stores only the FIRST recipient's id
(`productionRuntime.ts:2706-2718`), and the receipt handler hard-gates on
`ids.has(msg.envelope_id)` (`:5182`) — every other member's receipt is silently dropped, while
B-116 requires receipts from EVERY participant (`messengerStore.ts:766-777`). 1 acceptable receipt
< N-1 required ⇒ 'read' unreachable in any 3+ group; combined with SYNC-3, group bubbles sit at
single-tick 'sent' forever. _Prior: B-116 shipped structurally incomplete._ **Fix:** persist the
full per-recipient envelopeId set (fan-out `results[]` already carries them) or match receipts by
`clientMsgId` (identical across the fan-out, already known to recipients).

> **⚠ SUPERSEDED REMEDY (second option) — matching by `clientMsgId` would add a reader↔message
> correlator to the WS frame and break relay group-blindness (Part I §3 row 11). Implement the FIRST
> option (per-recipient envelopeId set) in RT-7 — and mind its 🔴 hard backup gate (§5.2).**

**[SYNC-2 · P1 · CONFIRMED×2]** Server-side twin of GF-2 (key/state fan-out fire-and-forget; the
sender rotates the epoch even when the rekey reached nobody `productionRuntime.ts:3943-3960` —
deliberate fail-closed, but with no durable redelivery it strands members). **Fix:** as GF-2 —
durable redelivery makes the fail-closed rotate safe. Same architecture-check requirement.

> **⚠ WRONG FILE HINT — there is no "server-side twin"; nothing in `apps/messenger-service` changes,
> the entire fix is client-side (Part I §3 row 12). SYNC-2 ≡ GF-2 — ONE PR (item G2, §4.2).**

**[SYNC-3 · P2 · CONFIRMED]** Delivered/undeliverable receipts never fire for ANY HTTP-submitted
envelope — all group sends, all outbox drains, and every SN-03 fallback winner
(`messenger.gateway.ts:1088-1094` WS-only submitter; `envelope.controller.ts:74-83`;
`envelope.service.ts:376-390`). The decryptFailureSignal red-icon honesty path is also dead for
these lanes. _Prior: MSG-03._ **Fix:** carry the caller's own JWT identity as submitter on HTTP
submit (parity with WS; architecture check — relay envelope semantics).

> **⚠ SUPERSEDED REMEDY — ⛔ FORBIDDEN (Part I §0.2). SYNC-3 ≡ OM-03 ≡ SRV-08; implement NA-GATE-1
> design (A) once (§4.1). SYNC-3's own alternative (an anonymous socket.io receipt room + a new
> `receipt.subscribe` frame) was design (B) and was NOT chosen.**

**[SYNC-4 · P2 · CONFIRMED]** **No delete-for-everyone and no edit protocol** — delete is
local-only (`ChatScreen.tsx:775-783`, self-labeled "Delete (this device)"), retract only works
pre-fetch (`relayClient.ts:135-142`), zero edit surface in src/. Devices permanently diverge the
moment anyone deletes a delivered message. **Fix:** delete-directive envelope mirroring the
reaction pattern (durable outbox, idempotent by shared clientMsgId, tombstone apply); edits ride
the same machinery. Pure additive protocol.

> **⚠ ARCHITECTURE-GATED — approved 2026-07-20 as an additive INNER `redact?: {targetMsgId}` field,
> shipped as a FULL single release, with an owner-scoped `redactRegistry` authorship binding and
> ops-console redeployed FIRST (§4.5, item G5). "Pure additive protocol" understates the risk: the
> `SEALED_PAYLOAD_KEYS` allow-list makes an un-upgraded receiver DESTROY the envelope. Edits are
> deferred.**

**[SYNC-5 · P3 · ⚠ UNVERIFIED]** Missed-call record lost if callee offline >6h
(`MISSED_CALL_MARKER_TTL_SEC`, `messenger.gateway.ts:2648`); call history is per-device local with
no reconciliation (`CallsLogScreen.tsx:88-117`). **Fix:** raise marker TTL toward the 30-day dwell
(slim JSON) or mint missed-call as a real E2EE relay envelope. Keep TTL ≤ 30d (dwell
stop-condition).

> **⚠ SECOND CLAUSE WRONG + SECOND OPTION BLOCKED — call bubbles DO ride the E2EE backup mirror, so
> restore-time reconciliation already exists (only live multi-device sync is missing, a product
> feature, out of scope). Minting missed calls as E2EE envelopes is a 30-day relay POISON PILL
> (Part I §3 row 13). Approved remedy: 7-day env-tunable TTL clamped to `min(RELAY_DWELL_SECONDS,
30d)` (§4.6, item G6), after GW-2.**

**[SYNC-6 · P3 · ⚠ UNVERIFIED]** Typing frames carry no conversation id
(`messenger.gateway.ts:2182-2185`), client fans the flag to the 1:1 slot AND every shared group
(`productionRuntime.ts:5203-5232`) — one peer typing paints "typing…" in every mutual
conversation. **Fix:** optional `conversationId` on the typing frame (plaintext presence-class
signal), scoped client apply, legacy fallback.

> **⚠ SUPERSEDED REMEDY — a raw `conversationId` on the frame is ⛔ FORBIDDEN (group clustering
> signal; Part I §0.2). Approved: an opaque 16-hex `convTag` that DIFFERS PER RECIPIENT (§4.7,
> items G7-GW + G7-RT), deployed server-first.**

**[SYNC-7 · P3 · ⚠ UNVERIFIED]** Reaction loss modes: (a) reaction-before-target silently dropped
forever (`productionRuntime.ts:7323-7350`, no pending-reaction stash); (b) reaction rows lack
SN-06 reseal inputs (`:3338`) → >1h-offline reactions ship dead certs and are destroyed. **Fix:**
tiny pending-reactions stash keyed by targetMsgId + OM-01's reaction-row reseal metadata.

> **⚠ SCOPE CORRECTED — part (a) is WORSE than described: `applyReaction` never calls
> `sqlMessages.upsert` at all, so reactions vanish on every cold boot even when the target IS
> present. Part (b) is literally OM-01's finding and belongs to RT-3, NOT here — SYNC-7 must not
> touch `sendReaction`'s enqueue hunk. Implement in RT-6.**

### II.3.7 · Offline recovery + reconnection lifecycle — 6 findings

**[OR-1 · P2 (was P1) · CONFIRMED×2]** **No background/killed/reboot send pipeline**: the outbox
drains only from boot, WS 'connected', and a 60s _foreground_ interval
(`productionRuntime.ts:1601`, `:1134`, `:1612`); no WorkManager/scheduled job, no headless drain,
no BOOT_COMPLETED receiver (`AndroidManifest.xml` has zero receivers), the killed-app FCM handler
never touches the outbox. Dead-zone send → pocket phone → process dies → message waits **hours**
for a manual open. Signal ships exactly this via WorkManager. **Fix:** network-constrained
one-shot job + BOOT_COMPLETED receiver scheduling the same job; guard SQLCipher with a
cross-process mutex like the mirror ledger.

> **⚠ SUPERSEDED REMEDY — WorkManager + `BOOT_COMPLETED` 2nd-process SQLCipher drain is ⛔ FORBIDDEN
> (Part I §0.2): arch-memo NOT-COVERED, previously tried and removed, and relaxing keychain
> accessibility to enable it is forbidden outright. The boot receiver is also redundant
> (androidx.work 2.8.0 merges it). Compliant scope: foreground/AppState/NetInfo/WS-connected kicks
> (RT-2) + the background-AppState drain and `onServerSignal` clock (RT-8).**

**[OR-2 · P1 · CONFIRMED×2]** **Every messaging send-recovery timer freezes while locked** — the
B-100/B-101 remediation event-drove only CALL paths. WS ack-watchdog (setTimeout 5-20s,
`productionRuntime.ts:2957-2989`), outbox tick (60s setInterval `:1612`), `fetchWithTimeout` abort
(setTimeout, `fetchWithTimeout.ts:32`), and the inline-reconnect gate is `hasLiveCall()` only
(`client.ts:1059-1101`). Send + immediately lock (the most common gesture) onto a half-dead fd ⇒
nothing retries until unlock. **Fix:** event-driven messaging fallback — fire httpFallback for
pending unacked ids on AppState 'background'; piggyback drainOutbox on the Manager 'ping' clock
(same seam as `maybeRenewSocketAuth`); extend the inline-reconnect gate to pending-outbound.

> **⚠ ONE TARGET IS UNFIXABLE — the `fetchWithTimeout` abort CANNOT be fixed in JS (no timer fires
> while the screen is locked); bounding the caller is the only lever. `httpFallback` is an
> unreachable per-send closure, so `drainOutbox` is the right target (Part I §3 row 17). The
> Manager-`'ping'` piggyback is correct and is RT-8's core.**

**[OR-3 · P2 · CONFIRMED]** Killed-app FCM msg-wake never fetches content (deliberate slim
handler; 2nd-VM SQLCipher contention is why) — 30 overnight messages = a few generic banners,
state frozen till open; iOS lane absent entirely (IOSMSG-1/2). **Fix:** Doze-budgeted single-VM-
guarded minimal pull (persist sealed, decrypt on open), or at minimum close the iOS banner lane.

> **⚠ PRIMARY REMEDY REJECTED — the headless minimal pull is ⛔ FORBIDDEN for this batch (2nd-VM
> class + a headless access-token refresh, the B-71 revocation-loop class). PUSH-1 ships the
> audit's own stated FALLBACK: the iOS banner lane. The Android sealed-stage half is separately
> approved but bounded and decrypt-free — see §4.4 (G4).**

**[OR-4 · P2 · CONFIRMED]** Drain coalescers swallow triggers arriving mid-drain — no re-run latch
(`productionRuntime.ts:7400`, `:1246`); a Wi-Fi→LTE handover mid-drain reliably absorbs the
reconnect kick into the doomed run; next attempt = the 60s tick. **Fix:** 6-line `rerunRequested`
latch on both coalescers; optionally abort in-flight drain fetches on 'connected'.

> **Shipped in `c9728f9` (RT-1, `createRerunCoalescer`). RT-8 must UPGRADE the in-flight guard to
> wall-clock ownership — do not add a second guard.**

**[OR-5 · P3 · CONFIRMED]** `connectionStateRecovery` inert server-side (`WS_SESSION_RECOVERY`
unset; stock adapter no-ops restore) while the client faithfully re-presents pid/offset — every
blip drops volatile frames (typing/presence/in-flight receipt fan-out). _Prior: LC-7._ **Fix:**
staging verification + enable the flag (single-replica staging is the documented sweet spot).

> **⚠ "ENV/OPS CHANGE ONLY" IS WRONG — flipping the flag activates ~225 lines of never-unit-tested
> code that overrides `broadcast()` for every WS event, and it is unsafe without a jti-revocation
> check in `doRestoreSession` (socket.io flushes missed packets in the Socket constructor BEFORE the
> auth middleware runs). `c9728f9` (WS-1) shipped the config routing + the fail-closed jti gate; the
> flag stays `false` and the staging flip is a separate ops action (§8).**

**[OR-6 · P3 · CONFIRMED]** Foreground resume with a healthy socket never kicks the outbox —
'drain'/'probe' resume branches call only the receive-side `coalescedDrain`
(`productionRuntime.ts:1445-1470`); due rows wait up to 60s while the user stares at 'sending'.
**Fix:** add `drainOutbox()` alongside (self-guarded, cheap no-op when idle).

> **Shipped in `c9728f9` (RT-1). RT-2 replaces it with the throttled `kickAndDrainOutbox`. OR-6 is
> SUBSUMED by OR-1 — do not implement it a second time.**

### II.3.8 · Server relay + WS gateway integrity — 8 findings

**[SRV-01 · P1 · CONFIRMED×2]** Server-side statement of GF-1: the 30/10s per-user throttle
(`envelope.controller.ts:67`, keyed on `claims.sub`) chokes the group fan-out the server itself
forces onto HTTP; 429s burn client budgets, stagger delivery by minutes, or flip members to
'failed' silently. **Fix:** batch endpoint (§6.4) or fan-out-aware shaping; the client stopgap in
GF-1/XO-3.

> **⚠ SUPERSEDED REMEDY — both options ⛔ FORBIDDEN (Part I §0.2). Blind flat raise shipped in
> `c9728f9` (RELAY-1): `SEND_THROTTLE = {limit: 300, ttl: 60_000}` via `RELAY_SEND_THROTTLE_LIMIT` /
> `RELAY_SEND_THROTTLE_TTL_MS`, so one `MAX_GROUP_FANOUT = 250` burst fits a window at a 5/s
> sustained rate. SRV-01's window shape won over GF-1's 120/10 s.**

**[SRV-02 · P2 (was P1) · CONFIRMED×2]** `call.answer` is fire-and-forget against an **in-memory
`callSessions` map** (`messenger.gateway.ts:252`): pending offers ARE Redis-persisted and replayed
across restarts (`:556-618`) **without re-registering a session**, so a replayed offer can never
be answered — `authorizeCallFrame` `{ignore:true}` for unknown callIds (`:2414-2419`), answer
silently dropped (`:1314-1319`). Staging auto-deploys messenger-service on every push to main ⇒
every in-flight ring at deploy time becomes an unanswerable ghost ring; also bites any cross-pod
split and caller-socket blips (no answer queue symmetrical to the offer queue). Matches sqa.md
F-5 "post-crash ring-path degradation" and the HTML report's stuck-ANSWERING findings. **Fix:**
persist minimal ringing-session state in Redis (45s+grace TTL), re-register on offer replay,
queue call.answer briefly when the caller's room probe fails. Pure signalling state — S7 auth
untouched.

> **⚠ SUPERSEDED REMEDY — persisting NEW ringing-state in Redis is the ARCH-GATED version and is
> unnecessary. The persisted offer already carries caller + callee + callId, so
> `rehydrateCallSession(...)` needs NO new Redis state and therefore needs NO approval (Part I §3
> row 17). Implement that — item GW-2, wave 2.**

**[SRV-03 · P2 · CONFIRMED]** Connect-time replay of pending call offers/group rings is a
**destructive drain** — index DEL'd up-front, payload+marker GET+DEL'd _before_ `client.emit`
(`messenger.gateway.ts:571,578-598`; group `:640-659`; same take-then-emit remains in
flushPendingDelivered/Undeliverable `envelope.service.ts:406-423`) — a socket dying mid-connect
permanently eats the queued ring AND the missed-call record. The read-receipt queue in the same
function was already converted to peek/emit/remove for exactly this reason. **Fix:** apply that
proven pattern + short-TTL claim key; client already dedups by callId.

**[SRV-04 · P2 · CONFIRMED]** `handleSfuRing` never passes `conversationId` into the group VoIP
wake — the parameter, payload plumbing and tests all exist (`push.service.ts:966-977,1110-1116`;
spec passes 'grp:c-9'), but the only production call site passes 5 args
(`messenger.gateway.ts:1925-1928`) — killed-app group-call Answer navigates with
`conversationId=''` on both platforms. **Fix:** one line — pass `data.conversationId` as arg 6.

**[SRV-05 · P3 · CONFIRMED]** Ack throughput capped ~6/s (HTTP 60/10s `envelope.controller.ts:156`,
WS 60-burst/6-per-s) vs bootstrap flush up to 20×1000 envelopes per connect
(`messenger.gateway.ts:716-717`) — deep backlogs redeliver and re-process across sessions.
**Fix:** batch-ack endpoint preserving the per-envelope P0-N9 possession proof, or pace the flush.

> **Split three ways: part A (throttle raise) shipped in `c9728f9` (RELAY-1: ack throttle 60 → 240
> /10 s, WS bucket `{refillPerSec: 24, capacity: 240}`); part C server = RELAY-2
> (`POST /envelopes/ack-batch`, looping the existing `ack()` so the possession proof is
> byte-identical); parts B + C client = RT-8. A third amplifier the audit missed: archive-replay
> frames POST an ack with no `ackToken`, which can only 403 while burning budget — RT-8 skips it.**

**[SRV-06 · P3 · CONFIRMED]** VoIP wake pair-budget (6/min) is consumed by EVERY call.offer incl.
to fully-online callees (`push.service.ts:980-986` before any other work; N-01 made the wake
unconditional) — the 7th redial in a minute never wakes a Dozed callee, and the deny is
server-log-only. **Fix:** key the budget on (sender, recipient, callId) / refund same-callId
retries <45s. Anti-spam perimeter for distinct callIds stays.

> **⚠ SUPERSEDED REMEDY — a per-callId bucket CANNOT help redials: a redial mints a FRESH callId
> (`useCall.ts:874`) and the gateway rejects duplicate callIds, so per-callId buckets would delete
> the perimeter without fixing anything (Part I §3 row 17). Implement GW-3: charge once per callId
> with bounded free retries, commit the charge only when a push is dispatchable, pair cap 6 → 10.**

**[SRV-07 · P3 · CONFIRMED]** `connectionStateRecovery` block is dead config with the stock Redis
adapter (`redis-io.adapter.ts:71-77,107-110`; documented in
`session-aware-redis-adapter.ts:14-20`). Same env action as OR-5. **Fix:** verify + set
`WS_SESSION_RECOVERY=true`, or comment-gate the dead options.

> **⚠ SUPERSEDED REMEDY — "just set it true" is UNSAFE without the jti gate (see OR-5's banner).
> SRV-07 ≡ OR-5 — ONE diff, shipped in `c9728f9` (WS-1). The flag itself stays `false`.**

**[SRV-08 · P3 · CONFIRMED]** HTTP-submitted envelopes carry no submitter mapping ⇒ group senders
can never receive delivered/undeliverable — group ticks structurally capped at 'sent'
(server-side statement of SYNC-3/OM-03). **Fix:** pass the caller's JWT identity as submitter —
identical exposure to what the JWT already gives the relay at ingest.

> **⚠ SUPERSEDED REMEDY — ⛔ FORBIDDEN (Part I §0.2). "Identical exposure to what the JWT already
> gives the relay at ingest" is the exact reasoning the architecture rejects: ingest-time
> rate-limit use is transient, storage is not. SRV-08 ≡ OM-03 ≡ SYNC-3 — implement NA-GATE-1 design
> (A) once (§4.1). Related: SRV-08's own design used a 2-byte outcome; the APPROVED shape is
> `sha256(retractToken)|outcome`.**

---

## II.4 Device-log evidence (founder artifacts, mined)

All three logcat files are ONE Pixel 7a session, **2026-07-10 11:20–11:34** (copied into the repo
2026-07-17; `bravo_call_log_113328.txt` is a near-subset of `bravo_call_fulltest_113449.txt`).
Release build — JS telemetry stripped, so message-layer evidence is absent by construction.

- **Complaint (c) — STRONG evidence:** background-FGS mic denial at 11:21:26
  (`bravo_call_log_20260710_112445.txt:144-150` — "Foreground service started from background can
  not have … microphone access", twice), followed by two aborted comm-mode sessions (0.95s / 6s);
  with app TOP the FGS starts clean but the HTML report shows UI stuck "ANSWERING…" with audio
  flowing (report Findings A/B) — consistent with NA-04 + SRV-02; process death holding the call
  FGS during hang-up at 11:30:22 (`fulltest:2546`, B-66 class) with the first incoming call in the
  death window dropped; FGS type never includes phoneCall(4) — B-70 family. NOTE: the HTML
  report's 11:27:37 FGS-denial timeline entry is misattributed — that line belongs to
  `com.whatsapp` (`fulltest:197`); the genuine Bravo denial is the 11:21:26 one.
- **Complaint (d) — circumstantial:** front camera negotiated 640×480 (4:3) in most sessions but
  1280×720 in one (`fulltest:818` vs `:1612`) — the per-session aspect flip that GCV-1 now
  explains mechanically.
- **Complaints (a)/(b)/(e) — no evidence in these logs** (no message-transport telemetry; Android
  only). The 42-event `stale_seq` hammer (`112445:4207→7717`, surviving a process restart) is the
  backup-snapshot channel, already fixed on main (409-adopt, `ratchetSnapshotScheduler.ts:292-323`).

---

## II.5 Verified-healthy mechanisms (do not re-fix)

The core is strong; keep these intact when fixing the above:

- **Outbox**: enqueue-before-send at all 3 send sites; composite PK; FIFO drain; SN-04 budget
  discipline; boot/reconnect/60s triggers; MSG-07 boot self-heal; retry chip deletes-then-resends
  (MSG-05).
- **Exactly-once**: server SET-NX dedup with claim-release on put failure; durable
  `seen_envelopes` (35d > 30d dwell) written INSIDE the receive txn; in-flight set closes the
  WS-vs-drain TOCTOU; UI dedup by id and (sender, content). Receive txn = ratchet+plaintext
  atomic on a serialized chain (B-75 fixed); transient SQL failure leaves the envelope on the
  relay (no ack-discard).
- **Relay**: Lua-atomic put (per-recipient 10k cap) before ack; per-device ZSET FIFO; idempotent
  acks with possession-proof tokens; paginated connect flush (20×1000) with same-ms cursor
  overlap absorbed; 7-day durable delivered/read receipt queues, read-receipt drain
  peek/emit/remove; **no push-suppression-if-online anywhere** (the hunted zombie-socket blind
  spot is dead: wakes fire on both WS and HTTP submit paths regardless of socket state).
- **Ordering**: authenticated `aad.ts` stamping + binary-splice + hydration tie-break — late
  arrivals land in the right thread slot (the residual defects are OM-02/05/06, not the splice).
- **Calls**: offer always queued (Redis EX 45) + wake always fired (N-01); 45s alignment across
  notification timeout / offer TTL / ring window / accept-intent expiry; accept dedupe latch
  across notifee/Telecom/in-app; B-110 TURN 6s ceiling + STUN fallback; B-70 FGS type ladder;
  caller-cancel teardown incl. tombstones; B-100/B-101 event-driven `auth.refresh` intact
  (`client.ts:577-637,847-859`) with wall-clock guards (no latchable booleans).
- **Group calls (UI)**: B-17 single-source render list + opacity latch; stable tile identity
  (persistent keyed views); B-19 grid math; B-118 empty-format crash guard present in the M125
  patch; hero-hold defenses.
- **Sync**: 1:1 WS delivered ticks + read receipts (durable, offline-queued, privacy-gated);
  B-117 named typing complete; reactions golden path ack-tracked + durable; disappearing messages
  converge (absolute expiry + relay retract + R2 delete); presence refcounted w/ replay;
  platform-neutral sync code (zero iOS gates outside notification surfacing).
- **Recovery**: reconnect kicks catch-up pull + outbox drain + boot-bundle retry + key resync +
  push re-register + presence resubscribe; NetInfo handover is transition-gated, background-safe
  (inbound-signal clock, not frozen timers), live-call-guarded; unauthorized/token_revoked
  single-flight refresh+reopen with terminal-vs-transient classification.

---

## II.6 Baseline gates (as recorded 2026-07-19, historical)

| Gate                         | Result at audit time                                                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| messenger-service Jest       | 32/32 suites, 310/310 tests green (worker teardown warning pre-existing)                                                               |
| mobile messenger-crypto Jest | 198/200 suites green; 2 failing suites were 60s timeouts under audit-fleet CPU load — pass in isolation in 13s (flake, not regression) |
| mobile typecheck             | 47 errors = 47 baseline — passing but AT the ceiling                                                                                   |
| Device testing               | Not performed                                                                                                                          |

**Current numbers are in Part I §7.**

---

## II.7 ~~Prioritized fix plan~~ — **DELETED**

> 🚫 **The original §7 has been removed on purpose.** As written it instructed the reader to build
> `POST /envelopes/batch` (Phase B item 4) and to pass an HTTP `{userId, deviceId}` submitter
> (Phase B item 6). **Both break Sealed Sender and are architecturally FORBIDDEN** (Part I §0.2).
> A fresh reader following it would ship a compliance violation.
>
> **Use instead:**
>
> - Part I §0.2 — the FORBIDDEN list.
> - Part I §5 — the wave plan (waves 2–8 + the 6 gate items).
> - Part I §4 — the approved architecture-gate designs.
> - `docs/audits/b121-specs/PLAN.md` — the full plan with per-item scope.
>
> The original §7's Phase D (env/ops) and Phase E (device matrix) content survives in Part I §8 and
> §9 respectively, corrected.

---

## II.8 Scope notes

- The 4 findings the audit marked ⚠ UNVERIFIED (GCV-3, SYNC-5, SYNC-6, SYNC-7) failed verification
  only because the verifier agents hit API stream/session-limit errors overnight. **All four were
  subsequently re-verified and confirmed** in the 2026-07-20 spec pass (Part I §1).
- iOS-side ground truth is bounded by the interop audit's build-skew caveat: every cross-platform
  row must record the TestFlight build number; rows against builds 143/144 are UNTESTABLE for
  group calls, not failing.
- No stress/soak testing was executed on-device this session; the "stress" dimension is covered
  analytically (throttle math, timer freeze, backlog arithmetic in SRV-05) and by the automated
  suites. Device follow-through is Part I §9.
- **Still open from the original Phase D (ops, no code):** iOS `APNS_VOIP_*` + org App ID (P-1) —
  still the blocker for any locked-iPhone ring; and a new iPhone TestFlight build from `main`
  ≥ `76e2702` via the Mac runbook (closes IOSGV-1, IOSVID-2, IOSVID-4, the background-modes class,
  and unblocks complaint-5 retesting on even builds).
