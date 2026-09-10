/**
 * FCM token bootstrap.
 *
 * Called once after the user authenticates. Responsibilities:
 *
 *   1. Request the runtime POST_NOTIFICATIONS permission (Android 13+).
 *   2. Acquire the FCM registration token via @react-native-firebase/messaging.
 *   3. POST it to messenger-service `/push/register-voip` so the gateway can
 *      fan VoIP wake-ups to it when a 1:1 `call.offer` or group `sfu.ring`
 *      arrives for an offline callee.
 *   4. Subscribe to onTokenRefresh and re-register if FCM rotates the token.
 *
 * iOS path is stubbed for now — VoIP on iOS needs PushKit (a separate
 * token type) which requires the `@react-native-voip-push-notification`
 * native module + Apple PushKit cert. Android FCM works with the same
 * react-native-firebase module already linked.
 *
 * The push payload itself carries ONLY a wake hint (`{wake: true, callId}`)
 * — never the SDP, never message content. Keeps with the spec invariant
 * documented in messenger-service `push.service.ts`.
 */
import {Platform, PermissionsAndroid} from 'react-native';
import messaging from '@react-native-firebase/messaging';
import {fetchWithTimeout} from '@bravo/messenger-core/transport/fetchWithTimeout';
import {MSG_BASE_URL} from '@utils/constants';
import {navigateToMessengerScreen, deptThreadEntersWorkspaceSurface} from '@navigation/messengerDeepLink';
import {tokenVault} from '@services/tokenVault';
// WI-4.8 — the cold-launch nav wait, shared across all four polling sites
// (Telecom answer, notifee answer, msg-wake tap, missed-call tap). Tier A.
import {NAV_READY_WAIT_MS, TURN_FETCH_CEILING_MS} from '../webrtc/callDeadlines';
import {flushAcksBounded} from './flushAcksBounded';

let unsubTokenRefresh: (() => void) | null = null;
let unsubOnMessage: (() => void) | null = null;
let started = false;

// NA-03 — getToken() has no abort hook and blocks on FCM's own network
// registration, so a dribbling link stalls it without bound. Race it, and bound
// the two POSTs (PUSH_REGISTER_TIMEOUT_MS). A miss is not fatal: serverRegistered
// stays false and ensurePushRegistered re-asserts on the next WS `connected`.
async function doRegisterPushTokens(): Promise<void> {
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const token = await Promise.race<string | null>([
      messaging().getToken(),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), GET_TOKEN_TIMEOUT_MS); }),
    ]).finally(() => { if (timer) {clearTimeout(timer);} });
    if (!token) {
      console.warn('[fcm] getToken empty or timed out — will retry on next WS connect');
      return;
    }
    console.log('[fcm] getToken ok, len =', token.length, 'prefix =', token.slice(0, 10) + '…');
    // Register against BOTH endpoints. /register-voip wakes the device for
    // incoming calls; /register is for chat-message wakes. They share the same
    // FCM token but live in different Redis keyspaces on the server so we can
    // lifecycle them independently.
    const results = await Promise.all([
      registerDataToken(token).then(() => true).catch(e => { console.warn('[fcm] register-data failed:', (e as Error).message); return false; }),
      registerVoipToken(token).then(() => true).catch(e => { console.warn('[fcm] register-voip failed:', (e as Error).message); return false; }),
    ]);
    // Both must succeed to flip the gate — partial success would leave either
    // chat-wake or call-wake broken.
    if (results.every(Boolean)) {
      serverRegistered = true;
      console.log('[fcm] server-register OK (both endpoints)');
    } else {
      console.warn('[fcm] server-register PARTIAL — next attempt will retry');
    }
  } catch (e) {
    console.warn('[fcm] push register failed:', (e as Error).message);
  }
}

let registerInFlight: Promise<void> | null = null;
async function registerPushTokens(): Promise<void> {
  // Why: bootstrap now fires this without awaiting, so a re-login or a WS
  // `connected` landing mid-flight must join the existing attempt instead of
  // firing a second pair of POSTs.
  if (registerInFlight) {return registerInFlight;}
  registerInFlight = doRegisterPushTokens();
  try {
    await registerInFlight;
  } finally {
    registerInFlight = null;
  }
}
// Why: a first-time bootstrap can succeed at the framework level (permission
// + getToken + onTokenRefresh wired) but the SERVER-SIDE push register can
// still fail silently (no JWT yet OR 401). Without re-attempting the
// server register on each user-id change, the recipient stays invisible
// to push.chat.sendChatWake forever — sender sees "delivered" via WS but
// receiver gets no notification banner. This flag tracks whether we've
// successfully posted to BOTH /push/register and /push/register-voip;
// subsequent startFcmBootstrap calls re-attempt registration when it's
// still false even if the framework bootstrap already ran.
let serverRegistered = false;

// B-48 — reconnect self-heal. The server can delete this device's token
// rows while the app runs or sits killed (dead-token GC after an FCM
// `not-registered`, logout tombstone from an account switch on another
// device) — and `serverRegistered=true` would mask it forever, since the
// only other re-register triggers are app start and FCM token rotation.
// Called from the messenger runtime on every WS `connected`, this
// unconditionally re-asserts BOTH /push/register* rows (idempotent POSTs),
// throttled so socket flaps don't spam the server.
let lastEnsureRegisteredAt = 0;
const ENSURE_REGISTER_MIN_INTERVAL_MS = 60_000;
// NA-03 — /push/register* is a tiny JSON POST; 10 s is generous on any working
// link and an abort self-heals (ensurePushRegistered re-asserts both rows on
// every WS `connected`). TRANSPORT_TIMEOUT_MS (20 s) is deliberately not reused:
// this runs on the boot path where latency is user-visible.
const PUSH_REGISTER_TIMEOUT_MS = 10_000;
const GET_TOKEN_TIMEOUT_MS = 10_000;
// B-412 [NOTIFHEALTH] — read-only snapshot for the boot health probe: has the
// server confirmed BOTH /push/register* rows this session, and how long ago
// was the last re-assert attempt.
export function getPushRegisterHealth(): {registered: boolean; lastAssertAgoMs: number | null} {
  return {
    registered: serverRegistered,
    lastAssertAgoMs: lastEnsureRegisteredAt ? Date.now() - lastEnsureRegisteredAt : null,
  };
}

export async function ensurePushRegistered(): Promise<void> {
  // Bootstrap hasn't run yet (pre-login or MainNavigator not mounted) —
  // startFcmBootstrap will do the full register imminently.
  if (!started) {return;}
  // P1-9 / P1-BR-3 — this runs on every WS `connected`, so it's our "on first
  // connect" hook to flush deferred killed-app actions (queued replies / reads /
  // declines). Fire-and-forget; drainPendingActions has its own in-flight guard.
  void drainPendingActions();
  const now = Date.now();
  if (now - lastEnsureRegisteredAt < ENSURE_REGISTER_MIN_INTERVAL_MS) {return;}
  lastEnsureRegisteredAt = now;
  await registerPushTokens();
}

// P1-9 / P1-BR-3 — drain the durable queue of actions taken from a notification
// while the process was killed (inline Reply, Mark-as-read, call Decline). The
// slim bundle-entry handler persists them; here (runtime ready / WS connected) we
// dispatch: replies + reads via the runtime outbox, declines via the server
// endpoint. Entries are removed ONLY on success, so a transient failure retries
// on the next connect (the queue self-sweeps entries older than 7 days).
let draining = false;

/**
 * B-363 — WhatsApp-parity dispatch for a KILLED-app notification action. The
 * slim bundle-entry handler used to only enqueue and tell the user "Reply will
 * send when you open Bravo" — founder-rejected ("that not the correct way, it
 * should be like whatsapp"). The killed VM can do the whole job: the msg-wake
 * drain already boots the runtime + connects there (headlessDrainAndNotify),
 * and the 1:1/group send ships over HTTP relay, so no WS wait is needed for
 * the reply itself; read receipts queue durably and flush the moment the bg
 * socket connects inside this same VM.
 *
 * Returns true when every queued reply/read dispatched (queue empty of them) —
 * the caller then skips the "will send later" banner. All
 * configureRuntimeFromPersisted safety gates (restore mode, missing db key,
 * missing persisted config) stay in force: any bail → false → the durable
 * queue + banner fallback behave exactly as before.
 */
export async function headlessDispatchNotifActions(): Promise<boolean> {
  try {
    const {configureRuntimeFromPersisted} = require('./headlessDrain') as typeof import('./headlessDrain');
    if (!(await configureRuntimeFromPersisted())) {return false;}
    const {getMessengerRuntime} = require('@/modules/messenger/runtime') as typeof import('@/modules/messenger/runtime');
    await getMessengerRuntime('production');
    await drainPendingActions();
    // markRead queues its receipts when the socket has not finished the
    // handshake yet; they auto-flush on the transport's `connected` event.
    // Hold this VM open (bounded) until that happens so the sender's blue
    // tick does not wait for the next app open. On timeout the receipts stay
    // in the AsyncStorage-mirrored queue — durable, just later.
    try {
      const reg = require('@/modules/messenger/runtime/transportRegistry') as typeof import('@/modules/messenger/runtime/transportRegistry');
      if ((reg.getLiveTransport() as {state?: string} | null)?.state !== 'connected') {
        await new Promise<void>(resolve => {
          const done = setTimeout(() => { clearInterval(iv); resolve(); }, 8000);
          const iv = setInterval(() => {
            if ((reg.getLiveTransport() as {state?: string} | null)?.state === 'connected') {
              clearTimeout(done); clearInterval(iv); resolve();
            }
          }, 250);
        });
        await new Promise(r => setTimeout(r, 500));
      }
    } catch { /* receipts stay durably queued */ }
    let owner: string | undefined;
    try {
      const {useAuthStore} = require('@/store/authStore') as typeof import('@/store/authStore');
      owner = useAuthStore.getState().user?.id || undefined;
    } catch { owner = undefined; }
    const {loadPendingActions} = require('./pendingActions') as typeof import('./pendingActions');
    const left = await loadPendingActions(owner);
    return !left.some(e => e.t === 'reply' || e.t === 'read');
  } catch (e) {
    console.warn('[fcm] headless notif-action dispatch failed:', (e as Error).message);
    return false;
  }
}
async function drainPendingActions(): Promise<void> {
  if (draining) {return;}
  draining = true;
  try {
    let owner: string | undefined;
    try {
      const {useAuthStore} = require('@/store/authStore') as typeof import('@/store/authStore');
      owner = useAuthStore.getState().user?.id || undefined;
    } catch { owner = undefined; }
    const {loadPendingActions, removePendingAction, sendCallDecline} = require('./pendingActions') as typeof import('./pendingActions');
    const entries = await loadPendingActions(owner);
    if (!entries.length) {return;}
    // B-361 — replies/reads dispatch AGAINST THE STORE (group detection, peer
    // resolution, markRead's envelope collection), and this drain fires on WS
    // `connected`, which can beat zustand-persist hydration on a cold boot.
    // Pre-hydration the group path fell through to 1:1 and threw "production
    // mode requires explicit peer address" on every retry (Redmi, 2026-08-01),
    // and markRead receipted nothing. Bounded so a storage stall cannot wedge
    // the drain forever.
    const hasReplyOrRead = entries.some(e => e.t === 'reply' || e.t === 'read');
    if (hasReplyOrRead) {
      try {
        const {useMessengerStore} = require('@/modules/messenger/store/messengerStore') as
          typeof import('@/modules/messenger/store/messengerStore');
        const p = (useMessengerStore as unknown as {
          persist?: {hasHydrated?: () => boolean; onFinishHydration?: (cb: () => void) => () => void};
        }).persist;
        if (p?.hasHydrated && !p.hasHydrated()) {
          await new Promise<void>(resolve => {
            const timer = setTimeout(resolve, 3000);
            const unsub = p.onFinishHydration?.(() => { clearTimeout(timer); unsub?.(); resolve(); });
            if (!unsub) { clearTimeout(timer); resolve(); }
          });
        }
      } catch { /* store unavailable — dispatch attempts below still guard */ }
    }
    let rt: {
      sendText?: (c: string, t: string, o?: {isGroup?: boolean; peer?: {userId: string; deviceId: number}; stableMsgId?: string}) => Promise<void>;
      markRead?: (c: string) => void;
    } | null = null;
    const getRt = async () => {
      if (!rt) {
        const {getMessengerRuntime} = require('@/modules/messenger/runtime') as typeof import('@/modules/messenger/runtime');
        rt = (await getMessengerRuntime('production')) as unknown as typeof rt;
      }
      return rt!;
    };
    // Group-or-1:1 for a conversation the live store may not know yet: fall
    // back to the persisted owner slice (same source the banner composer uses).
    const resolveIsGroup = async (convId: string): Promise<boolean | undefined> => {
      try {
        const {useMessengerStore} = require('@/modules/messenger/store/messengerStore') as
          typeof import('@/modules/messenger/store/messengerStore');
        const conv = useMessengerStore.getState().conversations[convId];
        if (conv) {return conv.type === 'group' || conv.type === 'ops_channel';}
      } catch { /* fall through */ }
      try {
        const {resolveConversationMeta} = require('./mutedLookup') as typeof import('./mutedLookup');
        const meta = await resolveConversationMeta(convId);
        if (meta) {return meta.isGroup;}
      } catch { /* unknown */ }
      return undefined;
    };
    for (const e of entries) {
      let ok = false;
      try {
        if (e.t === 'decline') {
          ok = await sendCallDecline({callId: e.callId, peerUserId: e.peerUserId, kind: e.kind, roomId: e.roomId});
        } else if (e.t === 'reply') {
          const r = await getRt();
          const isGroup = await resolveIsGroup(e.convId);
          // sendText enqueues to the durable outbox; resolving == accepted for
          // send. stableMsgId = the entry id, so a retried entry reuses its one
          // bubble instead of stacking a new failed copy per attempt (B-361).
          // isGroup===undefined (conversation unknown even to the persisted
          // slice): pass NEITHER hint — a group reply forced down the 1:1 path
          // would land as a private DM to the sender. Let sendText resolve or
          // throw; the entry stays queued and retries once state syncs.
          await r.sendText?.(e.convId, e.text, {
            ...(isGroup !== undefined ? {isGroup} : {}),
            ...(isGroup === false && e.peerUserId ? {peer: {userId: e.peerUserId, deviceId: 1}} : {}),
            stableMsgId: `notifreply-${e.id}`,
          });
          r.markRead?.(e.convId);
          ok = true;
        } else if (e.t === 'read') {
          const r = await getRt();
          r.markRead?.(e.convId);
          ok = true;
        }
      } catch (err) {
        console.warn('[fcm] pending-action dispatch failed:', (err as Error).message);
        ok = false;
      }
      if (ok) { await removePendingAction(e); }
    }
  } catch (e) {
    console.warn('[fcm] drainPendingActions failed:', (e as Error).message);
  } finally {
    draining = false;
  }
}

/**
 * OR-3 — iOS message banners are drawn by APNs (`aps.alert`, see
 * push.service.sendChatWake) because a force-quit iOS app never runs JS. An
 * alert with no UNUserNotificationCenter authorization is dropped by the OS, so
 * this prompt is load-bearing for the whole iOS lane. It no longer competes with
 * PushKit: `voipPush.startVoipPushBootstrap` registers the VoIP token without a
 * runtime prompt, which is why the old "would mis-train the user" skip was safe
 * to remove. Idempotent — iOS shows the sheet once and afterwards resolves with
 * the standing status.
 */
export async function requestIosNotificationAuthorization(): Promise<number> {
  try {
    const status = await messaging().requestPermission();
    console.log('[fcm] iOS notification authorization =', status);
    return status;
  } catch (e) {
    console.warn('[fcm] iOS permission request failed:', (e as Error).message);
    return -1;
  }
}

