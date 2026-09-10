/**
 * B-31 — boot-time selection for draining an undrained group envelope stash.
 *
 * A group text that arrives before its master key is durably stashed
 * (`pendingGroupEnvelopes`) and rendered fail-closed (the `no_key` / `tamper`
 * branch in productionRuntime). That stash is normally drained by the admin
 * create/rekey post-txn `drain-group` request. But once that admin envelope is
 * ACKed off the relay it is never redelivered — so a stash row left undrained
 * across a restart has nothing to re-trigger it. The key is on disk and the
 * message IS decryptable, yet it never renders.
 *
 * The boot key-restore path now re-runs the EXISTING per-row drain
 * (`drainPendingGroup` → `replayGroupSealedDecode`) for every group whose
 * master key we just restored into memory. This helper is that selection — and
 * the fail-closed gate:
 *
 *   - Scenario A (the fix): the key is on disk → the group carries a
 *     `masterKeyB64` after the merge → selected → drained → the stashed message
 *     renders.
 *   - Scenario B (UNCHANGED, fail-closed): the member never persisted / lost
 *     the key → no `masterKeyB64` → NOT selected → the row stays stashed behind
 *     its banner. Re-seeding a truly-lost key is an owner-side resync — a
 *     group-master-key-distribution change, a CLAUDE.md stop-condition decided
 *     fail-closed (sqa.md B-26(a) 2026-06-11, B-13 2026-06-09). This helper
 *     MUST NOT request or distribute keys; it only filters by what is already
 *     on this device.
 */

/** Group ids whose master key is already on this device (Scenario A only). */
export function selectGroupIdsToDrain(
  groups: Record<string, {masterKeyB64?: string}>,
): string[] {
  return Object.entries(groups)
    .filter(([, gs]) => !!gs.masterKeyB64)
    .map(([gid]) => gid);
}

/**
 * GF-3 — a replay that failed because the key we hold still can't open the
 * row (absent, or diverged). Recoverable: a later key install may fix it, so
 * the drain must not spend one of the row's bounded attempts on it.
 */
export class ReplayNeedsKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayNeedsKeyError';
  }
}

/**
 * GF-3 — attempt-spend policy for a failed stash replay.
 *
 * `PENDING_GROUP_MAX_ATTEMPTS` exists to evict a row that will never decrypt.
 * The boot drain re-runs against the SAME on-disk key every launch, so a
 * key-divergence row used to burn all three attempts in three launches and be
 * deleted — destroying the only surviving copy (stashing ACKs the relay).
 * Spend an attempt only when the failure is structural (no key could fix it)
 * or when this drain actually followed a NEW key landing.
 */
// `transientSql` is REQUIRED (critic rev-5): optional, a future caller that
// forgets to feed it silently inherits the old destructive policy.
export function shouldBumpStashAttempt(args: {needsKey: boolean; keyChanged: boolean; transientSql: boolean}): boolean {
  // AUDIT #11 rev-5 (edge) — a TRANSIENT local failure (db_closed during a
  // rebuild's handle swap, BUSY) says nothing about the row and no key
  // could fix it: spending attempts on it deleted the only surviving copy
  // in three hits. Never bump for it.
  if (args.transientSql) {return false;}
  return !args.needsKey || args.keyChanged;
}
