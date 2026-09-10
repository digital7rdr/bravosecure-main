# B-155 â€” Messenger laggy on first boot Â· Root-cause register

**Date:** 2026-07-23 Â· **Reported by:** founder ("on first boot the messenger fell laggy")
**Status:** **FIXED** (2026-07-23, same day) â€” B-155 F1+F3 plus every Â§8 follow-up
(B-156â€¦B-160). All gates green; **on-device verification still outstanding** (see Â§9).
**Severity:** P2 (UX; one-shot per install, but it is the user's _first impression_ of the app)
**Regression suites:** `bootstrapDrainYield` (11) Â· `messengerRenderPerf` (10) Â·
`expirySweeperCost` (9) Â· `legacyMessengerStoreGone` (5) Â· `linkPreview` (+4)
**Runbook:** any fix here touches `drainRelay` in `productionRuntime.ts` â†’ run `docs/runbooks/MESSAGE_LOOP.md` (Â§5 caller completeness, Â§7 gates, Â§9 sign-off).

---

## 1. Symptom

On the **first boot after a fresh install** (or cleared data / new account on the device), the
messenger is visibly laggy â€” touches respond late, navigation stutters, the home list repaints
continuously. Subsequent boots are fine. This is not a render bug on one screen; it is
**JS-thread starvation for the duration of the first relay drain**.

## 2. Why _first_ boot specifically

`drainRelay` (`src/modules/messenger/runtime/productionRuntime.ts:8210`) keys off a per-owner
AsyncStorage flag:

```
bravo.relay.bootstrap-done.<ownUserId>     (productionRuntime.ts:8246)
```

While the flag is unset â€” exactly once per install per owner â€” the first pull runs with
`bootstrap=true`, which raises the page cap from the steady-state 50 to the server's
`relay.maxBootstrapLimit` (default **1000**):

```ts
const pageLimit = bootstrap && iter === 0 ? 1000 : 50; // :8254
```

That was a deliberate correctness fix (restore-after-reinstall #4: a multi-week backlog must not
be truncated). The _cost_ side was never handled: every one of those envelopes is processed
back-to-back on the JS thread. On the second boot the flag is set, pages are 50 and the backlog
is small â€” so the lag "heals itself", which is exactly the reported signature.

## 3. Root cause â€” the mechanism, step by step

The per-envelope loop (`for (const env of envelopes)`, `:8274`) does, **sequentially, per
envelope, with zero macrotask yields anywhere in `drainRelay`**:

| Step                            | Work                                                                                                                                                                                                 | Where it runs                                                                                                                             |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `unwrapOuter` (:8306)           | sealed-sender v2 unwrap: X25519 ECDH + AES-GCM                                                                                                                                                       | JS thread (curve25519 is the pure-JS `@privacyresearch/curve25519-typescript`; SHA via `@noble/hashes` â€” see `crypto/polyfills.ts:172`) |
| `seenEnvelopes.wasSeen` (:8356) | SQLCipher SELECT                                                                                                                                                                                     | native pool, but JS marshalling per call                                                                                                  |
| `admitSenderCert` (:8378)       | authority signature verify (+ keys-service fetch on first contact with each peer)                                                                                                                    | JS thread + network                                                                                                                       |
| `handleIncoming` (:8412)        | **serialized on the global txn chain**: libsignal decrypt (first boot â‡’ X3DH `PreKeyWhisperMessage` session build per new peer â€” the most expensive envelope kind), SQL receive txn, ack enqueue | JS thread + SQLCipher                                                                                                                     |
| store commit                    | `appendMessage` â†’ Zustand `set` per envelope                                                                                                                                                       | JS thread                                                                                                                                 |

Amplifiers that turn "busy" into "frozen":

- **A1 â€” no yield.** There is no `setTimeout(0)` / `InteractionManager` hop between envelopes
  (verified by comment-stripped scan; pinned by the `DOCUMENTS B-155` test). `await` boundaries
  are microtasks â€” React Native touch/timer callbacks are macrotasks and never get a slot until
  the whole page drains. At 5â€“20 ms of crypto+SQL per envelope, a full 1000-envelope bootstrap
  page is **10â€“30+ s of continuous JS-thread occupancy**.
- **A2 â€” per-envelope render.** Every `appendMessage` mutates `conversations` /
  `conversationOrder` (preview, unread count, reorder-to-top), and `MessengerHomeScreen`
  subscribes to both (`MessengerHomeScreen.tsx:68-69`). One re-render of the home list per
  envelope, interleaved into the same saturated thread. (The SQLCipher write-through diff itself
  is already O(changed) â€” N-30 â€” _provided_ untouched lists stay referentially stable; that
  property is now pinned.)
- **A3 â€” the WS lane storms the same window.** The relay's `flushPendingOnConnect` re-pushes
  queued envelopes over the WebSocket at the same moment the HTTP drain runs (the L16/W22a
  comments at :8285-8300 document the race). The in-flight holds prevent duplicated _work_, but
  both lanes contend for the same txn chain and the same thread.
- **A4 â€” first-boot-only extras stack on top.** Identity install + 50-OPK pool build + bundle
  upload (`:5428-5441`), per-new-peer X3DH and keys-service fetches, `/conversations/mine` sync,
  boot prunes/sweeps (seen-envelope prune, pending-stash prunes, B-124 contamination sweep,
  group-stash drain â€” `:1770-2015`). Individually cheap; they all land inside the same window.

**Not the cause** (checked): boot hydration is one `loadRecent` + a **single** `hydrateMessages`
commit (`messengerStore.ts:1275` â€” one `set` for the whole payload, now pinned); the B-94 mirror
ledger keeps idle boots upload-silent; the expiry sweeper and outbox drain are no-ops on a fresh
install.

## 4. Evidence

- Source-level: every claim above carries a file:line; the two load-bearing properties
  (1000-cap bootstrap page, zero yields in the loop body) are asserted by the regression suite
  against the comment-stripped source, so they cannot silently drift.
- On-device timing capture: **pending** â€” no logcat was taken during the founder's first-boot
  session. A capture recipe is in Â§7; re-grep symbols before trusting the stamped lines above
  (MESSAGE_LOOP.md trap: line numbers rot).

## 5. Fix plan (NOT applied â€” for the fix session)

Ordered by value/risk; F1 alone converts "frozen" into "responsive with background catch-up".

- **F1 â€” cooperative yield in the envelope loop** Â· **DONE**. Implemented **time-sliced**
  rather than every-Nth: envelope cost varies by two orders of magnitude (a `wasSeen` hit vs an
  X3DH session build), so a fixed stride over-yields on cheap pages and under-yields on
  expensive ones. `DRAIN_SLICE_MS = 12` (~one frame); when the current slice is spent the loop
  awaits `yieldToEventLoop()` â€” a real `setTimeout(0)` macrotask, because a microtask hop keeps
  the thread and changes nothing. Placed at the TOP of the loop body: outside the W22a in-flight
  hold, outside the receive txn, never between an envelope's decrypt and its ack (ack/dwell
  semantics untouched). Adds no new epoch-flip window â€” the body already awaits network and
  SQLCipher several times. The `DOCUMENTS B-155` assertion is flipped, plus three new pins
  (macrotask-not-microtask, yield-before-hold ordering, slice budget â‰¤ 20 ms).
  **Mutation-proved**: replacing `yieldToEventLoop()` with `Promise.resolve()` turns the suite
  red (byte-copy restore, never `git checkout`, per the runbook concurrency rule).
