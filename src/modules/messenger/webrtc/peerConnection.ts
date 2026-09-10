import type {PeerConnectionLike, PeerConnectionFactory, StatsReport} from './types';
import {
  extractDtlsFingerprints,
  fingerprintMatchesPinned,
  normalizeCertFingerprint,
  type DtlsFingerprint,
} from './sdpFingerprint';
import {preferVp8OnVideoMLine} from './sdpCodecPreference';

/**
 * Audit P0-N3 — when the remote SDP omits `a=fingerprint:` (legacy
 * relay path, pre-rollout), accept the call rather than failing closed.
 * Default is OFF (fail-closed). Set EXPO_PUBLIC_DTLS_PIN_LEGACY=true
 * for a controlled rollout window only.
 */
function readDtlsPinLegacy(): boolean {
  const raw = (globalThis as {process?: {env?: Record<string, string | undefined>}})
    ?.process?.env?.EXPO_PUBLIC_DTLS_PIN_LEGACY;
  return raw === 'true';
}
const DTLS_PIN_LEGACY = readDtlsPinLegacy();
if (DTLS_PIN_LEGACY && typeof console !== 'undefined') {

  console.warn('[peerConnection] DTLS_PIN_LEGACY enabled — remote SDPs without fingerprint accepted. MUST be off in production.');
}

/**
 * Audit P0-C3 — SRTP cipher allowlist + cipher-missing fail-closed.
 *
 * The pre-fix verifier defaulted `srtpCipher` to
 * `AES_CM_128_HMAC_SHA1_80` whenever the engine omitted the field. That
 * is fail-OPEN against a downgrade — there is no way to tell from the
 * caller's perspective whether the engine genuinely negotiated that
 * cipher or whether it negotiated something weaker / unknown and just
 * didn't report. Worse, the legacy default disguised the omission so
 * every passing call looked the same in logs.
 *
 * Fix:
 *   1. Whitelist of cipher names we will accept. RFC 7714 GCM family
 *      preferred; RFC 5764 AES-CM kept for legacy peers that haven't
 *      negotiated GCM yet.
 *   2. When the engine REPORTS a cipher, it MUST be in the whitelist.
 *      Anything else throws (downgrade defence).
 *   3. When the engine does NOT report, fail closed by default. Set
 *      `EXPO_PUBLIC_DTLS_CIPHER_LEGACY=true` to accept (rollout escape
 *      hatch only). Loud console.warn on load when set.
 */
const SRTP_CIPHER_ALLOWLIST = Object.freeze(new Set<string>([
  // AEAD (RFC 7714 §15.1) — preferred.
  'SRTP_AEAD_AES_128_GCM',
  'SRTP_AEAD_AES_256_GCM',
  // Same set under the alt names some engines emit.
  'AES_128_GCM',
  'AES_256_GCM',
  'AEAD_AES_128_GCM',
  'AEAD_AES_256_GCM',
  // AES-CM with HMAC-SHA1 (RFC 5764 §4.1.2) — legacy fallback.
  'AES_CM_128_HMAC_SHA1_80',
  'AES_CM_128_HMAC_SHA1_32',
]));

function readDtlsCipherLegacy(): boolean {
  const raw = (globalThis as {process?: {env?: Record<string, string | undefined>}})
    ?.process?.env?.EXPO_PUBLIC_DTLS_CIPHER_LEGACY;
  return raw === 'true';
}
const DTLS_CIPHER_LEGACY = readDtlsCipherLegacy();
if (DTLS_CIPHER_LEGACY && typeof console !== 'undefined') {

  console.warn('[peerConnection] DTLS_CIPHER_LEGACY enabled — transport stats without srtpCipher accepted. MUST be off in production.');
}

