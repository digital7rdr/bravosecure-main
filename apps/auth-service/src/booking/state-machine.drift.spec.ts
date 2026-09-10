/**
 * Audit fix 2.3 — drift detector between the TypeScript FSM and the
 * Postgres FSM-enforcement trigger (`lite_bookings_fsm_check` defined
 * in supabase/migrations/20260509100000_phase2_data_integrity.sql).
 *
 * The DB trigger exists so a service method that bypasses the
 * BookingStateMachine helper still can't write an illegal transition.
 * The two definitions MUST agree — if the TS FSM allows a transition
 * the DB trigger doesn't, the request 500s; if the trigger allows one
 * the TS FSM doesn't, the trigger is dead weight. This spec parses the
 * migration SQL and asserts both sets are identical.
 *
 * Negative-path coverage of the trigger itself (real-DB integration)
 * stays parked under Phase 5.5; this is the cheap check that catches
 * drift in the meantime.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

// Points at the LATEST migration that (re)defines lite_bookings_fsm_check().
// 20260509100000 first created it; 20260620000001 added the auto-dispatch
// transitions; 20260622000001 added CONFIRMED -> AGENCY_NO_SHOW; 20260628000001
// added CONFIRMED -> DISPATCHING (arrival no-show re-dispatch); 20260630000000 added
// CONFIRMED -> COMPLETED (auto-dispatch completion); 20260706000000 added
// OPS_APPROVED -> DISPATCHING (ops-gated auto dispatch), so that is now the canonical one.
const MIGRATION_PATH = join(
  __dirname, '..', '..', '..', '..',
  'supabase', 'migrations', '20260706000000_ops_gated_auto_dispatch.sql',
);

interface Pair {from: string; to: string}

/** Mirrors the canonical allowed transitions from the TypeScript FSM. */
const TS_PAIRS: Pair[] = [
  {from: 'DRAFT',           to: 'PENDING_OPS'},
  {from: 'PENDING_OPS',     to: 'OPS_APPROVED'},
  {from: 'OPS_APPROVED',    to: 'PAYMENT_PENDING'},
  {from: 'PAYMENT_PENDING', to: 'CONFIRMED'},
  {from: 'CONFIRMED',       to: 'LIVE'},
  {from: 'LIVE',            to: 'COMPLETED'},
  // Auto-dispatch completion — booking stays CONFIRMED through the mission, then
  // the CPO Finish / ops close it straight from CONFIRMED.
  {from: 'CONFIRMED',       to: 'COMPLETED'},
  // Cancellation is universal from any non-terminal state.
  {from: 'DRAFT',            to: 'CANCELLED'},
  {from: 'PENDING_OPS',      to: 'CANCELLED'},
  {from: 'OPS_APPROVED',     to: 'CANCELLED'},
  {from: 'PAYMENT_PENDING',  to: 'CANCELLED'},
  {from: 'CONFIRMED',        to: 'CANCELLED'},
  {from: 'LIVE',             to: 'CANCELLED'},
  // Auto-dispatch (Uber-style). DISPATCHING is cancellable while searching;
  // NO_PROVIDER and AGENCY_NO_SHOW are terminal (no outgoing transitions).
  {from: 'DRAFT',            to: 'DISPATCHING'},
  {from: 'DISPATCHING',      to: 'CONFIRMED'},
  {from: 'DISPATCHING',      to: 'NO_PROVIDER'},
  {from: 'DISPATCHING',      to: 'CANCELLED'},
  {from: 'CONFIRMED',        to: 'AGENCY_NO_SHOW'},
  // Arrival no-show re-dispatch (Step 16): CONFIRMED re-enters the search.
  {from: 'CONFIRMED',        to: 'DISPATCHING'},
  // Ops-gated auto dispatch: ops approval hands the auto booking to the matchmaker.
  {from: 'OPS_APPROVED',     to: 'DISPATCHING'},
];

/**
 * Pull the OLD.status / NEW.status pairs out of the
 * `lite_bookings_fsm_check` plpgsql body. Format we expect:
 *   (OLD.status = 'X' AND NEW.status IN ('Y','Z',...))
 */
function parseDbPairs(sql: string): Pair[] {
  const fnStart = sql.indexOf('lite_bookings_fsm_check()');
  expect(fnStart).toBeGreaterThanOrEqual(0);
  const fnEnd = sql.indexOf('$$ LANGUAGE plpgsql', fnStart);
  const body = sql.slice(fnStart, fnEnd);

  const out: Pair[] = [];
  const re = /OLD\.status\s*=\s*'([A-Z_]+)'\s+AND\s+NEW\.status\s+IN\s*\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const from = m[1];
    const tos  = m[2].split(',').map(s => s.trim().replace(/'/g, ''));
    for (const to of tos) out.push({from, to});
  }
  return out;
}

describe('FSM drift — TypeScript ↔ Postgres trigger (Phase 2.3)', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf8');
  const dbPairs = parseDbPairs(sql);

  it('migration file exists and parses', () => {
    expect(dbPairs.length).toBeGreaterThan(0);
  });

  it('every TS-allowed transition also exists in the DB trigger', () => {
    for (const p of TS_PAIRS) {
      const found = dbPairs.some(d => d.from === p.from && d.to === p.to);
      expect({found, p}).toEqual({found: true, p});
    }
  });

  it('every DB-allowed transition also exists in the TS FSM (no DB-only escape hatches)', () => {
    for (const d of dbPairs) {
      const found = TS_PAIRS.some(p => p.from === d.from && p.to === d.to);
      expect({found, d}).toEqual({found: true, d});
    }
  });

  it('rejects an obviously illegal transition (DRAFT → COMPLETED) in both layers', () => {
    expect(TS_PAIRS.some(p => p.from === 'DRAFT' && p.to === 'COMPLETED')).toBe(false);
    expect(dbPairs.some(d => d.from === 'DRAFT' && d.to === 'COMPLETED')).toBe(false);
  });

  it('rejects backwards (COMPLETED → LIVE) in both layers', () => {
    expect(TS_PAIRS.some(p => p.from === 'COMPLETED' && p.to === 'LIVE')).toBe(false);
    expect(dbPairs.some(d => d.from === 'COMPLETED' && d.to === 'LIVE')).toBe(false);
  });
});
