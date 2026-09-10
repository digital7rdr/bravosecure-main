/**
 * messageMirror — write-through replication of LocalMessage rows to
 * the encrypted backup. Decoupled from the runtime via an in-memory
 * queue + debounced flush so the hot send/receive paths never block
 * on a network call.
 *
 * Wire format (per row):
 *   ciphertext = AES-256-GCM(JSON.stringify({
 *     content, type, status, created_at, peer, reply_to_msg_id,
 *     reply_to_preview, reactions, call_meta, expires_at,
 *     media_object_key, media_mime, media_key, media_iv, retract_token,
 *   }), per-row subkey)
 *   wrappedSubkey = AES-256-GCM(subkey, master_key)
 *
 * The Supabase row stores the WRAPPED blob — the server cannot read
 * a single field. On restore we pull the row and reverse the wrap
 * with the same master_key recovered from the identity backup.
 *
 * Round 8 lifecycle changes (vs the R5 / R7 implementation):
 *   • markDirty no longer just clears the dedup — it RE-ENQUEUES the
 *     message for re-mirror, so status flips, reaction updates,
 *     retract-token assignment, and removals actually reach the
 *     server. Previously these were silent no-ops.
 *   • Owner gating: setMirrorOwner(userId) keys queue + dedup so a
 *     logout → re-login swap can never ship the previous user's
 *     in-flight queue under the new user.
 *   • disposeMirror() clears every module global. signOut wires this
 *     so cross-user contamination is impossible.
 *   • An AppState 'background' / 'inactive' hook forces a flush so
 *     the 1.5s debounce window can't leak when the OS suspends JS.
 *   • setMirrorKey now triggers a CATCH-UP SWEEP that walks the
 *     full SQLCipher store and re-mirrors any rows that were dropped
 *     while the mirror was disabled (boot window, dismissed unlock).
 *   • Media key + IV are serialized so restored attachments are
 *     decryptable. The retract token is also serialized so a
 *     restored device can still "delete for everyone" within dwell.
 */
import {AppState, type AppStateStatus} from 'react-native';
import {backupClient, BackupError} from './backupClient';
import {bumpFlushEpoch, recordFlushedVersions, setMerkleCommitPending} from './mirrorLedger';
import {leavesFromWireRows, upsertLeaves, setLeafCacheDirty, clearLeafCacheDirty, readLeafCacheDirty} from './merkleLeafCache';
import {aesGcmEncrypt, generateSubkey, toB64, backupAad} from './backupCrypto';
import {
  encryptGroupStateBlob,
  serializeMessageForBackup,
} from './backupWireV3';
import type {LocalMessage} from '../store/types';
import type {LocalConversation} from '../store/types';
import type {GroupState} from '@bravo/messenger-core';

// Round 5 / Security S8 — pluggable hook for the runtime to inject a
// "commit a Merkle root after a successful flush" callback. The
// mirror itself doesn't have access to the user's identity priv key
// or userId — those live in the runtime context. We expose the slot
// here and the runtime sets it once at boot.
type MerkleHook = () => Promise<void>;
let merkleAfterFlushHook: MerkleHook | null = null;
let merkleHookDebounce: ReturnType<typeof setTimeout> | null = null;
// B-45 R3 — was 30 s. Every second of lag between "rows uploaded" and
// "count signed" was a window where a kill/suspend left the server ahead
// of the last commit → the next restore hard-failed rows_count_mismatch.
// One curve25519 sign + one small POST per flush burst is cheap.
const MERKLE_DEBOUNCE_MS = 5_000;
export function setMerkleAfterFlushHook(hook: MerkleHook | null): void {
  merkleAfterFlushHook = hook;
}
function scheduleMerkleHook(): void {
  if (!merkleAfterFlushHook) {return;}
  if (merkleHookDebounce) {return;}
  merkleHookDebounce = setTimeout(() => {
    merkleHookDebounce = null;
    if (!merkleAfterFlushHook) {return;}
    void merkleAfterFlushHook().catch(e =>
      console.warn('[bravo.backup.mirror] merkle hook failed:', (e as Error).message),
    );
  }, MERKLE_DEBOUNCE_MS);
}

/**
 * B-45 R3 — run the pending Merkle commit NOW instead of waiting out the
 * debounce. Used by the AppState background handler (RN timers don't fire
 * while suspended, so an un-fast-forwarded timer dies with the process and
 * the server stays ahead of the signed count) and by fresh-setup callers
 * that need the baseline commit to cover what they just flushed.
 */
export async function fireMerkleHookNow(): Promise<void> {
  if (merkleHookDebounce) {clearTimeout(merkleHookDebounce); merkleHookDebounce = null;}
  if (!merkleAfterFlushHook) {return;}
  try {
    await merkleAfterFlushHook();
  } catch (e) {
    console.warn('[bravo.backup.mirror] merkle hook failed:', (e as Error).message);
  }
}

/**
 * B-81 — fast-forward the debounced Merkle commit ONLY when a flush actually
 * scheduled one. Used by the boot catch-up sweep: an idle boot (nothing
 * re-mirrored) must NOT mint a fresh commit — the walk-and-sign should only
 * follow real uploads. Shrinks the "rows uploaded but commit still pending"
 * kill-window from (5s debounce + walk) to just the walk.
 */
export async function fireMerkleHookNowIfPending(): Promise<void> {
  if (!merkleHookDebounce) {return;}
  await fireMerkleHookNow();
}

let masterKey: CryptoKey | null = null;
let enabled = false;
let warnedNoKey = false;
/**
 * Round 8 — owner gate. signOut + setOwner BOTH set this so the
 * queue can never ship the previous user's pending mirror writes
 * under the new owner_user_id.
 */
let mirrorOwnerUserId: string | null = null;

const FLUSH_DEBOUNCE_MS = 1500;
const MAX_BATCH = 50;
const MAX_QUEUE_SIZE = 500;

interface Pending {
  ownerUserId: string;
  msg: LocalMessage;
  /**
   * B-94 — the version hash this enqueue represents ('__deleted__' for
   * tombstones). Carried so a successful flush can persist it to the
   * mirror_flushed ledger without re-serializing the message.
   */
  version: string;
}

