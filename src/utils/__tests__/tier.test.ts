import {isProUser, isProActive, effectiveTier} from '../tier';

/**
 * RS-19 — the tier helper must treat a lapsed Pro window (pro_active_until in
 * the past) as Lite locally, even when the cached subscription_tier still reads
 * 'pro' (a server downgrade the warm app hasn't re-pulled yet). It must never
 * fabricate 'pro' — only demote a stale one.
 */
describe('tier RS-19 — local pro_active_until expiry guard', () => {
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const past = new Date(Date.now() - 86_400_000).toISOString();

  it('pro with no expiry recorded → pro (comp/permanent grant)', () => {
    const u = {subscription_tier: 'pro' as const, pro_active_until: null};
    expect(isProUser(u)).toBe(true);
    expect(isProActive(u)).toBe(true);
    expect(effectiveTier(u)).toBe('pro');
  });

  it('pro with a FUTURE expiry → pro', () => {
    const u = {subscription_tier: 'pro' as const, pro_active_until: future};
    expect(isProUser(u)).toBe(true);
    expect(effectiveTier(u)).toBe('pro');
  });

  it('pro with a PAST expiry → lite (core RS-19 stale-downgrade)', () => {
    const u = {subscription_tier: 'pro' as const, pro_active_until: past};
    expect(isProUser(u)).toBe(false);
    expect(isProActive(u)).toBe(false);
    expect(effectiveTier(u)).toBe('lite');
  });

  it('lite with any expiry → lite', () => {
    expect(isProUser({subscription_tier: 'lite', pro_active_until: future})).toBe(false);
    expect(effectiveTier({subscription_tier: 'lite', pro_active_until: future})).toBe('lite');
  });

  it('pro with an unparseable expiry → pro (guard never wrongly demotes)', () => {
    const u = {subscription_tier: 'pro' as const, pro_active_until: 'not-a-date'};
    expect(isProUser(u)).toBe(true);
  });

  it('null / undefined user → lite', () => {
    expect(isProUser(null)).toBe(false);
    expect(isProUser(undefined)).toBe(false);
    expect(effectiveTier(null)).toBe('lite');
  });
});

/**
 * M1A — Enterprise joins the tier ladder above Pro. The same RS-19 lapse
 * rules apply, and every existing isProUser() gate admits an active
 * Enterprise account (matrix superset rule).
 */
describe('tier M1A — enterprise', () => {
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const past = new Date(Date.now() - 86_400_000).toISOString();

  it('enterprise with no expiry → enterprise (comp/permanent grant)', () => {
    const u = {subscription_tier: 'enterprise' as const, pro_active_until: null};
    expect(effectiveTier(u)).toBe('enterprise');
    expect(isProUser(u)).toBe(true); // superset: pro gates admit enterprise
  });

  it('enterprise with a FUTURE expiry → enterprise', () => {
    const u = {subscription_tier: 'enterprise' as const, pro_active_until: future};
    expect(effectiveTier(u)).toBe('enterprise');
    expect(isProActive(u)).toBe(true);
  });

  it('enterprise with a PAST expiry → lite (RS-19 applies to every paid tier)', () => {
    const u = {subscription_tier: 'enterprise' as const, pro_active_until: past};
    expect(effectiveTier(u)).toBe('lite');
    expect(isProUser(u)).toBe(false);
  });

  it('enterprise with an unparseable expiry → enterprise (never wrongly demotes)', () => {
    const u = {subscription_tier: 'enterprise' as const, pro_active_until: 'not-a-date'};
    expect(effectiveTier(u)).toBe('enterprise');
  });
});
