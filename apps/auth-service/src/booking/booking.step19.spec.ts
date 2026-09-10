import {BookingService} from './booking.service';
import type {DatabaseService} from '../database/database.service';
import type {PricingService} from './pricing.service';
import type {ConfigService} from '@nestjs/config';

/** Harness routing db.qOne/db.q by SQL regex + a captured INSERT param array. */
function mk(opts: {qOneRoutes?: Array<[RegExp, unknown]>; capture?: {insertParams?: unknown[]}}) {
  const dbQOne = jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
    if (/INSERT INTO lite_bookings/.test(sql)) {
      if (opts.capture) {opts.capture.insertParams = params;}
      // Return a minimal LiteBookingRow toClientBooking can consume.
      return Promise.resolve({
        id: 'bk1', client_id: 'c1', status: (params as unknown[])?.[24] ?? 'PENDING_OPS',
        region_code: 'AE', region_label: 'Dubai', service: 'secure_transfer',
        pickup_address: 'X', pickup_lat: 25, pickup_lng: 55, dropoff_address: null,
        dropoff_lat: null, dropoff_lng: null, pickup_time: new Date('2026-06-30T00:00:00Z'),
        passengers: 1, cpo_count: 1, vehicle_count: 1, driver_only: false, add_ons: [],
        total_eur: 100, duration_hours: 4, total_aed: 367, conversation_id: null,
        created_at: new Date('2026-06-22T00:00:00Z'),
      });
    }
    // LM-B7 — the auto path's request-time affordability soft-check.
    if (/FROM wallet_balances/.test(sql)) return Promise.resolve({bravo_credits: 10_000});
    for (const [re, val] of opts.qOneRoutes ?? []) if (re.test(sql)) return Promise.resolve(val);
    return Promise.resolve(null);
  });
  const db = {
    qOne: dbQOne, q: jest.fn().mockResolvedValue([]),
    withTransaction: (fn: (t: unknown) => unknown) => fn({q: jest.fn().mockResolvedValue([]), qOne: dbQOne}),
  } as unknown as DatabaseService;
  const pricing = {calculate: jest.fn().mockReturnValue({
    rate_eur_per_hour: 25, rate_aed_per_hour: 91, total_eur: 100, total_aed: 367,
  })} as unknown as PricingService;
  const config = {get: () => undefined} as unknown as ConfigService;
  const fsm = {assert: jest.fn()};
  // LM-B7 — the auto path resolves the payer at request time.
  const family = {resolvePayer: jest.fn().mockResolvedValue({payerId: 'c1', familyRowId: null, spendLimit: null, spent: 0})};
  const svc = new BookingService(
    db, pricing, fsm as never, {} as never, {} as never, {} as never, family as never, {} as never, config,
  );
  return {svc, dbQOne, fsm};
}

function futureDto() {
  return {
    type: 'transfer', region: 'AE', region_label: 'Dubai', service: 'secure_transfer',
    booking_mode: 'now', start_time: new Date(Date.now() + 4 * 3_600_000).toISOString(),
    pickup: {address: 'X', latitude: 25, longitude: 55}, add_ons: [],
    passengers: 1, cpo_count: 1, vehicle_count: 1, driver_only: false,
    payment_method: 'card', duration_hours: 4,
    // Step 22 — the auto path now requires lawful-basis consent; supply it so these
    // DRAFT/dispatch_mode assertions exercise the auto branch (legacy ignores them).
    location_consent: true, terms_accepted: true,
  } as never;
}

describe('BookingService.create — auto-dispatch branch (Step 19)', () => {
  it('legacy create persists PENDING_OPS with NULL dispatch_mode (byte-for-byte)', async () => {
    const capture: {insertParams?: unknown[]} = {};
    const {svc, fsm} = mk({capture});
    const res = await svc.create('c1', futureDto());
    expect(capture.insertParams?.[24]).toBe('PENDING_OPS');
    expect(capture.insertParams?.[25]).toBeNull();
    expect(fsm.assert).toHaveBeenCalledWith('DRAFT', 'PENDING_OPS', 'CLIENT');
    expect(res.booking.status).toBe('PENDING_OPS');
  });

  it('auto create persists PENDING_OPS + dispatch_mode=auto — ops-gated, never straight to the matchmaker', async () => {
    const capture: {insertParams?: unknown[]} = {};
    const {svc, fsm} = mk({capture});
    const res = await svc.create('c1', futureDto(), {autoDispatch: true});
    expect(capture.insertParams?.[24]).toBe('PENDING_OPS');
    expect(capture.insertParams?.[25]).toBe('auto');
    // Ops-gated auto dispatch: the auto path submits to the ops board like legacy;
    // approval (not the client request) later asserts OPS_APPROVED→DISPATCHING.
    expect(fsm.assert).toHaveBeenCalledWith('DRAFT', 'PENDING_OPS', 'CLIENT');
    expect(res.booking.status).toBe('PENDING_OPS');
  });

  it('treats NO_PROVIDER / AGENCY_NO_SHOW as terminal so a failed search frees the slot (LB17)', async () => {
    // The active-booking guard SELECT must exclude the auto-terminal states. We assert the
    // SQL the service issues, since a NO_PROVIDER row must not block a fresh request.
    const {svc, dbQOne} = mk({});
    await svc.create('c1', futureDto());
    const activeSelect = dbQOne.mock.calls.find(c => /status NOT IN/.test(c[0] as string));
    expect(activeSelect?.[0]).toMatch(/'NO_PROVIDER'/);
    expect(activeSelect?.[0]).toMatch(/'AGENCY_NO_SHOW'/);
  });
});

describe('BookingService.getProvider — coarse reveal (Step 19)', () => {
  it('returns name/call-sign/rating/jobs for the assigned provider (owner-scoped)', async () => {
    const {svc} = mk({qOneRoutes: [
      [/assigned_provider_user_id FROM lite_bookings/, {assigned_provider_user_id: 'agency-A'}],
      [/FROM agents WHERE user_id/, {display_name: 'Acme CP', call_sign: 'A1', rating: '4.80', jobs_total: 37}],
    ]});
    const res = await svc.getProvider('c1', 'bk1');
    expect(res).toEqual({display_name: 'Acme CP', call_sign: 'A1', rating: 4.8, jobs_total: 37});
  });

  it('404s no_provider_yet while still DISPATCHING (no agency assigned)', async () => {
    const {svc} = mk({qOneRoutes: [
      [/assigned_provider_user_id FROM lite_bookings/, {assigned_provider_user_id: null}],
    ]});
    await expect(svc.getProvider('c1', 'bk1')).rejects.toThrow('no_provider_yet');
  });

  it('404s for a booking that is not the caller\'s', async () => {
    const {svc} = mk({qOneRoutes: []}); // ownership SELECT returns null
    await expect(svc.getProvider('intruder', 'bk1')).rejects.toThrow('Booking not found');
  });
});
