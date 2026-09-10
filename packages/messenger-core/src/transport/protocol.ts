/**
 * Mirror of apps/messenger-service/src/gateway/protocol.ts.
 *
 * Kept as a separate file (not a shared package) because the RN build
 * and the NestJS build have incompatible tsconfigs. When you change a
 * frame shape on the server, change it here in the same commit — type
 * drift is silent.
 */

export interface SessionAddress {
  userId:   string;
  deviceId: number;
}

export interface Ciphertext {
  type: 1 | 3;
  body: string;
}

export interface ClientPing {
  event: 'ping';
  data?: {ts: number};
}

/**
 * B-100/B-101 — in-place socket re-authentication. Sent whenever the app
 * obtains a fresh access token while a socket is open, so the gateway can
 * swap the socket's claims instead of disconnecting it when the old jti
 * leaves the Redis allowlist (a disconnect mid-call is fatal: 12s
 * disconnect-bye / 10s SFU leave grace, and reconnects are frozen while
 * the screen is locked). Server mirror in messenger-service protocol.ts.
 */
export interface ClientAuthRefresh {
  event: 'auth.refresh';
  data:  {token: string};
}

export interface ClientEnvelopeSend {
  event: 'envelope.send';
  data: {
    to:          SessionAddress;
    /**
     * Sealed Sender v2 outer ECIES wrap. Replaces the Phase-1
     * `{ciphertext, senderAddressHint}` pair: the libsignal SessionCipher
     * output and the sender's address now travel inside an X25519+AES-GCM
     * envelope keyed off the recipient's identity public key. The relay
     * treats this as opaque bytes and has no field that links the
     * envelope back to the sender.
     */
    outerSealed: string;
    clientMsgId: string;
    /**
     * Disappearing-message deadline (epoch seconds). When set, the relay
     * shrinks the envelope's Redis TTL so the sealed ciphertext
     * self-evicts at its advertised expiry even if the recipient never
     * comes online to ACK.
     */
    expiresAtSec?: number;
    /**
     * Killed-app wake suppression. Default (absent/true) keeps the
     * recipient's FCM data-wake for DISPLAYABLE envelopes (text/media).
     * Set `false` for NON-displayable envelopes (reactions, group-control
     * / rekey, key-request) so a killed device isn't woken by a phantom
     * banner for a frame that renders nothing. The relay/gateway honour
     * `urgent !== false` when deciding whether to fire the wake.
     */
    urgent?: boolean;
  };
}

/**
 * Ack-outcome split (handoff §3.6c). The ack has always meant BOTH
 * "delete this envelope from the relay" and "the recipient has it" —
 * the relay converted every ack into a sender-facing ✓✓
 * (`envelope.delivered`), including acks fired on terminal decrypt
 * failures (which the receiver sends on purpose to stop redelivery).
 * `disposition` separates the two meanings:
 *   'delivered' (default when absent — legacy clients keep today's
 *                behavior) → relay emits `envelope.delivered`;
 *   'discarded' → the receiving device destroyed the message (decrypt
 *                failure); relay deletes the envelope but emits
 *                `envelope.undeliverable` instead.
 * Metadata note: this discloses a one-bit decrypt outcome per envelope
 * to the relay — owner-approved 2026-07-03 (plaintext read-receipt
 * frames already disclose strictly more per envelope).
 */
export type AckDisposition = 'delivered' | 'discarded';

export interface ClientEnvelopeAck {
  event: 'envelope.ack';
  data: {
    envelopeId: string;
    /** See AckDisposition — absent means 'delivered' (legacy). */
    disposition?: AckDisposition;
    /**
     * Audit P0-N9 — possession-proof token issued by the relay in the
     * `envelope.deliver` frame (or the HTTP pull response). The relay
     * stores the token under `ack_token:{envelopeId}` with the same
     * TTL as the envelope; on ack it requires a constant-time match
     * before hard-deleting. Without this, any authenticated socket
     * could ack any envelope-id it owned — including ones it had
     * never received — and wipe undelivered messages from the relay
     * before the legitimate device pulled them.
     *
     * Optional during the rollout window so legacy clients can still
     * ack their pending envelopes. The server enforces the token
     * STRICTLY when present; missing tokens fall back to the
     * recipient-identity check (the legacy semantics) and emit a
     * warning that's surfaced in telemetry.
     */
    ackToken?: string;
  };
}

