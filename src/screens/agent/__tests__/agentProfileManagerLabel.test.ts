/**
 * B-215 follow-up — a manager's own profile showed the wrong role.
 *
 * The premise below was backwards, and the correction is the whole point: a
 * delegated manager IS a promoted CPO, so `agents.managed_by_org_id` is set and
 * ACCOUNT_KIND_SQL's cpo precedence pins account_kind='cpo'. So `isCpo` is TRUE
 * for a manager (not false), and the replacement test `account_kind==='agency'
 * && org` was false — the chip read "CPO", and the org-KPI effect never ran, so
 * RATING/JOBS DONE silently showed personal numbers on a manager's profile.
 * Both now key off the server-computed `managed_org`; see
 * managerModuleGrants.test.ts for the contract.
 *
 * This screen can't be imported by the node `booking` project (native
 * deps), so it's pinned by reading the source — same pattern as
 * agentDashboardOrgScoping.test.ts.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const SCREEN = join(process.cwd(), 'src', 'screens', 'agent', 'AgentProfileScreen.tsx');

function source(): string {
  return readFileSync(SCREEN, 'utf8').replace(/\r\n/g, '\n');
}
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('B-215 — AgentProfileScreen shows "Manager" for a delegated manager (static source scan)', () => {
  it('defines isManager from the server-computed managed_org', () => {
    const src = stripComments(source());
    const start = src.indexOf('const isManager = ');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf(';', start);
    expect(src.slice(start, end)).toMatch(/!!user\?\.managed_org/);
    // Neither superseded client-side derivation may return.
    expect(src).not.toMatch(/account_kind === 'agency' && !!user\?\.org/);
  });

  it('the org KPI effect runs for a manager, not just an agency-kind account', () => {
    // This is why a manager saw their PERSONAL rating: account_kind is 'cpo'
    // for them, so the org-scoped fetch was skipped entirely.
    const src = stripComments(source());
    const start = src.indexOf('const orgScoped = ');
    expect(start).toBeGreaterThan(-1);
    expect(src.slice(start, src.indexOf(';', start))).toMatch(/\|\| isManager/);
  });

  it('roleLabel checks isManager before falling back to CPO/Agent/Agency Owner', () => {
    const src = stripComments(source());
    expect(src).toMatch(/const roleLabel = isManager \? 'Manager' : isCpo \? 'CPO'/);
  });

  it('the "Agency · {org.name}" line shows for a manager too, not just a plain CPO', () => {
    const src = stripComments(source());
    expect(src).toMatch(/\(isCpo \|\| isManager\) && user\?\.org\?\.name/);
  });
});

describe('B-215 — AgentProfileScreen RATING/JOBS DONE prefer the org KPI over the personal agents-row (static source scan)', () => {
  it('fetches orgApi.getSummary() for any agency-kind viewer (owner or manager)', () => {
    const src = stripComments(source());
    expect(src).toMatch(/orgApi\.getSummary\(\)/);
    expect(src).toMatch(/setOrgKpi\(\{rating: data\.org_rating, jobs_total: data\.org_jobs_total\}\)/);
  });

  it('RATING prefers orgKpi.rating over the personal me.agent.rating', () => {
    const src = stripComments(source());
    expect(src).toMatch(/orgKpi\?\.rating !== null && orgKpi\?\.rating !== undefined \? orgKpi\.rating\.toFixed\(2\)/);
  });

  it('JOBS DONE prefers orgKpi.jobs_total over the personal me.agent.jobs_total', () => {
    const src = stripComments(source());
    expect(src).toMatch(/\{orgKpi \? orgKpi\.jobs_total : \(me\?\.agent\.jobs_total \?\? 0\)\}/);
  });
});
