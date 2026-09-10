/**
 * Protection Phase-2 surface — location ingest (activation-on-first-fix, the
 * 410 straggler, invalid-fix filtering), CPO access denials + access audit, and
 * the ops end / transfer-only reassignment. DatabaseService mocked; SQL text +
 * bind values are the pinned behavior.
 */
import {ProtectionService} from './protection.service';
import type {DatabaseService} from '../database/database.service';

const SESSION_COLS_ROW = {
  id: 'sess-1', application_id: 'app-1', customer_id: 'owner-1', cpo_user_id: 'cpo-1',
  assignment_id: 'asg-1', status: 'ACTIVE', requested_at: 't', activated_at: 't',
  ended_at: null, end_reason: null, last_fix_at: 't', sos_active: false, created_at: 't', updated_at: 't',
};

type Opts = {
  ingestSession?: Record<string, unknown> | null;
  ingestUpdated?: Record<string, unknown> | null;
  ownedByCpo?: Record<string, unknown> | null;
  getByIdRow?: Record<string, unknown> | null;
  opsUpdated?: Record<string, unknown> | null;
  newCpo?: Record<string, unknown> | null;
  covering?: Record<string, unknown> | null;
  transferUpdated?: Record<string, unknown> | null;
  overviewRows?: Array<Record<string, unknown>>;
  trail?: Array<Record<string, unknown>>;
};

function mk(opts: Opts = {}) {
  const qCalls: Array<{sql: string; params?: unknown[]}> = [];
  const qOneCalls: Array<{sql: string; params?: unknown[]}> = [];
  const db = {
    q: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
      qCalls.push({sql, params});
      if (/AS session_id[\s\S]*FROM public\.pro_cpo_assignments pca/.test(sql)) {
        return Promise.resolve(opts.overviewRows ?? []);
      }
      if (/FROM public\.protection_session_locations\s+WHERE session_id/.test(sql)) {
        return Promise.resolve(opts.trail ?? []);
      }
      return Promise.resolve([]); // inserts, audits, sweeps
    }),
    qOne: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
      qOneCalls.push({sql, params});
      if (/SELECT id, customer_id, status FROM public\.protection_sessions WHERE id/.test(sql)) {
        return Promise.resolve(opts.ingestSession ?? null);
      }
      if (/UPDATE public\.protection_sessions[\s\S]*last_fix_at = now\(\)/.test(sql)) {
        return Promise.resolve(opts.ingestUpdated ?? null);
      }
      // assertCpoOwnsSession — joins ONLY the customer (cu), not the cpo (co).
      if (/FROM public\.protection_sessions s\b[\s\S]*JOIN public\.users cu\b/.test(sql) && !/JOIN public\.users co\b/.test(sql)) {
        return Promise.resolve(opts.ownedByCpo ?? null);
      }
      // opsSessionDetail — joins BOTH cu + co.
      if (/JOIN public\.users co\b/.test(sql)) {
        return Promise.resolve(opts.getByIdRow ?? null);
      }
      if (/UPDATE public\.protection_sessions[\s\S]*end_reason = 'ops'/.test(sql)) {
        return Promise.resolve(opts.opsUpdated ?? null);
      }
      if (/FROM public\.agents WHERE user_id = \$1 AND type = 'cpo'/.test(sql)) {
        return Promise.resolve(opts.newCpo ?? null);
      }
      if (/SELECT id AS assignment_id\s+FROM public\.pro_cpo_assignments/.test(sql)) {
        return Promise.resolve(opts.covering ?? null);
      }
      if (/UPDATE public\.protection_sessions[\s\S]*cpo_user_id = \$2, assignment_id = \$3/.test(sql)) {
        return Promise.resolve(opts.transferUpdated ?? null);
      }
      // getById — full SESSION_COLS, no join.
      if (/application_id[\s\S]*FROM public\.protection_sessions WHERE id = \$1/.test(sql)) {
        return Promise.resolve(opts.getByIdRow ?? null);
      }
      return Promise.resolve(null);
    }),
  } as unknown as DatabaseService;
  const opsAudit = {emit: jest.fn().mockResolvedValue(undefined)};
  const events = {broadcast: jest.fn().mockResolvedValue(undefined)};
  const push = {
    psessionNew: jest.fn().mockResolvedValue(undefined),
    psessionStarted: jest.fn().mockResolvedValue(undefined),
    psessionEnded: jest.fn().mockResolvedValue(undefined),
    proCpoChanged: jest.fn().mockResolvedValue(undefined),
  };
  const svc = new ProtectionService(db, opsAudit as never, events as never, push as never);
  return {svc, db, qCalls, qOneCalls, events, push};
}

