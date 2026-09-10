# OR-6 - Foreground resume with a healthy socket never kicks the durable outbox

## Verdict

**CONFIRMED** (mechanism exactly as described; line numbers drifted — the handler now lives at
`src/modules/messenger/runtime/productionRuntime.ts:1428-1489`).

Evidence from the CURRENT tree:

1. `productionRuntime.ts:1444` — `const resumeAction = decideResumeAction(pongFresh, hasLiveCall());`
2. `productionRuntime.ts:1445-1448` — the `'drain'` branch is **only** `coalescedDrain().catch(() => { /* silent */ });`
   (`coalescedDrain` at `:1239` calls `drainRelay(...)`, i.e. the **receive** side only).
3. `productionRuntime.ts:1449-1470` — the `'probe'` branch sends one `ping`, schedules a 3 s
   re-check, and calls `coalescedDrain()` twice. **No `drainOutbox` anywhere in the whole
   `AppState === 'active'` block** (`grep -n drainOutbox productionRuntime.ts` → 779, 1134, 1601,
   1613, 2504, 3372, 7393-7527 — none inside 1428-1489).
4. The only outbox kicks are: boot (`:1601`), the 60 s timer (`:1612-1614`
   `setInterval(() => { void drainOutbox(outboxLive, relay, isOurEpoch, resealDeferredGroupRow); }, 60_000)`),
   and the WS `'connected'` transition (`:1133-1135`).
5. Because `decideResumeAction` returns `'drain'` when `pongFresh` and `'probe'` when a call is
   live (`callResumeGuard.ts:55-59`), a resume onto a **healthy** socket never produces a
   `disconnected → connected` transition, so `:1133` never fires → the outbox is untouched.
6. Worst case is therefore ~60 s (one full `outboxRetryTimer` period), and worse in practice:
   RN suspends/throttles JS timers while backgrounded, so the tick that "should" have fired
   during the background stint is coalesced — the user foregrounds, sees a single-tick bubble,
   and nothing moves until the next tick lands.

Not already fixed, not refuted. `drainOutbox` is module-private to `productionRuntime.ts`
(repo-wide grep: only `sqlOutboxStore.ts` doc-comments and `productionRuntime.ts` mention it), so
no other surface compensates.

## Mechanism

1. User sends a message while on a flaky/backgrounded connection. The send path enqueues a durable
   row (`SqlOutboxStore.enqueue`, written **before** `transport.send`) and the bubble shows
   `status: 'sending'`.
2. The WS send never gets `envelope.accepted` (Doze, radio off, app backgrounded). The row stays
   `status='pending'` with `next_retry_at` set by the backoff ladder
   (`sqlOutboxStore.ts:59` `BACKOFF_MS = [1_000, 4_000, 15_000, 60_000, 5*60_000]`).
3. App goes to background. `outboxRetryTimer` (60 s) is suspended/throttled by RN. Nothing ships.
4. User foregrounds. `AppState 'active'` fires. socket.io has already silently reconnected or the
   socket genuinely survived, so `transport.state === 'connected'` and `lastPongAt` is within 8 s
   → `pongFresh === true` → `decideResumeAction` returns `'drain'`.
   (Or: a call FGS held the socket, pong is stale → `'probe'`.)
5. The handler calls `coalescedDrain()` → `drainRelay(...)` → **inbound** envelopes are pulled and
   rendered. The outbox is never consulted. `row.next_retry_at` is long past due.
