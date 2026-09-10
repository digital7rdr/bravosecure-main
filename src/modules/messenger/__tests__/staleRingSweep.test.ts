/**
 * Warm-start FIX-14 — a call that is over must not ring, and must not stay
 * ringing.
 *
 * Two holes the audit found, both resting on the same missing check:
 *
 *   1. Nothing anywhere called `notifee.getDisplayedNotifications`. A ring
 *      drawn while the device was in Doze — or drawn moments before its cancel
 *      landed — outlived the process, and the next launch found a dead call
 *      ringing with the NATIVE looping ringtone still going (that ringtone
 *      survives JS VM death by design, so nothing else would have stopped it).
 *
 *   2. The in-app ring handler never consulted `isIncomingCallDead` /
 *      `wasRecentlyEnded`, so protection against a replayed `call.offer` rested
 *      entirely on ONE server-side tombstone (rehydrateCallSession).
 *
 * The sweep must route every cancel through `dismissCallNotif`, never a bare
 * `cancelNotification` — the ringtone stop lives in that funnel, and a bare
 * cancel leaves the phone ringing with no notification left to stop it.
 */

const mockDisplayed: Array<{notification: {id?: string}; date?: number | string}> = [];
const mockCancelled: string[] = [];
const mockRingtoneStops: string[] = [];

jest.mock('@notifee/react-native', () => ({
  __esModule: true,
  default: {
    getDisplayedNotifications: jest.fn(async () => mockDisplayed),
    cancelNotification: jest.fn(async (id: string) => { mockCancelled.push(id); }),
  },
  AndroidCategory: {CALL: 'call'},
  AndroidImportance: {HIGH: 4},
  AndroidVisibility: {PUBLIC: 1},
  EventType: {PRESS: 1, ACTION_PRESS: 2, DISMISSED: 0},
}));

jest.mock('react-native', () => ({
  Platform: {OS: 'android', Version: 33},
  NativeModules: {},
  AppState: {currentState: 'active', addEventListener: jest.fn(() => ({remove: jest.fn()}))},
}));

jest.mock('../push/incomingRingtone', () => ({
  stopIncomingRingtone: jest.fn((callId: string) => { mockRingtoneStops.push(callId); }),
  startIncomingRingtone: jest.fn(),
}));

const mockDead = new Set<string>();
jest.mock('../push/incomingCallCache', () => ({
  isIncomingCallDead: (id: string) => mockDead.has(id),
  clearIncomingCallPayload: jest.fn(),
  getIncomingCallPayload: jest.fn(() => null),
  setIncomingCallPayload: jest.fn(() => true),
}));

const mockEnded = new Set<string>();
jest.mock('../runtime/callRegistry', () => ({
  wasRecentlyEnded: (id: string) => mockEnded.has(id),
  getActiveCall: jest.fn(() => null),
}));

import {sweepStaleCallNotifications} from '../push/callNotification';

// Audit finding — notifee's Android native side STRINGIFIES the post time
// (putString(String.valueOf(getPostTime()))), so on device `date` is a string.
// The first cut of the sweep checked `typeof date === 'number'`, this fixture
// fed a number, and the age lane passed vacuously while being dead code on
// device. The fixture now mirrors the device shape by default.
const displayCall = (callId: string, ageMs = 0, dateShape: 'string' | 'number' = 'string'): void => {
  const at = Date.now() - ageMs;
  mockDisplayed.push({
    notification: {id: `bravo-call-${callId}`},
    date: dateShape === 'string' ? String(at) : at,
  });
};

beforeEach(() => {
  mockDisplayed.length = 0;
  mockCancelled.length = 0;
  mockRingtoneStops.length = 0;
  mockDead.clear();
  mockEnded.clear();
  jest.clearAllMocks();
});

