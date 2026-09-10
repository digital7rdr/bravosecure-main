<!-- SQA context pointer -->

## QA / Bug / Testing tasks → read `sqa.md` FIRST

**For any QA, bug-investigation, ADB-logcat, or device-testing task, read `sqa.md`
at the repo root before doing anything else.** It is the running SQA reference and
bug log, and it is NOT auto-loaded into context. It contains:

- The full bug log (B-01 … B-17) with status, root cause, log evidence, and files involved.
- The **Device & Identity Reference** (BlueStacks serial ↔ account ↔ Signal userId) and group IDs.
- ADB setup/log-capture commands, the Frontend/Backend breakdown, and per-session timelines.

When you log a new bug or finding during a session, append it to `sqa.md` (keep the
summary table and bug numbering consistent). The tester is an SQA engineer who finds and
documents bugs and does NOT implement fixes unless explicitly asked.

---

## Lite CPO booking module → run `docs/runbooks/LITE_BOOKING_LOOP.md`

**Whenever you work on the Lite (auto-dispatch) CPO booking module — client booking screens,
agency/service dispatch, CPO mission, escrow/payout, or booking notifications — read and run
[`docs/runbooks/LITE_BOOKING_LOOP.md`](docs/runbooks/LITE_BOOKING_LOOP.md) as part of the
task.** It is the module-specific verification loop (a companion to the root `LOOP.md`) that
proves the whole flow is workable across all three actors before you call a change done:

- **Client:** book → cancel while waiting → resume/navigate freely → notification at every step →
  team (verify) code shows → money deducted accurately.
- **Agency (service):** receive offer → assign CPO → monitor mission → smooth top-up / payout.
- **CPO:** receive assigned job → run live mission → real-time GPS → mission control (pickup/go-live/complete).

Run it at the **start** (baseline) and **after** any change (regression), including its
automated gates, SQL/data probes, notification matrix, and the B-82 regression watchlist. The
trigger-file list is at the top of that doc. Do not mark a Lite-booking change complete until
its §7 sign-off criteria hold (or you state which lane you could not exercise and why).

---

## Messenger backup / restore / Merkle → run `docs/runbooks/BACKUP_LOOP.md`

**Whenever you work on the messenger backup module — the mirror pipeline, Merkle
commits/verification, restore/repair flows, ratchet snapshots, backup screens, or
`apps/messenger-service/src/backup/**` — read and run
[`docs/runbooks/BACKUP_LOOP.md`](docs/runbooks/BACKUP_LOOP.md) as part of the task.**
The `root_mismatch` restore dead-end shipped FIVE times (B-45r3, B-50, B-67, B-81, B-94)
because each fix patched a symptom while the write side kept manufacturing drift; that
runbook is the contract that keeps the class dead:

- The **§2 invariants** (I1–I9): idle boots upload nothing (persistent `mirror_flushed`
  ledger), every flush owes a commit (pending flag + flush-epoch guard), the verifier is
  never weakened, repair never launders, server wipes purge the ledger, seq 409s adopt
  once — check every one against your diff.
- The **§4 automated gates** (backup/merkle Jest suites first, then the full crypto
  project) and the **§5 device/data probes** (idle-boot silence check, kill-window heal,
  fresh-install restore round-trip, SQL drift probes).
- New `root_mismatch` sighting? §3 first: ask "what wrote server bytes without a covering
  commit?" — do NOT soften `verifyMerkleCommit` (CLAUDE.md security stop-condition).

Do not mark a backup change complete until its §6 sign-off criteria hold (or you state
which check you could not exercise and why).

---

## Messenger message pipeline → run `docs/runbooks/MESSAGE_LOOP.md`

**Whenever you work on the messenger message pipeline — send, receive, the message store, the
receive transaction, notifications, or the call→message seam — read and run
[`docs/runbooks/MESSAGE_LOOP.md`](docs/runbooks/MESSAGE_LOOP.md) as part of the task.**
**No test imports `productionRuntime.ts`**, so a green suite is NOT evidence that a change there
is safe: on 2026-07-18 a _call_ fix silently broke _messaging_ and produced CRITICAL data loss
(B-125) two days later, with the suite green the whole time. That runbook holds:

- The **M1–M16 invariant contract** with each one's current status and what pins it — including
  the rules that no unit test can reach, which are pinned by **static source scans** instead
  (`messageTopologyInvariants.test.ts`, `receivePersistenceInvariants.test.ts`).
- The **§5 caller-completeness protocol** — run it for every change to a shared symbol. Skipping
  it is precisely how B-124 shipped.
- The ordered **§6 work items**, the **§7 gates**, and **§10 stop conditions** (the call-key
  namespace M4 is arch-gated) plus a DO-NOT-RE-PROPOSE table of ideas already rejected with
  reasons.

Two traps that have each cost a session: `test:crypto` **flakes ~50%** (B-126, libsignal ratchet
state leak) so **one red run is not evidence** — run it twice; and line numbers in these docs go
stale fast, so **re-grep the symbol**, never trust a stamped line.

Do not mark a message-pipeline change complete until its §9 sign-off holds (or you state which
check you could not exercise and why). Trigger-file list is at its §0.

---

## Navigation / back press / rapid-use → run `docs/runbooks/NAV_RAPID_USE_LOOP.md`

**Whenever you work on anything that decides how a back press or a tap behaves, read and run
[`docs/runbooks/NAV_RAPID_USE_LOOP.md`](docs/runbooks/NAV_RAPID_USE_LOOP.md) as part of the
task. EVERY edit on these surfaces must take care of that loop.** The surfaces:

- navigators (`src/navigation/**`), tab bars, `tapGuard.ts`
- `BackHandler` / `beforeRemove` / hardware-back handling in any screen
- any `onPress` that navigates; any button whose handler mutates or spends
- focus-effect fetches; timer-driven navigation
- zustand `persist` wiring; `@utils/alert`
- `freezeOnBlur` / `unmountOnBlur` / screen `animation` options

It exists because the client's "not smooth swipe back (back button also) and rapid use" turned
out to be sixteen fixed bugs (B-664..B-679, audit
`docs/audits/NAV_BACK_RAPID_USE_AUDIT_2026-08-26.md`), and each one regrows from a single
innocent-looking line:

- The **§2 invariants** (N1–N11): mounted-under screens register hardware back
  `useFocusEffect`-scoped, never `useEffect` (a mount-scoped handler EATS the first back press
  on every pushed screen); tappable backs go through `goBackOnce` and hot forward presses
  through `navigateOnce` (`onPress` only — programmatic navigation is NEVER guarded);
  mutation/money buttons carry a synchronous ref/store guard reset in `finally`, never a
  `disabled={state}` alone; new persisted stores use `@store/debouncedJsonStorage`, never bare
  `createJSONStorage` (the B-633/B-669 stringify-per-set defect); alert dedupe stays
  handler-less-only; derived Sets keep identity (`sameIdSet`); focus fetches dedupe.