export async function startFcmBootstrap(): Promise<void> {
  // NA-03 — FIRST, before any awaited I/O. installNotifeeHandlers owns the
  // ONLY cold-launch route (getInitialNotification): a killed-app Answer tap
  // has no other path to CallScreen. It has no dependency on the FCM token,
  // the push register, or the notification channels, and it already owns the
  // nav-ref race internally (the NAV_READY_WAIT_MS poll / the 8 s msg-wake poll), so the
  // old "attach after token registration" ordering only delayed routing.
  // Wrapped because a require/notifee failure must not abort the rest of boot.
  try {
    installNotifeeHandlers();
  } catch (e) {
    console.warn('[fcm] notifee handler install failed:', (e as Error).message);
  }
  // FIX-14 — a ring drawn while the device was in Doze (or moments before its
  // cancel landed) can outlive the process, and nothing used to reconcile it:
  // the user's next launch found a dead call ringing at them with the native
  // looping ringtone still going. Fire-and-forget, after the handlers are
  // installed so a live call's own notification is already accounted for.
  try {
    const {sweepStaleCallNotifications} = require('./callNotification') as typeof import('./callNotification');
    const {getActiveCall} = require('../runtime/callRegistry') as typeof import('../runtime/callRegistry');
    void sweepStaleCallNotifications({
      isLive: (callId) => getActiveCall()?.callId === callId,
    }).catch(() => { /* best-effort */ });
  } catch (e) {
    console.warn('[fcm] stale call sweep skipped:', (e as Error).message);
  }
  // M-04 — warm-path group/message banners are store-driven (sealed sender
  // hides the conversation from the FCM frame). Idempotent; restarted here
  // after a logout→login because stopFcmBootstrap tears it down.
  try {
    const {startBackgroundMessageNotifier} = require('./backgroundMessageNotifier') as typeof import('./backgroundMessageNotifier');
    startBackgroundMessageNotifier();
  } catch (e) {
    console.warn('[fcm] bg-message notifier start failed:', (e as Error).message);
  }
  if (started && serverRegistered) {
    console.log('[fcm] bootstrap skip — already started + server-registered');
    return;
  }
  if (started) {
    console.log('[fcm] bootstrap re-attempting server-register');
    await registerPushTokens();
    return;
  }
  started = true;
  console.log('[fcm] bootstrap start, platform =', Platform.OS, 'apiLevel =', Platform.Version);

  // Android 13+ requires runtime POST_NOTIFICATIONS grant; older Androids
  // grant it implicitly. iOS uses messaging().requestPermission() which
  // shows the iOS permissions sheet.
  try {
    if (Platform.OS === 'android') {
      const apiLevel = typeof Platform.Version === 'number'
        ? Platform.Version
        : Number.parseInt(String(Platform.Version), 10);
      if (apiLevel >= 33) {
        // Avoid a double prompt: PermissionsScreen (onboarding) may already
        // have requested POST_NOTIFICATIONS. Only request here if it isn't
        // already granted — a redundant request re-surfaces the sheet.
        const already = await PermissionsAndroid.check('android.permission.POST_NOTIFICATIONS' as never);
        if (!already) {
          const result = await PermissionsAndroid.request('android.permission.POST_NOTIFICATIONS' as never);
          console.log('[fcm] POST_NOTIFICATIONS grant =', result);
        } else {
          console.log('[fcm] POST_NOTIFICATIONS already granted');
        }
      } else {
        console.log('[fcm] POST_NOTIFICATIONS skipped, apiLevel < 33');
      }
      // BS-MSG1 — create the `bravo-messages` channel the server targets
      // in its chat-wake FCM `notification.android.channelId`. Without an
      // existing channel, Android 8+ SILENTLY DROPS the notification — so
      // calls (which create their own channel) rang while message wakes
      // showed nothing. Create it up front so the server's backgrounded
      // notification renders, and the msg-wake handler can reuse it.
      await ensureMessagesChannel();
      // B-21 — pre-create the high-importance incoming-call ring channel
      // (sound + vibration + full-screen) at boot too, not lazily on the
      // first ring. A voip-wake delivered to a freshly-launched headless JS
      // context could otherwise fire `showIncomingCallNotif` before the
      // channel exists; on Android 8+ a notification to a missing channel
      // is SILENTLY DROPPED — exactly the "no ring" symptom. Pre-creating
      // also surfaces an "Incoming calls" entry in system settings so the
      // user can pre-configure the ringtone. Idempotent (Android ignores a
      // repeat createChannel for an existing id).
      try {
        const {ensureIncomingCallChannel} = require('./callNotification') as typeof import('./callNotification');
        await ensureIncomingCallChannel();
      } catch (e) {
        console.warn('[fcm] ensureIncomingCallChannel failed:', (e as Error).message);
      }
    } else {
      await requestIosNotificationAuthorization();
      // IOSMSG-2 — APNs registration must precede getToken() on iOS.
      // RNFirebase auto-registers by default, but that default can be turned
      // off from firebase.json without anyone touching this file — register
      // explicitly (idempotent) so the iOS data-wake lane can't silently die.
      try {
        const m = messaging() as unknown as {registerDeviceForRemoteMessages?: () => Promise<void>};
        await m.registerDeviceForRemoteMessages?.();
      } catch (e) {
        console.warn('[fcm] registerDeviceForRemoteMessages failed:', (e as Error).message);
      }
    }
  } catch (e) {
    console.warn('[fcm] permission prompt failed:', (e as Error).message);
  }

  // NA-03 — fire-and-forget. Nothing below consumes the token or the register
  // result (onTokenRefresh / onMessage / CallKit-Telecom handlers / pending-action
  // drain are all independent), so awaiting it only stalled the Telecom Answer
  // route and the killed-app action drain behind unbounded network I/O.
  void registerPushTokens();

  // Re-register on rotate. FCM rotates tokens on app reinstall, data
  // clear, sustained offline period, or anti-abuse triggers. Without
  // re-registering, the server's token cache goes stale and the next
  // VoIP wake fires into the void.
  unsubTokenRefresh?.();
  unsubTokenRefresh = messaging().onTokenRefresh(token => {
    console.log('[fcm] token rotated, len =', token.length);
    void Promise.all([
      registerDataToken(token).then(() => true).catch(e => { console.warn('[fcm] re-register-data failed:', (e as Error).message); return false; }),
      registerVoipToken(token).then(() => true).catch(e => { console.warn('[fcm] re-register-voip failed:', (e as Error).message); return false; }),
    ]).then(results => {
      serverRegistered = results.every(Boolean);
    });
  });
  // Foreground data-push handler. setBackgroundMessageHandler only fires when
  // the app is backgrounded/killed; without onMessage a data push arriving
  // while the app is FOREGROUNDED is dropped entirely. Chat is already
  // delivered live over the WS, so for msg-wake we just nudge a pull; the
  // server-driven wakes (booking/agent/SOS/opaque) surface their notification
  // via the shared dispatcher even in the foreground. Registered once; the
  // returned unsubscribe is torn down on logout.
  try {
    unsubOnMessage?.();
    unsubOnMessage = messaging().onMessage(async (msg) => {
      const data = msg?.data ?? {};
      const kind = typeof data.kind === 'string' ? data.kind : '';
      // P2-5 — handle call-cancel in the FOREGROUND too: stop a ring drawn
      // while backgrounded the instant the caller gives up, instead of letting
      // it run out its 45 s timeout after the app is foregrounded.
      if (kind === 'call-cancel') { await handleCallCancel(stringFields(data)); return; }
      if (kind === 'voip-wake') {
        // AC-3 (B-306 rider) — a GROUP wake arriving in the FOREGROUND is the
        // FCM lane's copy of the ring. This used to drop it on the assumption
        // that the live WS lane always presents the ring UI — the assumption
        // the 2026-07-27 two-device run 3 disproved: the WS lane's outcome
        // can be lost (busy-1:1 race), leaving a notification card as the
        // only trace, and a card cannot full-screen a foregrounded app.
        // Re-dispatch through the ring dispatcher: the roomId dedup makes
        // this a NO-OP when the WS lane already presented (or parked) the
        // ring, and a rescue when it did not. 1:1 wakes keep the old
        // behaviour — the WS call.offer frame drives that UI.
        const wakeKind = typeof data.callKind === 'string' ? data.callKind : '';
        // B-504 — verify the HMAC BEFORE any presentation, for BOTH kinds.
        // This was the last Security-S3 asymmetry: the bg, headless and
        // 1:1-rescue lanes all verified first, while the group re-dispatch
        // below presented a full ring UI from an unverified push payload. A
        // throwing verifier fails CLOSED — every sibling lane's exception
        // path also ends with no presentation.
        if (typeof data.callId === 'string' && data.callId) {
          try {
            const {verifyVoipWake} = require('./voipWakeVerify') as typeof import('./voipWakeVerify');
            const {useAuthStore} = require('@/store/authStore') as typeof import('@/store/authStore');
            const verdict = await verifyVoipWake({
              selfUserId: useAuthStore.getState().user?.id ?? '',
              fields: {
                kind:   'voip-wake',
                callId: data.callId,
                nonce:  typeof data.nonce === 'string' ? data.nonce : undefined,
                exp:    typeof data.exp === 'string' ? Number(data.exp) : (typeof data.exp === 'number' ? data.exp : undefined),
                sig:    typeof data.sig === 'string' ? data.sig : undefined,
              },
            });
            if (!verdict.ok) {
              console.warn(`[fcm] fg voip-wake DROPPED reason=${verdict.reason} call=${data.callId}`);
              return;
            }
            // Audit Step 2.1 — a verified foreground wake (the lane that exists
            // for when the WS offer is missing): warm TURN now, after verify.
            try {
              const {prewarmIceServers} = require('@/modules/messenger/webrtc/turnCredentials') as typeof import('@/modules/messenger/webrtc/turnCredentials');
              prewarmIceServers();
            } catch { /* prewarm never blocks */ }
          } catch (e) {
            console.warn('[fcm] fg voip-wake verify failed — dropping:', (e as Error).message);
            return;
          }
        }
        if ((wakeKind === 'group-voice' || wakeKind === 'group-video') && typeof data.callId === 'string' && data.callId) {
          try {
            const {dispatchGroupRingFrame} = require('@/modules/messenger/webrtc/groupCallRingDispatcher') as typeof import('@/modules/messenger/webrtc/groupCallRingDispatcher');
            const fromUid = typeof data.fromUserId === 'string' ? data.fromUserId : '';
            // The wake carries no cleartext name (by design); a directory
            // fallback beats no ring at all, and the WS frame refreshes the
            // label whenever it does arrive.
            let callerName = 'Bravo contact';
            try {
              const {useMessengerStore} = require('@/modules/messenger/store/messengerStore') as typeof import('@/modules/messenger/store/messengerStore');
              callerName = useMessengerStore.getState().directoryNames[fromUid] ?? callerName;
            } catch { /* store cold — generic label */ }
            const handled = dispatchGroupRingFrame({
              event: 'sfu.ring.incoming',
              data: {
                roomId:         data.callId,
                conversationId: typeof data.conversationId === 'string' ? data.conversationId : '',
                callType:       wakeKind === 'group-video' ? 'video' : 'voice',
                // deviceId is not in the wake payload and unused downstream
                // (routing is by userId); 0 marks "FCM lane, device unknown".
                from:           {userId: fromUid, deviceId: 0},
                callerName,
                roomToken:      typeof data.roomToken === 'string' ? data.roomToken : undefined,
                // B-336 — carry the fan-out id so THIS wake dedups against the
                // WS copy of the same ring (that dedup is the whole reason this
                // re-dispatch is safe), while a genuinely new fan-out still
                // presents. Absent on a pre-B-336 relay → roomId dedup, as before.
                ringId:         typeof data.ringId === 'string' ? data.ringId : undefined,
              },
            });
            console.warn('[CALLDIAG] [ring.fcm] foreground group wake re-dispatched room=', data.callId.slice(0, 8), 'handled=', handled);
          } catch { /* dispatcher unavailable — the WS lane stays the only path */ }
          return;
        }
        // WI-4.10 — the 1:1 mirror of the group rescue above, built on the
        // same disproof: "the WS call.offer frame drives that UI" fails
        // exactly when the socket is mid-reconnect or the frame is lost, and
        // then a caller rings a user who is LOOKING at the app and sees
        // nothing. Same gates as the background wake lane, in the same order;
        // the presentation surfaces dedup by callId and the SDP-carrying WS
        // offer merges over the seed whenever it does arrive.
        if ((wakeKind === '' || wakeKind === 'voice' || wakeKind === 'video') &&
            typeof data.callId === 'string' && data.callId) {
          try {
            const rescueCallId = data.callId;
            // Verification already happened at the top of the voip-wake
            // branch (B-504 — one gate for both kinds, Security S3).
            // B-107 — never present over an active restore.
            try {
              const {isRestoreModeActive} = require('@/modules/messenger/backup/restoreMode') as typeof import('@/modules/messenger/backup/restoreMode');
              if (isRestoreModeActive()) {return;}
            } catch { /* flag unavailable — proceed */ }
            const callReg = require('@/modules/messenger/runtime/callRegistry') as typeof import('@/modules/messenger/runtime/callRegistry');
            const live = callReg.getActiveCall();
            // Already ours (ringing/answered via the WS lane) → nothing to rescue.
            if (live && live.callId === rescueCallId) {return;}
            // Busy on a different call → the in-call banner owns busy (W4.2).
            if (live) {
              console.warn('[CALLDIAG] [ring.fcm] fg busy — suppressing 1:1 rescue for', rescueCallId);
              return;
            }
            try {
              const groupReg = require('@/modules/messenger/runtime/groupCallRegistry') as typeof import('@/modules/messenger/runtime/groupCallRegistry');
              const liveGroup = groupReg.getActiveGroupCall();
              if (liveGroup && !liveGroup.ending) {return;}
            } catch { /* registry unavailable — proceed */ }
            // WS lane demonstrably presented → CallScreen is up. The route
            // check covers the PRE-CONTROLLER boot window; once useCall's
            // boot registers the ringing call, the same-id registry gate
            // above fires first (review round 1: the registry is empty only
            // until TURN resolves, not for the whole ring).
            try {
              const {navigationRef} = require('@navigation/navigationRef') as typeof import('@navigation/navigationRef');
              const route = (navigationRef as unknown as {getCurrentRoute?: () => {name?: string} | undefined}).getCurrentRoute?.();
              if (route?.name === 'CallScreen' || route?.name === 'VoiceCall') {return;}
            } catch { /* nav unavailable — present */ }
            const cache = require('./incomingCallCache') as typeof import('./incomingCallCache');
            const rescueKind = wakeKind === 'video' ? 'video' : 'voice';
            let callerName = 'Bravo contact';
            try {
              const fromUid = typeof data.fromUserId === 'string' ? data.fromUserId : '';
              const {useMessengerStore} = require('@/modules/messenger/store/messengerStore') as typeof import('@/modules/messenger/store/messengerStore');
              const convos = useMessengerStore.getState().conversations ?? {};
              for (const c of Object.values(convos)) {
                if (c.type === 'direct' && c.peer?.userId === fromUid && c.name) { callerName = c.name; break; }
              }
            } catch { /* store cold — generic label */ }
            const seeded = cache.setIncomingCallPayload({
              callId:         rescueCallId,
              callerName,
              kind:           rescueKind,
              fromUserId:     typeof data.fromUserId === 'string' && data.fromUserId ? data.fromUserId : undefined,
              conversationId: typeof data.conversationId === 'string' ? data.conversationId : undefined,
            });
            if (!seeded) {return;} // tombstoned — declined/cancelled already
            try {
              const bridge = require('./callKitBridge') as typeof import('./callKitBridge');
              bridge.reportIncomingCall({callId: rescueCallId, callerName, kind: rescueKind});
            } catch (e2) { console.warn('[fcm] fg callkit report failed:', (e2 as Error).message); }
            const {showIncomingCallNotif} = require('./callNotification') as typeof import('./callNotification');
            await showIncomingCallNotif({
              callId:         rescueCallId,
              kind:           rescueKind,
              callerName,
              fromUserId:     typeof data.fromUserId === 'string' && data.fromUserId ? data.fromUserId : undefined,
              conversationId: typeof data.conversationId === 'string' ? data.conversationId : undefined,
            });
            console.warn('[CALLDIAG] [ring.fcm] foreground 1:1 wake rescued call=', rescueCallId.slice(0, 8));
          } catch (e) {
            console.warn('[fcm] fg 1:1 rescue failed:', (e as Error).message);
          }
        }
        return;
      }
      if (kind === 'msg-wake') {
        // B-107 rider — NEVER boot the runtime while the RESTORE gate /
        // an active restore holds. getMessengerRuntime here used to run
        // installIdentity + an immediate bundle publish with a throwaway
        // identity, which the server's rotation detector answered by
        // WIPING the OPK pool and permanently disarming the RESTORE gate
        // (the Round-8 data-loss class).
        try {
          const {isRestoreModeActive} = require('@/modules/messenger/backup/restoreMode') as typeof import('@/modules/messenger/backup/restoreMode');
          if (isRestoreModeActive()) {
            console.log('[fcm] msg-wake during restore — runtime boot deferred');
            return;
          }
        } catch { /* flag module unavailable — proceed */ }
        try {
          const {getMessengerRuntime} = require('@/modules/messenger/runtime') as typeof import('@/modules/messenger/runtime');
          const rt = await getMessengerRuntime('production');
          await (rt as unknown as {pullEnvelopes?: () => Promise<void>}).pullEnvelopes?.();
        } catch { /* WS foreground delivery is the backstop */ }
        return;
      }
      try {
        const {showServerWakeNotification} = require('./serverWakeNotifications') as typeof import('./serverWakeNotifications');
        // N-18 — warm path: also record a durable in-app bell row (store is
        // hydrated here, unlike the fully-killed headless path).
        await showServerWakeNotification(data as Record<string, unknown>, {recordActivity: true});
      } catch (e) {
        console.warn('[fcm] foreground server-wake failed:', (e as Error).message);
      }
    });
  } catch (e) {
    console.warn('[fcm] onMessage register failed:', (e as Error).message);
  }

  // CallKit (iOS) + Telecom (Android) bridge.
  //   Android: ACTIVE — Telecom ConnectionService displays system call
  //     UI alongside the existing notifee path. Both fire (de-duped by
  //     callId). If Telecom setup fails (OEM stripped Telecom, user
  //     denied phone-account permission), the bridge silently no-ops
  //     and notifee remains the sole ringer — Android calling keeps
  //     working exactly as before.
  //   iOS: SKELETON — flips to active when Apple VoIP cert + APNs
  //     server creds + IOS_RUNTIME_ENABLED all line up.
  try {

    const {setupCallKit} = require('./callKitBridge') as typeof import('./callKitBridge');

    const {startVoipPushBootstrap} = require('./voipPush') as typeof import('./voipPush');
    await setupCallKit();
    await startVoipPushBootstrap();
    installCallKitEventHandlers();
  } catch (e) {
    console.warn('[fcm] CallKit/Telecom bootstrap failed:', (e as Error).message);
  }

  // P1-9 / P1-BR-3 — flush any actions queued while the app was killed.
  void drainPendingActions();

  console.log('[fcm] bootstrap complete');
}

/**
 * Wire system-call-UI events (Telecom Accept / End / Mute on Android,
 * CXProvider equivalents on iOS once enabled) into Bravo's existing
 * call lifecycle.
 *
 *   Accept tap (lock screen / system UI) → look up cached payload →
 *     same nav + accept flow as the notifee Accept tap.
 *   End tap → if call hasn't been accepted yet, send call.hangup with
 *     reason='declined' to peer; otherwise treat as remote-ended
 *     hangup (CallScreen.hangup() handles it).
 *
 * Idempotent — guarded by `callKitHandlersInstalled` so a re-bootstrap
 * doesn't double-subscribe (which would double-fire every accept).
 */
let callKitHandlersInstalled = false;
/**
 * The unsubscribe returned by subscribeToCallKitEvents. Previously this was
 * discarded, so a logout→login within the same process left the OLD answer/end
 * listeners attached AND added a second set — a single system-UI Accept then
 * fired onAnswer twice (and a decline could send call.hangup twice). Captured
 * here and invoked in stopFcmBootstrap so the listeners are torn down on logout.
 */
let callKitUnsub: (() => void) | null = null;
/**
 * NA-04 — a system-UI (Telecom lock-screen / headset / Android Auto) Answer.
 * Exported so the accept path is testable; `installCallKitEventHandlers` wires
 * it straight onto the bridge's `onAnswer`.
 */
