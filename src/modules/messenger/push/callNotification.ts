/**
 * Production-grade incoming-call notifications backed by notifee.
 *
 * Why this exists:
 *   When the app is backgrounded or the device is locked, the existing
 *   in-app incoming-call screens (IncomingGroupCallScreen for SFU
 *   group calls, CallScreen with isIncoming for 1:1) can't pop up on
 *   their own — JS isn't running, or running but can't navigate. The
 *   user just sees nothing and the call goes unanswered.
 *
 *   This module fixes that with a notifee call-style notification:
 *
 *     - High-importance channel (IMPORTANCE_HIGH = sound + vibration +
 *       heads-up display)
 *     - Category 'call' so Android treats it as a real call (lock-screen
 *       priority, bypass DND if user allows)
 *     - fullScreenAction: 'default' — when device is LOCKED, Android
 *       launches the app full-screen the moment the notification
 *       arrives (this is what makes "phone rings on lock screen" work)
 *     - Accept / Decline actions inline so the user can answer without
 *       unlocking
 *     - Persistent (`autoCancel: false`, `ongoing: true`) — the
 *       notification stays until we explicitly dismiss it on
 *       answer/decline/hangup
 *     - Custom default ringtone (the OS-default for incoming calls)
 *
 *   The full-screen launch brings MainActivity to foreground; the
 *   existing ring dispatchers (callDispatcher / groupCallRingDispatcher)
 *   then navigate to the right ring screen. So the visible "real UI"
 *   the user sees is the existing IncomingGroupCallScreen /
 *   CallScreen — notifee is JUST the wake-up bridge.
 *
 *   Tap actions ('accept-...' / 'decline-...') are handled in
 *   fcmBootstrap.ts via notifee.onForegroundEvent +
 *   notifee.onBackgroundEvent so we can dismiss + route correctly even
 *   when the user taps from the notification shade.
 */
import notifee, {
  AndroidImportance, AndroidCategory, AndroidVisibility, AndroidStyle,
  EventType, type Event,
} from '@notifee/react-native';
import {Platform} from 'react-native';
import {RING_CHANNEL_VIBRATION, RING_NOTIF_VIBRATION} from './callVibration';
import {isDirectPrefixed, peerFromDirectSlot} from '../conversationIds';
// WI-4.9 — the missed-banner age bound lives with the other call deadlines.
import {MISSED_NOTIF_MAX_AGE_MS} from '../webrtc/callDeadlines';
// B-710 — the card cap, shared with backgroundMessageNotifier's batch sizing.
import {MSG_CARD_CAP} from './msgNotifCardCap';

// v2 (call-UI parity plan §4): SILENT channel — the ring sound is now the
// device-default RINGTONE played by BravoRingtoneModule, not a channel sound.
// Android channels are immutable after creation, so dropping the old
// channel's `sound: 'default'` (the short notification CHIME, wrongly
// looped as a "ringtone") requires a new channel id; the old channel is
// deleted at ensure time so stale installs converge.
const CHANNEL_ID        = 'bravo-incoming-call-v2';
const LEGACY_CHANNEL_ID = 'bravo-incoming-call';
const CHANNEL_NAME      = 'Incoming calls';

// B-66 — obsidian design-system cobalt; tints the monochrome ic_stat_bravo
// small icon (matches @color/notificationAccent + the FCM manifest default).
export const NOTIF_ACCENT = '#5B8DEF';

export type CallNotifKind = 'voice' | 'video' | 'group-voice' | 'group-video';

export interface IncomingCallNotifPayload {
  /** Unique per-call id; we use it as the notification tag so dismiss matches. */
  callId:           string;
  kind:             CallNotifKind;
  /** Display name shown in the title row. */
  callerName:       string;
  /** For 1:1: the offer SDP we already received via WS, or null if pending. */
  remoteUserId?:    string;
  remoteDeviceId?:  number;
  incomingSdp?:     string;
  /** For group calls: the SFU room id we should join on accept. */
  roomId?:          string;
  /** P1-BR-1 — per-recipient SFU room token; the group accept path echoes it to `sfu.join`. */
  roomToken?:       string;
  /** Conversation that owns this call — needed for navigation + history. */
  conversationId?:  string;
  /** Caller userId (for groups, this is the userId that pressed call). */
  fromUserId?:      string;
}

let channelEnsured = false;

/**
 * Idempotent channel + permission ensure. Safe to call repeatedly. The
 * channel must exist before any notification displays — Android groups
 * notifications by channel and uses its IMPORTANCE to decide whether
 * to show heads-up / play sound / etc.
 */
export async function ensureIncomingCallChannel(): Promise<void> {
  if (channelEnsured) {return;}
  if (Platform.OS !== 'android') { channelEnsured = true; return; }
  try {
    await notifee.createChannel({
      id:           CHANNEL_ID,
      name:         CHANNEL_NAME,
      importance:   AndroidImportance.HIGH,
      // NO `sound` — deliberately silent. `sound: 'default'` resolved to the
      // default NOTIFICATION chime (not the user's ringtone); the real
      // device-default ringtone is played/looped/stopped by
      // BravoRingtoneModule (see incomingRingtone.ts). Vibration stays on
      // the channel so silent/vibrate ringer modes still buzz.
      vibration:    true,
      vibrationPattern: RING_CHANNEL_VIBRATION,
      // BYPASS_DND would require a special Android permission; default
      // to off so we don't require user grants beyond POST_NOTIFICATIONS.
    });
    // Retire the v1 channel (chime-sound) so old installs don't keep a dead
    // "Incoming calls" entry in system settings alongside the v2 one.
    try { await notifee.deleteChannel(LEGACY_CHANNEL_ID); } catch { /* never created on fresh installs */ }
    channelEnsured = true;
  } catch (e) {
    console.warn('[callNotification] channel create failed:', (e as Error).message);
  }
}

// ── Message notification (killed/backgrounded chat wakes) ────────────────────
// The slim killed-app FCM handler (fcmHeadless) draws this so a backgrounded/killed app
// shows a heads-up for a new message WITHOUT booting the messenger runtime / SQLCipher / WS
// (that 2nd-VM contention is why the old headless task was removed). The body stays GENERIC
// ("New secure message") — content is E2EE and is only decrypted once the app foregrounds
// and the WS reconnects. notifee-only; safe to call from a headless JS context.
const MSG_CHANNEL_ID = 'bravo-messages';
let msgChannelEnsured = false;

// B-692 NL-2 — the alert model. The old shape was a per-conversation 10 s gag:
// after one alert, every further message in that thread for 10 s posted silent,
// which in a live exchange reads exactly as "notifications not updating". Three
// rules replace it:
//   1. A given MESSAGE alerts at most once, ever (N-29 — a re-post of the same
//      row must never re-sound). Callers that know the row pass messageId.
//   2. A short per-banner floor (ALERT_FLOOR_MS) coalesces same-thread burst
//      sounds — silent shade updates in between, like WhatsApp.
//   3. A GENERIC wake banner (wakeFallback: pre-drain, no decrypted row) opens
//      a collapse window: the named upgrades the drain posts moments later stay
//      silent, so one wake produces one sound — the original N-29
//      generic→named double-sound, solved without gagging live traffic.
// B-710 — rule 3 is now SENDER-SCOPED wherever the sender is known. The window
// exists to collapse ONE message's generic wake into its own named upgrade, and
// both halves of that pair carry the same `senderUserId`: the wake lanes have it
// from the push payload, and the store notifier reads it off the row it is
// bannering. A global window answered that question for every OTHER conversation
// too — a message from Bo, seconds after a wake from Alex, posted silent. A wake
// that names no sender still arms the global window (nothing can be matched to
// it, so the N-29 double-sound protection has to stay wide there).
const ALERT_FLOOR_MS = 1_500;
const WAKE_UPGRADE_SILENCE_MS = 10_000;
const ALERTED_MSG_TTL_MS = 60_000;
const lastAlertAtById = new Map<string, number>();
const alertedMessageIds = new Map<string, number>();
const lastWakeAlertBySender = new Map<string, number>();
// Armed by ANY alerted wake — silences posts that cannot name their sender.
let lastWakeAlertAt = 0;
// Armed only by a wake that named NO sender. Such a wake could have belonged to
// any conversation, so it is the one case where a post that DOES name its sender
// still has to be silenced — the N-29 protection stays wide exactly where the
// two halves cannot be matched, and nowhere else.
let lastAnonWakeAlertAt = 0;

// B-235 — bound WITHOUT resetting in-flight windows. A wholesale clear() at
// the bound forgot every id's last-alert time, so a just-alerted id re-alerted
// (heads-up + sound) inside its window the moment 500 other ids tripped the
// bound. Evict only entries whose window has already elapsed.
function evictExpiredAlerts(map: Map<string, number>, windowMs: number, now: number): void {
  if (map.size <= 500) {return;}
  for (const [k, t] of map) {
    if (now - t >= windowMs) {map.delete(k);}
  }
}

/**
 * B-703 MR-19 — returns the verdict AND an `undo`. The alert budget is spent
 * BEFORE the display (the answer shapes the payload), so a draw that then fails
 * would otherwise burn the message's one-alert-ever record and open the 1.5 s
 * per-thread floor for a banner that never appeared — and the fallback posted
 * moments later, on the same notifee id, would land inside that floor and show
 * up SILENT. `undo` is only safe to call when nothing else has alerted since,
 * which the timestamp guards below check.
 */
