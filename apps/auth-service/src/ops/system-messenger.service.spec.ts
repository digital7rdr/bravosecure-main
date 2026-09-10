import {SystemMessengerService} from './system-messenger.service';
import {ConversationsService} from '../conversations/conversations.service';

const SYS_USER_ID = SystemMessengerService.SYSTEM_USER_ID;

function make() {
  const db = {
    q:    jest.fn().mockResolvedValue([]),
    qOne: jest.fn().mockResolvedValue(null),
  };
  const convs = {
    create: jest.fn().mockResolvedValue({id: 'c-new'}),
  };
  const svc = new SystemMessengerService(db as never, convs as unknown as ConversationsService);
  return {svc, db, convs};
}

describe('SystemMessengerService', () => {
  describe('ensureSystemDirect()', () => {
    it('returns existing direct conversation if one exists', async () => {
      const {svc, db, convs} = make();
      db.qOne.mockResolvedValueOnce({id: 'existing-c'});
      const id = await svc.ensureSystemDirect('u-1');
      expect(id).toBe('existing-c');
      expect(convs.create).not.toHaveBeenCalled();
    });
    it('creates a direct Bravo System conversation on first call', async () => {
      const {svc, convs} = make();
      const id = await svc.ensureSystemDirect('u-1');
      expect(id).toBe('c-new');
      expect(convs.create).toHaveBeenCalledWith(
        SYS_USER_ID, 'direct', ['u-1'], 'Bravo System',
      );
    });
  });

  describe('broadcast()', () => {
    it('inserts a system_broadcasts row with correct columns', async () => {
      const {svc, db} = make();
      db.qOne.mockResolvedValueOnce({id: 'bc-1'});
      const r = await svc.broadcast({
        conversationId: 'c1', kind: 'booking_approved',
        title: 'Approved', body: 'Body',
        severity: 'ok',
        subject_type: 'booking', subject_id: 'b-1',
        payload: {short: 'JF-1'},
      });
      expect(r).toEqual({id: 'bc-1'});
      const [sql, params] = db.qOne.mock.calls[0];
      expect(sql).toMatch(/INSERT INTO public\.system_broadcasts/);
      expect(params[0]).toBe('c1');
      expect(params[1]).toBe('booking_approved');
      expect(params[4]).toBe('ok');
      expect(params[5]).toBe('booking');
      expect(params[6]).toBe('b-1');
      expect(params[7]).toBe(JSON.stringify({short: 'JF-1'}));
      // created_by is the system user
      expect(params[8]).toBe(SYS_USER_ID);
    });
  });

  describe('sendBookingApproved()', () => {
    it('ensures direct conversation + inserts broadcast with the booking payload', async () => {
      const {svc, db, convs} = make();
      // No existing conv → create new
      db.qOne.mockResolvedValueOnce(null);
      db.qOne.mockResolvedValueOnce({id: 'bc-ok'});
      convs.create.mockResolvedValueOnce({id: 'c-a'});
      const r = await svc.sendBookingApproved({
        client_user_id: 'client-1',
        booking_id: 'b-1',
        job_short_code: 'JF-2026-0094',
        pickup_address: 'DIFC',
        dropoff_address: 'Palm Jumeirah',
        start_time: '2026-04-24T15:00:00Z',
        total_aed: 4200,
      });
      expect(r.conversation_id).toBe('c-a');
      expect(r.broadcast_id).toBe('bc-ok');
      const [, params] = db.qOne.mock.calls[1];
      expect(params[1]).toBe('booking_approved');
      expect(params[4]).toBe('ok');
      const payload = JSON.parse(params[7]);
      expect(payload.job_short_code).toBe('JF-2026-0094');
    });
  });

  describe('sendBookingRejected()', () => {
    it('sends a warn-severity card with reason + notes', async () => {
      const {svc, db, convs} = make();
      db.qOne.mockResolvedValueOnce({id: 'c-r'});
      db.qOne.mockResolvedValueOnce({id: 'bc-r'});
      convs.create.mockResolvedValueOnce({id: 'c-r'});
      await svc.sendBookingRejected({
        client_user_id: 'c1', booking_id: 'b-1',
        reason: 'regulatory', notes: 'paperwork',
      });
      const [, params] = db.qOne.mock.calls[1];
      expect(params[1]).toBe('booking_rejected');
      expect(params[4]).toBe('warn');
      expect(params[3]).toMatch(/regulatory/);
    });
  });

  describe('createMissionOpsRoom()', () => {
    it('returns existing comms_channel_id if set (idempotent)', async () => {
      const {svc, db, convs} = make();
      db.qOne.mockResolvedValueOnce({comms_channel_id: 'c-exists'});
      const r = await svc.createMissionOpsRoom({
        mission_id: 'm1', mission_short_code: 'MSN-1',
        booking_client_id: 'cli', crew_user_ids: ['a1', 'a2'],
        ops_admin_user_id: 'ops',
      });
      expect(r).toEqual({conversation_id: 'c-exists', created: false});
      expect(convs.create).not.toHaveBeenCalled();
    });

    it('creates a group conversation, updates mission.comms_channel_id, seeds greeting', async () => {
      const {svc, db, convs} = make();
      db.qOne.mockResolvedValueOnce({comms_channel_id: null});
      db.qOne.mockResolvedValueOnce({id: 'bc-greeting'});
      convs.create.mockResolvedValueOnce({id: 'c-ops'});

      const r = await svc.createMissionOpsRoom({
        mission_id: 'm1',
        mission_short_code: 'MSN-4817',
        booking_client_id: 'client-1',
        crew_user_ids: ['cpo-22', 'cpo-18', 'drv-07'],
        ops_admin_user_id: 'ops-01',
      });

      expect(r).toEqual({conversation_id: 'c-ops', created: true});
      expect(convs.create).toHaveBeenCalledWith(
        'ops-01',
        'group',
        expect.arrayContaining(['cpo-22', 'cpo-18', 'drv-07', 'client-1']),
        // The group NAME is what shows as the title of an incoming mission
        // call, so it carries the locked client-facing term, not "OPS ROOM".
        'Mission MSN-4817 · Bravo Control System',
      );
      // Mission row updated with the new conv id.
      expect(db.q).toHaveBeenCalledWith(
        expect.stringMatching(/UPDATE missions SET comms_channel_id/),
        ['m1', 'c-ops'],
      );
      // Seed broadcast inserted
      const [, params] = db.qOne.mock.calls[1];
      expect(params[1]).toBe('mission_started');
    });

    it('excludes ops admin from the member list (they are the creator)', async () => {
      const {svc, db, convs} = make();
      db.qOne.mockResolvedValueOnce({comms_channel_id: null});
      db.qOne.mockResolvedValueOnce({id: 'bc-x'});
      convs.create.mockResolvedValueOnce({id: 'c-ops'});

      await svc.createMissionOpsRoom({
        mission_id: 'm1', mission_short_code: 'MSN-1',
        booking_client_id: 'ops-01', // intentionally same as admin — should be filtered
        crew_user_ids: ['cpo-22', 'ops-01'],
        ops_admin_user_id: 'ops-01',
      });

      const [, , members] = convs.create.mock.calls[0];
      expect(members).not.toContain('ops-01');
      expect(members).toContain('cpo-22');
    });
  });

  describe('sendMissionEvent()', () => {
    it('posts SOS card with err severity by default', async () => {
      const {svc, db} = make();
      db.qOne.mockResolvedValueOnce({id: 'bc-sos'});
      await svc.sendMissionEvent({
        conversation_id: 'c-ops',
        mission_id: 'm1',
        mission_short_code: 'MSN-1',
        kind: 'mission_sos',
        message: '⚠ SOS · CPO-22 · suspicious tail',
      });
      const [, params] = db.qOne.mock.calls[0];
      expect(params[1]).toBe('mission_sos');
      expect(params[4]).toBe('err');  // severity defaulted based on kind
    });
    it('posts completion card with info default', async () => {
      const {svc, db} = make();
      db.qOne.mockResolvedValueOnce({id: 'bc-c'});
      await svc.sendMissionEvent({
        conversation_id: 'c-ops', mission_id: 'm1', mission_short_code: 'MSN-1',
        kind: 'mission_complete', message: 'Mission complete',
      });
      const [, params] = db.qOne.mock.calls[0];
      expect(params[4]).toBe('info');
    });
  });

  describe('deleteMissionRoom() — B-207 hard delete on completion', () => {
    it('runs the 6 idempotent statements in ONE txn, in order, all scoped to the conversation id', async () => {
      const txQ = jest.fn().mockResolvedValue([]);
      const db = {
        q: jest.fn(), qOne: jest.fn(),
        withTransaction: (fn: (t: unknown) => unknown) => fn({q: txQ, qOne: jest.fn()}),
      };
      const svc = new SystemMessengerService(db as never, {} as never);
      await svc.deleteMissionRoom('conv-9', 'mission_completed');

      const sqls = txQ.mock.calls.map(c => String(c[0]));
      // Order is load-bearing: SET NULL back-refs FIRST (booking/mission rows
      // survive), then the child rows, then the conversation. Deleting the
      // intents (row 3) is what stops a later agency drain re-minting a ghost.
      expect(sqls[0]).toMatch(/UPDATE public\.lite_bookings SET conversation_id = NULL/);
      expect(sqls[1]).toMatch(/UPDATE public\.missions SET comms_channel_id = NULL/);
      expect(sqls[2]).toMatch(/DELETE FROM public\.dispatch_room_intents/);
      expect(sqls[3]).toMatch(/DELETE FROM public\.conversation_members/);
      expect(sqls[4]).toMatch(/DELETE FROM public\.system_broadcasts/);
      expect(sqls[5]).toMatch(/DELETE FROM public\.conversations WHERE id = \$1/);
      expect(txQ).toHaveBeenCalledTimes(6);
      for (const c of txQ.mock.calls) {expect(c[1]).toEqual(['conv-9']);}
    });

    it('no-ops on an empty conversation id (never opens a txn)', async () => {
      const withTransaction = jest.fn();
      const svc = new SystemMessengerService({withTransaction} as never, {} as never);
      await svc.deleteMissionRoom('', 'x');
      expect(withTransaction).not.toHaveBeenCalled();
    });
  });

  describe('list helpers', () => {
    it('listForConversation pulls latest N ordered desc', async () => {
      const {svc, db} = make();
      await svc.listForConversation('c1', 25);
      const [sql, params] = db.q.mock.calls[0];
      expect(sql).toMatch(/ORDER BY created_at DESC/);
      expect(params).toEqual(['c1', 25]);
    });

    it('listForSubject filters by subject_type + subject_id', async () => {
      const {svc, db} = make();
      await svc.listForSubject('mission', 'm1');
      const [, params] = db.q.mock.calls[0];
      expect(params.slice(0, 2)).toEqual(['mission', 'm1']);
    });
  });
});
