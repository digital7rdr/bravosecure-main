import {BadRequestException, NotFoundException} from '@nestjs/common';
import {JobFeedService} from './job-feed.service';
import {JobStateMachine} from './job-state-machine.service';
import {MissionStateMachine} from './mission-state-machine.service';
import {OpsAuditService} from './ops-audit.service';
import {SystemMessengerService} from './system-messenger.service';
import type {AdminContext} from './admin.guard';

const ADMIN: AdminContext = {
  user_id: 'u-ops', role: 'OPS', call_sign: 'OPS-01', region: 'AE',
};

function make() {
  const q    = jest.fn().mockResolvedValue([]);
  const qOne = jest.fn().mockResolvedValue(null);
  // JobFeedService.dispatch wraps its body in withTransaction; the
  // mock forwards calls onto the same db.q / db.qOne so existing
  // call-count assertions keep working.
  const db = {
    q,
    qOne,
    withTransaction: jest.fn(async (fn: (tx: {q: jest.Mock; qOne: jest.Mock}) => unknown) => fn({q, qOne})),
  };
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
    createMissionOpsRoom:   jest.fn().mockResolvedValue({conversation_id: 'c-ops', created: true}),
    sendMissionEvent:       jest.fn().mockResolvedValue(undefined),
    listForConversation:    jest.fn().mockResolvedValue([]),
    listForSubject:         jest.fn().mockResolvedValue([]),
  };
  const svc = new JobFeedService(
    db as never,
    new JobStateMachine(),
    new MissionStateMachine(),
    audit as unknown as OpsAuditService,
    systemMsg as unknown as SystemMessengerService,
  );
  return {svc, db, audit, systemMsg};
}

