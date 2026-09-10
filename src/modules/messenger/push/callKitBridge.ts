/**
 * CallKit (iOS) + Telecom (Android) bridge.
 *
 * Thin wrapper around `react-native-callkeep` that hides platform
 * differences and lazy-loads the native module so missing or partial
 * installs degrade to no-ops instead of crashes.
 *
 * Platform status:
 *
 *   Android — ACTIVE.
 *     Telecom ConnectionService displays the system incoming-call UI
 *     alongside the existing notifee + FCM-data path. Both fire (de-
 *     duped by callId so the user doesn't see two rings). If Telecom
 *     setup fails (e.g. user denied phone-account permission, OEM
 *     stripped Telecom), every method here becomes a no-op and the
 *     existing notifee path remains the sole ringer — Android calling
 *     keeps working exactly as before.
 *
 *   iOS — SKELETON.
 *     Hard prerequisites still pending:
 *       - Apple VoIP Services Certificate (manual issue on developer.apple.com)
 *       - PushKit token registration (voipPush.ts is wired but inert
 *         until that cert lands)
 *       - Server APNs HTTP/2 path live (sender exists, env vars not set)
 *     iOS calls that come in while the app is backgrounded still die.
 *     `IOS_RUNTIME_ENABLED` flips to `true` when ALL of the above are
 *     satisfied — at that point the iOS path activates without further
 *     integration work.
 *
 * Why both paths fire on Android (not "Telecom replaces notifee"):
 *   The notifee path is battle-tested and works on every Android we
 *   ship to. Telecom is layered on top to add (a) bluetooth headset
 *   routing, (b) "ringing alongside WhatsApp" without one killing the
 *   other, (c) recents-app integration. If Telecom misbehaves on a
 *   specific OEM, the user still gets the notifee ring.
 *   See `useCallKit()` flag below to disable Telecom-side display per
 *   call — useful for the in-app live-call path where the user is
 *   already holding the phone (Telecom UI would just be visual noise).
 *
 * iOS 13+ contract once enabled (kept here so the next reader doesn't
 * trip on it): every PushKit notification MUST report a CallKit
 * incoming call within ~5 s of delivery. Miss it once → Apple revokes
 * the VoIP entitlement (no warning, no appeal). voipPush.ts calls
 * `reportIncomingCall` synchronously BEFORE any verification or
 * network work; if verification later rejects the wake, it calls
 * `reportEnded(callId, 'failed')` — the user sees a ½-second flash of
 * CallKit UI in the worst case, far better than losing the entitlement.
 */
import {Platform} from 'react-native';

/**
 * iOS-side activation flag. Stays `false` until:
 *   1. Apple VoIP Services Certificate provisioned in Developer Console
 *   2. APNS_VOIP_* env vars set on messenger-service
 *   3. PushKit token registration is delivering tokens (verify in
 *      voipPush.ts logs)
 *
 * Flip to `true` in a single commit AFTER a TestFlight smoke pass:
 * lock-screen ring + system-UI accept/decline + background→foreground
 * answer + system-UI hangup propagation to peer.
 *
 * Android does NOT use this flag — the Android path activates whenever
 * the native module is linked, which is detected at runtime via
 * `getCallKeep()` returning non-null.
 */
const IOS_RUNTIME_ENABLED = true;

/**
 * Per-platform "is this bridge alive?" probe. Android: true once
 * native module is linked. iOS: gated on IOS_RUNTIME_ENABLED so
 * partial wiring during development cannot accidentally trigger
 * the 5s-or-revoke contract.
 */
function isBridgeActive(): boolean {
  if (Platform.OS === 'android') {return getCallKeep() !== null;}
  if (Platform.OS === 'ios')     {return IOS_RUNTIME_ENABLED && getCallKeep() !== null;}
  return false;
}

export type CallKitCallKind = 'voice' | 'video';

export interface CallKitIncomingPayload {
  /** Stable per-call id — must match the callId used everywhere in the call stack. */
  callId:       string;
  callerName:   string;
  /** Used to label the call in the recents list and the lock-screen UI. */
  handle?:      string;
  kind:         CallKitCallKind;
}

export interface CallKitOutgoingPayload {
  callId:       string;
  calleeName:   string;
  handle?:      string;
  kind:         CallKitCallKind;
}

export type CallKitEndReason =
  | 'remoteEnded'
  | 'declined'
  | 'failed'
  | 'unanswered'
  | 'answeredElsewhere';

