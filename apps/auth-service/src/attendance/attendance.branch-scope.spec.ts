/**
 * AUTHZ-3 — a department-scoped (branch) manager may only edit/review attendance
 * sessions in their own branch. Before this, editShift/reviewSession bound only
 * `org_user_id`, letting a branch manager alter/approve ANY department's sessions.
 * The gate is the department predicate on the locked SELECT (the same
 * COALESCE(shift, member) rule the scoped list/queue reads use), with the
 * manager's department threaded from the controller. Reverting the fix (dropping
 * the predicate or the param) turns these red.
 */
import {NotFoundException} from '@nestjs/common';
import {AttendanceService} from './attendance.service';
import type {DatabaseService} from '../database/database.service';
import type {ConfigService} from '@nestjs/config';
import type {OrgAuditService} from '../org/org-audit.service';
import type {NotificationsService} from '../notifications/notifications.service';

function mk() {
  const tx = {q: jest.fn().mockResolvedValue([]), qOne: jest.fn().mockResolvedValue(null)};
  const db = {
    q: jest.fn().mockResolvedValue([]),
    qOne: jest.fn().mockResolvedValue(null),
    withTransaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
  };
  const svc = new AttendanceService(
    db as unknown as DatabaseService,
    {get: jest.fn(() => undefined)} as unknown as ConfigService,
    {log: jest.fn()} as unknown as OrgAuditService,
    {record: jest.fn()} as unknown as NotificationsService,
  );
  return {svc, tx};
}

const selectOf = (tx: {qOne: jest.Mock}) =>
  tx.qOne.mock.calls.find(c => /FROM cpo_shift_sessions ses/.test(String(c[0])));

describe('AttendanceService — AUTHZ-3 branch scope on edit/review', () => {
  it('editShift gates the locked SELECT on the manager department (COALESCE predicate + $3 param)', async () => {
    const {svc, tx} = mk();
    await expect(svc.editShift('org-9', 'mgr-1', 'sh-x', {edit_reason: 'fix'}, 'Alpha'))
      .rejects.toBeInstanceOf(NotFoundException); // foreign branch → no row
    const sel = selectOf(tx);
    expect(sel).toBeDefined();
    expect(String(sel![0])).toMatch(/COALESCE\(sh\.department, om\.department\) = \$3/);
    expect(sel![1]).toEqual(['sh-x', 'org-9', 'Alpha']);
  });

  it('reviewSession gates the locked SELECT on the manager department', async () => {
    const {svc, tx} = mk();
    await expect(svc.reviewSession('org-9', 'mgr-1', 'ses-x', 'approve', undefined, 'Bravo'))
      .rejects.toBeInstanceOf(NotFoundException);
    const sel = selectOf(tx);
    expect(sel).toBeDefined();
    expect(String(sel![0])).toMatch(/COALESCE\(sh\.department, om\.department\) = \$3/);
    expect(sel![1]).toEqual(['ses-x', 'org-9', 'Bravo']);
  });

  it('a full org manager (null department) passes null → matches all branches', async () => {
    const {svc, tx} = mk();
    await expect(svc.editShift('org-9', 'mgr-1', 'sh-x', {edit_reason: 'fix'}, null))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(selectOf(tx)![1]).toEqual(['sh-x', 'org-9', null]);
  });
});
