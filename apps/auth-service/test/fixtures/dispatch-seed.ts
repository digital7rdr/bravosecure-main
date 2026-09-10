/**
 * Reusable dispatch test fixtures (BUILD_RUNBOOK Step 27).
 *
 * Hand-inserts the rows the dispatch engine ranks + charges over — an eligible on-duty
 * agency (verified licence + insurance + accepted DPA), its managed CPOs, a client with a
 * wallet, a booking, and an escrow hold + paired ledger. These unblock the SQL-function
 * tests (is_eligible_for_dispatch / has_free_cpo_capacity) and the money-invariant test,
 * and mirror the seed the 3-device smoke (Step 28) needs.
 *
 * Pure SQL via a pg Pool (the integration harness gives a Pool, not the Nest app). Every
 * insert is idempotent (ON CONFLICT) so a fixture can be layered. Synthetic coords only.
 */
import type {Pool} from 'pg';

/** A client user + a funded wallet so accept() can charge into escrow. */
export async function seedClient(pool: Pool, id: string, credits = 100_000): Promise<void> {
  await pool.query(
    `INSERT INTO public.users (id, email, role, subscription_tier)
     VALUES ($1, $2, 'individual', 'lite') ON CONFLICT (id) DO NOTHING`,
    [id, `${id}@test.local`],
  );
  await pool.query(
    `INSERT INTO public.wallet_balances (user_id, bravo_credits, currency)
     VALUES ($1, $2, 'AED') ON CONFLICT (user_id) DO UPDATE SET bravo_credits = EXCLUDED.bravo_credits`,
    [id, credits],
  );
}

/**
 * An on-duty, dispatch-eligible agency: an ACTIVE company agent in a region with a verified
 * non-expired licence + insurance and an accepted DPA. `eligible:false` omits the DPA so the
 * eligibility gate fails (for the negative test).
 */
export async function seedAgency(
  pool: Pool,
  opts: {id: string; region?: string; dpaAccepted?: boolean; verifiedCreds?: boolean},
): Promise<void> {
  const {id, region = 'AE', dpaAccepted = true, verifiedCreds = true} = opts;
  await pool.query(
    `INSERT INTO public.users (id, email, role, subscription_tier)
     VALUES ($1, $2, 'agent', 'lite') ON CONFLICT (id) DO NOTHING`,
    [id, `${id}@agency.local`],
  );
  await pool.query(
    `INSERT INTO agents (user_id, type, status, on_duty, region_code, dpa_accepted_at)
     VALUES ($1, 'company', 'ACTIVE', TRUE, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET
       type = 'company', status = 'ACTIVE', on_duty = TRUE,
       region_code = EXCLUDED.region_code, dpa_accepted_at = EXCLUDED.dpa_accepted_at`,
    [id, region, dpaAccepted ? new Date() : null],
  );
  if (verifiedCreds) {
    for (const kind of ['licence', 'insurance']) {
      await pool.query(
        `INSERT INTO public.compliance_credentials
           (subject_user_id, subject_kind, kind, region_code, verified, expires_at)
         VALUES ($1, 'agency', $2, $3, TRUE, NOW() + INTERVAL '1 year')
         ON CONFLICT DO NOTHING`,
        [id, kind, region],
      );
    }
  }
}

/** A managed CPO (active org_members edge) so has_free_cpo_capacity counts a free seat. */
export async function seedCpo(pool: Pool, agencyId: string, cpoId: string): Promise<void> {
  await pool.query(
    `INSERT INTO public.users (id, email, role, subscription_tier)
     VALUES ($1, $2, 'agent', 'lite') ON CONFLICT (id) DO NOTHING`,
    [cpoId, `${cpoId}@cpo.local`],
  );
  await pool.query(
    `INSERT INTO agents (user_id, type, status, managed_by_org_id)
     VALUES ($1, 'cpo', 'ACTIVE', $2) ON CONFLICT (user_id) DO NOTHING`,
    [cpoId, agencyId],
  );
  await pool.query(
    `INSERT INTO org_members (org_user_id, member_user_id, member_role, status)
     VALUES ($1, $2, 'cpo', 'active') ON CONFLICT (org_user_id, member_user_id) DO NOTHING`,
    [agencyId, cpoId],
  );
}

/** A booking in a given state. Returns the booking id. */
export async function seedBooking(
  pool: Pool, id: string, clientId: string, status: string, opts: {region?: string; providerId?: string} = {},
): Promise<string> {
  const {region = 'AE', providerId = null} = opts;
  await pool.query(
    `INSERT INTO lite_bookings (id, client_id, status, dispatch_mode, assigned_provider_user_id,
       region_code, region_label, service, booking_mode, pickup_time, pickup_address,
       passengers, cpo_count, vehicle_count, driver_only, add_ons,
       rate_eur_per_hour, rate_aed_per_hour, duration_hours, total_eur, total_aed, payment_method)
     VALUES ($1, $2, $3, 'auto', $4, $5, 'UAE', 'secure_transfer', 'now',
       NOW() + INTERVAL '6 hours', 'X', 1, 1, 1, FALSE, '[]'::jsonb,
       100, 400, 4, 400, 1600, 'bravo_credits')
     ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status`,
    [id, clientId, status, providerId, region],
  );
  return id;
}

/**
 * A HELD escrow hold + the paired ledger debit (client → escrow account) for a booking, so
 * the money-invariant test has a conserved baseline to assert + perturb.
 */
export async function seedEscrowHold(
  pool: Pool, opts: {bookingId: string; clientId: string; providerId: string; gross: number; status?: string},
): Promise<void> {
  const {bookingId, clientId, providerId, gross, status = 'HELD'} = opts;
  await pool.query(
    `INSERT INTO public.escrow_holds (booking_id, client_id, provider_user_id, gross_credits, currency, status)
     VALUES ($1, $2, $3, $4, 'AED', $5)
     ON CONFLICT (booking_id) DO UPDATE SET status = EXCLUDED.status, gross_credits = EXCLUDED.gross_credits`,
    [bookingId, clientId, providerId, gross, status],
  );
  // Paired ledger: client debited, escrow account credited (net 0 for the booking).
  const ESCROW_ACCT = '00000000-0000-0000-0000-0000000000e5';
  await pool.query(
    `INSERT INTO public.wallet_transactions (user_id, booking_id, type, amount_credits, status)
     VALUES ($1, $2, 'escrow_hold', $3, 'succeeded'),
            ($4, $2, 'escrow_hold', $5, 'succeeded')`,
    [clientId, bookingId, -gross, ESCROW_ACCT, gross],
  );
}
