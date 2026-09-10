/**
 * Enterprise Dept Channels scope v2, frame A7.3 — "Use Member terminology
 * throughout; remove remaining Employee or CPO labels."
 *
 * Two separate guarantees, because the first one alone is not enough:
 *
 *   1. THE VALUE.  An Enterprise account's dept-chat staff noun is "Member"
 *      (was "Employee"). The service-provider branch deliberately still says
 *      "CPO" — rule 7 keeps the provider tenant untouched, and whether an
 *      AGENCY's dept-chat staff should read "Member" too is a founder call.
 *      If that call is later made, change the assertion deliberately; do not
 *      delete it.
 *
 *   2. NOBODY COMPARES IT.  `DayStatusScreen` had
 *      `deptMemberNoun() === 'Employee' ? 'an employee' : 'a CPO'`. The moment
 *      the noun became 'Member' that branch silently fell through to "a CPO"
 *      for exactly the accounts the rename was FOR. A value test cannot see
 *      that — the string compare lives in a different file — so the source scan
 *      below is the part that actually protects the rename.
 *
 * This is the repo's duplicate-copy / changed-shared-symbol bug class: when a
 * shared value changes, the bug is in its CONSUMERS, not in the value.
 */
import {readFileSync, readdirSync} from 'node:fs';
import {join, sep} from 'node:path';

const DIR = join(process.cwd(), 'src', 'screens', 'deptchat');

/** These files are CRLF — normalise so `\n`-anchored patterns cannot match
 *  nothing and pass vacuously. */
function read(file: string): string {
  return readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

/** Strip comments before any absence assertion — the doc comment in
 *  deptNoun.ts quotes the very pattern under test. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('A7.3 — Enterprise dept-chat staff are called "Member"', () => {
  /** Body of one exported helper, so an assertion about one branch cannot
   *  accidentally read the other helper's returns (deptNoun.ts exports two). */
  function fnBody(name: string): string {
    const src = stripComments(read(join(DIR, 'deptNoun.ts')));
    const start = src.indexOf(`export function ${name}(`);
    expect(start).toBeGreaterThan(-1);
    const next = src.indexOf('export function ', start + 1);
    return src.slice(start, next === -1 ? undefined : next);
  }

  it('deptMemberNoun returns Member / Members on the Enterprise branch', () => {
    const body = fnBody('deptMemberNoun');
    expect(body).toMatch(/return plural \? 'Members' : 'Member';/);
    expect(body).not.toMatch(/'Employees?'/);
  });

  it('deptMemberNoun keeps CPO for the provider tenant (rule 7 — provider untouched)', () => {
    expect(fnBody('deptMemberNoun')).toMatch(/return plural \? 'CPOs' : 'CPO';/);
  });

  it('deptEmployeeNoun is Member for Enterprise but EMPLOYEE — never CPO — otherwise', () => {
    // The employee roster excludes CPOs by construction, so naming it after the
    // CPO roster would be wrong for exactly the tenant rule 7 protects.
    const body = fnBody('deptEmployeeNoun');
    expect(body).toMatch(/return plural \? 'Members' : 'Member';/);
    expect(body).toMatch(/return plural \? 'Employees' : 'Employee';/);
    expect(body).not.toMatch(/'CPOs?'/);
  });
});

