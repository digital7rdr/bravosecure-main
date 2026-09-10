/**
 * SYNC-7 — the reaction map merge rule, in one place.
 *
 * Kept in its own module (no runtime/native imports) so both the receive path
 * and the pending-reaction drain can be unit-tested without standing up the
 * messenger runtime — same rationale as `outboxCertFreshness.ts`.
 *
 * Semantics: one emoji per reactor. A later reaction from the same user
 * replaces the earlier one; `remove` deletes that user's entry. Replaying the
 * same patch is therefore idempotent, which is what lets a stashed reaction be
 * applied twice without corrupting the map.
 */
export function mergeReaction(
  current: Record<string, string> | undefined,
  fromUserId: string,
  emoji: string,
  remove: boolean,
): Record<string, string> {
  const next: Record<string, string> = {...(current ?? {})};
  if (remove) {
    delete next[fromUserId];
  } else {
    next[fromUserId] = emoji;
  }
  return next;
}
