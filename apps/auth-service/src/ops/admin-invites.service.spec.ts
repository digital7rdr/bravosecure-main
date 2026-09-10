import {Test, TestingModule} from '@nestjs/testing';
import {BadRequestException, ConflictException, NotFoundException} from '@nestjs/common';
import {createHash} from 'crypto';
import {AdminInvitesService} from './admin-invites.service';
import {DatabaseService} from '../database/database.service';
import {PasswordService} from '../common/services/password.service';
import {AuthService} from '../auth/auth.service';
import {OpsAuditService} from './ops-audit.service';
import type {AdminContext} from './admin.guard';

const mockDb = {
  q: jest.fn(),
  qOne: jest.fn(),
  withTransaction: jest.fn(),
};
const mockPw = {hash: jest.fn(), verify: jest.fn()};
const mockAuth = {revokeAllUserSessions: jest.fn()};
const mockAudit = {recordAdmin: jest.fn()};

const ADMIN: AdminContext = {
  user_id: 'admin-1', role: 'ADMIN', call_sign: 'ADM-01', region: 'AE',
};

describe('AdminInvitesService (RS-09)', () => {
  let service: AdminInvitesService;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockPw.hash.mockResolvedValue('$argon2id$mock');
    mockAudit.recordAdmin.mockResolvedValue(undefined);
    mockAuth.revokeAllUserSessions.mockResolvedValue(0);
    mockDb.q.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminInvitesService,
        {provide: DatabaseService, useValue: mockDb},
        {provide: PasswordService, useValue: mockPw},
        {provide: AuthService, useValue: mockAuth},
        {provide: OpsAuditService, useValue: mockAudit},
      ],
    }).compile();
    service = module.get(AdminInvitesService);
  });

  describe('createInvite', () => {
    const dto = {email: 'New.Admin@Bravo.test', display_name: 'New Admin', call_sign: 'OPS-09'};

    it('rejects when a user with that email already exists', async () => {
      mockDb.qOne.mockResolvedValueOnce({id: 'u-1'}); // users dup check
      await expect(service.createInvite(ADMIN, dto)).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects a call sign already held by any admin account', async () => {
      mockDb.qOne
        .mockResolvedValueOnce(null)               // users dup check
        .mockResolvedValueOnce({user_id: 'u-2'});  // call_sign taken
      await expect(service.createInvite(ADMIN, dto)).rejects.toThrow('call_sign_taken');
    });

    it('stores only a sha256 hash and returns the raw token exactly once, defaulting role to OPS', async () => {
      mockDb.qOne
        .mockResolvedValueOnce(null)  // users dup
        .mockResolvedValueOnce(null)  // call_sign
        .mockResolvedValueOnce({      // INSERT ... RETURNING
          id: 'inv-1', email: 'new.admin@bravo.test', display_name: 'New Admin',
          call_sign: 'OPS-09', role: 'OPS', region: 'AE', invited_by: 'admin-1',
          expires_at: 'x', redeemed_at: null, revoked_at: null, created_at: 'x',
        });

      const {invite, token} = await service.createInvite(ADMIN, dto);
      expect(invite.role).toBe('OPS');
      expect(token).toHaveLength(43); // 32 bytes base64url

      const insert = mockDb.qOne.mock.calls.find(c => /INSERT INTO public\.admin_invites/i.test(String(c[0])));
      const params = insert?.[1] as unknown[];
      // Email lowercased; token never stored raw — param 6 is its sha256 hex.
      expect(params[0]).toBe('new.admin@bravo.test');
      expect(params[5]).toBe(createHash('sha256').update(token, 'utf8').digest('hex'));
      expect(params).not.toContain(token);

      expect(mockAudit.recordAdmin).toHaveBeenCalledWith(
        ADMIN, 'admin.invite.create', 'user', 'inv-1', expect.objectContaining({role: 'OPS'}),
      );
    });

    it('maps a 23505 on the pending-email unique index to invite_already_pending', async () => {
      mockDb.qOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce({code: '23505'});
      await expect(service.createInvite(ADMIN, dto)).rejects.toThrow('invite_already_pending');
    });
  });

  describe('redeemInvite', () => {
    const dto = {token: 'a'.repeat(43), phone_e164: '+15555550100', password: 'hunter2hunter2'};

    it('rejects an invalid / expired / already-used token', async () => {
      const txQOne = jest.fn().mockResolvedValueOnce(null); // claim UPDATE matches nothing
      mockDb.withTransaction.mockImplementation(async (fn: any) => fn({q: jest.fn(), qOne: txQOne}));
      await expect(service.redeemInvite(dto)).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.redeemInvite(dto)).rejects.toThrow('invite_invalid_or_expired');
    });

    it('claims the invite atomically and creates users + admin_users with the BAKED-IN role', async () => {
      const invite = {
        id: 'inv-1', email: 'new.admin@bravo.test', display_name: 'New Admin',
        call_sign: 'SUP-09', role: 'SUPERVISOR', region: 'AE', invited_by: 'admin-1',
      };
      const txQ = jest.fn().mockResolvedValue([]);
      const txQOne = jest.fn()
        .mockResolvedValueOnce(invite)        // claim UPDATE returns the invite
        .mockResolvedValueOnce({id: 'u-new'}); // users INSERT
      mockDb.withTransaction.mockImplementation(async (fn: any) => fn({q: txQ, qOne: txQOne}));

      const out = await service.redeemInvite(dto);
      expect(out).toEqual({ok: true, call_sign: 'SUP-09', role: 'SUPERVISOR'});

      // Claim is the single-use gate: WHERE redeemed_at IS NULL … expires_at > NOW().
      const claim = String(txQOne.mock.calls[0][0]);
      expect(claim).toMatch(/SET redeemed_at = NOW\(\)/);
      expect(claim).toMatch(/redeemed_at IS NULL/);
      expect(claim).toMatch(/expires_at > NOW\(\)/);

      // users row: platform role stays 'individual' (RS-12 taxonomy), password hashed.
      const userInsert = String(txQOne.mock.calls[1][0]);
      expect(userInsert).toMatch(/'individual'/);
      expect(txQOne.mock.calls[1][1]).toContain('$argon2id$mock');
      expect(txQOne.mock.calls[1][1]).not.toContain('hunter2hunter2');

      // admin_users takes role/call_sign/region from the INVITE, phone from the redeemer.
      const adminInsert = txQ.mock.calls.find(c => /INSERT INTO admin_users/i.test(String(c[0])));
      expect(adminInsert?.[1]).toEqual(['u-new', 'New Admin', 'SUP-09', 'SUPERVISOR', 'AE', '+15555550100']);

      // Audit row commits inside the same tx.
      const audit = txQ.mock.calls.find(c => /admin\.invite\.redeem/.test(String(c[0])));
      expect(audit).toBeDefined();
    });

    it('maps a unique-violation race (phone/email already registered) to 409 so the invite stays retryable', async () => {
      const txQOne = jest.fn().mockResolvedValueOnce({
        id: 'inv-1', email: 'e@x.y', display_name: 'N', call_sign: 'OPS-09',
        role: 'OPS', region: 'AE', invited_by: 'admin-1',
      });
      mockDb.withTransaction.mockImplementation(async (fn: any) => {
        await fn({q: jest.fn(), qOne: txQOne.mockRejectedValueOnce({code: '23505'})});
      });
      mockDb.withTransaction.mockRejectedValueOnce({code: '23505'});
      await expect(service.redeemInvite(dto)).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('revokeInvite', () => {
    it('revokes only a pending invite', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);
      await expect(service.revokeInvite(ADMIN, 'inv-9')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('audits the revoke', async () => {
      mockDb.qOne.mockResolvedValueOnce({id: 'inv-1'});
      await service.revokeInvite(ADMIN, 'inv-1');
      expect(mockAudit.recordAdmin).toHaveBeenCalledWith(ADMIN, 'admin.invite.revoke', 'user', 'inv-1', {});
    });
  });

  describe('setAdminRole', () => {
    it('404s an unknown admin', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);
      await expect(service.setAdminRole(ADMIN, 'u-x', 'OPS')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('is idempotent on same role (no update, no audit, no revoke)', async () => {
      mockDb.qOne.mockResolvedValueOnce({role: 'OPS', active: true});
      const out = await service.setAdminRole(ADMIN, 'u-1', 'OPS');
      expect(out).toEqual({role: 'OPS'});
      expect(mockDb.q).not.toHaveBeenCalled();
      expect(mockAudit.recordAdmin).not.toHaveBeenCalled();
      expect(mockAuth.revokeAllUserSessions).not.toHaveBeenCalled();
    });

    it('refuses to demote the last active ADMIN', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({role: 'ADMIN', active: true}) // target
        .mockResolvedValueOnce({n: '0'});                     // no other ADMIN
      await expect(service.setAdminRole(ADMIN, 'admin-1', 'SUPERVISOR'))
        .rejects.toThrow('cannot_demote_last_admin');
      expect(mockDb.q).not.toHaveBeenCalled();
    });

    it('changes the role, audits from→to, and revokes the target sessions', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({role: 'ADMIN', active: true})
        .mockResolvedValueOnce({n: '1'}); // another ADMIN exists
      const out = await service.setAdminRole(ADMIN, 'u-2', 'SUPERVISOR');
      expect(out).toEqual({role: 'SUPERVISOR'});

      const update = mockDb.q.mock.calls.find(c => /UPDATE admin_users SET role/i.test(String(c[0])));
      expect(update?.[1]).toEqual(['u-2', 'SUPERVISOR']);
      expect(mockAudit.recordAdmin).toHaveBeenCalledWith(
        ADMIN, 'admin.role.change', 'user', 'u-2', {from: 'ADMIN', to: 'SUPERVISOR'},
      );
      expect(mockAuth.revokeAllUserSessions).toHaveBeenCalledWith('u-2');
    });

    it('promotion (OPS→ADMIN) needs no last-admin count', async () => {
      mockDb.qOne.mockResolvedValueOnce({role: 'OPS', active: true});
      const out = await service.setAdminRole(ADMIN, 'u-3', 'ADMIN');
      expect(out).toEqual({role: 'ADMIN'});
      expect(mockDb.qOne).toHaveBeenCalledTimes(1); // no count query
    });

    it('a session-revoke failure does not fail the role change', async () => {
      mockDb.qOne.mockResolvedValueOnce({role: 'OPS', active: true});
      mockAuth.revokeAllUserSessions.mockRejectedValueOnce(new Error('redis down'));
      await expect(service.setAdminRole(ADMIN, 'u-4', 'SUPERVISOR')).resolves.toEqual({role: 'SUPERVISOR'});
    });
  });

  // OC-09 — admin offboarding: the only lever that sets admin_users.active.
  describe('setAdminActive', () => {
    it('refuses self-deactivation', async () => {
      await expect(service.setAdminActive(ADMIN, 'admin-1', false))
        .rejects.toBeInstanceOf(BadRequestException);
    });

    it('404s an unknown admin', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);
      await expect(service.setAdminActive(ADMIN, 'u-9', false))
        .rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses to deactivate the last active ADMIN', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({role: 'ADMIN', active: true}) // target
        .mockResolvedValueOnce({n: '0'});                     // other active admins
      await expect(service.setAdminActive(ADMIN, 'u-2', false))
        .rejects.toThrow('cannot_deactivate_last_admin');
      expect(mockDb.q).not.toHaveBeenCalledWith(expect.stringMatching(/UPDATE admin_users SET active/), expect.anything());
    });

    it('deactivates: flips active, writes admin.deactivate, revokes all sessions', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({role: 'SUPERVISOR', active: true}); // target (non-ADMIN: no last-admin count)
      await expect(service.setAdminActive(ADMIN, 'u-3', false)).resolves.toEqual({active: false});
      expect(mockDb.q).toHaveBeenCalledWith(
        expect.stringMatching(/UPDATE admin_users SET active = \$2/), ['u-3', false],
      );
      expect(mockAudit.recordAdmin).toHaveBeenCalledWith(
        ADMIN, 'admin.deactivate', 'user', 'u-3', {role: 'SUPERVISOR'},
      );
      expect(mockAuth.revokeAllUserSessions).toHaveBeenCalledWith('u-3');
    });

    it('reactivates: writes admin.reactivate and does NOT revoke sessions', async () => {
      mockDb.qOne.mockResolvedValueOnce({role: 'OPS', active: false});
      await expect(service.setAdminActive(ADMIN, 'u-4', true)).resolves.toEqual({active: true});
      expect(mockAudit.recordAdmin).toHaveBeenCalledWith(
        ADMIN, 'admin.reactivate', 'user', 'u-4', {role: 'OPS'},
      );
      expect(mockAuth.revokeAllUserSessions).not.toHaveBeenCalled();
    });

    it('is a no-op when already in the requested state', async () => {
      mockDb.qOne.mockResolvedValueOnce({role: 'OPS', active: true});
      await expect(service.setAdminActive(ADMIN, 'u-5', true)).resolves.toEqual({active: true});
      expect(mockDb.q).not.toHaveBeenCalled();
      expect(mockAudit.recordAdmin).not.toHaveBeenCalled();
    });
  });

  describe('listInvites', () => {
    it('derives status pending/redeemed/revoked/expired', async () => {
      mockDb.q.mockResolvedValueOnce([
        {id: 'a', redeemed_at: 'x', revoked_at: null, expired: false},
        {id: 'b', redeemed_at: null, revoked_at: 'x', expired: false},
        {id: 'c', redeemed_at: null, revoked_at: null, expired: true},
        {id: 'd', redeemed_at: null, revoked_at: null, expired: false},
      ]);
      const out = await service.listInvites();
      expect(out.map(i => i.status)).toEqual(['redeemed', 'revoked', 'expired', 'pending']);
      expect((out[0] as unknown as Record<string, unknown>).expired).toBeUndefined();
    });
  });
});
