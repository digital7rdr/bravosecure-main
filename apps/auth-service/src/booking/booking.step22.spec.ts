import {BadRequestException} from '@nestjs/common';
import {BookingService} from './booking.service';
import type {DatabaseService} from '../database/database.service';
import type {PricingService} from './pricing.service';
import type {ConfigService} from '@nestjs/config';

/** Harness routing db.qOne by SQL regex + capturing the INSERT param array (mirrors step19). */
function mk(capture: {insertParams?: unknown[]}) {
  const dbQOne = jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
    if (/INSERT INTO lite_bookings/.test(sql)) {
      capture.insertParams = params;
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
    // LM-B7 — auto path affordability soft-check.
    if (/FROM wallet_balances/.test(sql)) return Promise.resolve({bravo_credits: 10_000});
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
  const family = {resolvePayer: jest.fn().mockResolvedValue({payerId: 'c1', familyRowId: null, spendLimit: null, spent: 0})};
  const svc = new BookingService(
    db, pricing, fsm as never, {} as never, {} as never, {} as never, family as never, {} as never, config,
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

// $27–$30 → 0-indexed 26..29.
const I_LOC_AT = 26, I_LOC_VER = 27, I_TERMS_AT = 28, I_TERMS_VER = 29;

describe('BookingService.create — Step 22 lawful-basis consent gate', () => {
  it('auto path WITHOUT consent throws consent_required (no INSERT)', async () => {
    const cap: {insertParams?: unknown[]} = {};
    const {svc} = mk(cap);
    await expect(svc.create('c1', dto(), {autoDispatch: true})).rejects.toBeInstanceOf(BadRequestException);
    expect(cap.insertParams).toBeUndefined();
  });

  it('auto path WITH consent persists versioned location + terms stamps ($27–$30)', async () => {
    const cap: {insertParams?: unknown[]} = {};
    const {svc} = mk(cap);
    await svc.create('c1', dto({
      location_consent: true, terms_accepted: true,
      location_consent_version: 'v-loc', terms_accepted_version: 'v-terms',
    }), {autoDispatch: true});
    expect(cap.insertParams?.[I_LOC_AT]).toBeInstanceOf(Date);
    expect(cap.insertParams?.[I_LOC_VER]).toBe('v-loc');
    expect(cap.insertParams?.[I_TERMS_AT]).toBeInstanceOf(Date);
    expect(cap.insertParams?.[I_TERMS_VER]).toBe('v-terms');
  });

  it('legacy path needs NO consent and stamps NULL consent columns (byte-for-byte unchanged)', async () => {
    const cap: {insertParams?: unknown[]} = {};
    const {svc} = mk(cap);
    const res = await svc.create('c1', dto()); // no autoDispatch, no consent fields
    expect(res.booking.status).toBe('PENDING_OPS');
    expect(cap.insertParams?.[I_LOC_AT]).toBeNull();
    expect(cap.insertParams?.[I_LOC_VER]).toBeNull();
    expect(cap.insertParams?.[I_TERMS_AT]).toBeNull();
    expect(cap.insertParams?.[I_TERMS_VER]).toBeNull();
  });

  it('auto path with only ONE of the two consents still fails closed', async () => {
    const {svc} = mk({});
    await expect(svc.create('c1', dto({location_consent: true}), {autoDispatch: true}))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create('c1', dto({terms_accepted: true}), {autoDispatch: true}))
      .rejects.toBeInstanceOf(BadRequestException);
  });
});
