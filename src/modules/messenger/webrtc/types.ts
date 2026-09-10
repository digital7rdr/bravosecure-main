import type {SessionAddress} from '@bravo/messenger-core';

export type CallKind = 'voice' | 'video';
export type HangupReason = 'busy' | 'declined' | 'ended' | 'failed';

export type CallState =
  | 'idle'
  | 'calling'       // outgoing offer sent, awaiting answer
  | 'ringing'       // inbound offer received, awaiting user accept
  | 'connecting'    // answer exchanged, ICE in progress
  | 'connected'     // ICE complete + DTLS-SRTP verified
  | 'reconnecting'  // ICE went disconnected mid-call; restart in flight
  | 'ended'
  | 'failed';

export interface CallDescriptor {
  callId:  string;
  peer:    SessionAddress;
  kind:    CallKind;
  /** 'outgoing' means WE offered. */
  direction: 'outgoing' | 'incoming';
}

/**
 * Minimal subset of the WebRTC RTCPeerConnection API that the call
 * controller actually needs. Keeps tests decoupled from the native
 * react-native-webrtc module (which won't load under Jest/node).
 */
export interface PeerConnectionLike {
  setLocalDescription(desc: {type: 'offer' | 'answer'; sdp: string}): Promise<void>;
  setRemoteDescription(desc: {type: 'offer' | 'answer'; sdp: string}): Promise<void>;
  createOffer(): Promise<{type: 'offer'; sdp: string}>;
  createAnswer(): Promise<{type: 'answer'; sdp: string}>;
  addIceCandidate(c: IceCandidateInit): Promise<void>;
  addTrack(track: unknown): void;
  getStats(): Promise<Iterable<StatsReport> | Map<string, StatsReport>>;
  close(): void;
  oniceconnectionstatechange: ((state: string) => void) | null;
  // The WebRTC API fires this with an RTCPeerConnectionIceEvent whose
  // `.candidate` holds the actual candidate (null on end-of-candidates) —
  // NOT the candidate directly. Typing it as the event matches the native
  // contract and the controller's handler; the earlier (cand) => void shape
  // mis-described it and let a "treat the event as the candidate" bug slip in.
  onicecandidate: ((event: {candidate?: IceCandidateInit | null}) => void) | null;
  ontrack: ((event: {streams: unknown[]}) => void) | null;
  /**
   * W3C signaling state — used by the controller's renegotiation lock
   * to detect glare (both sides simultaneously firing call.reoffer).
   * Optional in this interface so test fakes don't have to implement
   * it; the controller treats `undefined` as 'stable' for fakes.
   * Real RN-WebRTC always populates it on RTCPeerConnection.
   */
  signalingState?: string;
}

export interface IceCandidateInit {
  candidate:    string;
  sdpMid?:      string | null;
  sdpMLineIndex?: number | null;
}

/** Narrow subset of RTCStatsReport entries we consume in verifyDtlsSrtp. */
export interface StatsReport {
  type:            string;
  dtlsState?:      string;
  srtpCipher?:     string;
  selectedCandidatePairId?:      string;
  selectedCandidatePairChanges?: number;
  /**
   * Audit P0-N3 — DTLS fingerprint pinning. The W3C webrtc-stats spec
   * exposes the remote DTLS cert's fingerprint via a `certificate`
   * report referenced by `transport.remoteCertificateId`. RN-WebRTC
   * forwards both fields when libwebrtc populates them.
   */
  remoteCertificateId?:  string;
  /** Hex-encoded fingerprint of the remote DTLS cert (cert stat). */
  fingerprint?:          string;
  /** Hash algorithm name (e.g. 'sha-256') used to compute `fingerprint`. */
  fingerprintAlgorithm?: string;
  [k: string]:     unknown;
}

export type PeerConnectionFactory = (cfg: {
  iceServers: Array<{urls: string | string[]; username?: string; credential?: string}>;
  /**
   * 'max-bundle' forces all m-lines to share a single ICE/DTLS transport
   * from the start. Without this (default 'balanced'), libwebrtc
   * provisionally spawns one transport per BUNDLE group and only fuses
   * them after the answer arrives. In RN-WebRTC the post-answer fusion
   * doesn't always complete cleanly: the answerer trickles candidates
   * only for mid=0, mid=1's transport stays in 'checking' forever, and
   * the overall PC never reaches 'connected' — symptom: voice calls
   * (1 m-line) work but video calls (2 m-lines) hang in 'connecting'.
   */
  bundlePolicy?:    'balanced' | 'max-compat' | 'max-bundle';
  rtcpMuxPolicy?:   'negotiate' | 'require';
  /**
   * Number of candidates to pre-gather as soon as the PC is built
   * (before setLocalDescription). Saves ~1-2s of pre-flight latency
   * on the first call after PC creation — important on cellular
   * networks where the 15s ICE checking window is tight.
   */
  iceCandidatePoolSize?: number;
  /**
   * 'relay' forces every candidate to be a TURN relay. On cellular
   * CGNAT, host/srflx candidates always fail and just burn the ICE
   * timeout before reaching the relay pair that works. 'all' is the
   * default and tries everything in priority order.
   */
  iceTransportPolicy?:   'all' | 'relay';
}) => PeerConnectionLike;

/** Optional ICE servers config alias, for callers that need a typed cfg literal. */
export type IceServerConfig = {urls: string | string[]; username?: string; credential?: string};