const queue: Pending[] = [];
/**
 * B-632 — dedup keyed `${ownerUserId}:${messageId}` → the version last
 * enqueued for that row ('__deleted__' for a tombstone). Deliberately the
 * SAME shape as the durable ledger's own PRIMARY KEY (owner_user_id,
 * message_id) in `mirror_flushed`, so "what did we last ship for this row?"
 * is one lookup rather than a scan.
 *
 * Why it changed: as a Set of `${owner}:${id}:${version}` composites, every
 * per-message operation (markDirty, mirrorRemoval, clearDedupForItems) had to
 * WALK the whole set to find that one row's entries — and the set is seeded at
 * boot from the full ledger, i.e. one entry per message in the user's entire
 * history. Measured on the JS thread: a chat-open marking 200 rows read cost
 * 214 ms at 5k history and 1.7 s at 40k (V8; Hermes is several times worse),
 * which is the "tap registers late" class in CLAUDE.md's lag section.
 *
 * Behaviour is unchanged for every path that matters: each add was already
 * preceded by a strip of that row's other versions, so the Set was a map in
 * disguise. The ONE difference is a revert (version A → B → A): the Set had
 * seen A before and skipped it, leaving the server permanently on B; the map
 * holds only the LAST version, so the revert re-ships and the server converges
 * on local truth. That is the direction I1/I8 already ask for.
 */
const seenIds = new Map<string, string>();
const versionKey = (ownerUserId: string, messageId: string): string =>
  `${ownerUserId}:${messageId}`;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * B-648 — conversation versions live in the SAME `mirror_flushed` table as
 * messages, namespaced by this id prefix (message ids are UUID-shaped and
 * can never collide with it). Sharing the table means `clearFlushedForOwner`
 * purges conv entries for free on every wipe/rotation path (I5), and the
 * B-81 repair's full re-upload covers conversations without new plumbing.
 */
const CONV_LEDGER_PREFIX = 'conv:';
/**
 * B-648 — dedup keyed `${ownerUserId}:${conversationId}` → the version hash
 * last enqueued for that row. Ledger-seeded at boot (seedMirrorDedup), so an
 * idle boot's catch-up sweep enqueues NO conversation whose snapshot already
 * reached the server — the conv-side I1. Before this map existed, every
 * launch re-encrypted + re-uploaded the entire conversation set
 * (`[backup.drain] rows=<conv count>` on every idle cold start), a boot-lag
 * cost linear in how many chats the account has.
 */
const convSeen = new Map<string, string>();
const convQueue = new Map<string, {ownerUserId: string; conv: LocalConversation; groupState?: GroupState; deleted: boolean; version: string}>();
let convFlushTimer: ReturnType<typeof setTimeout> | null = null;

// BUG-2/BUG-6 (audit 2026-07-23) — session generation. Bumped on
// dispose, wipe, and every key change. An in-flight flush captures it
// at entry; when it comes back stale it must neither requeue its items
// (they belong to a previous owner/key — the cross-user contamination
// lane) nor record ledger state (the ledger was just purged/rotated —
// recording an old-key row's version poisons the fresh ledger into
// skipping a row the server can no longer decrypt).
let mirrorSessionGen = 0;
// BUG-2/BUG-8 — retry + overflow-sweep timers are tracked so dispose
// can cancel them; previously they were fire-and-forget setTimeouts
// that survived signOut and re-armed the cleared queue's flush loop.
const pendingRetryTimers = new Set<ReturnType<typeof setTimeout>>();
function trackTimer(cb: () => void, delayMs: number): void {
  const t = setTimeout(() => { pendingRetryTimers.delete(t); cb(); }, delayMs);
  pendingRetryTimers.add(t);
}
function cancelTrackedTimers(): void {
  for (const t of pendingRetryTimers) {clearTimeout(t);}
  pendingRetryTimers.clear();
}

/**
 * Round 8 — catch-up sweep callback. Wired by the runtime so when
 * setMirrorKey flips us from disabled → enabled, we re-walk the
 * full local store and re-mirror anything that was silently dropped
 * during the boot window (or any session that ran with the mirror
 * locked).
 */
let catchUpSweep: (() => Promise<void>) | null = null;
export function setCatchUpSweep(fn: (() => Promise<void>) | null): void {
  catchUpSweep = fn;
}

/**
 * Round 8 — AppState 'background'/'inactive' handler. Without this,
 * a debounced 1.5s queue would lose every queued message when the
 * OS suspended JS. The handler subscription is installed once (idempotent
 * via `appStateSub`) and removed by disposeMirror.
 */
let appStateSub: {remove: () => void} | null = null;
function installAppStateHook(): void {
  if (appStateSub) {return;}
  const onChange = (state: AppStateStatus): void => {
    if (state === 'background' || state === 'inactive') {
      // Force-flush both queues. Cancel the pending debounce timers
      // first so the immediate flush isn't double-invoked.
      if (flushTimer) {clearTimeout(flushTimer); flushTimer = null;}
      if (convFlushTimer) {clearTimeout(convFlushTimer); convFlushTimer = null;}
      void (async () => {
        try { await flush(); } catch { /* logged inside flush */ }
        try { await flushConversations(); } catch { /* logged inside */ }
        // B-45 R3 — ship the pending Merkle commit too. Force-flushing
        // ROWS while abandoning the commit timer guaranteed the server
        // ended up ahead of the signed count (RN timers don't fire in
        // the background) → rows_count_mismatch on the next restore.
        // Only when a commit is actually owed (timer pending) — a plain
        // backgrounding with nothing mirrored must not hit the network.
        if (merkleHookDebounce) {
          await fireMerkleHookNow();
        }
      })();
    }
  };
  appStateSub = AppState.addEventListener('change', onChange);
}

/**
 * Wire the master key. Called by:
 *   • setupBackup() success path → first wrap of newly-generated key
 *   • restoreBackup() success path → key recovered from backup
 *   • app-resume bootstrap if both backup is enabled AND the user has
 *     re-entered their backup password to unlock for the session.
 *
 * Without a master key, mirror calls are no-ops (logged once).
 *
 * Round 8 — flipping enabled false → true triggers a catch-up sweep
 * so messages dropped while the mirror was locked still reach the
 * server. The sweep callback is installed by the runtime via
 * setCatchUpSweep; if it isn't wired, the flip is purely cosmetic.
 */
export function setMirrorKey(key: CryptoKey | null): void {
  const wasEnabled = enabled;
  // BUG-6 — a key CHANGE invalidates any in-flight flush: its rows were
  // wrapped under the previous key and (on the rotation path) the server
  // mirror + ledger were just wiped, so a late-landing batch must not
  // record itself as flushed.
  if (masterKey !== key) {mirrorSessionGen++;}
  masterKey = key;
  enabled = !!key;
  warnedNoKey = false;
  installAppStateHook();
  console.log(`[bravo.backup.mirror] setMirrorKey enabled=${enabled}`);
  if (!wasEnabled && enabled && catchUpSweep) {
    // Round 8 — gap recovery. Boot-window messages, dismissed-unlock
    // sessions, and FCM-headless-wake deliveries all silently dropped
    // before the key arrived. Re-walking the local store catches them.
    void catchUpSweep().catch(e =>
      console.warn('[bravo.backup.mirror] catch-up sweep failed:', (e as Error).message),
    );
  }
}

