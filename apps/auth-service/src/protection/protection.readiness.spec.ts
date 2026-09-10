/**
 * Mission-start readiness gate (founder 2026-08-11).
 *
 * THE RULE: a protection session becomes ACTIVE only when BOTH the protected
 * customer AND the assigned CPO hold real device capability. One ready side is
 * never enough, a rendered map is not evidence of location, and the backend —
 * not either app — decides. Every numbered case below maps to a founder edge
 * case. DatabaseService is mocked; SQL text and bind values are the contract.
 */
import {ProtectionService} from './protection.service';
import type {DatabaseService} from '../database/database.service';

const ALL_GOOD = {
  location_permission: true, location_services: true, precise_location: true,
  connectivity: true, location_available: true, platform: 'android',
};

type Row = Record<string, unknown>;

function mk(opts: {
  session?: Row | null;
  readinessRows?: Row[];
  beforeReady?: Row | null;
  activated?: Row | null;
} = {}) {
  const qCalls: Array<{sql: string; params?: unknown[]}> = [];
  const qOneCalls: Array<{sql: string; params?: unknown[]}> = [];
  const db = {
    q: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
      qCalls.push({sql, params});
      if (/SELECT role, ready, location_permission/.test(sql)) {
        return Promise.resolve(opts.readinessRows ?? []);
      }
      return Promise.resolve([]);
    }),
    qOne: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
      qOneCalls.push({sql, params});
      if (/SELECT id, customer_id, cpo_user_id, status, last_fix_at/.test(sql)) {
        return Promise.resolve(
          opts.session === undefined
            ? {id: 'sess-1', customer_id: 'owner-1', cpo_user_id: 'cpo-1', status: 'REQUESTED', last_fix_at: null}
            : opts.session,
        );
      }
      if (/SELECT ready FROM public\.protection_session_readiness/.test(sql)) {
        return Promise.resolve(opts.beforeReady ?? null);
      }
      if (/SET status = 'ACTIVE', activated_at = now\(\)/.test(sql)) {
        return Promise.resolve(opts.activated ?? null);
      }
      return Promise.resolve(null);
    }),
  } as unknown as DatabaseService;
  const events = {broadcast: jest.fn().mockResolvedValue(undefined)};
  const push = {
    psessionNew: jest.fn().mockResolvedValue(undefined),
    psessionStarted: jest.fn().mockResolvedValue(undefined),
    psessionEnded: jest.fn().mockResolvedValue(undefined),
    proCpoChanged: jest.fn().mockResolvedValue(undefined),
  };
  const svc = new ProtectionService(
    db, {emit: jest.fn().mockResolvedValue(undefined)} as never, events as never, push as never,
  );
  return {svc, db, qCalls, qOneCalls, events};
}

const side = (role: string, ready: boolean, over: Row = {}): Row => ({
  role, ready,
  location_permission: ready, location_services: ready, precise_location: ready,
  connectivity: ready, location_available: ready, reported_at: 't', ...over,
});

