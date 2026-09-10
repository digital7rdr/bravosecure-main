/**
 * Static source-scan regression for Issue 38 (Testing Issues V2, PDF p.43) —
 * "Agent and Service Provider Earnings Screens Incorrectly Offer Credit Top-Up".
 *
 * Agents and providers RECEIVE payouts here; they do not buy client services
 * from this screen. A "Top Up Credits" CTA sitting inside the earnings hero
 * conflates a payout balance with a client's purchasable Bravo Credits — the
 * PDF's requirement is that top-up appears only in the authorised client wallet
 * and that the two balances can never be mixed.
 *
 * These are RN screens the node `booking` project cannot import, so the rule is
 * pinned by reading the source.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = process.cwd();

const EARNINGS_SCREENS = [
  ['EarningsScreen (agent/CPO)', join(ROOT, 'src', 'screens', 'agent', 'EarningsScreen.tsx')],
  ['OrgEarningsScreen (provider)', join(ROOT, 'src', 'screens', 'agent', 'OrgEarningsScreen.tsx')],
] as const;

/** CRLF-normalised, comments stripped — prose about top-up must not fail a
 *  CODE assertion, and a `\n`-anchored regex would match nothing on CRLF. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('Issue 38 — earnings screens never offer a client credit top-up', () => {
  it.each(EARNINGS_SCREENS)('%s has no top-up CTA', (_label, file) => {
    const src = code(file);
    expect(src).not.toMatch(/Top\s*Up\s*Credits/i);
    // The route that opens the client purchase flow.
    expect(src).not.toMatch(/tab:\s*'topup'/);
  });

  it.each(EARNINGS_SCREENS)('%s does not navigate to the client Credits screen', (_label, file) => {
    expect(code(file)).not.toMatch(/navigate\('Credits'/);
  });

  it('EarningsScreen labels the hero as EARNED, not a generic wallet balance', () => {
    const src = code(join(ROOT, 'src', 'screens', 'agent', 'EarningsScreen.tsx'));
    // "WALLET BALANCE" reads as the same purchasable balance a client tops up.
    expect(src).not.toContain('WALLET BALANCE');
    expect(src).toContain('EARNED BALANCE');
  });

  it('EarningsScreen still shows payout history — removing top-up must not strip the ledger', () => {
    const src = code(join(ROOT, 'src', 'screens', 'agent', 'EarningsScreen.tsx'));
    expect(src).toContain('RECENT PAYOUTS');
    expect(src).toMatch(/type === 'payout'/);
  });

  it('the client wallet KEEPS its top-up — the entitlement is role-scoped, not removed', () => {
    const src = code(join(ROOT, 'src', 'screens', 'wallet', 'CreditsScreen.tsx'));
    expect(src).toMatch(/topUp|topup/i);
  });
});
