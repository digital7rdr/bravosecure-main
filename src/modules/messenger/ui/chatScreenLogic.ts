import type {SessionAddress} from '@bravo/messenger-core';
import type {LocalMessage} from '../store/types';
import {isDirectPrefixed, peerFromDirectSlot} from '../conversationIds';

/**
 * Pure presentation logic lifted out of `ChatScreenInner` (1,666 lines, zero
 * tests). Sibling of `chatListItems.ts`, which set the precedent.
 *
 * These four were `useMemo` bodies. Nothing in them needs React — they are
 * (state) -> (value) functions — so keeping them inline meant they could only be
 * exercised by rendering a screen that needs native modules, i.e. never. Moving
 * them out is the cheapest way to get `ChatScreenInner` under test at all.
 *
 * See docs/runbooks/MESSAGE_LOOP.md — the ChatScreenInner item.
 */

export interface ConversationLike {
  type?:         string;
  peer?:         {userId: string; deviceId: number} | undefined;
  participants?: string[] | undefined;
}

/**
 * The peer a 1:1 chat is with.
 *
 * The `direct:` fallback matters: a chat opened from NewChat / a push tap / an
 * incoming call may have no conversation row yet, and the peer id is recoverable
 * from the synthetic id itself. Without it the composer has nobody to send to on
 * exactly the entry points where a first message is most likely.
 */
export function resolvePeer(
  conversation: ConversationLike | undefined,
  conversationId: string,
): SessionAddress | undefined {
  if (conversation?.peer?.userId) {return conversation.peer;}
  if (isDirectPrefixed(conversationId)) {
    return {userId: peerFromDirectSlot(conversationId), deviceId: 1};
  }
  return undefined;
}

/**
 * Fan-out targets: every member except self.
 *
 * Drives presence subscribe, typing fan-out and read-receipt routing. Collapses
 * to `[peer]` for a 1:1. The `uid !== 'self'` filter is not redundant with the
 * ownUserId check — 'self' is a literal sentinel that appears in participant
 * lists from some server rows, and leaking it produces a subscribe for a user
 * id that cannot exist.
 */
export function groupFanoutPeers(
  conversation: ConversationLike | undefined,
  isGroup: boolean,
  ownUserId: string | undefined,
): SessionAddress[] {
  if (!conversation) {return [];}
  if (isGroup) {
    return (conversation.participants ?? [])
      .filter(uid => uid && uid !== 'self' && uid !== ownUserId)
      .map(uid => ({userId: uid, deviceId: 1}));
  }
  if (conversation.peer?.userId) {return [conversation.peer];}
  return [];
}

export type RuntimeMode = string | undefined;

export function isLoopbackMode(mode: RuntimeMode): boolean {
  return mode === 'loopback-memory' || mode === 'loopback-sqlcipher';
}

/** The banner above the list: error > not-ready > loopback > nothing. */
export function chatStatusLabel(args: {
  error?: string | null;
  ready:  boolean;
  mode:   RuntimeMode;
  /** True while this group's master key is still being synced (merge: B-121 lane). */
  groupKeyPending?: boolean;
}): string | null {
  if (args.error) {return `Error: ${args.error}`;}
  if (!args.ready) {return 'Initializing secure session…';}
  // Ranks ABOVE the loopback notice: a user who cannot send yet needs to be told
  // why, and loopback is a dev-only banner.
  if (args.groupKeyPending) {
    return 'Syncing this group’s encryption key — you can send once it arrives.';
  }
  if (isLoopbackMode(args.mode)) {
    return 'LOOPBACK MODE — messages echo back to verify crypto';
  }
  return null;
}

/**
 * Warm-start FIX-05 — what an EMPTY thread should say.
 *
 * "No messages yet." is a claim about the server, and until now the client had
 * no basis for it: an empty thread and a thread whose 1000-envelope bootstrap
 * page was still draining rendered identically. On a cold boot with a backlog
 * that reads as data loss.
 *
 * Returns null when the caller should render its normal empty state.
 */
