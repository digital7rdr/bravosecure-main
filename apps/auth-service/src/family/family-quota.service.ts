import {BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException} from '@nestjs/common';
import {DatabaseService, type Tx} from '../database/database.service';
import {BookingPushBridge} from '../ops/booking-push-bridge.service';
import {OpsAuditService} from '../ops/ops-audit.service';
import {
  classifyQuotaChange, normalizeCredits, remainingQuota, resolveApprovedAmount,
  thresholdToNotify, usageBand, validateQuotaChange, MAX_QUOTA_CREDITS,
} from './family-quota.util';

export type CreditRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired';

export interface CreditRequestDto {
  id:               string;
  familyRowId:      string;
  holderId:         string;
  memberId:         string;
  memberName:       string | null;
  requestedCredits: number;
  approvedCredits:  number | null;
  reason:           string | null;
  status:           CreditRequestStatus;
  decisionReason:   string | null;
  createdAt:        string;
  decidedAt:        string | null;
  expiresAt:        string;
}

export interface QuotaAuditDto {
  id:            string;
  action:        string;
  previousLimit: number | null;
  newLimit:      number | null;
  deltaCredits:  number | null;
  spentAtTime:   number;
  requestId:     string | null;
  reason:        string | null;
  actorId:       string | null;
  createdAt:     string;
}

interface MemberRow {
  id: string; holder_id: string; member_id: string | null; status: string;
  spend_limit_credits: number | null; spent_credits: number; quota_notified_pct: number;
}

/**
 * Family spending-quota control plane: quota changes, the member→root credit
 * request lifecycle, the audit trail and the usage-threshold warnings.
 *
 * ─── What this service deliberately does NOT do ────────────────────────────
 *
 * It does not move money and it does not gate spending. The actual debit — the
 * both-limits check, the row locks, the ledger write and the `spent_credits`
 * bump — already lives inside the single transaction in
 * `BookingService.payWithCredits` and the dispatch escrow accept, in that
 * order: `family_members FOR UPDATE` then `wallet_balances FOR UPDATE` (MON-4).
 * That lock order is a repo-wide invariant; every statement here that takes
 * both locks takes them in the same order, or two of these paths would
 * deadlock against a live charge.
 *
 * ─── Approval does NOT reserve root credit (spec §51) ──────────────────────
 *
 * Raising a member's quota raises a SPENDING LIMIT. It does not set aside any
 * of the holder's balance, so a holder with ৳1,000 may legitimately approve two
 * ৳800 requests: the sum of family quotas is allowed to exceed the root balance
 * (§24), and the root balance is enforced again, under a lock, at spend time
 * (§10). That is what makes `Root balance = -৳600` unreachable no matter how
 * fast the holder taps approve. The trade-off is that an approved quota is a
 * permission, not a guarantee of funds, and the member can still be told
 * ROOT_CREDIT_UNAVAILABLE afterwards.
 */
@Injectable()
export class FamilyQuotaService {
  private readonly log = new Logger(FamilyQuotaService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly push: BookingPushBridge,
    private readonly opsAudit: OpsAuditService,
  ) {}

  // ── Holder side: quota changes ───────────────────────────────────────────

