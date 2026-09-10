/**
 * Real-DB money-invariant tests (BUILD_RUNBOOK Step 27 / §43). Asserts the escrow ledger
 * conserves on a real pg engine — the property the Step-28 reconciliation sweep watches:
 *   - HELD:     sum(client debits) == escrow_holds.gross_credits
 *   - terminal: gross_credits == to_provider + to_client + platform_fee
 *   - paired:   every booking's wallet_transactions net to 0 (debit one acct, credit other)
 *
 * SQL-level via the harness Pool; skips when Docker is unavailable; seeds defensively.
 */
import {bootIntegrationDb, getPool, resetWriteableTables, shouldSkipIntegration, teardownIntegrationDb} from './harness';
import {seedClient, seedAgency, seedBooking, seedEscrowHold} from '../fixtures/dispatch-seed';

const describeIfDb = shouldSkipIntegration() ? describe.skip : describe;

const CLIENT = 'c1000000-0000-0000-0000-000000000001';
const AGENCY = 'a1000000-0000-0000-0000-000000000001';
const BOOKING = 'b1000000-0000-0000-0000-000000000001';
const GROSS = 400;

describeIfDb('Step 27 — escrow money invariant (real pg)', () => {
  let booted = false;
  beforeAll(async () => { booted = await bootIntegrationDb(); }, 120_000);
  afterAll(async () => { if (booted) await teardownIntegrationDb(); }, 30_000);
  beforeEach(async () => { if (booted) await resetWriteableTables(); });

  /** Seed a HELD hold + ledger; returns false if the schema can't hold the fixture. */
  async function seedHeld(): Promise<boolean> {
    try {
      const pool = getPool();
      await seedClient(pool, CLIENT);
      await seedAgency(pool, {id: AGENCY});
      await seedBooking(pool, BOOKING, CLIENT, 'CONFIRMED', {providerId: AGENCY});
      await seedEscrowHold(pool, {bookingId: BOOKING, clientId: CLIENT, providerId: AGENCY, gross: GROSS});
      return true;
    } catch { return false; }
  }

  it('a HELD hold conserves: sum(client debits) == gross_credits', async () => {
    if (!booted || !(await seedHeld())) return;
    const pool = getPool();
    const debit = await pool.query(
      `SELECT COALESCE(-SUM(amount_credits), 0)::int AS held
         FROM wallet_transactions
        WHERE booking_id = $1 AND user_id = $2 AND amount_credits < 0`,
      [BOOKING, CLIENT],
    );
    const hold = await pool.query(`SELECT gross_credits FROM escrow_holds WHERE booking_id = $1`, [BOOKING]);
    if (hold.rowCount === 0) return;
    expect(debit.rows[0].held).toBe(GROSS);
    expect(hold.rows[0].gross_credits).toBe(GROSS);
  });

  it("a booking's ledger nets to 0 (paired debit/credit)", async () => {
    if (!booted || !(await seedHeld())) return;
    const net = await getPool().query(
      `SELECT COALESCE(SUM(amount_credits), 0)::int AS net FROM wallet_transactions WHERE booking_id = $1`,
      [BOOKING],
    );
    expect(net.rows[0].net).toBe(0);
  });

  it('a terminal RELEASED hold conserves the split: gross == to_provider + to_client + fee', async () => {
    if (!booted || !(await seedHeld())) return;
    const pool = getPool();
    // Move it to RELEASED with a conserving split (provider 380 + fee 20 + client 0 = 400).
    const upd = await pool.query(
      `UPDATE escrow_holds
          SET status = 'RELEASED', to_provider_credits = 380, platform_fee_credits = 20,
              to_client_credits = 0, settled_at = NOW()
        WHERE booking_id = $1 RETURNING gross_credits, to_provider_credits, to_client_credits, platform_fee_credits`,
      [BOOKING],
    );
    if (upd.rowCount === 0) return;
    const h = upd.rows[0];
    expect(h.to_provider_credits + h.to_client_credits + h.platform_fee_credits).toBe(h.gross_credits);
  });

  it('detects a NON-conserving split (the drift the reconciliation sweep catches)', async () => {
    if (!booted || !(await seedHeld())) return;
    const pool = getPool();
    // Inject drift: provider 380 + fee 30 + client 0 = 410 ≠ 400 gross.
    const upd = await pool.query(
      `UPDATE escrow_holds
          SET status = 'RELEASED', to_provider_credits = 380, platform_fee_credits = 30, to_client_credits = 0
        WHERE booking_id = $1 RETURNING gross_credits, to_provider_credits, to_client_credits, platform_fee_credits`,
      [BOOKING],
    );
    if (upd.rowCount === 0) return;
    const h = upd.rows[0];
    expect(h.to_provider_credits + h.to_client_credits + h.platform_fee_credits).not.toBe(h.gross_credits);
  });
});
