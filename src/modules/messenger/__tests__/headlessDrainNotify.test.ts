/**
 * B-324/B-325 residuals — the Signal-style KILLED-APP drain (founder-approved
 * 2026-07-29 "yes do signal/whatsapp level", supersedes the wake-metadata
 * option).
 *
 * Contract under test:
 *  - a msg-wake with the app killed boots the runtime from a PERSISTED config
 *    record, drains+persists, and the store notifier then posts the
 *    fully-resolved banner (group name title, sender, preview, SEND time) —
 *    the exact composition path the warm path uses (one rule, no drift);
 *  - FAIL-OPEN: every guard degrades to the pre-drain generic/guess banner —
 *    the drain may never make the killed path worse than before it existed;
 *  - identity safety: no persisted config / restore gate held (B-107) / no
 *    local identity (Round-8 keygen class) → the runtime is NEVER booted.
 *
 * Harness mirrors backgroundMessageNotifier.test.ts (real store + notifier +
 * callNotification; notifee/AsyncStorage/react-native mocked) with the
 * runtime/keychain/restoreMode seams mocked at their exact require paths.
 */

const mockStorage = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem:    async (k: string) => mockStorage.get(k) ?? null,
    setItem:    async (k: string, v: string) => { mockStorage.set(k, v); },
    removeItem: async (k: string) => { mockStorage.delete(k); },
  },
}));

jest.mock('react-native', () => ({
  Platform: {OS: 'android'},
  AppState: {
    currentState: 'background',
    addEventListener: jest.fn(() => ({remove: jest.fn()})),
  },
}));

jest.mock('@notifee/react-native', () => ({
  __esModule: true,
  default: {
    displayNotification: jest.fn(async () => 'nid'),
    cancelNotification:  jest.fn(async () => {}),
    createChannel:       jest.fn(async () => 'bravo-messages'),
    deleteChannel:       jest.fn(async () => {}),
    onForegroundEvent:   jest.fn(),
    onBackgroundEvent:   jest.fn(),
  },
  AndroidImportance: {HIGH: 4, DEFAULT: 3, LOW: 2},
  AndroidCategory:   {MESSAGE: 'msg', CALL: 'call'},
  AndroidVisibility: {PRIVATE: 0, PUBLIC: 1},
  AndroidStyle:      {BIGTEXT: 1, MESSAGING: 2},
  EventType:         {PRESS: 1, ACTION_PRESS: 2},
}));

jest.mock('@utils/constants', () => ({
  API_BASE_URL: 'https://api.test',
  MSG_BASE_URL: 'https://msg.test',
}));

const mockConfigureMessengerRuntime = jest.fn();
const mockGetActiveOwnerKey = jest.fn((): string | null => null);
/**
 * B-703 MR-1 — the mock returns a REPORT, like the real `pullEnvelopes`.
 * An inert `async () => {}` double is exactly what hid this bug: it modelled a
 * pull that can only ever succeed, so no test could see the lane treat a failed
 * or half-finished drain as 'drained'.
 */
const fullyDrained = (): RelayPullReport =>
  ({ok: true, pulled: 1, acked: 1, skipped: 0, leftOnRelay: 0});
const leftOnRelay = (n = 1): RelayPullReport =>
  ({ok: true, pulled: n, acked: 0, skipped: 0, leftOnRelay: n});
const mockPullEnvelopes = jest.fn(async (): Promise<RelayPullReport | void> => fullyDrained());
/**
 * B-703 MR-5 — the killed lane must WAIT for queued relay acks. Acks ride a
 * 200 ms batcher; if the headless task resolves first, Android can freeze the
 * process with the POST unsent and the sender's tick stays single.
 */
const ackOrder: string[] = [];
const mockFlushAcks = jest.fn(async (): Promise<void> => { ackOrder.push('flush'); });
const mockGetMessengerRuntime = jest.fn(async (_mode?: string) =>
  ({pullEnvelopes: mockPullEnvelopes, flushAcks: mockFlushAcks}));
