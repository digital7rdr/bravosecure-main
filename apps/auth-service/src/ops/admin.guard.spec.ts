/**
 * Phase 5.5 — AdminGuard unit tests.
 *
 * Covers:
 *   - rejects requests with no JWT claims attached
 *   - rejects users not in admin_users
 *   - rejects inactive admin rows (active = FALSE)
 *   - rejects when @RequireRoles disallows the admin's role
 *   - accepts when admin role satisfies @RequireRoles
 *   - stamps last_active_at on success
 *   - region-scope helper: ADMIN bypasses, OPS/SUPERVISOR scoped
 */
import {ForbiddenException} from '@nestjs/common';
import type {Reflector} from '@nestjs/core';
import {
  AdminGuard, assertRegionScope, isGlobalAdmin, REQUIRED_ROLES_KEY,
  type AdminContext, type AdminRole,
} from './admin.guard';

function makeCtx(req: Partial<{user: {sub: string}; admin: AdminContext}>) {
  return {
    switchToHttp: () => ({getRequest: () => req}),
    getHandler:   () => ({}),
    getClass:     () => ({}),
  } as never;
}

function makeReflector(requiredRoles?: AdminRole[]): Reflector {
  return {
    getAllAndOverride: jest.fn((key: string) =>
      key === REQUIRED_ROLES_KEY ? requiredRoles : undefined,
    ),
  } as unknown as Reflector;
}

describe('AdminGuard', () => {
  it('rejects when JWT claims are missing', async () => {
    const db = {qOne: jest.fn(), q: jest.fn()} as never;
    const g  = new AdminGuard(db, makeReflector());
    await expect(g.canActivate(makeCtx({}))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects when the user is not in admin_users', async () => {
    const db = {qOne: jest.fn().mockResolvedValue(null), q: jest.fn()} as never;
    const g  = new AdminGuard(db, makeReflector());
    await expect(g.canActivate(makeCtx({user: {sub: 'u-not-admin'}})))
      .rejects.toThrow(/Admin access required/);
  });

  it('rejects when admin_users.active = FALSE (qOne already filters that out, double-check)', async () => {
    // The SQL `WHERE active = TRUE` means an inactive row returns null
    // from qOne — same path as "not in admin_users".
    const db = {qOne: jest.fn().mockResolvedValue(null), q: jest.fn()} as never;
    const g  = new AdminGuard(db, makeReflector());
    await expect(g.canActivate(makeCtx({user: {sub: 'u-deactivated'}})))
      .rejects.toThrow(/Admin access required/);
  });

  it('accepts when admin row exists and no @RequireRoles is set', async () => {
    const row = {user_id: 'u-1', role: 'OPS' as const, call_sign: 'OPS-01', region: 'AE'};
    const db = {
      qOne: jest.fn().mockResolvedValue(row),
      q:    jest.fn().mockResolvedValue([]),
    } as never;
    const g = new AdminGuard(db, makeReflector());
    const req: {user?: {sub: string}; admin?: AdminContext} = {user: {sub: 'u-1'}};
    await expect(g.canActivate(makeCtx(req))).resolves.toBe(true);
    expect(req.admin).toEqual(row);
  });

  it('stamps last_active_at on every successful canActivate', async () => {
    const row = {user_id: 'u-1', role: 'OPS' as const, call_sign: 'OPS-01', region: 'AE'};
    const dbQ    = jest.fn().mockResolvedValue([]);
    const dbQOne = jest.fn().mockResolvedValue(row);
    const db = {qOne: dbQOne, q: dbQ} as never;
    const g  = new AdminGuard(db, makeReflector());
    await g.canActivate(makeCtx({user: {sub: 'u-1'}}));
    expect(dbQ).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE admin_users SET last_active_at'),
      ['u-1'],
    );
  });

  it('rejects when @RequireRoles disallows the admin role', async () => {
    const row = {user_id: 'u-1', role: 'OPS' as const, call_sign: 'OPS-01', region: 'AE'};
    const db = {
      qOne: jest.fn().mockResolvedValue(row),
      q:    jest.fn().mockResolvedValue([]),
    } as never;
    const g = new AdminGuard(db, makeReflector(['ADMIN']));
    await expect(g.canActivate(makeCtx({user: {sub: 'u-1'}})))
      .rejects.toThrow(/Requires one of: ADMIN/);
  });

  it('accepts when @RequireRoles permits the admin role', async () => {
    const row = {user_id: 'u-1', role: 'SUPERVISOR' as const, call_sign: 'SUP-01', region: 'AE'};
    const db = {
      qOne: jest.fn().mockResolvedValue(row),
      q:    jest.fn().mockResolvedValue([]),
    } as never;
    const g = new AdminGuard(db, makeReflector(['SUPERVISOR', 'ADMIN']));
    await expect(g.canActivate(makeCtx({user: {sub: 'u-1'}}))).resolves.toBe(true);
  });
});

describe('isGlobalAdmin / assertRegionScope (Phase 1.5)', () => {
  const ADMIN_AE: AdminContext = {user_id: 'u-1', role: 'ADMIN',      call_sign: 'ADM-01', region: 'AE'};
  const OPS_AE:   AdminContext = {user_id: 'u-2', role: 'OPS',        call_sign: 'OPS-01', region: 'AE'};
  const SUP_AE:   AdminContext = {user_id: 'u-3', role: 'SUPERVISOR', call_sign: 'SUP-01', region: 'AE'};

  it('ADMIN bypasses region check (Q4 default)', () => {
    expect(isGlobalAdmin(ADMIN_AE)).toBe(true);
    expect(() => assertRegionScope(ADMIN_AE, 'SA')).not.toThrow();
    expect(() => assertRegionScope(ADMIN_AE, 'BD')).not.toThrow();
  });

  it('OPS is region-scoped — same region OK, cross-region throws', () => {
    expect(isGlobalAdmin(OPS_AE)).toBe(false);
    expect(() => assertRegionScope(OPS_AE, 'AE')).not.toThrow();
    expect(() => assertRegionScope(OPS_AE, 'SA'))
      .toThrow(/region_scope_violation:AE!=SA/);
  });

  it('SUPERVISOR is region-scoped (same rule as OPS)', () => {
    expect(isGlobalAdmin(SUP_AE)).toBe(false);
    expect(() => assertRegionScope(SUP_AE, 'AE')).not.toThrow();
    expect(() => assertRegionScope(SUP_AE, 'GB'))
      .toThrow(/region_scope_violation:AE!=GB/);
  });

  it('admin with empty region string is treated as unscoped (no throw) — covers seed data', () => {
    const unset: AdminContext = {user_id: 'u-x', role: 'OPS', call_sign: 'OPS-Y', region: ''};
    expect(() => assertRegionScope(unset, 'AE')).not.toThrow();
  });
});
