/**
 * Headless JS handler for FCM data-only pushes that arrive while the
 * app is fully killed or frozen by Doze.
 *
 * Why this file exists separately from fcmBootstrap.setBackgroundMessageHandler:
 * the bg-message handler RNFirebase auto-fires only works when JS is
 * already alive. When Android freezes the process (you'll see
 * `ActivityManager: freezing <pid> com.bravosecure.app` in logcat) the
 * JS context is gone — RNFirebase then routes the push through a
 * registered headless task instead. Without a headless entry, logcat
 * warns:
 *   "No task registered for key ReactNativeFirebaseMessagingHeadlessTask"
 * and the data push silently drops. That's the bug behind "Sirajul
 * sent a message but I never got it" — the FCM wake fired, but our
 * handler wasn't reachable in headless mode, so we never pulled the
 * queued envelope from the relay.
 *
 * Payload kinds handled:
 *   - voip-wake: incoming call. Show notifee call notif so the user
 *     sees a heads-up + can tap accept.
 *   - msg-wake: queued chat message. Draw a generic banner (the server
 *     wake is data-only). Best-effort — Doze gives a tight time budget.
 *   - server-driven wakes (SOS / mission-* / booking-* / agent-* /
 *     payout-settled) and opaque {eventId} wakes: delegated to the
 *     shared showServerWakeNotification() so the killed-app path renders
 *     the SAME notifications the warm handler does (CRIT-5 — these were
 *     previously dropped as "unknown kind, no action" when killed, so an
 *     SOS fired to a swiped-away app surfaced nothing).
 */
import type {FirebaseMessagingTypes} from '@react-native-firebase/messaging';

type RemoteMessage = FirebaseMessagingTypes.RemoteMessage;

// FCM high-priority wakes get a short execution window (~10 s under Doze); the
// notify decision must land inside it. On timeout the fallback banner posts
// while the drain keeps running best-effort — persisted messages are a bonus.
const HEADLESS_DRAIN_BUDGET_MS = 8000;
// B-703 MR-19 — the cue verdict is waited for AFTER the drain race, so it is
// additive to the budget above and has to be tiny: the wait exists only to let
// an already-issued notifee round-trip settle, and everything left in the
// window after it (mute lookup, conversation resolve, unread, the draw itself)
// still has to fit. Same rule as ACK_FLUSH_BUDGET_MS — see the pin in
// flushAcksBounded.test.ts.
const HEADLESS_CUE_VERDICT_BUDGET_MS = 300;

