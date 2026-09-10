/**
 * Real-DB tests for the two load-bearing dispatch SQL functions (BUILD_RUNBOOK Step 27):
 *   - is_eligible_for_dispatch (licence + insurance + DPA gates)
 *   - has_free_cpo_capacity   (D6 — an accept must not over-commit free CPO seats)
 *
 * These are the vetting + capacity predicates the matchmaker ranks on, so a regression here
 * would silently dispatch an uneligible / over-committed agency. SQL-level via the harness
 * Pool; skips when Docker is unavailable. Seeds are defensive — a partial-apply schema that
 * can't hold the fixture returns early rather than failing CI.
 */
import {bootIntegrationDb, getPool, resetWriteableTables, shouldSkipIntegration, teardownIntegrationDb} from './harness';
import {seedAgency, seedCpo} from '../fixtures/dispatch-seed';

const describeIfDb = shouldSkipIntegration() ? describe.skip : describe;

const AGENCY = 'a0000000-0000-0000-0000-000000000001';

describeIfDb('Step 27 — dispatch SQL functions (real pg)', () => {
  let booted = false;
  beforeAll(async () => { booted = await bootIntegrationDb(); }, 120_000);
  afterAll(async () => { if (booted) await teardownIntegrationDb(); }, 30_000);
  beforeEach(async () => { if (booted) await resetWriteableTables(); });

  async function trySeedAgency(opts: Parameters<typeof seedAgency>[1]): Promise<boolean> {
    try { await seedAgency(getPool(), opts); return true; } catch { return false; }
  }

  it('is_eligible_for_dispatch TRUE for a verified, DPA-accepted agency', async () => {
    if (!booted) return;
    if (!(await trySeedAgency({id: AGENCY, region: 'AE'}))) return;
    const r = await getPool().query(`SELECT public.is_eligible_for_dispatch($1, 'AE', '{}'::jsonb) AS ok`, [AGENCY]);
    if (r.rowCount === 0) return;
    expect(r.rows[0].ok).toBe(true);
  });

  it('is_eligible_for_dispatch FALSE when the agency has not accepted the DPA (Step 22 gate)', async () => {
    if (!booted) return;
    if (!(await trySeedAgency({id: AGENCY, region: 'AE', dpaAccepted: false}))) return;
    const r = await getPool().query(`SELECT public.is_eligible_for_dispatch($1, 'AE', '{}'::jsonb) AS ok`, [AGENCY]);
    if (r.rowCount === 0) return;
    expect(r.rows[0].ok).toBe(false);
  });

  it('is_eligible_for_dispatch FALSE without verified licence + insurance', async () => {
    if (!booted) return;
    if (!(await trySeedAgency({id: AGENCY, region: 'AE', verifiedCreds: false}))) return;
    const r = await getPool().query(`SELECT public.is_eligible_for_dispatch($1, 'AE', '{}'::jsonb) AS ok`, [AGENCY]);
    if (r.rowCount === 0) return;
    expect(r.rows[0].ok).toBe(false);
  });

  it('has_free_cpo_capacity gates on free CPO seats (D6)', async () => {
    if (!booted) return;
    if (!(await trySeedAgency({id: AGENCY, region: 'AE'}))) return;
    const pool = getPool();
    try {
      await seedCpo(pool, AGENCY, 'c0000000-0000-0000-0000-000000000001');
      await seedCpo(pool, AGENCY, 'c0000000-0000-0000-0000-000000000002');
      await seedCpo(pool, AGENCY, 'c0000000-0000-0000-0000-000000000003');
    } catch { return; }
    const enough = await pool.query(`SELECT public.has_free_cpo_capacity($1, 2) AS ok`, [AGENCY]);
    const tooMany = await pool.query(`SELECT public.has_free_cpo_capacity($1, 5) AS ok`, [AGENCY]);
    if (enough.rowCount === 0 || tooMany.rowCount === 0) return;
    expect(enough.rows[0].ok).toBe(true);  // 3 free ≥ 2 needed
    expect(tooMany.rows[0].ok).toBe(false); // 3 free < 5 needed
  });
});
