import type {SessionAddress} from '../gateway/protocol';

/**
 * Sealed-sender envelope. There is no `sender` field by design —
 * the recipient recovers the sender identity from the outer ECIES
 * wrap (Sealed Sender v2) and from the cert that was wrapped INSIDE
 * the Signal ciphertext. The server cannot link the persisted
 * envelope to a specific sender user id.
 *
 * `dwellExpires` is the epoch-ms deadline after which the envelope is
 * automatically evicted by Redis TTL. Clients that miss the window
 * just don't get the message — forward secrecy doesn't guarantee
 * reliable delivery.
 *
 * The `submitterUserId` field is NOT persisted here — it's only
 * inspected transiently by the controller for rate limiting (M12).
 * We deliberately do not carry it into storage.
 */
export interface StoredEnvelope {
  envelopeId: string;
  recipient:  SessionAddress;
  /**
   * Sealed Sender v2 outer ECIES wrap (base64). Opaque to the relay;
   * the recipient's libsignal SessionCipher input + the sender's
   * address both live encrypted inside this single string.
   */
  outerSealed: string;
  timestamp:  number;
  dwellExpires: number;
  /**
   * Disappearing-message deadline (epoch seconds). When set, the relay
   * shrinks the Redis TTL to match and the cleanup cron hard-deletes
   * any stragglers whose `expiresAtSec <= now`. The ciphertext itself
   * still carries an encrypted copy of the deadline inside the sealed-
   * sender envelope — the server-visible field here is only used for
   * relay purge timing.
   */
  expiresAtSec?: number;
  /**
   * Audit P0-N9 — possession-proof token attached on `pull()`. Random
   * 24-byte value minted by the relay on first delivery (or on the
   * pull, whichever comes first). The recipient must echo it back on
   * POST /envelopes/:id/ack. NOT persisted on the StoredEnvelope row
   * in Redis (it lives in its own `ack_token:{id}` key); this field
   * is populated transiently by `EnvelopeService.pull` and exists on
   * the type so the HTTP controller can serialise it back to the
   * client without a parallel array.
   */
  ackToken?: string;
}

export interface SendEnvelopeInput {
  recipient:   SessionAddress;
  outerSealed: string;
  /** Optional client-generated correlation id (echoed back on acceptance). */
  clientMsgId?: string;
  /** See StoredEnvelope.expiresAtSec. */
  expiresAtSec?: number;
  /**
   * Audit P0-T6 — transient submitter address for the
   * `envelope.delivered` callback. The relay records this in a
   * short-lived Redis key (`submitter:{envelopeId}`) and consumes it
   * when the recipient acks, so the sender device can paint the
   * double-tick. NOT persisted into `StoredEnvelope` and NOT archived
   * — sealed sender remains intact at the storage layer. The WS
   * gateway passes this from the authenticated socket context; the
   * HTTP controller deliberately omits it because HTTP submitters
   * don't have a live socket to notify anyway.
   */
  submitter?: SessionAddress;
  /**
   * OM-03 — client asks the relay to park an anonymous delivery-receipt
   * slot for this envelope (`rcpt:{envelopeId}`, gated on the retract
   * token). Set by the HTTP lane, whose submitter has no live socket for
   * `envelope.delivered` and whose identity must not be recorded.
   */
  receipt?: boolean;
}

export type ReceiptOutcome = 'pending' | 'delivered' | 'discarded' | 'unknown';

export interface SendEnvelopeResult {
  envelopeId: string;
  clientMsgId?: string;
  /** True when recipient was online; `false` means the envelope is queued. */
  deliveredNow: boolean;
  /**
   * M12: opaque capability token the sender stores locally. Presenting
   * it to `POST /envelopes/retract` hard-deletes this envelope from
   * the relay even if the recipient is still offline. Single-use.
   */
  retractToken: string;
  /**
   * Audit P2-BR-3 — whether this submit warrants a push chat-wake. False
   * for the server-detectable non-notification cases regardless of the
   * client's `urgent` hint: a dedup-claim HIT (a retried send whose
   * original already fired its wake) and an envelope already expired at
   * submit (ttl elapsed → nothing persisted or fanned out). The HTTP
   * controller / WS gateway AND this with the client `urgent` flag before
   * calling `sendChatWake`, so a retried/pre-expired/non-urgent envelope
   * never re-banners a killed device.
   */
  wakeEligible: boolean;
  /**
   * B-715 — milliseconds spent between the envelope becoming DURABLE
   * (`store.put` resolved) and this result being returned, i.e. the window in
   * which the message existed but the caller had not yet been able to start the
   * push. It is the measurable form of "is our own backend sitting on the
   * notification?", and it did not exist before: the only server timestamps were
   * the `accepted` log (printed after this whole tail) and the push log, so the
   * tail between them was invisible.
   *
   * Optional because the early returns — an already-expired submit and a dedup
   * HIT — never reach the put, and both are `wakeEligible: false` anyway, so
   * there is no push for the number to explain. `-1` means the put was skipped.
   */
  postPutMs?: number;
}