  /**
   * Set (or clear) a member's spending quota — spec §18 and §19.
   *
   * Runs inside a transaction with the member row locked, for two reasons that
   * are both financial: the §19 floor is a check-then-write against
   * `spent_credits`, which a concurrent charge is bumping; and the audit row
   * must record the SAME "previous" value that was actually replaced. Reading
   * the row unlocked would let a charge land between the read and the write and
   * produce both a wrong decision and a lying audit entry.
   *
   * `limit === null` clears the quota (unlimited within the holder's balance).
   */
  async setQuota(
    holderId: string,
    memberRowId: string,
    limit: number | null,
    actorId: string,
    reason?: string | null,
  ): Promise<{ok: true; previousLimit: number | null; newLimit: number | null; spent: number; remaining: number | null}> {
    // null is a legitimate value (unlimited), so it is distinguished from a
    // malformed number BEFORE normalisation collapses both.
    let next: number | null;
    if (limit === null || limit === undefined) {
      next = null;
    } else if (limit === 0) {
      // Zero is a real quota — "this member may not spend" — and is the one
      // amount `normalizeCredits` rejects, because zero is never a valid
      // SPEND or REQUEST. Accepted here and nowhere else.
      next = 0;
    } else {
      next = normalizeCredits(limit);
      if (next === null) {throw new BadRequestException({code: 'INVALID_AMOUNT', message: 'invalid_quota'});}
    }

    const out = await this.db.withTransaction(async tx => {
      const row = await this.lockMember(tx, memberRowId, holderId);
      const spent = Number(row.spent_credits ?? 0);
      const previous = row.spend_limit_credits;

      const check = validateQuotaChange(next, spent);
      if (!check.ok) {
        // §19 / §44 — the UI needs the floor to render "cannot be reduced below
        // ৳4,500", so the minimum travels with the error rather than making the
        // client guess it from a separate round trip.
        throw new BadRequestException({
          code: 'QUOTA_BELOW_SPENT',
          message: 'quota_below_spent',
          minimumCredits: check.minimumCredits,
          spentCredits: spent,
        });
      }

      const {action, delta} = classifyQuotaChange(previous, next);
      await tx.q(
        `UPDATE public.family_members
            SET spend_limit_credits = $3, quota_notified_pct = $4
          WHERE id = $1 AND holder_id = $2`,
        // The band marker is re-seeded to the band the member now occupies: the
        // holder just read these numbers to make this change, so re-announcing
        // a band they knowingly moved the member into would be noise. Future
        // UPWARD crossings still fire.
        [memberRowId, holderId, next, usageBand(spent, next)],
      );
      await this.writeQuotaAudit(tx, {
        familyRowId: memberRowId, holderId, memberId: row.member_id, actorId,
        action, previousLimit: previous, newLimit: next, delta, spent, requestId: null,
        reason: reason ?? null,
      });
      return {previous, spent, memberId: row.member_id};
    });

    // Notifications and the ops trail are outside the transaction on purpose:
    // neither may roll back a committed quota change, and neither is allowed to
    // fail one (§33 is a courtesy, §37 is served by family_quota_audit above,
    // which IS transactional).
    void this.notifyQuotaChanged(out.memberId, memberRowId, holderId, actorId, out.previous, next, out.spent);

    return {
      ok: true, previousLimit: out.previous, newLimit: next, spent: out.spent,
      remaining: remainingQuota(out.spent, next),
    };
  }

  /** Append-only quota history for one member (§37). Holder-scoped. */
  async quotaHistory(holderId: string, memberRowId: string, limit = 50): Promise<QuotaAuditDto[]> {
    await this.assertHolderOwns(memberRowId, holderId);
    const rows = await this.db.q<{
      id: string; action: string; previous_limit: number | null; new_limit: number | null;
      delta_credits: number | null; spent_at_time: number; request_id: string | null;
      reason: string | null; actor_id: string | null; created_at: Date;
    }>(
      `SELECT id, action, previous_limit, new_limit, delta_credits, spent_at_time,
              request_id, reason, actor_id, created_at
         FROM public.family_quota_audit
        WHERE family_row_id = $1 AND holder_id = $2
        ORDER BY created_at DESC
        LIMIT $3`,
      [memberRowId, holderId, Math.min(Math.max(1, Math.floor(limit) || 50), 200)],
    );
    return rows.map(r => ({
      id: r.id, action: r.action, previousLimit: r.previous_limit, newLimit: r.new_limit,
      deltaCredits: r.delta_credits, spentAtTime: Number(r.spent_at_time ?? 0),
      requestId: r.request_id, reason: r.reason, actorId: r.actor_id,
      createdAt: r.created_at.toISOString(),
    }));
  }

  // ── Member side: asking for more ─────────────────────────────────────────

