# OR-4 — Drain coalescers swallow triggers that arrive mid-drain (no re-run latch)

## Verdict

**CONFIRMED** (both coalescers; line numbers drifted by a few, code matches exactly).

Receive-side coalescer — `src/modules/messenger/runtime/productionRuntime.ts:1239-1277`:

```ts
1246:    if (drainInflight) { return drainInflight; }
1247:    const run = async (): Promise<void> => {
1248:      try {
1252:        if (!isOurEpoch()) {return;}
1253:        await drainRelay(
...
1271:      } finally {
1272:        drainInflight = null;
1273:      }
1274:    };
1275:    drainInflight = run();
```

A caller arriving while `drainInflight` is set receives the _already-doomed_ promise and **nothing is
recorded**; when `run` settles, `drainInflight` is nulled and no follow-up pass is scheduled.

Send-side coalescer — `productionRuntime.ts:7393-7401` / `:7526-7528`:

```ts
7393: let drainOutboxInflight = false;
7400:   if (drainOutboxInflight) {return;}
7401:   drainOutboxInflight = true;
...
7526:   } finally {
7527:     drainOutboxInflight = false;
7528:   }
```

Same shape, worse: the bounced caller gets a resolved `Promise<void>` (looks like success) and there
is no latch at all.

Recovery cadence confirms the audit: the outbox has exactly one periodic re-trigger,
`productionRuntime.ts:1612-1614`

```ts
const outboxRetryTimer = setInterval(() => {
  void drainOutbox(outboxLive, relay, isOurEpoch, resealDeferredGroupRow);
}, 60_000);
```

and the **receive** coalescer has _no_ periodic tick at all — every `coalescedDrain()` call site is
event-driven (`:1114` WS `connected`, `:1448`/`:1467`/`:1470` AppState resume, `:4560`
`pullEnvelopes` from `ChatScreen`/`DepartmentChatScreen`/`fcmBootstrap`). A swallowed receive trigger
therefore waits for the _next_ user-visible event, not for a timer.

**Honest caveat (audit slightly overstated the reconnect case):** on a _successful_ WS reconnect the
gateway pushes the backlog itself —
`apps/messenger-service/src/gateway/messenger.gateway.ts:539` → `flushPendingOnConnect` (`:712`,
paginated, `bootstrap:true`). So a swallowed `connected`-branch `coalescedDrain()` is largely covered
by the server flush. The genuinely uncovered swallows are (a) **every `drainOutbox` trigger**
(no server-side equivalent — the outbox is client-only), and (b) the AppState-resume /
`pullEnvelopes` receive triggers, which fire when the socket is _already_ connected and there is no
new `handleConnection` to flush anything.

## Mechanism

Timings that make the window real, not theoretical:

- Every relay HTTP request is bounded at **20 s** (`packages/messenger-core/src/transport/fetchWithTimeout.ts:18`,
  `TRANSPORT_TIMEOUT_MS = 20_000`), and `drainOutbox` ships rows **serially** (`productionRuntime.ts:7406`
  `for (const row of rows)`).
- So a black-holed route (exactly what a Wi-Fi→LTE handover produces for a few seconds) makes a
  drain pass last `20 s × rows` for the outbox, and up to `20 s × 10` for `drainRelay`
  (`HARD_CAP_ITERATIONS = 10`, `productionRuntime.ts:7563`).

Send-side, step by step:

1. Device is on Wi-Fi with a dead upstream. `drainOutbox` starts; `dueRows()` returns 4 rows.
2. Row 1's `relay.send` hangs; `fetchWithTimeout` aborts at 20 s; `recordAttempt(..., {unreachable:true})`
   sets `next_retry_at = now + 1000` (`src/modules/messenger/store/sqlOutboxStore.ts:235-244`).
   Rows 2-4 do the same. Total pass ≈ 80 s.