export interface ClientEnvelopePull {
  event: 'envelope.pull';
  data?: {
    after?: string;
    limit?: number;
    /**
     * Restore-after-reinstall fix #4 — bootstrap pulls bypass the
     * normal limit cap. Set to `true` on the FIRST pull after a
     * fresh install so the client gets every pending envelope in
     * one round-trip rather than the default 50/100.
     */
    bootstrap?: boolean;
  };
}

// ─── WebRTC call signalling (M8) — mirror of server protocol.ts ─────

export type CallId = string;

/**
 * Audit S7 — caller-identity binding for `call.offer`. Without this the
 * frame body (callId/to/sdp/kind) was end-to-end unauthenticated; a
 * compromised relay could ring a callee under a forged `from` identity.
 *
 * Wire shape: `{cert, aad, sig}` produced by `signCallOfferAuth(...)` in
 * messenger-core. The relay forwards opaquely; verification happens
 * end-to-end on the callee via `verifyCallOfferAuth(...)`.
 */
export interface CallOfferAuthBlock {
  /** XEd25519 sender cert from auth-service (header.payload.sig). */
  cert: string;
  /** Bound AAD — fields the cert holder swore to. */
  aad: {
    v: number;
    callId: string;
    from: {userId: string; deviceId: number};
    to:   {userId: string; deviceId: number};
    kind: 'voice' | 'video';
    ts:   number;
  };
  /** Base64 XEd25519 signature over canonical-bytes(aad). */
  sig: string;
}

export interface ClientCallOffer {
  event: 'call.offer';
  data: {
    callId: CallId; to: SessionAddress; sdp: string; kind: 'voice' | 'video';
    /**
     * Audit S7 — caller-identity binding. Required end-to-end on the
     * callee. Optional on the wire during the rollout window so legacy
     * peers don't break; receivers SHOULD fail-closed once telemetry
     * shows zero legacy offers in flight.
     */
    auth?: CallOfferAuthBlock;
  };
}
/**
 * Audit P1-C3 — caller-identity binding for `call.answer`. Mirrors the
 * S7 / callOfferAuth shape but with a per-kind body hash (so an answer
 * sig cannot be replayed as a media-state advisory and vice versa).
 *
 * Wire shape: `{cert, aad, sig}` produced by `signCallControlAuth(...)`
 * in messenger-core. The relay forwards opaquely; verification happens
 * end-to-end on the receiver via `verifyCallControlAuth(...)`.
 */
export interface CallControlAuthBlock {
  cert: string;
  aad: {
    v:        number;
    kind:     'call.answer' | 'call.media-state';
    callId:   string;
    from:     {userId: string; deviceId: number};
    to:       {userId: string; deviceId: number};
    /** Base64 SHA-256 of the canonical body bytes. */
    bodyHash: string;
    ts:       number;
  };
  sig: string;
}

export interface ClientCallAnswer {
  event: 'call.answer';
  data: {
    callId: CallId; to: SessionAddress; sdp: string;
    /**
     * Audit P1-C3 — answerer-identity binding. Optional on the wire
     * during the rollout window; receivers fail-closed once telemetry
     * confirms 100% of clients send it.
     */
    auth?: CallControlAuthBlock;
  };
}
export interface ClientCallIce {
  event: 'call.ice';
  data: {
    callId: CallId; to: SessionAddress; candidate: string;
    sdpMid?: string | null; sdpMLineIndex?: number | null;
  };
}
export interface ClientCallHangup {
  event: 'call.hangup';
  data: {callId: CallId; to: SessionAddress; reason: 'busy'|'declined'|'ended'|'failed'};
}

