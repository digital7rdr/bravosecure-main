/**
 * Founder 2026-08-26 — ops-editable package catalog (name + description via
 * plan_catalog; messenger prices stay in subscription_prices, the charge-time
 * source). Pins:
 *   - getCatalog merges live prices onto the copy rows and FAILS OPEN to an
 *     empty catalog (a DB hiccup must never blank a paywall — the apps keep
 *     their shipped copy).
 *   - the ops PATCH updates only the named columns, refuses an empty patch
 *     and an unknown key, and stamps the acting admin.
 */
import {Test, TestingModule} from '@nestjs/testing';
import {BadRequestException} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';
import {WalletService} from '../wallet/wallet.service';
import {StripeClient} from '../wallet/stripe.client';
import {SubscriptionService} from './subscription.service';
import {OpsSubscriptionController} from '../ops/ops-subscription.controller';
import {OpsAuditService} from '../ops/ops-audit.service';

const tx = {q: jest.fn(), qOne: jest.fn()};
const mockDb = {
  q: jest.fn(),
  qOne: jest.fn(),
  withTransaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
};
const mockWallet = {debitForFeature: jest.fn()};
const mockStripe = {
  enabled: false,
  ensureCustomer: jest.fn(),
  createSubscription: jest.fn(),
  cancelSubscription: jest.fn(),
};

describe('plan catalog', () => {
  let svc: SubscriptionService;
  let ops: OpsSubscriptionController;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDb.q.mockResolvedValue([]);
    mockDb.qOne.mockResolvedValue(null);
    const module: TestingModule = await Test.createTestingModule({
      controllers: [OpsSubscriptionController],
      providers: [
        SubscriptionService,
        {provide: DatabaseService, useValue: mockDb},
        {provide: WalletService, useValue: mockWallet},
        {provide: StripeClient, useValue: mockStripe},
        // OC-03 — the controller now writes an audit row per mutation.
        {provide: OpsAuditService, useValue: {recordAdmin: jest.fn().mockResolvedValue(undefined)}},
      ],
    })
      .overrideGuard(require('../common/guards/jwt-auth.guard').JwtAuthGuard)
      .useValue({canActivate: () => true})
      .overrideGuard(require('../common/guards/csrf.guard').CsrfGuard)
      .useValue({canActivate: () => true})
      .overrideGuard(require('../ops/admin.guard').AdminGuard)
      .useValue({canActivate: () => true})
      .compile();
    svc = module.get(SubscriptionService);
    ops = module.get(OpsSubscriptionController);
  });

  describe('SubscriptionService.getCatalog', () => {
    it('merges the LIVE messenger prices onto the copy rows', async () => {
      mockDb.q.mockImplementation(async (sql: string) => {
        if (/FROM plan_catalog/.test(sql)) {
          return [
            {key: 'messenger_pro', display_name: 'Pro', description: 'd'},
            {key: 'secure_pro', display_name: 'Secure Pro', description: 'd2'},
          ];
        }
        if (/FROM subscription_prices/.test(sql)) {
          return [{tier: 'pro', price_bc: 2500}, {tier: 'enterprise', price_bc: 5000}];
        }
        return [];
      });
      const out = await svc.getCatalog();
      const pro = out.catalog.find(c => c.key === 'messenger_pro');
      const securePro = out.catalog.find(c => c.key === 'secure_pro');
      expect(pro?.price_bc).toBe(2500);
      // Non-messenger packages carry NO price — Secure Pro is priced per
      // application, and inventing a number here would render on a card.
      expect(securePro?.price_bc).toBeNull();
    });

    it('FAILS OPEN to an empty catalog when the table is unreachable', async () => {
      mockDb.q.mockRejectedValue(new Error('relation does not exist'));
      await expect(svc.getCatalog()).resolves.toEqual({catalog: []});
    });
  });

  describe('ops PATCH /ops/subscription/catalog', () => {
    const req = {admin: {user_id: 'admin-1'}} as never;

    it('updates only the provided columns and stamps the admin', async () => {
      mockDb.qOne.mockResolvedValueOnce({
        key: 'secure_pro', display_name: 'New Name', description: 'kept',
      });
      const out = await ops.setCatalogEntry(
        {key: 'secure_pro', display_name: 'New Name'} as never, req,
      );
      expect(out.display_name).toBe('New Name');
      const [sql, params] = mockDb.qOne.mock.calls[0];
      expect(String(sql)).toMatch(/COALESCE\(\$2, display_name\)/);
      expect(String(sql)).toMatch(/COALESCE\(\$3, description\)/);
      expect(params).toEqual(['secure_pro', 'New Name', null, 'admin-1']);
    });

    it('refuses an empty patch — nothing_to_update', async () => {
      await expect(ops.setCatalogEntry({key: 'secure_pro'} as never, req))
        .rejects.toThrow(BadRequestException);
      expect(mockDb.qOne).not.toHaveBeenCalled();
    });

    it('an unknown key 400s (the key set is the app\'s, not ops-mintable)', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);
      await expect(
        ops.setCatalogEntry({key: 'secure_pro', description: 'x'} as never, req),
      ).rejects.toThrow('unknown_package');
    });
  });
});