jest.mock('../runtime/runtime', () => ({
  configureMessengerRuntime: (cfg: unknown) => mockConfigureMessengerRuntime(cfg),
  getActiveOwnerKey:         () => mockGetActiveOwnerKey(),
  getMessengerRuntime:       (mode: string) => mockGetMessengerRuntime(mode),
}));

const mockHasDbKey = jest.fn(async (_owner: string) => true);
jest.mock('../runtime/keychain', () => ({
  hasDbKey: (owner: string) => mockHasDbKey(owner),
}));

let mockRestoreActive = false;
jest.mock('../backup/restoreMode', () => ({
  isRestoreModeActive: () => mockRestoreActive,
}));

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import notifee from '@notifee/react-native';
import {useMessengerStore} from '../store/messengerStore';
import {stopBackgroundMessageNotifier} from '../push/backgroundMessageNotifier';
import {_resetMsgNotifStateForTest} from '../push/callNotification';
// B-710 — the cue ledger is module state that outlives a test. The killed lane
// now names its sender, so it can actually CLAIM a token — and an earlier
// case's token would otherwise answer a later case's wake and suppress its
// fallback banner.
import {_resetCueWitnessForTests} from '../push/backgroundMessageNotifier';
import {
  headlessDrainAndNotify,
  configureRuntimeFromPersisted,
  persistHeadlessRuntimeConfig,
  clearHeadlessRuntimeConfig,
  HEADLESS_CONFIG_KEY,
} from '../push/headlessDrain';
import {handleHeadlessFcm} from '../push/fcmHeadless';
import type {RelayPullReport} from '../runtime/relayPullReport';
import type {LocalConversation, LocalMessage} from '../store/types';

const display = notifee.displayNotification as jest.Mock;
const cancel  = notifee.cancelNotification as jest.Mock;

const SENT_AT_ISO = '2026-07-29T08:00:00.000Z';

const flush = async () => {
  await new Promise<void>(r => setImmediate(r));
  await new Promise<void>(r => setImmediate(r));
};

function seedConfig(): void {
  mockStorage.set(HEADLESS_CONFIG_KEY, JSON.stringify({
    ownUserId: 'auth-1', ownerKey: 'owner@x', authorityPubKeyB64: 'cHViLWtleQ==',
  }));
}

/** Simulates the runtime ingesting a sealed group message during the drain. */
function ingestGroupMessage(opts: {muted?: boolean} = {}): void {
  const s = useMessengerStore.getState();
  s.upsertConversation({
    id:            'g-1',
    type:          'group',
    name:          'Ops Squad',
    participants:  ['peer-1', 'peer-2'],
    unread_count:  0,
    is_muted:      opts.muted === true,
    created_at:    '2026-07-01T00:00:00.000Z',
    peer:          {userId: '', deviceId: 0},
    session_state: 'established',
  } as LocalConversation);
  useMessengerStore.setState({groupMemberNames: {'g-1': {'peer-1': 'Alice'}}} as never);
  s.appendMessage('g-1', {
    id:              'm-1',
    conversation_id: 'g-1',
    sender_id:       'peer-1',
    type:            'text',
    content:         'the group message body',
    status:          'delivered',
    is_encrypted:    true,
    created_at:      SENT_AT_ISO,
    peer:            {userId: 'peer-1', deviceId: 1},
  } as LocalMessage);
}

