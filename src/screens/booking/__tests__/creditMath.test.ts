import {
  BC_PER_USD,
  bcToUsd,
  shortfallFor,
  afterBalanceFor,
  buildPackages,
  recommendPackageKey,
} from '../creditMath';

describe('credit math — the 1:1 peg (CREDITS_BC_AUDIT F-02)', () => {
  it('bcToUsd holds 1 fiat unit = 1 BC', () => {
    expect(BC_PER_USD).toBe(1);
    expect(bcToUsd(10)).toBe(10);
    expect(bcToUsd(1000)).toBe(1000);
    expect(bcToUsd(0)).toBe(0);
  });

  it.each([
    [500, 500],
    [1000, 1000],
    [1500, 1500],
    [2500, 2500],
  ])('bcToUsd(%i) = $%i', (bc, usd) => {
    expect(bcToUsd(bc)).toBe(usd);
  });

  it('every package charges exactly its credits (client promise == server award)', () => {
    // Server mirror: WalletService.computeCreditsForFiat = round(amount).
    for (const p of buildPackages(1880)) {
      expect(Math.round(p.priceUsd)).toBe(p.credits);
    }
  });
});

describe('credit math — shortfall calculation', () => {
  it.each([
    // [required, balance, expectedShortfall]
    [1880, 0,    1880],  // zero balance
    [1880, 500,  1380],  // partial
    [1880, 1880, 0],     // exact
    [1880, 2000, 0],     // surplus — never negative
    [1880, 9999, 0],     // huge surplus
    [0,    0,    0],     // trivial zero required
    [0,    500,  0],     // no booking needed
    [1,    0,    1],     // min required
  ])('required=%i balance=%i → shortfall=%i', (req, bal, expected) => {
    expect(shortfallFor(req, bal)).toBe(expected);
  });
});

describe('credit math — afterBalance', () => {
  it('sums current balance + package credits', () => {
    expect(afterBalanceFor(0,    500)).toBe(500);
    expect(afterBalanceFor(500,  1000)).toBe(1500);
    expect(afterBalanceFor(100,  2500)).toBe(2600);
  });
});

describe('credit math — buildPackages', () => {
  const pkgs = buildPackages(1880);

  it('returns the four Phase-1 SKUs in ascending order', () => {
    expect(pkgs.map(p => p.key)).toEqual(['500', '1000', '1500', '2500']);
    expect(pkgs.map(p => p.credits)).toEqual([500, 1000, 1500, 2500]);
  });

  it('prices every SKU at the flat 1-fiat-unit-per-BC peg (no discount tiers)', () => {
    expect(pkgs[0].priceUsd).toBe(500);
    expect(pkgs[1].priceUsd).toBe(1000);
    expect(pkgs[2].priceUsd).toBe(1500);
    expect(pkgs[3].priceUsd).toBe(2500);
  });

  it('marks exactly one package as recommended (the 1,500 tier)', () => {
    const recommended = pkgs.filter(p => p.recommended);
    expect(recommended).toHaveLength(1);
    expect(recommended[0].key).toBe('1500');
  });

  it('only the 1,500 and 2,500 tiers carry a badge', () => {
    expect(pkgs[0].badge).toBeNull();
    expect(pkgs[1].badge).toBeNull();
    expect(pkgs[2].badge).toEqual({label: 'Covers Booking', color: '#22c55e'});
    expect(pkgs[3].badge).toEqual({label: 'Best Value',     color: '#2563EB'});
  });

  it('reflects the required amount inside the 1,500 tier sub-label', () => {
    const p = buildPackages(2340);
    expect(p[2].sub).toContain('2,340 BC');
  });
});

describe('credit math — recommendPackageKey', () => {
  const pkgs = buildPackages(1880);

  it('picks the smallest SKU that lands >= 110% of the shortfall', () => {
    // shortfall 400 → 400 * 1.1 = 440 → first SKU >= 440 is 500
    expect(recommendPackageKey(pkgs, 400)).toBe('500');
    // shortfall 500 → 550 → 1000
    expect(recommendPackageKey(pkgs, 500)).toBe('1000');
    // shortfall 1000 → 1100 → 1500
    expect(recommendPackageKey(pkgs, 1000)).toBe('1500');
    // shortfall 1500 → 1650 → 2500
    expect(recommendPackageKey(pkgs, 1500)).toBe('2500');
  });

  it('falls back to the largest SKU when shortfall exceeds all packages', () => {
    expect(recommendPackageKey(pkgs, 10000)).toBe('2500');
    expect(recommendPackageKey(pkgs, 99999)).toBe('2500');
  });

  it('recommends the smallest package when shortfall is zero', () => {
    expect(recommendPackageKey(pkgs, 0)).toBe('500');
  });
});