  /**
   * A member asks the holder for additional spending credit (§11).
   *
   * The membership is resolved from the AUTHENTICATED user id — the caller
   * never names their own member_id, holder_id or quota (§38), so a member
   * cannot file a request against someone else's family or on someone else's
   * behalf.
   */
  async requestCredit(
    memberUserId: string, requestedCredits: number, reason?: string | null,
  ): Promise<CreditRequestDto> {
    const credits = normalizeCredits(requestedCredits);
    if (credits === null) {
      throw new BadRequestException({code: 'INVALID_AMOUNT', message: 'invalid_amount'});
    }

    const membership = await this.db.qOne<MemberRow>(
      `SELECT id, holder_id, member_id, status, spend_limit_credits, spent_credits, quota_notified_pct
         FROM public.family_members
        WHERE member_id = $1 AND status = 'active'`,
      [memberUserId],
    );
    if (!membership) {throw new NotFoundException({code: 'NOT_A_FAMILY_MEMBER', message: 'not_a_family_member'});}

    await this.expireStale(this.db, membership.id);

    // §12 — the duplicate gate is the PARTIAL UNIQUE INDEX, not a preceding
    // SELECT. Two simultaneous taps both pass any check-then-insert; only one
    // can win an index. `ON CONFLICT … DO NOTHING` turns the loser into an
    // empty result instead of a 500, and the index predicate is repeated so
    // Postgres can infer the partial index.
    const inserted = await this.db.qOne<{id: string}>(
      `INSERT INTO public.family_credit_requests
         (family_row_id, holder_id, member_id, requested_credits, reason)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (family_row_id) WHERE status = 'pending' DO NOTHING
       RETURNING id`,
      [membership.id, membership.holder_id, memberUserId, credits, trimReason(reason)],
    );
    if (!inserted) {
      const existing = await this.findPending(membership.id);
      throw new BadRequestException({
        code: 'CREDIT_REQUEST_PENDING',
        message: 'credit_request_pending',
        // §42 — the UI must offer "View Request", not a second "Request More
        // Credit" button, so it needs the open request's id.
        requestId: existing?.id ?? null,
        requestedCredits: existing?.requestedCredits ?? null,
      });
    }

    void this.push.familyCreditRequested(membership.holder_id, inserted.id).catch(() => undefined);
    void this.opsAudit.record({
      actor_id: memberUserId, actor_role: 'CLIENT', action: 'CREDIT_REQUESTED',
      subject_type: 'user', subject_id: membership.holder_id,
      metadata: {family_row_id: membership.id, request_id: inserted.id, requested_credits: credits},
    }).catch(() => undefined);

    const dto = await this.getRequest(inserted.id);
    if (!dto) {throw new NotFoundException({code: 'REQUEST_NOT_FOUND', message: 'request_not_found'});}
    return dto;
  }

  /** The member's own request history (§39 — own rows only). */
  async myRequests(memberUserId: string, limit = 20): Promise<CreditRequestDto[]> {
    await this.expireStaleForMember(memberUserId);
    return this.listBy('member_id', memberUserId, limit);
  }

  /** Every request across the holder's family, newest first (§43). */
  async listRequests(holderId: string, limit = 50): Promise<CreditRequestDto[]> {
    await this.expireStaleForHolder(holderId);
    return this.listBy('holder_id', holderId, limit);
  }

  // ── Holder side: deciding ────────────────────────────────────────────────

