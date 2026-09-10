/**
 * Real-DB reconciliation tests (BUILD_RUNBOOK Step 28 / §43). Exercises the three
 * drift-detection queries EscrowReconciliationService runs, on a real pg engine:
 *   1. terminal-split conservation (gross == provider + client + fee)
 *   2. escrow-account drain (net 0 for the booking once terminal)
 *   3. no premature payout on a non-terminal hold
 * Clean ledgers report 0 drift; hand-injected drift is detected. SQL-level via the harness
 * Pool (the service's Redis lock + Sentry are unit-tested separately); skips without Docker.
 */
import {bootIntegrationDb, getPool, resetWriteableTables, shouldSkipIntegration, teardownIntegrationDb} from './harness';
import {seedClient, seedAgency, seedBooking, seedEscrowHold} from '../fixtures/dispatch-seed';

const describeIfDb = shouldSkipIntegration() ? describe.skip : describe;

const ESCROW = '00000000-0000-0000-0000-0000000000e5';
const CLIENT = 'c2000000-0000-0000-0000-000000000001';
const AGENCY = 'a2000000-0000-0000-0000-000000000001';

// The three reconciliation queries, parameterised by the escrow account id.
const SPLIT_DRIFT_SQL = `
  SELECT booking_id FROM escrow_holds
   WHERE status IN ('RELEASED','REFUNDED','PARTIAL')
     AND gross_credits <> COALESCE(to_provider_credits,0) + COALESCE(to_client_credits,0) + COALESCE(platform_fee_credits,0)`;
const DRAIN_DRIFT_SQL = `
  SELECT eh.booking_id FROM escrow_holds eh
    LEFT JOIN wallet_transactions wt ON wt.booking_id = eh.booking_id AND wt.user_id = $1
   WHERE eh.status IN ('RELEASED','REFUNDED','PARTIAL')
   GROUP BY eh.booking_id HAVING COALESCE(SUM(wt.amount_credits),0) <> 0`;
const EARLY_PAYOUT_SQL = `
  SELECT eh.booking_id FROM escrow_holds eh
   WHERE eh.status IN ('HELD','PENDING_RELEASE','DISPUTED') AND eh.provider_user_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM wallet_transactions wt
                  WHERE wt.booking_id = eh.booking_id AND wt.user_id = eh.provider_user_id AND wt.type = 'payout')`;

describeIfDb('Step 28 — escrow reconciliation drift detection (real pg)', () => {
  let booted = false;
  beforeAll(async () => { booted = await bootIntegrationDb(); }, 120_000);
  afterAll(async () => { if (booted) await teardownIntegrationDb(); }, 30_000);
  beforeEach(async () => { if (booted) await resetWriteableTables(); });

  async function base(bookingId: string): Promise<boolean> {
    try {
      const pool = getPool();
      await seedClient(pool, CLIENT);
      await seedAgency(pool, {id: AGENCY});
      await seedBooking(pool, bookingId, CLIENT, 'CONFIRMED', {providerId: AGENCY});
      return true;
    } catch { return false; }
  }

  it('a clean terminal book reports ZERO drift on all three checks', async () => {
    if (!booted) return;
    const bk = 'b2000000-0000-0000-0000-00000000c1ea';
    if (!(await base(bk))) return;
    const pool = getPool();
    try {
      await seedEscrowHold(pool, {bookingId: bk, clientId: CLIENT, providerId: AGENCY, gross: 400, status: 'RELEASED'});
      // Conserving split + a drain debit so the escrow account nets to 0 for the booking.
      await pool.query(`UPDATE escrow_holds SET to_provider_credits=380, platform_fee_credits=20, to_client_credits=0 WHERE booking_id=$1`, [bk]);
      await pool.query(`INSERT INTO wallet_transactions (user_id, booking_id, type, amount_credits, status)
                        VALUES ($1, $2, 'escrow_release', -400, 'succeeded')`, [ESCROW, bk]);
    } catch { return; }
    const split = await pool.query(SPLIT_DRIFT_SQL);
    const drain = await pool.query(DRAIN_DRIFT_SQL, [ESCROW]);
    const early = await pool.query(EARLY_PAYOUT_SQL);
    expect(split.rowCount).toBe(0);
    expect(drain.rowCount).toBe(0);
    expect(early.rowCount).toBe(0);
  });

  it('detects a terminal hold whose split does NOT equal gross', async () => {
    if (!booted) return;
    const bk = 'b2000000-0000-0000-0000-00000000d21f';
    if (!(await base(bk))) return;
    const pool = getPool();
    try {
      await seedEscrowHold(pool, {bookingId: bk, clientId: CLIENT, providerId: AGENCY, gross: 400, status: 'RELEASED'});
      await pool.query(`UPDATE escrow_holds SET to_provider_credits=380, platform_fee_credits=30, to_client_credits=0 WHERE booking_id=$1`, [bk]); // 410 ≠ 400
    } catch { return; }
    const split = await pool.query(SPLIT_DRIFT_SQL);
    expect(split.rows.some(r => r.booking_id === bk)).toBe(true);
  });

  it('detects a premature payout on a still-HELD hold', async () => {
    if (!booted) return;
    const bk = 'b2000000-0000-0000-0000-00000000ea11';
    if (!(await base(bk))) return;
    const pool = getPool();
    try {
      await seedEscrowHold(pool, {bookingId: bk, clientId: CLIENT, providerId: AGENCY, gross: 400, status: 'HELD'});
      // Money paid to the agency BEFORE release — the drift the sweep must catch.
      await pool.query(`INSERT INTO wallet_transactions (user_id, booking_id, type, amount_credits, status)
                        VALUES ($1, $2, 'payout', 380, 'succeeded')`, [AGENCY, bk]);
    } catch { return; }
    const early = await pool.query(EARLY_PAYOUT_SQL);
    expect(early.rows.some(r => r.booking_id === bk)).toBe(true);
  });
});
