import {Injectable, NotFoundException} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';

export interface DispatchRoomIntent {
  id: string;
  booking_id: string;
  conversation_id: string;
  member_user_id: string;
  action: 'add' | 'remove';
  created_at: string;
  // MISSION-GROUP (area 5) — the agency device bootstraps the Ops Room E2EE
  // group before applying adds; it needs the client (the room's initial
  // non-agency member) and the room title. The relay still holds no key.
  client_id: string;
  conversation_title: string | null;
}

/**
 * Dispatch-room membership-intent queue (BUILD_RUNBOOK Step 12) — the booking-Ops-Room
 * parallel of DepartmentService's channel-membership intents. The relay holds NO group
 * key: when an agency assigns/removes a CPO to a booking's Ops Room, the server records
 * the metadata + ENQUEUES an intent here; the AGENCY's device (the room creator/admin)
 * drains it and broadcasts the actual Signal rekey (planAddAndRekey / planRemoveAndRekey),
 * acking only after the rekey lands. This service writes/reads the queue only — it never
 * touches key material. Scoped by `org_user_id` (the agency) rather than channel-admin
 * membership, since the OrgManagerGuard already proves the caller owns that org.
 */
@Injectable()
export class DispatchRoomIntentsService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Enqueue one add/remove intent for the agency to drain. Called (Step 13) from the
   * crew-assign handler — once per assigned/removed CPO. Pure INSERT; the agency device's
   * drain does the rekey. `orgUserId` is the agency that owns + must drain the room.
   */
  async enqueueRoomIntent(
    orgUserId: string,
    bookingId: string,
    conversationId: string,
    memberUserId: string,
    action: 'add' | 'remove',
    requestedBy: string,
  ): Promise<void> {
    /**
     * Idempotent enqueue: skip a same-(booking, member, action) intent that is
     * already pending or done, so crew-assign can safely RE-enqueue on a
     * resume/retry without minting a duplicate the agency device would loop on
     * (an already-member `addGroupMember` throws and never acks).
     *
     * ── B-416 FOLLOW-UP: "done" IS NOT TERMINAL FOR THE MEMBER ───────────────
     *
     * The dedup used to look only at whether ANY same-action intent existed in
     * ('pending','done'), which silently made re-adding impossible:
     *
     *   1. CPO assigned      → add  → drained → (add, done)
     *   2. CPO removed       → remove → drained → (remove, done); the agency
     *      device rekeys the room and the CPO no longer holds the key
     *   3. CPO assigned AGAIN → the stale (add, done) from step 1 matches, the
     *      INSERT is skipped, and NO add-intent is ever produced.
     *
     * The member is then SEATED (`conversations` membership is written by the
     * mission service, not by this queue) but KEYLESS. They are rung, they
     * accept, and they fail the 25s in-call key wait — the "the CPO can't join
     * the Ops Room call" report, with a completely green server.
     *
     * So a same-action intent only suppresses when it is NEWER than the last
     * OPPOSING one. Same-action spam inside one membership episode is still
     * deduped exactly as before; a genuine remove→re-add always enqueues.
     */
    await this.db.q(
      `INSERT INTO public.dispatch_room_intents
         (org_user_id, booking_id, conversation_id, member_user_id, action, requested_by)
       SELECT $1, $2, $3, $4, $5, $6
        WHERE NOT EXISTS (
          SELECT 1 FROM public.dispatch_room_intents s
           WHERE s.booking_id = $2 AND s.member_user_id = $4 AND s.action = $5
             AND s.state IN ('pending', 'done')
             AND s.created_at > COALESCE(
               (SELECT MAX(o.created_at) FROM public.dispatch_room_intents o
                 WHERE o.booking_id = $2 AND o.member_user_id = $4 AND o.action <> $5
                   AND o.state IN ('pending', 'done')),
               '-infinity'::timestamptz))`,
      [orgUserId, bookingId, conversationId, memberUserId, action, requestedBy],
    );
  }

  /** Pending room intents for the caller's agency, oldest first — drained by the
   *  agency device, which broadcasts the corresponding rekey. */
  async listRoomIntents(orgUserId: string): Promise<DispatchRoomIntent[]> {
    return this.db.q<DispatchRoomIntent>(
      `SELECT i.id, i.booking_id, i.conversation_id, i.member_user_id, i.action, i.created_at,
              b.client_id,
              c.title AS conversation_title
         FROM public.dispatch_room_intents i
         JOIN public.lite_bookings b ON b.id = i.booking_id
         LEFT JOIN public.conversations c ON c.id = i.conversation_id
        WHERE i.org_user_id = $1 AND i.state = 'pending'
        ORDER BY i.created_at ASC`,
      [orgUserId],
    );
  }

  /**
   * Agency device acks it has broadcast the rekey for an intent. Race-safe + IDOR-safe:
   * the conditional UPDATE fuses exactly-once (`state='pending'`) with the org-scope
   * authorization (`org_user_id=$2`) in one statement, so a second ack — or a cross-org
   * caller — matches 0 rows → an ambiguous 404 (never leaks whether the intent exists).
   */
  async ackRoomIntent(orgUserId: string, intentId: string): Promise<{ok: true}> {
    const row = await this.db.qOne<{id: string}>(
      `UPDATE public.dispatch_room_intents
          SET state = 'done', settled_at = NOW()
        WHERE id = $1 AND state = 'pending' AND org_user_id = $2
        RETURNING id`,
      [intentId, orgUserId],
    );
    if (!row) throw new NotFoundException('intent_not_found_or_not_org');
    return {ok: true};
  }

  /**
   * B-416 — atomically claim the SINGLE E2EE key authority for one Ops Room.
   *
   * Key authority used to be implicitly "the agency owner's device"; an
   * offline owner stranded every member keyless. Authority is now WHOEVER
   * WINS THIS CLAIM — the owner or any delegated manager (OrgManagerGuard
   * admits both with the same org scope) — and every losing device stands
   * down, which is what makes two admin devices structurally unable to mint
   * diverging keys for one room (the B-35 permanent-fork class).
   *
   * The PRIMARY KEY on conversation_id IS the arbitration: first
   * INSERT ... ON CONFLICT DO NOTHING wins; later callers read the existing
   * claimant back and skip. `claimed_by` is the CALLER's user id, not the
   * org id — on a manager win the manager's account becomes the room's
   * crypto owner (state.owner) when its device mints.
   *
   * Org scoping rides the intent rows (they were written server-side with
   * the owning org), so a cross-org or workspace-tenant caller gets the
   * same ambiguous 404 the ack path uses — never a hint the room exists.
   * This service still never touches key material.
   */
  async claimRoomCrypto(
    orgUserId: string,
    callerUserId: string,
    conversationId: string,
  ): Promise<{claimed_by: string}> {
    const scoped = await this.db.qOne<{ok: number}>(
      `SELECT 1 AS ok FROM public.dispatch_room_intents
        WHERE conversation_id = $1 AND org_user_id = $2 LIMIT 1`,
      [conversationId, orgUserId],
    );
    if (!scoped) throw new NotFoundException('room_not_found_or_not_org');
    const ins = await this.db.qOne<{claimed_by: string}>(
      `INSERT INTO public.dispatch_room_crypto_claims (conversation_id, claimed_by)
       VALUES ($1, $2) ON CONFLICT (conversation_id) DO NOTHING
       RETURNING claimed_by`,
      [conversationId, callerUserId],
    );
    if (ins) return {claimed_by: ins.claimed_by};
    const cur = await this.db.qOne<{claimed_by: string}>(
      `SELECT claimed_by FROM public.dispatch_room_crypto_claims
        WHERE conversation_id = $1`,
      [conversationId],
    );
    // Room hard-deleted between the conflict and the read (FK cascade) —
    // same ambiguous 404.
    if (!cur) throw new NotFoundException('room_not_found_or_not_org');
    return {claimed_by: cur.claimed_by};
  }
}