- The **§4 gates** (the pin suites, plus the messenger gate when messenger files are touched)
  and **two operational traps**: the pre-push hook coin-flips on the B-126 moving flake (retry
  on a quiet machine, never `--no-verify`), and killing a backgrounded jest run orphans workers
  that make every later suite look broken.
- The **§6 stop conditions** (Android swipe-back / predictive-back are ARCH-GATED; money-path
  guards are correctness-critical) and the **§8 DO-NOT-RE-PROPOSE table** — six of those
  entries were real defects an adversarial critic caught in the first fix cut; do not re-derive
  them.

Do not mark a change on these surfaces complete until its §7 sign-off holds (or you state which
check you could not exercise and why). Trigger-file list is at its §0.

---

## Messenger regression gate — the WHOLE messenger folder must stay green

**Any change that touches `src/modules/messenger/**`or`src/screens/messenger/**` — and any
push — must leave the entire messenger test suite green. No exceptions, no "unrelated" failures.**

```bash
# The gate — run BOTH projects, 100% green before you commit AND again before you push.
# 1) Crypto/node project — src/modules/messenger/__tests__/** + packages/messenger-core/__tests__/**
npx jest --selectProjects messenger-crypto                       # run TWICE (flake rule below)
# 2) App project — the messenger SCREEN render tests the crypto project does NOT run
npx jest --selectProjects app --testPathPattern "screens/messenger"
```

**Touching `src/modules/messenger/**`OR`src/screens/messenger/**` means running EVERY messenger
test across BOTH Jest projects, every time.** The crypto/node project does not include the screen
render tests under `src/screens/messenger/__tests__/**` (they mount RN screens), so
`--selectProjects messenger-crypto` ALONE is NOT the full gate — you must also run the app-project
messenger screen tests above. Run the crypto project **twice** (flake rule below); the app screen
tests once. No exceptions, no "unrelated" failures.

### The bug-regression contract

Every bug logged in `sqa.md` from **B-143 onward** has a permanent regression test, and the rule
going forward is: **a bug is not fixed until a test would catch it coming back.** When you fix a
bug, its test must have been RED first (mutation-prove it by reverting the fix). When you find a
bug you are NOT fixing, land a test that pins the CURRENT broken behaviour under a
`DOCUMENTS B-NNN` name, with a comment stating what the assertion must become — the fix commit
then flips it. Never delete one of these to make a run green.

