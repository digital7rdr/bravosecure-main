import {Injectable, NotFoundException} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';
import type {AdminContext} from './admin.guard';
import {assertRegionScope, isGlobalAdmin} from './admin.guard';

/**
 * Read-only ops data surfaces added by the 2026-07-07 webapp data-coverage
 * audit (DC-01/02/06/07/08/10/15/16/20): finance ledger, disputes, SOS log,
 * VBG oversight, global audit browser, analytics rollups, telemetry replay,
 * broadcast log, and the user directory. Mutations stay in OpsService /
 * dedicated services — the only write here is the session-device revoke.
 */
@Injectable()
export class OpsDataService {
  constructor(private readonly db: DatabaseService) {}

  private effectiveRegion(admin: AdminContext, requested?: string): string | null {
    return !isGlobalAdmin(admin) ? admin.region : (requested ?? null);
  }

  private clampLimit(limit: number | undefined, def: number, max = 500): number {
    const n = Number(limit) || def;
    return Math.min(Math.max(n, 1), max);
  }

  // ─── Disputes (DC-02) ─────────────────────────────────────────────

  listDisputes(admin: AdminContext, status?: string, limit?: number) {
    return this.db.q(
      `SELECT d.id, d.booking_id, d.category, d.reason, d.status,
              d.to_client_credits, d.to_provider_credits,
              d.raised_by, ru.display_name AS raised_by_name,
              d.decided_by, d.created_at, d.decided_at,
              b.region_code, b.region_label, b.service, b.total_eur,
              b.status AS booking_status,
              e.status AS escrow_status, e.gross_credits, e.review_required
         FROM booking_disputes d
         JOIN lite_bookings b ON b.id = d.booking_id
         LEFT JOIN users ru ON ru.id = d.raised_by
         LEFT JOIN escrow_holds e ON e.booking_id = d.booking_id
        WHERE ($1::text IS NULL OR d.status = $1)
          AND ($2::text IS NULL OR b.region_code = $2)
        ORDER BY (d.status = 'OPEN') DESC, d.created_at DESC
        LIMIT $3`,
      [status ?? null, this.effectiveRegion(admin), this.clampLimit(limit, 100)],
    );
  }

  // ─── Finance ledger (DC-01) ───────────────────────────────────────
  // Never selects stripe_client_secret / stripe_intent_id — ids stay
  // reconcilable via the Stripe dashboard, secrets never leave the DB.

  listWalletTransactions(q: {user_id?: string; type?: string; status?: string; before?: string; limit?: number}) {
    return this.db.q(
      `SELECT t.id, t.user_id, u.display_name, u.role AS user_role,
              t.type, t.status, t.amount_credits, t.amount_fiat_cents,
              t.fiat_currency, t.description, t.booking_id,
              t.created_at, t.settled_at
         FROM wallet_transactions t
         LEFT JOIN users u ON u.id = t.user_id
        WHERE ($1::uuid IS NULL OR t.user_id = $1)
          AND ($2::text IS NULL OR t.type::text = $2)
          AND ($3::text IS NULL OR t.status::text = $3)
          AND ($4::timestamptz IS NULL OR t.created_at < $4)
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT $5`,
      [q.user_id ?? null, q.type ?? null, q.status ?? null, q.before ?? null, this.clampLimit(q.limit, 50, 200)],
    );
  }

  listEscrows(admin: AdminContext, status?: string, limit?: number) {
    return this.db.q(
      `SELECT e.id, e.booking_id, e.status, e.basis, e.review_required,
              e.gross_credits, e.to_provider_credits, e.to_client_credits, e.platform_fee_credits,
              e.held_at, e.completed_at, e.release_eligible_at, e.settled_at,
              e.client_id, cu.display_name AS client_name,
              e.provider_user_id, pu.display_name AS provider_name,
              b.region_code, b.region_label, b.service, b.status AS booking_status
         FROM escrow_holds e
         JOIN lite_bookings b ON b.id = e.booking_id
         LEFT JOIN users cu ON cu.id = e.client_id
         LEFT JOIN users pu ON pu.id = e.provider_user_id
        WHERE ($1::text IS NULL OR e.status::text = $1)
          AND ($2::text IS NULL OR b.region_code = $2)
        ORDER BY e.held_at DESC
        LIMIT $3`,
      [status ?? null, this.effectiveRegion(admin), this.clampLimit(limit, 100)],
    );
  }

