/**
 * Static source-scan regression for Issue 39 (Testing Issues V2, PDF p.44) —
 * "Service Provider Cannot View Sufficient Agent Roster Information".
 *
 * Most of this already existed: OrgRosterScreen's action sheet has a "View
 * profile" entry, and OrgCpoProfileScreen already showed identity + contact,
 * roster join date, approval status, armed authorisation, duty state, the full
 * mission record and mission history.
 *
 * The two the PDF names that were genuinely absent — RATING and QUALIFICATIONS —
 * were already persisted on `agents` (rating from the Issue-31 flow, capabilities
 * from the Issue-36 selector). They were simply never selected or rendered, so
 * the provider had no basis for deciding who to assign.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = process.cwd();

function code(rel: string): string {
  const src = readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  const out: string[] = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (inBlock) { if (t.includes('*/')) {inBlock = false;} continue; }
    if (t.startsWith('/*') || t.startsWith('{/*')) { if (!t.includes('*/')) {inBlock = true;} continue; }
    if (t.startsWith('*') || t.startsWith('//')) {continue;}
    out.push(line.replace(/([^:'"`])\/\/.*$/, '$1'));
  }
  return out.join('\n');
}

const SERVICE = 'apps/auth-service/src/org/org-cpo.service.ts';
const SCREEN = 'src/screens/agent/OrgCpoProfileScreen.tsx';

describe('Issue 39 — the provider can assess an agent', () => {
  it('the profile query selects rating and capabilities', () => {
    // UPDATED 2026-07-25. This pinned `a.capabilities` — right intent (the
    // query must return capabilities) but the wrong table: `a` is `agents`,
    // and capabilities lives on `agent_profiles`. Postgres threw "column
    // a.capabilities does not exist" and 500'd the whole member-profile
    // endpoint, which is what the departmental-chat sender tap and
    // OrgHierarchyScreen both call.
    //
    // It went unnoticed because the deployed auth-service image predated this
    // query — a source scan proves the SQL was written, never that it runs.
    // The join is asserted below so the alias cannot go stale again.
    const src = code(SERVICE);
    expect(src).toMatch(/a\.rating AS agent_rating/);
    expect(src).toMatch(/ap\.capabilities AS agent_capabilities/);
    expect(src).not.toMatch(/a\.capabilities AS agent_capabilities/);
  });

  it('capabilities is joined from agent_profiles, the table it actually lives on', () => {
    // Selecting ap.* without joining ap is the same 500 with a different
    // message, so the alias and its join have to be asserted together.
    expect(code(SERVICE)).toMatch(/LEFT JOIN agent_profiles ap ON ap\.user_id = om\.member_user_id/);
  });

  it('an unrated agent is null, NOT 0 — a fake zero reads as a bad officer', () => {
    expect(code(SERVICE)).toMatch(/row\.agent_rating === null \|\| row\.agent_rating === undefined/);
  });

  it('capabilities always come back as an array, never null', () => {
    expect(code(SERVICE)).toMatch(/Array\.isArray\(row\.agent_capabilities\)[\s\S]{0,80}: \[\]/);
  });

  it('the screen renders both, with honest empty states', () => {
    const src = code(SCREEN);
    expect(src).toMatch(/label="Rating"/);
    expect(src).toMatch(/'Not yet rated'/);
    expect(src).toMatch(/label="Qualifications"/);
    expect(src).toMatch(/'None recorded'/);
  });

  it('capability KEYS are translated to labels, including the legacy ones', () => {
    const src = code(SCREEN);
    for (const key of ['firearms', 'medical_frec3', 'medical_paramedic', 'first_aid', 'medical']) {
      expect(src).toContain(`${key}:`);
    }
  });

  it('an UNKNOWN capability degrades instead of vanishing', () => {
    // Silently dropping a key the client does not know would hide a real
    // qualification from a compliance view.
    expect(code(SCREEN)).toMatch(/CAPABILITY_LABELS\[c\] \?\? c\.replace\(\/_\/g, ' '\)/);
  });

  it('the roster still routes to the profile from its action sheet', () => {
    const src = code('src/screens/agent/OrgRosterScreen.tsx');
    expect(src).toMatch(/text: 'View profile'/);
    expect(src).toMatch(/navigate\('OrgCpoProfile'/);
  });

  it('the detail the profile already carried is intact', () => {
    const src = code(SCREEN);
    for (const label of ['"Email"', '"Phone"', '"Member since"', '"Approval"', '"Armed authorised"', '"Duty state"']) {
      expect(src).toContain(`label=${label}`);
    }
    expect(src).toMatch(/MISSION RECORD/);
  });
});

/**
 * The two clauses the first pass left open — the PDF names them alongside the
 * fields above, and one of them is a security requirement, not a feature.
 */
describe('Issue 39 — qualification EXPIRY', () => {
  it('the query returns the compliance pack with its validity window', () => {
    const src = code(SERVICE);
    expect(src).toMatch(/FROM agent_documents ad WHERE ad\.user_id = om\.member_user_id/);
    expect(src).toMatch(/'expires_at', ad\.expires_at/);
    expect(src).toMatch(/'issuing_body', ad\.issuing_body/);
  });

  it('and the soonest ARMED permit expiry, not just the boolean', () => {
    expect(code(SERVICE)).toMatch(/min\(aa2\.expires_at\)[\s\S]{0,220}AS armed_expires_at/);
  });

  it('never selects a document file ref or permit number into this payload', () => {
    // Data minimisation: the provider needs to know a certificate is valid,
    // not to receive the certificate.
    const src = code(SERVICE);
    const block = src.slice(src.indexOf('FROM agent_documents ad') - 600, src.indexOf('FROM agent_documents ad') + 200);
    expect(block).not.toMatch(/file_url|file_hash|permit_ref/);
  });

  it('the column exists, is nullable, and is indexed only where it is set', () => {
    const sql = readFileSync(
      join(ROOT, 'supabase', 'migrations', '20260725190000_qualification_expiry.sql'), 'utf8',
    );
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS expires_at\s+TIMESTAMPTZ/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS issuing_body TEXT/);
    expect(sql).toMatch(/WHERE expires_at IS NOT NULL/);
    // Purely additive — a NOT NULL or a default on either ADD COLUMN would
    // break every existing row. Scoped to the ALTER, because the partial
    // index's `IS NOT NULL` predicate is legitimate.
    const alter = sql.slice(sql.indexOf('ALTER TABLE'), sql.indexOf('CREATE INDEX'));
    expect(alter).not.toMatch(/NOT NULL|DEFAULT/);
  });

  it('a MISSING expiry is "none recorded", never expired', () => {
    // Most rows predate the column; painting them red would tell a provider
    // their whole roster lapsed overnight.
    const src = code(SCREEN);
    expect(src).toMatch(/if \(!expiresAt\) \{return \{label: 'no expiry recorded'\};\}/);
    // An unparseable date takes the same safe branch.
    expect(src).toMatch(/if \(!Number\.isFinite\(ms\)\) \{return \{label: 'no expiry recorded'\};\}/);
  });

  it('a lapsed certificate is called EXPIRED, and a near one warns', () => {
    const src = code(SCREEN);
    expect(src).toMatch(/if \(days < 0\) \{return \{label: `EXPIRED /);
    expect(src).toMatch(/days <= EXPIRY_WARN_DAYS/);
  });

  it('the screen renders a certifications block driven by that state', () => {
    const src = code(SCREEN);
    expect(src).toMatch(/CERTIFICATIONS/);
    expect(src).toMatch(/expiryState\(q\.expires_at\)/);
    expect(src).toMatch(/expiryState\(p\.armed_expires_at\)/);
  });
});

describe('Issue 39 — AUDIT OF ACCESS (PDF security clause)', () => {
  it('opening an officer profile writes an org-tier audit row', () => {
    const src = code(SERVICE);
    expect(src).toMatch(/'roster\.profile\.view'/);
    expect(src).toMatch(/targetKind: 'org_member'/);
  });

  it('it is written BEFORE the read, so a rejected probe is still logged', () => {
    const src = code(SERVICE);
    const auditAt = src.indexOf("'roster.profile.view'");
    const readAt = src.indexOf('WHERE om.org_user_id = $1 AND om.member_user_id = $2');
    expect(auditAt).toBeGreaterThan(-1);
    expect(readAt).toBeGreaterThan(-1);
    expect(auditAt).toBeLessThan(readAt);
  });

  it('the audit row carries NO PII — coarse ids only', () => {
    const src = code(SERVICE);
    const start = src.indexOf("'roster.profile.view'");
    const block = src.slice(start - 200, start + 300);
    expect(block).not.toMatch(/display_name|email|phone|capabilit|rating/);
  });

  it('a failed audit write never breaks the read', () => {
    const src = code(SERVICE);
    const start = src.indexOf("'roster.profile.view'");
    expect(src.slice(start, start + 300)).toMatch(/\.catch\(/);
  });

  it('the VIEWER is recorded, not the company account', () => {
    // A delegated manager and the owner must be distinguishable in the log.
    expect(code('apps/auth-service/src/org/org.controller.ts'))
      .toMatch(/getMemberProfile\(manager\.org_user_id, memberUserId, manager\.user_id\)/);
  });

  it('uses the ORG audit tier, not the HQ one', () => {
    // org_audit_log is append-only and provider-scoped; OpsAuditService is the
    // AdminGuard tier and deliberately separate.
    const src = code(SERVICE);
    expect(src).toMatch(/this\.audit\s*\n?\s*\.log\(orgUserId, viewerId, 'roster\.profile\.view'/);
  });
});
