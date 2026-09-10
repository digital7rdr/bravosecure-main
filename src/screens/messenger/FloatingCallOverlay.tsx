/**
 * FloatingCallOverlay — global "minimized call" UI.
 *
 * Mounted once at App.tsx so it can render over any screen the user
 * navigates to while a call is active. Subscribes to the
 * `callRegistry` singleton and shows nothing unless there's an active
 * call AND it's been minimized.
 *
 * Two layouts:
 *  - audio: a slim top-of-screen bar with caller name, duration,
 *           tap-to-restore, and an end-call button
 *  - video: a draggable floating card (Messenger / FaceTime style)
 *           with the remote video preview, tap-to-restore, end button
 */
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Animated, PanResponder, StyleSheet, Text, TouchableOpacity, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {RTCView} from 'react-native-webrtc';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import {navigationRef} from '@navigation/navigationRef';
import {navigateToMessengerScreen} from '@navigation/messengerDeepLink';
import {endActiveCall, getActiveCall, onActiveCallChange, setMinimized, type ActiveCallState} from '@/modules/messenger/runtime/callRegistry';
import {
  endActiveGroupCall, getActiveGroupCall, onActiveGroupCallChange, setGroupCallMinimized,
  patchActiveGroupCall,
  type ActiveGroupCallState,
} from '@/modules/messenger/runtime/groupCallRegistry';
import {logCallSm, shortCallId} from '@/modules/messenger/runtime/callDiag';
import {safeStreamURL} from '@/modules/messenger/webrtc/safeStreamURL';
import {resolveRemoteTile} from '@/modules/messenger/webrtc/remoteTileGate';

