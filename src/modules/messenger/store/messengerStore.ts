import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { persist } from 'zustand/middleware';
import { current as immerCurrent } from 'immer';
import { makeDebouncedJsonStorage } from '@store/debouncedJsonStorage';
import type { LocalConversation, LocalMessage, MessageStatus } from './types';
import type { GroupState } from '@bravo/messenger-core';
// Why: messagingLogic is dependency-free by design (no React/RN/store imports),
// so this static import cannot cycle back through the store. It is THE message
// topology rule — see MESSAGE_LOOP.md M2.
import { isGroupConversation, isCallGroupState, isCallGroupName } from '../runtime/messagingLogic';
import { isDirectPrefixed, peerFromDirectSlot } from '../conversationIds';
import {
  rememberDeletedConversation, suppressResurrection, isConversationTombstoned,
} from '../backup/conversationTombstones';
// B-703 MR-2 — dependency-free flag; the restore brackets EVERY hydrate with it.
import { isRestoreWriteThroughSuppressed } from '../backup/restoreWriteThrough';
import type { ConversationId, MessageId } from '../conversationIds';



// Audit fix #13 + B-633 — the debounced PersistStorage adapter (one stringify
// + one AsyncStorage write per quiet window; read path tick-for-tick like
// createJSONStorage) moved to @store/debouncedJsonStorage so activityStore
// (NAV-14, 2026-08-26 audit) could stop re-growing the per-set() stringify.
// Full history + the G4 hydration-timing and B-304 teardown notes live there.

const PERSIST_DEBOUNCE_MS = 500;

/**
 * Audit P1-N20 — stable comparator: created_at ascending, with `id`
 * as the tie-break for equal timestamps. Without the tie-break, two
 * rapid-fire sends on the same millisecond would flip order on every
 * sort (V8's sort is no longer stable in all paths once the array
 * crosses ~10 elements). `id` is a random suffix so the resulting
 * order isn't meaningful in time — it's just consistent.
 */
const byCreatedAtThenId = (a: LocalMessage, b: LocalMessage): number => {
  if (a.created_at !== b.created_at) {return a.created_at < b.created_at ? -1 : 1;}
  if (a.id === b.id) {return 0;}
  return a.id < b.id ? -1 : 1;
};

/**
 * OM-06 — true when `next` may take over a conversation's `last_message`
 * (preview + list ordering). A late-spliced OLDER row (a stashed no_key group
 * message draining with its real send-time, a replayed missed-call marker) must
 * not regress the preview or re-sort the thread by its old timestamp. Own sends
 * always win: they are composed now, and a peer with a skewed-future clock must
 * not be able to freeze our own preview. Unparseable timestamps fall through to
 * "accept" so a malformed row can never wedge the preview permanently.
 */
type LastMessageCandidate = Pick<LocalMessage, 'created_at' | 'sender_id'>;

const supersedesLastMessage = (cur: LastMessageCandidate | undefined, next: LastMessageCandidate): boolean => {
  if (!cur || next.sender_id === 'self') {return true;}
  const a = Date.parse(cur.created_at);
  const b = Date.parse(next.created_at);
  if (Number.isNaN(a) || Number.isNaN(b)) {return true;}
  return a <= b;
};

/**
 * In-memory Zustand store for the messenger UI. SQLCipher persistence
 * is wired in separately by the runtime layer — this store is the fast
 * read path for ChatScreen and MessengerHomeScreen. When the runtime
 * hydrates from disk at boot it replays into this store via setAll().
 */

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'unauthorized'
  // B-11 — this device was evicted by a newer session on the same
  // account (single-device takeover). Mirrors TransportState.
  | 'superseded';

/**
 * Warm-start FIX-05 — is the client still pulling what it missed?
 *
 * Deliberately NOT folded into ConnectionState: that union mirrors
 * TransportState in messenger-core, is shared with the ops-console, and is
 * pinned by transport tests. Catch-up is a different axis — a connected socket
 * can still be mid-drain, and that is exactly the state the UI could not see.
 *
 * Without this an empty thread and a thread whose 1000-envelope bootstrap page
 * is still draining render identically, and the notification-tap path has
 * nothing to await (it races a 6s timer instead).
 */
export type SyncState =
  | 'idle'      // nothing pulled yet this session
  | 'syncing'   // a relay drain is in flight
  | 'synced';   // the last drain settled

interface MessengerState {
  /** The OWNER KEY for this vault — `email ?? phone ?? user.id`, pinned per
   * install (MainNavigator). Used to detect user-switch at boot, to key
   * `vaultByOwner`, and to wipe stale data from the previous session.
   * NOT an identity: it is usually an email, so it never matches a
   * `participants` entry. */
  _ownUserId: string | null;
  /** The signed-in user's real auth UUID — the SAME id space as
   * `conversations[].participants`, `receipts` keys and `envelope_ids` keys.
   * Kept alongside `_ownUserId` because that one is an email for almost every
   * account, so filtering `participants` by it silently matched nothing and
   * left the author inside their own "everyone must read this" set — which is
   * why a group read receipt could never complete the blue tick. */
  _ownAuthUserId: string | null;
  conversations: Record<string, LocalConversation>;
  conversationOrder: string[];
  messages: Record<string, LocalMessage[]>;
  /**
   * B-712 — bumped by `hydrateMessages` INSIDE its own immer producer, so the
   * commit that carries bulk disk/backup replay is distinguishable from a live
   * arrival. The background notifier compares it against the previous state and
   * watermarks such a commit without bannering it.
   *
   * Why a per-commit COUNTER and not a "we are hydrating" boolean: zustand `set`
   * is synchronous, so a module-level flag is still true after the subscriber
   * returns and would swallow the next live append — which is exactly how the
   * B-710 hydration-hold attempt lost real messages and had to be reverted. A
   * counter that differs only on the hydration commit itself cannot leak onto the
   * commit after it.
   *
   * NOT persisted (the partialize whitelist omits it): a generation restored from
   * disk would make the first live commit of a session look like a hydration.
   */
  hydrationGeneration: number;
  /**
   * MI-06 — per-conversation composer drafts. A draft is message PLAINTEXT:
   * it is NEVER included in the AsyncStorage partialize whitelist; durable
   * copies live only in the SQLCipher `drafts` table via the draft sink
   * (hydrated at runtime boot).
   */
  drafts: Record<string, string>;
  /** currently foregrounded conversationId — used to suppress unread increments */
  activeConversationId: string | null;
  /** ephemeral typing indicators keyed by conversationId */
  typing: Record<string, boolean>;
  /**
   * B-117 — WHO is typing, per conversation (userId set). The boolean
   * `typing` above stays as the derived aggregate for legacy consumers;
   * both are session-scoped (never persisted).
   */
  typingUsers: Record<string, Record<string, true>>;
  /**
   * Presence per peer (populated in M11). The wire protocol carries four
   * states (`online | active | away | offline`); we preserve them all so
   * the UI can distinguish "active now" (interacting), "online" (just
   * connected), and "away" (idle / backgrounded). `online` is kept as a
   * derived boolean for back-compat with existing consumers — true for
   * `online | active | away`, false for `offline`.
   *
   * The `lastSeen` alias mirrors `lastSeenMs` so older readers keep
   * working without changes.
   */
  presence: Record<string, {
    state:       'online' | 'active' | 'away' | 'offline';
    online:      boolean;
    lastSeen?:   number;
    lastSeenMs?: number;
  }>;
  /** live transport state — drives the connection banner in chat headers */
  connection: ConnectionState;
  /** FIX-05 — relay catch-up phase, orthogonal to `connection`. */
  syncState: SyncState;
  ready: boolean;
  error: string | null;
  /**
   * Soft, non-fatal recovery banner — separate slot from `error` so a
   * transient identity-rotation hint ("rebuilding session …") doesn't
   * clobber a live red error banner (e.g. WS unauthorized) and vice
   * versa. Surfaces in the chat header next to / below the error
   * banner. Cleared by the runtime when the recovery completes.
   */
  recoveryBanner: string | null;
  /**
   * B-46 — count of envelopes this device DESTROYED because the outer
   * sealed wrap couldn't be opened (sealed to a previous identity:
   * reinstall / cleared data / failed restore). Sealed sender means the
   * sender is unknowable here, so no per-conversation placeholder is
   * possible — this counter drives the one-shot MessengerHome banner
   * ("N messages couldn't be decrypted — ask senders to resend").
   * Session-scoped (not persisted); cleared when the user dismisses.
   */
  undecryptableDropCount: number;
  /**
   * Per-group display-name overrides. Admin can rename a member's
   * shown name inside one group without affecting their profile or
   * other conversations: `{ [groupId]: { [userId]: displayName } }`.
   */
  groupMemberNames: Record<string, Record<string, string>>;
  /**
   * B-206 — department channel id → the group conversation id it currently maps
   * to. When an owner "reactivates" a keyless channel the group id is re-minted,
   * which orphans the whole message history under the old id. Persisting this
   * map lets any device detect the change (old id != new id for the same
   * channel) and migrate the history onto the new id — even across a restart,
   * because the old-id rows still hydrate from SQLite.
   */
  /** Every conversation ever known to be a department channel — additive,
   *  never pruned. Distinct from deptGroupByChannel, which is a POINTER that
   *  B-206 overwrites to migrate history; pruning that must not un-refuse a
   *  company file, so the vault refusal reads THIS. */
  deptConversationIds: Record<string, true>;
  /** vs2 edge A9 — conversationId -> the ORG that owns the channel. Additive and
   *  persisted like the set beside it; a dept-message push carries no org, so
   *  this is the only local answer to "which workspace is this thread in". */
  deptOrgByConversation: Record<string, string>;
  deptGroupByChannel: Record<string, string>;
  /**
   * B-115 — session-scoped directory display names (userId → registered
   * Bravo name from /users/profiles). LAST-RESORT source before a raw-id
   * fragment: custom names, address-book names, and manual group-member
   * overrides all win. Deliberately NOT vault-persisted — refetched per
   * session, so a stale rename can't stick.
   */
  directoryNames: Record<string, string>;
  /**
   * B-253 — session-scoped directory AVATARS (userId → profile photo URL).
   *
   * `/users/profiles` has always returned `avatarUrl` alongside
   * `displayName`, and the shared resolver has always thrown it away —
   * so every surface outside ChatInfoScreen (which kept its own private
   * copy of the same fetch) had no avatar source at all and rendered an
   * initials disc for users who DO have a photo.
   *
   * Same lifetime rules as `directoryNames`: not vault-persisted, refetched
   * per session, so a changed photo cannot stick.
   */
  directoryAvatars: Record<string, string>;
  /**
   * Per-group full state — membership, master key, epoch. Populated
   * from admin `create` / `add` / `remove` / `rekey` messages. The
   * masterKeyB64 field is the spec's "group master key shared via
   * pairwise Signal sessions" and is used to encrypt subsequent
   * group message bodies via AES-256-GCM. Persisted to the same
   * AsyncStorage as messages until SQLCipher message store lands.
   */
  groups: Record<string, GroupState>;
  /**
   * Per-user data vault. When the user switches accounts, the previous
   * owner's conversation list, conversation order, group state and
   * group-member-name overrides are saved here under their owner key
   * (email/phone) so re-login restores their thread list rather than
   * showing an empty inbox. Message bodies stay in SQLCipher (per-user
   * by `userId`-scoped DB filename); this vault holds only the lighter
   * AsyncStorage-resident slices.
   */
  vaultByOwner: Record<string, VaultSlice>;
}

interface VaultSlice {
  conversations:     Record<string, LocalConversation>;
  conversationOrder: string[];
  groups:            Record<string, GroupState>;
  groupMemberNames:  Record<string, Record<string, string>>;
  deptConversationIds: Record<string, true>;
  /** vs2 edge A9 — conversationId -> the ORG that owns the channel. Additive and
   *  persisted like the set beside it; a dept-message push carries no org, so
   *  this is the only local answer to "which workspace is this thread in". */
  deptOrgByConversation: Record<string, string>;
  deptGroupByChannel: Record<string, string>;
}

