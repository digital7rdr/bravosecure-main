/**
 * One place that answers "did this fail because the wallet was short on Bravo
 * Credits, and by how much?" — Issue 25 (Testing Issues V2, PDF p.30).
 *
 * Why this exists: the same question was answered four different ways and three
 * of them were wrong for at least one caller.
 *
 *   - bookingStore pre-check  throws `Error & {code, amountDue}` BEFORE the
 *     request, so the code survives on the error itself.
 *   - the server throws `BadRequestException` whose body is `{code, message,
 *     required, balance}` — but bookingStore.confirmBooking's catch used to
 *     flatten it into a bare `new Error(friendly)`, so by the time a screen saw
 *     it only `.message` was left.
 *   - NestJS's validation pipe returns `message` as a string[], not a string.
 *
 * So a caller can be handed any of: the typed local error, a live axios error
 * with a structured body, or a flattened Error carrying only the raw code in
 * its message. All three mean the same thing and all three must route the user
 * to the top-up paywall instead of an alert that leaks `insufficient_credits`.
 *
 * Deliberately dependency-free (no axios, no RN) so the node `booking` Jest
 * project can unit-test it directly rather than scanning source.
 */

const CODE = 'insufficient_credits';

/** The structured 400 body the booking / wallet endpoints return. */
interface CreditErrorBody {
  code?: unknown;
  message?: unknown;
  /** Credits the booking costs. */
  required?: unknown;
  /** Credits the payer actually holds. */
  balance?: unknown;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function bodyOf(e: unknown): CreditErrorBody | undefined {
  if (!isObject(e)) {return undefined;}
  const response = e.response;
  if (!isObject(response)) {return undefined;}
  return isObject(response.data) ? (response.data as CreditErrorBody) : undefined;
}

/** Nest's `message` is a string for a manual throw and a string[] from the
 *  validation pipe. Normalise both to one searchable string. */
function messageText(v: unknown): string {
  if (typeof v === 'string') {return v;}
  if (Array.isArray(v)) {return v.filter(x => typeof x === 'string').join(' ');}
  return '';
}

function finiteNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Did this failure happen because the payer's Bravo Credits balance was short?
 * Only then should the caller route to the top-up paywall; anything else is a
 * real failure and must surface its own message.
 */
export function isInsufficientCreditsError(e: unknown): boolean {
  if (!isObject(e)) {return false;}
  // 1 — the typed local pre-check, or a store re-throw that preserved the code.
  if (e.code === CODE) {return true;}
  const body = bodyOf(e);
  // 2 — structured server body.
  if (body && body.code === CODE) {return true;}
  // 3 — server message, string or validation-pipe string[].
  if (body && messageText(body.message).includes(CODE)) {return true;}
  // 4 — a flattened Error that kept only the raw code in its message.
  return messageText(e.message).includes(CODE);
}

/**
 * How many more credits the payer needs, when the error says so. Returns
 * undefined when the shortfall cannot be derived from the error alone — the
 * caller should then fall back to its own estimate-minus-balance arithmetic
 * rather than showing a wrong number.
 *
 * Always rounded UP: topping up the floor would still leave the payer short.
 */
export function creditShortfallFrom(e: unknown): number | undefined {
  if (!isObject(e)) {return undefined;}
  // The local pre-check already did the arithmetic.
  const direct = finiteNumber(e.amountDue);
  if (direct !== undefined && direct > 0) {return Math.ceil(direct);}

  const body = bodyOf(e);
  const required = finiteNumber(body?.required);
  const balance = finiteNumber(body?.balance);
  if (required !== undefined && balance !== undefined && required > balance) {
    return Math.ceil(required - balance);
  }
  return undefined;
}

/**
 * Spec §8/§9 — WHICH limit refused this spend.
 *
 * The two are different products of the same request and must never be shown
 * interchangeably: a member whose own quota is exhausted gets "Request More
 * Credit"; a member whose ROOT is empty gets a message about the root account
 * and no button, because requesting more quota cannot help them.
 *
 * Returns undefined when the error is not a spending denial at all.
 */
export function spendDenialKind(
  e: unknown,
  opts?: {isFamilyMember?: boolean},
): 'SPENDING_QUOTA_EXCEEDED' | 'ROOT_CREDIT_UNAVAILABLE' | 'ROOT_ACCOUNT_SUSPENDED' | 'INSUFFICIENT_CREDITS' | undefined {
  if (!isObject(e)) {return undefined;}
  const body = bodyOf(e);
  const text = `${messageText(e.message)} ${messageText(body?.message)} ${String(body?.code ?? '')} ${String(e.code ?? '')}`;
  if (text.includes('root_account_suspended') || text.includes('ROOT_ACCOUNT_SUSPENDED')) {
    return 'ROOT_ACCOUNT_SUSPENDED';
  }
  if (text.includes('family_spend_limit_exceeded') || text.includes('SPENDING_QUOTA_EXCEEDED')) {
    return 'SPENDING_QUOTA_EXCEEDED';
  }
  if (text.includes(CODE)) {
    // Same wire code either way; only the caller's own membership tells them
    // whose wallet was short. §9 is explicit that these must read differently.
    return opts?.isFamilyMember ? 'ROOT_CREDIT_UNAVAILABLE' : 'INSUFFICIENT_CREDITS';
  }
  return undefined;
}

/**
 * The quota figures the server attaches to a `SPENDING_QUOTA_EXCEEDED` refusal,
 * so §48's "the UI is stale, the server is authoritative" reconciliation can
 * happen from the error itself instead of a second round trip.
 *
 * Undefined when the error carries no figures — the caller must then refresh
 * rather than render numbers it guessed.
 */
export function quotaFiguresFrom(e: unknown): {
  required: number; allocated: number; used: number; remaining: number;
} | undefined {
  const body = bodyOf(e);
  const required  = finiteNumber(body?.required);
  const allocated = finiteNumber((body as Record<string, unknown> | undefined)?.allocated);
  const used      = finiteNumber((body as Record<string, unknown> | undefined)?.used);
  const remaining = finiteNumber((body as Record<string, unknown> | undefined)?.remaining);
  if (required === undefined || allocated === undefined || used === undefined || remaining === undefined) {
    return undefined;
  }
  return {required, allocated, used, remaining};
}

/**
 * Spec §19/§44 — the minimum a quota may be reduced to, taken from a
 * `QUOTA_BELOW_SPENT` refusal, so the confirmation dialog can say "cannot be
 * reduced below ৳4,500" with the server's own number.
 */
export function quotaFloorFrom(e: unknown): number | undefined {
  const body = bodyOf(e) as Record<string, unknown> | undefined;
  if (!body) {return undefined;}
  const code = String(body.code ?? '');
  const raw = messageText(body.message);
  if (code !== 'QUOTA_BELOW_SPENT' && !raw.includes('quota_below_spent')) {return undefined;}
  return finiteNumber(body.minimumCredits);
}

/**
 * Spec §12/§42 — the already-open credit request id from a
 * `CREDIT_REQUEST_PENDING` refusal, so the UI shows "View Request" instead of a
 * button that would create a duplicate.
 */
export function pendingCreditRequestFrom(e: unknown): {id: string; requestedCredits?: number} | undefined {
  const body = bodyOf(e) as Record<string, unknown> | undefined;
  if (!body) {return undefined;}
  const code = String(body.code ?? '');
  const raw = messageText(body.message);
  if (code !== 'CREDIT_REQUEST_PENDING' && !raw.includes('credit_request_pending')) {return undefined;}
  const id = typeof body.requestId === 'string' ? body.requestId : undefined;
  if (!id) {return undefined;}
  return {id, requestedCredits: finiteNumber(body.requestedCredits)};
}

/**
 * Client-side fallback for when the error carries no shortfall: how many more
 * credits `balance` needs to reach `required`. Undefined when either number is
 * unknown or the balance already covers it, so the caller can fall back again
 * rather than asking for 0.
 */
export function shortfallFor(
  required: number | null | undefined,
  balance: number | null | undefined,
): number | undefined {
  const need = finiteNumber(required);
  const have = finiteNumber(balance);
  if (need === undefined || have === undefined || need <= have) {return undefined;}
  return Math.ceil(need - have);
}

/**
 * Human copy for a server error body, so a raw code can never reach an alert
 * or the booking store's `error` field (which BookingHistoryScreen renders).
 * Returns undefined when the body already carries a human message.
 */
export function humanCreditMessage(
  rawMessage: string,
  /**
   * Spec §9 — the caller is an active FAMILY MEMBER, so an empty wallet is the
   * ROOT account's, not theirs. Without this the member is told "you don't have
   * enough credits" when their own quota is untouched and there is nothing they
   * can do about the balance — the exact confusion §9 forbids.
   */
  opts?: {isFamilyMember?: boolean},
): string | undefined {
  // Spec §21 — checked FIRST: a suspended root outranks both the quota and the
  // balance, and telling the member anything else sends them somewhere useless.
  if (rawMessage.includes('root_account_suspended')) {
    return 'The Root Account is suspended, so family spending is paused. Contact your plan holder.';
  }
  if (rawMessage.includes(CODE)) {
    return opts?.isFamilyMember
      ? 'The Root Account currently has insufficient credit. Your own spending limit is unaffected.'
      : 'You don’t have enough Bravo Credits for this booking.';
  }
  // B-380 — the family cap rejection surfaced verbatim as
  // "family_spend_limit_exceeded" on the exec wizard and the pay sheet.
  // The server now also sends `code: 'SPENDING_QUOTA_EXCEEDED'`; the raw string
  // stays the match target because already-shipped clients key on it.
  if (rawMessage.includes('family_spend_limit_exceeded') || rawMessage.includes('SPENDING_QUOTA_EXCEEDED')) {
    return 'You’ve reached your spending limit. Ask your plan holder for more credit.';
  }
  // B-379 — the escrow controls race the release sweep by design, so these are
  // the EXPECTED failures, not rare ones. None may reach an Alert as a raw code.
  if (rawMessage.includes('confirm_not_allowed_review')) {
    return 'This payment is on hold for review by the Bravo Control System. You’ll be notified once it’s settled.';
  }
  if (rawMessage.includes('confirm_not_allowed')) {
    return 'This payment has already been settled — there is nothing left to release.';
  }
  if (rawMessage.includes('dispute_already_open')) {
    return 'A dispute is already open on this booking. The Bravo Control System is reviewing it.';
  }
  if (rawMessage.includes('dispute_not_allowed')) {
    return 'This payment has already been released, so it can no longer be disputed. Contact support for help.';
  }
  return undefined;
}