/**
 * B-41 hardening — 1:1 ICE transport policy.
 *
 * Default is now `'all'` (gather host + srflx + relay, let ICE pick the
 * best working pair) — the SAME policy the group/SFU path uses and what
 * mainstream E2EE clients ship. This removes coturn as a SINGLE POINT OF
 * FAILURE: if the TURN relay is unreachable OR its credentials are
 * rejected (exactly what happened in B-41 — a TURN_STATIC_AUTH_SECRET
 * drift made coturn 401 every credential, and because this path was
 * hard-coded relay-only, EVERY 1:1 call hung forever on "Answering…"),
 * same-LAN and non-symmetric-NAT calls still connect via host/srflx
 * instead of bricking. The TURN relay stays in `iceServers` as the
 * fallback for genuinely UDP-blocked / symmetric-NAT networks.
 *
 * Historical context (why this used to be 'relay'): with a pre-gathered
 * candidate pool the offerer on cellular CGNAT could check host/srflx
 * first and time out before selecting the relay pair. That was mitigated
 * by the pendingIce queue-and-drain fix in callController.ts AND
 * iceCandidatePoolSize:0 (both still in place), and the group path has
 * run 'all'+pool:0 in production since. If a cross-network cellular
 * regression resurfaces, set `EXPO_PUBLIC_ICE_RELAY_ONLY=true` to restore
 * the old relay-only behaviour without a code change — but note relay-only
 * reintroduces the coturn single-point-of-failure.
 */
function resolveIceTransportPolicy(): 'all' | 'relay' {
  const raw = (globalThis as {process?: {env?: Record<string, string | undefined>}})
    ?.process?.env?.EXPO_PUBLIC_ICE_RELAY_ONLY;
  return raw === 'true' ? 'relay' : 'all';
}
if (resolveIceTransportPolicy() === 'relay' && typeof console !== 'undefined') {

  console.warn('[peerConnection] EXPO_PUBLIC_ICE_RELAY_ONLY=true — 1:1 calls are relay-only; a coturn/TURN outage will brick every call (see B-41).');
}

/**
 * Normalise a cipher name and decide if it's on the allowlist. The
 * engine may emit lower-case (some Android builds) so we match
 * case-insensitively and return the canonical upper-case form.
 *
 * Returns `null` on rejection so the caller can produce a single throw
 * site (uniform error message + log shape).
 */
function normaliseAllowedSrtpCipher(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) {return null;}
  const upper = raw.toUpperCase();
  return SRTP_CIPHER_ALLOWLIST.has(upper) ? upper : null;
}

/**
 * RTCPeerConnection wrapper with a mandatory DTLS-SRTP verification
 * step. The spec forbids plain RTP in modern WebRTC stacks, but we
 * still assert it defensively — a hacked native module or a future
 * spec addition must not silently bypass the guarantee.
 *
 * The host must inject a factory: RN builds pass
 * `() => new RTCPeerConnection(cfg)` from react-native-webrtc; tests
 * pass a fake. This module therefore has zero native-module imports.
 */

export interface IceServerConfig {
  urls: string | string[];
  username?:   string;
  credential?: string;
}

export interface PeerConnectionWrapperOptions {
  factory:    PeerConnectionFactory;
  iceServers: IceServerConfig[];
  /**
   * Override the ICE transport policy. When omitted, resolved from env
   * via `resolveIceTransportPolicy()` (default 'all'; 'relay' only when
   * EXPO_PUBLIC_ICE_RELAY_ONLY=true). Exposed primarily so tests can
   * assert both branches without mutating module-level env, and so a
   * future per-call policy decision can be threaded through.
   */
  iceTransportPolicy?: 'all' | 'relay';
}

