/**
 * IS-02 (audit 2026-08-07) — the Pro-management mutations (org/CPO
 * provisioning, suspensions, assignments) must each leave an ops_audit row
 * naming the acting admin.
 */
import {ProManagementOpsController} from './pro-management-ops.controller';
import type {AdminContext} from '../ops/admin.guard';

const ADMIN: AdminContext = {user_id: 'adm-1', role: 'SUPERVISOR', call_sign: 'OPS-2', region: 'AE'};
const req = {admin: ADMIN} as never;

function mk() {
  const mgmt = {
    createOrg: jest.fn().mockResolvedValue({org: {id: 'org-1'}}),
    createCpo: jest.fn().mockResolvedValue({member: {member_user_id: 'cpo-1'}}),
    setCpoSuspension: jest.fn().mockResolvedValue({ok: true}),
    createAssignment: jest.fn().mockResolvedValue({assignment: {id: 'asg-1', application_id: 'app-1', cpo_user_id: 'cpo-1'}}),
    cancelAssignment: jest.fn().mockResolvedValue({assignment: {id: 'asg-1', application_id: 'app-1', cpo_user_id: 'cpo-1'}}),
    completeAssignment: jest.fn().mockResolvedValue({assignment: {id: 'asg-1', application_id: 'app-1', cpo_user_id: 'cpo-1'}}),
    scheduleRequestWithCpos: jest.fn().mockResolvedValue({mission: {}, assignments: []}),
  };
  const audit = {recordAdmin: jest.fn().mockResolvedValue(undefined)};
  const ctrl = new ProManagementOpsController(mgmt as never, audit as never);
  return {ctrl, mgmt, audit};
}

describe('ProManagementOpsController — admin attribution', () => {
  it('org create records pro_org.create against the new org user', async () => {
    const {ctrl, audit} = mk();
    await ctrl.createOrg({display_name: 'Internal Org'} as never, req);
    expect(audit.recordAdmin).toHaveBeenCalledWith(
      ADMIN, 'pro_org.create', 'user', 'org-1', {display_name: 'Internal Org'});
  });

  it('CPO create records pro_cpo.create against the new officer', async () => {
    const {ctrl, audit} = mk();
    await ctrl.createCpo({org_user_id: 'org-1'} as never, req);
    expect(audit.recordAdmin).toHaveBeenCalledWith(
      ADMIN, 'pro_cpo.create', 'agent', 'cpo-1', {org_user_id: 'org-1'});
  });

  it('suspend vs reinstate record distinct actions', async () => {
    const {ctrl, audit} = mk();
    await ctrl.suspend('cpo-1', {suspend: true, days: 14} as never, req);
    await ctrl.suspend('cpo-1', {suspend: false} as never, req);
    expect(audit.recordAdmin).toHaveBeenCalledWith(
      ADMIN, 'pro_cpo.suspend', 'agent', 'cpo-1', expect.objectContaining({days: 14}));
    expect(audit.recordAdmin).toHaveBeenCalledWith(
      ADMIN, 'pro_cpo.reinstate', 'agent', 'cpo-1', expect.anything());
  });

  it('assignment create/finish/cancel all record against the application', async () => {
    const {ctrl, audit} = mk();
    await ctrl.createAssignment({application_id: 'app-1', cpo_user_id: 'cpo-1', starts_on: '2026-09-01', ends_on: '2026-09-03'} as never, req);
    await ctrl.complete('asg-1', req);
    await ctrl.cancel('asg-1', req);
    expect(audit.recordAdmin).toHaveBeenCalledWith(
      ADMIN, 'pro_assignment.create', 'application', 'app-1', expect.objectContaining({cpo_user_id: 'cpo-1'}));
    expect(audit.recordAdmin).toHaveBeenCalledWith(
      ADMIN, 'pro_assignment.complete', 'application', 'app-1', expect.objectContaining({assignment_id: 'asg-1'}));
    expect(audit.recordAdmin).toHaveBeenCalledWith(
      ADMIN, 'pro_assignment.cancel', 'application', 'app-1', expect.objectContaining({assignment_id: 'asg-1'}));
  });

  it('schedule-with-CPOs records pro_mission.schedule with the picked officers', async () => {
    const {ctrl, audit} = mk();
    await ctrl.scheduleWithCpos('app-1', 'msn-1', {cpo_user_ids: ['cpo-1', 'cpo-2']} as never, req);
    expect(audit.recordAdmin).toHaveBeenCalledWith(
      ADMIN, 'pro_mission.schedule', 'application', 'app-1',
      {mission_id: 'msn-1', cpo_user_ids: ['cpo-1', 'cpo-2']});
  });
});
