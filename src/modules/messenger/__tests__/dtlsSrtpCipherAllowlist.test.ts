/**
 * Audit P0-C3 — DTLS-SRTP cipher allowlist.
 *
 * Threat model: react-native-webrtc's transport stat sometimes omits
 * `srtpCipher`. The pre-fix code defaulted to `AES_CM_128_HMAC_SHA1_80`
 * on omission — fail-OPEN against a downgrade (or a buggy engine that
 * silently negotiated a weak/unknown cipher).
 *
 * Fix: explicit allowlist of approved cipher names. When the engine
 * does report `srtpCipher`, the value MUST be on the list — anything
 * else is a downgrade and the call is torn down. When it does NOT
 * report, fail closed UNLESS the rollout-window escape hatch
 * `EXPO_PUBLIC_DTLS_CIPHER_LEGACY=true` is set (default off; loud
 * console.warn on load — see peerConnection.ts).
 *
 * Approved (RFC 7714 §15.1 GCM family preferred; RFC 5764 §4.1.2
 * AES-CM-128 retained for legacy peers that have not negotiated GCM):
 *   - SRTP_AEAD_AES_128_GCM
 *   - SRTP_AEAD_AES_256_GCM
 *   - AES_128_GCM
 *   - AES_256_GCM
 *   - AES_CM_128_HMAC_SHA1_80
 *   - AES_CM_128_HMAC_SHA1_32   (legacy 32-bit auth tag)
 */

import {PeerConnectionWrapper} from '../webrtc/peerConnection';
import type {PeerConnectionLike, StatsReport} from '../webrtc/types';

const PEER_FP = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';
const OFFER_SDP = `v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\na=fingerprint:sha-256 ${PEER_FP}\r\n`;

function buildPc(reports: StatsReport[]): PeerConnectionLike {
  return {
    createOffer:  async () => ({type: 'offer',  sdp: 'unused'}),
    createAnswer: async () => ({type: 'answer', sdp: 'unused'}),
    setLocalDescription:  async () => {},
    setRemoteDescription: async () => {},
    addIceCandidate:      async () => {},
    addTrack:             () => {},
    close:                () => {},
    getStats: async () => {
      const m = new Map<string, StatsReport>();
      reports.forEach((r, i) => m.set(String(i), r));
      return m;
    },
    oniceconnectionstatechange: null,
    onicecandidate:             null,
    ontrack:                    null,
  };
}

const transportConnected = (extra: Partial<StatsReport>): StatsReport => ({
  type:                  'transport',
  selectedCandidatePairId: 'pair-1',
  dtlsState:             'connected',
  remoteCertificateId:   'cert-remote',
  ...extra,
});

const remoteCertReport: StatsReport = {
  type:                 'certificate',
  id:                   'cert-remote',
  fingerprint:          PEER_FP,
  fingerprintAlgorithm: 'sha-256',
} as StatsReport;

describe('Audit P0-C3 — SRTP cipher allowlist', () => {
  it('accepts SRTP_AEAD_AES_128_GCM', async () => {
    const w = new PeerConnectionWrapper({
      factory: () => buildPc([transportConnected({srtpCipher: 'SRTP_AEAD_AES_128_GCM'}), remoteCertReport]),
      iceServers: [],
    });
    await w.setRemoteOffer(OFFER_SDP);
    const out = await w.verifyDtlsSrtp();
    expect(out.srtpCipher).toBe('SRTP_AEAD_AES_128_GCM');
  });

  it('accepts SRTP_AEAD_AES_256_GCM', async () => {
    const w = new PeerConnectionWrapper({
      factory: () => buildPc([transportConnected({srtpCipher: 'SRTP_AEAD_AES_256_GCM'}), remoteCertReport]),
      iceServers: [],
    });
    await w.setRemoteOffer(OFFER_SDP);
    const out = await w.verifyDtlsSrtp();
    expect(out.srtpCipher).toBe('SRTP_AEAD_AES_256_GCM');
  });

  it('accepts AES_CM_128_HMAC_SHA1_80 (legacy)', async () => {
    const w = new PeerConnectionWrapper({
      factory: () => buildPc([transportConnected({srtpCipher: 'AES_CM_128_HMAC_SHA1_80'}), remoteCertReport]),
      iceServers: [],
    });
    await w.setRemoteOffer(OFFER_SDP);
    const out = await w.verifyDtlsSrtp();
    expect(out.srtpCipher).toBe('AES_CM_128_HMAC_SHA1_80');
  });

  it('REJECTS an unknown cipher (downgrade defence)', async () => {
    const w = new PeerConnectionWrapper({
      factory: () => buildPc([transportConnected({srtpCipher: 'NULL_HMAC_SHA1_80'}), remoteCertReport]),
      iceServers: [],
    });
    await w.setRemoteOffer(OFFER_SDP);
    await expect(w.verifyDtlsSrtp()).rejects.toThrow(/cipher.*not.*allowed|cipher.*allowlist|disallowed/i);
  });

  it('REJECTS an empty / null cipher when reported as such', async () => {
    const w = new PeerConnectionWrapper({
      factory: () => buildPc([transportConnected({srtpCipher: 'NULL'}), remoteCertReport]),
      iceServers: [],
    });
    await w.setRemoteOffer(OFFER_SDP);
    await expect(w.verifyDtlsSrtp()).rejects.toThrow(/cipher/i);
  });

  it('fails closed when transport stat omits srtpCipher entirely (no legacy flag)', async () => {
    const w = new PeerConnectionWrapper({
      factory: () => buildPc([transportConnected({}), remoteCertReport]),
      iceServers: [],
    });
    await w.setRemoteOffer(OFFER_SDP);
    // EXPO_PUBLIC_DTLS_CIPHER_LEGACY default is OFF — no field, no
    // fall-back to a guessed value. The pre-P0-C3 code defaulted to
    // AES_CM_128_HMAC_SHA1_80, which is exactly what this test forbids.
    await expect(w.verifyDtlsSrtp()).rejects.toThrow(/cipher.*missing|cipher.*not reported|no.*srtp.*cipher/i);
  });

  it('case-insensitive match on cipher name (engine may emit lower-case)', async () => {
    const w = new PeerConnectionWrapper({
      factory: () => buildPc([transportConnected({srtpCipher: 'srtp_aead_aes_128_gcm'}), remoteCertReport]),
      iceServers: [],
    });
    await w.setRemoteOffer(OFFER_SDP);
    const out = await w.verifyDtlsSrtp();
    // Normalised back to canonical upper-case form for the returned value.
    expect(out.srtpCipher.toUpperCase()).toBe('SRTP_AEAD_AES_128_GCM');
  });
});
