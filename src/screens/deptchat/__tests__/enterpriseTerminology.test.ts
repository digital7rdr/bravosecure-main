/**
 * F10 / PDF A7.3 — "use Member terminology throughout; remove remaining Employee
 * or CPO labels."
 *
 * `deptNoun.test.ts` already pins the HELPER and bans a bare noun that is the
 * whole JSX text node or the whole string literal. It could not see the three
 * instances this file covers, because each one is a CPO/Employee label buried in
 * a longer sentence:
 *
 *   1. `DepartmentChannelsScreen` gate — "…a service-provider organisation
 *      workspace — managers create channels and add their CPOs and staff" and
 *      "Managers post; CPOs read". This is the screen a would-be member LANDS
 *      on, so it is the first Enterprise copy anyone reads.
 *   2. `EmployeesScreen` — "N CPO/manager roster member(s)".
 *   3. `tierMatrix` — the Enterprise plan tile row "Employee Attendance
 *      Tracking".
 *
 * Comments are stripped first: all three files now EXPLAIN the rule in prose
 * that quotes the banned words, which is the single most common false result in
 * this repo.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

function code(...rel: string[]): string {
  return readFileSync(join(process.cwd(), 'src', ...rel), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .split('\n')
    .filter(l => !l.trim().startsWith('//'))
    .join('\n');
}

const GATE = code('screens', 'messenger', 'DepartmentChannelsScreen.tsx');
const ROSTER = code('screens', 'deptchat', 'EmployeesScreen.tsx');
const MATRIX = code('screens', 'pro', 'tierMatrix.ts');

describe('F10 — the Department Channels gate speaks Member terminology', () => {
  it('the scan is reading the real screens (guards against an empty read)', () => {
    // Anti-vacuity canary only. Was 'Department Channels' until client review
    // vs2 item 17 renamed the surface to "Channels"; re-anchored on a string
    // the screen keeps for its own reasons, NOT on the renamed title.
    // Re-anchored 2026-08-20: was 'ENTERPRISE', which the screen only still
    // contained because the tier vocabulary was hardcoded there. PDF checklist
    // line 9 made those names admin-chosen, so the canary now sits on a string
    // the screen keeps for its OWN reasons — which is what a canary is for.
    expect(GATE).toContain('LEVELS.map');
    expect(ROSTER).toContain('OTHER ROSTER MEMBERS');
    expect(MATRIX).toContain('ENTERPRISE_FEATURES');
  });

  it('the gate body no longer names CPOs or a service provider', () => {
    // The three-line body a would-be member reads first.
    expect(GATE).not.toMatch(/add their CPOs/);
    expect(GATE).not.toMatch(/service-provider organisation/);
  });

  it('the "who can post" bullet no longer says CPOs', () => {
    expect(GATE).not.toMatch(/Managers post; CPOs read/);
    // The DECISION SITE: the bullet still exists and still explains posting
    // rights. Asserting only the absence above would pass if it were deleted.
    expect(GATE).toMatch(/Admins post, everyone else reads — unread badges per channel/);
  });

  /**
   * WHY THE GATE IS NOUN-FREE while the rest of this screen interpolates the
   * helper. `deptEmployeeNoun` derives from the SIGNED-IN tenant, and the gate
   * renders only when `hasDeptChannels` is false — an account with no tenancy
   * and no Enterprise tier, for which BOTH helpers take their non-Enterprise arm
   * ('Employees' / 'CPOs'). Interpolating one here would have swapped a banned
   * label for a banned label in front of exactly the audience A7.3 is about.
   */
  it('the entitled empty state still uses the tenant helper', () => {
    // …so this is a scoped exception, not the helper being abandoned. The M8
    // entry CTA points at the Employees roster and must speak its noun.
    expect(GATE).toMatch(/add your team under \{deptEmployeeNoun\(true\)\}/);
    // deptNoun.test.ts bans the OTHER helper on this file; keep it that way.
    expect(GATE).not.toMatch(/deptMemberNoun/);
  });
});

describe('F10 — the roster and the plan tile', () => {
  it('the other-roster bucket drops the CPO/manager label', () => {
    expect(ROSTER).not.toMatch(/CPO\/manager roster member/);
    // Decision site: the count line still exists and still pluralises, so this
    // is a rename and not a deletion.
    expect(ROSTER).toMatch(/\{others\.length\} other roster member\{others\.length === 1 \? '' : 's'\}/);
  });

  it('the Enterprise plan tile no longer says "Employee Attendance Tracking"', () => {
    expect(MATRIX).not.toMatch(/'Employee Attendance Tracking'/);
    // …and the capability is still advertised — the row was renamed, not cut.
    expect(MATRIX).toMatch(/'Attendance Tracking'/);
  });

  it('no visible Enterprise copy in these files still says Employee or CPO', () => {
    // Deliberately narrow, the same shape deptNoun.test.ts uses: a banned noun
    // that is the WHOLE string literal. Longer prose that legitimately names the
    // provider funnel ("a service provider (agency / CPO)") and the lowercase
    // SERVER DATA VALUE `member_role === 'employee'` are untouched, because
    // renaming either would break a real branch.
    for (const src of [GATE, ROSTER]) {
      expect(src).not.toMatch(/'(CPO|CPOs|Employee|Employees)'(?!\s*\))/);
    }
  });
});
