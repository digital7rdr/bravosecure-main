/**
 * Resolve a renderable local file:// uri for a message attachment.
 *
 *   - Outgoing bubbles may carry the plaintext local pick at
 *     `media_url` — return it as-is, no network.
 *   - Otherwise the decrypted temp file is checked FIRST (media-parity
 *     G4, 2026-07-03): it is the product of a prior authenticated
 *     decrypt of this exact message, so a warm open costs one stat()
 *     instead of re-running download + HMAC + AES + base64 on every
 *     bubble mount and again in the viewer.
 *   - Cold path: download the ciphertext (cached), decrypt, write the
 *     plaintext temp file, return its uri. Resolutions are SINGLE-
 *     FLIGHT per message id (module-level map) so the bubble and the
 *     full-screen viewer share one pipeline run instead of racing two.
 *
 * State machine: 'idle' → 'loading' → 'ready' | 'error'. The hook is
 * lazy by default — pass `auto: true` to fetch on mount (used for image
 * thumbnails), or call `load()` on demand. On error, `errorReason`
 * distinguishes the cases users kept reporting as one opaque "Tap to
 * retry" (media-parity M17): 'forbidden' (no grant — ask the sender to
 * resend), 'gone' (expired off the server), 'offline', 'unavailable'.
 */

import {useCallback, useEffect, useRef, useState} from 'react';
import {getMessengerRuntime} from '../runtime/runtime';
import {writeTempBytes, statTempBytes} from './mediaFiles';
import {classifyAttachmentError, type AttachmentErrorReason} from './attachmentError';
import {assertFreeSpaceFor} from './freeSpace';

export {attachmentErrorText, type AttachmentErrorReason} from './attachmentError';

export interface AttachmentMessageLike {
  id: string;
  media_url?: string;
  media_object_key?: string;
  media_key?: string;
  media_iv?: string;
  media_mime?: string;
  /** MD-08 — declared size drives the free-space precheck when present. */
  media_meta?: {sizeBytes?: number};
}

export type AttachmentState = 'idle' | 'loading' | 'ready' | 'error';

// Media-parity G4 — single-flight resolution per message id, shared by
// every hook instance (bubble + viewer). The resolved uri is memoized so
// later mounts return instantly without even a stat().
const inFlight    = new Map<string, Promise<string>>();
const resolvedUri = new Map<string, string>();
const MAX_RESOLVED = 300;

// MEDIA-25 — module-level semaphore capping concurrent download+decrypt
// pipelines. A long thread mounting dozens of image bubbles auto-loads
// them all at once; single-flight only dedupes per message id. Manual
// taps share the same gate (simplest; the warm-stat/memo fast paths
// above it never queue, so re-opens stay instant).
const MAX_CONCURRENT_RESOLVES = 4;
let activeResolves = 0;
const resolveWaiters: Array<() => void> = [];
function acquireResolveSlot(): Promise<void> {
  if (activeResolves < MAX_CONCURRENT_RESOLVES) {
    activeResolves += 1;
    return Promise.resolve();
  }
  return new Promise(resolve => { resolveWaiters.push(resolve); });
}
function releaseResolveSlot(): void {
  const next = resolveWaiters.shift();
  // Why: hand the slot to the next waiter without decrementing —
  // decrement-then-increment would let a racing acquire overshoot the cap.
  if (next) {next();} else {activeResolves -= 1;}
}

/** Test hook — clears the module-level memo between cases. */
export function _resetAttachmentUriCache(): void {
  inFlight.clear();
  resolvedUri.clear();
}

/**
 * Media-parity G6 — seed the resolved-uri memo right after a SEND, so
 * the sender's own bubble never re-downloads its own upload (the send
 * path already wrote the decrypted temp file it just encrypted).
 */
export function seedResolvedAttachmentUri(messageId: string, uri: string): void {
  if (resolvedUri.size >= MAX_RESOLVED && !resolvedUri.has(messageId)) {
    const oldest = resolvedUri.keys().next().value;
    if (oldest !== undefined) {resolvedUri.delete(oldest);}
  }
  resolvedUri.set(messageId, uri);
}

/**
 * Non-hook resolver for batch flows (Files multi-select share) — the exact
 * pipeline `load()` runs: memo → single-flight → warm temp stat → gated
 * download + decrypt. Callers must have object key + key material on `msg`.
 */