export default function FloatingCallOverlay(): React.ReactElement | null {
  const insets = useSafeAreaInsets();
  const [active, setActive] = useState<ActiveCallState | null>(null);
  const [groupActive, setGroupActive] = useState<ActiveGroupCallState | null>(null);
  // Local re-render tick driven by the registry. We can't rely on the
  // ActiveCallState reference identity changing, because patchActiveCall
  // sometimes mutates without swapping the object.
  useEffect(() => onActiveCallChange(setActive), []);
  useEffect(() => onActiveGroupCallChange(setGroupActive), []);

  // BS-MINBUBBLE — minimized-window SFU watchdog. While a group call is
  // minimized, NO useGroupCall hook is mounted (this overlay is a pure
  // registry consumer), so server control frames that arrive during the
  // minimize window are otherwise dropped: a host End / kick would leave the
  // bubble stuck forever over a dead call, and a peer who LEAVES would stay a
  // frozen phantom tile after restore. This watchdog runs ONLY while
  // minimized and: tears the registry down on room.ended / kicked, and drops
  // a leaver's tile. `registerSfuHandler` is additive (a Set), so it never
  // clobbers the live hook's handler; `endActiveGroupCall` is idempotent.
  const minimizedRoomId = groupActive?.isMinimized ? groupActive.roomId : null;
  useEffect(() => {
    if (!minimizedRoomId) {return;}
    const {registerSfuHandler} = require('@/modules/messenger/webrtc/sfuDispatcher') as typeof import('@/modules/messenger/webrtc/sfuDispatcher');
    return registerSfuHandler(minimizedRoomId, (frame) => {
      if (frame.event === 'sfu.room.ended' || frame.event === 'sfu.kicked') {
        // WI-1.5 — keyed: this watchdog is registered for one room, and a frame
        // for it must not tear down whatever room took the slot since.
        void endActiveGroupCall(minimizedRoomId);
      } else if (frame.event === 'sfu.participant.left') {
        const tag = (frame.data as {participantTag?: string})?.participantTag;
        const live = getActiveGroupCall();
        if (live && tag) {
          const tiles = live.remoteTiles.filter(t => t.participantTag !== tag);
          const ident = {...live.identityByTag};
          delete ident[tag];
          patchActiveGroupCall(minimizedRoomId, {remoteTiles: tiles, identityByTag: ident});
        }
      }
    });
  }, [minimizedRoomId]);

  // Duration counter — ticks for both 1:1 ('connected') and group ('joined').
  const [duration, setDuration] = useState(0);
  // Fix #22: re-evaluate the wall-clock anchor on EVERY tick (not just
  // at effect-rebind time). The previous code branched once based on
  // whether `startMs` was set at the moment the effect ran — so if the
  // overlay mounted BEFORE the underlying call hit connected/joined
  // (anchor still null), we fell into the local-fallback path and
  // never switched to the wall-clock even after the anchor landed.
  // Reading the registry on every tick is cheap and gives us a single
  // source of truth that auto-snaps to wall-clock the moment the
  // anchor lands.
  useEffect(() => {
    const oneOnOneOn = active?.state === 'connected';
    const groupOn    = groupActive?.state === 'joined';
    if (!oneOnOneOn && !groupOn) { setDuration(0); return; }
    let localFallback = 0;
    let anchored = false;
    const tick = (): void => {
      // Re-read every tick — `active` and `groupActive` here are the
      // closure captures from when the effect ran, but their `.connectedAtMs`
      // / `.joinedAtMs` fields are mutated in place by the registry's
      // patchActiveCall (the registry mutates not just swaps for these
      // fields), so reading through the closure is safe and current.
      const startMs = groupOn
        ? groupActive?.joinedAtMs ?? null
        : active?.connectedAtMs ?? null;
      if (startMs) {
        anchored = true;
        setDuration(Math.max(0, Math.round((Date.now() - startMs) / 1000)));
      } else if (!anchored) {
        // Local fallback only while the anchor is still null. Once
        // anchored we never come back here (latched).
        localFallback += 1;
        setDuration(localFallback);
      }
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [active, groupActive, active?.state, active?.connectedAtMs, groupActive?.state, groupActive?.joinedAtMs]);

  // Drag state for the video card — see useDraggablePan above.
  const {pan, panHandlers} = useDraggablePan();

  // Round 2 / Perf audit: stable streamURL cache for the 1:1 video path.
  // The ref MUST be declared before any early-return below, otherwise
  // hooks-order would change between renders and React would crash.
  // We compute the URL conditionally inside the if-isVideo branch later.
  const oneToOneUrlRef = useRef<string | null>(null);

  // WI-2.4 — the current route, from a NAVIGATION SUBSCRIPTION rather than a
  // render-time `getCurrentRoute()` read. Reading navigation during render made
  // this component's output a function of mutable external state React does not
  // track: it was only ever correct because the registry's 1 Hz duration patch
  // happened to re-render us, so a route change took up to a second to show —
  // and with no live call there is no 1 Hz patch at all. That latency is what
  // made B-460 read as a dead tap (the bar re-appeared ~1 s after a restore
  // that had silently failed). Declared HERE, above every early return, for the
  // same hooks-order reason as the ref above.
  const [routeName, setRouteName] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const ref = navigationRef as unknown as {
      isReady?: () => boolean;
      getCurrentRoute?: () => {name?: string} | undefined;
      addListener?: (t: string, cb: () => void) => (() => void) | undefined;
    };
    // `undefined` is the third state and it is load-bearing: "nav not ready"
    // (auth gate — the call is genuinely unreachable, so show End) must stay
    // distinguishable from "ready, and the route is not CallScreen".
    const sync = (): void => {
      try {
        if (!ref?.isReady?.()) { setRouteName(undefined); return; }
        setRouteName(ref.getCurrentRoute?.()?.name ?? null);
      } catch { setRouteName(undefined); }
    };
    sync();
    let off: (() => void) | undefined;
    try { off = ref?.addListener?.('state', sync); } catch { /* older nav ref — sync-only */ }
    return () => { try { off?.(); } catch { /* ignore */ } };
  }, []);

  // Group call takes precedence — only one floating overlay visible at
  // a time. (Two simultaneous calls is a UX disaster anyway and
  // useGroupCall / useCall both check the registry on boot to bail.)
  // WI-1.6 — do not float a bar for a call that is leaving. The entry now
  // outlives the End tap by up to the 3 s leave bound; without this the bubble
  // lingers over a dead call and its End button re-enters the teardown.
  if (groupActive?.isMinimized && !groupActive.ending) {
    // Founder bug 4 (2026-08-01) — inside a DIFFERENT conversation's chat
    // (e.g. a private 1:1 opened mid-group-call) the "Group video call"
    // bar reads as belonging to THAT chat; suppress it there only. Every
    // other surface (chat list, the group's own chat, other tabs) keeps
    // the return-to-call bar. The 1 Hz duration re-render picks up route
    // changes within a second (see the orphanedLive note below), so the
    // bar reappears as soon as the user leaves the foreign chat.
    const cur = (navigationRef as unknown as {getCurrentRoute?: () => {name?: string; params?: unknown} | undefined}).getCurrentRoute?.();
    const foreignChat = cur?.name === 'Chat' &&
      !!(cur.params as {conversationId?: string} | undefined)?.conversationId &&
      (cur.params as {conversationId: string}).conversationId !== groupActive.conversationId;
    if (!foreignChat) {
      return <GroupOverlay state={groupActive} duration={duration} />;
    }
    return null;
  }

  // B-64 — show the overlay not only for explicitly-minimized calls but for
  // ANY live in-progress 1:1 call whose CallScreen isn't the focused route:
  // an auth-gate swap can unmount the whole Main tree (user parked on the
  // OTP screen with a call running behind it), leaving no End control
  // anywhere. Restricted to post-answer states so the ring/dial surfaces
  // (which own 'ringing'/'calling') don't get a duplicate overlay flash.
  // WI-2.4 — the route now comes from a NAVIGATION SUBSCRIPTION, not a
  // render-time `getCurrentRoute()` read.
  //
  // Reading navigation during render made this component's output a function
  // of mutable external state React does not track: it was only ever correct
  // because the registry's 1 Hz duration patch happened to re-render us, so a
  // route change took up to a second to show — and with no live call there is
  // no 1 Hz patch at all. That latency is what made B-460 read as a dead tap:
  // the bar re-appeared ~1 s after a restore that had silently failed.
  // Subscribing makes the same decision edge-triggered and exact.


  // B-64's decision, unchanged — only its route input moved.
  const orphanedLive = ((): boolean => {
    if (!active || active.isMinimized) {return false;}
    if (active.state !== 'connecting' && active.state !== 'connected' && active.state !== 'reconnecting') {return false;}
    if (routeName === undefined) {return true;}   // nav not ready — call unreachable, show End
    return routeName !== 'CallScreen';
  })();

  if (!active) {return null;}
  if (!active.isMinimized && !orphanedLive) {return null;}

  const isVideo = active.kind === 'video';
  const peerName = active.peerName || 'Contact';
  const restore = (): void => {
    // Fix #24: re-check the registry BEFORE touching minimized state.
    // Between this overlay's render and the user's tap, the underlying
    // call may have been ended on another path (peer hung up, fail
    // event, manual end via the floating End button). Navigating to
    // CallScreen with stale `active` params would mount it for a call
    // that no longer exists.
    if (!getActiveCall()) {return;}
    // Bring CallScreen back to the foreground via the global
    // navigation ref so this overlay (mounted OUTSIDE the navigator
    // tree) can route. CallScreen on remount sees the active call
    // already in the registry and resumes the existing controller +
    // streams instead of starting a new call.
    //
    // P3 / B-460 — the overlay may only hide once the call screen is REALLY on
    // screen. The old order flipped minimized=false first; the P3 fix moved it
    // after the dispatch and its comment claimed the case was handled — but
    // "issued" is not "resolved". `navigateToMessengerScreen` returns TRUE for
    // a navigate React Navigation then drops silently (documented at
    // messengerDeepLink.ts:12-15), which is exactly what happens in the
    // product-gate / product-switch hold windows — and productSwitch.ts:48,53
    // minimizes the call at precisely that moment. So: consume the boolean AND
    // verify the resolved route on the next tick, reverting the optimistic
    // clear if the screen never arrived.
    try {
      const ref = navigationRef as unknown as {isReady: () => boolean};
      if (!ref?.isReady?.()) {return;}   // overlay stays up; user can retap
      // B-414 shell resolver, not a bare navigate: CallScreen is registered in
      // the Messenger and Agent stacks only, so a restore after a product
      // switch to secure/vbg was dropped in silence — a live call with no way
      // back to it. Item 18 makes that switch a one-tap action, which is why
      // it matters now.
      const ok = navigateToMessengerScreen(navigationRef as never, 'CallScreen', {
        callType:       active.kind,
        isIncoming:     active.direction === 'incoming',
        conversationId: active.conversationId,
        callId:         active.callId,
        remoteUserId:   active.peer.userId,
        remoteDeviceId: active.peer.deviceId,
      }, {initial: false});
      // B-460 — the return value was DISCARDED. It is false on three real paths
      // (messengerDeepLink :274/:275/:304: no nav object, not ready, a throwing
      // navigate), and each one hid the overlay while routing nowhere.
      if (!ok) {return;}
      // WI-1.1 — key both the clear and the deferred re-minimise on the call
      // this tap was FOR. `confirmRestored`'s fallback fires a tick later, by
      // which time the slot can hold a different call; unkeyed, it re-minimised
      // that one. Read at PRESS time, not from `active`: that is React state fed
      // by `onActiveCallChange`, so it is a commit behind the registry.
      // …and it must be the SAME call the bar is rendering. Mixing the two
      // sources is worse than either alone: the navigate above carries the
      // RENDERED callId, so if the slot moved between commit and tap we would
      // mount CallScreen for A while un-minimising B — leaving B with no screen
      // and no bar (orphanedLive is false, the route IS CallScreen), i.e. a live
      // call with zero End control. Refusing costs one no-op tap that the next
      // render fixes; acting costs a stranded call.
      const live = getActiveCall();
      if (!live || live.callId !== active.callId) {
        // Phase 1 routes dropped `end` ops to the release-visible lane because
        // "End landed nowhere" is the evidence you grep for. Refusing BEFORE
        // the registry call bypasses that, so say it here instead.
        logCallSm('overlay.restore.refused', {
          rendered: shortCallId(active.callId), live: shortCallId(live?.callId),
        });
        return;
      }
      const key = {callId: live.callId, gen: live.gen};
      setMinimized(key, false);
      confirmRestored('CallScreen', () => setMinimized(key, true));
    } catch { /* nav failed — leave the overlay up so the call isn't stranded */ }
  };
  // 'local' source so CallKit / Telecom logs the end correctly as a
  // user-initiated hangup (declined glyph in iOS Recents) rather than
  // a remote-ended one.
  //
  // Keyed on a PRESS-TIME read. Keying on the rendered `active` would key on
  // state that is one commit behind the registry — and a stale key does not
  // end the wrong call, it ends NOTHING: the End button silently no-ops while
  // the bubble is still on screen, which for a global overlay is the one
  // control the user has left.
  const hangup = (): void => {
    const live = getActiveCall();
    // Identity must agree with what the user is LOOKING at. A press-time read
    // alone would end whatever call holds the slot — so a bar still rendering A
    // would end B. Refuse instead; the next render re-points the bar.
    if (live && live.callId === active.callId) {
      endActiveCall({callId: live.callId, gen: live.gen}, 'ended', 'local');
    } else {
      logCallSm('overlay.end.refused', {
        rendered: shortCallId(active.callId), live: shortCallId(live?.callId),
      });
    }
  };

  // Round 2 / Perf audit: stable streamURL cache for the 1:1 video path.
  // Mirrors the GroupOverlay `lastUrlRef` pattern at line 325. Without
  // this, the IIFE called `safeStreamURL(active.remoteStream)` on every
  // render — and `patchActiveCall({duration, …})` mutates the
  // surrounding `active` object every second. The result was that the
  // RTCView's streamURL prop got a fresh string identity each tick,
  // forcing a JNI hop on the native side and occasionally swapping the
  // EGL surface mid-call. With the ref cache the prop only flips
  // identity when the underlying stream actually changes. The ref
  // itself is declared above the early returns so hooks-order stays
  // stable across renders; only the cache update happens here.
  const computedOneToOneUrl = isVideo ? safeStreamURL(active.remoteStream) : null;
  if (computedOneToOneUrl !== oneToOneUrlRef.current) {
    oneToOneUrlRef.current = computedOneToOneUrl;
  }
  const oneToOneVideoUrl = oneToOneUrlRef.current;
  // B-16 — remount the remote tile when the peer's video track arrives
  // (mid-call audio→video upgrade) so a same-stream-id upgrade rebinds
  // the native renderer instead of staying black. Mirrors CallScreen.
  const oneToOneRemoteHasVideo = (active.remoteStream?.getVideoTracks?.().length ?? 0) > 0;
  // O-E (VIDEO_CALL_RENDER_ISSUES_HANDOFF §4) — the minimized card never
  // got the CALL-N2 gate: it mounted the RTCView off streamURL alone, so
  // an audio-only or camera-off peer rendered a BLACK card. Share the
  // audited decision with CallScreen via resolveRemoteTile.
  const overlayGate = resolveRemoteTile({
    remoteVideoOff:  !!active.remoteVideoOff,
    remoteHasVideo:  oneToOneRemoteHasVideo,
    hasRemoteStream: !!active.remoteStream,
    streamURL:       oneToOneVideoUrl,
    videoTrackId:    active.remoteStream?.getVideoTracks?.()[0]?.id ?? null,
  });

  if (isVideo) {
    // Floating draggable card with remote video. Default origin is
    // top-right — pan moves it from there.
    return (
      <Animated.View
        style={[styles.videoCard, {transform: pan.getTranslateTransform()}]}
        {...panHandlers}>
        <TouchableOpacity activeOpacity={0.9} onPress={restore} style={StyleSheet.absoluteFill}>
          {/* B-455 — deliberately NO extra clip wrapper here, unlike
              CallScreen's PiP. That fix exists because the PiP pinned its
              plane to -2 on every side, out to the BORDER box; this card
              never had a bleed — the RTCView absolute-fills the card, whose
              own `overflow:'hidden'` already clips it on iOS. A wrapper
              would be inert.
              RESIDUAL, Android only: the vendored renderer exposes no
              TextureView / clip / corner option at all (RTCVideoViewManager
              props are mirror, objectFit, streamURL, zOrder,
              onDimensionsChange; setZOrder only toggles
              setZOrderMediaOverlay / setZOrderOnTop, WebRTCView.java:521-533),
              so the SurfaceView is composited ABOVE the window in its own
              layer and NO ancestor's rounded clip can reach it — not this
              card's, and not a wrapper's. The surface stays an unrounded
              rectangle inside the frame. A native TextureView renderer is
              the only true fix. */}
          {overlayGate.kind === 'video' ? (
            <RTCView
              key={`overlay-remote-${overlayGate.remountKey}`}
              streamURL={overlayGate.streamURL}
              style={StyleSheet.absoluteFill}
              objectFit="cover"
              mirror={false}
              zOrder={2}
            />
          ) : overlayGate.kind === 'camera-off' ? (
            <View style={[StyleSheet.absoluteFill, styles.videoCardPlaceholder]}>
              <Icon name="video-off" size={20} color="#94A3B8" />
            </View>
          ) : (
            <View style={[StyleSheet.absoluteFill, styles.videoCardPlaceholder]}>
              <Icon name="phone" size={20} color="#94A3B8" />
            </View>
          )}
          <View style={styles.videoCardFooter}>
            <Text numberOfLines={1} style={styles.videoCardName} maxFontSizeMultiplier={1.1}>{peerName}</Text>
            <Text style={styles.videoCardTimer} maxFontSizeMultiplier={1.1}>{formatDuration(duration)}</Text>
          </View>
        </TouchableOpacity>
        <TouchableOpacity onPress={hangup} style={styles.videoCardHangup} hitSlop={{top:8, left:8, right:8, bottom:8}}>
          <Icon name="phone-hangup" size={14} color="#fff" />
        </TouchableOpacity>
      </Animated.View>
    );
  }

  // Audio: a top bar across the screen.
  return (
    // The bar is `position:absolute; top:0`, so it sits UNDER the status bar
    // and owes its own top inset. It used to hard-code 44 — an iPhone-notch
    // constant — which is ~20px of dead space on a 24dp Android status bar and
    // too SHORT on a device with a tall cutout, where the title collided with
    // the clock. `+ 8` keeps the same visual breathing room the 44 implied.
    <View style={[styles.audioBar, {paddingTop: insets.top + 8}]} pointerEvents="box-none">
      <TouchableOpacity activeOpacity={0.85} onPress={restore} style={styles.audioBarTap}>
        <View style={styles.audioBarDot} />
        <Text numberOfLines={1} style={styles.audioBarTitle}>
          {active.state === 'connected' ? 'On call' : active.state === 'calling' ? 'Calling…' : active.state === 'ringing' ? 'Ringing…' : 'Connecting…'} · {peerName}
        </Text>
        {active.state === 'connected' && (
          <Text style={styles.audioBarTimer}>{formatDuration(duration)}</Text>
        )}
      </TouchableOpacity>
      <TouchableOpacity onPress={hangup} style={styles.audioBarHangup} hitSlop={{top:8, left:8, right:8, bottom:8}}>
        <Icon name="phone-hangup" size={16} color="#fff" />
      </TouchableOpacity>
    </View>
  );
}

