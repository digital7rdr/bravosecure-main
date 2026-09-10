/**
 * missionAction (BUILD_RUNBOOK Step 21) — the pure selector for the ONE context-aware
 * mission button. Lead-only: a non-lead never gets an advance action (they ride along, read-
 * only, with chat + SOS). Maps the mission FSM state to the single next transition:
 *   DISPATCHED → Arrived at pickup (agentApi.missionPickup,  DISPATCHED→PICKUP)
 *   PICKUP     → Client Picked Up  (agentApi.missionGoLive,  PICKUP→LIVE, deliberate confirm)
 *   LIVE       → Client Dropped Off(agentApi.missionComplete, LIVE→COMPLETED, deliberate confirm)
 *   SOS / COMPLETED / ABORTED / anything else → none
 * Pure → trivially unit-tested; the field screen renders exactly one button from this.
 *
 * The wording is the founder's, from the August 2026 device-feedback deck: the six mission
 * stages are named Assigned / Navigate to pickup / Arrived at pickup / Client Picked Up /
 * Navigate to drop-off / Client Dropped Off. "Go live" described the FSM, not the event the
 * driver is confirming, and a driver confirming that a person is in the vehicle should read
 * the sentence they are attesting to.
 *
 * `confirm` on go-live is required, not cosmetic: PICKUP→LIVE stamps live_at, which drives the
 * proof gate, the pre-LIVE full-refund boundary and the executive check-in schedule. The deck
 * asks for "a deliberate tap and confirmation to prevent accidental activation".
 */
export type MissionAction = 'start' | 'go-live' | 'finish' | 'none';

export interface MissionActionView {
  action: MissionAction;
  label: string;
  /** Require a deliberate swipe-to-confirm (Finish ends the mission + opens settlement). */
  confirm: boolean;
}

export function missionAction(status: string | null | undefined, isLead: boolean): MissionAction {
  if (!isLead) {return 'none';}
  switch ((status ?? '').toUpperCase()) {
    case 'DISPATCHED': return 'start';
    case 'PICKUP':     return 'go-live';
    case 'LIVE':       return 'finish';
    default:           return 'none'; // SOS / COMPLETED / ABORTED — no lead advance
  }
}

export interface MissionActionConfirm {
  title: string;
  body: string;
  cta: string;
  destructive: boolean;
}

/**
 * The confirmation sheet for an action whose view has `confirm: true`. Lives here
 * so the CPO Mission tab and the driver's live tracker put the SAME sentence in
 * front of the officer — the wording is what they are attesting to, and two
 * screens owning two copies is how that drifts.
 */
export function missionActionConfirm(action: MissionAction): MissionActionConfirm | null {
  switch (action) {
    case 'go-live':
      return {
        title: 'Client picked up?',
        body: 'Confirm the client is in the vehicle. This starts protection, tells the Bravo Control System, and switches navigation to the drop-off.',
        cta: 'Client Picked Up',
        destructive: false,
      };
    case 'finish':
      return {
        title: 'Client dropped off?',
        body: 'This ends the detail and releases payment to your agency. Only confirm once the principal is safely handed over.',
        cta: 'Client Dropped Off',
        destructive: true,
      };
    default:
      return null;
  }
}

export function missionActionView(status: string | null | undefined, isLead: boolean): MissionActionView {
  const action = missionAction(status, isLead);
  switch (action) {
    case 'start':   return {action, label: 'Arrived at pickup', confirm: false};
    case 'go-live': return {action, label: 'Client Picked Up', confirm: true};
    case 'finish':  return {action, label: 'Client Dropped Off', confirm: true};
    default:        return {action, label: '', confirm: false};
  }
}