export function chatEmptyStateLabel(args: {
  ready: boolean;
  syncState: 'idle' | 'syncing' | 'synced';
}): string | null {
  if (!args.ready) {return null;}          // the status banner already speaks
  if (args.syncState === 'syncing') {return 'Syncing your messages…';}
  // 'idle' means no drain has run yet this session — still not a basis for
  // claiming the thread is empty.
  if (args.syncState === 'idle') {return 'Syncing your messages…';}
  return null;
}

export interface TypingLabelArgs {
  typingUserIds:    Record<string, unknown> | undefined;
  /** GROUPS only — a 1:1 keeps the plain dots, its header already names the peer. */
  isGroup:          boolean;
  /** Name precedence, highest first (B-115). */
  groupMemberNames: Record<string, string> | undefined;
  directoryNames:   Record<string, string> | undefined;
  /** Name of the peer's own `direct:` thread, if one is known. */
  directThreadName: (userId: string) => string | undefined;
}

/**
 * B-117 — WhatsApp-parity named typing label for groups.
 *
 * Name precedence mirrors B-115: manual group override > directory name > known
 * direct-thread name > id fragment. The fragment fallback is what keeps the
 * label from reading "undefined is typing" for someone not yet in any directory.
 */
export function typingLabel(args: TypingLabelArgs): string | undefined {
  const ids = Object.keys(args.typingUserIds ?? {});
  if (ids.length === 0) {return undefined;}
  if (!args.isGroup) {return undefined;}

  const nameOf = (id: string): string =>
    args.groupMemberNames?.[id] ??
    args.directoryNames?.[id] ??
    args.directThreadName(id) ??
    id.slice(0, 8);

  const names = ids.map(nameOf);
  if (names.length === 1) {return `${names[0]} is typing`;}
  if (names.length === 2) {return `${names[0]} and ${names[1]} are typing`;}
  return `${names[0]} +${names.length - 1} are typing`;
}

/**
 * B-264 — the receipt time shown in the "Message info" sheet.
 *
 * Same day → the clock time alone ("3:18 pm"), which is the common case and
 * the only thing WhatsApp shows there. Older than today the bare clock is
 * ambiguous and actively misleading — "3:18 pm" on a message from last week
 * reads as today — so the date is prepended.
 *
 * `now` is injectable so the day boundary is testable without freezing the
 * clock. A non-finite or missing ts yields '' rather than "Invalid Date".
 */
export function messageInfoTime(ts: number | undefined, now: number = Date.now()): string {
  if (ts === undefined || !Number.isFinite(ts) || ts <= 0) {return '';}
  const at = new Date(ts);
  const today = new Date(now);
  const sameDay =
    at.getFullYear() === today.getFullYear() &&
    at.getMonth() === today.getMonth() &&
    at.getDate() === today.getDate();
  const clock = at.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
  if (sameDay) {return clock;}
  return `${at.toLocaleDateString([], {day: '2-digit', month: 'short'})} ${clock}`;
}

/**
 * Build a short plaintext preview for the reply strip. Caps at 200
 * chars, collapses newlines, and falls back to a type icon label for
 * non-text messages so the recipient still sees context.
 */
export function previewForReply(msg: LocalMessage): string {
  // Why: the reply affordance is hidden for tombstones, but a stale
  // action sheet / swipe can still race one in — never quote deleted content.
  if (msg.deleted_for_all) {return 'Message deleted';}
  if (msg.type === 'image') {return '📷 Photo';}
  if (msg.type === 'file')  {return '📎 Attachment';}
  if (msg.type === 'audio') {return '🎤 Voice message';}
  if (msg.type === 'video') {return '🎬 Video';}
  const s = (msg.content ?? '').replace(/\s+/g, ' ').trim();
  return s.length > 200 ? s.slice(0, 199) + '…' : s;
}