/**
 * Round 8 — owner gate. Pin the userId allowed to flow through the
 * mirror queue. Mismatches between mirrorMessage's ownerUserId and
 * this owner are silently dropped (the user just signed out and a
 * stale callback fired with the previous user's id).
 */
export function setMirrorOwner(userId: string | null): void {
  mirrorOwnerUserId = userId;
}

export function isMirrorEnabled(): boolean { return enabled; }

/**
 * Round 8 — total dispose. Wired into authStore.signOut so cross-
 * user contamination is impossible. Clears: queue, dedup, master
 * key handle, owner gate, conv queue, all timers, AppState hook.
 * Does NOT clear the merkle hook — that's owned by mirrorBootstrap
 * and cleared in stopMirrorBootstrap.
 */
export function disposeMirror(): void {
  // BUG-2 — invalidate in-flight flushes FIRST so their catch paths
  // can't requeue the previous user's rows into the cleared queue, and
  // cancel the untracked retry timers that used to survive signOut.
  mirrorSessionGen++;
  cancelTrackedTimers();
  masterKey = null;
  enabled = false;
  warnedNoKey = false;
  mirrorOwnerUserId = null;
  queue.length = 0;
  convQueue.clear();
  seenIds.clear();
  convSeen.clear();
  if (flushTimer) {clearTimeout(flushTimer); flushTimer = null;}
  if (convFlushTimer) {clearTimeout(convFlushTimer); convFlushTimer = null;}
  if (merkleHookDebounce) {clearTimeout(merkleHookDebounce); merkleHookDebounce = null;}
  if (appStateSub) {appStateSub.remove(); appStateSub = null;}
  catchUpSweep = null;
}

/**
 * BUG-6 (audit 2026-07-23) — forget/wipe + fresh-setup hygiene. The
 * server mirror is gone (or about to be rotated), so: drop both queues,
 * clear the dedup, null the key, and invalidate in-flight flushes — a
 * late old-key batch landing after the rotation must not be recorded
 * into the fresh ledger (its rows are permanently undecryptable under
 * the new master key). Unlike disposeMirror this KEEPS the store
 * subscription, owner gate, and AppState hook: a follow-up
 * setupBackup → setMirrorKey resumes mirroring without a reboot.
 */
export function resetMirrorForWipe(): void {
  mirrorSessionGen++;
  cancelTrackedTimers();
  masterKey = null;
  enabled = false;
  warnedNoKey = false;
  queue.length = 0;
  convQueue.clear();
  seenIds.clear();
  convSeen.clear();
  if (flushTimer) {clearTimeout(flushTimer); flushTimer = null;}
  if (convFlushTimer) {clearTimeout(convFlushTimer); convFlushTimer = null;}
  if (merkleHookDebounce) {clearTimeout(merkleHookDebounce); merkleHookDebounce = null;}
}

/**
 * Enqueue a message for mirroring. Cheap — wraps + flushes happen on
 * the debounced timer.
 *
 * Audit fix #30 — dedup gate keyed on `(owner, msgId, version)` where
 * version is a hash of the serialized message. Re-shipping the same
 * wire bytes is a no-op; ANY semantic change goes through.
 */
export function mirrorMessage(ownerUserId: string, msg: LocalMessage): void {
  if (!enabled) {
    if (!warnedNoKey) {
      console.log('[mirror] disabled — backup not unlocked this session');
      warnedNoKey = true;
    }
    return;
  }
  if (!ownerUserId || !msg.id) {return;}
  // Round 8 — owner gate. Reject mismatched owners so a stale
  // callback fired with the previous user's id can't ship under the
  // new user.
  if (mirrorOwnerUserId && mirrorOwnerUserId !== ownerUserId) {
    console.warn(`[mirror] owner mismatch: got ${ownerUserId} expected ${mirrorOwnerUserId} — dropped`);
    return;
  }
  const version = versionHash(msg);
  const key = versionKey(ownerUserId, msg.id);
  if (seenIds.get(key) === version) {return;}
  seenIds.set(key, version);
  queue.push({ownerUserId, msg, version});
  scheduleFlush();
}

/**
 * B-94 — seed the in-memory dedup from the persistent mirror_flushed
 * ledger, so the boot catch-up sweep skips every row whose CURRENT
 * version already reached the server in a previous session. Without
 * this, every boot re-encrypted + re-uploaded the entire history (the
 * drift factory behind the recurring `root_mismatch` dead-end).
 */
export function seedMirrorDedup(ownerUserId: string, versions: ReadonlyMap<string, string>): void {
  if (!ownerUserId) {return;}
  for (const [id, version] of versions) {
    // B-648 — conversation versions share the ledger under the `conv:`
    // namespace; route them to the conv dedup, everything else is a
    // message id.
    if (id.startsWith(CONV_LEDGER_PREFIX)) {
      convSeen.set(`${ownerUserId}:${id.slice(CONV_LEDGER_PREFIX.length)}`, version);
    } else {
      seenIds.set(versionKey(ownerUserId, id), version);
    }
  }
}

/**
 * B-94 — the exact version hash the mirror dedup uses for a message.
 * Exposed so the restore path can seed the ledger with the versions the
 * server verifiably holds (the rows it just decrypted), keeping the
 * first post-restore boot sweep a no-op.
 */
export function computeMirrorVersion(msg: LocalMessage): string {
  return versionHash(msg);
}

/**
 * Round 8 — markDirty now RE-ENQUEUES the message via the live store
 * snapshot. Previously it only invalidated the dedup, which was
 * useless: nothing called mirrorMessage afterwards, so status flips,
 * reaction updates, retract-token assignment, and removals never
 * reached the server. Restored chats showed every outbound message
 * stuck at 'sending', no reactions, no retract capability.
 *
 * The new behaviour: drop every cached version for this messageId
 * AND read the current LocalMessage from the store and push it onto
 * the queue. Lazy require breaks the store ↔ backup circular dep.
 */
/**
 * B-81 — rows still waiting in the outbox (messages + conversations). The
 * repair flow checks this AFTER drainMirrorOutbox: a non-empty outbox means
 * the drain bailed (flaky network) and signing now would commit a root over
 * a half-overwritten server set.
 */
export function mirrorOutboxSize(): number {
  return queue.length + convQueue.size;
}

/**
 * B-81 — drop EVERY dedup key for an owner so a follow-up `backupNow` walk
 * re-enqueues the owner's full local history (fresh AES-GCM wrap + upsert per
 * row). Used by the backup-repair flow: when the server's row bytes have
 * drifted from the last signed commit (equal-count `root_mismatch`), the
 * honest reconciliation is to overwrite the server rows with LOCAL truth and
 * re-sign — never to re-sign the server's bytes as-is.
 */
