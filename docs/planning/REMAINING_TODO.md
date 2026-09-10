# Bravo Secure — Remaining TODO (post-v1.0.13)

This document captures everything that v1.0.13 did NOT fully address, so it doesn't get lost between sessions.

---

## Scale-out project (audit #3/#10 — the full fix behind the replica guard)

The 2026-08-14 `ReplicaGuardService` makes >1 messenger-service replica
refuse to start (loud), which is the audit's sanctioned stopgap. To actually
SCALE OUT, this project must land first: promote `callSessions` to
short-TTL Redis hashes (audit #3, M) and give the SFU room→pod affinity or
externalized room state (audit #10, L). Until then the guard stays and
`REPLICA_GUARD=off` must never be set in production.

## DEFERRED by founder 2026-08-14: audit #2 — ops-console receive pipeline

Audit 2026-08-13 finding #2 (P0): the ops-console runs a PARALLEL receive
pipeline with none of mobile's guarantees — unconditional acks (even on
transient failure), no seen-set, no transaction around ratchet+message
writes (`apps/ops-console/src/lib/messenger/runtime.ts` ~:704-800). This is
the live B-125 data-loss shape on a second platform: an ops tab refresh
between decrypt and IndexedDB write loses the message PERMANENTLY (the
relay already got the ack). Founder chose to defer. **Until fixed, treat
the ops-console messenger as lossy under any interruption** — mobile
remains the durable record. Fix shape per the audit: port the mobile
posture (persistent seen-set, ack only after store write, transient-vs-
terminal ack split).

## APPLY the B-6 migration (audit 2026-08-13 B-6 — the fix is inert until this runs)

`supabase/migrations/20260814190000_put_identity_rotation_atomic.sql` must be
applied to the live database (migrations do NOT auto-deploy — the D6-e
incident). Until then, messenger-service's `putIdentity` logs ONE loud error
(`put_identity_rotation_atomic MISSING`) and falls back to the legacy
non-atomic sequential path — i.e. the B-6 crash windows (old identity over a
wiped mirror; partial wipes) remain open in production. After applying:
verify the error log goes quiet and a backup re-setup logs
`wiped ATOMICALLY`. Also run the BACKUP_LOOP §5 fresh-install restore
round-trip on the next release.

## M4 remainder (audit 2026-08-13 #9) — TWO limbs, only ONE is arch-gated

The 2026-08-15 M4-lite slice gave the `'Call'` sentinel ONE home
(`messagingLogic.isCallGroupName`/`isCallGroupState`/`CALL_GROUP_NAME`,
scan-pinned) — the duplicate-copy class is dead. M4 itself has two limbs
(MESSAGE_LOOP: "never filed without an explicit ephemeral marker, AND
every ephemeral key has a teardown — no call-end teardown, no TTL"):

**Limb 1 — the wire field (ARCH-GATED, founder + architecture-doc
decision).** A dedicated marker (`isCallGroup`/`ephemeral`) on the
group-create state so receivers stop classifying by display name.
Constraints for the design: the field must live INSIDE the encrypted
group state (CLAUDE.md: the relay does not see group plaintext — it must
not learn which groups are calls); `GroupState` is consumed by
`packages/messenger-core` AND ops-console, so both type copies move
together; wire-compat shape: optional field, old clients ignore it, new
clients prefer it and fall back to the name sentinel for old-format
creates, retire the fallback one release later.

Known limit until limb 1 lands (pre-existing, unchanged by the slice): a
real group a user literally names "Call" with a server-uuid id is
name-classified as a call carrier — concretely, `pruneCallGroupGhostRows`
deletes its chat-list row, the inbox upsert skips it, and its master key
becomes a call-key harvest candidate. MITIGATION already live: the
destructive sites compound with `is_custom_name`, which a user-NAMED
group has — so the practical exposure is a group whose server-assigned
default name is exactly "Call", which the app never produces.

**Limb 2 — the teardown/TTL (NOT wire-gated — buildable now).**
Identifying ephemeral keys is exactly what `isCallGroupState` does today,
and `pruneCallKeyContamination` already purges on that basis reactively.
What's missing is a call-END teardown (or TTL) for the minted 'Call'
state + its `direct:<owner>` alias, so old call keys stop accumulating
until the next contamination prune. HARD CONSTRAINT from B-337..B-345: a
purge must never fire while the call is LIVE (the group-removal purge
mid-call stranded a member in the call) — gate teardown on call-session
end + a grace, same shape as the #17 retire timers.

## App Check enforce flip (audit 2026-08-13 #6 — the open half of a P1)

The push-token attestation gate (`app-check.guard.ts`) no longer defaults
silently open: prod fails closed on `/push/*` when `APP_CHECK_MODE` is
unset/typo'd, and the staging deploy preflights the box compose. **But the
operational posture is `warn-only`, which admits forged binaries — the
stolen-JWT → attacker-push-token attack from the audit remains live until
the flip.** Nothing in code forces it; this entry is the owner.

Unblocking conditions, in order:

1. Mobile + ops-console ship the `X-Firebase-AppCheck` header on every
   `/push/*` call (Firebase App Check / Play Integrity on Android, App
   Attest on iOS; ops-console via reCAPTCHA/debug provider).
2. Enable App Check **replay protection** on the Firebase project
   (`verifyToken(..., {consume:true})` requires it — without it every
   verify throws and enforce would 401 valid clients).
3. While still on `warn-only`, confirm `/push/token-health` reports
   `fcmReady=true` (once fail-closed, token-health itself 401s).
4. Flip `APP_CHECK_MODE: 'enforce'` in the box compose
   (`docker-compose.staging.yml`, messenger-service block) and watch the
   `[app-check]` warn lines for stragglers (throttled 1/min).

## Group-fork heal is OWNER-ONLY (audit #1 spin-off, 2026-08-14)

The audit-#1 fresh-random rekey re-admits a narrow cross-order key fork,
repaired by the reshare lane. The edge review proved the heal has a
CRYPTOGRAPHIC tiebreak (only the OWNER's reshare carries a fresh
signGroupCreate; a non-owner relays a stale creatorSigB64 that fails
verification post-rekey — signed bytes cover masterKeyB64 + epoch), so it
cannot oscillate — but that makes it OWNER-CONDITIONAL:

- Owner offline → the fork persists for their offline window (messages
  stash as `tamper`, never lost, never rendered).
- Owner LEFT the group → `leaveGroup` has no ownership transfer, so
  `state.owner` names a departed user forever, `isOwnerReshare` is false
  for everyone, and a fork is PERMANENT (group calls die too — media key
  is HKDF(masterKey)). Same stale-sig root also means a NON-owner admin
  running addGroupMember cannot key the new member inline (drops the
  relayed stale sig; heals only via the owner).
  Follow-ups, in order: (1) ownership transfer / owner re-attestation on
  leave (arch-touching: create-sig authority); (2) drain stashed admin
  actions whenever `next !== existing`, not only on masterKey change
  (pendingAdminActionStore's header claims the wider behavior — doc is
  stale; today a stashed early-arriving rekey waits for a boot or the
  divergence heal); (3) PENDING_ADMIN_MAX_ATTEMPTS=3 is burned on no-op
  drain passes — a stashed rekey can be evicted before its enabling action
  arrives; (4) forked-window messages under the LOSING key are permanently
  unreadable by the winning half (stash rows never bump attempts, never
  render; sender sees ✓✓) — surface or expire them once (1) lands.

## Unlock-path reinstallIdentity vs live receive frames (audit F9 spin-off, 2026-08-14)

`reinstallIdentity` (`src/modules/messenger/backup/identityBackup.ts`, the
M-18 bracket) issues a raw `BEGIN`/`COMMIT` on the shared SQLCipher
connection. On the fresh-install restore path the runtime is gated, but the
Settings → Chat Backup **UNLOCK** path (`BackupSetupScreen`) explicitly does
NOT gate the runtime — its header says so — so this bracket can interleave
with a live receive frame's `BEGIN IMMEDIATE`: its `COMMIT` can commit a
half-done receive txn, its `ROLLBACK` can abort one (the P0-1 doctrine
class). Pre-existing; surfaced by the F9 budget review (critic rev-3), which
made the site's comment state this honestly instead of claiming a quiesce
that does not exist. Proper fix: serialize the bracket through the receive
txn chain (`runOnTxnChain` or `runWithRatchetTxn`) — a backup-module change,
so it must run `docs/runbooks/BACKUP_LOOP.md` and is NOT a drive-by.

---

## Round 11 — Backup 100% identical audit (2026-05-08) — DELIVERED

User-reported bug: "I need 100% identical backup (chat) — it was not 100% working." Six brutal-audit agents ran in parallel across mirror-write, restore-read, server endpoints, identity/ratchet, conversation/media, and lifecycle/race dimensions. ~120 issues found, deduped to 13 converging P0 root causes. All P0 + critical P1 fixed in one round.

### Root causes of "not 100% working"

Three categories, all silently destructive:

1. **Wire-format gaps** — every restored attachment was bricked because the per-file AES key + IV never reached `LocalMessage` (sealed payload consumed once at receive, then thrown away). Conversation row schema lacked mute/pin/TTL/unread/custom-name slots, so all five reset on every restore. GroupState (admin/master key/epoch) lived only in AsyncStorage's `vaultByOwner` which dies on uninstall.
2. **Pagination + lifecycle** — server cursor was `> ts` only, so every page boundary dropped same-ms rows (group fan-outs always tie). `markDirty` cleared dedup but never re-enqueued, so status flips, reactions, retract tokens, and removals never reached the server. Boot-window messages between WS-connect and `setMirrorKey` were silently dropped with no catch-up sweep. Mirror module globals (queue, dedup, master key, AppState hook) never cleared on logout — cross-user contamination latent.
3. **Catastrophic boot-order bug** — `BackupRestoreScreen` called `getMessengerRuntime` BEFORE `restoreBackup`, so the fresh `installIdentity` bundle uploaded to auth-service first, the rotation detector treated it as a key rotation and **WIPED every server-side OPK public**. Peers building sessions from cached pre-restore bundles then could not decrypt anything they sent to the user.

### Fixes shipped (P0)

#### Server-side (`apps/messenger-service/src/backup/`)

1. **`backup.service.ts:getMessages` — tuple cursor on `(msg_created_at, message_id)`.** Pagination uses `OR(ts > since, AND(ts = since, id > sinceId))` plus `ORDER BY ... , message_id ASC`. Same fix on `getSealedArchive` for the sealed envelope replay.
2. **`backup.service.ts:putConversations` / `getConversations`** — extended schema columns: `is_muted`, `is_pinned`, `default_ttl_sec`, `unread_count`, `is_custom_name`, `group_state` (JSONB). Both methods include a legacy-fallback path that retries with the pre-Round-8 column set if the migration hasn't landed yet, so a pre-migration server still serves restore requests cleanly.
3. **`backup.service.ts:sweepSealedArchive`** — new method, deletes `sealed_envelope_archive` rows older than 90 days.
4. **`relay.cron.ts`** — new `archiveSweep` cron at 03:30 UTC daily; calls `sweepSealedArchive`. Closes the unbounded-growth defect.
5. **`backup.controller.ts`** — `getMessages` and `getSealedArchive` accept `sinceId` query param.
6. **`supabase/migrations/20260508120000_backup_round8.sql`** — creates `backup_merkle_commits` (S8 protection was inert in production because the table never existed), adds `(owner, msg_created_at, message_id)` ASC index for tuple paging, extends `conversation_backups` with the new columns, adds `(recipient, ts_ms, envelope_id)` ASC index on the sealed archive.

#### Client-side mirror (`src/modules/messenger/backup/`)

7. **`messageMirror.ts` — full rewrite.** Adds:
   - `disposeMirror()`: clears every module global (queue, dedup, master key, owner gate, AppState hook, merkle hook). Wired into `authStore.signOut` so cross-user contamination is impossible.
   - `setMirrorOwner(userId)`: pin owner gate. Mismatched-owner mirror calls are silently dropped (catches stale callbacks fired with the previous user's id).
   - `setCatchUpSweep(fn)`: new callback fired by `setMirrorKey` when the mirror flips disabled → enabled. Re-walks the full SQLCipher store and re-mirrors anything dropped while locked. Closes the boot-window gap.
   - AppState `'background'` / `'inactive'` listener: forces a flush so the 1.5s debounce can't leak when the OS suspends JS.
   - `markDirty` now actually re-enqueues the live message via the store snapshot — status flips, reaction updates, retract tokens, removals all reach the server.
   - `serializeMessage` now writes `media_key`, `media_iv`, `media_mime`, `retract_token` — restored attachments are decryptable, restored retract tokens still work, restored bubbles render with the right viewer.
   - `mirrorConversation` accepts an optional `groupState` arg so admin/owner/epoch/master-key round-trip via the new `group_state` column.
   - Queue overflow now drops NEWEST entries (not oldest) so "100% identical history" is preserved when the network goes south; the most-recent tail is recoverable from SQLCipher via the catch-up sweep on next reconnect.
   - `expires_at` removed from plaintext `envelope_meta` — server no longer sees burn-timer metadata.
8. **`mirrorBootstrap.ts` — diff-on-content not just diff-on-id.** Per-message version hash captures status / reactions / retract / envelope-id / expires_at / content / media_key / media_iv. Per-conversation version hash captures name / pin / mute / TTL / unread / custom-name / participant count. Mutations now diff-fire correctly. Conversation diff calls `mirrorConversation(ownerUserId, conv, groupState)` with the matching GroupState from the store. `setCatchUpSweep` installs a re-walk callback. Owner pin via `setMirrorOwner` on start.
9. **`identityBackup.ts`** — three changes:
   - OPK enumeration cap raised from 200 to 10,000 with gap-tolerance termination, so OPKs above id 200 actually reach the backup.
   - `refreshIdentityBackup(store)`: re-uploads the identity bundle with the CURRENT contents of the local CryptoStore. Reuses the pinned `wrappedMasterKey` so the F6 same-key guard treats it as idempotent (preserves all mirrored messages instead of wiping). Called by `maybeReplenishOwnOpks` after every OPK refill so post-setup OPK private keys reach the encrypted backup.
   - `lockIdentityBackup()`: clears the pinned master key + wrap context. Wired into signOut.
10. **`backupClient.ts`** — `getMessages`, `getSealedArchive`, `putConversations`, `getConversations` extended for the new tuple cursor + columns.

#### Client-side restore (`src/modules/messenger/backup/restoreMessages.ts`)

11. **Tuple cursor** — passes `sinceId` to `backupClient.getMessages` so server-side tuple paging activates. Belt-and-braces client-side dedup retained for legacy server compatibility.
12. **Page cap raised 100 → 1000** (1M-row ceiling).
13. **Inbound peer fallback fix** — outbound rows fall back to `recipient_id`, inbound to `sender_id`. Previously inbound rows fell back to `recipient_id` (= self), corrupting replies, retracts, and contact resolve on every restored inbound message.
14. **Group room peer disambiguation** — picks the first non-self member as placeholder peer; consumers should use `participants` for groups.
15. **Conversation restore round-trips the new fields** — `is_muted`, `is_pinned`, `default_ttl_sec`, `unread_count`, `is_custom_name`. No more "every restored chat un-mutes itself."
16. **GroupState restore** — when `group_state` is present on a group row, calls `setGroupState(...)` so admin / owner / master key / epoch are populated. Restored groups are usable.
17. **Tombstone handling** — restore skips rows with `status='deleted'` so user-deleted-on-previous-device messages don't resurrect.
18. **`media_key` / `media_iv` / `media_mime` / `retract_token` restored** onto `LocalMessage` — attachments decrypt, retract works.
19. **`markRestoredNow()`** — opens a 5-minute `ExpirySweeper` grace window so disappearing-messages whose absolute `expires_at` already passed don't evaporate within seconds of restore. User has time to scroll through the chat first.

#### Runtime (`src/modules/messenger/runtime/`)

20. **`productionRuntime.ts:setDeferBundlePublish` + `publishOwnBundleAfterRestore`** — restore screen sets `deferBundlePublish=true` BEFORE booting the runtime, then calls `publishOwnBundleAfterRestore()` AFTER `restoreBackup` reinstalls the recovered identity. The recovered identity matches what auth-service has on file, so the rotation detector treats it as a no-op upsert and the OPK pool is preserved.
21. **`drainRelay` bootstrap-done flag** — only flips to "done" on a TRULY empty drain page, not on `length < pageLimit`. Previously a single short page (server-side cap, single-row delivery) would lock the user into the 50-cap reconnect path forever, undershooting on every drain.
22. **`expirySweeper.ts`** — `markRestoredNow(graceMs)` short-circuits sweeps until the grace window expires.
23. **`maybeReplenishOwnOpks`** — fires `refreshIdentityBackup` after every OPK refill. Best-effort; failures (mirror locked, network blip) don't propagate. Identity backup now contains the freshest OPK privates.
24. **`appendMessage` / receive paths in `productionRuntime.ts`** (4 sites) — populate `media_key`, `media_iv`, `media_mime`, `media_object_key` from the sealed payload's `SealedAttachment`. Without this the per-file decryption material never reached `LocalMessage` and every restored attachment was unrecoverable.

#### Auth (`src/store/authStore.ts`)

25. **`signOut`** — calls `disposeMirror()`, `stopMirrorBootstrap()`, `lockIdentityBackup()` BEFORE `disposeLiveRuntime`. Cross-user contamination closed; pending mirror flushes can't ship under the new owner.

### Local + Type changes

- **`src/modules/messenger/store/types.ts`** — `LocalMessage` extended with `media_key`, `media_iv`, `media_mime`. Sender + recipient both populate these from the sealed payload at send/receive.

### Verified

- `tsc --noEmit` (root): no new errors introduced. Baseline drift unchanged from pre-Round-8.
- `tsc --noEmit` (messenger-service): clean.
- `jest --selectProjects messenger-crypto`: 192/192 pass.
- `jest` (messenger-service): 50/50 pass.

### Known gaps → Phase 2

- **Session ratchet recovery** (the `applyRatchetSnapshot` placeholder in `sessionRatchetRecovery.ts` still returns `phase2_pending`). The mirror now reliably ships every message, the archive replays cleanly under the recovered identity, and OPKs survive — but messages encrypted under a Double-Ratchet chain that already advanced server-side still can't be decrypted on a fresh device until ratchet snapshots ship. Two paths documented previously: (A) Sender Keys for 1:1 (wire-format change, big project) or (B) encrypted ratchet snapshot in the backup bundle (smaller change, recommended first).
- **Sealed-archive size budgeting** — the new daily 90-day sweep keeps the table bounded, but power users with high inbound volume may benefit from a per-recipient cap as well. Phase 2.

### Deployment notes

- ⚠️ **Apply the Supabase migration FIRST**: `supabase/migrations/20260508120000_backup_round8.sql`. Without it, the new client tries to write `is_muted` / `is_pinned` / `default_ttl_sec` / `unread_count` / `is_custom_name` / `group_state` and the server falls back to legacy mode (Round-8 mirror state lost on restore until the migration runs).
- ⚠️ **Re-deploy `messenger-service`** — until then, the new server cursor + retention sweeper + extended schema all sit dark. Pre-Round-8 clients keep working.
- ⚠️ **Re-deploy client (APK/IPA)** — the boot-order fix (`setDeferBundlePublish`) prevents the catastrophic OPK wipe on first restore. Until the new client ships, every restore attempt continues to wipe peers' OPK pool.

---

## Round 10 — Call rapid-hangup regression audit (2026-05-08) — DELIVERED

User-reported bug: "I cut the call again within milliseconds" — rapid hangup leaves zombie call state, ghost ringing on the peer, mic/camera LED stuck on, or the user gets popped two screens deep. A six-agent brutal audit found 4 converging root causes + 16 ranked issues across client, server, and UI. All P0/P1/P2 fixed in one round.

### Root cause of the user-reported regression

Three things converging:

1. **`callController.ts` had no post-`await` cancellation guards.** `startOutgoing` / `accept` / `handleAnswer` each await 4-5 times. After `end()` ran, `this.pc` was null — the next await resumed and crashed with TypeError. State flipped `ended → failed` (or `ended → connecting`) because `setState` was unguarded.
2. **`signallingClient.sendHangup` was sync-fire-and-drop, but `sendOffer` queued for up to 4s.** User dials → offer waits for transport. Instantly hangs up → `sendHangup` finds transport closed → silently drops. Transport reconnects 2s later → offer fires → peer rings forever for a cancelled call.
3. **NO hangup-button debounce anywhere.** Rapid double-tap fired `liveCall.hangup()` + `navigation.goBack()` twice → the second `goBack` popped the parent screen.

### Fixes shipped (P0)

1. **`scripts/release-apk.ps1`** — added `npx patch-package` step + RNCallKeep `@ReactMethod` fingerprint check before the Gradle build. Stops shipping the cold-start CallKit `displayIncomingCall` TurboModule crash captured in `bravo-log-callkit-crash.txt`.
2. **`src/modules/messenger/webrtc/callController.ts`** — cancellation guards after every `await` in `startOutgoing` / `accept` / `handleAnswer` / `drainPendingIce`; `setState` is now a no-op when state is terminal (`ended`/`failed`); `pendingIce` bounded at 64 with FIFO eviction; new `enqueueIce` helper.
3. **`src/modules/messenger/webrtc/peerConnection.ts`** — `close()` now nulls all PC event handlers (`onicecandidate`, `oniceconnectionstatechange`, `onconnectionstatechange`, `onsignalingstatechange`, `onicegatheringstatechange`, `ontrack`) BEFORE calling native close. Eliminates post-close native callback firings + closure-pinning leak.
4. **`src/modules/messenger/webrtc/signallingClient.ts`** — per-callId send queue. `sendOffer/sendAnswer/sendReOffer/sendReAnswer/sendHangup` all chain through `enqueueForCall(callId, …)`. Hangup waits for transport (1.5s timeout) AND lands strictly after any pending offer for the same callId — peer can never get an unanswerable forever-call.
5. **`src/screens/messenger/CallScreen.tsx` + `GroupCallScreen.tsx`** — `hangupInFlightRef` debounce on End/Decline buttons. CallScreen's `endCall` no longer calls `navigation.goBack()` — the auto-dismiss effect (state==='ended') is the single dismissal path.
6. **`src/modules/messenger/webrtc/useGroupCall.ts`** — best-effort `sfu.leave` on cancel for both leave-during-boot windows (post-`getLocalMedia`, post-`sfu.join`). Server doesn't accumulate orphan participants/transports/rooms.

### Fixes shipped (P1)

7. **`apps/messenger-service/src/gateway/messenger.gateway.ts`** — added `CallSession` map (callId → caller/callee/state/tombstone). Every `call.*` handler now authorizes sender membership; `call.hangup` rejects third-party attempts; duplicate `call.offer` for an existing/tombstoned callId returns `duplicate_call_id`. `handleDisconnect` synthesizes `call.hangup {reason:'failed'}` to the active peer so a flaky-network drop ends the peer's call within milliseconds instead of waiting 30s for ICE consent timeout.
8. **`messenger.gateway.ts`** — `pending-call-offer` Redis key is now `pending-call-offer:${userId}:${deviceId}:${callId}` plus a SET index. `deliverPendingCallOffer` drains all queued callIds in chronological order. Concurrent callers no longer overwrite each other.
9. **`src/modules/messenger/webrtc/useCall.ts`** — local mic/camera tracks now stop on `state === 'ended'/'failed'` (not only on CallScreen unmount). Fixes the "mic LED stuck on" defect on the floating-overlay End path. Track `.stop()` calls wrapped in try/catch (Pixel 6a RN-WebRTC throws InvalidStateError on already-stopped tracks). Unmount cleanup ordering corrected: stop tracks BEFORE controller.hangup so encoder thread isn't bound to a transport mid-close.
10. **`src/screens/messenger/CallScreen.tsx`** — `isMountedRef` guard added to all async `Alert.alert` paths: upgrade-to-video catch, BS-021 `peerAddedVideo` effect, post-permission-request branch. No more "Could not turn on video" popup landing on the chat thread seconds after a hung-up call.
11. **`src/modules/messenger/push/fcmBootstrap.ts`** — accept-dedupe (`acceptedCallIds` Map). Notifee Accept tap and Telecom Answer event for the same callId can no longer both navigate → mount CallScreen twice → send two `call.answer` frames. Cleared via `notifyCallEnded(callId)` from `useCall`'s onState 'ended'. Also: malformed wake without `fromUserId` is rejected at the cache boundary; tombstoned callIds skip UI display entirely.
12. **`apps/messenger-service/src/gateway/messenger.gateway.ts`** — `firstTagFor(client, roomId?)` is now roomId-aware; `handleSfuLeave` filters by `data.roomId` instead of tearing down EVERY tag on the socket. All five `sfu.*` handlers (`connect`/`produce`/`consume`/`consumer.resume`/`leave`) thread `data.roomId` through. Fixes the rapid leave→rejoin race where the new room's tag was killed before it ever started routing.
13. **`apps/messenger-service/src/sfu/sfu.service.ts`** — `OnModuleInit/Destroy` zombie-room sweeper. Rooms older than 60s with zero participants are reaped every 30s. `findRoomForConversation` reaps zero-participant rooms eagerly so the next caller never inherits a corpse. Closes the host-creates-room-then-cancels leak.

### Fixes shipped (P2)

14. **`src/modules/messenger/push/incomingCallCache.ts`** — consumed-tombstone (90s TTL). `setIncomingCallPayload` returns `boolean`, rejects tombstoned callIds. `clearIncomingCallPayload` always tombstones the slot. A buggy/retrying caller resending the same callId after a decline cannot expose stale SDP.
15. **`src/modules/messenger/runtime/callRegistry.ts`** — `endActiveCall(reason, source: 'local' | 'remote')` — maps source='local' → CallKit `'declined'`, default 'remote' → `'remoteEnded'`. iOS Recents shows the right glyph. `FloatingCallOverlay`'s End button passes `'local'`.
16. **`src/modules/messenger/__tests__/webrtcSignalling.test.ts`** — three microtask flushes added with comments explaining why (the per-callId queueing made every send 1 microtask later).

### Verified

- `tsc --noEmit`: 100 errors → no regression vs baseline 100.
- `jest --selectProjects messenger-crypto`: 192/192 pass (incl. all 14 webrtcSignalling tests).

### Known gaps → Round 11 (separate session)

The audit identified two more areas that need work but didn't ship in this round:

- **Group-call SFU client/UI** (Agent 4 findings #5, #6, #7, #11, #12, #13) — listener-leak surfaces around mediasoup-client transport state changes, `cleanupSubRef` ordering during host-leave broadcast, sfuDispatcher overwrite-warns. Survivable today; cleanup needed.
- **Test infrastructure for rapid-lifecycle scenarios** (Agent 6 PART 2) — no fake transport state machine, no in-memory NestJS gateway harness. The 18 missing rapid-hangup test scenarios named in the audit are listed below; none currently have a place to live.
  1. hangup within 100ms of dial — bye must reach peer
  2. hangup before transport opens — bye must not be dropped
  3. double hangup is idempotent
  4. hangup-then-redial uses fresh callId; old callId frames silently dropped
  5. bye arriving before answer — controller transitions ended, drops late answer
  6. hangup during ICE gathering — pendingIce queue cleared
  7. stale ICE for ended call is dropped
  8. callId-mismatched hangup is ignored
  9. malicious cross-call ICE: ICE for c1 does not land on c2's PC
  10. busy collision: simultaneous incoming offer + outgoing dial
  11. rapid accept+decline race on multi-device account (server-side)
  12. server tracks active call sessions; second offer for same callId rejected
  13. server emits bye on disconnect when call active
  14. malformed offer payload: gateway returns error, does not crash
  15. hangup authorization: third party cannot end someone's call
  16. pending-offer collision: caller-A then caller-C within TTL — both delivered
  17. reconnect mid-call preserves call state via re-deliver
  18. group call rapid join/leave

### Deployment notes

- ⚠️ **Re-run `release-apk.ps1`** — the patch-package step + RNCallKeep fingerprint check is what makes the next APK boot at all. Pre-Round-10 APKs will keep cold-start crashing in `setupCallKit`.
- ⚠️ **Re-deploy `messenger-service`** — the call-state authority + bye-on-disconnect + per-callId Redis key are server-side; client-only deploy will leave 30s ICE-timeout hangs on the peer side and concurrent-caller offer-overwrites in place.
- No DB migration; `callSessions` is in-memory and `pending-call-offer-idx` is just a new Redis SET.

---

## Round 7 — Restore-after-reinstall (2026-05-08) — DELIVERED

User-reported bug: "messages are saved on server, but when I reinstall, most of the chat is gone." Audit found 5 distinct holes in the persistence pipeline; all 5 are now closed.

### Fixes shipped

1. **Hydrate cap bypassed during restore** — `hydrateMessages(map, bypassCap?)` skips the `MAX_HYDRATE_PER_CONVO=200` slice when called from `restoreAllMessages`. Restored rows now reach the UI in full instead of being silently truncated to the last 200/conversation.
   - `src/modules/messenger/store/messengerStore.ts`
   - `src/modules/messenger/backup/restoreMessages.ts`

2. **Backup master key persisted to OS keychain** — `setupBackup` / `restoreBackup` now return raw key bytes; saved hardware-backed via `saveMirrorMasterKey` (per-userId, `WHEN_UNLOCKED_THIS_DEVICE_ONLY`). On the next cold start, `backupBoot.ts` auto-unlocks the mirror without prompting. Closes the gap where the user's mirror was silently dead between unlock prompts.
   - `src/modules/messenger/runtime/keychain.ts` (+ save/load/clear)
   - `src/modules/messenger/backup/identityBackup.ts` (return rawB64)
   - `src/screens/messenger/BackupSetupScreen.tsx` + `BackupRestoreScreen.tsx` (persist on success)
   - `src/modules/messenger/backup/backupBoot.ts` (RESUME-AUTO branch)

3. **Server-side sealed-envelope archive** — every accepted envelope's opaque outer wrap is now mirrored into a new Supabase table `sealed_envelope_archive`, keyed by recipient userId. Server stays cryptographically blind (Sealed Sender). On restore the client pulls + replays through the live `handleDeliver`, so messages delivered during sessions where the client mirror was locked are recovered.
   - `supabase/migrations/20260508000000_sealed_envelope_archive.sql` (✅ applied to production Supabase 2026-05-08)
   - `apps/messenger-service/src/backup/backup.service.ts` (`archiveSealedEnvelope`, `getSealedArchive`)
   - `apps/messenger-service/src/relay/envelope.service.ts` (fire-and-forget archive on submit)
   - `apps/messenger-service/src/backup/backup.controller.ts` (`GET /backup/sealed-archive`)
   - `apps/messenger-service/src/relay/relay.module.ts` (imports BackupModule)
   - `src/modules/messenger/backup/backupClient.ts` (client `getSealedArchive`)
   - `src/modules/messenger/runtime/productionRuntime.ts` (`replayArchivedEnvelope` export + `liveReplayArchive` slot)
   - `src/screens/messenger/BackupRestoreScreen.tsx` (drains archive after `restoreAllMessages`)

4. **Bootstrap pull on fresh install** — `envelope.pull` now accepts `bootstrap=true`; server raises cap to `relay.maxBootstrapLimit=1000` (vs default 100). Client tracks `bravo.relay.bootstrap-done.<userId>` flag in AsyncStorage and sets `bootstrap=true` on the first drain after install. Closes the gap where multi-week backlogs only delivered the most-recent slice.
   - `apps/messenger-service/src/gateway/protocol.ts` + client mirror (`bootstrap?: boolean` field)
   - `apps/messenger-service/src/relay/envelope.service.ts` (`pull(..., {bootstrap})`)
   - `apps/messenger-service/src/relay/envelope.controller.ts` + `gateway/messenger.gateway.ts` (honour query param / WS field)
   - `src/modules/messenger/transport/relayClient.ts` (`pull({bootstrap})`)
   - `src/modules/messenger/runtime/productionRuntime.ts` (`drainRelay` flips bootstrap on first run)

5. **Ratchet-recovery telemetry stub** — counts undecryptable rows across `restoreMessages`, `handleDeliver`, `drainRelay`. Surfaces a single combined number to the user in the restore-complete summary so they understand the gap. Phase-2 hook `applyRatchetSnapshot` is wired but returns `phase2_pending`.
   - `src/modules/messenger/backup/sessionRatchetRecovery.ts` (new)
   - `src/modules/messenger/backup/restoreMessages.ts` + `runtime/productionRuntime.ts` (notes)
   - `src/screens/messenger/BackupRestoreScreen.tsx` (combined skipped + undecryptable count in summary)

### Verified

- `apps/messenger-service` typecheck: clean.
- `EnvelopeService` jest suite: 12/12 pass (all sealed-sender flows including the new archive hook).
- `backupMerkle` jest suite: 7/7 pass.
- Production Supabase migration verified — table + index + RLS-disabled all present.

### Known gap → Phase 2

**Session ratchet recovery (a.k.a. "messages sent during the reinstall window").** Even after Round 7, a small fraction of messages can't be recovered: those Signal-encrypted under the OLD per-peer Double Ratchet state that gets wiped with the SQLCipher DB on uninstall. Two options:

- **(A) Sender Keys for 1:1** — switch to the Signal group protocol so messages are encrypted to the recipient's identity key alone, no per-pair ratchet state. Requires a wire-format change. Big project.
- **(B) Encrypted ratchet snapshot in the backup bundle** — periodically serialize the SessionStore, AES-GCM-wrap with the master key, upload alongside identity backup. On restore, replay before the live deliver path runs. Smaller change; downside is the snapshot ages.

Recommendation: ship (B) first (cheaper and partial recovery is better than none), then evaluate (A) for a 2.0 milestone. The placeholder hook `applyRatchetSnapshot()` in `sessionRatchetRecovery.ts` is where (B) lands.

### Deployment notes

- ✅ Supabase migration applied.
- ⚠️ **Re-deploy `messenger-service`** — until then, the new archive table sits empty (legacy client-side `messages_backup` mirror keeps working).
- ⚠️ **Re-deploy client (APK/IPA)** — restore screen drains the archive automatically; pre-Round-7 builds simply ignore the new endpoint.
- ⚠️ **Rotate the Supabase DB password** that was used to apply the migration (it appeared in the Round-7 chat transcript).

---

## Part 1 — What v1.0.13 ships (delivered fixes)

### Crypto / Store / Media / Groups / Backup / Vault — 39 fixes

- ES2022 `Error.cause` semantics (errors.ts)
- Sealed-payload validator extended for clientMsgId/replyTo/reaction/control/groupCallPresence shapes
- Sealed-sender backward-compat: accepts v >= MIN_SEALED_VERSION instead of strict `v === SEALED_VERSION`
- `senderCert.verify` typed via `verifyXEd25519Signature({valid})` helper + boot-time self-test
- Crypto polyfills SHA-256 self-test → global `cryptoSelfTestFailed()` predicate, app refuses to boot on broken crypto
- `installIdentity` is transactional; signed_pre_key as completion sentinel
- `saveIdentity` single-statement UPSERT (eliminates RMW race on rotated peers)
- **Per-address session mutex** in `sessionManager` — eliminates Double Ratchet corruption from concurrent encrypts
- `groupCrypto.importKey` cached per masterKeyB64
- Persist middleware debounced (500ms) — no more multi-MB JSON.stringify on every keystroke
- Group conversation shadow-create on unknown groupId
- Vault swap uses `current()` snapshot — no immer draft leak across user-switch
- `MAX_HYDRATE_PER_CONVO=200` cap + `loadOlderMessages` pagination
- Per-conversation Promise chain on upsert/remove fixes TOCTOU on clearMessages
- `upsertCoalesced` 50ms batch → single transaction (10× fewer fsyncs)
- Media AES-CBC + HMAC-SHA256 (encrypt-then-MAC, format-version byte for backward compat)
- Media HEAD-after-PUT verification with retry
- Media cache eviction mutex; 25MB per-blob cap; decrypt-fail purge
- **Deterministic groupId** via sha256(salt || sortedMembers) — no more "two admins create same group" duplicates
- **Group admin authz check** — `applyAdminAction(state, action, senderUserId)` gates non-admin mutations
- `parseGroupMessage` returns discriminated union (`no_key | tamper | malformed | not_group`)
- Mirror bootstrap cleanup on logout
- Mirror flush queue capped at 500; FIFO drop with backup-behind UI flag
- `markDirty` wired to message mutations (status/reactions/retract token now replicate to backup)
- `restoreMessages` paginates with (timestamp, msg_id) cursor; transactional; single hydrateMessages
- Phone normalize strips ONE leading zero (universal trunk-prefix)
- Custom conversation names preserved (`is_custom_name` flag)
- **Vault uses Argon2id + lockout schedule** (5 attempts → 30s, 10 → 5min, 15 → 1hr); persisted counter
- Vault biometric default false (consent required)
- Vault unlock dual wall-clock + monotonic check (clock-rollback resistant)

### Runtime / Transport / Push — 23 fixes

- **Heartbeat `setInterval` no longer leaks** across runtime rebuilds (`liveHeartbeat` slot)
- Zustand subscribe captured in `liveDisposers` array, properly unsubscribed on logout
- WS-ack 5s watchdog now stored on pending entry; cleared in `handleAccepted` AND http-fallback paths
- `coalescedDrain()` mutex — drainRelay/AppState/pullEnvelopes share one in-flight call
- `drainRelay` paginates with 10-iter cap (no more stuck-at-50 envelope backlog)
- `shouldAttemptRebuild` cooldown stamped only AFTER rebuild succeeds
- AppState 'active' skips force-reconnect when transport is healthy AND last pong < 8s
- `pendingByClientMsgId` LRU-capped at 1000
- ExpirySweeper parked on `liveSweeper` slot, properly stopped
- Group fan-out parallel via `Promise.allSettled`
- **Per-runtime `peerIdentityCache`** (8min TTL) — no more OPK-pop on every send
- `isRecoverableFrameError` splits soft (recovery banner) from fatal (error banner)
- Heartbeat bails on 'unauthorized' WS state
- `upsertRetryQueue` for failed SQLCipher writes; backpressure via store error
- `disposeLiveRuntime()` exported; wired into `authStore.signOut`
- `recoveryPid` persisted to AsyncStorage for kill-revive replay
- `forceReconnect` 2s throttle
- HTTP clients support optional `refreshToken` callback for 401 retry
- `transportRegistry.clearLiveTransport()` on logout
- BravoTones state machine (`'idle' | 'starting' | 'started' | 'stopping'`)
- `certCache` 30s negative cache after fetch failure
- Listener arrays snapshotted before iteration (callRegistry, groupCallRegistry, transportRegistry)
- FCM bootstrap stop/start surfaces; logout invalidates per-user state

### WebRTC subsystem — 24 fixes

- **Boot-effect incomingSdp guard** in useCall — no more accept-with-undefined-SDP for incoming push-to-call
- **DTLS-poll cancellation** in callController — no more crash on hangup-during-DTLS-poll
- Multi-handler signalling — fast-double-mount no longer wipes prior handlers
- `registerSignalling` warns on overwrite + tears down prior
- `end()` is idempotent + unregisters all handlers
- PeerConnectionWrapper exposes `isClosed()`
- Stats-tick bails on closed PC
- `flipCamera` accepts optional localStream + splices new track
- `addTrack(video)` failure → `state='failed'` instead of silent voice-only degrade
- `groupCallIdentityRegistry` initial fire wrapped in `queueMicrotask` (no mid-render setState)
- `sfuDispatcher` warns on overwrite
- **SFU frame handler re-registers on resume-from-registry** — minimize→restore no longer freezes tiles
- Stale-roomId branch awaits prior leave (3s cap) before adopting fresh
- Same-roomId branch verifies `transportsAlive` before adopting
- **Per-consumer cleanup arrays** (`consumerCleanupsByPid`) — no more setState-on-unmounted from trackended
- Audio-poll interval stored in ref, cleared directly in `leaveInternal`
- **`sentRingRef` set AFTER successful wsRequest** — failed first ring no longer permanently blocks
- **`inFlightConsumes` Set** blocks concurrent consume of same producerId
- `roomIdRef` mirror used inside leaveInternal (no closure stale)
- Registry slot only cleared if our roomId matches
- `toggleVideo` synced to registry
- Agora dead code removed (was wired but never armed); ICE failure now hard-fails cleanly
- `clearPendingOneToOne()` wired into signOut

### Hot screens — partial coverage (4th agent hit usage limit)

**Confirmed landed:**

- `preferredRouteRef` BT-restore in CallScreen + GroupCallScreen
- `safeStreamURL` guards across all 7 RTCView call sites
- Audio-focus listener + "Paused" banner (CallScreen + GroupCallScreen)
- AppState lifecycle listener with throttled tick
- Hero-hold silence-pin (no swap when audioLevel < 0.05)
- `FlexibleVideoTile` ratio reset on streamURL change + memoized merged style
- `fetchWithRefresh` for TURN credentials + group SFU calls
- Voice-call Camera button shows clear Alert + red feedback
- Invitee strip removed from room UI (lives only in Invite modal)
- `inviteUsers` retries once on `peer_offline`
- Camera-off clear visual feedback (red tint + "Camera off"/"Video off" label)
- Chrome auto-hide also fades dark gradient scrim
- WhatsApp-style flexible video tiles (FlexibleVideoTile + onDimensionsChange)

---

## Part 2 — What v1.0.13 did NOT yet fully address (Round 2/3 work)

### Hot-screen fixes — Round 2 verification pass

Round 2 verified that the 4th agent's work landed despite the org-usage-limit
interruption. Most items were already in place; the remaining gaps were
patched in this pass (Fix #43, Fix #44).

#### CRITICAL / HIGH — all landed

- [x] **Fix #2** `CallScreen.tsx:304-333` — useCall arg `useMemo` wrapping. ✅ Landed.
- [x] **Fix #3** `CallScreen.tsx:206-220` — back-press uses `liveCallStateRef`; minimize only when 'connected', hangup otherwise. ✅ Landed.
- [x] **Fix #4** `CallScreen.tsx:176-194` — audio-focus listener via `liveCallRef`. ✅ Landed.
- [x] **Fix #5** `CallScreen.tsx:806-849` — dual call-record append collapsed to single unmount-cleanup source via `callRecordedRef`. ✅ Landed.
- [x] **Fix #11** `GroupCallScreen.tsx:305-420` — speaker-priority useMemo refactored to use stable-ref/sig/debounce cache (no console.log inside). ✅ Landed.
- [x] **Fix #15** `GroupCallScreen.tsx:569-600` — `acceptIncomingOneToOne` now awaits `endActiveGroupCall().then(...)` before navigating. ✅ Landed.
- [x] **Fix #18** `GroupCallScreen.tsx:840-858` — audioInterrupted effect reads via `callRef` mirror. ✅ Landed.
- [x] **Fix #20** `GroupCallScreen.tsx:640-690` — invite ring expiry persisted to `groupCallRegistry.inviteRingExpiry` and survives minimize→restore. ✅ Landed.
- [x] **Fix #21** `FloatingCallOverlay.tsx:259-287` — HERO_HOLD_MS bumped to 3000 ms; `heroHoldRef` ref-tracks previous hero. ✅ Landed.
- [x] **Fix #25** `ChatScreen.tsx:249-259` — markRead 200 ms debounce. ✅ Landed.
- [x] **Fix #26** `ChatScreen.tsx:1499-1525` — single-global 1 Hz pub/sub via `useSyncExternalStore` replaces per-bubble setInterval. ✅ Landed.
- [x] **Fix #27** `ChatScreen.tsx:1222-1252` — burn-effect via `removeMessageRef` mirror. ✅ Landed.
- [x] **Fix #28** `ChatScreen.tsx:1299-1311` — panResponder via `onSwipeReplyRef` mirror. ✅ Landed.
- [x] **Fix #31** `ChatScreen.tsx:202-209` — setActive cleanup checks `liveActive === conversationId` before clearing. ✅ Landed.
- [x] **Fix #33** `ChatScreen.tsx:303-330` — typing-stop fires on conversation switch. ✅ Landed.
- [x] **Fix #34** `MessengerHomeScreen.tsx:201-231` — peerIds memoized via `peerIdsKey` join string + `lastSubscribedKeyRef`. ✅ Landed.
- [x] **Fix #35** `MessengerHomeScreen.tsx:42-50, 318-340` — Swipeable refs hoisted into `swipeableMapRef` Map. ✅ Landed.
- [x] **Fix #36** `MessengerHomeScreen.tsx:134-195` — search filter debounced via `debouncedQuery` + 150 ms timer. ✅ Landed.
- [x] **Fix #37** `ChatInfoScreen.tsx:125-160` — `allConversations` dep handled via dep-omit + intentional re-derivation. ✅ Landed.

#### MEDIUM / LOW — all landed (#43 + #44 patched in Round 2)

- [x] **Fix #1** `CallScreen.tsx:1050-1093` — pulse-ring `Animated.timing(...,duration:0)` reset at start of each loop. ✅ Landed.
- [x] **Fix #6** `CallScreen.tsx:760-776` — speaker-effect re-applies after ringing via `speakerNeedsReapplyRef`. ✅ Landed.
- [x] **Fix #7** `CallScreen.tsx` — PiP RTCView safeStreamURL memoized. ✅ Landed.
- [x] **Fix #8** `CallScreen.tsx` — duration tick fallback via `callDurationRef`. ✅ Landed.
- [x] **Fix #9** `CallScreen.tsx:1238-1268` — PiP PanResponder reads `pipPanValueRef` instead of private `_value`. ✅ Landed.
- [x] **Fix #10** `CallScreen.tsx:386-398` — Add-picker via `useMessengerStore(s => s.conversations)` selector. ✅ Landed.
- [x] **Fix #12** `CallScreen.tsx:133-161` — single consolidated AppState listener (was three). ✅ Landed.
- [x] **Fix #13** `GroupCallScreen.tsx` — RTCView hero/small via `key={tag}` + cached merged array (avoids remount on swap). ✅ Landed (workaround); full unified-grid restructure remains a deferred design improvement.
- [x] **Fix #14** `GroupCallScreen.tsx:660-674` — invite ring ticker via `inviteRingExpiryRef`. ✅ Landed.
- [x] **Fix #16** `GroupCallScreen.tsx:126-129` — InCallManager session effect bails until `roomId !== null`. ✅ Landed.
- [x] **Fix #17** `GroupCallScreen.tsx:177-188` — audioRoute lazy initializer reads `getAudioDeviceList()`. ✅ Landed.
- [x] **Fix #19** `GroupCallScreen.tsx` — chat send via `Promise.allSettled`. ✅ Landed (group fan-out path on runtime).
- [x] **Fix #22** `FloatingCallOverlay.tsx:38-75` — duration timer drift via per-tick wall-clock anchor. ✅ Landed.
- [x] **Fix #23** `FloatingCallOverlay.tsx` — two PanResponders consolidated. ✅ Landed.
- [x] **Fix #24** `FloatingCallOverlay.tsx` — tap-to-restore re-checks `getActiveCall()` after `setMinimized(false)`. ✅ Landed.
- [x] **Fix #29** `ChatScreen.tsx:115-132` — keyboardDidShow only updates kbHeight on >4 dp delta. ✅ Landed.
- [x] **Fix #32** `ChatScreen.tsx:183-203` — pullEnvelopes dedup via runtime drainInflight mutex. ✅ Covered.
- [x] **Fix #38** `IncomingGroupCallScreen.tsx:100-108` — recipientUserIds via Zustand selectors. ✅ Landed.
- [x] **Fix #39** `IncomingGroupCallScreen.tsx:57-76` — vibration kick deferred 50 ms via setTimeout to avoid pre-empt-by-accept-handler race. ✅ Landed.
- [x] **Fix #40** `VoiceCallScreen.tsx:18-35` — gated behind `__DEV__` (returns null in release). ✅ Landed.
- [x] **Fix #43** `CallScreen.tsx:1280-1338, 1632, 1842` — duplicate Add-picker Modal lifted into shared `addPickerModal` JSX (single source of truth across video + voice return trees). ✅ **Patched in Round 2.**
- [x] **Fix #44** `CallScreen.tsx:986-997` — tab nav `setOptions` migrated to `useFocusEffect` (was `useEffect`; could miss the parent on first attach). ✅ **Patched in Round 2.**
- [x] **Fix #45** Same as #33 above. ✅ Landed.
- [x] **Fix #46** Same as #12 above. ✅ Landed.
- [x] **Fix #47** Same as #20 above. ✅ Landed.
- [x] **Fix #48** Same as #32 above. ✅ Landed.

### Round 2 audit (completed 2026-05-06) — three lenses

Three parallel audit agents (security-first, perf-first, architecture-first)
ran on the post-Round-1 codebase. Combined findings: ~30 real Round 2 gaps.

Round 3 fixes applied in this session (highest-impact + tractable items):

- [x] **CRITICAL — refreshToken not wired into productionRuntime HTTP clients**
      Round 1 added the `refreshToken?: () => Promise<void>` option to every
      HTTP client (Keys/SenderCert/Relay/Users) but `productionRuntime` never
      passed one. Effect: every 401 inside those clients fell through silently
      and the user was stuck until they navigated to a screen using
      `fetchWithRefresh`. **Fix:** added `refreshToken` to `ProductionConfig`,
      exported `refreshAccessTokenShared()` from `services/api`, wired through
      in `MainNavigator.configureMessengerRuntime`, plus passed to all HTTP
      clients + the WS TransportClient. WS unauthorized-close now drives the
      refresh chain instead of stranding in `unauthorized` state.

- [x] **CRITICAL — signOut leaked WS, active calls, and dispatcher state**
      Round 1's signOut called `disposeLiveRuntime()` + `clearLiveTransport()`
      but never closed the underlying socket and never cleared the WebRTC
      dispatchers (callDispatcher, sfuDispatcher, groupCallIdentityRegistry,
      groupCallRingDispatcher). Effect: the prior user's WS stayed open under
      the old JWT, the persisted recoveryPid was reused by the next user, and
      late-arriving call frames routed into the prior user's listener
      closures. **Fix:** signOut now (a) ends any active 1:1 + group call,
      (b) `clearLiveTransport` now `.close()`s the socket too, (c) every
      dispatcher exposes a `clearAll*` function called from signOut, (d)
      `stopAllTones()` is wired so a logout mid-ring doesn't bleed into the
      login screen.

- [x] **HIGH — `platform: 'android'` hardcoded in authStore registration**
      iOS users were registered as Android devices for FCM/APNs routing.
      **Fix:** new `DEVICE_PLATFORM` constant reads `Platform.OS` once at
      module load and passes it to `registerVerify` + `verifyOtp`.

- [x] **HIGH — `Math.random()` used for callId fallback**
      RN polyfill chain doesn't always populate `crypto.randomUUID`; the
      fallback fired in production. Predictable callIds let an attacker
      who can guess them spoof `call.hangup`/`call.ice` against active calls.
      **Fix:** [launchCall.ts:38-58](src/modules/messenger/webrtc/launchCall.ts#L38-L58)
      `genCallId` now hard-fails if no CSPRNG is available, uses
      `crypto.getRandomValues` (always present — libsignal already depends on
      it). Also hardened the local group-call history bubble id in
      `useGroupCall.ts:1272`.

- [x] **HIGH — Server gateway logs leak PII** — full SDP dumps to docker
      logs (private IPs + ICE candidates + ufrag/password), full userIds in
      call/answer/ice/hangup/pull-debug log lines.
      **Fix:** SDP dump is now gated behind `BRAVO_DUMP_SDP=1` env-var; userId
      fields truncated to first 8 chars; ICE candidate body replaced with
      `candLen=` only.

- [x] **HIGH — 100ms mic-poll runs while app is backgrounded** (battery)
      Voice-call decorative waveform poll opened a SECOND `Audio.Recording`
      and ran a 10 Hz JNI poll for the entire call duration, including when
      backgrounded. **Fix:** `appIsActiveForMicPoll` AppState gate added in
      CallScreen — poll halts when state !== 'active' and resumes on return.

- [x] **MEDIUM — FloatingCallOverlay 1:1 video path bypassed lastUrlRef
      cache** Group path got the cache in Round 1; 1:1 path didn't, so every
      duration tick produced a fresh streamURL string identity and the JNI
      bridge re-set the prop. **Fix:** mirror the GroupOverlay `lastUrlRef`
      pattern for the 1:1 path.

- [x] **MEDIUM — `expiresAtSec` server-side not upper-bounded**
      Client could submit `expiresAtSec` 100 years in the future; Redis TTL
      was capped at `dwellSeconds` (so storage exhaustion was prevented), but
      the stored metadata field still showed the bogus value to the recipient.
      **Fix:** clamp `storedExpiresAtSec` to `now + dwellSeconds` when
      `remaining > dwellSeconds`.

### Round 4 fixes (2026-05-06) — three more from the audit punch-list

- [x] **Per-screen ErrorBoundary wrappers** (architecture/CRITICAL).
      New `withScreenErrorBoundary` HOC in
      [src/modules/observability/withScreenErrorBoundary.tsx](src/modules/observability/withScreenErrorBoundary.tsx)
      wraps CallScreen, GroupCallScreen, and ChatScreen. A render-phase
      crash inside any of them now shows a screen-local Retry/Back card
      instead of unmounting the whole app. Crashlytics still records the
      error via the inner ErrorBoundary.
- [x] **`sfu.ring.cancel` on host hangup**
      ([src/modules/messenger/webrtc/useGroupCall.ts:1141-1170](src/modules/messenger/webrtc/useGroupCall.ts#L1141-L1170)).
      Host-only branch in leaveInternal: if a ring is in flight AND there
      are recipients who haven't joined yet, fire `sfu.ring.cancel` to
      dismiss their ringing screens before tearing the session down.
      Server already supported the frame; just wired the client send.
- [x] **Coalesce 3 patchActiveGroupCall effects + gate on isMinimized**
      ([src/modules/messenger/webrtc/useGroupCall.ts:996-1023](src/modules/messenger/webrtc/useGroupCall.ts#L996-L1023)).
      audioLevels / identityByTag / remoteTiles mirrored to the registry
      in ONE coalesced effect, only while the FloatingCallOverlay is
      actually mounted (isMinimized=true). Subscriber on the registry
      flips `mirrorActive` when minimize toggles so the overlay always
      gets a fresh seed.

### Round 5 + Round 6 fixes landed (2026-05-07) — closing out the audit punch-list

The following items from the Round 2/4 audit have all been LANDED and are
no longer deferred. Kept in the doc as ✅ entries so the audit-trail
shows what was closed and when.

Round 5 — security batch (commit `f0b680e`):

- [x] **S1 — Sealed-sender AAD binding** (security/CRITICAL). v3 wire
      format with `aad: {to: {userId, deviceId}, ts}`; 15-min skew window;
      back-compat decode for v1/v2. See `crypto/sealedSender.ts`.
- [x] **S2 — Group rekey on member removal** (security/HIGH). New
      `removeGroupMember()` runtime action with two-step broadcast
      (remove → rekey). New master key shipped to surviving members
      after the remove envelope. See `groups/groupClient.ts:planRemoveAndRekey`.
- [x] **S3 — VoIP push replay protection** (security/HIGH). Server
      `voipSign()` HMAC-signs `kind|callId|callKind|nonce|exp`;
      client-side `voipWakeVerify.ts` verifies + nonce-LRU. Wake key
      provisioned via `registerVoipToken`.
- [x] **S4 — Admin-create sender verification** (security/HIGH). Group
      create envelopes now carry a `creatorSignature` (curve25519 over
      `BRAVO_GROUP_CREATE_V1\n` + sorted members + masterKey + epoch).
      Verified at receive time before the group state is installed.
- [x] **S5 — Self-DoS via pending LRU** (security/HIGH). Bounded
      `pendingByClientMsgId` Map at `MAX_PENDING=1000`; LRU-evicted
      entries surface as `'sending' → 'failed'` so the user sees a
      retryable error instead of a silent black hole. Recipient cap
      `MAX_GROUP_FANOUT=250` rate-limits per send.
- [x] **S6 — Server-side mediasoup mute** (security/CRITICAL).
      `authoriseMute` in `sfu.service.ts` now actually calls
      `producer.pause()` / `producer.resume()` server-side and tracks
      mute state in `mutedProducerIdsByTag`.
- [x] **S7 — Mirror sealed-envelope wrapping** (security/HIGH). Per-row
      AES-GCM subkey wrap (`generateSubkey` / `importSubkey` in
      `backupCrypto.ts`); `ciphertext_type=2` rows carry `wrappedSubkey`
      in `envelope_meta`.
- [x] **S8 — Restore replay protection** (security/CRITICAL). Merkle
      root pinned in identity bundle. `backupMerkle.ts` computes root
      over sorted `(msg_id, ts, ciphertext)` leaves; `merkleCommit.ts`
      signs with identity priv key + cross-session seq cache for
      rollback detection. New `MerkleCommitMismatchError`.

Round 6 — perf + race (commits TBD this session):

- [x] **CallsLog / Files / Groups subscribe to whole `messages` map**
      (perf/HIGH). New memoised selectors `selectCallMessages`,
      `selectMediaMessages`, `selectLastMessageByConv` in
      `messengerStore.ts`. `WeakMap`-cached on the live `messages` map
      identity so cross-conversation appends don't re-render the
      filter screens.
- [x] **ChatScreen FlatList stabilisation** (perf/HIGH). Round-2 of
      Fix #30 — module-level `keyExtractor`, memoised
      `ListHeader`/`ListFooter` (TypingBubble no longer re-mounts each
      render), `onContentSizeChange` + `onScroll` made identity-stable
      via `atBottomRef` mirror. `MessageBubble` was already memo'd.
- [x] **WS frame handlers ownerKey** (race/MEDIUM→HIGH). Module-level
      monotonic owner-epoch in `productionRuntime.ts`. Every async
      callback (`onFrame`, `onStateChange`, `coalescedDrain`,
      AppState handler, heartbeat tick) bails when its captured
      `myEpoch` doesn't match `currentOwnerEpoch`. Closes the
      cross-user data-bleed window where User A's `envelope.deliver`
      could land on User B's store after a fast logout/login cycle.
- [x] **`runtime.loadOlderMessages` — actual pagination** (perf/MEDIUM).
      Was comment-only in the store; now wired through
      `productionRuntime.loadOlderMessages` →
      `sqlMessages.loadOlder(convId, before, beforeId, limit)` →
      `store.prependOlderMessages`. ChatScreen `onScroll` fires the
      runtime call when `contentOffset.y < 200` with serialise-via-ref
      guard + exhausted-latch. `maintainVisibleContentPosition` keeps
      the user's anchor stable when older pages prepend.

### Round 7 fixes landed (2026-05-07) — 1:1 voice→video upgrade

- [x] **1:1 voice→video upgrade** — full SDP renegotiation pipeline.
      New `call.reoffer` / `call.reanswer` frames added to both client
      and server protocols (mirrors stay in sync); server gateway is
      a pure relay (no offline queue, no VoIP push — peer is mid-call
      so by definition online). Client side: new
      `CallController.upgradeToVideo({prepare, watchdogMs})` + private
      `handleReOffer` / `handleReAnswer` with glare detection
      (`signalingState !== 'stable'` rejects the incoming reoffer so
      the politer side's watchdog rolls back). `useCall.upgradeToVideo`
      acquires camera with explicit Android `PermissionsAndroid.CAMERA`
      pre-prompt (RN-WebRTC's getUserMedia doesn't auto-prompt on
      Android), splices video into the existing MediaStream so the
      peer parses both tracks as one stream, applies the same
      maintain-framerate / 600 kbps cap as the initial-offer path, and
      surfaces a clean rollback (stop track + drop sender + restore
      audio-only stream) on any failure including the 10 s reanswer
      watchdog. CallScreen's voice-call Camera button now triggers the
      upgrade with specific Alert text per failure mode (peer didn't
      reply, camera unavailable, glare); a derived `isVideoUI` swaps
      the screen to the video-grid layout the moment a local video
      track lands without remounting. Peer-initiated upgrades surface
      via `peerAddedVideo` with a "Turn on yours too?" Alert (no
      auto-acquire — privacy). End() rejects any in-flight
      renegotiation promise so the host's catch handler runs the
      rollback instead of hanging on the watchdog. 14 unit tests
      cover the lock, watchdog, glare rejection, callId mismatch,
      hangup-mid-renegotiation rejection, and the responder path.

### Round 8 fix landed (2026-05-07) — restore-status correctness

- [x] **Restored outbound messages were lying about delivery state**
      (UX/MEDIUM-HIGH). Pre-fix: send "hi" → 1-tick (delivered to
      relay) → delete app → reinstall + restore → "hi" still showed
      1-tick (or 2-tick / blue-tick depending on whatever the OLD
      device's last-known status was at backup-flush time).
      The acks were from the OLD device's WS session — the new device
      has never spoken to the relay about that envelope. Showing the
      old status is a UX lie. Worse: 'sending' / 'failed' restored
      as zombies because the new runtime's `pendingByClientMsgId` Map
      is empty, so nothing would ever retry them — user staring at a
      forever-clock or non-actionable error pill.
      **Fix:** new pure helper
      [src/modules/messenger/backup/restoreStatus.ts](src/modules/messenger/backup/restoreStatus.ts)
      exports `decideRestoredStatus(senderId, ownerUserId, decoded)`.
      Outbound rows always floor to `'sent'` (1-tick — strongest
      claim we can keep without lying); inbound rows preserve their
      backup status (read-state on received messages is locally
      driven, still semantically true after restore). Wired into
      [src/modules/messenger/backup/restoreMessages.ts:200](src/modules/messenger/backup/restoreMessages.ts#L200).
      15 unit tests in
      [src/modules/messenger/**tests**/restoreStatus.test.ts](src/modules/messenger/__tests__/restoreStatus.test.ts)
      cover every status × direction combo plus the directional edge
      case (string equality is exact — no whitespace/case
      normalisation). Matches WhatsApp/Signal post-restore behaviour.
      192/192 tests pass; tsc baseline unchanged.

### Round 9 fixes shipped in v1.0.18 (2026-05-07) — contact resolution + group-call regressions

Build: v1.0.18, versionCode 19. Firebase release `5cenhn1ssrvj0`. APK 452.5 MB.

- [x] **Contact-name resolution on the chat list — WhatsApp-style passive sync**
      (UX/HIGH). Pre-fix: when a saved contact messaged you first, the
      auto-created direct conversation row showed the peer's UUID prefix
      (`abc12345`) instead of their saved name. The rename pass in
      [useDiscoveredContacts](src/modules/messenger/contacts/useDiscoveredContacts.ts)
      only ran on NewChatScreen, so users had to "manually enter" a chat
      to get the proper label. **Fix:** added `passive: boolean` option
      that uses `Contacts.getPermissionsAsync()` (read-only) instead of
      `requestPermissionsAsync()` (system prompt) — silent no-op when
      contacts permission isn't granted. Mounted on
      [MessengerHomeScreen](src/screens/messenger/MessengerHomeScreen.tsx)
      with `passive: true` so every Home open re-pairs the address book
      with the directory and patches every auto-created direct row.
      Friendlier placeholder for unknowns: `Bravo · abcd1234` instead
      of bare hex. Existing rename condition (`!is_custom_name`)
      preserves user-customised names.

- [x] **BS-024 — group-call tiles vanish 5 s after first appearing**
      (UX/HIGH). Pre-fix: 3-participant audio call showed all tiles for
      a moment then collapsed to just the YOU tile. Root cause: the
      retention map's `lastSeenMs` stamp only refreshed when the
      `layout` reference changed, but `merged` is **deliberately
      debounced** (1500 ms — keeps RTCView identity stable across
      audioLevels ticks) and returns the same array reference for a
      stable tag set. So on a steady call, `layout` reference stayed
      frozen, `lastSeenMs` went stale, and the 1 Hz eviction interval
      tripped at the 5 s mark and dropped every remote from the map.
      The render loop iterates the **retained map** (not `layout`), so
      once evicted the tile disappeared entirely. **Fix:** added
      `call.remoteTiles` as a second dep on the layout-stamp effect,
      plus a belt-and-suspenders refresh inside the eviction interval
      that re-stamps `lastSeenMs` for any retained tag still present in
      the live `remoteTiles` set. Eviction now strictly means "tag has
      actually left the call". Verified against all 7 documented
      load-bearing dependents (BT route, hero-hold, FlexibleVideoTile
      aspect, mute overlays, invite ring tickers, FloatingCallOverlay
      handoff, speaking border) + all 10 SQA scenarios A–J.
      [GroupCallScreen.tsx:469-528](src/screens/messenger/GroupCallScreen.tsx#L469-L528).

- [x] **BS-025 — voice→video upgrade fails on retry (have-local-offer
      stuck)** (UX/HIGH). Pre-fix: tapping Camera on a 1:1 voice call
      showed "Peer didn't respond" after 10 s; tapping Camera again
      immediately showed "Try again — both sides tried to change the
      call at the same time (signaling state is have-local-offer,
      expected stable)". Root cause: when
      [renegotiateLocal](src/modules/messenger/webrtc/callController.ts#L416-L450)
      hit the watchdog, it threw cleanly but **left the local PC stuck
      in `have-local-offer`**. Every subsequent Camera tap then
      rejected at the top of `renegotiateLocal` before sending a fresh
      reoffer. **Fix:** new
      [`PeerConnectionWrapper.rollbackLocalDescription()`](src/modules/messenger/webrtc/peerConnection.ts)
      calls `setLocalDescription({type: 'rollback'})` per WebRTC spec
      — the controller's renegotiation catch block invokes it on every
      failure path (watchdog, acceptAnswer-throw, cancellation) so the
      next attempt starts from `stable`. Best-effort: rollback failures
      log non-fatally and don't mask the original error. Skips when PC
      is already closed (e.g. peer hangup mid-renegotiation, where
      `end()` nulls `this.pc` before the catch runs). 14/14
      webrtcSignalling tests still pass.

- [x] **BS-026 — in-call chat sheet locks up after first send**
      (UX/MEDIUM). Pre-fix: first send worked, but the keyboard
      dismissed and the next composer tap was absorbed by the
      ScrollView. Root cause: `TextInput` defaulted to
      `blurOnSubmit={true}` (closes keyboard on submit) AND the
      ScrollView lacked `keyboardShouldPersistTaps="handled"` (so the
      first keyboard-dismiss tap was consumed by the scroll surface
      instead of the next interactive child). **Fix:** minimal-touch —
      added both props on the chat sheet; kept the existing
      nested-Pressable modal structure intact (it's the same pattern
      the invite-picker and route-picker modals use, both proven
      working).
      [GroupCallScreen.tsx:1631-1693](src/screens/messenger/GroupCallScreen.tsx#L1631-L1693).

### Items still deferred

- **iOS CallKit / PushKit activation** (cross-platform/CRITICAL).
  Code is complete — bridge, PushKit registration, APNs HTTP/2 sender,
  entitlements, UIBackgroundModes — all dorm
  ant behind a single
  `IOS_RUNTIME_ENABLED = false` flag in
  [callKitBridge.ts](src/modules/messenger/push/callKitBridge.ts).
  Activation is a 1-day operation once you have:
  1. Apple VoIP Services Certificate (manual issue at developer.apple.com)
  2. `.p8` auth key deployed to messenger-service host
  3. Four `APNS_VOIP_*` env vars set on the server
  4. Flip the flag, EAS iOS build, TestFlight smoke
     See "CallKit + PushKit (iOS) + Telecom (Android)" milestone below
     for details — Android Telecom side has LANDED.

### Already-known architectural deferrals (multi-day milestones)

#### CallKit + PushKit (iOS) + Telecom (Android) — unified milestone

**Status**: 🟢 Android shipped 2026-05-07 (this build) · 🟡 iOS code complete, dormant pending Apple VoIP cert.

##### Android Telecom — LANDED

`react-native-callkeep@4.3.16` + `@config-plugins/react-native-callkeep@12.0.0` installed and verified compiling into the release APK (BUILD SUCCESSFUL in 17m 29s, all CallKeep classes — `VoiceConnectionService`, `RNCallKeepModule`, etc — present in dex via R8). Manifest entries patched directly into [android/app/src/main/AndroidManifest.xml](android/app/src/main/AndroidManifest.xml) because the project has custom Kotlin (`CallForegroundService.kt`) that `expo prebuild` would overwrite.

What now works on Android:

- System call UI (Telecom ConnectionService) on lock screen, alongside the existing notifee path — both fire, de-duped by `callId`
- Bluetooth headset auto-routing (Telecom owns audio routing now)
- Coexistence with WhatsApp / SIM calls — both register their own Telecom phone account, neither yanks audio from the other (replaces the v1.0.13 audio-focus-listener workaround)
- Decline button now actually declines: sends `call.hangup` reason='declined' to peer over live WS so the caller stops ringing immediately instead of the 30s no-answer timeout
- Outgoing call shows system call UI even if user locks the phone immediately after dialling

Failure-soft: if Telecom setup fails (OEM stripped Telecom, user denied phone-account permission), the bridge silently no-ops and notifee remains the sole ringer — Android calling keeps working exactly as before.

##### iOS — CODE COMPLETE, DORMANT

Every line of iOS-side code is written and typechecks clean. Activation is a 1-day operation gated on Apple cert + server env.

What ships dormant:

- [callKitBridge.ts](src/modules/messenger/push/callKitBridge.ts) — same wrapper module Android uses, with `IOS_RUNTIME_ENABLED = false` flag
- [voipPush.ts](src/modules/messenger/push/voipPush.ts) — PushKit token registration, mirrors fcmBootstrap pattern
- [apnsClient.ts](apps/messenger-service/src/push/apnsClient.ts) — production-ready APNs HTTP/2 sender. Zero new deps (uses `node:http2` + ES256 JWT signing). 50-min token cache. Auto-cleanup of `BadDeviceToken` / `Unregistered` (410) tokens
- [push.service.ts:sendVoipApns](apps/messenger-service/src/push/push.service.ts) — same HMAC + nonce + exp envelope as Android FCM, so on-device verifyVoipWake works identically when iOS lights up
- `app.json` already has `aps-environment: production` entitlement + `voip / audio / remote-notification` UIBackgroundModes
- iOS 13+ contract respected: `voipPush.handleInboundVoipPush` calls `reportIncomingCall` synchronously BEFORE any verification or network work; if HMAC verification later rejects, calls `reportEnded(callId, 'failed')` so CallKit dismisses (½-second flash of UI in worst case, far better than entitlement loss)

##### Activation steps (when Apple cert lands)

1. Issue Apple VoIP Services Certificate at developer.apple.com → Certificates → +
2. Download the `.p8` auth key file from Apple Developer Console → Keys
3. Deploy `.p8` to messenger-service host (any path, referenced by env var)
4. Set 4 env vars on messenger-service:
   ```
   APNS_VOIP_KEY_ID=ABC1234DEF
   APNS_VOIP_TEAM_ID=YOUR_10_CHAR_TEAM
   APNS_VOIP_BUNDLE_ID=com.bravosecure.app
   APNS_VOIP_KEY_PATH=/etc/bravo/AuthKey_ABC1234DEF.p8
   APNS_VOIP_SANDBOX=1                   # optional, for TestFlight smoke
   ```
5. Flip `IOS_RUNTIME_ENABLED = true` in [callKitBridge.ts](src/modules/messenger/push/callKitBridge.ts) (one line)
6. EAS iOS build: `npx eas build --profile preview-staging --platform ios`
7. TestFlight smoke test: lock-screen ring, system Accept/Decline propagates, background→foreground answer

##### iOS prerequisites (NOT YET satisfied)

- [ ] Apple VoIP Services Certificate (manual issue at developer.apple.com)
- [ ] `.p8` auth key downloaded and deployed to messenger-service host
- [ ] APNS*VOIP*\* env vars set in production / staging
- [ ] EAS iOS build cred provisioning updated for VoIP entitlement

#### True 1:1 voice-to-video upgrade — **LANDED Round 7 (2026-05-07)**

**Status**: ✅ Shipped end-to-end. Voice-call users tap Camera; the
client acquires the camera (with Android permission pre-prompt),
addTracks to the live PC, and runs an SDP renegotiation through the
new `call.reoffer` / `call.reanswer` frames. Failure modes have
specific Alert copy; success is silent and the screen swaps to video
mode without remounting via the new `isVideoUI` derived flag. Peer
upgrades raise a "Turn on yours too?" prompt — no auto-acquire of
the responder's camera (privacy). 14 unit tests cover the state
machine, glare, watchdog, hangup-mid-renegotiation, and callId
mismatch.

**Files touched**:

- `apps/messenger-service/src/gateway/protocol.ts` — added
  `ClientCallReOffer` / `ClientCallReAnswer` + server mirrors.
- `apps/messenger-service/src/gateway/messenger.gateway.ts` — two
  new `@SubscribeMessage` handlers (pure relay, no offline queue,
  no push — same shape as call.media-state).
- `src/modules/messenger/transport/protocol.ts` — client mirror.
- `src/modules/messenger/webrtc/signallingClient.ts` —
  `sendReOffer` / `sendReAnswer` (waitOpenThenSend), `onReOffer` /
  `onReAnswer` subscribers, `ingest` switch routes the new events.
- `src/modules/messenger/webrtc/callDispatcher.ts` — pending-frame
  queue extended for `call.reoffer` / `call.reanswer`.
- `src/modules/messenger/webrtc/callController.ts` —
  `upgradeToVideo({prepare, watchdogMs})` + `handleReOffer` /
  `handleReAnswer` private methods, glare detection on
  `signalingState`, in-flight Promise lock, end()
  rejects-mid-renegotiation.
- `src/modules/messenger/webrtc/useCall.ts` — `upgradeToVideo`
  callback, `peerAddedVideo` + `isUpgrading` state, rollback path,
  `onRemoteRenegotiation` host hook, registry `kind: 'video'` patch
  on success.
- `src/modules/messenger/webrtc/types.ts` — optional
  `signalingState` on `PeerConnectionLike` for glare tests.
- `src/screens/messenger/CallScreen.tsx` — Alert replaced with
  upgrade flow, Android CAMERA pre-prompt, `isVideoUI` swap,
  peer-added-video Alert, button label flips to "Adding…" while
  in-flight.
- `src/modules/messenger/__tests__/webrtcSignalling.test.ts` — 9
  new tests for the renegotiation pipeline.

**Hard prerequisite (now satisfied)**: server change ships in the
same commit as the client; both the offer→answer path and the
reoffer→reanswer path are pure relays, so a stale client falls
through to its watchdog gracefully (10 s) rather than the call
dying.

#### RTCView Fix #13 full unified-grid restructure — **CLOSED — shipped end-to-end in v1.0.18**

**Status**: ✅ Closed 2026-05-07. End-to-end rewrite shipped, the
post-rewrite retention regression (BS-024) was caught in the next
session and fixed in the same v1.0.18 build. Deferral lifted; this
section stays in the doc as the audit-trail for what was done and
why. Skip to the next section unless you specifically need the
historical context.

**Original deferral rationale (kept for context):** workaround
landed in v1.0.13 (`key={tag}` swap + cached merged style array).
Reviewed 2026-05-07 — high regression risk vs. low marginal value at
the time. **Then taken on anyway** in the same session: helper
extraction first (zero behaviour diff) → position resolver →
screen-side render-tree rewrite → SQA build → BS-024 retention
regression caught + fixed in the v1.0.18 follow-up.

**What's involved**:

- The unified grid would absolutely-position every tile, where the hero tile is just one of N tiles with bigger geometry. Same z-stack, no swap on focus change. Theoretical wins: smoother hero transitions, easier multi-hero (active-speaker spotlight), less reliance on RN's flexbox dance.
- GroupCallScreen.tsx is 1819 lines. The current layout is load-bearing across BT route restoration, hero-hold silence-pin, FlexibleVideoTile aspect-ratio adaptation, mute/camera-off overlays, invite ring tickers, and the floating overlay handoff. Restructuring touches ALL of these.
- Doc explicitly classifies as a "deferred design improvement" — workaround is good enough.

**Estimated effort**: 2-3 days, real-device testing across 2/3/4/5+ participant counts required.

**Recommended interim step**: extract grid math into a single `computeTileLayout(participants, hero) → {tag, x, y, w, h}[]` helper. Half-day, zero user-visible change, isolates the layout logic so a future swap is local. Saves ~1 day off the eventual rewrite.

- [x] **Interim step LANDED 2026-05-07.** New module
      [src/modules/messenger/webrtc/groupCallLayout.ts](src/modules/messenger/webrtc/groupCallLayout.ts)
      ships three pure helpers — `mergeAndSortTiles`, `applyHeroHold`,
      `paginateOthers` — and replaces the inline `useMemo` blocks at
      [GroupCallScreen.tsx:306-408](src/screens/messenger/GroupCallScreen.tsx#L306-L408).
      The flexbox-driven layout means tiles don't have explicit
      `(x, y, w, h)`; the equivalent extraction is "decide which slot
      each tile occupies", which is what the new helpers own.
      Behavioural diff: zero — the screen retains the React
      reference-identity layer (sig + debounce cache) so RTCView
      identity is still stable across audioLevels ticks. The helper
      returns the same `prev` ref for `nextHold` when the hold is
      unchanged, so the screen also skips the `useRef` write on
      no-op transitions. 32 unit tests in
      [src/modules/messenger/**tests**/groupCallLayout.test.ts](src/modules/messenger/__tests__/groupCallLayout.test.ts)
      cover all four hero-hold branches, every participant count from
      0–6, the chunk-boundary at `i += 3`, and the integration of
      merge → hold → paginate end-to-end. The full unified-grid
      restructure remains deferred but is now scoped to the screen
      file alone — the layout math is no longer entangled with it.

- [x] **Position resolver LANDED 2026-05-07** — pure function
      `resolveTilePositions(layout, slotRects, pageW)` added to the
      same helper file. Maps each tile (by tag) to an absolute
      `{role, x, y, width, height, page, visible}` rect on the
      page-stack canvas. Unmeasured slot rects produce `visible:false`
      tiles (screen renders hidden, no remount). Cross-page tiles
      x-shift by `pageW * page` so they live on the correct logical
      page of a translateX-swiped stack. 11 additional unit tests
      cover hero-alone, hero+2 small, 4-participant grid spillover,
      6-participant 3-page span, partially-measured rects, and the
      role-swap-without-remount property. **Total helper coverage:
      43 tests.**

- [x] **Screen-side render-tree rewrite LANDED 2026-05-07 — shipped to qa in v1.0.18**.
      [GroupCallScreen.tsx](src/screens/messenger/GroupCallScreen.tsx)
      now uses the unified persistent-tile model:

      - **Slot skeleton layer** — invisible flexbox replicas of every
        page (page 0 = hero+smallRow, pages 1+ = equal-3 grid) live as
        absolute siblings inside the swipe wrapper. Each slot reports
        its rect via `onLayout` into `slotRectsRef` + a version
        counter (`bumpSlotRects`) that triggers re-resolve. Geometry
        is byte-identical to the pre-rewrite layout because we reused
        the same `s.heroTile` / `s.smallRow` / `s.gridThree` /
        `s.gridThreeSlot` styles in the skeleton. The smallRow's
        page-local y is captured separately via its own onLayout
        (`smallRowYRef`) and applied to small1/small2 rects so the
        resolver receives true page-local coords.
      - **Tiles layer** — one persistent `<View key={tag}>` per
        retained tile, absolutely positioned from
        `resolveTilePositions`. Hero ↔ small role swaps are now
        CSS-only — `RTCView` (inside `FlexibleVideoTile`) never
        unmounts on role transition.
      - **Tag retention** — `retainedRef: Map<tag, RetainedEntry>`
        keeps every tag ever seen in the call mounted, with a
        1-second eviction tick that drops entries older than
        `RETENTION_TTL_MS = 5000`. Self tile is never evicted.
        Retained-but-currently-absent tiles render with
        `visible: false` (opacity 0, pointerEvents none).
      - **Pagination** — all pages render simultaneously on a
        `width: PAGE_W * totalPages` canvas; settled position
        animates via `Animated.spring` on `settledX`, gesture delta
        via `Animated.event` on `swipeX`. Outer pageWrap has
        `overflow: 'hidden'` to clip off-screen pages.
      - **PanResponder pre-existing-bug fix** — the swipe handler
        was reading `pageIndex` / `totalPages` from mount-time
        closure, so repeated swipes used stale values. Mirrored
        both into refs (`pageIndexRef`, `totalPagesRef`) so the
        handler reads live values.
      - **Camera-off avatar** — given an explicit `aspectRatio`
        (16:11 hero, 9:12 small) so the absolute-positioned wrapper
        gets a deterministic height when no video is present.
      - **Host long-press** — overlay `<TouchableOpacity
        style={StyleSheet.absoluteFill}>` rendered ONLY when
        `call.isHost` (not for non-host members). Outer pageWrap
        retains the swipe PanResponder; long-press yields to swipe
        when `Math.abs(g.dx) > 10`.

      **Verification done in this session:**
        - `tsc --noEmit` net delta vs baseline: 0
        - 19/19 jest suites pass, 177/177 tests pass
        - Static audit of all 7 documented load-bearing dependents
          (BT route, hero-hold, FlexibleVideoTile aspect, mute
          overlays, invite ring tickers, FloatingCallOverlay
          handoff, speaking border) — all preserved.

      **Post-ship regression caught + fixed (v1.0.18, BS-024):**
      the retention-eviction interval was keyed on `[layout]`, but
      the merged-cache deliberately returns a stable array reference
      when the tag set is unchanged (preserves RTCView identity
      across audioLevels ticks) → `lastSeenMs` went stale → 5 s
      after the call started, every retained remote tile was
      wrongly evicted from `retainedRef` and the render loop
      stopped iterating them. Fixed in v1.0.18 by adding
      `call.remoteTiles` as a second dep on the layout-stamp effect
      plus a belt-and-suspenders refresh inside the eviction tick
      that re-stamps `lastSeenMs` for any retained tag still
      present in the live tile set. Eviction now strictly means
      "tag has actually left the call".
      [GroupCallScreen.tsx:469-528](src/screens/messenger/GroupCallScreen.tsx#L469-L528).

      **SQA test checklist (real device, before push):**

      Run each scenario on Android first, then iOS if available.
      Test on at least one mid-tier Android (Pixel 6a / Galaxy A53
      class) plus one budget Android (≤2GB RAM if available) — the
      RTCView decoder path is most likely to crack on low-end GPUs.

      **A. Active-speaker swap (the headline win — no flicker)**
        1. Start a 3-participant video call (you + 2 others).
        2. Both peers speak alternately, ~5s each, for ~30s.
        3. Watch the hero tile when it swaps. EXPECTED: smooth
           position change with no black-flash, no aspect-snap-to-16:9
           glitch, no decoder stutter. (Pre-fix: brief flicker on
           every swap.)

      **B. Page-swipe with retained off-screen tiles**
        1. Start a 5-participant call (you + 4 others, video on for
           all).
        2. Swipe to page 1 (the equal-3 grid).
        3. Swipe back to page 0.
        4. Swipe to page 1 again.
        EXPECTED: no decoder hiccup on either swipe. Off-screen
        tiles stay live in memory; first frame on swipe-in is
        immediate (not "loading then frame").

      **C. Camera-off / camera-on toggle mid-call**
        1. 2-participant call. Peer turns camera off.
        2. EXPECTED: peer's tile transitions to avatar+initials with
           "Camera off" text. No layout collapse. No black hole.
        3. Peer turns camera back on. EXPECTED: video tile reappears,
           hero size adjusts to source aspect within ~150ms.

      **D. Transient peer drop (retention test)**
        1. 4-participant call with a peer on a flaky network. Have
           that peer toggle airplane mode for ~3s, then off.
        2. EXPECTED: their tile stays visible (with last-known
           frame frozen) for the gap, then resumes when they
           reconnect. No remount, no flicker.
        3. If they stay disconnected >5s: tile fades out (eviction
           kicks in).

      **E. Host actions — mute / kick on long-press**
        1. As host, long-press a remote-small tile.
        2. EXPECTED: Alert appears with Mute / Remove options.
        3. Long-press DURING a horizontal swipe — the swipe should
           win (page change), no Alert.
        4. As non-host, long-press a remote tile — nothing happens.

      **F. Minimize → restore handoff**
        1. 3+ participant call.
        2. Tap minimize (chevron-down top-left).
        3. EXPECTED: floating overlay shows active speaker.
        4. Tap overlay to restore.
        EXPECTED: room reopens, all tiles still mounted, no
        re-decoding.

      **G. BT headset route (if available)**
        1. Start a call with BT headset connected.
        2. EXPECTED: Speaker icon shows BT, audio routes through BT.
        3. Drop BT (turn off headset). Audio falls back to earpiece.
        4. Reconnect BT — audio auto-restores to BT (preferred-route
           pin).
        5. Tile layout MUST not flicker during any of this — audio
           routing is independent of render tree.

      **H. Incoming 1:1 banner during group call**
        1. While in group call, have someone dial you 1:1.
        2. EXPECTED: incoming banner appears at top with z-index
           above tiles. Accept tears down group + jumps to 1:1.
        3. Decline keeps you in the group, tiles unchanged.

      **I. Memory soak — long call with churn**
        1. 4-participant call, 30 min.
        2. Have 1 peer leave + rejoin every ~2 min, with different
           tag.
        3. EXPECTED: Android memory profile stays bounded
           (retention + 5s eviction). No accumulated RTCViews.
        4. Final teardown returns to home screen cleanly with no
           orphaned audio.

      **J. Edge cases**
        - 1-participant call (just you): EXPECTED: empty-hero card
          "Waiting for others to join…" + your self tile in
          small slot.
        - 2-participant call: hero + your self tile in small slot.
        - 6-participant max-cap call: pages 0+1+2 all populated.
        - Rapid join+leave (peer joins, leaves within 2s): tile
          appears + retains briefly + evicts cleanly.
        - Orientation change mid-call: layout adapts, tiles stay
          mounted (not strictly required to preserve identity
          across orientation but no crashes either).

      **Rollback path if SQA finds a critical regression:**
      `git revert` JUST the GroupCallScreen.tsx changes (helper +
      tests are independent, keep them). The pre-rewrite render
      lives in commit history.

#### TS strict-mode cleanup

**Status**: 249 pre-existing TS errors as of 2026-05-07 (was ~110 at the original audit; TS 5.9+ added more `BufferSource` / `SharedArrayBuffer` strictness on top). Most clusters: `backupCrypto.ts` (BufferSource overload narrowing), `ChatScreen.tsx` (NavLike from CompositeNavigationProp), vector-icons name string narrowing across screens.

**What's needed**: surgical type assertions or schema updates across 30+ files. Doesn't block runtime; would just clean up the noise.

**Estimated effort**: half-day.

#### Vault test refactor

**Status**: vaultStore tests are sync; v1.0.13 made setupPin/verifyPin/changePin async. Tests need rewrite.

**Estimated effort**: 1-2 hours.

---

## Part 3 — What you should observe AFTER installing v1.0.13

These are the **user-visible improvements** to test for after the build installs. If any of these don't work, log it for Round 2.

### Crashes / freezes that should NO LONGER happen

1. **App freeze when ending a video call mid-renegotiation** (was: PC kept doing createOffer/setRemoteDescription on closed transport). Now: leaveInternal sets `isLeavingRef.current = true`, signal handlers bail.
2. **App crash with `mqt_v_native FATAL` when group video call starts on a chat with disappearing messages**. Now: MessageBubble burn animation no longer mixes JS-driven and native-driven animations in same parallel block.
3. **App freeze when WhatsApp call interrupts Bravo call**. Now: audio-focus listener auto-mutes mic, shows "Paused" banner. (Full Telecom integration is still deferred, but the freeze is gone.)
4. **App crash when reopening Bravo while in a video call (Doze freeze + thaw)**. Now: `safeStreamURL` wraps all RTCView toURL calls — dead native handles return null and tile renders avatar fallback instead of SEGFAULT through JNI.
5. **Group call tiles freeze after minimize→restore; mutes/kicks silently dropped**. Now: SFU frame handler re-registers on resume-from-registry.
6. **Random "Maximum update depth exceeded" crash in GroupCallScreen on fresh group create**. Now: Zustand selector returns stable EMPTY_MESSAGES reference.
7. **Permanent decrypt failure on rapid back-to-back sends to same peer**. Now: per-address session mutex serializes the Double Ratchet.

### Connectivity issues that should be resolved

1. **TURN 401 → calls stuck "connecting"**. Now: `fetchWithRefresh` auto-refreshes JWT on 401, retries once.
2. **BT headset doesn't reappear in Speaker picker after SCO drop+reconnect**. Now: `preferredRouteRef` re-snaps to BT when it returns.
3. **Add Call → last joinee fails with peer_offline**. Now: `inviteUsers` retries once after 1.5s on peer_offline.
4. **First ring fails silently → recipient never sees call**. Now: `sentRingRef` only set after successful wsRequest, allowing retry.
5. **Old envelopes lost on long-offline reconnect (>50 backlog)**. Now: drainRelay paginates with 10-iter cap.
6. **JWT expires mid-session → every send/pull fails**. Now: HTTP clients support `refreshToken` callback (wired through axios path; runtime opt-in for the rest).

### UX improvements you should see

1. **Group call invite list is no longer in the room UI**. Pending invitees show only inside the Invite modal (not as ghost tiles in the grid).
2. **Group call Speaker picker shows BT** (BLUETOOTH_CONNECT permission request fires on mount).
3. **Voice call Camera button shows Alert** "This is a voice call. To use video, end this call and start a new video call." (Mid-call upgrade is not supported.)
4. **Camera-off has clear visual feedback** — red tint on the button, "Camera off" / "Video off" label.
5. **Video call chrome auto-hide also fades the dark gradient scrim** (no lingering vignette over the remote face).
6. **Active speaker name + video tile in the floating overlay** when minimized (audio: name pill; video: live PiP of speaker).
7. **Incoming 1:1 call during a group call shows a banner** (not a screen yank). Accept tears down group + jumps to 1:1.
8. **Invite Ring button shows "Ringing… 24s" countdown** then re-arms.
9. **WhatsApp-flexible group video tiles** — no crop, no black bars (tile bends to source video aspect).
10. **Hero tile no longer flickers when nobody is speaking** (silence-pin keeps the previous hero).
11. **Audio route switch (BT/earpiece/speaker) feels instant** — picker closes optimistically before the native call resolves.

### Reliability improvements that should be invisible (but real)

1. **Heartbeat doesn't leak** across re-logins (was: 5 logins = 5 ping timers fighting).
2. **Persist middleware no longer multi-MB JSON.stringify on every keystroke** (debounced 500ms).
3. **drainRelay can't run concurrently** (mutex prevents libsignal session-rebuild oscillation).
4. **Backup mirror queue capped at 500** — won't OOM on long network outage.
5. **Backup `markDirty` wired** — reactions/status/retract tokens now replicate (previously the FIRST state of each message was the only state in backup).
6. **Vault PIN brute-force-protected** — Argon2id + lockout schedule.
7. **Group admin authz enforced** — non-admin members can't add/remove other members.
8. **Group ID is deterministic** — concurrent admin "create group" no longer produces two parallel groups.
9. **Per-OPK exhaustion fixed** — `peerIdentityCache` (8min TTL) means we don't pop a recipient's one-time pre-key on every message.
10. **Identity-rotation recovery cooldown** stamped only after success, so transient network failures don't lock recovery for 60s.

### Things you might NOT yet see (Round 9 update — 2026-05-07, v1.0.18)

After Round 9, these are the items still NOT in the build:

- **CallKit / iOS background-call equivalent** — full milestone (13–21 days). Hard prerequisites: Apple VoIP cert, Expo workflow decision, server APNs path. See dedicated section above.
- **TS strict-mode cleanup** (~251 errors, half-day; +2 since Round 6 from the renegotiation `RTCRtpSendParameters` ambient-DOM type pattern).
- **Vault test refactor** (sync → async, 1-2 hours).

Items that USED to be on this list but landed in Round 5 + Round 6 + Round 7 + Round 9:

- ✅ Per-bubble disappearing-message countdown — single global 1 Hz pub/sub via `useSyncExternalStore`.
- ✅ MessengerHomeScreen presence subscribe storm — memoized via `peerIdsKey`.
- ✅ Dead `VoiceCallScreen.tsx` — gated behind `__DEV__` (release returns null).
- ✅ Duplicate Add-picker Modal in CallScreen — lifted into single shared `addPickerModal` JSX.
- ✅ Tab nav setOptions on null parent — migrated to `useFocusEffect`.
- ✅ **All 8 Round 5 security items (S1–S8)** — see commit `f0b680e`.
- ✅ **BS-021 + BS-022** — remote camera-off placeholder + gesture-minimize navigation. Commit `7011e6a`.
- ✅ **ChatScreen FlatList migration (Fix #30 round-2)** — keyExtractor stable, ListHeader/Footer memoised, scroll handlers identity-stable.
- ✅ **CallsLog/Files/Groups derived selector slices** — narrow store subscriptions; cross-conversation appends no longer re-render the filter screens.
- ✅ **WS frame handlers ownerKey race** — owner-epoch stamp gates `onFrame`/`onStateChange`/`coalescedDrain`/AppState/heartbeat against stale-runtime fires after logout.
- ✅ **`runtime.loadOlderMessages` real pagination** — was comment-only; now wired through `sqlMessages.loadOlder` + `prependOlderMessages` + ChatScreen near-top trigger with `maintainVisibleContentPosition`.
- ✅ **Round 7: 1:1 voice→video upgrade** — full SDP renegotiation pipeline (`call.reoffer` / `call.reanswer`). See "True 1:1 voice-to-video upgrade — LANDED Round 7" section above.
- ✅ **Round 9 (v1.0.18): contact-name passive sync** — Home screen now patches auto-created direct rows ("Bravo · abcd1234" / UUID prefix) with the user's saved contact label on every open, no system permission prompt. Mirrors WhatsApp.
- ✅ **Round 9 / BS-024: group-call retention bug** — tiles disappearing 5 s after first appearing. Layout-stamp effect now also depends on `call.remoteTiles` + the eviction tick refreshes `lastSeenMs` for any tag still present in the live tile set.
- ✅ **Round 9 / BS-025: voice→video upgrade retry stuck in have-local-offer** — controller now rolls back the local SDP via `setLocalDescription({type: 'rollback'})` on every renegotiation failure path so the next attempt starts from `stable`.
- ✅ **Round 9 / BS-026: in-call chat sheet locks up after first send** — added `keyboardShouldPersistTaps="handled"` + `blurOnSubmit={false}` so the keyboard stays up across back-to-back sends and the next composer tap isn't absorbed by the ScrollView.
- ✅ **RTCView Fix #13 full unified-grid restructure** — closed in v1.0.18. Helper extraction (`groupCallLayout.ts`) + position resolver (`resolveTilePositions`) + screen-side render-tree rewrite all shipped; the BS-024 retention regression caught afterward was fixed in the same v1.0.18 build. End-to-end in qa testers' hands.

---

## Part 4 — Resume protocol (for next session)

**Status as of Round 9 / v1.0.18 (2026-05-07):** Rounds 1–9 fully
landed. All 48 original hot-screen items are in. Round 5 closed all 8
security audit items (S1–S8). Round 6 closed the three remaining
tractable perf/race items (derived selectors, owner-epoch, real
pagination) plus the ChatScreen FlatList stabilisation. Round 7
closed the 1:1 voice→video upgrade pipeline. **Round 9 (this build)
closed contact-name resolution on the chat list (WhatsApp-style
passive sync) plus three group-call regressions:** BS-024 retention
eviction wrongly evicting live tiles, BS-025 voice→video retry stuck
in `have-local-offer`, BS-026 in-call chat keyboard dismissing after
first send. Build shipped as v1.0.18 (versionCode 19), Firebase
release `5cenhn1ssrvj0`. The audit punch-list from Rounds 2/4 is
empty except for milestones that need native infrastructure.

To resume in a future session, run through this checklist:

1. Read this file (`REMAINING_TODO.md`) first.
2. Remaining work, ranked by user-visible impact and feasibility:
   - **CallKit + Telecom unified milestone** — multi-week; needs
     Apple VoIP cert + Expo workflow decision before kickoff. See
     dedicated section above for the full pre-flight checklist.
   - **RTCView Fix #13 unified-grid restructure** — 2-3 days, high
     regression risk on the 1819-line GroupCallScreen. Recommended
     interim: extract `computeTileLayout` helper (half-day, zero
     user-visible change).
   - **TS strict-mode cleanup** (~251 errors, half-day) — pure noise
     reduction, no behaviour risk.
   - **Vault test refactor** (1-2 hours) — sync → async.
3. For commit hygiene: every fix should reference its round/audit ID
   (e.g. "Round 5 / Security S3", "Round 6 / Task 2 / owner-epoch",
   "Round 7 / voice→video") in the commit message so we can trace
   coverage.
