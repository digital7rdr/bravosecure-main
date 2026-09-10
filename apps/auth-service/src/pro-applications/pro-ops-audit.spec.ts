/**
 * IS-02 (audit 2026-08-07) — every mutating ops Pro-application endpoint must
 * leave an ops_audit row naming the acting admin. The console's decision
 * timeline and the global audit browser both depend on these rows existing.
 */
import {ProApplicationsOpsController} from './pro-applications-ops.controller';
import type {AdminContext} from '../ops/admin.guard';

const ADMIN: AdminContext = {user_id: 'adm-1', role: 'ADMIN', call_sign: 'OPS-1', region: 'AE'};
const req = {admin: ADMIN} as never;

function mk() {
  const proApps = {
    createProposal: jest.fn().mockResolvedValue({application: {}, proposal: {}}),
    reject: jest.fn().mockResolvedValue({application: {}}),
    opsCancel: jest.fn().mockResolvedValue({application: {}}),
    scheduleMission: jest.fn().mockResolvedValue({mission: {}}),
    declineMission: jest.fn().mockResolvedValue({mission: {}}),
  };
  const audit = {recordAdmin: jest.fn().mockResolvedValue(undefined)};
  const ctrl = new ProApplicationsOpsController(proApps as never, audit as never);
  return {ctrl, proApps, audit};
}

describe('ProApplicationsOpsController — admin attribution', () => {
  it('proposal create records pro_application.proposal_create', async () => {
    const {ctrl, audit} = mk();
    await ctrl.createProposal('app-1', {
      total_credits: 1000, valid_until: '2027-01-01T00:00:00Z',
      coverage_start: '2026-09-01', coverage_end: '2026-12-01',
      included_services: [], assigned_team: [],
    } as never, req);
    expect(audit.recordAdmin).toHaveBeenCalledWith(
      ADMIN, 'pro_application.proposal_create', 'application', 'app-1',
      expect.objectContaining({total_credits: 1000}),
    );
  });

  it('reject records pro_application.reject with the reason', async () => {
    const {ctrl, audit} = mk();
    await ctrl.reject('app-1', {reason: 'out of coverage'} as never, req);
    expect(audit.recordAdmin).toHaveBeenCalledWith(
      ADMIN, 'pro_application.reject', 'application', 'app-1', {reason: 'out of coverage'});
  });

  it('cancel-on-behalf records pro_application.cancel', async () => {
    const {ctrl, audit} = mk();
    await ctrl.cancel('app-1', {note: 'client called'} as never, req);
    expect(audit.recordAdmin).toHaveBeenCalledWith(
      ADMIN, 'pro_application.cancel', 'application', 'app-1', {note: 'client called'});
  });

  it('mission schedule/decline both record against the application', async () => {
    const {ctrl, audit} = mk();
    await ctrl.scheduleMission('app-1', 'msn-1', {} as never, req);
    await ctrl.declineMission('app-1', 'msn-1', {} as never, req);
    expect(audit.recordAdmin).toHaveBeenCalledWith(
      ADMIN, 'pro_mission.schedule', 'application', 'app-1', {mission_id: 'msn-1'});
    expect(audit.recordAdmin).toHaveBeenCalledWith(
      ADMIN, 'pro_mission.decline', 'application', 'app-1',
      expect.objectContaining({mission_id: 'msn-1'}));
  });

  it('a failed mutation records NO audit row (audit follows the state change)', async () => {
    const {ctrl, proApps, audit} = mk();
    proApps.reject.mockRejectedValueOnce(new Error('pro_application_state_changed_concurrently'));
    await expect(ctrl.reject('app-1', {reason: 'x'} as never, req)).rejects.toThrow();
    expect(audit.recordAdmin).not.toHaveBeenCalled();
  });
});
