/**
 * Cross-conversation derived selectors on messengerStore — `selectCallMessages`,
 * `selectMediaMessages`, `selectLastMessageByConv` — plus the two id-scoped
 * selectors (`selectMessages` / `selectConversation`) and the EMPTY_MESSAGES
 * singleton.
 *
 * These three power CallsLogScreen, FilesScreen and GroupsScreen. Before this
 * suite NOTHING executed them: they were reachable only through a React render,
 * so their filter predicates, their newest-first sort, and — most importantly —
 * their WeakMap memoisation contract were entirely unpinned.
 *
 * What is pinned here:
 *   - the FILTER of each selector, including the branches that exclude
 *     (a `type:'call'` row with no `call_meta`, a plain text row)
 *   - Audit MSG-13: 'video' belongs in the media set. It was omitted once and
 *     videos vanished from the per-chat media surface — a regression a text
 *     scan cannot see, because the fix is one token inside a boolean.
 *   - the memoisation contract itself: SAME `s.messages` reference ⇒ the SAME
 *     array instance (the whole point — consumers wrap these in `useShallow`
 *     and a fresh array every call defeats that); a MUTATED store ⇒ a fresh
 *     computation. If someone drops the WeakMap the identity assertion goes red.
 *   - the returned arrays are frozen, so a consumer cannot corrupt the cache
 *     that every other screen shares.
 *   - EMPTY_MESSAGES is ONE frozen reference (React 18 "Maximum update depth"
 *     guard — a fresh `[]` per render loops the screen).
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

import {
  useMessengerStore,
  selectCallMessages,
  selectMediaMessages,
  selectLastMessageByConv,
  selectMessages,
  selectConversation,
  EMPTY_MESSAGES,
} from '../store/messengerStore';
import type {LocalConversation, LocalMessage} from '../store/types';

const PEER = 'peer-uuid';

function msg(over: Partial<LocalMessage> & {id: string; created_at: string}): LocalMessage {
  return {
    conversation_id: 'c1',
    sender_id:       PEER,
    type:            'text',
    content:         'hi',
    status:          'delivered',
    is_encrypted:    true,
    peer:            {userId: PEER, deviceId: 1},
    ...over,
  } as LocalMessage;
}

function convo(id: string, over: Partial<LocalConversation> = {}): LocalConversation {
  return {
    id,
    type:          'direct',
    name:          id,
    participants:  [PEER],
    unread_count:  0,
    is_muted:      false,
    created_at:    '2026-08-01T00:00:00.000Z',
    peer:          {userId: PEER, deviceId: 1},
    session_state: 'established',
    ...over,
  } as LocalConversation;
}

const callMeta = (over: Partial<NonNullable<LocalMessage['call_meta']>> = {}) => ({
  kind:      'voice' as const,
  direction: 'incoming' as const,
  outcome:   'answered' as const,
  duration:  12,
  ...over,
});

beforeEach(() => {
  useMessengerStore.getState().reset();
});

describe('selectCallMessages — CallsLogScreen fold', () => {
  it('collects call rows across EVERY conversation, newest first', () => {
    const s = useMessengerStore.getState();
    s.hydrateMessages({
      a: [
        msg({id: 'a-old', created_at: '2026-08-01T10:00:00.000Z', type: 'call', call_meta: callMeta()}),
        msg({id: 'a-txt', created_at: '2026-08-01T11:00:00.000Z'}),
      ],
      b: [
        msg({id: 'b-new', created_at: '2026-08-01T12:00:00.000Z', type: 'call', call_meta: callMeta({direction: 'outgoing'})}),
      ],
    });

    const rows = selectCallMessages(useMessengerStore.getState());
    expect(rows.map(m => m.id)).toEqual(['b-new', 'a-old']);
  });

  it('excludes a call-typed row that carries no call_meta (unrenderable)', () => {
    const s = useMessengerStore.getState();
    s.hydrateMessages({
      a: [
        msg({id: 'no-meta', created_at: '2026-08-01T10:00:00.000Z', type: 'call'}),
        msg({id: 'good',    created_at: '2026-08-01T09:00:00.000Z', type: 'call', call_meta: callMeta()}),
      ],
    });

    expect(selectCallMessages(useMessengerStore.getState()).map(m => m.id)).toEqual(['good']);
  });

  it('returns the SAME array instance while `messages` is untouched, a NEW one after a mutation', () => {
    const s = useMessengerStore.getState();
    s.hydrateMessages({
      a: [msg({id: 'c1', created_at: '2026-08-01T10:00:00.000Z', type: 'call', call_meta: callMeta()})],
    });

    const first  = selectCallMessages(useMessengerStore.getState());
    const second = selectCallMessages(useMessengerStore.getState());
    // The memoisation contract: consumers use `useShallow` over this, and a
    // freshly-allocated array on every call re-renders CallsLog on every store
    // touch anywhere in the app.
    expect(second).toBe(first);

    useMessengerStore.getState().appendMessage('a', msg({
      id: 'c2', conversation_id: 'a', created_at: '2026-08-01T11:00:00.000Z',
      type: 'call', call_meta: callMeta(),
    }));

    const third = selectCallMessages(useMessengerStore.getState());
    expect(third).not.toBe(first);
    expect(third.map(m => m.id)).toEqual(['c2', 'c1']);
  });

  it('hands back a FROZEN array so one consumer cannot corrupt the shared cache', () => {
    useMessengerStore.getState().hydrateMessages({
      a: [msg({id: 'c1', created_at: '2026-08-01T10:00:00.000Z', type: 'call', call_meta: callMeta()})],
    });
    const rows = selectCallMessages(useMessengerStore.getState());
    expect(Object.isFrozen(rows)).toBe(true);
  });

  it('is empty (not undefined) when no call has ever happened', () => {
    expect(selectCallMessages(useMessengerStore.getState())).toEqual([]);
  });
});

describe('selectMediaMessages — FilesScreen fold', () => {
  it('includes image, audio, video and file — and excludes text/call', () => {
    useMessengerStore.getState().hydrateMessages({
      a: [
        msg({id: 'img',   created_at: '2026-08-01T01:00:00.000Z', type: 'image'}),
        msg({id: 'aud',   created_at: '2026-08-01T02:00:00.000Z', type: 'audio'}),
        msg({id: 'vid',   created_at: '2026-08-01T03:00:00.000Z', type: 'video'}),
        msg({id: 'doc',   created_at: '2026-08-01T04:00:00.000Z', type: 'file'}),
        msg({id: 'txt',   created_at: '2026-08-01T05:00:00.000Z', type: 'text'}),
        msg({id: 'call',  created_at: '2026-08-01T06:00:00.000Z', type: 'call', call_meta: callMeta()}),
      ],
    });

    const ids = selectMediaMessages(useMessengerStore.getState()).map(m => m.id);
    // Newest-first.
    expect(ids).toEqual(['doc', 'vid', 'aud', 'img']);
  });

  it("MSG-13 — 'video' is in the media set (its omission hid every video)", () => {
    useMessengerStore.getState().hydrateMessages({
      a: [msg({id: 'vid', created_at: '2026-08-01T03:00:00.000Z', type: 'video'})],
    });
    expect(selectMediaMessages(useMessengerStore.getState()).map(m => m.id)).toEqual(['vid']);
  });

  it('memoises on the live `messages` reference and re-folds after an append', () => {
    useMessengerStore.getState().hydrateMessages({
      a: [msg({id: 'img', created_at: '2026-08-01T01:00:00.000Z', type: 'image'})],
    });
    const first = selectMediaMessages(useMessengerStore.getState());
    expect(selectMediaMessages(useMessengerStore.getState())).toBe(first);

    useMessengerStore.getState().appendMessage('a', msg({
      id: 'vid2', conversation_id: 'a', created_at: '2026-08-01T07:00:00.000Z', type: 'video',
    }));
    const next = selectMediaMessages(useMessengerStore.getState());
    expect(next).not.toBe(first);
    expect(next.map(m => m.id)).toEqual(['vid2', 'img']);
    expect(Object.isFrozen(next)).toBe(true);
  });
});

describe('selectLastMessageByConv — GroupsScreen preview + sort key', () => {
  it('maps each conversation to its LAST row and skips empty lists', () => {
    useMessengerStore.getState().hydrateMessages({
      a: [
        msg({id: 'a1', created_at: '2026-08-01T01:00:00.000Z'}),
        msg({id: 'a2', created_at: '2026-08-01T02:00:00.000Z'}),
      ],
      b: [msg({id: 'b1', created_at: '2026-08-01T03:00:00.000Z'})],
      c: [],
    });

    const map = selectLastMessageByConv(useMessengerStore.getState());
    expect(map.a?.id).toBe('a2');
    expect(map.b?.id).toBe('b1');
    // An empty conversation must not appear at all — a `{c: undefined}` entry
    // would make `Object.keys(map)` lie to the screen.
    expect('c' in map).toBe(false);
  });

  it('memoises per messages-map identity and refreshes when a chat gets a newer row', () => {
    useMessengerStore.getState().hydrateMessages({
      a: [msg({id: 'a1', created_at: '2026-08-01T01:00:00.000Z'})],
    });
    const first = selectLastMessageByConv(useMessengerStore.getState());
    expect(selectLastMessageByConv(useMessengerStore.getState())).toBe(first);
    expect(first.a?.id).toBe('a1');

    useMessengerStore.getState().appendMessage('a', msg({
      id: 'a2', conversation_id: 'a', created_at: '2026-08-01T05:00:00.000Z',
    }));
    const next = selectLastMessageByConv(useMessengerStore.getState());
    expect(next).not.toBe(first);
    expect(next.a?.id).toBe('a2');
  });

  it('follows the message ORDER, not arrival order — a late older row is not the "last"', () => {
    const s = useMessengerStore.getState();
    s.appendMessage('a', msg({id: 'newer', conversation_id: 'a', created_at: '2026-08-01T09:00:00.000Z'}));
    // L18 — a stashed no_key group message drains late but carries its real
    // send time; appendMessage binary-splices it into place.
    s.appendMessage('a', msg({id: 'older', conversation_id: 'a', created_at: '2026-08-01T08:00:00.000Z'}));

    expect(selectLastMessageByConv(useMessengerStore.getState()).a?.id).toBe('newer');
  });
});

describe('id-scoped selectors', () => {
  it('selectMessages returns the SAME frozen EMPTY_MESSAGES for any unknown id', () => {
    const s = useMessengerStore.getState();
    expect(selectMessages('nope')(s)).toBe(EMPTY_MESSAGES);
    expect(selectMessages('also-nope')(s)).toBe(EMPTY_MESSAGES);
    expect(Object.isFrozen(EMPTY_MESSAGES)).toBe(true);
  });

  it('selectMessages returns the live list once the conversation has one', () => {
    useMessengerStore.getState().hydrateMessages({
      a: [msg({id: 'a1', created_at: '2026-08-01T01:00:00.000Z'})],
    });
    const s = useMessengerStore.getState();
    expect(selectMessages('a')(s).map(m => m.id)).toEqual(['a1']);
  });

  it('selectConversation returns the row, or undefined for an unknown id', () => {
    useMessengerStore.getState().upsertConversation(convo('c-known'));
    const s = useMessengerStore.getState();
    expect(selectConversation('c-known')(s)?.id).toBe('c-known');
    expect(selectConversation('c-missing')(s)).toBeUndefined();
  });
});
