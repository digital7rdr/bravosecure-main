/**
 * End-to-end smoke test: the full ops admin workflow.
 *
 *   Client books → Ops approves → Job auto-published to agent feed →
 *   agents apply → Ops shortlists + assigns → Ops dispatches → mission
 *   goes DISPATCHED → PICKUP → LIVE → SOS → LIVE (resolve) → COMPLETED.
 *
 * Runs ×3 to prove idempotency of the state machines + services
 * against mocked database I/O.
 */
import {MissionStateMachine} from './mission-state-machine.service';
import {JobStateMachine}     from './job-state-machine.service';
import {MissionService}      from './mission.service';
import {JobFeedService}      from './job-feed.service';
import {OpsAuditService}     from './ops-audit.service';
import {SystemMessengerService} from './system-messenger.service';
import type {AdminContext}   from './admin.guard';

const ADMIN: AdminContext = {
  user_id: 'u-ops', role: 'OPS', call_sign: 'OPS-01', region: 'AE',
};
const SUPER: AdminContext = {...ADMIN, role: 'SUPERVISOR', call_sign: 'SUP-01'};

// Shared fake DB — returns whatever you queue up per call via `q` / `qOne`.
function makeDb() {
  const q    = jest.fn().mockResolvedValue([]);
  const qOne = jest.fn().mockResolvedValue(null);
  // JobFeedService.dispatch (and OpsService.dispatchBooking) now wrap
  // their bodies in withTransaction; the mock forwards onto the same
  // db.q / db.qOne so existing call-count assertions still work.
  const withTransaction = jest.fn(
    async (fn: (tx: {q: jest.Mock; qOne: jest.Mock}) => unknown) => fn({q, qOne}),
  );
  return {q, qOne, withTransaction};
}

function makeAudit() {
  return {
    record:      jest.fn().mockResolvedValue(undefined),
    recordAdmin: jest.fn().mockResolvedValue(undefined),
    emit:        jest.fn().mockResolvedValue(undefined),
    listForSubject: jest.fn().mockResolvedValue([]),
  };
}

function makeSystemMsg() {
  return {
    ensureSystemDirect:     jest.fn().mockResolvedValue('c-sys'),
    broadcast:              jest.fn().mockResolvedValue({id: 'bc'}),
    sendBookingApproved:    jest.fn().mockResolvedValue({conversation_id: 'c', broadcast_id: 'bc'}),
    sendBookingRejected:    jest.fn().mockResolvedValue({conversation_id: 'c', broadcast_id: 'bc'}),
    createMissionOpsRoom:   jest.fn().mockResolvedValue({conversation_id: 'c-ops', created: true}),
    sendMissionEvent:       jest.fn().mockResolvedValue(undefined),
    listForConversation:    jest.fn().mockResolvedValue([]),
    listForSubject:         jest.fn().mockResolvedValue([]),
  };
}

