/**
 * Audit P0-N3 — DTLS fingerprint pinning regression suite.
 *
 * Covers:
 *  - SDP extractor: session-level + per-m-section lines, dedup, case
 *    normalisation, malformed lines ignored.
 *  - normalizeCertFingerprint: hex without colons, hex with colons,
 *    rejects non-hex / odd-length.
 *  - PeerConnectionWrapper: setRemoteOffer / acceptAnswer pin the
 *    fingerprints; verifyDtlsSrtp throws on mismatch and on missing
 *    cert stat (fail-closed); accepts a matching cert.
 */

import {
  extractDtlsFingerprints,
  normalizeCertFingerprint,
  fingerprintMatchesPinned,
} from '../webrtc/sdpFingerprint';
import {PeerConnectionWrapper} from '../webrtc/peerConnection';
import type {PeerConnectionLike, StatsReport} from '../webrtc/types';

const PEER_FP_HEX_COLONED = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';
const PEER_FP_HEX_FLAT    = 'AABBCCDDEEFF001122334455667788991122334455667788AABBCCDDEEFF0011';
const ATTACKER_FP_HEX     = '11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00';

function sdpWith(algo: string, fpUpper: string): string {
  return `v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\na=fingerprint:${algo} ${fpUpper}\r\n`;
}

describe('extractDtlsFingerprints', () => {
  it('extracts a single sha-256 fingerprint at session level', () => {
    const out = extractDtlsFingerprints(sdpWith('sha-256', PEER_FP_HEX_COLONED));
    expect(out).toEqual([{algorithm: 'sha-256', fingerprint: PEER_FP_HEX_COLONED}]);
  });

  it('extracts session-level AND per-m-section fingerprints, dedup identical pairs', () => {
    const sdp = [
      'v=0',
      'o=- 1 1 IN IP4 0.0.0.0',
      `a=fingerprint:sha-256 ${PEER_FP_HEX_COLONED}`,
      'm=audio 9 UDP/TLS/RTP/SAVPF 111',
      `a=fingerprint:sha-256 ${PEER_FP_HEX_COLONED}`,
      'm=video 9 UDP/TLS/RTP/SAVPF 96',
      `a=fingerprint:sha-256 ${PEER_FP_HEX_COLONED}`,
    ].join('\r\n');
    const out = extractDtlsFingerprints(sdp);
    expect(out).toHaveLength(1);
  });

  it('normalises algorithm to lower-case and fingerprint to upper-case', () => {
    const sdp = `v=0\r\na=fingerprint:SHA-256 ${PEER_FP_HEX_COLONED.toLowerCase()}\r\n`;
    const out = extractDtlsFingerprints(sdp);
    expect(out).toEqual([{algorithm: 'sha-256', fingerprint: PEER_FP_HEX_COLONED}]);
  });

  it('ignores malformed and unrelated lines', () => {
    const sdp = [
      'v=0',
      'a=fingerprint:',                    // empty
      'a=fingerprint: zzz',                // no algo / bad chars
      'a=group:BUNDLE 0 1',                // not a fingerprint
      `a=fingerprint:sha-256 ${PEER_FP_HEX_COLONED}`,
    ].join('\n');
    const out = extractDtlsFingerprints(sdp);
    expect(out).toEqual([{algorithm: 'sha-256', fingerprint: PEER_FP_HEX_COLONED}]);
  });

  it('returns [] for empty input', () => {
    expect(extractDtlsFingerprints('')).toEqual([]);
    expect(extractDtlsFingerprints(null as unknown as string)).toEqual([]);
  });
});

describe('normalizeCertFingerprint', () => {
  it('accepts colon-separated upper-case hex unchanged', () => {
    expect(normalizeCertFingerprint(PEER_FP_HEX_COLONED)).toBe(PEER_FP_HEX_COLONED);
  });
  it('re-inserts colons on flat hex', () => {
    expect(normalizeCertFingerprint(PEER_FP_HEX_FLAT)).toBe(PEER_FP_HEX_FLAT.replace(/(.{2})(?=.)/g, '$1:').toUpperCase());
  });
  it('upper-cases lower-case hex', () => {
    expect(normalizeCertFingerprint(PEER_FP_HEX_COLONED.toLowerCase())).toBe(PEER_FP_HEX_COLONED);
  });
  it('rejects non-hex strings', () => {
    expect(normalizeCertFingerprint('not-a-fingerprint')).toBeNull();
  });
  it('rejects odd-length hex', () => {
    expect(normalizeCertFingerprint('ABCDE')).toBeNull();
  });
  it('rejects non-string inputs', () => {
    expect(normalizeCertFingerprint(undefined)).toBeNull();
    expect(normalizeCertFingerprint(42)).toBeNull();
  });
});