| Area                        | Suite                                                                                                                                                                                                                     | Pins                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ticks / receipts            | `messageTicks`, `envelopeLegParity`                                                                                                                                                                                       | the one tick rule; delivered/undeliverable leg parity (B-143)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Reply                       | `replyWireParity`                                                                                                                                                                                                         | replyTo on all 8 send sites + the ingest cap (B-144, B-145)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Presence                    | `presenceStore`, `peerPresence`                                                                                                                                                                                           | last-seen retention + privacy strip (B-146), skew window (B-147)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Voice notes                 | `voiceNoteLifecycle`                                                                                                                                                                                                      | recorder lifecycle + plaintext cleanup (B-148, B-149)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Link preview                | `linkPreview`                                                                                                                                                                                                             | OG attribute order, no negative caching (B-151)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Transport                   | `transportSingleSource`                                                                                                                                                                                                   | no resurrected duplicate clients (B-152)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Contacts                    | `phoneNormalize`                                                                                                                                                                                                          | E.164 normalization incl. double-prefix (B-154)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Media                       | `mediaBlobCache`, `uploadProgress`                                                                                                                                                                                        | LRU/caps, progress clamp+quantise                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Boot perf                   | `bootstrapDrainYield`                                                                                                                                                                                                     | first-boot drain must not starve the JS thread (B-155); one-commit hydration + N-30 referential stability                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Group rejoin                | `groupCallAttemptGen`, `groupCallRejoinRace`                                                                                                                                                                              | attempt generation + the rejoin in-flight mark (B-469, B-470); the rejoin must still consume its OWN producers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Rejoin ownership            | `groupCallRejoinHub`                                                                                                                                                                                                      | handler ownership tokens — a stale instance may not retire the live call's recovery (B-471)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Ring dedup                  | `ringDedupPresented`                                                                                                                                                                                                      | the marker burns on PRESENTED, never on "a handler exists" (B-306, B-474)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Ring screen                 | `groupRingScreenReuse`                                                                                                                                                                                                    | param reuse: per-ring 45 s timer, cancel-latch reset (B-473)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Call timers                 | `groupCallRoomScopedTimers`                                                                                                                                                                                               | the +5 s ICE snapshot, consumer rebuild and duration tick are room-scoped (B-475)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Ring park                   | `ringParkRecovery`                                                                                                                                                                                                        | a dead park re-arms the room (B-481); restore mode parks and has an exit signal (B-479)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Ring replay ack             | `messenger.gateway.calls.spec` (service) + `ringDedupPresented`                                                                                                                                                           | the reconnect replay is NOT cleared on emit — it waits for `sfu.ring.ack`, and only a `replayed` frame is acked (B-479)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Ring tones                  | `bravoTonesAudioMode`                                                                                                                                                                                                     | the tone slot survives stop→start in one tick, and a stop inside the load window cannot brick it (B-480, B-484)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Call identity               | `callRegistryIdentity`                                                                                                                                                                                                    | 1:1 registry keyed by `{callId, gen}`; non-re-entrant `endActiveCall`; one media-state handler per adopt (WI-1.1/1.2/1.4); remote-VERDICT ends are wire-silent ONLY via the explicit `{silentWire}` opt-in — never keyed on `source`, which is CallKit-glyph-coupled (B-565)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Group identity              | `groupCallRegistryIdentity`                                                                                                                                                                                               | group registry keyed by `roomId` + `gen`; ordered `ending` teardown before the slot clears (WI-1.5/1.6)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Answer arbitration          | `messenger.gateway.answer-arbitration.spec` (service)                                                                                                                                                                     | first answer wins server-side (`answeredBy`); duplicate answers idempotent-dropped + a DIRECTED loser hangup, never a room emit (B-554, B-561)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Ring lifecycle              | `messenger.gateway.ring-lifecycle.spec` (service)                                                                                                                                                                         | WS/HTTP decline parity, atomic MULTI artifact clears, `call.sync` (no oracle, rescue-aware), per-ring cancel identity (B-555/556/559/560, B-566)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Call sync probe             | `callSyncProbe`                                                                                                                                                                                                           | keyed hard-end on `ended`/`unknown` ONLY; keep-on-error; post-await gen re-check; wired at reconnect + resume (B-559)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Ring cancel identity        | `groupRingCancelIdentity`                                                                                                                                                                                                 | cancel matches ring identity on every surface; the `silentWire` population scan; the bare-'ringing' collapse guards (B-560/561/564)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Channel tree                | `channelTreeInteraction`, `channelTreeModel`, `departmentDirectoryRender`                                                                                                                                                 | G1: the WHOLE CARD toggles an expandable level — press it by `testID`, NEVER by label (the card is `accessible={false}`, so a label query silently hits the inner name area and the pin is decorative); G2: no door lost (admin pencil / member open button); G4: `nestParentedBroadcasts` refuses a parent `buildChannelTree` does not walk (B-569/B-572/B-573)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Channel admin scope         | `manageChannelsOrgScoped`, `inviteTeamPicker`, `managerOrgScope.spec` (service), `enterpriseJoin.spec` (service)                                                                                                          | G5/G6: `manager_scope_root_ids` is DERIVED from membership and fail-OPEN (`null`, never `[]`); a scope covering every root is not a scope; the invite PICKER narrows too; a teamless MANAGER invite is refused server-side, which is the real boundary (B-570/B-571/B-574/B-575/B-576)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Channel depth               | `department.hierarchyMigration.spec` (service), `department.service.spec`, `channelTreeInteraction`                                                                                                                       | B-590: every workspace gets FOUR visible levels — the trigger's one level allowance is EXACTLY parentless non-broadcast 1→0 (never a mid-tree lower); a legacy root promotes on its first structural child, workspace-only, best-effort under the broadcast unique index; the depth cap HIDES "+ Add sub-level" per node — a rendered button that no-ops is the bug                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Dept-registry writes        | `deptChannelsHiddenFromLists`, `channelHierarchyGrouping`                                                                                                                                                                 | B-593: the dept registry is written at MINT time (`provisionOnce`, the self-heal sweep, `onGroupLearned`) — it is NOT a projection of a `listChannels` response, or hiding a channel is a race against the network. Record the losing fork id too: the registry is additive, and that is what makes an orphaned local group permanently hideable                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Deleted conversations       | `conversationTombstones`                                                                                                                                                                                                  | B-594: a delete leaves a persisted owner-keyed tombstone, consulted by all FOUR minters. SUPPRESSION-ONLY — at the upsert, never the mirror walk, so the Merkle leaf set and the flush ledger are untouched (I3/I7); fail-open (I8); ids only (I9). A LIVE arrival lifts it, a replayed one does not — the replay brackets itself                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Conv mirror ledger          | `convMirrorLedger`                                                                                                                                                                                                        | B-648: idle boots ship NO conversation rows — conv versions share `mirror_flushed` under a `conv:` namespace, dedup at enqueue, hash = the SAME builder as the wire row (plaintext group_state), no merkle-pending from a conv flush                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Group call artifacts        | `groupCallArtifactTeardown`, `groupCallResourceRelease`, `callForegroundArbitration`                                                                                                                                      | B-595: End routes through `endActiveGroupCall` (the funnel that owns every artifact); `reportEnded` fires for GROUP calls too — both ring lanes raise a Telecom connection that only it removes; the already-started gate guards the START, never the cleanup registration; release iff NO group call is live (not "is the registry pointing at me")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Call diagnostics            | `callDiagTransition`                                                                                                                                                                                                      | `[CALLSM]` accepted-transition record wired in `setState`; latch + cancel-funnel report; ids/enums only (WI-7.1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Call-join latency           | `callLatLane`, `callLatMarkers`, `offer-ordering.spec` (svc), `turnCredentials`, `turnPrewarmWiring`, `groupBootStep3aWiring`, `sfu.service.parallel-transport.spec` (svc), `callFrameRouter`, `groupRingDepsReadyBypass` | B-596..B-604 (audit `CALL_JOIN_LATENCY_AUDIT_2026-08-20.md`, spec §21): server registers the call session BEFORE its first await + bounded block-check (B-596/597); session-wide TURN cache, single-flight, epoch-fenced invalidate + prewarm on every wake lane incl. the killed headless one (B-601); the group boot de-serializes — ceiling'd shared TURN, void'd presence, audio at `'joining'` off the BT prompt, parallel `consumeProducer` (B-598/599/600); the SFU join creates send+recv transports with `allSettled` NOT `Promise.all` — a one-sided reject must close the sibling, never leak it (B-604); group ring frames bypass the depsReady buffer like 1:1 call frames, epoch gate FIRST, `sfu.ring.missed` stays buffered (B-602). Ordering pins are source scans (no test imports `productionRuntime.ts`) — strip comments, `\r?\n`, anchor INSIDE the executing closure (a `lastIndexOf` epoch scan matched a sibling function and passed vacuously). DEFERRED-OPEN: 1:1 pre-built PC (2.2/2.4), audio-unpaused + batch consume (4.2/4.3/4.4), the killed-lane boot reorders (5.2/5.6/5.7) — all device-number-gated; A/B device sign-off (Step 6.4) owed |
| Notification liveness       | `msgBannerDismissBadge`, `headlessDrainNotify`, `fcmHeadlessRouting`, `inAppMessageForegroundRouting`, `messageToneGuards`, `chatLiveArrivalAnim`, `liveArrivals`                                                         | B-692: the alert model — 1.5 s per-thread floor (never the old 10 s per-conversation gag), a `messageId` alerts once EVER and is recorded only on an ACTUAL alert, and the `wakeFallback` 10 s collapse window is deliberately GLOBAL (sealed sender makes a sender-keyed wake banner unmatchable to its conv-keyed upgrade — scoping resurrects the N-29 double-sound). The killed-lane "checking" placeholder is LOW-channel SILENT (an audible one would ding per read receipt, P2-BR-3) and is ALWAYS retired on a drained outcome. Foreground commits route in-app INSIDE `onAfterCommit` (M16) and MUST bump `messagePostedGeneration` — without the bump the warm P2-6 fallback stacks a notifee ding on the in-app cue; only AppState `'active'` is foreground UI. The bubble entrance marks live arrivals in the render-phase `useMemo` — an effect-timed mark lands after the bubble's first render and the entrance is lost                                                                                                                                                                                                                                        |
| Notification liveness B-710 | `msgNotifLiveUpdate`, `backgroundMessageNotifier` (B-710 block), `msgBannerDismissBadge`, `msgWakeWarmBannerRules`, `push-chat-wake.spec` (service)                                                                       | B-710: a content-free wake draw may never KEY on a GUESSED conversation id — `fcmHeadless` resolves a DM locally, so keying on it lands on the store notifier's own notifee id and `displayNotification` REPLACES the rich card (and a group message resolves to the sender's DM, captioning the wrong thread). The guess rides as `convRouteHint` for the tap only. `headlessMode` is PROMOTED by a warm start — the headless task shares the app's JS VM, and a stuck flag makes `foregroundUi` and `isBackgrounded()` BOTH false with the app on screen, dropping every message for the process lifetime. The card is timestamp-ordered and `messageId`-deduped, and the shade header (`Notification.when`, Android's sort key) takes the NEWEST row so an older draw cannot regress it. The whole commit reaches the card via `preceding`, and the self-send filter runs BEFORE the newest row is chosen. `EventType.DISMISSED` is observed in both notifee handlers. The alert-collapse window is SENDER-scoped; only a wake that names no sender arms the global one                                                                                                    |
| Channel search              | `channelMessageSearch`, `sqlMessageStoreEngine` (B-636 block), `departmentDirectoryRender`                                                                                                                                | B-636: the Channels box searches message BODIES too. The conversation-id ALLOW-LIST is the scope boundary — an empty list returns NOTHING, never "no filter" — and `channelMessageHits` DROPS a row whose conversation is not in the caller's channel map, so org separation survives a bug in the SQL layer rather than depending on it. `LIKE` wildcards typed by a user are ESCAPED (backslash first, or it re-escapes its own output); `deleted_for_all` is `IS NULL OR = 0`, never a bare `= 0` (every pre-tombstone row is NULL, so the bare form hides the whole history). Multi-chunk reads MUST merge — gating the sort on "did we exceed the cap" returns chunk order whenever the total fits, which is the common case                                                                                                                                                                                                                                                                                                                                                                                                                                             |

