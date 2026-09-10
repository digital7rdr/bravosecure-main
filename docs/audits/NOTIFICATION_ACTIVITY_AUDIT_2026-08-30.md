# Activity / Notification Centre — reliability audit (B-706)

**Date:** 2026-08-30 · **Trigger:** founder report — _"the notification things it is not working
perfectly… it is not real time. And I delete the notification, again it came back."_
**Method:** 4 parallel auditors (real-time lane · delete/resurrection lane · edge cases · server)
→ 1 adversarial critic. Every load-bearing claim re-verified by hand against source **and against
the live Supabase database**.

**Verdict: the founder is right on both counts, and neither symptom is what it looks like.**
The feed is not _stale_ — it is **inverted**. The deletion does not _fail_ — there is **no
deletion**, on either side of the wire. Nine defects are P0/P1.

---

## 0. The screenshot, explained

The nine rows the founder photographed, all labelled `50d`, are **his own account rendered
oldest-first**. Matched against the live DB (`user 79d63649…`, 65 rows):

| #   | Screenshot row            | `ORDER BY created_at ASC`           |
| --- | ------------------------- | ----------------------------------- |
| 1   | Booking approved · 50d    | `booking-approved` 2026-07-10 (51d) |
| 2   | No agency available · 50d | `no-provider` 2026-07-10 (51d)      |
| 3–5 | Booking approved ×3 · 50d | `booking-approved` ×3 2026-07-10    |
| 6   | Agency accepted · 50d     | `provider-accepted` 2026-07-10      |
| 7   | Crew assigned · 50d       | `crew-assigned` 2026-07-10          |
| 8   | Mission complete · 50d    | `booking-completed` 2026-07-10      |
| 9   | Booking approved · 50d    | `booking-approved` 2026-07-10       |

Exact sequence match. **His newest notification is 5 days old and sits at the bottom of a 65-row
list.** Everything above it is July. That single fact is the whole "not real time" complaint.

### Live database state (queried 2026-08-30)

| Metric                                                         | Value                       | Meaning                                                              |
| -------------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------- |
| Total rows                                                     | 500 across 52 users         | inbox is being written correctly                                     |
| **Unread**                                                     | **467 (93 %)**              | nothing ever marks read server-side → **A-3**                        |
| Older than 30 days                                             | **215 (43 %)**              | the promised retention sweep was never written → **A-6**             |
| Oldest row                                                     | 2026-07-09 (52 d)           | ditto                                                                |
| **Rows whose `created_at` exceeds its own ms-truncated value** | **500 / 500 (100 %)**       | **every user's newest row re-delivers on every sync, forever → A-2** |
| `booking-approved` count vs distinct `booking_id`              | **1 : 1 for every account** | server duplication **REFUTED** — the dupes are client-side (**A-4**) |

---

## 1. Findings

| ID      | Sev    | Defect                                                                                                           | Symptom the founder sees                           |
| ------- | ------ | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **A-1** | **P0** | Feed renders **oldest-first**                                                                                    | "it's showing 50-day-old stuff / it never updates" |
| **A-2** | **P0** | Watermark is ms-truncated vs a µs column → newest row re-delivered every sync                                    | "I delete it and it comes back"                    |
| **A-3** | **P0** | `Clear` is local-only; **no delete/dismiss exists server-side**; the only synced mark-read sits in **dead code** | deletions never stick; badge stays lit             |
| **A-4** | **P0** | Live FCM row and backfill row use **two id keyspaces** → every event lands twice                                 | duplicate-looking rows, badge reads 2N             |
| **A-5** | **P1** | Killed-app wakes record **no** row                                                                               | banner appears, app shows nothing                  |
| **A-6** | **P1** | No retention sweep despite the schema promising 30 days                                                          | 43 % of the inbox is >30 d old                     |
| **A-7** | **P1** | Most classes ship at FCM **`priority: 'normal'`**                                                                | genuinely late delivery                            |
| **A-8** | **P1** | No token refresh / no retry — a 401 or blip silently freezes the feed                                            | feed randomly stops updating                       |
| **A-9** | **P1** | Unknown-route taps are **silent no-ops in release**; `sos-cpo-alert` is a dead tap in the agent shell            | tapping a notification does nothing                |
| A-10    | P2     | Relative-time labels never tick                                                                                  | "50d" stays "50d"                                  |
| A-11    | P2     | `ActivityCenterScreen` never syncs on open (no focus effect, no pull-to-refresh)                                 | must background/foreground to refresh              |
| A-12    | P2     | `since` + `LIMIT 100` permanently orphans a >100-row backlog                                                     | silently missing notifications                     |
| A-13    | P2     | 17 kinds carry no routable id → guaranteed dead taps                                                             | tapping does nothing                               |
| A-14    | P2     | `CountdownPill` interval never cleared at zero                                                                   | "Expires in Expired", timer leak                   |
| A-15    | P2     | 200 unvirtualised rows in a `ScrollView`                                                                         | jank on open (the known Slow-UI-thread class)      |
| A-16    | P2     | Unread state is colour-only — no a11y label                                                                      | screen-reader users cannot tell read from unread   |

