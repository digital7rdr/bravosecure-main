/**
 * Issue 22 (Testing Issues V2, PDF p.27) — "Secure Services Onboarding Displays
 * Messenger Plans and Features".
 *
 * RoleSelectionScreen rendered ONE global card list built from the messenger
 * tier matrix, regardless of which product card the user tapped on Onboarding.
 * Entering through Secure Services offered "Group Chats" and "Voice and Video
 * Calls (up to 10 people)" and never mentioned booking a detail.
 *
 * PDF p.5 locks one plan pair per product family. plansForProduct() is pure, so
 * this is a real unit test; a source scan then pins that the screen actually
 * uses it.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {
  plansForProduct,
  LITE_FEATURES,
  SECURE_LITE_FEATURES,
} from '../../pro/tierMatrix';

describe('Issue 22 — plans are scoped to the chosen product path', () => {
  it('Secure Services offers exactly Bravo Secure Lite and Bravo Secure Pro', () => {
    expect(plansForProduct('secure').map(p => p.title))
      .toEqual(['Bravo Secure Lite', 'Bravo Secure Pro']);
  });

  it('Messenger offers the locked Messenger names', () => {
    const titles = plansForProduct('messenger').map(p => p.title);
    expect(titles).toContain('Bravo Messenger Lite');
    // F9 / PDF A2 + M2 — "Professional must not appear in the Enterprise
    // onboarding route", and this function IS the onboarding plan list. The
    // assertion here used to be `toContain('Bravo Messenger Pro')`; it was
    // inverted deliberately, not deleted, so the rule stays pinned in the suite
    // that owns product-scoped plans. The full catalogue still describes
    // Professional for Settings -> Pricing and the paywall —
    // `src/screens/deptchat/__tests__/onboardingPlanScope.test.ts` pins that
    // half, including that neither screen imports this function.
    expect(titles).not.toContain('Bravo Messenger Pro');
    expect(titles).not.toContain('Bravo Secure Pro');
    // Issue 22's own point still holds: this path carries the MESSENGER family
    // names and offers more than one plan.
    expect(titles.length).toBeGreaterThan(1);
  });

  it('no path advertises another family\'s plan', () => {
    for (const title of plansForProduct('secure').map(p => p.title)) {
      expect(title).not.toMatch(/Messenger/);
    }
    for (const title of plansForProduct('messenger').map(p => p.title)) {
      expect(title).not.toMatch(/Bravo Secure/);
    }
  });

  it('Secure Services features describe BOOKING, not messaging', () => {
    const feats = plansForProduct('secure')[0].features;
    expect(feats).toEqual(SECURE_LITE_FEATURES);
    // The exact strings the tester saw under a Secure Services heading.
    expect(feats).not.toContain('Group Chats');
    expect(feats).not.toContain('Voice and Video Calls (up to 10 people)');
    expect(feats.some(f => /book/i.test(f))).toBe(true);
  });

  it('Messenger keeps the approved M1A tier matrix untouched', () => {
    expect(plansForProduct('messenger')[0].features).toEqual(LITE_FEATURES);
  });

  it('Enterprise belongs to the Messenger/Department path only', () => {
    // Department Channels is a SEPARATE product (PDF p.5) — it must not be sold
    // as a tier of Secure Services.
    expect(plansForProduct('secure').some(p => p.tier === 'enterprise')).toBe(false);
    expect(plansForProduct('messenger').some(p => p.tier === 'enterprise')).toBe(true);
  });

  it('every plan keeps a tier id the signup + paywall understand', () => {
    for (const product of ['secure', 'messenger', 'vbg'] as const) {
      for (const plan of plansForProduct(product)) {
        expect(['lite', 'pro', 'enterprise']).toContain(plan.tier);
        expect(plan.features.length).toBeGreaterThan(0);
        expect(plan.eyebrow.length).toBeGreaterThan(0);
      }
    }
  });

  it('an unknown path falls back to Messenger rather than rendering nothing', () => {
    expect(plansForProduct(null)).toEqual(plansForProduct('messenger'));
    expect(plansForProduct(undefined)).toEqual(plansForProduct('messenger'));
  });
});

describe('Issue 22 — the screen actually consumes the scoped list', () => {
  const SCREEN = join(process.cwd(), 'src', 'screens', 'auth', 'RoleSelectionScreen.tsx');

  function code(): string {
    const src = readFileSync(SCREEN, 'utf8').replace(/\r\n/g, '\n');
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

  it('reads pendingProduct and renders the derived cards', () => {
    const src = code();
    expect(src).toMatch(/useProductStore\(st => st\.pendingProduct\)/);
    expect(src).toMatch(/cardsForProduct\(pendingProduct\)/);
    expect(src).toMatch(/\{cards\.map\(card =>/);
  });

  it('no longer hard-codes a single global CARDS list', () => {
    const src = code();
    expect(src).not.toMatch(/const CARDS(:|\s*=)/);
    // The messenger feature lists must not be imported here any more — that
    // import IS the bug: it bound onboarding to one product's copy.
    expect(src).not.toMatch(/import \{[^}]*LITE_FEATURES/);
  });

  /**
   * RE-POINTED 2026-08-08, not deleted. This used to assert "every path".
   * Founder: Virtual Bodyguard is a personal safety product with no officer
   * roster, so the Operator Partner funnel is removed from that path only.
   * The behaviour is pinned by `roleSelectionCards.test.tsx` in the app
   * project, which calls `cardsForProduct` for real; this keeps the SOURCE
   * shape honest for the paths that must still offer it.
   */
  it('the Operator Partner funnel stays reachable on every path EXCEPT vbg', () => {
    const src = code();
    expect(src).toContain('PROVIDER_CARD');
    expect(src).toMatch(/return \[\.\.\.plans, PROVIDER_CARD\]/);
    // The vbg guard must come BEFORE the append, or it can never take effect.
    const guard = src.search(/if \(product === 'vbg'\) \{return plans;\}/);
    const append = src.search(/return \[\.\.\.plans, PROVIDER_CARD\]/);
    expect(guard).toBeGreaterThan(-1);
    expect(append).toBeGreaterThan(guard);
  });

  it('Onboarding still records the tapped product BEFORE navigating here', () => {
    const onboarding = readFileSync(
      join(process.cwd(), 'src', 'screens', 'auth', 'OnboardingScreen.tsx'), 'utf8',
    ).replace(/\r\n/g, '\n');
    const idx = onboarding.indexOf('setPendingProduct(SERVICE_PRODUCT[key])');
    expect(idx).toBeGreaterThan(-1);
    // Order matters: navigating first would render the cards before the store
    // knows which product was chosen.
    expect(onboarding.indexOf("navigate('RoleSelection')")).toBeGreaterThan(idx);
  });
});