function shouldAlert(
  id: string | undefined,
  messageId: string | undefined,
  wakeFallback: boolean,
  senderUserId?: string,
): {alert: boolean; undo: () => void} {
  const noUndo = {alert: false, undo: (): void => {}};
  const now = Date.now();
  evictExpiredAlerts(lastAlertAtById, ALERT_FLOOR_MS, now);
  evictExpiredAlerts(alertedMessageIds, ALERTED_MSG_TTL_MS, now);
  evictExpiredAlerts(lastWakeAlertBySender, WAKE_UPGRADE_SILENCE_MS, now);
  // One AUDIBLE alert per message, ever. Recorded only on an actual alert
  // (the return true tail) — critic F2: a message silenced by another
  // conversation's wake window must keep its one chance, not be burned
  // without ever having sounded.
  if (messageId && alertedMessageIds.has(messageId)) {return noUndo;}
  // Rule 3 — measured from the last ALERTED wake post; a suppressed post never
  // extends the window.
  //
  // B-710 — the window is scoped to the wake's SENDER when it named one. The
  // pair it exists to collapse (generic wake → named upgrade) always shares a
  // senderUserId even when the notifee ids differ, so the sender is the correct
  // join key; the conversation id is not (a sealed-sender wake cannot name it).
  // A wake with NO sender still arms the global window, because nothing can be
  // matched to it. A post inside EITHER window stays silent.
  if (senderUserId) {
    const senderWakeAt = lastWakeAlertBySender.get(senderUserId);
    if (senderWakeAt !== undefined && now - senderWakeAt < WAKE_UPGRADE_SILENCE_MS) {return noUndo;}
    if (now - lastAnonWakeAlertAt < WAKE_UPGRADE_SILENCE_MS) {return noUndo;}
  } else if (now - lastWakeAlertAt < WAKE_UPGRADE_SILENCE_MS) {return noUndo;}
  const prevFloor = id ? lastAlertAtById.get(id) : undefined;
  if (id) {
    if (prevFloor !== undefined && now - prevFloor < ALERT_FLOOR_MS) {return noUndo;}
    lastAlertAtById.set(id, now);
  }
  if (messageId) {alertedMessageIds.set(messageId, now);}
  const prevWakeAlertAt = lastWakeAlertAt;
  const prevAnonWakeAlertAt = lastAnonWakeAlertAt;
  const prevSenderWakeAt = senderUserId ? lastWakeAlertBySender.get(senderUserId) : undefined;
  if (wakeFallback) {
    lastWakeAlertAt = now;
    if (senderUserId) {lastWakeAlertBySender.set(senderUserId, now);}
    else {lastAnonWakeAlertAt = now;}
  }
  const undo = (): void => {
    // Only roll back what is still OURS — a later alert on the same key must
    // keep its own record.
    if (id && lastAlertAtById.get(id) === now) {
      if (prevFloor === undefined) {lastAlertAtById.delete(id);}
      else {lastAlertAtById.set(id, prevFloor);}
    }
    if (messageId && alertedMessageIds.get(messageId) === now) {alertedMessageIds.delete(messageId);}
    if (wakeFallback) {
      if (lastWakeAlertAt === now) {lastWakeAlertAt = prevWakeAlertAt;}
      if (senderUserId) {
        if (lastWakeAlertBySender.get(senderUserId) === now) {
          if (prevSenderWakeAt === undefined) {lastWakeAlertBySender.delete(senderUserId);}
          else {lastWakeAlertBySender.set(senderUserId, prevSenderWakeAt);}
        }
      } else if (lastAnonWakeAlertAt === now) {lastAnonWakeAlertAt = prevAnonWakeAlertAt;}
    }
  };
  return {alert: true, undo};
}
export async function ensureMessagesChannel(): Promise<void> {
  if (msgChannelEnsured) {return;}
  if (Platform.OS !== 'android') { msgChannelEnsured = true; return; }
  try {
    await notifee.createChannel({
      id: MSG_CHANNEL_ID, name: 'Messages',
      importance: AndroidImportance.HIGH, sound: 'default', vibration: true,
    });
    msgChannelEnsured = true;
  } catch (e) {
    console.warn('[messageNotif] channel create failed:', (e as Error).message);
  }
}

// ── GAP-1/GAP-2 (industry audit 2026-07-27) — conversation cards + grouping ──
// Per-thread rolling message window for the MessagingStyle card, and the
// one-summary-over-many-threads shade shape every major messenger uses.
const MSG_GROUP_ID = 'bravo-messages-group';
const MSG_SUMMARY_ID = 'bravo-msg-summary';
// B-710 — imported, not re-declared: `backgroundMessageNotifier` sizes its batch
// against this same number, and a drifted copy would build a batch the card
// silently throws away.
const MSG_THREAD_CAP = MSG_CARD_CAP;
interface MsgThreadEntry {
  /** B-710 — the committed row, when the caller knows it. The card's dedupe key. */
  messageId?: string;
  text: string;
  /** The card's own ordering key. Falls back to draw time when nothing better is known. */
  timestamp: number;
  /**
   * B-323 — the REAL send time, or undefined. Only a real one may reach the shade
   * header (`Notification.when`): stamping draw time there claims a send time we
   * do not have, which is the lie B-323 exists to prevent.
   */
  sentAtMs?: number;
  senderName: string;
  senderIcon?: string;
}
/** B-710 — the newest real send time in a card, or undefined if none is known. */
function newestSentAt(thread: MsgThreadEntry[]): number | undefined {
  let best: number | undefined;
  for (const m of thread) {
    if (m.sentAtMs !== undefined && (best === undefined || m.sentAtMs > best)) {best = m.sentAtMs;}
  }
  return best;
}
const msgThreads = new Map<string, MsgThreadEntry[]>();
/** B-710 — the last title rendered for a thread, so a retained re-render keeps it. */
const msgThreadTitles = new Map<string, string>();
const activeMsgNotifIds = new Set<string>();
// B-710 — notifee ids that are currently showing a CONTENT-FREE wake banner,
// keyed by the sender the wake named. The named card that supersedes one is
// drawn under a different id (the wake could not resolve the conversation), so
// without this the generic row sits in the shade forever beside it — never
// updating, and counted by the group summary as a separate conversation.
const genericWakeIdBySender = new Map<string, string>();
const GENERIC_WAKE_SENDERS_MAX = 200;
// Only cancel a summary that was actually posted — single-thread flows (the
// overwhelmingly common case) must produce ZERO extra notifee traffic.
let msgSummaryVisible = false;

// B-710 — draws on one notifee id are serialised. `showMessageNotif` snapshots
// the card synchronously and then awaits a native round-trip, so two overlapping
// draws for the same thread build [m1] and [m1,m2] and race to notify(): if the
// older one lands last the shade is left showing message 1 while the accumulator
// believes both are up. A Person `icon` is a remote URL that notifee resolves
// natively before it notifies, so the slower draw really can be the older one.
// One chain per id. `dismissMessageNotif` (the read path) joins it, so opening a
// chat can no longer be undone by a draw that was already in flight. The notifee
// DISMISSED hook does NOT join it: it is a synchronous map clear driven by an OS
// callback, and the residual race there costs one re-rendered card rather than a
// banner for a chat the user is looking at.
const msgDrawChains = new Map<string, Promise<void>>();
const MSG_DRAW_LINK_BUDGET_MS = 5_000;

function serialiseMsgDraw<T>(id: string | undefined, run: () => Promise<T>): Promise<T> {
  if (!id) {return run();}
  const prev = msgDrawChains.get(id);
  // Uncontended: run INLINE. Chaining off a resolved promise would insert a
  // microtask hop before every draw, and this repo has already lost a session to
  // an extra tick shifting hydration order (the persist adapter's `getItem`).
  // Ordering is unaffected — a second draw arriving while this one is in flight
  // still finds the link below and queues behind it.
  const result = prev ? prev.then(run, run) : run();
  // The stored link never carries a value or a rejection — it exists only to
  // order the next draw behind this one.
  //
  // ...and it is BOUNDED. A `displayNotification` that never settles is the
  // wedged-binder case `awaitPendingCues` already defends against, and a Person
  // `icon` is a remote URL notifee resolves natively before it notifies. An
  // unbounded chain would turn one hung avatar fetch into permanent silence for
  // that conversation; the budget degrades it back to what it was before the
  // chain existed — one lost banner, then normal service.
  const link = new Promise<void>(resolve => {
    let done = false;
    const settle = (): void => { if (!done) {done = true; resolve();} };
    const timer = setTimeout(settle, MSG_DRAW_LINK_BUDGET_MS);
    if (typeof (timer as unknown as {unref?: () => void})?.unref === 'function') {
      (timer as unknown as {unref: () => void}).unref();
    }
    void result.then(() => { clearTimeout(timer); settle(); }, () => { clearTimeout(timer); settle(); });
  });
  msgDrawChains.set(id, link);
  // Drop the id once this link is the tail, so the map cannot grow with every
  // conversation the device has ever bannered.
  void link.then(() => { if (msgDrawChains.get(id) === link) {msgDrawChains.delete(id);} });
  return result;
}

