/**
 * B-692 S-3 — the FOREGROUND half of message notification.
 *
 * backgroundMessageNotifier owns the decision (fresh committed inbound row,
 * not self, not muted); while the app is foregrounded it routes the event
 * HERE instead of notifee. This module fans it out to:
 *   - the in-app banner host (a UI listener registered by
 *     src/components/InAppMessageBanner.tsx) — non-active conversations only;
 *   - a short receive tone (messageTone.ts) — subtler for the OPEN thread;
 *   - a light haptic — banner events only.
 *
 * Everything user-audible/visible is invoked by the notifier from inside
 * onAfterCommit, so M16 holds on this lane too: a rolled-back receive
 * transaction makes no sound and shows no banner.
 *
 * All side effects are lazy-required and individually swallowed: this module
 * sits in the push import graph (headless-safe), so it must never pull
 * expo-av / react-native UI in at import time.
 */

export interface InAppMessageEvent {
  conversationId: string;
  title?: string;
  body?: string;
  senderName?: string;
  isGroup: boolean;
  sentAtMs?: number;
}

type BannerListener = (e: InAppMessageEvent) => void;

let bannerListener: BannerListener | null = null;

/** UI host registration. Returns an unsubscribe; last registration wins. */
export function setInAppMessageBannerListener(l: BannerListener | null): () => void {
  bannerListener = l;
  return () => {
    if (bannerListener === l) {bannerListener = null;}
  };
}

/** Test/health probe — is a banner host mounted? */
export function hasInAppMessageBannerListener(): boolean {
  return bannerListener !== null;
}

function playTone(kind: 'banner' | 'inChat'): void {
  try {
    const {playMessageTone} = require('../runtime/messageTone') as typeof import('../runtime/messageTone');
    void playMessageTone(kind);
  } catch { /* audio unavailable (headless/node) — cue skipped */ }
}

function lightHaptic(): void {
  try {
    const {haptics} = require('../../../utils/haptics') as typeof import('../../../utils/haptics');
    haptics.select();
  } catch { /* vibration unavailable — cue skipped */ }
}

/**
 * A committed inbound message arrived while the app is FOREGROUNDED.
 * `inActiveThread: true` = the thread is on screen — subtle tone only,
 * no banner, no haptic (the message itself is the visual).
 *
 * B-703 MR-19 — returns whether a CUE was actually delivered, because the
 * caller counts this as one and the FCM wake lanes then decline to draw their
 * fallback on the strength of it. Every side effect here is individually
 * swallowed by design, so "it did not throw" says nothing at all: with no
 * banner host mounted this used to return silently at `if (!l)` and still be
 * counted as a banner the user saw.
 */
export function notifyForegroundMessage(
  event: InAppMessageEvent & {inActiveThread: boolean},
): boolean {
  if (event.inActiveThread) {
    playTone('inChat');
    // The open thread's own bubble is the cue, and it is drawn by the store
    // commit that got us here — this is true even with the receive tone off.
    return true;
  }
  playTone('banner');
  lightHaptic();
  const l = bannerListener;
  if (!l) {return false;}
  try {
    const {inActiveThread: _drop, ...bannerEvent} = event;
    l(bannerEvent);
    return true;
  } catch (e) {
    console.warn('[inAppMsgNotif] banner listener failed:', (e as Error).message);
    return false;
  }
}