- **F2 â€” coalesce home-list churn during a drain page** (medium). Batch the per-envelope
  conversation-preview/reorder commits per chunk (the message _append_ can stay per-envelope;
  it is the `conversations`/`conversationOrder` mutation that re-renders the home list).
- **F3 â€” defer the deferrable first-boot work** Â· **DONE, narrowed**. Only the **group-stash
  drain** is deferred (`deferToIdle` â†’ `InteractionManager.runAfterInteractions`, falling back
  to running inline where there is no RN runtime so deferred work can never silently vanish).
  It replays stashed envelopes through the group crypto path, is pure catch-up (restores what is
  already on disk) and was already fire-and-forget, so deferring changes only _when_ it competes
  for the thread. The deferred callback re-checks `isOurEpoch()` â€” it can otherwise fire after a
  logout/rebuild against a closed `txnDb` and the next user's store.
  **Deliberately NOT deferred:** the B-124/B-125 contamination sweep (it deletes rows the user
  could tap before it lands â€” a correctness ordering, not a perf one) and the seen-envelope /
  pending-stash prunes (already fire-and-forget SQL DELETEs costing native time, not JS thread).
  Reordering boot-time data-corruption cleanup to save a few ms is a bad trade; the register
  records the reasoning so the next session does not "finish the job".
