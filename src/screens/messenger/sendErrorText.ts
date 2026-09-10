/**
 * sendErrorText (B-74) — map a send-pipeline exception to user-facing banner
 * text. Raw libsignal/session errors (e.g. `No record for <userId>.<deviceId>`)
 * leak internal ids and mean nothing to the user; the bubble already flips to
 * 'failed' with a retry chip (M-15), so the banner only needs a human
 * explanation. Deliberately user-readable pipeline errors (e.g. "group too
 * large to send") pass through, with any raw userId(.deviceId) addresses
 * redacted. Pure → unit-tested.
 */

// Session/crypto-internal failures where the raw message is technician-speak.
const SESSION_ERROR =
  /no record for|no session|session record|bad mac|invalid key|untrusted identity|identity key/i;

// A libsignal address is `<uuid>.<deviceId>`; bare uuids also count.
const UUID_ADDRESS =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\.\d+)?/gi;

// B-272 — the messenger singleton is not configured/built yet. Reachable for
// real: a notification tap can mount ChatScreen in the same frame
// MainNavigator starts resolving the ownerKey pin.
const RUNTIME_NOT_READY = /configureMessengerRuntime|runtime (?:is )?not (?:ready|configured)/i;

// B-272 — anything naming a function call is engineering-speak. This file
// passed EVERYTHING it did not recognise straight to the banner, which is
// allow-by-default for a user-facing string: the one that escaped read
// "production runtime requires configureMessengerRuntime(cfg) first". Deliberate
// pipeline copy ("group too large to send (300 > 250 recipients)") has a space
// before its parenthesis and is unaffected.
const INTERNAL_SYMBOL = /\b[a-z][A-Za-z0-9_$]*\(/;

export const SESSION_REESTABLISH_TEXT =
  'Secure session is re-establishing — the message wasn’t sent. Tap it to retry.';

export const RUNTIME_WARMING_TEXT =
  'Secure messaging is still starting up — try again in a moment.';

export function sendErrorText(e: unknown, fallback: string): string {
  const raw = e instanceof Error ? e.message : '';
  if (!raw) {return fallback;}
  if (RUNTIME_NOT_READY.test(raw)) {return RUNTIME_WARMING_TEXT;}
  if (SESSION_ERROR.test(raw)) {return SESSION_REESTABLISH_TEXT;}
  if (INTERNAL_SYMBOL.test(raw)) {return fallback;}
  return raw.replace(UUID_ADDRESS, 'contact');
}
