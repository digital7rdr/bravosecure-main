import {BadRequestException} from '@nestjs/common';
import {BookingService} from './booking.service';
import type {DatabaseService} from '../database/database.service';
import type {PricingService} from './pricing.service';
import type {ConfigService} from '@nestjs/config';

/**
 * B-405 — a parked future reservation must not hold the one-mission slot.
 * Founder repro 2026-08-09: with a 'later' booking sitting PENDING_OPS /
 * OPS_APPROVED (zero commitment — no escrow, no crew, dispatch starts ~15 min
 * before pickup), the client must still be able to book go-now.
 */
function mkCreate(activeRow: {id: string; status: string} | null = null, parkedCount = 0) {
  const guardCalls: string[] = [];
  const capCalls: string[] = [];
  const dbQOne = jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
    if (/status NOT IN \('COMPLETED','CANCELLED','NO_PROVIDER','AGENCY_NO_SHOW'\)/.test(sql)) {
      guardCalls.push(sql);
      return Promise.resolve(activeRow);
    }
    if (/count\(\*\)::int AS n FROM lite_bookings/.test(sql)) {
      capCalls.push(sql);
      return Promise.resolve({n: parkedCount});
    }
    if (/INSERT INTO lite_bookings/.test(sql)) {
      return Promise.resolve({
        id: 'bk1', client_id: 'c1', status: (params as unknown[])?.[24] ?? 'PENDING_OPS',
        region_code: 'AE', region_label: 'Dubai', service: 'secure_transfer',
        pickup_address: 'X', pickup_lat: 25, pickup_lng: 55, dropoff_address: null,
        dropoff_lat: null, dropoff_lng: null, pickup_time: new Date(), passengers: 1,
        cpo_count: 1, vehicle_count: 1, driver_only: false, add_ons: [], total_eur: 100,
        duration_hours: 4, total_aed: 367, conversation_id: null, created_at: new Date(),
      });
    }
    if (/FROM wallet_balances/.test(sql)) return Promise.resolve({bravo_credits: 10_000});
    return Promise.resolve(null);
  });
  const db = {
    qOne: dbQOne, q: jest.fn().mockResolvedValue([]),
    withTransaction: (fn: (t: unknown) => unknown) => fn({q: jest.fn().mockResolvedValue([]), qOne: dbQOne}),
  } as unknown as DatabaseService;
  const pricing = {calculate: jest.fn().mockReturnValue({
    rate_eur_per_hour: 25, rate_aed_per_hour: 91, total_eur: 100, total_aed: 367,
  })} as unknown as PricingService;
  const family = {resolvePayer: jest.fn().mockResolvedValue({payerId: 'c1', familyRowId: null, spendLimit: null, spent: 0})};
  const svc = new BookingService(
    db, pricing, {assert: jest.fn()} as never, {} as never, {} as never,
    {} as never, family as never, {} as never, {get: () => undefined} as unknown as ConfigService,
  );
  return {svc, guardCalls, capCalls};
}

function nowDto(extra: Record<string, unknown> = {}) {
  return {
    type: 'transfer', region: 'AE', region_label: 'Dubai', service: 'secure_transfer',
    booking_mode: 'now', start_time: new Date(Date.now() + 30 * 60_000).toISOString(),
    pickup: {address: 'X', latitude: 25, longitude: 55}, add_ons: [],
    passengers: 1, cpo_count: 1, vehicle_count: 1, driver_only: false,
    payment_method: 'card', duration_hours: 4,
    location_consent: true, terms_accepted: true, ...extra,
  } as never;
}

describe('BookingService.create — B-405 parked future reservations free the slot', () => {
  it('the one-active guard SQL exempts parked reservations at the decision site (legacy OPS_APPROVED still holds it)', async () => {
    const {svc, guardCalls} = mkCreate(null);
    await svc.create('c1', nowDto(), {autoDispatch: true});
    expect(guardCalls).toHaveLength(1);
    // The exemption must live INSIDE the guard query — a client-side filter
    // would leave the raced/stale-client backstop broken. PENDING_OPS is parked
    // for either mode; OPS_APPROVED is parked ONLY for auto — a legacy 'later'
    // row at OPS_APPROVED owes payment NOW and must keep blocking (3-agent
    // review: otherwise it dies unpaid at pickup+60 behind an APPROVED chip).
    expect(guardCalls[0]).toMatch(
      /AND NOT \(booking_mode = 'later'[\s\S]{0,80}status = 'PENDING_OPS'[\s\S]{0,80}\(status = 'OPS_APPROVED' AND dispatch_mode = 'auto'\)\)\)/,
    );
  });

  it('a genuinely active booking (DISPATCHING) still blocks with active_booking_exists', async () => {
    const {svc} = mkCreate({id: 'busy1', status: 'DISPATCHING'});
    await expect(svc.create('c1', nowDto(), {autoDispatch: true}))
      .rejects.toMatchObject({
        response: expect.objectContaining({code: 'active_booking_exists', booking_id: 'busy1'}),
      });
    await expect(svc.create('c1', nowDto(), {autoDispatch: true}))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('a 4th parked reservation is rejected with too_many_scheduled_bookings', async () => {
    const later = nowDto({
      booking_mode: 'later',
      start_time: new Date(Date.now() + 48 * 3600_000).toISOString(),
    });
    const {svc} = mkCreate(null, 3);
    await expect(svc.create('c1', later, {autoDispatch: true}))
      .rejects.toMatchObject({
        response: expect.objectContaining({code: 'too_many_scheduled_bookings'}),
      });
  });

  it('the cap counts only parked rows and never runs for a go-now booking', async () => {
    const {svc, capCalls} = mkCreate(null, 3);
    // 3 parked reservations must NOT block a go-now booking — that is the
    // whole point of B-405.
    await svc.create('c1', nowDto(), {autoDispatch: true});
    expect(capCalls).toHaveLength(0);

    const {svc: svc2, capCalls: capCalls2} = mkCreate(null, 2);
    const later = nowDto({
      booking_mode: 'later',
      start_time: new Date(Date.now() + 48 * 3600_000).toISOString(),
    });
    await svc2.create('c1', later, {autoDispatch: true});
    expect(capCalls2).toHaveLength(1);
    expect(capCalls2[0]).toMatch(/booking_mode = 'later'/);
    expect(capCalls2[0]).toMatch(/\(status = 'OPS_APPROVED' AND dispatch_mode = 'auto'\)/);
  });
});