export class PeerConnectionWrapper {
  private pc: PeerConnectionLike;
  private closed = false;
  /**
   * Audit P0-N3 — DTLS fingerprints extracted from the remote SDP
   * (offer for the answerer, answer for the offerer). The set is
   * frozen at signalling time; verifyDtlsSrtp asserts the active
   * transport's remote cert hash is in this set. A relay/SFU that
   * substitutes its own cert during the DTLS handshake produces a
   * fingerprint that's NOT in this set and the verification fails.
   *
   * `null` means we haven't applied a remote description yet (offerer
   * pre-answer, answerer pre-offer). `[]` means we applied one but it
   * carried no fingerprint line — handled via DTLS_PIN_LEGACY.
   */
  private pinnedRemoteFingerprints: DtlsFingerprint[] | null = null;
  /**
   * Audit P1-N6 — DTLS certificate continuity across ICE restarts.
   *
   * The initial pinned set (captured on the FIRST setRemoteOffer /
   * acceptAnswer of this call) is the authoritative cert identity for
   * the duration of the call. Subsequent reoffers/reanswers
   * (mid-call renegotiation OR ICE restart) MUST present a fingerprint
   * set whose entries are a subset of (or equal to) this baseline —
   * the spec says ICE restart changes ufrag/pwd only, NOT DTLS
   * identity, so a fingerprint that wasn't in the original cert is
   * either a bundle-group remediation we don't allow OR a MITM
   * attempt by a relay/SFU positioned mid-stream.
   *
   * `null` until the first SDP is applied.
   */
  private initialPinnedRemoteFingerprints: DtlsFingerprint[] | null = null;

  constructor(opts: PeerConnectionWrapperOptions) {
    // ── RTCConfiguration ───────────────────────────────────
    //
    // bundlePolicy: 'max-bundle' is REQUIRED for 1:1 video calls in
    // RN-WebRTC. With the default 'balanced', libwebrtc creates a
    // separate ICE transport per BUNDLE group (audio + video) and only
    // fuses them after the answer arrives. The post-answer fusion is
    // unreliable here: the answerer only trickles candidates for mid=0,
    // so mid=1's transport stays in 'checking' forever and the PC never
    // reaches iceConnectionState='connected'. Symptom this fixes:
    // voice calls (1 m-line) connect, video calls (2 m-lines) hang in
    // the 'connecting' state with zero media in either direction.
    //
    // iceCandidatePoolSize: 4 pre-gathers candidates as soon as the PC
    // is built, so the FIRST setLocalDescription doesn't pay a 1-2 sec
    // wait on cellular for STUN srflx + TURN allocation responses.
    // Without this, cross-network video calls were timing out the 15-
    // second ICE checking window before any pair completed.
    //
    // iceTransportPolicy — see resolveIceTransportPolicy() above. Default
    // 'all' (host + srflx + relay) so a coturn/TURN outage degrades
    // gracefully instead of bricking every 1:1 call (B-41); env can
    // force 'relay'.
    //
    // iceCandidatePoolSize: 0 (down from 4). With pool size > 0 the
    // engine pre-gathers N candidates from EACH TURN URL — so 4 × 2
    // URLs = 8 parallel TURN allocations per PC. Only 1 ends up in the
    // selected pair; the other 7 sit idle in coturn (visible as the
    // `rp=0, sp=0` sessions). On RN-WebRTC's libwebrtc fork this seems
    // to confuse the offerer's TurnPort selection on cross-network
    // calls — the engine receives the answerer's binding requests on
    // the active relay but never sends responses via TURN (peer sp=0
    // forever). With pool=0, only ONE allocation per URL is created,
    // and only when needed (after setLocalDescription). Cost: ~500ms
    // extra latency on FIRST candidate gathered, imperceptible for
    // ringing UX.
    this.pc = opts.factory({
      iceServers:           opts.iceServers,
      bundlePolicy:         'max-bundle',
      rtcpMuxPolicy:        'require',
      iceCandidatePoolSize: 0,
      iceTransportPolicy:   opts.iceTransportPolicy ?? resolveIceTransportPolicy(),
    });
  }

  get raw(): PeerConnectionLike { return this.pc; }

  async createOffer(): Promise<{type: 'offer'; sdp: string}> {
    const offer = await this.pc.createOffer();
    // B-99 RC-1 — VP8-first on the video m-line so the two libwebrtc builds
    // (Stream on Android, stock pod on iOS) negotiate a codec both decode.
    offer.sdp = preferVp8OnVideoMLine(offer.sdp);
    await this.pc.setLocalDescription(offer);
    return offer;
  }