/**
 * Subset of `react-native-callkeep` we use. Kept narrow on purpose —
 * fewer surfaces means less to keep in sync with upstream API drift.
 * The full type is available via `import type RNCallKeep from
 * 'react-native-callkeep'` for callers that need it.
 */
type CallKeepLike = {
  setup:                 (opts: unknown) => Promise<boolean>;
  registerAndroidEvents: () => void;
  unregisterAndroidEvents: () => void;
  displayIncomingCall:   (uuid: string, handle: string, name?: string, type?: string, video?: boolean, opts?: object) => void;
  startCall:             (uuid: string, handle: string, name?: string, type?: string, video?: boolean) => void;
  answerIncomingCall:    (uuid: string) => void;
  reportConnectedOutgoingCallWithUUID: (uuid: string) => void;
  setCurrentCallActive:  (uuid: string) => void;
  endCall:               (uuid: string) => void;
  reportEndCallWithUUID: (uuid: string, reason: number) => void;
  endAllCalls:           () => void;
  setMutedCall:          (uuid: string, muted: boolean) => void;
  rejectCall:            (uuid: string) => void;
  backToForeground:      () => void;
  addEventListener: <E extends string>(
    type: E,
    handler: (data: Record<string, unknown>) => void,
  ) => {remove: () => void};
  removeEventListener:   (type: string) => void;
  CONSTANTS?: {
    END_CALL_REASONS: {
      FAILED:             1;
      REMOTE_ENDED:       2;
      UNANSWERED:         3;
      ANSWERED_ELSEWHERE: 4;
      DECLINED_ELSEWHERE: 5 | 2;
      MISSED:             2 | 6;
    };
  };
};

let cachedCallKeep: CallKeepLike | null | undefined;

/**
 * Lazy + memoised native-module load. Returns `null` once if the
 * module isn't installed (skeleton phase, or a dev build that hasn't
 * autolinked yet) — the cache prevents repeating the require() on
 * every call.
 */
function getCallKeep(): CallKeepLike | null {
  if (cachedCallKeep !== undefined) {return cachedCallKeep;}
  try {

    const mod = require('react-native-callkeep') as {default?: CallKeepLike} | CallKeepLike;
    cachedCallKeep = ('default' in mod && mod.default ? mod.default : mod) as CallKeepLike;
    return cachedCallKeep;
  } catch {
    cachedCallKeep = null;
    return null;
  }
}

let setupComplete = false;
let setupSucceeded = false;

// B-391b — the call whose Telecom Connection is currently live. Tracked here so
// `reportAudioRoute` can mirror our chosen route onto that Connection without
// every call screen having to thread a uuid down to its audio code.
let activeTelecomCallId: string | null = null;

/**
 * B-109 RC-4 — CallKit audio-session coordination (iOS only).
 *
 * Under CallKit the app must not start its audio units until CXProvider
 * activates the AVAudioSession (`didActivateAudioSession`); an app-activated
 * session isn't owned by CallKit and gets torn down on lock / lock-screen
 * answer (classic "silence after answering from the lock screen").
 * `setupCallKit` installs the listeners; `waitForIosAudioSession` is the
 * gate CallScreen awaits before `InCallManager.start` on iOS. It resolves
 * immediately on Android / inert bridge, and falls through on timeout so a
 * CallKit-less run can never leave a call silent.
 */
let iosAudioSessionActive = false;
let iosAudioSessionWaiters: Array<(active: boolean) => void> = [];

function flushIosAudioSessionWaiters(active: boolean): void {
  const waiters = iosAudioSessionWaiters;
  iosAudioSessionWaiters = [];
  for (const w of waiters) {
    try { w(active); } catch { /* waiter must never throw into the event path */ }
  }
}

export function waitForIosAudioSession(timeoutMs: number): Promise<boolean> {
  if (Platform.OS !== 'ios' || !isBridgeActive() || !setupSucceeded) {
    return Promise.resolve(true);
  }
  if (iosAudioSessionActive) {
    return Promise.resolve(true);
  }
  return new Promise<boolean>(resolve => {
    let settled = false;
    const settle = (active: boolean) => {
      if (settled) {return;}
      settled = true;
      resolve(active);
    };
    iosAudioSessionWaiters.push(settle);
    setTimeout(() => settle(false), timeoutMs);
  });
}