export function handleSystemUiAnswer(callId: string): void {
  console.log('[callkit-ev] answer callId=', callId);

  const bridge = require('./callKitBridge') as typeof import('./callKitBridge');

  const cache = require('./incomingCallCache') as typeof import('./incomingCallCache');
  // Why: NA-04 — this MUST run before we navigate, and on BOTH branches. A
  // Telecom answer leaves the process backgrounded, so CallScreen's
  // startCallForegroundService is a background FGS start and Android denies the
  // microphone/camera types ("Foreground service started from background can
  // not have ... microphone access") — CallForegroundService then degrades to a
  // typeless service and the callee is mute. It is also the only thing that
  // turns the screen on and puts the in-call controls in front of the user.
  bridge.bringAppToForeground();
  const payload = cache.getIncomingCallPayload(callId);
  if (!payload) {
    console.warn('[callkit-ev] no cached payload for callId=', callId, '— Telecom event arrived without prior reportIncomingCall (notifee path may handle it)');
    return;
  }
  // Same flow as the notifee Accept tap — wait for nav, then navigate to the
  // right screen. CallScreen.useCall picks up the offer SDP and runs accept
  // locally.
  //
  // Do NOT clear the cache here — the navigated screen consumes the SDP. The
  // entry clears once the call ends (peer hangup or user hangup, both routed to
  // clearByCallId through the same bridge.reportEnded path).
  void navigateToIncomingCall(callId, payload);
}
function installCallKitEventHandlers(): void {
  if (callKitHandlersInstalled) {return;}
  callKitHandlersInstalled = true;


  const bridge = require('./callKitBridge') as typeof import('./callKitBridge');

  const cache = require('./incomingCallCache') as typeof import('./incomingCallCache');

  callKitUnsub = bridge.subscribeToCallKitEvents({
    onAnswer: handleSystemUiAnswer,

    onEnd: (callId) => {
      console.log('[callkit-ev] end callId=', callId);
      // B-109 RC-3 — check the LIVE call FIRST. The incoming-call cache is
      // only cleared when the call ENDS, so "payload exists" does NOT mean
      // "still ringing": an in-app-answered call keeps its cached payload
      // for the whole call. Under the old order, iOS dismissing the stale
      // CallKit ring after an in-app answer took the decline branch and
      // sent call.hangup{declined} on a live call, cutting it.
      try {
        const reg = require('@/modules/messenger/runtime/callRegistry') as typeof import('@/modules/messenger/runtime/callRegistry');
        const active = reg.getActiveCall();
        if (active && active.callId === callId) {
          console.log('[callkit-ev] end on LIVE call — hangup, not decline:', callId);
          // WI-1.1 — weak (callId) ref: a Telecom/CallKit event carries no
          // generation. The id equality on the line above is the guard.
          // 'remote' preserves the pre-WI-1.1 default: this path maps to the
          // CallKit 'remoteEnded' glyph, and the comment above is explicit that
          // it is a hangup and NOT a decline.
          reg.endActiveCall(callId, 'ended', 'remote');
          cache.clearIncomingCallPayload(callId);
          clearAcceptedCallId(callId);
          try {
            const cn = require('./callNotification') as typeof import('./callNotification');
            void cn.dismissCallNotif(callId);
          } catch { /* notifee may not be ready in headless JS */ }
          return;
        }
      } catch (e) {
        console.warn('[callkit-ev] live-call probe failed:', (e as Error).message);
      }
      const payload = cache.getIncomingCallPayload(callId);
      if (payload) {
        // WI-4.8 — "payload present + registry empty" is NOT proof the ring
        // is unanswered: the registry is empty for the whole null-controller
        // window of an accept in flight (notification Answer → cold nav →
        // controller build). A Telecom End here is usually the system tearing
        // down its own ring surface racing that answer — declining would tell
        // the caller the user refused the call they just accepted. The
        // explicit-accept latch is the cross-lane record of the Answer press;
        // while it holds, never convert an End into a decline.
        //
        // ADJUDICATED (review rounds 1+2): a REAL user End in this window is
        // also swallowed — deliberately. The two are indistinguishable at
        // this event, and acting on it would tombstone the call and kill the
        // accept the user just made (the B-109 regression, resurrected). The
        // cost of the no-op is one ignored press: the in-app surface mounts
        // within the same window and its End works. Round 2 bounded the
        // branch by AGE: past the plausible accept-in-flight window (the
        // cold-nav wait + the TURN ceiling) a system End cannot still be
        // racing the answer, so an End is unambiguously the user's and
        // declines exactly as it did at HEAD.
        if (wasCallExplicitlyAcceptedWithin(callId, NAV_READY_WAIT_MS + TURN_FETCH_CEILING_MS)) {
          console.warn('[CALLDIAG] [callkit-ev] end on answered-but-not-yet-live call — NOT declining:', callId);
          try {
            const cn = require('./callNotification') as typeof import('./callNotification');
            void cn.dismissCallNotif(callId);
          } catch { /* notifee may not be ready in headless JS */ }
          return;
        }
        // Call was still pending (user hasn't accepted yet) →
        // decline. Send call.hangup with reason='declined' so the
        // caller stops ringing instead of waiting for the 30s no-
        // answer timeout.
        sendCallHangup(callId, payload, 'declined');
        cache.clearIncomingCallPayload(callId);
        clearAcceptedCallId(callId);
        // Also dismiss the notifee notification so a duplicate ring
        // doesn't outlive the Telecom decline.
        try {

          const cn = require('./callNotification') as typeof import('./callNotification');
          void cn.dismissCallNotif(callId);
        } catch { /* notifee may not be ready in headless JS */ }
        return;
      }
      // Call already accepted → user hit End from system UI. The
      // active CallScreen owns hangup; we just need to make sure
      // the active controller hears it. Easiest path: navigate the
      // existing controller to hang up via the call registry.
      try {

        const reg = require('@/modules/messenger/runtime/callRegistry') as typeof import('@/modules/messenger/runtime/callRegistry');
        const active = reg.getActiveCall();
        if (active && active.callId === callId) {
          // The active call's controller will see this and run its
          // own hangup / cleanup via the existing onState=ended path.
          reg.endActiveCall(callId, 'ended', 'remote');
        }
      } catch (e) {
        console.warn('[callkit-ev] end propagate failed:', (e as Error).message);
      }
    },

    onToggleMute: (callId, muted) => {
      console.log('[callkit-ev] mute', callId, muted);
      // System UI mute → flip the local audio track directly via the
      // active-call registry. The track is what carries audio; flipping
      // .enabled mutes immediately. We do NOT round-trip through
      // useCall's toggleMute callback because that lives inside React
      // state and isn't reachable from headless JS.
      //
      // Caveat: the in-app mute icon is driven by useCall's local
      // useState which won't update from this path — so a system-UI
      // mute won't visually flip the in-app button until CallScreen
      // remounts. Acceptable trade-off; the audio IS muted (which is
      // the contract the user cares about).
      try {

        const reg = require('@/modules/messenger/runtime/callRegistry') as typeof import('@/modules/messenger/runtime/callRegistry');
        const active = reg.getActiveCall();
        if (active && active.callId === callId && active.audioTrack) {
          active.audioTrack.enabled = !muted;
          console.log(`[callkit-ev] audioTrack.enabled = ${!muted} for callId=${callId}`);
        }
      } catch (e) {
        console.warn('[callkit-ev] mute mirror failed:', (e as Error).message);
      }
    },
  });

  console.log('[callkit] event handlers installed');
}

/**
 * Tracks callIds that have already been navigated to, so a notifee
 * Accept tap + Telecom Answer event for the SAME callId (which fires
 * within ms of each other on Android FullScreenIntent) doesn't mount
 * CallScreen twice and send TWO `call.answer` frames to the gateway.
 * The second frame would cross the caller's setRemoteDescription mid-
 * flight and the call would stick in have-local-offer.
 *
 * Cleared when the call ends (peer hangup, our hangup, or decline)
 * via `clearAcceptedCallId(callId)` — both clearByCallId paths in
 * onEnd/decline-handler call it. Bounded scrub (older-than-5-min) on
 * every check so an abandoned entry can't outlive the day.
 */
const acceptedCallIds = new Map<string, number>();
/**
 * B-102 A1 — callIds the user EXPLICITLY answered (notification Answer
 * button / Telecom Answer / in-app accept), as opposed to a body tap that
 * merely opens the ring screen (which also latches acceptedCallIds for
 * navigation dedupe). MainNavigator's offer navigation consults this so a
 * WS offer replay landing AFTER the Answer tap re-asserts autoAccept
 * instead of clobbering it (React Navigation 6 navigate() REPLACES params).
 */
// Review round 1 (P0) — a Map WITH timestamps, scrubbed on read, never a bare
// Set: WI-4.6 made this latch a NAVIGATION INPUT keyed by roomId, and group
// roomIds are REUSED across re-rings while the room has participants. An
// unbounded entry surviving a failed Answer (nav abandon, roomMissing, a
// same-tick cancel) would auto-join the user into the NEXT ring of that room
// with zero interaction — a live mic with no consent. The 5-minute scrub is
// the backstop; every terminal lane still clears explicitly.
const explicitAcceptIds = new Map<string, number>();
/**
 * WI-4.4 — body taps get their OWN navigate dedupe, separate from the answer
 * dedupe above. A body tap opens the ring UI; it is not an answer, so it must
 * not spend `acceptedCallIds` and disable the Answer button the user reaches
 * for next. It still needs a dedupe of its own: the Android FSI body press and
 * the cold-launch `getInitialNotification` replay can both describe the same
 * tap, and re-navigating on the second is pointless work.
 */
const bodyTapNavIds = new Map<string, number>();
export function wasCallExplicitlyAccepted(callId: string): boolean {
  scrubOlderThan5Min(explicitAcceptIds);
  return explicitAcceptIds.has(callId);
}
/**
 * R2-3 — the age-bounded read. Two consumers need a TIGHTER window than the
 * 5-minute scrub:
 *   • the GROUP navigate re-assert (MainNavigator): group roomIds are reused
 *     across re-rings, so an Answer whose navigation was abandoned must stop
 *     re-asserting once its own ring window has passed — otherwise the
 *     room's NEXT ring auto-joins with zero consent;
 *   • the Telecom onEnd no-decline branch: past the plausible accept-in-
 *     flight window a system End can no longer be racing the answer, so a
 *     real user End should decline as it always did.
 */
export function wasCallExplicitlyAcceptedWithin(callId: string, windowMs: number): boolean {
  const at = explicitAcceptIds.get(callId);
  return at !== undefined && Date.now() - at <= windowMs;
}
/** Shared bounded scrub — >5 min is well past any realistic ring window. */
function scrubOlderThan5Min(m: Map<string, number>): void {
  const cutoff = Date.now() - 5 * 60_000;
  for (const [cid, t] of m) {
    if (t < cutoff) {m.delete(cid);}
  }
}
/**
 * WI-6.1 — how long a local Answer press shields this device from an
 * answered-elsewhere ring-cancel while the call has not yet reached the
 * registry. Long enough for the accept→register path (navigation + WebRTC
 * setup start, a few seconds); short enough that a device whose accept LOST
 * the server arbitration is collapsed by a later cancel instead of
 * stranding at "Answering…" forever.
 */
const ACCEPT_PRESERVE_WINDOW_MS = 20_000;
function markAccepted(callId: string): boolean {
  scrubOlderThan5Min(acceptedCallIds);
  if (acceptedCallIds.has(callId)) {return false;}
  acceptedCallIds.set(callId, Date.now());
  // WI-7.1 — the accept latch is a lifecycle DECISION (it gates the
  // answered-elsewhere collapse and the notification dedup); record it in
  // the [CALLSM] lane so a release logcat shows who claimed the answer.
  try {
    const {logCallSm, shortCallId} = require('../runtime/callDiag') as typeof import('../runtime/callDiag');
    logCallSm('latch.accept', {cid: shortCallId(callId)});
  } catch { /* diag unavailable — never block the accept */ }
  return true;
}
function markBodyTapNavigated(callId: string): boolean {
  scrubOlderThan5Min(bodyTapNavIds);
  if (bodyTapNavIds.has(callId)) {return false;}
  bodyTapNavIds.set(callId, Date.now());
  return true;
}
function clearAcceptedCallId(callId: string): void {
  acceptedCallIds.delete(callId);
  bodyTapNavIds.delete(callId);
  explicitAcceptIds.delete(callId);
}
/**
 * WI-4.3 — release ONLY the navigate dedupes, never the Answer INTENT.
 *
 * Both 20 s nav-readiness waits used to call `clearAcceptedCallId` on abandon.
 * Their stated purpose ("don't leave the accept latch set for 5 min so a
 * follow-up answer isn't silently dropped") is served entirely by the two
 * dedupe maps. `explicitAcceptIds` is a different fact — it records that the
 * USER PRESSED ANSWER — and MainNavigator's offer navigation reads it to
 * re-assert `autoAccept` after RN6 replaces the route params (B-102 A1).
 * Clearing it turned "the navigator was slow to mount" into "the user never
 * answered": the offer replay landing a second later re-showed the ring on a
 * call the user had already accepted.
 */
function releaseAcceptDedupe(callId: string): void {
  acceptedCallIds.delete(callId);
  bodyTapNavIds.delete(callId);
}
/**
 * Public helper for useCall's onState('ended') path to clear the
 * accept-dedupe entry without reaching into module internals. Called
 * after the call lifecycle naturally ends so the next incoming call
 * with the same callId (extremely unlikely but possible on a buggy
 * server) can navigate fresh.
 */
export function notifyCallEnded(callId: string): void {
  clearAcceptedCallId(callId);
}

/**
 * B-109 RC-3 — pre-latch for the in-app accept path. `reportAnswered`
 * (callKitBridge) makes RNCallKeep re-emit `answerCall`; marking the callId
 * accepted BEFORE that call means the resulting onAnswer →
 * navigateToIncomingCall dedupes instead of navigating again and firing a
 * second `call.answer` (the have-local-offer wedge). Idempotent.
 */
export function markCallAccepted(callId: string): void {
  markAccepted(callId);
  explicitAcceptIds.set(callId, Date.now());
}

/**
 * B-102 A2 — best-effort decline for the null-controller window: the ring
 * screen's Decline was a silent no-op when the useCall boot bailed on a
 * missing offer SDP (controllerRef never built). Mirrors the notification
 * Decline path: hangup{declined} over the live transport from the cached
 * payload, then clear every ring surface. Safe to call with nothing cached.
 *
 * NA-02 passes reason='failed' so a dead offer does not tell the caller /
 * Telecom that the user declined.
 */
/**
 * WI-5.4 (transport G9) — a call-control send with the durable fallback the
 * killed-app lane already had. The live transport's send() THROWS on a
 * disconnected socket (it never queues), and `getLiveTransport()` happily
 * returns a non-null client whose socket is down — so every site here that
 * guarded on `tx` TRUTHINESS and put `enqueuePendingAction` in the `else`
 * lost the decline whenever the send threw: the catch logged, the enqueue
 * was never reached, and the caller kept ringing to timeout. ANY failure —
 * null transport OR thrown send — now lands the durable action, which the
 * pendingActions drain flushes over HTTP on the next connect.
 *
 * Never throws: callers put local teardown (cache clear, latch clear) after
 * this call, and a transport fault must not skip it.
 */
async function sendCallControlDurable(
  frame: {event: string; data: unknown},
  // Round 1 P2 — null = no durable fallback for this frame (a dead-offer
  // 'failed' hangup must NOT degrade into a decline: NA-02 chose that reason
  // precisely so the caller/Telecom never hears "declined" for a call that
  // simply never connected).
  durable: import('./pendingActions').PendingActionInput | null,
  logTag: string,
): Promise<void> {
  let sent = false;
  try {
    const reg = require('@/modules/messenger/runtime/transportRegistry') as typeof import('@/modules/messenger/runtime/transportRegistry');
    const tx = reg.getLiveTransport();
    if (tx) {
      tx.send(frame as never);
      sent = true;
      console.log(`${logTag} sent ${frame.event}`);
    }
  } catch (e) {
    console.warn(`${logTag} ${frame.event} send failed — falling back to durable queue:`, (e as Error).message);
  }
  if (!sent && durable) {
    // Round 1 P1 — this resolves only after the AsyncStorage write lands.
    // The notifee BACKGROUND handler must AWAIT it: notifee keeps the
    // headless task alive only until the handler's promise settles, and a
    // floated write here could be frozen with the process — losing the
    // decline on exactly the lane the durable queue exists for. Foreground
    // callers may void it.
    try {
      const {enqueuePendingAction} = require('./pendingActions') as typeof import('./pendingActions');
      await enqueuePendingAction(durable);
      console.log(`${logTag} queued durable ${frame.event.includes('ring') ? 'group' : 'direct'} decline`);
    } catch (e2) {
      console.warn(`${logTag} durable enqueue failed:`, (e2 as Error).message);
    }
  }
}

export function declineIncomingCallBestEffort(
  callId: string,
  reason: 'declined' | 'failed' = 'declined',
): void {
  try {
    const cache = require('./incomingCallCache') as typeof import('./incomingCallCache');
    const payload = cache.getIncomingCallPayload(callId);
    if (payload?.fromUserId) {
      // WI-5.4 — durable on ANY send failure (null transport or a thrown
      // send). Round 1 P2: EXCEPT a dead-offer 'failed' — the durable lane
      // only speaks decline, and NA-02 chose 'failed' precisely so the
      // caller/Telecom never hears "declined" for a call that simply never
      // connected. A failed 'failed' hangup degrades to no-answer, as before.
      void sendCallControlDurable(
        {
          event: 'call.hangup',
          data: {
            callId,
            to: {userId: payload.fromUserId, deviceId: payload.remoteDeviceId ?? 1},
            reason,
          },
        },
        reason === 'failed' ? null : {t: 'decline', callId, kind: 'direct', peerUserId: payload.fromUserId},
        '[bravo.call] null-controller teardown →',
      );
    }
    cache.clearIncomingCallPayload(callId);
    clearAcceptedCallId(callId);
    try {
      const bridge = require('./callKitBridge') as typeof import('./callKitBridge');
      bridge.reportEnded(callId, reason === 'failed' ? 'failed' : 'declined');
    } catch { /* bridge inactive */ }
    try {
      const cn = require('./callNotification') as typeof import('./callNotification');
      void cn.dismissCallNotif(callId);
    } catch { /* notifee unavailable */ }
  } catch (e) {
    console.warn('[bravo.call] declineIncomingCallBestEffort failed:', (e as Error).message);
  }
}

/**
 * Look up the navigationRef and route to the right ring screen.
 * Mirrors the notifee Accept-tap path (so a notifee Accept and a
 * Telecom Accept land on identical UI).
 */