beforeEach(() => {
  mockStorage.clear();
  display.mockClear();
  mockConfigureMessengerRuntime.mockClear();
  mockGetMessengerRuntime.mockClear();
  mockGetActiveOwnerKey.mockReset();
  mockGetActiveOwnerKey.mockReturnValue(null);
  // Re-seat the runtime double every test: several cases override it, and the
  // outer clear() alone leaves the last override in place for whatever runs
  // next (this file warns about that hazard twice below).
  mockGetMessengerRuntime.mockImplementation(async () =>
    ({pullEnvelopes: mockPullEnvelopes, flushAcks: mockFlushAcks}));
  mockHasDbKey.mockClear();
  mockHasDbKey.mockResolvedValue(true);
  mockPullEnvelopes.mockReset();
  mockPullEnvelopes.mockImplementation(async () => { ackOrder.push('pull'); return fullyDrained(); });
  // mockReset, not mockClear: a `mockRejectedValueOnce` left by one case would
  // otherwise fire inside the next one.
  mockFlushAcks.mockReset();
  mockFlushAcks.mockImplementation(async () => { ackOrder.push('flush'); });
  ackOrder.length = 0;
  mockRestoreActive = false;
  useMessengerStore.getState().reset();
  _resetMsgNotifStateForTest();
  _resetCueWitnessForTests();
});

afterEach(() => {
  stopBackgroundMessageNotifier();
});

describe('guards — the runtime is NEVER booted without its preconditions', () => {
  it('no persisted config → unavailable, nothing configured or booted', async () => {
    const outcome = await headlessDrainAndNotify();
    expect(outcome).toBe('unavailable');
    expect(mockConfigureMessengerRuntime).not.toHaveBeenCalled();
    expect(mockGetMessengerRuntime).not.toHaveBeenCalled();
  });

  it('RESTORE gate held → unavailable (B-107 — a wake must never disarm the restore)', async () => {
    seedConfig();
    mockRestoreActive = true;
    const outcome = await headlessDrainAndNotify();
    expect(outcome).toBe('unavailable');
    expect(mockConfigureMessengerRuntime).not.toHaveBeenCalled();
    expect(mockGetMessengerRuntime).not.toHaveBeenCalled();
  });

  it('no local identity → unavailable (Round-8 — a wake must never be the thing that keygens)', async () => {
    seedConfig();
    mockHasDbKey.mockResolvedValue(false);
    const outcome = await headlessDrainAndNotify();
    expect(outcome).toBe('unavailable');
    expect(mockHasDbKey).toHaveBeenCalledWith('owner@x');
    expect(mockConfigureMessengerRuntime).not.toHaveBeenCalled();
    expect(mockGetMessengerRuntime).not.toHaveBeenCalled();
  });

  it('an already-configured runtime is reused, not re-configured', async () => {
    seedConfig();
    mockGetActiveOwnerKey.mockReturnValue('owner@x');
    const ok = await configureRuntimeFromPersisted();
    expect(ok).toBe(true);
    expect(mockConfigureMessengerRuntime).not.toHaveBeenCalled();
  });

  it('B-703 MR-13 — a runtime configured DURING the awaits is not stomped either', async () => {
    seedConfig();
    // The entry check passes (nothing configured yet), and then everything
    // between it and the write is awaits: AsyncStorage, the keychain probe, a
    // store-hydration wait. An INTERACTIVE session configures itself inside
    // that window on every cold notification tap — it races MainNavigator by
    // construction. Writing backgroundBoot:true over it leaves the session
    // presence-'away', socket-invisible and sync-suppressed for its whole
    // life: MainNavigator does not configure again, and nothing else
    // re-asserts it, so only a process restart heals it.
    mockGetActiveOwnerKey.mockReturnValueOnce(null).mockReturnValue('owner@x');

    const ok = await configureRuntimeFromPersisted();

    expect(ok).toBe(true); // a usable runtime IS configured — a better one
    expect(mockConfigureMessengerRuntime).not.toHaveBeenCalled();
  });
});