/**
 * One-time CallKit + Telecom configuration. Idempotent. Caller is the
 * FCM bootstrap (which runs once per authenticated session).
 *
 * On Android this:
 *   - Registers a self-managed Telecom phone account
 *   - Prompts the user for the phone-account permission (one-time,
 *     standard Android dialog — same as Signal / Wire)
 *   - Wires CallKeep's Android event bridge so answer/end taps from
 *     the system UI fire JS callbacks
 *
 * On iOS this is currently a no-op (skeleton phase). When
 * IOS_RUNTIME_ENABLED flips true, this configures CXProvider with the
 * iOS options block.
 */
export async function setupCallKit(): Promise<void> {
  if (setupComplete) {return;}
  setupComplete = true;

  if (Platform.OS === 'ios' && !IOS_RUNTIME_ENABLED) {
    console.log('[callkit] iOS skeleton — setup deferred until VoIP cert + PushKit module land');
    return;
  }

  const ck = getCallKeep();
  if (!ck) {
    console.warn('[callkit] react-native-callkeep not available — bridge stays inert');
    return;
  }

  try {
    const ok = await ck.setup({
      ios: {
        appName:                  'Bravo Secure',
        supportsVideo:            true,
        // includesCallsInRecents=false — Bravo keeps its own private
        // call log; mirroring to the system Recents would leak peer
        // identities to anyone with phone access.
        includesCallsInRecents:   false,
        maximumCallGroups:        '1',
        maximumCallsPerCallGroup: '1',
      },
      android: {
        // Permission prompt strings — shown if user hasn't already
        // granted phone-account access.
        alertTitle:           'Permissions required',
        alertDescription:     'Bravo Secure needs phone-account permission to display calls in the system UI alongside other call apps.',
        cancelButton:         'Not now',
        okButton:             'OK',
        // additionalPermissions is required by the upstream type even
        // though we declare permissions in the manifest. Empty array
        // = "use the manifest, ask for nothing extra at runtime".
        additionalPermissions: [],
        // selfManaged=true: Bravo owns the audio session + signalling.
        // The OS Telecom layer just provides the system UI + Bluetooth
        // routing. selfManaged=false would hand audio to the OS like
        // a SIM call, which fights InCallManager for the audio mode.
        selfManaged:          true,
        foregroundService: {
          // P3 — point at the v2 channel id (callNotification.ts CHANNEL_ID).
          // The old 'bravo-incoming-call' string RE-CREATED the legacy v1
          // channel that ensureIncomingCallChannel() deletes, leaving two
          // "Incoming calls" entries in system settings and undoing the v2
          // migration. Keep this in lockstep with callNotification.CHANNEL_ID.
          channelId:         'bravo-incoming-call-v2',
          channelName:       'Incoming calls',
          notificationTitle: 'Bravo Secure call in progress',
        },
      },
    });
    setupSucceeded = ok !== false;
    if (Platform.OS === 'android' && setupSucceeded) {
      // Android requires this AFTER setup() to start receiving events
      // from the native side (answer / end / mute taps from the
      // system call UI). iOS auto-registers in setup().
      try { ck.registerAndroidEvents(); } catch (e) {
        console.warn('[callkit] registerAndroidEvents failed:', (e as Error).message);
      }
    }
    if (Platform.OS === 'ios' && setupSucceeded) {
      // B-109 RC-4 — track CXProvider's audio-session lifecycle. These
      // listeners live for the whole session (torn down via CallKeep's
      // removeEventListener in teardownCallKit's endAllCalls path is not
      // needed — the bridge resets setupSucceeded, which re-gates the wait).
      try {
        ck.addEventListener('didActivateAudioSession', () => {
          iosAudioSessionActive = true;
          flushIosAudioSessionWaiters(true);
          console.log('[callkit] didActivateAudioSession');
        });
        ck.addEventListener('didDeactivateAudioSession', () => {
          iosAudioSessionActive = false;
          console.log('[callkit] didDeactivateAudioSession');
        });
      } catch (e) {
        console.warn('[callkit] audio-session listeners failed:', (e as Error).message);
      }
    }
    console.log(`[callkit] setup ${setupSucceeded ? 'ok' : 'returned false'} platform=${Platform.OS}`);
  } catch (e) {
    setupSucceeded = false;
    console.warn('[callkit] setup failed:', (e as Error).message);
  }
}

/**
 * Display the system incoming-call UI. On iOS this is the load-bearing
 * "must fire within 5 s of PushKit" call. On Android this layers
 * Telecom's incoming-call screen on top of the existing notifee ring
 * — they coexist (de-duped by callId so the user sees one ring).
 *
 * Safe to call when the bridge is inert: returns early with a log line.
 */
