/**
 * MX-09 — transient per-message upload progress, OUTSIDE the zustand
 * store: progress ticks are high-frequency and worthless to persist, so
 * they ride a module-level registry + useSyncExternalStore (the same
 * shape as ChatScreen's shared countdown tick). Only the ONE bubble
 * whose message id is uploading re-renders per tick.
 */
import {useSyncExternalStore} from 'react';

const values = new Map<string, number>();
const listeners = new Map<string, Set<() => void>>();

/** fraction ∈ [0,1]; null clears (upload finished or failed). */
export function setUploadProgress(msgId: string, fraction: number | null): void {
  if (fraction === null) {
    values.delete(msgId);
  } else {
    const clamped = Math.max(0, Math.min(1, fraction));
    // Quantise to 2% steps so a chatty XHR can't render-storm the bubble.
    const stepped = Math.round(clamped * 50) / 50;
    if (values.get(msgId) === stepped) {return;}
    values.set(msgId, stepped);
  }
  const subs = listeners.get(msgId);
  if (subs) {
    for (const cb of subs) {
      try { cb(); } catch { /* one bad subscriber mustn't break the rest */ }
    }
  }
}

function subscribe(msgId: string, cb: () => void): () => void {
  let subs = listeners.get(msgId);
  if (!subs) {
    subs = new Set();
    listeners.set(msgId, subs);
  }
  subs.add(cb);
  return () => {
    subs!.delete(cb);
    if (subs!.size === 0) {listeners.delete(msgId);}
  };
}

/** null when no upload is in flight for this message. */
export function useUploadProgress(msgId: string): number | null {
  return useSyncExternalStore(
    cb => subscribe(msgId, cb),
    () => values.get(msgId) ?? null,
  );
}