/**
 * B-710 — drop every accumulator on SIGN-OUT.
 *
 * `msgThreads` holds DECRYPTED previews and was retired only by
 * `dismissMessageNotif`, i.e. per conversation, on read. Nothing cleared it when
 * the account changed — and 1:1 threads are keyed `direct:<peerUserId>`, which is
 * the SAME id for two accounts that both talk to the same peer. So after an
 * account switch a content-free wake could re-render the PREVIOUS account's
 * decrypted preview into the new account's shade. That is the hazard the MR-10
 * note named, and the retain path makes it reachable, so it is closed here
 * rather than accepted.
 */
export function clearMessageNotifState(): void {
  msgThreads.clear();
  msgThreadTitles.clear();
  activeMsgNotifIds.clear();
  genericWakeIdBySender.clear();
  msgDrawChains.clear();
  msgSummaryVisible = false;
  lastAlertAtById.clear();
  alertedMessageIds.clear();
  lastWakeAlertBySender.clear();
  lastWakeAlertAt = 0;
  lastAnonWakeAlertAt = 0;
}

/** Test seam — the thread/group accumulators and alert records are module state. */
export function _resetMsgNotifStateForTest(): void {
  clearMessageNotifState();
}

/**
 * B-710 — insert a message into a thread card, in SEND order, at most once.
 *
 * The old shape was a bare `push` + `shift` past the cap, which gave the card
 * two defects the founder could see: an out-of-order draw (a racing wake, a
 * drain that splices a late message into send order) rendered the rows in
 * ARRIVAL order, and a re-draw of the same row — a push retry, the same message
 * arriving over both WS and the HTTP drain, a background→foreground redraw —
 * appended its text a second time. The alert model deduped the SOUND; nothing
 * deduped the CARD.
 *
 * Insertion is a scan from the tail rather than a sort, so equal timestamps keep
 * arrival order (the common case: several rows stamped in the same millisecond).
 */
function insertThreadEntry(thread: MsgThreadEntry[], entry: MsgThreadEntry): MsgThreadEntry[] {
  let next = entry;
  if (entry.messageId) {
    const at = thread.findIndex(m => m.messageId === entry.messageId);
    if (at >= 0) {
      // Re-draw of a row we already show: an edit, a caption arriving with the
      // media, a retried push. Merge, but a plain spread would let an UNDEFINED
      // field on the new draw blank a value the old one knew — losing the real
      // send time (and with it the shade header, B-323) or the sender's avatar.
      const prev = thread[at];
      next = {
        ...prev,
        ...entry,
        sentAtMs:   entry.sentAtMs   ?? prev.sentAtMs,
        senderIcon: entry.senderIcon ?? prev.senderIcon,
        timestamp:  entry.sentAtMs !== undefined ? entry.timestamp : prev.timestamp,
      };
      thread.splice(at, 1); // re-insert below, in case the time moved
    }
  }
  let i = thread.length;
  while (i > 0 && thread[i - 1].timestamp > next.timestamp) {i--;}
  thread.splice(i, 0, next);
  while (thread.length > MSG_THREAD_CAP) {thread.shift();} // the OLDEST goes
  return thread;
}

/**
 * B-710 — a banner the user SWIPED AWAY is gone, and the accumulators have to
 * learn that. Nothing observed `EventType.DISMISSED`, so a dismissed thread kept
 * its card (already-read text reappeared under the next message) and its group
 * membership (the summary counted banners that were no longer showing).
 *
 * Called from the ONE notifee background handler and the foreground one; safe to
 * call for an id we never drew.
 */
export function noteMessageNotifDismissed(notifId: string | undefined): void {
  if (!notifId) {return;}
  // Critic D9 — Android delivers the delete intent for the SUMMARY row only, but
  // dismissing it takes every child banner off the shade with it. Without this
  // the children's accumulators survived and the next message re-rendered up to
  // seven already-dismissed previews onto the lock screen — the exact defect the
  // dismissal handling exists to close.
  if (notifId === MSG_SUMMARY_ID) {
    msgThreads.clear();
    msgThreadTitles.clear();
    activeMsgNotifIds.clear();
    genericWakeIdBySender.clear();
    msgSummaryVisible = false;
    return;
  }
  msgThreads.delete(notifId);
  msgThreadTitles.delete(notifId);
  const had = activeMsgNotifIds.delete(notifId);
  for (const [sender, id] of genericWakeIdBySender) {
    if (id === notifId) {genericWakeIdBySender.delete(sender);}
  }
  // Re-sync only if the group membership actually changed; the summary is
  // chrome and must never take a message banner down with it.
  if (had) {void syncMsgSummary();}
}

/**
 * Post/refresh the group summary when ≥2 thread banners are showing; clear it
 * below that. Best-effort chrome — a summary failure must never take the
 * message banner down with it.
 */
async function syncMsgSummary(): Promise<void> {
  try {
    if (activeMsgNotifIds.size >= 2) {
      msgSummaryVisible = true;
      await notifee.displayNotification({
        id: MSG_SUMMARY_ID,
        title: 'Bravo Secure',
        body: `${activeMsgNotifIds.size} conversations`,
        android: {
          channelId:     MSG_CHANNEL_ID,
          smallIcon:     'ic_stat_bravo',
          color:         NOTIF_ACCENT,
          category:      AndroidCategory.MESSAGE,
          visibility:    AndroidVisibility.PRIVATE,
          groupId:       MSG_GROUP_ID,
          groupSummary:  true,
          onlyAlertOnce: true,
          pressAction:   {id: 'default', launchActivity: 'default'},
        },
      });
    } else if (msgSummaryVisible) {
      msgSummaryVisible = false;
      await notifee.cancelNotification(MSG_SUMMARY_ID);
    }
  } catch { /* summary is chrome, never load-bearing */ }
}

export async function showMessageNotif(p: {
  conversationId?: string;
  senderUserId?:   string;
  /** Display title. LOCALLY-derived only (store conversation name) — never wire data. */
  title?:          string;
  /**
   * N-10 — message preview text. LOCALLY-derived only (decrypted store tail on
   * the WARM path). NEVER pass killed-path/wire content here: the killed
   * headless VM cannot decrypt, so it never has plaintext to leak. When
   * present we render a Telegram-style MessagingStyle card; when absent the
   * banner stays generic ("Open Bravo Secure to read it").
   */
  body?:           string;
  /** Sender's local display name for the MessagingStyle Person (groups). */
  senderName?:     string;
  /**
   * B-327 — the sender's directory profile-photo URL (the same
   * `directoryAvatars` source UserAvatar renders in-app), so the card shows
   * their face instead of Android's default letter disc. Optional; absent
   * keeps the letter avatar.
   */
  senderIconUrl?:  string;
  /** N-17 — total unread across conversations, for the launcher badge. */
  badgeCount?:     number;
  /** N-10 — enable inline Reply + Mark-as-read actions (warm path, runtime alive). */
  actions?:        boolean;
  /**
   * B-323 — the message's SEND time (epoch ms). Stamped on the style message
   * and the shade header so a Doze/drain-delayed banner reads the time the
   * message was SENT, not when it happened to be drawn.
   */
  sentAtMs?:       number;
  /**
   * B-324 — conversationId above is a sealed-sender GUESS (the sender's DM),
   * not wire truth. Rides the data as `convGuess` so the tap handler re-routes
   * off the post-pull store instead of deep-linking the possibly-wrong DM.
   */
  convUnconfirmed?: boolean;
  /**
   * B-710 — a GUESSED conversation id: good enough to deep-link a tap (paired
   * with `convUnconfirmed`, which tells the tap handler to re-route off the
   * post-pull store), never good enough to key the notification on.
   *
   * The two uses had been conflated. Keying a content-free wake banner on a
   * guess put it on the same notifee id as the store notifier's rich card for
   * that DM and replaced it — and for a group message it captioned the wrong
   * thread entirely. This rides in `data` only; the notifee id stays
   * sender-keyed.
   */
  convRouteHint?:  string;
  /**
   * B-692 NL-2 — the committed row this banner announces (warm/store path).
   * Lets the alert model guarantee a message sounds at most once, ever, however
   * many times its banner is re-composed.
   */
  messageId?:      string;
  /**
   * B-692 NL-2 — set ONLY by the pre-drain generic wake banners (fcmHeadless
   * fallback, fcmBootstrap warm wake draws). An alerted wake banner opens the
   * collapse window that keeps the drain's named upgrades silent — one wake,
   * one sound. Store-notifier posts must never set it.
   */
  wakeFallback?:   boolean;
  /**
   * B-710 — rows that arrived in the SAME store commit ahead of `body`, oldest
   * first. They join the conversation card silently: the batch is one event from
   * the user's point of view, so the newest row owns the title and the one alert.
   * Without this the notifier bannered only the newest row of a commit and the
   * ones between never reached the card at all — the offline catch-up case,
   * where several messages land together.
   */
  preceding?:      Array<{messageId?: string; body: string; senderName?: string; senderIconUrl?: string; sentAtMs?: number; senderUserId?: string}>;
}): Promise<boolean> {
  if (Platform.OS !== 'android') {return false;}
  // B-710 — one draw at a time per notifee id. See `serialiseMsgDraw`.
  const serialiseId = p.conversationId
    ? `bravo-msg-${p.conversationId}`
    : (p.senderUserId ? `bravo-msg-sender:${p.senderUserId}` : undefined);
  return serialiseMsgDraw(serialiseId, () => showMessageNotifInner(p));
}

