import {BadRequestException, Injectable, Logger, NotFoundException} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';
import {resolveAccountKind} from '../auth/account-kind';
import {GeocodeService} from '../vbg/geocode.service';
import {BookingPushBridge} from '../ops/booking-push-bridge.service';
import {OpsAuditService} from '../ops/ops-audit.service';
import {FamilyQuotaService} from './family-quota.service';
import {effectiveSpendable, remainingQuota} from './family-quota.util';

export interface FamilyMemberLocation {
  lat:        number;
  lng:        number;
  /** Reverse-geocoded area name ("Benoni") — falls back to rounded coords. */
  label:      string | null;
  accuracyM:  number | null;
  recordedAt: string;
}

export interface FamilyMemberDto {
  id:           string;
  memberId:     string | null;
  name:         string;        // display name or the invited phone
  avatarUrl:    string | null;
  status:       'pending' | 'active' | 'revoked' | 'declined';
  /** Owner-declared relationship (badge on the member row). */
  relationship: string | null;
  /** ISO — while in the future the member is ON HOLD (no owner credits / no Pro plan). */
  heldUntil:    string | null;
  spendLimit:   number | null;
  spent:        number;
  invitedAt:    string;
  acceptedAt:   string | null;
  /** Last device fix — ACTIVE, non-held members only; null until they report. */
  lastLocation: FamilyMemberLocation | null;
}

export interface FamilyMemberSpendDto {
  member: {id: string; name: string; spent: number; spendLimit: number | null};
  byFeature: Array<{feature: string; spent: number; refunded: number; count: number}>;
  transactions: Array<{
    id: string;
    type: 'payment' | 'refund';
    feature: string | null;
    description: string;
    /** Signed credits — negative = spent from the owner's wallet, positive = refunded back. */
    amount: number;
    bookingId: string | null;
    at: string;
  }>;
}

export interface FamilyInviteDto {
  id:           string;
  holderId:     string;
  holderName:   string;
  relationship: string | null;
  invitedAt:    string;
}

const MAX_ACTIVE_MEMBERS = 4;

/**
 * Family hierarchy + shared credits.
 *
 * A holder invites members (by phone). Accepted members' bookings are
 * charged to the HOLDER's wallet — `resolvePayer()` is the single hook the
 * booking flow uses to redirect the debit. A per-member `spend_limit` caps
 * how much of the holder's credits a member may consume.
 */
@Injectable()
export class FamilyService {
  private readonly log = new Logger(FamilyService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly geocode: GeocodeService,
    private readonly push: BookingPushBridge,
    private readonly opsAudit: OpsAuditService,
    private readonly quota: FamilyQuotaService,
  ) {}

