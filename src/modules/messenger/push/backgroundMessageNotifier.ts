/**
 * M-04 (audit 2026-07-06) — store-driven message banners for the WARM
 * background path.
 *
 * Sealed sender means a msg-wake FCM frame names only the sender, so a GROUP
 * message can never be resolved to its conversation from the push payload —
 * which broke per-conversation collapse, mute suppression, and tap routing
 * for groups. But on the warm path the messenger runtime DOES decrypt the
 * message into messengerStore. This module subscribes to the store and,
 * while the app is backgrounded/inactive, posts a conv-keyed notifee banner
 * for each NEW inbound message in a non-muted, non-active conversation —
 * giving groups correct collapse + mute + tap. The banner text stays generic
 * ('New message'); the title is the conversation's display name, which is
 * allowed because it is derived locally from the store, never from the wire.
 *
 * The killed-app path cannot run this (no runtime, no decrypt), so killed
 * group wakes stay generic sender-keyed banners — documented residual gap.
 *
 * Idempotent start; stopped (and its banners cleared) on sign-out via
 * stopFcmBootstrap.
 */
import {AppState, Platform} from 'react-native';
import type {NativeEventSubscription} from 'react-native';
// M2 — THE message topology rule. Dependency-free by design, so importing it
// here cannot pull the runtime into the push path.
import {isGroupConversation} from '../runtime/messagingLogic';
// M16 — post-COMMIT deferral for user-visible effects (see onStoreChange).
import {onAfterCommit} from '../runtime/receiveTransaction';
// B-710 — the card's own cap, so a batch is never built larger than it can hold.
import {MSG_CARD_CAP} from './msgNotifCardCap';
// ONE mention rule, shared with the composer and the bubble renderer.
import {mentionsUser} from '../runtime/mentionText';
// B-411 — ONE title rule, dependency-free (safe in this import graph):
// saved name plain, directory name tagged "· Unsaved", placeholder never.
import {resolveNotifTitle} from '../contacts/notifTitle';

type StoreModule = typeof import('../store/messengerStore');
type StoreState  = ReturnType<StoreModule['useMessengerStore']['getState']>;

let running = false;
let unsubStore: (() => void) | null = null;
let appStateSub: NativeEventSubscription | null = null;
// Headless-VM mode (killed-app drain, headlessDrain.ts): a headless JS
// context has no activity, so AppState can read 'unknown' — treating only
// 'background'/'inactive' as backgrounded would silently withhold every
// banner there. In headless mode anything that is not 'active' counts.
let headlessMode = false;
// B-356 — `AppState.currentState` LIES on one lane that matters here: a VM that
// FCM started headless reports a stale 'background' even while the user is
// looking at the screen (launched-from-notification), until the first 'change'
// event corrects it. ChatScreen already carries its own `observedAppStateRef`
// for exactly this. So "the app is backgrounded" is only trusted when we have
// OBSERVED the transition — the same rule, and the reason an ACTIVE thread does
// not start bannering the moment a boot-window read says 'background'.
let confirmedBackground = false;

// N-10/N-16 — message-content previews in notifications are a privacy choice.
// B-65 (tester 2026-07-10: "notification does not say what is going on — like
// Telegram"): default is now ON, matching Signal/WhatsApp/Telegram — the
// preview is locally decrypted, rendered with visibility PRIVATE (redacted on
// a secure lock screen), and never comes from the wire. Users can opt out via
// Messenger settings ('0'); a previous explicit opt-in ('1') still reads as on.
// Cached so the store subscriber (sync) can read it without an await per message.
const PREVIEW_PREF_KEY = 'bravo:notif-content-preview';
let contentPreviewEnabled = true;
async function loadPreviewPref(): Promise<void> {
  try {
    const AsyncStorage = (require('@react-native-async-storage/async-storage') as {default: {getItem(k: string): Promise<string | null>}}).default;
    contentPreviewEnabled = (await AsyncStorage.getItem(PREVIEW_PREF_KEY)) !== '0';
  } catch { contentPreviewEnabled = true; }
}
/** Settings toggle updates the live cache so the change takes effect at once. */
export function setContentPreviewEnabled(v: boolean): void { contentPreviewEnabled = v; }
/**
 * Message ids already observed per conversation — the "already seen" watermark
 * that separates live arrivals from boot hydration replay.
 *
 * M16 — this used to be a single TAIL id per conversation, which silently lost
 * every out-of-order arrival: `appendMessage` binary-splices a late row into
 * send order rather than pushing it, so a drained/stashed group message lands
 * MID-list and leaves the tail id unchanged. The watermark then matched, we
 * `continue`d, and the user got NO banner and NO badge at all — for exactly the
 * messages most likely to need one (they arrived late because the device was
 * offline). Tracking the id SET instead detects a new row wherever it lands.
 *
 * Bounded to the most recent ids per conversation so a long-lived process does
 * not accumulate every id ever seen; Set iteration is insertion-ordered, so
 * trimming from the front drops the oldest.
 */
const seenIdsByConvo = new Map<string, Set<string>>();
const SEEN_IDS_PER_CONVO = 200;

function rememberSeen(cid: string, ids: string[]): void {
  let seen = seenIdsByConvo.get(cid);
  if (!seen) {seen = new Set(); seenIdsByConvo.set(cid, seen);}
  for (const id of ids) {seen.add(id);}
  if (seen.size > SEEN_IDS_PER_CONVO) {
    const excess = seen.size - SEEN_IDS_PER_CONVO;
    let dropped = 0;
    for (const id of seen) {
      if (dropped >= excess) {break;}
      seen.delete(id);
      dropped++;
    }
  }
}
// Conversations with a banner posted by THIS module (so foreground/read
// cleanup only cancels what we own).
const postedConvos = new Set<string>();