async function navigateToIncomingCall(
  callId: string,
  payload: import('./incomingCallCache').CachedIncomingCall,
): Promise<void> {
  // Dedupe: if a notifee Accept tap already navigated for this callId,
  // and the Telecom Answer event fires 50ms later (Android FSI), the
  // second invocation is silently dropped. Without this both paths
  // mount CallScreen and both fire `call.answer` — the second one
  // races the caller's setRemoteDescription and the call hangs.
  if (!markAccepted(callId)) {
    console.log('[callkit-ev] navigate skipped (already accepted) callId=', callId);
    return;
  }
  // B-102 A1 — a Telecom Answer is always an explicit accept.
  explicitAcceptIds.set(callId, Date.now());
  // [CALLLAT] (audit Step 0, §1.2 N1) — the Telecom Answer tap is the user's
  // origin for this lane; `freshAfterMs` lets an earlier ring/offer row keep
  // t0 while a stale clock from a previous call on the same id cannot.
  const latIsGroup = payload.kind === 'group-voice' || payload.kind === 'group-video';
  const latLane = latIsGroup ? 'grp-join' as const : '1to1-in' as const;
  const latId = latIsGroup ? (payload.conversationId ?? callId) : callId;
  {
    const {logCallLat} = require('../runtime/callDiag') as typeof import('../runtime/callDiag');
    logCallLat(latLane, latId, 'notif:answer-tap', {src: 'telecom'}, {freshAfterMs: 90_000});
  }
  try {

    const {navigationRef} = require('@navigation/navigationRef') as typeof import('@navigation/navigationRef');
    const t0 = Date.now();
    // P1-BR-2 — cold launch from a killed state can take 10–25 s; wait 20 s.
    while (Date.now() - t0 < NAV_READY_WAIT_MS) {
      if ((navigationRef as unknown as {isReady?: () => boolean})?.isReady?.()) {break;}
      await new Promise(r => setTimeout(r, 100));
    }
    if (!(navigationRef as unknown as {isReady?: () => boolean})?.isReady?.()) {
      console.warn('[callkit-ev] nav not ready after 20s — abandoning route');
      // WI-4.3 — release the navigate dedupe only; the Answer intent survives.
      releaseAcceptDedupe(callId);
      return;
    }
    {
      const {logCallLat} = require('../runtime/callDiag') as typeof import('../runtime/callDiag');
      logCallLat(latLane, latId, 'nav:ready', {waitMs: Date.now() - t0, src: 'telecom'});
    }

    // A Telecom Answer event is always an explicit accept → autoAccept.
    const isGroup = payload.kind === 'group-voice' || payload.kind === 'group-video';
    if (isGroup) {
      navigateToMessengerScreen(navigationRef as never, 'IncomingGroupCallScreen', {
        roomId:         payload.roomId ?? '',
        conversationId: payload.conversationId ?? '',
        roomToken:      payload.roomToken ?? '', // P1-BR-1 — echo to sfu.join
        callType:       payload.kind === 'group-video' ? 'video' : 'voice',
        callerName:     payload.callerName,
        fromUserId:     payload.fromUserId ?? '',
        autoAccept:     true,
      });
    } else {
      navigateToMessengerScreen(navigationRef as never, 'CallScreen', {
        callType:       payload.kind === 'video' ? 'video' : 'voice',
        isIncoming:     true,
        conversationId: payload.conversationId ?? `direct:${payload.fromUserId ?? ''}`,
        callId,
        remoteUserId:   payload.fromUserId,
        remoteDeviceId: payload.remoteDeviceId ?? 1,
        incomingSdp:    payload.incomingSdp,
        autoAccept:     true,
      });
    }
    console.log('[callkit-ev] navigated → callId=', callId);
  } catch (e) {
    console.warn('[callkit-ev] navigate failed:', (e as Error).message);
  }
}

/**
 * Send `call.hangup` to the peer over the live transport. Used by:
 *   - Telecom End-tap-while-ringing (decline)
 *   - Notifee Decline button tap
 *
 * Fire-and-forget — if the WS isn't connected (app cold-launched
 * directly into the system call UI without messenger runtime up),
 * the caller will see no-answer instead of decline. Acceptable
 * degradation; the alternative is making the user wait while we
 * boot a runtime just to send one frame.
 */
function sendCallHangup(
  callId: string,
  payload: import('./incomingCallCache').CachedIncomingCall,
  reason: 'declined' | 'busy' | 'ended' | 'failed',
): void {
  if (!payload.fromUserId) {
    console.warn('[callkit-ev] cannot send call.hangup — no fromUserId in cached payload, callId=', callId);
    return;
  }
  // WI-5.4 — was "Fire-and-forget … the caller will see no-answer instead
  // of decline. Acceptable degradation." It is not acceptable when the
  // durable lane exists: ANY send failure now queues the decline, flushed
  // over HTTP on the next connect.
  void sendCallControlDurable(
    {
      event: 'call.hangup',
      data: {
        callId,
        to: {userId: payload.fromUserId, deviceId: payload.remoteDeviceId ?? 1},
        reason,
      },
    },
    // Round 2 F-2 — the durable lane only speaks decline; any other reason
    // ('busy'/'ended'/'failed') degrades to no-answer rather than lying.
    reason === 'declined' ? {t: 'decline', callId, kind: 'direct', peerUserId: payload.fromUserId} : null,
    '[callkit-ev]',
  );
}

/**
 * P1-7 — route a Missed-call banner tap. Deep-link to the caller's local 1:1
 * thread (resolved from the payload's fromUserId) so the user can call back;
 * fall back to the Calls log when we don't know who called. Never opens the
 * incoming CallScreen — that call is already over.
 */
async function handleMissedCallTap(data: Record<string, string | undefined>): Promise<void> {
  try {
    const {navigationRef} = require('@navigation/navigationRef') as typeof import('@navigation/navigationRef');
    const navReady = navigationRef as unknown as {isReady?: () => boolean};
    const t0 = Date.now();
    while (Date.now() - t0 < NAV_READY_WAIT_MS) {
      if (navReady?.isReady?.()) {break;}
      await new Promise(r => setTimeout(r, 100));
    }
    // B-230 — mirror the Telecom-Answer path (handleSystemUiAnswer): if the nav
    // ref never became ready, DON'T navigate a dead ref (silent no-op that drops
    // the tap intent). Bail; the app's own resume logic lands the user sensibly.
    if (navReady?.isReady && !navReady.isReady()) {
      console.warn('[notifee] nav not ready after 20s — missed-call tap abandoned');
      return;
    }
    const fromUserId = data.fromUserId;
    let convId: string | undefined;
    let name: string | undefined;
    if (fromUserId) {
      try {
        const {resolveDirectConversation} = require('./mutedLookup') as typeof import('./mutedLookup');
        const resolved = await resolveDirectConversation(fromUserId);
        convId = resolved?.id;
        name = resolved?.name;
      } catch { /* fall through to the Calls log */ }
    }
    if (convId) {
      // B-85 — `initial: false` is LOAD-BEARING: without it, React
      // Navigation treats the nested `screen` as the stack's initial
      // route on first mount, seeding [Chat] alone — back then bubbles
      // to the tab navigator and lands on the Dashboard. With it, the
      // navigator's initialRouteName (MessengerHome) is seeded beneath.
      navigateToMessengerScreen(navigationRef as never, 'Chat', {conversationId: convId, name: name ?? '', isGroup: false}, {initial: false});
    } else {
      // BB-3 — same B-85 flag the Chat branch above carries: without it a
      // cold missed-call tap seeds [CallsLog] alone and its back arrow dies.
      navigateToMessengerScreen(navigationRef as never, 'CallsLog', {}, {initial: false});
    }
  } catch (e) {
    console.warn('[notifee] missed-call tap routing failed:', (e as Error).message);
  }
}

/**
 * Why: RNFirebase types a push's `data` as `{[k: string]: string | object}`;
 * our handlers only consume string fields, so drop non-strings instead of
 * casting (behavior-identical — object values were never read).
 */
function stringFields(data: Record<string, string | object>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === 'string') {out[k] = v;}
  }
  return out;
}

/**
 * B-323 — parse the wake's display-only send time (`sentAtMs`, numeric string)
 * into a showMessageNotif arg. Absent/malformed stays absent, so the banner
 * never claims a send time it doesn't have.
 */
function wakeSentAtArg(data: Record<string, string | object | undefined>): {sentAtMs?: number} {
  const parsed = typeof data.sentAtMs === 'string' ? Number(data.sentAtMs) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? {sentAtMs: parsed} : {};
}

/**
 * B-325 — the same guarded runtime boot + envelope pull the wake handlers run,
 * kicked at TAP time so ingest travels alongside navigation instead of waiting
 * for the ChatScreen mount (that ordering is what made a notification-opened
 * thread render 2–3 s stale). Resolves false when the pull could not run
 * (restore gate held, runtime unavailable) so callers can fall back promptly.
 */
/**
 * B-326 — EVERY notification action (tap pull, inline Reply, Mark-as-read)
 * must work on a COLD headless VM. A bare getMessengerRuntime('production')
 * there throws B-272 ("requires configureMessengerRuntime first") and the
 * action — including a TYPED REPLY — is silently dropped. Configure from the
 * persisted record first (same guards as the killed-app drain), then hand
 * back the runtime. Throws when truly unavailable; callers catch.
 */
async function ensureRuntimeForNotifAction(): Promise<import('@/modules/messenger/runtime').MessengerRuntime> {
  const rtIndex = require('@/modules/messenger/runtime') as typeof import('@/modules/messenger/runtime');
  const configured = typeof rtIndex.getActiveOwnerKey === 'function' ? !!rtIndex.getActiveOwnerKey() : true;
  if (!configured) {
    const {configureRuntimeFromPersisted} = require('./headlessDrain') as typeof import('./headlessDrain');
    await configureRuntimeFromPersisted();
  }
  return rtIndex.getMessengerRuntime('production');
}

async function startTapTimePull(): Promise<boolean> {
  try {
    const {isRestoreModeActive} = require('@/modules/messenger/backup/restoreMode') as typeof import('@/modules/messenger/backup/restoreMode');
    // B-107 — never boot the runtime while the RESTORE gate holds.
    if (isRestoreModeActive()) {return false;}
  } catch { /* flag module unavailable — proceed */ }
  try {
    const rt = await ensureRuntimeForNotifAction();
    await (rt as unknown as {pullEnvelopes?: () => Promise<void>}).pullEnvelopes?.();
    return true;
  } catch { return false; }
}

/**
 * B-324 — a sealed-sender wake can only GUESS its conversation (the sender's
 * DM), so a killed-app GROUP banner used to deep-link the wrong thread. Wait
 * briefly for the tap-time pull, then route to the conversation holding the
 * sender's NEWEST message — after a successful pull that is exactly the
 * message the banner was about. Null → caller falls back to the guess.
 */
const GUESS_ROUTE_PULL_WAIT_MS = 6000;
async function resolveTapTargetAfterPull(
  senderUserId: string,
  pullSettled: Promise<boolean>,
): Promise<{id: string; name?: string; isGroup: boolean} | null> {
  await Promise.race([pullSettled, new Promise(r => setTimeout(r, GUESS_ROUTE_PULL_WAIT_MS))]);
  try {
    const {useMessengerStore} = require('@/modules/messenger/store/messengerStore') as
      typeof import('@/modules/messenger/store/messengerStore');
    const state = useMessengerStore.getState();
    let best: {cid: string; at: string} | null = null;
    for (const [cid, list] of Object.entries(state.messages)) {
      // Lists are send-ordered — the sender's newest row in a conversation is
      // the first hit scanning from the tail.
      for (let i = list.length - 1; i >= 0; i--) {
        const m = list[i];
        if (m.sender_id !== senderUserId) {continue;}
        if (!best || m.created_at > best.at) {best = {cid, at: m.created_at};}
        break;
      }
    }
    if (!best) {return null;}
    const conv = state.conversations[best.cid];
    if (!conv) {return null;}
    return {id: best.cid, name: conv.name, isGroup: conv.type === 'group' || conv.type === 'ops_channel'};
  } catch { return null; }
}

/**
 * F4 — is this conversation a DEPARTMENT CHANNEL, and which channel?
 *
 * A channel's conversation is stored with `type: 'group'`, so the tap handler
 * cannot tell it from an ordinary group by type — and routing it to `Chat` puts
 * phone + video buttons on a surface the PDF (A9/M9) says must have none.
 *
 * Live store FIRST (a warm tap: authoritative and free), persisted vault slice
 * SECOND (a killed-app tap, where the store has not hydrated — the same
 * store-then-persisted ladder the name/isGroup resolution above uses). Returns
 * null when the conversation is not departmental OR when nothing can be read,
 * so an unknown answer keeps the pre-existing Chat routing.
 */
async function resolveDeptRouteForTap(conversationId: string): Promise<import('./deptChannelTarget').DeptConversationRoute | null> {
  if (!conversationId) {return null;}
  const {resolveDeptConversation} = require('./deptChannelTarget') as typeof import('./deptChannelTarget');
  try {
    const {useMessengerStore} = require('@/modules/messenger/store/messengerStore') as
      typeof import('@/modules/messenger/store/messengerStore');
    const live = resolveDeptConversation(conversationId, useMessengerStore.getState());
    if (live) {return live;}
  } catch { /* store unavailable — fall through to the persisted slice */ }
  try {
    const {resolvePersistedDeptMaps} = require('./mutedLookup') as typeof import('./mutedLookup');
    return resolveDeptConversation(conversationId, await resolvePersistedDeptMaps());
  } catch { return null; }
}

/**
 * F4 — the ONE door from "a tap resolved to conversation X" to a thread screen.
 *
 * Both the immediate route and the B-324 post-pull re-route come through here,
 * so the department rule cannot hold on one path and silently lapse on the
 * other — the duplicate-copy shape this repo keeps paying for. A department
 * conversation with no locally-known channel id degrades to the channel
 * DIRECTORY rather than to Chat: `DepartmentChatScreen` needs `channelId` for
 * every server call it makes, and Chat is the banned destination.
 */
/**
 * The route `navigateToThread` will land on for a given dept verdict.
 *
 * D3 — B-324's re-route guard used to ask `current.name === 'Chat'` to decide
 * "is the user still where our immediate navigate put them?". Once F4 let that
 * immediate navigate land on DepartmentChat/DepartmentChannels, the guard could
 * only ever answer "no" for a channel, so the pull's correction was silently
 * dropped and the user stayed on the WRONG conversation. Deriving both the
 * navigate and the guard from this one function is what stops the two from
 * drifting apart again — the previous shape was two copies of one rule.
 */
function threadRouteName(
  dept: import('./deptChannelTarget').DeptConversationRoute | null,
): 'DepartmentChat' | 'DepartmentChannels' | 'Chat' {
  if (dept?.channelId) {return 'DepartmentChat';}
  if (dept) {return 'DepartmentChannels';}
  return 'Chat';
}

function navigateToThread(
  nav: unknown,
  target: {conversationId: string; name?: string; isGroup: boolean},
  dept: import('./deptChannelTarget').DeptConversationRoute | null,
): void {
  /**
   * vs2 edge A9 — SCOPE FIRST when we know which workspace this thread is in.
   *
   * The thread itself opens fine by `channelId`; the broken half is what sits
   * BEHIND it. Back lands in a directory belt-filtered by
   * `scopeChannelsToActiveWorkspace` to the sticky org — which does not contain
   * the thread just read, so the channel the user is standing in appears not to
   * exist.
   *
   * The ORDER is not optional. Adopting a different org remounts
   * `DepartmentalNavigator` (the B-95 held frame), which would tear down a
   * thread we had already navigated to. `adoptOrgContextFromWake` waits that
   * out, so this navigates after the switch has settled — and no-ops instantly
   * when the org is unknown (old client state) or already active, which is
   * every single-workspace user.
   */
  /**
   * The routing body, declared FIRST and kept INSIDE `navigateToThread`.
   *
   * Two source scans slice this function by name to prove the door reads
   * `dept?.channelId` and never lands on Chat, and a third walks forward a
   * bounded window from each `'DepartmentChat'` literal. Hoisting this into a
   * sibling made the first two read the wrapper; putting the A9 adoption block
   * above it pushed the `channelId:` assignment out of the third's window. It
   * stays here, and it stays first.
   */
  function go(): void {
  // Switch on the SAME function the re-route guard asks, so the destination and
  // the "did we land there?" test can never disagree (D3).
  const route = threadRouteName(dept);
  if (route === 'DepartmentChat') {
    navigateToMessengerScreen(nav as never, 'DepartmentChat', {
      channelId:            dept?.channelId,
      channelName:          target.name ?? '',
      channelDesc:          '',
      groupConversationId:  target.conversationId,
    }, {initial: false});
    return;
  }
  if (route === 'DepartmentChannels') {
    navigateToMessengerScreen(nav as never, 'DepartmentChannels', {}, {initial: false});
    return;
  }
  navigateToMessengerScreen(nav as never, 'Chat', {
    conversationId: target.conversationId,
    name:           target.name ?? '',
    isGroup:        target.isGroup,
  }, {initial: false});
  }

  /**
   * …and ONLY on the shell where this door actually enters the workspace
   * surface. `adoptOrgContext`'s own contract forbids adopting from a door that
   * leaves the user outside that org's surface — the context also decides where
   * clock-in, incident submit and invite mint LAND, and none of those has a
   * drift guard. On the client and CPO shells this tap reaches
   * `MessengerNavigator`'s DepartmentChat and Back goes to `MessengerHome`,
   * which is explicitly excluded from workspace scoping: no symptom to fix, and
   * a sticky global repointed with nothing on screen naming the new org.
   */
  if (dept?.orgId && deptThreadEntersWorkspaceSurface()) {
    void (async () => {
      try {
        const {adoptOrgContextFromWake} =
          require('@/store/adoptOrgContext') as typeof import('@/store/adoptOrgContext');
        // A newer tap won the context while this one settled — it owns the
        // navigation now.
        if (await adoptOrgContextFromWake(dept.orgId) === 'superseded') {return;}
      } catch { /* store unavailable — fall through and route unscoped */ }
      go();
    })();
    return;
  }
  go();
}

/**
 * P2-5 — full call-cancel teardown, shared by the killed/background FCM handler
 * and the FOREGROUND onMessage path. Dismisses the notifee ring, tears down the
 * system-UI (Telecom) display, tombstones the incoming-call cache so a queued
 * Accept can't resurrect a dead call, and (when the caller gave up unanswered)
 * leaves a Missed-call trace.
 */
