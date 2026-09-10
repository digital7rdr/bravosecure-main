import {ForbiddenException} from '@nestjs/common';
import {
  BookingStateMachine,
  type ActorRole,
  type BookingStatus,
} from './state-machine.service';
import {PricingService} from './pricing.service';

/**
 * End-to-end booking lifecycle smoke tests.
 *
 * Exercises the full happy path (DRAFT → PENDING_OPS → OPS_APPROVED →
 * PAYMENT_PENDING → CONFIRMED → LIVE → COMPLETED), replays it three
 * times for flakiness, and then walks every DB status + every actor to
 * prove the state machine rejects every invalid combination.
 */

const ALL_STATES: BookingStatus[] = [
  'DRAFT',
  'PENDING_OPS',
  'OPS_APPROVED',
  'PAYMENT_PENDING',
  'CONFIRMED',
  'LIVE',
  'COMPLETED',
  'CANCELLED',
];

const ALL_ACTORS: ActorRole[] = ['CLIENT', 'OPS_HANDLER', 'CPO', 'SYSTEM'];

// Allowed forward transitions (mirrors TRANSITIONS in state-machine.service.ts).
const LEGAL_FORWARD: Array<[BookingStatus, BookingStatus, ActorRole]> = [
  ['DRAFT',           'PENDING_OPS',     'CLIENT'],
  ['PENDING_OPS',     'OPS_APPROVED',    'OPS_HANDLER'],
  ['OPS_APPROVED',    'PAYMENT_PENDING', 'CLIENT'],
  ['PAYMENT_PENDING', 'CONFIRMED',       'SYSTEM'],
  ['CONFIRMED',       'LIVE',            'CPO'],
  // Ops can dispatch a CONFIRMED booking to LIVE from the console (assigns
  // CPOs + vehicle) without waiting for a CPO self-check-in.
  ['CONFIRMED',       'LIVE',            'OPS_HANDLER'],
  ['LIVE',            'COMPLETED',       'CPO'],
  // Ops can close a LIVE mission to COMPLETED from the console (END MISSION →
  // PAYOUT) — distributes escrow to assigned CPOs and dissolves the group.
  ['LIVE',            'COMPLETED',       'OPS_HANDLER'],
  // Auto-dispatch completion (20260630000000 FSM) — the booking can stay
  // CONFIRMED for the whole mission, so lead Finish / ops complete close it
  // straight from CONFIRMED (mirrors state-machine.service.ts).
  ['CONFIRMED',       'COMPLETED',       'CPO'],
  ['CONFIRMED',       'COMPLETED',       'OPS_HANDLER'],
];

// Cancellable states + actors (mirrors CANCELLABLE in state-machine.service.ts).
const CANCELLABLE_FROM: BookingStatus[] = [
  'DRAFT', 'PENDING_OPS', 'OPS_APPROVED', 'PAYMENT_PENDING', 'CONFIRMED',
];
const CANCELLING_ACTORS: ActorRole[] = ['CLIENT', 'SYSTEM', 'OPS_HANDLER'];

