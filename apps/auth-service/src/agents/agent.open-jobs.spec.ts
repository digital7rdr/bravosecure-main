import {BadRequestException, ForbiddenException} from '@nestjs/common';
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
 * browseOpenJobs — the testing-affordance provider region browse.
 * Contract under test:
 *  - company-only (provider/agency) gate;
 *  - region validated against the canonical list (BadRequest otherwise);
 *  - COARSE fields only (LB1) — never pickup/dropoff coords, full addresses,
 *    or client identity, in the SQL or in the mapped response;
 *  - open pipeline statuses only (PENDING_OPS/OPS_APPROVED/DISPATCHING);
 *  - FIFO by created_at ASC, LIMIT 50.
 */
function mk(agent: {type?: string} | null, rows: Array<Record<string, unknown>> = []) {
  const calls: Array<{sql: string; params: unknown[]}> = [];
  const db = {
    q: jest.fn().mockImplementation((sql: string, params: unknown[]) => {
      calls.push({sql, params});
      return Promise.resolve(rows);
    }),
    qOne: jest.fn().mockImplementation((sql: string) => {
      if (/FROM agents WHERE user_id/.test(sql)) {
        return Promise.resolve(agent ? {user_id: 'a1', status: 'ACTIVE', ...agent} : null);
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

const COARSE_ROW = {
  booking_id: 'b-1', status: 'PENDING_OPS', region_code: 'AE', region_label: 'Dubai',
  service: 'close_protection', pickup_area: 'Dubai Marina',
  pickup_time: new Date('2026-07-06T10:00:00Z'), duration_hours: 4, cpo_count: 2,
  armed_required: false, total_eur: '344.00', total_aed: '1376.00',
  created_at: new Date('2026-07-05T10:00:00Z'),
};

describe('AgentService.browseOpenJobs (provider region browse — LB1 coarse)', () => {
  it('rejects a non-company agent (provider/agency only)', async () => {
    const {svc} = mk({type: 'cpo'});
    await expect(svc.browseOpenJobs('a1', 'AE')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects an unsupported region', async () => {
    const {svc} = mk({type: 'company'});
    await expect(svc.browseOpenJobs('a1', 'XX')).rejects.toThrow('unsupported_region');
    await expect(svc.browseOpenJobs('a1', 'US')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('normalises the region param (lower-case in → upper-cased filter)', async () => {
    const {svc, calls} = mk({type: 'company'});
    await svc.browseOpenJobs('a1', 'bd');
    expect(calls[0].params).toEqual(['BD']);
  });

  it('omitted region / ALL → no region filter (null param)', async () => {
    const {svc, calls} = mk({type: 'company'});
    await svc.browseOpenJobs('a1');
    await svc.browseOpenJobs('a1', 'ALL');
    expect(calls[0].params).toEqual([null]);
    expect(calls[1].params).toEqual([null]);
  });

  it('selects only open pipeline statuses (no CONFIRMED, no terminals)', async () => {
    const {svc, calls} = mk({type: 'company'});
    await svc.browseOpenJobs('a1', 'AE');
    const sql = calls[0].sql;
    expect(sql).toMatch(/IN \('PENDING_OPS','OPS_APPROVED','DISPATCHING'\)/);
    for (const status of ['CONFIRMED', 'LIVE', 'COMPLETED', 'CANCELLED', 'NO_PROVIDER', 'AGENCY_NO_SHOW']) {
      expect(sql).not.toContain(status);
    }
  });

  it('is FIFO by created_at ASC with LIMIT 50', async () => {
    const {svc, calls} = mk({type: 'company'});
    await svc.browseOpenJobs('a1', 'AE');
    expect(calls[0].sql).toMatch(/ORDER BY b\.created_at ASC/);
    expect(calls[0].sql).toMatch(/LIMIT 50/);
  });

  it('LB1: the SQL never selects coords, full addresses, or client identity', async () => {
    const {svc, calls} = mk({type: 'company'});
    await svc.browseOpenJobs('a1', 'AE');
    const sql = calls[0].sql;
    expect(sql).not.toMatch(/pickup_lat|pickup_lng|dropoff_lat|dropoff_lng|dropoff_address|client_id/);
    // pickup_address may appear ONLY inside the zone-truncating split_part().
    expect(sql.match(/pickup_address/g)).toHaveLength(1);
    expect(sql).toMatch(/split_part\(b\.pickup_address, ',', 1\) AS pickup_area/);
  });

  it('LB1: the response drops any precise field a row might carry (allow-list map)', async () => {
    // Simulate a drifted SELECT that leaks precise columns — the map must strip them.
    const leakyRow = {
      ...COARSE_ROW,
      pickup_lat: '25.20', pickup_lng: '55.27',
      pickup_address: '1 Marina Walk, Dubai Marina, Dubai', dropoff_address: 'Burj Khalifa',
      client_id: 'u-client',
    };
    const {svc} = mk({type: 'company'}, [leakyRow]);
    const {jobs} = await svc.browseOpenJobs('a1', 'AE');
    expect(jobs).toHaveLength(1);
    const keys = Object.keys(jobs[0]);
    for (const forbidden of ['pickup_lat', 'pickup_lng', 'pickup_address', 'dropoff_address', 'client_id']) {
      expect(keys).not.toContain(forbidden);
    }
    expect(jobs[0]).toEqual({
      booking_id: 'b-1', status: 'PENDING_OPS', region_code: 'AE', region_label: 'Dubai',
      service: 'close_protection', pickup_area: 'Dubai Marina',
      pickup_time: COARSE_ROW.pickup_time, duration_hours: 4, cpo_count: 2,
      armed_required: false, total_eur: '344.00', total_aed: '1376.00',
      created_at: COARSE_ROW.created_at,
    });
  });
});

describe('AgentService.getAvailableJobs (legacy feed) — FRAUD-4 coarse', () => {
  it('returns NULL coords + a coarse distance_bucket — never the raw pickup/dropoff', async () => {
    const {svc, calls} = mk({type: 'company'});
    await svc.getAvailableJobs('a1');
    const jobsCall = calls.find(c => /FROM jobs j/.test(c.sql));
    expect(jobsCall).toBeDefined();
    const sql = jobsCall!.sql;
    // Coords still power the proximity WHERE/ORDER server-side, but the OUTPUT is coarse.
    expect(sql).toMatch(/NULL::double precision AS pickup_lat/);
    expect(sql).toMatch(/NULL::double precision AS dropoff_lat/);
    expect(sql).toMatch(/AS distance_bucket/);
    // A reverted fix would SELECT the raw coords into the response — it must not.
    expect(sql).not.toMatch(/b\.pickup_lat, b\.pickup_lng, b\.dropoff_lat, b\.dropoff_lng,/);
  });
});
