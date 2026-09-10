import {Injectable, Logger} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';
import {ConversationsService} from '../conversations/conversations.service';

/**
 * SystemMessengerService — server-authored announcements inside the
 * existing messenger primitives.
 *
 * Why we don't encrypt these:
 *  - message_envelopes are E2E with per-recipient ciphertext. The server
 *    never holds session keys, so it cannot write envelopes.
 *  - system_broadcasts are intentionally plaintext, written by the ops
 *    pipeline, and rendered client-side as inline cards alongside
 *    decrypted envelopes. They carry no confidential content (booking
 *    IDs + status events) — the sensitive crypto channel (envelopes) is
 *    unchanged.
 *
 * This service does two jobs:
 *   1. ensureSystemDirect(userId) — returns the direct conversation
 *      between a user and the Bravo System actor; creates it on first
 *      use so every client has one persistent "Bravo System" thread.
 *   2. createMissionOpsRoom(…)  — creates a group conversation for a
 *      mission and seeds the first system card. Reused by the booking
 *      approve + mission dispatch flows.
 */
@Injectable()
export class SystemMessengerService {
  private readonly log = new Logger(SystemMessengerService.name);

  /** Deterministic UUID for the seeded Bravo System user. */
  static readonly SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000001';

  constructor(
    private readonly db: DatabaseService,
    private readonly convs: ConversationsService,
  ) {}

  // ─── Direct "Bravo System" conversation per client ─────────────────

  /**
   * Returns the conversation_id of the direct thread between the given
   * user and the Bravo System actor. Creates it on first call and
   * caches it via the existing conversations.create() path so
   * membership + audit triggers fire consistently.
   */
  async ensureSystemDirect(userId: string): Promise<string> {
    const existing = await this.db.qOne<{id: string}>(
      `SELECT c.id
         FROM public.conversations c
         JOIN public.conversation_members a ON a.conversation_id = c.id AND a.user_id = $1
         JOIN public.conversation_members b ON b.conversation_id = c.id AND b.user_id = $2
        WHERE c.kind = 'direct'
        LIMIT 1`,
      [userId, SystemMessengerService.SYSTEM_USER_ID],
    );
    if (existing) return existing.id;

    const created = await this.convs.create(
      SystemMessengerService.SYSTEM_USER_ID,
      'direct',
      [userId],
      'Bravo System',
    );
    return created.id;
  }

  // ─── Broadcast insertion ──────────────────────────────────────────

  async broadcast(entry: {
    conversationId: string;
    kind: string;
    title: string;
    body: string;
    severity?: 'info' | 'ok' | 'warn' | 'err';
    subject_type?: 'booking' | 'mission' | 'job' | 'agent';
    subject_id?: string;
    payload?: Record<string, unknown>;
  }): Promise<{id: string}> {
    const row = await this.db.qOne<{id: string}>(
      `INSERT INTO public.system_broadcasts
         (conversation_id, kind, title, body, severity,
          subject_type, subject_id, payload, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
       RETURNING id`,
      [
        entry.conversationId, entry.kind, entry.title, entry.body,
        entry.severity ?? 'info',
        entry.subject_type ?? null,
        entry.subject_id ?? null,
        JSON.stringify(entry.payload ?? {}),
        SystemMessengerService.SYSTEM_USER_ID,
      ],
    );
    if (!row) throw new Error('system_broadcasts insert returned no row');
    return row;
  }

  /** Send a booking-approved card to the client's Bravo System thread. */
  async sendBookingApproved(args: {
    client_user_id: string;
    booking_id: string;
    job_short_code: string;
    pickup_address: string;
    dropoff_address: string | null;
    start_time: string;
    total_aed: number | string;
  }): Promise<{conversation_id: string; broadcast_id: string}> {
    const conversation_id = await this.ensureSystemDirect(args.client_user_id);
    const {id} = await this.broadcast({
      conversationId: conversation_id,
      kind: 'booking_approved',
      severity: 'ok',
      title: 'Booking approved',
      body: `Your booking ${args.job_short_code.toUpperCase()} has been approved by ops and is now open to crew applications. You'll be notified when a crew is assigned.`,
      subject_type: 'booking',
      subject_id: args.booking_id,
      payload: {
        booking_id: args.booking_id,
        job_short_code: args.job_short_code,
        pickup: args.pickup_address,
        dropoff: args.dropoff_address,
        start_time: args.start_time,
        total_aed: args.total_aed,
      },
    });
    return {conversation_id, broadcast_id: id};
  }