interface MessengerActions {
  upsertConversation: (c: LocalConversation) => void;
  /**
   * B-691/F3 — `skipUnreadClear` pins the active id WITHOUT the unread-zeroing
   * commit (ChatScreen defers that half until its open transition ends, so the
   * badge sweep stops re-rendering the list mid-slide). Every other caller
   * keeps the one-argument form, whose behaviour is unchanged.
   */
  setActiveConversation: (id: string | null, opts?: {skipUnreadClear?: boolean}) => void;
  /**
   * M12 — returns the EFFECTIVE message id, or null when the row was deduped /
   * rerouted and no bubble was added under `conversationId`.
   *
   * This is not cosmetic. On a content-divergent id collision the store stores
   * the row under `${id}#${n}`, so a caller that keeps its own `msgId` and
   * later calls `updateMessageStatus(conversationId, msgId, ...)` matches
   * NOTHING — silently. The bubble then sits in `sending` forever with no error
   * anywhere. Use the returned id for every follow-up status/envelope/media
   * patch.
   */
  appendMessage: (conversationId: string, msg: LocalMessage) => string | null;
  updateMessageStatus: (conversationId: ConversationId, messageId: MessageId, status: MessageStatus) => void;
  /** Flip many messages in one conversation in ONE store commit — the write-through subscriber diffs the whole store per commit, so per-message flips are O(N·M). */
  updateMessageStatusBulk: (conversationId: ConversationId, messageIds: readonly MessageId[], status: MessageStatus) => void;
  /**
   * B-116 — record a read receipt from `userId` on the given own-message
   * ids, then derive the scalar status: group rows flip to 'read' only
   * when every OTHER participant has read (WhatsApp); direct rows flip on
   * their single peer as before. One store commit for the whole batch.
   */
  recordReadReceipts: (conversationId: string, messageIds: readonly string[], userId: string, ts: number) => void;
  /**
   * B-187 — record a per-member DELIVERED receipt on one of our own group
   * messages, then derive the scalar: 'sent' → 'delivered' only when every
   * member of the required set (participants(non-self) ∩ shipped
   * envelope_ids keys — the exact recordReadReceipts rule) has
   * delivered|read. A member already at 'read' is never demoted.
   */
  recordDeliveredReceipt: (conversationId: string, messageId: string, userId: string, ts: number) => void;
  /**
   * B-683 — record one member's terminal destroy of their fan-out leg, and
   * flip the scalar to 'undelivered' ONLY when the failure is total: every
   * CURRENT participant has a shipped leg, that leg is dead, and none holds
   * a delivered/read receipt. Value-level idempotent (the 60s receipt poll
   * re-fires settled verdicts). The failure-side mirror of
   * recordDeliveredReceipt's B-187 all-legs aggregate.
   */
  recordUndeliverableLeg: (conversationId: string, messageId: string, userId: string, ts: number) => void;
  /**
   * B-683/F2 — atomic wire-artifact reset before a fresh-wire-id re-send:
   * clears scalar envelope_id/retract_token, both per-leg maps, and
   * undeliverable_legs, so round-2 accepts can seed the first-wins slots
   * and a late round-1 verdict matches nothing.
   */
  resetWireArtifactsForResend: (conversationId: string, messageId: string) => void;
  /**
   * MI-06 — set/clear the composer draft for a conversation. Whitespace-only
   * text clears. Writes through the SQLCipher draft sink when registered;
   * never touches AsyncStorage (a draft is message plaintext).
   */
  setDraft: (conversationId: string, text: string) => void;
  updateMessageCiphertext: (conversationId: string, messageId: string, ciphertext: LocalMessage['ciphertext']) => void;
  /**
   * Stash the relay's per-envelope retract capability token on the local message.
   * SYNC-1 — pass `recipientUserId` for a group fan-out leg: the scalar only ever
   * keeps the FIRST leg's token (matching `updateMessageEnvelopeId`'s first-wins
   * rule) so the HTTP receipt-poll fallback probes a token that actually pairs
   * with the scalar `envelope_id` it also stashed from that same first leg.
   */
  updateMessageRetractToken: (conversationId: string, messageId: string, token: string, recipientUserId?: string) => void;
  /**
   * Backfill the relay's envelope id on an outbound message after accept.
   * SYNC-1 — pass `recipientUserId` for group fan-out legs: the id is
   * recorded in the per-recipient map (so every member's read receipt can
   * be matched) and the scalar is only seeded, never overwritten.
   */
  updateMessageEnvelopeId: (
    conversationId: string,
    messageId: string,
    envelopeId: string,
    recipientUserId?: string,
  ) => void;
  removeMessage: (conversationId: string, messageId: string) => void;
  /** Drop every message in a conversation but keep the conversation row + name. */
  clearMessages: (conversationId: string) => void;
  updateMessageReactions: (conversationId: string, messageId: string, reactions: Record<string, string>) => void;
  /**
   * Replace the body of an already-sent message and stamp `edited_at`.
   *
   * Authorisation is NOT decided here. This is the applier; the decision lives
   * in runtime/messageMutationGate.ts and callers must gate first.
   *
   * Returns void, like `updateMessageReactions`: an immer draft does not
   * survive the `set()` that produced it, so the M9 "persist the row the store
   * COMMITTED" rule is served by reading the row back afterwards. That
   * read-back lives in runtime/messageMutationApply.ts — do not try to return
   * the draft from here.
   */
  applyMessageEdit: (
    conversationId: string,
    messageId: string,
    body: string,
    editedAt: number,
    mentions?: LocalMessage['mentions'],
  ) => void;
  /**
   * Turn a message into a "deleted for everyone" tombstone: strip the body,
   * the media handles, the reactions and the quote, keep the row.
   *
   * The row is KEPT deliberately. Removing it would break every reply that
   * quotes it and would make the surrounding run-grouping jump; WhatsApp keeps
   * a tombstone for the same reason. Same read-back contract as above.
   */
  applyDeleteForEveryone: (conversationId: string, messageId: string) => void;
  /**
   * P2-12 — stamp the encrypted-attachment metadata onto an already-appended
   * bubble AFTER the upload completes. `sendMedia` appends an optimistic
   * bubble before the upload (so an upload failure has a durable failed
   * bubble), then patches the object key / per-file key+iv here so the row
   * mirrored to SQLCipher can be re-rendered/forwarded post-restore.
   */
  patchMessageMedia: (
    conversationId: string,
    messageId: string,
    fields: Partial<Pick<LocalMessage,
      'type' | 'media_mime' | 'media_object_key' | 'media_key' | 'media_iv' | 'media_meta'>>,
  ) => void;
  /** Toggle per-conversation mute — suppresses push + unread badge bumps. */
  setConversationMuted: (conversationId: string, muted: boolean) => void;
  /** Pin/unpin a conversation so it floats to the top of the list. */
  setConversationPinned: (conversationId: string, pinned: boolean) => void;
  /** Remove a conversation from the local list (does not delete history on peer). */
  removeConversation: (conversationId: string) => void;
  setTyping: (conversationId: string, typing: boolean) => void;
  /** B-117 — per-user typing state; also maintains the legacy boolean aggregate. */
  setTypingUser: (conversationId: string, userId: string, typing: boolean) => void;
  /** Set or clear an admin-assigned display name for a member inside one group. */
  setGroupMemberName: (groupId: string, userId: string, name: string | null) => void;
  /** B-206 — the group id a channel last mapped to, or null if never seen.
   *  A caller compares it to the freshly-resolved id to detect an owner
   *  re-provision (peek only — does NOT record; call setDeptChannelGroup after
   *  the history migration succeeds so an interrupted migration retries). */
  deptChannelGroup: (channelId: string) => string | null;
  /** B-206 — record a channel's current group id (after any needed migration). */
  setDeptChannelGroup: (channelId: string, groupId: string) => void;
  /** Phase 4 — record a conversation as departmental, additively. */
  /** vs2 edge A9 — `orgId` optional: additive, and never cleared by a caller
   *  that happens not to know it. */
  rememberDeptConversation: (conversationId: string, orgId?: string | null) => void;
  /** B-206 — fold the message history + last_message + unread from an orphaned
   *  old group id into the new one (mirrors the B-18 synthetic→canonical fold). */
  migrateConversationMessages: (oldId: string, newId: string) => void;
  /** B-115 — merge directory display names (userId → name). Empty names ignored. */
  setDirectoryNames: (entries: Record<string, string>) => void;
  /** B-253 — merge resolved profile photos (userId -> url). */
  setDirectoryAvatars: (entries: Record<string, string | null>) => void;
  /** Set the conversation-level default disappearing-message TTL. */
  setConversationTtl: (conversationId: string, ttlSec: number | null) => void;
  /**
   * Update presence for a peer. Accepts the full server state — callers
   * that only know `online: bool` can pass `'online'` or `'offline'`.
   * Both `online` (boolean) and `lastSeen` are derived/aliased for
   * back-compat with consumers that haven't migrated to `state`.
   */
  setPresence: (
    userId: string,
    state: 'online' | 'active' | 'away' | 'offline',
    lastSeenMs?: number,
  ) => void;
  /**
   * Mark a list of peers offline without touching their `lastSeen`.
   * Used when the runtime stops receiving presence frames for a peer
   * (unsubscribe, socket reconnect): keeping the last-known `online`
   * value would pin a phantom green dot forever. We flip to `offline`
   * rather than deleting so consumers reading `presence[uid].state`
   * never see `undefined`.
   */
  clearPresence: (userIds: string[]) => void;
  /**
   * Wipe the entire presence map. Used on logout/owner-switch, where
   * any cached presence belongs to the previous user. Distinct from
   * `clearPresence` so reconnect paths can't accidentally nuke peers
   * we still want to track.
   */
  clearAllPresence: () => void;
  setConnection: (state: ConnectionState) => void;
  /** FIX-05 — published by the ONE drain coalescer, never per trigger site. */
  setSyncState: (state: SyncState) => void;
  setReady: (ready: boolean) => void;
  setError: (error: string | null) => void;
  /** Soft recovery banner — see `recoveryBanner` on state. Pass null to clear. */
  setRecoveryBanner: (msg: string | null) => void;
  /**
   * B-46 — record one destroyed (undecryptable-outer) envelope. Deduped
   * by envelopeId so a WS-deliver / drain race on the same envelope
   * can't double-count.
   */
  noteUndecryptableDrop: (envelopeId: string) => void;
  /** B-46 — user dismissed the banner. */
  clearUndecryptableDrops: () => void;
  reset: () => void;
  /** Called by configureMessengerRuntime — clears stale data if a different user logs in. */
  setOwner: (userId: string, authUserId?: string) => void;
  /** Replace a group's full state (used on admin create + rekey). */
  setGroupState: (state: GroupState) => void;
  /** Drop a group entirely (member removed themselves, etc.). */
  removeGroupState: (groupId: string) => void;
  /**
   * Bulk replace the in-memory messages map. Used at runtime boot
   * after hydrating from SQLCipher so the UI paints with full
   * persisted history rather than the AsyncStorage-cached subset.
   *
   * Audit fix #16 — capped at MAX_HYDRATE_PER_CONVO most-recent
   * messages per conversation so a chat with 50 000 historical
   * messages doesn't lock the UI thread on boot serializing them all
   * into immer drafts. The runtime exposes `loadOlderMessages` for
   * the pagination path.
   *
   * Restore-after-reinstall fix: `bypassCap=true` keeps the FULL set
   * in memory. The boot-time cap is a UI-thread protection that's
   * load-bearing on cold start, but during restore the user is on a
   * progress screen and explicitly waiting — silently truncating to
   * 200 most-recent per conversation made restored chats look like
   * they only kept the tail. Restore now hydrates everything; the
   * next cold boot re-applies the cap from SQLCipher (loadRecent),
   * and the chat's scroll-back path pages older history on demand.
   */
  hydrateMessages: (map: Record<string, LocalMessage[]>, bypassCap?: boolean) => void;
  /**
   * Audit fix #16 — prepend a page of older messages to a conversation.
   * Used by the chat scroll-back path. Caller is responsible for
   * fetching `before`-bounded rows from sqlMessageStore.
   */
  prependOlderMessages: (conversationId: string, older: LocalMessage[]) => void;
}

/**
 * Audit fix #16 — at-rest cap for `hydrateMessages`. Loading every
 * persisted message at boot is fine for a few hundred rows but starts
 * to hurt visibly at ~5k messages per chat. 200 most-recent matches
 * what the user actually scrolls through on resume; older history
 * pages in via `loadOlderMessages` only if the user scrolls up.
 */
export const MAX_HYDRATE_PER_CONVO = 200;

/**
 * Audit fix #30 — wired hook into the backup mirror's dedup cache.
 *
 * Every store action that mutates an existing message (status flip,
 * reactions, retract token, removal) calls notifyBackupDirty so the
 * mirror's `markDirty(owner, msgId)` runs on the next tick. Lazy
 * import avoids a circular dep between store ↔ backup. The mirror
 * pulls the live `_ownUserId` itself; we just nudge it with the
 * messageId.
 */
function notifyBackupDirty(messageId: string, conversationId?: string): void {
  try {
    const owner = useMessengerStore.getState()._ownUserId;
    if (!owner) {return;}
    const {markDirty} = require('../backup/messageMirror') as
      typeof import('../backup/messageMirror');
    // B-632 — pass the conversation every caller already knows. Without it
    // markDirty scanned EVERY hydrated conversation's message array to locate
    // one id, per mutation; recordReadReceipts alone fires this once per row
    // it marks.
    markDirty(owner, messageId, conversationId);
  } catch { /* mirror not loaded — safe no-op */ }
}

/**
 * B-634 — fire the nudges an action collected, AFTER its immer commit.
 *
 * Inside a recipe `getState()` still returns the PRE-commit snapshot, so a
 * nudge fired there made `markDirty` find the row as it looked BEFORE the very
 * mutation it was reporting, mirror THAT, and stamp the dedup with the stale
 * version — one wasted encrypt + upload per mutation, re-shipping unchanged
 * plaintext under a fresh AES-GCM IV (the server-byte churn BACKUP_LOOP I1
 * exists to prevent). `notifyBackupRemoved` already carried this lesson in a
 * comment; the dirty nudge never got it.
 *
 * Recipes run synchronously, so by the time this is reached the array is
 * populated and the store holds committed truth. Collecting ids rather than
 * notifying unconditionally after `set` preserves each action's own guards —
 * a recipe that bailed early nudges nothing, exactly as before.
 */
function flushBackupDirty(messageIds: readonly string[], conversationId: string): void {
  for (const id of messageIds) {notifyBackupDirty(id, conversationId);}
}

/**
 * H-3 — explicit removal notification. Unlike notifyBackupDirty, this
 * carries the removed row's real conversation_id + created_at so the
 * mirror ships a well-formed tombstone (status='deleted'). It MUST be
 * called AFTER the immer commit — calling it inside the recipe made
 * markDirty read the pre-commit state, find the still-present row, and
 * re-mirror it as a LIVE message, so the tombstone was never sent and
 * restores resurrected "deleted for everyone" messages.
 */
function notifyBackupRemoved(messageId: string, conversationId: string, createdAt: string): void {
  try {
    const owner = useMessengerStore.getState()._ownUserId;
    if (!owner) {return;}
    const {mirrorRemoval} = require('../backup/messageMirror') as
      typeof import('../backup/messageMirror');
    mirrorRemoval(owner, {id: messageId, conversation_id: conversationId, created_at: createdAt});
  } catch { /* mirror not loaded — safe no-op */ }
}

/**
 * B-594 fresh-install restore — mirror a CONVERSATION delete so the intent
 * survives a reinstall (the local tombstone in AsyncStorage does not). Ships
 * the last-known row with `deleted:true`; a later LIVE mirror (re-add / server
 * re-list) sends `deleted:false` and clears it. Same shape as the H-3 message
 * removal, and MUST run AFTER the immer commit (so the row is captured, not
 * re-mirrored live). Best-effort — the local tombstone already suppresses this
 * session; ids/flags only, never used to carry plaintext.
 */
function notifyBackupConversationDeleted(conv: LocalConversation): void {
  try {
    const owner = useMessengerStore.getState()._ownUserId;
    if (!owner) {return;}
    const {mirrorConversation} = require('../backup/messageMirror') as
      typeof import('../backup/messageMirror');
    mirrorConversation(owner, conv, undefined, {deleted: true});
  } catch { /* mirror not loaded — safe no-op */ }
}

/**
 * XO-4 — outbound delivery progress is monotonic. A late outbox drain
 * (a group sibling row that only reaches its peer hours later) and a
 * duplicated `envelope.accepted` both re-assert 'sent' on a bubble the
 * recipient has already delivered/read, and the write-through
 * subscriber then persists the downgrade — so the tick never recovers.
 *
 * Only the forward ladder is ranked. 'failed'/'undelivered' stay
 * off-ladder: they are terminal signals gated at their own call sites,
 * and a retry legitimately re-enters the ladder at 'sending' from one
 * of them (ChatScreen retrySend).
 */
const STATUS_RANK: Partial<Record<MessageStatus, number>> = {
  sending: 1, sent: 2, delivered: 3, read: 4,
};

// MERGE: my B-134 shared placeholder minter, restored. The merged appendMessage
// keeps THEIR inline materialisation (it carries their OM-06 fix), but
// callDispatcher still needs this helper — the `Bravo · ` prefix is what
// useRegisteredNames treats as backfillable.
export function directPlaceholderConversation(
  conversationId: string,
  peerId: string,
  peer: LocalConversation['peer'],
  createdAt: string,
): LocalConversation {
  return {
    id:            conversationId,
    type:          'direct',
    name:          `Bravo · ${peerId.slice(0, 8)}`,
    name_source:   'placeholder',
    participants:  [peerId],
    peer,
    session_state: 'established',
    unread_count:  0,
    is_muted:      false,
    created_at:    createdAt,
  } as LocalConversation;
}

