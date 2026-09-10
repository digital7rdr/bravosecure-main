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
 * Step 23 anti-fraud — updateLocation() plausibility + mock gating. A mocked or
 * teleporting fix is flagged `last_location_mocked` but must NOT advance the trusted
 * last_location (so it can't win dispatch); a legit fix updates geo + clears the flag.
 */
function mk(prev: {last_lat?: number; last_lng?: number; last_location_at?: Date | null}) {
  const calls: Array<{sql: string; params: unknown[]}> = [];
  const db = {
    q: jest.fn().mockImplementation((sql: string, params: unknown[]) => {
      calls.push({sql, params});
      return Promise.resolve([]);
    }),
    qOne: jest.fn().mockImplementation((sql: string) =>
      /FROM agents WHERE user_id/.test(sql)
        ? Promise.resolve({user_id: 'a1', type: 'cpo', status: 'ACTIVE', ...prev})
        : Promise.resolve(null)),
  } as unknown as DatabaseService;
  const svc = new AgentService(
    db, new AgentStateMachine(),
    {} as unknown as RedisService, {} as unknown as CpoAssignmentService,
    {} as unknown as WalletService, {} as unknown as DepartmentService,
    {} as unknown as ProofOfCompletionService, {get: () => 0} as unknown as ConfigService,
  );
  return {svc, calls};
}
const geoUpdate = (c: {sql: string}) => /last_location = extensions\.ST_SetSRID/.test(c.sql);
const mockFreeze = (c: {sql: string}) => /SET\s+last_location_mocked = TRUE/.test(c.sql) && !geoUpdate(c);

describe('AgentService.updateLocation — plausibility + mock gating (Step 23)', () => {
  it('client-reported mock freezes the trusted position (records mocked, no geo update)', async () => {
    const {svc, calls} = mk({last_lat: 25, last_lng: 55, last_location_at: new Date(Date.now() - 60_000)});
    await svc.updateLocation('a1', 25.0001, 55.0001, {is_mocked: true, accuracy_m: 12});
    expect(calls.some(mockFreeze)).toBe(true);
    expect(calls.some(geoUpdate)).toBe(false);
  });

  it('an impossible-speed teleport is flagged mocked and does not move last_location', async () => {
    // ~7000 km in 10 s ⇒ ~2.5M km/h ⇒ implausible (well above the accuracy buffer).
    const {svc, calls} = mk({last_lat: 0, last_lng: 0, last_location_at: new Date(Date.now() - 10_000)});
    await svc.updateLocation('a1', 50, 50, {accuracy_m: 8});
    expect(calls.some(mockFreeze)).toBe(true);
    expect(calls.some(geoUpdate)).toBe(false);
  });

  it('does NOT false-flag ordinary GPS jitter on near-simultaneous fixes (accuracy-aware)', async () => {
    // ~600 m apparent jump only 2 s apart with poor accuracy — below the min-dt window,
    // so it must NOT be treated as a teleport (would wrongly bench a real agency).
    const {svc, calls} = mk({last_lat: 25.2105, last_lng: 55.2727, last_location_at: new Date(Date.now() - 2_000)});
    await svc.updateLocation('a1', 25.2160, 55.2782, {accuracy_m: 120});
    expect(calls.some(geoUpdate)).toBe(true);
    expect(calls.some(mockFreeze)).toBe(false);
  });

  it('a plausible slow move updates geo and clears the mocked flag', async () => {
    const {svc, calls} = mk({last_lat: 25, last_lng: 55, last_location_at: new Date(Date.now() - 60_000)});
    await svc.updateLocation('a1', 25.001, 55.001, {accuracy_m: 5, speed_kph: 4});
    const geo = calls.find(geoUpdate);
    expect(geo).toBeDefined();
    expect(geo?.sql).toMatch(/last_location_mocked = FALSE/);
    expect(calls.some(mockFreeze)).toBe(false);
  });

  it('with no prior fix there is nothing to compare, so a first fix is trusted', async () => {
    const {svc, calls} = mk({last_lat: undefined, last_lng: undefined, last_location_at: null});
    await svc.updateLocation('a1', 25, 55, {accuracy_m: 9});
    expect(calls.some(geoUpdate)).toBe(true);
  });

  it('FRAUD-3 — a spoofed high-accuracy fix can no longer buy teleport room (slack is capped)', async () => {
    // ~20 km jump in 60 s: allowed by 900 km/h (15 km) + ONLY the capped accuracy slack
    // (~0.3 km). Reporting accuracy_m: 10000 previously bought ~10 km of extra room and
    // slipped through; now it is flagged mocked and does not advance last_location.
    const {svc, calls} = mk({last_lat: 25, last_lng: 55, last_location_at: new Date(Date.now() - 60_000)});
    await svc.updateLocation('a1', 25.18, 55, {accuracy_m: 10000});
    expect(calls.some(mockFreeze)).toBe(true);
    expect(calls.some(geoUpdate)).toBe(false);
  });
});
