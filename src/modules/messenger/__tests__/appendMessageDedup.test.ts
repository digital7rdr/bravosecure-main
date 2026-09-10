/**
 * sqa.md bug register — this suite pins: B-138.
 *
 * B-138 (duplicate messages came back on EVERY restart) is pinned by both halves: "M12 —
 * appendMessage returns the EFFECTIVE message id" is the WRITE side (lanes must persist the
 * id the store committed, not the one they handed it, because appendMessage forks a
 * content-divergent collision X to X#n), and "M8 — hydrateMessages dedups by envelope_id,
 * not just id" is the READ side (a row on disk under a different local id was re-imported
 * as a second bubble at every boot).
 */
/**
 * P0-T4 + P1-N20 regression locks on `messengerStore.appendMessage`.
 *
 * - P0-T4: a reconnect that re-pushes the same envelope MUST NOT
 *   produce two bubbles. The crypto-layer `seenEnvelopeStore` guards
 *   the ratchet, but a redelivered envelope can still re-enter
 *   `appendMessage` via a different code path; the store itself must
 *   reject it on `envelope_id` even when the local `id` differs.
 * - P1-N20: hydrate sort + prependOlder sort must produce a stable
 *   order when two messages share the same `created_at`.
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
import type {LocalConversation, LocalMessage} from '../store/types';

const CONV = 'direct:alice';

function msg(overrides: Partial<LocalMessage>): LocalMessage {
  return {
    id:              overrides.id ?? 'm1',
    conversation_id: CONV,
    sender_id:       'alice-uuid',
    type:            'text',
    content:         'hi',
    status:          'sent',
    is_encrypted:    true,
    created_at:      overrides.created_at ?? '2026-05-25T12:00:00.000Z',
    peer:            {userId: 'alice-uuid', deviceId: 1},
    ...overrides,
  };
}

beforeEach(() => {
  useMessengerStore.setState({
    conversations: {}, conversationOrder: [], messages: {},
    activeConversationId: null,
  } as never, false);
});

describe('M12 — appendMessage returns the EFFECTIVE message id', () => {
  test('returns the id it stored for a normal append', () => {
    expect(useMessengerStore.getState().appendMessage(CONV, msg({id: 'm1', envelope_id: 'e1'})))
      .toBe('m1');
  });

  test('returns the FORKED id when content diverges under the same id', () => {
    // The store keeps BOTH bodies by storing the second under `${id}#${n}`.
    // A caller that kept its own 'm1' would then patch nothing at all.
    const s = useMessengerStore.getState();
    s.appendMessage(CONV, msg({id: 'm1', content: 'first', envelope_id: 'e1'}));
    const got = s.appendMessage(CONV, msg({id: 'm1', content: 'second', envelope_id: 'e2'}));
    expect(got).toMatch(/^m1#/);
    expect(useMessengerStore.getState().messages[CONV]).toHaveLength(2);
  });

  test('returns null when the row was deduped (nothing was added)', () => {
    const s = useMessengerStore.getState();
    s.appendMessage(CONV, msg({id: 'm1', content: 'same', envelope_id: 'e1'}));
    expect(s.appendMessage(CONV, msg({id: 'm1', content: 'same', envelope_id: 'e1'}))).toBeNull();
    expect(useMessengerStore.getState().messages[CONV]).toHaveLength(1);
  });

  test('the returned id is the one updateMessageStatus actually matches', () => {
    // The whole point: patching by the PASSED id after a fork is a silent
    // no-op, so the bubble sits in `sending` forever with no error anywhere.
    const s = useMessengerStore.getState();
    s.appendMessage(CONV, msg({id: 'm1', content: 'first', envelope_id: 'e1'}));
    const effective = s.appendMessage(CONV, msg({id: 'm1', content: 'second', envelope_id: 'e2'}))!;

    useMessengerStore.getState().updateMessageStatus(CONV, effective, 'failed');
    const rows = useMessengerStore.getState().messages[CONV];
    expect(rows.find(r => r.id === effective)?.status).toBe('failed');
    expect(rows.find(r => r.id === 'm1')?.status).not.toBe('failed');
  });
});

describe('M8 — hydrateMessages dedups by envelope_id, not just id', () => {
  test('a disk row sharing an envelope with a live row does NOT come back as a second bubble', () => {
    // The live gate (P0-T4 below) collapses these, but hydration matched on
    // `id` only — so a duplicate that reached disk under a different local id
    // was RE-CREATED on every restart, and no amount of live dedup could clear
    // it. Any install carrying such a row before the committed-row fix still
    // has one, so hydration has to hold the line too.
    useMessengerStore.getState().appendMessage(CONV, msg({id: 'live-a', envelope_id: 'env-1'}));
    useMessengerStore.getState().hydrateMessages({
      [CONV]: [msg({id: 'disk-b', envelope_id: 'env-1'})],
    });
    expect(useMessengerStore.getState().messages[CONV]).toHaveLength(1);
  });

  test('rows with distinct envelopes still hydrate normally', () => {
    useMessengerStore.getState().appendMessage(CONV, msg({id: 'live-a', envelope_id: 'env-1'}));
    useMessengerStore.getState().hydrateMessages({
      [CONV]: [msg({id: 'disk-b', envelope_id: 'env-2', created_at: '2026-05-25T12:00:01.000Z'})],
    });
    expect(useMessengerStore.getState().messages[CONV]).toHaveLength(2);
  });

  test('two disk rows sharing one envelope collapse to a single bubble', () => {
    // Dedup must be transitive within the hydrated page, not only against
    // what was already in memory.
    useMessengerStore.getState().hydrateMessages({
      [CONV]: [
        msg({id: 'disk-a', envelope_id: 'env-9'}),
        msg({id: 'disk-b', envelope_id: 'env-9'}),
      ],
    });
    expect(useMessengerStore.getState().messages[CONV]).toHaveLength(1);
  });

  test('rows with NO envelope_id (outbound) are never collapsed together', () => {
    // Outbound rows carry no envelope until acked; treating undefined as a
    // shared key would merge every unsent message into one.
    useMessengerStore.getState().hydrateMessages({
      [CONV]: [
        msg({id: 'out-a', created_at: '2026-05-25T12:00:00.000Z'}),
        msg({id: 'out-b', created_at: '2026-05-25T12:00:01.000Z'}),
      ],
    });
    expect(useMessengerStore.getState().messages[CONV]).toHaveLength(2);
  });
});

describe('P0-T4 — appendMessage dedups by envelope_id', () => {
  test('two distinct local ids sharing one envelope_id collapse to a single bubble', () => {
    const a = msg({id: 'local-a', envelope_id: 'env-1'});
    const b = msg({id: 'local-b', envelope_id: 'env-1'});  // simulated reconnect-redeliver
    useMessengerStore.getState().appendMessage(CONV, a);
    useMessengerStore.getState().appendMessage(CONV, b);
    expect(useMessengerStore.getState().messages[CONV]).toHaveLength(1);
    expect(useMessengerStore.getState().messages[CONV][0].id).toBe('local-a');
  });

  test('distinct envelope_ids stay distinct', () => {
    useMessengerStore.getState().appendMessage(CONV, msg({id: 'm1', envelope_id: 'env-1'}));
    useMessengerStore.getState().appendMessage(CONV, msg({id: 'm2', envelope_id: 'env-2'}));
    expect(useMessengerStore.getState().messages[CONV]).toHaveLength(2);
  });

  test('missing envelope_id: exact-duplicate (same id+sender+content) is dropped', () => {
    // Same id, same sender_id, same content → P2-N4 content-bound dedup
    // drops the second push.
    useMessengerStore.getState().appendMessage(CONV, msg({id: 'm1', content: 'hi'}));
    useMessengerStore.getState().appendMessage(CONV, msg({id: 'm1', content: 'hi'}));
    expect(useMessengerStore.getState().messages[CONV]).toHaveLength(1);
    expect(useMessengerStore.getState().messages[CONV][0].content).toBe('hi');
  });

  test('outbound message without envelope_id is not blocked by an inbound msg that has one', () => {
    useMessengerStore.getState().appendMessage(CONV, msg({id: 'in1', envelope_id: 'env-1'}));
    useMessengerStore.getState().appendMessage(CONV, msg({id: 'out1', sender_id: 'self'}));
    expect(useMessengerStore.getState().messages[CONV]).toHaveLength(2);
  });
});

describe('P1-N20 — appendMessage append order is the comparator-stable order under hydrate', () => {
  test('hydrateMessages sorts equal-ts messages by id ascending', () => {
    const sameTs = '2026-05-25T12:00:00.000Z';
    const m1 = msg({id: 'mZ', created_at: sameTs});
    const m2 = msg({id: 'mA', created_at: sameTs});
    const m3 = msg({id: 'mM', created_at: sameTs});
    useMessengerStore.getState().hydrateMessages({[CONV]: [m1, m2, m3]}, true);
    const ids = useMessengerStore.getState().messages[CONV].map(m => m.id);
    expect(ids).toEqual(['mA', 'mM', 'mZ']);
  });

  test('prependOlderMessages preserves stable order for equal-ts boundary', () => {
    const ts = '2026-05-25T12:00:00.000Z';
    useMessengerStore.getState().appendMessage(CONV, msg({id: 'mB', created_at: ts}));
    useMessengerStore.getState().prependOlderMessages(CONV, [
      msg({id: 'mA', created_at: ts}),
      msg({id: 'mC', created_at: ts}),
    ]);
    const ids = useMessengerStore.getState().messages[CONV].map(m => m.id);
    expect(ids).toEqual(['mA', 'mB', 'mC']);
  });
});

describe('L18 — appendMessage splices an out-of-order (late-drained) message into send-order', () => {
  test('a stashed message that drains late lands in its chronological slot, not the bottom', () => {
    // Two live messages, then a late insert whose send-time created_at falls
    // BETWEEN them — a no_key group message that drained after newer messages.
    useMessengerStore.getState().appendMessage(CONV, msg({id: 'm1', envelope_id: 'e1', created_at: '2026-05-25T12:00:01.000Z'}));
    useMessengerStore.getState().appendMessage(CONV, msg({id: 'm3', envelope_id: 'e3', created_at: '2026-05-25T12:00:03.000Z'}));
    useMessengerStore.getState().appendMessage(CONV, msg({id: 'm2', envelope_id: 'e2', created_at: '2026-05-25T12:00:02.000Z'}));
    expect(useMessengerStore.getState().messages[CONV].map(m => m.id)).toEqual(['m1', 'm2', 'm3']);
  });

  test('in-order appends still go to the end (fast path preserved)', () => {
    useMessengerStore.getState().appendMessage(CONV, msg({id: 'a', envelope_id: 'ea', created_at: '2026-05-25T12:00:01.000Z'}));
    useMessengerStore.getState().appendMessage(CONV, msg({id: 'b', envelope_id: 'eb', created_at: '2026-05-25T12:00:02.000Z'}));
    expect(useMessengerStore.getState().messages[CONV].map(m => m.id)).toEqual(['a', 'b']);
  });
});

describe('OM-06 — a late-spliced OLDER message does not regress the preview or the MRU order', () => {
  const OTHER = 'direct:bob';
  const convo = (id: string, over: Partial<LocalConversation> = {}): LocalConversation => ({
    id, type: 'direct', name: id, participants: [], peer: {userId: 'alice-uuid', deviceId: 1},
    session_state: 'established', unread_count: 0, is_muted: false,
    created_at: '2026-05-25T11:00:00.000Z', ...over,
  } as LocalConversation);

  beforeEach(() => {
    useMessengerStore.setState({
      conversations: {[CONV]: convo(CONV), [OTHER]: convo(OTHER)},
      conversationOrder: [OTHER, CONV],
      messages: {}, activeConversationId: null,
    } as never, false);
  });

  test('last_message keeps the newer row when an older one splices in', () => {
    const s = () => useMessengerStore.getState();
    s().appendMessage(CONV, msg({id: 'new', envelope_id: 'e-new', content: 'newest',
      created_at: '2026-05-25T12:00:30.000Z'}));
    s().appendMessage(CONV, msg({id: 'old', envelope_id: 'e-old', content: 'stale drain',
      created_at: '2026-05-25T12:00:02.000Z'}));
    expect(s().messages[CONV].map(m => m.id)).toEqual(['old', 'new']);
    expect(s().conversations[CONV].last_message?.id).toBe('new');
    expect(s().conversations[CONV].last_message?.content).toBe('newest');
  });

  test('a stale insert does not move the conversation to the front of conversationOrder', () => {
    const s = () => useMessengerStore.getState();
    s().appendMessage(CONV, msg({id: 'new', envelope_id: 'e-new', created_at: '2026-05-25T12:00:30.000Z'}));
    expect(s().conversationOrder[0]).toBe(CONV);
    useMessengerStore.setState({conversationOrder: [OTHER, CONV]} as never, false);
    s().appendMessage(CONV, msg({id: 'old', envelope_id: 'e-old', created_at: '2026-05-25T12:00:02.000Z'}));
    expect(s().conversationOrder).toEqual([OTHER, CONV]);
  });

  test('a stale insert still bumps the unread badge', () => {
    const s = () => useMessengerStore.getState();
    s().appendMessage(CONV, msg({id: 'new', envelope_id: 'e-new', created_at: '2026-05-25T12:00:30.000Z'}));
    const before = s().conversations[CONV].unread_count;
    s().appendMessage(CONV, msg({id: 'old', envelope_id: 'e-old', created_at: '2026-05-25T12:00:02.000Z'}));
    expect(s().conversations[CONV].unread_count).toBe(before + 1);
  });

  test('boot case: an older drain into an EMPTY message list does not clobber a rehydrated preview', () => {
    useMessengerStore.setState({
      conversations: {[CONV]: convo(CONV, {
        last_message: msg({id: 'persisted', content: '', created_at: '2026-05-25T12:00:30.000Z'}),
      })},
      conversationOrder: [OTHER, CONV], messages: {},
    } as never, false);
    useMessengerStore.getState().appendMessage(CONV,
      msg({id: 'old', envelope_id: 'e-old', created_at: '2026-05-25T12:00:02.000Z'}));
    expect(useMessengerStore.getState().conversations[CONV].last_message?.id).toBe('persisted');
  });

  test('own send always takes the preview even against a skewed-future peer timestamp', () => {
    const s = () => useMessengerStore.getState();
    s().appendMessage(CONV, msg({id: 'skewed', envelope_id: 'e-skew', sender_id: 'alice-uuid',
      created_at: '2099-01-01T00:00:00.000Z'}));
    s().appendMessage(CONV, msg({id: 'mine', sender_id: 'self', content: 'my reply',
      created_at: '2026-05-25T12:01:00.000Z'}));
    expect(s().conversations[CONV].last_message?.id).toBe('mine');
  });
});

describe('OM-02 — a clamped fast-clock peer row keeps later replies at the tail', () => {
  const T = 1_800_000_000_000;

  it('contrast: the raw future stamp splices the reply ABOVE the question (the defect)', () => {
    const st = useMessengerStore.getState();
    st.appendMessage(CONV, msg({id: 'peer-raw', created_at: new Date(T + 3 * 60_000).toISOString()}));
    st.appendMessage(CONV, msg({id: 'own', sender_id: 'self', created_at: new Date(T + 1_000).toISOString()}));
    expect(useMessengerStore.getState().messages[CONV].map(m => m.id)).toEqual(['own', 'peer-raw']);
  });

  it('the clamped stamp keeps the transcript in true order', () => {
    const {orderingCreatedAt} = require('../runtime/orderingClock') as
      typeof import('../runtime/orderingClock');
    const st = useMessengerStore.getState();
    st.appendMessage(CONV, msg({id: 'peer', created_at: orderingCreatedAt(T + 3 * 60_000, T)}));
    st.appendMessage(CONV, msg({id: 'own', sender_id: 'self', created_at: new Date(T + 1_000).toISOString()}));
    expect(useMessengerStore.getState().messages[CONV].map(m => m.id)).toEqual(['peer', 'own']);
  });
});