/**
 * B-703 MR-12 — the store-write MISS warn, BOUNDED.
 *
 * W14 asked for this warn because a silent miss is what makes the false-retry
 * class undebuggable. But a miss is not always a bug: reactions, edits and
 * delete-for-everyone deliberately register a `messageId` that is a synthetic
 * wire id with NO bubble row (`productionRuntime`'s own comment calls the
 * resulting status writes "harmless no-ops"), and every accepted control
 * envelope produces two misses PER RECIPIENT LEG — one reaction in a 20-member
 * channel is ~38 lines. `console.warn` survives release builds (the release
 * strip only removes `log`), and these logs are the founder's device-debugging
 * surface, so an unbounded warn would drown the very signal it exists to give.
 *
 * A cap keeps the diagnosis (the FIRST misses on a device are the informative
 * ones) and cannot spam. Marking control envelopes explicitly at their send
 * sites is the precise fix and is recorded as MR-12b for when that path is next
 * touched.
 */
const MAX_STORE_MISS_WARNS = 20;
let storeMissWarns = 0;
function warnStoreMiss(line: string): void {
  if (storeMissWarns > MAX_STORE_MISS_WARNS) {return;}
  storeMissWarns += 1;
  if (storeMissWarns > MAX_STORE_MISS_WARNS) {
    console.warn('[messenger.store] further write-MISS lines suppressed for this process (B-703 MR-12)');
    return;
  }
  console.warn(line);
}

/** Test hook — the cap is process-scoped. */
export function _resetStoreMissWarnsForTests(): void {
  storeMissWarns = 0;
}

export function isStatusRegression(current: MessageStatus, next: MessageStatus): boolean {
  const a = STATUS_RANK[current];
  const b = STATUS_RANK[next];
  return a !== undefined && b !== undefined && b < a;
}

/**
 * Audit P0-S3 / P0-S5 — pluggable sink for the on-disk wrapped
 * group-key store. The runtime registers the SQLCipher-backed
 * GroupMasterKeyStore at boot; the messenger store calls it from
 * `setGroupState` / `removeGroupState` so the wrapped row stays in
 * sync with the in-memory `s.groups[gid].masterKeyB64`.
 *
 * The sink is module-scoped (not in Zustand state) because:
 *   - Zustand state should hold serializable data only; a SQLCipher
 *     handle and an imported WebCrypto key are neither.
 *   - We want the AsyncStorage partialize to remain dumb — it strips
 *     masterKeyB64 unconditionally, regardless of whether the sink
 *     is wired yet (loopback dev mode skips the sink, and that's fine
 *     because there's no SQLCipher to write to anyway).
 *
 * Registration is idempotent + replaceable. The runtime wires it
 * inside buildProductionRuntime; on logout, `clearGroupMasterKeySink`
 * removes it so a stray late mutation doesn't write under the
 * previous user's wrap key.
 */
interface GroupMasterKeySink {
  setKey(groupId: string, masterKeyB64: string): Promise<void>;
  deleteKey(groupId: string): Promise<void>;
}
let groupMasterKeySink: GroupMasterKeySink | null = null;
export function registerGroupMasterKeySink(sink: GroupMasterKeySink): void {
  groupMasterKeySink = sink;
}
export function clearGroupMasterKeySink(): void {
  groupMasterKeySink = null;
}

/**
 * MI-06 — durable draft writer, same module-scoped-sink pattern as
 * GroupMasterKeySink (and for the same reason: the durable copy lives in
 * SQLCipher, which Zustand state must not hold a handle to). The runtime
 * registers the SQLCipher-backed writer at boot and clears it on dispose;
 * with no sink registered drafts are session-only (loopback dev mode).
 */
interface DraftSink {
  set(conversationId: string, content: string): Promise<void>;
}
let draftSink: DraftSink | null = null;
export function registerDraftSink(sink: DraftSink | null): void {
  draftSink = sink;
}

/**
 * AUDIT-2026-08-13 #13 — a SYNCHRONOUS suppression bracket for the
 * write-through subscriber. Zustand fires subscribers synchronously on
 * the mutator's stack, so a sync depth flag wrapped around a store
 * mutation is a PRECISE "this delta came from me" signal — unlike any
 * module-state check (`isInsideRatchetTxn` is true across the txn's
 * AWAIT windows, where an interleaved user send would have been
 * wrongly suppressed and lost on restart). Used ONLY by the receive
 * txn's row-append sites, whose rows the txn persists explicitly.
 *
 * SYNCHRONOUS mutators only (critic): the depth decrements in `finally`,
 * so an async fn would release the bracket at its FIRST await and
 * suppress nothing. Failure direction is fail-open (the write-through
 * fires and the row persists) — safe, but not what you meant.
 */
let writeThroughSuppressDepth = 0;
export function runWriteThroughSuppressed<T>(fn: () => T): T {
  writeThroughSuppressDepth += 1;
  try {
    return fn();
  } finally {
    writeThroughSuppressDepth -= 1;
  }
}
export function isWriteThroughSuppressedNow(): boolean {
  return writeThroughSuppressDepth > 0;
}

const initialState: MessengerState = {
  _ownUserId: null,
  _ownAuthUserId: null,
  conversations: {},
  conversationOrder: [],
  messages: {},
  hydrationGeneration: 0, // B-712
  drafts: {},
  activeConversationId: null,
  typing: {},
  typingUsers: {},
  presence: {},
  connection: 'disconnected',
  syncState: 'idle',
  ready: false,
  error: null,
  recoveryBanner: null,
  undecryptableDropCount: 0,
  groupMemberNames: {},
  deptGroupByChannel: {},
  deptConversationIds: {},
  deptOrgByConversation: {},
  directoryNames: {},
  directoryAvatars: {},
  groups: {},
  vaultByOwner: {},
};

// B-46 — envelopeIds already counted toward `undecryptableDropCount`,
// so a WS-deliver / HTTP-drain race on the same envelope is one drop.
// Module-level (not in immer state): it's a dedup guard, not UI data.
const countedUndecryptableDrops = new Set<string>();
const COUNTED_DROPS_CAP = 512;