describe('fingerprintMatchesPinned', () => {
  it('matches case-insensitively on algorithm', () => {
    const pinned = [{algorithm: 'sha-256', fingerprint: PEER_FP_HEX_COLONED}];
    expect(fingerprintMatchesPinned(pinned, 'SHA-256', PEER_FP_HEX_COLONED)).toBe(true);
  });
  it('rejects mismatched fingerprint under matching algo', () => {
    const pinned = [{algorithm: 'sha-256', fingerprint: PEER_FP_HEX_COLONED}];
    expect(fingerprintMatchesPinned(pinned, 'sha-256', ATTACKER_FP_HEX)).toBe(false);
  });
});

// ── PeerConnectionWrapper end-to-end ────────────────────────────────

function fakeRawPc(getStats: () => Promise<Map<string, StatsReport>>): PeerConnectionLike {
  return {
    createOffer:  async () => ({type: 'offer',  sdp: 'unused'}),
    createAnswer: async () => ({type: 'answer', sdp: 'unused'}),
    setLocalDescription:  async () => {},
    setRemoteDescription: async () => {},
    addIceCandidate:      async () => {},
    addTrack:             () => {},
    close:                () => {},
    getStats,
    oniceconnectionstatechange: null,
    onicecandidate:             null,
    ontrack:                    null,
  };
}

