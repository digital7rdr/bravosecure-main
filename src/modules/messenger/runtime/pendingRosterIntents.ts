import AsyncStorage from '@react-native-async-storage/async-storage';
import {conversationApi} from '@services/api';

/**
 * Audit P1-5 / P1-6 — durable client→server roster reconciliation.
 *
 * ChatInfoScreen (remove / leave) and NewChatScreen (add) apply the group
 * membership change CRYPTOGRAPHICALLY on-device (runtime.removeGroupMember /
 * leaveGroup / addGroupMember rekey the group) but must ALSO write the server
 * `conversation_members` roster, otherwise the next `/conversations/mine` sync
 * resurrects a removed member (who then still receives fan-out media keys +
 * download grants — a privacy defect) or drops a freshly-added one.
 *
 * The server write can fail (offline / 5xx). Losing it would re-open the exact
 * split-brain. This module is the durable retry queue: a failed write is
 * enqueued to owner-scoped AsyncStorage and `flushRosterIntents` (fired on
 * MessengerHome sync) re-attempts it until the server roster matches the local
 * crypto state. Until then `hasPendingRosterIntent` lets the Home sync SKIP the
 * participants overwrite for that conversation so the stale server roster can't
 * undo the local change.
 *
 * SECURITY: this layer only reconciles METADATA (the `conversation_members`
 * roster). It never touches key material — the rekey already happened in the
 * runtime and the removed member is already excluded from the new master key.
 *
 * Owner-scoped (mirrors blockedPeers.ts): a multi-account device must never
 * flush account A's pending roster writes as account B.
 */

export type RosterAction = 'add' | 'remove';

export interface PendingRosterIntent {
  id:             string;
  conversationId: string;
  memberUserId:   string;
  action:         RosterAction;
  createdAtMs:    number;
}

const KEY_PREFIX = 'messenger.pendingRosterIntents.v1.';

// Server-backed conversations (mission ops rooms, dept channels, REST-created
// groups) have a UUID id and a `conversation_members` row. Locally-derived
// group ids (createGroupChat → salt-derived sha256 hex) are NOT on the server
// roster, so a roster write would 404 — skip them.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isServerBackedConversationId(conversationId: string): boolean {
  return UUID_RE.test(conversationId);
}

let cached: PendingRosterIntent[] | null = null;
let cachedOwner: string | null = null;

function keyFor(owner: string): string {
  return `${KEY_PREFIX}${owner}`;
}

function makeId(): string {
  const rand = new Uint8Array(8);
  crypto.getRandomValues(rand);
  return Array.from(rand, b => b.toString(16).padStart(2, '0')).join('');
}

async function persist(): Promise<void> {
  if (!cached || !cachedOwner) {return;}
  try {
    await AsyncStorage.setItem(keyFor(cachedOwner), JSON.stringify(cached));
  } catch {
    // Best-effort — the in-memory queue still reflects this session's changes.
  }
}

/**
 * Load the persisted queue into memory. A NEW owner resets the in-memory queue
 * first (owner switch) so a multi-account device never flushes the wrong user's
 * roster writes. Passing no owner reuses the currently-loaded owner.
 */
export async function loadPendingRosterIntents(ownerKey?: string): Promise<PendingRosterIntent[]> {
  if (ownerKey !== undefined && ownerKey !== cachedOwner) {
    cached = null;
    cachedOwner = ownerKey || null;
  } else if (cachedOwner === null && ownerKey) {
    cachedOwner = ownerKey;
  }
  if (cached) {return cached;}
  const owner = cachedOwner;
  if (!owner) {cached = []; return cached;}
  try {
    const raw = await AsyncStorage.getItem(keyFor(owner));
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    cached = Array.isArray(arr) ? (arr.filter(isIntent) as PendingRosterIntent[]) : [];
  } catch {
    cached = [];
  }
  return cached;
}

function isIntent(x: unknown): x is PendingRosterIntent {
  const i = x as PendingRosterIntent;
  return !!i && typeof i.conversationId === 'string' && typeof i.memberUserId === 'string'
    && (i.action === 'add' || i.action === 'remove');
}

/**
 * Synchronous hot-path read used by the Home sync guard. Returns true when a
 * roster write for this conversation is still pending (local crypto state is
 * ahead of the server roster). Returns false when the cache isn't loaded — the
 * sync loads/flushes the queue before consulting this.
 */
export function hasPendingRosterIntent(conversationId: string): boolean {
  if (!cached) {return false;}
  return cached.some(i => i.conversationId === conversationId);
}

