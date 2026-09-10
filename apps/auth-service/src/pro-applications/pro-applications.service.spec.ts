/**
 * Ops-surface projections of ProApplicationsService (audit 2026-08-07):
 *  - F1  (SK-01/CA-02/IS-01): both ops projections carry the derived
 *    covered_until alias so no surface renders the off-by-one
 *    current_period_end directly.
 *  - F2  (SK-07/IS-03): getForOps returns the applicant's linked family
 *    members (queried by holder_id = applicant).
 *  - F3  (IS-02): getForOps resolves decided_by to a display identity.
 *  - F16 (IS-08/CA-10): actionable buckets list oldest-first; everything
 *    else stays newest-first.
 * DatabaseService is mocked — the SQL text and bind values ARE the behavior
 * a unit test can honestly pin here (same rationale as booking.list.spec.ts).
 */
import {ProApplicationsService} from './pro-applications.service';
import type {DatabaseService} from '../database/database.service';

function mk() {
  const qCalls: Array<{sql: string; params?: unknown[]}> = [];
  const qOneCalls: Array<{sql: string; params?: unknown[]}> = [];
  const db = {
    q: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
      qCalls.push({sql, params});
      return Promise.resolve([]);
    }),
    qOne: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
      qOneCalls.push({sql, params});
      if (/FROM pro_applications pa/.test(sql)) {
        return Promise.resolve({id: 'app-1', user_id: 'client-1', status: 'ACTIVE'});
      }
      return Promise.resolve(null);
    }),
    withTransaction: jest.fn(),
  } as unknown as DatabaseService;
  const svc = new ProApplicationsService(
    db, {} as never, {} as never,
    {broadcast: jest.fn().mockResolvedValue(undefined)} as never,
    {} as never,
  );
  return {svc, db, qCalls, qOneCalls};
}

const listSql = (qCalls: Array<{sql: string}>) =>
  qCalls.find(c => /LEFT JOIN LATERAL/.test(c.sql) && /u\.display_name AS client_name/.test(c.sql))?.sql ?? '';

describe('ProApplicationsService — ops projections', () => {
  it('listForOps carries the derived covered_until (never raw current_period_end alone)', async () => {
    const {svc, qCalls} = mk();
    await svc.listForOps('all');
    const sql = listSql(qCalls);
    expect(sql).toMatch(/current_period_end - interval '1 day'.*AS covered_until/);
    expect(sql).toMatch(/pa\.activated_at/);
  });

  it('listForOps orders the actionable buckets oldest-first (queue drains fairly)', async () => {
    const {svc, qCalls} = mk();
    await svc.listForOps('PENDING_PROPOSAL');
    expect(listSql(qCalls)).toMatch(/ORDER BY pa\.submitted_at ASC/);
  });

  it('listForOps keeps REVISION_REQUESTED oldest-first too', async () => {
    const {svc, qCalls} = mk();
    await svc.listForOps('REVISION_REQUESTED');
    expect(listSql(qCalls)).toMatch(/ORDER BY pa\.submitted_at ASC/);
  });

  it('listForOps keeps every non-actionable view newest-first', async () => {
    const {svc, qCalls} = mk();
    await svc.listForOps('ACTIVE');
    expect(listSql(qCalls)).toMatch(/ORDER BY pa\.submitted_at DESC/);
  });

  it('getForOps projects covered_until + the decided_by identity join', async () => {
    const {svc, qOneCalls} = mk();
    await svc.getForOps('app-1');
    const appSql = qOneCalls.find(c => /FROM pro_applications pa/.test(c.sql))?.sql ?? '';
    expect(appSql).toMatch(/AS covered_until/);
    expect(appSql).toMatch(/du\.display_name AS decided_by_name/);
    expect(appSql).toMatch(/du\.email AS decided_by_email/);
  });

  it('getForOps returns the applicant family block, queried by holder_id = applicant', async () => {
    const {svc, qCalls} = mk();
    const out = await svc.getForOps('app-1');
    expect(out).toHaveProperty('family');
    const fam = qCalls.find(c => /FROM public\.family_members fm/.test(c.sql));
    expect(fam).toBeDefined();
    expect(fam!.sql).toMatch(/fm\.held_until/);
    expect(fam!.params).toEqual(['client-1']);
  });
});

/**
 * Dedicated-officer fast path (founder 2026-08-10): a Pro member whose plan
 * already has an ops-assigned officer covering the requested dates must NOT
 * land back in the ops queue — the request routes straight to that officer.
 * Before this, the member's own dedicated officer read as BUSY in the ops
 * pool (his dedication window to this very member) and the request dead-ended.
 */
