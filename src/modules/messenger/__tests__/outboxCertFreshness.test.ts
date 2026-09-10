/**
 * SN-06 — the outbox must never re-ship an envelope whose sender cert has
 * aged out.
 *
 * Why this bug was severe: the recipient runs `verifySenderCert` BEFORE
 * libsignal decrypt and destroys anything expired (+120s tolerance), but the
 * RELAY still answers 200. So the drain flipped the bubble to 'sent' for a
 * message that was dead on arrival. 1:1 text has a one-shot undeliverable
 * resend (B-46); group rows have no resend path at all, so the loss was total
 * and silent — a delivered tick on a message nobody could read.
 *
 * Certs live ~1h, so this fired for anything queued through a longer offline
 * stretch: an overnight dead zone, a flight, a tunnel commute.
 */

import {
  isStoredCertStale,
  OUTBOX_CERT_RESEAL_MARGIN_SEC,
} from '../runtime/outboxCertFreshness';

const NOW_MS  = 1_800_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);

describe('SN-06 — stored sender-cert freshness', () => {
  it('treats a comfortably-valid cert as shippable', () => {
    // Freshly sealed: ~50 min of life left (1h TTL, 10-min refresh margin).
    expect(isStoredCertStale(NOW_SEC + 50 * 60, NOW_MS)).toBe(false);
  });

  it('treats an already-expired cert as stale', () => {
    // The overnight-dead-zone case: queued 2h, cert died an hour ago.
    expect(isStoredCertStale(NOW_SEC - 3600, NOW_MS)).toBe(true);
  });

  it('treats a cert expiring inside the tolerance margin as stale', () => {
    // Still technically valid, but the drain has a round-trip ahead of it and
    // the receiver only allows +120s — do not gamble.
    expect(isStoredCertStale(NOW_SEC + 30, NOW_MS)).toBe(true);
  });

  it('is stale exactly at the margin boundary', () => {
    expect(isStoredCertStale(NOW_SEC + OUTBOX_CERT_RESEAL_MARGIN_SEC, NOW_MS)).toBe(true);
  });

  it('is fresh one second beyond the margin', () => {
    expect(isStoredCertStale(NOW_SEC + OUTBOX_CERT_RESEAL_MARGIN_SEC + 1, NOW_MS)).toBe(false);
  });

  /**
   * Upgrade safety: rows written by a build that predates SN-06 carry no
   * `certExpSec`. Failing closed on missing metadata would strand an existing
   * queue on first launch after update, so those keep the pre-fix path.
   */
  it('reports a pre-SN-06 row (no recorded expiry) as fresh, not stale', () => {
    expect(isStoredCertStale(undefined, NOW_MS)).toBe(false);
  });

  it('defaults to the current clock when no time is supplied', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    expect(isStoredCertStale(nowSec - 3600)).toBe(true);
    expect(isStoredCertStale(nowSec + 3600)).toBe(false);
  });
});
