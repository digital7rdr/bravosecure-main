import {BadRequestException} from '@nestjs/common';
import {AgentService} from './agent.service';
import {AgentStateMachine} from './state-machine.service';
import type {AgentStatus} from './state-machine.service';
import type {DatabaseService} from '../database/database.service';
import type {RedisService} from '../redis/redis.service';
import type {CpoAssignmentService} from '../booking/assignment/cpo-assignment.service';
import type {WalletService} from '../wallet/wallet.service';
import type {DepartmentService} from '../department/department.service';
import type {ProofOfCompletionService} from './proof-of-completion.service';
import type {ConfigService} from '@nestjs/config';

/**
 * B-96 — submit dead-end. The PROFILE_COMPLETE → DOCS_PENDING hop is driven by a
 * fire-and-forget skipKyc() call in the registration wizard. When that call never
 * landed, the agent still uploaded a full compliance pack (uploadDocument has no
 * status gate) and then hit `Cannot submit from status PROFILE_COMPLETE` forever —
 * no in-app recovery. submitForReview now re-runs the idempotent fast-forward.
 *
 * The gates must survive the self-heal: required docs are still mandatory, and a
 * status with no legitimate path to DOCS_PENDING is still rejected.
 */
function mk(status: AgentStatus, missingRequiredDocs = 0) {
  const state = {status, audits: [] as string[]};

  const q = jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
    const set = /UPDATE agents SET status = '(\w+)'/.exec(sql);
    if (set) {
      state.status = set[1] as AgentStatus;
      return Promise.resolve([]);
    }
    if (/INSERT INTO agent_audit/.test(sql)) {
      state.audits.push(`${params?.[1] ?? 'null'}->${params?.[2]}`);
      return Promise.resolve([]);
    }
    return Promise.resolve([]); // kyc settle, kyc select (no rows to mirror), pipeline
  });

  const qOne = jest.fn().mockImplementation((sql: string) => {
    if (/SELECT \* FROM agents/.test(sql)) {
      return Promise.resolve({user_id: 'u1', status: state.status});
    }
    if (/FROM agent_documents/.test(sql)) {
      return Promise.resolve({n: String(missingRequiredDocs)});
    }
    if (/FROM agent_kyc_checks/.test(sql)) {
      return Promise.resolve({n: '0'});
    }
    return Promise.resolve(null);
  });

  const svc = new AgentService(
    {q, qOne} as unknown as DatabaseService, new AgentStateMachine(),
    {} as unknown as RedisService, {} as unknown as CpoAssignmentService,
    {} as unknown as WalletService, {} as unknown as DepartmentService,
    {} as unknown as ProofOfCompletionService, {get: () => 0} as unknown as ConfigService,
  );
  return {svc, state};
}

describe('AgentService.submitForReview — B-96 stale-status self-heal', () => {
  it('submits from PROFILE_COMPLETE with a complete doc pack (the B-96 repro)', async () => {
    const {svc, state} = mk('PROFILE_COMPLETE');
    await expect(svc.submitForReview('u1')).resolves.toBeUndefined();
    expect(state.status).toBe('SUBMITTED');
  });

  it('walks the real FSM hops rather than jumping straight to SUBMITTED', async () => {
    const {svc, state} = mk('PROFILE_COMPLETE');
    await svc.submitForReview('u1');
    expect(state.audits).toEqual([
      'PROFILE_COMPLETE->KYC_PENDING',
      'KYC_PENDING->DOCS_PENDING',
      'DOCS_PENDING->SUBMITTED',
    ]);
  });

  it('submits from KYC_PENDING (skipKyc landed the first hop only)', async () => {
    const {svc, state} = mk('KYC_PENDING');
    await svc.submitForReview('u1');
    expect(state.status).toBe('SUBMITTED');
  });

  it('still submits from DOCS_PENDING without a self-heal (regression)', async () => {
    const {svc, state} = mk('DOCS_PENDING');
    await svc.submitForReview('u1');
    expect(state.status).toBe('SUBMITTED');
    expect(state.audits).toEqual(['DOCS_PENDING->SUBMITTED']);
  });

  it('does NOT let the self-heal bypass the required-document gate', async () => {
    const {svc, state} = mk('PROFILE_COMPLETE', 2);
    await expect(svc.submitForReview('u1')).rejects.toThrow(/2 required document\(s\) still missing/);
    expect(state.status).not.toBe('SUBMITTED');
  });

  it('still rejects a status with no legitimate path to DOCS_PENDING', async () => {
    for (const status of ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED'] as AgentStatus[]) {
      const {svc} = mk(status);
      await expect(svc.submitForReview('u1')).rejects.toBeInstanceOf(BadRequestException);
    }
  });
});