  /**
   * Re-create an offer with iceRestart=true — used by CallController when
   * iceConnectionState transitions to 'disconnected'. This forces the
   * engine to allocate fresh ICE ufrag/pwd, re-gather candidates against
   * the same TURN allocation, and re-do the connectivity checks WITHOUT
   * tearing down the DTLS context. If the peer accepts the resulting
   * answer fast enough, audio/video resumes on the new path without the
   * user noticing more than a brief "Reconnecting…" overlay.
   *
   * The returned SDP has a different `a=ice-ufrag:` from the original;
   * receivers detect that and treat it as a restart per RFC 5245 §9.1.1.
   */
  async createRestartOffer(): Promise<{type: 'offer'; sdp: string}> {
    const pc = this.pc as unknown as {
      createOffer: (opts?: {iceRestart?: boolean}) => Promise<{type: 'offer'; sdp: string}>;
    };
    const offer = await pc.createOffer({iceRestart: true});
    // B-99 RC-1 — keep the codec preference stable across ICE-restart reoffers.
    offer.sdp = preferVp8OnVideoMLine(offer.sdp);
    await this.pc.setLocalDescription(offer);
    return offer;
  }

  /**
   * Apply the remote offer ONLY — the answerer should call this BEFORE
   * adding local tracks, then call createAnswer() last. The previous
   * combined acceptOffer() did setRemote + createAnswer in a single call,
   * which forced any track-adding (we add via the wrapped factory at PC
   * construction) to happen BEFORE setRemoteDescription. Some
   * react-native-webrtc builds then create duplicate / mis-ordered
   * transceivers and the answer SDP doesn't line up with the offer's
   * m-lines — symptom: ICE can connect but DTLS never establishes, exactly
   * the asymmetric "could not establish secure connection" we hit only
   * when the answerer was on a specific device. Spec-correct order is
   * setRemote → addTrack → createAnswer.
   */
  async setRemoteOffer(sdp: string): Promise<void> {
    this.pinRemoteFingerprints(sdp);
    await this.pc.setRemoteDescription({type: 'offer', sdp});
  }

  /**
   * Generate the answer SDP after setRemote + addTrack. This is the
   * second half of what the old acceptOffer() did, split out so callers
   * can interleave addTrack between the two steps.
   */
  async createAnswerAndApply(): Promise<{type: 'answer'; sdp: string}> {
    const answer = await this.pc.createAnswer();
    // B-99 RC-1 — the answer's codec order is authoritative for the session;
    // reorder here too so the fix holds no matter who dials. (acceptOffer —
    // the legacy one-shot — funnels through this method as well.)
    answer.sdp = preferVp8OnVideoMLine(answer.sdp);
    await this.pc.setLocalDescription(answer);
    return answer;
  }

  /**
   * Legacy combined call — kept for callers that still want the
   * one-shot semantics (notably the SFU path which has no local tracks
   * to worry about). New 1:1 code uses setRemoteOffer + createAnswerAndApply.
   */
  async acceptOffer(sdp: string): Promise<{type: 'answer'; sdp: string}> {
    await this.setRemoteOffer(sdp);
    return this.createAnswerAndApply();
  }

  async acceptAnswer(sdp: string): Promise<void> {
    this.pinRemoteFingerprints(sdp);
    await this.pc.setRemoteDescription({type: 'answer', sdp});
  }