---

### A-1 · P0 · The feed is rendered oldest-first

- Server returns newest-first — `apps/auth-service/src/notifications/notifications.service.ts:90`
  (`ORDER BY created_at DESC`).
- Client iterates that page in order — `src/store/activitySync.ts:144`.
- `append()` **prepends** — `src/store/activityStore.ts:79` (`[next, ...state.rows]`).
- Neither surface sorts — `src/screens/activity/ActivityCenterScreen.tsx:169` (`rows.map`).

Each prepend reverses the page. Reproduced:

```
server (DESC): n5 n4 n3 n2 n1   →   rendered: n1 n2 n3 n4 n5   (oldest at top)
```

The live-mixed steady state is worse: each incremental batch is internally reversed while batches
stay newest-batch-first, and correctly-prepended live FCM rows sit among them — the feed is
genuinely scrambled, not merely reversed.

**Why it survived review:** `activitySync.test.ts:31` mocks `append` with `jest.fn()`, so ordering is
never exercised; `activityStore.test.ts:15` pins "newest first" only for two _sequential live_
appends — the opposite traversal.

### A-2 · P0 · Microsecond truncation re-delivers the newest row on every sync, forever

`created_at` is `timestamptz` precision **6** (microseconds). The wire value is truncated to
milliseconds twice over:

1. `pg-types` maps OID 1184 to `postgres-date`, which computes `1000 * parseFloat('.090116')` =
   `90.116` and lets `Date.UTC` **truncate** to `90` (a JS `Date` is ms-only; no `setTypeParser`
   exists anywhere in `apps/auth-service`).
2. `notifications.controller.ts:47` — `.toISOString()` emits exactly 3 fractional digits.

The client then stores that verbatim as the next `since` (`activitySync.ts:161-165`) and the server
filters `created_at > $since` (`notifications.service.ts:81`).

Verified against the founder's own newest row:

```
stored            2026-08-25 11:16:02.090116+00
API emits         2026-08-25 11:16:02.090
stored > emitted  TRUE      ← returned again on every sync, forever
```

**Fleet-wide: 500 / 500 rows.** The direction is safe (truncation can never _skip_ a row), so this is
not data loss — it is a permanent re-append. Harmless while the row is still on screen, because
`append` dedupes by id. **Fatal the moment the user presses Clear:** the row is gone locally, the
watermark still points below it, and the next `AppState: 'active'` puts it straight back — unread.

### A-3 · P0 · There is no deletion, and the only synced read-marker is dead code

- `notifications.controller.ts` exposes **only** `@Get()` and `@Post('read')`. No `@Delete`, no
  dismiss. Live DDL has **no `dismissed_at` / `deleted_at`** column.
- `activityStore.ts:95` — `clear: () => set({rows: []})`. Local zustand only.
- `activityStore.ts:94` — `remove(id)` has **no production caller**; there is no per-row delete
  affordance anywhere. Clear-everything is the only option the user has.
