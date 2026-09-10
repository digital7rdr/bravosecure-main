/**
 * BS-RECENTS — picker rows for people you ALREADY chat with.
 *
 * The New-Chat / Add-to-group picker's only people-source was contact
 * discovery (address book → /users/lookup), so a peer reached via
 * "Message by Number" — who is not in the phone's address book — could
 * never be picked: not addable to a group, invisible while creating one,
 * and completely absent when contacts permission is denied. WhatsApp
 * parity: anyone with an existing 1:1 thread is pickable.
 *
 * Pure derivation from store conversations so the node Jest project can
 * test it without mounting the screen.
 */
import type {DiscoveredRow} from './useDiscoveredContacts';

export interface RecentPeerConversationLike {
  type?:         string;
  name?:         string;
  peer?:         {userId: string; deviceId: number} | undefined;
  phoneE164?:    string;
  created_at?:   string;
  last_message?: {created_at?: string} | undefined;
}

/** ISO timestamps compare correctly as strings; missing sorts oldest. */
function activityStamp(c: RecentPeerConversationLike): string {
  return c.last_message?.created_at ?? c.created_at ?? '';
}

/**
 * Direct-chat peers as picker rows, newest activity first.
 *
 * - direct conversations with a known peer only (groups have no single peer)
 * - `excludeUserIds` drops peers another section already lists (contact
 *   discovery, dev contacts) and self — the caller owns that policy
 * - one row per peer even when a synthetic `direct:<uid>` row AND a
 *   canonical server-UUID row coexist (the BS-NC1 split-brain shape):
 *   the row with the newer activity wins, a named row beats an unnamed one
 */
export function recentDirectPeers(
  conversations: Record<string, RecentPeerConversationLike | undefined>,
  excludeUserIds: Iterable<string>,
): DiscoveredRow[] {
  const excluded = new Set(excludeUserIds);
  const byPeer = new Map<string, RecentPeerConversationLike>();
  for (const conv of Object.values(conversations)) {
    if (!conv || conv.type !== 'direct') {continue;}
    const uid = conv.peer?.userId;
    if (!uid || excluded.has(uid)) {continue;}
    const prev = byPeer.get(uid);
    if (!prev) {byPeer.set(uid, conv); continue;}
    const a = activityStamp(conv);
    const b = activityStamp(prev);
    if (a > b || (a === b && !!conv.name && !prev.name)) {byPeer.set(uid, conv);}
  }
  return Array.from(byPeer.entries())
    .sort(([, a], [, b]) => (activityStamp(a) < activityStamp(b) ? 1 : -1))
    .map(([userId, conv]) => ({
      userId,
      displayName: conv.name ?? '',
      avatarUrl:   null,
      phoneE164:   conv.phoneE164 ?? '',
      localName:   conv.name || conv.phoneE164 || 'Bravo contact',
    }));
}
