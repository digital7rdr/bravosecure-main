/**
 * Mission-code authorization PERSISTENCE (founder 2026-08-11).
 *
 * The bug: the only thing that survived an app restart was the mission code
 * itself, cached in AsyncStorage on the device. Uninstall/reinstall or a new
 * phone wiped it, so an assigned CPO was wrongly asked for the code again even
 * though ops had a live approved assignment for them.
 *
 * The contract pinned here: the mission code is a ONE-TIME authorization that
 * stamps `authorized_at` on the assignment row, and the restore lookup
 * (`getActiveMission`) hands the mission back with NO code — but only while the
 * assignment is genuinely live. DatabaseService is mocked; the SQL text and
 * bind values are the pinned behavior.
 */
import {ProManagementService} from './pro-management.service';

const CODE = 'PMC-ABC234';

type Row = Record<string, unknown>;

function mk(opts: {codeRow?: Row | null; activeRow?: Row | null} = {}) {
  const qCalls: Array<{sql: string; params?: unknown[]}> = [];
  const qOneCalls: Array<{sql: string; params?: unknown[]}> = [];
  const db = {
    q: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
      qCalls.push({sql, params});
      return Promise.resolve([]);
    }),
    qOne: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
      qOneCalls.push({sql, params});
      if (/WHERE pca\.mission_code = \$1/.test(sql)) {
        return Promise.resolve(opts.codeRow ?? null);
      }
      // Dispatch on the restore query's ordering — deliberately NOT on any
      // clause a test asserts, so removing a guard fails the assertion rather
      // than silently missing this mock.
      if (/ORDER BY pca\.starts_on ASC/.test(sql)) {
        return Promise.resolve(opts.activeRow ?? null);
      }
      if (/UPDATE pro_cpo_assignments/.test(sql) && /SET authorized_at/.test(sql)) {
        return Promise.resolve({authorized_at: '2026-08-11T09:00:00.000Z'});
      }
      if (/SET status = 'CANCELLED'/.test(sql)) {
        return Promise.resolve({id: 'a-1', status: 'CANCELLED'});
      }
      return Promise.resolve(null);
    }),
  };
  const svc = new ProManagementService(
    db as never, {} as never, {} as never,
    {broadcast: jest.fn().mockResolvedValue(undefined)} as never,
    {proMissionUpdate: jest.fn().mockResolvedValue(undefined)} as never,
  );
  return {svc, db, qCalls, qOneCalls};
}

const liveRow = (over: Row = {}): Row => ({
  id: 'a-1', application_id: 'app-1', cpo_user_id: 'cpo-1', mission_id: null,
  org_user_id: null, starts_on: '2026-08-01', ends_on: '2999-12-31',
  status: 'ASSIGNED', mission_code: CODE, note: null,
  created_at: '2026-08-01T00:00:00Z', authorized_at: null, revoked_at: null,
  member_name: 'Sirajul', member_avatar: null, coverage_area: null, ...over,
});

