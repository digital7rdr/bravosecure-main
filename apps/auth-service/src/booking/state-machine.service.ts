import {ForbiddenException, Injectable} from '@nestjs/common';

export type BookingStatus =
  | 'DRAFT'
  | 'DISPATCHING'      // auto-dispatch: searching for the nearest agency
  | 'PENDING_OPS'
  | 'OPS_APPROVED'
  | 'PAYMENT_PENDING'
  | 'CONFIRMED'
  | 'LIVE'
  | 'COMPLETED'
  | 'NO_PROVIDER'      // auto-dispatch terminal: nobody available / all rejected
  | 'AGENCY_NO_SHOW'   // auto-dispatch terminal: agency accepted but never crewed (LB5)
  | 'CANCELLED';

export type ActorRole = 'CLIENT' | 'OPS_HANDLER' | 'CPO' | 'SYSTEM';

interface Transition {
  from: BookingStatus;
  to:   BookingStatus;
  actor: ActorRole;
}

/**
 * Allowed booking state transitions. Anything not in this table is rejected.
 * CANCELLED is reachable from any non-terminal status by the CLIENT or SYSTEM.
 */
const TRANSITIONS: Transition[] = [
  {from: 'DRAFT',            to: 'PENDING_OPS',     actor: 'CLIENT'},
  {from: 'PENDING_OPS',      to: 'OPS_APPROVED',    actor: 'OPS_HANDLER'},
  {from: 'OPS_APPROVED',     to: 'PAYMENT_PENDING', actor: 'CLIENT'},
  {from: 'PAYMENT_PENDING',  to: 'CONFIRMED',       actor: 'SYSTEM'},
  {from: 'CONFIRMED',        to: 'LIVE',            actor: 'CPO'},
  // Ops can dispatch a confirmed booking from the console — assigns CPOs +
  // vehicle and flips the mission to LIVE without waiting for a CPO check-in.
  {from: 'CONFIRMED',        to: 'LIVE',            actor: 'OPS_HANDLER'},
  {from: 'LIVE',             to: 'COMPLETED',       actor: 'CPO'},
  // Ops can close a LIVE mission from the console — distributes the
  // escrowed credits to assigned CPOs and dissolves the mission group.
  {from: 'LIVE',             to: 'COMPLETED',       actor: 'OPS_HANDLER'},

  // ── Auto-dispatch (Uber-style) — gated behind AUTO_DISPATCH_ENABLED ──
  // Client submits an auto request → server hunts for the nearest agency.
  {from: 'DRAFT',            to: 'DISPATCHING',     actor: 'CLIENT'},
  // Ops-gated auto dispatch: an auto booking now goes to the ops board first
  // (PENDING_OPS → OPS_APPROVED, legacy edges); approval hands it to the
  // matchmaker — the dispatch subscriber ("now") or scheduled cron ("later")
  // flips it into the search as SYSTEM.
  {from: 'OPS_APPROVED',     to: 'DISPATCHING',     actor: 'SYSTEM'},
  // An agency accepted + the client was charged. CONFIRMED here means
  // "accepted, awaiting crew assignment" (the crew-assign step creates the mission).
  {from: 'DISPATCHING',      to: 'CONFIRMED',       actor: 'SYSTEM'},
  // Nobody available / every eligible agency rejected — terminal.
  {from: 'DISPATCHING',      to: 'NO_PROVIDER',     actor: 'SYSTEM'},
  // Agency accepted but never assigned crew before crew_deadline_at — the Step 8
  // crew-SLA watchdog flips it (provider-fault breach). Terminal, SYSTEM-only;
  // deliberately NOT in CANCELLABLE so it can't be re-cancelled.
  {from: 'CONFIRMED',        to: 'AGENCY_NO_SHOW',  actor: 'SYSTEM'},
  // Crew was assigned (mission DISPATCHED) but never reached PICKUP by
  // arrival_deadline_at — the Step 16 arrival-no-show watchdog re-dispatches the
  // SAME booking to another agency. SYSTEM-only; the escrow hold persists (the
  // client is NEVER re-charged). Makes CONFIRMED re-enterable back into the search.
  {from: 'CONFIRMED',        to: 'DISPATCHING',     actor: 'SYSTEM'},
  // Auto-dispatch completion — the booking FSM stays CONFIRMED for the whole
  // mission (the MISSION advances DISPATCHED->PICKUP->LIVE->COMPLETED; the booking is
  // not separately driven to LIVE), so the CPO Finish (agent.service.missionComplete)
  // and ops completeBooking close the booking straight from CONFIRMED. Without this
  // an auto-dispatch completion matched 0 rows and stuck the booking CONFIRMED forever
  // (client UI frozen on "assigned", cancel 404s, new bookings blocked).
  {from: 'CONFIRMED',        to: 'COMPLETED',       actor: 'CPO'},
  {from: 'CONFIRMED',        to: 'COMPLETED',       actor: 'OPS_HANDLER'},
];

const CANCELLABLE: readonly BookingStatus[] = [
  'DRAFT', 'DISPATCHING', 'PENDING_OPS', 'OPS_APPROVED', 'PAYMENT_PENDING', 'CONFIRMED',
];

@Injectable()
export class BookingStateMachine {
  /** Throws if the transition is not allowed for this actor. */
  assert(from: BookingStatus, to: BookingStatus, actor: ActorRole): void {
    if (to === 'CANCELLED') {
      if (!CANCELLABLE.includes(from)) {
        throw new ForbiddenException(`Cannot cancel a booking in state ${from}`);
      }
      if (actor !== 'CLIENT' && actor !== 'SYSTEM' && actor !== 'OPS_HANDLER') {
        throw new ForbiddenException(`Actor ${actor} cannot cancel booking`);
      }
      return;
    }
    const ok = TRANSITIONS.some(t => t.from === from && t.to === to && t.actor === actor);
    if (!ok) {
      throw new ForbiddenException(
        `Invalid transition ${from} → ${to} for actor ${actor}`,
      );
    }
  }
}
