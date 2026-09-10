import {
  BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Param, ParseUUIDPipe,
  Patch, Req, UseGuards,
} from '@nestjs/common';
import type {Request} from 'express';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CsrfGuard} from '../common/guards/csrf.guard';
import {AdminGuard, RequireRoles, type AdminContext} from './admin.guard';
import {DatabaseService} from '../database/database.service';
import {OpsAuditService} from './ops-audit.service';
import {SubscriptionService} from '../subscription/subscription.service';
import {IsBoolean, IsIn, IsInt, IsOptional, IsString, Length, Max, MaxLength, Min} from 'class-validator';

type OpsReq = Request & {admin: AdminContext};

export class SetTierPriceDto {
  @IsIn(['pro', 'enterprise']) tier!: 'pro' | 'enterprise';
  // Why the cap: a fat-fingered extra zero on a live price is a production
  // incident; 1,000,000 BC is far above any plausible SKU.
  @IsInt() @Min(1) @Max(1_000_000) price_bc!: number;
}

export const PLAN_CATALOG_KEYS = [
  'messenger_lite', 'messenger_pro', 'messenger_enterprise',
  'secure_pro', 'secure_lux',
] as const;
export type PlanCatalogKey = (typeof PLAN_CATALOG_KEYS)[number];

export class SetCatalogEntryDto {
  @IsIn(PLAN_CATALOG_KEYS as unknown as string[]) key!: PlanCatalogKey;
  // Same bounds the table CHECKs enforce — the 400 beats a raw 23514.
  @IsOptional() @IsString() @Length(1, 60) display_name?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
}

export class SetUserTierDto {
  @IsIn(['lite', 'pro', 'enterprise']) tier!: 'lite' | 'pro' | 'enterprise';
  /** Grant days from now; omit/null = permanent comp grant (RS-17). Ignored for 'lite'. */
  @IsOptional() @IsInt() @Min(1) @Max(3650) days?: number | null;
  @IsOptional() @IsBoolean() clear_auto_renew?: boolean;
}

/**
 * M1A/S9 — ops console pricing + tier administration.
 *
 * Prices are charged AT CHARGE TIME (subscribe + every renewal), so a price
 * change here applies to all future charges — "from next month" for every
 * renewing subscriber — while already-paid periods finish at what they paid.
 *
 * The tier editor backs comp grants and support fixes. It writes exactly the
 * columns the sweeps/guards already honour (RS-17 NULL = permanent grant;
 * RS-19 lapse). ADMIN/SUPERVISOR only.
 */
@Controller('ops/subscription')
@UseGuards(JwtAuthGuard, CsrfGuard, AdminGuard)
@RequireRoles('SUPERVISOR', 'ADMIN')
export class OpsSubscriptionController {
  constructor(
    private readonly db: DatabaseService,
    private readonly subscription: SubscriptionService,
    private readonly audit: OpsAuditService,
  ) {}

  @Get('prices')
  async prices() {
    const rows = await this.db.q<{tier: string; price_bc: number; updated_at: string}>(
      `SELECT tier, price_bc, updated_at FROM subscription_prices ORDER BY tier`,
    );
    return {prices: rows};
  }

  @Patch('prices')
  @HttpCode(200)
  async setPrice(@Body() dto: SetTierPriceDto, @Req() req: OpsReq) {
    // OC-03 — read the outgoing price first so the audit row carries from→to.
    const prev = await this.db.qOne<{price_bc: number}>(
      `SELECT price_bc FROM subscription_prices WHERE tier = $1`, [dto.tier],
    );
    const row = await this.db.qOne<{tier: string; price_bc: number}>(
      `UPDATE subscription_prices
          SET price_bc = $2, updated_at = NOW(), updated_by = $3
        WHERE tier = $1
        RETURNING tier, price_bc`,
      [dto.tier, dto.price_bc, req.admin.user_id],
    );
    if (!row) throw new BadRequestException('unknown_tier');
    await this.audit.recordAdmin(req.admin, 'subscription.price.update', 'system', dto.tier, {
      from: prev ? Number(prev.price_bc) : null, to: dto.price_bc,
    });
    return row;
  }