describe('reportReadiness — the app reports, the server judges', () => {
  it('stores exactly what the OS said, keyed by session+role (idempotent upsert)', async () => {
    const {svc, qCalls} = mk();
    await svc.reportReadiness('owner-1', 'sess-1', 'customer', ALL_GOOD);

    const ins = qCalls.find(c => /INSERT INTO public\.protection_session_readiness/.test(c.sql))!;
    expect(ins.sql).toMatch(/ON CONFLICT \(session_id, role\) DO UPDATE/);
    expect(ins.params).toEqual(['sess-1', 'customer', 'owner-1', true, true, true, true, true, 'android']);
  });

  it('never lets a caller set `ready` itself — it is not in the INSERT column list', async () => {
    const {svc, qCalls} = mk();
    await svc.reportReadiness('owner-1', 'sess-1', 'customer', ALL_GOOD);
    const ins = qCalls.find(c => /INSERT INTO public\.protection_session_readiness/.test(c.sql))!;
    const columns = /\(([^)]*)\)\s*VALUES/.exec(ins.sql)![1];
    expect(columns).not.toMatch(/\bready\b/);
  });

  it('rejects a session the caller does not own, on either side', async () => {
    const {svc, qCalls} = mk();
    await expect(svc.reportReadiness('someone-else', 'sess-1', 'customer', ALL_GOOD))
      .rejects.toMatchObject({message: 'not_your_session'});
    const {svc: svc2, qCalls: q2} = mk();
    await expect(svc2.reportReadiness('owner-1', 'sess-1', 'cpo', ALL_GOOD))
      .rejects.toMatchObject({message: 'not_your_session'});
    expect(qCalls.concat(q2).some(c => /INSERT INTO public\.protection_session_readiness/.test(c.sql))).toBe(false);
  });

  it('410s on an already-ended session', async () => {
    const {svc} = mk({session: {id: 'sess-1', customer_id: 'owner-1', cpo_user_id: 'cpo-1', status: 'COMPLETED', last_fix_at: 't'}});
    await expect(svc.reportReadiness('owner-1', 'sess-1', 'customer', ALL_GOOD))
      .rejects.toMatchObject({message: 'session_ended', status: 410});
  });

  it('broadcasts a refetch trigger carrying NO device detail', async () => {
    const {svc, events} = mk();
    await svc.reportReadiness('owner-1', 'sess-1', 'customer', ALL_GOOD);
    const call = events.broadcast.mock.calls.find(c => c[1] === 'psession.readiness')!;
    expect(Object.keys(call[2] as object)).toEqual(['ts']);
  });
});

describe('sessionReadiness — what is missing, per side', () => {
  it('READY only when BOTH sides are ready', async () => {
    const {svc} = mk({readinessRows: [side('customer', true), side('cpo', true)]});
    const out = await svc.sessionReadiness('sess-1');
    expect(out.state).toBe('READY');
    expect(out.blocked_by).toEqual([]);
  });

  it.each([
    ['customer ready, CPO not (edge case 3)', [side('customer', true), side('cpo', false)], ['cpo']],
    ['CPO ready, customer not (edge case 4)', [side('customer', false), side('cpo', true)], ['customer']],
    ['neither ready', [side('customer', false), side('cpo', false)], ['customer', 'cpo']],
  ])('%s → WAITING_FOR_READINESS, naming the blocking side', async (_label, rows, blocked) => {
    const {svc} = mk({readinessRows: rows});
    const out = await svc.sessionReadiness('sess-1');
    expect(out.state).toBe('WAITING_FOR_READINESS');
    expect(out.blocked_by).toEqual(blocked);
  });

  it('a side that never reported is NOT ready and owes everything (never optimistic)', async () => {
    const {svc} = mk({readinessRows: [side('customer', true)]});
    const out = await svc.sessionReadiness('sess-1');
    const cpo = out.cpo as {ready: boolean; reported: boolean; missing: string[]};
    expect(cpo.ready).toBe(false);
    expect(cpo.reported).toBe(false);
    expect(cpo.missing).toEqual([
      'location_permission', 'location_services', 'precise_location',
      'connectivity', 'location_available',
    ]);
  });

  it('lists ONLY the unmet requirements so the app can name them (edge case 5)', async () => {
    // Permission granted but the OS location switch is off.
    const {svc} = mk({
      readinessRows: [side('customer', false, {
        location_permission: true, location_services: false,
        precise_location: true, connectivity: true, location_available: false,
      }), side('cpo', true)],
    });
    const out = await svc.sessionReadiness('sess-1');
    expect((out.customer as {missing: string[]}).missing).toEqual(['location_services', 'location_available']);
  });
});

