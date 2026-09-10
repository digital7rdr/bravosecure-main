# Backup — deferred Merkle commit ("the WhatsApp shape")

**Status:** PLAN, **Rev 4** — after two critic rounds (R1: DISAGREE, 4×P0, all verified and accepted
→ Rev 2 reversal; R2: DISAGREE, no P0, 4×P1 + 4×P2 + a ceiling call → Rev 3; R3: DISAGREE, 1×P0 in
W3 itself — the landing site — + 3×P1). Not built.
**Trigger files:** `messageMirror.ts`, `authStore.ts`, `ChatScreen.tsx`, `DepartmentChatScreen.tsx`
(+4 route registrations across 3 navigators) → **BACKUP_LOOP.md applies in full.**
**Founder ask (2026-08-22):** "instead of the current approach can we do something like WhatsApp —
when the user clicks back, then it will back up."

> **Rev 1 → Rev 2 was a REVERSAL** (defer the signature only, never the upload). **Rev 2 → Rev 3** is
> a tightening: ceiling 45 s → **15 s**, sign-out closed as a second entrance, and three pins that
> did not exist. **Rev 3 → Rev 4** moves W3 to the only place it can work, widens B-632 to BOTH
> queues, and SPLITS the build so the bug fix ships without waiting on the measurement.
> §11 records everything rejected so it is not re-litigated.

---

## 1. The problem, and the honest state of the premise

The Merkle commit page-walks the server backup, hashes every leaf and signs — every 5 s during a
burst (`MERKLE_DEBOUNCE_MS`, `messageMirror.ts:62`).

**The premise is weaker than Rev 1 claimed and is NOT yet measured.** B-310 already made the hashing
yield (`computeMerkleRootYielding`, `backupMerkle.ts:110-129`, a macrotask yield per 100 rows) and
`merkleCommit.ts:247` already yields between pages. The remaining synchronous cost is each page's
`res.json()` (~1.4 MB parse) plus walk latency. **§10 is therefore a hard gate, not an open
question.**

## 2. The change — defer the SIGNATURE only

Upload path **byte-untouched** (1.5 s flush). Four edits:

| #   | Edit                                                                                                                                                                                                             | File                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| W1  | `MERKLE_DEBOUNCE_MS` 5 s → **15 s** — the fallback ceiling, not the normal path                                                                                                                                  | `messageMirror.ts:62`                                      |
| W2  | Leaving a chat/channel fast-forwards a **pending** commit via `void fireMerkleHookNowIfPending()` — the EXPORTED form of B1's gate                                                                               | shared hook, used by `ChatScreen` + `DepartmentChatScreen` |
| W3  | **Sign-out closes its own window:** bounded best-effort `drainMirrorOutbox()` + gated fast-forward — placed **immediately before `authApi.signOut(deviceId)`** (`authStore.ts:686`), NOT next to `disposeMirror` | `authStore.ts:~684`                                        |
| W4  | Tests (§7) + doc updates (§8)                                                                                                                                                                                    | tests, `BACKUP_LOOP.md`                                    |

⚠️ **Do NOT export `merkleHookDebounce`** (R4-P1-1). It is a module-private `let` (`:57`) with six
internal readers; exporting it to inline the gate would make a mutable timer handle public API and
the next external `clearTimeout` would silently break B1. `fireMerkleHookNowIfPending()` (`:102-105`)
is already exactly that gate.

`scheduleMerkleHook` / `merkleHookDebounce` **stay** — six live readers depend on the variable
(`:68`, `:86`, `:103`, `:196`, `:275`, `:301`). Deleting it was Rev 1's P0-1.

### 2.1 Why it wins, and where the win actually comes from

`scheduleMerkleHook` arms once and does **not** extend (`:67`), so a sustained burst mints a commit
every 5 s today. But **the ceiling is not the win** — B1 (background) and B2 (leaving a chat) are,
and B2 _is_ the founder's literal repro. The ceiling only serves someone who never leaves the screen,
never backgrounds, and types past 15 s. That is why 15 s, not 45 s (§5, R2-Q4).

### 2.2 The gate is self-limiting (R2-Q2, verified)