  /**
   * Holder invites a phone. Founder rule (2026-08-03): the invitee MUST
   * already hold an individual Bravo account (Lite or Pro) — pending-by-phone
   * rows are no longer created; the client picks from registered contacts.
   */
  async invite(
    holderId: string, phoneE164: string, spendLimit?: number | null, relationship?: string | null,
  ): Promise<{id: string; status: string}> {
    const phone = phoneE164.trim();
    if (!/^\+\d{6,15}$/.test(phone)) {throw new BadRequestException('invalid_phone');}

    const target = await this.db.qOne<{id: string; phone_e164: string | null}>(
      `SELECT id, phone_e164 FROM public.users WHERE phone_e164 = $1`,
      [phone],
    );
    if (!target) {throw new BadRequestException('not_a_bravo_user');}
    if (target.id === holderId) {throw new BadRequestException('cannot_invite_self');}
    const {account_kind} = await resolveAccountKind(this.db, target.id);
    if (account_kind !== 'individual') {throw new BadRequestException('not_an_individual_account');}

    // Enforce max active members.
    const active = await this.db.qOne<{n: number}>(
      `SELECT COUNT(*)::int AS n FROM public.family_members WHERE holder_id = $1 AND status = 'active'`,
      [holderId],
    );
    if ((active?.n ?? 0) >= MAX_ACTIVE_MEMBERS) {throw new BadRequestException('family_full');}

    // If that user is already active in ANOTHER family, refuse.
    const elsewhere = await this.db.qOne<{id: string}>(
      `SELECT id FROM public.family_members WHERE member_id = $1 AND status = 'active' AND holder_id <> $2`,
      [target.id, holderId],
    );
    if (elsewhere) {throw new BadRequestException('member_in_another_family');}

    // The legacy holder+phone partial unique can't catch member_id-bound
    // duplicates — check explicitly.
    const dupe = await this.db.qOne<{id: string}>(
      `SELECT id FROM public.family_members
        WHERE holder_id = $1 AND member_id = $2 AND status IN ('pending','active')`,
      [holderId, target.id],
    );
    if (dupe) {throw new BadRequestException('invite_already_pending');}

    const row = await this.db.qOne<{id: string}>(
      `INSERT INTO public.family_members
         (holder_id, member_id, invite_phone, status, spend_limit_credits, relationship)
       VALUES ($1, $2, NULL, 'pending', $3, $4)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [holderId, target.id, normalizeLimit(spendLimit), normalizeRelationship(relationship)],
    );
    if (!row) {
      throw new BadRequestException('invite_already_pending');
    }
    // R-3 — the invitee only discovered the invite if they happened to open
    // Profile. Fire-and-forget; polling remains the fallback.
    void this.push.familyInvite(target.id, row.id).catch(() => undefined);
    return {id: row.id, status: 'pending'};
  }

  /**
   * At the self-serve cap the holder can ASK Ops to raise their linked-member
   * seat limit. Self-serve stays hard-capped at MAX_ACTIVE_MEMBERS (`invite`
   * still throws `family_full` past 4) — this is the escape hatch, not a way to
   * mint a 5th seat. It files a request into the ops live feed (the same
   * lightweight ops-alert channel the protection no-CPO path uses) and never
   * throws for the client, so the CTA always confirms "request sent".
   */
  async requestSeats(holderId: string): Promise<{ok: true}> {
    const active = await this.db.qOne<{n: number}>(
      `SELECT COUNT(*)::int AS n FROM public.family_members WHERE holder_id = $1 AND status = 'active'`,
      [holderId],
    );
    // `emit` is best-effort and swallows its own errors, so awaiting it cannot
    // throw — the holder always gets {ok:true}.
    await this.opsAudit.emit({
      kind: 'family', severity: 'warn', subject: holderId,
      message: `Linked-member seat increase requested (family at ${active?.n ?? MAX_ACTIVE_MEMBERS}/${MAX_ACTIVE_MEMBERS})`,
      metadata: {holderId, activeCount: active?.n ?? null, maxSeats: MAX_ACTIVE_MEMBERS},
    });
    return {ok: true};
  }

  async listMembers(holderId: string): Promise<FamilyMemberDto[]> {
    const rows = await this.db.q<{
      id: string; member_id: string | null; invite_phone: string | null;
      status: string; relationship: string | null; held_until: Date | null;
      spend_limit_credits: number | null; spent_credits: number;
      invited_at: Date; accepted_at: Date | null; display_name: string | null;
      avatar_url: string | null;
      loc_lat: number | null; loc_lng: number | null; loc_label: string | null;
      loc_accuracy_m: number | null; loc_recorded_at: Date | null;
    }>(
      // The location join is gated in SQL: a pending or held member never
      // exposes a fix to the owner, even if a stale row exists.
      `SELECT fm.id, fm.member_id, fm.invite_phone, fm.status, fm.relationship,
              fm.held_until, fm.spend_limit_credits, fm.spent_credits,
              fm.invited_at, fm.accepted_at, u.display_name, u.avatar_url,
              loc.lat AS loc_lat, loc.lng AS loc_lng, loc.label AS loc_label,
              loc.accuracy_m AS loc_accuracy_m, loc.recorded_at AS loc_recorded_at
         FROM public.family_members fm
         LEFT JOIN public.users u ON u.id = fm.member_id
         LEFT JOIN public.family_member_locations loc
                ON loc.user_id = fm.member_id
               AND fm.status = 'active'
               AND (fm.held_until IS NULL OR fm.held_until <= NOW())
        WHERE fm.holder_id = $1 AND fm.status IN ('pending','active')
        ORDER BY fm.invited_at DESC`,
      [holderId],
    );
    return rows.map(r => ({
      id: r.id,
      memberId: r.member_id,
      name: r.display_name ?? r.invite_phone ?? 'Invited member',
      avatarUrl: r.avatar_url,
      status: r.status as FamilyMemberDto['status'],
      relationship: r.relationship,
      heldUntil: r.held_until?.toISOString() ?? null,
      spendLimit: r.spend_limit_credits,
      spent: r.spent_credits,
      invitedAt: r.invited_at.toISOString(),
      acceptedAt: r.accepted_at?.toISOString() ?? null,
      lastLocation: r.loc_lat !== null && r.loc_lng !== null && r.loc_recorded_at ? {
        lat: Number(r.loc_lat),
        lng: Number(r.loc_lng),
        label: r.loc_label,
        accuracyM: r.loc_accuracy_m !== null ? Number(r.loc_accuracy_m) : null,
        recordedAt: r.loc_recorded_at.toISOString(),
      } : null,
    }));
  }

  /** Invites awaiting THIS user's accept (by member_id or by their phone). */
  async invitesFor(userId: string): Promise<FamilyInviteDto[]> {
    const rows = await this.db.q<{id: string; holder_id: string; invited_at: Date; holder_name: string | null; relationship: string | null}>(
      `SELECT fm.id, fm.holder_id, fm.invited_at, fm.relationship, h.display_name AS holder_name
         FROM public.family_members fm
         JOIN public.users h ON h.id = fm.holder_id
        WHERE fm.status = 'pending'
          AND (fm.member_id = $1
               OR fm.invite_phone = (SELECT phone_e164 FROM public.users WHERE id = $1))
        ORDER BY fm.invited_at DESC`,
      [userId],
    );
    return rows.map(r => ({
      id: r.id, holderId: r.holder_id, holderName: r.holder_name ?? 'A Bravo user',
      relationship: r.relationship,
      invitedAt: r.invited_at.toISOString(),
    }));
  }

  async accept(userId: string, inviteId: string): Promise<{ok: true}> {
    // Bind this user, but only if not already active elsewhere.
    const inElsewhere = await this.db.qOne<{id: string}>(
      `SELECT id FROM public.family_members WHERE member_id = $1 AND status = 'active'`,
      [userId],
    );
    if (inElsewhere) {throw new BadRequestException('already_in_a_family');}

    const updated = await this.db.qOne<{id: string; holder_id: string}>(
      `UPDATE public.family_members
          SET status = 'active', member_id = $1, accepted_at = NOW(), invite_phone = NULL
        WHERE id = $2 AND status = 'pending'
          AND (member_id = $1 OR invite_phone = (SELECT phone_e164 FROM public.users WHERE id = $1))
        RETURNING id, holder_id`,
      [userId, inviteId],
    );
    if (!updated) {throw new NotFoundException('invite_not_found');}
    // R-3 — tell the holder their member is now active (was poll-only).
    void this.push.familyInviteAccepted(updated.holder_id, updated.id).catch(() => undefined);
    return {ok: true};
  }

  async decline(userId: string, inviteId: string): Promise<{ok: true}> {
    await this.db.q(
      `UPDATE public.family_members SET status = 'declined'
        WHERE id = $1 AND status = 'pending'
          AND (member_id = $2 OR invite_phone = (SELECT phone_e164 FROM public.users WHERE id = $2))`,
      [inviteId, userId],
    );
    return {ok: true};
  }

  async revoke(holderId: string, memberRowId: string): Promise<{ok: true}> {
    await this.db.q(
      `UPDATE public.family_members SET status = 'revoked' WHERE id = $1 AND holder_id = $2`,
      [memberRowId, holderId],
    );
    // Privacy hygiene: a removed member's last fix must not linger. Gated on
    // accepted_at so cancelling a merely-PENDING invite can never delete a fix
    // the member is sharing with a DIFFERENT family they actually joined. (A
    // report racing this delete can strand one row — it stays invisible to this
    // holder via the listMembers active-join and is overwritten on next report.)
    await this.db.q(
      `DELETE FROM public.family_member_locations
        WHERE user_id = (SELECT member_id FROM public.family_members
                          WHERE id = $1 AND holder_id = $2 AND accepted_at IS NOT NULL)`,
      [memberRowId, holderId],
    );
    // §20 — financial history stays: the ledger, the quota audit trail and the
    // membership row itself are all untouched (status flips to 'revoked', it is
    // never deleted). Only the OPEN credit request is closed, because a request
    // against a revoked membership can never legitimately be approved.
    await this.quota.cancelPendingOnRevoke(memberRowId, holderId);
    return {ok: true};
  }

  /**
   * Set a member's spending quota.
   *
   * Delegates to FamilyQuotaService, which does this under a row lock, refuses
   * a reduction below the member's already-spent amount (spec §19 — the bare
   * UPDATE this replaced could drive `remaining` negative), and writes the
   * `family_quota_audit` row. The signature keeps its old shape plus an
   * optional actor/reason so the existing controller route and its callers did
   * not have to change.
   */
  async setSpendLimit(
    holderId: string, memberRowId: string, limit: number | null,
    actorId?: string, reason?: string | null,
  ): Promise<{ok: true; previousLimit: number | null; newLimit: number | null; spent: number; remaining: number | null}> {
    return this.quota.setQuota(holderId, memberRowId, limit, actorId ?? holderId, reason);
  }

  /**
   * Owner-imposed hold: until the given instant the member cannot spend the
   * owner's credits (resolvePayer falls back to their own wallet) or use the
   * owner's Pro plan. `null` lifts the hold.
   */
  async setHold(holderId: string, memberRowId: string, heldUntilIso: string | null): Promise<{ok: true}> {
    if (heldUntilIso !== null) {
      const t = new Date(heldUntilIso).getTime();
      if (!Number.isFinite(t)) {throw new BadRequestException('invalid_hold_date');}
      if (t <= Date.now()) {throw new BadRequestException('hold_must_be_in_future');}
      if (t > Date.now() + 366 * 86400_000) {throw new BadRequestException('hold_too_long');}
    }
    const row = await this.db.qOne<{id: string}>(
      `UPDATE public.family_members SET held_until = $3
        WHERE id = $1 AND holder_id = $2 AND status = 'active'
        RETURNING id`,
      [memberRowId, holderId, heldUntilIso],
    );
    if (!row) {throw new NotFoundException('member_not_found');}
    return {ok: true};
  }

  /** The family this user is an active member of (for their own UI). */
  async myMembership(userId: string): Promise<{
    holderId: string; holderName: string; relationship: string | null;
    heldUntil: string | null; spendLimit: number | null; spent: number;
    /** Spec §41 — `spendLimit - spent`, or null when the quota is unlimited. */
    remaining: number | null;
    /**
     * Spec §3/§10/§41 — `min(remaining quota, root available credit)`: what this
     * member can ACTUALLY spend right now.
     *
     * The root's raw balance is deliberately NOT returned. §41 asks for it only
     * "if appropriate for the product", and a member is not entitled to read the
     * holder's finances — but they do need to understand why a booking inside
     * their quota can still be refused, and this number says exactly that
     * without disclosing how much the holder actually has.
     */
    effectiveSpendable: number;
    /** Spec §21 — the root account is suspended, so nothing is spendable. */
    rootSuspended: boolean;
    /** Spec §42 — so the UI shows "View Request", never a duplicate-creating button. */
    pendingRequest: {id: string; requestedCredits: number; createdAt: string} | null;
  } | null> {
    const row = await this.db.qOne<{
      id: string; holder_id: string; holder_name: string | null; relationship: string | null;
      held_until: Date | null; spend_limit_credits: number | null; spent_credits: number;
      holder_suspended_at: Date | null; root_credits: number | null;
    }>(
      `SELECT fm.id, fm.holder_id, h.display_name AS holder_name, fm.relationship,
              fm.held_until, fm.spend_limit_credits, fm.spent_credits,
              h.suspended_at AS holder_suspended_at, wb.bravo_credits AS root_credits
         FROM public.family_members fm
         JOIN public.users h ON h.id = fm.holder_id
         LEFT JOIN public.wallet_balances wb ON wb.user_id = fm.holder_id
        WHERE fm.member_id = $1 AND fm.status = 'active'`,
      [userId],
    );
    if (!row) {return null;}

    const spent = Number(row.spent_credits ?? 0);
    const limit = row.spend_limit_credits;
    const rootSuspended = row.holder_suspended_at !== null;
    // A suspended root makes the effective figure 0 regardless of quota (§21) —
    // the number the member sees must agree with what the spend path will do,
    // or the UI is lying to them.
    const rootAvailable = rootSuspended ? 0 : Number(row.root_credits ?? 0);

    const pending = await this.db.qOne<{id: string; requested_credits: number; created_at: Date}>(
      `SELECT id, requested_credits, created_at
         FROM public.family_credit_requests
        WHERE family_row_id = $1 AND status = 'pending' AND expires_at > NOW()`,
      [row.id],
    ).catch(() => null);

    return {
      holderId: row.holder_id, holderName: row.holder_name ?? 'Family',
      relationship: row.relationship, heldUntil: row.held_until?.toISOString() ?? null,
      spendLimit: limit, spent,
      remaining: remainingQuota(spent, limit),
      effectiveSpendable: effectiveSpendable(spent, limit, rootAvailable),
      rootSuspended,
      pendingRequest: pending
        ? {id: pending.id, requestedCredits: pending.requested_credits, createdAt: pending.created_at.toISOString()}
        : null,
    };
  }

  /**
   * BILLING HOOK — who pays for `userId`'s booking. Active family member →
   * the holder; everyone else → themselves (identity). Also returns the
   * active member-row so the caller can enforce the cap + bump `spent`.
   */
  async resolvePayer(userId: string): Promise<{
    payerId: string; familyRowId: string | null; spendLimit: number | null; spent: number;
    /**
     * Spec §21 — the ROOT account is suspended, so every member draw on it must
     * stop even though the member's own quota may be untouched. Additive field:
     * the charge sites turn it into ROOT_ACCOUNT_SUSPENDED, and a caller (or a
     * test double) that predates it reads `undefined`, i.e. not suspended,
     * which is exactly the previous behaviour.
     */
    holderSuspended: boolean;
  }> {
    // A held member (held_until in the future) pays from their OWN wallet —
    // the owner's credits are frozen for them for the hold window. That is a
    // deliberate PRODUCT rule and differs from spec §22's "member suspended =
    // cannot spend at all"; it is preserved as-is rather than rewritten.
    const row = await this.db.qOne<{
      id: string; holder_id: string; spend_limit_credits: number | null;
      spent_credits: number; holder_suspended_at: Date | null;
    }>(
      `SELECT fm.id, fm.holder_id, fm.spend_limit_credits, fm.spent_credits,
              h.suspended_at AS holder_suspended_at
         FROM public.family_members fm
         JOIN public.users h ON h.id = fm.holder_id
        WHERE fm.member_id = $1 AND fm.status = 'active'
          AND (fm.held_until IS NULL OR fm.held_until <= NOW())`,
      [userId],
    );
    if (!row) {return {payerId: userId, familyRowId: null, spendLimit: null, spent: 0, holderSuspended: false};}
    return {
      payerId: row.holder_id, familyRowId: row.id,
      spendLimit: row.spend_limit_credits, spent: row.spent_credits,
      holderSuspended: row.holder_suspended_at !== null,
    };
  }

  /**
   * Post-charge hook for the two spend sites (spec §33/§34): warn the holder if
   * this member just crossed 80 / 90 / 100% of their quota.
   *
   * A passthrough so `BookingService` and `DispatchService` — which already
   * inject `FamilyService` — do not each have to take a second dependency.
   * MUST be called AFTER the charge transaction commits: it reads the
   * post-bump `spent_credits`, and running it inside the txn would both read a
   * value that may still roll back and hold the member row's lock across a
   * Redis publish, lengthening the critical section MON-4 keeps short.
   */
  async notifyUsageThreshold(familyRowId: string | null): Promise<void> {
    if (!familyRowId) {return;}
    await this.quota.notifyUsageThreshold(familyRowId);
  }

  /** Same hook, addressed by member user id — for callers that do not carry the
   *  membership row id out of their charge transaction (the escrow accept). */
  async notifyUsageThresholdForMember(memberUserId: string | null): Promise<void> {
    if (!memberUserId) {return;}
    await this.quota.notifyUsageThresholdForMember(memberUserId);
  }

  /**
   * Post-refund hook: a refund lowered `spent_credits`, so re-arm the usage
   * bands the member has dropped back below (§26). Never notifies.
   */
  async rearmUsageThreshold(familyRowId: string | null): Promise<void> {
    if (!familyRowId) {return;}
    await this.quota.rearmUsageThreshold(familyRowId);
  }

  /**
   * MEMBER side — report the device's current fix. Silently a no-op (`reported:
   * false`) unless the caller is an ACTIVE, non-held family member whose
   * `users.location_scope` is not 'never' — the report path is the consent
   * gate, so an ineligible client learns nothing and stores nothing.
   */
  async reportLocation(
    userId: string,
    fix: {lat: number; lng: number; accuracyM?: number | null},
  ): Promise<{ok: true; reported: boolean}> {
    const lat = Number(fix.lat);
    const lng = Number(fix.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)
        || Math.abs(lat) > 90 || Math.abs(lng) > 180
        || (lat === 0 && lng === 0)) {
      throw new BadRequestException('invalid_coordinates');
    }
    // Consent: only the permissive default scope shares continuously with the
    // family owner. Both narrower choices the user can make in Settings →
    // Location ('during_mission', 'never') exclude family sharing — a user who
    // deliberately narrowed their location use must not stream 24/7.
    const eligible = await this.db.qOne<{id: string}>(
      `SELECT fm.id
         FROM public.family_members fm
         JOIN public.users u ON u.id = fm.member_id
        WHERE fm.member_id = $1 AND fm.status = 'active'
          AND (fm.held_until IS NULL OR fm.held_until <= NOW())
          AND u.location_scope = 'while_on_duty'`,
      [userId],
    );
    if (!eligible) {return {ok: true, reported: false};}

    // Number(null) === 0 — a missing accuracy must store NULL, never "perfect".
    const accRaw = fix.accuracyM == null ? NaN : Number(fix.accuracyM);
    const accuracyM = Number.isFinite(accRaw) && accRaw >= 0 ? accRaw : null;
    // Reverse-geocode server-side (cached ~1km/1h) so the label is trusted and
    // consistent; GeocodeService degrades to a coords label, never throws.
    const region = await this.geocode.reverse(lat, lng);
    await this.db.q(
      `INSERT INTO public.family_member_locations (user_id, lat, lng, accuracy_m, label, recorded_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (user_id) DO UPDATE
         SET lat = EXCLUDED.lat, lng = EXCLUDED.lng, accuracy_m = EXCLUDED.accuracy_m,
             label = EXCLUDED.label, recorded_at = NOW()`,
      [userId, lat, lng, accuracyM, region.region ?? null],
    );
    return {ok: true, reported: true};
  }

  /**
   * HOLDER side — what a member spent from the owner's wallet, itemised.
   * Sourced from the ledger's actor stamps (`wallet_transactions.actor_user_id`
   * = the member, `user_id` = the holder who paid), so every charge path —
   * legacy pay, escrow hold, refunds — shows up with its feature.
   */
  async memberSpend(holderId: string, memberRowId: string, limit = 50): Promise<FamilyMemberSpendDto> {
    const fm = await this.db.qOne<{
      member_id: string | null; spend_limit_credits: number | null; spent_credits: number;
      display_name: string | null; invite_phone: string | null;
    }>(
      `SELECT fm.member_id, fm.spend_limit_credits, fm.spent_credits, u.display_name, fm.invite_phone
         FROM public.family_members fm
         LEFT JOIN public.users u ON u.id = fm.member_id
        WHERE fm.id = $1 AND fm.holder_id = $2`,
      [memberRowId, holderId],
    );
    if (!fm) {throw new NotFoundException('member_not_found');}
    const member = {
      id: memberRowId,
      name: fm.display_name ?? fm.invite_phone ?? 'Member',
      spent: fm.spent_credits,
      spendLimit: fm.spend_limit_credits,
    };
    if (!fm.member_id) {return {member, byFeature: [], transactions: []};}

    const lim = Math.max(1, Math.min(100, Math.floor(limit) || 50));
    const txns = await this.db.q<{
      id: string; type: string; amount_credits: number; description: string;
      booking_id: string | null; feature: string | null; created_at: Date;
    }>(
      `SELECT id, type, amount_credits, description, booking_id, feature, created_at
         FROM wallet_transactions
        WHERE user_id = $1 AND actor_user_id = $2 AND type IN ('payment','refund')
        ORDER BY created_at DESC
        LIMIT $3`,
      [holderId, fm.member_id, lim],
    );
    const byFeature = await this.db.q<{feature: string | null; spent: number; refunded: number; n: number}>(
      `SELECT feature,
              COALESCE(SUM(CASE WHEN amount_credits < 0 THEN -amount_credits ELSE 0 END), 0)::int AS spent,
              COALESCE(SUM(CASE WHEN amount_credits > 0 THEN amount_credits ELSE 0 END), 0)::int AS refunded,
              COUNT(*)::int AS n
         FROM wallet_transactions
        WHERE user_id = $1 AND actor_user_id = $2 AND type IN ('payment','refund')
        GROUP BY feature
        ORDER BY spent DESC`,
      [holderId, fm.member_id],
    );
    return {
      member,
      byFeature: byFeature.map(f => ({
        feature: f.feature ?? 'other',
        spent: f.spent,
        refunded: f.refunded,
        count: f.n,
      })),
      transactions: txns.map(t => ({
        id: t.id,
        type: (t.type === 'refund' ? 'refund' : 'payment') as 'payment' | 'refund',
        feature: t.feature,
        description: t.description,
        amount: t.amount_credits,
        bookingId: t.booking_id,
        at: t.created_at.toISOString(),
      })),
    };
  }

  /**
   * Credit-usage breakdown for the holder — a Claude-token-style view:
   * total family spend, per-member spend (+ cap + share %), and the recent
   * family-charged transactions from the wallet ledger.
   */
  async usage(holderId: string): Promise<{
    totalSpent: number;
    members: Array<{id: string; name: string; spent: number; spendLimit: number | null; sharePct: number}>;
    recent: Array<{name: string; credits: number; at: string; bookingId: string | null}>;
  }> {
    const members = await this.db.q<{
      id: string; member_id: string | null; invite_phone: string | null;
      spent_credits: number; spend_limit_credits: number | null; display_name: string | null;
    }>(
      `SELECT fm.id, fm.member_id, fm.invite_phone, fm.spent_credits, fm.spend_limit_credits, u.display_name
         FROM public.family_members fm
         LEFT JOIN public.users u ON u.id = fm.member_id
        WHERE fm.holder_id = $1 AND fm.status = 'active'`,
      [holderId],
    );
    const totalSpent = members.reduce((n, m) => n + (m.spent_credits || 0), 0);
    const memberOut = members.map(m => ({
      id: m.id,
      name: m.display_name ?? m.invite_phone ?? 'Member',
      spent: m.spent_credits,
      spendLimit: m.spend_limit_credits,
      sharePct: totalSpent > 0 ? Math.round((m.spent_credits / totalSpent) * 100) : 0,
    }));

    // Recent family-charged ledger rows on the holder's wallet, keyed on the
    // actor stamp (the old description LIKE-match silently missed every
    // escrow-path charge and could not name the member).
    const recent = await this.db.q<{
      amount_credits: number; created_at: Date; booking_id: string | null; display_name: string | null;
    }>(
      `SELECT wt.amount_credits, wt.created_at, wt.booking_id, u.display_name
         FROM wallet_transactions wt
         LEFT JOIN public.users u ON u.id = wt.actor_user_id
        WHERE wt.user_id = $1 AND wt.type = 'payment' AND wt.amount_credits < 0
          AND wt.actor_user_id IS NOT NULL AND wt.actor_user_id <> $1
          AND EXISTS (SELECT 1 FROM public.family_members fm
                       WHERE fm.holder_id = $1 AND fm.member_id = wt.actor_user_id)
        ORDER BY wt.created_at DESC LIMIT 20`,
      [holderId],
    );
    return {
      totalSpent,
      members: memberOut,
      recent: recent.map(r => ({
        name: r.display_name ?? 'Family member',
        credits: Math.abs(r.amount_credits),
        at: r.created_at.toISOString(),
        bookingId: r.booking_id,
      })),
    };
  }

  // MON-4 — the standalone recordSpend() bump was removed: it wrote spent_credits
  // UNLOCKED, and both live charge sites (booking.payWithCredits, dispatch escrow
  // accept) now bump it inline under a FOR UPDATE lock on the member row. A revived
  // unlocked helper would reopen the family-cap TOCTOU, so it is intentionally gone.

  /**
   * When a phone registers, attach any pending-by-phone invites to the new
   * user id (so they show up on that user's invites list). Called from the
   * registration flow.
   */
  async linkPendingInvitesByPhone(userId: string, phoneE164: string): Promise<void> {
    await this.db.q(
      `UPDATE public.family_members SET member_id = $1
        WHERE invite_phone = $2 AND status = 'pending' AND member_id IS NULL`,
      [userId, phoneE164],
    );
  }
}

function normalizeLimit(v: number | null | undefined): number | null {
  if (v === null || v === undefined) {return null;}
  if (!Number.isFinite(v) || v < 0) {return null;}
  return Math.floor(v);
}

function normalizeRelationship(v: string | null | undefined): string | null {
  const trimmed = v?.trim();
  return trimmed ? trimmed.slice(0, 40) : null;
}
