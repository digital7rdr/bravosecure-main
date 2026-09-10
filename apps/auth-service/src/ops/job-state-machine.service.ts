import {ForbiddenException, Injectable} from '@nestjs/common';

/**
 * Job feed lifecycle — a booking after Ops approval.
 *
 *   PUBLISHED → REVIEW → ASSIGNED → DISPATCHED
 *
 * CANCELLED is terminal and reachable from any pre-dispatch state.
 */
export type JobStatus =
  | 'PUBLISHED' | 'REVIEW' | 'ASSIGNED' | 'DISPATCHED' | 'CANCELLED';

export type JobActor = 'OPS' | 'ADMIN' | 'SYSTEM';

interface JT {from: JobStatus; to: JobStatus; actor: JobActor}

const TRANSITIONS: JT[] = [
  // When applications start arriving, admin opens the review tray.
  {from: 'PUBLISHED', to: 'REVIEW',     actor: 'OPS'},
  // Admin shortlists and assigns a crew.
  {from: 'REVIEW',    to: 'ASSIGNED',   actor: 'OPS'},
  {from: 'REVIEW',    to: 'ASSIGNED',   actor: 'ADMIN'},
  // System materialises the mission after assignment.
  {from: 'ASSIGNED',  to: 'DISPATCHED', actor: 'SYSTEM'},
  {from: 'ASSIGNED',  to: 'DISPATCHED', actor: 'OPS'},
];

// Any non-terminal, pre-dispatch state can be cancelled by Ops/Admin.
const CANCELLABLE: readonly JobStatus[] = ['PUBLISHED', 'REVIEW', 'ASSIGNED'];
const CANCELLING_ACTORS: readonly JobActor[] = ['OPS', 'ADMIN'];

@Injectable()
export class JobStateMachine {
  assert(from: JobStatus, to: JobStatus, actor: JobActor): void {
    if (to === 'CANCELLED') {
      if (!CANCELLABLE.includes(from)) {
        throw new ForbiddenException(`Cannot cancel job in state ${from}`);
      }
      if (!CANCELLING_ACTORS.includes(actor)) {
        throw new ForbiddenException(`Actor ${actor} cannot cancel jobs`);
      }
      return;
    }
    const ok = TRANSITIONS.some(t => t.from === from && t.to === to && t.actor === actor);
    if (!ok) {
      throw new ForbiddenException(
        `Invalid job transition ${from} → ${to} for actor ${actor}`,
      );
    }
  }
}
