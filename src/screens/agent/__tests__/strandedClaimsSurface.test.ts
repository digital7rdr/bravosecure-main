/**
 * Static source-scan regression for B-417 — the stranded-claims warning
 * reaches the owner at act time.
 *
 * The server reports `stranded_room_claims` on every setCpoStatus/setCpoRole
 * response (a demoted/suspended/removed member who holds an Ops Room crypto
 * claim strands that room — B-416 deliberately never auto-frees claims). The
 * ONLY timely surface is the acting device's alert, so EVERY call site must
 * route the response through the ONE shared helper (duplicate-copy class: a
 * site that drops it silently reverts to learn-it-from-the-runbook).
 *
 * These screens can't be imported by the node `booking` project (navigation,
 * api layer), so the rule is pinned by reading the source — same pattern as
 * dashboardDrainAuthority.test.ts. Files are CRLF; comments are stripped.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const SCREENS = [
  'src/screens/agent/OrgRosterScreen.tsx',
  'src/screens/agent/OrgCpoProfileScreen.tsx',
  'src/screens/deptchat/EmployeesScreen.tsx',
];
const HELPER = 'src/utils/strandedClaimsAlert.ts';

function code(rel: string): string {
  const src = readFileSync(join(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('B-417 — stranded-claims surface (static source scan)', () => {
  it.each(SCREENS)('%s imports the ONE shared helper', rel => {
    expect(code(rel)).toMatch(
      /import\s*\{\s*warnStrandedClaims\s*\}\s*from\s*['"]@utils\/strandedClaimsAlert['"]/,
    );
  });

  it.each(SCREENS)('%s routes EVERY setCpoStatus/setCpoRole response through the helper', rel => {
    const src = code(rel);
    const calls = [...src.matchAll(/await orgApi\.setCpo(Status|Role)\(/g)];
    // The scan must be finding call sites, or the loop below proves nothing.
    expect(calls.length).toBeGreaterThan(0);
    for (const m of calls) {
      const at = m.index ?? 0;
      // The response must be captured…
      const before = src.slice(Math.max(0, at - 60), at);
      expect(before).toMatch(/const \{data\} =\s*$/);
      // …and handed to the helper before anything else navigates away.
      const after = src.slice(at, at + 300);
      expect(after).toMatch(/warnStrandedClaims\(data\.stranded_room_claims\)/);
    }
  });

  it('the helper no-ops on empty/undefined (older servers) and never throws on absence', () => {
    const helper = code(HELPER);
    expect(helper).toMatch(/if \(!rooms\?\.length\) \{return;\}/);
  });

  it('both api.ts response types carry the optional field', () => {
    const api = code('src/services/api.ts');
    const status = api.indexOf('setCpoStatus:');
    const role = api.indexOf('setCpoRole:');
    expect(status).toBeGreaterThan(-1);
    expect(role).toBeGreaterThan(-1);
    expect(api.slice(status, status + 600)).toMatch(/stranded_room_claims\?: string\[\]/);
    expect(api.slice(role, role + 400)).toMatch(/stranded_room_claims\?: string\[\]/);
  });
});
