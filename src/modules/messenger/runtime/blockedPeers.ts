import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * M-07 (recipient leg) — local cache of the user's blocked-peer userIds.
 *
 * The server enforces block on the DIRECTORY, presence, typing and
 * read-receipt paths, but sealed sender hides the sender from the relay,
 * so an inbound MESSAGE from a blocked peer cannot be dropped server-side.
 * The recipient client is therefore the only place message-level block can
 * be enforced: the receive path consults `isPeerBlocked()` before it
 * appends (which would otherwise resurrect the conversation the user just
 * blocked out of existence).
 *
 * Authoritative source is auth-service (`GET /users/blocked`); this cache
 * is refreshed on runtime build and written through on every block/unblock
 * so a hot inbound frame can check synchronously with no round-trip.
 * Defaults to "not blocked" for an uninitialised cache — we never drop a
 * message we aren't sure is from a blocked peer.
 *
 * Audit P1-10 — the cache is OWNER-SCOPED. A device can host multiple
 * accounts (vaultByOwner); a single global key let account B inherit
 * account A's block set and silently destroy the wrong user's messages
 * (and, on a settings visit, silently un-enforce A's blocks). Storage is
 * now keyed per owner (`messenger.blockedPeers.v1.<owner>`, mirroring the
 * durable read-receipt queue) and the in-memory set is reset whenever
 * `loadBlockedPeers(owner)` is called with a different owner (owner switch).
 */
const KEY_PREFIX = 'messenger.blockedPeers.v1.';

let cached: Set<string> | null = null;
/** The owner key the in-memory `cached` set belongs to. */
let cachedOwner: string | null = null;

function keyFor(owner: string): string {
  return `${KEY_PREFIX}${owner}`;
}

async function persist(): Promise<void> {
  if (!cached || !cachedOwner) {return;}
  try {
    await AsyncStorage.setItem(keyFor(cachedOwner), JSON.stringify(Array.from(cached)));
  } catch {
    // Best-effort — the in-memory set still reflects the change this session.
  }
}

/**
 * Load the persisted set into memory. Call on every runtime build with the
 * active owner key. Passing a NEW owner resets the in-memory set first so a
 * multi-account device never bleeds one user's blocks into another. Passing
 * no owner reuses the currently-loaded owner (or a safe empty set).
 */
export async function loadBlockedPeers(ownerKey?: string): Promise<Set<string>> {
  // Owner switch — drop the prior owner's set so account B never inherits
  // account A's blocks (silent wrong-user message loss).
  if (ownerKey !== undefined && ownerKey !== cachedOwner) {
    cached = null;
    cachedOwner = ownerKey || null;
  } else if (cachedOwner === null && ownerKey) {
    cachedOwner = ownerKey;
  }
  if (cached) {return cached;}
  const owner = cachedOwner;
  if (!owner) {cached = new Set(); return cached;}
  try {
    const raw = await AsyncStorage.getItem(keyFor(owner));
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    cached = new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    cached = new Set();
  }
  return cached;
}

/**
 * Replace the whole set from the server's authoritative list. Merges nothing —
 * an unblock on another device must be able to REMOVE an id here. Persists
 * under the currently-loaded owner.
 */
export async function setBlockedPeers(userIds: readonly string[]): Promise<void> {
  cached = new Set(userIds);
  await persist();
}

export async function addBlockedPeer(userId: string): Promise<void> {
  if (!userId) {return;}
  if (!cached) {await loadBlockedPeers();}
  cached!.add(userId);
  await persist();
}

export async function removeBlockedPeer(userId: string): Promise<void> {
  if (!userId || !cached) {return;}
  cached.delete(userId);
  await persist();
}

/** Synchronous hot-path read. Returns false when uninitialised (fail-open). */
export function isPeerBlocked(userId: string | undefined | null): boolean {
  if (!userId || !cached) {return false;}
  return cached.has(userId);
}

/** Test-only — clears the in-memory cache so a fresh load re-reads storage. */
export function _resetBlockedPeersForTests(): void {
  cached = null;
  cachedOwner = null;
}
