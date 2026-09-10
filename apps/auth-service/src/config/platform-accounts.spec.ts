import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import configuration from './configuration';
import {SystemMessengerService} from '../ops/system-messenger.service';

/**
 * Step 3 — the platform escrow + fee wallet accounts. Their ids live in config
 * (configuration.platformAccounts) AND are seeded into wallet_balances by
 * 20260620000002_escrow_integrity.sql. This guards three invariants:
 *   1. both ids are well-formed and distinct;
 *   2. neither collides with the messenger SYSTEM actor (escrow money must never
 *      land on …0001);
 *   3. config and the migration seed stay in lock-step (drift guard).
 */
const MIGRATION_PATH = join(
  __dirname, '..', '..', '..', '..',
  'supabase', 'migrations', '20260620000002_escrow_integrity.sql',
);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('platform escrow / fee accounts (Step 3)', () => {
  const {escrowId, platformFeeId} = configuration().platformAccounts;

  it('exposes two well-formed, distinct account ids', () => {
    expect(escrowId).toMatch(UUID_RE);
    expect(platformFeeId).toMatch(UUID_RE);
    expect(escrowId).not.toBe(platformFeeId);
  });

  it('does not collide with the messenger SYSTEM actor', () => {
    expect(escrowId).not.toBe(SystemMessengerService.SYSTEM_USER_ID);
    expect(platformFeeId).not.toBe(SystemMessengerService.SYSTEM_USER_ID);
  });

  it('matches the wallet_balances seed in the migration (config ↔ DB drift guard)', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    expect(sql).toMatch(/INSERT INTO public\.wallet_balances/i);
    expect(sql).toContain(escrowId);
    expect(sql).toContain(platformFeeId);
    // both accounts must be seeded at 0 credits ('<id>', 0, …)
    const seededAtZero = (id: string) => new RegExp(`'${id}'\\s*,\\s*0\\s*,`);
    expect(sql).toMatch(seededAtZero(escrowId));
    expect(sql).toMatch(seededAtZero(platformFeeId));
  });

  // Part V §43 — proven once the escrow move + settlement land (Steps 9–11):
  it.todo('reconciliation: sum(client debits) == gross_credits, and gross_credits == to_provider + to_client + platform_fee at terminal');
});
