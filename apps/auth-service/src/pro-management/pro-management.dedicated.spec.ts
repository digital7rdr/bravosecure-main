/**
 * Dedicated-officer handling in the ops assignment surfaces (founder
 * 2026-08-10): a member's own dedicated officer must never dead-end as BUSY.
 *  - listPool annotates the requesting application's covering officer as
 *    `dedicated` and keeps him selectable (available) despite busy_in_window.
 *  - scheduleRequestWithCpos REUSES a covering same-plan assignment instead
 *    of inserting (the gist exclusion forbids a second overlapping row), and
 *    a later failure must not cancel the pre-existing dedication row.
 *  - createAssignment is idempotent over a covered same-plan window.
 * DatabaseService is mocked — SQL text and bind values are the pinned behavior.
 */
import {ProManagementService} from './pro-management.service';
import type {DatabaseService} from '../database/database.service';
import type {AdminContext} from '../ops/admin.guard';

const ADMIN = {user_id: 'admin-1', call_sign: 'OPS'} as unknown as AdminContext;

function mk(opts: {
  covering?: Record<string, unknown> | null;
  poolRows?: Array<Record<string, unknown>>;
  conflictsByCpo?: Record<string, Array<Record<string, unknown>>>;
} = {}) {
  const qCalls: Array<{sql: string; params?: unknown[]}> = [];
  const qOneCalls: Array<{sql: string; params?: unknown[]}> = [];
  const db = {
    q: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
      qCalls.push({sql, params});
      if (/AS busy_in_window/.test(sql)) {return Promise.resolve(opts.poolRows ?? []);}
      if (/&& daterange/.test(sql)) {
        return Promise.resolve(opts.conflictsByCpo?.[String(params?.[0])] ?? []);
      }
      return Promise.resolve([]);
    }),
    qOne: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
      qOneCalls.push({sql, params});
      if (/FROM pro_plan_missions WHERE id/.test(sql)) {
        return Promise.resolve({id: 'msn-1', status: 'REQUESTED', mission_dates: ['2030-01-10', '2030-01-12']});
      }
      if (/FROM pro_applications WHERE id/.test(sql)) {
        return Promise.resolve({id: 'app-1', user_id: 'client-1', status: 'ACTIVE'});
      }
      if (/FROM pro_proposals/.test(sql)) {
        return Promise.resolve({coverage_start: '2030-01-01', coverage_end: '2030-12-31'});
      }
      if (/FROM agents WHERE user_id/.test(sql)) {return Promise.resolve({status: 'ACTIVE'});}
      if (/FROM org_members/.test(sql)) {
        return Promise.resolve({org_user_id: 'org-1', status: 'active', suspended_until: null});
      }
      // coveringAssignment binds [applicationId, cpoUserId, startsOn, endsOn] —
      // only the dedicated officer's lookup returns the row.
      if (/@> daterange/.test(sql)) {
        const cpo = String(params?.[1]);
        const row = opts.covering ?? null;
        return Promise.resolve(row && String(row.cpo_user_id) === cpo ? row : null);
      }
      if (/UPDATE pro_plan_missions/.test(sql)) {
        return Promise.resolve({id: 'msn-1', status: 'SCHEDULED', assigned_team: [], ops_note: null});
      }
      if (/INSERT INTO pro_cpo_assignments/.test(sql)) {
        return Promise.resolve({
          id: 'asg-new', application_id: 'app-1', mission_id: 'msn-1',
          cpo_user_id: params?.[2], org_user_id: 'org-1',
          starts_on: '2030-01-10', ends_on: '2030-01-12',
          status: 'ASSIGNED', mission_code: 'PMC-NEWROW', note: null, created_at: 'now',
        });
      }
      if (/FROM users WHERE id/.test(sql)) {return Promise.resolve({display_name: 'Vinod'});}
      return Promise.resolve(null);
    }),
    withTransaction: jest.fn(),
  } as unknown as DatabaseService;
  const push = {proMissionUpdate: jest.fn().mockResolvedValue(undefined)};
  const svc = new ProManagementService(
    db, {} as never, {} as never,
    {broadcast: jest.fn().mockResolvedValue(undefined)} as never,
    push as never,
  );
  return {svc, qCalls, qOneCalls, push};
}

const DEDICATION = {
  id: 'asg-1', application_id: 'app-1', mission_id: null, cpo_user_id: 'cpo-1',
  org_user_id: 'org-1', starts_on: '2030-01-01', ends_on: '2030-03-31',
  status: 'ASSIGNED', mission_code: 'PMC-ABCDEF', note: null, created_at: 'now',
};