/**
 * B-460 — did the restore actually LAND?
 *
 * `navigateToMessengerScreen` reports success as soon as it has dispatched, and
 * React Navigation drops an unresolvable nested navigate in silence (see
 * messengerDeepLink.ts:12-15). Both restore handlers clear the minimized flag
 * optimistically on that report, so a dropped navigate hides the overlay and
 * routes nowhere: a live call with no controls and no way back — the founder's
 * "the green bar does nothing" report.
 *
 * One tick later the resolved route is readable. If it is not the screen we
 * asked for, put the overlay back. ONE helper for both handlers, because two
 * copies of a revert is exactly how one of them keeps the next fix.
 */
function confirmRestored(target: string, revert: () => void): void {
  setTimeout(() => {
    const cur = (navigationRef as unknown as {
      getCurrentRoute?: () => {name?: string} | undefined;
    }).getCurrentRoute?.();
    // Absence of a readable route is NOT proof of failure (the container can be
    // mid-transition), so only an explicitly different route reverts.
    if (cur?.name && cur.name !== target) {revert();}
  }, 0);
}

/**
 * Fix #23: shared draggable-pan hook. Both the 1:1 audio/video card
 * and the group video card are draggable, and they used to each
 * declare their own `pan` Animated.ValueXY + `responder` PanResponder
 * — fine in isolation, but if both early-return paths somehow
 * mounted simultaneously (e.g. between a registry write and the
 * render that consumes it) two responders would compete for the same
 * gesture. Single source means whichever overlay is visible owns the
 * drag exclusively.
 *
 * We also use a value-listener pattern (Fix #8 from CallScreen) to
 * read the live offset on grant rather than poking `_value`.
 */
