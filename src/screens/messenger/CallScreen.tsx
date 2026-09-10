import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator,
  StatusBar, Animated, Easing, Vibration, PermissionsAndroid, Platform,
  Modal, Pressable, PanResponder, AppState, FlatList, useWindowDimensions,
} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
// B-419 — `Audio` from expo-av is deliberately NOT imported here. This screen
// must never open a second microphone alongside the WebRTC capture; the
// waveform level comes from the engine's own stats (see micLevelRef below).
// Pinned by callCaptureSingleSource.test.ts.
import {RTCView, MediaStream} from 'react-native-webrtc';
import {BackHandler} from 'react-native';
import {patchActiveCall, setMinimized} from '@/modules/messenger/runtime/callRegistry';
import {isDirectPrefixed, peerFromDirectSlot} from '@/modules/messenger/conversationIds';
import {createOpeningRouteSettle, createRoutePickQueue, parseAudioDeviceList, preferredHeadset} from '@/modules/messenger/runtime/callAudioRoute';
import {forceSpeakerFlagFor} from '@/modules/messenger/runtime/callAudioForceFlag';
import {applyCallVolumeFloor, restoreCallVolume} from '@/modules/messenger/runtime/callVolumeFloor';
import {reportAudioRoute} from '@/modules/messenger/push/callKitBridge';
import {UserAvatar} from '@/modules/messenger/ui/UserAvatar';
import {CallQualityBanner, useCallQualityVisible} from '@/modules/messenger/ui/CallQualityBanner';
import type {MessengerScreenProps} from '@navigation/types';
import {navigateToMessengerScreen} from '@navigation/messengerDeepLink';
import {useMessengerStore} from '@/modules/messenger/store';
import {resolveCallConversation, resolveCallPeerName} from '@/modules/messenger/runtime/callPeerName';
import {useAuthStore} from '@store/authStore';
import {useFocusEffect} from '@react-navigation/native';
import {useCall} from '@/modules/messenger/webrtc/useCall';
import {getLiveTransport, onTransport, waitForLiveTransport} from '@/modules/messenger/runtime/transportRegistry';
import {resolveMemberName} from '@/modules/messenger/runtime/groupEventMessage';
import {onPendingOneToOneChange, clearPendingOneToOne} from '@/modules/messenger/webrtc/incomingOneToOneBanner';
import {acceptWaitingCall, declineWaitingCall, type AcceptedCallParams} from '@/modules/messenger/webrtc/callWaiting';
import type {IceServerConfig} from '@/modules/messenger/webrtc/types';
import {safeStreamURL} from '@/modules/messenger/webrtc/safeStreamURL';
import {resolveRemoteTile} from '@/modules/messenger/webrtc/remoteTileGate';
import {snapPipOffset} from '@/modules/messenger/webrtc/pipLayout';
// B-454 — the one mirror rule ("mirror follows the stream"), shared with
// GroupCallScreen so a swapped 1:1 tile can never pair the peer's frame
// with the selfie flip.
import {shouldMirrorTile} from '@/modules/messenger/webrtc/groupCallLayout';
import InCallManager from 'react-native-incall-manager';
import {DeviceEventEmitter} from 'react-native';
import {withScreenErrorBoundary} from '@modules/observability';

type Props = MessengerScreenProps<'CallScreen'>;

/**
 * Audio-route helper. Prefers `InCallManager.chooseAudioRoute(route)`
 * which atomically updates AudioManager mode + speakerphone flag —
 * the only API that reliably switches routes mid-call on Android 13+.
 * Falls back to the legacy `setSpeakerphoneOn` for SPEAKER_PHONE /
 * EARPIECE on older builds where chooseAudioRoute may be missing.
 *
 * The bug this fixes: tapping the Speaker button or BT picker did
 * nothing once a video call had started. Reason — the call was
 * launched with `InCallManager.start({media: 'video'})`, which sets
 * an internal ForceSpeakerphoneOn flag that silently overrides
 * subsequent setSpeakerphoneOn() calls. chooseAudioRoute clears that
 * flag as part of the route change, so it actually takes.
 */
// Video-call backdrop — deep blue-black from the Bravo Video Call design
// (the radial vignette's dominant tone, #080B14, vs the old flat navy
// #0A1F3F). A solid fill stands in for the CSS radial gradient; it reads
// noticeably richer/darker behind the avatar + pulse rings. VISUAL ONLY.
const VC_BG = '#080B14';

// BS-CALL-CHOPPY — last route we actually pushed to the native layer.
// Several effects (speaker toggle, hold/resume, screen-on reapply, video
// upgrade, BT auto-snap) all converge on pickAudioRouteNative, and on a
// call with a Bluetooth headset paired they re-issue the SAME route within
// a few seconds of each other. Each redundant chooseAudioRoute('BLUETOOTH')
// tears down and re-establishes the SCO link (logcat: startSco/stopScoAudio
// → SCO_CONNECTED↔HEADSET_AVAILABLE churn), and every SCO renegotiation
// produces a burst of PCM output underruns (chk_out_pcm_underrun) — that's
// the choppy/stuttering audio. Skipping a route call that's already in
// effect eliminates the churn without changing any caller's logic; a real
// route change (different target) always goes through.
let lastAppliedRoute: 'SPEAKER_PHONE' | 'EARPIECE' | 'BLUETOOTH' | 'WIRED_HEADSET' | null = null;

/**
 * B-278 — drop our cached belief about the hardware route.
 *
 * `lastAppliedRoute` is not the device state, it is only what WE last asked
 * for. Anything that can re-route audio behind our back invalidates it, and
 * until it is cleared the idempotence guard below turns the corrective
 * re-apply into a no-op.
 *
 * The bug: on a Bluetooth call, backgrounding the app (home screen, app switch,
 * another app taking focus) makes Android tear down the SCO link and fall back
 * to the loudspeaker. Coming back, the AppState handler re-applies
 * 'BLUETOOTH' — and the guard sees 'BLUETOOTH' as already applied and returns
 * immediately, so the call stays on speaker for good. The call-state-transition
 * path already clears this for the same reason (the ringback player flips
 * speakerphone underneath us); the AppState path never did.
 */
function invalidateAppliedRoute(): void {
  lastAppliedRoute = null;
}

/**
 * Is the de-dupe cache holding this exact route?
 *
 * Only the restore path needs to ask. Everywhere else "invalidate then apply"
 * is unconditional and cheap, but the restore branch runs on every
 * `onAudioDeviceChanged` — many times through a car's SCO handshake — so
 * clearing the cache there without checking removes the only brake on the churn
 * the guard exists to prevent.
 */
function appliedRouteIs(route: 'SPEAKER_PHONE' | 'EARPIECE' | 'BLUETOOTH' | 'WIRED_HEADSET'): boolean {
  return lastAppliedRoute === route;
}

function pickAudioRouteNative(route: 'SPEAKER_PHONE' | 'EARPIECE' | 'BLUETOOTH' | 'WIRED_HEADSET'): void {
  // Idempotence guard — see lastAppliedRoute above. Redundant re-issues of
  // the current route are the BT-SCO-flap source behind the audio underruns.
  if (route === lastAppliedRoute) {
    return;
  }
  lastAppliedRoute = route;
  // B-391b — tell Android Telecom the SAME target. We register the phone
  // account selfManaged, so the framework route lives on the Connection and
  // was never being set: InCallManager drove AudioManager while Telecom sat
  // on its default. Mirroring (never diverging) is what keeps this safe.
  reportAudioRoute(route);
  // B-276 — ECHO ON HEADPHONES. `InCallManager.start({media:'video'})` sets an
  // internal ForceSpeakerphoneOn flag (see the helper's own docstring above).
  // Three OTHER route paths — the mid-call headset auto-snap, the manual
  // picker, and the device-list re-assert — each explicitly clear that flag
  // before choosing a route. This one never did, and it is the path used by
  // the B-251 MOUNT SEED (headphones already plugged in when the call starts,
  // i.e. the normal case), by the main speaker-toggle application, and by the
  // screen-on restore.
  //
  // Result on a video call with headphones connected: the route says
  // WIRED_HEADSET while the forced loudspeaker keeps playing, so the far end's
  // voice comes out of the phone speaker, the phone mic recaptures it, and both
  // sides get a live acoustic echo loop. Same shape for BLUETOOTH.
  //
  // Set the flag to MATCH the route, so all four paths now agree.
  try {
    // B-391 -- the flag MUST come from forceSpeakerFlagFor, never from
    // `route === 'SPEAKER_PHONE'`. That comparison yields a BOOLEAN, and the
    // library maps boolean false to -1 -> selectAudioDevice(EARPIECE): a
    // sticky user pin. So every attempt to reach BLUETOOTH first told the
    // library the user had chosen the earpiece, which short-circuits its own
    // auto-Bluetooth branch, so startScoAudio() never runs and a CAR
    // hands-free kit is never handed the call. A non-boolean 0 clears the pin
    // instead, and still clears the internal force flag -- the only reason
    // this call exists (B-276 echo). Full trace: callAudioForceFlag.ts.
    (InCallManager as unknown as {setForceSpeakerphoneOn?: (on: boolean | 0) => void})
      .setForceSpeakerphoneOn?.(forceSpeakerFlagFor(route));
  } catch { /* ignore — older builds lack it; chooseAudioRoute below still runs */ }
  // Try the modern API first. We fire BOTH paths in a defensive
  // belt-and-braces — chooseAudioRoute is the only API that reliably
  // switches BT or works mid-video-call, but for SPEAKER_PHONE /
  // EARPIECE on Android stacks where chooseAudioRoute returns a
  // Promise that rejects silently we still need setSpeakerphoneOn
  // to take effect. Worst case both run and the second one is a
  // no-op; that's cheaper than the bug where neither did anything.
  let chooseAttempted = false;
  try {
    const fn = (InCallManager as unknown as {chooseAudioRoute?: (r: string) => unknown})
      .chooseAudioRoute;
    if (typeof fn === 'function') {
      fn.call(InCallManager, route);
      chooseAttempted = true;
    }
  } catch { /* ignore — fall through */ }
  // For SPEAKER / EARPIECE always also flip the speakerphone flag —
  // it's the only thing that takes when the audio session is in
  // auto-mode (voice calls), where chooseAudioRoute is silently
  // overridden by InCallManager's auto-route logic.
  if (route === 'SPEAKER_PHONE' || route === 'EARPIECE') {
    try {
      InCallManager.setSpeakerphoneOn(route === 'SPEAKER_PHONE');
    } catch { /* ignore */ }
  }
  if (!chooseAttempted) {
    console.log('[bravo.callaudio] chooseAudioRoute missing on this build — used setSpeakerphoneOn only');
  }
}

// Why: NA-02 / B-110 — one number for both the accept-intent refusal and the
// dead-offer watchdog, so the two deadlines can never drift apart.
import {ACCEPT_INTENT_TTL_MS, TURN_FETCH_CEILING_MS} from '@/modules/messenger/webrtc/callDeadlines';
import {logCallLat} from '@/modules/messenger/runtime/callDiag';