/**
 * BS-021 — peer-mute / peer-camera-off advisory.
 *
 *   The 1:1 P2P pipeline doesn't have a way for the peer to know when
 *   you flip `videoTrack.enabled = false`: RTP just stops, but the
 *   remote SurfaceView keeps painting the last decoded frame so the
 *   receiver sees a static image and can't tell if you muted your
 *   camera or if the network froze.
 *
 *   The fix is purely advisory: sender flips the track, fires this
 *   frame, receiver hides the remote tile and shows a "Camera off"
 *   placeholder. This does NOT affect SRTP — security stays intact.
 *
 *   The frame is server-relayed verbatim (gateway only forwards;
 *   never persists). On legacy peers that don't understand it, the
 *   server-side `forwardToDevice` returns `peer_offline`-style errors
 *   only when the user is offline; an unknown event name is a no-op
 *   on the receiver because the dispatcher's switch falls through.
 */
export interface ClientCallMediaState {
  event: 'call.media-state';
  data: {
    callId:     CallId;
    to:         SessionAddress;
    /** True when the LOCAL camera track is disabled. */
    cameraOff:  boolean;
    /** True when the LOCAL mic track is disabled (muted). */
    micOff:     boolean;
    /**
     * Audit P1-C2 — sender-identity binding. Optional during rollout;
     * receivers fail-closed (drop the frame) once telemetry shows 100%
     * of clients are sending.
     */
    auth?:      CallControlAuthBlock;
  };
}

/**
 * Mid-call SDP renegotiation — voice→video upgrade. Distinct from
 * `call.offer` so the recipient routes via callId match to the EXISTING
 * controller instead of mounting a fresh CallScreen. Pure relay: not
 * queued offline, no VoIP push (peer is already mid-call so by
 * definition online). On a peer running an older client that doesn't
 * understand the frame the dispatcher's switch falls through with a
 * no-op; the initiator's local watchdog (callController.upgradeToVideo)
 * times out and rolls back the half-applied upgrade so the call stays
 * voice-only and connected.
 *
 *   reoffer  — initiator (the side adding a video track) calls
 *              pc.setLocalDescription(createOffer()), ships the SDP.
 *   reanswer — responder applies the remote offer, optionally adds
 *              its own video, calls pc.createAnswer(), ships the SDP.
 */
export interface ClientCallReOffer {
  event: 'call.reoffer';
  data: {callId: CallId; to: SessionAddress; sdp: string};
}

export interface ClientCallReAnswer {
  event: 'call.reanswer';
  data: {callId: CallId; to: SessionAddress; sdp: string};
}

// ─── Ephemeral signals (M11) — mirror ────────────────────────────────

export interface ClientTyping {
  event: 'typing';
  data:  {to: SessionAddress; state: 'start' | 'stop'; convTag?: string};
}
export interface ClientReadReceipt {
  event: 'read-receipt';
  data:  {to: SessionAddress; envelopeIds: string[]};
}
export interface ClientPresence {
  event: 'presence';
  data:  {state: 'active' | 'away'};
}

/**
 * Subscribe to a list of users' presence. The server joins this socket
 * to each user's `watch` room and immediately emits a one-shot snapshot
 * so the contact-status UI can paint before the next state transition.
 */
export interface ClientPresenceSubscribe {
  event: 'presence.subscribe';
  data:  {userIds: string[]};
}
export interface ClientPresenceUnsubscribe {
  event: 'presence.unsubscribe';
  data:  {userIds: string[]};
}

/** Audit fix 5.1 — mission lifecycle subscription (mirror of server). */
export interface ClientMissionSubscribe {
  event: 'mission.subscribe';
  data:  {missionId: string};
}
export interface ClientMissionUnsubscribe {
  event: 'mission.unsubscribe';
  data:  {missionId: string};
}

export type ClientFrame =
  | ClientPing
  | ClientAuthRefresh
  | ClientEnvelopeSend
  | ClientEnvelopeAck
  | ClientEnvelopePull
  | ClientCallOffer
  | ClientCallAnswer
  | ClientCallIce
  | ClientCallHangup
  | ClientCallMediaState
  | ClientCallReOffer
  | ClientCallReAnswer
  | ClientTyping
  | ClientReadReceipt
  | ClientPresence
  | ClientPresenceSubscribe
  | ClientPresenceUnsubscribe
  | ClientMissionSubscribe
  | ClientMissionUnsubscribe;

