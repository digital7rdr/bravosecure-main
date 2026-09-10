import {create} from 'zustand';

/**
 * Phase B (owner-join, founder-approved 2026-08-09) — WHICH workspace the
 * Departmental surface is currently scoped to.
 *
 * Null = "primary" (today's behaviour everywhere): the server resolves the
 * org from the caller's identity, exactly as before Phase B. Only the
 * Workspace Hub sets a context, when the user explicitly enters a workspace
 * tile — so every pre-existing entry point (drawer, CPO shells, notification
 * taps) is untouched by construction.
 *
 * DELIBERATELY session-only (not persisted): a stale context surviving a
 * restart could point the dept UI at a workspace the user was removed from
 * while the app was closed; booting to the primary org is the safe default.
 * Sticky within a session (Discord remembers your last server) — entering a
 * different tile or signing out replaces/clears it.
 *
 * Role rides along so `useIsManager` can render the RIGHT chrome per
 * workspace: an owner browsing a workspace they joined as an employee must
 * get the member UI, not manager chrome pointed at their own org's data.
 */
export interface ActiveWorkspace {
  org_id: string;
  name: string;
  role: 'owner' | 'manager' | 'employee' | 'cpo';
}

interface ActiveWorkspaceState {
  workspace: ActiveWorkspace | null;
  setActiveWorkspace: (w: ActiveWorkspace | null) => void;
}

export const useActiveWorkspace = create<ActiveWorkspaceState>(set => ({
  workspace: null,
  setActiveWorkspace: w => set({workspace: w}),
}));

/** Non-hook read for handlers/effects. */
export function getActiveWorkspace(): ActiveWorkspace | null {
  return useActiveWorkspace.getState().workspace;
}

/** Sign-out / account-switch hygiene: a context must never outlive its user. */
export function clearActiveWorkspace(): void {
  useActiveWorkspace.getState().setActiveWorkspace(null);
}

/**
 * ONE scoping rule for every dept-surface channel list (channels directory,
 * home dashboard, vault shelf, unread badge) — never copy this inline
 * (duplicate-copy bug class). Fail-open by construction: no context, or rows
 * from an old server that lack org_id, pass through untouched — which is
 * exactly today's single-org behaviour.
 *
 * NOT for the messenger-list dept filters (MessengerHome/Groups/
 * useDeptConversationFilter): those must see EVERY workspace's dept group
 * ids, or the other workspace's channels leak into messenger lists.
 */
export function scopeChannelsToActiveWorkspace<T extends {org_id?: string}>(channels: T[]): T[] {
  const active = getActiveWorkspace();
  if (!active) {return channels;}
  return channels.filter(c => !c.org_id || c.org_id === active.org_id);
}

/** Query param for departmentApi.listChannels on the scoped surfaces. */
export function activeWorkspaceOrgParam(): {orgId: string} | undefined {
  const active = getActiveWorkspace();
  return active ? {orgId: active.org_id} : undefined;
}

/**
 * THE one context-role predicate (critic MAJOR-1/2 — three inline copies of
 * this rule would be the repo's duplicate-copy class; every consumer calls
 * this).
 *
 * Null = no context — the caller falls back to the global flags, exactly the
 * pre-Phase-B behaviour.
 *
 * ── THE owns_workspace CLAUSE IS GONE (vs2 item 4) ──────────────────────────
 *
 * It used to read `active.role === 'manager' && !ownsWorkspace`, and that was
 * correct while it lasted: OrgManagerGuard's owner arm (Path 1b) returned the
 * owner's OWN org before it ever reached the delegated-manager arm, so manager
 * chrome inside somebody else's workspace would have read and written the
 * wrong company's data.
 *
 * Item 4 changed exactly that precedence. The owner arm no longer
 * short-circuits when a context is named, so Priya — who owns Acme and is a
 * delegated manager of Borealis — now genuinely IS Borealis's manager
 * server-side while viewing Borealis. The stale clause left her looking at the
 * EMPLOYEE surface: Attend rooted at Attendance instead of AdminAttendance,
 * Incidents at the report form instead of the queue, every manager card and
 * the module sheet hidden. The headline persona of the founder's Option A
 * decision, locked out of the thing the decision granted her.
 *
 * A mirror of a server rule has to move when the server rule moves — which is
 * why the parameter stays in the signature and is now explicitly unused rather
 * than being deleted: the next person to reach for it should read this first.
 */
export function contextManagerRole(
  active: ActiveWorkspace | null,

  _ownsWorkspace: boolean,
): boolean | null {
  if (!active) {return null;}
  return active.role === 'owner' || active.role === 'manager';
}