Every fire requires a **fresh flush** to have re-armed the slot (`:672`). Once fired, the gate is
false until the next upload. So B2 can never mint more commits than today's cadence, and browsing
five chats costs at most one commit — and only if one was already owed. This is asserted in §7.2.

### 2.3 Why the upload must NOT move (R1-P0-3, verified in code)

`mirrorRemoval` (`:481-523`) queues a **synthetic** tombstone; the SQL row is already gone
(`messengerStore.ts:570-572`), so `backupNow`'s `loadAll()` cannot re-derive it, and `markDirty`'s
BUG-3 note forbids manufacturing one. `disposeMirror` (:270) and `resetMirrorForWipe` (:296) do
`queue.length = 0`. Deferring uploads ⇒ delete a message, sign out, **the next restore resurrects
it** — B-594/B-605 reverted by a scheduling change.

## 3. Boundaries

| #      | Trigger                   | Status                                                                                                                                                                                                                                                                                                                                   |
| ------ | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1     | App → background/inactive | **Exists** (`:196`). Untouched.                                                                                                                                                                                                                                                                                                          |
| B2     | Leaving a chat/channel    | **New (W2).** `useFocusEffect` cleanup (**blur**), not `beforeRemove` — the latter misses tab switches and `navigation.reset` product switches. Wired in the **component**, not the route: `ChatScreen` is registered in 2 navigators and `DepartmentChatScreen` in 2 — a route-level wire is the "screen in 2 shells, route in 1" trap. |
| B3     | 15 s ceiling              | W1.                                                                                                                                                                                                                                                                                                                                      |
| B4     | Sign-out                  | **New (W3).** See §5.1.                                                                                                                                                                                                                                                                                                                  |
| ~~B5~~ | ~~Queue cap~~             | **DROPPED** (R1-P0-2): fires ~60× mid-`backupNow`, signing torn sets and defeating repair's undrained-outbox refusal (I4).                                                                                                                                                                                                               |

**Gate on "a commit is owed", never on queue size** (R2): `flushConversations` deliberately arms no
commit, and opening any chat enqueues a conversation row (`convVersion` hashes `unread_count`,
`mirrorBootstrap.ts:103`; zeroed on open, `messengerStore.ts:1375`). Gating on `mirrorOutboxSize()`
would sign on every chat _open_.

## 4. Invariant audit (BACKUP_LOOP §2)

| #   | Invariant                 | Effect                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1  | Idle boots upload nothing | **Unchanged** — no upload path touched.                                                                                                                                                                                                                                                                                                                                     |
| I2  | Every flush owes a commit | **Preserved; window `(5+W)` → `(15+W)`** where W = walk duration, which §10 has NOT measured. Flag raised BEFORE `putMessages` (`:650`), survives a kill, healed at `mirrorBootstrap.ts:163`. The timer callback nulls the slot _before_ invoking (`:69-71`), so a flush landing mid-walk re-arms and the epoch-guard retry survives — **bounded, not indefinite** (R2-Q1). |
| I3  | Never weaken the verifier | **Unchanged** — no verifier code in the diff.                                                                                                                                                                                                                                                                                                                               |
| I4  | Repair never launders     | **Unchanged** — B5 dropped; nothing signs mid-drain.                                                                                                                                                                                                                                                                                                                        |
| I5  | Wipe ⇒ ledger purge       | **Unchanged.**                                                                                                                                                                                                                                                                                                                                                              |
| I6  | Seq adopts, never hammers | **Unchanged.**                                                                                                                                                                                                                                                                                                                                                              |
| I7  | Restore seeds the ledger  | **Unchanged.**                                                                                                                                                                                                                                                                                                                                                              |
| I8  | Ledger best-effort        | **Unchanged**; the ceiling leans on the flag, whose failure mode is one extra commit — the harmless direction.                                                                                                                                                                                                                                                              |
| I9  | No plaintext in logs      | New log line: reason enum + ms only.                                                                                                                                                                                                                                                                                                                                        |

## 5. Residual risk, stated plainly