describe('the drain — persist first, then notify fully-resolved', () => {
  it('boots from the persisted record and banners the ingested GROUP message with its real name, sender and SEND time', async () => {
    seedConfig();
    mockPullEnvelopes.mockImplementation(async () => { ingestGroupMessage(); return fullyDrained(); });

    const outcome = await headlessDrainAndNotify();
    await flush();

    expect(outcome).toBe('drained');
    const cfg = mockConfigureMessengerRuntime.mock.calls[0][0] as Record<string, unknown>;
    expect(cfg.ownUserId).toBe('auth-1');
    expect(cfg.ownerKey).toBe('owner@x');
    expect(cfg.authorityPubKeyB64).toBe('cHViLWtleQ==');
    expect(cfg.messengerBaseUrl).toBe('https://msg.test');
    expect(useMessengerStore.getState()._ownUserId).toBe('owner@x');

    const banner = display.mock.calls.map(c => c[0]).find(n => n.id === 'bravo-msg-g-1');
    expect(banner).toBeDefined();
    expect(banner.title).toBe('Ops Squad');                       // real group name, not the sender's DM
    expect(banner.android.timestamp).toBe(Date.parse(SENT_AT_ISO)); // B-323 through the drain
    expect(banner.android.style.messages[0].person.name).toBe('Alice');
    expect(banner.android.style.messages[0].text).toContain('group message body');
  });

  it('a drain that ingests nothing banner-worthy stays SILENT (kills the phantom banner for reactions/receipts)', async () => {
    seedConfig();
    const outcome = await headlessDrainAndNotify();
    await flush();
    expect(outcome).toBe('drained');
    expect(display).not.toHaveBeenCalled();
  });
});

describe('handleHeadlessFcm msg-wake — drain first, generic banner only as fallback', () => {
  it('drain success → the resolved banner posts and the generic/guess banner does NOT', async () => {
    seedConfig();
    mockPullEnvelopes.mockImplementation(async () => { ingestGroupMessage(); return fullyDrained(); });

    await handleHeadlessFcm({data: {kind: 'msg-wake', senderUserId: 'peer-1'}} as never);
    await flush();

    const ids = display.mock.calls.map(c => c[0].id as string);
    expect(ids).toContain('bravo-msg-g-1');
    expect(ids).not.toContain('bravo-msg-sender:peer-1'); // no sender-keyed generic
  });

  it('drain unavailable → falls back to today\'s guess banner (fail-open pin)', async () => {
    // No persisted config; persisted vault knows the sender's DM (the guess).
    mockStorage.set('messenger-store-v1', JSON.stringify({
      state: {_ownUserId: 'owner@x', vaultByOwner: {'owner@x': {conversations: {
        'direct:peer-1': {type: 'direct', peer: {userId: 'peer-1'}, name: 'Alice'},
      }}}},
      version: 0,
    }));

    await handleHeadlessFcm({data: {kind: 'msg-wake', senderUserId: 'peer-1'}} as never);
    await flush();

    expect(mockGetMessengerRuntime).not.toHaveBeenCalled();
    const ids = display.mock.calls.map(c => c[0].id as string);
    // B-710 — the fail-open intent is unchanged (a banner IS drawn), but the
    // guess no longer keys it: a content-free draw on `bravo-msg-direct:peer-1`
    // would replace that DM's rich card in the shade. The guess still rides in
    // `data.conversationId` for the tap.
    expect(ids).toContain('bravo-msg-sender:peer-1');
    const drawn = display.mock.calls.find(c => c[0].id === 'bravo-msg-sender:peer-1')![0];
    expect(drawn.data.conversationId).toBe('direct:peer-1');
    expect(drawn.data.convGuess).toBe('1');
  });

  it('drain failure → falls back too (the drain may never make the killed path worse)', async () => {
    seedConfig();
    mockGetMessengerRuntime.mockRejectedValue(new Error('boot exploded'));

    await handleHeadlessFcm({data: {kind: 'msg-wake', senderUserId: 'peer-1'}} as never);
    await flush();

    expect(display).toHaveBeenCalled(); // generic sender-keyed fallback still posts
    const ids = display.mock.calls.map(c => c[0].id as string);
    expect(ids).toContain('bravo-msg-sender:peer-1');
  });
});

