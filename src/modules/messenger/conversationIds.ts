/**
 * AUDIT-2026-08-13 #19 — flavored ID types + the ONE `direct:` grammar.
 *
 * The audit verified 7+ signatures where two same-typed ids swap and the
 * program still compiles (`updateMessageStatus(conversationId, messageId)`,
 * `setCallKeyMapping(originId, keyGroupId)`, `markDelivered(clientMsgId, …)`,
 * …) — the B-124/B-143 bug class. These are FLAVORS (weak brands): a plain
 * `string` is still assignable to every flavor, so nothing cascades — tests,
 * literals, wire parses and the tsc baseline are untouched — but a value
 * TYPED with one flavor no longer assigns to a parameter demanding another.
 * A swap of two already-typed ids is now a compile error at exactly the
 * seams that have cost bug-cycles, at zero runtime cost (flavors erase).
 *
 * Deliberately NOT strong brands: strong brands reject plain strings, which
 * would force constructor calls through ~4k existing test literals and every
 * wire/DB parse — the audit's own recommendation says not to brand the
 * wire/DTO boundary. The honest limits (edge-review verified, 2026-08-14):
 * two UNTYPED local strings swapped stay uncaught until they flow through a
 * typed seam; and a TEMPLATE LITERAL erases the flavor — every `${id}` in a
 * log line, cache key, or composed store key yields plain `string`, so a
 * flavored value laundered through interpolation re-enters untyped. Object
 * properties and array elements DO preserve flavors; interpolation and
 * JSON round-trips do not.
 *
 * ── The `direct:` prefix carries TWO grammars ────────────────────────────
 *   A. slot id  `direct:<peerUserId>`   — the device-LOCAL 1:1 conversation
 *      slot. It names a DIFFERENT person on every device; it must never
 *      travel on the wire as a group id (B-124).
 *   B. AAD id   `direct:<lo>|<hi>`      — the sorted user-id PAIR that a
 *      sealed envelope's AAD names for a 1:1 (built by
 *      `aadBinding.directConvoAadId`, which stays that grammar's home).
 * `id.slice('direct:'.length)` on grammar B yields `"lo|hi"`, NOT a userId —
 * which is why every parse must go through `peerFromDirectSlot` here rather
 * than re-inlining the slice. The scan pin (`brandedIdSeams.test.ts`) bans
 * the inlined slice outside this file.
 */

// ── Flavors ──────────────────────────────────────────────────────────────
// ConversationId is the SUPERTYPE: a conversation key is a server uuid, a
// group id, a direct slot, or (in AAD position) the pair form — so those
// flavors are assignable TO ConversationId but not to each other.
export type ConversationId = string & {
  readonly __flavor?: 'ConversationId' | 'GroupId' | 'DirectSlotId' | 'DirectAadId';
};
export type GroupId      = string & {readonly __flavor?: 'GroupId'};
export type DirectSlotId = string & {readonly __flavor?: 'DirectSlotId'};
export type DirectAadId  = string & {readonly __flavor?: 'DirectAadId'};

export type MessageId   = string & {readonly __flavor?: 'MessageId'};
export type ClientMsgId = string & {readonly __flavor?: 'ClientMsgId'};
export type EnvelopeId  = string & {readonly __flavor?: 'EnvelopeId'};

export type UserId = string & {readonly __flavor?: 'UserId'};
export type CallId = string & {readonly __flavor?: 'CallId'};
export type RoomId = string & {readonly __flavor?: 'RoomId'};

// The dual deviceId namespaces, previously held apart by convention only:
// the numeric libsignal device id (always 1 in Phase-1) vs the JWT
// session-device uuid. One is a number, one is a string — but both appear
// as `deviceId` in signatures, so name them.
export type SignalDeviceId  = number & {readonly __flavor?: 'SignalDeviceId'};
export type SessionDeviceId = string & {readonly __flavor?: 'SessionDeviceId'};

// ── The grammar (the only file allowed to spell it) ──────────────────────
export const DIRECT_PREFIX = 'direct:';

/** Build a device-local 1:1 slot id (grammar A). */
export function directSlotId(peerUserId: UserId): DirectSlotId {
  return (DIRECT_PREFIX + peerUserId) as DirectSlotId;
}

/** Is this id in the `direct:` namespace (EITHER grammar)? */
export function isDirectPrefixed(id: string): boolean {
  return id.startsWith(DIRECT_PREFIX);
}

/**
 * Parse the peer userId out of a slot id (grammar A). The parameter is
 * DirectSlotId ONLY (edge review): a value typed DirectAadId — or a
 * ConversationId, which could be carrying one — is a compile error at
 * the single function the module exists to centralise; plain strings
 * still assign. On a raw grammar-B string this returns `"lo|hi"` — same
 * bytes the historical inlined slices produced (behavior-preserving by
 * contract with the 11 migrated sites) — but it WARNS: no live path
 * feeds grammar B here today (two independent reviews, 2026-08-14), so
 * the warn is a real signal, and console.warn survives release builds.
 */
export function peerFromDirectSlot(id: DirectSlotId): UserId {
  const peer = id.slice(DIRECT_PREFIX.length);
  if (peer.includes('|')) {
    console.warn(`[messenger.ids] peerFromDirectSlot fed a grammar-B aad id (pipe in remainder) len=${peer.length}`);
  }
  return peer as UserId;
}

/**
 * Is this the AAD pair form (grammar B, `direct:<lo>|<hi>`)?
 * Pure syntax: a slot id whose USER id contains `|` would misclassify.
 * Harmless while user ids are server UUIDs; revisit if that ever changes.
 */
export function isDirectAadId(id: string): boolean {
  return isDirectPrefixed(id) && id.includes('|');
}