- `markAllActivityReadSynced` (`activitySync.ts:170`) — the only writer of
  `POST /me/notifications/read` — is called **only** from
  `src/screens/dashboard/DashboardScreen.tsx:229`, and **that file is imported by nothing.** The
  navigators mount `AgentDashboardScreen` / `ProDashboardScreen` / `OpsDashboardScreen`; this one is
  unreachable.
- `ActivityCenterScreen.tsx:62,111` uses the **local-only** `markAllRead` / `markRead`.

So in production `read_at` is **never set**. The live DB agrees: **467 of 500 rows unread (93 %)**.
Every resurrection therefore arrives unread and relights the bell.

**What the server believes after a Clear: nothing changed.** The client's delete is invisible to the
only authority in the lane.

### A-4 · P0 · Two id keyspaces — every non-`enterprise` event lands twice

- Live FCM row id = `data.eventId` — `serverWakeNotifications.ts:219` — minted as
  `crypto.randomBytes(16).toString('base64url')` (`booking-push-bridge.service.ts:65`).
- Backfill row id = the table's `gen_random_uuid()` PK — `activitySync.ts:149`.
- Dedupe is `r.id === row.id` only (`activityStore.ts:75`) — the keyspaces provably never collide,
  because the `notifications` table has **no `event_id` column**.

**The code documents its own defect** at `serverWakeNotifications.ts:207-215`: _"two id keyspaces
that never collide, so every wake produced a SECOND identical bell row on the next sync and the
badge read 2N for N requests… The double-row mechanism is repo-wide."_ Only `enterprise.*` was
mitigated — by suppressing the local row entirely (`:214`).

**Important correction to the first read of the screenshot:** the founder's four "Booking approved"
rows are **four genuinely different bookings** (live DB: `booking-approved` count equals distinct
`booking_id` for _every_ account — server duplication is REFUTED). They are indistinguishable
because the row renders only `KIND_META[kind]` — a fixed title and subtitle with no booking
reference (`activitySync.ts:45`). So there are **two** problems here: a real duplication mechanism
(A-4) _and_ rows that carry nothing to tell legitimate siblings apart.

### A-5 · ~~P1~~ → **P3 · WILL NOT FIX — the obvious fix arms a data-loss bug**

`fcmHeadless.ts:463` calls `showServerWakeNotification(data)` with **no** `{recordActivity: true}`;
both record sites (`serverWakeNotifications.ts:308,417`) are gated on that flag. The fact is
confirmed. **The fix is not "pass the flag."**

The critic pass proved the existing rationale correct: `zustand/middleware.js:335-338` defaults
`merge` to `{...currentState, ...persistedState}` and `:421` calls `set(stateFromStorage, true)` —
a **replace**. An `append` landing before `getItem` resolves is silently discarded. Worse, the
debounced adapter captures `pendingValue` at `setItem` time, so if the headless `getItem` lost that
race the 500 ms flush would write `{ownerKey: null, rows: [<the one wake row>]}` — **wiping the
user's entire persisted feed and its owner key**. That is unreachable today only because nothing in
the headless lane touches the store; passing the flag arms it.

Real severity is low: the row is not lost. `BookingPushBridge.publish()` writes the durable row
unconditionally (`booking-push-bridge.service.ts:92-105`, deliberately outside the Redis try), so the
next foreground sync backfills it. The defect is latency-to-the-bell — and it is now the deliberate
behaviour of **every** class after the A-4 fix.

### A-6 · P1 · The 30-day retention sweep was never written

`supabase/migrations/20260727210000_notifications_inbox.sql:44-49` promises _"a cheap opportunistic
sweep on insert-heavy paths"_ and the table `COMMENT` claims _"30-day intended retention"_. There is
**no `DELETE FROM public.notifications` anywhere in `apps/auth-service/src`** and no `pg_cron`. Live:
215 of 500 rows (43 %) are older than 30 days; the oldest is 52 days. This is what a fresh install
pulls down and — thanks to A-1 — puts at the **top**.