The unsigned window is `ceiling + W` (walk duration): `(5+W)` today, `(15+W)` at 15 s — roughly **2×** — the exact factor depends on W (2.7× at W=1 s, 1.7× at W=10 s), which step 2
measures. Not the 9× Rev 2 claimed (R2-P2-8). A kill inside it leaves the server ahead of the signed
root, which is exactly what the pending flag + boot heal exist for and is tested
(`mirrorSessionHygiene` BUG-7/7b, `mirrorLedgerBootSweep`).

**Two entrances to that window, not one:**

1. **Force-stop → uninstall, never relaunching** (BACKUP_LOOP §5.3, B-463): destroys the flag and the
   local history repair needs → permanent `root_mismatch`. Mitigated structurally — you normally
   background before uninstalling, and B1 commits on background.
2. **Sign-out → uninstall, never logging back in** (R2-P1-2) — _the more ordinary story_.
   `disposeMirror` clears the armed timer (`:275`) **and removes the AppState hook** (`:276`), so B1
   can never fire afterwards. **W3 closes this**, and it is also why W3 is not optional.

**Also caught during this round — a PRE-EXISTING bug, not caused by this change:** `signOut` calls
`disposeMirror()` with **no preceding flush** (`authStore.ts:743`), and `disposeMirror` does
`queue.length = 0`. So **deleting a message and signing out within 1.5 s already drops the
tombstone today** — the deletion never reaches the server and a later restore resurrects it. Same
class as B-594/B-605. **Logged as B-632.**

**And it is not only messages** (R3-P1-2): `notifyBackupConversationDeleted`
(`messengerStore.ts:585-593`) → `mirrorConversation(..., {deleted:true})` → `convQueue`, also cleared
by `disposeMirror` (`:271`). So B-605s "deleted chats survive a fresh-install restore" is equally
broken by a sign-out inside 1.5 s. B-632 covers BOTH queues; `drainMirrorOutbox()` drains both.

**It is permanent, not merely delayed.** `mirror_flushed` still holds the row's LIVE version, so the
next catch-up sweep's `seedMirrorDedup` (`mirrorBootstrap.ts:150`) skips it by design (I1). Logging
back in does not heal it: the server keeps the live row forever and every future restore resurrects
the message. **Therefore B-632 SHIPS INDEPENDENTLY and FIRST** (§10) — it is a user-visible integrity
failure in a feature shipped two days ago, it is not caused by this plan, and its fix only ever
narrows windows.

### 5.1 W3 shape — and WHERE it goes (R3-P0-1)

**Landing site is the whole finding.** `authStore.ts:672-680` already documents this hazard for push
tokens: _"revoke … BEFORE `authApi.signOut()` runs. Once auth invalidates the JTI, the DELETE calls
would 401 against JwtHttpGuard's revocation check."_ `disposeMirror()` sits at `:743`, ~57 lines
**after** `authApi.signOut(deviceId)` at `:686`. A drain there POSTs on a revoked JTI →
`backupClient.ts:89-104` refresh also revoked → `BackupError('unauthorized')` → `flush()` classifies
`unauthorized` as **retryable** (`messageMirror.ts:691`) → requeues + arms a retry → `disposeMirror`
then cancels the timer and clears the queue. **It would ship nothing, fix nothing, and every mocked
test would pass.** Inert-but-green, the shape this repo keeps re-learning.

So: **W3 goes immediately before `authApi.signOut(deviceId)` (`:686`)**, beside
`revokeServerPushTokens()` (`:684`) — same ordering constraint, same reason. Final order:
`W3 → authApi.signOut → … → disposeMirror → stopMirrorBootstrap` (the last two must stay after:
`stopMirrorBootstrap` nulls `merkleAfterFlushHook`, after which `fireMerkleHookNow` returns at `:87`).

**Shape:** gate on `isMirrorEnabled()` first — a locked-backup sign-out must cost 0 ms. Then
`await Promise.race([drainMirrorOutbox() → gated fireMerkleHookNow(), timeout(2 s)])`, try/catch,
never throwing. **`await`, not `void`** (R3-P1-2): W2 is a React cleanup and correctly `void`s; W3
must not copy that shape or it becomes decorative.