export interface ServerPong {
  event: 'pong';
  data: {ts: number};
}

export interface ServerEnvelopeAccepted {
  event: 'envelope.accepted';
  data: {
    clientMsgId: string;
    envelopeId:  string;
    /**
     * M12: capability token the sender stores to retract this envelope
     * before the recipient pulls it. Single-use; absence means the
     * server didn't issue one (older deploys) — caller falls back to
     * waiting on dwell expiry.
     */
    retractToken?: string;
  };
}

export interface ServerEnvelopeDeliver {
  event: 'envelope.deliver';
  data: {
    envelopeId:  string;
    /** Sealed Sender v2 outer ECIES wrap — see ClientEnvelopeSend.outerSealed. */
    outerSealed: string;
    timestamp:   number;
    /**
     * Optional sender-supplied dedup id. The server forwards whatever the
     * sender put on `ClientEnvelopeSend.clientMsgId`; recipients use it to
     * collapse the N pairwise copies of one logical group message.
     */
    clientMsgId?: string;
    /**
     * Optional dwell expiry (Unix seconds). Set when the sender requested a
     * disappearing-message TTL; recipients schedule local deletion.
     */
    expiresAtSec?: number;
    /**
     * Optional one-shot retract token, issued by the relay so a sender can
     * "delete for everyone" within the dwell window without proving identity
     * a second time.
     */
    retractToken?: string;
    /**
     * Audit P0-N9 — possession-proof token. Random per-envelope value
     * minted by the relay on FIRST delivery and stored with the same
     * TTL as the envelope. The recipient must present this token back
     * on `envelope.ack` (and on POST /envelopes/:id/ack). Optional
     * during the rollout window so legacy clients aren't broken; the
     * server requires it strictly once a future config flag flips.
     */
    ackToken?: string;
  };
}

/**
 * Audit P0-T6 — sender-facing "delivered" notification. Fired when the
 * recipient device acks the envelope (i.e. it pulled the ciphertext off
 * the relay and durably stored the decrypted plaintext). The sender uses
 * this to advance the local bubble from single-tick `sent` → double-tick
 * `delivered`. Read receipts continue to carry the further transition
 * to `read`, gated by the recipient's privacy setting.
 *
 * The wire payload carries ONLY the envelopeId — the sender already
 * minted the local clientMsgId and stored the envelopeId on the bubble
 * when `envelope.accepted` arrived, so matching by envelopeId is enough.
 * Sealed-sender is preserved: the relay's submitter-mapping lives in a
 * transient Redis key (`submitter:{envelopeId}`) that is deleted as part
 * of the ack flow, so no link between envelope ciphertext and submitter
 * identity persists past the dwell window.
 */
export interface ServerEnvelopeDelivered {
  event: 'envelope.delivered';
  data: {
    envelopeId: string;
  };
}

/**
 * Handoff §3.6(c) — sender-facing "destroyed" notification, the honest
 * counterpart of `envelope.delivered`. Fired when the recipient device
 * acks with `disposition: 'discarded'` (terminal decrypt failure — the
 * message will never render there). The sender flips the bubble to
 * `undelivered` instead of showing a lying ✓✓. Same submitter-mapping
 * privacy posture as `envelope.delivered` (transient Redis key, WS
 * submits only).
 */
export interface ServerEnvelopeUndeliverable {
  event: 'envelope.undeliverable';
  data: {
    envelopeId: string;
  };
}

export interface ServerError {
  event: 'error';
  data: {code: string; message: string};
}

export interface ServerCallOffer {
  event: 'call.offer';
  data: {
    callId: CallId; from: SessionAddress; sdp: string; kind: 'voice' | 'video';
    /** Audit S7 — forwarded verbatim from the caller; relay never inspects. */
    auth?: CallOfferAuthBlock;
  };
}
export interface ServerCallAnswer {
  event: 'call.answer';
  data: {
    callId: CallId; from: SessionAddress; sdp: string;
    /** Audit P1-C3 — forwarded verbatim from the answerer; relay never inspects. */
    auth?:  CallControlAuthBlock;
  };
}
export interface ServerCallIce {
  event: 'call.ice';
  data: {
    callId: CallId; from: SessionAddress; candidate: string;
    sdpMid?: string | null; sdpMLineIndex?: number | null;
  };
}
export interface ServerCallHangup {
  event: 'call.hangup';
  data: {callId: CallId; from: SessionAddress; reason: 'busy'|'declined'|'ended'|'failed'};
}

