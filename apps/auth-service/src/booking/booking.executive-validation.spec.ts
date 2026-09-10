/**
 * E-7 (audit 2026-08-05) — the executive create()/estimate() VALIDATION layer had
 * zero coverage: pricing was pinned on both sides, but the reject-never-reprice
 * money guards (all eight `exec_*` codes) could regress silently. Every code is
 * exercised here, plus the two guards the same audit added (B-385 `unknown_add_on`,
 * E-14 `vehicle_capacity_insufficient`).
 */
import {BadRequestException} from '@nestjs/common';
import {BookingService} from './booking.service';
import type {DatabaseService} from '../database/database.service';
import type {PricingService} from './pricing.service';
import type {ConfigService} from '@nestjs/config';

function mk(addOnRows: Array<{id: string; label: string; price_eur_per_hour: string}> = []) {
  const dbQOne = jest.fn().mockImplementation((sql: string) => {
    if (/INSERT INTO lite_bookings/.test(sql)) {
      return Promise.resolve({
        id: 'bk1', client_id: 'c1', status: 'PENDING_OPS',
        region_code: 'AE', region_label: 'Dubai', service: 'executive_protection',
        pickup_address: 'X', pickup_lat: 25, pickup_lng: 55, dropoff_address: null,
        dropoff_lat: null, dropoff_lng: null, pickup_time: new Date(), passengers: 1,
        cpo_count: 1, vehicle_count: 0, driver_only: false, add_ons: [], total_eur: 258,
        duration_hours: 3, total_aed: 947, conversation_id: null, created_at: new Date(),
      });
    }
    if (/FROM wallet_balances/.test(sql)) {return Promise.resolve({bravo_credits: 10_000});}
    return Promise.resolve(null);
  });
  const dbQ = jest.fn().mockImplementation((sql: string) => {
    if (/FROM lite_booking_add_ons/.test(sql)) {return Promise.resolve(addOnRows);}
    return Promise.resolve([]);
  });
  const db = {
    qOne: dbQOne, q: dbQ,
    withTransaction: (fn: (t: unknown) => unknown) => fn({q: dbQ, qOne: dbQOne}),
  } as unknown as DatabaseService;
  const pricing = {calculate: jest.fn().mockReturnValue({
    rate_eur_per_hour: 86, rate_aed_per_hour: 316, total_eur: 258, total_aed: 947,
    breakdown: [],
  })} as unknown as PricingService;
  const family = {resolvePayer: jest.fn().mockResolvedValue({payerId: 'c1', familyRowId: null, spendLimit: null, spent: 0})};
  const svc = new BookingService(
    db, pricing, {assert: jest.fn()} as never, {} as never, {} as never,
    {} as never, family as never, {} as never, {get: () => undefined} as unknown as ConfigService,
  );
  return {svc};
}

function execDto(extra: Record<string, unknown> = {}) {
  return {
    type: 'timeslot', region: 'AE', region_label: 'Dubai', service: 'executive_protection',
    booking_mode: 'now', start_time: new Date(Date.now() + 30 * 60_000).toISOString(),
    pickup: {address: 'X', latitude: 25, longitude: 55}, add_ons: [],
    passengers: 1, cpo_count: 1, vehicle_count: 0, driver_only: false,
    payment_method: 'bravo_credits', duration_hours: 3, task_type: 'site_protection',
    location_consent: true, terms_accepted: true, ...extra,
  } as never;
}

const transport = (over: Record<string, unknown> = {}) => ({
  mode: 'one_way',
  pickup: {address: 'A', latitude: 25.1, longitude: 55.1},
  dropoff: {address: 'B', latitude: 25.2, longitude: 55.2},
  ...over,
});

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  try {
    await p;
    throw new Error(`expected BadRequestException(${code}) — resolved instead`);
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    const body = (e as BadRequestException).getResponse() as {code?: string; message?: string};
    const got = typeof body === 'string' ? body : (body.code ?? body.message);
    expect(got).toBe(code);
  }
}

