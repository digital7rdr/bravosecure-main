/**
 * sqa.md bug register — this suite pins: B-411 (flag persistence half).
 *
 * `upsertConversation` is a REPLACE, not a merge (B-247), and the
 * /conversations/mine sync rebuilds rows from an explicit field list on
 * every Home focus — so without stickiness the `name_source` flag written
 * by the name sweeps would be wiped within one Home visit and the
 * "· Unsaved" tag would silently die (doc §1c.1, critic round-1 BLOCKER).
 *
 * Rule pinned here: a flagless upsert keeps the previous flag ONLY when the
 * name is unchanged; a flagless rename clears it; an explicit flag wins.
 */

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

import {useMessengerStore} from '../store/messengerStore';
import {directPlaceholderConversation} from '../store/messengerStore';
import type {LocalConversation} from '../store/types';

const PEER = 'c700ccde-1234-5678-9abc-def012345678';
const CONV = `direct:${PEER}`;

function row(overrides: Partial<LocalConversation>): LocalConversation {
  return {
    id:            CONV,
    type:          'direct',
    name:          'John Doe',
    participants:  [PEER],
    peer:          {userId: PEER, deviceId: 1},
    session_state: 'established',
    unread_count:  0,
    is_muted:      false,
    created_at:    '2026-08-09T00:00:00.000Z',
    ...overrides,
  } as LocalConversation;
}

beforeEach(() => {
  useMessengerStore.setState({
    conversations: {}, conversationOrder: [],
  } as never, false);
});

describe('name_source stickiness (B-411)', () => {
  it('a flagless same-name rebuild keeps the flag (the /conversations/mine sync shape)', () => {
    const s = useMessengerStore.getState();
    s.upsertConversation(row({name_source: 'profile'}));
    s.upsertConversation(row({}));
    expect(useMessengerStore.getState().conversations[CONV].name_source).toBe('profile');
  });

  it('a flagless RENAME clears the flag (unknown provenance must not inherit a tag)', () => {
    const s = useMessengerStore.getState();
    s.upsertConversation(row({name_source: 'profile'}));
    s.upsertConversation(row({name: 'Someone Else'}));
    expect(useMessengerStore.getState().conversations[CONV].name_source).toBeUndefined();
  });

  it('an explicit incoming flag always wins', () => {
    const s = useMessengerStore.getState();
    s.upsertConversation(row({name_source: 'profile'}));
    s.upsertConversation(row({name: 'John D.', name_source: 'contact'}));
    expect(useMessengerStore.getState().conversations[CONV].name_source).toBe('contact');
  });

  it('a brand-new row carries exactly what it was given', () => {
    const s = useMessengerStore.getState();
    s.upsertConversation(row({name_source: 'contact'}));
    expect(useMessengerStore.getState().conversations[CONV].name_source).toBe('contact');
    s.upsertConversation(row({id: 'direct:other', name_source: undefined} as never));
    expect(useMessengerStore.getState().conversations['direct:other'].name_source).toBeUndefined();
  });

  it("directPlaceholderConversation stamps 'placeholder' (covers callDispatcher + MainNavigator mints)", () => {
    const c = directPlaceholderConversation(CONV, PEER, {userId: PEER, deviceId: 1}, '2026-08-09T00:00:00.000Z');
    expect(c.name_source).toBe('placeholder');
    expect(c.name).toBe(`Bravo · ${PEER.slice(0, 8)}`);
  });
});
