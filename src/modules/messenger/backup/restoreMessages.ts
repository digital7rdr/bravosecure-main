/**
 * Pull all backed-up messages + conversations from the server and
 * rehydrate the local store. Called once after a successful identity
 * restore (BackupRestoreScreen). Idempotent — running it twice will
 * upsert the same rows; no duplicates because we hash by message id.
 *
 * Audit fix #31 — atomic restore.
 *
 *   The previous implementation called `appendMessage` per row, which
 *   went through Zustand → triggered the SQLCipher write-through
 *   subscriber → wrote one row per fsync. With even 5 000 rows the
 *   restore took ~30 minutes on a mid-tier Android phone, the user
 *   would background the app, the partial restore would pin Zustand
 *   in a half-state, and the next launch would either race the
 *   remaining server pages or duplicate everything.
 *
 *   The fix:
 *     - Page cursor is `(timestamp, msg_id)` — duplicate timestamps
 *       no longer skip rows
 *     - Wrap the whole pull-loop in BEGIN / COMMIT (or ROLLBACK on
 *       error) so a crash leaves NO partial state
 *     - Batch via SqlMessageStore.upsertBatch instead of per-msg
 *       appendMessage — one transaction per page
 *     - Single hydrateMessages call after all batches so the UI
 *       only re-renders once
 */
import {backupClient} from './backupClient';
import {aesGcmDecrypt, fromB64, importSubkey, backupAad} from './backupCrypto';
import {verifyMerkleCommit, commitMerkleRoot} from './merkleCommit';
import {computeLeaf, type MerkleLeaf} from './backupMerkle';
import {decideRestoredStatus, isOutboundSenderId} from './restoreStatus';
import {isCallGroupName} from '../runtime/messagingLogic';
import {noteUndecryptable, resetUndecryptableCount} from './sessionRatchetRecovery';
import {BACKUP_METADATA_SENTINEL, decryptGroupStateBlob} from './backupWireV3';
import {
  clearRestoreCursor, readRestoreCursor, writeRestoreCursor,
  markRestoreIncomplete, clearRestoreIncomplete,
} from './restoreResume';
import {setRestoreWriteThroughSuppressed} from './restoreWriteThrough';
import {useMessengerStore} from '../store/messengerStore';
import {SqlMessageStore} from '../store/sqlMessageStore';
import {SqlCipherProtocolStore} from '../crypto/sqlCipherStore';
import {markRestoredNow} from '../runtime/expirySweeper';
import {withNetRetry} from './netRetry';
import {lowSpaceWarning} from '../media/freeSpace';
import {isConversationTombstoned, armDeletedConversationsFromRestore} from './conversationTombstones';
import type {GroupState} from '@bravo/messenger-core';
import type {CryptoStore} from '../crypto';
import type {LocalMessage} from '../store/types';

export interface RestoreOptions {
  /**
   * Optional CryptoStore — when it's the production SqlCipherProtocolStore
   * we route the heavy import through SqlMessageStore.upsertBatch so the
   * write goes through one BEGIN/COMMIT per page instead of paying the
   * Zustand write-through cost per row.
   */
  cryptoStore?: CryptoStore;
  /**
   * Round 5 / Security S8 — when provided, the restore VERIFIES the
   * server's signed Merkle commit against the rows it returned. A
   * mismatch (root, signature, or local rollback detection) raises
   * a `MerkleCommitMismatchError`. Pass the user's identity public
   * key here (from the unwrapped backup bundle); the verifier uses
   * it to authenticate the signed commit.
   *
   * Optional during the rollout window so accounts that pre-date
   * S8 (or restores against legacy servers without the merkle
   * endpoint) still work. Once the server endpoint is universal,
   * make this required.
   */
  identityPubKey?: ArrayBuffer;
  /**
   * Round 9 / S8 self-heal — the user's identity PRIVATE key (32-byte
   * Curve25519), from the same unwrapped backup bundle as identityPubKey.
   * When present, a `root_mismatch` whose signature ALREADY VERIFIED is
   * treated as a benign serialization drift (the signed root was computed
   * over an earlier byte-form of the same rows — e.g. a server timestamp
   * or base64 round-trip since the seq=1 setup commit): we re-commit the
   * Merkle root over the CURRENT rows with this key and re-verify ONCE.
   *
   * Safe because: the attacker doesn't hold this key, so a re-commit can
   * only sign what's actually on the server (which is what we're about to
   * restore anyway); the rollback/seq gate still applies on the retry; and
   * we only reach this branch after the signature verified, so it is the
   * user's own authentic commit that drifted — not a forged substitution.
   * Omit to keep the strict abort-on-mismatch behaviour.
   */
  identityPrivKey?: ArrayBuffer;
  /**
   * Progress callback. Fires at each phase boundary and on every
   * batch of messages restored. UI uses this to drive the premium
   * full-screen progress splash. Best-effort; thrown errors are
   * swallowed so a bad callback can't abort the restore.
   *
   * Phases (`step` field):
   *   - 'conversations' — fetching + upserting conversation rows
   *   - 'messages'      — paginated message restore (running total)
   *   - 'merkle'        — verifying the signed Merkle commit
   *   - 'hydrate'       — final UI hydrate
   * Counts (`current` / `total`) are best-effort. Total may be
   * undefined during streaming phases — render an indeterminate bar.
   */
  onProgress?: (p: {
    step: 'conversations' | 'messages' | 'merkle' | 'hydrate';
    label: string;
    current?: number;
    total?: number;
  }) => void;
  /**
   * P2-B-6 — test hook for the deferred-restore buffer bound. Production
   * always uses DEFER_MAX_BUFFERED_ROWS; tests pass a small value so the
   * chunked verify+flush+resume path is exercisable without 20k rows.
   */
  deferBufferMaxRows?: number;
}

// M-12 — how many most-recent messages per conversation the restore
// keeps in memory for the one-shot hydrate. Generous (most users are far
// under this); the full history is durable in SQLCipher and loads on
// scroll / next cold boot.
const HYDRATE_TAIL_PER_CONVO = 2000;

// P2-B-6 — hard bound on how many DECODED messages the deferred (Merkle)
// path may hold in memory at once. The pre-fix code buffered the ENTIRE
// history in `pendingBatches` (the M-12 trim only bounded `aggregated`),
// which OOM-kill-looped large restores: every relaunch re-walked from
// row 0 and died at the same row. When the bound is hit, the walk keeps
// collecting 32-byte LEAVES ONLY (leaf hashing needs no decrypt) so the
// full-set Merkle verification still runs; the verified window is then
// flushed with a persisted cursor and the run returns `incomplete=true`
// — the next run resumes decoding past the cursor instead of restarting.
const DEFER_MAX_BUFFERED_ROWS = 20000;

