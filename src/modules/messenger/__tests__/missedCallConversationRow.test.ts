/**
 * M11 — a call event must not invent a chat row as a SIDE EFFECT.
 *
 * `appendMessage` shadow-creates a `direct:` conversation row for any inbound
 * message whose slot does not exist yet. That gate keys off `sender_id !==
 * 'self'`, which encodes inbound-ness, not INTENT — so a missed call from a
 * cold contact silently manufactured a chat thread. The group branch has had a
 * sentinel for this since B-106; the direct branch never did.
 *
 * The row itself is wanted (the call bubble needs somewhere to land). What was
 * wrong is that nothing declared it: it appeared or not depending on which
 * branch of a 213-line store action happened to fire. The dispatcher now mints
 * it explicitly, through the SAME shared helper the store uses, so the two can
 * never drift into producing different rows for the same situation.
 *
 * See docs/runbooks/MESSAGE_LOOP.md M11 / W15.
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

import { dispatchCallFrame } from '../webrtc/callDispatcher';
import { useMessengerStore, directPlaceholderConversation } from '../store/messengerStore';
import type { ServerFrame } from '@bravo/messenger-core';

const CALLER = 'caller-abcd1234-efgh';

beforeEach(() => {
  useMessengerStore.getState().reset();
});

describe('directPlaceholderConversation — the one placeholder minter', () => {
  it('uses the `Bravo · ` prefix that the name backfill looks for', () => {
    const row = directPlaceholderConversation(
      `direct:${CALLER}`, CALLER, { userId: CALLER, deviceId: 1 }, '2026-07-21T10:00:00.000Z',
    );
    // useRegisteredNames treats exactly this prefix as "still a placeholder,
    // safe to overwrite". A hand-rolled label (e.g. a bare userId.slice(0, 8))
    // produces a row whose name is NEVER backfilled.
    expect(row.name?.startsWith('Bravo · ')).toBe(true);
    expect(row.name).toBe(`Bravo · ${CALLER.slice(0, 8)}`);
  });

  it('is a direct row carrying the peer, with no unread and not muted', () => {
    const row = directPlaceholderConversation(
      `direct:${CALLER}`, CALLER, { userId: CALLER, deviceId: 1 }, '2026-07-21T10:00:00.000Z',
    );
    expect(row.type).toBe('direct');
    expect(row.participants).toEqual([CALLER]);
    expect(row.peer?.userId).toBe(CALLER);
    expect(row.unread_count).toBe(0);
    expect(row.is_muted).toBe(false);
  });
});

describe('B-134 — every cold-contact row minter produces a BACKFILLABLE name', () => {
  const SOURCES = [
    'src/modules/messenger/webrtc/callDispatcher.ts',
    'src/navigation/MainNavigator.tsx',
    'src/modules/messenger/store/messengerStore.ts',
  ];

  it('no caller hand-rolls a `userId.slice(0, 8)` label', () => {
    // The trap: a bare hex prefix LOOKS equivalent to the shared placeholder but
    // is not. `useRegisteredNames` treats ONLY the `Bravo · ` prefix as "still a
    // placeholder, safe to overwrite", so a hand-rolled label sticks forever —
    // the row keeps a raw hex name even after contact discovery learns the real
    // one. Mint through directPlaceholderConversation instead.
    const {readFileSync} = require('node:fs') as typeof import('node:fs');
    const {join} = require('node:path') as typeof import('node:path');
    for (const rel of SOURCES) {
      const src = readFileSync(join(process.cwd(), rel), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      expect(src).not.toMatch(/name:\s*[A-Za-z.]*userId\.slice\(/);
    }
  });
});

describe('M11 — a missed call from a cold contact', () => {
  function missedFrame(callId = 'call-1'): ServerFrame {
    return {
      event: 'call.missed',
      data: { callId, from: { userId: CALLER, deviceId: 1 }, kind: 'voice', at: Date.parse('2026-07-21T10:00:00.000Z') },
    } as unknown as ServerFrame;
  }

  it('lands the call bubble in a conversation row that actually exists', () => {
    dispatchCallFrame(missedFrame());

    const s = useMessengerStore.getState();
    const cid = `direct:${CALLER}`;
    // The bubble must not be orphaned in `messages` with no row to render it in
    // (M11's unnamed third outcome).
    expect(s.messages[cid]?.length).toBe(1);
    expect(s.conversations[cid]).toBeDefined();
    expect(s.conversationOrder).toContain(cid);
  });

  it('the row is backfillable — the call path and the store agree on the label', () => {
    dispatchCallFrame(missedFrame());
    const row = useMessengerStore.getState().conversations[`direct:${CALLER}`];
    expect(row?.name).toBe(`Bravo · ${CALLER.slice(0, 8)}`);
  });

  it('does not duplicate the row when a second call misses', () => {
    dispatchCallFrame(missedFrame('call-1'));
    dispatchCallFrame(missedFrame('call-2'));

    const s = useMessengerStore.getState();
    const cid = `direct:${CALLER}`;
    expect(s.conversationOrder.filter(id => id === cid)).toHaveLength(1);
    expect(s.messages[cid]?.length).toBe(2);
  });

  it('does not clobber an existing named conversation', () => {
    const cid = `direct:${CALLER}`;
    useMessengerStore.getState().upsertConversation({
      id: cid, type: 'direct', name: 'Alice', participants: [CALLER],
      peer: { userId: CALLER, deviceId: 1 }, session_state: 'established',
      unread_count: 0, is_muted: false, created_at: '2026-07-01T00:00:00.000Z',
    } as never);

    dispatchCallFrame(missedFrame());

    expect(useMessengerStore.getState().conversations[cid]?.name).toBe('Alice');
  });
});
