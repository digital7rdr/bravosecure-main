import {BadRequestException, NotFoundException, ForbiddenException} from '@nestjs/common';
import {DispatchService, resolveTrustMockedLocation, mockedLocationClause,
        resolveDisableRegionFilter, regionScopeClause, eligibilityClause} from './dispatch.service';
import {BookingStateMachine} from '../booking/state-machine.service';
import type {DatabaseService} from '../database/database.service';
import type {OpsAuditService} from '../ops/ops-audit.service';
import type {BookingPushBridge} from '../ops/booking-push-bridge.service';
import type {WalletService} from '../wallet/wallet.service';

const fsm = new BookingStateMachine(); // real FSM (pure logic)
const audit = {record: jest.fn()};
const push = {dispatchOffer: jest.fn(), providerAccepted: jest.fn(), noProvider: jest.fn()};
// refundEscrowHold: noProvider's R12 refund of a persisted HELD hold (relisted
// bookings) — idempotent no-op for the never-charged case these tests model.
const wallet = {holdToEscrow: jest.fn(), refundEscrowHold: jest.fn()};
const db = {q: jest.fn(), qOne: jest.fn(), withTransaction: jest.fn()};

function service(): DispatchService {
  return new DispatchService(
    db as unknown as DatabaseService, fsm,
    audit as unknown as OpsAuditService,
    push as unknown as BookingPushBridge,
    wallet as unknown as WalletService,
  );
}

interface Wire {
  bookingLock?: {status: string; dispatch_mode: string | null} | null; // start: SELECT status,dispatch_mode FOR UPDATE
  bookingCtx?: {status: string; region_code?: string; cpo_count?: number; requirements?: unknown; armed_required?: boolean} | null;
  bookingStatusLock?: {status: string; client_id?: string} | null;     // noProvider/cancel: SELECT status[, client_id] FOR UPDATE
  offerLock?: {booking_id: string; status: string; provider_user_id: string} | null; // reject: SELECT ... FOR UPDATE
  offerCount?: number;
  ranking?: Array<{user_id: string; distance_km: string} | null>;      // FIFO ranking results
  insertThrowsUnique?: boolean[];                                       // FIFO: each INSERT throws 23505?
  insertConstraints?: Array<string | undefined>;                       // FIFO: constraint name on the thrown 23505
  expireReturns?: Array<{booking_id: string; provider_user_id?: string}>; // expire UPDATE RETURNING
  updateBookingRows?: number;
  rejectRows?: number;
}

// Wire db.qOne/db.q to dispatch by SQL content, and capture INSERT params.
function wire(w: Wire): {inserts: unknown[][]} {
  let rankIdx = 0;
  let insertIdx = 0;
  const inserts: unknown[][] = [];
  db.qOne.mockImplementation((sql: string) => {
    if (/FROM lite_bookings WHERE id = \$1 FOR UPDATE/.test(sql) && /dispatch_mode/.test(sql)) {
      return Promise.resolve(w.bookingLock ?? null);
    }
    if (/SELECT status, region_code, cpo_count/.test(sql)) return Promise.resolve(w.bookingCtx ?? null);
    if (/SELECT status(?:, client_id)?(?:, region_code)? FROM lite_bookings WHERE id = \$1 FOR UPDATE/.test(sql)) {
      // Serves cancel/noProvider (explicit bookingStatusLock) AND offerNext's
      // pre-INSERT re-check (defaults to the cascade's bookingCtx status).
      return Promise.resolve(w.bookingStatusLock ?? (w.bookingCtx ? {status: w.bookingCtx.status} : null));
    }
    if (/FROM dispatch_offers WHERE id = \$1 FOR UPDATE/.test(sql)) return Promise.resolve(w.offerLock ?? null);
    if (/count\(\*\)::text/.test(sql)) return Promise.resolve({n: String(w.offerCount ?? 0)});
    if (/is_eligible_for_dispatch/.test(sql)) return Promise.resolve(w.ranking?.[rankIdx++] ?? null);
    return Promise.resolve(null);
  });
  db.q.mockImplementation((sql: string, params: unknown[]) => {
    if (/INSERT INTO dispatch_offers/.test(sql)) {
      inserts.push(params);
      const i = insertIdx++;
      return (w.insertThrowsUnique?.[i] ?? false)
        ? Promise.reject({code: '23505', constraint: w.insertConstraints?.[i]})
        : Promise.resolve([]);
    }
    if (/UPDATE lite_bookings SET status = 'DISPATCHING'/.test(sql)
        || /UPDATE lite_bookings SET status = 'NO_PROVIDER'/.test(sql)
        || /UPDATE lite_bookings SET status = 'CANCELLED'/.test(sql)) {
      return Promise.resolve(new Array(w.updateBookingRows ?? 1).fill({id: 'b1'}));
    }
    if (/UPDATE dispatch_offers SET status = 'REJECTED'/.test(sql)) {
      return Promise.resolve(new Array(w.rejectRows ?? 1).fill({id: 'o1'}));
    }
    if (/UPDATE dispatch_offers SET status = 'EXPIRED'/.test(sql)) return Promise.resolve(w.expireReturns ?? [{booking_id: 'b1'}]);
    if (/UPDATE dispatch_offers SET status = 'SUPERSEDED'/.test(sql)) return Promise.resolve([]);
    return Promise.resolve([]);
  });
  return {inserts};
}

