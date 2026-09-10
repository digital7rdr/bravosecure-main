import type {AccountKind, UserRole} from '@appTypes/index';

/**
 * §35A §B — the post-auth root switch, as a PURE function so it can be unit-tested
 * exhaustively (account_kind × must_set_password × membership_status × legacy role).
 *
 * THE RULE: route off the SERVER-authenticated `account_kind`, never a client-chosen
 * flag (the lesson from the pendingProvider stuck-register bug). `pendingProvider` and
 * the legacy role strings survive ONLY as the agency self-signup fallback — the window
 * before the server flips a fresh provider's account_kind to 'agency'.
 */
export type AuthedRoute =
  | 'access-ended'    // CPO whose agency membership is suspended/removed
  | 'cpo-activation'  // CPO first login (must set password)
  | 'cpo-onboarding'  // CPO whose compliance pack isn't submitted/approved yet
  | 'cpo'             // active CPO → CpoNavigator
  | 'agency'          // agency operator → AgentNavigator
  | 'client';         // individual → client tabs

export interface RouteSignals {
  accountKind?: AccountKind;
  mustSetPassword?: boolean;
  membershipStatus?: string | null;
  /** Server flag: a CPO whose agent record hasn't cleared onboarding (docs/review). */
  cpoNeedsOnboarding?: boolean;
  /** Legacy `users.role` — only consulted for the agency fallback. */
  legacyRole?: UserRole;
  /** In-memory agency self-signup bridge (pendingProvider) — agency fallback only. */
  pendingProvider?: boolean;
  /**
   * Server-resolved: this CPO has ALSO been promoted to manager within their
   * org (mirrors OrgManagerGuard — company account OR an active org_members
   * manager). Promotion is an org-level role layered on top of account_kind
   * ('cpo' never changes to 'agency' on promotion — only the owner truly
   * owns the org) — so a promoted manager routes into the SAME AgentNavigator
   * dashboard the owner uses, tabs unfiltered for now. A demote (this flips
   * back false) naturally re-resolves to 'cpo' on the next render — no
   * separate redirect needed, since this is derived, not stored, state.
   */
  isOrgManager?: boolean;
  /**
   * vs2 item 4 — does this person belong to ANY workspace, as owner or member?
   *
   * A revoked CPO membership used to mean the account had nowhere left to be,
   * so it routed to `access-ended`. Multi-org broke that equivalence: Chidi is
   * an officer at agency Meridian AND an employee of workspace Acme. Meridian
   * suspending him says nothing about Acme, and sending him to a dead-end
   * screen locks him out of a company he still works for.
   */
  hasWorkspaceAffiliation?: boolean;
}

export function resolveAuthedRoute(sig: RouteSignals): AuthedRoute {
  const {accountKind, mustSetPassword, membershipStatus, cpoNeedsOnboarding, legacyRole, pendingProvider,
    isOrgManager, hasWorkspaceAffiliation} = sig;

  // CPO is the most restrictive door, and the server account_kind is authoritative.
  if (accountKind === 'cpo') {
    // A suspended/removed CPO must never reach the CPO home (covers boot/login as an
    // already-revoked guard; mid-session revocation is handled by recheckMembership).
    // membership_status is 'active'|'suspended'|'removed'|null/undefined — a truthy
    // non-'active' value is a revocation; null/undefined is treated as active.
    // ...unless they still hold a workspace, in which case the CPO half of
    // their identity ended and the rest of the account carries on. `client` is
    // where a plain workspace employee already lives (the workspace surface
    // hangs off the messenger shell), so this is the same door they would have
    // had if they had never been an officer.
    if (membershipStatus && membershipStatus !== 'active') {
      return hasWorkspaceAffiliation ? 'client' : 'access-ended';
    }
    if (mustSetPassword) {return 'cpo-activation';}
    // A managed CPO is seeded DOCS_PENDING with a compliance pack to upload; send them to
    // the onboarding flow (docs → submit → ops review) until their agent record is ACTIVE.
    // Ordered AFTER must_set_password so a brand-new CPO sets their password first.
    if (cpoNeedsOnboarding) {return 'cpo-onboarding';}
    // A promoted manager sees the full agency dashboard (AgentNavigator), same as the
    // owner — still gated behind the suspension/activation/onboarding checks above.
    if (isOrgManager) {return 'agency';}
    return 'cpo';
  }

  // Agency: the server discriminator OR — only as the self-signup fallback — the legacy
  // role strings / pendingProvider bridge (an account_kind not yet flipped server-side).
  if (
    accountKind === 'agency' ||
    legacyRole === 'agent' ||
    legacyRole === 'service_provider' ||
    pendingProvider === true
  ) {
    return 'agency';
  }

  return 'client';
}