const ADMIN = {user_id: 'admin-1', role: 'SUPERVISOR', call_sign: 'OPS', region: 'AE'} as never;
const GOOD_FIX = {lat: 25.2, lng: 55.3, recorded_at: '2026-08-10T12:00:00.000Z'};

describe('ingestLocations', () => {
  it('first accepted fix flips REQUESTED→ACTIVE and broadcasts status + location', async () => {
    const {svc, qCalls, qOneCalls, events} = mk({
      ingestSession: {id: 'sess-1', customer_id: 'owner-1', status: 'REQUESTED'},
      ingestUpdated: {status: 'ACTIVE'},
    });
    const out = await svc.ingestLocations('owner-1', 'sess-1', [GOOD_FIX]);

    expect(qCalls.some(c => /INSERT INTO public\.protection_session_locations/.test(c.sql))).toBe(true);
    const upd = qOneCalls.find(c => /last_fix_at = now\(\)/.test(c.sql));
    // Founder 2026-08-11: the flip is GATED on both sides being device-ready,
    // and the gate is evaluated inside the same UPDATE so it cannot race.
    expect(upd!.sql).toMatch(/status = CASE WHEN s\.status = 'REQUESTED' AND g\.both_ready THEN 'ACTIVE'/);
    expect(upd!.sql).toMatch(/count\(\*\) FILTER \(WHERE ready\) = 2/);
    expect(upd!.sql).toMatch(/FROM public\.protection_session_readiness WHERE session_id = \$1/);
    expect(out).toMatchObject({accepted: 1, status: 'ACTIVE', activated: true});
    expect(events.broadcast).toHaveBeenCalledWith('sess-1', 'psession.status', {status: 'ACTIVE'});
    expect(events.broadcast).toHaveBeenCalledWith('sess-1', 'psession.location', expect.objectContaining({ts: expect.any(Number)}));
  });

  it('a fix on an already-ACTIVE session broadcasts location but not a status change', async () => {
    const {svc, events} = mk({
      ingestSession: {id: 'sess-1', customer_id: 'owner-1', status: 'ACTIVE'},
      ingestUpdated: {status: 'ACTIVE'},
    });
    const out = await svc.ingestLocations('owner-1', 'sess-1', [GOOD_FIX]);
    expect(out.activated).toBe(false);
    expect(events.broadcast).not.toHaveBeenCalledWith('sess-1', 'psession.status', expect.anything());
    expect(events.broadcast).toHaveBeenCalledWith('sess-1', 'psession.location', expect.anything());
  });

  it('a foreign session is 403 and nothing is inserted', async () => {
    const {svc, qCalls} = mk({ingestSession: {id: 'sess-1', customer_id: 'someone-else', status: 'ACTIVE'}});
    await expect(svc.ingestLocations('owner-1', 'sess-1', [GOOD_FIX])).rejects.toMatchObject({message: 'not_your_session'});
    expect(qCalls.some(c => /INSERT INTO public\.protection_session_locations/.test(c.sql))).toBe(false);
  });

  it('a straggler ping on an ended session gets 410 session_ended', async () => {
    const {svc} = mk({ingestSession: {id: 'sess-1', customer_id: 'owner-1', status: 'COMPLETED'}});
    await expect(svc.ingestLocations('owner-1', 'sess-1', [GOOD_FIX]))
      .rejects.toMatchObject({message: 'session_ended', status: 410});
  });

  it('drops invalid + null-island fixes; all-invalid updates nothing', async () => {
    const {svc, qCalls} = mk({ingestSession: {id: 'sess-1', customer_id: 'owner-1', status: 'ACTIVE'}});
    const out = await svc.ingestLocations('owner-1', 'sess-1', [
      {lat: 0, lng: 0, recorded_at: 't'},        // null island
      {lat: 200, lng: 10, recorded_at: 't'},     // out of range
    ]);
    expect(out).toEqual({accepted: 0, status: 'ACTIVE', activated: false, waiting_for_readiness: false});
    expect(qCalls.some(c => /INSERT INTO public\.protection_session_locations/.test(c.sql))).toBe(false);
  });

  it('a fix while a side is NOT ready banks the location but stays REQUESTED', async () => {
    // The DB gate returns the pre-existing status when both_ready is false —
    // the founder rule: one ready side must never start the mission.
    const {svc, qCalls, events} = mk({
      ingestSession: {id: 'sess-1', customer_id: 'owner-1', status: 'REQUESTED'},
      ingestUpdated: {status: 'REQUESTED', both_ready: false},
    });
    const out = await svc.ingestLocations('owner-1', 'sess-1', [GOOD_FIX]);

    expect(out).toMatchObject({accepted: 1, status: 'REQUESTED', activated: false, waiting_for_readiness: true});
    // The fix is still stored — readiness gates ACTIVATION, not the stream.
    expect(qCalls.some(c => /INSERT INTO public\.protection_session_locations/.test(c.sql))).toBe(true);
    expect(events.broadcast).not.toHaveBeenCalledWith('sess-1', 'psession.status', expect.anything());
  });
});

