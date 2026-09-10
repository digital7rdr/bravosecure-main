import {OpsAuditService} from './ops-audit.service';

describe('OpsAuditService', () => {
  function makeService() {
    const db = {
      q: jest.fn().mockResolvedValue([]),
      qOne: jest.fn().mockResolvedValue(null),
    };
    const svc = new OpsAuditService(db as never);
    return {svc, db};
  }

  describe('record()', () => {
    it('inserts a row with the admin identity + metadata', async () => {
      const {svc, db} = makeService();
      await svc.record({
        actor_id: 'u-1', actor_role: 'OPS', actor_call: 'OPS-01',
        action: 'booking.approve',
        subject_type: 'booking', subject_id: 'b-1',
        metadata: {notes: 'ok'},
      });
      expect(db.q).toHaveBeenCalledTimes(1);
      const [sql, params] = db.q.mock.calls[0];
      expect(sql).toMatch(/INSERT INTO ops_audit/);
      expect(params).toEqual([
        'u-1', 'OPS', 'OPS-01', 'booking.approve',
        'booking', 'b-1',
        JSON.stringify({notes: 'ok'}),
        null,
      ]);
    });

    it('defaults missing fields to null + {}', async () => {
      const {svc, db} = makeService();
      await svc.record({
        actor_role: 'SYSTEM',
        action: 'x', subject_type: 'booking', subject_id: 'b',
      });
      const [, params] = db.q.mock.calls[0];
      expect(params[0]).toBeNull();
      expect(params[6]).toBe('{}');
    });

    it('never throws when db fails (audit is best-effort)', async () => {
      const {svc, db} = makeService();
      db.q.mockRejectedValue(new Error('pg offline'));
      await expect(svc.record({
        actor_role: 'OPS', action: 'x',
        subject_type: 'booking', subject_id: 'b',
      })).resolves.toBeUndefined();
    });
  });

  describe('recordAdmin()', () => {
    it('hydrates from the AdminContext', async () => {
      const {svc, db} = makeService();
      await svc.recordAdmin(
        {user_id: 'u', role: 'SUPERVISOR', call_sign: 'SUP-01', region: 'AE'},
        'mission.abort',
        'mission',
        'msn-1',
        {reason: 'threat_level'},
      );
      expect(db.q).toHaveBeenCalledTimes(1);
      const [, params] = db.q.mock.calls[0];
      expect(params[1]).toBe('SUPERVISOR');
      expect(params[2]).toBe('SUP-01');
    });
  });

  describe('emit()', () => {
    it('inserts into live_feed_events', async () => {
      const {svc, db} = makeService();
      await svc.emit({
        kind: 'sos', severity: 'err',
        actor: 'CPO-22', subject: 'MSN-4817',
        message: 'SOS triggered',
      });
      const [sql, params] = db.q.mock.calls[0];
      expect(sql).toMatch(/INSERT INTO live_feed_events/);
      expect(params[0]).toBe('sos');
      expect(params[1]).toBe('err');
      expect(params[2]).toBe('CPO-22');
    });

    it('defaults severity to info when omitted', async () => {
      const {svc, db} = makeService();
      await svc.emit({kind: 'x', message: 'y'});
      const [, params] = db.q.mock.calls[0];
      expect(params[1]).toBe('info');
    });
  });

  describe('recentFeed()', () => {
    it('passes a LIMIT parameter', async () => {
      const {svc, db} = makeService();
      await svc.recentFeed(25);
      const [sql, params] = db.q.mock.calls[0];
      expect(sql).toMatch(/ORDER BY created_at DESC\s*\n\s*LIMIT/);
      expect(params).toEqual([25]);
    });

    it('defaults to 50', async () => {
      const {svc, db} = makeService();
      await svc.recentFeed();
      const [, params] = db.q.mock.calls[0];
      expect(params).toEqual([50]);
    });
  });
});
