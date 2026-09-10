/**
 * sqa.md bug register — this suite pins: B-191.
 *
 * B-191 (the mission Ops Room never dissolved on completion — dissolution existed only in
 * SettlementService.settleEscrowRelease, which runs after the 3-day dispute window, only
 * when AUTO_DISPATCH_ENABLED, and never once review_required is set, while
 * completeMissionCore did nothing at all) is pinned by the B-207 cases here. NOTE the
 * supersession: B-191 shipped as an ARCHIVE (archived_at + archived_reason); B-207 later
 * replaced that with a HARD DELETE on founder instruction, so the surviving assertions say
 * hard-delete.
 */
import {BadRequestException, NotFoundException} from '@nestjs/common';
import {MissionService} from './mission.service';
import {MissionStateMachine} from './mission-state-machine.service';
import {OpsAuditService} from './ops-audit.service';
import {SystemMessengerService} from './system-messenger.service';
import type {AdminContext} from './admin.guard';

const ADMIN: AdminContext = {
  user_id: 'u-ops',
  role: 'OPS',
  call_sign: 'OPS-01',
  region: 'AE',
};
const SUPERVISOR: AdminContext = {...ADMIN, role: 'SUPERVISOR', call_sign: 'SUP-01'};

function makeService() {
  const db = {
    q:    jest.fn().mockResolvedValue([]),
    qOne: jest.fn().mockResolvedValue(null),
    // abort() now wraps the mission+booking flip in a transaction; the
    // mock forwards tx.q/tx.qOne onto the same spies so call assertions
    // still see them.
    withTransaction: jest.fn(async (fn: (tx: {q: jest.Mock; qOne: jest.Mock}) => unknown) =>
      fn({q: db.q, qOne: db.qOne})),
  } as {q: jest.Mock; qOne: jest.Mock; withTransaction: jest.Mock};
  const audit = {
    record:      jest.fn().mockResolvedValue(undefined),
    recordAdmin: jest.fn().mockResolvedValue(undefined),
    emit:        jest.fn().mockResolvedValue(undefined),
    listForSubject: jest.fn().mockResolvedValue([]),
  };
  const systemMsg = {
    ensureSystemDirect:     jest.fn().mockResolvedValue('c-sys'),
    broadcast:              jest.fn().mockResolvedValue({id: 'bc-1'}),
    sendBookingApproved:    jest.fn().mockResolvedValue({conversation_id: 'c', broadcast_id: 'bc'}),
    sendBookingRejected:    jest.fn().mockResolvedValue({conversation_id: 'c', broadcast_id: 'bc'}),
    createMissionOpsRoom:   jest.fn().mockResolvedValue({conversation_id: 'cm', created: true}),
    deleteMissionRoom:      jest.fn().mockResolvedValue(undefined),
    sendMissionEvent:       jest.fn().mockResolvedValue(undefined),
    listForConversation:    jest.fn().mockResolvedValue([]),
    listForSubject:         jest.fn().mockResolvedValue([]),
  };
  const mapbox = {
    getRoute: jest.fn().mockResolvedValue({distance_m: 0, duration_s: 0, polyline: null}),
    getRouteAlternatives: jest.fn().mockResolvedValue([]),
  };
  const wallet = {
    refundForBooking: jest.fn().mockResolvedValue({refunded: false, credits: 0, balance: {bravo_credits: 0, currency: 'AED', stripe_customer_id: null}}),
    refundEscrowHold: jest.fn().mockResolvedValue({refunded: true, credits: 800}),
    settleEscrowSplit: jest.fn().mockResolvedValue({settled: true, toProvider: 400, toClient: 400, platformFee: 0}),
  };
  const svc = new MissionService(
    db as never,
    new MissionStateMachine(),
    audit as unknown as OpsAuditService,
    systemMsg as unknown as SystemMessengerService,
    mapbox as never,
    wallet as never,
    {get: () => 0} as never,
  );
  return {svc, db, audit, systemMsg, wallet};
}