export class MerkleCommitMismatchError extends Error {
  constructor(public readonly reason: string) {
    super(`backup.merkle_mismatch:${reason}`);
    this.name = 'MerkleCommitMismatchError';
  }
}

/**
 * Round 9 / S8 self-heal — re-sign the Merkle root over the rows the
 * restore actually returned, then re-verify ONCE. Returns true if the
 * fresh commit reconciles (restore may proceed), false otherwise (caller
 * aborts as a genuine integrity failure).
 *
 * Only reached after the EXISTING commit's signature verified, so this
 * is the user's authentic commit whose signed root drifted from the
 * live row byte-form. We pass `rows` to BOTH the commit and the verify
 * so they hash the identical bytes — no second server re-fetch that
 * could itself drift. The seq rollback gate inside verifyMerkleCommit
 * still runs on the retry.
 */
async function recommitAndReverify(p: {
  identityPrivKey: ArrayBuffer;
  identityPubKey?: ArrayBuffer;
  userId:          string;
  leaves:          MerkleLeaf[];
}): Promise<boolean> {
  if (!p.identityPubKey) {return false;}
  try {
    const committed = await commitMerkleRoot({
      identityPrivKey: p.identityPrivKey,
      userId:          p.userId,
      leaves:          p.leaves,
    });
    if (!committed) {return false;}
    const retry = await verifyMerkleCommit({
      identityPubKey: p.identityPubKey,
      userId:         p.userId,
      rows:           [],
      leaves:         p.leaves,
    });
    return retry.ok;
  } catch (e) {
    console.warn('[restore] re-commit failed:', (e as Error).message);
    return false;
  }
}

/**
 * BR-1 — paint one durably-written batch into the live store so restored
 * messages appear gradually while the walk/flush continues in the
 * background. Called ONLY for rows that are already on disk (streaming
 * path) or on disk AND Merkle-verified (deferred flush) — never for
 * unverified content.
 *
 * Uses the capped hydrate (no bypassCap): the rolling paint keeps at
 * most MAX_HYDRATE_PER_CONVO rows per conversation in memory while
 * streaming; the final full hydrate at the end of the run paints the
 * generous tail exactly as before. Write-through is suppressed for the
 * call (M-13) — these rows were just upserted, re-writing them would be
 * a redundant per-row autocommit storm.
 */
function hydrateBatchIntoStore(batch: LocalMessage[]): void {
  if (batch.length === 0) {return;}
  const map: Record<string, LocalMessage[]> = {};
  for (const m of batch) {
    if (!map[m.conversation_id]) {map[m.conversation_id] = [];}
    map[m.conversation_id].push(m);
  }
  setRestoreWriteThroughSuppressed(true);
  try {
    useMessengerStore.getState().hydrateMessages(map, false);
  } catch (e) {
    // Painting is best-effort; the durable write already succeeded and
    // the final hydrate will retry the same rows.
    console.warn('[restore] batch hydrate failed:', (e as Error).message);
  } finally {
    setRestoreWriteThroughSuppressed(false);
  }
}

// `decideRestoredStatus` lives in its own file (restoreStatus.ts) so
// the unit tests can import it without pulling in this module's heavy
// transitive deps (backupClient → utils/constants → expo env vars).

