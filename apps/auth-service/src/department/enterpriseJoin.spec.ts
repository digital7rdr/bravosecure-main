/**
 * Enterprise Dept Channels scope v2 — Phase 3: the join → approve loop.
 * Frames M5 / M11A / A11, page 10 rules 2-4.
 *
 * The behavioural cases run against the real service with a mocked db. The
 * STRUCTURAL cases are source scans, because the invariants that matter here
 * are absences — "no membership row is written", "no team field is accepted",
 * "the decision is not a read-then-write" — and an absence is exactly what a
 * behavioural test cannot see once someone adds the thing back somewhere else.
 */
import {Test, TestingModule} from '@nestjs/testing';
import {BadRequestException, ConflictException, NotFoundException} from '@nestjs/common';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseService} from '../database/database.service';
import {OrgAuditService} from '../org/org-audit.service';
import {BookingPushBridge} from '../ops/booking-push-bridge.service';
import {EnterpriseJoinService} from './enterprise-join.service';
import {DepartmentService} from './department.service';

// withTransaction hands the callback the SAME mock, so a test can keep
// sequencing qOne/q in call order regardless of the transaction boundary.
// Explicitly typed: a self-referencing `withTransaction` otherwise makes TS
// infer the object's type from its own return value and fail with TS7024.
const mockDb: {
  q: jest.Mock; qOne: jest.Mock;
  withTransaction: (cb: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
} = {
  q: jest.fn(),
  qOne: jest.fn(),
  // A DISTINCT tx handle, so a test can tell "inside the transaction" from
  // "after the commit". Sharing mockDb here made the C1 pin blind: moving the
  // membership grant back outside the transaction — fully restoring the torn
  // "approved forever / zero access" state — passed 27/27.
  withTransaction: (cb: (tx: unknown) => Promise<unknown>) => cb(mockTx),
};
const mockTx = {q: jest.fn(), qOne: jest.fn()};
const mockAudit = {log: jest.fn().mockResolvedValue(undefined)};
// R13-2 — the wake + durable inbox row ride BookingPushBridge in one call;
// the service must never call NotificationsService.record directly again
// (that would double-write the Activity Centre row).
const mockPush = {
  enterpriseJoinRequested: jest.fn().mockResolvedValue(undefined),
  enterpriseJoinDecided: jest.fn().mockResolvedValue(undefined),
  enterpriseInviteReceived: jest.fn().mockResolvedValue(undefined),
  enterpriseInviteAccepted: jest.fn().mockResolvedValue(undefined),
};
// addMember is the ONLY path that enqueues the rekey intent, so the seed must
// call it rather than INSERT directly — the mock exists to assert exactly that.
const mockDepartment = {
  addMember: jest.fn().mockResolvedValue({ok: true}),
  // vs2 item 7 — the mint predicate is tenant-gated now (a branchless channel
  // is mintable by any manager on a WORKSPACE, never on an agency). Default
  // true: these cases are all enterprise-workspace flows.
  isWorkspaceTenant: jest.fn().mockResolvedValue(true),
};

const ORG = 'org-1';
const ADMIN = 'admin-1';
const APPLICANT = 'user-9';

function source(file: string): string {
  return readFileSync(join(process.cwd(), 'src', 'department', file), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
}

describe('EnterpriseJoinService', () => {
  let svc: EnterpriseJoinService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDb.q.mockResolvedValue([]);
    mockTx.q.mockReset().mockResolvedValue([]);
    // Default null = "no existing org_members row", so a test only has to stub
    // the claim unless it is specifically about reinstatement.
    mockTx.qOne.mockReset().mockResolvedValue(null);
    mockAudit.log.mockResolvedValue(undefined);
    mockPush.enterpriseJoinRequested.mockResolvedValue(undefined);
    mockPush.enterpriseJoinDecided.mockResolvedValue(undefined);
    mockDepartment.addMember.mockResolvedValue({ok: true});
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EnterpriseJoinService,
        {provide: DatabaseService, useValue: mockDb},
        {provide: OrgAuditService, useValue: mockAudit},
        {provide: BookingPushBridge, useValue: mockPush},
        {provide: DepartmentService, useValue: mockDepartment},
      ],
    }).compile();
    svc = module.get(EnterpriseJoinService);
  });

  describe('M5 — a bad link must not become an oracle', () => {
    it('an expired or revoked code returns a bare {valid:false}, exposing NOTHING', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);
      const res = await svc.resolveReferralLink('DEADBEEF');
      // "Expired or revoked links show a safe message without exposing
      // organisation data" — no org name, no team, not even whether it existed.
      expect(res).toEqual({valid: false});
      expect(JSON.stringify(res)).not.toMatch(/org|team|name/i);
    });

    it('the lookup itself refuses revoked and expired links (not the caller)', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);
      await svc.resolveReferralLink('abcd1234');
      const sql = String(mockDb.qOne.mock.calls[0][0]);
      expect(sql).toMatch(/revoked_at IS NULL/);
      expect(sql).toMatch(/expires_at IS NULL OR l\.expires_at > NOW\(\)/);
      // Codes are stored upper-case; the lookup must normalise or a lower-case
      // paste silently fails as "invalid".
      expect(mockDb.qOne.mock.calls[0][1]).toEqual(['ABCD1234']);
    });
  });

  describe('M5 — submitting grants nothing', () => {
    it('creates a PENDING row and writes NO org_members row', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({id: 'link-1', org_user_id: ORG, referrer_user_id: 'ref-1', team_channel_id: 'ch-2'})
        .mockResolvedValueOnce(null)              // not already a member
        .mockResolvedValueOnce({id: 'req-1'});    // insert
      const res = await svc.submitJoinRequest(APPLICANT, {code: 'ABCD1234', full_name: 'Jo'});
      expect(res).toEqual({status: 'pending', id: 'req-1'});

      // THE load-bearing assertion of the whole phase.
      const written = [...mockDb.q.mock.calls, ...mockDb.qOne.mock.calls].map((c: unknown[]) => String(c[0])).join('\n');
      expect(written).not.toMatch(/INSERT INTO (public\.)?org_members\b/);
      // ANCHOR ON THE BARE TABLE NAME. The house style for this table is
      // UNQUALIFIED (`INSERT INTO org_members` — org-cpo.service.ts:193, :396),
      // so a `public.`-qualified anchor let a real membership grant added to
      // submitJoinRequest pass 16/16. The rule was enforced over a narrower
      // surface than the code actually uses.
      expect(written).not.toMatch(/UPDATE (public\.)?org_members\b/);
    });

    it('takes the team from the LINK, never from the applicant', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({id: 'link-1', org_user_id: ORG, referrer_user_id: null, team_channel_id: 'ch-from-link'})
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({id: 'req-1'});
      // A hostile body carrying its own team must have no effect.
      await svc.submitJoinRequest(APPLICANT, {
        code: 'ABCD1234', ...({team_channel_id: 'ch-attacker'} as Record<string, unknown>),
      });
      const insert = mockDb.qOne.mock.calls.find((c: unknown[]) => /INSERT INTO public\.enterprise_join_requests/.test(String(c[0])));
      expect(insert?.[1]).toContain('ch-from-link');
      expect(insert?.[1]).not.toContain('ch-attacker');
    });

    it('a double-tap resolves to the SAME pending request (idempotent)', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({id: 'link-1', org_user_id: ORG, referrer_user_id: null, team_channel_id: null})
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(Object.assign(new Error('dup'), {code: '23505'}))
        .mockResolvedValueOnce({id: 'req-existing'});
      const res = await svc.submitJoinRequest(APPLICANT, {code: 'ABCD1234'});
      expect(res).toEqual({status: 'pending', id: 'req-existing'});
    });

    it('rejects an invalid link before touching anything else', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);
      await expect(svc.submitJoinRequest(APPLICANT, {code: 'NOPE'})).rejects.toThrow(BadRequestException);
      const written = [...mockDb.q.mock.calls, ...mockDb.qOne.mock.calls].map((c: unknown[]) => String(c[0])).join('\n');
      expect(written).not.toMatch(/INSERT INTO/);
    });
  });

  describe('A11 — first decision wins', () => {
    it('claims the request with a CONDITIONAL update, not a read-then-write', async () => {
      mockTx.qOne.mockResolvedValueOnce({applicant_user_id: APPLICANT, team_channel_id: null});
      await svc.decideJoinRequest(ORG, ADMIN, 'req-1', 'approved');
      const upd = String(mockTx.qOne.mock.calls[0][0]);
      expect(upd).toMatch(/UPDATE public\.enterprise_join_requests/);
      // The guard is IN the update. A read-then-write would let two admins both
      // read 'pending' and both proceed.
      expect(upd).toMatch(/WHERE r\.id = \$1 AND r\.org_user_id = \$2 AND r\.status = 'pending'/);
      expect(upd).toMatch(/RETURNING/);
      // The BRANCH forced filter lives in the same conditional, so a
      // department-scoped manager cannot decide outside their branch.
      // A TEAMLESS request falls THROUGH the branch filter — otherwise the claim
      // matches nothing and the fallback reports a FALSE "already decided".
      // The EFFECTIVE department, archive-aware — see the shared-rule test at
      // the bottom of this file for why the raw column is wrong here.
      expect(upd).toMatch(/\$5::text IS NULL OR COALESCE\(/);
      expect(upd).toMatch(/CASE WHEN c\.archived_at IS NULL THEN c\.department END/);
    });

    it('runs the claim and the membership grant in ONE transaction', async () => {
      // The claim used to commit on its own, then the org_members INSERT ran
      // after — and that INSERT can fail on a DIFFERENT unique index
      // (org_members_one_active_agency is UNIQUE(member_user_id) WHERE
      // status='active', which ON CONFLICT (org_user_id, member_user_id) does
      // not absorb). The request was left permanently 'approved' with no
      // membership row: "Access approved" forever, zero access, and a retry
      // 409s because the conditional claim now matches nothing.
      mockTx.qOne
        .mockResolvedValueOnce({applicant_user_id: APPLICANT, team_channel_id: null})
        .mockResolvedValueOnce(null);
      const spy = jest.spyOn(mockDb, 'withTransaction');
      await svc.decideJoinRequest(ORG, ADMIN, 'req-1', 'approved');
      expect(spy).toHaveBeenCalled();
    });

    it('a user already active in ANOTHER org gets a 409, not a torn approval', async () => {
      mockTx.qOne
        .mockResolvedValueOnce({applicant_user_id: APPLICANT, team_channel_id: null})
        .mockResolvedValueOnce(null);   // no existing row in THIS org
      mockTx.q.mockRejectedValueOnce(Object.assign(new Error('dup'), {code: '23505'}));
      await expect(svc.decideJoinRequest(ORG, ADMIN, 'req-1', 'approved'))
        .rejects.toThrow(ConflictException);
    });

    it('REFUSES to silently reinstate a non-employee (a removed manager must not return as manager)', async () => {
      // `DO UPDATE SET status='active'` left member_role untouched, so a
      // deliberately-removed 'manager' came back with full OrgManagerGuard
      // powers — including approving further joins — from a click labelled
      // only "Approve". enrollEmployee refuses exactly this move.
      // Phase B removed grantMembership's owner probe, so the roster read is
      // now the SECOND tx read (was third).
      mockTx.qOne
        .mockResolvedValueOnce({applicant_user_id: APPLICANT, team_channel_id: null})
        .mockResolvedValueOnce({member_role: 'manager', status: 'removed'});
      // The SPECIFIC message, not just the class — a queue misalignment would
      // throw a DIFFERENT 409 and a bare toThrow(ConflictException) could
      // never tell.
      await expect(svc.decideJoinRequest(ORG, ADMIN, 'req-1', 'approved'))
        .rejects.toThrow('member_exists_use_roster_status');
    });

    it('REFUSES to lift a suspension through an approval — that is a roster operation', async () => {
      // Suspension is an audited state with a window and a reason; both join
      // lanes would otherwise reactivate it silently (in the invite lane the
      // minting admin cannot even know — the mint is match-blind).
      mockTx.qOne
        .mockResolvedValueOnce({applicant_user_id: APPLICANT, team_channel_id: null})
        .mockResolvedValueOnce({member_role: 'employee', status: 'suspended'});
      await expect(svc.decideJoinRequest(ORG, ADMIN, 'req-1', 'approved'))
        .rejects.toThrow('member_suspended_use_roster_status');
    });

    it('Phase B — a WORKSPACE OWNER may be granted membership (the owner refusal is gone)', async () => {
      // Founder-approved 2026-08-09. This test previously pinned the refusal
      // (rejects.toThrow workspace_owner_cannot_join) and went RED when the
      // check was removed — flipped deliberately per the bug-regression
      // contract. The identity split is handled structurally now: /auth/me's
      // four-arm primary-org precedence + the workspaces array
      // (account-kind.ts), and the one-active-org index still bounds the
      // membership count. grantMembership no longer probes org_workspaces:
      // the flow goes straight to the existing-row check.
      mockTx.qOne
        .mockResolvedValueOnce({applicant_user_id: APPLICANT, team_channel_id: null})
        .mockResolvedValueOnce(null);           // no existing org_members row
      mockTx.q.mockResolvedValue([]);
      await expect(svc.decideJoinRequest(ORG, ADMIN, 'req-1', 'approved'))
        .resolves.toBeDefined();
      // The ownership probe must be GONE from the grant path.
      for (const call of mockTx.qOne.mock.calls) {
        expect(String(call[0])).not.toMatch(/org_workspaces/);
      }
    });

    it('REFUSES a self-grant — an org cannot hire itself', async () => {
      mockTx.qOne.mockResolvedValueOnce({applicant_user_id: ORG, team_channel_id: null});
      await expect(svc.decideJoinRequest(ORG, ADMIN, 'req-1', 'approved'))
        .rejects.toThrow('cannot_join_own_workspace');
    });

    it('APPROVE seeds the referred team\'s PATH — not every channel in the org', async () => {
      /**
       * FLIPPED DELIBERATELY by vs2 item 2 (P2-d), per the bug-regression
       * contract. This test previously asserted the opposite — that `ch-other`,
       * a channel with no relationship to the referred team, was seeded too,
       * because "membership, not the referral, is what entitles them".
       *
       * That was the defect the client reported: the team picker in front of
       * this flow was decorative, and every approval granted the whole
       * workspace. With more than one organisation per workspace it is a
       * cross-organisation grant issued on every join.
       *
       * The rest of the original test is preserved, because it is still exactly
       * right: the role must come from EACH channel's own post_mode, and the
       * write must route through addMember (which enqueues the rekey intent)
       * rather than a raw INSERT.
       */
      mockTx.qOne
        .mockResolvedValueOnce({applicant_user_id: APPLICANT, team_channel_id: 'ch-team'})
        .mockResolvedValueOnce(null);
      // The in-tx scope read comes FIRST, then the org_members write.
      mockTx.q
        .mockResolvedValueOnce([
          {id: 'ch-team', parent_id: 'ch-root', access: 'standard', channel_type: 'department', is_broadcast: false},
          {id: 'ch-root', parent_id: null, access: 'standard', channel_type: 'department', is_broadcast: false},
          {id: 'ch-other', parent_id: null, access: 'standard', channel_type: 'department', is_broadcast: false},
        ])
        .mockResolvedValueOnce([]);                                            // org_members write (tx)
      mockDb.q.mockResolvedValueOnce([
        {id: 'ch-team', access: 'standard', channel_type: 'department', post_mode: 'open'},
        {id: 'ch-root', access: 'standard', channel_type: 'department', post_mode: 'read_only'},
        {id: 'ch-other', access: 'standard', channel_type: 'department', post_mode: 'read_only'},
      ]);
      await svc.decideJoinRequest(ORG, ADMIN, 'req-1', 'approved');

      // The team's ANCESTOR is seeded — you cannot be in Fort Hunter without
      // seeing SASFA above it — with the role ITS OWN post_mode implies:
      // `read_only` → viewer, while the open team channel → admin (poster).
      // Two channels with different post_modes prove the mapping is applied per
      // channel rather than once for the whole seed.
      // Trailing args: no role_label, and the DECIDING ADMIN as the audit
      // actor (I-a M1) — the org stays the authorization identity.
      expect(mockDepartment.addMember).toHaveBeenCalledWith(
        ORG, 'ch-root', APPLICANT, 'viewer', undefined, ADMIN);
      // …and the UNRELATED root is NOT. This is the whole change.
      expect(mockDepartment.addMember).not.toHaveBeenCalledWith(
        ORG, 'ch-other', APPLICANT, expect.anything(), expect.anything(), expect.anything());
      expect(mockDepartment.addMember).toHaveBeenCalledTimes(2);

      // MUST route through addMember, never a raw INSERT.
      //
      // addMember writes the row AND enqueues the rekey intent — the only
      // writer of channel_membership_intents. A raw INSERT gave the member
      // roster rows with NO group master key: listChannels returned the
      // channels, the UI listed them, and every message was undecryptable.
      // Asserting on the INSERT text would have passed for exactly that bug,
      // so assert the CALL.
      expect(mockDepartment.addMember).toHaveBeenCalledWith(
        ORG, 'ch-team', APPLICANT, 'admin', undefined, ADMIN);
      const raw = mockDb.q.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
      expect(raw).not.toMatch(/INSERT INTO public\.department_channel_members/);
    });

    it('never seeds a managers-only channel, even as the referred team', async () => {
      // createReferralLink now refuses one at mint, but the seed must not rely
      // on that: "the referred team ALWAYS" was stated over a narrower surface
      // than the code had, and force-seeded an employee into a restricted or
      // incident channel as a POSTER (post_mode defaults to 'open').
      //
      // The referred team is managers-only and has a LIVE ordinary parent, so
      // P2-d's fallback climbs to the parent rather than refusing. The original
      // claim still holds and is what is asserted: the restricted team itself is
      // never seeded.
      mockTx.qOne
        .mockResolvedValueOnce({applicant_user_id: APPLICANT, team_channel_id: 'ch-restricted'})
        .mockResolvedValueOnce(null);
      mockTx.q
        .mockResolvedValueOnce([
          {id: 'ch-restricted', parent_id: 'ch-root', access: 'restricted', channel_type: 'department', is_broadcast: false},
          {id: 'ch-root', parent_id: null, access: 'standard', channel_type: 'department', is_broadcast: false},
          {id: 'ch-incident', parent_id: 'ch-root', access: 'standard', channel_type: 'incident', is_broadcast: false},
        ])
        .mockResolvedValueOnce([]);
      mockDb.q.mockResolvedValueOnce([
        {id: 'ch-restricted', access: 'restricted', channel_type: 'department', post_mode: 'open'},
        {id: 'ch-incident', access: 'standard', channel_type: 'incident', post_mode: 'open'},
        {id: 'ch-root', access: 'standard', channel_type: 'department', post_mode: 'open'},
      ]);
      await svc.decideJoinRequest(ORG, ADMIN, 'req-1', 'approved');
      for (const dead of ['ch-restricted', 'ch-incident']) {
        expect(mockDepartment.addMember).not.toHaveBeenCalledWith(
          ORG, dead, APPLICANT, expect.anything(), expect.anything(), expect.anything());
      }
      // The fallback landed them somewhere real rather than nowhere.
      expect(mockDepartment.addMember).toHaveBeenCalledWith(
        ORG, 'ch-root', APPLICANT, 'admin', undefined, ADMIN);
    });

    it('REFUSES the approval when the team AND its whole chain are unseedable', async () => {
      /**
       * NEW with P2-d. Previously this approved "successfully" and seeded
       * nothing: the applicant became a real member of an org in which they
       * could see zero channels, with HTTP 200, no warning, and a join request
       * marked approved. That state is indistinguishable from a working join
       * until they open the app.
       *
       * Refusing rolls the claim back, so the request stays pending and the
       * admin gets an error naming the actual problem.
       */
      mockTx.qOne
        .mockResolvedValueOnce({applicant_user_id: APPLICANT, team_channel_id: 'ch-restricted'})
        .mockResolvedValueOnce(null);
      mockTx.q.mockResolvedValueOnce([
        {id: 'ch-restricted', parent_id: null, access: 'restricted', channel_type: 'department', is_broadcast: false},
      ]);
      await expect(svc.decideJoinRequest(ORG, ADMIN, 'req-1', 'approved'))
        .rejects.toThrow('team_channel_unavailable_reinvite');
      expect(mockDepartment.addMember).not.toHaveBeenCalled();
    });

    it('notifies the applicant on a decision, and the admin on submit', async () => {
      mockTx.qOne
        .mockResolvedValueOnce({applicant_user_id: APPLICANT, team_channel_id: null})
        .mockResolvedValueOnce(null);
      await svc.decideJoinRequest(ORG, ADMIN, 'req-1', 'approved');
      expect(mockPush.enterpriseJoinDecided).toHaveBeenCalledWith(APPLICANT, 'approved');
    });

    it('R13-2 — the wake rides the bridge; a direct record() would double-write the inbox row', () => {
      // Source scan: the bridge's publish() already writes the durable
      // notifications row (N-20). A second, direct NotificationsService call in
      // this service means every join event lands in the Activity Centre twice.
      // COMMENT-STRIPPED first (the repo's scan rule): prose naming the banned
      // token is the most common false result in this repo's source scans.
      // Block comments FIRST, then line tails — the repo's canonical strip
      // order (a `//` inside a one-line block comment would otherwise eat the
      // block's terminator and let the block regex swallow real code).
      const src = readFileSync(join(__dirname, 'enterprise-join.service.ts'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split(/\r?\n/)
        .map(line => {
          const i = line.indexOf('//');
          return i >= 0 ? line.slice(0, i) : line;
        })
        .join('\n');
      expect(src).not.toMatch(/notifications\.record\(/);
      expect(src).not.toMatch(/from '\.\.\/notifications\/notifications\.service'/);
      // Anti-vacuity: the file still routes through the bridge.
      expect(src).toMatch(/this\.push\.enterpriseJoinRequested\(/);
      expect(src).toMatch(/this\.push\.enterpriseJoinDecided\(/);
    });

    it('the SECOND admin gets a conflict, not a 404 and not a silent overwrite', async () => {
      mockTx.qOne
        .mockResolvedValueOnce(null)                 // conditional update claimed nothing
        .mockResolvedValueOnce({status: 'approved'}); // …because it was already decided
      await expect(svc.decideJoinRequest(ORG, ADMIN, 'req-1', 'declined'))
        .rejects.toThrow(ConflictException);
    });

    it('a request that never existed in this org is a 404', async () => {
      mockTx.qOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      await expect(svc.decideJoinRequest(ORG, ADMIN, 'req-x', 'approved'))
        .rejects.toThrow(NotFoundException);
    });

    it('APPROVE is what creates the membership row — ON THE TX HANDLE', async () => {
      mockTx.qOne.mockResolvedValueOnce({applicant_user_id: APPLICANT, team_channel_id: 'ch-2'});
      // P2-d resolves the seed scope on the same handle, before the grant, so
      // the referred team has to exist in the in-tx read or the approval is
      // (correctly) refused as unseedable.
      mockTx.q.mockResolvedValueOnce([
        {id: 'ch-2', parent_id: null, access: 'standard', channel_type: 'department', is_broadcast: false},
      ]);
      await svc.decideJoinRequest(ORG, ADMIN, 'req-1', 'approved');
      // Asserting on the TX handle is what makes this pin the C1 fix: moving the
      // grant back outside the transaction now leaves mockTx.q empty and fails,
      // where the shared-handle mock could not tell the difference.
      const grantCall = mockTx.q.mock.calls.find(
        (c: unknown[]) => /INSERT INTO (public\.)?org_members\b/.test(String(c[0])));
      expect(grantCall).toBeTruthy();
      // Since the grant moved into the shared grantMembership helper (Item E),
      // role and department travel as PARAMS. The approve path must still grant
      // exactly 'employee' with NO branch — an Enterprise joiner is back-office
      // staff, never a deployable CPO (the rule-7 / A7.3 distinction), and only
      // a manager INVITE may carry a department.
      expect(grantCall?.[1]).toEqual([ORG, APPLICANT, 'employee', null, ADMIN]);
    });

    it('DECLINE grants nothing but is still recorded', async () => {
      mockTx.qOne.mockResolvedValueOnce({applicant_user_id: APPLICANT, team_channel_id: null});
      await svc.decideJoinRequest(ORG, ADMIN, 'req-1', 'declined');
      const written = mockDb.q.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
      expect(written).not.toMatch(/INSERT INTO (public\.)?org_members\b/);
      // M11A: "the decision remains in the Admin record".
      expect(mockAudit.log).toHaveBeenCalledWith(
        ORG, ADMIN, 'enterprise.join.declined', expect.anything());
    });
  });
});

describe('Phase 3 — TENANCY (page 10 rule 2)', () => {
  /**
   * "One Enterprise must never access another Enterprise's records or metadata."
   *
   * Three of six service methods had NO coverage at all, so deleting each scope
   * passed 16/16: every admin could read every Enterprise's applicants (name,
   * phone, email, team, message); any user could read the newest join request
   * system-wide; and an admin could mint a link pointing at another Enterprise's
   * branch. Each is now pinned at its own decision site.
   */
  let svc: EnterpriseJoinService;
  beforeEach(async () => {
    jest.clearAllMocks();
    mockDb.q.mockResolvedValue([]);
    mockTx.q.mockReset().mockResolvedValue([]);
    mockTx.qOne.mockReset();
    // mockReset, not just clearAllMocks: `clearAllMocks` clears recorded CALLS
    // but NOT a queued `mockResolvedValueOnce` chain. A test that throws before
    // consuming its whole queue therefore leaks the remainder into the next
    // test, which makes this suite silently order-dependent — the write-path
    // refusal test queues three values and consumes one by design.
    mockDb.qOne.mockReset();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EnterpriseJoinService,
        {provide: DatabaseService, useValue: mockDb},
        {provide: OrgAuditService, useValue: mockAudit},
        {provide: BookingPushBridge, useValue: mockPush},
        {provide: DepartmentService, useValue: mockDepartment},
      ],
    }).compile();
    svc = module.get(EnterpriseJoinService);
  });

  it('listPendingRequests is scoped to the calling org AND the manager branch', async () => {
    await svc.listPendingRequests(ORG, 'Ops');
    const sql = String(mockDb.q.mock.calls[0][0]);
    expect(sql).toMatch(/r\.org_user_id = \$1/);
    // OrgManagerContext.department is a FORCED FILTER — attendance and incidents
    // both apply it; dropping it let a scoped manager act outside their branch.
    // …and a teamless request must remain visible to a scoped manager rather
    // than being swallowed by "NULL = 'Ops'".
    expect(sql).toMatch(/\$2::text IS NULL\s+OR COALESCE\(CASE WHEN c\.archived_at IS NULL THEN c\.department END, \$2\) = \$2/);
    expect(mockDb.q.mock.calls[0][1]).toEqual([ORG, 'Ops']);
  });

  /**
   * THE INVARIANT THAT DRIFTED, pinned as one rule rather than two literals.
   *
   * `listPendingRequests` and `decideJoinRequest` must answer the SAME question
   * — "is this request in my branch?" — or a manager can act on what their own
   * inbox hides. They diverged silently: the list excluded archived channels in
   * its join while the claim resolved the channel with no archive check, so for
   * an ARCHIVED team a scoped manager could not SEE a request but could still
   * DECIDE it. Separately, both tested the RAW `r.team_channel_id IS NULL`,
   * which asks "is there a team id" rather than "does it resolve" — so an
   * archived team was neither routed nor unrouted and the request vanished from
   * every scoped manager's inbox.
   *
   * Assert the shared shape, not two independent strings: two literals are
   * exactly how they drifted in the first place.
   */
  it('the branch rule is IDENTICAL in the list and in the claim', async () => {
    await svc.listPendingRequests(ORG, 'Ops');
    const listSql = String(mockDb.q.mock.calls[0][0]);

    mockTx.qOne.mockResolvedValueOnce({applicant_user_id: APPLICANT, team_channel_id: null});
    await svc.decideJoinRequest(ORG, ADMIN, 'req-1', 'approved');
    const claimSql = String(mockTx.qOne.mock.calls[0][0]);

    // Both fold every UNRESOLVABLE team (none / deleted / archived) into
    // "unrouted", which belongs in every manager's inbox.
    const RULE = /COALESCE\([\s\S]*?CASE WHEN c\.archived_at IS NULL THEN c\.department END[\s\S]*?\)\s*=\s*\$\d/;
    expect(listSql).toMatch(RULE);
    expect(claimSql).toMatch(RULE);
    // And neither may fall back to the raw column, which is the bug.
    expect(listSql).not.toMatch(/r\.team_channel_id IS NULL OR c\.department/);
    expect(claimSql).not.toMatch(/r\.team_channel_id IS NULL OR EXISTS/);
  });

  /**
   * ARCHIVING A CHANNEL MUST NOT DISARM THE MANAGERS-ONLY REFUSAL.
   *
   * The first version of the archived-team fix put `AND c.archived_at IS NULL`
   * on the JOIN, which also nulled `team_access`/`team_type` — so the
   * fail-closed check below them was skipped and links to an archived
   * restricted channel became submittable again. The access columns must
   * resolve unconditionally; only the display name degrades.
   */
  it('resolves team ACCESS regardless of archive state, and only degrades the NAME', () => {
    const src = readFileSync(join(__dirname, 'enterprise-join.service.ts'), 'utf8')
      .replace(/\r\n/g, '\n');
    // No team-resolving join may carry the archive filter…
    expect(src).not.toMatch(/ON c\.id = [lr]\.team_channel_id AND c\.archived_at IS NULL/);
    // …and every place a team NAME is selected gates it with the CASE instead.
    const names = src.match(/c\.name AS team_name/g) ?? [];
    expect(names).toHaveLength(0);
    expect((src.match(/CASE WHEN c\.archived_at IS NULL THEN c\.name END AS team_name/g) ?? []).length)
      .toBeGreaterThanOrEqual(3);
    // The access columns stay unfiltered so the refusal still fires.
    expect(src).toMatch(/c\.access AS team_access, c\.channel_type AS team_type/);
    // The THIRD leg: the department that drives the notify fan-out degrades the
    // same way the inbox predicate does, or the two disagree for an archived
    // team — fan-out to one branch, inbox visible to all.
    expect(src).toMatch(/CASE WHEN c\.archived_at IS NULL THEN c\.department END AS team_department/);
    expect(src).not.toMatch(/c\.department AS team_department/);
  });

  /**
   * The one service method this block missed, while its own docblock claimed
   * "each is now pinned at its own decision site".
   *
   * A referral code is, in this service's own words, the sole capability needed
   * to read another Enterprise's name and team AND to inject a row into its
   * admin inbox. So an unscoped list is not merely a metadata read — it is a
   * join vector. The shipped query is correct; nothing was asserting it.
   */
  it('listReferralLinks is scoped to the calling org', async () => {
    await svc.listReferralLinks(ORG);
    const sql = String(mockDb.q.mock.calls[0][0]);
    expect(sql).toMatch(/WHERE l\.org_user_id = \$1/);
    expect(mockDb.q.mock.calls[0][1]).toEqual([ORG]);
  });

  it('myJoinRequest is scoped to the CALLER', async () => {
    mockDb.qOne.mockResolvedValueOnce(null);
    await svc.myJoinRequest(APPLICANT);
    const sql = String(mockDb.qOne.mock.calls[0][0]);
    expect(sql).toMatch(/r\.applicant_user_id = \$1/);
    expect(mockDb.qOne.mock.calls[0][1]).toEqual([APPLICANT]);
  });

  it('createReferralLink refuses a team channel belonging to another Enterprise', async () => {
    mockDb.qOne.mockResolvedValueOnce({org_id: 'some-other-org'});
    await expect(svc.createReferralLink(ORG, ADMIN, {team_channel_id: 'ch-foreign'}))
      .rejects.toThrow(BadRequestException);
    const written = mockDb.qOne.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(written).not.toMatch(/INSERT INTO public\.enterprise_referral_links/);
  });

  /**
   * FOUND ON STAGING, NOT BY A TEST — and this is why.
   *
   * `org_audit_log.target_id` is a UUID column. Both referral-link audit
   * calls passed the CODE ('YLDZ3KGV', 8 chars), so Postgres rejected the
   * audit INSERT with `invalid input syntax for type uuid` and the whole
   * endpoint 500'd. Minting a link was impossible, which blocks the entire
   * join -> approve loop the planning doc calls "the whole feature".
   *
   * No unit test could see it: OrgAuditService is MOCKED in every spec, so
   * the audit INSERT never executes and any value looks fine. The mock is
   * what hid it, so the test has to assert the SHAPE of what we hand the
   * mock rather than trusting that it was accepted.
   */
  it('audits referral links against the row UUID, never the code', async () => {
    mockDb.qOne.mockResolvedValueOnce({id: 'a1b2c3d4-1111-2222-3333-444455556666',
      code: 'YLDZ3KGV', expires_at: null});
    await svc.createReferralLink(ORG, ADMIN, {});

    const call = mockAudit.log.mock.calls.find(
      (c: unknown[]) => String(c[2]) === 'enterprise.referral_link.create');
    expect(call).toBeDefined();
    const opts = call![3] as {targetId?: string; metadata?: Record<string, unknown>};
    // A UUID, because the column is uuid. The 8-char code is NOT one.
    expect(opts.targetId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    // …and the code is not lost — metadata is jsonb, where a string is valid.
    // Minted internally by mintCode(), so assert its SHAPE, not a fixture value.
    expect(String(opts.metadata?.code)).toMatch(/^[A-Z0-9]{8}$/);
  });

  it('audits a REVOKE against the row UUID too', async () => {
    mockDb.qOne.mockResolvedValueOnce({id: 'b2c3d4e5-1111-2222-3333-444455556666'});
    await svc.revokeReferralLink(ORG, ADMIN, 'ylDZ3kgv');
    const call = mockAudit.log.mock.calls.find(
      (c: unknown[]) => String(c[2]) === 'enterprise.referral_link.revoke');
    expect(call).toBeDefined();
    const opts = call![3] as {targetId?: string; metadata?: Record<string, unknown>};
    expect(opts.targetId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(opts.metadata?.code).toBe('YLDZ3KGV');
  });

  it('revokeReferralLink scopes in the WHERE clause, not a pre-read', async () => {
    mockDb.qOne.mockResolvedValueOnce(null);
    await expect(svc.revokeReferralLink(ORG, ADMIN, 'ABCD1234')).rejects.toThrow(NotFoundException);
    const sql = String(mockDb.qOne.mock.calls[0][0]);
    expect(sql).toMatch(/WHERE code = \$1 AND org_user_id = \$2/);
  });

  it('the invite code comes from a CSPRNG, not Math.random', () => {
    // A code is the sole capability needed to read another Enterprise's name and
    // team and to inject into its admin inbox. V8's Math.random state is
    // recoverable from observed output; every other token mint in auth-service
    // uses node:crypto.
    const src = source('enterprise-join.service.ts');
    expect(src).toMatch(/randomInt/);
    expect(src).not.toMatch(/Math\.random/);
  });

  /**
   * ROUND 12 — the rules that CONSUME what the SQL provides.
   *
   * Every branch-scope and fail-closed rule in this phase was pinned by
   * scanning two query literals inside enterprise-join.service.ts. Everything
   * around them — the controller wiring, the TypeScript refusals that read the
   * columns those queries return, the notify fan-out, the submit-side
   * department derivation — had no coverage at all, and eight separate
   * mutations to those rules survived the full suite.
   *
   * That is R11-3's own lesson one layer up: restoring the DATA a check needs,
   * and pinning the data, proves nothing about whether the CHECK still fires.
   */
  describe('page 10 rule 2 — the rules that consume the data, not just the SQL', () => {
    it('the READ path refuses a managers-only team, even when it is archived', async () => {
      // The archived case is the one that regressed: gating the join on
      // archived_at nulled team_access and skipped this refusal entirely, so
      // archiving a restricted channel made its links resolvable again.
      mockDb.qOne.mockResolvedValueOnce({
        org_name: 'Acme', team_name: null,          // name degraded: archived
        team_access: 'restricted', team_type: 'department',   // access still resolves
      });
      await expect(svc.resolveReferralLink('CODE12')).resolves.toEqual({valid: false});
    });

    it('the WRITE path refuses it too — the UI is not the boundary', async () => {
      // The REST of the happy path is mocked deliberately, so that deleting the
      // refusal makes this call SUCCEED rather than fail somewhere downstream.
      // The first version stubbed only the link lookup: with the refusal removed
      // the mock chain ran dry, the insert returned undefined, and the method
      // threw `join_request_create_failed` — still a BadRequestException, so
      // `rejects.toThrow(BadRequestException)` passed and the mutation survived.
      // Assert the CLASS AND THE REASON, and leave a working path underneath.
      mockDb.qOne
        .mockResolvedValueOnce({
          id: 'lnk-1', org_user_id: ORG, referrer_user_id: null, team_channel_id: 'ch-r',
          team_access: 'restricted', team_type: 'department', team_department: null,
        })
        .mockResolvedValueOnce(null)                 // not already a member
        .mockResolvedValueOnce({id: 'req-1'});       // the insert would succeed
      await expect(svc.submitJoinRequest(APPLICANT, {code: 'CODE12'}))
        .rejects.toThrow(/referral_link_invalid_or_expired/);
      // And nothing was written.
      const writes = [...mockDb.q.mock.calls, ...mockDb.qOne.mock.calls]
        .map(c => String(c[0])).join('\n');
      expect(writes).not.toMatch(/INSERT INTO public\.enterprise_join_requests/);
    });

    it('an incident channel is refused on both paths as well', async () => {
      mockDb.qOne.mockResolvedValueOnce({
        org_name: 'Acme', team_name: 'IR', team_access: 'standard', team_type: 'incident',
      });
      await expect(svc.resolveReferralLink('CODE12')).resolves.toEqual({valid: false});
    });

    it('the fan-out is scoped to the SAME branch the inbox will show', async () => {
      // resolveOrgManagers' own docblock says the fan-out and the inbox must
      // agree; nothing asserted that the department actually reached it.
      mockDb.qOne
        .mockResolvedValueOnce({
          id: 'lnk-1', org_user_id: ORG, referrer_user_id: 'ref-1', team_channel_id: 'ch-1',
          team_access: 'standard', team_type: 'department', team_department: 'Ops',
        })
        .mockResolvedValueOnce(null)                       // not already a member
        .mockResolvedValueOnce({id: 'req-1'});             // the insert
      await svc.submitJoinRequest(APPLICANT, {code: 'CODE12'});

      const mgrCall = mockDb.q.mock.calls.find(c => /FROM org_members/.test(String(c[0])));
      expect(mgrCall).toBeDefined();
      expect((mgrCall as unknown[])[1]).toEqual([ORG, 'Ops']);
      // The admin wake actually fires (the org account is always in the set —
      // the manager query above returned no delegated managers here). Note the
      // REFERRER is deliberately absent: a non-manager referrer's tap 403s on
      // the manager-only inbox, so "notified" must equal "can action".
      // vs2 edge A2 — and it names WHICH org, or a two-org admin's tap opens
      // whichever workspace their session happened to be sticky on.
      expect(mockPush.enterpriseJoinRequested).toHaveBeenCalledWith(ORG, ORG);
      // Asserted on the RECIPIENT arg, not on the whole arg list: an exact-args
      // `not.toHaveBeenCalledWith('ref-1')` silently stopped meaning anything
      // the moment the call grew a second argument.
      expect(mockPush.enterpriseJoinRequested.mock.calls.map(c => c[0])).not.toContain('ref-1');
      // A manager with NO department is org-wide and must still be notified —
      // dropping that clause silently stops paging every unscoped manager.
      const mgrSql = String((mgrCall as unknown[])[0]);
      expect(mgrSql).toMatch(/department IS NULL OR department = \$2/);
      // The OTHER half of the same predicate: only ACTIVE MANAGERS. The
      // department half was pinned and the role/status half was not, so
      // dropping it paged every employee and every removed member with the
      // applicant's page-10 metadata.
      expect(mgrSql).toMatch(/member_role = 'manager'/);
      expect(mgrSql).toMatch(/status = 'active'/);
    });

    it('an ARCHIVED team fans out to EVERY manager, matching the inbox', async () => {
      // team_department degrades to NULL for an archived team, so the request is
      // "unrouted" — and listPendingRequests shows an unrouted request to every
      // manager. The fan-out has to make the same call or the two disagree.
      mockDb.qOne
        .mockResolvedValueOnce({
          id: 'lnk-1', org_user_id: ORG, referrer_user_id: null, team_channel_id: 'ch-arch',
          team_access: 'standard', team_type: 'department', team_department: null,
        })
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({id: 'req-1'});
      await svc.submitJoinRequest(APPLICANT, {code: 'CODE12'});

      const mgrCall = mockDb.q.mock.calls.find(c => /FROM org_members/.test(String(c[0])));
      expect((mgrCall as unknown[])[1]).toEqual([ORG, null]);
    });

    it('the conflict/404 lookup is itself org-scoped — no cross-org id oracle', async () => {
      // Without `AND org_user_id = $2` this SELECT answers "does this request id
      // exist anywhere" — a 409-vs-404 existence oracle over another
      // Enterprise's request ids.
      mockTx.qOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      await expect(svc.decideJoinRequest(ORG, ADMIN, 'req-1', 'approved'))
        .rejects.toThrow(NotFoundException);
      const seenCall = mockTx.qOne.mock.calls
        .find(c => /SELECT status FROM public\.enterprise_join_requests/.test(String(c[0])));
      expect(seenCall).toBeDefined();
      expect(String((seenCall as unknown[])[0])).toMatch(/WHERE id = \$1 AND org_user_id = \$2/);
      expect((seenCall as unknown[])[1]).toEqual(['req-1', ORG]);
    });

    it('an out-of-scope manager gets 404, never a false "already decided"', async () => {
      // The claim matched nothing but the row is STILL pending ⇒ it was the
      // branch filter, not another admin. Reporting a conflict would both lie
      // and confirm the request id exists to someone outside its branch.
      mockTx.qOne
        .mockResolvedValueOnce(null)                       // claim matched nothing
        .mockResolvedValueOnce({status: 'pending'});       // ...and it is still pending
      await expect(svc.decideJoinRequest(ORG, ADMIN, 'req-1', 'approved', 'OtherBranch'))
        .rejects.toThrow(NotFoundException);
    });

    it('a genuinely-decided request still yields the CONFLICT state', async () => {
      // The other half of the same branch — proving the 404 above is not simply
      // swallowing every miss.
      mockTx.qOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({status: 'approved'});
      await expect(svc.decideJoinRequest(ORG, ADMIN, 'req-1', 'approved'))
        .rejects.toThrow(ConflictException);
    });

    it('EVERY admin route passes the manager branch through to the service', () => {
      // MUT-H: changing the controller to pass `null` disarmed the forced filter
      // entirely — a scoped manager would see every branch's applicant name,
      // phone, email and message — and the whole suite stayed green, because
      // every existing pin asserted the SQL and none asserted the wiring.
      const ctl = source('enterprise-join.controller.ts');
      expect(ctl).toMatch(/listPendingRequests\(mgr\.org_user_id, mgr\.department\)/);
      expect((ctl.match(/decideJoinRequest\([^)]*mgr\.department\)/g) ?? [])).toHaveLength(2);
      // And no admin route may hand the service a hard-coded null scope.
      expect(ctl).not.toMatch(/listPendingRequests\([^)]*,\s*null\)/);
      expect(ctl).not.toMatch(/decideJoinRequest\([^)]*,\s*null\)/);
    });
  });
});

