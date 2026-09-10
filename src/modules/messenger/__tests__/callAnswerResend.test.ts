/**
 * NA-05 — a `call.answer` that is queued while the WS is down must survive the
 * whole ring window (40s), report whether it actually reached the socket, and
 * be abandonable the moment the call goes terminal.
 */

import {CallSignalling} from '../webrtc/signallingClient';
import type {TransportClient, ClientFrame} from '@bravo/messenger-core';

const PEER = {userId: 'bob', deviceId: 1};
const SDP = 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\nx-label=answer\r\n';

// Mirrors packages/messenger-core/src/transport/client.ts:320-322 — send()
// THROWS when the socket is not connected. Without that, the post-budget
// unconditional trySend would record the frame and these tests would pass
// vacuously.
function fakeTransport(initial = 'connected') {
  const sent: ClientFrame[] = [];
  const t = {
    state: initial,
    send: (f: ClientFrame) => {
      if (t.state !== 'connected') {throw new Error('transport not open');}
      sent.push(f);
    },
  };
  return {sent, t, transport: t as unknown as TransportClient};
}

describe('NA-05 — call-setup send budget spans the ring window', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(()  => { jest.useRealTimers(); });

  it('call.answer survives a 25s outage and lands on reconnect', async () => {
    const {sent, t, transport} = fakeTransport('reconnecting');
    const signalling = new CallSignalling(transport);

    const delivered = signalling.sendAnswer('cNA5', PEER, SDP);
    await jest.advanceTimersByTimeAsync(25_000);
    expect(sent.find(f => f.event === 'call.answer')).toBeUndefined();

    t.state = 'connected';
    await jest.advanceTimersByTimeAsync(200);
    expect(sent.find(f => f.event === 'call.answer')).toBeTruthy();
    await expect(delivered).resolves.toBe(true);
  });

  it('reports give-up when the transport never opens within the budget', async () => {
    const {sent, transport} = fakeTransport('reconnecting');
    const signalling = new CallSignalling(transport);

    const delivered = signalling.sendAnswer('cNA5a', PEER, SDP);
    await jest.advanceTimersByTimeAsync(41_000);

    await expect(delivered).resolves.toBe(false);
    expect(sent.find(f => f.event === 'call.answer')).toBeUndefined();
  });

  it('cancelPending abandons a queued answer', async () => {
    const {sent, t, transport} = fakeTransport('reconnecting');
    const signalling = new CallSignalling(transport);

    const delivered = signalling.sendAnswer('cNA5b', PEER, SDP);
    signalling.cancelPending('cNA5b');
    await jest.advanceTimersByTimeAsync(200);
    t.state = 'connected';
    await jest.advanceTimersByTimeAsync(500);

    expect(sent.find(f => f.event === 'call.answer')).toBeUndefined();
    await expect(delivered).resolves.toBe(false);
  });

  it('cancelPending on an idle callId does not poison a later send', async () => {
    const {sent, transport} = fakeTransport('connected');
    const signalling = new CallSignalling(transport);

    signalling.cancelPending('never-queued');
    const delivered = signalling.sendAnswer('never-queued', PEER, SDP);
    await jest.advanceTimersByTimeAsync(200);

    expect(sent.find(f => f.event === 'call.answer')).toBeTruthy();
    await expect(delivered).resolves.toBe(true);
  });

  it('hangup still wins immediately under the longer budget', async () => {
    const {sent, t, transport} = fakeTransport('reconnecting');
    const signalling = new CallSignalling(transport);

    signalling.sendOffer('cNA5c', PEER, SDP, 'voice');
    signalling.sendHangup('cNA5c', PEER, 'ended');
    await jest.advanceTimersByTimeAsync(200);
    t.state = 'connected';
    await jest.advanceTimersByTimeAsync(500);

    expect(sent.find(f => f.event === 'call.hangup')).toBeTruthy();
    expect(sent.find(f => f.event === 'call.offer')).toBeUndefined();
  });
});
