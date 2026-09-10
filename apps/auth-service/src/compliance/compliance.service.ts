import {BadRequestException, Injectable, Logger, NotFoundException} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';

export const COMPLIANCE_DOC_TYPES = ['licence', 'insurance', 'armed_permit'] as const;
export type ComplianceDocType = (typeof COMPLIANCE_DOC_TYPES)[number];

export interface SubmitComplianceArgs {
  docType: ComplianceDocType;
  regionCode: string;
  expiresAt: string;          // ISO date — the hard validity gate
  reference?: string | null;
  fileUrl?: string | null;    // S3 key of the AES-256-CBC-encrypted cert (never plaintext)
  fileHashSha256?: string | null;
  cpoUserId?: string | null;  // armed_permit only: the CPO the permit is for (defaults to the submitter)
}

/**
 * Provider compliance registry operations (BUILD_RUNBOOK Step 15). The eligibility GATE
 * (is_eligible_for_dispatch, Step 6) already reads these tables — licence/insurance from
 * compliance_credentials, armed from armed_authorizations, both keyed on
 * `verified/authorized AND non-expired`. This service is the surface that POPULATES them:
 * a provider submits a credential (unverified), an admin verifies/rejects it. Until an
 * admin verifies, the provider is NOT eligible — no "skip in dev" anywhere.
 *
 * Never logs the cert file_url/hash (regulatory PII). The cert itself is stored via the
 * encrypted media path + the File-Vault MFA gate; this service only records its reference.
 */
@Injectable()
export class ComplianceService {
  private readonly log = new Logger(ComplianceService.name);

  constructor(private readonly db: DatabaseService) {}

  /**
   * Submit (or re-submit) a credential. Licence/insurance land on compliance_credentials
   * keyed to the subject (the agency, or a CPO); armed_permit lands on armed_authorizations
   * for the named CPO. Re-submitting a not-yet-verified doc supersedes the prior unverified
   * one for the same (subject, kind, region). Always starts UNVERIFIED.
   */
  async submit(subjectUserId: string, subjectKind: 'agency' | 'cpo', args: SubmitComplianceArgs): Promise<{id: string; doc_type: ComplianceDocType; state: 'PENDING'}> {
    if (!COMPLIANCE_DOC_TYPES.includes(args.docType)) throw new BadRequestException('invalid_doc_type');
    if (new Date(args.expiresAt).getTime() <= Date.now()) throw new BadRequestException('expiry_in_past');

    if (args.docType === 'armed_permit') {
      const cpoUserId = args.cpoUserId ?? subjectUserId;
      const row = await this.db.withTransaction(async tx => {
        // Supersede any prior un-authorized permit for this (cpo, region).
        await tx.q(
          `DELETE FROM public.armed_authorizations
            WHERE cpo_user_id = $1 AND region_code = $2 AND NOT authorized`,
          [cpoUserId, args.regionCode],
        );
        return tx.qOne<{id: string}>(
          `INSERT INTO public.armed_authorizations
             (cpo_user_id, region_code, permit_ref, authorized, expires_at, created_by)
           VALUES ($1, $2, $3, FALSE, $4, $5) RETURNING id`,
          [cpoUserId, args.regionCode, args.reference ?? null, args.expiresAt, subjectUserId],
        );
      });
      return {id: row?.id ?? '', doc_type: 'armed_permit', state: 'PENDING'};
    }

    const row = await this.db.withTransaction(async tx => {
      await tx.q(
        `DELETE FROM public.compliance_credentials
          WHERE subject_user_id = $1 AND kind = $2 AND region_code = $3 AND NOT verified AND reject_reason IS NULL`,
        [subjectUserId, args.docType, args.regionCode],
      );
      return tx.qOne<{id: string}>(
        `INSERT INTO public.compliance_credentials
           (subject_user_id, subject_kind, kind, region_code, reference, file_url, file_hash_sha256, expires_at, verified)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, FALSE) RETURNING id`,
        [subjectUserId, subjectKind, args.docType, args.regionCode, args.reference ?? null, args.fileUrl ?? null, args.fileHashSha256 ?? null, args.expiresAt],
      );
    });
    this.log.log(`compliance submit subject=${subjectUserId} kind=${args.docType} region=${args.regionCode}`);
    return {id: row?.id ?? '', doc_type: args.docType, state: 'PENDING'};
  }