3. At t≈5 s NetInfo sees the handover, `transport.notifyNetworkChange()` rebuilds the socket, the
   `connected` branch fires `void drainOutbox(sqlOutbox, ...)` (`productionRuntime.ts:1134`).
   `drainOutboxInflight === true` → **returns immediately, nothing recorded**.
4. At t≈60 s the `outboxRetryTimer` fires → also swallowed.
5. Pass ends at t≈80 s. All four rows are due (their `next_retry_at` was `+1 s`, long past).
   Nothing runs them. Next attempt is the following 60 s tick → up to **~140 s** of "sending" spinner
   on a device that has had good LTE for over two minutes.

Receive-side, step by step:

1. `coalescedDrain()` from a background→foreground resume starts a `drainRelay` whose first
   `relay.pull` is stuck on the dead route (up to 20 s).
2. The user opens a chat; `ChatScreen`'s mount effect awaits `rt.pullEnvelopes()`
   (`src/screens/messenger/ChatScreen.tsx:384`) → `coalescedDrain()` → returns the doomed promise.
3. The doomed pull rejects; `pullEnvelopes` logs `[bravo.pullEnvelopes] drain failed` and the user
   sees a stale thread. Nothing re-drains until the next AppState transition or WS reconnect.

Root cause in one line: both coalescers implement _mutual exclusion_ but not _edge retention_ — a
trigger is an edge, and an edge that lands inside the critical section is lost.

## Fix

No wire change, no schema change, no migration. Purely client-local scheduling. Three files.

### F1 (new) `src/modules/messenger/runtime/rerunCoalescer.ts`

Follows the established "small pure runtime helper, node-safe, unit-tested in the `messenger-crypto`
project" pattern already used by `callResumeGuard.ts`, `outboxCertFreshness.ts`,
`bootGroupStashDrain.ts`.

```ts
/**
 * OR-4 — single-flight coalescer WITH a re-run latch.
 *
 * The plain mutex both drain paths used implements mutual exclusion but not
 * edge retention: a trigger that lands inside the critical section is
 * absorbed into a pass that is already committed to a dead route. On a
 * Wi-Fi→LTE handover the reconnect kick lands exactly there, and the next
 * attempt is whatever timer happens to fire next (60 s for the outbox;
 * nothing at all for the receive drain, which has no periodic tick).
 *
 * `createRerunCoalescer` keeps the single-flight property — concurrent
 * callers still share ONE promise and the relay still sees one request
 * sequence at a time — but remembers that a trigger arrived and runs one
 * more pass when the current one settles. Re-runs are bounded so a source
 * that fires continuously cannot spin the relay.
 */

/** Extra passes a latched trigger may schedule (total passes = this + 1). */
export const MAX_COALESCER_RERUNS = 2;

/**
 * Wrap `run` so that:
 *  • concurrent calls share the in-flight promise (unchanged single-flight);
 *  • a call made while `run` is executing latches ONE re-run, however many
 *    callers arrive (they coalesce onto the same latch);
 *  • the shared promise settles only when no further re-run is pending, so
 *    an awaiting caller genuinely gets a pass that started after it asked;
 *  • a pass that throws still honours the latch — the failure is what makes
 *    the re-run worth doing — and the promise rejects with the LAST pass's
 *    error only if that last pass failed.
 */
export function createRerunCoalescer(
  run: () => Promise<void>,
  maxReruns: number = MAX_COALESCER_RERUNS,
): () => Promise<void> {
  let inflight: Promise<void> | null = null;
  let rerunRequested = false;

  return (): Promise<void> => {
    if (inflight) {
      rerunRequested = true;
      return inflight;
    }
    const pump = async (): Promise<void> => {
      let lastErr: unknown = null;
      let lastFailed = false;
      try {
        for (let pass = 0; pass <= maxReruns; pass++) {
          rerunRequested = false;
          lastErr = null;
          lastFailed = false;
          try {
            await run();
          } catch (e) {
            lastErr = e;
            lastFailed = true;
          }
          if (!rerunRequested) {
            break;
          }
        }
      } finally {
        rerunRequested = false;
        inflight = null;
      }
      if (lastFailed) {
        throw lastErr;
      }
    };
    inflight = pump();
    return inflight;
  };
}
```

