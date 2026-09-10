/**
 * Family spending-quota error handling on the CLIENT.
 *
 * The server is the authority on every number here (§38, §48); these helpers
 * only decide which screen the member sees and which figures it may render
 * without a second round trip. The rule that matters most is §8 vs §9: two
 * different refusals that must never be shown interchangeably, because one has
 * a "Request More Credit" action and the other has nothing the member can do.
 */
import {
  humanCreditMessage, pendingCreditRequestFrom, quotaFiguresFrom,
  quotaFloorFrom, spendDenialKind,
} from '../creditErrors';

/** An axios-shaped rejection carrying a Nest structured 400 body. */
const serverError = (body: Record<string, unknown>) => ({response: {data: body}});

describe('§8 vs §9 — the denial names the right limit', () => {
  it('§8: the member\'s own quota is exhausted', () => {
    const e = serverError({
      code: 'SPENDING_QUOTA_EXCEEDED', message: 'family_spend_limit_exceeded',
      required: 400, allocated: 5000, used: 5000, remaining: 0,
    });
    expect(spendDenialKind(e, {isFamilyMember: true})).toBe('SPENDING_QUOTA_EXCEEDED');
  });

  it('§9: the ROOT is empty while the member still has quota', () => {
    const e = serverError({code: 'insufficient_credits', message: 'insufficient_credits', required: 400, balance: 0});
    expect(spendDenialKind(e, {isFamilyMember: true})).toBe('ROOT_CREDIT_UNAVAILABLE');
  });

  it('the SAME wire error means something else for a solo payer', () => {
    // Identical body — only the caller's own membership distinguishes them, and
    // the copy must follow.
    const e = serverError({code: 'insufficient_credits', message: 'insufficient_credits'});
    expect(spendDenialKind(e, {isFamilyMember: false})).toBe('INSUFFICIENT_CREDITS');
    expect(spendDenialKind(e)).toBe('INSUFFICIENT_CREDITS');
  });

  it('§21: a suspended root outranks both, and is checked first', () => {
    const e = serverError({code: 'ROOT_ACCOUNT_SUSPENDED', message: 'root_account_suspended'});
    expect(spendDenialKind(e, {isFamilyMember: true})).toBe('ROOT_ACCOUNT_SUSPENDED');
  });

  it('is undefined for an unrelated failure — it must not swallow real errors', () => {
    expect(spendDenialKind(serverError({message: 'Booking not found'}))).toBeUndefined();
    expect(spendDenialKind(new Error('network timeout'))).toBeUndefined();
    expect(spendDenialKind(null)).toBeUndefined();
    expect(spendDenialKind(undefined)).toBeUndefined();
  });

  it('survives a flattened Error that kept only the raw code', () => {
    // The store's catch has historically collapsed structured bodies into
    // `new Error(raw)`; all three carriers must still resolve.
    expect(spendDenialKind(new Error('family_spend_limit_exceeded'))).toBe('SPENDING_QUOTA_EXCEEDED');
    expect(spendDenialKind(new Error('root_account_suspended'))).toBe('ROOT_ACCOUNT_SUSPENDED');
  });

  it('reads a validation-pipe string[] message as well as a string', () => {
    const e = serverError({message: ['family_spend_limit_exceeded', 'something else']});
    expect(spendDenialKind(e)).toBe('SPENDING_QUOTA_EXCEEDED');
  });
});

describe('§48 — the figures come from the server, never from the stale UI', () => {
  it('extracts the full quota picture from the refusal', () => {
    const e = serverError({
      code: 'SPENDING_QUOTA_EXCEEDED', message: 'family_spend_limit_exceeded',
      required: 400, allocated: 5000, used: 4250, remaining: 750,
    });
    expect(quotaFiguresFrom(e)).toEqual({required: 400, allocated: 5000, used: 4250, remaining: 750});
  });

  it('returns undefined rather than a partial set — the caller must refresh', () => {
    // Rendering three real numbers and one guessed one is worse than refreshing:
    // the whole point of §48 is that the client's own copy may be wrong.
    expect(quotaFiguresFrom(serverError({code: 'SPENDING_QUOTA_EXCEEDED', required: 400}))).toBeUndefined();
    expect(quotaFiguresFrom(serverError({}))).toBeUndefined();
    expect(quotaFiguresFrom(new Error('family_spend_limit_exceeded'))).toBeUndefined();
  });
});

describe('§19/§44 — the quota floor for the confirmation dialog', () => {
  it('reads the minimum from a QUOTA_BELOW_SPENT refusal', () => {
    const e = serverError({code: 'QUOTA_BELOW_SPENT', message: 'quota_below_spent', minimumCredits: 4500, spentCredits: 4500});
    expect(quotaFloorFrom(e)).toBe(4500);
  });

  it('ignores an unrelated error, so a stale floor cannot be shown', () => {
    expect(quotaFloorFrom(serverError({code: 'insufficient_credits', minimumCredits: 4500}))).toBeUndefined();
    expect(quotaFloorFrom(serverError({code: 'QUOTA_BELOW_SPENT'}))).toBeUndefined();
  });
});

describe('§12/§42 — never offer a button that creates a duplicate request', () => {
  it('extracts the OPEN request id so the UI can show "View Request"', () => {
    const e = serverError({
      code: 'CREDIT_REQUEST_PENDING', message: 'credit_request_pending',
      requestId: 'req-1', requestedCredits: 2000,
    });
    expect(pendingCreditRequestFrom(e)).toEqual({id: 'req-1', requestedCredits: 2000});
  });

  it('returns undefined without an id — there is nothing to link to', () => {
    expect(pendingCreditRequestFrom(serverError({code: 'CREDIT_REQUEST_PENDING'}))).toBeUndefined();
    expect(pendingCreditRequestFrom(serverError({code: 'insufficient_credits', requestId: 'x'}))).toBeUndefined();
  });
});

describe('no raw server code may ever reach the user (§8)', () => {
  it.each([
    'root_account_suspended',
    'family_spend_limit_exceeded',
    'SPENDING_QUOTA_EXCEEDED',
    'insufficient_credits',
  ])('%s is humanized', raw => {
    const out = humanCreditMessage(raw, {isFamilyMember: true});
    expect(out).toBeDefined();
    expect(out).not.toContain(raw);
    expect(out).not.toMatch(/_/);
  });
});