  /**
   * Approve a request, in full or in part (§13, §14).
   *
   * Atomic by construction: the request row and the member row are both locked
   * before anything is written, so a double-tapped approve cannot apply the
   * same increase twice — the second attempt finds the status already
   * `approved` and is refused. The lock order is request → member, which never
   * collides with the charge path's member → wallet.
   */
  async approveRequest(
    holderId: string, requestId: string, approvedCredits?: number | null, reason?: string | null,
  ): Promise<{ok: true; requestId: string; approvedCredits: number; previousLimit: number | null; newLimit: number; partial: boolean}> {
    const out = await this.db.withTransaction(async tx => {
      const req = await this.lockRequest(tx, requestId, holderId);
      const approved = resolveApprovedAmount(req.requested_credits, approvedCredits);
      if (!approved.ok) {
        throw new BadRequestException({
          code: approved.code,
          message: approved.code === 'APPROVAL_EXCEEDS_REQUEST' ? 'approval_exceeds_request' : 'invalid_amount',
          requestedCredits: req.requested_credits,
        });
      }

      const row = await this.lockMember(tx, req.family_row_id, holderId);
      if (row.status !== 'active') {
        throw new BadRequestException({code: 'MEMBER_NOT_ACTIVE', message: 'member_not_active'});
      }
      const previous = row.spend_limit_credits;
      if (previous === null) {
        // Topping up an unlimited quota is meaningless — there is no ceiling to
        // raise. Refused rather than silently "approved" so the holder can
        // reject the request and the member gets an honest outcome.
        throw new BadRequestException({code: 'QUOTA_UNLIMITED', message: 'quota_already_unlimited'});
      }
      const spent = Number(row.spent_credits ?? 0);
      const nextLimit = previous + approved.credits;
      if (nextLimit > MAX_QUOTA_CREDITS) {
        throw new BadRequestException({code: 'QUOTA_LIMIT_REACHED', message: 'quota_limit_reached', maxCredits: MAX_QUOTA_CREDITS});
      }

      await tx.q(
        `UPDATE public.family_members
            SET spend_limit_credits = $3, quota_notified_pct = $4
          WHERE id = $1 AND holder_id = $2`,
        [req.family_row_id, holderId, nextLimit, usageBand(spent, nextLimit)],
      );
      await tx.q(
        `UPDATE public.family_credit_requests
            SET status = 'approved', approved_credits = $2, decided_by = $3,
                decided_at = NOW(), decision_reason = $4
          WHERE id = $1`,
        [requestId, approved.credits, holderId, trimReason(reason)],
      );
      // §13 — previous_quota, approved_amount, new_quota, approved_by,
      // approved_at and request_id all land in one audit row.
      await this.writeQuotaAudit(tx, {
        familyRowId: req.family_row_id, holderId, memberId: req.member_id, actorId: holderId,
        action: 'CREDIT_APPROVED', previousLimit: previous, newLimit: nextLimit,
        delta: approved.credits, spent, requestId, reason: trimReason(reason),
      });
      return {
        memberId: req.member_id, previous, nextLimit,
        credits: approved.credits, partial: approved.credits < req.requested_credits,
      };
    });

    void this.push.familyCreditDecided(
      out.memberId, requestId, out.partial ? 'partially_approved' : 'approved',
    ).catch(() => undefined);
    void this.opsAudit.record({
      actor_id: holderId, actor_role: 'CLIENT', action: 'CREDIT_APPROVED',
      subject_type: 'user', subject_id: out.memberId,
      metadata: {request_id: requestId, approved_credits: out.credits, new_quota: out.nextLimit, partial: out.partial},
    }).catch(() => undefined);

    return {
      ok: true, requestId, approvedCredits: out.credits,
      previousLimit: out.previous, newLimit: out.nextLimit, partial: out.partial,
    };
  }

  /** Reject a request (§15). The quota is NOT touched. */
  async rejectRequest(holderId: string, requestId: string, reason?: string | null): Promise<{ok: true}> {
    const memberId = await this.db.withTransaction(async tx => {
      const req = await this.lockRequest(tx, requestId, holderId);
      await tx.q(
        `UPDATE public.family_credit_requests
            SET status = 'rejected', decided_by = $2, decided_at = NOW(), decision_reason = $3
          WHERE id = $1`,
        [requestId, holderId, trimReason(reason)],
      );
      return req.member_id;
    });
    void this.push.familyCreditDecided(memberId, requestId, 'rejected').catch(() => undefined);
    void this.opsAudit.record({
      actor_id: holderId, actor_role: 'CLIENT', action: 'CREDIT_REJECTED',
      subject_type: 'user', subject_id: memberId, metadata: {request_id: requestId},
    }).catch(() => undefined);
    return {ok: true};
  }

  /**
   * Cancel a pending request (§16 holder, §17 member).
   *
   * One method for both sides because the rule is the same — only a PENDING
   * request can be cancelled, and a cancelled one can never later be approved
   * (`lockRequest` refuses any non-pending status). Authorisation is by
   * PARTICIPATION: the caller must be the request's holder or its member, which
   * is checked against the stored row, never against anything the client sent.
   */
  async cancelRequest(actorId: string, requestId: string): Promise<{ok: true}> {
    const out = await this.db.withTransaction(async tx => {
      const req = await tx.qOne<{
        id: string; holder_id: string; member_id: string; status: string; expires_at: Date;
      }>(
        `SELECT id, holder_id, member_id, status, expires_at
           FROM public.family_credit_requests WHERE id = $1 FOR UPDATE`,
        [requestId],
      );
      if (!req) {throw new NotFoundException({code: 'REQUEST_NOT_FOUND', message: 'request_not_found'});}
      if (req.holder_id !== actorId && req.member_id !== actorId) {
        // Not a 404: the row exists, the caller simply has no business with it.
        throw new ForbiddenException({code: 'FORBIDDEN', message: 'not_your_request'});
      }
      if (req.status !== 'pending') {
        throw new BadRequestException({code: 'REQUEST_NOT_PENDING', message: 'request_not_pending', status: req.status});
      }
      await tx.q(
        `UPDATE public.family_credit_requests
            SET status = 'cancelled', decided_by = $2, decided_at = NOW()
          WHERE id = $1`,
        [requestId, actorId],
      );
      return {holderId: req.holder_id, memberId: req.member_id, byHolder: req.holder_id === actorId};
    });

    // §33 — tell the OTHER party. A member cancelling notifies the holder (the
    // pending row is off their queue); a holder cancelling notifies the member.
    if (out.byHolder) {
      void this.push.familyCreditDecided(out.memberId, requestId, 'cancelled').catch(() => undefined);
    } else {
      void this.push.familyCreditRequested(out.holderId, requestId).catch(() => undefined);
    }
    return {ok: true};
  }

