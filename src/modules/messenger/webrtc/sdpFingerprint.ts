/**
 * Audit P0-N3 — DTLS fingerprint pinning.
 *
 * The DTLS-SRTP handshake's authenticity rests entirely on the
 * `a=fingerprint:` line being a faithful copy of the remote peer's
 * certificate hash. The signalling layer transports it: the relay sees
 * the SDP in plaintext (sealed-sender bodies are E2E-encrypted, but
 * the call.offer / call.answer frames carry SDP) and a malicious SFU
 * or TURN server is also positioned to MITM the DTLS handshake itself.
 * Without pinning, the engine accepts whichever cert the handshake
 * counter-party presents — that may not be the peer we agreed with on
 * the signalling channel.
 *
 * Mitigation: parse every `a=fingerprint:` line out of the remote
 * SDP at signalling time, store as the pinned set, and after DTLS
 * connects compare the stats-reported remote certificate fingerprint
 * against the pinned set. Mismatch ⇒ tear the call down.
 *
 * Spec reference: RFC 8122 §5 — `a=fingerprint:<hash-function> <hex>`
 * may appear at session-level OR per m= section; both must be honored.
 * Algorithms supported by all modern stacks: sha-256 (mandatory),
 * sha-384, sha-512. We accept any but normalise to lower-case for the
 * comparison so a sha-256 vs SHA-256 mismatch can't cause a false
 * positive.
 */

export interface DtlsFingerprint {
  /** Lower-case hash name, e.g. 'sha-256'. */
  algorithm:   string;
  /**
   * Upper-case hex with the spec-mandated `:` separator between each
   * pair of nibbles, e.g. `AA:BB:CC:...`. We normalise the case here so
   * the cert-stat comparison can do a single case-folded equality
   * check without a fresh normalisation pass on every poll iteration.
   */
  fingerprint: string;
}

/**
 * Parse every `a=fingerprint:<algo> <hex>` line out of an SDP blob.
 * The same algorithm + fingerprint pair may legitimately appear once
 * at session level and again per m= section (bundle group all share
 * the cert) — we dedupe by `<algo>|<fingerprint>` so the caller sees
 * a flat unique set.
 *
 * Returns an empty array when the SDP has no fingerprint lines — the
 * caller decides whether to treat that as a hard failure (default) or
 * a legacy-server fall-through under an explicit env flag.
 */
export function extractDtlsFingerprints(sdp: string): DtlsFingerprint[] {
  if (typeof sdp !== 'string' || sdp.length === 0) {return [];}
  const out:  DtlsFingerprint[] = [];
  const seen: Set<string>       = new Set();
  // RFC 4566 §5 — SDP lines are CRLF separated but tolerant parsers
  // also accept LF. Splitting on /\r?\n/ catches both.
  const lines = sdp.split(/\r?\n/);
  for (const raw of lines) {
    // Match `a=fingerprint:<token> <hex-colon-hex…>` allowing leading
    // whitespace (some stacks indent, even though the spec forbids it)
    // and a trailing carriage return that survived a CRLF-on-LF split.
    const m = /^\s*a=fingerprint:(\S+)\s+([0-9A-Fa-f:]+)\s*$/.exec(raw);
    if (!m) {continue;}
    const algorithm   = m[1].toLowerCase();
    const fingerprint = m[2].toUpperCase();
    const key = `${algorithm}|${fingerprint}`;
    if (seen.has(key)) {continue;}
    seen.add(key);
    out.push({algorithm, fingerprint});
  }
  return out;
}

/**
 * Normalise a fingerprint reported by `RTCStatsReport`'s certificate
 * stat. libwebrtc emits the hex unseparated on some builds and
 * colon-separated on others; we always compare in the colon-separated
 * upper-case form parsed from SDP, so canonicalise the stats value to
 * match.
 *
 * Returns `null` when the input doesn't look like a hex fingerprint —
 * the caller treats `null` as "no comparable value" and fails closed.
 */
export function normalizeCertFingerprint(raw: unknown): string | null {
  if (typeof raw !== 'string') {return null;}
  const hex = raw.replace(/:/g, '').toUpperCase();
  // 32 bytes (sha-256) = 64 hex chars; 48 (sha-384) = 96; 64 (sha-512)
  // = 128. Reject anything that isn't pure hex or has a non-cert length
  // so a stray non-fingerprint string can't sneak through.
  if (!/^[0-9A-F]+$/.test(hex)) {return null;}
  if (hex.length % 2 !== 0) {return null;}
  // Re-insert `:` every two chars so the result matches SDP form.
  const groups: string[] = [];
  for (let i = 0; i < hex.length; i += 2) {groups.push(hex.slice(i, i + 2));}
  return groups.join(':');
}

/**
 * True when `candidate` (already normalised via
 * `normalizeCertFingerprint`) matches ANY entry in the pinned set
 * under the given algorithm. The algorithm comparison is case-
 * insensitive because libwebrtc reports `sha-256` while the SDP line
 * is sometimes written `SHA-256` even though RFC 8122 §5 mandates
 * lower-case.
 */
export function fingerprintMatchesPinned(
  pinned:    readonly DtlsFingerprint[],
  algorithm: string,
  fingerprint: string,
): boolean {
  const algLower = algorithm.toLowerCase();
  for (const p of pinned) {
    if (p.algorithm === algLower && p.fingerprint === fingerprint) {return true;}
  }
  return false;
}
