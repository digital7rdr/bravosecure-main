import {BookingService} from './booking.service';
import type {DatabaseService} from '../database/database.service';
import type {ConfigService} from '@nestjs/config';

/** Build a BookingService whose db.qOne/db.q (and tx) are routed by SQL regex. */
function mk(opts: {
  qOneRoutes?: Array<[RegExp, unknown]>;
  qRoutes?: Array<[RegExp, unknown]>;
  cfg?: Record<string, unknown>;
}) {
  const dbQOne = jest.fn().mockImplementation((sql: string) => {
    for (const [re, val] of opts.qOneRoutes ?? []) if (re.test(sql)) return Promise.resolve(val);
    return Promise.resolve(null);
  });
  const dbQ = jest.fn().mockImplementation((sql: string) => {
    for (const [re, val] of opts.qRoutes ?? []) if (re.test(sql)) return Promise.resolve(val);
    return Promise.resolve([]);
  });
  const db = {
    qOne: dbQOne, q: dbQ,
    withTransaction: (fn: (t: unknown) => unknown) => fn({q: dbQ, qOne: dbQOne}),
  } as unknown as DatabaseService;
  const config = {get: (k: string) => (opts.cfg ?? {})[k]} as unknown as ConfigService;
  const svc = new BookingService(
    db, {} as never, {assert: jest.fn()} as never, {} as never, {} as never,
    {} as never, {} as never, {} as never, config,
  );
  return {svc, db, dbQ, dbQOne};
}

const FULL_ROW = {
  id: 'b1', client_id: 'c1', region_code: 'AE', region_label: 'Dubai', service: 'CP',
  pickup_address: 'X', pickup_lat: 25, pickup_lng: 55, dropoff_address: null,
  dropoff_lat: null, dropoff_lng: null, pickup_time: '2026-06-22T00:00:00Z', passengers: 1,
  cpo_count: 1, vehicle_count: 0, driver_only: false, add_ons: [], total_eur: 800,
  duration_hours: 3, total_aed: 2900, conversation_id: null, created_at: '2026-06-22T00:00:00Z',
};

describe('BookingService — Step 16 identity handshake + fallback', () => {
  const SECRET = {'jwt.actionSecret': 'sek'};

  describe('getVerifyCode', () => {
    it('returns a 6-digit rotating code + the lead identity when crew is assigned', async () => {
      const {svc} = mk({
        cfg: SECRET,
        qOneRoutes: [
          [/SELECT id FROM lite_bookings/, {id: 'b1'}],
          [/mc\.is_lead = TRUE/, {agent_id: 'lead-1', call_sign: 'ALPHA-1', display_name: 'Jane Doe'}],
        ],
      });
      const res = await svc.getVerifyCode('c1', 'b1');
      expect(res.code).toMatch(/^\d{6}$/);
      expect(typeof res.rotates_at).toBe('string');
      expect(res.lead).toEqual({display_name: 'Jane Doe', call_sign: 'ALPHA-1'});
    });

    it('400s before crew is assigned (no guard to verify yet)', async () => {
      const {svc} = mk({cfg: SECRET, qOneRoutes: [[/SELECT id FROM lite_bookings/, {id: 'b1'}]]});
      await expect(svc.getVerifyCode('c1', 'b1')).rejects.toThrow('no_crew_assigned');
    });

    it('404s for a booking that is not the client\'s', async () => {
      const {svc} = mk({cfg: SECRET, qOneRoutes: []}); // ownership SELECT returns null
      await expect(svc.getVerifyCode('intruder', 'b1')).rejects.toThrow('Booking not found');
    });
  });

  describe('markNotMyGuard', () => {
    it('stamps not_my_guard_at when the caller owns the booking', async () => {
      const {svc, dbQ} = mk({qRoutes: [[/UPDATE lite_bookings SET not_my_guard_at/, [{id: 'b1'}]]]});
      await expect(svc.markNotMyGuard('c1', 'b1')).resolves.toBeUndefined();
      expect(dbQ).toHaveBeenCalledWith(expect.stringMatching(/UPDATE lite_bookings SET not_my_guard_at/), ['b1', 'c1']);
    });

    it('404s when the booking is not the caller\'s (RETURNING empty)', async () => {
      const {svc} = mk({qRoutes: [[/UPDATE lite_bookings SET not_my_guard_at/, []]]});
      await expect(svc.markNotMyGuard('intruder', 'b1')).rejects.toThrow('Booking not found');
    });
  });

  describe('escalate', () => {
    it('returns the hotline + records an escalation audit row (no status flip)', async () => {
      const {svc, dbQ} = mk({
        cfg: {'booking.hotlineE164': '+971500000000'},
        qOneRoutes: [[/SELECT status FROM lite_bookings/, {status: 'NO_PROVIDER'}]],
      });
      const res = await svc.escalate('c1', 'b1');
      expect(res).toEqual({ok: true, hotline_e164: '+971500000000'});
      expect(dbQ).toHaveBeenCalledWith(
        expect.stringMatching(/INSERT INTO lite_booking_audit/),
        expect.arrayContaining(['b1', 'NO_PROVIDER', 'NO_PROVIDER', 'c1', 'CLIENT']),
      );
    });

    it('404s for a non-owner', async () => {
      const {svc} = mk({qOneRoutes: []});
      await expect(svc.escalate('intruder', 'b1')).rejects.toThrow('Booking not found');
    });
  });

  describe('NO_PROVIDER fallback block (getById)', () => {
    it('attaches the safety fallback only on a NO_PROVIDER booking', async () => {
      const {svc} = mk({
        cfg: {'booking.hotlineE164': '+9710'},
        qOneRoutes: [[/SELECT \* FROM lite_bookings WHERE id = \$1 AND client_id/, {...FULL_ROW, status: 'NO_PROVIDER'}]],
      });
      const res = await svc.getById('c1', 'b1');
      expect(res.no_provider_fallback).toEqual({hotline_e164: '+9710', can_widen: true, can_escalate: true});
    });

    it('omits the fallback on a non-NO_PROVIDER booking (legacy shape unchanged)', async () => {
      const {svc} = mk({
        cfg: {'booking.hotlineE164': '+9710'},
        qOneRoutes: [[/SELECT \* FROM lite_bookings WHERE id = \$1 AND client_id/, {...FULL_ROW, status: 'CONFIRMED'}]],
      });
      const res = await svc.getById('c1', 'b1');
      expect(res.no_provider_fallback).toBeUndefined();
    });
  });
});