export const useMessengerStore = create<MessengerState & MessengerActions>()(
  persist(
    immer(set => ({
    ...initialState,

    upsertConversation: c =>
      set(s => {
        const prev = s.conversations[c.id];
        const existed = !!prev;
        // B-247 — this is a REPLACE, not a merge, so a later upsert that does
        // not carry rosterUserIds (the roster sync, a message-driven upsert)
        // would silently wipe it and the ring fan-out would fall back to
        // crypto membership again. Sticky: only an upsert that actually knows
        // the true roster may change it.
        // B-411 — name_source is sticky the same way: a flagless upsert keeps
        // the previous flag ONLY when the name is unchanged; a flagless
        // rename clears it (unknown provenance must not inherit a tag).
        const nameSource = c.name_source
          ?? (prev && c.name === prev.name ? prev.name_source : undefined);
        const next = c.rosterUserIds || !prev?.rosterUserIds
          ? c
          : {...c, rosterUserIds: prev.rosterUserIds};
        s.conversations[c.id] = nameSource === next.name_source
          ? next
          : {...next, name_source: nameSource};
        if (!existed) {s.conversationOrder.unshift(c.id);}

        // B-18 — when /conversations/mine syncs a server-UUID direct row
        // for a peer that already has a synthetic `direct:<peer>` row,
        // MERGE the synthetic slot into this canonical one. Why: the
        // inbound-append reroute (see appendMessage) only catches NEW
        // messages once the UUID row exists; history that accumulated in
        // the synthetic slot BEFORE the sync would otherwise strand there,
        // leaving the home list with two rows for one peer — the stale
        // synthetic one showing "(encrypted)" — and split-braining the
        // thread until the next append. Fold the messages + last_message +
        // unread into the UUID row and drop the synthetic row so there is
        // exactly one canonical 1:1 thread per peer.
        const peerUid = c.type === 'direct' ? c.peer?.userId : undefined;
        if (peerUid && !c.id.startsWith('direct:')) {
          const synthId = `direct:${peerUid}`;
          if (synthId !== c.id && s.conversations[synthId]) {
            const synthMsgs = s.messages[synthId] ?? [];
            if (synthMsgs.length) {
              if (!s.messages[c.id]) {s.messages[c.id] = [];}
              const dest = s.messages[c.id];
              const seenId  = new Set(dest.map(m => m.id));
              const seenEnv = new Set(dest.map(m => m.envelope_id).filter(Boolean));
              for (const m of synthMsgs) {
                if (seenId.has(m.id)) {continue;}
                if (m.envelope_id && seenEnv.has(m.envelope_id)) {continue;}
                dest.push({...m, conversation_id: c.id});
              }
              dest.sort((a, b) =>
                a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0,
              );
              const last = dest[dest.length - 1];
              const dst = s.conversations[c.id];
              if (last && (!dst.last_message || dst.last_message.created_at <= last.created_at)) {
                dst.last_message = last;
              }
            }
            const synthConvo = s.conversations[synthId];
            if (synthConvo && s.activeConversationId !== c.id) {
              s.conversations[c.id].unread_count =
                (s.conversations[c.id].unread_count ?? 0) + (synthConvo.unread_count ?? 0);
            }
            // B-411 — the synthetic row can hold higher-precedence identity
            // than the sync-minted UUID row (address-book label 'contact',
            // user rename 'custom', a discovered phone). Dropping it would
            // re-tag a SAVED friend "· Unsaved" until the next discovery
            // sweep — the fail-safe violation (edge-case review #4). Fold
            // those fields into the canonical row along with the messages.
            if (synthConvo) {
              const dst2 = s.conversations[c.id];
              const synthWins = synthConvo.is_custom_name
                || synthConvo.name_source === 'custom'
                || synthConvo.name_source === 'contact';
              if (synthWins && !dst2.is_custom_name && dst2.name_source !== 'custom') {
                dst2.name = synthConvo.name;
                dst2.name_source = synthConvo.name_source;
                if (synthConvo.is_custom_name) {dst2.is_custom_name = true;}
              }
              if (!dst2.phoneE164 && synthConvo.phoneE164) {dst2.phoneE164 = synthConvo.phoneE164;}
            }
            delete s.messages[synthId];
            delete s.conversations[synthId];
            const oi = s.conversationOrder.indexOf(synthId);
            if (oi >= 0) {s.conversationOrder.splice(oi, 1);}
          }
        }
      }),

    setActiveConversation: (id, opts) =>
      set(s => {
        s.activeConversationId = id;
        if (!id || opts?.skipUnreadClear) {return;}
        const active = s.conversations[id];
        if (active) {active.unread_count = 0;}
        // L20 — a 1:1 thread can transiently exist under two slots for the
        // same peer: the synthetic `direct:<peer>` row (push-tap / incoming
        // -call deep link) and the canonical server-UUID row. Opening either
        // must clear the badge on BOTH, otherwise the home list keeps an
        // unread count on the sibling slot the user didn't tap. Resolve the
        // peer and zero every direct slot that maps to it.
        const peerUid =
          active?.type === 'direct'
            ? active.peer?.userId
            : isDirectPrefixed(id)
              ? peerFromDirectSlot(id)
              : undefined;
        if (!peerUid) {return;}
        const synthId = `direct:${peerUid}`;
        if (s.conversations[synthId]) {s.conversations[synthId].unread_count = 0;}
        for (const cid of Object.keys(s.conversations)) {
          const c = s.conversations[cid];
          if (c?.type === 'direct' && c.peer?.userId === peerUid) {c.unread_count = 0;}
        }
      }),

    appendMessage: (conversationId, msg) => {
      // M12 — `set` returns void, so capture the effective id in a closure.
      // Zustand's set is synchronous, so this is populated by the time we return.
      let effectiveId: string | null = null;
      set(s => {
        if (!s.messages[conversationId]) {s.messages[conversationId] = [];}
        // Audit P0-T4 — dedup by both `id` AND `envelope_id`. The
        // crypto-layer `seenEnvelopeStore` (P0-N6) suppresses redundant
        // ratchet advances on reconnect-flush, but the UI path mints a
        // fresh local `id` per decode so two passes through the same
        // envelope would otherwise push two bubbles into the list. We
        // skip the second push so a reconnect storm doesn't render
        // duplicates even if the receive pipeline re-enters the append
        // before the seen-set guard has committed.
        //
        // Audit P2-N4 — content-bound dedup gate. The group fan-out's
        // `clientMsgId` is sender-supplied (see groupClient.broadcastToGroup
        // line 128 `genId()`), so a malicious sender could ship two
        // DIFFERENT bodies under one clientMsgId; the second body would
        // hit the `m.id === msg.id` check and silently drop. We now
        // also compare `(sender_id, content)` for the matching id —
        // if the content differs the second is treated as a NEW message
        // (different local id minted at decode, see receive path).
        // For same-content replays the existing id/envelope_id check
        // still fires first.
        const list = s.messages[conversationId];
        const collision = list.find(m => m.id === msg.id);
        if (collision) {
          if (collision.sender_id === msg.sender_id && collision.content === msg.content) {return;}
          // Content diverges — emerge as a fresh row with a derived id
          // so both bodies are visible. Recipient can flag the sender
          // for inconsistency; we prefer over-rendering to silent loss.
          msg = {...msg, id: `${msg.id}#${list.length}`};
        }
        if (msg.envelope_id && list.some(m => m.envelope_id === msg.envelope_id)) {return;}
        // L18 GROUP-DRAIN-RECEIVE-TIME-ORDERING — keep send-order even for a
        // late insert. The common case appends to the end (created_at >= tail);
        // only an OUT-OF-ORDER row (a stashed no_key group message draining
        // after newer messages, carrying its real send-time created_at) is
        // binary-spliced into its chronological slot so it doesn't render at
        // the bottom. The fast append path is unchanged.
        const tail = list[list.length - 1];
        if (tail && msg.created_at < tail.created_at) {
          let lo = 0;
          let hi = list.length;
          while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (list[mid].created_at <= msg.created_at) {lo = mid + 1;} else {hi = mid;}
          }
          list.splice(lo, 0, msg);
        } else {
          list.push(msg);
        }
        // M12 — the row is in the list; this is the id callers must use for
        // every follow-up patch. May differ from the id they passed in (see the
        // content-divergence fork above).
        effectiveId = msg.id;

        // MERGE NOTE: kept THEIRS. My M11 extraction of this into
        // materialiseConversationForAppend() was a pure refactor with no behaviour
        // change, but THIS version carries their OM-06 fix (supersedesLastMessage —
        // a late-draining OLDER message must not regress the conversation preview or
        // re-sort the thread). Taking my side would have silently deleted that. When
        // it is a refactor against a fix, the fix wins; re-extract later if wanted.
        // Auto-create the conversation row if this is the first time we
        // hear about it. Without this, a message from someone who found
        // us via contact discovery (before we found them) lands in
        // `s.messages` but the conversation never appears in the chat
        // list because it's not in `s.conversations` / `s.conversationOrder`.
        //
        // Audit fix #14 — extend the shadow-create to GROUP conversations
        // too. The original code only handled `direct:` ids; if a group
        // text envelope races ahead of its admin.create (e.g. backup
        // restore order, missed-and-redelivered admin envelope), the
        // message body landed in `s.messages` but ChatScreen crashed
        // when it tried to read `conversations[groupId].name`. Place a
        // minimal placeholder row so navigation works; the real group
        // metadata patches over it as soon as the admin.create lands.
        let convo = s.conversations[conversationId];
        /**
         * B-594 — a REPLAYED archive envelope must not shadow-create a
         * conversation the user deleted. `appendMessage` is the last of the
         * four minters and the one the sealed-archive replay reaches through
         * the live deliver path.
         *
         * The tombstone lifts on a genuinely LIVE arrival, which is decided by
         * the caller (the receive path clears it before appending) — so this
         * can never hide a real new message from a peer you cleared, only the
         * restore handing back what you deleted. Same slot and same shape as
         * the M-07 blocked-peer gate that already lives on this path.
         */
        if (!convo && suppressResurrection(conversationId, Date.parse(msg.created_at))) {return;}
        // B-124 §3.2 — a slot that names YOURSELF is never a real chat: you have
        // no 1:1 with yourself. Call escalation aliases a throwaway 'Call' key
        // onto `direct:<ownUserId>`, so a group-stamped message routed there used
        // to shadow-create a `Bravo · <hex>` row whose only participant is you —
        // which the home list then relabelled with the PEER's name, giving the
        // caller two identically-titled chats.
        //
        // Belt-and-braces: the receive path no longer routes here at all (it
        // refuses to adopt a device-local wire group id), and the boot sweep
        // clears historical rows. This stops any OTHER caller re-minting one
        // mid-session, which is what made the boot sweep insufficient on its own.
        const isSelfSlot =
          !!s._ownUserId && conversationId === `direct:${s._ownUserId}`;
        if (!convo && !isSelfSlot && conversationId.startsWith('direct:') && msg.peer && msg.sender_id !== 'self') {
          // Why: before shadow-creating a synthetic `direct:<peer>` row,
          // check if a server-UUID row already exists for the same peer
          // (from /conversations/mine sync). Without this guard the
          // home list ends up with TWO rows for the same peer — the
          // server-UUID one (which the user sees + taps) and the
          // synthetic one (which is where messages actually land but
          // never gets seen). Production runtime's inbound routing
          // already prefers the server-UUID when found, so this branch
          // should only fire on first-contact-before-sync.
          const peerId = peerFromDirectSlot(conversationId);
          let serverRowId: string | undefined;
          for (const [id, existing] of Object.entries(s.conversations)) {
            if (existing.type === 'direct' && existing.peer?.userId === peerId && !id.startsWith('direct:')) {
              serverRowId = id;
              break;
            }
          }
          if (serverRowId) {
            // Re-route this message to the server-UUID slot. Update the
            // msg's conversation_id so SQLite persistence + downstream
            // selectors all agree.
            const rerouted = {...msg, conversation_id: serverRowId};
            if (!s.messages[serverRowId]) {s.messages[serverRowId] = [];}
            const serverList = s.messages[serverRowId];
            if (!serverList.some(m => m.id === rerouted.id || (rerouted.envelope_id && m.envelope_id === rerouted.envelope_id))) {
              serverList.push(rerouted);
            }
            // Drop the duplicate push into the synthetic slot we just
            // made above appendMessage's main `list.push(msg)`. We
            // already pushed there; remove it.
            const idx = list.findIndex(m => m.id === msg.id);
            if (idx >= 0) {list.splice(idx, 1);}
            // Also bump the server row's metadata + ordering.
            const serverConvo = s.conversations[serverRowId];
            if (serverConvo) {
              const reroutedIsLatest = supersedesLastMessage(serverConvo.last_message, rerouted);
              if (reroutedIsLatest) {serverConvo.last_message = rerouted;}
              if (s.activeConversationId !== serverRowId) {serverConvo.unread_count += 1;}
              const oi = s.conversationOrder.indexOf(serverRowId);
              if (reroutedIsLatest && oi > 0) {
                s.conversationOrder.splice(oi, 1);
                s.conversationOrder.unshift(serverRowId);
              }
            }
            return;
          }
          // Friendlier placeholder than a bare UUID prefix. The Home
          // screen runs a passive contact-discovery sweep (see
          // useDiscoveredContacts({passive:true})) which will overwrite
          // this label with the user's saved contact name as soon as
          // it pairs the peer's phone number to an address-book entry.
          // For peers we don't have in contacts the row stays as
          // "Bravo · abcd1234" so the user can still recognise it as
          // an inbound message from a Bravo account, not a cryptic
          // hex string.
          const shortId = peerId.slice(0, 8);
          convo = {
            id:             conversationId,
            type:           'direct',
            name:           `Bravo · ${shortId}`,
            name_source:    'placeholder',
            participants:   [peerId],
            peer:           msg.peer,
            session_state:  'established',
            unread_count:   0,
            is_muted:       false,
            created_at:     msg.created_at,
          };
          s.conversations[conversationId] = convo;
          if (!s.conversationOrder.includes(conversationId)) {
            s.conversationOrder.unshift(conversationId);
          }
        } else if (
          !convo &&
          !conversationId.startsWith('direct:') &&
          msg.sender_id !== 'self' &&
          // B-106 — an ad-hoc call group must never grow a chat-list row
          // (BS-CALL-GHOST sentinel). The message still appends below, so
          // the Calls tab (which walks thread-less slots) keeps its rows.
          !isCallGroupState(s.groups[conversationId])
        ) {
          // Non-direct id with no existing row → assume group placeholder.
          // ChatScreen reads conversations[id] for name + participants;
          // a missing row means a JS crash on render. Stamp a stub.
          convo = {
            id:             conversationId,
            type:           'group',
            name:           'Group chat',
            participants:   msg.peer ? [msg.peer.userId] : [],
            // The carry-over `peer` field is required by LocalConversation;
            // for groups the legitimate routing is per-member fan-out so
            // this is just a placeholder to satisfy the schema.
            peer:           msg.peer ?? {userId: '', deviceId: 1},
            session_state:  'fresh',
            unread_count:   0,
            is_muted:       false,
            created_at:     msg.created_at,
          };
          s.conversations[conversationId] = convo;
          if (!s.conversationOrder.includes(conversationId)) {
            s.conversationOrder.unshift(conversationId);
          }
        }

        if (convo) {
          // OM-06 — only a message at least as recent as the current preview may
          // take over `last_message` / the MRU slot. The unread badge still bumps
          // for a stale insert: it IS an unseen message, it just isn't the newest.
          const isLatest = supersedesLastMessage(convo.last_message, msg);
          if (isLatest) {convo.last_message = msg;}
          // BS-MUTE-UNREAD — a muted conversation must NOT bump its unread
          // badge (the store's documented contract). Inbound messages still
          // append + reorder, just without inflating the badge.
          if (msg.sender_id !== 'self' && s.activeConversationId !== conversationId && !convo.is_muted) {
            convo.unread_count += 1;
          }
          const idx = s.conversationOrder.indexOf(conversationId);
          if (isLatest && idx > 0) {
            s.conversationOrder.splice(idx, 1);
            // Audit MSG-12 (2026-07-02): insert AFTER the pinned prefix, not at
            // index 0. Unconditionally unshifting made any inbound message to
            // an unpinned chat jump ABOVE pinned chats (Home renders the raw
            // conversationOrder). A pinned conversation still moves to the top
            // of the pinned block via setConversationPinned's reorder.
            let insertAt = 0;
            if (!s.conversations[conversationId]?.is_pinned) {
              while (insertAt < s.conversationOrder.length &&
                     s.conversations[s.conversationOrder[insertAt]]?.is_pinned) {
                insertAt++;
              }
            }
            s.conversationOrder.splice(insertAt, 0, conversationId);
          }
        }
        // BS-TY2 — clear any "typing…" flag for this conversation the
        // moment a real message lands. A peer who sends without a
        // trailing `stop` frame (common when the app backgrounds
        // mid-type) would otherwise leave the bubble stuck "typing…"
        // even though their message is already in the thread. Only
        // clear for an INBOUND message (our own send never reflects the
        // peer's typing state).
        if (msg.sender_id !== 'self' && s.typing[conversationId]) {
          // B-117 — clear only the SENDER's typing entry: in a group,
          // another member may still be composing.
          const tu = s.typingUsers[conversationId];
          if (tu?.[msg.sender_id]) {
            delete tu[msg.sender_id];
            if (Object.keys(tu).length === 0) {delete s.typingUsers[conversationId];}
          }
          s.typing[conversationId] = !!s.typingUsers[conversationId];
        }
      });
      return effectiveId;
    },


    updateMessageStatus: (conversationId, messageId, status) => {
      const dirty: string[] = [];
      set(s => {
        const msg = s.messages[conversationId]?.find(m => m.id === messageId);
        // B-703 MR-12 (the W14-promised warn, finally landed) — a miss here is
        // SILENT, and that silence is what makes a whole class of bug
        // undebuggable: the boot outbox drain writes 'sent' and the envelope id
        // store-first, so before hydration both vanish, and the MSG-07 sweep
        // then reds a message the relay accepted. Ids only, sliced — never
        // content (logAudit).
        if (!msg) {
          warnStoreMiss(
            `[messenger.store] updateMessageStatus MISS conv=${String(conversationId).slice(0, 12)} msg=${String(messageId).slice(0, 8)} status=${status}`,
          );
        }
        if (msg && !isStatusRegression(msg.status, status)) {msg.status = status;}
        syncLastMessageStatus(s, conversationId, messageId, status);
        // Audit fix #30 — invalidate backup-mirror dedup so the next
        // tick re-ships this row with its new state. Wired here (and
        // in updateMessageReactions / updateMessageRetractToken /
        // removeMessage below) so a single store action reaches both
        // the local store AND the backup mirror without callers
        // having to remember to call markDirty by hand.
        dirty.push(messageId);
      });
      flushBackupDirty(dirty, conversationId);
    },

    updateMessageStatusBulk: (conversationId, messageIds, status) => {
      const dirty: string[] = [];
      set(s => {
        const list = s.messages[conversationId];
        if (!list || messageIds.length === 0) {return;}
        const wanted = new Set(messageIds);
        for (const m of list) {
          if (wanted.has(m.id) && m.status !== status && !isStatusRegression(m.status, status)) {
            m.status = status;
            syncLastMessageStatus(s, conversationId, m.id, status);
            dirty.push(m.id);
          }
        }
      });
      flushBackupDirty(dirty, conversationId);
    },

    recordReadReceipts: (conversationId, messageIds, userId, ts) => {
      const dirty: string[] = [];
      set(s => {
        const list = s.messages[conversationId];
        if (!list || messageIds.length === 0 || !userId) {return;}
        const wanted = new Set(messageIds);
        const convo = s.conversations[conversationId];
        // B-116 / M2 — ask the ONE topology rule. This used to re-derive it as
        // `type === 'group'`, which omitted ops_channel: `required` fell to null
        // and the direct rule blue-ticked a whole channel on one member's read.
        const isGroup = isGroupConversation(s, conversationId);
        // Group WhatsApp semantics: 'read' only when every OTHER participant
        // has read. Own uid excluded from the required set.
        //
        // `_ownAuthUserId`, NOT `_ownUserId`: the latter is the vault OWNER KEY
        // (`email ?? phone ?? id`), so for any account with an email it never
        // equals a `participants` entry. The author therefore stayed inside
        // their own required set, nobody ever sends the author a receipt for
        // their own message, and `allRead` was structurally unreachable — no
        // group message could EVER go blue. Falls back to `_ownUserId` for the
        // id-only accounts where the two coincide.
        const ownUid = s._ownAuthUserId ?? s._ownUserId;
        const participants = isGroup
          ? (convo?.participants ?? []).filter(u => u && u !== ownUid)
          : null;
        for (const m of list) {
          if (!wanted.has(m.id)) {continue;}
          if (m.sender_id !== 'self') {continue;}
          if (!m.receipts) {m.receipts = {};}
          m.receipts[userId] = {status: 'read', ts};
          // Only members we actually SHIPPED a leg to can ever read it, so
          // requiring a receipt from anyone else deadlocks the aggregate
          // forever. Two real cases: a member added to the channel AFTER this
          // message (no leg, and readReceiptEnvelopeMatch would reject their
          // receipt anyway), and a member whose leg never shipped (no prekeys /
          // outbox exhausted). Intersect with the shipped legs when we know
          // them; fall back to the full roster for rows predating envelope_ids.
          // DO NOT relax this for rows with no envelope_ids.
          //
          // Tried and reverted 2026-07-25: a restored row keeps only the scalar
          // envelope_id, so only ONE member's receipt can ever be attributed to
          // it and the aggregate can never complete — which looks like a bug
          // worth "fixing" by treating an unattributable row as satisfied by
          // any single receipt. It is not. `envelope_ids` is ALSO empty on a
          // freshly-sent row, for the window between the optimistic append and
          // `envelope.accepted` populating the map — so that relaxation
          // blue-ticks a brand-new group message on its first receipt, which is
          // precisely the B-116 semantic this rule exists to enforce.
          // `groupReadReceipts.test.ts` catches it; it was right and the
          // relaxation was wrong.
          //
          // The real fix is upstream: `backupWireV3` now mirrors envelope_ids
          // and receipts, so restores stop discarding the attribution in the
          // first place. Rows restored BEFORE that shipped keep the stuck tick
          // — their per-recipient ids are simply gone and no local rule can
          // reconstruct them.
          const shipped = Object.keys(m.envelope_ids ?? {});
          const required = participants && shipped.length > 0
            ? participants.filter(u => shipped.includes(u))
            : participants;
          const allRead = required && required.length > 0
            ? required.every(u => m.receipts?.[u]?.status === 'read')
            : true; // direct: the single peer's receipt is sufficient
          // Why: same one-ladder rule every other status writer uses (XO-4);
          // equivalent today (read is rank-top) but keeps this site from
          // drifting if a rank above read ever lands.
          if (allRead && m.status !== 'read' && !isStatusRegression(m.status, 'read')) {
            m.status = 'read';
            syncLastMessageStatus(s, conversationId, m.id, 'read');
          }
          dirty.push(m.id);
        }
      });
      flushBackupDirty(dirty, conversationId);
    },

    recordDeliveredReceipt: (conversationId, messageId, userId, ts) => {
      const dirty: string[] = [];
      set(s => {
        const msg = s.messages[conversationId]?.find(m => m.id === messageId);
        if (!msg || !userId) {return;}
        if (msg.sender_id !== 'self') {return;}
        if (!msg.receipts) {msg.receipts = {};}
        // Never demote a member who already READ the message.
        if (msg.receipts[userId]?.status !== 'read') {
          msg.receipts[userId] = {status: 'delivered', ts};
        }
        // B-187 — same required-set rule as recordReadReceipts above: only
        // members we actually shipped a leg to can ever ack it (see the long
        // rationale there — including why rows with no envelope_ids must NOT
        // be relaxed). Accepted, documented limitation shared with the read
        // rule: while the fan-out is still populating envelope_ids there is a
        // short premature-flip window; B-143's any-leg-destroyed →
        // 'undelivered' still overrides (off-ladder, allowed over delivered).
        const isGroup = isGroupConversation(s, conversationId);
        const ownUid = s._ownAuthUserId ?? s._ownUserId;
        const participants = isGroup
          ? (s.conversations[conversationId]?.participants ?? []).filter(u => u && u !== ownUid)
          : null;
        const shipped = Object.keys(msg.envelope_ids ?? {});
        const required = participants && shipped.length > 0
          ? participants.filter(u => shipped.includes(u))
          : participants;
        const allDelivered = required && required.length > 0
          ? required.every(u => {
              const st = msg.receipts?.[u]?.status;
              return st === 'delivered' || st === 'read';
            })
          : true; // direct: the single peer's ack is sufficient
        if (allDelivered && msg.status === 'sent' && !isStatusRegression(msg.status, 'delivered')) {
          msg.status = 'delivered';
          syncLastMessageStatus(s, conversationId, msg.id, 'delivered');
        }
        dirty.push(messageId);
      });
      flushBackupDirty(dirty, conversationId);
    },

    recordUndeliverableLeg: (conversationId, messageId, userId, ts) => {
      const dirty: string[] = [];
      set(s => {
        const msg = s.messages[conversationId]?.find(m => m.id === messageId);
        if (!msg || !userId) {return;}
        if (msg.sender_id !== 'self') {return;}
        // Value-level idempotency — the 60s receipt poll re-fires settled
        // 'discarded' verdicts; a fresh ts each pass would re-mirror the
        // row every minute (the B-634/I1 backup-churn class).
        if (msg.undeliverable_legs?.[userId] !== undefined) {return;}
        if (!msg.undeliverable_legs) {msg.undeliverable_legs = {};}
        msg.undeliverable_legs[userId] = ts;
        // B-683 — flip only on TOTAL failure. Every CURRENT participant must
        // have a shipped leg (a deferred outbox leg still owes a delivery —
        // its envelope id is stamped only at drain), that leg dead, and no
        // delivered/read receipt. A partial failure keeps the ladder state
        // so the other members' receipts keep flowing. Roster is read at
        // verdict time: a member added after send has no leg and makes the
        // flip unreachable — accepted residue, see
        // docs/audits/FEED_TICKER_FALSE_RETRY_AUDIT_2026-08-27.md §2.4.
        const ownUid = s._ownAuthUserId ?? s._ownUserId;
        const participants = (s.conversations[conversationId]?.participants ?? [])
          .filter(u => u && u !== ownUid);
        const allDead = participants.length > 0 &&
          participants.every(u => {
            if (!msg.envelope_ids?.[u]) {return false;}
            const st = msg.receipts?.[u]?.status;
            if (st === 'delivered' || st === 'read') {return false;}
            return msg.undeliverable_legs?.[u] !== undefined;
          });
        if (allDead && (msg.status === 'sent' || msg.status === 'delivered')) {
          msg.status = 'undelivered';
          syncLastMessageStatus(s, conversationId, msg.id, 'undelivered');
        }
        dirty.push(messageId);
      });
      flushBackupDirty(dirty, conversationId);
    },

    resetWireArtifactsForResend: (conversationId, messageId) => {
      const dirty: string[] = [];
      set(s => {
        const msg = s.messages[conversationId]?.find(m => m.id === messageId);
        if (!msg) {return;}
        // B-683/F2 — round-1 artifacts must not survive into a fresh-wire-id
        // re-send: the retract slots are FIRST-WINS (updateMessageRetractToken),
        // so a stale token would pair with round-2 envelope ids and turn every
        // receipt probe 'unknown' forever; a cleared scalar makes a late
        // round-1 'discarded' match nothing at all.
        delete msg.envelope_id;
        delete msg.retract_token;
        delete msg.envelope_ids;
        delete msg.retract_tokens;
        delete msg.undeliverable_legs;
        dirty.push(messageId);
      });
      flushBackupDirty(dirty, conversationId);
    },

    setDraft: (conversationId, text) =>
      set(s => {
        if (!conversationId) {return;}
        const t = text.trim() ? text : '';
        if (t) {
          if (s.drafts[conversationId] === t) {return;}
          s.drafts[conversationId] = t;
        } else {
          if (s.drafts[conversationId] === undefined) {return;}
          delete s.drafts[conversationId];
        }
        if (draftSink) {
          const sink = draftSink;
          // Outside the immer producer — same rule as the master-key sink.
          queueMicrotask(() => {
            void sink.set(conversationId, t).catch(e => {
              console.warn('[messengerStore] draft sink failed', e);
            });
          });
        }
      }),

    updateMessageCiphertext: (conversationId, messageId, ciphertext) =>
      set(s => {
        const msg = s.messages[conversationId]?.find(m => m.id === messageId);
        if (msg) {msg.ciphertext = ciphertext;}
      }),

    updateMessageRetractToken: (conversationId, messageId, token, recipientUserId) => {
      const dirty: string[] = [];
      set(s => {
        const msg = s.messages[conversationId]?.find(m => m.id === messageId);
        if (!msg) {return;}
        // First-wins when a leg is attributed (group fan-out): a later leg must
        // not clobber the token that pairs with the scalar envelope_id the first
        // leg already seeded — see updateMessageEnvelopeId's SYNC-1 comment.
        if (recipientUserId) {
          // B-187 — also record the token in the per-recipient map (the pair
          // to envelope_ids) so the receipt poll can probe EVERY leg.
          // First-wins per leg: a drain retry must not swap a token the relay
          // already issued for that recipient.
          if (!msg.retract_tokens) {msg.retract_tokens = {};}
          if (!msg.retract_tokens[recipientUserId]) {msg.retract_tokens[recipientUserId] = token;}
          if (!msg.retract_token) {msg.retract_token = token;}
        } else {
          msg.retract_token = token;
        }
        dirty.push(messageId);
      });
      flushBackupDirty(dirty, conversationId);
    },

    updateMessageEnvelopeId: (conversationId, messageId, envelopeId, recipientUserId) => {
      const dirty: string[] = [];
      set(s => {
        const msg = s.messages[conversationId]?.find(m => m.id === messageId);
        if (!msg) {
          // B-703 MR-12 — the acceptance artifact is what the MSG-07 boot sweep
          // reads to tell "the relay took this" from "give the user a retry
          // chip". Losing it silently is how a delivered message goes red.
          warnStoreMiss(
            `[messenger.store] updateMessageEnvelopeId MISS conv=${String(conversationId).slice(0, 12)} msg=${String(messageId).slice(0, 8)}`,
          );
          return;
        }
        if (recipientUserId) {
          if (!msg.envelope_ids) {msg.envelope_ids = {};}
          msg.envelope_ids[recipientUserId] = envelopeId;
          // Why: a later fan-out leg (or an outbox drain) must not clobber
          // the scalar the first leg seeded — SYNC-1.
          if (!msg.envelope_id) {msg.envelope_id = envelopeId;}
        } else {
          msg.envelope_id = envelopeId;
        }
        dirty.push(messageId);
      });
      flushBackupDirty(dirty, conversationId);
    },

    patchMessageMedia: (conversationId, messageId, fields) => {
      const dirty: string[] = [];
      set(s => {
        const msg = s.messages[conversationId]?.find(m => m.id === messageId);
        if (!msg) {return;}
        if (fields.type !== undefined) {msg.type = fields.type;}
        if (fields.media_mime !== undefined) {msg.media_mime = fields.media_mime;}
        if (fields.media_object_key !== undefined) {msg.media_object_key = fields.media_object_key;}
        if (fields.media_key !== undefined) {msg.media_key = fields.media_key;}
        if (fields.media_iv !== undefined) {msg.media_iv = fields.media_iv;}
        if (fields.media_meta !== undefined) {msg.media_meta = fields.media_meta;}
        dirty.push(messageId);
      });
      flushBackupDirty(dirty, conversationId);
    },

    removeMessage: (conversationId, messageId) => {
      // H-3 — capture the row BEFORE the immer commit so the tombstone
      // carries the real conversation_id + created_at, then emit it
      // AFTER the commit (see notifyBackupRemoved).
      const existing = useMessengerStore.getState().messages[conversationId]?.find(m => m.id === messageId);
      set(s => {
        const list = s.messages[conversationId];
        if (!list) {return;}
        s.messages[conversationId] = list.filter(m => m.id !== messageId);
      });
      notifyBackupRemoved(messageId, conversationId, existing?.created_at ?? new Date().toISOString());
    },

    clearMessages: (conversationId) =>
      set(s => {
        // Empties the message list for one chat without dropping the
        // conversation row — the chat stays in the list but the bubbles
        // (text + media + call records) are gone. The runtime's
        // SQLCipher write-through subscriber sees the [] and DELETEs
        // every persisted row for this conversation, so the clear
        // survives restart.
        if (!s.messages[conversationId]) {return;}
        s.messages[conversationId] = [];
        const convo = s.conversations[conversationId];
        if (convo) {
          convo.last_message = undefined;
          convo.unread_count = 0;
        }
      }),

    updateMessageReactions: (conversationId, messageId, reactions) => {
      const dirty: string[] = [];
      set(s => {
        const msg = s.messages[conversationId]?.find(m => m.id === messageId);
        if (msg) {msg.reactions = reactions;}
        dirty.push(messageId);
      });
      flushBackupDirty(dirty, conversationId);
    },

    applyMessageEdit: (conversationId, messageId, body, editedAt, mentions) => {
      const dirty: string[] = [];
      set(s => {
        const msg = s.messages[conversationId]?.find(m => m.id === messageId);
        if (!msg) {return;}
        msg.content   = body;
        msg.edited_at = editedAt;
        // Assign the WHOLE field, including the absent case. An edit that
        // removes the last @-mention must clear the list, or the old highlight
        // survives against a body that no longer contains the name.
        msg.mentions  = mentions?.length ? mentions : undefined;
        syncLastMessagePreview(s, conversationId, msg);
        dirty.push(messageId);
      });
      flushBackupDirty(dirty, conversationId);
    },

    applyDeleteForEveryone: (conversationId, messageId) => {
      const dirty: string[] = [];
      set(s => {
        const msg = s.messages[conversationId]?.find(m => m.id === messageId);
        if (!msg) {return;}
        msg.deleted_for_all = true;
        msg.content         = '';
        // Everything that could still render the retracted content, or point a
        // reader at it, goes. `media_object_key` in particular: leaving it
        // would let the attachment renderer re-download and decrypt the blob
        // the author just retracted.
        msg.type             = 'text';
        msg.media_mime       = undefined;
        msg.media_object_key = undefined;
        msg.media_key        = undefined;
        msg.media_iv         = undefined;
        msg.media_meta       = undefined;
        msg.reactions        = undefined;
        msg.mentions         = undefined;
        msg.reply_to_msg_id  = undefined;
        msg.reply_to_preview = undefined;
        // A disappearing-message timer on a tombstone would delete the
        // tombstone itself and make the thread jump; the content is already
        // gone, so the timer has nothing left to protect.
        msg.expires_at       = undefined;
        syncLastMessagePreview(s, conversationId, msg);
        dirty.push(messageId);
      });
      flushBackupDirty(dirty, conversationId);
    },

    setConversationMuted: (conversationId, muted) =>
      set(s => {
        const c = s.conversations[conversationId];
        if (c) {c.is_muted = muted;}
      }),

    setConversationPinned: (conversationId, pinned) =>
      set(s => {
        const c = s.conversations[conversationId];
        if (!c) {return;}
        c.is_pinned = pinned;
        // Re-order: pinned rows always sit above unpinned, newest first.
        const order = s.conversationOrder.filter(id => id !== conversationId);
        const head  = order.filter(id => s.conversations[id]?.is_pinned);
        const tail  = order.filter(id => !s.conversations[id]?.is_pinned);
        s.conversationOrder = pinned ? [conversationId, ...head, ...tail] : [...head, conversationId, ...tail];
      }),

    removeConversation: conversationId => {
      /**
       * B-594 — THE SINGLE CHOKE POINT for "this conversation is gone".
       *
       * Recorded HERE rather than at the four call sites, so a future
       * deleter cannot forget it. Before this, the delete was a Zustand-only
       * eviction with no durable trace of the user's intent — so the backup
       * restore, whose "already live?" guard exists to avoid stomping
       * FRESHER state, read a deleted conversation as "not live, safe to
       * restore" and handed it straight back at the top of the list. The
       * Home screen's server prune then removed it again once `listMine`
       * landed: the founder's "appears for a fraction of a second".
       *
       * Suppression only — nothing about what the mirror stores or what the
       * Merkle commit covers changes here (BACKUP_LOOP I3/I7). A genuinely
       * live arrival lifts it again.
       */
      // B-594 fresh-install restore — capture the row BEFORE the commit so the
      // delete-mirror below can ship a well-formed tombstone (H-3 lesson).
      const convBefore = useMessengerStore.getState().conversations[conversationId];
      set(s => {
        rememberDeletedConversation(conversationId, Date.now());
        delete s.conversations[conversationId];
        delete s.messages[conversationId];
        s.conversationOrder = s.conversationOrder.filter(id => id !== conversationId);
      });
      // AFTER the commit — mirror the delete (deleted:true) so it survives a
      // reinstall; the per-install AsyncStorage tombstone above does not.
      if (convBefore) {notifyBackupConversationDeleted(convBefore);}
    },

    setTyping: (conversationId, typing) =>
      set(s => {
        s.typing[conversationId] = typing;
        // B-117 — a blanket boolean write clears the per-user set too so
        // the two views can never disagree (legacy callers only ever
        // CLEAR via this path).
        if (!typing) {delete s.typingUsers[conversationId];}
      }),

    setTypingUser: (conversationId, userId, typing) =>
      set(s => {
        if (typing) {
          if (!s.typingUsers[conversationId]) {s.typingUsers[conversationId] = {};}
          s.typingUsers[conversationId][userId] = true;
        } else if (s.typingUsers[conversationId]) {
          delete s.typingUsers[conversationId][userId];
          if (Object.keys(s.typingUsers[conversationId]).length === 0) {
            delete s.typingUsers[conversationId];
          }
        }
        s.typing[conversationId] = !!s.typingUsers[conversationId];
      }),

    setConversationTtl: (conversationId, ttlSec) =>
      set(s => {
        const c = s.conversations[conversationId];
        if (!c) {return;}
        c.default_ttl_sec = ttlSec;
      }),

    setGroupMemberName: (groupId, userId, name) =>
      set(s => {
        if (!name?.trim()) {
          if (s.groupMemberNames[groupId]) {
            delete s.groupMemberNames[groupId][userId];
            if (Object.keys(s.groupMemberNames[groupId]).length === 0) {
              delete s.groupMemberNames[groupId];
            }
          }
          return;
        }
        if (!s.groupMemberNames[groupId]) {s.groupMemberNames[groupId] = {};}
        s.groupMemberNames[groupId][userId] = name.trim();
      }),

    // Explicit return type: reading `useMessengerStore.getState()` inside the
    // store's own initializer makes TS infer the store type through this action,
    // which is circular and collapses the whole store to `any` without it.
    deptChannelGroup: (channelId): string | null =>
      useMessengerStore.getState().deptGroupByChannel[channelId] ?? null,

    setDeptChannelGroup: (channelId, groupId) =>
      set(s => {
        if (channelId && groupId) {
          s.deptGroupByChannel[channelId] = groupId;
          // Scope v2 Phase 4 — ALSO record it in the additive registry. That
          // map is a channel->conversation POINTER (B-206 overwrites it to
          // migrate history); this is a permanent set of every conversation
          // ever known to be departmental, which is what the vault refusal
          // needs. Keeping them separate is deliberate: pruning the pointer
          // must not un-refuse a company file.
          s.deptConversationIds[groupId] = true;
        }
      }),

    /**
     * vs2 edge A9 — `orgId` is OPTIONAL and only ever written, never cleared.
     *
     * A dept-message push carries `{kind, conversationId, senderUserId}` and
     * nothing else — messenger-service holds no org membership data — so this
     * map is the only local answer to "which workspace is this thread in".
     * Without it a cross-workspace channel push opens the thread correctly and
     * then Back lands in a directory belt-filtered to the STICKY org, which
     * does not contain the thread just read.
     *
     * Additive like the set beside it: a caller that does not know the org must
     * not erase one we already learned.
     */
    rememberDeptConversation: (conversationId, orgId) =>
      set(s => {
        if (!conversationId) {return;}
        s.deptConversationIds[conversationId] = true;
        if (orgId) {s.deptOrgByConversation[conversationId] = orgId;}
      }),

    migrateConversationMessages: (oldId, newId) =>
      set(s => {
        if (!oldId || !newId || oldId === newId) {return;}
        const src = s.messages[oldId] ?? [];
        if (src.length) {
          if (!s.messages[newId]) {s.messages[newId] = [];}
          const dest = s.messages[newId];
          const seenId  = new Set(dest.map(m => m.id));
          const seenEnv = new Set(dest.map(m => m.envelope_id).filter(Boolean));
          for (const m of src) {
            if (seenId.has(m.id)) {continue;}
            if (m.envelope_id && seenEnv.has(m.envelope_id)) {continue;}
            dest.push({...m, conversation_id: newId});
          }
          dest.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
          const conv = s.conversations[newId];
          const last = dest[dest.length - 1];
          if (conv && last && (!conv.last_message || conv.last_message.created_at <= last.created_at)) {
            conv.last_message = last;
          }
        }
        // The old id's local conversation row + messages are now orphaned; drop
        // them so the home list doesn't show a dead duplicate thread.
        delete s.messages[oldId];
        delete s.conversations[oldId];
        const oi = s.conversationOrder.indexOf(oldId);
        if (oi >= 0) {s.conversationOrder.splice(oi, 1);}
      }),

    setDirectoryNames: (entries) =>
      set(s => {
        for (const [userId, name] of Object.entries(entries)) {
          if (userId && name?.trim()) {s.directoryNames[userId] = name.trim();}
        }
      }),

    setDirectoryAvatars: (entries) =>
      set(s => {
        for (const [userId, url] of Object.entries(entries)) {
          if (!userId) {continue;}
          // A null/blank url means the user has no photo — store nothing
          // rather than an empty string, so any present value is renderable.
          if (url?.trim()) {s.directoryAvatars[userId] = url.trim();}
          else {delete s.directoryAvatars[userId];}
        }
      }),

    setPresence: (userId, state, lastSeenMs) =>
      set(s => {
        // Round 7 / presence audit fix #7 — preserve the server's
        // 4-state granularity. `online` stays as a derived boolean so
        // existing consumers (`presence.online ? 'green' : 'grey'`)
        // keep working until they migrate to `state`. `lastSeen` is
        // mirrored from `lastSeenMs` for the same reason.
        const online = state !== 'offline';
        // B-146 — an online/active/away frame legitimately carries NO
        // lastSeenMs (protocol: "connected, no active/away hint yet"),
        // and writing that undefined through destroyed a timestamp the
        // client already knew. The peer then went offline via a LOCAL
        // downgrade (`clearPresence` on reconnect/unsubscribe), which
        // faithfully preserved the wiped value — so the offline banner
        // lost its "Last seen …" line for the rest of the session.
        //
        // An `offline` frame is deliberately NOT backfilled: the relay
        // STRIPS lastSeenMs when the peer has "show last seen" off
        // (audit M-06), so re-asserting a remembered timestamp there
        // would resurrect precisely what the peer asked us to forget.
        // Absence on an offline frame is therefore meaningful; absence
        // on a non-offline frame is not.
        const prev = s.presence[userId];
        const resolved = lastSeenMs ?? (state === 'offline' ? undefined : prev?.lastSeen);
        s.presence[userId] = { state, online, lastSeen: resolved, lastSeenMs: resolved };
      }),

    clearPresence: (userIds) =>
      set(s => {
        for (const uid of userIds) {
          const prev = s.presence[uid];
          // Preserve lastSeen — the user really was last seen at that
          // time; only the `online` claim is no longer trustworthy.
          s.presence[uid] = {
            state:      'offline',
            online:     false,
            lastSeen:   prev?.lastSeen,
            lastSeenMs: prev?.lastSeenMs,
          };
        }
      }),

    clearAllPresence: () =>
      set(s => {
        s.presence = {};
      }),

    setConnection: state =>
      set(s => {
        s.connection = state;
      }),

    setSyncState: state =>
      set(s => {
        s.syncState = state;
      }),

    setReady: ready =>
      set(s => {
        s.ready = ready;
      }),

    setError: error =>
      set(s => {
        s.error = error;
      }),

    setRecoveryBanner: msg =>
      set(s => {
        s.recoveryBanner = msg;
      }),

    noteUndecryptableDrop: (envelopeId: string) => {
      if (!envelopeId || countedUndecryptableDrops.has(envelopeId)) {return;}
      countedUndecryptableDrops.add(envelopeId);
      if (countedUndecryptableDrops.size > COUNTED_DROPS_CAP) {
        const oldest = countedUndecryptableDrops.values().next().value;
        if (oldest !== undefined) {countedUndecryptableDrops.delete(oldest);}
      }
      set(s => {
        s.undecryptableDropCount += 1;
      });
    },

    clearUndecryptableDrops: () =>
      set(s => {
        s.undecryptableDropCount = 0;
      }),

    reset: () => set(() => ({ ...initialState })),

    setOwner: (userId: string, authUserId?: string) =>
      set(s => {
        // Recorded BEFORE the same-owner early-return: the vault does not need
        // swapping on a re-login, but the auth id still has to be present (it
        // is not persisted, so every cold boot arrives here with it unset).
        if (authUserId) {s._ownAuthUserId = authUserId;}
        const prev = s._ownUserId;
        if (prev === userId) {return;} // same owner — nothing to swap
        // Snapshot the current owner's slice into the vault so it
        // survives the upcoming swap (and the next AsyncStorage flush).
        //
        // Audit fix #15 — store a PLAIN snapshot, not the immer drafts.
        // Stuffing the live drafts into vaultByOwner means later
        // mutations to s.conversations / s.groups also mutate the
        // vault entry (drafts share the same underlying proxies), which
        // poisoned the previous owner's vault state and surfaced as
        // "vault entries grew while user wasn't logged in". `current()`
        // returns a structurally-shared but plain (non-draft) copy.
        if (prev) {
          s.vaultByOwner[prev] = {
            conversations:     immerCurrent(s.conversations),
            conversationOrder: immerCurrent(s.conversationOrder),
            groups:            immerCurrent(s.groups),
            groupMemberNames:  immerCurrent(s.groupMemberNames),
            deptGroupByChannel: immerCurrent(s.deptGroupByChannel),
            deptConversationIds: immerCurrent(s.deptConversationIds),
            deptOrgByConversation: immerCurrent(s.deptOrgByConversation),
          };
        }
        // Load the incoming owner's slice if we've seen them before;
        // otherwise start with empty slots. Live state (messages,
        // presence, typing, connection, error) is intentionally NOT
        // vaulted — it's transient + the runtime re-hydrates messages
        // from SQLCipher under the new ownerKey-scoped DB.
        const incoming = s.vaultByOwner[userId];
        s.conversations     = incoming?.conversations     ?? {};
        s.conversationOrder = incoming?.conversationOrder ?? [];
        s.groups            = incoming?.groups            ?? {};
        s.groupMemberNames  = incoming?.groupMemberNames  ?? {};
        s.deptGroupByChannel = incoming?.deptGroupByChannel ?? {};
        // MUST be restored alongside the pointer map, not just snapshotted.
        // It was written into vaultByOwner above but never read back, so an
        // account switch left the incoming owner holding the PREVIOUS owner's
        // ids (accumulating on every switch) while dropping any id that lives
        // only here — the OLD conversation after a B-206 remap, or a channel
        // recorded from the server but never opened on this device. Those stop
        // being refused by the vault, which is precisely the regression this
        // registry exists to prevent.
        s.deptConversationIds = incoming?.deptConversationIds ?? {};
        // vs2 edge A9 — the SAME rule, one line below the comment that
        // documents it. The org map was snapshotted into vaultByOwner above and
        // never read back, so an account switch left the incoming owner holding
        // the PREVIOUS owner's org mappings (accumulating on every switch) and
        // dropping their own. Refused safely by `adoptOrgContextFromWake` (a
        // foreign org is not in `user.workspaces`), but the incoming user's A9
        // stayed dead until the next registry arm.
        s.deptOrgByConversation = incoming?.deptOrgByConversation ?? {};
        // Reset transient slices on switch so we don't leak the
        // previous user's typing/presence/error state.
        s.messages             = {};
        s.activeConversationId = null;
        s.typing               = {};
        s.presence             = {};
        s.error                = null;
        s.ready                = false;
        s._ownUserId           = userId;
        // A genuine user switch must not leave the previous account's auth id
        // behind — it would exclude the wrong person from every read-receipt
        // aggregate. Cleared unless this call supplied a fresh one.
        if (!authUserId) {s._ownAuthUserId = null;}
        if (prev) {
          console.log(`[messengerStore] user changed (${prev} → ${userId}), swapped vault (had vault: ${!!incoming})`);
        }
      }),

    setGroupState: (state: GroupState) =>
      set(s => {
        s.groups[state.groupId] = state;
        // L9 send-recipients-decoupled-from-crypto-membership — keep the
        // conversation's SEND recipient set (convo.participants) in lockstep
        // with the crypto membership (groupState.members). Without this an
        // ADDED member received the key + admin events but no actual text
        // messages (the fan-out targets participants, not members), and a
        // REMOVED member kept being fanned out to. Single choke point: every
        // add / remove / received-admin-action commits group state here.
        const gconvo = s.conversations[state.groupId];
        if (gconvo && (gconvo.type === 'group' || gconvo.type === 'ops_channel')) {
          gconvo.participants = Object.keys(state.members);
        }
        // Audit P0-S3 / P0-S5 — mirror the master key into the SQLCipher
        // group_master_keys table, AES-GCM-wrapped under the per-user
        // wrap secret. Best-effort + fire-and-forget; if the sink isn't
        // wired (loopback dev mode, tests) we no-op silently. The
        // partialize step strips masterKeyB64 from the AsyncStorage
        // snapshot regardless, so a missed sink write just means the
        // key has to be re-learned from the next admin envelope rather
        // than restored on cold start — never a plaintext leak.
        if (groupMasterKeySink && state.masterKeyB64) {
          const sink = groupMasterKeySink;
          const gid = state.groupId;
          const mk = state.masterKeyB64;
          queueMicrotask(() => {
            void sink.setKey(gid, mk).catch(e => {
              console.warn('[messengerStore] groupMasterKey sink.setKey failed', e);
            });
          });
        }
      }),

    removeGroupState: (groupId: string) =>
      set(s => {
        // Audit P1-G5 — when the group goes away, evict its master key
        // from the in-process keyCache so a captured pre-removal
        // ciphertext can't `groupDecrypt` against a leftover live key.
        // Captured here BEFORE the `delete` so the lookup still works;
        // dispose runs OUTSIDE the immer producer to avoid mutating
        // module state during the draft commit (we just queue the call).
        const stale = s.groups[groupId]?.masterKeyB64;
        delete s.groups[groupId];
        if (stale) {
          // Best-effort dispose — defer to a microtask so the immer
          // commit lands first and any concurrent `groupDecrypt` against
          // the SAME key for an in-flight envelope completes before we
          // evict. Required because `keyCache` returns a Promise<CryptoKey>
          // and an in-flight resolution is shared across awaiters.
          queueMicrotask(() => {
            try {
              const {disposeGroupKey} = require('@bravo/messenger-core') as
                typeof import('@bravo/messenger-core');
              disposeGroupKey(stale);
            } catch { /* fine — package may not be linked in tests */ }
          });
        }
        // Audit P0-S3 / P0-S5 — purge the wrapped row so a captured
        // SQLCipher file from a phone the user has since left this
        // group on can't be replayed against future intercepted group
        // ciphertext.
        if (groupMasterKeySink) {
          const sink = groupMasterKeySink;
          queueMicrotask(() => {
            void sink.deleteKey(groupId).catch(e => {
              console.warn('[messengerStore] groupMasterKey sink.deleteKey failed', e);
            });
          });
        }
      }),

    hydrateMessages: (map, bypassCap) =>
      set(s => {
        // Merge into existing — preserves any in-flight unsaved
        // messages the runtime appended before hydration completed.
        //
        // Audit fix #16 — cap each conversation at the
        // MAX_HYDRATE_PER_CONVO most-recent messages. A user with
        // years of history shouldn't pay the cost of every row at
        // boot; the chat scroll-back path uses prependOlderMessages
        // to page in older content on demand.
        //
        // bypassCap is set by the restore-from-backup path so all
        // restored rows reach the UI in one shot. Without it, restoring
        // 5 000 messages would land in SQLCipher fine but only the last
        // 200 per conversation would render — looking exactly like the
        // "most messages disappeared after reinstall" bug.
        for (const [conversationId, list] of Object.entries(map)) {
          const existing = s.messages[conversationId] ?? [];
          const seen = new Set(existing.map(m => m.id));
          // M8 — dedup on envelope_id TOO, mirroring the live gate in
          // appendMessage. Hydration matched on `id` only, so a row that
          // reached disk under a different local id but the SAME envelope
          // (a reconnect re-decode, or anything written before the
          // committed-row fix) came back as a SECOND bubble on every single
          // restart — a duplicate that no amount of live dedup could clear
          // because it was re-created at boot.
          const seenEnvelopes = new Set(
            existing.map(m => m.envelope_id).filter(Boolean) as string[],
          );
          const merged = [...existing];
          for (const m of list) {
            if (seen.has(m.id)) {continue;}
            if (m.envelope_id && seenEnvelopes.has(m.envelope_id)) {continue;}
            seen.add(m.id);
            if (m.envelope_id) {seenEnvelopes.add(m.envelope_id);}
            merged.push(m);
          }
          // Audit P1-N20 — break ties on `id` so two messages stamped
          // with the same millisecond stay in a deterministic order
          // across hydrations. Without this, equal timestamps fall back
          // to the JS engine's unstable sort and the bubbles swap on
          // every reload.
          merged.sort(byCreatedAtThenId);
          const capped = (!bypassCap && merged.length > MAX_HYDRATE_PER_CONVO)
            ? merged.slice(-MAX_HYDRATE_PER_CONVO)
            : merged;
          s.messages[conversationId] = capped;
          // B-78 — repopulate the conversation's `last_message` from the freshest
          // hydrated row. Persist strips the body (MSG-10), so after a restart or
          // a backup restore `last_message` is missing → the home list showed no
          // preview/timestamp AND the ordering fell back to the conversation's
          // (stale) `created_at`, sinking an actively-used chat below empty ones.
          // SQLCipher is the source of truth for the body on boot; seed it here so
          // both the preview and the last-activity ordering are correct. Guarded
          // to only move forward in time so a capped page can't stale the pointer.
          const convo = s.conversations[conversationId];
          const newest = capped[capped.length - 1];
          if (convo && newest) {
            const cur = convo.last_message;
            if (!cur || Date.parse(cur.created_at) <= Date.parse(newest.created_at)) {
              convo.last_message = newest;
            }
          }
        }
        // B-703 MR-2/MR-3 — messages are durable (SQLCipher, committed and
        // acked); the conversation row is not (debounced vault write, and the
        // rehydrate REPLACES the map). Rows whose thread went missing would
        // otherwise hydrate into an invisible conversation forever — the
        // founder's "in the notification but not in the chat". THIS is the
        // repair site: it re-derives from SQLCipher on the next boot whatever
        // either failure clobbered, so it covers MR-3 as well as MR-2.
        //
        // NOT during a RESTORE: the importer decides which conversation rows
        // exist from the SERVER listing (including a B-106 suppression this
        // repair cannot see) and must not be second-guessed mid-import.
        // Keyed on the restore's own bracket rather than on `bypassCap`: the
        // streaming BR-1 batch paint calls hydrateMessages(map, FALSE) because
        // it wants the cap, so a `bypassCap` test skipped only the final
        // one-shot hydrate and let the repair run on every painted batch. That
        // was safe by ordering luck alone (the deferred path stages
        // conversation rows first); on the non-deferred path a placeholder
        // minted here BLOCKS the restored real row, which the staged apply
        // skips whenever the store already holds one — losing its name,
        // members, mute, pin and unread.
        const healed = isRestoreWriteThroughSuppressed() ? 0 : repairOrphanConversationRows(s);
        if (healed > 0) {
          console.warn(`[messengerStore] B-703 restored ${healed} conversation row(s) from hydrated messages`);
        }
        // B-712 — mark THIS commit as bulk replay, inside the same producer so
        // `hydrateMessages` remains exactly ONE store commit (pinned by
        // bootstrapDrainYield.test.ts). The background notifier reads the delta
        // and watermarks these rows without bannering them; a live append never
        // touches this counter, so it can never be swallowed by the mark.
        s.hydrationGeneration += 1;
      }),

    prependOlderMessages: (conversationId, older) =>
      set(s => {
        // Audit fix #16 — insert older messages in front of the
        // existing list and dedupe by id. Caller handles "no more to
        // load" by passing an empty array (we no-op).
        if (!older.length) {return;}
        const existing = s.messages[conversationId] ?? [];
        const seen = new Set(existing.map(m => m.id));
        const fresh = older.filter(m => !seen.has(m.id));
        if (!fresh.length) {return;}
        const combined = [...fresh, ...existing];
        // Audit P1-N20 — `id` tie-break for stable order on equal ts.
        combined.sort(byCreatedAtThenId);
        s.messages[conversationId] = combined;
      }),
    })),
    {
      name: 'messenger-store-v1',
      // Audit fix #13 — debounced storage adapter coalesces a burst of
      // mutations into one AsyncStorage write per 500ms. See the
      // makeDebouncedJsonStorage doc comment for the durability tradeoff, and
      // for why B-633 moved the JSON.stringify inside that same window.
      storage: makeDebouncedJsonStorage(PERSIST_DEBOUNCE_MS, 'messengerStore'),
      // Persist the per-user vault. The current owner's live data is
      // continuously folded into vaultByOwner[ownerKey] on every flush
      // so re-login restores their threads. MESSAGES are NOT in the
      // vault — they live in SQLCipher (see sqlMessageStore.ts) per
      // the architecture spec, scoped per-user via the DB filename.
      partialize: (s) => {
        // Audit fix #15 — partialize runs against the latest committed
        // snapshot (already a plain object after immer's produce
        // returns), so the structural reference here is fine. We
        // explicitly take a SHALLOW copy of vaultByOwner so the
        // serializer doesn't accidentally share the live owner slice
        // with the in-memory state when the next mutation fires
        // BEFORE the AsyncStorage debounce flushes.
        //
        // Audit P0-S3 / P0-S5 — strip `masterKeyB64` from every group
        // before persisting to AsyncStorage. The real master key now
        // lives in the SQLCipher `group_master_keys` table, wrapped
        // under a separate keychain entry. AsyncStorage retains the
        // rest of the GroupState (membership, epoch, name, etc.) so
        // UI surfaces (group list, member chips) render with no
        // SQLCipher round-trip; the runtime warm-up path re-hydrates
        // masterKeyB64 into the live store from disk via
        // GroupMasterKeyStore.loadAll() at boot.
        const owner = s._ownUserId;
        const stripGroups = (groups: Record<string, GroupState>): Record<string, GroupState> => {
          const out: Record<string, GroupState> = {};
          for (const [gid, gs] of Object.entries(groups)) {
            out[gid] = {...gs, masterKeyB64: ''};
          }
          return out;
        };
        // Audit MSG-10 (2026-07-02): AsyncStorage is NOT encrypted, but each
        // conversation embeds `last_message` including the PLAINTEXT `content`
        // (and media keys). Persisting it here contradicts the store's own
        // contract that message bodies live only in SQLCipher, and it survives
        // a disappearing-message burn. Strip the body + media material from the
        // persisted last_message, keeping only the metadata the home list needs
        // for ordering/type; SQLCipher's loadRecent rehydrates the preview text
        // on boot.
        const stripLastMessage = (convos: Record<string, LocalConversation>): Record<string, LocalConversation> => {
          const out: Record<string, LocalConversation> = {};
          for (const [id, c] of Object.entries(convos)) {
            if (c.last_message) {
              out[id] = {...c, last_message: {
                ...c.last_message,
                content: '',   // MSG-10 — no plaintext body persisted at rest
              }};
            } else {
              out[id] = c;
            }
          }
          return out;
        };
        const liveSlice: VaultSlice = {
          conversations:     stripLastMessage(s.conversations),
          conversationOrder: s.conversationOrder,
          groups:            stripGroups(s.groups),
          groupMemberNames:  s.groupMemberNames,
          deptGroupByChannel: s.deptGroupByChannel,
          deptConversationIds: s.deptConversationIds,
          deptOrgByConversation: s.deptOrgByConversation,
        };
        // Defensive: also strip masterKeyB64 from any vaulted (inactive
        // owner) slice in case an older app version wrote them in plain.
        // This makes the migration self-healing without a one-shot script.
        const safeVault: Record<string, VaultSlice> = {};
        for (const [k, v] of Object.entries(s.vaultByOwner)) {
          safeVault[k] = {
            ...v,
            groups:        stripGroups(v.groups ?? {}),
            conversations: stripLastMessage(v.conversations ?? {}),  // MSG-10
          };
        }
        const vaultByOwner = owner
          ? {...safeVault, [owner]: liveSlice}
          : safeVault;
        return {
          _ownUserId:    s._ownUserId,
          vaultByOwner,
        } as typeof s;
      },
      onRehydrateStorage: () => (state, error) => {
        if (error) {
          console.log('[messengerStore] rehydrate error', error);
          return;
        }
        // Hydrate the active live slice from the vault for whoever was
        // last active. setOwner will swap to a different vault entry
        // shortly after (and snapshot back), so this is just a paint-
        // time placeholder for the most-recent-user.
        const owner = state?._ownUserId ?? null;
        const slice = owner ? state?.vaultByOwner?.[owner] : undefined;
        if (state && slice) {
          state.conversations     = slice.conversations     ?? {};
          state.conversationOrder = slice.conversationOrder ?? [];
          state.groups            = slice.groups            ?? {};
          state.groupMemberNames  = slice.groupMemberNames  ?? {};
          state.deptGroupByChannel = slice.deptGroupByChannel ?? {};
          state.deptConversationIds = slice.deptConversationIds ?? {};
          /**
           * vs2 edge A9 — RESTORED, not merely persisted.
           *
           * Omitting this made the whole fix a no-op on disk data that held the
           * right answer: the live map was `{}` at every boot, and
           * `resolveDeptRouteForTap` short-circuits on the LIVE store the
           * moment `deptConversationIds` knows the conversation — which IS
           * restored — so the persisted reader added for A9 was unreachable for
           * exactly the conversations it was added to answer.
           */
          state.deptOrgByConversation = slice.deptOrgByConversation ?? {};
        }
        // B-106 — hygiene sweep: drop chat-list rows for ad-hoc call groups
        // (exact BS-CALL-GHOST sentinel). Rows persisted before the create-
        // side guard landed (d435697), or resurrected by a backup restore,
        // otherwise show a ghost 'Call' group thread forever.
        if (state) {
          const pruned = pruneCallGroupGhostRows(state);
          if (pruned > 0) {
            console.log(`[messengerStore] B-106 pruned ${pruned} ad-hoc call-group ghost row(s)`);
          }
          // B-124/B-125 — heal devices contaminated before the topology fix
          // landed: drop call-key aliases filed at direct-shaped chat ids and
          // the impossible `direct:<self>` duplicate thread. Runs after the
          // B-106 sweep so a row removed there is not re-examined.
          const {aliases, rows} = pruneCallKeyContamination(state);
          if (aliases > 0 || rows > 0) {
            console.log(`[messengerStore] B-124 cleared ${aliases} call-key alias(es) + ${rows} self-slot ghost row(s)`);
          }
          // B-703 MR-3 — deliberately NOT repaired here. An earlier cut called
          // repairOrphanConversationRows at this point and it was dead code
          // that could only ever misfire: `messages` is not persisted, so it is
          // empty at rehydration unless a prior `set()` populated it — and that
          // same `set()` is what makes immer auto-freeze `conversations` /
          // `conversationOrder`, so the repair's writes would throw. A throw
          // here skips zustand's `hasHydrated = true` and its finish-hydration
          // listeners for the process lifetime, silently disabling the Home
          // screen's listMine reconcile and burning headlessDrain's 3 s wait on
          // every wake. The tombstone cache is also unarmed this early, so the
          // B-594 guard would be inert. MR-3 is covered where it belongs: the
          // hydrateMessages site re-derives from SQLCipher on the next boot
          // whatever this wholesale replace clobbered.
        }
        const convoCount = Object.keys(state?.conversations ?? {}).length;
        const vaultCount = Object.keys(state?.vaultByOwner ?? {}).length;
        console.log(`[messengerStore] rehydrated: ${convoCount} conversations · ${vaultCount} vaulted owners`);
      },
    },
  ),
);

