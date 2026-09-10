/**
 * Protection-session service — FSM guards, create validations, the
 * unique-index (23505) "open the existing session" handler, end idempotency,
 * SOS-vs-end isolation, access denials, and the lazy sweeps. DatabaseService is
 * mocked; SQL text + bind values are the pinned behavior (repo's q/qOne regex
 * mock pattern, cf. pro-management.dedicated.spec.ts).
 */
import {ProtectionService} from './protection.service';
import type {DatabaseService} from '../database/database.service';

const APP_ACTIVE = {id: 'app-1', user_id: 'owner-1', status: 'ACTIVE'};
const COVERING = {assignment_id: 'asg-1', cpo_user_id: 'cpo-1'};
const SESSION_ROW = {
  id: 'sess-1', application_id: 'app-1', customer_id: 'owner-1', cpo_user_id: 'cpo-1',
  assignment_id: 'asg-1', status: 'REQUESTED', requested_at: 't', activated_at: null,
  ended_at: null, end_reason: null, last_fix_at: null, sos_active: false,
  created_at: 't', updated_at: 't',
};
const CPO_IDENTITY = {cpo_name: 'Vinod', cpo_avatar: null, call_sign: 'B-12'};

type Opts = {
  app?: Record<string, unknown> | null;
  member?: Record<string, unknown> | null;
  covering?: Record<string, unknown> | null;
  insert?: Record<string, unknown> | '23505' | Error;
  existingLive?: Record<string, unknown> | null;
  owned?: Record<string, unknown> | null;
  updated?: Record<string, unknown> | null;
};

function mk(opts: Opts = {}) {
  const qCalls: Array<{sql: string; params?: unknown[]}> = [];
  const qOneCalls: Array<{sql: string; params?: unknown[]}> = [];
  const db = {
    q: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
      qCalls.push({sql, params});
      // listHistory is the only q() that returns rows to a caller.
      if (/FROM public\.protection_sessions s\b[\s\S]*LIMIT \$2/.test(sql)) {
        return Promise.resolve(opts.owned ? [opts.owned] : []);
      }
      return Promise.resolve([]); // sweeps + retention DELETE
    }),
    qOne: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
      qOneCalls.push({sql, params});
      if (/FROM public\.pro_applications WHERE id/.test(sql)) {
        return Promise.resolve('app' in opts ? opts.app : APP_ACTIVE);
      }
      if (/FROM public\.family_members/.test(sql)) {
        return Promise.resolve(opts.member ?? null);
      }
      if (/AS assignment_id, cpo_user_id[\s\S]*FROM public\.pro_cpo_assignments/.test(sql)) {
        return Promise.resolve('covering' in opts ? opts.covering : COVERING);
      }
      if (/INSERT INTO public\.protection_sessions/.test(sql)) {
        const ins = opts.insert ?? SESSION_ROW;
        if (ins === '23505') {return Promise.reject({code: '23505'});}
        if (ins instanceof Error) {return Promise.reject(ins);}
        return Promise.resolve(ins);
      }
      // cpoIdentityFor — SELECT u.display_name ... FROM public.users u
      if (/FROM public\.users u\b/.test(sql) && /pca\.id = \$2/.test(sql)) {
        return Promise.resolve(CPO_IDENTITY);
      }
      // liveSessionWithCpo — joined SELECT off protection_sessions s
      if (/FROM public\.protection_sessions s\b/.test(sql) && /LIMIT 1/.test(sql)) {
        return Promise.resolve(opts.existingLive ?? null);
      }
      // end() — owned read (no alias, no join)
      if (/SELECT[\s\S]*FROM public\.protection_sessions WHERE id = \$1/.test(sql)) {
        return Promise.resolve(opts.owned ?? null);
      }
      // end() — guarded UPDATE
      if (/UPDATE public\.protection_sessions[\s\S]*status = 'COMPLETED'/.test(sql)) {
        return Promise.resolve(opts.updated ?? null);
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
  return {svc, db, qCalls, qOneCalls, opsAudit, events, push};
}

