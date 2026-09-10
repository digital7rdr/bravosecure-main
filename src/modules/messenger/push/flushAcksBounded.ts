/**
 * B-703 MR-5 — push queued relay acks before a background task resolves, under
 * a bound.
 *
 * WHY IT EXISTS. The delivered receipt (the sender's second tick) IS the relay
 * ack. Acks are coalesced on a 200 ms batcher and every foreground caller fires
 * the flush and forgets it — correct there, because awaiting a network
 * round-trip on the chat-open path is the jank B-279/B-691 fought. A BACKGROUND
 * task is the opposite case: the moment it resolves, Android may freeze the
 * process with the POST unsent, so the relay never learns this device holds the
 * message. The sender's tick then stays single until the recipient opens the
 * app, and the envelope redelivers (which also feeds the duplicate lane, MR-7).
 *
 * WHY BOUNDED. Both background lanes run inside their own time budget, and the
 * ack queue can legitimately take far longer than any of them: its 429 arm
 * sleeps 10 s INSIDE the run (up to 3x), and a `batchless` relay acks serially,
 * one POST per envelope. Waiting unbounded would not deliver those acks any
 * sooner — the OS still cuts the task off — but it WOULD push the killed lane
 * past its 8 s notify budget, flipping a quietly-drained wake into the generic
 * fallback banner. That banner cannot be muted (sealed sender leaves the wake
 * without a conversationId), so an unbounded wait trades a stuck tick for a
 * muted thread that dings. The bound keeps the whole benefit for the common
 * single-POST case and drops exactly the cases where waiting buys nothing.
 *
 * WHY SHARED. Two handlers register for msg-wake — the headless task
 * (`index.js` → fcmHeadless) and the richer one fcmBootstrap installs, which
 * OVERRIDES it whenever the app is warm. Both pull, so both owe this flush;
 * this repo's most common bug shape is N drifted copies of one behaviour.
 *
 * Never throws: an ack that does not land is redelivered by the relay, and a
 * caller that cannot ack must still finish its own work.
 */

/** Long enough for the common single ack-batch POST, short enough to sit inside
 *  both lanes' budgets (the killed lane's is 8 s). */
export const ACK_FLUSH_BUDGET_MS = 1500;

export async function flushAcksBounded(
  runtime: unknown,
  tag: string,
  budgetMs: number = ACK_FLUSH_BUDGET_MS,
): Promise<void> {
  const flush = (runtime as {flushAcks?: () => Promise<void>} | null | undefined)?.flushAcks;
  if (typeof flush !== 'function') {
    // Reachable only from a degraded/stub runtime — exactly where a breadcrumb
    // is worth having, since the symptom (a stuck tick) is silent otherwise.
    console.warn(`[NOTIFLAT] ${tag}: runtime has no flushAcks — acks stay on the batcher`);
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (flush as () => Promise<void>).call(runtime),
      new Promise<void>(resolve => { timer = setTimeout(resolve, budgetMs); }),
    ]);
  } catch (e) {
    console.warn(`[NOTIFLAT] ${tag}: ack flush failed:`, (e as Error).message);
  } finally {
    if (timer) {clearTimeout(timer);}
  }
}