function isBackgrounded(): boolean {
  const s = AppState.currentState;
  if (headlessMode) {return s !== 'active';}
  return s === 'background' || s === 'inactive';
}

/** N-29/N-11 — lets the FCM background handler skip its own (generic /
 *  mis-keyed) banner when this store-driven notifier is alive to draw the
 *  correct conv-keyed one, avoiding a double banner for the same message. */
export function isBackgroundMessageNotifierRunning(): boolean {
  return running;
}

// P2-6 — monotonic count of user-visible cues this notifier has produced
// (notifee banners AND, since B-692 S-3, in-app banner/tone events — critic
// F1: an in-app cue must satisfy the fallback check or the warm lane stacks a
// notifee ding on top of it when the user foregrounds mid-pull). The FCM
// warm-background handler skips its own banner when the notifier is running,
// then pulls; it snapshots this before the pull and, if it hasn't advanced
// afterwards (Doze pull failed), posts a fallback so a real message can never
// produce ZERO signal. Incremented synchronously at the top of post() / the
// foreground onAfterCommit callbacks so it reflects the store-subscriber's
// decision by the time the pull promise resolves.
let messagePostedGeneration = 0;
export function getMessagePostedGeneration(): number { return messagePostedGeneration; }

// B-703 MR-19 — the generation says a cue was ATTEMPTED, never that one landed.
// It is bumped synchronously (above) because the FCM lanes read it right after
// their own awaits and a bump that slid below the notifee round-trip would make
// them double-banner; the price is that a display which throws — or an in-app
// layer that isn't mounted — still reads as "a banner exists", and the fallback
// that is supposed to guarantee a real message is never fully silent gets
// suppressed for exactly the message that produced nothing.
//
// So failures are counted too, and the pair is read through `cueDeliveredSince`
// below: attempted-and-not-failed. Counters are monotonic; a consumer compares
// its own snapshot, never an absolute value.
//
// Failures are counted PER CONVERSATION as well as globally. A single global
// count made one thread's miss answer another thread's question, and the cost
// of that wrong answer is not "an extra banner": the fallback is keyed to the
// wake's conversation, so it REPLACES that thread's rich card with the generic
// line, and its `wakeFallback` flag arms the 10 s GLOBAL alert-collapse window.
let messageCueFailures = 0;
const cueFailuresByConvo = new Map<string, number>();
const CUE_FAILURE_CONVOS_MAX = 200;

// B-703 MR-10 — ONE CUE, ONE WAKE: a claim ledger, not a time window.
//
// The server fires the FCM wake without consulting whether live WS delivery
// succeeded, so for every HTTP-path send (all group fan-out) a backgrounded-
// but-connected recipient ingests over the socket and banners FIRST, and the
// wake handler arrives afterwards. A snapshot taken at handler entry cannot see
// that cue — it already happened — so the handler concludes "nothing drew" and
// posts a second, generic banner for a message the user has already been told
// about.
//
// The first cut answered this with a recency window ("was anything cued in the
// last N seconds?") and that was WRONG in the dangerous direction: a window
// wide enough to cover push latency also reaches back past an EARLIER message's
// cue, so the second message of a burst — whose own wake exists precisely
// because the server debounced it — was suppressed on the strength of the
// first message's banner. It silenced real messages.
//
// A token ledger cannot make that mistake. Each delivered cue mints one token
// for its sender; each wake for that sender may claim at most one. Two
// messages, two cues, two wakes: each wake claims its own. Two messages, ONE
// cue (the second's pull failed): the second wake finds nothing to claim and
// draws its fallback — which is exactly the guarantee this lane exists for. No
// clocks are compared: the wake's `sentAtMs` is the SERVER's clock and a cue
// time is the DEVICE's, so any inequality between them is unsound.
//
// Sender-keyed because that is the only attribution a sealed-sender wake has
// (the server does not put a conversationId on a chat wake). A sender who is in
// two of the user's threads can therefore have one thread's token claimed by
// the other's wake — bounded, same-sender only, and far tighter than "any cue".
const cueTokensBySender = new Map<string, number[]>();
const CUE_TOKEN_TTL_MS = 60_000;
const CUE_TOKENS_PER_SENDER_MAX = 8;
const CUE_TOKEN_SENDERS_MAX = 200;

function noteCueDelivered(conversationId: string, senderUserId?: string): void {
  void conversationId;
  if (!senderUserId) {return;}
  const list = cueTokensBySender.get(senderUserId) ?? [];
  list.push(Date.now());
  while (list.length > CUE_TOKENS_PER_SENDER_MAX) {list.shift();}
  cueTokensBySender.set(senderUserId, list);
  if (cueTokensBySender.size > CUE_TOKEN_SENDERS_MAX) {
    const oldest = cueTokensBySender.keys().next();
    if (!oldest.done) {cueTokensBySender.delete(oldest.value);}
  }
}

/** Consume one token if this sender has an unclaimed, unexpired cue. */
function claimCueToken(senderUserId: string | undefined): boolean {
  if (!senderUserId) {return false;}
  const list = cueTokensBySender.get(senderUserId);
  if (!list) {return false;}
  const now = Date.now();
  // A token from minutes ago is not evidence about the message that just
  // arrived. Both sides of this comparison are the device's own clock.
  while (list.length > 0 && now - list[0] > CUE_TOKEN_TTL_MS) {list.shift();}
  const claimed = list.length > 0;
  if (claimed) {list.shift();}
  if (list.length === 0) {cueTokensBySender.delete(senderUserId);}
  return claimed;
}