export async function resolveAttachmentFileUri(msg: AttachmentMessageLike): Promise<string> {
  const memo = resolvedUri.get(msg.id);
  if (memo) {return memo;}
  const existing = inFlight.get(msg.id);
  if (existing) {return existing;}
  const p = (async (): Promise<string> => {
    // Fast path — a prior authenticated decrypt already produced the file.
    const warm = await statTempBytes(msg.media_mime ?? 'application/octet-stream', msg.id);
    if (warm) {return warm;}
    // MEDIA-25 — cold path only: gate the network+decrypt pipeline.
    await acquireResolveSlot();
    try {
      // MD-08 — probe BEFORE spending network + decrypt on bytes the disk
      // cannot hold; surfaces as the 'no_space' reason. Fail OPEN inside
      // the probe; unknown size still guards a near-full disk.
      await assertFreeSpaceFor(msg.media_meta?.sizeBytes);
      const rt = await getMessengerRuntime();
      if (!rt || typeof rt.downloadMedia !== 'function') {throw new Error('runtime_not_ready');}
      const bytes = await rt.downloadMedia({
        objectKey: msg.media_object_key!,
        keyB64:    msg.media_key!,
        ivB64:     msg.media_iv!,
      });
      return writeTempBytes(bytes, msg.media_mime ?? 'application/octet-stream', msg.id);
    } finally {
      releaseResolveSlot();
    }
  })();
  inFlight.set(msg.id, p);
  try {
    const uri = await p;
    seedResolvedAttachmentUri(msg.id, uri);
    return uri;
  } finally {
    inFlight.delete(msg.id);
  }
}

export function useAttachmentUri(
  msg: AttachmentMessageLike,
  opts?: {auto?: boolean},
): {
  uri: string | null;
  state: AttachmentState;
  errorReason: AttachmentErrorReason | null;
  load: () => void;
  onError: () => void;
} {
  // Sender's own pick is already a local plaintext uri.
  const directUri = msg.media_url ?? null;
  // Audit MEDIA-A3 — whether the message ALSO carries the encrypted objectKey
  // so we can re-download if the local pick uri dies (content:// grants are
  // revoked after reboot; the OS can clear the cache dir).
  const canDownload = !!(msg.media_object_key && msg.media_key && msg.media_iv);
  // Prefer the local pick until it proves dead, then fall back to download.
  const [preferDirect, setPreferDirect] = useState<boolean>(!!directUri);
  const activeDirect = preferDirect ? directUri : null;
  const memoized = resolvedUri.get(msg.id) ?? null;
  const [uri, setUri]     = useState<string | null>(activeDirect ?? memoized);
  const [state, setState] = useState<AttachmentState>((activeDirect ?? memoized) ? 'ready' : 'idle');
  const [errorReason, setErrorReason] = useState<AttachmentErrorReason | null>(null);
  const startedRef = useRef(false);

  /**
   * B-296 — RESET when this hook is handed a DIFFERENT message.
   *
   * `uri`, `state` and `preferDirect` are seeded by `useState` initialisers and
   * `startedRef` latches after the first load — all of which happen on the first
   * mount ONLY. That was fine while the sole caller was a message bubble, where
   * one hook instance sees exactly one message for its whole life.
   *
   * The full-screen viewer pages between photos on a MOUNTED component, so
   * without this the hook kept returning the FIRST photo's uri forever, and
   * `load()` early-returned on the latched `startedRef`. The viewer therefore
   * showed the same picture no matter how many times you swiped.
   *
   * Done in the render phase (React's documented "adjusting state when props
   * change") rather than in an effect: an effect would let one frame render with
   * the previous photo's uri paired to the new message, which is precisely the
   * mismatch the viewer's last-good-pair logic then latches onto.
   */
  const lastIdRef = useRef(msg.id);
  if (lastIdRef.current !== msg.id) {
    lastIdRef.current = msg.id;
    startedRef.current = false;
    const nextDirect = msg.media_url ?? null;
    const nextSeed = nextDirect ?? resolvedUri.get(msg.id) ?? null;
    setPreferDirect(!!nextDirect);
    setUri(nextSeed);
    setState(nextSeed ? 'ready' : 'idle');
    setErrorReason(null);
  }

  const load = useCallback(() => {
    if (activeDirect) {return;}               // still trusting the local pick
    if (startedRef.current) {return;}         // already in-flight / done
    if (!canDownload) {
      setState('error');
      setErrorReason('unavailable');
      return;
    }
    startedRef.current = true;
    setState('loading');
    setErrorReason(null);
    void (async () => {
      try {
        const localUri = await resolveAttachmentFileUri(msg);
        setUri(localUri);
        setState('ready');
      } catch (e) {
        // Allow a later retry (e.g. the runtime finished booting).
        startedRef.current = false;
        setErrorReason(classifyAttachmentError(e));
        setState('error');
      }
    })();
    // msg fields are stable for a given message id; keying on id keeps the
    // callback identity steady across bubble re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDirect, canDownload, msg.id, msg.media_object_key, msg.media_key, msg.media_iv, msg.media_mime]);

  // Audit MEDIA-A3 — the local pick uri failed to render (revoked/cleared).
  // Stop trusting it and fall through to the encrypted download path so the
  // SENDER's own attachment isn't permanently broken after a reboot.
  const onError = useCallback(() => {
    if (preferDirect && canDownload) {
      resolvedUri.delete(msg.id);
      setPreferDirect(false);
      startedRef.current = false;
      setUri(null);
      setState('idle');
    }
  }, [preferDirect, canDownload, msg.id]);

  useEffect(() => {
    if (opts?.auto) {load();}
  }, [opts?.auto, load]);
  // Once we've flipped off the dead local pick, kick the download immediately.
  useEffect(() => {
    if (!preferDirect && !uri && canDownload) {load();}
  }, [preferDirect, uri, canDownload, load]);

  return {uri, state, errorReason, load, onError};
}
