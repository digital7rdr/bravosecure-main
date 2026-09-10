/**
 * Audit P1-N6 — DTLS certificate continuity across ICE restart.
 *
 * Threat model: a MITM relay/TURN/SFU that survives the initial DTLS
 * handshake (because the initial SDP fingerprint matched the cert it
 * presented) waits for an ICE restart (network handover, Wi-Fi blip),
 * then substitutes its OWN fingerprint into the post-restart SDP and
 * presents its OWN cert in the post-restart DTLS handshake. Without
 * continuity, the pinned set rotates to the attacker's fingerprint
 * and the cert check still passes — but DTLS is now terminated by
 * the attacker, who can read media.
 *
 * Fix: snapshot the initial pinned set as a baseline. Every
 * subsequent setRemoteOffer/acceptAnswer MUST present a fingerprint
 * set that is a subset of the baseline. Any new fingerprint not in
 * the baseline = MITM attempt = throw, call torn down.
 */

import {PeerConnectionWrapper} from '../webrtc/peerConnection';
import type {PeerConnectionLike, StatsReport} from '../webrtc/types';

const ORIG_FP    = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';
const ATTACKER_FP = '11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00';

function sdpWith(algo: string, fpUpper: string): string {
  return `v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\na=fingerprint:${algo} ${fpUpper}\r\n`;
}

function emptyRawPc(): PeerConnectionLike {
  return {
    createOffer:  async () => ({type: 'offer',  sdp: 'unused'}),
    createAnswer: async () => ({type: 'answer', sdp: 'unused'}),
    setLocalDescription:  async () => {},
    setRemoteDescription: async () => {},
    addIceCandidate:      async () => {},
    addTrack:             () => {},
    close:                () => {},
    getStats: async () => new Map<string, StatsReport>(),
    oniceconnectionstatechange: null,
    onicecandidate:             null,
    ontrack:                    null,
  };
}

describe('DTLS cert continuity across ICE restart (P1-N6)', () => {
  it('first setRemoteOffer captures the baseline pin', async () => {
    const w = new PeerConnectionWrapper({factory: () => emptyRawPc(), iceServers: []});
    await w.setRemoteOffer(sdpWith('sha-256', ORIG_FP));
    expect(w.pinnedFingerprintsForTests).toEqual([
      {algorithm: 'sha-256', fingerprint: ORIG_FP},
    ]);
  });

  it('accepts a reanswer that re-emits the SAME fingerprint (legitimate ICE restart)', async () => {
    const w = new PeerConnectionWrapper({factory: () => emptyRawPc(), iceServers: []});
    await w.setRemoteOffer(sdpWith('sha-256', ORIG_FP));
    // ICE restart: peer's cert is unchanged, just new ufrag/pwd.
    await expect(w.acceptAnswer(sdpWith('sha-256', ORIG_FP))).resolves.toBeUndefined();
    expect(w.pinnedFingerprintsForTests).toEqual([
      {algorithm: 'sha-256', fingerprint: ORIG_FP},
    ]);
  });

  it('REJECTS a reanswer that substitutes a different fingerprint (MITM cert swap)', async () => {
    const w = new PeerConnectionWrapper({factory: () => emptyRawPc(), iceServers: []});
    await w.setRemoteOffer(sdpWith('sha-256', ORIG_FP));
    // Attacker intercepts the ICE-restart reanswer and rewrites the
    // fingerprint to their own cert.
    await expect(w.acceptAnswer(sdpWith('sha-256', ATTACKER_FP)))
      .rejects.toThrow(/DTLS cert continuity FAILED/);
  });

  it('REJECTS a reoffer (incoming) that introduces a new fingerprint', async () => {
    const w = new PeerConnectionWrapper({factory: () => emptyRawPc(), iceServers: []});
    await w.acceptAnswer(sdpWith('sha-256', ORIG_FP));
    // Mid-call reoffer (e.g. peer enables camera) — would normally
    // emit the same cert. An attacker swap rewrites it.
    await expect(w.setRemoteOffer(sdpWith('sha-256', ATTACKER_FP)))
      .rejects.toThrow(/DTLS cert continuity FAILED/);
  });

  it('preserves the baseline on rejection (post-mortem inspection)', async () => {
    const w = new PeerConnectionWrapper({factory: () => emptyRawPc(), iceServers: []});
    await w.setRemoteOffer(sdpWith('sha-256', ORIG_FP));
    await expect(w.acceptAnswer(sdpWith('sha-256', ATTACKER_FP)))
      .rejects.toThrow(/DTLS cert continuity FAILED/);
    // Baseline (and working set, since the attacker's set was never accepted) unchanged.
    expect(w.pinnedFingerprintsForTests).toEqual([
      {algorithm: 'sha-256', fingerprint: ORIG_FP},
    ]);
  });

  it('accepts a subset of the baseline (peer drops an m-section mid-call)', async () => {
    // A peer that disabled video might re-emit SDP with the same
    // session-level fingerprint but no per-m fingerprint. Subset is
    // legitimate; we only forbid INTRODUCING new fingerprints.
    const w = new PeerConnectionWrapper({factory: () => emptyRawPc(), iceServers: []});
    await w.setRemoteOffer(sdpWith('sha-256', ORIG_FP));
    await expect(w.acceptAnswer(sdpWith('sha-256', ORIG_FP))).resolves.toBeUndefined();
    // Now a reoffer with the same single fingerprint — still a subset.
    await expect(w.setRemoteOffer(sdpWith('sha-256', ORIG_FP))).resolves.toBeUndefined();
  });

  it('accepts two-algorithm baseline + later subset with only one algorithm', async () => {
    const orig384 = 'DD:EE:FF:' + ORIG_FP.slice(9);
    const baselineSdp = [
      'v=0',
      'o=- 1 1 IN IP4 0.0.0.0',
      `a=fingerprint:sha-256 ${ORIG_FP}`,
      `a=fingerprint:sha-384 ${orig384}`,
    ].join('\r\n');
    const w = new PeerConnectionWrapper({factory: () => emptyRawPc(), iceServers: []});
    await w.setRemoteOffer(baselineSdp);
    // Peer's reanswer emits only the sha-256 fingerprint — subset, OK.
    await expect(w.acceptAnswer(sdpWith('sha-256', ORIG_FP))).resolves.toBeUndefined();
  });

  it('REJECTS an empty fingerprint pin when the baseline had one (downgrade attempt)', async () => {
    const w = new PeerConnectionWrapper({factory: () => emptyRawPc(), iceServers: []});
    await w.setRemoteOffer(sdpWith('sha-256', ORIG_FP));
    // Attacker strips fingerprint from the reanswer entirely. Defence
    // in depth: pinRemoteFingerprints rejects at pin-time so the
    // subsequent verifyDtlsSrtp never has to discover the bypass.
    await expect(w.acceptAnswer('v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n'))
      .rejects.toThrow(/downgrade attempt/);
    // Baseline unchanged.
    expect(w.pinnedFingerprintsForTests).toEqual([
      {algorithm: 'sha-256', fingerprint: ORIG_FP},
    ]);
  });
});
