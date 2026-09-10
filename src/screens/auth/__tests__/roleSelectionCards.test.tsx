/**
 * Founder 2026-08-08 — "remove Operator Partner completely from Virtual
 * Bodyguard."
 *
 * VBG is a PERSONAL safety product; there is no roster of officers to onboard
 * under a master licence, so the provider funnel has no business on that path.
 * It must still be offered everywhere else — it is how a security company signs
 * up (D-5), not a plan the client chooses between, so a blanket removal would
 * be a different and much worse bug.
 *
 * Asserted by CALLING `cardsForProduct`, not by scanning source. The sibling
 * scan in `screens/booking/__tests__/productScopedPlans.test.ts` can only see
 * that the guard is written; only this can see what the screen would render.
 */
import {cardsForProduct} from '@screens/auth/RoleSelectionScreen';
import type {BravoProduct} from '@store/productStore';

const ids = (p: BravoProduct | null) => cardsForProduct(p).map(c => c.id);

describe('Operator Partner is not offered under Virtual Bodyguard', () => {
  it('vbg offers NO provider card', () => {
    expect(ids('vbg')).not.toContain('provider');
  });

  it('vbg still offers its own plans — the card was removed, not the screen', () => {
    // A guard that returned [] would also pass the assertion above.
    expect(ids('vbg').length).toBeGreaterThan(0);
  });

  it('removing the card removes its "WHAT YOU GET" sub-card with it', () => {
    // That block renders from `card.id === 'provider'`, so no card = no block.
    // Pinned because the founder asked for it gone COMPLETELY, and the
    // sub-card is the second half of what was on screen.
    expect(cardsForProduct('vbg').some(c => c.id === 'provider')).toBe(false);
  });

  it('every OTHER path keeps the funnel', () => {
    for (const p of ['messenger', 'secure'] as BravoProduct[]) {
      expect(ids(p)).toContain('provider');
    }
    // No product chosen yet (deep link / cold start) is not VBG — keep it.
    expect(ids(null)).toContain('provider');
  });

  it('the provider card is LAST wherever it appears', () => {
    for (const p of ['messenger', 'secure', null] as Array<BravoProduct | null>) {
      const list = ids(p);
      expect(list[list.length - 1]).toBe('provider');
    }
  });

  it('no path emits a duplicate card id', () => {
    for (const p of ['messenger', 'secure', 'vbg', null] as Array<BravoProduct | null>) {
      const list = ids(p);
      expect(new Set(list).size).toBe(list.length);
    }
  });

  it("'lite' — the screen's default selection — exists on every path", () => {
    // `useState<Choice>('lite')` must always name a card that renders, or the
    // screen opens with nothing selected and Continue acts on a phantom.
    for (const p of ['messenger', 'secure', 'vbg', null] as Array<BravoProduct | null>) {
      expect(ids(p)).toContain('lite');
    }
  });
});
