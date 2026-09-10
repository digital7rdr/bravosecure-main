/**
 * GF-1 / SRV-01 — client-side pacing for `POST /envelopes`.
 *
 * The relay caps that handler per authenticated user
 * (`apps/messenger-service/src/relay/envelope.controller.ts`, keyed on
 * `claims.sub`), and a group fan-out issues one submit PER MEMBER in parallel.
 * Without pacing, any group larger than the cap 429s its own tail; the 429
 * then burns the outbox retry budget and the tail waits for the 60s drain tick.
 *
 * Pure module (no imports) so it unit-tests in the `messenger-crypto` project —
 * same pattern as `outboxCertFreshness.ts` / `undeliverableResend.ts`.
 *
 * Sealed Sender note: this is a purely local budget. Nothing about the group,
 * its size, or its membership is communicated to the relay — the submits stay
 * N independent, unrelated requests, exactly as before.
 */

/**
 * Server window for the `POST /envelopes` bucket. Mirrors the @Throttle ttl
 * that RELAY-1 ships (300 submits / 60 s per user).
 */
export const RELAY_SEND_WINDOW_MS = 60_000;
/**
 * Submits we allow ourselves per window. Deliberately below the server cap
 * (300/60 s) so clock skew and a concurrent second device on the same account
 * don't push us over. If the server cap is ever lowered, lower this with it.
 */
export const RELAY_SEND_BUDGET_PER_WINDOW = 240;
/** Bounds on a server-supplied `Retry-After` before we trust it. */
export const RETRY_AFTER_MIN_MS = 1_000;
export const RETRY_AFTER_MAX_MS = 60_000;

export interface RelaySendBucket {
  tokens:          number;
  windowStartMs:   number;
  cooldownUntilMs: number;
}

export function createRelaySendBucket(nowMs: number = Date.now()): RelaySendBucket {
  return {tokens: RELAY_SEND_BUDGET_PER_WINDOW, windowStartMs: nowMs, cooldownUntilMs: 0};
}

/** True for a relay rejection caused by the per-user submit throttle. */
export function isRateLimitError(e: unknown): boolean {
  return (e as {status?: unknown} | null)?.status === 429;
}

/** Parsed `Retry-After` (ms) carried on a `RelayHttpError`, when present. */
export function retryAfterMsOf(e: unknown): number | undefined {
  const v = (e as {retryAfterMs?: unknown} | null)?.retryAfterMs;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

export function clampRetryAfterMs(ms: number | undefined): number {
  if (ms === undefined) {return RELAY_SEND_WINDOW_MS;}
  return Math.min(Math.max(ms, RETRY_AFTER_MIN_MS), RETRY_AFTER_MAX_MS);
}

/**
 * Reserve one submit slot. Mutates the bucket; returns how long the caller must
 * wait before issuing the request. Fixed-window, matching the server's storage
 * model (`@nestjs/throttler` increments a per-key counter with a ttl).
 */
export function reserveSendSlot(b: RelaySendBucket, nowMs: number = Date.now()): number {
  if (nowMs - b.windowStartMs >= RELAY_SEND_WINDOW_MS) {
    b.windowStartMs = nowMs;
    b.tokens = RELAY_SEND_BUDGET_PER_WINDOW;
  }
  if (b.tokens <= 0) {
    b.windowStartMs += RELAY_SEND_WINDOW_MS;
    b.tokens = RELAY_SEND_BUDGET_PER_WINDOW;
  }
  b.tokens -= 1;
  return Math.max(nowMs, b.windowStartMs, b.cooldownUntilMs) - nowMs;
}

/** A 429 landed anyway — drop the rest of this window and honour Retry-After. */
export function noteThrottled(
  b: RelaySendBucket,
  retryAfterMs: number | undefined,
  nowMs: number = Date.now(),
): void {
  const cooldownMs = clampRetryAfterMs(retryAfterMs);
  b.tokens = 0;
  // Why: parking the window start one full window behind the cooldown makes
  // the next reservation chain forward to exactly when the server said we may
  // resume — a short Retry-After must not be rounded up to a whole window.
  b.windowStartMs = nowMs + cooldownMs - RELAY_SEND_WINDOW_MS;
  b.cooldownUntilMs = Math.max(b.cooldownUntilMs, nowMs + cooldownMs);
}

const bucket = createRelaySendBucket();

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/**
 * Gate every relay submit through the shared bucket. Wired as
 * `RelayHttpClientOptions.sendGate` so every `relay.send(...)` call site in the
 * runtime (fan-out, drain, receipts, rekey/admin control sends) shares one
 * budget — they all share one server bucket.
 */
export async function withRelaySendSlot<T>(fn: () => Promise<T>): Promise<T> {
  const delayMs = reserveSendSlot(bucket);
  if (delayMs > 0) {await sleep(delayMs);}
  try {
    return await fn();
  } catch (e) {
    if (isRateLimitError(e)) {noteThrottled(bucket, retryAfterMsOf(e));}
    throw e;
  }
}

/** Test / runtime-teardown hook — drops any accumulated cooldown. */
export function resetRelaySendPacer(nowMs: number = Date.now()): void {
  const fresh = createRelaySendBucket(nowMs);
  bucket.tokens = fresh.tokens;
  bucket.windowStartMs = fresh.windowStartMs;
  bucket.cooldownUntilMs = fresh.cooldownUntilMs;
}
