/**
 * B-691 / F4 — the tap→transitionEnd bracket for a chat open.
 *
 * Why: none of the repo's perf probes covered the exact interaction the
 * founder complains about (tap a chat row → thread visible), so every prior
 * chat-open number was a gfxinfo aggregate. The list row marks the tap here;
 * ChatScreen consumes the mark when its open transition ends and emits ONE
 * `[LAGDIAG] [chat.open]` warn (warn survives release builds; ids only).
 * Module state, not a store: a probe must never cause a commit.
 */
let tapMark: {id: string; t: number} | null = null;

/** A mark older than this is a tap whose navigation never landed — a later
 *  open of the same conversation must not inherit its timestamp. */
const TAP_MARK_TTL_MS = 10_000;

export function markChatOpenTap(conversationId: string): void {
  tapMark = {id: conversationId, t: Date.now()};
}

/** The tap timestamp for this conversation, or null; reading burns the mark. */
export function takeChatOpenTap(conversationId: string): number | null {
  if (tapMark?.id !== conversationId) {return null;}
  const t = tapMark.t;
  tapMark = null;
  return Date.now() - t > TAP_MARK_TTL_MS ? null : t;
}
