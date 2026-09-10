/**
 * IncomingGroupCallScreen — full-screen ring UI for inbound group calls.
 *
 * Mounted by the navigation root when the runtime receives a
 * `sfu.ring.incoming` frame. Plays the device default ringtone +
 * vibrates, shows the caller (group) name and an Accept / Decline pair.
 *
 *   Accept  → navigate to GroupCallScreen with direction='incoming' so
 *             useGroupCall joins the room without firing another ring.
 *   Decline → fire `sfu.ring.decline` so the host's UI can show the
 *             decline + close this screen.
 *
 * Subscribes to the same multi-listener ring dispatcher so it can
 * self-dismiss when the host cancels (`sfu.ring.cancelled`).
 */
import React, {useCallback, useEffect, useMemo, useRef} from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, StatusBar, Platform, Vibration,
  BackHandler,
} from 'react-native';
import {useFocusEffect} from '@react-navigation/native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import type {MessengerScreenProps} from '@navigation/types';
import {navigateToMessengerScreen} from '@navigation/messengerDeepLink';
import {setGroupCallRingHandler} from '@/modules/messenger/webrtc/groupCallRingDispatcher';
import {appendMissedGroupCallBubble} from '@/modules/messenger/webrtc/useGroupCall';
import {getLiveTransport} from '@/modules/messenger/runtime/transportRegistry';
import {useAuthStore} from '@store/authStore';
import {useMessengerStore} from '@/modules/messenger/store/messengerStore';
import {resolveMemberName} from '@/modules/messenger/runtime/groupEventMessage';
import {displayRoomName} from '@utils/missionRoomName';
import {useContentWidth} from '@utils/scaling';

type Props = MessengerScreenProps<'IncomingGroupCallScreen'>;

const C = {
  bg:    '#07090D',
  surf1: '#13182A',
  bd:    'rgba(255,255,255,0.14)',
  bd2:   'rgba(255,255,255,0.08)',
  tx1:   '#FFFFFF',
  tx2:   '#B8C7E0',
  tx3:   '#7E8AA6',
  ok:    '#00C853',
  err:   '#D5212B',
  glow:  '#5B8DEF',
};

const MONO = Platform.select({ios: 'Menlo', default: 'monospace'});

