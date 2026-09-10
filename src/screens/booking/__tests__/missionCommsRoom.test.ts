/**
 * Static source-scan regression for Issue 11 (Testing Issues V2, PDF p.16) —
 * "Mission Group Messaging Fails Between Mobile App and Bravo Control System".
 * CRITICAL.
 *
 * DIAGNOSED: org-mission.service.assignCrew creates the mission (step 3) and
 * THEN opens the Ops Room (step 5) inside a try/catch that logged at WARN and
 * carried on. When that catch fired the mission was already inserted AND
 * DISPATCHED, so crew-assign reported success while the mission had no comms
 * room — the mobile mission chat had nothing to open and the console answered
 * `conversation_not_found_or_forbidden`. Exactly the reported symptom, and
 * invisible until a human noticed mid-mission.
 *
 * NOW FIXED IN FULL, in two halves:
 *   1. the failure is no longer silent — ERROR level plus a queryable
 *      `missions.comms_room_failed_at` marker;
 *   2. the PDF's "mission activation must fail safely if the communication room
 *      cannot be created" — a FRESH assign whose room cannot be opened is
 *      ROLLED BACK (mission ABORTED, crew stood down, arrival clock cleared)
 *      and the assign fails with `comms_room_unavailable`, so a mission is
 *      never dispatched to a crew nobody can reach. A RESUME is deliberately
 *      NOT rolled back — that mission predates the call and may be in flight.
 *
 * The per-branch behaviour (which SQL runs, which pushes are suppressed, the
 * PICKUP race, a rollback that itself fails) is covered by the real unit tests
 * in `apps/auth-service/src/org/org-mission.service.spec.ts`. This file guards
 * the invariants that no unit test can see from the mobile project.
 *
 * This area has regressed five times (B-207, B-210, B-211, B-216) — B-210 being
 * a CRITICAL self-inflicted one that silently blocked the intent drain on every
 * trigger. Diagnosis before code.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = process.cwd();
const SERVICE = 'apps/auth-service/src/org/org-mission.service.ts';

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

describe('Issue 11 — a missing Ops Room can no longer pass silently', () => {
  it('the setup failure is logged at ERROR, not WARN', () => {
    const src = code(SERVICE);
    expect(src).not.toMatch(/log\.warn\(`ops-room\/intents setup failed/);
    expect(src).toMatch(/log\.error\(\s*\n?\s*`ops-room setup FAILED for booking/);
  });

  it('the failure is recorded on the mission so ops can query it', () => {
    const src = code(SERVICE);
    expect(src).toMatch(/UPDATE missions SET comms_room_failed_at = NOW\(\) WHERE id = \$1/);
  });

  it('recording the failure can never itself break the assign', () => {
    const src = code(SERVICE);
    const start = src.indexOf('comms_room_failed_at = NOW()');
    expect(src.slice(start, start + 200)).toMatch(/\.catch\(\(\) => undefined\)/);
  });

  it('the marker column exists and is indexed for the "who is broken" query', () => {
    const sql = readFileSync(
      join(ROOT, 'supabase', 'migrations', '20260725180000_mission_comms_room_failed.sql'), 'utf8',
    );
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS comms_room_failed_at TIMESTAMPTZ/);
    expect(sql).toMatch(/WHERE comms_room_failed_at IS NOT NULL/);
  });

  it('the mission FSM is untouched — this is a marker, not a state', () => {
    const sql = readFileSync(
      join(ROOT, 'supabase', 'migrations', '20260725180000_mission_comms_room_failed.sql'), 'utf8',
    );
    expect(sql).not.toMatch(/mission_status|ALTER TYPE|status\s*=/);
  });
});

describe('Issue 11 — mission activation FAILS SAFELY without a comms room', () => {
  it('a fresh assign that cannot open a room throws instead of returning ok', () => {
    const src = code(SERVICE);
    expect(src).toMatch(/throw new ServiceUnavailableException\('comms_room_unavailable'\)/);
  });

  it('the rollback is gated on `fresh` — a RESUME must never be aborted', () => {
    // A resumed assign's mission predates this call and may already be at
    // PICKUP/LIVE; aborting it would strand a real deployment.
    const src = code(SERVICE);
    expect(src).toMatch(/if \(fresh\) \{[\s\S]{0,200}rollbackFailedActivation/);
  });

  it('the rollback aborts the mission, stands the crew down AND clears the clock', () => {
    const src = code(SERVICE);
    // All three are load-bearing: mission_crew_agent_active_uq is scoped to
    // `status <> 'off'` regardless of mission status, so skipping the crew
    // stand-down leaves every CPO permanently "busy"; leaving
    // arrival_deadline_at set lets the no-show sweep re-dispatch the retry.
    expect(src).toMatch(/UPDATE missions SET status = 'ABORTED'/);
    expect(src).toMatch(/UPDATE mission_crew SET status = 'off' WHERE mission_id = \$1 AND status <> 'off'/);
    expect(src).toMatch(/UPDATE lite_bookings SET arrival_deadline_at = NULL WHERE id = \$1/);
  });

  it('the abort is conditional, so a lead who already reached PICKUP wins', () => {
    const src = code(SERVICE);
    expect(src).toMatch(/WHERE id = \$1 AND status = 'DISPATCHED' AND pickup_at IS NULL/);
  });

  it('escrow is not touched by the rollback', () => {
    // The hold belongs to the booking and is carried to the retry — the same
    // rule the arrival-no-show re-dispatch follows.
    const src = code(SERVICE);
    const fn = src.slice(src.indexOf('rollbackFailedActivation'));
    expect(fn).not.toMatch(/escrow_holds|holdToEscrow|refund/);
  });

  it('the agency is told what happened in plain language, not a raw code', () => {
    const screen = code('src/screens/agent/OrgMissionsScreen.tsx');
    expect(screen).toMatch(/comms_room_unavailable:/);
    expect(screen).toMatch(/nothing was dispatched/);
  });
});

describe('Issue 11 — the seating rules B-207 established are still intact', () => {
  it('the CLIENT and the OWNER are seated on every crew-assign, not only first creation', () => {
    // B-207: createMissionOpsRoom seats the client only on FIRST creation and
    // short-circuits on an existing comms_channel_id, so a resume or a crash
    // between create and seating left the client with no room at all.
    // B-416: the PROVIDER (owner) joined the seat list — under claimed key
    // authority a MANAGER's device can be the room bootstrapper, and an
    // unseated, unintented owner would be locked out of its own room.
    const src = code(SERVICE);
    expect(src).toMatch(/result\.clientId,\s*\n\s*result\.provider,\s*\n\s*\.\.\.crewIds,/);
  });

  it('BOTH halves still run — metadata seating AND the key-bearing intent', () => {
    // Seating without the intent shows an undecryptable room; the intent
    // without seating shows nothing, and the reconciliation sweep then DELETES
    // the locally bootstrapped copy.
    const src = code(SERVICE);
    expect(src).toMatch(/ensureRoomMembers\(room\.conversation_id, roomMembers\)/);
    expect(src).toMatch(/enqueueRoomIntent\(orgUserId, bookingId, room\.conversation_id, uid, 'add', requestedBy\)/);
  });

  it('the AGENCY owns the room, never SYSTEM — the server distributes no key', () => {
    const src = code(SERVICE);
    expect(src).toMatch(/creator_user_id: result\.provider/);
    expect(src).toMatch(/ops_admin_user_id: result\.provider/);
    // Crew are rekeyed in by the agency device draining intents, not seated with
    // a server-held key.
    expect(src).toMatch(/crew_user_ids: \[\]/);
  });
});
