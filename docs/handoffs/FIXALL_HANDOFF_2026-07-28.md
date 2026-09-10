# FIX-ALL campaign handoff — 2026-07-28 (session ended mid-flight)

> ✅ **RESOLVED (2026-07-28, session 2):** every item below is DONE — §3.1 minors finished,
> B-187 landed (schema v19), B-236u wired, #5/#11/#14/#15/#16/#17 all landed, gates run,
> committed. See sqa.md's EOF entry "FIX-ALL campaign completion — 2026-07-28 (session 2)".
> This file is retained as the historical record of the mid-flight state only.

> **Read this before touching anything.** The tree is UNCOMMITTED and holds a mix of
> COMPLETE fixes (tested, RED→GREEN proven) and PARTIAL work from subagents the founder
> stopped mid-task. Nothing here is pushed. `git stash` or `git checkout --` will destroy
> finished work — don't. The founder's instruction was **"fix all"** (all fixable gaps from
> the edge-case audit), then "write this handoff".

## 0. What this campaign is

1. `docs/audits/CALL_MESSAGE_EDGE_CASE_AUDIT_2026-07-28.md` — 78-case WhatsApp/Signal
   edge-case benchmark vs our codebase, evidence-backed (written this session, untracked).
2. "Fix all" = fix every gap that is NOT (a) arch-gated by CLAUDE.md stop-conditions
   (B-237 epoch, GF-2 key fan-out, B-128p2 AAD, M4 call-key namespace, SYNC-4, B-221/222/225),
   (b) blocked external (APNs cert P-1, iOS/Mac build, device matrices), or
   (c) product-scale features (multi-device, view-once, PSTN hold, PiP, resumable upload).
3. **A recurring discovery: several audit rows were STALE.** B-262a, B-227, B-234, B-235
   were already fixed in the tree (fixed in the 07-24 batch / 07-28 stability sweep;
   sqa.md status lines lag). ALWAYS verify a bug still reproduces before re-fixing —
   four tasks closed as "already-fixed, verified" this session.

## 1. COMPLETE fixes in the tree (tested, do not redo)

| Fix                                                            | Files                                                                                                                                                                                                                                                                                                                                                    | Tests (all RED-first, green now)                                                                                                                                                                                          |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **W4.2** busy device must not raise a 2nd system call surface  | `src/navigation/MainNavigator.tsx` (Telecom/cache block MOVED below both busy branches), `src/modules/messenger/push/fcmBootstrap.ts` (registry busy-guard above ringers, marker comment `W4.2 —`, log anchor `[ring.fcm] busy`)                                                                                                                         | `callEdgeGuards.test.ts` → new `W4.2` describe (2 tests)                                                                                                                                                                  |
| **B-321 residual** parked-ring TTL expiry writes missed bubble | `src/modules/messenger/webrtc/pendingGroupRing.ts` (expiry timer + lazy backstop → shared `appendMissedGroupCallBubble`, stableId `missed-group-<roomId>`)                                                                                                                                                                                               | `pendingGroupRingExpiryBubble.test.ts` (6, mutation-proved) — by subagent, finished                                                                                                                                       |
| **B-236u** route-pick queue-and-apply (logic layer)            | `src/modules/messenger/runtime/callAudioRoute.ts` → new `createRoutePickQueue`                                                                                                                                                                                                                                                                           | `routePickQueue.test.ts` (11, mutation-proved) — by subagent, finished. **SCREEN WIRING STILL OWED** (see §3.2)                                                                                                           |
| **B-238** server `not_host` redial dead-end                    | `apps/messenger-service/src/sfu/sfu.service.ts` (createRoom resolves via `findRoomForConversation`, corpse reaped; new `endRoomIfEmptyByHost`), `messenger.gateway.ts` (ring-cancel calls it after auth gate)                                                                                                                                            | `sfu.service.stale-room.spec.ts` (5) + 2 in `messenger.gateway.sfu-auth.spec.ts`; 11 suites/64 tests green; service typecheck clean. Residual documented: host KILLED mid-ring within 30s grace can still leak the corpse |
| **MM-05** reaction-to-deleted guards (3 tiers)                 | `src/modules/messenger/runtime/pendingReactionApply.ts` (`deleted_for_all` guard in window tier / disk tier / drain-discards-stash)                                                                                                                                                                                                                      | `pendingReactionApply.test.ts` +3 MM-05 tests                                                                                                                                                                             |
| **MS-10** send-side payload caps                               | `src/modules/messenger/runtime/productionRuntime.ts`: module consts `MAX_MESSAGE_CHARS=65_536`, `MAX_ATTACHMENT_BYTES=100MB`; text cap below append via `failGroupSend`/`failDirectSend` (M3-safe); sendMedia byte cap below append, before upload. **Why it matters: WS gateway hard-caps frames at 256 KiB (`apps/messenger-service/src/main.ts:38`)** | `payloadCaps.test.ts` (3 source-scan tests)                                                                                                                                                                               |
| Receipt-regression consistency (minor f)                       | `messengerStore.ts` `recordReadReceipts` now routes through `isStatusRegression` (behaviorally equivalent today; drift guard)                                                                                                                                                                                                                            | covered by existing receipt suites (40 green)                                                                                                                                                                             |
| B-235 header-comment truth-up                                  | `msgBannerDismissBadge.test.ts` comment-only (suite header contradicted the flipped test)                                                                                                                                                                                                                                                                | n/a                                                                                                                                                                                                                       |

