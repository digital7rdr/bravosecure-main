/**
 * B-41 hardening -- 1:1 ICE transport policy.
 *
 * Root cause of B-41 (calls stuck forever on "Answering"): the 1:1 path
 * hard-coded iceTransportPolicy:'relay', so when coturn rejected the
 * app's TURN credentials (a TURN_STATIC_AUTH_SECRET drift) there were
 * ZERO usable ICE candidates and the call never connected.
 *
 * Fix: default to 'all' (host + srflx + relay -- same as the group/SFU
 * path), so a TURN outage degrades gracefully instead of bricking every
 * call. EXPO_PUBLIC_ICE_RELAY_ONLY=true restores relay-only; an explicit
 * iceTransportPolicy option always wins.
 *
 * These tests assert the config the wrapper hands to the PC factory.
 *
 * NOTE: the env var is read/written via a COMPUTED key (process.env[KEY])
 * on purpose -- a static `process.env.EXPO_PUBLIC_*` reference makes
 * babel-preset-expo inject an `expo/virtual/env` import, which the
 * messenger-crypto jest project (plain @babel/preset-env, no expo) cannot
 * transform. The runtime code under test uses the same indirection.
 */

import {PeerConnectionWrapper} from '../webrtc/peerConnection';
import type {PeerConnectionLike, StatsReport} from '../webrtc/types';

const ENV_KEY = 'EXPO_PUBLIC_ICE_RELAY_ONLY';

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

/** Capture the config passed to the factory. */
function spyFactory() {
  const calls: Array<Record<string, unknown>> = [];
  const factory = (cfg: Record<string, unknown>): PeerConnectionLike => {
    calls.push(cfg);
    return emptyRawPc();
  };
  return {calls, factory};
}

describe('1:1 ICE transport policy (B-41 hardening)', () => {
  const PRIOR = process.env[ENV_KEY];
  afterEach(() => {
    if (PRIOR === undefined) {delete process.env[ENV_KEY];}
    else {process.env[ENV_KEY] = PRIOR;}
  });

  it("defaults to 'all' (no env, no override) -- coturn is not a single point of failure", () => {
    delete process.env[ENV_KEY];
    const {calls, factory} = spyFactory();
    // eslint-disable-next-line no-new
    new PeerConnectionWrapper({factory, iceServers: []});
    expect(calls[0].iceTransportPolicy).toBe('all');
  });

  it("resolves 'relay' when EXPO_PUBLIC_ICE_RELAY_ONLY=true (escape hatch)", () => {
    process.env[ENV_KEY] = 'true';
    const {calls, factory} = spyFactory();
    // eslint-disable-next-line no-new
    new PeerConnectionWrapper({factory, iceServers: []});
    expect(calls[0].iceTransportPolicy).toBe('relay');
  });

  it("treats any non-'true' env value as the default 'all'", () => {
    process.env[ENV_KEY] = 'false';
    const {calls, factory} = spyFactory();
    // eslint-disable-next-line no-new
    new PeerConnectionWrapper({factory, iceServers: []});
    expect(calls[0].iceTransportPolicy).toBe('all');
  });

  it('explicit iceTransportPolicy option overrides env', () => {
    process.env[ENV_KEY] = 'true';
    const {calls, factory} = spyFactory();
    // eslint-disable-next-line no-new
    new PeerConnectionWrapper({factory, iceServers: [], iceTransportPolicy: 'all'});
    expect(calls[0].iceTransportPolicy).toBe('all');
  });

  it('preserves the other ICE invariants (max-bundle, rtcp-mux, pool 0)', () => {
    delete process.env[ENV_KEY];
    const {calls, factory} = spyFactory();
    // eslint-disable-next-line no-new
    new PeerConnectionWrapper({factory, iceServers: []});
    expect(calls[0].bundlePolicy).toBe('max-bundle');
    expect(calls[0].rtcpMuxPolicy).toBe('require');
    expect(calls[0].iceCandidatePoolSize).toBe(0);
  });
});
