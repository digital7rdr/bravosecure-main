/**
 * B-237-CW — should a NON-HOST participant re-broadcast the group's
 * authoritative call key when they JOIN?
 *
 * The host already re-broadcasts the key on call start (useGroupCall boot →
 * `ensureCallGroupKey`), which heals a member who fell behind on the group
 * epoch. But that heal only fires when the OWNER hosts: a non-owner host reuses
 * the stored key with no fan-out (productionRuntime "reuse real-group key"
 * path), so a call hosted by anyone other than the owner never converges a
 * forked member — the founder-hosted calls in the field are exactly this case.
 *
 * This makes the OWNER re-broadcast whenever they are IN the call, host or not,
 * so a behind-member heals as long as the owner participates — not only when
 * the owner happens to be the one who started it.
 *
 * Only the OWNER of a REAL, KEYED, named group qualifies:
 *  - non-host — the host path already resyncs (don't double-broadcast);
 *  - a real named group, not an ad-hoc 'Call' carrier or a `direct:` alias —
 *    ad-hoc keys are minted per-call by the host, and re-broadcasting one as a
 *    joiner carries no owner authority and would trip the receiver's guards;
 *  - we actually hold the master key — nothing to re-broadcast otherwise;
 *  - we ARE the owner — only an owner-signed create is accepted by the inbound
 *    gate (a non-owner re-broadcast is dropped `owner-changed` / `unsigned-fork`).
 *
 * SECURITY: this changes NO guard. It only decides whether to fire the SAME
 * owner-signed resync the host already uses, from one additional place. A
 * behind-member still heals only through the existing accepting gate
 * (`decideGroupCreate`), and a rollback/replay is still refused there. Pure so
 * it is unit-testable under the node project (useGroupCall pulls
 * react-native-webrtc and cannot be imported there).
 */
export interface OwnerResyncInput {
  /** Are we the host of this call? The host boot path already resyncs. */
  isHost:            boolean;
  /** Our own user id (`_ownAuthUserId ?? _ownUserId`). */
  ownUserId:         string | null | undefined;
  /** The group's recorded owner id. */
  groupOwner:        string | null | undefined;
  /** Do we hold a master key for this group to re-broadcast? */
  groupHasMasterKey: boolean;
  /** A real named group — NOT an ad-hoc 'Call' carrier or a `direct:` alias. */
  isRealNamedGroup:  boolean;
}

export function shouldOwnerResyncOnJoin(input: OwnerResyncInput): boolean {
  // The host already re-broadcasts on its own boot path.
  if (input.isHost) {return false;}
  // Only ever re-broadcast a real, owned, keyed group's authoritative key.
  if (!input.isRealNamedGroup) {return false;}
  if (!input.groupHasMasterKey) {return false;}
  if (!input.ownUserId) {return false;}
  // Only the OWNER may re-broadcast — the gate accepts only owner-signed creates.
  return input.groupOwner === input.ownUserId;
}
