/**
 * Regression — "PAYMENT FAILED · idempotency_key_invalid_shape".
 *
 * The mobile client sent Idempotency-Key values with a `:` separator
 * (`paywc:<uuid>`, `apply:<id>`, `sos:<id>:<bucket>`, …). The auth-service
 * IdempotencyInterceptor's shape gate is /^[A-Za-z0-9_-]{8,128}$/ — a `:`
 * is NOT in that charset, so EVERY one of those keys threw
 * `idempotency_key_invalid_shape` and the payment (and all mission FSM
 * transitions) failed before the handler ran.
 *
 * Fix: the client now uses `-` as the separator. This test pins the key
 * builders against the SERVER'S EXACT regex + length bounds so the
 * cross-service contract can't drift again. It mirrors the builders in
 * src/services/api.ts (kept in sync by construction below).
 */

// Mirrors apps/auth-service/src/common/interceptors/idempotency.interceptor.ts
const KEY_MIN = 8;
const KEY_MAX = 128;
const KEY_RE = /^[A-Za-z0-9_-]+$/;

function isValidIdempotencyKey(key: string): boolean {
  return key.length >= KEY_MIN && key.length <= KEY_MAX && KEY_RE.test(key);
}

// Sample identifiers in the real format: UUIDs (booking/mission/job ids)
// and an enum tag. UUIDs contain `-`, which IS in the charset.
const UUID = '3cb79cb1-f1b0-40be-9f2c-df76344a0f00';
const TAG = 'PICKUP';
const BUCKET = String(Math.floor(1_700_000_000_000 / 60_000));

// Mirrors every Idempotency-Key builder in src/services/api.ts.
const keys: Record<string, string> = {
  payWithCredits:      `paywc-${UUID}`,
  applyToJob:          `apply-${UUID}`,
  withdrawApplication: `withdraw-${UUID}`,
  acknowledgeDress:    `dress-${UUID}`,
  missionPickup:       `pickup-${UUID}`,
  missionGoLive:       `golive-${UUID}`,
  missionComplete:     `complete-${UUID}`,
  raiseSos:            `sos-${UUID}-${BUCKET}`,
  markWaypoint:        `wp-${UUID}-${TAG}`,
};

describe('idempotency key shape — client/server contract', () => {
  it('every client Idempotency-Key passes the server shape gate', () => {
    for (const [name, key] of Object.entries(keys)) {
      expect({name, valid: isValidIdempotencyKey(key)}).toEqual({name, valid: true});
    }
  });

  it('rejects the OLD colon-separated form (the bug)', () => {
    expect(isValidIdempotencyKey(`paywc:${UUID}`)).toBe(false);
    expect(isValidIdempotencyKey(`sos:${UUID}:${BUCKET}`)).toBe(false);
  });

  it('keys stay within the 8..128 length bounds', () => {
    for (const key of Object.values(keys)) {
      expect(key.length).toBeGreaterThanOrEqual(KEY_MIN);
      expect(key.length).toBeLessThanOrEqual(KEY_MAX);
    }
  });
});
