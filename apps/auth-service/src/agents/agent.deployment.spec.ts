import {ForbiddenException} from '@nestjs/common';
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
 * Step 21 — getMyMissionDeployment must be CREW-ONLY. The membership gate closes a
 * pre-existing IDOR (any authenticated agent could read another mission's pickup/dropoff
 * coords + the principal's name); the extended payload (crew roster + client_name) makes
 * the gate load-bearing.
 */
function mk(member: boolean, clientFix: {lat: number; lng: number; at: Date} | null = {lat: 25.197, lng: 55.274, at: new Date('2026-06-25T10:00:00.000Z')}): AgentService {
  const db = {
    q: jest.fn().mockImplementation((sql: string) =>
      /AS is_me/.test(sql)
        ? Promise.resolve([{call_sign: 'A1', role: 'LEAD', team_idx: 0, is_lead: true, is_me: true}])
        : Promise.resolve([])), // checks, waypoints
    qOne: jest.fn().mockImplementation((sql: string) => {
      // B-377 — the caller's crew row now also carries their own response stamps.
      if (/SELECT is_lead, team_idx, role, call_sign, accepted_at, declined_at\s+FROM mission_crew/.test(sql)) {
        return Promise.resolve(member
          ? {is_lead: true, team_idx: 0, role: 'LEAD', call_sign: 'A1', accepted_at: null, declined_at: null}
          : null);
      }
      if (/short_code, status, booking_id/.test(sql)) {
        return Promise.resolve({short_code: 'BL-1', status: 'LIVE', booking_id: 'b1', route_distance_m: null, route_duration_s: null, route_polyline: null, current_lat: null, current_lng: null, client_lat: clientFix?.lat ?? null, client_lng: clientFix?.lng ?? null, client_recorded_at: clientFix?.at ?? null, comms_channel_id: null});
      }
      if (/client_name/.test(sql)) {
        return Promise.resolve({pickup_address: 'X', pickup_lat: null, pickup_lng: null, dropoff_address: null, dropoff_lat: null, dropoff_lng: null, booking_status: 'LIVE', client_name: 'Jane Principal'});
      }
      return Promise.resolve(null); // dress
    }),
  } as unknown as DatabaseService;
  return new AgentService(
    db, new AgentStateMachine(),
    {} as unknown as RedisService, {} as unknown as CpoAssignmentService,
    {} as unknown as WalletService, {} as unknown as DepartmentService,
    {} as unknown as ProofOfCompletionService, {get: () => 0} as unknown as ConfigService,
  );
}

describe('AgentService.getMyMissionDeployment — membership gate (Step 21)', () => {
  it('throws Forbidden when the caller is NOT on the mission crew (IDOR closed)', async () => {
    await expect(mk(false).getMyMissionDeployment('intruder', 'm1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns the brief + crew roster + principal name for a crew member', async () => {
    const out = await mk(true).getMyMissionDeployment('cpo1', 'm1');
    expect(out.crew_role?.is_lead).toBe(true);
    expect(out.booking?.client_name).toBe('Jane Principal');
    expect(out.booking?.booking_status).toBe('LIVE');
    expect(out.crew).toHaveLength(1);
    expect(out.crew[0].is_me).toBe(true);
  });

  // Step 29 — the principal's own last-known GPS rides the same crew-gated read so
  // the live map can draw the user marker next to the CPO leader.
  it('returns the principal live position (client-ping) for a crew member, ISO-normalized', async () => {
    const out = await mk(true).getMyMissionDeployment('cpo1', 'm1');
    expect(out.mission?.client_lat).toBe(25.197);
    expect(out.mission?.client_lng).toBe(55.274);
    expect(out.mission?.client_recorded_at).toBe('2026-06-25T10:00:00.000Z');
  });

  it('returns null principal position when the client has not pinged', async () => {
    const out = await mk(true, null).getMyMissionDeployment('cpo1', 'm1');
    expect(out.mission?.client_lat).toBeNull();
    expect(out.mission?.client_lng).toBeNull();
    expect(out.mission?.client_recorded_at).toBeNull();
  });
});