  /**
   * Audit P0-N3 + P1-N6 — record / verify the remote DTLS fingerprint
   * set extracted from `sdp`.
   *
   * - First call (initial offer/answer): capture as the baseline. Any
   *   subsequent SDP MUST match this baseline (P1-N6 cert continuity).
   * - Subsequent calls (reoffer/reanswer, ICE-restart): verify the
   *   new set is a SUBSET of the baseline. Any new fingerprint not in
   *   the baseline is a protocol violation — ICE-restart only rotates
   *   ufrag/pwd, NOT DTLS identity. A peer legitimately re-presenting
   *   a fingerprint that was already pinned is fine (bundle-group
   *   re-emission of the same cert). A peer presenting a NEW cert
   *   during the call is a MITM cert-swap by a relay or TURN server.
   *
   * On violation: throw — the throw propagates out of
   * setRemoteOffer/acceptAnswer to callController, which tears the
   * call down via `end('failed')`. We do NOT mutate the pinned set on
   * violation, so the original baseline survives the throw for any
   * post-mortem inspection.
   */
  private pinRemoteFingerprints(sdp: string): void {
    const incoming = extractDtlsFingerprints(sdp);
    if (this.initialPinnedRemoteFingerprints === null) {
      // First SDP — capture baseline + working copy.
      this.initialPinnedRemoteFingerprints = incoming;
      this.pinnedRemoteFingerprints        = incoming;
      return;
    }
    // Subsequent SDP — enforce continuity against the baseline.
    // Empty baseline + empty incoming: DTLS_PIN_LEGACY path. Pass
    // through; assertRemoteFingerprintPinned will decide policy.
    if (this.initialPinnedRemoteFingerprints.length === 0 && incoming.length === 0) {
      this.pinnedRemoteFingerprints = incoming;
      return;
    }
    // Downgrade attempt: baseline had a fingerprint, the reoffer/
    // reanswer presents NO fingerprint. RFC 8122 §5 requires one for
    // DTLS-SRTP. An attacker stripping the line so the next verify
    // falls into the empty-set branch and (under DTLS_PIN_LEGACY)
    // bypasses the pin entirely. Refuse at pin-time, not later.
    if (this.initialPinnedRemoteFingerprints.length > 0 && incoming.length === 0) {
      throw new Error(
        'DTLS cert continuity FAILED — reoffer/reanswer carried no a=fingerprint line; downgrade attempt',
      );
    }
    // Every incoming fingerprint MUST be in the baseline.
    for (const fp of incoming) {
      if (!fingerprintMatchesPinned(this.initialPinnedRemoteFingerprints, fp.algorithm, fp.fingerprint)) {
        // Don't log the actual fingerprint value (fingerprinting vector).
        throw new Error(
          `DTLS cert continuity FAILED — reoffer/reanswer introduced new fingerprint (alg=${fp.algorithm}) absent from initial pin; possible MITM cert-swap during ICE restart`,
        );
      }
    }
    // The incoming set is a subset of the baseline — accept it as the
    // new working set. We narrow rather than expand: if the peer drops
    // an m-section's fingerprint mid-call, we don't try to assert that
    // section is still valid against the cert reports.
    this.pinnedRemoteFingerprints = incoming;
  }

  /**
   * Test-only — inspect the pinned fingerprint set. Used by the
   * pinning unit tests so they don't have to re-parse the SDP they
   * just handed to setRemoteOffer.
   */
  get pinnedFingerprintsForTests(): readonly DtlsFingerprint[] | null {
    return this.pinnedRemoteFingerprints;
  }

  /**
   * Roll the signalingState back to 'stable' by clearing any pending
   * local description. Used when a mid-call renegotiation watchdog
   * fires — without this the PC is stuck in 'have-local-offer' for
   * the rest of the call and the next `Camera` tap throws "signaling
   * state is have-local-offer, expected stable" before we can even
   * send a fresh reoffer. WebRTC spec: setLocalDescription({type:
   * 'rollback'}) when current state is 'have-local-offer' returns to
   * 'stable'. Best-effort: some RN-WebRTC builds don't expose the
   * rollback type in their RTCSessionDescriptionInit overload, so we
   * cast to bypass the typed wrapper. If the underlying engine
   * rejects (e.g. PC already closed), the caller's catch handles it.
   */
  async rollbackLocalDescription(): Promise<void> {
    if (this.closed) {return;}
    const sigState = (this.pc as {signalingState?: string}).signalingState;
    // Rollback is only meaningful from `have-local-offer` /
    // `have-remote-offer`. Skip from `stable` (already there) or
    // `closed` so we don't surface a stray engine throw.
    if (sigState === 'stable' || sigState === 'closed') {return;}
    const setLocal = this.pc.setLocalDescription as unknown as
      (desc: {type: string}) => Promise<void>;
    await setLocal.call(this.pc, {type: 'rollback'});
  }

