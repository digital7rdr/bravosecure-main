import {
  BASE_RATE_BC,
  rateBcPerHour,
  vehiclesForPassengers,
  maxCposForClientVehicle,
  PASSENGERS_PER_VEHICLE,
  MAX_CPOS,
} from '../pricing';

describe('vehiclesForPassengers', () => {
  it('needs 1 vehicle for 1–3 passengers', () => {
    expect(vehiclesForPassengers(1)).toBe(1);
    expect(vehiclesForPassengers(3)).toBe(1);
  });

  it('needs 2 vehicles once passengers exceed 3', () => {
    expect(vehiclesForPassengers(4)).toBe(2);
    expect(vehiclesForPassengers(6)).toBe(2);
  });

  it('adds a vehicle per 3 passengers thereafter', () => {
    expect(vehiclesForPassengers(7)).toBe(3);
    expect(vehiclesForPassengers(9)).toBe(3);
  });

  it('never returns fewer than 1 (baseline includes a vehicle)', () => {
    expect(vehiclesForPassengers(0)).toBe(1);
    expect(vehiclesForPassengers(-2)).toBe(1);
  });

  it('uses the documented 3-pax-per-vehicle constant', () => {
    expect(PASSENGERS_PER_VEHICLE).toBe(3);
  });
});

describe('maxCposForClientVehicle (driver-only seat cap)', () => {
  it('leaves free seats for CPOs after passengers (5-seater: driver + 4)', () => {
    // 3 passengers + my car -> 4 - 3 = 1 free seat -> max 1 CPO (the user's case)
    expect(maxCposForClientVehicle(3)).toBe(1);
    expect(maxCposForClientVehicle(2)).toBe(2);
    expect(maxCposForClientVehicle(1)).toBe(3);
  });

  it('always allows at least 1 CPO even when the car is full of passengers', () => {
    expect(maxCposForClientVehicle(4)).toBe(1);
    expect(maxCposForClientVehicle(10)).toBe(1);
  });

  it('never exceeds the global MAX_CPOS', () => {
    expect(maxCposForClientVehicle(0)).toBeLessThanOrEqual(MAX_CPOS);
    expect(MAX_CPOS).toBe(4);
  });
});

describe('rateBcPerHour', () => {
  const base = {cpoCount: 1, vehicleCount: 1, driverOnly: false, addOnsBcPerHour: 0};

  it('starts at the 86 BC base for the baseline team', () => {
    expect(rateBcPerHour(base)).toBe(BASE_RATE_BC);
    expect(rateBcPerHour(base)).toBe(86);
  });

  it('increases the rate when CPOs are added (the reported bug)', () => {
    // +1 CPO = 86 + 0.25*86 = 107.5 -> 108
    expect(rateBcPerHour({...base, cpoCount: 2})).toBe(108);
    expect(rateBcPerHour({...base, cpoCount: 2})).toBeGreaterThan(86);
    // +2 CPO = 86 + 2*21.5 = 129
    expect(rateBcPerHour({...base, cpoCount: 3})).toBe(129);
  });

  it('increases the rate when vehicles are added', () => {
    expect(rateBcPerHour({...base, vehicleCount: 2})).toBe(108);
  });

  it('applies the driver-only discount', () => {
    // 86 * 0.65 = 55.9 -> 56
    expect(rateBcPerHour({...base, driverOnly: true})).toBe(56);
  });

  it('ignores extra-vehicle surcharge when driver-only (client supplies vehicle)', () => {
    // Even with vehicleCount > 1, driver-only zeroes Bravo vehicles: 86 * 0.65.
    expect(rateBcPerHour({...base, vehicleCount: 3, driverOnly: true})).toBe(56);
  });

  it('adds optional add-on hourly prices', () => {
    expect(rateBcPerHour({...base, addOnsBcPerHour: 120})).toBe(206);
  });

  it('combines extras: 2 CPO + 2 vehicles + female CPO add-on', () => {
    // 86 + 21.5 + 21.5 + 120 = 249
    expect(rateBcPerHour({cpoCount: 2, vehicleCount: 2, driverOnly: false, addOnsBcPerHour: 120})).toBe(249);
  });
});
