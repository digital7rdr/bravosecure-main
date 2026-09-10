/**
 * fetch() with a hard time bound for the intel feed.
 *
 * Every news client already forwards an upstream AbortSignal (so the hook
 * can cancel on unmount / filter change), but none of them bound a request
 * that connects then STALLS — common on flaky mobile networks. Without a
 * timeout the feed spinner hangs until the OS eventually kills the socket.
 *
 * This composes the caller's signal with an internal timeout: whichever
 * fires first aborts the request. An abort surfaces as the usual fetch
 * rejection, which each client already catches and turns into [] / cached.
 */
const DEFAULT_TIMEOUT_MS = 10_000;

export async function fetchWithTimeout(
  input: string,
  init: RequestInit & {signal?: AbortSignal} = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const {signal: upstream, ...rest} = init;
  const controller = new AbortController();
  const onUpstreamAbort = () => controller.abort();

  // If the caller's signal is already aborted, abort immediately.
  if (upstream) {
    if (upstream.aborted) {controller.abort();}
    else {upstream.addEventListener('abort', onUpstreamAbort, {once: true});}
  }

  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, {...rest, signal: controller.signal});
  } finally {
    clearTimeout(timer);
    upstream?.removeEventListener('abort', onUpstreamAbort);
  }
}