### A-7 · P1 · Most classes ship at FCM `priority: 'normal'`

`apps/messenger-service/src/push/push.service.ts:276-278` marks only `sos` / `dispatch` / `incident`
high-priority; `:425` sends everything else `priority: 'normal'`.

**Corrected by the critic pass:** "normal priority ⇒ not real time" is overstated. A foregrounded app
on an awake device holds a live FCM socket, and normal-priority delivery there is prompt; the deferral
bites only in Doze, background, and low App-Standby buckets. But the auditor _understated_ the actual
harm — `:426` sets `ttl: 10 * 60 * 1000`, so a normal-priority wake deferred past a Doze maintenance
window beyond 10 minutes is **discarded by FCM**. The banner never appears at all. (The bell row still
backfills; the notification does not.) `collapseKey` is per-event, so nothing is lost to collapsing.

Blanket `'high'` is **not** the fix: `payout-settled`, `*-hour-checkin` and `enterprise.*` are not
time-critical, and over-using high priority costs App-Standby quota for the classes that are.

### A-8 · P1 · No token refresh, no retry, silent failure

- `tokenVault.getAccess()` returns the cached token with **no expiry check and no refresh**
  (`tokenVault.ts:300`); access TTL is 15 min.
- `activitySync.ts:138` — `if (!res.ok) {return;}`. No 401 branch, no retry, no log.
- This module uses raw `fetch`, bypassing the axios 401-refresh interceptor. Every sibling in this
  family has the refresh ladder (`serverWakeNotifications.ts:61,70`, `headlessDrain.ts:178`,
  `pendingActions.ts:127`, `backupClient.ts:98`) — `activitySync.ts` is the only one without it.

### A-9 · P1 · Dead taps are silent in release, and one is safety-relevant

`@react-navigation/core`'s `defaultOnUnhandledAction` **returns early when
`process.env.NODE_ENV === 'production'`** — an unknown route is a silent no-op with no log, and the
`try/catch` around every `navigation.navigate` in `ActivityCenterScreen.tsx:133-144` is decorative.
That is exactly why this passes dev testing.

| Route              | AgentNavigator | BookingNavigator | CpoNavigator       |
| ------------------ | -------------- | ---------------- | ------------------ |
| `ActivityCenter`   | ✅ `:350`      | ✅ `:316`        | ❌ **absent**      |
| `AgentLiveTracker` | ✅ `:170`      | ❌               | (`CpoLiveTracker`) |
| `SOSScreen`        | ❌             | ✅ `:230`        | ❌                 |
| `LiveTracking`     | ❌             | ✅ `:225`        | ❌                 |
| `OpsRoomReview`    | ❌             | ✅ `:245`        | ❌                 |

In the **agent/agency shell**, `sos-cpo-alert` (class `sos`, carries `bookingId`) routes to
`SOSScreen` at `ActivityCenterScreen.tsx:134` → not registered → **tapping an SOS crew alert does
nothing.** The `missionId` branch that would have worked is one line later, at `:135`.
The **CPO shell registers no `ActivityCenter` at all** — that persona has no durable notification
surface whatsoever.

### A-10 → A-16 (P2)

- **A-10** `relTime` (`ActivityCenterScreen.tsx:35`) is a plain render-time function with no
  interval. Labels only change when the row set changes. Duplicated verbatim as `relNotifTime`
  at `DashboardScreen.tsx:1194` (the duplicate-copy class).
- **A-11** `ActivityCenterScreen` has no `useFocusEffect`, no `RefreshControl`, and does not import
  `syncActivityFromServer`. Opening the bell refreshes nothing. With the drawer dead (A-3), the only
  automatic refresh in the entire app is boot + `AppState: 'active'`.
- **A-12** The server returns the **newest** `LIMIT 100` of the matching set and the client advances
  the watermark to the max received (`activitySync.ts:161`) — rows 101+ of a backlog are never
  requested again. Latent today (max 65 rows/user); arms at 101.
