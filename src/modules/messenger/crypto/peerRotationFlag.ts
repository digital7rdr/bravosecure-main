/**
 * B-701 — send-side peer-rotation detection: the flag between the SEAL layer
 * (which learns the peer's CURRENT identity from the server every ≤8 min via
 * `recipientIdentityKeyB64Cached` — server-first exactly because of the
 * reinstall case) and the SESSION layer (whose `own.hasSession` fast path
 * would otherwise trust a Double-Ratchet built against a DEAD identity
 * forever).
 *
 * Observed live 2026-08-29: the founder reinstalled, and a peer's device
 * kept sealing into the pre-reinstall ratchet — outer unwrap fine (seal
 * identity had refreshed), inner decrypt dead, first-message-recovery
 * redelivery churn, 150 bundle fetches, 110-141 s sends. The receive-side
 * heal (`refreshPeerIdentityIfRotated`) only runs when the rotated peer
 * SENDS; a sender-only relationship never converged on its own.
 *
 * The contract: the seal lane NOTES a suspicion when the server identity
 * differs from the local trust row (zero extra network — it rides the fetch
 * the seal already made, so no OPK is spent on detection);
 * `ensureOutgoingSession` TAKES it (one-shot) and rebuilds through the
 * existing B-46 core. A failed rebuild re-notes, so an offline probe can
 * never eat the flag.
 *
 * Tier A — no imports, module state with a test reset hook, per the
 * MESSAGE_LOOP sibling conventions.
 */

const suspected = new Map<string, number>();   // addrKey → noted-at ms

/** The seal lane saw a server identity that differs from the trust row. */
export function notePeerRotationSuspected(addrKey: string): void {
  if (!addrKey) {return;}
  if (!suspected.has(addrKey)) {suspected.set(addrKey, Date.now());}
}

/** One-shot consume — true at most once per note. */
export function takePeerRotationSuspected(addrKey: string): boolean {
  if (!suspected.has(addrKey)) {return false;}
  suspected.delete(addrKey);
  return true;
}

/** Read-only peek (tests + diagnostics). */
export function hasPeerRotationSuspected(addrKey: string): boolean {
  return suspected.has(addrKey);
}

export function _resetPeerRotationFlagsForTests(): void {
  suspected.clear();
}