  /** Submit resolving the subject kind from the caller's agent type (company → agency). */
  async submitForUser(userId: string, args: SubmitComplianceArgs): Promise<{id: string; doc_type: ComplianceDocType; state: 'PENDING'}> {
    const agent = await this.db.qOne<{type: string}>(`SELECT type FROM public.agents WHERE user_id = $1`, [userId]);
    const subjectKind: 'agency' | 'cpo' = agent?.type === 'company' ? 'agency' : 'cpo';
    return this.submit(userId, subjectKind, args);
  }

  /** The caller's own credentials + armed permits, with a derived display state. */
  async listMine(subjectUserId: string): Promise<Array<{
    id: string; doc_type: string; region_code: string; reference: string | null;
    expires_at: string; state: 'PENDING' | 'VERIFIED' | 'REJECTED' | 'EXPIRED'; reject_reason: string | null;
  }>> {
    const creds = await this.db.q<{
      id: string; kind: string; region_code: string; reference: string | null;
      expires_at: Date; verified: boolean; reject_reason: string | null;
    }>(
      `SELECT id, kind, region_code, reference, expires_at, verified, reject_reason
         FROM public.compliance_credentials WHERE subject_user_id = $1
        ORDER BY created_at DESC`,
      [subjectUserId],
    );
    const armed = await this.db.q<{id: string; region_code: string; permit_ref: string | null; expires_at: Date | null; authorized: boolean; reject_reason: string | null}>(
      `SELECT id, region_code, permit_ref, expires_at, authorized, reject_reason
         FROM public.armed_authorizations WHERE cpo_user_id = $1 OR created_by = $1
        ORDER BY created_at DESC`,
      [subjectUserId],
    );
    const stateOf = (verified: boolean, reject: string | null, exp: Date | null): 'PENDING' | 'VERIFIED' | 'REJECTED' | 'EXPIRED' =>
      reject ? 'REJECTED' : (exp && exp.getTime() < Date.now()) ? 'EXPIRED' : verified ? 'VERIFIED' : 'PENDING';
    return [
      ...creds.map(c => ({id: c.id, doc_type: c.kind, region_code: c.region_code, reference: c.reference, expires_at: c.expires_at.toISOString(), state: stateOf(c.verified, c.reject_reason, c.expires_at), reject_reason: c.reject_reason})),
      ...armed.map(a => ({id: a.id, doc_type: 'armed_permit', region_code: a.region_code, reference: a.permit_ref, expires_at: a.expires_at ? a.expires_at.toISOString() : '', state: stateOf(a.authorized, a.reject_reason, a.expires_at), reject_reason: a.reject_reason})),
    ];
  }

  /**
   * Admin: the PENDING review queue (optionally region-filtered).
   * DC-03 — armed permits used to have a verify endpoint but NO discovery
   * list (a submitted permit was invisible to ops). They now ride in the
   * same queue with doc_type='armed_permit' + armed:true; the console
   * routes those rows to /ops/armed/:id/verify|reject.
   */
  async listPending(regionCode?: string): Promise<Array<{id: string; doc_type: string; subject_user_id: string; provider_name: string | null; file_url: string | null; region_code: string; reference: string | null; expires_at: string; created_at: string; armed: boolean}>> {
    // IS-06 — reviewers must see WHO submitted and the DOC itself, not a bare
    // UUID: provider display name (users join) + file_url ride each row.
    // armed_authorizations carries no file column — those rows keep file_url null.
    const [creds, armed] = await Promise.all([
      this.db.q<{id: string; kind: string; subject_user_id: string; provider_name: string | null; file_url: string | null; region_code: string; reference: string | null; expires_at: Date; created_at: Date}>(
        `SELECT c.id, c.kind, c.subject_user_id, c.file_url, c.region_code, c.reference, c.expires_at, c.created_at,
                u.display_name AS provider_name
           FROM public.compliance_credentials c
           LEFT JOIN public.users u ON u.id = c.subject_user_id
          WHERE NOT c.verified AND c.reject_reason IS NULL AND ($1::text IS NULL OR c.region_code = $1)
          ORDER BY c.created_at ASC`,
        [regionCode ?? null],
      ),
      this.db.q<{id: string; cpo_user_id: string; provider_name: string | null; region_code: string; permit_ref: string | null; expires_at: Date | null; created_at: Date}>(
        `SELECT a.id, a.cpo_user_id, a.region_code, a.permit_ref, a.expires_at, a.created_at,
                u.display_name AS provider_name
           FROM public.armed_authorizations a
           LEFT JOIN public.users u ON u.id = a.cpo_user_id
          WHERE NOT a.authorized AND a.reject_reason IS NULL AND ($1::text IS NULL OR a.region_code = $1)
          ORDER BY a.created_at ASC`,
        [regionCode ?? null],
      ),
    ]);
    return [
      ...creds.map(c => ({id: c.id, doc_type: c.kind, subject_user_id: c.subject_user_id, provider_name: c.provider_name, file_url: c.file_url, region_code: c.region_code, reference: c.reference, expires_at: c.expires_at.toISOString(), created_at: c.created_at.toISOString(), armed: false})),
      ...armed.map(a => ({id: a.id, doc_type: 'armed_permit', subject_user_id: a.cpo_user_id, provider_name: a.provider_name, file_url: null, region_code: a.region_code, reference: a.permit_ref, expires_at: a.expires_at ? a.expires_at.toISOString() : '', created_at: a.created_at.toISOString(), armed: true})),
    ].sort((x, y) => x.created_at.localeCompare(y.created_at));
  }