export function reportIncomingCall(p: CallKitIncomingPayload): void {
  activeTelecomCallId = p.callId;
  if (!isBridgeActive()) {
    console.log('[callkit] reportIncomingCall — bridge inert, skip:', p.callId, p.kind);
    return;
  }
  const ck = getCallKeep();
  if (!ck || !setupSucceeded) {return;}
  try {
    ck.displayIncomingCall(
      p.callId,
      p.handle ?? p.callerName,
      p.callerName,
      'generic',
      p.kind === 'video',
    );
    console.log('[callkit] displayIncomingCall:', p.callId);
  } catch (e) {
    console.warn('[callkit] displayIncomingCall failed:', (e as Error).message);
  }
}

/**
 * Local user initiated an outgoing call. Reporting it makes the
 * system call UI appear immediately — without this, locking the
 * phone right after dialling would lose the call entirely on iOS.
 *
 * On Android self-managed Telecom this also requests audio focus
 * via the Telecom layer, which prevents music apps from continuing
 * to play over the call.
 */
export function reportOutgoingCall(p: CallKitOutgoingPayload): void {
  activeTelecomCallId = p.callId;
  if (!isBridgeActive()) {
    console.log('[callkit] reportOutgoingCall — bridge inert, skip:', p.callId, p.kind);
    return;
  }
  const ck = getCallKeep();
  if (!ck || !setupSucceeded) {return;}
  try {
    ck.startCall(
      p.callId,
      p.handle ?? p.calleeName,
      p.calleeName,
      'generic',
      p.kind === 'video',
    );
    console.log('[callkit] startCall:', p.callId);
  } catch (e) {
    console.warn('[callkit] startCall failed:', (e as Error).message);
  }
}

/**
 * B-109 RC-3 — the user accepted an INCOMING call from the in-app ring UI
 * (not from the CallKit/Telecom system UI). Without this, the CXCall stays
 * in the ringing state forever: no lock-screen protection for the live
 * call, and the stale ring's eventual dismissal fires `endCall`, which the
 * bootstrap used to translate into `call.hangup{declined}` on a LIVE call.
 *
 * iOS-only: `answerIncomingCall` requests a CXAnswerCallAction, which flips
 * the CXCall to answered/active. It also re-emits the `answerCall` event —
 * callers MUST pre-latch the callId in fcmBootstrap's accept-dedupe
 * (`markCallAccepted`) so that event cannot re-navigate / double-answer.
 * Android is deliberately untouched — its in-app-accept flow is the
 * B-53/B-58 device-verified path.
 */
export function reportAnswered(callId: string): void {
  if (Platform.OS !== 'ios') {return;}
  if (!isBridgeActive()) {return;}
  const ck = getCallKeep();
  if (!ck || !setupSucceeded) {return;}
  try {
    ck.answerIncomingCall(callId);
    console.log('[callkit] answerIncomingCall (in-app accept):', callId);
  } catch (e) {
    console.warn('[callkit] answerIncomingCall failed:', (e as Error).message);
  }
}

/**
 * Call entered the 'connected' state. Flips the system UI from
 * "Calling…" to "In call" + starts the call-duration timer.
 *
 * iOS: `reportConnectedOutgoingCallWithUUID` (outgoing only — incoming
 * auto-flipped on user accept).
 * Android: `setCurrentCallActive` (works for both directions).
 */
export function reportConnected(callId: string): void {
  if (!isBridgeActive()) {return;}
  const ck = getCallKeep();
  if (!ck || !setupSucceeded) {return;}
  activeTelecomCallId = callId;
  try {
    if (Platform.OS === 'ios') {
      ck.reportConnectedOutgoingCallWithUUID(callId);
    } else {
      ck.setCurrentCallActive(callId);
    }
  } catch (e) {
    console.warn('[callkit] reportConnected failed:', (e as Error).message);
  }
}