describe('activation gate', () => {
  it('edge case 11 — the LAST side to become ready activates, if a fix is already banked', async () => {
    const {svc, qOneCalls, events} = mk({
      session: {id: 'sess-1', customer_id: 'owner-1', cpo_user_id: 'cpo-1', status: 'REQUESTED', last_fix_at: 't'},
      readinessRows: [side('customer', true), side('cpo', true)],
      activated: {status: 'ACTIVE'},
    });
    const out = await svc.reportReadiness('cpo-1', 'sess-1', 'cpo', ALL_GOOD);

    expect(out.activated).toBe(true);
    const flip = qOneCalls.find(c => /SET status = 'ACTIVE', activated_at = now\(\)/.test(c.sql))!;
    // Same predicate as the ingest path: still REQUESTED, a real fix exists,
    // and BOTH readiness rows are ready.
    expect(flip.sql).toMatch(/s\.status = 'REQUESTED'/);
    expect(flip.sql).toMatch(/s\.last_fix_at IS NOT NULL/);
    expect(flip.sql).toMatch(/count\(\*\) FILTER \(WHERE ready\) = 2/);
    expect(events.broadcast).toHaveBeenCalledWith('sess-1', 'psession.status', {status: 'ACTIVE'});
  });

  it('does not activate while the pair is incomplete', async () => {
    const {svc, events} = mk({
      session: {id: 'sess-1', customer_id: 'owner-1', cpo_user_id: 'cpo-1', status: 'REQUESTED', last_fix_at: 't'},
      readinessRows: [side('customer', true), side('cpo', false)],
      activated: null, // the guarded UPDATE matched no row
    });
    const out = await svc.reportReadiness('owner-1', 'sess-1', 'customer', ALL_GOOD);
    expect(out.activated).toBe(false);
    expect(events.broadcast).not.toHaveBeenCalledWith('sess-1', 'psession.status', expect.anything());
  });
});

describe('edge case 6 — capability lost mid-session', () => {
  it('records a timeline event when a side that WAS ready stops being ready', async () => {
    const {svc, qCalls} = mk({
      session: {id: 'sess-1', customer_id: 'owner-1', cpo_user_id: 'cpo-1', status: 'ACTIVE', last_fix_at: 't'},
      beforeReady: {ready: true},
      readinessRows: [side('customer', false), side('cpo', true)],
    });
    await svc.reportReadiness('owner-1', 'sess-1', 'customer', {...ALL_GOOD, location_permission: false});

    const evt = qCalls.find(c => /INSERT INTO public\.protection_session_events/.test(c.sql))!;
    expect(evt.params).toEqual(expect.arrayContaining(['readiness']));
    expect(String(evt.params![6])).toMatch(/lost location readiness/i);
  });

  it('does NOT spam the timeline when a side was already not ready', async () => {
    const {svc, qCalls} = mk({
      session: {id: 'sess-1', customer_id: 'owner-1', cpo_user_id: 'cpo-1', status: 'ACTIVE', last_fix_at: 't'},
      beforeReady: {ready: false},
      readinessRows: [side('customer', false), side('cpo', true)],
    });
    await svc.reportReadiness('owner-1', 'sess-1', 'customer', {...ALL_GOOD, location_permission: false});
    expect(qCalls.some(c => /INSERT INTO public\.protection_session_events/.test(c.sql))).toBe(false);
  });
});

describe('the readiness table itself', () => {
  it('derives `ready` in the DB so no client can assert it', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs');
    const sql = fs.readFileSync(
      require('path').join(__dirname, '../../../../supabase/migrations/20260811140000_protection_session_readiness.sql'),
      'utf8',
    );
    expect(sql).toMatch(/ready\s+boolean GENERATED ALWAYS AS \(/);
    for (const col of ['location_permission', 'location_services', 'precise_location', 'connectivity', 'location_available']) {
      expect(sql).toMatch(new RegExp(`${col}[\\s\\S]{0,200}\\)\\s*STORED`));
    }
    // Deny-all posture for anon/authenticated (the anon key ships in the APK).
    expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/FORCE ROW LEVEL SECURITY/);
    expect(sql).not.toMatch(/CREATE POLICY/);
  });
});
