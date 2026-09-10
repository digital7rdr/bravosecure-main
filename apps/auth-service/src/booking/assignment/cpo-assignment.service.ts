import {BadRequestException, Injectable, Logger} from '@nestjs/common';
import {DatabaseService, type Tx} from '../../database/database.service';

interface CpoRow {
  id: string;
  call_sign: string;
  display_name: string;
  role: string;
  region_code: string;
  armed: boolean;
  female: boolean;
  specialties: string[];
  availability: 'available' | 'on_mission' | 'off_duty';
  active: boolean;
}

export interface AssignedCpo {
  id: string;
  call_sign: string;
  display_name: string;
  role: string;
  armed: boolean;
  female: boolean;
  specialties: string[];
  /**
   * Public profile photo, or null. The client is told to compare a face against
   * a rotating code at handover, so a name and initials alone were never enough
   * to identify who is arriving. Served from the public `avatars` bucket.
   */
  avatar_url: string | null;
  /** The service provider this officer belongs to, or null if self-registered. */
  company: string | null;
  /** Vetting complete — agents.approved_at is set. */
  verified: boolean;
  /** The officer has accepted this specific assignment (B-377). */
  accepted: boolean;
}

/**
 * Allocates N CPOs to a booking. Encodes the small bit of policy a dispatcher
 * would otherwise enforce:
 *
 * - add-on `female_cpo` pins the first slot to a female-team CPO,
 * - add-on `recon` prefers a CPO with `recon` in their specialties,
 * - add-on `medical` prefers medical-trained CPOs,
 * - otherwise fall back to any armed available CPO in-region.
 */
@Injectable()
export class CpoAssignmentService {
  private readonly log = new Logger(CpoAssignmentService.name);

  constructor(private readonly db: DatabaseService) {}

  async assign(bookingId: string, opts: {
    region: string;
    cpoCount: number;
    addOns: string[];
  }): Promise<AssignedCpo[]> {
    const existing = await this.getForBooking(bookingId);
    if (existing.length >= opts.cpoCount) return existing.slice(0, opts.cpoCount);

    const need = opts.cpoCount - existing.length;
    const claimed = [...existing.map(e => e.id)];
    const picked: AssignedCpo[] = [...existing];

    const specialtyOrder = this.specialtyPreference(opts.addOns);

    for (let slot = existing.length; slot < opts.cpoCount; slot++) {
      const preferred = specialtyOrder[slot - existing.length] ?? null;
      const row = await this.claimOne({
        region: opts.region,
        // Snapshot at call-time so the array captured by the driver's
        // parameter binding can't be retroactively mutated by later slots.
        excludeIds: [...claimed],
        preferredSpecialty: preferred,
        requireFemale: preferred === 'female_team',
      });
      if (!row) {
        this.log.warn(`CPO pool exhausted for booking ${bookingId} after ${picked.length}/${opts.cpoCount}`);
        throw new BadRequestException(picked.length === 0 ? 'no_cpo_available' : 'cpo_pool_exhausted');
      }
      claimed.push(row.id);
      picked.push(this.toClient(row));
      await this.db.q(
        `INSERT INTO booking_cpo_assignments (booking_id, cpo_id, slot)
           VALUES ($1, $2, $3)
         ON CONFLICT (booking_id, cpo_id) DO NOTHING`,
        [bookingId, row.id, slot],
      );
      this.log.log(`booking ${bookingId} slot ${slot} → ${row.call_sign}`);
    }

    // Update booking.cpo_id to the lead CPO so legacy single-cpo callers still work.
    if (picked.length > 0) {
      await this.db.q(
        `UPDATE lite_bookings SET cpo_id = $1 WHERE id = $2`,
        [picked[0].id, bookingId],
      );
    }

    // Remaining slots we claimed — we haven't omitted anything yet.
    void need;
    return picked;
  }

  /**
   * Manual assignment by ops: claim a specific list of CPO IDs for the
   * booking. Verifies each one is currently available before locking.
   * Throws if any chosen CPO has been picked up by someone else.
   */
  async assignSpecific(bookingId: string, cpoIds: string[], tx?: Tx): Promise<AssignedCpo[]> {
    if (cpoIds.length === 0) throw new BadRequestException('no_cpos_selected');
    // When called inside an outer transaction (dispatchBooking), use the
    // tx so the cpo_pool flip + booking_cpo_assignments inserts roll
    // back together with the surrounding mission/booking writes.
    const q = tx ?? this.db;

    // Lock + verify the chosen rows in one shot. SKIP LOCKED so a parallel
    // dispatch can't deadlock — but we then re-check that we got everyone
    // we asked for.
    const rows = await q.q<CpoRow>(
      `UPDATE cpo_pool
          SET availability = 'on_mission'
        WHERE id = ANY($1::uuid[])
          AND active = TRUE
          AND availability = 'available'
        RETURNING *`,
      [cpoIds],
    );
    if (rows.length !== cpoIds.length) {
      // Roll back what we did claim — caller should refresh and retry.
      // When inside a tx the throw alone rolls back; the explicit revert
      // here is for the standalone-call path.
      if (rows.length > 0 && !tx) {
        await this.db.q(
          `UPDATE cpo_pool SET availability = 'available' WHERE id = ANY($1::uuid[])`,
          [rows.map(r => r.id)],
        );
      }
      throw new BadRequestException('cpo_unavailable');
    }

    // Insert assignment rows in the order ops picked them.
    for (let i = 0; i < cpoIds.length; i++) {
      const id = cpoIds[i];
      await q.q(
        `INSERT INTO booking_cpo_assignments (booking_id, cpo_id, slot)
           VALUES ($1, $2, $3)
         ON CONFLICT (booking_id, cpo_id) DO NOTHING`,
        [bookingId, id, i],
      );
    }

    // Lead CPO mirrors slot 0.
    await q.q(
      `UPDATE lite_bookings SET cpo_id = $1 WHERE id = $2`,
      [cpoIds[0], bookingId],
    );
    return cpoIds.map(id => this.toClient(rows.find(r => r.id === id) as CpoRow));
  }