6. No `disconnected → connected` state transition occurs (the socket never dropped from the
   client's point of view), so the `:1133` reconnect drain never runs either.
7. The row waits for the next `outboxRetryTimer` tick — up to 60 s of a stuck single tick, with the
   user staring at the chat they just opened. The asymmetry is the bug: resume fixes _receive_ and
   ignores _send_.

Note the send path is **HTTP** (`drainOutbox` → `relay.send` → `RelayHttpClient.request`,
`packages/messenger-core/src/transport/relayClient.ts:86`), not the WS. So the drain does not need
the socket at all — which is why the fix is safe in all three resume branches, including
`'reconnect'` where `forceReconnect()`'s handshake can take seconds before `:1133` fires.

## Fix

Single insertion in `src/modules/messenger/runtime/productionRuntime.ts`. **Hoist** the kick above
the `resumeAction` branch rather than duplicating it in two branches (the audit's phrasing) — one
insertion instead of two, and it additionally covers the `'reconnect'` branch, where the HTTP send
path is usable immediately while the socket handshake is still in flight.

### `src/modules/messenger/runtime/productionRuntime.ts`

**Anchor** (verbatim, current tree, inside the `AppState.addEventListener('change', ...)` callback):

```ts
      const resumeAction = decideResumeAction(pongFresh, hasLiveCall());
      if (resumeAction === 'drain') {
```

**Replacement:**

```ts
      const resumeAction = decideResumeAction(pongFresh, hasLiveCall());
      // OR-6 — resume must kick the SEND side too. `drain`/`probe` mean the
      // socket never dropped, so the `connected` handler's outbox replay
      // (which is the only other non-timer kick) never fires and a due row
      // waits up to a full 60s outboxRetryTimer period. drainOutbox ships over
      // HTTP, so it works in all three branches; it self-guards on
      // drainOutboxInflight and dueRows() filters on next_retry_at, so an idle
      // resume costs one empty SELECT.
      if (sqlOutbox) {
        void drainOutbox(sqlOutbox, relay, isOurEpoch, resealDeferredGroupRow);
      }
      if (resumeAction === 'drain') {
```

That is the entire production change: 8 comment lines + 3 code lines.

Notes on why this exact shape:

- `if (sqlOutbox) { void drainOutbox(sqlOutbox, relay, isOurEpoch, resealDeferredGroupRow); }` is a
  byte-for-byte reuse of the proven call shape at `:1133-1135`, so the `let sqlOutbox:
SqlOutboxStore | null` narrowing typechecks identically (no `const outboxLive` alias needed —
  that alias at `:1611` exists only because the `setInterval` closure escapes the narrowing scope).
- All four arguments (`sqlOutbox` `:970`, `relay`, `isOurEpoch`, `resealDeferredGroupRow` `:786`)
  are in scope at `:1444`; the listener body only runs post-construction, same as the `onFrame`/
  `onStateChange` closures that already capture `sqlOutbox`.
- No throttle/debounce is added. A rapid foreground/background flap (iOS control-centre pull emits
  `inactive → active`) costs one `SELECT ... FROM outbox WHERE status='pending' AND next_retry_at <= ?`
  which returns early on empty (`drainOutbox` `:7404` `if (rows.length === 0) {return;}`), and
  concurrent calls are collapsed by `drainOutboxInflight` (`:7393`, `:7400`).

**No schema change.** `outbox` table shape, `SqlOutboxStore`, and the SQLCipher schema version are
untouched — this is a scheduling change only, no new columns, no migration.

**No wire change.** `drainOutbox` uses the existing `POST /envelopes` shape via
`RelayHttpClient.send`. Server, envelope shape, AAD binding, sender cert, dwell semantics, ack/
retract tokens: all unchanged. Old/new client and old/new server interoperate exactly as today.

**No security-check change.** The re-seal path (`resealDeferredGroupRow`, cert-staleness gate
`isStoredCertStale` at `:7446`) is reached through the identical call, so a resume-triggered drain
mints a **fresh** sender cert exactly like the reconnect/timer drains — no window is widened, no
check is skipped. Nothing new is logged (`drainOutbox`'s existing logs carry only counts,
`clientMsgId`, and peer ids — no bodies, no key bytes — and are unchanged).

**Retry-budget safety.** The kick cannot shorten backoff (`dueRows` filters `next_retry_at <= now`)
and cannot burn the attempt budget on a dead network (`recordAttempt(..., {unreachable: true})`
bumps only `next_retry_at`, `sqlOutboxStore.ts:235-245`). A stale access token after a long
background does not consume budget either: `RelayHttpClient.request` refreshes once on 401 and
retries (`relayClient.ts:191-216`).

## Blast radius

**Files touched:** `src/modules/messenger/runtime/productionRuntime.ts` (one hunk, ~11 lines) plus
one new test file.

**Functions affected:**

- The `AppState.addEventListener('change', …)` callback (`:1428-1489`) — the only edited function.
- `drainOutbox` (`:7394`) — call frequency increases only; body unchanged. Callers become 4:
  boot `:1601`, reconnect `:1134`, 60 s timer `:1613`, **and resume (new)**.
- Downstream of a drain that now runs earlier: `SqlOutboxStore.dueRows/markDelivered/recordAttempt`,
  `resealDeferredGroupRow` (`:786`), `RelayHttpClient.send`, and the three
  `useMessengerStore` mutations `updateMessageStatus` / `updateMessageRetractToken` /
  `updateMessageEnvelopeId`. All already run on this exact path today, just later.

**What could regress:**

- _Extra relay load on resume._ Bounded: one drain per foreground transition, coalesced by
  `drainOutboxInflight`, and it only issues network calls when rows are actually due. Server-side
  rate limits are per-user and unchanged; a foreground drain replaces work the 60 s tick would have
  done anyway.
- _Interleaving with a concurrent drain._ If the 60 s tick is mid-flight when the user foregrounds,
  the resume call returns immediately (`drainOutboxInflight`) — the row is not skipped, it is
  already being processed by the in-flight pass. Pre-existing semantics, not new.
- _Group fan-out amplification._ None. The drain ships the already-enqueued per-peer rows one at a
  time via individual `POST /envelopes` — it does not create new rows and does not batch, so the
  relay-blindness constraint (one unrelated ciphertext per recipient) is preserved.
- _Epoch safety on user switch._ `drainOutbox` re-checks `isOurEpoch()` per row (`:7407`), and the
  AppState callback already bails on a stale epoch at `:1432`. Two guards, both pre-existing.

**Overlapping findings (edit-conflict watch):**

- **OR-1** (WorkManager / `BOOT_COMPLETED` background drain) — same function `drainOutbox`, and
  ARCH-gated NOT-COVERED. If OR-1 lands, this resume kick becomes one of several writers; nothing
  here blocks it, but merge OR-6 first (it is the trivial one).
- **OM-05** (reuse compose `sentAtMs` on re-seal) — edits the `drainOutbox` body / re-seal path.
  Different hunk, same file; textual conflict unlikely, semantic overlap: OM-05 must keep the
  cert-freshness re-mint at `:7446` intact, which the resume kick now exercises more often.
- **GF-2 / SYNC-2** (group key fan-out through the durable outbox) — adds outbox rows carrying key
  material. Those rows would now also be replayed on resume; that is desirable, but it makes the
  `logAudit` gate on `drainOutbox`'s log lines more load-bearing.
- **Any other finding editing the `AppState === 'active'` block** in this batch (OR-4 / OM-06 / XO-4
  if they touch resume) will conflict textually on the same anchor — sequence them, do not merge in
  parallel.

## Tests

`productionRuntime.ts` cannot be imported under Jest (the repo says so explicitly:
`src/modules/messenger/__tests__/bootGroupStashDrain.test.ts:12` — _"`productionRuntime.ts` is too
heavy to import in jest"_). The established substitute for pinning a runtime invariant in this file
is a **static source assertion**, already used in this very directory
(`groupCallConsumeOrder.test.ts:21-48`, `logAudit.test.ts`, `vaultMoveGuard.test.ts`,
`frameCryptorParity.test.ts`).

Extracting a pure helper is NOT worth it here — the decision is unconditional ("always kick"), so a
`resumeShouldDrainOutbox()` helper would be a function that returns `true` and a test that asserts
`true`. Pin the wiring instead.

### New: `src/modules/messenger/__tests__/resumeOutboxKick.test.ts` (project `messenger-crypto`)

```ts
/**
 * OR-6 — a foreground resume onto a HEALTHY socket must kick the durable
 * outbox, not just the receive-side drain. `drain`/`probe` resumes produce no
 * disconnected→connected transition, so the reconnect-time drainOutbox at the
 * onStateChange handler never fires and a due row waits a full 60s
 * outboxRetryTimer period. productionRuntime.ts is too heavy to import under
 * jest (see bootGroupStashDrain.test.ts), so pin the wiring statically —
 * same approach as groupCallConsumeOrder.test.ts.
 */
import {readFileSync} from 'fs';
import {join} from 'path';

const SRC = readFileSync(join(__dirname, '..', 'runtime', 'productionRuntime.ts'), 'utf8');

function appStateActiveBlock(): string {
  const start = SRC.indexOf("AppState.addEventListener('change'");
  expect(start).toBeGreaterThan(-1);
  const end = SRC.indexOf('liveAppStateSub = appStateSub', start);
  expect(end).toBeGreaterThan(start);
  return SRC.slice(start, end);
}

describe('OR-6 — AppState resume kicks the durable outbox', () => {
  it('calls drainOutbox inside the AppState-active handler', () => {
    expect(appStateActiveBlock()).toMatch(/drainOutbox\(\s*sqlOutbox\s*,/);
  });

  it('kicks the outbox BEFORE branching on resumeAction, so drain/probe are covered', () => {
    const block = appStateActiveBlock();
    const kickAt = block.indexOf('drainOutbox(');
    const branchAt = block.indexOf("if (resumeAction === 'drain')");
    expect(kickAt).toBeGreaterThan(-1);
    expect(branchAt).toBeGreaterThan(-1);
    expect(kickAt).toBeLessThan(branchAt);
  });

  it('guards on sqlOutbox and threads the reseal callback (fresh sender cert)', () => {
    expect(appStateActiveBlock()).toMatch(
      /if\s*\(sqlOutbox\)\s*\{\s*void drainOutbox\(sqlOutbox, relay, isOurEpoch, resealDeferredGroupRow\);/,
    );
  });

  it('still drains the receive side on resume (no regression of the original behaviour)', () => {
    expect(appStateActiveBlock()).toMatch(/coalescedDrain\(\)/);
  });
});
```

### Existing suites to re-run (regression)

- `npx jest --selectProjects=messenger-crypto -t 'OR-6'` — the new test, fail-fast.
- `src/modules/messenger/__tests__/callResumeGuard.test.ts` — `decideResumeAction` semantics must be
  unchanged (the fix deliberately does **not** touch the guard).
- `src/modules/messenger/__tests__/sqlOutboxStore.test.ts` and `outboxCertFreshness.test.ts` — the
  drain contract (`dueRows` filtering, `recordAttempt` unreachable exemption, stale-cert re-mint)
  must still hold now that it is exercised on a new trigger.
- `npm run test:crypto` (full `messenger-crypto` project), then `npm test`.
- `npm run typecheck` — must not exceed the `.tsc-baseline.json` count (47).

### Device probe (state so if not run)

Airplane-mode a send (bubble stuck at one tick) → background the app for ~20 s → disable airplane
mode → foreground. The bubble must flip to ✓ within ~1 s of resume, not after up to a minute.
Logcat marker: `[messenger.outbox] draining N row(s)` immediately following the foreground.

## Risk

Low. Things a reviewer should be suspicious of, in order:

1. **`sqlOutbox` narrowing.** It is a `let … | null` in the enclosing factory scope. The fix reuses
   the exact `if (sqlOutbox) { void drainOutbox(sqlOutbox, …) }` shape that already compiles at
   `:1133-1135`; if the reviewer sees a `const outboxLive = sqlOutbox` alias in the diff, that is a
   sign someone moved the call into a nested closure and lost the narrowing — reject it, the alias
   would also pin a stale store across a runtime rebuild.
2. **Placement.** The kick must be _above_ the `resumeAction` branch and _below_ the `isOurEpoch()`
   bail at `:1432`. Below the branch would still work, but inside a single branch (the audit's
   literal wording) leaves `'probe'` or `'reconnect'` uncovered — the whole point.
3. **Someone "improving" it with a throttle.** A resume-side throttle (e.g. min 10 s between kicks)
   re-introduces the bug for the exact scenario users hit: send → background → immediately
   foreground. `drainOutboxInflight` + `dueRows`' `next_retry_at` filter are already the throttle.
4. **Someone adding a `transport.state === 'connected'` precondition.** Wrong: the drain ships over
   HTTP, and gating on the socket would silently drop the `'reconnect'` case, which is precisely
   when rows are most likely due.
5. **The 3 s probe timeout.** Not given a second kick, deliberately — a row that becomes due inside
   that 3 s window is covered by the 60 s timer, and adding a kick there would double the resume
   cost for zero user-visible gain. If a reviewer wants it, it is additive, not a correctness fix.
6. **Static test brittleness.** The new test asserts on source text; a legitimate refactor of the
   AppState handler will fail it. That is the accepted trade in this directory
   (`groupCallConsumeOrder.test.ts` makes the same trade explicitly) because the alternative is
   mocking the entire RN + SQLCipher + transport graph. If the handler is ever refactored into a
   testable helper, replace the static test with a behavioural one.
