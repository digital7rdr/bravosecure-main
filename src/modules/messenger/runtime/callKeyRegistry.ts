import AsyncStorage from '@react-native-async-storage/async-storage';
import type {ConversationId, GroupId} from '../conversationIds';

/**
 * B-124/B-125 root fix (handoff §9 item 2, founder-approved 2026-07-21) —
 * the call-key NAMESPACE.
 *
 * 1:1→group call escalation mints a throwaway `'Call'`-named GroupState.
 * That state used to be ALIASED into `groups[]` under chat-bearing ids
 * (`direct:<self>`, the originating 1:1 conversation id) so the resync /
 * joiner paths could find it by the ids that travel with the call — and
 * those aliases were the seed of the whole B-124/B-125 contamination
 * class: a `type:'direct'` row with a stray `'Call'` key was routed as a
 * group forever.
 *
 * This registry replaces every alias. `'Call'` states now live ONLY
 * under their own minted 32-hex group ids; the link from an originating
 * conversation id (or `direct:<host>` on the receiving side) to the
 * minted id lives here — ids only, NEVER key material, so nothing in
 * this file touches SQLCipher, the backup mirror, or the wire.
 *
 * Owner-scoped + persisted (mirrors blockedPeers.ts): a re-escalation of
 * the same 1:1 days later must resync the existing key, not mint a new
 * one per call (the B-106 growth class). Losing the file is benign — the
 * next escalation mints fresh, exactly like a first install.
 */
const KEY_PREFIX = 'messenger.callKeyRegistry.v1.';
/** Bounded — one live mapping per 1:1 thread that ever escalated. */
const MAX_ENTRIES = 50;

interface CallKeyEntry {
  keyGroupId: string;
  updatedAt:  number;
}

let cached: Map<string, CallKeyEntry> | null = null;
let cachedOwner: string | null = null;

function keyFor(owner: string): string {
  return `${KEY_PREFIX}${owner}`;
}

function persist(): void {
  if (!cached || !cachedOwner) {return;}
  const obj: Record<string, CallKeyEntry> = {};
  for (const [k, v] of cached) {obj[k] = v;}
  void AsyncStorage.setItem(keyFor(cachedOwner), JSON.stringify(obj)).catch(() => {
    // Best-effort — the in-memory map still serves this session.
  });
}

/**
 * Hydrate the persisted map. Call on every runtime build with the active
 * owner key; a NEW owner resets the map first (multi-account device).
 */
export async function loadCallKeyRegistry(ownerKey?: string): Promise<void> {
  if (ownerKey !== undefined && ownerKey !== cachedOwner) {
    cached = null;
    cachedOwner = ownerKey || null;
  } else if (cachedOwner === null && ownerKey) {
    cachedOwner = ownerKey;
  }
  if (cached) {return;}
  cached = new Map();
  const owner = cachedOwner;
  if (!owner) {return;}
  try {
    const raw = await AsyncStorage.getItem(keyFor(owner));
    const obj = raw ? (JSON.parse(raw) as unknown) : null;
    if (obj && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        const e = v as Partial<CallKeyEntry> | null;
        if (e && typeof e.keyGroupId === 'string' && e.keyGroupId) {
          cached.set(k, {keyGroupId: e.keyGroupId, updatedAt: Number(e.updatedAt) || 0});
        }
      }
    }
  } catch {
    // Corrupt/unreadable — start empty; the next escalation self-heals.
  }
}

/** Sync hot-path read: the minted call-key group id an origin id maps to. */
export function resolveCallKeyGroupId(originId: string | undefined | null): string | undefined {
  if (!originId || !cached) {return undefined;}
  return cached.get(originId)?.keyGroupId;
}

/**
 * File (or replace) the origin → minted-id link. Returns the PREVIOUS
 * minted id when the link changed, so the caller can garbage-collect the
 * superseded `'Call'` state (the B-106 per-escalation accumulation).
 * Refuses chat-shaped targets — a `direct:`-prefixed "minted id" is
 * exactly the corruption this module exists to end.
 */
export function setCallKeyMapping(originId: ConversationId, keyGroupId: GroupId): string | undefined {
  if (!originId || !keyGroupId) {return undefined;}
  if (keyGroupId.startsWith('direct:') || keyGroupId === originId) {return undefined;}
  if (!cached) {cached = new Map();}
  const prev = cached.get(originId)?.keyGroupId;
  cached.set(originId, {keyGroupId, updatedAt: Date.now()});
  if (cached.size > MAX_ENTRIES) {
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [k, v] of cached) {
      if (v.updatedAt < oldestAt) {oldestAt = v.updatedAt; oldestKey = k;}
    }
    if (oldestKey !== null && oldestKey !== originId) {cached.delete(oldestKey);}
  }
  persist();
  return prev !== keyGroupId ? prev : undefined;
}

export function deleteCallKeyMapping(originId: string): void {
  if (!originId || !cached) {return;}
  if (cached.delete(originId)) {persist();}
}

/**
 * Resolve the GroupState for a call-capable lookup handle: the mapped
 * minted `'Call'` state when a registry link exists AND holds a key,
 * else whatever legitimately lives at the id itself (real groups).
 * Shared by the SFrame keySource and the joiner's slot resolution so
 * both sides always agree on which state a handle means.
 */
export function resolveGroupForCall<T extends {masterKeyB64?: string}>(
  groups: Record<string, T | undefined>,
  id: string | undefined | null,
): T | undefined {
  if (!id) {return undefined;}
  const mappedId = resolveCallKeyGroupId(id);
  const viaMap = mappedId ? groups[mappedId] : undefined;
  if (viaMap?.masterKeyB64) {return viaMap;}
  return groups[id];
}

/** Test-only — clears the in-memory map so a fresh load re-reads storage. */
export function _resetCallKeyRegistryForTests(): void {
  cached = null;
  cachedOwner = null;
}
