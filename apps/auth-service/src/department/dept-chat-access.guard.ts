import {CanActivate, ExecutionContext, ForbiddenException, Injectable} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';
import {effectiveTierOf} from '../common/guards/tier.guard';
import type {AccessClaims} from '../auth/jwt.service';

/**
 * DeptChatAccessGuard — entitles the department-chat workspace by **service-
 * provider org membership**, replacing the old `@RequireTier('pro')` gate.
 *
 * The department workspace is an ORG feature, not an individual-Pro perk: a
 * service-provider runs it for their CPOs/staff, none of whom are individually
 * Pro (managed CPOs are created `subscription_tier='lite'`, and a Lite service-
 * provider is also non-Pro). The Pro gate locked every org member out of their
 * own seeded channels — this guard fixes that.
 *
 * Access is granted to:
 *   - the service-provider company account (`agents.type='company'`), or
 *   - an active `org_members` row (CPO or manager).
 *
 * Modeled on OrgManagerGuard: it RE-READS the DB rather than trusting a JWT
 * claim, so the token shape is untouched (auth stop-condition). This is
 * STRICTER than the old Lite-blocking gate (you must belong to an org), so the
 * BE-6.3 audit gap stays closed — a non-org caller is rejected, and has no
 * `department_channels` rows anyway.
 *
 * Apply AFTER JwtAuthGuard so `req.user` is populated.
 */
@Injectable()
export class DeptChatAccessGuard implements CanActivate {
  constructor(private readonly db: DatabaseService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{user?: AccessClaims}>();
    const claims = req.user;
    if (!claims) throw new ForbiddenException('not_authenticated');

    // Path 1: the caller is itself an ACTIVE service-provider company account.
    // D4-c — a suspended/deactivated company (status <> 'ACTIVE') must lose dept-chat access,
    // so the status check is part of the entitlement, not just the type.
    const company = await this.db.qOne<{user_id: string}>(
      `SELECT user_id FROM agents WHERE user_id = $1 AND type = 'company' AND status = 'ACTIVE'`,
      [claims.sub],
    );
    if (company) return true;

    // Path 2: the caller is an active member (CPO or manager) of some org.
    const member = await this.db.qOne<{org_user_id: string}>(
      `SELECT org_user_id FROM org_members
        WHERE member_user_id = $1 AND status = 'active'`,
      [claims.sub],
    );
    if (member) return true;

    // Path 3 (M1A) — an ACTIVE Enterprise-tier individual: Department
    // Channels + attendance + incident reporting are part of the paid
    // Enterprise feature set (founder: "inherit today's 3 features"); their
    // org is the single-tenant org_id = their own user id. Lapse-aware.
    const tierRow = await this.db.qOne<{subscription_tier: string; pro_active_until: Date | null}>(
      `SELECT subscription_tier, pro_active_until FROM public.users
        WHERE id = $1 AND deleted_at IS NULL`,
      [claims.sub],
    );
    if (effectiveTierOf(tierRow) === 'enterprise') return true;

    throw new ForbiddenException('dept_chat_org_membership_required');
  }
}