async function showMessageNotifInner(p: Parameters<typeof showMessageNotif>[0]): Promise<boolean> {
  await ensureMessagesChannel();
  const data: Record<string, string> = {kind: 'msg-wake'};
  if (p.conversationId) {data.conversationId = p.conversationId;}
  else if (p.convRouteHint) {data.conversationId = p.convRouteHint;}
  if (p.senderUserId) {data.senderUserId = p.senderUserId;}
  if (p.convUnconfirmed) {data.convGuess = '1';}
  const sentAtMs = (typeof p.sentAtMs === 'number' && Number.isFinite(p.sentAtMs) && p.sentAtMs > 0)
    ? p.sentAtMs
    : undefined;
  // M-03 — collapse per conversation when the thread is locally resolvable;
  // otherwise per sender (bounded stacking for likely-group wakes, whose
  // conversation is unknowable under sealed sender).
  const id = p.conversationId
    ? `bravo-msg-${p.conversationId}`
    : (p.senderUserId ? `bravo-msg-sender:${p.senderUserId}` : undefined);
  // B-710 — RETAIN, never downgrade. A wake draw carries no body (it cannot
  // decrypt), and when it lands on an id that is already showing a conversation
  // card it REPLACES that card with "Open Bravo Secure to read it". That is the
  // founder's "the notification went back to the first/blank message", and it is
  // the commonest killed-lane shape: `fcmHeadless` resolves a DM's conversation
  // id LOCALLY (`mutedLookup.resolveDirectConversation`), so the wake and the
  // store notifier share one notifee id.
  //
  // The MR-10 note that removed an earlier version of this branch reasoned from
  // "the server puts no conversationId on a chat wake, so the fallback is always
  // sender-keyed" — true of the SERVER, but the client resolves one itself. Its
  // three hazards are answered rather than accepted:
  //   * a SWIPED-AWAY banner being re-rendered → `noteMessageNotifDismissed`
  //     now clears the accumulator on the notifee DISMISSED event;
  //   * a SENDER-keyed id aggregating several conversations being captioned with
  //     one thread's title → retention is refused for sender-keyed ids outright;
  //   * a re-render RE-ALERTING → a retained draw never alerts (it announces no
  //     new row, so it spends no alert budget).
  // Critic D1 — gated on `wakeFallback`, NOT merely on a missing body. The store
  // notifier also draws body-less: `previewForNotif` returns undefined when the
  // user turns content previews OFF (applied live from Messenger settings) or
  // when a row's text is empty. Retaining there would re-render the previews
  // that setting exists to withhold, take the silent path, and never add the new
  // row — a thread frozen on its old content, which is the very symptom this
  // whole fix is about. Only a WAKE draw, which is content-free because it
  // cannot decrypt, may re-render what is already there.
  const retained = (p.wakeFallback && !p.body && !!p.conversationId && !!id)
    ? msgThreads.get(id)
    : undefined;
  const retainedCard = retained && retained.length > 0 ? retained : undefined;
  // B-692 NL-2 — per-message once-ever + short per-thread floor + wake collapse.
  const {alert: alertNow, undo: undoAlert} = retainedCard
    ? {alert: false, undo: (): void => {}}
    : shouldAlert(id, p.messageId, !!p.wakeFallback, p.senderUserId);
  // N-10 — inline actions (only meaningful when the runtime can act, i.e. warm).
  const actions = (p.actions && p.conversationId)
    ? [
        {
          title: 'Mark as read',
          pressAction: {id: `read-${p.conversationId}`},
        },
        {
          title: 'Reply',
          pressAction: {id: `reply-${p.conversationId}`},
          input: {
            allowFreeFormInput: true,
            placeholder: 'Reply…',
            editableInputEnabled: true,
          },
        },
      ]
    : undefined;
  // N-10 + GAP-1 (industry audit 2026-07-27) — a CONVERSATION card, not a
  // single line. The card accumulates the thread's recent messages (capped)
  // so five texts read as one thread, matching WhatsApp/Signal. People are
  // modelled per the platform contract: top-level `person` is the DEVICE
  // USER ("You"); each message carries its own sender — the old shape put
  // the sender at top level, which models every message as sent by you.
  // B-327 — a Person carries an icon only when one is known; an absent key
  // (not undefined) keeps notifee/Android on the default letter avatar.
  const personFor = (name: string, icon?: string): {name: string; icon?: string} =>
    (icon ? {name, icon} : {name});
  let style;
  // B-710 — the line the collapsed banner shows and the shade's sort key are
  // both taken from the NEWEST row in the card, not from whichever draw ran
  // last. Without that, a late-arriving older message rewrote the one-line
  // preview with its own text and pushed `Notification.when` backwards, which
  // is Android's shade sort order — an older notification overwriting a newer.
  let cardBody: string | undefined;
  let cardWhenMs: number | undefined;
  let retainedOnly = false;
  // Only a RETAINED re-render may borrow a remembered title, and retention is
  // conversation-keyed only — a sender-keyed id aggregates several threads, so
  // captioning it with one thread's name is the MR-10 hazard, not a nicety.
  const cardTitle = p.title ?? (retainedCard && id ? msgThreadTitles.get(id) : undefined);
  if (retainedCard && id) {
    style = {
      type: AndroidStyle.MESSAGING as const,
      person: {name: 'You'},
      messages: retainedCard.map(m => ({text: m.text, timestamp: m.timestamp, person: personFor(m.senderName, m.senderIcon)})),
      ...(cardTitle ? {title: cardTitle, group: true} : {}),
    };
    cardBody = retainedCard[retainedCard.length - 1].text;
    // Critic D9 — ONLY the retained rows' own times. `sentAtMs` here belongs to
    // the incoming message, which this branch deliberately does not render;
    // publishing it would sort the card to the top of the shade advertising a
    // time for content that is not in it. B-323: never claim a time we do not
    // have for what is shown.
    cardWhenMs = newestSentAt(retainedCard);
    retainedOnly = true;
  } else if (p.body && id) {
    const senderName = p.senderName || p.title || 'Message';
    let thread = msgThreads.get(id) ?? [];
    for (const m of p.preceding ?? []) {
      const at = (typeof m.sentAtMs === 'number' && Number.isFinite(m.sentAtMs) && m.sentAtMs > 0) ? m.sentAtMs : undefined;
      thread = insertThreadEntry(thread, {
        messageId: m.messageId,
        text: m.body,
        timestamp: at ?? Date.now(),
        sentAtMs: at,
        senderName: m.senderName || p.title || 'Message',
        senderIcon: m.senderIconUrl,
      });
    }
    thread = insertThreadEntry(thread, {
      messageId: p.messageId,
      text: p.body,
      timestamp: sentAtMs ?? Date.now(),
      sentAtMs,
      senderName,
      senderIcon: p.senderIconUrl,
    });
    msgThreads.set(id, thread);
    if (cardTitle && p.conversationId) {msgThreadTitles.set(id, cardTitle);}
    style = {
      type: AndroidStyle.MESSAGING as const,
      person: {name: 'You'},
      messages: thread.map(m => ({text: m.text, timestamp: m.timestamp, person: personFor(m.senderName, m.senderIcon)})),
      ...(cardTitle ? {title: cardTitle, group: true} : {}),
    };
    cardBody = thread[thread.length - 1].text;
    cardWhenMs = newestSentAt(thread);
  } else if (p.body) {
    style = {
      type: AndroidStyle.MESSAGING as const,
      person: {name: 'You'},
      messages: [{text: p.body, timestamp: sentAtMs ?? Date.now(), person: personFor(p.senderName || p.title || 'Message', p.senderIconUrl)}],
      ...(p.title ? {title: p.title, group: true} : {}),
    };
    cardBody = p.body;
    cardWhenMs = sentAtMs;
  }
  // B-703 MR-19 — the answer the wake lanes need: was a banner ACTUALLY drawn?
  // This catch used to swallow the failure whole, so `post()` above it could
  // never see one, and the generation it had already bumped told the FCM
  // fallback "a banner exists" for a message that produced nothing at all.
  let drawn = false;
  try {
    // GAP-2 — group membership is recorded first, but the summary is synced
    // AFTER the banner (B-692 NL-8): first paint must not wait a native
    // round-trip behind the group-summary chrome. Android accepts members
    // preceding their summary.
    if (id) {activeMsgNotifIds.add(id);}
    await notifee.displayNotification({
      id,
      title: cardTitle || 'New secure message',
      body: cardBody || p.body || 'Open Bravo Secure to read it',
      data,
      android: {
        channelId:  MSG_CHANNEL_ID,
        importance: AndroidImportance.HIGH,
        category:   AndroidCategory.MESSAGE,
        visibility: AndroidVisibility.PRIVATE,
        smallIcon:  'ic_stat_bravo',
        color:      NOTIF_ACCENT, // B-66 — tint the monochrome mark (else OS-default grey)
        // N-29 — collapse the generic-FCM→named-store upgrade and rapid bursts
        // (onlyAlertOnce=true → silent update) but re-alert a genuinely new
        // message once the burst window has passed (onlyAlertOnce=false).
        onlyAlertOnce: !alertNow,
        // B-323 — the shade header shows the SEND time when known; without it
        // the keys stay absent (never claim a send time we don't have).
        // B-710 — the NEWEST row in the card wins, so a late older message can
        // never push `Notification.when` (Android's shade sort key) backwards.
        ...((): Record<string, unknown> => {
          const when = retainedOnly
            ? cardWhenMs
            : (cardWhenMs !== undefined || sentAtMs !== undefined
              ? Math.max(cardWhenMs ?? 0, sentAtMs ?? 0)
              : undefined);
          return when !== undefined ? {timestamp: when, showTimestamp: true} : {};
        })(),
        // N-17 — launcher badge tracks total unread (launcher-dependent: dot
        // or number). Omitted when unknown so we never clobber a real count.
        ...(typeof p.badgeCount === 'number' ? {badgeCount: Math.max(0, p.badgeCount)} : {}),
        ...(style ? {style} : {}),
        ...(actions ? {actions} : {}),
        // GAP-2 — every thread banner joins the one app group; the summary
        // sync follows the display below.
        groupId: MSG_GROUP_ID,
        // GAP-1 — conversation identity for Android's conversation space.
        // Harmless while the launcher shortcut is unpublished (the native
        // ShortcutManager publisher is the flagged follow-up); load-bearing
        // the moment it lands.
        ...(p.conversationId ? {shortcutId: p.conversationId} : {}),
        pressAction: {id: 'default', launchActivity: 'default'},
      },
    });
    drawn = true;
    // B-710 — bookkeeping for the generic→named handover.
    if (id && p.senderUserId) {
      // Critic D4 — `!style` alone means "this draw had no preview text", which
      // is ALSO true of an ordinary store banner with previews off, or a row
      // whose preview is empty (a call record, a tombstone). Recording those
      // both ORPHANED the real sender-keyed wake (overwritten in the map) and
      // let an unrelated later message CANCEL a live conversation banner. Only a
      // content-free WAKE on a SENDER-keyed id qualifies: that is the row which
      // carries no information and is safe to retire.
      if (!style && p.wakeFallback && !p.conversationId) {
        genericWakeIdBySender.set(p.senderUserId, id);
        if (genericWakeIdBySender.size > GENERIC_WAKE_SENDERS_MAX) {
          const oldest = genericWakeIdBySender.keys().next();
          if (!oldest.done) {genericWakeIdBySender.delete(oldest.value);}
        }
      } else if (style) {
        // A card WITH content for this sender supersedes their content-free
        // wake banner. Under sealed sender the wake could not name the
        // conversation, so it is keyed `bravo-msg-sender:<uid>` while this card
        // is `bravo-msg-<conv>` — two shade rows for one message, the generic
        // one frozen forever because nothing else ever draws to it.
        //
        // Retiring it can also clear the signal for a DIFFERENT thread of the
        // same sender, since one sender-keyed banner aggregates them. That is
        // the trade `dismissMessageNotif` already makes on read, and it fails in
        // the right direction: the generic row carries no information, while the
        // unread badge and the chat list still show there is something to read.
        const stale = genericWakeIdBySender.get(p.senderUserId);
        if (stale && stale !== id) {
          genericWakeIdBySender.delete(p.senderUserId);
          msgThreads.delete(stale);
          msgThreadTitles.delete(stale);
          activeMsgNotifIds.delete(stale);
          try { await notifee.cancelNotification(stale); }
          catch { /* the row may already be gone; the summary sync below still corrects the count */ }
        } else if (stale === id) {
          genericWakeIdBySender.delete(p.senderUserId);
        }
      }
    }
    if (id) {await syncMsgSummary();}
  } catch (e) {
    console.warn('[messageNotif] display failed:', String((e as Error)?.message ?? e));
  }
  // B-703 MR-19 — give the alert budget back: nothing was shown, so this
  // message has not had its one sound, and the thread's 1.5 s floor must not
  // silence the fallback that is about to stand in for it.
  if (!drawn && alertNow) {undoAlert();}
  return drawn;
}