describe('credit math — end-to-end paywall scenarios (exhaust every DB balance branch)', () => {
  // Exercises the entire credit pop-up calculation pipeline for each
  // representative DB state of a client wallet vs a pending booking.
  // Expectations follow the "smallest SKU >= shortfall * 1.1" rule.
  const scenarios = [
    // shortfall 500  → 550  → pick 1000
    {name: 'empty wallet, small booking',        required: 500,  balance: 0,    expectPkg: '1000', expectAfter: 1000},
    // shortfall 1000 → 1100 → pick 1500
    {name: 'empty wallet, mid booking',          required: 1000, balance: 0,    expectPkg: '1500', expectAfter: 1500},
    // shortfall 1880 → 2068 → pick 2500
    {name: 'empty wallet, Phase-1 default',      required: 1880, balance: 0,    expectPkg: '2500', expectAfter: 2500},
    // shortfall 5000 → 5500 → fallback to largest 2500
    {name: 'empty wallet, expensive booking',    required: 5000, balance: 0,    expectPkg: '2500', expectAfter: 2500},
    // shortfall 1380 → 1518 → pick 2500
    {name: 'partial balance below half',         required: 1880, balance: 500,  expectPkg: '2500', expectAfter: 3000},
    // shortfall 80   → 88   → pick 500
    {name: 'partial balance just under',         required: 1880, balance: 1800, expectPkg: '500',  expectAfter: 2300},
    // shortfall 0    → 0    → pick smallest 500
    {name: 'balance exactly covers',             required: 1880, balance: 1880, expectPkg: '500',  expectAfter: 2380},
    // shortfall 0    → surplus → pick smallest 500
    {name: 'balance surplus (no shortfall)',     required: 1880, balance: 5000, expectPkg: '500',  expectAfter: 5500},
  ];

  it.each(scenarios)('$name', ({required, balance, expectPkg, expectAfter}) => {
    const shortfall = shortfallFor(required, balance);
    const pkgs = buildPackages(required);
    const recommendedKey = recommendPackageKey(pkgs, shortfall);
    expect(recommendedKey).toBe(expectPkg);

    const pkg = pkgs.find(p => p.key === recommendedKey)!;
    const after = afterBalanceFor(balance, pkg.credits);
    expect(after).toBe(expectAfter);

    // If there WAS a shortfall, either the picked package covers it OR
    // we correctly fell back to the largest SKU.
    if (shortfall > 0) {
      const coversIt = after >= required;
      const isLargest = recommendedKey === '2500';
      expect(coversIt || isLargest).toBe(true);
    }
  });

  it('charges in USD at the 1:1 peg for every scenario', () => {
    for (const {required, balance} of scenarios) {
      const pkgs = buildPackages(required);
      const key = recommendPackageKey(pkgs, shortfallFor(required, balance));
      const pkg = pkgs.find(p => p.key === key)!;
      expect(pkg.priceUsd).toBeGreaterThan(0);
      expect(pkg.priceUsd).toBe(bcToUsd(pkg.credits));
      expect(pkg.priceUsd).toBe(pkg.credits);
    }
  });
});

describe('credit math — flakiness / idempotency smoke (×3 runs)', () => {
  // Replays the full paywall calculation three times with the same inputs
  // to prove pure-function idempotency (no hidden state, no date math).
  const required = 1880;
  const balance  = 420;

  it('produces identical results on three consecutive runs', () => {
    const runs = Array.from({length: 3}, () => {
      const pkgs = buildPackages(required);
      const key  = recommendPackageKey(pkgs, shortfallFor(required, balance));
      const pkg  = pkgs.find(p => p.key === key)!;
      return {key, priceUsd: pkg.priceUsd, after: afterBalanceFor(balance, pkg.credits)};
    });
    expect(runs[0]).toEqual(runs[1]);
    expect(runs[1]).toEqual(runs[2]);
  });
});