describe('MissionService', () => {
  describe('listActive()', () => {
    it('lists all active missions when no region filter', async () => {
      const {svc, db} = makeService();
      await svc.listActive();
      const [sql, params] = db.q.mock.calls[0];
      expect(sql).toMatch(/WHERE m\.status = ANY\(\$1\)/);
      expect(params).toEqual([['DISPATCHED', 'PICKUP', 'LIVE', 'SOS']]);
    });
    it('filters by region when provided', async () => {
      const {svc, db} = makeService();
      await svc.listActive('AE');
      const [sql, params] = db.q.mock.calls[0];
      expect(sql).toMatch(/b\.region_code = \$2/);
      expect(params).toEqual([['DISPATCHED', 'PICKUP', 'LIVE', 'SOS'], 'AE']);
    });
  });

  describe('getById()', () => {
    // Global ADMIN bypasses region scope (Audit AUTH-01), so the added
    // assertMissionRegion check passes regardless of region_code.
    const ADMIN = {user_id: 'a1', role: 'ADMIN' as const, call_sign: 'A1', region: 'AE'};
    it('throws NotFoundException when mission missing', async () => {
      const {svc} = makeService();
      await expect(svc.getById('missing', ADMIN)).rejects.toThrow(NotFoundException);
    });
    it('returns mission + related collections', async () => {
      const {svc, db} = makeService();
      db.qOne
        .mockResolvedValueOnce({id:'m1', status:'LIVE', short_code:'MSN-1', booking_id:'b1'}) // mission
        .mockResolvedValueOnce({region_code:'AE'})   // assertMissionRegion booking-region lookup
        .mockResolvedValue(null);                     // booking + vehicle in Promise.all
      db.q.mockResolvedValue([]);
      const result = await svc.getById('m1', ADMIN);
      expect(result).toHaveProperty('mission');
      expect(result).toHaveProperty('crew');
      expect(result).toHaveProperty('waypoints');
      expect(result).toHaveProperty('principals');
      expect(result).toHaveProperty('sos');
    });
  });

  describe('updateTelemetry()', () => {
    it('updates missions + mirrors into mission_telemetry_last', async () => {
      const {svc, db} = makeService();
      db.qOne.mockResolvedValueOnce({id:'m1', booking_id:'b1', status:'LIVE'});
      await svc.updateTelemetry('m1', {lat: 25.2, lng: 55.3, heading_deg: 270, speed_kph: 45});
      // two updates: missions + mission_telemetry_last upsert
      expect(db.q).toHaveBeenCalledTimes(2);
    });
    it('rejects telemetry on terminal missions', async () => {
      const {svc, db} = makeService();
      db.qOne.mockResolvedValueOnce({id:'m1', booking_id:'b1', status:'COMPLETED'});
      await expect(svc.updateTelemetry('m1', {lat:1,lng:2})).rejects.toThrow(BadRequestException);
    });
  });

  describe('pickup / goLive / complete', () => {
    it('AGENT can walk DISPATCHED → PICKUP → LIVE → COMPLETED', async () => {
      const {svc, db, audit} = makeService();

      db.qOne.mockResolvedValueOnce({id:'m1', booking_id:'b1', status:'DISPATCHED', short_code:'MSN-1'});
      await svc.pickup('m1');
      expect(db.q).toHaveBeenCalledWith(expect.stringMatching(/SET status = \$2/), ['m1', 'PICKUP']);

      db.qOne.mockResolvedValueOnce({id:'m1', booking_id:'b1', status:'PICKUP', short_code:'MSN-1'});
      await svc.goLive('m1');
      expect(db.q).toHaveBeenCalledWith(expect.stringMatching(/SET status = \$2/), ['m1', 'LIVE']);

      db.qOne.mockResolvedValueOnce({id:'m1', booking_id:'b1', status:'LIVE', short_code:'MSN-1'});
      await svc.complete('m1');
      // emits mission + marks booking completed
      expect(db.q).toHaveBeenCalledWith(expect.stringMatching(/status = 'COMPLETED'/), ['m1']);
      expect(db.q).toHaveBeenCalledWith(
        expect.stringMatching(/UPDATE lite_bookings.+COMPLETED/s),
        ['b1'],
      );
      expect(audit.emit).toHaveBeenCalledWith(
        expect.objectContaining({kind: 'mission.complete', severity: 'ok'}),
      );
    });

    it('rejects backwards transitions', async () => {
      const {svc, db} = makeService();
      db.qOne.mockResolvedValueOnce({id:'m1', booking_id:'b1', status:'COMPLETED'});
      await expect(svc.goLive('m1')).rejects.toThrow();
    });

    it('B-207 — completing a mission with an Ops Room HARD-DELETES it (founder: delete, not archive)', async () => {
      const {svc, db, systemMsg} = makeService();
      db.qOne.mockResolvedValueOnce({id:'m1', booking_id:'b1', status:'LIVE', short_code:'MSN-1', comms_channel_id: 'cm-1'});
      await svc.complete('m1');
      expect(systemMsg.deleteMissionRoom).toHaveBeenCalledWith('cm-1', 'mission_completed');
      // archiveConversation is gone — the mock never grew one, so a regression to
      // archive would throw "not a function" here rather than silently pass.
      expect((systemMsg as Record<string, unknown>).archiveConversation).toBeUndefined();
    });
  });

  describe('abort()', () => {
    it('Supervisor can abort any active mission + cancels booking', async () => {
      const {svc, db, audit} = makeService();
      // qOne order: 1 requireMission → 2 region (assertMissionRegion) →
      // 3 booking-cancel RETURNING.
      db.qOne.mockResolvedValueOnce({id:'m1', booking_id:'b1', status:'LIVE', short_code:'MSN-1'});
      db.qOne.mockResolvedValueOnce({region_code: 'AE'}); // SUPERVISOR region AE → allowed
      db.qOne.mockResolvedValueOnce({client_id: 'c1', payment_captured: false});
      await svc.abort('m1', SUPERVISOR, 'imminent_threat', 'perimeter breached');
      expect(db.q).toHaveBeenCalledWith(
        expect.stringMatching(/status = 'ABORTED'/s),
        ['m1', SUPERVISOR.user_id, 'imminent_threat'],
      );
      // Booking flip is now a RETURNING update (qOne) so abort can read
      // client_id + payment_captured for the audit-C2 refund.
      expect(db.qOne).toHaveBeenCalledWith(
        expect.stringMatching(/UPDATE lite_bookings.+CANCELLED.+RETURNING/s),
        ['b1'],
      );
      expect(audit.recordAdmin).toHaveBeenCalledWith(
        SUPERVISOR, 'mission.abort', 'mission', 'm1',
        expect.objectContaining({reason: 'imminent_threat'}),
      );
      expect(audit.emit).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'mission.abort', severity: 'err',
      }));
    });

    it('B-207 — aborting a mission with an Ops Room HARD-DELETES it with a reason suffix', async () => {
      const {svc, db, systemMsg} = makeService();
      db.qOne.mockResolvedValueOnce({id:'m1', booking_id:'b1', status:'LIVE', short_code:'MSN-1', comms_channel_id: 'cm-2'});
      db.qOne.mockResolvedValueOnce({region_code: 'AE'});
      db.qOne.mockResolvedValueOnce({client_id: 'c1', payment_captured: false});
      await svc.abort('m1', SUPERVISOR, 'imminent_threat', 'perimeter breached');
      expect(systemMsg.deleteMissionRoom).toHaveBeenCalledWith('cm-2', 'mission_aborted:imminent_threat');
    });

    it('Step 11 — mid-LIVE abort on an escrow booking pro-rates the hold (not the legacy refund)', async () => {
      const {svc, db, wallet} = makeService();
      db.qOne.mockResolvedValueOnce({id: 'm1', booking_id: 'b1', status: 'LIVE', short_code: 'MSN-1'}); // requireMission
      db.qOne.mockResolvedValueOnce({region_code: 'AE'});                                              // region
      db.qOne.mockResolvedValueOnce({client_id: 'c1', payment_captured: true});                        // booking flip
      db.qOne.mockResolvedValueOnce({status: 'HELD', gross_credits: 800, duration_hours: 4, worked_minutes: '120'}); // HELD hold, 120/240 min
      await svc.abort('m1', SUPERVISOR, 'principal_stand_down');
      // 50% on task → provider 400, client 400 (fee 0), basis pro_rata, HELD → PARTIAL.
      expect(wallet.settleEscrowSplit).toHaveBeenCalledWith(expect.anything(), 'b1', expect.objectContaining({
        toProvider: 400, toClient: 400, basis: 'pro_rata', fromStatuses: ['HELD'], finalStatus: 'PARTIAL',
      }));
      // The legacy total_eur refund is SKIPPED for an escrow booking.
      expect(wallet.refundForBooking).not.toHaveBeenCalled();
    });

    it('B-374 — a legacy abort refund credits the family HOLDER that paid, not the member', async () => {
      const {svc, db, wallet} = makeService();
      db.qOne.mockResolvedValueOnce({id: 'm1', booking_id: 'b1', status: 'PICKUP', short_code: 'MSN-1'});
      db.qOne.mockResolvedValueOnce({region_code: 'AE'});
      db.qOne.mockResolvedValueOnce({client_id: 'c1', payment_captured: true, payer_user_id: 'holder-9'});
      db.qOne.mockResolvedValueOnce(null); // no escrow hold — legacy booking
      await svc.abort('m1', SUPERVISOR, 'principal_stand_down');
      expect(wallet.refundForBooking).toHaveBeenCalledWith('holder-9', 'b1', expect.stringMatching(/aborted/));
    });

    it('Step 11 — pre-LIVE abort on an escrow booking fully refunds the hold', async () => {
      const {svc, db, wallet} = makeService();
      db.qOne.mockResolvedValueOnce({id: 'm1', booking_id: 'b1', status: 'PICKUP', short_code: 'MSN-1'});
      db.qOne.mockResolvedValueOnce({region_code: 'AE'});
      db.qOne.mockResolvedValueOnce({client_id: 'c1', payment_captured: true});
      db.qOne.mockResolvedValueOnce({status: 'HELD', gross_credits: 800, duration_hours: 4, worked_minutes: null}); // never went LIVE
      await svc.abort('m1', SUPERVISOR, 'cancelled_pre_live');
      expect(wallet.refundEscrowHold).toHaveBeenCalledWith(expect.anything(), 'b1', expect.stringMatching(/pre-live/));
      expect(wallet.settleEscrowSplit).not.toHaveBeenCalled();
      expect(wallet.refundForBooking).not.toHaveBeenCalled();
    });

    it('Step 11 — abort on a PENDING_RELEASE hold does NOT legacy-refund (race guard vs lead Finish)', async () => {
      const {svc, db, wallet} = makeService();
      db.qOne.mockResolvedValueOnce({id: 'm1', booking_id: 'b1', status: 'LIVE', short_code: 'MSN-1'});
      db.qOne.mockResolvedValueOnce({region_code: 'AE'});
      db.qOne.mockResolvedValueOnce({client_id: 'c1', payment_captured: true});
      // A lead Finish already flipped the hold HELD→PENDING_RELEASE before this abort.
      db.qOne.mockResolvedValueOnce({status: 'PENDING_RELEASE', gross_credits: 800, duration_hours: 4, worked_minutes: '120'});
      await svc.abort('m1', SUPERVISOR, 'late_abort');
      // No active escrow reversal (the hold is in the release lifecycle) AND, critically,
      // NO legacy refundForBooking — that would double-refund while the sweep pays the agency.
      expect(wallet.refundEscrowHold).not.toHaveBeenCalled();
      expect(wallet.settleEscrowSplit).not.toHaveBeenCalled();
      expect(wallet.refundForBooking).not.toHaveBeenCalled();
    });
  });

  describe('SOS flow', () => {
    it('triggerSos — AGENT raises SOS from LIVE, mission transitions to SOS', async () => {
      const {svc, db, audit} = makeService();
      db.qOne.mockResolvedValueOnce({id:'m1', booking_id:'b1', status:'LIVE', short_code:'MSN-1'});
      db.qOne.mockResolvedValueOnce({id:'sos-1', mission_id:'m1', reason:'tail'} as never);
      const sos = await svc.triggerSos('m1', {
        agent_id: 'a1', agent_call_sign: 'CPO-22',
        reason: 'suspicious_tail',
      });
      expect(sos).toEqual(expect.objectContaining({id: 'sos-1'}));
      // Mission transitioned.
      expect(db.q).toHaveBeenCalledWith(expect.stringMatching(/status = \$2/), ['m1', 'SOS']);
      // Audit + feed.
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
        actor_role: 'AGENT', action: 'sos.trigger',
      }));
      expect(audit.emit).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'sos', severity: 'err',
      }));
    });

    it('triggerSos — no state change when already in SOS', async () => {
      const {svc, db} = makeService();
      db.qOne.mockResolvedValueOnce({id:'m1', booking_id:'b1', status:'SOS', short_code:'MSN-1'});
      db.qOne.mockResolvedValueOnce({id:'sos-2'} as never);
      await svc.triggerSos('m1', {agent_id:'a', agent_call_sign:'CPO-22', reason:'x'});
      // No extra status update.
      const calls = db.q.mock.calls.filter(([sql]: [string]) => /SET status = \$2/.test(sql));
      expect(calls).toHaveLength(0);
    });

    it('triggerSos — refuses on COMPLETED or ABORTED mission', async () => {
      const {svc, db} = makeService();
      db.qOne.mockResolvedValueOnce({id:'m1', status:'COMPLETED'});
      await expect(svc.triggerSos('m1', {agent_id:'a', agent_call_sign:'C', reason:'x'}))
        .rejects.toThrow(BadRequestException);
    });

    it('ackSos — stamps acknowledged_at + by', async () => {
      const {svc, db, audit} = makeService();
      db.qOne.mockResolvedValueOnce({id:'sos-1', mission_id:'m1', acknowledged_at:null});
      await svc.ackSos('sos-1', ADMIN, 'on it');
      expect(db.q).toHaveBeenCalledWith(
        expect.stringMatching(/SET acknowledged_at = NOW\(\)/s),
        ['sos-1', ADMIN.user_id],
      );
      expect(audit.recordAdmin).toHaveBeenCalledWith(
        ADMIN, 'sos.ack', 'sos', 'sos-1', {notes: 'on it'},
      );
    });

    it('ackSos — idempotent (returns early if already acked)', async () => {
      const {svc, db} = makeService();
      db.qOne.mockResolvedValueOnce({id:'sos-1', acknowledged_at: new Date()});
      await svc.ackSos('sos-1', ADMIN);
      expect(db.q).not.toHaveBeenCalled();
    });

    it('escalateSos — records escalation_to', async () => {
      const {svc, db, audit} = makeService();
      db.qOne.mockResolvedValueOnce({id: 'sos-1', mission_id: 'm1'}); // AUTHZ-2 — escalateSos now loads the SOS
      await svc.escalateSos('sos-1', SUPERVISOR, 'POLICE', 'local chief notified');
      expect(db.q).toHaveBeenCalledWith(
        expect.stringMatching(/SET escalated_at = NOW\(\)/s),
        ['sos-1', 'POLICE'],
      );
      expect(audit.recordAdmin).toHaveBeenCalledWith(
        SUPERVISOR, 'sos.escalate', 'sos', 'sos-1',
        expect.objectContaining({escalated_to: 'POLICE'}),
      );
    });

    it('resolveSos — returns mission to LIVE when returnToLive=true', async () => {
      const {svc, db} = makeService();
      db.qOne.mockResolvedValueOnce({id:'sos-1', mission_id:'m1'});   // sos load
      db.qOne.mockResolvedValueOnce({region_code:'AE'});               // AUTHZ-2 region (matches the OPS admin)
      db.qOne.mockResolvedValueOnce({id:'m1', booking_id:'b1', status:'SOS', short_code:'MSN-1'}); // requireMission
      await svc.resolveSos('sos-1', ADMIN, 'false_alarm', true);
      expect(db.q).toHaveBeenCalledWith(expect.stringMatching(/SET resolved_at = NOW/s), ['sos-1', 'false_alarm']);
      // FSM-4 — the return-to-LIVE is now a status-guarded literal UPDATE (WHERE
      // status = 'SOS') so a concurrent Finish can't be resurrected. Params carry
      // only the mission id; 'LIVE'/'SOS' are literals.
      expect(db.q).toHaveBeenCalledWith(
        expect.stringMatching(/SET status = 'LIVE'[\s\S]*WHERE id = \$1 AND status = 'SOS'/),
        ['m1'],
      );
    });

    it('AUTHZ-2 — refuses an SOS action whose mission is outside the admin region (no write)', async () => {
      const {svc, db} = makeService();
      db.qOne.mockResolvedValueOnce({id: 'sos-1', mission_id: 'm1', acknowledged_at: null}); // sos load
      db.qOne.mockResolvedValueOnce({region_code: 'SA'}); // mission booking is in another region
      await expect(svc.ackSos('sos-1', SUPERVISOR)).rejects.toThrow(); // SUPERVISOR is region 'AE'
      expect(db.q).not.toHaveBeenCalled(); // gated before the ack write
    });
  });

  describe('advanceWaypoint()', () => {
    it('sets state + stamps settled_at when done', async () => {
      const {svc, db} = makeService();
      db.qOne.mockResolvedValueOnce({id:'m1', status:'LIVE'});
      await svc.advanceWaypoint('m1', 3, 'done');
      const [sql, params] = db.q.mock.calls[0];
      expect(sql).toMatch(/SET state = \$3/);
      expect(params).toEqual(['m1', 3, 'done']);
    });
  });
});