describe('mission code → persistent server-side authorization', () => {
  it('stamps authorized_at on the FIRST successful code entry', async () => {
    const {svc, qOneCalls} = mk({codeRow: liveRow()});
    await svc.resolveMissionCode('cpo-1', CODE);

    const stamp = qOneCalls.find(c => /UPDATE pro_cpo_assignments/.test(c.sql) && /SET authorized_at/.test(c.sql));
    expect(stamp).toBeDefined();
    // Scoped to the row AND the caller, and only while still live.
    expect(stamp!.sql).toMatch(/WHERE id = \$1 AND cpo_user_id = \$2 AND status = 'ASSIGNED'/);
    expect(stamp!.params).toEqual(['a-1', 'cpo-1']);
  });

  it('is idempotent — re-submitting the code never re-authorizes (edge case 8)', async () => {
    // Already authorized yesterday.
    const {svc, qOneCalls} = mk({codeRow: liveRow({authorized_at: '2026-08-10T10:00:00Z'})});
    await svc.resolveMissionCode('cpo-1', CODE);

    const stamps = qOneCalls.filter(c => /SET authorized_at/.test(c.sql));
    expect(stamps).toHaveLength(0);
  });

  it('COALESCEs the stamp so a race keeps the FIRST authorization time', async () => {
    const {svc, qOneCalls} = mk({codeRow: liveRow()});
    await svc.resolveMissionCode('cpo-1', CODE);
    const stamp = qOneCalls.find(c => /SET authorized_at/.test(c.sql));
    expect(stamp!.sql).toMatch(/authorized_at = COALESCE\(authorized_at, now\(\)\)/);
  });

  it('never stamps for a code that belongs to a DIFFERENT officer', async () => {
    const {svc, qOneCalls} = mk({codeRow: liveRow({cpo_user_id: 'someone-else'})});
    await expect(svc.resolveMissionCode('cpo-1', CODE)).rejects.toThrow('invalid_mission_code');
    expect(qOneCalls.filter(c => /SET authorized_at/.test(c.sql))).toHaveLength(0);
  });

  it.each([
    ['CANCELLED', 'mission_cancelled'],
    ['COMPLETED', 'mission_already_completed'],
  ])('never stamps a %s assignment', async (status, message) => {
    const {svc, qOneCalls} = mk({codeRow: liveRow({status})});
    await expect(svc.resolveMissionCode('cpo-1', CODE)).rejects.toThrow(message);
    expect(qOneCalls.filter(c => /SET authorized_at/.test(c.sql))).toHaveLength(0);
  });
});

describe('getActiveMission — restore after reinstall / new device / re-login', () => {
  it('returns the mission with NO code when a live authorization exists', async () => {
    const {svc} = mk({activeRow: liveRow({authorized_at: '2026-08-10T10:00:00Z'})});
    const out = await svc.getActiveMission('cpo-1') as {assignment: Row};
    expect((out.assignment as Row).id).toBe('a-1');
  });

  it('is scoped to the caller and demands a LIVE, already-authorized row', async () => {
    const {svc, qOneCalls} = mk({activeRow: liveRow({authorized_at: '2026-08-10T10:00:00Z'})});
    await svc.getActiveMission('cpo-1');

    const lookup = qOneCalls.find(c => /ORDER BY pca\.starts_on ASC/.test(c.sql))!;
    expect(lookup.params).toEqual(['cpo-1']);
    expect(lookup.sql).toMatch(/pca\.cpo_user_id = \$1/);
    expect(lookup.sql).toMatch(/pca\.status = 'ASSIGNED'/);      // ops revoked → CANCELLED → excluded
    expect(lookup.sql).toMatch(/pca\.authorized_at IS NOT NULL/); // code never entered → still gated
    expect(lookup.sql).toMatch(/pca\.ends_on >= CURRENT_DATE/);   // schedule finished → excluded
  });

  it('sweeps finished schedules BEFORE deciding (edge case 4)', async () => {
    const {svc, qCalls} = mk({activeRow: null});
    await expect(svc.getActiveMission('cpo-1')).rejects.toThrow('no_active_assignment');
    const swept = qCalls.find(c => /SET status = 'COMPLETED'/.test(c.sql) && /ends_on < CURRENT_DATE/.test(c.sql));
    expect(swept).toBeDefined();
  });

  it('404s when there is no live authorization — the app then shows the code gate', async () => {
    const {svc} = mk({activeRow: null});
    await expect(svc.getActiveMission('cpo-1')).rejects.toThrow('no_active_assignment');
  });
});

describe('revocation stamps revoked_at', () => {
  it('cancelAssignment records WHEN access was withdrawn (edge cases 3, 5, 9)', async () => {
    const {svc, qOneCalls} = mk();
    await svc.cancelAssignment({user_id: 'admin-1'} as never, 'a-1');
    const cancel = qOneCalls.find(c => /SET status = 'CANCELLED'/.test(c.sql))!;
    expect(cancel.sql).toMatch(/revoked_at = now\(\)/);
  });
});
