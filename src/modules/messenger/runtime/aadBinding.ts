/**
 * Seam S2 — which conversation id the sealed AAD is expected to be bound to.
 *
 * The AAD binds the ciphertext to a conversation so it cannot be replayed into
 * a different thread. Computing the EXPECTED id is a rule with one genuinely
 * counter-intuitive case, which is why it belongs in a named, tested function
 * rather than inline in a 950-line handler:
 *
 *   - GROUP: the group id. Both sides already agree on it.
 *   - 1:1:   the SYMMETRIC id `directConvoAadId(self, peer)` — the lexically
 *            sorted pair — NOT the per-side UI key. Each device stores a 1:1
 *            under its own local slot, so a per-side key would never match
 *            across the wire. This is audit P0-N2-follow-up, and it is the
 *            thing a refactorer "simplifying" to the local conversation id
 *            would break: every 1:1 would then fail AAD and be destroyed.
 *
 * Pure and dependency-free (Tier A) so it can be unit-tested directly.
 */
import type {DirectAadId} from '../conversationIds';

/**
 * Audit P0-N2-follow-up — the symmetric 1:1 AAD conversation id.
 *
 * Both devices must derive the SAME string from the same pair of user ids, so
 * the inputs are sorted lexically. Kept here beside its only consumer.
 */
export function directConvoAadId(a: string, b: string): DirectAadId {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return `direct:${lo}|${hi}` as DirectAadId;
}

/**
 * The conversation id the AAD must name for this envelope to be accepted.
 *
 * `groupId` is the sender-stamped group id when the envelope carries one.
 */
export function expectedAadConversationId(args: {
  groupId?:    string;
  ownUserId:   string;
  peerUserId:  string;
}): string {
  return args.groupId ?? directConvoAadId(args.ownUserId, args.peerUserId);
}
