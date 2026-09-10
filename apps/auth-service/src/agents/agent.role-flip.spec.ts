/**
 * RS-05 / RS-11 — a self-service company-agent create flips users.role to
 * 'service_provider'. It must then (a) revoke the caller's live access JTIs so
 * the next call refreshes into a token carrying the new role (refresh tokens
 * left intact — an upgrade must not log the user out), and (b) write a queryable
 * `user.role.change` ops_audit row. Both are best-effort: neither may fail the
 * create. A non-company (cpo) self-registration is rejected BEFORE any flip.
 */
import {BadRequestException} from '@nestjs/common';
import {AgentService} from './agent.service';
import {AgentStateMachine} from './state-machine.service';
import type {DatabaseService} from '../database/database.service';
import type {RedisService} from '../redis/redis.service';
import type {CpoAssignmentService} from '../booking/assignment/cpo-assignment.service';
import type {WalletService} from '../wallet/wallet.service';
import type {DepartmentService} from '../department/department.service';
import type {ProofOfCompletionService} from './proof-of-completion.service';
import type {ConfigService} from '@nestjs/config';

function mk(opts: {revokeJtis?: jest.Mock} = {}) {
  const qCalls: Array<{sql: string; params: unknown[]}> = [];
  const db = {
    q: jest.fn().mockImplementation((sql: string, params: unknown[]) => {
      qCalls.push({sql, params});
      if (/FROM auth_devices/.test(sql)) {
        // one live jti + one null (device that never got an access token)
        return Promise.resolve([{current_jti: 'j1'}, {current_jti: null}]);
      }
      return Promise.resolve([]);
    }),
    qOne: jest.fn().mockImplementation((sql: string) => {
      if (/SELECT \* FROM agents WHERE user_id/.test(sql)) return Promise.resolve(null); // no existing agent
      if (/INSERT INTO agents/.test(sql)) return Promise.resolve({user_id: 'u1', type: 'company', status: 'DRAFT'});
      return Promise.resolve(null);
    }),
  } as unknown as DatabaseService;
  const revokeJtis = opts.revokeJtis ?? jest.fn().mockResolvedValue(undefined);
  const redis = {revokeJtis} as unknown as RedisService;
  const svc = new AgentService(
    db, new AgentStateMachine(), redis,
    {} as unknown as CpoAssignmentService, {} as unknown as WalletService,
    {} as unknown as DepartmentService, {} as unknown as ProofOfCompletionService,
    {get: () => 0} as unknown as ConfigService,
  );
  return {svc, qCalls, revokeJtis};
}

describe('AgentService.create — role-flip session revoke + audit (RS-05/RS-11)', () => {
  it('flips role, revokes only non-null access JTIs, and writes a user.role.change audit row', async () => {
    const {svc, qCalls, revokeJtis} = mk();
    const out = await svc.create('u1', {type: 'company'});
    expect(out).toMatchObject({user_id: 'u1'});

    expect(qCalls.some(c => /UPDATE public\.users SET role = 'service_provider'/.test(c.sql))).toBe(true);
    expect(revokeJtis).toHaveBeenCalledWith(['j1']); // null current_jti filtered out

    const audit = qCalls.find(c => /INSERT INTO ops_audit/.test(c.sql) && /user\.role\.change/.test(c.sql));
    expect(audit).toBeDefined();
    expect(audit!.sql).toMatch(/'AGENT'/);
    expect(String(audit!.params[1])).toContain('service_provider'); // metadata JSON from→to
  });

  it('rejects a non-company (cpo) self-registration BEFORE any role flip', async () => {
    const {svc, qCalls, revokeJtis} = mk();
    await expect(svc.create('u1', {type: 'cpo'})).rejects.toBeInstanceOf(BadRequestException);
    expect(qCalls.some(c => /UPDATE public\.users SET role/.test(c.sql))).toBe(false);
    expect(revokeJtis).not.toHaveBeenCalled();
  });

  it('a failing JTI revoke does NOT fail agent creation (best-effort)', async () => {
    const revokeJtis = jest.fn().mockRejectedValue(new Error('redis down'));
    const {svc} = mk({revokeJtis});
    await expect(svc.create('u1', {type: 'company'})).resolves.toMatchObject({user_id: 'u1'});
  });
});