function useDraggablePan(): {pan: Animated.ValueXY; panHandlers: ReturnType<typeof PanResponder.create>['panHandlers']} {
  const pan = useRef(new Animated.ValueXY({x: 0, y: 0})).current;
  const valueRef = useRef({x: 0, y: 0});
  useEffect(() => {
    const idX = pan.x.addListener(({value}) => { valueRef.current.x = value; });
    const idY = pan.y.addListener(({value}) => { valueRef.current.y = value; });
    return () => {
      pan.x.removeListener(idX);
      pan.y.removeListener(idY);
    };
  }, [pan]);
  const responder = useMemo(
    () => PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder:  (_e, g) => Math.abs(g.dx) > 4 || Math.abs(g.dy) > 4,
      onPanResponderMove: Animated.event([null, {dx: pan.x, dy: pan.y}], {useNativeDriver: false}),
      onPanResponderRelease: () => pan.flattenOffset(),
      onPanResponderGrant: () => {
        const {x, y} = valueRef.current;
        pan.setOffset({x, y});
        pan.setValue({x: 0, y: 0});
      },
    }),
    [pan],
  );
  return {pan, panHandlers: responder.panHandlers};
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Floating overlay for an active group SFU call. Audio-only group call
 * is a top bar (mirrors 1:1); video group call shows a draggable PiP
 * card with the first remote video tile — GroupCallScreen sorts tiles
 * by audioLevel so [0] is the loudest speaker, which is the same
 * "show whoever is talking" model WhatsApp uses for its mini-window.
 * Falls back to the audio bar when no remote video is available yet.
 */