// ── B-692 NL-1 — the killed-lane "checking" placeholder ──────────────────────
// The killed msg-wake path draws NOTHING until a full runtime boot + drain
// completes or the 8 s budget expires. This placeholder gives the shade an
// IMMEDIATE presence instead — on its own LOW-importance channel: no sound, no
// heads-up, because a sealed-sender wake is indistinguishable from a
// receipt/reaction wake, and an audible placeholder would ding for every read
// receipt (the P2-BR-3 phantom class). The drain's named banner (HIGH channel)
// carries the alert; a drained outcome cancels the placeholder either way, so
// a receipt wake leaves at most a brief silent shade entry. Deliberately
// OUTSIDE the thread-card/summary accumulators and the alert model.
const MSG_PENDING_CHANNEL_ID = 'bravo-messages-pending';
const MSG_PENDING_NOTIF_ID   = 'bravo-msg-pending';
let msgPendingChannelEnsured = false;

async function ensurePendingChannel(): Promise<void> {
  if (msgPendingChannelEnsured) {return;}
  try {
    await notifee.createChannel({
      id: MSG_PENDING_CHANNEL_ID, name: 'Message check',
      importance: AndroidImportance.LOW, vibration: false,
    });
    msgPendingChannelEnsured = true;
  } catch (e) {
    console.warn('[messageNotif] pending channel create failed:', (e as Error).message);
  }
}

export async function showPendingWakeNotif(p: {
  conversationId?: string;
  senderUserId?:   string;
  sentAtMs?:       number;
}): Promise<void> {
  // OR-3 — iOS draws nothing client-side; the APNs alert is the only lane.
  if (Platform.OS !== 'android') {return;}
  await ensurePendingChannel();
  const data: Record<string, string> = {kind: 'msg-wake'};
  if (p.conversationId) {data.conversationId = p.conversationId;}
  if (p.senderUserId) {data.senderUserId = p.senderUserId;}
  const sentAtMs = (typeof p.sentAtMs === 'number' && Number.isFinite(p.sentAtMs) && p.sentAtMs > 0)
    ? p.sentAtMs
    : undefined;
  try {
    await notifee.displayNotification({
      id: MSG_PENDING_NOTIF_ID,
      title: 'Bravo Secure',
      // Honest body — it claims a check, never a message (a receipt wake must
      // not manufacture a "New secure message" the drain then deletes).
      body: 'Checking for new messages…',
      data,
      android: {
        channelId:  MSG_PENDING_CHANNEL_ID,
        importance: AndroidImportance.LOW,
        category:   AndroidCategory.MESSAGE,
        visibility: AndroidVisibility.PRIVATE,
        smallIcon:  'ic_stat_bravo',
        color:      NOTIF_ACCENT,
        onlyAlertOnce: true,
        ...(sentAtMs !== undefined ? {timestamp: sentAtMs, showTimestamp: true} : {}),
        pressAction: {id: 'default', launchActivity: 'default'},
      },
    });
  } catch (e) {
    console.warn('[messageNotif] pending display failed:', (e as Error).message);
  }
}

export async function dismissPendingWakeNotif(): Promise<void> {
  if (Platform.OS !== 'android') {return;}
  try {
    await notifee.cancelNotification(MSG_PENDING_NOTIF_ID);
  } catch { /* best-effort — a stale "checking" entry is chrome, not state */ }
}

/**
 * Dismiss-on-read — cancel a conversation's message banner(s) when the user
 * opens/reads the thread. Every path (warm FCM, killed FCM, store-driven
 * backgroundMessageNotifier) now funnels through showMessageNotif's
 * `bravo-msg-<id>`; the `msg-wake:<id>` cancel covers banners drawn by
 * pre-M-03 builds that survive an app update in the shade.
 */
export async function dismissMessageNotif(conversationId?: string, memberUserIds?: string[]): Promise<void> {
  if (Platform.OS !== 'android' || !conversationId) {return;}
  // B-710 — a dismissal joins the SAME per-id chain as the draws.
  //
  // It retires `msgThreads` synchronously and then awaits its cancels, while a
  // draw already past its first await still holds the card snapshot it built and
  // will re-display it afterwards. That is "I opened the chat, the banner
  // cleared, and then it came back". Nothing here ever calls back into
  // `showMessageNotif`, so the chain cannot deadlock.
  return serialiseMsgDraw(`bravo-msg-${conversationId}`, () => dismissMessageNotifInner(conversationId, memberUserIds));
}

async function dismissMessageNotifInner(conversationId: string, memberUserIds?: string[]): Promise<void> {
  // GAP-1/GAP-2 — retire the thread's accumulated card + its group membership
  // for every id this dismissal covers, then re-sync the summary.
  const retire = (nid: string): void => {
    msgThreads.delete(nid);
    // Critic D10 — the title cache and the generic-wake ledger are keyed on the
    // same ids. Left behind, the title grew one entry per conversation ever
    // bannered, and the ledger kept pointing at an id that had just been
    // cancelled — so the next card for that sender fired a cancel at a dead id
    // and wiped its accumulators.
    msgThreadTitles.delete(nid);
    for (const [sender, gid] of genericWakeIdBySender) {
      if (gid === nid) {genericWakeIdBySender.delete(sender);}
    }
    activeMsgNotifIds.delete(nid);
  };
  retire(`bravo-msg-${conversationId}`);
  if (isDirectPrefixed(conversationId)) {
    retire(`bravo-msg-sender:${peerFromDirectSlot(conversationId)}`);
  }
  for (const uid of memberUserIds ?? []) {
    if (uid) {retire(`bravo-msg-sender:${uid}`);}
  }
  try {
    await notifee.cancelNotification(`msg-wake:${conversationId}`);
    await notifee.cancelNotification(`bravo-msg-${conversationId}`);
    // Why: a first-contact banner is drawn sender-keyed (the thread didn't
    // exist yet); opening the shadow-created direct:<peer> thread must clear
    // it too or the banner outlives the read.
    if (isDirectPrefixed(conversationId)) {
      await notifee.cancelNotification(`bravo-msg-sender:${peerFromDirectSlot(conversationId)}`);
    }
    // P3 — a killed-app GROUP message is banner-keyed by its SENDER (the group
    // couldn't be resolved headless). Opening/reading the thread must clear
    // those sender-keyed banners too; the caller passes the conversation's
    // member/peer user ids from the live store.
    for (const uid of memberUserIds ?? []) {
      if (uid) { await notifee.cancelNotification(`bravo-msg-sender:${uid}`); }
    }
    await syncMsgSummary();
  } catch (e) {
    console.warn('[messageNotif] dismiss failed:', (e as Error).message);
  }
}

