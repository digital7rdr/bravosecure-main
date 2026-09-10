/**
 * Static source-scan regression for Issue 28 (Testing Issues V2, PDF p.33) —
 * "Provider or Referral Code Is Missing from the Booking Flow".
 *
 * The SECURITY property matters more than the feature here. The PDF is explicit:
 * "Confirm a code never bypasses availability, licensing or operator approval."
 * So this is ATTRIBUTION ONLY — validated, recorded, surfaced to ops, and read
 * by nothing in dispatch. The assertions below are mostly about proving that
 * boundary is intact, because a future "preferred provider" tweak is exactly how
 * it would get crossed.
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

const SERVICE = 'apps/auth-service/src/booking/booking.service.ts';
const SCREEN = 'src/screens/booking/CustomizeAddOnsScreen.tsx';
const MIGRATION = 'supabase/migrations/20260725140000_provider_referral_codes.sql';

describe('Issue 28 — the code is captured and attributed', () => {
  it('a table exists, keyed on an owner OR an external partner', () => {
    const sql = readFileSync(join(ROOT, MIGRATION), 'utf8');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS provider_referral_codes/);
    expect(sql).toMatch(/owner_user_id IS NOT NULL OR partner_name IS NOT NULL/);
    expect(sql).toMatch(/expires_at\s+TIMESTAMPTZ/);
    expect(sql).toMatch(/active\s+BOOLEAN NOT NULL DEFAULT TRUE/);
  });

  it('the booking stores the code AS SUBMITTED, not only the FK', () => {
    // A deactivated or renamed code row must not rewrite history.
    const sql = readFileSync(join(ROOT, MIGRATION), 'utf8');
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS referral_code\s+TEXT/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS referral_code_id UUID/);
    expect(code(SERVICE)).toMatch(/referral_code, referral_code_id/);
  });

  it('a blank code is fine; an unknown / inactive / expired one is REJECTED', () => {
    const src = code(SERVICE);
    const start = src.indexOf('private async resolveReferralCode');
    expect(start).toBeGreaterThan(-1);
    const fn = src.slice(start, src.indexOf('\n  }', start));
    expect(fn).toMatch(/if \(!code\) return null;/);
    expect(fn).toMatch(/active = TRUE/);
    expect(fn).toMatch(/expires_at IS NULL OR expires_at > NOW\(\)/);
    expect(fn).toMatch(/referral_code_invalid/);
  });

  it('lookup is case-insensitive without a functional index', () => {
    expect(code(SERVICE)).toMatch(/\(raw \?\? ''\)\.trim\(\)\.toUpperCase\(\)/);
  });

  it('the redemption counter can never fail the booking', () => {
    const src = code(SERVICE);
    const start = src.indexOf('redeemed_count = redeemed_count + 1');
    expect(start).toBeGreaterThan(-1);
    expect(src.slice(start, start + 200)).toMatch(/\.catch\(/);
  });

  it('B-404: the counter bumps AFTER the booking insert, never at validation', () => {
    // A bump at validation time counted redemptions for bookings whose INSERT
    // then failed (e.g. any later throw in createBooking), skewing partner
    // reporting. The bump must sit after the lite_bookings insert, guarded on
    // the resolved referral — and resolveReferralCode itself must stay pure.
    const src = code(SERVICE);
    const insertAt = src.indexOf('INSERT INTO lite_bookings');
    const bumpAt = src.indexOf('redeemed_count = redeemed_count + 1');
    const resolveAt = src.indexOf('private async resolveReferralCode');
    expect(insertAt).toBeGreaterThan(-1);
    // The bump must live in createBooking's post-insert region — after the
    // insert AND before resolveReferralCode's definition, so a bump parked
    // anywhere inside/after the resolver cannot satisfy this vacuously.
    expect(bumpAt).toBeGreaterThan(insertAt);
    expect(bumpAt).toBeLessThan(resolveAt);
    const fn = src.slice(resolveAt, src.indexOf('\n  }', resolveAt));
    expect(fn).not.toMatch(/redeemed_count/);
  });
});

describe('B-404 — the write side exists (codes can actually be minted)', () => {
  // The read side shipped 2026-07-25 validating against a table NOTHING could
  // populate, so every non-blank code failed with referral_code_invalid.
  // These pins keep the mint/deactivate surface from being dropped again.
  const WRITE_SERVICE = 'apps/auth-service/src/ops/referral-codes.service.ts';
  const WRITE_CONTROLLER = 'apps/auth-service/src/ops/referral-codes.controller.ts';

  it('ops can mint and deactivate codes, behind the config-surface role gate', () => {
    const svc = code(WRITE_SERVICE);
    expect(svc).toMatch(/INSERT INTO provider_referral_codes/);
    expect(svc).toMatch(/UPDATE provider_referral_codes\s*SET active/);
    const ctrl = code(WRITE_CONTROLLER);
    expect(ctrl).toMatch(/@Controller\('ops\/referral-codes'\)/);
    // Anchor the gate to EACH mutating handler — a single unanchored match
    // would stay green if the decorator were dropped from one of them.
    expect(ctrl).toMatch(/@Post\(\)\s*@RequireRoles\('SUPERVISOR', 'ADMIN'\)/);
    expect(ctrl).toMatch(/@Patch\(':id\/active'\)\s*@HttpCode\(200\)\s*@RequireRoles\('SUPERVISOR', 'ADMIN'\)/);
  });

  it('the controller is registered, so the routes are live', () => {
    // Anchor inside the controllers array — the import line alone stays
    // matchable after the entry is removed (the CLAUDE.md postMode trap).
    expect(code('apps/auth-service/src/ops/ops.module.ts'))
      .toMatch(/controllers:\s*\[[^\]]*ReferralCodesController/);
  });

  it('mint stores upper-case, matching the booking-side lookup', () => {
    expect(code(WRITE_SERVICE)).toMatch(/\.trim\(\)\.toUpperCase\(\)/);
  });

  it('the console page is wired into the api and the nav', () => {
    expect(code('apps/ops-console/src/lib/api.ts')).toMatch(/\/ops\/referral-codes/);
    expect(code('apps/ops-console/src/app/referral-codes/page.tsx'))
      .toMatch(/createReferralCode/);
    expect(code('apps/ops-console/src/components/Shell.tsx')).toMatch(/'\/referral-codes'/);
  });

  it('the write side never touches dispatch, the cascade or escrow', () => {
    // Same boundary as the read side: attribution only.
    const svc = code(WRITE_SERVICE);
    expect(svc).not.toMatch(/dispatch|cascade|escrow|rank/i);
  });
});

describe('Issue 28 — the code NEVER influences dispatch', () => {
  it('is resolved as attribution only, and nothing dispatch-side reads it', () => {
    // The PDF's hard constraint. If a future change wants preferred assignment,
    // it must be a separate, separately-approved commit — not a quiet edit here.
    for (const rel of [
      'apps/auth-service/src/dispatch/dispatch.service.ts',
      'apps/auth-service/src/booking/assignment/cpo-assignment.service.ts',
      'apps/auth-service/src/booking/assignment/vehicle-pool.service.ts',
    ]) {
      expect(code(rel)).not.toMatch(/referral_code/);
    }
  });

  it('the escrow / wallet path does not read it either', () => {
    expect(code('apps/auth-service/src/wallet/wallet.service.ts')).not.toMatch(/referral_code/);
  });
});

describe('Issue 28 — the client field', () => {
  it('sits on the booking flow before final submission', () => {
    const src = code(SCREEN);
    expect(src).toContain('Provider / referral code (optional)');
    expect(src).toMatch(/value=\{referralCode\}/);
  });

  it('accepts only identifier characters, matching the server DTO', () => {
    expect(code(SCREEN)).toMatch(/replace\(\/\[\^A-Z0-9-\]\/g, ''\)/);
    expect(code('apps/auth-service/src/booking/dto/create-booking.dto.ts'))
      .toMatch(/\^\[A-Za-z0-9\]\[A-Za-z0-9-\]\*\$/);
  });

  it('blank submits as ABSENT, never an empty string', () => {
    expect(code('src/store/bookingStore.ts'))
      .toMatch(/referral_code: draft\.referral_code\.trim\(\) \|\| undefined/);
  });

  it('tells the user plainly that it does not change assignment', () => {
    expect(code(SCREEN)).toMatch(/does not\s*\n?\s*change availability or who is assigned/);
  });

  it('a typed code marks the draft dirty, so it is not silently lost', () => {
    expect(code('src/store/bookingStore.ts')).toMatch(/d\.referral_code !== ''/);
  });
});
