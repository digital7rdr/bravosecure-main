/**
 * OM-02 — inbound ordering timestamp: future-clamped against the relay's
 * accept time, display-only. The FUTURE-ONLY asymmetry is deliberate — a
 * store-and-forwarded or outbox-queued envelope is legitimately much OLDER
 * than the reference (MSG-01 / L18) and must keep its send time.
 */

import {
  orderingTsMs,
  orderingCreatedAt,
  ORDERING_FUTURE_SKEW_MS,
} from '../runtime/orderingClock';
import {
  SEALED_AAD_FUTURE_MS,
  SEALED_AAD_MAX_AGE_MS,
  SEALED_AAD_SKEW_MS,
} from '@bravo/messenger-core';

const REF = 1_800_000_000_000;

describe('OM-02 — orderingTsMs', () => {
  it('identity: a stamp equal to the reference is kept', () => {
    expect(orderingTsMs(REF, REF)).toBe(REF);
  });

  it('keeps a stamp inside the future skew verbatim', () => {
    expect(orderingTsMs(REF + 60_000, REF)).toBe(REF + 60_000);
  });

  it('clamps a 3-min-fast peer to the accept time (the reported defect)', () => {
    expect(orderingTsMs(REF + 3 * 60_000, REF)).toBe(REF);
  });

  it('clamps the worst case verifySealedAad still accepts (23h fast)', () => {
    expect(orderingTsMs(REF + 23 * 3600_000, REF)).toBe(REF);
  });

  it('MSG-01 regression lock — a store-and-forwarded envelope keeps its send time', () => {
    const old = REF - 3 * 24 * 3600_000;
    expect(orderingTsMs(old, REF)).toBe(old);
  });

  it('L18 regression lock — a 29-day-old stash drain keeps its send time', () => {
    const old = REF - 29 * 24 * 3600_000;
    expect(orderingTsMs(old, REF)).toBe(old);
  });

  it('falls back to the reference for missing/invalid stamps', () => {
    expect(orderingTsMs(undefined, REF)).toBe(REF);
    expect(orderingTsMs(Number.NaN, REF)).toBe(REF);
    expect(orderingTsMs(0, REF)).toBe(REF);
  });

  it('falls back to Date.now() when the reference itself is missing/invalid', () => {
    for (const badRef of [undefined, 0, Number.NaN]) {
      const before = Date.now();
      const clamped = orderingTsMs(before + 10 * 24 * 3600_000, badRef);
      const after = Date.now();
      expect(clamped).toBeGreaterThanOrEqual(before);
      expect(clamped).toBeLessThanOrEqual(after + ORDERING_FUTURE_SKEW_MS);
      // A past stamp still comes back verbatim.
      expect(orderingTsMs(before - 3600_000, badRef)).toBe(before - 3600_000);
    }
  });

  it('orderingCreatedAt is the ISO form of orderingTsMs', () => {
    for (const ts of [REF - 3600_000, REF + 3 * 60_000, undefined]) {
      expect(orderingCreatedAt(ts, REF)).toBe(new Date(orderingTsMs(ts, REF)).toISOString());
    }
  });

  it('STOP-CONDITION GUARD — the AAD accept windows are untouched', () => {
    // OM-02 is display-only. If someone "fixes" it by narrowing the crypto
    // accept windows instead, this fails loudly (CLAUDE.md: never weaken —
    // or silently change — transitions).
    expect(SEALED_AAD_FUTURE_MS).toBe(24 * 60 * 60 * 1000);
    expect(SEALED_AAD_MAX_AGE_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(SEALED_AAD_SKEW_MS).toBe(15 * 60 * 1000);
  });
});
