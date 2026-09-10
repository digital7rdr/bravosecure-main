import {
  BadRequestException, ForbiddenException, Injectable, NotFoundException,
} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';

export interface ConversationRecord {
  id:         string;
  kind:       'direct' | 'group';
  title:      string | null;
  createdAt:  string;
  createdBy:  string;
  members:    Array<{userId: string; displayName: string; role: 'admin' | 'member'; joinedAt: string}>;
  myRole:     'admin' | 'member';
}

interface ConvRow {
  id:         string;
  kind:       'direct' | 'group';
  title:      string | null;
  created_at: string;
  created_by: string;
}

interface MemberRow {
  conversation_id: string;
  user_id:         string;
  role:            'admin' | 'member';
  joined_at:       string;
  display_name:    string;
}

/**
 * Conversations + group-membership CRUD.
 *
 * Model notes:
 *  - Admins can rename + add/remove members + delete the conversation.
 *  - Members can leave (== remove self).
 *  - Creator defaults to `admin`; the last admin leaving promotes the
 *    next-oldest member to admin so a conversation never becomes
 *    orphaned.
 *  - This service handles METADATA only. Sender-key distribution for
 *    group E2E lives in the messenger-service / crypto layer (Phase-2).
 */
@Injectable()
export class ConversationsService {
  constructor(private readonly db: DatabaseService) {}

  async create(
    creatorId: string,
    kind: 'direct' | 'group',
    memberIds: string[],
    title?: string,
  ): Promise<ConversationRecord> {
    const unique = Array.from(new Set([creatorId, ...memberIds]));
    if (kind === 'direct' && unique.length !== 2) {
      throw new BadRequestException('direct conversations must have exactly 2 members');
    }
    if (kind === 'group' && unique.length < 2) {
      throw new BadRequestException('group needs at least one other member');
    }

    const row = await this.db.qOne<ConvRow>(
      `INSERT INTO public.conversations (kind, title, created_by)
       VALUES ($1, $2, $3)
       RETURNING id, kind, title, created_at, created_by`,
      [kind, title ?? null, creatorId],
    );
    if (!row) throw new Error('conversation insert returned no row');

    // Single batched insert for all members. Creator is admin; others
    // default to member. Postgres array-unnest gives us one round-trip.
    await this.db.q(
      `INSERT INTO public.conversation_members (conversation_id, user_id, role)
       SELECT $1, uid, CASE WHEN uid = $2 THEN 'admin' ELSE 'member' END
         FROM unnest($3::uuid[]) AS uid
         ON CONFLICT DO NOTHING`,
      [row.id, creatorId, unique],
    );

    return this.getForUser(row.id, creatorId);
  }

  async listMine(userId: string): Promise<ConversationRecord[]> {
    // Archived rooms (e.g. completed/aborted mission ops-rooms) drop off
    // the active channel list — history remains accessible by direct id
    // for audit/read-only replay.
    const rows = await this.db.q<ConvRow & {my_role: 'admin' | 'member'}>(
      `SELECT c.id, c.kind, c.title, c.created_at, c.created_by, cm.role AS my_role
         FROM public.conversations c
         JOIN public.conversation_members cm
           ON cm.conversation_id = c.id AND cm.user_id = $1
        WHERE c.archived_at IS NULL
        ORDER BY c.created_at DESC`,
      [userId],
    );
    if (rows.length === 0) return [];
    const members = await this.membersFor(rows.map(r => r.id));
    return rows.map(r => ({
      id:         r.id,
      kind:       r.kind,
      title:      r.title,
      createdAt:  r.created_at,
      createdBy:  r.created_by,
      members:    members.get(r.id) ?? [],
      myRole:     r.my_role,
    }));
  }

  async getForUser(convId: string, userId: string): Promise<ConversationRecord> {
    const myRole = await this.roleOf(convId, userId);
    if (!myRole) throw new NotFoundException('conversation_not_found_or_forbidden');
    const row = await this.db.qOne<ConvRow>(
      `SELECT id, kind, title, created_at, created_by
         FROM public.conversations WHERE id = $1`,
      [convId],
    );
    if (!row) throw new NotFoundException('conversation_not_found_or_forbidden');
    const map = await this.membersFor([convId]);
    // Audit fix 4.7 — if the reader is an ops admin, log the read.
    // E2EE means we can't see the bodies, but visibility into the
    // metadata (which conversation, which admin, when) is still useful
    // for detecting cross-customer leakage. Fire-and-forget — a logging
    // failure must NEVER refuse the read.
    void this.maybeAuditOpsRead(userId, convId, row.kind);
    return {
      id:         row.id,
      kind:       row.kind,
      title:      row.title,
      createdAt:  row.created_at,
      createdBy:  row.created_by,
      members:    map.get(row.id) ?? [],
      myRole,
    };
  }