**Why the bounds hold** (verified, R3): re-entrancy is already solved by `isSigningOut` (`:639`,
IDN-22); sign-out is already async behind a blocking overlay (`:643`) and already awaits
`revokeServerPushTokens` (4 s timeouts) and `authApi.signOut`, so a 2 s race is _smaller_ than what
is there; `drainMirrorOutbox` clears both debounce timers, loops with `guard < 200` and bails on no
progress (`:759-771`); retry/overflow timers go through `trackTimer`, cancelled by `disposeMirror`.

⚠️ **`Promise.race` ABANDONS, it does not cancel.** A drain still running when `disposeMirror()`
fires is made safe by `mirrorSessionGen++` (`:264`), which turns the in-flight flush stale at `:657`
/`:679` so it neither requeues nor writes the ledger. That is BUG-2/BUG-6 working as designed —
stated here so nobody "fixes" it later.

**Security posture:** the master key stays live ~2 s longer, _during_ a user-initiated,
overlay-blocked teardown in which the key was already live and network calls were already in flight.
`:733-739`'s stated threat (a _post-logout_ attacker triggering a re-mirror) is unaffected, and
`lockIdentityBackup()` (`:753`) is untouched.

## 6. Out of scope

Incremental/cached Merkle roots; yielding inside `res.json()`; the remaining `markDirty` scans
(B-631 residue); a durable tombstone outbox (§11-A).

## 7. Tests — RED first, each mutation-proved

1. **Ceiling is pinned** (R2-P1-3 — W1 currently ships pinned by _nothing_: no suite waits the
   debounce, so a mistyped constant stays green). Fake timers: **no** commit at ceiling−100 ms,
   **exactly one** at ceiling+100 ms.
2. **B2 fires an owed commit on blur; browsing mints none.** Two chats opened and left with no send
   in between ⇒ zero commits (the §2.2 self-limiting property).
3. **B1 still commits on background after W1** — the R1-P0-1 regression guard: it must not depend on
   a deleted variable.
4. **`backupNow` of 200 rows still produces exactly one commit** (R1-P0-2 guard).
5. **A flush landing during the commit walk produces a second commit**; advance the **full** ceiling,
   and assert B1 is _not_ what catches it (the slot is null mid-walk) (R2-P2-6).
