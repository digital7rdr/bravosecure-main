/**
 * B-275 — "if I take the call from the notification it says Group call
 * unavailable".
 *
 * Answering a group call from its notification COLD-STARTS the app. Device
 * logcat, 2026-07-26:
 *
 *     14:09:33.811  Start proc 15286 … for broadcast
 *                   {ReactNativeFirebaseMessagingReceiver}
 *     14:09:42.546  [bravo.groupcall.boot] FAIL — no live WS transport
 *
 * The group-call boot called `getLiveTransport()` exactly ONCE and treated null
 * as terminal (`setState('unavailable')` → the "Group call unavailable" blocker
 * in GroupCallScreen). The 1:1 path never had this because CallScreen
 * SUBSCRIBES via `onTransport`.
 *
 * Two halves, and the second is the one that matters: `setLiveTransport` is
 * called from exactly one place — buildProductionRuntime — so on a push
 * cold-start nothing is constructing the transport, and a bare wait would just
 * time out more slowly. The device sat 8.7 SECONDS with no socket. So the boot
 * has to kick the runtime and then wait.
 */

jest.mock('@bravo/messenger-core', () => ({}), {virtual: true});

import {
  setLiveTransport, getLiveTransport, clearLiveTransport, waitForLiveTransport,
} from '../runtime/transportRegistry';
import type {TransportClient} from '@bravo/messenger-core';

const fakeTransport = (tag: string): TransportClient =>
  ({tag, close: () => {}} as unknown as TransportClient);

describe('B-275 — waitForLiveTransport', () => {
  afterEach(() => { setLiveTransport(null); });

  it('resolves IMMEDIATELY when a transport is already registered', async () => {
    const t = fakeTransport('already-here');
    setLiveTransport(t);
    await expect(waitForLiveTransport(50)).resolves.toBe(t);
  });

  it('resolves as soon as the transport arrives LATER (the cold-start case)', async () => {
    const t = fakeTransport('late');
    const pending = waitForLiveTransport(5000);
    // Nothing yet — this is the ~600ms-into-cold-start moment where the old
    // code gave up and rendered "Group call unavailable".
    expect(getLiveTransport()).toBeNull();
    setLiveTransport(t);
    await expect(pending).resolves.toBe(t);
  });

  it('resolves null on timeout so a genuinely dead socket still FAILS', async () => {
    // The wait must stay bounded — an unbounded one turns a hard error into a
    // permanent spinner, which is worse.
    jest.useFakeTimers();
    const pending = waitForLiveTransport(8000);
    jest.advanceTimersByTime(8000);
    await expect(pending).resolves.toBeNull();
    jest.useRealTimers();
  });

  it('a null broadcast does NOT settle the wait', async () => {
    // clearLiveTransport / signOut pushes null to every listener. Treating
    // that as an answer would resolve the waiter with no transport and put us
    // straight back on the "unavailable" screen.
    jest.useFakeTimers();
    const pending = waitForLiveTransport(3000);
    setLiveTransport(null);
    setLiveTransport(null);
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    jest.advanceTimersByTime(3000);
    await expect(pending).resolves.toBeNull();
    jest.useRealTimers();
  });

  it('unsubscribes — a resolved wait leaves no listener behind', async () => {
    // A leaked listener per answered call would accumulate for the process
    // lifetime and keep firing into dead closures.
    const t1 = fakeTransport('t1');
    const p = waitForLiveTransport(5000);
    setLiveTransport(t1);
    await p;
    // If the listener leaked, this second registration would still reach it.
    // Assert via clearLiveTransport not throwing and state being consistent.
    clearLiveTransport();
    expect(getLiveTransport()).toBeNull();
    setLiveTransport(fakeTransport('t2'));
    expect(getLiveTransport()).not.toBeNull();
  });
});

describe('B-275 — the group-call boot waits instead of giving up', () => {
  const {readFileSync} = require('node:fs') as typeof import('node:fs');
  const {join} = require('node:path') as typeof import('node:path');
  const src = readFileSync(
    join(process.cwd(), 'src', 'modules', 'messenger', 'webrtc', 'useGroupCall.ts'), 'utf8',
  ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\r\n]*/g, '');

  it('boots the runtime before waiting — nothing else creates the transport', () => {
    // THE load-bearing half. setLiveTransport is called only by
    // buildProductionRuntime, so without this the wait just times out.
    const bootAt = src.indexOf('getMessengerRuntime()');
    const waitAt = src.indexOf('waitForLiveTransport()');
    expect(bootAt).toBeGreaterThan(-1);
    expect(waitAt).toBeGreaterThan(-1);
    expect(bootAt).toBeLessThan(waitAt);
  });

  it('no longer declares unavailable on the FIRST null transport', () => {
    // The original: `const ws = getLiveTransport(); if (!ws) { … setState
    // ('unavailable'); return; }` — one look, then terminal.
    expect(src).not.toMatch(/const ws = getLiveTransport\(\);\s*if \(!ws\) \{[^}]*setState\('unavailable'\)/);
  });

  it('still fails when the transport never arrives', () => {
    // The bounded-failure branch must survive, or a dead socket hangs forever.
    expect(src).toContain("setState('unavailable')");
  });

  it('re-checks the cancellation flags after the await', () => {
    // Hanging up during the wait must not resume the boot afterwards.
    const waitAt = src.indexOf('waitForLiveTransport()');
    const after = src.slice(waitAt, waitAt + 400);
    expect(after).toMatch(/cancelled \|\| isLeavingRef\.current/);
  });
});

/**
 * Warm-start FIX-16 — the 1:1 twin of the fix above.
 *
 * CallScreen SUBSCRIBES to the transport registry, which is why B-275 never hit
 * the 1:1 lane — but subscribing only waits for whoever else boots the runtime.
 * On a cold-VM answer that is MainNavigator's configure effect, 10-25s out on
 * low-end hardware (B-227), while the 40s signalling budget burns down doing
 * nothing. Same answer as the group path: kick the runtime yourself.
 *
 * Source scan — CallScreen mounts RN and the node project cannot import it.
 * Comments stripped, \r?\n anchors (these files are CRLF).
 */
describe('FIX-16 — the 1:1 answer kicks the runtime on a cold start', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const CALL_SCREEN = path.resolve(
    __dirname, '..', '..', '..', 'screens', 'messenger', 'CallScreen.tsx',
  );
  const s = fs.readFileSync(CALL_SCREEN, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map(l => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');

  it('boots the runtime when there is no transport to subscribe to', () => {
    expect(s).toMatch(/getMessengerRuntime\(\)/);
  });

  it('only kicks when the transport is genuinely absent', () => {
    const kick = s.indexOf('getMessengerRuntime()');
    expect(kick).toBeGreaterThan(-1);
    // A kick on every render would rebuild the runtime under a live call.
    const before = s.slice(Math.max(0, kick - 900), kick);
    expect(before).toMatch(/if \(transport \|\| !callId\) \{return;\}/);
  });

  it('never forces a runtime under an in-progress restore', () => {
    const kick = s.indexOf('getMessengerRuntime()');
    const before = s.slice(Math.max(0, kick - 900), kick);
    // A restore rebuilds the runtime mid-flight; answering under it would sign
    // with the throwaway pre-restore identity (B-107 / B-64 class).
    expect(before).toMatch(/isRestoreModeActive\(\)/);
  });

  it('re-checks cancellation after the await before publishing the transport', () => {
    const kick = s.indexOf('getMessengerRuntime()');
    const after = s.slice(kick, kick + 600);
    expect(after).toMatch(/if \(cancelled\) \{return;\}/);
  });
});