- **A-13** 17 kinds (`agent-*`, `pro-*`, `psession-*`, `family-*`) carry only an
  `applicationId`/`sessionId`/`inviteId`, none of which has a column on `notifications`, so the row
  falls through every branch of `onRow`. `psession-sos` is the worst: an SOS row that opens nothing.
- **A-14** `CountdownPill.tsx:20` runs a 1 s `setInterval` never cleared at zero; renders
  "Expires in Expired" and leaks a per-second timer for the life of the feed.
- **A-15** `ActivityCenterScreen.tsx:162` is a `ScrollView` over up to `MAX_ROWS = 200` rows
  (~1200 views in one commit) — the measured Slow-UI-thread class from `CLAUDE.md`.
- **A-16** `ActivityRow.tsx:40` renders unread as a bare tinted `View` with no `accessibilityLabel`
  or `accessibilityState`.

---

## 2. Checked and explicitly FINE — do not "fix" these

| Checked                                    | Verdict                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server-side duplicate rows                 | **REFUTED with live data** — `booking-approved` count equals distinct `booking_id` for every account. `ops.service.ts:337-365` guards with `SELECT … FOR UPDATE` + FSM assert; the two `bookingApproved` call sites are mutually exclusive branches.                                                        |
| `pg` returning a non-ISO date string       | **REFUTED** — no `setTypeParser` in `apps/`; OID 1184 maps to `postgres-date`, which returns a real `Date`, so `controller.ts:47` takes the `instanceof Date` branch. The `String()` fallback is a latent landmine (Hermes would yield `NaNd`), not a live bug. **Not** the cause of "50d" — A-6 + A-1 are. |
| Index on `(user_id, created_at DESC)`      | **PRESENT** live as `idx_notifications_user_created`. No full-scan-per-sync.                                                                                                                                                                                                                                |
| Auth scoping / IDOR                        | **CLEAN** — all three service methods predicate on `user_id = $1` from `req.user.sub`; RLS on, SELECT-only self policy.                                                                                                                                                                                     |
| auth-service push ↔ durable-row parity     | **COMPLETE** — all ~48 bridge methods funnel through one `publish()`, which records **outside** the Redis try/catch, so a Redis outage still writes the row.                                                                                                                                                |
| `startActivitySync` `started` flag         | **Correct** — flag-guarded against duplicate listeners; `stopActivitySync` clears flag and listener together.                                                                                                                                                                                               |
| Per-user watermark key (MOB-6)             | **Correct**, and pinned by `activitySync.test.ts`.                                                                                                                                                                                                                                                          |
| Debounced-persist ordering race            | **REFUTED** — the last `setItem` always supersedes (`debouncedJsonStorage.ts:99-102`). The residual risk is a _lost_ write inside the 500 ms window, not an out-of-order one.                                                                                                                               |
| Device clock skew corrupting the watermark | **No** — the watermark only ever compares server `createdAt` values.                                                                                                                                                                                                                                        |
| Duplicate React keys from the A-4 twins    | **No** — the two twins have genuinely different ids.                                                                                                                                                                                                                                                        |
| `MAX_ROWS = 200` evicting unseen rows      | Fine at today's `limit=100`. Note the cap is applied _after_ the (inverted) prepend, so raising `limit` past 200 would start dropping the **newest** rows first.                                                                                                                                            |
| fontScale ≥ 1.3 overflow on rows           | Fine — bounded `numberOfLines`, `flex: 1` title, ≤4-char time label.                                                                                                                                                                                                                                        |
| Messenger pushes have no durable row       | **By design, not a defect** — `20260727210000…sql:13-17`: a messenger inbox "would leak the very sender→recipient metadata sealed sender exists to hide." Consequence worth naming: **a missed call or message can never appear in Activity.** That is an architecture decision, not a bug.                 |

---

## 3. Root cause, in one sentence

**`Clear` mutates a cache that the code treats as the record:** there is no dismissal state on either
side of the wire, the only reconciliation cursor is both blind to the live push lane _and_
systematically rounded below the row it just read, and the reconciled result is then rendered in
reverse. So the feed's steady state is "whatever the server has, upside-down", and any local
deletion survives only until the next `AppState: 'active'`.