describe('executive create() — reject-never-reprice validation (E-7)', () => {
  it('exec_invalid_duration — off the 3..24 %3 grid', async () => {
    const {svc} = mk();
    await expectCode(svc.create('c1', execDto({duration_hours: 5})), 'exec_invalid_duration');
    await expectCode(svc.create('c1', execDto({duration_hours: 27})), 'exec_invalid_duration');
  });

  it('exec_invalid_task_type — unknown task', async () => {
    const {svc} = mk();
    await expectCode(svc.create('c1', execDto({task_type: 'yacht_party'})), 'exec_invalid_task_type');
  });

  it('exec_invalid_transport — malformed leg', async () => {
    const {svc} = mk();
    await expectCode(
      svc.create('c1', execDto({vehicle_count: 1, exec_transport: transport({mode: 'teleport'})})),
      'exec_invalid_transport');
    await expectCode(
      svc.create('c1', execDto({vehicle_count: 1, exec_transport: transport({pickup: {address: 'A'}})})),
      'exec_invalid_transport');
  });

  it('exec_transport_time_out_of_window — leg outside [start − 2h, start + block]', async () => {
    const {svc} = mk();
    const start = Date.now() + 30 * 60_000;
    await expectCode(
      svc.create('c1', execDto({
        vehicle_count: 1,
        exec_transport: transport({pickup_time: new Date(start - 3 * 3600_000).toISOString()}),
      })),
      'exec_transport_time_out_of_window');
    await expectCode(
      svc.create('c1', execDto({
        vehicle_count: 1, duration_hours: 3,
        exec_transport: transport({pickup_time: new Date(start + 4 * 3600_000).toISOString()}),
      })),
      'exec_transport_time_out_of_window');
  });

  it('exec_transport_required — vehicles or driver-only without a transfer leg', async () => {
    const {svc} = mk();
    await expectCode(svc.create('c1', execDto({vehicle_count: 1})), 'exec_transport_required');
    await expectCode(svc.create('c1', execDto({driver_only: true})), 'exec_transport_required');
  });

  it('exec_vehicle_required — a transfer leg with nothing to drive it', async () => {
    const {svc} = mk();
    await expectCode(
      svc.create('c1', execDto({vehicle_count: 0, exec_transport: transport()})),
      'exec_vehicle_required');
  });

  it('exec_cpo_seat_cap — driver-only team that cannot board the client vehicle', async () => {
    const {svc} = mk();
    await expectCode(
      svc.create('c1', execDto({
        driver_only: true, passengers: 3, cpo_count: 2, exec_transport: transport(),
      })),
      'exec_cpo_seat_cap');
  });

  it('exec_unknown_addon — outside the fixed executive catalogue', async () => {
    const {svc} = mk();
    await expectCode(svc.create('c1', execDto({add_ons: ['gold_plating']})), 'exec_unknown_addon');
  });

  it('a fully valid executive request passes validation and inserts', async () => {
    const {svc} = mk();
    const res = await svc.create('c1', execDto());
    expect(res.booking.id).toBe('bk1');
  });
});

describe('B-385 / E-14 — the same audit’s new Lite guards', () => {
  it('unknown_add_on — a Lite id the catalogue does not resolve is REJECTED (was silently dropped)', async () => {
    const {svc} = mk([]); // catalogue resolves nothing
    await expectCode(
      svc.create('c1', execDto({
        service: 'secure_transfer', vehicle_count: 1, add_ons: ['medical'],
        start_time: new Date(Date.now() + 4 * 3600_000).toISOString(), booking_mode: 'later',
      })),
      'unknown_add_on');
  });

  it('vehicle_capacity_insufficient — passengers that cannot board the vehicles', async () => {
    const {svc} = mk();
    await expectCode(
      svc.create('c1', execDto({
        service: 'secure_transfer', passengers: 7, vehicle_count: 2, cpo_count: 1,
        start_time: new Date(Date.now() + 4 * 3600_000).toISOString(), booking_mode: 'later',
      })),
      'vehicle_capacity_insufficient');
  });
});

describe('E-9 — estimate() mirrors create()’s reject rules', () => {
  it('exec estimate REJECTS a seat-cap violation instead of silently clamping the quote', async () => {
    const {svc} = mk();
    await expectCode(
      svc.estimate({
        type: 'timeslot', region: 'AE', service: 'executive_protection', add_ons: [],
        duration_hours: 3, driver_only: true, passengers: 3, cpo_count: 2,
      } as never),
      'exec_cpo_seat_cap');
  });

  it('Lite estimate rejects an unboardable passenger/vehicle combination', async () => {
    const {svc} = mk();
    await expectCode(
      svc.estimate({
        type: 'timeslot', region: 'AE', add_ons: [],
        passengers: 7, vehicle_count: 2, cpo_count: 1,
      } as never),
      'vehicle_capacity_insufficient');
  });
});
