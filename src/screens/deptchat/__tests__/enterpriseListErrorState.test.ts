/**
 * F15 — "errors are indistinguishable from empty."
 *
 * Every Enterprise list did `catch { setX([]) }`, so a 403, an expired token and
 * "nothing here yet" all rendered the SAME empty state. That is not cosmetic: it
 * is what makes every other bug in this module get misdiagnosed in the field,
 * because the screen reports success while the request failed.
 *
 * THIS IS A SOURCE SCAN BY NECESSITY AND BY CHOICE.
 *
 *   - By necessity: these screens cannot be imported by a test (navigation,
 *     safe-area, expo-linear-gradient, the API layer) — the same reason
 *     `bottomChrome.test.ts` scans them.
 *   - By choice: this is the repo's duplicate-copy class. ONE behaviour with N
 *     copies, where the bug is always copy N+1. A render test on two screens
 *     cannot see the eleventh list that quietly kept its silent `catch`, so the
 *     gate has to be a sweep over an enumerated list of files.
 *
 * Each screen is checked at its DECISION SITE — the failure branch must set the
 * error, and the render must have a branch for it — not merely for the tokens
 * appearing somewhere in the file.
 *
 * Comments are stripped: every one of these files now explains the rule in prose
 * naming `loadError`.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

/** [label, path-parts]. Add a row here whenever a new Enterprise list ships. */
const LISTS: Array<[string, string[]]> = [
  ['DepartmentChannelsScreen', ['screens', 'messenger', 'DepartmentChannelsScreen.tsx']],
  ['ManageChannelsScreen', ['screens', 'deptchat', 'ManageChannelsScreen.tsx']],
  ['ChannelMembersScreen', ['screens', 'deptchat', 'ChannelMembersScreen.tsx']],
  ['EmployeesScreen', ['screens', 'deptchat', 'EmployeesScreen.tsx']],
  ['ApprovalsScreen', ['screens', 'deptchat', 'ApprovalsScreen.tsx']],
  ['MyIncidentsScreen', ['screens', 'deptchat', 'MyIncidentsScreen.tsx']],
  ['IncidentQueueScreen', ['screens', 'deptchat', 'IncidentQueueScreen.tsx']],
  ['MyAttendanceScreen', ['screens', 'deptchat', 'MyAttendanceScreen.tsx']],
  ['ShiftManagementScreen', ['screens', 'deptchat', 'ShiftManagementScreen.tsx']],
  ['DayStatusScreen', ['screens', 'deptchat', 'DayStatusScreen.tsx']],
  ['MonthlyRosterScreen', ['screens', 'deptchat', 'MonthlyRosterScreen.tsx']],
  ['CorrectionsScreen', ['screens', 'deptchat', 'CorrectionsScreen.tsx']],
];

