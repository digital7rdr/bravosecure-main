/**
 * useCall — the React hook that turns the existing `CallController`
 * machinery into something a screen can consume.
 *
 *   const call = useCall({
 *     callId,
 *     peer:        {userId, deviceId},
 *     kind:        'voice' | 'video',
 *     direction:   'outgoing' | 'incoming',
 *     incomingSdp: ...    // only when direction = 'incoming'
 *   });
 *
 *   call.state           → 'connecting' | 'ringing' | 'connected' | 'ended' | 'failed'
 *   call.localStream     → MediaStream  (your camera/mic)
 *   call.remoteStream    → MediaStream | null (peer's media)
 *   call.toggleMute()    → audio track .enabled flip
 *   call.toggleVideo()   → video track .enabled flip
 *   call.flipCamera()    → front ↔ back via replaceTrack
 *   call.hangup()
 *   call.stats           → {rttMs, jitterMs, packetLossPct} sampled every 1s
 *   call.dtls            → {dtlsState, srtpCipher} | null  (set after secure)
 */
import {useEffect, useRef, useState, useCallback} from 'react';
import type { MediaStreamTrack} from 'react-native-webrtc';
import {MediaStream} from 'react-native-webrtc';
import {CallController, type CallControllerOptions} from './callController';
import {CallSignalling} from './signallingClient';
import {rtcPeerConnectionFactory, getLocalMedia, flipCamera, recoverCamera} from './peerConnectionFactory';
import {registerSignalling} from './callDispatcher';
import type {SessionAddress, CallKind, CallState, IceServerConfig} from './types';
import type {CallKey} from '../runtime/callRegistry';
import {logCallSm, shortCallId, logCallLat} from '../runtime/callDiag';
import type {TransportClient} from '@bravo/messenger-core';

/**
 * Minimal local declaration of WebRTC `RTCRtpSendParameters` so the
 * sender-quality tuning blocks below (which `as unknown`-cast the
 * native getSenders return value) typecheck without the DOM lib.
 * This project's tsconfig doesn't pull in lib.dom (RN runtime), and
 * react-native-webrtc doesn't ship the type. We only access the
 * `encodings` shape; the cast paths handle everything else.
 */
type RTCRtpSendParameters = {
  encodings?: Array<{maxBitrate?: number; maxFramerate?: number}>;
};

export interface UseCallOptions {
  callId:      string;
  peer:        SessionAddress;
  kind:        CallKind;
  direction:   'outgoing' | 'incoming';
  /** Only required for incoming calls — the offer SDP from `call.offer`. */
  incomingSdp?: string;
  /** WebSocket transport — the call signalling rides on it. */
  transport:   TransportClient;
  /** TURN/STUN config from `GET /webrtc/turn-credentials`. */
  iceServers:  IceServerConfig[];
  /**
   * Reserved for the future Agora fallback wiring. The current
   * implementation hard-fails on ICE failure (no fallback). Kept on
   * the interface so callers don't need to change when fallback lands.
   */
  agoraStart?: (callId: string) => Promise<void>;
}

export interface CallStats {
  rttMs:           number | null;
  jitterMs:        number | null;
  packetLossPct:   number | null;
  bytesPerSecond:  number | null;
  /**
   * BS-CALL-DUPMIC — local mic level, 0..1, straight off the engine's own
   * `media-source` audio stat. It exists so the call UI can show a live
   * waveform WITHOUT opening a second microphone: CallScreen used to run an
   * `expo-av Audio.Recording` alongside the WebRTC capture for exactly this,
   * which is a duplicate capture client on a live call (see the removal note
   * in CallScreen). `null` when the engine has not reported a level yet.
   */
  micLevel:        number | null;
}

export interface CallHandle {
  state:        CallState;
  localStream:  MediaStream | null;
  remoteStream: MediaStream | null;
  isMuted:      boolean;
  isVideoOff:   boolean;
  /**
   * Peer added video to this call mid-stream (received `call.reoffer`).
   * Driven by the controller's onRemoteRenegotiation hook — UI uses
   * this to show a "Turn on your camera too?" prompt for symmetry
   * without auto-acquiring the user's camera (privacy: the responder
   * never gets their camera enabled without explicit consent).
   */
  peerAddedVideo: boolean;
  /**
   * True while a renegotiation is in flight on this side. UI uses this
   * to disable the Camera button so a fast double-tap can't fire two
   * upgrades. The controller has its own coalesce, but mirroring it
   * here keeps the button visibly disabled instead of looking like a
   * dead tap.
   */
  isUpgrading:    boolean;
  /**
   * BS-021 — peer-side flags driven by the inbound `call.media-state`
   * advisory. `remoteVideoOff` flips the receiver's UI to a "Camera
   * off" placeholder so the user can distinguish a frozen feed from
   * an intentional disable. `remoteMuted` is plumbed for symmetry —
   * UI may show a tiny "muted" pill on the remote tile.
   */
  remoteVideoOff: boolean;
  remoteMuted:    boolean;
  /**
   * B-16 — true once the peer's remote stream carries a video track.
   * Set deterministically from `ontrack` (which fires for the late
   * video track added by a mid-call audio→video upgrade), independent
   * of stream-object identity. The remote `<RTCView>` keys off this so
   * it REMOUNTS the moment remote video arrives — otherwise the party
   * that enabled video FIRST keeps an audio-era SurfaceView that never
   * rebinds to the peer's later-added track (stays black / "self only").
   */
  remoteHasVideo: boolean;
  facing:       'user' | 'environment';
  stats:        CallStats;
  dtls:         {dtlsState: string; srtpCipher: string} | null;
  /** Resolves false when no controller exists yet (B-319 null-controller
   *  window) — the caller must NOT latch its accept as done. */
  accept:       () => Promise<boolean>;
  /** True once controllerRef holds a real controller (built or adopted).
   *  B-319 — the auto-accept effect gates on this. */
  controllerReady: boolean;
  /** Returns whether a live controller handled the decline (B-102 A2 —
   *  false = null-controller window; the caller must run its own teardown). */
  decline:      () => boolean;
  hangup:       () => void;
  toggleMute:   () => void;
  /**
   * Returns true when a video track was actually toggled, false when
   * the call has no video track (voice-only call). The caller can use
   * the false return to show "video upgrade not available mid-call"
   * feedback instead of leaving the user staring at a dead button.
   */
  toggleVideo:  () => boolean;
  /**
   * Mid-call voice→video upgrade. Acquires the local camera, addTracks
   * to the live PeerConnection, fires `call.reoffer` to the peer, and
   * resolves once the peer's `call.reanswer` has applied. On any
   * failure the local change is rolled back (track stopped, sender
   * removed) so the call stays voice-only and connected. The caller
   * (CallScreen) typically catches and surfaces an Alert.
   *
   * No-op + resolved when the call is already video — keeps the
   * Camera button idempotent on the video-call return tree.
   */
  upgradeToVideo: () => Promise<void>;
  flipCamera:   () => Promise<void>;
}

const EMPTY_STATS: CallStats = {rttMs: null, jitterMs: null, packetLossPct: null, bytesPerSecond: null, micLevel: null};

/**
 * WI-1.4 — the media-state ownership key. One owner per callId, so the boot
 * registration and every later adoption of the same call compete for the same
 * slot instead of stacking up.
 */
function mediaStateOwner(callId: string): string { return `useCall:${callId}`; }

