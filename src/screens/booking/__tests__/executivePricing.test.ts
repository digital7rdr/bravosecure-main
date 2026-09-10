/**
 * Executive Protection — the client pricing mirror must stay in lockstep with
 * apps/auth-service/src/booking/pricing.service.ts (calculateExecutive). These are
 * the same numbers asserted server-side in pricing.executive.spec.ts; if either
 * side changes without the other, one of the two suites goes red.
 */
import {
  EXEC_ADDONS, EXEC_CPO_RATE_BC, EXEC_VEHICLE_RATE_BC, EXEC_DRIVER_ONLY_RATE_BC,
  execAddOnsBcPerHour, execRateBcPerHour, execTotalBc,
} from '../../executive/executivePricing';

describe('executivePricing — client mirror of calculateExecutive', () => {
  it('mirrors the unit rates', () => {
    expect(EXEC_CPO_RATE_BC).toBe(86);
    expect(EXEC_VEHICLE_RATE_BC).toBe(30);
    expect(EXEC_DRIVER_ONLY_RATE_BC).toBe(20);
  });

  it('mirrors the add-on catalogue (display == charge)', () => {
    expect(EXEC_ADDONS.map(a => [a.id, a.bcPerHour])).toEqual([
      ['female_cpo', 120], ['recon', 100], ['medical', 90], ['comms', 75],
    ]);
  });

  it('prices the mock exactly: 1 CPO · 3 h = 86/hr → 258 total', () => {
    const rate = execRateBcPerHour({cpoCount: 1, vehicleCount: 0, driverOnly: false, addOnsBcPerHour: 0});
    expect(rate).toBe(86);
    expect(execTotalBc(rate, 3)).toBe(258);
  });

  it('charges per CPO and per vehicle', () => {
    expect(execRateBcPerHour({cpoCount: 3, vehicleCount: 2, driverOnly: false, addOnsBcPerHour: 0}))
      .toBe(3 * 86 + 2 * 30);
  });

  it('driver-only adds the Bravo-driver fee and zeroes vehicles', () => {
    expect(execRateBcPerHour({cpoCount: 1, vehicleCount: 3, driverOnly: true, addOnsBcPerHour: 0}))
      .toBe(86 + 20);
  });

  it('sums selected add-ons', () => {
    expect(execAddOnsBcPerHour(['female_cpo', 'comms'])).toBe(195);
    expect(execAddOnsBcPerHour([])).toBe(0);
    expect(execAddOnsBcPerHour(['unknown'])).toBe(0);
  });

  it('the full stack matches the server spec: 2 CPO + 1 vehicle + medical, 12 h', () => {
    const rate = execRateBcPerHour({
      cpoCount: 2, vehicleCount: 1, driverOnly: false,
      addOnsBcPerHour: execAddOnsBcPerHour(['medical']),
    });
    expect(rate).toBe(2 * 86 + 30 + 90);
    expect(execTotalBc(rate, 12)).toBe((2 * 86 + 30 + 90) * 12);
  });
});
