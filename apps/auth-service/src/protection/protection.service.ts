import {
  BadRequestException, ConflictException, ForbiddenException, GoneException,
  Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';
import {OpsAuditService} from '../ops/ops-audit.service';
import {MissionEventsService} from '../ops/mission-events.service';
import {BookingPushBridge} from '../ops/booking-push-bridge.service';
import {type AdminContext} from '../ops/admin.guard';
import {isLive, LIVE_STATUS_SQL, type ProtectionSessionStatus} from './protection-session.fsm';
import {stalenessFor} from './protection.staleness';
import {
  LOCATION_RETENTION_DAYS, MAX_SESSION_DURATION_HOURS, NO_FIX_ACTIVATION_TIMEOUT_MIN,
} from './protection.constants';

// Raw row shape (raw SQL, no entity layer — matches the repo's Pro services).
export interface ProtectionSessionRow {
  id: string;
  application_id: string;
  customer_id: string;
  cpo_user_id: string;
  assignment_id: string;
  status: ProtectionSessionStatus;
  requested_at: string;
  activated_at: string | null;
  ended_at: string | null;
  end_reason: string | null;
  last_fix_at: string | null;
  sos_active: boolean;
  protect_activated_at: string | null;
  created_at: string;
  updated_at: string;
}

/** CPO identity a customer is allowed to see — name/callsign/avatar, NEVER the
 *  PMC mission code (that is the officer's gate credential). */
export interface SessionCpoIdentity {
  cpo_name: string | null;
  cpo_avatar: string | null;
  call_sign: string | null;
}

const SESSION_COLS = `
  id, application_id, customer_id, cpo_user_id, assignment_id, status,
  requested_at, activated_at, ended_at, end_reason, last_fix_at, sos_active,
  protect_activated_at, created_at, updated_at
`;

/**
 * Protection sessions — the on-demand live-tracking window layered on top of the
 * already-live Pro plan→assignment substrate (spec docs/planning/PROTECTION_SESSIONS_SPEC.md).
 *
 * This service owns the session FSM (§3) and the customer surface (§4):
 *   create → REQUESTED (or the existing live session, opened not errored),
 *   getCurrent, end (idempotent), history, and the three lazy sweeps
 *   (no-fix activation timeout, 12h max duration, coordinate retention).
 *
 * Location ingest (the REQUESTED→ACTIVE flip), the WS broadcasts, and the
 * CPO/Ops read surface land in the next unit (spec §15.2). The backend is the
 * single source of truth: a session is ACTIVE only after a real fix, never on
 * client optimism (edge N).
 */
@Injectable()
export class ProtectionService {
  private readonly log = new Logger(ProtectionService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly opsAudit: OpsAuditService,
    private readonly events: MissionEventsService,
    private readonly push: BookingPushBridge,
  ) {}

  // ─── Customer surface (self-access only) ─────────────────────────────────

  /**
   * Open a protection session against an ACTIVE plan. Validates, in order:
   * plan access (owner OR active linked member), plan ACTIVE, a covering
   * dedicated officer for TODAY (else 409 no_cpo_assigned + ops alert). A
   * unique-index race (23505 on protection_sessions_one_live_uq) returns the
   * EXISTING live session with `already_active: true` — edges C and M open the
   * session, they never error.
   */
  async create(userId: string, applicationId: string): Promise<{session: ProtectionSessionRow & Partial<SessionCpoIdentity>; already_active: boolean}> {
    await this.sweepRetention();
    const app = await this.assertPlanAccess(userId, applicationId);
    if (app.status !== 'ACTIVE') {throw new BadRequestException('plan_not_active');}

    const covering = await this.coveringAssignmentToday(applicationId);
    if (!covering) {
      void this.opsAudit.emit({
        kind: 'protection', severity: 'warn', subject: applicationId,
        message: 'Protection requested but no covering officer is assigned today',
      }).catch(() => undefined);
      throw new ConflictException('no_cpo_assigned');
    }

    try {
      const row = await this.db.qOne<ProtectionSessionRow>(
        `INSERT INTO public.protection_sessions
           (application_id, customer_id, cpo_user_id, assignment_id)
         VALUES ($1, $2, $3, $4)
         RETURNING ${SESSION_COLS}`,
        [applicationId, userId, covering.cpo_user_id, covering.assignment_id],
      );
      if (!row) {throw new BadRequestException('protection_session_insert_failed');}
      const cpo = await this.cpoIdentityFor(row.cpo_user_id, row.assignment_id);
      await this.recordEvent(row.id, 'created', {actorRole: 'customer', actorId: userId, newStatus: 'REQUESTED'});
      // CPO "automatic receive" (§10) — no acceptance step, just the wake.
      void this.push.psessionNew(row.cpo_user_id, row.id).catch(() => undefined);
      return {session: {...row, ...cpo}, already_active: false};
    } catch (e) {
      // 23505 on protection_sessions_one_live_uq — the customer already holds a
      // live session (possibly from another device / a double tap). OPEN it.
      if ((e as {code?: string}).code === '23505') {
        const existing = await this.liveSessionWithCpo(userId);
        if (existing) {return {session: existing, already_active: true};}
      }
      throw e;
    }
  }

  /** The caller's current live session (+ CPO identity + server clock), or 404. */
  async getCurrent(userId: string): Promise<{
    session: ProtectionSessionRow & SessionCpoIdentity;
    readiness: Record<string, unknown>; server_now: string;
  }> {
    await this.sweepStaleActivations();
    await this.sweepMaxDuration();
    const session = await this.liveSessionWithCpo(userId);
    if (!session) {throw new NotFoundException('no_active_session');}
    const readiness = await this.sessionReadiness(session.id);
    return {session, readiness, server_now: new Date().toISOString()};
  }

  /**
   * Customer ends their own session → COMPLETED (end_reason 'customer'). Idempotent:
   * a repeat call on an already-terminal session is a no-op that returns the row.
   * NEVER cascades to a linked SOS — the SOS stays live and is closed only by the
   * sos module's own lifecycle (§3 / rule 12).
   */
  async end(userId: string, sessionId: string): Promise<{session: ProtectionSessionRow}> {
    const owned = await this.db.qOne<ProtectionSessionRow>(
      `SELECT ${SESSION_COLS} FROM public.protection_sessions WHERE id = $1`,
      [sessionId],
    );
    if (!owned) {throw new NotFoundException('protection_session_not_found');}
    if (owned.customer_id !== userId) {throw new ForbiddenException('not_your_session');}
    if (!isLive(owned.status)) {return {session: owned};} // already COMPLETED/ABORTED

    const updated = await this.db.qOne<ProtectionSessionRow>(
      `UPDATE public.protection_sessions
          SET status = 'COMPLETED', ended_at = now(), end_reason = 'customer', updated_at = now()
        WHERE id = $1 AND status IN (${LIVE_STATUS_SQL})
        RETURNING ${SESSION_COLS}`,
      [sessionId],
    );
    if (!updated) {
      // Raced to a terminal state between the read and the write — return current.
      const current = await this.db.qOne<ProtectionSessionRow>(
        `SELECT ${SESSION_COLS} FROM public.protection_sessions WHERE id = $1`,
        [sessionId],
      );
      return {session: current ?? owned};
    }
    await this.recordEvent(sessionId, 'ended', {actorRole: 'customer', actorId: userId, prevStatus: owned.status, newStatus: 'COMPLETED', comment: 'Ended by customer'});
    return {session: updated};
  }

  /** Session history for the customer — times, CPO, SOS flag; NEVER coordinates (§9).
   *  Cursor-paginated (before = created_at). */
  async listHistory(userId: string, limit = 20, before?: string): Promise<{sessions: Array<Record<string, unknown>>}> {
    const cap = Math.min(Math.max(limit, 1), 100);
    const params: unknown[] = [userId];
    let where = 's.customer_id = $1';
    if (before) {params.push(before); where += ` AND s.created_at < $${params.length}`;}
    params.push(cap);
    const sessions = await this.db.q(
      `SELECT s.id, s.application_id, s.status, s.requested_at, s.activated_at,
              s.ended_at, s.end_reason, s.sos_active, s.protect_activated_at, s.created_at, s.cpo_user_id,
              u.display_name AS cpo_name, u.avatar_url AS cpo_avatar
         FROM public.protection_sessions s
         JOIN public.users u ON u.id = s.cpo_user_id
        WHERE ${where}
        ORDER BY s.created_at DESC
        LIMIT $${params.length}`,
      params,
    );
    return {sessions: sessions.map(r => ({...r, protection_status: this.protectionStatus(r as {protect_activated_at?: unknown; status: string})}))};
  }

  /**
   * Ingest a batch of the customer's OWN GPS fixes (edge E: batching = offline
   * catch-up). The FIRST accepted fix flips REQUESTED→ACTIVE — proof the stream
   * works, never optimism (edge N). Updates last_fix_at and broadcasts a
   * refetch-trigger to the CPO/Ops room (coordinates stay behind the audited
   * REST poll, §9). A straggler ping on an ended session gets 410.
   */
  async ingestLocations(
    userId: string, sessionId: string,
    fixes: Array<{lat: number; lng: number; accuracy_m?: number; recorded_at: string}>,
  ): Promise<{accepted: number; status: ProtectionSessionStatus; activated: boolean; waiting_for_readiness: boolean}> {
    const s = await this.db.qOne<{id: string; customer_id: string; status: ProtectionSessionStatus}>(
      `SELECT id, customer_id, status FROM public.protection_sessions WHERE id = $1`,
      [sessionId],
    );
    if (!s) {throw new NotFoundException('protection_session_not_found');}
    if (s.customer_id !== userId) {throw new ForbiddenException('not_your_session');}
    if (s.status !== 'REQUESTED' && s.status !== 'ACTIVE') {throw new GoneException('session_ended');}

    // Defense in depth on top of the DTO validators — drop non-finite /
    // out-of-range / null-island fixes (B-89 MG-12). Coordinates NEVER logged (§9).
    const valid = fixes.filter(f => isValidFix(f.lat, f.lng));
    if (valid.length === 0) {
      return {accepted: 0, status: s.status, activated: false, waiting_for_readiness: s.status === 'REQUESTED'};
    }

    await this.db.q(
      `INSERT INTO public.protection_session_locations
         (session_id, customer_id, lat, lng, accuracy_m, recorded_at)
       SELECT $1, $2, l, g, a, r
         FROM unnest($3::double precision[], $4::double precision[], $5::real[], $6::timestamptz[])
              AS t(l, g, a, r)`,
      [
        sessionId, userId,
        valid.map(f => f.lat), valid.map(f => f.lng),
        valid.map(f => (typeof f.accuracy_m === 'number' && Number.isFinite(f.accuracy_m) ? f.accuracy_m : null)),
        valid.map(f => f.recorded_at),
      ],
    );

    // A fix alone must NOT go live: BOTH sides have to be device-ready first
    // (founder 2026-08-11). The gate is evaluated inside the UPDATE so a
    // readiness flip racing this write can never produce a half-ready ACTIVE.
    const updated = await this.db.qOne<{status: ProtectionSessionStatus; both_ready: boolean}>(
      `WITH gate AS (
         SELECT count(*) FILTER (WHERE ready) = 2 AS both_ready
           FROM public.protection_session_readiness WHERE session_id = $1
       )
       UPDATE public.protection_sessions s
          SET last_fix_at = now(),
              status = CASE WHEN s.status = 'REQUESTED' AND g.both_ready THEN 'ACTIVE' ELSE s.status END,
              activated_at = CASE WHEN s.status = 'REQUESTED' AND g.both_ready THEN now() ELSE s.activated_at END,
              updated_at = now()
         FROM gate g
        WHERE s.id = $1 AND s.status IN ('REQUESTED','ACTIVE')
        RETURNING s.status, g.both_ready`,
      [sessionId],
    );
    if (!updated) {throw new GoneException('session_ended');} // raced to terminal between read + write

    const activated = s.status === 'REQUESTED' && updated.status === 'ACTIVE';
    // Trigger-to-refetch only — NO coordinates on the pub/sub lane (§4/§9).
    void this.events.broadcast(sessionId, 'psession.location', {ts: Date.now()}).catch(() => undefined);
    if (activated) {
      await this.recordEvent(sessionId, 'activated', {actorRole: 'system', prevStatus: 'REQUESTED', newStatus: 'ACTIVE'});
      void this.events.broadcast(sessionId, 'psession.status', {status: 'ACTIVE'}).catch(() => undefined);
      void this.push.psessionStarted(userId, sessionId).catch(() => undefined);
    }
    return {
      accepted: valid.length, status: updated.status, activated,
      waiting_for_readiness: updated.status === 'REQUESTED',
    };
  }

  // ─── Mission-start readiness (founder 2026-08-11) ─────────────────────────

  /**
   * A side reports what the OS actually told it. The apps never decide they are
   * "ready" — `ready` is a GENERATED column, so a client cannot flip it while a
   * requirement is false, and the activation gate reads this table.
   *
   * Reporting is idempotent (upsert on the session+role key) and safe at any
   * point in the session: a mid-mission revocation lands here too (edge case 6)
   * and immediately stops the session being counted as ready.
   */
  async reportReadiness(
    userId: string, sessionId: string, role: 'customer' | 'cpo',
    r: {
      location_permission: boolean; location_services: boolean;
      precise_location: boolean; connectivity: boolean;
      location_available: boolean; platform?: string;
    },
  ): Promise<Record<string, unknown>> {
    const s = await this.db.qOne<{
      id: string; customer_id: string; cpo_user_id: string;
      status: ProtectionSessionStatus; last_fix_at: string | null;
    }>(
      `SELECT id, customer_id, cpo_user_id, status, last_fix_at
         FROM public.protection_sessions WHERE id = $1`,
      [sessionId],
    );
    if (!s) {throw new NotFoundException('protection_session_not_found');}
    const owner = role === 'customer' ? s.customer_id : s.cpo_user_id;
    if (owner !== userId) {throw new ForbiddenException('not_your_session');}
    if (!isLive(s.status)) {throw new GoneException('session_ended');}

    const before = await this.db.qOne<{ready: boolean}>(
      `SELECT ready FROM public.protection_session_readiness
        WHERE session_id = $1 AND role = $2`,
      [sessionId, role],
    );

    await this.db.q(
      `INSERT INTO public.protection_session_readiness
         (session_id, role, user_id, location_permission, location_services,
          precise_location, connectivity, location_available, platform, reported_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
       ON CONFLICT (session_id, role) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         location_permission = EXCLUDED.location_permission,
         location_services   = EXCLUDED.location_services,
         precise_location    = EXCLUDED.precise_location,
         connectivity        = EXCLUDED.connectivity,
         location_available  = EXCLUDED.location_available,
         platform            = EXCLUDED.platform,
         reported_at         = now()`,
      [
        sessionId, role, userId,
        r.location_permission, r.location_services, r.precise_location,
        r.connectivity, r.location_available, r.platform ?? null,
      ],
    );

    // Edge case 11: whoever becomes ready LAST completes the pair — the other
    // side never repeats its setup. If a fix already arrived while we waited,
    // the session goes live right here instead of needing another one.
    const activated = await this.tryActivateWhenReady(sessionId);

    const readiness = await this.sessionReadiness(sessionId);
    const nowReady = (readiness.state as string) === 'READY';
    if (before?.ready !== undefined && before.ready && !nowReady) {
      // Capability LOST mid-session — a first-class timeline event so ops can
      // see which side dropped and when (edge case 6).
      await this.recordEvent(sessionId, 'readiness', {
        actorRole: role, actorId: userId,
        comment: `${role === 'cpo' ? 'CPO' : 'Customer'} lost location readiness`,
        visibility: 'all',
      });
    }
    void this.events.broadcast(sessionId, 'psession.readiness', {ts: Date.now()}).catch(() => undefined);
    return {readiness, activated};
  }

  /**
   * The deferred half of the gate: both sides ready AND a real fix already
   * banked → REQUESTED becomes ACTIVE. Same predicate as the ingest path, so
   * neither ordering of "ready" and "first fix" can strand a session.
   */
  private async tryActivateWhenReady(sessionId: string): Promise<boolean> {
    const updated = await this.db.qOne<{status: ProtectionSessionStatus}>(
      `UPDATE public.protection_sessions s
          SET status = 'ACTIVE', activated_at = now(), updated_at = now()
        WHERE s.id = $1 AND s.status = 'REQUESTED'
          AND s.last_fix_at IS NOT NULL
          AND (SELECT count(*) FILTER (WHERE ready) = 2
                 FROM public.protection_session_readiness WHERE session_id = $1)
        RETURNING s.status`,
      [sessionId],
    );
    if (!updated) {return false;}
    await this.recordEvent(sessionId, 'activated', {actorRole: 'system', prevStatus: 'REQUESTED', newStatus: 'ACTIVE'});
    void this.events.broadcast(sessionId, 'psession.status', {status: 'ACTIVE'}).catch(() => undefined);
    return true;
  }

  /**
   * Both sides' readiness + exactly what is missing, per side. Drives the
   * "Protection Setup Required" / "Mission Not Ready" screens and the ops view;
   * a side that has never reported is treated as not ready with everything
   * outstanding (never optimistic).
   */
  async sessionReadiness(sessionId: string): Promise<Record<string, unknown>> {
    const rows = await this.db.q<{
      role: 'customer' | 'cpo'; ready: boolean; location_permission: boolean;
      location_services: boolean; precise_location: boolean; connectivity: boolean;
      location_available: boolean; reported_at: string | null;
    }>(
      `SELECT role, ready, location_permission, location_services, precise_location,
              connectivity, location_available, reported_at
         FROM public.protection_session_readiness WHERE session_id = $1`,
      [sessionId],
    );
    const side = (role: 'customer' | 'cpo') => {
      const r = rows.find(x => x.role === role);
      const missing: string[] = [];
      if (!r?.location_permission) {missing.push('location_permission');}
      if (!r?.location_services) {missing.push('location_services');}
      if (!r?.precise_location) {missing.push('precise_location');}
      if (!r?.connectivity) {missing.push('connectivity');}
      if (!r?.location_available) {missing.push('location_available');}
      return {
        ready: Boolean(r?.ready), reported: Boolean(r),
        reported_at: r?.reported_at ?? null, missing,
      };
    };
    const customer = side('customer');
    const cpo = side('cpo');
    return {
      state: customer.ready && cpo.ready ? 'READY' : 'WAITING_FOR_READINESS',
      customer, cpo,
      blocked_by: [
        ...(customer.ready ? [] : ['customer']),
        ...(cpo.ready ? [] : ['cpo']),
      ],
    };
  }

  // ─── CPO surface (§6) — every query scoped to cpo_user_id = caller ────────

  /** Assigned customers today + any live session, with server-computed staleness. */
  async cpoOverview(cpoUserId: string): Promise<{customers: Array<Record<string, unknown>>; server_now: string}> {
    await this.sweepStaleActivations();
    await this.sweepMaxDuration();
    const rows = await this.db.q(
      `SELECT pca.id AS assignment_id, pca.application_id,
              pca.starts_on::text AS starts_on, pca.ends_on::text AS ends_on,
              pa.user_id AS owner_id, ow.display_name AS owner_name, ow.avatar_url AS owner_avatar,
              s.id AS session_id, s.status AS session_status, s.customer_id AS session_customer_id,
              s.activated_at, s.last_fix_at, s.sos_active,
              scu.display_name AS session_customer_name
         FROM public.pro_cpo_assignments pca
         JOIN public.pro_applications pa ON pa.id = pca.application_id
         JOIN public.users ow ON ow.id = pa.user_id
         LEFT JOIN LATERAL (
           SELECT id, status, customer_id, activated_at, last_fix_at, sos_active
             FROM public.protection_sessions ps
            WHERE ps.assignment_id = pca.id AND ps.status IN (${LIVE_STATUS_SQL})
            ORDER BY ps.created_at DESC LIMIT 1
         ) s ON TRUE
         LEFT JOIN public.users scu ON scu.id = s.customer_id
        WHERE pca.cpo_user_id = $1 AND pca.status = 'ASSIGNED'
          AND CURRENT_DATE BETWEEN pca.starts_on AND pca.ends_on
        ORDER BY (s.id IS NOT NULL) DESC, ow.display_name
        LIMIT 200`,
      [cpoUserId],
    );
    const now = Date.now();
    const customers = rows.map(r => ({
      ...r,
      staleness: r.session_id ? stalenessFor(r.last_fix_at as string | null, now) : null,
    }));
    return {customers, server_now: new Date(now).toISOString()};
  }

  /** Full live view of ONE session (customer, latest fix + age, trail). Audited; 403 unless owned. */
  async cpoSessionDetail(cpoUserId: string, sessionId: string): Promise<Record<string, unknown>> {
    const session = await this.assertCpoOwnsSession(cpoUserId, sessionId);
    await this.writeAccessAudit(cpoUserId, 'cpo', sessionId, 'view_live');
    const trail = await this.sessionTrail(sessionId, 120);
    const cpoTrail = await this.sessionTrail(sessionId, 120, undefined, 'cpo');
    const notes = await this.sessionNotes(sessionId);
    const readiness = await this.sessionReadiness(sessionId);
    const now = Date.now();
    return {
      session,
      staleness: stalenessFor((session.last_fix_at as string | null) ?? null, now),
      trail,
      cpo_trail: cpoTrail,
      notes,
      readiness,
      server_now: new Date(now).toISOString(),
    };
  }

  /**
   * Officer streams THEIR OWN location during a session (subject='cpo'), so ops
   * can render client / CPO / combined maps. Scoped: only the session's officer
   * may write, and the row carries the session's customer_id for the §9 scope.
   */
  async ingestCpoLocations(
    cpoUserId: string, sessionId: string,
    fixes: Array<{lat: number; lng: number; accuracy_m?: number; recorded_at: string}>,
  ): Promise<{accepted: number}> {
    const s = await this.assertCpoOwnsSession(cpoUserId, sessionId);
    if (!isLive(String(s.status))) {throw new GoneException('session_ended');}
    const valid = fixes.filter(f => isValidFix(f.lat, f.lng));
    if (valid.length === 0) {return {accepted: 0};}
    await this.db.q(
      `INSERT INTO public.protection_session_locations
         (session_id, subject, customer_id, lat, lng, accuracy_m, recorded_at)
       SELECT $1, 'cpo', $2, l, g, a, r
         FROM unnest($3::double precision[], $4::double precision[], $5::real[], $6::timestamptz[])
              AS t(l, g, a, r)`,
      [
        sessionId, s.customer_id as string,
        valid.map(f => f.lat), valid.map(f => f.lng),
        valid.map(f => (typeof f.accuracy_m === 'number' && Number.isFinite(f.accuracy_m) ? f.accuracy_m : null)),
        valid.map(f => f.recorded_at),
      ],
    );
    void this.events.broadcast(sessionId, 'psession.location', {ts: Date.now(), subject: 'cpo'}).catch(() => undefined);
    return {accepted: valid.length};
  }

  /** Poll-fallback trail (WS is primary). Audited; 403 unless owned. */
  async cpoSessionLocations(
    cpoUserId: string, sessionId: string, since?: string,
  ): Promise<{fixes: Array<Record<string, unknown>>; server_now: string}> {
    await this.assertCpoOwnsSession(cpoUserId, sessionId);
    await this.writeAccessAudit(cpoUserId, 'cpo', sessionId, 'view_history');
    const fixes = await this.sessionTrail(sessionId, 200, since);
    return {fixes, server_now: new Date().toISOString()};
  }

  // ─── Ops surface (§8) — AdminGuard + role enforced at the controller ──────

  /**
   * Monitoring / history list with combinable filters (§4/§6): status
   * (undefined|'live' → live set · 'all' → everything · else exact), cpo, user,
   * and a created-at date range. Server-side filtered + capped (§8).
   */
  async opsListSessions(f: {status?: string; cpoUserId?: string; customerId?: string; from?: string; to?: string; limit?: number} = {}): Promise<{sessions: Array<Record<string, unknown>>; server_now: string}> {
    // Cheap status sweeps only — the retention DELETE runs on the low-frequency
    // create() path, never on this 2s ops poll (§8 SWR) which would re-scan
    // protection_session_locations every tick.
    await this.sweepStaleActivations();
    await this.sweepMaxDuration();
    const params: unknown[] = [];
    const conds: string[] = [];
    if (!f.status || f.status === 'live') {conds.push(`s.status IN (${LIVE_STATUS_SQL})`);}
    else if (f.status !== 'all') {params.push(f.status); conds.push(`s.status = $${params.length}`);}
    if (f.cpoUserId) {params.push(f.cpoUserId); conds.push(`s.cpo_user_id = $${params.length}`);}
    if (f.customerId) {params.push(f.customerId); conds.push(`s.customer_id = $${params.length}`);}
    if (f.from) {params.push(f.from); conds.push(`s.created_at >= $${params.length}`);}
    if (f.to) {params.push(f.to); conds.push(`s.created_at < $${params.length}`);}
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const cap = Math.min(Math.max(f.limit ?? 200, 1), 500);
    params.push(cap);
    const rows = await this.db.q(
      `SELECT s.id, s.application_id, s.status, s.customer_id, s.cpo_user_id,
              s.requested_at, s.activated_at, s.ended_at, s.end_reason, s.last_fix_at, s.sos_active,
              s.protect_activated_at, s.created_at,
              cu.display_name AS customer_name, co.display_name AS cpo_name
         FROM public.protection_sessions s
         JOIN public.users cu ON cu.id = s.customer_id
         JOIN public.users co ON co.id = s.cpo_user_id
         ${where}
        ORDER BY s.created_at DESC
        LIMIT $${params.length}`,
      params,
    );
    const now = Date.now();
    const sessions = rows.map(r => ({
      ...r,
      staleness: stalenessFor(r.last_fix_at as string | null, now),
      protection_status: this.protectionStatus(r as {protect_activated_at?: unknown; status: string}),
    }));
    return {sessions, server_now: new Date(now).toISOString()};
  }

  /** Session detail + full trail (audited). */
  async opsSessionDetail(admin: AdminContext, sessionId: string): Promise<Record<string, unknown>> {
    const session = await this.db.qOne(
      `SELECT ${prefixCols('s')},
              cu.display_name AS customer_name, co.display_name AS cpo_name
         FROM public.protection_sessions s
         JOIN public.users cu ON cu.id = s.customer_id
         JOIN public.users co ON co.id = s.cpo_user_id
        WHERE s.id = $1`,
      [sessionId],
    );
    if (!session) {throw new NotFoundException('protection_session_not_found');}
    await this.writeAccessAudit(admin.user_id, 'ops', sessionId, 'view_history');
    const trail = await this.sessionTrail(sessionId, 200);
    const cpoTrail = await this.sessionTrail(sessionId, 200, undefined, 'cpo');
    const notes = await this.sessionNotes(sessionId);
    const readiness = await this.sessionReadiness(sessionId);
    const now = Date.now();
    return {
      session,
      staleness: stalenessFor((session.last_fix_at as string | null) ?? null, now),
      trail,
      cpo_trail: cpoTrail,
      notes,
      readiness,
      server_now: new Date(now).toISOString(),
    };
  }

  /** Ops end (end_reason 'ops'). Idempotent. The reason text is audited by the controller. */
  async opsEnd(admin: AdminContext, sessionId: string): Promise<{session: ProtectionSessionRow}> {
    const owned = await this.getById(sessionId);
    if (!owned) {throw new NotFoundException('protection_session_not_found');}
    if (!isLive(owned.status)) {return {session: owned};}
    const updated = await this.db.qOne<ProtectionSessionRow>(
      `UPDATE public.protection_sessions
          SET status = 'COMPLETED', ended_at = now(), end_reason = 'ops', updated_at = now()
        WHERE id = $1 AND status IN (${LIVE_STATUS_SQL})
        RETURNING ${SESSION_COLS}`,
      [sessionId],
    );
    const final = updated ?? owned;
    if (updated) {await this.recordEvent(sessionId, 'ended', {actorRole: 'ops', actorId: admin.user_id, prevStatus: owned.status, newStatus: 'COMPLETED', comment: 'Ended by operations'});}
    void this.events.broadcast(sessionId, 'psession.status', {status: final.status}).catch(() => undefined);
    void this.push.psessionEnded(final.customer_id, sessionId).catch(() => undefined);
    return {session: final};
  }

  /**
   * Edge J — the ONLY way session responsibility moves. Re-pins cpo_user_id (and
   * assignment_id when the new officer has a covering dedication today). Audited +
   * notified by the controller. Never a silent transfer (§6).
   */
  async opsTransfer(
    admin: AdminContext, sessionId: string, newCpoUserId: string,
  ): Promise<{session: ProtectionSessionRow; previous_cpo_user_id: string}> {
    const s = await this.getById(sessionId);
    if (!s) {throw new NotFoundException('protection_session_not_found');}
    if (!isLive(s.status)) {throw new BadRequestException('session_not_live');}
    if (s.cpo_user_id === newCpoUserId) {throw new BadRequestException('already_assigned_to_cpo');}
    const newCpo = await this.db.qOne<{status: string}>(
      `SELECT status FROM public.agents WHERE user_id = $1 AND type = 'cpo'`,
      [newCpoUserId],
    );
    if (!newCpo) {throw new NotFoundException('cpo_not_found');}
    const covering = await this.coveringAssignmentForCpoToday(s.application_id, newCpoUserId);
    const newAssignmentId = covering?.assignment_id ?? s.assignment_id;
    const updated = await this.db.qOne<ProtectionSessionRow>(
      `UPDATE public.protection_sessions
          SET cpo_user_id = $2, assignment_id = $3, updated_at = now()
        WHERE id = $1 AND status IN (${LIVE_STATUS_SQL})
        RETURNING ${SESSION_COLS}`,
      [sessionId, newCpoUserId, newAssignmentId],
    );
    if (!updated) {throw new BadRequestException('session_not_live');}
    // §2 — the timeline keeps BOTH officers: the departing officer's events stay
    // (actor_id preserved) and this row marks the handover.
    await this.recordEvent(sessionId, 'reassigned', {actorRole: 'ops', actorId: admin.user_id, comment: 'Protection officer reassigned'});
    void this.events.broadcast(sessionId, 'psession.status', {status: updated.status}).catch(() => undefined);
    void this.push.proCpoChanged(updated.customer_id, updated.application_id).catch(() => undefined);
    void this.push.psessionNew(newCpoUserId, sessionId).catch(() => undefined);
    return {session: updated, previous_cpo_user_id: s.cpo_user_id};
  }

  // ─── In-session notes (customer predefined/comment one-way; officer reply) ──

  /** Customer posts a note (predefined option or free comment) to their officer. */
  async postCustomerNote(userId: string, sessionId: string, body: string): Promise<{note: Record<string, unknown>}> {
    const s = await this.getById(sessionId);
    if (!s) {throw new NotFoundException('protection_session_not_found');}
    if (s.customer_id !== userId) {throw new ForbiddenException('not_your_session');}
    const note = await this.insertNote(sessionId, 'customer', body);
    await this.recordEvent(sessionId, 'note', {actorRole: 'customer', actorId: userId, comment: String(note.body ?? body)});
    return {note};
  }

  /** Customer reads the note thread for their own session. */
  async listCustomerNotes(userId: string, sessionId: string): Promise<{notes: Array<Record<string, unknown>>}> {
    const s = await this.getById(sessionId);
    if (!s) {throw new NotFoundException('protection_session_not_found');}
    if (s.customer_id !== userId) {throw new ForbiddenException('not_your_session');}
    return {notes: await this.sessionNotes(sessionId)};
  }

  /** Officer replies on a session they own. */
  async postCpoNote(cpoUserId: string, sessionId: string, body: string): Promise<{note: Record<string, unknown>}> {
    await this.assertCpoOwnsSession(cpoUserId, sessionId);
    const note = await this.insertNote(sessionId, 'cpo', body);
    await this.recordEvent(sessionId, 'note', {actorRole: 'cpo', actorId: cpoUserId, comment: String(note.body ?? body)});
    return {note};
  }

  /**
   * CPO Protect — the officer formally engages protection. Idempotent + one-time
   * (a double-tap or a second officer activates only once, via the protect_activated_at
   * IS NULL guard). Records an activity note, notifies ops, broadcasts. Blocked once
   * the session is no longer live.
   */
  async cpoActivateProtect(cpoUserId: string, sessionId: string): Promise<{protect_activated_at: string | null; already: boolean}> {
    const s = await this.assertCpoOwnsSession(cpoUserId, sessionId);
    if (!isLive(String(s.status))) {throw new BadRequestException('session_not_live');}
    if (s.protect_activated_at) {return {protect_activated_at: String(s.protect_activated_at), already: true};}
    const updated = await this.db.qOne<{protect_activated_at: string}>(
      `UPDATE public.protection_sessions
          SET protect_activated_at = now(), updated_at = now()
        WHERE id = $1 AND status IN (${LIVE_STATUS_SQL}) AND protect_activated_at IS NULL
        RETURNING protect_activated_at`,
      [sessionId],
    );
    if (!updated) {
      const cur = await this.getById(sessionId);
      return {protect_activated_at: cur?.protect_activated_at ?? null, already: true};
    }
    await this.insertNote(sessionId, 'cpo', 'Protection activated by officer').catch(() => undefined);
    await this.recordEvent(sessionId, 'protect', {actorRole: 'cpo', actorId: cpoUserId, comment: 'Protection activated'});
    void this.opsAudit.emit({kind: 'protection', severity: 'ok', subject: sessionId, message: 'CPO Protect activated'}).catch(() => undefined);
    void this.events.broadcast(sessionId, 'psession.status', {protect: true}).catch(() => undefined);
    return {protect_activated_at: updated.protect_activated_at, already: false};
  }

  private async insertNote(sessionId: string, sender: 'customer' | 'cpo', body: string): Promise<Record<string, unknown>> {
    const clean = body.trim().slice(0, 500);
    if (!clean) {throw new BadRequestException('empty_note');}
    const note = await this.db.qOne<Record<string, unknown>>(
      `INSERT INTO public.protection_session_notes (session_id, sender, body)
       VALUES ($1, $2, $3)
       RETURNING id, sender, body, created_at`,
      [sessionId, sender, clean],
    );
    void this.events.broadcast(sessionId, 'psession.note', {sender}).catch(() => undefined);
    return note ?? {};
  }

  private sessionNotes(sessionId: string): Promise<Array<Record<string, unknown>>> {
    return this.db.q(
      `SELECT id, sender, body, created_at
         FROM public.protection_session_notes
        WHERE session_id = $1
        ORDER BY created_at ASC
        LIMIT 200`,
      [sessionId],
    );
  }

  // ─── Mission History — one canonical append-only timeline (§5/§8) ─────────

  /** Append-only event. Best-effort — never breaks the transition it records. */
  private async recordEvent(sessionId: string, eventType: string, o: {
    actorId?: string | null; actorRole: 'customer' | 'cpo' | 'ops' | 'system';
    prevStatus?: string | null; newStatus?: string | null; comment?: string | null;
    visibility?: 'all' | 'internal';
  }): Promise<void> {
    try {
      await this.db.q(
        `INSERT INTO public.protection_session_events
           (session_id, event_type, actor_id, actor_role, prev_status, new_status, comment, visibility)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [sessionId, eventType, o.actorId ?? null, o.actorRole, o.prevStatus ?? null,
         o.newStatus ?? null, o.comment ?? null, o.visibility ?? 'all'],
      );
    } catch (e) {
      this.log.warn(`event record failed (${eventType}): ${(e as Error).message}`);
    }
  }

  /** Protection status (distinct from mission status, §9). */
  private protectionStatus(s: {protect_activated_at?: unknown; status: string}): 'not_activated' | 'active' | 'ended' {
    if (!s.protect_activated_at) {return 'not_activated';}
    return isLive(s.status) ? 'active' : 'ended';
  }

  /** Role-filtered, cursor-paginated timeline. Newest-first by seq (deterministic). */
  private timelineRows(
    sessionId: string, role: 'customer' | 'cpo' | 'ops', limit: number, beforeSeq?: number,
  ): Promise<Array<Record<string, unknown>>> {
    const cap = Math.min(Math.max(limit, 1), 200);
    const params: unknown[] = [sessionId];
    let where = 'session_id = $1';
    if (role === 'customer') {where += ` AND visibility = 'all'`;} // §7 — internal never reaches the user
    if (beforeSeq != null && Number.isFinite(beforeSeq)) {params.push(beforeSeq); where += ` AND seq < $${params.length}`;}
    params.push(cap);
    return this.db.q(
      `SELECT id, seq::text AS seq, event_type, actor_role, prev_status, new_status, comment, created_at
         FROM public.protection_session_events
        WHERE ${where}
        ORDER BY seq DESC
        LIMIT $${params.length}`,
      params,
    );
  }

  /** Customer reads their own session's timeline (visibility='all' only). */
  async customerTimeline(userId: string, sessionId: string, limit = 50, beforeSeq?: number): Promise<Record<string, unknown>> {
    const s = await this.getById(sessionId);
    if (!s) {throw new NotFoundException('protection_session_not_found');}
    if (s.customer_id !== userId) {throw new ForbiddenException('not_your_session');}
    return {
      events: await this.timelineRows(sessionId, 'customer', limit, beforeSeq),
      mission_status: s.status,
      protection_status: this.protectionStatus(s),
    };
  }

  /** CPO reads a session they own (full operational timeline). */
  async cpoTimeline(cpoUserId: string, sessionId: string, limit = 50, beforeSeq?: number): Promise<Record<string, unknown>> {
    const s = await this.assertCpoOwnsSession(cpoUserId, sessionId);
    return {
      events: await this.timelineRows(sessionId, 'cpo', limit, beforeSeq),
      mission_status: String(s.status),
      protection_status: this.protectionStatus(s as {protect_activated_at?: unknown; status: string}),
    };
  }

  /** Ops reads the full audit timeline (audited). */
  async opsTimeline(admin: AdminContext, sessionId: string, limit = 100, beforeSeq?: number): Promise<Record<string, unknown>> {
    const s = await this.getById(sessionId);
    if (!s) {throw new NotFoundException('protection_session_not_found');}
    await this.writeAccessAudit(admin.user_id, 'ops', sessionId, 'view_history');
    return {
      events: await this.timelineRows(sessionId, 'ops', limit, beforeSeq),
      mission_status: s.status,
      protection_status: this.protectionStatus(s),
    };
  }

  /**
   * CPO mission history — sessions ever assigned to this officer (incl. after a
   * reassignment: the events table carries the reassignment, but the session's
   * current cpo_user_id is the live owner; past officers still see their events).
   * Cursor-paginated by created_at.
   */
  async cpoHistory(cpoUserId: string, limit = 20, before?: string): Promise<{sessions: Array<Record<string, unknown>>}> {
    const cap = Math.min(Math.max(limit, 1), 100);
    const params: unknown[] = [cpoUserId];
    let where = `(s.cpo_user_id = $1 OR EXISTS (
        SELECT 1 FROM public.protection_session_events e
         WHERE e.session_id = s.id AND e.actor_id = $1 AND e.actor_role = 'cpo'))`;
    if (before) {params.push(before); where += ` AND s.created_at < $${params.length}`;}
    params.push(cap);
    const sessions = await this.db.q(
      `SELECT s.id, s.status, s.requested_at, s.activated_at, s.ended_at, s.end_reason,
              s.protect_activated_at, s.sos_active, s.created_at,
              cu.display_name AS customer_name
         FROM public.protection_sessions s
         JOIN public.users cu ON cu.id = s.customer_id
        WHERE ${where}
        ORDER BY s.created_at DESC
        LIMIT $${params.length}`,
      params,
    );
    return {sessions: sessions.map(r => ({...r, protection_status: this.protectionStatus(r as {protect_activated_at?: unknown; status: string})}))};
  }

  // ─── Lazy sweeps (same pattern as sweepExpired / sweepAssignments) ────────

  /** REQUESTED with no fix past the activation window → ABORTED + ops alert (§3). */
  private async sweepStaleActivations(): Promise<void> {
    try {
      await this.db.q(
        `WITH flipped AS (
           UPDATE public.protection_sessions
              SET status = 'ABORTED', ended_at = now(),
                  end_reason = 'failed_activation', updated_at = now()
            WHERE status = 'REQUESTED' AND last_fix_at IS NULL
              AND requested_at < now() - make_interval(mins => ${NO_FIX_ACTIVATION_TIMEOUT_MIN})
            RETURNING id),
         feed AS (
           INSERT INTO public.live_feed_events (kind, severity, subject, message)
           SELECT 'protection', 'warn', id::text,
                  'Protection session aborted — no location received within the activation window'
             FROM flipped)
         INSERT INTO public.protection_session_events (session_id, event_type, actor_role, prev_status, new_status, comment)
         SELECT id, 'aborted', 'system', 'REQUESTED', 'ABORTED',
                'No location received within the activation window'
           FROM flipped`,
      );
    } catch (e) {
      this.log.warn(`stale-activation sweep failed: ${(e as Error).message}`);
    }
  }

  /** ACTIVE past the max-duration cap → COMPLETED (end_reason 'timeout') + ops alert (§3). */
  private async sweepMaxDuration(): Promise<void> {
    try {
      await this.db.q(
        `WITH flipped AS (
           UPDATE public.protection_sessions
              SET status = 'COMPLETED', ended_at = now(),
                  end_reason = 'timeout', updated_at = now()
            WHERE status = 'ACTIVE'
              AND activated_at < now() - make_interval(hours => ${MAX_SESSION_DURATION_HOURS})
            RETURNING id),
         feed AS (
           INSERT INTO public.live_feed_events (kind, severity, subject, message)
           SELECT 'protection', 'warn', id::text,
                  'Protection session auto-ended — ${MAX_SESSION_DURATION_HOURS}h maximum duration reached'
             FROM flipped)
         INSERT INTO public.protection_session_events (session_id, event_type, actor_role, prev_status, new_status, comment)
         SELECT id, 'timeout', 'system', 'ACTIVE', 'COMPLETED',
                '${MAX_SESSION_DURATION_HOURS}h maximum duration reached'
           FROM flipped`,
      );
    } catch (e) {
      this.log.warn(`max-duration sweep failed: ${(e as Error).message}`);
    }
  }

  /** Prune coordinates older than the retention horizon (§9). Sessions + audit kept. */
  private async sweepRetention(): Promise<void> {
    try {
      await this.db.q(
        `DELETE FROM public.protection_session_locations
          WHERE received_at < now() - make_interval(days => ${LOCATION_RETENTION_DAYS})`,
      );
    } catch (e) {
      this.log.warn(`retention sweep failed: ${(e as Error).message}`);
    }
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  /**
   * Owner OR an ACTIVE (non-held) linked member of the owner may act on the
   * plan. Mirrors ProApplicationsService.assertPlanAccess — kept in sync
   * deliberately (a shared export would drag WalletModule into this module).
   */
  private async assertPlanAccess(userId: string, applicationId: string): Promise<{id: string; user_id: string; status: string}> {
    const app = await this.db.qOne<{id: string; user_id: string; status: string}>(
      `SELECT id, user_id, status FROM public.pro_applications WHERE id = $1`,
      [applicationId],
    );
    if (!app) {throw new NotFoundException('pro_application_not_found');}
    if (app.user_id !== userId) {
      const member = await this.db.qOne<{id: string}>(
        `SELECT id FROM public.family_members
          WHERE member_id = $1 AND holder_id = $2 AND status = 'active'
            AND (held_until IS NULL OR held_until <= NOW())`,
        [userId, app.user_id],
      );
      if (!member) {throw new ForbiddenException('not_your_application');}
    }
    return app;
  }

  /** The dedicated officer covering TODAY for this plan (the session's CPO). */
  private async coveringAssignmentToday(applicationId: string): Promise<{assignment_id: string; cpo_user_id: string} | null> {
    return this.db.qOne<{assignment_id: string; cpo_user_id: string}>(
      `SELECT id AS assignment_id, cpo_user_id
         FROM public.pro_cpo_assignments
        WHERE application_id = $1 AND status = 'ASSIGNED'
          AND CURRENT_DATE BETWEEN starts_on AND ends_on
        ORDER BY starts_on ASC, created_at ASC
        LIMIT 1`,
      [applicationId],
    );
  }

  /** The caller's live session joined to CPO identity (name/callsign/avatar). */
  private async liveSessionWithCpo(userId: string): Promise<(ProtectionSessionRow & SessionCpoIdentity) | null> {
    return this.db.qOne<ProtectionSessionRow & SessionCpoIdentity>(
      `SELECT ${prefixCols('s')},
              u.display_name AS cpo_name, u.avatar_url AS cpo_avatar, om.call_sign
         FROM public.protection_sessions s
         JOIN public.users u ON u.id = s.cpo_user_id
         LEFT JOIN public.pro_cpo_assignments pca ON pca.id = s.assignment_id
         LEFT JOIN public.org_members om
           ON om.member_user_id = s.cpo_user_id AND om.org_user_id = pca.org_user_id
        WHERE s.customer_id = $1 AND s.status IN (${LIVE_STATUS_SQL})
        ORDER BY s.created_at DESC
        LIMIT 1`,
      [userId],
    );
  }

  /** CPO identity for a freshly-created session row. */
  private async cpoIdentityFor(cpoUserId: string, assignmentId: string): Promise<SessionCpoIdentity> {
    const row = await this.db.qOne<SessionCpoIdentity>(
      `SELECT u.display_name AS cpo_name, u.avatar_url AS cpo_avatar, om.call_sign
         FROM public.users u
         LEFT JOIN public.pro_cpo_assignments pca ON pca.id = $2
         LEFT JOIN public.org_members om
           ON om.member_user_id = u.id AND om.org_user_id = pca.org_user_id
        WHERE u.id = $1`,
      [cpoUserId, assignmentId],
    );
    return row ?? {cpo_name: null, cpo_avatar: null, call_sign: null};
  }

  /** Raw session row by id (no scope) — callers apply their own access check. */
  private getById(sessionId: string): Promise<ProtectionSessionRow | null> {
    return this.db.qOne<ProtectionSessionRow>(
      `SELECT ${SESSION_COLS} FROM public.protection_sessions WHERE id = $1`,
      [sessionId],
    );
  }

  /** The session + customer identity, guaranteed owned by this CPO (else 403/404). */
  private async assertCpoOwnsSession(cpoUserId: string, sessionId: string): Promise<Record<string, unknown>> {
    const s = await this.db.qOne<Record<string, unknown>>(
      `SELECT ${prefixCols('s')},
              cu.display_name AS customer_name, cu.avatar_url AS customer_avatar
         FROM public.protection_sessions s
         JOIN public.users cu ON cu.id = s.customer_id
        WHERE s.id = $1`,
      [sessionId],
    );
    if (!s) {throw new NotFoundException('protection_session_not_found');}
    if (s.cpo_user_id !== cpoUserId) {throw new ForbiddenException('not_your_session');}
    return s;
  }

  /** Newest-first coordinate trail for a session's customer OR cpo stream. */
  private sessionTrail(
    sessionId: string, limit: number, since?: string, subject: 'customer' | 'cpo' = 'customer',
  ): Promise<Array<Record<string, unknown>>> {
    const cap = Math.min(Math.max(limit, 1), 500);
    if (since) {
      return this.db.q(
        `SELECT lat, lng, accuracy_m, recorded_at, received_at
           FROM public.protection_session_locations
          WHERE session_id = $1 AND subject = $2 AND received_at > $3
          ORDER BY received_at DESC
          LIMIT $4`,
        [sessionId, subject, since, cap],
      );
    }
    return this.db.q(
      `SELECT lat, lng, accuracy_m, recorded_at, received_at
         FROM public.protection_session_locations
        WHERE session_id = $1 AND subject = $2
        ORDER BY received_at DESC
        LIMIT $3`,
      [sessionId, subject, cap],
    );
  }

  /** CPO/Ops read of live/history location data is audited (§9). Never blocks the read. */
  private async writeAccessAudit(
    actorId: string, actorRole: 'cpo' | 'ops', sessionId: string, action: 'view_live' | 'view_history' | 'export',
  ): Promise<void> {
    try {
      await this.db.q(
        `INSERT INTO public.protection_access_audit (actor_id, actor_role, session_id, action)
         VALUES ($1, $2, $3, $4)`,
        [actorId, actorRole, sessionId, action],
      );
    } catch (e) {
      this.log.warn(`access audit failed: ${(e as Error).message}`);
    }
  }

  /** A covering dedication for a SPECIFIC officer on this plan today (transfer path). */
  private coveringAssignmentForCpoToday(applicationId: string, cpoUserId: string): Promise<{assignment_id: string} | null> {
    return this.db.qOne<{assignment_id: string}>(
      `SELECT id AS assignment_id
         FROM public.pro_cpo_assignments
        WHERE application_id = $1 AND cpo_user_id = $2 AND status = 'ASSIGNED'
          AND CURRENT_DATE BETWEEN starts_on AND ends_on
        ORDER BY starts_on ASC, created_at ASC
        LIMIT 1`,
      [applicationId, cpoUserId],
    );
  }
}

/** `id, application_id, …` → `s.id, s.application_id, …` for a joined SELECT. */
function prefixCols(alias: string): string {
  return SESSION_COLS.trim().split(',').map(c => `${alias}.${c.trim()}`).join(', ');
}

/** Reject non-finite / out-of-range / null-island fixes (B-89 MG-12). Coords never logged. */
function isValidFix(lat: unknown, lng: unknown): boolean {
  const latOk = typeof lat === 'number' && Number.isFinite(lat) && Math.abs(lat) <= 90;
  const lngOk = typeof lng === 'number' && Number.isFinite(lng) && Math.abs(lng) <= 180;
  return latOk && lngOk && !(lat === 0 && lng === 0);
}