/**
 * B-703 MR-2/MR-3 — give a message back the thread it belongs to.
 *
 * THE SYMPTOM: "I can see the message in the notification but not in the chat."
 *
 * Messages are durable — the receive txn commits them to SQLCipher and acks the
 * relay, so the envelope is gone from the server. The CONVERSATION row is not:
 * it lives in the zustand vault behind a 500 ms trailing debounce that resets on
 * every `set()`. Two independent ways it goes missing:
 *   - MR-2: the killed-app drain mints the row and Android freezes the headless
 *     VM before the debounce fires.
 *   - MR-3: `onRehydrateStorage` REPLACES `conversations` wholesale from the
 *     vault slice, so a row minted by an ingest that beat rehydration is
 *     clobbered.
 * Either way the message rows survive and `hydrateMessages` never mints a
 * conversation for them — it only patches rows that already exist. The thread
 * is then invisible in the chat list and the banner's tap resolves to nothing,
 * landing the user on the home screen.
 *
 * This is a REPAIR, not a new minter: it re-derives what was lost from the rows
 * that survived, and it is idempotent. Run it after BOTH hydration paths so
 * whichever lands last heals the other.
 *
 * It honours every rule the live minter honours, because resurrecting the wrong
 * thing is worse than the bug: a deleted conversation stays deleted (B-594
 * tombstone, consulted with the NEWEST row's composed time so genuinely newer
 * traffic still lifts it), `direct:<self>` is never a chat (B-124), an ad-hoc
 * call group never grows a chat-list row (B-106), and a peer that already has a
 * server-UUID row does not get a synthetic twin (the home list would show the
 * same peer twice; ChatScreen already unions both slots).
 *
 * Returns the number of rows repaired.
 */
