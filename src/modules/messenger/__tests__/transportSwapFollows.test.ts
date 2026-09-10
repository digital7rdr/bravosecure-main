/**
 * WI-5.3 (transport G5) — no stale transport captures: call modules follow
 * the LIVE transport across a runtime rebuild.
 *
 * After `disposeLiveRuntime()` → new transport, three captures went stale:
 * `CallSignalling` held its constructor transport (every send
 * threw-and-swallowed against the corpse while a healthy replacement sat in
 * the registry), the rejoin hub stayed bound to the dead client's reconnect
 * listeners until the next fresh mount, and the useGroupCall rejoin closures
 * captured `ws` by value. This suite drives the first two against the REAL
 * `transportRegistry`; the closure fix is pinned by source scan below.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

jest.mock('../runtime/groupCallRegistry', () => ({
  getActiveGroupCall: () => ({roomId: 'room-1', gen: 1, state: 'joined', ending: false}),
}));
jest.mock('../runtime/callDiag', () => ({
  logCallSm:      jest.fn(),
  logCallSmQuiet: jest.fn(),
  shortCallId:    (s: string) => s.slice(0, 8),
}));

import {CallSignalling} from '../webrtc/signallingClient';
import {
  setGroupCallRejoinHandler,
  clearGroupCallRejoinHandler,
  nextGroupCallRejoinToken,
  releaseGroupCallRejoinHandler,
} from '../webrtc/groupCallRejoinHub';
import {setLiveTransport} from '../runtime/transportRegistry';
import type {TransportClient} from '@bravo/messenger-core';

type Sent = {event: string; data: unknown};

function fakeTransport(name: string): {tx: TransportClient; sent: Sent[]; fireReconnect: () => void; listeners: () => number} {
  const sent: Sent[] = [];
  const reconnectFns = new Set<() => void>();
  const tx = {
    name,
    state: 'connected',
    send(frame: Sent) { sent.push(frame); },
    onReconnect(fn: () => void) {
      reconnectFns.add(fn);
      return () => reconnectFns.delete(fn);
    },
  } as unknown as TransportClient;
  return {
    tx, sent,
    fireReconnect: () => { for (const fn of [...reconnectFns]) {fn();} },
    listeners: () => reconnectFns.size,
  };
}

const PEER = {userId: 'peer-1', deviceId: 1};

afterEach(() => {
  setLiveTransport(null);
  clearGroupCallRejoinHandler();
});

describe('WI-5.3 — CallSignalling resolves the live transport per send', () => {
  it('a send reaches the REGISTRY transport, not the stale constructor capture', () => {
    const dead = fakeTransport('dead');
    (dead.tx as unknown as {send: () => void}).send = () => { throw new Error('transport not open'); };
    const live = fakeTransport('live');

    const sig = new CallSignalling(dead.tx);
    setLiveTransport(live.tx);

    sig.sendIce('c-1', PEER, {candidate: 'c', sdpMid: '0', sdpMLineIndex: 0} as never);
    expect(live.sent).toHaveLength(1);
    expect(live.sent[0].event).toBe('call.ice');
  });

  it('with an EMPTY registry the constructor transport is the fallback (test/boot parity)', () => {
    const only = fakeTransport('only');
    const sig = new CallSignalling(only.tx);
    sig.sendIce('c-2', PEER, {candidate: 'c', sdpMid: '0', sdpMLineIndex: 0} as never);
    expect(only.sent).toHaveLength(1);
  });
});

describe('WI-5.3 — the rejoin hub follows the registry', () => {
  it('re-binds to a NEW live transport; the old subscription is dropped', () => {
    const a = fakeTransport('a');
    const b = fakeTransport('b');
    const fired: string[] = [];

    const token = nextGroupCallRejoinToken('room-1');
    setGroupCallRejoinHandler(token, a.tx as never, () => { fired.push('rejoin'); });
    expect(a.listeners()).toBe(1);

    // The runtime rebuild publishes the replacement.
    setLiveTransport(b.tx);
    expect(a.listeners()).toBe(0);   // old corpse released

    b.fireReconnect();
    expect(fired).toEqual(['rejoin']); // the SAME handler follows the socket

    a.fireReconnect();
    expect(fired).toEqual(['rejoin']); // the corpse can no longer trigger rejoins
  });

  it('a re-bind does not disturb ownership — the token still releases', () => {
    const a = fakeTransport('a');
    const b = fakeTransport('b');
    const fired: string[] = [];

    const token = nextGroupCallRejoinToken('room-1');
    setGroupCallRejoinHandler(token, a.tx as never, () => { fired.push('rejoin'); });
    setLiveTransport(b.tx);

    releaseGroupCallRejoinHandler(token);
    b.fireReconnect();
    expect(fired).toEqual([]); // released by its owner, rebind notwithstanding
  });

  it('a rebind to an ALREADY-CONNECTED fresh client fires the rejoin at once (round 1 P1)', () => {
    // A rebuild constructs a NEW TransportClient whose first connect is a
    // FIRST connect — onReconnect never fires for it (B-05). The hub arms a
    // one-shot on the new client's up-edge via onceConnected; when the swap
    // publishes an already-connected client, the rejoin runs immediately —
    // which is exactly when the SFU has torn this participant down.
    const a = fakeTransport('a');
    const fired: string[] = [];
    const token = nextGroupCallRejoinToken('room-1');
    setGroupCallRejoinHandler(token, a.tx as never, () => { fired.push('rejoin'); });

    const onceFns: Array<() => void> = [];
    const b = fakeTransport('b');
    (b.tx as unknown as {state: string; onceConnected: (fn: () => void) => () => void}).onceConnected =
      (fn: () => void) => { onceFns.push(fn); return () => {}; };

    setLiveTransport(b.tx);
    expect(fired).toEqual([]);        // not yet connected — armed, not fired
    for (const fn of onceFns) {fn();} // the new client's FIRST connect edge
    expect(fired).toEqual(['rejoin']);
  });

  it('an up-edge fire refused by a HELD claim retries when the claim releases (R-1)', () => {
    // A pre-dispose rejoin's claim survives ≤15 s on the dead socket's ack;
    // the fresh client's ONLY up-edge shot used to be spent against that
    // refusal with no recovery until a genuine reconnect.
    const {beginGroupCallRejoin, endGroupCallRejoin} =
      require('../webrtc/groupCallRejoinHub') as typeof import('../webrtc/groupCallRejoinHub');
    const a = fakeTransport('a');
    const fired: string[] = [];
    const token = nextGroupCallRejoinToken('room-1');
    setGroupCallRejoinHandler(token, a.tx as never, () => { fired.push('rejoin'); });

    const staleClaim = beginGroupCallRejoin(); // the pre-dispose rejoin, still in flight
    expect(staleClaim).toBeGreaterThan(0);

    const b = fakeTransport('b');
    (b.tx as unknown as {onceConnected: (fn: () => void) => () => void}).onceConnected =
      (fn: () => void) => { fn(); return () => {}; }; // already-connected: fires at once

    setLiveTransport(b.tx);
    expect(fired).toEqual(['rejoin']); // fired — but its own claim would be REFUSED

    endGroupCallRejoin(staleClaim);    // the stale ack finally settles
    expect(fired).toEqual(['rejoin', 'rejoin']); // the release retries the spent shot
  });

  it('a NULL broadcast (dispose) does not fire or re-bind anything', () => {
    const a = fakeTransport('a');
    const fired: string[] = [];
    const token = nextGroupCallRejoinToken('room-1');
    setGroupCallRejoinHandler(token, a.tx as never, () => { fired.push('rejoin'); });

    setLiveTransport(null); // dispose — the old subscription stays, inert
    expect(fired).toEqual([]);
    expect(a.listeners()).toBe(1);
  });
});

describe('WI-5.3 — the useGroupCall rejoin closures live-resolve (source scan)', () => {
  it('both closures resolve getLiveTransport() at fire time, never only the capture', () => {
    const src = readFileSync(
      join(process.cwd(), 'src', 'modules', 'messenger', 'webrtc', 'useGroupCall.ts'), 'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\r\n]*/g, '');
    const hits = src.match(/const wsNow = getLiveTransport\(\) \?\? (?:ws|wsRestore);/g) ?? [];
    expect(hits).toHaveLength(2);
    // And the rejoin rides the resolved one, not the raw capture.
    expect(src).toMatch(/ws:\s+wsNow,/);
    expect(src).not.toMatch(/ws:\s+wsRestore,/);
  });
});