export default function IncomingGroupCallScreen({route, navigation}: Props) {
  const insets = useSafeAreaInsets();
  const {roomId, conversationId, callType, callerName, fromUserId, roomToken, autoAccept, ringId} = route.params;
  const ownDisplayName = useAuthStore(s => s.user?.full_name ?? s.user?.email ?? 'Me');
  // P1-BR-1 — a ring with no roomId is non-actionable: joining would POST
  // /sfu/rooms and mint a NEW empty room instead of the host's. Treat it as
  // an error (dismiss) and never let Accept navigate into the create path.
  const roomMissing = !roomId || roomId.trim() === '';

  // Tracks "we already accepted/declined" so dispatcher cancel callbacks
  // don't double-pop the navigator after we've already moved.
  const settledRef = useRef(false);
  // BS-RING-RACE — set when a cancel for THIS room arrives. If Accept loses a
  // same-tick race to the cancel, we route to the "Missed call" UX instead of
  // joining a room the host already destroyed.
  const cancelledRef = useRef(false);
  // Why: navigators can reuse this mounted screen for a NEW ring (new
  // route.params, same instance) — without the reset, the latched true
  // from the previous ring would silently swallow Accept/Decline.
  //
  // WI-3.5 — `cancelledRef` has to reset here too. It only ever latched TRUE,
  // so a cancel for ring #1 permanently poisoned ring #2: Accept took the
  // BS-RING-RACE branch below and wrote a missed-call bubble instead of
  // joining a room that was perfectly alive. Resetting `settledRef` alone
  // made that worse, not better — it re-opened the door and left the trap.
  // Round 2 (critic F4) — `ringId` IS a key: a same-room re-ring swaps params
  // with an UNCHANGED roomId, and ring #1's latched settle would swallow
  // ring #2's Accept exactly the way WI-3.5 describes.
  useEffect(() => {
    settledRef.current   = false;
    cancelledRef.current = false;
  }, [roomId, ringId]);
  // BB-1 (2026-08-15 back audit) — a cold ring is BY DESIGN this stack's ONLY
  // route (B-319: the ring navigations are deliberately flagless), so a bare
  // goBack() was a silent no-op: Decline sent its frame but left the user
  // trapped on the ring screen, with the hardware key swallowed by the
  // decline-and-return-true handler. Same canGoBack fallback the two sibling
  // call screens carry (CallScreen B-319, GroupCallScreen B-213). Every
  // dismissal on this screen funnels through here.
  const dismissRing = useCallback((): void => {
    // Review round 1 (P0 rider) — every NON-ACCEPT exit funnels through here
    // (decline, host cancel, roomMissing, the no-FrameCryptor bail, the 45 s
    // timeout), and each of them is terminal for this ring ATTEMPT. The
    // explicit-accept latch is a navigation input keyed by roomId (WI-4.6),
    // and group roomIds are reused across re-rings — an entry surviving a
    // failed Answer would auto-join the NEXT ring of this room with zero
    // interaction. accept() deliberately does not pass here, so an answered
    // ring keeps its latch for the offer-replay re-assert.
    try {
      const fb = require('@/modules/messenger/push/fcmBootstrap') as typeof import('@/modules/messenger/push/fcmBootstrap');
      fb.notifyCallEnded(roomId);
    } catch { /* push layer not booted — the 5-min scrub bounds the latch */ }
    /**
     * B-595 — AND END THE TELECOM CONNECTION HERE, in the funnel.
     *
     * The first draft put this in the decline CALLBACK, one level above — so
     * four of the five non-accept exits (the 45 s timeout, the WS host-cancel,
     * `roomMissing`, and the FrameCryptor bail) still stranded RNCallKeep's
     * ongoing "call in progress" notification. This comment block already says
     * every non-accept exit funnels through here; the cleanup belongs where
     * that is true.
     *
     * Android-gated inside the helper (a roomId is not a formatted UUID, and
     * iOS turns that into a nil NSUUID inside a native call this try cannot
     * catch). accept() deliberately does not pass through here, so an answered
     * ring keeps its connection for the live call.
     */
    try {
      const {clearGroupCallArtifacts} =
        require('@/modules/messenger/runtime/groupCallRegistry') as typeof import('@/modules/messenger/runtime/groupCallRegistry');
      clearGroupCallArtifacts(roomId);
    } catch { /* registry unavailable */ }
    try {
      const nav = navigation as unknown as {goBack: () => void; canGoBack?: () => boolean};
      if (nav.canGoBack === undefined || nav.canGoBack()) {
        nav.goBack();
      } else {
        const {navigationRef} = require('@/navigation/navigationRef') as typeof import('@/navigation/navigationRef');
        navigateToMessengerScreen(navigationRef as never, 'MessengerHome', {});
      }
    } catch { /* already gone */ }
  }, [navigation, roomId]);
  // AC-6 (B-306 rider) — the one release-visible proof this screen ever
  // surfaced. Its absence from a device log is what cost the 2026-07-27
  // session an afternoon of inference: every other trace on the ring path
  // was a stripped console.log.
  useEffect(() => {
    console.warn('[CALLDIAG] [ring.screen] mounted room=', roomId.slice(0, 8));
    return () => { console.warn('[CALLDIAG] [ring.screen] unmounted room=', roomId.slice(0, 8)); };
  }, [roomId]);

  // Ringtone + vibration. Same path as 1:1 incoming — Bravo-shipped
  // WAV asset via expo-av; InCallManager's '_DEFAULT_' path is broken
  // on Android 14+ Pixels (see runtime/bravoTones.ts).
  // Fix #39: defer the vibrate kick by 50 ms via setTimeout so a
  // user who taps Accept the moment the screen appears (a real
  // pattern when the screen comes up while the phone is in their
  // hand) can have their accept-handler's Vibration.cancel() pre-empt
  // the start. Without the defer, Vibration.vibrate(...) lands inside
  // the same JS tick as the ring screen mount and the OS queues the
  // pattern before the cancel can race in. Result: the phone keeps
  // buzzing for the full 800ms after the user already saw the
  // GroupCallScreen mount.
  useEffect(() => {
    // P1-BR-2 (group) — answered from the notification: skip the ring
    // (no sound / vibration); the auto-join effect below routes straight
    // into the call. Also skip entirely when the ring is non-actionable.
    if (autoAccept || roomMissing) {return;}

    const tones = require('@/modules/messenger/runtime/bravoTones') as typeof import('@/modules/messenger/runtime/bravoTones');
    const ring  = require('@/modules/messenger/push/incomingRingtone') as typeof import('@/modules/messenger/push/incomingRingtone');
    // Why: the group voip-wake rings natively under the roomId (the gateway
    // reuses it as the callId), so an in-app tone here would double it (NA-06).
    let vibTimer: ReturnType<typeof setTimeout> | null = null;
    const unbindRing = ring.bindInAppRingOwnership(roomId, owns => {
      if (owns) {
        void tones.startRingtone();
        vibTimer = setTimeout(() => { Vibration.vibrate([0, 800, 1200, 800], true); }, 50);
      } else {
        if (vibTimer) { clearTimeout(vibTimer); vibTimer = null; }
        void tones.stopRingtone();
        Vibration.cancel();
      }
    });
    return () => {
      if (vibTimer) { clearTimeout(vibTimer); }
      unbindRing();
      void tones.stopRingtone();
      Vibration.cancel();
    };
    // B-480 — re-keyed per ring, which is only safe now that the tone slot is.
    //
    // A navigator can hand this mounted instance a NEW ring by swapping
    // route.params. Under `[]` deps the NA-06 ownership binding stayed bound to
    // ring #1's roomId, so the native-ring hand-off was evaluated for the wrong
    // room on ring #2 — and the `autoAccept || roomMissing` early return above
    // was evaluated once per screen INSTANCE, so a ring following an
    // auto-accepted one got no tone at all.
    //
    // WI-3.5 tried this first and had to revert it: React runs this cleanup
    // before the re-run, `stopRingtone()` set the tone slot to 'stopping'
    // synchronously, and the re-run's `bindInAppRingOwnership` calls
    // `startRingtone()` synchronously inside bind — which the slot refused
    // because it was not 'idle'. Ring #2 vibrated in silence. `bravoTones` now
    // QUEUES a start that arrives mid-teardown and drains it once the slot is
    // idle, so the stop→start-in-one-tick pattern this creates is handled at
    // the source. Do not re-key this without that queue in place.
    //
    // `conversationId` / `callType` are deliberately not deps: they change WITH
    // `roomId` for a genuinely new ring, and listing them would restart the
    // ringtone on an unrelated re-render of the same one.

  }, [roomId, autoAccept, roomMissing]);

  // WI-3.5 — the 45 s fallback, re-armed PER RING.
  //
  // The screen normally self-dismisses on the host's `sfu.ring.cancel`. If
  // that frame is lost (host crash, dropped socket, never answered) this is
  // what stops the ring screen trapping the user.
  //
  // It has to be keyed on `roomId` because a navigator can hand this mounted
  // instance a NEW ring by swapping route.params. Under `[]` deps the cleanup
  // held the only `clearTimeout`, so it ran on unmount alone: ring #1's timer
  // survived into ring #2 and fired holding ring #1's `conversationId` and
  // `dismissRing` — writing a missed-call bubble into the WRONG conversation,
  // latching `settledRef` so ring #2's Accept was swallowed, and popping a
  // ring the user was looking at. Ring #2 meanwhile had no fallback at all.
  //
  // `conversationId` / `callType` are deliberately not deps: they change WITH
  // `roomId` for a genuinely new ring, and listing them would re-arm the 45 s
  // clock on an unrelated re-render of the same one.
  useEffect(() => {
    if (autoAccept || roomMissing) {return;}
    const ringTimeout = setTimeout(() => {
      if (settledRef.current) {return;}
      settledRef.current = true;
      try { appendMissedGroupCallBubble({conversationId, callType}); } catch { /* best-effort */ }
      dismissRing();
    }, 45000);
    return () => { clearTimeout(ringTimeout); };
    // Round 2 (critic F4) — keyed on ringId too: a same-room re-ring must get
    // its OWN 45 s clock, not inherit the remainder of ring #1's (which would
    // dismiss a live ring and write a missed bubble while the user looks at it).
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-armed per ring; see above
  }, [roomId, ringId]);

  // Listen for cancel/decline frames from the dispatcher. If the caller
  // cancels (room destroyed) or all participants leave, self-dismiss.
  useEffect(() => {
    const unsub = setGroupCallRingHandler({
      onIncoming: () => { /* root navigator handles this */ },
      onCancel:   (data) => {
        if (data.roomId !== roomId) {return;}
        // WI-6.7 — ring identity: when BOTH sides name their fan-out and they
        // differ, this cancel is for an OLDER ring of the same room — the ring
        // on screen is newer and must survive. Either side lacking a ringId
        // falls back to the historical roomId-wide dismiss.
        if (data.ringId && ringId && data.ringId !== ringId) {return;}
        cancelledRef.current = true;
        if (settledRef.current) {return;}
        settledRef.current = true;
        // B-12 — the host cancelled the ring before we accepted (abandoned
        // the call). Drop a "Missed group call" entry into the chat so the
        // ring doesn't just silently vanish with no record (WhatsApp UX).
        try {
          appendMissedGroupCallBubble({conversationId, callType});
        } catch { /* best-effort — never block dismissal */ }
        dismissRing();
      },
      onDecline:  () => { /* not relevant on the recipient side */ },
    });
    return unsub;
    // WI-6.7 — `ringId` IS a dep: ring #2 for the SAME room swaps params with
    // an unchanged roomId, and a closure holding ring #1's ringId would
    // ignore ring #2's own legitimate cancel.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handler is (re)bound per ring; conversationId/callType are read only inside the one-shot cancel branch
  }, [roomId, ringId, navigation]);

  // Recipient member-id list for the join — re-derived from the local
  // conversation so the joiner can also rebroadcast its presence
  // envelope to others on join. Falls back to just the caller if we
  // somehow don't have the conversation locally yet.
  // Fix #38: use Zustand selectors so the list re-renders if the
  // conversation hydrates AFTER this screen mounts (cold-boot ringing
  // race: the push wakes the app, the screen mounts before the
  // conversations slice has finished restoring from disk → the
  // previous getState() snapshot returned `[fromUserId]` only and
  // the joiner's presence envelope under-counted the room).
  const ownId        = useAuthStore(s => s.user?.id);
  const convoForRoom = useMessengerStore(s => s.conversations[conversationId]);
  const recipientUserIds = (convoForRoom?.participants ?? [fromUserId])
    .filter(p => p && p !== 'self' && p !== ownId);

  // B-226 — show the host's human NAME, not a raw id fragment. Subscribe to the
  // two name maps so a late directory/roster backfill re-renders this label;
  // resolveMemberName fires that backfill on a miss and applies the app-wide
  // B-115 precedence (group override > direct name > directory > phone > code).
  const hostNameSignal = useMessengerStore(
    s => s.groupMemberNames[conversationId]?.[fromUserId] ?? s.directoryNames[fromUserId] ?? '',
  );
  const hostName = useMemo(
    () => resolveMemberName(fromUserId, ownId, conversationId),
    // hostNameSignal is a reactivity TRIGGER, not a value input: it forces a
    // re-resolve through the canonical chain when a late directory/roster
    // backfill lands. Intentional — exhaustive-deps sees it as unused.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fromUserId, ownId, conversationId, hostNameSignal],
  );

  const accept = (): void => {
    if (settledRef.current) {return;}
    // B-111-A — this build cannot run E2EE group calls (no FrameCryptor —
    // iOS until B-111-B). Mirror the roomMissing dismissal: honest alert +
    // missed-call record, never a join→S6-refuse roster ghost. The host
    // sees this member as unanswered.
    try {
      const {frameCryptorOrchestratorAvailable} = require('@/modules/messenger/webrtc/frameCryptorOrchestrator') as typeof import('@/modules/messenger/webrtc/frameCryptorOrchestrator');
      if (!frameCryptorOrchestratorAvailable()) {
        settledRef.current = true;
        const {Alert} = require('@utils/alert') as typeof import('@utils/alert');
        Alert.alert(
          'Group calls not available yet',
          'Group calls are not supported on this device yet — one-to-one calls work normally.',
        );
        try { appendMissedGroupCallBubble({conversationId, callType}); } catch { /* best-effort */ }
        dismissRing();
        return;
      }
    } catch { /* probe unavailable — proceed as before */ }
    // P1-BR-1 — never navigate into GroupCallScreen without a roomId: that
    // path would create a brand-new empty room. A ring this broken is an
    // error — dismiss (a "Missed group call" record is written by the
    // roomMissing effect on mount) rather than joining nothing.
    if (roomMissing) {
      settledRef.current = true;
      dismissRing();
      return;
    }
    settledRef.current = true;
    // BS-RING-RACE — a cancel for this room already arrived in the same tick
    // (host cancelled the instant we tapped Accept). Don't join a destroyed
    // room; route to the missed-call UX the cancel path would have produced.
    if (cancelledRef.current) {
      try { appendMissedGroupCallBubble({conversationId, callType}); } catch { /* best-effort */ }
      dismissRing();
      return;
    }
    // WI-4.5 — the answer consumes the ring: dismiss the notification card
    // and stop the NATIVE ringtone (the notifee id and the native ring are
    // both keyed by roomId — the gateway reuses it as the callId). Without
    // this, a ring that arrived via the FCM lane kept its card + looping
    // ringtone through the whole call, until the 45 s timeout. The payload is
    // deliberately NOT cleared: an answered call keeps it (1:1 rule), and a
    // tombstone here would mark the call we are joining as dead.
    try {
      const {dismissCallNotif} = require('@/modules/messenger/push/callNotification') as typeof import('@/modules/messenger/push/callNotification');
      void dismissCallNotif(roomId);
    } catch { /* notifee unavailable — the 45 s timeout still bounds it */ }
    // Pop the ring screen and replace with the group call. Using
    // `replace` (via goBack + navigate) avoids leaving the ring screen
    // in the back-stack so swiping back doesn't re-mount it after the
    // call ends.
    navigation.replace('GroupCallScreen', {
      conversationId,
      callType,
      direction:        'incoming',
      roomId,
      recipientUserIds,
      callerName,
      // BS-CALL-ADHOC — the ringer is the call host/owner. The joiner
      // looks up the ad-hoc call master key under `direct:<host>` (where
      // the host filed it), so thread the host id through.
      hostUserId:       fromUserId,
      // Audit row #5 — server requires this token in sfu.join when
      // SFU_ROOM_TOKEN_SECRET is set. Carried from the ring frame.
      roomToken,
    });
  };

  // P1-BR-1 — a ring that arrived with no roomId can't be joined. Record a
  // "Missed group call" (so it isn't a silent void) and dismiss rather than
  // presenting an Accept that would spin up a wrong room.
  useEffect(() => {
    if (!roomMissing) {return;}
    if (settledRef.current) {return;}
    settledRef.current = true;
    console.warn('[bravo.groupring] incoming group ring missing roomId — dismissing (P1-BR-1)');
    try { appendMissedGroupCallBubble({conversationId, callType}); } catch { /* best-effort */ }
    dismissRing();
    // WI-3.5 — `roomId` is a dep for the same param-reuse reason as the ring
    // effect: a second ring that is ALSO roomless leaves `roomMissing` true
    // across the swap, so this would never re-fire and the new ring would sit
    // on screen with an Accept that cannot work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomMissing, roomId]);

  // P1-BR-2 (group) — the user answered the ring from the notification.
  // Join the room directly instead of waiting on the on-screen Accept.
  // Guarded by settledRef (shared with manual accept/decline) so it fires
  // at most once, and skipped when the ring is non-actionable.
  useEffect(() => {
    if (!autoAccept || roomMissing) {return;}
    if (settledRef.current) {return;}
    console.log('[bravo.groupring] autoAccept — joining group call from notification');
    accept();
    // WI-3.5 — `roomId` too. Two notification-answered rings in a row keep
    // `autoAccept` true across the param swap, so without it the second ring
    // never auto-joined: the user tapped Answer and landed on a ring screen
    // that just sat there.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAccept, roomMissing, roomId]);

  const decline = useCallback((): void => {
    if (settledRef.current) {return;}
    settledRef.current = true;
    // Best-effort decline frame so the host's UI updates. We use
    // emitWithAck because it accepts arbitrary event names — the typed
    // ClientFrame union doesn't include sfu.* frames (they're sent
    // ad-hoc through the same socket). Failure is not fatal — the
    // host's room continues without us either way.
    try {
      const ws = getLiveTransport();
      if (ws) {
        // Audit row #5 (C2) — echo the per-recipient roomToken so the
        // gateway can verify we were actually ringed. Without it any
        // authed user could fake-decline rings they never received,
        // leaking who-is-in-which-call inferences via response timing.
        void ws.emitWithAck('sfu.ring.decline', {roomId, conversationId, roomToken})
          .catch(() => { /* socket not open or server not reachable */ });
      }
    } catch { /* ignore */ }
    // WI-4.5 — a decline is terminal for this ring: clear the card + native
    // ringtone and tombstone the payload, exactly what the notifee Decline
    // lane already does (fcmBootstrap's decline branch). Without it, an
    // FCM-lane ring declined ON SCREEN left its card up and its payload
    // alive — where a later Telecom End would convert it into a second
    // decline, and a queued Accept could resurrect it.
    try {
      const {dismissCallNotif} = require('@/modules/messenger/push/callNotification') as typeof import('@/modules/messenger/push/callNotification');
      void dismissCallNotif(roomId);
    } catch { /* notifee unavailable */ }
    try {
      const {clearIncomingCallPayload} = require('@/modules/messenger/push/incomingCallCache') as typeof import('@/modules/messenger/push/incomingCallCache');
      clearIncomingCallPayload(roomId);
    } catch { /* cache unavailable */ }
    // (The Telecom end now lives in `dismissRing` below — the funnel every
     // non-accept exit passes through, not just this one. B-595.)
    dismissRing();
  }, [roomId, conversationId, roomToken, dismissRing]);

  // Round 7 / back-button audit fix #6 — hardware back must fire the
  // same `sfu.ring.decline` frame as the on-screen Decline button.
  // Without this, hitting back silently dismisses the ring screen but
  // never tells the host — the caller's UI keeps "ringing" until the
  // 30s server-side timeout fires.
  useFocusEffect(
    useCallback(() => {
      const onBack = () => {
        decline();
        return true;
      };
      const sub = BackHandler.addEventListener('hardwareBackPress', onBack);
      return () => sub.remove();
    }, [decline]),
  );

  // Foldable: useContentWidth is driven by useWindowDimensions, so unfolding
  // re-measures. 420 keeps the name a readable column on a tablet/unfolded
  // inner screen instead of one very long line.
  const {contentMaxWidth} = useContentWidth(420);
  const roomTitle = displayRoomName(callerName) || 'Group';
  const initials = roomTitle.slice(0, 2).toUpperCase();

  return (
    <View style={[s.root, {paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24}]}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />

      {/* Header */}
      <View style={s.headerWrap}>
        <Text style={s.kicker}>{callType === 'video' ? 'INCOMING VIDEO CALL' : 'INCOMING VOICE CALL'}</Text>
        <Text style={s.subkicker}>Group · {recipientUserIds.length + 1} members</Text>
      </View>

      {/* Avatar + name */}
      <View style={s.heroWrap}>
        <View style={s.avatarOuter}>
          <View style={s.avatarInner}>
            <Text style={s.avatarTxt}>{initials}</Text>
          </View>
        </View>
        <Text
          style={[s.callerName, {maxWidth: contentMaxWidth}]}
          numberOfLines={3}
          ellipsizeMode="tail">
          {roomTitle}
        </Text>
        <Text style={s.callerSub}>{`From ${hostName}`}</Text>
        <Text style={s.youAre}>{`You are signed in as ${ownDisplayName}`}</Text>
      </View>

      {/* Action row */}
      <View style={s.actions}>
        <View style={s.actionCol}>
          <TouchableOpacity style={[s.fab, s.fabDecline]} onPress={decline} activeOpacity={0.85}>
            <Icon name="phone-hangup" size={28} color="#FFF" />
          </TouchableOpacity>
          <Text style={s.actionLbl}>DECLINE</Text>
        </View>
        <View style={s.actionCol}>
          <TouchableOpacity style={[s.fab, s.fabAccept]} onPress={accept} activeOpacity={0.85}>
            <Icon name={callType === 'video' ? 'video' : 'phone'} size={28} color="#FFF" />
          </TouchableOpacity>
          <Text style={s.actionLbl}>ACCEPT</Text>
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: {flex: 1, backgroundColor: C.bg, justifyContent: 'space-between'},

  headerWrap: {alignItems: 'center', gap: 6, paddingHorizontal: 24},
  kicker:    {color: C.tx1, fontSize: 12, fontWeight: '800', letterSpacing: 2.5, fontFamily: MONO},
  subkicker: {color: C.tx3, fontSize: 11, fontWeight: '500'},

  heroWrap: {alignItems: 'center', gap: 12, paddingHorizontal: 24},
  avatarOuter: {
    width: 156, height: 156, borderRadius: 78,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: C.glow,
    backgroundColor: 'rgba(91,141,239,0.12)',
    shadowColor: C.glow, shadowOpacity: 0.55, shadowRadius: 22, shadowOffset: {width: 0, height: 0}, elevation: 10,
  },
  avatarInner: {
    width: 132, height: 132, borderRadius: 66,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: C.surf1, borderWidth: 1, borderColor: C.bd,
  },
  avatarTxt:  {color: C.tx1, fontSize: 38, fontWeight: '800', letterSpacing: 1.6, fontFamily: MONO},
  // A mission room name wraps to two lines. Without textAlign the wrapped
  // lines render left-ragged inside a centre-aligned column, which is what
  // the founder photographed - every neighbouring line looked centred
  // because each happened to fit on ONE line.
  callerName: {
    color: C.tx1, fontSize: 22, fontWeight: '800', marginTop: 16,
    textAlign: 'center', lineHeight: 28,
  },
  callerSub:  {color: C.tx2, fontSize: 12, textAlign: 'center'},
  youAre:     {color: C.tx3, fontSize: 11, marginTop: 6, fontStyle: 'italic', textAlign: 'center'},

  actions: {flexDirection: 'row', justifyContent: 'space-evenly', paddingHorizontal: 24, gap: 24},
  actionCol: {alignItems: 'center', gap: 10},
  fab: {
    width: 76, height: 76, borderRadius: 38,
    alignItems: 'center', justifyContent: 'center',
    elevation: 8, shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 12, shadowOffset: {width: 0, height: 6},
  },
  fabAccept:  {backgroundColor: C.ok},
  fabDecline: {backgroundColor: C.err},
  actionLbl:  {color: C.tx2, fontSize: 11, fontWeight: '800', letterSpacing: 1.5, fontFamily: MONO},
});
