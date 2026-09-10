import {BadRequestException} from '@nestjs/common';
import {ClientDispatchController} from './client-dispatch.controller';
import {BookingService} from '../booking/booking.service';
import type {DatabaseService} from '../database/database.service';
import type {PricingService} from '../booking/pricing.service';
import type {ConfigService} from '@nestjs/config';
import type {DispatchKillswitchService} from '../ops/dispatch-killswitch.service';

/**
 * Step 22 — end-to-end plumbing: the consent fields in the request body must flow
 * through ClientDispatchController → BookingService.create()'s lawful-basis gate.
 * Uses a REAL BookingService (mocked db) so the gate actually fires, not a stub.
 *
 * Ops-gated auto dispatch: the request path now ONLY creates the PENDING_OPS auto
 * booking — it must never touch the matchmaker (no dispatch.start, no rollback);
 * ops approval triggers the cascade via the `dispatch:ops-approved` subscriber.
 */
function harness(flagOn: boolean) {
  const dbQOne = jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
    if (/INSERT INTO lite_bookings/.test(sql)) {
      return Promise.resolve({
        // Echo the bound status/dispatch_mode so the assertion sees what create() persisted.
        id: 'bk1', client_id: 'c1', status: (params as unknown[])?.[24] ?? 'PENDING_OPS',
        dispatch_mode: (params as unknown[])?.[25] ?? null,
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
    return Promise.resolve(null); // active-booking guard etc.
  });
  const db = {qOne: dbQOne, q: jest.fn().mockResolvedValue([])} as unknown as DatabaseService;
  const pricing = {calculate: jest.fn().mockReturnValue({
    rate_eur_per_hour: 25, rate_aed_per_hour: 91, total_eur: 100, total_aed: 367,
  })} as unknown as PricingService;
  const bookingCfg = {get: () => undefined} as unknown as ConfigService;
  const family = {resolvePayer: jest.fn().mockResolvedValue({payerId: 'c1', familyRowId: null, spendLimit: null, spent: 0})};
  const bookings = new BookingService(
    db, pricing, {assert: jest.fn()} as never, {} as never, {} as never,
    {} as never, family as never, {} as never, bookingCfg,
  );
  const config = {get: jest.fn().mockReturnValue(flagOn)} as unknown as ConfigService;
  // Step 26 — the controller gates on the runtime kill switch (which itself folds in
  // the env flag); mirror flagOn here.
  const killswitch = {isAutoDispatchEnabled: jest.fn().mockResolvedValue(flagOn)} as unknown as DispatchKillswitchService;
  const ctrl = new ClientDispatchController(bookings, config, killswitch);
  return {ctrl, dbQOne};
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
const consented = {
  location_consent: true, terms_accepted: true,
  location_consent_version: 'v1', terms_accepted_version: 'v1',
};
const user = {sub: 'c1'} as never;

const insertCalls = (dbQOne: jest.Mock) =>
  dbQOne.mock.calls.filter(c => /INSERT INTO lite_bookings/.test(c[0] as string));

describe('ClientDispatchController.request — ops-gated submit (+ Step 22 consent plumbing)', () => {
  it('400s auto_dispatch_disabled when the flag is off (no booking created)', async () => {
    const {ctrl, dbQOne} = harness(false);
    await expect(ctrl.request(dto(consented), user))
      .rejects.toThrow('auto_dispatch_disabled');
    expect(insertCalls(dbQOne)).toHaveLength(0);
  });

  it('creates the auto booking as PENDING_OPS and does NOT start the matchmaker ("now")', async () => {
    const {ctrl, dbQOne} = harness(true);
    const res = await ctrl.request(dto(consented), user);
    expect(res.booking.status).toBe('PENDING_OPS');
    expect(res.booking.dispatch_mode).toBe('auto');
    // No DRAFT/OPS_APPROVED → DISPATCHING flip may ever run on the request path.
    const flips = dbQOne.mock.calls.filter(c => /DISPATCHING/.test(c[0] as string));
    expect(flips).toHaveLength(0);
  });

  it('a SCHEDULED ("later") request also lands PENDING_OPS — approval + cron dispatch it, not the request', async () => {
    const {ctrl} = harness(true);
    const res = await ctrl.request(dto({...consented, booking_mode: 'later'}), user);
    expect(res.booking.status).toBe('PENDING_OPS');
    expect(res.booking.dispatch_mode).toBe('auto');
  });

  it('WITHOUT consent the real create() gate rejects consent_required (no booking persisted)', async () => {
    const {ctrl, dbQOne} = harness(true);
    await expect(ctrl.request(dto(), user)).rejects.toBeInstanceOf(BadRequestException);
    expect(insertCalls(dbQOne)).toHaveLength(0);
  });
});
