import {BadRequestException} from '@nestjs/common';
import {BookingService} from './booking.service';
import type {DatabaseService} from '../database/database.service';
import type {PricingService} from './pricing.service';
import type {ConfigService} from '@nestjs/config';

/** Harness routing db.qOne by SQL regex + capturing the INSERT param array (mirrors step22). */
function mk(capture: {insertParams?: unknown[]}) {
  const dbQOne = jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
    if (/INSERT INTO lite_bookings/.test(sql)) {
      capture.insertParams = params;
      return Promise.resolve({
        id: 'bk1', client_id: 'c1', status: (params as unknown[])?.[24] ?? 'PENDING_OPS',
        region_code: (params as unknown[])?.[1] ?? 'AE', region_label: 'Dubai', service: 'secure_transfer',
        pickup_address: 'X', pickup_lat: 25, pickup_lng: 55, dropoff_address: null,
        dropoff_lat: null, dropoff_lng: null, pickup_time: new Date('2026-06-30T00:00:00Z'),
        passengers: 1, cpo_count: 1, vehicle_count: 1, driver_only: false, add_ons: [],
        total_eur: 100, duration_hours: 4, total_aed: 367, conversation_id: null,
        created_at: new Date('2026-06-22T00:00:00Z'),
      });
    }
    return Promise.resolve(null); // active-booking guard, etc.
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
  const svc = new BookingService(
    db, pricing, fsm as never, {} as never, {} as never, {} as never, {} as never, {} as never, config,
  );
  return {svc};
}

function dto(extra: Record<string, unknown> = {}) {
  return {
    type: 'transfer', region: 'AE', region_label: 'Dubai', service: 'secure_transfer',
    booking_mode: 'now', start_time: new Date(Date.now() + 4 * 3_600_000).toISOString(),
    pickup: {address: 'X', latitude: 25, longitude: 55}, add_ons: [],
    passengers: 1, cpo_count: 1, vehicle_count: 1, driver_only: false,
    payment_method: 'card', duration_hours: 4, ...extra,
  } as never;
}

// region_code is bound as $2 → 0-indexed 1.
const I_REGION = 1;

describe('BookingService.create — region gate', () => {
  it('rejects an unsupported region with no INSERT', async () => {
    const cap: {insertParams?: unknown[]} = {};
    const {svc} = mk(cap);
    await expect(svc.create('c1', dto({region: 'XX'}))).rejects.toBeInstanceOf(BadRequestException);
    expect(cap.insertParams).toBeUndefined();
  });

  it('rejects a blank/missing region with no INSERT', async () => {
    const cap: {insertParams?: unknown[]} = {};
    const {svc} = mk(cap);
    await expect(svc.create('c1', dto({region: ''}))).rejects.toBeInstanceOf(BadRequestException);
    expect(cap.insertParams).toBeUndefined();
  });

  it('normalizes a supported region to upper-case before persisting', async () => {
    const cap: {insertParams?: unknown[]} = {};
    const {svc} = mk(cap);
    await svc.create('c1', dto({region: 'ae'}));
    expect(cap.insertParams?.[I_REGION]).toBe('AE');
  });

  it('accepts every supported region (AE/SA/BD/GB/ZA)', async () => {
    for (const r of ['AE', 'SA', 'BD', 'GB', 'ZA']) {
      const cap: {insertParams?: unknown[]} = {};
      const {svc} = mk(cap);
      await svc.create('c1', dto({region: r}));
      expect(cap.insertParams?.[I_REGION]).toBe(r);
    }
  });
});
