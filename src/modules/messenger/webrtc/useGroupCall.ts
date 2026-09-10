/**
 * useGroupCall — mediasoup-client SFU group call with WhatsApp-style
 * ringing, end-to-end identity binding, and host-only moderation.
 *
 * Lifecycle (matches the server sfu.* protocol verbatim):
 *
 *   1. POST /sfu/rooms (with conversationId)         → opaque roomId
 *      (server reuses the existing room if one is live for this convo)
 *   2. WS  sfu.ring (on outgoing only)               → fans rings to recipients
 *   3. WS  sfu.join {roomId}                          → routerRtpCaps,
 *                                                       send + recv transport params,
 *                                                       participantTag, isHost,
 *                                                       existingProducers
 *   4. Device.load({routerRtpCapabilities})
 *   5. Device.createSendTransport(sendParams)         → relay-only ICE
 *      .on('connect',  ...) → sfu.transport.connect
 *      .on('produce',  ...) → sfu.produce
 *   6. Device.createRecvTransport(recvParams)         → same connect plumbing
 *   7. Broadcast `groupCallPresence` envelope to every other group
 *      member so they can map our opaque participantTag to our display
 *      name. SFU never sees the mapping.
 *   8. produce(local audio + (video if isVideo)) → server fans `sfu.new-producer`
 *   9. for each existing + new producer:
 *        WS sfu.consume → consumerId, rtpParameters
 *        recvTransport.consume → MediaStream tile
 *        WS sfu.consumer.resume → media starts flowing
 *  10. Listen for sfu.muted / sfu.kicked → flip state / leave
 *  11. WS sfu.leave on hangup; clear identity registry.
 *
 * Security:
 *   - DTLS-SRTP terminates between client and the SFU's WebRtcTransport
 *   - Media is SRTP-encrypted on the wire — the SFU forwards SRTP
 *     packets without decrypting
 *   - participantTag is opaque (server-issued randomUUID) — the SFU
 *     access log never sees userIds
 *   - Identity (tag → displayName) ships through the existing E2E
 *     pairwise Signal sessions, never through the SFU
 */
import {GROUP_TERMINAL_STATES, type GroupCallState} from './groupCallStates';
import {useEffect, useRef, useState, useCallback} from 'react';
import {VIDEO_ENCODINGS, videoEncodings} from './videoEncodings';
import type { types as MediasoupTypes} from 'mediasoup-client';
import {Device} from 'mediasoup-client';
type Transport = MediasoupTypes.Transport;
type Producer  = MediasoupTypes.Producer;
type Consumer  = MediasoupTypes.Consumer;

/**
 * Audit BS-LEAK — minimize→restore mediasoup-handle holder.
 *
 * The boot hook owns the live mediasoup objects (Device, send/recv
 * Transports, Producers, Consumers, SFrame detachers, GroupCallEncryption)
 * inside its useRef closures. On minimize, keepAlive skips the unmount
 * teardown so the call keeps running — but the boot hook instance is then
 * gone, and its refs become unreachable. The RESTORED hook gets FRESH,
 * empty refs; the registry-sync effect re-binds `leave` to the restored
 * hook's leaveInternal, whose refs are null — so ending the call after a
 * restore closed NOTHING and leaked every transport/producer/consumer +
 * the camera/mic until process death.
 *
 * Fix: stash the live handles here (module-level, keyed by roomId) at the
 * end of boot, and rehydrate the restored hook's refs from this holder on
 * the adopt path. The holder is cleared by leaveInternal on real teardown
 * and by the logout reset, so it never outlives the call.
 *
 * It deliberately holds the SAME ref-container objects (the Maps/arrays),
 * not copies, so a producer consumed AFTER stash (via the original
 * handler, during the minimize window) is still visible to the restored
 * hook's teardown.
 */
interface LiveSfuHandles {
  device:               Device | null;
  sendTx:               Transport | null;
  recvTx:               Transport | null;
  transport:            TransportClient | null;
  producers:            Producer[];
  consumersByPid:       Map<string, Consumer>;
  consumerCleanups:     Map<string, Array<() => void>>;
  sframeDetachers:      Array<() => void>;
  groupEncryption:      FrameCryptorOrchestrator | null;
  participantTag:       string | null;
  // Audit F6 — the CURRENT registered SFU frame-handler's cleanup fn, stashed
  // at module scope so the restore/adopt path (a fresh hook instance whose own
  // cleanupSubRef is null) can GENUINELY release the prior handler before
  // registering its own. Without this the release was a no-op and every
  // minimize→restore leaked another handler (memory + double-consume).
  handlerCleanup?:      (() => void) | null;
  // Audit L14 — the boot IIFE's rejoin fn + the room token, stashed so the
  // restore/adopt path can re-arm ws.onReconnect→rejoin recovery (the adopt
  // path had none, so a WS drop after a minimize→restore zombied the call).
  // WI-3.1 — takes the attempt generation it is running as, so its writes can
  // be refused once a newer rejoin has superseded it.
  rejoinRoom?:          ((joined: SfuJoinedResp, attemptGen: number) => Promise<void>) | null;
  roomToken?:           string;
  /**
   * WI-3.4 — the consume-dedup sets.
   *
   * These are call-scoped, not hook-scoped, and leaving them out was a real
   * bug: the restore/adopt path rehydrated `consumersByPid` (populated) but
   * started `inFlightConsumes` / `consumedProducerIds` EMPTY, because they
   * were plain `useRef`s on the fresh instance. `consumeMissingAfterRestore`
   * then had no record that a producer was already consumed, re-issued
   * `recv.consume` for it, and mediasoup threw "consumer already exists" —
   * the exact B-17 class the reconcile exists to repair.
   *
   * EXCEPTION to the container-sharing rule in the header above:
   * `rejoinRoom` REPLACES these two Sets rather than clearing them in place,
   * so that a consume still in flight from before the rebuild releases its
   * in-flight lock into the orphaned Set instead of deleting the entry the
   * rebuild just made.
   *
   * That leaves a hook instance which adopted the OLD Sets on a pre-rejoin
   * snapshot — which is exactly why the rejoin republishes this stash and
   * fires `notifyLiveSfuHandles`. Every mounted instance re-adopts, so the
   * replacement is invisible to them. The two mechanisms are a pair; do not
   * remove one without the other.
   */
  inFlightConsumes:     Set<string>;
  consumedProducerIds:  Set<string>;
}
const liveSfuHandlesByRoom = new Map<string, LiveSfuHandles>();

/**
 * B-477 — "this room's live handles were replaced; re-read them".
 *
 * The stash exists because a minimize→restore mounts a NEW hook instance that
 * has to adopt the running call's mediasoup objects. What it did not cover is
 * what happens when those objects are REPLACED afterwards: `rejoinRoom` is
 * stashed and adopted, so the restored instance runs the ORIGINAL instance's
 * closure, and that closure writes the ORIGINAL instance's refs. The restored
 * hook was left holding the transports the rejoin had just closed —
 * `consumeMissingAfterRestore` issuing `recv.consume` against a dead transport
 * every 4 s, the audio-level poller bound to it, `leaveInternal` closing the
 * OLD pair so the new one leaked, and frozen tiles whose consumerIds blocked
 * the reconcile from ever rebuilding them.
 *
 * A rejoin now republishes the stash and fires this, and every mounted hook for
 * the room re-adopts. Re-adoption is pure ref assignment and idempotent, so the
 * instance that owns the rejoin re-adopting its own values is a no-op.
 */
const liveSfuHandleListeners = new Map<string, Set<() => void>>();

function subscribeLiveSfuHandles(roomId: string, fn: () => void): () => void {
  let set = liveSfuHandleListeners.get(roomId);
  if (!set) { set = new Set(); liveSfuHandleListeners.set(roomId, set); }
  set.add(fn);
  return () => {
    const live = liveSfuHandleListeners.get(roomId);
    if (!live) {return;}
    live.delete(fn);
    if (live.size === 0) {liveSfuHandleListeners.delete(roomId);}
  };
}

function notifyLiveSfuHandles(roomId: string): void {
  const set = liveSfuHandleListeners.get(roomId);
  if (!set) {return;}
  // Copy: a listener may unsubscribe (unmount) while we are iterating.
  for (const fn of [...set]) {
    try { fn(); } catch { /* one bad listener must not block the others */ }
  }
}

/**
 * Audit GC-06 (2026-07-02): mediasoup starts shipping RTP the moment
 * `produce()` resolves, but the SFrame sender cryptor can only attach to the
 * RtpSender AFTER produce returns it — leaving a brief window where real
 * frames reach the SFU unencrypted at the SFrame layer (still DTLS-SRTP on
 * the wire, but the SFU could see plaintext media). Blank the track
 * (enabled=false → black frames / silence) for the produce→attach window so
 * nothing meaningful leaves the device before the cryptor is live. Restores
 * the prior enabled state even on throw.
 */
/**
 * Video send encodings.
 *
 * B-121 — mirror the per-tag decode counters into the group-call trace file
 * (observability/fileLog.ts) so a RELEASE build is diagnosable. Same flag the
 * file logger itself uses, so one env var turns the whole trace on.
 */
const DECODE_DIAG = process.env.EXPO_PUBLIC_GROUPCALL_FILELOG === '1';

/**
 * B-123 — undo the false "paused" latch that GC-06 blanking causes.
 *
 * mediasoup decides a producer's initial paused state from the track it is
 * handed AT CONSTRUCTION:
 *     this._paused = disableTrackOnPause ? !track.enabled : false;   (Producer.js)
 * GC-06 deliberately sets track.enabled = false across produce() so no frame
 * can leave before the FrameCryptor is attached — so every producer we create
 * is born believing it is paused. withTrackBlanked's finally re-enables the
 * track, which is why the call looks fine, but mediasoup's flag stays wrong.
 *
 * It stays harmless until something calls replaceTrack, which re-applies it:
 *     if (this._paused) { this._track.enabled = false; }             (Producer.js)
 * i.e. a camera flip (or a B-20 camera recovery) installs a brand-new track
 * and immediately DISABLES it. Observed on device: the iPhone trace showed
 *     switchCamera swapped to=environment newTrack=live/enabled=false
 * and the Android peer saw dec:0/rx:0/B:0.
 *
 * resume() here is purely local state repair — it sets _paused = false and
 * re-enables the track, and only signals the server when zeroRtpOnPause is
 * set, which we never pass. It does NOT weaken GC-06: the blanking still
 * covers the whole produce+attach window, we only correct the flag afterwards.
 */
function clearBlankedPauseLatch(prod: unknown): void {
  try { (prod as {resume?: () => void} | null)?.resume?.(); } catch { /* best-effort */ }
}

/**
 * Review round 2 — re-entrancy state for withTrackBlanked.
 *
 * Two overlapping rejoins can both blank the SAME local track. The old
 * single-frame version captured `wasEnabled` per call, so the inner one saw
 * `enabled === false` (the outer had already blanked it), recorded "was off",
 * and its `finally` declined to restore. Net result: the microphone or camera
 * stayed disabled for the rest of the call while the UI showed it live.
 *
 * Depth-counted, with the ORIGINAL state recorded once by the outermost
 * entrant and restored once at the outermost exit. GC-06 is unchanged: the
 * track is blanked for the whole produce+attach window either way.
 */
const blankedTracks = new Map<object, {depth: number; wasEnabled: boolean}>();

async function withTrackBlanked<T>(track: unknown, fn: () => Promise<T>): Promise<T> {
  const t = track as {enabled?: boolean} | null | undefined;
  if (!t) { return await fn(); }
  const key = t as object;
  const existing = blankedTracks.get(key);
  const rec = existing ?? {depth: 0, wasEnabled: t.enabled === true};
  rec.depth += 1;
  blankedTracks.set(key, rec);
  if (rec.wasEnabled) {t.enabled = false;}
  try { return await fn(); }
  finally {
    rec.depth -= 1;
    if (rec.depth <= 0) {
      blankedTracks.delete(key);
      if (rec.wasEnabled) {t.enabled = true;}
    }
  }
}

/** Logout reset — drop any stashed handles so they don't pin a prior user's transports. */
export function clearAllLiveSfuHandles(): void {
  liveSfuHandlesByRoom.clear();
  liveSfuHandleListeners.clear();
  // WI-3.1 — the attempt counters are call state too; a stale counter would
  // let a signed-out session's in-flight attempt match the next one's number.
  clearAllAttempts();
  // WI-3.3 — the ownership-checked release is right for a hook teardown but
  // wrong here: on logout there is no owner left to ask, and leaving a handler
  // installed would keep a closure into the previous user's call alive. This
  // is the one place the UNCONDITIONAL clear is correct.
  clearGroupCallRejoinHandler();
}
import type { MediaStreamTrack} from 'react-native-webrtc';
import {MediaStream, mediaDevices} from 'react-native-webrtc';
import {getLocalMedia, localVideoConstraints, recoverGroupCamera} from './peerConnectionFactory';
// SFU rooms + TURN credentials are served by the messenger-service
// (NOT auth-service). Hitting MSG_BASE_URL gave 404 in staging because
// auth.94-136-184-52.sslip.io has no /sfu/* or /webrtc/* routes — the
// SFU + TURN controllers are mounted on relay.94-136-184-52.sslip.io.
import {MSG_BASE_URL} from '@utils/constants';
// BS-GC-ICE — release-visible diagnostics. `console.*` is NOT routed to
// logcat on a release Hermes build, so group-call media failures were
// invisible in field logs. crashLog writes a Crashlytics breadcrumb
// (PII-redacted) so the selected ICE candidate pair + TURN result show up
// in the Firebase console for a device whose media won't traverse.
import {log as crashLog} from '../../observability/crashlytics';
import {getLiveTransport, waitForLiveTransport} from '../runtime/transportRegistry';
import {registerSfuHandler} from './sfuDispatcher';
import {shouldSendRingCancel} from './ringCancelDecision';
import type {CallQualitySample} from '../runtime/callQuality';
import {isVideoForCall} from './groupCallMediaMode';
import {waitForGroupCallKey, armVideoEncryptorRetry} from './groupCallKeyWait';
import {shouldOwnerResyncOnJoin} from './callKeyResync';
import {attemptSfuRejoin} from './groupCallReconnect';
import {
  setGroupCallRejoinHandler, clearGroupCallRejoinHandler,
  releaseGroupCallRejoinHandler, nextGroupCallRejoinToken,
  beginGroupCallRejoin, endGroupCallRejoin, currentGroupCallRejoinClaim,
} from './groupCallRejoinHub';
import {
  beginAttempt, abortStaleAttempt, clearRoomAttempts, clearAllAttempts,
  markAttemptRunning, endAttemptRunning, isAttemptRunning, runningAttemptGen,
} from './groupCallAttemptGen';
import {createEarlyProducerBuffer} from './groupCallProducerBuffer';
import {logCallSm, logCallSmQuiet, shortCallId, logCallLat, endCallLatLane, type CallDiagField, type CallLatOpts} from '../runtime/callDiag';
import {RECONNECT_BUDGET_MS, TURN_FETCH_CEILING_MS} from './callDeadlines';
import type {EarlyProducerBuffer} from './groupCallProducerBuffer';
import {getMessengerRuntime} from '../runtime/runtime';
import {
  onGroupCallIdentities,
  recordGroupCallIdentity,
  getGroupCallIdentities,
  clearRoomIdentities,
  recordObservedTag,
  selectPresenceReplyTargets,
  selectUnsentMembers,
  markPresenceSent,
} from './groupCallIdentityRegistry';
import {computeTilePrune, applyProducerPaused, applyProducerPausedFrame} from './groupCallLayout';
import {
  setActiveGroupCall, patchActiveGroupCall, renameActiveGroupCallRoom,
  getActiveGroupCall, endActiveGroupCall, groupLeaveInFlight, clearGroupCallArtifacts,
  type GroupCallKey,
  onActiveGroupCallChange, seedRosterForRepublish,
} from '../runtime/groupCallRegistry';
import {useMessengerStore} from '../store/messengerStore';
import {isCallGroupState} from '../runtime/messagingLogic';
import {isDirectPrefixed} from '../conversationIds';
import type {LocalMessage} from '../store/types';
import type {TransportClient} from '@bravo/messenger-core';
import {messengerStoreKeySource} from './messengerStoreKeySource';
import {resolveGroupForCall} from '../runtime/callKeyRegistry';
// BS-GC-FC — group-call E2E media encryption now runs through the native
// FrameCryptor (io.getstream:stream-webrtc-android) rather than the JS
// encoded-transform path, which stock react-native-webrtc 124.x doesn't
// expose (that path always refused: "SFrame unavailable on this build").
// See docs/ARCHITECTURE_AMENDMENT_SFRAME.md and frameCryptorOrchestrator.ts.
import {
  FrameCryptorOrchestrator,
  frameCryptorOrchestratorAvailable,
} from './frameCryptorOrchestrator';

// B-595 — the state union and its terminal partition moved to their own
// dependency-free module, so a PURE consumer (groupCallResourceRelease) can
// import them without dragging WebRTC/Crashlytics into a node test.
// Re-exported here, so every existing import site is unchanged and there is
// still exactly ONE definition.
export {GROUP_TERMINAL_STATES} from './groupCallStates';
export type {GroupCallState} from './groupCallStates';

export interface RemoteTile {
  participantTag: string;
  consumerId:     string;
  producerId:     string;
  kind:           'audio' | 'video';
  stream:         MediaStream;
  // Set when the remote producer pauses (peer toggles camera/mic off).
  // The track + streamURL stay valid (RTCView keeps the last frame on
  // screen), so we need this flag to switch the tile to its "Camera
  // off" placeholder instead of freezing on the last decoded frame.
  paused?:        boolean;
}

/**
 * Per-participant audio level snapshot, polled from the recv
 * transport's RTCStatsReport once every 500 ms. Drives the
 * "loudest speaker becomes hero" logic on page 1 of the group call
 * grid. Values are normalised 0..1.
 */
export interface AudioLevelMap {
  [participantTag: string]: number;
}

export interface GroupCallOptions {
  /** Pre-existing roomId (joining an existing call). Omit to create. */
  roomId?:        string;
  /** Conversation that owns this call — used for ring + history bubble. */
  conversationId: string;
  callType:       'voice' | 'video';
  /**
   * `outgoing` rings everyone (sfu.ring); `incoming` joins straight in
   * (the ring was already handled by IncomingGroupCallScreen).
   */
  direction:      'outgoing' | 'incoming';
  /** Group members to ring (all of them — server filters self). */
  recipientUserIds: string[];
  /** Display name to advertise to peers via the identity envelope. */
  ownDisplayName:  string;
  /** Caller-supplied label shown in recipients' incoming-call UI. */
  callerName:      string;
  /**
   * BS-CALL-ADHOC — host/owner userId of an ad-hoc ('Call') group. The
   * host files the call master key under `direct:<owner>` on every
   * recipient; the joiner must look it up under that SAME id rather than
   * its own asymmetric `conversationId` (the host's local thread key,
   * which resolves to a different user on the joiner's device). Present
   * only on the incoming path (threaded from the ring's `from.userId`).
   */
  hostUserId?:     string;
  /**
   * Audit P0-C2 / row #5 — per-recipient HMAC room-access token. Echo
   * in `sfu.join` so the gateway admits the join. Incoming direction
   * receives it from `sfu.ring.incoming`; outgoing direction (host)
   * gets a self-token from `POST /sfu/rooms` and uses it here.
   * Optional in the opts because dev configs without
   * `SFU_ROOM_TOKEN_SECRET` skip the gate.
   */
  roomToken?:      string;
}

export interface GroupCallHandle {
  state:         GroupCallState;
  roomId:        string | null;
  isHost:        boolean;
  selfTag:       string | null;
  localStream:   MediaStream | null;
  remoteTiles:   RemoteTile[];
  identityByTag: Record<string, {displayName: string; userId?: string}>;
  isMuted:       boolean;
  isVideoOff:    boolean;
  /** True when the local camera is the front (selfie) lens. Flipped by switchCamera. */
  isFrontCamera: boolean;
  /**
   * Live audio level per participantTag, normalised 0..1. Updated on
   * a 500 ms tick from the recv transport's RTCStatsReport. The UI
   * uses this to elevate the loudest speaker to the hero slot on
   * page 1 of the grid, matching the Google Meet / WhatsApp model.
   */
  audioLevels:   AudioLevelMap;
  /**
   * CN-09 — 1 Hz aggregate link-quality sample (candidate-pair RTT +
   * inbound-audio jitter/loss) feeding the poor-connection banner. Null
   * until the first sample lands.
   */
  netQuality:    CallQualitySample | null;
  /**
   * B-15 — participantTags whose live (non-paused) video consumer has
   * delivered 0 decoded frames for >3s. The UI shows a "Video unavailable"
   * overlay on these tiles so the user can tell a stalled/undecodable
   * stream apart from a peer who simply turned their camera off.
   */
  videoStalledTags: Record<string, boolean>;
  /**
   * Offscreen-video bandwidth policy — the screen reports which tags
   * currently live on a non-visible swipe page; their VIDEO consumers
   * are paused server-side (sfu.consumer.pause) so the SFU stops
   * forwarding those streams to this device. Audio is never touched.
   * Pass [] to resume everything (e.g. on blur → FloatingCallOverlay).
   * No-ops when the set is unchanged.
   */
  setHiddenVideoTags: (tags: ReadonlyArray<string>) => void;
  toggleMute:    () => void;
  toggleVideo:   () => Promise<void>;
  /**
   * Flip the local camera between front and back. Client-only: re-acquires
   * the camera at the opposite facing and `replaceTrack`s it onto the
   * existing producer. No SDP renegotiation and no SFU/relay involvement,
   * and because replaceTrack keeps the SAME RTCRtpSender the SFrame
   * FrameCryptor stays attached — video is never sent in the clear.
   * Resolves false when there's no live video track, no live video
   * producer, or a swap is already in flight (B-123).
   */
  switchCamera:  () => Promise<boolean>;
  /**
   * Ring additional users into the live room (Invite button). The
   * underlying server endpoint is the same `sfu.ring` we use on
   * outgoing-direction boot; calling it again with new
   * recipientUserIds fans fresh push notifications without
   * disturbing anyone already in the room.
   */
  inviteUsers:   (userIds: string[]) => Promise<void>;
  /**
   * Re-ring previously-dialed recipients who haven't picked up after
   * the 30s window. Host-initiated only — there's no automatic retry.
   * Bumps `ringStartedAt` so the UI flips back to "Re-ringing".
   */
  reRing:        (userIds: string[]) => Promise<void>;
  /** Wall-clock when the most recent ring was issued (or null). */
  ringStartedAt: number | null;
  /** Recipients the host explicitly re-rang this session. */
  reRungUserIds: Set<string>;
  /** Outgoing dial list snapshot — drives the per-recipient status pills. */
  recipientUserIds: string[];
  /** Host-only — server enforces. */
  muteParticipant:  (tag: string, unmute?: boolean) => Promise<void>;
  /** Tags THIS host has force-muted, so the UI can offer Unmute. */
  hostMutedTags:    string[];
  kickParticipant:  (tag: string) => Promise<void>;
  leave:         () => Promise<void>;
}

type SfuJoinedResp = {
  routerRtpCapabilities: unknown;
  sendTransport:         unknown;
  recvTransport:         unknown;
  participantTag:        string;
  isHost:                boolean;
  existingProducers:     Array<{producerId: string; participantTag: string; kind: 'audio' | 'video'}>;
};