- **Non-goals:** do NOT lower the 1000 bootstrap cap (that re-opens the restore-truncation bug
  it fixed); do NOT move decrypt off the txn chain (B-75/B-140 deadlock history); do NOT touch
  ack ordering.

Any fix here is a `drainRelay`/`productionRuntime.ts` change â‡’ **MESSAGE_LOOP.md applies in
full** (no test imports this file â€” the suite being green is not evidence), plus the manual
smoke from CLAUDE.md change-safety rule 6, plus a real first-boot device verify: clear app data
with a seeded 300+ envelope backlog, boot, and interact during the drain.

## 6. Regression contract (what the suite pins, and how it flips)

`src/modules/messenger/__tests__/bootstrapDrainYield.test.ts`:

| Test                                                          | Kind             | Today               | On fix                                    |
| ------------------------------------------------------------- | ---------------- | ------------------- | ----------------------------------------- |
| CONTROL: envelope loop + 1000-cap anchors exist               | control          | green               | update anchors if the loop is extracted   |
| `DOCUMENTS B-155`: no yield token in `drainRelay`             | pins the **bug** | green (bug present) | **flip to `toBe(true)`** in the F1 commit |
| `hydrateMessages` is ONE commit                               | permanent        | green               | stays                                     |
| untouched conversation lists stay referentially stable (N-30) | permanent        | green               | stays                                     |

## 7. Device capture recipe (for the fix session's before/after)

```bash
adb shell pm clear com.bravosecure.app        # forces bootstrap=true on next boot
adb logcat -c && adb logcat -v time | grep -E "bravo.drainRelay|messenger.boot|Choreographer|Davey" | tee first_boot_lag.txt
# boot the app, log in, and swipe the home list during the drain;
# Choreographer "Skipped N frames" + Davey lines are the jank measure,
# bracketed by the drainRelay page logs.
```

---

## 8. Overall-lagginess audit (steady state, beyond first boot) â€” 2026-07-23 follow-up

Same-day follow-up sweep of the messenger's steady-state JS-thread behaviour: every screen-level
store subscription, every live timer, the receive/typing/presence/mirror cadences, and the chat
render path. Findings ranked; fixes NOT applied.

### L1 â€” every catch-up drain shares the B-155 no-yield loop âš ï¸ P2 (the headline)

B-155 is **not confined to first boot** â€” first boot is only the worst case. The same
yield-free envelope loop runs on **every** reconnect, AppState-foreground, and
ChatScreen-pull drain, at up to 50 envelopes/page Ã— 10 pages (500 envelopes) per
`HARD_CAP_ITERATIONS`. Coming back online after a night offline processes hundreds of
envelopes decrypt-to-decrypt â€” the familiar "app stutters for a few seconds right after
foregrounding" signature. The **F1 fix (Â§5) therefore fixes steady-state lag too**, and the
`DOCUMENTS B-155` scan already covers it (it pins the whole function body, not just the
bootstrap branch). The WS lane does not have this problem â€” each `handleDeliver` frame
arrives as its own socket event, so the event loop breathes between frames naturally.

### L2 â€” ExpirySweeper walks EVERY message at 1 Hz while any burn timer is live Â· **FIXED (B-160)**

`expirySweeper.ts:124-137`: the sweep is `O(total hydrated messages)` â€”
`Object.entries(state.messages)` over every conversation, every message â€” and runs every
**1 s** whenever at least one armed (`expires_at`) message exists anywhere. The F-13 idle
backoff (30 s rescan) only engages at exactly zero armed messages, so ONE live
disappearing message anywhere buys a full-store walk + per-tick allocations at 1 Hz for its
whole lifetime (hydration is 200/convo â€” a 20-conversation account walks ~4 000 rows/s).
The related UI half is already right (shared 1 Hz countdown tick, see "healthy" below).