describe('FIX-14 — stale call-notification sweep', () => {
  it('leaves a fresh ring with no death signal alone', async () => {
    displayCall('call-live', 2_000);

    const n = await sweepStaleCallNotifications();

    expect(n).toBe(0);
    expect(mockCancelled).toEqual([]);
  });

  it('cancels a ring whose call was tombstoned', async () => {
    displayCall('call-dead', 1_000);
    mockDead.add('call-dead');

    const n = await sweepStaleCallNotifications();

    expect(n).toBe(1);
    expect(mockCancelled).toEqual(['bravo-call-call-dead']);
  });

  it('cancels a ring whose call recently ended', async () => {
    displayCall('call-ended', 1_000);
    mockEnded.add('call-ended');

    expect(await sweepStaleCallNotifications()).toBe(1);
    expect(mockCancelled).toEqual(['bravo-call-call-ended']);
  });

  it('cancels a ring that outlived the ring window even with no tombstone', async () => {
    // The exact case the sweep exists for: the process that would have written
    // the tombstone is gone, so age is the only evidence left — and on device
    // that age arrives as a STRING (see displayCall).
    displayCall('call-old', 5 * 60_000);

    expect(await sweepStaleCallNotifications()).toBe(1);
    expect(mockCancelled).toEqual(['bravo-call-call-old']);
  });

  it('the age lane also works where date IS a number (iOS / future notifee)', async () => {
    displayCall('call-old-n', 5 * 60_000, 'number');

    expect(await sweepStaleCallNotifications()).toBe(1);
  });

  it('a garbage date string falls back to the death signals, never NaN math', async () => {
    mockDisplayed.push({notification: {id: 'bravo-call-junkdate'}, date: 'not-a-number'});

    // No death signal → must be left alone (NaN comparisons must not cancel).
    expect(await sweepStaleCallNotifications()).toBe(0);

    mockDead.add('junkdate');
    expect(await sweepStaleCallNotifications()).toBe(1);
  });

  it('ALWAYS stops the native ringtone for anything it cancels', async () => {
    displayCall('call-dead', 1_000);
    mockDead.add('call-dead');

    await sweepStaleCallNotifications();

    // A bare cancelNotification leaves the phone ringing with no notification
    // left to stop it — the ringtone is native and outlives the JS VM.
    expect(mockRingtoneStops).toEqual(['call-dead']);
  });

  it('never touches the call the app is actually on', async () => {
    displayCall('call-live', 10 * 60_000);   // old AND
    mockDead.add('call-live');               // tombstoned — still must survive

    const n = await sweepStaleCallNotifications({isLive: id => id === 'call-live'});

    expect(n).toBe(0);
    expect(mockCancelled).toEqual([]);
  });

  it('ignores notifications that are not calls', async () => {
    mockDisplayed.push({notification: {id: 'bravo-msg-conv-1'}, date: Date.now() - 600_000});
    mockDisplayed.push({notification: {id: 'bravo-missed-x'}, date: Date.now() - 600_000});

    expect(await sweepStaleCallNotifications()).toBe(0);
    expect(mockCancelled).toEqual([]);
  });

  it('falls back to the death signals when the OEM shell reports no post time', async () => {
    mockDisplayed.push({notification: {id: 'bravo-call-nodate'}});
    mockDead.add('nodate');

    expect(await sweepStaleCallNotifications()).toBe(1);
    expect(mockCancelled).toEqual(['bravo-call-nodate']);
  });

  it('does not cancel an undated ring that has no death signal', async () => {
    mockDisplayed.push({notification: {id: 'bravo-call-unknown'}});

    expect(await sweepStaleCallNotifications()).toBe(0);
  });

  it('survives a notifee failure without throwing into the boot path', async () => {
    const notifee = (require('@notifee/react-native') as {default: {getDisplayedNotifications: jest.Mock}}).default;
    notifee.getDisplayedNotifications.mockRejectedValueOnce(new Error('binder died'));

    await expect(sweepStaleCallNotifications()).resolves.toBe(0);
  });

  it('sweeps several dead rings in one pass', async () => {
    displayCall('a', 1_000); mockDead.add('a');
    displayCall('b', 1_000); mockEnded.add('b');
    displayCall('c', 1_000);

    expect(await sweepStaleCallNotifications()).toBe(2);
    expect(mockCancelled).toEqual(['bravo-call-a', 'bravo-call-b']);
  });
});

/**
 * The ring-handler half lives in MainNavigator.tsx, which the node project
 * cannot mount. Source scan per CLAUDE.md — comments stripped, \r?\n anchors.
 */
describe('FIX-14 — the ring handler consults the death signals (source scan)', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const NAV = path.resolve(__dirname, '..', '..', '..', 'navigation', 'MainNavigator.tsx');

  const src = (): string =>
    fs.readFileSync(NAV, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/)
      .map(l => l.replace(/(^|[^:])\/\/.*$/, '$1'))
      .join('\n');

  it('checks isIncomingCallDead and wasRecentlyEnded before ringing', () => {
    const s = src();
    const handler = s.indexOf('setIncomingCallHandler(');
    expect(handler).toBeGreaterThan(-1);
    const body = s.slice(handler, handler + 3000);
    expect(body).toMatch(/isIncomingCallDead\(data\.callId\)/);
    expect(body).toMatch(/wasRecentlyEnded\(data\.callId\)/);
  });

  it('keys the guard on callId, never on the peer', () => {
    const s = src();
    const guard = s.indexOf('isIncomingCallDead(data.callId)');
    expect(guard).toBeGreaterThan(-1);
    const line = s.slice(guard, s.indexOf('\n', guard));
    // Keying by peer would swallow a legitimate second call from the same
    // person.
    expect(line).not.toMatch(/data\.from/);
  });

  it('runs the guard BEFORE any ring/Telecom work', () => {
    const s = src();
    const guard = s.indexOf('isIncomingCallDead(data.callId)');
    const groupRing = s.indexOf('getActiveGroupCall()');
    expect(guard).toBeGreaterThan(-1);
    expect(groupRing).toBeGreaterThan(guard);
  });
});