6. **The upload path is byte-untouched:** delete a message, wait out the 1.5 s flush debounce ⇒ the
   tombstone ships. _(Restated per R2-P1-1 — the Rev 2 wording "delete then sign out" is RED by
   construction against today's code; that is B-632, pinned separately by W3.)_
7. **W3 / B-632 — THE FIRST TEST TO WRITE, and RED against today's code.** A queued MESSAGE
   tombstone **and** a queued CONVERSATION delete are both on the server before `disposeMirror` runs.
   Plus: sign-out still completes when the network hangs (timeout path).
   ⚠️ **A mocked `backupClient` cannot catch R3-P0-1** — the 401 never happens, so a mis-placed W3
   passes green. So ALSO: (a) a case where `putMessages` rejects with `BackupError('unauthorized')`,
   asserting the tombstone is not silently requeued-then-discarded; and (b) a **source-scan ordering
   pin** that the W3 call site appears BEFORE `authApi.signOut(` in `authStore.ts` — comments
   stripped first (the `:672-680` comment contains the token), CRLF-safe, anchored inside the
   `signOut` closure.
8. **Backup disabled ⇒ every boundary inert.**

**Re-point, never delete** (R2-P2-9): `mirrorQueueBackpressure.test.ts:310-330`,
`messageMirrorMerkleFlush.test.ts:95-134`, `mirrorSessionHygiene.test.ts:198-218`,
`mirrorConversationLane`, `conversationDeleteMirror`, `backupLagProbes`, `restoreBackgroundRunner`.

## 8. Doc updates (R2-P1-4 — restored; Rev 2 dropped this item)

`BACKUP_LOOP.md` hard-codes the old constant where it matters most: **§5.2** ("within ~2 s … before
the 5 s commit", line ~174) and **§5.4** ("persists for more than ~10 s of activity = a client not
honouring I2", ~234-236). Left stale, the next investigator reads a healthy 15 s client as an I2
violation — on the exact probe used to chase `root_mismatch`. Update both, plus §1's ASCII pipeline.

## 9. Gates (BACKUP_LOOP §4, in order)

1. §4.1 backup/merkle suite list, verbatim. 2. `npm run test:crypto` **twice** (B-126).
2. `cd apps/messenger-service && npm test -- --testPathPattern backup`. 4. `typecheck` ≤ 47; `lint`
   adds zero. 5. App project (W2 touches screens; W3 touches authStore).

## 10. BUILD ORDER — the bug fix ships first, the tuning waits (R3-Q3)

The critic's straight answer to "would you ship Rev 3 unverified?" was **no for the tuning, yes for
the bug fix** — and that split is adopted:

| Step  | What                                                                                                                                                                              | Gated on                                                                                                                                                                                     |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** | **W3 + B-632** as a STANDALONE commit — placed before `authApi.signOut(:686)`, covering BOTH queues, own tests + `sqa.md`.                                                        | **Nothing.** It is a pure bug fix that only ever NARROWS the tombstone-loss and unsigned windows; worst-case failure is a 2 s sign-out delay behind an existing blocking overlay. Ships now. |
| **2** | **The measurement.** One release build, reproduce "send fast then press back", read `[LAGDIAG] [backup.merkle] tookMs= rows= seq=` (`merkleCommit.ts:152-158`, fires at ≥250 ms). | A device.                                                                                                                                                                                    |
| **3** | **W1** (5 s → 15 s)                                                                                                                                                               | Step 2 clearing. **If the commit is NOT the multi-second block, CLOSE this plan** — do not build it smaller.                                                                                 |
| **4** | **W2** (blur hook, in the component)                                                                                                                                              | Ships with W1 — harmless alone, pointless alone.                                                                                                                                             |
| **5** | **W4** tests + `BACKUP_LOOP.md` §5.2 / §5.4 / §1                                                                                                                                  | With W1/W2.                                                                                                                                                                                  |
| **6** | **§5.2 kill-window heal on-device at 15 s**                                                                                                                                       | Before testers see W1.                                                                                                                                                                       |

**Why W1 is held:** it is the only edit that _widens_ the window behind five shipped `root_mismatch`
incidents, and BACKUP_LOOP §5.2 is exactly the check that validates a widened window. Shipping a 2×
widening on that code with zero device evidence, for a benefit nobody has yet observed, is the
pattern §3 of the runbook exists to stop.

**Remaining decision — Q2:** device for §5.2/§5.3 before testers get W1? If not, the release notes
must say so plainly rather than imply verification.

## 11. Rejected in review — do NOT re-propose

**A. Deferring the UPLOAD** (Rev 1's core). Synthetic queue-only tombstones + `queue.length = 0` on
signOut/wipe ⇒ deleted messages resurrect on restore (§2.3). Needs a durable tombstone outbox first,
and is unnecessary for the win.

**B. "Deferring the commit alone reverts B-45r3."** Rev 1's premise, **stale by three fixes**.
B-45r3 (05 Jul) lowered 30 s → 5 s when nothing survived a kill; B-94 (17 Jul) then built the
persistent flag + epoch guard + boot heal _specifically_ to make a lagging commit survivable, with
the flag raised before the upload (BUG-7).

**C. Deleting `scheduleMerkleHook` / `merkleHookDebounce`.** **Six** readers (`:68`, `:86`, `:103`,
`:196`, `:275`, `:301`) — B1's gate, `fireMerkleHookNow`'s clear, `fireMerkleHookNowIfPending`,
`disposeMirror`, `resetMirrorForWipe`. Deleting it while "keeping B1 as-is" silently re-ships
B-45r3's root cause.

**D. A queue-cap commit trigger.** ~60 commits mid-`backupNow` on a 3,000-message history, signing
torn intermediate sets and defeating `repairBackupCommit`'s undrained-outbox refusal (I4).

**E. Gating a boundary on `mirrorOutboxSize()`.** Includes the conversation queue, which fills on
every chat _open_ ⇒ a full server walk + sign per chat opened.