describe('CPO access', () => {
  it('a foreign CPO is 403 and writes NO access audit', async () => {
    const {svc, qCalls} = mk({ownedByCpo: {...SESSION_COLS_ROW, cpo_user_id: 'cpo-OTHER'}});
    await expect(svc.cpoSessionDetail('cpo-1', 'sess-1')).rejects.toMatchObject({message: 'not_your_session'});
    expect(qCalls.some(c => /INSERT INTO public\.protection_access_audit/.test(c.sql))).toBe(false);
  });

  it('the owning CPO gets the trail and an audited view_live', async () => {
    const {svc, qCalls} = mk({
      ownedByCpo: {...SESSION_COLS_ROW, cpo_user_id: 'cpo-1'},
      trail: [{lat: 25.2, lng: 55.3, recorded_at: 't', received_at: 't'}],
    });
    const out = await svc.cpoSessionDetail('cpo-1', 'sess-1');
    const audit = qCalls.find(c => /INSERT INTO public\.protection_access_audit/.test(c.sql));
    expect(audit!.params).toEqual(['cpo-1', 'cpo', 'sess-1', 'view_live']);
    expect((out.trail as unknown[]).length).toBe(1);
    expect(out).toHaveProperty('staleness');
  });

  it('overview is scoped to the calling CPO', async () => {
    const {svc, qCalls} = mk({overviewRows: []});
    await svc.cpoOverview('cpo-1');
    const q = qCalls.find(c => /FROM public\.pro_cpo_assignments pca/.test(c.sql));
    expect(q!.sql).toMatch(/WHERE pca\.cpo_user_id = \$1/);
    expect(q!.params).toEqual(['cpo-1']);
  });
});

