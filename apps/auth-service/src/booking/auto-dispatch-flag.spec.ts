import configuration from '../config/configuration';

/**
 * Step 1 invariant: the auto-dispatch feature flag defaults OFF, so
 * POST /bookings stays the legacy admin-mediated flow (DRAFT -> PENDING_OPS).
 * The booking create() branch that reads this flag lands in a later step;
 * until then this guards that nothing flips it on by default.
 */
describe('auto-dispatch feature flag', () => {
  const KEY = 'AUTO_DISPATCH_ENABLED';
  const original = process.env[KEY];

  afterEach(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  });

  it('defaults to false when AUTO_DISPATCH_ENABLED is unset', () => {
    delete process.env[KEY];
    expect(configuration().featureFlags.autoDispatch).toBe(false);
  });

  it('stays false for any value other than the literal "true"', () => {
    process.env[KEY] = 'false';
    expect(configuration().featureFlags.autoDispatch).toBe(false);
    process.env[KEY] = '1';
    expect(configuration().featureFlags.autoDispatch).toBe(false);
    process.env[KEY] = 'TRUE';
    expect(configuration().featureFlags.autoDispatch).toBe(false);
  });

  it('is true only when AUTO_DISPATCH_ENABLED === "true"', () => {
    process.env[KEY] = 'true';
    expect(configuration().featureFlags.autoDispatch).toBe(true);
  });
});