describe('ProtectionService.create', () => {
  it('inserts a REQUESTED session pinned to the covering officer', async () => {
    const {svc, qOneCalls} = mk();
    const out = await svc.create('owner-1', 'app-1');

    const insert = qOneCalls.find(c => /INSERT INTO public\.protection_sessions/.test(c.sql));
    expect(insert).toBeDefined();
    // [applicationId, customerId, cpo_user_id, assignment_id]
    expect(insert!.params).toEqual(['app-1', 'owner-1', 'cpo-1', 'asg-1']);
    expect(out.already_active).toBe(false);
    expect(out.session).toMatchObject({id: 'sess-1', cpo_name: 'Vinod'});
  });

  it('rejects when the plan is not ACTIVE and never inserts', async () => {
    const {svc, qOneCalls} = mk({app: {id: 'app-1', user_id: 'owner-1', status: 'EXPIRED'}});
    await expect(svc.create('owner-1', 'app-1')).rejects.toMatchObject({message: 'plan_not_active'});
    expect(qOneCalls.some(c => /INSERT INTO public\.protection_sessions/.test(c.sql))).toBe(false);
  });

  it('409 no_cpo_assigned + ops alert when no officer covers today', async () => {
    const {svc, opsAudit, qOneCalls} = mk({covering: null});
    await expect(svc.create('owner-1', 'app-1')).rejects.toMatchObject({message: 'no_cpo_assigned'});
    expect(opsAudit.emit).toHaveBeenCalledWith(expect.objectContaining({kind: 'protection', subject: 'app-1'}));
    expect(qOneCalls.some(c => /INSERT INTO public\.protection_sessions/.test(c.sql))).toBe(false);
  });

  it('23505 unique-index race OPENS the existing live session (already_active)', async () => {
    const existing = {...SESSION_ROW, id: 'sess-existing', status: 'ACTIVE', ...CPO_IDENTITY};
    const {svc} = mk({insert: '23505', existingLive: existing});
    const out = await svc.create('owner-1', 'app-1');
    expect(out.already_active).toBe(true);
    expect(out.session.id).toBe('sess-existing');
  });

  it('an active linked member may open a session against the owner plan', async () => {
    const {svc} = mk({app: {id: 'app-1', user_id: 'owner-1', status: 'ACTIVE'}, member: {id: 'fm-1'}});
    const out = await svc.create('member-9', 'app-1');
    // customer_id is the MEMBER (their location only, §13.5).
    const insertParams = out.session; // sanity: created
    expect(insertParams).toBeDefined();
  });

  it('a stranger with no membership is refused', async () => {
    const {svc} = mk({app: {id: 'app-1', user_id: 'owner-1', status: 'ACTIVE'}, member: null});
    await expect(svc.create('stranger-9', 'app-1')).rejects.toMatchObject({message: 'not_your_application'});
  });

  it('prunes coordinates on the create path (retention sweep, days => 30)', async () => {
    const {svc, qCalls} = mk();
    await svc.create('owner-1', 'app-1');
    const del = qCalls.find(c => /DELETE FROM public\.protection_session_locations/.test(c.sql));
    expect(del).toBeDefined();
    expect(del!.sql).toMatch(/make_interval\(days => 30\)/);
  });
});

describe('ProtectionService.getCurrent', () => {
  it('runs both status sweeps then returns the session + server clock', async () => {
    const live = {...SESSION_ROW, status: 'ACTIVE', ...CPO_IDENTITY};
    const {svc, qCalls} = mk({existingLive: live});
    const out = await svc.getCurrent('owner-1');

    expect(qCalls.some(c => /status = 'REQUESTED'[\s\S]*make_interval\(mins => 10\)/.test(c.sql))).toBe(true);
    expect(qCalls.some(c => /status = 'ACTIVE'[\s\S]*make_interval\(hours => 12\)/.test(c.sql))).toBe(true);
    expect(out.session.id).toBe('sess-1');
    expect(typeof out.server_now).toBe('string');
  });

  it('404 when the caller has no live session', async () => {
    const {svc} = mk({existingLive: null});
    await expect(svc.getCurrent('owner-1')).rejects.toMatchObject({message: 'no_active_session'});
  });
});

describe('ProtectionService.end', () => {
  it('live session → COMPLETED with end_reason customer', async () => {
    const owned = {...SESSION_ROW, customer_id: 'owner-1', status: 'ACTIVE'};
    const updated = {...owned, status: 'COMPLETED', end_reason: 'customer', ended_at: 't2'};
    const {svc, qOneCalls} = mk({owned, updated});
    const out = await svc.end('owner-1', 'sess-1');

    const upd = qOneCalls.find(c => /UPDATE public\.protection_sessions[\s\S]*status = 'COMPLETED'/.test(c.sql));
    expect(upd).toBeDefined();
    expect(upd!.sql).toMatch(/end_reason = 'customer'/);
    expect(out.session.status).toBe('COMPLETED');
  });

  it('idempotent: an already-terminal session returns without an UPDATE', async () => {
    const owned = {...SESSION_ROW, customer_id: 'owner-1', status: 'COMPLETED'};
    const {svc, qOneCalls} = mk({owned});
    const out = await svc.end('owner-1', 'sess-1');
    expect(out.session.status).toBe('COMPLETED');
    expect(qOneCalls.some(c => /UPDATE public\.protection_sessions/.test(c.sql))).toBe(false);
  });

  it('a foreign session is 403, never ended', async () => {
    const owned = {...SESSION_ROW, customer_id: 'someone-else', status: 'ACTIVE'};
    const {svc, qOneCalls} = mk({owned});
    await expect(svc.end('owner-1', 'sess-1')).rejects.toMatchObject({message: 'not_your_session'});
    expect(qOneCalls.some(c => /UPDATE public\.protection_sessions/.test(c.sql))).toBe(false);
  });

  it('ending NEVER touches sos_events and never clears sos_active (§3 isolation)', async () => {
    const owned = {...SESSION_ROW, customer_id: 'owner-1', status: 'ACTIVE', sos_active: true};
    const updated = {...owned, status: 'COMPLETED', end_reason: 'customer'};
    const {svc, qCalls, qOneCalls} = mk({owned, updated});
    await svc.end('owner-1', 'sess-1');
    const allSql = [...qCalls, ...qOneCalls].map(c => c.sql).join('\n');
    // Never write the SOS row, never CLEAR sos_active (it may appear in a
    // SELECT/RETURNING column list — that is a read, which is fine).
    expect(allSql).not.toMatch(/sos_events/);
    expect(allSql).not.toMatch(/sos_active\s*=/);
  });
});
