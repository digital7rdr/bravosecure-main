/**
 * Enterprise Dept Channels scope v2 — Phase 3, the client half (M5 / M11A / A11).
 *
 * These screens mount RN views, so this project cannot import them —
 * comment-stripped source scan, same technique as the other deptchat pins.
 *
 * Every assertion here targets a rule the PDF states in the negative ("the
 * applicant cannot…", "pending means no content is visible", "without exposing
 * organisation data"). Negative rules are exactly what a render test cannot
 * prove, because the failure mode is something EXTRA appearing.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const DIR = join(process.cwd(), 'src', 'screens', 'deptchat');

function read(f: string): string {
  return readFileSync(join(DIR, f), 'utf8').replace(/\r\n/g, '\n');
}
function strip(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('M5 — the applicant cannot choose their own team', () => {
  it('the join screen has no team or department picker', () => {
    // "The applicant cannot change the requested department or team." The team
    // is resolved from the LINK server-side. A picker here would be a hole even
    // if the server ignored it, because the next edit would start honouring it.
    const src = strip(read('JoinWorkspaceScreen.tsx'));
    expect(src).not.toMatch(/setTeam|team_channel_id|selectedTeam/);
    expect(src).not.toMatch(/setDepartment\b/);
  });

  it('submits only the four fields M5 names, plus the code', () => {
    const src = strip(read('JoinWorkspaceScreen.tsx'));
    const call = src.slice(src.indexOf('submitJoinRequest({'), src.indexOf('});', src.indexOf('submitJoinRequest({')));
    for (const f of ['code:', 'full_name:', 'phone:', 'email:', 'message:']) {
      expect(`${f}:${call.includes(f)}`).toBe(`${f}:true`);
    }
    expect(call).not.toMatch(/team|department/);
  });

  it('an invalid link exposes NO organisation data', () => {
    // "Expired or revoked links show a safe message without exposing
    // organisation data." The invalid branch must not render org_name/team_name.
    const src = strip(read('JoinWorkspaceScreen.tsx'));
    const start = src.indexOf('invalid ? (');
    const end = src.indexOf(') : resolved?.valid ?', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const invalidBranch = src.slice(start, end);
    expect(invalidBranch).not.toMatch(/org_name|team_name/);
  });

  it('a network failure is indistinguishable from an invalid code', () => {
    // Otherwise the error itself is an oracle: "server error" vs "no such code"
    // tells an attacker whether a code exists.
    const src = strip(read('JoinWorkspaceScreen.tsx'));
    // The upper bound was `indexOf('Auto-resolve') > -1 ? … : src.length`, and
    // `strip` removes comments — so the probe was ALWAYS -1 and the slice always
    // ran to EOF. It still discriminated, but only by luck: `submit`'s
    // `catch (e: unknown) {` happens not to match `catch\s*\{`. Bound the slice
    // on code that survives stripping, and assert the bound is real.
    const start = src.indexOf('const check =');
    const end = src.indexOf('const submit');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const check = src.slice(start, end);
    expect(check).toMatch(/catch\s*\{[\s\S]*?setResolved\(\{valid: false\}\)/);
  });
});

describe('M11A — pending means blank', () => {
  it('the status screen never fetches workspace content', () => {
    // "Pending means no Enterprise content or metadata is visible." The server
    // enforces this (no org_members row ⇒ nothing returned), but this screen
    // must not even ask — a "preview while you wait" would be the obvious
    // well-meaning regression.
    const src = strip(read('ApprovalStatusScreen.tsx'));
    for (const banned of ['departmentApi', 'attendanceApi', 'incidentApi', 'listChannels', 'listMembers']) {
      expect(`${banned}:${src.includes(banned)}`).toBe(`${banned}:false`);
    }
    // It talks to exactly one endpoint: its own status.
    expect(src).toMatch(/enterpriseApi\.myJoinRequest/);
  });

  it('the Enter button routes through the shared entry helper, not a hard-coded route', () => {
    // The documented departmentalEntry failure: a bare navigate() to a route the
    // mounted tree does not register is SILENTLY DROPPED, and this screen is
    // reachable from more than one shell.
    const src = strip(read('ApprovalStatusScreen.tsx'));
    // Q4/Q11 — an approved member's landing is the Home dashboard (M11A's
    // own words), still via the shared helper, never a hard-coded route.
    expect(src).toMatch(/openDepartmentChannels\(navigation, \{preferHome: true\}\)/);
    expect(src).not.toMatch(/navigate\('Departmental'\)/);
  });
});

describe('REACHABILITY — the loop must be enterable and returnable', () => {
  /**
   * Round 1 shipped 25 green tests over a feature nobody could reach: no admin
   * entry, no way to mint a link, and no route to M5 at all. Tests that pin
   * behaviour but not REACHABILITY are how that happens, so these assertions
   * land in the same change as the entry points rather than as a later step.
   */
  const messenger = (f: string) => strip(
    readFileSync(join(process.cwd(), 'src', 'screens', 'messenger', f), 'utf8').replace(/\r\n/g, '\n'));

  it('an applicant can REACH M5 — "I have an invite code"', () => {
    const src = messenger('DepartmentChannelsScreen.tsx');
    expect(src).toMatch(/openJoinFlowScreen\(navigation, target\)/);
    // Never a bare navigate: this screen is mounted in more than one shell and
    // the route lives in MessengerNavigator, so a hard-coded call is silently
    // dropped in the others (the documented Issues 18/19 failure).
    expect(src).not.toMatch(/navigation\.navigate\('JoinWorkspace'\)/);
  });

  /**
   * R6-2/R6-3 — the whole class, pinned structurally rather than site by site.
   *
   * `Approvals`, `JoinWorkspace` and `ApprovalStatus` were registered ONLY in
   * MessengerNavigator, which the Agent and CPO shells do not mount — and EVERY
   * approver persona (agency owner and promoted org manager alike,
   * resolveRoute.ts:60) is routed into the Agent shell. Each call site then used
   * `const host = findNavigatorWithRoute(...); if (host) { navigate }` with no
   * else, so the tap was silently dropped: an admin could receive the "join
   * requested" notification and never open the inbox. The loop terminated at
   * "pending" permanently while every test stayed green.
   *
   * Enumerating the three call sites is what failed before — a fourth is always
   * one screen away. So assert the two structural facts instead: the routes
   * exist in the shell that hosts the feature, and NO caller anywhere reaches
   * them through a bare no-else `if (host)`.
   */
  it('the join-flow routes exist in the shell every approver actually lands in', () => {
    const dep = strip(readFileSync(
      join(process.cwd(), 'src', 'navigation', 'DepartmentalNavigator.tsx'), 'utf8').replace(/\r\n/g, '\n'));
    for (const r of ['Approvals', 'JoinWorkspace', 'ApprovalStatus']) {
      expect(dep).toMatch(new RegExp(`name="${r}"`));
    }
    // And the resolver knows the tab hop — DepartmentalHomeScreen is the Home
    // TAB, so these routes are on a SIBLING stack that findNavigatorWithRoute
    // cannot see (it walks UP only).
    const entry = strip(readFileSync(
      join(process.cwd(), 'src', 'navigation', 'departmentalEntry.ts'), 'utf8').replace(/\r\n/g, '\n'));
    expect(entry).toMatch(/export function openJoinFlowScreen/);
    // R9-2 — every nested-navigation branch must pass `initial: false`, or the
    // lazy child stack initialises AT the target with no history beneath it and
    // the tab becomes a dead end for the life of the shell.
    expect(entry).toMatch(/navigateVia\(tabs, 'Channels', \{screen: route, initial: false\}\)/);
    expect(entry).toMatch(/params: \{screen: route, initial: false\}/);
    // No branch may nest a screen WITHOUT the flag.
    expect(entry).not.toMatch(/\{screen: route\}/);
    // No candidate may fall through without telling the user.
    const body = entry.slice(entry.indexOf('export function openJoinFlowScreen'));
    expect(body.slice(0, body.indexOf('\n}'))).toMatch(/Alert\.alert/);
  });

  it('NO caller reaches a join-flow route through a silent no-else navigate', () => {
    // The mechanism, not the instance. Three sites had it; the fix is only
    // durable if a fourth cannot be added without this failing.
    const files = [
      join('src', 'screens', 'messenger', 'DepartmentChannelsScreen.tsx'),
      join('src', 'screens', 'deptchat', 'DepartmentalHomeScreen.tsx'),
      join('src', 'screens', 'activity', 'ActivityCenterScreen.tsx'),
    ];
    for (const f of files) {
      const src = strip(readFileSync(join(process.cwd(), f), 'utf8').replace(/\r\n/g, '\n'));
      // The banned shape: resolve a host, then navigate under a bare `if`.
      expect(src).not.toMatch(/findNavigatorWithRoute\([^)]*(Approvals|JoinWorkspace|ApprovalStatus|target)[^)]*\)/);
    }
  });

  it('the CTA CONDITION is satisfiable — not just present in the file', () => {
    /**
     * THE PIN THAT WAS MISSING, and the reason five rounds of source scans did
     * not catch this.
     *
     * The CTAs lived inside `if (!entitled)`, while the only screen that
     * navigates here (GroupsScreen) navigated ONLY when `hasDeptChannels` was
     * true. Arriving required true; rendering required false. Mutually
     * exclusive — so BOTH CTAs were unreachable by every user, and a scan for
     * `findNavigatorWithRoute(...)` passed the whole time because the strings
     * were right there. A token in a file is not a reachable decision, and this
     * decision spans two files.
     *
     * Worst for the exact persona this phase is for: `hasDeptChannels` is
     * `isOrgAffiliated || tier === 'enterprise'`, so a tier-only Enterprise
     * individual with no membership row got `true` from buying the plan.
     */
    const src = messenger('DepartmentChannelsScreen.tsx');

    // 1. Rendered in BOTH branches, so no single `entitled` value hides it.
    expect((src.match(/<JoinCta\b/g) ?? []).length).toBeGreaterThanOrEqual(2);

    // 2. Keyed off "actually in an org", never off the tier-satisfiable flag.
    const cta = src.slice(src.indexOf('function JoinCta('), src.indexOf('const iconForType'));
    expect(cta).toMatch(/isOrgAffiliated/);
    expect(cta).not.toMatch(/hasDeptChannels|!entitled/);

    // 3. The applicant's own status is fetched in BOTH branches — behind the
    //    entitled guard it could never populate for the person who needs it.
    const loadIdx = src.indexOf('const load = useCallback');
    const gate = src.indexOf('if (!entitled) { setLoading(false); return; }', loadIdx);
    expect(gate).toBeGreaterThan(-1);
    expect(src.indexOf('enterpriseApi.myJoinRequest', loadIdx)).toBeLessThan(gate);

    // 4. CROSS-FILE: the non-entitled path must actually reach this screen, or
    //    the gate branch is dead no matter what it renders. Assert the DECISION
    //    (both branches attempt the open; the paywall is only the fallback),
    //    not a helper name — the first version of this pin named
    //    findNavigatorWithRoute and went stale the moment the call moved to the
    //    shared resolver, which is the same "token, not decision" mistake it
    //    exists to catch.
    //    Founder 2026-08-05 — this entry moved from GroupsScreen to the profile
    //    drawer. The decision is unchanged and is now expressed as ONE shared
    //    call whose result gates the fallback, rather than two branches that
    //    each called it. That is strictly stronger, so the old ">= 2 calls"
    //    count is retired: what matters is that EVERY paywall is preceded by an
    //    attempt to open, which is asserted directly below.
    const drawer = readFileSync(
      join(process.cwd(), 'src', 'components', 'ProfileDrawerModal.tsx'), 'utf8',
    ).replace(/\r\n/g, '\n');
    const opens = [...drawer.matchAll(/openDepartmentChannels\(navigation[,)]/g)].map(m => m.index ?? -1);
    expect(opens.length).toBeGreaterThanOrEqual(1);
    const paywall = drawer.indexOf('showEnterpriseUpgradePrompt({onViewPlans: openPricing})');
    expect(paywall).toBeGreaterThan(-1);
    // The non-entitled path opens the gate BEFORE it can fall back to the
    // paywall — a paywall-only else-branch is exactly R5-1.
    expect(opens.every(i => i < paywall)).toBe(true);
    // And the old home must not still carry a second, drifted copy.
    expect(messenger('GroupsScreen.tsx')).not.toMatch(/openDepartmentChannels/);

    // 5. AND the door that redirect REPLACED must still exist. The locked card
    //    used to raise the upgrade dialog on tap; routing to the gate instead
    //    silently removed the only in-app way to BUY Enterprise from the
    //    feature that advertises it. Whoever owns the redirect owns this.
    expect(src).toMatch(/onPress=\{openPricing\}/);
    expect(src).toMatch(/from '@navigation\/openPricing'/);
  });

  it('a pending applicant can RETURN to M11A from STATE, not from a notification', () => {
    // ApprovalStatus used to be reachable only THROUGH JoinWorkspace, so anyone
    // who backgrounded the app could never see their own status again. Driving
    // it from myJoinRequest() means recoverability does not depend on a
    // notification arriving, or on the user tapping it.
    const src = messenger('DepartmentChannelsScreen.tsx');
    expect(src).toMatch(/enterpriseApi\.myJoinRequest/);
    expect(src).toMatch(/setJoinStatus/);
    // The target is chosen from state — a pending/decided request routes to
    // M11A, otherwise to M5 — so assert the mapping rather than a literal.
    //
    // STALE ANCHOR REPAIR (found red on this branch before the F7-F15 batch, and
    // unrelated to it): the anchor was the single-line
    // `joinStatus ? 'ApprovalStatus' : 'JoinWorkspace'`, and Phase 6 deliberately
    // made the false arm a two-way fork — an Enterprise-tier caller who can
    // create a workspace gets 'EnterpriseSetup', everyone else keeps the
    // code-only 'JoinWorkspace' — written across three lines. The RULE this test
    // exists for is unchanged and is what is asserted below: a request in state
    // routes to M11A, and the no-request arm still reaches M5.
    // Item E extended the fork once more: an open INVITE outranks everything
    // (the admin already decided — surfacing it beats re-offering the code
    // form), so the anchor moved with it. The original rule still holds and is
    // still asserted: request-in-state → M11A, no-request arm → M5.
    const target = src.slice(src.indexOf('const target = hasInvite || joinStatus'));
    expect(target.indexOf('const target = hasInvite || joinStatus')).toBe(0);
    const decision = target.slice(0, target.indexOf(';'));
    expect(decision).toMatch(/\?\s*'ApprovalStatus'/);
    expect(decision).toMatch(/'JoinWorkspace'/);
  });

  it('an admin can REACH A11, and can MINT and REVOKE an invite', () => {
    const home = strip(readFileSync(
      join(process.cwd(), 'src', 'screens', 'deptchat', 'DepartmentalHomeScreen.tsx'), 'utf8').replace(/\r\n/g, '\n'));
    expect(home).toMatch(/openJoinFlowScreen\(navigation, 'Approvals'\)/);
    // A6 mockup renders a pending count on that card.
    expect(home).toMatch(/pendingApprovals/);

    const approvals = strip(readFileSync(
      join(process.cwd(), 'src', 'screens', 'deptchat', 'ApprovalsScreen.tsx'), 'utf8').replace(/\r\n/g, '\n'));
    // Q14 — the multi-use referral lane is retired: a referral code was never
    // consumed on use (any number of people could join off one code) and never
    // disappeared from the admin's screen. The DIRECT invite (bound, single-
    // use, atomically claimed) is the only mint lane now.
    expect(approvals).not.toMatch(/enterpriseApi\.createReferralLink/);
    expect(approvals).not.toMatch(/enterpriseApi\.listReferralLinks/);
    // Without a mint affordance no invitee can ever join.
    expect(approvals).toMatch(/navigate\('InviteMember'\)/);
    // Page 10 rule 2 — "revocable invitation tokens" (now the direct invites).
    expect(approvals).toMatch(/enterpriseApi\.revokeInvite/);
    expect(approvals).toMatch(/enterpriseApi\.listInvites/);
  });
});