// ── Missed-call notification ─────────────────────────────────────────────────
// When a ring ends unanswered (caller hung up while ringing, or the 45s ring
// timed out) we post a persistent, low-priority "Missed call" entry — WhatsApp/
// Signal behavior — so a backgrounded user sees they missed a call after the
// ring notification auto-dismisses. Separate LOW channel: informational, no
// sound/vibration (the ring already rang).
const MISSED_CHANNEL_ID = 'bravo-missed-calls';
let missedChannelEnsured = false;
async function ensureMissedCallChannel(): Promise<void> {
  if (missedChannelEnsured || Platform.OS !== 'android') { missedChannelEnsured = true; return; }
  try {
    await notifee.createChannel({
      id: MISSED_CHANNEL_ID,
      name: 'Missed calls',
      importance: AndroidImportance.DEFAULT,
    });
    missedChannelEnsured = true;
  } catch (e) {
    console.warn('[missedCall] channel create failed:', (e as Error).message);
  }
}

export async function showMissedCallNotif(p: {callId: string; callerName?: string; kind?: CallNotifKind; fromUserId?: string; conversationId?: string}): Promise<void> {
  if (Platform.OS !== 'android') {return;}
  await ensureMissedCallChannel();
  const isVideo = p.kind === 'video' || p.kind === 'group-video';
  // P1-7 — carry fromUserId so tapping the Missed-call banner can deep-link to
  // the caller's 1:1 thread instead of opening a ghost incoming CallScreen.
  // WI-4.9 — carry conversationId too (where the producer knows it), so
  // opening that thread can retire the banner even when the ringer's uid
  // doesn't identify the thread (group calls).
  const data: Record<string, string> = {kind: 'missed-call', callId: p.callId};
  if (p.fromUserId) {data.fromUserId = p.fromUserId;}
  if (p.conversationId) {data.conversationId = p.conversationId;}
  try {
    await notifee.displayNotification({
      // Distinct id from the ring notif so posting the miss doesn't collide
      // with (or get cleared by) the ring's own dismissal.
      id: `bravo-missed-${p.callId}`,
      title: 'Missed call',
      body: `${isVideo ? 'Video' : 'Voice'} call from ${p.callerName || 'Bravo contact'}`,
      data,
      android: {
        channelId: MISSED_CHANNEL_ID,
        importance: AndroidImportance.DEFAULT,
        // notifee's AndroidCategory has no MISSED_CALL member; CALL is the
        // closest telephony category and renders appropriately.
        category: AndroidCategory.CALL,
        visibility: AndroidVisibility.PRIVATE,
        smallIcon: 'ic_stat_bravo',
        color: NOTIF_ACCENT, // B-66
        pressAction: {id: 'default', launchActivity: 'default'},
      },
    });
  } catch (e) {
    console.warn('[missedCall] display failed:', (e as Error).message);
  }
}

/**
 * WI-4.9 — retire "Missed call" banners the user has acted on by another
 * door: opening the caller's thread, calling them back, or the caller ringing
 * again. The banner id is keyed by callId — which none of those lanes know —
 * so matching is by the data block's fromUserId / conversationId. Only
 * `bravo-missed-*` ids are ever touched; a live ring card is not a stale
 * miss. No criteria → no-op (never a mass sweep). Returns the cancel count.
 */
export async function dismissMissedCallNotifs(match: {fromUserId?: string; conversationId?: string}): Promise<number> {
  if (Platform.OS !== 'android') {return 0;}
  if (!match.fromUserId && !match.conversationId) {return 0;}
  let cancelled = 0;
  try {
    const displayed = await notifee.getDisplayedNotifications();
    for (const entry of displayed) {
      const id = entry.notification?.id;
      if (!id?.startsWith('bravo-missed-')) {continue;}
      const data = (entry.notification?.data ?? {}) as Record<string, string | undefined>;
      // Review round 1 (P2) — conversation identity WINS when both the banner
      // and the query carry one: a direct thread opened with Bob must not
      // retire a GROUP missed banner that merely names Bob as the ringer.
      // Only when either side lacks the conversation does the ringer decide.
      let hit: boolean;
      if (match.conversationId !== undefined && data.conversationId !== undefined) {
        hit = data.conversationId === match.conversationId;
      } else {
        hit =
          (match.fromUserId !== undefined && data.fromUserId !== undefined && data.fromUserId === match.fromUserId) ||
          (match.conversationId !== undefined && data.conversationId === match.conversationId);
      }
      if (!hit) {continue;}
      try {
        await notifee.cancelNotification(id);
        cancelled += 1;
      } catch (e) {
        console.warn('[missedCall] dismiss failed:', (e as Error).message);
      }
    }
  } catch (e) {
    console.warn('[missedCall] shade query failed:', (e as Error).message);
  }
  return cancelled;
}

/**
 * Display the incoming-call notification. On a LOCKED device, the
 * fullScreenAction launches MainActivity immediately, bypassing the
 * lock screen — that's the load-bearing piece for "phone rings on
 * lock screen" behavior. On an unlocked device, the user sees a
 * heads-up notification with Accept / Decline buttons.
 */
export async function showIncomingCallNotif(p: IncomingCallNotifPayload): Promise<void> {
  if (Platform.OS !== 'android') {return;} // iOS uses PushKit (separate path, not yet wired)
  await ensureIncomingCallChannel();

  const isVideo = p.kind === 'video' || p.kind === 'group-video';
  const isGroup = p.kind === 'group-voice' || p.kind === 'group-video';
  const titleVerb = isGroup ? 'Group call' : (isVideo ? 'Video call' : 'Voice call');
  const title = `${titleVerb} from ${p.callerName || 'Bravo contact'}`;

  // Stable per-call ids so dismiss can target the right notification
  // when answer / decline / hangup fires later.
  const notifId = `bravo-call-${p.callId}`;
  const acceptId  = `accept-${p.callId}`;
  const declineId = `decline-${p.callId}`;

  // Stash the entire payload as JSON in `data` so the tap handler
  // (notifee event handler) can navigate without re-querying state.
  const data: Record<string, string> = {
    callId:         p.callId,
    kind:           p.kind,
    callerName:     p.callerName,
    isGroup:        isGroup ? '1' : '0',
  };
  if (p.remoteUserId)    {data.remoteUserId    = p.remoteUserId;}
  if (p.remoteDeviceId !== null && p.remoteDeviceId !== undefined) {data.remoteDeviceId = String(p.remoteDeviceId);}
  if (p.incomingSdp)     {data.incomingSdp     = p.incomingSdp;}
  if (p.roomId)          {data.roomId          = p.roomId;}
  if (p.roomToken)       {data.roomToken       = p.roomToken;}
  if (p.conversationId)  {data.conversationId  = p.conversationId;}
  if (p.fromUserId)      {data.fromUserId      = p.fromUserId;}

  try {
    await notifee.displayNotification({
      id:    notifId,
      title,
      body:  isVideo ? 'Incoming video call · Tap to answer' : 'Incoming voice call · Tap to answer',
      data,
      android: {
        channelId:    CHANNEL_ID,
        // category: 'call' — Android Auto / Wear / DND treat this
        // notification as a real telephony call. Combined with
        // ongoing=true + fullScreenAction, Android pins this to the
        // very top of the shade and bypasses the lock screen on
        // arrival, which is what makes the WhatsApp/Signal "phone
        // rings on lock screen" UX work.
        category:     AndroidCategory.CALL,
        importance:   AndroidImportance.HIGH,
        visibility:   AndroidVisibility.PUBLIC,
        smallIcon:    'ic_stat_bravo',
        // The launcher icon doubles as the round caller avatar in the
        // notification card. When we have a real avatar URL pipe it
        // through the payload (future).
        largeIcon:    'ic_launcher',
        // colorized=true makes Android paint the entire notification
        // surface with the accent color — visually matches Bravo's
        // call screen and stands out vs ordinary push notifications.
        // B-232 — obsidian design-system cobalt (was legacy #1E88FF); every
        // other display site already uses NOTIF_ACCENT.
        color:        NOTIF_ACCENT,
        colorized:    true,
        ongoing:      true,
        autoCancel:   false,
        // No loopSound — the v2 channel is silent; looping is owned by
        // BravoRingtoneModule (device-default ringtone), started below.
        // Audit PUSH-B5 (2026-07-02): auto-dismiss the ring after 45s. On a
        // KILLED app the caller's hangup arrives only as a WS frame on the
        // next reconnect (which a killed app never processes), and the VoIP
        // FCM ttl bounds delivery, not the DISPLAYED notification — so a
        // missed call used to ring/loop until the user manually swiped it.
        // 45s matches the offer's 45s relay TTL.
        timeoutAfter: 45_000,
        // The full-screen intent is what fires the lock-screen wake-up.
        // 'default' means "use the notification's pressAction" — i.e.
        // launch MainActivity. The Android launchActivity field is
        // implicit when set to 'default' on the main app activity.
        fullScreenAction: {
          id:             'default',
          launchActivity: 'default',
        },
        pressAction: {
          id:             'default',
          launchActivity: 'default',
        },
        actions: [
          {
            // P1-BR-3 — NO launchActivity: notifee delivers ACTION_PRESS to the
            // (headless) bg handler, which sends the decline over HTTP without
            // cold-launching the app the user just rejected.
            title: '❌ Decline',
            pressAction: {id: declineId},
          },
          {
            title: isVideo ? '📹 Answer' : '☎️ Answer',
            pressAction: {id: acceptId, launchActivity: 'default'},
          },
        ],
        style: {
          type: AndroidStyle.BIGTEXT,
          text: isGroup
            ? `Group call from ${p.callerName || 'Bravo contact'}\nTap Answer to join the room`
            : `${isVideo ? 'Video' : 'Voice'} call from ${p.callerName || 'Bravo contact'}\nTap Answer to pick up`,
        },
        // Vibrate aggressively on display + every few seconds the OS
        // re-pings while the heads-up is visible.
        vibrationPattern: RING_NOTIF_VIBRATION,
      },
    });
    // Ring with the DEVICE-DEFAULT ringtone (WhatsApp parity). Started only
    // after the card displays so a failed display can't leave sound with no
    // visible call; natively auto-stops at RING_TIMEOUT_MS (= timeoutAfter
    // above) even if this JS context dies (killed-app headless wake).
    try {
      const {startIncomingRingtone} = require('./incomingRingtone') as typeof import('./incomingRingtone');
      startIncomingRingtone(p.callId);
    } catch (e) {
      console.warn('[bravo.callnotif] ringtone start failed:', (e as Error).message);
    }
  } catch (e) {
    console.warn('[bravo.callnotif] display failed:', (e as Error).message);
  }
  // WI-4.9 — a NEW ring from this caller supersedes their "Missed call"
  // banner: the reminder's job is done the moment they are ringing again.
  // This funnel covers the three CARD-drawing lanes (warm bg, headless, the
  // WI-4.10 foreground rescue); the WS lanes present in-app without a card
  // and retire the banner at their own navigate sites in MainNavigator.
  // AFTER the card + ringtone (review round 1 P2: this is a bridge
  // round-trip, and a Doze-budgeted wake must never pay it before ringing).
  // Passing the conversationId (when known) keeps a DIRECT ring from
  // retiring a GROUP missed banner that merely shares the ringer.
  if (p.fromUserId) {
    try { await dismissMissedCallNotifs({fromUserId: p.fromUserId, conversationId: p.conversationId}); }
    catch { /* shade query unavailable — the banner just stays */ }
  }
}

