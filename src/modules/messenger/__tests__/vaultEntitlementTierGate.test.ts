/**
 * `entitlementGate` — M1A rule 12, the Secure Cloud Vault tier seam.
 *
 * The whole file was at 0% executable coverage in both Jest projects: the
 * `vaultNavigation` suite mocks this module wholesale to exercise the three
 * routing branches behind it, so nothing had ever run the gate ITSELF. Deleting
 * its body and returning `true` broke no test.
 *
 * The REAL `deriveEntitlements` / `effectiveTier` run here — only `authStore` is
 * stubbed — because the interesting part is the tier BOUNDARY, and a mocked
 * entitlement derivation would just be asserting the mock. The boundaries that
 * matter:
 *
 *   - Lite is out. Pro and Enterprise are in (M1A matrix, `hasCloudVault`).
 *   - A LAPSED paid window is Lite again (RS-19): a cached `subscription_tier`
 *     of 'pro' whose `pro_active_until` has passed must NOT open the vault.
 *   - Org tenancy entitles regardless of tier — but only an ACTIVE membership.
 *
 * The gate is display-side: the server backstops it at action-token issuance
 * (403 tier_insufficient), so nothing here is the last line of defence — but a
 * gate that reads the wrong way either sells a paid feature for free or locks a
 * paying customer out of files they already own.
 */
import type {User} from '@appTypes/index';

const mockUser: {value: Partial<User> | null} = {value: null};
const mockAlert = jest.fn();
const mockOpenPricing = jest.fn(() => true);

jest.mock('@store/authStore', () => ({
  useAuthStore: {getState: () => ({user: mockUser.value})},
}));
jest.mock('@utils/alert', () => ({Alert: {alert: (...a: unknown[]) => mockAlert(...a)}}));
jest.mock('@navigation/openPricing', () => ({openPricing: () => mockOpenPricing()}));

import {hasCloudVaultEntitlement, promptCloudVaultUpgrade} from '../vault/entitlementGate';

const asUser = (u: Partial<User>): Partial<User> => u;
const DAY = 86_400_000;
const future = () => new Date(Date.now() + 30 * DAY).toISOString();
const past = () => new Date(Date.now() - DAY).toISOString();

beforeEach(() => {
  jest.clearAllMocks();
  mockUser.value = null;
});

describe('hasCloudVaultEntitlement — the paid-tier boundary', () => {
  it('a signed-out caller is NOT entitled', () => {
    mockUser.value = null;
    expect(hasCloudVaultEntitlement()).toBe(false);
  });

  it('Lite is not entitled', () => {
    mockUser.value = asUser({subscription_tier: 'lite'});
    expect(hasCloudVaultEntitlement()).toBe(false);
  });

  it('a user with no tier recorded defaults to Lite, not to entitled', () => {
    mockUser.value = asUser({});
    expect(hasCloudVaultEntitlement()).toBe(false);
  });

  it('Pro is entitled', () => {
    mockUser.value = asUser({subscription_tier: 'pro'});
    expect(hasCloudVaultEntitlement()).toBe(true);
  });

  it('Enterprise is entitled', () => {
    mockUser.value = asUser({subscription_tier: 'enterprise'});
    expect(hasCloudVaultEntitlement()).toBe(true);
  });

  it('Pro inside its paid window is entitled', () => {
    mockUser.value = asUser({subscription_tier: 'pro', pro_active_until: future()});
    expect(hasCloudVaultEntitlement()).toBe(true);
  });

  /**
   * RS-19 — THE boundary. The client caches `subscription_tier` and the server
   * downgrade may not have been pulled yet, so a stale 'pro' whose paid window
   * closed yesterday must read as Lite here. Trusting the cached string is how
   * a lapsed subscriber keeps a paid feature until the next refresh.
   */
  it('a LAPSED Pro window is not entitled, even with a cached pro tier', () => {
    mockUser.value = asUser({subscription_tier: 'pro', pro_active_until: past()});
    expect(hasCloudVaultEntitlement()).toBe(false);
  });

  it('a lapsed Enterprise window is not entitled either', () => {
    mockUser.value = asUser({subscription_tier: 'enterprise', pro_active_until: past()});
    expect(hasCloudVaultEntitlement()).toBe(false);
  });

  it('a comp / permanent grant (no expiry recorded) stays entitled', () => {
    mockUser.value = asUser({subscription_tier: 'pro', pro_active_until: null});
    expect(hasCloudVaultEntitlement()).toBe(true);
  });

  it('an unparseable expiry does not wrongly demote a paying user', () => {
    mockUser.value = asUser({subscription_tier: 'pro', pro_active_until: 'not-a-date'});
    expect(hasCloudVaultEntitlement()).toBe(true);
  });
});

