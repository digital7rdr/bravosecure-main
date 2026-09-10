import {BadRequestException} from '@nestjs/common';

/**
 * Protection-session finite state machine (spec §3). The backend is the single
 * source of truth for session state — the client shows "Starting protection…"
 * until the backend confirms ACTIVE, never on optimism (edge N).
 *
 *              create                first accepted fix / activate ack
 *   (no row) ─────────► REQUESTED ──────────────────────────────► ACTIVE
 *                          │                                          │
 *                          │ activation failure / no-fix timeout      │ customer|ops end
 *                          ▼                                          │ 12h max-duration
 *                       ABORTED                    ENDING ◄───────────┘
 *                    (failed_activation)              │
 *                                                     ▼
 *                                                 COMPLETED
 *
 * ENDING is transient + idempotent: the backend collapses live→COMPLETED in one
 * guarded UPDATE (repeated end calls are no-ops). COMPLETED/ABORTED are terminal.
 */
export type ProtectionSessionStatus =
  | 'REQUESTED' | 'ACTIVE' | 'ENDING' | 'COMPLETED' | 'ABORTED';

/**
 * The three NON-terminal states. This is the SINGLE source for "live" — it
 * pins the DB partial unique index predicate (protection_sessions_one_live_uq),
 * the getCurrent WHERE clause, and the end() guard together so they cannot
 * drift. A customer may hold at most one session in any of these states.
 */
export const LIVE_STATUSES: readonly ProtectionSessionStatus[] = ['REQUESTED', 'ACTIVE', 'ENDING'];

export function isLive(status: string): boolean {
  return (LIVE_STATUSES as readonly string[]).includes(status);
}

/** SQL fragment for the live set, e.g. `status IN ('REQUESTED','ACTIVE','ENDING')`. */
export const LIVE_STATUS_SQL = LIVE_STATUSES.map(s => `'${s}'`).join(',');

const ALLOWED: Record<ProtectionSessionStatus, readonly ProtectionSessionStatus[]> = {
  // First accepted fix flips ACTIVE; end-before-activation and the no-fix
  // timeout are the only other exits.
  REQUESTED: ['ACTIVE', 'ENDING', 'COMPLETED', 'ABORTED'],
  ACTIVE:    ['ENDING', 'COMPLETED'],
  ENDING:    ['COMPLETED'],
  COMPLETED: [],
  ABORTED:   [],
};

export function canTransition(from: ProtectionSessionStatus, to: ProtectionSessionStatus): boolean {
  return ALLOWED[from]?.includes(to) ?? false;
}

export function assertTransition(from: ProtectionSessionStatus, to: ProtectionSessionStatus): void {
  if (!canTransition(from, to)) {
    throw new BadRequestException(`protection_session_bad_transition:${from}->${to}`);
  }
}