describe('booking lifecycle — end-to-end', () => {
  const fsm = new BookingStateMachine();

  describe('happy path (DRAFT → CONFIRMED → COMPLETED), replayed ×3', () => {
    // Three deterministic attempts to smoke out any hidden mutable state.
    for (const attempt of [1, 2, 3]) {
      it(`attempt #${attempt}: walks the full lifecycle without throwing`, () => {
        const visited: BookingStatus[] = ['DRAFT'];
        const path: Array<[BookingStatus, BookingStatus, ActorRole]> = [
          ['DRAFT',           'PENDING_OPS',     'CLIENT'],
          ['PENDING_OPS',     'OPS_APPROVED',    'OPS_HANDLER'],
          ['OPS_APPROVED',    'PAYMENT_PENDING', 'CLIENT'],
          ['PAYMENT_PENDING', 'CONFIRMED',       'SYSTEM'],
          ['CONFIRMED',       'LIVE',            'CPO'],
          ['LIVE',            'COMPLETED',       'CPO'],
        ];

        for (const [from, to, actor] of path) {
          expect(() => fsm.assert(from, to, actor)).not.toThrow();
          visited.push(to);
        }

        expect(visited).toEqual([
          'DRAFT', 'PENDING_OPS', 'OPS_APPROVED', 'PAYMENT_PENDING',
          'CONFIRMED', 'LIVE', 'COMPLETED',
        ]);
      });
    }
  });

  describe('"booking → confirmed" focused flow (the exact path the client takes), ×3', () => {
    for (const attempt of [1, 2, 3]) {
      it(`attempt #${attempt}: client + ops + system arrive at CONFIRMED`, () => {
        // Client submits draft → ops approves → client accepts pricing /
        // kicks off payment → webhook-as-SYSTEM confirms.
        expect(() => fsm.assert('DRAFT',           'PENDING_OPS',     'CLIENT')).not.toThrow();
        expect(() => fsm.assert('PENDING_OPS',     'OPS_APPROVED',    'OPS_HANDLER')).not.toThrow();
        expect(() => fsm.assert('OPS_APPROVED',    'PAYMENT_PENDING', 'CLIENT')).not.toThrow();
        expect(() => fsm.assert('PAYMENT_PENDING', 'CONFIRMED',       'SYSTEM')).not.toThrow();
      });
    }
  });

  describe('cancel branches — client can bail out at every stage before LIVE', () => {
    it.each(CANCELLABLE_FROM)('CLIENT can cancel from %s', (from) => {
      expect(() => fsm.assert(from, 'CANCELLED', 'CLIENT')).not.toThrow();
    });

    it.each(CANCELLABLE_FROM)('OPS_HANDLER can cancel from %s', (from) => {
      expect(() => fsm.assert(from, 'CANCELLED', 'OPS_HANDLER')).not.toThrow();
    });

    it.each(CANCELLABLE_FROM)('SYSTEM can cancel from %s', (from) => {
      expect(() => fsm.assert(from, 'CANCELLED', 'SYSTEM')).not.toThrow();
    });

    it('CPO is never allowed to cancel (any state)', () => {
      for (const from of CANCELLABLE_FROM) {
        expect(() => fsm.assert(from, 'CANCELLED', 'CPO')).toThrow(ForbiddenException);
      }
    });

    it('neither LIVE nor COMPLETED nor CANCELLED are cancellable by anyone', () => {
      for (const from of ['LIVE', 'COMPLETED', 'CANCELLED'] as BookingStatus[]) {
        for (const actor of ALL_ACTORS) {
          expect(() => fsm.assert(from, 'CANCELLED', actor)).toThrow(ForbiddenException);
        }
      }
    });
  });

  describe('exhaustive state × actor matrix — every illegal move is rejected', () => {
    // For every (from, to, actor) triple NOT in LEGAL_FORWARD and not a
    // valid cancel combo, assert must throw.
    const legalSet = new Set(LEGAL_FORWARD.map(t => t.join('|')));
    const legalCancel = new Set(
      CANCELLABLE_FROM.flatMap(f => CANCELLING_ACTORS.map(a => `${f}|CANCELLED|${a}`)),
    );

    let illegalChecked = 0;
    let legalChecked  = 0;

    for (const from of ALL_STATES) {
      for (const to of ALL_STATES) {
        if (from === to) continue;
        for (const actor of ALL_ACTORS) {
          const key = `${from}|${to}|${actor}`;
          const isLegalForward = legalSet.has(key);
          const isLegalCancel  = legalCancel.has(key);

          if (isLegalForward || isLegalCancel) {
            legalChecked++;
            it(`ALLOW ${from} → ${to} by ${actor}`, () => {
              expect(() => fsm.assert(from, to, actor)).not.toThrow();
            });
          } else {
            illegalChecked++;
            it(`REJECT ${from} → ${to} by ${actor}`, () => {
              expect(() => fsm.assert(from, to, actor)).toThrow(ForbiddenException);
            });
          }
        }
      }
    }

    it('covered the full matrix (8 states × 8 states × 4 actors, minus self-loops)', () => {
      // 8*7*4 = 224 possible transitions
      expect(legalChecked + illegalChecked).toBe(224);
    });
  });

  describe('regression guards — specific gotchas we burned on before', () => {
    it('rejects skipping PAYMENT_PENDING (you cannot CONFIRM straight from OPS_APPROVED)', () => {
      expect(() => fsm.assert('OPS_APPROVED', 'CONFIRMED', 'SYSTEM'))
        .toThrow(ForbiddenException);
    });

    it('rejects client payment being "confirmed" by the client themselves', () => {
      expect(() => fsm.assert('PAYMENT_PENDING', 'CONFIRMED', 'CLIENT'))
        .toThrow(ForbiddenException);
    });

    it('rejects ops going backwards (COMPLETED → LIVE / LIVE → CONFIRMED)', () => {
      expect(() => fsm.assert('COMPLETED', 'LIVE', 'CPO')).toThrow(ForbiddenException);
      expect(() => fsm.assert('LIVE', 'CONFIRMED', 'SYSTEM')).toThrow(ForbiddenException);
    });

    it('does not accept CPO submitting / approving instead of the client-or-ops actor', () => {
      expect(() => fsm.assert('DRAFT', 'PENDING_OPS', 'CPO')).toThrow(ForbiddenException);
      expect(() => fsm.assert('PENDING_OPS', 'OPS_APPROVED', 'CPO')).toThrow(ForbiddenException);
    });
  });
});

describe('booking pricing — confirmation depends on correct EUR total', () => {
  const pricing = new PricingService();
  // Fix the pickup at 09:00 UTC so the peak surcharge doesn't kick in.
  const base = {
    cpoCount: 1,
    vehicleCount: 1,
    driverOnly: false,
    durationHours: 4,
    pickupTime: new Date('2026-05-01T09:00:00Z'),
    addOns: [],
  };

  it('baseline = 86 EUR/hr × 4 = 344 EUR', () => {
    expect(pricing.calculate(base).total_eur).toBe(344);
  });

  it('2 CPOs + 2 vehicles = 86 + 21.5 + 21.5 = 129 EUR/hr', () => {
    const p = pricing.calculate({...base, cpoCount: 2, vehicleCount: 2});
    expect(p.rate_eur_per_hour).toBe(129);
  });

  it('driver-only shaves 35% off the rate', () => {
    const p = pricing.calculate({...base, driverOnly: true});
    expect(p.rate_eur_per_hour).toBeCloseTo(86 * 0.65, 2);
  });

  it('peak window (18:00 UTC) applies a 1.2× multiplier', () => {
    const p = pricing.calculate({
      ...base,
      pickupTime: new Date('2026-05-01T18:00:00Z'),
    });
    expect(p.rate_eur_per_hour).toBeCloseTo(86 * 1.2, 2);
  });
});