Also verified-already-fixed (no code change): **B-262a** (`errorBannerLifecycle.test.ts` green),
**B-227** (fcmBootstrap:~1119 comment cites it, 20s+bail), **B-234** (`serverWakeTapRouting.test.ts:405`),
**B-235** (window-aware eviction, mutation-proved red-capable by agent).

## 2. IN-FLIGHT: B-187 group ✓✓ all-legs (I was mid-edit — design is FINAL, finish it)

**Contract target is written in `groupTickFirstLegWins.test.ts`'s own header** ("WHEN THE REAL
FIX LANDS" — flip test 1 to `'sent'`, test 3 to `toHaveLength(3)`).

**Design (settled after reading all mechanism files):**

- New `LocalMessage.retract_tokens?: Record<userId,string>` — ✅ **DONE** (`store/types.ts`, the
  only B-187 edit already applied).
- `crypto/db.ts`: SCHEMA_VERSION 18→**19**; add `retract_tokens_json TEXT` to the idempotent DDL
  list (~line 225 cluster) AND a `fromVersion < 19` block copying the v17 pattern (~line 883).
- `store/sqlMessageStore.ts`: `MessageRow.retract_tokens_json`; `doUpsert` serialize + add column
  to INSERT list (27→28 cols — count the `?`s); `rowToMessage` parse (safeJson).
- `store/messengerStore.ts`:
  - `updateMessageRetractToken` (line ~1052): when `recipientUserId` given, ALSO first-wins-write
    `msg.retract_tokens[recipientUserId]`.
  - NEW action `recordDeliveredReceipt(conversationId, messageId, userId, ts)` (+ interface decl):
    writes `receipts[userId]={status:'delivered',ts}` unless already `'read'`; flips status
    `sent→delivered` ONLY when every member of the required set has delivered|read;
    required set = **participants(non-self) ∩ shipped envelope_ids keys** (the exact B-186 read-rule
    pattern at `recordReadReceipts` — copy its `_ownAuthUserId ?? _ownUserId` + intersection code);
    `syncLastMessageStatus` + `notifyBackupDirty` like siblings. **Accepted, documented limitation:**
    a short premature-flip window while fan-out is incomplete (same as read rule); B-143's
    any-leg-destroyed→undelivered still overrides (undelivered is off-ladder → allowed over delivered).