### The call-registry identity rule (WI-1.1 / WI-1.5) — never write unkeyed

**Both call registries are IDENTITY-KEYED. Every write names the call it means to
mutate, and a mismatch is DROPPED with a `[CALLSM]` warn — it is never applied.**

```ts
patchActiveCall(ref, patch)          endActiveCall(ref, reason, source)     setMinimized(ref, min)
patchActiveGroupCall(roomId, patch)  setGroupCallMinimized(roomId, min)     renameActiveGroupCallRoom(from, to)
```

`ref` is `{callId, gen}` wherever the caller can know the generation (anything that
adopted or registered the call — `setActiveCall` RETURNS the key, keep it). A bare
`callId` string is the weaker form, for callers that genuinely cannot know a
generation: a server frame, the FGS notification action, a screen holding only a route
param. It still has to match the live id, so it can never hit a _different_ call.

- **`endActiveCall`'s `reason` and `source` are required on purpose.** With `ref`
  leading, `endActiveCall('ended')` would type-check as "end the call whose id is
  `'ended'`" — a no-op that reads as wired.
- **A patch can never change identity** (`callId`/`gen`/`roomId` are re-pinned after the
  spread). The one legitimate room rename has its own function, and it must be keyed on
  the id the registry HOLDS, not the one you are moving to.
- **"End whatever is live" is a real contract** for the overlay, signOut, the FGS action
  and the product switch — those read `getActiveCall()`/`getActiveGroupCall()` and pass
  that entry's own key, synchronously, at the moment they act.
- **`ending: true` on a group entry**: BUSY to the launch/join side, NOT LIVE to
  everything else (resume, rejoin, ring, UI). Full rationale in
  `docs/planning/CALL_RACE_HARDENING_SPEC.md` §13.
- **Both teardowns return an outcome** (`EndCallOutcome` / `GroupEndOutcome`:
  `'ended' | 'ending' | 'refused'`). If your next step assumes the call is gone, CHECK IT.
  A `void`/boolean return is what turned "await the teardown, then navigate" into
  "navigate now with the call still live", and what made the re-entrant caller run a
  duplicate CallKit report that stamped the wrong end-reason.

> **Two traps this work hit, both worth re-reading before Phase 2.**
> **(1) A teardown's `leave`/`hangup` callback mutates the registry.** `leaveInternal`
> nulls the slot itself, and `controller.hangup()` synchronously re-enters `endActiveCall`.
> So "is the slot still mine?" after an await is the WRONG question — ask "did a genuinely
> NEWER entry claim it?" (compare the monotonic `gen`, never the id).
> **(2) A mock that does not mutate the registry cannot see either.** Both P0s survived a
> green 507-suite run because the test doubles were inert. Model the real callback's side
> effects, or the pin is decorative.

**Several of these are static source scans**, because the code they guard (`productionRuntime.ts`,
`ChatScreen.tsx`, `VoiceNoteRecorder.tsx`) cannot be imported by the node Jest project. A source
scan is a real gate — but it is only as good as its anchor, so:

- **Strip comments before any ordering/absence assertion.** Prose containing the banned word is the
  single most common false result here (it has cost this repo a session).
- **These files are CRLF.** A `\n`-anchored regex matches nothing and the test passes VACUOUSLY.
  Use line-based scanning or `\r?\n`.
- **Anchor on the shape the CODE uses, not the one you'd write.** A scan for
  `INSERT INTO public.org_members` missed a real membership grant because this repo writes that
  table **unqualified**. Same class: asserting a token exists _somewhere in a file_ rather than at
  the decision site — `postMode` still appeared in a type signature after the param was deleted.
  Assert the site, and prefer `(public\.)?` / `\b` anchors.

### Two syntax traps that have each cost this repo real time

- **NEVER put a backtick in a comment inside a JS template literal.** SQL in this codebase lives in
  backtick strings, so a comment like ``-- `c.department` is NULL`` **terminates the string** and
  produces a baffling `TS2304: Cannot find name 'c'`. This has happened twice.
- **`perl -0pi -e` with `$1` / `\$` / backticks is unreliable here** (CRLF + shell escaping). A
  substitution that silently does not apply makes a mutation test report a **false GREEN** — the
  code was never mutated. **Always verify a mutation applied** (grep the region and print it)
  before believing a green result, and prefer a small `node` script _file_ over an inline `-e`.
- **A prose comment beginning with `@ts-expect-error` IS a directive to tsc.** Documenting a
  type-level pin with a comment like `// @ts-expect-error is load-bearing…` makes TS treat it as
  a real directive, report it TS2578-unused, and push the typecheck over baseline. Spell it
  "expect-error" in prose (same family as the comment-stripper and CRLF traps: a scanner reading
  prose as code).

### Flake rule (B-126 / B-153)

`test:crypto` has a history of intermittent, MOVING failures. **One red run is not evidence.** Run
it twice: a failure naming the same test both times is yours; one that moves is the known flake.
B-153 closed one real mechanism (`expo/virtual/env` is now mapped to a stub in the
`messenger-crypto` `moduleNameMapper`); a suite that imports `@utils/constants` should
`jest.mock` it — see `phoneNormalize.test.ts`.

---

## "The app feels laggy" / "the tap registers late" → READ THIS BEFORE PROPOSING A FIX

