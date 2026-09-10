/**
 * Founder 2026-08-24 — the forward/share picker's target list, as pure
 * decisions (`ForwardList` in ChatScreen.tsx renders exactly this module's
 * answers; B-623's review showed a source scan cannot pin a decision, so the
 * decisions live where tests can execute them).
 *
 *   1. INDIVIDUALS is a UNION: existing 1:1 conversations (recent-first,
 *      unchanged) plus every discovered Bravo contact with NO conversation
 *      yet (alphabetical, below them) — "it's only picking up my last 2
 *      chats" was the conversations-only list.
 *   2. One search box filters all sections by name, case-folded.
 */

export interface ForwardConversationLike {
  id: string;
  type?: string;
  name?: string | null;
  peer?: {userId: string} | null;
}

export interface ForwardContactLike {
  userId: string;
  displayName: string;
  localName: string;
}

/** The name a picker row shows (and searches) for a contact. */
export function contactRowName(c: ForwardContactLike): string {
  return c.localName || c.displayName;
}

export function matchesForwardQuery(name: string, query: string): boolean {
  const q = query.trim().toLocaleLowerCase();
  return !q || name.toLocaleLowerCase().includes(q);
}

/**
 * Contacts worth their own row: registered, not the user themself, and not
 * already present as a 1:1 conversation (the conversation row wins — it has
 * recency and a message preview). Alphabetical by the shown name.
 */
export function contactsWithoutConversation<C extends ForwardContactLike>(
  discovered: readonly C[],
  conversationRows: readonly ForwardConversationLike[],
  currentUserId: string | null,
  query: string,
): C[] {
  const knownPeers = new Set(
    conversationRows
      .filter(c => c.type !== 'group')
      .map(c => c.peer?.userId)
      .filter((id): id is string => !!id),
  );
  return discovered
    .filter(m => !!m.userId && m.userId !== currentUserId && !knownPeers.has(m.userId))
    .filter(m => matchesForwardQuery(contactRowName(m), query))
    .sort((a, b) => contactRowName(a).localeCompare(contactRowName(b)));
}

/** The conversation buckets, query-filtered, order preserved. */
export function bucketConversations<T extends ForwardConversationLike>(
  rows: readonly T[],
  query: string,
): {individuals: T[]; groups: T[]} {
  const individuals = rows.filter(
    c => c.type !== 'group' && matchesForwardQuery(c.name ?? c.peer?.userId ?? '', query),
  );
  const groups = rows.filter(
    c => c.type === 'group' && matchesForwardQuery(c.name ?? '', query),
  );
  return {individuals, groups};
}
