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

/**
 * Bug 3 — setAgencyProfile stamps the agency's dispatch region_code + dpa_accepted_at
 * (the two is_eligible_for_dispatch / ranker inputs with no other UI). Company-only,
 * region allow-listed, DPA fail-closed, COALESCE preserves the first-accept time.
 */
function mk(agent: {type?: string} | null, managesOrg?: string | null) {
  const calls: Array<{sql: string; params: unknown[]}> = [];
  const db = {
    q: jest.fn().mockResolvedValue([]),
    qOne: jest.fn().mockImplementation((sql: string, params: unknown[]) => {
      calls.push({sql, params});
      if (/UPDATE public\.agents/.test(sql)) {
        // RETURNING region_code, dpa_accepted_at — derive from the params the method passed.
        return Promise.resolve({
          region_code: params[1] as string,
          dpa_accepted_at: params[2] ? new Date('2026-01-01T00:00:00.000Z') : null,
        });
      }
      if (/FROM agents WHERE user_id/.test(sql)) {
        return Promise.resolve(agent ? {user_id: 'a1', status: 'ACTIVE', ...agent} : null);
      }
      // B-194 — the org-resolution lookup: which company does this caller
      // actually administer as an ACTIVE manager?
      if (/FROM org_members om/.test(sql)) {
        return Promise.resolve(managesOrg ? {org_user_id: managesOrg} : null);
      }
      return Promise.resolve(null);
    }),
  } as unknown as DatabaseService;
  const svc = new AgentService(
    db, new AgentStateMachine(),
    {} as unknown as RedisService, {} as unknown as CpoAssignmentService,
    {} as unknown as WalletService, {} as unknown as DepartmentService,
    {} as unknown as ProofOfCompletionService, {get: () => 0} as unknown as ConfigService,
  );
  return {svc, calls};
}
const updCall = (calls: Array<{sql: string; params: unknown[]}>) =>
  calls.find(c => /UPDATE public\.agents/.test(c.sql))!;

describe('AgentService.setAgencyProfile (Bug 3 — region + DPA)', () => {
  it('stamps region_code (upper-cased) + dpa_accepted_at when dpa_accepted=true', async () => {
    const {svc, calls} = mk({type: 'company'});
    const r = await svc.setAgencyProfile('a1', {region_code: 'bd', dpa_accepted: true});
    expect(r.region_code).toBe('BD');
    expect(r.dpa_accepted_at).not.toBeNull();
    const upd = updCall(calls);
    expect(upd.params[1]).toBe('BD');   // upper-cased region
    expect(upd.params[2]).toBe(true);   // dpa boolean (fail-closed: only literal true)
    expect(upd.sql).toMatch(/COALESCE\(dpa_accepted_at, NOW\(\)\)/); // first-accept time preserved
  });

  it('does NOT stamp dpa when dpa_accepted=false (fail-closed)', async () => {
    const {svc, calls} = mk({type: 'company'});
    const r = await svc.setAgencyProfile('a1', {region_code: 'AE', dpa_accepted: false});
    expect(r.dpa_accepted_at).toBeNull();
    expect(updCall(calls).params[2]).toBe(false);
  });

  it('rejects a non-company agent who administers no org', async () => {
    const {svc} = mk({type: 'cpo'}, null);
    await expect(svc.setAgencyProfile('a1', {region_code: 'BD', dpa_accepted: true}))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an unsupported region', async () => {
    const {svc} = mk({type: 'company'});
    await expect(svc.setAgencyProfile('a1', {region_code: 'XX', dpa_accepted: true}))
      .rejects.toThrow('unsupported_region');
  });
});

/**
 * B-194 — saving a Region returned HTTP 400 for every promoted manager.
 *
 * `setAgencyProfile` writes the CALLER's own `agents` row and rejected
 * `type !== 'company'`. But a promoted manager is minted as a MANAGED CPO
 * (`agents.type = 'cpo'`) — promotion only flips `org_members.member_role` — while
 * `resolveAuthedRoute` still sends them into the OWNER's shell, where `region` sits
 * in `ALWAYS_VISIBLE_KEYS`. So the Region tile was visible to a manager and every
 * Save threw `agency_profile_is_company_only`, with no path to success.
 *
 * The fix resolves the org the caller actually administers and writes THAT row.
 * The pre-fix spec above could not see the bug because its `qOne` fake returned
 * null for every unmatched query, so the org lookup always missed and the
 * company-only branch was the only reachable one — the manager lane was never
 * exercised. `managesOrg` in `mk()` is what makes it reachable.
 */
describe('B-194 — a promoted manager can save the org Region', () => {
  it('writes the ORG row, not the manager’s own agents row', async () => {
    const {svc, calls} = mk({type: 'cpo'}, 'org-owner-1');
    const r = await svc.setAgencyProfile('mgr-1', {region_code: 'ae', dpa_accepted: true});

    expect(r.region_code).toBe('AE');
    // The UPDATE must target the company account, NOT the caller.
    expect(updCall(calls).params[0]).toBe('org-owner-1');
  });

  it('the org lookup requires an ACTIVE manager of a company org', async () => {
    const {svc, calls} = mk({type: 'cpo'}, 'org-owner-1');
    await svc.setAgencyProfile('mgr-1', {region_code: 'AE', dpa_accepted: true});

    const lookup = calls.find(c => /FROM org_members om/.test(c.sql));
    expect(lookup).toBeDefined();
    // A suspended member, a plain CPO, or a manager of a non-company row must
    // not be able to rewrite an agency's dispatch region.
    expect(lookup!.sql).toMatch(/om\.status = 'active'/);
    expect(lookup!.sql).toMatch(/om\.member_role = 'manager'/);
    expect(lookup!.sql).toMatch(/a\.type = 'company'/);
    expect(lookup!.params[0]).toBe('mgr-1');
  });

  it('a company account still writes its own row (no regression)', async () => {
    const {svc, calls} = mk({type: 'company'});
    await svc.setAgencyProfile('a1', {region_code: 'BD', dpa_accepted: true});

    expect(updCall(calls).params[0]).toBe('a1');
    // The company path must not pay for the manager lookup at all.
    expect(calls.find(c => /FROM org_members om/.test(c.sql))).toBeUndefined();
  });

  it('the region allow-list still applies on the manager lane', async () => {
    const {svc} = mk({type: 'cpo'}, 'org-owner-1');
    await expect(svc.setAgencyProfile('mgr-1', {region_code: 'XX', dpa_accepted: true}))
      .rejects.toThrow('unsupported_region');
  });
});