**This has been investigated with on-device measurement across two sessions
(B-279, B-285). Eight plausible causes are MEASURED DEAD ENDS. Do not re-propose
any of them without NEW numbers.** The founder asks about this repeatedly; the
answer below is what we actually know, and what is still open.

### What the symptom means

Founder's phrasing is diagnostic: _"the tap renders but the action takes time to
register"_, _"the app gets stuck for a couple of secs"_.

A `TouchableOpacity`'s press feedback is an **Animated opacity change that runs
without JS**. `onPress` is a **JS callback**. Feedback-now / action-later
therefore means the **JS thread was BUSY when the touch landed** — the touch was
never missed, it was queued behind something. Any "fix" that makes the button
more responsive-looking is treating the symptom.

Confirmed independently by Android itself, not just our own probe:

```
Looper PerfMonitor longMsg : wall=6177ms h=...MessageQueueThreadHandler
```

Single JS-queue messages of 6177 / 5479 / 4508 / 4131 ms on a Redmi Note 11.

### The GPU is NOT the bottleneck — measured, twice

`dumpsys gfxinfo` over a scripted, repeatable interaction, before any change:

| interaction    | janky | 99th | Slow UI thread | GPU |
| -------------- | ----- | ---- | -------------- | --- |
| scroll a chat  | 7.2%  | 20ms | 7/516          | 7ms |
| type a message | 29.9% | 36ms | 12/67          | 3ms |
| open a chat    | 20.5% | 61ms | 64/419         | 7ms |

GPU never came close to the 16.7ms budget. Every jank bucket that fired was
**"Slow UI thread"** — the UI thread **MOUNTING views**, not drawing them.

> **So: do NOT "fix the lag" by deleting shadows, gradients or blur.** That was
> the intuitive first answer and it is wrong — it costs the design and buys
> nothing. It needs a NEW measurement showing GPU-bound frames first.

### Measured dead ends — DO NOT RE-PROPOSE

| Candidate                                                                 | Result                                                                                          |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Shadows / bubble glow / gradients                                         | GPU idle (3-7ms vs 16.7ms). No effect.                                                          |
| Hooks in ChatScreen (87 of them)                                          | 2ms total. Not it.                                                                              |
| Message bubbles                                                           | 6-11ms for 10 rows. Not it.                                                                     |
| The composer                                                              | 0ms.                                                                                            |
| Gating closed modal subtrees                                              | 82ms → 82ms. **Zero** improvement (kept anyway — strictly less work per render).                |
| FlatList `windowSize` / `initialNumToRender`                              | Within noise on a short thread.                                                                 |
| Deferring the list to `runAfterInteractions`                              | **~2x WORSE** (janky 34.9% → 68.0%). Reverted.                                                  |
| Media encrypt / base64 decode                                             | Probes produced **no** `readUriBytes` / `encryptAttachment` lines during the founder's freezes. |
| 1:1 Signal send stages (session / ratchet / identity-key / sealed-sender) | Instrumented at >120ms; **no log lines at all**. Ruled out.                                     |

### What IS still open

Founder repro: **"after sending very fast messages, press back / do stuff and it
gets stuck."** Captured stalls:

```
19:42:46 383ms  19:42:47 192ms  19:42:48 391ms  19:42:49 349ms
19:42:51 497ms  19:42:52 448ms  19:42:54 352ms
19:42:58 3392ms 19:43:06 3356ms 19:43:10 2997ms
```

One **~350-500ms stall PER MESSAGE**, compounding into multi-second stalls as the
queue backs up. A back-press then waits behind the queued sends — which is
exactly the reported symptom.

**That lead was the right one — three costs found and FIXED 2026-08-22
(B-632..B-634).** The per-send backup work is where the structural cost lived. All
three are measured (V8 microbenchmarks, so a FLOOR — Hermes is several times
slower). Do not re-derive these; read `sqa.md` B-632..B-634.

| Cost                                                        | Scales with        | Paid by                 | Was                                          |
| ----------------------------------------------------------- | ------------------ | ----------------------- | -------------------------------------------- |
| `markDirty` — two linear scans, once per row marked         | whole history      | backup-enabled accounts | 214 ms → 1.74 s per chat-open (5k → 40k)     |
| `persist` — `partialize` + `JSON.stringify` per `set()`     | conversation count | **every** account       | 0.17 → 4.82 ms per `set()` (20 → 250 convos) |
| `notifyBackupDirty` inside the immer recipe → double-mirror | per mutation       | backup-enabled accounts | 2 encrypts + 2 server rows per mutation      |

Fixes, in one line each: the mirror dedup is a `Map` keyed `owner:id` (the ledger's
own primary key) instead of a scanned Set of composites; the persist adapter is a
`PersistStorage` that stringifies inside its 500 ms debounce instead of on every
`set()`; the ten dirty nudges moved out of their immer recipes behind
`flushBackupDirty`, with a queue guard so they no longer duplicate the subscriber.

**Three traps these fixes hit — re-read before touching this code.**

1. **`versionHash` does NOT cover `receipts`/`envelope_ids`** even though the backup
   wire (`serializeMessageForBackup`) does. So a receipt-only change has an
   unchanged hash, and `markDirty`'s forced invalidation is the ONLY thing that gets
   delivered/read ticks to the server. Deduping on version there silently
   reintroduces B-116. Widening the hash is not the fix either: it changes every
   stored ledger version, so the next boot re-uploads the whole history with fresh
   IVs — the I1 drift factory.
2. **The persist adapter's `getItem` must not be `async`.** An async wrapper adds
   microtask ticks before hydration resolves, which delays `onRehydrateStorage` and
   flips `DepartmentChannelsScreen`'s initial collapse seed —
   `departmentDirectoryRender` G4 went red ONLY under a full app-project run and was
   green in isolation. Mirror `createJSONStorage` tick-for-tick.
3. **A suite that goes green→red under load is not automatically the known flake.**
   That one was mine, and the way to tell was re-running the identical sweep on
   stashed sources. Do that before invoking B-126.

**Still not device-confirmed.** The `[LAGDIAG]` probes have been in the tree since
2026-07-27 and have STILL never been read off a phone. At ~1k messages these three
together are ~15 ms, which does NOT explain a 350-500 ms per-send stall — so on a
SMALL account they are not the whole story; they matter most on the accounts that
hurt most. Never instrumented at all: the SQLCipher write and the `[backup.merkle]`
commit cadence. Next step is a release APK on a device with real history, not
another static pass.

### How to measure it (the harness already exists)

- `src/utils/jsThreadWatchdog.ts` — fixed-period timer that reports its own
  wake-up drift, started from `MainNavigator`. Drift > 120ms = the thread was
  blocked that long, with a timestamp to correlate against other logs.
- **`console.warn` survives release builds.** `babel-plugin-transform-remove-console`
  strips `log` and keeps `warn`, and release is the only build worth measuring.
  Probes are tagged `[LAGDIAG]`.