  /**
   * Audit fix 4.7 — if the caller is in admin_users, write a read row to
   * ops_audit. Uses a direct INSERT instead of OpsAuditService to avoid
   * a circular module dependency (ops → conversations → ops). Errors are
   * swallowed; this is a logging hook, not a security gate (membership
   * check above is the gate).
   */
  private async maybeAuditOpsRead(userId: string, convId: string, kind: string): Promise<void> {
    try {
      const admin = await this.db.qOne<{role: string; call_sign: string}>(
        `SELECT role, call_sign FROM public.admin_users
          WHERE user_id = $1 AND active = TRUE`,
        [userId],
      );
      if (!admin) return;       // not an admin — no audit row
      await this.db.q(
        `INSERT INTO ops_audit
           (actor_id, actor_role, actor_call, action, subject_type, subject_id, metadata)
         VALUES ($1, $2, $3, 'conversation.read', 'conversation', $4, $5::jsonb)`,
        [userId, admin.role, admin.call_sign, convId, JSON.stringify({kind})],
      );
    } catch {
      // Swallow — audit failure must not refuse the read.
    }
  }

  async rename(convId: string, userId: string, title: string): Promise<ConversationRecord> {
    await this.requireAdmin(convId, userId);
    await this.db.q(`UPDATE public.conversations SET title = $1 WHERE id = $2`, [title, convId]);
    return this.getForUser(convId, userId);
  }

  async addMember(convId: string, userId: string, newMemberId: string): Promise<ConversationRecord> {
    await this.requireAdmin(convId, userId);
    const inserted = await this.db.qOne<{user_id: string}>(
      `INSERT INTO public.conversation_members (conversation_id, user_id, role)
       VALUES ($1, $2, 'member')
       ON CONFLICT DO NOTHING
       RETURNING user_id`,
      [convId, newMemberId],
    );
    // RS-02 — the metadata row alone gives the new member no group key. Queue
    // the intent so an admin DEVICE distributes the key (planAddAndRekey), the
    // same seam department channels + dispatch rooms use. Server holds no key.
    if (inserted) {
      await this.enqueueIntent(convId, newMemberId, 'add', userId);
      void this.auditMembershipEvent(userId, convId, 'conversation.member.add', {member: newMemberId});
    }
    return this.getForUser(convId, userId);
  }

  async removeMember(convId: string, userId: string, target: string): Promise<void> {
    const myRole = await this.roleOf(convId, userId);
    if (!myRole) throw new NotFoundException('conversation_not_found_or_forbidden');
    // Self-removal is always allowed (leaving).
    if (target !== userId && myRole !== 'admin') {
      throw new ForbiddenException('only_admin_can_remove_others');
    }
    const removed = await this.db.qOne<{user_id: string}>(
      `DELETE FROM public.conversation_members
        WHERE conversation_id = $1 AND user_id = $2
        RETURNING user_id`,
      [convId, target],
    );
    // RS-02 — without the rekey the removed member keeps the group master key
    // (≤30d relay dwell). Queue the remove intent; an admin device broadcasts
    // planRemoveAndRekey (remove @E, fresh key @E+1) and acks.
    if (removed) {
      await this.enqueueIntent(convId, target, 'remove', userId);
      void this.auditMembershipEvent(userId, convId, 'conversation.member.remove', {member: target});
    }
    // Last-admin-left promotion: if no admin remains, promote oldest member.
    const anyAdmin = await this.db.qOne<{user_id: string}>(
      `SELECT user_id FROM public.conversation_members
        WHERE conversation_id = $1 AND role = 'admin' LIMIT 1`,
      [convId],
    );
    if (!anyAdmin) {
      const nextAdmin = await this.db.qOne<{user_id: string}>(
        `SELECT user_id FROM public.conversation_members
          WHERE conversation_id = $1
          ORDER BY joined_at ASC LIMIT 1`,
        [convId],
      );
      if (nextAdmin) {
        await this.db.q(
          `UPDATE public.conversation_members
              SET role = 'admin'
            WHERE conversation_id = $1 AND user_id = $2`,
          [convId, nextAdmin.user_id],
        );
        // RS-08 — this roster flip confers SERVER-side admin power with no
        // cryptographic provenance (clients' GroupState ignores it: no signed
        // 'promote' action exists, so the promoted member gains no crypto
        // authority). Make the silent event visible in ops_audit; the signed
        // handover itself is an architecture-gated change.
        void this.auditMembershipEvent(nextAdmin.user_id, convId, 'conversation.admin.autopromote', {
          promoted: nextAdmin.user_id, after_leave_of: target,
        });
      }
    }
  }