  async addIce(candidate: string, sdpMid?: string | null, sdpMLineIndex?: number | null): Promise<void> {
    await this.pc.addIceCandidate({candidate, sdpMid, sdpMLineIndex});
  }

  close(): void {
    if (this.closed) {return;}
    this.closed = true;
    // Null all event handlers BEFORE pc.close(). Two reasons:
    //   1. RN-WebRTC's native side keeps draining queued events
    //      (icecandidate, iceconnectionstatechange) for ~50-200ms after
    //      close(). Those callbacks fire into JS with stale closures
    //      and re-enter CallController.end()/setState — already-guarded
    //      by isClosed checks, but cheaper and safer to just sever
    //      the binding.
    //   2. The handlers close over `this` (the wrapper) AND the
    //      caller's controller. RN-WebRTC's native object holds those
    //      JS handler refs until its own GC, which can be 100s of ms
    //      after close. That pins the controller alive across rapid
    //      hangup→redial cycles, accumulating closures under memory
    //      pressure. Nulling lets the JS GC release them immediately.
    const pc = this.pc as unknown as {
      onicecandidate?:             ((e: unknown) => void) | null;
      oniceconnectionstatechange?: (() => void) | null;
      onconnectionstatechange?:    (() => void) | null;
      onsignalingstatechange?:     (() => void) | null;
      onicegatheringstatechange?:  (() => void) | null;
      ontrack?:                    ((e: unknown) => void) | null;
    };
    try { pc.onicecandidate             = null; } catch { /* ignore */ }
    try { pc.oniceconnectionstatechange = null; } catch { /* ignore */ }
    try { pc.onconnectionstatechange    = null; } catch { /* ignore */ }
    try { pc.onsignalingstatechange     = null; } catch { /* ignore */ }
    try { pc.onicegatheringstatechange  = null; } catch { /* ignore */ }
    try { pc.ontrack                    = null; } catch { /* ignore */ }
    try { this.pc.close(); } catch { /* ignore */ }
  }

  /**
   * True once close() has run. Used by stats pollers + late-arriving
   * async callbacks (DTLS-poll loop, getStats interval) to bail before
   * dereferencing `raw` — the underlying RTCPeerConnection rejects
   * every method call after close, and on RN-WebRTC some of those
   * rejections surface as JS exceptions that crash the bridge if not
   * caught upstream. Cheap: just a boolean read.
   */
  isClosed(): boolean {
    return this.closed;
  }

