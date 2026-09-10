import {Injectable} from '@nestjs/common';
import {DatabaseService, type Tx} from '../database/database.service';

/**
 * Org-manager-scoped audit log (Dept Chat v2). Every sensitive provider action
 * — attendance review approve/reject, day-status set, export, incident status
 * change / assignment — writes one row here.
 *
 * This is the ORG tier. Do NOT route provider actions through OpsAuditService
 * (the HQ / AdminGuard tier) or vice versa — they are intentionally separate.
 *
 * 🛑 `metadata` must hold NO PII: no incident descriptions, no coordinates, no
 * credential refs. Coarse keys only (decision, from/to, format, counts). The
 * static log-audit test + CLAUDE.md enforce this.
 */
@Injectable()
export class OrgAuditService {
  constructor(private readonly db: DatabaseService) {}

  async log(
    orgUserId: string,
    actorId: string,
    action: string,
    opts?: {
      targetKind?: string;
      targetId?: string;
      metadata?: Record<string, unknown>;
      // Pass the surrounding transaction so the audit row commits atomically
      // with the action it records (e.g. the status change).
      tx?: Tx;
    },
  ): Promise<void> {
    const runner: Pick<Tx, 'q'> = opts?.tx ?? this.db;
    await runner.q(
      `INSERT INTO org_audit_log (org_user_id, actor_id, action, target_kind, target_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [orgUserId, actorId, action, opts?.targetKind ?? null, opts?.targetId ?? null,
       JSON.stringify(opts?.metadata ?? {})],
    );
  }
}
