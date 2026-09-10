/**
 * Seam S3 — which local conversation slot an inbound envelope belongs to.
 *
 * Two rules, and the first one is a known hazard rather than a neutral choice:
 *
 *  1. GROUP — the envelope's own `group.groupId` is adopted VERBATIM. That id
 *     is stamped by the SENDER's device, so this is the point at which a remote
 *     device gets to name a local slot. B-124 rode in exactly here: call
 *     escalation filed an ad-hoc key under a `direct:`-shaped id, that id
 *     travelled on the wire, and the receiver adopted it — where it named a
 *     DIFFERENT person's 1:1 thread. Containment lives in
 *     `messagingLogic.isDeviceLocalGroupId` and in `groupConversationUpsert`,
 *     NOT here: this function must keep adopting the id, because the group
 *     lanes below it (key lookup, membership, epoch) all key off the same
 *     value, and rejecting it here would fail every re-escalated call at the
 *     joiner's key gate. Do not "harden" this by dropping device-local ids —
 *     that was tried and rejected (see MESSAGE_LOOP.md §10).
 *
 *  2. 1:1 — resolve through the SHARED resolver, never the raw `direct:<peer>`
 *     key. A 1:1 can live in two slots (the synthetic `direct:` key and a
 *     server-UUID row from /conversations/mine), and ChatScreen subscribes to
 *     whichever one the user tapped. Writing to the wrong one loses the bubble
 *     silently — typing indicators still render, because those fan out, while
 *     the message does not. That was the Pixel v1.0.38 field bug. `sendText`
 *     uses the same resolver so inbound and outbound agree.
 *
 * Pure: the caller injects the resolver, so this is testable without the store.
 */

export interface InboundRouteArgs {
  /** Sender-stamped group id, when the envelope carries one. */
  groupId?:    string;
  peerUserId:  string;
  /** `resolveDirectConversationIdFromState` bound to the current state. */
  resolveDirect: (peerUserId: string) => string;
}

export interface InboundRoute {
  conversationId: string;
  /** Which rule fired — 'group' adopted a REMOTE id, 'direct' resolved locally. */
  via:            'group' | 'direct';
}

export function routeInboundEnvelope(args: InboundRouteArgs): InboundRoute {
  if (args.groupId) {
    return {conversationId: args.groupId, via: 'group'};
  }
  return {conversationId: args.resolveDirect(args.peerUserId), via: 'direct'};
}