describe('ProManagementService — dedicated officer in listPool', () => {
  it('annotates dedicated_in_window for the requesting application and keeps him available', async () => {
    const {svc, qCalls} = mk({poolRows: [
      {id: 'cpo-1', member_status: 'active', suspended_until: null, busy_in_window: true, dedicated_in_window: true},
      {id: 'cpo-2', member_status: 'active', suspended_until: null, busy_in_window: true, dedicated_in_window: false},
      {id: 'cpo-3', member_status: 'active', suspended_until: null, busy_in_window: false, dedicated_in_window: false},
    ]});
    const out = await svc.listPool('2030-01-10', '2030-01-12', 'app-1');

    const pool = qCalls.find(c => /AS busy_in_window/.test(c.sql));
    expect(pool).toBeDefined();
    expect(pool!.sql).toMatch(/AS dedicated_in_window/);
    expect(pool!.sql).toMatch(/@> daterange/);
    expect(pool!.params).toEqual(['2030-01-10', '2030-01-12', 'app-1']);

    const byId = new Map(out.cpos.map(c => [c.id as string, c]));
    expect(byId.get('cpo-1')).toMatchObject({dedicated: true, available: true});
    expect(byId.get('cpo-2')).toMatchObject({dedicated: false, available: false});
    expect(byId.get('cpo-3')).toMatchObject({dedicated: false, available: true});
  });

  it('passes null when no application context (dedicated never set)', async () => {
    const {svc, qCalls} = mk({poolRows: []});
    await svc.listPool('2030-01-10', '2030-01-12');
    const pool = qCalls.find(c => /AS busy_in_window/.test(c.sql));
    expect(pool!.params).toEqual(['2030-01-10', '2030-01-12', null]);
  });
});

describe('ProManagementService — scheduleRequestWithCpos reuses the dedication', () => {
  it('covering same-plan assignment → no INSERT, existing row returned, request SCHEDULED', async () => {
    const {svc, qOneCalls, push} = mk({covering: DEDICATION});
    const out = await svc.scheduleRequestWithCpos(ADMIN, 'app-1', 'msn-1', {cpo_user_ids: ['cpo-1']});

    expect(qOneCalls.some(c => /INSERT INTO pro_cpo_assignments/.test(c.sql))).toBe(false);
    expect((out.assignments as Array<{id: string}>).map(a => a.id)).toEqual(['asg-1']);
    expect(qOneCalls.some(c => /UPDATE pro_plan_missions/.test(c.sql) && /'SCHEDULED'/.test(c.sql))).toBe(true);
    expect(push.proMissionUpdate).toHaveBeenCalledWith('client-1', 'app-1', 'SCHEDULED');
  });

  it('a failure after a reused row must NOT cancel the pre-existing dedication', async () => {
    const {svc, qCalls} = mk({
      covering: DEDICATION,
      conflictsByCpo: {'cpo-2': [{member_name: 'Other Member', starts_on: '2030-01-09', ends_on: '2030-01-11'}]},
    });
    await expect(
      svc.scheduleRequestWithCpos(ADMIN, 'app-1', 'msn-1', {cpo_user_ids: ['cpo-1', 'cpo-2']}),
    ).rejects.toMatchObject({response: expect.objectContaining({message: 'cpo_unavailable_overlap'})});

    const cancels = qCalls.filter(c => /UPDATE pro_cpo_assignments SET status = 'CANCELLED'/.test(c.sql));
    expect(cancels.some(c => (c.params ?? []).includes('asg-1'))).toBe(false);
  });
});

describe('ProManagementService — createAssignment idempotent over a covered window', () => {
  it('returns the covering same-plan assignment instead of inserting a doomed duplicate', async () => {
    const {svc, qOneCalls, qCalls} = mk({covering: DEDICATION});
    const out = await svc.createAssignment(ADMIN, {
      application_id: 'app-1', cpo_user_id: 'cpo-1',
      starts_on: '2030-01-10', ends_on: '2030-01-12',
    } as never);

    expect(out.assignment.id).toBe('asg-1');
    expect(qOneCalls.some(c => /INSERT INTO pro_cpo_assignments/.test(c.sql))).toBe(false);
    expect(qCalls.some(c => /cpo\.assigned/.test(c.sql))).toBe(false);
  });

  it('covering lookup is scoped to THIS application (a foreign dedication still 409s)', async () => {
    const {svc} = mk({
      covering: null,
      conflictsByCpo: {'cpo-1': [{member_name: 'Other Member', starts_on: '2030-01-01', ends_on: '2030-03-31'}]},
    });
    await expect(svc.createAssignment(ADMIN, {
      application_id: 'app-1', cpo_user_id: 'cpo-1',
      starts_on: '2030-01-10', ends_on: '2030-01-12',
    } as never)).rejects.toMatchObject({response: expect.objectContaining({message: 'cpo_unavailable_overlap'})});
  });
});