function noteCueFailure(conversationId: string): void {
  messageCueFailures++;
  cueFailuresByConvo.set(conversationId, (cueFailuresByConvo.get(conversationId) ?? 0) + 1);
  if (cueFailuresByConvo.size > CUE_FAILURE_CONVOS_MAX) {
    // Insertion-ordered: drop the oldest tracked conversation.
    const oldest = cueFailuresByConvo.keys().next();
    if (!oldest.done) {cueFailuresByConvo.delete(oldest.value);}
  }
}

// In-flight notifee draws. A consumer that resumes between the bump and the
// native round-trip would read the failure count too early and suppress its
// fallback anyway, so `cueDeliveredSince` waits (bounded) for the verdict.
const pendingCues = new Set<Promise<unknown>>();
// Critic F8 — this must be long enough for a SLOW draw to report its FAILURE:
// cut it too fine and a display that takes longer than the budget to be refused
// reads as delivered, and the fallback stays away from a message that got
// nothing. The killed lane is the one with a hard Doze deadline, and it passes
// its own much smaller budget explicitly rather than shrinking this default.
const PENDING_CUE_BUDGET_MS = 1_200;

async function awaitPendingCues(budgetMs: number): Promise<void> {
  if (pendingCues.size === 0 || budgetMs <= 0) {return;}
  const waited = Array.from(pendingCues);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    Promise.allSettled(waited).then(() => false),
    new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(true), budgetMs); }),
  ]);
  if (timer) {clearTimeout(timer);}
  // A draw that NEVER settles — a wedged notifee binder, precisely the class
  // this wait exists for — is only removed by `post()`'s finally, which never
  // runs. Left in the set it would make every later wake on this process pay
  // the whole budget, and on the killed lane that budget is spent on top of
  // the 8 s drain race, inside a Doze window of about ten seconds.
  if (timedOut) { for (const p of waited) {pendingCues.delete(p);} }
}

export interface CueSnapshot {
  gen: number;
  failures: number;
  /** The conversation the caller will draw a fallback FOR, when it knows one. */
  conversationId?: string;
  convFailures: number;
}

/** Taken BEFORE the work that might produce a cue — see cueDeliveredSince. */
export function snapshotCues(conversationId?: string): CueSnapshot {
  return {
    gen: messagePostedGeneration,
    failures: messageCueFailures,
    conversationId,
    convFailures: conversationId ? (cueFailuresByConvo.get(conversationId) ?? 0) : 0,
  };
}

/**
 * "Did the user actually get a cue since `before`?" — the question the FCM
 * wake lanes have to answer before drawing their own generic fallback.
 *
 * A cue counts only if one was attempted AND the conversation this caller is
 * about to draw for did not have a draw fail in the same window. A sealed-
 * sender wake that names no conversation cannot scope the question and falls
 * back to the process-wide count.
 */
export async function cueDeliveredSince(
  before: CueSnapshot,
  opts?: {budgetMs?: number; senderUserId?: string},
): Promise<boolean> {
  await awaitPendingCues(opts?.budgetMs ?? PENDING_CUE_BUDGET_MS);

  // A miss in THIS conversation vetoes everything below: a message that got
  // nothing needs the fallback, whatever else was cued.
  const failuresNow = before.conversationId
    ? (cueFailuresByConvo.get(before.conversationId) ?? 0)
    : messageCueFailures;
  const failuresBefore = before.conversationId ? before.convFailures : before.failures;
  if (failuresNow !== failuresBefore) {return false;}

  // A cue drawn inside the caller's own window. Claim its token as well, so a
  // LATER wake cannot spend the same cue a second time.
  if (messagePostedGeneration !== before.gen) {
    claimCueToken(opts?.senderUserId);
    return true;
  }

  // Nothing drew inside the window — but the live WS lane may have bannered
  // this very message BEFORE the caller started. Wake-after-banner is the
  // NORMAL case for an HTTP-path send, not an edge. One token, one wake.
  return claimCueToken(opts?.senderUserId);
}

/** Test seam — the witness is module state that outlives a single suite. */
export function _resetCueWitnessForTests(): void {
  messageCueFailures = 0;
  cueFailuresByConvo.clear();
  cueTokensBySender.clear();
  pendingCues.clear();
}

// N-10 — a short, locally-derived preview. Content is E2EE but on the WARM
// path it is already decrypted into the live store, so a lock-screen-redacted
// (visibility PRIVATE) preview is safe — Android hides it on a secure lock
// screen and shows it once unlocked, matching Signal/Telegram default UX.
function previewForNotif(msg: {type?: string; content?: string}): string | undefined {
  if (msg.type === 'image') {return '📷 Photo';}
  if (msg.type === 'file')  {return '📎 Attachment';}
  if (msg.type === 'audio') {return '🎤 Voice message';}
  if (msg.type === 'video') {return '📹 Video';}
  const s = (msg.content ?? '').replace(/\s+/g, ' ').trim();
  if (!s) {return undefined;}
  return s.length > 140 ? s.slice(0, 137) + '…' : s;
}

// B-327 — same lazy-require latch UserAvatar uses (B-261): `directoryNames`
// reaches `@utils/constants` → `expo/virtual/env`, which the node Jest project
// does not transform (B-153), so it must never sit in this module's import
// graph. A photo miss queues the same debounced backfill the in-app avatars
// use, so the NEXT banner in the thread has the face.
type DirectoryModule = typeof import('../contacts/directoryNames');
let directoryModule: DirectoryModule | null | undefined;
function backfillSenderProfile(userId: string): void {
  if (directoryModule === undefined) {
    try {
      directoryModule = require('../contacts/directoryNames') as DirectoryModule;
    } catch { directoryModule = null; }
  }
  directoryModule?.ensureDirectoryNames([userId]);
}

