// Mock AsyncStorage before the store loads — the persist middleware in
// `messengerStore.ts` calls into it on every set, and the RN package
// references `window.localStorage` which is undefined under Node.
jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem:    async (k: string) => store.get(k) ?? null,
      setItem:    async (k: string, v: string) => { store.set(k, v); },
      removeItem: async (k: string) => { store.delete(k); },
      clear:      async () => { store.clear(); },
    },
  };
});

import {ExpirySweeper} from '../runtime/expirySweeper';
import {useMessengerStore} from '../store/messengerStore';
import type {LocalMessage} from '../store/types';

/**
 * Disappearing-message + retract + conversation-clear paths must drop
 * any cached attachment blobs alongside the message itself. These
 * tests exercise the wiring in isolation by spying on the
 * `purgeBlob` / `retract` callbacks the runtime injects into the
 * sweeper, without standing up a real MediaBlobCache or SQLCipher
 * store. Coverage:
 *
 *   1. Expiry of a media message fires purgeBlob exactly once with
 *      the right object key, AND removes the bubble.
 *   2. Expiry of a non-media message DOES NOT fire purgeBlob.
 *   3. A purgeBlob failure is non-fatal — the bubble still gets
 *      removed and the sweeper completes its loop.
 *   4. Retract + purgeBlob fire in parallel for sender-side messages
 *      that carry both a token and an object key.
 *   5. Multiple expired media messages → each gets a distinct
 *      purgeBlob call.
 *
 * Tests reset the Zustand store before each case so cross-test bleed
 * (Zustand is a module singleton) doesn't poison expectations.
 */

function mediaMessage(overrides: Partial<LocalMessage> = {}): LocalMessage {
  return {
    id:               'm-' + Math.random().toString(16).slice(2),
    conversation_id:  'c1',
    sender_id:        'self',
    type:             'file',
    content:          '',
    media_mime:       'image/jpeg',
    media_object_key: 'media/abc-123',
    status:           'sent',
    is_encrypted:     true,
    created_at:       new Date().toISOString(),
    peer:             {userId: 'bob', deviceId: 1},
    expires_at:       Date.now() - 1_000, // already expired
    ...overrides,
  };
}

beforeEach(() => {
  useMessengerStore.getState().reset();
});

describe('ExpirySweeper — cache purge wiring', () => {
  it('fires purgeBlob with the message object key when an attachment expires', async () => {
    const purgeBlob = jest.fn().mockResolvedValue(undefined);
    const msg = mediaMessage({media_object_key: 'media/photo-42'});
    useMessengerStore.getState().appendMessage('c1', msg);

    const sweeper = new ExpirySweeper({purgeBlob});
    const purged = sweeper.sweep();

    expect(purged).toBe(1);
    expect(purgeBlob).toHaveBeenCalledTimes(1);
    expect(purgeBlob).toHaveBeenCalledWith('media/photo-42');
    // Bubble is gone from the store regardless of cache outcome.
    expect(useMessengerStore.getState().messages.c1).toEqual([]);
  });

  it('does not fire purgeBlob when the expired message has no attachment', async () => {
    const purgeBlob = jest.fn();
    useMessengerStore.getState().appendMessage('c1', mediaMessage({
      type: 'text', media_mime: undefined, media_object_key: undefined,
    }));

    const sweeper = new ExpirySweeper({purgeBlob});
    sweeper.sweep();

    expect(purgeBlob).not.toHaveBeenCalled();
  });

  it('non-fatal on purgeBlob rejection — bubble still removed, sweep returns count', async () => {
    const purgeBlob = jest.fn().mockRejectedValue(new Error('cache offline'));
    useMessengerStore.getState().appendMessage('c1', mediaMessage());

    const sweeper = new ExpirySweeper({purgeBlob});
    const purged = sweeper.sweep();

    expect(purged).toBe(1);
    expect(useMessengerStore.getState().messages.c1).toEqual([]);
    // Allow the swallowed promise to settle so jest doesn't flag an
    // unhandled rejection on subsequent suites.
    await new Promise(r => setTimeout(r, 0));
  });

  it('fires retract AND purgeBlob in parallel for self messages with both', async () => {
    const purgeBlob = jest.fn().mockResolvedValue(undefined);
    const retract   = jest.fn().mockResolvedValue(undefined);
    const msg = mediaMessage({
      sender_id:        'self',
      retract_token:    'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      media_object_key: 'media/voice-7',
    });
    useMessengerStore.getState().appendMessage('c1', msg);

    new ExpirySweeper({retract, purgeBlob}).sweep();

    expect(retract).toHaveBeenCalledWith('aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa');
    expect(purgeBlob).toHaveBeenCalledWith('media/voice-7');
  });

  it('purges every distinct object key when multiple media messages expire at once', async () => {
    const purgeBlob = jest.fn().mockResolvedValue(undefined);
    useMessengerStore.getState().appendMessage('c1', mediaMessage({media_object_key: 'media/a'}));
    useMessengerStore.getState().appendMessage('c1', mediaMessage({media_object_key: 'media/b'}));
    useMessengerStore.getState().appendMessage('c2', mediaMessage({media_object_key: 'media/c'}));

    const purged = new ExpirySweeper({purgeBlob}).sweep();

    expect(purged).toBe(3);
    const calls = purgeBlob.mock.calls.map(c => c[0]);
    expect(calls.sort()).toEqual(['media/a', 'media/b', 'media/c']);
  });

  it('skips messages that have not expired yet', async () => {
    const purgeBlob = jest.fn();
    useMessengerStore.getState().appendMessage('c1', mediaMessage({
      expires_at: Date.now() + 60_000,
    }));

    const purged = new ExpirySweeper({purgeBlob}).sweep();

    expect(purged).toBe(0);
    expect(purgeBlob).not.toHaveBeenCalled();
    expect(useMessengerStore.getState().messages.c1?.length).toBe(1);
  });
});
