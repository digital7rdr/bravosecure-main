/**
 * Channels vs2 item 4 — who sees the MANAGER surface inside a viewed workspace.
 *
 * This predicate mirrors a server rule (`OrgManagerGuard`'s arm precedence), and
 * the whole reason it exists as one function is that three screens were about to
 * inline three copies of it. A mirror is only correct while the thing it mirrors
 * holds still — item 4 moved the server rule and this was not moved with it, so
 * these tests pin the CURRENT precedence and name the persona for each row.
 *
 * There was no test on this function at all before item 4. The one place it is
 * referenced in a spec (`departmentDirectoryRender.test.tsx`) mocks it away.
 */
import {contextManagerRole, type ActiveWorkspace} from '@store/activeWorkspace';

const ctx = (role: ActiveWorkspace['role']): ActiveWorkspace =>
  ({org_id: 'org-1', name: 'Borealis', role});

describe('contextManagerRole', () => {
  it('is null with no context, so the caller keeps the global flags', () => {
    // Pre-Phase-B behaviour, and what every non-workspace entry point relies on.
    expect(contextManagerRole(null, false)).toBeNull();
    expect(contextManagerRole(null, true)).toBeNull();
  });

  it('arms manager chrome for the owner of the viewed workspace', () => {
    expect(contextManagerRole(ctx('owner'), false)).toBe(true);
  });

  it('arms it for a delegated manager of the viewed workspace', () => {
    expect(contextManagerRole(ctx('manager'), false)).toBe(true);
  });

  it('STILL arms it for a manager who also owns a workspace of their own', () => {
    /**
     * THE ITEM-4 CHANGE, and the one this file exists for.
     *
     * Priya owns workspace Acme and is a delegated manager of Borealis. She
     * taps Borealis in the hub, so the header names Borealis and the server's
     * owner arm no longer short-circuits — she genuinely is Borealis's manager
     * for that request, and `assertManagerOrg` agrees.
     *
     * The predicate used to return FALSE here (`role === 'manager' &&
     * !ownsWorkspace`), which was correct before item 4 and wrong after: Priya
     * got the EMPLOYEE surface — Attend rooted at Attendance rather than
     * AdminAttendance, Incidents at the report form rather than the queue, and
     * every manager card plus the module sheet hidden. She is the headline
     * persona of the founder's Option A decision.
     */
    expect(contextManagerRole(ctx('manager'), true)).toBe(true);
  });

  it('does NOT arm it for an employee or a cpo, whatever they own elsewhere', () => {
    // The narrowing direction still has to hold: owning a workspace somewhere
    // must never grant manager chrome in one you merely belong to.
    expect(contextManagerRole(ctx('employee'), true)).toBe(false);
    expect(contextManagerRole(ctx('employee'), false)).toBe(false);
    expect(contextManagerRole(ctx('cpo'), true)).toBe(false);
  });
});