export async function handleHeadlessFcm(message: RemoteMessage | undefined): Promise<void> {
  const data = message?.data ?? {};
  const kind = typeof data.kind === 'string' ? data.kind : '';
  // B-715 T7 — console.WARN, not log. This is the earliest observable moment on
  // the recipient device, and `transform-remove-console` strips `log` from
  // release builds — so on the only build worth measuring, the wake's arrival had
  // no timestamp at all and every device-side interval was unanchored.
  //
  // `sentAtMs` is the relay's accept time, carried in the wake payload for the
  // banner (B-323). Differencing it here gives the FCM transit time directly —
  // the single number that decides whether the remaining seconds are the
  // provider's or ours. Numbers and enums only; the payload is never logged.
  const wakeSentAt = typeof data.sentAtMs === 'string' ? Number(data.sentAtMs) : NaN;
  const transitMs = Number.isFinite(wakeSentAt) && wakeSentAt > 0 ? Date.now() - wakeSentAt : -1;
  console.warn(`[NOTIFLAT] T7 wake in kind=${kind} transitMs=${transitMs}`);

  // N-02 — a caller who hangs up (or times out) before an offline callee rings
  // now sends a data-only cancel push. Dismiss any ring this device already
  // drew and leave a Missed-call trace, so a Doze-deferred ring can't keep
  // ringing after the call is over ("notification appears only after the call").
  if (kind === 'call-cancel' && typeof data.callId === 'string') {
    // WI-4.1 — the warm lane's handleCallCancel guards the empty string too.
    if (!data.callId) {return;}
    // WI-6.7 — ring identity, same rule as the warm lane: a cancel naming an
    // OLDER fan-out must not dismiss a newer ring this headless process
    // already cached (the voip-wake seed below populates the cache). A fresh
    // headless process has an empty cache and falls back to id-wide dismiss.
    // (The WI-6.1 live-call/accept guards are structurally moot here: no
    // registry and an empty-by-construction accept latch — see WI-4.1 note.)
    const cancelRingId = typeof data.ringId === 'string' && data.ringId ? data.ringId : undefined;
    if (cancelRingId) {
      try {
        const cache = require('./incomingCallCache') as typeof import('./incomingCallCache');
        const cached = cache.getIncomingCallPayload(data.callId);
        if (cached?.ringId && cached.ringId !== cancelRingId) {
          console.warn(`[fcm-headless] call-cancel ignored — cancels an older ring id=${data.callId.slice(0, 8)}`);
          return;
        }
      } catch { /* cache unavailable — id-wide fallback */ }
    }
    try {
      const cn = require('./callNotification') as typeof import('./callNotification');
      await cn.dismissCallNotif(data.callId);
      // WI-4.1 — full teardown parity with handleCallCancel (P2-5): the ring
      // this lane can draw now has a Telecom display and a cache entry behind
      // it, so a cancel must tear both down or a queued Accept resurrects a
      // dead call. The accept latch lives in fcmBootstrap and is EMPTY by
      // construction wherever this handler runs — loading fcmBootstrap here
      // would displace this very handler (module-scope last-write-wins on
      // setBackgroundMessageHandler), so it is deliberately not required.
      try {
        const bridge = require('./callKitBridge') as typeof import('./callKitBridge');
        bridge.reportEnded(data.callId, 'remoteEnded');
      } catch { /* bridge inert — nothing to tear down */ }
      try {
        const cache = require('./incomingCallCache') as typeof import('./incomingCallCache');
        cache.clearIncomingCallPayload(data.callId); // tombstones the callId
      } catch { /* cache module unavailable */ }
      if (data.missed === '1') {
        let callerName = typeof data.callerName === 'string' ? data.callerName : undefined;
        if (!callerName && typeof data.fromUserId === 'string' && data.fromUserId) {
          try {
            const {resolveDirectPeerName} = require('./mutedLookup') as typeof import('./mutedLookup');
            callerName = (await resolveDirectPeerName(data.fromUserId)) ?? undefined;
          } catch { /* generic label */ }
        }
        await cn.showMissedCallNotif({
          callId: data.callId,
          callerName,
          conversationId: typeof data.conversationId === 'string' && data.conversationId ? data.conversationId : undefined,
          fromUserId: typeof data.fromUserId === 'string' && data.fromUserId ? data.fromUserId : undefined,
          kind: (typeof data.callKind === 'string' ? data.callKind : 'voice') as import('./callNotification').CallNotifKind,
        });
      }
    } catch (e) {
      console.warn('[fcm-headless] call-cancel handling failed:', (e as Error).message);
    }
    return;
  }

  if (kind === 'voip-wake' && typeof data.callId === 'string') {
    try {
      // Round 5 / Security S3 — verify HMAC sig + nonce in the headless
      // path too. Headless JS still has Keychain access so we can load
      // the wake key. selfUserId may not be available (no Zustand
      // hydrated yet) — verifyVoipWake still computes the sig check
      // regardless of selfUserId; the user id only namespaces the
      // nonce LRU and a missing one just means we can't dedupe across
      // headless wakes (acceptable until the foreground app loads).

      const {verifyVoipWake} = require('./voipWakeVerify') as typeof import('./voipWakeVerify');
      const verdict = await verifyVoipWake({
        selfUserId: '',
        fields: {
          // callKind is NOT part of the signed wake (voipSign covers {kind,callId,nonce,exp}),
          // so it must not be passed to the verifier — the display kind is read from data below.
          kind:     'voip-wake',
          callId:   data.callId as string,
          nonce:    typeof data.nonce === 'string' ? data.nonce : undefined,
          exp:      typeof data.exp === 'string' ? Number(data.exp) : (typeof data.exp === 'number' ? data.exp : undefined),
          sig:      typeof data.sig === 'string' ? data.sig : undefined,
        },
      });
      // N-13 — the wire carries only fromUserId (no caller name, by privacy
      // design). Resolve the caller's LOCAL contact name from the persisted
      // vault so a killed-app ring is labeled with their name, not the generic
      // 'Bravo contact' — the same lookup the warm handler already does.
      const fromUserId = typeof data.fromUserId === 'string' && data.fromUserId ? data.fromUserId : undefined;
      const callKind = (typeof data.callKind === 'string' ? data.callKind : 'voice') as 'voice' | 'video' | 'group-voice' | 'group-video';
      let callerName = typeof data.callerName === 'string' && data.callerName ? data.callerName : undefined;
      if (!callerName && fromUserId) {
        try {
          const {resolveDirectPeerName} = require('./mutedLookup') as typeof import('./mutedLookup');
          callerName = (await resolveDirectPeerName(fromUserId)) ?? undefined;
        } catch { /* generic label */ }
      }

      if (!verdict.ok) {
        console.warn(`[fcm-headless] voip-wake DROPPED reason=${verdict.reason} call=${data.callId}`);
        // N-03 — a wake that fails ONLY the freshness check (device clock skew
        // or Doze deferral past the window) still proves a call was attempted.
        // Degrade to a Missed-call notification instead of total silence, so
        // the user at least learns they missed the call.
        if (verdict.reason === 'stale') {
          try {
            const cn = require('./callNotification') as typeof import('./callNotification');
            await cn.showMissedCallNotif({callId: data.callId, callerName, fromUserId, kind: callKind, conversationId: typeof data.conversationId === 'string' && data.conversationId ? data.conversationId : undefined});
          } catch (e2) {
            console.warn('[fcm-headless] stale→missed-call failed:', (e2 as Error).message);
          }
        }
        return;
      }

      // Audit Step 5.1 (B-601) — the wake is valid and we are about to ring:
      // warm the TURN cache in THIS headless VM NOW so the Answer tap's
      // getIceServers is a hit, not a fresh fetch on the answer critical path
      // (measured 164-442 ms of the caller's launch→offer, TURN off the path).
      // Same-process only — a reaped VM loses the cache and the UI boot path
      // re-fetches as the fallback; fire-and-forget so it can never block or
      // fail the ring, and a failed fetch caches nothing (turnCredentials).
      try {
        const {prewarmIceServers} = require('@/modules/messenger/webrtc/turnCredentials') as typeof import('@/modules/messenger/webrtc/turnCredentials');
        prewarmIceServers();
      } catch { /* prewarm never blocks the ring */ }

      // P1-BR-1 — mirror the warm handler: group rings reuse the roomId AS the
      // callId (gateway contract), so `data.roomId` is absent — derive it from
      // callId. Thread roomToken + conversationId (both unsigned display/routing
      // fields, NOT part of the HMAC) so the group-accept nav can `sfu.join` the
      // host's room instead of creating a new empty one.
      const isGroupKind = callKind === 'group-voice' || callKind === 'group-video';
      const roomId = isGroupKind
        ? (data.callId as string)
        : (typeof data.roomId === 'string' ? data.roomId : undefined);
      const roomToken = typeof data.roomToken === 'string' ? data.roomToken : undefined;
      const conversationId = typeof data.conversationId === 'string' ? data.conversationId : undefined;

      // WI-4.1 — mirror the warm lane's gates. In a truly-killed VM both
      // probes are trivially quiet (fresh flag, empty registries); they matter
      // in the warm-but-not-logged-in VM this handler can also serve.
      try {
        const {isRestoreModeActive} = require('../backup/restoreMode') as typeof import('../backup/restoreMode');
        if (isRestoreModeActive()) {
          console.log('[fcm-headless] restore in progress — skipping ring for', data.callId);
          return;
        }
      } catch { /* flag module unavailable — ring normally */ }
      try {
        const callReg = require('../runtime/callRegistry') as typeof import('../runtime/callRegistry');
        const groupReg = require('../runtime/groupCallRegistry') as typeof import('../runtime/groupCallRegistry');
        const live = callReg.getActiveCall();
        const liveGroup = groupReg.getActiveGroupCall();
        const busyElsewhere =
          (!!live && live.callId !== data.callId) ||
          (!!liveGroup && !liveGroup.ending && liveGroup.roomId !== data.callId);
        if (busyElsewhere) {
          console.warn('[CALLDIAG] [ring.headless] busy — suppressing system ring for', data.callId);
          return;
        }
      } catch { /* registries unavailable — ring normally */ }

      // WI-4.1 — seed the cache BEFORE any UI, exactly like the warm lane: an
      // immediate Telecom Answer/End (heads-up "Answer" before notifee even
      // renders) must find the entry, and the cold-launch Answer tap hydrates
      // its route from it. Merge semantics preserve anything a WS offer frame
      // already delivered; a tombstoned callId (declined / cancelled, caller
      // retrying the same id) refuses the whole presentation.
      const cache = require('./incomingCallCache') as typeof import('./incomingCallCache');
      const accepted = cache.setIncomingCallPayload({
        callId:         data.callId,
        callerName:     callerName ?? 'Bravo contact',
        kind:           callKind,
        fromUserId,
        conversationId,
        roomId,
        roomToken,
        // R2-2 — fan-out identity: a re-ring of a reused group roomId must
        // supersede a declined ring's tombstone (see incomingCallCache).
        ringId:         typeof data.ringId === 'string' ? data.ringId : undefined,
      });
      if (!accepted) {
        console.warn('[fcm-headless] tombstoned callId — skipping UI for', data.callId);
        return;
      }

      // WI-4.1 — raise the system call UI too (Telecom/CallKit). HONESTY
      // (review round 1): in a truly-cold headless VM this is a no-op —
      // `reportIncomingCall` gates on `setupSucceeded`, and `setupCallKit`
      // only runs from startFcmBootstrap, which never runs here. It still
      // records `activeTelecomCallId` and covers the defensive case where
      // Telecom setup DID run earlier in this process; the notifee
      // full-screen card is the real killed-app ring surface. Group kinds
      // collapse to voice/video, as the warm lane does.
      try {
        const bridge = require('./callKitBridge') as typeof import('./callKitBridge');
        bridge.reportIncomingCall({
          callId:     data.callId,
          callerName: callerName ?? 'Bravo contact',
          kind:       callKind === 'video' || callKind === 'group-video' ? 'video' : 'voice',
        });
      } catch (e2) { console.warn('[fcm-headless] callkit reportIncomingCall failed:', (e2 as Error).message); }

      const {showIncomingCallNotif} = require('./callNotification') as typeof import('./callNotification');
      await showIncomingCallNotif({
        callId:         data.callId,
        kind:           callKind,
        callerName:     callerName ?? 'Bravo contact',
        conversationId,
        fromUserId,
        roomId,
        roomToken,
      });
      console.log('[fcm-headless] voip notif displayed for call=', data.callId);
    } catch (e) {
      console.warn('[fcm-headless] voip notif failed:', (e as Error).message);
    }
    return;
  }

  if (kind === 'msg-wake') {
    // Signal-level path (founder-approved 2026-07-29): drain + PERSIST first,
    // then the store notifier banners fully-resolved (real group name, sender,
    // preview, send time) — the model Signal's PushNotificationReceiveJob
    // uses. Bounded: if the drain can't run (never logged in, restore gate,
    // no identity) or hasn't finished inside the budget, fall through to the
    // pre-drain generic/guess banner below — never zero signal, never worse
    // than before the drain existed.
    // Explicit conversationId in the wake = UNAMBIGUOUS conversation.
    const explicitConvId = typeof data.conversationId === 'string' && data.conversationId ? data.conversationId : undefined;
    const senderUserId = typeof data.senderUserId === 'string' && data.senderUserId ? data.senderUserId : undefined;
    // B-323 — the wake's display-only send time; the banner header then
    // reads when the message was sent, not when Doze let us draw it.
    const sentAtParsed = typeof data.sentAtMs === 'string' ? Number(data.sentAtMs) : NaN;
    const sentAtArg = Number.isFinite(sentAtParsed) && sentAtParsed > 0 ? {sentAtMs: sentAtParsed} : {};
    let pendingPosted = false;
    try {
      const {headlessDrainAndNotify} = require('./headlessDrain') as typeof import('./headlessDrain');
      const {snapshotCues, cueDeliveredSince} = require('./backgroundMessageNotifier') as typeof import('./backgroundMessageNotifier');
      const cuesBefore = snapshotCues(explicitConvId);
      const wakeAt = Date.now();
      // The drain starts FIRST — the placeholder below rides alongside it,
      // never in front of it.
      const drainP = headlessDrainAndNotify();
      // B-692 NL-1 — immediate SILENT shade presence while the drain works
      // (LOW channel, "Checking for new messages…"). Silent by design: a
      // sealed-sender wake could be a receipt/reaction, and an audible
      // placeholder would ding for those (P2-BR-5 scopes the mute gate to the
      // unambiguous explicit id, same rule as the fallback below).
      try {
        let placeholderAllowed = true;
        if (explicitConvId) {
          const {isConversationMuted} = require('./mutedLookup') as typeof import('./mutedLookup');
          placeholderAllowed = !(await isConversationMuted({conversationId: explicitConvId}));
        }
        if (placeholderAllowed) {
          const cn = require('./callNotification') as typeof import('./callNotification');
          await cn.showPendingWakeNotif({conversationId: explicitConvId, senderUserId, ...sentAtArg});
          pendingPosted = true;
          console.warn('[NOTIFLAT] msg-wake pending placeholder at +', Date.now() - wakeAt, 'ms');
        }
      } catch { /* placeholder is chrome — the drain result is what matters */ }
      let budgetTimer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        drainP,
        new Promise<'timeout'>(r => { budgetTimer = setTimeout(() => r('timeout'), HEADLESS_DRAIN_BUDGET_MS); }),
      ]);
      if (budgetTimer) {clearTimeout(budgetTimer);}
      // B-703 MR-1 — the two questions this gate must answer, and the reason
      // it used to answer only half of one:
      //
      // 1. Did the drain finish its job? 'drained' now means the pull
      //    completed AND left nothing on the relay. It used to mean only
      //    "pullEnvelopes resolved" — and pullEnvelopes swallows every error,
      //    so a failed fetch, and envelopes left behind by the identity-regen
      //    (B-701) or transient-sql branches, all landed here and were retired
      //    in silence. Those are now 'failed'/'incomplete' and fall through to
      //    the banner below.
      // 2. Did the user already SEE something for this wake? bannersPosted was
      //    computed for a log line and never consulted. If the drain has
      //    already put a real, named banner in the shade, the generic wake
      //    banner adds nothing and costs plenty: it collapses onto the same
      //    notifee id (downgrading the named card to "New secure message") and
      //    arms the 10 s alert-collapse window. So a posted banner retires the
      //    placeholder whatever the outcome — including a timeout whose drain
      //    banners just before the budget expires.
      //
      //    ONLY a posted banner may suppress. Two richer signals were tried
      //    during review and BOTH reopened the P0 — do not re-propose them:
      //      - "did any envelope ack": the leave-on-relay path itself sends a
      //        rehandshake nudge, which acks silently, so the stuck message the
      //        nudge was sent FOR would be masked in exactly the B-701
      //        population this exists to fix.
      //      - "did the notifier reach a verdict (a post OR a muted/own
      //        withhold)": a fresh headless VM starts with an EMPTY message map
      //        (messages live in SQLCipher, not the persisted vault), so the
      //        runtime's own hydration replays history through the notifier;
      //        one thread whose only row the user sent reads as a withhold and
      //        silenced the FIRST wake of every VM — the killed-app case.
      //    Consequence, accepted: a wake that draws no banner while something
      //    is still stuck falls back generically even when the ingested row was
      //    muted. The fallback below still suppresses an EXPLICITLY named muted
      //    conversation (P2-BR-5); what it cannot mute is the ambiguous case,
      //    which is P2-BR-5's own documented trade — the stuck envelope may
      //    belong to a different, unmuted thread.
      //    B-703 MR-19 — and "posted" has to mean the shade actually got it.
      //    notifee swallows its own display error, so the generation moved
      //    identically whether the banner landed or vanished; the witness
      //    below waits for the draw's verdict and answers false when it failed.
      // B-710 — name the sender. Without it `claimCueToken` returns false on sight,
    // so the one-cue-one-wake ledger MR-10 built was inert on this lane: the
    // "the live lane already bannered this message before I started" answer could
    // never be given, and a wake whose message was already cued drew a second,
    // generic banner for it. The warm lane has always passed it.
    const bannerPosted = await cueDeliveredSince(cuesBefore, {
      budgetMs: HEADLESS_CUE_VERDICT_BUDGET_MS,
      senderUserId: senderUserId || undefined,
    });
      if (outcome === 'drained' || bannerPosted) {
        // [NOTIFLAT] — console.warn, NOT log: release builds strip log, and the
        // whole point of these probes is attributing tap latency on device.
        console.warn('[NOTIFLAT] msg-wake outcome=', outcome, 'bannerPosted=', bannerPosted);
        // Judged either way — a surviving placeholder here would be the
        // P2-BR-3 phantom for a receipt/reaction wake.
        if (pendingPosted) {
          const cn = require('./callNotification') as typeof import('./callNotification');
          await cn.dismissPendingWakeNotif();
        }
        return;
      }
      console.warn('[NOTIFLAT] msg-wake drain outcome=', outcome, 'bannerPosted= false — falling back to wake banner');
    } catch (e) {
      console.warn('[fcm-headless] drain attempt failed:', (e as Error).message);
    }
    // FALLBACK — the pre-drain generic banner (the server wake is data-only; without this a
    // killed app that can't drain shows nothing). Tapping it brings the app forward and the
    // tap-time pull picks the message up.
    try {
      const {isConversationMuted, resolveDirectConversation, resolveConversationMeta, resolveTotalUnread} = require('./mutedLookup') as typeof import('./mutedLookup');
      // M-03/M-05 — sealed sender names only the sender. A DIRECT thread is
      // resolvable from the persisted vault (conv-keyed banner: collapse,
      // dismiss-on-read, tap deep link). A sender with NO direct thread is
      // likely a group — unresolvable here without booting the runtime, so
      // the killed path keeps a generic sender-keyed banner (group
      // mute/collapse is only honored on the warm path).
      // N-12 — resolve the local display name too, so the banner is titled
      // with the contact's name instead of the generic 'New secure message'.
      let convId = explicitConvId;
      let title: string | undefined;
      // B-324 — a DM id resolved from senderUserId is a GUESS (the sender may
      // have posted to a GROUP the wake cannot name under sealed sender).
      // Marked in the banner data so the tap handler re-routes off the
      // post-pull store instead of trusting the guess.
      let convGuessed = false;
      if (convId) {
        // B-65 — an explicit conversationId (group wakes included) resolves
        // its display name from the persisted vault, so killed-app GROUP
        // messages banner with the group's name instead of the generic
        // 'New secure message'. Same N-07 resolver the tap handler uses.
        // B-411 — bannerTitle: tagged "· Unsaved" for directory names, never
        // the `Bravo · <hex>` placeholder.
        title = (await resolveConversationMeta(convId))?.bannerTitle ?? undefined;
      }
      if (!convId && senderUserId) {
        const resolved = await resolveDirectConversation(senderUserId);
        convId = resolved?.id ?? undefined; // heuristic DM — for banner keying only, NOT the mute gate
        convGuessed = convId !== undefined;
        title = resolved?.bannerTitle;
      }
      // P2-BR-5 — suppress ONLY when the wake names its conversation
      // unambiguously (explicit conversationId). A DM id merely resolved from
      // senderUserId is ambiguous (the sender may be posting to a GROUP), so
      // muting their 1:1 must NOT silence their group messages — that class of
      // over-suppression made real group messages fully silent on the killed
      // path. Trade-off: a muted DM whose wake lacks a conversationId can still
      // banner, which is the lesser evil vs. dropping a group message.
      if (explicitConvId && await isConversationMuted({conversationId: explicitConvId})) {
        console.log('[fcm-headless] msg-wake suppressed — conversation muted');
        // The placeholder gate above shares this rule; a placeholder can only
        // be up here if that gate's mute read threw. Retire it.
        if (pendingPosted) {
          const cn = require('./callNotification') as typeof import('./callNotification');
          await cn.dismissPendingWakeNotif();
        }
        return;
      }
      const {showMessageNotif, dismissPendingWakeNotif} = require('./callNotification') as typeof import('./callNotification');
      // B-231 — carry the last-known unread total so a killed-app device's
      // launcher badge doesn't go stale. null → omit the key entirely (N-17,
      // never clobber a real count with a guess).
      const badge = await resolveTotalUnread();
      const badgeArg = typeof badge === 'number' ? {badgeCount: badge} : {};
      // B-692 NL-2 — wakeFallback: this alerted generic banner opens the
      // collapse window that keeps a late drain's named upgrades silent.
      // B-710 — NEVER key on a GUESSED conversation. `convId` here may have come
      // from `resolveDirectConversation(senderUserId)`, which is the sender's DM
      // and not wire truth: sealed sender means the message may have been posted
      // to a GROUP. Keying on it made this content-free banner land on the exact
      // notifee id the store notifier uses for that DM, so it
      //   * REPLACED the DM's rich conversation card with "New secure message"
      //     (`displayNotification` on an existing id replaces), and
      //   * captioned a GROUP message with the sender's 1:1 thread.
      // The warm lane already refuses the guessed DM for this reason
      // (`fcmBootstrap`, "NEVER the ambiguous resolved DM"); the two lanes had
      // drifted. A sender-keyed generic is retired by the named card that
      // supersedes it (`genericWakeIdBySender` in callNotification), so the
      // second shade row does not outlive the drain.
      await showMessageNotif({
        conversationId: convGuessed ? undefined : convId,
        // The guess still routes the TAP (B-324); it just no longer keys the banner.
        convRouteHint:  convGuessed ? convId : undefined,
        senderUserId, title,
        convUnconfirmed: convGuessed,
        wakeFallback: true,
        ...sentAtArg, ...badgeArg,
      });
      console.log('[fcm-headless] msg-wake banner displayed');
      // The resolved wake banner supersedes the "checking" placeholder.
      if (pendingPosted) {await dismissPendingWakeNotif();}
    } catch (e) {
      // Why: on a DOUBLE failure (drain not drained AND this fallback threw)
      // the placeholder deliberately stays up — it is the only remaining
      // signal that something arrived, and its tap pulls. For a receipt wake
      // that means a lingering silent LOW-channel entry until the next wake
      // reposts/cancels the shared id: the lesser evil vs. total silence for
      // a real message. Do not "fix" this in either direction blindly.
      console.warn('[fcm-headless] msg notif failed:', (e as Error).message);
    }
    return;
  }

  // CRIT-5 — every other server-driven wake (SOS / mission-* / booking-* /
  // agent-* / payout-settled) AND opaque {eventId} wakes must surface a
  // notification when the app is fully killed, not silently drop. Shared with
  // the warm handler so the two paths can't drift.
  try {
    const {showServerWakeNotification} = require('./serverWakeNotifications') as typeof import('./serverWakeNotifications');
    const handled = await showServerWakeNotification(data as Record<string, unknown>);
    if (!handled) {
      console.log('[fcm-headless] unknown kind, no action');
    }
  } catch (e) {
    console.warn('[fcm-headless] server-wake notif failed:', (e as Error).message);
  }
}