describe('B-692 NL-1 — the silent "checking" placeholder rides the drain', () => {
  beforeEach(() => {
    cancel.mockClear();
    // The 'drain failure' test above leaves a mockRejectedValue on the runtime
    // getter, and the outer beforeEach only mockClear()s (calls, not impl) —
    // restore the working boot or every test here silently exercises the
    // FALLBACK lane instead of the drained one.
    mockGetMessengerRuntime.mockImplementation(async () => ({pullEnvelopes: mockPullEnvelopes, flushAcks: mockFlushAcks}));
  });

  it('drained wake with a real message: placeholder shows first, the named banner posts, the placeholder is cancelled', async () => {
    seedConfig();
    mockPullEnvelopes.mockImplementation(async () => { ingestGroupMessage(); return fullyDrained(); });

    await handleHeadlessFcm({data: {kind: 'msg-wake', senderUserId: 'peer-1'}} as never);
    await flush();

    const ids = display.mock.calls.map(c => c[0].id as string);
    // Instant shade presence BEFORE the boot+pull can possibly complete.
    expect(ids[0]).toBe('bravo-msg-pending');
    expect(ids).toContain('bravo-msg-g-1');
    expect(cancel).toHaveBeenCalledWith('bravo-msg-pending');
  });

  it('a receipt/reaction wake (drained, nothing banner-worthy) leaves NO phantom — the placeholder is cancelled', async () => {
    seedConfig();
    // Pull ingests nothing — the P2-BR-3 receipt/reaction shape. The old
    // model showed nothing (good) but also nothing DURING the drain; the
    // placeholder must appear and then be fully retired, never linger.
    await handleHeadlessFcm({data: {kind: 'msg-wake', senderUserId: 'peer-1'}} as never);
    await flush();

    const ids = display.mock.calls.map(c => c[0].id as string);
    expect(ids).toEqual(['bravo-msg-pending']); // only the silent placeholder ever showed
    expect(cancel).toHaveBeenCalledWith('bravo-msg-pending');
  });

  it('the placeholder is SILENT by construction: LOW-importance dedicated channel, never the messages channel', async () => {
    seedConfig();
    await handleHeadlessFcm({data: {kind: 'msg-wake', senderUserId: 'peer-1'}} as never);
    await flush();

    const pending = display.mock.calls.map(c => c[0]).find(n => n.id === 'bravo-msg-pending');
    expect(pending).toBeDefined();
    expect(pending.android.channelId).toBe('bravo-messages-pending');
    expect(pending.android.importance).toBe(2); // AndroidImportance.LOW — no sound, no heads-up
    expect(pending.body).toBe('Checking for new messages…');
  });
});

