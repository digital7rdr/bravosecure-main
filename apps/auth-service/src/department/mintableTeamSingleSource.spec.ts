/**
 * Channels vs2 item 2 — the invite picker greys nodes the manager cannot mint
 * into, which means the mint refusal now has TWO readers: the throwing one
 * (createMemberInvite) and the projecting one (listOrgChannels.mintable_by_me).
 *
 * WHY A SOURCE SCAN SITS ALONGSIDE THE UNIT TESTS.
 *
 * "The two can never drift" is not something a behavioural test can promise —
 * the defect is a SECOND copy of the predicate written later at a third site,
 * which by definition no existing test covers. This repo's most-shipped bug
 * shape is exactly that (one behaviour, N drifted copies), and here the two
 * copies would disagree silently: the picker would offer a node the server then
 * 403s, or grey one the server would have allowed. So the scan requires the
 * branch comparison to exist in exactly one place.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {DepartmentService} from './department.service';

const SERVICE = join(process.cwd(), 'src', 'department', 'department.service.ts');
const JOIN_SERVICE = join(process.cwd(), 'src', 'department', 'enterprise-join.service.ts');

/** Normalise CRLF and strip comments — the prose in both files quotes the very
 *  expressions under test, and a comment satisfying an assertion is the single
 *  most common false result in this repo's scans. */
function source(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('--'))
    .join('\n');
}

const ORG = 'org-1';
const row = (over: Partial<Parameters<typeof DepartmentService.mintRefusalFor>[0] & object> = {}) => ({
  org_id: ORG, access: 'standard' as const, channel_type: 'department' as const,
  department: null as string | null, archived: false, is_broadcast: false,
  // Item 04/D-5 — REQUIRED on the predicate (no default there, deliberately, so
  // a caller cannot fail open on the announcement arm). 'read_only' is the
  // ordinary channel default, so every existing case below reads unchanged.
  post_mode: 'read_only' as const, ...over,
});

