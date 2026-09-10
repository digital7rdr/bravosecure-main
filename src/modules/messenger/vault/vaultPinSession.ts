/**
 * B-696 Phase B (VAULT_DURABILITY_DESIGN_2026-08-29 §4.2) — client glue for
 * the server-side vault PIN verifier.
 *
 * Two jobs, both deliberately tiny:
 *
 * 1. THE PROVEN-PIN HOLDER. The change lane needs the OLD pin plaintext for
 *    the server's replace check (S2: a bare JWT must never overwrite a
 *    verifier), but VaultNewPinScreen never sees it — VaultLockScreen does,
 *    at verify time. The holder carries it across that one navigation hop:
 *    module memory only, NEVER persisted, single-take, 60 s TTL (the same
 *    presence window as PIN_PROOF_WINDOW_MS, and the same consent-anchor
 *    reasoning — see vaultStore).
 *
 * 2. BEST-EFFORT SERVER SYNC. Local-first always: a server failure never
 *    blocks vault usage. `reconcileServerPin` runs after every successful
 *    LOCAL unlock: it mints a missing verifier (self-heals the legacy
 *    install base) and settles any recorded sync debt (review F1 — the
 *    persisted `pinSyncPending`/`pinServerDiverged` flags in vaultStore).
 *
 * SECURITY: the PIN travels to auth-service over TLS exactly like the account
 * password, is hashed server-side (argon2id) and stored as a verifier only.
 * No key material derives from it anywhere. Never log a PIN.
 */
import {PIN_PROOF_WINDOW_MS, useVaultStore} from './vaultStore';

let provenPin: string | null = null;
let provenAt = 0;

export function notePinProven(pin: string): void {
  provenPin = pin;
  provenAt = Date.now();
}

/** Single-take: the value is cleared on read. */
export function takeProvenPin(): string | null {
  const val = provenPin;
  provenPin = null;
  if (!val) {return null;}
  if (Date.now() - provenAt > PIN_PROOF_WINDOW_MS) {return null;}
  return val;
}

/** Test/lock hygiene. */
export function clearProvenPin(): void {
  provenPin = null;
  provenAt = 0;
}

/** Nest error body → short code ('pin_invalid', 'current_pin_required', …). */
export function apiErrCode(e: unknown): string | null {
  const resp = (e as {response?: {data?: {message?: unknown}}})?.response;
  if (!resp) {return null;}   // no HTTP response = network/offline
  const msg = resp.data?.message;
  return typeof msg === 'string' ? msg : 'unknown';
}

export type PinSyncOutcome = 'ok' | 'refused' | 'offline';

/**
 * Push the (just set or changed) PIN to the server verifier. `currentPin`
 * authorizes a replace; on first set it is not needed.
 *
 * Review F1 — this call now OWNS the sync-state bookkeeping (the design
 * doc's §4.2 self-heal, armed): 'offline' records `pinSyncPending` so the
 * next unlock's reconcile retries; 'refused' records `pinServerDiverged`
 * (the server provably holds a different verifier — an offline fresh setup
 * over an existing account PIN, or a change whose old-pin proof no longer
 * matches). A refusal is never retried blind: S2 makes the Forgot-PIN lane
 * (account password + OTP) the only sanctioned overwrite door.
 */
export async function syncPinToServer(pin: string, currentPin?: string): Promise<PinSyncOutcome> {
  try {
    const {authApi} = require('@/services/api') as typeof import('@/services/api');
    await authApi.setVaultPin(currentPin ? {pin, currentPin} : {pin});
    useVaultStore.getState().setPinSyncState({pending: false, diverged: false});
    return 'ok';
  } catch (e) {
    const codeVal = apiErrCode(e);
    if (codeVal === null) {
      useVaultStore.getState().setPinSyncState({pending: true});
      return 'offline';
    }
    console.warn('[vault.pin] server sync refused:', codeVal);
    useVaultStore.getState().setPinSyncState({pending: false, diverged: true});
    return 'refused';
  }
}

export type ReconcileOutcome =
  | 'in-sync'         // server matches local (or nothing was owed)
  | 'minted'          // account had no verifier — created from this unlock
  | 'diverged-new'    // divergence CONFIRMED just now — surface the one-shot prompt
  | 'diverged-known'  // still diverged, already surfaced — stay silent
  | 'offline';        // could not reach the server — debt (if any) kept

/**
 * After a successful LOCAL unlock: reconcile the server verifier with the
 * pin that just proved presence.
 *
 *  - No server verifier → mint one (self-heals every pre-B-696 install).
 *  - Verifier exists and no debt is recorded → done (one cheap GET; a
 *    divergence probe on EVERY unlock would burn the server's lockout
 *    budget ten unlocks at a time on a diverged device).
 *  - Debt recorded (`pinSyncPending`/`pinServerDiverged`) → verify the
 *    local pin server-side: a match clears the debt; a mismatch confirms
 *    divergence, which S2 says only the Forgot-PIN lane may repair — the
 *    caller shows that guidance exactly once (the 'diverged-new' edge).
 */
export async function reconcileServerPin(pin: string): Promise<ReconcileOutcome> {
  try {
    const {authApi} = require('@/services/api') as typeof import('@/services/api');
    const st = () => useVaultStore.getState();
    const {exists} = await authApi.getVaultPinStatus();
    if (!exists) {
      await authApi.setVaultPin({pin});
      st().setPinSyncState({pending: false, diverged: false});
      console.log('[vault.pin] server verifier minted from local unlock');
      return 'minted';
    }
    if (!st().pinSyncPending && !st().pinServerDiverged) {return 'in-sync';}
    try {
      await authApi.verifyVaultPin({pin});
      st().setPinSyncState({pending: false, diverged: false});
      console.log('[vault.pin] sync debt cleared — server matches local');
      return 'in-sync';
    } catch (e) {
      if (apiErrCode(e) === null) {return 'offline';}
      const wasKnown = st().pinServerDiverged;
      st().setPinSyncState({pending: false, diverged: true});
      return wasKnown ? 'diverged-known' : 'diverged-new';
    }
  } catch {
    return 'offline';
  }
}
