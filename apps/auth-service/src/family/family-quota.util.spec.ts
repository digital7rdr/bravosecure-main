/**
 * Family spending-quota arithmetic — the rules the spec states as numbers.
 *
 * These are pure, so every one of them is exercised against the real function
 * rather than a mock. The service-level rules (locking, atomicity, the request
 * lifecycle, authorisation) live in family-quota.service.spec.ts; the
 * both-limits gate on the actual charge path is pinned by
 * booking.mon4-family-cap-lock.spec.ts.
 */
import {
  classifyQuotaChange, denialReason, effectiveSpendable, normalizeCredits,
  remainingQuota, resolveApprovedAmount, thresholdToNotify, usageBand,
  validateQuotaChange, MAX_QUOTA_CREDITS,
} from './family-quota.util';

describe('§30 — only valid positive monetary values are accepted', () => {
  it.each([0, -100, -500, 0.5, 1.01, NaN, Infinity, -Infinity])('rejects %p', v => {
    expect(normalizeCredits(v)).toBeNull();
  });

  it.each([null, undefined, '100', {}, [], true])('rejects the non-number %p', v => {
    expect(normalizeCredits(v)).toBeNull();
  });

  it('accepts positive integers up to the cap and rejects beyond it', () => {
    expect(normalizeCredits(1)).toBe(1);
    expect(normalizeCredits(5000)).toBe(5000);
    expect(normalizeCredits(MAX_QUOTA_CREDITS)).toBe(MAX_QUOTA_CREDITS);
    expect(normalizeCredits(MAX_QUOTA_CREDITS + 1)).toBeNull();
  });
});

describe('§3 — remaining quota', () => {
  it('is allocated minus used', () => {
    expect(remainingQuota(4000, 5000)).toBe(1000);
  });

  it('is 0 at exhaustion — the §2 worked example', () => {
    expect(remainingQuota(5000, 5000)).toBe(0);
  });

  it('NEVER reports a negative remaining, even from impossible stored data', () => {
    // §2: `Remaining = -৳500` is not a state this system may represent. If bad
    // data ever produces one we report exhausted rather than handing a caller a
    // negative it would treat as spendable.
    expect(remainingQuota(5500, 5000)).toBe(0);
  });

  it('is null — not Infinity — for an unlimited quota', () => {
    // Infinity would silently propagate into min()/arithmetic downstream.
    expect(remainingQuota(4000, null)).toBeNull();
  });
});

describe('§3/§10 — effective spendable is the MINIMUM of both limits', () => {
  it('the quota binds when the root has more (the §3 worked example)', () => {
    expect(effectiveSpendable(2000, 5000, 10_000)).toBe(3000);
  });

  it('the root balance binds when it is the smaller of the two', () => {
    // Root ৳1,000 vs ৳3,000 of quota left → ৳1,000.
    expect(effectiveSpendable(2000, 5000, 1000)).toBe(1000);
  });

  it('an unlimited quota is still bounded by the root balance', () => {
    expect(effectiveSpendable(9999, null, 700)).toBe(700);
  });

  it('a zero or negative root balance yields zero, never a negative', () => {
    expect(effectiveSpendable(0, 5000, 0)).toBe(0);
    expect(effectiveSpendable(0, 5000, -200)).toBe(0);
  });
});

describe('§8 vs §9 — the denial must name the RIGHT limit', () => {
  it('§8: quota exhausted while the root is flush', () => {
    expect(denialReason(100, 5000, 5000, 50_000)).toBe('SPENDING_QUOTA_EXCEEDED');
  });

  it('§9: the member has quota left but the ROOT is empty', () => {
    // The spec is explicit: do NOT tell the member their personal quota is
    // exhausted when it isn't. Member quota remaining ৳2,000, root ৳0.
    expect(denialReason(500, 3000, 5000, 0)).toBe('ROOT_CREDIT_UNAVAILABLE');
  });

  it('§10: root ৳300, quota remaining ৳500 — ৳400 is refused, ৳250 allowed', () => {
    expect(denialReason(400, 4500, 5000, 300)).toBe('ROOT_CREDIT_UNAVAILABLE');
    expect(denialReason(250, 4500, 5000, 300)).toBeNull();
  });

  it('spending exactly the remaining quota is allowed', () => {
    expect(denialReason(1000, 4000, 5000, 10_000)).toBeNull();
  });

  it('one credit more than remaining is not', () => {
    expect(denialReason(1001, 4000, 5000, 10_000)).toBe('SPENDING_QUOTA_EXCEEDED');
  });

  it('an unlimited quota is judged on the root balance alone', () => {
    expect(denialReason(900, 100_000, null, 1000)).toBeNull();
    expect(denialReason(1100, 100_000, null, 1000)).toBe('ROOT_CREDIT_UNAVAILABLE');
  });
});

