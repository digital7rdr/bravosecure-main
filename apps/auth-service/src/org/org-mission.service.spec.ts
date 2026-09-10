/**
 * sqa.md bug register — this suite pins: B-192.
 *
 * B-192 (the assigned CPO was never a MEMBER of the Ops Room — createMissionOpsRoom was
 * called with crew_user_ids: [] so the CPO got only the crypto half, a
 * dispatch_room_intents add-intent, and no conversation_members row; listMine is
 * membership-joined so the room was invisible, and MessengerHomeScreen's prune then DELETED
 * the room the CPO had just been bootstrapped into) is pinned by "seats the crew AND the
 * org managers, and enqueues a key intent for each". Both halves are required: seating
 * without the intent shows an undecryptable room, the intent without seating shows nothing.
 */
import {OrgMissionService} from './org-mission.service';
import type {DatabaseService} from '../database/database.service';
import type {SystemMessengerService} from '../ops/system-messenger.service';
import type {BookingPushBridge} from '../ops/booking-push-bridge.service';
import type {DispatchRoomIntentsService} from '../dispatch/dispatch-room-intents.service';
import {ForbiddenException, ServiceUnavailableException} from '@nestjs/common';

const ORG = 'org-A';
const MGR = 'mgr-1';

function mk(opts: {
  booking?: Record<string, unknown> | null;
  members?: Array<{member_user_id: string; call_sign: string | null; agent_status: string | null; on_duty?: boolean}>;
  busy?: Array<{agent_id: string}>;
  armed?: Array<{cpo_user_id: string}>;
  crewInsertThrows?: boolean;
  resume?: Record<string, unknown> | null;
  resumeCrew?: Array<{agent_id: string; is_lead?: boolean}>;
  managers?: Array<{member_user_id: string}>;
  /** Issue 11 — the Ops Room could not be opened. */
  roomThrows?: boolean;
  /** Issue 11 — a lead raced the rollback to PICKUP, so the abort matches 0 rows. */
  rollbackAbortsNothing?: boolean;
}) {
  const txQ = jest.fn().mockImplementation((sql: string) => {
    if (/FROM org_members/.test(sql)) return Promise.resolve(opts.members ?? []);
    if (/FROM mission_crew mc/.test(sql)) return Promise.resolve(opts.busy ?? []);
    if (/FROM armed_authorizations/.test(sql)) return Promise.resolve(opts.armed ?? []);
    if (/INSERT INTO mission_crew/.test(sql)) {
      if (opts.crewInsertThrows) return Promise.reject(new Error('duplicate key value violates unique constraint "mission_crew_agent_active_uq" (23505)'));
      return Promise.resolve([]);
    }
    if (/UPDATE missions SET status = 'ABORTED'/.test(sql)) {
      return Promise.resolve(opts.rollbackAbortsNothing ? [] : [{id: 'm1'}]);
    }
    return Promise.resolve([]);
  });
  const txQOne = jest.fn().mockImplementation((sql: string) => {
    if (/UPDATE lite_bookings\s+SET status = 'CONFIRMED'/.test(sql)) return Promise.resolve(opts.booking ?? null);
    if (/INSERT INTO missions/.test(sql)) return Promise.resolve({id: 'm1'});
    return Promise.resolve(null);
  });
  const tx = {q: txQ, qOne: txQOne};
  const db = {
    q: jest.fn().mockImplementation((sql: string) => {
      if (/SELECT agent_id, is_lead FROM mission_crew/.test(sql)) {return Promise.resolve(opts.resumeCrew ?? []);}
      if (/member_role = 'manager'/.test(sql)) {return Promise.resolve(opts.managers ?? []);}
      return Promise.resolve([]);
    }),
    qOne: jest.fn().mockResolvedValue(opts.resume ?? null), // resume lookup (post-commit recovery)
    withTransaction: (fn: (t: unknown) => unknown) => fn(tx),
  } as unknown as DatabaseService;
  const systemMsg = {
    createMissionOpsRoom: opts.roomThrows
      ? jest.fn().mockRejectedValue(new Error('relay unreachable'))
      : jest.fn().mockResolvedValue({conversation_id: 'conv-1', created: true}),
    // Item 6 — the crew + managers now get a real conversation_members row.
    ensureRoomMembers: jest.fn().mockResolvedValue([]),
  } as unknown as SystemMessengerService;
  const bookingPush = {missionDispatched: jest.fn(), crewAssigned: jest.fn()} as unknown as BookingPushBridge;
  const roomIntents = {enqueueRoomIntent: jest.fn().mockResolvedValue(undefined)} as unknown as DispatchRoomIntentsService;
  const config = {get: jest.fn().mockReturnValue(20)} as never;
  const svc = new OrgMissionService(db, systemMsg, bookingPush, roomIntents, config);
  return {svc, db, tx, txQ, txQOne, systemMsg, bookingPush, roomIntents};
}

