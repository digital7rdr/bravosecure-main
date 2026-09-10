import {Injectable, Logger, Optional} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';
import {SentryService} from '../observability/sentry.service';
import type {AdminContext} from './admin.guard';

// 'CLIENT' has been permitted by `ops_audit_actor_role_chk` since
// 20260509100000_phase2_data_integrity.sql; the union simply never caught up.
// Family quota decisions are taken by an account HOLDER — a customer, not ops
// staff — and recording those as 'SYSTEM' would have made the one column that
// answers "who did this?" useless for the only actions it now covers.
export type AuditActorRole = 'OPS' | 'SUPERVISOR' | 'ADMIN' | 'SYSTEM' | 'AGENT' | 'CLIENT';
export type AuditSubjectType =
  | 'booking' | 'mission' | 'agent' | 'job' | 'sos' | 'application'
  // Step 26 — system-wide ops actions (e.g. the runtime dispatch kill-switch flip).
  | 'system'
  // Audit fix 4.2 — PII reveal events (phone/email/address) so we have a
  // paper trail of which admin viewed which customer's contact info.
  | 'pii'
  // Audit fix 4.7 — ops reads of mission group threads (separate from
  // sends — every read is logged so cross-customer leakage is detectable).
  | 'conversation'
  // Audit F-14 — manual wallet adjustments record against the target USER
  // (both values already allowed by ops_audit_subject_type_chk).
  | 'user' | 'wallet';

export interface AuditEntry {
  actor_id?: string | null;
  actor_role: AuditActorRole;
  actor_call?: string | null;
  action: string;
  subject_type: AuditSubjectType;
  subject_id: string;
  metadata?: Record<string, unknown>;
  ip_address?: string | null;
}

export interface FeedEvent {
  kind: string;
  severity?: 'info' | 'ok' | 'warn' | 'err';
  actor?: string;
  subject?: string;
  message: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class OpsAuditService {
  private readonly log = new Logger(OpsAuditService.name);

  constructor(
    private readonly db: DatabaseService,
    // Audit fix 5.4 — optional Sentry hook for fail-closed audit
    // failures. @Optional so test fixtures that construct the service
    // directly (without the DI container) still work.
    @Optional() private readonly sentry?: SentryService,
  ) {}

  /**
   * Record an admin/system action into `ops_audit`.
   *
   * Audit fix 2.1 — by default this remains best-effort (audit failures
   * shouldn't strand a half-applied state change), BUT the action list
   * below names the "critical" actions where a missing audit row is
   * itself a security incident: approve / reject / dispatch / complete
   * / terminate / abort / SOS resolve. For those we re-throw so the
   * caller (already inside a transaction in Phase 1) ROLLBACKs the
   * state change. Result: a state mutation either commits with its
   * audit row or doesn't happen at all — there's no quiet drift.
   */
  private static readonly CRITICAL_ACTIONS = new Set<string>([
    'booking.approve', 'booking.reject', 'booking.dispatch', 'booking.complete',
    'agent.approve',   'agent.reject',   'agent.terminate',
    'mission.abort',   'mission.complete',
    'sos.ack',         'sos.resolve',    'sos.escalate',
    'wallet.payout',
    // A dispute resolution moves real money (paired escrow split + possible agency
    // clawback). It must commit with its audit row or roll back — fail-closed.
    'dispute.resolve',
    // Not a state mutation, but fail-closed by design (LB1): a `/dispatch/offers/:id/full`
    // read discloses the principal's exact pickup/dropoff. If we cannot record WHO read it,
    // we must NOT disclose it — so a failed audit insert here re-throws and the controller
    // 5xx's BEFORE returning the coordinates.
    'dispatch.full_read',
  ]);

  async record(entry: AuditEntry): Promise<void> {
    const isCritical = OpsAuditService.CRITICAL_ACTIONS.has(entry.action);
    try {
      await this.db.q(
        `INSERT INTO ops_audit
          (actor_id, actor_role, actor_call, action, subject_type, subject_id, metadata, ip_address)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
        [
          entry.actor_id ?? null,
          entry.actor_role,
          entry.actor_call ?? null,
          entry.action,
          entry.subject_type,
          entry.subject_id,
          JSON.stringify(entry.metadata ?? {}),
          entry.ip_address ?? null,
        ],
      );
    } catch (e) {
      const msg = (e as Error).message;
      this.log.warn(`audit insert failed for ${entry.action}: ${msg}`);
      if (isCritical) {
        // Audit fix 5.4 — fan the failure to Sentry BEFORE throwing so
        // the alert rule fires even if the transaction rollback path
        // swallows the exception further up. The shim is no-op when
        // SENTRY_DSN is unset, so dev/test boot stays silent.
        const failure = new Error(`audit_insert_failed:${entry.action}:${msg}`);
        this.sentry?.reportCriticalAuditFailure(entry.action, entry.subject_id, failure);
        // Fail-closed for critical actions. The caller's transaction
        // (or, lacking that, the caller itself) sees the throw and the
        // state change rolls back / surfaces a 5xx.
        throw failure;
      }
    }
  }

  /** Shorthand for admin-originated audit records. */
  recordAdmin(
    admin: AdminContext,
    action: string,
    subject_type: AuditSubjectType,
    subject_id: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    return this.record({
      actor_id: admin.user_id,
      actor_role: admin.role,
      actor_call: admin.call_sign,
      action, subject_type, subject_id, metadata,
    });
  }

  /** Emit an event to the live feed (used by the dashboard activity stream). */
  async emit(ev: FeedEvent): Promise<void> {
    try {
      await this.db.q(
        `INSERT INTO live_feed_events (kind, severity, actor, subject, message, metadata)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
        [
          ev.kind, ev.severity ?? 'info',
          ev.actor ?? null, ev.subject ?? null,
          ev.message, JSON.stringify(ev.metadata ?? {}),
        ],
      );
    } catch (e) {
      this.log.warn(`feed emit failed for ${ev.kind}: ${(e as Error).message}`);
    }
  }

  /** Last N audit entries for a subject — powers the mission/booking timeline. */
  listForSubject(subject_type: AuditSubjectType, subject_id: string, limit = 20) {
    return this.db.q(
      `SELECT id, actor_role, actor_call, action, metadata, created_at
         FROM ops_audit
        WHERE subject_type = $1 AND subject_id = $2
        ORDER BY created_at DESC
        LIMIT $3`,
      [subject_type, subject_id, limit],
    );
  }

  /** Recent activity feed across the whole system. */
  recentFeed(limit = 50) {
    return this.db.q(
      `SELECT id, kind, severity, actor, subject, message, metadata, created_at
         FROM live_feed_events
        ORDER BY created_at DESC
        LIMIT $1`,
      [limit],
    );
  }
}