export function repairOrphanConversationRows(state: {
  conversations: Record<string, LocalConversation>;
  conversationOrder: string[];
  messages: Record<string, LocalMessage[]>;
  groups: Record<string, GroupState>;
  _ownUserId?: string | null;
}): number {
  const convos = state.conversations ?? {};
  const messages = state.messages ?? {};
  let repaired = 0;

  for (const [conversationId, list] of Object.entries(messages)) {
    if (convos[conversationId] || !list || list.length === 0) {continue;}
    // B-124 — you have no 1:1 with yourself; that slot is call-key residue.
    if (state._ownUserId && conversationId === `direct:${state._ownUserId}`) {continue;}
    // B-106 — an ad-hoc call group keeps its messages but never a chat row.
    if (isCallGroupState(state.groups?.[conversationId])) {continue;}
    // ...and for a GROUP id, require real group state to exist at all. A row
    // this device can legitimately show is one it holds key material for; an
    // ad-hoc call slot restored from the SERVER listing (suppressed there by
    // name + is_custom_name, which this repair cannot see) has none, and
    // minting "Group chat" for it would resurrect the very B-106 ghost the
    // restore just refused. A real group whose row went missing is re-listed
    // by /conversations/mine, so this costs nothing.
    if (!conversationId.startsWith('direct:') && !state.groups?.[conversationId]) {continue;}

    // B-594 — the user deleted this thread, so leave it deleted. The PLAIN
    // check on purpose: `suppressResurrection` is the live/replay
    // discriminator and it CLEARS the tombstone as a side effect outside a
    // replay bracket, which a boot repair must never do. Lifting is the live
    // receive path's job — if a genuinely newer message had arrived, that path
    // would already have cleared this and minted the row, so a tombstone still
    // standing here means the rows on disk are pre-delete residue.
    if (isConversationTombstoned(conversationId)) {continue;}
    const newest = list.reduce((a, b) => (b.created_at >= a.created_at ? b : a));

    if (conversationId.startsWith('direct:')) {
      const peerId = peerFromDirectSlot(conversationId);
      if (!peerId) {continue;}
      // A server-UUID row for the same peer already fronts this thread.
      const hasServerRow = Object.entries(convos).some(
        ([id, c]) => c.type === 'direct' && c.peer?.userId === peerId && !id.startsWith('direct:'),
      );
      if (hasServerRow) {continue;}
      const peer = list.find(m => m.peer?.userId === peerId)?.peer ?? {userId: peerId, deviceId: 1};
      convos[conversationId] = directPlaceholderConversation(
        conversationId, peerId, peer, newest.created_at,
      );
    } else {
      // The guard above proved GroupState exists, and it carries both the real
      // name and the member roster — `partialize` strips only `masterKeyB64`.
      // Use them: 'Group chat' with a single participant would not just look
      // wrong, it would SEND wrong. The fan-out targets `participants` (the L9
      // rule at setGroupState), nothing re-syncs a repaired row at boot (the
      // group-key warm-up uses setState, not setGroupState), and B-703's whole
      // point is that the banner tap now lands in this repaired thread — so a
      // user replying here would encrypt to one member and silently miss the
      // rest until the next /conversations/mine.
      const gs = state.groups?.[conversationId] as
        {name?: string; members?: Record<string, unknown>} | undefined;
      const members = Object.keys(gs?.members ?? {});
      convos[conversationId] = {
        id:            conversationId,
        type:          'group',
        name:          gs?.name || 'Group chat',
        participants:  members.length > 0
          ? members
          : (newest.peer ? [newest.peer.userId] : []),
        peer:          newest.peer ?? {userId: '', deviceId: 1},
        session_state: 'fresh',
        unread_count:  0,
        is_muted:      false,
        created_at:    newest.created_at,
      } as LocalConversation;
    }
    convos[conversationId].last_message = newest;
    if (!state.conversationOrder.includes(conversationId)) {
      state.conversationOrder.unshift(conversationId);
    }
    repaired += 1;
  }
  return repaired;
}