describe('A7.3 — no screen may branch on the VALUE of deptMemberNoun()', () => {
  /**
   * The scan must follow the HELPER, not one directory. Two of the most
   * important Department Channel screens — DepartmentChatScreen (M9) and
   * DepartmentChannelsScreen (M8) — live under src/screens/messenger, so a
   * `src/screens/deptchat`-only sweep left them unguarded.
   */
  const MESSENGER = join(process.cwd(), 'src', 'screens', 'messenger');
  const files: string[] = [
    ...readdirSync(DIR)
      .filter(f => f.endsWith('.tsx') || f.endsWith('.ts'))
      .map(f => join(DIR, f)),
    ...readdirSync(MESSENGER)
      .filter(f => f.startsWith('Department') && f.endsWith('.tsx'))
      .map(f => join(MESSENGER, f)),
  ];

  it.each(files)('%s renders the noun instead of comparing it', file => {
    const src = stripComments(read(file));
    // Any equality/inequality test against the helper's result, or against the
    // literals it can return, re-creates the DayStatusScreen defect. `switch`
    // and prefix tests evade a bare `===` scan, so they are banned too (loose
    // `==` is already blocked by eqeqeq in .eslintrc.js).
    expect(src).not.toMatch(/deptMemberNoun\([^)]*\)\s*[=!]==/);
    expect(src).not.toMatch(/[=!]==\s*'(Employee|Employees|Member|Members|CPO|CPOs)'/);
    expect(src).not.toMatch(/switch\s*\(\s*deptMemberNoun/);
    expect(src).not.toMatch(/deptMemberNoun\([^)]*\)\s*\.\s*(startsWith|endsWith|includes|match)\b/);
  });

  // deptNoun.ts is the DEFINITION — it is required to contain these literals.
  const literalFiles = files.filter(f => !f.endsWith(`${sep}deptNoun.ts`));

  it.each(literalFiles)('%s hardcodes no staff noun in visible text', file => {
    // Route names are IDENTIFIERS, not labels: `navigate('Employees')` targets
    // the Employees route and renaming it would silently drop the tap (the
    // documented departmentalEntry failure). Strip navigation targets before
    // asserting on user-visible copy.
    const src = stripComments(read(file))
      .replace(/navigate\(\s*'[^']*'/g, "navigate('')")
      .replace(/name="[^"]*"/g, 'name=""');
    // Why this exists: the comparison scan above could not see a hardcoded
    // `<SectionLabel>CPO</SectionLabel>` sitting on the A7.3 screen itself,
    // directly above a line that already rendered the live noun — an Enterprise
    // admin read "CPO" over "No active Members…". A rename is only done when
    // the literal is gone, not just when the helper is correct.
    //
    // Deliberately narrow: matches a noun that IS the whole JSX text node or
    // the whole string literal. Longer prose that legitimately names the
    // provider ("service provider (agency / CPO)") and the lowercase SERVER
    // DATA VALUE `member_role === 'employee'` are untouched.
    expect(src).not.toMatch(/>\s*(CPO|CPOs|Employee|Employees)\s*</);
    expect(src).not.toMatch(/'(CPO|CPOs|Employee|Employees)'/);
    expect(src).not.toMatch(/`(CPO|CPOs|Employee|Employees)`/);
    // The double-quoted form is the one that MATTERS most, not an afterthought:
    // CLAUDE.md's style rule is "single quotes for strings, double quotes only
    // inside JSX attributes", which GUARANTEES every visible label prop
    // (title=, label=, placeholder=, accessibilityLabel=) is written in exactly
    // this form. Omitting it left `<ObHeader title="Employees">` — the very
    // string this phase was about — passing green. Route registrations are
    // already neutralised by the name="" strip above, so this cannot
    // false-positive on an identifier.
    expect(src).not.toMatch(/"(CPO|CPOs|Employee|Employees)"/);
  });

  it.each(files)('%s never lowercases a noun that can be an acronym', file => {
    // `deptMemberNoun` can return 'CPOs' → `.toLowerCase()` renders "cpos".
    // Write copy that reads correctly with the noun as-is instead.
    const src = stripComments(read(file));
    expect(src).not.toMatch(/dept(Member|Employee)Noun\([^)]*\)\s*\.\s*toLowerCase/);
  });

  it('the Employees roster uses the ROLE-bound noun, not the tenant staff noun', () => {
    // Why these are different helpers: EmployeesScreen filters
    // `member_role === 'employee'` and buckets CPO/manager rows separately as
    // "managed from your provider roster — untouched here". Rendering
    // deptMemberNoun there titled that screen "CPOs" for an agency — the one
    // roster it does not contain. A7.3 only asked for the ENTERPRISE label to
    // change, so the provider branch of this screen stays "Employees".
    for (const f of ['EmployeesScreen.tsx']) {
      const src = stripComments(read(join(DIR, f)));
      expect(src).toMatch(/deptEmployeeNoun/);
      expect(src).not.toMatch(/deptMemberNoun/);
    }
    // The M8 entry CTA points AT that screen, so it must agree with it.
    const m8 = stripComments(
      read(join(process.cwd(), 'src', 'screens', 'messenger', 'DepartmentChannelsScreen.tsx')));
    expect(m8).not.toMatch(/deptMemberNoun/);
  });

  it('the sweep covers both directories (guards against an empty glob)', () => {
    // Why: if either directory moves, readdirSync returns [] and every
    // assertion above passes vacuously.
    expect(files.filter(f => f.includes('deptchat')).length).toBeGreaterThan(10);
    // M8 + M9 at minimum.
    expect(files.filter(f => f.includes('messenger')).length).toBeGreaterThanOrEqual(2);
  });
});