describe('DISPATCH_TRUST_MOCKED_LOCATION gating (staging-only anti-fraud relaxation)', () => {
  it('resolveTrustMockedLocation: ON only when flag==="true" AND not production', () => {
    expect(resolveTrustMockedLocation('true', 'staging')).toBe(true);
    expect(resolveTrustMockedLocation('true', 'development')).toBe(true);
    expect(resolveTrustMockedLocation('true', undefined)).toBe(true);
    // Production hard-block (defense in depth behind main.ts fail-fast guard).
    expect(resolveTrustMockedLocation('true', 'production')).toBe(false);
    // Anything other than the exact string 'true' is OFF.
    expect(resolveTrustMockedLocation('1', 'staging')).toBe(false);
    expect(resolveTrustMockedLocation('TRUE', 'staging')).toBe(false);
    expect(resolveTrustMockedLocation(undefined, 'staging')).toBe(false);
  });

  it('mockedLocationClause: keeps the anti-fraud predicate OFF by default, drops it only when trusted', () => {
    expect(mockedLocationClause(false)).toBe('AND a.last_location_mocked = FALSE');
    expect(mockedLocationClause(true)).toBe('');
  });
});

describe('DISPATCH_DISABLE_REGION_FILTER gating (staging-only cross-region testing)', () => {
  it('resolveDisableRegionFilter: ON only when flag==="true" AND not production', () => {
    expect(resolveDisableRegionFilter('true', 'staging')).toBe(true);
    expect(resolveDisableRegionFilter('true', 'development')).toBe(true);
    expect(resolveDisableRegionFilter('true', undefined)).toBe(true);
    // Production hard-block (defense in depth behind main.ts fail-fast guard).
    expect(resolveDisableRegionFilter('true', 'production')).toBe(false);
    expect(resolveDisableRegionFilter('1', 'staging')).toBe(false);
    expect(resolveDisableRegionFilter(undefined, 'staging')).toBe(false);
  });

  it('regionScopeClause / eligibilityClause: region gates ON by default; when disabled, relax but KEEP $3/$4 referenced', () => {
    expect(regionScopeClause(false)).toBe('AND a.region_code = $3');
    expect(eligibilityClause(false)).toBe('AND public.is_eligible_for_dispatch(a.user_id, $3, $4::jsonb)');
    // Regression guard (staging dispatch outage 2026-07-10): the bypass clauses
    // MUST still reference their params or Postgres throws "could not determine
    // data type of parameter $3" and the entire ranking fails → zero offers.
    expect(regionScopeClause(true)).toContain('$3');
    expect(eligibilityClause(true)).toContain('$4');
    // ...and both must stay always-true (no real filtering).
    expect(regionScopeClause(true)).toBe('AND ($3::text IS NOT NULL OR $3::text IS NULL)');
    expect(eligibilityClause(true)).toBe('AND ($4::jsonb IS NOT NULL OR $4::jsonb IS NULL)');
  });
});

