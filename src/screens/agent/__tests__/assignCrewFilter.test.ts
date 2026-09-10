/**
 * Static source-scan regression for the assign-crew candidate filter.
 *
 * OrgMissionsScreen renders the "Assign crew" sheet. The server already rejects
 * a bad pick (cpo_not_in_org / cpo_not_approved_for_deployment / cpo_not_on_duty),
 * but the LIST must not offer them as selectable in the first place. This screen
 * can't be imported by the node `booking` project (navigation, gradients, api
 * layer), so the filter is pinned by reading the source.
 *
 * B-200 unverified CPO hidden · B-201 only CPOs (not managers/employees) ·
 * B-202 off-duty hidden. If one fails: restore the predicate, or change the
 * rule deliberately and update sqa.md.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const SCREEN = join(process.cwd(), 'src', 'screens', 'agent', 'OrgMissionsScreen.tsx');

function source(): string {
  return readFileSync(SCREEN, 'utf8').replace(/\r\n/g, '\n');
}
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
function filterBody(): string {
  const src = stripComments(source());
  const start = src.indexOf('const activeRoster = roster.filter(');
  const end = src.indexOf(');', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('assign-crew candidate filter (static source scan)', () => {
  it('B-201: only member_role === "cpo" is assignable (not managers/employees/owner)', () => {
    expect(filterBody()).toMatch(/m\.member_role === 'cpo'/);
  });

  it('B-200: only ops-verified CPOs (ACTIVE/APPROVED) are assignable', () => {
    const body = filterBody();
    expect(body).toMatch(/m\.agent_status === 'ACTIVE'/);
    expect(body).toMatch(/m\.agent_status === 'APPROVED'/);
  });

  it('B-202: only ON-DUTY CPOs are assignable', () => {
    expect(filterBody()).toMatch(/m\.on_duty/);
  });

  it('B-202: the row no longer claims an off-duty guard "can still be assigned"', () => {
    expect(stripComments(source())).not.toMatch(/can still be assigned/);
  });
});