  listPayouts(admin: AdminContext, limit?: number) {
    return this.db.q(
      `SELECT p.id, p.mission_id, p.booking_id, p.agent_user_id, p.call_sign,
              p.proposed_credits, p.paid_credits, p.deduction_credits, p.deduction_reason,
              p.decided_by, p.decided_at, p.payee_user_id,
              pu.display_name AS payee_name,
              m.short_code AS mission_short_code,
              b.region_code, b.region_label
         FROM mission_payouts p
         LEFT JOIN users pu ON pu.id = COALESCE(p.payee_user_id, p.agent_user_id)
         LEFT JOIN missions m ON m.id = p.mission_id
         LEFT JOIN lite_bookings b ON b.id = p.booking_id
        WHERE ($1::text IS NULL OR b.region_code = $1)
        ORDER BY p.decided_at DESC NULLS LAST
        LIMIT $2`,
      [this.effectiveRegion(admin), this.clampLimit(limit, 100)],
    );
  }

  listInvoices(admin: AdminContext, limit?: number) {
    return this.db.q(
      `SELECT i.id, i.invoice_number, i.booking_id, i.kind, i.issued_at, i.currency,
              i.subtotal_credits, i.tax_rate_pct, i.tax_credits, i.total_credits, i.pdf_url,
              b.region_code, b.region_label, b.service
         FROM invoices i
         LEFT JOIN lite_bookings b ON b.id = i.booking_id
        WHERE ($1::text IS NULL OR b.region_code = $1)
        ORDER BY i.issued_at DESC
        LIMIT $2`,
      [this.effectiveRegion(admin), this.clampLimit(limit, 100)],
    );
  }

  listPromos() {
    return this.db.q(
      `SELECT p.id, p.code, p.credits, p.max_redemptions, p.redeemed_count,
              p.expires_at, p.active, p.created_at,
              (SELECT COUNT(*)::int FROM promo_redemptions r WHERE r.promo_id = p.id) AS redemptions
         FROM promo_codes p
        ORDER BY p.created_at DESC`,
    );
  }

  /** Balance + batches + recent ledger for one user — powers the adjust form's context panel. */
  async walletOverview(userId: string) {
    const [user, balance, batches, transactions] = await Promise.all([
      this.db.qOne(
        `SELECT id, display_name, role, kyc_status, subscription_tier FROM users WHERE id = $1`,
        [userId],
      ),
      this.db.qOne(
        `SELECT bravo_credits, currency, updated_at FROM wallet_balances WHERE user_id = $1`,
        [userId],
      ),
      this.db.q(
        `SELECT id, amount_credits, consumed_credits, issued_at, expires_at, expired_at
           FROM wallet_credit_batches WHERE user_id = $1
          ORDER BY issued_at DESC LIMIT 20`,
        [userId],
      ),
      this.listWalletTransactions({user_id: userId, limit: 20}),
    ]);
    if (!user) throw new NotFoundException('user_not_found');
    return {user, balance: balance ?? {bravo_credits: 0, currency: 'BC', updated_at: null}, batches, transactions};
  }

  // ─── User directory (DC-04) ───────────────────────────────────────
  // password_hash / notif_prefs never selected.

  listUsers(q: {q?: string; role?: string; kyc?: string; tier?: string; limit?: number}) {
    return this.db.q(
      `SELECT u.id, u.display_name, u.phone_e164, u.email, u.role,
              u.subscription_tier, u.kyc_status, u.country_code, u.home_region,
              u.created_at, u.deleted_at,
              w.bravo_credits
         FROM users u
         LEFT JOIN wallet_balances w ON w.user_id = u.id
        WHERE ($1::text IS NULL OR u.display_name ILIKE '%' || $1 || '%'
               OR u.email ILIKE '%' || $1 || '%' OR u.phone_e164 LIKE '%' || $1 || '%')
          AND ($2::text IS NULL OR u.role = $2)
          AND ($3::text IS NULL OR u.kyc_status = $3)
          AND ($4::text IS NULL OR u.subscription_tier = $4)
        ORDER BY u.created_at DESC
        LIMIT $5`,
      [q.q?.trim() || null, q.role ?? null, q.kyc ?? null, q.tier ?? null, this.clampLimit(q.limit, 100)],
    );
  }