- `runtime/envelopeDelivered.ts`: leg match (entry in `envelope_ids`) → if status!=='sent' return 0;
  else `recordDeliveredReceipt(...)` and return 1 only if status became 'delivered' (re-read state).
  Scalar match (no map) keeps today's behavior. Update the header contract comment.
- `runtime/httpReceiptReconcile.ts` `selectReceiptProbes`: rows with `envelope_ids` **and**
  `retract_tokens` → one probe per leg `{envelopeId: envelope_ids[u], retractToken: retract_tokens[u]}`,
  skipping legs whose `receipts[u]` is delivered|read and ids in `skip`; rows with map but NO
  tokens map (pre-v19) → grandfather to today's scalar single probe; keep window/MAX_PROBES.
- `runtime/productionRuntime.ts` live group fan-out (~line 3516-3544, anchor `firstRetractToken`):
  collect per-recipient tokens like `envelopeIdByRecipient` and call
  `updateMessageRetractToken(conversationId, msgId, token, recipientUserId)` per leg (keep the
  scalar first-wins call). The outbox drain site (~9081) ALREADY passes recipientUserId → map
  write comes free. WS `handleAccepted` (~6787) is 1:1-only by design — leave scalar.
- `backup/backupWireV3.ts`: mirror `retract_tokens` beside `envelope_ids`/`receipts`/`retract_token`
  (serialize ~line 121-135 + the parse side) → **this reaches backup ⇒ run BACKUP_LOOP §4 gates**.
- Tests: flip `groupTickFirstLegWins.test.ts` per its own header (rename describe to "…all-legs (B-187 fixed)"),
  add: all-3-legs→delivered case; read-wins-over-late-delivered; grandfather single-probe case;
  partial-probe case (only undelivered legs probed); keep test 4 semantics (delivered rows leave probe set).
  Suites that must stay green: `groupReceiptTokenPairing`, `receiptRestoreFidelity`, `envelopeLegParity`,
  `messageTicks`, `sqlMessageStoreEngine` (REAL sqlite — column changes hit it), `conversationListTicks`,
  `messageStatusMonotonic`, `groupReadReceipts`, `groupBlueTickOwnerKey`.
- **§5 caller-completeness (enumerated, paste into commit body):** `applyEnvelopeDelivered` callers =
  `productionRuntime.ts:6594` (WS frame; inherits, no change) + `httpReceiptReconcile.ts:90` (inherits).
  `selectReceiptProbes` = reconcile + tests. `updateMessageRetractToken` = pR:1109 (1:1 resend, scalar ok),
  :3539 (group first-token — EXTEND per-leg), :3878 (1:1 HTTP fallback, scalar ok), :6799 (WS accepted,
  1:1-only, scalar ok), :9081 (outbox drain, already attributed). Line numbers rot — re-grep symbols.

## 3. NOT STARTED / PARTIAL — remaining work items

### 3.1 ⚠️ PARTIAL: minors bundle agent was KILLED mid-task — tree has its half-done edits

Files: `chatScreenLogic.test.ts` (+38), `chatScreenMutationUi.test.ts` (+14), `mediaBlobCache.test.ts`
(+29/-mods), `peerPresence.test.ts` (+10), `replyJumpParity.test.ts` (+24), `ui/chatScreenLogic.ts` (+13),
`ChatScreen.tsx` (+16/-12). Agent's last state: "confirm RED across all five items before applying the
fixes" — i.e. **test edits are in; source fixes are partly in (chatScreenLogic.ts/ChatScreen.tsx were
touched); `mediaBlobCache.ts` and `peerPresence.ts` sources are NOT touched → those suites are likely
RED right now.** Items it was doing: (1) previewForReply voice/video typed labels, (2) reply-to-deleted
guard/hide, (3) reply-jump `X#n` fork fallback, (4) mediaBlobCache over-cap put invalidation,
(5) formatLastSeen year. \*\*First step next session: run
`npx jest --selectProjects messenger-crypto --testPathPattern "replyJumpParity|mediaBlobCache|peerPresence|chatScreenLogic"`