/**
 * B-106 — remove chat-list rows that belong to ad-hoc call groups, in
 * place. A row is a ghost when it is a group row the user never renamed
 * (is_custom_name unset) AND either its crypto state carries the exact
 * BS-CALL-GHOST sentinel name 'Call' or the row itself is named 'Call'.
 * A user-renamed group ("Call + x") is never touched — pinned by
 * adhocCallKeyLookup.test.ts's exact-sentinel semantics. Returns the
 * number of rows removed. Called from onRehydrateStorage at every boot.
 */
export function pruneCallGroupGhostRows(state: {
  conversations: Record<string, LocalConversation>;
  conversationOrder: string[];
  groups: Record<string, GroupState>;
}): number {
  const groups = state.groups ?? {};
  const convos = state.conversations ?? {};
  const ghostIds = Object.keys(convos).filter(id => {
    const row = convos[id];
    if (!row || row.type !== 'group' || row.is_custom_name) {return false;}
    return isCallGroupState(groups[id]) || isCallGroupName(row.name);
  });
  if (ghostIds.length > 0) {
    for (const id of ghostIds) {delete convos[id];}
    state.conversationOrder = (state.conversationOrder ?? []).filter(id => !ghostIds.includes(id));
  }
  return ghostIds.length;
}

/**
 * B-124/B-125 — heal devices already contaminated by call escalation.
 *
 * The code fix (messagingLogic's `direct` veto) stops NEW contamination, but
 * an affected device keeps its persisted wreckage forever: `ensureCallGroupKey`
 * files a throwaway `'Call'` GroupState onto chat-bearing direct-shaped ids
 * (`direct:<own userId>` and the originating 1:1 id), nothing ever un-aliases
 * them, the ad-hoc group is never registered server-side so /conversations/mine
 * cannot reconcile it, and neither existing prune can reach it —
 * `pruneCallGroupGhostRows` skips `type !== 'group'` and MessengerHomeScreen's
 * sweep only matches dashed UUIDs.
 *
 * Two precise signals, both of which survive `partialize` (it strips only
 * `masterKeyB64`; the doc comment above it confirms `name` is retained):
 *
 *  1. GROUP-KEY ALIASES — `direct:`-shaped id carrying the exact `'Call'`
 *     sentinel. A real group id is a server UUID or 32-hex and is NEVER
 *     `direct:`-prefixed, so this cannot match a genuine group. This is why the
 *     sweep is safe here even though masterKeyB64 has been stripped at
 *     rehydrate: it keys off the id SHAPE and the name, never off key presence.
 *
 *  2. THE SELF-SLOT ROW — `direct:<own userId>`. You can never hold a 1:1 with
 *     yourself, so such a row is definitionally invalid. This is the duplicate
 *     thread the user sees, relabelled with the peer's name by the home list.
 *
 * Deliberately NOT used as a signal: "has a 'Call' alias and <= 1 participant".
 * The `:4442-4443` alias targets the ORIGINATING conversation — a real chat —
 * and a cold-contact row legitimately has `participants: [peer]`, so that rule
 * would delete a genuine conversation. Removing its alias (1) is enough to
 * un-break it; the row itself must be left alone.
 *
 * `s.messages` is intentionally untouched — orphaned rows are invisible and
 * harmless, and deleting them would destroy real user messages that were
 * mis-routed into the ghost. Same convention as pruneCallGroupGhostRows.
 */
