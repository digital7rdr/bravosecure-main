/**
 * SN-06 — is a stored outbox envelope still shippable, or has its sender cert
 * aged out?
 *
 * Kept in its own tiny module (no native/runtime imports) so the decision can
 * be unit-tested without standing up the whole messenger runtime — same
 * rationale as `media/attachmentError.ts`.
 *
 * Background: the outbox persists fully-sealed envelope bytes, but a sender
 * cert lives only ~1h. A row queued through a longer offline stretch used to be
 * re-shipped verbatim; the recipient runs `verifySenderCert` BEFORE libsignal
 * decrypt and destroys anything expired, while the relay still answers 200 — so
 * the sender's bubble flipped to 'sent' for a message that was dead on arrival.
 * Group rows have no undeliverable-resend path, making the loss silent.
 */

/**
 * Margin before expiry at which we stop trusting a stored cert.
 *
 * The receiver allows +120s of clock tolerance, and the drain still has a
 * network round-trip ahead of it, so anything inside this window is treated as
 * already dead rather than gambled on.
 */
export const OUTBOX_CERT_RESEAL_MARGIN_SEC = 120;

/**
 * True when a stored envelope's cert is too close to expiry to ship.
 *
 * `certExpSec` is undefined for rows written before SN-06 shipped. Those are
 * reported fresh so an app upgrade doesn't strand an existing queue — they
 * keep the pre-fix behaviour rather than failing closed on missing metadata.
 */
export function isStoredCertStale(
  certExpSec: number | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (certExpSec === undefined) {return false;}
  const nowSec = Math.floor(nowMs / 1000);
  return certExpSec - nowSec <= OUTBOX_CERT_RESEAL_MARGIN_SEC;
}
