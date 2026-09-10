/**
 * Static invariants for the CPO suspension lane.
 *
 * These are rules a render test cannot reach cheaply (OrgRosterScreen pulls in
 * navigation, safe-area, gradients and the API layer), but which are exactly the
 * kind that rot silently: someone "simplifies" the actions sheet and the
 * confirmation, the mission lock, or the mandatory reason quietly disappears.
 * The repo already uses source scans for this class of rule (see
 * messageTopologyInvariants / receivePersistenceInvariants).
 *
 * If you are here because one of these failed: do not delete the assertion.
 * Either restore the guarantee, or change the rule deliberately AND update the
 * plan doc (docs/planning/CPO_SUSPENSION_AND_PROFILE_PLAN.md).
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const ROSTER = 'src/screens/agent/OrgRosterScreen.tsx';
const MODAL = 'src/components/SuspendMemberModal.tsx';
const SERVICE = 'apps/auth-service/src/org/org-cpo.service.ts';

describe('roster suspension invariants (source scan)', () => {
  // R1 — suspend must never be a single unconfirmed tap. It used to fire
  // instantly straight from the sheet, which is how an accidental tap signed a
  // guard out mid-shift.
  it('R1: the roster never calls setStatus(..., "suspended") directly', () => {
    const src = read(ROSTER);
    expect(src).not.toMatch(/setStatus\([^)]*['"]suspended['"]/);
    // …it goes through the dialog instead.
    expect(src).toMatch(/setSuspendTarget\(m\)/);
  });

  // R2 — D4: a CPO on a live detail must not be cut off. The client half of the
  // guard; the server half is org-cpo.service.spec ("refuses to suspend a CPO
  // who is on a live mission").
  it('R2: suspend and remove are gated behind on_mission', () => {
    const src = read(ROSTER);
    expect(src).toMatch(/if\s*\(m\.on_mission\)/);
    expect(src).toMatch(/if\s*\(!m\.on_mission\)\s*\{/);
  });

  // R3 — lifting a suspension is also a real state change; it asks first.
  it('R3: lifting a suspension is confirmed', () => {
    const src = read(ROSTER);
    expect(src).toMatch(/Lift suspension\?/);
  });

  // R4 — D2: the reason is what the suspended officer is shown at login. A
  // dialog that can submit an empty one makes the login message useless.
  it('R4: the dialog blocks an empty reason', () => {
    const src = read(MODAL);
    expect(src).toMatch(/if\s*\(!reason\.trim\(\)\)/);
    expect(src).toMatch(/disabled=\{!!error \|\| busy\}/);
  });

  // R5 — D1: the owner explicitly kept the full lockout. Suspension must still
  // revoke sessions AND strip channel membership (which rotates the group key).
  // Dropping either would silently leave a suspended guard able to read agency
  // chat on an unexpired token.
  it('R5: suspend still revokes sessions and strips channels server-side', () => {
    const src = read(SERVICE);
    expect(src).toMatch(/revokeAllUserSessions\(memberUserId\)/);
    // The call gained trailing args at 187ed90 (I-a audit-actor threading), so
    // the anchor pins the three decision-bearing args and tolerates the rest —
    // the invariant is the 'remove' STRIP happening, not the arg count.
    expect(src).toMatch(/syncMemberToOrgChannels\(orgUserId, memberUserId, 'remove'[,)]/);
  });

  // R6 — the live-mission predicate exists once. Two hand-copied copies is how
  // the roster badge and the write-side guard drift apart.
  it('R6: the live-mission check is a single shared helper', () => {
    const src = read(SERVICE);
    expect(src).toMatch(/private async isOnLiveMission\(/);
    expect(src).toMatch(/await this\.isOnLiveMission\(memberUserId\)/);
  });

  // R7 — expiry must run the real reinstate path, not a bare status flip:
  // suspension removed them from channels, so a flip alone would leave a
  // reinstated officer silently locked out of every agency channel.
  it('R7: suspension expiry reinstates via setMemberStatus', () => {
    const src = read(SERVICE);
    const fn = src.slice(src.indexOf('private async expireLapsedSuspensions'));
    const body = fn.slice(0, fn.indexOf('\n  }'));
    expect(body).toMatch(/setMemberStatus\(orgUserId, m\.member_user_id, 'active'/);
    expect(body).not.toMatch(/UPDATE org_members\s+SET status = 'active'/);
  });

  // R8 — the dialog must reuse the app-wide dialog vocabulary rather than
  // re-declaring its own hex palette (a second copy is a drift waiting to happen).
  it('R8: the dialog imports the shared tokens instead of hard-coding the palette', () => {
    const src = read(MODAL);
    expect(src).toMatch(/from '@components\/ui\/dialogTokens'/);
    // No raw card-gradient hexes redeclared locally.
    expect(src).not.toMatch(/#131A28/);
    expect(src).not.toMatch(/#4C86F0/);
  });
});