export function clearMirrorDedupForOwner(ownerUserId: string): void {
  // Still a scan — but this is the repair path (once, deliberately), not the
  // per-message one, so the O(n) walk is the right trade here.
  const prefix = `${ownerUserId}:`;
  for (const k of seenIds.keys()) {
    if (k.startsWith(prefix)) {seenIds.delete(k);}
  }
  // B-648 — the repair's full re-upload covers conversations too; a stale
  // conv dedup entry would short-circuit exactly the overwrite it needs.
  for (const k of convSeen.keys()) {
    if (k.startsWith(prefix)) {convSeen.delete(k);}
  }
}

/**
 * @param conversationId B-632 — the conversation the row lives in, when the
 * caller knows it (every store action does: it is the action's own argument).
 * Without it this function had to scan EVERY hydrated conversation's message
 * array to find one id — up to MAX_HYDRATE_PER_CONVO rows per conversation,
 * per call, on the JS thread. Optional on purpose: callers that genuinely
 * don't know it keep the old full scan rather than losing the re-enqueue.
 */
export function markDirty(ownerUserId: string, messageId: string, conversationId?: string): void {
  const _t0 = lagNow();
  try {
  // B-632 — one key per (owner, message), so dropping this row's dedup entry
  // is a single delete. This also covers the legacy un-versioned key from
  // pre-B-94 sessions, which is now the very same key.
  const key = versionKey(ownerUserId, messageId);

  // Mirror off, or this row belongs to another owner: invalidate so a later
  // enable re-ships it, and stop. (Unchanged from before — only the ORDER of
  // the delete moved, so the B-634 guard below can decline to invalidate.)
  if (!enabled || (mirrorOwnerUserId && mirrorOwnerUserId !== ownerUserId)) {
    seenIds.delete(key);
    return;
  }

  // Round 8 — fetch the live message and re-enqueue it.
  try {
    const {useMessengerStore} = require('../store/messengerStore') as
      typeof import('../store/messengerStore');
    const state = useMessengerStore.getState();
    let found: LocalMessage | undefined;
    // B-632 — named conversation first; fall back to the full scan only when
    // the caller had no id (or the row is not where it said), so a mis-hint
    // can never silently drop the re-enqueue.
    if (conversationId) {
      found = state.messages[conversationId]?.find(m => m.id === messageId);
    }
    if (!found) {
      for (const list of Object.values(state.messages)) {
        const hit = list.find(m => m.id === messageId);
        if (hit) {found = hit; break;}
      }
    }
    // B-634 — the post-commit mirror subscriber runs synchronously inside the
    // same `set()` and has usually queued this EXACT committed row already.
    // Forcing a second enqueue would re-encrypt identical plaintext under a
    // fresh AES-GCM IV, changing server bytes for no reason — the churn I1
    // exists to prevent. Reference identity is the precise test: the subscriber
    // and this call read the same committed snapshot, and immer replaces rather
    // than mutates, so a row that changed again is a DIFFERENT object.
    //
    // It has to stay a queue scan rather than a version compare, because
    // `versionHash` is blind to `receipts`/`envelope_ids` — those ride the
    // backup wire (backupWireV3) but are NOT in the hash, so a receipt-only
    // change legitimately has an unchanged version and still must force its way
    // through. Bounded by MAX_QUEUE_SIZE (500 reference compares), i.e. noise
    // next to the whole-history string scan B-632 removed.
    if (found && queue.some(p => p.ownerUserId === ownerUserId && p.msg === found)) {return;}

    seenIds.delete(key);
    if (found) {
      // Use mirrorMessage so the version-hash dedup gate still holds
      // (idempotent across many markDirty calls between flushes).
      mirrorMessage(ownerUserId, found);
    }
    // BUG-3 (audit 2026-07-23) — not-found is NOT evidence of removal.
    // The in-memory store holds only the ~200 most-recent rows per
    // conversation; SQL-sourced status flips (late outbox drains,
    // receipts on old messages) routinely nudge evicted-but-live rows.
    // The old fallback shipped a real `__deleted__` tombstone for them,
    // overwriting the live backup row — any restore in the window
    // dropped the message. Genuine removals go through the authoritative
    // H-3 path (store.removeMessage → mirrorRemoval) with real row data;
    // here we only cleared the dedup above, so the next boot sweep
    // re-mirrors the row from SQL truth.
  } catch {
    // Store not loaded yet. The dedup delete lives inside the try now (B-634
    // moved it below the guard), so do it here too — I8 is explicit that a
    // failure degrades to RE-UPLOAD, never to skipping an upload we cannot
    // prove happened. Without this the mutation could be dropped for good.
    seenIds.delete(key);
  }
  } finally {
    // LAGDIAG (2026-07-27) — the named "next lead" in CLAUDE.md's lag
    // section: this function runs on EVERY message mutation (receipt,
    // status flip, reaction). It WAS structurally O(whole history + every
    // hydrated conversation list); B-632 made the dedup drop O(1) and gave
    // the store lookup a conversation hint, so what remains is one list
    // probe. The probe stays: it is how we prove that on device, and it is
    // aggregated to ≤1 warn/second so it cannot become the stall it measures.
    lagAccumMarkDirty(lagNow() - _t0);
  }
}

// ─── [LAGDIAG] probes — metadata only, release-visible (console.warn) ──────
// Why: the founder's "messenger is laggy / low-end device hangs" report and
// CLAUDE.md's measured-dead-ends doctrine: eight candidates are eliminated,
// the per-send backup work is the named untested lead. These probes turn the
// next device session into a read instead of an inference. performance.now
// where available (B-303: wall clocks step under NTP).
const lagNow = (): number =>
  (globalThis as {performance?: {now?: () => number}}).performance?.now?.() ?? Date.now();
let lagMdCount = 0;
let lagMdTotal = 0;
let lagMdWindowStart = 0;
function lagAccumMarkDirty(elapsedMs: number): void {
  lagMdCount += 1;
  lagMdTotal += elapsedMs;
  const now = lagNow();
  if (lagMdWindowStart === 0) {lagMdWindowStart = now;}
  if (now - lagMdWindowStart >= 1000) {
    if (lagMdTotal >= 8) {
      console.warn(`[LAGDIAG] [backup.markDirty] n=${lagMdCount} totalMs=${Math.round(lagMdTotal)} seenIds=${seenIds.size} queue=${queue.length}`);
    }
    lagMdCount = 0; lagMdTotal = 0; lagMdWindowStart = now;
  }
}