describe('§34 — usage bands are a ratio, not an absolute', () => {
  it('classifies the documented bands', () => {
    expect(usageBand(0, 5000)).toBe(0);
    expect(usageBand(3999, 5000)).toBe(0);
    expect(usageBand(4000, 5000)).toBe(80);   // exactly 80%
    expect(usageBand(4100, 5000)).toBe(80);   // the §34 worked example
    expect(usageBand(4500, 5000)).toBe(90);
    expect(usageBand(5000, 5000)).toBe(100);
  });

  it('means the same thing at any scale', () => {
    expect(usageBand(400, 500)).toBe(80);
    expect(usageBand(400_000, 500_000)).toBe(80);
  });

  it('an unlimited quota has no band — there is nothing to be 80% of', () => {
    expect(usageBand(99_999, null)).toBe(0);
  });

  it('a zero quota is exhausted by definition (and never divides by zero)', () => {
    expect(usageBand(0, 0)).toBe(100);
    expect(Number.isNaN(usageBand(0, 0) as number)).toBe(false);
  });
});

describe('§34 — notifications fire on CROSSING, so they cannot spam', () => {
  it('announces a band the first time it is entered', () => {
    expect(thresholdToNotify(4100, 5000, 0)).toBe(80);
  });

  it('stays silent for every later transaction inside the same band', () => {
    expect(thresholdToNotify(4200, 5000, 80)).toBeNull();
    expect(thresholdToNotify(4300, 5000, 80)).toBeNull();
    expect(thresholdToNotify(4499, 5000, 80)).toBeNull();
  });

  it('fires again only on the next band up', () => {
    expect(thresholdToNotify(4500, 5000, 80)).toBe(90);
    expect(thresholdToNotify(5000, 5000, 90)).toBe(100);
    expect(thresholdToNotify(5000, 5000, 100)).toBeNull();
  });

  it('never announces band 0 — "0% used" is not a warning', () => {
    expect(thresholdToNotify(10, 5000, 0)).toBeNull();
  });

  it('a refund that drops usage does not fire anything by itself', () => {
    // §26 — the caller LOWERS the stored marker separately, which re-arms the
    // band; the notifier itself must stay quiet on the way down.
    expect(thresholdToNotify(3700, 5000, 100)).toBeNull();
  });
});

describe('§19 — a quota may never fall below what is already spent', () => {
  it('allows the legal reduction from the spec (5,000 → 4,000 with 3,000 used)', () => {
    expect(validateQuotaChange(4000, 3000)).toEqual({ok: true});
    expect(remainingQuota(3000, 4000)).toBe(1000);
  });

  it('REFUSES the illegal one (5,000 → 4,000 with 4,500 used) and names the floor', () => {
    // Allowing it would produce Remaining = -৳500, which §2 forbids outright.
    expect(validateQuotaChange(4000, 4500)).toEqual({
      ok: false, code: 'QUOTA_BELOW_SPENT', minimumCredits: 4500,
    });
  });

  it('permits setting the quota to exactly the used amount — the minimum', () => {
    expect(validateQuotaChange(4500, 4500)).toEqual({ok: true});
    expect(remainingQuota(4500, 4500)).toBe(0);
  });

  it('always permits an increase, a first-time set, and clearing to unlimited', () => {
    expect(validateQuotaChange(7000, 5000)).toEqual({ok: true});
    expect(validateQuotaChange(5000, 0)).toEqual({ok: true});
    expect(validateQuotaChange(null, 4500)).toEqual({ok: true});
  });

  it('refuses a zero quota when anything has been spent', () => {
    expect(validateQuotaChange(0, 1)).toEqual({
      ok: false, code: 'QUOTA_BELOW_SPENT', minimumCredits: 1,
    });
  });
});