- **Interleave A/B runs (OLD, NEW, OLD, NEW)** with scripted
  `adb shell input swipe/tap` — device thermal drift is larger than most of the
  effects being measured, so sequential runs lie.

### TWO MEASUREMENT TRAPS THAT HAVE EACH COST A SESSION

1. **A backgrounded app looks exactly like a stall.** Android suspends timers for
   a backgrounded process, so the interval simply never fires. The first watchdog
   reported "blocked ~4760ms" when the founder opened the system photo picker —
   the app was not blocked, it was not running. Android's own `PerfMonitor
longMsg` shares the confound. The watchdog now reports only when the app was
   `active` for the WHOLE interval **including a background round-trip that
   starts and ends inside one tick** (a naive two-sample check cannot see that —
   both samples read `active`).
2. **`experimental_backgroundImage` needs explicit colour-stop positions.** A stop
   without one takes the `else ->` branch in RN's Android
   `style/LinearGradient.kt` and logs `Unsupported type for radius property:
Null` — once per stop, per bubble, per commit (260 warnings in 50s on device,
   against 0 before the change). **The gradient renders correctly either way, so
   only a log check catches it.** Pinned by `chatListMountBudget.test.ts`.

### If asked "why is it still laggy?"

Answer honestly: the freeze is **real and JS-thread-bound**, proven by two
independent sources (our watchdog + Android's `PerfMonitor`). Eight candidates are
eliminated **by measurement**, one made it twice as bad. The remaining cause is
**not yet named** — and the next step is instrumenting the per-send work listed
above, not another guess.

---

## Keyboard / focused input → ONE rule, `useKeyboardLayout` (B-184)

**Any screen with a `TextInput` inherits the app-wide keyboard-inset rule. Never hand-roll
keyboard avoidance again — not a listener, not a padding formula, not a platform branch.**

```ts
import {useKeyboardLayout} from '@hooks/useKeyboardLayout';
const {overlap, safeBottom, bottomPad} = useKeyboardLayout();
```

> **THE BOTTOM-MOST ELEMENT OF A SURFACE OWNS THE KEYBOARD INSET.**
> It pads by `bottomPad(gap)`; nothing else in the tree reacts to the IME.

| Situation                                            | Use                                                    | Example                        |
| ---------------------------------------------------- | ------------------------------------------------------ | ------------------------------ |
| Bottom-anchored composer / sticky footer / sheet     | `bottomPad(gap)`                                       | `ChatScreen` composer          |
| Container that lifts a whole column (form, backdrop) | `overlap`                                              | modal backdrops, scroll forms  |
| A child inside an already-lifted container           | `safeBottom + gap`                                     | `JobDetailScreen` pledge sheet |
| A whole form with a scroll body                      | `<KeyboardAvoidingScreen>` (already built on the rule) | Register, ProfileCompletion    |

`bottomPad` **REPLACES** the safe-area inset while the keyboard is up — it never stacks on
it, because the IME is already covering the nav bar / home indicator. Stacking them is the
iOS "blind space".

### Why the raw RN number is never usable directly

- **Android API ≥ 30:** `ReactRootView.checkForKeyboardEvents()` reports
  `imeInsets.bottom − systemBars().bottom`, so under edge-to-edge (mandatory here) padding
  by it under-lifts by exactly `insets.bottom` — the "composer cut in half" bug. API < 30
  takes the legacy path, which already includes the bar, so the compensation is **API-gated**.
- **iOS:** `endCoordinates` is the keyboard frame in **window** coords and already spans the
  home indicator.

### Banned repo-wide (enforced by `src/hooks/__tests__/keyboardContract.test.ts`)

`KeyboardAvoidingView` · `keyboardVerticalOffset` · any `Keyboard.addListener` outside the
rule module · a `kbHeight` variable · `behavior={Platform.OS === 'ios' ? 'padding' : undefined}`.
KAV's `frame.y` is parent-relative, its offset prop inflates padding one-for-one,
`behavior="height"` leaves ghost space, and `behavior=undefined` does nothing on Android.

| Gate                   | Command                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| The arithmetic (23)    | `npx jest --selectProjects app --testPathPattern useKeyboardLayout`                                           |
| The contract scan (40) | `npx jest --selectProjects app --testPathPattern keyboardContract`                                            |
| Device pass            | `docs/qa/KEYBOARD_UI_TEST_PLAN.md` (Tier 1 = Pixel 7a gesture **and** 3-button nav + a home-indicator iPhone) |

Register: `docs/audits/KEYBOARD_INSET_AUDIT_2026-07-24.md` (B-184), earlier sweep
`docs/audits/KEYBOARD_FOCUS_AUDIT_2026-07-16.md` (B-84).

---

## UI / Design / frontend tasks → read `DESIGN_REVIEW_LOOP.md` FIRST

**For any task that changes, adds, or reviews a screen, component, layout, interaction,
visual style, colour/theme, or user flow, read `DESIGN_REVIEW_LOOP.md` at the repo root
before doing anything else.** It is the running design-review operating procedure and is
NOT auto-loaded. It defines:

- The iterate-until-clean loop (analyze → design → audit → improve → re-audit → stress-test).
- The **mandatory audit categories** (UX, responsive, safe-area/platform, accessibility,
  states, performance) and the **device/breakpoint matrix** (320→430dp, foldables, tablets,
  fontScale ≥ 1.3, real test devices).
- The **quality gates** (incl. G8 = **no design-system deviation**: the app surface is
  **obsidian** `#07090D` / cobalt `#5B8DEF`; any screen still on the legacy Command-Navy
  palette is a Major to migrate — everything must be consistent).
- How to run it under ultracode (fan-out auditors via the Workflow tool, adversarial verify,
  then fix) and the per-iteration deliverable format + scores.

Design review composes WITH (does not replace) `LOOP.md` — still verify, audit, and risk-review.

---

## Project Instructions

Always read LOOP.md first.

LOOP.md defines your operating procedure.

Every task must follow LOOP.md.

Load these skills before starting:

- skills/android.md
- skills/supabase.md
- skills/ssh.md
- skills/deployment.md
- skills/notification.md

Never skip verification.

Never skip audit.

Never stop after implementation.

## Documentation layout

Most project docs live under **`docs/`** — see [`docs/README.md`](docs/README.md) for the full index.

