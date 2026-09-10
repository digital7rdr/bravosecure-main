/**
 * Issue 25 (Testing Issues V2, PDF p.30) — "Insufficient Credits Flow Stops
 * With 'Booking Failed' Instead of Top-Up".
 *
 * The reported screen showed title "Booking failed", body "insufficient_credits".
 * That is the SERVER-side rejection: bookingStore.confirmBooking flattened the
 * structured 400 into a bare Error, so CustomizeAddOnsScreen's `direct?.code`
 * check (which only ever matched the LOCAL pre-check) missed it and the raw code
 * fell through to the generic alert.
 *
 * These cases pin every error shape that means "wallet is short".
 */
import {
  isInsufficientCreditsError,
  creditShortfallFrom,
  humanCreditMessage,
} from '../creditErrors';

/** The typed error bookingStore throws BEFORE the request (auto-dispatch soft check). */
function localError(amountDue?: number) {
  const e: Error & {code?: string; amountDue?: number} = new Error('insufficient_credits');
  e.code = 'insufficient_credits';
  if (amountDue !== undefined) {e.amountDue = amountDue;}
  return e;
}

/** A live axios error carrying a Nest response body. */
function serverError(data: unknown) {
  return {isAxiosError: true, message: 'Request failed with status code 400', response: {status: 400, data}};
}

describe('isInsufficientCreditsError', () => {
  it('detects the local pre-check error (code on the error itself)', () => {
    expect(isInsufficientCreditsError(localError(120))).toBe(true);
  });

  it('detects the structured server body', () => {
    expect(
      isInsufficientCreditsError(
        serverError({code: 'insufficient_credits', message: 'insufficient_credits', required: 900, balance: 300}),
      ),
    ).toBe(true);
  });

  it('detects the legacy flat server body (message only) — the shape in the bug report', () => {
    expect(
      isInsufficientCreditsError(serverError({statusCode: 400, message: 'insufficient_credits', error: 'Bad Request'})),
    ).toBe(true);
  });

  it("detects Nest's validation-pipe string[] message", () => {
    expect(isInsufficientCreditsError(serverError({message: ['insufficient_credits']}))).toBe(true);
  });

  it('detects an Error flattened by a store re-throw (only the message survives)', () => {
    // This is exactly what confirmBooking used to hand the screen.
    expect(isInsufficientCreditsError(new Error('insufficient_credits'))).toBe(true);
  });

  it('is false for a different server code', () => {
    expect(isInsufficientCreditsError(serverError({code: 'active_booking_exists', message: 'You already have one.'})))
      .toBe(false);
  });

  it('is false for a lookalike code', () => {
    expect(isInsufficientCreditsError(serverError({message: 'tier_insufficient'}))).toBe(false);
  });

  it('is false for a plain network error', () => {
    expect(isInsufficientCreditsError(new Error('Network Error'))).toBe(false);
  });

  it('is false for null / undefined / primitives (never throws)', () => {
    expect(isInsufficientCreditsError(null)).toBe(false);
    expect(isInsufficientCreditsError(undefined)).toBe(false);
    expect(isInsufficientCreditsError('insufficient_credits')).toBe(false);
    expect(isInsufficientCreditsError(42)).toBe(false);
  });
});

describe('creditShortfallFrom', () => {
  it('uses amountDue from the local pre-check', () => {
    expect(creditShortfallFrom(localError(120))).toBe(120);
  });

  it('derives required minus balance from the structured server body', () => {
    expect(creditShortfallFrom(serverError({code: 'insufficient_credits', required: 900, balance: 300}))).toBe(600);
  });

  it('rounds the shortfall UP — the floor would still leave the payer short', () => {
    expect(creditShortfallFrom(serverError({required: 900.5, balance: 300}))).toBe(601);
    expect(creditShortfallFrom(localError(120.2))).toBe(121);
  });

  it('is undefined for the legacy flat body, so the caller falls back to its own arithmetic', () => {
    expect(creditShortfallFrom(serverError({statusCode: 400, message: 'insufficient_credits'}))).toBeUndefined();
  });

  it('is undefined when the balance already covers the requirement (never a zero/negative top-up)', () => {
    expect(creditShortfallFrom(serverError({required: 300, balance: 900}))).toBeUndefined();
    expect(creditShortfallFrom(serverError({required: 300, balance: 300}))).toBeUndefined();
  });

  it('ignores non-finite values rather than producing NaN', () => {
    expect(creditShortfallFrom(serverError({required: 'lots', balance: 3}))).toBeUndefined();
    expect(creditShortfallFrom(serverError({required: Number.POSITIVE_INFINITY, balance: 3}))).toBeUndefined();
  });

  it('is undefined for null / primitives (never throws)', () => {
    expect(creditShortfallFrom(null)).toBeUndefined();
    expect(creditShortfallFrom('nope')).toBeUndefined();
  });
});

describe('humanCreditMessage', () => {
  it('replaces the raw code with human copy', () => {
    expect(humanCreditMessage('insufficient_credits')).toBe(
      'You don’t have enough Bravo Credits for this booking.',
    );
  });

  it('leaves an unrelated message alone so its own text still surfaces', () => {
    expect(humanCreditMessage('You already have an active booking.')).toBeUndefined();
  });

  it('never lets the raw code reach a user-facing string', () => {
    const out = humanCreditMessage('insufficient_credits');
    expect(out).toBeDefined();
    expect(out).not.toContain('insufficient_credits');
  });

  // B-380 — a capped family member saw the literal snake_case code as the alert
  // text on the exec wizard and the pay sheet.
  it('humanizes family_spend_limit_exceeded (B-380)', () => {
    // RE-POINTED, not weakened. B-380's defect was the RAW CODE reaching an
    // alert; the phrase "family spend limit" was this pin's anchor, not its
    // rule. The quota spec (§8) mandates the user-facing wording
    // «You've reached your spending limit», with a route to ask for more — so
    // the copy changed and the invariant did not. Both halves are asserted:
    // no raw code, and the message still tells the member what to do next.
    const out = humanCreditMessage('family_spend_limit_exceeded');
    expect(out).toBeDefined();
    expect(out).not.toContain('family_spend_limit_exceeded');
    expect(out).toContain('spending limit');
    expect(out).toMatch(/plan holder/i);
  });

  it('the structured SPENDING_QUOTA_EXCEEDED code humanizes the same way (§8)', () => {
    const out = humanCreditMessage('SPENDING_QUOTA_EXCEEDED');
    expect(out).toContain('spending limit');
    expect(out).not.toContain('SPENDING_QUOTA_EXCEEDED');
  });

  it('§21 — a suspended root account gets its OWN message, not a limit message', () => {
    const out = humanCreditMessage('root_account_suspended');
    expect(out).toBeDefined();
    expect(out).not.toContain('root_account_suspended');
    expect(out).toMatch(/suspended/i);
    // Must NOT blame the member's own limit — nothing about their quota is wrong.
    expect(out).not.toMatch(/your spending limit/i);
  });

  it('§9 — an empty wallet reads differently for a family member than for a solo payer', () => {
    const solo = humanCreditMessage('insufficient_credits');
    const member = humanCreditMessage('insufficient_credits', {isFamilyMember: true});
    expect(solo).toMatch(/you don’t have enough/i);
    // The member's own quota is fine; saying otherwise is exactly what §9 forbids.
    expect(member).toMatch(/Root Account/i);
    expect(member).not.toMatch(/you don’t have enough/i);
    expect(member).not.toBe(solo);
  });
});