describe('JobFeedService', () => {
  describe('publishFromBooking()', () => {
    it('throws NotFoundException when booking missing', async () => {
      const {svc} = make();
      await expect(svc.publishFromBooking('b-404', ADMIN)).rejects.toThrow(NotFoundException);
    });

    it('returns existing job when already published (idempotent)', async () => {
      const {svc, db} = make();
      db.qOne
        .mockResolvedValueOnce({id:'b1', region_code:'AE', pickup_address:'A', dropoff_address:'B', pickup_time:new Date(), duration_hours:4, cpo_count:2})
        .mockResolvedValueOnce({id:'j1', short_code:'JF-2026-0001', status:'PUBLISHED'} as never);
      const result = await svc.publishFromBooking('b1', ADMIN);
      expect(result.id).toBe('j1');
      // no insert expected
      const inserted = db.q.mock.calls.some(([sql]: [string]) => /INSERT INTO jobs/.test(sql));
      expect(inserted).toBe(false);
    });

    it('creates job with auto-generated JF short code + emits feed', async () => {
      const {svc, db, audit} = make();
      db.qOne
        .mockResolvedValueOnce({id:'b1', region_code:'AE', pickup_address:'KAUST, Thuwal', dropoff_address:'Ritz Carlton, JED', pickup_time:new Date(), duration_hours:4, cpo_count:2})
        .mockResolvedValueOnce(null)                          // no existing job
        .mockResolvedValueOnce({id:'j-new', short_code:'JF-B1'} as never);  // INSERT ... RETURNING *
      const result = await svc.publishFromBooking('b1', ADMIN);
      expect(result.id).toBe('j-new');
      // Short code is now derived from the booking-id suffix (JF-<suffix>),
      // not a year sequence — booking 'b1' → 'JF-B1'.
      expect(audit.recordAdmin).toHaveBeenCalledWith(
        ADMIN, 'job.publish', 'job', 'j-new',
        expect.objectContaining({short_code: 'JF-B1'}),
      );
      expect(audit.emit).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'job.publish', severity: 'ok',
      }));
    });
  });

  describe('list()', () => {
    it('orders the full feed FIFO by published_at and skips CANCELLED', async () => {
      const {svc, db} = make();
      await svc.list();
      const [sql] = db.q.mock.calls[0] as [string];
      expect(sql).toMatch(/ORDER BY published_at ASC/);
      expect(sql).toMatch(/status <> 'CANCELLED'/);
      // Must NOT fall back to dispatch_at ordering (the old, non-FIFO behaviour).
      expect(sql).not.toMatch(/ORDER BY dispatch_at/);
    });

    it('orders a status-filtered feed FIFO by published_at', async () => {
      const {svc, db} = make();
      await svc.list('PUBLISHED');
      const [sql, params] = db.q.mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/ORDER BY published_at ASC/);
      expect(params).toEqual(['PUBLISHED']);
    });
  });

  describe('apply()', () => {
    it('records application on an open job', async () => {
      const {svc, db, audit} = make();
      db.qOne
        .mockResolvedValueOnce({id:'j1', status:'PUBLISHED', short_code:'JF-X'})
        .mockResolvedValueOnce({id:'app-1', agent_call_sign:'CPO-44'} as never);
      const app = await svc.apply('j1', {
        agent_id:'a1', agent_call_sign:'CPO-44',
        rate_per_hour:540, distance_km:3.2, fit_score:94,
      });
      expect(app.id).toBe('app-1');
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
        actor_role: 'AGENT', action: 'application.submit',
      }));
      expect(audit.emit).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'application.submit',
      }));
    });
    it('refuses when job is DISPATCHED or CANCELLED', async () => {
      const {svc, db} = make();
      db.qOne.mockResolvedValueOnce({id:'j1', status:'DISPATCHED'});
      await expect(svc.apply('j1', {agent_id:'a', agent_call_sign:'C'}))
        .rejects.toThrow(BadRequestException);
    });
  });

  describe('shortlist()', () => {
    it('stamps the shortlist decision', async () => {
      const {svc, db, audit} = make();
      db.qOne.mockResolvedValueOnce({id:'app-1', job_id:'j1', agent_call_sign:'CPO-44'} as never);
      await svc.shortlist('app-1', ADMIN);
      expect(db.q).toHaveBeenCalledWith(expect.stringMatching(/SHORTLISTED/), ['app-1', ADMIN.user_id]);
      expect(audit.recordAdmin).toHaveBeenCalledWith(
        ADMIN, 'application.shortlist', 'application', 'app-1',
        expect.any(Object),
      );
    });
  });

  describe('assign()', () => {
    it('moves PUBLISHED → REVIEW on first assign', async () => {
      const {svc, db} = make();
      db.qOne
        .mockResolvedValueOnce({id:'app-1', job_id:'j1', agent_call_sign:'CPO-44'} as never)
        .mockResolvedValueOnce({id:'j1', status:'PUBLISHED', short_code:'JF-1', cpo_slots:2, slots_filled:0});
      db.qOne.mockResolvedValueOnce({slots_filled:1, cpo_slots:2, status:'REVIEW'});
      await svc.assign('app-1', ADMIN);
      // saw REVIEW transition
      expect(db.q).toHaveBeenCalledWith(expect.stringMatching(/status = 'REVIEW'/), ['j1']);
      // app marked ASSIGNED
      expect(db.q).toHaveBeenCalledWith(
        expect.stringMatching(/SET status = 'ASSIGNED'/),
        ['app-1', ADMIN.user_id],
      );
      // slots_filled++
      expect(db.q).toHaveBeenCalledWith(expect.stringMatching(/slots_filled \+ 1/), ['j1']);
    });

    it('auto-advances to ASSIGNED when all slots filled', async () => {
      const {svc, db} = make();
      db.qOne
        .mockResolvedValueOnce({id:'app-2', job_id:'j1', agent_call_sign:'CPO-12'} as never)
        .mockResolvedValueOnce({id:'j1', status:'REVIEW', short_code:'JF-1', cpo_slots:2, slots_filled:1});
      db.qOne.mockResolvedValueOnce({slots_filled:2, cpo_slots:2, status:'REVIEW'});
      await svc.assign('app-2', ADMIN);
      expect(db.q).toHaveBeenCalledWith(expect.stringMatching(/status = 'ASSIGNED'/), ['j1']);
    });
  });

  describe('dispatch()', () => {
    it('refuses when no crew assigned', async () => {
      const {svc, db} = make();
      db.qOne.mockResolvedValueOnce({id:'j1', status:'ASSIGNED', booking_id:'b1', short_code:'JF-1'});
      db.q.mockResolvedValueOnce([]);            // assigned apps = empty
      await expect(svc.dispatch('j1', ADMIN)).rejects.toThrow(BadRequestException);
    });

    it('creates mission + seeds waypoints + moves job → DISPATCHED', async () => {
      const {svc, db, audit} = make();
      db.qOne
        .mockResolvedValueOnce({id:'j1', status:'ASSIGNED', booking_id:'b1', short_code:'JF-1'})
        .mockResolvedValueOnce({id:'m-new'} as never);   // INSERT INTO missions ... RETURNING id
      db.q.mockResolvedValueOnce([
        {id:'app-1', agent_id:'a1', agent_call_sign:'CPO-44', status:'ASSIGNED'},
        {id:'app-2', agent_id:'a2', agent_call_sign:'CPO-12', status:'ASSIGNED'},
      ]);
      const result = await svc.dispatch('j1', ADMIN);
      expect(result).toEqual({mission_id: 'm-new'});
      // Job moves DISPATCHED
      expect(db.q).toHaveBeenCalledWith(expect.stringMatching(/UPDATE jobs SET status = 'DISPATCHED'/), ['j1']);
      // Booking moves CONFIRMED
      expect(db.q).toHaveBeenCalledWith(
        expect.stringMatching(/UPDATE lite_bookings SET status = 'CONFIRMED'/),
        ['b1'],
      );
      // Audit + feed
      expect(audit.recordAdmin).toHaveBeenCalledWith(
        ADMIN, 'job.dispatch', 'job', 'j1',
        expect.objectContaining({mission_id: 'm-new'}),
      );
      expect(audit.emit).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'mission.dispatch',
      }));
      // Seeded 7 waypoints + 2 crew members
      const crewInserts = db.q.mock.calls.filter(
        ([sql]: [string]) => /INSERT INTO mission_crew/.test(sql),
      );
      expect(crewInserts).toHaveLength(2);
      const wpInserts = db.q.mock.calls.filter(
        ([sql]: [string]) => /INSERT INTO mission_waypoints/.test(sql),
      );
      expect(wpInserts).toHaveLength(7);
    });
  });

  describe('cancel()', () => {
    it('marks the job CANCELLED with closed_at', async () => {
      const {svc, db, audit} = make();
      db.qOne.mockResolvedValueOnce({id:'j1', status:'PUBLISHED'});
      db.q.mockResolvedValueOnce([{id:'j1'}]);   // atomic conditional UPDATE ... RETURNING id
      await svc.cancel('j1', ADMIN, 'client_cancelled');
      expect(db.q).toHaveBeenCalledWith(
        expect.stringMatching(/status = 'CANCELLED', closed_at = NOW\(\)/s),
        ['j1', 'PUBLISHED'],
      );
      expect(audit.recordAdmin).toHaveBeenCalledWith(
        ADMIN, 'job.cancel', 'job', 'j1', {reason: 'client_cancelled'},
      );
    });
  });
});