/**
 * B-391b — mirror the chosen audio route onto the Android Telecom connection.
 *
 * We register the phone account with `selfManaged: true`, and this file's own
 * setup comment states the intent: *"The OS Telecom layer just provides the
 * system UI + Bluetooth routing."* Nothing ever wired that up. For a
 * self-managed call the framework route lives on the Connection
 * (`Connection.setAudioRoute` → `CallAudioState.ROUTE_BLUETOOTH`), which
 * `RNCallKeep.setAudioRoute` wraps — and it was never called anywhere in the
 * app, so Telecom sat on its default while InCallManager drove AudioManager
 * alone. Two owners, one of them never told anything.
 *
 * B-391 fixed the InCallManager half (a boolean `false` was pinning the
 * earpiece and blocking the SCO handshake). This is the other half: tell
 * Telecom the SAME target so the two agree. Always mirroring the same route is
 * what makes this safe — divergence is what would flap the route, and we never
 * send a different one.
 *
 * Deliberately best-effort:
 *   - Android only; iOS routes through CallKit's own audio session.
 *   - no-ops when the bridge is inactive or no call is registered;
 *   - the native side already returns silently when the Connection is gone
 *     (`RNCallKeepModule.setAudioRoute`: `if (conn == null) return;`), so a
 *     stale id cannot throw.
 * It must never be able to fail a call, which is why every path swallows.
 */
export function reportAudioRoute(route: 'BLUETOOTH' | 'WIRED_HEADSET' | 'SPEAKER_PHONE' | 'EARPIECE'): void {
  if (Platform.OS !== 'android') {return;}
  if (!isBridgeActive() || !setupSucceeded) {return;}
  const callId = activeTelecomCallId;
  if (!callId) {return;}
  const ck = getCallKeep() as unknown as {setAudioRoute?: (uuid: string, name: string) => Promise<unknown> | unknown};
  if (typeof ck?.setAudioRoute !== 'function') {return;}
  // CallKeep's Android vocabulary, NOT ours — the native switch compares
  // against these exact strings and falls through to Wired/Earpiece otherwise.
  const name =
    route === 'BLUETOOTH'     ? 'Bluetooth' :
    route === 'WIRED_HEADSET' ? 'Headset'   :
    route === 'SPEAKER_PHONE' ? 'Speaker'   : 'Earpiece';
  try {
    void Promise.resolve(ck.setAudioRoute(callId, name)).catch(() => { /* connection gone */ });
  } catch { /* never let a routing hint break a call */ }
}

/**
 * Call ended. Maps Bravo's reason vocabulary to CallKeep's reason
 * codes so the system UI shows the right glyph in recents
 * (missed / declined / failed / etc.). Skipped reason → uses
 * `endCall(uuid)` which is the unspecified-reason path.
 */
export function reportEnded(callId: string, reason: CallKitEndReason): void {
  if (activeTelecomCallId === callId) {activeTelecomCallId = null;}
  if (!isBridgeActive()) {return;}
  const ck = getCallKeep();
  if (!ck || !setupSucceeded) {return;}
  try {
    const reasons = ck.CONSTANTS?.END_CALL_REASONS;
    if (reasons) {
      const code =
        reason === 'failed'             ? reasons.FAILED :
        reason === 'remoteEnded'        ? reasons.REMOTE_ENDED :
        reason === 'unanswered'         ? reasons.UNANSWERED :
        reason === 'answeredElsewhere'  ? reasons.ANSWERED_ELSEWHERE :
        reason === 'declined'           ? reasons.DECLINED_ELSEWHERE :
        reasons.REMOTE_ENDED;
      ck.reportEndCallWithUUID(callId, code as number);
    } else {
      ck.endCall(callId);
    }
    console.log('[callkit] reportEnded:', callId, reason);
  } catch (e) {
    console.warn('[callkit] reportEnded failed:', (e as Error).message);
  }
}

/**
 * Local mute toggle propagated to the system UI. Without this, the
 * lock-screen mute icon shows the wrong state when the user mutes
 * from the in-app UI.
 *
 * iOS only — Android Telecom doesn't expose programmatic mute on
 * self-managed connections (the user mutes via the system UI itself,
 * which fires `didPerformSetMutedCallAction` back into our handler).
 */
export function reportMuteChange(callId: string, muted: boolean): void {
  if (!isBridgeActive()) {return;}
  if (Platform.OS !== 'ios') {return;}
  const ck = getCallKeep();
  if (!ck || !setupSucceeded) {return;}
  try { ck.setMutedCall(callId, muted); } catch (e) {
    console.warn('[callkit] setMutedCall failed:', (e as Error).message);
  }
}

/**
 * Bring the app to the foreground programmatically. Wired into the
 * "answer from system UI" path so tapping Accept on the lock screen
 * also surfaces the in-app CallScreen for in-call controls.
 *
 * Android-only API in CallKeep; on iOS the system handles this
 * automatically when the user taps Accept from the lock-screen UI.
 */
