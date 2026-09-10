import {ForbiddenException, Injectable} from '@nestjs/common';

/**
 * Agent Portal state machine.
 *
 * Status lifecycle matches the 9-screen onboarding flow:
 *   DRAFT → PROFILE_COMPLETE → KYC_PENDING → DOCS_PENDING → SUBMITTED
 *         → UNDER_REVIEW → APPROVED → ACTIVE
 *         (or REJECTED from UNDER_REVIEW)
 *
 * The partner themselves is the AGENT actor. ADMIN and OPS are Bravo
 * staff; SYSTEM is the automated pipeline (KYC completion webhooks,
 * regulator lookups, Redis-backed scheduled jobs, etc.).
 */
export type AgentStatus =
  | 'DRAFT'
  | 'PROFILE_COMPLETE'
  | 'KYC_PENDING'
  | 'DOCS_PENDING'
  | 'SUBMITTED'
  | 'UNDER_REVIEW'
  | 'APPROVED'
  | 'REJECTED'
  | 'ACTIVE';

export type AgentActorRole = 'AGENT' | 'ADMIN' | 'OPS' | 'SYSTEM';

interface Transition {
  from: AgentStatus;
  to:   AgentStatus;
  actor: AgentActorRole;
}

/**
 * Allowed agent state transitions. Anything not in this table is rejected.
 * Note: a rejected agent may re-enter the flow (REJECTED → DRAFT by AGENT)
 * so they can fix issues flagged during review.
 */
const TRANSITIONS: Transition[] = [
  // Agent walks the onboarding wizard.
  {from: 'DRAFT',            to: 'PROFILE_COMPLETE', actor: 'AGENT'},
  {from: 'PROFILE_COMPLETE', to: 'KYC_PENDING',      actor: 'AGENT'},

  // KYC runs via SYSTEM (automated regulator + DBS lookups).
  {from: 'KYC_PENDING',      to: 'DOCS_PENDING',     actor: 'SYSTEM'},

  // Agent uploads compliance pack, then submits for review.
  {from: 'DOCS_PENDING',     to: 'SUBMITTED',        actor: 'AGENT'},

  // Admin pulls the application into active review.
  {from: 'SUBMITTED',        to: 'UNDER_REVIEW',     actor: 'ADMIN'},

  // Admin approves or rejects.
  {from: 'UNDER_REVIEW',     to: 'APPROVED',         actor: 'ADMIN'},
  {from: 'UNDER_REVIEW',     to: 'REJECTED',         actor: 'ADMIN'},

  // Agent auto-activates when approved (deployment checks are now per-mission).
  {from: 'APPROVED',         to: 'ACTIVE',           actor: 'OPS'},
  {from: 'APPROVED',         to: 'ACTIVE',           actor: 'SYSTEM'},

  // Rejected agent fixes issues and restarts the flow.
  {from: 'REJECTED',         to: 'DRAFT',            actor: 'AGENT'},
];

@Injectable()
export class AgentStateMachine {
  /** Throws if the transition is not allowed for this actor. */
  assert(from: AgentStatus, to: AgentStatus, actor: AgentActorRole): void {
    const ok = TRANSITIONS.some(
      t => t.from === from && t.to === to && t.actor === actor,
    );
    if (!ok) {
      throw new ForbiddenException(
        `Invalid agent transition ${from} → ${to} for actor ${actor}`,
      );
    }
  }

  /** Returns the set of valid next states for the given actor + current status. */
  nextStates(from: AgentStatus, actor: AgentActorRole): AgentStatus[] {
    return TRANSITIONS
      .filter(t => t.from === from && t.actor === actor)
      .map(t => t.to);
  }
}
