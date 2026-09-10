import {BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';
import {OrgAuditService} from '../org/org-audit.service';
import {pickOrgContext, orgNameExpr, orgNameJoin} from '../org/org-context';
import {BookingPushBridge} from '../ops/booking-push-bridge.service';
import type {OrgManagerContext} from '../org/org-manager.guard';
import type {IncidentCategory, IncidentSeverity, IncidentStatus} from './incident.constants';
import {assertIncidentTransition, type IncidentActor} from './incident-fsm';

export interface IncidentEvent {
  id: string;
  incident_id: string;
  actor_id: string;
  from_status: string | null;
  to_status: string | null;
  note: string | null;
  note_internal: boolean;
  created_at: string;
}

export interface IncidentAttachment {
  id: string;
  incident_id: string;
  storage_key: string;
  created_by: string;
  created_at: string;
}

export interface IncidentReport {
  id: string;
  ref: string | null;
  org_user_id: string;
  submitter_id: string;
  department: string | null;
  category: IncidentCategory;
  severity: IncidentSeverity;
  description: string;
  location_label: string | null;
  location_lat: number | null;
  location_lng: number | null;
  status: IncidentStatus;
  /** vs2 item 4 — the COMPANY this report was filed against. */
  org_name?: string | null;
  assigned_to: string | null;
  created_at: string;
  updated_at: string;
}

export interface SubmitIncidentInput {
  category: IncidentCategory;
  severity: IncidentSeverity;
  description: string;
  department?: string;
  location_label?: string;
  location_lat?: number;
  location_lng?: number;
}

@Injectable()
export class IncidentService {
  private readonly log = new Logger(IncidentService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: OrgAuditService,
    private readonly push: BookingPushBridge,
  ) {}

  // The company account itself is 'company_admin' (Path 1: user_id === org); a
  // delegated manager is 'manager'. Drives the FSM reopen gate (company-only).
  private actorOf(manager: OrgManagerContext): IncidentActor {
    return manager.user_id === manager.org_user_id ? 'company_admin' : 'manager';
  }

  // Recipients for a new-incident alert: the company account + active managers.
  // With a department (PDF p.11 "routes to the department manager"), only that
  // department's managers + org-wide (unscoped) managers are alerted — a manager
  // scoped to a DIFFERENT department is not.
  private async resolveOrgManagers(
    orgUserId: string, department?: string | null, excludeUserId?: string | null,
  ): Promise<string[]> {
    const mgrs = await this.db.q<{member_user_id: string}>(
      `SELECT member_user_id FROM org_members
        WHERE org_user_id = $1 AND member_role = 'manager' AND status = 'active'
          AND ($2::text IS NULL OR department IS NULL OR department = $2)`,
      [orgUserId, department ?? null],
    );
    // Never notify the person who just pressed Submit. They are on the
    // confirmation screen. This hits three real personas: a solo agent (whose
    // org resolves to THEMSELVES, so they were the whole audience), an owner
    // filing a report, and a manager filing one.
    return Array.from(new Set([orgUserId, ...mgrs.map(m => m.member_user_id)]))
      .filter(uid => uid !== excludeUserId);
  }

  // Mirrors AttendanceService.resolveOrg — the owning org of a managed CPO, or
  // self for a self-registered agent (so even a solo agent's incidents are
  // org-scoped to a real users.id the manager queue can read).
  private async resolveOrg(userId: string, requested: string | null = null): Promise<string> {
    /**
     * vs2 item 4 — WHICH org this record belongs to, when the person has more
     * than one.
     *
     * `requested` is the X-Org-Context the client already sends on this surface
     * (api.ts allowlists it). Without honouring it, Chidi — an officer at
     * agency Meridian and an employee of workspace Acme — stands inside Acme,
     * taps the action, and the record is filed against MERIDIAN, because the
     * ordering below prefers his cpo row. Acme's manager reads
     * WHERE org_user_id = the-acme-id and never sees it. The client was
     * faithfully naming the right org and the server was discarding it.
     *
     * `pickOrgContext` NARROWS: a header naming an org this person does not
     * belong to is ignored and the ordering below decides, so the cpo-first
     * default is unchanged for everyone who sends nothing.
     */
    const rows = await this.db.q<{org_user_id: string}>(
      `SELECT org_user_id FROM org_members
        WHERE member_user_id = $1 AND status = 'active'
        -- PREFER the cpo membership, NEVER require it. Requiring it was a
        -- CRITICAL defect: a workspace employee has no cpo row, so nothing
        -- matched, the caller fell through to the self-id default, and the
        -- record was written under the employee's OWN user id — invisible to
        -- every manager read, which all scope by the real org.
        ORDER BY (member_role = 'cpo') DESC, created_at ASC`,
      [userId],
    );
    return pickOrgContext(rows, requested)?.org_user_id ?? userId;
  }

  /**
   * Submit a structured incident. The ref (INC-YYYY-NNNNN) is stamped in the
   * same transaction that writes the report + its first status-history row, so a
   * report and its 'submitted' event are always consistent. Routes to the org's
   * manager queue (Step 9) — the body is NEVER posted into any chat channel.
   */
  async submit(
    submitterId: string, dto: SubmitIncidentInput, orgContext: string | null = null,
  ): Promise<{id: string; ref: string | null; status: IncidentStatus; severity: IncidentSeverity}> {
    const orgUserId = await this.resolveOrg(submitterId, orgContext);
    const result = await this.db.withTransaction(async (tx) => {
      const report = await tx.qOne<IncidentReport>(
        `INSERT INTO incident_reports
           (ref, org_user_id, submitter_id, department, category, severity, description,
            location_label, location_lat, location_lng)
         VALUES (
           'INC-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('incident_ref_seq')::text, 5, '0'),
           $1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [orgUserId, submitterId, dto.department ?? null, dto.category, dto.severity,
         dto.description, dto.location_label ?? null, dto.location_lat ?? null, dto.location_lng ?? null],
      );
      if (!report) throw new BadRequestException('incident_submit_failed');

      // Append-only status history; the initial 'submitted' transition.
      await tx.q(
        `INSERT INTO incident_events (incident_id, actor_id, from_status, to_status, note, note_internal)
         VALUES ($1, $2, NULL, 'submitted', NULL, TRUE)`,
        [report.id, submitterId],
      );

      // Audited like every other lifecycle action. 🛑 category/severity only —
      // the narrative never lands in the audit metadata.
      await this.audit.log(orgUserId, submitterId, 'incident.submit', {
        targetKind: 'incident', targetId: report.id,
        metadata: {category: dto.category, severity: dto.severity}, tx,
      });

      return {id: report.id, ref: report.ref, status: report.status, severity: report.severity};
    });

    // Best-effort manager alert (metadata-only; never blocks/throws the submit).
    //
    // vs2 item 16 — the banner names the organisation and the reporter and
    // opens the incident on tap, so those three come along. Read in ONE
    // best-effort query after the transaction: a naming lookup must never be
    // able to fail a filed incident, and a missing name simply degrades the
    // copy (the bridge omits blanks; the client falls back to generic text).
    const managers = await this.resolveOrgManagers(orgUserId, dto.department ?? null, submitterId);
    if (managers.length === 0) {return result;}
    let names: {org_name: string | null; reporter_name: string | null} | null = null;
    try {
      // `COALESCE(w.name, u.display_name)` is the repo-canonical org label —
      // the same shape enterprise-join uses, and pinned by its spec scans. A
      // workspace named "SASFA" owned by a personal account must title the
      // banner SASFA, not the owner's own name. (`users.full_name` does NOT
      // exist; the column is `display_name` — an earlier revision of this query
      // named it and threw 42703 on every submit, silently, so the banner never
      // named anything. Hence the warn below: this lane must never fail quietly
      // again.)
      names = await this.db.qOne<{org_name: string | null; reporter_name: string | null}>(
        `SELECT COALESCE(w.name, o.display_name) AS org_name,
                s.display_name                   AS reporter_name
           FROM public.users s
           LEFT JOIN public.users o          ON o.id = $2
           LEFT JOIN public.org_workspaces w ON w.owner_user_id = $2
          WHERE s.id = $1`,
        [submitterId, orgUserId],
      );
    } catch (e) {
      // Cosmetic — never fail a filed incident for a label. But VISIBLE.
      this.log.warn(`incident notify names lookup failed: ${(e as Error).message}`);
    }
    await this.push.incidentSubmitted(managers, result.ref, result.severity, {
      incidentId: result.id,
      // vs2 edge A1 — the org the tap must be scoped to. NOT from the name
      // lookup above: that query is best-effort and may have thrown, and a
      // deep link that only works when a cosmetic label resolved is the same
      // silent failure twice.
      orgId: orgUserId,
      orgName: names?.org_name ?? null,
      reporterName: names?.reporter_name ?? null,
    });
    return result;
  }

  /** A member's own submitted incidents (PDF p.16). Internal notes are NOT here. */
  async mine(submitterId: string, orgContext: string | null = null, limit = 50): Promise<IncidentReport[]> {
    // B-610 — SCOPE to the org being viewed, reversing the earlier vs2-item-4
    // "self-reads stay cross-org" call (SELF_READ_ORG_SCOPING_BRIEF.md) per the
    // founder: reports filed in different orgs must not mix in one list.
    // B-610 follow-up — scope ONLY when the client actually names a viewing org.
    // With NO org context (cold start, no workspace selected) show ALL the
    // member's own reports (labelled by org), never an empty list under an
    // arbitrary default. These are always the caller's OWN reports (submitter_id),
    // so "all" is never a cross-user leak. When a header IS present, resolveOrg
    // computes the SAME org key submit() stamps, so the filter and the write agree.
    const capped = Math.min(limit, 200);
    const orgUserId = orgContext ? await this.resolveOrg(submitterId, orgContext) : null;
    if (orgUserId) {
      return this.db.q<IncidentReport>(
        `SELECT ir.*, ${orgNameExpr()} AS org_name
           FROM incident_reports ir
          ${orgNameJoin('ir.org_user_id')}
          WHERE ir.submitter_id = $1 AND ir.org_user_id = $2
          ORDER BY ir.created_at DESC
          LIMIT $3`,
        [submitterId, orgUserId, capped],
      );
    }
    return this.db.q<IncidentReport>(
      `SELECT ir.*, ${orgNameExpr()} AS org_name
         FROM incident_reports ir
        ${orgNameJoin('ir.org_user_id')}
        WHERE ir.submitter_id = $1
        ORDER BY ir.created_at DESC
        LIMIT $2`,
      [submitterId, capped],
    );
  }

  // ─── Manager queue + lifecycle (Step 9) ───────────────────────────────

  /** Org-scoped manager queue, Critical/High first, then most-recently-updated.
   *  department filter doubles as the FORCED scope for a dept-scoped manager. */
  async queue(
    orgUserId: string,
    filters?: {
      status?: string; severity?: string; category?: string; submitterId?: string;
      from?: string; to?: string; department?: string;
    },
  ): Promise<IncidentReport[]> {
    return this.db.q<IncidentReport>(
      `SELECT * FROM incident_reports
        WHERE org_user_id = $1
          AND ($2::text IS NULL OR status = $2)
          AND ($3::text IS NULL OR severity = $3)
          AND ($4::text IS NULL OR category = $4)
          AND ($5::uuid IS NULL OR submitter_id = $5)
          AND ($6::timestamptz IS NULL OR created_at >= $6)
          AND ($7::timestamptz IS NULL OR created_at <= $7)
          AND ($8::text IS NULL OR department = $8)
        ORDER BY CASE severity
                   WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                   WHEN 'medium' THEN 2 ELSE 3 END,
                 updated_at DESC
        LIMIT 200`,
      [orgUserId, filters?.status ?? null, filters?.severity ?? null,
       filters?.category ?? null, filters?.submitterId ?? null,
       filters?.from ?? null, filters?.to ?? null, filters?.department ?? null],
    );
  }

  /**
   * Bravo-admin (HQ) cross-org oversight list (Step 15 ops-console). Optionally
   * filtered to one org. Severity-sorted. Gated by AdminGuard at the route — a
   * different trust tier from the OrgManagerGuard queue.
   */
  async adminIncidents(
    filters?: {orgId?: string; status?: string; severity?: string},
  ): Promise<Array<IncidentReport & {org_name: string | null}>> {
    // IS-09 — resolve the org's display name so the HQ list isn't bare UUIDs.
    return this.db.q<IncidentReport & {org_name: string | null}>(
      `SELECT i.*, u.display_name AS org_name
         FROM incident_reports i
         LEFT JOIN users u ON u.id = i.org_user_id
        WHERE ($1::uuid IS NULL OR i.org_user_id = $1)
          AND ($2::text IS NULL OR i.status = $2)
          AND ($3::text IS NULL OR i.severity = $3)
        ORDER BY CASE i.severity
                   WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                   WHEN 'medium' THEN 2 ELSE 3 END,
                 i.updated_at DESC
        LIMIT 300`,
      [filters?.orgId ?? null, filters?.status ?? null, filters?.severity ?? null],
    );
  }

  /** Manager detail: the report + its full event history (incl. internal notes).
   *  A department-scoped manager only opens their own department's incidents. */
  async detail(
    orgUserId: string, incidentId: string, managerDepartment?: string | null,
  ): Promise<{report: IncidentReport; events: IncidentEvent[]}> {
    const report = await this.db.qOne<IncidentReport>(
      `SELECT * FROM incident_reports
        WHERE id = $1 AND org_user_id = $2
          AND ($3::text IS NULL OR department = $3)`,
      [incidentId, orgUserId, managerDepartment ?? null],
    );
    if (!report) throw new NotFoundException('incident_not_found_in_org');
    const events = await this.db.q<IncidentEvent>(
      `SELECT * FROM incident_events WHERE incident_id = $1 ORDER BY created_at ASC`,
      [incidentId],
    );
    return {report, events};
  }

  /**
   * Move an incident through the FSM. The submitter's narrative is never touched
   * — only status + an event row. Reopen (closed→under_review) is company-admin
   * only (enforced by the FSM via actorOf). Audited.
   */
  async updateStatus(
    orgUserId: string, manager: OrgManagerContext, incidentId: string,
    to: IncidentStatus, note?: string,
  ): Promise<{id: string; status: IncidentStatus}> {
    const out = await this.db.withTransaction(async (tx) => {
      const row = await tx.qOne<{status: IncidentStatus; submitter_id: string; ref: string | null}>(
        `SELECT status, submitter_id, ref FROM incident_reports WHERE id = $1 AND org_user_id = $2 FOR UPDATE`,
        [incidentId, orgUserId],
      );
      if (!row) throw new NotFoundException('incident_not_found_in_org');
      assertIncidentTransition(row.status, to, this.actorOf(manager));

      await tx.q(
        `UPDATE incident_reports SET status = $2, updated_at = NOW() WHERE id = $1`,
        [incidentId, to],
      );
      await tx.q(
        `INSERT INTO incident_events (incident_id, actor_id, from_status, to_status, note, note_internal)
         VALUES ($1, $2, $3, $4, $5, TRUE)`,
        [incidentId, manager.user_id, row.status, to, note ?? null],
      );
      await this.audit.log(orgUserId, manager.user_id, 'incident.status', {
        targetKind: 'incident', targetId: incidentId, metadata: {from: row.status, to}, tx,
      });
      return {id: incidentId, status: to, submitter_id: row.submitter_id, ref: row.ref};
    });

    // Best-effort submitter notification (metadata-only). The id rides along so
    // the reporter's tap opens THEIR report rather than a list (vs2 item 16).
    await this.push.incidentStatusChanged(out.submitter_id, out.ref, out.status, out.id);
    return {id: out.id, status: out.status};
  }

  /** Assign an action owner (must be an active member of, or be, this org). */
  async assign(
    orgUserId: string, manager: OrgManagerContext, incidentId: string, assigneeUserId: string,
  ): Promise<{id: string; assigned_to: string}> {
    // Only managers work the incident queue, so only the company account or an
    // active manager is an assignable owner — this matches the mobile picker
    // (IncidentDetailScreen restricts to member_role='manager') so UI and server
    // agree on who can own an incident.
    if (assigneeUserId !== orgUserId) {
      const member = await this.db.qOne<{ok: number}>(
        `SELECT 1 AS ok FROM org_members
          WHERE org_user_id = $1 AND member_user_id = $2
            AND member_role = 'manager' AND status = 'active'`,
        [orgUserId, assigneeUserId],
      );
      if (!member) throw new BadRequestException('assignee_must_be_manager');
    }
    return this.db.withTransaction(async (tx) => {
      const row = await tx.qOne<{status: IncidentStatus}>(
        `SELECT status FROM incident_reports WHERE id = $1 AND org_user_id = $2 FOR UPDATE`,
        [incidentId, orgUserId],
      );
      if (!row) throw new NotFoundException('incident_not_found_in_org');
      // D7-a — assignment is only valid while the incident is actively worked. resolved/closed
      // are terminal, so reject (previously assignment was allowed on ANY status, incl. closed).
      if (row.status === 'resolved' || row.status === 'closed') {
        throw new BadRequestException('incident_not_assignable');
      }
      await tx.q(
        `UPDATE incident_reports SET assigned_to = $3, updated_at = NOW()
          WHERE id = $1 AND org_user_id = $2`,
        [incidentId, orgUserId, assigneeUserId],
      );
      // D7-a — record the assignment on the timeline (no status hop → from = to = current),
      // so detail()'s event history shows it instead of the assignment being invisible.
      await tx.q(
        `INSERT INTO incident_events (incident_id, actor_id, from_status, to_status, note, note_internal)
         VALUES ($1, $2, $3, $3, $4, TRUE)`,
        [incidentId, manager.user_id, row.status, 'Action owner assigned'],
      );
      await this.audit.log(orgUserId, manager.user_id, 'incident.assign', {
        targetKind: 'incident', targetId: incidentId, metadata: {}, tx,
      });
      return {id: incidentId, assigned_to: assigneeUserId};
    });
  }

  /** Append a note (internal by default). 🛑 The note text is never audit-logged. */
  async addNote(
    orgUserId: string, manager: OrgManagerContext, incidentId: string,
    note: string, internal = true,
  ): Promise<{ok: true}> {
    const exists = await this.db.qOne<{id: string}>(
      `SELECT id FROM incident_reports WHERE id = $1 AND org_user_id = $2`,
      [incidentId, orgUserId],
    );
    if (!exists) throw new NotFoundException('incident_not_found_in_org');
    await this.db.q(
      `INSERT INTO incident_events (incident_id, actor_id, from_status, to_status, note, note_internal)
       VALUES ($1, $2, NULL, NULL, $3, $4)`,
      [incidentId, manager.user_id, note, internal],
    );
    await this.audit.log(orgUserId, manager.user_id, 'incident.note', {
      targetKind: 'incident', targetId: incidentId, metadata: {internal},
    });
    return {ok: true};
  }

  // ─── Evidence attachments (Step 10) ───────────────────────────────────
  //
  // 🛑 The encrypted bytes live in the media vault; only the OPAQUE storage_key
  // lands here. The per-file key/iv never touch this DB or any log (they ride
  // the sealed envelope — architecture-gated). storage_key is never a URL.

  private async isOrgManager(userId: string, orgUserId: string): Promise<boolean> {
    if (userId === orgUserId) {return true;} // the company account is its own org
    const r = await this.db.qOne<{ok: number}>(
      `SELECT 1 AS ok FROM org_members
        WHERE org_user_id = $1 AND member_user_id = $2 AND member_role = 'manager' AND status = 'active'`,
      [orgUserId, userId],
    );
    return !!r;
  }

  /** Submitter attaches an opaque evidence pointer to their own incident. */
  async attach(callerId: string, incidentId: string, storageKey: string): Promise<{id: string}> {
    const inc = await this.db.qOne<{submitter_id: string}>(
      `SELECT submitter_id FROM incident_reports WHERE id = $1`, [incidentId],
    );
    if (!inc) throw new NotFoundException('incident_not_found');
    if (inc.submitter_id !== callerId) throw new ForbiddenException('only_submitter_can_attach');
    const row = await this.db.qOne<{id: string}>(
      `INSERT INTO incident_attachments (incident_id, storage_key, created_by)
       VALUES ($1, $2, $3) RETURNING id`,
      [incidentId, storageKey, callerId],
    );
    if (!row) throw new BadRequestException('attach_failed');
    return {id: row.id};
  }

  /** List evidence pointers — the submitter, or a manager of the owning org. */
  async listAttachments(callerId: string, incidentId: string): Promise<IncidentAttachment[]> {
    const inc = await this.db.qOne<{org_user_id: string; submitter_id: string}>(
      `SELECT org_user_id, submitter_id FROM incident_reports WHERE id = $1`, [incidentId],
    );
    if (!inc) throw new NotFoundException('incident_not_found');
    if (inc.submitter_id !== callerId && !(await this.isOrgManager(callerId, inc.org_user_id))) {
      throw new ForbiddenException('not_authorized_for_incident_evidence');
    }
    return this.db.q<IncidentAttachment>(
      `SELECT id, incident_id, storage_key, created_by, created_at
         FROM incident_attachments WHERE incident_id = $1 ORDER BY created_at ASC`,
      [incidentId],
    );
  }

  // ─── Evidence key delivery (Step 10 · E2) ─────────────────────────────
  //
  // 🛑 The per-file media key is AES; managers must decrypt it WITHOUT the server
  // ever seeing a plaintext key. The client seals the key (outer-ECIES) to each
  // recipient device's identity and posts the SEALED blobs here; a viewer fetches
  // their own blob and unseals it on-device. This table holds opaque ciphertext
  // only — no plaintext key is ever stored or logged.

  /**
   * The set of recipients the submitter must seal the evidence key to: the org's
   * active managers + the company account + the submitter themselves (so they can
   * re-open it across devices). Caller must be the submitter or an org manager.
   */
  async evidenceRecipients(callerId: string, incidentId: string): Promise<string[]> {
    const inc = await this.db.qOne<{org_user_id: string; submitter_id: string}>(
      `SELECT org_user_id, submitter_id FROM incident_reports WHERE id = $1`, [incidentId],
    );
    if (!inc) throw new NotFoundException('incident_not_found');
    if (inc.submitter_id !== callerId && !(await this.isOrgManager(callerId, inc.org_user_id))) {
      throw new ForbiddenException('not_authorized_for_incident_evidence');
    }
    const managers = await this.resolveOrgManagers(inc.org_user_id);
    return Array.from(new Set([...managers, inc.submitter_id]));
  }

  /**
   * The submitter (uploader) stores the per-recipient-device sealed keys for an
   * attachment they own. Idempotent per (attachment, recipient, device).
   */
  async storeAttachmentKeys(
    callerId: string, incidentId: string, attachmentId: string,
    keys: {recipient_user_id: string; device_id: number; sealed_key: string}[],
  ): Promise<{stored: number}> {
    const att = await this.db.qOne<{created_by: string}>(
      `SELECT created_by FROM incident_attachments WHERE id = $1 AND incident_id = $2`,
      [attachmentId, incidentId],
    );
    if (!att) throw new NotFoundException('attachment_not_found');
    if (att.created_by !== callerId) throw new ForbiddenException('only_uploader_can_store_keys');
    let stored = 0;
    for (const k of keys) {
      await this.db.q(
        `INSERT INTO incident_attachment_keys (attachment_id, recipient_user_id, device_id, sealed_key)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (attachment_id, recipient_user_id, device_id)
           DO UPDATE SET sealed_key = EXCLUDED.sealed_key`,
        [attachmentId, k.recipient_user_id, k.device_id, k.sealed_key],
      );
      stored += 1;
    }
    return {stored};
  }

  /**
   * A viewer (submitter OR org manager) fetches THEIR OWN sealed key for a given
   * attachment + device. 404 when no blob exists for this device (e.g. a device
   * added/rotated after the evidence was sealed — they open on their original).
   */
  async getMyAttachmentKey(
    callerId: string, deviceId: number, incidentId: string, attachmentId: string,
  ): Promise<{sealed_key: string}> {
    const inc = await this.db.qOne<{org_user_id: string; submitter_id: string}>(
      `SELECT r.org_user_id, r.submitter_id
         FROM incident_reports r JOIN incident_attachments a ON a.incident_id = r.id
        WHERE r.id = $1 AND a.id = $2`,
      [incidentId, attachmentId],
    );
    if (!inc) throw new NotFoundException('attachment_not_found');
    if (inc.submitter_id !== callerId && !(await this.isOrgManager(callerId, inc.org_user_id))) {
      throw new ForbiddenException('not_authorized_for_incident_evidence');
    }
    const row = await this.db.qOne<{sealed_key: string}>(
      `SELECT sealed_key FROM incident_attachment_keys
        WHERE attachment_id = $1 AND recipient_user_id = $2 AND device_id = $3`,
      [attachmentId, callerId, deviceId],
    );
    if (!row) throw new NotFoundException('no_sealed_key_for_this_device');
    return {sealed_key: row.sealed_key};
  }
}
