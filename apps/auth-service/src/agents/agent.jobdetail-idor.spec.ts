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
 * Step 22 — getJobDetail must not leak precise pickup/drop-off coordinates, full
 * addresses or client notes to an agent who has no stake in the job. The browse
 * summary stays open; the precise location is gated on a non-REJECTED application.
 */
function mk(application: {status: string} | null): AgentService {
  const db = {
    q: jest.fn().mockResolvedValue([]),
    qOne: jest.fn().mockImplementation((sql: string) => {
      if (/FROM agents WHERE user_id/.test(sql)) {
        return Promise.resolve({user_id: 'a1', type: 'cpo', status: 'ACTIVE'});
      }
      if (/FROM jobs WHERE id/.test(sql)) {
        return Promise.resolve({
          id: 'j1', booking_id: 'b1', short_code: 'BL-1', status: 'OPEN',
          region_code: 'AE', route_label: 'Dubai → DXB', dispatch_at: new Date(),
          duration_hours: 4, cpo_slots: 2, slots_filled: 0, published_at: new Date(),
        });
      }
      if (/FROM job_applications/.test(sql)) {
        return Promise.resolve(application ? {id: 'app1', status: application.status, applied_at: new Date()} : null);
      }
      if (/FROM lite_bookings WHERE id/.test(sql)) {
        return Promise.resolve({
          pickup_address: '12 Privacy St', pickup_lat: '25.1', pickup_lng: '55.2',
          dropoff_address: '7 Secret Rd', dropoff_lat: '25.3', dropoff_lng: '55.4',
          pickup_time: new Date(), total_eur: '100', total_aed: '367',
          cpo_count: 1, vehicle_count: 1, driver_only: false, passengers: 1,
          add_ons: [], notes: 'gate code 4471', service: 'secure_transfer',
          region_label: 'Dubai', dress_instructions: null,
        });
      }
      return Promise.resolve(null);
    }),
  } as unknown as DatabaseService;
  return new AgentService(
    db, new AgentStateMachine(),
    {} as unknown as RedisService, {} as unknown as CpoAssignmentService,
    {} as unknown as WalletService, {} as unknown as DepartmentService,
    {} as unknown as ProofOfCompletionService, {get: () => 0} as unknown as ConfigService,
  );
}

describe('AgentService.getJobDetail — precise-location IDOR (Step 22)', () => {
  it('redacts coords/address/notes when the agent has NOT applied', async () => {
    const out = await mk(null).getJobDetail('a1', 'j1');
    expect(out.location_revealed).toBe(false);
    expect(out.booking?.pickup_address).toBeNull();
    expect(out.booking?.pickup_lat).toBeNull();
    expect(out.booking?.dropoff_lng).toBeNull();
    expect(out.booking?.notes).toBeNull();
    // Non-sensitive browse fields still flow through.
    expect(out.booking?.service).toBe('secure_transfer');
    expect(out.job.route_label).toBe('Dubai → DXB');
  });

  it('redacts when the application was REJECTED (no access via a denied apply)', async () => {
    const out = await mk({status: 'REJECTED'}).getJobDetail('a1', 'j1');
    expect(out.location_revealed).toBe(false);
    expect(out.booking?.pickup_address).toBeNull();
  });

  it('reveals precise location to an agent with a live (non-rejected) application', async () => {
    const out = await mk({status: 'PENDING'}).getJobDetail('a1', 'j1');
    expect(out.location_revealed).toBe(true);
    expect(out.booking?.pickup_address).toBe('12 Privacy St');
    expect(out.booking?.pickup_lat).toBe('25.1');
    expect(out.booking?.notes).toBe('gate code 4471');
  });
});
