/**
 * CRIT-5 — the killed-app headless path must render the SAME server-driven
 * wakes the warm path does (SOS / mission-* / booking-* / agent-* /
 * payout-settled) instead of dropping them as "unknown kind, no action".
 *
 * These tests exercise the shared dispatcher both handlers call, asserting a
 * notifee notification is drawn for each server kind, an opaque {eventId} wake
 * is hydrated first, and a genuinely unknown kind returns false (so the caller
 * logs "no action").
 */

const displayed: Array<{id?: string; title?: string; body?: string; channelId?: string}> = [];
const createdChannels: Array<{id: string; name: string; bypassDnd?: boolean; sound?: string}> = [];
const deletedChannels: string[] = [];

// NOT `{virtual: true}` — B-161 (see the @utils/constants note below): notifee
// IS a real installed module, and a virtual mock RACES the real resolution
// under the node project. When the real one won, showServerWakeNotification
// drew nothing and this suite failed intermittently in full multi-project runs
// (the 2026-07-24 pre-push flake) while passing in isolation.
jest.mock(
  '@notifee/react-native',
  () => ({
    __esModule: true,
    default: {
      createChannel: jest.fn(async (c: {id: string; name: string; bypassDnd?: boolean; sound?: string}) => {
        createdChannels.push(c);
        return c.id;
      }),
      deleteChannel: jest.fn(async (id: string) => { deletedChannels.push(id); }),
      displayNotification: jest.fn(async (n: {id?: string; title?: string; body?: string; android?: {channelId?: string}}) => {
        displayed.push({id: n.id, title: n.title, body: n.body, channelId: n.android?.channelId});
      }),
    },
    AndroidImportance: {HIGH: 4, LOW: 2},
  }),
);

jest.mock('@services/api', () => ({refreshAccessTokenShared: jest.fn(async () => {})}), {virtual: true});
// NOT `{virtual: true}` — see B-161 in pendingActions.test.ts: the module is
// real, so a virtual mock races the real one and this suite intermittently saw
// the production fallback URLs.
jest.mock('@utils/constants', () => ({API_BASE_URL: 'https://api.test', MSG_BASE_URL: 'https://msg.test'}));
// NOT `{virtual: true}` — same B-161 race; AsyncStorage is a real module.
jest.mock(
  '@react-native-async-storage/async-storage',
  () => ({__esModule: true, default: {getItem: jest.fn(async () => 'access-token')}}),
);

import {showServerWakeNotification} from '../push/serverWakeNotifications';

describe('showServerWakeNotification (CRIT-5 shared dispatch)', () => {
  beforeEach(() => {
    displayed.length = 0;
    createdChannels.length = 0;
    deletedChannels.length = 0;
    (global as {fetch?: unknown}).fetch = undefined;
  });

  it('draws an SOS alert on the DND-bypassing sos-alerts-v2 channel and retires v1', async () => {
    const handled = await showServerWakeNotification({kind: 'sos-cpo-alert', missionId: 'm-1'});
    expect(handled).toBe(true);
    // P3 (2026-07-10): channel config is immutable after creation, so the
    // bypassDnd fix ships as a v2 channel + a delete of the stale v1.
    const sos = createdChannels.find(c => c.id === 'sos-alerts-v2');
    expect(sos).toBeDefined();
    expect(sos?.bypassDnd).toBe(true);
    expect(sos?.sound).toBe('default'); // no dedicated SOS asset in res/raw
    expect(deletedChannels).toContain('sos-alerts');
    expect(displayed).toHaveLength(1);
    expect(displayed[0].title).toContain('SOS');
    expect(displayed[0].channelId).toBe('sos-alerts-v2');
    expect(displayed[0].id).toBe('sos-cpo-alert-m-1');
  });

  it('draws mission-dispatched / payout / agent wakes', async () => {
    for (const kind of ['mission-dispatched', 'payout-settled', 'agent-approved', 'mission-aborted', 'agent-rejected']) {
      displayed.length = 0;
      const handled = await showServerWakeNotification({kind, missionId: 'mm'});
      expect(handled).toBe(true);
      expect(displayed).toHaveLength(1);
    }
  });

  it('draws booking-approved and rejects a malformed bookingId', async () => {
    const ok = await showServerWakeNotification({kind: 'booking-approved', bookingId: 'abc12345-def0-6789-abcd-ef0123456789'});
    expect(ok).toBe(true);
    expect(displayed).toHaveLength(1);
    expect(displayed[0].title).toBe('Booking approved');

    displayed.length = 0;
    const bad = await showServerWakeNotification({kind: 'booking-approved', bookingId: 'not a uuid!!'});
    expect(bad).toBe(true); // kind recognised
    expect(displayed).toHaveLength(0); // but nothing drawn
  });

  it('hydrates an opaque {eventId} wake then draws the hydrated kind', async () => {
    (global as {fetch?: unknown}).fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({kind: 'sos-cpo-alert', missionId: 'm-op'}),
    })) as unknown as typeof fetch;

    const handled = await showServerWakeNotification({eventId: 'evt-123', eventClass: 'sos'});
    expect(handled).toBe(true);
    expect((global.fetch as jest.Mock)).toHaveBeenCalled();
    expect(displayed).toHaveLength(1);
    expect(displayed[0].title).toContain('SOS');
    expect(displayed[0].id).toBe('sos-cpo-alert-m-op');
  });

  it('returns false for an unknown kind so the caller logs no-action', async () => {
    const handled = await showServerWakeNotification({kind: 'totally-unknown'});
    expect(handled).toBe(false);
    expect(displayed).toHaveLength(0);
  });
});