interface PostOpts {
  title?: string; body?: string; senderName?: string; senderIconUrl?: string;
  badgeCount?: number; sentAtMs?: number; messageId?: string; senderUserId?: string;
  /** B-710 — rows that arrived in the same commit, ahead of this one. */
  preceding?: Array<{messageId?: string; body: string; senderName?: string; senderIconUrl?: string; sentAtMs?: number; senderUserId?: string}>;
}

async function post(
  conversationId: string,
  opts: PostOpts,
): Promise<void> {
  messagePostedGeneration++; // P2-6 — bump synchronously so the pull caller can detect "a banner was drawn"
  // B-703 MR-19 — the draw is registered so a wake lane can wait for its
  // verdict; the bump above stays synchronous (see the counter's own note).
  const draw = drawBanner(conversationId, opts);
  pendingCues.add(draw);
  try { await draw; } finally { pendingCues.delete(draw); }
}

async function drawBanner(
  conversationId: string,
  opts: PostOpts,
): Promise<void> {
  try {
    const {showMessageNotif} = require('./callNotification') as typeof import('./callNotification');
    postedConvos.add(conversationId);
    const drawn = await showMessageNotif({
      conversationId,
      title: opts.title,
      body: opts.body,
      senderName: opts.senderName,
      senderIconUrl: opts.senderIconUrl, // B-327 — the in-app directory photo
      badgeCount: opts.badgeCount,
      sentAtMs: opts.sentAtMs, // B-323 — the row's real send time, not draw time
      messageId: opts.messageId, // B-692 NL-2 — a row alerts at most once, ever
      // B-710 — the join key for the wake-collapse window and for retiring the
      // sender-keyed generic banner this card supersedes. Without it the alert
      // model can only fall back to a process-wide window, which silenced every
      // OTHER conversation for 10 s after any wake.
      senderUserId: opts.senderUserId,
      preceding: opts.preceding,
      actions: true, // N-10 — runtime is alive on this path: Reply + Mark-read work
    });
    // B-703 MR-19 — notifee swallows its own display error, so an unthrown
    // `false` is the ONLY signal that the shade got nothing. The conversation
    // stays in `postedConvos`: a failed draw does not prove an EARLIER banner
    // for the same thread is gone, and dropping it there would strand that one
    // past a retraction.
    if (drawn) {
      // Critic D11 — ONE token per MESSAGE, not per draw. Batching several rows
      // into a single card used to mint a single token while the server still
      // fired a wake per message, so wakes 2..N concluded "nothing drew for me"
      // and posted generic fallbacks for rows already rendered in the card — an
      // extra shade row and a second sound. The ledger counts rows.
      noteCueDelivered(conversationId, opts.senderUserId);
      for (const m of opts.preceding ?? []) {noteCueDelivered(conversationId, m.senderUserId);}
    } else {noteCueFailure(conversationId);}
  } catch (e) {
    noteCueFailure(conversationId);
    // Defensive String(): a nullish rejection would make this catch itself
    // throw, and `post()` is called as `void post(...)` — an unhandled
    // rejection where the old inline try/catch could never produce one.
    console.warn('[bgMsgNotifier] post failed:', String((e as Error)?.message ?? e));
  }
}

async function dismiss(conversationId: string, memberUserIds?: string[]): Promise<void> {
  postedConvos.delete(conversationId);
  try {
    const {dismissMessageNotif} = require('./callNotification') as typeof import('./callNotification');
    // P3 — pass member ids so a killed-app GROUP banner (keyed by its sender,
    // since the group was unresolvable headless) is cleared on read too.
    await dismissMessageNotif(conversationId, memberUserIds);
  } catch (e) {
    console.warn('[bgMsgNotifier] dismiss failed:', (e as Error).message);
  }
}

async function cancelAllPosted(): Promise<void> {
  for (const cid of Array.from(postedConvos)) {
    await dismiss(cid);
  }
  await dismissStrandedPlaceholder();
}

/**
 * B-703 MR-17 — retire the killed-lane "Checking for new messages…" row.
 *
 * That placeholder is drawn by `fcmHeadless` and cancelled ONLY inside the same
 * handler, so a VM Android freezes mid-drain strands it in the shade: nothing in
 * a full app boot or a foreground ever cancels it, and it survives until the
 * NEXT wake happens to repost the same fixed id. A permanent "Checking for new
 * messages…" is a worse lie than no row at all — the app is open and there is
 * nothing left to check.
 */
async function dismissStrandedPlaceholder(): Promise<void> {
  try {
    const {dismissPendingWakeNotif} = require('./callNotification') as typeof import('./callNotification');
    await dismissPendingWakeNotif();
  } catch { /* chrome — never load-bearing */ }
}

