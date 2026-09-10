/**
 * Reaction folding + the "who reacted" roster.
 *
 * B-282 — extracted out of `ChatScreen.tsx` so these can be unit-tested for real.
 * The node Jest project cannot import `ChatScreen.tsx` (it pulls in react-native
 * and mounts views), which is why the rest of that screen is only reachable by
 * source scan. Pure logic belongs in a sibling module — same reason
 * `sendErrorText.ts`, `conversationListOrder.ts` and `senderColors.ts` live here.
 *
 * Nothing in here touches the wire. `LocalMessage.reactions` has always been
 * `Record<reactorUserId, emoji>` (`{'u-alice': '❤️', 'u-bob': '😂'}`); the client
 * simply discarded the key when rendering.
 */

/** The self key the store uses for the viewing user's own reaction. */
const SELF = 'self';

/**
 * Fold per-user reactions into one entry per emoji, KEEPING the reactors.
 *
 * `who` is the fix: this used to read the userId and drop it, returning only a
 * count, so "who reacted?" was unanswerable in the UI even though the data was
 * right there. Insertion order is preserved, so a roster reads in the order the
 * reactions arrived.
 */
export function groupReactions(
  reactions: Record<string, string>,
): Array<{emoji: string; count: number; mine: boolean; who: string[]}> {
  const byEmoji = new Map<string, {count: number; mine: boolean; who: string[]}>();
  for (const [who, emoji] of Object.entries(reactions)) {
    const cur = byEmoji.get(emoji) ?? {count: 0, mine: false, who: []};
    cur.count += 1;
    if (who === SELF) {cur.mine = true;}
    cur.who.push(who);
    byEmoji.set(emoji, cur);
  }
  return Array.from(byEmoji.entries()).map(([emoji, v]) => ({emoji, ...v}));
}

/**
 * Flat "who reacted with what" roster, your own reaction first and labelled
 * "You" the way WhatsApp does.
 *
 * `resolveName` is the caller's directory lookup. It returns undefined for a
 * userId the client has never seen — a member who left, or a roster that has not
 * hydrated yet — and those fall back to a truncated id rather than rendering
 * `undefined` (DESIGN_REVIEW_LOOP §3.5). The trailing ellipsis is load-bearing:
 * the screen keys its single batched directory request off it.
 */
export function reactionRoster(
  reactions: Record<string, string>,
  resolveName: (userId: string) => string | undefined,
): Array<{userId: string; label: string; emoji: string; isSelf: boolean}> {
  const rows = Object.entries(reactions).map(([userId, emoji]) => ({
    userId,
    emoji,
    isSelf: userId === SELF,
    label: userId === SELF
      ? 'You'
      : resolveName(userId) ?? `${userId.slice(0, 8)}…`,
  }));
  return rows.sort((a, b) => Number(b.isSelf) - Number(a.isSelf));
}

/**
 * Screen-reader label for the reaction row. The row is a button made of bare
 * emoji glyphs, which announces as nothing actionable without this.
 */
export function reactionsA11yLabel(reactions: Record<string, string>): string {
  const n = Object.keys(reactions).length;
  return `${n} ${n === 1 ? 'reaction' : 'reactions'}. Tap to see who reacted.`;
}