  async sendBookingRejected(args: {
    client_user_id: string;
    booking_id: string;
    reason: string;
    notes?: string;
  }): Promise<{conversation_id: string; broadcast_id: string}> {
    const conversation_id = await this.ensureSystemDirect(args.client_user_id);
    const {id} = await this.broadcast({
      conversationId: conversation_id,
      kind: 'booking_rejected',
      severity: 'warn',
      title: 'Booking not approved',
      body: `Ops could not approve your booking. Reason: ${args.reason}. ${args.notes ?? ''}`.trim(),
      subject_type: 'booking',
      subject_id: args.booking_id,
      payload: {booking_id: args.booking_id, reason: args.reason, notes: args.notes},
    });
    return {conversation_id, broadcast_id: id};
  }

  // ─── Mission Ops Room group ───────────────────────────────────────

  /**
   * Create the mission's Ops Room group chat. Members: client, assigned
   * crew agents, and the ops admin who dispatched it. The mission row's
   * `comms_channel_id` is set to the new conversation so the mission
   * detail UI can deep-link to it.
   *
   * Idempotent — returns the existing conversation if the mission
   * already has a `comms_channel_id`.
   */
  async createMissionOpsRoom(args: {
    mission_id: string;
    mission_short_code: string;
    booking_client_id: string | null;
    crew_user_ids: string[];
    ops_admin_user_id: string;
    // Step 12 (auto-dispatch): the AGENCY company-agent device must own the Ops Room
    // so it — and only it, a real member device that holds the group key — can run
    // addGroupMember/planAddAndRekey when CPOs are assigned. Defaults to the ops admin
    // for the legacy/admin-dispatch path (byte-identical behaviour when omitted). The
    // creator must be a real member device: NEVER pass SYSTEM_USER_ID here (it holds no key).
    creator_user_id?: string;
  }): Promise<{conversation_id: string; created: boolean}> {
    const existing = await this.db.qOne<{comms_channel_id: string | null}>(
      `SELECT comms_channel_id FROM missions WHERE id = $1`,
      [args.mission_id],
    );
    if (existing?.comms_channel_id) {
      return {conversation_id: existing.comms_channel_id, created: false};
    }

    const creator = args.creator_user_id ?? args.ops_admin_user_id;
    const memberIds = [
      ...args.crew_user_ids,
      ...(args.booking_client_id ? [args.booking_client_id] : []),
    ].filter(id => id !== creator);

    // This string is the group's NAME, so it is what the client and the crew see
    // as the title of an incoming mission call. Shouted-caps "OPS ROOM" broke the
    // locked client-facing terminology (it is the Bravo Control System) and read
    // as a system identifier rather than a call from their detail.
    const title = `Mission ${args.mission_short_code} · Bravo Control System`;

    const conv = await this.convs.create(
      creator,                   // creator = room admin (agency device on the auto path)
      'group',
      memberIds,
      title,
    );

    await this.db.q(
      `UPDATE missions SET comms_channel_id = $2 WHERE id = $1`,
      [args.mission_id, conv.id],
    );

    await this.broadcast({
      conversationId: conv.id,
      kind: 'mission_started',
      severity: 'ok',
      title: 'Mission dispatched',
      body: `Ops room is live. Mission ${args.mission_short_code} crew can coordinate here. All messages are end-to-end encrypted.`,
      subject_type: 'mission',
      subject_id: args.mission_id,
      payload: {
        mission_short_code: args.mission_short_code,
        crew: args.crew_user_ids,
        dispatched_by: args.ops_admin_user_id,
      },
    });

    return {conversation_id: conv.id, created: true};
  }

  /** Post a mission event (SOS, waypoint, complete) into the Ops Room. */
  async sendMissionEvent(args: {
    conversation_id: string;
    mission_id: string;
    mission_short_code: string;
    kind:
      | 'mission_pickup'
      | 'mission_live'
      | 'mission_sos'
      | 'mission_sos_ack'
      | 'mission_sos_resolved'
      | 'mission_abort'
      | 'mission_complete';
    by?: string;
    message: string;
    severity?: 'info' | 'ok' | 'warn' | 'err';
  }): Promise<void> {
    await this.broadcast({
      conversationId: args.conversation_id,
      kind: args.kind,
      severity: args.severity ?? (args.kind.includes('sos') ? 'err' : 'info'),
      title: args.message.split('·')[0].trim(),
      body: args.message,
      subject_type: 'mission',
      subject_id: args.mission_id,
      payload: {mission_short_code: args.mission_short_code, by: args.by},
    });
  }

