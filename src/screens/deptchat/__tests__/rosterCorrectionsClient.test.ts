/**
 * B2 (MonthlyRosterScreen) + C1 (CorrectionsScreen) client contract.
 *
 * These screens mount RN views, so this project scans them as text —
 * comment-stripped (blocks first, then line tails), CRLF-normalised, with
 * fail-closed anchors: every slice asserts it found its landmarks before any
 * absence/presence claim (a missed anchor must fail the test, not pass it).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const DIR = join(process.cwd(), 'src', 'screens', 'deptchat');

function read(p: string): string {
  return readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
}
function strip(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const screen = (f: string) => strip(read(join(DIR, f)));

/** Extract a quoted-string list from `anchor … [ 'a', 'b', … ]`. */
function parseList(src: string, anchorRe: RegExp): string[] {
  const m = src.match(anchorRe);
  expect(m).toBeTruthy();
  return [...(m as RegExpMatchArray)[1].matchAll(/'([a-z_]+)'/g)].map(x => x[1]);
}

describe('C1 — the corrections picker mirrors the server, exactly', () => {
  it('client CORRECTABLE_STATUSES ≡ roster.dto.ts CORRECTABLE_STATUSES (order and all)', () => {
    // DELIBERATELY BRITTLE, like the F13 day-status pin: an 11th status must
    // change the server DTO, the DB CHECK (via roster.spec's toBe(10)) and this
    // client list together, or the picker silently cannot express it.
    const client = parseList(screen('CorrectionsScreen.tsx'),
      /const CORRECTABLE_STATUSES: AttendanceStatusDto\[\] = \[([\s\S]*?)\]/);
    const server = parseList(
      strip(read(join(process.cwd(), 'apps', 'auth-service', 'src', 'attendance', 'dto', 'roster.dto.ts'))),
      /export const CORRECTABLE_STATUSES = \[([\s\S]*?)\]/);
    expect(client.length).toBe(10);
    expect(client).toEqual(server);
  });

  it('AttendanceStatusDto (api.ts) covers every correctable status', () => {
    // Day-status v2 widened the server set while this union silently stayed at
    // 8 — a corrected value of emergency_leave/mission was un-typeable.
    //
    // RAW text, NOT strip(): api.ts contains MIME-glob strings whose /* the
    // block stripper reads as a comment opener, deleting hundreds of real
    // lines including this union (the documented sourceScanSafety trap — it
    // has bitten THIS file before). The union declaration itself contains no
    // comments, so raw is both safe and sufficient.
    const api = read(join(process.cwd(), 'src', 'services', 'api.ts'));
    const m = api.match(/export type AttendanceStatusDto =([\s\S]*?);/);
    expect(m).toBeTruthy();
    const union = [...(m as RegExpMatchArray)[1].matchAll(/'([a-z_]+)'/g)].map(x => x[1]);
    const server = parseList(
      strip(read(join(process.cwd(), 'apps', 'auth-service', 'src', 'attendance', 'dto', 'roster.dto.ts'))),
      /export const CORRECTABLE_STATUSES = \[([\s\S]*?)\]/);
    for (const st of server) {
      expect(`${st}:${union.includes(st)}`).toBe(`${st}:true`);
    }
  });

  it('the reason is mandatory and the after-object sends ONLY changed fields', () => {
    const src = screen('CorrectionsScreen.tsx');
    expect(src).toMatch(/if \(!reason\.trim\(\)\)/);
    // The diff lives in proposedAfter — a change-detecting build, not a dump of
    // the whole form (the server 400s correction_changes_nothing otherwise).
    const start = src.indexOf('const proposedAfter');
    const end = src.indexOf('const submit', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const region = src.slice(start, end);
    expect(region).toMatch(/status !== \(session\.attendance_status \?\? null\)/);
    expect(region).toMatch(/!== toHHMM\(session\.clock_in_at\)/);
  });

  it('open sessions are never offered for correction', () => {
    const src = screen('CorrectionsScreen.tsx');
    expect(src).toMatch(/r\.status !== 'open'/);
  });

  it('the back arrow LEAVES from list mode (the round-1 spinner wedge)', () => {
    // setSession(null) on an already-null session re-renders nothing and the
    // focus effect never re-fires — the visible back control was dead and the
    // screen locked on a spinner.
    const src = screen('CorrectionsScreen.tsx');
    expect(src).toMatch(/if \(!session \|\| cameWithSession\) \{ navigation\.goBack\(\); return; \}/);
  });

  it('clock-out anchors to the EFFECTIVE clock-in and can never precede it', () => {
    // Anchoring to the old clock-out day could not express "pull an overnight
    // end back before midnight" and silently grew the shift ~24h.
    const src = screen('CorrectionsScreen.tsx');
    const start = src.indexOf('const proposedAfter');
    const end = src.indexOf('const submit', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const region = src.slice(start, end);
    expect(region).toMatch(/\?\? session\.clock_in_at/);
    expect(region).toMatch(/Date\.parse\(iso\) <= Date\.parse\(effIn\)/);
    expect(region).not.toMatch(/session\.clock_out_at \?\? session\.clock_in_at/);
  });

  it('pending_review is filtered from the picker (a label with no workflow)', () => {
    const src = screen('CorrectionsScreen.tsx');
    expect(src).toMatch(/CORRECTABLE_STATUSES\.filter\(st => st !== 'pending_review'\)\.map/);
  });
});

describe('B2 — the calendar respects the B1 verb split', () => {
  it('ensureRosterMonth fires ONLY from the explicit Start-planning tap, never from load/focus', () => {
    const src = screen('MonthlyRosterScreen.tsx');
    // Exactly one call site…
    const calls = src.match(/attendanceApi\.ensureRosterMonth\(/g) ?? [];
    expect(calls.length).toBe(1);
    // …inside startPlanning…
    const sp = src.indexOf('const startPlanning');
    const spEnd = src.indexOf('const publish', sp);
    expect(sp).toBeGreaterThan(-1);
    expect(spEnd).toBeGreaterThan(sp);
    expect(src.slice(sp, spEnd)).toMatch(/attendanceApi\.ensureRosterMonth\(/);
    // …and NOT inside the load callback (a focus handler fires on every
    // back-swipe — ensuring there mints phantom draft months, the exact
    // failure the GET/POST split exists to prevent).
    const load = src.indexOf('const load = useCallback');
    const loadEnd = src.indexOf('useFocusEffect', load);
    expect(load).toBeGreaterThan(-1);
    expect(loadEnd).toBeGreaterThan(load);
    expect(src.slice(load, loadEnd)).not.toMatch(/ensureRosterMonth/);
    expect(src.slice(load, loadEnd)).toMatch(/attendanceApi\.rosterMonth\(/);
  });

  it('publish/archive are unreachable while the month is unplanned', () => {
    const src = screen('MonthlyRosterScreen.tsx');
    // The action block is gated on the month row existing (the server 404s
    // both verbs with roster_month_not_planned anyway — this keeps the UI from
    // offering a guaranteed failure).
    expect(src).toMatch(/\{monthRow && monthRow\.status !== 'archived' && \(/);
    // And the empty state offers exactly the one verb that is valid.
    expect(src).toMatch(/Start planning/);
  });

  it('a blocked publish surfaces the conflicts and an AUDITED override', () => {
    const src = screen('MonthlyRosterScreen.tsx');
    expect(src).toMatch(/publishBlock && \(/);
    expect(src).toMatch(/Publish anyway/);
    expect(src).toMatch(/publish\(true\)/);
    expect(src).toMatch(/recorded in the audit log/);
  });

  it('month loads are race-guarded and cross-month leftovers are cleared up front', () => {
    // Whichever response resolved LAST used to win: month A's status and
    // conflicts could render under month B's title, one card above a Publish
    // button targeting B; and a stale publishBlock offered a force-publish
    // over shifts the manager had since fixed.
    const src = screen('MonthlyRosterScreen.tsx');
    const load = src.indexOf('const load = useCallback');
    const loadEnd = src.indexOf('useFocusEffect', load);
    expect(load).toBeGreaterThan(-1);
    expect(loadEnd).toBeGreaterThan(load);
    const region = src.slice(load, loadEnd);
    expect(region).toMatch(/reqRef\.current/);
    expect((region.match(/req !== reqRef\.current/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(region).toMatch(/setConflicts\(\[\]\)/);
    expect(region).toMatch(/setPublishBlock\(null\)/);
  });

  it('the calendar never mutates shifts — day taps go to ShiftManagement', () => {
    const src = screen('MonthlyRosterScreen.tsx');
    expect(src).toMatch(/navigate\('ShiftManagement'\)/);
    for (const banned of ['createShift', 'updateShift', 'archiveShift', 'assignCpos', 'patchShiftAssignments']) {
      expect(`${banned}:${src.includes(banned)}`).toBe(`${banned}:false`);
    }
  });
});

describe('G-c/G-d — shift recurrence + branch bulk-assign (client half)', () => {
  it('create is ONE call — the create-then-assign orphan window is gone', () => {
    const src = screen('ShiftEditorScreen.tsx');
    // The create flow sends assignees IN the create body…
    expect(src).toMatch(/cpo_user_ids: \[\.\.\.selected\]/);
    // …and never calls the legacy insert-only endpoint any more.
    expect(src).not.toMatch(/attendanceApi\.assignCpos\(/);
    // repeat_weeks rides the same body, only when a repeat is chosen.
    // Q6 added the multi-date lane: repeat_weeks is now ALSO gated on the
    // create not being a multi-date one (the two are mutually exclusive).
    expect(src).toMatch(/\.\.\.\(!wins && repeatWeeks > 1 \? \{repeat_weeks: repeatWeeks\} : \{\}\)/);
  });

  it('the repeat picker exists in CREATE mode only — series edit is deferred, stated', () => {
    const src = screen('ShiftEditorScreen.tsx');
    const start = src.indexOf('REPEAT WEEKLY');
    expect(start).toBeGreaterThan(-1);
    // The section sits inside a `!editing && !multiDates && (` guard — Q6's
    // multi-date lane also hides the weekly repeat (mutually exclusive).
    const before = src.slice(Math.max(0, start - 600), start);
    expect(before).toMatch(/\{!editing && !multiDates && \(/);
  });

  it('branch chips bulk-select the visible roster (G-c client half)', () => {
    const src = screen('ShiftEditorScreen.tsx');
    expect(src).toMatch(/m\.department === b/);
    expect(src).toMatch(/Select everyone in/);
  });
});

describe('entries — AdminAttendanceScreen reaches both new screens', () => {
  it('both screens are reachable IN PLACE; disputed rows carry the note and a Correct action', () => {
    const src = screen('AdminAttendanceScreen.tsx');
    // Client review vs2 item 13 replaced the four navigate-away cards with
    // SEGMENTS of this screen — "combined on one attendance dashboard rather
    // than treated as separate disconnected areas". The rule this test guards
    // (AdminAttendance reaches both screens) is unchanged; only the mechanism
    // moved, so assert the new one rather than deleting the coverage.
    // Tag-only, not the full attribute list: the roster body also takes an
    // onOpenShifts prop, and pinning the exact JSX froze that. The BEHAVIOUR
    // (each pill swaps in its own body) is covered by the render test in
    // attendanceDashboard.test.tsx — this scan only proves the wiring exists.
    expect(src).toMatch(/<MonthlyRosterScreen embedded\b/);
    expect(src).toMatch(/<CorrectionsScreen embedded\b/);
    expect(src).toMatch(/<ShiftManagementScreen embedded\b/);
    expect(src).toMatch(/<DayStatusScreen embedded\b/);
    // The per-row action still hands the SESSION over and still PUSHES the
    // route (rows are effective-folded server-side, so the editor needs no
    // refetch, and the standalone route must keep working for that deep link).
    expect(src).toMatch(/navigate\('Corrections', \{session: p\}\)/);
    expect(src).toMatch(/p\.dispute_note/);
  });

  /**
   * vs2 item 13, second half — "the user must be shown how to add a member to
   * a shift before the attendance review can continue". Both roster-dependent
   * screens used to state the problem and offer no way out.
   */
  it('the roster-empty states are actionable, not dead ends', () => {
    for (const f of ['DayStatusScreen.tsx', 'ShiftEditorScreen.tsx']) {
      const src = screen(f);
      // Resolved through the ladder: the roster lives on the CHANNELS stack
      // while both of these are on ATTEND, so a bare navigate is dropped.
      expect(`${f}:${/openEmployees\(navigation\)/.test(src)}`).toBe(`${f}:true`);
      expect(`${f}:${/Add people to the roster/.test(src)}`).toBe(`${f}:true`);
    }
    // …and the resolver must actually exist, with a real fallback rather than
    // a silent miss.
    const entry = strip(read(join(process.cwd(), 'src', 'navigation', 'departmentalEntry.ts')));
    expect(entry).toMatch(/export function openEmployees/);
    expect(entry).toMatch(/Roster unavailable/);
  });

  it('the embedded screens suppress their own chrome, so the host owns it', () => {
    // Without this each segment would draw a second header and a second
    // safe-area inset inside the dashboard.
    for (const f of ['ShiftManagementScreen.tsx', 'DayStatusScreen.tsx',
      'MonthlyRosterScreen.tsx', 'CorrectionsScreen.tsx']) {
      const src = screen(f);
      expect(`${f}:${/embedded = false/.test(src)}`).toBe(`${f}:true`);
      expect(`${f}:${/\{!embedded && <ObHeader/.test(src)}`).toBe(`${f}:true`);
      // Transparent when embedded — an opaque root paints over the host's
      // AmbientBg, so four of five segments lost the backdrop the Review
      // segment keeps. Own the inset only when standing alone.
      expect(`${f}:${/embedded \? \{backgroundColor: 'transparent'\} : \{paddingTop: insets\.top\}/.test(src)}`).toBe(`${f}:true`);
    }
  });

  it('both screens are registered on the Attend stack', () => {
    const nav = strip(read(join(process.cwd(), 'src', 'navigation', 'DepartmentalNavigator.tsx')));
    expect(nav).toMatch(/name="MonthlyRoster"/);
    expect(nav).toMatch(/name="Corrections"/);
  });
});
