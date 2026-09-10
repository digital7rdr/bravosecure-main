import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * B-594 — persistent record of conversations the user DELETED, so a backup
 * restore cannot hand them straight back.
 *
 * ── THE BUG ───────────────────────────────────────────────────────────────
 *
 * "whatever chat list we delete, it appears for a fraction of a second when
 * the backup thing happens — like those mission chats." Deleting a
 * conversation was a Zustand-only eviction (`removeConversation`): no
 * tombstone, no mirror removal, no server call. The conversation therefore
 * survived in full in `conversation_backups` and `messages_backup`, and the
 * restore's conversation apply re-inserted it — its "is this already live?"
 * guard exists to avoid stomping FRESHER state, so a deliberately-deleted row
 * is precisely the case it waves through. `upsertConversation` unshifts a new
 * row onto `conversationOrder`, so it reappeared at the TOP of the list.
 *
 * The flicker (rather than a permanent resurrection) is the Home screen's
 * server prune deleting it again once `listMine` lands — a network round-trip
 * later. Appear → prune → appear, for as long as the restore streams.
 *
 * ── WHY A SET AND NOT "JUST DELETE IT PROPERLY" ──────────────────────────
 *
 * Both, eventually — but they are different jobs. Purging the mirror is how
 * the backup stops GROWING; this set is how a delete stays honest across a
 * restore that legitimately still holds the rows (an older commit, another
 * device's mirror, a restore started before the delete). Only the second one
 * fixes the founder's flicker, and it is invariant-safe in a way the first is
 * not: see the BACKUP_LOOP notes below.
 *
 * ── BACKUP_LOOP (§2) — WHY THIS IS SUPPRESSION-ONLY ──────────────────────
 *
 * This gate runs at the UPSERT, never at the mirror walk. That distinction is
 * load-bearing:
 *   - I3: every mirrored row is still hashed into the Merkle leaf set.
 *     Filtering what gets PAINTED is not filtering what gets VERIFIED —
 *     filtering the walk would manufacture `rows_count` drift and re-open the
 *     `root_mismatch` class that shipped five times.
 *   - I7: the restore's ledger seed still records every durably-written,
 *     verified row. A suppressed conversation's messages remain in
 *     `pendingBatches`/`flushedIds`; dropping them would make the next sweep
 *     re-upload with fresh IVs, which is the B-94 drift factory.
 *   - I8: reads FAIL OPEN. An uninitialised or unreadable set means "not
 *     deleted", so a storage failure can never hide a live conversation.
 *   - I5: NOT cleared on a backup wipe — see `clearAllConversationTombstones`
 *     for why owner-keying, not wiping, is what closes the account-switch
 *     hazard I5 is really about.
 *   - I9: ids ONLY. A conversation NAME here would be plaintext at rest.
 *
 * ── UN-TOMBSTONING IS NOT OPTIONAL ───────────────────────────────────────
 *
 * A tombstone that never lifts is worse than the bug: re-adding someone to a
 * mission room, or a peer messaging you again after you cleared the thread,
 * would leave them permanently invisible. So a GENUINELY LIVE arrival clears
 * the entry (`clearConversationTombstone`) — the same shape as unblocking a
 * peer. The restore's own replay must NOT clear it, which is why the gate is
 * consulted by the replay path and cleared only by the live one.
 */
const KEY_PREFIX = 'messenger.deletedConversations.v1:';
/** Conversation ids are far rarer than message ids; this is generous. */
const MAX_IDS = 5_000;

// BUG-R shape, deliberately copied from restoreTombstones: the cache is keyed
// on the owner it was loaded for, so an in-process account switch cannot serve
// user A's deletions to user B. An empty ownerUserId is never cached, so an
// early anonymous call cannot pin an empty set for the session.
let cached: {owner: string; set: Map<string, number>} | null = null;

function keyFor(ownerUserId: string): string {
  return `${KEY_PREFIX}${ownerUserId}`;
}

/** Load the owner's deleted-conversation set. Call once on runtime build. */
export async function loadConversationTombstones(ownerUserId: string): Promise<ReadonlyMap<string, number>> {
  if (!ownerUserId) {return new Map();}
  if (cached && cached.owner === ownerUserId) {return cached.set;}
  try {
    const raw = await AsyncStorage.getItem(keyFor(ownerUserId));
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    // Stored as [id, deletedAtMs] pairs. A LEGACY array of bare ids (written by
    // the first draft of this module, before the timestamp mattered) still
    // loads: each id takes deletion time 0, which reads as "deleted at the
    // dawn of time" — so every arrival is newer and lifts it. That is the
    // fail-open direction, and the only honest one when we cannot know when
    // the delete happened.
    const entries: [string, number][] = [];
    if (Array.isArray(parsed)) {
      for (const row of parsed) {
        if (typeof row === 'string') {entries.push([row, 0]);}
        else if (Array.isArray(row) && typeof row[0] === 'string') {
          entries.push([row[0], typeof row[1] === 'number' ? row[1] : 0]);
        }
      }
    }
    cached = {owner: ownerUserId, set: new Map(entries)};
  } catch {
    cached = {owner: ownerUserId, set: new Map()};
  }
  return cached.set;
}

/**
 * Record a deleted conversation id.
 *
 * SYNCHRONOUS in-memory, best-effort on disk: the delete and the restore that
 * would resurrect it can be milliseconds apart, and awaiting AsyncStorage
 * before the gate is armed is exactly the race this exists to close. Returns
 * immediately; persistence catches up.
 */
export function rememberDeletedConversation(conversationId: string, nowMs: number): void {
  if (!conversationId || !cached) {return;}
  // Re-deleting refreshes the position AND the time: `Map.set` on an existing
  // key keeps its slot, so delete-and-re-add first to move it to the newest
  // end. Without that a repeatedly-deleted chat still ages out of the cap.
  cached.set.delete(conversationId);
  cached.set.set(conversationId, nowMs);
  const owner = cached.owner;
  let toStore = Array.from(cached.set.entries());
  if (toStore.length > MAX_IDS) {
    toStore = toStore.slice(toStore.length - MAX_IDS);
    cached = {owner, set: new Map(toStore)};
  }
  void AsyncStorage.setItem(keyFor(owner), JSON.stringify(toStore)).catch(() => {
    // Best-effort — the in-memory set still suppresses for this session.
  });
}

/**
 * B-594 fresh-install restore — arm the deleted-conversation set from ids the
 * backup carried (a `conversation_backups.deleted=true` row).
 *
 * THE GAP THIS CLOSES: the set above lives only in per-install AsyncStorage, so
 * a fresh install / device migration booted with an EMPTY set and every deleted
 * conversation was re-minted from the backup. The delete now mirrors a
 * server-side `deleted` flag (a live mirror clears it), so restore can arm the
 * ids here BEFORE it applies the staged conversation rows — the existing
 * `isConversationTombstoned` guard at the upsert then suppresses them.
 *
 * Deletion time 0 ("dawn of time") on purpose: we no longer know WHEN the delete
 * happened, so any genuinely newer arrival — a real message, or `listMine`
 * re-listing the room — still LIFTS it (the same fail-open direction as the
 * legacy bare-id load). Merged into the persisted set so it also survives to the
 * NEXT restore. Ids only (I9); best-effort persistence (I8).
 */
export async function armDeletedConversationsFromRestore(
  ownerUserId: string,
  ids: readonly string[],
): Promise<void> {
  if (!ownerUserId || ids.length === 0) {return;}
  // Loads + caches the owner's set (empty on a fresh install); after this,
  // `cached.owner === ownerUserId`, so we mutate the live cache directly and
  // the synchronous hot-path read sees the arm immediately.
  await loadConversationTombstones(ownerUserId);
  if (!cached || cached.owner !== ownerUserId) {return;}
  let changed = false;
  for (const id of ids) {
    if (id && !cached.set.has(id)) {
      cached.set.set(id, 0);
      changed = true;
    }
  }
  if (!changed) {return;}
  let toStore = Array.from(cached.set.entries());
  if (toStore.length > MAX_IDS) {
    toStore = toStore.slice(toStore.length - MAX_IDS);
    cached = {owner: ownerUserId, set: new Map(toStore)};
  }
  try {
    await AsyncStorage.setItem(keyFor(ownerUserId), JSON.stringify(toStore));
  } catch {
    // Best-effort — the in-memory set already suppresses this session.
  }
}

/** When this conversation was deleted (ms), or null if it was not. */
function deletionTime(conversationId: string | undefined | null): number | null {
  if (!conversationId || !cached || cached.set.size === 0) {return null;}
  const at = cached.set.get(conversationId);
  return at === undefined ? null : at;
}

/**
 * A conversation is genuinely live again (a real inbound message, or the
 * server listing it): lift the suppression.
 *
 * MUST NOT be called from the restore/replay path — that is the resurrection
 * this module exists to stop.
 */
export function clearConversationTombstone(conversationId: string): void {
  if (!conversationId || !cached?.set.delete(conversationId)) {return;}
  const owner = cached.owner;
  void AsyncStorage.setItem(keyFor(owner), JSON.stringify(Array.from(cached.set.entries()))).catch(() => {
    // Best-effort — the in-memory removal already un-suppresses this session.
  });
}

/**
 * Synchronous hot-path read. FAIL-OPEN: false when uninitialised, so a storage
 * failure can never hide a conversation the user still has (I8).
 */
export function isConversationTombstoned(conversationId: string | undefined | null): boolean {
  return deletionTime(conversationId) !== null;
}

/**
 * Drop every suppression for an owner.
 *
 * ⚠️ NOT wired to the backup wipe, deliberately — and this is a considered
 * divergence from the review's I5 suggestion. A server wipe changes what the
 * BACKUP holds; it does not change what the USER deleted. Clearing here would
 * make "wipe the backup, set it up again" resurrect every deleted chat on the
 * next restore, which is the bug this module exists to fix. The cross-account
 * hazard I5 is really about is already closed by owner-keying the set (see the
 * BUG-R cache note above).
 *
 * Kept for account deletion / explicit "forget my deletions", and for tests.
 */
export async function clearAllConversationTombstones(ownerUserId: string): Promise<void> {
  if (!ownerUserId) {return;}
  cached = {owner: ownerUserId, set: new Map()};
  try {
    await AsyncStorage.removeItem(keyFor(ownerUserId));
  } catch { /* best-effort */ }
}

/**
 * ── IS THIS ARRIVAL A REPLAY? ────────────────────────────────────────────
 *
 * The sealed-archive replay builds a synthetic `envelope.deliver` frame and
 * runs the FULL live receive path — deliberately, so replayed envelopes get
 * every dep the WS path carries (audit §12.4). That leaves the receive path
 * unable to tell "a peer just messaged me" from "the restore is handing back
 * what I deleted", and the two need opposite answers:
 *
 *   live  → the conversation is genuinely back; LIFT the tombstone. Deleting a
 *           thread must not deafen you to that person forever.
 *   replay→ suppress, silently. This is the resurrection being fixed.
 *
 * So the replay brackets itself. A COUNTER, not a boolean: the drain awaits
 * each envelope, but a nested/concurrent replay must not have its inner
 * `end` clear the outer's bracket.
 */
let replayDepth = 0;

export function beginArchiveReplay(): void { replayDepth += 1; }
export function endArchiveReplay(): void { replayDepth = Math.max(0, replayDepth - 1); }
export function isArchiveReplayInProgress(): boolean { return replayDepth > 0; }

/**
 * The receive path's decision for a tombstoned conversation.
 *
 * Returns true when the caller must SUPPRESS. A live arrival lifts the
 * tombstone as a side effect and returns false, so the message lands and the
 * thread comes back — which is the behaviour every messenger has.
 */
export function suppressResurrection(
  conversationId: string,
  /**
   * When the arriving item was COMPOSED (ms). Optional — a group `create` has
   * no meaningful per-arrival time.
   *
   * This is the precise half of the answer, and it exists because the replay
   * bracket is a global time window: a genuinely live WS envelope that lands
   * inside one of the replay's awaits would otherwise be read as replayed and
   * suppressed. Anything composed AFTER the delete is new traffic by
   * definition, whatever the bracket says.
   */
  composedAtMs?: number,
): boolean {
  const deletedAt = deletionTime(conversationId);
  if (deletedAt === null) {return false;}
  if (composedAtMs !== undefined && Number.isFinite(composedAtMs) && composedAtMs > deletedAt) {
    clearConversationTombstone(conversationId);
    return false;
  }
  if (isArchiveReplayInProgress()) {return true;}
  clearConversationTombstone(conversationId);
  return false;
}

/** Test-only — clears the in-memory cache. */
export function _resetConversationTombstonesForTests(): void {
  cached = null;
  replayDepth = 0;
}

/** Test-only — arms the cache without touching AsyncStorage. */
export function _armConversationTombstonesForTests(owner: string, ids: readonly string[] = []): void {
  cached = {owner, set: new Map(ids.map(id => [id, 0]))};
}