function CallScreenInner({route, navigation}: Props) {
  const {callType, isIncoming, conversationId, callId, remoteUserId, remoteDeviceId, incomingSdp, autoAccept} = route.params;
  const insets = useSafeAreaInsets();
  // Tracks whether the component is still mounted. Several async
  // continuations (Alert.alert + setState in the upgrade-to-video
  // catch path, the BS-021 peerAddedVideo effect, the audio-permission
  // request, etc.) can resolve AFTER the user hangs up and the screen
  // unmounts. Without this guard the alerts pop up over the parent
  // screen ("Could not turn on video" appearing on the chat thread
  // 5 s after a hung-up call). Set to false in cleanup; checked
  // before every Alert.alert / setState in those async branches.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);
  // Mount-time call kind from the route — the SETUP logic below
  // (camera permission boot, audio-route default, foreground service
  // kind) keys off this and MUST NOT re-run if the call upgrades
  // mid-stream. A separate `isVideoUI` further down (after liveCall
  // is constructed) ORs in "did the live call gain a video track?"
  // and drives the layout choice between voice column vs. video grid.
  const isVideo = callType === 'video';

  // B-695 — the route's conversationId can DIE mid-call (the B-18 merge
  // deletes a synthetic direct:<peer> row when the server-UUID row for the
  // same peer materializes), which is exactly the founder's "minimise the
  // call and return → CONTACT" repro. Resolve the CANONICAL row (falls back
  // through the peer id) and run the B-411 name ladder — name → directory
  // name → phone — instead of the old bare `convo?.name ?? 'Contact'`.
  // Both selectors return store-held references / primitives, so re-render
  // identity stays stable (the N-30 rule).
  const convo = useMessengerStore(s => resolveCallConversation(s, conversationId, remoteUserId));
  const peerName = useMessengerStore(s => resolveCallPeerName(s, conversationId, remoteUserId));
  const peerInitials = peerName.split(' ').map(w => w[0] ?? '').join('').slice(0, 2).toUpperCase() || 'B';

  // ── Real WebRTC engine wiring ────────────────────────────
  //
  // Mode = 'live' when the route carries a callId + the live socket
  // is up + we know the peer SessionAddress. Otherwise we fall back to
  // 'demo' (the prior fake state machine) so opening the screen from
  // older callsites doesn't crash. Once every callsite supplies callId
  // the demo branch can be removed.
  // Subscribe to the live transport so this screen rebinds the moment
  // the WS opens. Plain useMemo would freeze in the "null" state if the
  // socket wasn't open at mount time — leaving the call stuck on
  // peer={demo} forever even after reconnect.
  const [transport, setTransport] = useState(() => getLiveTransport());
  useEffect(() => onTransport(setTransport), []);
  // [CALLLAT] (audit Step 0, §1.2 N3) — the moment this screen has a live
  // transport to bind to (the killed/notification lanes wait here for the
  // runtime boot; the warm lane has it at mount).
  useEffect(() => {
    if (!transport || !callId) {return;}
    logCallLat(isIncoming ? '1to1-in' : '1to1-out', callId, 'transport:live');
  }, [transport, callId, isIncoming]);

  // FIX-16 — on a cold-VM answer there may be no runtime to subscribe TO.
  // Subscribing alone only waits for whoever else boots it, and on a cold
  // launch that is MainNavigator's configure effect, which can be 10-25s out on
  // low-end hardware (B-227). The 40s signalling budget was burning down doing
  // nothing. The GROUP path already solves this by kicking the runtime itself
  // (B-275, useGroupCall); this is the 1:1 twin.
  //
  // Safe to call early: B-272's config gate makes getMessengerRuntime() wait on
  // the ownerKey pin rather than throw, and it is a no-op once MainNavigator
  // has booted it. The restore gate still owns its own refusal — a restore in
  // progress must never have a runtime forced under it (the identity would be
  // the throwaway pre-restore one), so bail before kicking.
  useEffect(() => {
    if (transport || !callId) {return;}
    let cancelled = false;
    void (async () => {
      try {
        const {isRestoreModeActive} = require('@/modules/messenger/backup/restoreMode') as typeof import('@/modules/messenger/backup/restoreMode');
        if (isRestoreModeActive()) {return;}
      } catch { /* flag module unavailable — proceed */ }
      try {
        const {getMessengerRuntime} = require('@/modules/messenger/runtime') as typeof import('@/modules/messenger/runtime');
        await getMessengerRuntime();
      } catch (e) {
        console.warn('[call.boot] runtime kick failed:', (e as Error).message);
        return;
      }
      if (cancelled) {return;}
      const live = getLiveTransport();
      if (live) {setTransport(live);}
    })();
    return () => { cancelled = true; };
  }, [transport, callId]);

  // Patch the call registry with the bits CallScreen has but the
  // boot effect didn't (conversationId for routing on restore, the
  // human-readable name for the overlay). The registry is created in
  // useCall once tracks land — we just augment it here.
  useEffect(() => {
    if (!callId) {return;}
    patchActiveCall(callId, {conversationId, peerName});
  }, [callId, conversationId, peerName]);

  /**
   * WI-1.1 — the registry ref this screen may mutate.
   *
   * The screen holds a route param and nothing else, so this is the WEAK
   * (callId-only) form: it cannot tell two generations of one callId apart,
   * but it is what stops a screen showing call A from minimising or ending
   * call B. Mirrored through a ref because the `[]`-deps listeners below
   * (BackHandler, beforeRemove, AppState) capture their closure once, and a
   * React Navigation param replace can swap `callId` under a live mount.
   */
  const callIdRef = useRef(callId);
  useEffect(() => { callIdRef.current = callId; });

  // B-238-CW — call-waiting. A SECOND 1:1 offer arrived while we're on this
  // call; MainNavigator routed it into incomingOneToOneBanner instead of
  // tearing this call down. Surface an Accept/Decline dialog: Answer ends THIS
  // call then joins the new one; Decline keeps this call and declines the new
  // one. The decision logic is the shared, unit-tested callWaiting core — this
  // effect only bridges it to the banner + a branded dialog and never touches
  // the call render tree.
  useEffect(() => {
    let shownFor: string | null = null;
    return onPendingOneToOneChange((pending) => {
      if (!pending || pending.callId === callId || shownFor === pending.callId) {return;}
      shownFor = pending.callId;
      const deps = {
        // WI-1.1 — "end the call currently on screen" is the documented
        // contract here, so it reads the live entry's own key synchronously at
        // press time rather than trusting a route param: `acceptWaitingCall`
        // awaits this before launching the accepted call, and a dropped
        // teardown would leave two live 1:1 calls.
        endCurrentCall: () => {
          // Lazy require, matching the rest of this file: a top-level import
          // shadows the audio-cleanup effect's own destructure of the same name.
          const reg = require('@/modules/messenger/runtime/callRegistry') as typeof import('@/modules/messenger/runtime/callRegistry');
          const live = reg.getActiveCall();
          if (live) {reg.endActiveCall({callId: live.callId, gen: live.gen}, 'ended', 'local');}
        },
        sendFrame: (frame: {event: string; data: unknown}) => {
          try { getLiveTransport()?.send(frame as never); } catch { /* dead socket — must not trap the dialog */ }
        },
        navigateToCall: (params: AcceptedCallParams) =>
          (navigation as unknown as {replace: (n: string, p: unknown) => void}).replace('CallScreen', params),
        clearPending: () => clearPendingOneToOne(),
      };
      const who = resolveMemberName(pending.from.userId);
      Alert.alert(
        'Incoming call',
        `${who} is calling. Answering will end your current call.`,
        [
          {text: 'Decline', style: 'cancel', onPress: () => { shownFor = null; declineWaitingCall(pending, deps); }},
          {text: 'Answer',  onPress: () => { void acceptWaitingCall(pending, deps); }},
        ],
      );
    });
  }, [callId, navigation]);

  // Hardware back button → minimize the call instead of hanging up.
  // Sets keepAlive so useCall's unmount cleanup doesn't tear down the
  // controller; the FloatingCallOverlay then takes over rendering.
  // Returning true from the listener swallows the back event so React
  // Navigation doesn't pop us — but we also kick a navigation.goBack
  // ourselves AFTER the registry is in keep-alive mode, which is what
  // pops CallScreen and reveals the underlying screen.
  // AppState lifecycle guard — when the OS backgrounds the app during
  // an active call, mark keepAlive so cleanup paths don't tear down,
  // and on `→ active` force a tile re-render so dead native MediaStream
  // handles fall through to safeStreamURL's null path (avatar fallback)
  // instead of crashing through the JNI bridge. Same pattern as the
  // GroupCallScreen guard. Independent of the screen-on flag effect.
  // Fix #11: ONE consolidated AppState listener for the whole screen.
  // Three concerns previously each ran their own listener:
  //   (a) keep-alive on background → so cleanup paths don't tear down
  //   (b) throttled tile re-render on `→ active` → so dead native
  //       MediaStream handles fall through to safeStreamURL's null path
  //   (c) re-arm WindowManager FLAG_KEEP_SCREEN_ON for video calls
  // Multiple listeners means each fires its own native bridge call on
  // every transition, AND the second listener's cleanup couldn't see
  // the first's keepAlive write order. Consolidating gives us
  // deterministic ordering and halves the bridge cost on lock/unlock.
  const [, setAppStateTick] = useState(0);
  const lastAppStateTickRef = useRef(0);
  // Set by the audio-session effect when this is a video call so the
  // unified listener knows to re-arm setKeepScreenOn(true). Mirrored
  // through a ref so the listener doesn't have to rebind on isVideo.
  const videoArmedRef = useRef(false);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s: string) => {
      if (s === 'background' || s === 'inactive') {
        try {

          const reg = require('@/modules/messenger/runtime/callRegistry') as typeof import('@/modules/messenger/runtime/callRegistry');
          reg.patchActiveCall(callIdRef.current ?? null, {keepAlive: true});
        } catch { /* ignore */ }
      } else if (s === 'active') {
        // (c) re-arm screen-on first — cheap native call, runs on every
        // active even if we throttle the tile-render below.
        if (videoArmedRef.current) {
          try { InCallManager.setKeepScreenOn(true); } catch { /* ignore */ }
        }
        // BS-CALL1 — restore the user's audio route. While the screen was
        // off (proximity during a voice call, or a manual lock) Android can
        // silently re-route audio (earpiece↔speaker). Without this the route
        // never comes back. Slightly delayed so it lands AFTER the OS has
        // finished its own post-unlock device re-evaluation.
        // B-278 — invalidate the cached route BEFORE re-applying. While we were
        // backgrounded Android may have torn down the BT SCO link and fallen
        // back to the loudspeaker; without this the idempotence guard sees the
        // route it last ASKED for, matches, and skips the very correction this
        // timeout exists to make.
        // WI-2.4 — owned so unmount clears it. B-278 ordering is unchanged:
        // invalidate the cached route BEFORE re-applying, or the idempotence
        // guard skips the very correction this timeout exists to make.
        if (routeReapplyRef.current) {clearTimeout(routeReapplyRef.current);}
        // Exempt from the unmount sweep (it must survive a minimize), so it
        // needs its OWN liveness check: the call can END inside the 350 ms
        // window, and re-driving InCallManager then sets the speakerphone
        // force flag with no session left to clear it — the CALL-N5 /
        // latched-speaker shape leaking into the next call. Identity captured
        // at arm time, like the accept retry.
        const routeArmedForCallId = callIdRef.current;
        routeReapplyRef.current = setTimeout(() => {
          routeReapplyRef.current = null;
          try {
            const reg = require('@/modules/messenger/runtime/callRegistry') as typeof import('@/modules/messenger/runtime/callRegistry');
            const slot = reg.getActiveCall();
            if (!slot || slot.callId !== routeArmedForCallId) {
              console.warn('[CALLSM] route-reapply dropped — call ended or superseded');
              return;
            }
          } catch { /* registry unavailable (tests) — fall through */ }
          try {
            invalidateAppliedRoute();
            reapplyRouteRef.current();
          } catch { /* ignore */ }
        }, ROUTE_REAPPLY_DELAY_MS);
        // (b) Throttle — rapid lock/unlock cycles otherwise spam re-renders.
        const now = Date.now();
        if (now - lastAppStateTickRef.current < 1200) {return;}
        lastAppStateTickRef.current = now;
        setAppStateTick(t => t + 1);
      }
    });
    return () => sub.remove();
  }, []);

  // Audio-focus interruption guard. Mirrors GroupCallScreen — when
  // another app (incoming WhatsApp call, etc.) requests AUDIOFOCUS_LOSS
  // we mute the mic so we don't keep pumping RTP into a closed
  // AudioRecord (the symptom that froze the JS thread before we wired
  // this). User sees a "Paused" banner; we auto-clear on GAIN.
  const [audioInterrupted, setAudioInterrupted] = useState(false);
  /**
   * WI-2.4 — screen-local timer budgets. Not in `callDeadlines.ts`: those are
   * CALL-lifecycle deadlines with cross-module ordering relationships, while
   * these three are UI latencies that mean nothing outside this screen.
   */
  const AUTO_ACCEPT_RETRY_MS   = 1_500;   // B-62 one-shot accept retry
  const ROUTE_REAPPLY_DELAY_MS = 350;     // BS-CALL1 post-unlock route settle
  const POP_WATCHDOG_MS        = 800;     // B-102 A2 dismissal fallback
  // Ref-mirror liveCall so the focus listener + back-handler (registered
  // ONCE) always read the current state/handlers instead of capturing
  // the first render's snapshot. Without this, audio-focus events
  // fired during/after a state transition called a stale toggleMute
  // that pointed at a torn-down PC, throwing inside the JNI bridge.
  // Initialised to null and synced after `liveCall` is declared below
  // (TS hoisting won't let us pass `liveCall` to useRef up here).
  const liveCallRef = useRef<ReturnType<typeof useCall> | null>(null);
  /**
   * WI-2.4 — every screen-owned timer, so unmount can clear all of them.
   *
   * These used to be bare `setTimeout` calls with no handle. An unmounted
   * screen's timer still fires: the pop watchdogs would `dismissCallScreen()`
   * a screen that had already gone (popping the PARENT), the route re-apply
   * would drive InCallManager for a call that had ended, and the accept retry
   * would answer on a dead surface. None of them are recovery timers — this is
   * ownership, not the banned "timer-based recovery for a backgrounded call".
   */
  const autoAcceptRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const routeReapplyRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const popWatchdogRef     = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * WI-2.4(c) — seeded from the REAL state, not the literal `'connecting'`.
   *
   * The literal is the same defect B-329 fixed one layer up in `useCall`: on a
   * restore the registry already knows the live state, but this ref claimed
   * `'connecting'` until the first sync. Its three consumers — the BackHandler
   * (`hardwareBackPress`), the `beforeRemove` listener, and the audio-focus
   * listener — are all registered ONCE, so all three read the lie. The visible
   * cost was CALL-07: the first back press on an unanswered incoming ring took
   * the minimize branch instead of declining, and the caller rang out the full
   * 45 s with an overlay nobody would answer.
   *
   * Seeded exactly the way B-329 seeded `useCall`: from the live registry entry
   * when it is THIS call, else the fresh-boot value B-103 requires — `'ringing'`
   * for an incoming mount from frame 1, so there is no End-button flash during
   * the TURN fetch.
   */
  const liveCallStateRef = useRef<string>(useState(() => {
    try {
      const reg = require('@/modules/messenger/runtime/callRegistry') as typeof import('@/modules/messenger/runtime/callRegistry');
      const live = reg.getActiveCall();
      if (live && live.callId === callId) {return live.state;}
    } catch { /* registry unavailable (tests) — fall through to the boot seed */ }
    return isIncoming ? 'ringing' : 'connecting';
  })[0]);
  // A5 focus-gain-no-unmute — true ONLY when WE auto-muted an already-unmuted
  // user on a focus LOSS, so the GAIN branch can restore them. A user who was
  // already muted (manual) at LOSS leaves this false, so we never override
  // their choice. Mirrors GroupCallScreen's BS-FOCUS-UNMUTE.
  const autoMutedByFocusRef = useRef(false);
  /**
   * WI-2.4 — clear every screen-owned timer on unmount.
   *
   * `[]` deps on purpose: this must run exactly once, at teardown. An
   * unmounted screen's timer still fires — the pop watchdog would dismiss a
   * screen that is already gone (popping the PARENT), and the accept retry
   * would answer on a dead surface.
   *
   * `routeReapplyRef` is DELIBERATELY NOT swept. It drives a GLOBAL resource
   * (InCallManager) for a call that outlives this screen, and touches no mount
   * state. A product switch is a raw React unmount with no `beforeRemove`, so
   * sweeping it would cancel the B-278 route correction mid-flight and strand
   * a minimised call on the earpiece with no screen left to fix it.
   *
   * This clears timers only. It does NOT touch the call: a minimize unmounts
   * this screen while the call keeps running (keepAlive, I6), so anything here
   * that ended the call would break the minimize contract.
   */
  useEffect(() => () => {
    for (const t of [autoAcceptRetryRef, popWatchdogRef]) {
      if (t.current) { clearTimeout(t.current); t.current = null; }
    }
  }, []);
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('onAudioFocusChange', (data: {eventText?: string; eventCode?: number}) => {
      const code = data?.eventCode;
      if (code === -1 || code === -2) {
        console.log(`[bravo.callaudio] focus LOSS (${data.eventText}) — muting`);
        setAudioInterrupted(true);
        const lc = liveCallRef.current;
        if (lc && !lc.isMuted) {
          // Remember the mute was OURS so we can restore it on GAIN.
          try { lc.toggleMute(); autoMutedByFocusRef.current = true; } catch { /* ignore */ }
        }
      } else if (code === 1) {
        console.log('[bravo.callaudio] focus GAIN');
        setAudioInterrupted(false);
        // Auto-unmute ONLY if WE auto-muted on the matching LOSS — otherwise
        // a transient interruption (GSM call, alarm) left the caller silently
        // muted with the banner gone and no signal. A pre-interruption manual
        // mute is preserved (ref false → no unmute).
        if (autoMutedByFocusRef.current) {
          autoMutedByFocusRef.current = false;
          const lc = liveCallRef.current;
          if (lc?.isMuted) {
            try { lc.toggleMute(); } catch { /* ignore */ }
          }
        }
      }
    });
    return () => sub.remove();
  }, []);

  // Hardware back button:
  //   • If the call is CONNECTED → minimize (FloatingCallOverlay takes over
  //     rendering, the call keeps running). This is the WhatsApp/Messenger
  //     pattern — back ≠ end-call once the call is live.
  //   • If we're still in 'connecting' / 'calling' / 'ringing' → minimizing
  //     would strand the FloatingCallOverlay over a never-completed call.
  //     Hang up and let the goBack fall through normally so React
  //     Navigation pops us cleanly. (Returning false from the handler
  //     lets the system handle the back press as a regular pop.)
  // Round 7 / back-button audit fix #3 — track open modals via a ref so
  // the screen-level BackHandler can defer to the Modal's own
  // onRequestClose. Without this, pressing back while the "Add to call"
  // picker, the call route picker, or the in-call dialpad is open
  // closes the modal AND minimizes the call in one tap (two unrelated
  // actions in a single press). The ref is sync'd from the modal state
  // by a separate useEffect placed AFTER the modal state declarations
  // (see "modalsOpenRef sync" further down).
  const modalsOpenRef = useRef(false);
  // CALL-07 — latest-decline ref so the mount-time BackHandler (empty
  // deps) always invokes the current declineCall closure, not the first
  // render's. Synced by an effect next to declineCall's definition.
  const declineCallRef = useRef<() => void>(() => {});
  // CALLS-1to1 (#2) — guarantee End ENDS the call AND pops the screen even when
  // liveCall.state never reaches 'ended' (boot window: the controller isn't
  // built yet, so hangup() can't drive state). dismissedRef de-dupes the endCall
  // watchdog goBack against the auto-dismiss effect; tearingDown freezes the
  // heavy RTCView subtree BEFORE the pop so the native tree can't crash
  // ("child already has a parent") collapsing in the same commit (B-37 pattern).
  const dismissedRef = useRef(false);
  const [tearingDown, setTearingDown] = useState(false);
  // B-309 — the opening-route settle instance; created by the audio-session
  // effect, fed by the device-event listener, cancelled on session teardown.
  const openingSettleRef = useRef<ReturnType<typeof createOpeningRouteSettle> | null>(null);
  // B-236u — queue-and-apply for explicit picks made while the native device
  // list is still empty (the first ~11 s dead window). Created with the
  // session, fed by the device-event listener, cleared on teardown.
  const routePickQueueRef = useRef<ReturnType<typeof createRoutePickQueue> | null>(null);

  // B-306 — THE one dismissal path for the ended/watchdog family. Before
  // popping, consume any group ring that was PARKED while this 1:1 owned the
  // screen (MainNavigator parks instead of navigating over us — see
  // pendingGroupRing.ts) and route into the ring screen ourselves. One
  // navigation actor: the pop and the ring push can no longer race, which is
  // the device-proven failure this exists for (escalation's ring landing the
  // same instant the 1:1 dies; the old goBack popped the just-pushed ring
  // screen and the dedup swallowed the replay).
  // skipPop (B-367): the swipe-decline path runs while the native pop is
  // ALREADY in flight — it still owes the parked-ring consume below (B-306:
  // every dismissal funnels through this helper), but a second goBack here
  // would pop the PARENT screen.
  const dismissCallScreen = (opts?: {skipPop?: boolean}): void => {
    if (dismissedRef.current) {return;}
    dismissedRef.current = true;
    try {
      const {navigationRef: navRefEarly} = require('@/navigation/navigationRef') as typeof import('@/navigation/navigationRef');
      // Readiness is checked BEFORE the consume, not inside the timeout below.
      // `consumePendingGroupRing` is destructive — it clears the park AND
      // cancels its 45 s expiry — so bailing on "not ready" AFTER it ran lost
      // the ring with no record. Its sibling site in MainNavigator already
      // ordered these correctly.
      if (!navRefEarly.isReady()) {return;}
      const {consumePendingGroupRing} = require('@/modules/messenger/webrtc/pendingGroupRing') as typeof import('@/modules/messenger/webrtc/pendingGroupRing');
      const ring = consumePendingGroupRing();
      if (ring) {
        console.warn('[CALLDIAG] [ring.handoff] consuming parked ring room=', ring.roomId.slice(0, 8));
        // After the pop below settles — same nested-navigate shape as
        // MainNavigator's warm path, via the root ref so it works from
        // either stack this screen is mounted in.
        setTimeout(() => {
          try {
            const {navigationRef} = require('@/navigation/navigationRef') as typeof import('@/navigation/navigationRef');
            if (!navigationRef.isReady()) {return;}
            // Ops-Room call fix (2026-08-09) — shell-aware resolver: this is
            // the PRIMARY B-306 parked-ring consume, and the old hard-coded
            // MessengerTab path dropped silently on CPO/agency shells. No
            // opts (B-319 flaglessness preserved).
            const landed = navigateToMessengerScreen(navigationRef as never, 'IncomingGroupCallScreen', {
              roomId:         ring.roomId,
              conversationId: ring.conversationId,
              callType:       ring.callType,
              callerName:     ring.callerName,
              fromUserId:     ring.from.userId,
              roomToken:      ring.roomToken,
            });
            // B-478 — `consumePendingGroupRing` is DESTRUCTIVE: it clears the
            // park and cancels its 45 s expiry. Discarding the resolver's
            // verdict therefore lost the ring outright when it refused — and
            // the old comment below ("user can still be re-rung") stopped being
            // true once the dedup marker began burning on a parked ring, so
            // there was no ring, no replay and no missed-call record. Give it
            // back to the mailbox instead.
            if (!landed) {
              const {reparkGroupRing} = require('@/modules/messenger/webrtc/pendingGroupRing') as typeof import('@/modules/messenger/webrtc/pendingGroupRing');
              console.warn('[CALLDIAG] [ring.handoff] navigate refused — re-parking room=', ring.roomId.slice(0, 8));
              reparkGroupRing(ring);
            }
          } catch {
            // A throw past the consume would lose the ring outright — there is
            // no park left to bound it. Put it back with its original age.
            try {
              const {reparkGroupRing} = require('@/modules/messenger/webrtc/pendingGroupRing') as typeof import('@/modules/messenger/webrtc/pendingGroupRing');
              reparkGroupRing(ring);
            } catch { /* nothing more we can do */ }
          }
        }, 0);
      }
    } catch { /* mailbox unavailable — plain pop below */ }
    if (opts?.skipPop) {return;}
    // Why: B-319 (same class as GroupCallScreen's B-213) — a cold notification
    // answer seeds this stack with CallScreen as its ONLY route; a bare
    // goBack() is a silent no-op and a failed answer stranded the user here.
    try {
      const nav = navigation as unknown as {goBack: () => void; canGoBack?: () => boolean};
      if (nav.canGoBack === undefined || nav.canGoBack()) {
        nav.goBack();
      } else {
        const {navigationRef} = require('@/navigation/navigationRef') as typeof import('@/navigation/navigationRef');
        // Ops-Room call fix (2026-08-09) — shell-aware home exit: the bare
        // MessengerTab hop stranded CPO/agency users on a dead call card.
        navigateToMessengerScreen(navigationRef as never, 'MessengerHome', {});
      }
    } catch { /* ignore */ }
  };

  // BB-2 (2026-08-15 back audit) — guarded pop for the MINIMIZE family (the
  // screen leaves, the call lives on). Same B-319 single-route fallback as
  // dismissCallScreen above, WITHOUT its dismissedRef latch: minimizing must
  // never mark the call dismissed. A cold-answered call has no route beneath
  // this screen, so the old bare goBack() made the visible Minimise control
  // and the hardware key silent no-ops.
  const popOrHome = (): void => {
    try {
      const nav = navigation as unknown as {goBack: () => void; canGoBack?: () => boolean};
      if (nav.canGoBack === undefined || nav.canGoBack()) {
        nav.goBack();
      } else {
        const {navigationRef} = require('@/navigation/navigationRef') as typeof import('@/navigation/navigationRef');
        navigateToMessengerScreen(navigationRef as never, 'MessengerHome', {});
      }
    } catch { /* ignore */ }
  };

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      // Defer to the active Modal's onRequestClose — RN dispatches
      // BOTH events, so returning false here lets the modal close
      // and prevents the screen-level minimize from also firing.
      if (modalsOpenRef.current) { return false; }
      // WhatsApp-style: back NEVER cuts a live call — minimize it. The
      // FloatingCallOverlay shows the live state ('Calling…' / 'Ringing…' /
      // 'Connecting…' / 'On call') and tapping it restores full screen; it
      // auto-dismisses when the call reaches a terminal state. Covers
      // outgoing (calling/connecting), incoming (ringing) and active
      // (connected/reconnecting) — not only connected. Cancelling is an
      // explicit action (the End button), exactly like WhatsApp.
      const st = liveCallStateRef.current;
      // CALL-07 — back on an UNANSWERED incoming ring must DECLINE, not
      // minimize: minimizing left the caller ringing out the full 45s
      // timeout with no one on this end ever coming back to answer.
      // Outgoing-ringing ('calling') and connected keep the WhatsApp
      // minimize behaviour below.
      if (isIncoming && st === 'ringing') {
        declineCallRef.current();
        return true;
      }
      // Minimize ANY non-terminal live call — including the 'idle' boot window
      // of an outgoing call (state sits at 'idle' until startOutgoing flips it
      // to 'calling', a multi-second TURN+getUserMedia wait). Back in that
      // window used to fall through and CUT the call; gate on an actual active
      // registry call so a genuinely call-less screen still pops normally.
      try {
        const reg = require('@/modules/messenger/runtime/callRegistry') as typeof import('@/modules/messenger/runtime/callRegistry');
        // WI-1.1 — only minimise OUR call. Before keying, a back press on a
        // CallScreen whose call had already been replaced minimised the NEW
        // call instead, hiding a call the user never asked to hide.
        const live = reg.getActiveCall();
        if (live && live.callId === callIdRef.current && st !== 'ended' && st !== 'failed') {
          setMinimized({callId: live.callId, gen: live.gen}, true);
          popOrHome();
          return true;
        }
      } catch { /* registry unavailable (tests) — fall through to normal pop */ }
      // No live call (ended / failed / none) → normal pop.
      popOrHome();
      return true;
    });
    return () => sub.remove();
    // navigation is stable (set by React Navigation); we rebind only on mount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // BS-022 — default-to-minimize on ANY silent screen pop with a live
  // connected call.
  //
  // The hardware-back-press path above explicitly calls
  // setMinimized(true) BEFORE goBack(). But on Samsung S23 / OneUI the
  // system swipe-back gesture pops the native-stack screen WITHOUT
  // dispatching `hardwareBackPress`, so without this `beforeRemove`
  // listener the registry stays in `isMinimized=false` when CallScreen
  // unmounts. The audio session cleanup runs with no `keepAlive` flag,
  // the FloatingCallOverlay never appears (renders only when
  // `isMinimized=true`), but the call CONTROLLER stays in the registry
  // — leaving the user trapped: tapping a chat re-routed CallScreen
  // via the resume path, the FG service re-mounted, and they bounced
  // straight back to the call UI.
  //
  // Why `beforeRemove` instead of a useEffect cleanup: setMinimized
  // also flips `keepAlive=true`, and the audio-session cleanup at
  // line ~600 reads `keepAlive` to decide whether to stop InCallManager.
  // React runs cleanups in REVERSE registration order, so a cleanup
  // declared HERE (high in the file) would run AFTER the audio
  // cleanup — too late to influence keepAlive. `beforeRemove` fires
  // BEFORE any unmount cleanup, so the keepAlive flip is visible to
  // every downstream cleanup.
  //
  // setMinimized is idempotent + null-safe so the hardware-back, fail,
  // and explicit-hangup paths are unaffected: `setMinimized(true)`
  // either already ran (back-press) or `endActiveCall(s)` cleared the
  // registry first (fail/hangup) and the no-active-call early-out
  // makes the call a no-op.
  useEffect(() => {
    const unsubscribe = (navigation as unknown as {
      addListener: (event: string, cb: (e: unknown) => void) => () => void;
    }).addListener('beforeRemove', () => {
      try {

        const reg = require('@/modules/messenger/runtime/callRegistry') as typeof import('@/modules/messenger/runtime/callRegistry');
        const live = reg.getActiveCall();
        // WhatsApp-style: a swipe-back gesture (which doesn't fire
        // hardwareBackPress on OneUI) must minimize a live call, never cut
        // it — for every non-terminal state, not just connected. The
        // overlay shows the live state and tapping it restores full screen;
        // it auto-dismisses when the call reaches a terminal state.
        const liveStates = ['idle', 'calling', 'ringing', 'connecting', 'connected', 'reconnecting'];
        // B-367 — CALL-07 on the gesture path. iOS has no hardware back and
        // the OneUI swipe never dispatches hardwareBackPress, so this
        // listener is the ONLY intercept a swipe-back hits — and minimizing
        // an UNANSWERED incoming ring left the caller ringing out the full
        // 45s with no one ever coming back. Decline instead, mirroring the
        // BackHandler branch. The pop is already in flight, so run the
        // B-306 dismissal helper in skipPop mode FIRST: it latches
        // dismissedRef (declineCall's watchdog can't goBack a second time
        // onto the parent) and still consumes any parked group ring. Gate
        // on hangupInFlightRef because the decline itself pops the screen
        // and re-fires beforeRemove.
        // Keyed like the minimize branch below: `live` is the REGISTRY's
        // entry (possibly another call) while `liveCallStateRef` is THIS
        // screen's state. Unkeyed, a superseded screen still reading 'ringing'
        // would decline — consuming a parked group ring (B-306) — and then
        // return, skipping the minimise of the call that actually holds the slot.
        if (live && live.callId === callIdRef.current && !live.isMinimized && isIncoming &&
            liveCallStateRef.current === 'ringing' && !hangupInFlightRef.current) {
          console.log('[CallScreen] screen-pop on unanswered incoming ring — declining');
          dismissCallScreen({skipPop: true});
          declineCallRef.current();
          return;
        }
        // WI-1.1 — keyed for the same reason as the BackHandler branch above:
        // a swipe-back on a superseded CallScreen must not minimise whatever
        // call now holds the slot.
        if (live && live.callId === callIdRef.current && !live.isMinimized && liveStates.includes(live.state)) {
          console.log('[CallScreen] silent screen-pop with live call — defaulting to minimize');
          reg.setMinimized({callId: live.callId, gen: live.gen}, true);
        }
      } catch { /* registry / require may be unavailable in tests — ignore */ }
    });
    return unsubscribe;
    // navigation is stable across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const peerUserId     = remoteUserId ?? convo?.peer?.userId;
  const liveMode       = !!(callId && transport && peerUserId);
  // Presence for the peer-offline banner shown during outgoing
  // ringing — gives the caller an early signal that the other side
  // probably won't pick up. Uses the same `presence` map ChatScreen +
  // MessengerHomeScreen read; the original draft typo'd
  // `s.peerPresence` and crashed every CallScreen mount with
  // "Cannot convert undefined value to object" because that field
  // doesn't exist on the persisted store shape.
  const _peerPresence = useMessengerStore(s2 =>
    peerUserId ? s2.presence[peerUserId] : undefined);
  const [iceServers, setIceServers] = useState<IceServerConfig[] | null>(null);

  // TURN credentials, from the shared session cache (audit Step 2.1). A
  // prewarm fired while the phone rings (MainNavigator onIncoming / the FCM
  // voip-wake) usually makes this a synchronous cache hit; the 6 s ceiling +
  // STUN fallback (B-110) and single-flight now live in turnCredentials.ts.
  useEffect(() => {
    if (!liveMode) {return;}
    let cancelled = false;
    const turnT0 = Date.now();
    logCallLat(isIncoming ? '1to1-in' : '1to1-out', callId, 'turn:start');
    void (async () => {
      const {getIceServers} = require('@/modules/messenger/webrtc/turnCredentials') as typeof import('@/modules/messenger/webrtc/turnCredentials');
      const ice = await getIceServers({ceilingMs: TURN_FETCH_CEILING_MS});
      if (cancelled) {return;}
      const relay = ice.some(s => s.username);   // did we get real TURN creds vs the STUN-only fallback?
      logCallLat(isIncoming ? '1to1-in' : '1to1-out', callId, relay ? 'turn:ok' : 'turn:fail', {ms: Date.now() - turnT0, n: ice.length});
      setIceServers(ice);
    })();
    return () => { cancelled = true; };
  // Why: keyed on liveMode ALONE (a param replace on a live mount must not
  // re-run); callId/isIncoming are read only by the [CALLLAT] markers.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveMode]);

  // Memoize the useCall arg on stable scalars so we don't rebuild the
  // entire option object every render. Before this, every parent
  // re-render handed useCall a fresh object, which the hook compared
  // by reference for "did the call config change?" — so internal
  // effects (PC boot, mic/cam acquire) thrashed on every keystroke or
  // network tick. We key on the primitive identifiers; iceServers and
  // transport are stable once initially set, but we still include them
  // so a TURN refresh or transport reconnect can rebind the hook.
  const incomingSdpKey = !!incomingSdp;
  const callArgs = useMemo(() => {
    if (liveMode && iceServers && transport && peerUserId) {
      return {
        callId:      callId!,
        peer:        {userId: peerUserId, deviceId: remoteDeviceId ?? 1},
        kind:        callType,
        direction:   (isIncoming ? 'incoming' : 'outgoing') as 'incoming' | 'outgoing',
        incomingSdp: isIncoming ? incomingSdp : undefined,
        transport,
        iceServers,
      };
    }
    // Pass benign defaults when not live yet — the hook short-circuits
    // on its own boot effect because tracks/PC never get attached.
    // B-103 — direction must be ROUTE-derived even here: hard-coding
    // 'outgoing' made useCall seed state 'idle' for an INCOMING mount, so
    // the full in-call tray (dominant red End button) rendered for the
    // whole TURN-fetch window before the ring UI appeared — the reported
    // "end-call screen flashes before Accept/Decline". Seeding 'ringing'
    // also re-arms the audio-session defer gate for the boot window (no
    // pre-ring InCallManager/FGS start). The 'demo' peer/callId guard
    // still blocks all signalling side effects.
    return {
      callId: callId ?? 'demo', peer: {userId: 'demo', deviceId: 1},
      kind: callType,
      direction: (isIncoming ? 'incoming' : 'outgoing') as 'incoming' | 'outgoing',
      transport: transport as never, iceServers: iceServers ?? [],
    };
    // Deps are intentionally minimal scalars — incomingSdpKey is the
    // boolean presence (the SDP itself is set once and never changes
    // identity for the same call), and `transport` / `iceServers` are
    // stable refs that flip identity only on real reconnect / TURN
    // refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callId, peerUserId, remoteDeviceId, callType, isIncoming, incomingSdpKey, liveMode, transport, iceServers]);
  const liveCall = useCall(callArgs);
  // CN-09 — debounced link-quality banner, fed by useCall's 1 Hz stats.
  const qualityBannerVisible = useCallQualityVisible(liveCall.stats, liveCall.state === 'connected');
  // Sync the ref-mirrors declared above (Fix #2 + #3). Refs are stable
  // across renders so the listeners that read these always see the
  // latest snapshot without rebinding their subscribers.
  useEffect(() => { liveCallRef.current = liveCall; }, [liveCall]);
  useEffect(() => { liveCallStateRef.current = liveCall.state; }, [liveCall.state]);

  // Drive the legacy local UI state from the hook so the existing
  // animations/buttons keep working without rewriting the whole screen.
  // Setters route to the hook's track-level controls. Existing
  // legacy call sites use updater-style (`m => !m`) which we just
  // collapse to a toggle since both toggleMute / toggleVideo are
  // already toggles.
  const isMuted     = liveCall.isMuted;
  const setIsMuted  = (_: boolean | ((m: boolean) => boolean)) => liveCall.toggleMute();
  const isCameraOn  = !liveCall.isVideoOff;
  // B-389 — mid-call video upgrade requires a CONNECTED call. Used to gate the
  // Camera control (and re-checked in setIsCameraOn, which the peer-added-video
  // alert also routes through).
  const isCallConnected = liveCall.state === 'connected';
  /**
   * Render-time call kind. Starts as `isVideo` (the route param) and
   * flips to true the moment a local video track or peer-video event
   * arrives — so a successful mid-call voice→video upgrade swaps to
   * the video grid layout without remounting the screen. We also stay
   * in video mode after a peer flips their camera (peerAddedVideo)
   * so their incoming video tile has somewhere to render.
   *
   * Once true, stays true for the rest of the call: turning the local
   * camera off via toggleVideo flips `isCameraOn`, not `isVideoUI` —
   * the m-line stays in the SDP and the remote tile / chrome stays
   * in video layout.
   */
  const isVideoUI = isVideo
    || liveCall.peerAddedVideo
    || ((liveCall.localStream?.getVideoTracks().length ?? 0) > 0);
  /**
   * Camera button handler. Two paths:
   *
   *   • The call already has a video track (initial video call, or a
   *     prior successful upgrade): toggleVideo() flips the track's
   *     enabled flag and fires the BS-021 advisory so the peer's
   *     UI updates the camera-on indicator.
   *
   *   • The call is voice-only (no video track yet): kick off the
   *     mid-call SDP renegotiation pipeline. We pre-request the
   *     Android CAMERA permission first because RN-WebRTC's
   *     getUserMedia does not auto-prompt for it (unlike iOS).
   *     Permission denial → user-facing Alert; renegotiation
   *     failure → user-facing Alert that names the failure mode so
   *     they can decide whether to retry or fall back to ending
   *     and starting a fresh video call. Successful upgrade is
   *     silent — the screen re-renders with video-mode UI as the
   *     hook's localStream / kind state propagates.
   */
  const setIsCameraOn = (_: boolean | ((c: boolean) => boolean)) => {
    const flipped = liveCall.toggleVideo();
    if (flipped) {return;}
    // B-389 — do NOT attempt a mid-call upgrade before the call is connected.
    //
    // The control tray is hidden only for an INCOMING ringing call
    // (`isRinging` above), so on an OUTGOING call — state 'calling' until the
    // peer answers — Camera was fully live. upgradeToVideo then correctly threw
    // `call must be connected (got calling)`, which matched none of the catch's
    // friendly branches and fell through to the generic "End the call and start
    // a fresh video call" — telling the user to tear down a healthy encrypted
    // call to recover from something that fixes itself the moment the peer
    // answers.
    //
    // The gate lives HERE, not only on the button, because there are TWO entry
    // points: the Camera control and the "Turn on mine" action on the
    // peer-added-video alert below. Gating only the button leaves that one open.
    //
    // Note this is a CALLER-side gate. useCall's own `currentState !==
    // 'connected'` check stays exactly as it is — a renegotiation on a peer
    // connection that has not finished its initial offer/answer is real glare.
    if (liveCall.state !== 'connected') {
      Alert.alert(
        'Not connected yet',
        'Video can only be added once the call is connected. Stay on the call — as soon as it connects, tap Camera again.',
        [{text: 'OK'}],
      );
      return;
    }
    // Voice-only call → mid-call upgrade. Guard against double-tap
    // via the hook's isUpgrading flag (the controller has its own
    // coalesce too, but the hook flag means the button-tap is a
    // visible no-op without ANY work).
    if (liveCall.isUpgrading) {return;}
    void (async () => {
      try {
        // RN-WebRTC's getUserMedia({video:true}) on Android does NOT
        // automatically prompt for android.permission.CAMERA the way
        // iOS does — it expects the app to have requested it via
        // PermissionsAndroid first, otherwise it rejects with a
        // SecurityException-shaped error that's hard to surface
        // meaningfully. Pre-request here so the OS permission dialog
        // pops cleanly BEFORE we touch the WebRTC engine.
        if (Platform.OS === 'android') {
          const r = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.CAMERA);
          if (!isMountedRef.current) {return;}
          if (r !== PermissionsAndroid.RESULTS.GRANTED) {
            Alert.alert(
              'Camera permission required',
              'Bravo Secure needs camera access to turn on video during a call. Grant access in Settings and try again.',
              [{text: 'OK'}],
            );
            return;
          }
        }
        await liveCall.upgradeToVideo();
        if (!isMountedRef.current) {return;}
        // Success — the hook's setLocalStream + isVideoOff state
        // updates have already propagated; nothing else to do here.
        // The peer's BS-021 advisory has been fired, so when their
        // own UI re-renders they'll see camera-on.
      } catch (e) {
        const msg = (e as Error)?.message ?? 'unknown error';
        // Specific messages for the cases users can actually act on;
        // generic message for everything else with the raw error in
        // a trailing line so support can debug from a screenshot.
        let title = 'Could not turn on video';
        let body  = 'Something went wrong adding video to this call. End the call and start a fresh video call to continue.';
        if (/must be connected/i.test(msg)) {
          // B-389 — the pre-connect case. It is NOT a failure to recover from
          // by hanging up: waiting is the fix. Must be tested BEFORE the
          // /state/ branch below, whose wording ("both sides tried to change
          // the call") would be misleading here.
          title = 'Not connected yet';
          body  = 'Video can only be added once the call is connected. Stay on the call — as soon as it connects, tap Camera again.';
        } else if (/no reanswer within/i.test(msg)) {
          title = 'Peer didn\'t respond';
          body  = 'Your contact\'s app didn\'t reply to the video upgrade. They may be on an older version of Bravo Secure. Ask them to update, or end this call and start a fresh video call.';
        } else if (/getUserMedia|permission|NotAllowedError/i.test(msg)) {
          title = 'Camera unavailable';
          body  = 'Bravo Secure couldn\'t access your camera. Another app may be using it, or permission was denied.';
        } else if (/glare|signaling|state/i.test(msg)) {
          title = 'Try again';
          body  = 'Both sides tried to change the call at the same time. Wait a moment and tap Camera again.';
        }
        if (!isMountedRef.current) {return;}
        Alert.alert(title, body + `\n\n(${msg})`, [{text: 'OK'}]);
      }
    })();
  };

  // Mid-call: peer turned ON their camera (we received call.reoffer).
  // One-shot informational Alert with a "Turn on yours too" button so
  // the user can reciprocate without hunting for the Camera button.
  // We deliberately do NOT auto-acquire their camera — privacy.
  const peerAddedVideoNoticedRef = useRef(false);
  useEffect(() => {
    if (!liveCall.peerAddedVideo) {return;}
    if (peerAddedVideoNoticedRef.current) {return;}
    peerAddedVideoNoticedRef.current = true;
    // If we already have video (either it was a video call from the
    // start, or we just upgraded ourselves first), nothing to prompt.
    if (!liveCall.isVideoOff && liveCall.localStream?.getVideoTracks().length) {return;}
    // BS-021 race: peer can turn on video at the exact moment we hang
    // up. liveCall.peerAddedVideo flips, this effect runs, but the
    // screen is mid-unmount. Without the guard, the alert pops over
    // the parent screen (chat thread) seconds after the call ended.
    if (!isMountedRef.current || hangupInFlightRef.current) {return;}
    Alert.alert(
      `${peerName} turned on video`,
      'Tap "Turn on mine" to share your camera too. The call audio stays connected either way.',
      [
        {text: 'Stay on audio'},
        {text: 'Turn on mine', onPress: () => setIsCameraOn(true)},
      ],
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveCall.peerAddedVideo]);
  const cameraFacing: 'front' | 'back' = liveCall.facing === 'user' ? 'front' : 'back';
  const setCameraFacing = (_: 'front' | 'back' | ((f: 'front' | 'back') => 'front' | 'back')) => { void liveCall.flipCamera(); };

  const [isSpeaker, setIsSpeaker] = useState(isVideo);
  const [isOnHold, setIsOnHold] = useState(false);
  const [dialpadOpen, setDialpadOpen] = useState(false);
  const [dialedDigits, setDialedDigits] = useState('');
  const [callDuration, setCallDuration] = useState(0);
  /** Picker for "Add" button — escalates 1:1 → group via the SFU path. */
  const [addPickerOpen, setAddPickerOpen] = useState(false);
  const currentUserId = useAuthStore(s => s.user?.id ?? null);
  // BS-CALL-ADHOC — the host's OWN display name. On escalation the joiner's
  // ring must show who is calling (the host), not the host's local label for
  // the peer (`conversations[direct:<peer>].name`), which resolves to the
  // wrong contact on the joiner's device.
  const ownDisplayName = useAuthStore(s => s.user?.full_name ?? s.user?.email ?? 'Caller');
  // B-105 — the local PiP camera-off fallback must show the LOCAL user's
  // identity (it is the self-view tile), same derivation as peerInitials.
  const ownInitials = ownDisplayName.split(' ').map(w => w[0] ?? '').join('').slice(0, 2).toUpperCase() || 'B';
  // Fix #9: subscribe to conversations via the Zustand selector so the
  // Add-picker actually re-renders when the store mutates. The
  // previous implementation read `useMessengerStore.getState().conversations`
  // inside an IIFE in the render body — that's a one-shot read that
  // bypasses the subscription, so a conversation added DURING an open
  // call (e.g. the peer just texted us mid-call so a new conversation
  // appeared in the home list) would not show up in the picker until
  // CallScreen unmounted+remounted.
  const conversationsForPicker = useMessengerStore(s => s.conversations);
  const addPickerCandidates = useMemo(() => {
    const ownerId = currentUserId;
    return Object.values(conversationsForPicker)
      .filter(c => c.type === 'direct')
      .map(c => ({
        userId:      c.peer?.userId ?? (isDirectPrefixed(c.id) ? peerFromDirectSlot(c.id) : c.id),
        displayName: c.name ?? 'Contact',
      }))
      .filter(c => c.userId
        && c.userId !== ownerId
        && c.userId !== remoteUserId);
  }, [conversationsForPicker, currentUserId, remoteUserId]);
  /**
   * Video-call chrome auto-hide. Messenger UX: once the call is
   * connected the top bar + control row fade out after a few seconds
   * so the remote video can fill the screen; tapping anywhere on the
   * background brings them back. Voice calls don't get this — there's
   * no media to "see through" so chrome stays visible.
   */
  const [chromeVisible, setChromeVisible] = useState(true);
  /**
   * B-305 — bumped by every control interaction so the auto-hide countdown
   * measures IDLENESS, not the age of the reveal. Without it the 3.5s timer ran
   * from when the chrome appeared no matter what the user was doing, so the
   * control tray could unmount mid-reach and swallow the press.
   */
  const [chromeActivityTick, setChromeActivityTick] = useState(0);

  // Audio routing — driven by InCallManager's onAudioDeviceChanged
  // event so we react to BT pair/unpair, wired-headset plug/unplug,
  // etc. live during the call. Without this state, the only way the
  // user could hear audio on a Bluetooth headset was to have it paired
  // BEFORE the call started; pairing mid-call left them on the
  // earpiece. The audioRoutes list also drives a small picker so users
  // with multiple BT devices (car kit + AirPods) can choose.
  type AudioRoute = 'BLUETOOTH' | 'SPEAKER_PHONE' | 'EARPIECE' | 'WIRED_HEADSET';
  const [audioRoutes, setAudioRoutes] = useState<AudioRoute[]>([]);
  const [audioRoute, setAudioRoute] = useState<AudioRoute | ''>('');
  const [routePickerOpen, setRoutePickerOpen] = useState(false);

  // Round 7 / back-button audit fix #3 — modalsOpenRef sync (the ref is
  // declared near the BackHandler effect higher up; we mutate it here
  // now that all three modal state vars are declared).
  useEffect(() => {
    modalsOpenRef.current = addPickerOpen || routePickerOpen || dialpadOpen;
  }, [addPickerOpen, routePickerOpen, dialpadOpen]);
  // Track whether we've ever auto-snapped to BT in this call. The
  // moment a BT device shows up we route to it; if the SCO link drops
  // mid-call (common on cheap headsets), the OS falls back to EARPIECE
  // — when SCO comes back, we restore whichever route the user was
  // last on (BT if they picked it, or BT-by-default if they never
  // touched the picker since BT was already up).
  //
  // `preferredRouteRef` records the user's intent. Initial state: null
  // (no explicit preference yet) → auto-snap to BT the moment it shows.
  // After the user touches the picker, it pins to whatever they chose;
  // we honour that pin on every subsequent device-list change so a BT
  // SCO drop+reconnect re-snaps to BT instead of stranding on EARPIECE.
  const preferredRouteRef = useRef<AudioRoute | null>(null);
  // BS-CALL1 — holds a closure that re-applies the CURRENT desired audio
  // route. Kept in a ref so the AppState listener (bound once, []) can
  // re-apply the route on screen-on WITHOUT capturing a stale `isSpeaker`.
  // Populated by the speaker-toggle effect below, which always sees fresh
  // state. Fixes "screen off → audio output flips and never restores".
  const reapplyRouteRef = useRef<() => void>(() => {});
  // BS-CALL-ROUTE — the route we want RIGHT NOW, which is well-defined even
  // when the user never touched the picker (it falls back to the speaker
  // toggle). preferredRouteRef only holds an EXPLICIT choice, so on a plain
  // voice call with no Bluetooth it stays null forever and the
  // onAudioDeviceChanged re-assert below had nothing to restore to — the OS
  // flipped to speaker on screen-lock and it simply stayed there.
  const desiredRouteRef = useRef<AudioRoute | null>(null);

  // Map the hook's CallState to the legacy 'connecting'|'connected'|'ended'
  // so all the animation effects below keep their existing checks.
  const callState: 'connecting' | 'connected' | 'ended' =
    liveCall.state === 'connected' ? 'connected'
    : liveCall.state === 'ended' || liveCall.state === 'failed' ? 'ended'
    : 'connecting';
  // True only for an incoming call that hasn't been accepted yet — drives
  // the ringing UI with Answer / Decline buttons + repeating vibration.
  // P1-BR-2 — when the user already answered from the notification
  // (autoAccept), suppress the ring surface entirely (no ringtone, no
  // second Accept button); the auto-accept effect below picks up as soon
  // as the offer SDP lands, and the status shows "Answering…/Connecting…".
  // B-102 A2 — userAccepted: the on-screen ring Accept routes through the
  // SAME guarded effect as the notification autoAccept (below) instead of
  // calling accept() directly. In the null-controller boot window a direct
  // accept() was a silent optional-chained no-op; the effect fires as soon
  // as the offer SDP + controller land, with the B-62 retry built in.
  const [userAccepted, setUserAccepted] = useState(false);
  const isRinging = isIncoming && liveCall.state === 'ringing' && !autoAccept && !userAccepted;

  // P1-BR-2 — auto-accept the incoming call once its offer SDP is present.
  // The offer may be here at mount (warm tap) OR replay later over the
  // reconnecting WS (killed-app answer) — in the latter case incomingSdpKey
  // flips true, the useCall boot re-runs, and the controller reaches
  // 'ringing' with the offer applied, at which point this fires. accept()
  // is guarded to run at most once per mount so a re-render can't double it.
  const autoAcceptedRef = useRef(false);
  // B-110 (device-QA finding) — time-bound the queued accept. The accept
  // intent (notification Answer / ring tap) legitimately WAITS for the
  // offer SDP + controller, but if the boot stalls past the caller's ring
  // window the offer is dead — firing then produces a ghost auto-answer
  // of a call the caller already saw fail (observed on-device: connect
  // with zero user action ~35s after the offer). 45s covers the server
  // ring timeout with margin.
  const acceptIntentAtRef = useRef<number | null>(null);
  // Why: NA-02 — terminal state for an accept that never found an offer. The
  // TTL check below only REFUSES to answer; nothing ended the call, so the
  // screen sat on "Answering…" with no controller to hang up and no registry
  // entry for the WS / FCM cancel lanes to reach. This drives the exit.
  const [deadOffer, setDeadOffer] = useState(false);
  useEffect(() => {
    if (!(autoAccept || userAccepted) || !isIncoming) {return;}
    if (autoAcceptedRef.current) {return;}
    if (acceptIntentAtRef.current === null) {acceptIntentAtRef.current = Date.now();}
    if (Date.now() - acceptIntentAtRef.current > ACCEPT_INTENT_TTL_MS) {
      console.warn('[bravo.call] accept intent expired (>45s before controller was ready) — not answering a dead offer');
      return;
    }
    // Gate on the offer being present: incomingSdpKey guarantees useCall
    // built the controller + ran handleIncomingOffer, so accept() will
    // find a pendingOfferSdp instead of no-opping the latch.
    if (!incomingSdpKey) {return;}
    if (liveCall.state !== 'ringing') {return;}
    // Why: B-319 — on a cold notification answer, iceServers are still
    // resolving here and useCall has NO controller: accept() would no-op and
    // the latch below would strand "Answering…" with the watchdog disarmed.
    // Wait; this effect re-fires when controllerReady flips (dep below).
    if (!liveCall.controllerReady) {
      console.warn('[CALLDIAG] autoAccept waiting — controller not ready (B-319)');
      logCallLat('1to1-in', callId, 'accept:wait-controller');
      return;
    }
    autoAcceptedRef.current = true;
    console.log('[bravo.call] autoAccept — answering incoming call from notification');
    logCallLat('1to1-in', callId, 'accept:invoke', {auto: !!autoAccept});
    // B-62 — accept() failing here used to strand the call: with autoAccept
    // set, the ring UI is suppressed (isRinging above), so "retry via the
    // ring UI" was unreachable and the call sat in 'ringing'/'connecting'
    // forever behind an "Answering…" label. Retry once (a cold-boot mic/FGS
    // grant can settle within a second of the activity resuming), then end
    // the call as failed so every teardown path runs and the caller stops
    // ringing.
    void liveCall.accept().then((ok) => {
      if (ok === false) {
        // B-319 belt-and-braces: the controllerReady gate should make this
        // unreachable, but if accept still refused, release the one-shot
        // latch so a later controllerReady flip can retry instead of hanging.
        autoAcceptedRef.current = false;
        // WI-4.7 — a refusal here is now EITHER the B-319 null-controller
        // window OR the tombstone gate (caller already cancelled). Name the
        // right one on the release channel; the watchdog's own probe makes a
        // tombstoned verdict terminal within a tick.
        let refusedDead = false;
        try {
          const cache = require('@/modules/messenger/push/incomingCallCache') as typeof import('@/modules/messenger/push/incomingCallCache');
          refusedDead = callId ? cache.isIncomingCallDead(callId) : false;
        } catch { /* cache unavailable — attribute to B-319 */ }
        console.warn(refusedDead
          ? '[CALLDIAG] accept refused — call tombstoned, watchdog will close it (WI-4.7)'
          : '[CALLDIAG] accept refused despite controllerReady — latch released (B-319)');
      }
    }).catch((e1: unknown) => {
      console.warn('[WEBRTC] accept-failed (autoAccept, attempt 1):', (e1 as Error)?.message ?? e1);
      // WI-2.4(a) — the retry is OWNED: tracked so unmount clears it, and it
      // reads LIVE state through the refs rather than this closure's snapshot.
      //
      // The dep list below is deliberately unchanged. B-319 requires the effect
      // to re-fire when `controllerReady` flips, and requires the
      // `controllerReady` gate to sit BEFORE the one-shot latch — the two are
      // not in tension with reading live state HERE, because the fix belongs in
      // the timer callback, not in the effect's inputs. Removing a dep to
      // "use refs everywhere" would re-open B-319.
      if (autoAcceptRetryRef.current) {clearTimeout(autoAcceptRetryRef.current);}
      // NOTE (review round 2): this retry is currently UNREACHABLE. Since
      // B-274, `accept()` calls `hangup('failed')` before re-throwing, so the
      // controller is terminal by the time this arms and the 'ringing' gate
      // below always bails. B-62's "retry once then end" recovery therefore no
      // longer exists. Deliberately left dead here rather than reopened:
      // restoring it means changing `accept()`'s two-honest-outcomes contract,
      // which B-274 chose on device evidence. Logged for a decision —
      // restore the retry, or delete it and this hardening with it. Do not
      // read the ownership work below as coverage of a live lane.
      //
      // The identity is CAPTURED here, at arm time. Reading `callIdRef`
      // inside the callback would be tautological — both it and the registry
      // move with whatever call the screen now shows, so the check could never
      // detect the thing it exists for: a timer armed for an older call.
      const armedForCallId = callIdRef.current;
      autoAcceptRetryRef.current = setTimeout(() => {
        autoAcceptRetryRef.current = null;
        const live = liveCallRef.current;
        if (!live) {return;}
        if (liveCallStateRef.current !== 'ringing') {return;}
        // WI-2.4(a) — and it must still be OUR call. A retry armed for call A
        // that fires after the registry moved to call B would accept B.
        try {
          const reg = require('@/modules/messenger/runtime/callRegistry') as typeof import('@/modules/messenger/runtime/callRegistry');
          const slot = reg.getActiveCall();
          if (!slot || slot.callId !== armedForCallId) {
            console.warn('[CALLSM] autoAccept-retry dropped — registry moved on');
            return;
          }
        } catch { /* registry unavailable (tests) — the state gate above still applies */ }
        void live.accept().catch((e2: unknown) => {
          console.warn('[WEBRTC] accept-failed (autoAccept, attempt 2) — ending call:', (e2 as Error)?.message ?? e2);
          try { live.hangup(); } catch { /* already terminal */ }
        });
      }, AUTO_ACCEPT_RETRY_MS);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAccept, userAccepted, isIncoming, incomingSdpKey, liveCall.state, liveCall.controllerReady]);
  const [permGranted, setPermGranted] = useState<'pending' | 'granted' | 'denied'>('pending');
  // CALL-14 — ref mirror so the failed-alert effect (keyed on call
  // state, not permission state) reads the latest verdict without
  // re-firing the alert when the permission prompt settles late.
  const permGrantedRef = useRef(permGranted);
  useEffect(() => { permGrantedRef.current = permGranted; }, [permGranted]);

  // Haptic feedback at every meaningful state transition. Keeps the user
  // informed without forcing them to read the status text:
  //   • connected      → success thump (40ms)
  //   • ended (clean)  → short closure tap (15ms)
  //   • failed         → triple buzz so it's distinguishable from a normal
  //                      hang-up — this is "something went wrong".
  useEffect(() => {
    if (callState === 'connected')              {Vibration.vibrate(40);}
    else if (liveCall.state === 'ended')        {Vibration.vibrate(15);}
    else if (liveCall.state === 'failed')       {Vibration.vibrate([0, 80, 60, 80, 60, 80]);}
  }, [callState, liveCall.state]);

  // Outgoing call: tiny "sent" buzz the moment the offer leaves the device,
  // so the caller has tactile confirmation the SDP went out before any
  // network round-trip. Only fires for outgoing.
  useEffect(() => {
    if (!isIncoming && liveCall.state === 'connecting') {Vibration.vibrate(12);}
  }, [isIncoming, liveCall.state]);

  // Ringtone for incoming calls. We DELIBERATELY do not use
  // InCallManager.startRingtone('_DEFAULT_'): its content-resolver
  // path fails with FileNotFoundException on Android 14+ Pixels
  // (logcat: "Error setting data source via ContentResolver" →
  // ENOENT), which silently swallowed all incoming-call audio.
  // Bravo ships its own WAV asset; see runtime/bravoTones.ts.
  // Vibration stays as a hardware-guaranteed fallback for silent mode.
  useEffect(() => {
    if (!isRinging) {return;}

    const tones = require('@/modules/messenger/runtime/bravoTones') as typeof import('@/modules/messenger/runtime/bravoTones');
    const ring  = require('@/modules/messenger/push/incomingRingtone') as typeof import('@/modules/messenger/push/incomingRingtone');
    // Why: on a warm-background ring the notifee wake path is ALREADY looping
    // the device-default ringtone for this callId (NA-06). Stay silent while it
    // owns the call; take over the instant the dismiss funnel stops it.
    const unbind = ring.bindInAppRingOwnership(callId, owns => {
      if (owns) {
        void tones.startRingtone();
        Vibration.vibrate([0, 800, 1200, 800], true);
      } else {
        void tones.stopRingtone();
        Vibration.cancel();
      }
    });
    return () => {
      unbind();
      void tones.stopRingtone();
      Vibration.cancel();
    };
  }, [isRinging, callId]);

  // Ringback tone for OUTGOING calls — the "calling…" beep the caller
  // hears while waiting for the callee to pick up. Same reason as
  // above for not using InCallManager.startRingback.
  useEffect(() => {
    const isOutgoingRinging = !isIncoming && liveCall.state === 'calling';
    if (!isOutgoingRinging) {return;}

    const tones = require('@/modules/messenger/runtime/bravoTones') as typeof import('@/modules/messenger/runtime/bravoTones');
    // Voice call → ringback through the earpiece (caller holds the phone
    // to their ear, system-dialer convention); video call → speaker. This
    // also keeps expo-av's speakerphone re-applies aligned with the route
    // the call wants, so answering lands on the correct output.
    void tones.startRingback(!isVideo);
    return () => {
      void tones.stopRingback();
    };
  }, [isIncoming, liveCall.state, isVideo]);

  // The "have we started the audio session yet?" flag lives on the
  // module-scoped callRegistry, NOT a useRef. Reason: when Android
  // shows the mic/camera permission dialog on the first call, RN
  // reports a quick pause/resume cycle that remounts CallScreen.
  // A useRef-based guard would reset to false on the second mount,
  // we'd call InCallManager.start() again after the first mount's
  // cleanup already stopped it, and the session would be dead.
  // Keying by callId lets the second mount see "already started"
  // and skip both start AND the unmount-stop, so the session lives
  // across the remount. Logcat tag: [bravo.callaudio].

  // Audio session lifecycle for the active call — InCallManager.start() does:
  //   • acquires the proximity wake-lock (screen turns OFF when held to ear,
  //     ON when pulled away — Android Telephony parity)
  //   • routes audio through earpiece by default (or speakerphone for video)
  //   • auto-mutes background audio (music/podcast) for the call duration
  //   • acquires a CPU wake-lock so Doze can't drop our WS during the call
  // Stop on unmount restores all of the above.
  useEffect(() => {
    if (!liveMode) {return;}
    // Why: Android 14+/targetSDK 34+ rejects startForeground(...microphone)
    // with SecurityException unless RECORD_AUDIO is already granted at
    // runtime. The permission-request effect below runs in parallel, so
    // without this gate the FGS fires before the prompt resolves and the
    // process crashes (logcat: CallForegroundService.kt:75 SecurityException).
    // Wait until the prompt has settled. On iOS permGranted is forced to
    // 'granted' synchronously so this is effectively a no-op there.
    if (permGranted !== 'granted') {return;}
    // For INCOMING calls, defer the audio session start until the user
    // actually accepts. Calling InCallManager.start() while the call is
    // still 'ringing' puts the device in MODE_IN_COMMUNICATION, which
    // routes the ringtone (startRingtone below) through the in-call
    // audio stream — quiet, often through the earpiece — instead of
    // the loud RINGER stream. That's why the callee couldn't hear the
    // ringtone: the audio session had already taken over before the
    // user even saw the incoming-call screen.
    //
    // Outgoing calls don't have this problem because there's no
    // ringtone on the offerer side — only the ringback tone, which
    // SHOULD play through the in-call stream.
    if (isIncoming && liveCall.state === 'ringing') {return;}
    // Audit CALL-N6 (2026-07-02): never (re)start the audio session on a
    // terminal call. endActiveCall clears the audioSessionStartedFor flag
    // while CallScreen is still mounted, so a state change to ended/failed
    // re-runs THIS effect and markAudioSessionStarted returns true again —
    // fully restarting InCallManager + the FG service on a dead call (audible
    // route pop, FG notification flash, and up to 4s of zombie session on a
    // 'failed' call while the alert shows). The real stop happens at unmount.
    if (liveCall.state === 'ended' || liveCall.state === 'failed') {return;}
    // Single-fire guard, keyed by callId on the module-scoped registry
    // so it survives the permission-dialog remount (Android pauses +
    // resumes the activity → RN remounts CallScreen → naive useRef
    // would reset). markAudioSessionStarted returns false on second
    // call for the same callId, so we know to skip start AND skip
    // the unmount-stop in the cleanup branch below.

    const {markAudioSessionStarted} = require('@/modules/messenger/runtime/callRegistry') as typeof import('@/modules/messenger/runtime/callRegistry');
    const cidForGuard = callId ?? `pending-${liveCall.callId ?? 'noid'}`;
    if (!markAudioSessionStarted(cidForGuard)) {
      console.log('[bravo.callaudio] start skipped — already-started for', cidForGuard);
      return;
    }
    console.log(`[bravo.callaudio] start media=${isVideo ? 'video' : 'audio'} state=${liveCall.state}`);
    logCallLat(isIncoming ? '1to1-in' : '1to1-out', callId, 'audio-session:start', {state: liveCall.state});
    // Foreground service FIRST — without it Android 14+ suspends mic/
    // camera capture seconds after the screen turns off. WhatsApp /
    // Signal model. JS no-op on iOS.

    const {startCallForegroundService} = require('@/modules/messenger/runtime/callForegroundService') as typeof import('@/modules/messenger/runtime/callForegroundService');
    startCallForegroundService({kind: isVideo ? 'video' : 'voice', peer: peerName || 'Bravo Secure'});
    preferredRouteRef.current = null;
    // Reset the idempotence guard so this call's FIRST route push always
    // lands (a prior call may have left lastAppliedRoute set). See the
    // BS-CALL-CHOPPY note on pickAudioRouteNative.
    lastAppliedRoute = null;
    // `auto: true` lets InCallManager auto-manage the proximity sensor
    // — correct for voice calls (turn screen off when held to ear) but
    // wrong for VIDEO calls (you'd black out your own preview every
    // time you bring the phone close to your face). Disable auto-prox
    // for video so the screen stays on regardless of what the
    // proximity sensor reads. setKeepScreenOn alone wasn't enough
    // because the sensor was overriding the wake-lock.
    if (Platform.OS === 'ios') {
      // B-109 RC-4 — under CallKit, audio units may only start after
      // CXProvider activates the AVAudioSession (didActivateAudioSession);
      // an app-activated session gets torn down on lock / lock-screen
      // answer. The wait resolves immediately when the bridge is inert and
      // falls through after 3s, so a CallKit-less run is never left silent.
      const {waitForIosAudioSession} = require('@/modules/messenger/push/callKitBridge') as typeof import('@/modules/messenger/push/callKitBridge');
      void waitForIosAudioSession(3000).then(activated => {
        console.log(`[bravo.callaudio] ios audio-session gate resolved activated=${activated}`);
        InCallManager.start({media: isVideo ? 'video' : 'audio', auto: !isVideo, ringback: ''});
      });
    } else {
      InCallManager.start({media: isVideo ? 'video' : 'audio', auto: !isVideo, ringback: ''});
    }
    InCallManager.setKeepScreenOn(isVideo);   // video: stay awake; voice: let proximity sensor turn it off
    if (isVideo) {
      try { InCallManager.stopProximitySensor(); } catch { /* ignore */ }
    }
    // Re-arm keep-screen-on aggressively for video calls. A single
    // setKeepScreenOn call sets WindowManager FLAG_KEEP_SCREEN_ON,
    // but Android clears it on configuration changes (rotation,
    // multi-window transitions, picture-in-picture) and some OEMs
    // also drop it on AppState foreground transitions. The result
    // was the screen dimming/locking 30s into a video call.
    // Fix #11: the AppState rebind path lives in the consolidated
    // listener at the top of the component (videoArmedRef). Here we
    // only own the periodic 5s re-arm tick so the flag is never stale
    // for more than 5 seconds even if no AppState transition fires.
    let armTick: ReturnType<typeof setInterval> | null = null;
    if (isVideo) {
      const arm = () => { try { InCallManager.setKeepScreenOn(true); } catch { /* ignore */ } };
      arm();
      videoArmedRef.current = true;
      // 2s (was 5s): on a stock Pixel the screen-off timeout fired inside
      // the 5s gap before a re-arm could land. 2s keeps FLAG_KEEP_SCREEN_ON
      // fresh well inside any OEM/stock screen-off timeout.
      armTick = setInterval(arm, 2_000);
    }
    // B-309 — the opening route SETTLES from the enumerated device set
    // instead of being applied blind. The blind media default made every
    // call with a headset attached audibly open on the LOUDSPEAKER and
    // jump into the headset ~1s later (the first onAudioDeviceChanged is
    // when the auto-snap could correct it). Now: first device event with
    // a headset → the auto-snap below owns it, the settle stays silent;
    // first event without one → the default applies right then; no event
    // in 1.2s (iOS has no enumerator) → the default applies at timeout.
    // Safe because audio only flows at CONNECTED, far past the window.
    openingSettleRef.current?.cancel();
    openingSettleRef.current = createOpeningRouteSettle({
      applyDefault: () => { pickAudioRouteNative(isVideo ? 'SPEAKER_PHONE' : 'EARPIECE'); },
    });
    // B-236u — the pick queue applies through pickAudioRouteNative so a
    // deferred pick still gets the BS-CALL-CHOPPY de-dupe + the
    // lastAppliedRoute cache the AppState/lock restores read.
    routePickQueueRef.current?.clear();
    routePickQueueRef.current = createRoutePickQueue({apply: pickAudioRouteNative});
    // The UI shows the intended default immediately — display intent, not
    // hardware state; the device event corrects both together.
    setAudioRoute(isVideo ? 'SPEAKER_PHONE' : 'EARPIECE');
    setIsSpeaker(isVideo);
    return () => {
      if (armTick) {clearInterval(armTick);}
      // B-309 — a settle mid-flight must not fire into the next session.
      openingSettleRef.current?.cancel();
      openingSettleRef.current = null;
      // B-236u — a queued pick must not fire into the next session either.
      routePickQueueRef.current?.clear();
      routePickQueueRef.current = null;
      // Fix #11: the AppState listener now lives at the top of the
      // component; clear the flag so it stops re-arming after the
      // audio session tears down.
      videoArmedRef.current = false;
      // Three-way decision on cleanup:
      //  1. keepAlive (minimize)         → leave everything running
      //  2. registry still owns this call → permission-dialog remount;
      //     the second mount will reuse the live session, so don't
      //     stop. The actual stop happens via endActiveCall() when the
      //     call truly ends.
      //  3. registry empty or different call → the call ended, tear
      //     down audio session + FG service + clear the started flag.

      const {getActiveCall, clearAudioSessionStarted} = require('@/modules/messenger/runtime/callRegistry') as typeof import('@/modules/messenger/runtime/callRegistry');
      const live = getActiveCall();
      if (live?.keepAlive) {
        console.log('[bravo.callaudio] cleanup skipped — keepAlive (minimized)');
        return;
      }
      if (live && live.callId === cidForGuard) {
        console.log('[bravo.callaudio] cleanup skipped — registry still owns call (remount)');
        return;
      }
      console.log('[bravo.callaudio] stop');
      // Arbitrated — a 1:1 screen unmounting must not stop the session a live
      // group call is using. See callAudioSession.ts.

      // B-425 — hand the user's own call-volume setting back. No-op when we
      // never raised it, or when they moved the slider themselves mid-call.
      restoreCallVolume();

      const {stopSharedAudioSession} = require('@/modules/messenger/runtime/callAudioSession') as typeof import('@/modules/messenger/runtime/callAudioSession');
      stopSharedAudioSession('direct');
      // Tear down the foreground service — leaving it running would
      // keep the persistent notification visible and waste a slot in
      // Android's foreground-service quota.

      const {stopCallForegroundService} = require('@/modules/messenger/runtime/callForegroundService') as typeof import('@/modules/messenger/runtime/callForegroundService');
      stopCallForegroundService('direct');
      clearAudioSessionStarted(cidForGuard);
    };
    // Re-fire if liveCall.state moves out of 'ringing' (incoming
    // accept) — that's when we want the audio session to start. Also
    // re-fire if isIncoming flips for any reason. permGranted is in
    // the deps so the effect re-runs the moment the OS dialog resolves
    // to 'granted' (FGS start was gated above). callId/peerName are
    // intentionally captured once at session start; re-binding would
    // tear down the live audio session on rename.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveMode, isVideo, isIncoming, liveCall.state, permGranted]);

  // BS-CALL-UPGRADE-PROX — disable the proximity sensor + keep the screen
  // on the moment a VOICE call gains video (mid-call camera upgrade, or
  // the peer turning their camera on). The main audio-session effect above
  // captures `isVideo` ONCE at mount (re-binding it would tear down the
  // live session), so a call that STARTS as voice keeps the proximity
  // sensor armed even after it becomes a video call — holding the phone to
  // your face then blanks the screen, and the route stays on the earpiece
  // (which also makes echo far more likely). Device logs confirmed this:
  // `start media=audio` fired, then `upgradeToVideo` ran, but
  // stopProximitySensor()/setKeepScreenOn(true) never did because they
  // live inside the `if (isVideo)` blocks of the mount-time effect.
  //
  // This effect keys off `isVideoUI` (the LIVE "does the call have video?"
  // flag), so it fires on upgrade. It is a no-op for calls that started as
  // video (the main effect already armed everything; re-arming is
  // idempotent) and for calls that never gain video (`isVideoUI` stays
  // false). We also re-arm setKeepScreenOn on a short tick while video is
  // live, mirroring the main effect, so an OS flag-drop can't re-sleep us.
  const videoUpgradeArmedRef = useRef(false);
  useEffect(() => {
    if (!liveMode || !isVideoUI) {return;}
    // One-time UPGRADE setup (proximity off + speaker route) — only when the
    // call GAINED video mid-session, not when it started as video (the
    // mount-time effect already did this; videoArmedRef+isVideo marks that).
    if (!(videoArmedRef.current && isVideo)) {
      console.log('[bravo.callaudio] video upgrade detected — disabling proximity, keeping screen on, routing to speaker');
      try { InCallManager.stopProximitySensor(); } catch { /* ignore */ }
      try { InCallManager.setKeepScreenOn(true); } catch { /* ignore */ }
      videoArmedRef.current = true;
      videoUpgradeArmedRef.current = true;
      // Route to speaker on upgrade ONLY if the user hasn't already pinned an
      // explicit route (BT/wired/earpiece) — honour their choice if they have.
      if (preferredRouteRef.current === null) {
        pickAudioRouteNative('SPEAKER_PHONE');
        setAudioRoute('SPEAKER_PHONE');
        setIsSpeaker(true);
      }
    }
    // Audit CALL-N7 (2026-07-02): the keep-screen-on re-arm tick now lives
    // HERE, keyed purely on isVideoUI, so it runs for BOTH started-as-video
    // AND upgraded calls. Previously the started-as-video tick lived inside
    // the audio-session effect, whose cleanup fired on the first dep change
    // (and on the permission-dialog remount) clearing armTick — and this
    // upgrade effect early-returned for started-as-video calls — so nothing
    // re-armed FLAG_KEEP_SCREEN_ON and the screen dimmed/locked mid-call.
    const arm = () => { try { InCallManager.setKeepScreenOn(true); } catch { /* ignore */ } };
    arm();
    const tick = setInterval(arm, 2_000);
    return () => { clearInterval(tick); };
  }, [liveMode, isVideoUI, isVideo]);

  // P2-BR-7 — re-foreground the call FGS with the CAMERA service type the
  // moment this 1:1 call gains video (voice→video upgrade, or the local
  // camera toggled on). Android 14 revokes while-in-use camera capture when
  // the app backgrounds unless the running foreground service declares
  // FOREGROUND_SERVICE_TYPE_CAMERA. The mount-time audio-session effect
  // starts the FGS with the kind captured at mount, so a call that STARTED
  // as voice keeps a mic-only FGS after upgrade and would lose the camera
  // on background. Mirrors GroupCallScreen's fgsKind re-foreground.
  // Idempotent: native onStartCommand re-runs goForeground with the new type.
  const fgsKindRef = useRef<'voice' | 'video'>(isVideo ? 'video' : 'voice');
  useEffect(() => {
    if (Platform.OS !== 'android') {return;}
    if (!liveMode) {return;}
    if (liveCall.state !== 'connected') {return;}
    if (permGranted !== 'granted') {return;}
    // B-69 — ratchet UP only: once the FGS holds the camera type, keep it for
    // the call's lifetime. Downgrading on camera-off and re-upgrading on
    // camera-on thrashed the FGS type (192→128→192 within 1.4 s on the
    // 2026-07-10 Pixel-7a log), and a camera-typed-FGS drop mid-capture can
    // stall the stream (black video). Holding CAMERA while the camera is off
    // is harmless — the type is a capability declaration, not an in-use flag.
    if (!isCameraOn || fgsKindRef.current === 'video') {return;}
    fgsKindRef.current = 'video';
    try {
      const {startCallForegroundService} = require('@/modules/messenger/runtime/callForegroundService') as typeof import('@/modules/messenger/runtime/callForegroundService');
      startCallForegroundService({kind: 'video', peer: peerName || 'Bravo Secure'});
    } catch { /* native module missing — ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- peerName is a display-only label read at fire time; a stale value is harmless and adding it would needlessly restart the FGS
  }, [isCameraOn, liveCall.state, liveMode, permGranted]);

  // Live audio-device change listener. The native module emits
  // `onAudioDeviceChanged` whenever a BT headset connects/disconnects
  // or a wired headset is plugged/unplugged. Payload is
  //   { availableAudioDeviceList: '["BLUETOOTH","EARPIECE",...]',
  //     selectedAudioDevice:      'EARPIECE' }
  // (note: availableAudioDeviceList is a JSON-encoded string, not an
  // array — that's the module's API quirk).
  //
  // Two behaviors:
  //  1. Update local state so the picker UI reflects what's available
  //     and which is currently active.
  //  2. Auto-snap to BT the FIRST time it appears, so users who pair
  //     their headset mid-call don't have to manually switch routes.
  //     We only snap once — if the user manually picks EARPIECE after
  //     auto-snap, subsequent BT-list-change events don't override
  //     their choice.
  useEffect(() => {
    if (!liveMode) {return;}
    // B-297 — a mount-time "seed" used to live here (B-251), reading a
    // synchronous `getAudioDeviceList()` that this native module has never
    // exposed. Through an optional call it evaluated to `undefined` without
    // throwing, so it populated nothing and snapped nothing. The
    // `onAudioDeviceChanged` subscription below already carries the full device
    // list on its FIRST fire and runs the same auto-snap, which is what has
    // been covering the already-connected-headset case in practice. Removed
    // rather than reimplemented — there is no synchronous enumerator to
    // reimplement it against.
    const sub = DeviceEventEmitter.addListener('onAudioDeviceChanged', (data: {availableAudioDeviceList?: string; selectedAudioDevice?: string}) => {
      // B-297 — the event payload is the ONLY device-list source that exists,
      // so it goes through the shared total parser rather than a local
      // JSON.parse + inline route filter (which was a third copy of both).
      const list: AudioRoute[] = parseAudioDeviceList(data?.availableAudioDeviceList);
      // B-309 — first enumeration feeds the opening-route settle (exactly-once
      // inside the settle; no headset present → the media default applies now).
      openingSettleRef.current?.onFirstDeviceList(list);
      // B-236u — AFTER the settle: a queued explicit pick applies on the first
      // list that can honour it (the settle was already cancelled at pick time,
      // so ordering only matters for the parked-pick apply itself).
      routePickQueueRef.current?.onDeviceList(list);
      setAudioRoutes(list);
      if (data?.selectedAudioDevice && (data.selectedAudioDevice === 'BLUETOOTH' || data.selectedAudioDevice === 'SPEAKER_PHONE' || data.selectedAudioDevice === 'EARPIECE' || data.selectedAudioDevice === 'WIRED_HEADSET')) {
        setAudioRoute(data.selectedAudioDevice);
      }
      // Route restoration on device-list change. Two cases:
      //
      // 1. No explicit preference yet (initial mount, or user never
      //    touched the picker) AND BT just became available → snap to
      //    BT once. Future picker changes set preferredRouteRef.
      //
      // 2. Explicit preference exists (user picked BT/SPK/EAR earlier)
      //    AND that preferred device is in the freshly-emitted list AND
      //    the OS-reported selectedAudioDevice is something else →
      //    re-apply the preference. This is the BT-drop-reconnect fix:
      //    SCO link briefly disconnects, OS falls back to EARPIECE, then
      //    BT comes back available a moment later — without this branch
      //    the audio stays on EARPIECE until the user manually re-picks.
      const sel = data?.selectedAudioDevice;
      if (preferredRouteRef.current === null) {
        // Auto-snap to a HEADSET the moment one appears. Wired is checked
        // first: plugging in headphones is a stronger, more deliberate signal
        // than a Bluetooth device that merely happens to be in range.
        //
        // Wired used to be missing entirely — only BT auto-snapped — so
        // plugging in headphones mid-call left the audio wherever it was. If
        // that was the speaker, the mic then re-captured the far end's voice
        // straight off the earpiece grille: a live acoustic echo path, and the
        // likely reason the far end hears themselves.
        // B-297 — the shared rule, not a fourth hand-copy of it. This branch is
        // now the ONLY place the already-connected-headset case is decided, so
        // it must agree with `initialCallRoute`'s precedence by construction.
        const snap = preferredHeadset(list);
        if (snap) {
          preferredRouteRef.current = snap;
          desiredRouteRef.current = snap;
          // B-297 — go through `pickAudioRouteNative`, not a raw
          // setForceSpeakerphoneOn + chooseAudioRoute pair. This branch is now
          // the live auto-snap (the dead mount seed used to be the one that
          // routed through the helper), and the raw pair bypassed BOTH halves
          // of the helper's contract: the BS-CALL-CHOPPY de-dupe guard, and
          // the `lastAppliedRoute` cache the AppState/lock restores read. A
          // stale cache is what B-278 had to invalidate by hand.
          pickAudioRouteNative(snap);
          setAudioRoute(snap);
          setIsSpeaker(false);
          return;
        }
      }
      // Re-assert the route we want whenever the OS has moved us off it.
      //
      // This used to key off preferredRouteRef ALONE, which only ever holds an
      // EXPLICIT picker choice (or the BT auto-snap above). On a plain voice
      // call with no Bluetooth and no manual pick it is null for the whole
      // call, so this branch never ran: lock the screen, Android re-evaluates
      // devices and hands us SPEAKER_PHONE, and nothing ever put it back. The
      // existing AppState restore only fires when the app returns to the
      // FOREGROUND — no help at all while the screen is still locked and the
      // user is mid-conversation on the loudspeaker.
      //
      // desiredRouteRef is always populated (it falls back to the speaker
      // toggle), so the restore now works with no preference at all.
      // B-425 — the call stream's volume index is PER OUTPUT DEVICE, so it is
      // only knowable once a route has actually landed. Measured on the
      // founder's phone: routing to the paired headset dropped VOICE_CALL from
      // 15/15 to 7/15 half a second after SCO connected, and back to 15 when it
      // dropped out. Raise-if-below-floor only; see callVolumeFloor.ts for why
      // this is not a "force the volume up".
      void applyCallVolumeFloor();
      const want = preferredRouteRef.current ?? desiredRouteRef.current;
      if (want && list.includes(want) && sel !== want) {
        /**
         * B-391c — THE RESTORE PATH IS THE ONE A CAR ACTUALLY NEEDS, and it was
         * the only apply site in this file that never told Telecom.
         *
         * B-391b wired `reportAudioRoute` into `pickAudioRouteNative`, so the
         * seed, the auto-snap and the picker all mirror our target onto the
         * self-managed Telecom Connection — which for a self-managed call is
         * the owner of the HFP link. This branch hand-rolled the same pair of
         * native calls and mirrored nothing, so InCallManager was told to go
         * back to the car and Telecom was not.
         *
         * That asymmetry is invisible with earbuds and decisive in a car: a car
         * kit drops SCO routinely — engine start/stop, the head unit taking its
         * own navigation prompt, a handover between phone and car audio — and
         * every one of those lands here. So the ONE path that runs after a car
         * drops the link was the one that could not bring it back.
         *
         * `invalidateAppliedRoute()` first, because the guard inside
         * `pickAudioRouteNative` compares against what we last ASKED for, not
         * what the hardware did. Arriving here means the OS has already moved
         * us off `want` — the cache is stale by definition, and without this
         * the funnelled call would be swallowed as a no-op (B-278's class,
         * which the AppState path had to learn the same way).
         */
        // …but ONLY when the cache is the thing in the way.
        //
        // Invalidating unconditionally disarmed the BS-CALL-CHOPPY de-dupe on
        // the highest-frequency path in the file: `onAudioDeviceChanged` fires
        // repeatedly through a car's multi-second SCO handshake, and the funnel
        // also writes the Telecom route, which can itself move AudioManager and
        // re-emit the event. That is a feedback loop with no brake — the exact
        // SCO churn (startSco/stopScoAudio) behind the choppy audio.
        //
        // The stale-cache case this fix is about is precisely
        // `lastAppliedRoute === want`: we asked for `want`, the OS moved us off
        // it, and the guard would swallow the correction. Any other value and
        // the funnel proceeds on its own.
        if (appliedRouteIs(want)) {invalidateAppliedRoute();}
        pickAudioRouteNative(want);
      }
    });
    return () => sub.remove();
  }, [liveMode]);

  // Manual route change — used by the picker UI. Wraps the async
  // chooseAudioRoute call so callers can await success and the picker
  // closes only after the route actually flips.
  const pickAudioRoute = useCallback((nextRoute: AudioRoute) => {
    // Pin the user's explicit choice so the device-list-change handler
    // restores it on the next BT SCO drop+reconnect cycle (instead of
    // stranding on EARPIECE the way the old "auto-snap once" model did).
    preferredRouteRef.current = nextRoute;
    // B-236u × B-309 — an explicit pick beats the opening settle
    // (sticky-explicit-pick, extended not forked): the media default must
    // never land after the user has chosen.
    openingSettleRef.current?.cancel();
    // Optimistic UI flip — chooseAudioRoute resolves 200-1200 ms later
    // when switching to BLUETOOTH (SCO link negotiation). Painting the
    // sheet closed + the new icon immediately is what makes the swap
    // feel "smooth" to the user instead of "the button is dead".
    setAudioRoute(nextRoute);
    setRoutePickerOpen(false);
    // B-236u — apply through the queue: during the first ~11 s the native
    // device list is empty and selectAudioDevice drops every pick; the queue
    // parks it and applies on the first list that can honour it. The apply
    // primitive (pickAudioRouteNative) keeps the force-flag handling and the
    // BS-CALL-CHOPPY de-dupe.
    const q = routePickQueueRef.current;
    if (q) {q.pick(nextRoute);} else {pickAudioRouteNative(nextRoute);}
  }, []);

  // Speaker toggle in the UI flips between SPEAKER_PHONE and EARPIECE.
  // Use chooseAudioRoute (via pickAudioRouteNative helper) — the only
  // Android API that reliably switches routes mid-call once the audio
  // session has been started with media='video'. setSpeakerphoneOn
  // alone is silently overridden by the session's ForceSpeakerphoneOn
  // flag on Android 13+, which is why the Speaker button felt dead
  // during video calls. Also mirror the audioRoute state so the picker
  // UI reflects the actual route the user is now on.
  // Fix #5: re-apply the route ONCE after we leave 'ringing'. The
  // listener above bails while ringing (correct — would silence the
  // ringtone), but if isSpeaker was toggled DURING ringing (or even
  // pre-mount via the initial-state's `isVideo` default), the deps
  // satisfied the check before the bail, so the route never landed
  // post-accept. We mark "needs reapply" while ringing and consume
  // the flag exactly once when state moves out of ringing.
  const speakerNeedsReapplyRef = useRef(false);
  const routeGuardCallStateRef = useRef<string | null>(null);
  useEffect(() => {
    if (!liveMode) {return;}
    // Don't touch audio routing during the incoming-ringing window —
    // the system ringer is playing through the RINGER stream and we
    // mustn't switch the device into call mode yet (would silence
    // the ringtone). Routing kicks in once the user accepts.
    if (isIncoming && liveCall.state === 'ringing') {
      speakerNeedsReapplyRef.current = true;
      routeGuardCallStateRef.current = liveCall.state;
      return;
    }
    // Why: the ringback/ringtone player (expo-av) flips speakerphone ON
    // when it acquires audio focus, so after any call-state transition
    // lastAppliedRoute's belief may be stale — the device can sit on
    // loudspeaker while the UI says earpiece, and the guard would skip
    // the corrective re-apply. Drop the guard once per state transition
    // so this application always reaches the hardware; same-state runs
    // (user toggles, screen-on/hold reapplies) keep the guard and the
    // BS-CALL-CHOPPY SCO-churn fix intact.
    if (routeGuardCallStateRef.current !== liveCall.state) {
      routeGuardCallStateRef.current = liveCall.state;
      lastAppliedRoute = null;
    }
    // The route the user actually wants right now: an explicit picker
    // choice (BT / wired / spk / ear) wins; otherwise it's the speaker
    // toggle. Capture it in the reapply closure so screen-on can restore
    // it after the OS flips the route during a proximity/lock blackout.
    const desired: AudioRoute = preferredRouteRef.current ?? (isSpeaker ? 'SPEAKER_PHONE' : 'EARPIECE');
    desiredRouteRef.current = desired;
    reapplyRouteRef.current = () => {
      pickAudioRouteNative(desired);
      setAudioRoute(desired);
    };
    // Re-apply unconditionally if we were just unblocked by the state
    // transition, even if isSpeaker hadn't toggled (so the value gets
    // a fresh chooseAudioRoute call after the system ringer stops).
    pickAudioRouteNative(desired);
    setAudioRoute(desired);
    speakerNeedsReapplyRef.current = false;
  }, [isSpeaker, liveMode, isIncoming, liveCall.state]);

  // Hold = mute the local mic + force-speaker-off so the peer hears
  // nothing AND we hear nothing. Resume restores both. Without this
  // wiring the Hold button was purely cosmetic — it flipped a state
  // value but didn't affect audio. WhatsApp/Telegram use the same model.
  useEffect(() => {
    if (!liveMode) {return;}
    if (isOnHold) {
      // Suspend mic capture by disabling the audio track. The PC keeps
      // the transport alive (so resume is instant), but no media frames
      // are produced. Same for any inbound: route to earpiece (quietest)
      // so the user doesn't hear noise leaking from the held side.
      try { liveCall.toggleMute(); } catch { /* ignore */ }   // mute mic
      pickAudioRouteNative('EARPIECE');
    } else {
      // On resume, only un-mute if the user hasn't independently muted
      // (the flag flips back through the hook). isMuted reflects the
      // controller state, so checking it avoids a double-toggle.
      if (isMuted) {
        try { liveCall.toggleMute(); } catch { /* ignore */ }
      }
      pickAudioRouteNative(isSpeaker ? 'SPEAKER_PHONE' : 'EARPIECE');
    }
    // intentional: only react to hold state. mute/speaker change paths
    // own their own effects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnHold, liveMode]);

  // Single source of truth for the call-record append is the
  // unmount-cleanup effect below (search "cleanup-fire call record").
  // Reasoning: the previous implementation had TWO effects appending a
  // record — one keyed on `liveCall.state === 'ended'` and one on
  // unmount. They would race on rapid hangup → unmount: the state
  // effect fired, the cleanup effect saw `callRecordedRef.current ===
  // true` and bailed (good); but for unmounts that happened BEFORE the
  // state ever transitioned to 'ended' (back-press during connecting,
  // OS-killed activity), only the cleanup effect ran. Keeping just the
  // cleanup path means classification logic lives in one place.
  const callRecordedRef = useRef(false);

  // Track the live duration in a ref so the unmount-cleanup below can
  // see the actual time the call was connected — not zero. Without this
  // a brief connection that ended via unmount (e.g., back-press during
  // the 1-second window between handshake completing and 'ended' frame
  // arriving) was falsely recorded as 'missed' or 'declined' rather
  // than 'answered · 1s'.
  const callDurationRef = useRef(callDuration);
  useEffect(() => { callDurationRef.current = callDuration; }, [callDuration]);

  // Single-source-of-truth call-record append (see Fix #4). Runs ONLY
  // on unmount so it covers every termination path: clean hangup,
  // remote hangup, back-press, app-killed, nav reset. Reads the latest
  // state via refs (callDurationRef, liveCallRef) so the snapshot is
  // accurate regardless of how the call ended.
  // Classification rules:
  //   • liveCall.state === 'failed' → 'failed'
  //   • registry.connectedAtMs set OR callDuration > 0 → 'answered'
  //     (the registry's connectedAtMs is stamped from the controller's
  //     iceConnectionState/connectionState transition, so it's true
  //     even if the UI duration counter hadn't ticked yet)
  //   • else: incoming → 'missed', outgoing → 'declined'
  useEffect(() => {
    return () => {
      if (callRecordedRef.current || !conversationId) {return;}
      callRecordedRef.current = true;
      const liveDuration = callDurationRef.current;
      let everConnected = liveDuration > 0;
      try {

        const reg = require('@/modules/messenger/runtime/callRegistry') as typeof import('@/modules/messenger/runtime/callRegistry');
        if (reg.getActiveCall()?.connectedAtMs !== undefined && reg.getActiveCall()?.connectedAtMs !== null) {everConnected = true;}
      } catch { /* registry is optional */ }
      const finalState = liveCallRef.current?.state;
      const outcomeAtUnmount: 'answered' | 'missed' | 'declined' | 'failed' =
        finalState === 'failed'
          ? 'failed'
          : everConnected
            ? 'answered'
            : (isIncoming ? 'missed' : 'declined');
      const peerForRecord = convo?.peer ?? {userId: peerUserId ?? '', deviceId: remoteDeviceId ?? 1};
      const recordId = `call-${callId ?? Date.now().toString(36)}`;
      console.log('[CallScreen] cleanup-fire call record', {
        conversationId, recordId, outcomeAtUnmount, duration: liveDuration, finalState,
      });
      useMessengerStore.getState().appendMessage(conversationId, {
        id:              recordId,
        conversation_id: conversationId,
        sender_id:       isIncoming ? peerForRecord.userId : 'self',
        type:            'call',
        content:         '',
        status:          'sent',
        is_encrypted:    false,
        created_at:      new Date().toISOString(),
        peer:            peerForRecord,
        call_meta: {
          kind:      callType,
          direction: isIncoming ? 'incoming' : 'outgoing',
          outcome:   outcomeAtUnmount,
          duration:  liveDuration,
        },
      });
    };
    // Empty deps so cleanup runs only on unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Surface call failures so the user isn't stranded on a blank screen.
  useEffect(() => {
    if (liveCall.state === 'failed') {
      // B-05 — a 'failed' call is ALWAYS a network/transport drop (the WS
      // to the relay died, or ICE couldn't restart). It is NEVER an
      // encryption failure: every call DTLS-verifies before it can reach
      // this state. The old copy ("Could not establish a secure
      // connection") made a server/network problem look like a crypto bug.
      // Also auto-dismiss after a short beat so the user isn't stranded
      // behind the popup if they never tap OK.
      let done = false;
      const dismiss = () => {
        if (done) {return;}
        done = true;
        // B-319 — same single-route-stack fallback as dismissCallScreen.
        try {
          if ((navigation as unknown as {canGoBack?: () => boolean}).canGoBack?.() === false) {
            const {navigationRef} = require('@/navigation/navigationRef') as typeof import('@/navigation/navigationRef');
            // Ops-Room call fix (2026-08-09) — shell-aware home exit.
            navigateToMessengerScreen(navigationRef as never, 'MessengerHome', {});
            return;
          }
        } catch { /* fall through to goBack */ }
        navigation.goBack();
      };
      // CALL-14 — a mic/camera permission denial also lands here as
      // 'failed' (getUserMedia rejects → useCall boot fails). Showing
      // the generic "Connection lost" copy blamed the network for a
      // local permission problem. Give actionable guidance instead.
      if (permGrantedRef.current === 'denied') {
        Alert.alert(
          isVideo ? 'Microphone & camera permission required' : 'Microphone permission required',
          `Bravo Secure needs ${isVideo ? 'microphone and camera' : 'microphone'} access to make calls. ` +
          'Enable it in Settings → Apps → Bravo Secure → Permissions, then try again.',
          [{text: 'OK', onPress: dismiss}],
        );
      } else {
        Alert.alert(
          'Call ended',
          'Connection lost — couldn’t reconnect. Please try again.',
          [{text: 'OK', onPress: dismiss}],
        );
      }
      const t = setTimeout(dismiss, 4000);
      return () => clearTimeout(t);
    } else if (liveCall.state === 'ended') {
      // Auto-dismiss whenever the call ends — covers both "peer hung up
      // before we ever connected" AND "peer hung up mid-call". 50ms delay so
      // the appendMessage useEffect above gets to commit its store update
      // before this screen unmounts. dismissedRef de-dupes against the endCall
      // watchdog so the two paths can't both pop (the 2nd lands on the parent).
      const t = setTimeout(() => {
        // B-306 — funnel through the consuming helper (it owns dismissedRef).
        dismissCallScreen();
      }, 50);
      return () => clearTimeout(t);
    }
    // isVideo is a route-derived const — inert in deps, satisfies the lint.
  }, [liveCall.state, navigation, callDuration, isVideo]);

  useEffect(() => {
    void (async () => {
      if (Platform.OS !== 'android') { setPermGranted('granted'); return; }
      // BLUETOOTH_CONNECT (Android 12+, API 31): InCallManager's BT
      // route discovery returns an empty device list without it, so
      // chooseAudioRoute('BLUETOOTH') silently fails AND the route
      // picker UI never opens because audioRoutes stays []. PermissionsAndroid
      // exposes it as the literal string on platforms below 31, so guard
      // by Platform.Version. We treat denial as non-fatal — the call still
      // works on the earpiece/speaker, just not BT.
      const needed = [
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
        ...(isVideo ? [PermissionsAndroid.PERMISSIONS.CAMERA] : []),
      ];
      const optional: string[] = [];
      const apiLevel = typeof Platform.Version === 'number' ? Platform.Version : Number.parseInt(String(Platform.Version), 10);
      if (apiLevel >= 31) {
        optional.push('android.permission.BLUETOOTH_CONNECT');
      }
      try {
        const results = await PermissionsAndroid.requestMultiple([...needed, ...optional] as never);
        const ok = needed.every(p => results[p] === PermissionsAndroid.RESULTS.GRANTED);
        setPermGranted(ok ? 'granted' : 'denied');
        // BT denial is non-blocking — log and continue.
        if (apiLevel >= 31 && results['android.permission.BLUETOOTH_CONNECT'] !== PermissionsAndroid.RESULTS.GRANTED) {
          console.warn('[CallScreen] BLUETOOTH_CONNECT not granted — BT route picker will be unavailable');
        }
      } catch {
        setPermGranted('denied');
      }
    })();
  }, [isVideo]);

  // Debounce the End / Decline buttons so a rapid double-tap can't fire
  // two `liveCall.hangup()` + `navigation.goBack()` cycles. Without this
  // ref the second goBack pops the PARENT screen — user lands two
  // screens deep with no idea why. We also surface it to the
  // `beforeRemove` listener (BS-022 minimise gesture) below so a swipe-
  // back during a hangup doesn't briefly minimise to a registry that's
  // about to clear (FloatingCallOverlay flicker).
  //
  // Single dismissal path: endCall does NOT call navigation.goBack()
  // directly. liveCall.hangup() flips controller state to 'ended' →
  // useCall.onState fires → liveCall.state becomes 'ended' → the
  // auto-dismiss effect at the top of this file pops the screen with
  // a 50ms delay (giving appendMessage time to commit the call-record
  // bubble first). The previous code called BOTH paths and the second
  // goBack landed on the parent screen ~50ms after CallScreen unmounted,
  // popping it too. The flag on `endingNow` is read by the beforeRemove
  // gesture handler below so a swipe-back during a hangup doesn't
  // minimise into a registry that's about to clear.
  const hangupInFlightRef = useRef(false);
  /**
   * WI-2.4 — the End/Decline pop watchdog, owned.
   *
   * Fires only if the state never reaches a terminal value (so the auto-dismiss
   * effect never runs). It MUST stay routed through `dismissCallScreen()`:
   * that helper owns `dismissedRef` (exactly-once) and consumes any group ring
   * parked behind this call (B-306). A raw `goBack()` here bypasses both, which
   * is why the B-306 pin explicitly forbids pinning the raw shape.
   */
  const armPopWatchdog = (): void => {
    if (popWatchdogRef.current) {clearTimeout(popWatchdogRef.current);}
    popWatchdogRef.current = setTimeout(() => {
      popWatchdogRef.current = null;
      dismissCallScreen();
    }, POP_WATCHDOG_MS);
  };
  const endCall = () => {
    if (hangupInFlightRef.current) {return;}
    hangupInFlightRef.current = true;
    setTearingDown(true); // freeze the RTCView tree before the pop
    Vibration.vibrate([0, 80, 60, 80]);
    // REGISTRY FIRST, then the controller.
    //
    // The reverse order silently mis-reported every End the user pressed here.
    // The controller hangup drives the controller terminal, whose registry end
    // is hard-coded `source: 'remote'` (it genuinely cannot know who ended the
    // call) — and with the slot still live, THAT call won the teardown and
    // reported `remoteEnded`. `reportEndCallWithUUID` is first-write-wins, so
    // the `'local'` below never reached the bridge and the dominant End path
    // landed in iOS Recents and the Android call log with the remote-ended
    // glyph. Ending through the registry first makes `'local'` the reason that
    // wins; the registry hangs the controller up itself, and the terminal
    // re-entry then reports `'ending'` and skips its own fallback.
    //
    // WI-1.1 — weak (callId) ref: End on THIS screen may only end THIS screen's
    // call, never whatever happens to hold the slot.
    try {
      const reg = require('@/modules/messenger/runtime/callRegistry') as typeof import('@/modules/messenger/runtime/callRegistry');
      if (callId) {reg.endActiveCall(callId, 'ended', 'local');}
    } catch { /* ignore */ }
    // Belt-and-suspenders — idempotent, and still needed for the boot-window
    // case where there is no registry entry AND no controller.
    try { liveCall.hangup(); } catch { /* idempotent */ }
    // Watchdog: if state never reaches 'ended' (so the auto-dismiss effect never
    // fires), force the pop. dismissedRef (owned by dismissCallScreen) de-dupes
    // against that effect.
    // WI-2.4 — owned so unmount clears it. Still funnels through
    // dismissCallScreen (B-306): it latches dismissedRef AND consumes any
    // parked group ring; a raw goBack here would bypass both.
    armPopWatchdog();
  };
  const declineCall = () => {
    if (hangupInFlightRef.current) {return;}
    hangupInFlightRef.current = true;
    setTearingDown(true);
    Vibration.cancel();
    // B-102 A2 — decline() reports whether a live controller handled it.
    // In the null-controller boot window the old code was a silent no-op
    // that STILL latched hangupInFlightRef + tearingDown, freezing the
    // screen with every later tap swallowed. Fall back to the push-layer
    // decline (caller stops ringing) and pop via the same watchdog endCall
    // has — dismissedRef de-dupes against the state-driven auto-dismiss.
    let hadController = false;
    try { hadController = liveCall.decline(); } catch { /* idempotent */ }
    if (!hadController && callId) {
      try {
        const fb = require('@/modules/messenger/push/fcmBootstrap') as typeof import('@/modules/messenger/push/fcmBootstrap');
        fb.declineIncomingCallBestEffort(callId);
      } catch { /* push layer unavailable — watchdog still pops the screen */ }
    }
    armPopWatchdog();
  };
  // CALL-07 — keep the BackHandler's decline path on the latest closure.
  useEffect(() => { declineCallRef.current = declineCall; });

  // Why: NA-02 — dead-offer watchdog. Two exit triggers, both invisible to the
  // rest of the machinery while `useCall` is stuck pre-controller (no
  // controller ⇒ hangup() is a no-op; no callRegistry entry ⇒ the dispatcher's
  // endZombieSession and the FCM call-cancel path both no-op):
  //   1. the accept intent aged past ACCEPT_INTENT_TTL_MS — the offer is dead;
  //   2. the callId got tombstoned — the caller cancelled over WS or FCM.
  // Armed ONLY once an accept intent exists (autoAccept / on-screen Answer); a
  // plain ring keeps its existing ring surface + ringtone untouched. Disarms
  // the instant accept() fires (autoAcceptedRef) or the user ends/declines
  // (hangupInFlightRef), so a live call can never be killed here.
  useEffect(() => {
    if (!isIncoming || !callId || deadOffer) {return;}
    if (!(autoAccept || userAccepted)) {return;}
    if (autoAcceptedRef.current || hangupInFlightRef.current) {return;}
    if (acceptIntentAtRef.current === null) {acceptIntentAtRef.current = Date.now();}
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => { if (timer) {clearInterval(timer); timer = null;} };
    const tick = () => {
      if (autoAcceptedRef.current || hangupInFlightRef.current || dismissedRef.current) {
        stop();
        return;
      }
      // Why: the per-mount refs above only know about THIS mount's accept, so a
      // call adopted from the registry (restored from the floating overlay) and
      // answered on another surface would still look dead. The registry is the
      // cross-mount liveness signal — never tear down a call that connected.
      try {
        const reg = require('@/modules/messenger/runtime/callRegistry') as typeof import('@/modules/messenger/runtime/callRegistry');
        const live = reg.getActiveCall();
        if (live && live.callId === callId &&
            (live.state === 'connecting' || live.state === 'connected' || live.state === 'reconnecting')) {
          stop();
          return;
        }
      } catch { /* registry unavailable (tests) — the ref gates still apply */ }
      let peerCancelled = false;
      try {
        const cache = require('@/modules/messenger/push/incomingCallCache') as typeof import('@/modules/messenger/push/incomingCallCache');
        peerCancelled = cache.isIncomingCallDead(callId);
      } catch { /* cache unavailable (tests) — the deadline still fires */ }
      const startedAt = acceptIntentAtRef.current;
      const expired = startedAt !== null && Date.now() - startedAt > ACCEPT_INTENT_TTL_MS;
      if (!peerCancelled && !expired) {return;}
      console.warn(
        `[bravo.call] dead-offer watchdog fired cid=${callId.slice(0, 8)} ` +
        `reason=${peerCancelled ? 'peer-cancelled' : 'accept-intent-expired'}`,
      );
      stop();
      setDeadOffer(true);
    };
    timer = setInterval(tick, 1_000);
    return stop;
  }, [isIncoming, callId, autoAccept, userAccepted, deadOffer]);

  // Why: NA-02 — terminal handling for the dead-offer verdict: tear down every
  // ring surface (reusing the B-102 null-controller path), let the user read
  // the "Couldn't connect" label for a beat, then pop. The unmount call-record
  // effect files the leg as an incoming 'missed' call — no extra bubble here.
  useEffect(() => {
    if (!deadOffer) {return;}
    // Why: claim the teardown (a later End/Decline tap must not run a second
    // one) and end any adopted callRegistry entry — otherwise the BS-022
    // `beforeRemove` listener converts the pop below into a floating overlay
    // for the call we just reported failed. Both are idempotent and no-ops on
    // the primary dead-offer path (no controller, empty registry).
    hangupInFlightRef.current = true;
    setTearingDown(true);
    Vibration.cancel();
    Vibration.vibrate([0, 80, 60, 80, 60, 80]);
    if (callId) {
      try {
        const fb = require('@/modules/messenger/push/fcmBootstrap') as typeof import('@/modules/messenger/push/fcmBootstrap');
        fb.declineIncomingCallBestEffort(callId, 'failed');
      } catch { /* push layer unavailable — the pop below still runs */ }
    }
    try { liveCallRef.current?.hangup(); } catch { /* no controller on this path */ }
    try {
      const reg = require('@/modules/messenger/runtime/callRegistry') as typeof import('@/modules/messenger/runtime/callRegistry');
      if (callId) {reg.endActiveCall(callId, 'ended', 'local');}
    } catch { /* ignore */ }
    // B-306 — the dead-offer pop funnels through the consuming helper too: a
    // group ring parked behind a 1:1 that never even connected should surface
    // the moment this screen leaves.
    const t = setTimeout(() => { dismissCallScreen(); }, 1_800);
    return () => clearTimeout(t);
  }, [deadOffer, callId, navigation]);

  // Minimise = go back to Chat without ending the call. Silent (no buzz).
  const minimise = () => popOrHome();

  /**
   * Escalate the active 1:1 call to a group call by adding `pickedUserId`
   * as a third participant. We end the P2P leg first, then route through
   * the SFU path (`launchCall`-equivalent) with both the original peer
   * AND the picked user in the recipient list. The original peer's
   * existing CallScreen tears down on the call.hangup signal we just
   * fired, then their app rings via `sfu.ring.incoming` like any group
   * call invite. The newcomer rings the same way.
   */
  const escalateToGroupCall = async (picked: {userId: string; displayName: string}): Promise<void> => {
    // B-111-A — escalation converts to an SFU group call, which this build
    // cannot run without FrameCryptor (iOS until B-111-B). Gate BEFORE the
    // 1:1 leg is hung up so the live call survives the refusal.
    try {
      const {frameCryptorOrchestratorAvailable} = require('@/modules/messenger/webrtc/frameCryptorOrchestrator') as typeof import('@/modules/messenger/webrtc/frameCryptorOrchestrator');
      if (!frameCryptorOrchestratorAvailable()) {
        Alert.alert(
          'Group calls not available yet',
          'Adding a participant turns this into a group call, which is not supported on this device yet. Your current call continues.',
        );
        return;
      }
    } catch { /* probe unavailable — proceed as before */ }
    console.log('[add-call] escalate picked=', picked.userId, 'name=', picked.displayName, 'remoteUserId=', remoteUserId, 'conversationId=', conversationId);
    if (!remoteUserId) {
      console.warn('[add-call] aborted — no remoteUserId on this call');
      Alert.alert('Add failed', 'Original call peer is unknown.');
      return;
    }
    setAddPickerOpen(false);
    // B-301 — PRE-FLIGHT THE TRANSPORT BEFORE THE DESTRUCTIVE STEP.
    //
    // Everything below this line is irreversible: the 1:1 is hung up here, but
    // the SFU room is only created later, in GroupCallScreen. Nothing rolls the
    // hangup back, so a room that never forms costs the user a call that was
    // working — and leaves them on "Call failed" with nothing to return to.
    //
    // The B-111-A gate above already refuses cleanly for one cause (no
    // FrameCryptor). The most likely remaining one is having no relay
    // transport, in which case the room CANNOT be created at all — and that is
    // exactly the flaky-network moment when someone reaches for "Add". Refuse
    // it the same way, with the live call intact.
    //
    // This does not make escalation atomic: a failure after a healthy
    // pre-flight still loses the 1:1. The complete fix is to create the room
    // BEFORE hanging up, which is a cross-screen restructure of the handshake
    // (tracked in sqa.md under B-301) rather than something to improvise here.
    const preflightWs = await waitForLiveTransport(4000);
    if (!preflightWs) {
      Alert.alert(
        'Add failed',
        'You are not connected right now, so the group call could not be started. Your current call continues.',
      );
      return;
    }
    Vibration.vibrate(20);
    // B-301 — DO NOT HANG UP HERE. This used to cut the 1:1 before the SFU room
    // existed, with no rollback: a room that never formed cost the user a call
    // that was working.
    //
    // The screen already knows how to survive its own unmount with the call
    // running. The `beforeRemove` listener above minimizes any live call ("a
    // swipe-back gesture must minimize a live call, never cut it — for every
    // non-terminal state"), which sets keepAlive so useCall's cleanup leaves the
    // controller alone and the FloatingCallOverlay takes over. That fires on
    // `replace` too. The ONLY reason escalation lost the call is that hangup()
    // ran FIRST and drove the state terminal, so that branch stopped matching.
    //
    // So the 1:1 rides through the navigation, minimized, and GroupCallScreen
    // ends it once the room is genuinely JOINED. Fail before that and the call
    // is still up, with the overlay as the way back. Either you land in the
    // group call or you keep the call you started with.
    //
    // The other party benefits too: previously they were cut and then re-rung,
    // with a real gap; now they keep their working call until the room exists.
    const pendingDirectCallId = (() => {
      try {
        const reg = require('@/modules/messenger/runtime/callRegistry') as typeof import('@/modules/messenger/runtime/callRegistry');
        return reg.getActiveCall()?.callId;
      } catch { return undefined; }
    })();
    // B-124 — this REUSES the 1:1 conversation id as the escalated call's
    // ROOM/rendezvous id (signalling only). Since the root fix (handoff
    // item 2, founder-approved 2026-07-21) the throwaway 'Call' key is
    // NEVER aliased under this chat-bearing id: it lives only under its
    // minted 32-hex id, linked via callKeyRegistry. The routing seam
    // (type:'direct' veto) and the boot sweep remain as defense-in-depth
    // for state written by pre-fix builds.
    const groupConvoId = conversationId; // keep the bubble on the same chat
    const ownerId = currentUserId;
    const recipientUserIds = Array.from(new Set(
      [remoteUserId, picked.userId].filter(uid => uid && uid !== ownerId),
    ));
    // BS-CALL-ADHOC — advertise the HOST's own name to the ring. Using the
    // local conversation name here sent the host's label for the OTHER party,
    // so the joiner saw the wrong (often their own saved) name on the
    // incoming call. The host's display name is unambiguous on every device.
    const callerLabel = ownDisplayName;
    /**
     * Hand the CAMERA over before the group boot asks for it.
     *
     * B-301 deliberately keeps the 1:1 alive across this `replace` so a
     * failed escalation has something to fall back to. What it did not
     * account for is the capture device: the 1:1 still holds the camera,
     * and GroupCallScreen's boot immediately calls getUserMedia for the
     * same one. react-native-webrtc serialises camera opens, so the group
     * boot queues behind a holder that is not going to let go, hits the 15s
     * bound and dies — and because the boot ring is sent AFTER sfu.join,
     * NOBODY is ever rung. That is "the 1:1 turned into a group call and the
     * other person can't enter".
     *
     * Before 0bc67a62 (B-301) this was hidden: escalation called
     * `liveCall.hangup()` first, which stopped both tracks. Removing the
     * hangup was right; dropping the device release with it was not.
     *
     * MIC IS DELIBERATELY LEFT ALONE. Releasing it would silently mute a
     * call that is still live and is the rollback target. The camera is the
     * device that actually contends, and camera-off is visible and
     * recoverable — on rollback useCall re-derives `videoReleasedRef` from
     * `isVideoOff && !videoTrack` (useCall.ts:356), so the user's next
     * camera tap re-acquires properly instead of appearing dead.
     */
    try {
      const reg = require('@/modules/messenger/runtime/callRegistry') as typeof import('@/modules/messenger/runtime/callRegistry');
      const liveDirect = reg.getActiveCall();
      const liveVideo = liveDirect?.videoTrack ?? null;
      if (liveDirect && liveVideo) {
        try { liveVideo.stop(); } catch { /* already ended */ }
        const keptAudio = liveDirect.audioTrack;
        const rebuilt = keptAudio ? new MediaStream([keptAudio]) : new MediaStream([]);
        reg.patchActiveCall({callId: liveDirect.callId, gen: liveDirect.gen}, {videoTrack: null, localStream: rebuilt, isVideoOff: true});
        // Tell the peer the camera went off, so they render the avatar
        // placeholder instead of a frozen last frame if we roll back.
        try {
          liveDirect.signalling?.sendMediaState(
            liveDirect.callId, liveDirect.peer, true,
            liveDirect.audioTrack ? !liveDirect.audioTrack.enabled : false,
          );
        } catch { /* best-effort advisory */ }
        console.warn('[CALLDIAG] [add-call] released 1:1 camera before group boot (B-301 handoff)');
      }
    } catch { /* registry unavailable — group boot's own B-343 path still applies */ }
    console.log('[add-call] navigating → GroupCallScreen recipients=', recipientUserIds, 'caller=', callerLabel);
    navigation.replace('GroupCallScreen', {
      conversationId:   groupConvoId,
      callType,
      direction:        'outgoing',
      recipientUserIds,
      callerName:       callerLabel,
      // B-302 — hand the live audio route over. `replace` unmounts this screen,
      // so `preferredRouteRef` (set by the manual picker and by the headset
      // auto-snap) dies here; the fresh GroupCallScreen would otherwise start
      // with no preference and let its first device event snap to whatever
      // headset is attached. The founder chose SPEAKER on the 1:1 leg and the
      // group leg put the call into paired earbuds one event later. A route is
      // a user decision — the screen swap is an implementation detail they
      // neither asked for nor can see.
      initialAudioRoute: preferredRouteRef.current ?? undefined,
      // B-301 — the 1:1 that is still LIVE behind this transition. GroupCallScreen
      // ends it once (and only once) the room is joined.
      pendingDirectCallId,
    });
  };

  // Hide the root tab bar while the call is live — immersive feel.
  // MessengerNavigator (native stack) lives directly inside MainNavigator
  // (bottom tab), so the stack's direct parent IS the tab navigator.
  // Fix #44: useFocusEffect instead of useEffect. With plain useEffect,
  // the parent tab navigator may not be reachable on the very first
  // mount (the screen is still being attached to the stack), so the
  // initial setOptions is a no-op against `undefined`. useFocusEffect
  // fires after the screen is actually focused, which is when the
  // parent chain is reliably resolvable.
  useFocusEffect(
    useCallback(() => {
      const tabNav = navigation.getParent();
      tabNav?.setOptions({tabBarStyle: {display: 'none'}});
      return () => tabNav?.setOptions({tabBarStyle: undefined});
    }, [navigation]),
  );

  // (Removed dead expo-av Audio.setAudioModeAsync effect — it was
  // listed under [isSpeaker] but its body never read isSpeaker, so it
  // was a no-op that fired on every speaker toggle. Worse, expo-av
  // and react-native-incall-manager fight for AudioManager mode on
  // Android, so calling Audio.setAudioModeAsync mid-call could
  // silently undo the route InCallManager.chooseAudioRoute just set.
  // Speaker routing now flows entirely through pickAudioRouteNative
  // in the [isSpeaker] effect above.)

  // Haptic feedback on any control toggle — every button feels physical.
  // B-305 — every control's onPress already funnels through here, so this is the
  // one place that sees every interaction and can restart the chrome countdown.
  const tap = (fn: () => void) => () => { Vibration.vibrate(12); setChromeActivityTick(t => t + 1); fn(); };

  // Pulse rings for voice call
  const ring1 = useRef(new Animated.Value(0)).current;
  const ring2 = useRef(new Animated.Value(0)).current;
  // Waveform bars
  const bars = useRef(Array.from({length: 11}, () => new Animated.Value(0.2))).current;

  useEffect(() => {
    if (callState !== 'connected') {return;}
    if (isOnHold) {return;} // Pause the clock while held — matches expectation.
    // Anchor the timer to callRegistry.connectedAtMs so the displayed
    // duration survives CallScreen unmount/remount across minimize.
    // The previous code stored callDuration purely in local state, so
    // minimizing (which unmounts CallScreen) lost the count and the
    // restore showed 0:00. Re-derive on every tick from the registry's
    // wall-clock anchor (set in useCall.onState when state hits
    // 'connected') so the timer just keeps counting.

    const reg = require('@/modules/messenger/runtime/callRegistry') as typeof import('@/modules/messenger/runtime/callRegistry');
    // Fix #7: once the registry's wall-clock anchor lands we must
    // ALWAYS prefer it over the local-fallback counter — drift between
    // the two paths produced jumpy values when the anchor flipped from
    // null → set mid-call (e.g. ICE took 2.5 s, the local fallback had
    // already advanced to 3, then the anchor landed and we needed to
    // snap to ~2 to match the peer). `anchored` latches true the first
    // time we read a startMs so subsequent null reads (registry briefly
    // cleared during a transition) don't fall back to the local
    // counter and double-tick.
    let anchored = false;
    const tick = (): void => {
      const startMs = reg.getActiveCall()?.connectedAtMs;
      if (startMs) {
        anchored = true;
        setCallDuration(Math.max(0, Math.round((Date.now() - startMs) / 1000)));
      } else if (!anchored) {
        // Local fallback — only used in the brief window before useCall
        // stamps connectedAtMs. Once anchored we never come back here.
        setCallDuration(d => d + 1);
      }
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [callState, isOnHold]);

  useEffect(() => {
    // Pulse rings always loop (decorative, independent of mic state).
    const loops: Animated.CompositeAnimation[] = [];
    const createPulse = (anim: Animated.Value, delay: number) => {
      // Fix #10: explicitly reset to 0 at the start of each loop
      // iteration. Without the reset Animated.loop replays the
      // sequence in place, but the underlying value never returns to 0
      // — it stays at 1 (the toValue from the previous iteration), so
      // the second iteration's `timing(...toValue:1)` is a no-op and
      // the ring stops pulsing after one cycle. duration:0 snap is the
      // canonical fix (see VoiceCallScreen.tsx:36-48 for the same
      // pattern).
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(anim, {toValue:0, duration:0, useNativeDriver:true}),
          Animated.delay(delay),
          Animated.timing(anim, {toValue:1, duration:2400, easing:Easing.out(Easing.ease), useNativeDriver:true}),
        ]),
      );
      loops.push(loop);
      loop.start();
    };
    createPulse(ring1, 0);
    createPulse(ring2, 900);

    // Idle waveform — quiet baseline motion so bars aren't flat before we get
    // the first mic reading. Real mic levels will override once recording starts.
    bars.forEach((bar, i) => {
      const delay = [0, 100, 200, 300, 150, 50, 200, 300, 200, 100, 0][i] || 0;
      const loop = Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(bar, {toValue:0.35, duration:550, easing:Easing.inOut(Easing.ease), useNativeDriver:true}),
          Animated.timing(bar, {toValue:0.2,  duration:550, easing:Easing.inOut(Easing.ease), useNativeDriver:true}),
        ]),
      );
      loops.push(loop);
      loop.start();
    });

    return () => {
      loops.forEach(l => l.stop());
    };
  }, [ring1, ring2, bars]);

  // ── Live mic level → waveform bars (voice call only) ──────────────────
  // BS-CALL-DUPMIC — this used to open a SECOND microphone.
  //
  // The removed implementation ran `expo-av Audio.Recording` (LOW_QUALITY +
  // metering) for the whole connected leg of every VOICE call and polled
  // `getStatusAsync().metering` at 10 Hz, purely to animate these 11 bars. Its
  // own comment said so ("opening a SECOND Audio.Recording on top of the WebRTC
  // mic capture") — it was throttled for BATTERY and never recognised as an
  // audio-correctness fault. It is one:
  //
  //   • Android — a second AudioRecord client with a DIFFERENT audio source
  //     (the preset's default, not VOICE_COMMUNICATION) forces audio policy to
  //     re-pick the input path. The HAL binds its AEC/NS preprocessing per
  //     input stream (`/vendor/etc/audio_effects.xml`, `<preprocess><stream
  //     type="voice_communication">`), so the reshuffle can drop echo
  //     cancellation off the call's capture — the far end then hears itself.
  //     It also re-tunes mic gain mid-call ("voice too quiet", "unstable
  //     volume").
  //   • iOS — `setAudioModeAsync({allowsRecordingIOS: true})` rewrites the
  //     AVAudioSession category underneath CallKit/RTCAudioSession, and expo-av
  //     never restores it; sqa.md already records the aftermath ("AVAudioSession
  //     stays in playAndRecord — subsequent playback routes quiet/earpiece until
  //     restart"). Starting a recorder on a live VoiceProcessingIO session also
  //     tears down the voice-processing (AEC) unit.
  //   • It re-ran on EVERY mute toggle and every background→foreground trip
  //     (both are in the dep list), so it churned the input on exactly the
  //     transitions the user notices.
  //
  // The engine already measures this level for us. `liveCall.stats.micLevel`
  // comes off the 1 Hz `getStats()` poll that useCall was already running
  // (`media-source`/`outbound-rtp` audioLevel), so the waveform keeps its 10 Hz
  // motion with ZERO extra capture and zero extra native calls — the tick below
  // is pure JS reading a ref.
  //
  // Do NOT reintroduce a recorder here. If the bars need to be livelier, raise
  // the resolution of the existing stats sample; never open a second mic on a
  // live call.
  const [appIsActiveForMicPoll, setAppIsActiveForMicPoll] = useState(
    () => AppState.currentState === 'active',
  );
  useEffect(() => {
    const sub = AppState.addEventListener('change', s => {
      setAppIsActiveForMicPoll(s === 'active');
    });
    return () => sub.remove();
  }, []);
  const micLevelRef = useRef<number | null>(null);
  useEffect(() => {
    micLevelRef.current = liveCall.stats.micLevel;
  }, [liveCall.stats.micLevel]);
  useEffect(() => {
    if (isVideo) {return;}
    if (callState !== 'connected') {return;}
    if (isMuted) {return;}
    if (!appIsActiveForMicPoll) {return;}

    const pollTimer = setInterval(() => {
      // Keep the OLD curve. expo-av's `metering` was dBFS and was mapped with
      // (db + 60) / 60; `audioLevel` is LINEAR amplitude (RFC 6464), where
      // ordinary speech sits around 0.03. Feeding that in raw — or via a
      // sqrt — pins the bars near their floor and reads as "the waveform is
      // dead", so convert back to dB first and reuse the same window.
      const lvl = micLevelRef.current;
      if (lvl === null) {return;}   // no sample yet — the idle loop owns the bars
      const db   = lvl > 0 ? 20 * Math.log10(lvl) : -60;
      const norm = Math.max(0, Math.min(1, (db + 60) / 60));
      bars.forEach(bar => {
        // Randomise per-bar so all 11 don't move in lockstep.
        const jitter = 0.7 + Math.random() * 0.6;
        bar.setValue(Math.max(0.15, Math.min(1, norm * jitter)));
      });
    }, 100);

    return () => { clearInterval(pollTimer); };
  }, [isVideo, callState, isMuted, bars, appIsActiveForMicPoll]);

  // Chrome auto-hide for video calls. Fires only once the call is
  // CONNECTED — during ringing/connecting the user needs the buttons
  // visible (Decline, Mute, etc.). 3.5s after the last show, fade out.
  // The picker modals reset the timer so the chrome doesn't snap away
  // mid-interaction.
  useEffect(() => {
    // Use isVideoUI (not isVideo) so a successful mid-call upgrade
    // engages the auto-hide chrome behaviour without remount.
    if (!isVideoUI) {return;}
    if (callState !== 'connected') { setChromeVisible(true); return; }
    if (addPickerOpen || routePickerOpen || dialpadOpen) { setChromeVisible(true); return; }
    if (!chromeVisible) {return;}
    const timer = setTimeout(() => {
      setChromeVisible(false);
      console.log('[bravo.callchrome] auto-hide');
    }, 3500);
    return () => clearTimeout(timer);
    // B-305 — `chromeActivityTick` is what makes this an IDLE timer. Every
    // control tap bumps it, this effect re-runs, the cleanup clears the pending
    // timeout and a fresh 3.5s starts. Without it the countdown ran from the
    // reveal regardless of use, and since the tray is a conditional RENDER
    // (not an opacity fade) a press already in flight landed on a view that had
    // just unmounted — which reads as "the button did nothing".
  }, [isVideoUI, callState, chromeVisible, addPickerOpen, routePickerOpen, dialpadOpen, chromeActivityTick]);

  const toggleChrome = useCallback(() => {
    setChromeVisible(v => {
      console.log(`[bravo.callchrome] toggle ${v ? 'visible→hidden' : 'hidden→visible'}`);
      return !v;
    });
  }, []);

  const formatDuration = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = String(s % 60).padStart(2, '0');
    return `${String(m).padStart(2, '0')}:${sec}`;
  };

  const BAR_HEIGHTS = [16, 26, 36, 28, 44, 32, 44, 28, 36, 24, 16];

  // ── B-454 full-screen ↔ PiP stream swap ─────────────────
  // `swapped` names WHICH STREAM owns the full-screen slot: false = the
  // peer (default), true = the local camera. The flag travels with the
  // STREAM — streamURL, mirror, the native remount key and the fallback
  // placeholder all follow it — while zOrder stays with the CONTAINER
  // (see the note above the PiP in the video tree).
  const [swapped, setSwapped] = useState(false);
  // Why: there is only something to swap while the peer's stream is
  // actually in the full-screen slot. Before that the ringing identity
  // overlay (peer avatar + pulse rings) still owns the screen and is NOT
  // part of either slot, so a swap would leave it painted over the local
  // video. This one predicate is the authority for both consumers below:
  // it gates the gesture (so the tap never produces a frame that the
  // effect immediately undoes) and it resets the flag if the peer's
  // stream, the video UI or the call itself goes away mid-swap. A real
  // unmount drops the state with the screen.
  const canSwap = isVideoUI && !tearingDown && callState !== 'ended' && !!liveCall.remoteStream;
  const canSwapRef = useRef(canSwap);
  canSwapRef.current = canSwap;
  useEffect(() => {
    if (!canSwap) {setSwapped(false);}
  }, [canSwap]);

  // ── Draggable PiP ───────────────────────────────────────
  // Animated.ValueXY tracks the user-driven offset from the PiP's
  // resting position (bottom-right). PanResponder owns the gestures;
  // on release we clamp the position into the visible viewport so the
  // tile can never be flung off-screen.
  const PIP_W = 108;
  const PIP_H = 148;
  const win = useWindowDimensions();
  const winRef = useRef(win);
  winRef.current = win;
  const pipPan = useRef(new Animated.ValueXY({x: 0, y: 0})).current;
  // Fix #8: track Animated.Value's value via a listener instead of
  // poking the private `_value` field. The private-field path is
  // guaranteed to read-of-stale on iOS Hermes once Reanimated 3 lands
  // (the field is a getter that calls into a JSI-backed accessor and
  // can be torn down between native and JS frames). The listener is
  // the public, supported way and gives us the same per-frame value.
  const pipPanValueRef = useRef({x: 0, y: 0});
  // Distance threshold (squared, to avoid sqrt) above which we treat
  // a gesture as a real drag instead of a tap. Mirrors the standard
  // 4 dp slop used elsewhere in the app.
  const TAP_SLOP_SQ = 16;
  const pipGrantPosRef = useRef<{x: number; y: number} | null>(null);
  useEffect(() => {
    const idX = pipPan.x.addListener(({value}) => { pipPanValueRef.current.x = value; });
    const idY = pipPan.y.addListener(({value}) => { pipPanValueRef.current.y = value; });
    return () => {
      pipPan.x.removeListener(idX);
      pipPan.y.removeListener(idY);
    };
  }, [pipPan]);
  const settlePipIntoBounds = useCallback(() => {
    // B-366 — resting origin is now the TOP-right rail (matches the style
    // anchor above), and the bottom keep-out covers the REAL control-sheet
    // height (two button rows ≈ 340dp, not 140) so a drag can never park the
    // tile underneath the buttons again.
    const restingLeft = winRef.current.width - PIP_W - 16;
    const restingTop  = 120;
    const snapped = snapPipOffset({
      winW: winRef.current.width, winH: winRef.current.height,
      pipW: PIP_W, pipH: PIP_H,
      restingLeft, restingTop,
      dx: pipPanValueRef.current.x,
      dy: pipPanValueRef.current.y,
      margin: 16, topInset: 120, bottomInset: 340,
    });
    Animated.spring(pipPan, {
      toValue: snapped,
      useNativeDriver: false, friction: 7, tension: 80,
    }).start();

  }, [pipPan]);
  // Why: re-clamp on every mount + window change — a restore or fold/rotation
  // must never leave the tile off its margin rails. No-op at rest (offset 0,0
  // already sits on the bottom-right rail); skipped mid-gesture.
  useEffect(() => {
    if (pipGrantPosRef.current) {return;}
    settlePipIntoBounds();
  }, [settlePipIntoBounds, win.width, win.height]);
  const pipResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        // Why: a grab mid-settle must kill the running spring — it targets an
        // offset baseline the grant below re-bases, so letting it finish
        // shoves the tile off the corner rails by the difference.
        pipPan.stopAnimation();
        const x = pipPanValueRef.current.x;
        const y = pipPanValueRef.current.y;
        pipGrantPosRef.current = {x, y};
        pipPan.setOffset({x, y});
        pipPan.setValue({x: 0, y: 0});
      },
      onPanResponderMove: Animated.event([null, {dx: pipPan.x, dy: pipPan.y}], {useNativeDriver: false}),
      onPanResponderRelease: () => {
        pipPan.flattenOffset();
        // Tap-through detection — if the finger barely moved between
        // grant and release, treat as a tap.
        const start = pipGrantPosRef.current;
        const end = pipPanValueRef.current;
        if (start) {
          const ddx = end.x - start.x;
          const ddy = end.y - start.y;
          if (ddx * ddx + ddy * ddy < TAP_SLOP_SQ) {
            // B-454 — tap the small tile to SWAP it with the full-screen
            // one (tap again to swap back). This used to duplicate the
            // chrome toggle, which the full-screen tap-catcher below
            // already owns over the whole surface — so nothing is lost by
            // giving the one gesture that lands ON the tile the job only
            // that tile can do. Read through the ref: this responder is
            // built once, so a captured value would be the mount-time one
            // forever.
            // …and when there is nothing to swap WITH (one live tile), the tap
            // falls back to the chrome toggle it had before B-454. Without the
            // else the tile became a dead zone in exactly the audio-only /
            // remote-camera-off states where the controls matter most.
            try {
              if (canSwapRef.current) {setSwapped(s => !s);}
              else {setChromeVisible(v => !v);}
            } catch { /* ignore */ }
            pipGrantPosRef.current = null;
            // A sub-slop gesture still MOVED the tile: the offset was flattened
            // above and never re-clamped, so repeated taps walked it a few dp at
            // a time off its corner rail and eventually under the control sheet.
            settlePipIntoBounds();
            return;
          }
        }
        pipGrantPosRef.current = null;
        // Parity plan §6 (G5) — spring to the NEAREST CORNER (WhatsApp
        // behavior) instead of parking mid-screen wherever the finger
        // stopped. The PiP resting position is bottom:140, right:16;
        // snapPipOffset maps the release offset to the closest of the
        // four corner rails, staying clear of the header chrome (top)
        // and the control row (bottom).
        settlePipIntoBounds();
      },
      // Why: a stolen gesture (navigation swipe, modal grab) never fires
      // release — without this the tile strands un-flattened wherever the
      // finger was, off its margin rails. Same class as B-242.
      onPanResponderTerminate: () => {
        pipPan.flattenOffset();
        pipGrantPosRef.current = null;
        settlePipIntoBounds();
      },
    }),
  ).current;

  // ── B-454 tile renderers ────────────────────────────────
  // ONE renderer per STREAM, so the two slots can trade places without
  // any prop being left behind on the wrong side. `slot` decides ONLY
  // geometry and the Android layer order: the full-screen surface stays
  // zOrder 0 and the small tile stays zOrder 1 (rationale in the note
  // above the PiP in the video tree). Everything the stream owns —
  // streamURL, mirror, the native remount key, the fallback placeholder
  // — is derived per stream and follows it across a swap. The remount
  // key carries the slot for the same reason the O-F key carries the
  // track id: a moved stream must rebind its native renderer instead of
  // leaving the old surface bound to the old tile.
  const renderRemoteTile = (slot: 'full' | 'pip') => {
    if (!liveMode || !isVideoUI) {return null;}
    // O-E/O-F — the mount decision lives in resolveRemoteTile
    // (webrtc/remoteTileGate.ts) so this screen and the minimized
    // FloatingCallOverlay render the same audited CALL-N2 gate,
    // and the remount key carries the remote video TRACK id (a
    // replaced track with an unchanged stream id must rebind).
    const gate = resolveRemoteTile({
      remoteVideoOff:  !!liveCall.remoteVideoOff,
      remoteHasVideo:  !!liveCall.remoteHasVideo,
      hasRemoteStream: !!liveCall.remoteStream,
      streamURL:       safeStreamURL(liveCall.remoteStream),
      videoTrackId:    liveCall.remoteStream?.getVideoTracks?.()[0]?.id ?? null,
    });
    if (gate.kind === 'none') {return null;}
    if (gate.kind !== 'video') {
      // The peer has no frame to show. In the small tile the full-screen
      // treatment (96dp avatar + two label rows) does not fit, so the
      // placeholder scales with the slot — same information, same
      // ownership: the PEER's identity wherever the peer's stream is.
      if (slot === 'pip') {
        return (
          <View style={[styles.pipFill, styles.pipAvatarWrap]}>
            <View style={styles.pipAvatar}>
              <Text style={styles.pipAvatarLabel}>{peerInitials}</Text>
            </View>
            {gate.kind === 'camera-off' && (
              <Icon name="video-off" size={16} color="#94A3B8" style={styles.pipAvatarBadge} />
            )}
          </View>
        );
      }
      // B-105 — show WHO is on the other end, not an anonymous account
      // glyph: the peer's initials disc. 'camera-off' is an explicit peer
      // advisory and says so; 'avatar' is "connected on audio, no video
      // track" and stays silent about the reason.
      return (
        <View style={[StyleSheet.absoluteFill, styles.remoteCameraOff]}>
          <UserAvatar
            userId={remoteUserId}
            size={96}
            fallback={
              <View style={styles.remoteCameraOffAvatar}>
                <Text style={styles.videoAvatarText}>{peerInitials}</Text>
              </View>
            }
          />
          {gate.kind === 'camera-off' && (
            <Text style={styles.remoteCameraOffLabel}>Camera off</Text>
          )}
          <Text style={styles.remoteCameraOffSubtle} numberOfLines={1}>
            {peerName}
          </Text>
        </View>
      );
    }
    return (
      <RTCView
        // B-16 (both halves) — remount when video ARRIVES and when
        // the remote video track is REPLACED (same stream id →
        // unchanged streamURL; only a key change rebinds the
        // native renderer). B-454 adds the slot for the same reason.
        key={`remote-${slot}-${gate.remountKey}`}
        streamURL={gate.streamURL}
        style={StyleSheet.absoluteFill}
        objectFit="cover"
        mirror={shouldMirrorTile(false, cameraFacing === 'front')}
        zOrder={slot === 'full' ? 0 : 1}
      />
    );
  };

  const renderLocalTile = (slot: 'full' | 'pip') => {
    // Compute the URL ONCE so the conditional and the prop see
    // the same value. The previous code called safeStreamURL
    // twice — once to gate the branch, once to feed RTCView —
    // and on a stream identity churn the two calls could return
    // different values (e.g. the gate saw a live URL but the
    // prop saw '' on the next microtask), causing the tile to
    // mount RTCView with an empty streamURL.
    // B-360 — the self-view previews via RTCView on the WebRTC local
    // stream ONLY (pre-live too: the outgoing ring already holds it). The
    // old `!liveMode` branch mounted a SECOND camera client (androidx
    // CameraX) in the same process. At accept, react-native-webrtc's
    // capturer takes the same front camera and CameraX enters an
    // ERROR_CAMERA_IN_USE reopen loop that steals the device back
    // mid-call — black self-video on MIUI (Redmi, 2026-08-01 logs) and
    // camera churn behind every escalation. A call surface must never run
    // a second camera stack; with no local stream the initials disc below
    // renders instead.
    const localUrl = isCameraOn ? safeStreamURL(liveCall.localStream) : null;
    if (localUrl) {
      return (
        // QA Fix #10: key by isCameraOn so RTCView unmounts + remounts
        // cleanly when the camera toggles. Without this key, on some
        // Android stacks (Pixel/MIUI/OneUI) the native SurfaceView holds
        // onto the last decoded frame even after track.enabled flips to
        // false — the prop change alone doesn't tear down the underlying
        // SurfaceTexture, so the user sees their own video "stuck" until
        // the call ends. Forcing a remount on off→on AND on→off
        // transitions guarantees a fresh SurfaceView.
        <RTCView
          key={`local-${slot}-${isCameraOn ? 'on' : 'off'}`}
          streamURL={localUrl}
          style={StyleSheet.absoluteFill}
          objectFit="cover"
          mirror={shouldMirrorTile(true, cameraFacing === 'front')}
          zOrder={slot === 'full' ? 0 : 1}
        />
      );
    }
    // B-105 — camera off / no perm: this is the SELF-view, so the
    // fallback disc must carry the LOCAL user's initials (it used to show
    // the PEER's — on the device with the camera off, a disc with the
    // OTHER party's initial appeared, the founder's "shows my friend's
    // screen with MY initial" report seen from the other side). The
    // video-off badge still marks the state.
    if (slot === 'pip') {
      return (
        <View style={[styles.pipFill, styles.pipAvatarWrap]}>
          <View style={styles.pipAvatar}>
            <Text style={styles.pipAvatarLabel}>{ownInitials}</Text>
          </View>
          {!isCameraOn && (
            <Icon
              name="video-off"
              size={16}
              color="#94A3B8"
              style={styles.pipAvatarBadge}
            />
          )}
        </View>
      );
    }
    return (
      <View style={[StyleSheet.absoluteFill, styles.remoteCameraOff]}>
        <View style={styles.remoteCameraOffAvatar}>
          <Text style={styles.videoAvatarText}>{ownInitials}</Text>
        </View>
        {!isCameraOn && (
          <Text style={styles.remoteCameraOffLabel}>Camera off</Text>
        )}
        <Text style={styles.remoteCameraOffSubtle} numberOfLines={1}>You</Text>
      </View>
    );
  };

  // Fix #43: lift the Add-picker Modal out of both return-trees into a
  // single shared expression. Previously it was duplicated byte-for-byte
  // inside the video and voice JSX subtrees because each branch is a
  // separate `return (...)` — meaning a Modal placed in one didn't exist
  // in the other and `setAddPickerOpen(true)` had nothing to listen for
  // it. The cost of keeping two copies in sync is now fixed: any future
  // change to the picker UI lives in exactly one place.
  const addPickerModal = (
    <Modal
      visible={addPickerOpen}
      transparent
      animationType="slide"
      onRequestClose={() => setAddPickerOpen(false)}>
      <Pressable style={styles.dialpadBackdrop} onPress={() => setAddPickerOpen(false)}>
        {/* Bottom sheets owe their own bottom inset — with a fixed pad the
            last row sits under the gesture pill / home indicator. */}
        <Pressable style={[styles.addPickerSheet, {paddingBottom: 28 + insets.bottom}]}>
          <Text style={styles.addPickerTitle}>Add to call</Text>
          <Text style={styles.addPickerHint}>
            Pick someone to invite. Your current 1:1 will end and a fresh
            group call rings everyone (including {peerName || 'your peer'}).
          </Text>
          {addPickerCandidates.length === 0 ? (
            <Text style={styles.addPickerEmpty}>
              No other contacts to add. Start a chat with someone first.
            </Text>
          ) : (
            // B-308 — a FlatList, not a mapped View. The mapped View had no
            // scroll container at all, so with more direct conversations than
            // fit the sheet the rows past the fold were unreachable ("the
            // list is not slidable"). Height-bounded like GroupCallScreen's
            // invite sheet so the sheet itself never outgrows the screen.
            <FlatList
              data={addPickerCandidates}
              keyExtractor={c => c.userId}
              style={{maxHeight: 320}}
              contentContainerStyle={styles.addPickerList}
              renderItem={({item: c}) => (
                <TouchableOpacity
                  style={styles.addPickerRow}
                  activeOpacity={0.75}
                  onPress={() => {
                    // B-106 — escalation converts to a group call, and Add
                    // sits one slot from the Camera toggle; an unconfirmed
                    // tap was easy to hit by accident.
                    Alert.alert(
                      'Start a group call?',
                      `This adds ${c.displayName} and converts your call with ${peerName} into a group call.`,
                      [
                        {text: 'Cancel', style: 'cancel'},
                        {text: 'Start group call', onPress: () => { void escalateToGroupCall(c); }},
                      ],
                    );
                  }}>
                  <View style={styles.addPickerAvatar}>
                    <Text style={styles.addPickerAvatarTxt}>
                      {c.displayName.slice(0, 2).toUpperCase()}
                    </Text>
                  </View>
                  <View style={{flex: 1, minWidth: 0}}>
                    <Text style={styles.addPickerName} numberOfLines={1}>{c.displayName}</Text>
                    <Text style={styles.addPickerSub} numberOfLines={1}>{c.userId.slice(0, 12)}</Text>
                  </View>
                  <Icon name="phone-plus" size={18} color="#5B8DEF" />
                </TouchableOpacity>
              )}
            />
          )}
          <TouchableOpacity
            style={styles.addPickerCancel}
            onPress={() => setAddPickerOpen(false)}
            activeOpacity={0.75}>
            <Text style={styles.addPickerCancelTxt}>Cancel</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );

  if (isVideoUI) {
    return (
      <View style={styles.videoRoot}>
        <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />
        {/* Background gradient simulation */}
        <View style={styles.videoBg} />
        {/* Top + bottom gradient overlays — these are dark scrims that
            sit ABOVE the remote video to make the chrome (top bar +
            bottom controls) legible. When the user taps to hide the
            chrome, the scrims must hide WITH it; otherwise they keep
            darkening the remote's face for no reason and the user
            sees a permanent vignette over the call. Tied to the same
            chromeVisible flag so the fade is in lockstep with the
            controls — no separate animation needed. */}
        {chromeVisible && (
          <>
            <View style={styles.videoTopGrad} pointerEvents="none" />
            <View style={styles.videoBottomGrad} pointerEvents="none" />
          </>
        )}

        {audioInterrupted && (
          <View style={[styles.audioInterruptBanner, {top: insets.top + 8}]} pointerEvents="none">
            <Icon name="phone-paused" size={14} color="#FCD34D" />
            <Text style={styles.audioInterruptTxt} numberOfLines={1}>
              Paused — another call is using your audio
            </Text>
          </View>
        )}

        {chromeVisible && (
        /* Top bar */
        <View style={[styles.videoTopBar, {paddingTop: insets.top + 8}]}>
          {/* B-680/FS-05: the name column shrinks — the DTLS/signal cluster on the
              right must never be pushed off-screen by a long peer name. */}
          <View style={{flex: 1, minWidth: 0, marginRight: 8}}>
            <View style={{flexDirection: 'row', alignItems: 'center'}}>
              <Text style={styles.videoName} numberOfLines={1}>{peerName}</Text>
              {/* Audit CALL-N14 — surface the peer's muted state (remoteMuted
                  was plumbed but never rendered). */}
              {liveCall.remoteMuted && callState === 'connected' && (
                <Icon name="microphone-off" size={16} color="#F87171" style={{marginLeft: 8}} />
              )}
            </View>
            <View style={styles.connectedRow}>
              <View style={[styles.connectedDot, callState !== 'connected' && {backgroundColor: '#fbbf24'}]} />
              <Text style={styles.connectedText}>
                {
              deadOffer
                ? 'Couldn’t connect · missed call'
                : isRinging
                  ? `Incoming ${callType === 'video' ? 'video ' : ''}call…`
                  : callState === 'connecting'
                    ? (isIncoming ? 'Answering…' : 'Calling…')
                    : callState === 'ended'
                      ? 'Ended'
                      : `Connected · ${formatDuration(callDuration)}`
            }
              </Text>
            </View>
          </View>
          <View style={styles.videoTopRight}>
            {/* Signal bars */}
            <View style={styles.signalBars}>
              {[6, 9, 12, 15].map((h, i) => (
                <View key={i} style={[styles.sigBar, {height: h}]} />
              ))}
              <View style={[styles.sigBar, {height: 18, opacity: 0.2}]} />
            </View>
            {/* AES badge — now reports live DTLS-SRTP cipher when secure */}
            <View style={styles.aesBadge}>
              <Icon name="lock" size={11} color="#4ade80" />
              <Text style={styles.aesText}>
                {liveCall.dtls?.srtpCipher
                  ? `${liveCall.dtls.srtpCipher.replace(/_/g, ' ')}`
                  : 'DTLS-SRTP'}
              </Text>
            </View>
            {/* Live call quality strip — RTT / jitter / packet-loss */}
            {callState === 'connected' && (
              <View style={styles.qualityStrip}>
                <Text style={[styles.qualityKey, {color: liveCall.stats.rttMs === null ? '#7E8AA6' : liveCall.stats.rttMs < 100 ? '#00C853' : liveCall.stats.rttMs < 250 ? '#FFC107' : '#FF3B3B'}]}>
                  {liveCall.stats.rttMs !== null ? `${liveCall.stats.rttMs}ms` : '—'}
                </Text>
                <Text style={styles.qualityLbl}>RTT</Text>
                {liveCall.stats.packetLossPct !== null && (
                  <>
                    <Text style={[styles.qualityKey, {color: liveCall.stats.packetLossPct < 2 ? '#00C853' : liveCall.stats.packetLossPct < 5 ? '#FFC107' : '#FF3B3B'}]}>
                      {liveCall.stats.packetLossPct}%
                    </Text>
                    <Text style={styles.qualityLbl}>LOSS</Text>
                  </>
                )}
              </View>
            )}
          </View>
        </View>
        )}

        {/* Remote avatar (center) — only shown while we don't yet have
            a remote video track. The moment the peer's stream lands we
            drop this overlay so the call goes full-screen video. */}
        {!liveCall.remoteStream && (
          <View style={styles.videoAvatarWrap} pointerEvents="none">
            {/* Pulse rings while ringing/calling/connecting — stop once
                the peer's media lands (this whole overlay unmounts then). */}
            {callState !== 'connected' && <PulseRings size={300} />}
            {/* B-254 — the peer's photo when they have one. */}
            <UserAvatar
              userId={remoteUserId}
              size={168}
              fallback={
                <View style={styles.videoAvatar}>
                  <View style={styles.videoAvatarInner} />
                  <Text style={styles.videoAvatarText}>{peerInitials}</Text>
                </View>
              }
            />
          </View>
        )}

        {/* BS-CALL3 — removed the call-variant offline warning (video flow).
            See the voice-flow note above: no red "may be offline" bar during
            an unanswered call; ringing stays calm and ends cleanly. */}

        {/* Full-screen slot — the PEER's stream by default, the LOCAL
            camera once the user taps the small tile to swap (B-454).
            zOrder=0 keeps whichever stream lands here on the underlying
            surface so the small tile (zOrder=1) can layer on top on
            Android; the layer order belongs to the SLOT, not the stream.
            BS-021: when the peer flips their camera off, the RN-WebRTC
            SurfaceView keeps painting the LAST decoded frame because
            RTP just stops — there's no tear-down signal at the native
            layer. We mirror the peer's `cameraOff` state via the
            `call.media-state` advisory and swap in a placeholder so
            the receiver can tell intentional disable from a frozen
            connection. The remote stream stays attached (audio keeps
            flowing); only the video tile renders the placeholder.
            Audit CALL-N2 (2026-07-02) still governs the peer branch: it
            only mounts an RTCView when the remote actually HAS a live
            video track and hasn't toggled it off, because an audio-only
            remote stream still yields a valid streamURL and used to
            mount a full-screen BLACK SurfaceView. That decision lives in
            resolveRemoteTile and is reached through renderRemoteTile in
            BOTH slots — a swap never bypasses the gate. */}
        {/* CALLS-1to1 (#2) — during teardown freeze the heavy RTCView
            subtree to a stable, constant-keyed placeholder so the native
            tree can't crash ("child already has a parent") collapsing in
            the same commit as the screen pop. The freeze is keyed on the
            SLOT, so a swap mid-teardown cannot re-key it. */}
        {tearingDown
          ? <View key="remote-teardown" style={StyleSheet.absoluteFill} />
          : swapped ? renderLocalTile('full') : renderRemoteTile('full')}

        {/* Tap-catcher — toggles chrome visibility. Sits above the
            remote video but below PiP and the chrome rows; only active
            once the call is connected so users can't accidentally hide
            the Decline button while ringing. */}
        {callState === 'connected' && (
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={toggleChrome}
          />
        )}

        {/* Small tile — the LOCAL camera preview by default, the PEER's
            stream once swapped (B-454). Draggable; a tap on it swaps the
            two slots. zOrder=1 forces whichever SurfaceView lands here to
            render ABOVE the full-screen one on Android; without it the
            tile was painted under the full-screen video and looked empty
            even when its stream was live. The layer order belongs to the
            SLOT, so it does not move with the swap. */}
        <Animated.View
          accessible
          accessibilityRole="button"
          accessibilityLabel={swapped ? 'Peer video, small' : 'Your video, small'}
          accessibilityHint={canSwap ? 'Swaps this video with the full-screen one' : 'Shows or hides the call controls'}
          // The announced button role was a lie: the tap lives in a
          // PanResponder, which TalkBack / VoiceOver never drive, so an
          // activation gesture reached nothing. This is the same decision as
          // the release branch above, expressed for assistive tech.
          onAccessibilityTap={() => {
            if (canSwapRef.current) {setSwapped(s => !s);}
            else {setChromeVisible(v => !v);}
          }}
          style={[
            styles.pip,
            // B-366 — rest TOP-right (WhatsApp parity). The old bottom-right
            // anchor (bottom: 140) sat UNDER the two-row control sheet, which
            // is ~2.5x taller than that clearance — the founder's self-view
            // was buried behind the buttons (screenshot 2026-08-01 14:27).
            {top: 120, right: 16, transform: pipPan.getTranslateTransform()},
          ]}
          {...pipResponder.panHandlers}>
          {/* B-455 — the video plane must live in its OWN rounded, clipping
              box that fills the border's content box EXACTLY. The previous
              shape stretched the plane to -2 on every side (out to the
              border box) to kill a padding band and leaned on the parent's
              `overflow:hidden` to clip it — which works for ordinary views
              and NOT for an RTCView: on Android that is a SurfaceViewRenderer
              (WebRTCView.java:145/160) composited in its own layer, so the
              parent's rounded-corner canvas clip never applies and the video
              poked square corners 2dp past the frame. The inner container
              now owns the content box precisely, so the band never appears
              and the plane cannot reach past the border.
              RESIDUAL, Android only: the vendored renderer exposes no
              TextureView / clip / corner option at all (RTCVideoViewManager
              props are mirror, objectFit, streamURL, zOrder,
              onDimensionsChange; setZOrder only toggles
              setZOrderMediaOverlay / setZOrderOnTop, WebRTCView.java:521-533),
              so the surface stays an unrounded rectangle INSIDE the frame —
              its corners still fill the small area between the rounded inner
              edge and the square content box. That is a nick inside the
              border, not the overflow the founder reported, and closing it
              would need a native TextureView renderer. */}
          <View style={styles.pipClip}>
            {/* CALLS-1to1 (#2) — freeze the tile to a stable, constant-keyed
                placeholder during teardown (same crash-avoidance as the
                full-screen slot). Keyed on the SLOT so a swap mid-teardown
                cannot re-key it. */}
            {tearingDown
              ? <View key="local-teardown" style={styles.pipFill} />
              : swapped ? renderRemoteTile('pip') : renderLocalTile('pip')}
            {/* The swap is otherwise invisible: a small glyph is the only
                thing telling the user this tile is tappable. It appears
                only while the tap actually does something, so it never
                advertises a dead gesture. */}
            {canSwap && (
              <Icon
                name="swap-horizontal"
                size={14}
                color="rgba(255,255,255,0.85)"
                style={styles.pipSwapHint}
              />
            )}
          </View>
        </Animated.View>

        {/* Controls. During incoming-video ringing we replace the
            in-call control row with a clean Answer / Decline pair —
            same UX as the voice incoming flow. The user couldn't tell
            from the previous layout that they had to tap the small red
            End button to decline because there was no Answer button at
            all; only an "End" implied "you're already in a call". */}
        {isRinging ? (
          <View style={[styles.videoControls, {paddingBottom: insets.bottom + 28}]}>
            <View style={styles.ringActions}>
              <View style={styles.ringSlot}>
                <TouchableOpacity
                  style={[styles.ringBtn, styles.ringDecline]}
                  activeOpacity={0.85}
                  onPress={declineCall}>
                  <Icon name="phone-hangup" size={30} color="#FFF" />
                </TouchableOpacity>
                <Text style={styles.ringBtnLabel}>Decline</Text>
              </View>
              <View style={styles.ringSlot}>
                <TouchableOpacity
                  style={[styles.ringBtn, styles.ringAccept]}
                  activeOpacity={0.85}
                  onPress={() => { Vibration.cancel(); logCallLat('1to1-in', callId, 'tap:accept'); setUserAccepted(true); }}>
                  <Icon name="video" size={30} color="#FFF" />
                </TouchableOpacity>
                <Text style={styles.ringBtnLabel}>Accept</Text>
              </View>
            </View>
          </View>
        ) : chromeVisible ? (
          <View style={[styles.videoControls, {paddingBottom: insets.bottom + 24}]}>
            {/* CN-09 — debounced poor-connection pill above the control tray. */}
            <CallQualityBanner visible={qualityBannerVisible} />
            <View style={styles.ctrlTray}>
              {/* Tier 1 — call toggles (Mute / Video / BT-Speaker / Blur).
                  Two-tier glass tray per the Bravo Video Call design. Each
                  button keeps its exact existing wiring; only the layout +
                  styling changed. */}
              <View style={styles.ctrlTierRow}>
                {[
                  {icon:isMuted ? 'microphone-off' : 'microphone', label:'Mute',  active:isMuted, onPress:tap(() => setIsMuted(m => !m))},
                  {icon:isCameraOn ? 'video' : 'video-off',        label:isCameraOn ? 'Video' : 'Video off', active:!isCameraOn, isOff:!isCameraOn, onPress:tap(() => setIsCameraOn(c => !c))},
                  // Audio-route button — tap toggles speaker/earpiece; if a
                  // BT/wired headset is available, tap (or long-press) opens
                  // the picker. Identical logic to before; just relocated.
                  {
                    icon: audioRoute === 'BLUETOOTH'    ? 'bluetooth-audio'
                        : audioRoute === 'WIRED_HEADSET' ? 'headphones'
                        : audioRoute === 'SPEAKER_PHONE' ? 'volume-high'
                        : isSpeaker ? 'volume-high' : 'volume-medium',
                    label: audioRoute === 'BLUETOOTH' ? 'BT'
                         : audioRoute === 'WIRED_HEADSET' ? 'Wired'
                         : 'Speaker',
                    active: audioRoute === 'BLUETOOTH' || audioRoute === 'WIRED_HEADSET' || isSpeaker,
                    onPress: tap(() => {
                      const hasExternalRoute = audioRoutes.some(r => r === 'BLUETOOTH' || r === 'WIRED_HEADSET');
                      if (hasExternalRoute) {setRoutePickerOpen(true);}
                      else {setIsSpeaker(s => !s);}
                    }),
                    onLongPress: () => setRoutePickerOpen(true),
                  },
                  // B-283 — the Blur toggle is gone. It only ever blurred the
                  // LOCAL self-view PiP, which is the one frame the user does not
                  // need obscured (the peer never saw any difference), and it cost
                  // a native BlurView over live video. Removing it also drops the
                  // last use of @react-native-community/blur from this screen.
                ].map(btn => (
                  <View key={btn.label} style={styles.ctrlBtnWrap}>
                    <TouchableOpacity
                      style={[
                        styles.ctrlToggle,
                        btn.active && styles.ctrlToggleActive,
                        btn.isOff && styles.ctrlCircleOff,
                      ]}
                      onPress={btn.onPress}
                      onLongPress={(btn as {onLongPress?: () => void}).onLongPress}
                      activeOpacity={0.8}>
                      <Icon
                        name={btn.icon}
                        size={21}
                        color={btn.isOff ? '#F87171' : btn.active ? '#0E1424' : '#FFF'}
                      />
                    </TouchableOpacity>
                    <Text style={[styles.ctrlLabel, btn.active && {color:'#FFF'}, btn.isOff && {color:'#F87171'}]}>{btn.label}</Text>
                  </View>
                ))}
              </View>

              {/* divider */}
              <View style={styles.ctrlTrayDivider} />

              {/* Tier 2 — Flip + dominant End Call pill + Add */}
              <View style={styles.ctrlTier2}>
                <View style={styles.ctrlBtnWrap}>
                  <TouchableOpacity
                    style={styles.ctrlUtil}
                    onPress={tap(() => setCameraFacing(f => f === 'front' ? 'back' : 'front'))}
                    activeOpacity={0.8}>
                    <Icon name="camera-flip" size={20} color="#B8C2D9" />
                  </TouchableOpacity>
                  <Text style={styles.ctrlLabel}>Flip</Text>
                </View>

                <TouchableOpacity style={styles.endPill} onPress={endCall} activeOpacity={0.85}>
                  <Icon name="phone-hangup" size={20} color="#FFF" />
                  <Text style={styles.endPillText}>End Call</Text>
                </TouchableOpacity>

                <View style={styles.ctrlBtnWrap}>
                  <TouchableOpacity
                    style={styles.ctrlUtil}
                    onPress={tap(() => { console.log('[add-call] tap Add — opening picker, callType=', callType); setAddPickerOpen(true); })}
                    activeOpacity={0.8}>
                    <Icon name="account-plus" size={20} color="#B8C2D9" />
                  </TouchableOpacity>
                  <Text style={styles.ctrlLabel}>Add</Text>
                </View>
              </View>
            </View>
          </View>
        ) : null}

        {/* Fix #43: shared Add-picker — see definition above the
            isVideo branch (single source of truth). */}
        {addPickerModal}
      </View>
    );
  }

  // Voice call
  return (
    <View style={styles.voiceRoot}>
      <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />

      {/* Top row */}
      <View style={[styles.voiceTopRow, {paddingTop: insets.top + 8}]}>
        <TouchableOpacity style={styles.minimiseBtn} onPress={tap(minimise)} activeOpacity={0.7}>
          <Icon name="chevron-down" size={14} color="#B8C7E0" />
          <Text style={styles.minimiseText}>Minimise</Text>
        </TouchableOpacity>
        <View style={styles.encBadgeVoice}>
          <Icon name="video-off" size={12} color="#F87171" />
          <View>
            <Text style={styles.encBadgeLine}>AES-256</Text>
            <Text style={styles.encBadgeLine}>Encrypted</Text>
          </View>
        </View>
      </View>

      {/* BS-CALL3 — removed the call-variant "may be offline" warning
          banner. It read as an error/alarm mid-dial (red wifi-off strip).
          WhatsApp shows a calm "Ringing…" and, on no answer, ends quietly
          (the ring-timeout already does end('ended') + a missed-call row).
          No scary bar during an unanswered call. */}

      {/* Avatar with pulse rings */}
      <View style={styles.voiceAvatarSection}>
        <View style={styles.pulseWrap}>
          {[ring1, ring2].map((anim, i) => (
            <Animated.View key={i} style={[
              styles.pulseRing,
              {
                opacity: anim.interpolate({inputRange:[0,0.5,1], outputRange:[0.5,0.35,0]}),
                transform: [{scale: anim.interpolate({inputRange:[0,1], outputRange:[0.9,1.7]})}],
              },
            ]} />
          ))}
          <UserAvatar
            userId={remoteUserId}
            size={132}
            fallback={
              <View style={styles.voiceAvatar}>
                <View style={styles.voiceAvatarInner} />
                <Text style={styles.voiceAvatarText}>{peerInitials}</Text>
              </View>
            }
          />
        </View>

        <Text style={styles.voiceName}>{peerName}</Text>

        <View style={styles.connectedRow}>
          <View style={[
            styles.connectedDot,
            callState === 'connected'
              ? {shadowColor:'#22c55e', shadowOpacity:1, shadowRadius:6, elevation:2}
              : {backgroundColor: '#fbbf24'},
          ]} />
          <Text style={styles.connectedText}>
            {
              deadOffer
                ? 'Couldn’t connect · missed call'
                : isRinging
                  ? `Incoming ${callType === 'video' ? 'video ' : ''}call…`
                  : callState === 'connecting'
                    ? (isIncoming ? 'Answering…' : 'Calling…')
                    : callState === 'ended'
                      ? 'Ended'
                      : `Connected · ${formatDuration(callDuration)}`
            }
          </Text>
        </View>
        <Text style={styles.callSubtitle}>Encrypted Voice Call · WebRTC</Text>
      </View>

      {/* Waveform — contained band, centred between the avatar block and
          the control tray by the flex spacers on either side. */}
      <View style={styles.waveSpacer} pointerEvents="none" />
      <View style={styles.waveformWrap}>
        {bars.map((bar, i) => (
          <Animated.View key={i} style={[
            styles.waveBar,
            {height: BAR_HEIGHTS[i], transform: [{scaleY: bar}]},
          ]} />
        ))}
      </View>
      <View style={styles.waveSpacer} pointerEvents="none" />

      {/* Controls. During incoming-ringing we hide mute/speaker/hold/keypad —
          they confuse users into thinking the call is already live. The
          ringing UI is a pure Answer / Decline affordance like the OS dialer. */}
      <View style={[styles.voiceControls, {paddingBottom: insets.bottom + 16}]}>
        {/* CN-09 — debounced poor-connection pill above the voice tray. */}
        <CallQualityBanner visible={qualityBannerVisible} />
        {!isRinging && (
          <View style={styles.voiceTray}>
          <View style={styles.voiceCtrlRow}>
            {[
              {id:'mute',    icon:isMuted ? 'microphone-off' : 'microphone',                label:'Mute',    active:isMuted,   onPress:tap(() => setIsMuted(m => !m))},
              // Audio route button: tap = toggle speaker (legacy
              // behavior). Long-press = open multi-route picker so users
              // with several BT devices can pick one. The icon
              // reflects the active route, not the legacy isSpeaker
              // boolean — that way "BT" shows when routed to a headset.
              {id:'speaker',
                icon: audioRoute === 'BLUETOOTH' ? 'bluetooth-audio'
                  : audioRoute === 'WIRED_HEADSET' ? 'headphones'
                  : audioRoute === 'SPEAKER_PHONE' ? 'volume-high'
                  : isSpeaker ? 'volume-high' : 'volume-medium',
                label: audioRoute === 'BLUETOOTH' ? 'BT'
                  : audioRoute === 'WIRED_HEADSET' ? 'Wired'
                  : 'Speaker',
                active: audioRoute === 'BLUETOOTH' || audioRoute === 'WIRED_HEADSET' || isSpeaker,
                onPress: tap(() => {
                  // Open the multi-route picker only if there's a real
                  // CHOICE beyond plain earpiece/speaker — i.e. a BT
                  // headset or wired headset is currently available.
                  // The previous threshold `audioRoutes.length >= 2`
                  // misfired: every Android device always exposes BOTH
                  // EARPIECE and SPEAKER_PHONE in the route list, so
                  // length was always ≥ 2 and the picker opened on
                  // every tap — making the speaker button feel
                  // unresponsive (user dismisses picker without
                  // choosing, nothing changes).
                  const hasExternalRoute = audioRoutes.some(r => r === 'BLUETOOTH' || r === 'WIRED_HEADSET');
                  if (hasExternalRoute) {setRoutePickerOpen(true);}
                  else {setIsSpeaker(s => !s);}
                }),
                onLongPress: () => setRoutePickerOpen(true),
              },
              {id:'hold',    icon:isOnHold ? 'play-circle-outline' : 'pause-circle-outline', label:isOnHold ? 'Resume' : 'Hold', active:isOnHold, onPress:tap(() => setIsOnHold(h => !h))},
              // QA Fix #9: Camera button on the voice-call row. Tapping
              // kicks off the mid-call SDP renegotiation pipeline
              // (call.reoffer / call.reanswer); see setIsCameraOn for
              // the upgrade flow. Disabled visually + functionally
              // while a renegotiation is in progress so a fast
              // double-tap can't fire two upgrades. Label flips to
              // "Adding…" so the user knows something IS happening
              // (the camera permission prompt + SDP round-trip can
              // take a couple seconds on cellular).
              //
              // Replaced the Keypad button (DTMF dialing isn't wired
              // in Bravo — never PSTN-bridged) so we don't outgrow
              // the 5-slot row.
              // B-389 — also disabled until the call is CONNECTED. The tray is
              // hidden only for an incoming ringing call, so on an outgoing one
              // (state 'calling') this button used to be live and a tap threw
              // `upgradeToVideo: call must be connected`, which surfaced as
              // "End the call and start a fresh video call" — advice that
              // destroys a healthy call for a condition that clears itself when
              // the peer answers. setIsCameraOn holds the same guard (the
              // peer-added-video alert is a second entry point); this is the
              // visible half so the control never invites the tap.
              {id:'camera',  icon: liveCall.isUpgrading ? 'progress-clock' : 'video',  label: liveCall.isUpgrading ? 'Adding…' : 'Camera',  active:false,     disabled: !isCallConnected || liveCall.isUpgrading,  onPress:tap(() => { if (!liveCall.isUpgrading && isCallConnected) {setIsCameraOn(c => !c);} })},
              {id:'add',     icon:'account-plus',                                            label:'Add',     active:false,     onPress:tap(() => { console.log('[add-call] tap Add — opening picker, callType=', callType); setAddPickerOpen(true); })},
            ].map(btn => {
              const btnDisabled = (btn as {disabled?: boolean}).disabled === true;
              return (
              <View key={btn.id} style={styles.voiceCtrlBtn}>
                <TouchableOpacity
                  style={[styles.ctrlCircleVoice, btn.active && styles.ctrlCircleActive, btnDisabled && styles.ctrlCircleDisabled]}
                  onPress={btn.onPress}
                  onLongPress={(btn as {onLongPress?: () => void}).onLongPress}
                  disabled={btnDisabled}
                  accessibilityState={{disabled: btnDisabled}}
                  activeOpacity={0.8}>
                  <Icon name={btn.icon} size={20} color={btnDisabled ? 'rgba(184,199,224,0.35)' : '#B8C7E0'} />
                </TouchableOpacity>
                <Text style={[styles.voiceCtrlLabel, btnDisabled && styles.voiceCtrlLabelDisabled]}>{btn.label}</Text>
              </View>
              );
            })}
          </View>
          {/* divider + dominant End button inside the glass tray (design) */}
          <View style={styles.voiceTrayDivider} />
          <TouchableOpacity style={styles.endBtnVoice} onPress={endCall} activeOpacity={0.85}>
            <Icon name="phone-hangup" size={28} color="#FFF" />
          </TouchableOpacity>
          </View>
        )}

        {/* Audio route picker — modal-style overlay shown when user
            taps the speaker button with multiple routes available, or
            long-presses it. Lists every available route with the
            currently-active one highlighted. */}
        {routePickerOpen && audioRoutes.length > 0 && (
          <View style={styles.routePickerBackdrop}>
            <TouchableOpacity
              style={StyleSheet.absoluteFillObject}
              onPress={() => setRoutePickerOpen(false)}
              activeOpacity={1}
            />
            <View style={[styles.routePickerSheet, {paddingBottom: 32 + insets.bottom}]}>
              <Text style={styles.routePickerTitle}>Audio output</Text>
              {audioRoutes.map(r => {
                const label = r === 'BLUETOOTH' ? 'Bluetooth headset'
                  : r === 'SPEAKER_PHONE' ? 'Speaker'
                  : r === 'WIRED_HEADSET' ? 'Wired headset'
                  : 'Earpiece';
                const icon = r === 'BLUETOOTH' ? 'bluetooth-audio'
                  : r === 'SPEAKER_PHONE' ? 'volume-high'
                  : r === 'WIRED_HEADSET' ? 'headphones'
                  : 'phone';
                const active = audioRoute === r;
                return (
                  <TouchableOpacity
                    key={r}
                    style={[styles.routeRow, active && styles.routeRowActive]}
                    onPress={() => pickAudioRoute(r)}
                    activeOpacity={0.7}>
                    <Icon name={icon} size={22} color={active ? '#5B8DEF' : '#B8C7E0'} />
                    <Text style={[styles.routeLabel, active && {color: '#5B8DEF'}]}>{label}</Text>
                    {active && <Icon name="check" size={20} color="#5B8DEF" />}
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        )}

        {isRinging ? (
          <View style={styles.ringActions}>
            <View style={styles.ringSlot}>
              <TouchableOpacity
                style={[styles.ringBtn, styles.ringDecline]}
                activeOpacity={0.85}
                onPress={declineCall}>
                <Icon name="phone-hangup" size={30} color="#FFF" />
              </TouchableOpacity>
              <Text style={styles.ringBtnLabel}>Decline</Text>
            </View>
            <View style={styles.ringSlot}>
              <TouchableOpacity
                style={[styles.ringBtn, styles.ringAccept]}
                activeOpacity={0.85}
                onPress={() => { Vibration.cancel(); logCallLat('1to1-in', callId, 'tap:accept'); setUserAccepted(true); }}>
                <Icon name={isVideo ? 'video' : 'phone'} size={30} color="#FFF" />
              </TouchableOpacity>
              <Text style={styles.ringBtnLabel}>Accept</Text>
            </View>
          </View>
        ) : null /* non-ringing End now lives inside the glass tray above */}

        <View style={styles.homeIndicator} />
      </View>

      {/* Fix #43: shared Add-picker — see definition above the
          isVideo branch (single source of truth). */}
      {addPickerModal}

      {/* DTMF dialpad */}
      <Modal visible={dialpadOpen} transparent animationType="slide" onRequestClose={() => setDialpadOpen(false)}>
        <Pressable style={styles.dialpadBackdrop} onPress={() => setDialpadOpen(false)}>
          <Pressable style={[styles.dialpadSheet, {paddingBottom: 32 + insets.bottom}]}>
            <View style={styles.dialpadDisplay}>
              <Text style={styles.dialpadDigits}>{dialedDigits || '—'}</Text>
            </View>
            <View style={styles.dialpadGrid}>
              {['1','2','3','4','5','6','7','8','9','*','0','#'].map(k => (
                <TouchableOpacity
                  key={k}
                  style={styles.dialpadKey}
                  activeOpacity={0.6}
                  onPress={() => { Vibration.vibrate(20); setDialedDigits(d => (d + k).slice(-16)); }}>
                  <Text style={styles.dialpadKeyText}>{k}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={styles.dialpadActions}>
              <TouchableOpacity onPress={() => setDialedDigits('')} activeOpacity={0.7}>
                <Text style={styles.dialpadClear}>Clear</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setDialpadOpen(false)} activeOpacity={0.7}>
                <Text style={styles.dialpadClose}>Close</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Weak-network recovery overlay. Shown when ICE goes
          'disconnected' mid-call; controller transitions state to
          'reconnecting' and fires an ICE-restart reoffer behind the
          scenes. Auto-dismisses when iceConnectionState returns to
          'connected' (typical 2–6s); call ends with 'failed' if the
          30s reconnect budget exhausts. */}
      {liveCall.state === 'reconnecting' && (
        <ReconnectingOverlay
          peerName={peerName}
          peerInitials={peerInitials}
          onCancel={() => { void liveCall.hangup(); }}
        />
      )}
    </View>
  );
}

/**
 * Full-screen overlay shown while a 1:1 call is recovering from an ICE
 * disconnect (weak-network handover, brief packet-loss spike). Mirrors
 * the WhatsApp recovery UX: peer chrome stays visible underneath, a
 * dark scrim + center card communicate the state, and an elapsed
 * counter reaches 30s before the controller's budget timer ends the
 * call as failed.
 */
/**
 * Animated pulse rings radiating from the ringing avatar — three
 * staggered rings that scale-up + fade-out on a loop, giving a real
 * "calling out" feel (per the Bravo Video Call design). Purely
 * decorative: runs only while the call is pre-connect (calling /
 * ringing / connecting) and stops once media lands. Uses the JS-driver
 * for opacity+scale together (RN can't run both on the native driver
 * for a non-transform style); the rings are cheap (3 views) so the
 * cost is negligible.
 */
function PulseRings({size = 300}: {size?: number}) {
  const rings = useRef([new Animated.Value(0), new Animated.Value(0), new Animated.Value(0)]).current;
  useEffect(() => {
    const loops = rings.map((v, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 1100),
          Animated.timing(v, {toValue: 1, duration: 3300, easing: Easing.out(Easing.ease), useNativeDriver: true}),
        ]),
      ),
    );
    loops.forEach(l => l.start());
    return () => loops.forEach(l => l.stop());
  }, [rings]);
  return (
    <View pointerEvents="none" style={{position: 'absolute', width: size, height: size, alignItems: 'center', justifyContent: 'center'}}>
      {rings.map((v, i) => (
        <Animated.View
          key={i}
          style={{
            position: 'absolute',
            width: size, height: size, borderRadius: size / 2,
            borderWidth: 1.5, borderColor: 'rgba(167,139,250,0.55)',
            opacity: v.interpolate({inputRange: [0, 0.15, 1], outputRange: [0, 0.5, 0]}),
            transform: [{scale: v.interpolate({inputRange: [0, 1], outputRange: [0.45, 1]})}],
          }}
        />
      ))}
    </View>
  );
}

function ReconnectingOverlay(props: {
  peerName:     string;
  peerInitials: string;
  onCancel:     () => void;
}): React.ReactElement {
  const [elapsed, setElapsed] = useState(0);
  const t0Ref = useRef(Date.now());
  useEffect(() => {
    t0Ref.current = Date.now();
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - t0Ref.current) / 1000));
    }, 250);
    return () => clearInterval(id);
  }, []);
  const remaining = Math.max(0, 30 - elapsed);
  return (
    <View style={styles.reconnectScrim} pointerEvents="auto">
      <View style={styles.reconnectCard}>
        <View style={styles.reconnectAvatar}>
          <Text style={styles.reconnectAvatarTxt}>{props.peerInitials}</Text>
        </View>
        <Text style={styles.reconnectPeerName} numberOfLines={1}>{props.peerName}</Text>
        <View style={styles.reconnectStatusRow}>
          <ActivityIndicator size="small" color="#FBBF24" />
          <Text style={styles.reconnectStatusTxt}>Reconnecting…</Text>
        </View>
        <Text style={styles.reconnectCounter}>
          {elapsed}s of 30s
        </Text>
        <Text style={styles.reconnectHint}>
          Trying to restore the call.
          {remaining > 0 ? ` Giving up in ${remaining}s if the network does not recover.` : ''}
        </Text>
        <TouchableOpacity
          style={styles.reconnectCancelBtn}
          onPress={props.onCancel}
          activeOpacity={0.75}>
          <Text style={styles.reconnectCancelTxt}>End call</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// Round 4 / Architecture audit fix: wrap the screen's render tree in
// a per-screen ErrorBoundary so a crash inside CallScreen (e.g. a
// degraded RN-WebRTC build throwing inside an RTCView callback)
// doesn't unmount the whole app — the user sees an in-screen error
// card with Retry + Back instead of the global recovery screen.
const CallScreen = withScreenErrorBoundary(CallScreenInner, 'Call');
export default CallScreen;

const styles = StyleSheet.create({
  // ── Video Call ──
  videoRoot: {flex:1, backgroundColor: VC_BG},
  videoBg: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: VC_BG,
  },
  videoTopGrad: {
    position:'absolute', top:0, left:0, right:0, height:160, zIndex:1,
    backgroundColor:'rgba(0,0,0,0.5)',
  },
  videoBottomGrad: {
    position:'absolute', bottom:0, left:0, right:0, height:200, zIndex:1,
    backgroundColor:'rgba(0,0,0,0.7)',
  },
  videoTopBar: {
    position:'absolute', top:0, left:0, right:0, zIndex:10,
    flexDirection:'row', justifyContent:'space-between', alignItems:'flex-start',
    paddingHorizontal:16,
  },
  videoName: {flexShrink:1, minWidth:0, color:'#FFF', fontSize:13, fontWeight:'800', letterSpacing:2, textTransform:'uppercase'},
  connectedRow: {flexDirection:'row', alignItems:'center', gap:6, marginTop:3},
  connectedDot: {width:6, height:6, borderRadius:3, backgroundColor:'#22c55e'},
  connectedText: {color:'#22c55e', fontSize:10, fontWeight:'800', letterSpacing:2, textTransform:'uppercase'},
  videoTopRight: {alignItems:'flex-end', gap:6},
  signalBars: {flexDirection:'row', alignItems:'flex-end', gap:3},
  sigBar: {width:3, borderRadius:1, backgroundColor:'rgba(255,255,255,0.9)'},
  aesBadge: {flexDirection:'row', alignItems:'center', gap:4, paddingHorizontal:10, paddingVertical:4, borderRadius:99, backgroundColor:'rgba(34,197,94,0.15)', borderWidth:1, borderColor:'rgba(34,197,94,0.3)'},
  aesText: {color:'#4ade80', fontSize:9, fontWeight:'800', letterSpacing:1.5, textTransform:'uppercase'},
  qualityStrip: {flexDirection:'row', alignItems:'center', gap:5, paddingHorizontal:8, paddingVertical:4, borderRadius:99, backgroundColor:'rgba(19,24,42,0.85)', borderWidth:1, borderColor:'rgba(255,255,255,0.12)'},
  qualityKey: {fontSize:10, fontWeight:'800', letterSpacing:0.4, fontFamily:Platform.select({ios:'Menlo', default:'monospace'})},
  qualityLbl: {color:'#7E8AA6', fontSize:8.5, fontWeight:'700', letterSpacing:1.4, fontFamily:Platform.select({ios:'Menlo', default:'monospace'})},

  videoAvatarWrap: {
    position:'absolute', top:0, left:0, right:0, bottom:60,
    zIndex:5, alignItems:'center', justifyContent:'center',
  },
  // Premium ringing avatar — 168px violet disc with a glow halo + inner
  // highlight, matching the Bravo Video Call design (was a flat 110px
  // circle). The pulse rings radiate from behind it.
  videoAvatar: {
    width:168, height:168, borderRadius:84,
    backgroundColor:'#4A3FB0', borderWidth:1, borderColor:'rgba(167,139,250,0.5)',
    alignItems:'center', justifyContent:'center', overflow:'hidden',
    shadowColor:'#7C5AD6', shadowOpacity:0.5, shadowRadius:40, shadowOffset:{width:0, height:0}, elevation:16,
  },
  // Top-left radial highlight so the disc reads as lit, not flat.
  videoAvatarInner: {
    position:'absolute', top:-30, left:-30, width:150, height:150, borderRadius:75,
    backgroundColor:'rgba(150,130,235,0.55)',
  },
  videoAvatarText: {color:'#FFF', fontSize:52, fontWeight:'700', letterSpacing:1},

  // BS-021 — remote camera-off placeholder. Same dark backdrop the
  // full-screen video uses so the swap is seamless. Avatar circle +
  // explicit "Camera off" label so the user knows the disable was
  // intentional rather than a frozen connection.
  remoteCameraOff: {
    backgroundColor: VC_BG,
    alignItems: 'center',
    justifyContent: 'center',
  },
  remoteCameraOffAvatar: {
    width: 96, height: 96, borderRadius: 48,
    backgroundColor: 'rgba(148,163,184,0.16)',
    borderWidth: 2, borderColor: 'rgba(148,163,184,0.32)',
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 18,
  },
  remoteCameraOffLabel: {
    color: '#E2E8F0',
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 1.6,
    textTransform: 'uppercase',
  },
  remoteCameraOffSubtle: {
    color: '#94A3B8',
    fontSize: 13,
    marginTop: 6,
    paddingHorizontal: 24,
    textAlign: 'center',
  },

  pip: {
    // Modern PiP — bigger, rounder, drop-shadow so it feels like
    // floating glass. The previous tile was tiny and abutted the edge.
    // Owns position, size, border, radius and shadow ONLY; the video
    // plane lives inside pipClip below (B-455).
    position:'absolute', width:108, height:148, borderRadius:18,
    borderWidth:2, borderColor:'rgba(255,255,255,0.28)',
    backgroundColor:'#0F1422', alignItems:'center', justifyContent:'center',
    overflow:'hidden',
    zIndex:20,
    shadowColor:'#000', shadowOpacity:0.45, shadowRadius:18, shadowOffset:{width:0, height:8}, elevation:14,
  },
  // B-455 — the clip box. Zero insets pin it to the PADDING box, i.e.
  // exactly the border's content box (108-4 x 148-4), so there is no band
  // between the video and the border and nothing to bleed past it. Its
  // radius is the OUTER radius minus the border width (18 - 2) so the
  // curve is concentric with the frame.
  pipClip: {
    position:'absolute', top:0, left:0, right:0, bottom:0,
    borderRadius:16, overflow:'hidden',
  },
  // Tile content fill — pinned to pipClip's box. NEVER give this negative
  // insets: an RTCView is a native SurfaceView on Android and the parent's
  // rounded clip does not apply to it, so any outward inset renders as
  // square video sticking out past the frame (the B-455 report).
  pipFill: {position:'absolute', top:0, left:0, right:0, bottom:0},
  // B-454 — the only visible cue that the small tile swaps on tap.
  // Bottom-LEFT so it never collides with the camera-off badge at
  // bottom-right.
  pipSwapHint: {position:'absolute', bottom:6, left:6, opacity:0.9},

  videoControls: {
    position:'absolute', bottom:0, left:0, right:0, zIndex:20,
    paddingHorizontal:16, paddingTop:16,
  },
  // Glass control tray — the Bravo Video Call design wraps the controls
  // in a rounded translucent panel with a hairline border + lift shadow,
  // so the dock reads as floating glass over the call backdrop instead
  // of a flat bottom row.
  ctrlTray: {
    borderRadius:28, paddingVertical:16, paddingHorizontal:16,
    backgroundColor:'rgba(22,28,42,0.72)',
    borderWidth:1, borderColor:'rgba(255,255,255,0.1)',
    shadowColor:'#000', shadowOpacity:0.4, shadowRadius:24, shadowOffset:{width:0, height:-6}, elevation:18,
  },
  // Tier 1 — toggle row (Mute / Video / BT / Blur), evenly spaced.
  ctrlTierRow: {flexDirection:'row', alignItems:'flex-start', justifyContent:'space-between'},
  // 56px round toggle; white-filled when active (design's on-state).
  ctrlToggle: {
    width:56, height:56, borderRadius:28, alignItems:'center', justifyContent:'center',
    backgroundColor:'rgba(255,255,255,0.07)', borderWidth:1, borderColor:'rgba(255,255,255,0.12)',
  },
  // B-104 — NO `elevation` here: the shadow* props are iOS-only, so on
  // Android this style reduced to a bare elevation:8 whose native shadow
  // is dark — and when ctrlCircleOff overrode the background to 18%-alpha
  // red (camera off) the full shadow showed THROUGH the disc as the black
  // hexagon blob under the button. The intended white glow never rendered
  // on Android anyway; the opaque active fill is the state signal.
  ctrlToggleActive: {
    backgroundColor:'#FFFFFF', borderColor:'#FFFFFF',
    shadowColor:'#FFF', shadowOpacity:0.18, shadowRadius:22, shadowOffset:{width:0, height:8},
  },
  ctrlTrayDivider: {height:1, marginVertical:16, marginHorizontal:8, backgroundColor:'rgba(255,255,255,0.1)'},
  // Tier 2 — Flip · End Call (dominant) · Add.
  ctrlTier2: {flexDirection:'row', alignItems:'center', justifyContent:'space-between', gap:12},
  ctrlUtil: {
    width:50, height:50, borderRadius:25, alignItems:'center', justifyContent:'center',
    backgroundColor:'rgba(255,255,255,0.05)', borderWidth:1, borderColor:'rgba(255,255,255,0.1)',
  },
  endPill: {
    flex:1, height:58, borderRadius:20, flexDirection:'row', alignItems:'center', justifyContent:'center', gap:12,
    backgroundColor:'#D32339', borderWidth:1, borderColor:'rgba(255,255,255,0.18)',
    shadowColor:'#D32339', shadowOpacity:0.5, shadowRadius:24, shadowOffset:{width:0, height:12}, elevation:12,
  },
  endPillText: {color:'#FFF', fontSize:16, fontWeight:'700', letterSpacing:1},
  ctrlRow: {flexDirection:'row', justifyContent:'space-between', alignItems:'center'},
  ctrlBtnWrap: {alignItems:'center'},
  ctrlCircleVideo: {
    width:40, height:40, borderRadius:20, alignItems:'center', justifyContent:'center',
    backgroundColor:'rgba(0,0,0,0.55)', borderWidth:1, borderColor:'rgba(255,255,255,0.15)',
  },
  ctrlCircleActive: {backgroundColor:'rgba(91,141,239,0.35)', borderColor:'rgba(91,141,239,0.5)'},
  // B-389 — a control that cannot act yet must LOOK inert, or the user taps it
  // and gets an error for a state that resolves on its own.
  ctrlCircleDisabled: {opacity:0.4},
  // Camera-OFF visual: red tint + label so the user can tell at a
  // glance their video isn't going out. Replaces the v1.0.10 behaviour
  // where the only difference was a tiny `video` vs `video-off` icon
  // glyph that users couldn't distinguish at small button size.
  // B-104 — elevation:0 belt-and-braces: this style lands ON TOP of
  // ctrlToggleActive in the Video button's style array, so a future
  // re-added glow can never regress the translucent camera-off state.
  ctrlCircleOff: {backgroundColor:'rgba(248,113,113,0.18)', borderColor:'rgba(248,113,113,0.55)', elevation:0},
  // Audio interruption banner — same shape as the GroupCallScreen
  // banner. Surfaced when AUDIOFOCUS_LOSS fires (incoming WhatsApp/etc).
  audioInterruptBanner: {
    position: 'absolute', left: 12, right: 12,
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 12, paddingVertical: 8,
    backgroundColor: 'rgba(180,83,9,0.92)',
    borderWidth: 1, borderColor: 'rgba(252,211,77,0.45)',
    borderRadius: 12, zIndex: 60,
    elevation: 6, shadowColor: '#000', shadowOpacity: 0.3,
    shadowRadius: 6, shadowOffset: {width: 0, height: 3},
  },
  audioInterruptTxt: {color:'#FEF3C7', fontSize: 11, fontWeight: '700', flex: 1},
  ctrlCircleBlue: {backgroundColor:'rgba(91,141,239,0.35)', borderColor:'rgba(91,141,239,0.5)'},
  endBtnVideo: {
    width:40, height:40, borderRadius:20, alignItems:'center', justifyContent:'center',
    backgroundColor:'#DC2626', borderWidth:1, borderColor:'rgba(220,38,38,0.5)',
    shadowColor:'#DC2626', shadowOpacity:0.5, shadowRadius:10, elevation:4,
  },
  ctrlLabel: {textAlign:'center', color:'rgba(255,255,255,0.5)', fontSize:10, fontWeight:'800', letterSpacing:1.5, textTransform:'uppercase', marginTop:6},

  // ── Voice Call ──
  voiceRoot: {
    flex:1,
    // Deep indigo-black from the Bravo Audio Call design (radial
    // #11122A→#0A0B14→#05060B; solid mid-tone stands in for the gradient).
    backgroundColor:'#0A0B14',
  },
  voiceTopRow: {
    flexDirection:'row', justifyContent:'space-between', alignItems:'center',
    paddingHorizontal:16, paddingBottom:12,
  },
  minimiseBtn: {
    flexDirection:'row', alignItems:'center', gap:6,
    paddingHorizontal:12, paddingVertical:6, borderRadius:99,
    backgroundColor:'rgba(255,255,255,0.07)', borderWidth:1, borderColor:'rgba(255,255,255,0.1)',
  },
  minimiseText: {color:'#B8C7E0', fontSize:10, fontWeight:'800', letterSpacing:2, textTransform:'uppercase'},
  encBadgeVoice: {
    flexDirection:'row', alignItems:'center', gap:6,
    paddingHorizontal:10, paddingVertical:6, borderRadius:99,
    backgroundColor:'rgba(153,27,27,0.2)', borderWidth:1, borderColor:'rgba(239,68,68,0.28)',
  },
  encBadgeLine: {color:'#F87171', fontSize:9, fontWeight:'800', letterSpacing:2, textTransform:'uppercase', lineHeight:12},

  voiceAvatarSection: {alignItems:'center', paddingTop:16},
  pulseWrap: {position:'relative', alignItems:'center', justifyContent:'center', marginBottom:24, width:150, height:150},
  pulseRing: {
    position:'absolute', width:150, height:150, borderRadius:75,
    borderWidth:1.5, borderColor:'rgba(167,139,250,0.45)',
  },
  // Premium 132px violet disc + glow + outline ring, matching the video
  // call avatar so both call screens share one visual language.
  voiceAvatar: {
    width:132, height:132, borderRadius:66,
    backgroundColor:'#4A3FB0', overflow:'hidden',
    borderWidth:1, borderColor:'rgba(167,139,250,0.5)',
    alignItems:'center', justifyContent:'center',
    shadowColor:'#7C5AD6', shadowOpacity:0.5, shadowRadius:40, shadowOffset:{width:0, height:0}, elevation:14,
  },
  voiceAvatarInner: {
    position:'absolute', top:-24, left:-24, width:120, height:120, borderRadius:60,
    backgroundColor:'rgba(150,130,235,0.55)',
  },
  voiceAvatarText: {color:'#FFF', fontSize:42, fontWeight:'700', letterSpacing:1},
  voiceName: {
    color:'#FFF', fontSize:28, fontWeight:'800', letterSpacing:3.5,
    textTransform:'uppercase', textAlign:'center', lineHeight:34, marginBottom:12,
  },
  callSubtitle: {color:'#7E8AA6', fontSize:9.5, fontWeight:'600', letterSpacing:2, textTransform:'uppercase', marginTop:4},

  // Contained waveform band — matches the Bravo Audio Call design's
  // fixed 56px-tall strip. Previously this was `flex:1`, which stretched
  // the row across the whole mid-screen; when the call was idle/quiet the
  // 11 short bars collapsed into a single faint horizontal line floating
  // in the empty space (the stray "slide bar"). A fixed height keeps it a
  // tidy band; sibling flex spacers (see render) absorb the slack and
  // keep the control tray pinned to the bottom.
  waveformWrap: {
    height:56,
    flexDirection:'row', alignItems:'center', justifyContent:'center',
    gap:5, opacity:0.75,
  },
  waveSpacer: {flex:1},
  // Violet bar matching the design's #B7BEFF→#7C5AD6 gradient (mid-tone).
  waveBar: {width:3.5, borderRadius:3, backgroundColor:'#9B86E6', transformOrigin:'bottom'},

  voiceControls: {paddingHorizontal:16},
  // Glass control tray — matches the video call dock + the Bravo Audio
  // Call design: rounded translucent panel holding the toggle row, a
  // divider, and the dominant End button.
  voiceTray: {
    borderRadius:28, paddingVertical:16, paddingHorizontal:16,
    backgroundColor:'rgba(22,28,42,0.7)',
    borderWidth:1, borderColor:'rgba(255,255,255,0.1)',
    shadowColor:'#000', shadowOpacity:0.4, shadowRadius:24, shadowOffset:{width:0, height:-6}, elevation:18,
  },
  voiceTrayDivider: {height:1, marginVertical:16, marginHorizontal:8, backgroundColor:'rgba(255,255,255,0.1)'},
  voiceCtrlRow: {flexDirection:'row', justifyContent:'space-between', alignItems:'flex-start', paddingHorizontal:2},
  voiceCtrlBtn: {alignItems:'center', gap:8},
  ctrlCircleVoice: {
    width:60, height:60, borderRadius:30, alignItems:'center', justifyContent:'center',
    // Glass-look — soft translucent fill, hairline border, subtle inner glow.
    backgroundColor:'rgba(255,255,255,0.06)',
    borderWidth:1, borderColor:'rgba(255,255,255,0.10)',
  },
  voiceCtrlLabel: {color:'#9CA8C0', fontSize:10, fontWeight:'700', letterSpacing:1.6, textTransform:'uppercase'},
  voiceCtrlLabelDisabled: {color:'rgba(156,168,192,0.4)'},

  // Audio-route picker — modal-style sheet overlaid on the call UI
  // when the user wants to switch between BT / speaker / earpiece /
  // wired headset. Tapping outside the sheet closes it.
  routePickerBackdrop: {
    position:'absolute', top:0, left:0, right:0, bottom:0,
    backgroundColor:'rgba(0,0,0,0.55)',
    justifyContent:'flex-end',
  },
  routePickerSheet: {
    backgroundColor:'#0F172A',
    borderTopLeftRadius:20, borderTopRightRadius:20,
    paddingHorizontal:20, paddingTop:20, paddingBottom:32,
    borderTopWidth:1, borderColor:'rgba(255,255,255,0.10)',
  },
  routePickerTitle: {color:'#F1F5F9', fontSize:14, fontWeight:'700', letterSpacing:1.6, textTransform:'uppercase', marginBottom:14},
  routeRow: {flexDirection:'row', alignItems:'center', gap:14, paddingVertical:14, paddingHorizontal:12, borderRadius:12},
  routeRowActive: {backgroundColor:'rgba(91,141,239,0.12)'},
  routeLabel: {flex:1, color:'#E2E8F0', fontSize:15, fontWeight:'600'},

  endBtnVoice: {
    alignSelf:'center',
    width:76, height:76, borderRadius:38, alignItems:'center', justifyContent:'center',
    backgroundColor:'#E0314A',
    shadowColor:'#D32339', shadowOpacity:0.55, shadowRadius:28, shadowOffset:{width:0, height:10}, elevation:12,
    borderWidth:1, borderColor:'rgba(255,255,255,0.2)',
  },
  // Incoming-call answer/decline pair — shown only while liveCall.state === 'ringing'.
  ringActions: {
    flexDirection:'row', justifyContent:'space-evenly',
    alignSelf:'stretch', paddingHorizontal:24, marginBottom:16, marginTop:8,
  },
  ringSlot: {alignItems:'center', gap:10},
  ringBtnLabel: {
    color:'rgba(255,255,255,0.85)', fontSize:11, fontWeight:'700',
    letterSpacing:1.2, textTransform:'uppercase',
  },
  ringBtn: {
    width:76, height:76, borderRadius:38,
    alignItems:'center', justifyContent:'center',
    elevation:12,
    borderWidth:1.5, borderColor:'rgba(255,255,255,0.18)',
  },
  ringAccept: {
    backgroundColor:'#10B981',
    shadowColor:'#10B981', shadowOpacity:0.7, shadowRadius:28, shadowOffset:{width:0, height:8},
  },
  ringDecline: {
    backgroundColor:'#EF4444',
    shadowColor:'#EF4444', shadowOpacity:0.7, shadowRadius:28, shadowOffset:{width:0, height:8},
  },
  homeIndicator: {alignSelf:'center', width:110, height:4, borderRadius:2, backgroundColor:'rgba(255,255,255,0.15)', marginTop:8},

  // Local PiP avatar fallback — shown when the camera is off, perm
  // denied, or no live stream. Mirrors WhatsApp/FaceTime UX: a centered
  // initials disc instead of a generic "video-off" icon.
  pipAvatarWrap: {alignItems:'center', justifyContent:'center', backgroundColor:'#0F172A'},
  pipAvatar: {
    width:48, height:48, borderRadius:24,
    alignItems:'center', justifyContent:'center',
    backgroundColor:'#1E293B',
    borderWidth:1.5, borderColor:'rgba(255,255,255,0.12)',
  },
  pipAvatarLabel: {color:'#F1F5F9', fontSize:18, fontWeight:'700', letterSpacing:1.2},
  pipAvatarBadge: {position:'absolute', bottom:6, right:6, opacity:0.9},

  // DTMF dialpad modal
  dialpadBackdrop: {flex:1, backgroundColor:'rgba(0,0,0,0.7)', justifyContent:'flex-end'},
  dialpadSheet:    {backgroundColor:'#0B0E14', paddingTop:20, paddingHorizontal:20, paddingBottom:32, borderTopLeftRadius:20, borderTopRightRadius:20, borderTopWidth:1, borderColor:'rgba(255,255,255,0.08)'},
  dialpadDisplay:  {alignItems:'center', minHeight:44, justifyContent:'center', marginBottom:16, backgroundColor:'rgba(255,255,255,0.07)', borderRadius:10, paddingVertical:10},
  dialpadDigits:   {color:'#FFFFFF', fontSize:24, fontWeight:'700', letterSpacing:4},
  dialpadGrid:     {flexDirection:'row', flexWrap:'wrap', justifyContent:'space-between'},
  dialpadKey:      {width:'30%', aspectRatio:1.2, alignItems:'center', justifyContent:'center', backgroundColor:'rgba(91,141,239,0.10)', borderRadius:14, marginBottom:12},
  dialpadKeyText:  {color:'#FFFFFF', fontSize:26, fontWeight:'600'},
  dialpadActions:  {flexDirection:'row', justifyContent:'space-between', marginTop:4},
  dialpadClear:    {color:'#fca5a5', fontSize:14, fontWeight:'700', paddingVertical:10, paddingHorizontal:12},
  dialpadClose:    {color:'#5B8DEF', fontSize:14, fontWeight:'700', paddingVertical:10, paddingHorizontal:12},

  // ── Add-to-call picker (1:1 → group escalation sheet) ──
  addPickerSheet:    {backgroundColor:'#0B0E14', paddingTop:20, paddingHorizontal:20, paddingBottom:28, borderTopLeftRadius:20, borderTopRightRadius:20, borderTopWidth:1, borderColor:'rgba(255,255,255,0.08)', maxHeight:'72%'},
  addPickerTitle:    {color:'#FFFFFF', fontSize:17, fontWeight:'800', letterSpacing:0.4, marginBottom:6},
  addPickerHint:     {color:'#B8C7E0', fontSize:12, lineHeight:17, marginBottom:14},
  addPickerList:     {gap:8, paddingBottom:8},
  addPickerEmpty:    {color:'#7E8AA6', fontSize:13, textAlign:'center', paddingVertical:32, fontStyle:'italic'},
  addPickerRow:      {flexDirection:'row', alignItems:'center', gap:12, paddingHorizontal:12, paddingVertical:10, borderRadius:12, backgroundColor:'rgba(91,141,239,0.08)', borderWidth:1, borderColor:'rgba(91,141,239,0.2)'},
  addPickerAvatar:   {width:38, height:38, borderRadius:19, backgroundColor:'#13182A', alignItems:'center', justifyContent:'center', borderWidth:1, borderColor:'rgba(255,255,255,0.14)'},
  addPickerAvatarTxt:{color:'#FFFFFF', fontSize:13, fontWeight:'800', letterSpacing:0.6},
  addPickerName:     {color:'#FFFFFF', fontSize:14, fontWeight:'700'},
  addPickerSub:      {color:'#7E8AA6', fontSize:11, marginTop:2},
  addPickerCancel:   {marginTop:10, alignItems:'center', paddingVertical:12, borderRadius:12, backgroundColor:'rgba(255,255,255,0.05)'},
  addPickerCancelTxt:{color:'#B8C7E0', fontSize:13, fontWeight:'700', letterSpacing:0.5},

  // ── Reconnecting overlay (weak-network recovery) ──
  reconnectScrim: {
    position:'absolute', top:0, left:0, right:0, bottom:0,
    backgroundColor:'rgba(5,7,12,0.92)',
    alignItems:'center', justifyContent:'center',
    zIndex:200, elevation:200,
  },
  reconnectCard: {
    width:'82%', maxWidth:340,
    backgroundColor:'#13182A',
    borderWidth:1, borderColor:'rgba(255,255,255,0.14)',
    borderRadius:18, paddingVertical:26, paddingHorizontal:22,
    alignItems:'center', gap:10,
    shadowColor:'#000', shadowOffset:{width:0,height:8},
    shadowOpacity:0.45, shadowRadius:18, elevation:18,
  },
  reconnectAvatar: {
    width:64, height:64, borderRadius:32,
    backgroundColor:'rgba(255,255,255,0.08)',
    borderWidth:2, borderColor:'#FBBF24',
    alignItems:'center', justifyContent:'center',
    marginBottom:4,
  },
  reconnectAvatarTxt: {
    color:'#FFFFFF', fontSize:20, fontWeight:'800', letterSpacing:0.8,
  },
  reconnectPeerName: {
    color:'#FFFFFF', fontSize:16, fontWeight:'700', letterSpacing:0.3,
    maxWidth:'100%',
  },
  reconnectStatusRow: {
    flexDirection:'row', alignItems:'center', gap:8, marginTop:8,
  },
  reconnectStatusTxt: {
    color:'#FBBF24', fontSize:13, fontWeight:'700', letterSpacing:0.6,
  },
  reconnectCounter: {
    color:'#7E8AA6', fontSize:11, fontWeight:'600', letterSpacing:0.6,
    marginTop:2, fontFamily: Platform.select({ios:'Menlo', default:'monospace'}),
  },
  reconnectHint: {
    color:'#B8C7E0', fontSize:12, lineHeight:18, textAlign:'center',
    marginTop:10, paddingHorizontal:4,
  },
  reconnectCancelBtn: {
    marginTop:14, paddingHorizontal:22, paddingVertical:11,
    borderRadius:14, backgroundColor:'#E53935',
  },
  reconnectCancelTxt: {
    color:'#FFFFFF', fontSize:13, fontWeight:'800', letterSpacing:0.6,
  },
});
