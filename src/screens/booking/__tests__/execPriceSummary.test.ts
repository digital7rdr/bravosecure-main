/**
 * Secure Services Streamlined — GAP 3: the Executive price summary shows a
 * "Base Protection" and a "Secure Transfer" subtotal above the Estimated Total.
 * The subtotals are a GROUPING of the existing calculation lines (CPO hours +
 * add-ons → base; vehicles / driver → transfer) — no new pricing logic — so the
 * one invariant that matters is pinned here: the two subtotals always sum to
 * the total the screen already showed (execTotalBc of the mirrored rate).
 */
import {execPriceLines, execPriceSummary} from '../../executive/execPriceSummary';
import {EXEC_DURATIONS} from '../../executive/executiveProduct';
import {
  EXEC_ADDONS, execAddOnsBcPerHour, execRateBcPerHour, execTotalBc,
} from '../../executive/executivePricing';

type ExecAddOn = (typeof EXEC_ADDONS)[number];

const subsets = (items: ReadonlyArray<ExecAddOn>): ExecAddOn[][] => {
  const out: ExecAddOn[][] = [[]];
  for (const it of items) {
    const n = out.length;
    for (let i = 0; i < n; i++) {out.push([...out[i], it]);}
  }
  return out;
};

describe('execPriceLines — the existing calculation lines, now grouped', () => {
  it('puts the CPO line and every add-on under base, vehicles + driver under transfer', () => {
    const lines = execPriceLines({
      cpoCount: 2, vehicleCount: 1, driverOnly: false, selectedAddOns: [EXEC_ADDONS[0]],
    });
    expect(lines.map(l => [l.label, l.group])).toEqual([
      ['2 × Close Protection Officer', 'base'],
      ['1 × Vehicle & Driver', 'transfer'],
      [EXEC_ADDONS[0].label, 'base'],
    ]);
  });

  it('keeps the driver-only line (client vehicle) under transfer', () => {
    const lines = execPriceLines({cpoCount: 1, vehicleCount: 0, driverOnly: true, selectedAddOns: []});
    expect(lines.map(l => [l.label, l.group])).toEqual([
      ['1 × Close Protection Officer', 'base'],
      ['Bravo driver (client vehicle)', 'transfer'],
    ]);
  });

  it('emits no vehicle line at zero vehicles (the line list is unchanged from today)', () => {
    const lines = execPriceLines({cpoCount: 1, vehicleCount: 0, driverOnly: false, selectedAddOns: []});
    expect(lines).toHaveLength(1);
  });
});

describe('execPriceSummary — Base Protection + Secure Transfer === Estimated Total', () => {
  it('matches the spec figure shape (3 h, 1 CPO → 258 BC base)', () => {
    const lines = execPriceLines({cpoCount: 1, vehicleCount: 0, driverOnly: false, selectedAddOns: []});
    const {baseBc, transferBc} = execPriceSummary(lines, 3);
    expect(baseBc).toBe(258);
    expect(transferBc).toBe(0);
  });

  it('the subtotals sum to the EXISTING total for every team shape and duration', () => {
    const checked: number[] = [];
    for (const hours of EXEC_DURATIONS) {
      for (let cpoCount = 1; cpoCount <= 4; cpoCount++) {
        for (const driverOnly of [false, true]) {
          // Driver-only zeroes vehicles on the screen (setDriverOnly) — mirror the invariant.
          const vehicleChoices = driverOnly ? [0] : [0, 1, 2, 3, 4];
          for (const vehicleCount of vehicleChoices) {
            for (const selectedAddOns of subsets(EXEC_ADDONS)) {
              const lines = execPriceLines({cpoCount, vehicleCount, driverOnly, selectedAddOns});
              const {baseBc, transferBc} = execPriceSummary(lines, hours);
              const rate = execRateBcPerHour({
                cpoCount, vehicleCount, driverOnly,
                addOnsBcPerHour: execAddOnsBcPerHour(selectedAddOns.map(a => a.id)),
              });
              const total = execTotalBc(rate, hours);
              expect(+(baseBc + transferBc).toFixed(2)).toBe(total);
              // And each subtotal is exactly the sum of its own lines × hours.
              const sumOf = (g: 'base' | 'transfer') =>
                lines.filter(l => l.group === g).reduce((s, l) => s + l.perHour * hours, 0);
              expect(baseBc).toBe(sumOf('base'));
              expect(transferBc).toBe(sumOf('transfer'));
              checked.push(total);
            }
          }
        }
      }
    }
    expect(checked.length).toBeGreaterThan(1_000);
  });

  it('transfer is zero when there is neither a vehicle nor a driver line', () => {
    const lines = execPriceLines({cpoCount: 3, vehicleCount: 0, driverOnly: false, selectedAddOns: [...EXEC_ADDONS]});
    expect(execPriceSummary(lines, 8).transferBc).toBe(0);
  });
});
