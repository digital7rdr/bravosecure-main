/**
 * Pure decision helpers for the messaging receive/send paths, extracted
 * so they're unit-testable without standing up the full production
 * runtime (transport, libsignal, SQLCipher, keys). The runtime is a thin
 * caller; all the branching that produced the audited bugs lives here.
 *
 * No React / react-native / store imports — callers pass plain state.
 */

import {sha256} from '@noble/hashes/sha2.js';
import {isDirectPrefixed} from '../conversationIds';

export interface SessionAddressLike {
  userId:   string;
  deviceId: number;
}

interface ConversationLike {
  type?:         string;
  participants?: string[];
}

export interface MessagingStateLike {
  conversations: Record<string, ConversationLike | undefined>;
  groups:        Record<string, unknown | undefined>;
}

/**
 * Group detection — THE single rule for message topology. `sendText`,
 * reactions and read-receipt acceptance all call this; do not re-inline a
 * copy (the inline copy in productionRuntime drifted and caused B-124/B-125).
 *
 * A direct conversation stores both participants ([self, peer]), so the legacy
 * `participants.length > 1` fallback must be gated behind `type !== 'direct'`
 * or every 1:1 would mis-route into the group path.
 *
 * B-124/B-125 — the same veto is required on the GroupState clause. Holding
 * group key material at an id is a CRYPTO fact, not a conversation type:
 * escalating a 1:1 call files a throwaway `'Call'` GroupState under the real
 * 1:1 id, which reclassified that chat as a group forever (duplicate thread,
 * then a send that threw above the optimistic append and destroyed the typed
 * text). The clause stays live for untyped/absent rows so a group whose
 * admin-create landed before /conversations/mine still classifies correctly.
 *
 * NOTE: `launchCall.shouldRouteCallViaSfu` is a DIFFERENT rule (SFU vs 1:1 call
 * routing, thresholded on >= 2 other members) — a 2-person group routes as a
 * 1:1 CALL while still being a GROUP for message fan-out. It used to share this
 * name; renamed so the two can never be confused at an import site.
 */
export function isGroupConversation(
  state: MessagingStateLike,
  conversationId: string,
): boolean {
  // B-124/B-125 residual — a `direct:`-shaped id is never a group, whatever the
  // rows say. The `type !== 'direct'` veto below is vacuously TRUE when no
  // conversation row exists yet (cold contact, notification tap), so a stray
  // call-key at that id still won. The id SHAPE is the only signal that is
  // always present. This also makes a send-time stamp veto unnecessary: the
  // group branch can no longer be entered with a direct-shaped id, so no
  // half-state (group-encrypted body + suppressed stamp) can be constructed.
  if (isDeviceLocalGroupId(conversationId)) {return false;}
  const convo = state.conversations[conversationId];
  // B-124/B-125 — key-material presence must never overrule an explicit
  // `type: 'direct'` row, and a 'Call'-named state is a transient call-key
  // carrier (1:1→group call escalation aliases one under the real 1:1
  // conversation id), never a chat. Mirrors sendText's seam exactly.
  const gs = state.groups[conversationId] as {name?: string} | undefined;
  const groupStateCounts = !!gs && convo?.type !== 'direct' && !isCallGroupState(gs);
  return (
    convo?.type === 'group' ||
    convo?.type === 'ops_channel' ||
    groupStateCounts ||
    (convo?.type !== 'direct' && (convo?.participants?.length ?? 0) > 1)
  );
}

/**
 * B-124 — is this id a DEVICE-LOCAL slot rather than a real, cross-device
 * group id?
 *
 * A legitimate group id is either a `deriveGroupId` output (32 hex, salt+members
 * hash) or a server UUID from the assigned-group path. Nothing legitimate is
 * `direct:`-prefixed — that prefix names a 1:1 slot, and it means a DIFFERENT
 * person on every device. Call escalation files ad-hoc key aliases at such ids,
 * and those ids then travel on the wire, so a peer's stamp can name a local slot
 * that belongs to someone else entirely.
 *
 * Consumers must IMPORT this rather than re-inlining `startsWith('direct:')` —
 * that duplication is what produced B-124 in the first place.
 *
 * Scope note: this is for the TEXT / placeholder / row-creating consumers only.
 * It must NOT be used to reject an admin `create`: the ad-hoc call key
 * legitimately travels as a create whose `state.groupId` IS a device-local alias
 * (the BS-CALL-KEY-RESYNC broadcast), and rejecting it makes every re-escalated
 * call fail at the joiner's key gate.
 */
export function isDeviceLocalGroupId(conversationId: string): boolean {
  return isDirectPrefixed(conversationId);
}

