/**
 * OM-05 / NA-GATE-3 — a re-sealed outbox row carries its COMPOSE time in
 * `aad.ts`, clamped so it can never fall outside the receiver's existing,
 * unmodified accept window. Re-minting Date.now() at drain used to make the
 * sender and that one recipient permanently disagree on where the message
 * belongs in the thread.
 */

import {
  resolveResealAadTs,
  RESEAL_TS_SAFETY_MARGIN_MS,
} from '../runtime/outboxResealTimestamp';
import {verifySealedAad, SEALED_AAD_MAX_AGE_MS} from '@bravo/messenger-core';

const NOW = 1_800_000_000_000;

describe('OM-05 — resolveResealAadTs', () => {
  it('carries an overnight-queued compose time verbatim (the core case)', () => {
    const composed = NOW - 6 * 3600_000;
    expect(resolveResealAadTs(composed, NOW)).toBe(composed);
  });

  it('falls back to now for missing metadata (pre-fix rows never fail closed)', () => {
    expect(resolveResealAadTs(undefined, NOW)).toBe(NOW);
  });

  it('falls back to now for NaN / Infinity (guards the Date.parse call sites)', () => {
    expect(resolveResealAadTs(NaN, NOW)).toBe(NOW);
    expect(resolveResealAadTs(Number.POSITIVE_INFINITY, NOW)).toBe(NOW);
  });

  it('a backwards device clock never produces a future reject', () => {
    expect(resolveResealAadTs(NOW + 5 * 60_000, NOW)).toBe(NOW);
  });

  it('a carried timestamp is never allowed past the stale bound', () => {
    const limit = NOW - (SEALED_AAD_MAX_AGE_MS - RESEAL_TS_SAFETY_MARGIN_MS);
    expect(resolveResealAadTs(limit - 1, NOW)).toBe(NOW);
  });

  it('the inclusive boundary still carries the compose time', () => {
    const limit = NOW - (SEALED_AAD_MAX_AGE_MS - RESEAL_TS_SAFETY_MARGIN_MS);
    expect(resolveResealAadTs(limit, NOW)).toBe(limit);
  });

  it('round-trip guard — every returned value passes verifySealedAad at NOW', () => {
    // The helper's whole safety argument: it can never manufacture a
    // timestamp the receiver would destroy as stale/future.
    const candidates = [
      NOW - 6 * 3600_000,
      undefined,
      NaN,
      NOW + 5 * 60_000,
      NOW - SEALED_AAD_MAX_AGE_MS - 1,
      NOW - (SEALED_AAD_MAX_AGE_MS - RESEAL_TS_SAFETY_MARGIN_MS),
    ];
    for (const composedAt of candidates) {
      const ts = resolveResealAadTs(composedAt, NOW);
      const res = verifySealedAad({
        sealed:       {body: '', aad: {to: {userId: 'me', deviceId: 1}, ts}} as never,
        selfUserId:   'me',
        selfDeviceId: 1,
        now:          NOW,
      });
      expect(res.ok).toBe(true);
    }
  });
});