  /**
   * Assert every active transport has DTLS connected AND SRTP cipher
   * negotiated. Returns the matched transport report on success; throws
   * if the connection is in a plain-RTP state (or transport reports
   * aren't available yet — caller should only call this AFTER ICE
   * completes, typically on iceConnectionState === 'connected').
   */
  async verifyDtlsSrtp(): Promise<{dtlsState: string; srtpCipher: string}> {
    const stats = await this.pc.getStats();
    const reports: StatsReport[] = [];
    // getStats() returns either a Map (Chrome / W3C-compliant) or an
    // iterable of values (some RN-WebRTC builds). Normalise both.
    if (stats && typeof (stats as Map<string, StatsReport>).forEach === 'function') {
      (stats as Map<string, StatsReport>).forEach(r => reports.push(r));
    } else if (stats && typeof (stats as Iterable<StatsReport>)[Symbol.iterator] === 'function') {
      for (const r of stats as Iterable<StatsReport>) {reports.push(r);}
    }

    // Find ANY transport report — react-native-webrtc only sometimes
    // populates `srtpCipher`, so we can't filter by it (the previous
    // version did, which made every call throw "DTLS-SRTP not negotiated"
    // even when DTLS was actually fully connected). Prefer the transport
    // report whose `selectedCandidatePairId` is set, which marks the
    // active media path; fall back to the first transport report.
    const transports = reports.filter(r => r.type === 'transport');
    const active = transports.find(r => typeof r.selectedCandidatePairId === 'string')
      ?? transports[0];

    if (!active) {
      throw new Error('DTLS-SRTP not negotiated — no transport report yet');
    }

    // dtlsState is the load-bearing check. Spec values: new | connecting
    // | connected | closed | failed. Accept 'connected' or 'completed'
    // (the latter only appears in some impls when ICE+DTLS are both done).
    const dtlsState = typeof active.dtlsState === 'string' ? active.dtlsState : 'unknown';
    if (dtlsState !== 'connected' && dtlsState !== 'completed') {
      throw new Error(`DTLS not connected (state=${dtlsState})`);
    }

    // Audit P0-C3 — SRTP cipher allowlist + fail-closed on missing.
    // Two failure modes the pre-fix code masked:
    //   (1) Engine reports a non-allowed cipher (downgrade / unknown).
    //       Pre-fix: returned the raw string, caller never inspected
    //       so the call connected on an unvetted cipher.
    //   (2) Engine reports no cipher at all. Pre-fix: defaulted to
    //       AES_CM_128_HMAC_SHA1_80, lying about what was actually
    //       negotiated. We can't distinguish a missing-but-strong cipher
    //       from a missing-because-NULL cipher; the only safe move is
    //       to refuse — gated by EXPO_PUBLIC_DTLS_CIPHER_LEGACY for the
    //       rollout window only.
    let srtpCipher: string;
    if (typeof active.srtpCipher === 'string' && active.srtpCipher.length > 0) {
      const allowed = normaliseAllowedSrtpCipher(active.srtpCipher);
      if (!allowed) {
        // Don't echo the raw value — could be attacker-controlled stat
        // bait. Log the lowercased shape so triage can see what came
        // through without trusting the casing.
        throw new Error(
          `DTLS-SRTP cipher not on allowlist (got=${String(active.srtpCipher).toLowerCase()})`,
        );
      }
      srtpCipher = allowed;
    } else if (DTLS_CIPHER_LEGACY) {
      // Rollout escape hatch — accept silence and record the legacy
      // canonical name so downstream code has a stable string. Loud
      // warn at module load reminds operators this is off-spec.
      srtpCipher = 'AES_CM_128_HMAC_SHA1_80';
    } else {
      throw new Error('DTLS-SRTP cipher missing from transport stat — no srtpCipher field reported');
    }

    // Audit P0-N3 — fingerprint pinning. Compare the active
    // transport's reported remote-cert fingerprint against the set
    // pinned from the SDP we agreed to on the signalling channel. The
    // resolution chain:
    //   transport.remoteCertificateId → certificate stat (.type='certificate')
    //                                  → fingerprint + fingerprintAlgorithm
    // If the engine doesn't expose any certificate stats AND the SDP
    // had at least one fingerprint line (which it should — every
    // modern stack emits one), we fail-closed unless DTLS_PIN_LEGACY
    // is set: a passing call without a verifiable cert is exactly the
    // MITM-cert-swap scenario this fix exists to catch.
    this.assertRemoteFingerprintPinned(reports, active);

    return { dtlsState, srtpCipher };
  }