describe('§18/§37 — quota changes are classified for the audit trail', () => {
  it('names each direction', () => {
    expect(classifyQuotaChange(5000, 7000)).toEqual({action: 'QUOTA_INCREASED', delta: 2000});
    expect(classifyQuotaChange(5000, 4000)).toEqual({action: 'QUOTA_DECREASED', delta: -1000});
    expect(classifyQuotaChange(null, 5000)).toEqual({action: 'QUOTA_CREATED', delta: null});
    expect(classifyQuotaChange(5000, null)).toEqual({action: 'QUOTA_CLEARED', delta: null});
  });

  it('reports NO delta across an unlimited boundary rather than inventing 0', () => {
    // "unlimited → 5,000" has no magnitude; a fabricated 0 would read as
    // "nothing changed" in the history, which is the opposite of the truth.
    expect(classifyQuotaChange(null, 5000).delta).toBeNull();
    expect(classifyQuotaChange(5000, null).delta).toBeNull();
  });

  it('still records an unchanged value — confirming a limit is an auditable act', () => {
    expect(classifyQuotaChange(5000, 5000)).toEqual({action: 'QUOTA_INCREASED', delta: 0});
  });
});

describe('§14 — partial approval', () => {
  it('approves the full request when no amount is given', () => {
    expect(resolveApprovedAmount(5000, undefined)).toEqual({ok: true, credits: 5000});
    expect(resolveApprovedAmount(5000, null)).toEqual({ok: true, credits: 5000});
  });

  it('approves less than requested — the spec worked example', () => {
    expect(resolveApprovedAmount(5000, 2000)).toEqual({ok: true, credits: 2000});
  });

  it('REFUSES approving more than was requested', () => {
    // Otherwise the approval screen becomes an unbounded quota editor with none
    // of the §19 checks the quota endpoint runs.
    expect(resolveApprovedAmount(5000, 6000)).toEqual({ok: false, code: 'APPROVAL_EXCEEDS_REQUEST'});
  });

  it('refuses a zero, negative or fractional approval', () => {
    expect(resolveApprovedAmount(5000, 0)).toEqual({ok: false, code: 'INVALID_AMOUNT'});
    expect(resolveApprovedAmount(5000, -1)).toEqual({ok: false, code: 'INVALID_AMOUNT'});
    expect(resolveApprovedAmount(5000, 10.5)).toEqual({ok: false, code: 'INVALID_AMOUNT'});
  });
});

describe('§13 — the approval worked example, end to end in arithmetic', () => {
  it('quota 5,000 / used 5,000 / remaining 0, +2,000 approved → remaining 2,000', () => {
    const quota = 5000, used = 5000;
    expect(remainingQuota(used, quota)).toBe(0);
    expect(denialReason(1, used, quota, 999_999)).toBe('SPENDING_QUOTA_EXCEEDED');

    const approved = resolveApprovedAmount(2000, undefined);
    expect(approved).toEqual({ok: true, credits: 2000});
    const newQuota = quota + (approved as {credits: number}).credits;

    expect(newQuota).toBe(7000);
    expect(remainingQuota(used, newQuota)).toBe(2000);
    expect(denialReason(2000, used, newQuota, 999_999)).toBeNull();
    // …and the band marker drops out of "exhausted", so the holder can be
    // warned again on the new quota (5,000 of 7,000 = 71%).
    expect(usageBand(used, newQuota)).toBe(0);
  });
});

describe('§26 — a refund raises remaining quota', () => {
  it('the worked example: used 4,000 → 3,700 after a ৳300 refund', () => {
    const quota = 5000;
    expect(remainingQuota(4000, quota)).toBe(1000);
    const afterRefund = 4000 - 300;
    expect(afterRefund).toBe(3700);
    expect(remainingQuota(afterRefund, quota)).toBe(1300);
  });

  it('a refund can never drive the used amount negative in the reported figures', () => {
    // The DB does this with GREATEST(0, …); this pins that the arithmetic on
    // top of it also cannot report a remaining above the quota.
    expect(remainingQuota(0, 5000)).toBe(5000);
    expect(remainingQuota(Math.max(0, 100 - 300), 5000)).toBe(5000);
  });
});
