import {ForbiddenException, Injectable} from '@nestjs/common';

export type ProApplicationStatus =
  | 'PENDING_PROPOSAL'   // submitted, awaiting a Bravo Control System proposal
  | 'PROPOSAL_CREATED'   // proposal ready for the client to review
  | 'REVISION_REQUESTED' // client asked for changes; ops revises
  | 'ACCEPTED'           // client accepted; awaiting payment
  | 'ACTIVE'             // paid — plan is live until coverage_end
  | 'EXPIRED'            // terminal — coverage period ended without renewal
  | 'REJECTED'           // terminal — ops declined
  | 'CANCELLED';         // terminal — withdrawn (client, or ops on their behalf)

export type ProActorRole = 'CLIENT' | 'OPS_HANDLER' | 'SYSTEM';

interface Transition {
  from:  ProApplicationStatus;
  to:    ProApplicationStatus;
  actor: ProActorRole;
}

/**
 * Allowed Pro-application transitions. Anything not in this table is rejected.
 * Same posture as the booking FSM: the table IS the contract; services never
 * flip status without an assert() first.
 */
const TRANSITIONS: Transition[] = [
  // Ops answers the application with a proposal (also the revise loop's exit).
  {from: 'PENDING_PROPOSAL',   to: 'PROPOSAL_CREATED',   actor: 'OPS_HANDLER'},
  {from: 'REVISION_REQUESTED', to: 'PROPOSAL_CREATED',   actor: 'OPS_HANDLER'},
  // Client decisions on a proposal.
  {from: 'PROPOSAL_CREATED',   to: 'ACCEPTED',           actor: 'CLIENT'},
  {from: 'PROPOSAL_CREATED',   to: 'REVISION_REQUESTED', actor: 'CLIENT'},
  // Ops may decline at any pre-acceptance review stage.
  {from: 'PENDING_PROPOSAL',   to: 'REJECTED',           actor: 'OPS_HANDLER'},
  {from: 'PROPOSAL_CREATED',   to: 'REJECTED',           actor: 'OPS_HANDLER'},
  {from: 'REVISION_REQUESTED', to: 'REJECTED',           actor: 'OPS_HANDLER'},
  // Payment confirmation activates (server-side, after the wallet debit).
  {from: 'ACCEPTED',           to: 'ACTIVE',             actor: 'SYSTEM'},
  // Coverage period ended — lazy read-path sweep flips it.
  {from: 'ACTIVE',             to: 'EXPIRED',            actor: 'SYSTEM'},
  // Withdrawal — the client (or ops on their behalf) may cancel any time
  // BEFORE activation. Never from ACTIVE: a paid plan ends via EXPIRED only.
  {from: 'PENDING_PROPOSAL',   to: 'CANCELLED',          actor: 'CLIENT'},
  {from: 'PROPOSAL_CREATED',   to: 'CANCELLED',          actor: 'CLIENT'},
  {from: 'REVISION_REQUESTED', to: 'CANCELLED',          actor: 'CLIENT'},
  {from: 'ACCEPTED',           to: 'CANCELLED',          actor: 'CLIENT'},
  {from: 'PENDING_PROPOSAL',   to: 'CANCELLED',          actor: 'OPS_HANDLER'},
  {from: 'PROPOSAL_CREATED',   to: 'CANCELLED',          actor: 'OPS_HANDLER'},
  {from: 'REVISION_REQUESTED', to: 'CANCELLED',          actor: 'OPS_HANDLER'},
  {from: 'ACCEPTED',           to: 'CANCELLED',          actor: 'OPS_HANDLER'},
];

@Injectable()
export class ProApplicationStateMachine {
  /** Throws if the transition is not allowed for this actor. */
  assert(from: ProApplicationStatus, to: ProApplicationStatus, actor: ProActorRole): void {
    const ok = TRANSITIONS.some(t => t.from === from && t.to === to && t.actor === actor);
    if (!ok) {
      throw new ForbiddenException(
        `Invalid transition ${from} → ${to} for actor ${actor}`,
      );
    }
  }
}
