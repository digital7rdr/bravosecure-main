import {deriveVerifyCode, VERIFY_CODE_WINDOW_MS} from './verify-code.util';

describe('deriveVerifyCode (Step 16 identity handshake)', () => {
  const SECRET = 'test-action-secret';
  const BOOKING = '11111111-1111-1111-1111-111111111111';
  const LEAD = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const NOW = 1_750_000_000_000; // fixed instant inside one window

  it('is a 6-digit code with a rotation boundary (client and lead derive the SAME value)', () => {
    const a = deriveVerifyCode(SECRET, BOOKING, LEAD, NOW);
    const b = deriveVerifyCode(SECRET, BOOKING, LEAD, NOW + 1000); // same window
    expect(a.code).toBe(b.code);
    expect(a.code).toMatch(/^\d{6}$/);
    expect(a.rotates_at).toBe(b.rotates_at);
    expect(new Date(a.rotates_at).getTime()).toBeGreaterThan(NOW);
  });

  it('rotates: the code changes once the time bucket advances', () => {
    const before = deriveVerifyCode(SECRET, BOOKING, LEAD, NOW);
    const after = deriveVerifyCode(SECRET, BOOKING, LEAD, NOW + VERIFY_CODE_WINDOW_MS);
    expect(after.code).not.toBe(before.code);
  });

  it('differs by agent id — what makes "not my guard" meaningful', () => {
    const real = deriveVerifyCode(SECRET, BOOKING, LEAD, NOW);
    const imposter = deriveVerifyCode(SECRET, BOOKING, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', NOW);
    expect(real.code).not.toBe(imposter.code);
  });

  it('differs by booking id (a code from one detail does not validate another)', () => {
    const one = deriveVerifyCode(SECRET, BOOKING, LEAD, NOW);
    const two = deriveVerifyCode(SECRET, '22222222-2222-2222-2222-222222222222', LEAD, NOW);
    expect(one.code).not.toBe(two.code);
  });

  it('rotating the secret invalidates the code', () => {
    const before = deriveVerifyCode(SECRET, BOOKING, LEAD, NOW);
    const after = deriveVerifyCode('rotated-secret', BOOKING, LEAD, NOW);
    expect(before.code).not.toBe(after.code);
  });
});
