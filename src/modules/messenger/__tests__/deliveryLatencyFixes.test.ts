/**
 * B-693 F-2/F-3/F-4/F-5 + F-1a — the delivery-latency fixes stay wired.
 *
 * Companion to recvLatProbe.test.ts (the F-0 instruments). Root causes and
 * the rationale for every value pinned here live in
 * docs/qa/MESSAGE_DELIVERY_LATENCY_2026-08-29.md (DL-1..DL-9).
 *
 * productionRuntime.ts and ChatScreen.tsx cannot be imported by this project
 * (react-native) — comment-stripped source scans. Both files are CRLF:
 * nothing here is `\n`-anchored; anchors sit inside function/handler slices.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

function strip(rel: string[]): string {
  return readFileSync(join(process.cwd(), ...rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\r\n]*/g, '');
}

const runtime = strip(['src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts']);
const outbox  = strip(['src', 'modules', 'messenger', 'store', 'sqlOutboxStore.ts']);
const chat    = strip(['src', 'screens', 'messenger', 'ChatScreen.tsx']);

function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  expect(a).toBeGreaterThan(-1);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe('F-2 — group fan-out staggers LAUNCHES; waves are never gated on settle', () => {
  const fanout = slice(runtime, 'const GROUP_FANOUT_WAVE', 'const tWave1 = Date.now()');

  it('the wave size is 8 and the loop strides by it over participants', () => {
    expect(runtime).toContain('const GROUP_FANOUT_WAVE = 8;');
    expect(fanout).toContain('w += GROUP_FANOUT_WAVE');
    expect(fanout).toContain('participants.slice(w, w + GROUP_FANOUT_WAVE)');
  });

  it('launches are UNAWAITED per wave; one allSettled gathers everything at the end', () => {
    expect(fanout).toContain('const leg = sendOne(memberId);');
    expect(fanout).toContain('sendPromises.push(leg);');
    expect(fanout).toContain('const results = await Promise.allSettled(sendPromises);');
  });

  it('every leg is marked HANDLED at launch — a stagger-window rejection must not go global', () => {
    // The allSettled handler attaches macrotask turns after wave-1 launches;
    // without this an early rejection red-boxes dev / fails jest as an
    // unhandled rejection (found by the 250-cap test going red).
    const launchAt = fanout.indexOf('const leg = sendOne(memberId);');
    const handledAt = fanout.indexOf('leg.catch(() => {');
    const pushAt = fanout.indexOf('sendPromises.push(leg);');
    expect(launchAt).toBeGreaterThan(-1);
    expect(handledAt).toBeGreaterThan(launchAt);
    expect(pushAt).toBeGreaterThan(handledAt);
  });

  it('the REJECTED shape cannot return: no wave is awaited before the next launches', () => {
    // Critic P0-1: `await Promise.allSettled(wave...)` inside the loop gates
    // wave w+1 on wave w's NETWORK settle — one slow leg head-of-line-blocks
    // every later member's send and defers their P0-N4 durable enqueue by a
    // network-bounded window (Doze-kill = silent partial loss). The network
    // must stay fully concurrent; only the CPU launch is staggered.
    expect(fanout).not.toContain('await Promise.allSettled(wave');
  });

  it('a MACROTASK yield sits between wave LAUNCHES — a microtask yield frees nothing', () => {
    // Promise.resolve() would keep the next wave in the same task and hand
    // no time back to rendering/touches; the pin is on setTimeout precisely.
    expect(fanout).toContain('setTimeout(resolve, 0)');
    // …and only BETWEEN waves, never after the last one (a trailing yield
    // taxes every group send by a timer tick for nothing).
    expect(fanout).toContain('w + GROUP_FANOUT_WAVE < participants.length');
  });
});

describe('F-3 — the outbox retry ladder is the halved one', () => {
  it('rungs are [1s, 2s, 8s, 30s, 2min]', () => {
    expect(outbox).toContain('const BACKOFF_MS = [1_000, 2_000, 8_000, 30_000, 2 * 60_000];');
  });

  it('the budget shape is unchanged (ladder length + 5)', () => {
    expect(outbox).toContain('const MAX_ATTEMPTS = BACKOFF_MS.length + 5;');
  });
});