async function handleCallCancel(data: Record<string, string | undefined>): Promise<void> {
  const callId = typeof data.callId === 'string' ? data.callId : '';
  if (!callId) {return;}
  // WI-6.1 — preserve the answering device. The server's answered-elsewhere
  // cancel fans to EVERY registered device token, including the winner's. A
  // cancel is a RING-collapse instruction, never a call-teardown one: the
  // WS `call.hangup` lane owns ending live calls. Two signals, either wins:
  //   1. the registry holds this call live — this device IS on the call;
  //   2. the accept latch fired here within the answer-setup window — this
  //      device pressed Answer and may not have registered yet. Bounded
  //      (ACCEPT_PRESERVE_WINDOW_MS): if setup never completes, a later
  //      cancel may still collapse the zombie instead of stranding it.
  try {
    const {getActiveCall} = require('../runtime/callRegistry') as typeof import('../runtime/callRegistry');
    const live = getActiveCall();
    // Round 2 (critic F1/F2) — a bare 'ringing' entry is NOT "on the call":
    // it is the ring surface this cancel exists to collapse. Shielding it
    // made the answered-elsewhere cancel a no-op on every foreground-ringing
    // sibling (registry entries exist at ring time), which then rang the
    // full 45 s and could relay a ring-expiry hangup into the LIVE call.
    // The genuine accept→register window is covered by the latch below.
    if (live && live.callId === callId &&
        live.state !== 'ended' && live.state !== 'failed' && live.state !== 'ringing') {
      console.warn(`[fcm] call-cancel ignored — call is live on this device cid=${callId.slice(0, 8)}`);
      return;
    }
  } catch { /* registry unavailable (early boot) — latch check below still runs */ }
  const acceptedAt = acceptedCallIds.get(callId);
  if (acceptedAt !== undefined && Date.now() - acceptedAt <= ACCEPT_PRESERVE_WINDOW_MS) {
    console.warn(`[fcm] call-cancel ignored — Answer in flight on this device cid=${callId.slice(0, 8)}`);
    return;
  }
  // WI-6.7 — ring identity: a cancel that names a fan-out must not dismiss a
  // NEWER ring for the same room (group rings reuse roomId as the id). Only
  // enforceable when the cached ring carries a ringId; either side lacking
  // one falls back to the historical id-wide dismiss.
  const cancelRingId = typeof data.ringId === 'string' && data.ringId ? data.ringId : undefined;
  if (cancelRingId) {
    try {
      const cache = require('./incomingCallCache') as typeof import('./incomingCallCache');
      const cached = cache.getIncomingCallPayload(callId);
      if (cached?.ringId && cached.ringId !== cancelRingId) {
        console.warn(`[fcm] call-cancel ignored — cancels an older ring id=${callId.slice(0, 8)}`);
        return;
      }
    } catch { /* cache unavailable — id-wide fallback */ }
  }
  // Round 2 (edge F1) — an in-app RINGING sibling has no live socket (the
  // winner's connect evicted it under the shared signalDeviceId), so this
  // push is its ONLY collapse lane; the notification teardown below cannot
  // reach a registry-mounted ring. End the bare ring through the keyed
  // teardown. Scoped to missed!=='1': a caller-gave-up cancel leaves the
  // in-app collapse to the WS hangup lane (connected devices race it, and
  // the ring-expiry path owns the local missed record when disconnected).
  if (data.missed !== '1') {
    try {
      const reg = require('../runtime/callRegistry') as typeof import('../runtime/callRegistry');
      const ringing = reg.getActiveCall();
      if (ringing && ringing.callId === callId && ringing.state === 'ringing') {
        // silentWire — this end acts on the server's own verdict (the ring was
        // answered elsewhere / cancelled); a wire hangup from here could relay
        // an authorized kill into the winner's ACTIVE session.
        reg.endActiveCall({callId: ringing.callId, gen: ringing.gen}, 'ended', 'remote', {silentWire: true});
      }
    } catch { /* registry unavailable — the notif teardown below still runs */ }
  }
  // WI-7.1 — the cancel funnel's APPLY decision (the ignore branches above
  // each warn already); one line ties the teardown to the [CALLSM] lane.
  try {
    const {logCallSm, shortCallId} = require('../runtime/callDiag') as typeof import('../runtime/callDiag');
    logCallSm('notif.cancel.apply', {cid: shortCallId(callId), missed: data.missed === '1'});
  } catch { /* diag unavailable */ }
  try {
    const cn = require('./callNotification') as typeof import('./callNotification');
    await cn.dismissCallNotif(callId);
    try {
      const bridge = require('./callKitBridge') as typeof import('./callKitBridge');
      bridge.reportEnded(callId, 'remoteEnded');
    } catch { /* bridge inert — nothing to tear down */ }
    try {
      const cache = require('./incomingCallCache') as typeof import('./incomingCallCache');
      cache.clearIncomingCallPayload(callId); // tombstones the callId
    } catch { /* cache module unavailable */ }
    clearAcceptedCallId(callId);
    if (data.missed === '1') {
      const fromUserId = typeof data.fromUserId === 'string' && data.fromUserId ? data.fromUserId : undefined;
      let callerName = typeof data.callerName === 'string' ? data.callerName : undefined;
      if (!callerName && fromUserId) {
        try {
          const {resolveDirectPeerName} = require('./mutedLookup') as typeof import('./mutedLookup');
          callerName = (await resolveDirectPeerName(fromUserId)) ?? undefined;
        } catch { /* generic label */ }
      }
      await cn.showMissedCallNotif({
        callId,
        callerName,
        fromUserId,
        conversationId: typeof data.conversationId === 'string' && data.conversationId ? data.conversationId : undefined,
        kind: (typeof data.callKind === 'string' ? data.callKind : 'voice') as import('./callNotification').CallNotifKind,
      });
    }
  } catch (e) {
    console.warn('[fcm] call-cancel handling failed:', (e as Error).message);
  }
}

/**
 * LM-N2 — kind → screen for a server-wake notification tap. Returns true when the
 * kind is a recognised server-event kind (tap consumed), false otherwise.
 *
 * Exactly ONE shell (client tabs / AgentNavigator / CpoNavigator) is mounted at a
 * time and route names are unique per shell, so navigating every candidate is
 * safe: at most one resolves; a miss is a React Navigation no-op warn. The client
 * booking kinds all land on BookingHome, whose focus-resume gate then routes to
 * the in-flight booking's live screen (searching / accepted / tracking / summary).
 */
// LB-N (deep-link) — a client booking wake taps DIRECTLY to the stage screen it
// refers to, using the hydrated bookingId, instead of only landing on BookingHome
// and hoping the focus-resume gate forwards (which `seenRef` can suppress for a
// booking the user already visited). Every target here needs only {bookingId}.
const CLIENT_STAGE_SCREEN: Record<string, string> = {
  'crew-assigned':        'LiveTracking',   // mission DISPATCHED — verify-code window
  'detail-enroute':       'LiveTracking',   // mission PICKUP — en route
  'detail-live':          'LiveTracking',   // mission LIVE — protection active
  'detail-hour-checkin':  'LiveTracking',   // Executive Protection — hourly "all smooth" timeline
  'provider-accepted':    'LiveTracking',   // no mission yet — LiveTracking self-heals (shows "awaiting dispatch")
  'booking-completed':    'MissionComplete',
  'no-provider':          'NoDetail',
  'booking-redispatching':'FindingDetail',
  'agency-no-show':       'TripSummary',
  'refund-issued':        'TripSummary',
  'booking-rejected':     'TripSummary',
  'dispute-resolved':     'TripSummary',
  'family-charge-blocked':'TripSummary',   // B-384 — the cancelled booking's receipt
  'booking-approved':     'OpsRoomReview',
  // B-405 — T-60 start reminder: land on the review screen, which renders the
  // approved/scheduled state and self-advances once dispatch starts.
  'booking-reminder':     'OpsRoomReview',
  'payment-failed':       'BookingHome',
};

function routeServerWakeTap(kind: string, data: Record<string, string | undefined>): boolean {
  const rawId = data.bookingId;
  const bid = typeof rawId === 'string' && /^[0-9a-fA-F][0-9a-fA-F-]{7,63}$/.test(rawId) ? rawId : undefined;
  let candidates: Array<{name: string; params?: unknown}> = [];
  if (kind === 'dispatch-offer') {
    // Issue 40 — ALWAYS pass a params object. The server wake carries only a
    // bookingId (no offer id), and this used to navigate with nothing at all,
    // so IncomingOfferScreen's `const {offerId} = ....params` threw and the
    // ErrorBoundary flashed "Something went wrong". The screen resolves the live
    // offer itself; bookingId is passed for context.
    candidates = [{name: 'IncomingOffer', params: {bookingId: bid}}];
  } else if (kind === 'mission-dispatched' || kind === 'mission-aborted') {
    candidates = [{name: 'CpoMission'}, {name: 'AgentDashboard'}];
  } else if (
    kind === 'mission-complete-requested' || kind === 'mission-hour-checkin' ||
    // B-377/B-378 — officer answered / client cancelled: both are agency-board events.
    kind === 'mission-accepted' || kind === 'mission-declined' || kind === 'mission-cancelled'
  ) {
    // Executive Protection hourly confirmations land the agency on the missions board —
    // the mission detail there shows the live hourly timeline.
    candidates = [{name: 'OrgMissions'}];
  } else if (kind === 'sos-cpo-alert') {
    // Recipients are crew (CPO shell) AND the principal (client shell).
    candidates = [
      {name: 'CpoMission'},
      // BB-3 (2026-08-15 back audit) — initial: false on EVERY SecureTab
      // candidate: flagless nesting re-roots the lazy Booking stack at the
      // target on a cold start, where popToTop()/back are silent no-ops
      // (MissionComplete was a genuine dead end: no back, gesture off).
      {name: 'SecureTab', params: {screen: bid ? 'LiveTracking' : 'BookingHome', initial: false, params: bid ? {bookingId: bid} : undefined}},
    ];
  } else if (kind === 'payout-settled') {
    candidates = [{name: 'Earnings'}, {name: 'CpoMe'}];
  } else if (kind === 'agent-approved' || kind === 'agent-rejected') {
    candidates = [{name: 'AgentDashboard'}];
  } else if (kind === 'incident-submitted' || kind === 'incident-status') {
    // vs2 item 16 — "open the incident review screen when tapped".
    //
    // These wakes used to route to two BARE route names, and the incident
    // screens live only inside the Departmental shell's Incident tab, so a
    // manager landed on the channel directory and the reporter on a mission —
    // the B-414 dropped-navigate class. Resolve through the shell ladder
    // instead, and pick the leaf by AUDIENCE: `incident-submitted` goes to
    // managers (the review screen), `incident-status` goes to the submitter
    // (their own report). No id → open the tab at its role-branched root.
    const rawInc = data.incidentId;
    const incId = typeof rawInc === 'string' && /^[0-9a-fA-F][0-9a-fA-F-]{7,63}$/.test(rawInc)
      ? rawInc : undefined;
    void (async () => {
      try {
        const {navigationRef, mountedTreeHasRoute} =
          require('@navigation/navigationRef') as typeof import('@navigation/navigationRef');
        const nav = navigationRef as unknown as {isReady?: () => boolean};
        // Wait for the DESTINATION, not just for the container. `isReady()`
        // flips true while the Auth tree is still mounted on a cold start, so
        // a killed-app tap used to resolve against a shell that had not
        // rendered yet and die silently.
        for (let i = 0; i < 60; i++) {
          if ((!nav.isReady || nav.isReady()) && mountedTreeHasRoute('Main')) {break;}
          await new Promise(r => setTimeout(r, 250));
        }
        if (nav.isReady && !nav.isReady()) {return;}
        // Asymmetric ON PURPOSE. `IncidentDetail` takes `{incidentId}` and
        // fetches, so the manager lands on the exact report. `MyIncidentDetail`
        // takes a whole `{report}` object, which a push cannot carry (and
        // should not — that is incident content), so the reporter lands on
        // their own list, which fetches and shows the updated row.
        //
        // Routed through messengerDeepLink, NOT a departmentalEntry ladder:
        // those walk `getParent()` from the navigation object they are handed,
        // and the container REF has no parent and reports only the root state
        // — so from a push every ladder branch except the client-only
        // MessengerTab one is unreachable, and agency/CPO taps died in silence.
        // This table resolves per shell from the auth store instead (B-258).
        // Branch on the AUDIENCE first, then on whether we have an id.
        // `incident-submitted` goes to managers, so its id-less fallback is the
        // manager QUEUE — sending them to MyIncidents (a member's own reports)
        // would land them on a permanently empty screen, and that fallback is
        // not rare: it is every delivery that missed the Redis blob window.
        const target = kind === 'incident-submitted'
          ? (incId ? 'IncidentDetail' : 'IncidentQueue')
          : 'MyIncidents';
        const tParams = target === 'IncidentDetail' ? {incidentId: incId as string} : {};
        // vs2 edge A1 — point the workspace surface at the org this incident
        // belongs to BEFORE navigating, or a multi-org manager reads it with
        // their other org stamped on the request and lands on an empty screen.
        // Covers the id-less IncidentQueue fallback too — without that arm the
        // fallback still opens the WRONG org's queue. `incident-status` carries
        // no orgId by design (MyIncidents is a cross-org self-read), so this is
        // a no-op there.
        const {adoptOrgContextFromWake} =
          require('@/store/adoptOrgContext') as typeof import('@/store/adoptOrgContext');
        const adopted = await adoptOrgContextFromWake(data.orgId);
        // A LATER tap won the context while this one was settling — navigating
        // now would deep-link THIS incident's id against THAT org, which is the
        // empty screen the scoping exists to remove.
        if (adopted === 'superseded') {
          console.warn(`[notifee] incident tap superseded kind=${kind}`);
          return;
        }
        const routed = navigateToMessengerScreen(navigationRef as never, target, tParams, {initial: false});
        // WARN, not log: `transform-remove-console` strips `log` from release
        // builds, and this lane's failures are invisible without it. Log the
        // RESULT — the readiness loop can time out and fall through here.
        console.warn(`[notifee] incident tap kind=${kind} target=${target} routed=${routed} org=${adopted}`);
      } catch (e) {
        console.warn(`[notifee] incident tap route failed kind=${kind}: ${(e as Error).message}`);
      }
    })();
    return true;
  } else if (
    // R13-2 — enterprise join-loop wakes. Enumerated (not prefix-matched) so
    // the parity scan sees each kind. Admin → Approvals inbox; applicant →
    // their own ApprovalStatus. B-258 — NO hard-coded shell path here: the
    // messengerDeepLink table resolves the route per shell (client/agency/cpo),
    // reading the auth store at dispatch time. Self-contained readiness poll,
    // same shape as the shared block below.
    kind === 'enterprise.join.requested' || kind === 'enterprise.join.approved' ||
    kind === 'enterprise.join.declined' || kind === 'enterprise.invite.received' ||
    kind === 'enterprise.invite.accepted'
  ) {
    // Admin-side kinds → Approvals inbox; invitee/applicant kinds → their own
    // ApprovalStatus (which surfaces open invites as well as request state).
    const target = kind === 'enterprise.join.requested' || kind === 'enterprise.invite.accepted'
      ? 'Approvals' as const : 'ApprovalStatus' as const;
    void (async () => {
      try {
        const {navigationRef} = require('@navigation/navigationRef') as typeof import('@navigation/navigationRef');
        const nav = navigationRef as unknown as {isReady?: () => boolean; navigate: (n: string, p?: unknown) => void};
        for (let i = 0; i < 40; i++) {
          if (!nav.isReady || nav.isReady()) {break;}
          await new Promise(r => setTimeout(r, 250));
        }
        if (nav.isReady && !nav.isReady()) {return;} // gave up (~10s) — resume gates cover it
        // vs2 edge A2 — same contract as the incident lane above: a two-org
        // admin tapping org-B's "join request waiting" used to read org-A's
        // (usually empty) inbox. Only the ADMIN-side kinds carry an orgId, so
        // ApprovalStatus — the caller's own cross-org status screen — is
        // untouched by construction.
        const {adoptOrgContextFromWake} =
          require('@/store/adoptOrgContext') as typeof import('@/store/adoptOrgContext');
        const adopted = await adoptOrgContextFromWake(data.orgId);
        if (adopted === 'superseded') {
          console.warn(`[notifee] server-wake tap superseded kind=${kind}`);
          return;
        }
        navigateToMessengerScreen(nav as never, target, {}, {initial: false});
        console.warn(`[notifee] server-wake tap routed kind=${kind} org=${adopted}`);
      } catch { /* nav not ready — the shell's own resume logic covers it */ }
    })();
    return true;
  } else if (
    // Enumerated (not prefix-matched) so serverWakeTapRouting's static
    // producer↔consumer parity scan sees each kind.
    kind === 'pro-application-received' || kind === 'pro-proposal-ready' ||
    kind === 'pro-application-rejected' || kind === 'pro-application-cancelled' ||
    kind === 'pro-plan-activated' || kind === 'pro-ops-message' || kind === 'pro-mission-update'
  ) {
    // Bravo Secure Pro application wakes carry an applicationId (not a
    // bookingId). Proposal-ready deep-links into the proposal itself; every
    // other stage lands on the status screen, which self-heals (it fetches
    // the latest application and shows the right CTA — incl. ACTIVE's
    // Pro-dashboard entry).
    const rawApp = data.applicationId;
    const appId = typeof rawApp === 'string' && /^[0-9a-fA-F][0-9a-fA-F-]{7,63}$/.test(rawApp) ? rawApp : undefined;
    const proScreen = kind === 'pro-proposal-ready' && appId ? 'SecureProProposal'
      : kind === 'pro-mission-update' ? 'SecureProMissions'
      : 'SecureProStatus';
    candidates = [{name: 'SecureTab', params: {
      screen: proScreen,
      initial: false,
      params: proScreen === 'SecureProProposal' ? {applicationId: appId} : undefined,
    }}];
  } else if (kind === 'dispute-opened') {
    // Review finding — this kind wakes the AGENCY (booking.service.openDispute →
    // disputeOpened(provider)). Routing it through CLIENT_STAGE_SCREEN sent it to
    // SecureTab/TripSummary, which does not exist in the agency shell: the banner
    // drew and the tap did nothing. Agency shell first, client second (only one
    // shell is ever mounted, so the miss is a no-op).
    candidates = [
      {name: 'OrgMissions'},
      {name: 'SecureTab', params: {screen: bid ? 'TripSummary' : 'BookingHome', initial: false, params: bid ? {bookingId: bid} : undefined}},
    ];
  } else if (kind === 'family-invite') {
    // R-3 — invitee responds from Profile (the invites card lives there). The
    // invite targets a PHONE, so the invitee may be on the CPO shell instead.
    candidates = [{name: 'ProfileTab'}, {name: 'CpoMe'}];
  } else if (kind === 'family-invite-accepted') {
    // R-3 — holder manages members from the Secure Pro members screen.
    candidates = [{name: 'SecureTab', params: {screen: 'SecureProMembers', initial: false}}];
  } else if (kind === 'family-credit-requested' || kind === 'family-quota-threshold') {
    // HOLDER-side quota wakes. Both are decisions/oversight that live on the
    // members screen: the pending-request panel sits at the top of it, and the
    // threshold warning is answered by looking at that member's row.
    candidates = [{name: 'SecureTab', params: {screen: 'SecureProMembers', initial: false}}];
  } else if (kind === 'family-credit-decided' || kind === 'family-quota-changed') {
    // MEMBER-side quota wakes → their own profile, where FamilyQuotaCard shows
    // the new limit and any open request. A member may be on the CPO shell, so
    // that fallback is kept exactly as the family-invite route does.
    candidates = [{name: 'ProfileTab'}, {name: 'CpoMe'}];
  } else if (kind === 'psession-started' || kind === 'psession-ended' || kind === 'pro-cpo-changed') {
    // Protection-session CUSTOMER wakes → the Secure shell. started/ended open
    // the live session screen; a CPO change opens the assigned-team screen.
    const screen = kind === 'pro-cpo-changed' ? 'ProAssignedTeam' : 'ProLiveMission';
    candidates = [{name: 'SecureTab', params: {screen, initial: false}}];
  } else if (kind === 'psession-new' || kind === 'psession-sos' || kind === 'psession-conn-lost') {
    // Protection-session CPO wakes → the CPO protection surface (self-heals to
    // the right session). Behind the PMC gate; CpoMission is the shell fallback.
    const rawSid = data.sessionId;
    const sid = typeof rawSid === 'string' && /^[0-9a-fA-F][0-9a-fA-F-]{7,63}$/.test(rawSid) ? rawSid : undefined;
    candidates = [{name: 'CpoProtection', params: sid ? {sessionId: sid} : undefined}, {name: 'CpoMission'}];
  } else if (CLIENT_STAGE_SCREEN[kind]) {
    const screen = bid ? CLIENT_STAGE_SCREEN[kind] : 'BookingHome';
    candidates = [{name: 'SecureTab', params: {screen, initial: false, params: bid ? {bookingId: bid} : undefined}}];
  } else {
    return false;
  }
  // Poll for nav-readiness so a COLD-START tap (app launched from the notification)
  // still deep-links once the container mounts, instead of silently dropping the
  // intent. Fire-and-forget — the caller only needs to know the kind was consumed.
  void (async () => {
    try {
      const {navigationRef} = require('@navigation/navigationRef') as typeof import('@navigation/navigationRef');
      const nav = navigationRef as unknown as {isReady?: () => boolean; navigate: (n: string, p?: unknown) => void};
      // Wait up to ~10s for the container to mount — a killed-app cold start (the
      // exact "close the app then tap the notification" case) can take several
      // seconds to boot the NavigationContainer on a large bundle; a 3s cap dropped
      // the deep-link on slow devices.
      for (let i = 0; i < 40; i++) {
        if (!nav.isReady || nav.isReady()) {break;}
        await new Promise(r => setTimeout(r, 250));
      }
      if (nav.isReady && !nav.isReady()) {return;} // gave up (~10s) — resume gates cover it
      for (const c of candidates) {
        try { nav.navigate(c.name, c.params); } catch { /* shell without this route */ }
      }
      console.log(`[notifee] server-wake tap routed kind=${kind}`, bid ?? data.missionId ?? '');
    } catch { /* nav not ready — the shell's own resume logic covers it */ }
  })();
  return true;
}