**Fixed:** a per-conversation armed index keyed by the message-list **reference**. Unchanged
lists reuse their cached armed subset, so a steady-state tick visits **zero** rows (measured by
proxy-counting reads in the test); a list whose reference moved is re-scanned, which is what
keeps a newly-armed message visible. This reuses the same immer reference-stability property
the write-through diff relies on (N-30). Index rows for deleted conversations are dropped so it
cannot outgrow the store.

**Bonus correctness fix:** `IDLE_RESCAN_MS` (F-13) is **deleted**. It skipped all sweeps for
30 s after any scan that saw zero armed messages â€” so a 10 s disappearing message sent inside
that window sat on screen up to ~20 s past its own countdown. It existed only to avoid the full
walk, which no longer happens. Pinned by a dedicated test (RED-proved: returned 0 instead of 1).
Public API unchanged, so all four call sites (`productionRuntime.ts:2212`, `runtime.ts:589`,
two test suites) are unaffected â€” verified by caller sweep per MESSAGE_LOOP Â§5.

### L3 â€” every keystroke re-renders the whole ChatScreen Â· **FIXED (B-159)**

The composer's `text` state lives at the root of the ~2 700-line `ChatScreen` component
(`ChatScreen.tsx:195`, consumed by the input at `:1570`). Each keystroke re-runs every hook
and selector in the screen and re-renders everything not behind a memo (header, reply strip,
list wrapper â€” the bubbles themselves are saved by `React.memo`). On low-end devices this is
the classic RN "typing feels heavy in long chats" cost. Outbound typing signals are already
throttled (start once + refresh at 5 s â€” `:600-612`), so the waste is purely render-side.
**Fixed:** the input bar is now `<ChatComposer>` (memoised, `forwardRef`), owning `text`,
`justSent` and the native `inputRef`. A keystroke re-renders the composer and nothing else.
The screen learns what it needs by callback: `onSend(trimmed)` for the submitted body and
`onDraftActivity(hasText)` on every keystroke. The old typing `useEffect` â€” keyed on `text`,
which is _why_ the draft had to live in the screen â€” became a plain function that touches only
refs, so the typing cadence (start / 5 s re-emit / stop) is byte-for-byte the same at zero
render cost; its `[runtime, groupPeersKey]` legs are preserved by a small effect. Every
composer prop is referentially stable (`useCallback` + latest-refs for `send` /
`enqueueMediaAssets`), or the memo would be defeated and the extraction would buy nothing.
The emoji sheet â€” a modal the screen owns â€” reaches the draft through an imperative
`insert()` handle rather than lifting state back up. B-73's imperative native clear is
preserved and pinned. `hasDraftRef` is cleared on send, or a later `emitTyping()` would emit
`start` for an empty composer and strand the peer on a permanent "typingâ€¦".

10 source-scan pins in `messengerRenderPerf.test.ts` (RED-proved).
**Device verification is still REQUIRED before release** â€” this is the send path and no test in
this project can render `ChatScreen`. Exercise: type (draft persists, no stutter), send, rapid
double-send (B-73), emoji insert, TTL badge, attach sheet, voice note, and the peer's
"typingâ€¦" appearing and clearing.

#### Test-integrity finding (found while writing the L3 pins)

The naive `src.replace(/\/\*[\s\S]*?\*\//g, '')` comment stripper used by the existing source
scans is **unsafe on `.tsx`**: `ChatScreen.tsx:1140` passes the MIME wildcard `'*/*'` to
`DocumentPicker.getDocumentAsync`, whose `*/` closes a block comment early â€” a later real `/*`
then pairs with a distant `*/` and **64 KB of the 171 KB file disappears**. Every `not.toMatch`
downstream would have passed vacuously. `messengerRenderPerf.test.ts` uses a line-based
stripper instead (a block comment must open the line) plus a guard test asserting the stripped
source keeps >55% of its bytes and still contains known declarations.
**Checked, not affected:** the `.ts` runtime scans (`bootstrapDrainYield`,
`receivePersistenceInvariants`) â€” verified by asserting known code survives their slices
(`tryAcquireEnvelope`, `unwrapOuter`, `admitSenderCert`, `handleIncoming`, `own.decrypt`,
`appendMessage`â€¦). Their high strip ratio (50â€“59%) is genuine comment density, not loss.

