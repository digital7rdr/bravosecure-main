/**
 * Channels vs2 item 17b — which workspace modules the home screen advertises.
 *
 * ONE rule, consumed by every surface that offers Attendance or Incidents. There
 * are FOUR of them and they are easy to miss, which is exactly why this is a
 * module and not an inline check:
 *
 *   1. the quick-action grid on Departmental Home
 *   2. the alert tiles above it
 *   3. the member "Today's attendance" card
 *   4. the "Attendance & Incidents" row on the channels directory
 *
 * Miss one and the module is "hidden" while still being offered from somewhere
 * else — which is worse than not hiding it, because now the app disagrees with
 * itself about what this workspace does.
 *
 * ⚠️ HIDING IS PRESENTATION, NEVER A PERMISSION. Routes stay registered and
 * every server guard is unchanged. A deep link, a push tap or a back-stack entry
 * must still work: notifications already in flight when an admin hides a card
 * would otherwise dead-end. Nothing here may ever be used to decide access.
 */
export type WorkspaceModule = 'attendance' | 'incidents';

/**
 * The response shape. `orgUserId` is echoed by the server and is the ONLY key
 * worth storing against — see `hiddenModulesFor`.
 */
export interface WorkspaceSettings {
  orgUserId: string | null;
  hiddenModules: string[];
  /**
   * PDF checklist line 9 — admin-chosen hierarchy tier names, indexed by
   * DISPLAY tier. Optional because an older server omits it; `nameForTier`
   * reads absent/short/blank as "use the built-in vocabulary", so every org
   * that has chosen nothing is unchanged.
   */
  levelNames?: string[];
}

/**
 * Is this module advertised?
 *
 * FAILS OPEN on every unknown: no settings loaded yet, a request that failed, a
 * server too old to answer, a value nobody recognises. `undefined → visible` is
 * the whole safety story — a workspace that cannot reach the server shows the
 * app it had yesterday rather than an emptied home screen, and a fetch blip can
 * never make a module disappear.
 */
export function moduleVisible(
  settings: WorkspaceSettings | null | undefined,
  module: WorkspaceModule,
): boolean {
  // `Array.isArray`, not just a null check. A 200 with a non-JSON body
  // (captive portal, proxy error page) makes `data` a string, and a server
  // that renames the field makes it undefined — both then threw
  // `.includes of undefined` INSIDE render, on two screens, outside any
  // try/catch. The docblock above promised fail-open for exactly those.
  if (!settings || !Array.isArray(settings.hiddenModules)) {return true;}
  return !settings.hiddenModules.includes(module);
}

/**
 * The settings to apply for the workspace currently on screen.
 *
 * KEYED ON THE ORG THE RESPONSE ECHOES, never on the id the request asked with.
 * `activeWorkspaceOrgParam()` returns undefined before a hub selection — the
 * majority path, covering the drawer, the CPO shell and every notification tap
 * — so a request-keyed store collapses every workspace into one shared bucket
 * precisely where cross-workspace bleed matters most.
 *
 * A mismatch returns null, which `moduleVisible` reads as "show everything":
 * settings belonging to a different workspace must never be applied to this one,
 * and the safe direction is always to show.
 */
export function hiddenModulesFor(
  settings: WorkspaceSettings | null | undefined,
  viewingOrgId: string | null | undefined,
): WorkspaceSettings | null {
  if (!settings) {return null;}
  // No org context at all (the common case) — the response is for whatever the
  // server resolved for this caller, which is the workspace they are in.
  if (!viewingOrgId) {return settings;}
  return settings.orgUserId === viewingOrgId ? settings : null;
}

/**
 * The subtitle for the directory's combined Attendance + Incidents row.
 *
 * That row advertises BOTH modules in one sentence, so hiding one has to
 * narrow the copy as well as keep the row: "Shifts, day status, reviews and the
 * incident queue" over a workspace with no incident queue is the row promising
 * something the tap cannot deliver.
 *
 * Lives beside the visibility rule so the two cannot drift — the wording is
 * part of the hiding behaviour, not decoration on top of it.
 */
export function moduleRowSubtitle(
  isManager: boolean,
  showAttendance: boolean,
  showIncidents: boolean,
): string {
  if (showAttendance && showIncidents) {
    return isManager
      ? 'Shifts, day status, reviews and the incident queue'
      : 'Check in and report incidents';
  }
  if (showAttendance) {
    return isManager ? 'Shifts, day status and reviews' : 'Check in and view your history';
  }
  return isManager ? 'Manage the incident queue' : 'Report an incident';
}

/**
 * The title for that same row. The subtitle moved here and the title did not,
 * which left half the wording inline — the drift this module exists to stop,
 * inside the module's own feature.
 */
export function moduleRowTitle(showAttendance: boolean, showIncidents: boolean): string {
  if (showAttendance && showIncidents) {return 'Attendance & Incidents';}
  return showAttendance ? 'Attendance' : 'Incidents';
}
