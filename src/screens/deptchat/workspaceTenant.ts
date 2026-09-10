import {useAuthStore} from '@store/authStore';

/**
 * Is the CURRENT account operating inside a Bravo enterprise WORKSPACE, as
 * opposed to a service-provider AGENCY?
 *
 * Channels vs2 P3 gates real behaviour on this — a workspace starts clean, gets
 * no auto-#broadcast, and its create form drops the DEPARTMENT and TYPE fields
 * — while the agency tenant keeps every one of today's behaviours, because
 * agency orgs use typed departments for genuine branch scope.
 *
 * ONE definition, exported, because this predicate already existed inline in
 * `ProfileDrawerModal` and in variant forms in `WorkspaceHubScreen`. A third
 * hand-written copy is how this repo's most common defect starts, and here the
 * copies would disagree about a PERMISSION-adjacent question: which fields an
 * admin is shown, and therefore what the server receives.
 *
 * Two flags, not one, and both are needed:
 *   - `owns_workspace` — this user IS the workspace owner;
 *   - `org_is_workspace` — this user is a MEMBER (e.g. a delegated manager) of
 *     an org that is a workspace.
 * A manager who administers channels is the second case, so keying on
 * ownership alone would show them the agency form inside a workspace.
 *
 * ⚠️ This is a PRESENTATION gate. The server re-decides the same question from
 * `org_workspaces.owner_user_id` on every write (`isWorkspaceTenant`), which is
 * the real boundary — a client that lies about its tenant changes what it
 * DISPLAYS, never what it is allowed to do.
 */
export function isWorkspaceTenant(
  user?: {
    owns_workspace?: boolean;
    org_is_workspace?: boolean;
    workspaces?: ReadonlyArray<unknown>;
  } | null,
): boolean {
  /**
   * vs2 item 4 — `workspaces` is the third answer, and for one persona it is
   * the ONLY one.
   *
   * The first two flags both come from the discriminator's single collapsed
   * membership row. Chidi is an officer at agency Meridian and an employee of
   * workspace Acme: the LATERAL pins the Meridian row (its first sort key is
   * the managing org), so `org_is_workspace` is false and he owns nothing —
   * both flags say "not a workspace person" while he is plainly a member of
   * one. The drawer then offers him "Channels" instead of "Workspaces", and
   * since a hub TILE is the only place a workspace context is ever set, and
   * the context is deliberately session-only, one app restart left him unable
   * to re-enter Acme at all.
   */
  return user?.owns_workspace === true
    || user?.org_is_workspace === true
    || (user?.workspaces?.length ?? 0) > 0;
}

export function useIsWorkspaceTenant(): boolean {
  return useAuthStore(st => isWorkspaceTenant(st.user));
}