| Location               | Purpose                                                                        |
| ---------------------- | ------------------------------------------------------------------------------ |
| Repo root              | `README.md`, `CLAUDE.md`, `AGENTS.md`, `sqa.md` (agent + QA entry points)      |
| `docs/CODEBASE_MAP.md` | Codebase hunting tree (surfaces, modules, file index)                          |
| `docs/architecture/`   | Security, compliance, messenger backend design                                 |
| `docs/audits/`         | Audit reports                                                                  |
| `docs/qa/`             | Checklists, case studies, `analysis.md`                                        |
| `docs/handoffs/`       | Per-bug developer handoff notes                                                |
| `docs/planning/`       | Roadmaps, deploy plan, `REMAINING_TODO.md`                                     |
| `docs/runbooks/`       | Ops procedures — incl. `LITE_BOOKING_LOOP.md` (run when touching Lite booking) |
| `docs/openapi/`        | API specs                                                                      |

---

<!-- code-review-graph MCP tools -->

## MCP Tools: code-review-graph

**IMPORTANT: This project has a knowledge graph. ALWAYS use the
code-review-graph MCP tools BEFORE using Grep/Glob/Read to explore
the codebase.** The graph is faster, cheaper (fewer tokens), and gives
you structural context (callers, dependents, test coverage) that file
scanning cannot.

### When to use graph tools FIRST

- **Exploring code**: `semantic_search_nodes` or `query_graph` instead of Grep
- **Understanding impact**: `get_impact_radius` instead of manually tracing imports
- **Code review**: `detect_changes` + `get_review_context` instead of reading entire files
- **Finding relationships**: `query_graph` with callers_of/callees_of/imports_of/tests_for
- **Architecture questions**: `get_architecture_overview` + `list_communities`

Fall back to Grep/Glob/Read **only** when the graph doesn't cover what you need.

### Key Tools

