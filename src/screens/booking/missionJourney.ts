/**
 * missionJourney (BUILD_RUNBOOK Step 18 / §25, §28) — the SINGLE source of truth for the
 * mission progress bar, rendered identically on client, agency, and CPO. Pure (no React,
 * no I/O) so it is trivially unit-testable and the three apps can never tell three
 * different stories.
 *
 * Six steps, mapped to the real backing state (verified against the booking + mission
 * FSMs in apps/auth-service):
 *   1 Searching for your detail   — booking DISPATCHING                (advances: system)
 *   2 Accepted · assigning team   — booking CONFIRMED, no mission yet  (advances: agency)
 *   3 Team dispatched             — mission DISPATCHED                 (advances: lead)
 *   4 En route to pickup          — mission PICKUP                     (advances: lead)
 *   5 Protection active           — mission LIVE                       (advances: lead)
 *   6 Completed                   — mission/booking COMPLETED          (advances: none)
 *
 * Off-path: SOS overlays an active step (a ribbon, not a 7th step) — index stays at the
 * active step. CANCELLED / NO_PROVIDER (booking) and ABORTED (mission) are terminal
 * side-states with their own honest rendering.
 */
export type AdvanceActor = 'system' | 'agency' | 'lead' | 'none';
export type SideState = 'CANCELLED' | 'NO_PROVIDER' | 'ABORTED';

export interface JourneyStep {
  /** 1..6 for an on-path step; 0 when nothing is reached yet / a pre-mission cancel. */
  index: number;
  label: string;
  /** Who may advance FROM the current step — lets the CPO field UI gate the lead-only button. */
  canAdvanceBy: AdvanceActor;
  /** True when the mission is in SOS — render a ribbon over the active step. */
  sos: boolean;
  /** Terminal off-path rendering, when set. */
  sideState?: SideState;
}

export const STEP_LABELS = [
  'Searching for your detail',  // 1
  'Accepted · assigning team',  // 2
  'Team dispatched',            // 3
  'En route to pickup',         // 4
  'Protection active',          // 5
  'Completed',                  // 6
] as const;

export const TOTAL_STEPS = STEP_LABELS.length; // 6

const norm = (s: string | null | undefined): string => (s ?? '').toUpperCase();

export function journeyStep(
  booking: {status: string | null | undefined},
  mission?: {status: string | null | undefined} | null,
): JourneyStep {
  const b = norm(booking?.status);
  const m = norm(mission?.status);

  // ── Booking-level terminals first (they outrank any mission state) ──
  if (b === 'COMPLETED') {return step(6, 'none');}
  if (b === 'CANCELLED') {return {index: 0, label: 'Cancelled', canAdvanceBy: 'none', sos: false, sideState: 'CANCELLED'};}
  if (b === 'NO_PROVIDER') {return {index: 1, label: 'No detail available', canAdvanceBy: 'none', sos: false, sideState: 'NO_PROVIDER'};}

  // ── Mission state (takes precedence once a mission exists) ──
  if (m === 'ABORTED') {return {index: 3, label: 'Stood down', canAdvanceBy: 'none', sos: false, sideState: 'ABORTED'};}
  if (m === 'SOS') {return {index: 5, label: STEP_LABELS[4], canAdvanceBy: 'lead', sos: true};}
  if (m === 'COMPLETED') {return step(6, 'none');}
  if (m === 'LIVE') {return step(5, 'lead');}
  if (m === 'PICKUP') {return step(4, 'lead');}
  if (m === 'DISPATCHED') {return step(3, 'lead');}

  // ── Booking non-terminal (no mission yet) ──
  // A legacy ops "Dispatch" flips the booking CONFIRMED→LIVE directly and never
  // creates a mission row. Without this branch such a booking fell through to
  // the pre-dispatch default and rendered "Searching for your detail" while the
  // client's TRACK button was simultaneously enabled — the screen contradicted
  // itself (founder deck page 5: "the dispatch state must be unambiguous").
  if (b === 'LIVE') {return step(5, 'lead');}
  if (b === 'CONFIRMED') {return step(2, 'agency');}
  if (b === 'DISPATCHING') {return step(1, 'system');}

  // Legacy / pre-dispatch (DRAFT / PENDING_OPS / OPS_APPROVED / PAYMENT_PENDING) — the
  // auto stepper isn't the primary surface there; show step 1 with no advance affordance.
  return {index: b === '' ? 0 : 1, label: STEP_LABELS[0], canAdvanceBy: 'none', sos: false};
}

function step(index: number, canAdvanceBy: AdvanceActor): JourneyStep {
  return {index, label: STEP_LABELS[index - 1], canAdvanceBy, sos: false};
}

/**
 * Monotonic clamp (cross-app §34 rule) — a slow poll on one device must never render a
 * LOWER step than already shown. Returns the higher index; a terminal side-state always
 * wins (it is an honest end-state, not a regression).
 */
export function clampJourney(prev: JourneyStep | null | undefined, next: JourneyStep): JourneyStep {
  if (!prev) {return next;}
  if (next.sideState) {return next;}            // terminal end-state overrides
  if (next.index >= prev.index) {return next;}  // forward progress (or same)
  // next regressed below prev (stale poll) — keep prev's index/label/advance, but let a
  // freshly-raised SOS ribbon through (safety signal must never be suppressed).
  return {...prev, sos: prev.sos || next.sos};
}
