import {OpsServicePricingController} from './ops-service-pricing.controller';
import {OpsSubscriptionController} from './ops-subscription.controller';
import {DEFAULT_SERVICE_PRICING} from '../booking/pricing.service';
import type {AdminContext} from './admin.guard';

/**
 * OC-03 (audit 2026-08-26) — the money-root mutations shipped with NO audit
 * rows: /ops/service-pricing (incl. eur_per_bc), subscription prices/catalog,
 * and the user tier editor (which wasn't even actor-attributed). These pins
 * keep every one of them writing a from→to trail.
 */

const ADMIN: AdminContext = {
  user_id: 'admin-1', role: 'SUPERVISOR', call_sign: 'SUP-01', region: 'AE',
};
const req = {admin: ADMIN} as never;

function mocks() {
  return {
    db: {q: jest.fn().mockResolvedValue([]), qOne: jest.fn()},
    audit: {recordAdmin: jest.fn().mockResolvedValue(undefined)},
    subscription: {cancelAutoRenew: jest.fn().mockResolvedValue(undefined)},
  };
}

describe('OC-03 — ops pricing/tier mutations are audited', () => {
  it('service-pricing PATCH records pricing.service.update with from→to', async () => {
    const m = mocks();
    m.db.qOne
      .mockResolvedValueOnce({value: '0.9'})                    // prev
      .mockResolvedValueOnce({key: 'eur_per_bc', value: '1.1'}); // upsert
    const ctrl = new OpsServicePricingController(m.db as never, m.audit as never);
    await ctrl.set({key: 'eur_per_bc', value: 1.1}, req);
    expect(m.audit.recordAdmin).toHaveBeenCalledWith(
      ADMIN, 'pricing.service.update', 'system', 'eur_per_bc', {from: 0.9, to: 1.1},
    );
  });

  it('service-pricing falls back to the compiled default as the from value', async () => {
    const m = mocks();
    m.db.qOne
      .mockResolvedValueOnce(null) // no row yet — un-migrated environment
      .mockResolvedValueOnce({key: 'peak_multiplier', value: '1.5'});
    const ctrl = new OpsServicePricingController(m.db as never, m.audit as never);
    await ctrl.set({key: 'peak_multiplier', value: 1.5}, req);
    expect(m.audit.recordAdmin).toHaveBeenCalledWith(
      ADMIN, 'pricing.service.update', 'system', 'peak_multiplier',
      {from: DEFAULT_SERVICE_PRICING.peak_multiplier, to: 1.5},
    );
  });

  it('subscription price PATCH records subscription.price.update with from→to', async () => {
    const m = mocks();
    m.db.qOne
      .mockResolvedValueOnce({price_bc: 100})            // prev
      .mockResolvedValueOnce({tier: 'pro', price_bc: 120}); // update
    const ctrl = new OpsSubscriptionController(m.db as never, m.subscription as never, m.audit as never);
    await ctrl.setPrice({tier: 'pro', price_bc: 120}, req);
    expect(m.audit.recordAdmin).toHaveBeenCalledWith(
      ADMIN, 'subscription.price.update', 'system', 'pro', {from: 100, to: 120},
    );
  });

  it('catalog PATCH records subscription.catalog.update naming the changed fields', async () => {
    const m = mocks();
    m.db.qOne.mockResolvedValueOnce({key: 'secure_pro', display_name: 'Secure Pro+', description: 'old'});
    const ctrl = new OpsSubscriptionController(m.db as never, m.subscription as never, m.audit as never);
    await ctrl.setCatalogEntry({key: 'secure_pro', display_name: 'Secure Pro+'}, req);
    expect(m.audit.recordAdmin).toHaveBeenCalledWith(
      ADMIN, 'subscription.catalog.update', 'system', 'secure_pro', {display_name: 'Secure Pro+'},
    );
  });

  it('tier PATCH is attributed and records user.tier.change with from→to', async () => {
    const m = mocks();
    m.db.qOne
      .mockResolvedValueOnce({subscription_tier: 'pro', pro_active_until: '2026-09-01T00:00:00Z'}) // prev
      .mockResolvedValueOnce({id: 'u-1', subscription_tier: 'lite', pro_active_until: null});      // update
    const ctrl = new OpsSubscriptionController(m.db as never, m.subscription as never, m.audit as never);
    await ctrl.setUserTier('u-1', {tier: 'lite'}, req);
    expect(m.subscription.cancelAutoRenew).toHaveBeenCalledWith('u-1');
    expect(m.audit.recordAdmin).toHaveBeenCalledWith(
      ADMIN, 'user.tier.change', 'user', 'u-1', {
        from: 'pro', to: 'lite', days: null,
        from_until: '2026-09-01T00:00:00Z', to_until: null,
      },
    );
  });
});

