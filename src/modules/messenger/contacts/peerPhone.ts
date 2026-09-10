/**
 * B-338 — the ONE place that answers "what is this user's phone number?".
 *
 * Chat Info had a private `resolveUserPhone` for its "number under the name"
 * row, while the mid-call invite sheet printed `userId.slice(0, 12)` — a raw
 * account UUID, which reads to a user as an encrypted/garbage string. Two
 * surfaces, one question, and only one of them answered it.
 *
 * Extracted rather than copied on purpose: a second copy of a lookup like this
 * is the repo's most-repeated bug shape (one behaviour, N drifted copies), and
 * a copy is exactly what a unit test cannot see.
 *
 * Pure so the node Jest project can test it directly. The server's profile
 * endpoint deliberately never exposes phone numbers, so a locally-captured
 * E.164 (contact discovery / chat creation) is the ONLY source — meaning
 * `undefined` is a normal, expected answer for someone you have no 1:1 with,
 * and callers must render something sensible rather than assuming a value.
 */

export interface PhoneLookupConversation {
  type?:      string;
  peer?:      {userId: string} | undefined;
  phoneE164?: string | undefined;
}

/**
 * The peer's E.164 number, or undefined when this device has never learned it.
 *
 * `devContacts` is the dev-seeded roster (test rigs sign in as seeded users
 * whose numbers never come from contact discovery); it is consulted first so
 * dev builds behave, then the real direct-conversation row.
 */
export function resolvePeerPhone(
  conversations: Record<string, PhoneLookupConversation | undefined>,
  userId: string,
  devContacts?: ReadonlyArray<{userId: string; phoneE164?: string}>,
): string | undefined {
  if (!userId) {return undefined;}
  const dev = devContacts?.find(c => c.userId === userId);
  if (dev?.phoneE164) {return dev.phoneE164;}
  for (const c of Object.values(conversations)) {
    if (c && c.type === 'direct' && c.peer?.userId === userId && c.phoneE164) {
      return c.phoneE164;
    }
  }
  return undefined;
}