| Tool                        | Use when                                               |
| --------------------------- | ------------------------------------------------------ |
| `detect_changes`            | Reviewing code changes — gives risk-scored analysis    |
| `get_review_context`        | Need source snippets for review — token-efficient      |
| `get_impact_radius`         | Understanding blast radius of a change                 |
| `get_affected_flows`        | Finding which execution paths are impacted             |
| `query_graph`               | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes`     | Finding functions/classes by name or keyword           |
| `get_architecture_overview` | Understanding high-level codebase structure            |
| `refactor_tool`             | Planning renames, finding dead code                    |

### Workflow

1. The graph auto-updates on file changes (via hooks).
2. Use `detect_changes` for code review.
3. Use `get_affected_flows` to understand impact.
4. Use `query_graph` pattern="tests_for" to check coverage.

---

# Claude Project Context — Bravo Secure

Claude is the primary AI assistant for Bravo Secure and should be treated as the main source of project knowledge. Claude has end-to-end context of the architecture, codebase patterns, business rules, and implementation details across mobile, ops-console, and the backend services.

## Claude responsibilities

- Claude has full context of the project and should be used for most implementation, refactoring, debugging, and documentation tasks.
- Claude is the default assistant for both the React Native mobile client and the Next.js ops console, as well as the NestJS backend services.
- Claude should handle all tasks except those that are explicitly security-sensitive or restricted by the System Architecture Documentation.
- For security-related decisions (encryption, key handling, message routing, access control, sensitive data flows), Claude must refer to the **System Architecture Documentation** as the source of truth and follow the documented constraints exactly.

## Technology stack

- **Mobile (primary stack):** React Native 0.81 + Expo SDK 54, TypeScript 5.9, React 19, Zustand, React Navigation 6, `react-native-webrtc`, `react-native-callkeep`, `@op-engineering/op-sqlite` (with SQLCipher), `@privacyresearch/libsignal-protocol-typescript`, `@react-native-firebase/*`, `react-native-keychain`.
- **Ops Console (secondary stack):** Next.js 15 (App Router), React 19, TypeScript 5.7, SWR, Tailwind, `idb`, `socket.io-client`, `mapbox-gl`, `@privacyresearch/libsignal-protocol-typescript`.
- **Backend services:** NestJS (Node 18+, TypeScript). Two services live under `apps/`:
  - `apps/auth-service` — auth, ops endpoints (`/ops/*`), agents, bookings, missions, payouts, signal-keys.
  - `apps/messenger-service` — relay (HTTP) + WS gateway, sender-cert issuance, sealed-sender envelopes, group messaging, file vault.
- **Shared package:** `packages/messenger-core` — platform-agnostic libsignal wrapper, sealed-sender v2, group crypto, transport protocol types. Mobile is the source of truth; ops-console consumes via `@bravo/messenger-core`. Path aliases (no npm workspaces).
- **Persistence:** Postgres (auth-service), SQLCipher (mobile local), IndexedDB + AES-GCM (ops-console vault), Redis (messenger-service WS adapter).
- **Tooling:** Jest (split projects: `app`, `messenger-crypto`, `booking`), ESLint, Prettier, Husky, `patch-package`, EAS Build, GitHub Actions.

## Security constraints

The screenshot from the System Architecture Documentation is the contract. Do not deviate from it.

- **Do not invent security behavior.** If a behavior isn't documented, ask before implementing.
- **Encryption (locked, do not change without architecture approval):**
  - Signal Protocol via libsignal-typescript — Double Ratchet for message body encryption, X3DH for key agreement, Sealed Sender v2 for metadata protection.
  - Local message store: SQLCipher-encrypted SQLite. Message keys are derived per-session and stored separately from message ciphertext.
  - Media attachments: AES-256-CBC, unique key per file, encrypted locally before upload to S3-compatible storage. Key shipped in-band inside the encrypted message envelope.
  - WebRTC voice/video: PeerConnection established via the signalling service. ICE candidates exchanged over WebSocket. Media encrypted via DTLS-SRTP.
  - Disappearing messages: client-side timer; deletion instruction is also sent to the server to purge the relay cache.
- **Backing service (`messenger-service`) constraints — do not violate:**
  - The relay only transports messages. It stores messages **transiently** until the recipient device fetches. Maximum dwell time: **30 days** (Signal protocol default).
  - Group messaging is via sealed-sender broadcast. Group state (membership, admin list) is encrypted with the group master key and shared via pairwise Signal sessions. The relay does not see group plaintext.
  - The WebSocket gateway handles presence (online/offline dots), typing indicators, and read-receipt fan-out. None of these carry message content.
  - **File Vault MFA:** the files-service enforces a fresh biometric / TOTP challenge before returning download URLs, regardless of valid JWT. Do not bypass this gate.
- **Stop conditions — verify against the architecture reference before proceeding when a change could affect:**
  - Encryption primitives (algorithm, mode, key length, IV/nonce handling)
  - Sealed-sender envelope shape, sender-cert verification, or AAD binding
  - Group master key distribution, rekey on member removal, or epoch handling
  - Auth tokens (JWT, refresh, sender certs), session storage, biometric/TOTP gates
  - Relay dwell semantics, ack/retract tokens, or envelope ID handling
  - File vault MFA gate or any download URL issuance flow
- **Never log plaintext message bodies, decrypted media, key material, or ArrayBuffers that contain key bytes.** A static log-audit test (`src/modules/messenger/__tests__/logAudit.test.ts`) enforces this across `src/modules/messenger`, `apps/messenger-service/src` and `packages/messenger-core/src` — do not bypass it by renaming variables.
- **Never weaken transitions:** if a check exists (e.g. `verifySenderCert`, `verifySealedAad`, biometric gate), do not add a "skip in dev" branch unless the architecture doc allows it.

## Build, run, and test commands

All commands are run from the repo root unless noted otherwise.

### Mobile (React Native + Expo)

- Install dependencies: `npm install`
- Run dev server (Metro): `npm start` (or `npm run start:staging`)
- Run on Android: `npm run android` (or `npm run android:staging`)
- Run on iOS: `npm run ios`
- Build release APK (staging): `npm run apk:staging`
- Build release APK (local backend): `npm run apk:local`
- EAS staging build: `npm run eas:build:staging`
- EAS production-style local build: `npm run eas:build:local`

### Ops Console (Next.js)

- Install: `cd apps/ops-console && npm install`
- Dev server: `cd apps/ops-console && npm run dev` (port 3002)
- Production build: `cd apps/ops-console && npm run build`
- Production start: `cd apps/ops-console && npm start`
- Lint: `cd apps/ops-console && npm run lint`
- Typecheck: `cd apps/ops-console && npm run typecheck`

### Backend services

- `apps/auth-service` and `apps/messenger-service` each have their own `package.json` with `npm run start:dev`, `npm run build`, `npm test`. Run them from inside the respective directory.

### Tests

- All tests: `npm test`
- Crypto tests only (fastest signal): `npm run test:crypto`
- Booking flow tests: `npm test -- --selectProjects=booking`
- Changed-only since main: `npm run test:changed`
- Coverage: `npm run test:coverage`
- Mutation tests on crypto (slow): `npm run mutation:crypto`
- Flake-detect crypto suite: `npm run flake:crypto`

### Quality gates

- Typecheck (mobile): `npm run typecheck` — must NOT exceed the baseline error count in `.tsc-baseline.json` (currently **47**). Use `npm run tsc:rebaseline` only when intentionally lowering the count.
- Lint: `npm run lint` (or `npm run lint:fix`)
- Dead code: `npm run deadcode` (knip)
- Audit: `npm run audit:high`
- SBOM: `npm run sbom`
- Bundle size: `npm run size`
- Local CI bundle (fast): `npm run ci:local`
- Full CI bundle: `npm run ci:full`

## Style rules

- **Module system:** ES modules + TypeScript. `import`/`export` only — no `require()` except in legacy patch-package shims.
- **Indentation:** 2 spaces. No tabs.
- **Quotes:** single quotes for strings, double quotes only inside JSX attributes.
- **Naming:**
  - Files: `camelCase.ts` for modules, `PascalCase.tsx` for React components, `kebab-case.sql` for migrations.
  - Functions/variables: `camelCase`. Types/interfaces/classes: `PascalCase`. Constants that are truly immutable global config: `SCREAMING_SNAKE_CASE`.
- **Folder structure:**
  - Mobile UI lives under `src/screens/`, `src/components/`, `src/navigation/`. Stores under `src/store/`. Cross-cutting modules under `src/modules/<domain>/`.
  - Ops Console follows Next.js App Router conventions under `apps/ops-console/src/app/`. Shared lib under `apps/ops-console/src/lib/`.
  - Shared platform-agnostic crypto under `packages/messenger-core/src/`.
- **Imports:** prefer the established path aliases — `@/`, `@screens`, `@components`, `@modules`, `@bravo/messenger-core`. Avoid `../../../` ladders.
- **Comments:** default to writing none. Add a short `// Why:` line only when the reasoning is non-obvious (a workaround, a hidden invariant, a security-relevant decision). Never narrate what the code does.
- **Small, focused changes:** prefer minimal diffs. Don't refactor or rename when the task is a bug fix.
- **Reuse before abstracting:** check for an existing helper, hook, or pattern before introducing a new one.

## Change safety rules

Every change must clear these gates before being considered complete:

1. **Direct test:** the new behavior is exercised by at least one new or modified test.
2. **Regression test:** the most closely related existing flow is re-run (e.g. for a sealed-sender change, run `npm run test:crypto`; for a booking change, run the `booking` Jest project).
3. **Typecheck:** `npm run typecheck` (mobile) and `cd apps/ops-console && npm run typecheck` — neither may exceed its baseline.
4. **Targeted first, broad second:** run the narrow suite first to fail fast, then the wider suite (`npm test`) before declaring done.
5. **No behavior change without a test failing first:** when refactoring, the existing tests must still pass; when fixing a bug, write the failing test first whenever practical.
6. **Verify nearby flows:** for example, a change to `productionRuntime.ts` requires re-running the messenger-crypto suite AND a manual smoke (boot app, send + receive a 1:1, send + receive a group message).
7. **Do not commit on a red gate.** Pre-push hooks enforce typecheck-baseline; do not skip with `--no-verify`.
8. **Self-diff every change against the previous version before shipping it (founder standing rule, 2026-07-30).**
   After changing code — and again before building/committing — re-read your own
   `git diff` (against HEAD, and against the last shipped tag/commit when the
   change ships) hunting specifically for regressions the tests can't see:
   - For every piece of state/data your change deletes, moves, or rewrites,
     **enumerate its live consumers first** and check each one still works.
     B-339 shipped exactly because the B-337 purge deleted a group's key + row
     without checking who was consuming them (a live call was — the member got
     stranded in it).
   - For every shared symbol whose signature or behaviour changed, run the
     MESSAGE_LOOP §5 caller-completeness sweep — list ALL call sites and prove
     each one is either updated or unaffected.
   - Then diff the OLD path against the NEW path end-to-end for the flow you
     touched (the b/w "what did the working version do that mine no longer
     does?" question). A green suite is NOT evidence here — no test imports
     `productionRuntime.ts`, and B-125's data loss shipped on a fully green run.

## UI / feature verification

For UI or frontend changes, type-checking and unit tests verify code correctness, not feature correctness. If you changed a screen or interaction:

- Boot the dev server and exercise the feature.
- Test the golden path AND at least one error path (e.g. offline, denied permission, cancelled flow).
- Check for regressions in adjacent screens (e.g. a change to `LiveTrackingScreen` should not break `DashboardScreen`).
- If the UI cannot be tested in the current environment (e.g. native modules require a device), say so explicitly rather than claiming success.

## Working rule

**When unsure, inspect the codebase first.** Read the established pattern, the architecture documentation, the security reference. Don't guess. The MCP code-review-graph (top of this file) is the fastest way to find the right pattern.

If a task touches anything in the **Security constraints** section above, stop and verify against the System Architecture Documentation before writing code.
