import {ForbiddenException, Injectable} from '@nestjs/common';

/**
 * Mission lifecycle — active execution of a confirmed booking.
 *
 *   DISPATCHED → PICKUP → LIVE → COMPLETED
 *
 * Any non-terminal mission (DISPATCHED/PICKUP/LIVE) can escalate to SOS —
 * the CPO's red alert, or the client's panic button (SYSTEM). From SOS we
 * recover to LIVE (false alarm), complete, or get ABORTED.
 *
 * Any non-terminal state can be ABORTED by Ops / Admin, or by SYSTEM (the
 * sweeps tearing down a stuck/orphaned mission). The drift-janitor may also
 * close an orphaned mission COMPLETED (SYSTEM) when its booking already did.
 */
export type MissionStatus =
  | 'DISPATCHED'
  | 'PICKUP'
  | 'LIVE'
  | 'SOS'
  | 'COMPLETED'
  | 'ABORTED';

export type MissionActor = 'AGENT' | 'OPS' | 'ADMIN' | 'SYSTEM';

interface MT {from: MissionStatus; to: MissionStatus; actor: MissionActor}

// FSM-1 reconciliation (2026-08-28): this table is the SINGLE source of truth for the
// mission graph. It was previously stricter than the live pipeline, which writes mission
// status via raw conditional UPDATEs (agent.service, mission-lead.service, sos.service +
// the sweeps) rather than through assert(). Every transition below is annotated with the
// production writer that performs it, so wiring assert() into those writers cannot reject
// a legitimate flow. See docs/audits/SECURE_SERVICES_ADVERSARIAL_AUDIT_2026-08-28.md (FSM-1).
const TRANSITIONS: MT[] = [
  // Crew moves the mission forward from the mobile side. (agent.flipMissionStatus tap +
  // mission-lead waypoint/telemetry-fallback flips.)
  {from: 'DISPATCHED', to: 'PICKUP',    actor: 'AGENT'},
  {from: 'PICKUP',     to: 'LIVE',      actor: 'AGENT'},
  {from: 'LIVE',       to: 'COMPLETED', actor: 'AGENT'},

  // SOS from the agent on the ground (agent.raiseSos flips from any non-terminal state).
  // DISPATCHED→SOS is legitimate — a guard ambushed en route, or a principal in danger
  // while waiting for pickup; FSM-2 (completion requires live_at) already blocks the
  // never-live-completion abuse this used to enable, so raising the alarm early is safe.
  {from: 'DISPATCHED', to: 'SOS', actor: 'AGENT'},
  {from: 'PICKUP',     to: 'SOS', actor: 'AGENT'},
  {from: 'LIVE',       to: 'SOS', actor: 'AGENT'},
  // Or escalated by Ops watching the feed.
  {from: 'PICKUP', to: 'SOS', actor: 'OPS'},
  {from: 'LIVE',   to: 'SOS', actor: 'OPS'},
  // The CLIENT panic button (sos.service) raises SOS on the principal's behalf; the server
  // performs it, so it is modelled as SYSTEM. Same from-states as the agent path.
  {from: 'DISPATCHED', to: 'SOS', actor: 'SYSTEM'},
  {from: 'PICKUP',     to: 'SOS', actor: 'SYSTEM'},
  {from: 'LIVE',       to: 'SOS', actor: 'SYSTEM'},

  // SOS resolution paths — false alarm returns to LIVE, completion proceeds.
  {from: 'SOS', to: 'LIVE',      actor: 'OPS'},
  {from: 'SOS', to: 'LIVE',      actor: 'ADMIN'},
  {from: 'SOS', to: 'COMPLETED', actor: 'AGENT'},
  {from: 'SOS', to: 'COMPLETED', actor: 'OPS'},
  {from: 'SOS', to: 'COMPLETED', actor: 'ADMIN'},

  // Data-repair reconciliation (mission-drift-janitor): an orphaned mission whose booking
  // already reached COMPLETED is closed COMPLETED. SYSTEM-only; never a real user finish.
  {from: 'DISPATCHED', to: 'COMPLETED', actor: 'SYSTEM'},
  {from: 'PICKUP',     to: 'COMPLETED', actor: 'SYSTEM'},
  {from: 'LIVE',       to: 'COMPLETED', actor: 'SYSTEM'},
  {from: 'SOS',        to: 'COMPLETED', actor: 'SYSTEM'},
];

// Abort is a universal escape hatch from any non-terminal state. OPS/ADMIN abort by hand;
// SYSTEM aborts are the sweeps (arrival-noshow re-dispatch, drift-janitor, org-mission
// rollbackFailedActivation) tearing down a stuck/orphaned mission.
const ABORTABLE: readonly MissionStatus[] = ['DISPATCHED', 'PICKUP', 'LIVE', 'SOS'];
const ABORTING_ACTORS: readonly MissionActor[] = ['OPS', 'ADMIN', 'SYSTEM'];

@Injectable()
export class MissionStateMachine {
  assert(from: MissionStatus, to: MissionStatus, actor: MissionActor): void {
    if (to === 'ABORTED') {
      if (!ABORTABLE.includes(from)) {
        throw new ForbiddenException(`Cannot abort mission in state ${from}`);
      }
      if (!ABORTING_ACTORS.includes(actor)) {
        throw new ForbiddenException(`Actor ${actor} cannot abort missions`);
      }
      return;
    }
    const ok = TRANSITIONS.some(t => t.from === from && t.to === to && t.actor === actor);
    if (!ok) {
      throw new ForbiddenException(
        `Invalid mission transition ${from} → ${to} for actor ${actor}`,
      );
    }
  }

  nextStates(from: MissionStatus, actor: MissionActor): MissionStatus[] {
    const forward = TRANSITIONS
      .filter(t => t.from === from && t.actor === actor)
      .map(t => t.to);
    if (ABORTABLE.includes(from) && ABORTING_ACTORS.includes(actor)) {
      forward.push('ABORTED');
    }
    return forward;
  }
}
