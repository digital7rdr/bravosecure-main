import {ForbiddenException} from '@nestjs/common';
import {BookingStateMachine} from './state-machine.service';

describe('BookingStateMachine', () => {
  const fsm = new BookingStateMachine();

  describe('valid transitions', () => {
    const cases: Array<[any, any, any]> = [
      ['DRAFT',           'PENDING_OPS',     'CLIENT'],
      ['PENDING_OPS',     'OPS_APPROVED',    'OPS_HANDLER'],
      ['OPS_APPROVED',    'PAYMENT_PENDING', 'CLIENT'],
      ['PAYMENT_PENDING', 'CONFIRMED',       'SYSTEM'],
      ['CONFIRMED',       'LIVE',            'CPO'],
      ['LIVE',            'COMPLETED',       'CPO'],
      // auto-dispatch
      ['DRAFT',           'DISPATCHING',     'CLIENT'],
      // ops-gated auto dispatch: approval hands the booking to the matchmaker
      ['OPS_APPROVED',    'DISPATCHING',     'SYSTEM'],
      ['DISPATCHING',     'CONFIRMED',       'SYSTEM'],
      ['DISPATCHING',     'NO_PROVIDER',     'SYSTEM'],
      ['CONFIRMED',       'AGENCY_NO_SHOW',  'SYSTEM'],
      ['CONFIRMED',       'DISPATCHING',     'SYSTEM'],
    ];
    test.each(cases)('%s → %s by %s is allowed', (from, to, actor) => {
      expect(() => fsm.assert(from, to, actor)).not.toThrow();
    });
  });

  describe('invalid transitions', () => {
    it('rejects OPS_HANDLER trying to submit a DRAFT', () => {
      expect(() => fsm.assert('DRAFT', 'PENDING_OPS', 'OPS_HANDLER'))
        .toThrow(ForbiddenException);
    });

    it('rejects CLIENT trying to approve a PENDING_OPS booking', () => {
      expect(() => fsm.assert('PENDING_OPS', 'OPS_APPROVED', 'CLIENT'))
        .toThrow(ForbiddenException);
    });

    it('rejects skipping the payment-pending gate', () => {
      expect(() => fsm.assert('OPS_APPROVED', 'CONFIRMED', 'SYSTEM'))
        .toThrow(ForbiddenException);
    });

    it('rejects a CPO trying to mark LIVE before CONFIRMED', () => {
      expect(() => fsm.assert('PENDING_OPS', 'LIVE', 'CPO'))
        .toThrow(ForbiddenException);
    });

    it('rejects going backwards (COMPLETED → LIVE)', () => {
      expect(() => fsm.assert('COMPLETED', 'LIVE', 'CPO'))
        .toThrow(ForbiddenException);
    });
  });

  describe('cancellation rules', () => {
    it('allows the CLIENT to cancel at any non-terminal state', () => {
      for (const s of ['DRAFT','PENDING_OPS','OPS_APPROVED','PAYMENT_PENDING','CONFIRMED'] as const) {
        expect(() => fsm.assert(s, 'CANCELLED', 'CLIENT')).not.toThrow();
      }
    });

    it('refuses to cancel a LIVE mission (needs ops / CPO completion path)', () => {
      expect(() => fsm.assert('LIVE', 'CANCELLED', 'CLIENT'))
        .toThrow(ForbiddenException);
    });

    it('refuses to re-cancel a COMPLETED booking', () => {
      expect(() => fsm.assert('COMPLETED', 'CANCELLED', 'SYSTEM'))
        .toThrow(ForbiddenException);
    });

    it('forbids a CPO from cancelling — only client / ops / system', () => {
      expect(() => fsm.assert('CONFIRMED', 'CANCELLED', 'CPO'))
        .toThrow(ForbiddenException);
    });
  });

  describe('auto-dispatch transitions', () => {
    it('rejects a CLIENT settling a dispatch (only SYSTEM may confirm)', () => {
      expect(() => fsm.assert('DISPATCHING', 'CONFIRMED', 'CLIENT'))
        .toThrow(ForbiddenException);
    });

    it('rejects a non-SYSTEM actor marking NO_PROVIDER', () => {
      expect(() => fsm.assert('DISPATCHING', 'NO_PROVIDER', 'CLIENT'))
        .toThrow(ForbiddenException);
    });

    it('rejects jumping DISPATCHING straight to LIVE', () => {
      expect(() => fsm.assert('DISPATCHING', 'LIVE', 'CPO'))
        .toThrow(ForbiddenException);
    });

    it('lets the CLIENT or SYSTEM cancel while still searching (DISPATCHING)', () => {
      expect(() => fsm.assert('DISPATCHING', 'CANCELLED', 'CLIENT')).not.toThrow();
      expect(() => fsm.assert('DISPATCHING', 'CANCELLED', 'SYSTEM')).not.toThrow();
    });

    it('treats NO_PROVIDER as terminal — not cancellable', () => {
      expect(() => fsm.assert('NO_PROVIDER', 'CANCELLED', 'CLIENT'))
        .toThrow(ForbiddenException);
    });

    it('lets only SYSTEM flag a CONFIRMED booking AGENCY_NO_SHOW (crew-SLA breach)', () => {
      expect(() => fsm.assert('CONFIRMED', 'AGENCY_NO_SHOW', 'SYSTEM')).not.toThrow();
      for (const actor of ['CLIENT', 'OPS_HANDLER', 'CPO'] as const) {
        expect(() => fsm.assert('CONFIRMED', 'AGENCY_NO_SHOW', actor)).toThrow(ForbiddenException);
      }
    });

    it('treats AGENCY_NO_SHOW as terminal — no outgoing transition, not cancellable', () => {
      expect(() => fsm.assert('AGENCY_NO_SHOW', 'LIVE', 'CPO')).toThrow(ForbiddenException);
      expect(() => fsm.assert('AGENCY_NO_SHOW', 'CANCELLED', 'CLIENT')).toThrow(ForbiddenException);
    });

    it('lets only SYSTEM re-dispatch a CONFIRMED booking (arrival no-show)', () => {
      expect(() => fsm.assert('CONFIRMED', 'DISPATCHING', 'SYSTEM')).not.toThrow();
      for (const actor of ['CLIENT', 'OPS_HANDLER', 'CPO'] as const) {
        expect(() => fsm.assert('CONFIRMED', 'DISPATCHING', actor)).toThrow(ForbiddenException);
      }
    });

    it('lets only SYSTEM start the search from OPS_APPROVED (ops-gated auto dispatch)', () => {
      expect(() => fsm.assert('OPS_APPROVED', 'DISPATCHING', 'SYSTEM')).not.toThrow();
      for (const actor of ['CLIENT', 'OPS_HANDLER', 'CPO'] as const) {
        expect(() => fsm.assert('OPS_APPROVED', 'DISPATCHING', actor)).toThrow(ForbiddenException);
      }
    });

    it('still rejects PENDING_OPS → DISPATCHING — an unapproved booking never auto-dispatches', () => {
      for (const actor of ['CLIENT', 'OPS_HANDLER', 'CPO', 'SYSTEM'] as const) {
        expect(() => fsm.assert('PENDING_OPS', 'DISPATCHING', actor)).toThrow(ForbiddenException);
      }
    });
  });
});
