/**
 * Static source-scan guard for Issues 18 and 19 (Testing Issues V2, pp.23–24) —
 * "Departmental Chat Entry Card Does Not Open" and "Attendance and Incidents
 * Entry Does Not Open Across Dashboards".
 *
 * HISTORY — read this before "simplifying" the assertions below.
 *
 * The first pass on these two issues could not reproduce either symptom from
 * source and said so honestly: it removed the `as never` casts (which switch
 * route-name checking OFF) and pinned every target as registered, but left the
 * cause open pending a device repro.
 *
 * The cause was in source after all, and the casts were hiding it. GroupsScreen
 * is registered in TWO shells — MessengerNavigator AND AgentNavigator — but
 * `DepartmentChannels` is registered in MessengerNavigator ONLY. MainNavigator
 * renders exactly one shell at a time, so for a service-provider account in the
 * Agent shell there was no such route anywhere in the mounted tree: the
 * navigate found no target, bubbled to the root and was DROPPED. Silent in a
 * release build. It typechecked because the screen types its navigation as
 * `MessengerStackParamList` at BOTH mount points — TS validated the route
 * against a param list only one of the two shells implements.
 *
 * The fix is the shared resolver in `src/navigation/departmentalEntry.ts`,
 * whose behaviour (per shell, per role) is covered by
 * `src/navigation/__tests__/departmentalEntry.test.ts`. This file's remaining
 * job is to keep the call sites honest: no screen hosted by more than one
 * navigator may hard-code a shell-specific route name again.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = process.cwd();

function code(rel: string): string {
  const src = readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  const out: string[] = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (inBlock) { if (t.includes('*/')) {inBlock = false;} continue; }
    if (t.startsWith('/*') || t.startsWith('{/*')) { if (!t.includes('*/')) {inBlock = true;} continue; }
    if (t.startsWith('*') || t.startsWith('//')) {continue;}
    out.push(line.replace(/([^:'"`])\/\/.*$/, '$1'));
  }
  return out.join('\n');
}

describe('Issue 18 — the Departmental Chat card', () => {
  const GROUPS = 'src/screens/messenger/GroupsScreen.tsx';
  // Founder 2026-08-05 — the entry MOVED from the Groups screen to the profile
  // drawer. The Issue-18 invariant is unchanged and still asserted, just at its
  // new home: the destination must be RESOLVED against the mounted shell,
  // because the drawer is hosted by the messenger, booking AND VBG shells and
  // only the messenger stack registers 'DepartmentChannels'.
  const DRAWER = 'src/components/ProfileDrawerModal.tsx';

  it('resolves the destination against the MOUNTED shell, never a fixed name', () => {
    const src = code(DRAWER);
    // Q4 — the drawer passes preferHome so a workspace member/owner lands on
    // the Home dashboard; non-members keep the directory (gate + upsell).
    expect(src).toMatch(/openDepartmentChannels\(navigation, \{preferHome: entitlements\.isOrgAffiliated\}\)/);
    // The exact call that was dead in the Agent shell.
    expect(src).not.toMatch(/navigate\('DepartmentChannels'\)/);
  });

  it('is GONE from the Groups screen (moved, not duplicated)', () => {
    const src = code(GROUPS);
    expect(src).not.toMatch(/Departmental Chat/);
    expect(src).not.toMatch(/openDepartmentChannels/);
  });

  it('has no `as never` navigation left on this screen at all', () => {
    // The cast is the mechanism, not the instance — one left behind re-opens
    // the hole for the next route, and it is what let this bug typecheck.
    expect(code(GROUPS)).not.toMatch(/navigate\([^)]*as never/);
  });

  it('DepartmentChannels is registered in the shell that CAN host it directly', () => {
    expect(code('src/navigation/MessengerNavigator.tsx')).toMatch(/name="DepartmentChannels"/);
  });

  it('and the Agent shell — which hosts Groups too — still has a door', () => {
    // Not DepartmentChannels: AgentNavigator deliberately enters the full
    // workspace shell. The resolver's job is to know the difference.
    const agent = code('src/navigation/AgentNavigator.tsx');
    expect(agent).toMatch(/name="Groups"/);
    expect(agent).toMatch(/name="Departmental"/);
  });

  it('a NON-entitled account gets a real message, never a dead tap', () => {
    const src = code(DRAWER);
    expect(src).toMatch(/showEnterpriseUpgradePrompt\(\{onViewPlans: openPricing\}\)/);
    // And that helper must actually raise a dialog.
    expect(code('src/store/entitlements.ts')).toMatch(/showEnterpriseUpgradePrompt[\s\S]{0,200}Alert\.alert/);
  });
});

describe('Issue 19 — the Attendance and Incidents card', () => {
  const DEPT = 'src/screens/messenger/DepartmentChannelsScreen.tsx';

  it('routes through the shared resolver, not a bare navigate', () => {
    const src = code(DEPT);
    expect(src).toMatch(/openAttendance\(navigation\)/);
    // This landed on the shell's default Home tab, not Attendance.
    expect(src).not.toMatch(/navigate\('Departmental'\)/);
  });

  it('the shell probe walks the WHOLE ancestor chain, not one level', () => {
    const src = code(DEPT);
    expect(src).toMatch(/isInDepartmentalShell\(navigation\)/);
    // A single-level getParent() probe reads false in any deeper nesting, and a
    // false reading re-enters a shell the user is already looking at.
    expect(src).not.toMatch(/navigation\.getParent\(\)/);
    expect(src).not.toMatch(/routeNames\?\.includes/);
  });

  it('and the card is still hidden once already inside that shell', () => {
    expect(code(DEPT)).toMatch(/\{!inDepartmentalShell && \(/);
  });

  it("'Attend' is a real tab in the shell the resolver targets", () => {
    expect(code('src/navigation/DepartmentalNavigator.tsx')).toMatch(/name="Attend"/);
  });

  it('every shell that can host this screen registers Departmental', () => {
    for (const nav of ['MessengerNavigator', 'AgentNavigator', 'CpoNavigator']) {
      expect(code(`src/navigation/${nav}.tsx`)).toMatch(/name="Departmental"|name={'Departmental'}/);
    }
  });
});