export function useCall(opts: UseCallOptions): CallHandle {
  const {callId, peer, kind, direction, incomingSdp, transport, iceServers} = opts;
  const isVideo = kind === 'video';

  // B-102 A2 — sticky offer-SDP presence key for the boot-effect deps. See
  // the dep-array comment at the bottom of the boot effect.
  const sdpEverPresentRef = useRef(false);
  if (incomingSdp) {sdpEverPresentRef.current = true;}

  // Why: restore-from-minimize — the registry already knows the live state,
  // but the 'ringing'/'idle' seed held until iceServers resolved (a network
  // fetch), so the restored screen rendered the wrong surface for that whole
  // window: no chrome tap-catcher (first tap dead) and a ring-surface flash.
  const [state, setState]                 = useState<CallState>(() => {
    try {
      const {getActiveCall} = require('../runtime/callRegistry') as typeof import('../runtime/callRegistry');
      const live = getActiveCall();
      if (live && live.callId === callId) {return live.state;}
    } catch { /* registry unavailable (tests) */ }
    return direction === 'incoming' ? 'ringing' : 'idle';
  });
  // Why: B-319 — a notification answer can arrive before iceServers resolve,
  // when no controller exists. The auto-accept effect must be able to WAIT on
  // that (state alone can't signal it: incoming seeds 'ringing' immediately).
  const [controllerReady, setControllerReady] = useState(false);
  const [localStream, setLocalStream]     = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream]   = useState<MediaStream | null>(null);
  const [isMuted, setIsMuted]             = useState(false);
  const [isVideoOff, setIsVideoOff]       = useState(false);
  // Mid-call renegotiation state. peerAddedVideo flips when the peer
  // initiated a voice→video upgrade and our side accepted it; UI may
  // show a "Turn on your camera too?" prompt. isUpgrading mirrors the
  // controller's renegotiation lock so the Camera button is visibly
  // disabled while a tap is in progress.
  const [peerAddedVideo, setPeerAddedVideo] = useState(false);
  const [isUpgrading, setIsUpgrading]       = useState(false);
  // BS-021 — peer media-state mirrors. Driven by inbound
  // `call.media-state` advisories. Default false; the peer's first
  // toggle flips them.
  const [remoteVideoOff, setRemoteVideoOff] = useState(false);
  const [remoteMuted, setRemoteMuted]       = useState(false);
  // B-16 — whether the remote stream currently carries a video track.
  // Set from ontrack so a mid-call audio→video upgrade reliably flips
  // it (and forces the remote RTCView to remount), regardless of
  // whether the peer reused the same MediaStream id.
  const [remoteHasVideo, setRemoteHasVideo] = useState(false);
  const [facing, setFacing]               = useState<'user' | 'environment'>('user');
  const [stats, setStats]                 = useState<CallStats>(EMPTY_STATS);
  const [dtls, setDtls]                   = useState<{dtlsState: string; srtpCipher: string} | null>(null);

  const audioTrackRef = useRef<MediaStreamTrack | null>(null);
  const videoTrackRef = useRef<MediaStreamTrack | null>(null);
  /**
   * WI-1.1 — the registry identity this hook instance is allowed to mutate.
   *
   * Set once: to the ADOPTED entry's key on restore (adoption is a
   * continuation, so it inherits the generation), or to the key minted by our
   * own `setActiveCall` on a fresh boot. Every registry write below is keyed by
   * it, so a callback frozen on this instance — a late ring expiry, a queued
   * hangup ack, an ICE-failed on a closing PC, a stats tick — can no longer
   * mutate or tear down a NEWER call that has taken the slot. Null until we own
   * a call, and never cleared: the controller's callbacks outlive the mount and
   * must keep patching the entry they legitimately own.
   */
  const callKeyRef    = useRef<CallKey | null>(null);
  const controllerRef = useRef<CallController | null>(null);
  const signallingRef = useRef<CallSignalling | null>(null);
  // The MediaStream we hand to addTrack on initial accept; addTrack on
  // mid-call upgrade must reuse the SAME stream object so the new video
  // track lands in the same a=msid group as the existing audio. Without
  // this, the peer sees two separate MediaStreams (one audio, one video)
  // and our local PiP can't be a single RTCView pointing at one stream.
  const localStreamRef = useRef<MediaStream | null>(null);
  // Fix #5: AgoraFallback was scaffolding only — `fallbackHandle.current`
  // was never assigned, the cancel call in cleanup was always a no-op,
  // and `agoraStart` was never wired to a real Agora SDK boot. Carrying
  // the dead code obscured the actual ICE-failure behaviour: a hard
  // hangup with state='failed'. If/when Agora is wired for real, this
  // is the place to bring back a properly-built `iceConnectedPromise`
  // race against the fallback timeout. Until then: ICE failure ⇒ failed.
  const statsTimer    = useRef<ReturnType<typeof setInterval> | null>(null);
  const unregisterRef = useRef<(() => void) | null>(null);

  // B-20 — mirror facing + user-intended camera-off into refs so the
  // once-mounted resume handler below reads fresh values without
  // re-subscribing AppState on every toggle.
  const facingRef = useRef(facing);
  useEffect(() => { facingRef.current = facing; }, [facing]);
  const isVideoOffRef = useRef(isVideoOff);
  useEffect(() => { isVideoOffRef.current = isVideoOff; }, [isVideoOff]);
  // O-A (VIDEO_CALL_RENDER_ISSUES_HANDOFF §4) — the stats poller reads
  // this to self-heal a stale "Camera off" placeholder (see below).
  const remoteVideoOffRef = useRef(remoteVideoOff);
  useEffect(() => { remoteVideoOffRef.current = remoteVideoOff; }, [remoteVideoOff]);
  const recoveringCameraRef = useRef(false);

  // ── B-20 — camera-loss recovery on resume ───────────────────
  // When another app (e.g. the system Camera) grabs the camera mid-call,
  // our capture track ends/mutes and the encoder keeps "sending" null
  // frames — a magenta tile on BlueStacks, black/frozen on a real phone —
  // with no onCameraDisconnected to react to. On foreground, if we're in
  // a video call whose local track has died AND the user didn't
  // intentionally turn the camera off, re-acquire and replaceTrack onto
  // the existing sender (no SDP reneg — peer keeps receiving seamlessly).
  // NOTE: BlueStacks reports the stolen track as 'live' (it just feeds
  // garbage frames), so this path can only be verified on a physical
  // device; it is written to be a safe no-op when the track is healthy.
  useEffect(() => {
    const {AppState} = require('react-native') as typeof import('react-native');
    const sub = AppState.addEventListener('change', (next: string) => {
      // P2-BR-6 — pause/resume the controller's mid-call ICE-restart
      // reconnect budget across background transitions. RN freezes JS
      // timers while backgrounded; without this the 30 s budget flushes on
      // resume and end('failed')s the call exactly when the user taps back
      // in. notifyBackground pauses it; notifyForeground re-probes ICE and
      // grants a fresh grace window. Runs regardless of the camera-recovery
      // logic below.
      try {
        const ctl = controllerRef.current as unknown as {
          notifyForeground?: () => void; notifyBackground?: () => void;
        } | null;
        if (next === 'active') { ctl?.notifyForeground?.(); }
        else if (next === 'background' || next === 'inactive') { ctl?.notifyBackground?.(); }
      } catch { /* controller not built / older instance — ignore */ }
      if (next !== 'active') {return;}
      if (isVideoOffRef.current) {return;}            // user-intended off — respect it
      const track = videoTrackRef.current;
      if (!track) {return;}                            // audio-only call
      const muted = (track as unknown as {muted?: boolean}).muted === true;
      const dead  = track.readyState === 'ended' || muted;
      if (!dead) {return;}                             // healthy track — nothing to do
      if (recoveringCameraRef.current) {return;}       // re-entrancy guard
      const pc = (controllerRef.current as unknown as {pc?: {raw?: unknown}})?.pc?.raw;
      if (!pc) {return;}
      recoveringCameraRef.current = true;
      void (async () => {
        try {
          const replaced = await recoverCamera({
            pc:           pc as never,
            facing:       facingRef.current,
            currentTrack: track,
            localStream:  localStreamRef.current ?? undefined,
          });
          if (replaced) {
            videoTrackRef.current = replaced;
            const audio = audioTrackRef.current;
            const fresh = new MediaStream(audio ? [audio, replaced] : [replaced]);
            setLocalStream(fresh);
            try {
              const reg = require('../runtime/callRegistry') as typeof import('../runtime/callRegistry');
              reg.patchActiveCall(callKeyRef.current, {videoTrack: replaced, localStream: fresh});
            } catch { /* best-effort registry refresh */ }
            console.log('[useCall.recoverCamera] re-acquired camera after resume');
          }
        } catch (e) {
          console.warn('[useCall.recoverCamera] failed (camera may still be held):', (e as Error).message);
        } finally {
          recoveringCameraRef.current = false;
        }
      })();
    });
    return () => sub.remove();
  }, []);

  // ── Boot ────────────────────────────────────────────────
  useEffect(() => {
    // Guard: the hook must NEVER fire signalling with a placeholder
    // peer. CallScreen passes a `demo` peer when its prerequisites
    // (iceServers, transport, route remoteUserId) aren't ready yet.
    // Without this check the runtime sends `call.offer to:{userId:'demo'}`,
    // which the server rightly rejects as `peer_offline: callee not
    // connected` — the symptom every caller hits before iceServers loads.
    if (!peer.userId || peer.userId === 'demo' || !callId || callId === 'demo' || !transport) {
      return;
    }
    // Resume path: if the registry already has an active call with
    // this callId (we just navigated back from a minimized state),
    // adopt its refs instead of starting fresh. Without this branch
    // remounting CallScreen would build a second RTCPeerConnection,
    // re-acquire camera/mic, and burn another OPK on the keys server —
    // and the original call would still be running invisibly.
    //
    // Audit CALL-N1 (2026-07-02): this adopt check MUST run BEFORE the
    // incoming-SDP guard below. The overlay's restore() navigates without
    // an incomingSdp (the controller already consumed it at accept time and
    // the registry doesn't carry it), so for a minimized INCOMING call the
    // old ordering hit `direction==='incoming' && !incomingSdp` and bailed
    // BEFORE adopting — leaving controllerRef null, the state stuck at the
    // initial 'ringing', and the ringtone looping over live call audio with
    // dead Accept/Decline/End buttons. Adoption never needs the SDP.
    const {getActiveCall, setActiveCall, patchActiveCall, onActiveCallChange} = require('../runtime/callRegistry') as typeof import('../runtime/callRegistry');
    const existing = getActiveCall();
    if (existing && existing.callId === callId) {
      // WI-1.1 — adoption INHERITS the generation. A restored screen is the
      // same call session continuing, not a new one, so it must keep the key
      // the booting instance minted; bumping here would orphan every callback
      // still bound to the original instance.
      const adoptedKey: CallKey = {callId: existing.callId, gen: existing.gen};
      callKeyRef.current = adoptedKey;
      controllerRef.current = existing.controller;
      setControllerReady(true);
      signallingRef.current = existing.signalling;
      unregisterRef.current = existing.unregister;
      audioTrackRef.current = existing.audioTrack;
      videoTrackRef.current = existing.videoTrack;
      localStreamRef.current = existing.localStream;
      if (existing.localStream)  {setLocalStream(existing.localStream);}
      if (existing.remoteStream) {
        setRemoteStream(existing.remoteStream);
        // B-16 — restore remote-video state on minimize→restore so the
        // remote tile renders immediately instead of waiting for the
        // next ontrack.
        setRemoteHasVideo((existing.remoteStream.getVideoTracks?.().length ?? 0) > 0);
      }
      // Audit CALL-N11 — rehydrate the persisted local + remote media toggle
      // state so the restored screen reflects reality. Critically, restoring
      // videoReleasedRef prevents toggleVideo from mistaking a locally-off
      // camera for a fresh voice-only call and launching a duplicate-m-line
      // SDP upgrade.
      if (typeof existing.isMuted === 'boolean')        {setIsMuted(existing.isMuted);}
      if (typeof existing.remoteVideoOff === 'boolean') {setRemoteVideoOff(existing.remoteVideoOff);}
      if (typeof existing.remoteMuted === 'boolean')    {setRemoteMuted(existing.remoteMuted);}
      if (existing.facing) {setFacing(existing.facing); facingRef.current = existing.facing;}
      const cameraIsOff = existing.isVideoOff ?? (!existing.videoTrack && (existing.kind === 'video'));
      setIsVideoOff(cameraIsOff);
      videoReleasedRef.current = cameraIsOff && !existing.videoTrack;
      setState(existing.state);
      // Fix #4: re-bind ontrack on the existing PC so THIS hook
      // instance's setRemoteStream gets fired when the peer enables
      // their camera mid-call. The original ontrack was bound to the
      // PRIOR hook instance's setRemoteStream — that instance is gone
      // (we minimized + re-mounted), so without re-binding the new
      // tile would never appear in the restored CallScreen even
      // though the underlying RTP frames are arriving normally.
      try {
        const pcRaw = (existing.controller as unknown as {pc?: {raw?: {ontrack?: ((e: {streams: MediaStream[]}) => void) | null}}})?.pc?.raw;
        if (pcRaw) {
          pcRaw.ontrack = (e) => {
            if (e.streams?.[0]) {
              const remoteMs = e.streams[0];
              setRemoteStream(remoteMs);
              // B-16 — drive remoteHasVideo off the real track list so a
              // late video track (mid-call audio→video upgrade) flips it
              // even when the peer reused the same MediaStream id. The
              // remote RTCView keys off this and remounts to bind the
              // newly-arrived track.
              setRemoteHasVideo((remoteMs.getVideoTracks?.().length ?? 0) > 0);
              patchActiveCall(adoptedKey, {remoteStream: remoteMs});
            }
          };
        }
      } catch { /* RN-WebRTC variations — skip silently if pc layout differs */ }
      // BS-021 — also re-bind onMediaState on the existing signalling
      // so this remounted hook's setRemoteVideoOff / setRemoteMuted
      // fire on the next inbound advisory. The previous hook
      // instance's handler still exists in the array (the registry
      // kept the same CallSignalling), but it points at the dead
      // previous setState — without re-binding we'd silently miss
      // any peer toggle that happens while the user is on Chats Hub.
      // WI-1.4 — registration is REPLACE-BY-OWNER, not append. Every restore
      // used to leave the previous mount's handler installed forever: N
      // restores meant N handlers running per advisory, each writing into a
      // dead React tree and each firing its own registry patch. Owning the
      // slot by callId means N adoptions leave exactly one live handler, and
      // the composed disposer below still tears it down at teardown.
      try {
        const sig = existing.signalling;
        if (sig) {
          const unregisterMS = sig.onMediaStateOwned(mediaStateOwner(callId), d => {
            if (d.callId !== callId) {return;}
            if (typeof d.cameraOff === 'boolean') {setRemoteVideoOff(d.cameraOff);}
            if (typeof d.micOff    === 'boolean') {setRemoteMuted(d.micOff);}
            // Audit CALL-N11 — persist so a later restore rehydrates it.
            try { patchActiveCall(adoptedKey, {remoteVideoOff: d.cameraOff, remoteMuted: d.micOff}); } catch { /* best-effort */ }
          });
          const prevUnregister = existing.unregister;
          const composed = (): void => {
            try { unregisterMS(); } catch { /* ignore */ }
            try { prevUnregister?.(); } catch { /* ignore */ }
          };
          unregisterRef.current = composed;
          patchActiveCall(adoptedKey, {unregister: composed});
        }
      } catch { /* signalling layout variations — best effort */ }
      // Mark "back on screen" so the unmount cleanup behaves normally
      // again until the next minimize.
      patchActiveCall(adoptedKey, {keepAlive: false, isMinimized: false});
      // L6 restore-orphans-onstate — the adopted controller's onState was
      // bound to the PRIOR (now-unmounted) hook instance, so its setState is a
      // dead no-op for THIS instance; only its instance-independent
      // patchActiveCall({state}) keeps flowing. Without re-binding, a peer
      // hangup / reconnecting / failed AFTER restore left the screen frozen on
      // a stale 'connected'. Mirror the registry's state into this hook so the
      // restored CallScreen reacts.
      //
      // WI-1.3 — this used to map "slot is null OR holds a different callId" to
      // `setState('ended')` on OUR instance. Both halves were wrong:
      //   • null slot: a registry that has been cleared is not proof our
      //     controller died (anything can clear the slot), so ask the
      //     controller what it actually is instead of asserting death;
      //   • different callId: a NEWER call's `setActiveCall` flipped a
      //     still-mounted OLDER hook to 'ended' while its controller was very
      //     much alive. Two live 1:1 calls is an invalid state that B-320/B-322
      //     are supposed to prevent, so it gets a loud anomaly warn — and OUR
      //     call is the one that dies, through our own controller. The newer
      //     entry is deliberately NOT touched: running the registry teardown
      //     here would stop the shared audio session and the FGS out from under
      //     the call that now owns them.
      const unsubState = onActiveCallChange((st) => {
        if (!st) {
          // An empty registry IS the app's "there is no call" — so consulting
          // the controller decides whether we have an ORPHAN to clean up, not
          // what to display. Reporting a live state here would strand the
          // screen: the overlay renders nothing without a registry entry, and
          // End would be a keyed no-op against an empty slot.
          const live = controllerRef.current?.currentState;
          if (live && live !== 'ended' && live !== 'failed') {
            logCallSm('adopt.slot-cleared-while-live', {
              cid: shortCallId(callId), gen: adoptedKey.gen, ctl: live,
            });
            try { controllerRef.current?.hangup('ended'); } catch { /* idempotent */ }
            try { unregisterRef.current?.(); } catch { /* ignore */ }
          }
          setState('ended');
          return;
        }
        if (st.callId !== callId) {
          logCallSm('adopt.foreign-call-in-slot', {
            cid: shortCallId(callId), gen: adoptedKey.gen,
            liveCid: shortCallId(st.callId), liveGen: st.gen,
          });
          try { controllerRef.current?.hangup('ended'); } catch { /* idempotent */ }
          try { unregisterRef.current?.(); } catch { /* ignore */ }
          // Belt, not braces: whatever moved the slot to another call has
          // already marked ours (`setActiveCall` marks the entry it displaces,
          // `endActiveCall` marks the one it ends, and nothing else can change
          // the slot's identity). Recorded here anyway so the branch does not
          // silently depend on an invariant that lives in a different function
          // — this is the one path that kills a call the registry does not own,
          // and CALL-N15's ghost-redial guard plus FIX-14's stale-ring sweep
          // are what read it.
          try {
            const reg = require('../runtime/callRegistry') as typeof import('../runtime/callRegistry');
            reg.noteCallEnded(callId, 'adopt-foreign-slot');
          } catch { /* registry unavailable (tests) */ }
          setState('ended');
          return;
        }
        setState(st.state);
        // O-B (VIDEO_CALL_RENDER_ISSUES_HANDOFF §4) — after a restore, a
        // peer-initiated video upgrade fires instance-1's DEAD
        // setPeerAddedVideo (onRemoteRenegotiation is a constructor
        // option frozen at first mount); the only surviving signal is
        // the registry patch ({kind:'video'}). Mirror it so the restored
        // screen's isVideoUI flips and the remote tile becomes reachable.
        if (st.kind === 'video') { setPeerAddedVideo(true); }
        // O-C — accept-after-ring-restore builds the PC via instance-1's
        // frozen wrappedFactory, whose ontrack writes to dead state; only
        // its patchActiveCall({remoteStream}) side survives. Mirror the
        // registry's media into THIS instance so the remote tile mounts.
        if (st.remoteStream) {
          setRemoteStream(st.remoteStream);
          setRemoteHasVideo((st.remoteStream.getVideoTracks?.().length ?? 0) > 0);
        }
        // Peer toggle advisories can land on instance-1's still-registered
        // handler (it patches the registry through a module-level fn) —
        // mirror those too so the placeholder state stays truthful.
        if (typeof st.remoteVideoOff === 'boolean') { setRemoteVideoOff(st.remoteVideoOff); }
        if (typeof st.remoteMuted === 'boolean')    { setRemoteMuted(st.remoteMuted); }
      });
      return () => { try { unsubState(); } catch { /* ignore */ } };
    }
    // Fix #1 (now AFTER the adopt check — see CALL-N1): closure-stale-
    // incomingSdp guard. Only reached when there is NO existing call to
    // adopt, i.e. a genuinely FRESH boot. An incoming call without a ready
    // offer SDP yet would build a controller in 'idle' instead of 'ringing'
    // and lose the offer — bail until both arrive together.
    if (direction === 'incoming' && !incomingSdp) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        // 1. Local media. A9 incoming-camera-before-accept — acquire lazily +
        // memoized. OUTGOING calls acquire up front (the user dialed; the SDP
        // offer needs a=msid and they expect their self-preview). INCOMING
        // calls DEFER acquisition to attachLocalMedia (the controller calls it
        // during accept(), after setRemoteOffer) so a ringing — or declined —
        // call never lights the camera/mic or the privacy LED.
        type AcquiredMedia = {
          stream: MediaStream;
          audioTrack: MediaStreamTrack | null;
          videoTrack: MediaStreamTrack | null;
        };
        let acquiredMedia: AcquiredMedia | null = null;
        // SINGLE-FLIGHT, not just result-memoised (audit Step 2.3): two
        // concurrent callers both passing the `if (acquiredMedia)` guard while
        // the first getUserMedia was still in flight opened the camera TWICE
        // (caught by the CALL-N1 adopt test). Memoise the in-flight PROMISE.
        let acquiringMedia: Promise<AcquiredMedia> | null = null;
        const acquireLocalMediaOnce = async (): Promise<AcquiredMedia> => {
          logCallLat(direction === 'outgoing' ? '1to1-out' : '1to1-in', callId, 'media:start', {video: isVideo});
          const m = await getLocalMedia({video: isVideo});
          logCallLat(direction === 'outgoing' ? '1to1-out' : '1to1-in', callId, 'media:ok', {audio: !!m.audioTrack, video: !!m.videoTrack});
          if (cancelled) {
            m.stream.getTracks().forEach(t => t.stop());
            throw new Error('useCall: cancelled during media acquisition');
          }
          acquiredMedia = m;
          audioTrackRef.current = m.audioTrack;
          videoTrackRef.current = m.videoTrack;
          localStreamRef.current = m.stream;
          setLocalStream(m.stream);
          // Sync the registry once media exists so the floating overlay /
          // resume path see it (for incoming this lands at accept-time; the
          // boot setActiveCall below registers nulls during ring).
          try {
            const reg = require('../runtime/callRegistry') as typeof import('../runtime/callRegistry');
            reg.patchActiveCall(callKeyRef.current, {localStream: m.stream, audioTrack: m.audioTrack, videoTrack: m.videoTrack});
          } catch { /* registry not set yet — boot setActiveCall covers it */ }
          return m;
        };
        const ensureLocalMedia = async (): Promise<AcquiredMedia> => {
          if (acquiredMedia) {return acquiredMedia;}
          if (acquiringMedia) {return acquiringMedia;}   // a concurrent acquire is already in flight
          acquiringMedia = acquireLocalMediaOnce().finally(() => { acquiringMedia = null; });
          return acquiringMedia;
        };
        // Caller acquires now; answerer waits for accept() → attachLocalMedia.
        if (direction === 'outgoing') {
          await ensureLocalMedia();
        }
        if (cancelled) {return;}

        // 2. Signalling — borrow the live WS. We construct it here but
        // DEFER registerSignalling() until after the controller is built
        // and (for incoming calls) handleIncomingOffer has run. The
        // dispatcher drains pre-registration ICE candidates the moment
        // registerSignalling fires; if we register before:
        //   • the controller's onIce handler is wired (CallController
        //     constructor reassigns the no-op handlers on signalling), or
        //   • the controller's descriptor is set (handleIncomingOffer
        //     stamps the descriptor with the callId; without it, the
        //     onIce handler returns early on the callId mismatch check)
        // ...then the drained candidates land in a no-op or get rejected
        // at the descriptor check, and the answerer's engine never gets
        // the offerer's relay candidates → ICE never starts checking →
        // call hangs in have-remote-offer until hangup. This is the
        // root cause of the cross-network "answerer drops binding
        // requests" pattern visible in coturn logs (peer rp>0, sp=0).
        const signalling = new CallSignalling(transport);
        signallingRef.current = signalling;
        let unregister: (() => void) | null = null;

        // 3. (removed) Agora fallback — see Fix #5 comment at the
        //    deleted fallbackRef declaration. ICE failure is a hard
        //    fail until Agora is wired for real.

        // 4. Controller — the existing state machine.
        // We pass the rtcPeerConnectionFactory unwrapped now. The factory
        // ONLY creates the bare RTCPeerConnection; track-adding happens
        // via attachLocalMedia (below), which the controller calls at
        // the spec-correct moment per role:
        //   - caller:   buildPc → attachLocalMedia → createOffer
        //   - answerer: buildPc → setRemoteOffer → attachLocalMedia →
        //               createAnswer
        // The previous code wrapped the factory to addTrack at PC-creation
        // time, which on the answerer side ran BEFORE setRemoteDescription.
        // RN-WebRTC sometimes produced duplicate / mis-ordered
        // transceivers from that order, leading to DTLS never completing.
        const wrappedFactory: typeof rtcPeerConnectionFactory = (cfg) => {
          const pc = rtcPeerConnectionFactory(cfg);
          // Capture the remote stream as soon as the peer's track lands.
          // ontrack is safe to set at construction (it just registers a
          // callback) — only addTrack needs the new ordering.
          (pc as unknown as {ontrack: ((e: {streams: MediaStream[]}) => void) | null}).ontrack = (e) => {
            if (e.streams?.[0]) {
              const remoteMs = e.streams[0];
              setRemoteStream(remoteMs);
              // B-16 — drive remoteHasVideo off the real track list so a
              // late video track (mid-call audio→video upgrade) flips it
              // even when the peer reused the same MediaStream id. The
              // remote RTCView keys off this and remounts to bind the
              // newly-arrived track.
              setRemoteHasVideo((remoteMs.getVideoTracks?.().length ?? 0) > 0);
              patchActiveCall(callKeyRef.current, {remoteStream: remoteMs});
            }
          };
          return pc;
        };

        const controllerOpts: CallControllerOptions = {
          signalling,
          pcFactory:  wrappedFactory,
          iceServers,
          // Audit S7 — caller-identity binding. Delegate signing to the
          // runtime (which owns the sender-cert cache + identity priv
          // key). Lazy require avoids a circular import with the
          // runtime module — same pattern this hook uses for callRegistry
          // and incomingCallCache.
          buildOfferAuth: async ({callId: cid, to: peerTo, kind: peerKind}) => {
            const {getMessengerRuntime} = require('../runtime') as typeof import('../runtime');
            const rt = await getMessengerRuntime();
            if (!rt.signCallOfferAuth) {
              throw new Error('runtime.signCallOfferAuth unavailable (loopback mode?)');
            }
            return rt.signCallOfferAuth({callId: cid, to: peerTo, kind: peerKind});
          },
          onState: (s) => {
            if (!cancelled) {setState(s);}
            patchActiveCall(callKeyRef.current, {state: s});
            // Stamp connectedAtMs the FIRST time the controller reports
            // 'connected'. The duration timer in CallScreen + floating
            // overlay derives elapsed = now - connectedAtMs, which
            // survives CallScreen unmount/remount across minimize.
            // Skip if already set so a transient reconnect doesn't
            // reset the visible counter.
            if (s === 'connected') {

              const reg = require('../runtime/callRegistry') as typeof import('../runtime/callRegistry');
              if (!reg.getActiveCall()?.connectedAtMs) {
                reg.patchActiveCall(callKeyRef.current, {connectedAtMs: Date.now()});
              }
              // CallKit/Telecom bridge — flip system UI from "Calling…"
              // to "In call" on outgoing, no-op on incoming (system UI
              // already auto-flipped on user accept). Skeleton no-ops
              // until the iOS milestone activates.
              try {

                const {reportConnected} = require('../push/callKitBridge') as typeof import('../push/callKitBridge');
                reportConnected(callId);
              } catch { /* skeleton — module always loadable, but defensive */ }
              // Dismiss the incoming-call notifee notification the moment the call CONNECTS
              // (answered) — the in-call UI has taken over, so the looping ring / full-screen
              // call notification must not linger in the shade during the call. The end/failed
              // branch below clears it again on hangup; both together close the "the call notif
              // stays up" gap.
              try {
                const cn = require('../push/callNotification') as typeof import('../push/callNotification');
                void cn.dismissCallNotif(callId);
              } catch { /* notifee unavailable (tests / iOS) */ }
            }
            if (s === 'ended' || s === 'failed') {
              // Hard cleanup — the call is over. Floating overlay
              // disappears, resume path can't find a stale entry.

              // Stop local tracks IMMEDIATELY on call end, not on
              // CallScreen unmount. Two paths flip state to
              // 'ended'/'failed' without an unmount running first:
              //   1. Peer hangs up → controller fires onState('ended')
              //      while CallScreen is still mounted (registry hasn't
              //      cleared yet, the unmount happens on the next tick).
              //   2. Floating-overlay End button: registry's
              //      endActiveCall calls controller.hangup, which fires
              //      onState here, but the OVERLAY (a different mount
              //      tree) is what's mounted — CallScreen may not even
              //      be in the stack. Without this stop the mic/camera
              //      LED stays on for 30+ seconds until React's GC
              //      finally collects the refs. Visible defect on every
              //      reported "rapid hangup" run.
              try { audioTrackRef.current?.stop(); } catch { /* native may throw on already-stopped track */ }
              try { videoTrackRef.current?.stop(); } catch { /* native may throw on already-stopped track */ }
              audioTrackRef.current = null;
              videoTrackRef.current = null;

              // WI-1.1 — keyed: a terminal callback frozen on THIS instance
              // must never tear down whatever call happens to hold the slot.
              // WI-1.2 — `endActiveCall` already does the CallKit report, the
              // cache tombstone and the notifee dismissal, and it is now
              // non-re-entrant, so running them again here would be the exact
              // double-teardown that work item exists to kill. Only run them
              // ourselves when the registry did NOT own this call (an
              // adopted-then-displaced entry, or a controller-only end).
              const {endActiveCall} = require('../runtime/callRegistry') as typeof import('../runtime/callRegistry');
              // 'ending' means we are INSIDE the registry's own teardown for
              // this very call (it drops the slot before calling hangup, so a
              // plain "did it own the slot" test reads false here and the
              // fallback below fired on every single end — a second
              // `reportEnded` with the wrong end-reason, and the bridge is
              // first-write-wins). Only a genuine 'refused' means nobody is
              // doing this teardown for us.
              const outcome = endActiveCall(callKeyRef.current ?? callId, s, 'remote');
              if (outcome === 'refused') {
                try {

                  const {reportEnded} = require('../push/callKitBridge') as typeof import('../push/callKitBridge');

                  const cache = require('../push/incomingCallCache') as typeof import('../push/incomingCallCache');
                  reportEnded(callId, s === 'failed' ? 'failed' : 'remoteEnded');
                  cache.clearIncomingCallPayload(callId);
                  // notifee (Android) and CallKit/Telecom are independent
                  // surfaces. reportEnded only clears the system call UI; if
                  // this call was woken by FCM the looping full-screen
                  // notifee ring is STILL showing and would keep ringing
                  // until its TTL. Dismiss it on the same teardown.
                  try {
                    const cn = require('../push/callNotification') as typeof import('../push/callNotification');
                    void cn.dismissCallNotif(callId);
                  } catch { /* notifee unavailable (tests / iOS) */ }
                } catch { /* bridge inactive — nothing to dismiss */ }
              }
              // Drop the accept-dedupe entry so a (very unlikely) future
              // re-use of the same callId can navigate fresh. Unconditional:
              // the registry teardown does not own this one, and it used to be
              // nested inside the bridge try above, where a callKitBridge
              // failure silently skipped it.
              try {
                const {notifyCallEnded} = require('../push/fcmBootstrap') as typeof import('../push/fcmBootstrap');
                notifyCallEnded(callId);
              } catch { /* fcmBootstrap not loaded in tests */ }
            }
          },
          onSecured: (info) => { if (!cancelled) {setDtls(info);} },
          /**
           * Mid-call renegotiation hook — fires when the PEER tapped
           * Camera on a voice call. We've already applied their reoffer
           * and `pc.ontrack` will fire for their new video stream
           * (sender path is independent). We deliberately do NOT
           * acquire OUR camera here — that would auto-enable the
           * responder's webcam without consent. Instead we just flag
           * `peerAddedVideo` so the UI can show "Peer turned on video.
           * Turn on yours too?" with an explicit accept button.
           *
           * If the host (UI) wants symmetric two-way video without
           * prompting, it can call `upgradeToVideo()` reactively when
           * `peerAddedVideo` flips. The createAnswer that follows in
           * the controller will then carry only a recvonly video
           * m-line for the new transceiver — peer→us video flows; our
           * second renegotiation (initiated by upgradeToVideo) adds
           * the us→peer direction.
           */
          onRemoteRenegotiation: () => {
            if (!cancelled) {setPeerAddedVideo(true);}
            // Best-effort registry mirror so the floating overlay can
            // pick up the change too (it reads from the registry, not
            // from this hook's state).
            try { patchActiveCall(callKeyRef.current, {kind: 'video' as CallKind}); } catch { /* ignore */ }
          },
          attachLocalMedia: async (pc) => {
            // Single unified path for caller and answerer. Use addTrack
            // with the local MediaStream as the second argument:
            //
            //   • Caller (no remote desc yet, 0 transceivers): addTrack
            //     creates fresh sendrecv transceivers with the stream
            //     bound — outgoing offer has proper a=msid lines.
            //
            //   • Answerer (setRemoteOffer already ran, has recvonly
            //     transceivers): per W3C spec, addTrack REUSES a
            //     compatible recvonly transceiver (kind match, sender
            //     track == null, not stopped) and promotes it to
            //     sendrecv. RN-WebRTC 124's RTCPeerConnection.addTrack
            //     implements this correctly: it checks if native
            //     returned an existing sender ID and updates the
            //     transceiver in place — no duplicate m-lines.
            //
            // Why we no longer use replaceTrack on the answerer:
            // replaceTrack binds a track to a sender but does NOT
            // associate the sender with a MediaStream. The answer SDP
            // came out with `a=msid:- <track-id>` (dash = no stream),
            // and in RN-WebRTC the H264/VP8 encoder pipeline only
            // starts producing frames when the sender has a stream
            // binding. Symptom: answer SDP looked correct (sendrecv,
            // ssrc-group:FID, codecs all matched), camera produced
            // frames, encoder initialized — but ZERO RTP packets came
            // out of the answerer's video sender. Audio worked because
            // Opus's track→sink path doesn't require the stream
            // binding for activation.
            //
            // Order: audio first then video. SDP convention puts audio
            // at m-line 0; this also matches the order on the offerer.
            // A9 — acquire local media HERE for the answerer (memoized, so the
            // caller's boot acquisition is reused). The controller calls this
            // at the spec-correct moment per role, which for the answerer is
            // during accept() — so the camera/mic only light after Accept.
            const {stream} = await ensureLocalMedia();
            const localAudio = stream.getTracks().find(t => t.kind === 'audio');
            const localVideo = stream.getTracks().find(t => t.kind === 'video');
            const addTrack = (pc as unknown as {addTrack: (t: unknown, ...streams: unknown[]) => unknown}).addTrack;
            if (localAudio) {
              try { addTrack.call(pc, localAudio, stream); } catch (e) { console.warn('[useCall] addTrack(audio) failed:', (e as Error).message); }
            }
            if (localVideo) {
              // Fix #21: addTrack(video) failure must surface — the
              // previous warn-and-continue degraded a video call into
              // a half-broken audio-only session: outer state machine
              // thinks we're 'connecting' to video, the local video
              // track is acquired and previewed, but the peer never
              // gets video frames because no sender was bound. Hard
              // fail instead so the CallScreen flips to 'failed' and
              // the user can retry rather than sit confused.
              try {
                addTrack.call(pc, localVideo, stream);
              } catch (e) {
                console.warn('[useCall] addTrack(video) failed — failing the call:', (e as Error).message);
                throw e;
              }
              // ── Low-bandwidth resilience ────────────────────────────
              // On weak networks (slow 3G, congested wifi) the default
              // WebRTC encoder pegs at ~2 Mbps and starts dropping
              // FRAMES the moment RTT spikes — the receiver sees 1-2 fps
              // strobe-light video. We want the opposite: keep ~24 fps
              // motion smooth, drop RESOLUTION instead. Two knobs:
              //   • degradationPreference='maintain-framerate' — tells
              //     the encoder to lower res first, framerate last.
              //   • maxBitrate=600 kbps — cellular-friendly ceiling.
              //     360p@24fps fits comfortably; 480p when the link
              //     can carry it. Without a cap the encoder over-shoots
              //     on a brief speedtest, then can't sustain it.
              // Both are best-effort — RN-WebRTC 124 supports
              // setParameters on Android; iOS is a partial impl. Wrap
              // in try so an unsupported codec path doesn't kill the
              // call. Tagged for logcat: [bravo.callquality].
              try {
                const senders = (pc as unknown as {getSenders?: () => Array<{
                  track: MediaStreamTrack | null;
                  getParameters?: () => RTCRtpSendParameters;
                  setParameters?: (p: RTCRtpSendParameters) => Promise<void>;
                }>}).getSenders?.() ?? [];
                const vSender = senders.find(s => s.track?.kind === 'video');
                if (vSender?.getParameters && vSender.setParameters) {
                  const params = vSender.getParameters();
                  // Older spec puts encodings on the parent; mutate in place.
                  if (!params.encodings || params.encodings.length === 0) {
                    (params as unknown as {encodings: Array<unknown>}).encodings = [{}];
                  }
                  for (const enc of params.encodings as Array<{maxBitrate?: number; maxFramerate?: number; scaleResolutionDownBy?: number}>) {
                    enc.maxBitrate    = 600_000;       // 600 kbps cap
                    enc.maxFramerate  = 30;
                  }
                  (params as unknown as {degradationPreference?: string}).degradationPreference = 'maintain-framerate';
                  await vSender.setParameters(params);
                  console.log('[bravo.callquality] sender params set: maintain-framerate, maxBitrate=600k');
                }
                // ── Latency: pin audio sender to mono Opus @ 32 kbps ───
                // Without an explicit cap the engine can sprint to 64
                // kbps stereo on a fast initial measurement, then have
                // to throttle back the moment congestion hits — that
                // throttle takes one full RTT and the receiver's jitter
                // buffer absorbs the gap by GROWING (silent latency
                // creep). priority+networkPriority='high' asks the OS
                // packet scheduler / DSCP layer to deliver audio ahead
                // of video where the kernel honours it (RN-WebRTC 124
                // wires this through to Android's QoS DSCP marking).
                const aSender = senders.find(s => s.track?.kind === 'audio');
                if (aSender?.getParameters && aSender.setParameters) {
                  const params = aSender.getParameters();
                  if (!params.encodings || params.encodings.length === 0) {
                    (params as unknown as {encodings: Array<unknown>}).encodings = [{}];
                  }
                  for (const enc of params.encodings as Array<{maxBitrate?: number; priority?: string; networkPriority?: string}>) {
                    enc.maxBitrate      = 32_000;
                    enc.priority        = 'high';
                    enc.networkPriority = 'high';
                  }
                  await aSender.setParameters(params);
                  console.log('[bravo.callquality] audio sender params set: maxBitrate=32k, networkPriority=high');
                }
              } catch (e) {
                console.warn('[bravo.callquality] setParameters failed:', (e as Error).message);
              }
            }
          },
        };
        const controller = new CallController(controllerOpts);
        controllerRef.current = controller;
        setControllerReady(true);
        logCallLat(direction === 'outgoing' ? '1to1-out' : '1to1-in', callId, 'controller:ready');

        // 5a. Set descriptor BEFORE registering signalling, so when the
        // dispatcher drains pre-registration frames into the freshly-
        // wired handlers, the controller accepts them instead of
        // bailing on the descriptor check.
        if (direction === 'incoming' && incomingSdp) {
          controller.handleIncomingOffer({callId, from: peer, sdp: incomingSdp, kind});
        }

        // 5b. Register signalling. The dispatcher will synchronously
        // drain any frames it queued during the answerer's getUserMedia
        // window into sig.ingest(), which now hits the wired handlers
        // with the descriptor in place. ICE candidates land in the
        // controller's pendingIce queue and are drained when the user
        // taps accept and setRemoteOffer resolves.
        unregister = registerSignalling(callId, signalling);
        unregisterRef.current = unregister;

        // BS-021 — subscribe to peer media-state advisories. The peer
        // calls `sendMediaState(...)` whenever they flip their camera
        // or mic; we mirror that into local React state so CallScreen
        // can swap the remote tile for a "Camera off" placeholder.
        // Best-effort: handler errors must NEVER crash the call —
        // wrap in try/catch and just log.
        // WI-1.4 — owned registration, same owner key the adopt branch uses, so
        // a restore REPLACES this handler instead of stacking a second one.
        const unregisterMediaState = signalling.onMediaStateOwned(mediaStateOwner(callId), d => {
          if (d.callId !== callId) {return;} // safety: only our call
          if (typeof d.cameraOff === 'boolean') {
            setRemoteVideoOff(d.cameraOff);
          }
          if (typeof d.micOff === 'boolean') {
            setRemoteMuted(d.micOff);
          }
          // Audit CALL-N11 — persist so a later minimize→restore rehydrates
          // the peer's camera/mic state instead of showing a frozen tile.
          try {
            const reg = require('../runtime/callRegistry') as typeof import('../runtime/callRegistry');
            reg.patchActiveCall(callKeyRef.current, {remoteVideoOff: d.cameraOff, remoteMuted: d.micOff});
          } catch { /* best-effort */ }
        });
        // Attach to the existing unregister chain so cleanup tears it
        // down with the rest of the signalling registration.
        const composedUnregister = (): void => {
          try { unregisterMediaState(); } catch { /* ignore */ }
          try { unregister?.(); } catch { /* ignore */ }
        };
        unregisterRef.current = composedUnregister;

        // Publish to the registry so floating-overlay + resume paths
        // can find this call's refs after CallScreen unmounts.
        //
        // WI-1.1 — the returned key is this instance's licence to mutate the
        // slot. Every write above ran unkeyed until now and was dropped by
        // design (the seed below carries the same refs); every write after
        // this point is keyed by it.
        callKeyRef.current = setActiveCall({
          callId,
          conversationId: callId, // best-effort; CallScreen will patch with the real id
          peer,
          peerName: '', // CallScreen patches with the convo name
          kind,
          direction,
          controller,
          signalling,
          unregister,
          // A9 — refs are populated by ensureLocalMedia: at boot for outgoing,
          // at accept-time for incoming (null during ring). ensureLocalMedia
          // patches the registry when the deferred media lands.
          localStream:  localStreamRef.current,
          remoteStream: null,
          audioTrack:   audioTrackRef.current,
          videoTrack:   videoTrackRef.current,
          // Audit CALL-N13 — for an incoming call handleIncomingOffer already
          // transitioned the controller to 'ringing' by now; registering
          // 'idle' made the floating overlay show "Connecting…" for a
          // minimized ring. Outgoing stays 'idle' until startOutgoing runs.
          state:        direction === 'incoming' ? 'ringing' : 'idle',
          isMinimized:  false,
          keepAlive:    false,
          connectedAtMs: null,
        });

        // 6. Kick the OUTGOING side off — for incoming we already ran
        // handleIncomingOffer above (had to be before registerSignalling).
        if (direction === 'outgoing' && !cancelled) {
          // Audit CALL-N15 (2026-07-02): ghost-redial guard. If this boot came
          // from an overlay restore whose call ended between the overlay's
          // registry check and this effect (the adopt branch found nothing),
          // the route still carries the ENDED call's callId — dialing now
          // would silently re-call the peer. A genuine fresh dial mints a new
          // callId, so a recently-ended one can only be a stale restore.
          {
            const reg = require('../runtime/callRegistry') as typeof import('../runtime/callRegistry');
            if (reg.wasRecentlyEnded(callId)) {
              console.log('[useCall] boot skipped — callId recently ended (stale restore, not re-dialing)');
              setState('ended');
              return;
            }
          }
          // CallKit/Telecom — show the outgoing-call system UI before
          // we dial so locking the phone immediately after tap doesn't
          // lose the call. On Android Telecom this also requests audio
          // focus via the Telecom layer, which prevents music apps from
          // continuing to play over the call. iOS skeleton no-ops.
          try {

            const {reportOutgoingCall} = require('../push/callKitBridge') as typeof import('../push/callKitBridge');
            reportOutgoingCall({
              callId,
              calleeName: peer.userId.slice(0, 8), // CallScreen patches the registry with the real name
              kind:       kind === 'video' ? 'video' : 'voice',
            });
          } catch { /* bridge inactive */ }

          await controller.startOutgoing({callId, peer, kind});
        }
      } catch (err) {
        if (!cancelled) {setState('failed');}
        // Surface to the screen — caller decides whether to alert.
        console.warn('[useCall] boot failed:', (err as Error).message);
      }
    })();

    return () => {
      cancelled = true;
      // Honor "keep-alive" minimization: if the user navigates away
      // while the call is minimized, we WANT the controller + media
      // tracks to keep running. The floating overlay component reads
      // the same refs and renders a tiny preview / control bar. The
      // hangup happens later via the overlay's end button or when the
      // controller transitions to 'ended' / 'failed'.

      const {getActiveCall: getActiveCallNow} = require('../runtime/callRegistry') as typeof import('../runtime/callRegistry');
      const stillAlive = getActiveCallNow();
      if (stillAlive?.keepAlive && stillAlive.callId === callId) {
        // Drop our local refs so React state isn't pinned, but the
        // registry's references keep the underlying objects alive.
        if (statsTimer.current) {clearInterval(statsTimer.current);}
        return;
      }
      // Stop tracks BEFORE controller.hangup() so the encoder thread
      // isn't bound to a transport mid-close. RN-WebRTC has documented
      // Android races where pc.close() before track.stop() leaves
      // AudioRecord / Camera2 capture sessions orphaned (mic/camera
      // LED stuck on). Ordering: detach tracks → close PC → unregister
      // signalling. Each .stop() in try/catch — Pixel 6a's RN-WebRTC
      // build throws InvalidStateError on already-stopped tracks
      // (state='ended' state hook already ran), which would otherwise
      // kill the rest of cleanup before unregisterRef fires and leak a
      // dispatcher entry.
      try { audioTrackRef.current?.stop(); } catch { /* already-stopped or native quirk */ }
      try { videoTrackRef.current?.stop(); } catch { /* already-stopped or native quirk */ }
      audioTrackRef.current = null;
      videoTrackRef.current = null;
      try { controllerRef.current?.hangup('ended'); } catch { /* idempotent */ }
      try { unregisterRef.current?.(); } catch { /* ignore */ }
      // (Fix #5) Removed fallbackHandle.current?.cancel() — the ref
      // was never assigned, so the call was a no-op. AgoraFallback
      // wiring was scaffolding, not real integration.
      if (statsTimer.current) {clearInterval(statsTimer.current);}
      localStreamRef.current = null;
      setLocalStream(null);
      setRemoteStream(null);
    };
  // Re-run the boot when the call becomes "live": peer.userId and
  // callId start as placeholders ('demo') while CallScreen waits on
  // turn-credentials + transport to be ready. Once both are real the
  // effect fires for real and the offer goes to the right device.
  //
  // B-102 A2 — sdpEverPresentRef: the incoming-SDP guard above used to be a
  // TOMBSTONE — on killed/Doze paths this effect ran before the offer
  // replay, bailed on the missing SDP, and never re-ran (SDP wasn't a dep),
  // leaving controllerRef null forever → Accept/Decline silent no-ops. The
  // sticky key flips false→true exactly once, when the offer SDP first
  // lands (the bailed run registered NO cleanup, so nothing is torn down),
  // and never flips back — a later params replace WITHOUT the SDP (overlay
  // restore, notification tap) cannot re-fire or tear down a live boot.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peer.userId, callId, transport, sdpEverPresentRef.current]);

  // ── Stats sampling — RTT / jitter / packet-loss every 1s ──
  // [CALLLAT] — the "first remote audio bytes" row is one-shot PER CALL, not
  // per stats-effect run (a connected→reconnecting→connected flap re-creates
  // the effect — review round 2).
  const firstAudioCallRef = useRef<string | null>(null);
  useEffect(() => {
    if (state !== 'connected') {
      if (statsTimer.current) { clearInterval(statsTimer.current); statsTimer.current = null; }
      setStats(EMPTY_STATS);
      return;
    }
    let lastBytes = 0;
    let lastAt    = Date.now();
    // O-A — poller-scoped trackers: inbound video frame counter (stale
    // placeholder self-heal) and the transport state edge detector
    // (re-assert our media-state advisory after a reconnect).
    let lastVideoFrames    = -1;
    let lastTransportState: string | null = null;
    statsTimer.current = setInterval(() => {
      void (async () => {
      // Fix #3: tick may fire AFTER the call is torn down — the React
      // state cleanup runs only after the next render commits, so a
      // hangup-while-tick-was-queued path lets the stale closure
      // call .getStats on a closed PC. Guard at the TOP using both
      // the controller's own state machine AND the PC wrapper's
      // isClosed() flag (added in Fix #19).
      const ctl = controllerRef.current as unknown as {
        pc?: {raw?: {getStats?: () => Promise<unknown>}; isClosed?: () => boolean};
        currentState?: string;
      } | null;
      if (!ctl) {return;}
      if (ctl.currentState === 'ended' || ctl.currentState === 'failed') {return;}
      const wrapper = ctl.pc;
      if (!wrapper) {return;}
      if (typeof wrapper.isClosed === 'function' && wrapper.isClosed()) {return;}
      const pc = wrapper.raw;
      if (!pc?.getStats) {return;}
      try {
        const reportMaybe = await pc.getStats();
        const reports: Array<Record<string, unknown>> = [];
        if (reportMaybe && typeof (reportMaybe as Map<string, unknown>).forEach === 'function') {
          (reportMaybe as Map<string, Record<string, unknown>>).forEach(r => reports.push(r));
        } else {
          for (const r of reportMaybe as Iterable<Record<string, unknown>>) {reports.push(r);}
        }
        // Pull RTT from the candidate-pair, jitter + loss from inbound RTP.
        const cp = reports.find(r => r.type === 'candidate-pair' && r.state === 'succeeded');
        const inbound = reports.find(r => r.type === 'inbound-rtp' && r.kind === 'audio');
        const now     = Date.now();
        const bytes   = (inbound?.bytesReceived as number) ?? 0;
        const delta   = (bytes - lastBytes) / Math.max(1, (now - lastAt) / 1000);
        lastBytes = bytes; lastAt = now;
        // [CALLLAT] — one-shot "the first remote audio bytes landed" row; the
        // closest release-visible proxy for "the other side is audible".
        if (firstAudioCallRef.current !== callId && bytes > 0) {
          firstAudioCallRef.current = callId;
          logCallLat(direction === 'outgoing' ? '1to1-out' : '1to1-in', callId, 'audio:first-inbound', {bytes});
        }
        // BS-CALL-DUPMIC — local mic level for the UI waveform, read off the
        // capture the call ALREADY owns. `media-source` (kind=audio) is the
        // spec stat for a local track; some RN-WebRTC builds only populate the
        // level on the outbound-rtp entry, so fall back to that rather than
        // reintroducing a second recorder when one build is thin.
        const micSrc = reports.find(r => r.type === 'media-source' && r.kind === 'audio')
          ?? reports.find(r => r.type === 'outbound-rtp' && r.kind === 'audio');
        const rawLevel = micSrc?.audioLevel;
        setStats({
          micLevel:       typeof rawLevel === 'number' && Number.isFinite(rawLevel)
            ? Math.max(0, Math.min(1, rawLevel))
            : null,
          rttMs:          cp ? Math.round(((cp.currentRoundTripTime as number) ?? 0) * 1000) : null,
          jitterMs:       inbound ? Math.round(((inbound.jitter as number) ?? 0) * 1000) : null,
          packetLossPct:  inbound && (inbound.packetsLost as number | undefined) !== undefined && (inbound.packetsReceived as number | undefined)
            ? Math.round(100 * (inbound.packetsLost as number) / Math.max(1, (inbound.packetsLost as number) + (inbound.packetsReceived as number)))
            : null,
          bytesPerSecond: Number.isFinite(delta) ? Math.round(delta) : null,
        });
        // O-A self-heal (VIDEO_CALL_RENDER_ISSUES_HANDOFF §4) — the
        // "Camera off" placeholder is checked BEFORE remoteHasVideo, so
        // a stale advisory (frame lost in a WS blip; nothing reconciles
        // it) masked LIVE remote video forever. If inbound video frames
        // are advancing while the flag is set, the flag is lying — clear
        // it. Threshold of 3 frames/tick filters out a trailing packet
        // right after a genuine camera-off.
        const vin = reports.find(r => r.type === 'inbound-rtp' && r.kind === 'video');
        const vFrames = (vin?.framesReceived as number | undefined)
          ?? (vin?.framesDecoded as number | undefined) ?? 0;
        if (lastVideoFrames >= 0 && remoteVideoOffRef.current && vFrames >= lastVideoFrames + 3) {
          setRemoteVideoOff(false);
          try {
            const reg = require('../runtime/callRegistry') as typeof import('../runtime/callRegistry');
            reg.patchActiveCall(callKeyRef.current, {remoteVideoOff: false});
          } catch { /* best-effort */ }
          console.log('[bravo.call] stale remoteVideoOff cleared by frames-received self-heal');
        }
        lastVideoFrames = Math.max(lastVideoFrames, vFrames);
      } catch { /* transient — keep last sample */ }
      // O-A re-assert (sender side) — an advisory only rides toggle
      // events, so one dropped frame leaves the PEER's placeholder
      // stale until our next toggle. Detect the transport coming back
      // from a blip and re-emit our current camera/mic state (cheap,
      // idempotent on the receiver).
      try {
        const ts = (transport as unknown as {state?: string} | null)?.state ?? null;
        if (ts === 'connected' && lastTransportState !== null && lastTransportState !== 'connected') {
          const sig = signallingRef.current;
          if (sig && callId && peer.userId && peer.userId !== 'demo') {
            const v = videoTrackRef.current;
            const cameraOff = !v || v.readyState === 'ended' || !v.enabled;
            const a = audioTrackRef.current;
            sig.sendMediaState(callId, peer, cameraOff, a ? !a.enabled : false);
            console.log('[bravo.call] media-state re-asserted after transport reconnect');
          }
        }
        lastTransportState = ts;
      } catch { /* best-effort */ }
      })();
    }, 1000);
    return () => {
      if (statsTimer.current) { clearInterval(statsTimer.current); statsTimer.current = null; }
    };
  // Why: `direction` is a route param fixed for the hook's life — listing it
  // would only re-run the poller; keep the deps the poller actually keys on.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, transport, callId, peer]);

  // ── Controls ────────────────────────────────────────────
  const accept = useCallback(async (): Promise<boolean> => {
    // Why: B-319 — before iceServers resolve there is no controller; the old
    // `?.accept()` resolved silently and CallScreen latched on a no-op, leaving
    // "Answering…" stuck forever. Refuse LOUDLY, and refuse BEFORE the bridge
    // calls so a doomed attempt can't answer the CXCall / burn the dedupe.
    if (!controllerRef.current) {
      console.warn('[CALLDIAG] accept ignored — controller not built yet (B-319)');
      return false;
    }
    // WI-4.7 — the caller may have cancelled while this device was still
    // routing the Answer (notification tap → cold nav → controller build).
    // Every cancel lane tombstones the callId; the dead-offer watchdog polls
    // that tombstone at 1 Hz, but in the sub-tick window an un-gated accept
    // answered the CXCall, burned the accept dedupe and sent `call.answer` at
    // a peer that had already hung up. Refuse BEFORE the bridge calls, same
    // as B-319's bail. Returning false releases CallScreen's one-shot latch;
    // the watchdog's own probe makes the verdict terminal within a tick.
    if (callId) {
      try {
        const cache = require('../push/incomingCallCache') as typeof import('../push/incomingCallCache');
        if (cache.isIncomingCallDead(callId)) {
          console.warn('[CALLDIAG] accept refused — callId tombstoned, caller already cancelled (WI-4.7)');
          return false;
        }
      } catch { /* cache unavailable (tests) — accept proceeds */ }
    }
    // B-109 RC-3 — an in-app accept must also answer the CallKit CXCall on
    // iOS, or the ring stays pending forever (no lock protection + the
    // stale ring's dismissal used to decline the live call). Pre-latch the
    // accept-dedupe FIRST: reportAnswered re-emits `answerCall`, and the
    // latch is what stops that event from double-navigating/double-answering.
    if (callId) {
      try {
        const fb = require('../push/fcmBootstrap') as typeof import('../push/fcmBootstrap');
        fb.markCallAccepted(callId);
        const bridge = require('../push/callKitBridge') as typeof import('../push/callKitBridge');
        bridge.reportAnswered(callId);
      } catch { /* bridge inert / headless — accept proceeds regardless */ }
    }
    await controllerRef.current.accept();
    return true;
  }, [callId]);
  const decline = useCallback(() => {
    const hadController = controllerRef.current !== null;
    controllerRef.current?.decline();
    return hadController;
  }, []);
  const hangup = useCallback(() => {
    const c = controllerRef.current;
    if (c) {
      c.hangup('ended');
    } else {
      // Boot-window safety — the controller isn't built until iceServers +
      // transport + peer resolve (outgoing state sits at 'idle' until then).
      // Without this, End on a still-booting call is a silent no-op (state
      // never reaches 'ended'), stranding the user on a dead End button
      // ("End does not end"). Force the registry/audio/FG-service teardown.
      try {
        const {endActiveCall} = require('../runtime/callRegistry') as typeof import('../runtime/callRegistry');
        // WI-1.1 — `callId` (the weak ref form) is deliberate: in the
        // null-controller boot window this instance never registered, so it has
        // no generation to cite. Requiring the id to match is still what stops
        // it ending some other call that took the slot meanwhile.
        endActiveCall(callKeyRef.current ?? callId, 'ended', 'local');
      } catch { /* ignore */ }
    }
  }, [callId]);

  const toggleMute = useCallback(() => {
    const t = audioTrackRef.current;
    if (!t) {return;}
    t.enabled = !t.enabled;
    const micOff = !t.enabled;
    setIsMuted(micOff);
    // Audit CALL-N11 — persist so a restore rehydrates the mute state.
    try {
      const reg = require('../runtime/callRegistry') as typeof import('../runtime/callRegistry');
      reg.patchActiveCall(callKeyRef.current, {isMuted: micOff});
    } catch { /* best-effort */ }
    // BS-021 — emit advisory so the peer sees a "Mic off" indicator on
    // our tile. Best-effort: a closed transport drops the frame and
    // the call would already be tearing down.
    const sig = signallingRef.current;
    const v = videoTrackRef.current;
    // Audit CALL-N8 (2026-07-02): the A8 camera-release path keeps the ENDED
    // video track on the sender (so it stays findable by kind for re-acquire),
    // and stop() does NOT clear `.enabled`. So `!v.enabled` alone reported
    // cameraOff:false while the camera was actually released — the peer then
    // un-hid the "Camera off" placeholder onto a frozen/black tile. Treat an
    // ended (released) track as camera-off.
    const cameraOff = !v || v.readyState === 'ended' || !v.enabled;
    if (sig && callId && peer.userId) {
      try { sig.sendMediaState(callId, peer, cameraOff, micOff); }
      catch { /* swallow — best effort */ }
    }
    // CallKit/Telecom — mirror local mute into the system UI so the
    // lock-screen / system call sheet shows the right mute icon. iOS
    // accepts programmatic mute via setMutedCall; Android Telecom
    // exposes mute only through the system UI itself, so this is a
    // no-op there (the OS will fire didPerformSetMutedCallAction back
    // into our handler when the user taps mute from the system sheet).
    try {

      const {reportMuteChange} = require('../push/callKitBridge') as typeof import('../push/callKitBridge');
      reportMuteChange(callId, micOff);
    } catch { /* bridge inactive */ }
  }, [callId, peer]);

  // A8 video-toggle-camera-not-released — re-entrancy + released-state guards.
  // togglingVideoRef coalesces rapid double-taps (the async stop/re-acquire is
  // not instant); videoReleasedRef remembers that OFF stopped the camera but
  // KEPT its (now-ended) track on the RTCRtpSender, so ON is a cheap
  // replaceTrack re-acquire rather than a full SDP voice→video upgrade.
  const togglingVideoRef = useRef(false);
  const videoReleasedRef = useRef(false);
  /**
   * Toggle the local camera. Unlike the old build (which only flipped
   * `track.enabled` and left the camera hardware capturing — privacy LED lit,
   * black frames on the wire), this now RELEASES the camera on OFF
   * (`track.stop()`) and RE-ACQUIRES it on ON via `replaceTrack` onto the
   * existing video sender — mirroring the group-call path. Stays synchronous
   * and returns boolean so the caller's contract is unchanged: `true` means
   * "this was a real camera toggle" (the async work fires internally), `false`
   * means a genuine voice-only call (no video sender, nothing released) so the
   * caller kicks off the SDP voice→video upgrade pipeline instead.
   */
  const toggleVideo = useCallback((): boolean => {
    // Genuine voice-only call → defer to the caller's upgrade pipeline.
    if (!videoTrackRef.current && !videoReleasedRef.current) {return false;}
    // A real camera toggle. Swallow a double-tap while one is in flight.
    if (togglingVideoRef.current) {return true;}
    togglingVideoRef.current = true;
    void (async () => {
      try {
        // BS-021 — emit the media-state advisory so the peer swaps their tile
        // for a "Camera off" placeholder (camera released → RTP stops; without
        // the advisory the receiver can't tell muted from frozen).
        const emitState = (cameraOff: boolean) => {
          const sig = signallingRef.current;
          const a = audioTrackRef.current;
          const micOff = a ? !a.enabled : false;
          if (sig && callId && peer.userId) {
            try { sig.sendMediaState(callId, peer, cameraOff, micOff); }
            catch { /* swallow — best effort */ }
          }
        };
        // ── OFF — release the camera (stop the capturer + privacy LED) ────
        // KEEP the now-ended track on the sender so the sender stays findable
        // by kind for the re-acquire below (same invariant recoverCamera/B-20
        // rely on). Rebuild the local stream without video so the PiP clears.
        if (videoTrackRef.current && !videoReleasedRef.current) {
          const t = videoTrackRef.current;
          try { t.stop(); } catch { /* ignore */ }   // releases the camera + LED
          videoReleasedRef.current = true;
          setIsVideoOff(true);
          const audio = audioTrackRef.current;
          const rebuilt = audio ? new MediaStream([audio]) : new MediaStream([]);
          setLocalStream(rebuilt);
          try {
            const reg = require('../runtime/callRegistry') as typeof import('../runtime/callRegistry');
            reg.patchActiveCall(callKeyRef.current, {videoTrack: null, localStream: rebuilt, isVideoOff: true});
          } catch { /* best-effort registry refresh */ }
          emitState(true);
          console.log('[bravo.callvideo] toggleVideo OFF — camera released (sender preserved)');
          return;
        }
        // ── ON — re-acquire the camera onto the existing video sender ─────
        const pc = (controllerRef.current as unknown as {pc?: {raw?: unknown}})?.pc?.raw;
        if (!pc) {
          // Still connecting — the sender isn't built yet. Leave the flag set
          // so the next tap (post-connect) re-acquires.
          console.log('[bravo.callvideo] toggleVideo ON skipped — call not yet connected');
          return;
        }
        const next = await recoverCamera({
          pc:           pc as never,
          facing:       facingRef.current,
          currentTrack: videoTrackRef.current,
        });
        if (next) {
          videoTrackRef.current = next;
          videoReleasedRef.current = false;
          setIsVideoOff(false);
          const audio = audioTrackRef.current;
          const fresh = new MediaStream(audio ? [audio, next] : [next]);
          setLocalStream(fresh);
          try {
            const reg = require('../runtime/callRegistry') as typeof import('../runtime/callRegistry');
            reg.patchActiveCall(callKeyRef.current, {videoTrack: next, localStream: fresh, isVideoOff: false});
          } catch { /* best-effort registry refresh */ }
          emitState(false);
          console.log('[bravo.callvideo] toggleVideo ON — camera re-acquired (replaceTrack)');
        } else {
          // No video sender / acquisition failed — leave released so a retry
          // tap can try again (matches the resume recoverCamera convention).
          console.warn('[bravo.callvideo] toggleVideo ON failed — camera not re-acquired');
        }
      } finally {
        togglingVideoRef.current = false;
      }
    })();
    return true;
  }, [callId, peer]);

  /**
   * Mid-call voice→video upgrade. The host calls this when the user
   * taps Camera on a voice call. Steps:
   *   1. Mark UI busy (isUpgrading=true) so the button can't double-fire.
   *   2. Acquire camera + setLocalStream so the local PiP shows a
   *      preview while the SDP round-trip is in flight (instant feedback).
   *   3. Hand off to controller.upgradeToVideo({prepare}) which:
   *        a. Validates state (call connected, no glare, etc.)
   *        b. Calls our prepare() — addTrack(video, stream) +
   *           setParameters({maintain-framerate, 600k cap})
   *        c. createOffer + setLocalDescription + sendReOffer
   *        d. Awaits call.reanswer (10s watchdog)
   *        e. setRemoteDescription(answer)
   *   4. On success: patch the registry to kind: 'video' so the
   *      floating overlay swaps to video mode, fire BS-021 advisory
   *      so peer's UI updates the camera-on indicator.
   *   5. On failure: stop the new track, drop the stream rebuild,
   *      restore prior video-off React state. The PC sender stays
   *      around (harmless — peer never saw the m-line because we
   *      never sent the reoffer or it was rejected).
   *
   * Throws on any failure so the caller (CallScreen) can show an
   * Alert. Resolves quietly when the call already has video (idempotent).
   */
  const upgradeToVideo = useCallback(async (): Promise<void> => {
    if (videoTrackRef.current) {
      // Already have video — nothing to do. Caller's UI should treat
      // this as a no-op (the Camera button on a video call is already
      // bound to toggleVideo, not upgradeToVideo).
      return;
    }
    const ctl = controllerRef.current;
    if (!ctl) {throw new Error('upgradeToVideo: call not active');}
    if (ctl.currentState !== 'connected') {
      throw new Error(`upgradeToVideo: call must be connected (got ${ctl.currentState})`);
    }
    const baseStream = localStreamRef.current;
    if (!baseStream) {throw new Error('upgradeToVideo: no local stream');}

    setIsUpgrading(true);
    let acquired: {stream: MediaStream; videoTrack: MediaStreamTrack | null} | null = null;
    try {
      // Acquire camera FIRST, outside the controller's lock — the OS
      // permission prompt may take many seconds (the user reads it,
      // taps Allow, then the camera warms up). Doing this inside
      // controller.upgradeToVideo would hold the lock for the prompt
      // duration; if anything else (e.g. AppState handler) tried to
      // touch state in that window it'd be confusing. Acquiring here
      // also lets us bail with a clean rollback if the user denies.
      const fresh = await getLocalMedia({video: true});
      if (!fresh.videoTrack) {
        throw new Error('upgradeToVideo: getUserMedia returned no video track');
      }
      // Stop the bonus audio track that getLocalMedia returns (we
      // already have an audio track from the initial accept). Keeping
      // it would create a second mic capture and the encoder would
      // pick one arbitrarily — easy way to end up muted-on-the-wire.
      try { fresh.audioTrack?.stop(); } catch { /* ignore */ }
      acquired = {stream: fresh.stream, videoTrack: fresh.videoTrack};

      // Update the local PiP IMMEDIATELY so the user sees their face
      // in the small preview tile while the SDP round-trip happens.
      // We splice the new video track into the EXISTING audio-bearing
      // MediaStream so addTrack(track, stream) on the PC associates
      // them in the same a=msid group on the wire — without that, the
      // peer sees two MediaStreams and our local PiP can't render
      // both via a single RTCView.
      try {
        baseStream.addTrack(fresh.videoTrack);
      } catch (e) {
        console.warn('[useCall.upgradeToVideo] baseStream.addTrack failed:', (e as Error).message);
        // Some RN-WebRTC builds reject addTrack on a stream the engine
        // already consumed. Fall back to a fresh MediaStream that
        // includes both tracks; ontrack on the peer side still works
        // because the SDP a=msid lines come from the addTrack on the
        // PC (below), not from the local MediaStream object.
      }

      videoTrackRef.current = fresh.videoTrack;
      // Push a NEW MediaStream to React state so the RTCView re-attaches
      // (same trick as toggleVideo / flipCamera). React identity check
      // skips the re-render if we hand it the same object even though
      // it now has an extra track.
      const audio = audioTrackRef.current;
      const previewStream = new MediaStream(
        [audio, fresh.videoTrack].filter((x): x is MediaStreamTrack => !!x),
      );
      setLocalStream(previewStream);
      setIsVideoOff(false);

      // Hand off to the controller. The prepare() callback runs
      // INSIDE the renegotiation lock, after state validation, before
      // createOffer — exactly where addTrack(video) belongs.
      await ctl.upgradeToVideo({
        prepare: async (pc) => {
          const addTrack = (pc as unknown as {addTrack: (t: unknown, ...streams: unknown[]) => unknown}).addTrack;
          // addTrack(video, stream) — stream must be the SAME object
          // we used for the initial audio addTrack so the peer parses
          // them as one MediaStream (a=msid:<streamId> on both
          // m-lines). Otherwise the peer would see two MediaStreams
          // and useCall on their side would route the video to a
          // stream that has no audio.
          try {
            addTrack.call(pc, fresh.videoTrack, baseStream);
          } catch (e) {
            console.warn('[useCall.upgradeToVideo] pc.addTrack failed:', (e as Error).message);
            throw e;
          }

          // Apply the same maintain-framerate / 600 kbps cap that the
          // initial-offer path applies. RN-WebRTC will otherwise peg
          // the new sender at the default 2 Mbps and drop frames hard
          // on bad cellular — the symptom that the in-call quality
          // tuning notes in attachLocalMedia were written to fix.
          try {
            const senders = (pc as unknown as {getSenders?: () => Array<{
              track: MediaStreamTrack | null;
              getParameters?: () => RTCRtpSendParameters;
              setParameters?: (p: RTCRtpSendParameters) => Promise<void>;
            }>}).getSenders?.() ?? [];
            const vSender = senders.find(s => s.track?.id === fresh.videoTrack!.id);
            if (vSender?.getParameters && vSender.setParameters) {
              const params = vSender.getParameters();
              if (!params.encodings || params.encodings.length === 0) {
                (params as unknown as {encodings: Array<unknown>}).encodings = [{}];
              }
              for (const enc of params.encodings as Array<{maxBitrate?: number; maxFramerate?: number}>) {
                enc.maxBitrate   = 600_000;
                enc.maxFramerate = 30;
              }
              (params as unknown as {degradationPreference?: string}).degradationPreference = 'maintain-framerate';
              await vSender.setParameters(params);
              console.log('[bravo.callquality] upgradeToVideo sender params set');
            }
          } catch (e) {
            console.warn('[bravo.callquality] upgradeToVideo setParameters failed:', (e as Error).message);
          }
        },
      });

      // Success — keep the new track + stream and patch the registry
      // so other consumers (floating overlay, foreground service
      // notification) reflect the new call kind. BS-021 advisory tells
      // the peer our camera is on so they swap their remote-tile
      // placeholder for the live video tile.
      try {
        // patchActiveCall is destructured inside the boot effect's IIFE
        // and isn't in scope here — re-require at the callsite. Same
        // pattern the rest of useCall uses to dodge the circular
        // import via runtime/callRegistry.

        const reg = require('../runtime/callRegistry') as typeof import('../runtime/callRegistry');
        reg.patchActiveCall(callKeyRef.current, {videoTrack: fresh.videoTrack, localStream: previewStream, kind: 'video' as CallKind});
      } catch { /* ignore — registry refresh is best-effort */ }
      const sig = signallingRef.current;
      if (sig && callId && peer.userId) {
        try { sig.sendMediaState(callId, peer, /* cameraOff */ false, /* micOff */ !(audioTrackRef.current?.enabled ?? true)); }
        catch { /* swallow — best effort */ }
      }
      console.log('[useCall.upgradeToVideo] upgrade complete — call is now video');
    } catch (err) {
      // Roll back local changes so the call stays voice-only and
      // connected. Stopping the track also releases the camera so the
      // user's privacy indicator (camera light) goes off.
      console.warn('[useCall.upgradeToVideo] failed — rolling back:', (err as Error).message);
      if (acquired) {
        try { acquired.videoTrack?.stop(); } catch { /* ignore */ }
        // Try to remove from the base stream too (was best-effort added).
        try {
          if (acquired.videoTrack) {baseStream.removeTrack(acquired.videoTrack);}
        } catch { /* ignore */ }
      }
      videoTrackRef.current = null;
      setIsVideoOff(false); // back to default — there's no video to be off
      // Restore the audio-only stream to React state so the PiP
      // disappears.
      const audio = audioTrackRef.current;
      const restored = audio ? new MediaStream([audio]) : baseStream;
      setLocalStream(restored);
      // O-D (VIDEO_CALL_RENDER_ISSUES_HANDOFF §4) — tell the peer the
      // upgrade is dead. On a slow path they may have ALREADY applied
      // our reoffer (their ontrack fired → video layout mounted for a
      // track that will never carry RTP → full-screen black), and their
      // late reanswer is discarded by our watchdog. The advisory swaps
      // their black tile for the honest "Camera off" placeholder.
      const sigRollback = signallingRef.current;
      if (sigRollback && callId && peer.userId) {
        try {
          sigRollback.sendMediaState(callId, peer, /* cameraOff */ true, !(audioTrackRef.current?.enabled ?? true));
        } catch { /* swallow — best effort */ }
      }
      throw err;
    } finally {
      setIsUpgrading(false);
    }
  }, [callId, peer]);

  const doFlip = useCallback(async () => {
    // Audit CALL-N9 (2026-07-02): do NOT flip while the camera is released
    // (toggled off). flipCamera finds the video sender by kind — the ENDED
    // track kept on the sender still reports kind:'video' — and replaceTracks
    // a fresh LIVE track, silently re-activating the camera and streaming
    // frames to the peer while the local PiP shows the avatar and the peer
    // still shows "Camera off". Turning the camera back on must go through
    // toggleVideo, which re-acquires AND clears the released state + advisory.
    if (videoReleasedRef.current || videoTrackRef.current?.readyState === 'ended') {
      console.log('[bravo.callvideo] flip ignored — camera is off/released');
      return;
    }
    const pc = (controllerRef.current as unknown as {pc?: {raw?: unknown}})?.pc?.raw;
    if (!pc) {return;}
    const next = await flipCamera({
      pc:           pc as never,
      currentTrack: videoTrackRef.current,
      facing,
    });
    if (next) {
      videoTrackRef.current = next;
      const nextFacing = facing === 'user' ? 'environment' : 'user';
      setFacing(nextFacing);
      facingRef.current = nextFacing;
      // Rebuild the local MediaStream so the PiP RTCView picks up the
      // new camera. flipCamera() only replaces the track on the PC's
      // RTCRtpSender — it doesn't touch the stream we hand the
      // SurfaceViewRenderer. Without this, the PiP stays frozen on the
      // last frame of the now-stopped previous track even though the
      // peer's view (from the sender side) is already showing the
      // flipped camera.
      const fresh = new MediaStream(
        audioTrackRef.current ? [audioTrackRef.current, next] : [next],
      );
      setLocalStream(fresh);
      // Audit CALL-N12 — patch the registry so a minimize/restore renders the
      // live flipped track (not the stopped previous one) and endActiveCall
      // stops the CURRENT track, not a stale one. (facing persistence = N11.)
      try {
        const reg = require('../runtime/callRegistry') as typeof import('../runtime/callRegistry');
        reg.patchActiveCall(callKeyRef.current, {videoTrack: next, localStream: fresh, facing: nextFacing});
      } catch { /* best-effort registry refresh */ }
    }
  }, [facing]);

  return {
    state, localStream, remoteStream,
    isMuted, isVideoOff, facing,
    // Mid-call renegotiation surface.
    peerAddedVideo, isUpgrading,
    // BS-021 — peer-side mute/camera mirrors.
    remoteVideoOff, remoteMuted,
    // B-16 — remote video presence (drives the remote tile remount).
    remoteHasVideo,
    stats, dtls,
    accept, decline, hangup,
    controllerReady,
    toggleMute, toggleVideo,
    upgradeToVideo,
    flipCamera: doFlip,
  };
}