  async getUserDetail(userId: string) {
    const user = await this.db.qOne(
      `SELECT id, display_name, phone_e164, email, role, bio, subscription_tier,
              kyc_status, country_code, home_region, language, currency, avatar_url,
              pro_active_until, pro_renew_status, app_lock, location_scope,
              created_at, updated_at, deleted_at, password_set_at,
              suspended_at, suspended_reason, suspended_by
         FROM users WHERE id = $1`,
      [userId],
    );
    if (!user) throw new NotFoundException('user_not_found');
    const [devices, balance, bookings, agent] = await Promise.all([
      this.db.q(
        `SELECT id, device_id, platform, signal_device_id,
                created_at, last_used_at, expires_at, revoked_at
           FROM auth_devices WHERE user_id = $1
          ORDER BY last_used_at DESC NULLS LAST LIMIT 50`,
        [userId],
      ),
      this.db.qOne(
        `SELECT bravo_credits, currency, updated_at FROM wallet_balances WHERE user_id = $1`,
        [userId],
      ),
      this.db.q(
        `SELECT id, status, region_code, service, pickup_time, total_eur, created_at
           FROM lite_bookings WHERE client_id = $1 OR payer_user_id = $1
          ORDER BY created_at DESC LIMIT 10`,
        [userId],
      ),
      this.db.qOne(
        `SELECT user_id, type, status, call_sign, tier, on_duty FROM agents WHERE user_id = $1`,
        [userId],
      ),
    ]);
    return {user, devices, balance, bookings, agent};
  }

  /**
   * SK-07/IS-03 — family linkage for one user, both directions: members riding
   * THIS user's plan (owner_of) and the family THIS user is a member of
   * (member_of). Hold state (held_until in the future) rides each row.
   */
  async getUserFamily(userId: string) {
    const [ownerOf, memberOf] = await Promise.all([
      this.db.q(
        `SELECT fm.id, fm.member_id, fm.status, fm.relationship, fm.held_until,
                fm.spend_limit_credits, fm.spent_credits, fm.invited_at, fm.accepted_at,
                COALESCE(mu.display_name, fm.invite_phone) AS member_name,
                mu.email AS member_email
           FROM public.family_members fm
           LEFT JOIN public.users mu ON mu.id = fm.member_id
          WHERE fm.holder_id = $1 AND fm.status IN ('pending','active')
          ORDER BY fm.invited_at DESC`,
        [userId],
      ),
      this.db.q(
        `SELECT fm.id, fm.holder_id, fm.status, fm.relationship, fm.held_until,
                fm.spend_limit_credits, fm.spent_credits, fm.invited_at, fm.accepted_at,
                hu.display_name AS holder_name, hu.email AS holder_email
           FROM public.family_members fm
           JOIN public.users hu ON hu.id = fm.holder_id
          WHERE fm.member_id = $1 AND fm.status IN ('pending','active')
          ORDER BY fm.invited_at DESC`,
        [userId],
      ),
    ]);
    return {owner_of: ownerOf, member_of: memberOf};
  }

  /** Revoke one auth device/session. Refresh dies immediately; the access JWT ages out (≤15 min). */
  async revokeUserDevice(userId: string, deviceRowId: string) {
    const row = await this.db.qOne<{id: string}>(
      `UPDATE auth_devices SET revoked_at = NOW(), current_jti = NULL
        WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
        RETURNING id`,
      [deviceRowId, userId],
    );
    if (!row) throw new NotFoundException('device_not_active');
    return {ok: true as const, device_row_id: row.id};
  }

