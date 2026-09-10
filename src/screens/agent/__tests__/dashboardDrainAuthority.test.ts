/**
 * Static source-scan regression for B-416 — the AgentDashboard drain trigger
 * must be reachable for DELEGATED MANAGERS, not just the company owner.
 *
 * Two ways the old code silently excluded managers, both pinned here:
 *
 *   1. THE GATE — `me?.agent.type === 'company'` is false for every manager
 *      (a promoted-CPO manager's agents row says 'individual'; a pure manager
 *      has no agents row at all). The decision must go through the ONE shared
 *      predicate, isOpsRoomKeyAuthority (owner OR managed_org).
 *
 *   2. THE PLACEMENT — the drain used to live INSIDE the getMe() try-block.
 *      A pure delegated manager has no agents row, so getMe THROWS for them
 *      and the drain was unreachable for exactly the accounts B-416 admits.
 *      The drain must run BEFORE the getMe call, outside its try.
 *
 * The screen can't be imported by the node `booking` project (navigation,
 * gradients, api layer), so the fix is pinned by reading the source — same
 * pattern as assignCrewKeyDelivery.test.ts. The file is CRLF; comments are
 * stripped before every assertion.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const SCREEN = join(process.cwd(), 'src', 'screens', 'agent', 'AgentDashboardScreen.tsx');

function source(): string {
  return readFileSync(SCREEN, 'utf8').replace(/\r\n/g, '\n');
}
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
/** The body of load(), CODE only. */
function loadBody(): string {
  const src = stripComments(source());
  const start = src.indexOf('const load = useCallback(async () => {');
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('\n  }, []);', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('B-416 — AgentDashboard drain reachable for delegated managers (static source scan)', () => {
  it('imports both the drain and the shared authority predicate from the one rule module', () => {
    expect(source()).toMatch(
      /import\s*\{\s*drainDispatchRoomIntents\s*,\s*isOpsRoomKeyAuthority\s*\}\s*from\s*['"]@\/modules\/messenger\/orgWorkspace\/dispatchRoomIntents['"]/,
    );
  });

  it('load() gates the drain on isOpsRoomKeyAuthority, never on agent.type', () => {
    const body = loadBody();
    expect(body).toMatch(/isOpsRoomKeyAuthority\(/);
    // The agents-row shape is the trap: 'company' is false for every manager,
    // so keying this decision off it re-strands manager-claimed rooms.
    const drainAt = body.indexOf('drainDispatchRoomIntents(');
    expect(drainAt).toBeGreaterThan(-1);
    const decision = body.slice(Math.max(0, drainAt - 300), drainAt);
    expect(decision).not.toMatch(/agent\.type/);
  });

  it('load() drains BEFORE getMe — outside the try that throws for pure managers', () => {
    const body = loadBody();
    const drainAt = body.indexOf('drainDispatchRoomIntents(');
    const tryAt = body.indexOf('try {');
    const getMeAt = body.indexOf('agentApi.getMe(');
    expect(drainAt).toBeGreaterThan(-1);
    expect(tryAt).toBeGreaterThan(-1);
    expect(getMeAt).toBeGreaterThan(-1);
    expect(drainAt).toBeLessThan(tryAt);
    expect(drainAt).toBeLessThan(getMeAt);
  });

  it('the drain stays fire-and-forget (a drain failure must never blank the dashboard)', () => {
    expect(loadBody()).toMatch(/void drainDispatchRoomIntents\(\)\.catch\(/);
  });
});
