/**
 * B-107 — global "restore mode" flag.
 *
 * While a backup restore is in progress (or the RESTORE boot gate is
 * holding the user on the restore/password screen), the app must not
 * ring for incoming calls: `handleRestore` disposes and rebuilds the
 * live runtime mid-flow (a live call's signalling would be stranded —
 * the B-64 zombie-session class) and an answer would be cert-signed by
 * the throwaway identity the restore is about to overwrite. Callers get
 * an immediate `call.hangup{reason:'busy'}` instead (WhatsApp parity:
 * you cannot take calls during a restore).
 *
 * The same flag also gates the push layer's runtime-boot sites: a
 * foreground `msg-wake` during the pre-password window used to boot the
 * runtime → installIdentity + bundle publish → the server's rotation
 * detector wiped the OPK pool AND permanently disarmed the RESTORE gate.
 *
 * Deliberately a leaf module (no imports) so every consumer — UI,
 * navigation, push — can require it without cycles, and deliberately
 * IN-MEMORY: a process restart implicitly clears it, so a stuck flag
 * can never leave the user permanently unreachable. Setters must still
 * clear it on every exit path (finally / unmount / wipe).
 */

let restoreModeActive = false;

/**
 * B-479 — subscribers notified when restore mode flips.
 *
 * Every consumer used to POLL this flag at decision time, so anything the flag
 * caused to be dropped had nothing to re-trigger it. A group ring suppressed
 * here is exactly that: the server's replay is one-shot and destructive (the
 * gateway clears the pending-ring artifacts as soon as it emits them) AND the
 * restore flow connects a socket while the flag is still armed, so the one
 * replay we would have relied on can be consumed and discarded before the
 * restore finishes. The ring is then gone with no missed-call record.
 *
 * Still a leaf module: a Set of callbacks, no imports.
 */
type RestoreModeListener = (active: boolean) => void;
const restoreModeListeners = new Set<RestoreModeListener>();

export function subscribeRestoreMode(fn: RestoreModeListener): () => void {
  restoreModeListeners.add(fn);
  return () => { restoreModeListeners.delete(fn); };
}

export function setRestoreModeActive(active: boolean): void {
  if (restoreModeActive === active) {return;}
  restoreModeActive = active;
  console.log(`[bravo.restore] restore mode ${active ? 'ON — incoming calls busy-rejected, push runtime-boot deferred' : 'OFF'}`);
  // Copy: a listener may unsubscribe while we iterate.
  for (const fn of [...restoreModeListeners]) {
    try { fn(active); } catch { /* a bad listener must never wedge the restore */ }
  }
}

export function isRestoreModeActive(): boolean {
  return restoreModeActive;
}