  // ── Usage thresholds ─────────────────────────────────────────────────────

  /**
   * Called AFTER a charge has committed: warn the holder if the member just
   * crossed 80 / 90 / 100% of their quota (§33, §34).
   *
   * Deliberately not part of the charge transaction. A notification is not
   * worth rolling a payment back for, and holding the member row's lock across
   * a Redis publish would lengthen the very critical section MON-4 exists to
   * keep short. The marker write is a conditional UPDATE rather than a
   * read-modify-write, so two concurrent charges cannot both announce the same
   * band: only the row that actually raises `quota_notified_pct` sends.
   */
  async notifyUsageThreshold(familyRowId: string): Promise<void> {
    try {
      const row = await this.db.qOne<MemberRow>(
        `SELECT id, holder_id, member_id, status, spend_limit_credits, spent_credits, quota_notified_pct
           FROM public.family_members WHERE id = $1`,
        [familyRowId],
      );
      if (!row || row.status !== 'active') {return;}
      const spent = Number(row.spent_credits ?? 0);
      const band = thresholdToNotify(spent, row.spend_limit_credits, Number(row.quota_notified_pct ?? 0));
      if (band === null) {return;}
      const claimed = await this.db.qOne<{id: string}>(
        `UPDATE public.family_members SET quota_notified_pct = $2
          WHERE id = $1 AND quota_notified_pct < $2 RETURNING id`,
        [familyRowId, band],
      );
      if (!claimed) {return;}
      await this.push.familyQuotaThreshold(row.holder_id, familyRowId, band);
    } catch (e) {
      this.log.warn(`threshold notify failed row=${familyRowId}: ${(e as Error).message}`);
    }
  }

  /**
   * Same as `notifyUsageThreshold`, addressed by MEMBER user id.
   *
   * The escrow-accept path does not carry the membership row id out of its
   * transaction — it has an early return through `settleWonOffer` — and
   * widening that return type to thread one id through would have touched a
   * second method on the Lite-booking critical path for a notification. The
   * charge itself required `status = 'active'`, so immediately after it commits
   * the active row IS the row that was charged. A no-op if the member has since
   * been revoked, which is the right outcome anyway.
   */
  async notifyUsageThresholdForMember(memberUserId: string): Promise<void> {
    try {
      const row = await this.db.qOne<{id: string}>(
        `SELECT id FROM public.family_members WHERE member_id = $1 AND status = 'active'`,
        [memberUserId],
      );
      if (row) {await this.notifyUsageThreshold(row.id);}
    } catch (e) {
      this.log.warn(`threshold notify (by member) failed: ${(e as Error).message}`);
    }
  }

  /**
   * Called after a REFUND has lowered `spent_credits`: re-arm the bands the
   * member has dropped back below (§26 — a refund raises remaining quota, so
   * the next genuine crossing must warn again). Lowering only; it never fires a
   * notification of its own.
   */
  async rearmUsageThreshold(familyRowId: string): Promise<void> {
    try {
      await this.db.q(
        `UPDATE public.family_members
            SET quota_notified_pct = CASE
              WHEN spend_limit_credits IS NULL OR spend_limit_credits <= 0 THEN quota_notified_pct
              WHEN spent_credits * 100 >= spend_limit_credits * 100 THEN 100
              WHEN spent_credits * 100 >= spend_limit_credits * 90  THEN 90
              WHEN spent_credits * 100 >= spend_limit_credits * 80  THEN 80
              ELSE 0 END
          WHERE id = $1`,
        [familyRowId],
      );
    } catch (e) {
      this.log.warn(`threshold re-arm failed row=${familyRowId}: ${(e as Error).message}`);
    }
  }

  // ── Lifecycle hooks ──────────────────────────────────────────────────────