describe('B-703 MR-1 — "drained" must mean INGESTED, not merely "the pull resolved"', () => {
  beforeEach(() => {
    cancel.mockClear();
    // Same restore as the block above: an earlier mockRejectedValue would send
    // every case down the fallback lane and pass for the wrong reason.
    mockGetMessengerRuntime.mockImplementation(async () => ({pullEnvelopes: mockPullEnvelopes, flushAcks: mockFlushAcks}));
  });

  it('envelopes left ON THE RELAY report incomplete — the B-701 identity-regen / transient-sql shape', async () => {
    seedConfig();
    // The live case: the pull succeeded, but every envelope took a
    // leave-on-relay `continue` and was never ingested. pullEnvelopes swallows
    // that entirely, so this used to be indistinguishable from success.
    mockPullEnvelopes.mockImplementation(async () => leftOnRelay(2));

    expect(await headlessDrainAndNotify()).toBe('incomplete');
  });

  it('a pull that FAILED reports failed (pullEnvelopes never throws — it reports)', async () => {
    seedConfig();
    mockPullEnvelopes.mockImplementation(async () => ({
      ok: false, pulled: 0, acked: 0, skipped: 0, leftOnRelay: 0,
    }));

    expect(await headlessDrainAndNotify()).toBe('failed');
  });

  it('a runtime with NO pullEnvelopes reports failed, not drained', async () => {
    seedConfig();
    mockGetMessengerRuntime.mockImplementation(async () => ({} as never));

    expect(await headlessDrainAndNotify()).toBe('failed');
  });

  it('THE FOUNDER SYMPTOM: a wake whose envelopes stayed on the relay still banners, and retires the placeholder', async () => {
    seedConfig();
    mockPullEnvelopes.mockImplementation(async () => leftOnRelay(1));

    await handleHeadlessFcm({data: {kind: 'msg-wake', senderUserId: 'peer-1'}} as never);
    await flush();

    const ids = display.mock.calls.map(c => c[0].id as string);
    expect(ids[0]).toBe('bravo-msg-pending');            // the placeholder still leads
    expect(ids).toContain('bravo-msg-sender:peer-1');    // ...and a real banner FOLLOWS it
    expect(cancel).toHaveBeenCalledWith('bravo-msg-pending');
  });

  it('CRITIC G1: a silently-acked envelope beside a stuck one still banners', async () => {
    seedConfig();
    // The compound that defeated the first cut: the leave-on-relay path sends a
    // rehandshake nudge, which acks without ever reaching the notifier. One
    // wake, nothing shown, the real message still on the relay.
    mockPullEnvelopes.mockImplementation(async () => ({
      ok: true, pulled: 2, acked: 1, skipped: 0, leftOnRelay: 1,
    }));

    await handleHeadlessFcm({data: {kind: 'msg-wake', senderUserId: 'peer-1'}} as never);
    await flush();

    const ids = display.mock.calls.map(c => c[0].id as string);
    expect(ids).toContain('bravo-msg-sender:peer-1');
  });

  it('a muted thread whose drain finished CLEANLY stays silent', async () => {
    seedConfig();
    mockPullEnvelopes.mockImplementation(async () => {
      ingestGroupMessage({muted: true});
      return fullyDrained();
    });

    await handleHeadlessFcm({data: {kind: 'msg-wake', senderUserId: 'peer-1'}} as never);
    await flush();

    expect(display.mock.calls.map(c => c[0].id as string)).toEqual(['bravo-msg-pending']);
    expect(cancel).toHaveBeenCalledWith('bravo-msg-pending');
  });

  it('but a muted thread with something STILL STUCK banners — P2-BR-5 house trade', async () => {
    seedConfig();
    // Deliberate. Precisely: this wake carries NO conversationId (the server
    // cannot supply one under sealed sender), so the fallback's mute gate does
    // not apply — the AMBIGUOUS case, which is exactly the trade P2-BR-5
    // documents. 'incomplete' means a real envelope is un-ingested and may
    // belong to a DIFFERENT, unmuted thread, so a generic banner beats a drop.
    // A wake that DID name a muted conversation would still be suppressed.
    mockPullEnvelopes.mockImplementation(async () => {
      ingestGroupMessage({muted: true});
      return leftOnRelay(1);
    });

    await handleHeadlessFcm({data: {kind: 'msg-wake', senderUserId: 'peer-1'}} as never);
    await flush();

    expect(display.mock.calls.map(c => c[0].id as string)).toContain('bravo-msg-sender:peer-1');
  });

  it('CRITIC H1: boot hydration replaying an OWN row must not silence the wake', async () => {
    seedConfig();
    // A fresh headless VM starts with `messages` EMPTY — they live in
    // SQLCipher, not the persisted vault — so the runtime's own hydration
    // replays history through the notifier. A thread whose only row the user
    // sent produces a deliberate withhold. Keying suppression on that silenced
    // the FIRST wake of every VM: the killed-app case itself.
    mockPullEnvelopes.mockImplementation(async () => {
      const s = useMessengerStore.getState();
      s.upsertConversation({
        id: 'c-own', type: 'direct', name: 'Ranak', participants: ['peer-9'],
        unread_count: 0, is_muted: false, created_at: '2026-07-01T00:00:00.000Z',
        peer: {userId: 'peer-9', deviceId: 1}, session_state: 'established',
      } as LocalConversation);
      s.appendMessage('c-own', {
        id: 'own-1', conversation_id: 'c-own', sender_id: 'self', type: 'text',
        content: 'my only message', status: 'sent', is_encrypted: true,
        created_at: SENT_AT_ISO, peer: {userId: 'peer-9', deviceId: 1},
      } as LocalMessage);
      return leftOnRelay(1);
    });

    await handleHeadlessFcm({data: {kind: 'msg-wake', senderUserId: 'peer-1'}} as never);
    await flush();

    expect(display.mock.calls.map(c => c[0].id as string)).toContain('bravo-msg-sender:peer-1');
  });

  it('but an incomplete drain that ALREADY bannered does not add a generic one (no downgrade, no 10s gag)', async () => {
    seedConfig();
    // The concurrent case: this drain ingested nothing (its one envelope stayed
    // on the relay), but the live WS lane committed and bannered a message in
    // the same window. A generic wake banner on top would collapse onto the
    // named card's id for a 1:1 and, either way, arm the GLOBAL 10 s
    // alert-collapse window for nothing.
    mockPullEnvelopes.mockImplementation(async () => {
      ingestGroupMessage();
      return leftOnRelay(1);
    });

    await handleHeadlessFcm({data: {kind: 'msg-wake', senderUserId: 'peer-1'}} as never);
    await flush();

    const ids = display.mock.calls.map(c => c[0].id as string);
    expect(ids).toContain('bravo-msg-g-1');
    expect(ids).not.toContain('bravo-msg-sender:peer-1');
    expect(cancel).toHaveBeenCalledWith('bravo-msg-pending');
  });

  it('B-703 MR-19 — a banner that FAILED to draw does not suppress the generic fallback', async () => {
    seedConfig();
    // Same shape as the case above — the drain banners, its envelope stays on
    // the relay — except the display is refused. The old test read a bare
    // `messagePostedGeneration` delta, which moves identically whether the
    // shade got the banner or notifee threw it away, so the user ended up with
    // NOTHING: no named card, and no fallback either.
    display.mockImplementation(async (n: {id?: string}) =>
      n.id === 'bravo-msg-g-1' ? Promise.reject(new Error('display refused')) : 'nid');
    mockPullEnvelopes.mockImplementation(async () => {
      ingestGroupMessage();
      return leftOnRelay(1);
    });

    await handleHeadlessFcm({data: {kind: 'msg-wake', senderUserId: 'peer-1'}} as never);
    await flush();

    expect(display.mock.calls.map(c => c[0].id as string)).toContain('bravo-msg-sender:peer-1');
  });

  it('a fully drained receipt/reaction wake is still silent (P2-BR-3 stays fixed)', async () => {
    seedConfig();
    mockPullEnvelopes.mockImplementation(async () => fullyDrained());

    await handleHeadlessFcm({data: {kind: 'msg-wake', senderUserId: 'peer-1'}} as never);
    await flush();

    const ids = display.mock.calls.map(c => c[0].id as string);
    expect(ids).toEqual(['bravo-msg-pending']);
    expect(cancel).toHaveBeenCalledWith('bravo-msg-pending');
  });
});