/**
 * B-131 — keep `conversations[cid].last_message.status` in step with the message
 * it is a copy of.
 *
 * `last_message` is a SNAPSHOT taken when the message was appended, so every
 * later status transition (sent → delivered → read) landed only on the row in
 * `s.messages` and the conversation-list copy stayed frozen at its send-time
 * value. The list therefore could not show a truthful tick even once it was
 * pointed at the right field.
 *
 * Only touches the row when the updated message IS the current last message —
 * a receipt for an older message must not rewrite the newest one's tick.
 */
function syncLastMessageStatus(
  s: {conversations: Record<string, LocalConversation>},
  conversationId: string,
  messageId: string,
  status: LocalMessage['status'],
): void {
  const last = s.conversations[conversationId]?.last_message;
  if (last && last.id === messageId && !isStatusRegression(last.status, status)) {
    last.status = status;
  }
}

/**
 * Keep the chat-list preview in step when a message's BODY changes under it.
 *
 * `last_message` is a full row snapshot, not a pointer, so editing or
 * tombstoning the newest message patches `messages[]` and leaves the home-list
 * preview showing the old text. For a delete-for-everyone that is a leak in the
 * most visible place in the app: the author retracts a message and the chat
 * list keeps rendering it. `syncLastMessageStatus` is the same idea for the
 * tick; this is the idea for the content.
 *
 * Only the row that IS the preview is touched — an edit to an older message
 * must not promote it over a newer one (OM-06).
 */
function syncLastMessagePreview(
  s: {conversations: Record<string, LocalConversation>},
  conversationId: string,
  patched: LocalMessage,
): void {
  const convo = s.conversations[conversationId];
  if (convo?.last_message?.id === patched.id) {
    convo.last_message = patched;
  }
}

export function pruneCallKeyContamination(state: {
  conversations:     Record<string, LocalConversation>;
  conversationOrder: string[];
  groups:            Record<string, GroupState>;
  _ownUserId?:       string | null;
}): {aliases: number; rows: number} {
  const groups = state.groups ?? {};
  const convos = state.conversations ?? {};

  const aliasIds = Object.keys(groups).filter(
    id => isDirectPrefixed(id) && isCallGroupState(groups[id]),
  );
  for (const id of aliasIds) {delete groups[id];}

  const owner = state._ownUserId ?? null;
  const selfSlot = owner ? `direct:${owner}` : null;
  let rows = 0;
  if (selfSlot && convos[selfSlot]) {
    delete convos[selfSlot];
    state.conversationOrder = (state.conversationOrder ?? []).filter(id => id !== selfSlot);
    rows = 1;
  }

  return {aliases: aliasIds.length, rows};
}

// Stable empty-array singleton — returning a fresh `[]` from a Zustand
// selector on every render creates a new reference each time, which
// triggers "Maximum update depth exceeded" in React 18+. Keep one
// frozen reference and hand it out for every empty conversation.
export const EMPTY_MESSAGES: readonly LocalMessage[] = Object.freeze([]);

/**
 * Audit fix #17 — selectMessages used to return a freshly minted closure
 * every render: `useMessengerStore(selectMessages(id))` allocated a new
 * selector function each time, which forced zustand to re-run the inner
 * lookup and re-subscribe. The recommended pattern is to inline at the
 * call site: `useMessengerStore(s => s.messages[id] ?? EMPTY_MESSAGES)`.
 *
 * This export remains for backward compat (ChatScreen still uses it),
 * but new call sites should inline the selector. Marked `@deprecated`
 * so future eslint rules can catch it.
 *
 * @deprecated inline at call site:
 *   `useMessengerStore(s => s.messages[id] ?? EMPTY_MESSAGES)`
 */
export const selectMessages = (conversationId: string) =>
  (s: MessengerState): readonly LocalMessage[] =>
    s.messages[conversationId] ?? EMPTY_MESSAGES;

export const selectConversation = (conversationId: string) =>
  (s: MessengerState): LocalConversation | undefined => s.conversations[conversationId];

/**
 * Resolve the canonical conversation id for a 1:1 chat with `peerUserId`.
 *
 * Why: navigation, send, and receive all need to agree on ONE
 * conversation id per peer. Some entry points have historically passed
 * the synthetic `direct:<peerUserId>` key (NewChat / push tap / incoming
 * call) while others pass the server-issued UUID (Home list tap /
 * /conversations/mine sync). When both rows exist for the same peer,
 * inbound messages, outbound messages, and the open ChatScreen could
 * each land on different slots — split-brain. Centralise the rule:
 * if a server-UUID direct row exists for this peer, that's the
 * canonical id; otherwise fall back to the synthetic `direct:<peer>`
 * which the runtime's shadow-create branch will auto-mint on first
 * inbound.
 *
 * Callers: see `resolveDirectConversationIdFromState` for an
 * imperative variant usable from non-React code (productionRuntime
 * receive path, sendText resolver, MainNavigator push tap, etc.).
 */
export function resolveDirectConversationIdFromState(
  s: Pick<MessengerState, 'conversations'>,
  peerUserId: string,
): string {
  for (const [id, convo] of Object.entries(s.conversations)) {
    if (convo.type !== 'direct') {continue;}
    if (convo.peer?.userId !== peerUserId) {continue;}
    // Prefer server-UUID over synthetic `direct:` key.
    if (!id.startsWith('direct:')) {return id;}
  }
  // No server-UUID row found — try the synthetic key directly.
  const synthetic = `direct:${peerUserId}`;
  if (s.conversations[synthetic]) {return synthetic;}
  // Cold contact, no row yet — caller can use this as the shadow-create
  // key; subsequent /conversations/mine sync will replace with UUID.
  return synthetic;
}

/**
 * B-18 — every store slot that may hold a given conversation's messages.
 *
 * A 1:1 (direct) thread can have its history SPLIT across two slots: the
 * synthetic `direct:<peer>` key and a server-UUID row. The canonical slot
 * (`resolveDirectConversationIdFromState`, used by both `sendText` and the
 * inbound append) shifts to the UUID the moment `/conversations/mine` syncs
 * a row — so a message sent before the sync lands in the synthetic slot and
 * one received after lands in the UUID slot. ChatScreen is pinned to its
 * route-param id, so without merging one side goes invisible.
 *
 * Returns every direct slot that maps to this peer (route id + synthetic +
 * any server-UUID direct row for the peer) so render + mark-read can cover
 * them all. Groups and ids with no resolvable peer return `[conversationId]`.
 */
export function directConversationSlots(
  s: Pick<MessengerState, 'conversations' | 'groups'>,
  conversationId: string,
): string[] {
  const conv = s.conversations[conversationId];
  // M2 — ask the ONE topology rule. The inline `type === 'group'` copy said
  // "not a group" for a group whose key material had landed before its
  // /conversations/mine row, and then tried to resolve a PEER for it — merging
  // unrelated direct slots into a group thread.
  if (isGroupConversation(s, conversationId)) {return [conversationId];}
  const peerUid = conv?.peer?.userId
    ?? (isDirectPrefixed(conversationId) ? peerFromDirectSlot(conversationId) : undefined);
  if (!peerUid) {return [conversationId];}
  const slots = new Set<string>([conversationId, `direct:${peerUid}`]);
  for (const [id, c] of Object.entries(s.conversations)) {
    if (c.type === 'direct' && c.peer?.userId === peerUid) {slots.add(id);}
  }
  return Array.from(slots);
}

/**
 * Round 6 / perf — memoised cross-conversation derivations.
 *
 * Three screens (CallsLog, Files, Groups) need to fold every
 * conversation's message list into a single derived view. The naive
 * pattern `useMessengerStore(s => s.messages)` re-rendered the whole
 * screen on EVERY message append — including appends to chats the
 * screen doesn't display — because zustand's default ref-equality flips
 * whenever immer mints a new `messages` map (which happens on every
 * mutation).
 *
 * Solution: per-screen selector that returns a NARROW derived shape;
 * cached via WeakMap keyed on the live `messages` map. Because immer
 * produces a fresh top-level reference whenever any nested message
 * changes, the WeakMap key naturally invalidates → recompute happens at
 * most ONCE per state change, not per consumer. Consumers wrap the
 * selector in `useShallow` so two recomputes that produce the same
 * shape (e.g. an append to a different conversation that doesn't move
 * any of OUR derived rows) skip the re-render.
 *
 * The WeakMap also bounds memory: when the store mutates again, the old
 * `messages` reference becomes unreachable and the GC can collect the
 * cache entry. Net cost: one extra reference per derivation, freed on
 * the next mutation.
 */
type MessagesMap = Record<string, LocalMessage[]>;

const callMessagesCache = new WeakMap<MessagesMap, readonly LocalMessage[]>();
/**
 * All `type === 'call'` messages across every conversation, sorted
 * newest-first by `created_at`. Used by CallsLogScreen.
 */
export const selectCallMessages = (s: MessengerState): readonly LocalMessage[] => {
  const map = s.messages;
  const cached = callMessagesCache.get(map);
  if (cached) {return cached;}
  const out: LocalMessage[] = [];
  for (const list of Object.values(map)) {
    for (const m of list) {
      if (m.type === 'call' && m.call_meta) {out.push(m);}
    }
  }
  out.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const frozen = Object.freeze(out);
  callMessagesCache.set(map, frozen);
  return frozen;
};

const mediaMessagesCache = new WeakMap<MessagesMap, readonly LocalMessage[]>();
/**
 * All attachment-bearing messages (`type` ∈ {image, audio, file}) across
 * every conversation, sorted newest-first by `created_at`. Used by
 * FilesScreen. The screen still buckets by mime type at the call site.
 */
export const selectMediaMessages = (s: MessengerState): readonly LocalMessage[] => {
  const map = s.messages;
  const cached = mediaMessagesCache.get(map);
  if (cached) {return cached;}
  const out: LocalMessage[] = [];
  for (const list of Object.values(map)) {
    for (const m of list) {
      // Audit MSG-13 — 'video' was omitted, so videos never appeared in the
      // per-chat media/Files surface.
      if (m.type === 'image' || m.type === 'audio' || m.type === 'video' || m.type === 'file') {out.push(m);}
    }
  }
  out.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const frozen = Object.freeze(out);
  mediaMessagesCache.set(map, frozen);
  return frozen;
};

const lastByConvCache = new WeakMap<MessagesMap, Record<string, LocalMessage>>();
/**
 * `{conversationId: lastMessage}` map. Used by GroupsScreen for
 * preview text + sort key. Returning the last bubble (not the whole
 * list) means an append to a chat we already reflect doesn't churn
 * the derived shape unless the LAST message of that chat changed.
 */
export const selectLastMessageByConv = (s: MessengerState): Record<string, LocalMessage> => {
  const map = s.messages;
  const cached = lastByConvCache.get(map);
  if (cached) {return cached;}
  const out: Record<string, LocalMessage> = {};
  for (const [id, list] of Object.entries(map)) {
    const last = list[list.length - 1];
    if (last) {out[id] = last;}
  }
  lastByConvCache.set(map, out);
  return out;
};