  /**
   * Audit P0-N3 — assert the active transport's remote DTLS cert
   * fingerprint is in the pinned set. Throws on mismatch; throws on
   * "no comparable evidence" unless DTLS_PIN_LEGACY is on.
   *
   * Why check inside verifyDtlsSrtp (instead of after it returns):
   * verifyDtlsSrtp is the single point the controller polls until
   * DTLS-SRTP is confirmed. Folding the pin check in keeps the failure
   * mode unified — one throw, one teardown path, one log line — and
   * the controller doesn't need a second poll for cert-stat readiness
   * (some libwebrtc builds emit the certificate stat 1-2 ticks after
   * the transport stat, hence the existing 24×250ms poll handles both).
   */
  private assertRemoteFingerprintPinned(
    reports: StatsReport[],
    transport: StatsReport,
  ): void {
    const pinned = this.pinnedRemoteFingerprints;
    if (pinned === null) {
      // No remote description applied yet — verifyDtlsSrtp shouldn't
      // have been called. Defensive: treat as failure so a misuse
      // bug doesn't silently bypass the pin.
      throw new Error('DTLS fingerprint pin missing — no remote SDP applied');
    }
    if (pinned.length === 0) {
      // Remote SDP carried no `a=fingerprint:` line. RFC 8122 §5 makes
      // this MUST-have for DTLS-SRTP; in practice only ancient/legacy
      // signalling paths omit it. Fail closed unless the rollout flag
      // is explicitly set.
      if (DTLS_PIN_LEGACY) {return;}
      throw new Error('DTLS fingerprint pin failed — remote SDP carried no a=fingerprint line');
    }

    const certId  = typeof transport.remoteCertificateId === 'string' ? transport.remoteCertificateId : null;
    // Prefer the cert report referenced by transport.remoteCertificateId.
    // Fall back to the first certificate stat — libwebrtc occasionally
    // omits the id link even when the cert report itself is present
    // (older RN-WebRTC builds), and a single certificate stat is
    // unambiguous on a 1:1 transport.
    let certReport: StatsReport | undefined;
    if (certId) {
      certReport = reports.find(r => r.type === 'certificate' && (r as {id?: string}).id === certId);
    }
    if (!certReport) {
      const certs = reports.filter(r => r.type === 'certificate');
      // On 1:1 calls the cert report set is {local, remote}. Pick the
      // one whose fingerprint is NOT in our pinned set... no — that's
      // the local cert by elimination and we'd inadvertently match it.
      // Instead, try every cert report against the pinned set and
      // accept the first match. If none match we fall through to the
      // mismatch path below, which fails closed (correct).
      for (const c of certs) {
        const fp  = normalizeCertFingerprint((c as {fingerprint?: unknown}).fingerprint);
        const alg = typeof (c as {fingerprintAlgorithm?: unknown}).fingerprintAlgorithm === 'string'
          ? (c as {fingerprintAlgorithm: string}).fingerprintAlgorithm
          : '';
        if (fp && alg && fingerprintMatchesPinned(pinned, alg, fp)) {
          return;
        }
      }
      // No certificate stat at all (engine doesn't expose it yet) AND
      // we had a pinned set we couldn't validate — fail closed unless
      // the rollout flag is on. This is the MITM-cert-swap detection
      // path: an attacker can present any cert, but if the engine
      // can't tell us which one it actually trusted we have no basis
      // to trust the call.
      if (DTLS_PIN_LEGACY) {return;}
      throw new Error('DTLS fingerprint pin failed — engine reported no certificate stat');
    }

    const reportedFp  = normalizeCertFingerprint((certReport as {fingerprint?: unknown}).fingerprint);
    const reportedAlg = typeof (certReport as {fingerprintAlgorithm?: unknown}).fingerprintAlgorithm === 'string'
      ? (certReport as {fingerprintAlgorithm: string}).fingerprintAlgorithm
      : '';
    if (!reportedFp || !reportedAlg) {
      if (DTLS_PIN_LEGACY) {return;}
      throw new Error('DTLS fingerprint pin failed — certificate stat missing fingerprint/algorithm');
    }
    if (!fingerprintMatchesPinned(pinned, reportedAlg, reportedFp)) {
      // Don't log the actual values — fingerprints are stable per
      // device and a logged mismatch is a fingerprinting vector. The
      // algorithm name is safe to log.
      throw new Error(`DTLS fingerprint pin MISMATCH — alg=${reportedAlg.toLowerCase()} (peer presented a different cert than the SDP agreed)`);
    }
  }
}
