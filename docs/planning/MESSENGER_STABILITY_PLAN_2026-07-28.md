# Messenger Stability Plan — 2026-07-28

**Mandate (founder, 2026-07-27 night):** "fix all — and also tackle the edge cases as you can on
messenger." Standing bar from the same session: **messages feel instant; delivery is the norm;
retry is a <1% extreme-case path** — and nothing is called fixed until the device proves it
(round-1/round-2 lesson of B-311/B-312: verify the on-device state a fix's gate depends on, not
just green tests).

**Governing runbooks:** `MESSAGE_LOOP.md` (message pipeline — M1–M16, §5 caller-completeness,
§7 gates), `docs/runbooks/BACKUP_LOOP.md` (anything touching backup), CLAUDE.md messenger
regression gate (crypto suite ×2 + app screen tests, every time).

---

## Work items, in order

### W1 — B-313: restore tolerates LOW NETWORK · P1

Tonight's evidence: the heal + verify are solid, but one timed-out fetch aborts the whole restore
run into a hard banner needing manual RETRY (3× on LTE until Wi-Fi).

- **W1.1** Per-page retry inside the walk: backoff 2 s / 8 s / 30 s + jitter before a page failure
  becomes a round failure. A dropped packet must surface nothing.
- **W1.2** Sustained failure → quiet `waiting_network` state instead of the error banner:
  auto-resume from the cursor on the next attempt cycle (cap ~5 rounds before the hard banner).
  No connectivity-listener dependency in v1 — a capped backoff loop is enough and testable.
- **W1.3** Same per-attempt retry for the heal commit's server walk (it is a network walk too).
- **Tests:** runner harness (`restoreBackgroundRunner.test.ts` style) — page fails twice then
  succeeds ⇒ no state change to error; N sustained rounds ⇒ banner; cursor preserved across
  auto-resumes. RED-first.
- **Device check:** airplane-mode toggle mid-restore ⇒ no banner, restore completes after
  reconnect.

### W2 — Send-path STAGE-SUM probe · the smoothness prerequisite

The 2026-07-26 probes fired only at >120 ms PER STAGE — eight ~30 ms stages summing to a felt
~250 ms stall stay invisible (measured burst: ~150–280 ms per send, cause unnamed).

- One `[LAGDIAG] [send.stages]` warn per send: total ms + per-stage breakdown (serialize, ratchet,
  sealed-sender, store append, SQL upsert enqueue, WS submit, mirror enqueue). Metadata only —
  stage names + ms, no content (logAudit constraint).
- Plus a delivery-rate counter: `[MSGSTAT] sent=N acked=N retried=N failed=N` emitted once/min
  while sending — the founder's 1% bar becomes a readable number.
- **This is probes-only in `productionRuntime.ts`** → MESSAGE_LOOP applies: no behavior change,
  static-scan suites must stay green, crypto suite ×2.
- The FIX for whatever the numbers name is a separate item (W2b) — numbers first, fix second;
  no guessing (CLAUDE.md lag doctrine).

> **W3/W4 status (2026-07-28):** three parallel code audits mapped both paths and the
> call matrix; eight findings claimed as **B-315..B-322** in sqa.md. Fixed same day:
> B-315 (drain in-run cursor), B-316 (expiry skew grace, both sites), B-317 (LRU evict
> consults outbox), B-318 (1:1 compose-time ts), B-319 (accept controllerReady gate +
> canGoBack fallbacks), B-320 (launchCall combined busy guard + stale-leave capture),
> B-321 (parked-ring registry-null consume fallback), B-322 (glare route-name belt).
> Pinned by `drainRelayCursor` / `expiredEnvelopeGate` / `sendEdgeInvariants` /
> `callAnswerStuck` / `callEdgeGuards` suites. W3.1–W3.4 verified WORKING as designed
> (durable outbox, soft/hard retry ladders, 3-layer receive dedup + server claim, FIFO
> lanes). Remaining documented residuals: D1 fresh-id manual retry duplicate
> (deliberate trade), D4 group-leg permanent-rejection omission (deliberate), D5-D7
> minor lanes, W4.2/4.3 group-ring-over-group UX (feature-scale), missed-bubble on
> parked-ring TTL expiry.

### W3 — Messaging edge cases (send/receive) · fix what is provably broken, pin the rest

Audit + fix pass over the known-fragile seams, each with a RED test or an explicit DOCUMENTS pin:

