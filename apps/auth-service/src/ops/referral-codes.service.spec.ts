import {Test, TestingModule} from '@nestjs/testing';
import {BadRequestException, ConflictException, NotFoundException} from '@nestjs/common';
import {ReferralCodesService} from './referral-codes.service';
import {DatabaseService} from '../database/database.service';
import {OpsAuditService} from './ops-audit.service';
import type {AdminContext} from './admin.guard';

const mockDb = {
  q: jest.fn(),
  qOne: jest.fn(),
};
const mockAudit = {recordAdmin: jest.fn()};

const ADMIN: AdminContext = {
  user_id: 'admin-1', role: 'SUPERVISOR', call_sign: 'SUP-01', region: 'AE',
};

describe('ReferralCodesService (Issue 28 write side)', () => {
  let service: ReferralCodesService;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockAudit.recordAdmin.mockResolvedValue(undefined);
    mockDb.q.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReferralCodesService,
        {provide: DatabaseService, useValue: mockDb},
        {provide: OpsAuditService, useValue: mockAudit},
      ],
    }).compile();
    service = module.get(ReferralCodesService);
  });

  describe('create', () => {
    it('stores the code UPPER-CASED so the booking-side lookup matches', async () => {
      mockDb.qOne.mockResolvedValueOnce({
        id: 'rc-1', code: 'TRAVELCO-01', owner_user_id: null,
        partner_name: 'TravelCo', purpose: null, active: true,
        expires_at: null, redeemed_count: 0, created_at: 'x',
      });
      const row = await service.create(ADMIN, {code: 'travelco-01', partner_name: 'TravelCo'});
      const insert = mockDb.qOne.mock.calls.find(c => /INSERT INTO provider_referral_codes/.test(String(c[0])));
      expect((insert?.[1] as unknown[])[0]).toBe('TRAVELCO-01');
      expect(row.status).toBe('active');
      expect(mockAudit.recordAdmin).toHaveBeenCalledWith(
        ADMIN, 'referral.create', 'system', 'rc-1', expect.any(Object),
      );
    });

    it('requires exactly one attribution target: neither is rejected', async () => {
      await expect(service.create(ADMIN, {code: 'X1'}))
        .rejects.toBeInstanceOf(BadRequestException);
      expect(mockDb.qOne).not.toHaveBeenCalled();
    });

    it('requires exactly one attribution target: both is rejected', async () => {
      await expect(service.create(ADMIN, {
        code: 'X1', owner_user_id: 'u-1', partner_name: 'TravelCo',
      })).rejects.toBeInstanceOf(BadRequestException);
      expect(mockDb.qOne).not.toHaveBeenCalled();
    });

    it('a whitespace-only partner_name does not count as an attribution target', async () => {
      await expect(service.create(ADMIN, {code: 'X1', partner_name: '   '}))
        .rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an owner_user_id that is not a live user', async () => {
      mockDb.qOne.mockResolvedValueOnce(null); // users lookup
      await expect(service.create(ADMIN, {code: 'X1', owner_user_id: 'u-404'}))
        .rejects.toThrow('owner_not_found');
    });

    it('rejects an expiry in the past', async () => {
      await expect(service.create(ADMIN, {
        code: 'X1', partner_name: 'TravelCo', expires_at: '2020-01-01T00:00:00Z',
      })).rejects.toThrow('expires_at_in_past');
    });

    it('rejects a calendar-invalid expiry (NaN must not skip the guard)', async () => {
      // "2026-02-30" passes a regex-only ISO check and parses to NaN; the
      // old `<= Date.now()` comparison let NaN through to a DB 500.
      await expect(service.create(ADMIN, {
        code: 'X1', partner_name: 'TravelCo', expires_at: '2026-02-30T00:00:00Z',
      })).rejects.toThrow('expires_at_in_past');
      expect(mockDb.qOne).not.toHaveBeenCalled();
    });

    it('a zero-width-only partner_name does not count as an attribution target', async () => {
      await expect(service.create(ADMIN, {code: 'X1', partner_name: '\u200B\u200E'}))
        .rejects.toThrow('owner_or_partner_required');
    });

    it('maps a unique-violation to code_already_exists', async () => {
      mockDb.qOne.mockRejectedValueOnce(Object.assign(new Error('dup'), {code: '23505'}));
      await expect(service.create(ADMIN, {code: 'X1', partner_name: 'TravelCo'}))
        .rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('setActive', () => {
    it('deactivates and audits as referral.deactivate', async () => {
      mockDb.qOne.mockResolvedValueOnce({id: 'rc-1', code: 'TRAVELCO-01', active: false, expires_at: null});
      const row = await service.setActive(ADMIN, 'rc-1', false);
      expect(row.active).toBe(false);
      expect(mockAudit.recordAdmin).toHaveBeenCalledWith(
        ADMIN, 'referral.deactivate', 'system', 'rc-1', {code: 'TRAVELCO-01', expires_at: null},
      );
    });

    it('reactivates and audits as referral.reactivate', async () => {
      mockDb.qOne.mockResolvedValueOnce({id: 'rc-1', code: 'TRAVELCO-01', active: true, expires_at: null});
      await service.setActive(ADMIN, 'rc-1', true);
      expect(mockAudit.recordAdmin).toHaveBeenCalledWith(
        ADMIN, 'referral.reactivate', 'system', 'rc-1', {code: 'TRAVELCO-01', expires_at: null},
      );
    });

    it('reactivation clears a LAPSED expiry, so the code is actually usable again', async () => {
      // Without this, reactivate flips the flag while the booking lookup
      // (expires_at > NOW()) keeps rejecting — an unrevivable code behind a
      // console promise of "clients can submit it again".
      mockDb.qOne.mockResolvedValueOnce({id: 'rc-1', code: 'TRAVELCO-01', active: true, expires_at: null});
      await service.setActive(ADMIN, 'rc-1', true);
      const sql = String(mockDb.qOne.mock.calls[0][0]);
      expect(sql).toMatch(/CASE\s*WHEN \$2 AND expires_at IS NOT NULL AND expires_at <= NOW\(\) THEN NULL/);
    });

    it('404s on an unknown id', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);
      await expect(service.setActive(ADMIN, 'rc-404', false))
        .rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('list', () => {
    it('derives status: inactive beats expired; expiry beats active', async () => {
      mockDb.q.mockResolvedValueOnce([
        {id: 'a', code: 'A', active: true,  expired: false, redeemed_count: 1, booking_count: 1},
        {id: 'b', code: 'B', active: true,  expired: true,  redeemed_count: 0, booking_count: 0},
        {id: 'c', code: 'C', active: false, expired: true,  redeemed_count: 0, booking_count: 0},
      ]);
      const rows = await service.list();
      expect(rows.map(r => r.status)).toEqual(['active', 'expired', 'inactive']);
      expect(rows[0]).not.toHaveProperty('expired');
    });
  });
});