describe('Item E — a direct invite can actually carry a team', () => {
  it('the mint UI offers a team picker and sends team_channel_id', () => {
    // Q14 moved the mint (and its team picker) from ApprovalsScreen to the
    // direct-invite screen. "The invite records the exact originating team"
    // must survive the move: A11 shows the per-invite team, M11A takes its
    // team copy from it, and seedApprovedMemberChannels places the member.
    const src = strip(readFileSync(join(DIR, 'InviteMemberScreen.tsx'), 'utf8').replace(/\r\n/g, '\n'));
    expect(src).toMatch(/team_channel_id: teamId/);
    expect(src).toMatch(/setTeamId/);
    // Managers-only channels must not be OFFERED: the server refuses them as a
    // join target, so the row would be a guaranteed 400 and would promise a team
    // the approval then skips.
    //
    // RE-ANCHORED by vs2 item 2, not weakened. The rule used to be an inline
    // expression here; it now lives in `organisationTree.mintDisabled`, because
    // the picker groups rows into a tree and a pre-filter would delete a
    // restricted ORGANISATION ROOT and promote its children to top-level
    // organisations. Same rule, one copy, applied as a disabled state. Assert
    // BOTH halves — that the screen consumes the shared symbol, and that the
    // symbol still encodes the exclusions — or the scan passes against a screen
    // that imports it and never calls it.
    expect(src).toMatch(/mintDisabled/);
    expect(src).toMatch(/from '\.\/organisationTree'/);
    const helper = strip(readFileSync(join(DIR, 'organisationTree.ts'), 'utf8').replace(/\r\n/g, '\n'));
    expect(helper).toMatch(/row\.access === 'restricted' \|\| row\.channel_type === 'incident'/);
    expect(helper).toMatch(/if \(row\.is_broadcast\) \{return true;\}/);
  });

  it('revocation survives leaving the screen', () => {
    // Page 10 rule 2 — open invites are rehydrated from the server on every
    // load, so Revoke is never limited to a code minted this session.
    const src = strip(readFileSync(join(DIR, 'ApprovalsScreen.tsx'), 'utf8').replace(/\r\n/g, '\n'));
    expect(src).toMatch(/enterpriseApi\.listInvites/);
  });
});