describe('PeerConnectionWrapper — DTLS fingerprint pinning', () => {
  it('pins fingerprints from setRemoteOffer', async () => {
    const w = new PeerConnectionWrapper({
      factory:    () => fakeRawPc(async () => new Map()),
      iceServers: [],
    });
    await w.setRemoteOffer(sdpWith('sha-256', PEER_FP_HEX_COLONED));
    expect(w.pinnedFingerprintsForTests).toEqual([
      {algorithm: 'sha-256', fingerprint: PEER_FP_HEX_COLONED},
    ]);
  });

  it('pins fingerprints from acceptAnswer', async () => {
    const w = new PeerConnectionWrapper({
      factory:    () => fakeRawPc(async () => new Map()),
      iceServers: [],
    });
    await w.acceptAnswer(sdpWith('sha-256', PEER_FP_HEX_COLONED));
    expect(w.pinnedFingerprintsForTests).toEqual([
      {algorithm: 'sha-256', fingerprint: PEER_FP_HEX_COLONED},
    ]);
  });

  it('verifyDtlsSrtp succeeds when cert fingerprint matches pinned SDP fingerprint', async () => {
    const w = new PeerConnectionWrapper({
      factory: () => fakeRawPc(async () => new Map<string, StatsReport>([
        ['t0',   {type: 'transport',   dtlsState: 'connected', srtpCipher: 'AEAD_AES_128_GCM', remoteCertificateId: 'c-r'}],
        ['c-r',  {type: 'certificate', id: 'c-r', fingerprint: PEER_FP_HEX_COLONED, fingerprintAlgorithm: 'sha-256'}],
      ])),
      iceServers: [],
    });
    await w.setRemoteOffer(sdpWith('sha-256', PEER_FP_HEX_COLONED));
    await expect(w.verifyDtlsSrtp()).resolves.toEqual({dtlsState: 'connected', srtpCipher: 'AEAD_AES_128_GCM'});
  });

  it('verifyDtlsSrtp throws on cert fingerprint mismatch (MITM cert swap)', async () => {
    const w = new PeerConnectionWrapper({
      factory: () => fakeRawPc(async () => new Map<string, StatsReport>([
        ['t0',   {type: 'transport',   dtlsState: 'connected', srtpCipher: 'AEAD_AES_128_GCM', remoteCertificateId: 'c-r'}],
        ['c-r',  {type: 'certificate', id: 'c-r', fingerprint: ATTACKER_FP_HEX, fingerprintAlgorithm: 'sha-256'}],
      ])),
      iceServers: [],
    });
    await w.setRemoteOffer(sdpWith('sha-256', PEER_FP_HEX_COLONED));
    await expect(w.verifyDtlsSrtp()).rejects.toThrow(/DTLS fingerprint pin MISMATCH/);
  });

  it('verifyDtlsSrtp throws when SDP carried no fingerprint line (fail-closed)', async () => {
    const w = new PeerConnectionWrapper({
      factory: () => fakeRawPc(async () => new Map<string, StatsReport>([
        ['t0',   {type: 'transport',   dtlsState: 'connected', srtpCipher: 'AEAD_AES_128_GCM', remoteCertificateId: 'c-r'}],
        ['c-r',  {type: 'certificate', id: 'c-r', fingerprint: PEER_FP_HEX_COLONED, fingerprintAlgorithm: 'sha-256'}],
      ])),
      iceServers: [],
    });
    await w.setRemoteOffer('v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n');
    await expect(w.verifyDtlsSrtp()).rejects.toThrow(/remote SDP carried no a=fingerprint line/);
  });

  it('verifyDtlsSrtp throws when engine reports no certificate stat (fail-closed)', async () => {
    const w = new PeerConnectionWrapper({
      factory: () => fakeRawPc(async () => new Map<string, StatsReport>([
        ['t0',   {type: 'transport', dtlsState: 'connected', srtpCipher: 'AEAD_AES_128_GCM'}],
      ])),
      iceServers: [],
    });
    await w.setRemoteOffer(sdpWith('sha-256', PEER_FP_HEX_COLONED));
    await expect(w.verifyDtlsSrtp()).rejects.toThrow(/no certificate stat/);
  });

  it('verifyDtlsSrtp throws when called before any remote SDP applied (defensive)', async () => {
    const w = new PeerConnectionWrapper({
      factory: () => fakeRawPc(async () => new Map<string, StatsReport>([
        ['t0',   {type: 'transport',   dtlsState: 'connected', srtpCipher: 'AEAD_AES_128_GCM', remoteCertificateId: 'c-r'}],
        ['c-r',  {type: 'certificate', id: 'c-r', fingerprint: PEER_FP_HEX_COLONED, fingerprintAlgorithm: 'sha-256'}],
      ])),
      iceServers: [],
    });
    await expect(w.verifyDtlsSrtp()).rejects.toThrow(/no remote SDP applied/);
  });

  it('verifyDtlsSrtp accepts flat-hex cert fingerprint matching colon-hex SDP', async () => {
    const w = new PeerConnectionWrapper({
      factory: () => fakeRawPc(async () => new Map<string, StatsReport>([
        ['t0',   {type: 'transport',   dtlsState: 'connected', srtpCipher: 'AEAD_AES_128_GCM', remoteCertificateId: 'c-r'}],
        ['c-r',  {type: 'certificate', id: 'c-r', fingerprint: PEER_FP_HEX_COLONED.replace(/:/g, ''), fingerprintAlgorithm: 'sha-256'}],
      ])),
      iceServers: [],
    });
    await w.setRemoteOffer(sdpWith('sha-256', PEER_FP_HEX_COLONED));
    await expect(w.verifyDtlsSrtp()).resolves.toMatchObject({dtlsState: 'connected'});
  });

  it('verifyDtlsSrtp falls back to first certificate stat when transport.remoteCertificateId is missing', async () => {
    const w = new PeerConnectionWrapper({
      factory: () => fakeRawPc(async () => new Map<string, StatsReport>([
        ['t0',   {type: 'transport',   dtlsState: 'connected', srtpCipher: 'AEAD_AES_128_GCM'}],
        ['c-r',  {type: 'certificate', fingerprint: PEER_FP_HEX_COLONED, fingerprintAlgorithm: 'sha-256'}],
      ])),
      iceServers: [],
    });
    await w.setRemoteOffer(sdpWith('sha-256', PEER_FP_HEX_COLONED));
    await expect(w.verifyDtlsSrtp()).resolves.toMatchObject({dtlsState: 'connected'});
  });
});
