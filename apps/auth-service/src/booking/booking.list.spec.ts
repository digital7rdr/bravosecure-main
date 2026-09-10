/**
 * `GET /bookings` — the values this endpoint hands to Postgres.
 *
 * `BookingService.list` had NO direct test of any kind before this file, which
 * is a large part of why B-388 shipped: the whole C-6 `{status, page}` feature
 * was covered only transitively, and the one defect that mattered lived in the
 * SQL text rather than in the TypeScript around it.
 *
 * The shape of every bug found here is the same: an untrusted query-string
 * value reaches Postgres's TYPE layer and is rejected at bind/execute time.
 * `DatabaseService` is mocked in this service's whole suite, so nothing else in
 * it can see that class of failure — the bind values themselves are the only
 * thing a unit test can honestly assert. So that is what this file asserts.
 */
import {BookingService} from './booking.service';
import type {DatabaseService} from '../database/database.service';
import type {PricingService} from './pricing.service';
import type {ConfigService} from '@nestjs/config';

/** Captures the parameter array bound to the `SELECT * FROM lite_bookings` list query. */
function mk() {
  const cap: {listParams?: unknown[]} = {};
  const q = jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
    if (/SELECT \* FROM lite_bookings/.test(sql)) {cap.listParams = params;}
    return Promise.resolve([]);
  });
  const db = {q, qOne: jest.fn().mockResolvedValue(null)} as unknown as DatabaseService;
  const svc = new BookingService(
    db, {} as unknown as PricingService, {} as never, {} as never, {} as never,
    {} as never, {} as never, {} as never, {get: () => undefined} as unknown as ConfigService,
  );
  return {svc, cap};
}

// [clientId, status, offset]
const I_STATUS = 1;
const I_OFFSET = 2;

describe('BookingService.list — the values bound to Postgres', () => {
  it('binds a null status when none is asked for (filter is dropped)', async () => {
    const {svc, cap} = mk();
    await svc.list('c1');
    expect(cap.listParams?.[I_STATUS]).toBeNull();
    expect(cap.listParams?.[I_OFFSET]).toBe(0);
  });

  it('binds a real enum label through unchanged', async () => {
    const {svc, cap} = mk();
    await svc.list('c1', {status: 'LIVE'});
    expect(cap.listParams?.[I_STATUS]).toBe('LIVE');
  });

  it('binds null for a value that is not a lite_booking_status', async () => {
    // KNOWN, deliberate: an unknown status is coerced to null rather than 400d,
    // so a typo returns the UNFILTERED list. Documented in enumParamCast.spec.ts.
    // Pinned here so the coercion cannot silently become a raw interpolation.
    const {svc, cap} = mk();
    await svc.list('c1', {status: 'REJECTED'});
    expect(cap.listParams?.[I_STATUS]).toBeNull();
  });

  /**
   * B-388b — the OFFSET must stay inside bigint, and inside JS's non-exponential
   * range. `page` arrives as a query string and the controller admits anything
   * matching /^\d+$/, so both of these are one request away for any authenticated
   * client. Verified against the live database:
   *
   *   OFFSET '50000000000000000000' -> ERROR 22003: value out of range for type bigint
   *   OFFSET '5e+21'                -> ERROR 22P02: invalid input syntax for type bigint
   *
   * The second one is the nastier spelling: node-postgres binds a JS number via
   * `toString()`, and `Number.prototype.toString` switches to exponent form at
   * 1e21 — so `?page=20000000000000000000` is sent to Postgres as the literal
   * text "5e+21". Neither can be caught by asserting the SQL; only the bound
   * value shows it.
   */
  it('clamps a huge page so the OFFSET stays a valid bigint', async () => {
    const {svc, cap} = mk();
    await svc.list('c1', {page: 20_000_000_000_000_000_000});
    const offset = cap.listParams?.[I_OFFSET] as number;
    expect(Number.isSafeInteger(offset)).toBe(true);
    expect(offset).toBeLessThanOrEqual(9_223_372_036_854_775_807);
    // The exponent-form trap: this is what actually reaches the wire.
    expect(String(offset)).toMatch(/^\d+$/);
  });

  it('clamps a page that only overflows bigint, not JS notation', async () => {
    const {svc, cap} = mk();
    await svc.list('c1', {page: 1e18});
    expect(BigInt(cap.listParams?.[I_OFFSET] as number))
      .toBeLessThanOrEqual(9_223_372_036_854_775_807n);
  });

  it('leaves an ordinary page arithmetic alone', async () => {
    const {svc, cap} = mk();
    await svc.list('c1', {page: 3});
    expect(cap.listParams?.[I_OFFSET]).toBe(150);
  });

  it('floors a negative page to 0 rather than binding a negative OFFSET', async () => {
    const {svc, cap} = mk();
    await svc.list('c1', {page: -5});
    expect(cap.listParams?.[I_OFFSET]).toBe(0);
  });
});