/**
 * AUTHZ-4 — a PERMANENT paid comp (days=null on a non-lite tier = never-expiring free
 * paid tier) is the one unbounded-value money lever, so it requires ADMIN. Timed comps
 * and lite downgrades (also days=null) stay SUPERVISOR.
 */
describe('AUTHZ-4 — permanent paid comp is ADMIN-gated', () => {
  const ADMIN_ROLE: AdminContext = {user_id: 'admin-2', role: 'ADMIN', call_sign: 'ADM-01', region: 'AE'};
  const reqAdmin = {admin: ADMIN_ROLE} as never;

  it('a SUPERVISOR CANNOT grant a permanent paid comp (tier=pro, days=null)', async () => {
    const m = mocks();
    m.db.qOne.mockResolvedValueOnce({subscription_tier: 'lite', pro_active_until: null}); // prev
    const ctrl = new OpsSubscriptionController(m.db as never, m.subscription as never, m.audit as never);
    await expect(ctrl.setUserTier('u-1', {tier: 'pro'}, req)) // req = SUPERVISOR
      .rejects.toMatchObject({message: 'admin_required_for_permanent_comp'});
    // Never reached the tier write.
    expect(m.audit.recordAdmin).not.toHaveBeenCalled();
  });

  it('an ADMIN CAN grant a permanent paid comp', async () => {
    const m = mocks();
    m.db.qOne
      .mockResolvedValueOnce({subscription_tier: 'lite', pro_active_until: null})            // prev
      .mockResolvedValueOnce({id: 'u-1', subscription_tier: 'pro', pro_active_until: null}); // update
    const ctrl = new OpsSubscriptionController(m.db as never, m.subscription as never, m.audit as never);
    await expect(ctrl.setUserTier('u-1', {tier: 'pro'}, reqAdmin)).resolves.toBeDefined();
    expect(m.audit.recordAdmin).toHaveBeenCalledWith(
      ADMIN_ROLE, 'user.tier.change', 'user', 'u-1', expect.objectContaining({to: 'pro', days: null}),
    );
  });

  it('a SUPERVISOR CAN grant a TIMED paid comp (days set)', async () => {
    const m = mocks();
    m.db.qOne
      .mockResolvedValueOnce({subscription_tier: 'lite', pro_active_until: null})
      .mockResolvedValueOnce({id: 'u-1', subscription_tier: 'pro', pro_active_until: '2026-10-01T00:00:00Z'});
    const ctrl = new OpsSubscriptionController(m.db as never, m.subscription as never, m.audit as never);
    await expect(ctrl.setUserTier('u-1', {tier: 'pro', days: 30}, req)).resolves.toBeDefined();
  });

  it('a SUPERVISOR CAN still downgrade to lite (days=null but tier=lite is not gated)', async () => {
    const m = mocks();
    m.db.qOne
      .mockResolvedValueOnce({subscription_tier: 'pro', pro_active_until: '2026-09-01T00:00:00Z'})
      .mockResolvedValueOnce({id: 'u-1', subscription_tier: 'lite', pro_active_until: null});
    const ctrl = new OpsSubscriptionController(m.db as never, m.subscription as never, m.audit as never);
    await expect(ctrl.setUserTier('u-1', {tier: 'lite'}, req)).resolves.toBeDefined();
  });
});