export function bringAppToForeground(): void {
  if (Platform.OS !== 'android') {return;}
  // Why: NA-04 — CallKeep's backToForeground() sends a bare launcher intent,
  // which MainActivity reads as a NON-call launch and answers by CLEARING
  // showWhenLocked/turnScreenOn. Our own intent carries EXTRA_CALL_LAUNCH.
  try {
    const fg = require('@/modules/messenger/runtime/callForegroundService') as
      typeof import('@/modules/messenger/runtime/callForegroundService');
    if (fg.bringCallUiToForeground()) {return;}
  } catch { /* module unavailable — fall through to CallKeep */ }
  if (!isBridgeActive()) {return;}
  const ck = getCallKeep();
  if (!ck || !setupSucceeded) {return;}
  try { ck.backToForeground(); } catch (e) {
    console.warn('[callkit] backToForeground failed:', (e as Error).message);
  }
}

/**
 * Subscribe to system-UI events.
 *
 * The handlers MUST eventually drive the same state machine the
 * in-app buttons do — otherwise a system-UI hangup leaves the peer
 * waiting forever. Wiring is in `installCallKitEventHandlers()`
 * inside the FCM bootstrap, which translates these into the
 * existing call lifecycle (acceptCall / hangup via the live
 * transport + active-call registry).
 */
export interface CallKitEventHandlers {
  onAnswer?:      (callId: string) => void;
  onEnd?:         (callId: string) => void;
  onToggleMute?:  (callId: string, muted: boolean) => void;
  onDtmf?:        (callId: string, digits: string) => void;
}

interface ListenerHandle { remove: () => void }

export function subscribeToCallKitEvents(handlers: CallKitEventHandlers): () => void {
  if (!isBridgeActive()) {
    return () => { /* noop */ };
  }
  const ck = getCallKeep();
  if (!ck || !setupSucceeded) {return () => { /* noop */ };}

  const listeners: ListenerHandle[] = [];

  if (handlers.onAnswer) {
    const fn = handlers.onAnswer;
    listeners.push(ck.addEventListener('answerCall', (data) => {
      const uuid = String((data as {callUUID?: unknown}).callUUID ?? '');
      if (uuid) {fn(uuid);}
    }));
  }
  if (handlers.onEnd) {
    const fn = handlers.onEnd;
    listeners.push(ck.addEventListener('endCall', (data) => {
      const uuid = String((data as {callUUID?: unknown}).callUUID ?? '');
      if (uuid) {fn(uuid);}
    }));
  }
  if (handlers.onToggleMute) {
    const fn = handlers.onToggleMute;
    listeners.push(ck.addEventListener('didPerformSetMutedCallAction', (data) => {
      const d = data as {callUUID?: unknown; muted?: unknown};
      const uuid  = String(d.callUUID ?? '');
      const muted = Boolean(d.muted);
      if (uuid) {fn(uuid, muted);}
    }));
  }
  if (handlers.onDtmf) {
    const fn = handlers.onDtmf;
    listeners.push(ck.addEventListener('didPerformDTMFAction', (data) => {
      const d = data as {callUUID?: unknown; digits?: unknown};
      const uuid   = String(d.callUUID ?? '');
      const digits = String(d.digits ?? '');
      if (uuid && digits) {fn(uuid, digits);}
    }));
  }

  return () => {
    for (const l of listeners) {
      try { l.remove(); } catch { /* listener already detached */ }
    }
  };
}

/** Test helper — query whether the bridge is acting on calls. */
export function isCallKitActive(): boolean {
  return setupSucceeded && isBridgeActive();
}

/**
 * Teardown — called on logout / sign-out so a re-login starts with a
 * clean bridge state. Drops any active calls from the system UI,
 * unregisters the Android event listener, and resets the setup flag
 * so the next sign-in re-runs `setupCallKit()` and re-prompts for
 * the Telecom phone-account permission if it was revoked.
 *
 * Idempotent: safe to call when the bridge was never set up.
 */
export function teardownCallKit(): void {
  const ck = getCallKeep();
  if (ck && setupSucceeded) {
    try { ck.endAllCalls(); } catch { /* ignore */ }
    if (Platform.OS === 'android') {
      try { ck.unregisterAndroidEvents(); } catch { /* ignore */ }
    }
  }
  setupComplete  = false;
  setupSucceeded = false;
  iosAudioSessionActive = false;
  flushIosAudioSessionWaiters(false);
}
