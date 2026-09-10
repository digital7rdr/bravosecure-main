import {
  BadRequestException, Body, Controller, Get, HttpCode, Patch, Req, UseGuards,
} from '@nestjs/common';
import type {Request} from 'express';
import {IsIn, IsNumber, Min} from 'class-validator';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CsrfGuard} from '../common/guards/csrf.guard';
import {AdminGuard, RequireRoles, type AdminContext} from './admin.guard';
import {DatabaseService} from '../database/database.service';
import {OpsAuditService} from './ops-audit.service';
import {
  DEFAULT_SERVICE_PRICING, type ServicePricingConfig,
} from '../booking/pricing.service';

type OpsReq = Request & {admin: AdminContext};

const KEYS = Object.keys(DEFAULT_SERVICE_PRICING) as Array<keyof ServicePricingConfig>;

/**
 * Per-key sanity bounds — a fat-fingered extra zero on a live rate is a
 * production incident, and a factor above 1 silently turns a discount into a
 * surcharge. The DB CHECK (0 < value < 100000) is the backstop; these are the
 * business bounds.
 */
const BOUNDS: Record<keyof ServicePricingConfig, {min: number; max: number}> = {
  eur_per_bc:                  {min: 0.01, max: 100},
  transfer_base_rate_bc:       {min: 1,    max: 10_000},
  transfer_extra_unit_factor:  {min: 0.01, max: 1},
  transfer_driver_only_factor: {min: 0.05, max: 1},
  peak_multiplier:             {min: 1,    max: 3},
  base_rate_aed:               {min: 1,    max: 50_000},
  exec_cpo_rate_bc:            {min: 1,    max: 10_000},
  exec_vehicle_rate_bc:        {min: 1,    max: 10_000},
  exec_driver_only_rate_bc:    {min: 1,    max: 10_000},
  addon_female_cpo_bc:         {min: 1,    max: 10_000},
  addon_recon_bc:              {min: 1,    max: 10_000},
  addon_medical_bc:            {min: 1,    max: 10_000},
  addon_comms_bc:              {min: 1,    max: 10_000},
};

export class SetServicePriceDto {
  @IsIn(KEYS as string[]) key!: keyof ServicePricingConfig;
  @IsNumber() @Min(0.000001) value!: number;
}

/**
 * Founder 2026-08-26 — SERVICE pricing administration ("secure transfers,
 * executive protection… 1x CPO, vehicle, female, price per hour — everywhere
 * the price applicable", plus the eur_per_bc root). Charged at charge time
 * via PricingService.config() (60 s cache), so an edit prices the next quote;
 * already-created bookings keep their stored totals.
 */
@Controller('ops/service-pricing')
@UseGuards(JwtAuthGuard, CsrfGuard, AdminGuard)
@RequireRoles('SUPERVISOR', 'ADMIN')
export class OpsServicePricingController {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: OpsAuditService,
  ) {}

  @Get()
  async list() {
    const rows = await this.db.q<{key: string; value: string; updated_at: string}>(
      `SELECT key, value, updated_at FROM service_pricing ORDER BY key`,
    );
    const live = new Map(rows.map(r => [r.key, r]));
    // Emit EVERY key, table-backed or defaulted, so the console renders the
    // full board even before the migration ran anywhere.
    return {
      pricing: KEYS.map(k => ({
        key: k,
        value: live.has(k) ? Number(live.get(k)!.value) : DEFAULT_SERVICE_PRICING[k],
        default_value: DEFAULT_SERVICE_PRICING[k],
        updated_at: live.get(k)?.updated_at ?? null,
        min: BOUNDS[k].min,
        max: BOUNDS[k].max,
      })),
    };
  }

  @Patch()
  @HttpCode(200)
  async set(@Body() dto: SetServicePriceDto, @Req() req: OpsReq) {
    const b = BOUNDS[dto.key];
    if (!b || dto.value < b.min || dto.value > b.max) {
      throw new BadRequestException(`value_out_of_bounds:${b?.min}..${b?.max}`);
    }
    // OC-03 — capture the previous value so the audit row carries from→to.
    // eur_per_bc is the platform's fiat↔BC root; a change with no trail is
    // an incident, not a setting.
    const prev = await this.db.qOne<{value: string}>(
      `SELECT value FROM service_pricing WHERE key = $1`, [dto.key],
    );
    const fromValue = prev ? Number(prev.value) : DEFAULT_SERVICE_PRICING[dto.key];
    // Upsert: the board must be editable even on an environment where the
    // seed migration has not run (the read path already defaults).
    const row = await this.db.qOne<{key: string; value: string}>(
      `INSERT INTO service_pricing (key, value, updated_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by
       RETURNING key, value`,
      [dto.key, dto.value, req.admin.user_id],
    );
    await this.audit.recordAdmin(req.admin, 'pricing.service.update', 'system', dto.key, {
      from: fromValue, to: dto.value,
    });
    return {key: row!.key, value: Number(row!.value)};
  }
}
