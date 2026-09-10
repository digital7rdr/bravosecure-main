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
 * The "Client Picked Up" checkpoint record (founder deck, August 2026, page 3).
 *
 * The deck requires the checkpoint to record "mission ID, user/driver ID, GPS
 * position, timestamp". Before this, the device fix that rides with the
 * transition was consumed ONLY by the fire-and-forget geofence warning and then
 * discarded — so after the fact there was no way to answer "where was the driver
 * when they confirmed the client was aboard". pickup_at / live_at gave the WHEN,
 * mission_crew gave the WHO, and the WHERE was simply gone.
 *
 * The record is deliberately best-effort and deliberately NOT in
 * OpsAuditService.CRITICAL_ACTIONS: a transient audit-insert failure must never
 * roll back a real mission transition.
 */
const db = {q: jest.fn(), qOne: jest.fn(), withTransaction: jest.fn()};
const config = {get: jest.fn(() => 259200)};

function svc(): AgentService {
  return new AgentService(
    db as unknown as DatabaseService,
    new AgentStateMachine(),
    {} as unknown as RedisService,
    {} as unknown as CpoAssignmentService,
    {} as unknown as WalletService,
    {} as unknown as DepartmentService,
    {} as unknown as ProofOfCompletionService,
    config as unknown as ConfigService,
  );
}

/** Lead assigned, no pending deploy checks, and the status UPDATE matches a row. */
function wire(opts: {updated?: boolean} = {}): void {
  const updated = opts.updated !== false;
  db.qOne.mockImplementation((sql: string) => {
    if (/SELECT is_lead FROM mission_crew/.test(sql)) {return Promise.resolve({is_lead: true});}
    if (/agent_deployment_checks/.test(sql)) {return Promise.resolve({n: '0'});}
    return Promise.resolve(null);
  });
  db.q.mockImplementation((sql: string) => {
    if (/UPDATE missions SET status/.test(sql)) {
      return Promise.resolve(updated ? [{id: 'm1', booking_id: 'b1'}] : []);
    }
    return Promise.resolve([]);
  });
}

const auditCalls = () =>
  db.q.mock.calls.filter(c => /INSERT INTO ops_audit/.test(String(c[0])));

const auditMeta = (call: unknown[]) =>
  JSON.parse(String((call[1] as unknown[])[3])) as Record<string, unknown>;

beforeEach(() => {
  jest.resetAllMocks();
  wire();
});

describe('the checkpoint records who / where / when', () => {
  it('Client Picked Up writes a mission-scoped record with the actor and the fix', async () => {
    await svc().missionGoLive('lead-1', 'm1', {lat: 25.1234, lng: 55.4321});

    const calls = auditCalls();
    expect(calls).toHaveLength(1);
    const params = calls[0][1] as unknown[];
    expect(params[0]).toBe('lead-1');              // user/driver ID
    expect(params[1]).toBe('mission.client_picked_up');
    expect(params[2]).toBe('m1');                  // mission ID
    const meta = auditMeta(calls[0]);
    expect(meta.lat).toBe(25.1234);                // GPS position
    expect(meta.lng).toBe(55.4321);
    expect(meta.has_fix).toBe(true);
    expect(meta.booking_id).toBe('b1');
    // The timestamp is ops_audit.created_at (DEFAULT NOW()) — authoritative, and
    // not something a client clock can skew.
  });

  it('Arrived at pickup is recorded under its own action', async () => {
    await svc().missionPickup('lead-1', 'm1', {lat: 25.1, lng: 55.2});
    const calls = auditCalls();
    expect(calls).toHaveLength(1);
    expect((calls[0][1] as unknown[])[1]).toBe('mission.arrived_at_pickup');
  });

  it('a missing device fix is recorded honestly, not as an unknown position', async () => {
    // A denied permission or a 3 s timeout resolves the fix to undefined.
    await svc().missionGoLive('lead-1', 'm1', undefined);
    const meta = auditMeta(auditCalls()[0]);
    expect(meta.has_fix).toBe(false);
    expect(meta.lat).toBeNull();
    expect(meta.lng).toBeNull();
  });
});

describe('the record cannot be fabricated or become load-bearing', () => {
  it('is NOT written when the conditional UPDATE matched nothing', async () => {
    // A replayed idempotent 200, or a mission already past this state.
    wire({updated: false});
    await svc().missionGoLive('lead-1', 'm1', {lat: 25.1, lng: 55.2});
    expect(auditCalls()).toHaveLength(0);
  });

  it('an audit-insert failure never fails the transition', async () => {
    db.q.mockImplementation((sql: string) => {
      if (/INSERT INTO ops_audit/.test(sql)) {return Promise.reject(new Error('audit table down'));}
      if (/UPDATE missions SET status/.test(sql)) {return Promise.resolve([{id: 'm1', booking_id: 'b1'}]);}
      return Promise.resolve([]);
    });
    await expect(svc().missionGoLive('lead-1', 'm1', {lat: 25.1, lng: 55.2}))
      .resolves.toEqual({ok: true});
  });
});