describe('A11 / M11A — the notification must be readable and land somewhere', () => {
  const store = (f: string) => strip(
    readFileSync(join(process.cwd(), 'src', 'store', f), 'utf8').replace(/\r\n/g, '\n'));

  it('enterprise rows get their own class, not the booking fallback', () => {
    // activityClassOf ends in `return 'booking'`, so without a branch these
    // rendered with a calendar badge.
    expect(store('activitySync.ts')).toMatch(/eventClass === 'enterprise'/);
    expect(store('activityStore.ts')).toMatch(/'incident' \| 'enterprise'/);
  });

  it('each kind has a human label — not the raw kind string', () => {
    // KIND_META falls back to `{title: n.kind}`, so the row title was literally
    // "enterprise.join.approved" with no subtitle (page 10 rule 4).
    const src = store('activitySync.ts');
    for (const k of ['enterprise.join.requested', 'enterprise.join.approved', 'enterprise.join.declined']) {
      expect(`${k}:${src.includes(`'${k}':`)}`).toBe(`${k}:true`);
    }
  });

  it('tapping one deep-links to the exact record (page 10 rule 3)', () => {
    // These rows carry no bookingId/missionId, so every existing branch fell
    // through and tapping did nothing at all.
    const src = strip(readFileSync(
      join(process.cwd(), 'src', 'screens', 'activity', 'ActivityCenterScreen.tsx'), 'utf8').replace(/\r\n/g, '\n'));
    expect(src).toMatch(/row\.eventClass === 'enterprise'/);
    // Item E widened the admin-side set: a new join request AND an accepted
    // invite both land the admin on the Approvals inbox; everything else is the
    // caller's own status/invite surface.
    expect(src).toMatch(/row\.kind === 'enterprise\.join\.requested' \|\| row\.kind === 'enterprise\.invite\.accepted'/);
    expect(src).toMatch(/toApprovals \? 'Approvals' : 'ApprovalStatus'/);
    // Resolved against the mounted tree — these routes live in MessengerNavigator.
    expect(src).toMatch(/openJoinFlowScreen\(navigation, toApprovals/);
  });
});

describe('A11 — exactly Approve or Decline, and a conflict is not an error', () => {
  it('calls the two dedicated endpoints, never a status field', () => {
    const src = strip(read('ApprovalsScreen.tsx'));
    expect(src).toMatch(/enterpriseApi\.approveJoinRequest/);
    expect(src).toMatch(/enterpriseApi\.declineJoinRequest/);
    expect(src).not.toMatch(/status:\s*['"](approved|declined)['"]/);
  });

  it('surfaces the 409 race as "already decided", not a generic failure', () => {
    // "If two Admins act, the first decision wins and the second receives a
    // conflict state." That is the system working correctly — telling the second
    // admin "something went wrong" would be a lie that invites a retry.
    const src = strip(read('ApprovalsScreen.tsx'));
    expect(src).toMatch(/[=]== 409/);
    expect(src).toMatch(/Already decided/);
  });

  it('shows every field A11 lists for the admin to judge on', () => {
    const src = strip(read('ApprovalsScreen.tsx'));
    for (const f of ['applicant_name', 'applicant_phone', 'applicant_email', 'referrer_name', 'team_name']) {
      expect(`${f}:${src.includes(f)}`).toBe(`${f}:true`);
    }
  });
});

describe('Item E — member invites, client rules', () => {
  it('the mint screen normalises the phone BEFORE calling the API (B-154)', () => {
    const src = strip(read('InviteMemberScreen.tsx'));
    expect(src).toMatch(/normalizeToE164\(rawPhone, callingCodeFromOwnPhone\(ownPhone\)\)/);
    // And the wire carries the NORMALISED value, never the raw input.
    expect(src).toMatch(/contact_phone: e164/);
    expect(src).not.toMatch(/contact_phone: rawPhone|contact_phone: phone\b/);
  });

  it('no admin surface ever says whether the contact has an account', () => {
    // The server keeps the mint response byte-identical matched or unmatched;
    // a client string like "already on Bravo" would need exactly the signal
    // the server refuses to give — its presence means someone re-added the
    // oracle. ("been notified" in the code-card copy is conditional-neutral:
    // it holds for matched users and claims nothing about unmatched ones.)
    for (const f of ['InviteMemberScreen.tsx', 'ApprovalsScreen.tsx']) {
      const src = strip(read(f));
      expect(`${f}:${/is (already )?on Bravo|already has an account|not on Bravo|no account/i.test(src)}`)
        .toBe(`${f}:false`);
    }
  });

  it('InviteMember is registered in BOTH shells (dual-mount rule)', () => {
    const nav = (p: string) => strip(readFileSync(
      join(process.cwd(), 'src', 'navigation', p), 'utf8').replace(/\r\n/g, '\n'));
    // Same class as Issues 18/19: its callers (Approvals, ChannelMembers) are
    // mounted in both trees, so a single-shell registration makes the tap a
    // silent no-op in the other.
    expect(nav('MessengerNavigator.tsx')).toMatch(/name="InviteMember"/);
    expect(nav('DepartmentalNavigator.tsx')).toMatch(/name="InviteMember"/);
  });

  it('the JoinWorkspace invite branch ACCEPTS — it never submits a request', () => {
    const src = strip(read('JoinWorkspaceScreen.tsx'));
    // The fork exists and both arms are wired to the right verb.
    expect(src).toMatch(/isInvite \? join\(\) : submit\(\)/);
    // The join arm goes through the ONE shared accept helper (drifted-duplicate
    // rule), which is also what maps the server's single safe message.
    expect(src).toMatch(/acceptInviteFlow\(code\)/);
    const joinFn = src.slice(src.indexOf('const join = async'), src.indexOf('const invalid ='));
    expect(joinFn.length).toBeGreaterThan(0);
    expect(joinFn).not.toMatch(/submitJoinRequest/);
  });

  it('ApprovalStatus is the invitee surface: fetches invites, accepts via the shared helper', () => {
    const src = strip(read('ApprovalStatusScreen.tsx'));
    expect(src).toMatch(/enterpriseApi\.myInvites\(\)/);
    expect(src).toMatch(/acceptInviteFlow\(code\)/);
    // B-413 — blocked rows (workspace owners, acceptable:false) render NO
    // card of any kind here: the Workspace Hub is their one home. Every row
    // that survives the filter carries a live CTA. `!== false` (not truthy):
    // a not-yet-redeployed server omits the field, and missing must mean
    // today's behavior (show), never all-blocked.
    expect(src).toMatch(/\.filter\(iv => iv\.acceptable !== false\)/);
    // Q11 — accepting an invite IS membership: enter the workspace directly
    // (Home dashboard) instead of reloading this screen, which — for the
    // invite lane, which creates NO request row — rendered a blank status
    // page the founder read as "it didn't let me in". The shared helper
    // routes via openDepartmentChannels, which resolves against the mounted
    // shell (never a hard-coded route).
    expect(src).not.toMatch(/await acceptInviteFlow\(code\)\) \{ await load\(\); \}/);
    const accept = src.slice(src.indexOf('const accept = useCallback'), src.indexOf('const meta ='));
    expect(accept).toMatch(/openDepartmentChannels\(navigation, \{preferHome: true\}\)/);
  });

  it('the directory CTA surfaces an open invite and routes to ApprovalStatus', () => {
    const src = strip(readFileSync(
      join(process.cwd(), 'src', 'screens', 'messenger', 'DepartmentChannelsScreen.tsx'),
      'utf8').replace(/\r\n/g, '\n'));
    expect(src).toMatch(/enterpriseApi\.myInvites\(\)/);
    // The invite arm must ride the resolver TARGET, never thread the code as a
    // param — openJoinFlowScreen drops params on most of its branches.
    expect(src).toMatch(/hasInvite \|\| joinStatus/);
    expect(src).not.toMatch(/openJoinFlowScreen\([^)]*\{[^)]*code/);
    // B-413 — only ACCEPTABLE invites arm the CTA; a raw length check would
    // re-arm the phantom "tap to join" for a workspace owner whose accept can
    // only 409. `!== false` keeps a missing field (old server) behaving like
    // today rather than hiding every CTA.
    expect(src).toMatch(/\.some\(i => i\.acceptable !== false\)/);
    expect(src).not.toMatch(/invites \?\? \[\]\)\.length > 0/);
  });
});

describe('F-WSHUB — the Workspace Hub (B-413 companion)', () => {
  it('the hub enters via the resolver and honours the invite forks', () => {
    const src = strip(read('WorkspaceHubScreen.tsx'));
    // ENTERING a workspace goes through departmentalEntry — a bare
    // navigate('Departmental') only lands on Home for a COLD mount.
    expect(src).toMatch(/openDepartmentChannels\(navigation as ResolvableNavigation, \{preferHome: true\}\)/);
    expect(src).not.toMatch(/navigate\('Departmental'\)/);
    // Accepts through the ONE shared helper (drifted-duplicate rule), keeping
    // the code:null fork — email invites carry no code and point at the entry.
    expect(src).toMatch(/acceptInviteFlow\(code\)/);
    expect(src).toMatch(/navigate\('JoinWorkspace'\)/);
    // Blocked rows are informational: reason copy present, and no badge/count
    // affordance anywhere on the hub (a badge is a nag with extra steps).
    expect(src).toMatch(/workspace_owner_cannot_join/);
    expect(src).not.toMatch(/badge|Badge/);
  });

  it('B-448 — the hub carries a STANDING door to code entry, not one gated on an invite row', () => {
    const src = strip(read('WorkspaceHubScreen.tsx'));
    // Pre-B-448 the ONLY hub path to JoinWorkspace sat inside `invites.map`
    // (the code:null email-invite fork) — someone handed a referral code
    // out-of-band saw a list page with no way to use it. The standing card is
    // a section of its own, so the label is the anchor; the navigate after it
    // proves the label still owns a live door rather than a caption.
    expect(src).toMatch(/JOIN A WORKSPACE/);
    const standing = src.slice(src.indexOf('JOIN A WORKSPACE'));
    expect(standing).toMatch(/navigate\('JoinWorkspace'\)/);
  });

  it('the hub route is registered in the shell its entry points resolve to', () => {
    const nav = strip(readFileSync(
      join(process.cwd(), 'src', 'navigation', 'MessengerNavigator.tsx'), 'utf8').replace(/\r\n/g, '\n'));
    expect(nav).toMatch(/name="WorkspaceHub"/);
    expect(nav).toMatch(/import WorkspaceHubScreen from/);
  });

  it('every hub entry point resolves against the mounted tree — never a bare navigate from a multi-shell host', () => {
    // The drawer is hosted by the messenger, booking AND VBG shells; the
    // Departmental Home tab is hosted by three shells. A hard-coded navigate
    // is the documented Issue-18 silent drop.
    const drawer = strip(readFileSync(
      join(process.cwd(), 'src', 'components', 'ProfileDrawerModal.tsx'), 'utf8').replace(/\r\n/g, '\n'));
    expect(drawer).toMatch(/findNavigatorWithRoute\(navigation, 'WorkspaceHub'\)/);
    // Affiliation only (owns_workspace || org_is_workspace) — the drawer must
    // NOT grow a myInvites fetch (doc §6).
    //
    // Asserted through the SHARED predicate, not the inline expression it used
    // to spell out. `isWorkspaceTenant` IS that expression (pinned below), and
    // pinning the literal here is what made a reviewer's "one definition"
    // cleanup look like a regression. The rule under test is "affiliation
    // decides, and nothing else does" — which door it reads it through is not
    // the invariant.
    expect(drawer).toMatch(/isWorkspaceTenant\(user\)/);
    const tenant = strip(readFileSync(
      join(process.cwd(), 'src', 'screens', 'deptchat', 'workspaceTenant.ts'), 'utf8').replace(/\r\n/g, '\n'));
    // vs2 item 4 added a THIRD source. Both original flags come from the
    // discriminator's single collapsed membership row, and for an officer who
    // is also a workspace employee that row is the AGENCY one — so both read
    // false while they are plainly a member of a workspace. The affiliation
    // list is the only place that shows.
    expect(tenant).toMatch(/owns_workspace === true/);
    expect(tenant).toMatch(/org_is_workspace === true/);
    expect(tenant).toMatch(/workspaces\?\.length \?\? 0\) > 0/);
    expect(drawer).not.toMatch(/myInvites/);
    const home = strip(readFileSync(
      join(process.cwd(), 'src', 'screens', 'deptchat', 'DepartmentalHomeScreen.tsx'), 'utf8').replace(/\r\n/g, '\n'));
    expect(home).toMatch(/findNavigatorWithRoute\(navigation, 'WorkspaceHub'\)/);
  });
});