describe('B-703 MR-5 — the killed lane WAITS for its relay acks', () => {
  beforeEach(() => {
    mockGetMessengerRuntime.mockImplementation(async () =>
      ({pullEnvelopes: mockPullEnvelopes, flushAcks: mockFlushAcks}));
  });

  it('does NOT resolve until the flush settles — the freeze lands the moment we return', async () => {
    seedConfig();
    // The contract is the AWAIT, and only a deferred flush can prove it: a mock
    // that resolves synchronously records the same call order either way, so an
    // ordering assertion alone is decorative here.
    let release: (() => void) | null = null;
    mockFlushAcks.mockImplementationOnce(
      () => new Promise<void>(r => { release = () => r(); }),
    );

    let settled = false;
    const p = headlessDrainAndNotify().then(v => { settled = true; return v; });
    // configureRuntimeFromPersisted waits up to 3 s for store hydration (it
    // never hydrates under jest), so poll for the call rather than guessing a
    // tick count.
    const t0 = Date.now();
    while (release === null && Date.now() - t0 < 10_000) {
      await new Promise(r => setTimeout(r, 10));
    }
    expect(release).not.toBeNull();
    expect(settled).toBe(false);   // still holding the task open for the ack POST
    (release as unknown as () => void)();
    expect(await p).toBe('drained');
    expect(settled).toBe(true);
  }, 20_000);

  it('flushes AFTER the pull — an earlier flush would ship an empty batch', async () => {
    seedConfig();
    await headlessDrainAndNotify();
    expect(ackOrder).toEqual(['pull', 'flush']);
    expect(mockFlushAcks).toHaveBeenCalledTimes(1);
  });

  it('flushes even when the drain was INCOMPLETE — partial acks still owe delivery', async () => {
    seedConfig();
    mockPullEnvelopes.mockImplementation(async () => leftOnRelay(1));
    expect(await headlessDrainAndNotify()).toBe('incomplete');
    expect(mockFlushAcks).toHaveBeenCalledTimes(1);
  });

  it('a flush failure never changes the verdict (the relay redelivers)', async () => {
    seedConfig();
    mockFlushAcks.mockRejectedValueOnce(new Error('network down'));
    // Exact, not a superset: the flush is classified AFTER the verdict and
    // swallowed by flushAcksBounded, so a failed ack POST may not demote a
    // fully-drained wake to 'failed' (that would be MR-1's bug, inverted).
    expect(await headlessDrainAndNotify()).toBe('drained');
  });

  it('a flush that HANGS cannot burn the notify budget', async () => {
    seedConfig();
    // The ack queue's 429 arm sleeps 10 s inside its own run, and a batchless
    // relay acks serially — waiting for either would push the wake past its
    // 8 s budget and post the generic fallback for a thread that drained fine
    // (and, muted or not, that banner cannot be muted). Bounded instead.
    mockFlushAcks.mockImplementationOnce(() => new Promise<void>(() => { /* never settles */ }));
    const t0 = Date.now();
    expect(await headlessDrainAndNotify()).toBe('drained');
    expect(Date.now() - t0).toBeLessThan(8000);
  }, 20_000);

  it('a runtime with no flushAcks still drains, and says so', async () => {
    seedConfig();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockGetMessengerRuntime.mockImplementation(async () => ({pullEnvelopes: mockPullEnvelopes} as never));
    try {
      expect(await headlessDrainAndNotify()).toBe('drained');
      // A stuck tick is otherwise a silent symptom — leave a breadcrumb.
      expect(warn.mock.calls.flat().join(' ')).toContain('no flushAcks');
    } finally { warn.mockRestore(); }
  });
});

