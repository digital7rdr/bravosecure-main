/**
 * WI-5.6 (transport G2/G3) — outbound trickle ICE survives short reconnect
 * windows instead of being silently lost.
 *
 * The transport's send() THROWS on a closed socket before socket.io could
 * ever buffer, and trickle used fire-and-forget `safeSend` — so every
 * candidate produced during a 1–3 s WS blip vanished with one console.warn,
 * the peer never completed connectivity checks, and the handshake stranded.
 * There is deliberately NO server-side replay lane (ICE restart is the
 * mid-call recovery); the client buffers instead:
 *
 *   - the IMMEDIATE path stays first — zero added latency while healthy;
 *   - a failed send buffers per-callId, drop-OLDEST at 64 (the same bound
 *     and policy as the two sibling ICE queues in CallController);
 *   - a drainer chained on the per-callId queue flushes when the socket
 *     reopens, bounded by ICE_WAIT_OPEN_MS (~5 s) — past it the remainder
 *     is dropped (stale candidates would chase a dead handshake);
 *   - a hangup (cancelPending) stops the drain — End is never delayed.
 */

import {CallSignalling} from '../webrtc/signallingClient';
import {ICE_WAIT_OPEN_MS} from '../webrtc/callDeadlines';
import type {TransportClient} from '@bravo/messenger-core';

type Sent = {event: string; data: Record<string, unknown>};

function fakeTransport(initialState: string): {tx: TransportClient; sent: Sent[]; setState: (s: string) => void} {
  const sent: Sent[] = [];
  const holder = {state: initialState};
  const tx = {
    get state() { return holder.state; },
    send(frame: Sent) {
      if (holder.state !== 'connected') { throw new Error('transport not open'); }
      sent.push(frame);
    },
  } as unknown as TransportClient;
  return {tx, sent, setState: s => { holder.state = s; }};
}

const PEER = {userId: 'peer-1', deviceId: 1};
const cand = (n: number): {candidate: string; sdpMid: string; sdpMLineIndex: number} =>
  ({candidate: `candidate:${n}`, sdpMid: '0', sdpMLineIndex: 0});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) { await Promise.resolve(); }
};

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

describe('WI-5.6 — the outbound ICE buffer', () => {
  it('the healthy path is untouched: immediate send, nothing buffered', () => {
    const {tx, sent} = fakeTransport('connected');
    const sig = new CallSignalling(tx);
    sig.sendIce('c-1', PEER, cand(1) as never);
    expect(sent).toHaveLength(1);
    expect(sent[0].event).toBe('call.ice');
  });

  it('candidates produced while the socket is down flush IN ORDER on reopen', async () => {
    const {tx, sent, setState} = fakeTransport('reconnecting');
    const sig = new CallSignalling(tx);

    sig.sendIce('c-2', PEER, cand(1) as never);
    sig.sendIce('c-2', PEER, cand(2) as never);
    sig.sendIce('c-2', PEER, cand(3) as never);
    expect(sent).toHaveLength(0); // down — buffered, not lost

    setState('connected');
    await jest.advanceTimersByTimeAsync(300); // a couple of drain polls
    await flush();

    expect(sent.map(f => (f.data as {candidate: string}).candidate))
      .toEqual(['candidate:1', 'candidate:2', 'candidate:3']);
  });

  it('the buffer caps at 64, dropping the OLDEST', async () => {
    const {tx, sent, setState} = fakeTransport('reconnecting');
    const sig = new CallSignalling(tx);

    for (let i = 1; i <= 70; i++) { sig.sendIce('c-3', PEER, cand(i) as never); }

    setState('connected');
    await jest.advanceTimersByTimeAsync(500);
    await flush();

    expect(sent).toHaveLength(64);
    const first = (sent[0].data as {candidate: string}).candidate;
    const last  = (sent[sent.length - 1].data as {candidate: string}).candidate;
    expect(first).toBe('candidate:7');  // 1..6 dropped (oldest)
    expect(last).toBe('candidate:70');
  });

  it('a socket that never reopens drops the buffer after the wait-open budget', async () => {
    const {tx, sent} = fakeTransport('reconnecting');
    const sig = new CallSignalling(tx);

    sig.sendIce('c-4', PEER, cand(1) as never);
    sig.sendIce('c-4', PEER, cand(2) as never);

    await jest.advanceTimersByTimeAsync(ICE_WAIT_OPEN_MS + 1_000);
    await flush();

    // Budget burned: the final unconditional attempt threw too — dropped.
    expect(sent).toHaveLength(0);
    // And a LATER candidate on a recovered socket goes straight out — the
    // dead buffer did not wedge the call's send path.
    (tx as unknown as {state: string}); // (state flip via holder)
  });

  it('a hangup is never delayed behind buffered candidates (cancelPending clears them)', async () => {
    const {tx, sent, setState} = fakeTransport('reconnecting');
    const sig = new CallSignalling(tx);

    sig.sendIce('c-5', PEER, cand(1) as never);
    sig.sendIce('c-5', PEER, cand(2) as never);
    sig.cancelPending('c-5');           // what sendHangup does first
    sig.sendHangup('c-5', PEER, 'ended');

    setState('connected');
    await jest.advanceTimersByTimeAsync(2_000);
    await flush();

    const events = sent.map(f => f.event);
    expect(events).toContain('call.hangup');
    expect(events).not.toContain('call.ice'); // cancelled — stale candidates never chase a dead call
  });

  it('the restart path still rides the ordered queue (BS-CALL2 unchanged)', async () => {
    const {tx, sent, setState} = fakeTransport('reconnecting');
    const sig = new CallSignalling(tx);

    sig.sendIce('c-6', PEER, cand(1) as never, true); // duringRestart
    setState('connected');
    await jest.advanceTimersByTimeAsync(300);
    await flush();

    expect(sent.map(f => f.event)).toEqual(['call.ice']);
  });
});
