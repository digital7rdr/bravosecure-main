/**
 * Own-identity rotation purge — closes the second half of the
 * silent-drop gap on reinstall.
 *
 * Symptom in logs: `outer sealed authentication failed`. Cause: after
 * the local device publishes a fresh identity (reinstall or recovery),
 * the relay still holds envelopes encrypted to the OLD outer ECIES
 * recipient key. They cannot be unwrapped — the matching private key
 * was discarded with the old install. They sit on the relay until
 * the 30-day TTL expires, every drain attempt logs the same error,
 * and nothing useful can be recovered.
 *
 * Mitigation: when we publish a new identity, tell the relay which
 * identity was just superseded so it can drop the queued envelopes
 * that were wrapped to it. The relay validates the JWT-attached
 * userId matches; the supersededIdentity is a possession-proof-light
 * (the caller knows the old identity because they JUST rotated it).
 *
 * Backend
 * -------
 * POST /envelopes/purge-stale-recipient is LIVE on messenger-service
 * (envelope.controller.ts, guarded by RecipientPurgeGuard — a fresh
 * `recipient_purge` MFA action token in X-Mfa-Proof). Wired 2026-07-03
 * from the boot publish site in productionRuntime (server-detected
 * `identityRotated` on POST /auth/keys/upload). The 404 → no-op branch
 * stays for environments running an older relay.
 */

import type {RelayHttpClient} from '@bravo/messenger-core';
import {RelayHttpError} from '@bravo/messenger-core';

export interface PurgeOutcome {
  result:  'purged' | 'no-op' | 'backend-missing' | 'unavailable';
  /** Number the backend reported it purged. Only populated when result='purged'. */
  count?:  number;
  reason?: string;
}

/**
 * Best-effort purge. Caller invokes ONCE after `installIdentity`
 * succeeds with a new keypair AND we still hold the old identity
 * base64 in memory from before the rotation.
 *
 * Audit P1-T2 — `mfaProofToken` is the fresh MFA action token (purpose
 * `recipient_purge`) auth-service issues to a device that has just
 * completed its identity rotation ceremony. Required by the server's
 * `RecipientPurgeGuard`. Without it the relay rejects with 401
 * `missing_mfa_proof`; we map that to `unavailable` so the caller can
 * surface a friendlier "couldn't reach auth-service for the rotation
 * proof — your stale envelopes will time out via the 30-day dwell
 * instead." Pass `undefined` only when the auth-service hasn't yet
 * shipped the recipient_purge purpose (then expect 401).
 *
 * Safe under:
 *   - 401 (auth-service missing recipient_purge purpose) → unavailable
 *   - 404 (backend doesn't expose the endpoint yet) → backend-missing
 *   - network failure → unavailable
 *   - other RelayHttpError → unavailable with the status in `reason`
 *
 * NEVER throws — the caller's identity-rotation flow MUST proceed
 * even if the purge can't run, because the rotation itself is
 * already complete by the time we get here.
 */
export async function purgeStaleRecipientQueue(
  relay:                  RelayHttpClient,
  supersededIdentityB64:  string,
  mfaProofToken?:         string,
): Promise<PurgeOutcome> {
  if (!supersededIdentityB64) {
    return {result: 'no-op', reason: 'no-superseded-identity'};
  }
  try {
    const {purged} = await relay.purgeStaleRecipientQueue(supersededIdentityB64, mfaProofToken);
    return {result: 'purged', count: purged};
  } catch (e) {
    if (e instanceof RelayHttpError) {
      if (e.status === 404) {
        return {result: 'backend-missing', reason: 'endpoint-404'};
      }
      return {result: 'unavailable', reason: `http-${e.status}`};
    }
    return {result: 'unavailable', reason: (e as Error).message.slice(0, 80)};
  }
}