/**
 * NA-01 — the FCM voip-wake never carries SDP / caller device id, and (1:1)
 * never carries a conversationId, so a notification drawn from the wake has
 * none of them in its `data` block. The WS `call.offer` put all three in the
 * incoming-call cache; read them back before navigating. Exported for tests.
 */
export function resolveIncomingCallRoute(
  callId: string,
  data: {incomingSdp?: string; remoteDeviceId?: string; conversationId?: string; fromUserId?: string},
): {conversationId: string; remoteDeviceId: number; incomingSdp?: string} {
  const parsed = Number.parseInt(data.remoteDeviceId ?? '', 10);
  let deviceId: number | undefined = Number.isFinite(parsed) ? parsed : undefined;
  let sdp = data.incomingSdp;
  let convoId = data.conversationId;
  try {
    const cache = require('./incomingCallCache') as typeof import('./incomingCallCache');
    const cached = cache.getIncomingCallPayload(callId);
    if (cached) {
      sdp      = sdp      ?? cached.incomingSdp;
      deviceId = deviceId ?? cached.remoteDeviceId;
      convoId  = convoId  ?? cached.conversationId;
      if (sdp) {console.log('[notifee] hydrated offer SDP from cache callId=', callId);}
    }
  } catch { /* cache unavailable — offer replay will deliver it */ }
  return {
    conversationId: convoId ?? `direct:${data.fromUserId ?? ''}`,
    remoteDeviceId: deviceId ?? 1,
    incomingSdp:    sdp,
  };
}

let notifeeHandlersInstalled = false;
function installNotifeeHandlers(): void {
  if (notifeeHandlersInstalled) {return;}
  notifeeHandlersInstalled = true;

  const cn = require('./callNotification') as typeof import('./callNotification');
  const {EventType, notifee, parseCallAction, dismissCallNotif} = cn;
  type NotifeeEvent = Parameters<Parameters<typeof notifee.onForegroundEvent>[0]>[0];

  const handle = async (event: NotifeeEvent, source: 'fg' | 'bg') => {
    const {type, detail} = event;
    if (type !== EventType.ACTION_PRESS && type !== EventType.PRESS) {return;}
    const data = (detail.notification?.data ?? {}) as Record<string, string | undefined>;
    // Audit PUSH-B3 (2026-07-02): a msg-wake TAP has no callId, so it used to
    // fall through to the OS default (open the app wherever it was). Deep-link
    // straight to the conversation so ChatScreen mounts and pulls the queued
    // envelopes immediately — shrinking the "empty thread until WS reconnects"
    // window on a killed-app tap. We deliberately do NOT decrypt in the
    // headless FCM VM (that reintroduces the 2nd-VM contention the team removed
    // for stability); the fast foreground pull on this navigation is the safe
    // path.
    if (data.kind === 'msg-wake') {
      const convId = data.conversationId || '';
      const pressId = detail.pressAction?.id ?? '';

      // N-10 — inline Mark-as-read. B-361 — enqueue-then-drain like Reply, so
      // a pre-hydration/cold-VM press retries durably instead of silently
      // receipting nothing (the drain waits for store hydration; markRead's
      // envelope collection is empty before it).
      if (pressId.startsWith('read-') && convId) {
        try {
          const {enqueuePendingAction} = require('./pendingActions') as typeof import('./pendingActions');
          await enqueuePendingAction({t: 'read', convId});
          // B-326 — cold-VM parity: configure from persisted before acting.
          await ensureRuntimeForNotifAction();
          await drainPendingActions();
        } catch { /* runtime not up — the queued entry drains on next connect */ }
        try {
          const {dismissMessageNotif} = require('./callNotification') as typeof import('./callNotification');
          await dismissMessageNotif(convId);
        } catch { /* notifee unavailable */ }
        return;
      }
      // N-10 — inline Reply. B-361 — the reply now ALWAYS goes through the
      // durable pending-actions queue and the one shared drain (which resolves
      // group-ness, passes the explicit 1:1 peer, waits for store hydration and
      // dedupes retries onto a stable bubble id). The old direct sendText here
      // threw "production mode requires explicit peer address" on any
      // not-yet-hydrated conversation and DROPPED the typed text on failure.
      if (pressId.startsWith('reply-') && convId) {
        const input = (detail as unknown as {input?: string}).input;
        if (typeof input === 'string' && input.trim()) {
          try {
            const {enqueuePendingAction} = require('./pendingActions') as typeof import('./pendingActions');
            await enqueuePendingAction({t: 'reply', convId, text: input.trim(), peerUserId: data.senderUserId || undefined});
            // B-326 — cold-VM parity: boot the runtime before draining so the
            // dispatch has an outbox to land in.
            await ensureRuntimeForNotifAction();
            await drainPendingActions();
            const {dismissMessageNotif} = require('./callNotification') as typeof import('./callNotification');
            await dismissMessageNotif(convId);
          } catch (e) {
            console.warn('[notifee] inline reply failed:', (e as Error).message);
          }
        }
        return;
      }

      // B-325 — start ingest AT TAP TIME, in parallel with the nav-ready wait
      // below. The banner was drawn without the message (the killed path never
      // decrypts), and waiting for the ChatScreen mount pull is what made the
      // opened thread render 2–3 s stale. Navigation never blocks on this —
      // except the B-324 guessed-conversation re-route, which is the one
      // caller that needs the pull's outcome.
      const pullSettled = startTapTimePull();

      // Body tap → deep-link to the thread. M-05 — only open a thread that
      // EXISTS locally (the old fallback minted a phantom 1:1). N-07/N-08 — the
      // Chat route REQUIRES `name` + `isGroup`; without them ChatScreen crashed
      // at render (`initials(undefined)` → "Chat hit an error"). Resolve both
      // from the store (or persisted slice on cold boot) and pass them.
      let exists = false;
      let name: string | undefined;
      let isGroup = false;
      // F4 — resolved alongside name/isGroup and consulted at every navigate
      // below: a department channel is a `type: 'group'` conversation, and
      // ChatScreen (the old destination) shows call buttons the PDF bans there.
      let dept: import('./deptChannelTarget').DeptConversationRoute | null = null;
      if (convId) {
        try {
          const {useMessengerStore} = require('@/modules/messenger/store/messengerStore') as
            typeof import('@/modules/messenger/store/messengerStore');
          const conv = useMessengerStore.getState().conversations[convId];
          if (conv) {
            exists = true;
            name = conv.name;
            isGroup = conv.type === 'group' || conv.type === 'ops_channel';
          }
        } catch { /* store unavailable — fall through to the persisted check */ }
        if (!exists) {
          // Cold boot: the live store may not be hydrated yet — read name +
          // group-ness from the persisted owner slice before giving up.
          try {
            const {resolveConversationMeta} = require('./mutedLookup') as typeof import('./mutedLookup');
            const meta = await resolveConversationMeta(convId);
            if (meta) { exists = true; name = meta.name; isGroup = meta.isGroup; }
          } catch { exists = false; }
        }
        // F4 — and WHICH KIND of group. Resolved here, next to the meta it
        // belongs with, so both navigate sites below read one answer.
        dept = await resolveDeptRouteForTap(convId);
      }
      try {
        const {navigationRef} = require('@navigation/navigationRef') as typeof import('@navigation/navigationRef');
        // N-09 — wait for the navigator on a cold-launch tap (the call path
        // already does this); otherwise the deep-link is a silent no-op.
        const navReady = navigationRef as unknown as {isReady?: () => boolean};
        const t0 = Date.now();
        // B-227 — a killed-state cold launch can take 10–25 s (P1-BR-2); wait
        // 20 s like the call path, not 8 s, and re-check readiness AFTER the
        // loop. Navigating a non-ready ref is a silent no-op that DROPS the
        // Chat deep-link, so bail instead — the foreground mount pull still
        // surfaces the message.
        while (Date.now() - t0 < NAV_READY_WAIT_MS) {
          if (navReady?.isReady?.()) {break;}
          await new Promise(r => setTimeout(r, 100));
        }
        if (navReady?.isReady && !navReady.isReady()) {
          console.warn('[notifee] nav not ready after 20s — msg deep-link deferred to mount pull');
          return;
        }
        // Notif-latency C1 (docs/audits/NOTIF_TAP_TO_MESSAGE_LATENCY_2026-08-01.md)
        // — navigate FIRST, refine LATER. The B-324 guess re-route below used
        // to hold navigation for up to GUESS_ROUTE_PULL_WAIT_MS (6 s), so the
        // user sat on whatever screen the app opened on while the pull ran.
        // Route to the best-known target immediately; the pull's verdict can
        // only improve on it, never gate it.
        // B-85 — `initial: false` is LOAD-BEARING (see missed-call
        // handler above): it makes the messenger stack seed
        // MessengerHome BENEATH the deep-linked Chat so back returns
        // to the chat list instead of the Dashboard.
        const immediateChat = !!(convId && exists);
        if (immediateChat) {
          // F4 — Chat for an ordinary thread, DepartmentChat for a channel.
          navigateToThread(navigationRef, {conversationId: convId, name, isGroup}, dept);
        } else {
          navigateToMessengerScreen(navigationRef as never, 'MessengerHome', {});
        }
        // B-324 — when the banner's conversation was a sealed-sender GUESS
        // (`convGuess`, or no conversation at all), the guess may be a 1:1
        // while the message was really a GROUP post. Wait (bounded) for the
        // tap-time pull and RE-route to where the sender's newest message
        // actually landed — but only when it names a different thread AND the
        // user is still where this tap put them (a tap seconds ago must never
        // hijack navigation the user has since done themselves).
        if ((data.convGuess === '1' || !convId) && data.senderUserId) {
          const target = await resolveTapTargetAfterPull(data.senderUserId, pullSettled);
          // `target.id === convId` is only a no-op when the immediate route
          // above already opened that chat — from MessengerHome (conversation
          // not locally resolvable at tap time) a confirmed guess is still a
          // NEW destination and must navigate.
          if (!target || (immediateChat && target.id === convId)) {return;}
          const current = (navigationRef as unknown as {
            getCurrentRoute?: () => {name?: string; params?: unknown} | undefined;
          }).getCurrentRoute?.();
          const currentParams = (current?.params ?? {}) as {
            conversationId?: string; groupConversationId?: string;
          };
          // DepartmentChat carries the conversation as `groupConversationId`;
          // Chat carries it as `conversationId`. Reading only the latter made
          // the guard fail on channels even once the name matched.
          const currentConvId = currentParams.groupConversationId ?? currentParams.conversationId;
          // D3 — ask "are we still on the route the IMMEDIATE navigate chose?",
          // derived from the same dept verdict that drove it, instead of
          // hard-coding 'Chat'. The directory has no conversation param, so
          // there is nothing to compare for it.
          const immediateRoute = threadRouteName(dept);
          // No observable current route (ref shape without getCurrentRoute, or
          // nothing focused yet) → we cannot prove the user navigated away —
          // keep B-324's re-route rather than silently lose it.
          const stillOnTapTarget = !current ? true : (immediateChat
            ? current.name === immediateRoute
              && (immediateRoute === 'DepartmentChannels' || currentConvId === convId)
            : current.name === 'MessengerHome');
          if (stillOnTapTarget) {
            // F4 — the re-route obeys the SAME department rule as the immediate
            // one. Routing it straight to 'Chat' here is how the rule would have
            // lapsed on half the paths (the pull can land on a channel post).
            const reroutedDept = await resolveDeptRouteForTap(target.id);
            navigateToThread(navigationRef, {conversationId: target.id, name: target.name, isGroup: target.isGroup}, reroutedDept);
          }
        }
      } catch { /* nav not ready on cold boot — lands on home, the mount pull still runs */ }
      return;
    }
    // LM-N2 — server-wake TAP deep-links. Previously every non-chat/call tap fell
    // through to the OS default ("open the app wherever it was"), so an offer /
    // mission / payout / SOS notification never landed the user on the right
    // screen. Route by kind; each shell only mounts its own route names, so we
    // try candidates in order (React Navigation no-ops with a warn on a miss).
    if (typeof data.kind === 'string' && routeServerWakeTap(data.kind, data)) {return;}
    // P1-7 — a Missed-call banner also carries a callId, but it must NOT fall
    // into the CALL branch below (that opened a GHOST incoming CallScreen for a
    // dead call). Deep-link to the caller's 1:1 thread when known, else the
    // Calls log.
    if (data.kind === 'missed-call') {
      await handleMissedCallTap(data);
      return;
    }
    const callId = data.callId;
    if (!callId) {return;}

    const pressId = detail.pressAction?.id ?? '';
    const action  = parseCallAction(pressId);
    console.log(`[notifee] ${source} event press=${pressId} action=${action?.outcome ?? 'open'} callId=${callId}`);
    if (action?.outcome !== 'decline') {
      // [CALLLAT] (audit Step 0, §1.2 N1) — the notifee Answer/open tap is the
      // user's origin for this lane (Telecom twin: navigateToIncomingCall);
      // `freshAfterMs` keeps an earlier ring/offer row's t0, never a stale one.
      const {logCallLat} = require('../runtime/callDiag') as typeof import('../runtime/callDiag');
      // Same group test as callNotification's action router (isGroup flag OR a group- kind).
      const latIsGroup = data.isGroup === '1' || (data.kind ?? '').startsWith('group-');
      const latId = latIsGroup ? (data.conversationId ?? callId) : callId;
      logCallLat(latIsGroup ? 'grp-join' : '1to1-in', latId, 'notif:answer-tap', {src: 'notifee', action: String(action?.outcome ?? 'open')}, {freshAfterMs: 90_000});
    }

    // Always dismiss the notif on any user interaction — the in-app
    // ring screen takes over from here (or the call's already over).
    await dismissCallNotif(callId);

    // Review round 1 (edge D1) — a card-driven event for a DEAD call is by
    // construction stale: no lane draws a card for a tombstoned id, so the
    // card this tap came from predates the decline/cancel that tombstoned
    // it (a queued notifee event delivered late). Dropping it here beats
    // letting the ring screen mount and the watchdog kill it a second
    // later — and for groups it is the only gate (the group lane has no
    // dead-offer watchdog). Deliberately NOT extended to a liveness check
    // on the registries: an on-screen accept of a WS-delivered re-ring is
    // legitimate while this same id is tombstoned from an older decline,
    // and that flow never passes through here (no card exists for it).
    try {
      const cache = require('./incomingCallCache') as typeof import('./incomingCallCache');
      const reg = require('@/modules/messenger/runtime/callRegistry') as typeof import('@/modules/messenger/runtime/callRegistry');
      // R2-1 — the third signal covers the group-END door: END no longer
      // tombstones (a reused roomId must stay ringable — B-502), so the
      // consumed-room marker is what stops a stale queued event from
      // re-joining the call this device just left. Any fresh FCM seed
      // self-heals the marker, so a genuine re-invite's card passes.
      if (cache.isIncomingCallDead(callId) || reg.wasRecentlyEnded(callId) || cache.isGroupRingConsumed(callId)) {
        console.warn('[CALLDIAG] [notifee] dropping stale card event for dead callId=', callId.slice(0, 8));
        return;
      }
    } catch { /* cache/registry unavailable — proceed as before */ }

    // Decline: send `call.hangup` to peer so the caller stops ringing
    // immediately instead of waiting for the 30s no-answer timeout,
    // then dismiss the notification. Group calls get `sfu.ring.decline`
    // — TODO when we have the SFU client wired (1:1 was the urgent
    // gap). Best-effort: if the WS isn't connected (cold launch into
    // notif tap), we silently fall through and the caller will see
    // no-answer, which is the same fail-soft behaviour as before.
    if (action?.outcome === 'decline') {
      try {

        const cache = require('./incomingCallCache') as typeof import('./incomingCallCache');
        const payload = cache.getIncomingCallPayload(callId);
        if (data.isGroup === '1') {
          // Audit PUSH-B6 (2026-07-02): group-call decline was a no-op TODO —
          // the caller kept ringing until timeout. Send sfu.ring.decline so the
          // host stops ringing this recipient. The server's decline gate needs
          // the per-recipient ring roomToken (carried in the push data); when
          // absent (or WS down on cold launch) this falls through to no-answer,
          // the same fail-soft as before.
          const roomId    = data.roomId ?? payload?.roomId;
          const roomToken = data.roomToken;
          // NA-03 F4 + WI-5.4 — the durable decline now covers BOTH failure
          // shapes: no transport/roomId AND a send that THROWS (the old
          // structure put the enqueue in the `else` of a truthiness check, so
          // a thrown send unwound past it — decline lost, caller kept
          // ringing, and the cache/latch clears below were skipped too).
          if (roomId) {
            await sendCallControlDurable(
              {
                event: 'sfu.ring.decline',
                data: {roomId, conversationId: data.conversationId ?? payload?.conversationId ?? '', ...(roomToken ? {roomToken} : {})},
              },
              {t: 'decline', callId, kind: 'group', roomId},
              '[notifee] group decline →',
            );
          } else {
            console.log('[notifee] group decline → no roomId, queuing durable decline');
            try {
              const {enqueuePendingAction} = require('./pendingActions') as typeof import('./pendingActions');
              await enqueuePendingAction({t: 'decline', callId, kind: 'group', roomId: callId});
            } catch (e2) { console.warn('[notifee] group decline enqueue failed:', (e2 as Error).message); }
          }
          cache.clearIncomingCallPayload(callId);
          clearAcceptedCallId(callId);
        } else {
          // B-228 — the in-memory cache is empty when the process restarted
          // between the FCM wake and the tap, but data.fromUserId round-trips on
          // the notification. Fall back to it (the slim bundle handler and the
          // group branch above already do) so a cold-cache direct decline still
          // stops the caller ringing instead of the old "dismiss only" 45s
          // ring-out.
          const peerUserId = payload?.fromUserId ?? data.fromUserId;
          if (peerUserId) {
            // WI-5.4 — durable on ANY send failure, same as the group branch.
            await sendCallControlDurable(
              {
                event: 'call.hangup',
                data: {
                  callId,
                  to: {userId: peerUserId, deviceId: payload?.remoteDeviceId ?? (Number(data.remoteDeviceId) || 1)},
                  reason: 'declined',
                },
              },
              {t: 'decline', callId, kind: 'direct', peerUserId},
              '[notifee] decline →',
            );
            cache.clearIncomingCallPayload(callId);
            clearAcceptedCallId(callId);
          } else {
            console.log('[notifee] decline tapped — no payload, dismiss only');
          }
        }
      } catch (e) {
        console.warn('[notifee] decline hangup failed:', (e as Error).message);
      }
      // Also dismiss any system-UI Telecom display that showed alongside
      // the notifee notif so both surfaces clear together.
      try {

        const bridge = require('./callKitBridge') as typeof import('./callKitBridge');
        bridge.reportEnded(callId, 'declined');
      } catch { /* bridge inactive — nothing to dismiss */ }
      return;
    }

    // Accept OR body tap → bring the app to foreground and navigate
    // to the right ring screen. The screen mounts and runs its own
    // accept logic on top of the live WS frames the gateway is
    // already streaming.
    //
    // Dedupe: a Telecom Accept event AND a notifee Accept tap can
    // both fire for the same callId on Android FullScreenIntent
    // builds. Without `markAccepted`, both navigation calls mount
    // CallScreen sequentially → the dispatcher's
    // `registerSignalling` overwrite-warns and the FIRST hook's
    // accept() may have already sent `call.answer`. The SECOND
    // accept() then sends ANOTHER `call.answer` → caller's
    // setRemoteDescription rejects on the duplicate and the call
    // sticks in have-local-offer.
    //
    // WI-4.4 — that dedupe belongs to a REAL Answer. It used to be spent on
    // any interaction, so tapping the notification body to see who was calling
    // burned it, and the Answer the user pressed a moment later hit the
    // "already accepted" branch: no navigation, no autoAccept, a dead button.
    // A body tap gets its own dedupe instead, which an Answer never consults.
    const isAnswerAction = action?.outcome === 'accept';
    if (isAnswerAction) {
      if (!markAccepted(callId)) {
        console.log('[notifee] navigate skipped (already accepted) callId=', callId);
        return;
      }
      // B-102 A1 — record EXPLICIT Answer taps (not body taps) so the WS offer
      // navigation can re-assert autoAccept if it lands second and replaces
      // this navigation's params.
      explicitAcceptIds.set(callId, Date.now());
    } else if (!markBodyTapNavigated(callId)) {
      console.log('[notifee] navigate skipped (body tap already routed) callId=', callId);
      return;
    }
    try {

      const {navigationRef} = require('@navigation/navigationRef') as typeof import('@navigation/navigationRef');
      // Defer until nav is ready — when launched from a killed state
      // this fires before RootNavigator mounts, so we poll briefly.
      const waitReady = async (msMax: number): Promise<boolean> => {
        const t0 = Date.now();
        while (Date.now() - t0 < msMax) {
          if ((navigationRef as unknown as {isReady?: () => boolean})?.isReady?.()) {return true;}
          await new Promise(r => setTimeout(r, 100));
        }
        return false;
      };
      // P1-BR-2 — cold-launch nav can take 10–25 s; raise the wait to 20 s (the
      // poll loop is the retry). On abandon, clear the accept latch (P3) so a
      // follow-up Telecom answer for the same callId isn't silently dropped.
      const navT0 = Date.now();
      const ready = await waitReady(NAV_READY_WAIT_MS);
      if (ready) {
        // [CALLLAT] (audit Step 0, §1.2 N1) — how long the notifee Answer
        // waited for the navigator (cold start = the whole app boot).
        const {logCallLat} = require('../runtime/callDiag') as typeof import('../runtime/callDiag');
        const latIsGroup = data.isGroup === '1' || (data.kind ?? '').startsWith('group-');
        logCallLat(latIsGroup ? 'grp-join' : '1to1-in', latIsGroup ? (data.conversationId ?? callId) : callId, 'nav:ready', {waitMs: Date.now() - navT0, src: 'notifee'});
      }
      if (!ready) {
        console.warn('[notifee] nav not ready after 20s — abandoning route');
        // WI-4.3 — release the navigate dedupe only; the Answer intent survives.
        releaseAcceptDedupe(callId);
        return;
      }

      // P1-BR-2 — the notification's Answer button (accept-<callId>) means
      // "answer now"; pass autoAccept so the screen accepts once the offer SDP
      // lands (Wave 3 consumes it) instead of showing a second Accept button.
      // A body/full-screen tap (action === null) still lands on the ring UI —
      // unless the user ALREADY answered (WI-4.4: the FSI body press can land
      // after the Answer event; RN6 navigate replaces params, so navigating
      // with autoAccept false here would un-answer the call).
      const autoAccept = isAnswerAction || wasCallExplicitlyAccepted(callId);
      const isGroup = data.isGroup === '1';
      if (isGroup) {
        navigateToMessengerScreen(navigationRef as never, 'IncomingGroupCallScreen', {
          roomId:         data.roomId ?? '',
          conversationId: data.conversationId ?? '',
          // P1-BR-1 — echo the per-recipient room token so the group accept
          // path can `sfu.join` the host's room (not create a new one).
          roomToken:      data.roomToken ?? '',
          callType:       data.kind === 'group-video' ? 'video' : 'voice',
          callerName:     data.callerName ?? 'Bravo contact',
          fromUserId:     data.fromUserId ?? '',
          autoAccept,
        });
        console.log('[notifee] navigated → IncomingGroupCallScreen room=', data.roomId);
      } else {
        // B-102 A1 — the FCM voip-wake data never carries the offer SDP, so
        // this navigation used to land {incomingSdp: undefined} and CLOBBER
        // the SDP the WS offer navigation had already delivered (RN6
        // navigate() replaces params) → auto-accept effect starved, buttons
        // dead. Hydrate from the incoming-call cache (the warm WS path and
        // the Telecom path both seed it) — same asymmetry fix the Telecom
        // Answer path already had.
        const route = resolveIncomingCallRoute(callId, {
          incomingSdp:    data.incomingSdp,
          remoteDeviceId: data.remoteDeviceId,
          conversationId: data.conversationId,
          fromUserId:     data.fromUserId,
        });
        navigateToMessengerScreen(navigationRef as never, 'CallScreen', {
          callType:       data.kind === 'video' ? 'video' : 'voice',
          isIncoming:     true,
          conversationId: route.conversationId,
          callId,
          remoteUserId:   data.fromUserId,
          remoteDeviceId: route.remoteDeviceId,
          incomingSdp:    route.incomingSdp,
          autoAccept,
        });
        console.log('[notifee] navigated → CallScreen incoming callId=', callId);
      }
    } catch (e) {
      console.warn('[notifee] navigate failed:', (e as Error).message);
    }
  };

  notifee.onForegroundEvent(ev => {
    // B-710 — a swipe-away must retire the card accumulator and the group
    // membership, or already-dismissed previews come back under the next
    // message and the summary counts rows that are gone. `handle` filters to
    // PRESS/ACTION_PRESS, so this cannot live inside it.
    try {
      const {noteMsgDismissal} = require('./callNotification') as typeof import('./callNotification');
      noteMsgDismissal(ev);
    } catch { /* dismissal bookkeeping is never load-bearing */ }
    void handle(ev, 'fg');
  });
  // WI-4.2 — do NOT register a second notifee.onBackgroundEvent. notifee has
  // one bg-handler slot and callNotification owns THE registration; installing
  // this handler as its delegate replaces the old undocumented last-write-wins
  // displacement of the slim bundle-entry handler.
  cn.setNotifeeBgHandlerDelegate(async ev => { await handle(ev as NotifeeEvent, 'bg'); });

  // Cold-launch routing — when a notification tap LAUNCHES the app from a
  // killed state, the fg/bg event handlers above do NOT fire for the launching
  // notification; notifee surfaces it exactly once via getInitialNotification().
  // Feed it through the same handler as a synthetic PRESS so a killed-app tap
  // deep-links to the conversation (msg-wake) or the ring screen (call), rather
  // than landing on home. Previously this was never called, so a cold-launch
  // tap had no routing at all.
  void (async () => {
    try {
      const initial = await notifee.getInitialNotification();
      if (initial?.notification) {
        await handle(
          {
            type: EventType.PRESS,
            detail: {notification: initial.notification, pressAction: initial.pressAction},
          } as NotifeeEvent,
          'bg',
        );
      }
    } catch (e) {
      console.warn('[notifee] getInitialNotification routing failed:', (e as Error).message);
    }
  })();

  console.log('[notifee] event handlers installed');
}