/**
 * SLIM notifee background-event handler, registered at BUNDLE ENTRY (index.js) so a KILLED app's
 * notification taps are handled. Without it, notifee logs "no background event handler has been
 * set" and a tapped call notification is NOT dismissed (the rich handler in fcmBootstrap that
 * dismisses + declines-over-WS is only registered AFTER login). This slim version just dismisses
 * the call notif on any tap/action so a looping ring can't linger; the body-tap still launches the
 * app via the notification's launchActivity, and once warm + logged-in fcmBootstrap's richer
 * onBackgroundEvent (full accept/decline-over-WS) takes over. notifee-only; safe headless.
 */
/**
 * P1-9 — after persisting a killed-app inline reply we re-post the SAME banner
 * WITHOUT the RemoteInput action so Android clears the hung reply spinner and
 * the user learns the send is deferred (notifee allows updating a notification
 * from the background handler). Content stays generic — no plaintext.
 */
async function markReplyQueued(conversationId: string): Promise<void> {
  if (Platform.OS !== 'android' || !conversationId) {return;}
  await ensureMessagesChannel();
  try {
    await notifee.displayNotification({
      id:    `bravo-msg-${conversationId}`,
      title: 'Bravo Secure',
      body:  'Reply will send when you open Bravo',
      data:  {kind: 'msg-wake', conversationId},
      android: {
        channelId:     MSG_CHANNEL_ID,
        importance:    AndroidImportance.HIGH,
        category:      AndroidCategory.MESSAGE,
        visibility:    AndroidVisibility.PRIVATE,
        smallIcon:     'ic_stat_bravo',
        color:         NOTIF_ACCENT, // B-66
        onlyAlertOnce: true, // silent update — just clears the RemoteInput spinner
        pressAction:   {id: 'default', launchActivity: 'default'},
      },
    });
  } catch (e) {
    console.warn('[messageNotif] reply-queued update failed:', (e as Error).message);
  }
}

let slimBgHandlerInstalled = false;
export function installSlimNotifeeBgHandler(): void {
  if (slimBgHandlerInstalled || Platform.OS !== 'android') {return;}
  slimBgHandlerInstalled = true;
  ensureNotifeeBgRegistration();
}

/**
 * WI-4.2 — notifee keeps a SINGLE background-event handler slot, and this
 * module now owns THE registration. It used to be registered twice: the slim
 * handler at bundle entry, then fcmBootstrap's rich handler post-login,
 * relying on notifee's last-write-wins — an undocumented displacement two
 * files apart, where any future registrar (or a boot re-ordering) silently
 * decided which behaviours existed for killed-app taps. Now registration
 * happens exactly once, and the RICH handler installs itself as a delegate:
 * before it arrives the slim behaviour serves (durable decline + dismiss);
 * after, every event routes to it. Never cleared on sign-out — the rich
 * handler guards its own auth-dependent lanes, matching the old behaviour
 * where its registration also outlived the session.
 */
type NotifeeBgEvent = Parameters<Parameters<typeof notifee.onBackgroundEvent>[0]>[0];
let richNotifeeBgDelegate: ((event: NotifeeBgEvent) => Promise<void>) | null = null;
export function setNotifeeBgHandlerDelegate(fn: (event: NotifeeBgEvent) => Promise<void>): void {
  richNotifeeBgDelegate = fn;
  // iOS never runs the slim install (Android-gated above), so the delegate
  // installer must also own making the registration exist.
  ensureNotifeeBgRegistration();
}

let notifeeBgRegistered = false;
function ensureNotifeeBgRegistration(): void {
  if (notifeeBgRegistered) {return;}
  notifeeBgRegistered = true;
  try {
    notifee.onBackgroundEvent(async (event) => {
      // B-710 — dismissal is observed BEFORE the delegate split, so it is handled
      // whichever handler is serving. A swiped-away banner used to leave its card
      // accumulator and its group-summary membership behind: the next message in
      // that thread re-rendered up to seven previously-dismissed previews onto
      // the lock screen, and the summary kept counting rows that were gone.
      noteMsgDismissal(event);
      const rich = richNotifeeBgDelegate;
      if (rich) {
        await rich(event);
        return;
      }
      await slimBgHandle(event);
    });
  } catch (e) {
    console.warn('[callNotification] slim bg handler register failed:', (e as Error).message);
  }
}

/**
 * B-710 — the ONE place a notifee dismissal reaches the message accumulators.
 * Shared by the background registration above and the foreground handler in
 * fcmBootstrap, both of which filter to PRESS/ACTION_PRESS for their own work.
 */
export function noteMsgDismissal(event: {type: number; detail?: {notification?: {id?: string}}}): void {
  if (event.type !== EventType.DISMISSED) {return;}
  noteMessageNotifDismissed(event.detail?.notification?.id);
}