/**
 * H-3 — enqueue a removal tombstone (status='deleted') so a restore
 * doesn't resurrect a message the user deleted (incl. "delete for
 * everyone"). Called from store.removeMessage AFTER the commit with the
 * real conversation_id + created_at. Deduped per (owner,id) so repeated
 * removals don't flood the queue, and any queued LIVE version of the
 * same id is stripped first so the tombstone isn't shadowed.
 */
export function mirrorRemoval(
  ownerUserId: string,
  msg: {id: string; conversation_id: string; created_at: string},
): void {
  if (!enabled) {
    if (!warnedNoKey) {
      console.log('[mirror] disabled — backup not unlocked this session');
      warnedNoKey = true;
    }
    return;
  }
  if (!ownerUserId || !msg.id) {return;}
  if (mirrorOwnerUserId && mirrorOwnerUserId !== ownerUserId) {return;}
  // B-94 — '__deleted__' doubles as the ledger version for tombstones,
  // so a boot sweep after the flush doesn't re-enqueue the removal.
  //
  // BUG-5 (audit 2026-07-23) — the "already tombstoned" guard must be read
  // BEFORE this row's live version is dropped, or every repeated removal
  // pushes another tombstone Pending. B-632 makes that structural rather than
  // a matter of statement order: one key per (owner, message), so the read
  // below cannot be clobbered by the write that follows it, and the write
  // itself REPLACES any deduped live version (a same-tick live enqueue can no
  // longer shadow the tombstone).
  const key = versionKey(ownerUserId, msg.id);
  if (seenIds.get(key) === '__deleted__') {return;}   // already tombstoned this session
  seenIds.set(key, '__deleted__');
  const tombstone: LocalMessage = {
    id:              msg.id,
    conversation_id: msg.conversation_id || '',
    sender_id:       '',
    type:            'text',
    content:         '',
    status:          'deleted' as LocalMessage['status'],
    is_encrypted:    false,
    created_at:      msg.created_at || new Date().toISOString(),
    peer:            {userId: '', deviceId: 1},
  } as LocalMessage;
  queue.push({ownerUserId, msg: tombstone, version: '__deleted__'});
  scheduleFlush();
}

/**
 * Audit fix #30 — quick FNV-1a 32-bit hash of the serialized message
 * shape. Cheap (no async crypto), good enough to disambiguate "same
 * message, different state" inside one in-memory dedup window.
 * Collisions cost an unnecessary re-mirror; not a security boundary.
 */
function versionHash(msg: LocalMessage): string {
  return fnv1a(JSON.stringify(serializeMessage(msg)));
}