Note the `throw` is deliberately **after** the `finally` block's slot-clear so a rejecting pump has
already released `inflight` before any `.catch` handler runs (a handler that re-triggers must be able
to start a fresh pass).

### F2 `src/modules/messenger/runtime/productionRuntime.ts` — import

Anchor (line 88):

```ts
import {isStoredCertStale} from './outboxCertFreshness';
```

Replace with:

```ts
import {isStoredCertStale} from './outboxCertFreshness';
import {createRerunCoalescer} from './rerunCoalescer';
```

### F3 `productionRuntime.ts` — receive coalescer

Anchor (lines 727-732):

```ts
// Fix #4: drainRelay mutex. Coalesces WS-reconnect, AppState 'active'
// foreground push, and ChatScreen pullEnvelopes() into ONE in-flight
// call. Without this, three sources can fire concurrent pulls; the
// server is idempotent on ack but the cost is needless network
// chatter and triple-decryption of the same envelope.
let drainInflight: Promise<void> | null = null;
```

Replace with (the slot moves into the coalescer; keep the rationale comment):

```ts
// Fix #4: drainRelay mutex. Coalesces WS-reconnect, AppState 'active'
// foreground push, and ChatScreen pullEnvelopes() into ONE in-flight
// call. Without this, three sources can fire concurrent pulls; the
// server is idempotent on ack but the cost is needless network
// chatter and triple-decryption of the same envelope.
// OR-4: the mutex now carries a re-run latch (see rerunCoalescer.ts) so a
// trigger landing mid-pass isn't absorbed into a pass already committed to
// a dead route. This drain has NO periodic tick — a swallowed edge waited
// for the next foreground/reconnect.
```

(`drainInflight` has no other reader — `grep -n 'drainInflight' productionRuntime.ts` returns only
`:732`, `:1246`, `:1272`, `:1275`, `:1276`, all inside the block replaced here and in the next hunk.)

Anchor (lines 1239-1277) — the whole `coalescedDrain` definition:

```ts
  const coalescedDrain = (): Promise<void> => {
    // Round 6 / race fix — bail before kicking off a drain when we're
    // no longer the live runtime. drainRelay walks the relay queue and
    // funnels each envelope through handleIncoming → store mutations,
    // any of which would land on the new user's store if our epoch is
    // stale.
    if (!isOurEpoch()) {return Promise.resolve();}
    if (drainInflight) { return drainInflight; }
    const run = async (): Promise<void> => {
      try {
        // Re-check inside the async — between the synchronous gate
        // above and the first await, signOut could have flipped the
        // epoch. Cheap.
        if (!isOurEpoch()) {return;}
        await drainRelay(
```

Replace the header/footer around the unchanged `drainRelay(...)` argument list:

```ts
const drainPump = createRerunCoalescer(async () => {
  // Re-check inside the async — between the synchronous gate in
  // coalescedDrain and the first await (and again on every latched
  // re-run), signOut could have flipped the epoch. Cheap.
  if (!isOurEpoch()) {
    return;
  }
  await drainRelay(
    own,
    ownStore,
    relay,
    config,
    keys,
    peer => {
      if (!isOurEpoch()) {
        return;
      }
      void sendRehandshakeNudge({
        own,
        ownStore,
        keys,
        peer,
        ownAddress,
        certCache,
        transport,
        relay,
      });
    },
    peerIdentityCache,
    // Audit P0-N14 — atomic ratchet+plaintext on the drain path too.
    ownStore instanceof SqlCipherProtocolStore ? ownStore.getDb() : null,
    sqlMessages,
    // Audit P0-N6 — dedup on the HTTP catch-up path too.
    seenEnvelopes,
    // Audit 1:1 P1-1 — cert revocation cache on the drain path too.
    revokedJtiCache,
    // Bug-hunt #3 — pending-stash threading on the drain path too.
    pendingGroupEnvelopes,
    pendingAdminActions,
  );
});

const coalescedDrain = (): Promise<void> => {
  // Round 6 / race fix — bail before kicking off a drain when we're
  // no longer the live runtime. drainRelay walks the relay queue and
  // funnels each envelope through handleIncoming → store mutations,
  // any of which would land on the new user's store if our epoch is
  // stale. Gating here also means a stale caller can't arm the re-run
  // latch.
  if (!isOurEpoch()) {
    return Promise.resolve();
  }
  return drainPump();
};
```

