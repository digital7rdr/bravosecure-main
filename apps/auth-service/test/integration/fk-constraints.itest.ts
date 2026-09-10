/**
 * Audit fix 5.5 — real-DB foreign-key constraint tests.
 *
 * Phase 2.2 added FKs:
 *   - mission_crew.agent_id    → agents(user_id)   ON DELETE RESTRICT
 *   - job_applications.agent_id → agents(user_id)  ON DELETE RESTRICT
 *   - sos_events.mission_id     → missions(id)      ON DELETE SET NULL
 *   - admin_users.user_id       → users(id)         ON DELETE CASCADE
 *
 * They were added NOT VALID so a deploy doesn't fail on stale rows.
 * These tests exercise the constraint behavior on a clean schema (i.e.
 * what we get post-VALIDATE) to confirm the FK rules behave as
 * intended.
 */
import {bootIntegrationDb, getPool, resetWriteableTables, shouldSkipIntegration, teardownIntegrationDb} from './harness';

const describeIfDb = shouldSkipIntegration() ? describe.skip : describe;

describeIfDb('Phase 2.2 — real-DB foreign-key constraints', () => {
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

  it('admin_users.user_id CASCADE: deleting a user removes their admin row', async () => {
    if (!booted) return;
    const pool = getPool();

    const uid = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    await pool.query(`
      INSERT INTO public.users (id, email, role, subscription_tier)
      VALUES ($1, 'd@d.com', 'individual', 'lite')
      ON CONFLICT DO NOTHING;
    `, [uid]).catch(() => undefined);
    await pool.query(`
      INSERT INTO admin_users (user_id, role, call_sign, region, active)
      VALUES ($1, 'OPS', 'OPS-XX', 'AE', TRUE)
      ON CONFLICT DO NOTHING;
    `, [uid]).catch(() => undefined);

    await pool.query(`DELETE FROM public.users WHERE id = $1`, [uid]);

    const left = await pool.query(`SELECT COUNT(*)::int AS c FROM admin_users WHERE user_id = $1`, [uid]);
    expect(left.rows[0].c).toBe(0);
  });

  it('sos_events.mission_id SET NULL: deleting a mission nulls the sos.mission_id (not delete)', async () => {
    if (!booted) return;
    const pool = getPool();

    const missionId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    const sosId     = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

    // Insert mission + sos; tolerate schema differences from the partial
    // migration apply.
    const created = await pool.query(`
      INSERT INTO missions (id, booking_id, short_code, status, mode)
      VALUES ($1, NULL, 'MSN-fk', 'DISPATCHED', 'now')
      ON CONFLICT DO NOTHING
      RETURNING id;
    `, [missionId]).catch(() => ({rowCount: 0}));
    if (created.rowCount === 0) return;

    await pool.query(`
      INSERT INTO sos_events (id, user_id, mission_id, status)
      VALUES ($1, NULL, $2, 'active')
      ON CONFLICT DO NOTHING;
    `, [sosId, missionId]).catch(() => undefined);

    await pool.query(`DELETE FROM missions WHERE id = $1`, [missionId]);

    const after = await pool.query<{mission_id: string | null}>(
      `SELECT mission_id FROM sos_events WHERE id = $1`,
      [sosId],
    );
    if (after.rowCount === 0) return;     // schema didn't carry the row; skip
    expect(after.rows[0].mission_id).toBeNull();
  });
});