  private async revokeAllDevices(userId: string): Promise<number> {
    const rows = await this.db.q<{id: string}>(
      `UPDATE auth_devices SET revoked_at = NOW(), current_jti = NULL
        WHERE user_id = $1 AND revoked_at IS NULL
        RETURNING id`,
      [userId],
    );
    return rows.length;
  }

  /**
   * DC-04 — reversible account suspension. Sets suspended_at (the login/verify/
   * refresh paths gate on it) and revokes every live session so the lockout is
   * immediate (residual access tokens expire within their ≤15-min TTL).
   */
  async suspendUser(adminId: string, userId: string, reason: string) {
    const row = await this.db.qOne<{id: string}>(
      `UPDATE users SET suspended_at = NOW(), suspended_reason = $2, suspended_by = $3
        WHERE id = $1 AND deleted_at IS NULL AND suspended_at IS NULL
        RETURNING id`,
      [userId, reason, adminId],
    );
    if (!row) throw new NotFoundException('user_not_suspendable');
    const revoked = await this.revokeAllDevices(userId);
    return {ok: true as const, revoked_sessions: revoked};
  }

  async restoreUser(userId: string) {
    const row = await this.db.qOne<{id: string}>(
      `UPDATE users SET suspended_at = NULL, suspended_reason = NULL, suspended_by = NULL
        WHERE id = $1 AND suspended_at IS NOT NULL
        RETURNING id`,
      [userId],
    );
    if (!row) throw new NotFoundException('user_not_suspended');
    return {ok: true as const};
  }

  /**
   * DC-04 — GDPR erasure. Soft-delete (keep the row for financial/audit
   * referential integrity) + scrub PII + revoke sessions. Irreversible.
   * deleted_at is already the login tombstone across auth.service.
   */
  async eraseUser(adminId: string, userId: string, reason: string) {
    const row = await this.db.qOne<{id: string}>(
      `UPDATE users
          SET deleted_at = NOW(),
              display_name = 'Deleted User',
              email = NULL,
              phone_e164 = NULL,
              avatar_url = NULL,
              bio = NULL,
              password_hash = NULL,
              suspended_at = NULL, suspended_reason = NULL, suspended_by = NULL
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING id`,
      [userId],
    );
    if (!row) throw new NotFoundException('user_not_erasable');
    const revoked = await this.revokeAllDevices(userId);
    return {ok: true as const, revoked_sessions: revoked, reason};
  }

  // ─── SOS log (DC-06) — includes mission-less client/VBG panics ────
  // Deliberately NOT region-scoped: a panic with no booking has no region,
  // and safety visibility beats tenancy for emergency events.

  listSos(status?: 'active' | 'resolved' | 'all', limit?: number) {
    return this.db.q(
      `SELECT s.id, s.mission_id, s.booking_id, s.agent_id, s.user_id,
              s.agent_call_sign, s.reason, s.status, s.lat, s.lng,
              s.triggered_at, s.acknowledged_at, s.acknowledged_by,
              s.escalated_at, s.escalated_to, s.resolved_at, s.resolved_by, s.resolution,
              m.short_code AS mission_short_code,
              b.region_code, b.region_label,
              u.display_name AS user_display_name
         FROM sos_events s
         LEFT JOIN missions m ON m.id = s.mission_id
         LEFT JOIN lite_bookings b ON b.id = COALESCE(s.booking_id, m.booking_id)
         LEFT JOIN users u ON u.id = COALESCE(s.user_id, s.agent_id)
        WHERE CASE
                WHEN $1::text = 'active'   THEN s.resolved_at IS NULL
                WHEN $1::text = 'resolved' THEN s.resolved_at IS NOT NULL
                ELSE TRUE
              END
        ORDER BY (s.resolved_at IS NULL) DESC, s.triggered_at DESC
        LIMIT $2`,
      [status ?? 'all', this.clampLimit(limit, 200)],
    );
  }

  // ─── VBG oversight (DC-07) ────────────────────────────────────────