Everything between `own, ownStore, relay, config, keys,` and `pendingAdminActions,` is byte-identical
to the current tree — only the surrounding `run`/`drainInflight` scaffolding is replaced. The
`sqlMessages` / `seenEnvelopes` / `pendingGroupEnvelopes` / `pendingAdminActions` bindings are outer
`let`s assigned later at boot (`:1590-1591`); the arrow body reads them at _call_ time exactly as the
current `run` closure does, so ordering is unchanged.

### F4 `productionRuntime.ts` — send coalescer

Anchor (lines 7393-7402):

```ts
let drainOutboxInflight = false;
async function drainOutbox(
  outbox: SqlOutboxStore,
  relay:  RelayHttpClient,
  isOurEpoch: () => boolean,
  reseal?: ResealDeferredFn,
): Promise<void> {
  if (drainOutboxInflight) {return;}
  drainOutboxInflight = true;
  try {
    const rows = await outbox.dueRows();
```

Replace with:

```ts
interface DrainOutboxArgs {
  outbox: SqlOutboxStore;
  relay:  RelayHttpClient;
  isOurEpoch: () => boolean;
  reseal?: ResealDeferredFn;
}
// Why: the pump is module-level (as `drainOutboxInflight` was), so it must read
// the CURRENT runtime's stores at pass start — a latched re-run that fires after
// a logout→login must use the new SQLCipher handle, not the closed one.
let drainOutboxArgs: DrainOutboxArgs | null = null;
const drainOutboxPump = createRerunCoalescer(async () => {
  const a = drainOutboxArgs;
  if (!a || !a.isOurEpoch()) {return;}
  await drainOutboxPass(a.outbox, a.relay, a.isOurEpoch, a.reseal);
});

function drainOutbox(
  outbox: SqlOutboxStore,
  relay:  RelayHttpClient,
  isOurEpoch: () => boolean,
  reseal?: ResealDeferredFn,
): Promise<void> {
  if (!isOurEpoch()) {return Promise.resolve();}
  drainOutboxArgs = {outbox, relay, isOurEpoch, reseal};
  return drainOutboxPump();
}

async function drainOutboxPass(
  outbox: SqlOutboxStore,
  relay:  RelayHttpClient,
  isOurEpoch: () => boolean,
  reseal?: ResealDeferredFn,
): Promise<void> {
  const rows = await outbox.dueRows();
```

…and delete the now-orphaned `try {` opener plus the matching `finally` at the end of the function.

Anchor (lines 7525-7529, end of the function):

```ts
      }
    }
  } finally {
    drainOutboxInflight = false;
  }
}
```

Replace with:

```ts
      }
    }
}
```

(The body between `const rows = await outbox.dueRows();` and the closing `}` is **unchanged**,
including `if (rows.length === 0) {return;}` at `:7404` and the per-row `if (!isOurEpoch()) {return;}`
at `:7407` — both now return from the _pass_, and the pump's next iteration re-checks
`a.isOurEpoch()` before starting another one. De-indent the body by two spaces to match the removed
`try` level; that is the only whitespace churn.)