### L4 â€” ForwardList subscribes unshallow to the whole conversations map Â· **FIXED (B-158)**

`ChatScreen.tsx:2727` â€” `useMessengerStore(s => s.conversations)` without `useShallow`, so
while the forward modal is open every inbound message anywhere re-rendered the picker list.
Bounded by modal lifetime (RN `Modal` returns null when `visible=false`, so the component is
unmounted when closed) â€” hence P4.

**Fixed:** `useShallow`, matching the M-18 pattern the home list already uses. Pinned by a
source scan in `messengerRenderPerf.test.ts` (RED-proved). Honest scope: `useShallow` prevents
the re-render only when the map's entries are referentially unchanged; a commit that really
does mutate a conversation still re-renders, which is correct â€” the picker shows that row.

### L5 â€” failed link previews refetch on every view Â· **FIXED (B-157)**

`ui/linkPreview.ts:66-73` â€” the B-151 fix (correctly) stopped memoising `null` forever, but
kept **no** negative cache at all: a failed fetch deletes the entry, so each remount of a
link bubble (scroll in/out of the window) re-kicks a 5 s-timeout fetch. Offline scrolling
through a link-heavy chat spawns one doomed fetch + abort timer per link bubble pass.
Network I/O is native-threaded so this is battery/network more than jank.

**Fixed:** a 60 s negative TTL plus a 128-entry bounded map (expired-first, then
oldest-inserted eviction) so a chat full of dead links cannot leak. B-151's actual invariant â€”
a transient failure is never _permanent_ â€” is still asserted; its "retries on the very next
call" assertion was updated DELIBERATELY (with the reason in the test) rather than deleted,
because per-view retry was the defect. Success caching is untouched (no TTL on the happy
path). RED-proved before the fix.

### L6 â€” dead legacy hook `useRealtimeMessages` Â· **FIXED (B-156)**

`src/hooks/useRealtimeMessages.ts` had **zero importers** and targeted the _legacy_
`@store/messengerStore` + Supabase Realtime (the pre-relay era). No runtime cost, but a trap:
it subscribes with a no-selector `useMessengerStore()` (whole-store re-render on every commit)
if anyone ever revived it.

**Fixed:** the whole dead chain deleted â€” the hook, the Twilio-era `src/store/messengerStore.ts`
(120 lines, its only consumer), and `src/services/twilio.ts` (whose only consumer was that
store). The real prize is the name collision: the pipeline brief flags "two files named
`messengerStore.ts` â€” a grep-driven refactor will hit the wrong file", and there is now exactly
one. Pinned by `legacyMessengerStoreGone.test.ts`, which walks the source tree so a NEW importer
of either module fails too (RED-proved: 4 failures before deletion). tsc stayed at 47.

### Verified healthy (checked, do NOT re-audit)

- **Home screen selector discipline (M-18):** `useShallow` conversations, per-row
  `RowOnlineDot` primitive selector (`MessengerHomeScreen.tsx:922-929`) â€” a presence frame
  re-renders one dot, not the screen; search reads messages via `getState()`.
- **Chat list virtualization:** `initialNumToRender={20}` / `maxToRenderPerBatch={20}` /
  `windowSize={11}` / Android `removeClippedSubviews` (`ChatScreen.tsx:1486-1501`); bubbles
  behind `React.memo` with a field comparator (`:1953`).