  // ─── RS-02 — membership intents (drained by a conversation-admin device) ──

  private async enqueueIntent(
    convId: string, memberUserId: string, action: 'add' | 'remove', requestedBy: string,
  ): Promise<void> {
    await this.db.q(
      `INSERT INTO public.conversation_membership_intents
         (conversation_id, member_user_id, action, requested_by)
       VALUES ($1, $2, $3, $4)`,
      [convId, memberUserId, action, requestedBy],
    );
  }

  /** Pending intents for conversations the caller administers. */
  async listMembershipIntents(userId: string): Promise<Array<{
    id: string; conversation_id: string; member_user_id: string;
    action: 'add' | 'remove'; created_at: string;
  }>> {
    return this.db.q(
      `SELECT i.id, i.conversation_id, i.member_user_id, i.action, i.created_at
         FROM public.conversation_membership_intents i
         JOIN public.conversation_members m
           ON m.conversation_id = i.conversation_id AND m.user_id = $1 AND m.role = 'admin'
        WHERE i.state = 'pending'
        ORDER BY i.created_at ASC`,
      [userId],
    );
  }

  /** Admin device acks it has broadcast the rekey for an intent. */
  async ackMembershipIntent(userId: string, intentId: string): Promise<{ok: true}> {
    const row = await this.db.qOne<{id: string}>(
      `UPDATE public.conversation_membership_intents i
          SET state = 'done', settled_at = NOW()
        WHERE i.id = $1 AND i.state = 'pending'
          AND EXISTS (
            SELECT 1 FROM public.conversation_members m
             WHERE m.conversation_id = i.conversation_id AND m.user_id = $2 AND m.role = 'admin'
          )
        RETURNING i.id`,
      [intentId, userId],
    );
    if (!row) throw new NotFoundException('intent_not_found_or_not_admin');
    return {ok: true};
  }

  /**
   * Swallow-safe ops_audit row for membership/role events (RS-02/RS-08 —
   * these were previously invisible). Direct INSERT for the same
   * circular-dependency reason as maybeAuditOpsRead. Actor role is looked
   * up from admin_users; non-admin actors record as AGENT.
   */
  private async auditMembershipEvent(
    actorId: string, convId: string, action: string, metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      const admin = await this.db.qOne<{role: string; call_sign: string}>(
        `SELECT role, call_sign FROM public.admin_users
          WHERE user_id = $1 AND active = TRUE`,
        [actorId],
      );
      await this.db.q(
        `INSERT INTO ops_audit
           (actor_id, actor_role, actor_call, action, subject_type, subject_id, metadata)
         VALUES ($1, $2, $3, $4, 'conversation', $5, $6::jsonb)`,
        [actorId, admin?.role ?? 'AGENT', admin?.call_sign ?? null, action, convId,
         JSON.stringify(metadata)],
      );
    } catch {
      // Swallow — audit failure must not refuse the membership change.
    }
  }

  async remove(convId: string, userId: string): Promise<void> {
    await this.requireAdmin(convId, userId);
    await this.db.q(`DELETE FROM public.conversations WHERE id = $1`, [convId]);
  }

  // ─── helpers ─────────────────────────────────────────────────────

  private async roleOf(convId: string, userId: string): Promise<'admin' | 'member' | null> {
    const row = await this.db.qOne<{role: 'admin' | 'member'}>(
      `SELECT role FROM public.conversation_members
        WHERE conversation_id = $1 AND user_id = $2`,
      [convId, userId],
    );
    return row?.role ?? null;
  }

  private async requireAdmin(convId: string, userId: string): Promise<void> {
    const role = await this.roleOf(convId, userId);
    if (!role)              throw new NotFoundException('conversation_not_found_or_forbidden');
    if (role !== 'admin')   throw new ForbiddenException('only_admin_can_do_that');
  }

  private async membersFor(convIds: string[]): Promise<Map<string, ConversationRecord['members']>> {
    if (convIds.length === 0) return new Map();
    const rows = await this.db.q<MemberRow>(
      `SELECT cm.conversation_id, cm.user_id, cm.role, cm.joined_at, u.display_name
         FROM public.conversation_members cm
         JOIN public.users u ON u.id = cm.user_id AND u.deleted_at IS NULL
        WHERE cm.conversation_id = ANY($1)`,
      [convIds],
    );
    const out = new Map<string, ConversationRecord['members']>();
    for (const r of rows) {
      const arr = out.get(r.conversation_id) ?? [];
      arr.push({userId: r.user_id, displayName: r.display_name, role: r.role, joinedAt: r.joined_at});
      out.set(r.conversation_id, arr);
    }
    return out;
  }
}