  /**
   * Seat metadata members in an existing room, idempotently.
   *
   * METADATA ONLY — this grants no group key (BUILD_RUNBOOK "membership is
   * metadata-only … do not touch group plaintext or group keys here"). The
   * crypto half is still the agency device draining a `dispatch_room_intents`
   * add-intent and running planAddAndRekey.
   *
   * Why this exists: `createMissionOpsRoom` seats members only on FIRST
   * creation (it short-circuits on an existing `comms_channel_id`), so a CPO
   * crewed onto an already-open room got the rekey but no `conversation_members`
   * row — and `listMine` is membership-joined, so the room was invisible to
   * them AND actively pruned off their device by MessengerHomeScreen's
   * server-reconciliation sweep.
   *
   * Returns the ids that were actually inserted (already-seated ids are
   * skipped), so the caller can enqueue key intents for exactly those.
   */
  async ensureRoomMembers(conversationId: string, userIds: string[]): Promise<string[]> {
    const unique = Array.from(new Set(userIds.filter(Boolean)));
    if (unique.length === 0) {return [];}
    const rows = await this.db.q<{user_id: string}>(
      `INSERT INTO public.conversation_members (conversation_id, user_id, role)
       SELECT $1, uid, 'member' FROM unnest($2::uuid[]) AS uid
       ON CONFLICT DO NOTHING
       RETURNING user_id`,
      [conversationId, unique],
    );
    return rows.map(r => r.user_id);
  }

  /**
   * B-207 — HARD-DELETE a mission's Ops Room for EVERYONE (founder directive:
   * delete the whole group on completion, not archive — this supersedes the
   * B-191 archive design). Lifted from the settlement release path so every
   * completion boundary shares one primitive.
   *
   * Order matters and is load-bearing:
   *   1. SET NULL the back-references (lite_bookings.conversation_id,
   *      missions.comms_channel_id) so the booking/mission rows survive.
   *   2. DELETE dispatch_room_intents — CRITICAL: a leftover pending add-intent
   *      would make a later agency drain re-mint a GHOST room for a dead id.
   *   3. DELETE conversation_members, system_broadcasts, then the conversation.
   *
   * Server-side metadata only — no group keys touched (the relay is group-blind).
   * Idempotent: a missing/already-deleted conversation is a clean no-op. Wrapped
   * in one txn so a mid-sequence failure never leaves a half-deleted room. Devices
   * shed their local copy on the next MessengerHomeScreen reconciliation sweep
   * (listMine stops returning the row → prune), which also evicts the group key.
   */
  async deleteMissionRoom(conversationId: string, _reason: string): Promise<void> {
    if (!conversationId) {return;}
    await this.db.withTransaction(async tx => {
      const c = [conversationId];
      await tx.q(`UPDATE public.lite_bookings SET conversation_id = NULL WHERE conversation_id = $1`, c);
      await tx.q(`UPDATE public.missions SET comms_channel_id = NULL WHERE comms_channel_id = $1`, c);
      await tx.q(`DELETE FROM public.dispatch_room_intents WHERE conversation_id = $1`, c);
      await tx.q(`DELETE FROM public.conversation_members WHERE conversation_id = $1`, c);
      await tx.q(`DELETE FROM public.system_broadcasts WHERE conversation_id = $1`, c);
      await tx.q(`DELETE FROM public.conversations WHERE id = $1`, c);
    });
  }

  // ─── Read (list broadcasts) ───────────────────────────────────────

  listForConversation(conversationId: string, limit = 50) {
    return this.db.q(
      `SELECT id, kind, title, body, severity, subject_type, subject_id,
              payload, created_at
         FROM public.system_broadcasts
        WHERE conversation_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [conversationId, limit],
    );
  }

  listForSubject(subjectType: string, subjectId: string, limit = 50) {
    return this.db.q(
      `SELECT id, conversation_id, kind, title, body, severity,
              payload, created_at
         FROM public.system_broadcasts
        WHERE subject_type = $1 AND subject_id = $2
        ORDER BY created_at DESC
        LIMIT $3`,
      [subjectType, subjectId, limit],
    );
  }
}
