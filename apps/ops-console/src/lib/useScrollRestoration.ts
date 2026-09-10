'use client';

/**
 * Scroll restoration for INNER scroll containers (e.g. the bookings
 * table's `.dt-wrap`). Next.js only restores `window` scroll on
 * back/forward — positions inside `overflow:auto` divs are lost the
 * moment the page unmounts. This hook persists the container's
 * scrollTop to sessionStorage (per-tab, survives client-side nav and
 * reload, dies with the tab) and restores it once the data that gives
 * the container its height has rendered.
 *
 * Usage:
 *   const ref = useRef<HTMLDivElement>(null);
 *   useScrollRestoration(ref, !isLoading && !error);
 *   <div ref={ref} style={{overflow:'auto'}}>…</div>
 */

import {useEffect, useRef, type RefObject} from 'react';
import {usePathname} from 'next/navigation';

export function useScrollRestoration<T extends HTMLElement>(
  ref: RefObject<T | null>,
  /** Gate restoration until the scrollable content exists — pass your
   *  data-loaded flag. Restoring against an empty table is a no-op
   *  (scrollHeight is too small) and would silently lose the position. */
  ready: boolean = true,
  /** Override the storage key; defaults to the current pathname so each
   *  route remembers its own position. */
  key?: string,
): void {
  const pathname = usePathname();
  const storageKey = `scroll:${key ?? pathname}`;
  const restored = useRef(false);

  // Persist as the user scrolls, coalesced to one write per frame so the
  // (passive) handler never becomes scroll-jank.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        try {
          sessionStorage.setItem(storageKey, String(el.scrollTop));
        } catch {
          // Storage full / disabled — restoration is best-effort.
        }
      });
    };
    el.addEventListener('scroll', onScroll, {passive: true});
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener('scroll', onScroll);
    };
  }, [ref, storageKey]);

  // Restore exactly once per mount, after `ready` flips true. Effects run
  // post-layout, so scrollHeight already reflects the rendered rows and
  // the browser clamps an out-of-range value for us.
  useEffect(() => {
    if (!ready || restored.current) return;
    const el = ref.current;
    if (!el) return;
    restored.current = true;
    try {
      const saved = Number(sessionStorage.getItem(storageKey));
      if (Number.isFinite(saved) && saved > 0) el.scrollTop = saved;
    } catch {
      // Same best-effort stance as the writer above.
    }
  }, [ready, ref, storageKey]);
}