describe('F-3 — the "retrying…" whisper on a stalled sending bubble', () => {
  it('a 5s one-shot arms only for an own message in sending state', () => {
    const arm = slice(chat, 'const [sendingStalled, setSendingStalled]', 'const isImage');
    expect(arm).toContain("!(sent && msg.status === 'sending')");
    expect(arm).toContain('setTimeout(() => setSendingStalled(true), 5_000)');
    expect(arm).toContain('clearTimeout(t)');
  });

  it('renders in the meta row, suppressed while media narrates its upload', () => {
    expect(chat).toContain("msg.status === 'sending' && !isUploading && sendingStalled");
    expect(chat).toContain('>retrying…</Text>');
  });
});

describe('F-4 — the WS ack watchdog floor', () => {
  it('is 2_500 with the 4×RTT term and 20s ceiling intact', () => {
    expect(runtime).toContain('const WS_ACK_FLOOR_MS   = 2_500;');
    expect(runtime).toContain('const WS_ACK_CEILING_MS = 20_000;');
    expect(runtime).toContain('const WS_ACK_RTT_FACTOR = 4;');
  });

  it('the fallback stays dedup-shaped: HTTP retry unconditional, teardown gated', () => {
    const watchdog = slice(runtime, 'const ackTimer = setTimeout(', 'wsAckDeadlineMs())');
    expect(watchdog).toContain('serverLooksDead && !hasLiveCall()');
    expect(watchdog).toContain('void httpFallback()');
  });
});

describe('F-5 — receipt-poll triggers beyond the 60s timer', () => {
  it('the AppState resume handler polls receipts before branching on resumeAction', () => {
    const resume = slice(runtime, "if (s === 'active') {", "} else if (s === 'background'");
    const poll = resume.indexOf('reconcileHttpReceipts({');
    const branch = resume.indexOf("if (resumeAction === 'park')");
    expect(poll).toBeGreaterThan(-1);
    expect(branch).toBeGreaterThan(poll);
  });

  it('opening a conversation polls on the id CHANGE edge, throttled, and is disposed', () => {
    const sub = slice(runtime, 'const unsubReceiptPollOnOpen', 'unsubReceiptPollOnOpen(); }');
    expect(sub).toContain('state.activeConversationId');
    expect(sub).toContain('if (cur === receiptPollPrevConvId) {return;}');
    expect(sub).toContain('receiptPollLastAt < 5_000');
    expect(sub).toContain('reconcileHttpReceipts({');
    // The unsubscribe rides liveDisposers so logout→login cannot leak it.
    expect(runtime).toContain('liveDisposers.push(() => { try { unsubReceiptPollOnOpen(); }');
  });

  it('the open-edge poll is DEFERRED off the mount commit (B-691 class), epoch-rechecked', () => {
    // Critic P2-1 — the subscriber fires synchronously inside ChatScreen's
    // mount-time setActive commit, riding the 220ms open slide. The poll
    // must hop off that commit and re-check the epoch when it fires.
    const sub = slice(runtime, 'const unsubReceiptPollOnOpen', 'unsubReceiptPollOnOpen(); }');
    const timerAt = sub.indexOf('setTimeout(() => {');
    const pollAt = sub.indexOf('reconcileHttpReceipts({');
    expect(timerAt).toBeGreaterThan(-1);
    expect(pollAt).toBeGreaterThan(timerAt);
    expect(sub).toContain('if (!isOurEpoch()) {return;}');
  });
});

describe('F-1a — the pre-chain receive stages stay OFF the txn chain', () => {
  it('unwrap and cert admission both run before handleIncoming enqueues the frame', () => {
    const deliver = slice(runtime, 'async function handleDeliverInner', 'async function handleIncoming');
    const unwrapAt = deliver.indexOf('unwrapOuter({');
    const certAt = deliver.indexOf('await admitSenderCert(');
    const chainAt = deliver.indexOf('await handleIncoming(');
    expect(unwrapAt).toBeGreaterThan(-1);
    expect(certAt).toBeGreaterThan(unwrapAt);
    expect(chainAt).toBeGreaterThan(certAt);
  });
});