  /**
   * Founder 2026-08-26 — every package card's NAME and DESCRIPTION are
   * ops-editable too. Copy lives in plan_catalog; the messenger PRICES stay
   * in subscription_prices above (the charge-time source — one number, never
   * a display fork).
   */
  @Get('catalog')
  async catalog() {
    const rows = await this.db.q<{
      key: string; display_name: string; description: string; updated_at: string;
    }>(
      `SELECT key, display_name, description, updated_at
         FROM plan_catalog ORDER BY key`,
    );
    return {catalog: rows};
  }

  @Patch('catalog')
  @HttpCode(200)
  async setCatalogEntry(@Body() dto: SetCatalogEntryDto, @Req() req: OpsReq) {
    if (dto.display_name === undefined && dto.description === undefined) {
      throw new BadRequestException('nothing_to_update');
    }
    // COALESCE keeps the untouched column; the key row must already exist —
    // the key set is the app's, not ops-mintable.
    const row = await this.db.qOne<{key: string; display_name: string; description: string}>(
      `UPDATE plan_catalog
          SET display_name = COALESCE($2, display_name),
              description  = COALESCE($3, description),
              updated_at   = NOW(),
              updated_by   = $4
        WHERE key = $1
        RETURNING key, display_name, description`,
      [dto.key, dto.display_name ?? null, dto.description ?? null, req.admin.user_id],
    );
    if (!row) throw new BadRequestException('unknown_package');
    // OC-03 — customer-facing copy change; log which fields changed and the
    // resulting values (the previous copy is recoverable from earlier rows).
    await this.audit.recordAdmin(req.admin, 'subscription.catalog.update', 'system', dto.key, {
      ...(dto.display_name !== undefined ? {display_name: row.display_name} : {}),
      ...(dto.description !== undefined ? {description: row.description} : {}),
    });
    return row;
  }

  @Patch('users/:userId/tier')
  @HttpCode(200)
  async setUserTier(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: SetUserTierDto,
    @Req() req: OpsReq,
  ) {
    // OC-03 — a comp grant / demotion must be attributable: capture the
    // outgoing tier for the audit row's from→to.
    const prev = await this.db.qOne<{subscription_tier: string; pro_active_until: string | null}>(
      `SELECT subscription_tier, pro_active_until FROM public.users
        WHERE id = $1 AND deleted_at IS NULL`,
      [userId],
    );
    if (!prev) throw new BadRequestException('user_not_found');
    // AUTHZ-4 — a PERMANENT paid comp (days=null on a non-lite tier → pro_active_until
    // NULL = never expires) is the one money lever with UNBOUNDED economic value, so
    // gate it to ADMIN. Timed comps stay SUPERVISOR; a lite DOWNGRADE also carries
    // days=null and must NOT be gated (it costs nothing). NOTE for ops: a SUPERVISOR
    // can still grant days=3650 (~10y) via the timed path — lower SetUserTierDto @Max
    // if you want that closed too.
    if (dto.tier !== 'lite' && (dto.days === null || dto.days === undefined)
        && req.admin.role !== 'ADMIN') {
      throw new ForbiddenException('admin_required_for_permanent_comp');
    }
    // A downgrade to lite must also stop a live card renewal — otherwise the
    // next invoice.paid quietly re-upgrades the account ops just demoted.
    if (dto.tier === 'lite') {
      await this.subscription.cancelAutoRenew(userId);
    }
    const row = await this.db.qOne<{id: string; subscription_tier: string; pro_active_until: string | null}>(
      `UPDATE public.users
          SET subscription_tier = $2,
              pro_active_until  = CASE
                WHEN $2 = 'lite' THEN NULL
                WHEN $3::int IS NULL THEN NULL
                ELSE NOW() + ($3::int || ' days')::interval
              END,
              bc_auto_renew = CASE WHEN $4::boolean OR $2 = 'lite' THEN FALSE ELSE bc_auto_renew END
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING id, subscription_tier, pro_active_until`,
      [userId, dto.tier, dto.days ?? null, dto.clear_auto_renew === true],
    );
    if (!row) throw new BadRequestException('user_not_found');
    await this.audit.recordAdmin(req.admin, 'user.tier.change', 'user', userId, {
      from: prev.subscription_tier, to: dto.tier,
      days: dto.days ?? null,
      from_until: prev.pro_active_until, to_until: row.pro_active_until,
    });
    return row;
  }
}
