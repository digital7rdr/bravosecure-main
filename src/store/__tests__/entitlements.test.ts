/**
 * M1A — deriveEntitlements: org-OR-tier, never double-gate. Cloud vault is
 * Pro+; the enterprise feature set unlocks via paid tier OR org tenancy.
 * authStore is mocked — deriveEntitlements is pure over the user shape, and
 * the real store drags native deps (expo-local-authentication) into a unit test.
 */
jest.mock('@store/authStore', () => ({
  useAuthStore: Object.assign(jest.fn(), {getState: () => ({user: null})}),
}));

import {deriveEntitlements} from '@store/entitlements';

const base = {id: 'u1', email: 'x@y.z', full_name: 'X', role: 'individual'};

describe('entitlements M1A', () => {
  it('lite individual: no vault, no dept channels', () => {
    const e = deriveEntitlements({...base, subscription_tier: 'lite'} as never);
    expect(e.hasCloudVault).toBe(false);
    expect(e.hasDeptChannels).toBe(false);
    expect(e.effective).toBe('lite');
  });

  it('active pro individual: vault yes, dept channels no', () => {
    const e = deriveEntitlements({...base, subscription_tier: 'pro', pro_active_until: null} as never);
    expect(e.hasCloudVault).toBe(true);
    expect(e.hasDeptChannels).toBe(false);
    expect(e.hasSM512Label).toBe(true);
  });

  it('active enterprise individual: vault + dept channels (founder: inherit the 3 features)', () => {
    const e = deriveEntitlements({...base, subscription_tier: 'enterprise', pro_active_until: null} as never);
    expect(e.hasCloudVault).toBe(true);
    expect(e.hasDeptChannels).toBe(true);
    expect(e.isEnterprise).toBe(true);
    expect(e.isOrgAffiliated).toBe(false);
  });

  it('LAPSED enterprise individual: everything locks again', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const e = deriveEntitlements({...base, subscription_tier: 'enterprise', pro_active_until: past} as never);
    expect(e.hasCloudVault).toBe(false);
    expect(e.hasDeptChannels).toBe(false);
    expect(e.effective).toBe('lite');
  });

  it('lite ORG member (managed CPO): keeps vault + dept channels via tenancy', () => {
    const e = deriveEntitlements({
      ...base, subscription_tier: 'lite', account_kind: 'cpo',
      membership_status: 'active', org: {id: 'o1', name: 'Acme'},
    } as never);
    expect(e.hasCloudVault).toBe(true);
    expect(e.hasDeptChannels).toBe(true);
    expect(e.isOrgAffiliated).toBe(true);
  });

  it('SUSPENDED org member on lite: tenancy no longer entitles', () => {
    const e = deriveEntitlements({
      ...base, subscription_tier: 'lite', account_kind: 'cpo',
      membership_status: 'suspended', org: {id: 'o1', name: 'Acme'},
    } as never);
    expect(e.hasCloudVault).toBe(false);
    expect(e.hasDeptChannels).toBe(false);
  });

  it('agency/provider account: enterprise set regardless of tier (rule 7 untouched)', () => {
    const e = deriveEntitlements({
      ...base, role: 'service_provider', subscription_tier: 'lite', account_kind: 'agency',
    } as never);
    expect(e.isEnterprise).toBe(true);
    expect(e.hasDeptChannels).toBe(true);
    expect(e.hasCloudVault).toBe(true);
  });

  /**
   * Scope v2 Phase 6 — THE BLOCKER: an Enterprise workspace OWNER.
   *
   * They deliberately have no agents row and no org_members row, because the
   * alternative was to mint them through the service-provider funnel, which
   * would have put an Enterprise company in the provider home and the job
   * marketplace (owner-decided 2026-08-04).
   *
   * So `account_kind` is 'individual', `role` is not service_provider, and
   * `membership_status` is null — EVERY pre-existing arm of isOrgAffiliated
   * reports false. Without `owns_workspace` the person who just created the
   * workspace is locked out of it: no Company shelf, no Departmental entry.
   */
  it('workspace OWNER is org-affiliated even though they are not an agency', () => {
    const e = deriveEntitlements({
      ...base, role: 'user', subscription_tier: 'enterprise',
      account_kind: 'individual', membership_status: null, org: null,
      owns_workspace: true,
    } as never);
    expect(e.isOrgAffiliated).toBe(true);
    expect(e.isEnterprise).toBe(true);
    expect(e.hasDeptChannels).toBe(true);
    // …and it did NOT reclassify them as an agency. That distinction is the
    // whole reason this flag exists rather than reusing account_kind.
    expect(e.hasCloudVault).toBe(true);
  });

  it('an Enterprise individual with NO workspace is still not org-affiliated', () => {
    // The pre-existing "enterprise tier individual" case must not drift: paying
    // for the tier is not the same as being inside an org, and Phase 0 depends
    // on the two staying distinct (deptNoun's `enterpriseIndividual`).
    const e = deriveEntitlements({
      ...base, role: 'user', subscription_tier: 'enterprise',
      account_kind: 'individual', membership_status: null, org: null,
    } as never);
    expect(e.isOrgAffiliated).toBe(false);
    expect(e.isEnterprise).toBe(true);
  });

  it('owns_workspace is only honoured when the SERVER says true', () => {
    // Fails closed on anything that is not an explicit true — the flag arrives
    // from /auth/me and a missing field must never read as ownership.
    for (const v of [undefined, null, false, 'true', 1]) {
      const e = deriveEntitlements({
        ...base, role: 'user', account_kind: 'individual',
        membership_status: null, org: null, owns_workspace: v,
      } as never);
      expect(e.isOrgAffiliated).toBe(false);
    }
  });

  it('null user: fully locked', () => {
    const e = deriveEntitlements(null as never);
    expect(e.hasCloudVault).toBe(false);
    expect(e.hasDeptChannels).toBe(false);
    expect(e.effective).toBe('lite');
  });
});
