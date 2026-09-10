import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {Test, TestingModule} from '@nestjs/testing';
import {ForbiddenException, NotFoundException} from '@nestjs/common';
import {IncidentService} from './incident.service';
import {DatabaseService} from '../database/database.service';
import {OrgAuditService} from '../org/org-audit.service';
import {BookingPushBridge} from '../ops/booking-push-bridge.service';

const tx = {q: jest.fn(), qOne: jest.fn()};
const mockDb = {
  q: jest.fn(),
  qOne: jest.fn(),
  withTransaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
};
const mockAudit = {log: jest.fn()};
const mockPush = {incidentSubmitted: jest.fn(), incidentStatusChanged: jest.fn()};
// A delegated manager (user ≠ org) vs the company admin (user === org).
const MANAGER = {user_id: 'mgr-1', org_user_id: 'org-9', department: null};
const COMPANY = {user_id: 'org-9', org_user_id: 'org-9', department: null};

describe('IncidentService', () => {
  let svc: IncidentService;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockDb.q.mockResolvedValue([]);
    mockDb.withTransaction.mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx));
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IncidentService,
        {provide: DatabaseService, useValue: mockDb},
        {provide: OrgAuditService, useValue: mockAudit},
        {provide: BookingPushBridge, useValue: mockPush},
      ],
    }).compile();
    svc = module.get(IncidentService);
  });

  /**
   * vs2 item 16 — a SOURCE scan, because nothing in this suite executes SQL.
   *
   * The first version of the naming query selected `users.full_name`. That
   * column does not exist (it is `display_name`), so Postgres raised 42703 on
   * every single submit, a bare catch swallowed it, and the banner silently
   * fell back to generic copy — i.e. the headline requirement of item 16 was
   * dead on device while every test above stayed green. Mocked DBs cannot see
   * a wrong column name; a scan can.
   */
  describe('the notification naming query names columns that exist', () => {
    // Comments FIRST — this file's own comment explains the bug and therefore
    // contains the banned word. Line-anchored, per sourceScanSafety's rule.
    const SRC = readFileSync(join(__dirname, 'incident.service.ts'), 'utf8')
      .replace(/\r\n/g, '\n')
      .replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*$/gm, '')
      .split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');

    it('uses display_name, never full_name', () => {
      expect(SRC).not.toMatch(/\bfull_name\b/);
      expect(SRC).toMatch(/AS reporter_name/);
      expect(SRC).toMatch(/s\.display_name\s+AS reporter_name/);
    });

    it('uses the canonical COALESCE(workspace name, owner display name) org label', () => {
      // A workspace named "SASFA" owned by a personal account must title the
      // banner SASFA, not the owner's own name.
      expect(SRC).toMatch(/COALESCE\(w\.name,\s*o\.display_name\)\s+AS org_name/);
      expect(SRC).toMatch(/LEFT JOIN public\.org_workspaces w/);
    });

    it('does not swallow a failure silently', () => {
      // The silent catch is what let the wrong column ship.
      expect(SRC).toMatch(/names lookup failed/);
    });
  });

  describe('submit', () => {
    it('resolves the org, stamps a ref from the sequence, and writes the submitted event', async () => {
      mockDb.q.mockResolvedValueOnce([{org_user_id: 'org-9'}]); // resolveOrg (q: ALL memberships)
      tx.qOne.mockResolvedValueOnce({id: 'inc1', ref: 'INC-2026-00001', status: 'submitted', severity: 'high'});
      tx.q.mockResolvedValueOnce([]); // event insert

      const out = await svc.submit('user-1', {category: 'security_concern', severity: 'high', description: 'gate breach'});
      expect(out).toEqual({id: 'inc1', ref: 'INC-2026-00001', status: 'submitted', severity: 'high'});

      const [reportSql, reportParams] = tx.qOne.mock.calls[0];
      expect(String(reportSql)).toMatch(/incident_ref_seq/);          // ref stamped from the sequence
      expect(String(reportSql)).toMatch(/INSERT INTO incident_reports/i);
      expect(reportParams[0]).toBe('org-9');                          // org resolved
      expect(reportParams[1]).toBe('user-1');                         // submitter

      const evt = tx.q.mock.calls.find(c => /incident_events/i.test(String(c[0])));
      expect(evt).toBeDefined();
      expect(String(evt![0])).toMatch(/'submitted'/);                 // initial transition
      // Manager(s) alerted metadata-only (the org account + active managers).
      // vs2 item 16 — the 4th arg carries the deep-link id plus the two names
      // the banner needs. Asserted explicitly: a regression that drops
      // incidentId turns the notification back into a dead-ends-on-a-list tap.
      // vs2 edge A1 — and WHICH org, or a manager of two organisations reads
      // the incident with the other one stamped on the request and lands on an
      // empty screen. Pinned to the RESOLVED org (not the submitter, not the
      // name lookup's row), because that is what the client re-scopes to.
      expect(mockPush.incidentSubmitted).toHaveBeenCalledWith(
        ['org-9'], 'INC-2026-00001', 'high',
        expect.objectContaining({incidentId: expect.any(String), orgId: 'org-9'}),
      );
    });

    it('still carries the org when the cosmetic NAME lookup fails (edge A1)', async () => {
      // The names query is best-effort and swallows its own errors. Deriving
      // orgId from its result would make the deep link work only when a label
      // resolved — the same silent failure the 42703 column bug already caused
      // once on this exact query.
      mockDb.q.mockResolvedValueOnce([{org_user_id: 'org-9'}]);
      tx.qOne.mockResolvedValueOnce({id: 'inc2', ref: 'INC-2026-00002', status: 'submitted', severity: 'low'});
      tx.q.mockResolvedValueOnce([]);
      mockDb.qOne.mockRejectedValueOnce(new Error('42703 column does not exist'));

      await svc.submit('user-1', {category: 'security_concern', severity: 'low', description: 'x'});

      expect(mockPush.incidentSubmitted).toHaveBeenCalledWith(
        ['org-9'], 'INC-2026-00002', 'low',
        expect.objectContaining({orgId: 'org-9', orgName: null, reporterName: null}),
      );
    });

    it('resolves the org by PREFERRING a cpo membership, never requiring one', async () => {
      /**
       * vs2 item 4 CRITICAL. This resolver was briefly narrowed to
       * `AND member_role = 'cpo'` on the reasoning that it decides employment.
       * A workspace EMPLOYEE has no cpo row, so it matched nothing, the caller
       * fell through to the self-id default, and the record was written with
       * org_user_id = the employee's own user id. Every manager read is scoped
       * `WHERE org_user_id = <the org>`, so the row was not lost — it was
       * invisible, permanently, to the only people who look at it. Employees
       * are exactly who this surface is for.
       *
       * Asserted on the SQL because the db is mocked to answer regardless of
       * the query, so no behavioural assertion here can see a WHERE clause.
       */
      mockDb.q.mockResolvedValueOnce([{org_user_id: 'org-9'}]);
      tx.qOne.mockResolvedValueOnce({id: 'x', ref: 'r', status: 'submitted', severity: 'low'});
      tx.q.mockResolvedValueOnce([]);
      await svc.submit('user-1', {category: 'other', severity: 'low', description: 'd'});

      // Comments stripped LINE-WISE, not with a greedy pattern: the prose above
      // this query names the very clause the assertions below forbid, and the
      // house stripper has eaten real code in this repo (sourceScanSafety).
      // Found by CONTENT, not by index: resolveOrg moved from qOne to q when
      // it learned to read the org context, and a positional lookup silently
      // started asserting against a different query.
      const call = mockDb.q.mock.calls.find(c => /FROM org_members/.test(String(c[0])));
      expect(call).toBeDefined();
      const sql = String(call![0])
        .split(/\r?\n/)
        .filter(l => !l.trim().startsWith('--'))
        .join('\n');
      expect(sql).toMatch(/FROM org_members/);
      // Must NOT require the role...
      expect(sql).not.toMatch(/member_role\s*=\s*'cpo'\s*$/m);
      expect(sql).not.toMatch(/AND\s+member_role\s*=\s*'cpo'/);
      // ...but must still PREFER it, so a cpo who is also an office employee
      // resolves to the agency that employs them as an officer.
      expect(sql).toMatch(/ORDER BY\s*\(member_role = 'cpo'\)\s*DESC/);
    });

    it('files against the org the submitter is VIEWING, not their cpo employer', async () => {
      /**
       * vs2 item 4. Chidi is an officer at agency Meridian and an employee of
       * workspace Acme — the consultant the migration exists to allow. He is
       * standing in Acme's workspace when he files.
       *
       * The ordering below prefers his cpo row, so without the header this
       * lands on MERIDIAN: Acme's manager reads WHERE org_user_id = acme and
       * never sees the report, while Meridian's managers get the evidence key
       * for another company's incident. The client was already sending the
       * right org and the server was discarding it.
       */
      mockDb.q.mockResolvedValueOnce([
        {org_user_id: 'meridian'},   // cpo row — first by the ordering
        {org_user_id: 'acme'},       // workspace employee row
      ]);
      tx.qOne.mockResolvedValueOnce({id: 'i', ref: 'r', status: 'submitted', severity: 'low'});
      tx.q.mockResolvedValueOnce([]);
      await svc.submit('chidi', {category: 'other', severity: 'low', description: 'd'}, 'acme');
      expect(tx.qOne.mock.calls[0][1][0]).toBe('acme');
    });

    it('...and a header naming an org he does NOT hold cannot redirect it', async () => {
      // NARROWS, never grants: an unheld org falls back to the ordering, so the
      // record still lands somewhere real and somewhere his.
      mockDb.q.mockResolvedValueOnce([{org_user_id: 'meridian'}]);
      tx.qOne.mockResolvedValueOnce({id: 'i', ref: 'r', status: 'submitted', severity: 'low'});
      tx.q.mockResolvedValueOnce([]);
      await svc.submit('chidi', {category: 'other', severity: 'low', description: 'd'}, 'someone-elses-org');
      expect(tx.qOne.mock.calls[0][1][0]).toBe('meridian');
    });

    it('falls back to self-as-org when the submitter has no org membership', async () => {
      mockDb.q.mockResolvedValueOnce([]); // resolveOrg → no memberships
      tx.qOne.mockResolvedValueOnce({id: 'inc2', ref: 'INC-2026-00002', status: 'submitted', severity: 'low'});
      tx.q.mockResolvedValueOnce([]);
      await svc.submit('solo-1', {category: 'other', severity: 'low', description: 'note'});
      expect(tx.qOne.mock.calls[0][1][0]).toBe('solo-1'); // org_user_id = self
    });

    it('writes an org_audit_log row on submission (like every other lifecycle action)', async () => {
      mockDb.q.mockResolvedValueOnce([{org_user_id: 'org-9'}]);
      tx.qOne.mockResolvedValueOnce({id: 'inc1', ref: 'INC-2026-00001', status: 'submitted', severity: 'high'});
      tx.q.mockResolvedValueOnce([]);
      await svc.submit('user-1', {category: 'security_concern', severity: 'high', description: 'gate breach'});
      expect(mockAudit.log).toHaveBeenCalledWith(
        'org-9', 'user-1', 'incident.submit',
        expect.objectContaining({
          targetId: 'inc1',
          metadata: expect.objectContaining({category: 'security_concern', severity: 'high'}),
        }),
      );
      // The narrative must never land in the audit metadata.
      const call = mockAudit.log.mock.calls.find(c => c[2] === 'incident.submit');
      expect(JSON.stringify(call![3])).not.toMatch(/gate breach/);
    });

    it('routes the alert to the department\'s managers (dept-scoped or org-wide, never another dept)', async () => {
      mockDb.q.mockResolvedValueOnce([{org_user_id: 'org-9'}]);
      tx.qOne.mockResolvedValueOnce({id: 'inc1', ref: 'INC-2026-00001', status: 'submitted', severity: 'high'});
      tx.q.mockResolvedValueOnce([]);
      mockDb.q.mockResolvedValueOnce([{member_user_id: 'mgr-ops'}]); // resolveOrgManagers
      await svc.submit('user-1', {
        category: 'safety_issue', severity: 'high', description: 'x', department: 'Operations',
      });
      // resolveOrg ALSO queries org_members now, so match the manager-fan-out
      // query specifically rather than the first org_members query.
      const mgrQuery = mockDb.q.mock.calls.find(c => /department IS NULL OR department/i.test(String(c[0])));
      expect(mgrQuery).toBeDefined();
      expect(String(mgrQuery![0])).toMatch(/department IS NULL OR department = \$2/);
      expect(mgrQuery![1]).toContain('Operations');
    });
  });

  describe('mine names the organisation (vs2 item 4)', () => {
    it('selects org_name with the company-first COALESCE', async () => {
      // Twin of the attendance assertion — same decision, same reason, and the
      // same hazard if the COALESCE is inverted: every employee would be shown
      // their founder's personal name in place of the company's.
      // No org context → the unscoped all-own branch (a single query, no resolveOrg).
      mockDb.q.mockResolvedValueOnce([]);
      await svc.mine('user-1');
      const sql = String(mockDb.q.mock.calls[0][0])
        .split(/\r?\n/).filter(l => !l.trim().startsWith('--')).join('\n');
      expect(sql).toMatch(/AS org_name/);
      expect(sql).toMatch(/COALESCE\([a-z_]+\.name,\s*[a-z_]+\.display_name\)/);
    });
  });

  describe('mine', () => {
    // DOCUMENTS B-610 — "my reports" must be scoped to the org being viewed, not
    // just the submitter. Before the fix a member of several orgs saw every org's
    // reports mixed in one list. resolveOrg (org_members read) computes the SAME
    // org key submit() stamps, so the list and the write agree.
    it('scopes to the submitter AND the viewing org, newest first (B-610)', async () => {
      mockDb.q
        .mockResolvedValueOnce([{org_user_id: 'org-A'}]) // resolveOrg → org_members
        .mockResolvedValueOnce([{id: 'inc1'}]);          // the scoped list
      await svc.mine('user-1', 'org-A');

      // resolveOrg ran against the submitter's memberships (proves the org is
      // derived server-side, never trusted from the client).
      expect(String(mockDb.q.mock.calls[0][0])).toMatch(/FROM org_members/);
      expect(mockDb.q.mock.calls[0][1][0]).toBe('user-1');

      // the list query filters by BOTH submitter and org.
      const [sql, params] = mockDb.q.mock.calls[1];
      const clean = String(sql).split(/\r?\n/).filter(l => !l.trim().startsWith('--')).join('\n');
      expect(clean).toMatch(/submitter_id = \$1 AND ir\.org_user_id = \$2/);
      expect(clean).toMatch(/ORDER BY ir\.created_at DESC/i);
      expect(params[0]).toBe('user-1');
      expect(params[1]).toBe('org-A');
    });

    // B-610 absent-header follow-up — with NO org context (cold start, no
    // workspace selected) show ALL the member's own reports, never an empty list
    // under an arbitrary default. Still submitter-scoped (own reports only), so
    // not a cross-user leak. No resolveOrg round-trip on this path.
    it('shows ALL the submitter’s own reports when no org is named (no empty list)', async () => {
      mockDb.q.mockResolvedValueOnce([{id: 'inc1'}]); // one query, no resolveOrg
      await svc.mine('user-1'); // no header
      expect(mockDb.q).toHaveBeenCalledTimes(1);
      const [sql, params] = mockDb.q.mock.calls[0];
      const clean = String(sql).split(/\r?\n/).filter(l => !l.trim().startsWith('--')).join('\n');
      expect(clean).toMatch(/WHERE ir\.submitter_id = \$1\s+ORDER BY/); // no org filter
      expect(clean).not.toMatch(/org_user_id = \$2/);
      expect(params[0]).toBe('user-1');
    });
  });

  // ─── Manager queue + lifecycle (Step 9) ───────────────────────────────
  describe('queue', () => {
    it('sorts Critical/High first via a severity CASE rank', async () => {
      mockDb.q.mockResolvedValueOnce([{id: 'a'}]);
      await svc.queue('org-9', {severity: 'high'});
      const [sql, params] = mockDb.q.mock.calls[0];
      expect(String(sql)).toMatch(/CASE severity/);
      expect(String(sql)).toMatch(/'critical' THEN 0/);
      expect(params[0]).toBe('org-9');
    });

    it('supports date + department filters (PDF p.14)', async () => {
      mockDb.q.mockResolvedValueOnce([]);
      await svc.queue('org-9', {from: '2026-06-01', to: '2026-06-30', department: 'Operations'});
      const [sql, params] = mockDb.q.mock.calls[0];
      expect(String(sql)).toMatch(/created_at >= /);
      expect(String(sql)).toMatch(/created_at <= /);
      expect(String(sql)).toMatch(/department = /);
      expect(params).toEqual(expect.arrayContaining(['2026-06-01', '2026-06-30', 'Operations']));
    });
  });

  describe('department-scoped manager (PDF p.9/p.16)', () => {
    const SCOPED = {user_id: 'mgr-ops', org_user_id: 'org-9', department: 'Operations'};

    it('detail is blocked outside the manager\'s department', async () => {
      mockDb.qOne.mockResolvedValueOnce(null); // dept-scoped SELECT misses
      await expect(svc.detail('org-9', 'inc1', SCOPED.department)).rejects.toBeInstanceOf(NotFoundException);
      const [sql, params] = mockDb.qOne.mock.calls[0];
      expect(String(sql)).toMatch(/department = \$3/);
      expect(params).toContain('Operations');
    });
  });

  describe('updateStatus', () => {
    it('allows a legal transition, writes an event + audit, leaves the report narrative untouched', async () => {
      tx.qOne.mockResolvedValueOnce({status: 'submitted', submitter_id: 'sub-1', ref: 'INC-1'}); // SELECT FOR UPDATE
      const out = await svc.updateStatus('org-9', MANAGER, 'inc1', 'received');
      expect(out.status).toBe('received');
      // vs2 item 16 — the 4th arg is the incident id, so the REPORTER's tap can
      // reach their own report instead of a list screen.
      expect(mockPush.incidentStatusChanged).toHaveBeenCalledWith('sub-1', 'INC-1', 'received', 'inc1');
      const evt = tx.q.mock.calls.find(c => /INSERT INTO incident_events/i.test(String(c[0])));
      expect(evt).toBeDefined();
      const upd = tx.q.mock.calls.find(c => /UPDATE incident_reports/i.test(String(c[0])));
      // Only status/updated_at change — never category/severity/description/location.
      expect(String(upd![0])).not.toMatch(/description|category|severity|location/);
      expect(mockAudit.log).toHaveBeenCalledWith(
        'org-9', 'mgr-1', 'incident.status', expect.objectContaining({metadata: {from: 'submitted', to: 'received'}}),
      );
    });

    it('rejects an illegal hop (submitted → closed)', async () => {
      tx.qOne.mockResolvedValueOnce({status: 'submitted'});
      await expect(svc.updateStatus('org-9', MANAGER, 'inc1', 'closed')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('reopen (closed → under_review) is blocked for a delegated manager', async () => {
      tx.qOne.mockResolvedValueOnce({status: 'closed'});
      await expect(svc.updateStatus('org-9', MANAGER, 'inc1', 'under_review')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('reopen is allowed for the company admin', async () => {
      tx.qOne.mockResolvedValueOnce({status: 'closed'});
      const out = await svc.updateStatus('org-9', COMPANY, 'inc1', 'under_review');
      expect(out.status).toBe('under_review');
    });
  });

  describe('assign (D7-a)', () => {
    it('records the assignment on the timeline + updates assigned_to (active incident)', async () => {
      tx.qOne.mockResolvedValueOnce({status: 'under_review'}); // SELECT status FOR UPDATE
      const out = await svc.assign('org-9', COMPANY, 'inc1', 'org-9');
      expect(out).toEqual({id: 'inc1', assigned_to: 'org-9'});
      const upd = tx.q.mock.calls.find(c => /UPDATE incident_reports SET assigned_to/i.test(String(c[0])));
      expect(upd).toBeDefined();
      const evt = tx.q.mock.calls.find(c => /INSERT INTO incident_events/i.test(String(c[0])));
      expect(evt).toBeDefined(); // assignment now appears in detail()'s timeline
      expect(mockAudit.log).toHaveBeenCalledWith('org-9', 'org-9', 'incident.assign', expect.anything());
    });

    it('rejects assignment on a terminal (closed/resolved) incident', async () => {
      tx.qOne.mockResolvedValueOnce({status: 'closed'});
      await expect(svc.assign('org-9', COMPANY, 'inc1', 'org-9')).rejects.toThrow('incident_not_assignable');
    });

    it('rejects an assignee who is not an active manager', async () => {
      mockDb.qOne.mockResolvedValueOnce(null); // org_members manager check fails
      await expect(svc.assign('org-9', MANAGER, 'inc1', 'stranger')).rejects.toThrow('assignee_must_be_manager');
    });
  });

  describe('addNote', () => {
    it('appends an internal note and never logs the note text', async () => {
      mockDb.qOne.mockResolvedValueOnce({id: 'inc1'}); // exists
      await svc.addNote('org-9', MANAGER, 'inc1', 'secret manager note', true);
      const ins = mockDb.q.mock.calls.find(c => /INSERT INTO incident_events/i.test(String(c[0])));
      expect(ins).toBeDefined();
      expect(mockAudit.log).toHaveBeenCalledWith(
        'org-9', 'mgr-1', 'incident.note', expect.objectContaining({metadata: {internal: true}}),
      );
      // The note body must NOT appear in the audit metadata.
      const auditCall = mockAudit.log.mock.calls.find(c => c[2] === 'incident.note');
      expect(JSON.stringify(auditCall![3])).not.toMatch(/secret manager note/);
    });
  });

  // ─── Evidence attachments (Step 10) ───────────────────────────────────
  describe('attach / listAttachments', () => {
    it('lets the submitter attach an opaque storage_key to their own incident', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({submitter_id: 'user-1'}) // SELECT submitter_id
        .mockResolvedValueOnce({id: 'att1'});            // INSERT RETURNING
      const out = await svc.attach('user-1', 'inc1', 'vault/obj-abc');
      expect(out).toEqual({id: 'att1'});
      const ins = mockDb.qOne.mock.calls.find(c => /INSERT INTO incident_attachments/i.test(String(c[0])));
      expect(ins![1]).toEqual(['inc1', 'vault/obj-abc', 'user-1']); // opaque key only, no plaintext URL
    });

    it('rejects a non-submitter attaching', async () => {
      mockDb.qOne.mockResolvedValueOnce({submitter_id: 'someone-else'});
      await expect(svc.attach('user-1', 'inc1', 'k')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('lets a manager of the owning org list evidence', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({org_user_id: 'org-9', submitter_id: 'user-1'}) // incident
        .mockResolvedValueOnce({ok: 1});                                       // isOrgManager
      mockDb.q.mockResolvedValueOnce([{id: 'att1', storage_key: 'vault/obj-abc'}]);
      const out = await svc.listAttachments('mgr-1', 'inc1');
      expect(out[0].storage_key).toBe('vault/obj-abc');
    });

    it('blocks a manager of another org (403)', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({org_user_id: 'org-9', submitter_id: 'user-1'}) // incident
        .mockResolvedValueOnce(null);                                          // not a manager
      await expect(svc.listAttachments('outsider', 'inc1')).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ─── Evidence key delivery (Step 10 · E2) ─────────────────────────────
  describe('evidenceRecipients', () => {
    it('returns org managers + the submitter (deduped) for the submitter', async () => {
      mockDb.qOne.mockResolvedValueOnce({org_user_id: 'org-9', submitter_id: 'user-1'}); // submitter → skips manager check
      mockDb.q.mockResolvedValueOnce([{member_user_id: 'mgr-1'}]);                        // resolveOrgManagers
      const out = await svc.evidenceRecipients('user-1', 'inc1');
      expect(out).toEqual(expect.arrayContaining(['org-9', 'mgr-1', 'user-1']));
      expect(new Set(out).size).toBe(out.length); // deduped
    });

    it('blocks an outsider (not submitter, not manager) — 403', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({org_user_id: 'org-9', submitter_id: 'user-1'})
        .mockResolvedValueOnce(null); // isOrgManager → no
      await expect(svc.evidenceRecipients('outsider', 'inc1')).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('storeAttachmentKeys', () => {
    it('lets the uploader store opaque sealed blobs (idempotent upsert)', async () => {
      mockDb.qOne.mockResolvedValueOnce({created_by: 'user-1'}); // attachment ownership
      const out = await svc.storeAttachmentKeys('user-1', 'inc1', 'att1', [
        {recipient_user_id: 'mgr-1', device_id: 1, sealed_key: 'SEALED-BLOB'},
        {recipient_user_id: 'user-1', device_id: 2, sealed_key: 'SEALED-SELF'},
      ]);
      expect(out).toEqual({stored: 2});
      const ins = mockDb.q.mock.calls.filter(c => /INSERT INTO incident_attachment_keys/i.test(String(c[0])));
      expect(ins).toHaveLength(2);
      expect(String(ins[0][0])).toMatch(/ON CONFLICT[\s\S]*DO UPDATE/i); // idempotent
      expect(ins[0][1]).toEqual(['att1', 'mgr-1', 1, 'SEALED-BLOB']); // opaque ciphertext stored as-is
    });

    it('rejects a non-uploader storing keys — 403', async () => {
      mockDb.qOne.mockResolvedValueOnce({created_by: 'someone-else'});
      await expect(
        svc.storeAttachmentKeys('user-1', 'inc1', 'att1', [{recipient_user_id: 'm', device_id: 1, sealed_key: 'x'}]),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('404s when the attachment is not on that incident', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);
      await expect(svc.storeAttachmentKeys('user-1', 'inc1', 'bad', [])).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('getMyAttachmentKey', () => {
    it('returns the caller’s own sealed blob for this device', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({org_user_id: 'org-9', submitter_id: 'user-1'}) // submitter
        .mockResolvedValueOnce({sealed_key: 'SEALED-BLOB'});
      const out = await svc.getMyAttachmentKey('user-1', 2, 'inc1', 'att1');
      expect(out).toEqual({sealed_key: 'SEALED-BLOB'});
      const sel = mockDb.qOne.mock.calls.find(c => /FROM incident_attachment_keys/i.test(String(c[0])));
      expect(sel![1]).toEqual(['att1', 'user-1', 2]); // scoped to caller + device
    });

    it('404s when this device has no sealed blob (added/rotated after seal)', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({org_user_id: 'org-9', submitter_id: 'user-1'})
        .mockResolvedValueOnce(null); // no row for this device
      await expect(svc.getMyAttachmentKey('user-1', 9, 'inc1', 'att1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('blocks a manager of another org — 403', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({org_user_id: 'org-9', submitter_id: 'user-1'})
        .mockResolvedValueOnce(null); // isOrgManager → no
      await expect(svc.getMyAttachmentKey('outsider', 1, 'inc1', 'att1')).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('adminIncidents (IS-09)', () => {
    it('joins the org display name so the HQ list is not bare UUIDs', async () => {
      mockDb.q.mockResolvedValueOnce([{id: 'inc1', org_user_id: 'org-9', org_name: 'Falcon Security'}]);
      const out = await svc.adminIncidents({severity: 'high'});
      expect(out[0].org_name).toBe('Falcon Security');
      const [sql, params] = mockDb.q.mock.calls[0];
      expect(String(sql)).toMatch(/display_name\s+AS\s+org_name/i);
      expect(String(sql)).toMatch(/LEFT JOIN users u ON u\.id = i\.org_user_id/i);
      expect(params).toEqual([null, null, 'high']);
    });
  });
});