function onStoreChange(state: StoreState, prev: StoreState): void {
  // Opening a thread clears its banner immediately (read == activation). P3 —
  // run this even when WE didn't post the banner, so a killed-path sender-keyed
  // GROUP banner is cleared on read; pass the conversation's members so those
  // sender-keyed ids are cancelled.
  const active = state.activeConversationId;
  if (active && active !== prev.activeConversationId) {
    const conv = state.conversations[active];
    const memberIds: string[] = [];
    if (conv?.peer?.userId) {memberIds.push(conv.peer.userId);}
    for (const p of conv?.participants ?? []) { if (p) {memberIds.push(p);} }
    void dismiss(active, memberIds);
  }
  if (state.messages === prev.messages) {return;}
  // B-712 — is THIS commit bulk replay from the store's own loader? The counter
  // is bumped inside `hydrateMessages`' immer producer, so it differs on exactly
  // the commit that carried disk/backup rows and on no other. Computed once, per
  // commit, before the loop: it is a property of the commit, not of any one
  // conversation.
  //
  // This is the signal the reverted B-710 "hydration hold" should have been. The
  // hold was a TIME WINDOW, so a live message committed inside it was swallowed
  // whole; a per-commit mark cannot do that, because zustand `set` is synchronous
  // and a live append is always a different commit with an unchanged counter.
  const isHydrationCommit = state.hydrationGeneration !== prev.hydrationGeneration;
  for (const [cid, list] of Object.entries(state.messages)) {
    if (list === prev.messages[cid]) {continue;}
    // B-703 MR-8 — the destruction check runs BEFORE the empty-list bail. The
    // case that matters most is a conversation whose ONLY message just burned:
    // its list is now empty, and bailing first is precisely what left that
    // message's decrypted preview sitting on the lock screen.
    if (postedConvos.has(cid)) {
      const gone = prev.messages[cid];
      if (gone && list.length < gone.length) {
        const live = new Set(list.map(m => m.id));
        if (gone.some(m => !m.deleted_for_all && !live.has(m.id))) {void dismiss(cid);}
      }
    }
    if (list.length === 0) {continue;}
    // A banner already on the lock screen keeps rendering its preview after the
    // author retracts the message — the notification shade is the one surface
    // the store cannot repaint. Dismiss the conversation's banner when a row in
    // it newly becomes a tombstone.
    //
    // Banners are conversation-COLLAPSED, so this can also clear a sibling
    // message's banner. That is the correct direction to fail in: the unread
    // badge and the chat list still show there is something to read, whereas
    // leaving retracted plaintext on a lock screen is exactly what
    // delete-for-everyone exists to prevent.
    if (postedConvos.has(cid)) {
      const before = prev.messages[cid];
      const wasLive = new Set(
        (before ?? []).filter(m => !m.deleted_for_all).map(m => m.id),
      );
      if (list.some(m => m.deleted_for_all && wasLive.has(m.id))) {
        void dismiss(cid);
      }
    }
    const seen = seenIdsByConvo.get(cid);
    const firstSight = seen === undefined;
    // M16 — look for a new id ANYWHERE in the list, not just at the tail: a
    // late-drained message is spliced into send order and leaves the tail alone.
    // B-698 — SYSTEM rows (membership/rename/photo event lines) are thread
    // furniture, not arrivals: they must never banner, ding, or notifee. The
    // founder's screenshot showed "Member 7f8f75 added Member bc9bc9" bannered
    // on every app open — a boot-lane re-mint of a deterministic-id event row
    // landing pre-hydration (single-row conversation, so the >1 hydration
    // guard below can't catch it) with a raw-userId sender_id that also
    // passes the 'self' filter and rings the tone for the user's OWN actions.
    // Watermark them (rememberSeen below takes ALL ids), just never alert.
    const fresh = list.filter(m => !seen?.has(m.id) && m.type !== 'system');
    rememberSeen(cid, list.map(m => m.id)); // advance the watermark first, always
    // B-710 — a "hydration hold" (suppress every draw between a headless start
    // and the runtime being ready) lived here and was REMOVED after adversarial
    // review. Recorded so it is not re-derived:
    //   * `getMessengerRuntime` fires `void transport.connect()` UN-AWAITED, and
    //     the gateway flushes every pending envelope the moment the socket
    //     authenticates. So the wake's OWN message can be committed inside the
    //     hold — watermarked by `rememberSeen` above, suppressed here, and then
    //     invisible to `pullEnvelopes`, which reports 'drained' and makes
    //     `fcmHeadless` skip its fallback too. Zero notification for a real
    //     message: a WORSE bug than the stale re-banner it was closing.
    //   * The hold could also STICK ON. `armBackgroundMessageNotifier` has one
    //     caller, after the awaited runtime build; if that build rejects, the
    //     cached promise re-rejects for the process lifetime and a user opening
    //     the app on a degraded session never reaches the warm promotion either.
    //     Total silence with the app on screen — the F2 symptom, in a new guise.
    // The residual defect it was aimed at (a ONE-ROW conversation re-bannering
    // its old message on a killed-VM boot, because the length guard below needs
    // MORE THAN ONE row) was logged as B-712 and is now CLOSED — by the store
    // signal that note called for, not by a time window. See `isHydrationCommit`
    // at the top of this function.
    // B-712 — bulk replay is watermarked (rememberSeen above ran) and never
    // bannered, whatever its row count. This is what closes the one-row hole: the
    // length heuristic below needs MORE THAN ONE row, so a thread whose only
    // message is old walked straight through it and re-bannered — with sound,
    // because a fresh VM's once-ever alert ledger is empty — on every wake.
    //
    // Kept SEPARATE from the length guard rather than replacing it: that guard
    // also covers bulk materialisation this counter cannot see, and several
    // suites pin its behaviour. Two narrow conditions are cheaper to reason about
    // than one widened one.
    if (isHydrationCommit) {continue;}
    // Why: a conversation materializing with MANY rows at once is SQLCipher
    // boot hydration, not a live arrival — replaying it as banners would
    // spray stale notifications after a background boot.
    if (firstSight && !(cid in prev.messages) && list.length > 1) {continue;}
    if (fresh.length === 0) {continue;}
    // B-710 — the batch, in send order, not just its newest row.
    //
    // Two defects lived in the old one-liner. (1) It bannered ONLY the newest
    // fresh row, so when a drain committed several messages at once — the
    // offline catch-up, exactly the "10 messages while I was away" case — the
    // ones in between never reached the card at all, and `rememberSeen` had
    // already watermarked them so nothing could ever show them. (2) It picked
    // the newest row BEFORE the self-send filter, so an outbound row landing in
    // the same commit as an inbound one (an outbox drain, a send from another
    // device) made the whole conversation `continue` — silently burning the
    // inbound messages with it.
    const freshInbound = fresh
      .filter(m => m.sender_id && m.sender_id !== 'self')
      .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
    if (freshInbound.length === 0) {continue;}
    const tail = freshInbound[freshInbound.length - 1];
    // B-692 S-3 — foreground no longer bails to silence: it routes to the
    // in-app layer (banner + receive tone) instead of notifee. Headless keeps
    // the old bail — a headless VM reading 'active' has no UI to draw on.
    // Critic F5 — ONLY 'active' is foreground UI: the boot-window 'unknown'
    // state has no guarantee the banner host is mounted, so it keeps the old
    // silent bail rather than playing a tone at nobody.
    const foregroundUi = !headlessMode && AppState.currentState === 'active';
    if (!foregroundUi && !isBackgrounded()) {continue;}
    if (state.conversations[cid]?.is_muted) {continue;} // M-04 — muted stays silent on every lane
    // B-703 MR-11 — an "active" thread suppresses its banner ONLY while the app
    // is actually on screen. Backgrounded, the user is not reading it, and the
    // old unconditional `continue` here silenced it outright — no notifee, no
    // tone, no unread — for the thread they are most engaged with (the founder's
    // "press Home from inside a chat" case). The screens now release the id on
    // background (`useActiveConversation`); this is the consumer-side half of
    // the same invariant, so a race, a headless VM, or a future surface that
    // does not use the hook cannot bring the silence back.
    // B-356 (critic F3) — ...and "not foreground" is only believed once a
    // background transition has been OBSERVED. Otherwise the boot window of a
    // notification-launched VM, whose currentState still reads 'background'
    // while the user reads the thread, would shade-banner and ding the chat
    // that is on screen. Headless VMs have no active thread to begin with.
    if (cid === active && (foregroundUi || !confirmedBackground)) {
      // A message landing in the OPEN thread: subtle in-chat tone only —
      // the message bubble itself is the visual. Still after COMMIT (M16).
      // The unconfirmed-background arm keeps the ORIGINAL silent bail (no UI
      // to route to, and the state may be lying either way); only a genuine
      // foreground gets the in-app cue.
      if (!foregroundUi) {continue;}
      const activeIsGroup = isGroupConversation(state, cid);
      onAfterCommit(() => {
        // Critic F1 — the in-app cue COUNTS as "the notifier drew": without
        // this bump, the P2-6 warm fallback sees an unchanged generation
        // after its pull and stacks a notifee ding on top of the in-app
        // tone when the user foregrounds mid-pull.
        messagePostedGeneration++;
        try {
          const {notifyForegroundMessage} = require('./inAppMessageNotifier') as typeof import('./inAppMessageNotifier');
          // B-703 MR-19 — the RETURN, not the absence of a throw: every side
          // effect in that module is individually swallowed, so it cannot throw
          // and a `catch` here would never fire.
          if (notifyForegroundMessage({conversationId: cid, isGroup: activeIsGroup, inActiveThread: true})) {
            noteCueDelivered(cid, tail.sender_id);
          } else {
            noteCueFailure(cid);
          }
        } catch { noteCueFailure(cid); }
      });
      continue;
    }
    // N-10 — Telegram-style preview + sender name (groups), all locally
    // derived. N-17 — badge = total unread across conversations.
    const conv = state.conversations[cid];
    // M2 — ask the ONE topology rule rather than re-deriving it. The inline
    // copy missed a group whose key material had arrived but whose
    // /conversations/mine row had not, so those banners fell through to the
    // direct branch and showed the wrong sender name.
    const isGroupConv = isGroupConversation(state, cid);
    const directPeer = !isGroupConv ? conv?.peer?.userId : undefined;
    // B-411 (supersedes the B-226 inline placeholder guard) — 1:1 titles and
    // person names go through the ONE title rule: address-book/custom names
    // plain, directory names tagged "· Unsaved", the 'Bravo · <hex>'
    // placeholder mapped to directory/phone/generic — never rendered. Groups
    // keep their conversation name as the title (the tag is a 1:1 concept).
    const resolvedTitle = isGroupConv
      ? undefined
      : resolveNotifTitle({
          name:           conv?.name,
          name_source:    conv?.name_source,
          is_custom_name: conv?.is_custom_name,
          phoneE164:      conv?.phoneE164,
          peerUserId:     directPeer,
          directoryName:  directPeer ? state.directoryNames?.[directPeer] : undefined,
        });
    // B-226 — a group banner's sender name falls back to the session
    // directory (populated from /conversations/mine, B-224) so it shows a name
    // instead of nothing/a code when no manual override exists.
    const senderName = isGroupConv
      ? (state.groupMemberNames?.[cid]?.[tail.sender_id] ?? state.directoryNames?.[tail.sender_id] ?? undefined)
      : resolvedTitle?.displayName;
    const bannerTitle = isGroupConv ? conv?.name : resolvedTitle?.title;
    // Preview text only when the user opted in (default off → name-only banner,
    // no plaintext in the notification).
    const body = contentPreviewEnabled
      ? previewForNotif(tail as {type?: string; content?: string})
      : undefined;
    // "X mentioned you" — the one signal worth surfacing above a generic group
    // banner, because it is the reason a user opens a busy channel at all.
    //
    // The AUTH uuid, not `_ownUserId` (which is `email ?? phone ?? id`): for any
    // account with an email the latter never equals a participants entry, so the
    // check would be structurally false. Same root cause as the missing group
    // blue tick (B-116) and the mention roster in ChatScreen.
    //
    // DELIBERATELY does NOT override mute. `is_muted` is checked above and stays
    // authoritative: this codebase treats mute as a hard contract (M-04 for
    // banners, BS-MUTE-UNREAD for badges), and a "mentions pierce mute" rule is
    // a product decision with its own setting, not something to infer here.
    const ownUid = state._ownAuthUserId ?? state._ownUserId;
    // B-710 — the rows that arrived in this same commit BEFORE the newest one.
    // They join the conversation card silently; the newest row still owns the
    // title, the tone and the alert budget. Capped to what the card can hold, so
    // a 200-message catch-up costs one draw, not two hundred.
    const nameForSender = (uid: string): string | undefined => (isGroupConv
      ? (state.groupMemberNames?.[cid]?.[uid] ?? state.directoryNames?.[uid] ?? undefined)
      : resolvedTitle?.displayName);
    type PrecedingRow = {messageId?: string; body: string; senderName?: string; senderIconUrl?: string; sentAtMs?: number; senderUserId?: string};
    // Critic D10 raised the cost of building this on the FOREGROUND lane. It is
    // built once, below the cheap early-`continue`s, and BOTH lanes consume it:
    // the notifee card takes the rows, and the in-app banner takes the promotion
    // (a newest row with no preview would otherwise leave both with no text at
    // all). The bound is `MSG_CARD_CAP - 1` previews, not the whole commit.
    const buildPreceding = (): PrecedingRow[] => (contentPreviewEnabled
      ? freshInbound.slice(0, -1).slice(-(MSG_CARD_CAP - 1)).flatMap(m => {
          const preview = previewForNotif(m as {type?: string; content?: string});
          if (!preview) {return [];} // a row with no renderable preview adds nothing
          const at = Date.parse(m.created_at);
          const rowName = isGroupConv ? nameForSender(m.sender_id) : nameForSender(m.sender_id);
          // Critic D11 — a name MISS must self-heal like the tail's does, or a
          // batch row is stuck rendering as 'Member' (the B-328 class).
          if (isGroupConv && !rowName) {backfillSenderProfile(m.sender_id);}
          return [{
            messageId: m.id,
            body: preview,
            senderUserId: m.sender_id,
            senderName: isGroupConv ? (rowName ?? 'Member') : rowName,
            senderIconUrl: state.directoryAvatars?.[m.sender_id] ?? undefined,
            sentAtMs: Number.isFinite(at) ? at : undefined,
          }];
        })
      : []);
    const mentionsMe = isGroupConv && mentionsUser(tail.mentions, ownUid);
    const prefix = mentionsMe
      ? (senderName ? `${senderName} mentioned you` : 'You were mentioned')
      : undefined;
    // M16 — Zustand notifies SYNCHRONOUSLY from inside the immer producer, and
    // the inbound append runs inside BEGIN IMMEDIATE. Posting here would fire
    // the banner while the row is still uncommitted, and a ROLLBACK would then
    // remove the message but leave the notification (and its badge) behind.
    // Defer the visible part to after COMMIT; outside a txn this runs inline,
    // so the foreground/self-send paths are unaffected.
    // B-323 — the row's authenticated send time (sealed aad.ts → created_at).
    // A drain-delayed banner must read when the message was SENT, not drawn.
    const sentAtMs = Date.parse(tail.created_at);
    // B-327 — the sender's directory photo (the same source UserAvatar renders
    // in-app). A miss (photo OR name) queues the standard debounced backfill —
    // one fetch fills both maps — so the thread's next banner upgrades.
    const senderIconUrl = state.directoryAvatars?.[tail.sender_id] ?? undefined;
    if (!senderIconUrl || (isGroupConv && !senderName)) {backfillSenderProfile(tail.sender_id);}
    // B-328 — a group sender with NO resolvable name must NOT fall back to the
    // conversation title (showMessageNotif's `senderName || title` chain would
    // model the GROUP as the author — "who sent the msg is showing fault").
    // A neutral label is honest until the backfill lands; 1:1 keeps undefined
    // (there the title IS the sender, so the fallback is correct).
    const displaySenderName = isGroupConv ? (senderName ?? 'Member') : senderName;
    // With previews off there is no body at all, so the mention signal has
    // to become one — otherwise being mentioned is indistinguishable from
    // any other message in the channel. It names no content, so it does not
    // reintroduce the plaintext the preview setting exists to withhold.
    const preceding = buildPreceding();
    let bannerBody = prefix ? (body ? `${prefix}: ${body}` : prefix) : body;
    // Critic D3 — `preceding` is only read on the body-bearing branch of
    // `showMessageNotif`, so a newest row with NO preview (a call record, a
    // tombstone, an empty body) threw the whole batch away — and `rememberSeen`
    // above had already watermarked those rows, so nothing could ever show them.
    // That is F4 reintroduced through a different door. Promote the newest row
    // that DOES have a preview to carry the banner instead.
    if (!bannerBody && preceding.length > 0) {
      const promoted = preceding.pop()!;
      bannerBody = promoted.body;
    }
    if (foregroundUi) {
      // B-692 S-3 — foregrounded: in-app banner + tone instead of notifee.
      // S-5b — the whole-map badge reduce below is skipped on this lane:
      // nothing consumes a launcher badge while the app is on screen.
      onAfterCommit(() => {
        // Critic F1 — the in-app banner counts as "the notifier drew" for the
        // P2-6 generation check (same rationale as the active-thread route).
        messagePostedGeneration++;
        try {
          const {notifyForegroundMessage} = require('./inAppMessageNotifier') as typeof import('./inAppMessageNotifier');
          // B-703 MR-19 — with no banner host mounted this route returns
          // silently and draws NOTHING; counting it as a cue is what let the
          // warm fallback stay away from a message the user never saw.
          const delivered = notifyForegroundMessage({
            conversationId: cid,
            title: bannerTitle ?? displaySenderName,
            body: bannerBody,
            senderName: displaySenderName,
            isGroup: isGroupConv,
            sentAtMs: Number.isFinite(sentAtMs) ? sentAtMs : undefined,
            inActiveThread: false,
          });
          if (delivered) {noteCueDelivered(cid, tail.sender_id);} else {noteCueFailure(cid);}
        } catch { noteCueFailure(cid); }
      });
      continue;
    }
    const badgeCount = Object.values(state.conversations).reduce(
      (n, c) => n + (c.unread_count || 0), 0,
    );
    onAfterCommit(() => {
      void post(cid, {
        title: bannerTitle,
        body: bannerBody,
        senderName: body ? displaySenderName : undefined,
        senderIconUrl,
        badgeCount,
        sentAtMs: Number.isFinite(sentAtMs) ? sentAtMs : undefined,
        messageId: tail.id, // B-692 NL-2 — once-ever alert per row
        senderUserId: tail.sender_id, // B-703 MR-10 — mints this sender's cue token
        preceding, // B-710 — the rest of this commit's arrivals join the card
      });
    });
  }
}