// B-648 — extracted unchanged from versionHash so the conversation hash
// shares it. MUST stay byte-identical: changing the algorithm invalidates
// every stored ledger version, and the next boot then re-uploads the whole
// history with fresh IVs — the I1 drift factory.
function fnv1a(json: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * B-648 — the plaintext conversation row, shared by the wire build in
 * flushConversations (which swaps `group_state` for its encrypted blob) and
 * the version hash. ONE builder on purpose: hashing a hand-maintained copy
 * of "what we upload" is how a field gets added to the wire but not the
 * hash, and a row whose only change is in that field then never re-ships
 * (the B-116 class, conv edition).
 */
function serializeConvForMirror(
  conv: LocalConversation,
  groupState: GroupState | undefined,
  deleted: boolean,
): Record<string, unknown> {
  const t = conv.type as unknown as string;
  const kind: 'direct' | 'group' | 'system' =
    t === 'group' ? 'group' : t === 'system' ? 'system' : 'direct';
  let members: Array<{userId: string; displayName?: string}> = [];
  if (kind === 'group' && Array.isArray(conv.participants)) {
    members = conv.participants
      .filter((uid): uid is string => typeof uid === 'string' && uid.length > 0 && uid !== 'self')
      .map(uid => ({userId: uid}));
  } else if (conv.peer) {
    members = [{userId: conv.peer.userId, displayName: conv.name ?? undefined}];
  }
  return {
    conversation_id: conv.id,
    kind,
    name:            conv.name ?? null,
    members,
    last_message_at: (conv as unknown as {last_message_at?: string}).last_message_at ?? null,
    // Round 8 — round-trip the conversation-level UX state.
    is_muted:        conv.is_muted ?? false,
    is_pinned:       conv.is_pinned ?? false,
    default_ttl_sec: conv.default_ttl_sec ?? null,
    unread_count:    conv.unread_count ?? 0,
    is_custom_name:  conv.is_custom_name ?? false,
    // Hashed as PLAINTEXT serialization — the wire encrypts this blob with
    // a fresh IV per upload, so hashing ciphertext would defeat the dedup.
    group_state:     groupState ? serializeGroupState(groupState) : null,
    // B-594 — explicit on every mirror: false for a live snapshot (so a
    // re-added room clears a stored delete), true from the delete path.
    deleted,
  };
}

/**
 * B-648 — the exact version hash the conversation dedup uses. Exported so
 * tests (and a future restore-side seed) can compute what the ledger holds.
 */
export function computeConvMirrorVersion(
  conv: LocalConversation,
  groupState?: GroupState,
  deleted = false,
): string {
  return fnv1a(JSON.stringify(serializeConvForMirror(conv, groupState, deleted)));
}

export function mirrorConversation(
  ownerUserId: string,
  conv: LocalConversation,
  groupState?: GroupState,
  // B-594 — a LIVE mirror sends deleted:false (so re-adding a room CLEARS a
  // stored delete flag: the lift); the delete path passes {deleted:true}. Both
  // are explicit — the server omits the column only when it is absent, so a
  // live mirror never leaves a re-added room suppressed.
  opts?: {deleted?: boolean},
): void {
  if (!enabled) {return;}
  if (!ownerUserId || !conv.id) {return;}
  if (mirrorOwnerUserId && mirrorOwnerUserId !== ownerUserId) {return;}
  const deleted = opts?.deleted ?? false;
  const version = computeConvMirrorVersion(conv, groupState, deleted);
  const key = `${ownerUserId}:${conv.id}`;
  // B-648 — conv-side I1: an unchanged snapshot whose version already
  // reached the server (convSeen is ledger-seeded at boot) must not
  // re-enqueue. The boot sweep walks EVERY conversation, so without this
  // check every launch re-encrypted + re-uploaded the whole set.
  if (convSeen.get(key) === version) {return;}
  convSeen.set(key, version);
  // De-dup by id — the latest snapshot wins.
  convQueue.set(key, {ownerUserId, conv, groupState, deleted, version});
  scheduleConvFlush();
}

function scheduleFlush(): void {
  if (flushTimer) {return;}
  flushTimer = setTimeout(() => { void flush(); }, FLUSH_DEBOUNCE_MS);
}

function scheduleConvFlush(): void {
  if (convFlushTimer) {return;}
  convFlushTimer = setTimeout(() => { void flushConversations(); }, FLUSH_DEBOUNCE_MS);
}

async function flush(): Promise<void> {
  flushTimer = null;
  if (queue.length === 0) {return;}
  if (!masterKey) {return;}
  // LAGDIAG — per-flush cost: serialization + AES-GCM per row runs on the
  // JS thread. Duration + batch size name the cost; >100ms is a felt stall.
  const _t0 = lagNow();
  const _n0 = queue.length;
  try {
  // BUG-2 — snapshot the session at entry. A dispose / wipe / key
  // rotation during any await below makes this flush stale: it must not
  // requeue its items or record ledger state afterwards.
  const gen = mirrorSessionGen;

  // Group by owner so we can ship a single POST per user.
  const byOwner = new Map<string, Pending[]>();
  while (queue.length > 0 && (byOwner.size === 0 || sumValues(byOwner) < MAX_BATCH)) {
    const item = queue.shift();
    if (!item) {break;}
    // BUG-2 — enforce the owner gate at FLUSH time too. Enqueue-time
    // gating isn't enough: rows requeued by an earlier failed flush can
    // sit in the queue across a signOut→signIn swap, and shipping them
    // here would wrap user A's plaintext under user B's master key and
    // POST it under B's bearer token into B's server mirror.
    if (mirrorOwnerUserId && item.ownerUserId !== mirrorOwnerUserId) {
      console.warn(`[mirror] flush dropped ${1} row for stale owner — gate mismatch`);
      continue;
    }
    const list = byOwner.get(item.ownerUserId) ?? [];
    list.push(item);
    byOwner.set(item.ownerUserId, list);
  }

  for (const [ownerId, items] of byOwner) {
    try {
      const rows = await Promise.all(items.map(async ({msg}) => {
        // Audit P0-B4 — outer-row metadata blinding. Use the v3
        // serializer so sender_id / recipient_id / conversation_id /
        // msg_type ship as a single opaque sentinel; the real values
        // are kept ONLY inside the encrypted payload. ciphertext_type
        // becomes 3. The DB schema's NOT NULL columns are satisfied
        // by the sentinel string.
        const v3 = serializeMessageForBackup(msg);
        const {key: subkey, raw: subkeyRaw} = await generateSubkey();
        // M-3 — bind BOTH the payload and the wrapped subkey to
        // (owner, message_id). A server that swaps a (ciphertext,
        // wrappedSubkey) pair into a different row's slot yields tags
        // that no longer verify under the target row's AAD, so the swap
        // is rejected on restore instead of silently accepted.
        const aadMsg = backupAad('msg', ownerId, v3.message_id);
        const wrappedPayload = await aesGcmEncrypt(subkey, new TextEncoder().encode(v3.payloadJson), aadMsg);
        const wrappedSubkey = await aesGcmEncrypt(masterKey!, subkeyRaw, aadMsg);
        subkeyRaw.fill(0);
        return {
          message_id:      v3.message_id,
          conversation_id: v3.conversation_id,
          sender_id:       v3.sender_id,
          recipient_id:    v3.recipient_id,
          msg_type:        v3.msg_type,
          ciphertext:      toB64(wrappedPayload),
          ciphertext_type: v3.ciphertext_type,
          envelope_meta:   {
            // Audit P0-B4 — `has_reactions` removed from plaintext
            // envelope_meta; it leaked which messages had reactions,
            // letting an attacker reconstruct partial conversation
            // activity from a server snapshot. Receivers reconstruct
            // the reactions array from the decrypted payload anyway.
            // (`expires_at` was already removed in Round 8 for the
            // same reason.)
            wrappedSubkey: toB64(wrappedSubkey),
          },
          msg_created_at:  v3.msg_created_at,
        };
      }));
      // BUG-7 (I2 kill window) — raise the pending flag BEFORE the
      // upload. The old order (upload → ledger write → flag) left a
      // kill window in which server bytes had changed, the ledger
      // suppressed re-upload, and no flag survived to fire the boot
      // heal → equal-count root_mismatch. Raising it first is kill-safe
      // in the harmless direction: a flag with no upload just costs one
      // extra commit over unchanged rows at the next boot.
      try { await setMerkleCommitPending(ownerId); } catch { /* best-effort */ }
      // B-687 — leaf-cache dirty raised BEFORE the upload, same raise-first
      // shape as the pending flag above: a kill between the POST and the
      // leaf upsert below must leave the cache marked untrusted, or a
      // flipped commit would sign a root missing this batch. `wasDirty`
      // remembers a PRIOR failure: this flush's success may only clear a
      // flag it raised itself — a cache missing an earlier batch stays
      // untrusted until a walk rewrite restores completeness.
      let leafCacheWasDirty = true;
      try {
        leafCacheWasDirty = await readLeafCacheDirty(ownerId);
        await setLeafCacheDirty(ownerId);
      } catch { /* best-effort */ }
      await backupClient.putMessages(rows);
      console.log(`[bravo.backup.mirror] flushed ${rows.length} messages`);
      // BUG-6 — a rotation/wipe/dispose happened while the POST was in
      // flight: the ledger was purged for a reason; recording the old-key
      // versions would make the boot sweep skip rows the server can no
      // longer decrypt. Skip all bookkeeping for this stale batch.
      if (gen !== mirrorSessionGen) {
        console.warn('[mirror] flush landed after session change — bookkeeping skipped');
        return;
      }
      // B-94 — the server bytes just changed, so (1) bump the flush epoch
      // (an in-flight commit walk must NOT clear the pending flag over
      // them), (2) persist which versions the server now holds so the
      // next boot sweep skips them.
      bumpFlushEpoch();
      try {
        await recordFlushedVersions(
          ownerId,
          items.map(({msg, version}) => ({messageId: msg.id, version})),
        );
      } catch { /* best-effort — degraded = pre-B-94 re-upload behaviour */ }
      // B-687 — record the batch's Merkle leaves from the EXACT uploaded
      // bytes (timestamp transformed to the server-return form). Tombstones
      // are ordinary rows here: the server upserts them, the row remains.
      // Dirty clears only when the covering upsert succeeded AND no prior
      // failure left the cache incomplete (`leafCacheWasDirty`); otherwise
      // it stays raised and the cache degrades to the walk (I8 direction).
      try {
        if (await upsertLeaves(ownerId, leavesFromWireRows(rows)) && !leafCacheWasDirty) {
          await clearLeafCacheDirty(ownerId);
        }
      } catch { /* best-effort — dirty stays raised */ }
      scheduleMerkleHook();
    } catch (e) {
      const kind = e instanceof BackupError ? e.kind : 'network';
      // BUG-2 — a stale flush (dispose/wipe/rotation during the await)
      // must NOT requeue: the queue was cleared for cross-user hygiene
      // and pushing the old owner's rows back re-opens the exact
      // contamination lane the dispose closed.
      if (gen !== mirrorSessionGen) {
        console.warn('[mirror] flush failed after session change — batch discarded');
        return;
      }
      // M-16 — treat auth/lockout as retry-later (requeue), not drop:
      // the batch is still valid; the token refreshes / lockout expires.
      // BUG-6b (audit 2026-07-23) — `quota_exceeded` (507) and
      // `invalid_request` (4xx validation) are PERMANENT for these bytes:
      // retrying re-encrypts and re-POSTs the same batch every 5-8s
      // forever. They fall through to the non-retryable drop below, and
      // quota additionally surfaces the "backup behind" banner so the
      // user learns the backup stopped.
      const retryable = kind === 'network' || kind === 'server' || kind === 'unauthorized' || kind === 'locked';
      if (retryable) {
        for (const item of items) {queue.push(item);}
        if (queue.length > MAX_QUEUE_SIZE) {
          // Round 8 — drop the NEWEST entries instead of the oldest.
          // The OLDEST messages are the ones the user can least afford to
          // lose; the newest tail lives durably in SQLCipher and the
          // catch-up sweep re-mirrors it.
          const drop = queue.length - MAX_QUEUE_SIZE;
          const dropped = queue.splice(MAX_QUEUE_SIZE, drop);
          // H-7 — remove the dropped entries' dedup keys. They were added
          // at enqueue time; leaving them made the overflow catch-up
          // sweep (which re-enqueues via mirrorMessage) a NO-OP, so the
          // dropped rows were lost for the rest of the session. Clearing
          // the keys lets the sweep re-mirror them from SQLCipher.
          clearDedupForItems(dropped);
          surfaceBackupBehind(true);
          console.warn(`[mirror] queue overflow — dropped ${drop} newest entries; backup behind`);
          if (catchUpSweep) {
            // BUG-8 — deferred + null-checked at fire time (dispose inside
            // the 1s defer used to null the callback and the `!` deref
            // threw an uncatchable TypeError inside the timer). Tracked so
            // dispose cancels it outright.
            trackTimer(() => {
              const sweep = catchUpSweep;
              if (!sweep) {return;}
              void sweep().catch(err =>
                console.warn('[mirror] overflow-triggered catch-up sweep failed:', (err as Error).message));
            }, 1_000);
          }
        }
        scheduleFlushRetry();
      } else {
        // Genuinely non-retryable for this row right now (e.g. no_backup /
        // service_disabled / quota / validation). Drop the batch BUT clear
        // its dedup keys so a later catch-up sweep can re-attempt from the
        // durable store — otherwise the keys pin the rows out of the
        // backup forever.
        clearDedupForItems(items);
        if (kind === 'quota_exceeded') {surfaceBackupBehind(true);}
        console.warn('[mirror] flush failed (dropped, dedup cleared):', (e as Error).message);
      }
    }
  }
  if (queue.length === 0) {surfaceBackupBehind(false);}
  if (queue.length > 0) {scheduleFlush();}
  } finally {
    const elapsed = lagNow() - _t0;
    if (elapsed >= 100) {
      console.warn(`[LAGDIAG] [backup.flush] tookMs=${Math.round(elapsed)} rows=${_n0 - queue.length} queuedLeft=${queue.length}`);
    }
  }
}

/**
 * B-45 R3 — synchronously drain BOTH outbox queues (messages +
 * conversations), bypassing the debounce timers. Used by the backup-setup
 * flow so the baseline Merkle commit signs the set that actually reached
 * the server — `backupNow()` only ENQUEUES, and committing while flushes
 * were still in flight signed a near-empty baseline (live evidence:
 * committed=3 vs server=14), bricking every later restore.
 *
 * `flush()` handles ≤ MAX_BATCH rows per call and re-queues on retryable
 * errors, so loop until both queues are empty — bailing out if an
 * iteration makes no progress (persistent network failure: leave the rest
 * to the jittered retry machinery rather than spin).
 */
export async function drainMirrorOutbox(): Promise<void> {
  if (flushTimer) {clearTimeout(flushTimer); flushTimer = null;}
  if (convFlushTimer) {clearTimeout(convFlushTimer); convFlushTimer = null;}
  // LAGDIAG — the backup-page "Enable" path drains the WHOLE history through
  // here in one sitting; on a low-end device this is the prime hang suspect.
  const _t0 = lagNow();
  const _n0 = queue.length + convQueue.size;
  let guard = 0;
  while ((queue.length > 0 || convQueue.size > 0) && guard < 200) {
    const before = queue.length + convQueue.size;
    try { await flush(); } catch { /* logged inside flush */ }
    try { await flushConversations(); } catch { /* logged inside */ }
    guard += 1;
    if (queue.length + convQueue.size >= before) {break;}
  }
  const elapsed = lagNow() - _t0;
  if (elapsed >= 250 || _n0 >= 100) {
    console.warn(`[LAGDIAG] [backup.drain] tookMs=${Math.round(elapsed)} rows=${_n0} iterations=${guard}`);
  }
}

/**
 * H-7 — drop every dedup key for the given items so they can be
 * re-enqueued later (by the catch-up sweep or a fresh mutation). B-632 — one
 * key per (owner, message) now holds EITHER the version hash or the
 * '__deleted__' tombstone marker, so a single delete clears both cases; this
 * used to be a full walk of the dedup set PER ITEM in a failed batch.
 */
function clearDedupForItems(items: Pending[]): void {
  for (const {ownerUserId, msg} of items) {
    seenIds.delete(versionKey(ownerUserId, msg.id));
  }
}

/** M-16 — jittered retry so many clients don't stampede the relay on recovery. */
function scheduleFlushRetry(): void {
  const delay = 5_000 + Math.floor(Math.random() * 3_000);
  // BUG-2 — tracked so disposeMirror/resetMirrorForWipe cancels it; the
  // untracked version survived signOut and re-armed the flush loop.
  trackTimer(() => scheduleFlush(), delay);
}

async function flushConversations(): Promise<void> {
  convFlushTimer = null;
  if (convQueue.size === 0) {return;}
  // BUG-2 — same stale-session guard as flush(); see there.
  const gen = mirrorSessionGen;
  // Round 8 — snapshot then clear so a new mutation arriving DURING
  // the await doesn't lose its event. Failed entries get re-set into
  // the queue in the catch path.
  const snapshot = Array.from(convQueue.values());
  convQueue.clear();
  const byOwner = new Map<string, Array<{conv: LocalConversation; groupState?: GroupState; deleted: boolean; version: string}>>();
  for (const {ownerUserId, conv, groupState, deleted, version} of snapshot) {
    const list = byOwner.get(ownerUserId) ?? [];
    list.push({conv, groupState, deleted, version});
    byOwner.set(ownerUserId, list);
  }
  for (const [ownerUserId, items] of byOwner) {
    try {
      const rows = await Promise.all(items.map(async ({conv, groupState, deleted}) => {
        // B-648 — the plaintext row comes from the SAME builder the version
        // hash uses (serializeConvForMirror); only group_state is swapped
        // for its encrypted blob below. Keeping one builder is what
        // guarantees the hash covers every field that ships.
        const plain = serializeConvForMirror(conv, groupState, deleted);
        // Audit P0-B5 — group_state is AES-GCM-encrypted under the
        // backup master key before it leaves the device. The plaintext
        // exposed groupId + member list + the GROUP MASTER KEY in raw
        // base64; anyone with DB read access could decrypt every
        // message ever sent in the group. With v3 the server stores
        // only ciphertext + a `v: 3` marker. Legacy plaintext blobs on
        // older accounts continue to deserialize via decryptGroupStateBlob.
        let groupStateOut: Record<string, unknown> | null = null;
        if (groupState && masterKey) {
          try {
            groupStateOut = (await encryptGroupStateBlob(
              masterKey,
              plain.group_state as Record<string, unknown>,
              backupAad('group', ownerUserId, conv.id),
            )) as unknown as Record<string, unknown>;
          } catch (e) {
            console.warn('[mirror] group_state encrypt failed; dropping:', (e as Error).message);
            groupStateOut = null;
          }
        }
        // Audit P0-B5 — v3 envelope. Legacy plaintext shape decoded
        // by decryptGroupStateBlob via the legacy-passthrough branch.
        return {...plain, group_state: groupStateOut};
      }));
      await backupClient.putConversations(rows);
      // B-648 — persist which conversation versions the server now holds
      // (conv: namespace in mirror_flushed) so the next boot sweep skips
      // them. Gen-guarded like flush(): a rotation/wipe during the POST
      // purged the ledger for a reason (BUG-6 class), so a stale batch must
      // not record itself. Deliberately NO flush-epoch bump and NO pending
      // flag — conversation rows are not Merkle leaves, and an idle boot
      // that only healed a conv row must stay commit-free.
      if (gen === mirrorSessionGen) {
        try {
          await recordFlushedVersions(
            ownerUserId,
            items.map(({conv, version}) => ({messageId: `${CONV_LEDGER_PREFIX}${conv.id}`, version})),
          );
        } catch { /* best-effort — degraded = re-upload on the next boot */ }
      }
    } catch (e) {
      // BUG-2 — stale session: do not requeue the previous owner's rows.
      if (gen !== mirrorSessionGen) {
        console.warn('[mirror] conv flush failed after session change — batch discarded');
        return;
      }
      const kind = e instanceof BackupError ? e.kind : 'network';
      const retryable = kind === 'network' || kind === 'server' || kind === 'unauthorized' || kind === 'locked';
      if (retryable) {
        for (const {conv, groupState, deleted, version} of items) {
          const key = `${ownerUserId}:${conv.id}`;
          // F11 — do NOT clobber a newer snapshot that arrived during the
          // await (e.g. a mute toggle or group rekey). Only requeue the
          // failed one when nothing fresher is already pending; otherwise
          // the stale state would ship and overwrite the newer one.
          if (!convQueue.has(key)) {
            convQueue.set(key, {ownerUserId, conv, groupState, deleted, version});
          }
        }
        const delay = 5_000 + Math.floor(Math.random() * 3_000);
        trackTimer(() => scheduleConvFlush(), delay);
      } else {
        // B-648 / H-7 parity — this batch is dropped for good; leaving the
        // dedup entries would skip these exact snapshots forever.
        for (const {conv} of items) {convSeen.delete(`${ownerUserId}:${conv.id}`);}
        console.warn('[mirror] conv flush failed:', (e as Error).message);
      }
    }
  }
}

/**
 * Round 8 — serialize GroupState for the backup. The masterKeyB64 is
 * encrypted-at-rest under the master key (the conversation row goes
 * through Supabase, not the per-row subkey wrap). The data is INSIDE
 * the user's encrypted backup blob conceptually — but the conv table
 * hasn't migrated to subkey wrapping yet. We pass the JSON through
 * straight; the server cannot do anything with the master key without
 * the user's password (the row column is bytea-equivalent JSONB
 * inside the user's owner_user_id row, which the auth guard scopes).
 *
 * Phase 2 will wrap the group_state column with a per-row subkey
 * the same way messages_backup is wrapped today.
 */
function serializeGroupState(g: GroupState): Record<string, unknown> {
  return {
    groupId:      g.groupId,
    owner:        g.owner,
    members:      g.members,
    masterKeyB64: g.masterKeyB64,
    epoch:        g.epoch,
    name:         g.name,
  };
}

function sumValues<T>(m: Map<unknown, T[]>): number {
  let n = 0; for (const v of m.values()) {n += v.length;} return n;
}

/**
 * Audit fix #29 — surface a "backup behind" flag the UI can render.
 */
function surfaceBackupBehind(behind: boolean): void {
  try {
    const {useMessengerStore} = require('../store/messengerStore') as
      typeof import('../store/messengerStore');
    if (behind) {
      useMessengerStore.getState().setError('Backup is behind — some messages may be missing on restore');
    } else {
      const cur = useMessengerStore.getState().error;
      if (cur?.startsWith('Backup is behind')) {
        useMessengerStore.getState().setError(null);
      }
    }
  } catch { /* store not ready yet; safe to ignore */ }
}

function serializeMessage(msg: LocalMessage): Record<string, unknown> {
  // Round 8 — full-fidelity serialization. Previously omitted fields
  // (`media_key`, `media_iv`, `retract_token`) caused restored
  // attachments to render as broken bubbles and stripped the user's
  // ability to retract messages from a freshly-restored device.
  return {
    id:               msg.id,
    conversation_id:  msg.conversation_id,
    sender_id:        msg.sender_id,
    type:             msg.type,
    content:          msg.content,
    status:           msg.status,
    created_at:       msg.created_at,
    is_encrypted:     msg.is_encrypted,
    peer:             msg.peer,
    envelope_id:      msg.envelope_id,
    expires_at:       msg.expires_at,
    reply_to_msg_id:  msg.reply_to_msg_id,
    reply_to_preview: msg.reply_to_preview,
    reactions:        msg.reactions,
    call_meta:        msg.call_meta,
    media_object_key: msg.media_object_key,
    media_mime:       msg.media_mime,
    media_key:        msg.media_key,
    media_iv:         msg.media_iv,
    retract_token:    msg.retract_token,
  };
}
