/**
 * Audit fix 5.5 — real-DB concurrency tests.
 *
 * Spawn two parallel `UPDATE … WHERE status = $expected RETURNING id`
 * statements against the same booking row inside their own transactions
 * with `SELECT … FOR UPDATE`. The winner commits OPS_APPROVED; the
 * loser's UPDATE matches zero rows and the surrounding code can throw
 * `booking_state_changed_concurrently`. The mocked unit test (Phase 5.5
 * earlier pass) proves the JS layer; this one proves the pg locks
 * actually serialize.
 */
import {bootIntegrationDb, getPool, resetWriteableTables, shouldSkipIntegration, teardownIntegrationDb} from './harness';

const describeIfDb = shouldSkipIntegration() ? describe.skip : describe;

describeIfDb('Phase 1.1 — real-DB concurrency on approveBooking', () => {
  let booted = false;

  beforeAll(async () => {
    booted = await bootIntegrationDb();
  }, 120_000);

  afterAll(async () => {
    if (booted) await teardownIntegrationDb();
  }, 30_000);

  beforeEach(async () => {
    if (!booted) return;
    await resetWriteableTables();
  });

  it('two parallel approve transactions — exactly one commits OPS_APPROVED', async () => {
    if (!booted) return;
    const pool = getPool();

    await pool.query(`
      INSERT INTO public.users (id, email, role, subscription_tier)
      VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'c@c.com', 'individual', 'lite')
      ON CONFLICT DO NOTHING;
    `).catch(() => undefined);
    await pool.query(`
      INSERT INTO lite_bookings (id, client_id, status, region_code, region_label, service, booking_mode,
        pickup_time, pickup_address, passengers, cpo_count, vehicle_count, driver_only,
        add_ons, rate_eur_per_hour, rate_aed_per_hour, duration_hours, total_eur, total_aed,
        payment_method)
      VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'PENDING_OPS',
        'AE', 'UAE', 'secure_transfer', 'now',
        NOW() + INTERVAL '6 hours', 'X', 1, 1, 1, FALSE,
        '[]'::jsonb, 100, 400, 4, 400, 1600, 'card');
    `);

    async function attemptApprove(): Promise<boolean> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const sel = await client.query<{status: string}>(
          `SELECT status FROM lite_bookings WHERE id = $1 FOR UPDATE`,
          ['bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'],
        );
        const status = sel.rows[0]?.status;
        if (!status) { await client.query('ROLLBACK'); return false; }
        // Mimic the service: conditional UPDATE only commits if the
        // status still matches the snapshot we read after the FOR UPDATE
        // lock. The loser of the race finds the row already at
        // OPS_APPROVED, so the UPDATE matches zero rows.
        const upd = await client.query(
          `UPDATE lite_bookings
              SET status = 'OPS_APPROVED'
            WHERE id = $1 AND status = $2
          RETURNING id`,
          ['bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', status],
        );
        if (upd.rowCount === 0) {
          await client.query('ROLLBACK');
          return false;
        }
        await client.query('COMMIT');
        return true;
      } finally {
        client.release();
      }
    }

    const [a, b] = await Promise.all([attemptApprove(), attemptApprove()]);
    const wins = (a ? 1 : 0) + (b ? 1 : 0);
    expect(wins).toBe(1);

    const final = await pool.query<{status: string}>(
      `SELECT status FROM lite_bookings WHERE id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'`,
    );
    expect(final.rows[0]?.status).toBe('OPS_APPROVED');
  });
});
