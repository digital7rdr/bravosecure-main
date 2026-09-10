/**
 * sqa.md bug register — this suite pins: B-248.
 *
 * B-248 (the manager dashboard rendered as a solo CPO — every client-side manager
 * discriminator was false for a real manager) is the same defect this suite already tracks
 * through B-215/B-216: a delegated manager is a PROMOTED CPO, so ACCOUNT_KIND_SQL's cpo
 * precedence pins account_kind=cpo and BOTH the original account_kind===cpo check and
 * B-215's account_kind===agency && user.org replacement were always false.
 */
/**
 * B-215 — AgentDashboardScreen's org-detection checked `user?.account_kind
 * === 'cpo'` to spot a delegated manager. But deriveAccountKind
 * (account-kind.ts) gives a delegated manager account_kind 'agency', NOT
 * 'cpo' — isActiveManager routes into the same branch as isCompanyAgent.
 * The check was ALWAYS false for every real manager (three copies of the
 * same wrong string in this file), so a manager:
 *   - fell back to their own PERSONAL agents-row rating/jobs_total instead
 *     of the agency's (orgScoped gate at the capacity poll — founder
 *     report: "rating and 2 jobs are wrong ... in the manager account").
 *   - landed on the solo-CPO personal dashboard layout instead of the org
 *     layout (isPromotedManager -> isOrg).
 *   - showed "(AGENT)" instead of "(Manager)" next to their name — visible
 *     directly in the founder's own screenshot header text.
 *
 * B-215's fix was `account_kind === 'agency' && !!user?.org`, and it was ALSO
 * always false — for a different reason, which is why this file kept passing
 * while the founder's screenshot still showed "(AGENT)". A delegated manager
 * is a PROMOTED CPO, so `agents.managed_by_org_id` is set and
 * ACCOUNT_KIND_SQL's deliberate cpo precedence pins account_kind='cpo'. The
 * 'agency' branch is only reached by a manager who was never a managed CPO.
 * Confirmed against production: owner "Agent Due" = {agency, org:null},
 * manager "CPO 1" = {cpo, org:'Agent Due'} — the test matched NEITHER.
 *
 * The intent below is right and is kept; only the shape it asserts is
 * superseded. It is now the server-computed `managed_org`, which reads the
 * org_members manager row directly, so the client cannot get it wrong again.
 * See managerModuleGrants.test.ts for the full contract.
 *
 * Also new in this pass: NEXT ON OPS previously only ever showed the
 * VIEWER'S OWN personal mission, which never applies to an org account (the
 * owner/manager isn't personally crewed) — always read "No active mission"
 * even with a full board running. Added a compact preview sourced from
 * orgApi.listMissions() (same source OrgMissionsScreen already uses).
 *
 * This screen can't be imported by the node `booking` project (native
 * deps: geolocation, drawer animation, etc.), so both are pinned by
 * reading the source — same pattern as assignCrewFilter.test.ts.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const SCREEN = join(process.cwd(), 'src', 'screens', 'agent', 'AgentDashboardScreen.tsx');

function source(): string {
  return readFileSync(SCREEN, 'utf8').replace(/\r\n/g, '\n');
}
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe("B-215 — org-account detection uses account_kind 'agency', not 'cpo' (static source scan)", () => {
  it('never checks account_kind against the wrong literal anywhere in the file', () => {
    const src = stripComments(source());
    expect(src).not.toMatch(/account_kind === 'cpo'/);
  });

  it('orgScoped (capacity/rating/jobs poll gate) reuses the one discriminator', () => {
    // Was: asserted an inline `account_kind === 'agency' && !!user?.org` here.
    // Inlining it is how three copies drifted; it now reads the shared flag,
    // so the manager's org data is fetched at all.
    const src = stripComments(source());
    const start = src.indexOf('const orgScoped = ');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf(';', start);
    const body = src.slice(start, end);
    expect(body).toMatch(/isPromotedManager/);
    expect(body).not.toMatch(/account_kind/);
  });

  it('isPromotedManager (drives isOrg / the whole org layout) comes from the server', () => {
    const src = stripComments(source());
    const start = src.indexOf('const isPromotedManager = ');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf(';', start);
    const body = src.slice(start, end);
    expect(body).toMatch(/!!managedOrg/);
    // Neither superseded client-side derivation may return anywhere.
    expect(src).not.toMatch(/account_kind === 'agency' && !!user\?\.org/);
  });

  it('the "(Manager)" header label reuses isPromotedManager instead of re-deriving it a third time', () => {
    const src = stripComments(source());
    expect(src).toMatch(/\$\{isPromotedManager \? 'Manager' : 'AGENT'\}/);
  });
});

describe('B-215 — NEXT ON OPS shows the org mission board for org accounts (static source scan)', () => {
  it('fetches orgApi.listMissions() in the org-scoped poll effect', () => {
    const src = stripComments(source());
    expect(src).toMatch(/orgApi\.listMissions\(\)/);
  });

  it('renders a compact preview of IN-PROGRESS missions (needs_crew + active) when there is no personal active mission', () => {
    const src = stripComments(source());
    expect(src).toMatch(/isOrg && orgOpsPreview\.length > 0/);
    expect(src).toMatch(/\.\.\.orgMissions\.needs_crew, \.\.\.orgMissions\.active/);
  });

  it("B-216 — never falls back to FINISHED missions when nothing is in progress (founder correction: a completed mission is not 'next on ops')", () => {
    const src = stripComments(source());
    expect(src).not.toMatch(/orgMissions\.recent/);
  });

  it('each preview row shows the lead name and status on one line and opens OrgMissionDetail', () => {
    const src = stripComments(source());
    const start = src.indexOf('isOrg && orgOpsPreview.length > 0 ? (');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf(') : (', start);
    const body = src.slice(start, end);
    expect(body).toMatch(/lead\.call_sign/);
    // NAV-10 (2026-08-26) — the row press dispatches through navigateOnce now.
    expect(body).toMatch(/navigateOnce\(navigation, 'OrgMissionDetail', \{job\}\)/);
  });
});
