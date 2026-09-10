/**
 * F9 / PDF A2 + M2 — "the Professional plan must not appear in the Enterprise
 * onboarding route."
 *
 * `plansForProduct` IS the onboarding plan list: its only production caller is
 * `RoleSelectionScreen.cardsForProduct`, the pre-auth picker. The Enterprise
 * plan is sold on the messenger path, so that path is the Enterprise onboarding
 * route and the rule lands there.
 *
 * The function is pure, so this is a real unit test rather than a scan. The
 * second half is the part that matters most: it pins what the fix must NOT have
 * done. Filtering `PricingScreen` (Settings -> Pricing, where every user manages
 * their own plan) would strand live Pro subscribers with no current-plan row and
 * no downgrade path — the exact mistake the fit doc records being made once
 * already and reversed.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {
  plansForProduct,
  PRODUCT_PLANS,
  TIER_LABELS,
  TIER_FEATURES,
} from '../../pro/tierMatrix';

function code(rel: string[]): string {
  return readFileSync(join(process.cwd(), 'src', ...rel), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .split('\n')
    .filter(l => !l.trim().startsWith('//'))
    .join('\n');
}

describe('F9 — Professional is absent from the onboarding plan list', () => {
  it('the messenger onboarding route offers Lite and Enterprise, never Professional', () => {
    const titles = plansForProduct('messenger').map(p => p.title);
    expect(titles).toContain('Bravo Messenger Lite');
    expect(titles).toContain('Enterprise');
    expect(titles).not.toContain('Bravo Messenger Pro');
    expect(plansForProduct('messenger').some(p => p.tier === 'pro')).toBe(false);
  });

  it('an unknown / cold-start path cannot smuggle it back in', () => {
    // The fallback resolves to the messenger ladder, so the hidden-tier lookup
    // has to follow the same fallback. Looking it up under the raw argument
    // while falling back to the messenger LIST would return Professional here.
    for (const p of [null, undefined, 'nonsense' as unknown as 'messenger']) {
      expect(plansForProduct(p).some(x => x.tier === 'pro')).toBe(false);
    }
    expect(plansForProduct(null)).toEqual(plansForProduct('messenger'));
    expect(plansForProduct(undefined)).toEqual(plansForProduct('messenger'));
  });

  it('Bravo Secure Pro is untouched — a different product family, not this tier', () => {
    // lockedTerminology.test.ts keeps the two families apart; the A2 rule names
    // the MESSENGER Professional tier, and the Secure path's plan is the
    // request-and-approval protection plan.
    expect(plansForProduct('secure').map(p => p.title))
      .toEqual(['Bravo Secure Lite', 'Bravo Secure Pro']);
  });
});

describe('F9 — plan MANAGEMENT is not collateral damage', () => {
  it('the full catalogue still describes Professional', () => {
    // Only the onboarding VIEW narrows. A live Pro subscriber still has a plan
    // with a name and a feature list to render.
    expect(PRODUCT_PLANS.messenger.some(p => p.tier === 'pro')).toBe(true);
    expect(TIER_LABELS.pro).toBe('Bravo Messenger Pro');
    expect(TIER_FEATURES.pro.length).toBeGreaterThan(0);
  });

  it('Settings -> Pricing was NOT filtered', () => {
    // It reads TIER_LABELS / TIER_FEATURES — the maps above — and iterates all
    // three tiers. A `plansForProduct` import here would mean the onboarding
    // filter had leaked onto the plan-management screen.
    const pricing = code(['screens', 'settings', 'PricingScreen.tsx']);
    expect(pricing).toMatch(/TIER_LABELS/);
    expect(pricing).not.toMatch(/plansForProduct/);
    expect(pricing).not.toMatch(/ONBOARDING_HIDDEN/);
  });

  it('the paywall can still resolve a Pro purchase', () => {
    const paywall = code(['screens', 'pro', 'TierPaywall.tsx']);
    expect(paywall).toMatch(/TIER_LABELS/);
    expect(paywall).not.toMatch(/plansForProduct/);
  });
});