export function stopFcmBootstrap(): void {
  unsubTokenRefresh?.();
  unsubTokenRefresh = null;
  unsubOnMessage?.();
  unsubOnMessage = null;
  started = false;
  // M-04 — stop the store-driven banner subscriber and clear its banners so
  // a sign-out doesn't leave the previous account's notifications behind.
  try {
    const {stopBackgroundMessageNotifier} = require('./backgroundMessageNotifier') as typeof import('./backgroundMessageNotifier');
    stopBackgroundMessageNotifier();
  } catch { /* notifier never started */ }
  // Teardown the CallKit/Telecom bridge so a re-login starts clean
  // (re-prompts for phone-account permission if it was revoked, and
  // drops any orphaned system-UI calls from the previous session).
  // Also drop the in-memory incoming-call cache for the same reason.
  try {

    const {teardownCallKit} = require('./callKitBridge') as typeof import('./callKitBridge');
    teardownCallKit();

    const cache = require('./incomingCallCache') as typeof import('./incomingCallCache');
    cache._resetIncomingCallCacheForTests(); // method name is "test" but applies just as well to a logout reset
  } catch { /* bridge inactive */ }
  // Tear down the Telecom event-handler subscription BEFORE clearing the guard,
  // otherwise the next login re-subscribes on top of still-live listeners and a
  // single Accept/End fires twice (double call.answer / double call.hangup).
  try { callKitUnsub?.(); } catch { /* already gone */ }
  callKitUnsub = null;
  callKitHandlersInstalled = false;
}

async function registerVoipToken(token: string): Promise<void> {
  // Round 5 / Security S3 — capture the wake key the server returns
  // and stash it in keychain so verifyVoipWake can validate inbound
  // VoIP push HMAC sigs.
  const resp = await registerToken('register-voip', token);
  if (resp && typeof resp === 'object' && typeof (resp as {wakeKeyB64?: unknown}).wakeKeyB64 === 'string') {
    try {

      const {storeVoipWakeKey} = require('./voipWakeVerify') as typeof import('./voipWakeVerify');

      const {useAuthStore} = require('@/store/authStore') as typeof import('@/store/authStore');
      const userId = useAuthStore.getState().user?.id ?? '';
      if (userId) {
        await storeVoipWakeKey(userId, '1', (resp as {wakeKeyB64: string}).wakeKeyB64);
        console.log('[fcm] VoIP wake key stored');
      }
    } catch (e) {
      console.warn('[fcm] VoIP wake key persist failed:', (e as Error).message);
    }
  }
  console.log('[fcm] VoIP token registered with messenger-service, len =', token.length);
}

async function registerDataToken(token: string): Promise<void> {
  await registerToken('register', token);
  console.log('[fcm] DATA token registered with messenger-service, len =', token.length);
}