**Signature compatibility:** `drainOutbox` keeps its exact parameter list and `Promise<void>` return,
so the three call sites (`:1134`, `:1601`, `:1613`) need no edit. It becomes non-`async` (it returns
the pump's promise directly) — `void drainOutbox(...)` is still valid.

### F5 (small, recommended, same change) — don't leave the shared promise unhandled

`drainOutbox` can reject (`outbox.dueRows()` at the top of the pass is outside the per-row
try/catch), and all three call sites currently use bare `void`. Today that is already an unhandled
rejection; now the _same_ promise is shared by more callers, so attach a handler at each site rather
than leaving it to chance. `:1134`, `:1601`, `:1613` become:

```ts
void drainOutbox(sqlOutbox, relay, isOurEpoch, resealDeferredGroupRow).catch(e =>
  console.warn('[messenger.outbox] drain failed:', asErrorMessage(e)),
);
```

(`asErrorMessage` is already imported and used throughout this file; `console.warn` survives
`transform-remove-console`, and the message carries no body/key material so the `logAudit` gate is
unaffected.)

### Not needed

- **No schema/migration.** `outbox` table untouched; no `sqlOutboxStore.ts` change.
- **No wire field, no envelope-shape change, no AAD change, no server change.** Nothing about
  sender-cert verification, sealed-sender, group keys, dwell, ack/retract tokens or the vault MFA
  gate is touched. Old peers and the deployed relay are unaffected — this only changes _when_ the
  client re-issues requests it already makes.
- The audit's optional "abort in-flight drain fetches on 'connected'" is **deliberately out of
  scope**: `fetchWithTimeout` owns the `AbortController` and aborting mid-`relay.send` risks a row
  that the relay actually accepted being retried — safe (server dedups on `(recipient, clientMsgId)`)
  but it adds an abort-plumbing surface for no additional recovery guarantee once the latch exists.
  Propose as a follow-up only if device testing shows the 20 s deadline is the dominant delay.

## Blast radius

**Files**

- `src/modules/messenger/runtime/rerunCoalescer.ts` — new, ~45 lines, no imports, node-safe.
- `src/modules/messenger/runtime/productionRuntime.ts` — 4 hunks (import; `drainInflight` decl;
  `coalescedDrain`; `drainOutbox`), plus 3 one-line `.catch` additions if F5 is taken.

**Functions whose timing changes**

- `coalescedDrain` → callers `:1114` (WS `connected`), `:1448`/`:1467`/`:1470` (AppState resume),
  `:4560` (`pullEnvelopes`). `pullEnvelopes` is awaited by `ChatScreen.tsx:384`,
  `DepartmentChatScreen.tsx:200`, `fcmBootstrap.ts:302` and `:1598`. Their awaits can now last up to
  `MAX_COALESCER_RERUNS` extra passes — bounded, and only when a _real_ trigger arrived mid-pass.
- `drainOutbox` → callers `:1134`, `:1601`, `:1613`.
- `drainRelay` and the whole receive pipeline (`handleIncoming`, `seenEnvelopes`,
  `pendingGroupEnvelopes`, `pendingAdminActions`) are re-entered one extra time at most per latch —
  all of them are already idempotent (persistent `SeenEnvelopeStore` dedup, P0-N6) because the
  pre-existing pagination loop and the server's `flushPendingOnConnect` already replay envelopes.

**Overlapping findings**

- **OR-6** edits `productionRuntime.ts:1445-1470` to add `drainOutbox(...)` alongside the resume-path
  `coalescedDrain()`. Textually adjacent to F3's region, and it _increases_ the trigger rate into the
  outbox coalescer — OR-4 should land first or in the same commit, otherwise OR-6 adds two more
  swallow-able edges.
- **OR-2** (frozen timers) touches the `outboxRetryTimer` region `:1602-1615`.
- **OR-1** (background/WorkManager drain) would call `drainOutbox` from a second JS VM. The pump is
  per-VM module state — it gives **no** cross-process exclusion. Whatever OR-1 does must not rely on
  this latch for mutual exclusion.
- **XO-1 / OM-01** (stale sender-cert re-seal) edit the _body_ of what becomes `drainOutboxPass`
  (`isStoredCertStale` branch, `:7434-7469`). Pure textual conflict — the body is unchanged by OR-4
  apart from a two-space de-indent, which will make a same-region diff noisy. Sequence them.
- **SRV-01/GF-1** (relay throttle) — reruns add relay requests; if the throttle is being tuned in the
  same batch, size it after this lands.

**What could regress**

1. **Relay request amplification.** Worst case 3× the pulls/sends of today, and only while triggers
   keep arriving mid-pass. Server throttle is 30 req/10 s per user (code-level); a 3-pass chain is 3
   paginated pull sequences, well inside it.
2. **Longer `pullEnvelopes` await** delays the group-key self-heal that runs right after it
   (`ChatScreen.tsx:389-396`) and consumes more of the FCM handler's Doze budget
   (`fcmBootstrap.ts:302`, `:1598`). `MAX_COALESCER_RERUNS = 2` caps this at ~2 extra passes.
3. **Epoch safety.** A latch can only be armed by a caller that passed `isOurEpoch()`, and every pass
   re-checks it before doing work (`drainPump` first line; `drainOutboxPump` via
   `a.isOurEpoch()`), so a re-run cannot touch a post-logout store. This is _stricter_ than today,
   where `drainOutbox` had no top-level epoch gate at all.
4. **Cross-epoch stall (improved, not regressed).** Today a long stale-epoch `drainOutbox` blocks the
   new runtime's drain entirely (module-level boolean, no latch). After the fix the new runtime's
   call arms the latch and re-runs with the refreshed `drainOutboxArgs`.

## Tests

Jest project **`messenger-crypto`** (`testMatch: src/modules/messenger/__tests__/**/*.test.ts`),
mirroring `callResumeGuard.test.ts` / `outboxCertFreshness.test.ts`.

**New: `src/modules/messenger/__tests__/rerunCoalescer.test.ts`**

```
describe('OR-4 createRerunCoalescer')
```

1. _single-flight preserved_ — start a pass on a deferred promise, call the coalescer 3 more times
   synchronously; assert `run` has been called **once**, all 4 returned promises are the **same
   object**, and after resolving the deferred, `run` total = 2 (one latched re-run, not three).
2. _no trigger → no re-run_ — call once, let it settle, assert `run` called exactly once.
3. _latch coalesces N callers into 1 re-run_ — 5 mid-pass calls ⇒ exactly 2 total passes.
4. _bounded chain_ — a `run` that re-enters the coalescer on every pass ⇒ `run` called exactly
   `MAX_COALESCER_RERUNS + 1` (3) times, and the returned promise settles (no hang, no infinite loop).
5. _failure still honours the latch_ — pass 1 rejects, a mid-pass trigger was latched ⇒ pass 2 runs;
   if pass 2 resolves, the shared promise **resolves** (the recovery succeeded).
6. _last-pass failure propagates_ — pass 1 resolves, latched pass 2 rejects ⇒ shared promise rejects
   with pass 2's error.
7. _lone failure propagates_ — single pass rejects, no latch ⇒ rejects with that error (proves the
   existing `[bravo.pullEnvelopes] drain failed` warn path is preserved).
8. _slot released before the rejection is observed_ — attach `.catch(() => coalescer())` to a
   rejecting pump and assert the handler's call starts a **new** pass (`run` called again) rather than
   returning a dead promise.
9. _state resets between cycles_ — settle a latched chain, then call again; assert a fresh pass starts
   and the rerun counter restarts (no leaked `rerunRequested`).

**Regression suites to run**

- `npm run test:crypto` (whole `messenger-crypto` project) — this is the mandated regression for
  anything in `productionRuntime.ts`. Specifically watch `bootGroupStashDrain.test.ts`,
  `archiveReplayDrain.test.ts`, `outboxCertFreshness.test.ts`, `sqlOutboxStore.test.ts`,
  `undeliverableResend.test.ts`, `firstMessageDrop.test.ts`, `logAudit.test.ts`.
- `npm test` (all projects) before declaring done.
- `npm run typecheck` — must stay ≤ 47 (`.tsc-baseline.json`). The new file introduces no errors;
  the `drainOutbox` return-type change from `async …: Promise<void>` to `…: Promise<void>` is
  type-identical at all three call sites.

**Device probe (the check that actually proves OR-4)** — no automated substitute exists:

- Queue 3-4 messages while airplane-mode/dead-Wi-Fi so a `drainOutbox` pass is mid-flight burning
  20 s deadlines; toggle Wi-Fi off to force the Wi-Fi→LTE handover; watch logcat for a **second**
  `[messenger.outbox] draining N row(s)` line within a couple of seconds of the reconnect instead of
  at the next 60 s tick, and for the bubbles flipping to `sent` in ≲5 s rather than ≲140 s.
- Receive lane: with a slow/black-holed route, background→foreground and immediately open a chat;
  confirm the thread fills without needing a second foreground cycle.

## Risk

Things a reviewer should be suspicious of, in order:

1. **Is the re-run chain genuinely bounded?** The loop is `for (pass = 0; pass <= maxReruns; pass++)`
   with `rerunRequested` cleared at the _top_ of each pass. A trigger during pass _k_ only ever buys
   pass _k+1_. Verify test #4 asserts an exact call count, not just "≥2".
2. **The 1 s backoff can make an immediate re-run a no-op.** `recordAttempt` pushes
   `next_retry_at = now + BACKOFF_MS[0] = now + 1000` (`sqlOutboxStore.ts:236-243`), so a re-run that
   starts <1 s after the last recorded failure sees `dueRows() === []`. This is benign (the pass is a
   single cheap SELECT) and does **not** hit the main scenario — a doomed pass over a dead route
   takes ≥20 s per row, so by the time it ends every row it touched is long past its retry time. But
   if the doomed pass was _short_ (instant offline rejection), the fix buys nothing and the 60 s tick
   still governs. Do not claim OR-4 fixes the fast-fail-offline case; it fixes the black-holed-route
   case, which is the handover case the finding describes. A follow-up (out of scope) would be to
   have the re-run pass compute `dueRows(Date.now() + 1500)` — rejected here because it would also
   defeat backoff for genuinely server-rejected rows.
3. **`drainOutboxArgs` is last-writer-wins module state.** A pass that has already started keeps the
   args it read at pass start (`const a = drainOutboxArgs` before the first await), so a concurrent
   overwrite cannot swap the store out from under an in-flight pass — but confirm that read is
   _before_ the await, not inside `drainOutboxPass`.
4. **Rejection semantics changed.** A pass-1 failure followed by a successful re-run now **resolves**
   where the old code rejected. That is intended (the caller's question is "did the drain eventually
   work?"), but it means `[bravo.pullEnvelopes] drain failed` warnings will get _rarer_, which could
   be mistaken for the log going silent. Say so in the commit message.
5. **`throw` placement relative to `finally`.** `inflight` must be nulled before the rejection is
   delivered, otherwise a `.catch(() => coalescedDrain())` handler would re-receive the dead promise.
   Test #8 covers exactly this; do not "simplify" the pump by moving the throw inside the `try`.
6. **Removing `let drainInflight` at `:732`.** Confirm with `grep -n 'drainInflight'` that the
   declaration and all five references disappear together — a stray reference would typecheck-fail,
   but a _re-added_ one during conflict resolution with OR-6 would silently reintroduce the old
   swallow.
7. **This is per-JS-VM state only.** It is not a cross-process lock and must not be sold as one when
   OR-1's background drain is designed.
8. **Security surface: none.** No check is weakened or bypassed; `verifySenderCert`,
   `verifySealedAad`, the B-42 epoch guard, `isStoredCertStale` re-seal, `seenEnvelopes` dedup and
   the sealed-sender envelope shape are all untouched. No new logging of bodies, ids or key bytes.
   The only new observable behaviour is "the client re-issues a request it was already entitled to
   make, sooner".
