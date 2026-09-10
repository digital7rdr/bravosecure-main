/**
 * Mission-start readiness — the pure logic (founder 2026-08-11).
 *
 * The founder rule these pin: a mission starts only when BOTH sides really can
 * provide location. The traps are (a) claiming readiness we did not verify and
 * (b) telling the user the wrong thing is wrong — a GPS timeout is not the same
 * as the location switch being off, and saying so sends them to the wrong
 * setting.
 */
import {
  ALL_REQUIREMENTS, NOT_READY, applyLocationError, blockedByText, isReady,
  missingRequirements, requirementHint, requirementLabel,
  type ReadinessFlags,
} from '../protectionReadiness';

const READY: ReadinessFlags = {
  location_permission: true, location_services: true, precise_location: true,
  connectivity: true, location_available: true,
};

describe('readiness is all-or-nothing', () => {
  it('a fully capable device is ready with nothing missing', () => {
    expect(isReady(READY)).toBe(true);
    expect(missingRequirements(READY)).toEqual([]);
  });

  it('the default is NOT ready — we never assume a previous grant', () => {
    expect(isReady(NOT_READY)).toBe(false);
    expect(missingRequirements(NOT_READY)).toEqual(ALL_REQUIREMENTS);
  });

  it.each(ALL_REQUIREMENTS)('a device missing only %s is not ready', req => {
    const flags = {...READY, [req]: false};
    expect(isReady(flags)).toBe(false);
    expect(missingRequirements(flags)).toEqual([req]);
  });

  it('having a map/permission is not enough without an actual position', () => {
    // The explicit founder rule: "A map component loading successfully is not
    // enough" — location_available is what proves capability.
    expect(isReady({...READY, location_available: false})).toBe(false);
  });

  it('coarse-only location blocks readiness', () => {
    expect(isReady({...READY, precise_location: false})).toBe(false);
  });
});

describe('geolocation errors are diagnosed, not guessed', () => {
  it('code 1 (denied) clears permission and precision, not the OS switch', () => {
    const out = applyLocationError(READY, 1);
    expect(out.location_permission).toBe(false);
    expect(out.precise_location).toBe(false);
    expect(out.location_available).toBe(false);
    expect(out.location_services).toBe(true); // not disproven
  });

  it.each([2, 5])('code %s (no provider / settings) clears location services', code => {
    const out = applyLocationError(READY, code);
    expect(out.location_services).toBe(false);
    expect(out.location_available).toBe(false);
    expect(out.location_permission).toBe(true); // permission was fine
  });

  it('a TIMEOUT only means no fix yet — it must not claim the switch is off', () => {
    const out = applyLocationError(READY, 3);
    expect(out.location_available).toBe(false);
    expect(out.location_services).toBe(true);
    expect(out.location_permission).toBe(true);
    expect(out.precise_location).toBe(true);
  });

  it('an unknown code is treated as "no fix", nothing else disproven', () => {
    expect(applyLocationError(READY, undefined)).toEqual({...READY, location_available: false});
  });

  it('never turns a false flag back on', () => {
    const out = applyLocationError(NOT_READY, 3);
    expect(isReady(out)).toBe(false);
  });
});

describe('the user is told exactly what to fix', () => {
  it.each(ALL_REQUIREMENTS)('%s has a human label and a hint', req => {
    expect(requirementLabel(req).length).toBeGreaterThan(0);
    expect(requirementLabel(req)).not.toBe(req);   // never leak the raw key
    expect(requirementHint(req).length).toBeGreaterThan(0);
  });

  it('lists missing items in a stable fix order', () => {
    expect(missingRequirements(NOT_READY)).toEqual([
      'location_permission', 'location_services', 'precise_location',
      'connectivity', 'location_available',
    ]);
  });
});

describe('blockedByText names the side that is holding the mission', () => {
  it('says who is being waited on', () => {
    expect(blockedByText(['cpo'])).toMatch(/officer/i);
    expect(blockedByText(['customer'])).toMatch(/member/i);
    expect(blockedByText(['customer', 'cpo'])).toMatch(/both/i);
  });

  it('says nothing when nobody is blocking', () => {
    expect(blockedByText([])).toBe('');
  });
});