/**
 * BS-021 — server-side mirror of the client media-state advisory.
 * `from` is the peer who toggled their track; receiver flips the
 * remote tile placeholder accordingly.
 */
export interface ServerCallMediaState {
  event: 'call.media-state';
  data: {
    callId:    CallId;
    from:      SessionAddress;
    cameraOff: boolean;
    micOff:    boolean;
    /** Audit P1-C2 — forwarded verbatim from the sender; relay never inspects. */
    auth?:     CallControlAuthBlock;
  };
}

/**
 * Server-side mirrors of the renegotiation frames. `from` is the peer
 * who initiated (reoffer) or replied to (reanswer) the renegotiation.
 */
export interface ServerCallReOffer {
  event: 'call.reoffer';
  data: {callId: CallId; from: SessionAddress; sdp: string};
}

export interface ServerCallReAnswer {
  event: 'call.reanswer';
  data: {callId: CallId; from: SessionAddress; sdp: string};
}

/**
 * SYNC-6 — `convTag` is an OPAQUE 16-hex scope token bound to the
 * {sender, recipient} pair (see `typingConversationTag`). It is never the
 * group id: two members of the same group receive different tags, so the
 * relay cannot cluster it into a membership set. Absent = legacy peer.
 */
export interface ServerTyping {
  event: 'typing';
  data:  {from: SessionAddress; state: 'start' | 'stop'; convTag?: string};
}
export interface ServerReadReceipt {
  event: 'read-receipt';
  data:  {from: SessionAddress; envelopeIds: string[]};
}
export interface ServerPresence {
  event: 'presence';
  data:  {
    userId: string;
    /**
     * `online` — connected, no active/away hint yet
     * `active` — foreground + interacting
     * `away`   — backgrounded / idle
     * `offline` — no sockets for this user anywhere in the cluster
     */
    state:  'online' | 'active' | 'away' | 'offline';
    /** epoch ms of the last state transition. */
    lastSeenMs?: number;
  };
}

/** Audit fix 5.1 — mission lifecycle frames pushed to subscribed clients. */
export interface ServerMissionStatus {
  event: 'mission.status';
  data: {
    missionId: string;
    status?:   string;
    sosAcked?: boolean;
    ackedBy?:  string;
    ts:        number;
  };
}
export interface ServerMissionTeam {
  event: 'mission.team';
  data: {missionId: string; ts: number};
}
export interface ServerMissionTelemetry {
  event: 'mission.telemetry';
  data: {
    missionId:  string;
    lat:        number;
    lng:        number;
    recordedAt: string;
    ts:         number;
  };
}
export interface ServerMissionSubscribed {
  event: 'mission.subscribed';
  data:  {missionId: string};
}
export interface ServerMissionUnsubscribed {
  event: 'mission.unsubscribed';
  data:  {missionId: string};
}

export type ServerFrame =
  | ServerPong
  | ServerEnvelopeAccepted
  | ServerEnvelopeDeliver
  | ServerEnvelopeDelivered
  | ServerEnvelopeUndeliverable
  | ServerError
  | ServerCallOffer
  | ServerCallAnswer
  | ServerCallIce
  | ServerCallHangup
  | ServerCallMediaState
  | ServerCallReOffer
  | ServerCallReAnswer
  | ServerTyping
  | ServerReadReceipt
  | ServerPresence
  | ServerMissionStatus
  | ServerMissionTeam
  | ServerMissionTelemetry
  | ServerMissionSubscribed
  | ServerMissionUnsubscribed;

export const WS_CLOSE_UNAUTHORIZED = 4401;
export const WS_CLOSE_POLICY       = 4403;
export const WS_CLOSE_HEARTBEAT    = 4408;