function GroupOverlay({state, duration}: {state: ActiveGroupCallState; duration: number}): React.ReactElement {
  // B-460 — the padding sweep that fixed the 1:1 bar patched only that one
  // site; this component never read the insets at all, so the group bar
  // rendered at top:0 INSIDE the status-bar strip, where SystemUI takes the
  // touches. On a device with a tall cutout the whole bar — tap target and
  // hangup alike — was untappable, which is the founder's dead green bar.
  const insets = useSafeAreaInsets();
  const restore = (): void => {
    // Fix #24: see 1:1 restore for full reasoning. If the group call
    // was ended (host left, kicked, etc.) between this overlay's
    // render and the user's tap, bail out before navigating.
    if (!getActiveGroupCall()) {return;}
    try {
      const ref = navigationRef as unknown as {isReady: () => boolean};
      if (ref?.isReady?.()) {
        /**
         * TWO fixes, both mirroring what the 1:1 path above already does.
         *
         * ORDER: the flag was cleared BEFORE dispatching, so a navigate that
         * was not ready — or that got dropped — hid the overlay and failed to
         * route, leaving a live group call with no End button and no way back.
         * The 1:1 path calls out this exact ordering in its own comment; this
         * one was written the other way round.
         *
         * SHELL: `GroupCallScreen` is registered in the Messenger and Agent
         * stacks only, so a bare navigate is silently dropped in secure/vbg —
         * the B-414 class. Item 18 lets a user switch product mid-call in one
         * tap, so this stopped being theoretical.
         */
        const ok = navigateToMessengerScreen(navigationRef as never, 'GroupCallScreen', {
          conversationId:   state.conversationId,
          callType:         state.callType,
          direction:        'incoming', // resume path — never re-rings
          roomId:           state.roomId,
          recipientUserIds: [],         // resume doesn't re-broadcast
          callerName:       state.conversationName,
        }, {initial: false});
        // B-460 — same discarded-boolean bug as the 1:1 path.
        if (!ok) {return;}
        // AFTER the dispatch, never before — see the ORDER note above.
        // WI-1.5 — key the deferred re-minimise on the room this tap was FOR;
        // it fires a tick later, when the slot may hold a different room. Read
        // at PRESS time: `state` is React state fed by
        // `onActiveGroupCallChange`, so it is a commit behind the registry.
        const liveNow = getActiveGroupCall();
        // Same rule as the 1:1 lane: the navigate carries the RENDERED roomId, so
        // acting on a different live room would strand it.
        if (!liveNow || liveNow.roomId !== state.roomId) {return;}
        const room = liveNow.roomId;
        setGroupCallMinimized(room, false);
        confirmRestored('GroupCallScreen', () => setGroupCallMinimized(room, true));
      }
    } catch { /* nav failed — leave the overlay up so the call isn't stranded */ }
  };
  // WI-1.5 — keyed on a PRESS-TIME read, for the same reason as the 1:1 End
  // above: keying on the rendered `state` keys on a commit-old snapshot, and a
  // stale key makes this button a silent no-op rather than a wrong teardown.
  const hangup = (): void => {
    const liveNow = getActiveGroupCall();
    if (liveNow && liveNow.roomId === state.roomId) {void endActiveGroupCall(liveNow.roomId);}
    else {
      logCallSm('overlay.group-end.refused', {
        rendered: shortCallId(state.roomId), live: shortCallId(liveNow?.roomId),
      });
    }
  };

  // Active-speaker tracking — pick the participant with the highest
  // audioLevel. Hero-hold debounce prevents rapid back-and-forth
  // flicker when two people interrupt each other; mirrors the hold
  // logic GroupCallScreen uses for its hero tile.
  // Fix #21: bumped HERO_HOLD_MS from 1.2s to 3s to match
  // GroupCallScreen — the previous 1.2s window let the overlay's
  // RTCView remount on rapid alternation between speakers, which
  // tears down the EGL surface and produces a one-frame black flash.
  // 3s of stickiness means the overlay PiP and the full-screen hero
  // tile track the SAME speaker through the same hold window.
  const HERO_HOLD_MS = 3000;
  const heroHoldRef = useRef<{tag: string; until: number} | null>(null);
  const activeTag = useMemo<string | null>(() => {
    const levels = state.audioLevels ?? {};
    // Build a candidate list ordered by audio level. Exclude self —
    // the overlay should show whoever's speaking on the other side,
    // not bounce to "you" when you talk.
    const candidates = Object.entries(levels)
      .filter(([tag]) => tag !== state.selfTag)
      .sort((a, b) => b[1] - a[1]);
    const naturalHero = candidates[0]?.[0]
      ?? state.remoteTiles.find(t => t.participantTag !== state.selfTag)?.participantTag
      ?? null;
    const now = Date.now();
    const pinned = heroHoldRef.current;
    if (pinned && pinned.until > now && pinned.tag !== naturalHero) {
      return pinned.tag;
    }
    if (naturalHero) {
      heroHoldRef.current = {tag: naturalHero, until: now + HERO_HOLD_MS};
    }
    return naturalHero;
  }, [state.audioLevels, state.remoteTiles, state.selfTag]);

  const activeName = useMemo<string>(() => {
    if (!activeTag) {return state.conversationName ?? 'Group call';}
    return state.identityByTag?.[activeTag]?.displayName
      ?? activeTag.slice(0, 6).toUpperCase();
  }, [activeTag, state.identityByTag, state.conversationName]);

  // Active speaker's video tile (only used in video-call PiP). Falls
  // back to ANY remote video tile if the active speaker doesn't have
  // a video producer (camera off) — better to show *some* live face
  // than a black card.
  const activeVideoTile = useMemo(() => {
    if (state.callType !== 'video') {return null;}
    // Skip paused video tiles — RTCView would otherwise show the last
    // decoded frame (frozen) instead of falling back to the audio bar.
    const isLiveVideo = (t: typeof state.remoteTiles[number]): boolean =>
      t.kind === 'video' && !t.paused;
    if (activeTag) {
      const t = state.remoteTiles.find(rt => rt.participantTag === activeTag && isLiveVideo(rt));
      if (t) {return t;}
    }
    return state.remoteTiles.find(isLiveVideo) ?? null;
  // The hook is keyed on the specific state slices it reads (callType,
  // remoteTiles, activeTag). Adding the full `state` would over-invalidate
  // — every connection-state flip would force a recompute and trigger a
  // re-render storm during call setup. Round 10 audit verified this.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.callType, state.remoteTiles, activeTag]);

  // Fix #23: shared draggable pan — see useDraggablePan above.
  const {pan, panHandlers} = useDraggablePan();

  // Fix #21: track previous activeVideoUrl in a ref + only re-update
  // the rendered URL when it actually changes. safeStreamURL can
  // return semantically-identical URLs across audioLevels ticks (the
  // underlying MediaStream is the same; .toURL() is stable for a
  // given native track) — but it occasionally returns a fresh string
  // when the JNI call goes through a new bridge frame. Holding the
  // last-known string means the RTCView's streamURL prop only flips
  // identity when the active speaker actually changes, not on every
  // 250ms audioLevels tick.
  const computedUrl = activeVideoTile ? safeStreamURL(activeVideoTile.stream) : null;
  const lastUrlRef = useRef<string | null>(null);
  // Only re-stamp when the URL actually changed (including → null). The
  // second half of the old condition was a no-op tautology.
  if (computedUrl !== lastUrlRef.current) {
    lastUrlRef.current = computedUrl;
  }
  const activeVideoUrl = lastUrlRef.current;
  if (state.callType === 'video' && activeVideoUrl) {
    return (
      <Animated.View
        style={[styles.videoCard, {transform: pan.getTranslateTransform()}]}
        {...panHandlers}>
        <TouchableOpacity activeOpacity={0.9} onPress={restore} style={StyleSheet.absoluteFill}>
          {/* Fix #21: key by activeTag so React preserves RTCView
              identity when the same participant continues to be the
              active speaker across renders. When the speaker changes
              we WANT a fresh RTCView (new track means new EGL
              surface), so the key flip is correct.
              B-455: no clip wrapper here either — see the 1:1 card above.
              The card's own overflow:'hidden' is the iOS clip, and on
              Android NO ancestor clip can reach a SurfaceView composited
              above the window. */}
          <RTCView
            key={activeTag ?? 'no-speaker'}
            streamURL={activeVideoUrl}
            style={StyleSheet.absoluteFill}
            objectFit="cover"
            mirror={false}
            zOrder={2}
          />
          <View style={styles.videoCardFooter}>
            <Text numberOfLines={1} style={styles.videoCardName} maxFontSizeMultiplier={1.1}>{activeName}</Text>
            <Text style={styles.videoCardTimer} maxFontSizeMultiplier={1.1}>{formatDuration(duration)}</Text>
          </View>
        </TouchableOpacity>
        <TouchableOpacity onPress={hangup} style={styles.videoCardHangup} hitSlop={{top:8, left:8, right:8, bottom:8}}>
          <Icon name="phone-hangup" size={14} color="#fff" />
        </TouchableOpacity>
      </Animated.View>
    );
  }

  // Audio path (or video before any tile is available) — slim bar
  // shows JUST the active speaker's name. Joining-phase fallback
  // shows the conversation name so the user knows what call this is.
  const titleText = state.state === 'joined'
    ? activeName
    : `${state.conversationName ?? 'Group call'} · joining…`;
  return (
    // Composed EXACTLY like the 1:1 bar above — same style, same `insets.top + 8`.
    // This lane serves group audio AND group video before any remote tile
    // exists, so it is the bar a joining group-video call shows first.
    <View style={[styles.audioBar, {paddingTop: insets.top + 8}]} pointerEvents="box-none">
      <TouchableOpacity activeOpacity={0.85} onPress={restore} style={styles.audioBarTap}>
        <View style={styles.audioBarDot} />
        <Text numberOfLines={1} style={styles.audioBarTitle}>{titleText}</Text>
        {state.state === 'joined' && (
          <Text style={styles.audioBarTimer}>{formatDuration(duration)}</Text>
        )}
      </TouchableOpacity>
      <TouchableOpacity onPress={hangup} style={styles.audioBarHangup} hitSlop={{top:8, left:8, right:8, bottom:8}}>
        <Icon name="phone-hangup" size={16} color="#fff" />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  // Audio bar — pinned to the top, full width, semi-translucent. The
  // outer wrapper uses `pointerEvents="box-none"` so it only catches
  // touches on its actual children (the tap area + hangup button) and
  // lets the rest of the screen receive touches.
  audioBar: {
    position:'absolute', top:0, left:0, right:0,
    flexDirection:'row', alignItems:'center',
    // paddingTop is applied at the call site from the live safe-area inset.
    paddingBottom:10, paddingHorizontal:16,
    backgroundColor:'rgba(16,185,129,0.96)',
    elevation:14, shadowColor:'#000', shadowOpacity:0.25, shadowRadius:6, shadowOffset:{width:0, height:2},
    zIndex:1000,
  },
  audioBarTap: {flex:1, flexDirection:'row', alignItems:'center', gap:10},
  audioBarDot: {width:8, height:8, borderRadius:4, backgroundColor:'#FFFFFF'},
  audioBarTitle: {flex:1, color:'#FFFFFF', fontSize:13, fontWeight:'700'},
  audioBarTimer: {color:'rgba(255,255,255,0.9)', fontSize:12, fontVariant:['tabular-nums']},
  audioBarHangup: {
    width:32, height:32, borderRadius:16, alignItems:'center', justifyContent:'center',
    backgroundColor:'rgba(0,0,0,0.25)', marginLeft:12,
  },

  // Video card — floating, draggable, top-right anchored.
  videoCard: {
    position:'absolute', top:60, right:14,
    width:120, height:170, borderRadius:16, overflow:'hidden',
    backgroundColor:'#0F172A',
    borderWidth:1.5, borderColor:'rgba(255,255,255,0.18)',
    elevation:18, shadowColor:'#000', shadowOpacity:0.45, shadowRadius:14, shadowOffset:{width:0, height:6},
    zIndex:1000,
  },
  videoCardPlaceholder: {alignItems:'center', justifyContent:'center', backgroundColor:'#1E293B'},
  videoCardFooter: {
    position:'absolute', bottom:0, left:0, right:0,
    paddingHorizontal:10, paddingVertical:8,
    backgroundColor:'rgba(0,0,0,0.55)',
    flexDirection:'row', justifyContent:'space-between', alignItems:'center', gap:8,
  },
  videoCardName:  {color:'#F1F5F9', fontSize:11, fontWeight:'700', flex:1, minWidth:0},
  videoCardTimer: {flexShrink:0, color:'rgba(255,255,255,0.9)', fontSize:10, fontVariant:['tabular-nums']},
  videoCardHangup: {
    position:'absolute', top:6, right:6,
    width:28, height:28, borderRadius:14, alignItems:'center', justifyContent:'center',
    backgroundColor:'#EF4444',
    elevation:6,
  },
});