describe('hasCloudVaultEntitlement — org tenancy entitles without a paid tier', () => {
  it('a workspace OWNER on Lite is entitled', () => {
    // Scope v2 Phase 6: an Enterprise workspace owner has account_kind
    // 'individual', so `owns_workspace` is the only clause that catches them.
    mockUser.value = asUser({subscription_tier: 'lite', owns_workspace: true});
    expect(hasCloudVaultEntitlement()).toBe(true);
  });

  it('an active MEMBER of a workspace on Lite is entitled', () => {
    mockUser.value = asUser({
      subscription_tier: 'lite',
      workspaces: [{org_id: 'o1', name: 'Acme', role: 'employee'}],
    });
    expect(hasCloudVaultEntitlement()).toBe(true);
  });

  it('a service provider on Lite is entitled', () => {
    mockUser.value = asUser({subscription_tier: 'lite', role: 'service_provider'});
    expect(hasCloudVaultEntitlement()).toBe(true);
  });

  it('an agency account on Lite is entitled', () => {
    mockUser.value = asUser({subscription_tier: 'lite', account_kind: 'agency'});
    expect(hasCloudVaultEntitlement()).toBe(true);
  });

  it('a CPO with an ACTIVE membership is entitled', () => {
    mockUser.value = asUser({subscription_tier: 'lite', account_kind: 'cpo', membership_status: 'active'});
    expect(hasCloudVaultEntitlement()).toBe(true);
  });

  /**
   * The membership half of the clause is load-bearing: a CPO who has been
   * invited but not activated — or who was suspended — is not org-affiliated,
   * so on Lite they get the upgrade prompt, not the vault.
   */
  it('a CPO whose membership is only PENDING is NOT entitled', () => {
    mockUser.value = asUser({subscription_tier: 'lite', account_kind: 'cpo', membership_status: 'pending'});
    expect(hasCloudVaultEntitlement()).toBe(false);
  });

  it('a SUSPENDED org member is NOT entitled', () => {
    mockUser.value = asUser({subscription_tier: 'lite', account_kind: 'cpo', membership_status: 'suspended'});
    expect(hasCloudVaultEntitlement()).toBe(false);
  });

  it('an empty workspaces array does not entitle', () => {
    mockUser.value = asUser({subscription_tier: 'lite', workspaces: []});
    expect(hasCloudVaultEntitlement()).toBe(false);
  });

  it('org tenancy survives a lapsed paid window — the org path is independent', () => {
    mockUser.value = asUser({subscription_tier: 'pro', pro_active_until: past(), owns_workspace: true});
    expect(hasCloudVaultEntitlement()).toBe(true);
  });
});

describe('hasCloudVaultEntitlement — reads live state', () => {
  /**
   * The lazy `require` in this module exists so `openVault` stays parse-clean in
   * node tests, but it also means the gate must re-read the store on EVERY call.
   * A module-level snapshot would leave a user who just upgraded still locked
   * out until the app restarted.
   */
  it('an upgrade taken mid-session flips the gate without a reload', () => {
    mockUser.value = asUser({subscription_tier: 'lite'});
    expect(hasCloudVaultEntitlement()).toBe(false);

    mockUser.value = asUser({subscription_tier: 'pro'});
    expect(hasCloudVaultEntitlement()).toBe(true);
  });

  it('signing out closes the gate again', () => {
    mockUser.value = asUser({subscription_tier: 'pro'});
    expect(hasCloudVaultEntitlement()).toBe(true);
    mockUser.value = null;
    expect(hasCloudVaultEntitlement()).toBe(false);
  });
});

describe('promptCloudVaultUpgrade — the refusal is a route to the fix', () => {
  it('shows the cloud-vault upgrade copy, naming the tiers that include it', () => {
    promptCloudVaultUpgrade();
    expect(mockAlert).toHaveBeenCalledTimes(1);
    const [title, message] = mockAlert.mock.calls[0] as [string, string];
    expect(title).toMatch(/cloud vault/i);
    expect(message).toMatch(/Pro/);
    expect(message).toMatch(/Enterprise/);
  });

  /**
   * The wiring, not just the button. A "View Plans" action that is present but
   * not connected is the dead-CTA class this repo has already shipped once
   * (openPricing's own docblock, R6-4) — so press it and prove it routes.
   */
  it('its View Plans action actually opens pricing when pressed', () => {
    promptCloudVaultUpgrade();
    const buttons = (mockAlert.mock.calls[0] as unknown[])[2] as Array<{text: string; onPress?: () => void}>;
    const viewPlans = buttons.find(b => /view plans/i.test(b.text));
    expect(viewPlans).toBeDefined();

    expect(mockOpenPricing).not.toHaveBeenCalled();
    viewPlans!.onPress!();
    expect(mockOpenPricing).toHaveBeenCalledTimes(1);
  });

  it('offers a way out that does nothing', () => {
    promptCloudVaultUpgrade();
    const buttons = (mockAlert.mock.calls[0] as unknown[])[2] as Array<{text: string; style?: string}>;
    const notNow = buttons.find(b => /not now/i.test(b.text));
    expect(notNow).toMatchObject({style: 'cancel'});
  });
});
