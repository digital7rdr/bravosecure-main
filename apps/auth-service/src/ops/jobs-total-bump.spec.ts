import {shouldBumpAgencyJobs} from './ops.service';

// RATING-CARD (#10) — the legacy completeBooking path bumped only the deployed
// crew CPOs (paidIds), never the agency org user, so an agency's jobs_total (its
// "N jobs" rating card) stayed 0. The fix bumps the provider once per completion,
// guarded so a CPO who is ALSO their own provider isn't counted twice.
describe('shouldBumpAgencyJobs', () => {
  it('bumps a real agency provider that is not in the paid crew', () => {
    expect(shouldBumpAgencyJobs('agency-A', ['cpo-1', 'cpo-2'])).toBe(true);
  });

  it('does NOT bump when the provider is also a paid crew member (no double-count)', () => {
    expect(shouldBumpAgencyJobs('cpo-1', ['cpo-1', 'cpo-2'])).toBe(false);
  });

  it('bumps when there is a provider but no crew was paid', () => {
    expect(shouldBumpAgencyJobs('agency-A', [])).toBe(true);
  });

  it('does NOT bump when there is no provider', () => {
    expect(shouldBumpAgencyJobs(null, ['cpo-1'])).toBe(false);
    expect(shouldBumpAgencyJobs(undefined, ['cpo-1'])).toBe(false);
    expect(shouldBumpAgencyJobs('', ['cpo-1'])).toBe(false);
  });
});
