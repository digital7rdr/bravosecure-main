import {getActiveWorkspace, useActiveWorkspace} from './activeWorkspace';

/**
 * Channels vs2 edge A1/A2 — a server wake names an organisation; point the
 * workspace surface at it BEFORE the tap navigates.
 *
 * ── THE BUG THIS EXISTS FOR ──────────────────────────────────────────────
 *
 * Item 4 made a person able to belong to several organisations, and every
 * org-scoped read is stamped with the ACTIVE workspace (`X-Org-Context`). But
 * nothing on a notification tap ever set that context, so a manager of two orgs
 * who got "Acme: incident reported" read the incident with BOREALIS stamped on
 * the request — `detail()` filters `WHERE id = $1 AND org_user_id = $2`, found
 * nothing, and `IncidentDetailScreen` swallowed the 404 into an empty screen.
 * From a killed app it failed on EVERY tap for a non-default org, because the
 * context is session-only and null at boot. Same mechanism, second door: a
 * two-org admin tapping org-B's "join request waiting" read org-A's inbox.
 *
 * ── WHY THIS IS SAFE ─────────────────────────────────────────────────────
 *
 * Adopting a context client-side can never widen access. The header is a
 * REQUEST, never a grant (`org-context.ts`): the server intersects it with the
 * caller's real memberships and ignores an org they do not hold. We narrow
 * further here anyway — an id that is not in the user's own `workspaces` array
 * is refused outright, so a forged blob cannot even change what the UI asks
 * for.
 *
 * ── WHAT ELSE READS THIS STATE (know before you widen the callers) ───────
 *
 * "Cannot widen access" is an ACCESS argument, and `activeWorkspace` also
 * decides a DESTINATION. `X-Org-Context` is stamped on `attendance/*` and
 * `incidents/*` (`services/api.ts` ORG_SCOPED_PREFIXES), and two of those are
 * writes whose target org the server reads from the header: clock-in
 * (`attendance.service.resolveOrg`) and incident submit
 * (`incident.service.resolveOrg`). So adopting does not merely change what is
 * displayed — a later clock-in files against the adopted org.
 *
 * That is accepted, because every door here NAVIGATES INTO that workspace's
 * own Departmental surface: the user ends up on Borealis's tabs, under
 * Borealis's header, and clocking in there is the honest answer. It is the
 * same contract as entering by a hub tile, which has always been sticky. The
 * hazard to respect is the SEQUENCE — glance at a wake, leave, come back via
 * the drawer — so do NOT extend adoption to any door that does not put the
 * user inside that org's surface. A wake that only shows a banner must not
 * call this.
 *
 * ── WHAT IT DOES NOT COVER ───────────────────────────────────────────────
 *
 * A membership created while the app was KILLED is not in the persisted auth
 * snapshot that a cold tap reads, so the very first wake from a brand-new org
 * degrades to the sticky context until `/auth/me` lands. Self-healing on the
 * next tap; the `[orgctx] wake org not a membership` warn below is how it is
 * recognised on a device rather than guessed at.
 *
 * ── WHY IT IS ONE FUNCTION ───────────────────────────────────────────────
 *
 * THREE doors deliver the same event: the foreground/cold-boot push tap
 * (`fcmBootstrap.routeServerWakeTap`, incident + enterprise lanes) and the
 * durable bell row (`ActivityCenterScreen`) — the lane that carries every
 * delivery which missed the 5-minute blob. One behaviour with N copies is this
 * repo's most-shipped bug, so all three call THIS, and nothing else writes a
 * context from a wake.
 *
 * Lives in its own file rather than in `activeWorkspace.ts` because it needs the
 * auth store, and `activeWorkspace` is imported by `services/api` — the import
 * would close the cycle api → activeWorkspace → authStore → api.
 */

/**
 * The shape the server's own header validator accepts (`readOrgContextHeader`).
 *
 * Lowercase-only, and the id is lowercased before it is tested — NOT an `/i`
 * flag. A case-insensitive validator in front of case-SENSITIVE `===` compares
 * (both the active-context check and the membership lookup, against ids
 * Postgres always emits lowercase) is worse than either: a mixed-case id passes
 * validation and then silently reports `skipped`, which is indistinguishable
 * from "not a member" in the logs.
 */