export function useGroupCall(opts: GroupCallOptions): GroupCallHandle {
  // B-09 — a video call must acquire a video track at boot (step=2),
  // not boot audio-only and toggle later. isVideoForCall is the pure,
  // unit-pinned derivation; getLocalMedia({video: isVideo}) at step=2
  // requests the camera track up front.
  const isVideo = isVideoForCall(opts.callType);
  // [CALLLAT] (audit Step 0) — the group lane id is the conversationId: stable
  // across the whole boot (the host learns its roomId only at step 1) and shared
  // with GroupCallScreen's audio-session markers and MainNavigator's ring row.
  // Hook-scoped so every effect (boot, stats sampler) stamps the same lane.
  const latG = (step: string, fields: Record<string, CallDiagField> = {}, o?: CallLatOpts): void =>
    logCallLat(opts.direction === 'incoming' ? 'grp-join' : 'grp-host', opts.conversationId, step, fields, o);
  /** One-shot per boot for the "first remote audio bytes" row. */
  const firstAudioMarkedRef = useRef(false);

  const [state, setStateRaw]              = useState<GroupCallState>('idle');
  const [roomId, setRoomId]               = useState<string | null>(opts.roomId ?? null);
  // WI-7.1 round 3 (B-568 review) — THE group transition funnel. The registry
  // patch path never carries `state` in production: milestones re-REGISTER
  // (setActiveGroupCall → `group.set`, already on the [CALLSM] lane) or end
  // (`group.end`), so this React setter is the ONLY place every live
  // transition passes — including reconnecting↔joined, which never touches
  // the registry at all. `lastStateRef` is written synchronously here (the
  // passive `stateRef` mirror is one commit behind) so rapid double-sets in
  // one tick still record the true prev.
  const lastStateRef = useRef<GroupCallState>('idle');
  const setState = useCallback((action: GroupCallState | ((prev: GroupCallState) => GroupCallState)) => {
    // Updater forms resolve against lastStateRef — which is exact, because
    // this wrapper is the ONLY door to the raw setter (pinned), so every
    // prior write already passed through here synchronously.
    const prev = lastStateRef.current;
    const next = typeof action === 'function' ? action(prev) : action;
    if (next !== prev) {
      try {
        const {logCallTransition} = require('../runtime/callDiag') as typeof import('../runtime/callDiag');
        logCallTransition({
          callId: roomIdRef.current ?? null,
          gen:    groupKeyRef.current?.gen ?? null,
          prev, next,
          event:  'setState', source: 'useGroupCall',
        });
      } catch { /* diag unavailable — never block a transition */ }
      lastStateRef.current = next;
      // [CALLLAT] (audit Step 0, review round 2) — a TERMINAL group state is
      // the lane's closing row and ENDS its clock, the exact twin of the 1:1
      // controller's `state:ended`; without it the group lane was never ended
      // and a later js-stall could be attributed to a finished call.
      if (GROUP_TERMINAL_STATES.has(next)) {
        latG(`state:${next}`, {src: 'setState'});
        endCallLatLane(opts.direction === 'incoming' ? 'grp-join' : 'grp-host', opts.conversationId);
      }
    }
    setStateRaw(next);
    // Refs only — stable for the hook's lifetime. The [CALLLAT] terminal row
    // reads `latG`/`opts`: two fixed route params behind a per-render closure;
    // the wrapper keeps its stable identity on purpose.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [isHost, setIsHost]               = useState(false);
  const [selfTag, setSelfTag]             = useState<string | null>(null);
  const [localStream, setLocalStream]     = useState<MediaStream | null>(null);
  const [remoteTiles, setRemoteTiles]     = useState<RemoteTile[]>([]);
  const [identityByTag, setIdentityByTag] = useState<Record<string, {displayName: string; userId?: string}>>({});
  const [isMuted, setIsMuted]             = useState(false);
  const [isVideoOff, setIsVideoOff]       = useState(false);
  // Local camera lens. getUserMedia below always acquires facingMode:'user'
  // (front), so the initial truth is `true`; switchCamera flips it.
  const [isFrontCamera, setIsFrontCamera] = useState(true);
  const [audioLevels, setAudioLevels]     = useState<AudioLevelMap>({});
  // CN-09 — 1 Hz aggregate link-quality sample for the poor-connection
  // banner: RTT from the selected candidate-pair, jitter/loss from inbound
  // audio. Null until the first sample lands.
  const [netQuality, setNetQuality]       = useState<CallQualitySample | null>(null);
  // B-15 — per-tag video-stall flag. True when a tile has a live, NON-paused
  // video consumer that is delivering 0 decoded frames for >3s (decrypt
  // failure / SFU drop / encoder stall). Distinct from camera-off (peer
  // paused their producer) so the UI can say "Video unavailable" instead of
  // showing an indistinguishable black surface.
  const [videoStalledTags, setVideoStalledTags] = useState<Record<string, boolean>>({});
  // framesDecoded snapshot per tag from the previous stats tick + the
  // wall-clock when it last advanced. Lets the poller compute "no new frames
  // for >N ms" without re-rendering every tick.
  const videoFrameSnapRef = useRef<Map<string, {frames: number; lastAdvanceMs: number}>>(new Map());
  // Wall-clock when the most recent ring was issued. Drives the per-
  // recipient status pill in the UI: while now-ringStartedAt < 30s the
  // recipient shows 'Ringing'; after that 'No answer' until the host
  // taps Re-ring (which updates this stamp). null means no outgoing
  // ring is in flight.
  const [ringStartedAt, setRingStartedAt] = useState<number | null>(null);
  // Per-recipient indicator: did the host bump them with a re-ring this
  // session? Drives the "Re-ringing" pill (vs initial "Ringing").
  const [reRungUserIds, setReRungUserIds] = useState<Set<string>>(() => new Set());

  const audioTrackRef    = useRef<MediaStreamTrack | null>(null);
  const videoTrackRef    = useRef<MediaStreamTrack | null>(null);
  const deviceRef        = useRef<Device | null>(null);
  const sendTxRef        = useRef<Transport | null>(null);
  const recvTxRef        = useRef<Transport | null>(null);
  const producersRef     = useRef<Producer[]>([]);
  const consumersByPid   = useRef<Map<string, Consumer>>(new Map());
  // Fix #9: per-consumer cleanup callbacks. addEventListener('mute' /
  // 'unmute' / 'trackended') has NO removeEventListener counterpart in
  // RN-WebRTC's track API — once attached, the listener fires forever
  // and can dereference the captured setRemoteTiles closure long after
  // the hook unmounts (post-unmount setState warning + leaked memory).
  // We collect detachers per-consumerId so leaveInternal can run them
  // BEFORE closing the consumer. Keying on consumer.id matches the
  // map used for the consumer itself.
  const consumerCleanupsByPid = useRef<Map<string, Array<() => void>>>(new Map());
  const transportRef     = useRef<TransportClient | null>(null);
  // WI-5.3 (round 1 P1 rider) — refresh the ref when the registry swaps the
  // transport, so the two dozen send sites reading transportRef.current ride
  // the replacement after a runtime rebuild instead of the closed corpse.
  // HONESTY (round 2 F-4): this is a best-effort refresh, not an authority —
  // adoptLiveHandles assigns the ref from the restore stash AFTER this
  // effect's registration, so a stash carrying an older transport can win
  // until the next registry broadcast. The rejoin closures are immune (they
  // re-resolve getLiveTransport() at fire time). Guarded optional call: the
  // group-call unit fakes mock the registry without onTransport.
  useEffect(() => {
    try {
      const reg = require('../runtime/transportRegistry') as typeof import('../runtime/transportRegistry');
      const un = reg.onTransport?.(t => { if (t) {transportRef.current = t;} });
      return typeof un === 'function' ? un : undefined;
    } catch { return undefined; }
  }, []);
  const participantTagRef = useRef<string | null>(null);
  const cleanupSubRef    = useRef<(() => void) | null>(null);
  const cleanupIdentSub  = useRef<(() => void) | null>(null);
  const sentRingRef      = useRef(false);
  // WI-6.7 — every fan-out id this call minted (from the sfu.ring acks). The
  // cancel frame names a ring ONLY when exactly one fan-out exists: every
  // current cancel caller is a cancel-ALL (host End / boot failure), and
  // naming the latest ring with ≥2 outstanding fan-outs left the OTHER
  // fan-out's recipients ringing a withdrawn call (round-2 edge F2 — their
  // artifacts/screens hold a different ringId and correctly ignore a
  // mismatched cancel). Zero or many → unscoped, the historical room-wide
  // cancel. An ack still in flight simply hasn't added its id yet, which
  // degrades to the same safe unscoped form (critic F5).
  const mintedRingIdsRef = useRef<Set<string>>(new Set());
  // KO-7 (B-566) — every user THIS call ever rang (boot ring + invites +
  // re-rings). The cancel-all target list used to be opts.recipientUserIds
  // only, so an invitee added mid-ring who never joined received NO cancel
  // and rang out the full window against a withdrawn call.
  const rungUsersRef     = useRef<Set<string>>(new Set());
  const callStartedAtRef = useRef<number | null>(null);
  const wasKickedRef     = useRef(false);
  /**
   * True when the SERVER told us the host left (`sfu.room.ended` frame).
   * leaveInternal uses this to skip the outbound `sfu.leave` round-trip
   * — the server has already closed our consumers/transports and
   * deleted the room from its state, so sending `sfu.leave` would
   * either error out (unknown participant) or pointlessly add latency
   * to our local teardown.
   */
  const wasHostEndedRef  = useRef(false);
  // Round 4: ref-mirrors so leaveInternal can decide whether to send
  // sfu.ring.cancel to outstanding ringing recipients (host-only,
  // and only while a ring is in flight). Without these the closure
  // reads stale snapshots of isHost / ringStartedAt and would either
  // skip the cancel or fire it after the ring already cleared.
  const isHostRef        = useRef(false);
  const ringStartedAtRef = useRef<number | null>(null);
  // Tracks userIds that have actually joined the room so leaveInternal
  // can compute "still ringing" = recipientUserIds − joined.
  const joinedUserIdsRef = useRef<Set<string>>(new Set());
  // Audit row #5 (C2) — host's roomToken captured at boot so the
  // leaveInternal → `sfu.ring.cancel` path can echo it. Without this
  // the gateway rejects with `room_token_required` once
  // SFU_ROOM_TOKEN_SECRET is set.
  const roomTokenRef     = useRef<string | undefined>(undefined);
  // Audit F7 — re-mint the room token for a rejoin when the original 30-min
  // token has expired (a call that ran longer than the TTL then hit a WS
  // reconnect). GET /sfu/rooms/by-conversation mints a fresh per-caller token.
  const remintRoomToken = useCallback(async (): Promise<string | undefined> => {
    try {
      const {fetchWithRefresh} = require('@/services/api') as typeof import('@/services/api');
      const res = await fetchWithRefresh(
        `${MSG_BASE_URL}/sfu/rooms/by-conversation/${encodeURIComponent(opts.conversationId)}`,
        {method: 'GET', headers: {'X-Signal-Device-Id': '1'}},
      );
      if (!res.ok) {return undefined;}
      const body = await res.json() as {roomToken?: string};
      const token = body.roomToken || undefined;
      if (token) {roomTokenRef.current = token;}
      return token;
    } catch { return undefined; }
  }, [opts.conversationId]);
  // Fix #13: roomId ref synced from React state. leaveInternal needs
  // the LATEST roomId (not the closure's snapshot from when the
  // useCallback last fired) — the useCallback's deps include roomId,
  // but every other code path that calls leaveInternal goes through
  // a ref captured at a different time and would otherwise race.
  // Mirror keeps the ref always-current.
  const roomIdRef = useRef<string | null>(null);
  /**
   * The room id as soon as the SERVER issued it, written synchronously at
   * step 1 rather than via React state.
   *
   * `roomIdRef` above is populated by an effect fed from `setRoomId`, so it
   * is still null for the whole synchronous stretch between the create
   * response and React committing that state. A throw inside that window —
   * the exact window this boot's failure path exists for — would leave the
   * failure handler with no id and the freshly-created room would survive as
   * the corpse the reap is meant to remove.
   */
  const createdRoomIdRef = useRef<string | null>(null);
  /**
   * WI-1.5 — the registry key THIS hook published, so `leaveInternal` can tell
   * its own entry from a same-room successor's. `roomId` alone cannot: a fresh
   * call in the same room looks identical to ourselves.
   */
  const groupKeyRef = useRef<GroupCallKey | null>(null);
  // Fix #12: producerIds whose consume is currently in flight. A fast
  // sequence of sfu.new-producer frames for the same producerId (rare,
  // but happens when the server retries due to a transient peer
  // disconnect) used to fire two concurrent sfu.consume requests; the
  // second one would race the first's recv.consume and either crash
  // mediasoup ("consumer already created") or leave us with a phantom
  // consumer no one knows about.
  const inFlightConsumes = useRef<Set<string>>(new Set());
  // BS-MEDIA — producerIds we've successfully consumed (a tile is live).
  // The reconcile tick diffs the server's authoritative producer list
  // against this set and consumes any gap, recovering a missed
  // sfu.new-producer frame or a consume that exhausted its retries.
  // Cleared per-producer on tile teardown and wholesale on leave.
  const consumedProducerIdsRef = useRef<Set<string>>(new Set());
  // BS-MEDIA — latest reconcile closure, populated at the end of boot so
  // the periodic effect can call the freshest version (which captures
  // `rid` + the in-IIFE consumeProducer) without re-firing on identity.
  const reconcileProducersRef = useRef<(() => Promise<void>) | null>(null);
  // Latest rebuildVideoConsumer closure, called from the stats-poll freeze
  // watchdog (which can't take it as an effect dep without re-creating the
  // poller). Rebuilds a wedged remote video consumer with a FRESH decoder.
  const rebuildVideoConsumerRef = useRef<((tag: string) => void) | null>(null);
  // B-06 — buffers sfu.new-producer frames that land before the recv
  // pipeline is ready (handler now registers right after the roomId is
  // known, BEFORE sfu.join). Drained once recvTx + consumeProducer are
  // live; the 4 s reconcile stays a pure backstop. Populated in boot.
  const earlyProducerBufferRef = useRef<EarlyProducerBuffer | null>(null);
  // Fix #10: handle for the audio-level interval so leaveInternal can
  // clear it directly. The previous code only cleared in the effect's
  // cleanup, which doesn't fire until the React unmount commits — a
  // 500ms tick can land between leaveInternal closing recvTx and the
  // unmount and crash on a closed transport.
  const audioPollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Fix #7: ref to the latest leaveInternal so nested closures
  // (the resume-path SFU handler in particular) call the freshest
  // version without depending on the useCallback's identity.
  const leaveInternalRef = useRef<(() => Promise<void>) | null>(null);
  // B-07 — ref to the freshest toggleVideo so the one-shot
  // encryptor-arrival retry re-invokes the up-to-date closure (which
  // captures the current localStream), mirroring leaveInternalRef.
  const toggleVideoRef = useRef<(() => Promise<void>) | null>(null);
  // True from the moment leaveInternal starts running until the hook
  // unmounts. Async paths inside the hook (consumeProducer, producer
  // tx events, mediasoup `negotiationneeded` callbacks fired during
  // track removal) check this flag and bail instead of issuing a
  // fresh wsRequest against an already-closed transport. Without it,
  // ending a call while the engine is mid-renegotiation blocks the JS
  // thread on a Promise that will never resolve (sfu.connect ack never
  // arrives because we already sent sfu.leave) and the app freezes
  // until the OS kills the WS heartbeat. Repro: end a video call right
  // after a peer enables/disables their camera (which triggers a
  // negotiation cycle that's still in flight when the user taps End).
  const isLeavingRef     = useRef(false);
  /**
   * B-101 LC-5 — installed by the boot effect's ICE-recovery block so the
   * AppState-'active' handler can re-probe the reconnect budget after a
   * background stint (frozen timers must not fail a recovered call).
   */
  const budgetForegroundProbeRef = useRef<(() => void) | null>(null);
  /**
   * B-101 LC-12/13 — true when WE paused the local camera because the app
   * went to background, so foreground only resumes what we paused (a
   * user-intended camera-off must stay off).
   */
  const bgAutoPausedVideoRef = useRef(false);

  // ── B-20 (group) — camera-loss recovery on resume ──────────────
  // Mirror facing + user-intended-off into refs so the once-bound resume
  // handler reads fresh values without re-subscribing AppState on every
  // toggle (mirrors useCall.ts).
  const isVideoOffRef = useRef(isVideoOff);
  useEffect(() => { isVideoOffRef.current = isVideoOff; }, [isVideoOff]);
  const isFrontCameraRef = useRef(isFrontCamera);
  useEffect(() => { isFrontCameraRef.current = isFrontCamera; }, [isFrontCamera]);
  const recoveringCameraRef = useRef(false);
  // Another app grabs the camera mid group-call; our capture track
  // ends/mutes and the mediasoup video producer keeps "sending" null
  // frames. On foreground, if we're in a video call whose local track has
  // died AND the user didn't intentionally turn the camera off, acquire a
  // fresh track and replaceTrack it onto the EXISTING video producer —
  // keeping the producer's RTPSender + SFrame transform, so recovered
  // frames stay encrypted (no SDP reneg; peers keep receiving). BlueStacks
  // reports the stolen track as 'live' so this is physical-device-only; it
  // is a safe no-op on a healthy track.
  useEffect(() => {
    const {AppState} = require('react-native') as typeof import('react-native');
    const sub = AppState.addEventListener('change', (next: string) => {
      // B-101 LC-12/13 — background/lock: stop pushing camera frames and
      // TELL the peers, so they swap to the avatar placeholder instead of
      // staring at a frozen last frame (WhatsApp parity), and our encoder
      // stops burning battery in the user's pocket. Audio is untouched —
      // the call keeps working. A user-intended camera-off is respected
      // (nothing to do), and only what we auto-paused is resumed later.
      // Review GC-7 — 'background' ONLY. iOS raises 'inactive' for
      // transient interruptions (notification shade, incoming banner,
      // app switcher preview) where the camera keeps working; treating
      // those as background would pause/resume video several times per
      // minute and flicker the avatar placeholder for every peer.
      if (next === 'background') {
        if (isLeavingRef.current || isVideoOffRef.current) {return;}
        if (bgAutoPausedVideoRef.current) {return;}
        const track = videoTrackRef.current;
        const vp = producersRef.current.find(
          p => (p as unknown as {kind?: string; closed?: boolean}).kind === 'video'
            && !(p as unknown as {closed?: boolean}).closed,
        );
        const pid = (vp as unknown as {id?: string} | undefined)?.id;
        const ws  = transportRef.current;
        const rid = roomIdRef.current;
        if (!track || !pid || !ws || !rid) {return;}
        bgAutoPausedVideoRef.current = true;
        try { track.enabled = false; } catch { /* track may have died */ }
        void wsRequest<{ok: true}>(ws, 'sfu.producer.pause', {roomId: rid, producerId: pid})
          .catch(() => { /* peers self-heal via the reconcile snapshot */ });
        return;
      }
      if (next !== 'active') {return;}
      // B-101 LC-5 — re-probe the ICE reconnect budget FIRST: time spent
      // frozen in background must not fail a call whose transports have
      // recovered. Runs before the camera guards below, which return
      // early for an intentionally-off camera.
      try { budgetForegroundProbeRef.current?.(); } catch { /* best-effort */ }
      // B-101 LC-12/13 — undo our background camera pause.
      if (bgAutoPausedVideoRef.current && !isLeavingRef.current) {
        bgAutoPausedVideoRef.current = false;
        const track = videoTrackRef.current;
        try { if (track) {track.enabled = true;} } catch { /* re-acquired below if dead */ }
        const vp = producersRef.current.find(
          p => (p as unknown as {kind?: string; closed?: boolean}).kind === 'video'
            && !(p as unknown as {closed?: boolean}).closed,
        );
        const pid = (vp as unknown as {id?: string} | undefined)?.id;
        const ws  = transportRef.current;
        const rid = roomIdRef.current;
        // Respect a camera the user turned off while backgrounded.
        if (pid && ws && rid && !isVideoOffRef.current && intendedVideoPausedRef.current !== true) {
          void wsRequest<{ok: true}>(ws, 'sfu.producer.resume', {roomId: rid, producerId: pid})
            .catch(() => { /* reconcile re-asserts */ });
        }
      }
      if (isVideoOffRef.current) {return;}            // user-intended off — respect it
      if (isLeavingRef.current) {return;}             // call tearing down
      const track = videoTrackRef.current;
      if (!track) {return;}                           // audio-only / camera never on
      const muted = (track as unknown as {muted?: boolean}).muted === true;
      const dead  = track.readyState === 'ended' || muted;
      if (!dead) {return;}                            // healthy track — nothing to do
      if (recoveringCameraRef.current) {return;}      // re-entrancy guard
      const vp = producersRef.current.find(
        p => (p as unknown as {kind?: string; closed?: boolean}).kind === 'video'
          && !(p as unknown as {closed?: boolean}).closed,
      );
      if (!vp) {return;}                              // no live video producer
      recoveringCameraRef.current = true;
      void (async () => {
        try {
          const replaced = await recoverGroupCamera({
            producer:     vp as never,
            facing:       isFrontCameraRef.current ? 'user' : 'environment',
            currentTrack: track,
          });
          if (replaced) {
            videoTrackRef.current = replaced;
            const audio = audioTrackRef.current;
            const rebuilt = new MediaStream(audio ? [audio, replaced] : [replaced]);
            setLocalStream(rebuilt);
            try {
              patchActiveGroupCall(roomIdRef.current, {localStream: rebuilt, videoTrack: replaced});
            } catch { /* best-effort registry refresh */ }
            console.log('[useGroupCall.recoverCamera] re-acquired camera after resume');
          }
        } catch (e) {
          console.warn('[useGroupCall.recoverCamera] failed (camera may still be held):', (e as Error).message);
        } finally {
          recoveringCameraRef.current = false;
        }
      })();
    });
    return () => sub.remove();
  }, []);

  // S6 / P0-C1 — SFrame end-to-end encryption layered ON TOP of SRTP
  // so the SFU forwards ciphertext-inside-ciphertext and never sees
  // plaintext media. Lazy-initialised after sfu.joined fires (we need
  // the participantTag) and torn down on leave. `null` means either
  // the platform lacks encoded-transform support (capability probe
  // failed — we refuse to start the call) or the call hasn't joined
  // yet. The accumulated per-sender/receiver detach fns live in
  // sframeDetachersRef so leaveInternal can fire them before closing
  // mediasoup transports — otherwise the inflight TransformStream
  // pipeTo() races consumer.close() and crashes the native bridge.
  const groupEncryptionRef = useRef<FrameCryptorOrchestrator | null>(null);
  const sframeDetachersRef = useRef<Array<() => void>>([]);
  // B-07 — one-shot guard so a mid-call "turn camera on" tapped before the
  // SFrame encryptor lands arms at most ONE retry (repeat taps don't stack
  // store subscriptions). Cleared when the wait settles.
  const videoRetryArmedRef = useRef(false);
  // B-05 — current call state mirrored to a ref so the WS-reconnect
  // subscriber (registered once at boot) can read the LATEST state without
  // re-subscribing on every transition. Used to gate the rejoin: only a
  // 'joined'/'reconnecting' call is rejoined after a socket reopen.
  const stateRef = useRef<GroupCallState>(state);
  // B-05 — freshest rejoin closure, populated at the end of boot so the
  // reconnect subscriber can re-wire mediasoup (create transports, produce,
  // consume) against the NEW participantTag + transports the server mints
  // on a fresh sfu.join. Null until the call has fully joined once.
  const rejoinRoomRef = useRef<((joined: SfuJoinedResp, attemptGen: number) => Promise<void>) | null>(null);
  /**
   * WI-3.3 — the rejoin-hub token THIS instance installed, so its teardown
   * releases only its own handler. The hub outlives the screen by design, so
   * an unconditional clear let a stale instance's late `leaveInternal` retire
   * the handler the NEXT call had already installed.
   */
  const rejoinTokenRef = useRef<string | null>(null);
  // B-05 — overlapping rejoins (a flapping socket fires onReconnect
  // repeatedly inside the 60s window) are guarded by the rejoin hub's
  // shared, wall-clock-expiring slot rather than a per-hook ref, so the
  // guard survives minimize/restore and cannot latch on a lost ack.
  // See groupCallRejoinHub.beginGroupCallRejoin.

  // Fix #13: keep the roomIdRef in lockstep with the React state.
  useEffect(() => { roomIdRef.current = roomId; }, [roomId]);

  /**
   * B-477 — hydrate THIS instance's refs from the room's live handles.
   *
   * Runs on the restore/adopt path at mount, and again whenever a rejoin
   * republishes the stash. The second call is the fix: `rejoinRoom` is stashed
   * and adopted, so a restored instance runs the ORIGINAL instance's closure,
   * which writes the ORIGINAL instance's refs. Without re-adoption the restored
   * hook keeps the transports that rejoin closed — the resume reconcile issues
   * `recv.consume` against a dead transport every 4 s, the audio-level poller
   * binds it, `leaveInternal` closes the OLD pair so the new one leaks, and the
   * frozen tiles' consumerIds block the reconcile from rebuilding them.
   *
   * Pure ref assignment, so re-running it is idempotent and the instance that
   * owns the rejoin re-adopting its own values is a no-op.
   */
  const adoptLiveHandles = useCallback((stash: LiveSfuHandles): void => {
    deviceRef.current             = stash.device;
    sendTxRef.current             = stash.sendTx;
    recvTxRef.current             = stash.recvTx;
    transportRef.current          = stash.transport;
    producersRef.current          = stash.producers;
    consumersByPid.current        = stash.consumersByPid;
    consumerCleanupsByPid.current = stash.consumerCleanups;
    sframeDetachersRef.current    = stash.sframeDetachers;
    groupEncryptionRef.current    = stash.groupEncryption;
    participantTagRef.current     = stash.participantTag;
    // Audit L14 — adopt the boot rejoin fn + room token so THIS instance's
    // reconnect handler can actually recover the call.
    rejoinRoomRef.current         = stash.rejoinRoom ?? null;
    if (stash.roomToken) {roomTokenRef.current = stash.roomToken;}
    // WI-3.4 — adopt the consume-dedup sets. Without these this instance
    // believes it has consumed NOTHING while holding a fully-populated
    // consumersByPid, so the resume reconcile re-consumes live producers and
    // mediasoup throws "consumer already exists".
    inFlightConsumes.current       = stash.inFlightConsumes;
    consumedProducerIdsRef.current = stash.consumedProducerIds;
    // A consumer can exist without a matching entry in the consumed set — the
    // boot's batch path registers the consumer before its tile flush, and a
    // handler running during the minimize window can add one at any time.
    // Reconcile the two so "consumed" is derived from what actually exists
    // rather than from bookkeeping alone.
    for (const consumer of consumersByPid.current.values()) {
      const cx = consumer as unknown as {producerId?: string; closed?: boolean; track?: unknown};
      // Three-part, to AGREE with the reconcile's own liveness test
      // (`live && !live.closed && track`). Membership in this map is NOT proof
      // of a live consumer, and an open consumer with no track is classified as
      // needing re-consume there — so marking either consumed here would make
      // it permanently unrecoverable behind both dedup guards.
      if (cx.producerId && !cx.closed && cx.track) {consumedProducerIdsRef.current.add(cx.producerId);}
    }
  }, []);

  /**
   * B-477 — re-adopt whenever a rejoin republishes this room's handles.
   *
   * Keyed on the live `roomId` rather than `opts.roomId` so the host path
   * (whose room is minted at boot) is covered too.
   */
  useEffect(() => {
    if (!roomId) {return;}
    const reAdopt = (): void => {
      const fresh = liveSfuHandlesByRoom.get(roomId);
      if (!fresh) {return;}
      adoptLiveHandles(fresh);
      /**
       * The refs are the winner's now — but our TILES are still the pre-rejoin
       * ones, whose streams come from consumers the rebuild closed. Nothing
       * repairs them on their own: `haveTile` is keyed on producerId, which is
       * unchanged across a rejoin, so the resume reconcile skips every one of
       * them, and it has no prune branch. Video eventually heals when the stall
       * watchdog rebuilds a frozen consumer; AUDIO NEVER DOES.
       *
       * The rejoin re-consumed into the registry as it went
       * (`patchActiveGroupCall(rid, {remoteTiles})` on each consume), so the
       * registry — not our own state — holds the authoritative post-rebuild
       * list. Adopt that. Filtering our own tiles against `consumersByPid`
       * would leave this instance with NONE, because the rejoin's
       * `setRemoteTiles` calls landed on the instance that owns the closure.
       */
      const live = getActiveGroupCall();
      if (live && live.roomId === roomId) {
        setRemoteTiles(live.remoteTiles ?? []);
      }
      console.warn('[CALLDIAG] [bravo.groupcall] re-adopted republished handles room=', roomId.slice(0, 8));
    };
    // Adopt once on subscribe as well as on notify. The restore branch adopts
    // at mount while `roomId` state is still null, so this effect does not
    // subscribe until the NEXT commit — a republish landing in that window
    // would otherwise be missed permanently, since nothing re-reads the stash.
    reAdopt();
    return subscribeLiveSfuHandles(roomId, reAdopt);
  }, [roomId, adoptLiveHandles]);
  // B-05 — mirror state for the reconnect subscriber's gate.
  useEffect(() => { stateRef.current = state; }, [state]);
  // Round 4: mirror isHost + ringStartedAt for leaveInternal's
  // sfu.ring.cancel decision. See refs above for full reasoning.
  useEffect(() => { isHostRef.current = isHost; }, [isHost]);
  useEffect(() => { ringStartedAtRef.current = ringStartedAt; }, [ringStartedAt]);
  // Track userIds that have joined the room — drives the "still
  // ringing" set leaveInternal hands to sfu.ring.cancel. Pull from
  // identityByTag (server emits identity envelopes for every joined
  // peer including ourselves).
  useEffect(() => {
    const joined = new Set<string>();
    for (const id of Object.values(identityByTag)) {
      if (id.userId) {joined.add(id.userId);}
    }
    joinedUserIdsRef.current = joined;
  }, [identityByTag]);

  // B-365 — proactive roster refresh on every call join. A stale roster on
  // ANY side leaves that pair's names unresolved forever (identity replies
  // and key serves are roster-gated) and — when every member already holds
  // the key — NOTHING else ever triggers a reconcile: the drifted device
  // never asks (it has the key) and nobody sends it a create (Ariful↔Ae2,
  // 2026-08-01 15:36 — encrypted names with zero heal traffic in the logs).
  // One bounded request 5 s after joining; requestGroupKeyResync's 20 s
  // per-group cooldown caps repeats, members serve the owner-signed state,
  // and the same-epoch superset heal (inboundGroupCreateGate) adopts it.
  useEffect(() => {
    if (state !== 'joined') {return;}
    const resyncId = opts.conversationId.startsWith('direct:') && opts.hostUserId
      ? `direct:${opts.hostUserId}`
      : opts.conversationId;
    const t = setTimeout(() => {
      void (async () => {
        try {
          const rt = await getMessengerRuntime();
          // divergence:true — the resync impl FILTERS OUT groups whose state
          // is present ("no resync candidate — state present or filtered",
          // 16:31 logs), which is EXACTLY the stale-roster case this refresh
          // exists for. The divergence flag is the impl's own bypass for
          // "I hold state but suspect it is wrong".
          await (rt as unknown as {requestGroupKeyResync?: (id: string, fromPeer?: undefined, opts?: {divergence?: boolean}) => Promise<void>})
            .requestGroupKeyResync?.(resyncId, undefined, {divergence: true});
          console.warn('[bravo.groupcall] B-365 roster refresh requested for', resyncId.slice(0, 14));
        } catch { /* cooldown / offline — the next join retries */ }
      })();
    }, 5000);
    return () => clearTimeout(t);
  }, [state, opts.conversationId, opts.hostUserId]);

  // B-365b — re-announce our identity whenever the call's ROSTER heals or
  // grows. The boot one-shot fires before an escalated-call joiner's healed
  // state lands (reaching nobody), and B-344's reciprocal reply only
  // triggers off the joiner's OWN announcement — so both directions stayed
  // hex tags forever ("140129"/"ED2257" tiles, founder screenshots 17:20).
  // Sent-set guarded (one announce per (room, userId) per boot) so the
  // unselective store subscription can never storm.
  useEffect(() => {
    if (state !== 'joined' || !roomId) {return;}
    const rid = roomId;
    const announce = (): void => {
      const selfTagNow = participantTagRef.current;
      if (!selfTagNow) {return;}
      const st = useMessengerStore.getState();
      const g = resolveGroupForCall(st.groups, opts.conversationId);
      if (!g) {return;}
      const ownUid = st._ownAuthUserId ?? st._ownUserId;
      const targets = selectUnsentMembers(rid, Object.keys(g.members ?? {}), ownUid ?? undefined);
      if (targets.length === 0) {return;}
      markPresenceSent(rid, targets);
      void (async () => {
        try {
          const rtNow = await getMessengerRuntime();
          await rtNow.broadcastGroupCallPresence(targets, {
            roomId:         rid,
            participantTag: selfTagNow,
            displayName:    opts.ownDisplayName,
            callType:       opts.callType,
          });
          console.warn(`[CALLDIAG] [bravo.groupcall.presence] roster-heal identity announce to ${targets.length} member(s) (B-365b)`);
        } catch (e) {
          console.warn('[bravo.groupcall.presence] roster-heal announce failed:', (e as Error).message);
        }
      })();
    };
    announce(); // a roster that healed BEFORE this effect armed still announces
    return useMessengerStore.subscribe(() => announce());
  }, [state, roomId, opts.conversationId, opts.ownDisplayName, opts.callType]);

  /**
   * Audit P1-C6 — auto-evict removed members from the live SFU room.
   *
   * Without this: `removeGroupMember` rotates the group master key
   * (P1-C5 closes via GroupCallEncryption.subscribe) but the kicked
   * user, still connected to the SFU, keeps receiving in-flight frames
   * encrypted under the OLD key. The new key never reaches them so
   * the frames decrypt to nothing useful — but the SFU's per-track
   * buffering means they get one tail of pre-rotation media for free.
   *
   * Subscribing to the local group state and firing `sfu.kick` for any
   * (tag → userId) that's no longer in `cur.members` closes the window
   * end-to-end: the SFU drops their consumers + transports immediately,
   * and the SFrame rotation takes effect for the remaining members.
   *
   * Host-only — the SFU's `sfu.kick` requires the host's tag. Non-host
   * clients can't kick anyone (server enforces too); this hook is a
   * no-op for non-hosts. Skipped when not joined (`state !== 'joined'`)
   * so a teardown-in-progress doesn't fire stale kicks.
   */
  useEffect(() => {
    if (!isHost || state !== 'joined' || !roomId) {return;}
    const conversationId = opts.conversationId;
    const ws = transportRef.current;
    if (!ws) {return;}
    return useMessengerStore.subscribe((s, prev) => {
      // B-124 root fix — resolve through the callKeyRegistry so an ad-hoc
      // escalated call's roster (state under its minted id) is watched via
      // the same handle the rest of the call machinery uses.
      const cur  = resolveGroupForCall(s.groups, conversationId);
      const old  = resolveGroupForCall(prev.groups, conversationId);
      if (!cur || !old) {return;}
      // Compute which userIds were present before AND are gone now.
      const removed: string[] = [];
      for (const uid of Object.keys(old.members)) {
        if (!cur.members[uid]) {removed.push(uid);}
      }
      if (removed.length === 0) {return;}
      // Translate userId → participantTag via the live identity map.
      // A removed member who was never in the call has no tag — skip
      // (the SFU has no consumer to drop anyway). The identity map is
      // captured fresh inside the closure since identityByTag is a
      // dependency below.
      for (const uid of removed) {
        const entry = Object.entries(identityByTag).find(([, v]) => v.userId === uid);
        if (!entry) {continue;}
        const [tag] = entry;
        console.log(`[bravo.groupcall.auto-evict] kicking removed member uid=${uid.slice(0,8)} tag=${tag.slice(0,8)}`);
        wsRequest<{ok: true}>(ws, 'sfu.kick', {roomId, targetTag: tag})
          .catch(e => console.warn('[bravo.groupcall.auto-evict] kick failed:', (e as Error).message));
      }
    });
  }, [isHost, state, roomId, opts.conversationId, identityByTag]);

  // ── Boot ────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    /**
     * B-642 — the cleanup EVERY dead-boot exit owes, not just the thrown ones.
     *
     * The outer catch at the bottom of this IIFE performs four teardown steps.
     * Three sites bypass it entirely — the two FrameCryptor refusals (S6/B-111)
     * and the group-key-lane catch — because they `setState('failed')` and
     * **`return`** instead of throwing. So the two steps that matter to them
     * never ran:
     *
     *   1. The B-343 media release. Tracks are acquired at step 2, long before
     *      the key lane, and were only ever stopped by an explicit End. A boot
     *      that dies after step 2 leaves the camera held, which wedges every
     *      subsequent getUserMedia behind it — the loop B-343's own comment
     *      calls "the 'Call failed' loop".
     *   2. The BS-MINIMIZE-RING registry clear. If the call was minimized while
     *      connecting the hook is unmounted, `setState('failed')` is a no-op,
     *      and the floating bubble hangs on "connecting…" forever. That comment
     *      names "key-wait failure" explicitly — i.e. exactly the site that
     *      could not reach it.
     *
     * ⚠️ DELIBERATELY NOT the other two steps:
     *   - Ring-cancel is gated on `sentRingRef`, which is set AFTER every site
     *     here, so it can never fire from this helper.
     *   - The room reap is guarded by `neverJoined`. At the POST-join sites
     *     `participantTagRef` is already set (`:2178`), so the reap is a no-op
     *     there — and relaxing that guard so a joined failure "leaves properly"
     *     would make the frame take the gateway's host path and EVICT every
     *     peer already in the room.
     *
     * ⚠️ KNOWN GAP, stated rather than hidden (review round 1 corrected an
     * earlier comment here that claimed the opposite): at the PRE-JOIN site
     * `neverJoined` is genuinely true and `createdRoomIdRef` was set at
     * `:1796`, so that IS a site where the outer catch's reap would do real
     * work — and it sends no `sfu.leave` at all. A FrameCryptor-less build can
     * therefore leave a host-owned, zero-participant server room behind.
     * NOT fixed here: the reap's safety rests on `endRoomIfEmptyByHost`
     * refusing unless the caller IS the recorded host and the room is empty
     * (`messenger.gateway.ts:2465-2472`), which is a server invariant this
     * change has not audited. Pinned as a known gap instead of guessed at.
     *
     * ⚠️ This helper does NOT emit `sfu.leave` — the call sites own that, and
     * each already passes its own `roomId`. Adding a second leave here risks
     * the roomId-less fallback that drops every tag on the socket.
     */
    const releaseDeadBoot = (): void => {
      /**
       * ⛔ NOTHING TO DO ONCE THE EFFECT WAS REALLY TORN DOWN — and worse than
       * nothing. `cancelled` is set only in the cleanup's REAL branch
       * (`:4131`), which runs `leaveInternal`: that already stops and nulls
       * both refs synchronously and nulls the registry slot under its own
       * gen check. So after a genuine teardown this helper can only be a no-op
       * or — before the gen guard below existed — a teardown of somebody
       * else's call.
       *
       * The MINIMIZE path deliberately returns from the cleanup BEFORE setting
       * `cancelled` (the `keepAlive` branch at `:4100`), so the case this
       * helper exists for is unaffected by this guard.
       */
      if (cancelled) {return;}

      const reg  = getActiveGroupCall();
      const ours = groupKeyRef.current;
      /**
       * ⚠️ IDENTITY, NOT CONVERSATION (WI-1.5). The first draft of this helper
       * tested `reg.conversationId === opts.conversationId`, which is NOT an
       * identity — several rooms and several generations legitimately share one
       * conversation, and `launchCall` EXPLICITLY permits a second call in the
       * same group (`rejoiningOwnGroup`, `launchCall.ts:302-305`). So a boot
       * stuck in the 25 s key wait would have ended the call the user started
       * afterwards. `leaveInternal` already learned this at `:5675` — same
       * generation test, same reason, and its comment names the same symptom.
       */
      const mine = !!reg && !!ours && reg.roomId === ours.roomId && reg.gen === ours.gen;

      /**
       * ⚠️ AND THE TRACKS MAY NOT BE OURS TO STOP. The resume path ADOPTS the
       * previous instance's track OBJECTS (`:1287-1288`) and inherits its
       * generation, so a stale twin timing out would stop the microphone and
       * camera of the call the user is looking at. Skip only when a registry
       * entry that is NOT ours is holding the very objects we are about to
       * stop — that is the precise "somebody restored or replaced me" case.
       * Everything else releases, because a held camera wedges the next
       * getUserMedia (B-343).
       */
      const stolen = !!reg && !mine
        && (reg.audioTrack === audioTrackRef.current || reg.videoTrack === videoTrackRef.current);

      if (!stolen) {
        try {
          // NOTE: the two refs, not the whole stream. `getLocalMedia` keeps only
          // the first audio and first video track, so in principle a stream with
          // extra tracks would leak them — but `localStream` is STATE here, not a
          // ref, and threading a mirror ref through every `setLocalStream` site
          // is a larger regression risk than the theoretical leak (getUserMedia
          // returns one track per kind under these constraints). Revisit only if
          // a multi-track stream is ever introduced.
          audioTrackRef.current?.stop(); audioTrackRef.current = null;
          videoTrackRef.current?.stop(); videoTrackRef.current = null;
          setLocalStream(null);
        } catch { /* best-effort release */ }
      }

      if (mine && reg.isMinimized) {
        // Keyed on the room the entry itself names, so a slot change between
        // the read and the call cannot redirect the teardown.
        void endActiveGroupCall(reg.roomId);
      }
    };
    // Resume path: if the registry already holds a live call for this
    // room, adopt its refs instead of starting fresh — covers the
    // floating-overlay → restore navigation. Without this branch,
    // remounting GroupCallScreen would build a second mediasoup pipeline,
    // re-acquire camera/mic, and the original call would still be running
    // invisibly.
    const existing = getActiveGroupCall();
    // If the registry holds an OLD room (different ids, or we're
    // creating a fresh room and the registry has anything stale)
    // wipe it now. Otherwise the floating overlay would briefly show
    // the previous call while the new one boots, and any leftover
    // dispatcher subscriptions could fire on the new room's frames.
    // Fix #8: capture the prior call's leave fn BEFORE we null the
    // registry. The stale-room teardown is awaited inside the boot's
    // async IIFE below — useEffect cleanup must stay synchronous, so
    // we can't await here. The IIFE blocks on staleLeavePromise
    // before issuing sfu.join, which guarantees the prior
    // sendTransport / recvTransport are closed by the time we ask the
    // SFU for fresh ones (otherwise sfu.join can fail with
    // "transport_id_in_use" or we end up with two transports in the
    // peer connection layer fighting for the same ICE candidates).
    // Fix #8 + BS-RECONNECT-MIN: decide whether the registry's call is
    // genuinely adoptable. The mediasoup transports aren't on the registry
    // shape, so read the STASHED handles for their REAL connectionState — a
    // WS reconnect WHILE MINIMIZED leaves them disconnected/failed/closed
    // (the server dropped us with no mounted hook to rejoin), and adopting
    // them yields a ZOMBIE call: tiles render, no media flows, and nothing
    // ever recovers. A dead-transport restore must fall through to a fresh,
    // fully-wired boot instead.
    const transportsAlive = (() => {
      if (!existing) {return false;}
      const stash = opts.roomId ? liveSfuHandlesByRoom.get(opts.roomId) : undefined;
      const sTx = stash?.sendTx as {connectionState?: string; closed?: boolean} | undefined;
      const rTx = stash?.recvTx as {connectionState?: string; closed?: boolean} | undefined;
      const txOk = (t?: {connectionState?: string; closed?: boolean}): boolean =>
        !!t && !t.closed
        && t.connectionState !== 'disconnected'
        && t.connectionState !== 'failed'
        && t.connectionState !== 'closed';
      const audioReady = existing.audioTrack ? (existing.audioTrack as unknown as {readyState?: string}).readyState !== 'ended' : true;
      const videoReady = existing.videoTrack ? (existing.videoTrack as unknown as {readyState?: string}).readyState !== 'ended' : true;
      // No stash (shouldn't happen on a genuine resume) — keep the prior
      // permissive track-only check so the common adopt fast-path isn't
      // regressed.
      if (!stash) {return audioReady && videoReady;}
      return audioReady && videoReady && txOk(sTx) && txOk(rTx);
    })();
    let staleLeavePromise: Promise<void> | null = null;
    // Tear the registry's call down when it's a DIFFERENT room OR the SAME
    // room with dead transports (reconnect-while-minimized). Either way we
    // must NOT adopt it; the staleLeavePromise blocks the fresh boot's
    // sfu.join until the old transports are closed (avoids transport_id_in_use).
    if (existing && (existing.roomId !== opts.roomId || !transportsAlive)) {
      console.log(`[bravo.groupcall.boot] clearing un-adoptable registry old=${existing.roomId} new=${opts.roomId ?? 'fresh'} transportsAlive=${transportsAlive}`);
      const oldLeave = existing.leave;
      setActiveGroupCall(null);
      if (oldLeave) {
        staleLeavePromise = oldLeave().catch((e) => {
          console.warn('[bravo.groupcall.boot] stale-room leave failed:', (e as Error).message);
        });
      }
    }
    // WI-1.6 — never adopt an entry that is mid-teardown. `ending` means the
    // transports are still closing; adopting them yields a call wired to dead
    // handles, which is exactly what the `transportsAlive` gate exists to stop.
    if (existing && opts.roomId && existing.roomId === opts.roomId && transportsAlive && !existing.ending) {
      // WI-1.5 — adoption INHERITS the key. Without this the restored instance
      // has no generation, and `leaveInternal`'s guard silently falls back to
      // the id-only test it exists to replace — for exactly the instance most
      // likely to overlap a same-room successor.
      groupKeyRef.current = {roomId: existing.roomId, gen: existing.gen};
      setRoomId(existing.roomId);
      setIsHost(existing.isHost);
      setSelfTag(existing.selfTag);
      setLocalStream(existing.localStream);
      setRemoteTiles(existing.remoteTiles);
      setIdentityByTag(existing.identityByTag);
      setIsMuted(existing.isMuted);
      setIsVideoOff(existing.isVideoOff);
      setState(existing.state);
      audioTrackRef.current = existing.audioTrack;
      videoTrackRef.current = existing.videoTrack;
      // Audit GC-05 — restore the call-start timestamp so ending the call from
      // a restored hook still appends a "Group call · N min" history bubble
      // (leaveInternal gates the bubble on callStartedAtRef, which only the
      // boot IIFE set — so a minimize→restore→hang-up produced no record).
      callStartedAtRef.current = existing.joinedAtMs ?? Date.now();
      // Audit BS-LEAK — rehydrate the live mediasoup handles into THIS
      // hook's refs. Without this, the restored hook's refs are empty,
      // the registry-sync effect re-binds `leave` to this hook's
      // leaveInternal, and ending the call closes nothing — leaking
      // every transport/producer/consumer + the camera/mic. Adopting the
      // SAME container objects means teardown sees producers/consumers
      // that arrived during the minimize window too.
      const stash = liveSfuHandlesByRoom.get(opts.roomId);
      if (stash) {
        adoptLiveHandles(stash);
      } else {
        console.warn('[bravo.groupcall.resume] no stashed mediasoup handles for room — teardown may leak; falling back to surface-only adopt');
      }
      patchActiveGroupCall(opts.roomId, {isMinimized: false, keepAlive: false});
      // Fix #7: re-register an SFU frame handler bound to THIS hook's
      // state setters. The original handler (registered by the prior
      // hook instance) captured stale setRemoteTiles / setIdentityByTag
      // closures — frames arriving after the user minimizes + restores
      // would update the OLD (unmounted) tree, never reaching the
      // visible UI. Replace with a fresh handler that mutates via
      // patchActiveGroupCall + this hook's setters; also trigger a
      // ref-driven consume for any new producers that arrive on resume.
      // NB: the registry warning from Fix #24 is expected here and is
      // the desired behaviour — we WANT the prior handler gone.
      try {
        // F6 minimize-leaks-sfu-handler — release the PRIOR boot's frame
        // handler BEFORE registering this one. The minimize keepAlive
        // early-return deliberately kept it alive (so producer events still
        // arrived while minimized), but on restore we overwrite cleanupSubRef
        // with the new handler below; without releasing the old one first it
        // stays registered (registerSfuHandler appends, it does not replace)
        // and keeps consuming frames into the now-unmounted tree — so a peer
        // who joins or switches audio→video after a restore can be routed into
        // the invisible prior handler and never get a tile. Each minimize→
        // restore cycle leaked another handler.
        // Audit F6 — release the PRIOR boot's handler via the module-scoped
        // stash (this fresh instance's own cleanupSubRef is null, so the old
        // `cleanupSubRef.current?.()` released nothing and handlers leaked).
        try { stash?.handlerCleanup?.(); } catch { /* ignore */ }
        try { cleanupSubRef.current?.(); } catch { /* ignore */ }
        cleanupSubRef.current = null;
        const cleanup = registerSfuHandler(opts.roomId, (frame) => {
          // We don't have the full mediasoup state on resume (the
          // previous boot owns deviceRef/recvTxRef in its closures),
          // so for resume we proxy a subset: participant.left removes
          // the tile from this hook's state; new-producer / kicked /
          // muted update React state. The actual mediasoup consume of
          // a NEW producer arriving on resume is out of scope for this
          // fix and would need a re-architecture (see audit Fix #7
          // notes — moving the handler into a separate fn callable
          // from both paths). For minimize→restore, the new-producer
          // window is narrow because we still get those events
          // through the original handler at the moment they're sent.
          if (frame.event === 'sfu.participant.left') {
            // BS-027 — same teardown as the primary handler. Resume
            // path is hit after minimize→restore so the per-consumer
            // cleanups + native-track-stop matter just as much (more,
            // even — the tile has been live longer).
            const f = frame.data as {participantTag: string};
            const leavingTiles: typeof remoteTiles = [];
            setRemoteTiles(prev => {
              const next: typeof prev = [];
              for (const t of prev) {
                if (t.participantTag !== f.participantTag) { next.push(t); continue; }
                leavingTiles.push(t);
              }
              return next;
            });
            for (const t of leavingTiles) {
              const cleanups = consumerCleanupsByPid.current.get(t.consumerId);
              if (cleanups) {
                for (const cb of cleanups) { try { cb(); } catch { /* ignore */ } }
                consumerCleanupsByPid.current.delete(t.consumerId);
              }
              try {
                const tr = (t.stream as unknown as {getTracks?: () => Array<{stop?: () => void}>}).getTracks?.();
                if (Array.isArray(tr)) {
                  for (const x of tr) { try { x.stop?.(); } catch { /* ignore */ } }
                }
              } catch { /* ignore */ }
              const c = consumersByPid.current.get(t.consumerId);
              if (c) { try { c.close(); } catch { /* ignore */ } consumersByPid.current.delete(t.consumerId); }
              inFlightConsumes.current.delete(t.producerId);
              // BS-MEDIA — drop from consumed set so a rejoin re-consumes.
              consumedProducerIdsRef.current.delete(t.producerId);
            }
            setIdentityByTag(prev => {
              if (!(f.participantTag in prev)) {return prev;}
              const next = {...prev};
              delete next[f.participantTag];
              return next;
            });
          } else if (frame.event === 'sfu.producer-paused' || frame.event === 'sfu.producer-resumed') {
            // Audit GC-03 — the restore handler MUST process camera-toggle
            // frames too (pure React state, no mediasoup needed). Without this
            // a peer turning their camera off/on after a minimize→restore
            // never updated the visible tile (stuck on frozen frame or, for
            // resume, stuck on the avatar for the rest of the call). Mirrors
            // the primary handler.
            const f = frame.data as {producerId: string; participantTag?: string; kind?: 'audio' | 'video'};
            const isPaused = frame.event === 'sfu.producer-paused';
            setRemoteTiles(prev => {
              const {tiles: next} = applyProducerPausedFrame(prev, f, isPaused);
              if (next !== prev) {patchActiveGroupCall(opts.roomId, {remoteTiles: next});}
              return next;
            });
          } else if (frame.event === 'sfu.muted') {
            const t = audioTrackRef.current;
            if (t) { t.enabled = false; setIsMuted(true); }
            // Audit GC-08 — persist so a subsequent restore rehydrates the
            // muted state (adopt seeds isMuted from the registry).
            patchActiveGroupCall(opts.roomId, {isMuted: true});
          } else if (frame.event === 'sfu.unmuted') {
            // Audit SFU-08 — host un-muted us (restore-path handler).
            const t = audioTrackRef.current;
            if (t) { t.enabled = true; }
            setIsMuted(false);
            patchActiveGroupCall(opts.roomId, {isMuted: false});
          } else if (frame.event === 'sfu.host-changed') {
            // KO-6 (B-566) — restore-path twin of the primary handler's
            // host-promotion case (see that comment). Promote-only.
            const newHost = (frame.data as {hostUserId?: string} | undefined)?.hostUserId;
            const stHost = useMessengerStore.getState();
            const ownUid = stHost._ownAuthUserId ?? stHost._ownUserId;
            if (newHost && ownUid && newHost === ownUid && !isHostRef.current) {
              setIsHost(true);
              patchActiveGroupCall(opts.roomId, {isHost: true});
            }
          } else if (frame.event === 'sfu.kicked') {
            wasKickedRef.current = true;
            setState('kicked');
            void (async () => {
              try { await leaveInternalRef.current?.(); } catch { /* ignore */ }
            })();
          } else if (frame.event === 'sfu.room.ended') {
            // Host ended the call for everyone — same path as the
            // primary handler. Server has already torn us down on its
            // side; we just need to clean up local refs. Finding #8(c):
            // reason:'worker_died' rides this same frame; teardown is
            // identical, we just log the reason. Graceful for any string.
            const endReason = (frame as unknown as {data?: {reason?: string}}).data?.reason;
            console.log(`[bravo.groupcall.frame] room.ended (restore) reason=${endReason ?? 'host-left'} — tearing down`);
            wasHostEndedRef.current = true;
            void (async () => {
              try { await leaveInternalRef.current?.(); } catch { /* ignore */ }
            })();
          }
        });
        cleanupSubRef.current = cleanup;
        // Audit F6 — keep the stash pointing at the CURRENTLY-registered
        // handler so the NEXT restore releases this one, not a stale fn.
        if (stash) {stash.handlerCleanup = cleanup;}
      } catch (e) {
        console.warn('[bravo.groupcall.resume] re-register sfu handler failed:', (e as Error).message);
      }
      // BS-RESUME-RECONCILE — arm the self-contained re-consume so the 4s
      // reconcile tick (which runs because we just setState(existing.state)
      // → 'joined') picks up any producer that appeared while we were
      // minimized (a new joiner / a peer enabling video). Fire once now too
      // so the recovery doesn't wait up to 4s.
      reconcileProducersRef.current = consumeMissingAfterRestore;
      void consumeMissingAfterRestore();
      // Audit L14 (2026-07-02): re-arm the WS-reconnect→rejoin recovery. The
      // boot IIFE arms this, but the adopt/restore path had NONE — so a WS drop
      // after a minimize→restore left the call zombied (tiles freeze, no media)
      // with no automatic recovery. Uses the adopted rejoinRoom (from the
      // stash). Defensive: if the rejoin fn is missing it no-ops (falls back to
      // the prior no-recovery behaviour); the boot path is untouched so the
      // common non-minimized reconnect is unaffected. The returned cleanup
      // removes the listener on the next unmount (no leak).
      const wsRestore = transportRef.current;
      if (wsRestore && rejoinRoomRef.current) {
        // B-101 LC-4 — REPLACE the hub's handler (the minimized window's
        // handler, installed by the previous hook instance, is still
        // live) so exactly one instance ever issues `sfu.join`.
        rejoinTokenRef.current = nextGroupCallRejoinToken(opts.roomId);
        setGroupCallRejoinHandler(rejoinTokenRef.current, wsRestore, () => {
          if (cancelled || isLeavingRef.current) {return;}
          const rid = roomIdRef.current;
          if (rid === null) {return;}
          const rejoin = rejoinRoomRef.current;
          if (!rejoin) {return;}
          // Shared, wall-clock-expiring guard (review F2/GC-4): a
          // per-instance ref would latch forever on an ack lost while
          // locked, and could not see a rejoin still in flight from the
          // hook instance that owned the call before this restore.
          // The claim identifies THIS attempt's hold on the shared slot, so
          // a later takeover cannot be undone by this one settling late.
          const rejoinClaim = beginGroupCallRejoin();
          if (!rejoinClaim) {return;}
          // WI-3.1 — the generation is taken when the rejoin ACTUALLY TAKES
          // OVER (inside onJoined), not when this handler fires.
          //
          // Bumping on entry looked equivalent and was not: a rejoin that
          // never reaches onJoined — the server refuses the join, the state is
          // no longer joinable, the socket dies again first — would still have
          // superseded the BOOT's generation. The boot's reconnect-budget
          // timer is guarded by that generation, so it would then abort
          // forever, and a call whose ICE later died would sit in
          // 'reconnecting' with nothing left able to fail it. Taking the
          // number here means "no rebuild started" leaves the boot current.
          //
          // `let`, because the failure branch below has to be guarded by the
          // SAME number the rebuild ran under — and there may be none.
          let attemptGen: number | null = null;
          // WI-5.3 — same live-resolve as the boot twin: this closure outlives
          // runtime rebuilds via the hub, so the captured wsRestore may be dead.
          const wsNow = getLiveTransport() ?? wsRestore;
          transportRef.current = wsNow;
          void attemptSfuRejoin<SfuJoinedResp['existingProducers']>({
            ws:        wsNow,
            roomId:    rid,
            roomToken: roomTokenRef.current,
            state:     stateRef.current,
            isLeaving: isLeavingRef.current,
            log:       (line) => console.log(line),
            request:   wsRequest,
            onJoined:  async (joined) => {
              // Review round 2 — our claim may have been taken over while this
              // ack was outstanding (the 90 s stuck-claim path exists for
              // exactly that). Minting a generation now would give this
              // ABANDONED attempt a higher number than the fresh one that
              // replaced it, and it would then tear down the transports that
              // attempt just built.
              if (rejoinClaim !== currentGroupCallRejoinClaim()) {
                logCallSm('groupcall.rejoin.late-ack.dropped', {room: shortCallId(rid)});
                return;
              }
              attemptGen = beginAttempt(rid);
              await rejoin(joined as SfuJoinedResp, attemptGen);
            },
            remintToken: remintRoomToken,   // F7
          })
            .then((outcome) => {
              if (outcome !== 'failed') {return;}
              // No rebuild ever started: nothing can have superseded us, so
              // apply the ORIGINAL teardown guards unchanged.
              if (attemptGen === null) {
                if (!cancelled && !isLeavingRef.current) {setState('failed');}
                return;
              }
              // A newer attempt may already have rebuilt the room while this
              // one was failing; failing the call then would stomp it.
              if (abortStaleAttempt('rejoin.outcome-failed', {
                roomId: rid, gen: attemptGen,
                cancelled, leaving: isLeavingRef.current,
              })) {return;}
              setState('failed');
            })
            .finally(() => { endGroupCallRejoin(rejoinClaim); });
        });
      }
      // No unsubscribe on unmount: the hub intentionally outlives the
      // screen so a MINIMIZED call can still re-join (LC-4). It is
      // cleared on real teardown by the boot effect's cleanup.
      return undefined;
    }

    // B-13 — late-joiner tile race. When this device joins a room that
    // already has ≥2 producers, the step=9 consume loop is SERIAL and each
    // consumer's setRemoteTiles fired its OWN React re-render. The first
    // re-render lands the instant `recvTx` flips to 'connected' — when only
    // 1 remote tile exists — and GroupCallScreen's retainedRef froze the
    // layout to 2 positions (1 remote + self). Tiles 2..N arrived ~700ms
    // later into a layout with no slots → user permanently saw 2 tiles.
    // Fix: during the initial step=9 burst, the loop calls consumeProducer
    // with batch=true so each tile is COLLECTED into this buffer instead of
    // firing its own setRemoteTiles; the loop then flushes them in a SINGLE
    // update so the layout computes once at the final count. Every OTHER
    // caller (live sfu.new-producer — a mid-call audio→video switch — and the
    // reconcile tick) passes batch=false and updates per-tile immediately.
    // The batch mode is an explicit per-call argument, NOT a shared flag, so
    // it can never leak into the live path (the regression that swallowed
    // mid-call video tiles).
    const pendingTileBatch: RemoteTile[] = [];
    void (async () => {
      // [CALLLAT] — a host START is always a new call (hard reset); an invitee
      // boot CONTINUES the clock MainNavigator's `ring:received` (or the
      // notification answer tap) started seconds earlier, unless that clock is
      // a stale one from a previous call on this conversation.
      firstAudioMarkedRef.current = false;
      const bootClock: CallLatOpts = opts.direction === 'incoming' ? {freshAfterMs: 90_000} : {reset: true};
      latG('boot', {dir: opts.direction, room: opts.roomId ? shortCallId(opts.roomId) : null}, bootClock);
      // Fix #8: await the stale-room teardown FIRST so the SFU has
      // actually freed the prior client's transport ids before we
      // request fresh ones via sfu.join. Cap to ~3s so a hung leave
      // doesn't permanently block a fresh call (server-side cleanup
      // will kick in via the ws-disconnect path).
      // WI-1.6 — the registry's own in-flight leave counts too. `endActiveGroupCall`
      // now holds the slot (`ending: true`) until leave() resolves, so a boot
      // that raced it would otherwise call sfu.join against transports the
      // previous call has not finished closing.
      //
      // BOTH, not either: when both exist, `staleLeavePromise` is the worthless
      // one. The un-adoptable branch above calls the SAME `leaveInternal`
      // closure, whose `isLeavingRef` is already set by the teardown in flight,
      // so it returns an already-resolved promise — and `??` would have picked
      // exactly that and waved the join straight through. One shared ≤3 s bound.
      const priorLeaves = [staleLeavePromise, groupLeaveInFlight()]
        .filter((p): p is Promise<void> => !!p);
      if (priorLeaves.length > 0) {
        await Promise.race([
          Promise.all(priorLeaves),
          new Promise<void>(r => setTimeout(r, 3000)),
        ]);
      }
      // B-275 — accepting a group call from its notification COLD-STARTS the
      // app (logcat: "Start proc … for broadcast ReactNativeFirebaseMessaging-
      // Receiver"), and this asked for the socket exactly once, then declared
      // the call permanently unavailable. That is the whole bug.
      //
      // Waiting alone is NOT enough: `setLiveTransport` is called from exactly
      // one place — buildProductionRuntime — so on a push cold-start there may
      // be nothing constructing the transport at all, and a bare wait would
      // just time out more slowly (the device sat 8.7s with no socket). So boot
      // the runtime first. getMessengerRuntime() is an idempotent singleton and
      // B-272's config gate makes it safe to call this early; it is a no-op
      // when MainNavigator already booted it.
      let ws = getLiveTransport();
      if (!ws) {
        console.warn('[CALLDIAG] [bravo.groupcall.boot] no WS — booting runtime (cold start?)');
        try {
          await getMessengerRuntime();
        } catch (e) {
          console.warn('[bravo.groupcall.boot] runtime boot failed:', (e as Error).message);
        }
        if (cancelled || isLeavingRef.current) {return;}
        ws = getLiveTransport() ?? await waitForLiveTransport();
      }
      if (cancelled || isLeavingRef.current) {return;}
      if (!ws) {
        console.warn('[bravo.groupcall.boot] FAIL — no live WS transport, cannot start');
        setState('unavailable'); return;
      }
      console.warn('[CALLDIAG] [bravo.groupcall.boot] transport acquired — continuing');
      transportRef.current = ws;
      // B-05 — when the WS reopens after the server's P0-6 revoked-socket
      // sweep + the TransportClient refresh path, the SFU room/transports
      // were torn down server-side. An ICE restart over the fresh socket
      // (the old recovery path) would ack_timeout and end in 'failed'. We
      // RE-JOIN the room instead, inside the SFU's 60s zombie-room grace
      // window. The group key is unchanged so the SFrame layer is reused.
      // B-101 LC-4 — install via the hub, which keeps ONE subscription
      // alive across minimize (this effect's cleanup used to drop it,
      // leaving a minimized call with no way to re-join after a socket
      // bounce) and replaces rather than stacks handlers on restore.
      rejoinTokenRef.current = nextGroupCallRejoinToken(opts.roomId ?? 'new');
      setGroupCallRejoinHandler(rejoinTokenRef.current, ws, () => {
        if (cancelled || isLeavingRef.current) {return;}
        const rid = roomIdRef.current;
        if (rid === null) {return;}
        const rejoin = rejoinRoomRef.current;
        if (!rejoin) {return;}
        // Shared, wall-clock-expiring guard — see the restore-path twin
        // and the hub's rationale (review F2/GC-4).
        const rejoinClaim = beginGroupCallRejoin();
        if (!rejoinClaim) {return;}
        // WI-3.1 — see the restore-path twin for why the generation is taken
        // inside onJoined rather than here.
        let attemptGen: number | null = null;
        // WI-5.3 — the closure captured ws by VALUE at boot; after a runtime
        // rebuild the hub re-binds to the NEW transport and fires this handler
        // from it — the rejoin must ride that live socket, not the corpse.
        const wsNow = getLiveTransport() ?? ws;
        transportRef.current = wsNow;
        void attemptSfuRejoin<SfuJoinedResp['existingProducers']>({
          ws:        wsNow,
          roomId:    rid,
          roomToken: roomTokenRef.current,
          state:     stateRef.current,
          isLeaving: isLeavingRef.current,
          log:       (line) => console.log(line),
          request:   wsRequest,
          onJoined:  async (joined) => {
            // See the restore-path twin: a takeover while our ack was
            // outstanding must not let this attempt mint a NEWER generation
            // than the one that replaced it.
            if (rejoinClaim !== currentGroupCallRejoinClaim()) {
              logCallSm('groupcall.rejoin.late-ack.dropped', {room: shortCallId(rid)});
              return;
            }
            attemptGen = beginAttempt(rid);
            await rejoin(joined as SfuJoinedResp, attemptGen);
          },
          remintToken: remintRoomToken,   // F7
        })
          .then((outcome) => {
            if (outcome !== 'failed') {return;}
            if (attemptGen === null) {
              if (!cancelled && !isLeavingRef.current) {setState('failed');}
              return;
            }
            if (abortStaleAttempt('rejoin.outcome-failed', {
              roomId: rid, gen: attemptGen,
              cancelled, leaving: isLeavingRef.current,
            })) {return;}
            setState('failed');
          })
          .finally(() => { endGroupCallRejoin(rejoinClaim); });
      });
      console.log(`[bravo.groupcall.boot] start direction=${opts.direction} callType=${opts.callType} convo=${opts.conversationId} recipients=${opts.recipientUserIds.length}`);

      try {
        // 0. Fetch TURN credentials in parallel with room setup. Symmetric
        // NAT clients depend on relay; iceTransportPolicy: 'relay' below
        // forces relay-only on the *client* transport (mediasoup's
        // WebRtcTransport on the server side has its own ICE).
        latG('turn:start');
        const turnT0 = Date.now();
        const turnPromise = fetchTurnCredentials().then(servers => {
          // A cancelled boot's late resolution must not stamp the next boot's clock.
          if (!cancelled) {latG('turn:resolved', {ms: Date.now() - turnT0, n: servers.length});}
          return servers;
        });
        console.log('[bravo.groupcall.boot] step=0 fetching TURN credentials');

        // 1. Create or join. The server's createRoom is idempotent per
        // conversationId — passing a fresh conversationId guarantees the
        // 2nd member tapping "call" lands in the same room as the 1st.
        //
        // Audit row #5 — `roomToken` is the HMAC echo the gateway needs
        // on `sfu.join`. Outgoing path: read `hostRoomToken` from the
        // POST /sfu/rooms response. Incoming path: it was carried via
        // ring → IncomingGroupCallScreen → opts.roomToken.
        let rid = opts.roomId ?? null;
        // P1-BR-1 — normalise an empty-string roomId to null. `?? null` only
        // catches null/undefined, so a '' from a malformed notification
        // payload would slip through as a falsy rid and hit the create path.
        if (rid !== null && rid.trim() === '') {rid = null;}
        let roomToken: string | undefined = opts.roomToken;
        // P1-BR-1 — an INCOMING group call MUST carry a roomId: it joins the
        // host's EXISTING room. A missing/empty id here (dropped from the
        // ring/notification payload) must FAIL, never fall through to
        // POST /sfu/rooms — that would silently mint a brand-new empty room
        // the host is not in, and even a correct-but-tokenless sfu.join is
        // rejected `room_token_required` in production. Only the outgoing
        // (host) path legitimately has no roomId.
        if (opts.direction === 'incoming' && !rid) {
          console.warn('[bravo.groupcall.boot] incoming call has no roomId — refusing to create a new room (P1-BR-1)');
          setState('unavailable');
          return;
        }
        if (!rid) {
          // B-342 follow-up — warn, not log: release strips `log`, and NOT
          // being able to tell "created a room" from "joined an existing
          // one" is what forced every lane of the 2026-08-12 investigation
          // to infer the room's origin by elimination.
          console.warn('[CALLDIAG] [bravo.groupcall.boot] step=1 creating room (no existing roomId)');
          setState('creating');
          // fetchWithRefresh attaches the access token AND auto-refreshes
          // on 401 (same code path as the axios interceptor). Without it,
          // a stale token here would 401 the room create even though the
          // user's session is still recoverable via /auth/refresh —
          // observed live as `boot failed: sfu_rooms_401` after a long
          // foreground gap.
          const {fetchWithRefresh} = require('@/services/api') as typeof import('@/services/api');
          const res = await fetchWithRefresh(`${MSG_BASE_URL}/sfu/rooms`, {
            method: 'POST',
            headers: {
              'Content-Type':       'application/json',
              'X-Signal-Device-Id': '1',
            },
            body: JSON.stringify({conversationId: opts.conversationId}),
          });
          if (!res.ok) {throw new Error(`sfu_rooms_${res.status}`);}
          const body = await res.json() as {roomId: string; hostRoomToken?: string};
          rid = body.roomId;
          // Synchronous, before any React state — see createdRoomIdRef.
          createdRoomIdRef.current = rid;
          if (body.hostRoomToken) {roomToken = body.hostRoomToken;}
          console.warn(`[CALLDIAG] [bravo.groupcall.boot] step=1 room created roomId=${rid.slice(0, 8)}`);
          latG('room:created', {room: shortCallId(rid)});
        } else {
          console.warn(`[CALLDIAG] [bravo.groupcall.boot] step=1 joining existing room roomId=${rid.slice(0, 8)} direction=${opts.direction}`);
          latG('room:existing', {room: shortCallId(rid)});
        }
        if (cancelled) {return;}
        setRoomId(rid);
        // Audit row #5 (C2) — capture the host/joiner token in a ref so
        // leaveInternal's `sfu.ring.cancel` (host) can echo it. The
        // decline path reads its token from route params directly.
        roomTokenRef.current = roomToken;

        // B-344/B-345 — seed the room's presence sent-set (lives in the
        // identity registry so participant-LEFT processing can un-learn a
        // leaver for both frame-handler variants) with the step-10 broadcast
        // targets; a mid-call joiner is exactly what falls outside this seed.
        markPresenceSent(rid, opts.recipientUserIds);

        // B-06 — early producer buffer. New-producer frames that arrive
        // before the recv pipeline (recvTx + consumeProducer) is live are
        // queued and drained on connect; afterwards they consume inline.
        // `consumeProducer` is a hoisted function declaration further down
        // in this IIFE, so referencing it from these closures is safe even
        // though source-order puts its body after this point.
        const earlyProducerBuffer = createEarlyProducerBuffer(
          // WI-3.2 — a rejoin closes both transports before rebuilding them,
          // so "ready" must be false for its whole duration: consuming into a
          // half-built reRecvTx re-inserts tiles the rejoin has just cleared.
          () => !!recvTxRef.current && !!groupEncryptionRef.current && !cancelled
                && !isLeavingRef.current && !isAttemptRunning(rid ?? ''),
          (p) => { void consumeProducer(p.producerId, p.participantTag, p.kind); },
        );
        earlyProducerBufferRef.current = earlyProducerBuffer;

        // 7. (moved up from after step 6) Subscribe to per-room SFU frames
        // (new producers, leaves, moderation pings) as soon as the roomId
        // is known — BEFORE sfu.join — so a peer that starts producing in
        // the join→recvTx window isn't dropped. Producer frames are routed
        // through `earlyProducerBuffer` and drained once the recv pipeline
        // is ready (after step 9); the 4 s reconcile stays a pure backstop.
        /**
         * Registration is wrapped in a factory (rather than called inline)
         * so the step-3 `room_not_found` retry can RE-POINT it at the room
         * it actually joined. `registerSfuHandler` keys strictly by roomId,
         * so a handler left registered against a reaped room would receive
         * nothing — no new-producer, no participant.left, no room.ended —
         * and the caller would sit in a live call with a grid that never
         * populates. The body reads `rid` from the enclosing `let`, so it
         * needs no other change when the id moves.
         */
        const registerFramesFor = (roomForFrames: string) => registerSfuHandler(roomForFrames, (frame) => {
          if (cancelled) {return;}
          if (frame.event === 'sfu.new-producer') {
            const f = frame.data as {producerId: string; participantTag: string; kind: 'audio' | 'video'};
            console.log(`[bravo.groupcall.frame] new-producer tag=${f.participantTag.slice(0,8)} kind=${f.kind} pid=${f.producerId.slice(0,8)}`);
            // B-06 — route through the early buffer. Before the recv pipeline
            // is ready (handler now registers BEFORE sfu.join) the event is
            // queued and drained on connect; afterwards it consumes inline.
            // consumeProducer dedups (consumedProducerIds + inFlightConsumes)
            // so an event seen both here and in step-9 existingProducers
            // can't double-consume.
            earlyProducerBufferRef.current?.accept({
              producerId: f.producerId, participantTag: f.participantTag, kind: f.kind,
            });
          } else if (frame.event === 'sfu.producer-paused' || frame.event === 'sfu.producer-resumed') {
            // Peer toggled their camera/mic. Authoritative — the server
            // paused/resumed its producer before fanning this out. Flips
            // the tile to its avatar placeholder (paused) or back to the
            // live plane (resumed) without waiting on the native track
            // 'mute' heuristic, which never fires when a disabled track
            // keeps emitting frames.
            const f = frame.data as {producerId: string; participantTag?: string; kind?: 'audio' | 'video'};
            const isPaused = frame.event === 'sfu.producer-paused';
            setRemoteTiles(prev => {
              // producerId-primary, (participantTag, kind)-fallback match. The
              // fallback is what stops a producerId drift from silently dropping
              // the camera-state flip and freezing the peer tile — see
              // applyProducerPausedFrame for the full why. Unit-tested there.
              const {tiles: next, matchedBy} = applyProducerPausedFrame(prev, f, isPaused);
              console.log(`[bravo.groupcall.frame] producer-${isPaused ? 'paused' : 'resumed'} pid=${f.producerId.slice(0,8)} tag=${(f.participantTag ?? '?').slice(0,6)} matchedBy=${matchedBy} videoPids=${prev.filter(t => t.kind === 'video').map(t => t.producerId.slice(0,8)).join(',')}`);
              if (next !== prev) {patchActiveGroupCall(roomForFrames, {remoteTiles: next});}
              return next;
            });
          } else if (frame.event === 'sfu.participant.joined') {
            const f = frame.data as {participantTag: string};
            console.log(`[bravo.groupcall.frame] participant.joined tag=${f.participantTag.slice(0,8)}`);
          } else if (frame.event === 'sfu.participant.left') {
            // BS-027 — when a peer leaves a 3+ participant group call,
            // their tile was freezing on the last decoded frame for the
            // remaining peers instead of dropping cleanly. The old impl
            // closed the consumer + filtered the tile out, but did NOT:
            //   1. Fire the per-consumer cleanups that flip the
            //      listenerCancelled flag (so trackended/mute callbacks
            //      registered on the just-closed consumer continued to
            //      fire setRemoteTiles/setIdentityByTag on stale state)
            //   2. Stop the underlying MediaStreamTrack (RN-WebRTC keeps
            //      the native handle alive after consumer.close, so the
            //      decoder buffer holds the last frame and any
            //      still-mounted RTCView keeps painting it)
            //   3. Mirror the new tile list to the registry — meaning
            //      the floating overlay's snapshot still showed the
            //      leaver's tile until the next remoteTiles change
            //   4. Clear the leaver's identityByTag entry, so the
            //      invite-candidates filter still excluded them as
            //      "joined" even though they had already left
            const f = frame.data as {participantTag: string};
            const leavingTiles: typeof remoteTiles = [];
            setRemoteTiles(prev => {
              const next: typeof prev = [];
              for (const t of prev) {
                if (t.participantTag !== f.participantTag) { next.push(t); continue; }
                leavingTiles.push(t);
              }
              return next;
            });
            for (const t of leavingTiles) {
              // Fire per-consumer cleanups (flips listenerCancelled).
              const cleanups = consumerCleanupsByPid.current.get(t.consumerId);
              if (cleanups) {
                for (const cb of cleanups) { try { cb(); } catch { /* ignore */ } }
                consumerCleanupsByPid.current.delete(t.consumerId);
              }
              // Stop the underlying track BEFORE closing the consumer.
              // Reverses the freeze: with the track stopped, RTCView's
              // last-frame buffer is invalidated and the next render
              // (the post-filter empty state) is genuinely empty.
              try {
                const tr = (t.stream as unknown as {getTracks?: () => Array<{stop?: () => void}>}).getTracks?.();
                if (Array.isArray(tr)) {
                  for (const x of tr) { try { x.stop?.(); } catch { /* ignore */ } }
                }
              } catch { /* ignore */ }
              const c = consumersByPid.current.get(t.consumerId);
              if (c) { try { c.close(); } catch { /* ignore */ } consumersByPid.current.delete(t.consumerId); }
              inFlightConsumes.current.delete(t.producerId);
              // BS-MEDIA — drop from consumed set so a rejoin re-consumes.
              consumedProducerIdsRef.current.delete(t.producerId);
            }
            // Drop the leaver from identityByTag too. (B-345 — the presence
            // sent-set un-learn happens in the registry's forgetObservedTag,
            // which sfuDispatcher feeds for every participant.left before
            // this handler runs.)
            setIdentityByTag(prev => {
              if (!(f.participantTag in prev)) {return prev;}
              const next = {...prev};
              delete next[f.participantTag];
              return next;
            });
          } else if (frame.event === 'sfu.muted') {
            // Host muted us — flip our audio track off + show indicator.
            const t = audioTrackRef.current;
            if (t) { t.enabled = false; setIsMuted(true); }
            // Audit GC-08 — persist so a minimize→restore rehydrates the
            // muted state from the registry (adopt seeds isMuted from it).
            patchActiveGroupCall(roomForFrames, {isMuted: true});
          } else if (frame.event === 'sfu.unmuted') {
            // Audit SFU-08 — host un-muted us. The server already unpaused our
            // producers; clear the UI muted state so the mic icon matches.
            const t = audioTrackRef.current;
            if (t) { t.enabled = true; }
            setIsMuted(false);
            patchActiveGroupCall(roomForFrames, {isMuted: false});
          } else if (frame.event === 'sfu.host-changed') {
            // KO-6 (B-566) — a failed host-claiming join handed the claim
            // over AFTER our own join ack said isHost:false. The server's
            // authority is the truth (it gates ring-cancel + moderation);
            // without this the room's real host doesn't know it — no
            // call-key mint, no ring cancel. Promote-only: no demotion
            // lane exists (the failed claimant never became host locally).
            const newHost = (frame.data as {hostUserId?: string} | undefined)?.hostUserId;
            const stHost = useMessengerStore.getState();
            const ownUid = stHost._ownAuthUserId ?? stHost._ownUserId;
            if (newHost && ownUid && newHost === ownUid && !isHostRef.current) {
              setIsHost(true);
              patchActiveGroupCall(roomForFrames, {isHost: true});
            }
          } else if (frame.event === 'sfu.kicked') {
            // Host booted us — tear down hard. Set the ref BEFORE
            // calling leave so the bubble-emit branch sees we were
            // kicked (the React state setter is async and would lose
            // the race against the synchronous leaveInternal body).
            wasKickedRef.current = true;
            setState('kicked');
            void leaveInternal();
          } else if (frame.event === 'sfu.room.ended') {
            // Host ended the call for everyone (WhatsApp/Zoom-style
            // host-leaves-everyone-drops semantics). The server has
            // ALREADY closed our consumers/transports + deleted the
            // room — we just need to tear down the local session and
            // stop pretending we're in a call. Skip the WS sfu.leave
            // round-trip (server doesn't have us anymore) by setting
            // the ref so leaveInternal short-circuits the WS calls.
            //
            // Finding #8(c) — the frame can now carry reason:'worker_died'
            // (SFU worker crash) as well as the host-left case. The room is
            // gone server-side either way, so the teardown is identical; we
            // just log the reason so a crash is distinguishable in the
            // trace. This is an if/else, not an exhaustive switch, so an
            // unknown reason falls through to the same graceful teardown.
            const endReason = (frame as unknown as {data?: {reason?: string}}).data?.reason;
            console.log(`[bravo.groupcall.frame] room.ended reason=${endReason ?? 'host-left'} — tearing down`);
            wasHostEndedRef.current = true;
            void leaveInternal();
          }
        });
        cleanupSubRef.current = registerFramesFor(rid);
        console.log('[bravo.groupcall.boot] step=1b sfu frame handler registered (pre-join)');

        // B-343 — end a STALE call before acquiring media. setActiveGroupCall
        // below OVERWRITES whatever entry is in the registry without ending
        // it, orphaning that call's tracks (only its bound leave() can stop
        // them) — and a zombie's held camera makes THIS boot's getUserMedia
        // queue behind it and die at the 15 s bound ("Call failed" forever,
        // founder 2026-07-30 19:34-19:35). A different-room entry here is by
        // definition dead weight: the user is accepting/starting THIS call.
        // Ending it stops its tracks, freeing the camera for step 2. The
        // same-room case (minimize→restore) never reaches this code — the
        // adopt path returns earlier.
        {
          const stale = getActiveGroupCall();
          if (stale && stale.roomId !== rid) {
            console.warn(`[CALLDIAG] [bravo.groupcall.boot] ending stale call room=${stale.roomId.slice(0, 8)} before joining room=${rid.slice(0, 8)} — releasing its media (B-343)`);
            // WI-1.5 — keyed on the STALE room the guard above identified.
            try { await endActiveGroupCall(stale.roomId); } catch { /* best-effort — media may still free */ }
          }
        }

        // 2. Acquire local media. Voice-only call still acquires mic;
        // video producer is added later so toggleVideo() can flip on
        // mid-call without renegotiation surprises.
        console.log(`[bravo.groupcall.boot] step=2 acquiring local media (video=${isVideo})`);
        latG('media:start', {video: isVideo});
        const mediaT0 = Date.now();
        const {stream, audioTrack, videoTrack} = await getLocalMedia({video: isVideo});
        if (cancelled) {
          // Stop tracks AND best-effort fire sfu.leave so the server-
          // side janitor (post-#15) can reap the room. Without this the
          // host-created room sits in `rooms.set(rid, …)` with zero
          // participants until process restart and `findRoomForConver-
          // sation` would hand it to the next caller as a zombie.
          stream.getTracks().forEach(t => t.stop());
          try {
            void wsRequest<{ok: boolean}>(ws, 'sfu.leave', {roomId: rid}).catch(() => undefined);
          } catch { /* ignore */ }
          return;
        }
        audioTrackRef.current = audioTrack;
        videoTrackRef.current = videoTrack;
        setLocalStream(stream);
        // B-340 — warn, not log: this is the far edge of the permission-prompt
        // dark window (see getLocalMedia). Release builds keep only warns, and
        // the absence of THIS line after "transport acquired" is what finally
        // localised four silent join failures to the media step.
        console.warn(`[CALLDIAG] [bravo.groupcall.boot] step=2 local media OK audio=${!!audioTrack} video=${!!videoTrack}`);
        latG('media:ok', {ms: Date.now() - mediaT0, audio: !!audioTrack, video: !!videoTrack});

        // BS-MINIMIZE-RING — seed the floating-overlay registry NOW, while
        // the call is still connecting/ringing (before sfu.join), so pressing
        // back MINIMIZES it to a bubble instead of being stuck on the
        // "waiting…" screen (mirrors the 1:1 useCall early-seed). The 'joined'
        // publish below upgrades this entry (preserving any minimize the user
        // did while it rang); the boot-failed and leave paths clear it so the
        // bubble dismisses on timeout/no-answer.
        groupKeyRef.current = setActiveGroupCall({
          roomId:           rid,
          conversationId:   opts.conversationId,
          conversationName: opts.callerName,
          callType:         opts.callType,
          /**
           * Seeded FALSE, not from `direction`. Until this fix, an outgoing
           * boot always created its own room, so "outgoing" implied "host"
           * by construction. It no longer does: a caller who taps Call and
           * is handed an existing room now also boots outgoing, and the
           * server may legitimately answer `isHost:false`. The join ack at
           * step 3 is the only authority; nothing before it needs host
           * rights, and claiming them early showed host-only controls in
           * the floating overlay for a call the user does not own.
           */
          isHost:           false,
          selfTag:          null,
          state:            'joining',
          localStream:      stream,
          remoteTiles:      [],
          identityByTag:    {},
          audioLevels:      {},
          audioTrack,
          videoTrack,
          isMuted:          false,
          isVideoOff:       false,
          isMinimized:      false,
          keepAlive:        false,
          leave:            leaveInternal,
          toggleMute:       toggleMuteInternal,
          toggleVideo,
          joinedAtMs:       null,
        });

        // B-111-A — refuse BEFORE joining when this build can never run the
        // call. The S6 kill site below (after join) remains the last-line
        // authority; this pre-join copy of the SAME check just stops the
        // iOS user from flashing into the roster and instantly leaving
        // (peers read that as a network glitch). Never weakens S6 — a
        // build without FrameCryptor still cannot reach media either way.
        if (!frameCryptorOrchestratorAvailable()) {
          console.warn('[bravo.groupcall.boot] pre-join: FrameCryptor unavailable on this build — refusing before sfu.join (S6/B-111)');
          if (!cancelled) {setState('failed');}
          releaseDeadBoot(); // B-642
          return;
        }
        // 3. WS sfu.join — receive caps + transport params + isHost.
        // Audit row #5 — include the room-access token so the gateway
        // verifies us. Omitted on configs without the secret set.
        // B-340 — warn-level for release visibility (see step=2 note).
        console.warn(`[CALLDIAG] [bravo.groupcall.boot] step=3 sfu.join room=${rid.slice(0, 8)} hasToken=${!!roomToken}`);
        setState('joining');
        let joined: SfuJoinedResp;
        latG('join:sent');
        const joinT0 = Date.now();
        try {
          joined = await wsRequest<SfuJoinedResp>(ws, 'sfu.join', {roomId: rid, roomToken});
        } catch (e) {
          if ((e as Error).message?.includes('room_full')) {
            console.warn('[bravo.groupcall.boot] step=3 FAIL room_full');
            setState('full');
            // B-642 — same bypass class as the FrameCryptor refusals: media is
            // already held from step 2, this renders the same blocker card, and
            // it never reaches the outer catch.
            releaseDeadBoot();
            return;
          }
          /**
           * The room we were handed vanished between the probe and the join.
           *
           * This is a REAL race, not a theoretical one: the by-conversation
           * probe hands out a room for a grace window before anyone is in
           * it, and the creator's own boot may fail and reap it during the
           * 2-10s we spend acquiring media. Whoever tapped Call second then
           * joined nothing. Re-creating is exactly right for them — they
           * tapped Call, they intend to summon — and `POST /sfu/rooms` is
           * idempotent per conversation, so if a THIRD party has meanwhile
           * made a live room we join theirs instead of forking the call.
           *
           * ONE retry, and only for a user who tapped Call. An 'incoming'
           * boot must never mint a room (P1-BR-1): its room belongs to the
           * host, and creating a new one would strand the caller in a room
           * nobody else is in.
           */
          const vanished = (e as Error).message?.includes('room_not_found');
          if (!vanished || opts.direction !== 'outgoing') {
            console.warn('[bravo.groupcall.boot] step=3 FAIL', (e as Error).message);
            throw e;
          }
          console.warn('[CALLDIAG] [bravo.groupcall.boot] step=3 room vanished — re-creating once room=', rid.slice(0, 8));
          // Check BEFORE minting. A cancel discovered after the create would
          // `return` past this boot's catch, leaving the room we just made as
          // the very kind of corpse this change set exists to stop producing.
          if (cancelled || isLeavingRef.current) {return;}
          const {fetchWithRefresh: refetch} = require('@/services/api') as typeof import('@/services/api');
          const reRes = await refetch(`${MSG_BASE_URL}/sfu/rooms`, {
            method:  'POST',
            headers: {'Content-Type': 'application/json', 'X-Signal-Device-Id': '1'},
            body:    JSON.stringify({conversationId: opts.conversationId}),
          });
          if (!reRes.ok) {throw new Error(`sfu_rooms_${reRes.status}`);}
          const reBody = await reRes.json() as {roomId: string; hostRoomToken?: string};
          // WI-1.5 — capture the id the registry currently holds BEFORE `rid`
          // moves to the new room. `roomIdRef.current` is NOT a substitute: it
          // is fed by an effect off `setRoomId`, so it lags a React commit.
          const priorRid = rid;
          rid = reBody.roomId;
          createdRoomIdRef.current = rid;
          roomToken = reBody.hostRoomToken ?? undefined;
          roomTokenRef.current = roomToken;
          setRoomId(rid);
          /**
           * RE-POINT every room-scoped binding made before the first join.
           *
           * Each of these was keyed to the room that has just been reaped,
           * and leaving them behind is worse than the failure being
           * recovered from: `registerSfuHandler` matches strictly on roomId,
           * so the device would join the new room and then receive none of
           * its frames — no producers, no participant.left, no room.ended —
           * i.e. a call that connects to a permanently empty grid. The
           * registry entry matters too: `leaveInternal` only tears down when
           * `reg.roomId === rid`, so a stale id there strands the slot and
           * `launchCall`'s busy guard then blocks calls in OTHER
           * conversations with "Call in progress".
           */
          cleanupSubRef.current?.();
          cleanupSubRef.current = registerFramesFor(rid);
          markPresenceSent(rid, opts.recipientUserIds);
          // WI-1.5 — the ONE legitimate room-id rewrite, keyed on the id the
          // registry actually holds. `patchActiveGroupCall(rid, {roomId: rid})`
          // would silently no-op (the slot still says `priorRid`) and strand
          // the entry on the reaped room — exactly what the note above warns of.
          renameActiveGroupCallRoom(priorRid, rid);
          if (cancelled || isLeavingRef.current) {return;}
          console.warn('[CALLDIAG] [bravo.groupcall.boot] step=3 retry sfu.join room=', rid.slice(0, 8));
          joined = await wsRequest<SfuJoinedResp>(ws, 'sfu.join', {roomId: rid, roomToken});
        }
        if (cancelled) {
          // Rapid leave-during-boot leak: user tapped End between media-
          // acquire and join-ack. Server has now built a full Participant
          // (sendTransport + recvTransport + Router slot) and registered
          // it in `sfuSocketTags`. If we just `return` here,
          // leaveInternal() runs but participantTagRef is still null AND
          // rid may be set (host case) — the `if (ws && rid)` guard
          // sends sfu.leave WITHOUT a participantTag, server's
          // handleSfuLeave then iterates ALL tags on the socket which is
          // a separate bug (see SFU server-side fix). The cleaner fix
          // here: fire a synchronous best-effort sfu.leave with the
          // freshly-issued tag. Server's leaveRoom is keyed by tag.
          try {
            void wsRequest<{ok: boolean}>(ws, 'sfu.leave', {roomId: rid}).catch(() => undefined);
          } catch { /* ignore — best effort */ }
          return;
        }
        participantTagRef.current = joined.participantTag;
        setSelfTag(joined.participantTag);
        setIsHost(joined.isHost);
        // B-344 — feed the P0-C3 observed-tag set from the join ack. The
        // existingProducers list is the same SFU authority as the
        // sfu.participant.joined frames that normally feed it, but those
        // frames fired BEFORE we joined and were never replayed to us — so a
        // late joiner's strict mode knew none of the room's real tags and
        // rejected legitimate presence envelopes. This ADDS authoritative
        // observations; the gate's rule is unchanged.
        try {
          for (const ep of joined.existingProducers) {
            recordObservedTag(rid, ep.participantTag);
          }
        } catch { /* registry feed is best-effort */ }
        // B-340 — warn-level for release visibility (see step=2 note).
        console.warn(`[CALLDIAG] [bravo.groupcall.boot] step=3 joined tag=${joined.participantTag.slice(0,8)} isHost=${joined.isHost} existingProducers=${joined.existingProducers.length}`);
        latG('join:ack', {ms: Date.now() - joinT0, existing: joined.existingProducers.length, host: joined.isHost});

        // S6 / P0-C1 — initialise SFrame encryption. Refuses to proceed
        // when the platform lacks encoded-transform support OR when the
        // group has no local master key. Either branch surfaces as a
        // 'failed' state — we do NOT silently fall back to plaintext
        // because the SFU would then have access to media bytes.
        if (!frameCryptorOrchestratorAvailable()) {
          console.warn('[bravo.groupcall.boot] step=3 FrameCryptor unavailable on this build — refusing to start unencrypted group call (S6)');
          if (!cancelled) {setState('failed');}
          try {
            void wsRequest<{ok: boolean}>(ws, 'sfu.leave', {roomId: rid}).catch(() => undefined);
          } catch { /* ignore */ }
          releaseDeadBoot(); // B-642
          return;
        }
        try {
          // BS-CALL-ADHOC — ensure a group master key exists for this call.
          // For a real group chat opts.conversationId already has one (no-op).
          // For an ad-hoc/escalated call from a 1:1 (`direct:*`), the HOST
          // mints + distributes a fresh key to the ring recipients via the
          // proven sealed fan-out. Recipients receive it through the normal
          // incoming-envelope handler (admin/create). The returned id is
          // what we key the FrameCryptor off. Host-only: a recipient that
          // hasn't received the key yet will fail-closed below and retry as
          // the create envelope lands.
          // Host-only fallback id (reassigned from ensureCallGroupKey below);
          // the joiner resolves its key slot via resolveKeyId() instead.
          let keyConvoId = opts.conversationId;
          // BS-CALL-REALGROUP — the master key may live in EITHER of two
          // slots and the joiner can't tell which from the ring alone:
          //   • ad-hoc escalated 1:1 ('Call'): receive-side aliases it under
          //     `direct:<owner>` = `direct:<host>` (productionRuntime
          //     name==='Call' branch).
          //   • real named group: filed ONLY under the real `conversationId`
          //     (server UUID) — NO `direct:<host>` alias is ever created.
          // IncomingGroupCallScreen sets `hostUserId` UNCONDITIONALLY on every
          // incoming call, so keying off `direct:<host>` alone made real-group
          // joiners wait on an empty slot → 25 s timeout → "Call failed".
          // Resolve under whichever slot actually holds a key (real id first,
          // then the ad-hoc alias). This does NOT relax the gate: if NEITHER
          // slot has a key, resolveKeyId() is undefined → hasKey() false → we
          // still fail closed below (no key ⇒ no media, never plaintext).
          const directLookupId = opts.hostUserId ? `direct:${opts.hostUserId}` : undefined;
          // B-124 root fix — 'Call' states live ONLY under their minted ids
          // now; a handle (`direct:<host>` / the origin id) resolves through
          // the callKeyRegistry. resolveKeyId still RETURNS the handle: the
          // keySource indirects on every read, so a re-escalation that
          // re-points the mapping mid-wait/mid-call rotates the cryptor onto
          // the fresh key exactly like the old alias-overwrite did.
          const slotHasKey = (id?: string): boolean =>
            !!id && !!resolveGroupForCall(useMessengerStore.getState().groups, id)?.masterKeyB64;
          const resolveKeyId = (): string | undefined => {
            const g = useMessengerStore.getState().groups;
            // B-10 (non-admin host of a REAL group): the host could NOT
            // resync the real master key (it isn't the group owner), so it
            // minted an ad-hoc 'Call' key reachable via `direct:<host>`.
            // This device still holds the REAL group key under
            // `conversationId`, but that key does NOT match what the host
            // encrypted with — keying off it gives 0 decrypted frames. When
            // the ring's host is NOT this group's admin/owner, prefer the
            // ad-hoc `direct:<host>` slot so host and receiver agree on the
            // SAME per-call key. Admin-hosted calls fall through to the real
            // id below (the proven path).
            const groupOwner = g[opts.conversationId]?.owner;
            const hostIsAdmin =
              !opts.hostUserId || !groupOwner || groupOwner === opts.hostUserId;
            // B-13 — the force-the-ad-hoc-slot rule applies ONLY to an
            // ad-hoc ('direct:*') escalated call. There, a non-owner host
            // MINTS a fresh 'Call' key reachable via `direct:<host>`, so
            // keying off the stale real key would give 0 frames (the B-10
            // mismatch). But a non-owner host of a REAL named group CANNOT
            // mint or broadcast over a group it doesn't own (B-10/B-15
            // owner-poison guard) — `ensureCallGroupKey` REUSES the real
            // group's master key under the real `conversationId`. So for a
            // real group the joiner must resolve that SAME real key it
            // already holds as a member; forcing the empty `direct:<host>`
            // slot is exactly what hung real-group joiners for 25 s ("Call
            // failed"). Scope this branch to ad-hoc ids so the two paths
            // stay consistent.
            const isAdHocCall = opts.conversationId.startsWith('direct:');
            if (!hostIsAdmin && isAdHocCall && directLookupId) {
              // Ad-hoc non-owner host: the ONLY correct slot is the ad-hoc
              // `direct:<host>` key. Do NOT fall back to a stale real-group
              // key, and return undefined until the ad-hoc key lands so the
              // joiner stays in the benign wait window.
              return slotHasKey(directLookupId) ? directLookupId : undefined;
            }
            if (slotHasKey(opts.conversationId)) {return opts.conversationId;}
            if (directLookupId && slotHasKey(directLookupId)) {return directLookupId;}
            return undefined;
          };
          // Display-only id for the wait log (prefers the ad-hoc slot it's
          // most likely in-flight to, falling back to the real convo).
          const keyLookupId = directLookupId ?? opts.conversationId;
          const hasKey = (): boolean => !!resolveKeyId();
          const rt = await getMessengerRuntime();
          if (joined.isHost && rt.ensureCallGroupKey) {
            // Host always calls ensureCallGroupKey — if a key already exists
            // it re-broadcasts it to all recipients so reinstalled/missed
            // devices (Techno self-minted K2, emulator never had a key) get
            // the correct key before they attempt FrameCryptor init.
            latG('key:ensure-start');
            const keyT0 = Date.now();
            try {
              const res = await rt.ensureCallGroupKey({
                conversationId:   opts.conversationId,
                recipientUserIds: opts.recipientUserIds,
              });
              keyConvoId = res.keyConversationId;
              console.log('[bravo.groupcall.boot] step=3a call key ensured/resynced keyConvo=', keyConvoId.slice(0, 12));
              latG('key:ensured', {ms: Date.now() - keyT0});
            } catch (e) {
              // SELF-HEAL HOST PATH — the HOST of a REAL group it does NOT own
              // (e.g. a CPO/client hosting a call in an agency-owned mission
              // Ops Room) fail-closes here with 'missing real-group master
              // key' because ensureCallGroupKey refuses to mint over a group
              // owned by another user. The OLD behaviour abandoned the call
              // instantly — before the self-heal key-request could be
              // answered. Mirror the joiner: actively ask the owner to
              // re-share, then WAIT (benign window) for the key to land, then
              // key the cryptor off the real conversation. Still fail-closed:
              // if the window elapses with no key we re-throw (no key ⇒ no
              // media, never plaintext).
              const msg = (e as Error)?.message ?? '';
              if (hasKey() || !/missing real-group master key/.test(msg)) {
                throw e;
              }
              console.log('[bravo.groupcall.boot] step=3a host lacks real-group key — requesting re-share + waiting (self-heal)...');
              if (rt.requestGroupKeyResync) {
                void rt.requestGroupKeyResync(opts.conversationId).catch(() => { /* best-effort */ });
              }
              const hostWait = await waitForGroupCallKey({
                hasKey,
                subscribe:   (cb) => useMessengerStore.subscribe(() => cb()),
                isCancelled: () => cancelled,
              });
              if (hostWait === 'cancelled' || cancelled) {return;}
              if (hostWait === 'timeout' || !hasKey()) {
                throw e; // genuinely no key after the window — fail closed
              }
              keyConvoId = resolveKeyId() ?? opts.conversationId;
              console.log('[bravo.groupcall.boot] step=3a host recovered real-group key via self-heal keyConvo=', keyConvoId.slice(0, 12));
            }
          } else if (!joined.isHost && !hasKey()) {
            // BS-CALL-KEY-WAIT: joiner has no key yet — the host sent it via
            // sealed fan-out in ensureCallGroupKey, but it may be in-flight.
            //
            // BS-CALL-KEY-RECOVER: the key envelope and the sfu.ring are
            // SEPARATE frames on SEPARATE paths (sealed relay envelope vs WS
            // ring). A cold-wake joiner on cellular, or one whose envelope is
            // queued behind a backlog, can have the key land 10-20 s after it
            // accepts — well past the old 8 s ceiling, which then hard-FAILED
            // the whole call ("Call failed") even though the key was moments
            // away. We now stay in the benign 'joining' state (UI: "Joining…")
            // and resolve the INSTANT the key lands, any time inside a 25 s
            // window. This does NOT relax the gate: if the window elapses with
            // no key we still throw and fail closed (no key ⇒ no media,
            // never plaintext — per ARCHITECTURE_AMENDMENT_SFRAME §"fails
            // closed"). It only stops abandoning a call whose key is in-flight.
            //
            // The wait also breaks out early on teardown (`cancelled`) so a
            // user who hits End mid-wait isn't held for the full window.
            // [KEYDIAG] warn — names the EXACT id hasKey() probes; if messaging
            // in the group works but this id has no key, the id mapping (not
            // distribution) is the bug.
            console.warn('[bravo.groupcall.boot] step=3b waiting for group master key under', keyLookupId.slice(0, 18), '(in-flight from host)...');
            latG('key:wait-start');
            const keyWaitT0 = Date.now();
            // Self-heal — don't just wait passively. A joiner that lost the
            // key (reinstall/logout) or missed the original fan-out actively
            // asks the owner to re-share it, so the key lands inside the wait
            // window instead of timing out into "Call failed". Fire-and-
            // forget + rate-limited; harmless when the host's resync already
            // covers it.
            //
            // B-340 — pass the ring's host as the fallback target. After a
            // B-337 purge this device holds NO conversation row for the group,
            // so the resync's participant lookup comes back empty and the
            // request silently no-ops (the Catch-22 branch in
            // requestGroupKeyResyncImpl needs SOME peer to aim at). The host
            // that just rang us provably holds the key or can relay it (G-05).
            if (rt.requestGroupKeyResync) {
              // B-358 — request under the id this wait's hasKey() PROBES, not
              // opts.conversationId verbatim. For an escalated (ad-hoc) call
              // the ring's conversationId is the HOST's local `direct:` slot
              // name — on this device it denotes ourselves, and on the host
              // (post-B-124) it holds no state either, so the request was
              // declined by the very device that minted the key. The
              // `direct:<host>` handle resolves on BOTH ends: locally it is
              // the slot resolveKeyId() checks; on the host it maps through
              // the callKeyRegistry to the minted state.
              const resyncId = opts.conversationId.startsWith('direct:') && directLookupId
                ? directLookupId
                : opts.conversationId;
              console.warn('[bravo.groupcall.boot] step=3b key resync requested for', resyncId.slice(0, 18), 'fallback host=', opts.hostUserId ? opts.hostUserId.slice(0, 8) : '(none)');
              void rt.requestGroupKeyResync(
                resyncId,
                opts.hostUserId ? {userId: opts.hostUserId, deviceId: 1} : undefined,
              ).catch(() => { /* best-effort */ });
            }
            const waitOutcome = await waitForGroupCallKey({
              hasKey,
              subscribe:   (cb) => useMessengerStore.subscribe(() => cb()),
              isCancelled: () => cancelled,
            });
            // Cancelled during the wait — bail without surfacing a failure
            // (the teardown path owns the state transition).
            if (waitOutcome === 'cancelled' || cancelled) {return;}
            // Fail closed: window elapsed with no key ⇒ no media, never
            // plaintext (ARCHITECTURE_AMENDMENT_SFRAME §"fails closed").
            if (waitOutcome === 'timeout' || !hasKey()) {
              throw new Error('FrameCryptorOrchestrator: no group master key — refusing to start');
            }
            console.warn('[bravo.groupcall.boot] step=3b group master key arrived');
            latG('key:arrived', {ms: Date.now() - keyWaitT0});
          }
          // B-237-CW — owner re-broadcasts the authoritative key even when
          // JOINING (not only hosting), so a behind-member heals whenever the
          // owner is in the call — closing the "non-owner-hosted call never
          // heals" gap. Best-effort + NON-awaited: the owner already holds its
          // own key; this only helps OTHERS converge and must never delay or
          // fail the local join. Uses the SAME owner-signed resync + accepting
          // gate the host path uses — no security guard is changed here.
          try {
            const st  = useMessengerStore.getState();
            const grp = st.groups[opts.conversationId];
            const ownUid = st._ownAuthUserId ?? st._ownUserId;
            const isRealNamedGroup =
              !isDirectPrefixed(opts.conversationId) && !isCallGroupState(grp);
            if (rt.ensureCallGroupKey && shouldOwnerResyncOnJoin({
              isHost:            joined.isHost,
              ownUserId:         ownUid,
              groupOwner:        grp?.owner,
              groupHasMasterKey: !!grp?.masterKeyB64,
              isRealNamedGroup,
            })) {
              void rt.ensureCallGroupKey({
                conversationId:   opts.conversationId,
                recipientUserIds: opts.recipientUserIds,
              })
                .then(() => console.log('[bravo.groupcall.boot] owner re-broadcast key on JOIN (heal)'))
                .catch(e => console.warn('[bravo.groupcall.boot] owner join-resync failed', (e as Error)?.message));
            }
          } catch { /* best-effort — must never block the local join */ }
          // Key the cryptor off the right slot for our role:
          //   • HOST: `keyConvoId` is the id ensureCallGroupKey actually
          //     keyed this call under — the real `conversationId` when we own
          //     the group (admin resync), or a fresh ad-hoc id when we don't
          //     (B-10: non-admin host). We MUST use it verbatim; resolveKeyId
          //     would pick the stale REAL group key for a non-admin-hosted
          //     real group and mismatch every receiver.
          //   • JOINER: resolveKeyId() picks the slot that matches the host
          //     (ad-hoc `direct:<host>` when the host isn't this group's
          //     admin, else the real convo id), falling back to keyConvoId.
          const keyConvoForCryptor = joined.isHost
            ? keyConvoId
            : (resolveKeyId() ?? keyConvoId);
          const enc = new FrameCryptorOrchestrator({
            conversationId: keyConvoForCryptor,
            selfTag:        joined.participantTag,
            keySource:      messengerStoreKeySource,
          });
          await enc.init();
          groupEncryptionRef.current = enc;
          // BS-GC-KEYDIAG — the old `epoch=current` log was useless for
          // diagnosing the TECNO-only "no remote A/V both directions"
          // (SFrame decrypt fails when this device's group master key
          // doesn't match the senders'). Log a SHA-256 FINGERPRINT of the
          // master key (one-way hash — never the key itself, per the
          // no-plaintext-key-material rule) + epoch + source convo, so a
          // capture from the broken device can be compared against a
          // working one: same fp+epoch ⇒ key is fine, cause is the native
          // cryptor/hardware; different fp/epoch ⇒ key desync (re-sync fix).
          try {
            const cur = resolveGroupForCall(useMessengerStore.getState().groups, keyConvoForCryptor);
            const mk = cur?.masterKeyB64 ?? '';
            let fp = 'none';
            if (mk) {
              const c = (globalThis as {crypto?: {subtle?: {digest?: (a: string, d: ArrayBuffer) => Promise<ArrayBuffer>}}}).crypto;
              if (c?.subtle?.digest) {
                const bytes = new TextEncoder().encode(mk);
                const dig = await c.subtle.digest('SHA-256', bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
                fp = Array.from(new Uint8Array(dig)).slice(0, 4).map(b => b.toString(16).padStart(2, '0')).join('');
              }
            }
            crashLog(`[bravo.groupcall.keydiag] FrameCryptor ready selfTag=${joined.participantTag.slice(0,8)} keyConvo=${keyConvoForCryptor.slice(0,12)} epoch=${cur?.epoch ?? '?'} masterKeyFp=${fp}`);
          } catch { /* diagnostic only — never block the call */ }
        } catch (e) {
          console.warn('[bravo.groupcall.boot] step=3b FrameCryptor init failed — refusing:', (e as Error).message);
          if (!cancelled) {setState('failed');}
          try {
            void wsRequest<{ok: boolean}>(ws, 'sfu.leave', {roomId: rid}).catch(() => undefined);
          } catch { /* ignore */ }
          releaseDeadBoot(); // B-642 — the dominant dead-boot exit; see the helper.
          return;
        }

        // Self entry into the identity registry so OUR tile shows our
        // own name immediately even though we never receive our own
        // presence envelope.
        recordGroupCallIdentity(rid, joined.participantTag, opts.ownDisplayName);

        // Subscribe to identity updates from peers' presence envelopes.
        cleanupIdentSub.current = onGroupCallIdentities(rid, snap => {
          if (cancelled) {return;}
          setIdentityByTag(snap);
          patchActiveGroupCall(rid, {identityByTag: snap});
          // B-344 — reciprocal presence. A member ADDED mid-call was in no
          // one's boot-time recipient list, so nobody's one-shot step-10
          // broadcast ever reached them: their tiles showed hex tags
          // ("encrypted names") forever. Their OWN announcement does reach
          // us (their roster-derived list includes us) — when it lands,
          // reply once with our identity, targeted at them. The sent-set
          // guard makes storms impossible: one reply per (boot, userId).
          const selfTagNow = participantTagRef.current;
          if (!selfTagNow) {return;} // pre-join snapshot — nothing to announce yet
          const st = useMessengerStore.getState();
          const ownUid = st._ownAuthUserId ?? st._ownUserId;
          const replyTo = selectPresenceReplyTargets(rid, snap, ownUid);
          if (replyTo.length === 0) {return;}
          markPresenceSent(rid, replyTo);
          void (async () => {
            try {
              const rtNow = await getMessengerRuntime();
              await rtNow.broadcastGroupCallPresence(replyTo, {
                roomId:         rid,
                participantTag: selfTagNow,
                displayName:    opts.ownDisplayName,
                callType:       opts.callType,
              });
              console.warn(`[CALLDIAG] [bravo.groupcall.presence] replied identity to ${replyTo.length} late joiner(s) (B-344)`);
            } catch (e) {
              console.warn('[bravo.groupcall.presence] late-joiner identity reply failed:', (e as Error).message);
            }
          })();
        });

        // 3c (B-342 — MOVED UP from step 11). Outgoing direction → ring
        // everyone in the group NOW, not after transports/produce/presence.
        // Measured 2026-07-30: the old position rang 10.8 s after sfu.join
        // (Device.load + 2 transports + DTLS + producing audio+video + an
        // AWAITED presence fan-out all ran first) — the founder's "it takes
        // time to ring the other members". The ring's real prerequisites are
        // already met here: the room exists and has a host (step 3, B-334
        // host-or-participant check passes) and the key fan-out ran (step
        // 3a — the key-before-ring contract, pinned by groupCallRingOrder).
        // A recipient who accepts before we produce sees existingProducers=0
        // and picks our tracks up via sfu.new-producer + the B-06 early
        // buffer — the standard path for any 3rd member already. If a later
        // boot step fails, the boot-failed path still sends the ring cancel,
        // same as before. sentRingRef guards against re-rings on remount.
        if (opts.direction === 'outgoing' && !sentRingRef.current && opts.recipientUserIds.length > 0) {
          // Fix #11: only flip sentRingRef on SUCCESS. The previous
          // version set it before the wsRequest, so if the ring failed
          // (transient WS hiccup, peer_offline, anything) sentRingRef
          // was permanently true and a future state-transition retry
          // would silently no-op. Recipients would never get rung and
          // the host would stare at a "Ringing…" screen with nothing
          // happening. Set inside the try, AFTER the ack returns.
          latG('ring:send', {n: opts.recipientUserIds.length});
          const ringT0 = Date.now();
          try {
            const ringAck = await wsRequest<{ok: true; ringId?: string}>(ws, 'sfu.ring', {
              roomId:           rid,
              conversationId:   opts.conversationId,
              callType:         opts.callType,
              callerName:       opts.callerName,
              recipientUserIds: opts.recipientUserIds,
            });
            if (ringAck?.ringId) {mintedRingIdsRef.current.add(ringAck.ringId);}
            for (const u of opts.recipientUserIds) {rungUsersRef.current.add(u);} // KO-7
            sentRingRef.current = true;
            latG('ring:ack', {ms: Date.now() - ringT0});
            // AC-6 — the ring-send is the host-side half of the receiver's
            // ring trail; release builds strip the log variant.
            console.warn('[CALLDIAG] [ring.send] boot ring ok room=', rid.slice(0, 8), 'recipients=', opts.recipientUserIds.length);
            // Ring window starts now — UI shows "Ringing" status for
            // every dialed user until either their participantTag
            // shows up in identityByTag (answered) OR the 30s window
            // elapses (no-answer). After 30s we DON'T auto-re-ring;
            // the host explicitly taps "Re-ring" if they want to try
            // again. That's surfaced in the hook's `ringStatus` map.
            setRingStartedAt(Date.now());
          } catch (e) {
            console.warn('[useGroupCall] ring failed (sentRingRef stays false for retry):', (e as Error).message);
          }
        }

        // 4. mediasoup-client Device.load
        // CRITICAL: must pass `handlerName: 'ReactNative106'` because
        // the auto-detect path inspects window.navigator.userAgent which
        // doesn't exist in RN — without this, `new Device()` throws
        // "device not supported" the moment we try to load the router
        // capabilities, surfacing as the "network error" group-call
        // blocker. The 106 suffix matches the WebRTC API level
        // react-native-webrtc 124.x exposes; mediasoup ships a single
        // RN handler against that surface.
        console.log('[useGroupCall] constructing mediasoup Device with handlerName=ReactNative106');
        const device = new Device({handlerName: 'ReactNative106'});
        latG('device:load-start');
        const devT0 = Date.now();
        await device.load({routerRtpCapabilities: joined.routerRtpCapabilities as never});
        console.log('[useGroupCall] Device loaded ok');
        latG('device:loaded', {ms: Date.now() - devT0});
        deviceRef.current = device;

        // Resolve TURN before opening transports.
        const turnAwaitT0 = Date.now();
        const turnServers = await turnPromise;
        latG('turn:awaited', {waitMs: Date.now() - turnAwaitT0, n: turnServers.length});

        // 5. Send transport.
        // Why NOT relay-only here (unlike the 1:1 path in
        // peerConnection.ts): in 1:1 BOTH peers are relay-only and meet
        // inside coturn — peer↔peer NAT traversal genuinely needs the
        // relay. The SFU is the opposite topology: client↔server, where
        // the server is a PUBLIC endpoint advertising its own
        // (announcedIp) ICE candidates — there is no NAT to traverse to
        // reach it. Forcing the client relay-only there makes media
        // hairpin phone→coturn→SFU→coturn→phone, and coturn refuses the
        // SFU hop whenever the SFU's announcedIp is RFC1918 (our SSRF
        // denylist, docker-compose.yml). The pair then completes DTLS
        // (transport reaches 'connected') but carries ZERO RTP, starves,
        // and dies on idle — observed on physical Android Wi-Fi while
        // emulators (sharing the host LAN) worked. 'all' lets the client
        // reach the SFU directly; TURN stays in iceServers as the
        // fallback for genuinely UDP-blocked networks.
        const sendTx = device.createSendTransport({
          ...(joined.sendTransport as Record<string, unknown>),
          iceServers:           turnServers,
          iceTransportPolicy:   'all',
          iceCandidatePoolSize: 0,
        } as never);
        sendTxRef.current = sendTx;
        sendTx.on('connect', ({dtlsParameters}, cb, errb) => {
          // Bail if we're tearing down — the WS may already be closed
          // and the request would hang forever (freeze on call-end).
          if (isLeavingRef.current) { errb(new Error('leaving')); return; }
          wsRequest<{ok: true}>(ws, 'sfu.transport.connect', {
            roomId: rid!, transportId: sendTx.id, dtlsParameters,
          }).then(() => cb()).catch(e => errb(e as Error));
        });
        sendTx.on('produce', ({kind, rtpParameters}, cb, errb) => {
          if (isLeavingRef.current) { errb(new Error('leaving')); return; }
          wsRequest<{producerId: string}>(ws, 'sfu.produce', {
            roomId: rid!, transportId: sendTx.id, kind, rtpParameters,
          }).then(({producerId}) => cb({id: producerId})).catch(e => errb(e as Error));
        });

        // 6. Recv transport — same 'all' rationale as the send transport
        // above (direct-to-SFU primary, TURN fallback). The recv path is
        // where the no-media symptom showed first: recvTx reached
        // 'connected' but never decoded a frame (8 mute / 0 unmute) under
        // the old relay-only policy.
        const recvTx = device.createRecvTransport({
          ...(joined.recvTransport as Record<string, unknown>),
          iceServers:           turnServers,
          iceTransportPolicy:   'all',
          iceCandidatePoolSize: 0,
        } as never);
        recvTxRef.current = recvTx;
        latG('transports:created');
        recvTx.on('connect', ({dtlsParameters}, cb, errb) => {
          if (isLeavingRef.current) { errb(new Error('leaving')); return; }
          wsRequest<{ok: true}>(ws, 'sfu.transport.connect', {
            roomId: rid!, transportId: recvTx.id, dtlsParameters,
          }).then(() => cb()).catch(e => errb(e as Error));
        });

        // 6b. Weak-network recovery — attach `connectionstatechange`
        // listeners to BOTH transports so a Wi-Fi ↔ cellular handover
        // (or any blip that flips ICE to 'disconnected') triggers a
        // server-side `transport.restartIce()` round-trip instead of
        // dropping the whole call. Recovery budget mirrors the 1:1
        // path's 30s ceiling.
        //
        // On 'disconnected':
        //   • flip group state to 'reconnecting' for the overlay,
        //   • POST `sfu.transport.restartIce` and apply the returned
        //     iceParameters via mediasoup-client's `restartIce()`,
        //   • the engine re-gathers candidates against the existing
        //     TURN allocation; DTLS context, producers, and consumers
        //     all survive (mediasoup spec).
        // On 'connected' (during reconnecting): clear the budget and
        // restore 'joined'.
        // On 'failed' / budget expiry: setState('failed') and leave.
        // Review round 2 — the shared constant, not a local copy.
        //
        // This literal carried a proof it did not advertise: `onBudgetExpiry`
        // terminates because GROUP_REBUILD_MARK_CEILING_MS <= this budget, so a
        // rebuild can defer the expiry by at most one window. With the number
        // inlined here, the WI-2.3 drift scan could not see it and the two
        // could silently diverge — at which point a stuck rebuild would defer
        // the budget forever and the call could never fail.
        let restartBudgetTimer: ReturnType<typeof setTimeout> | null = null;
        const sendRestartInFlight = {current: false};
        const recvRestartInFlight = {current: false};
        // B-101 LC-5 — WALL-CLOCK budget (ports the 1:1 P2-BR-6 fix).
        // A bare setTimeout is wrong here: RN freezes JS timers while the
        // screen is locked, so a call that entered 'reconnecting' before
        // the lock had its 30s timer flush-fire the instant the user
        // returned — reporting "Call failed" for a call whose ICE had
        // often already recovered. We now (a) re-arm for the REMAINING
        // real time when a timer fires early/late, and (b) re-probe the
        // live transports before failing, so recovery always wins.
        let restartBudgetDeadline = 0;
        const clearBudget = (): void => {
          if (restartBudgetTimer) { clearTimeout(restartBudgetTimer); restartBudgetTimer = null; }
          restartBudgetDeadline = 0;
        };
        const transportsHealthy = (): boolean => {
          const s = (sendTxRef.current as unknown as {connectionState?: string} | null)?.connectionState;
          const r = (recvTxRef.current as unknown as {connectionState?: string} | null)?.connectionState;
          return (s === 'connected' || s === 'completed') && (r === 'connected' || r === 'completed');
        };
        const onBudgetExpiry = (): void => {
          restartBudgetTimer = null;
          if (cancelled || isLeavingRef.current) {return;}
          // Fired before the real deadline (timer coalescing / clock skew)
          // — re-arm for what's actually left instead of failing early.
          const remaining = restartBudgetDeadline - Date.now();
          if (remaining > 250) {
            restartBudgetTimer = setTimeout(onBudgetExpiry, remaining);
            return;
          }
          // The budget elapsed, but transports may have recovered while
          // the timer was frozen (screen locked) — never fail a call
          // that is demonstrably healthy right now.
          if (transportsHealthy()) {
            console.log('[bravo.groupcall] budget elapsed but transports healthy — resuming');
            clearBudget();
            setState(prev => (prev === 'reconnecting' ? 'joined' : prev));
            return;
          }
          // WI-3.1 — do not fail a call a rejoin is ACTIVELY rebuilding: that
          // rebuild IS the recovery, and failing underneath it is group G6's
          // `failed`-over-`joined` stomp.
          //
          // Round 1 rewrote this. It first asked "has a newer attempt
          // superseded the boot?", which is permanently TRUE after the first
          // rejoin of the call's life — the boot's generation never moves
          // again. That silently retired B-108's stated contract that this
          // handler is "the only terminal authority": a call whose ICE died
          // later sat in 'reconnecting' forever, holding the audio session,
          // the foreground service and `launchCall`'s busy guard, with no way
          // out but a force-quit. Asking whether a rebuild is running RIGHT
          // NOW hands authority back the moment it finishes.
          if (isAttemptRunning(rid!)) {
            // Grant a fresh window rather than returning with a live deadline
            // the foreground probe would re-arm forever.
            startBudget();
            return;
          }
          console.warn('[bravo.groupcall] reconnect budget exhausted — failing');
          setState('failed');
        };
        const startBudget = (): void => {
          clearBudget();
          restartBudgetDeadline = Date.now() + RECONNECT_BUDGET_MS;
          restartBudgetTimer = setTimeout(onBudgetExpiry, RECONNECT_BUDGET_MS);
        };
        // Foreground re-probe: on return from background the frozen time
        // must not count against the user. If ICE recovered, promote to
        // 'joined'; if still reconnecting, grant a fresh full window.
        budgetForegroundProbeRef.current = (): void => {
          if (cancelled || isLeavingRef.current) {return;}
          if (stateRef.current !== 'reconnecting') {return;}
          if (transportsHealthy()) {
            clearBudget();
            setState('joined');
            return;
          }
          if (restartBudgetDeadline > 0) {startBudget();}
        };
        // B-14 — the SFU WebSocket idle-closes ~5s BEFORE ICE flips to
        // 'disconnected' (logs: `sfu.producers failed: transport not open`
        // precedes the ICE event). The OLD restart fired
        // `sfu.transport.restartIce` immediately — over the already-dead
        // socket — so it `ack_timeout`'d and the call stuck in 'failed'
        // forever with no recovery. socket.io auto-reconnects in the
        // background; we just have to WAIT for the WS to be open again
        // before sending the restart, and RETRY across the recovery budget
        // rather than one-shotting it.
        const wsIsOpen = (): boolean =>
          (ws as unknown as {state?: string}).state === 'connected';
        const waitForWsOpen = async (deadlineMs: number): Promise<boolean> => {
          while (Date.now() < deadlineMs) {
            if (cancelled || isLeavingRef.current) {return false;}
            if (wsIsOpen()) {return true;}
            await new Promise(r => setTimeout(r, 250));
          }
          return wsIsOpen();
        };
        const restartTransport = async (
          tx:        typeof sendTx,
          kind:      'send' | 'recv',
          inFlight:  {current: boolean},
        ): Promise<void> => {
          if (inFlight.current) {return;}
          if (cancelled || isLeavingRef.current) {return;}
          // B-05 — never restartIce over a known-dead WS. When the server's
          // P0-6 sweep dropped the socket, the restartIce wsRequest would
          // ack_timeout and the call would end in 'failed'. The reconnect →
          // rejoin path handles recovery once the socket reopens; here we
          // simply bail so we don't burn the reconnect budget on a doomed
          // round-trip.
          if (transportRef.current?.state !== 'connected') {
            console.log(`[bravo.groupcall] ${kind}Tx ice-restart skipped — WS not connected (state=${transportRef.current?.state ?? 'none'}); awaiting reconnect→rejoin`);
            return;
          }
          inFlight.current = true;
          // Retry within the same recovery budget. Each attempt first waits
          // for the WS to come back (so the restart command can actually be
          // delivered), then issues restartIce. We stop early once the
          // transport reports connected/completed again, on teardown, or
          // when the budget window elapses (the budget timer flips state to
          // 'failed' independently).
          const deadline = Date.now() + RECONNECT_BUDGET_MS;
          try {
            let attempt = 0;
            while (!cancelled && !isLeavingRef.current && Date.now() < deadline) {
              const txConn = (tx as unknown as {connectionState?: string}).connectionState;
              if (txConn === 'connected' || txConn === 'completed') {return;}
              attempt += 1;
              // Wait for the WS to reconnect before attempting the restart.
              const open = await waitForWsOpen(deadline);
              if (cancelled || isLeavingRef.current) {return;}
              if (!open) {
                console.warn(`[bravo.groupcall] ${kind}Tx ice-restart skipped attempt=${attempt} — WS still down`);
                continue;
              }
              try {
                console.log(`[bravo.groupcall] ${kind}Tx ice-restart begin attempt=${attempt}`);
                const resp = await wsRequest<{iceParameters: unknown}>(
                  ws,
                  'sfu.transport.restartIce',
                  {roomId: rid!, transportId: tx.id},
                );
                if (cancelled || isLeavingRef.current) {return;}
                await (tx as unknown as {restartIce: (p: {iceParameters: unknown}) => Promise<void>})
                  .restartIce({iceParameters: resp.iceParameters});
                console.log(`[bravo.groupcall] ${kind}Tx ice-restart applied attempt=${attempt}`);
                return;
              } catch (e) {
                console.warn(`[bravo.groupcall] ${kind}Tx ice-restart failed attempt=${attempt}: ${(e as Error).message}`);
                // Back off briefly, then re-evaluate WS + budget and retry.
                await new Promise(r => setTimeout(r, 1_000));
              }
            }
          } finally {
            inFlight.current = false;
          }
        };
        // BS-GC-ICE — dump the SELECTED ICE candidate pair when a transport
        // connects. This is the missing piece for "DTLS connected but 0 RTP"
        // field reports: it tells us whether media is going direct (host/
        // srflx to the SFU's announcedIp) or relayed (TURN), over UDP or
        // TCP — and which local/remote candidate types won. A pair that
        // selects e.g. relay/udp but still carries no media points at the
        // relay path; a host/udp pair that dies points at the device's
        // network dropping UDP to 40000-40100. Best-effort + Crashlytics so
        // it survives release builds where console.* isn't in logcat.
        const dumpSelectedPair = async (tx: typeof sendTx, kind: 'send' | 'recv'): Promise<void> => {
          try {
            // `RTCStatsReport` isn't in this project's lib types (RN), so
            // type the report by the only method we use — forEach — rather
            // than naming the global (which would add a tsc-baseline error).
            const report = await (tx as unknown as {
              getStats: () => Promise<{forEach: (cb: (s: Record<string, unknown>) => void) => void}>;
            }).getStats();
            const byId = new Map<string, Record<string, unknown>>();
            let pair: Record<string, unknown> | null = null;
            report.forEach((s: Record<string, unknown>) => {
              if (typeof s.id === 'string') {byId.set(s.id, s);}
              const t = s.type as string | undefined;
              if ((t === 'candidate-pair') && (s.selected === true || s.nominated === true || s.state === 'succeeded')) {
                // Prefer a nominated/selected pair; keep the last succeeded as fallback.
                if (!pair || s.selected === true || s.nominated === true) {pair = s;}
              }
            });
            if (!pair) { crashLog(`[bravo.groupcall.ice] ${kind}Tx connected but NO selected candidate-pair in stats`); return; }
            const p = pair as Record<string, unknown>;
            const loc = (typeof p.localCandidateId === 'string' ? byId.get(p.localCandidateId) : undefined) ?? {};
            const rem = (typeof p.remoteCandidateId === 'string' ? byId.get(p.remoteCandidateId) : undefined) ?? {};
            crashLog(
              `[bravo.groupcall.ice] ${kind}Tx pair` +
              ` local=${(loc.candidateType as string) ?? '?'}/${(loc.protocol as string) ?? '?'}` +
              ` remote=${(rem.candidateType as string) ?? '?'}/${(rem.protocol as string) ?? '?'}` +
              ` bytesSent=${(p.bytesSent as number) ?? 0} bytesRecv=${(p.bytesReceived as number) ?? 0}`,
            );
          } catch (e) {
            crashLog(`[bravo.groupcall.ice] ${kind}Tx getStats failed: ${(e as Error).message.slice(0, 50)}`);
          }
        };

        const onTxState = (kind: 'send' | 'recv', txState: string, source: unknown): void => {
          console.log(`[bravo.groupcall] ${kind}Tx connectionState=${txState}`);
          if (cancelled || isLeavingRef.current) {return;}
          // B-483 — a SUPERSEDED rejoin's transports keep emitting. This
          // handler reads the live refs for its ACTIONS (correct), but its
          // DECISIONS were driven by whichever transport fired: a dying loser
          // reporting 'failed' knocked a healthy call into 'reconnecting',
          // started the reconnect budget and fired a restartIce on the
          // WINNER's transport. `source` is required so a missed registration
          // is a compile error rather than a silently unguarded one.
          {
            const owner = kind === 'send'
              ? (sendTxRef.current ?? sendTx)
              : (recvTxRef.current ?? recvTx);
            if (source && owner && source !== owner) {
              logCallSmQuiet('groupcall.tx-state.superseded', {kind, state: txState});
              return;
            }
          }
          // BS-GC-ICE-REFS — read the LIVE transports from the refs, not the
          // boot-time `sendTx`/`recvTx` consts. After a rejoinRoom (WS
          // reconnect) those consts are CLOSED and replaced by reSendTx/
          // reRecvTx; using them would restartIce a dead transport id (fails
          // until the budget flips to 'failed') and bothHealthy would read
          // the closed transports and never flip back to 'joined' (zombie
          // call). Fall back to the const before the refs are first set.
          const liveSend = sendTxRef.current ?? sendTx;
          const liveRecv = recvTxRef.current ?? recvTx;
          // BS-GC-ICE — on connect, snapshot the selected pair, and ~5s
          // later snapshot again so the byteSent/Recv delta reveals whether
          // RTP is actually flowing on the chosen pair (0 delta = the
          // "connected but no media" failure, now with the pair identified).
          if (txState === 'connected' || txState === 'completed') {
            const txRef = kind === 'send' ? liveSend : liveRecv;
            void dumpSelectedPair(txRef, kind);
            setTimeout(() => {
              // WI-3.7 — room-scoped. This fires 5 s later and reads the LIVE
              // transport refs, which a rejoin (or a successor call in another
              // room) may by then have re-pointed; the snapshot would be
              // attributed to the wrong room in the ICE diagnostics that exist
              // to tell those cases apart.
              if (cancelled || isLeavingRef.current) {return;}
              if (roomIdRef.current !== rid) {return;}
              void dumpSelectedPair(kind === 'send' ? (sendTxRef.current ?? liveSend) : (recvTxRef.current ?? liveRecv), kind);
            }, 5000);
          }
          if (txState === 'disconnected') {
            setState(prev => (prev === 'joined' ? 'reconnecting' : prev));
            startBudget();
            if (kind === 'send') {
              if (liveSend) { void restartTransport(liveSend, 'send', sendRestartInFlight); }
            } else {
              if (liveRecv) { void restartTransport(liveRecv, 'recv', recvRestartInFlight); }
            }
          } else if (txState === 'connected' || txState === 'completed') {
            // Only flip back if BOTH transports are healthy and we
            // were in 'reconnecting'.
            const sendState = (liveSend as unknown as {connectionState?: string})?.connectionState;
            const recvState = (liveRecv as unknown as {connectionState?: string})?.connectionState;
            const bothHealthy =
              (sendState === 'connected' || sendState === 'completed') &&
              (recvState === 'connected' || recvState === 'completed');
            if (bothHealthy) {
              clearBudget();
              setState(prev => (prev === 'reconnecting' ? 'joined' : prev));
            }
          } else if (txState === 'failed') {
            // B-108 — a mid-call transport 'failed' is NOT terminal:
            // restartIce re-gathers with a fresh ufrag and IS the recovery
            // mechanism (a network switch fails every pair before the
            // restart lands). Stay in the reconnect machinery and let
            // onBudgetExpiry (which health-probes first) remain the only
            // terminal authority. The budget is armed only when absent so
            // repeat 'failed' events cannot extend it forever, and a call
            // that never JOINED keeps the old fail-fast (initial-join
            // failure must not fake-reconnect for 30 s).
            const wasLive = stateRef.current === 'joined' || stateRef.current === 'reconnecting';
            if (wasLive) {
              setState(prev => (prev === 'joined' ? 'reconnecting' : prev));
              if (restartBudgetDeadline === 0) {startBudget();}
              if (kind === 'send') {
                if (liveSend) { void restartTransport(liveSend, 'send', sendRestartInFlight); }
              } else if (liveRecv) {
                void restartTransport(liveRecv, 'recv', recvRestartInFlight);
              }
            } else {
              clearBudget();
              if (!cancelled) {setState('failed');}
            }
          }
        };
        // mediasoup-client emits 'connectionstatechange' with a state
        // string; we use a permissive cast since the on() typing is
        // overloaded and varies by mediasoup-client version.
        (sendTx as unknown as {on: (e: string, cb: (s: string) => void) => void})
          .on('connectionstatechange', (s) => onTxState('send', s, sendTx));
        (recvTx as unknown as {on: (e: string, cb: (s: string) => void) => void})
          .on('connectionstatechange', (s) => onTxState('recv', s, recvTx));

        // 7. (moved up) The per-room SFU frame handler is now registered
        // right after step 1, BEFORE sfu.join — see the
        // `registerSfuHandler(rid, …)` block above. Producer frames that
        // arrive in the join→recvTx window are buffered there and drained
        // below (B-06).

        // 8. Produce our local tracks.
        // Audio: pin to mono Opus @ 32 kbps with in-band FEC + DTX.
        // Without these knobs mediasoup negotiates Opus stereo @ 32–64
        // kbps with NO FEC — every lost packet then triggers a NACK
        // round-trip, the receiver's NetEq jitter buffer grows to
        // compensate, and the call gains 300+ ms of audible delay.
        // mediasoup-client maps these to the SDP fmtp on the producer;
        // the SFU's router codec config (sfuWorkerPool.ts) advertises
        // the same parameters so both sides agree.
        console.log('[bravo.groupcall.boot] step=8 producing local tracks');
        latG('produce:start');
        const prodT0 = Date.now();
        const enc = groupEncryptionRef.current;
        if (!enc) {throw new Error('SFrame encryption ref missing at produce time');}
        if (audioTrack) {
          // GC-06 — track blanked until the sender cryptor is attached.
          const p = await withTrackBlanked(audioTrack, async () => {
            const prod = await sendTx.produce({
              track: audioTrack as never,
              codecOptions: {
                opusStereo:            false,
                opusFec:               true,
                opusDtx:               true,
                opusMaxAverageBitrate: 32_000,
                opusPtime:             10,
              },
            } as never);
            producersRef.current.push(prod);
            clearBlankedPauseLatch(prod);
            // Attach SFrame encrypt transform to the underlying
            // RTPSender. mediasoup-client exposes it via .rtpSender on
            // its handler-specific Producer. If the platform doesn't
            // expose createEncodedStreams we throw — caller catches and
            // tears down the call (no plaintext send fallback).
            const rtpSender = (prod as unknown as {rtpSender?: {id: string}}).rtpSender;
            if (rtpSender) {
              try {
                const detach = await enc.attachSenderCryptor(
                  rtpSender,
                  (sendTx as unknown as {handler?: {_pc?: unknown}}).handler?._pc,
                  'audio',
                );
                sframeDetachersRef.current.push(detach);
                console.log('[bravo.groupcall.sframe] audio producer attached (FrameCryptor)');
              } catch (e) {
                console.warn('[bravo.groupcall.sframe] audio attach FAILED — refusing:', (e as Error).message);
                throw e;
              }
            }
            return prod;
          });
          console.log(`[bravo.groupcall.quality] audio producer up (mono, fec, dtx) id=${p.id.slice(0,8)}`);
          latG('produce:audio-ok', {ms: Date.now() - prodT0});
        }
        // Video: use 3-layer simulcast so the SFU can drop to lower
        // layers per-receiver when bandwidth tanks. Each receiver gets
        // the highest layer their downlink can sustain — a slow
        // viewer sees 180p@15fps while a fast viewer sees 720p@30fps,
        // all from the same producer. Without simulcast, bad-link
        // viewers freeze the entire call. Tagged [bravo.groupcall.quality].
        // Re-read the CURRENT camera track from the ref: the user may have
        // toggled video OFF (track stopped → readyState 'ended') or ON (a
        // fresh local-preview track) DURING the connect/ring window.
        // Producing the STALE boot-time `videoTrack` after a toggle-off
        // throws "track ended" and FAILS THE ENTIRE CALL (the "call fails
        // when I toggle while ringing" bug). If video is off / the track
        // ended, skip video and start AUDIO-ONLY — the user can turn the
        // camera on later via toggleVideo (the no-producer ON path produces
        // it then). If video is on, produce whatever track is live now
        // (incl. a fresh one acquired by a toggle-ON local-preview).
        const liveVideoTrack = videoTrackRef.current;
        const liveVideoEnded = !liveVideoTrack
          || (liveVideoTrack as unknown as {readyState?: string}).readyState === 'ended';
        if (liveVideoTrack && !isVideoOffRef.current && !liveVideoEnded) {
          // GC-06 — track blanked until the sender cryptor is attached.
          const p = await withTrackBlanked(liveVideoTrack, async () => {
            const prod = await sendTx.produce({
              track: liveVideoTrack as never,
              encodings: videoEncodings(),
              // Attach SFrame encrypt transform AFTER produce returns.
              // See block below for the rationale + refusal contract.
              codecOptions: {
                // 200 (was 600): start low so TWCC measures the real
                // uplink capacity before we flood the modem queue with
                // 600 kbps of video. Same head-of-line-blocking fix
                // applied on the SFU side (initialBitrate 300k).
                videoGoogleStartBitrate: 200,
              },
            } as never);
            producersRef.current.push(prod);
            clearBlankedPauseLatch(prod);
            const rtpSender = (prod as unknown as {rtpSender?: {id: string}}).rtpSender;
            if (rtpSender) {
              try {
                const detach = await enc.attachSenderCryptor(
                  rtpSender,
                  (sendTx as unknown as {handler?: {_pc?: unknown}}).handler?._pc,
                  'video',
                );
                sframeDetachersRef.current.push(detach);
                console.log('[bravo.groupcall.sframe] video producer attached (FrameCryptor)');
              } catch (e) {
                console.warn('[bravo.groupcall.sframe] video attach FAILED — refusing:', (e as Error).message);
                throw e;
              }
            }
            return prod;
          });
          console.log(`[bravo.groupcall.quality] video producer up — ${VIDEO_ENCODINGS.length === 1 ? 'single encoding (iOS, B-121)' : '3-layer simulcast'} id=${p.id.slice(0,8)}`);
          latG('produce:video-ok', {ms: Date.now() - prodT0});
        }

        // 9. Consume everyone already in the room.
        // B-13 — batch the initial burst: collect tiles, flush once after
        // the loop so the layout computes at the FINAL count (not 1).
        console.log(`[bravo.groupcall.boot] step=9 consuming ${joined.existingProducers.length} existing producer(s)`);
        latG('consume:start', {n: joined.existingProducers.length});
        try {
          // Audit Step 3b.1 (B-599) — consume the existing producers in PARALLEL,
          // not one-await-at-a-time. For N peers the serial loop cost 2N sequential
          // WS acks (consume + resume each); concurrently, mediasoup-client's
          // awaitQueue coalesces the recv.consume SDP work into one handler.receive
          // and the recv transport's '@connect' (sfu.transport.connect) is awaited
          // once (shared connect promise), so the acks overlap. Safe under the
          // existing dedup: consumeProducer skips an in-flight/consumed producerId
          // (inFlightConsumes + consumedProducerIdsRef) — the same guards that
          // already cover the join-iteration vs sfu.new-producer race. Audio is
          // kicked BEFORE video (m-line 0 first, and audio is what "can talk"
          // depends on) — the map order is the transceiver-add order in the queue.
          const ordered = [...joined.existingProducers].sort(
            (a, b) => (a.kind === 'audio' ? 0 : 1) - (b.kind === 'audio' ? 0 : 1),
          );
          for (const ep of ordered) {
            console.log(`[bravo.groupcall.boot] step=9 consume tag=${ep.participantTag.slice(0,8)} kind=${ep.kind}`);
          }
          await Promise.all(ordered.map(ep =>
            consumeProducer(ep.producerId, ep.participantTag, ep.kind, /* batch */ true),
          ));
          latG('consume:done');
        } finally {
          if (pendingTileBatch.length > 0 && !cancelled && !isLeavingRef.current) {
            const batch = pendingTileBatch.splice(0, pendingTileBatch.length);
            setRemoteTiles(prev => {
              // Dedup by consumerId in case a live new-producer frame already
              // added one of these mid-burst (the per-tile path can run for a
              // producer announced while we were still consuming).
              const have = new Set(prev.map(t => t.consumerId));
              const next = prev.concat(batch.filter(t => !have.has(t.consumerId)));
              patchActiveGroupCall(rid, {remoteTiles: next});
              return next;
            });
          }
        }

        // 9b. B-06 — recv pipeline (recvTx + consumeProducer + group key)
        // is now live, so drain any new-producer frames that arrived in the
        // join→recvTx window. Each forwards through consumeProducer, which
        // dedups against the producers we just consumed in step 9
        // (consumedProducerIds + inFlightConsumes) so there's no double
        // consume. From here `accept` consumes inline (isReady() true).
        if (earlyProducerBuffer.size() > 0) {
          console.log(`[bravo.groupcall.boot] step=9b draining ${earlyProducerBuffer.size()} early producer(s)`);
        }
        earlyProducerBuffer.drain();

        // 10. Identity broadcast — tell every other group member that
        // our SFU tag belongs to our display name. The SFU never sees
        // this; it travels through the existing E2E pairwise Signal
        // sessions. Best-effort: per-recipient failures are logged.
        // Audit Step 3a.2 — the presence broadcast (a per-recipient pairwise
        // Signal fan-out, HTTP on a session/identity cache miss) used to be
        // AWAITED before setState('joined'), delaying "in the room" for work
        // NOTHING downstream depends on (it only labels the caller's SFU tag on
        // the others' rosters). Fire-and-forget with its existing failure warn.
        {
          const presT0 = Date.now();
          latG('presence:start', {n: opts.recipientUserIds.length});
          void (async () => {
            try {
              const rt = await getMessengerRuntime();
              await rt.broadcastGroupCallPresence(opts.recipientUserIds, {
                roomId:         rid,
                participantTag: joined.participantTag,
                displayName:    opts.ownDisplayName,
                callType:       opts.callType,
              });
              latG('presence:done', {ms: Date.now() - presT0});
            } catch (e) {
              console.warn('[useGroupCall] presence broadcast failed:', (e as Error).message);
            }
          })();
        }

        // BS-MEDIA — `consumedProducerIdsRef.current` holds the producerIds
        // we've SUCCESSFULLY consumed (a tile is live for them). It drives
        // the reconcile diff so we don't re-consume what we already have,
        // and lets a permanent-failure producer fall through to the next
        // reconcile tick rather than being dropped forever. We read the ref
        // DIRECTLY at each use site below — NOT via a `const` captured here.
        // BS-GC-CRASH: a captured `const` declared at this point lived
        // AFTER step 9's existing-producer consume loop in source order, so
        // on a JOINER (host already producing) consumeProducer ran during
        // step 9 and touched the const inside its temporal dead zone →
        // "Cannot read property 'has' of undefined" / TDZ throw on the very
        // first consume. The host never hit it (empty existingProducers).
        // Reading the always-initialised ref directly removes the ordering
        // hazard entirely. Cleared per-producer on tile teardown.

        // BS-MEDIA — bounded retry around a single consume. Transient
        // failures (weak-link sfu.consume ack timeout, a recv.consume that
        // loses a race with ICE settling, an SFrame attach that throws
        // before the key epoch lands) used to drop the tile permanently:
        // the catch only logged, and no fresh sfu.new-producer frame ever
        // re-fires for an already-announced producer. We retry a few times
        // with backoff; anything still failing is left UN-consumed so the
        // reconcile tick retries it later.
        // `batch` is true ONLY for the step=9 existing-producer burst at boot
        // (B-13): those tiles are collected and flushed in one setRemoteTiles
        // after the loop. Every other caller — the live sfu.new-producer path
        // (a peer switching audio→video mid-call) and the reconcile tick —
        // MUST pass batch=false so the tile renders immediately. A shared
        // closure flag previously leaked the batch mode into the live path and
        // swallowed mid-call video tiles into a buffer that only drained once
        // at boot (the "switch to video doesn't show" regression).
        async function consumeProducer(producerId: string, participantTag: string, kind: 'audio' | 'video', batch = false, attemptGen?: number): Promise<void> {
          // WI-3.2 — stand down while a REJOIN owned by someone else is
          // rebuilding the room. `attemptGen` is how the rejoin consumes its
          // OWN existingProducers through this same funnel; without that
          // distinction the rejoin would refuse its own work and rebuild a
          // room containing no remote tiles at all.
          const running = runningAttemptGen(rid ?? '');
          if (running !== null && running !== attemptGen) {
            // Park rather than drop — this producer has already been announced
            // and no fresh sfu.new-producer frame will ever re-fire for it.
            // The rejoin drains the buffer once it has finished.
            const buf = earlyProducerBufferRef.current;
            if (buf) {buf.accept({producerId, participantTag, kind});}
            // No buffer (the restore/adopt path never builds one) — the 4 s
            // reconcile tick is the designed backstop for exactly this.
            return;
          }
          // Fix #12: dedup concurrent consume attempts for the same
          // producerId. Two paths can race here: existingProducers
          // iteration on join + an sfu.new-producer frame for the same
          // producerId arriving in the gap. Mediasoup's recv.consume
          // would throw "consumer already exists" on the second call;
          // worse, the sfu.consume server side increments per-room
          // counters that get stuck.
          // Review round 2 — CAPTURE the set, don't re-read it in the finally.
          //
          // A rejoin replaces this ref with a fresh Set, so a consume that
          // started before the rebuild would otherwise delete its producerId
          // out of the WINNER's set on the way out — switching the Fix-#12
          // in-flight dedup off for that producer and letting a second
          // concurrent `recv.consume` through ("consumer already exists").
          const inFlightSet = inFlightConsumes.current;
          if (inFlightSet.has(producerId)) {
            console.log(`[useGroupCall] consume skipped (in flight) producerId=${producerId.slice(0,8)}`);
            return;
          }
          if (consumedProducerIdsRef.current.has(producerId)) {return;}
          inFlightSet.add(producerId);
          const MAX_ATTEMPTS = 3;
          try {
            for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
              if (cancelled || isLeavingRef.current) {return;}
              const consumerId = await attemptConsume(producerId, participantTag, kind, batch);
              if (consumerId) {
                // B-482 — claim "consumed" only if the consumer that proves it
                // is still in the map. A rebuild that landed mid-consume closed
                // the transport this was built on and cleared the map; marking
                // the producer then strands it behind both dedup guards
                // forever. The rebuild re-consumes its own existingProducers,
                // and the reconcile tick is the backstop either way.
                if (consumersByPid.current.has(consumerId)) {
                  consumedProducerIdsRef.current.add(producerId);
                } else {
                  console.warn(`[useGroupCall] consume landed on a superseded transport producerId=${producerId.slice(0, 8)} — not marking consumed`);
                  // `attemptConsume` registers the tile BEFORE returning, so
                  // leaving it behind gives this participant a permanently
                  // blank cell alongside the live one the rebuild creates —
                  // the B-17 "extra blank tile" symptom, which neither
                  // reconcile removes (both key on producerId, and the prune
                  // only drops producers ABSENT from the snapshot; this one is
                  // present). We know the consumer is dead, so drop its tile.
                  setRemoteTiles(prev => {
                    const next = prev.filter(t => t.consumerId !== consumerId);
                    if (next.length === prev.length) {return prev;}
                    patchActiveGroupCall(rid, {remoteTiles: next});
                    return next;
                  });
                }
                return;
              }
              if (attempt < MAX_ATTEMPTS) {
                // Backoff 300ms, 600ms — short enough to recover before
                // the user notices a missing tile, long enough to let a
                // transient ICE/key blip clear.
                const delay = 300 * attempt;
                console.warn(`[useGroupCall] consume retry ${attempt}/${MAX_ATTEMPTS - 1} in ${delay}ms producerId=${producerId.slice(0,8)}`);
                await new Promise<void>(r => setTimeout(r, delay));
              } else {
                console.warn(`[useGroupCall] consume gave up after ${MAX_ATTEMPTS} attempts producerId=${producerId.slice(0,8)} — reconcile will retry`);
              }
            }
          } finally {
            inFlightSet.delete(producerId);
          }
        }

        // Returns true on success, false on a (retryable) failure. Never
        // throws — the SFrame refuse-on-failure path closes its own
        // consumer and returns false so the retry loop can try again.
        /**
         * Returns the CONSUMER ID on success, null on a retryable failure.
         *
         * B-482 — it used to return a bare boolean, and the caller wrote
         * `consumedProducerIds` on that. But a rebuild can land while this is
         * in flight: `recv.consume` resolves against the OLD transport, the
         * rebuild closes it and clears `consumersByPid`, and the write still
         * happened — leaving the producer marked consumed with no live consumer
         * behind it, skipped forever by both dedup guards. The discriminator is
         * LIVENESS, not timing, and the consumer id is what lets the caller
         * ask.
         */
        async function attemptConsume(producerId: string, participantTag: string, _kind: 'audio' | 'video', batch = false): Promise<string | null> {
          // Function declaration breaks TS's narrowing on the captured
          // `ws`, so re-assert via the ref (which we set right after the
          // initial null check above).
          const wsLive = transportRef.current;
          if (!wsLive || !deviceRef.current || !recvTxRef.current) {
            return null;
          }
          // Fix #9: also bail if the hook is mid-leave — a late frame
          // could try to spin up a fresh consumer against a closed
          // recvTx and crash the bridge.
          if (isLeavingRef.current) {
            return null;
          }
          const dev = deviceRef.current;
          const recv = recvTxRef.current;
          // BS-MEDIA — track the consumer + whether the tile was fully
          // registered so a mid-way failure (e.g. sfu.consumer.resume
          // throws after recv.consume succeeded) can close the orphan
          // before the retry mints a fresh one. Without this, each retry
          // would leak a half-built consumer into consumersByPid.
          let consumer: Consumer | null = null;
          let tileRegistered = false;
          const consumeT0 = Date.now();
          try {
            const consumed = await wsRequest<{
              consumerId: string; producerId: string; kind: 'audio' | 'video';
              rtpParameters: unknown; participantTag: string;
              producerPaused?: boolean;
            }>(wsLive, 'sfu.consume', {
              roomId: rid!, transportId: recv.id, producerId,
              rtpCapabilities: dev.rtpCapabilities,
            });
            latG('consume:ack', {ms: Date.now() - consumeT0, kind: consumed.kind, tag: participantTag.slice(0, 8), batch});

            // Re-check leaving — getStats / consume are slow on weak
            // links and the user can hit End between request and ack.
            if (isLeavingRef.current) { return null; }

            consumer = await recv.consume({
              id:            consumed.consumerId,
              producerId:    consumed.producerId,
              kind:          consumed.kind,
              rtpParameters: consumed.rtpParameters as never,
            });
            // Non-null alias so the downstream body keeps reading cleanly
            // (the outer `consumer` stays mutable for the catch's cleanup).
            const c = consumer;
            consumersByPid.current.set(c.id, c);
            latG('consume:sdp', {ms: Date.now() - consumeT0, kind: consumed.kind, tag: participantTag.slice(0, 8), batch});

            // S6 / P0-C1 — attach SFrame decrypt transform to the
            // remote RTPReceiver. Refusal-on-failure: if the platform
            // doesn't expose the encoded-frame API we tear down the
            // consumer rather than render plaintext (the SFU is the
            // attacker in our threat model — it MUST NOT see media).
            const encRecv = groupEncryptionRef.current;
            const rtpReceiver = (c as unknown as {rtpReceiver?: {id: string}}).rtpReceiver;
            if (encRecv && rtpReceiver) {
              try {
                const detach = await encRecv.attachReceiverCryptor(
                  rtpReceiver,
                  (recv as unknown as {handler?: {_pc?: unknown}}).handler?._pc,
                  participantTag,
                );
                sframeDetachersRef.current.push(detach);
                console.log(`[bravo.groupcall.sframe] consumer attached (FrameCryptor) tag=${participantTag.slice(0,8)} kind=${consumed.kind}`);
                latG('consume:cryptor', {ms: Date.now() - consumeT0, kind: consumed.kind, tag: participantTag.slice(0, 8), batch});
              } catch (e) {
                console.warn('[bravo.groupcall.sframe] consumer attach FAILED — closing consumer:', (e as Error).message);
                try {c.close();} catch { /* ignore */ }
                consumersByPid.current.delete(c.id);
                consumer = null; // already closed — don't double-close in catch
                throw e;
              }
            }

            // Latency: cap NetEq jitter-buffer target at 150 ms on
            // audio receivers. Default adaptive target grows to 300+ ms
            // on weak networks → audible echo. Best-effort: not all
            // RN-WebRTC builds expose playoutDelayHint, so the try
            // simply ignores unsupported runtimes.
            if (consumed.kind === 'audio') {
              try {
                const receiver = (c as unknown as {rtpReceiver?: {playoutDelayHint?: number}}).rtpReceiver;
                if (receiver) { receiver.playoutDelayHint = 0.15; }
              } catch { /* ignore */ }
            }

            await wsRequest<{ok: true}>(wsLive, 'sfu.consumer.resume', {
              roomId: rid!, consumerId: c.id,
            });
            latG('consume:resumed', {ms: Date.now() - consumeT0, kind: consumed.kind, tag: participantTag.slice(0, 8), batch});

            const ms = new MediaStream();
            ms.addTrack(c.track as unknown as MediaStreamTrack);
            const newTile: RemoteTile = {
              participantTag,
              consumerId:  c.id,
              producerId,
              kind:        consumed.kind,
              stream:      ms,
              // Late join: the peer's camera may already be off — start
              // on the avatar placeholder, not a frameless black plane.
              // Older servers omit the field → false (unchanged).
              paused:      consumed.producerPaused === true,
            };
            if (batch) {
              // B-13 — boot burst ONLY: defer the React update; the step=9
              // loop flushes the whole batch in one setRemoteTiles so the
              // layout sees the final tile count and never freezes at the
              // intermediate 1. The live new-producer path passes batch=false
              // so a mid-call audio→video switch renders its tile immediately
              // (regression fix: the old shared flag swallowed those tiles).
              pendingTileBatch.push(newTile);
            } else {
              setRemoteTiles(prev => {
                const next = prev.concat(newTile);
                patchActiveGroupCall(rid, {remoteTiles: next});
                return next;
              });
            }
            // Tile is live — from here a failure is NOT a retryable
            // partial; the consumer is fully wired and owned by the map.
            tileRegistered = true;

            // Fix #9: track listener cleanup. Each consumer accumulates
            // listeners (trackended, mute, unmute) that have no
            // standardized removeEventListener path on RN-WebRTC's
            // MediaStreamTrack. We capture each cb behind a `cancelled`
            // flag the cleanup array can flip — that way the listeners
            // remain attached but become inert post-leaveInternal.
            // This also closes the post-unmount setState window: if
            // mute fires after we've torn down, setRemoteTiles would
            // run on an unmounted hook and React would warn.
            let listenerCancelled = false;
            const cleanups: Array<() => void> = [
              () => { listenerCancelled = true; },
            ];

            c.on('trackended', () => {
              if (listenerCancelled) {return;}
              setRemoteTiles(prev => prev.filter(t => t.consumerId !== c.id));
              consumersByPid.current.delete(c.id);
              consumerCleanupsByPid.current.delete(c.id);
              // BS-MEDIA — drop from the consumed set so that if this exact
              // producer is re-announced later the reconcile can re-consume
              // it (the producerId is the consume key).
              consumedProducerIdsRef.current.delete(producerId);
            });

            // Camera-off (paused) state is owned SOLELY by the authoritative
            // sfu.producer-paused/-resumed frames (+ the consume snapshot and
            // the reconcile re-apply). We deliberately DO NOT flip `paused`
            // from the native track 'mute' event any more. On a flaky hardware
            // decoder, 'mute' ALSO fires on a mid-stream DECODE STALL (camera
            // still on) — which mislabelled the tile as camera-off and, fatally,
            // EXCLUDED it from the freeze watchdog (vUnpaused), so the stall
            // self-heal / consumer-rebuild never ran and the peer's video
            // stayed frozen (device-confirmed: Redmi tile stuck at `=223(off)`).
            // Letting a real stall surface as an unpaused-but-not-advancing tile
            // is exactly what lets the watchdog recover it. A genuine camera-off
            // arrives as a producer-paused frame within ~100ms (matchedBy=pid),
            // so the avatar swap is unaffected.
            consumerCleanupsByPid.current.set(c.id, cleanups);
            return c.id;
          } catch (e) {
            // Retryable — the outer consumeProducer loop decides whether
            // to try again or leave it for the reconcile tick. Note the
            // SFrame attach failure path above rethrows here AFTER it has
            // already closed its own consumer + removed it from the map,
            // so a retry starts clean.
            console.warn('[useGroupCall] consume attempt failed', producerId.slice(0,8), (e as Error).message);
            // BS-MEDIA — close any half-built consumer so the retry mints
            // a fresh one cleanly instead of leaking it into the map.
            if (consumer && !tileRegistered) {
              try { consumer.close(); } catch { /* ignore */ }
              consumersByPid.current.delete(consumer.id);
            }
            return null;
          }
        }

        // BS-MEDIA — reconcile against the SFU's authoritative producer
        // list. Recovers two failure modes the old code dropped silently:
        //   1. a missed `sfu.new-producer` frame (WS blip, or a frame that
        //      arrived during the minimize→restore handler swap), and
        //   2. a producer whose consume exhausted its retries.
        // We ask the server which producers we SHOULD have, subtract the
        // ones we already consumed (or have in flight), and consume the
        // gap. Idempotent and cheap — safe to run on a slow tick.
        // B-17 — per-producer "absent from the authoritative snapshot"
        // counter, persisted across reconcile ticks (same boot closure).
        // A tile is only pruned after the producer has been gone for
        // PRUNE_MISS_THRESHOLD consecutive SUCCESSFUL snapshots, so a
        // transient/partial fetch can never drop a valid tile.
        const tilePruneMisses = new Map<string, number>();
        const PRUNE_MISS_THRESHOLD = 3;
        async function reconcileProducers(): Promise<void> {
          if (cancelled || isLeavingRef.current) {return;}
          const wsLive = transportRef.current;
          if (!wsLive || !rid) {return;}
          let resp: {producers: Array<{producerId: string; participantTag: string; kind: 'audio' | 'video'; paused?: boolean}>};
          try {
            resp = await wsRequest<typeof resp>(wsLive, 'sfu.producers', {roomId: rid});
          } catch (e) {
            console.warn('[bravo.groupcall.reconcile] sfu.producers failed:', (e as Error).message);
            return;
          }
          if (cancelled || isLeavingRef.current) {return;}
          // B-17 — reconcile on TILES, not just on consumers. A producer can
          // be fully consumed (consumer attached, audio flowing) yet have NO
          // tile if the step=9 boot-batch flush lost it to a race — the
          // rotating-victim symptom where a non-host joiner shows 2/3 tiles
          // even though every consumer attached. The old filter only
          // re-consumed producers with no CONSUMER, so a consumed-but-tileless
          // producer was invisible forever (the reconcile saw it as "already
          // consumed" and skipped it). Split the work by what's actually
          // missing:
          //   • no tile AND no live consumer  → fresh consume.
          //   • no tile BUT a live consumer    → rebuild the tile from the
          //     existing consumer; re-consuming would throw "consumer already
          //     exists" and the SFrame transform is already attached to it.
          const haveTileFor = new Set(remoteTilesRef.current.map(t => t.producerId));
          const recovered: RemoteTile[] = [];
          const toConsume: typeof resp.producers = [];
          for (const p of resp.producers) {
            if (haveTileFor.has(p.producerId)) {continue;}
            if (inFlightConsumes.current.has(p.producerId)) {continue;}
            const live = Array.from(consumersByPid.current.values()).find(
              c => (c as unknown as {producerId?: string}).producerId === p.producerId,
            );
            const track = live ? (live.track as unknown as MediaStreamTrack | null) : null;
            if (live && !(live as unknown as {closed?: boolean}).closed && track) {
              const ms = new MediaStream();
              ms.addTrack(track);
              recovered.push({
                participantTag: p.participantTag,
                consumerId:     live.id,
                producerId:     p.producerId,
                kind:           p.kind,
                stream:         ms,
                paused:         p.paused === true,
              });
            } else {
              toConsume.push(p);
            }
          }
          // Authoritative pause sync. A missed sfu.producer-paused/
          // -resumed frame self-heals here on the next tick. CALL-24:
          // audio now rides the same server-side producer pause as
          // video (toggleMuteInternal emits it), so the snapshot is
          // authoritative for the remote mic-off glyph too — this only
          // touches REMOTE tiles, never the local mute badge.
          {
            const pauseSync = resp.producers.filter(p => p.paused !== undefined);
            if (pauseSync.length > 0) {
              setRemoteTiles(prev => {
                let next = prev;
                for (const p of pauseSync) {
                  next = applyProducerPaused(next, p.producerId, p.paused === true);
                }
                if (next !== prev) {patchActiveGroupCall(rid, {remoteTiles: next});}
                return next;
              });
            }
          }
          // Audit GC-01 — durably re-assert MY OWN camera pause state. If the
          // authoritative snapshot for my video producer disagrees with what I
          // intended (a lost pause/resume, or a reconnect that dropped my SFU
          // tag), re-emit so peers converge onto the right state. Fixes both
          // the reported video-toggle-not-syncing bug and the receiver churn
          // loop (GC-02) that a stuck-unpaused producer triggers.
          // B-101 LC-12/13 — while WE hold a background auto-pause, the
          // server snapshot legitimately disagrees with the user's intent;
          // re-asserting here would resume the camera in the user's pocket
          // and fight the AppState handler every reconcile tick.
          if (intendedVideoPausedRef.current !== null && !isLeavingRef.current
              && !bgAutoPausedVideoRef.current) {
            const myVp = producersRef.current.find(
              p => (p as unknown as {kind?: string; closed?: boolean}).kind === 'video'
                && !(p as unknown as {closed?: boolean}).closed,
            );
            const myPid = (myVp as unknown as {id?: string} | undefined)?.id;
            if (myPid) {
              const snap = resp.producers.find(p => p.producerId === myPid);
              if (snap?.paused !== undefined && snap.paused !== intendedVideoPausedRef.current) {
                const ev = intendedVideoPausedRef.current ? 'sfu.producer.pause' : 'sfu.producer.resume';
                console.log(`[bravo.groupcall.reassert] snapshot=${snap.paused} intended=${intendedVideoPausedRef.current} → ${ev}`);
                void wsRequest<{ok: true}>(wsLive, ev, {roomId: rid, producerId: myPid})
                  .catch(e => console.log(`[bravo.groupcall.reassert] ${ev} failed:`, (e as Error).message));
              }
            }
          }
          if (recovered.length > 0) {
            console.log(`[bravo.groupcall.reconcile] rebuilding ${recovered.length} orphaned tile(s)`);
            setRemoteTiles(prev => {
              const have = new Set(prev.map(t => t.consumerId));
              const next = prev.concat(recovered.filter(t => !have.has(t.consumerId)));
              patchActiveGroupCall(rid, {remoteTiles: next});
              return next;
            });
          }
          // B-17 — PRUNE phantom tiles. A boot-race room recreation (B-08)
          // or a producer that closed without a `sfu.participant.left` can
          // leave a stale tile behind, shown as an EXTRA BLANK cell next to
          // the real participants (the v1.0.48 "SH + FA + 1 blank" symptom).
          // The server's snapshot is authoritative: a producer that's still
          // producing is ALWAYS listed, so a tile whose producerId is absent
          // for several consecutive successful snapshots is genuinely gone.
          // Debounced so a one-off partial fetch can't drop a live tile.
          // B-17 — prune phantom + superseded (zombie-tag) tiles. The rule
          // lives in `computeTilePrune` (pure, unit-tested): a tag absent
          // from the snapshot whose userId is live under a DIFFERENT tag was
          // replaced by a reconnect→rejoin (B-05 WS churn) and drops THIS
          // tick; a plain-absent producer drops only after
          // PRUNE_MISS_THRESHOLD consecutive successful snapshots so a
          // partial fetch can't evict a live participant. Identity
          // (tag→userId) comes from the per-room registry, populated by each
          // peer's groupCallPresence envelope at (re)join.
          const {pruneConsumerIds, prunedProducerIds, nextMisses} = computeTilePrune({
            tiles:               remoteTilesRef.current,
            snapshot:            resp.producers,
            inFlightProducerIds: inFlightConsumes.current,
            identities:          getGroupCallIdentities(rid),
            prevMisses:          tilePruneMisses,
            threshold:           PRUNE_MISS_THRESHOLD,
          });
          tilePruneMisses.clear();
          for (const [pid, n] of nextMisses) {tilePruneMisses.set(pid, n);}
          for (const pid of prunedProducerIds) {
            // Allow a re-consume if the producer ever reappears.
            consumedProducerIdsRef.current.delete(pid);
          }
          if (pruneConsumerIds.size > 0) {
            console.log(`[bravo.groupcall.reconcile] pruning ${pruneConsumerIds.size} stale tile(s)`);
            for (const cid of pruneConsumerIds) {
              const c = consumersByPid.current.get(cid);
              if (c) {
                try { (c as unknown as {close?: () => void}).close?.(); } catch { /* already closed */ }
                consumersByPid.current.delete(cid);
              }
            }
            setRemoteTiles(prev => {
              const next = prev.filter(t => !pruneConsumerIds.has(t.consumerId));
              patchActiveGroupCall(rid, {remoteTiles: next});
              return next;
            });
          }
          if (toConsume.length === 0) {return;}
          console.log(`[bravo.groupcall.reconcile] consuming ${toConsume.length} missing producer(s)`);
          for (const p of toConsume) {
            await consumeProducer(p.producerId, p.participantTag, p.kind);
          }
        }
        reconcileProducersRef.current = reconcileProducers;

        // B-05 — re-wire mediasoup against the FRESH participantTag +
        // transports the server mints on a reconnect-driven sfu.join. The
        // group master key is unchanged (the original key gate already
        // passed), so we REUSE groupEncryptionRef — no re-gate, no
        // plaintext fallback (ARCHITECTURE_AMENDMENT_SFRAME §"fails
        // closed"). We close the dead transports/producers/consumers
        // first, then rebuild from the new join response and re-consume
        // its existingProducers. Does NOT touch the group key, refresh, or
        // any server state — purely a client-side re-entry into the SFU.
        // Arrow (not a function declaration) so it keeps the IIFE's
        // non-null narrowing of the captured `ws`.
        const rejoinRoom = async (rejoined: SfuJoinedResp, attemptGen: number): Promise<void> => {
          const dev = deviceRef.current;
          const recEnc = groupEncryptionRef.current;
          if (!dev || !recEnc) {throw new Error('rejoin: device/encryption missing');}
          const room = rid!;
          /**
           * WI-3.1 — every write below this point is conditional on still
           * being the newest attempt. Two rejoins CAN overlap (a flapping
           * socket, or the hub's stuck-claim takeover), and their writes
           * interleave destructively: the loser's `consumedProducerIds.clear()`
           * erases the winner's record and every producer is consumed twice;
           * its `producersRef.push` appends producers bound to a transport it
           * is about to close; its `sendTxRef` assignment re-points the live
           * refs at a dead socket; and its terminal setState lands after the
           * winner's.
           */
          const stale = (where: string): boolean => abortStaleAttempt(where, {
            roomId: room, gen: attemptGen,
            cancelled, leaving: isLeavingRef.current,
          });
          if (stale('rejoin.enter')) {return;}
          // WI-3.2 — hold the room for the whole rebuild so the reconcile
          // tick, the early-producer buffer and the resume reconcile all
          // stand down instead of consuming onto half-built transports.
          markAttemptRunning(room, attemptGen);
          try {
            participantTagRef.current = rejoined.participantTag;
            setSelfTag(rejoined.participantTag);
            setIsHost(rejoined.isHost);
            // Tear down the dead client-side mediasoup objects bound to the
            // pre-drop socket. SFrame detachers first (abort in-flight pipes
            // before transports close), then producers/consumers/transports.
            // Keep groupEncryptionRef alive — same key, re-attached below.
            for (const detach of sframeDetachersRef.current) { try {detach();} catch { /* ignore */ } }
            sframeDetachersRef.current = [];
            for (const cleanups of consumerCleanupsByPid.current.values()) {
              for (const cb of cleanups) { try { cb(); } catch { /* ignore */ } }
            }
            consumerCleanupsByPid.current.clear();
            for (const p of producersRef.current) { try { p.close(); } catch { /* ignore */ } }
            producersRef.current = [];
            for (const c of consumersByPid.current.values()) { try { c.close(); } catch { /* ignore */ } }
            consumersByPid.current.clear();
            // Review round 2 — REPLACED, not cleared in place. A consume still
            // in flight from before this rebuild holds a reference to the OLD
            // Set, so its `finally` lands harmlessly there instead of deleting
            // the entry this rebuild is about to make (which would switch the
            // Fix-#12 in-flight dedup off for that producer and let a second
            // concurrent `recv.consume` through).
            inFlightConsumes.current       = new Set<string>();
            consumedProducerIdsRef.current = new Set<string>();
            try { sendTxRef.current?.close(); } catch { /* ignore */ }
            try { recvTxRef.current?.close(); } catch { /* ignore */ }
            setRemoteTiles([]);
            patchActiveGroupCall(rid, {remoteTiles: []});

            const freshTurn = await fetchTurnCredentials();
            if (stale('rejoin.turn')) {return;}

            const reSendTx = dev.createSendTransport({
              ...(rejoined.sendTransport as Record<string, unknown>),
              iceServers:           freshTurn,
              iceTransportPolicy:   'all',
              iceCandidatePoolSize: 0,
            } as never);
            sendTxRef.current = reSendTx;
            reSendTx.on('connect', ({dtlsParameters}, cb, errb) => {
              if (isLeavingRef.current) { errb(new Error('leaving')); return; }
              wsRequest<{ok: true}>(ws, 'sfu.transport.connect', {
                roomId: rid!, transportId: reSendTx.id, dtlsParameters,
              }).then(() => cb()).catch(e => errb(e as Error));
            });
            reSendTx.on('produce', ({kind, rtpParameters}, cb, errb) => {
              if (isLeavingRef.current) { errb(new Error('leaving')); return; }
              wsRequest<{producerId: string}>(ws, 'sfu.produce', {
                roomId: rid!, transportId: reSendTx.id, kind, rtpParameters,
              }).then(({producerId}) => cb({id: producerId})).catch(e => errb(e as Error));
            });

            const reRecvTx = dev.createRecvTransport({
              ...(rejoined.recvTransport as Record<string, unknown>),
              iceServers:           freshTurn,
              iceTransportPolicy:   'all',
              iceCandidatePoolSize: 0,
            } as never);
            recvTxRef.current = reRecvTx;
            reRecvTx.on('connect', ({dtlsParameters}, cb, errb) => {
              if (isLeavingRef.current) { errb(new Error('leaving')); return; }
              wsRequest<{ok: true}>(ws, 'sfu.transport.connect', {
                roomId: rid!, transportId: reRecvTx.id, dtlsParameters,
              }).then(() => cb()).catch(e => errb(e as Error));
            });
            (reSendTx as unknown as {on: (e: string, cb: (s: string) => void) => void})
              .on('connectionstatechange', (s) => onTxState('send', s, reSendTx));
            (reRecvTx as unknown as {on: (e: string, cb: (s: string) => void) => void})
              .on('connectionstatechange', (s) => onTxState('recv', s, reRecvTx));

            // Re-produce the still-live local tracks (the camera/mic were
            // never released across the WS drop). SFrame re-attached via the
            // same encryptor; refuse (throw) on attach failure.
            //
            // Review round 2 — the produced objects are collected LOCALLY and
            // published to the refs only once, under the guard below.
            //
            // Pushing straight into `producersRef` / `sframeDetachersRef` was
            // the one write this module's own header claimed to have fixed and
            // had not: `reSendTx.produce()` is a full `sfu.produce` round-trip
            // and `attachSenderCryptor` is another await, with the next stale
            // check one await too late. A superseded attempt therefore appended
            // a producer bound to a transport ALREADY CLOSED by the winner into
            // the winner's live array — where `toggleVideo`, the GC-01 self-pause
            // re-assert (which would then emit `sfu.producer.pause` for a
            // producerId the server no longer has), the minimize resume path and
            // `leaveInternal` all read it. Its detacher likewise sat waiting to
            // fire against a closed pipe.
            const newProducers: Producer[] = [];
            const newDetachers: Array<() => void> = [];
            const at = audioTrackRef.current;
            if (at && at.readyState !== 'ended') {
              // GC-06 — track blanked until the sender cryptor is attached.
              await withTrackBlanked(at, async () => {
                const p = await reSendTx.produce({
                  track: at as never,
                  codecOptions: {opusStereo: false, opusFec: true, opusDtx: true, opusMaxAverageBitrate: 32_000, opusPtime: 10},
                } as never);
                newProducers.push(p);
                clearBlankedPauseLatch(p);
                const rtpSender = (p as unknown as {rtpSender?: {id: string}}).rtpSender;
                if (rtpSender) {
                  const detach = await recEnc.attachSenderCryptor(rtpSender, (reSendTx as unknown as {handler?: {_pc?: unknown}}).handler?._pc, 'audio');
                  newDetachers.push(detach);
                }
              });
            }
            const vt = videoTrackRef.current;
            if (vt && vt.readyState !== 'ended') {
              // GC-06 — track blanked until the sender cryptor is attached.
              await withTrackBlanked(vt, async () => {
                const p = await reSendTx.produce({
                  track: vt as never,
                  // B-121 — MUST match the boot path. Hardcoding simulcast here
                  // re-broke iOS video after every transport recovery.
                  encodings: videoEncodings(),
                  codecOptions: {videoGoogleStartBitrate: 200},
                } as never);
                newProducers.push(p);
                clearBlankedPauseLatch(p);
                const rtpSender = (p as unknown as {rtpSender?: {id: string}}).rtpSender;
                if (rtpSender) {
                  const detach = await recEnc.attachSenderCryptor(rtpSender, (reSendTx as unknown as {handler?: {_pc?: unknown}}).handler?._pc, 'video');
                  newDetachers.push(detach);
                }
              });
            }

            if (stale('rejoin.produced')) {
              // Superseded while producing: close what we built instead of
              // leaking it. The winner already closed the transport these were
              // created on, so this is belt-and-braces, not the mechanism.
              for (const p of newProducers)  { try { p.close(); } catch { /* ignore */ } }
              for (const d of newDetachers)  { try { d(); }       catch { /* ignore */ } }
              return;
            }
            producersRef.current.push(...newProducers);
            sframeDetachersRef.current.push(...newDetachers);
            // Re-consume everyone already in the room (fresh consume keys
            // against the new recv transport). `attemptGen` marks these as OUR
            // OWN work so the mid-rebuild park above lets them through.
            for (const ep of rejoined.existingProducers) {
              if (stale('rejoin.consume')) {return;}
              await consumeProducer(ep.producerId, ep.participantTag, ep.kind, false, attemptGen);
            }

            if (stale('rejoin.stash')) {return;}
            // Refresh the leak-stash with the new live handles.
            liveSfuHandlesByRoom.set(rid!, {
              device:           deviceRef.current,
              sendTx:           sendTxRef.current,
              recvTx:           recvTxRef.current,
              transport:        transportRef.current,
              producers:        producersRef.current,
              consumersByPid:   consumersByPid.current,
              consumerCleanups: consumerCleanupsByPid.current,
              sframeDetachers:  sframeDetachersRef.current,
              groupEncryption:  groupEncryptionRef.current,
              participantTag:   participantTagRef.current,
              handlerCleanup:   cleanupSubRef.current,  // F6
              rejoinRoom,                               // L14
              roomToken:        roomTokenRef.current,    // L14
              inFlightConsumes:    inFlightConsumes.current,       // WI-3.4
              consumedProducerIds: consumedProducerIdsRef.current, // WI-3.4
            });
            // B-477 — the handles this instance just replaced are the ones a
            // RESTORED instance is holding. Without this it keeps the closed
            // transports for the rest of the call.
            notifyLiveSfuHandles(rid!);
            if (stale('rejoin.joined')) {return;}
            setState('joined');
          } finally {
            endAttemptRunning(room, attemptGen);
            // WI-3.2 — release anything announced during the rebuild. Done
            // AFTER the in-flight mark is dropped so the buffer's readiness
            // probe can pass; if a NEWER rejoin has since claimed the room,
            // consumeProducer re-parks them rather than losing them.
            try { earlyProducerBufferRef.current?.drain(); } catch { /* ignore */ }
          }
        };
        rejoinRoomRef.current = rejoinRoom;

        // Review round 1 removed an attempt-generation guard here.
        //
        // It was minted against the room known at step 1, and the B-08
        // `room_not_found` re-create RE-POINTS `rid` at a freshly minted room
        // without re-minting the generation. The guard therefore compared a
        // generation from the reaped room against a room with no counter at
        // all, read "superseded", and returned — skipping setState('joined'),
        // the BS-LEAK handle stash and setActiveGroupCall. The second person
        // to tap Call got a call that was fully connected server-side behind a
        // screen stuck on "Connecting…", with the whole mediasoup pipeline
        // leaked. Found by both reviewers independently.
        //
        // It also protected nothing: no await separates
        // `rejoinRoomRef.current = rejoinRoom` from this line, so no rejoin
        // can interleave here, and a rejoin's own `setState('joined')` agrees
        // with this one anyway.
        if (cancelled || isLeavingRef.current) {return;}
        callStartedAtRef.current = Date.now();
        setState('joined');
        latG('state:joined');

        // Audit BS-LEAK — stash the live mediasoup handles so a
        // minimize→restore can rehydrate the restored hook's refs and
        // its leaveInternal can actually close them. We store the SAME
        // container objects (Maps/arrays), so producers/consumers added
        // during the minimize window (via the original handler) are
        // still reachable for teardown. See holder doc at top of file.
        liveSfuHandlesByRoom.set(rid, {
          device:           deviceRef.current,
          sendTx:           sendTxRef.current,
          recvTx:           recvTxRef.current,
          transport:        transportRef.current,
          producers:        producersRef.current,
          consumersByPid:   consumersByPid.current,
          consumerCleanups: consumerCleanupsByPid.current,
          sframeDetachers:  sframeDetachersRef.current,
          groupEncryption:  groupEncryptionRef.current,
          participantTag:   participantTagRef.current,
          handlerCleanup:   cleanupSubRef.current,  // F6
          rejoinRoom,                               // L14
          roomToken:        roomTokenRef.current,    // L14
          inFlightConsumes:    inFlightConsumes.current,       // WI-3.4
          consumedProducerIds: consumedProducerIdsRef.current, // WI-3.4
        });

        // Publish to the floating-overlay registry so minimize works.
        // B-33 (Defect B) — preserve the last-known roster on a same-room
        // rejoin (the adopt gate can miss when a local track ended), so the
        // user doesn't see an empty grid while live consume re-attaches. A
        // different room / no prior call seeds empty; the consume + identity
        // flow overwrites with live data either way.
        const rosterSeed = seedRosterForRepublish(
          getActiveGroupCall(), rid, joined.participantTag, opts.ownDisplayName,
        );
        // BS-MINIMIZE-RING — preserve a minimize the user did WHILE it rang
        // (the early-seed registry may already be isMinimized/keepAlive). If
        // we hardcoded false here the call would un-minimize itself the
        // instant it connected behind the bubble.
        const prevReg = getActiveGroupCall();
        groupKeyRef.current = setActiveGroupCall({
          roomId:           rid,
          conversationId:   opts.conversationId,
          conversationName: opts.callerName,
          callType:         opts.callType,
          isHost:           joined.isHost,
          selfTag:          joined.participantTag,
          state:            'joined',
          localStream:      stream,
          remoteTiles:      rosterSeed.remoteTiles,
          identityByTag:    rosterSeed.identityByTag,
          audioLevels:      {},
          audioTrack,
          // Reflect any toggle the user made DURING the ring/connect window
          // (the boot started audio-only if they turned video off) instead
          // of hardcoding the at-join defaults.
          videoTrack:       videoTrackRef.current,
          isMuted:          audioTrackRef.current ? !audioTrackRef.current.enabled : false,
          isVideoOff:       isVideoOffRef.current,
          isMinimized:      prevReg?.isMinimized ?? false,
          keepAlive:        prevReg?.keepAlive ?? false,
          leave:            leaveInternal,
          toggleMute:       toggleMuteInternal,
          // Fix #15: register the freshest toggleVideo on the
          // registry too. Without this, the FloatingCallOverlay's
          // video toggle would call into a stale closure that
          // captured a stale localStream — turning the camera back on
          // would acquire a track but fail to splice it into the
          // currently-rendered MediaStream. The registry-sync effect
          // below also writes toggleVideo on every refresh.
          toggleVideo:      toggleVideo,
          joinedAtMs:       callStartedAtRef.current,
        });
      } catch (e) {
        if (!cancelled) {
          console.warn('[useGroupCall] boot failed:', (e as Error).message);
          setState('failed');
          // B-343 — a dead boot must not strand the camera/mic. Tracks
          // acquired at step 2 were only ever stopped by an explicit user
          // End (leaveInternal); a failure before that leaves the camera
          // held, which wedges EVERY subsequent call's getUserMedia behind
          // it (the "Call failed" loop). The call is failed — no media can
          // flow — so stopping is unconditionally safe here.
          try {
            audioTrackRef.current?.stop(); audioTrackRef.current = null;
            videoTrackRef.current?.stop(); videoTrackRef.current = null;
            setLocalStream(null);
          } catch { /* best-effort release */ }
          // B-342 — the step-3c early ring means a boot can now die AFTER
          // recipients were rung (Device.load / transports / produce
          // failures). Dismiss their ringing screens immediately instead of
          // letting them ring the full 30 s window at a dead room. Same
          // stillRinging arithmetic as leaveInternal; same shared frame
          // builder, so the payloads cannot drift apart.
          try {
            const wsNow = transportRef.current;
            const ridNow = roomIdRef.current;
            if (wsNow && ridNow && opts.direction === 'outgoing' && sentRingRef.current) {
              const stillRinging = Array.from(new Set([
                ...(Array.isArray(opts.recipientUserIds) ? opts.recipientUserIds : []).filter(Boolean),
                ...rungUsersRef.current, // KO-7 — same union as leaveInternal
              ])).filter(uid => !joinedUserIdsRef.current.has(uid));
              if (stillRinging.length > 0) {
                console.warn('[CALLDIAG] [ring.send] boot failed after early ring — cancelling', stillRinging.length, 'outstanding ring(s) (B-342)');
                sendRingCancelFrame(wsNow, ridNow, stillRinging);
              }
            }
          } catch { /* best-effort — recipients time out at 30s */ }
          /**
           * ...and a dead boot must not strand the ROOM either.
           *
           * Step 1 creates the room; step 3 joins it. A boot that dies in
           * between leaves a server-side room with us as host and nobody in
           * it, which the relay then advertises to every other member for
           * its fresh-room grace — the corpse the next caller "joins".
           *
           * THREE constraints, each learned the hard way in review:
           *
           * 1. AFTER the ring-cancel above, never before. Leaving deletes
           *    the room, and `sfu.ring.cancel` is host-gated on a room that
           *    still exists — reaping first made the cancel fail
           *    `not_host`, so everyone we rang kept ringing the full 30s at
           *    a room that was already gone.
           *
           * 2. ONLY when we never joined. With a participant tag this frame
           *    takes the gateway's normal tag path, which runs
           *    `hostTerminatesRoom` — so a boot that threw AFTER a peer had
           *    already answered would evict that peer from a working call.
           *    Post-join teardown belongs to leaveInternal, which already
           *    orders cancel-then-leave correctly.
           *
           * 3. IMMEDIATELY, or not at all — not via `wsRequest`.
           *    NOT because anything is buffered: `emitWithAck` rejects at
           *    once with `transport not open` when the socket is down
           *    (packages/messenger-core/src/transport/client.ts:392), and
           *    `waitForTransportOpen` only polls for up to 10s and then
           *    gives up. The reason is the DELAY itself. `wsRequest` would
           *    send this up to 10s late, and `createRoom` is idempotent
           *    within the room's grace — so the user's retry in that window
           *    gets THE SAME room id and may already have joined it. The
           *    late frame then finds a live tag for the room on this socket,
           *    skips the orphan branch, and takes the ordinary leave path
           *    with `hostTerminatesRoom` — tearing down the call the retry
           *    had just established.
           *    Cost of the trade: a boot that fails mid-reconnect skips the
           *    reap. The relay's 60s zombie sweeper is the backstop, and a
           *    corpse that outlives the grace is no longer handed out.
           */
          try {
            const wsLeave = transportRef.current;
            const ridLeave = roomIdRef.current ?? createdRoomIdRef.current;
            const neverJoined = !participantTagRef.current;
            const open = (wsLeave as unknown as {state?: string} | null)?.state === 'connected';
            if (wsLeave && ridLeave && neverJoined && open) {
              console.warn('[CALLDIAG] [bravo.groupcall.boot] releasing never-joined room after failed boot room=', ridLeave.slice(0, 8));
              void wsLeave.emitWithAck<{ok: boolean}>('sfu.leave', {roomId: ridLeave})
                .catch(() => undefined);
            }
          } catch { /* best-effort — the relay's zombie sweeper is the backstop */ }
          // BS-MINIMIZE-RING — if the call was MINIMIZED while it was
          // connecting (the hook is unmounted, so setState('failed') is a
          // no-op), clear the registry so the floating bubble dismisses
          // instead of hanging on "connecting…" forever after a timeout /
          // no-answer / key-wait failure.
          try {
            const reg = getActiveGroupCall();
            if (reg && reg.conversationId === opts.conversationId && reg.isMinimized) {
              // WI-1.5 — this branch keys on conversationId; pass the room the
              // entry itself names so a slot change between the two lines cannot
              // redirect the teardown.
              void endActiveGroupCall(reg.roomId);
            }
          } catch { /* ignore */ }
        }
      }
    })();

    return () => {
      // BS-MINIMIZE-RING — on MINIMIZE (keepAlive), keep the boot/ring/call
      // running in the BACKGROUND so the floating bubble stays live and a
      // still-connecting call keeps connecting (the join/key-wait completes
      // behind the bubble). Only on a real teardown do we cancel + leave.
      const live = getActiveGroupCall();
      if (live?.keepAlive) {
        // B-101 LC-4 — MINIMIZE: deliberately KEEP the rejoin handler
        // installed. Dropping it here is what left a minimized call
        // unable to re-join after a socket bounce (the SFU had already
        // closed our transports on its 10s leave grace), so the bubble
        // showed a live call while the user was silent for everyone.
        // The hub replaces the handler on restore, so no stacking.
        //
        // Review GC-1 — but the AppState listener DOES go away with this
        // screen, so a background camera auto-pause taken before the
        // minimize could never be undone: peers would see the avatar
        // placeholder for the rest of the call. Release it here.
        if (bgAutoPausedVideoRef.current) {
          bgAutoPausedVideoRef.current = false;
          const t = videoTrackRef.current;
          try { if (t) {t.enabled = true;} } catch { /* track already dead */ }
          const vp = producersRef.current.find(
            p => (p as unknown as {kind?: string; closed?: boolean}).kind === 'video'
              && !(p as unknown as {closed?: boolean}).closed,
          );
          const pid = (vp as unknown as {id?: string} | undefined)?.id;
          const wsMin = transportRef.current;
          const ridMin = roomIdRef.current;
          if (pid && wsMin && ridMin && !isVideoOffRef.current
              && intendedVideoPausedRef.current !== true) {
            void wsRequest<{ok: true}>(wsMin, 'sfu.producer.resume', {roomId: ridMin, producerId: pid})
              .catch(() => { /* the GC-01 reconcile re-asserts */ });
          }
        }
        return;
      }
      cancelled = true;
      releaseGroupCallRejoinHandler(rejoinTokenRef.current);
      void leaveInternal();
    };
  // Mount once per call. Re-keying happens by remounting.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Audio level poller ────────────────────────────────────
  // Drives the "loudest speaker → hero tile" logic on page 1.
  // We don't poll producer/consumer objects individually because
  // mediasoup-client doesn't expose RTCRtpReceiver.getStats() in a
  // typed way; instead we walk the recv transport's combined report
  // once every 500 ms and pluck `audioLevel` off each inbound-rtp
  // of kind='audio'. The report's `trackIdentifier` lets us join
  // back to the consumer's track, then to its participantTag.
  // Tag: [bravo.groupcall.audio-level].
  useEffect(() => {
    if (state !== 'joined') {return;}
    const recvTx = recvTxRef.current;
    if (!recvTx) {return;}
    let cancelled = false;
    const trackToTag = (): Map<string, string> => {
      // (re)build the track→tag map each tick — cheap, and consumers
      // come/go as participants join/leave.
      const m = new Map<string, string>();
      for (const c of consumersByPid.current.values()) {
        if (c.kind !== 'audio') {continue;}
        const tag = (c.appData as {participantTag?: string} | undefined)?.participantTag
          // appData isn't set today; fall back to mapping consumerId
          // back to the tile we registered.
          ?? remoteTilesRef.current.find(t => t.consumerId === c.id)?.participantTag;
        const trackId = (c.track as MediaStreamTrack | null)?.id;
        if (tag && trackId) {m.set(trackId, tag);}
      }
      return m;
    };
    // B-15 — video track→tag map, plus the set of tags whose video consumer
    // is currently UNPAUSED (a paused producer is camera-off, not a stall).
    const videoTrackToTag = (): {byTrack: Map<string, string>; unpaused: Set<string>} => {
      const byTrack = new Map<string, string>();
      const unpaused = new Set<string>();
      for (const c of consumersByPid.current.values()) {
        if (c.kind !== 'video') {continue;}
        const tag = remoteTilesRef.current.find(t => t.consumerId === c.id)?.participantTag;
        const trackId = (c.track as MediaStreamTrack | null)?.id;
        if (!tag) {continue;}
        const tile = remoteTilesRef.current.find(t => t.consumerId === c.id);
        // Offscreen-paused tiles are intentionally frameless — excluding
        // them here keeps the freeze watchdog + stalled overlay off them
        // (the snapshot cleanup below also restarts their grace window,
        // so a scroll-back never inherits a stale stall clock).
        if (!tile?.paused && !hiddenVideoTagsRef.current.has(tag)) {unpaused.add(tag);}
        if (trackId) {byTrack.set(trackId, tag);}
      }
      return {byTrack, unpaused};
    };
    const VIDEO_STALL_MS = 3_000;
    // DIAG + freeze-watchdog scratch state (effect-scoped; resets on state change).
    let decodeTick = 0;
    const lastKfReqByTag   = new Map<string, number>();  // last keyframe re-request per tag
    const stallSinceByTag  = new Map<string, number>();  // when a tag's CONTINUOUS stall began
    const lastRebuildByTag = new Map<string, number>();  // last consumer-rebuild per tag
    // G-C (VIDEO_CALL_RENDER_ISSUES_HANDOFF §3) — fast rebuilds per tag
    // before we accept the sender genuinely isn't emitting and slow to a
    // 60s probe (the stalled-tag overlay stays up meanwhile). Unbounded
    // 8s churn (teardown → re-consume → fresh decoder) blanked/blinked
    // the tile forever when the stall was sender-side.
    const rebuildCountByTag = new Map<string, number>();
    const MAX_FAST_REBUILDS = 3;
    const SLOW_REBUILD_MS   = 60_000;
    // CN-09 — publish the quality sample every 2nd 500 ms tick (1 Hz).
    let qualityTick = 0;
    const tick = async (): Promise<void> => {
      // Fix #10: bail before EVERY work step if the call is leaving.
      // The 500ms interval is wide enough for leaveInternal to close
      // recvTx and null sendTxRef between ticks; without this guard
      // the next tick would fire getStats() on a closed transport
      // (mediasoup throws "transport closed") and the unhandled
      // promise rejection ends up as a noisy logcat warning every
      // half second until the unmount commits.
      if (cancelled || isLeavingRef.current) {return;}
      const live = recvTxRef.current;
      if (!live) {return;}
      try {
        const report = await (live as unknown as {getStats: () => Promise<RTCStatsReport>}).getStats();
        const map = trackToTag();
        const {byTrack: vmap, unpaused: vUnpaused} = videoTrackToTag();
        const next: AudioLevelMap = {};
        const videoFramesByTag = new Map<string, number>();
        // B-121 — framesDecoded alone can't tell "the SFU forwarded nothing"
        // apart from "bytes arrived but the decoder rejected them" (an SFrame
        // decrypt miss or a codec the receiver can't parse). Those need
        // opposite fixes, so capture the inbound counters too.
        const videoRecvByTag = new Map<string, {bytes: number; recv: number}>();
        // B-123 — OUTBOUND truth for this device. Inbound counters only ever
        // describe the OTHER peer, so an iOS send-side failure was only ever
        // visible from the Android peer's trace. framesEncoded vs bytesSent
        // splits "camera/encoder produced nothing" from "encoded fine but
        // nothing left the box".
        let outEncoded = -1;
        let outBytes = -1;
        // CN-09 — link-quality aggregates for this tick.
        let cpRttMs: number | null = null;
        let jitterMsMax = -1;
        let lostSum = 0;
        let recvSum = 0;
        report.forEach((s: Record<string, unknown>) => {
          const type = s.type as string | undefined;
          if (type === 'candidate-pair' && s.state === 'succeeded' &&
              typeof s.currentRoundTripTime === 'number') {
            cpRttMs = Math.round((s.currentRoundTripTime as number) * 1000);
            return;
          }
          if (type === 'outbound-rtp' && s.kind === 'video') {
            outEncoded = Number(s.framesEncoded ?? 0);
            outBytes = Number(s.bytesSent ?? 0);
            return;
          }
          if (type !== 'inbound-rtp') {return;}
          if (s.kind === 'audio') {
            // CN-09 — aggregate BEFORE the tag mapping: an unmapped track's
            // jitter/loss still describes this device's link.
            // [CALLLAT] — one-shot "first remote audio bytes" per boot (the
            // closest release-visible proxy for "I can hear them").
            if (!firstAudioMarkedRef.current && Number(s.bytesReceived ?? 0) > 0) {
              firstAudioMarkedRef.current = true;
              latG('audio:first-inbound', {bytes: Number(s.bytesReceived ?? 0)});
            }
            const j = Number(s.jitter);
            if (Number.isFinite(j)) {jitterMsMax = Math.max(jitterMsMax, Math.round(j * 1000));}
            const pl = Number(s.packetsLost);
            const pr = Number(s.packetsReceived);
            if (Number.isFinite(pl) && Number.isFinite(pr)) {lostSum += pl; recvSum += pr;}
            const trackId = (s.trackIdentifier as string | undefined) ?? '';
            const tag = map.get(trackId);
            if (!tag) {return;}
            // audioLevel comes from the spec as 0..1 (RFC 6464 voice
            // activity). Some Android stacks report a different scale;
            // clamp defensively.
            const lvl = Math.max(0, Math.min(1, Number(s.audioLevel ?? 0)));
            next[tag] = lvl;
          } else if (s.kind === 'video') {
            const trackId = (s.trackIdentifier as string | undefined) ?? '';
            const tag = vmap.get(trackId);
            if (!tag) {return;}
            videoFramesByTag.set(tag, Number(s.framesDecoded ?? 0));
            videoRecvByTag.set(tag, {
              bytes: Number(s.bytesReceived ?? 0),
              recv:  Number(s.framesReceived ?? 0),
            });
          }
        });
        if (cancelled) {return;}

        // B-15 — fold the framesDecoded readings into the stall tracker.
        // A tag is "stalled" when its UNPAUSED video consumer hasn't
        // decoded a new frame for VIDEO_STALL_MS. Paused producers
        // (camera-off) are excluded — they have their own placeholder.
        const nowMs = Date.now();
        const snap = videoFrameSnapRef.current;
        const stalledNext: Record<string, boolean> = {};
        for (const tag of vUnpaused) {
          const frames = videoFramesByTag.get(tag) ?? 0;
          const prevSnap = snap.get(tag);
          if (!prevSnap) {
            snap.set(tag, {frames, lastAdvanceMs: nowMs});
            continue;
          }
          if (frames > prevSnap.frames) {
            snap.set(tag, {frames, lastAdvanceMs: nowMs});
          } else if (nowMs - prevSnap.lastAdvanceMs > VIDEO_STALL_MS) {
            stalledNext[tag] = true;
          }
        }
        // Drop snapshots for tags that no longer have an unpaused video
        // consumer so a later camera-on starts its grace window fresh.
        for (const tag of Array.from(snap.keys())) {
          if (!vUnpaused.has(tag)) {snap.delete(tag);}
        }
        // DIAG — per-tag decode health every ~3s. A remote video tag whose
        // framesDecoded stays flat (and isn't camera-off) is a decode stall:
        // either keyframe starvation or an SFrame decrypt miss. (off) marks a
        // tile we believe is paused — if a tag shows (off) while the peer's
        // camera is ON, the producer-paused match is wrong, not a decode stall.
        decodeTick++;
        if (decodeTick % 6 === 0) {
          const parts: string[] = [];
          for (const t of remoteTilesRef.current) {
            if (t.kind !== 'video') {continue;}
            const fr = videoFramesByTag.get(t.participantTag);
            const rx = videoRecvByTag.get(t.participantTag);
            parts.push(
              `${t.participantTag.slice(0,6)}=dec:${fr ?? -1}/rx:${rx?.recv ?? -1}/B:${rx?.bytes ?? -1}${t.paused ? '(off)' : ''}`,
            );
          }
          // Always emit, even with no remote video tiles — the send side is
          // exactly what we need when THIS device is the one going dark.
          parts.unshift(`SELF=enc:${outEncoded}/B:${outBytes}`);
          if (parts.length) {
            const line = `[bravo.groupcall.decode] frames ${parts.join(' ')}`;
            console.log(line);
            // B-121 — console.log is stripped from production bundles
            // (babel.config.js transform-remove-console), which is exactly why
            // this stall has been undiagnosable on a release build. crashLog
            // survives and mirrors into the groupcall trace file. Gated on the
            // diag flag so production Crashlytics isn't spammed every 3s.
            if (DECODE_DIAG) {crashLog(line);}
          }
        }
        // Freeze watchdog — recover an UNPAUSED video tile whose frames stop
        // advancing. Two-step escalation per tag:
        //   1. ≤2.5s stalled: cheap keyframe re-request (sfu.consumer.resume →
        //      server requestKeyFrame). Fixes a missed I-frame / simulcast-layer
        //      switch / dropped initial keyframe.
        //   2. >2.5s stalled (a keyframe didn't help → the hardware decoder is
        //      wedged): REBUILD the consumer for a FRESH decoder. This is the
        //      device-confirmed cure for the Redmi mid-call freeze; a keyframe
        //      alone can't un-stick a jammed hardware H.264 decoder.
        {
          const wsHeal  = transportRef.current;
          const ridHeal = roomIdRef.current;
          // Clear stall bookkeeping for any tag that has recovered (or whose
          // tile vanished mid-rebuild) so its next stall starts a fresh window.
          for (const tag of Array.from(stallSinceByTag.keys())) {
            if (!stalledNext[tag]) {
              stallSinceByTag.delete(tag);
              // G-C — a recovery resets the fast-rebuild budget.
              rebuildCountByTag.delete(tag);
            }
          }
          if (wsHeal && ridHeal) {
            for (const tag of Object.keys(stalledNext)) {
              const tile = remoteTilesRef.current.find(t => t.participantTag === tag && t.kind === 'video');
              if (!tile) {continue;}
              if (!stallSinceByTag.has(tag)) {stallSinceByTag.set(tag, nowMs);}
              const stalledForMs = nowMs - (stallSinceByTag.get(tag) ?? nowMs);
              if (stalledForMs <= 2_500) {
                // Step 1 — keyframe re-request (≤1 per 1.5s/tag).
                if (nowMs - (lastKfReqByTag.get(tag) ?? 0) >= 1_500) {
                  lastKfReqByTag.set(tag, nowMs);
                  void wsRequest<{ok: true}>(wsHeal, 'sfu.consumer.resume', {roomId: ridHeal, consumerId: tile.consumerId})
                    .then(() => console.log(`[bravo.groupcall.decode] keyframe re-request OK tag=${tag.slice(0,6)} cid=${tile.consumerId.slice(0,8)}`))
                    .catch((e) => console.log(`[bravo.groupcall.decode] keyframe re-request failed tag=${tag.slice(0,6)}: ${(e as Error).message}`));
                }
              } else {
                // Step 2 — rebuild the wedged consumer (≤1 per 8s/tag).
                // G-C — after MAX_FAST_REBUILDS the churn clearly isn't
                // fixing it (the stall is sender-side: their capture died
                // or our pause-state is wrong); drop to one probe per
                // 60s so the tile shows the stable stalled overlay
                // instead of blanking/blinking every 8s forever.
                const rebuilds = rebuildCountByTag.get(tag) ?? 0;
                const interval = rebuilds >= MAX_FAST_REBUILDS ? SLOW_REBUILD_MS : 8_000;
                if (nowMs - (lastRebuildByTag.get(tag) ?? 0) >= interval) {
                  lastRebuildByTag.set(tag, nowMs);
                  stallSinceByTag.set(tag, nowMs);
                  rebuildCountByTag.set(tag, rebuilds + 1);
                  if (rebuilds + 1 === MAX_FAST_REBUILDS) {
                    console.log(`[bravo.groupcall.decode] rebuild cap reached tag=${tag.slice(0, 6)} — slowing to ${SLOW_REBUILD_MS / 1000}s probes`);
                  }
                  rebuildVideoConsumerRef.current?.(tag);
                }
              }
            }
          }
        }
        setVideoStalledTags(prev => {
          const prevKeys = Object.keys(prev);
          const nextKeys = Object.keys(stalledNext);
          if (prevKeys.length === nextKeys.length &&
              nextKeys.every(k => prev[k])) {
            return prev; // unchanged — skip the re-render
          }
          return stalledNext;
        });
        // Only set state when something actually changed enough to
        // matter — avoid 2 Hz re-renders of the entire grid for noise.
        setAudioLevels(prev => {
          const tags = new Set([...Object.keys(prev), ...Object.keys(next)]);
          for (const t of tags) {
            const a = prev[t] ?? 0;
            const b = next[t] ?? 0;
            if (Math.abs(a - b) > 0.04) {return next;}
          }
          return prev;
        });
        // CN-09 — fresh object identity per publish is what advances the
        // banner hook's debounce gate; 1 Hz matches the 1:1 path.
        qualityTick += 1;
        if (qualityTick % 2 === 0) {
          setNetQuality({
            rttMs:         cpRttMs,
            jitterMs:      jitterMsMax >= 0 ? jitterMsMax : null,
            packetLossPct: lostSum + recvSum > 0
              ? Math.round(100 * lostSum / (lostSum + recvSum))
              : null,
          });
        }
      } catch {
        // Stats can transiently throw mid-renegotiation. Ignore.
      }
    };
    const interval = setInterval(() => { void tick(); }, 500);
    audioPollIntervalRef.current = interval;
    return () => {
      cancelled = true;
      clearInterval(interval);
      // Belt-and-braces: leaveInternal also clears via the ref so the
      // window between leaveInternal closing recvTx and React unmount
      // committing this cleanup is closed.
      if (audioPollIntervalRef.current === interval) {audioPollIntervalRef.current = null;}
    };
  // Why: `latG` is a per-render closure over two fixed route params and is read
  // only by the [CALLLAT] first-audio row; listing it would restart the 1 Hz
  // sampler every render. Keep the sampler keyed on `state` alone.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // remoteTiles ref so the audio-level poller's track→tag mapper
  // can read the LATEST tile list without re-firing the effect on
  // every tile change (the stats poll is independent of the React
  // tile list — we only need to read it once per tick).
  const remoteTilesRef = useRef<RemoteTile[]>([]);
  useEffect(() => { remoteTilesRef.current = remoteTiles; }, [remoteTiles]);

  // ── Offscreen video pause (10-person calls) ─────────────────────
  // The screen reports which tags are on a non-visible swipe page; we
  // pause those VIDEO consumers server-side (sfu.consumer.pause) so
  // the SFU stops forwarding their RTP to this device — a full
  // 10-person call then decodes ≤3 streams instead of 9. Audio is
  // never touched. Resume rides the tested sfu.consumer.resume path,
  // whose server side requests a keyframe so the decoder re-syncs the
  // moment the tile scrolls back into view.
  //
  // Reconciler design (state, not fire-once signals): hiddenVideoTagsRef
  // holds the screen's intent; offscreenPausedByTagRef holds tag → the
  // consumerId we actually paused. Re-running the reconciler converges
  // the two, which self-heals every churn case: a consumer REBUILT by
  // the freeze watchdog gets a fresh cid (mismatch → re-pause), a tile
  // that vanished drops its record, a failed pause is retried on the
  // next sync, and a failed RESUME is healed by the stall watchdog
  // (the tag is no longer hidden, so the watchdog sees its frozen
  // frames and re-issues sfu.consumer.resume itself).
  const hiddenVideoTagsRef     = useRef<Set<string>>(new Set());
  const offscreenPausedByTagRef = useRef<Map<string, string>>(new Map());
  const syncOffscreenVideo = useCallback((): void => {
    if (isLeavingRef.current) {return;}
    const ws  = transportRef.current;
    const rid = roomIdRef.current;
    if (!ws || !rid) {return;}
    const hidden = hiddenVideoTagsRef.current;
    const pausedByTag = offscreenPausedByTagRef.current;
    const liveVideoTags = new Set<string>();
    for (const tile of remoteTilesRef.current) {
      if (tile.kind !== 'video') {continue;}
      const tag = tile.participantTag;
      liveVideoTags.add(tag);
      const pausedCid = pausedByTag.get(tag);
      if (hidden.has(tag)) {
        if (pausedCid !== tile.consumerId) {
          pausedByTag.set(tag, tile.consumerId);
          void wsRequest<{ok: true}>(ws, 'sfu.consumer.pause', {roomId: rid, consumerId: tile.consumerId})
            .then(() => console.log(`[bravo.groupcall.offscreen] paused tag=${tag.slice(0, 6)}`))
            .catch(() => {
              // Retry on the next sync — drop the record so the diff re-fires.
              if (pausedByTag.get(tag) === tile.consumerId) {pausedByTag.delete(tag);}
            });
        }
      } else if (pausedCid) {
        pausedByTag.delete(tag);
        void wsRequest<{ok: true}>(ws, 'sfu.consumer.resume', {roomId: rid, consumerId: tile.consumerId})
          .then(() => console.log(`[bravo.groupcall.offscreen] resumed tag=${tag.slice(0, 6)}`))
          .catch(() => { /* stall watchdog re-issues resume for visible frozen tiles */ });
      }
    }
    // Drop bookkeeping for tags whose video tile vanished (peer left /
    // camera off tore the consumer down) so a later tile starts clean.
    for (const tag of Array.from(pausedByTag.keys())) {
      if (!liveVideoTags.has(tag)) {pausedByTag.delete(tag);}
    }
  }, []);
  // Screen-facing intent setter. No-ops when the set is unchanged so the
  // per-render effect in GroupCallScreen costs nothing.
  const setHiddenVideoTags = useCallback((tags: ReadonlyArray<string>): void => {
    const next = new Set(tags);
    const prev = hiddenVideoTagsRef.current;
    if (next.size === prev.size && Array.from(next).every(t => prev.has(t))) {return;}
    hiddenVideoTagsRef.current = next;
    syncOffscreenVideo();
  }, [syncOffscreenVideo]);
  // Re-converge whenever the tile list changes: a late joiner's consumer
  // is created + resumed by the consume flow, then immediately re-paused
  // here if its page is offscreen; a watchdog-rebuilt consumer (fresh
  // cid) is re-paused via the cid mismatch.
  useEffect(() => { syncOffscreenVideo(); }, [remoteTiles, syncOffscreenVideo]);

  // BS-RESUME-RECONCILE — consume producers that appeared WHILE MINIMIZED.
  // The full boot reconcileProducers/consumeProducer live inside the boot
  // IIFE and are NEVER set up on the resume/adopt path (it returns early),
  // so reconcileProducersRef is null on a restored hook and the 4s tick is
  // inert — a peer who JOINED or turned their camera ON during the minimize
  // window stays permanently tile-less after restore. This is a
  // SELF-CONTAINED, ref-based re-consume that the adopt path arms. It is
  // ADDITIVE: it never touches the working boot consume path, so a bug here
  // can only affect the rare restore-reconsume, never a live call. It
  // mirrors attemptConsume's FAIL-CLOSED SFrame contract — a remote track is
  // NEVER rendered without its decrypt transform (the SFU is the attacker).
  const consumeMissingAfterRestore = useCallback(async (): Promise<void> => {
    if (isLeavingRef.current) {return;}
    const ws   = transportRef.current;
    const rid  = roomIdRef.current;
    // WI-3.2 — same rule as the periodic tick. This one is the more dangerous
    // of the two: it issues `recv.consume` directly rather than through
    // consumeProducer, so it bypasses every dedup guard the funnel applies.
    if (rid && isAttemptRunning(rid)) {return;}
    const recv = recvTxRef.current;
    const dev  = deviceRef.current;
    if (!ws || !rid || !recv || !dev) {return;}
    let resp: {producers: Array<{producerId: string; participantTag: string; kind: 'audio' | 'video'; paused?: boolean}>};
    try {
      resp = await wsRequest<typeof resp>(ws, 'sfu.producers', {roomId: rid});
    } catch (e) {
      console.warn('[bravo.groupcall.resume-reconcile] sfu.producers failed:', (e as Error).message);
      return;
    }
    if (isLeavingRef.current) {return;}
    // Review round 2 — RE-CHECK after the await, not just on entry. The
    // request above is a full WS round-trip, and a rejoin taking the room
    // inside it would find this loop adding to the dedup sets it has just
    // rebuilt — making the rejoin silently skip that peer, or marking a
    // producer consumed whose only consumer sits on the transport the rejoin
    // closed. Neither self-heals: on this path the reconcile IS the backstop.
    if (isAttemptRunning(rid)) {return;}
    const haveTile = new Set(remoteTilesRef.current.map(t => t.producerId));
    for (const p of resp.producers) {
      if (haveTile.has(p.producerId)) {continue;}
      if (consumedProducerIdsRef.current.has(p.producerId)) {continue;}
      if (inFlightConsumes.current.has(p.producerId)) {continue;}
      inFlightConsumes.current.add(p.producerId);
      let consumer: Consumer | null = null;
      let tileRegistered = false;
      try {
        const consumed = await wsRequest<{
          consumerId: string; producerId: string; kind: 'audio' | 'video';
          rtpParameters: unknown; participantTag: string; producerPaused?: boolean;
        }>(ws, 'sfu.consume', {
          roomId: rid, transportId: recv.id, producerId: p.producerId,
          rtpCapabilities: dev.rtpCapabilities,
        });
        if (isLeavingRef.current) {return;}
        consumer = await recv.consume({
          id: consumed.consumerId, producerId: consumed.producerId,
          kind: consumed.kind, rtpParameters: consumed.rtpParameters as never,
        });
        const c = consumer;
        consumersByPid.current.set(c.id, c);
        // SFrame decrypt — REQUIRED. Fail-closed: tear the consumer down
        // rather than render an unencrypted remote track.
        const encRecv = groupEncryptionRef.current;
        const rtpReceiver = (c as unknown as {rtpReceiver?: {id: string}}).rtpReceiver;
        if (encRecv && rtpReceiver) {
          try {
            const detach = await encRecv.attachReceiverCryptor(
              rtpReceiver,
              (recv as unknown as {handler?: {_pc?: unknown}}).handler?._pc,
              p.participantTag,
            );
            sframeDetachersRef.current.push(detach);
          } catch (e) {
            console.warn('[bravo.groupcall.resume-reconcile] SFrame attach failed — closing consumer:', (e as Error).message);
            try { c.close(); } catch { /* ignore */ }
            consumersByPid.current.delete(c.id);
            consumer = null;
            continue;
          }
        }
        await wsRequest<{ok: true}>(ws, 'sfu.consumer.resume', {roomId: rid, consumerId: c.id});
        const ms = new MediaStream();
        ms.addTrack(c.track as unknown as MediaStreamTrack);
        consumedProducerIdsRef.current.add(p.producerId);
        const tile: RemoteTile = {
          participantTag: p.participantTag, consumerId: c.id, producerId: p.producerId,
          kind: p.kind, stream: ms, paused: consumed.producerPaused === true,
        };
        setRemoteTiles(prev => {
          if (prev.some(t => t.consumerId === c.id)) {return prev;}
          const next = prev.concat(tile);
          patchActiveGroupCall(rid, {remoteTiles: next});
          return next;
        });
        tileRegistered = true;
        // Listener cleanup (inert after leave) — mirrors attemptConsume.
        let listenerCancelled = false;
        const cleanups: Array<() => void> = [() => { listenerCancelled = true; }];
        c.on('trackended', () => {
          if (listenerCancelled) {return;}
          setRemoteTiles(prev => prev.filter(t => t.consumerId !== c.id));
          consumersByPid.current.delete(c.id);
          consumerCleanupsByPid.current.delete(c.id);
          consumedProducerIdsRef.current.delete(p.producerId);
        });
        // See attemptConsume: paused is owned by authoritative producer
        // pause/resume frames, NOT the native 'mute' event (which also fires
        // on a decode stall and would hide+exclude a frozen tile from the
        // freeze watchdog). No mute/unmute → setPaused coupling here either.
        consumerCleanupsByPid.current.set(c.id, cleanups);
        console.log('[bravo.groupcall.resume-reconcile] consumed missed producer tag=', p.participantTag.slice(0, 8), 'kind=', p.kind);
      } catch (e) {
        console.warn('[bravo.groupcall.resume-reconcile] consume failed', p.producerId.slice(0, 8), (e as Error).message);
        if (consumer && !tileRegistered) {
          try { (consumer as Consumer).close(); } catch { /* ignore */ }
          consumersByPid.current.delete((consumer as Consumer).id);
        }
      } finally {
        inFlightConsumes.current.delete(p.producerId);
      }
    }

    // Audit L22 / GC-03 — the restore path arms THIS function (not the full
    // boot reconcileProducers, which is trapped in the boot closure), so it
    // must also do the authoritative VIDEO pause-sync and MY-OWN-producer
    // re-assert. Without this, after a minimize→restore (hardware back =
    // minimize, so the common path) a peer toggling their camera never
    // updated the visible tile — the restore handler doesn't process
    // sfu.producer-paused/-resumed and the add-only consume skipped the sync.
    if (isLeavingRef.current) {return;}
    {
      const videoPause = resp.producers.filter(p => p.kind === 'video' && p.paused !== undefined);
      if (videoPause.length > 0) {
        setRemoteTiles(prev => {
          let next = prev;
          for (const p of videoPause) { next = applyProducerPaused(next, p.producerId, p.paused === true); }
          if (next !== prev) {patchActiveGroupCall(rid, {remoteTiles: next});}
          return next;
        });
      }
    }
    // GC-01 re-assert my own camera state post-restore too.
    // B-101 LC-12/13 — not while a background auto-pause is in force.
    if (intendedVideoPausedRef.current !== null && !isLeavingRef.current
        && !bgAutoPausedVideoRef.current) {
      const myVp = producersRef.current.find(
        p => (p as unknown as {kind?: string; closed?: boolean}).kind === 'video'
          && !(p as unknown as {closed?: boolean}).closed,
      );
      const myPid = (myVp as unknown as {id?: string} | undefined)?.id;
      if (myPid) {
        const snap = resp.producers.find(p => p.producerId === myPid);
        if (snap?.paused !== undefined && snap.paused !== intendedVideoPausedRef.current) {
          const ev = intendedVideoPausedRef.current ? 'sfu.producer.pause' : 'sfu.producer.resume';
          void wsRequest<{ok: true}>(ws, ev, {roomId: rid, producerId: myPid}).catch(() => undefined);
        }
      }
    }
  }, []);

  // Rebuild a wedged remote VIDEO consumer with a fresh decoder. The freeze
  // watchdog escalates here when a keyframe re-request fails to un-stick a
  // stalled tile — the only reliable cure for a jammed hardware H.264 decoder
  // (device-confirmed: Redmi froze the peer's incoming video mid-call and a
  // keyframe alone didn't recover it). Clean teardown mirrors sfu.participant.
  // left (fire cleanups → stop the frozen track → close consumer → drop tile +
  // consumed-set entry), then the reconcile re-consumes the now-missing
  // producer => brand-new consumer + decoder. The ~0.5–1s blank blip while it
  // re-consumes is the accepted trade for keeping camera-release/privacy.
  const rebuildVideoConsumer = useCallback((tag: string): void => {
    if (isLeavingRef.current) {return;}
    // WI-3.7 — room-scoped. The 500 ms stats poll that drives this can outlive
    // the room it was armed for, and a rebuild tears down a live consumer and
    // re-consumes it: doing that against a successor call's room would blank a
    // tile the user is actually watching.
    const ridNow = roomIdRef.current;
    const liveRoom = getActiveGroupCall();
    if (!ridNow || !liveRoom || liveRoom.roomId !== ridNow) {return;}
    const tile = remoteTilesRef.current.find(t => t.participantTag === tag && t.kind === 'video');
    if (!tile) {return;}
    console.log(`[bravo.groupcall.kf] REBUILD video consumer tag=${tag.slice(0,6)} pid=${tile.producerId.slice(0,8)} cid=${tile.consumerId.slice(0,8)}`);
    const cleanups = consumerCleanupsByPid.current.get(tile.consumerId);
    if (cleanups) {
      for (const cb of cleanups) { try { cb(); } catch { /* ignore */ } }
      consumerCleanupsByPid.current.delete(tile.consumerId);
    }
    // Stop the frozen track first so RTCView's last-frame buffer is invalidated.
    try {
      const tr = (tile.stream as unknown as {getTracks?: () => Array<{stop?: () => void}>}).getTracks?.();
      if (Array.isArray(tr)) { for (const x of tr) { try { x.stop?.(); } catch { /* ignore */ } } }
    } catch { /* ignore */ }
    const c = consumersByPid.current.get(tile.consumerId);
    if (c) { try { c.close(); } catch { /* ignore */ } consumersByPid.current.delete(tile.consumerId); }
    inFlightConsumes.current.delete(tile.producerId);
    consumedProducerIdsRef.current.delete(tile.producerId);
    setRemoteTiles(prev => {
      const next = prev.filter(t => t.consumerId !== tile.consumerId);
      patchActiveGroupCall(roomIdRef.current, {remoteTiles: next});
      return next;
    });
    // Re-consume the now-missing producer → FRESH decoder. reconcileProducersRef
    // is the boot/restore reconcile (snapshot fetch + SFrame-attached consume).
    void (reconcileProducersRef.current?.() ?? consumeMissingAfterRestore());
  }, [consumeMissingAfterRestore]);
  useEffect(() => { rebuildVideoConsumerRef.current = rebuildVideoConsumer; }, [rebuildVideoConsumer]);

  // ── Producer reconcile tick ───────────────────────────────
  // BS-MEDIA — periodically reconcile our consumers against the SFU's
  // authoritative producer list so a missed sfu.new-producer frame or a
  // retry-exhausted consume self-heals within a few seconds instead of
  // leaving a participant permanently tile-less (the "one device sees
  // everyone, another sees only some" report). 4s is invisible WS
  // traffic and well under the threshold where a missing tile is
  // annoying. Only runs while joined; reconcileProducers self-guards on
  // leaving/cancelled.
  useEffect(() => {
    if (state !== 'joined') {return;}
    // Kick once immediately on entering 'joined' (and on the 'reconnecting'
    // → 'joined' transition after an ICE restart, which is exactly when a
    // producer announced mid-blip may have been missed).
    // WI-3.2 — never reconcile onto a room a rejoin is mid-rebuild on: the
    // snapshot it diffs against was taken from transports the rejoin has
    // already closed, so it re-inserts tiles the rejoin just cleared.
    if (!isAttemptRunning(roomIdRef.current ?? '')) {
      void reconcileProducersRef.current?.();
    }
    const interval = setInterval(() => {
      if (isAttemptRunning(roomIdRef.current ?? '')) {return;}
      void reconcileProducersRef.current?.();
    }, 4000);
    return () => { clearInterval(interval); };
  }, [state]);

  // ── SFU WebSocket keepalive ────────────────────────────────
  // B-14 — the SFU WS idle-closed mid-call (~3min in), and because the
  // close happened silently the next `sfu.transport.restartIce` fired
  // over a dead socket and `ack_timeout`'d → call stuck in 'failed'.
  // While a call is live (joining/joined/reconnecting) send a lightweight
  // app-level `ping` every 20s. The server already answers it (`pong`).
  // Two wins: (1) regular app-level traffic keeps idle-timeout
  // intermediaries (proxy/LB/NAT) from reaping the connection, and (2) a
  // rejected ping surfaces a dead WS promptly so socket.io's auto-reconnect
  // kicks in BEFORE ICE drops — giving restartTransport an open socket to
  // recover over. Best-effort: a failed ping just logs; the transport
  // layer owns the actual reconnect.
  useEffect(() => {
    if (state !== 'joining' && state !== 'joined' && state !== 'reconnecting') {return;}
    const ws = transportRef.current;
    if (!ws) {return;}
    // Only warn after TWO consecutive misses. A single slow ack is expected
    // right after the app resumes from background — the WS is still finishing
    // its socket.io reconnect handshake, so the round-trip can briefly exceed
    // the ack window. Logging "ping failed" on that first miss was a false
    // alarm (seen in field logs as a lone `ack_timeout:ping` after wake).
    let consecutiveMisses = 0;
    const interval = setInterval(() => {
      // Don't add load while the socket is already known-down; socket.io is
      // reconnecting and the ack would just time out.
      if ((ws as unknown as {state?: string}).state !== 'connected') {return;}
      // 10s ack window — generous enough to ride out a just-resumed socket
      // without false-failing, still well under the 20s keepalive cadence.
      void ws.emitWithAck('ping', {ts: Date.now()}, 10_000)
        .then(() => { consecutiveMisses = 0; })
        .catch((e: unknown) => {
          consecutiveMisses += 1;
          if (consecutiveMisses >= 2) {
            console.warn(`[bravo.groupcall] keepalive ping failed x${consecutiveMisses}:`, (e as Error).message);
          }
        });
    }, 20_000);
    return () => { clearInterval(interval); };
  }, [state]);

  // Mirror audioLevels into the registry so the FloatingCallOverlay
  // (mounted globally, NOT inside this hook's tree) can compute the
  // active speaker on minimize. Without this the overlay would always
  // show the same first-tile, never tracking who's actually talking
  // right now. Patches only when the registry exists for this roomId
  // — guards against late writes after a fresh call replaced ours.
  // Round 4 / Perf audit: ONE coalesced mirror effect for
  // audioLevels + identityByTag + remoteTiles. The previous three
  // separate effects each called patchActiveGroupCall on every
  // dependency change — and audioLevels mutates ~2 Hz from the stats
  // poll — so the registry's listener Set was notified three separate
  // times per audio tick even when nothing the overlay cared about
  // had actually changed.
  //
  // Gate the mirror on `isMinimized` per the perf audit: the ONLY
  // consumer of these registry fields is the FloatingCallOverlay,
  // which by definition only renders when the call is minimized.
  // GroupCallScreen reads straight off the hook (no registry round-
  // trip needed), so mirroring while the screen is foreground is
  // pure waste.
  //
  // Two effects make this work:
  //   (a) Subscribe to registry.isMinimized so we can flip a local
  //       `mirrorActive` flag — when minimize toggles ON we mirror
  //       the CURRENT state once to seed the overlay; thereafter the
  //       per-tick mirror below keeps it fresh.
  //   (b) Per-tick mirror that fires when audioLevels / identityByTag
  //       / remoteTiles change AND mirrorActive is true.
  const [mirrorActive, setMirrorActive] = useState(false);
  useEffect(() => {
    return onActiveGroupCallChange(s => {
      const next = !!(s && s.roomId === roomId && s.isMinimized);
      setMirrorActive(prev => prev === next ? prev : next);
    });
  }, [roomId]);
  useEffect(() => {
    if (!mirrorActive) {return;}
    if (state !== 'joined') {return;}
    const live = getActiveGroupCall();
    if (!live || live.roomId !== roomId) {return;}
    patchActiveGroupCall(roomId, {audioLevels, identityByTag, remoteTiles});
  }, [mirrorActive, audioLevels, identityByTag, remoteTiles, state, roomId]);

  // ── Controls ────────────────────────────────────────────
  // CALL-24 — generation guard for the audio-producer pause/resume sync:
  // each mute toggle bumps this so a stale retry from an earlier toggle
  // aborts and the most-recent mute state always wins on the SFU.
  const muteToggleGenRef = useRef(0);
  const toggleMuteInternal = useCallback(() => {
    const t = audioTrackRef.current;
    if (!t) {return;}
    t.enabled = !t.enabled;
    const muted = !t.enabled;
    setIsMuted(muted);
    patchActiveGroupCall(roomIdRef.current, {isMuted: muted});
    console.log(`[bravo.groupcall.ctl] toggleMute → muted=${muted}`);
    // CALL-24 — track.enabled only silences the LOCAL capture; peers get
    // no signal, so a muted participant looked live on every remote tile.
    // Mirror the camera-toggle path: pause/resume the AUDIO producer on
    // the SFU, whose sfu.producer-paused/-resumed broadcast flips the
    // remote tiles' paused flag (mic-off glyph in GroupCallScreen).
    const ws  = transportRef.current;
    const rid = roomIdRef.current;
    const ap  = producersRef.current.find(
      p => (p as unknown as {kind?: string; closed?: boolean}).kind === 'audio'
        && !(p as unknown as {closed?: boolean}).closed,
    );
    const pid = (ap as unknown as {id?: string} | undefined)?.id;
    if (ws && rid && pid) {
      const myGen = ++muteToggleGenRef.current;
      const event = muted ? 'sfu.producer.pause' : 'sfu.producer.resume';
      void (async () => {
        // Same lost-under-WS-congestion rationale as syncSfuPaused in
        // toggleVideo: retry a few times, but only while THIS toggle is
        // still the latest so an old pause can't land after an unmute.
        for (let attempt = 0; attempt < 4; attempt++) {
          if (myGen !== muteToggleGenRef.current || isLeavingRef.current) {return;}
          try {
            await wsRequest<{ok: true}>(ws, event, {roomId: rid, producerId: pid});
            return;
          } catch (e) {
            if (attempt === 3) {
              console.log(`[bravo.groupcall.ctl] mute ${event} signal gave up:`, (e as Error).message);
              return;
            }
            await new Promise(r => setTimeout(r, 350 * (attempt + 1)));
          }
        }
      })();
    }
  }, []);

  // BS-VIDEO-TOGGLE — re-entrancy guard. toggleVideo is async (getUserMedia
  // + replaceTrack/produce); without this a rapid double-tap double-acquires
  // the camera (two producers) and a later OFF only stops one.
  const togglingVideoRef = useRef(false);
  // Generation guard for the SFU pause/resume sync inside toggleVideo: each
  // toggle bumps this so a stale retry from an earlier toggle aborts and the
  // most-recent camera state always wins (no off/on race on the SFU).
  const videoToggleGenRef = useRef(0);
  // Audit GC-01 — my INTENDED camera pause state (true=off, false=on, null=no
  // video producer yet). Camera state is a STATE, not a fire-once signal: the
  // reconcile tick compares this to the authoritative sfu.producers snapshot
  // for my own producer and re-asserts pause/resume if they diverge (e.g. all
  // toggle retries failed, or a silent WS reconnect dropped my SFU tag). This
  // is what converges peers onto the right state and stops the receiver-side
  // keyframe/consumer-rebuild churn (GC-02) after a lost pause.
  const intendedVideoPausedRef = useRef<boolean | null>(null);
  // Force a fresh keyframe on EVERY remote video consumer. Fired right after a
  // local camera toggle: on single-hardware-codec phones (Redmi & most mid-
  // range Androids) re-acquiring / releasing the camera encoder contends with
  // the H.264 DECODER and starves the INCOMING remote video of a reference
  // frame — the remote tile then freezes on its last frame and never recovers
  // until a natural IDR, which on a 3-layer simulcast stream can be many
  // seconds out (device trace: peer's video froze the instant THIS device
  // toggled its own camera). Re-issuing sfu.consumer.resume drives the server's
  // requestKeyFrame so each decoder re-syncs in ~200ms. Reuses the tested
  // resume path; fire-and-forget + leave-guarded. (Emulators use a software
  // codec and never hit this, which is why it only repro'd on the phone.)
  const refreshRemoteVideoKeyframes = useCallback((reason: string): void => {
    if (isLeavingRef.current) {return;}
    const ws  = transportRef.current;
    const rid = roomIdRef.current;
    if (!ws || !rid) {return;}
    for (const tile of remoteTilesRef.current) {
      if (tile.kind !== 'video') {continue;}
      // Skip offscreen-paused tiles — the blanket resume would silently
      // undo the bandwidth pause; they get their keyframe from the
      // resume that fires when their page scrolls back into view.
      if (hiddenVideoTagsRef.current.has(tile.participantTag)) {continue;}
      void wsRequest<{ok: true}>(ws, 'sfu.consumer.resume', {roomId: rid, consumerId: tile.consumerId})
        .then(() => console.log(`[bravo.groupcall.kf] ${reason} refresh tag=${tile.participantTag.slice(0,6)}`))
        .catch(() => { /* best-effort — the 3s stall self-heal is the backstop */ });
    }
  }, []);
  // Blanket the codec-contention window after a toggle with a few spaced
  // keyframe pulls (the freeze lands ~1–2s in, so a single immediate pull can
  // miss it). Cheap: each is one sfu.consumer.resume per remote video tile.
  const scheduleKeyframeRefresh = useCallback((reason: string): void => {
    for (const delay of [400, 1200, 2200]) {
      setTimeout(() => refreshRemoteVideoKeyframes(reason), delay);
    }
  }, [refreshRemoteVideoKeyframes]);
  const toggleVideo = useCallback(async () => {
    if (togglingVideoRef.current) {
      console.log('[bravo.groupcall.ctl] toggleVideo ignored — toggle already in progress');
      return;
    }
    togglingVideoRef.current = true;
    // Bump the toggle generation so any in-flight SFU sync retry from a
    // previous toggle aborts — the most-recent camera state must win.
    const myGen = ++videoToggleGenRef.current;
    // Reliable SFU producer pause/resume. The single fire-and-forget signal
    // was lost under WS congestion (rapid toggles → ack_timeout), leaving the
    // SFU on the WRONG state: peers kept the frozen last frame after OFF, and
    // saw no video after ON. Retry a few times, but only while THIS toggle is
    // still the latest (the gen guard) so an OFF retry can't land after an ON.
    const syncSfuPaused = async (
      ws: TransportClient, roomIdArg: string, producerId: string, paused: boolean,
    ): Promise<void> => {
      const event = paused ? 'sfu.producer.pause' : 'sfu.producer.resume';
      // Audit GC-01 — record the intended state so the reconcile tick can
      // durably re-assert it if every attempt below fails.
      intendedVideoPausedRef.current = paused;
      for (let attempt = 0; attempt < 4; attempt++) {
        if (myGen !== videoToggleGenRef.current) {return;}
        if (isLeavingRef.current) {return;}   // don't retry into a torn-down call
        try {
          await wsRequest<{ok: true}>(ws, event, {roomId: roomIdArg, producerId});
          return; // SFU acked — peers now see the correct camera state
        } catch (e) {
          if (attempt === 3) {
            // Give up the fast path; the reconcile tick re-asserts from
            // intendedVideoPausedRef on the next poll until the SFU agrees.
            console.log(`[bravo.groupcall.ctl] producer ${paused ? 'pause' : 'resume'} signal gave up (reconcile will re-assert):`, (e as Error).message);
            return;
          }
          await new Promise(r => setTimeout(r, 350 * (attempt + 1)));
        }
      }
    };
    try {
      // ── OFF — release the camera but KEEP the producer ──────────────
      // Stop the capturer (powers the camera + privacy LED down) and PAUSE
      // (not close) the mediasoup producer, so its RTPSender + SFrame
      // transform + simulcast encodings all survive. Re-enabling is then an
      // instant, reliable `replaceTrack` (below). The previous build CLOSED
      // the producer, forcing ON down a fragile full re-produce + re-attach
      // path that failed — the camera "stayed off forever". OFF must work
      // even without the send transport, so its guard lives on the ON path.
      if (videoTrackRef.current) {
        const t = videoTrackRef.current;
        const vp = producersRef.current.find(
          p => (p as unknown as {kind?: string; closed?: boolean}).kind === 'video'
            && !(p as unknown as {closed?: boolean}).closed,
        );
        const wsToggle  = transportRef.current;
        const ridToggle = roomIdRef.current;
        const pidToggle = (vp as unknown as {id?: string} | undefined)?.id;
        if (wsToggle && ridToggle && pidToggle) {
          void syncSfuPaused(wsToggle, ridToggle, pidToggle, true);
        }
        try { (vp as unknown as {pause?: () => void})?.pause?.(); } catch { /* ignore */ }
        try { t.stop(); } catch { /* ignore */ }   // releases the camera + LED
        videoTrackRef.current = null;
        const rebuilt = new MediaStream(
          audioTrackRef.current ? [audioTrackRef.current] : [],
        );
        setLocalStream(rebuilt);
        setIsVideoOff(true);
        patchActiveGroupCall(ridToggle, {localStream: rebuilt, videoTrack: null, isVideoOff: true});
        console.log('[bravo.groupcall.ctl] toggleVideo OFF — camera released (producer paused)');
        // Stopping the local camera releases the hardware encoder, which on a
        // single-codec phone briefly knocks out the INCOMING video decoder —
        // re-sync every remote tile so a peer's video doesn't freeze on us.
        scheduleKeyframeRefresh('post-off');
        return;
      }

      // ── ON — (re)acquire the camera ─────────────────────────────────
      let newTrack: MediaStreamTrack | null = null;
      try {
        const facing = isFrontCameraRef.current ? 'user' : 'environment';
        const fresh = await mediaDevices.getUserMedia({audio: false, video: localVideoConstraints(facing)});
        newTrack = fresh.getVideoTracks()[0] ?? null;
      } catch (e) {
        console.warn('[bravo.groupcall.ctl] toggleVideo getUserMedia failed:', (e as Error).message);
        try { useMessengerStore.getState().setError('Camera unavailable — check permissions'); } catch { /* ignore */ }
        return;
      }
      if (!newTrack) {
        try { useMessengerStore.getState().setError('Camera unavailable'); } catch { /* ignore */ }
        return;
      }

      // RE-ENABLE an existing (paused) producer via replaceTrack. The
      // RTPSender's SFrame transform + simulcast encodings persist, so frames
      // stay encrypted with NO re-attach — the proven recoverGroupCamera path
      // and the reliable fix for "video won't turn back on".
      const existingVp = producersRef.current.find(
        p => (p as unknown as {kind?: string; closed?: boolean}).kind === 'video'
          && !(p as unknown as {closed?: boolean}).closed,
      );
      if (existingVp) {
        try {
          await (existingVp as unknown as {replaceTrack: (o: {track: unknown}) => Promise<void>})
            .replaceTrack({track: newTrack});
          try { (existingVp as unknown as {resume?: () => void}).resume?.(); } catch { /* ignore */ }
          const wsR  = transportRef.current;
          const ridR = roomIdRef.current;
          const pidR = (existingVp as unknown as {id?: string}).id;
          if (wsR && ridR && pidR) {
            void syncSfuPaused(wsR, ridR, pidR, false);
          }
          videoTrackRef.current = newTrack;
          const rebuilt = new MediaStream(
            audioTrackRef.current ? [audioTrackRef.current, newTrack] : [newTrack],
          );
          setLocalStream(rebuilt);
          setIsVideoOff(false);
          patchActiveGroupCall(ridR, {localStream: rebuilt, videoTrack: newTrack, isVideoOff: false});
          console.log('[bravo.groupcall.ctl] toggleVideo ON — camera re-acquired (replaceTrack)');
          // Re-acquiring the camera (new encoder session) is the exact moment
          // the incoming decoder stalls on a single-codec phone — re-sync every
          // remote tile so peers' video doesn't freeze when WE turn ours on.
          //
          // Best-effort, same reason as the first-video path below: the track
          // is already swapped in and publishing, so a failure here is a
          // quality nicety, not a camera failure. Inside the outer catch it
          // reported "Could not turn the camera back on" over a live camera
          // and stopped the track.
          try {
            scheduleKeyframeRefresh('post-on');
          } catch (e) {
            console.warn('[bravo.groupcall.ctl] post-on keyframe refresh failed (camera is live):', (e as Error).message);
          }
        } catch (e) {
          console.warn('[bravo.groupcall.ctl] toggleVideo replaceTrack failed:', (e as Error).message);
          try { newTrack.stop(); } catch { /* ignore */ }
          try { useMessengerStore.getState().setError('Could not turn the camera back on'); } catch { /* ignore */ }
        }
        return;
      }

      // FIRST video (audio-only call → video upgrade): no producer yet, so
      // produce fresh WITH the boot simulcast ladder + SFrame attach (same
      // no-plaintext refusal contract as boot). Needs the send transport.
      const sendTx = sendTxRef.current;
      if (!sendTx) {
        // The call hasn't built its send transport yet — it's still
        // connecting or stuck waiting for the group key (e.g. a mission Ops
        // Room whose owner is offline). DON'T abandon the camera: show it as
        // a LOCAL PREVIEW so the toggle always works visually. The boot's
        // video-produce picks up videoTrackRef.current once the call goes
        // live (peers see it then). This is the fix for "toggle off works
        // but toggle on shows nothing" on a not-yet-connected call.
        console.log('[bravo.groupcall.ctl] toggleVideo ON — local preview only (call not yet connected)');
        videoTrackRef.current = newTrack;
        const lsPv = localStream;
        const rebuiltPv = new MediaStream(
          lsPv ? [...lsPv.getTracks().filter(x => x.kind === 'audio'), newTrack] : [newTrack],
        );
        setLocalStream(rebuiltPv);
        setIsVideoOff(false);
        patchActiveGroupCall(roomIdRef.current, {localStream: rebuiltPv, videoTrack: newTrack, isVideoOff: false});
        return;
      }
      const t0 = newTrack;
      try {
        // GC-06 — blank the track for the produce→attach window (every
        // failure path below stops the track, so only the success path
        // needs the restore after the cryptor is live).
        const t0Enabled = t0 as unknown as {enabled: boolean};
        t0Enabled.enabled = false;
        const producer = await sendTx.produce({
          track: t0 as never,
          // B-121 — MUST match the boot path. Hardcoding simulcast here meant
          // an iOS camera off->on mid-call silently reintroduced the bug.
          encodings: videoEncodings(),
          codecOptions: {videoGoogleStartBitrate: 200},
        } as never);
        const enc = groupEncryptionRef.current;
        const rtpSender = (producer as unknown as {rtpSender?: {id: string}}).rtpSender;
        if (!enc || !rtpSender) {
          console.warn('[bravo.groupcall.ctl] toggleVideo refusing — no SFrame encryptor/rtpSender; closing producer');
          try { producer.close(); } catch { /* ignore */ }
          try { t0.stop(); } catch { /* ignore */ }
          armVideoEncryptorRetry({
            hasEncryptor: () => !!groupEncryptionRef.current,
            subscribe:    (cb) => useMessengerStore.subscribe(() => cb()),
            isCancelled:  () => isLeavingRef.current,
            notify:       (m) => { try { useMessengerStore.getState().setError(m); } catch { /* ignore */ } },
            retry:        () => { void toggleVideoRef.current?.(); },
            isArmed:      () => videoRetryArmedRef.current,
            setArmed:     (v) => { videoRetryArmedRef.current = v; },
          });
          return;
        }
        try {
          const detach = await enc.attachSenderCryptor(
            rtpSender,
            (sendTx as unknown as {handler?: {_pc?: unknown}}).handler?._pc,
            'video',
          );
          sframeDetachersRef.current.push(detach);
          console.log('[bravo.groupcall.sframe] mid-call video producer attached (FrameCryptor)');
        } catch (e) {
          console.warn('[bravo.groupcall.sframe] mid-call video attach FAILED — refusing:', (e as Error).message);
          try { producer.close(); } catch { /* ignore */ }
          try { t0.stop(); } catch { /* ignore */ }
          return;
        }
        t0Enabled.enabled = true;   // GC-06 — cryptor live, unblank
        producersRef.current.push(producer);
        clearBlankedPauseLatch(producer);
        videoTrackRef.current = t0;
        const ls = localStream;
        const rebuilt = new MediaStream(
          ls ? [...ls.getTracks().filter(x => x.kind === 'audio'), t0] : [t0],
        );
        setLocalStream(rebuilt);
        setIsVideoOff(false);
        patchActiveGroupCall(roomIdRef.current, {localStream: rebuilt, videoTrack: t0, isVideoOff: false});
        console.log('[bravo.groupcall.ctl] toggleVideo ON — first video (new producer)');
        // PAST THE POINT OF NO RETURN. The producer is live and the cryptor is
        // attached, so the camera IS on and peers can already see it. The
        // keyframe refresh is a quality nicety; letting it fall into the catch
        // below reported "Could not turn the camera on" over a working camera
        // AND stopped the track — a red banner while the other side was
        // watching the video perfectly well. Best-effort from here.
        try {
          scheduleKeyframeRefresh('post-first-video');
        } catch (e) {
          console.warn('[bravo.groupcall.ctl] post-video keyframe refresh failed (camera is live):', (e as Error).message);
        }
      } catch (e) {
        console.warn('[bravo.groupcall.ctl] toggleVideo enable failed:', (e as Error).message);
        try { t0.stop(); } catch { /* ignore */ }
        try { useMessengerStore.getState().setError('Could not turn the camera on'); } catch { /* ignore */ }
      }
    } finally {
      togglingVideoRef.current = false;
    }
  }, [localStream, scheduleKeyframeRefresh]);

  // Flip front ↔ back camera.
  //
  // B-123: this used the non-standard `track._switchCamera()`, which looked
  // ideal (same track identity → producer + FrameCryptor untouched) but is a
  // NO-OP on both platforms in the current react-native-webrtc. It is
  // deprecated and now just calls applyConstraints({facingMode}), and neither
  // capture controller honours a facing change:
  //   iOS   VideoCaptureController.applyConstraints reads only width/height/
  //         frameRate — facingMode is never examined.
  //   Android CameraCaptureController.applyConstraints deliberately reuses the
  //         INITIAL constraintFacingMode ("it is a constraint violation to
  //         change these through applyConstraints").
  // There is also no native switchCamera exported to JS on iOS.
  //
  // So acquire a fresh track at the opposite facing and replaceTrack it onto
  // the EXISTING producer — the same mechanism 1:1 calls already use, and the
  // one recoverGroupCamera is built on. replaceTrack keeps the SAME
  // RTCRtpSender, so the SFrame transform stays attached and video is never
  // sent in the clear. Do NOT close + recreate the producer instead: that
  // requires re-attaching the encryptor and opens a plaintext-video window.
  //
  // Returns false when there's no live video track (audio call, or camera
  // off) so the UI can no-op cleanly.
  const switchCamera = useCallback(async (): Promise<boolean> => {
    const track = videoTrackRef.current;
    if (!track?.enabled) {
      console.log('[bravo.groupcall.ctl] switchCamera skipped — no live video track');
      return false;
    }
    // Shared with the resume-path recovery: both replace the video track, and
    // running them concurrently would race two getUserMedia acquisitions onto
    // one producer.
    if (recoveringCameraRef.current) {
      console.log('[bravo.groupcall.ctl] switchCamera skipped — camera swap already in flight');
      return false;
    }
    const vp = producersRef.current.find(
      p => (p as unknown as {kind?: string; closed?: boolean}).kind === 'video'
        && !(p as unknown as {closed?: boolean}).closed,
    );
    if (!vp) {
      console.warn('[bravo.groupcall.ctl] switchCamera — no live video producer');
      return false;
    }
    recoveringCameraRef.current = true;
    try {
      const next = isFrontCameraRef.current ? 'environment' : 'user';
      const replaced = await recoverGroupCamera({
        producer:     vp as never,
        facing:       next,
        currentTrack: track,
      });
      if (!replaced) {
        console.warn('[bravo.groupcall.ctl] switchCamera — acquisition returned no track');
        return false;
      }
      videoTrackRef.current = replaced;
      const audio = audioTrackRef.current;
      const rebuilt = new MediaStream(audio ? [audio, replaced] : [replaced]);
      setLocalStream(rebuilt);
      try {
        patchActiveGroupCall(roomIdRef.current, {localStream: rebuilt, videoTrack: replaced});
      } catch { /* best-effort registry refresh */ }
      if (DECODE_DIAG) {
        // Survives the production console-strip; pairs with the SELF=enc/B
        // counters so a dead post-flip producer is attributable.
        const st = (replaced as unknown as {readyState?: string}).readyState;
        const en = (replaced as unknown as {enabled?: boolean}).enabled;
        crashLog(`[bravo.groupcall.ctl] switchCamera swapped to=${next} newTrack=${String(st)}/enabled=${String(en)}`);
      }
      // Only after the swap actually landed — a failed flip must not leave the
      // mirror-image PiP lying about which lens is live.
      setIsFrontCamera(prev => !prev);
      console.log(`[bravo.groupcall.ctl] switchCamera → flipped to ${next}`);
      return true;
    } catch (e) {
      console.warn('[bravo.groupcall.ctl] switchCamera failed:', (e as Error).message);
      return false;
    } finally {
      recoveringCameraRef.current = false;
    }
  }, []);

  // Tags this host has force-muted. The server already supported the
  // inverse from the start — sfu.mute-target takes {unmute:true} and emits
  // sfu.unmuted, which the receive side below has always handled — but the
  // client never sent it, so a host could silence someone with no way to give
  // them their mic back. Tracked here because only the host knows who IT
  // muted: a participant muting themselves is not the host's to undo.
  const [hostMutedTags, setHostMutedTags] = useState<string[]>([]);

  const muteParticipant = useCallback(async (tag: string, unmute = false) => {
    const ws = transportRef.current;
    if (!ws || !roomId) {return;}
    try {
      await wsRequest<{ok: true}>(ws, 'sfu.mute-target', {roomId, targetTag: tag, unmute});
      setHostMutedTags(prev => unmute ? prev.filter(t => t !== tag) : (prev.includes(tag) ? prev : [...prev, tag]));
    } catch (e) {
      console.warn(`[useGroupCall] ${unmute ? 'un' : ''}mute-target failed:`, (e as Error).message);
    }
  }, [roomId]);

  const inviteUsers = useCallback(async (userIds: string[]) => {
    const ws = transportRef.current;
    // B-299 — "nothing was asked for" and "we could not ask" are different
    // outcomes and must not share an exit. GroupCallScreen's `handleInvite`
    // sets an optimistic 30s "Ringing…" countdown and clears it ONLY from its
    // catch, so a silent `return` here left the host watching a countdown for
    // a ring that was never sent — with no error anywhere. The window that hits
    // it is real and common: right after an escalation the host lands on a
    // fresh GroupCallScreen whose `roomId` is still being assigned.
    if (userIds.length === 0) {return;}
    if (!ws || !roomId) {
      throw new Error('Call is still connecting — try adding again in a moment.');
    }
    // Retry once on `peer_offline` — the server fires a VoIP push
    // notification when the recipient isn't currently connected, but
    // there's a 1-3s window where their socket is reconnecting (e.g.
    // they just woke their phone) during which the ring lands as
    // peer_offline despite them being moments-from-online. Without
    // this retry, the host's "Add Call" reports failure and the user
    // taps Add again manually. Server is idempotent on `sfu.ring`
    // (push collapseKey ensures only ONE ring lands on the device
    // even if we hit it twice), so a duplicate is safe.
    // B-300 — KEY THE INVITEE BEFORE RINGING THEM.
    //
    // This used to send `sfu.ring` and nothing else. Both `ensureCallGroupKey`
    // call sites (the host boot at step=3a and the owner join-resync) pass
    // `opts.recipientUserIds` — the list captured at screen MOUNT — so someone
    // added mid-call was never in it and the group master key never reached
    // them. They accepted, joined, waited out `waitForGroupCallKey` and failed
    // closed. On an ESCALATED (ad-hoc) call every heal path is closed to them
    // too: their own `requestGroupKeyResync` targets the reused 1:1
    // conversation they are not a member of, and the owner's join-resync is
    // gated on `isRealNamedGroup`, which an ad-hoc `name === 'Call'` state is
    // not. So they could never join at all.
    //
    // ARCHITECTURE_AMENDMENT_SFRAME: keys are "distributed via pairwise Signal
    // sessions", and "group master key rotation on member-add … triggers a
    // frame-cryptor key rotation in the same epoch". Member-add is REQUIRED to
    // distribute; the absence was the deviation.
    //
    // `ensureCallGroupKey` already does the right thing once it is handed the
    // wider roster: its resync branch is guarded by
    // `others.every(uid => !!mapped.members[uid])`, so a roster containing
    // someone outside the minted state falls through to a FRESH MINT covering
    // everyone — the rotation the amendment asks for.
    //
    // Order matters: ringing first only shrinks the race, and a keying failure
    // must ABORT the invite rather than summon someone who cannot join. The
    // throw reaches `handleInvite`'s catch (B-299), which clears the optimistic
    // countdown and tells the host. Nothing here relaxes the fail-closed join
    // gate — an invitee who still ends up without a key still gets no media.
    try {
      const rt = await getMessengerRuntime();
      if (rt.ensureCallGroupKey) {
        await rt.ensureCallGroupKey({
          conversationId:   opts.conversationId,
          recipientUserIds: Array.from(new Set([...opts.recipientUserIds, ...userIds])),
        });
      }
    } catch (e) {
      console.warn('[bravo.groupcall.invite] keying failed — NOT ringing:', (e as Error).message);
      throw new Error('Could not share the call key with that person. They were not added.');
    }
    const attemptRing = async (): Promise<void> => {
      const ringAck = await wsRequest<{ok: true; ringId?: string}>(ws, 'sfu.ring', {
        roomId,
        conversationId:   opts.conversationId,
        callType:         opts.callType,
        callerName:       opts.callerName,
        recipientUserIds: userIds,
      });
      // WI-6.7 — record this fan-out; see mintedRingIdsRef.
      if (ringAck?.ringId) {mintedRingIdsRef.current.add(ringAck.ringId);}
      for (const u of userIds) {rungUsersRef.current.add(u);} // KO-7
    };
    try {
      await attemptRing();
      // AC-6 — warn, not log: the invite trail must survive release builds.
      console.warn('[CALLDIAG] [ring.send] invite ring ok room=', roomId.slice(0, 8), 'invitees=', userIds.length);
    } catch (e) {
      const msg = (e as Error).message ?? '';
      if (msg.includes('peer_offline') || msg.includes('not_connected')) {
        console.warn('[bravo.groupcall.invite] peer_offline — retrying once after 1.5s');
        await new Promise(r => setTimeout(r, 1500));
        try {
          await attemptRing();
          console.log('[bravo.groupcall.invite] retry succeeded');
          return;
        } catch (retryErr) {
          console.warn('[bravo.groupcall.invite] retry failed:', (retryErr as Error).message);
          throw retryErr;
        }
      }
      console.warn('[bravo.groupcall.invite] failed:', msg);
      throw e;
    }
    // B-300 — `opts.recipientUserIds` is now read here (the key roster), so it
    // belongs in the deps: a stale closure would key the OLD roster and strand
    // exactly the invitee this fix exists to reach.
  }, [roomId, opts.conversationId, opts.callType, opts.callerName, opts.recipientUserIds]);

  /**
   * Host-initiated re-ring. Tap from the per-recipient pill when the
   * 30s ring window has expired and the recipient still hasn't joined.
   * Bumps `ringStartedAt` so the UI flips back to a fresh "Re-ringing"
   * status, and marks the user in `reRungUserIds` so the pill label
   * reads "Re-ringing" instead of the initial "Ringing".
   */
  const reRing = useCallback(async (userIds: string[]) => {
    const ws = transportRef.current;
    if (!ws || !roomId || userIds.length === 0) {return;}
    try {
      const ringAck = await wsRequest<{ok: true; ringId?: string}>(ws, 'sfu.ring', {
        roomId,
        conversationId:   opts.conversationId,
        callType:         opts.callType,
        callerName:       opts.callerName,
        recipientUserIds: userIds,
      });
      // WI-6.7 — record this fan-out; see mintedRingIdsRef.
      if (ringAck?.ringId) {mintedRingIdsRef.current.add(ringAck.ringId);}
      for (const u of userIds) {rungUsersRef.current.add(u);} // KO-7
      setRingStartedAt(Date.now());
      setReRungUserIds(prev => {
        const next = new Set(prev);
        for (const u of userIds) {next.add(u);}
        return next;
      });
      console.log('[bravo.groupcall.rering] sent to', userIds.length, 'user(s)');
    } catch (e) {
      console.warn('[bravo.groupcall.rering] failed:', (e as Error).message);
      throw e;
    }
  }, [roomId, opts.conversationId, opts.callType, opts.callerName]);

  const kickParticipant = useCallback(async (tag: string) => {
    const ws = transportRef.current;
    if (!ws || !roomId) {return;}
    try {
      await wsRequest<{ok: true}>(ws, 'sfu.kick', {roomId, targetTag: tag});
      // The server-side leaveRoom fires participant.left to peers, so
      // our remoteTiles will drop the kicked tile via the dispatcher
      // path — no need to mutate here.
    } catch (e) {
      console.warn('[useGroupCall] kick failed:', (e as Error).message);
    }
  }, [roomId]);

  // B-342 — the ONE place the sfu.ring.cancel frame is built. Two callers:
  // leaveInternal (host hangs up mid-ring) and the boot's outer catch (boot
  // fails AFTER the step-3c early ring — reachable since the ring moved
  // ahead of Device/transports/produce; recipients must not keep ringing at
  // a dead room). One builder, not a copy per site — the payload drifting
  // between copies is this repo's most-repeated bug shape.
  const sendRingCancelFrame = useCallback((
    wsArg: TransportClient,
    ridArg: string,
    stillRinging: string[],
  ): void => {
    void wsRequest<{ok: true}>(wsArg, 'sfu.ring.cancel', {
      roomId:           ridArg,
      conversationId:   opts.conversationId,
      recipientUserIds: stillRinging,
      // Audit row #5 (C2) — host's self-token (minted at POST /sfu/rooms).
      // Gateway rejects cancels from non-hosts and (when secret is set)
      // requires this token.
      roomToken:        roomTokenRef.current,
      // WI-6.7 — name the fan-out being withdrawn ONLY when this call minted
      // exactly one (see mintedRingIdsRef): both cancel callers are
      // cancel-ALLs, and naming one ring of several leaves the other
      // fan-out's recipients ringing a withdrawn call. Zero (old relay /
      // ack in flight) or many → unscoped room-wide cancel.
      ringId:           mintedRingIdsRef.current.size === 1
        ? Array.from(mintedRingIdsRef.current)[0]
        : undefined,
    }).catch(() => { /* best-effort — recipients time out at 30s */ });
  }, [opts.conversationId]);

  const leaveInternal = useCallback(async () => {
    // Idempotent — multiple paths can call this (BackHandler, End btn,
    // overlay End, peer-leave-and-room-empty). Only the first run does
    // real work; subsequent calls are silent no-ops.
    if (isLeavingRef.current) {return;}
    isLeavingRef.current = true;
    // Review GC-2/F5 — the rejoin hub outlives the screen by design, so
    // the boot effect's cleanup is NOT a reliable place to retire it: a
    // call restored from the bubble takes the restore branch and never
    // reaches that cleanup. Clearing it here covers every real ending
    // (End button, peer/host end, kick, error teardown), which all
    // funnel through leaveInternal.
    // WI-3.3 — but ONLY this instance's handler. leaveInternal is fired
    // un-awaited for a STALE instance by launchCall's `void staleLeave()`
    // and by endActiveGroupCall, both of which run while the next call is
    // already booting; the unconditional clear retired the new call's
    // handler and left it with no WS-reopen recovery for its whole life.
    releaseGroupCallRejoinHandler(rejoinTokenRef.current);
    rejoinTokenRef.current = null;
    // B-37 — flip to a TERMINAL state IMMEDIATELY, BEFORE the synchronous
    // producer/consumer/transport/stream teardown below. Leaving call.state
    // at 'joined' during teardown let GroupCallScreen's animated, clipping
    // tile grid keep re-rendering while native views were being detached,
    // and Fabric crashed with "The specified child already has a parent"
    // (addViewAt). Flipping terminal first lets the screen swap to the
    // static "Call ended" view (early-return) in ONE clean unmount before
    // any native teardown. The terminal setState at the END of this fn is
    // now an idempotent no-op.
    setState(prev =>
      prev === 'kicked' ? 'kicked' :
      wasHostEndedRef.current ? 'ended-by-host' :
      'left',
    );
    // Fix #13: read roomId from the ref so we use the LATEST value.
    // The useCallback closure captures the roomId at the time the
    // callback was last memoized, but external paths (FloatingCall-
    // Overlay's End button, BackHandler) may invoke it via a ref bound
    // earlier — using the state directly would clear identities for
    // an old roomId and miss the live one.
    const rid = roomIdRef.current ?? roomId;
    console.log(`[bravo.groupcall.leave] tearing down roomId=${rid ?? '-'} kicked=${wasKickedRef.current}`);
    const ws = transportRef.current;
    cleanupSubRef.current?.();
    cleanupSubRef.current = null;
    cleanupIdentSub.current?.();
    cleanupIdentSub.current = null;
    // Fix #10: stop the audio-level interval HERE, before the recv
    // transport closes. The effect's React-cleanup runs on unmount
    // commit, which can be 1-2 ticks later — ample time for one more
    // tick() to fire on a closed transport and produce noisy logs.
    if (audioPollIntervalRef.current) {
      clearInterval(audioPollIntervalRef.current);
      audioPollIntervalRef.current = null;
    }

    // S6 / P0-C1 — fire SFrame detachers BEFORE closing mediasoup
    // transports. Each detacher aborts the in-flight TransformStream
    // pipeTo() that ties the producer/consumer to its SFrame
    // encrypt/decrypt pipe; if we close the transport first, the pipe
    // tries to write to a closed stream and the native bridge crashes.
    // Dispose the GroupCallEncryption instance last so any final
    // in-flight encrypt/decrypt has its sender/receiver state intact.
    for (const detach of sframeDetachersRef.current) {
      try {detach();} catch { /* ignore */ }
    }
    sframeDetachersRef.current = [];
    if (groupEncryptionRef.current) {
      try {groupEncryptionRef.current.dispose();} catch { /* ignore */ }
      groupEncryptionRef.current = null;
    }

    // CLOSE LOCAL MEDIA FIRST — synchronous, fast, kills inbound audio
    // and outbound capture immediately. Was previously sequenced AFTER
    // two awaited wsRequest calls (sfu.ring.cancel + sfu.leave), which
    // each carry an 8-second ack timeout — so a slow/unhealthy WS at
    // hangup time meant the user kept hearing peer audio for up to 16s
    // while the screen froze. The WS frames are best-effort hints
    // (server tears us down on disconnect anyway); they MUST NOT block
    // the audio teardown. Reproduce path: host of a group call presses
    // End → freeze + peer audio bleed for 16s + remaining peers stuck
    // talking to each other in a hostless ghost room.
    //
    // Fix #9: detach per-consumer track listeners BEFORE close. The
    // `cancelled` flag inside each cleanup makes any late-firing
    // 'mute'/'unmute'/'trackended' callback a no-op, which avoids
    // setRemoteTiles running on the unmounted hook. Run cleanups for
    // ALL consumers up-front, THEN walk the map again to close.
    for (const cleanups of consumerCleanupsByPid.current.values()) {
      for (const cb of cleanups) { try { cb(); } catch { /* ignore */ } }
    }
    consumerCleanupsByPid.current.clear();

    for (const p of producersRef.current) {try { p.close(); } catch { /* ignore */ }}
    producersRef.current = [];
    for (const c of consumersByPid.current.values()) {try { c.close(); } catch { /* ignore */ }}
    consumersByPid.current.clear();
    inFlightConsumes.current.clear();
    consumedProducerIdsRef.current.clear();
    reconcileProducersRef.current = null;
    earlyProducerBufferRef.current = null;
    try { sendTxRef.current?.close(); } catch { /* ignore */ }
    try { recvTxRef.current?.close(); } catch { /* ignore */ }
    sendTxRef.current = null; recvTxRef.current = null;
    audioTrackRef.current?.stop(); audioTrackRef.current = null;
    videoTrackRef.current?.stop(); videoTrackRef.current = null;
    setLocalStream(null);
    setRemoteTiles([]);
    // B-15 — clear video-stall tracking so a fresh call starts clean.
    setVideoStalledTags({});
    videoFrameSnapRef.current.clear();

    // When the server already told us the host left (sfu.room.ended),
    // it has already closed our consumers/transports and deleted the
    // room state — sending sfu.leave would error out (unknown
    // participant) or pointlessly add latency. Same for sfu.ring.cancel:
    // the server torn-down everyone, including the ring queue.
    if (!wasHostEndedRef.current) {
      // Round 4 / server-contract drift fix: if WE were the host AND a
      // ring is still in flight (recipients haven't all joined yet),
      // tell the server to dismiss those recipients' ringing screens.
      // Without this, callees that didn't pick up before the host hung
      // up keep ringing for the full 30s ring window — server already
      // supports sfu.ring.cancel but no client codepath was sending it.
      //
      // B-12: the decision is factored into shouldSendRingCancel so it
      // no longer requires ringStartedAtRef (set only AFTER the sfu.ring
      // ack lands). A host who taps End in the window between "sendTx
      // connected" and the ack now still cancels via sentRingRef.
      //
      // FIRE-AND-FORGET: the call was previously awaited synchronously,
      // blocking media teardown. Now non-blocking.
      // KO-7 (B-566) — cancel EVERYONE this call ever rang, not only the
      // boot list: a mid-ring invitee who never joined must get the cancel.
      const recipientIds = Array.from(new Set([
        ...(Array.isArray(opts.recipientUserIds) ? opts.recipientUserIds : []).filter(Boolean),
        ...rungUsersRef.current,
      ]));
      const stillRinging = recipientIds.filter(
        uid => uid && !joinedUserIdsRef.current.has(uid),
      );
      if (
        ws && rid
        && shouldSendRingCancel({
          isHost:            isHostRef.current,
          direction:         opts.direction,
          sentRing:          sentRingRef.current,
          ringStartedAt:     ringStartedAtRef.current,
          recipientCount:    recipientIds.length,
          stillRingingCount: stillRinging.length,
        })
      ) {
        // B-342 — shared frame builder; see sendRingCancelFrame above.
        sendRingCancelFrame(ws, rid, stillRinging);
      }

      // sfu.leave is best-effort — server tears us down on disconnect
      // anyway. Fire-and-forget so a slow/unhealthy WS doesn't block
      // the user-visible hangup.
      if (ws && rid) {
        void wsRequest<{ok: true}>(ws, 'sfu.leave', {roomId: rid})
          .catch(() => { /* swallow — we're tearing down */ });
      }
    }

    // Append a call_meta history bubble before clearing the registry.
    // Skip for kicked (rude exit, no chat record) and for sub-2s leaves
    // (misclick / never-connected). Use the kicked ref because React
    // state updates from the dispatcher branch above haven't flushed yet.
    //
    // Outcome distinguishes:
    //   - kicked         → no bubble (handled above)
    //   - host ended     → 'ended-by-host' so the calls log shows
    //                      "Group call ended by host" on the peer side,
    //                      matching what they just saw on screen
    //   - normal hangup  → 'answered' (we participated and walked away)
    if (callStartedAtRef.current && !wasKickedRef.current) {
      const durationSec = Math.max(0, Math.round((Date.now() - callStartedAtRef.current) / 1000));
      if (durationSec >= 2) {
        appendGroupCallHistoryBubble({
          conversationId: opts.conversationId,
          callType:       opts.callType,
          durationSec,
          outcome:        wasHostEndedRef.current ? 'ended-by-host' : 'answered',
        });
      }
    }
    callStartedAtRef.current = null;

    if (rid) {clearRoomIdentities(rid);}
    // Audit BS-LEAK — drop the stashed handles now that we've closed
    // them, so a later same-room call can't adopt dead transports.
    if (rid) {liveSfuHandlesByRoom.delete(rid);}
    // WI-3.1 — and the attempt counter, for the same reason: a later call in
    // this room must not inherit a sequence a stale attempt could still match.
    // Safe to restart at 1 because every surviving attempt from THIS call also
    // carries `leaving`, which refuses it regardless of its number.
    if (rid) {clearRoomAttempts(rid);}
    // Fix #14: only clear the registry if it still points at OUR
    // roomId — between leaveInternal entering and reaching this line,
    // a fresh call could have replaced the slot (rare, but the
    // hangup-and-immediately-call-someone-else path makes it
    // possible). Comparing against roomIdRef.current ensures we
    // never null-out someone else's call.
    // WI-1.5 — the generation closes the hole roomId alone left open: a fresh
    // call in the SAME room is indistinguishable from ourselves by id, so a
    // slow leave used to null the successor's slot (and `launchCall`'s busy
    // guard then blocked calls in other conversations with "Call in progress").
    // Falls back to the id-only test when we never published an entry.
    const reg = getActiveGroupCall();
    const ours = groupKeyRef.current;
    if (reg && reg.roomId === rid && (!ours || reg.gen === ours.gen)) {setActiveGroupCall(null);}

    /**
     * B-595 — CLEAR THE EXTERNAL ARTIFACTS ON EVERY TERMINAL LANE, not just
     * the one the End button takes.
     *
     * `sfu.room.ended` (the HOST hung up) and `sfu.kicked` land here directly
     * and never route through `endActiveGroupCall`, so every OTHER participant
     * — the ones who pressed nothing — kept the ring card and RNCallKeep's
     * ongoing "call in progress" notification. Wiring only the teardown fixed
     * the symptom for the person who ended the call and nobody else.
     *
     * ⚠️ GATED ON THE SAME SUCCESSOR TEST AS THE SLOT NULL ABOVE — running
     * AFTER that check is not the same as being GATED BY it, and the first
     * draft of this block only ran after it while claiming to be gated.
     *
     * `rid` is THIS instance's room, and a same-room successor is a real,
     * documented shape: the reconnect-while-minimized path fires the old
     * instance's `oldLeave()` for the SAME roomId when its transports are
     * dead. Ungated, that stale leave would end the LIVE call's Telecom
     * connection (taking its "call in progress" card and silently disabling
     * `reportAudioRoute` for the rest of the call), clear the accept latch the
     * group navigate sites re-assert from, and mark the room's ring consumed —
     * all mid-call, to a call that is fine.
     *
     * Identity is `gen`, matching the slot check: a successor with a NEWER
     * generation owns these artifacts now, so we leave them alone. Everything
     * else — host-ended, kicked, last-participant-out, an ordinary leave —
     * still clears, which is the whole point of this hook.
     */
    const supersededByNewer = !!reg && reg.roomId === rid && !!ours && reg.gen !== ours.gen;
    if (rid && !supersededByNewer) {
      try { clearGroupCallArtifacts(rid); } catch { /* push layer absent */ }
    }

    setState(prev =>
      prev === 'kicked' ? 'kicked' :
      wasHostEndedRef.current ? 'ended-by-host' :
      'left',
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- leaveInternal is mirrored via leaveInternalRef (see below); opts.direction is not read here
  }, [roomId, opts.conversationId, opts.callType, opts.recipientUserIds]);

  // Fix #7: keep leaveInternalRef pointing at the freshest closure so
  // the resume-path SFU handler can call leave without depending on
  // the useCallback's identity (which changes on every roomId update).
  useEffect(() => { leaveInternalRef.current = leaveInternal; }, [leaveInternal]);

  // B-07 — keep toggleVideoRef on the freshest closure so the
  // encryptor-arrival retry hits the up-to-date implementation.
  useEffect(() => { toggleVideoRef.current = toggleVideo; }, [toggleVideo]);

  // Keep the registry's leave/toggleMute/toggleVideo references in
  // sync with the freshest closures so the floating overlay always
  // invokes the right ones (closures capture state — without this,
  // an early-bound leave would use a stale roomId, and toggleVideo
  // would splice a fresh track into a stale localStream).
  // Fix #15: include toggleVideo in this sync so the overlay's video
  // button always hits the up-to-date implementation.
  useEffect(() => {
    if (state !== 'joined') {return;}
    patchActiveGroupCall(roomIdRef.current, {leave: leaveInternal, toggleMute: toggleMuteInternal, toggleVideo});
  }, [state, leaveInternal, toggleMuteInternal, toggleVideo]);

  return {
    state, roomId, isHost, selfTag,
    localStream, remoteTiles, identityByTag,
    isMuted, isVideoOff, isFrontCamera,
    audioLevels,
    netQuality,
    videoStalledTags,
    toggleMute: toggleMuteInternal, toggleVideo, switchCamera,
    inviteUsers,
    reRing,
    ringStartedAt,
    reRungUserIds,
    recipientUserIds: opts.recipientUserIds,
    muteParticipant, hostMutedTags, kickParticipant,
    setHiddenVideoTags,
    leave: leaveInternal,
  };
}

// ─── helpers ────────────────────────────────────────────────────────

/**
 * SN-07 — how long a group WS request may wait for a reconnecting transport.
 *
 * Mirrors CALL_SETUP_SEND_BUDGET_MS on the 1:1 path. socket.io reconnects in
 * ~500ms-2s (reconnectionDelay 500ms, jittered backoff), so this converts the
 * common blip into a successful call while still failing fast on a genuinely
 * dead transport.
 */
const WS_REQUEST_OPEN_BUDGET_MS = 10_000;

/**
 * SN-07 — device-confirmed 2026-07-19 on a Pixel 6a: tapping a group call
 * during a WS reconnect produced an instant "Call failed" with
 *   [bravo.groupcall.boot] step=3 FAIL  transport not open
 *   [useGroupCall] boot failed: transport not open
 *
 * Every group boot step (sfu.join / produce / ring …) rides emitWithAck, which
 * rejects SYNCHRONOUSLY when `socket.connected` is false, and the boot catch
 * turns any rejection into setState('failed') with no retry — so a 1-3s blip
 * killed a call the transport was about to recover from. The B-05 rejoin
 * machinery only arms AFTER state reaches 'joined', so it does not cover boot.
 *
 * The 1:1 path already had `waitOpenThenSend`; the group path had no
 * equivalent. Waiting here fixes every sfu.* step at once because `wsRequest`
 * is their single choke point.
 *
 * On timeout we deliberately fall through to emitWithAck so the failure mode
 * is exactly what it was before — this only ever converts a would-be failure
 * into a success, never the reverse.
 */
async function waitForTransportOpen(
  ws: TransportClient,
  timeoutMs = WS_REQUEST_OPEN_BUDGET_MS,
): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if ((ws as unknown as {state?: string}).state === 'connected') {return;}
    if (Date.now() - t0 >= timeoutMs) {
      console.warn(`[bravo.groupcall] transport still not open after ${timeoutMs}ms; attempting anyway`);
      return;
    }
    await new Promise(r => setTimeout(r, 100));
  }
}

async function wsRequest<T>(ws: TransportClient, event: string, data: unknown): Promise<T> {
  await waitForTransportOpen(ws);
  return ws.emitWithAck<T>(event, data);
}

/**
 * Pull short-lived TURN credentials from messenger-service. Falls back
 * to STUN-only if the request fails — STUN-only works on most networks;
 * only symmetric-NAT clients hard-fail without TURN, and they'll see
 * the same network errors the 1:1 path surfaces.
 */
async function fetchTurnCredentials(): Promise<Array<{urls: string | string[]; username?: string; credential?: string}>> {
  // Audit Step 3a.1 (B-598) — the group path fetched TURN with NO ceiling (the
  // 6 s cap was CallScreen-only) and un-cached, so a background/Doze window
  // could hang the whole boot on a dead socket. Delegate to the shared session
  // cache (webrtc/turnCredentials.ts, Step 2.1): TURN_FETCH_CEILING_MS bound +
  // STUN fallback + single-flight, and the ring-time prewarm usually makes this
  // a hit. Rejoin (freshTurn) reuses the cache too.
  const {getIceServers} = require('./turnCredentials') as typeof import('./turnCredentials');
  const ice = await getIceServers({ceilingMs: TURN_FETCH_CEILING_MS});
  const hasTurn = ice.some(sv => !!sv.username);
  crashLog(`[bravo.groupcall.ice] TURN ${hasTurn ? 'ok' : 'STUN-only'} n=${ice.length}`);
  return ice;
}

function appendGroupCallHistoryBubble(args: {
  conversationId: string;
  callType:       'voice' | 'video';
  durationSec:    number;
  /** 'answered' for normal hangup, 'ended-by-host' when the server
   *  fired sfu.room.ended (host left, we got tornd own). */
  outcome?:       'answered' | 'ended-by-host';
}): void {
  // Round 2 / Security audit: replace Math.random() with crypto-grade
  // random bytes. This id ends up as the local message id for the
  // call-history bubble; a predictable id makes it easier to
  // collide-replace a victim's outbound entry. crypto.getRandomValues
  // is guaranteed by polyfills.ts boot order.
  const c = (globalThis as {crypto?: {getRandomValues?: (a: Uint8Array) => Uint8Array}}).crypto;
  let suffix: string;
  if (c?.getRandomValues) {
    const b = new Uint8Array(4);
    c.getRandomValues(b);
    suffix = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  } else {
    suffix = Math.random().toString(36).slice(2, 10); // best-effort fallback
  }
  const id = `gc_${Date.now().toString(36)}_${suffix}`;
  const msg: LocalMessage = {
    id,
    conversation_id: args.conversationId,
    sender_id:       'self',
    type:            'call',
    content:         '',
    status:          'delivered',
    is_encrypted:    true,
    created_at:      new Date().toISOString(),
    // Group calls don't have a single peer; placeholder address keeps
    // the LocalMessage shape happy and CallRecordRow's relaunch path
    // ignores it for group calls (see ChatScreen wire-up).
    peer:            {userId: 'group-call', deviceId: 0},
    call_meta: {
      kind:      args.callType,
      direction: 'outgoing',
      outcome:   args.outcome ?? 'answered',
      duration:  args.durationSec,
      // Marker so the chat renderer knows this is the group variant —
      // tapping should re-launch a group call, not 1:1.
      groupCall: true,
    },
  };
  useMessengerStore.getState().appendMessage(args.conversationId, msg);
}

/**
 * B-12 — append an INCOMING "missed group call" history bubble. Called by
 * IncomingGroupCallScreen when the host cancels the ring before the user
 * accepted (host abandoned the call). Without this the ring just vanished
 * with no record — the WhatsApp behaviour is a "Missed group call" entry.
 * Idempotent-ish at the call site via a per-roomId settled guard.
 */
export function appendMissedGroupCallBubble(args: {
  conversationId: string;
  callType:       'voice' | 'video';
  /**
   * Finding #8(a) — stable id for idempotent dedup. The server's
   * `sfu.ring.missed` can REPLAY on reconnect, so the runtime passes
   * `missed-group-<roomId>` here; appendMessage dedups on id so the same
   * missed marker never doubles the Calls log. Omitted (random id) for the
   * host-cancelled-ring call site where each dismissal is distinct.
   */
  stableId?:      string;
  /** Optional server timestamp (ms) for the missed marker. */
  at?:            number;
}): void {
  let id: string;
  if (args.stableId) {
    id = args.stableId;
  } else {
    const c = (globalThis as {crypto?: {getRandomValues?: (a: Uint8Array) => Uint8Array}}).crypto;
    let suffix: string;
    if (c?.getRandomValues) {
      const b = new Uint8Array(4);
      c.getRandomValues(b);
      suffix = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    } else {
      suffix = Math.random().toString(36).slice(2, 10);
    }
    id = `gc_${Date.now().toString(36)}_${suffix}`;
  }
  const msg: LocalMessage = {
    id,
    conversation_id: args.conversationId,
    sender_id:       'self',
    type:            'call',
    content:         '',
    status:          'delivered',
    is_encrypted:    true,
    created_at:      new Date(args.at ?? Date.now()).toISOString(),
    peer:            {userId: 'group-call', deviceId: 0},
    call_meta: {
      kind:      args.callType,
      direction: 'incoming',
      outcome:   'missed',
      duration:  0,
      groupCall: true,
    },
  };
  useMessengerStore.getState().appendMessage(args.conversationId, msg);
}

// Helper used by the floating overlay's hangup path. Re-exported so
// FloatingCallOverlay doesn't need to import groupCallRegistry directly.
export {endActiveGroupCall};
