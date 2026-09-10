/**
 * RS-04 / RS-11 — terminating or rejecting an agent must drop the user back to
 * the plain 'individual' role (guarded so a still-active manager / agency owner
 * is not stripped), emit a queryable `user.role.change` audit row, and revoke
 * the user's live sessions so the stale-role JWT + mobile shell die.
 *
 * OpsService is constructed positionally (mirrors ops.service.sqli.spec.ts):
 * only the deps terminate/reject actually touch are real mocks; the rest are
 * inert stubs. `auth` is the last (@Optional) constructor arg.
 */
import {OpsService} from './ops.service';

const stub = () => ({}) as never;

type Over = {
  qOne?: jest.Mock;
  agents?: unknown;
  revokeAllUserSessions?: jest.Mock;
};

function makeSvc(over: Over = {}) {
  const qOne = over.qOne ?? jest.fn().mockResolvedValue(null);
  const q = jest.fn().mockResolvedValue([]);
  const db = {q, qOne} as never;
  const recordAdmin = jest.fn().mockResolvedValue(undefined);
  const audit = {recordAdmin, emit: jest.fn().mockResolvedValue(undefined)} as never;
  const agents =
    (over.agents as never) ??
    ({startReview: jest.fn().mockResolvedValue(undefined), decide: jest.fn().mockResolvedValue(undefined)} as never);
  const bookingPush = {agentDecided: jest.fn()} as never;
  const revokeAllUserSessions = over.revokeAllUserSessions ?? jest.fn().mockResolvedValue(1);
  const auth = {revokeAllUserSessions} as never;

  const svc = new OpsService(
    db,           // 0  db
    stub(),       // 1  bookings
    agents,       // 2  agents
    stub(),       // 3  bookingFsm
    stub(),       // 4  agentFsm
    audit,        // 5  audit
    stub(),       // 6  jobFeed
    stub(),       // 7  systemMsg
    stub(),       // 8  cpoAssign
    stub(),       // 9  vehicles
    stub(),       // 10 conversations
    stub(),       // 11 wallet
    stub(),       // 12 settlement
    stub(),       // 13 mapbox
    bookingPush,  // 14 bookingPush
    undefined,    // 15 redis   (@Optional)
    undefined,    // 16 sentry  (@Optional)
    auth,         // 17 auth    (@Optional)
  );
  return {svc, qOne, recordAdmin, revokeAllUserSessions, agents};
}

const admin = {user_id: 'admin-1', call_sign: 'OPS-1', role: 'ADMIN', region: 'AE'} as never;

describe('OpsService — role revert on agent exit (RS-04/RS-11)', () => {
  it('terminate reverts role→individual, audits user.role.change, and revokes sessions', async () => {
    const qOne = jest.fn().mockResolvedValueOnce({from_role: 'agent'}); // revert CTE matched
    const {svc, recordAdmin, revokeAllUserSessions} = makeSvc({qOne});

    await svc.terminateAgent('cpo-1', admin, 'gross misconduct');

    const revert = qOne.mock.calls.find(c => /SET role = 'individual'/.test(String(c[0])));
    expect(revert).toBeDefined();
    // guard clauses: no active agents row, no active manager membership, no active ownership
    expect(String(revert![0])).toMatch(/status IN \('APPROVED','ACTIVE'\)/);
    expect(String(revert![0])).toMatch(/member_role = 'manager'/);
    expect(String(revert![0])).toMatch(/owns\.org_user_id = \$1/);
    expect(recordAdmin).toHaveBeenCalledWith(
      admin, 'user.role.change', 'user', 'cpo-1',
      expect.objectContaining({from: 'agent', to: 'individual', reason: 'agent_terminated'}),
    );
    expect(revokeAllUserSessions).toHaveBeenCalledWith('cpo-1');
  });

  it('does NOT audit or revoke when the guard blocks the revert (active manager / owner)', async () => {
    const qOne = jest.fn().mockResolvedValue(null); // revert CTE matched no row
    const {svc, recordAdmin, revokeAllUserSessions} = makeSvc({qOne});

    await svc.terminateAgent('cpo-1', admin);

    expect(recordAdmin).not.toHaveBeenCalledWith(admin, 'user.role.change', 'user', 'cpo-1', expect.anything());
    expect(revokeAllUserSessions).not.toHaveBeenCalled();
  });

  it('reject (SUBMITTED) runs review→decide then reverts with reason agent_rejected', async () => {
    const agents = {
      startReview: jest.fn().mockResolvedValue(undefined),
      decide: jest.fn().mockResolvedValue(undefined),
    };
    const qOne = jest.fn()
      .mockResolvedValueOnce({status: 'SUBMITTED'}) // rejectAgent's status pre-read
      .mockResolvedValueOnce({from_role: 'agent'});  // the revert CTE
    const {svc, recordAdmin, revokeAllUserSessions} = makeSvc({qOne, agents});

    await svc.rejectAgent('cpo-2', admin, 'incomplete docs');

    expect(agents.startReview).toHaveBeenCalledWith('cpo-2', 'admin-1');
    expect(agents.decide).toHaveBeenCalledWith('cpo-2', 'admin-1', 'REJECTED', 'incomplete docs');
    expect(recordAdmin).toHaveBeenCalledWith(
      admin, 'user.role.change', 'user', 'cpo-2',
      expect.objectContaining({reason: 'agent_rejected'}),
    );
    expect(revokeAllUserSessions).toHaveBeenCalledWith('cpo-2');
  });

  it('tolerates a missing AuthService (undefined) without throwing', async () => {
    const qOne = jest.fn().mockResolvedValueOnce({from_role: 'service_provider'});
    const db = {q: jest.fn().mockResolvedValue([]), qOne} as never;
    const audit = {recordAdmin: jest.fn().mockResolvedValue(undefined), emit: jest.fn().mockResolvedValue(undefined)} as never;
    const svc = new OpsService(
      db, stub(), stub(), stub(), stub(), audit, stub(), stub(), stub(), stub(),
      stub(), stub(), stub(), stub(), {agentDecided: jest.fn()} as never,
      undefined, undefined, undefined, // redis, sentry, auth all absent
    );
    await expect(svc.terminateAgent('x', admin)).resolves.toEqual({ok: true});
  });
});