  /** List CPOs available in a region for the ops dispatch picker. */
  async listAvailable(region: string): Promise<AssignedCpo[]> {
    const rows = await this.db.q<CpoRow>(
      `SELECT * FROM cpo_pool
        WHERE active = TRUE
          AND availability = 'available'
          AND region_code = $1
        ORDER BY call_sign ASC`,
      [region],
    );
    return rows.map(this.toClient);
  }

  async release(bookingId: string): Promise<void> {
    const rows = await this.db.q<{cpo_id: string}>(
      `SELECT cpo_id FROM booking_cpo_assignments WHERE booking_id = $1`,
      [bookingId],
    );
    if (rows.length === 0) return;
    await this.db.q(
      `UPDATE cpo_pool
          SET availability = 'available'
        WHERE id = ANY($1::uuid[])`,
      [rows.map(r => r.cpo_id)],
    );
    await this.db.q(
      `DELETE FROM booking_cpo_assignments WHERE booking_id = $1`,
      [bookingId],
    );
  }

  async getForBooking(bookingId: string): Promise<AssignedCpo[]> {
    const rows = await this.db.q<CpoRow & {slot: number}>(
      `SELECT c.*, a.slot
         FROM booking_cpo_assignments a
         JOIN cpo_pool c ON c.id = a.cpo_id
        WHERE a.booking_id = $1
        ORDER BY a.slot ASC`,
      [bookingId],
    );
    return rows.map(this.toClient);
  }

  /** Auto-dispatch crew — the REAL officers in mission_crew, in the client-facing
   *  AssignedCpo shape. getForBooking() reads the LEGACY booking_cpo_assignments table,
   *  which is empty for an auto-dispatched booking, so the client's team card was stuck on
   *  "assigning" even after the agency crewed the mission. Excludes released ('off') crew. */
  async getMissionCrewForBooking(bookingId: string): Promise<AssignedCpo[]> {
    const rows = await this.db.q<{
      id: string; call_sign: string | null; display_name: string | null;
      role: string | null; armed: boolean | null; avatar_url: string | null;
      company: string | null; verified: boolean | null; accepted: boolean | null;
    }>(
      // Deck page 12 — the Team tab must show identity, role, COMPANY and live
      // availability, not just a name. The org that owns a managed CPO is itself
      // a user (org_members.org_user_id), so the company name is one join away.
      `SELECT mc.agent_id AS id,
              COALESCE(mc.call_sign, a.call_sign) AS call_sign,
              u.display_name, mc.role, mc.armed, u.avatar_url,
              ou.display_name AS company,
              (a.approved_at IS NOT NULL) AS verified,
              (mc.accepted_at IS NOT NULL) AS accepted
         FROM mission_crew mc
         JOIN missions m ON m.id = mc.mission_id
         JOIN public.users u ON u.id = mc.agent_id
         LEFT JOIN agents a ON a.user_id = mc.agent_id
         LEFT JOIN public.org_members om
                ON om.member_user_id = mc.agent_id AND om.status = 'active'
         LEFT JOIN public.users ou ON ou.id = om.org_user_id
        WHERE m.booking_id = $1 AND mc.status <> 'off'
        ORDER BY mc.slot ASC`,
      [bookingId],
    );
    return rows.map(r => ({
      id: r.id,
      call_sign: r.call_sign ?? '',
      display_name: r.display_name ?? 'Officer',
      role: r.role ?? 'CPO',
      armed: r.armed ?? false,
      female: false,
      specialties: [],
      avatar_url: r.avatar_url ?? null,
      company: r.company ?? null,
      verified: r.verified === true,
      accepted: r.accepted === true,
    }));
  }

  // ─── Payout sourcing (Phase 2 — org-as-payee) ────────────────────────
  //
  // The deployed officers live in mission_crew (real users.id), NOT cpo_pool
  // (whose ids are a denormalised roster — many are not real users, so the
  // legacy getForBooking-keyed payout silently credited phantom ids). Payout
  // must iterate the real crew and resolve each officer to their payee.