describe('DispatchService', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    audit.record.mockResolvedValue(undefined);
    // Pushes are fire-and-forget (.catch()ed) — must return a promise.
    push.dispatchOffer.mockResolvedValue(undefined);
    push.providerAccepted.mockResolvedValue(undefined);
    push.noProvider.mockResolvedValue(undefined);
    wallet.holdToEscrow.mockResolvedValue({currency: 'AED'});
    wallet.refundEscrowHold.mockResolvedValue({refunded: false, credits: 0});
    db.withTransaction.mockImplementation((fn: (tx: unknown) => unknown) => fn({q: db.q, qOne: db.qOne}));
  });

  describe('start', () => {
    it('DRAFT auto booking → DISPATCHING and offers the nearest eligible agency at rank 1', async () => {
      const {inserts} = wire({
        bookingLock: {status: 'DRAFT', dispatch_mode: 'auto'},
        bookingCtx: {status: 'DISPATCHING', region_code: 'AE', cpo_count: 1, requirements: {}, armed_required: false},
        offerCount: 0,
        ranking: [{user_id: 'agency-A', distance_km: '1.20'}],
      });
      await service().start('b1');
      expect(inserts).toEqual([['b1', 'agency-A', 1, '1.20', 30]]);
      // Step 23 — the offered agency's offers_received counter is bumped in the same txn.
      expect(db.q).toHaveBeenCalledWith(
        expect.stringMatching(/UPDATE agents SET offers_received = offers_received \+ 1/),
        ['agency-A'],
      );
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({action: 'dispatch.start'}));
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
        action: 'dispatch.offer',
        metadata: expect.objectContaining({provider_user_id: 'agency-A', rank: 1}),
      }));
    });

    it('rejects a non-auto booking', async () => {
      wire({bookingLock: {status: 'DRAFT', dispatch_mode: null}});
      await expect(service().start('b1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws NotFound when the booking is missing', async () => {
      wire({bookingLock: null});
      await expect(service().start('missing')).rejects.toBeInstanceOf(NotFoundException);
    });

    // Ops-gated auto dispatch: approval parks the booking OPS_APPROVED; the
    // ops-approved subscriber / scheduled cron then start the search from there.
    it('OPS_APPROVED auto booking → DISPATCHING (ops-gated source) and offers rank 1', async () => {
      const {inserts} = wire({
        bookingLock: {status: 'OPS_APPROVED', dispatch_mode: 'auto'},
        bookingCtx: {status: 'DISPATCHING', region_code: 'AE', cpo_count: 1, requirements: {}, armed_required: false},
        offerCount: 0,
        ranking: [{user_id: 'agency-A', distance_km: '1.20'}],
      });
      await service().start('b1');
      // The status-guarded flip binds the OPS_APPROVED snapshot — the race guard.
      expect(db.q).toHaveBeenCalledWith(
        expect.stringMatching(/UPDATE lite_bookings SET status = 'DISPATCHING'/),
        ['b1', 'OPS_APPROVED'],
      );
      expect(inserts).toEqual([['b1', 'agency-A', 1, '1.20', 30]]);
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({action: 'dispatch.start'}));
    });

    it('rejects an unapproved PENDING_OPS source — ops approval is the gate', async () => {
      wire({bookingLock: {status: 'PENDING_OPS', dispatch_mode: 'auto'}});
      await expect(service().start('b1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects a CONFIRMED source — start() is not a re-dispatch backdoor', async () => {
      wire({bookingLock: {status: 'CONFIRMED', dispatch_mode: 'auto'}});
      await expect(service().start('b1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('409s when the conditional flip loses the race (0 rows) from OPS_APPROVED', async () => {
      wire({
        bookingLock: {status: 'OPS_APPROVED', dispatch_mode: 'auto'},
        updateBookingRows: 0,
      });
      await expect(service().start('b1')).rejects.toThrow('booking_state_changed_concurrently');
    });
  });

  describe('offerNext cascade', () => {
    it('MAX_OFFERS reached → NO_PROVIDER (no further offer)', async () => {
      const {inserts} = wire({
        bookingCtx: {status: 'DISPATCHING', region_code: 'AE', cpo_count: 1, requirements: {}, armed_required: false},
        offerCount: 8,
        bookingStatusLock: {status: 'DISPATCHING'},
      });
      await service().offerNext('b1');
      expect(inserts).toHaveLength(0);
      expect(db.q).toHaveBeenCalledWith(expect.stringMatching(/UPDATE lite_bookings SET status = 'NO_PROVIDER'/), ['b1']);
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({action: 'dispatch.no_provider'}));
    });

    it('empty / zero-eligible pool → NO_PROVIDER', async () => {
      wire({
        bookingCtx: {status: 'DISPATCHING', region_code: 'AE', cpo_count: 1, requirements: {}, armed_required: false},
        offerCount: 0, ranking: [null], bookingStatusLock: {status: 'DISPATCHING'},
      });
      await service().offerNext('b1');
      expect(db.q).toHaveBeenCalledWith(expect.stringMatching(/SET status = 'NO_PROVIDER'/), ['b1']);
    });

    it('stops cascading once the booking is no longer DISPATCHING (accepted/cancelled elsewhere)', async () => {
      const {inserts} = wire({bookingCtx: {status: 'CONFIRMED'}});
      await service().offerNext('b1');
      expect(inserts).toHaveLength(0);
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('advances to the next agency (never 500) when the per-provider index rejects the INSERT', async () => {
      const {inserts} = wire({
        bookingCtx: {status: 'DISPATCHING', region_code: 'AE', cpo_count: 1, requirements: {}, armed_required: false},
        offerCount: 0,
        ranking: [{user_id: 'agency-A', distance_km: '1'}, {user_id: 'agency-B', distance_km: '2'}],
        insertThrowsUnique: [true, false], // A collides (already holds a live offer elsewhere), B succeeds
        insertConstraints: ['dispatch_offers_one_live_per_provider', undefined],
      });
      await service().offerNext('b1');
      expect(inserts).toHaveLength(2);
      expect(inserts[1][1]).toBe('agency-B');
    });

    it('stops (no second offer) when the per-booking index rejects the INSERT — concurrent cascade won', async () => {
      const {inserts} = wire({
        bookingCtx: {status: 'DISPATCHING', region_code: 'AE', cpo_count: 1, requirements: {}, armed_required: false},
        offerCount: 0,
        ranking: [{user_id: 'agency-A', distance_km: '1'}, {user_id: 'agency-B', distance_km: '2'}],
        insertThrowsUnique: [true], // a concurrent offerNext already placed THIS booking's live offer
        insertConstraints: ['dispatch_offers_one_live_per_booking'],
      });
      await service().offerNext('b1');
      expect(inserts).toHaveLength(1);              // tried once, did NOT cascade to agency-B
      expect(audit.record).not.toHaveBeenCalled();  // no offer recorded by this losing cascade
    });

    it('does NOT strand a phantom offer when the booking is accepted between the ranking read and the INSERT', async () => {
      const {inserts} = wire({
        bookingCtx: {status: 'DISPATCHING', region_code: 'AE', cpo_count: 1, requirements: {}, armed_required: false},
        bookingStatusLock: {status: 'CONFIRMED'}, // a concurrent accept committed before our locked re-check
        offerCount: 0,
        ranking: [{user_id: 'agency-A', distance_km: '1'}],
      });
      await service().offerNext('b1');
      expect(inserts).toHaveLength(0);                  // the FOR UPDATE re-check blocked the INSERT
      expect(audit.record).not.toHaveBeenCalled();      // no phantom dispatch.offer
      expect(push.dispatchOffer).not.toHaveBeenCalled(); // no phantom offer card pushed
    });
  });

  describe('reject', () => {
    it('marks REJECTED then cascades to the next agency', async () => {
      const {inserts} = wire({
        offerLock: {booking_id: 'b1', status: 'OFFERED', provider_user_id: 'agency-A'},
        bookingCtx: {status: 'DISPATCHING', region_code: 'AE', cpo_count: 1, requirements: {}, armed_required: false},
        offerCount: 1,
        ranking: [{user_id: 'agency-B', distance_km: '3'}],
      });
      await service().reject('o1', 'agency-A', 'too far');
      expect(db.q).toHaveBeenCalledWith(
        expect.stringMatching(/UPDATE dispatch_offers SET status = 'REJECTED'/),
        expect.arrayContaining(['o1', 'agency-A']),
      );
      expect(inserts[0][1]).toBe('agency-B');
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({action: 'dispatch.reject'}));
    });

    it('Step 23 — bumps offers_rejected + recomputes acceptance_rate + arms cooldown on the rejecter', async () => {
      wire({
        offerLock: {booking_id: 'b1', status: 'OFFERED', provider_user_id: 'agency-A'},
        bookingCtx: {status: 'CONFIRMED'}, // stop the cascade after the reject
      });
      await service().reject('o1', 'agency-A', 'too far');
      const acctCall = db.q.mock.calls.find(([sql]: [string]) =>
        /UPDATE agents\s+SET offers_rejected = offers_rejected \+ 1/.test(sql));
      expect(acctCall).toBeDefined();
      expect(acctCall?.[0]).toMatch(/acceptance_rate = ROUND/);
      expect(acctCall?.[0]).toMatch(/cooldown_until = CASE/);
      expect(acctCall?.[1]).toEqual(['agency-A']);
    });

    it('409 on a non-OFFERED offer', async () => {
      wire({offerLock: {booking_id: 'b1', status: 'EXPIRED', provider_user_id: 'agency-A'}});
      await expect(service().reject('o1', 'agency-A')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('404 when the offer does not exist', async () => {
      wire({offerLock: null});
      await expect(service().reject('missing', 'agency-A')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('403 (org_scope_violation) when the caller is not the offer owner — checked before status (IDOR)', async () => {
      wire({offerLock: {booking_id: 'b1', status: 'OFFERED', provider_user_id: 'agency-A'}});
      await expect(service().reject('o1', 'agency-OTHER')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('redacts PII (email/phone) from the reject reason', async () => {
      wire({
        offerLock: {booking_id: 'b1', status: 'OFFERED', provider_user_id: 'agency-A'},
        bookingCtx: {status: 'CONFIRMED'}, // stop the cascade after the reject
      });
      await service().reject('o1', 'agency-A', 'call me at 5551234567 or me@x.com');
      const rejectCall = db.q.mock.calls.find(([sql]: [string]) => /SET status = 'REJECTED'/.test(sql));
      const storedReason = rejectCall?.[1]?.[2] as string;
      expect(storedReason).not.toMatch(/5551234567|me@x\.com/);
      expect(storedReason).toContain('[redacted]');
    });

    it('redacts a separator-laden phone number from the reject reason', async () => {
      wire({
        offerLock: {booking_id: 'b1', status: 'OFFERED', provider_user_id: 'agency-A'},
        bookingCtx: {status: 'CONFIRMED'}, // stop the cascade after the reject
      });
      await service().reject('o1', 'agency-A', 'reach me on +1 555-123-4567 today');
      const rejectCall = db.q.mock.calls.find(([sql]: [string]) => /SET status = 'REJECTED'/.test(sql));
      const storedReason = rejectCall?.[1]?.[2] as string;
      expect(storedReason).not.toMatch(/555-123-4567|5551234567/);
      expect(storedReason).toContain('[redacted]');
    });
  });

  describe('expire', () => {
    it('EXPIRED → cascades to the next agency', async () => {
      const {inserts} = wire({
        expireReturns: [{booking_id: 'b1', provider_user_id: 'agency-A'}],
        bookingCtx: {status: 'DISPATCHING', region_code: 'AE', cpo_count: 1, requirements: {}, armed_required: false},
        offerCount: 1, ranking: [{user_id: 'agency-C', distance_km: '4'}],
      });
      await service().expire('o1');
      expect(inserts[0][1]).toBe('agency-C');
    });

    it('Step 23 — an ignored (expired) offer counts against the agency like a reject', async () => {
      wire({
        expireReturns: [{booking_id: 'b1', provider_user_id: 'agency-A'}],
        bookingCtx: {status: 'CONFIRMED'}, // stop the cascade after the expire
      });
      await service().expire('o1');
      const acctCall = db.q.mock.calls.find(([sql]: [string]) =>
        /UPDATE agents\s+SET offers_rejected = offers_rejected \+ 1/.test(sql));
      expect(acctCall).toBeDefined();
      expect(acctCall?.[1]).toEqual(['agency-A']);
    });

    it('no-ops (no cascade, no audit) when the offer already moved on (raced with accept)', async () => {
      wire({expireReturns: []});
      await service().expire('o2');
      expect(audit.record).not.toHaveBeenCalled();
      expect(db.qOne).not.toHaveBeenCalledWith(expect.stringMatching(/region_code, cpo_count/), expect.anything());
    });
  });

  describe('cancel', () => {
    it('supersedes the live offer + DISPATCHING → CANCELLED', async () => {
      wire({bookingStatusLock: {status: 'DISPATCHING'}});
      await service().cancel('b1');
      expect(db.q).toHaveBeenCalledWith(expect.stringMatching(/UPDATE dispatch_offers SET status = 'SUPERSEDED'/), ['b1']);
      expect(db.q).toHaveBeenCalledWith(expect.stringMatching(/UPDATE lite_bookings SET status = 'CANCELLED'/), ['b1']);
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({action: 'dispatch.cancel'}));
    });

    it('no-op when the booking is no longer DISPATCHING', async () => {
      wire({bookingStatusLock: {status: 'CONFIRMED'}});
      await service().cancel('b1');
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('accept', () => {
    function wireAccept(opts: {
      offer?: {booking_id: string; status: string; provider_user_id: string} | null;
      wonRows?: number;       // rows the OFFERED→ACCEPTED conditional UPDATE returns
      booking?: {status: string; client_id: string; payer_user_id?: string | null; total_eur?: string} | null;
      confirmRows?: number;   // rows the DISPATCHING→CONFIRMED UPDATE returns
      existingHold?: boolean; // an escrow_holds row already exists for the booking
      // B-384 — the charge-time family re-check row. Default = healthy active
      // membership; pass null to simulate revoked/declined.
      family?: {id: string; held_until: Date | null; spend_limit_credits: number | null; spent_credits: number} | null;
    }): void {
      db.qOne.mockImplementation((sql: string) => {
        if (/FROM dispatch_offers WHERE id = \$1 FOR UPDATE/.test(sql)) return Promise.resolve(opts.offer ?? null);
        if (/SELECT status, client_id, payer_user_id, total_eur FROM lite_bookings WHERE id = \$1 FOR UPDATE/.test(sql)) return Promise.resolve(opts.booking ?? null);
        if (/FROM escrow_holds WHERE booking_id = \$1/.test(sql)) return Promise.resolve(opts.existingHold ? {booking_id: 'b1'} : null);
        if (/FROM public\.family_members/.test(sql)) {
          return Promise.resolve(opts.family !== undefined
            ? opts.family
            : {id: 'fm-1', held_until: null, spend_limit_credits: null, spent_credits: 0});
        }
        return Promise.resolve(null);
      });
      db.q.mockImplementation((sql: string) => {
        if (/UPDATE dispatch_offers SET status = 'ACCEPTED'/.test(sql)) return Promise.resolve(new Array(opts.wonRows ?? 1).fill({id: 'o1'}));
        if (/INSERT INTO escrow_holds/.test(sql)) return Promise.resolve([]);
        if (/UPDATE lite_bookings\s+SET status = 'CONFIRMED'/.test(sql)) return Promise.resolve(new Array(opts.confirmRows ?? 1).fill({id: 'b1'}));
        if (/UPDATE dispatch_offers SET status = 'SUPERSEDED'/.test(sql)) return Promise.resolve([]);
        return Promise.resolve([]);
      });
    }

    it('wins the offer + charges escrow + flips booking → CONFIRMED, supersedes siblings, audits, wakes the client', async () => {
      wireAccept({
        offer: {booking_id: 'b1', status: 'OFFERED', provider_user_id: 'agency-A'},
        booking: {status: 'DISPATCHING', client_id: 'client-1', total_eur: '800'},
      });
      const res = await service().accept('o1', 'agency-A');
      expect(res).toEqual({offer_id: 'o1', booking_id: 'b1', status: 'CONFIRMED'});
      expect(db.q).toHaveBeenCalledWith(expect.stringMatching(/UPDATE dispatch_offers SET status = 'ACCEPTED'/), expect.anything());
      // Escrow charge happens INSIDE the txn, before the CONFIRMED flip.
      expect(wallet.holdToEscrow).toHaveBeenCalledWith(
        expect.anything(),
        {clientId: 'client-1', bookingId: 'b1', offerId: 'o1', credits: 800, actorUserId: 'client-1', familyRowId: null},
      );
      expect(db.q).toHaveBeenCalledWith(expect.stringMatching(/INSERT INTO escrow_holds/), expect.arrayContaining(['b1', 'o1', 'client-1', 'agency-A', 800, 'AED']));
      expect(db.q).toHaveBeenCalledWith(expect.stringMatching(/UPDATE lite_bookings\s+SET status = 'CONFIRMED'/), expect.arrayContaining(['b1', 'agency-A', 15]));
      // D3 — raced siblings are retired as CANCELLED (innocent bystanders), never
      // SUPERSEDED (which the R9 + ranking exclusions read as agency fault).
      expect(db.q).toHaveBeenCalledWith(expect.stringMatching(/UPDATE dispatch_offers SET status = 'CANCELLED'/), ['b1', 'o1']);
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({action: 'dispatch.accept', subject_id: 'b1'}));
      expect(push.providerAccepted).toHaveBeenCalledWith('client-1', 'b1');
    });

    it('MON-6 — charges the peg-correct BC amount (total_eur / eur_per_bc), not raw EUR', async () => {
      // At the shipped peg (1.0) credits == total_eur (proven by the test above). With
      // the peg moved to 2 (1 BC = 2 EUR), an 800-EUR booking must debit 400 BC, not 800.
      // Revert the division and this reads 800 → RED.
      wireAccept({
        offer: {booking_id: 'b1', status: 'OFFERED', provider_user_id: 'agency-A'},
        booking: {status: 'DISPATCHING', client_id: 'client-1', total_eur: '800'},
      });
      const pricing = {config: jest.fn().mockResolvedValue({eur_per_bc: 2})};
      const svc = new DispatchService(
        db as unknown as DatabaseService, fsm,
        audit as unknown as OpsAuditService,
        push as unknown as BookingPushBridge,
        wallet as unknown as WalletService,
        undefined, undefined, pricing as never,
      );
      await svc.accept('o1', 'agency-A');
      expect(wallet.holdToEscrow).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({credits: 400}),
      );
    });

    it('aborts the whole accept (offer NOT won) when the client cannot afford the escrow', async () => {
      wireAccept({
        offer: {booking_id: 'b1', status: 'OFFERED', provider_user_id: 'agency-A'},
        booking: {status: 'DISPATCHING', client_id: 'client-1', total_eur: '800'},
      });
      wallet.holdToEscrow.mockRejectedValue(new BadRequestException('insufficient_credits'));
      await expect(service().accept('o1', 'agency-A')).rejects.toBeInstanceOf(BadRequestException);
      // The throw unwinds the txn — no CONFIRMED flip, no hold, no audit/push.
      expect(db.q).not.toHaveBeenCalledWith(expect.stringMatching(/SET status = 'CONFIRMED'/), expect.anything());
      expect(audit.record).not.toHaveBeenCalled();
      expect(push.providerAccepted).not.toHaveBeenCalled();
    });

    it('LM-B7: debits the resolved PAYER (family holder) when payer_user_id is stamped', async () => {
      wireAccept({
        offer: {booking_id: 'b1', status: 'OFFERED', provider_user_id: 'agency-A'},
        booking: {status: 'DISPATCHING', client_id: 'client-1', payer_user_id: 'holder-9', total_eur: '800'},
      });
      await service().accept('o1', 'agency-A');
      // Payer = the holder; the MEMBER stays on the ledger as actor so the
      // owner's per-member spend view can attribute the charge. B-384 — the
      // charge-time re-check resolves the live membership row, so familyRowId
      // now pins cap bookkeeping to it.
      expect(wallet.holdToEscrow).toHaveBeenCalledWith(
        expect.anything(),
        {clientId: 'holder-9', bookingId: 'b1', offerId: 'o1', credits: 800, actorUserId: 'client-1', familyRowId: 'fm-1'},
      );
    });

    // B-384 — a holder who revoked/held/capped the member must NOT be debited
    // at accept time (the request-time soft-check can be days old on scheduled
    // bookings). Same neutral failure as insufficient credits.
    const familyBooking = {status: 'DISPATCHING', client_id: 'client-1', payer_user_id: 'holder-9', total_eur: '800'} as const;
    it('B-384: REVOKED member → charge refused, holder never debited', async () => {
      wireAccept({offer: {booking_id: 'b1', status: 'OFFERED', provider_user_id: 'agency-A'}, booking: familyBooking, family: null});
      await expect(service().accept('o1', 'agency-A')).rejects.toMatchObject({message: 'offer_not_available'});
      expect(wallet.holdToEscrow).not.toHaveBeenCalled();
    });
    it('B-384: member ON HOLD → charge refused', async () => {
      wireAccept({offer: {booking_id: 'b1', status: 'OFFERED', provider_user_id: 'agency-A'}, booking: familyBooking,
        family: {id: 'fm-1', held_until: new Date(Date.now() + 86_400_000), spend_limit_credits: null, spent_credits: 0}});
      await expect(service().accept('o1', 'agency-A')).rejects.toMatchObject({message: 'offer_not_available'});
      expect(wallet.holdToEscrow).not.toHaveBeenCalled();
    });
    it('B-384: charge would exceed the live spend cap → refused', async () => {
      wireAccept({offer: {booking_id: 'b1', status: 'OFFERED', provider_user_id: 'agency-A'}, booking: familyBooking,
        family: {id: 'fm-1', held_until: null, spend_limit_credits: 1000, spent_credits: 300}});
      await expect(service().accept('o1', 'agency-A')).rejects.toMatchObject({message: 'offer_not_available'});
      expect(wallet.holdToEscrow).not.toHaveBeenCalled();
    });
    it('B-384: an expired hold no longer blocks the charge', async () => {
      wireAccept({offer: {booking_id: 'b1', status: 'OFFERED', provider_user_id: 'agency-A'}, booking: familyBooking,
        family: {id: 'fm-1', held_until: new Date(Date.now() - 86_400_000), spend_limit_credits: null, spent_credits: 0}});
      await service().accept('o1', 'agency-A');
      expect(wallet.holdToEscrow).toHaveBeenCalled();
    });

    it('skips the escrow charge for a free (0-total) booking but still CONFIRMs', async () => {
      wireAccept({
        offer: {booking_id: 'b1', status: 'OFFERED', provider_user_id: 'agency-A'},
        booking: {status: 'DISPATCHING', client_id: 'client-1', total_eur: '0'},
      });
      const res = await service().accept('o1', 'agency-A');
      expect(res.status).toBe('CONFIRMED');
      expect(wallet.holdToEscrow).not.toHaveBeenCalled();
      expect(db.q).not.toHaveBeenCalledWith(expect.stringMatching(/INSERT INTO escrow_holds/), expect.anything());
    });

    it('does NOT double-charge when a hold already exists for the booking (idempotent)', async () => {
      wireAccept({
        offer: {booking_id: 'b1', status: 'OFFERED', provider_user_id: 'agency-A'},
        booking: {status: 'DISPATCHING', client_id: 'client-1', total_eur: '800'},
        existingHold: true, // a hold is already recorded → the charge must be skipped
      });
      const res = await service().accept('o1', 'agency-A');
      expect(res.status).toBe('CONFIRMED');
      expect(wallet.holdToEscrow).not.toHaveBeenCalled();
      expect(db.q).not.toHaveBeenCalledWith(expect.stringMatching(/INSERT INTO escrow_holds/), expect.anything());
    });

    it('404 when the offer does not exist', async () => {
      wireAccept({offer: null});
      await expect(service().accept('missing', 'agency-A')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('403 (org_scope_violation) when the caller is not the offer owner (IDOR)', async () => {
      wireAccept({offer: {booking_id: 'b1', status: 'OFFERED', provider_user_id: 'agency-A'}});
      await expect(service().accept('o1', 'agency-OTHER')).rejects.toBeInstanceOf(ForbiddenException);
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('409 (offer_not_available) when the offer is no longer OFFERED / expired (0 rows won)', async () => {
      wireAccept({offer: {booking_id: 'b1', status: 'EXPIRED', provider_user_id: 'agency-A'}, wonRows: 0});
      await expect(service().accept('o1', 'agency-A')).rejects.toBeInstanceOf(BadRequestException);
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('409 when the booking is no longer DISPATCHING', async () => {
      wireAccept({
        offer: {booking_id: 'b1', status: 'OFFERED', provider_user_id: 'agency-A'},
        booking: {status: 'CONFIRMED', client_id: 'client-1'}, // already moved on
      });
      await expect(service().accept('o1', 'agency-A')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('getCurrentOfferForOrg (coarse — LB1)', () => {
    function wireCoarse(row: Record<string, unknown> | null): void {
      db.qOne.mockImplementation((sql: string) =>
        /FROM dispatch_offers o\s+JOIN lite_bookings b/.test(sql) ? Promise.resolve(row) : Promise.resolve(null));
    }

    it('returns null when the org holds no live offer', async () => {
      wireCoarse(null);
      expect(await service().getCurrentOfferForOrg('agency-A')).toBeNull();
    });

    it('returns ONLY coarse fields — never exact pickup/dropoff coords, address, or client id', async () => {
      wireCoarse({
        offer_id: 'o1', expires_at: new Date('2026-06-21T10:00:00Z'), distance_km: '3.40',
        region_code: 'AE', region_label: 'Dubai', service: 'CPO', pickup_time: new Date('2026-06-21T12:00:00Z'),
        duration_hours: 4, cpo_count: 2, vehicle_count: 1, driver_only: false, armed_required: true,
        add_ons: ['medic'],
        // A hostile / future non-boolean key smuggled into requirements must NOT
        // reach the coarse payload — only boolean capability flags survive (LB1).
        requirements: {female_officer: true, principal_name: 'Jane Doe', vip_phone: 5551234567},
        total_eur: '800.00', total_aed: '3200.00',
      });
      const dto = await service().getCurrentOfferForOrg('agency-A');
      expect(dto).not.toBeNull();
      expect(dto!.distance_bucket).toBe('2-5km');
      expect(dto!.region_label).toBe('Dubai');
      expect(dto!.requirements.armed).toBe(true);
      expect(dto!.requirements.flags).toEqual({female_officer: true}); // booleans only
      expect(dto!.price).toEqual({eur: '800.00', aed: '3200.00'});
      // The crown-jewel assertion: the serialized payload carries NO precise
      // location, address, booking id, client identity, or smuggled PII (LB1 + H5).
      const serialized = JSON.stringify(dto);
      expect(serialized).not.toMatch(/pickup_lat|pickup_lng|dropoff|address|client_id|booking_id/);
      expect(serialized).not.toMatch(/Jane Doe|principal_name|vip_phone|5551234567/);
      expect(Object.keys(dto!)).not.toContain('pickup_lat');
    });
  });

  describe('getFullOffer (ACCEPTED + owner only)', () => {
    function wireFull(opts: {
      offer?: {status: string; provider_user_id: string; booking_id: string} | null;
      booking?: Record<string, unknown> | null;
    }): void {
      db.qOne.mockImplementation((sql: string) => {
        if (/SELECT status, provider_user_id, booking_id FROM dispatch_offers/.test(sql)) return Promise.resolve(opts.offer ?? null);
        if (/pickup_lat, pickup_lng, pickup_address/.test(sql)) return Promise.resolve(opts.booking ?? null);
        return Promise.resolve(null);
      });
    }
    const acceptedOffer = {status: 'ACCEPTED', provider_user_id: 'agency-A', booking_id: 'b1'};
    const fullBooking = {
      region_code: 'AE', region_label: 'Dubai', service: 'CPO', pickup_time: new Date('2026-06-21T12:00:00Z'),
      duration_hours: 4, cpo_count: 2, pickup_lat: '25.20', pickup_lng: '55.27', pickup_address: '1 X St',
      dropoff_lat: '25.10', dropoff_lng: '55.10', dropoff_address: '2 Y Rd',
    };

    it('404 when the offer does not exist', async () => {
      wireFull({offer: null});
      await expect(service().getFullOffer('agency-A', 'missing')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('403 (org_scope_violation) for a non-owner — even when ACCEPTED (IDOR)', async () => {
      wireFull({offer: acceptedOffer});
      await expect(service().getFullOffer('agency-OTHER', 'o1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('403 (offer_not_accepted) for the owner before acceptance', async () => {
      wireFull({offer: {status: 'OFFERED', provider_user_id: 'agency-A', booking_id: 'b1'}});
      await expect(service().getFullOffer('agency-A', 'o1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('returns precise coords for the owning org once ACCEPTED', async () => {
      wireFull({offer: acceptedOffer, booking: fullBooking});
      const dto = await service().getFullOffer('agency-A', 'o1');
      expect(dto.booking_id).toBe('b1');
      expect(dto.pickup_lat).toBe('25.20');
      expect(dto.dropoff_address).toBe('2 Y Rd');
      // Still no client account UUID leaks (H5).
      expect(JSON.stringify(dto)).not.toMatch(/client_id/);
    });
  });
});
