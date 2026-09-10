/**
 * F11 — `navigate('Employees')` was SILENTLY DROPPED in the Agent and CPO shells.
 *
 * THE BUG, and it is this repo's most-repeated shape (Issues 18/19, B-251,
 * B-257): `DepartmentChannelsScreen` is registered in TWO places —
 * MessengerNavigator AND DepartmentalNavigator's Channels stack — but its
 * empty-state "add your team" CTA calls `navigation.navigate('Employees')`, and
 * `Employees` was registered in MessengerNavigator ONLY.
 *
 * MainNavigator mounts exactly ONE shell, and the break is per ENTRY PATH, not
 * per shell. AgentNavigator mounts `Departmental` and no MessengerNavigator at
 * all. CpoNavigator DOES mount MessengerNavigator (as its `CpoComms` tab), but
 * it ALSO has its own root `Departmental` route — and entering the workspace
 * that way puts no MessengerNavigator on the ancestor chain either. So the walk
 * from the Channels stack found no `Employees` on any ancestor, the action
 * bubbled to the root and React Navigation dropped it — with no warning in a
 * release build. A primary door, dead, on the two roles that own a team.
 *
 * (An earlier version of this note claimed NEITHER shell mounts
 * MessengerNavigator. That is false for CPO — the fixtures below always modelled
 * the real `Departmental` entry path, so the test was right and only the prose
 * was wrong. Corrected rather than deleted: a comment that misstates the root
 * cause is what sends the next reader to the wrong file.)
 *
 * The fix registers it beside the siblings that same screen opens. These
 * assertions are structural (the registration table) because the failure is
 * structural: nothing throws, nothing logs, the tap simply does nothing.
 */
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';

import {findNavigatorWithRoute, type RouteAwareNavigation} from '../departmentalEntry';

const src = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

/** Build a navigator chain, innermost first — same helper shape as
 *  departmentalEntry.test.ts, mirroring the REAL registrations pinned below. */
function chain(...levels: string[][]): RouteAwareNavigation[] {
  const navs: RouteAwareNavigation[] = levels.map(routeNames => ({
    navigate: jest.fn(),
    getParent: () => undefined,
    getState: () => ({routeNames}),
  }));
  navs.forEach((n, i) => { n.getParent = () => navs[i + 1]; });
  return navs;
}

describe('the Employees route is reachable from every shell that hosts the directory', () => {
  /**
   * THE REGRESSION. Agency: DepartmentChannelsScreen runs inside the Channels
   * stack of the Departmental workspace, which AgentNavigator pushes full-screen.
   * Before the fix the Channels stack had no `Employees` and neither did any
   * ancestor, so this resolved to null — the dropped tap.
   */
  it('AGENT shell (directory inside the workspace) finds a host navigator', () => {
    const [channelsStack] = chain(
      CHANNELS_STACK_ROUTES,
      ['Home', 'Channels', 'Attend', 'Incident', 'Vault'],
      ['AgentDashboard', 'Departmental', 'MessengerHome', 'Chat'],
    );
    expect(findNavigatorWithRoute(channelsStack, 'Employees')).not.toBeNull();
  });

  it('CPO shell (same workspace, different host) finds one too', () => {
    const [channelsStack] = chain(
      CHANNELS_STACK_ROUTES,
      ['Home', 'Channels', 'Attend', 'Incident', 'Vault'],
      ['CpoTabs', 'Departmental'],
    );
    expect(findNavigatorWithRoute(channelsStack, 'Employees')).not.toBeNull();
  });

  it('CLIENT shell (directory as a plain messenger push) is unchanged', () => {
    const [messengerStack] = chain(MESSENGER_STACK_ROUTES);
    expect(findNavigatorWithRoute(messengerStack, 'Employees')).toBe(messengerStack);
  });

  /** Proof the fixture is not tautological: drop the registration and the two
   *  provider shells go dark again, exactly as they were. */
  it('without the registration the provider shells have NO door — the bug', () => {
    const withoutIt = CHANNELS_STACK_ROUTES.filter(r => r !== 'Employees');
    const [channelsStack] = chain(
      withoutIt,
      ['Home', 'Channels', 'Attend', 'Incident', 'Vault'],
      ['AgentDashboard', 'Departmental'],
    );
    expect(findNavigatorWithRoute(channelsStack, 'Employees')).toBeNull();
  });
});

/**
 * The fixtures above are only worth anything if they mirror the app. Derive the
 * route names from the navigator SOURCE, so a future edit that unregisters
 * `Employees` fails here instead of quietly re-opening the bug.
 */
const CHANNELS_STACK_ROUTES  = registeredRoutes('src/navigation/DepartmentalNavigator.tsx', 'ChannelsStack');
const MESSENGER_STACK_ROUTES = registeredRoutes('src/navigation/MessengerNavigator.tsx', 'Stack');

function registeredRoutes(rel: string, prefix: string): string[] {
  // Comments first — a route name mentioned in prose must never count as a
  // registration (this repo's classic false pass).
  const code = src(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  const re = new RegExp(`<${prefix}\\.Screen\\s+name="([A-Za-z]+)"`, 'g');
  return [...code.matchAll(re)].map(m => m[1]);
}

describe('pins the real registrations these fixtures model', () => {
  it("the Departmental shell's Channels stack registers Employees", () => {
    expect(CHANNELS_STACK_ROUTES).toContain('Employees');
    // Beside the siblings the SAME screen opens — if those moved, this should
    // move with them rather than being stranded.
    expect(CHANNELS_STACK_ROUTES).toEqual(expect.arrayContaining([
      'DepartmentChannels', 'DepartmentChat', 'ManageChannels', 'ChannelEditor', 'ChannelMembers',
    ]));
  });

  it('MessengerNavigator still registers it — the shell that never reproduced', () => {
    expect(MESSENGER_STACK_ROUTES).toContain('Employees');
  });

  it('the ONE call site still names the route (it is an id, not a label)', () => {
    // EmployeesScreen's HEADING is the tenant's noun ("CPOs" for a provider) —
    // renaming the route to match the label is the tempting mistake, and it
    // would break every navigate above.
    const dir = src('src/screens/messenger/DepartmentChannelsScreen.tsx')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(dir).toMatch(/navigate\('Employees'\)/);
  });

  it('the DeptChannelsStackParamList declares it, so the navigate typechecks', () => {
    const types = src('src/navigation/types.ts');
    const block = types.slice(
      types.indexOf('export type DeptChannelsStackParamList'),
      types.indexOf('export type DeptAttendStackParamList'),
    );
    expect(block).toMatch(/\bEmployees:/);
  });

  it('no OTHER navigator quietly grew a second Employees copy', () => {
    const dir = join(process.cwd(), 'src', 'navigation');
    const hits = readdirSync(dir)
      .filter(f => f.endsWith('.tsx'))
      .filter(f => /\.Screen\s+name="Employees"/.test(
        readFileSync(join(dir, f), 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/[^\n]*/g, ''),
      ))
      .sort();
    expect(hits).toEqual(['DepartmentalNavigator.tsx', 'MessengerNavigator.tsx']);
  });
});