describe('Ops admin flow — end-to-end smoke', () => {
  for (const attempt of [1, 2, 3]) {
    it(`attempt #${attempt}: client books → ops runs the full lifecycle`, async () => {
      const db     = makeDb();
      const audit  = makeAudit();
      const sys    = makeSystemMsg();
      const jobFsm = new JobStateMachine();
      const mFsm   = new MissionStateMachine();

      const jobs     = new JobFeedService(
        db as never, jobFsm, mFsm,
        audit as unknown as OpsAuditService,
        sys   as unknown as SystemMessengerService,
      );
      const missions = new MissionService(
        db as never, mFsm,
        audit as unknown as OpsAuditService,
        sys   as unknown as SystemMessengerService,
        {getRoute: jest.fn(), getRouteAlternatives: jest.fn()} as never,
        {refundForBooking: jest.fn().mockResolvedValue({refunded: false, credits: 0})} as never,
        {get: () => 0} as never,
      );

      // ── 1. Ops publishes job from freshly-approved booking ──────
      db.qOne
        .mockResolvedValueOnce({
          id: 'b1', region_code: 'AE',
          pickup_address: 'DIFC Gate 3', dropoff_address: 'Palm Jumeirah',
          pickup_time: new Date(), duration_hours: 4, cpo_count: 2,
        })
        .mockResolvedValueOnce(null)                             // no existing job
        .mockResolvedValueOnce({id: 'j1', short_code: 'JF-B1', status: 'PUBLISHED'} as never);  // INSERT ... RETURNING *
      const job = await jobs.publishFromBooking('b1', ADMIN);
      // Short code is now derived from the booking-id suffix ('b1' → 'JF-B1').
      expect(job.short_code).toBe('JF-B1');
      expect(audit.emit).toHaveBeenCalledWith(expect.objectContaining({kind: 'job.publish'}));

      // ── 2. Agents apply (multiple) ──────────────────────────────
      for (const a of [
        {id:'agt-44', call:'CPO-44', fit:94, distance:3.2, rate:540},
        {id:'agt-12', call:'CPO-12', fit:88, distance:5.8, rate:510},
        {id:'agt-07', call:'CPO-07', fit:76, distance:12.4, rate:480},
      ]) {
        db.qOne
          .mockResolvedValueOnce({id:'j1', status:'PUBLISHED', short_code:'JF-2026-0094'})
          .mockResolvedValueOnce({id:`app-${a.id}`, agent_call_sign:a.call} as never);
        const app = await jobs.apply('j1', {
          agent_id: a.id, agent_call_sign: a.call,
          rate_per_hour: a.rate, distance_km: a.distance, fit_score: a.fit,
        });
        expect(app.id).toBe(`app-${a.id}`);
      }

      // ── 3. Ops shortlists + assigns the top 2 (→ REVIEW then ASSIGNED) ──
      db.qOne.mockResolvedValueOnce({id:'app-agt-44', job_id:'j1', agent_call_sign:'CPO-44'} as never);
      await jobs.shortlist('app-agt-44', ADMIN);

      // First assign triggers PUBLISHED → REVIEW
      db.qOne
        .mockResolvedValueOnce({id:'app-agt-44', job_id:'j1', agent_call_sign:'CPO-44'} as never)
        .mockResolvedValueOnce({id:'j1', status:'PUBLISHED', short_code:'JF-2026-0094', cpo_slots:2, slots_filled:0})
        .mockResolvedValueOnce({slots_filled:1, cpo_slots:2, status:'REVIEW'});
      await jobs.assign('app-agt-44', ADMIN);

      // Second assign — fills last slot, auto-advances to ASSIGNED
      db.qOne
        .mockResolvedValueOnce({id:'app-agt-12', job_id:'j1', agent_call_sign:'CPO-12'} as never)
        .mockResolvedValueOnce({id:'j1', status:'REVIEW', short_code:'JF-2026-0094', cpo_slots:2, slots_filled:1})
        .mockResolvedValueOnce({slots_filled:2, cpo_slots:2, status:'REVIEW'});
      await jobs.assign('app-agt-12', ADMIN);
      expect(db.q).toHaveBeenCalledWith(
        expect.stringMatching(/UPDATE jobs SET status = 'ASSIGNED'/),
        ['j1'],
      );

      // Third applicant rejected
      db.qOne.mockResolvedValueOnce({id:'app-agt-07', job_id:'j1', agent_call_sign:'CPO-07'} as never);
      await jobs.reject('app-agt-07', ADMIN, 'too_far');

      // ── 4. Ops dispatches — creates mission ─────────────────────
      db.qOne
        .mockResolvedValueOnce({id:'j1', status:'ASSIGNED', booking_id:'b1', short_code:'JF-2026-0094'})
        .mockResolvedValueOnce({id:'m-4817'} as never);   // INSERT INTO missions ... RETURNING id
      db.q.mockResolvedValueOnce([
        {id:'app-agt-44', agent_id:'agt-44', agent_call_sign:'CPO-44', status:'ASSIGNED'},
        {id:'app-agt-12', agent_id:'agt-12', agent_call_sign:'CPO-12', status:'ASSIGNED'},
      ]);
      const dispatched = await jobs.dispatch('j1', ADMIN);
      expect(dispatched).toEqual({mission_id: 'm-4817'});

      // ── 5. Mission lifecycle: DISPATCHED → PICKUP → LIVE ────────
      db.qOne.mockResolvedValueOnce({id:'m-4817', booking_id:'b1', status:'DISPATCHED', short_code:'MSN-4816'});
      await missions.pickup('m-4817');

      db.qOne.mockResolvedValueOnce({id:'m-4817', booking_id:'b1', status:'PICKUP', short_code:'MSN-4816'});
      await missions.goLive('m-4817');

      // ── 6. CPO-44 triggers SOS from mobile ──────────────────────
      db.qOne
        .mockResolvedValueOnce({id:'m-4817', booking_id:'b1', status:'LIVE', short_code:'MSN-4816'})
        .mockResolvedValueOnce({id:'sos-1', mission_id:'m-4817', reason:'suspicious_tail'} as never);
      const sos = await missions.triggerSos('m-4817', {
        agent_id: 'agt-44', agent_call_sign: 'CPO-44',
        reason: 'suspicious_tail', lat: 25.1185, lng: 55.1392,
      });
      expect(sos.id).toBe('sos-1');
      expect(audit.emit).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'sos', severity: 'err',
      }));

      // ── 7. OPS acknowledges, supervisor resolves ─────────────────
      db.qOne.mockResolvedValueOnce({id:'sos-1', mission_id:'m-4817', acknowledged_at: null});
      await missions.ackSos('sos-1', ADMIN);

      db.qOne
        .mockResolvedValueOnce({id:'sos-1', mission_id:'m-4817'})
        .mockResolvedValueOnce({region_code:'AE'}) // AUTHZ-2 — region gate (matches SUPER's region)
        .mockResolvedValueOnce({id:'m-4817', booking_id:'b1', status:'SOS', short_code:'MSN-4816'});
      await missions.resolveSos('sos-1', SUPER, 'false_alarm_tail_was_unrelated', true);
      // FSM-4 — return-to-LIVE is a status-guarded literal UPDATE (params: mission id only).
      expect(db.q).toHaveBeenCalledWith(
        expect.stringMatching(/SET status = 'LIVE'[\s\S]*WHERE id = \$1 AND status = 'SOS'/),
        ['m-4817'],
      );

      // ── 8. Mission completes cleanly ────────────────────────────
      db.qOne.mockResolvedValueOnce({id:'m-4817', booking_id:'b1', status:'LIVE', short_code:'MSN-4816'});
      await missions.complete('m-4817');
      expect(db.q).toHaveBeenCalledWith(
        expect.stringMatching(/status = 'COMPLETED'/),
        ['m-4817'],
      );
      expect(db.q).toHaveBeenCalledWith(
        expect.stringMatching(/UPDATE lite_bookings.+COMPLETED/s),
        ['b1'],
      );
      expect(audit.emit).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'mission.complete',
      }));
    });
  }

  describe('failure path — Ops aborts a mission mid-flight', () => {
    it('aborts LIVE mission, cancels booking, audits', async () => {
      const db    = makeDb();
      const audit = makeAudit();
      const sys   = makeSystemMsg();
      const missions = new MissionService(
        db as never, new MissionStateMachine(),
        audit as unknown as OpsAuditService,
        sys as unknown as SystemMessengerService,
        {getRoute: jest.fn(), getRouteAlternatives: jest.fn()} as never,
        {refundForBooking: jest.fn().mockResolvedValue({refunded: false, credits: 0})} as never,
        {get: () => 0} as never,
      );

      db.qOne.mockResolvedValueOnce({
        id:'m-bad', booking_id:'b-bad', status:'LIVE', short_code:'MSN-9999',
      });
      // Region SELECT (audit H3 — assertMissionRegion). SUPER is AE.
      db.qOne.mockResolvedValueOnce({region_code: 'AE'});
      // Booking-cancel RETURNING row (audit C2 — read for refund decision).
      db.qOne.mockResolvedValueOnce({client_id: 'c-bad', payment_captured: false});

      await missions.abort('m-bad', SUPER, 'severe_weather', 'route unsafe');

      expect(db.q).toHaveBeenCalledWith(
        expect.stringMatching(/status = 'ABORTED'/s),
        ['m-bad', SUPER.user_id, 'severe_weather'],
      );
      expect(db.qOne).toHaveBeenCalledWith(
        expect.stringMatching(/UPDATE lite_bookings.+CANCELLED.+RETURNING/s),
        ['b-bad'],
      );
      expect(audit.emit).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'mission.abort', severity: 'err',
      }));
    });
  });
});