  /** Admin verify — race-safe conditional flip from PENDING only (double-verify is a no-op). */
  async verify(adminUserId: string, credId: string): Promise<{ok: true; doc_type: string; subject_user_id: string}> {
    const row = await this.db.qOne<{kind: string; subject_user_id: string}>(
      `UPDATE public.compliance_credentials
          SET verified = TRUE, verified_by = $2, verified_at = NOW(), reject_reason = NULL, updated_at = NOW()
        WHERE id = $1 AND NOT verified AND reject_reason IS NULL
        RETURNING kind, subject_user_id`,
      [credId, adminUserId],
    );
    if (!row) throw new NotFoundException('credential_not_pending');
    return {ok: true, doc_type: row.kind, subject_user_id: row.subject_user_id};
  }

  /** Admin reject with a reason (PENDING only). */
  async reject(adminUserId: string, credId: string, reason: string): Promise<{ok: true; subject_user_id: string}> {
    // OC-13 — return the AGENT too, so the audit row is keyed on the same
    // subject as compliance.verify (a per-agent timeline that only shows
    // verifies is a hole, not a trail).
    const row = await this.db.qOne<{id: string; subject_user_id: string}>(
      `UPDATE public.compliance_credentials
          SET reject_reason = $3, verified = FALSE, verified_by = $2, verified_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND NOT verified AND reject_reason IS NULL
        RETURNING id, subject_user_id`,
      [credId, adminUserId, reason],
    );
    if (!row) throw new NotFoundException('credential_not_pending');
    return {ok: true, subject_user_id: row.subject_user_id};
  }

  /** Admin reject an armed permit with a reason (PENDING only). */
  async rejectArmed(adminUserId: string, armedId: string, reason: string): Promise<{ok: true; cpo_user_id: string}> {
    const row = await this.db.qOne<{cpo_user_id: string}>(
      `UPDATE public.armed_authorizations
          SET reject_reason = $3, authorized = FALSE, verified_by = $2, verified_at = NOW()
        WHERE id = $1 AND NOT authorized AND reject_reason IS NULL
        RETURNING cpo_user_id`,
      [armedId, adminUserId, reason],
    );
    if (!row) throw new NotFoundException('armed_permit_not_pending');
    return {ok: true, cpo_user_id: row.cpo_user_id};
  }

  /** Admin verify/reject an armed permit (flips armed_authorizations.authorized). */
  async verifyArmed(adminUserId: string, armedId: string): Promise<{ok: true; cpo_user_id: string}> {
    const row = await this.db.qOne<{cpo_user_id: string}>(
      `UPDATE public.armed_authorizations
          SET authorized = TRUE, verified_by = $2, verified_at = NOW(), reject_reason = NULL
        WHERE id = $1 AND NOT authorized AND reject_reason IS NULL
        RETURNING cpo_user_id`,
      [armedId, adminUserId],
    );
    if (!row) throw new NotFoundException('armed_permit_not_pending');
    return {ok: true, cpo_user_id: row.cpo_user_id};
  }
}