function code(parts: string[]): string {
  return readFileSync(join(process.cwd(), 'src', ...parts), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .split('\n')
    .filter(l => !l.trim().startsWith('//'))
    .join('\n');
}

describe('F15 — every Enterprise list can tell failure from emptiness', () => {
  it('the sweep is not vacuous', () => {
    expect(LISTS.length).toBeGreaterThanOrEqual(10);
    for (const [, parts] of LISTS) {
      expect(code(parts).length).toBeGreaterThan(1000);
    }
  });

  it.each(LISTS)('%s records WHY the load failed instead of swallowing it', (_label, parts) => {
    const src = code(parts);
    // The decision site: the failure branch must bind the error and translate
    // it. `catch {` with no binding cannot — which is exactly what was there.
    expect(src).toMatch(/catch \(e\)[\s\S]{0,240}?setLoadError\(loadErrorText\(e\)\)/);
    // …and the success path must CLEAR it, or one transient failure would pin
    // the error state forever, including across a successful pull-to-refresh.
    expect(src).toMatch(/setLoadError\(null\)/);
  });

  it.each(LISTS)('%s renders a distinct failure branch with a retry', (_label, parts) => {
    const src = code(parts);
    // A branch on the error that renders the shared component — not an
    // `Alert.alert` (which vanishes and leaves the empty state behind) and not
    // a bare message with no way forward.
    // `loadError` may now be QUALIFIED. A screen that keeps its rows through a
    // blip shows a strip above them and takes the screen over only when there
    // is nothing behind it — blanking a list the user is reading is its own
    // defect. The rule under test is still "a branch on the error renders the
    // shared component", not "the branch tests loadError alone".
    expect(src).toMatch(/loadError[^?]{0,60}\?[\s\S]{0,300}?<ErrorState/);
    expect(src).toMatch(/<ErrorState[\s\S]{0,200}?onRetry=/);
    // …and the retry must RE-RUN THE LOADER. `onRetry={() => {}}` satisfied the
    // assertion above while doing nothing, which is precisely the decorative
    // fix this test exists to refuse: an error state you cannot get out of is
    // the silent-failure bug wearing a label. Anchored on the handler body, so
    // a no-op or a handler that only flips the spinner fails.
    expect(src).toMatch(/<ErrorState[^>]*onRetry=\{\(\) => \{[^}]*void \w+\(/);
  });

  it.each(LISTS)('%s uses the shared kit, not its own visual language', (_label, parts) => {
    // DESIGN_REVIEW_LOOP G8. A per-screen error card would drift, and a
    // per-screen error MESSAGE would drift faster — 403 must read the same
    // everywhere or a field report cannot be matched to a cause.
    const src = code(parts);
    expect(src).toMatch(/import \{[^}]*\bErrorState\b[^}]*\} from '(\.\/_obsidian|@screens\/deptchat\/_obsidian)'/);
    expect(src).toMatch(/import \{[^}]*\bloadErrorText\b[^}]*\} from '(\.\/_obsidian|@screens\/deptchat\/_obsidian)'/);
  });
});

describe('F15 — the shared translator distinguishes the cases that matter', () => {
  const KIT = code(['screens', 'deptchat', '_obsidian.tsx']);

  it('offline, denied, and server-error are three different answers', () => {
    // A single "Something went wrong" would re-create the bug one level up:
    // "check your network" and "ask an admin to approve you" are different
    // actions, and the field tester has to be able to tell them apart.
    const fn = KIT.slice(KIT.indexOf('export function loadErrorText'), KIT.indexOf('export function ErrorState'));
    expect(fn.length).toBeGreaterThan(200);
    // No response at all is the OFFLINE case — axios rejects without one — and
    // must not be reported as a server error.
    expect(fn).toMatch(/status === undefined/);
    expect(fn).toMatch(/status === 401 \|\| status === 403/);
    expect(fn).toMatch(/status >= 500/);
  });

  it('the raw server message is a last resort, not the headline', () => {
    // The server's `message` is a code (`user_not_found`,
    // `cpo_not_active_member_of_org`) meant for a switch, not for a human.
    const fn = KIT.slice(KIT.indexOf('export function loadErrorText'), KIT.indexOf('export function ErrorState'));
    const statusAt = fn.indexOf('status === 401');
    const rawAt = fn.indexOf('response?.data?.message');
    expect(statusAt).toBeGreaterThan(-1);
    expect(rawAt).toBeGreaterThan(statusAt);
  });

  it('ErrorState is built from the obsidian kit and offers the retry', () => {
    const fn = KIT.slice(KIT.indexOf('export function ErrorState'));
    expect(fn).toMatch(/<Card style=\{k\.errorCard\}/);
    expect(fn).toMatch(/onRetry \?[\s\S]{0,240}?<GhostButton label="Try again"/);
    // …and it must be able to SAY it is retrying. Without that, every caller
    // reinvents the acknowledgement — or, as happened here, flips a flag the
    // error branch does not read and ships a retry button that looks dead for
    // the whole request timeout.
    expect(fn).toMatch(/busy\?: boolean/);
  });
});
