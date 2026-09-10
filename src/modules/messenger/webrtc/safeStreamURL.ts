/**
 * Defensive wrapper around `MediaStream.toURL()`.
 *
 * Why: when the OS suspends the app under Doze (call minimized, screen
 * off, user reopens later) the JS context freezes but native WebRTC
 * objects continue. If the OS reclaims the WebRTC engine before JS
 * thaws — or if a renegotiation tore down a track during the freeze —
 * the JS-side `MediaStream` reference is still alive but its underlying
 * native track is gone. Calling `.toURL()` on that dead handle has
 * three observed failure modes:
 *
 *   1. throws `TypeError: Cannot read property 'toURL' of null` on the
 *      JS side (recoverable)
 *   2. returns an empty string (RTCView paints black, no crash)
 *   3. SEGFAULTs through the JNI bridge during native render (FATAL,
 *      app dies — same shape as the v1.0.10 close+reopen crash)
 *
 * This helper:
 *   - returns null when the stream itself is null/undefined
 *   - try/catches the .toURL() call so a dead handle returns null
 *     instead of throwing through React's render path (which would
 *     unmount the entire screen, losing the call)
 *   - returns null on empty-string results so the caller can fall back
 *     to a placeholder tile
 *
 * Callers MUST treat null as "no video, render the avatar fallback".
 * RTCView is forgiving with empty strings but explicit-null rendering
 * is cleaner.
 */
export function safeStreamURL(stream: {toURL?: () => string | undefined | null} | null | undefined): string | null {
  if (!stream || typeof stream.toURL !== 'function') {return null;}
  try {
    const url = stream.toURL();
    if (typeof url !== 'string' || url.length === 0) {return null;}
    return url;
  } catch (e) {

    console.warn('[bravo.safeStreamURL] toURL threw — likely dead native handle:', (e as Error).message);
    return null;
  }
}