/** The pre-login (slim) behaviour — see installSlimNotifeeBgHandler's doc. */
async function slimBgHandle({type, detail}: NotifeeBgEvent): Promise<void> {
  if (Platform.OS !== 'android') {return;}
  try {
      if (type !== EventType.PRESS && type !== EventType.ACTION_PRESS) {return;}
      const data    = (detail.notification?.data ?? {}) as Record<string, string | undefined>;
      const pressId = detail.pressAction?.id ?? '';

      // P1-9 — inline Reply / Mark-as-read pressed after the process died. The
      // runtime + WS aren't up in this slim headless context, so PERSIST to the
      // durable queue; fcmBootstrap drains it (outbox send + mark-read) once the
      // runtime is ready. Never boots the runtime here (the 2nd-VM contention we
      // removed) and never decrypts.
      if (data.kind === 'msg-wake') {
        const convId = data.conversationId || '';
        if (pressId.startsWith('reply-') && convId) {
          const input = (detail as unknown as {input?: string}).input;
          if (typeof input === 'string' && input.trim()) {
            try {
              const {enqueuePendingAction} = require('./pendingActions') as typeof import('./pendingActions');
              // B-361 — carry the banner's sender uid so the drain can 1:1-send
              // even before the conversation row hydrates.
              await enqueuePendingAction({t: 'reply', convId, text: input.trim(), peerUserId: data.senderUserId || undefined});
            } catch (e) { console.warn('[callNotification] reply enqueue failed:', (e as Error).message); }
            // B-363 — WhatsApp parity: dispatch NOW from the killed VM (boot
            // runtime + drain; the send ships over HTTP relay). The durable
            // enqueue above already happened, so a mid-dispatch process death
            // loses nothing. Only a failed/blocked dispatch shows the
            // "will send when you open Bravo" fallback banner.
            let sentNow = false;
            try {
              const {headlessDispatchNotifActions} = require('./fcmBootstrap') as typeof import('./fcmBootstrap');
              sentNow = await headlessDispatchNotifActions();
            } catch (e) { console.warn('[callNotification] headless reply dispatch failed:', (e as Error).message); }
            if (sentNow) {
              console.warn('[callNotification] killed-VM reply dispatched, convo=', convId.slice(0, 12));
              await dismissMessageNotif(convId);
            } else {
              await markReplyQueued(convId);
            }
          }
          return;
        }
        if (pressId.startsWith('read-') && convId) {
          try {
            const {enqueuePendingAction} = require('./pendingActions') as typeof import('./pendingActions');
            await enqueuePendingAction({t: 'read', convId});
          } catch (e) { console.warn('[callNotification] read enqueue failed:', (e as Error).message); }
          // B-363 — same killed-VM dispatch as Reply: the sender's blue tick
          // must not wait for the app to be opened.
          try {
            const {headlessDispatchNotifActions} = require('./fcmBootstrap') as typeof import('./fcmBootstrap');
            const ok = await headlessDispatchNotifActions();
            console.warn('[callNotification] killed-VM mark-as-read dispatch:', ok ? 'sent' : 'queued');
          } catch (e) { console.warn('[callNotification] headless read dispatch failed:', (e as Error).message); }
          await dismissMessageNotif(convId);
          return;
        }
        return; // body tap launches the app; the warm handler takes over
      }

      const callId = data.callId;
      if (!callId) {return;}

      // B-233 — a missed-call banner tap. Its notification id is
      // `bravo-missed-<id>`, NOT the ring's `bravo-call-<id>`, and it has no
      // live ring to decline. Cancel the correct id and never fall through to
      // the decline/dismissCallNotif path (which targets bravo-call-<id>).
      if (data.kind === 'missed-call') {
        try { await notifee.cancelNotification(`bravo-missed-${callId}`); }
        catch (e) { console.warn('[callNotification] missed dismiss failed:', (e as Error).message); }
        return;
      }

      // P1-BR-3 — headless Decline: tell the server to stop the caller ringing
      // WITHOUT cold-launching the app. On any failure, enqueue a durable
      // pending-decline flushed on first connect. Cancel the ring either way.
      if (pressId.startsWith('decline-')) {
        const isGroup = data.isGroup === '1' || (data.kind ?? '').startsWith('group-');
        const args = isGroup
          ? {callId, kind: 'group' as const, roomId: data.roomId || callId}
          : {callId, kind: 'direct' as const, peerUserId: data.fromUserId};
        try {
          const {sendCallDecline, enqueuePendingAction} = require('./pendingActions') as typeof import('./pendingActions');
          const ok = await sendCallDecline(args);
          if (!ok) { await enqueuePendingAction({t: 'decline', ...args}); }
        } catch (e) {
          console.warn('[callNotification] headless decline failed:', (e as Error).message);
          try {
            const {enqueuePendingAction} = require('./pendingActions') as typeof import('./pendingActions');
            await enqueuePendingAction({t: 'decline', ...args});
          } catch { /* durable enqueue is best-effort */ }
        }
      }
      await dismissCallNotif(callId);
  } catch (e) {
    console.warn('[callNotification] slim bg handle failed:', (e as Error).message);
  }
}

/**
 * Dismiss the active call notification, e.g. after answer / decline / hangup.
 * Single funnel for every ring-exit path (accept / decline / remote hangup /
 * killed-app slim tap handler) — so the ringtone stop lives HERE and cannot
 * be missed by a new exit path that forgets it.
 */
export async function dismissCallNotif(callId: string): Promise<void> {
  if (Platform.OS !== 'android') {return;}
  try {
    const {stopIncomingRingtone} = require('./incomingRingtone') as typeof import('./incomingRingtone');
    stopIncomingRingtone(callId, 'dismiss');
  } catch { /* ringtone module unavailable — native auto-stop still bounds it */ }
  try {
    await notifee.cancelNotification(`bravo-call-${callId}`);
  } catch (e) {
    console.warn('[callNotification] dismiss failed:', (e as Error).message);
  }
}

/**
 * FIX-14 — cancel any ring the OS is still showing for a call that is over.
 *
 * The 45s `timeoutAfter` on the notification, a cancel push, and a WS frame are
 * the only things that ever cleared a ring. None of them survives the case this
 * exists for: a ring drawn while the device was in Doze (or drawn moments
 * before the cancel landed) that outlives the process. Nothing anywhere called
 * `getDisplayedNotifications`, so on the next launch the user found a dead call
 * ringing at them — with the native looping ringtone still going, because that
 * survives JS VM death by design.
 *
 * Run on boot and on foreground. Judges a call dead by the SAME cross-lane
 * signals the ring handler uses, plus TTL expiry (a ring older than the ring
 * window cannot be live even if no tombstone was ever written — the process
 * that would have written it is gone).
 *
 * Routes every cancel through `dismissCallNotif`, never a bare
 * `cancelNotification`: the ringtone stop lives in that funnel, and a bare
 * cancel leaves the phone ringing with no notification to stop it.
 */
export async function sweepStaleCallNotifications(opts?: {
  /** Never touch a call the app is actually on. */
  isLive?: (callId: string) => boolean;
  /** Rings older than this are dead regardless of tombstones. */
  maxAgeMs?: number;
}): Promise<number> {
  if (Platform.OS !== 'android') {return 0;}
  const maxAgeMs = opts?.maxAgeMs ?? 60_000;
  let swept = 0;
  let agedMissed = 0;
  try {
    const displayed = await notifee.getDisplayedNotifications();
    const {isIncomingCallDead} = require('./incomingCallCache') as typeof import('./incomingCallCache');
    const {wasRecentlyEnded} = require('../runtime/callRegistry') as typeof import('../runtime/callRegistry');
    const now = Date.now();
    for (const entry of displayed) {
      const id = entry.notification?.id;
      // WI-4.9 — the sweep also AGES missed-call banners: one older than
      // MISSED_NOTIF_MAX_AGE_MS is clutter the user has demonstrably not
      // acted on (every acted-on path dismisses it explicitly). A banner
      // whose posted-date can't be read is left alone — fail open, never
      // destroy the user's only record of a miss on a parsing quirk.
      if (id?.startsWith('bravo-missed-')) {
        // Note for callers: missed banners ignore `isLive`/`maxAgeMs` on
        // purpose — those describe RING liveness; this lane has its own
        // fixed 24 h bound and its own counter.
        const rawMissedDate = (entry as {date?: number | string}).date;
        const parsedMissed = rawMissedDate === undefined || rawMissedDate === null ? NaN : Number(rawMissedDate);
        if (Number.isFinite(parsedMissed) && parsedMissed > 0 && now - parsedMissed > MISSED_NOTIF_MAX_AGE_MS) {
          try {
            await notifee.cancelNotification(id);
            agedMissed += 1;
          } catch (e) {
            console.warn('[missedCall] age-out cancel failed:', (e as Error).message);
          }
        }
        continue;
      }
      if (!id?.startsWith('bravo-call-')) {continue;}
      const callId = id.slice('bravo-call-'.length);
      if (!callId) {continue;}
      if (opts?.isLive?.(callId)) {continue;}
      // `date` is when the notification was posted (epoch ms) — but notifee's
      // Android native side stringifies it (putString(String.valueOf(...))),
      // so on device it arrives as a STRING and a `typeof === 'number'` check
      // silently killed this whole lane (the test fed a number and passed
      // vacuously — audit finding). Coerce; absent/garbage falls back to the
      // cross-lane death signals alone.
      const rawDate = (entry as {date?: number | string}).date;
      const parsedDate = rawDate === undefined || rawDate === null ? NaN : Number(rawDate);
      const postedAt = Number.isFinite(parsedDate) && parsedDate > 0 ? parsedDate : undefined;
      const tooOld = postedAt !== undefined && now - postedAt > maxAgeMs;
      if (!tooOld && !isIncomingCallDead(callId) && !wasRecentlyEnded(callId)) {continue;}
      await dismissCallNotif(callId);
      swept += 1;
    }
    if (swept > 0 || agedMissed > 0) {
      console.log(`[callNotification] swept ${swept} stale ring(s), aged out ${agedMissed} missed banner(s)`);
    }
  } catch (e) {
    console.warn('[callNotification] stale sweep failed:', (e as Error).message);
  }
  return swept;
}

/**
 * Parse an action press id back into an outcome + callId. Returns null
 * for the body-tap (id: 'default') which we treat as "open the app and
 * let the existing screens handle it."
 */
export function parseCallAction(pressActionId: string): {
  outcome: 'accept' | 'decline';
  callId:  string;
} | null {
  if (pressActionId.startsWith('accept-')) {
    return {outcome: 'accept',  callId: pressActionId.slice('accept-'.length)};
  }
  if (pressActionId.startsWith('decline-')) {
    return {outcome: 'decline', callId: pressActionId.slice('decline-'.length)};
  }
  return null;
}

/**
 * Re-export notifee's event types so callers don't have to import
 * notifee directly when wiring handlers in fcmBootstrap.
 */
export {EventType, notifee};
export type {Event};
