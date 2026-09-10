/**
 * B-703 MR-11 — ONE owner for `activeConversationId`.
 *
 * That id means "the thread the user is looking at RIGHT NOW", and three
 * separate systems trust it to mean exactly that: the background notifier
 * withholds a banner for it, the store withholds an unread bump for it
 * (`messengerStore` inbound append), and the in-app banner layer hides itself
 * for it. So a thread that stays "active" while the user is not looking at it
 * is a thread that is SILENCED — no banner, no sound, no unread, for the one
 * conversation they are most engaged with.
 *
 * Two lanes did exactly that, and both were reported as "no notification":
 *
 *   (a) Anything pushed OVER the chat — contact info, settings, a call screen.
 *       `ChatScreen` pinned the id in a plain mount-scoped `useEffect`, so the
 *       chat underneath stayed "active" for as long as it stayed MOUNTED.
 *   (b) Pressing Home from inside a chat. Nothing in navigation changes, so a
 *       focus-scoped pin is not enough on its own either.
 *
 * The rule this hook enforces: the id is pinned while the screen is FOCUSED and
 * the app is FOREGROUND, and is cleared the moment either stops being true.
 * Backgrounding hands the thread back to the notifier; resuming re-pins it and
 * clears whatever unread piled up, because the user is looking at it again.
 *
 * `DepartmentChatScreen` and `ChatScreen` both route through here. They had
 * drifted copies of the pin/clear pair (this repo's most common bug shape), and
 * only one of them had even the focus half.
 */
import {useCallback, useEffect, useRef} from 'react';
import {AppState} from 'react-native';
import {useFocusEffect} from '@react-navigation/native';
import {useMessengerStore} from '@/modules/messenger/store/messengerStore';

export function useActiveConversation(
  conversationId: string | null | undefined,
  opts?: {
    /**
     * B-691/F3 — defer the unread-zeroing half of the FIRST pin of a thread.
     * Zeroing re-renders every conversations subscriber, including the
     * not-yet-frozen chat list behind the open slide, so the screen hands us
     * its open-transition gate through `unreadClearReady` instead and we do
     * that half when it opens. Re-focusing an already-pinned thread never
     * defers: there is no slide, and the unread that accumulated while the
     * user was away is precisely what has to clear.
     */
    deferFirstUnreadClear?: boolean;
    /**
     * The deferred half's green light (ChatScreen's `transitionDone`). Ignored
     * unless `deferFirstUnreadClear` is set. It lives here rather than in the
     * screen because that gate opens on a 400 ms FALLBACK TIMER which keeps
     * running while the app is backgrounded and after the screen has blurred —
     * a screen-side `setActive` on that timer re-pinned a released thread, or
     * clobbered the pin of the chat the user had just moved to.
     */
    unreadClearReady?: boolean;
  },
): void {
  const deferFirstUnreadClear = opts?.deferFirstUnreadClear === true;
  const unreadClearReady = opts?.unreadClearReady === true;
  const pinnedIdRef = useRef<string | null>(null);
  const focusedRef = useRef(false);
  // B-356 — the same rule the notifier uses, and for the same reason: a VM that
  // FCM started headless reports a stale `'background'` while the user is
  // reading the screen. Only an OBSERVED transition is evidence they left, so
  // the deferred clear below keys on this rather than on `AppState.currentState`
  // — which is exactly the reading this hook already refuses to gate its PIN on.
  const confirmedBackgroundRef = useRef(false);
  // Which thread the deferred clear has already been spent on. Without it, a
  // `conversationId` change under a live screen (the B-18 merge shape) re-runs
  // the effect with the gate ALREADY open and zeroes unread inside the new
  // thread's open animation — the re-render B-691 measured and removed.
  const clearedForRef = useRef<string | null>(null);

  const pin = useCallback((skipUnreadClear: boolean): void => {
    if (!conversationId) {return;}
    try {
      useMessengerStore.getState().setActiveConversation(
        conversationId,
        skipUnreadClear ? {skipUnreadClear: true} : undefined,
      );
    } catch { /* defensive — the store can be torn down on app exit */ }
  }, [conversationId]);

  // Fix #31 — read the LIVE value: a fast back-out + drill-into-another-chat
  // can run this cleanup AFTER the next screen has already pinned itself, and
  // an unconditional clear would blank the chat the user is now on.
  const clearIfMine = useCallback((): void => {
    if (!conversationId) {return;}
    try {
      const store = useMessengerStore.getState();
      if (store.activeConversationId === conversationId) {store.setActiveConversation(null);}
    } catch { /* defensive — the store can be torn down on app exit */ }
  }, [conversationId]);

  useFocusEffect(
    useCallback(() => {
      if (!conversationId) {return;}
      focusedRef.current = true;

      const firstPin = pinnedIdRef.current !== conversationId;
      pinnedIdRef.current = conversationId;
      // Deliberately NOT gated on `AppState.currentState`: B-356 — a VM that FCM
      // started headless reports a stale 'background' while the user is looking
      // at the screen, so refusing to pin on that reading would silence the
      // notification-opened chat. A focused, user-navigated screen is foreground
      // by construction; only a CONFIRMED background transition releases it.
      pin(deferFirstUnreadClear && firstPin);

      const sub = AppState.addEventListener('change', s => {
        // 'background' ONLY. iOS fires 'inactive' for every incoming banner and
        // every control-centre swipe, and the user is still on the thread.
        if (s === 'background') {confirmedBackgroundRef.current = true; clearIfMine();}
        else if (s === 'active') {confirmedBackgroundRef.current = false; pin(false);}
      });

      return () => {
        focusedRef.current = false;
        sub.remove();
        clearIfMine();
      };
    }, [conversationId, deferFirstUnreadClear, pin, clearIfMine]),
  );

  // The deferred half. Guarded by the two facts the pin above is guarded by,
  // because this one fires from a TIMER and can therefore land long after the
  // screen lost focus or the app went away.
  useEffect(() => {
    if (!conversationId || !deferFirstUnreadClear || !unreadClearReady) {return;}
    if (clearedForRef.current === conversationId) {return;}
    if (!focusedRef.current) {return;}
    if (confirmedBackgroundRef.current) {return;}
    clearedForRef.current = conversationId;
    pin(false);
  }, [conversationId, deferFirstUnreadClear, unreadClearReady, pin]);
}