describe('ops end + transfer', () => {
  it('ops end sets end_reason ops and broadcasts', async () => {
    const {svc, qOneCalls, events} = mk({
      getByIdRow: {...SESSION_COLS_ROW, status: 'ACTIVE'},
      opsUpdated: {...SESSION_COLS_ROW, status: 'COMPLETED', end_reason: 'ops'},
    });
    const out = await svc.opsEnd(ADMIN, 'sess-1');
    expect(qOneCalls.some(c => /end_reason = 'ops'/.test(c.sql))).toBe(true);
    expect(out.session.status).toBe('COMPLETED');
    expect(events.broadcast).toHaveBeenCalledWith('sess-1', 'psession.status', expect.objectContaining({status: 'COMPLETED'}));
  });

  it('ops end on an already-terminal session is an idempotent no-op', async () => {
    const {svc, qOneCalls} = mk({getByIdRow: {...SESSION_COLS_ROW, status: 'COMPLETED'}});
    const out = await svc.opsEnd(ADMIN, 'sess-1');
    expect(out.session.status).toBe('COMPLETED');
    expect(qOneCalls.some(c => /end_reason = 'ops'/.test(c.sql))).toBe(false);
  });

  it('transfer re-pins cpo_user_id + assignment_id and returns the previous officer', async () => {
    const {svc, qOneCalls, events} = mk({
      getByIdRow: {...SESSION_COLS_ROW, status: 'ACTIVE', cpo_user_id: 'cpo-1', assignment_id: 'asg-1'},
      newCpo: {status: 'ACTIVE'},
      covering: {assignment_id: 'asg-2'},
      transferUpdated: {...SESSION_COLS_ROW, cpo_user_id: 'cpo-2', assignment_id: 'asg-2'},
    });
    const out = await svc.opsTransfer(ADMIN, 'sess-1', 'cpo-2');
    const upd = qOneCalls.find(c => /cpo_user_id = \$2, assignment_id = \$3/.test(c.sql));
    expect(upd!.params).toEqual(['sess-1', 'cpo-2', 'asg-2']); // new covering assignment adopted
    expect(out.previous_cpo_user_id).toBe('cpo-1');
    expect(events.broadcast).toHaveBeenCalled();
  });

  it('transfer keeps the original assignment when the new officer has no covering dedication', async () => {
    const {svc, qOneCalls} = mk({
      getByIdRow: {...SESSION_COLS_ROW, status: 'ACTIVE', cpo_user_id: 'cpo-1', assignment_id: 'asg-1'},
      newCpo: {status: 'ACTIVE'},
      covering: null,
      transferUpdated: {...SESSION_COLS_ROW, cpo_user_id: 'cpo-2', assignment_id: 'asg-1'},
    });
    await svc.opsTransfer(ADMIN, 'sess-1', 'cpo-2');
    const upd = qOneCalls.find(c => /cpo_user_id = \$2, assignment_id = \$3/.test(c.sql));
    expect(upd!.params).toEqual(['sess-1', 'cpo-2', 'asg-1']); // fell back to the old assignment
  });

  it('transfer to the same officer is rejected', async () => {
    const {svc} = mk({getByIdRow: {...SESSION_COLS_ROW, status: 'ACTIVE', cpo_user_id: 'cpo-1'}});
    await expect(svc.opsTransfer(ADMIN, 'sess-1', 'cpo-1')).rejects.toMatchObject({message: 'already_assigned_to_cpo'});
  });

  it('transfer on a non-live session is rejected', async () => {
    const {svc} = mk({getByIdRow: {...SESSION_COLS_ROW, status: 'COMPLETED', cpo_user_id: 'cpo-1'}});
    await expect(svc.opsTransfer(ADMIN, 'sess-1', 'cpo-2')).rejects.toMatchObject({message: 'session_not_live'});
  });
});

describe('mission-history timeline (§5/§7)', () => {
  it('customer timeline filters internal events (visibility=all) + derives protection_status', async () => {
    const {svc, qCalls} = mk({getByIdRow: {...SESSION_COLS_ROW, customer_id: 'owner-1', status: 'ACTIVE', protect_activated_at: 't'}});
    const out = await svc.customerTimeline('owner-1', 'sess-1');
    const q = qCalls.find(c => /FROM public\.protection_session_events/.test(c.sql));
    expect(q!.sql).toMatch(/visibility = 'all'/);
    expect(out).toMatchObject({protection_status: 'active', mission_status: 'ACTIVE'});
  });

  it('a foreign customer cannot read the timeline', async () => {
    const {svc} = mk({getByIdRow: {...SESSION_COLS_ROW, customer_id: 'someone-else'}});
    await expect(svc.customerTimeline('owner-1', 'sess-1')).rejects.toMatchObject({message: 'not_your_session'});
  });

  it('ops timeline has NO visibility filter — full audit', async () => {
    const {svc, qCalls} = mk({getByIdRow: {...SESSION_COLS_ROW}});
    await svc.opsTimeline(ADMIN, 'sess-1');
    const q = qCalls.find(c => /FROM public\.protection_session_events/.test(c.sql));
    expect(q!.sql).not.toMatch(/visibility = 'all'/);
  });
});