describe('config record lifecycle', () => {
  it('persist + clear round-trip', async () => {
    await persistHeadlessRuntimeConfig({ownUserId: 'auth-1', ownerKey: 'owner@x', authorityPubKeyB64: 'cHViLWtleQ=='});
    expect(mockStorage.get(HEADLESS_CONFIG_KEY)).toContain('owner@x');
    await clearHeadlessRuntimeConfig();
    expect(mockStorage.has(HEADLESS_CONFIG_KEY)).toBe(false);
  });

  it('MainNavigator persists the record with the SAME ids it configures the runtime with', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'navigation', 'MainNavigator.tsx'), 'utf8');
    const cfgAt = src.indexOf('configureMessengerRuntime({');
    expect(cfgAt).toBeGreaterThan(-1);
    const persistAt = src.indexOf('persistHeadlessRuntimeConfig({', cfgAt);
    expect(persistAt).toBeGreaterThan(cfgAt); // written right after the runtime config
    const call = src.slice(persistAt, persistAt + 200);
    expect(call).toContain('ownUserId');
    expect(call).toContain('ownerKey');
  });

  it('signOut clears the record (a wake after logout must not boot the runtime)', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'store', 'authStore.ts'), 'utf8');
    expect(src).toContain('clearHeadlessRuntimeConfig');
  });
});
