/**
 * B-117 - per-user typing state (named group typing bubbles).
 *
 * Pins: the per-user map and the legacy boolean aggregate can never
 * disagree; an inbound message clears ONLY the sender's entry (another
 * member may still be composing); a blanket setTyping(false) clears the
 * whole set.
 */

const mockStore = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem:    async (k: string) => mockStore.get(k) ?? null,
    setItem:    async (k: string, v: string) => { mockStore.set(k, v); },
    removeItem: async (k: string) => { mockStore.delete(k); },
  },
}));

import {useMessengerStore} from '../store/messengerStore';
import type {LocalMessage} from '../store/types';

const CONV = 'group-conv-1';

function inbound(sender: string, id: string): LocalMessage {
  return {
    id,
    sender_id: sender,
    body: 'x',
    created_at: new Date().toISOString(),
    status: 'delivered',
    peer: {userId: sender, deviceId: 1},
  } as unknown as LocalMessage;
}

beforeEach(() => {
  useMessengerStore.getState().reset();
});

describe('setTypingUser (B-117)', () => {
  it('tracks multiple typers and derives the boolean aggregate', () => {
    const s = useMessengerStore.getState();
    s.setTypingUser(CONV, 'alice', true);
    s.setTypingUser(CONV, 'bob', true);
    let st = useMessengerStore.getState();
    expect(Object.keys(st.typingUsers[CONV] ?? {}).sort()).toEqual(['alice', 'bob']);
    expect(st.typing[CONV]).toBe(true);

    s.setTypingUser(CONV, 'alice', false);
    st = useMessengerStore.getState();
    expect(Object.keys(st.typingUsers[CONV] ?? {})).toEqual(['bob']);
    expect(st.typing[CONV]).toBe(true);

    s.setTypingUser(CONV, 'bob', false);
    st = useMessengerStore.getState();
    expect(st.typingUsers[CONV]).toBeUndefined();
    expect(st.typing[CONV]).toBe(false);
  });

  it('an inbound message clears only the SENDER entry', () => {
    const s = useMessengerStore.getState();
    s.setTypingUser(CONV, 'alice', true);
    s.setTypingUser(CONV, 'bob', true);
    s.appendMessage(CONV, inbound('alice', 'm1'));
    const st = useMessengerStore.getState();
    expect(st.typingUsers[CONV]?.alice).toBeUndefined();
    expect(st.typingUsers[CONV]?.bob).toBe(true);
    expect(st.typing[CONV]).toBe(true);
  });

  it('blanket setTyping(false) clears the per-user set (legacy path)', () => {
    const s = useMessengerStore.getState();
    s.setTypingUser(CONV, 'alice', true);
    s.setTyping(CONV, false);
    const st = useMessengerStore.getState();
    expect(st.typingUsers[CONV]).toBeUndefined();
    expect(st.typing[CONV]).toBe(false);
  });
});
