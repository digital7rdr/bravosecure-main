/**
 * B-691 — chat-open side effects must not land inside the open animation.
 *
 * Why: the ChatScreen open slide is native (native-stack, 220 ms), but every
 * mount effect used to fire during it — the relay pull's decrypt burst, the
 * markRead commit on a 200 ms timer detonating at the animation's tail, the
 * unread-zeroing re-render of the still-unfrozen list behind the slide. Each
 * store commit → reconcile → native view batch competes with the animator on
 * the UI thread; measured as B-279's 64/419 Slow-UI-thread frames with the
 * GPU idle. Root cause & fix plan: docs/qa/CHAT_OPEN_ANIMATION_LAG_2026-08-29.md (F2/F3).
 *
 * Contract: returns false until the OPEN transition ends ('transitionEnd'
 * with closing=false — emitted by native-stack and the JS stack alike), then
 * true for the rest of the screen's life. A fallback timer covers paths that
 * never emit the event (animation:'none', a replace), so a gated effect can
 * be DELAYED, never lost. SIDE EFFECTS ONLY — content must never be gated on
 * this: deferring the list commit itself was measured 2× WORSE (CLAUDE.md
 * dead-ends table), and the scan suite pins that no JSX keys on the flag.
 */
import {useEffect, useRef, useState} from 'react';

interface TransitionNavLike {
  addListener: (
    type: 'transitionEnd',
    cb: (e: {data?: {closing?: boolean}}) => void,
  ) => () => void;
}

export interface OpenTransitionDone {
  /** ms from hook mount to the gate opening. */
  ms: number;
  via: 'transition' | 'fallback';
}

export const OPEN_TRANSITION_FALLBACK_MS = 400;

export function useOpenTransitionGate(
  navigation: TransitionNavLike,
  opts?: {fallbackMs?: number; onDone?: (info: OpenTransitionDone) => void},
): boolean {
  const [done, setDone] = useState(false);
  // Latest-callback ref so an inline onDone never re-arms the listener.
  const onDoneRef = useRef(opts?.onDone);
  onDoneRef.current = opts?.onDone;
  const fallbackMsRef = useRef(opts?.fallbackMs ?? OPEN_TRANSITION_FALLBACK_MS);
  const t0Ref = useRef(Date.now());

  useEffect(() => {
    let finished = false;
    const finish = (via: OpenTransitionDone['via']): void => {
      if (finished) {return;}
      finished = true;
      setDone(true);
      try {
        onDoneRef.current?.({ms: Date.now() - t0Ref.current, via});
      } catch { /* a perf probe must never break the screen */ }
    };
    const unsub = navigation.addListener('transitionEnd', e => {
      // closing=true is THIS screen being popped — it never opens the gate.
      if (e?.data?.closing !== true) {finish('transition');}
    });
    const timer = setTimeout(() => finish('fallback'), fallbackMsRef.current);
    return () => { unsub(); clearTimeout(timer); };
    // Why one-shot per mount: the gate never re-closes, so re-arming on a
    // navigation-prop identity change would only double-report.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return done;
}