  listVbgMonitoring() {
    return this.db.q(
      `SELECT v.user_id, u.display_name, u.phone_e164, u.home_region,
              v.status, v.interval_min, v.enrolled_at, v.last_heartbeat_at,
              v.missed_count, v.consecutive_fails, v.last_zone_state, v.escalated_at,
              v.lat, v.lng,
              t.lat AS last_lat, t.lng AS last_lng, t.recorded_at AS last_telemetry_at,
              s.risk_score, s.level AS sra_level, s.created_at AS sra_at
         FROM vbg_monitoring v
         JOIN users u ON u.id = v.user_id
         LEFT JOIN vbg_telemetry_last t ON t.user_id = v.user_id
         LEFT JOIN LATERAL (
           SELECT risk_score, level, created_at FROM vbg_sra_snapshots ss
            WHERE ss.user_id = v.user_id ORDER BY ss.created_at DESC LIMIT 1
         ) s ON TRUE
        ORDER BY v.escalated_at DESC NULLS LAST, v.last_heartbeat_at DESC NULLS LAST`,
    );
  }

  // ─── Global audit browser (DC-08) — keyset-paginated ──────────────

  browseAudit(q: {actor_id?: string; action?: string; subject_type?: string; from?: string; to?: string; before?: string; limit?: number}) {
    return this.db.q(
      `SELECT id, actor_id, actor_role, actor_call, action,
              subject_type, subject_id, metadata, ip_address, created_at
         FROM ops_audit
        WHERE ($1::uuid IS NULL OR actor_id = $1)
          AND ($2::text IS NULL OR action ILIKE $2 || '%')
          AND ($3::text IS NULL OR subject_type = $3)
          AND ($4::timestamptz IS NULL OR created_at >= $4)
          AND ($5::timestamptz IS NULL OR created_at <= $5)
          AND ($6::timestamptz IS NULL OR created_at < $6)
        ORDER BY created_at DESC, id DESC
        LIMIT $7`,
      [q.actor_id ?? null, q.action?.trim() || null, q.subject_type ?? null,
       q.from ?? null, q.to ?? null, q.before ?? null, this.clampLimit(q.limit, 100, 200)],
    );
  }

  /** Readers for the previously write-only trails. */
  listAgentAudit(agentUserId: string, limit = 50) {
    return this.db.q(
      `SELECT id, from_status, to_status, actor_id, actor_role, metadata, created_at
         FROM agent_audit WHERE user_id = $1
        ORDER BY created_at DESC LIMIT $2`,
      [agentUserId, this.clampLimit(limit, 50, 200)],
    );
  }

  listOrgAudit(orgUserId: string, limit = 100) {
    return this.db.q(
      `SELECT id, org_user_id, actor_id, action, target_kind, target_id, metadata, created_at
         FROM org_audit_log WHERE org_user_id = $1
        ORDER BY created_at DESC LIMIT $2`,
      [orgUserId, this.clampLimit(limit, 100, 200)],
    );
  }

  // ─── Telemetry replay (DC-16) ─────────────────────────────────────

  async missionTelemetry(missionId: string, admin: AdminContext) {
    const m = await this.db.qOne<{id: string; region_code: string | null}>(
      `SELECT m.id, b.region_code FROM missions m
         LEFT JOIN lite_bookings b ON b.id = m.booking_id
        WHERE m.id = $1`,
      [missionId],
    );
    if (!m) throw new NotFoundException('mission_not_found');
    if (m.region_code) assertRegionScope(admin, m.region_code);
    const points = await this.db.q(
      `SELECT agent_id, lat, lng, heading_deg, speed_kph, accuracy_m,
              distance_to_dropoff_m, battery_pct, recorded_at
         FROM mission_telemetry WHERE mission_id = $1
        ORDER BY recorded_at ASC LIMIT 5000`,
      [missionId],
    );
    return {mission_id: missionId, points};
  }

  // ─── Broadcast log (DC-20) ────────────────────────────────────────

  listRecentBroadcasts(kind?: string, limit?: number) {
    return this.db.q(
      `SELECT id, conversation_id, kind, title, body, severity,
              subject_type, subject_id, created_by, created_at
         FROM system_broadcasts
        WHERE ($1::text IS NULL OR kind::text = $1)
        ORDER BY created_at DESC
        LIMIT $2`,
      [kind ?? null, this.clampLimit(limit, 100, 200)],
    );
  }

