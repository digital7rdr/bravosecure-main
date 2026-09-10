import {
  BadRequestException, ConflictException, Injectable, NotFoundException,
} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';
import {OpsAuditService} from './ops-audit.service';
import type {AdminContext} from './admin.guard';

export interface ReferralCodeRow {
  id: string;
  code: string;
  owner_user_id: string | null;
  owner_name: string | null;
  partner_name: string | null;
  purpose: string | null;
  active: boolean;
  expires_at: string | null;
  redeemed_count: number;
  booking_count: number;
  created_at: string;
  status: 'active' | 'inactive' | 'expired';
}

export interface CreateReferralCodeInput {
  code: string;
  owner_user_id?: string;
  partner_name?: string;
  purpose?: string;
  expires_at?: string;
}

/**
 * Issue 28 — the WRITE side of provider/referral attribution codes.
 *
 * The read side (booking submit validates a code against
 * `provider_referral_codes`) shipped on 2026-07-25 with no way to create a
 * row, so every non-blank code was rejected. This service is the missing
 * mint/deactivate surface, exposed to the ops console.
 *
 * Same contract as the table: ATTRIBUTION ONLY. Nothing here is read by the
 * dispatch ranker, the offer cascade or escrow, and this service must never
 * grow a method that feeds them (pinned by referralCode.test.ts).
 */
@Injectable()
export class ReferralCodesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: OpsAuditService,
  ) {}

  async list(): Promise<ReferralCodeRow[]> {
    const rows = await this.db.q<Omit<ReferralCodeRow, 'status'> & {expired: boolean}>(
      `SELECT c.id, c.code, c.owner_user_id, u.display_name AS owner_name,
              c.partner_name, c.purpose, c.active, c.expires_at,
              c.redeemed_count, c.created_at,
              (c.expires_at IS NOT NULL AND c.expires_at <= NOW()) AS expired,
              COUNT(b.id)::int AS booking_count
         FROM provider_referral_codes c
         LEFT JOIN public.users u ON u.id = c.owner_user_id
         LEFT JOIN lite_bookings b ON b.referral_code_id = c.id
        GROUP BY c.id, u.display_name
        ORDER BY c.created_at DESC`,
    );
    return rows.map(({expired, ...r}) => ({
      ...r,
      status: !r.active ? 'inactive' : expired ? 'expired' : 'active',
    }));
  }

  async create(admin: AdminContext, dto: CreateReferralCodeInput): Promise<ReferralCodeRow> {
    // Stored upper-case; the booking API upper-cases before lookup so codes
    // are case-insensitive to the client without a functional index.
    const code = dto.code.trim().toUpperCase();
    // Why the strip: zero-width/format chars survive trim(), so a lone zero-width space would
    // otherwise count as a real partner name and mint a blank attribution.
    const partnerName =
      dto.partner_name?.replace(/[\u200B-\u200F\u2060\uFEFF]/g, '').trim() || null;

    // The DB CHECK only requires at least one owner; the API requires exactly
    // one so every code has a single unambiguous attribution target.
    if (!!dto.owner_user_id === !!partnerName) {
      throw new BadRequestException('owner_or_partner_required');
    }

    if (dto.owner_user_id) {
      const owner = await this.db.qOne<{id: string}>(
        `SELECT id FROM public.users WHERE id = $1 AND deleted_at IS NULL`,
        [dto.owner_user_id],
      );
      if (!owner) throw new BadRequestException('owner_not_found');
    }

    if (dto.expires_at) {
      const t = new Date(dto.expires_at).getTime();
      // NaN (calendar-invalid despite the DTO) and past dates both refuse:
      // either would mint a code the booking lookup can never accept.
      if (!(t > Date.now())) throw new BadRequestException('expires_at_in_past');
    }

    let row: (Omit<ReferralCodeRow, 'status' | 'owner_name' | 'booking_count'>) | null;
    try {
      row = await this.db.qOne(
        `INSERT INTO provider_referral_codes
           (code, owner_user_id, partner_name, purpose, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, code, owner_user_id, partner_name, purpose, active,
                   expires_at, redeemed_count, created_at`,
        [code, dto.owner_user_id ?? null, partnerName,
         dto.purpose?.trim() || null, dto.expires_at ?? null],
      );
    } catch (e) {
      if ((e as {code?: string}).code === '23505') {
        throw new ConflictException('code_already_exists');
      }
      throw e;
    }
    if (!row) throw new BadRequestException('referral_code_create_failed');

    await this.audit.recordAdmin(admin, 'referral.create', 'system', row.id, {
      code, owner_user_id: row.owner_user_id, partner_name: row.partner_name,
      expires_at: row.expires_at,
    });
    return {...row, owner_name: null, booking_count: 0, status: 'active'};
  }

  async setActive(
    admin: AdminContext, id: string, active: boolean,
  ): Promise<{id: string; code: string; active: boolean; expires_at: string | null}> {
    // Why the CASE: reactivating an already-expired code would otherwise flip
    // the flag while the booking lookup keeps rejecting it (expires_at > NOW())
    // — with no expiry-edit endpoint, that code would be unrevivable and the
    // console's "clients can submit it again" promise a lie. Reactivation
    // therefore clears a lapsed expiry; the console confirm says so.
    const row = await this.db.qOne<{id: string; code: string; active: boolean; expires_at: string | null}>(
      `UPDATE provider_referral_codes
          SET active = $2,
              expires_at = CASE
                WHEN $2 AND expires_at IS NOT NULL AND expires_at <= NOW() THEN NULL
                ELSE expires_at
              END
        WHERE id = $1
        RETURNING id, code, active, expires_at`,
      [id, active],
    );
    if (!row) throw new NotFoundException('referral_code_not_found');
    await this.audit.recordAdmin(
      admin, active ? 'referral.reactivate' : 'referral.deactivate',
      'system', row.id, {code: row.code, expires_at: row.expires_at},
    );
    return row;
  }
}
