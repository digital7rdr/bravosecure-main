/**
 * Family spending-quota arithmetic — pure, so every rule in the spec can be
 * exercised without a database or a Nest module.
 *
 * The three quantities the spec insists on keeping separate (§3) map onto the
 * existing schema like this, and nothing here invents a fourth:
 *
 *   Root Available Credit   → wallet_balances.bravo_credits
 *   Member Allocated Quota  → family_members.spend_limit_credits  (NULL = unlimited)
 *   Member Used Amount      → family_members.spent_credits
 *
 * All values are whole BRAVO CREDITS stored as INTEGER (§31): the wallet is
 * pegged 1 credit = 1 unit of fiat and has never used a float, so there is no
 * money to lose to binary fractions and no minor-unit conversion to get wrong.
 * Callers must hand these functions integers; `normalizeCredits` is the gate.
 */

/** The usage bands the holder is warned about (§34). 0 = nothing to announce. */
export type UsageBand = 0 | 80 | 90 | 100;

/** Upper bound on any single quota or request, mirroring the DTO validators. */
export const MAX_QUOTA_CREDITS = 1_000_000;

/**
 * Coerce a client-supplied credit amount to a safe positive integer, or null.
 *
 * Rejects everything §30 lists — 0, negatives, NaN, Infinity, null, undefined,
 * and non-integers — by returning null. Callers turn null into a 400; this
 * function never throws so it can also be used for soft/optional fields.
 */
export function normalizeCredits(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) {return null;}
  if (!Number.isInteger(v)) {return null;}
  if (v <= 0 || v > MAX_QUOTA_CREDITS) {return null;}
  return v;
}

/**
 * Remaining quota (§3). `null` limit means unlimited — there is no number to
 * return, and returning Infinity would leak into arithmetic downstream.
 *
 * Clamped at 0: a remaining below zero is not a state the system may represent
 * (§2), so if bad data ever produces one we report exhausted rather than
 * handing a negative to a caller that would treat it as spendable.
 */
export function remainingQuota(spent: number, limit: number | null): number | null {
  if (limit === null) {return null;}
  return Math.max(0, limit - spent);
}

/**
 * The most a member may spend right now (§3, §10) — BOTH limits at once.
 *
 *   effectiveSpendable = min(remaining quota, root available credit)
 *
 * With an unlimited quota the root balance alone is the ceiling. A negative
 * root balance (which the ledger must never produce) is floored at 0 rather
 * than propagated.
 */
export function effectiveSpendable(
  spent: number, limit: number | null, rootAvailable: number,
): number {
  const root = Math.max(0, rootAvailable);
  const remaining = remainingQuota(spent, limit);
  return remaining === null ? root : Math.min(remaining, root);
}

/**
 * Which limit blocks a spend of `amount` — and it must name the RIGHT one.
 *
 * §9 is explicit that a member whose own quota is fine must not be told their
 * quota is exhausted when the real problem is the root balance. The quota is
 * checked first because it is the member's own constraint; when both are
 * short, the quota is the more actionable message (they can request more).
 */
export function denialReason(
  amount: number, spent: number, limit: number | null, rootAvailable: number,
): 'SPENDING_QUOTA_EXCEEDED' | 'ROOT_CREDIT_UNAVAILABLE' | null {
  const remaining = remainingQuota(spent, limit);
  if (remaining !== null && amount > remaining) {return 'SPENDING_QUOTA_EXCEEDED';}
  if (amount > Math.max(0, rootAvailable)) {return 'ROOT_CREDIT_UNAVAILABLE';}
  return null;
}

/**
 * The usage band a member currently occupies (§34).
 *
 * A ratio, not an absolute: the warning must mean the same thing on a ৳500
 * quota and a ৳500,000 one. An unlimited quota has no band — there is nothing
 * to be 80% of. A zero (or negative) quota is exhausted by definition, which is
 * also what keeps 0/0 out of the arithmetic.
 */