- the app-project chatScreen suites, diff the 7 files, then FINISH each item (small) or revert that file's hunk.\*\*

### 3.2 B-236u screen wiring (logic done, wiring owed)

Per the finished agent's note: in CallScreen + GroupCallScreen session effects — create queue with
`apply` = the screen's route-apply primitive (`pickAudioRouteNative` in CallScreen, keeps BS-CALL-CHOPPY
de-dupe); route `pickAudioRoute` through `queue.pick(next)` + `openingSettleRef.current?.cancel()`
(still latching `preferredRouteRef`); feed `queue.onDeviceList(list)` from `onAudioDeviceChanged` AFTER
the settle call; `queue.clear()` in cleanup. `routePickQueue.test.ts` composition test pins the order.
Also still owed from the audit: a visible current-route (BT) indicator in call UI.

### 3.3 Untouched tasks (killed before starting — specs were in their prompts, reproduce from audit doc)

- **#5 IOSMSG-1/2/3**: iOS `showMessageNotif` early return; iOS permission request +
  `registerDeviceForRemoteMessages` in fcmBootstrap; server apns-priority 5 + content-available for
  data wakes. NOTE agent found `or3IosBannerLane.test.ts` exists — READ IT FIRST, iOS lane may be
  partially handled (another possible stale-audit row).
- **#11 drafts persistence**: store slice + persistence, restore into composer, clear on send.
- **#14 B-239 visibility**: server warn per token-less ring member + fan-out summary; one-shot boot
  warn when APNs env unset; token-health script/endpoint (auth-guarded only).
- **#15 CN-09 poor-connection banner**: `call.stats` (rtt/jitter/loss, 1 Hz, tag `[bravo.callquality]`)
  → debounced banner on both call screens (obsidian tokens; DESIGN_REVIEW_LOOP applies).
- **#16 MM-09 forwarded label**: additive `isForwarded` inner-payload field + "Forwarded" chip.
- **#17 CA-07 DND row** in NotificationReliabilityCard (+ possible small native read → APK rebuild note)
  - **MD-08 free-space prechecks** (media download via `attachmentError` new reason; restore start via
    existing error surface; fail OPEN; BACKUP_LOOP additive-only).

## 4. Gates & commit protocol (task #18 — NOT run yet)

Per MESSAGE_LOOP §7 + CLAUDE.md, in order: invariant suites → `npm run test:crypto` **TWICE** (moving
failure = B-126 flake; same-name failure = yours) → `npx jest --selectProjects app --testPathPattern
"screens/messenger"` → `npm run typecheck` ≤ **47** (was 46 mid-session) → `npm run lint`. Backend:
`cd apps/messenger-service && npm test && npm run typecheck`. B-187 touches backup mirror ⇒ BACKUP_LOOP
§4 (backup/merkle suites) too. Commit in logical units (one fix per commit; caller lists in B-187 commit
body); update `sqa.md` per fix (bug-regression contract; also log B-238's server fix + new bug numbers
for anything found); refresh the audit doc's status column; **do not commit on red; never `--no-verify`**.

## 5. Session gotchas worth keeping

- **sqa.md statuses lag the tree** — 4 of my first 5 "open" bugs were already fixed. Verify first.
- WS gateway `ws.maxPayloadBytes` = 256 KiB — the real reason MS-10 matters.
- `callEdgeGuards` scans can flash-fail if another process is mid-edit of a scanned file (moving failure, ignore per B-126 rule).
- Killed-agent tasks notify with their last inner monologue as "result" — do not trust those lines as completion claims.
- Founder killed the 4 parallel agents ~22:3x — prefer INLINE work over agent fan-out unless asked.

**Task-list mirror (harness):** #1-4,7,8,13 done · #6 logic-done/wiring-owed · #9 partial (agent killed)
· #10 done · #12 in-flight (design final, §2) · #5,11,14,15,16,17,18 pending.