function mkMission(dedicated: Array<{cpo_user_id: string; cpo_name: string | null}>) {
  const qCalls: Array<{sql: string; params?: unknown[]}> = [];
  const qOneCalls: Array<{sql: string; params?: unknown[]}> = [];
  const db = {
    q: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
      qCalls.push({sql, params});
      if (/FROM pro_cpo_assignments/.test(sql)) {return Promise.resolve(dedicated);}
      return Promise.resolve([]);
    }),
    qOne: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
      qOneCalls.push({sql, params});
      if (/FROM pro_applications WHERE id/.test(sql)) {
        return Promise.resolve({id: 'app-1', user_id: 'client-1', status: 'ACTIVE'});
      }
      if (/FROM pro_proposals/.test(sql)) {
        return Promise.resolve({
          id: 'prop-1', proposal_number: 'P-1', version: 1, valid_until: '2031-01-01',
          coverage_start: '2030-01-01', coverage_end: '2030-12-31', total_credits: 100,
        });
      }
      if (/INSERT INTO pro_plan_missions/.test(sql)) {
        return Promise.resolve({
          id: 'msn-1', application_id: 'app-1', requested_by: 'client-1',
          mission_dates: params?.[2] ?? [], note: null,
          status: /'SCHEDULED'/.test(sql) ? 'SCHEDULED' : 'REQUESTED',
          assigned_team: [], ops_note: null, created_at: 'now',
        });
      }
      return Promise.resolve(null);
    }),
    withTransaction: jest.fn(),
  } as unknown as DatabaseService;
  const push = {proMissionUpdate: jest.fn().mockResolvedValue(undefined)};
  const svc = new ProApplicationsService(
    db, {} as never, {} as never,
    {broadcast: jest.fn().mockResolvedValue(undefined)} as never,
    push as never,
  );
  return {svc, qCalls, qOneCalls, push};
}

describe('ProApplicationsService — requestMission dedicated-officer fast path', () => {
  it('auto-schedules when an ASSIGNED window for THIS plan covers every requested date', async () => {
    const {svc, qCalls, qOneCalls, push} = mkMission([{cpo_user_id: 'cpo-9', cpo_name: 'Vinod'}]);
    const out = await svc.requestMission('client-1', 'app-1', ['2030-01-12', '2030-01-10']);

    const lookup = qCalls.find(c => /FROM pro_cpo_assignments/.test(c.sql));
    expect(lookup).toBeDefined();
    expect(lookup!.sql).toMatch(/status = 'ASSIGNED'/);
    expect(lookup!.sql).toMatch(/daterange\(pca\.starts_on, pca\.ends_on, '\[\]'\) @> daterange/);
    expect(lookup!.params).toEqual(['app-1', '2030-01-10', '2030-01-12']);

    const ins = qOneCalls.find(c => /INSERT INTO pro_plan_missions/.test(c.sql));
    expect(ins).toBeDefined();
    expect(ins!.sql).toMatch(/'SCHEDULED'/);
    expect(ins!.sql).toMatch(/assigned_team/);
    expect(JSON.stringify(ins!.params)).toContain('Vinod');

    expect(qCalls.some(c => /'system','mission\.scheduled'/.test(c.sql))).toBe(true);
    expect(push.proMissionUpdate).toHaveBeenCalledWith('client-1', 'app-1', 'SCHEDULED');
    expect(out.mission.status).toBe('SCHEDULED');
  });

  it('stays REQUESTED (ops queue) when no covering dedicated window exists', async () => {
    const {svc, qCalls, qOneCalls, push} = mkMission([]);
    const out = await svc.requestMission('client-1', 'app-1', ['2030-01-10']);

    const ins = qOneCalls.find(c => /INSERT INTO pro_plan_missions/.test(c.sql));
    expect(ins).toBeDefined();
    expect(ins!.sql).not.toMatch(/'SCHEDULED'/);
    expect(qCalls.some(c => /'client','mission\.requested'/.test(c.sql))).toBe(true);
    expect(push.proMissionUpdate).not.toHaveBeenCalled();
    expect(out.mission.status).toBe('REQUESTED');
  });
});

describe('ProApplicationsService — listTeam (client projection of the dedicated team)', () => {
  it('is gated by plan access and never projects mission_code', async () => {
    const {svc, qCalls, qOneCalls} = mkMission([]);
    await svc.listTeam('client-1', 'app-1');

    // assertPlanAccess ran (owner lookup on the application row).
    expect(qOneCalls.some(c => /FROM pro_applications WHERE id/.test(c.sql))).toBe(true);

    const teamQ = qCalls.find(c => /FROM pro_cpo_assignments/.test(c.sql));
    expect(teamQ).toBeDefined();
    expect(teamQ!.sql).toMatch(/status = 'ASSIGNED'/);
    expect(teamQ!.sql).toMatch(/AS live_today/);
    expect(teamQ!.sql).not.toMatch(/mission_code/);
    expect(teamQ!.params).toEqual(['app-1']);
  });
});