const ORG_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Which adoption is the LIVE one.
 *
 * Every door runs `adopt → await → navigate`, and the await is real (below), so
 * two taps inside that window interleave: the first chain wakes up holding the
 * SECOND tap's context and deep-links its own id against the wrong org — the
 * exact empty screen this module exists to remove, reintroduced by the fix.
 * A tap also lands on a bell row with no tap guard, so this is a double-tap
 * away, not a stress test.
 *
 * Newest tap wins (the message-wake lane reaches the same conclusion with its
 * `stillOnTapTarget` guard: a tap from seconds ago must never hijack navigation
 * the user has since done themselves).
 */
let adoptionGeneration = 0;

/**
 * B-95 — a context switch does not take effect on the next line.
 *
 * `DepartmentalNavigator` answers an org change by rendering ONE navigator-free
 * frame (~30ms) so React Navigation's deferred cleanup can drop the previous
 * org's stored child state; mounting the replacement in the same commit makes
 * the cleanup skip itself and the new tree rehydrates the OLD org's screens.
 * A deep-link dispatched into that gap targets an unmounted navigator. Waiting
 * out the frame costs an already-async tap nothing and is the difference
 * between landing on the incident and landing on the tab root.
 */
const SWITCH_SETTLE_MS = 120;

export type OrgContextAdoption =
  /** The blob named no org, a malformed one, or one this user does not hold. */
  | 'skipped'
  /** Already looking at that org — nothing written, nothing to wait for. */
  | 'unchanged'
  /** Context switched; the caller may navigate now. */
  | 'adopted'
  /** A LATER tap started while this one was settling. Do NOT navigate. */
  | 'superseded';

/**
 * Point the workspace surface at the organisation a wake names, if it is
 * genuinely one of the user's own. Await it before navigating.
 *
 * Absent / unknown / malformed org id = today's behaviour, unchanged: the tap
 * keeps the sticky context. That is the whole compatibility story — an old
 * server sends no `orgId`, and single-org users never had a second org to be
 * wrong about.
 */
export async function adoptOrgContextFromWake(rawOrgId: unknown): Promise<OrgContextAdoption> {
  // Claimed FIRST, for every outcome: a tap that resolves instantly still has
  // to invalidate an older tap that is mid-settle, or the stale chain navigates
  // on top of it.
  const generation = ++adoptionGeneration;
  if (typeof rawOrgId !== 'string') {return 'skipped';}
  const orgId = rawOrgId.trim().toLowerCase();
  if (!ORG_ID_RE.test(orgId)) {return 'skipped';}
  if (getActiveWorkspace()?.org_id === orgId) {return 'unchanged';}

  // Required at CALL time, not at module top: `authStore` pulls in `services/api`
  // (axios, AsyncStorage, supabase), and `fcmBootstrap` is loaded by the
  // headless background handler on a cold process.
  const {useAuthStore} = require('@/store/authStore') as typeof import('@/store/authStore');
  const match = useAuthStore.getState().user?.workspaces?.find(w => w.org_id === orgId);
  // Undefined `workspaces` (older server, or /auth/me not landed yet) reads the
  // same as "not a member" ON PURPOSE — never adopt an org we cannot vouch for.
  if (!match) {
    // Release-visible: this is the ONE outcome that looks identical to "the
    // feature is not working" (stale cold-boot snapshot vs a genuine
    // non-membership, e.g. an agency org, which is a correct skip).
    console.warn(`[orgctx] wake org not a membership org=${orgId.slice(0, 8)}`);
    return 'skipped';
  }

  useActiveWorkspace.getState().setActiveWorkspace({
    org_id: match.org_id, name: match.name, role: match.role,
  });
  // WARN, not log: `transform-remove-console` strips `log` in release, and this
  // lane's failures are exactly the ones that are invisible on a device.
  console.warn(`[orgctx] wake adopted org=${orgId.slice(0, 8)} role=${match.role}`);

  /**
   * Yield ONCE before starting the clock.
   *
   * The held frame's own 30ms timer does not exist yet at this line — it is
   * scheduled by an effect that runs only after React commits the re-render
   * this write just triggered. Starting a 120ms timer in the same tick means
   * both are racing from different origins, and under this repo's documented
   * JS-thread stalls (350-500ms per send, 4-6s `PerfMonitor longMsg`) the
   * commit can land AFTER our timer has already fired — navigating into the
   * gap we are waiting for. One macrotask boundary lets the commit and its
   * effect happen first, so the two timers are ordered by their constants
   * rather than by thread luck.
   */
  await new Promise(r => setTimeout(r, 0));
  await new Promise(r => setTimeout(r, SWITCH_SETTLE_MS));
  if (generation !== adoptionGeneration) {
    console.warn(`[orgctx] adoption superseded org=${orgId.slice(0, 8)}`);
    return 'superseded';
  }
  return 'adopted';
}