/**
 * AUDIT-2026-08-13 #9 (M4-lite) — is this group state / name the ad-hoc
 * CALL-KEY carrier rather than a real chat group?
 *
 * Call escalation mints a transient `GroupState` whose only wire-visible
 * discriminator is `name === 'Call'` (the receiver of the create/
 * BS-CALL-KEY-RESYNC broadcast has NOTHING else to classify by — a
 * dedicated wire field is the arch-gated M4 remainder, runbook §10.1).
 * That sentinel was re-inlined at 15 comparison sites across 9 files —
 * the duplicate-copy class that produced B-124. This is now the ONE
 * spelling; consumers must IMPORT it, and the brandedIdSeams scan bans
 * the inline comparison.
 *
 * KNOWN LIMIT (document, don't guess around it): a REAL group a user
 * literally names "Call" with a server-uuid id is classified as a call
 * carrier by name alone. Every site had this bug individually before;
 * centralising doesn't fix it — only the wire field can. Sites that can
 * compound with a structural signal (id shape, custom-name flag) should
 * keep doing so.
 */
export const CALL_GROUP_NAME = 'Call';
export function isCallGroupName(name: string | null | undefined): boolean {
  return name === CALL_GROUP_NAME;
}
// Generic TYPE PREDICATE (critic N1): a plain boolean return cannot
// narrow, so `isCallGroupState(x) && x.field` needed a `?.` that turned
// a compile-time guarantee into a silent undefined if the conjuncts are
// ever reordered. `gs is T` re-couples them at every call site.
export function isCallGroupState<T extends {name?: string | null}>(gs: T | null | undefined): gs is T {
  return isCallGroupName(gs?.name);
}

/**
 * BS-RX1 — recipient set for a reaction. For a group, every member
 * except self (server-authoritative list); for a direct chat, just the
 * passed peer. Empty-group falls back to [peer] so a reaction still
 * lands before /conversations/mine sync resolves membership.
 */
export function reactionRecipients(
  state: MessagingStateLike,
  conversationId: string,
  ownUserId: string,
  peer: SessionAddressLike,
): SessionAddressLike[] {
  if (!isGroupConversation(state, conversationId)) {return [peer];}
  const convo = state.conversations[conversationId];
  const members = (convo?.participants ?? [])
    .filter(uid => uid && uid !== ownUserId)
    .map(uid => ({userId: uid, deviceId: 1}));
  return members.length > 0 ? members : [peer];
}

/**
 * SYNC-6 — opaque scope token for a typing frame. Bound to the SORTED
 * {sender, recipient} pair, so the same group produces a different tag
 * for every recipient: the relay forwards it but cannot cluster it into
 * a membership set. 1:1 chats use the fixed `DIRECT_CONVERSATION_KEY`
 * because the two endpoints key the same thread by different ids
 * (`direct:<peer>` vs a server UUID).
 */
export const DIRECT_CONVERSATION_KEY = 'direct';
const TYPING_TAG_DOMAIN = 'BRAVO_TYPING_TAG_V1';

