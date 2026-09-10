import {ForbiddenException} from '@nestjs/common';
import type {IncidentStatus} from './incident.constants';

/**
 * Incident status FSM (PDF p.15). Mirrors booking/state-machine.service.ts:
 * a flat TRANSITIONS table + an assert() that throws on an illegal hop. The
 * submitter's report (category/severity/description/location) is NEVER mutated
 * by a transition — only incident_reports.status + an incident_events row move.
 *
 * Actors: a delegated 'manager' vs the 'company_admin' (the company account
 * itself). Reopen (closed → under_review) is company-admin-only (PDF p.15).
 */
export type IncidentActor = 'manager' | 'company_admin';

interface IncidentTransition {
  from: IncidentStatus;
  to: IncidentStatus;
  actors: readonly IncidentActor[];
}

const BOTH: readonly IncidentActor[] = ['manager', 'company_admin'];

export const INCIDENT_TRANSITIONS: readonly IncidentTransition[] = [
  {from: 'submitted',       to: 'received',        actors: BOTH},
  {from: 'received',        to: 'under_review',    actors: BOTH},
  {from: 'under_review',    to: 'action_assigned', actors: BOTH},
  {from: 'action_assigned', to: 'resolved',        actors: BOTH},
  {from: 'resolved',        to: 'closed',          actors: BOTH},
  // Rework — a resolved incident can be reopened for more work.
  {from: 'resolved',        to: 'under_review',    actors: BOTH},
  // Reopen a closed incident — company-admin only.
  {from: 'closed',          to: 'under_review',    actors: ['company_admin']},
];

/** Throws ForbiddenException if the transition is not allowed for this actor. */
export function assertIncidentTransition(
  from: IncidentStatus, to: IncidentStatus, actor: IncidentActor,
): void {
  const ok = INCIDENT_TRANSITIONS.some(t => t.from === from && t.to === to && t.actors.includes(actor));
  if (!ok) {
    throw new ForbiddenException(`invalid_incident_transition:${from}->${to}:${actor}`);
  }
}
