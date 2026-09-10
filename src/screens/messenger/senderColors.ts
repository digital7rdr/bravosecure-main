/**
 * Per-sender bubble colours for departmental chat.
 *
 * Lives outside the screen so it can be unit-tested for real: the screen pulls
 * in expo-clipboard / rn-emoji-keyboard, which the Jest transform can't parse,
 * so anything defined inside it is only reachable by a source scan.
 *
 * The sender's colour tints the NAME and the left rule, the way a normal
 * messenger thread does. A short-lived variant painted the whole bubble in it;
 * that was reverted on request, along with the contrast helpers it needed.
 */

// Stable per-sender colour: hash the id so a person keeps the same colour
// across messages and across devices (the brief: "in their assigned colour").
export const ROLE_COLORS = ['#60A5FA', '#34d399', '#F59E0B', '#A78BFA', '#F472B6', '#22D3EE'];

// B-286 — accepts null. ChatScreen used to keep its own copy of this function
// purely for that hardening: a partial decrypt, or a restored backup that
// dropped sender_id, used to crash the whole chat render on `id.length`. The
// two copies then drifted to different palettes, which is the bug. Painting a
// stable fallback colour beats throwing inside a list row.
export function colorForSender(id: string | null | undefined): string {
  if (!id) {return ROLE_COLORS[0];}
  let h = 0;
  for (let i = 0; i < id.length; i++) {h = (h * 31 + id.charCodeAt(i)) >>> 0;}
  return ROLE_COLORS[h % ROLE_COLORS.length];
}