const OK_BOOKING = {
  id: 'b1', cpo_count: 2, armed_required: false, requirements: {}, region_code: 'AE',
  client_id: 'c1', conversation_id: null, assigned_provider_user_id: ORG,
};
const TWO_MEMBERS = [
  {member_user_id: 'cpo-1', call_sign: 'A1', agent_status: 'ACTIVE', on_duty: true},
  {member_user_id: 'cpo-2', call_sign: 'A2', agent_status: 'APPROVED', on_duty: true},
];

describe('OrgMissionService.assignCrew', () => {
  it('creates one mission + crew (lead is_lead), opens the agency room, enqueues intents, pushes', async () => {
    const {svc, txQ, systemMsg, roomIntents, bookingPush} = mk({booking: OK_BOOKING, members: TWO_MEMBERS});
    const res = await svc.assignCrew(ORG, MGR, 'b1', {cpo_user_ids: ['cpo-1', 'cpo-2'], lead_user_id: 'cpo-2'});
    expect(res).toEqual({ok: true, mission_id: 'm1', short_code: expect.stringMatching(/^MSN-/), crew: 2, lead_user_id: 'cpo-2'});
    // lead seeded first (slot 0, role LEAD, is_lead true)
    expect(txQ).toHaveBeenCalledWith(expect.stringMatching(/INSERT INTO mission_crew/), ['m1', 'cpo-2', 0, 'LEAD', 'A2', true, false]);
    expect(txQ).toHaveBeenCalledWith(expect.stringMatching(/INSERT INTO mission_crew/), ['m1', 'cpo-1', 1, 'CP', 'A1', false, false]);
    expect(txQ).toHaveBeenCalledWith(expect.stringMatching(/INSERT INTO mission_waypoints/), expect.arrayContaining(['m1']));
    expect(txQ).toHaveBeenCalledWith(expect.stringMatching(/INSERT INTO agent_deployment_checks/), expect.arrayContaining(['cpo-1', 'dress', 'm1']));
    // E2EE: AGENCY is the room creator and holds the key; the crew are seated as
    // metadata members here and rekeyed in later by the agency device draining
    // the intents. Both halves are required — see the comment at the call site.
    expect(systemMsg.createMissionOpsRoom).toHaveBeenCalledWith(expect.objectContaining({creator_user_id: ORG, ops_admin_user_id: ORG, crew_user_ids: []}));
    // B-207 — the CLIENT is seated first (idempotent) so a resumed/crashed assign
    // never leaves the room invisible to them. B-416 — the PROVIDER (owner) is
    // seated + intented too: under claimed key authority the bootstrapper can
    // be a manager's device, and an unseated owner would be locked out of its
    // own mission room. Then the crew.
    expect(systemMsg.ensureRoomMembers).toHaveBeenCalledWith('conv-1', ['c1', ORG, 'cpo-2', 'cpo-1']);
    expect(roomIntents.enqueueRoomIntent).toHaveBeenCalledTimes(4);
    expect(roomIntents.enqueueRoomIntent).toHaveBeenCalledWith(ORG, 'b1', 'conv-1', 'cpo-1', 'add', MGR);
    // B-207 — the client gets its OWN add-intent (retried key delivery, vs the
    // old one-shot create fan-out that was never re-sent).
    expect(roomIntents.enqueueRoomIntent).toHaveBeenCalledWith(ORG, 'b1', 'conv-1', 'c1', 'add', MGR);
    expect(bookingPush.missionDispatched).toHaveBeenCalledTimes(2);
  });

  // Item 6 — the assigned CPO used to get the crypto rekey but NO
  // conversation_members row. `listMine` is membership-joined, so the Ops Room
  // was invisible to them and MessengerHomeScreen's server-reconciliation sweep
  // then DELETED the locally bootstrapped copy off their device. Managers were
  // never added at all. (The owner already is the room creator/admin: on this
  // path the agency company account IS the org.)
  it('seats the crew AND the org managers, and enqueues a key intent for each', async () => {
    const {svc, systemMsg, roomIntents} = mk({
      booking: OK_BOOKING,
      members: TWO_MEMBERS,
      managers: [{member_user_id: 'mgr-a'}, {member_user_id: 'mgr-b'}],
    });
    await svc.assignCrew(ORG, MGR, 'b1', {cpo_user_ids: ['cpo-1', 'cpo-2'], lead_user_id: 'cpo-2'});

    // B-207/B-416 — client first, then the owner, then crew, then managers.
    expect(systemMsg.ensureRoomMembers)
      .toHaveBeenCalledWith('conv-1', ['c1', ORG, 'cpo-2', 'cpo-1', 'mgr-a', 'mgr-b']);
    // One add-intent per seated member — the metadata row alone carries no key.
    expect(roomIntents.enqueueRoomIntent).toHaveBeenCalledTimes(6);
    for (const uid of ['c1', ORG, 'cpo-1', 'cpo-2', 'mgr-a', 'mgr-b']) {
      expect(roomIntents.enqueueRoomIntent).toHaveBeenCalledWith(ORG, 'b1', 'conv-1', uid, 'add', MGR);
    }
  });

  it('B-416 (FLIPPED from B-207) — the agency owner IS seated + intented, exactly once even when listed as its own manager', async () => {
    // The old pin (`never seats the agency account`) assumed the owner is
    // always the room bootstrapper. Under B-416 claimed key authority the
    // bootstrapper can be a MANAGER's device — an unseated, unintented owner
    // would then be locked out of its own mission room. The Set dedup keeps
    // the defensive owner-as-own-manager row from double-seating.
    const {svc, systemMsg, roomIntents} = mk({
      booking: OK_BOOKING,
      members: TWO_MEMBERS,
      managers: [{member_user_id: ORG}],   // defensive: org listed as its own manager
    });
    await svc.assignCrew(ORG, MGR, 'b1', {cpo_user_ids: ['cpo-1', 'cpo-2'], lead_user_id: 'cpo-2'});
    const seated = (systemMsg.ensureRoomMembers as jest.Mock).mock.calls[0][1];
    expect(seated.filter((id: string) => id === ORG)).toHaveLength(1);
    expect(roomIntents.enqueueRoomIntent).toHaveBeenCalledWith(ORG, 'b1', 'conv-1', ORG, 'add', MGR);
  });

  it('rejects lead not in crew (400) before any DB work', async () => {
    const {svc, txQOne} = mk({booking: OK_BOOKING});
    await expect(svc.assignCrew(ORG, MGR, 'b1', {cpo_user_ids: ['cpo-1', 'cpo-2'], lead_user_id: 'cpo-9'}))
      .rejects.toThrow('lead_not_in_crew');
    expect(txQOne).not.toHaveBeenCalled();
  });

  it('409 booking_not_assignable when the tenant/state gate matches 0 rows (cross-org / already crewed)', async () => {
    const {svc} = mk({booking: null});
    await expect(svc.assignCrew(ORG, MGR, 'b1', {cpo_user_ids: ['cpo-1', 'cpo-2'], lead_user_id: 'cpo-1'}))
      .rejects.toThrow('booking_not_assignable');
  });

  it('409 crew_count_mismatch when ids.length != cpo_count', async () => {
    const {svc} = mk({booking: {...OK_BOOKING, cpo_count: 3}, members: TWO_MEMBERS});
    await expect(svc.assignCrew(ORG, MGR, 'b1', {cpo_user_ids: ['cpo-1', 'cpo-2'], lead_user_id: 'cpo-1'}))
      .rejects.toThrow('crew_count_mismatch');
  });

  it('400 cpo_not_in_org when a CPO is not an active member of this org', async () => {
    const {svc} = mk({booking: OK_BOOKING, members: [TWO_MEMBERS[0]]}); // only 1 of 2 active
    await expect(svc.assignCrew(ORG, MGR, 'b1', {cpo_user_ids: ['cpo-1', 'cpo-2'], lead_user_id: 'cpo-1'}))
      .rejects.toThrow('cpo_not_in_org');
  });

  // B-202 — an off-duty guard must not be crewable even if the client submits
  // them (stale sheet / duty toggle raced the assign). The client hides them
  // too, but the server is the real gate.
  it('400 cpo_not_on_duty when a selected CPO is off duty', async () => {
    const {svc} = mk({
      booking: OK_BOOKING,
      members: [TWO_MEMBERS[0], {...TWO_MEMBERS[1], on_duty: false}],
    });
    await expect(svc.assignCrew(ORG, MGR, 'b1', {cpo_user_ids: ['cpo-1', 'cpo-2'], lead_user_id: 'cpo-1'}))
      .rejects.toThrow('cpo_not_on_duty');
  });

  it('409 cpo_busy when a CPO is already on a non-terminal mission', async () => {
    const {svc} = mk({booking: OK_BOOKING, members: TWO_MEMBERS, busy: [{agent_id: 'cpo-1'}]});
    await expect(svc.assignCrew(ORG, MGR, 'b1', {cpo_user_ids: ['cpo-1', 'cpo-2'], lead_user_id: 'cpo-1'}))
      .rejects.toThrow('cpo_busy');
  });

  it('409 cpo_busy when the crew INSERT races the agent-active unique index (23505)', async () => {
    const {svc} = mk({booking: OK_BOOKING, members: TWO_MEMBERS, crewInsertThrows: true});
    await expect(svc.assignCrew(ORG, MGR, 'b1', {cpo_user_ids: ['cpo-1', 'cpo-2'], lead_user_id: 'cpo-1'}))
      .rejects.toThrow('cpo_busy');
  });

  it('409 requirement_unmet_armed when an armed booking has an unauthorized CPO', async () => {
    const {svc} = mk({booking: {...OK_BOOKING, armed_required: true}, members: TWO_MEMBERS, armed: [{cpo_user_id: 'cpo-1'}]});
    await expect(svc.assignCrew(ORG, MGR, 'b1', {cpo_user_ids: ['cpo-1', 'cpo-2'], lead_user_id: 'cpo-1'}))
      .rejects.toThrow('requirement_unmet_armed');
  });

  it('RESUMES the Ops Room + intents when a prior assign crashed post-commit (mission exists, no room)', async () => {
    const {svc, systemMsg, roomIntents} = mk({
      booking: null, // fresh gate 0 rows — the mission already exists
      resume: {mission_id: 'm1', short_code: 'MSN-XYZ', client_id: 'c1', assigned_provider_user_id: ORG},
      resumeCrew: [{agent_id: 'cpo-1', is_lead: true}, {agent_id: 'cpo-2', is_lead: false}],
    });
    const res = await svc.assignCrew(ORG, MGR, 'b1', {cpo_user_ids: ['cpo-1', 'cpo-2'], lead_user_id: 'cpo-1'});
    expect(res).toEqual({ok: true, mission_id: 'm1', short_code: 'MSN-XYZ', crew: 2, lead_user_id: 'cpo-1'});
    // re-drives the room + (idempotent) intents for the EXISTING crew + client — no 409.
    expect(systemMsg.createMissionOpsRoom).toHaveBeenCalledWith(expect.objectContaining({creator_user_id: ORG}));
    expect(roomIntents.enqueueRoomIntent).toHaveBeenCalledTimes(4); // B-207 +client; B-416 +owner
    expect(roomIntents.enqueueRoomIntent).toHaveBeenCalledWith(ORG, 'b1', 'conv-1', ORG, 'add', MGR);
  });

  it('LM-B5: a double-confirm with the SAME crew+lead is idempotent (200, existing mission)', async () => {
    const {svc} = mk({
      booking: null,
      resume: {mission_id: 'm1', short_code: 'MSN-XYZ', client_id: 'c1', assigned_provider_user_id: ORG},
      resumeCrew: [{agent_id: 'cpo-2', is_lead: true}, {agent_id: 'cpo-1', is_lead: false}],
    });
    const res = await svc.assignCrew(ORG, MGR, 'b1', {cpo_user_ids: ['cpo-1', 'cpo-2'], lead_user_id: 'cpo-2'});
    expect(res.mission_id).toBe('m1');
  });

  // ── Issue 11 · "mission activation must fail safely if the communication
  //    room cannot be created" (Testing Issues V2, PDF p.16) ────────────────
  describe('Issue 11 — a mission is never dispatched without an Ops Room', () => {
    it('rolls the FRESH mission back and fails the assign when the room cannot be opened', async () => {
      const {svc, txQ} = mk({booking: OK_BOOKING, members: TWO_MEMBERS, roomThrows: true});
      await expect(svc.assignCrew(ORG, MGR, 'b1', {cpo_user_ids: ['cpo-1', 'cpo-2'], lead_user_id: 'cpo-2'}))
        .rejects.toBeInstanceOf(ServiceUnavailableException);

      // The mission is aborted, not left DISPATCHED with no comms.
      expect(txQ).toHaveBeenCalledWith(
        expect.stringMatching(/UPDATE missions SET status = 'ABORTED'/), ['m1']);
    });

    it('stands the crew down, or mission_crew_agent_active_uq holds them busy forever', async () => {
      const {svc, txQ} = mk({booking: OK_BOOKING, members: TWO_MEMBERS, roomThrows: true});
      await expect(svc.assignCrew(ORG, MGR, 'b1', {cpo_user_ids: ['cpo-1', 'cpo-2'], lead_user_id: 'cpo-2'}))
        .rejects.toThrow('comms_room_unavailable');
      expect(txQ).toHaveBeenCalledWith(
        expect.stringMatching(/UPDATE mission_crew SET status = 'off'/), ['m1']);
    });

    it('clears the arrival clock so the no-show sweep cannot re-dispatch the retry', async () => {
      const {svc, txQ} = mk({booking: OK_BOOKING, members: TWO_MEMBERS, roomThrows: true});
      await expect(svc.assignCrew(ORG, MGR, 'b1', {cpo_user_ids: ['cpo-1', 'cpo-2'], lead_user_id: 'cpo-2'}))
        .rejects.toThrow();
      expect(txQ).toHaveBeenCalledWith(
        expect.stringMatching(/UPDATE lite_bookings SET arrival_deadline_at = NULL/), ['b1']);
    });

    it('tells NOBODY the mission is live — no crew or client push on a rolled-back assign', async () => {
      const {svc, bookingPush} = mk({booking: OK_BOOKING, members: TWO_MEMBERS, roomThrows: true});
      await expect(svc.assignCrew(ORG, MGR, 'b1', {cpo_user_ids: ['cpo-1', 'cpo-2'], lead_user_id: 'cpo-2'}))
        .rejects.toThrow();
      expect(bookingPush.missionDispatched).not.toHaveBeenCalled();
      expect(bookingPush.crewAssigned).not.toHaveBeenCalled();
    });

    it('still records comms_room_failed_at so ops can find the wreckage', async () => {
      const {svc, db} = mk({booking: OK_BOOKING, members: TWO_MEMBERS, roomThrows: true});
      await expect(svc.assignCrew(ORG, MGR, 'b1', {cpo_user_ids: ['cpo-1', 'cpo-2'], lead_user_id: 'cpo-2'}))
        .rejects.toThrow();
      expect(db.q).toHaveBeenCalledWith(
        expect.stringMatching(/comms_room_failed_at = NOW\(\)/), ['m1']);
    });

    it('does NOT roll back when a lead already raced to PICKUP — the deployment is real', async () => {
      // The abort is conditional on status='DISPATCHED' AND pickup_at IS NULL;
      // matching 0 rows must leave the crew seated.
      const {svc, txQ} = mk({
        booking: OK_BOOKING, members: TWO_MEMBERS, roomThrows: true, rollbackAbortsNothing: true,
      });
      await expect(svc.assignCrew(ORG, MGR, 'b1', {cpo_user_ids: ['cpo-1', 'cpo-2'], lead_user_id: 'cpo-2'}))
        .rejects.toThrow('comms_room_unavailable');
      expect(txQ).not.toHaveBeenCalledWith(
        expect.stringMatching(/UPDATE mission_crew SET status = 'off'/), expect.anything());
    });

    it('a RESUME whose room fails is NOT rolled back — that mission may be in flight', async () => {
      // The mission predates this call. Aborting it would strand a live
      // deployment; the marker + a later retry are the repair path instead.
      const {svc, txQ, bookingPush} = mk({
        booking: null,
        resume: {mission_id: 'm1', short_code: 'MSN-XYZ', client_id: 'c1', assigned_provider_user_id: ORG},
        resumeCrew: [{agent_id: 'cpo-1', is_lead: true}, {agent_id: 'cpo-2', is_lead: false}],
        roomThrows: true,
      });
      const res = await svc.assignCrew(ORG, MGR, 'b1', {cpo_user_ids: ['cpo-1', 'cpo-2'], lead_user_id: 'cpo-1'});
      expect(res.mission_id).toBe('m1');
      expect(txQ).not.toHaveBeenCalledWith(
        expect.stringMatching(/UPDATE missions SET status = 'ABORTED'/), expect.anything());
      expect(bookingPush.missionDispatched).toHaveBeenCalledTimes(2);
    });

    it('a rollback that itself fails still fails the assign — never a silent success', async () => {
      const {svc, db, tx} = mk({booking: OK_BOOKING, members: TWO_MEMBERS, roomThrows: true});
      (db as unknown as {withTransaction: jest.Mock}).withTransaction = jest.fn()
        // 1st call = the assign transaction (the real mock); 2nd = the rollback.
        .mockImplementationOnce((fn: (t: unknown) => unknown) => fn(tx))
        .mockImplementationOnce(() => Promise.reject(new Error('db down')));
      await expect(svc.assignCrew(ORG, MGR, 'b1', {cpo_user_ids: ['cpo-1', 'cpo-2'], lead_user_id: 'cpo-2'}))
        .rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });

  it('LM-B5: a confirm with a DIFFERENT crew 409s crew_already_assigned', async () => {
    const {svc} = mk({
      booking: null,
      resume: {mission_id: 'm1', short_code: 'MSN-XYZ', client_id: 'c1', assigned_provider_user_id: ORG},
      resumeCrew: [{agent_id: 'cpo-1', is_lead: true}, {agent_id: 'cpo-3', is_lead: false}],
    });
    await expect(svc.assignCrew(ORG, MGR, 'b1', {cpo_user_ids: ['cpo-1', 'cpo-2'], lead_user_id: 'cpo-1'}))
      .rejects.toThrow('crew_already_assigned');
  });
});

describe('OrgMissionService.listMissions', () => {
  it('groups rows into needs_crew / active / recent', async () => {
    const rows = [
      {booking_id: 'b1', booking_status: 'CONFIRMED', mission_id: null, mission_status: null, crew: []},
      {booking_id: 'b2', booking_status: 'CONFIRMED', mission_id: 'm2', mission_status: 'LIVE', crew: []},
      {booking_id: 'b3', booking_status: 'COMPLETED', mission_id: 'm3', mission_status: 'COMPLETED', crew: []},
    ];
    const db = {q: jest.fn().mockResolvedValue(rows)} as unknown as DatabaseService;
    const svc = new OrgMissionService(db, {} as never, {} as never, {} as never, {get: () => 20} as never);
    const out = await svc.listMissions(ORG);
    expect(out.needs_crew.map(r => r.booking_id)).toEqual(['b1']);
    expect(out.active.map(r => r.booking_id)).toEqual(['b2']);
    expect(out.recent.map(r => r.booking_id)).toEqual(['b3']);
  });
});

describe('OrgMissionService.getMissionEscrow (SP-MISSION-DETAIL · IDOR)', () => {
  it('returns the agency escrow view (payout + status, no client refund leg) when the org owns the booking', async () => {
    const {svc, db} = mk({resume: {status: 'HELD', basis: null, currency: 'AED', gross_credits: 800, to_provider_credits: 700, platform_fee_credits: 100}});
    const res = await svc.getMissionEscrow(ORG, 'b1');
    expect(res).toMatchObject({status: 'HELD', to_provider_credits: 700, platform_fee_credits: 100});
    expect(res).not.toHaveProperty('to_client_credits');
    const sql = (db.qOne as jest.Mock).mock.calls[0][0] as string;
    expect(sql).toMatch(/assigned_provider_user_id = \$2/);
  });

  it('throws ForbiddenException when the booking is not the caller org', async () => {
    const {svc} = mk({resume: null}); // no escrow row AND ownership check misses
    await expect(svc.getMissionEscrow(ORG, 'b-foreign')).rejects.toBeInstanceOf(ForbiddenException);
  });
});
