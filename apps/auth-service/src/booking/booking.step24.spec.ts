import {BadRequestException, NotFoundException} from '@nestjs/common';
import {BookingService} from './booking.service';
import type {DatabaseService} from '../database/database.service';
import type {PricingService} from './pricing.service';
import type {ConfigService} from '@nestjs/config';

// ── Lead-time exemption ─────────────────────────────────────────────────────────
function mkCreate() {
  const dbQOne = jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
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
    // LM-B7 — auto path affordability soft-check.
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
  return {svc};
}
function soonDto(extra: Record<string, unknown> = {}) {
  return {
    type: 'transfer', region: 'AE', region_label: 'Dubai', service: 'secure_transfer',
    booking_mode: 'now', start_time: new Date(Date.now() + 30 * 60_000).toISOString(), // 30 min out
    pickup: {address: 'X', latitude: 25, longitude: 55}, add_ons: [],
    passengers: 1, cpo_count: 1, vehicle_count: 1, driver_only: false,
    payment_method: 'card', duration_hours: 4,
    location_consent: true, terms_accepted: true, ...extra,
  } as never;
}

describe('BookingService.create — Step 24 on-demand lead-time exemption', () => {
  it('on-demand auto ("now") skips the 3-hour lead-time gate', async () => {
    const {svc} = mkCreate();
    const res = await svc.create('c1', soonDto({booking_mode: 'now'}), {autoDispatch: true});
    // Ops-gated auto dispatch: the auto booking now submits to the ops board.
    expect(res.booking.status).toBe('PENDING_OPS');
  });

  it('a SCHEDULED auto ("later") request still honors the lead-time gate', async () => {
    const {svc} = mkCreate();
    await expect(svc.create('c1', soonDto({booking_mode: 'later'}), {autoDispatch: true}))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('a legacy booking still honors the lead-time gate', async () => {
    const {svc} = mkCreate();
    await expect(svc.create('c1', soonDto())).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ── Ratings loop ────────────────────────────────────────────────────────────────
function mkRating(opts: {
  ratedRow?: {assigned_provider_user_id: string | null} | null; // RETURNING from the rating UPDATE
  current?: {status: string; rating: number | null; client_id: string} | null;
  agencyRating?: string | null;
}) {
  const txQ = jest.fn().mockImplementation((sql: string) => {
    if (/UPDATE lite_bookings SET rating/.test(sql)) {
      return Promise.resolve(opts.ratedRow ? [opts.ratedRow] : []);
    }
    return Promise.resolve([]);
  });
  const txQOne = jest.fn().mockImplementation((sql: string) => {
    if (/SELECT status, rating, client_id FROM lite_bookings/.test(sql)) {
      return Promise.resolve(opts.current ?? null);
    }
    return Promise.resolve(null);
  });
  // The agency-average recompute runs POST-COMMIT on the outer db.qOne (not the txn).
  const dbQOne = jest.fn().mockImplementation((sql: string) =>
    /UPDATE agents SET rating/.test(sql)
      ? Promise.resolve({rating: opts.agencyRating ?? null})
      : Promise.resolve(null));
  const db = {
    q: jest.fn(), qOne: dbQOne,
    withTransaction: (fn: (t: unknown) => unknown) => fn({q: txQ, qOne: txQOne}),
  } as unknown as DatabaseService;
  const svc = new BookingService(
    db, {} as never, {assert: jest.fn()} as never, {} as never, {} as never,
    {} as never, {} as never, {} as never, {get: () => undefined} as unknown as ConfigService,
  );
  return {svc, txQ, txQOne, dbQOne};
}

describe('BookingService.submitRating — Step 24 ratings loop', () => {
  it('writes the rating + recomputes the agency rolling average (ranking trust signal)', async () => {
    const {svc, dbQOne} = mkRating({
      ratedRow: {assigned_provider_user_id: 'agency-A'}, agencyRating: '4.50',
    });
    const out = await svc.submitRating('c1', 'bk1', {stars: 5});
    expect(out).toEqual({id: 'bk1', rating: 5, agency_rating: 4.5});
    // Recompute runs post-commit on the outer connection (reads the committed set).
    expect(dbQOne).toHaveBeenCalledWith(expect.stringMatching(/UPDATE agents SET rating/), ['agency-A']);
  });

  it('404s for a booking that is not the caller\'s', async () => {
    const {svc} = mkRating({ratedRow: null, current: {status: 'COMPLETED', rating: null, client_id: 'someone-else'}});
    await expect(svc.submitRating('intruder', 'bk1', {stars: 4})).rejects.toBeInstanceOf(NotFoundException);
  });

  it('400s when the booking is not COMPLETED', async () => {
    const {svc} = mkRating({ratedRow: null, current: {status: 'LIVE', rating: null, client_id: 'c1'}});
    await expect(svc.submitRating('c1', 'bk1', {stars: 4})).rejects.toBeInstanceOf(BadRequestException);
  });

  it('is idempotent — a second rating is a no-op echoing the stored value', async () => {
    const {svc, dbQOne} = mkRating({ratedRow: null, current: {status: 'COMPLETED', rating: 3, client_id: 'c1'}});
    const out = await svc.submitRating('c1', 'bk1', {stars: 5});
    expect(out).toEqual({id: 'bk1', rating: 3, agency_rating: null});
    // Must NOT recompute the agency average on the idempotent path.
    expect(dbQOne).not.toHaveBeenCalledWith(expect.stringMatching(/UPDATE agents SET rating/), expect.anything());
  });
});