export function usageBand(spent: number, limit: number | null): UsageBand {
  if (limit === null) {return 0;}
  if (limit <= 0) {return 100;}
  const pct = (spent / limit) * 100;
  if (pct >= 100) {return 100;}
  if (pct >= 90) {return 90;}
  if (pct >= 80) {return 80;}
  return 0;
}

/**
 * Should a threshold notification fire, and for which band?
 *
 * Returns the band to announce, or null. This is the whole anti-spam mechanism
 * (§34): it fires only on an UPWARD crossing out of the band already recorded
 * against the member, so ten transactions inside the 80s produce one warning.
 * A refund that drops usage back down returns null here — the caller lowers the
 * stored marker separately, which re-arms the band for a future crossing.
 */
export function thresholdToNotify(
  spent: number, limit: number | null, alreadyNotified: number,
): Exclude<UsageBand, 0> | null {
  // `Exclude<…, 0>` in the return type, not just at the call site: 0 means "no
  // band", and letting it escape would let a caller publish a "0% used"
  // warning. Narrowed here so the notifier's own signature can refuse it.
  const band = usageBand(spent, limit);
  return band !== 0 && band > alreadyNotified ? band : null;
}

/**
 * Validate a quota change before it touches the row (§19 — THE rule).
 *
 * A quota may never be set below what the member has already spent, because
 * that is precisely how `Remaining = -৳500` gets created. The minimum legal
 * quota is therefore the used amount itself, and that number is returned so the
 * caller can put it in the error the UI shows.
 *
 * Raising a quota, clearing it to unlimited, and setting it for the first time
 * are all unconditionally legal — none of them can produce a negative
 * remaining.
 */
export function validateQuotaChange(
  nextLimit: number | null, spent: number,
): {ok: true} | {ok: false; code: 'QUOTA_BELOW_SPENT'; minimumCredits: number} {
  if (nextLimit === null) {return {ok: true};}
  if (nextLimit < spent) {return {ok: false, code: 'QUOTA_BELOW_SPENT', minimumCredits: spent};}
  return {ok: true};
}

/**
 * Classify a quota change for the audit trail (§18, §37).
 *
 * `null` on either side is unlimited, so a delta is not always a meaningful
 * number — crossing the unlimited boundary has no magnitude and the delta is
 * reported as null rather than as a fabricated 0.
 */
export function classifyQuotaChange(
  previous: number | null, next: number | null,
): {action: 'QUOTA_CREATED' | 'QUOTA_INCREASED' | 'QUOTA_DECREASED' | 'QUOTA_CLEARED'; delta: number | null} {
  if (next === null) {return {action: 'QUOTA_CLEARED', delta: null};}
  if (previous === null) {return {action: 'QUOTA_CREATED', delta: null};}
  if (next > previous) {return {action: 'QUOTA_INCREASED', delta: next - previous};}
  if (next < previous) {return {action: 'QUOTA_DECREASED', delta: next - previous};}
  // An unchanged value is still recorded — "root confirmed the limit" is an
  // auditable act, and silently dropping it would leave a gap in the history.
  return {action: 'QUOTA_INCREASED', delta: 0};
}

/**
 * The approved amount for a credit request (§14 — partial approval).
 *
 * Root may approve LESS than was asked for, never more: approving more would
 * let the approval screen become an unbounded quota-editing surface with none
 * of the §19 checks the quota endpoint runs. Omitting the amount approves the
 * full request.
 */
export function resolveApprovedAmount(
  requested: number, approved: number | null | undefined,
): {ok: true; credits: number} | {ok: false; code: 'INVALID_AMOUNT' | 'APPROVAL_EXCEEDS_REQUEST'} {
  if (approved === null || approved === undefined) {return {ok: true, credits: requested};}
  const n = normalizeCredits(approved);
  if (n === null) {return {ok: false, code: 'INVALID_AMOUNT'};}
  if (n > requested) {return {ok: false, code: 'APPROVAL_EXCEEDS_REQUEST'};}
  return {ok: true, credits: n};
}