  /**
   * §20 — the holder removed a member. Financial history is untouched (the
   * ledger and the audit trail are permanent); only the OPEN request is closed,
   * because a request against a membership that no longer exists can never be
   * legitimately approved.
   */
  async cancelPendingOnRevoke(familyRowId: string, actorId: string): Promise<void> {
    try {
      const rows = await this.db.q<{id: string; member_id: string}>(
        `UPDATE public.family_credit_requests
            SET status = 'cancelled', decided_by = $2, decided_at = NOW(),
                decision_reason = 'membership_revoked'
          WHERE family_row_id = $1 AND status = 'pending'
        RETURNING id, member_id`,
        [familyRowId, actorId],
      );
      for (const r of rows) {
        void this.push.familyCreditDecided(r.member_id, r.id, 'cancelled').catch(() => undefined);
      }
    } catch (e) {
      this.log.warn(`revoke request cleanup failed row=${familyRowId}: ${(e as Error).message}`);
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async lockMember(tx: Tx, memberRowId: string, holderId: string): Promise<MemberRow> {
    const row = await tx.qOne<MemberRow>(
      `SELECT id, holder_id, member_id, status, spend_limit_credits, spent_credits, quota_notified_pct
         FROM public.family_members
        WHERE id = $1 AND holder_id = $2
        FOR UPDATE`,
      [memberRowId, holderId],
    );
    // Scoped by holder_id in the WHERE, so a foreign member row is a 404 and
    // never leaks its existence to another family (§38, §40).
    if (!row) {throw new NotFoundException({code: 'MEMBER_NOT_FOUND', message: 'member_not_found'});}
    return row;
  }

  private async lockRequest(tx: Tx, requestId: string, holderId: string): Promise<{
    id: string; family_row_id: string; member_id: string; requested_credits: number; status: string; expires_at: Date;
  }> {
    const req = await tx.qOne<{
      id: string; family_row_id: string; member_id: string; requested_credits: number; status: string; expires_at: Date;
    }>(
      `SELECT id, family_row_id, member_id, requested_credits, status, expires_at
         FROM public.family_credit_requests
        WHERE id = $1 AND holder_id = $2
        FOR UPDATE`,
      [requestId, holderId],
    );
    if (!req) {throw new NotFoundException({code: 'REQUEST_NOT_FOUND', message: 'request_not_found'});}
    if (req.status !== 'pending') {
      // §16 — a cancelled request "cannot later be approved". The same check
      // makes approve/reject idempotent-safe under a double tap: the second
      // call sees the decided status and changes nothing.
      throw new BadRequestException({code: 'REQUEST_NOT_PENDING', message: 'request_not_pending', status: req.status});
    }
    if (req.expires_at.getTime() <= Date.now()) {
      // §50 — expiry is enforced at the decision point, not only by the lazy
      // sweep, so a request cannot be approved in the gap before a sweep runs.
      await tx.q(`UPDATE public.family_credit_requests SET status = 'expired' WHERE id = $1`, [requestId]);
      throw new BadRequestException({code: 'REQUEST_EXPIRED', message: 'request_expired'});
    }
    return req;
  }

  private async assertHolderOwns(memberRowId: string, holderId: string): Promise<void> {
    const row = await this.db.qOne<{id: string}>(
      `SELECT id FROM public.family_members WHERE id = $1 AND holder_id = $2`,
      [memberRowId, holderId],
    );
    if (!row) {throw new NotFoundException({code: 'MEMBER_NOT_FOUND', message: 'member_not_found'});}
  }

  private async writeQuotaAudit(tx: Tx, e: {
    familyRowId: string; holderId: string; memberId: string | null; actorId: string;
    action: string; previousLimit: number | null; newLimit: number | null;
    delta: number | null; spent: number; requestId: string | null; reason: string | null;
  }): Promise<void> {
    await tx.q(
      `INSERT INTO public.family_quota_audit
         (family_row_id, holder_id, member_id, actor_id, action,
          previous_limit, new_limit, delta_credits, spent_at_time, request_id, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [e.familyRowId, e.holderId, e.memberId, e.actorId, e.action,
       e.previousLimit, e.newLimit, e.delta, e.spent, e.requestId, e.reason],
    );
  }

  /** Flip PENDING rows past their expiry to EXPIRED (§50). Lazy — no cron. */
  private async expireStale(db: {q: DatabaseService['q']}, familyRowId: string): Promise<void> {
    await db.q(
      `UPDATE public.family_credit_requests SET status = 'expired'
        WHERE family_row_id = $1 AND status = 'pending' AND expires_at <= NOW()`,
      [familyRowId],
    ).catch(() => undefined);
  }

  private async expireStaleForHolder(holderId: string): Promise<void> {
    await this.db.q(
      `UPDATE public.family_credit_requests SET status = 'expired'
        WHERE holder_id = $1 AND status = 'pending' AND expires_at <= NOW()`,
      [holderId],
    ).catch(() => undefined);
  }

  private async expireStaleForMember(memberUserId: string): Promise<void> {
    await this.db.q(
      `UPDATE public.family_credit_requests SET status = 'expired'
        WHERE member_id = $1 AND status = 'pending' AND expires_at <= NOW()`,
      [memberUserId],
    ).catch(() => undefined);
  }

  private async findPending(familyRowId: string): Promise<{id: string; requestedCredits: number} | null> {
    const row = await this.db.qOne<{id: string; requested_credits: number}>(
      `SELECT id, requested_credits FROM public.family_credit_requests
        WHERE family_row_id = $1 AND status = 'pending'`,
      [familyRowId],
    );
    return row ? {id: row.id, requestedCredits: row.requested_credits} : null;
  }

  private async getRequest(id: string): Promise<CreditRequestDto | null> {
    const rows = await this.queryRequests(`r.id = $1`, [id], 1);
    return rows[0] ?? null;
  }

  private async listBy(column: 'holder_id' | 'member_id', id: string, limit: number): Promise<CreditRequestDto[]> {
    // `column` is a closed union, never client input — no interpolation risk.
    return this.queryRequests(`r.${column} = $1`, [id], Math.min(Math.max(1, Math.floor(limit) || 20), 100));
  }

  /**
   * `limit` is BOUND, not interpolated. It is a clamped integer at every call
   * site today, so interpolating would be safe right now — and that is exactly
   * the shape that stops being safe the first time someone threads a query
   * parameter into it. On a financial endpoint the parameterised form costs
   * nothing and removes the question.
   */
  private async queryRequests(where: string, params: unknown[], limit: number): Promise<CreditRequestDto[]> {
    const rows = await this.db.q<{
      id: string; family_row_id: string; holder_id: string; member_id: string;
      member_name: string | null; requested_credits: number; approved_credits: number | null;
      reason: string | null; status: CreditRequestStatus; decision_reason: string | null;
      created_at: Date; decided_at: Date | null; expires_at: Date;
    }>(
      `SELECT r.id, r.family_row_id, r.holder_id, r.member_id, u.display_name AS member_name,
              r.requested_credits, r.approved_credits, r.reason, r.status, r.decision_reason,
              r.created_at, r.decided_at, r.expires_at
         FROM public.family_credit_requests r
         LEFT JOIN public.users u ON u.id = r.member_id
        WHERE ${where}
        ORDER BY r.created_at DESC
        LIMIT $${params.length + 1}`,
      [...params, limit],
    );
    return rows.map(r => ({
      id: r.id, familyRowId: r.family_row_id, holderId: r.holder_id, memberId: r.member_id,
      memberName: r.member_name, requestedCredits: r.requested_credits,
      approvedCredits: r.approved_credits, reason: r.reason, status: r.status,
      decisionReason: r.decision_reason, createdAt: r.created_at.toISOString(),
      decidedAt: r.decided_at?.toISOString() ?? null, expiresAt: r.expires_at.toISOString(),
    }));
  }

  private notifyQuotaChanged(
    memberId: string | null, familyRowId: string, holderId: string, actorId: string,
    previous: number | null, next: number | null, spent: number,
  ): void {
    if (memberId) {
      void this.push.familyQuotaChanged(memberId, familyRowId).catch(() => undefined);
    }
    const {action, delta} = classifyQuotaChange(previous, next);
    void this.opsAudit.record({
      actor_id: actorId, actor_role: 'CLIENT', action,
      subject_type: 'user', subject_id: memberId ?? holderId,
      metadata: {family_row_id: familyRowId, previous_limit: previous, new_limit: next, delta_credits: delta, spent_at_time: spent},
    }).catch(() => undefined);
  }
}

function trimReason(v: string | null | undefined): string | null {
  const t = v?.trim();
  return t ? t.slice(0, 280) : null;
}