  // ─── Analytics rollups (DC-10, DC-15) ─────────────────────────────

  async analytics(admin: AdminContext, days = 30, requestedRegion?: string) {
    const window = Math.min(Math.max(Number(days) || 30, 1), 365);
    const region = this.effectiveRegion(admin, requestedRegion);
    const [byDay, byStatus, offers, missions, walletFlows, regions, lowPrekeys] = await Promise.all([
      this.db.q(
        `SELECT created_at::date AS day, COUNT(*)::int AS bookings,
                COALESCE(SUM(total_eur), 0)::numeric AS gmv_bc
           FROM lite_bookings
          WHERE created_at >= NOW() - make_interval(days => $1)
            AND ($2::text IS NULL OR region_code = $2)
          GROUP BY 1 ORDER BY 1`,
        [window, region],
      ),
      this.db.q(
        `SELECT status::text, COUNT(*)::int AS count
           FROM lite_bookings
          WHERE created_at >= NOW() - make_interval(days => $1)
            AND ($2::text IS NULL OR region_code = $2)
          GROUP BY 1 ORDER BY 2 DESC`,
        [window, region],
      ),
      this.db.q(
        `SELECT o.status::text, COUNT(*)::int AS count
           FROM dispatch_offers o
           JOIN lite_bookings b ON b.id = o.booking_id
          WHERE o.offered_at >= NOW() - make_interval(days => $1)
            AND ($2::text IS NULL OR b.region_code = $2)
          GROUP BY 1`,
        [window, region],
      ),
      this.db.qOne(
        `SELECT COUNT(*) FILTER (WHERE m.status = 'COMPLETED')::int AS completed,
                COUNT(*) FILTER (WHERE m.status = 'ABORTED')::int   AS aborted,
                COALESCE(AVG(EXTRACT(EPOCH FROM (m.ended_at - m.started_at)))
                  FILTER (WHERE m.status = 'COMPLETED' AND m.ended_at IS NOT NULL AND m.started_at IS NOT NULL), 0)::int AS avg_duration_s,
                (SELECT COUNT(*)::int FROM sos_events s
                  WHERE s.triggered_at >= NOW() - make_interval(days => $1)) AS sos_events
           FROM missions m
           LEFT JOIN lite_bookings b ON b.id = m.booking_id
          WHERE m.created_at >= NOW() - make_interval(days => $1)
            AND ($2::text IS NULL OR b.region_code = $2)`,
        [window, region],
      ),
      this.db.q(
        `SELECT type::text, COUNT(*)::int AS count, COALESCE(SUM(amount_credits), 0)::bigint AS credits
           FROM wallet_transactions
          WHERE created_at >= NOW() - make_interval(days => $1) AND status = 'succeeded'
          GROUP BY 1 ORDER BY 3 DESC`,
        [window],
      ),
      this.db.q(
        `SELECT region_code, COUNT(*)::int AS bookings, COALESCE(SUM(total_eur), 0)::numeric AS gmv_bc
           FROM lite_bookings
          WHERE created_at >= NOW() - make_interval(days => $1)
          GROUP BY 1 ORDER BY 2 DESC`,
        [window],
      ),
      // DC-15 — one-time-prekey low-watermark (X3DH silently degrades when a
      // device runs dry); count (user, device) bundles under 10 keys.
      this.db.qOne<{low: number; total_devices: number}>(
        `SELECT COUNT(*) FILTER (WHERE cnt < 10)::int AS low, COUNT(*)::int AS total_devices
           FROM (SELECT user_id, device_id, COUNT(*)::int AS cnt
                   FROM signal_one_time_prekeys GROUP BY 1, 2) k`,
      ),
    ]);
    return {
      window_days: window,
      region: region ?? 'ALL',
      bookings_by_day: byDay,
      bookings_by_status: byStatus,
      dispatch_offers: offers,
      missions,
      wallet_flows: walletFlows,
      regions,
      signal_prekeys: lowPrekeys ?? {low: 0, total_devices: 0},
    };
  }
}