async function registerToken(endpoint: 'register' | 'register-voip', token: string): Promise<unknown> {
  // Why: previously this returned null on missing access token AND threw on
  // 401 without retry, leaving the recipient with ZERO server-registered
  // push tokens. The user was then invisible to push.chat.sendChatWake —
  // every send to them hit `push.chat.no-tokens`. Now: (1) if no token
  // yet, attempt a refresh once before bailing; (2) on 401 from /push/*,
  // refresh-and-retry exactly once via the same single-flight chain
  // axios uses.
  const {refreshAccessTokenShared} = require('@services/api') as typeof import('@services/api');
  async function attempt(retried: boolean): Promise<unknown> {
    let access = await tokenVault.getAccess();
    if (!access) {
      if (retried) {return null;}
      try { await refreshAccessTokenShared(); } catch { return null; }
      access = await tokenVault.getAccess();
      if (!access) {return null;}
    }
    // signalDeviceId is hardcoded to 1 across the app (Phase-1 single-device
    // — see productionRuntime.ts default). The server's JwtHttpGuard
    // requires the X-Signal-Device-Id header on every authenticated POST,
    // so we set it explicitly even though there's no per-user value.
    // #6 — App Check attestation header; {} until the console provider is
    // configured (fail-soft, appCheckHeader never throws).
    const {appCheckHeader} = require('./appCheckHeader') as typeof import('./appCheckHeader');
    const headers: Record<string, string> = {
      'Content-Type':       'application/json',
      'Authorization':      `Bearer ${access}`,
      'X-Signal-Device-Id': '1',
      ...(await appCheckHeader()),
    };
    const res = await fetchWithTimeout(`${MSG_BASE_URL}/push/${endpoint}`, {
      method:  'POST',
      headers,
      body:    JSON.stringify({platform: Platform.OS, token}),
    }, PUSH_REGISTER_TIMEOUT_MS);
    if (res.status === 401 && !retried) {
      try { await refreshAccessTokenShared(); } catch { /* fall through to throw */ }
      return attempt(true);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[fcm] /push/${endpoint} failed`, res.status, body.slice(0, 200));
      throw new Error(`${endpoint} ${res.status}: ${body.slice(0, 120)}`);
    }
    // Round 5 / Security S3 — return the parsed JSON so callers (e.g.
    // registerVoipToken) can capture the per-device wake key the server
    // mints. Older /register endpoints just return `{ok: true}`.
    try { return await res.json(); } catch { return null; }
  }
  return attempt(false);
}

/**
 * Background message handler — must be set at module-top-level (NOT
 * inside React) so headless JS can pick it up when the app is killed.
 *
 * For voip-wake messages we fire a notifee call notification right
 * here so the user sees a heads-up + (on locked devices) the full-
 * screen ring UI. We do NOT depend on the WS being connected — the
 * notification payload carries everything the call screens need to
 * mount on tap (callId, callerName, kind, conversationId, optional
 * roomId/SDP).
 *
 * If the WS happens to be live too, the existing in-app ring handler
 * also fires; we de-dupe by callId in showIncomingCallNotif (notifee
 * tag stays unique per callId).
 */
// BS-MSG1 — the channel the server's chat-wake notifications target. Must
// exist before any `bravo-messages` notification (server-drawn or notifee)
// can show on Android 8+. Idempotent; safe to call repeatedly.
async function ensureMessagesChannel(): Promise<string> {
  try {
    const {default: notifee, AndroidImportance} = require('@notifee/react-native') as typeof import('@notifee/react-native');
    return await notifee.createChannel({
      id: 'bravo-messages',
      name: 'Messages',
      importance: AndroidImportance.HIGH,
      sound: 'default',
      // Keep identical to callNotification.ensureMessagesChannel — channel
      // settings are immutable after first create, so a drift here means
      // vibration silently depends on which install path ran first.
      vibration: true,
    });
  } catch (e) {
    console.warn('[fcm] ensureMessagesChannel failed:', (e as Error).message);
    return 'bravo-messages';
  }
}

// CRIT-5 — hydratePushEvent moved to ./serverWakeNotifications (shared by the
// warm + killed-app handlers). Import kept implicit via that module.

messaging().setBackgroundMessageHandler(async (remoteMessage) => {
  const data = remoteMessage?.data ?? {};
  // B-715 T7b — the WARM background lane's own arrival stamp. Same reasoning as
  // fcmHeadless's T7: this was `console.log`, which release builds strip, so the
  // lane that actually handles most wakes (this handler overrides the headless
  // one whenever the app is warm) had no readable entry timestamp.
  //
  // Deliberately NOT a `JSON.stringify(data)` at warn level. The old line dumped
  // the whole payload; promoting that verbatim would put a sender id into every
  // release log for no measurement benefit. Kind + transit only.
  const wakeSentAt = typeof data.sentAtMs === 'string' ? Number(data.sentAtMs) : NaN;
  const transitMs = Number.isFinite(wakeSentAt) && wakeSentAt > 0 ? Date.now() - wakeSentAt : -1;
  console.warn(`[NOTIFLAT] T7 warm wake in kind=${typeof data.kind === 'string' ? data.kind : ''} transitMs=${transitMs}`);
  // N-02 — the caller hung up before this backgrounded device answered.
  // Dismiss any ring we drew and (when the caller gave up on an unanswered
  // call) leave a Missed-call trace, so a Doze-deferred ring can't keep ringing
  // after the call is over.
  if (data.kind === 'call-cancel' && typeof data.callId === 'string') {
    // P2-5 — full teardown (ring dismiss + Telecom reportEnded + cache
    // tombstone + optional missed-call trace), shared with the foreground path.
    await handleCallCancel(data as Record<string, string | undefined>);
    return;
  }
  if (data.kind === 'voip-wake' && typeof data.callId === 'string') {
    try {
      // Round 5 / Security S3 — verify the HMAC sig + nonce window
      // BEFORE displaying the ring notification. A captured/replayed
      // payload fails verification and the user does not ring-spam.

      const {verifyVoipWake} = require('./voipWakeVerify') as typeof import('./voipWakeVerify');

      const {useAuthStore} = require('@/store/authStore') as typeof import('@/store/authStore');
      const selfUserId = useAuthStore.getState().user?.id ?? '';
      const verdict = await verifyVoipWake({
        selfUserId,
        fields: {
          kind:     'voip-wake',
          callId:   data.callId as string,
          nonce:    typeof data.nonce === 'string' ? data.nonce : undefined,
          exp:      typeof data.exp === 'string' ? Number(data.exp) : (typeof data.exp === 'number' ? data.exp : undefined),
          sig:      typeof data.sig === 'string' ? data.sig : undefined,
        },
      });
      if (!verdict.ok) {
        console.warn(`[fcm] voip-wake DROPPED reason=${verdict.reason} call=${data.callId}`);
        return;
      }
      // Audit Step 2.1 — a verified incoming call: warm TURN NOW (before the
      // ring UI / navigation) so the answerer's accept-time fetch is a hit.
      // Only after HMAC verification, so a replayed wake cannot drive traffic.
      try {
        const {prewarmIceServers} = require('@/modules/messenger/webrtc/turnCredentials') as typeof import('@/modules/messenger/webrtc/turnCredentials');
        prewarmIceServers();
      } catch { /* prewarm never blocks the ring */ }

      // §5 parity (Ranak-approved 2026-07-05, relaxes audit P1-N2): the
      // wake now carries the pseudonymous sender UUID + call kind (both
      // display-only and unsigned — ring admission stays HMAC-gated).
      // Resolve the caller's LOCAL contact name from the conversation
      // list so the ring is labeled instantly, WhatsApp-style; no
      // cleartext name ever rides FCM. Fallback stays 'Bravo contact'
      // (old server / lookup miss) and the WS `call.offer` frame still
      // refreshes the in-app UI with authoritative detail.
      const rawKind = typeof data.callKind === 'string' ? data.callKind : 'voice';
      const callKindStr: 'voice' | 'video' | 'group-voice' | 'group-video' =
        rawKind === 'video' || rawKind === 'group-voice' || rawKind === 'group-video' ? rawKind : 'voice';
      const fromUserId = typeof data.fromUserId === 'string' && data.fromUserId ? data.fromUserId : undefined;
      let callerName = 'Bravo contact';
      try {
        if (fromUserId) {
          const {useMessengerStore} = require('@/modules/messenger/store/messengerStore') as
            typeof import('@/modules/messenger/store/messengerStore');
          const convos = useMessengerStore.getState().conversations ?? {};
          for (const c of Object.values(convos)) {
            if (c.type === 'direct' && c.peer?.userId === fromUserId && c.name) {
              callerName = c.name;
              break;
            }
          }
        }
      } catch { /* store not hydrated (cold headless-ish context) — generic label */ }

      // Cache the payload BEFORE displaying any UI so an immediate
      // Telecom Accept / End tap (heads-up "Answer" before notifee
      // even renders) finds the entry. The cache is the same one
      // used by the Telecom event handlers. fromUserId/conversationId/
      // roomId fill in from the WS offer frame on reconnect.

      // B-107 — no ring surfaces while a backup restore is in progress.
      // The background handler runs in the same JS VM when the app is
      // alive (a truly-killed headless VM cannot coincide with an active
      // in-app restore), so the in-memory flag is readable here. The
      // caller falls through to no-answer; the warm WS offer path is the
      // one that sends the explicit busy.
      try {
        const {isRestoreModeActive} = require('@/modules/messenger/backup/restoreMode') as typeof import('@/modules/messenger/backup/restoreMode');
        if (isRestoreModeActive()) {
          console.log('[fcm.bg] restore in progress — skipping ring for', data.callId);
          return;
        }
      } catch { /* flag module unavailable — ring normally */ }

      // W4.2 — a live call already owns the audio + call UI. When this VM is
      // warm (backgrounded behind the call FGS), the WS offer path presents
      // the in-call waiting banner; raising Telecom + notifee here rang a
      // SECOND system surface over the live call. Same-id falls through (the
      // B-102 offer replay for the call being answered). A truly-killed
      // headless VM has empty registries, so a genuine killed-app ring is
      // unaffected.
      try {
        const callReg = require('@/modules/messenger/runtime/callRegistry') as typeof import('@/modules/messenger/runtime/callRegistry');
        const groupReg = require('@/modules/messenger/runtime/groupCallRegistry') as typeof import('@/modules/messenger/runtime/groupCallRegistry');
        const incomingCallId = data.callId as string;
        const live = callReg.getActiveCall();
        const liveGroup = groupReg.getActiveGroupCall();
        // WI-1.6 — `ending` means the group call is tearing down; suppressing
        // the system ring against it would swallow a real incoming call for the
        // length of the leave.
        const busyElsewhere =
          (!!live && live.callId !== incomingCallId) ||
          (!!liveGroup && !liveGroup.ending && liveGroup.roomId !== incomingCallId);
        if (busyElsewhere) {
          console.warn('[CALLDIAG] [ring.fcm] busy — suppressing system ring for', incomingCallId, 'live=', live?.callId ?? liveGroup?.roomId);
          return;
        }
      } catch { /* registries unavailable (headless VM) — ring normally */ }

      const cache = require('./incomingCallCache') as typeof import('./incomingCallCache');
      // Group rings reuse the roomId as the callId (gateway contract).
      const isGroupKind = callKindStr === 'group-voice' || callKindStr === 'group-video';
      // P1-BR-1 — the wake now carries conversationId + per-recipient roomToken
      // (both unsigned display/routing fields, NOT part of the HMAC). Thread them
      // so a group accept can sfu.join the host's room.
      const roomToken = typeof data.roomToken === 'string' ? data.roomToken : undefined;
      const conversationId = typeof data.conversationId === 'string' ? data.conversationId : undefined;
      const accepted = cache.setIncomingCallPayload({
        callId:         data.callId as string,
        callerName,
        kind:           callKindStr,
        fromUserId,
        conversationId,
        roomId:         isGroupKind ? (data.callId as string) : undefined,
        roomToken,
        // R2-2 — the fan-out identity; lets a genuine re-ring supersede a
        // declined ring's tombstone on this reused (group) id.
        ringId:         typeof data.ringId === 'string' ? data.ringId : undefined,
      });
      if (!accepted) {
        // Tombstoned (caller retried with same callId after a decline).
        // Skip UI display — repopulating it would expose stale SDP.
        console.warn('[fcm.bg] tombstoned callId — skipping UI for', data.callId);
        return;
      }

      // Fire BOTH ringers in parallel:
      //   notifee → covers Android baseline (lock-screen + heads-up).
      //   Telecom (Android) / CallKit (iOS) → adds system-call-UI on
      //     top, with bluetooth headset routing + recents integration.
      // De-dupe is by callId (notifee tag = `bravo-call-${callId}`,
      // Telecom uuid = callId). Both clear together on accept/end.

      const {showIncomingCallNotif} = require('./callNotification') as typeof import('./callNotification');

      const bridge = require('./callKitBridge') as typeof import('./callKitBridge');

      // Telecom's CallKitCallKind is 'voice' | 'video' — collapse the group
      // variants the same way the warm path (MainNavigator) does.
      try { bridge.reportIncomingCall({callId: data.callId as string, callerName, kind: callKindStr === 'video' || callKindStr === 'group-video' ? 'video' : 'voice'}); }
      catch (e) { console.warn('[fcm] callkit reportIncomingCall failed:', (e as Error).message); }

      await showIncomingCallNotif({
        callId:         data.callId as string,
        kind:           callKindStr,
        callerName,
        conversationId,
        fromUserId,
        roomId:         isGroupKind ? (data.callId as string) : undefined,
        roomToken,
      });
      console.log('[fcm] notifee + callkit ring displayed for callId =', data.callId);
    } catch (e) {
      console.warn('[fcm] failed to show call notif:', (e as Error).message);
    }
  } else if (data.kind === 'msg-wake') {
    // Chat-message wake. BS-MSG1 — DO NOT rely on the server's FCM
    // `notification` block to draw the banner: it targets the
    // `bravo-messages` channel, and if that channel doesn't exist yet
    // (fresh install, or a sender who isn't in the recipient's contacts
    // so no prior chat ever created it) Android silently drops it — which
    // is exactly why calls rang but messages showed nothing. Draw the
    // banner ourselves via notifee against a channel we guarantee exists.
    const explicitConvId = typeof data.conversationId === 'string' && data.conversationId ? data.conversationId : undefined;
    const senderUserId = typeof data.senderUserId === 'string' && data.senderUserId ? data.senderUserId : undefined;
    // B-703 MR-10 — snapshot at handler ENTRY, before the mute lookup and the
    // runtime boot below. The old snapshot was taken AFTER
    // `await getMessengerRuntime(...)`, so a banner the live WS lane drew while
    // that promise was in flight was invisible to it and the handler posted a
    // duplicate generic one on top. (This is the awaits INSIDE this handler; the
    // cue that landed BEFORE the handler ran at all is what the recent-cue
    // windows below cover — the two halves are not interchangeable.)
    // Scoped to the conversation the fallback would draw for; see MR-19/F5.
    let cuesBefore: import('./backgroundMessageNotifier').CueSnapshot | undefined;
    try {
      const {snapshotCues} = require('./backgroundMessageNotifier') as typeof import('./backgroundMessageNotifier');
      cuesBefore = snapshotCues(explicitConvId);
    } catch { cuesBefore = undefined; }
    let notifierRunning = false;
    try {
      const {isBackgroundMessageNotifierRunning} = require('./backgroundMessageNotifier') as typeof import('./backgroundMessageNotifier');
      notifierRunning = isBackgroundMessageNotifierRunning();
    } catch { notifierRunning = false; }
    // P2-BR-5 — mute ONLY off the unambiguous explicit conversationId. A DM id
    // resolved from senderUserId is ambiguous (the sender may be posting to a
    // GROUP), so muting their 1:1 must not silence a group message.
    let muted = false;
    try {
      if (explicitConvId) {
        const {isConversationMuted} = require('./mutedLookup') as typeof import('./mutedLookup');
        muted = await isConversationMuted({conversationId: explicitConvId});
      }
    } catch { muted = false; }
    try {
      if (muted) {
        console.log('[fcm] msg-wake suppressed — conversation muted');
      } else if (notifierRunning) {
        // P1-8 — skip the FCM banner REGARDLESS of convId resolution; the store
        // notifier draws the correct conv-keyed banner after the pull below.
        // Drawing here off a sealed-sender wake would misattribute a group
        // message to the sender's 1:1 AND duplicate the notifier's banner.
        console.log('[fcm] msg-wake banner deferred to store notifier');
      } else {
        // No notifier alive — draw the banner ourselves (resolve the DM for
        // conv-keying / titling; N-12). B-65 — an explicit conversationId
        // (group wakes included) resolves its display name from the persisted
        // vault, so backgrounded GROUP messages banner with the group's name.
        const {resolveDirectConversation, resolveConversationMeta, resolveTotalUnread} = require('./mutedLookup') as typeof import('./mutedLookup');
        // B-411 — bannerTitle: tagged "· Unsaved" for directory names, never
        // the `Bravo · <hex>` placeholder.
        const resolved = explicitConvId
          ? {id: explicitConvId, bannerTitle: (await resolveConversationMeta(explicitConvId))?.bannerTitle}
          : (senderUserId ? await resolveDirectConversation(senderUserId) : null);
        const {showMessageNotif} = require('./callNotification') as typeof import('./callNotification');
        // B-231 — carry the last-known unread total so the launcher badge stays
        // in sync on the notifier-down draw. null → omit the key (N-17).
        const badge = await resolveTotalUnread();
        const badgeArg = typeof badge === 'number' ? {badgeCount: badge} : {};
        await showMessageNotif({
          // B-710 — an explicit conversation id only. A DM merely RESOLVED from
          // the sender is a guess (the message may be a group post), and keying a
          // content-free banner on it replaces that DM's rich card in the shade.
          // Same rule the MR-19 fallback below already follows.
          conversationId: explicitConvId ?? undefined,
          // The guess still routes the TAP (B-324); it just no longer keys the banner.
          convRouteHint:  explicitConvId ? undefined : (resolved?.id ?? undefined),
          senderUserId,
          title: resolved?.bannerTitle,
          // B-324 — a DM resolved from the sender is a guess, not wire truth.
          convUnconfirmed: !explicitConvId && !!resolved?.id,
          // B-692 NL-2 — a generic wake draw opens the alert-collapse window.
          wakeFallback: true,
          ...wakeSentAtArg(data),
          ...badgeArg,
        });
      }
    } catch (e) {
      console.warn('[fcm] msg-wake notif failed:', (e as Error).message);
    }
    // Kick the in-app envelope poller so the recipient's local store has the
    // actual message before they tap through. P2-6 — if we deferred to the
    // notifier but it drew NOTHING (Doze pull failed, or the message was for the
    // active thread), post a fallback so a real message is never fully silent.
    try {
      // BUG-C (audit 2026-07-23) — same B-107 guard the foreground
      // msg-wake path has. The background handler shares the JS VM when
      // the app is alive-but-backgrounded; booting the runtime here while
      // the user sits on BackupRestoreScreen ran installIdentity + an
      // immediate bundle publish with a throwaway identity → the server's
      // rotation detector wiped the OPK pool and, because localKeyExists
      // flips true, permanently disarmed the RESTORE gate (stranded
      // backup — the Round-8 data-loss class).
      {
        const {isRestoreModeActive} = require('@/modules/messenger/backup/restoreMode') as typeof import('@/modules/messenger/backup/restoreMode');
        if (isRestoreModeActive()) {
          console.log('[fcm] bg msg-wake during restore — runtime boot deferred');
          return;
        }
      }
      const {getMessengerRuntime} = require('@/modules/messenger/runtime') as typeof import('@/modules/messenger/runtime');
      const {snapshotCues, cueDeliveredSince} = require('./backgroundMessageNotifier') as typeof import('./backgroundMessageNotifier');
      // Entry snapshot (MR-10) when it was taken; only a require failure up
      // there leaves it unset, and then here is still better than nothing.
      const cues = cuesBefore ?? snapshotCues(explicitConvId);
      const rt = await getMessengerRuntime('production');
      let pulled = false;
      if (rt && typeof (rt as unknown as {pullEnvelopes?: () => Promise<void>}).pullEnvelopes === 'function') {
        try { await (rt as unknown as {pullEnvelopes: () => Promise<void>}).pullEnvelopes(); pulled = true; }
        catch { pulled = false; }
        // B-703 MR-5 — this handler OVERRIDES the headless one whenever the app
        // is warm (module-scope re-registration; see index.js), so it is the
        // lane most wakes actually take, and it owes the same ack flush: when
        // it resolves, Android may freeze the process with the POST still on
        // the 200 ms batcher and the sender's tick stays single until the
        // recipient opens the app. Bounded and shared with the headless lane so
        // the two cannot drift.
        await flushAcksBounded(rt, 'warm msg-wake');
      }
      // B-703 MR-19 — "the generation moved" only proves a cue was ATTEMPTED.
      // A notifee display that failed, or an in-app banner layer that was not
      // mounted, moved it just the same and suppressed the one draw that was
      // supposed to guarantee this message is never fully silent.
      // B-703 MR-10 — ...and a cue that landed just BEFORE this handler ran
      // still counts. The server fires the wake without knowing the socket
      // already delivered, so for an HTTP-path send the live lane banners first
      // as a matter of course; without this the handler adds a second, generic
      // banner that REPLACES the named card on the same notifee id and arms the
      // 10 s global alert gag.
      // Critic F11 — evaluated behind the short-circuit, not ahead of it: a
      // muted conversation and a down notifier cannot draw a fallback at all,
      // and the witness costs a bounded wait of Doze budget.
      if (notifierRunning && !muted && !(await cueDeliveredSince(cues, {senderUserId}))) {
        const {showMessageNotif} = require('./callNotification') as typeof import('./callNotification');
        const {resolveTotalUnread} = require('./mutedLookup') as typeof import('./mutedLookup');
        // B-231 — the fallback draw also carries the badge (null → omit the key).
        const badge = await resolveTotalUnread();
        const badgeArg = typeof badge === 'number' ? {badgeCount: badge} : {};
        // Explicit conv → conv-keyed; else sender-keyed generic. NEVER the
        // ambiguous resolved DM (that would re-introduce the P1-8 misattribution).
        // B-692 NL-2 — wakeFallback: a generic wake draw opens the alert-collapse
        // window (a retried pull's named upgrade must not double-sound).
        // B-710 — BOTH branches name the sender. Without it `shouldAlert` falls to
        // the anonymous arm and arms the process-wide 10 s window, silencing every
        // other conversation — the exact gag this release narrowed.
        await showMessageNotif(explicitConvId
          ? {conversationId: explicitConvId, senderUserId, wakeFallback: true, ...wakeSentAtArg(data), ...badgeArg}
          : {senderUserId, wakeFallback: true, ...wakeSentAtArg(data), ...badgeArg});
        console.log('[fcm] msg-wake fallback banner (notifier drew nothing), pulled=', pulled);
      }
    } catch (e) {
      // Headless JS often can't bootstrap the full runtime — the foreground app
      // catches up via WS on next open.
      console.log('[fcm] msg-wake bg pull skipped:', (e as Error).message);
    }
  } else {
    // CRIT-5 — every other server-driven wake (booking-approved / agent-* /
    // mission-* / payout-settled / sos-cpo-alert) and opaque {eventId} wakes
    // are dispatched by the SHARED showServerWakeNotification(), the same
    // function the killed-app headless handler calls, so warm and killed paths
    // can never drift again.
    try {
      const {showServerWakeNotification} = require('./serverWakeNotifications') as typeof import('./serverWakeNotifications');
      // N-18 — warm background path: the app is alive, so record the in-app
      // bell row alongside the OS banner.
      const handled = await showServerWakeNotification(data as Record<string, unknown>, {recordActivity: true});
      if (!handled) {
        console.log('[fcm] unknown background wake kind, no action');
      }
    } catch (e) {
      console.warn('[fcm] server-wake notif failed:', (e as Error).message);
    }
  }
});