describe('Phase 3 — structural invariants', () => {
  it('ONLY the approve path may write org_members', () => {
    // If submit (or any future helper) writes a membership row, "pending means
    // blank" collapses — and it collapses silently, because every module would
    // then legitimately show that user content.
    const src = source('enterprise-join.service.ts');
    // ANY MEMBERSHIP TABLE, not just org_members.
    //
    // The invariant named one table while TWO grant access:
    // `department_channel_members` alone makes channels visible (listChannels
    // joins only that table) and, routed through addMember, mints rekey intents
    // — i.e. hands over group master keys. Seeding channels from
    // submitJoinRequest passed 27/27 with the old anchor.
    const grants = /(INSERT INTO|UPDATE)\s+(public\.)?(org_members|department_channel_members)\b|\.addMember\(/g;

    // EXACT count, not a ceiling: `<=` also passed when the reinstatement UPDATE
    // was deleted, so the pin accepted a regression in the safe direction too.
    const writes = src.match(grants) ?? [];
    expect(writes.length).toBe(3);   // INSERT + reinstate UPDATE + the addMember seed

    // Item E moved the two org_members writes into the SHARED grantMembership
    // helper — the single writer both the approve path and invite acceptance
    // call, so the reinstatement rules cannot drift between them. Both writes
    // must sit INSIDE that helper's own region, and nowhere else.
    const gmStart = src.indexOf('private async grantMembership(');
    expect(gmStart).toBeGreaterThan(-1);
    const gmEnd = src.indexOf('\n  async createMemberInvite(', gmStart);
    expect(gmEnd).toBeGreaterThan(gmStart);
    const grantRegion = src.slice(gmStart, gmEnd);
    expect((grantRegion.match(grants) ?? []).length).toBe(2);
    // And both its callers hand it a TX handle, never the pooled connection —
    // the call sites read `this.grantMembership(tx, …)` by contract.
    expect((src.match(/this\.grantMembership\(\s*\n?\s*tx,/g) ?? []).length).toBe(2);
    expect(src).not.toMatch(/grantMembership\(\s*this\.db/);

    // And submit must contain NONE of them.
    const submit = src.slice(src.indexOf('async submitJoinRequest('), src.indexOf('async myJoinRequest('));
    expect(submit.match(grants) ?? []).toHaveLength(0);
    expect(submit).not.toMatch(/seedApprovedMemberChannels/);

    // THE THIRD LOCATION, so the count above is a CONSEQUENCE of three known
    // sites rather than a bare number. `toBe(3)`'s social failure mode is that
    // the next legitimate write turns it red and the obvious fix is bumping it
    // to 4 — which is precisely where an illegitimate write would hide. With all
    // three located, a bump has to be justified per-site.
    const seedStart = src.indexOf('private async seedApprovedMemberChannels(');
    expect(seedStart).toBeGreaterThan(-1);
    const seedRegion = src.slice(seedStart, src.indexOf('\n  private ', seedStart + 10));
    expect((seedRegion.match(grants) ?? []).length).toBe(1);
  });

  it('the applicant DTO carries no team field', () => {
    // M5: "The applicant cannot change the requested department or team."
    // Accepting one even to ignore it invites a later edit to honour it.
    const dto = source(join('dto', 'join.dto.ts'));
    const start = dto.indexOf('class SubmitJoinRequestDto');
    expect(start).toBeGreaterThan(-1);
    // Bounded to THIS class: CreateMemberInviteDto below it legitimately
    // carries team_channel_id/invited_department — there the ADMIN sets them at
    // mint, which is the exact opposite of the applicant choosing.
    const nextClass = dto.indexOf('export class', start + 1);
    const submit = nextClass === -1 ? dto.slice(start) : dto.slice(start, nextClass);
    expect(submit).not.toMatch(/team_channel_id/);
    expect(submit).not.toMatch(/department/);
  });

  it('applicant routes are NOT behind DeptChatAccessGuard, admin routes ARE manager-gated', () => {
    const ctl = source('enterprise-join.controller.ts');
    // The guard admits only existing members; an applicant is by definition not
    // one, so putting join routes behind it makes joining impossible.
    expect(ctl).not.toMatch(/DeptChatAccessGuard/);
    // Page 10 rule 2 — "Members never … approve join requests."
    const admin = ctl.slice(ctl.indexOf('createLink'));
    for (const route of ['createLink', 'pending', 'approve', 'decline']) {
      expect(`${route}:${admin.includes(route)}`).toBe(`${route}:true`);
    }
    expect((ctl.match(/OrgManagerGuard/g) ?? []).length).toBeGreaterThanOrEqual(5);
  });

  it('there is no free-text status endpoint — exactly Approve or Decline', () => {
    // A11: "Admin decision actions are exactly Approve or Decline." Two routes
    // rather than one taking a status string means no third state can be minted.
    const ctl = source('enterprise-join.controller.ts');
    expect(ctl).toMatch(/join-requests\/:id\/approve/);
    expect(ctl).toMatch(/join-requests\/:id\/decline/);
    expect(ctl).not.toMatch(/@Body\(\)\s*\w*\s*:\s*\{?\s*status/);
  });

  it('the migration keeps a pending row un-writable in org_members', () => {
    const mig = readFileSync(
      join(process.cwd(), '..', '..', 'supabase', 'migrations', '20260803030000_enterprise_join_requests.sql'),
      'utf8').replace(/\r\n/g, '\n').split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
    // Defence in depth for the whole design: 12 org_members reads do NOT filter
    // on status, so a 'pending' row there would be a live leak.
    expect(mig).toMatch(/CHECK \(status IN \('invited', 'active', 'suspended', 'removed'\)\)/);
    // Idempotency + the admin inbox index.
    expect(mig).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS enterprise_join_requests_one_open/);
    expect(mig).toMatch(/WHERE status = 'pending'/);
  });
});

describe('Item E — member invites by phone/email', () => {
  let svc: EnterpriseJoinService;

  const PHONE = '+8801799306165';
  const EMAIL = 'invitee@example.com';

  /** A live email-bound invite row, minted by the org owner unless overridden. */
  function inviteRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'link-1', org_user_id: ORG, created_by: ORG,
      invited_phone: null, invited_email: EMAIL,
      invited_role: 'employee', invited_department: null, team_channel_id: null,
      // vs2 item 2 (P2-d). The default is null/null, which resolves to the
      // historical org-wide seed — so every pre-existing case in this file is
      // unaffected. The scoped lane needs these set explicitly, and NOT having
      // them here is exactly why the caller-side breadcrumb bug shipped: the
      // pure function was covered, its only real caller never was.
      team_parent_id: null,
      accepted_at: null, revoked_at: null, expires_at: null,
      ...overrides,
    };
  }

  /** Channel rows as the in-tx scope read returns them (archived included). */
  const seedRow = (id: string, parent_id: string | null, over: Record<string, unknown> = {}) => ({
    id, parent_id, access: 'standard', channel_type: 'department',
    is_broadcast: false, archived: false, ...over,
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDb.q.mockReset().mockResolvedValue([]);
    mockDb.qOne.mockReset();
    mockTx.q.mockReset().mockResolvedValue([]);
    mockTx.qOne.mockReset().mockResolvedValue(null);
    mockAudit.log.mockResolvedValue(undefined);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EnterpriseJoinService,
        {provide: DatabaseService, useValue: mockDb},
        {provide: OrgAuditService, useValue: mockAudit},
        {provide: BookingPushBridge, useValue: mockPush},
        {provide: DepartmentService, useValue: mockDepartment},
      ],
    }).compile();
    svc = module.get(EnterpriseJoinService);
  });

  describe('mint — createMemberInvite', () => {
    it('input refusals fire BEFORE any database access', async () => {
      await expect(svc.createMemberInvite(ORG, ADMIN, null, {}))
        .rejects.toThrow('invite_contact_required');
      await expect(svc.createMemberInvite(ORG, ADMIN, null,
        {contact_phone: PHONE, contact_email: EMAIL}))
        .rejects.toThrow('invite_one_contact_only');
      // The server refuses, never guesses, a missing country prefix (B-154 is
      // the CLIENT's job).
      await expect(svc.createMemberInvite(ORG, ADMIN, null, {contact_phone: '01799306165'}))
        .rejects.toThrow('invite_phone_not_e164');
      await expect(svc.createMemberInvite(ORG, ADMIN, null,
        {contact_email: EMAIL, invited_department: 'Ops'}))
        .rejects.toThrow('invite_department_requires_manager_role');
      // A branch-scoped manager cannot mint their way to a peer admin.
      await expect(svc.createMemberInvite(ORG, ADMIN, 'Ops',
        {contact_email: EMAIL, invited_role: 'manager'}))
        .rejects.toThrow('scoped_manager_cannot_grant_admin');
      expect(mockDb.q).not.toHaveBeenCalled();
      expect(mockDb.qOne).not.toHaveBeenCalled();
    });

    /**
     * G6 (founder, 2026-08-19) — "When adding Admins, it should be organization
     * specific only."
     *
     * A teamless invite seeds the joiner across the whole workspace
     * (`resolveSeedScopeInTx` returns `{kind:'orgWide'}` when neither the
     * channel nor the parent breadcrumb is set), which with more than one root
     * is a grant over every organisation in it. For a MANAGER that is exactly
     * the "admins seeing other organizations" the founder asked us to stop —
     * and it was the DEFAULT, because the invite form starts with no team.
     *
     * THE RULE LIVES HERE because the client pre-flight cannot be the boundary:
     * it reads `workspace_tenant` from `listManagedChannels`, so a single
     * failed list load left it undefined and the rule silently off, and an
     * older APK bypassed it entirely.
     */
    describe('G6 — a manager invite must name an organisation', () => {
      const anyTeamExists = (exists: boolean) =>
        mockDb.qOne.mockResolvedValueOnce(exists ? {n: 1} : null);

      it('refuses a TEAMLESS manager invite on a workspace', async () => {
        mockDepartment.isWorkspaceTenant.mockResolvedValueOnce(true);
        anyTeamExists(true);
        await expect(svc.createMemberInvite(ORG, ADMIN, null,
          {contact_email: EMAIL, invited_role: 'manager'}))
          .rejects.toThrow('manager_invite_requires_team');
      });

      it('allows it once a team IS named', async () => {
        // The rule must not be a wall — naming the organisation is the ask.
        mockDb.qOne
          .mockResolvedValueOnce(   // assertMintableTeam
            {org_id: ORG, access: 'standard', channel_type: 'department', department: null,
             archived: false, is_broadcast: false, post_mode: 'open', parent_id: null})
          .mockResolvedValueOnce(null)                                     // adopt probe
          .mockResolvedValueOnce({n: '0'})                                 // cap
          .mockResolvedValueOnce({id: 'l1', code: 'AAAA2222', expires_at: null})
          .mockResolvedValueOnce(null);                                    // silent match
        await expect(svc.createMemberInvite(ORG, ADMIN, null,
          {contact_email: EMAIL, invited_role: 'manager', team_channel_id: 'ch-1'}))
          .resolves.toEqual({code: 'AAAA2222', expires_at: null});
      });

      it('leaves an EMPLOYEE invite alone — that reach is the admin call', async () => {
        mockDb.qOne
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({n: '0'})
          .mockResolvedValueOnce({id: 'l1', code: 'AAAA2222', expires_at: null})
          .mockResolvedValueOnce(null);
        await expect(svc.createMemberInvite(ORG, ADMIN, null,
          {contact_email: EMAIL, invited_role: 'employee'}))
          .resolves.toEqual({code: 'AAAA2222', expires_at: null});
      });

      it('leaves an AGENCY alone — one organisation, so the rule has no meaning', async () => {
        mockDepartment.isWorkspaceTenant.mockResolvedValueOnce(false);
        mockDb.qOne
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({n: '0'})
          .mockResolvedValueOnce({id: 'l1', code: 'AAAA2222', expires_at: null})
          .mockResolvedValueOnce(null);
        await expect(svc.createMemberInvite(ORG, ADMIN, null,
          {contact_email: EMAIL, invited_role: 'manager'}))
          .resolves.toEqual({code: 'AAAA2222', expires_at: null});
      });

      it('leaves a CLEAN workspace alone — the rule would be unsatisfiable', async () => {
        /**
         * With no channels there is nothing to name, and no OTHER organisations
         * to leak into either — which is the entire point of the rule. Refusing
         * here made the first co-admin of a brand-new workspace impossible to
         * invite, and the client screen simultaneously instructed the blocked
         * action ("invite with no specific team, or create channels first").
         */
        mockDepartment.isWorkspaceTenant.mockResolvedValueOnce(true);
        anyTeamExists(false);
        mockDb.qOne
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({n: '0'})
          .mockResolvedValueOnce({id: 'l1', code: 'AAAA2222', expires_at: null})
          .mockResolvedValueOnce(null);
        await expect(svc.createMemberInvite(ORG, ADMIN, null,
          {contact_email: EMAIL, invited_role: 'manager'}))
          .resolves.toEqual({code: 'AAAA2222', expires_at: null});
      });
    });

    it('a scoped manager cannot attach a team outside their branch', async () => {
      mockDb.qOne.mockResolvedValueOnce(
        {org_id: ORG, access: 'org', channel_type: 'general', department: 'HR'});
      await expect(svc.createMemberInvite(ORG, ADMIN, 'Ops',
        {contact_email: EMAIL, team_channel_id: 'ch-hr'}))
        .rejects.toThrow('team_channel_outside_your_branch');
    });

    // Mint read order: (q) auto-revoke expired → (qOne 1) adopt-existing probe
    // → (qOne 2) cap count → (qOne 3) INSERT → (qOne 4) silent user match.
    it('open-invite cap refuses with a visible wall, not a silent pile', async () => {
      mockDb.qOne
        .mockResolvedValueOnce(null)       // no adoptable invite
        .mockResolvedValueOnce({n: '50'});
      await expect(svc.createMemberInvite(ORG, ADMIN, null, {contact_phone: PHONE}))
        .rejects.toThrow('invite_cap_reached');
    });

    it('THE MINT IS NOT AN EXISTENCE ORACLE: response is identical matched or unmatched', async () => {
      // Unmatched contact.
      mockDb.qOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({n: '0'})
        .mockResolvedValueOnce({id: 'l1', code: 'AAAA2222', expires_at: null})
        .mockResolvedValueOnce(null);
      const unmatched = await svc.createMemberInvite(ORG, ADMIN, null, {contact_phone: PHONE});
      expect(mockPush.enterpriseInviteReceived).not.toHaveBeenCalled();
      // Matched contact — an account exists for this phone.
      mockDb.qOne.mockReset();
      mockDb.qOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({n: '0'})
        .mockResolvedValueOnce({id: 'l2', code: 'AAAA2222', expires_at: null})
        .mockResolvedValueOnce({id: 'user-55'});
      const matched = await svc.createMemberInvite(ORG, ADMIN, null, {contact_phone: PHONE});
      // Same code seeded on purpose: the RESPONSES must be deep-equal, so the
      // only observable difference is the invitee's own notification.
      expect(matched).toEqual(unmatched);
      expect(mockPush.enterpriseInviteReceived).toHaveBeenCalledWith('user-55');
    });

    it('an IDENTICAL open invite is adopted — before the cap, no re-audit, no re-notify', async () => {
      // Adoption creates nothing, so it must not be refusable by the cap.
      mockDb.qOne.mockResolvedValueOnce(
        {code: 'OLDCODE2', expires_at: null, invited_role: 'employee', team_channel_id: null, invited_department: null});
      const res = await svc.createMemberInvite(ORG, ADMIN, null, {contact_phone: PHONE});
      expect(res).toEqual({code: 'OLDCODE2', expires_at: null});
      expect(mockAudit.log).not.toHaveBeenCalled();
      expect(mockPush.enterpriseInviteReceived).not.toHaveBeenCalled();
      // ONE qOne — the cap count never ran.
      expect(mockDb.qOne).toHaveBeenCalledTimes(1);
    });

    it('a CONFIG-DIFFERENT open invite is a 409, never a silently-wrong code', async () => {
      // Blind adoption handed back the OLD settings: re-minting an employee
      // invite over a live MANAGER one returned the manager credential while
      // the UI said "invite created" with the new role (critic finding).
      mockDb.qOne.mockResolvedValueOnce(
        {code: 'OLDCODE2', expires_at: null, invited_role: 'manager', team_channel_id: null, invited_department: null});
      await expect(svc.createMemberInvite(ORG, ADMIN, null, {contact_phone: PHONE}))
        .rejects.toThrow('invite_exists_for_contact');
    });

    it('a BRANCH-SCOPE change is a config difference too — never adopted across', async () => {
      // invited_department is the scope OrgManagerGuard enforces: adopting an
      // 'Ops'-scoped manager code for a 'Finance' re-mint grants the OLD branch
      // (edge review round 2 — the same class, one field over).
      //
      // AGENCY, stated explicitly since G6: `invited_department` IS the agency's
      // branch scope, so this case was always about that tenant. On a WORKSPACE a
      // teamless manager invite is now refused up front, which would shadow the
      // adoption rule this test exists to pin.
      mockDepartment.isWorkspaceTenant.mockResolvedValueOnce(false);
      mockDb.qOne.mockResolvedValueOnce(
        {code: 'OLDCODE2', expires_at: null, invited_role: 'manager', team_channel_id: null, invited_department: 'Ops'});
      await expect(svc.createMemberInvite(ORG, ADMIN, null,
        {contact_phone: PHONE, invited_role: 'manager', invited_department: 'Finance'}))
        .rejects.toThrow('invite_exists_for_contact');
    });

    it('a mint RACE (23505) re-runs the same adoption rules', async () => {
      mockDb.qOne
        .mockResolvedValueOnce(null)       // nothing to adopt yet
        .mockResolvedValueOnce({n: '1'})
        .mockRejectedValueOnce(Object.assign(new Error('dup'), {code: '23505'}))
        .mockResolvedValueOnce(
          {code: 'RACED123', expires_at: null, invited_role: 'employee', team_channel_id: null, invited_department: null});
      const res = await svc.createMemberInvite(ORG, ADMIN, null, {contact_phone: PHONE});
      expect(res).toEqual({code: 'RACED123', expires_at: null});
      expect(mockAudit.log).not.toHaveBeenCalled();
    });

    it('audit metadata carries contact_kind, NEVER the raw phone or email', async () => {
      mockDb.qOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({n: '0'})
        .mockResolvedValueOnce({id: 'l1', code: 'AAAA2222', expires_at: null})
        .mockResolvedValueOnce(null);
      await svc.createMemberInvite(ORG, ADMIN, null, {contact_phone: PHONE});
      const call = JSON.stringify(mockAudit.log.mock.calls[0]);
      expect(call).toContain('contact_kind');
      expect(call).not.toContain(PHONE);
    });
  });

  describe('accept — one safe message for every pre-claim failure class', () => {
    it('unknown / revoked / accepted / expired / phone-mismatch / demoted-minter are INDISTINGUISHABLE', async () => {
      const failures: Array<() => void> = [
        // Unknown code.
        () => { mockDb.qOne.mockResolvedValueOnce(null); },
        // Revoked.
        () => { mockDb.qOne.mockResolvedValueOnce(inviteRow({revoked_at: new Date()})); },
        // Already accepted.
        () => { mockDb.qOne.mockResolvedValueOnce(inviteRow({accepted_at: new Date()})); },
        // Expired.
        () => { mockDb.qOne.mockResolvedValueOnce(inviteRow({expires_at: new Date(Date.now() - 1000)})); },
        // Phone-bound, caller's verified number does not match.
        () => {
          mockDb.qOne
            .mockResolvedValueOnce(inviteRow({invited_phone: PHONE, invited_email: null}))
            .mockResolvedValueOnce({phone_e164: '+15551234567'});
        },
        // Minter was demoted — their outstanding invites die with their authority.
        () => {
          mockDb.qOne
            .mockResolvedValueOnce(inviteRow({created_by: 'mgr-2'}))
            .mockResolvedValueOnce(null);
        },
        // Self-accept: the org account itself holds the code.
        () => { mockDb.qOne.mockResolvedValueOnce(inviteRow({org_user_id: APPLICANT, created_by: APPLICANT})); },
        // Prior roster history, role-mismatched: a removed MANAGER. On an email
        // invite ANY code holder can attempt the accept, so a distinguishable
        // refusal here would leak the target's membership history.
        () => {
          mockDb.qOne
            .mockResolvedValueOnce(inviteRow())
            .mockResolvedValueOnce(null)   // not a workspace owner
            .mockResolvedValueOnce({member_role: 'manager', status: 'removed'});
        },
        // Prior roster history, suspended: reinstatement is a roster operation.
        () => {
          mockDb.qOne
            .mockResolvedValueOnce(inviteRow())
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({member_role: 'employee', status: 'suspended'});
        },
      ];
      const messages: string[] = [];
      for (const arm of failures) {
        mockDb.qOne.mockReset();
        arm();
        try {
          await svc.acceptInvite(APPLICANT, 'SOMECODE');
          throw new Error('should have thrown');
        } catch (e) {
          messages.push((e as Error).message);
        }
      }
      expect(messages).toHaveLength(9);
      // ONE message for all nine — a code holder cannot probe which failure
      // they hit, and a phone prober cannot confirm a number is bound.
      expect(new Set(messages).size).toBe(1);
      expect(messages[0]).toBe('invite_invalid_or_expired');
    });

    it('already active in THIS org is an honest exception — 409', async () => {
      // Phase B removed the owner probe, so the membership check is now the
      // SECOND pre-tx read (was third).
      mockDb.qOne
        .mockResolvedValueOnce(inviteRow())
        .mockResolvedValueOnce({member_role: 'employee', status: 'active'});
      await expect(svc.acceptInvite(APPLICANT, 'SOMECODE')).rejects.toThrow('already_a_member');
    });

    it('Phase B — a WORKSPACE OWNER accepts like anyone else (the owner refusal is gone)', async () => {
      // Founder-approved 2026-08-09. Previously pinned the 409
      // (workspace_owner_cannot_join) and went RED when the pre-check was
      // removed — flipped deliberately per the bug-regression contract. The
      // whole accept path must run ZERO org_workspaces probes: owner-ness is
      // simply not consulted anymore.
      mockDb.qOne
        .mockResolvedValueOnce(inviteRow())
        .mockResolvedValueOnce(null);           // no org_members row yet
      mockTx.qOne
        .mockResolvedValueOnce({id: 'link-1'})  // claim
        .mockResolvedValueOnce(null)            // no open pending request
        .mockResolvedValueOnce(null);           // no existing membership (grant)
      await expect(svc.acceptInvite(APPLICANT, 'SOMECODE')).resolves.toEqual({ok: true});
      const allReads = [...mockDb.qOne.mock.calls, ...mockTx.qOne.mock.calls]
        .map((c: unknown[]) => String(c[0])).join('\n');
      expect(allReads).not.toMatch(/org_workspaces/);
    });
  });

  describe('accept — the transaction', () => {
    function happyPreTx() {
      mockDb.qOne
        .mockResolvedValueOnce(inviteRow())   // the invite
        .mockResolvedValueOnce(null);          // no org_members row yet
    }

    it('claims the invite, records an approved request, and grants ON THE TX HANDLE', async () => {
      happyPreTx();
      mockTx.qOne
        .mockResolvedValueOnce({id: 'link-1'})  // claim
        .mockResolvedValueOnce(null)            // no open pending request
        .mockResolvedValueOnce(null);           // no existing membership (grant)
      const res = await svc.acceptInvite(APPLICANT, 'somecode');
      expect(res).toEqual({ok: true});
      const txWrites = mockTx.q.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
      expect(txWrites).toMatch(/INSERT INTO (public\.)?enterprise_join_requests/);
      expect(txWrites).toMatch(/'approved'/);
      const grantCall = mockTx.q.mock.calls.find(
        (c: unknown[]) => /INSERT INTO (public\.)?org_members\b/.test(String(c[0])));
      expect(grantCall?.[1]).toEqual([ORG, APPLICANT, 'employee', null, ORG]);
      // The invitee's wake reuses the join-approved kind; admins hear an arrival.
      // The applicant's wake stays ORG-LESS on purpose (vs2 edge A2):
      // ApprovalStatus is their own cross-org screen and scoping it to one org
      // would hide the other org's invites.
      expect(mockPush.enterpriseJoinDecided).toHaveBeenCalledWith(APPLICANT, 'approved');
      // The ADMIN-side wake does name the org, so the tap opens THIS workspace.
      expect(mockPush.enterpriseInviteAccepted).toHaveBeenCalledWith(ORG, ORG);
    });

    /**
     * P2-d — THE INVITE LANE, which had no service-level coverage at all until
     * these cases existed. Every other test in this block leaves
     * `team_channel_id` null, which takes the org-wide early return, so the
     * scoped path was exercised only through a pure function that its real
     * caller bypassed. That is precisely how the caller-side breadcrumb bug
     * shipped: fixed in `seed-path.ts`, and the identical early return left
     * standing in `resolveSeedScopeInTx` one layer out.
     */
    describe('P2-d — path-scoped seeding through the real caller', () => {
      const TREE = [
        seedRow('root', null), seedRow('rsa', 'root'), seedRow('fort', 'rsa'),
        seedRow('kenya', 'root'),
      ];

      it('seeds the chain and subtree, and NOT the sibling branch', async () => {
        mockDb.qOne
          .mockResolvedValueOnce(inviteRow({team_channel_id: 'rsa'}))
          .mockResolvedValueOnce(null);
        mockTx.q.mockResolvedValueOnce(TREE);          // the in-tx scope read
        mockTx.qOne
          .mockResolvedValueOnce({id: 'link-1'}).mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null);
        mockDb.q.mockResolvedValueOnce(TREE.map(c => ({...c, post_mode: 'open'})));

        await svc.acceptInvite(APPLICANT, 'somecode');
        const seeded = mockDepartment.addMember.mock.calls.map((c: unknown[]) => c[1]).sort();
        expect(seeded).toEqual(['fort', 'root', 'rsa']);
        expect(seeded).not.toContain('kenya');
      });

      it('a DELETED team still scopes, via the mint-time breadcrumb', async () => {
        // team_channel_id is ON DELETE SET NULL, so this is what a deleted team
        // actually looks like on the wire. RED before the caller-side fix:
        // it took the org-wide early return and seeded Kenya too.
        mockDb.qOne
          .mockResolvedValueOnce(inviteRow({team_channel_id: null, team_parent_id: 'rsa'}))
          .mockResolvedValueOnce(null);
        mockTx.q.mockResolvedValueOnce(TREE);
        mockTx.qOne
          .mockResolvedValueOnce({id: 'link-1'}).mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null);
        mockDb.q.mockResolvedValueOnce(TREE.map(c => ({...c, post_mode: 'open'})));

        await svc.acceptInvite(APPLICANT, 'somecode');
        const seeded = mockDepartment.addMember.mock.calls.map((c: unknown[]) => c[1]).sort();
        expect(seeded).toEqual(['root', 'rsa']);
        expect(seeded).not.toContain('kenya');
      });

      it('the in-tx scope read SELECTS archived rows — they are walk scaffolding', async () => {
        // Not a style point. Filtering `archived_at IS NULL` here makes an
        // archived ancestor UNTRAVERSABLE rather than merely unseedable: the
        // climb hits undefined, stops, and reports a dead chain while a live
        // grandparent sits directly above it. Two ordinary admin taps (archive
        // a leaf, then its now-childless parent) reach that, and the accept is
        // refused instead of falling back. The pure function's own tests cannot
        // see this — it is the CALLER's query.
        mockDb.qOne
          .mockResolvedValueOnce(inviteRow({team_channel_id: 'rsa'}))
          .mockResolvedValueOnce(null);
        mockTx.q.mockResolvedValueOnce(TREE);
        mockTx.qOne
          .mockResolvedValueOnce({id: 'link-1'}).mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null);
        mockDb.q.mockResolvedValueOnce(TREE.map(c => ({...c, post_mode: 'open'})));
        await svc.acceptInvite(APPLICANT, 'somecode');

        const scopeRead = mockTx.q.mock.calls
          .map((c: unknown[]) => String(c[0]))
          .find(q => /FROM public\.department_channels/.test(q)) ?? '';
        expect(scopeRead).toMatch(/\(archived_at IS NOT NULL\) AS archived/);
        expect(scopeRead).not.toMatch(/archived_at IS NULL/);
      });

      it('a dead chain refuses BEFORE the claim, so the invite survives', async () => {
        mockDb.qOne
          .mockResolvedValueOnce(inviteRow({team_channel_id: 'solo'}))
          .mockResolvedValueOnce(null);
        mockTx.q.mockResolvedValueOnce([seedRow('solo', null, {access: 'restricted'})]);

        await expect(svc.acceptInvite(APPLICANT, 'somecode'))
          .rejects.toThrow('team_channel_unavailable_reinvite');
        // THE POINT: the claim never ran, so the code is still usable after the
        // admin fixes the channel. A post-claim refusal would consume it.
        const claims = mockTx.qOne.mock.calls
          .map((c: unknown[]) => String(c[0])).filter(q => /SET accepted_by/.test(q));
        expect(claims).toEqual([]);
        expect(mockDepartment.addMember).not.toHaveBeenCalled();
      });
    });

    it('a raced-away claim gets the SAME safe message', async () => {
      happyPreTx();
      mockTx.qOne.mockResolvedValueOnce(null);   // someone claimed it first
      await expect(svc.acceptInvite(APPLICANT, 'somecode'))
        .rejects.toThrow('invite_invalid_or_expired');
      expect(mockPush.enterpriseJoinDecided).not.toHaveBeenCalled();
    });

    it('active-elsewhere (23505) rolls the whole tx back — nothing post-commit fires', async () => {
      happyPreTx();
      mockTx.qOne
        .mockResolvedValueOnce({id: 'link-1'})
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      mockTx.q
        .mockResolvedValueOnce([])   // the approved-request INSERT
        .mockRejectedValueOnce(Object.assign(new Error('dup'), {code: '23505'}));
      await expect(svc.acceptInvite(APPLICANT, 'somecode'))
        .rejects.toThrow('already_active_in_another_org');
      expect(mockDepartment.addMember).not.toHaveBeenCalled();
      expect(mockAudit.log).not.toHaveBeenCalled();
      expect(mockPush.enterpriseJoinDecided).not.toHaveBeenCalled();
    });

    it('a seed failure NEVER fails an acceptance that already committed', async () => {
      happyPreTx();
      mockTx.qOne
        .mockResolvedValueOnce({id: 'link-1'})
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      mockDb.q.mockRejectedValueOnce(new Error('seed exploded'));   // channel query
      await expect(svc.acceptInvite(APPLICANT, 'somecode')).resolves.toEqual({ok: true});
    });

    it('a MANAGER invite grants the role+branch from the INVITE and seeds like a manager', async () => {
      mockDb.qOne
        .mockResolvedValueOnce(inviteRow({invited_role: 'manager', invited_department: 'Ops'}))
        .mockResolvedValueOnce(null);
      mockTx.qOne
        .mockResolvedValueOnce({id: 'link-1'})
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      // One managers-only channel, one ordinary managed channel.
      mockDb.q.mockResolvedValueOnce([
        {id: 'c-restricted', access: 'restricted', channel_type: 'general', post_mode: 'managed'},
        {id: 'c-open', access: 'org', channel_type: 'general', post_mode: 'managed'},
      ]);
      await svc.acceptInvite(APPLICANT, 'somecode');
      const grantCall = mockTx.q.mock.calls.find(
        (c: unknown[]) => /INSERT INTO (public\.)?org_members\b/.test(String(c[0])));
      expect(grantCall?.[1]).toEqual([ORG, APPLICANT, 'manager', 'Ops', ORG]);
      // Managers-only channels are NOT skipped, and the role is admin/'Manager'
      // — mirroring seedChannelMembers' isManager branch.
      expect(mockDepartment.addMember).toHaveBeenCalledWith(
        ORG, 'c-restricted', APPLICANT, 'admin', 'Manager', ORG);
      expect(mockDepartment.addMember).toHaveBeenCalledWith(
        ORG, 'c-open', APPLICANT, 'admin', 'Manager', ORG);
      // The arrival fan-out is BRANCH-SCOPED like every other fan-out here
      // ("notified = can see it"): a teamless manager invite scopes to the
      // manager's own branch.
      const mgrQuery = mockDb.q.mock.calls.find(
        (c: unknown[]) => /member_role = 'manager'/.test(String(c[0])));
      expect(mgrQuery?.[1]).toEqual([ORG, 'Ops']);
    });

    it('an EMPLOYEE acceptance still skips managers-only channels', async () => {
      happyPreTx();
      mockTx.qOne
        .mockResolvedValueOnce({id: 'link-1'})
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      mockDb.q.mockResolvedValueOnce([
        {id: 'c-restricted', access: 'restricted', channel_type: 'general', post_mode: 'managed'},
        {id: 'c-open', access: 'org', channel_type: 'general', post_mode: 'managed'},
      ]);
      await svc.acceptInvite(APPLICANT, 'somecode');
      expect(mockDepartment.addMember).toHaveBeenCalledTimes(1);
      expect(mockDepartment.addMember).toHaveBeenCalledWith(
        ORG, 'c-open', APPLICANT, 'viewer', undefined, ORG);
    });
  });

  describe('revoke', () => {
    it('an already-accepted invite is a 409, never a silent success', async () => {
      mockDb.qOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({accepted_at: new Date()});
      await expect(svc.revokeMemberInvite(ORG, ADMIN, 'somecode'))
        .rejects.toThrow('invite_already_accepted');
    });

    it('unknown code is a plain 404', async () => {
      mockDb.qOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      await expect(svc.revokeMemberInvite(ORG, ADMIN, 'somecode'))
        .rejects.toThrow('invite_not_found');
    });
  });

  describe('myInvites', () => {
    it('a caller with no phone AND no email matches nothing without touching the table', async () => {
      mockDb.qOne.mockResolvedValueOnce({phone_e164: null, email: null});
      await expect(svc.myInvites(APPLICANT)).resolves.toEqual([]);
      expect(mockDb.q).not.toHaveBeenCalled();
    });

    it('SECURITY: the code travels only on a PHONE match, and never to an existing member', () => {
      // The account email is UNVERIFIED — returning the code on an email
      // string-match handed the acceptance credential to whoever registered
      // that address first (register hr@corp.com → GET /invites/me → a manager
      // code). Phone matches are OTP-verified, so only they carry it. And an
      // already-active member's invite is excluded outright: their accept can
      // only 409, so surfacing it is a permanent zombie CTA.
      const src = source('enterprise-join.service.ts');
      const region = src.slice(src.indexOf('async myInvites('), src.indexOf('async acceptInvite('));
      expect(region.length).toBeGreaterThan(0);
      expect(region).toMatch(/CASE WHEN l\.invited_phone IS NOT NULL THEN l\.code END AS code/);
      expect(region).not.toMatch(/SELECT l\.code/);
      // The exclusion mirrors the accept pre-check EXACTLY: every cohort whose
      // accept can only fail (active, suspended, non-employee history, manager
      // invite over an existing row) is excluded — a surfaced-but-unacceptable
      // invite is a permanent phantom CTA (edge review round 2).
      expect(region).toMatch(/NOT EXISTS/);
      expect(region).toMatch(/m\.status IN \('active', 'suspended'\)/);
      expect(region).toMatch(/m\.member_role <> 'employee'/);
      expect(region).toMatch(/l\.invited_role <> 'employee'/);
    });
  });

  describe('B-413/Phase B — honest invites, no phantom CTA, owners accept', () => {
    // Phase B (founder-approved 2026-08-09) removed the workspace-owner
    // refusal, so the owner rows that were pinned acceptable:false here went
    // RED and were flipped deliberately (bug-regression contract). The one
    // refusal the accept still hits — active membership in a DIFFERENT org,
    // the one-active-org unique index — stays surfaced with its reason.
    it("Phase B — an owner's invite is acceptable:true and NO org_workspaces probe runs", async () => {
      mockDb.qOne
        .mockResolvedValueOnce({phone_e164: '+8801711000000', email: null})
        .mockResolvedValueOnce(null);      // no active membership anywhere
      mockDb.q.mockResolvedValueOnce([
        {code: 'ABCD1234', org_name: 'Corp', team_name: null, invited_role: 'employee', expires_at: null},
      ]);
      const rows = await svc.myInvites(APPLICANT);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({code: 'ABCD1234', acceptable: true});
      expect(rows[0].blocked_reason).toBeUndefined();
      for (const call of mockDb.qOne.mock.calls) {
        expect(String(call[0])).not.toMatch(/org_workspaces/);
      }
    });

    // Edge-case review #7 — `acceptable` must mirror EVERY refusal the accept
    // runs: a member active in a different org dies on the one-active-org
    // unique index (already_active_in_another_org), so their rows must not
    // arm a CTA.
    it('a member active in ANOTHER org can now accept — vs2 item 4 FLIPPED this', async () => {
      /**
       * B-413 asserted `acceptable: false` here, and that was right at the
       * time: one blanket unique index meant the accept could only 409.
       *
       * Item 4 narrowed that index to `member_role = 'cpo'`, and
       * `grantMembership` only ever writes 'employee' | 'manager' — so the
       * accept can no longer 409 for this caller. The probe that fed this field
       * has been deleted rather than narrowed, because narrowing it kept
       * exactly the wrong half: the hub greyed the CTA and ApprovalStatusScreen
       * dropped the row entirely for the consultant persona, while the accept
       * behind both surfaces would have succeeded.
       *
       * Note the mock no longer supplies a second qOne — there is no second
       * query. If someone reinstates the probe, this goes red on the shape.
       */
      mockDb.qOne.mockResolvedValueOnce({phone_e164: '+8801711000000', email: null});
      mockDb.q.mockResolvedValueOnce([
        {code: 'ABCD1234', org_name: 'Corp', team_name: null, invited_role: 'employee', expires_at: null},
      ]);
      const rows = await svc.myInvites(APPLICANT);
      expect(rows[0]).toMatchObject({acceptable: true});
      expect(rows[0]).not.toHaveProperty('blocked_reason');
      /**
       * ⚠️ THE ASSERTION THAT ACTUALLY BITES. The two above do not: `mockReset()`
       * leaves qOne returning `undefined`, so the deleted probe would have read
       * falsy and produced `acceptable: true` as well — the test passed on both
       * versions. Assert the QUERY is gone instead of guessing at its result.
       */
      const probes = mockDb.qOne.mock.calls.filter(c => /FROM public\.org_members/.test(String(c[0])));
      expect(probes).toHaveLength(0);
    });

    it('resolveReferralLink no longer blocks an INVITE row for a caller active elsewhere', async () => {
      /**
       * The same flip, and this was the worse half of it: a hard
       * `{valid: false}` in the code-entry lane, not merely a greyed CTA. A
       * serving officer typing a workspace code was refused outright for a
       * combination the migration's own closing note calls "the consultant case
       * this item exists for".
       */
      mockDb.qOne.mockResolvedValueOnce({org_name: 'Corp', team_name: null, team_access: null,
        team_type: null, is_invite: true, invited_role: 'employee', org_user_id: 'org-b'});
      await expect(svc.resolveReferralLink('CODE12', APPLICANT))
        .resolves.toMatchObject({valid: true});
      // Same reasoning as above — the result alone cannot tell the versions
      // apart, the absence of the probe can.
      const probes = mockDb.qOne.mock.calls.filter(c => /FROM public\.org_members/.test(String(c[0])));
      expect(probes).toHaveLength(0);
    });

    it('resolveReferralLink does NOT block a REFERRAL (non-invite) row for that caller — cross-org PENDING is legitimate', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({org_name: 'Corp', team_name: null, team_access: null,
          team_type: null, is_invite: false, invited_role: 'employee', org_user_id: 'org-b'});
      const r = await svc.resolveReferralLink('CODE12', APPLICANT);
      expect(r.valid).toBe(true);
      // Exactly one qOne call: the row. Referral rows skip the elsewhere
      // probe entirely (and Phase B removed the owner probe).
      expect(mockDb.qOne).toHaveBeenCalledTimes(1);
    });

    it('Phase B — a workspace OWNER resolves an invite link as valid:true', async () => {
      // Previously pinned {valid:false, reason:'workspace_owner_cannot_join'};
      // flipped deliberately when Phase B removed the refusal.
      mockDb.qOne
        .mockResolvedValueOnce({org_name: 'Corp', team_name: null, team_access: null,
          team_type: null, is_invite: true, invited_role: 'employee', org_user_id: 'org-b'})
        .mockResolvedValueOnce(null);      // no active membership elsewhere
      await expect(svc.resolveReferralLink('CODE12', APPLICANT))
        .resolves.toMatchObject({valid: true, code: 'CODE12'});
      // The row query itself joins org_workspaces for the ORG NAME — assert
      // the CALLER-ownership probe shape specifically.
      for (const call of mockDb.qOne.mock.calls) {
        expect(String(call[0])).not.toMatch(/org_workspaces WHERE owner_user_id/);
      }
    });

    it('a non-member caller still resolves valid:true', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({org_name: 'Corp', team_name: 'Ops', team_access: null,
          team_type: null, is_invite: false, invited_role: 'employee'})
        .mockResolvedValueOnce(null);
      await expect(svc.resolveReferralLink('code12', 'user-2')).resolves.toEqual(
        {valid: true, code: 'CODE12', org_name: 'Corp', team_name: 'Ops'});
    });

    it('an ANONYMOUS resolve (no caller) never runs any caller-state probe', async () => {
      mockDb.qOne.mockResolvedValueOnce({org_name: 'Corp', team_name: null, team_access: null,
        team_type: null, is_invite: false, invited_role: 'employee'});
      const res = await svc.resolveReferralLink('CODE12');
      expect(res).toMatchObject({valid: true});
      expect(mockDb.qOne).toHaveBeenCalledTimes(1);
    });
  });

  describe('structural pins', () => {
    it('the claim is a CONDITIONAL UPDATE — read-then-write cannot be raced', () => {
      const src = source('enterprise-join.service.ts');
      const start = src.indexOf('async acceptInvite(');
      expect(start).toBeGreaterThan(-1);
      const region = src.slice(start, src.indexOf('\n  private async seedApprovedMemberChannels(', start));
      const claim = region.slice(region.indexOf('SET accepted_by'));
      expect(claim).toMatch(/accepted_at IS NULL/);
      expect(claim).toMatch(/revoked_at IS NULL/);
      expect(claim).toMatch(/expires_at IS NULL OR expires_at > NOW\(\)/);
      expect(claim).toMatch(/RETURNING/);
    });

    it('an invite row can NEVER be submitted as a join request (binding bypass)', () => {
      const src = source('enterprise-join.service.ts');
      // Bounded at revokeReferralLink, NOT myJoinRequest: the wider slice also
      // contained listReferralLinks, whose identical exclusion token kept this
      // green with the submit-side one deleted — the exact "assert the site"
      // trap (critic finding, 2026-08-08).
      const start = src.indexOf('async submitJoinRequest(');
      const end = src.indexOf('async revokeReferralLink(', start);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      expect(src.slice(start, end)).toMatch(/invited_phone IS NULL AND l\.invited_email IS NULL/);
    });

    it('legacy referral list excludes invite rows (they have their own list)', () => {
      const src = source('enterprise-join.service.ts');
      const start = src.indexOf('async listReferralLinks(');
      const end = src.indexOf('async myJoinRequest(', start);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      expect(src.slice(start, end)).toMatch(/invited_phone IS NULL AND l\.invited_email IS NULL/);
    });

    it('B-392: myJoinRequest names the WORKSPACE, not the founder', () => {
      // resolveReferralLink already preferred COALESCE(w.name, u.display_name);
      // myJoinRequest still served the owner's personal display_name for the
      // SAME application, so the join screen and the status screen named
      // different things — and the status screen leaked the owner's personal
      // identity where the company name exists.
      const src = source('enterprise-join.service.ts');
      const region = src.slice(src.indexOf('async myJoinRequest('), src.indexOf('async listPendingRequests('));
      expect(region).toMatch(/COALESCE\(w\.name, u\.display_name\) AS org_name/);
      expect(region).toMatch(/org_workspaces w ON w\.owner_user_id = r\.org_user_id/);
    });

    it('the invite migration pins the binding and single-use shape', () => {
      const mig = readFileSync(
        join(process.cwd(), '..', '..', 'supabase', 'migrations', '20260808010000_enterprise_member_invites.sql'),
        'utf8').replace(/\r\n/g, '\n').split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
      // E.164-only at rest; one contact; department only on manager invites.
      expect(mig).toMatch(/CHECK \(invited_phone IS NULL OR invited_phone ~ '\^\\\+\[0-9\]\{7,15\}\$'\)/);
      expect(mig).toMatch(/CHECK \(NOT \(invited_phone IS NOT NULL AND invited_email IS NOT NULL\)\)/);
      expect(mig).toMatch(/CHECK \(invited_department IS NULL OR invited_role = 'manager'\)/);
      // One open invite per contact per org, phone and email variants.
      expect(mig).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS enterprise_invites_one_open_phone/);
      expect(mig).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS enterprise_invites_one_open_email/);
    });
  });
});