async function enqueue(
  ownerKey: string | undefined,
  conversationId: string,
  memberUserId: string,
  action: RosterAction,
): Promise<void> {
  await loadPendingRosterIntents(ownerKey);
  if (!cached) {cached = [];}
  // Latest action per (conversation, member) wins — a queued add followed by a
  // remove of the same member cancels the add (and vice-versa), so we never
  // flush two contradictory writes.
  cached = cached.filter(i => !(i.conversationId === conversationId && i.memberUserId === memberUserId));
  cached.push({id: makeId(), conversationId, memberUserId, action, createdAtMs: Date.now()});
  await persist();
}

async function callServerRoster(
  conversationId: string, memberUserId: string, action: RosterAction,
): Promise<void> {
  if (action === 'add') {
    await conversationApi.addMember(conversationId, memberUserId);
  } else {
    await conversationApi.removeMember(conversationId, memberUserId);
  }
}

/**
 * Write the server `conversation_members` roster for a membership change that
 * was ALREADY applied to the local group crypto. On failure the write is
 * durably queued for `flushRosterIntents` to retry. No-op (skipped) for
 * locally-derived (non-UUID) group ids that have no server roster.
 *
 * Call this AFTER the local crypto remove/add/leave — the new master key
 * already excludes a removed member; this only reconciles the metadata roster.
 */
export async function writeServerRosterOrQueue(args: {
  conversationId: string;
  memberUserId:   string;
  action:         RosterAction;
  ownerKey?:      string;
}): Promise<{ok: boolean; queued: boolean; skipped: boolean}> {
  if (!isServerBackedConversationId(args.conversationId)) {
    return {ok: true, queued: false, skipped: true};
  }
  try {
    await callServerRoster(args.conversationId, args.memberUserId, args.action);
    return {ok: true, queued: false, skipped: false};
  } catch {
    await enqueue(args.ownerKey, args.conversationId, args.memberUserId, args.action);
    return {ok: false, queued: true, skipped: false};
  }
}

export interface FlushResult {
  flushed:   number;
  remaining: number;
}

// Coalesce concurrent flushes (same rationale as drainConversationIntents).
let inFlight: Promise<FlushResult> | null = null;

/**
 * Retry every pending roster write. Each success drops the intent from the
 * durable queue; failures stay for the next flush (at-least-once). Coalesced.
 */
export function flushRosterIntents(ownerKey?: string): Promise<FlushResult> {
  if (inFlight) {return inFlight;}
  inFlight = flushOnce(ownerKey).finally(() => { inFlight = null; });
  return inFlight;
}

async function flushOnce(ownerKey?: string): Promise<FlushResult> {
  const queue = await loadPendingRosterIntents(ownerKey);
  if (queue.length === 0) {return {flushed: 0, remaining: 0}; }
  let flushed = 0;
  const survivors: PendingRosterIntent[] = [];
  // Iterate a snapshot so a concurrent enqueue can't be lost.
  for (const intent of [...queue]) {
    try {
      await callServerRoster(intent.conversationId, intent.memberUserId, intent.action);
      flushed += 1;
    } catch {
      survivors.push(intent);
    }
  }
  cached = survivors;
  await persist();
  return {flushed, remaining: survivors.length};
}

/**
 * Home-sync guard decision. When a roster write is still pending for a
 * conversation the LOCAL participants are authoritative (the crypto change
 * already applied); the stale server roster must not overwrite them:
 *   - existing local row  → keep its participants (don't resurrect/drop a member)
 *   - no local row        → skip the upsert entirely (don't re-create a group
 *                            the user just left while its self-removal is pending)
 *
 * GF-4 — the pending queue is device-local (owner-scoped AsyncStorage), so it
 * only ever protects the device that made the change. On every OTHER member's
 * device the crypto membership (`groups[gid].members`, committed by the verified
 * admin envelope) is the source of truth for `convo.participants` — the same
 * invariant `setGroupState` enforces (L9). When we hold group state, use it; the
 * server roster is only a fallback for rows we have no crypto state for.
 */
export function resolveRosterOverwrite(args: {
  hasPending:           boolean;
  existingParticipants: string[] | undefined;
  serverParticipants:   string[];
  cryptoMembers?:       string[];
}): {skip: boolean; participants: string[]} {
  if (args.hasPending) {
    if (!args.existingParticipants) {return {skip: true, participants: args.serverParticipants}; }
    return {skip: false, participants: args.existingParticipants};
  }
  if (args.cryptoMembers && args.cryptoMembers.length > 0) {
    return {skip: false, participants: args.cryptoMembers};
  }
  return {skip: false, participants: args.serverParticipants};
}

/** Test-only — clear the in-memory cache so a fresh load re-reads storage. */
export function _resetPendingRosterIntentsForTests(): void {
  cached = null;
  cachedOwner = null;
  inFlight = null;
}