export function startBackgroundMessageNotifier(opts?: {headless?: boolean}): void {
  if (Platform.OS !== 'android') {return;}
  // B-710 — PROMOTE a headless notifier when the warm start arrives.
  //
  // The FCM headless task runs in the app's OWN JS VM (react-native-firebase
  // starts its HeadlessJsTaskService against the app's ReactApplication and
  // reuses `currentReactContext`), so `headlessMode` outlives the wake. The old
  // shape returned early on `running` and left the flag set for the life of the
  // process, and the flag is load-bearing twice over: `foregroundUi` is
  // `!headlessMode && …`, and `isBackgrounded()` returns `s !== 'active'` in
  // headless mode. With it stuck true and the app on screen BOTH read false, so
  // the `!foregroundUi && !isBackgrounded()` bail below dropped EVERY message —
  // no in-app banner, no receive tone, no shade banner — until sign-out or
  // process death. "I opened the app from a notification and then stopped being
  // notified."
  //
  // The promotion is one-way. A headless start must never demote a notifier that
  // is already serving a live UI.
  if (running) {
    if (opts?.headless !== true && headlessMode) {
      headlessMode = false;
      console.log('[bgMsgNotifier] promoted headless → warm');
      void dismissStrandedPlaceholder();
    }
    return;
  }
  running = true;
  headlessMode = opts?.headless === true;
  void loadPreviewPref();
  try {
    const {useMessengerStore} = require('../store/messengerStore') as StoreModule;
    // Baseline the watermarks so nothing already in the store notifies. Seed the
    // whole id set, not just the tail (M16) — otherwise every pre-existing row
    // reads as "fresh" on the first store change and sprays stale banners.
    for (const [cid, list] of Object.entries(useMessengerStore.getState().messages)) {
      if (list.length > 0) {rememberSeen(cid, list.map(m => m.id));}
    }
    unsubStore = useMessengerStore.subscribe((state, prev) => {
      try { onStoreChange(state, prev); } catch (e) {
        console.warn('[bgMsgNotifier] change handler failed:', (e as Error).message);
      }
    });
    appStateSub = AppState.addEventListener('change', st => {
      // B-356 — see `confirmedBackground`. A transition to 'background' is the
      // ONLY evidence that the user actually left; a stale currentState is not.
      if (st === 'background' || st === 'inactive') {confirmedBackground = true;}
      if (st === 'active') {confirmedBackground = false; void cancelAllPosted();}
    });
    // B-703 MR-17 — a WARM start means the app is alive and drained by other
    // means, so any placeholder a frozen headless VM left behind is a lie. The
    // headless notifier must NOT do this: it starts alongside the drain that
    // legitimately owns the placeholder.
    if (!headlessMode) {void dismissStrandedPlaceholder();}
    console.log('[bgMsgNotifier] started');
  } catch (e) {
    running = false;
    console.warn('[bgMsgNotifier] start failed:', (e as Error).message);
  }
}

