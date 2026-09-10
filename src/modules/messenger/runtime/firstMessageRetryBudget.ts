/**
 * B-30 — first-inbound-message-on-(re)established-session recovery budget.
 *
 * When `own.decrypt` fails on the FIRST envelope of a freshly (re)established
 * Signal pair, the receive path used to ACK-drop it (a hard-delete on the
 * relay) even though it was never delivered — so message 1 was permanently
 * lost (message 2+ re-handshakes and delivers). This module lets the receive
 * path instead LEAVE the envelope on the relay for a BOUNDED number of
 * redeliveries, so a redelivered PreKeyWhisperMessage can decrypt once
 * `runDecryptRecovery` has rebuilt the session.
 *
 * The bound (a per-envelope attempt cap AND a wall-clock age ceiling, both far
 * inside the relay's 30-day dwell) prevents the "redelivers forever, burns CPU
 * on every reconnect" hazard that an unbounded leave-on-relay would create —
 * the same hazard the existing keys-service `unavailable` leave-on-relay path
 * warns about (productionRuntime handleDeliver, ~line 3684).
 *
 * Mirrors `sessionWipeProtection`'s bounded-LRU hot-cache pattern. In-memory
 * only: a process restart resets the counters, which merely grants a fresh
 * (still-bounded) budget — acceptable, never unsafe.
 *
 * SECURITY (CLAUDE.md stop-condition — relay dwell / ACK timing):
 *   This NEVER changes the ack token, the envelope id, or the server. It only
 *   defers WHETHER to call `relay.ack` for a decrypt-failed envelope, exactly
 *   mirroring the established keys-service-`unavailable` leave-on-relay path —
 *   but bounded. It applies ONLY to the `own.decrypt` failure branch; sender-
 *   cert / sealed-AAD verification is unaffected (those run AFTER a successful
 *   decrypt). The P0-1 `protected` branch is deliberately EXCLUDED from
 *   leave-on-relay — a likely-forged envelope is ACK-dropped, never
 *   recirculated, so this cannot amplify a forged-envelope flood.
 */

import {DecryptError, NoSessionError} from '@bravo/messenger-core';

/** Max times we leave a single failed envelope on the relay before giving up. */
export const FIRST_MSG_RETRY_CAP = 5;
/** Per-envelope wall-clock ceiling — far inside the 30-day relay dwell. */
export const FIRST_MSG_RETRY_MAX_AGE_MS = 10 * 60_000;
/** Bound on the in-memory map (mirrors sessionWipeProtection HOT_CACHE_CAP). */
const BUDGET_CACHE_CAP = 1024;

/** The three recovery reasons `doHandleIncoming` can signal. */
export type DecryptRecoveryReason = 'protected' | 'rebuild' | 'cooldown';

/**
 * Sentinel thrown by `handleIncoming` to tell the WS / drain callers to SKIP
 * the `relay.ack` so the envelope redelivers (bounded). Carries the envelopeId
 * for logging only — it changes no ack-token or envelope-id handling.
 */
export class LeaveOnRelayError extends Error {
  constructor(public readonly envelopeId: string) {
    super('leave-on-relay');
    this.name = 'LeaveOnRelayError';
  }
}

/**
 * True for the two decrypt failures `own.decrypt` (SessionManager.decrypt) can
 * raise that a session rebuild can recover:
 *   - `DecryptError`   — bad MAC / ratchet desync
 *   - `NoSessionError` — no local session yet ("no session/record")
 *
 * Name-based fallback neutralizes the dual-class hazard: there are two
 * structurally-identical error-class copies (the `@bravo/messenger-core`
 * package and the mobile `src/modules/messenger/crypto`), so an error thrown
 * by the other module's class would fail an `instanceof` against ours and
 * silently fall through to the ACK-drop catch-all. Matching on `.name` closes
 * that. `IdentityKeyMismatchError` is intentionally NOT recoverable here — it
 * has its own refresh-and-retry path in the callers.
 */
export function isRecoverableDecryptError(e: unknown): boolean {
  if (e instanceof DecryptError || e instanceof NoSessionError) {return true;}
  const name = (e as {name?: string} | null | undefined)?.name;
  return name === 'DecryptError' || name === 'NoSessionError';
}

interface BudgetEntry {
  attempts: number;
  firstSeenMs: number;
}

const budget = new Map<string, BudgetEntry>();

// Classical JS-Map-as-LRU: insertion order is iteration order, so re-inserting
// promotes a key and the oldest is evicted when we exceed the cap.
function touchLru(key: string, entry: BudgetEntry): void {
  if (budget.has(key)) {budget.delete(key);}
  budget.set(key, entry);
  if (budget.size > BUDGET_CACHE_CAP) {
    const oldest = budget.keys().next().value;
    if (oldest !== undefined) {budget.delete(oldest);}
  }
}

/**
 * True while this envelope is still under BOTH the attempt cap and the age
 * ceiling. A never-seen envelope is always retryable (returns true).
 */
export function shouldRetry(envelopeId: string): boolean {
  const e = budget.get(envelopeId);
  if (!e) {return true;}
  if (e.attempts >= FIRST_MSG_RETRY_CAP) {return false;}
  return Date.now() - e.firstSeenMs < FIRST_MSG_RETRY_MAX_AGE_MS;
}

/** Record one leave-on-relay for this envelope (stamps firstSeen on first call). */
export function note(envelopeId: string): void {
  const e = budget.get(envelopeId);
  if (!e) {
    touchLru(envelopeId, {attempts: 1, firstSeenMs: Date.now()});
  } else {
    touchLru(envelopeId, {attempts: e.attempts + 1, firstSeenMs: e.firstSeenMs});
  }
}

/** Free the slot once the envelope finally decrypts (or is given up on). */
export function clear(envelopeId: string): void {
  budget.delete(envelopeId);
}

/**
 * Decide what to do with a decrypt-recovery envelope AFTER `runDecryptRecovery`
 * has run. Returns `'leave-on-relay'` (bounded redelivery) for the rebuild
 * paths while still under budget; otherwise `'ack-drop'`. EXCLUDES the P0-1
 * `'protected'` reason (likely-forged → never recirculate) and the loopback
 * path (no envelopeId). On a `'leave-on-relay'` decision it notes the budget as
 * a side effect, so each caller counts as exactly one attempt.
 */
export function decideRecoveryDisposition(
  reason: DecryptRecoveryReason,
  envelopeId: string | undefined,
): 'leave-on-relay' | 'ack-drop' {
  if (reason === 'protected') {return 'ack-drop';}
  if (!envelopeId) {return 'ack-drop';}
  if (!shouldRetry(envelopeId)) {return 'ack-drop';}
  note(envelopeId);
  return 'leave-on-relay';
}

/** Test-only — current number of tracked envelopes (for the LRU-bound test). */
export function _firstMsgRetryBudgetSize(): number {
  return budget.size;
}

/** Test-only — reset the in-process budget. */
export function _resetFirstMessageRetryBudget(): void {
  budget.clear();
}
