import {readFileSync} from 'fs';
import {join} from 'path';

/**
 * AUTHZ-6 — ops/pro admin `:id` route params must run through ParseUUIDPipe so a
 * malformed id is a clean 400, not a 500 from the DB layer (and never reaches a
 * query as an arbitrary string). These endpoints previously took a bare
 * `@Param('id')`. Source scan (the handlers are thin passthroughs the node Jest
 * project can't bootstrap through the real pipe pipeline).
 */
const ROOT = join(__dirname, '..');
const strip = (s: string) => s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

const CASES: Array<[string, string]> = [
  ['dispatch/dispatch-admin.controller.ts', 'getRequest'],
  ['pro-applications/pro-applications-ops.controller.ts', 'get'],
  ['pro-management/pro-fleet-ops.controller.ts', 'applicationVehicles'],
  ['pro-management/pro-fleet-ops.controller.ts', 'applicationResources'],
  ['pro-management/pro-management-ops.controller.ts', 'orgDetail'],
];

describe('AUTHZ-6 — admin :id params are UUID-validated', () => {
  it.each(CASES)('%s#%s binds @Param(\'id\', ParseUUIDPipe)', (file, handler) => {
    const src = strip(readFileSync(join(ROOT, file), 'utf8'));
    // The handler declares its id param with the pipe, on one line.
    const re = new RegExp(`\\b${handler}\\s*\\(\\s*@Param\\('id',\\s*ParseUUIDPipe\\)`);
    expect(re.test(src)).toBe(true);
  });

  it('no admin controller binds a bare UUID param (id/missionId/userId) without a pipe', () => {
    const files = Array.from(new Set(CASES.map(([f]) => f)));
    for (const file of files) {
      const src = strip(readFileSync(join(ROOT, file), 'utf8'));
      // A bare param closes the paren right after the name; the piped form has a comma.
      expect(src).not.toMatch(/@Param\('(id|missionId|userId)'\)/);
    }
  });
});