  /** Real officers crewed on a booking's mission, in slot order. */
  async getCrewForPayout(bookingId: string): Promise<Array<{user_id: string; call_sign: string | null}>> {
    return this.db.q<{user_id: string; call_sign: string | null}>(
      `SELECT mc.agent_id AS user_id, mc.call_sign
         FROM mission_crew mc
         JOIN missions m ON m.id = mc.mission_id
        WHERE m.booking_id = $1
        ORDER BY mc.slot ASC`,
      [bookingId],
    );
  }

  /**
   * Resolve who actually gets paid for an officer's work on a booking.
   *
   * Priority:
   *  1. The applicant_org_id on the WINNING (ASSIGNED) application that named
   *     this officer for this booking — the org that applied is the payee.
   *  2. The officer's owning org from org_members (managed CPO with no app row).
   *  3. The officer themselves (legacy self-registered CPO).
   *
   * Returns a real users.id in every branch (org ids and self ids are both
   * users.id), so the wallet credit always lands on a valid wallet.
   */
  async resolvePayeeUserId(bookingId: string, officerUserId: string): Promise<string> {
    const fromApp = await this.db.qOne<{applicant_org_id: string | null}>(
      `SELECT ja.applicant_org_id
         FROM job_applications ja
         JOIN jobs j ON j.id = ja.job_id
        WHERE j.booking_id = $1
          AND ja.assigned_cpo_user_id = $2
          AND ja.status = 'ASSIGNED'
        ORDER BY ja.decided_at DESC NULLS LAST
        LIMIT 1`,
      [bookingId, officerUserId],
    );
    if (fromApp?.applicant_org_id) return fromApp.applicant_org_id;

    const owning = await this.db.qOne<{org_user_id: string}>(
      `SELECT org_user_id FROM org_members
        -- vs2 item 4 — ROLE-FILTERED. Multi-org membership means a CPO can
        -- also be an 'employee' of a company workspace, and an older
        -- employee row would otherwise win this ORDER BY and answer with
        -- the wrong org. This resolver decides EMPLOYMENT (and downstream,
        -- who gets paid), so it must only ever consider the CPO membership
        -- — which the new org_members_one_active_cpo index keeps unique.
        WHERE member_user_id = $1 AND status = 'active' AND member_role = 'cpo'
        ORDER BY created_at ASC LIMIT 1`,
      [officerUserId],
    );
    if (owning?.org_user_id) return owning.org_user_id;

    return officerUserId;
  }

  private async claimOne(opts: {
    region: string;
    excludeIds: string[];
    preferredSpecialty: string | null;
    requireFemale: boolean;
  }): Promise<CpoRow | null> {
    // Try preferred specialty / gender first, then fall back.
    const attempts: Array<{specialty?: string; female?: boolean}> = [];
    if (opts.requireFemale) attempts.push({female: true});
    if (opts.preferredSpecialty && opts.preferredSpecialty !== 'female_team') {
      attempts.push({specialty: opts.preferredSpecialty});
    }
    attempts.push({}); // fallback — any armed available CPO

    for (const attempt of attempts) {
      const row = await this.db.qOne<CpoRow>(
        `UPDATE cpo_pool
            SET availability = 'on_mission'
          WHERE id = (
            SELECT id FROM cpo_pool
             WHERE active = TRUE
               AND availability = 'available'
               AND region_code = $1
               AND NOT (id = ANY($2::uuid[]))
               AND ($3::text IS NULL OR $3 = ANY(specialties))
               AND ($4::boolean IS NULL OR female = $4)
             ORDER BY created_at ASC
             FOR UPDATE SKIP LOCKED
             LIMIT 1
          )
          RETURNING *`,
        [
          opts.region,
          opts.excludeIds,
          attempt.specialty ?? null,
          attempt.female ?? null,
        ],
      );
      if (row) return row;
    }
    return null;
  }

  private specialtyPreference(addOns: string[]): Array<string | null> {
    // Map add-on ids → the specialty we'd prefer for the FIRST available slot
    // after the add-on is selected. Order mirrors on-screen importance:
    // female CPO > recon > medical > comms.
    const order: string[] = [];
    if (addOns.includes('female_cpo')) order.push('female_team');
    if (addOns.includes('recon'))      order.push('recon');
    if (addOns.includes('medical'))    order.push('medical');
    if (addOns.includes('comms'))      order.push('comms');
    return order;
  }

  private toClient = (r: CpoRow): AssignedCpo => ({
    id: r.id,
    call_sign: r.call_sign,
    display_name: r.display_name,
    role: r.role,
    armed: r.armed,
    female: r.female,
    specialties: r.specialties ?? [],
    // The legacy cpo_pool roster carries no photo, org or vetting record —
    // many of its rows are not real users at all. Honest nulls; the UI falls
    // back to initials and simply omits what it does not know.
    avatar_url: null,
    company: null,
    verified: false,
    accepted: false,
  });
}