export function typingConversationTag(
  conversationKey: string,
  userIdA: string,
  userIdB: string,
): string {
  const pair = [userIdA, userIdB].sort().join('|');
  const digest = sha256(
    new TextEncoder().encode(`${TYPING_TAG_DOMAIN}|${conversationKey}|${pair}`),
  );
  let hex = '';
  for (let i = 0; i < 8; i++) {
    hex += digest[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * BS-TY1 + SYNC-6 — the set of conversation ids a typing frame from
 * `senderUid` affects.
 *
 * With a `convTag` (SYNC-6 peers) exactly ONE thread is resolved: the
 * direct pair, or the single group whose tag matches. An unmatchable tag
 * resolves to nothing — dropping an ephemeral indicator beats painting
 * "typing…" in the wrong chat.
 *
 * Without a tag (legacy peer / ops-console) the historical fan-out is
 * preserved: synthetic + canonical direct ids and every group the sender
 * participates in.
 */
export function typingAffectedConversationIds(
  state: MessagingStateLike,
  senderUid: string,
  syntheticDirectId: string,
  canonicalDirectId: string,
  convTag?: string,
  ownUserId?: string,
): string[] {
  const directIds = [syntheticDirectId, canonicalDirectId];
  if (convTag && ownUserId) {
    if (convTag === typingConversationTag(DIRECT_CONVERSATION_KEY, ownUserId, senderUid)) {
      return Array.from(new Set(directIds));
    }
    for (const [convId, convo] of Object.entries(state.conversations)) {
      if (!(convo?.participants ?? []).includes(senderUid)) {continue;}
      if (typingConversationTag(convId, ownUserId, senderUid) === convTag) {
        return [convId];
      }
    }
    return [];
  }
  const out = new Set<string>(directIds);
  for (const [convId, convo] of Object.entries(state.conversations)) {
    if ((convo?.participants ?? []).includes(senderUid)) {out.add(convId);}
  }
  return Array.from(out);
}

/**
 * BS-TY2 — typing watchdog. A peer's `typing: start` with no trailing
 * `stop` (app backgrounded mid-type, dropped frame) would otherwise
 * leave the "typing…" bubble on forever. Arm a per-conversation timer on
 * every `start`; if no `stop` (or inbound message — cleared by the
 * caller) lands within the window, force the flag off. 8s comfortably
 * covers the client's own 6s typing-debounce re-emit cadence.
 *
 * Lives here (not inline in the runtime) so it can be driven with Jest
 * fake timers without importing the whole production runtime.
 */
export const TYPING_WATCHDOG_MS = 8000;

export class TypingWatchdog {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(private readonly windowMs: number = TYPING_WATCHDOG_MS) {}

  /** Arm (or re-arm) the timer for a conversation. `onExpire` fires once. */
  arm(conversationId: string, onExpire: () => void): void {
    this.clear(conversationId);
    const h = setTimeout(() => {
      this.timers.delete(conversationId);
      onExpire();
    }, this.windowMs);
    this.timers.set(conversationId, h);
  }

  /** Cancel the timer for a conversation (e.g. on `stop` or a message). */
  clear(conversationId: string): void {
    const existing = this.timers.get(conversationId);
    if (existing) {clearTimeout(existing); this.timers.delete(conversationId);}
  }

  /** True iff a timer is currently armed for the conversation. */
  isArmed(conversationId: string): boolean {
    return this.timers.has(conversationId);
  }
}

/**
 * BS-RR1 — should a read-receipt from `receipterUid` be allowed to flip
 * THIS message to `read`? Preserves the P0-E1 ownership guard (the
 * receipter must belong to the thread the message lives in):
 *   - direct chat: the receipter must equal the message's stored peer.
 *   - group chat:  every outbound row stores peer = participants[0], so
 *     matching the single peer only ever accepted the first member's
 *     receipt. Validate against the conversation's participant list
 *     instead — any member's read counts, but a non-member's is rejected.
 *
 * Caller still gates on envelope-id match, sender_id === 'self', and
 * not-already-read; this is purely the ownership predicate.
 */
export function readReceiptAccepted(args: {
  state:          MessagingStateLike;
  conversationId: string;
  receipterUid:   string;
  messagePeerUserId?: string;
}): boolean {
  const {state, conversationId, receipterUid, messagePeerUserId} = args;
  if (isGroupConversation(state, conversationId)) {
    const members = state.conversations[conversationId]?.participants ?? [];
    return members.includes(receipterUid);
  }
  return messagePeerUserId === receipterUid;
}

/**
 * GF-5 — a group send is blocked until this device holds the group
 * master key. Without the key the send path used to ship the inner
 * GroupMessageEnvelope UNWRAPPED, which the receive side already
 * classifies as a downgrade (`parseGroupMessage` → 'malformed', Audit
 * P0-G2) and which reaches only the single placeholder participant a
 * keyless member's row was seeded with. `masterKeyB64` is persisted as
 * `''` in the AsyncStorage vault (the real key lives in SQLCipher and is
 * rehydrated during runtime init, before `ready` flips), so an empty
 * string counts as absent.
 *
 * `forceGroup` mirrors sendText's `opts.isGroup` / the ChatScreen route
 * param for rows whose `type` has not synced yet.
 */
export function groupSendBlockedReason(
  state: MessagingStateLike,
  conversationId: string,
  forceGroup = false,
): 'group_key_missing' | null {
  if (!forceGroup && !isGroupConversation(state, conversationId)) {
    return null;
  }
  const group = state.groups[conversationId] as {masterKeyB64?: string} | undefined;
  return group?.masterKeyB64 ? null : 'group_key_missing';
}

export const GROUP_KEY_PENDING_SEND_ERROR =
  'Waiting for this group’s encryption key — the message will send once the key syncs.';

export function isGroupKeyPendingError(e: unknown): boolean {
  return e instanceof Error && e.message === GROUP_KEY_PENDING_SEND_ERROR;
}

/**
 * SYNC-1 — does a read-receipt from `receipterUid` reference THIS
 * message? Group fan-out mints one relay envelope id per recipient, so
 * the author must match against the id minted for that specific member.
 *
 * Strict when the per-recipient map exists: a member may only receipt the
 * envelope addressed to them (a tightening of the P0-E1 ownership guard,
 * never a relaxation). Rows written before the map existed, and every 1:1
 * row, fall back to the scalar so in-flight messages keep ticking.
 */
export function readReceiptEnvelopeMatch(args: {
  envelopeId?: string;
  envelopeIds?: Record<string, string>;
  receipterUid: string;
  ids: ReadonlySet<string>;
}): boolean {
  const {envelopeId, envelopeIds, receipterUid, ids} = args;
  const forReceipter = envelopeIds?.[receipterUid];
  if (forReceipter) {
    return ids.has(forReceipter);
  }
  if (envelopeIds && Object.keys(envelopeIds).length > 0) {
    return false;
  }
  return !!envelopeId && ids.has(envelopeId);
}
