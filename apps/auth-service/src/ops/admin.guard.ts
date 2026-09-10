import {
  CanActivate, ExecutionContext, ForbiddenException, Injectable,
  SetMetadata,
} from '@nestjs/common';
import {Reflector} from '@nestjs/core';
import {DatabaseService} from '../database/database.service';
import type {AccessClaims} from '../auth/jwt.service';

export type AdminRole = 'OPS' | 'SUPERVISOR' | 'ADMIN';

export const REQUIRED_ROLES_KEY = 'ops_required_roles';

/**
 * Decorator to restrict a handler to specific admin roles.
 * Example: `@RequireRoles('SUPERVISOR', 'ADMIN')`.
 */
export const RequireRoles = (...roles: AdminRole[]) =>
  SetMetadata(REQUIRED_ROLES_KEY, roles);

export interface AdminContext {
  user_id: string;
  role: AdminRole;
  call_sign: string;
  region: string;
}

/**
 * Audit fix 1.5 — region/tenant scoping helper.
 *
 * Bravo runs ops admins per-region (e.g. AE, SA, BD). A Saudi admin
 * approving a UAE booking is a tenant-isolation violation. We enforce
 * `admin.region === record.region` at the service layer for any flow
 * that touches a region-bound record (bookings, missions).
 *
 * Q4 default — `ADMIN` is treated as global (bypasses the region check)
 * because the founders + on-call leads are ADMIN-tier and need the
 * ability to step into any region. `OPS` and `SUPERVISOR` stay scoped.
 * If Q4 ever lands as "no global admins", flip the body to always
 * return false.
 */
export function isGlobalAdmin(admin: {role: AdminRole}): boolean {
  return admin.role === 'ADMIN';
}

/**
 * Throws ForbiddenException if the admin can't operate on a record
 * from the given region. Use at the service layer right after the
 * booking/mission row is read.
 */
export function assertRegionScope(admin: AdminContext, recordRegion: string): void {
  if (isGlobalAdmin(admin)) return;
  if (admin.region && admin.region !== recordRegion) {
    throw new ForbiddenException(`region_scope_violation:${admin.region}!=${recordRegion}`);
  }
}

/**
 * AdminGuard — verifies that the JWT subject is a row in `admin_users`
 * (active = TRUE) and optionally that their role satisfies any
 * `@RequireRoles(…)` metadata on the handler. Attaches the admin record
 * to `req.admin` for controllers to use.
 *
 * Apply AFTER JwtAuthGuard so `req.user` is already populated.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly db: DatabaseService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{
      user?: AccessClaims;
      admin?: AdminContext;
    }>();

    const claims = req.user;
    if (!claims) throw new ForbiddenException('Not authenticated');

    const row = await this.db.qOne<{
      user_id: string; role: AdminRole; call_sign: string; region: string;
    }>(
      `SELECT user_id, role, call_sign, region
         FROM admin_users
        WHERE user_id = $1 AND active = TRUE`,
      [claims.sub],
    );
    if (!row) throw new ForbiddenException('Admin access required');

    // Stamp last_active so the console can show who's online.
    await this.db.q(
      `UPDATE admin_users SET last_active_at = NOW() WHERE user_id = $1`,
      [claims.sub],
    );

    req.admin = row;

    const required = this.reflector.getAllAndOverride<AdminRole[] | undefined>(
      REQUIRED_ROLES_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (required && required.length > 0 && !required.includes(row.role)) {
      throw new ForbiddenException(
        `Requires one of: ${required.join(', ')}. You are ${row.role}.`,
      );
    }

    return true;
  }
}