describe('vs2 item 2 — mintRefusalFor is the ONE mint predicate', () => {
  it('an unscoped manager (null department) may mint into any branch', () => {
    expect(DepartmentService.mintRefusalFor(row({department: 'RSA'}), ORG, null, true)).toBeNull();
    expect(DepartmentService.mintRefusalFor(row({department: null}), ORG, null, true)).toBeNull();
  });

  it('a scoped manager is held to their own branch', () => {
    expect(DepartmentService.mintRefusalFor(row({department: 'RSA'}), ORG, 'RSA', true)).toBeNull();
    // FLIPPED BY ITEM 7, exactly as the previous revision of this comment said
    // it would be — it named `toBeNull()` as the assertion this commit must
    // change, so that widening the boundary could only happen as a decision.
    //
    // A BRANCHLESS channel is now mintable by any manager ON A WORKSPACE. Item
    // 7 removes the DEPARTMENT field from the create form, so most new
    // workspace channels carry NULL; keeping the refusal would leave scoped
    // managers unable to be given ANY new team. It is the convention the
    // join/invite file already encodes four times over ("unrouted belongs in
    // every manager's inbox").
    expect(DepartmentService.mintRefusalFor(row({department: null}), ORG, 'RSA', true)).toBeNull();

    // ⚠️ THE TENANT GATE, and it is a permission boundary, not tidiness.
    // AGENCY orgs use typed departments for real branch scope and can already
    // produce a NULL-department channel by leaving the field blank, so applying
    // the relaxation there would widen a live surface the client never asked to
    // change. The first version of this change had no gate at all.
    expect(DepartmentService.mintRefusalFor(row({department: null}), ORG, 'RSA', false))
      .toBe('team_channel_outside_your_branch');

    // The boundary that REMAINS on BOTH tenants: another branch's channel is
    // still refused. This is the half that must never quietly disappear.
    for (const tenant of [true, false]) {
      expect(DepartmentService.mintRefusalFor(row({department: 'Kenya'}), ORG, 'RSA', tenant))
        .toBe('team_channel_outside_your_branch');
    }
  });

  it('refuses missing, archived, cross-org and managers-only rows', () => {
    expect(DepartmentService.mintRefusalFor(null, ORG, null, true)).toBe('team_channel_not_found');
    // Archived reads as absent, matching the throwing caller's WHERE clause.
    expect(DepartmentService.mintRefusalFor(row({archived: true}), ORG, null, true)).toBe('team_channel_not_found');
    expect(DepartmentService.mintRefusalFor(row({org_id: 'other'}), ORG, null, true)).toBe('team_channel_in_other_org');
    expect(DepartmentService.mintRefusalFor(row({access: 'restricted'}), ORG, null, true))
      .toBe('team_channel_is_managers_only');
    expect(DepartmentService.mintRefusalFor(row({channel_type: 'incident'}), ORG, null, true))
      .toBe('team_channel_is_managers_only');
  });

  /**
   * Item 04/D-5 — AN ANNOUNCEMENT CHANNEL IS NOT A TEAM, however it got that way.
   *
   * The rule used to key on `is_broadcast` alone. A workspace no longer gets a
   * server-minted #broadcast, and there is no `is_broadcast` field a caller can
   * set — its announcement channel is now a LATERAL carrying
   * post_mode 'announcement'. Keying on the flag alone would have made the NEW
   * announcement channel bindable as a joiner's team: the same meaningless grant
   * this refusal exists to prevent, walking in through the new door.
   *
   * The code is deliberately reused rather than adding a sixth: the client
   * already renders honest copy for it and the sentence is the same either way.
   */
  it('refuses an ANNOUNCEMENT channel as a team — by mode, not just the flag', () => {
    expect(DepartmentService.mintRefusalFor(row({post_mode: 'announcement'}), ORG, null, true))
      .toBe('team_channel_is_broadcast');
    // …and still by the flag, for agency #broadcast rows, which keep post_mode
    // 'announcement' anyway but must not depend on that to be refused.
    expect(DepartmentService.mintRefusalFor(row({is_broadcast: true}), ORG, null, true))
      .toBe('team_channel_is_broadcast');
    // An ORDINARY lateral is a perfectly good team — it is a real channel with
    // members. Only the announcement MODE is refused, not laterality.
    expect(DepartmentService.mintRefusalFor(row({post_mode: 'open'}), ORG, null, true)).toBeNull();
  });

  it('order is fixed: a cross-org restricted row reports the ORG violation', () => {
    // Not cosmetic. Reporting managers_only for another org's channel would
    // confirm that a channel with that id exists in a tenant the caller cannot
    // see — the disclosure the org check is there to prevent.
    expect(DepartmentService.mintRefusalFor(row({org_id: 'other', access: 'restricted'}), ORG, null, true))
      .toBe('team_channel_in_other_org');
  });

  it('defers to seedsManagersOnly rather than re-deriving visibility', () => {
    // The whole point of the shared symbol. If someone inlines the rule here,
    // channelAccessInvariants' exactly-one-occurrence scan catches it in this
    // file — and this assertion catches it if they move it out of the file.
    const src = source(SERVICE);
    const fn = src.slice(src.indexOf('static mintRefusalFor('), src.indexOf('static memberRoleFor('));
    expect(fn).toMatch(/DepartmentService\.seedsManagersOnly\(/);
    expect(fn).not.toMatch(/=== 'restricted'/);
    expect(fn).not.toMatch(/=== 'incident'/);
  });

  it('the BRANCH comparison exists in exactly one place across both services', () => {
    // The expression that moved. Two copies of it is the drift this file exists
    // to ban, and the count is what makes the ban structural.
    // Anchored on the COMPARISON, not on "is this manager scoped". The scoped
    // check itself legitimately appears twice: the second is
    // `scoped_manager_cannot_grant_admin`, a whole-REQUEST rule about the
    // invited role that a per-row predicate deliberately cannot express.
    const both = `${source(SERVICE)}\n${source(JOIN_SERVICE)}`;
    const hits = both.match(/!==\s*managerDepartment/g) ?? [];
    expect(hits.length).toBe(1);
    // …and the throwing caller reaches it through the shared symbol.
    expect(source(JOIN_SERVICE)).toMatch(/DepartmentService\.mintRefusalFor\(/);
  });

  it('the branch refusal stays a 403 while the rest stay 400s', () => {
    // The split the call site had before the predicate moved. Collapsing them
    // would change the client's error mapping (InviteMemberScreen maps the
    // branch code to its own alert).
    const src = source(JOIN_SERVICE);
    const fn = src.slice(src.indexOf('private async assertMintableTeam('), src.indexOf('async createReferralLink('));
    expect(fn).toMatch(/ForbiddenException\(refusal\)/);
    expect(fn).toMatch(/BadRequestException\(refusal\)/);
    expect(fn).toMatch(/team_channel_outside_your_branch/);
  });
});