---

## 4. Deferred / out of scope

- **A-13 routing targets** for the 17 idless kinds need product decisions (and, for `pro-*` /
  `psession-*` / `family-*`, new columns on `notifications`). Logged, not fixed here.
- **Messenger events in the Activity feed** — architecture-gated by the sealed-sender posture.
- **A-15 virtualisation** — worth doing, but it is the known lag class and should be measured, not
  guessed (CLAUDE.md standing rule).

---

## 5. Fix log — what shipped this session

| ID                        | Status                                | Change                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A-1**                   | **FIXED**                             | Ordering is now an invariant of the store. `mergeRows()` dedupes by id, sorts `ts` DESC, and caps **after** the sort (the old cap ran inside the prepend and could evict rows _newer_ than ones it kept). `syncActivityFromServer` commits a page with one `appendMany()` instead of N prepends. `onRehydrateStorage` re-sorts the already-scrambled feed every existing install has on disk. |
| **A-2**                   | **FIXED — migration not yet applied** | Migration `20260830120000` truncates `created_at` to milliseconds (column DEFAULT + one-time UPDATE) so `stored == emitted`; `list()` moves to `>=`. Both originally-proposed alternatives were rejected with proof — see below.                                                                                                                                                              |
| **A-3**                   | **FIXED — migration not yet applied** | `dismissed_at` column + `POST /me/notifications/dismiss` + `AND dismissed_at IS NULL` in `list()`. Client `Clear` routes through `clearActivitySynced()`, and a capped local tombstone ledger makes an **offline** clear stick too. `ActivityCenterScreen` now calls the _synced_ mark-all-read.                                                                                              |
| **A-4**                   | **FIXED**                             | The durable inbox is the single minter. `recordActivityForWake` no longer appends a locally-keyed row; it calls `scheduleActivitySync()` (1.5 s debounce, because `publish()` sends the wake _before_ the INSERT). The `enterprise.*` special-case is gone — it is now the rule for every class.                                                                                              |
| A-5                       | **WILL NOT FIX**                      | See above — passing the flag arms a persisted-feed wipe.                                                                                                                                                                                                                                                                                                                                      |
| **A-6**                   | **PARTIAL**                           | Sampled retention sweep added to `NotificationsService`, off the fan-out's await path. The **one-time purge of the 215 already-stale rows is deliberately not automated** — it destroys live data across 52 accounts. Command is in the migration header.                                                                                                                                     |
| **A-7**                   | **FIXED**                             | `booking` and `mission` join the high-priority set. Deliberately not blanket.                                                                                                                                                                                                                                                                                                                 |
| **A-8**                   | **FIXED**                             | `authedFetch()` gives the sync the same 401-refresh-and-retry ladder every sibling already had (lazy `require`, like the siblings, to keep axios/supabase off this module's graph).                                                                                                                                                                                                           |
| **A-9**                   | **FIXED**                             | Tap routing resolves candidates against the mounted tree via `findNavigatorWithRoute` and takes the first that exists, so an `sos-cpo-alert` in the agent shell no longer dead-ends on the unregistered `SOSScreen` one line before the branch that would have worked. Unresolvable rows now `console.warn` instead of failing silently.                                                      |
| **A-10**                  | **FIXED**                             | `relTime(iso, now)` takes the clock as a parameter; a focus-scoped 60 s tick drives it. An unparseable `ts` renders `—`, not `NaNd`.                                                                                                                                                                                                                                                          |
| **A-11**                  | **FIXED**                             | `useFocusEffect` sync + `RefreshControl`, both behind an in-flight ref.                                                                                                                                                                                                                                                                                                                       |
| **A-12**                  | **FIXED (server half)**               | `limit` is coerced before clamping, so `?limit=abc` no longer yields `LIMIT NaN` → `22P02` → an empty feed behind a 200. The >100-row backlog paging remains **OPEN**.                                                                                                                                                                                                                        |
| A-13 · A-14 · A-15 · A-16 | **OPEN**                              | Deferred — see §4. A-13 needs product decisions and new columns.                                                                                                                                                                                                                                                                                                                              |

### Two fixes that were proposed, proven wrong, and rejected

The adversarial critic killed both watermark designs originally recommended:

- **`to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS.USOF')`** — `OF` emits `+00`, and
  `new Date('2026-08-25T11:16:02.090116+00')` is **`Invalid Date`** in JS. Every row's label would
  render `NaNd`, on new _and_ old clients. It also silently breaks the client's **lexicographic**
  watermark compare (`'Z'` 0x5A > `'1'` 0x31), stalling the cursor for every user mid-upgrade.
- **A `bigserial` cursor** — sequence values are assigned at INSERT but transactions **commit out of
  order**, so a reader can see seq 105 before 104 commits, advance past it, and **permanently skip
  104**. That converts today's _safe over-return_ into real data loss.

Truncating the column keeps the wire format byte-identical, needs no client change, and has no
old-client hazard in either deploy direction.

### Verification

| Gate             | Result                                                                                                                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New pins         | `activityFeedOrdering` (4) — **RED before, green after**; `activityDismissTombstone` (7) — **4 go RED under mutation**; `notifications.dismiss.spec` (8) — **2 go RED under mutation** |
| Re-pointed pin   | `activityCenterWiring` — the wake-row assertion was **re-pointed, not deleted** (it went RED first, proving it was load-bearing)                                                       |
| Messenger gate   | `messenger-crypto` **569 suites / 7086 tests green, run twice** (B-126 flake rule); app-project `screens/messenger` **54 suites / 740 green**                                          |
| Full app project | **238 suites / 3257 green**                                                                                                                                                            |
| Typecheck        | mobile **46** (baseline 47); `auth-service` **0**; `messenger-service` **0**                                                                                                           |

### Owed before this is done

1. ~~Apply migration `20260830120000`~~ — **DONE 2026-08-30.** Verified live: `dismissed_at`
   present, `created_at` DEFAULT is `date_trunc('milliseconds', now())`, rows whose stored value
   exceeded its own ms-truncation went **500 → 0**, all 500 rows preserved, 0 rows dismissed
   (no back-fill), partial index `notifications_user_active_idx` created. The A-2 loop is proven
   dead: the founder's newest row now stores `…02.09+00` and the API emits `…02.090Z` — identical,
   so the strict `>` that used to re-deliver it returns 0 rows.
2. ~~Deploy `auth-service` and `messenger-service`~~ — **DONE 2026-08-30** (manual tar flow;
   `rsync` is absent on Windows/Git Bash). Both containers **healthy**; the new code was verified
   **inside the running containers**, not just on disk: `dismissed_at` ×5, `dismissAll`,
   `created_at >= ` and `maybeSweepRetention` in `auth-service` dist; `eventClass === 'booking'`
   and `'mission'` in `messenger-service` dist. Nest mapped `{/me/notifications/dismiss, POST}`;
   the route answers **401** (present + guarded), not 404. Watchdog pristine snapshot refreshed
   and confirmed to contain the new code.
3. **Device pass** on the founder's own account — founder standing rule: not fixed until seen in a
   post-install device log.
4. ~~Decide on the one-time purge~~ — **DONE 2026-08-30, founder-authorised.** 215 rows deleted,
   **500 → 285**; oldest row went from **52 days to 30**. Pre-flight confirmed 0 inbound FKs and a
   clean boundary (newest deleted 2026-07-30 19:48, oldest kept 2026-07-31 20:34). Run OUT OF BAND,
   deliberately not inside the migration, so replaying that file elsewhere cannot destroy data.
   The sampled sweep in `NotificationsService` now holds the line.

> **APK HELD.** The founder has asked that the app build NOT be released until they say so
> (2026-08-30). The server side is fully deployed and backward-compatible, so the current build in
> the field is unaffected — it simply does not dismiss yet. Every client-side fix (A-1 ordering,
> A-3 tombstones, A-4 single minter, A-8..A-11) reaches the founder only in that build.