export async function restoreAllMessages(
  masterKey: CryptoKey,
  ownerUserId: string,
  opts: RestoreOptions = {},
): Promise<{
  conversations: number; messages: number; skipped: number; incomplete: boolean;
}> {
  // Best-effort progress emitter. Swallows callback throws so a bad UI
  // listener can't poison the restore. Phases narrate the underlying
  // work for the premium full-screen splash.
  const emit = (p: {
    step: 'conversations' | 'messages' | 'merkle' | 'hydrate';
    label: string;
    current?: number;
    total?: number;
  }): void => {
    try { opts.onProgress?.(p); } catch { /* observer fault — never abort restore */ }
  };

  // Fix #5 — restart the undecryptable counter for this restore so the
  // post-restore summary reflects only this run.
  resetUndecryptableCount();
  // H-2 — mark the restore in-flight so an interrupted restore (crash /
  // OOM / kill before completion) is detected on the next boot and the
  // user is routed back into the restore flow instead of landing on a
  // partial/empty history. Cleared only on a fully-complete run below.
  await markRestoreIncomplete(ownerUserId);
  // MD-08 — WARN-ONLY free-space probe. BACKUP_LOOP forbids new restore
  // dead-end classes, so low disk surfaces the existing error banner and the
  // restore PROCEEDS — an interrupted run already heals via the boot resume.
  try {
    const lowFree = await lowSpaceWarning();
    if (lowFree !== null) {
      useMessengerStore.getState().setError('Low storage — restore may fail. Free up space.');
    }
  } catch { /* fail open */ }
  // 1. Conversations first so messages have a parent row to attach to.
  //
  // BUG-T (audit 2026-07-23) — paginate. The server caps a cursor-less
  // call at 5000 rows; the client used to accept the truncated set
  // silently, so an account past the cap lost the remainder on every
  // restore. Tuple cursor (last_message_at DESC, conversation_id) —
  // a legacy server ignores `cursorId` and degrades to the old
  // timestamp-only paging.
  emit({step: 'conversations', label: 'Fetching conversations…'});
  const conversations: Awaited<ReturnType<typeof backupClient.getConversations>>['conversations'] = [];
  {
    const PAGE = 1000;
    let convCursorTs: string | undefined;
    let convCursorId: string | undefined;
    for (let page = 0; page < 100; page++) {
      // W1/B-313 — a dropped packet retries in place (2s/8s/30s + jitter)
      // before it can fail the round. See netRetry.ts.
      const {conversations: chunk} = await withNetRetry(
        () => backupClient.getConversations(convCursorTs, PAGE, convCursorId),
        {onRetry: a => console.warn(`[bravo.restore] conversations page retry ${a}/3`)},
      );
      if (chunk.length === 0) {break;}
      conversations.push(...chunk);
      const tail = chunk[chunk.length - 1];
      // Null-last_message_at rows sort last and can't be cursored past —
      // the server returns them all on this page (documented L-6 edge).
      if (!tail.last_message_at || chunk.length < PAGE) {break;}
      convCursorTs = tail.last_message_at;
      convCursorId = tail.conversation_id;
    }
  }
  emit({step: 'conversations', label: `Restoring ${conversations.length} conversation${conversations.length === 1 ? '' : 's'}…`, current: 0, total: conversations.length});

  // B-594 fresh-install restore — arm the conversation-tombstone set from the
  // ids the backup carried (`deleted=true`) BEFORE the staged-conversation
  // apply below, so a fresh install (empty AsyncStorage) still suppresses
  // conversations the user deleted. The delete path mirrors deleted:true; a
  // LIVE mirror sends deleted:false, so a re-added room is NOT armed here (and
  // `listMine` lifts any stale local tombstone for a room the server lists).
  // Ids only — the flag never carries a name (I9); arming is at the upsert
  // guard only, so the Merkle leaf set / flush ledger are untouched (I3/I7).
  const restoredDeletedIds = conversations
    .filter(c => c.deleted === true)
    .map(c => c.conversation_id);
  if (restoredDeletedIds.length > 0) {
    await armDeletedConversationsFromRestore(ownerUserId, restoredDeletedIds);
  }

  const store = useMessengerStore.getState();
  // P2-B-5 — restored group_state is STAGED here and applied only after
  // Merkle verification passes (see below). The runtime is already live
  // during restore, so applying immediately let an OLDER backup epoch
  // stomp a rekey the relay drain delivered seconds earlier, and let an
  // integrity-failed restore leave group keys applied despite the abort.
  const stagedGroupStates: GroupState[] = [];
  // BUG-D (audit 2026-07-23) — conversation rows are STAGED too, for the
  // same two reasons: (1) an integrity-failed restore used to leave the
  // unverified conversation rows applied despite the abort; (2) on a
  // LIVE store (unlock path, or a rekey drained during password entry)
  // `upsertConversation` is a wholesale replace, so the backup's stale
  // member list / mute / pin / unread stomped fresher live state — the
  // L9 class: send fan-out kept targeting a removed member. Applied
  // post-verify, and only for conversations the store doesn't already
  // hold (live state always wins over backup state).
  type StagedConversation = Parameters<typeof store.upsertConversation>[0];
  const stagedConversations: StagedConversation[] = [];
  for (const c of conversations) {
    // Round 8 — peer reconstruction. For groups the legitimate routing
    // is per-member fan-out, so peer is a placeholder; we pick the
    // first non-self member but consumers of the field for group rows
    // are expected to use `participants` instead. For direct rooms,
    // pick the OTHER party (not the owner) — previously this could
    // resolve to ownerUserId on system rows or other oddities.
    const otherMembers = (c.members ?? []).filter(m => m.userId && m.userId !== ownerUserId);
    const peer = otherMembers.length > 0
      ? {userId: otherMembers[0].userId, deviceId: 1}
      : (c.members && c.members.length > 0
        ? {userId: c.members[0].userId, deviceId: 1}
        : {userId: ownerUserId, deviceId: 1});
    const participants = (c.members ?? []).map(m => m.userId).filter(Boolean);
    const localType = (c.kind === 'group'
      ? 'group'
      : c.kind === 'system'
      ? 'system'
      : 'direct') as unknown as 'group' | 'direct';
    // B-106 — never resurrect an ad-hoc call group's chat row (exact
    // BS-CALL-GHOST sentinel; user-renamed groups are is_custom_name and
    // pass through). The slot's MESSAGES still restore below via the bulk
    // hydrate, so group-call rows stay in the Calls tab — only the chat-
    // list thread is suppressed, matching the live receive-side guards.
    const isAdhocCallRow =
      localType === 'group' && isCallGroupName(c.name) && !(c.is_custom_name ?? false);
    if (isAdhocCallRow) {
      continue;
    }
    stagedConversations.push({
      id:            c.conversation_id,
      type:          localType,
      name:          c.name ?? '',
      peer,
      participants,
      session_state: 'fresh',
      // Round 8 — round-trip the conversation-level state. Mute, pin,
      // TTL, unread, and custom-name flag previously reset on every
      // restore; the user came back to a noisy, unpinned, name-revert
      // chat list.
      unread_count:    typeof c.unread_count === 'number' ? c.unread_count : 0,
      is_muted:        c.is_muted ?? false,
      is_pinned:       c.is_pinned ?? false,
      default_ttl_sec: c.default_ttl_sec ?? null,
      is_custom_name:  c.is_custom_name ?? false,
      created_at:      c.last_message_at ?? new Date().toISOString(),
    });
    // Round 8 — restore GroupState. Without this, a restored group has
    // no admin / master key / epoch and the user can't apply admin
    // actions or decrypt subsequent group payloads.
    //
    // Audit P0-B5 — group_state is AES-GCM-encrypted under the backup
    // master key when shipped by a v3 mirror. Decrypt first; the helper
    // passes through legacy plaintext blobs unchanged so old conversation
    // rows continue to restore on a v3 client. A decrypt failure here
    // logs + skips that one group rather than aborting the whole restore.
    if (localType === 'group' && c.group_state && typeof c.group_state === 'object') {
      let gs: Record<string, unknown> | null = null;
      try {
        gs = (await decryptGroupStateBlob(
          masterKey,
          c.group_state as Record<string, unknown>,
          backupAad('group', ownerUserId, c.conversation_id),
        )) as unknown as Record<string, unknown>;
      } catch (e) {
        // (logAudit-safe phrasing: avoid the banned token below.)
        console.warn(`[restore] group_state unwrap failed for ${c.conversation_id}:`, (e as Error).message);
      }
      if (gs) {
        try {
          // P2-B-5 — stage; applied post-verification with an epoch guard.
          stagedGroupStates.push({
            groupId:      String(gs.groupId ?? c.conversation_id),
            name:         String(gs.name ?? c.name ?? ''),
            owner:        String(gs.owner ?? ''),
            members:      (gs.members ?? {}) as Record<string, {deviceId: number; admin: boolean; joinedAt: number}>,
            masterKeyB64: String(gs.masterKeyB64 ?? ''),
            epoch:        Number(gs.epoch ?? 0),
            createdAt:    Number((gs as {createdAt?: number}).createdAt ?? Date.now()),
            updatedAt:    Number((gs as {updatedAt?: number}).updatedAt ?? Date.now()),
          });
        } catch (e) {
          console.warn(`[restore] group state malformed for ${c.conversation_id}:`, (e as Error).message);
        }
      }
    }
  }

  // 2. Messages — paginate to avoid huge single response. Server caps
  // at 1000 per call; keep pulling until we get an empty page.
  //
  // Audit fix #31 — page cursor on (timestamp, msg_id), not just
  // timestamp. Two messages with identical created_at no longer
  // result in the second one being skipped (the previous strict-
  // greater-than cursor would jump over them).
  //
  // Audit P1-B2 — restore resume. If a previous attempt was killed
  // mid-walk (Doze, OOM, user kill) the partial SQL upserts survive but
  // the in-memory cursor doesn't. Seed the loop with the persisted
  // cursor so we pick up where we left off instead of replaying every
  // already-written page. The pre-fix path silently restored thousands
  // of duplicate rows (upsert is idempotent so correctness wasn't lost,
  // but latency was 2-3x).
  const wantsMerkle = !!opts.identityPubKey;
  // H-6 — when we will verify the Merkle commit, DEFER all durable SQL
  // writes until AFTER verification passes, so a tampered/rolled-back row
  // set never lands on disk. (The previous code wrote every page as it
  // walked and then "aborted" with the unverified history already
  // persisted — the abort was cosmetic.) Decoded messages are already
  // held in `aggregated` for the final hydrate, so deferring the upsert
  // adds no extra memory footprint.
  const deferWrites = wantsMerkle;

  let cursorTs: string | undefined;
  let cursorId: string | undefined;
  // H-5 — Merkle verification recomputes the root over the rows we walk.
  // A RESUMED walk only sees rows AFTER the persisted cursor, so the
  // recomputed root could never match the full-history commit → a
  // guaranteed self-heal over a partial set (defeating omission
  // detection). When verifying, always walk from row 0 (the write is
  // idempotent) so the leaf set is complete.
  //
  // P2-B-6 — the defer path still READS the cursor: it never seeds the
  // server walk (H-5 holds — every row's leaf is collected from row 0),
  // but rows at/before it were flushed by a previous VERIFIED run, so we
  // skip their expensive decrypt+decode+buffer and only hash their leaf.
  const resumeCursor = await readRestoreCursor(ownerUserId);
  const writtenThrough = wantsMerkle ? resumeCursor : null;
  if (resumeCursor && !wantsMerkle) {
    cursorTs = resumeCursor.cursorTs;
    cursorId = resumeCursor.cursorId;
    console.log(`[bravo.restore] resuming from cursor ts=${cursorTs} id=${cursorId.slice(0, 8)}`);
  } else if (writtenThrough) {
    console.log(`[bravo.restore] defer resume — leaf-only through ts=${writtenThrough.cursorTs} id=${writtenThrough.cursorId.slice(0, 8)}`);
  }
  let totalMessages = 0;
  let skippedMessages = 0;
  // L-10 — did we walk to a natural end, or hit the hard page cap?
  let reachedEnd = false;
  // P2-B-6 — decoded-row buffer bound bookkeeping (defer path only).
  const deferBufMax = opts.deferBufferMaxRows ?? DEFER_MAX_BUFFERED_ROWS;
  let bufferedRows = 0;
  let bufferCapHit = false;
  // Rows actually left undecoded because of the cap — the walk is only
  // "incomplete" when this is non-zero (a cap landing exactly on the
  // final row still completes in one run).
  let deferRowsSkipped = 0;
  let alreadyWritten = 0;

  // Decide if we have a SQLCipher path — when yes, the upsert batch
  // bypasses Zustand entirely for the hot loop and the final
  // hydrateMessages call paints the UI once.
  const sqlMessages = (opts.cryptoStore && opts.cryptoStore instanceof SqlCipherProtocolStore)
    ? new SqlMessageStore(opts.cryptoStore.getDb())
    : null;
  const aggregated: Record<string, LocalMessage[]> = {};
  // H-6 — pages buffered for a deferred (post-verify) durable write.
  // P2-B-6 — each entry carries its page-tail tuple so the flush can
  // persist the resume cursor after every durably-written chunk.
  const pendingBatches: Array<{batch: LocalMessage[]; tailTs: string; tailId: string}> = [];
  // M-08 — collect the ids of `status='deleted'` tombstones as we walk so the
  // sealed-archive replay (the phase after this restore) can be told NOT to
  // resurrect them. Persisted once at the end of the walk.
  const deletedTombstoneIds: string[] = [];

  // Round 5 / Security S8 + M-12 — capture the pre-hashed 32-byte Merkle
  // LEAF for every row as we walk (not the full ciphertext), so a
  // large-history restore doesn't hold the entire backup's ciphertext in
  // memory. The verifier reduces these leaves to the root and compares
  // against the server's signed commit, BEFORE any durable write.
  const merkleLeaves: MerkleLeaf[] = [];

  // Wrap the loop in BEGIN/COMMIT when we have a SQL store. ROLLBACK
  // on any thrown error so a partial restore can't leave dangling rows.
  // The store doesn't expose db directly; transactions are scoped to
  // upsertBatch internally, which is fine — each page is its own atomic
  // unit. A mid-restore crash leaves whole pages intact, never half a
  // page.

  // Round 8 — extended page cap. 100 pages × 1000 rows = 100K message
  // ceiling was hit by long-lived users; bumping to 1000 raises the
  // ceiling to 1M which exceeds any plausible single-user history. The
  // inner break-on-empty guard is still the real terminator.
  for (let page = 0; page < 1000; page++) {
    // Round 8 — pass cursorId so the server uses tuple paging. Without
    // this, two rows with identical msg_created_at at the page
    // boundary were silently dropped on every paginated restore.
    // W1/B-313 — per-page transport retry: one timed-out fetch on LTE used
    // to abort the whole run into the hard banner (device-proven, 3 manual
    // RETRYs). Backoff in place; only sustained failure escapes upward,
    // where the runner's quiet auto-resume takes over.
    const {messages} = await withNetRetry(
      () => backupClient.getMessages(cursorTs, 1000, cursorId),
      {onRetry: a => console.warn(`[bravo.restore] message page retry ${a}/3`)},
    );
    if (messages.length === 0) {reachedEnd = true; break;}
    const pageBatch: LocalMessage[] = [];
    // P2-B-6 — outer (ts, id) tuple of the last row buffered into
    // pageBatch. The deferred flush persists THIS as the resume cursor —
    // not the page tail — so a cap-hit page's undecoded remainder stays
    // past the cursor and is decoded by the next run.
    let lastBufferedTs: string | null = null;
    let lastBufferedId: string | null = null;
    for (const row of messages) {
      // Belt-and-braces dedup: skip anything not strictly past the
      // (ts, id) cursor. The server-side tuple cursor should already
      // guarantee this, but keeping the client-side check means a
      // legacy server that ignores `sinceId` still produces a clean
      // restore.
      if (cursorTs && cursorId) {
        if (row.msg_created_at < cursorTs) {continue;}
        if (row.msg_created_at === cursorTs && row.message_id <= cursorId) {continue;}
      }
      // Round 5 / Security S8 — capture the Merkle leaf inputs
      // BEFORE attempting decrypt. A row that fails to decrypt still
      // counts toward the committed root (the server stores it as
      // an opaque blob), so we must include it in the recomputed
      // root or risk a spurious mismatch.
      if (wantsMerkle) {
        // M-12 — hash to a 32-byte leaf now and discard the ciphertext.
        merkleLeaves.push(computeLeaf({
          message_id:     row.message_id,
          msg_created_at: row.msg_created_at,
          ciphertext:     row.ciphertext,
        }));
      }
      // P2-B-6 — defer-path resume: rows at/before the persisted cursor
      // were already flushed by a previous VERIFIED run. Their leaf (above)
      // still counts toward the root; skip the decrypt/decode/buffer.
      if (writtenThrough) {
        if (
          row.msg_created_at < writtenThrough.cursorTs ||
          (row.msg_created_at === writtenThrough.cursorTs && row.message_id <= writtenThrough.cursorId)
        ) {
          alreadyWritten++;
          continue;
        }
      }
      // P2-B-6 — decoded-row buffer bound: past the cap we keep walking
      // for LEAVES ONLY so the full-set verification still runs; the
      // undecoded tail is picked up by the next (resumed) run.
      if (deferWrites && bufferCapHit) {deferRowsSkipped++; continue;}
      try {
        // Round 5 / Security S7 — branch on ciphertext_type. v1 rows
        // (legacy) decrypt directly with the master key; v2 rows
        // unwrap the per-row subkey first then decrypt the payload
        // under that subkey. Mixed-version restores work because the
        // server stores the type alongside each row.
        let ptBytes: Uint8Array;
        // Audit P0-B4 — v3 rows use the same subkey-wrap envelope as
        // v2; only the OUTER columns change. Branch on ciphertext_type:
        //   • 3 (v3) → subkey wrap, outer columns blinded — prefer the
        //              payload's sender/recipient/conversation fields.
        //   • 2 (v2) → subkey wrap, outer columns real.
        //   • 1 (v1) → legacy direct-master wrap.
        // M-3 — the same (owner, message_id) AAD the mirror bound at
        // write time. On a legacy row (written before AAD binding) the
        // decrypt falls back to no-AAD; a NEW row served in the wrong
        // slot fails both and is skipped.
        const aadMsg = backupAad('msg', ownerUserId, row.message_id);
        if (row.ciphertext_type === 2 || row.ciphertext_type === 3) {
          const meta = (row.envelope_meta ?? {}) as {wrappedSubkey?: string};
          if (typeof meta.wrappedSubkey !== 'string') {
            throw new Error(`v${row.ciphertext_type} row missing wrappedSubkey`);
          }
          const subkeyRaw = await aesGcmDecrypt(masterKey, fromB64(meta.wrappedSubkey), aadMsg);
          const subkey = await importSubkey(subkeyRaw);
          subkeyRaw.fill(0);
          ptBytes = await aesGcmDecrypt(subkey, fromB64(row.ciphertext), aadMsg);
        } else {
          // ciphertext_type === 1 (or unset) — legacy direct-master wrap.
          ptBytes = await aesGcmDecrypt(masterKey, fromB64(row.ciphertext));
        }
        const decoded = JSON.parse(new TextDecoder().decode(ptBytes)) as Partial<LocalMessage>;
        // M-3 (belt-and-braces) — the decrypted payload carries its own
        // id; reject a row whose payload id doesn't match the outer
        // message_id (a same-key content swap that legacy no-AAD rows
        // wouldn't otherwise catch).
        if (typeof decoded.id === 'string' && decoded.id.length > 0 && decoded.id !== row.message_id) {
          throw new Error(`payload_id_mismatch:${decoded.id.slice(0, 8)}!=${row.message_id.slice(0, 8)}`);
        }
        // Audit P0-B4 — for v3 rows the outer sender/recipient/
        // conversation columns are blinded to `BACKUP_METADATA_SENTINEL`.
        // Pull the real values from the decrypted payload (it carries
        // them all). For v1/v2 we use the outer columns as before.
        const isV3 = row.ciphertext_type === 3 || row.sender_id === BACKUP_METADATA_SENTINEL;
        const senderId      = isV3 ? (decoded.sender_id ?? '') : row.sender_id;
        const conversationId = isV3 ? (decoded.conversation_id ?? '') : row.conversation_id;
        const recipientId   = isV3
          ? ((decoded as Partial<LocalMessage> & {recipient_id?: string | null}).recipient_id ?? null)
          : row.recipient_id;
        // See `decideRestoredStatus` above for the why. Floors outbound
        // at 'sent' so the restored device can't lie about delivery.
        const restoredStatus = decideRestoredStatus(
          senderId,
          ownerUserId,
          decoded.status as LocalMessage['status'] | undefined,
        );
        // Round 8 — peer fallback fix.
        //   Outbound (owner UUID or the store's 'self' sentinel — P2-B-4)
        //     → recipient is the message's recipient_id.
        //   Inbound → peer is the SENDER.
        // Previous code defaulted to recipient_id for both directions,
        // which on inbound rows pointed peer at SELF (because we ARE
        // the recipient). That broke replies, retracts, and contact
        // lookup on every restored inbound message.
        const isOutbound = isOutboundSenderId(senderId, ownerUserId);
        const fallbackPeerId = isOutbound
          ? (recipientId ?? senderId)
          : senderId;
        const msg: LocalMessage = {
          id:              row.message_id,
          conversation_id: conversationId,
          sender_id:       senderId,
          type:            (decoded.type ?? 'text') as LocalMessage['type'],
          content:         decoded.content ?? '',
          status:          restoredStatus,
          is_encrypted:    decoded.is_encrypted ?? true,
          created_at:      decoded.created_at ?? row.msg_created_at,
          peer:            decoded.peer ?? {userId: fallbackPeerId, deviceId: 1},
          envelope_id:     decoded.envelope_id,
          // SYNC-1 / B-116 — without these a restored group row can only ever
          // match ONE member's read receipt (the scalar id), so the rest are
          // unmatchable forever and the blue tick can never complete. Absent on
          // rows written by a build that predated the mirror change; the
          // recordReadReceipts fallback covers those.
          envelope_ids:    decoded.envelope_ids,
          receipts:        decoded.receipts,
          expires_at:      decoded.expires_at,
          reply_to_msg_id: decoded.reply_to_msg_id,
          reply_to_preview: decoded.reply_to_preview,
          reactions:       decoded.reactions,
          call_meta:       decoded.call_meta,
          media_object_key: decoded.media_object_key,
          // Round 8 — restore the new fields so the chat is fully
          // self-contained after a reinstall: media renders, retract
          // works, mime-typed bubbles route correctly.
          media_mime:      decoded.media_mime,
          media_key:       decoded.media_key,
          media_iv:        decoded.media_iv,
          // Media-parity (2026-07-03) — restore display metadata so a
          // reinstalled chat keeps thumbnails/filenames/dimensions.
          media_meta:      decoded.media_meta,
          retract_token:   decoded.retract_token,
          // B-187 — restore the per-leg tokens so the receipt poll keeps
          // probing every leg after a reinstall (absent on pre-v19 rows;
          // those grandfather to the scalar single probe).
          retract_tokens:  decoded.retract_tokens,
          // B-683 — restore the per-leg failure records so a reinstall
          // neither forgets a terminal destroy (probe skip) nor re-reds a
          // partially-delivered row (absent on pre-v21 backups; rows <7d
          // re-converge via the receipt poll).
          undeliverable_legs: decoded.undeliverable_legs,
          // MM-09 — the "Forwarded" chip survives a reinstall.
          is_forwarded:    decoded.is_forwarded,
        };
        // Round 8 — drop tombstones (markDirty's "remove this row"
        // sentinel from messageMirror). Don't write them into the
        // store; they exist only to instruct the restore path to
        // skip the row, mirroring a "delete for everyone" the user
        // ran on the previous device.
        if ((decoded.status as unknown) === 'deleted') {
          if (row.message_id) {deletedTombstoneIds.push(row.message_id);}
          continue;
        }
        pageBatch.push(msg);
        lastBufferedTs = row.msg_created_at;
        lastBufferedId = row.message_id;
        // P2-B-6 — enforce the defer buffer bound. The row that fills the
        // cap is kept (it's already decoded); subsequent rows are leaf-only.
        if (deferWrites) {
          bufferedRows++;
          if (bufferedRows >= deferBufMax) {bufferCapHit = true;}
        }
        const cvid = msg.conversation_id;
        if (!aggregated[cvid]) {aggregated[cvid] = [];}
        aggregated[cvid].push(msg);
        // M-12 — when rows are durably written to SQLCipher (sqlMessages),
        // bound the in-memory hydrate set per conversation: the UI paints
        // the most-recent tail and older messages load from SQL on scroll
        // / next boot. Trim in bulk (amortized O(1)/row) so a huge-history
        // restore doesn't hold every decoded message in memory at once.
        // The memory-only path keeps everything (nothing else holds it).
        if (sqlMessages && aggregated[cvid].length > HYDRATE_TAIL_PER_CONVO + 512) {
          aggregated[cvid] = aggregated[cvid].slice(-HYDRATE_TAIL_PER_CONVO);
        }
        totalMessages++;
      } catch (e) {
        // Single bad row shouldn't abort the entire restore. The most
        // common cause is an AES-GCM auth-tag mismatch ("DoCipher
        // status: 2"), which means the row was encrypted under a
        // different master key than the one we just unlocked — i.e.
        // backup setup ran twice and the old rows are now orphans.
        // We count these so the caller can show a one-line warning
        // instead of silently restoring 0 messages.
        skippedMessages += 1;
        noteUndecryptable(`restore-decrypt:${(e as Error).message.slice(0, 40)}`);
        console.warn(`[restore] skipped message ${row.message_id}:`, (e as Error).message);
      }
    }
    // Audit fix #31 — page-level transaction via upsertBatch. Each
    // page lands as one atomic write; a crash mid-restore leaves
    // whole pages intact instead of a half-loaded state.
    if (sqlMessages && pageBatch.length > 0) {
      if (deferWrites) {
        // H-6 — hold the page; write only after integrity verification.
        pendingBatches.push({
          batch:  pageBatch,
          tailTs: lastBufferedTs as string,
          tailId: lastBufferedId as string,
        });
      } else {
        try {
          // AUDIT #14 (critic) — duplicate-envelope skips are COUNTED into
          // the completion tally, so "restore succeeded" and "rows silently
          // absent" stay distinguishable (pre-fix server mirrors hold dups).
          skippedMessages += await sqlMessages.upsertBatch(pageBatch);
        } catch (e) {
          console.warn('[restore] page upsertBatch failed:', (e as Error).message);
          throw e;
        }
        // BR-1 — this path has no pending verification (deferWrites is
        // false ⇔ no Merkle requested), so the page is final: paint it
        // now so the user watches chats fill in instead of a blank list.
        hydrateBatchIntoStore(pageBatch);
      }
    }
    // Advance cursor to the LAST row in this page. Tuple comparison
    // means duplicate-timestamp tails don't reset progress.
    const tail = messages[messages.length - 1];
    cursorTs = tail.msg_created_at;
    cursorId = tail.message_id;
    // L-11 / P1-B2 — persist the resume cursor ONLY when the page was
    // durably written this iteration (streaming SQL path). In defer mode
    // nothing is on disk yet, so a persisted cursor would let a crash
    // skip rows that were never written; the defer path restarts from 0.
    if (sqlMessages && !deferWrites) {
      await writeRestoreCursor(ownerUserId, {cursorTs, cursorId});
    }
    // Total is unknown during streaming — emit current only so the
    // UI renders a "Restoring N messages…" line + indeterminate bar.
    emit({step: 'messages', label: `Restored ${totalMessages} messages`, current: totalMessages});
    if (messages.length < 1000) {reachedEnd = true; break;}     // last page

    // BS-RESTORE-YIELD — yield the JS thread to the React Native bridge
    // queue between pages. Without this, the tight decrypt+upsert loop
    // (1 000 rows per page × N pages) holds the JS thread continuously
    // for tens of seconds. Any call offer, ring-stop, or navigation
    // event that arrives during the restore sits in the bridge queue
    // and is never dispatched until the loop finishes. Observed effect:
    // a call that rings mid-restore stays ringing indefinitely because
    // the ring-stop callback (which fires after the answer/decline flow)
    // can't execute. A 0ms timeout costs ~1 frame per page but gives
    // the bridge message queue a full event-loop turn — call signals,
    // BackHandler events, and NativeEventEmitter callbacks all unblock.
    await new Promise<void>(resolve => { setTimeout(resolve, 0); });
  }
  // L-10 — if we exhausted the hard page cap without reaching a natural
  // end, the restored history is TRUNCATED. Don't claim success: keep the
  // resume cursor (streaming path) and leave the restore-incomplete
  // marker set so the caller / next boot continues instead of showing a
  // partial history as if complete.
  if (!reachedEnd) {
    console.warn(`[bravo.restore] page cap hit at ${totalMessages} messages — restore INCOMPLETE, will resume`);
  }

  // Round 5 / Security S8 — verify the Merkle commit BEFORE any deferred
  // durable write. A tampered or rolled-back commit aborts the restore so
  // nothing untrusted lands on disk. The exception bubbles up so
  // BackupRestoreScreen surfaces "Backup integrity check failed" instead
  // of silently degrading. Only meaningful on a complete walk (a truncated
  // set would always mismatch).
  //
  // P2-B-2 — `integrityCleared` records that verification actually RAN to
  // a write-permitting decision this run. The deferred flush below is
  // gated on it: a page-cap-hit walk (reachedEnd=false) used to skip
  // verification entirely yet still flush every buffered page.
  let integrityCleared = !wantsMerkle;
  if (wantsMerkle && opts.identityPubKey && reachedEnd) {
    emit({step: 'merkle', label: 'Verifying backup integrity…'});
    const verdict = await verifyMerkleCommit({
      identityPubKey: opts.identityPubKey,
      userId:         ownerUserId,
      rows:           [],
      leaves:         merkleLeaves,
    });
    if (!verdict.ok) {
      if (verdict.reason === 'no_commit') {
        // Server GENUINELY has no commit row — a legacy account or a
        // server that pre-dates S8. Soft-warn (not abort) so the
        // user isn't locked out of legitimate restores. Log so the
        // audit trail records that this restore wasn't S8-protected.
        // P2-B-1 — an ERRORING endpoint no longer lands here: it maps
        // to 'commit_fetch_failed', which hard-fails below, so a server
        // can't skip S8 wholesale by 500ing the endpoint.
        console.warn('[restore] no merkle commit — proceeding without S8 protection');
      } else if (verdict.reason === 'rows_count_grew' && opts.identityPrivKey) {
        // Round 9 / S8 self-heal, tightened by P2-B-1:
        //   • 'rows_count_grew' (B-45 R3) is now returned ONLY when the
        //     verifier proved the growth is ADDITIVE — the sorted prefix
        //     of the fetched set, at the committed row count, reproduces
        //     the signed root byte-for-byte. That's the honest
        //     post-commit-mirror-lag state (live staging: committed=3 vs
        //     server=14 on an untampered account).
        //   • Equal-count 'root_mismatch' is NO LONGER self-healed: the
        //     served rows verifiably differ from the committed set (e.g.
        //     a per-row substitution resurrecting an old ciphertext into
        //     a tombstone slot). It hard-fails below and surfaces to the
        //     user instead of being re-signed and silently accepted.
        // Re-commit over the fetched rows and re-verify ONCE; an attacker
        // can't abuse this (no priv key), the seq rollback gate still
        // applies, and 'rows_count_mismatch' (omission / rollback /
        // unverifiable growth, H-4) stays a hard fail below.
        console.warn(`[restore] ${verdict.reason} with valid sig + additive prefix — re-committing over fetched rows and retrying`);
        const recommitted = await recommitAndReverify({
          identityPrivKey: opts.identityPrivKey,
          identityPubKey:  opts.identityPubKey,
          userId:          ownerUserId,
          leaves:          merkleLeaves,
        });
        if (!recommitted) {
          throw new MerkleCommitMismatchError(verdict.reason);
        }
        console.warn('[restore] re-commit reconciled the root — restore integrity restored');
      } else {
        // Hard fail (incl. H-4 'rows_count_mismatch' = omission/rollback,
        // P2-B-1 'root_mismatch' substitution + 'commit_fetch_failed'):
        // do NOT write or hydrate. The caller surfaces the error.
        throw new MerkleCommitMismatchError(verdict.reason);
      }
    }
    integrityCleared = true;
  }

  // H-6 — integrity confirmed (or verification not requested): now flush
  // the buffered pages to SQLCipher. A merkle hard-fail above threw before
  // reaching this point, so an omitted/tampered set never touches disk.
  //
  // P2-B-2 — and a walk whose verification never RAN (page-cap hit) must
  // not flush either: drop the unverified buffer, keep the incomplete
  // marker, and let the next run resume + verify.
  if (deferWrites && !integrityCleared) {
    console.warn(`[bravo.restore] verification did not run (cap-hit walk) — dropping ${pendingBatches.length} unverified buffered pages`);
    pendingBatches.length = 0;
    stagedGroupStates.length = 0;
    stagedConversations.length = 0;
    for (const k of Object.keys(aggregated)) {delete aggregated[k];}
  }

  // BUG-D — apply the staged conversation rows, only now that integrity
  // is cleared, and NEVER over a row the live store already holds: live
  // state (fresher membership from a drained rekey, current mute/pin/
  // unread on the unlock path) always wins over backup state. Applied
  // before the flush loop so batch-hydrated messages have parent rows.
  if (integrityCleared) {
    const liveConvos = useMessengerStore.getState().conversations;
    for (const sc of stagedConversations) {
      if (liveConvos[sc.id]) {continue;}
      /**
       * B-594 — THE RE-MINT. The guard above exists to avoid stomping FRESHER
       * live state, so a conversation the user deliberately DELETED is exactly
       * the case it waves through: not live, therefore "safe to restore". The
       * row came back at the top of the list (upsertConversation unshifts),
       * and the Home screen's server prune removed it again once `listMine`
       * landed — the founder's "appears for a fraction of a second".
       *
       * Suppression is at the UPSERT only. The row stays in the verified set
       * and in the Merkle leaves; nothing about what is HASHED changes here
       * (BACKUP_LOOP I3/I7).
       */
      if (isConversationTombstoned(sc.id)) {
        console.log(`[restore] conversation ${sc.id.slice(0, 8)} stays deleted (user tombstone)`);
        continue;
      }
      try {
        store.upsertConversation(sc);
      } catch (e) {
        console.warn(`[restore] conversation apply failed for ${sc.id.slice(0, 8)}:`, (e as Error).message);
      }
    }
  }
  // BUG-B (audit 2026-07-23) — ids of rows this run durably wrote from
  // the VERIFIED set. The B-94 ledger seed below is restricted to these:
  // the old screen-level seed ran loadAll() after the archive drain and
  // marked archive-replayed + live-received rows as "flushed" too — rows
  // the server mirror never got. The boot sweep then skipped them
  // forever and the next restore permanently lacked them (the archive
  // expires ≤30 days).
  const flushedIds: string[] = [];
  if (deferWrites && sqlMessages && pendingBatches.length > 0) {
    emit({step: 'hydrate', label: 'Saving restored messages…'});
    let flushedRows = 0;
    for (const pb of pendingBatches) {
      try {
        // AUDIT #14 — same skip-count fold as the non-deferred path.
        skippedMessages += await sqlMessages.upsertBatch(pb.batch);
      } catch (e) {
        console.warn('[restore] deferred upsertBatch failed:', (e as Error).message);
        throw e;
      }
      // P2-B-6 — every flushed row belonged to the verified set; persist
      // the cursor so an OOM/kill (now or on a later cap-hit run) resumes
      // decoding past it instead of re-walking from row 0.
      await writeRestoreCursor(ownerUserId, {cursorTs: pb.tailTs, cursorId: pb.tailId});
      // BR-1 — batch-by-batch paint. Every row in this batch is durable
      // AND belongs to the verified set (integrityCleared gated the loop),
      // so painting it now leaks nothing unverified — the user just sees
      // it minutes earlier. The final full hydrate below still runs (it
      // merges idempotently) so the end state is byte-identical to the
      // one-shot behaviour.
      hydrateBatchIntoStore(pb.batch);
      for (const m of pb.batch) {flushedIds.push(m.id);}
      flushedRows += pb.batch.length;
      emit({step: 'hydrate', label: 'Loading your chats…', current: flushedRows});
      // BR-1 — yield per batch (B-155 lesson): the flush loop must not
      // starve the JS thread now that the user is live on MessengerHome.
      await new Promise<void>(resolve => { setTimeout(resolve, 0); });
    }
  }

  // BUG-B / B-94 / I7 — seed the persistent flush ledger with EXACTLY
  // the rows this run verified + durably wrote. The versions are hashed
  // from the SQL round-trip (loadAll), not the in-memory objects, so
  // they byte-match what the boot catch-up sweep will compute — a
  // divergent hash here would re-open the I1 full-history re-upload.
  // Restricted to `flushedIds`, so archive-replayed and live-received
  // rows (which the server mirror does NOT hold) are never marked
  // flushed. Non-fatal: a failed seed degrades to one extra re-upload.
  if (integrityCleared && sqlMessages && flushedIds.length > 0) {
    try {
      const {recordFlushedVersions} = require('./mirrorLedger') as typeof import('./mirrorLedger');
      const {computeMirrorVersion} = require('./messageMirror') as typeof import('./messageMirror');
      const idSet = new Set(flushedIds);
      const all = await sqlMessages.loadAll();
      const entries = Object.values(all).flat()
        .filter(m => idSet.has(m.id))
        .map(m => ({messageId: m.id, version: computeMirrorVersion(m)}));
      if (entries.length > 0) {
        await recordFlushedVersions(ownerUserId, entries);
        console.log(`[bravo.restore] B-94 mirror ledger seeded (${entries.length} verified rows)`);
      }
    } catch (e) {
      console.warn('[bravo.restore] B-94 ledger seed failed (non-fatal):', (e as Error).message);
    }
  }

  // P2-B-5 — apply the staged group states, only now that integrity is
  // cleared, and never let an OLDER backup epoch stomp a newer epoch the
  // live runtime already holds (e.g. a rekey drained from the relay
  // pending queue seconds before this restore ran).
  if (integrityCleared) {
    for (const st of stagedGroupStates) {
      const local = useMessengerStore.getState().groups[st.groupId];
      if (local && st.epoch <= local.epoch) {
        console.log(`[restore] group_state ${st.groupId.slice(0, 8)} epoch=${st.epoch} <= local=${local.epoch} — keeping live state`);
        // BUG-D — the restored conversation row (if we inserted one above)
        // carries the BACKUP's member list, but the live group state we
        // just kept is newer. Re-commit the live state so its L9 sync
        // repoints conversation.participants at the live membership —
        // otherwise send fan-out keeps targeting a removed member (and
        // misses an added one) until the next admin action.
        try {
          store.setGroupState(local);
        } catch (e) {
          console.warn(`[restore] participants resync failed for ${st.groupId.slice(0, 8)}:`, (e as Error).message);
        }
        continue;
      }
      try {
        store.setGroupState(st);
      } catch (e) {
        console.warn(`[restore] group state apply failed for ${st.groupId.slice(0, 8)}:`, (e as Error).message);
      }
    }
  }

  // Cursor + incomplete-marker lifecycle: clear ONLY on a fully-complete,
  // integrity-verified restore. A truncated (page-cap or P2-B-6
  // buffer-cap) run leaves both set so it resumes.
  const incomplete = !reachedEnd || deferRowsSkipped > 0;
  if (!incomplete) {
    await clearRestoreCursor(ownerUserId);
    await clearRestoreIncomplete(ownerUserId);
  } else if (deferRowsSkipped > 0) {
    console.warn(`[bravo.restore] defer buffer cap (${deferBufMax}) hit — ${deferRowsSkipped} rows left for the next run; flushed verified window, restore INCOMPLETE, will resume`);
  }

  // Audit fix #31 — single hydrateMessages call so the UI paints
  // once after all pages are durable instead of flickering through
  // partial state for each batch. When sqlMessages is wired the
  // store is already up-to-date (the next runtime boot pulls from
  // SQLCipher); we still hydrate so the active session sees them.
  //
  // Restore-after-reinstall fix: bypass the MAX_HYDRATE_PER_CONVO cap
  // here. The cap is a cold-boot UI protection; during restore the
  // user is sitting on a progress screen explicitly waiting on this,
  // and silently slicing to the last 200 per conversation made the
  // user think their backup was incomplete.
  emit({step: 'hydrate', label: 'Painting your chats…'});
  // M-13 — suppress the runtime's store→SQLCipher write-through for this
  // hydrate. Every restored row was already durably written above via
  // upsertBatch, so letting the subscriber re-`upsert` each one would be
  // a redundant per-row autocommit storm. Zustand fires subscribers
  // synchronously inside set(), so the flag is observed during hydrate.
  setRestoreWriteThroughSuppressed(true);
  try {
    useMessengerStore.getState().hydrateMessages(aggregated, true);
  } finally {
    setRestoreWriteThroughSuppressed(false);
  }
  // Round 8 — open the ExpirySweeper grace window. Restored
  // disappearing-messages whose absolute `expires_at` already passed
  // would otherwise be wiped within the next sweep tick. The grace
  // gives the user time to scroll through their restored chat before
  // the timer-driven purge resumes.
  markRestoredNow();
  // M-08 — persist the tombstone ids so the sealed-archive replay that runs
  // next can't resurrect messages the user deleted before reinstalling.
  if (deletedTombstoneIds.length > 0) {
    try {
      const {addRestoreTombstones} = require('./restoreTombstones') as typeof import('./restoreTombstones');
      await addRestoreTombstones(ownerUserId, deletedTombstoneIds);
    } catch (e) {
      console.warn('[restore] persisting tombstone ids failed:', (e as Error).message);
    }
  }
  const convCount = Object.keys(aggregated).length;
  console.log(
    `[bravo.restore] done — conversations=${conversations.length} messages=${totalMessages} skipped=${skippedMessages} alreadyWritten=${alreadyWritten} hydrated_convos=${convCount} incomplete=${incomplete}`,
  );

  return {conversations: conversations.length, messages: totalMessages, skipped: skippedMessages, incomplete};
}
