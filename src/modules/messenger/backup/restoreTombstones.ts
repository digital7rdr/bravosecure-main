import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * M-08 — persistent record of message ids the user deleted before a
 * reinstall, so the sealed-envelope ARCHIVE REPLAY (the second restore
 * phase, which replays server-side `sealed_envelope_archive` rows through
 * the live deliver path) does not resurrect them.
 *
 * The message-mirror leg already ships `status='deleted'` tombstones and
 * `restoreMessages` drops those rows — but after a fresh install the
 * seen-envelope dedup is empty and the deleted row is simply ABSENT from
 * the store, so the archive replay's `appendMessage` re-inserts it. We
 * capture the tombstoned ids during the mirror restore into this set and
 * the receive path consults it (`isRestoreTombstoned`) before appending.
 *
 * Message ids are unique client-msg ids, so a live NEW message can never
 * collide with a tombstoned id — the gate is safe on the shared receive
 * path, but callers keep it scoped to inbound appends to be conservative.
 *
 * The set is bounded: only ids from the restored backup land here, and we
 * cap storage so a pathologically large delete history can't grow without
 * limit.
 */
const KEY_PREFIX = 'messenger.restoreTombstones.v1:';
const MAX_IDS = 20_000;

// BUG-R (audit 2026-07-23) — the cache is keyed on the owner it was
// loaded for. The old owner-blind `if (cached) return cached` served
// user A's tombstone set to user B after an in-process account switch
// (and a later B restore merged B's ids INTO A's cached set and
// persisted the union under B's key). An empty ownerUserId is never
// cached, so an early anonymous call can't pin an empty set for the
// whole session.
let cached: {owner: string; set: Set<string>} | null = null;

function keyFor(ownerUserId: string): string {
  return `${KEY_PREFIX}${ownerUserId}`;
}

/** Load the owner's tombstone id set into memory. Call once on runtime build. */
export async function loadRestoreTombstones(ownerUserId: string): Promise<Set<string>> {
  if (!ownerUserId) {return new Set();}
  if (cached && cached.owner === ownerUserId) {return cached.set;}
  try {
    const raw = await AsyncStorage.getItem(keyFor(ownerUserId));
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    cached = {
      owner: ownerUserId,
      set: new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []),
    };
  } catch {
    cached = {owner: ownerUserId, set: new Set()};
  }
  return cached.set;
}

/**
 * Persist a batch of deleted message ids captured during a mirror restore.
 * Merges with any already stored and re-loads the in-memory cache so the
 * receive path sees them immediately (the archive replay runs right after).
 */
export async function addRestoreTombstones(ownerUserId: string, ids: readonly string[]): Promise<void> {
  if (!ownerUserId || ids.length === 0) {return;}
  const set = await loadRestoreTombstones(ownerUserId);
  for (const id of ids) {if (id) {set.add(id);}}
  // Bound storage — drop the oldest ids (insertion order) past the cap.
  let toStore = Array.from(set);
  if (toStore.length > MAX_IDS) {
    toStore = toStore.slice(toStore.length - MAX_IDS);
    cached = {owner: ownerUserId, set: new Set(toStore)};
  }
  try {
    await AsyncStorage.setItem(keyFor(ownerUserId), JSON.stringify(toStore));
  } catch {
    // Best-effort — the in-memory set still blocks resurrection this session.
  }
}

/** Synchronous hot-path read. Returns false when uninitialised (fail-open — never drop a live message). */
export function isRestoreTombstoned(msgId: string | undefined | null): boolean {
  if (!msgId || !cached || cached.set.size === 0) {return false;}
  return cached.set.has(msgId);
}

/** Test-only — clears the in-memory cache. */
export function _resetRestoreTombstonesForTests(): void {
  cached = null;
}