- **W3.1 Offline send queue:** send with no transport ⇒ message must queue and auto-flush on
  reconnect (not error, not silently vanish). Verify the outbox drain covers app-restart between
  queue and flush.
- **W3.2 Send retry discipline:** a failed submit retries with backoff, capped; after cap the
  bubble shows a manual retry affordance. No infinite spinners.
- **W3.3 Duplicate protection under retry:** a retry that raced a slow ACK must not double-send
  (client msg id dedup on the relay path) — pin it.
- **W3.4 Burst ordering:** 20 rapid sends arrive in order on the peer (per-conversation ordering
  under the outbox) — pin it.
- **W3.5 Receive-while-backgrounded drain:** foregrounding after a long background drains fully
  without dropping pages (the B-126 "page made no progress" line seen 2026-07-27 gets a
  root-cause look: in-flight-skipped envelope wedge).
- **W3.6 Clock-skew tolerance on receive:** wake/envelope expiry checks vs device clock (the
  N-03 class) — verify the skew window actually shipped, pin it.

### W4 — Call edge-case matrix (the founder's "many edge cases on calling")

Model first, then fix the top holes. The matrix (rows = existing state, cols = incoming event):

| state \ event                 | incoming 1:1               | incoming GROUP ring                      | user starts outgoing |
| ----------------------------- | -------------------------- | ---------------------------------------- | -------------------- |
| idle                          | ✅ normal                  | ✅ normal                                | ✅ normal            |
| on 1:1                        | ✅ callWaiting (B-238)     | ✅ B-306 park                            | ❓ W4.1              |
| on GROUP call                 | ❓ W4.2 auto-busy? silent? | ❓ W4.3 second ring UI?                  | ❓ W4.4              |
| outgoing ringing (unanswered) | ❓ W4.5                    | ❓ W4.6                                  | n/a                  |
| minimized 1:1                 | ✅ callWaiting             | ❓ W4.7 (park consume needs CallScreen?) | ❓ W4.8              |

- Fill every ❓ by reading the code, classify: works / broken / unmodeled.
- Fix the CHEAP+SEVERE ones now (likely: W4.7 — a parked ring with CallScreen minimized never
  consumes, because the consume lives in CallScreen's dismissal; needs a registry-side consume
  fallback. And W4.2/W4.3 — busy-on-group behavior must at least not crash/stack screens).
- DOCUMENTS-pin the rest with the matrix as the source of truth; the full call-waiting UX for
  group rings is feature work, explicitly out of scope tonight.
- **Answer-from-notification (stuck "answering")** stays open pending its captured repro — the
  accept path gets a `[CALLDIAG]` warn trail in this pass (accept tapped → payload found/missing
  → navigate → controller accept → first frame) so the NEXT occurrence is a read, not a hunt.

### W5 — Staging auto-deploy broken (ops) · **DIAGNOSED: GitHub org billing — BLOCKED on org owner (B-314)**

Every `deploy-staging.yml` run dies in ~5 s (days). **Root cause found 2026-07-28:** the job is
never started — zero steps, no runner — and the check-run annotation states it directly:
_"The job was not started because recent account payments have failed or your spending limit
needs to be increased."_ Last successful run 2026-07-10 (`2b190e15b`); same wall kills every
workflow on the org. The workflow file itself is fine; **nothing in the repo fixes this** — the
`omnidevxstudiobit` org owner must repair Billing & plans. Until then every deploy is manual
(`scripts/deploy-staging.sh` / scp overlay), with the B-314 cautions: verify the box's
auth-service drift per-file before any `--delete` sync, and re-verify restore if the 6faf849
backup server halves go out. Staleness inventory in sqa.md B-314.

---

## Protocol (applies to every item)

1. RED test first (or DOCUMENTS pin when deliberately not fixing).
2. Gates: `messenger-crypto` ×2 (flake rule; bystanders checked in isolation — B-304), app
   `screens/messenger`, tsc ≤ 47.
3. sqa.md entry with bug number claimed in the header.
4. **Device verification before "fixed"** — name the exact log line or visible behavior that
   proves it, then check it. Probes ship WITH the fix so verification is a read.
5. Commit per item (subject ≤ 80 chars, message via BOM-free file), push only on green.

## Out of scope (named so they are not silently dropped)

- Full group-ring call-waiting UI (feature; design first)
- B-312 residual: cross-device prefix-check hole (needs the upload-time incremental-leaf design)
- Verify-path yielding for low-end devices (touches the pinned verify posture — own session)
- GAP-1 native ShortcutManager publisher; AC-5 in-call directory search