/**
 * B-710 — re-seed the watermarks from whatever the store holds now.
 *
 * Called once on the killed lane, right after `getMessengerRuntime` resolves, so
 * the rows the boot hydrated are marked seen before `pullEnvelopes` runs. It is
 * purely ADDITIVE: it can never suppress a draw that has already happened, and
 * it never gates future ones — which is the whole difference between it and the
 * hold that was tried and reverted (see the note in `onStoreChange`).
 *
 * It does NOT close B-712 on its own: zustand notifies synchronously, so a
 * one-row conversation hydrated during the boot has already drawn by the time
 * this runs. It does stop that row being re-drawn again later.
 */
export function armBackgroundMessageNotifier(): void {
  if (!running || Platform.OS !== 'android') {return;}
  try {
    const {useMessengerStore} = require('../store/messengerStore') as StoreModule;
    for (const [cid, list] of Object.entries(useMessengerStore.getState().messages)) {
      if (list.length > 0) {rememberSeen(cid, list.map(m => m.id));}
    }
  } catch (e) {
    console.warn('[bgMsgNotifier] rebaseline failed:', (e as Error).message);
  }
}

export function stopBackgroundMessageNotifier(): void {
  if (!running) {return;}
  running = false;
  headlessMode = false;
  unsubStore?.();
  unsubStore = null;
  appStateSub?.remove();
  appStateSub = null;
  // B-710 — cancel first, THEN drop the accumulators: `msgThreads` holds
  // decrypted previews and 1:1 ids are peer-keyed (`direct:<peerUserId>`), so
  // two accounts that talk to the same peer share an id. Without this, a wake
  // after an account switch could re-render the previous account's preview.
  void cancelAllPosted().then(() => {
    try {
      const {clearMessageNotifState} = require('./callNotification') as typeof import('./callNotification');
      clearMessageNotifState();
    } catch { /* the module may be absent in a degraded build */ }
  });
  seenIdsByConvo.clear();
  postedConvos.clear();
}
