/**
 * Audit fix 4.2 — role-based UI gating.
 *
 * Backend already enforces @RequireRoles on every mutation, so this
 * module is UX hygiene rather than security: hide the destructive
 * buttons (approve / reject / dispatch / complete / terminate / payout)
 * from OPS-tier admins so they can't try-and-fail. The 403 from the
 * backend would still block them, but flashing red errors makes the
 * console feel broken.
 *
 * Hierarchy: ADMIN > SUPERVISOR > OPS.
 *   - approve / reject / dispatch / complete / terminate / payout → SUPERVISOR or ADMIN
 *   - shortlist (lightest mutation) → OPS, SUPERVISOR, ADMIN
 *   - read-only → any role
 */

export type AdminRole = 'OPS' | 'SUPERVISOR' | 'ADMIN';

const ROLE_RANK: Record<AdminRole, number> = {OPS: 1, SUPERVISOR: 2, ADMIN: 3};

export function hasRole(actual: AdminRole | undefined | null, atLeast: AdminRole): boolean {
  if (!actual) return false;
  return ROLE_RANK[actual] >= ROLE_RANK[atLeast];
}

export function canApproveBooking(role: AdminRole | undefined): boolean {
  return hasRole(role, 'SUPERVISOR');
}
export function canRejectBooking(role: AdminRole | undefined): boolean {
  return hasRole(role, 'SUPERVISOR');
}
export function canDispatchBooking(role: AdminRole | undefined): boolean {
  return hasRole(role, 'SUPERVISOR');
}
export function canCompleteBooking(role: AdminRole | undefined): boolean {
  // Includes the payout override path.
  return hasRole(role, 'SUPERVISOR');
}
export function canAdjustWallet(role: AdminRole | undefined): boolean {
  // Manual BC grant/deduction — mirrors the backend @RequireRoles on
  // POST /ops/wallets/:userId/adjust.
  return hasRole(role, 'SUPERVISOR');
}
export function canResolveDispute(role: AdminRole | undefined): boolean {
  // Audit RS-15 — resolve a disputed escrow hold. Mirrors the backend
  // @RequireRoles('SUPERVISOR','ADMIN') on POST /ops/disputes/:id/resolve.
  // Previously the Resolve button borrowed canAdjustWallet; its own
  // capability lets the two diverge without a silent gating regression.
  return hasRole(role, 'SUPERVISOR');
}
export function canTerminateAgent(role: AdminRole | undefined): boolean {
  return hasRole(role, 'SUPERVISOR');
}
export function canDecideAgent(role: AdminRole | undefined): boolean {
  // Approve/reject an agent application.
  return hasRole(role, 'SUPERVISOR');
}
export function canShortlistAgent(role: AdminRole | undefined): boolean {
  // Lightest mutation — kept open to OPS.
  return hasRole(role, 'OPS');
}
export function canRejectApplication(role: AdminRole | undefined): boolean {
  // CA-06 — mirrors the backend @RequireRoles('SUPERVISOR','ADMIN') on
  // POST /ops/applications/:id/reject (the console gated this at OPS).
  return hasRole(role, 'SUPERVISOR');
}
export function canReviewCompliance(role: AdminRole | undefined): boolean {
  // Audit PAGE-18 — verify/reject provider docs. Backend @RequireRoles on
  // POST /ops/compliance/:id/{verify,reject} is SUPERVISOR/ADMIN.
  return hasRole(role, 'SUPERVISOR');
}

// Audit H4 — mission-control gating. Mirrors the backend @RequireRoles on
// the ops mission/SOS endpoints so the live page hides destructive controls
// an OPS-tier admin can't actually use (avoids try-and-fail 403 flashes).
// Backend: abort / route-select / sos.escalate / sos.resolve all require
// SUPERVISOR; sos.ack carries no role requirement (any authenticated admin).
export function canAbortMission(role: AdminRole | undefined): boolean {
  return hasRole(role, 'SUPERVISOR');
}
export function canCompleteMission(role: AdminRole | undefined): boolean {
  return hasRole(role, 'SUPERVISOR');
}
export function canReroute(role: AdminRole | undefined): boolean {
  return hasRole(role, 'SUPERVISOR');
}
export function canEscalateSos(role: AdminRole | undefined): boolean {
  return hasRole(role, 'SUPERVISOR');
}
export function canResolveSos(role: AdminRole | undefined): boolean {
  return hasRole(role, 'SUPERVISOR');
}
export function canAckSos(role: AdminRole | undefined): boolean {
  // Acknowledging an active SOS is open to any admin on shift — speed
  // matters more than tier for "I see it, responding".
  return hasRole(role, 'OPS');
}

// Step 26 — dispatch monitor overrides. Backend @RequireRoles: cancel + force-assign
// require SUPERVISOR; the runtime kill switch requires ADMIN.
export function canCancelDispatch(role: AdminRole | undefined): boolean {
  return hasRole(role, 'SUPERVISOR');
}
export function canForceAssign(role: AdminRole | undefined): boolean {
  return hasRole(role, 'SUPERVISOR');
}
export function canFlipKillswitch(role: AdminRole | undefined): boolean {
  return hasRole(role, 'ADMIN');
}

// RS-09 — admin lifecycle (invites + role changes). Backend: the whole
// /ops/admins surface is @RequireRoles('ADMIN') class-wide.
export function canManageAdmins(role: AdminRole | undefined): boolean {
  return hasRole(role, 'ADMIN');
}

// Issue 28 — mint / deactivate partner referral codes. Mirrors the backend
// @RequireRoles('SUPERVISOR','ADMIN') on POST/PATCH /ops/referral-codes;
// the list stays readable by any admin.
export function canManageReferralCodes(role: AdminRole | undefined): boolean {
  return hasRole(role, 'SUPERVISOR');
}

// Bravo Secure Pro applications — create proposal / reject mirror the backend
// @RequireRoles('SUPERVISOR','ADMIN') on POST /ops/pro-applications/:id/*.
// Notes + thread replies stay open to OPS (read/annotate, no decision).
export function canDecideProApplication(role: AdminRole | undefined): boolean {
  return hasRole(role, 'SUPERVISOR');
}