- **Countdown UI (fix #26 / M-13):** ONE shared module-level 1 Hz tick via
  `useSyncExternalStore`; unarmed bubbles get a no-op subscription; timer stops when no
  armed bubble is mounted (`ChatScreen.tsx:2512-2570`).
- **Write-through diff is O(changed)** (N-30) and row UPDATEs ride a 50 ms coalesced batch
  (`upsertCoalesced`); both properties now pinned by `bootstrapDrainYield.test.ts`.
- **Backup mirror cadence:** 1.5 s flush debounce + 5 s Merkle debounce; ratchet snapshots
  self-debounce (B-67 holds the debounce on failure).
- **Typing pipeline:** sender throttled (start + 5 s refresh + stop), inbound scoped per
  conversation via `convTag` (G7-RT) with a watchdog against stranded "typingâ€¦".
- **Media:** thumbnails are compressed, base64-capped at 48 KB and memoized as data-URIs;
  full media decrypts to temp files off the render path; blob cache is LRU-bounded (pinned
  by `mediaBlobCache`).
- **`useMessenger()`:** narrow selectors + lazy singleton â€” no provider-level re-render
  amplification exists.

### Disposition â€” ALL FIXED 2026-07-23

| Item | Bug   | Fix                                                       | Pinned by                  |
| ---- | ----- | --------------------------------------------------------- | -------------------------- |
| L1   | B-155 | time-sliced yield covers every drain, not just first boot | `bootstrapDrainYield`      |
| L2   | B-160 | armed index (+ F-13 late-purge window closed)             | `expirySweeperCost`        |
| L3   | B-159 | `<ChatComposer>` extraction                               | `messengerRenderPerf`      |
| L4   | B-158 | `useShallow` on the forward picker                        | `messengerRenderPerf`      |
| L5   | B-157 | 60 s bounded negative cache                               | `linkPreview`              |
| L6   | B-156 | dead Twilio-era chain deleted                             | `legacyMessengerStoreGone` |

Every fix was RED-proved before it landed (B-155 F1 additionally mutation-proved). The one
piece of the original plan deliberately **not** taken is F2 â€” see Â§9.

#### Superseded planning note (kept for provenance)

L1 needs no new pin (the B-155 scan covers the whole function). L2/L3 are the next two
worthwhile perf fixes after F1 and should land with their own before/after device numbers
(Â§7 recipe works for both â€” replace the `pm clear` step with "start a disappearing-message
chat" / "type into a 200-message chat"). L4/L5 are opportunistic one-liners. L6 is a
deadcode sweep item.

---

## 9. Sign-off (2026-07-23) — what is proven, and what is not

### Verified here

- **Every fix was RED first.** Each bug's test failed against the unfixed tree and passes
  after; the counts are in each commit message. B-155 F1 was additionally **mutation-proved**
  (swap `yieldToEventLoop()` for `Promise.resolve()` → suite red), restoring from a byte-copy
  rather than `git checkout`, per the MESSAGE_LOOP concurrency rule.
- **Gates:** the whole `messenger-crypto` project green, run **twice** per the B-126 flake rule;
  `tsc` at the 47 baseline throughout; eslint 0 errors on every touched file (the pre-commit
  hook caught one real defect mid-run — an unvoided `runAfterInteractions` promise).
- **Caller completeness (MESSAGE_LOOP §5)** run for each shared symbol touched: `ExpirySweeper`
  (public API unchanged; all 4 call sites checked), `drainRelay` (signature unchanged; the two
  new module-scope symbols checked for collisions), the deleted Twilio chain (tree-walked).

### NOT verified — required before release

1. **On-device first boot.** No `Choreographer`/`Davey` numbers exist for before or after. Run
   §7 on a real device with a seeded backlog and record both. This is the only measurement that
   proves the user-visible symptom is gone rather than merely explained.
2. **The composer (B-159) on-device.** This is the **send path**, and no test in this project
   can render `ChatScreen`. Exercise: type (no stutter, draft persists), send, rapid
   double-send (B-73), emoji insert, TTL badge, attach sheet, voice note, and confirm the peer
   sees "typing…" appear and clear.
3. **`InteractionManager` behaviour under a stuck gesture (F3).** `runAfterInteractions` waits
   for interaction handles to clear; if a gesture handle leaks, the deferred stash drain is
   delayed. Worst case is the pre-existing "stash drains on the next launch", but confirm the
   drain log appears shortly after boot on a real device.

### Deliberately not done

- **F2 (coalesce per-envelope home-list churn).** With F1 in place the renders are spread
  across frames instead of packed into one block, so the remaining win is much smaller than the
  risk: batching conversation-preview/reorder commits means touching `appendMessage`'s store
  path, which is the exact surface that produced B-124/B-125 (CRITICAL data loss). Not worth it
  without device numbers showing it still matters — take measurement 1 above first.
- **The `bootstrap=1000` cap** stays: lowering it re-opens the restore-truncation bug it was
  added to fix.
- **The B-124 sweep and stash prunes** stay inline at boot — see F3's note.
