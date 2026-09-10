/**
 * Static source-scan regression for Issue 41 (Testing Issues V2, PDF p.46) —
 * "Agent Acceptance Is Missing Before Client Confirmation and Dispatch".
 * CRITICAL.
 *
 * assignCrew creates the mission directly as DISPATCHED, so the client's journey
 * rail jumped to step 3 "Team dispatched" the instant the PROVIDER accepted —
 * before any officer had agreed to take the job.
 *
 * SCOPE, stated deliberately. The open question (fix plan §10 Q4) was where
 * escrow sits once acceptance exists. This change does not answer it and does
 * not need to: escrow timing is UNCHANGED, still taken at provider-accept.
 * `missions.status` is UNCHANGED too, so the ops console, the CPO screens and
 * the mission FSM behave exactly as before. Only the client-facing projection
 * waits for a real acceptance — which is precisely the PDF's acceptance check,
 * "Confirm the client is not told the team is dispatched before agent
 * acceptance". The stricter reading (reserve, then hold escrow at acceptance,
 * reassign on decline/timeout) still needs the finance decision.
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

/** Body of a top-level function, bounded at its closing brace. Slicing to EOF
 *  swallows the rest of the file and makes an absence assertion vacuous. */
function fnBody(src: string, decl: string): string {
  const start = src.indexOf(decl);
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('\n}', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

const BOOKING = 'apps/auth-service/src/booking/booking.service.ts';
const AGENTS = 'apps/auth-service/src/agents/agent.service.ts';

describe('Issue 41 — the client is not told "dispatched" before an officer accepts', () => {
  it('a DISPATCHED mission with NO acceptance reports null to the client', () => {
    const fn = fnBody(code(BOOKING), 'export function clientMissionStatus');
    expect(fn).toMatch(/if \(mission\.status !== 'DISPATCHED'\) return mission\.status;/);
    expect(fn).toMatch(/return mission\.crew_accepted \? 'DISPATCHED' : null;/);
  });

  it('null lands the client on step 2 "Accepted · assigning team", which is true', () => {
    // journeyStep's contract: booking CONFIRMED with no mission status is step 2.
    // Assert the runtime half (STEP_LABELS), not the JSDoc — prose is not a gate.
    const journey = code('src/screens/booking/missionJourney.ts');
    expect(journey).toMatch(/'Accepted · assigning team',/);
    expect(journey).toMatch(/'Team dispatched',/);
    // Order matters: 2 must precede 3, or "not yet dispatched" would read ahead.
    expect(journey.indexOf("'Accepted · assigning team'"))
      .toBeLessThan(journey.indexOf("'Team dispatched'"));
  });

  it('BOTH client read paths use the projection — list and getById', () => {
    const src = code(BOOKING);
    expect(src.match(/clientMissionStatus\(/g)?.length).toBeGreaterThanOrEqual(3);
    expect(src).toMatch(/booking\.mission_status = clientMissionStatus\(mission\)/);
    expect(src).toMatch(/byBooking = new Map\(missions\.map\(m => \[m\.booking_id, clientMissionStatus\(m\)\]\)\)/);
  });

  it('both queries actually compute crew_accepted', () => {
    const src = code(BOOKING);
    expect((src.match(/mc\.accepted_at IS NOT NULL\) AS crew_accepted/g) ?? []).length).toBe(2);
  });

  it('states past DISPATCHED pass through untouched', () => {
    // A mission that has physically moved on is self-evidently accepted; gating
    // PICKUP/LIVE/COMPLETED would HIDE real progress if an accept row were missed.
    const fn = fnBody(code(BOOKING), 'export function clientMissionStatus');
    expect(fn).not.toMatch(/'PICKUP'|'LIVE'|'COMPLETED'/);
  });
});

describe('Issue 41 — the officer can accept or decline', () => {
  it('an accept/decline path exists and is crew-gated', () => {
    const src = code(AGENTS);
    const start = src.indexOf('async respondToAssignment');
    expect(start).toBeGreaterThan(-1);
    const fn = src.slice(start, src.indexOf('\n  async raiseSos', start));
    expect(fn).toMatch(/not_assigned_to_mission/);
    expect(fn).toMatch(/status <> 'off'/);
    // Both writes are conditional on accepted_at IS NULL: accepting twice is a
    // no-op, and a decline can never overwrite an accept.
    expect((fn.match(/accepted_at IS NULL/g) ?? []).length).toBe(2);
    // The window TIGHTENED (2026-08-05 review): responding is DISPATCHED-only,
    // so a stale card can no longer land a decline on a running mission.
    expect(fn).toMatch(/respond_window_closed/);
    expect(fn).toMatch(/mission\.status !== 'DISPATCHED'/);
  });

  it('is reachable — the route is registered', () => {
    const ctrl = code('apps/auth-service/src/agents/agent.controller.ts');
    expect(ctrl).toMatch(/@Post\('me\/missions\/:missionId\/respond'\)/);
    // Idempotency-keyed so a double-tap collapses to one write.
    expect(ctrl).toMatch(/respond'\)[\s\S]{0,140}IdempotencyInterceptor/);
  });
});

describe('Issue 41 — nothing about money or the mission FSM moved', () => {
  it('escrow is still held at provider-accept, untouched', () => {
    const dispatch = code('apps/auth-service/src/dispatch/dispatch.service.ts');
    expect(dispatch).toMatch(/holdToEscrow/);
    // The acceptance flow must not appear anywhere near the money path.
    expect(dispatch).not.toMatch(/accepted_at|respondToAssignment/);
    expect(code('apps/auth-service/src/wallet/wallet.service.ts')).not.toMatch(/accepted_at/);
  });

  it('assignCrew still creates the mission as DISPATCHED — ops keeps the real state', () => {
    expect(code('apps/auth-service/src/org/org-mission.service.ts'))
      .toMatch(/INSERT INTO missions \(booking_id, status, short_code\)[\s\S]{0,60}'DISPATCHED'/);
  });

  it('the migration adds only crew columns, never a missions change', () => {
    const sql = readFileSync(
      join(ROOT, 'supabase', 'migrations', '20260725160000_mission_crew_acceptance.sql'), 'utf8',
    );
    expect(sql).toMatch(/ALTER TABLE mission_crew/);
    expect(sql).not.toMatch(/ALTER TABLE missions|UPDATE missions/);
  });
});

/**
 * Issue 41, second increment. Still NOT the escrow move — that remains gated on
 * fix plan §10 Q4 — but the half of "reassign on decline" that needs no finance
 * decision: the party who must re-crew has to learn the officer said no.
 */
describe('Issue 41 — an officer’s answer reaches the provider', () => {
  const SVC = 'apps/auth-service/src/agents/agent.service.ts';
  const BRIDGE = 'apps/auth-service/src/ops/booking-push-bridge.service.ts';

  it('a DECLINE wakes the assigned provider', () => {
    // It used to write declined_at and stop. Nobody was watching that column,
    // so the client's rail sat at "assigning team" indefinitely.
    const src = code(SVC);
    expect(src).toMatch(/notifyProviderOfResponse\(missionId, false\)/);
    expect(code(BRIDGE)).toMatch(/kind: accepted \? 'mission-accepted' : 'mission-declined'/);
  });

  it('an ACCEPT does too — the acceptance stage is only useful if it is visible', () => {
    expect(code(SVC)).toMatch(/notifyProviderOfResponse\(missionId, true\)/);
  });

  it('only the FIRST write notifies, so a re-tap cannot re-wake the agency', () => {
    const src = code(SVC);
    // Both branches gate on the conditional UPDATE actually changing a row.
    expect(src.match(/if \(upd\.length > 0\) \{await this\.notifyProviderOfResponse/g) ?? [])
      .toHaveLength(2);
    expect(src.match(/RETURNING agent_id/g) ?? []).toHaveLength(2);
  });

  it('the wake targets the ASSIGNED PROVIDER, resolved through the booking', () => {
    const src = code(SVC);
    expect(src).toMatch(/b\.assigned_provider_user_id AS provider_user_id/);
    // A booking with no provider is a no-op, not a crash.
    expect(src).toMatch(/if \(!row\?\.provider_user_id\) \{return;\}/);
  });

  it('a failed push never fails the officer’s accept or decline', () => {
    const src = code(SVC);
    const fn = src.slice(src.indexOf('private async notifyProviderOfResponse'));
    expect(fn.slice(0, 900)).toMatch(/catch \(e\)/);
  });

  it('STILL does not touch escrow or the mission FSM — §10 Q4 remains open', () => {
    // The boundary this increment must not cross.
    const src = code(SVC);
    const fn = src.slice(
      src.indexOf('async respondToAssignment'),
      src.indexOf('private async notifyProviderOfResponse'),
    );
    expect(fn).not.toMatch(/escrow|holdToEscrow|wallet/i);
    expect(fn).not.toMatch(/UPDATE missions SET status/);
  });
});
