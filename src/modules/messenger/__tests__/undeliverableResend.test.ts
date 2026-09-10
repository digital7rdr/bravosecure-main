/**
 * B-46 regression locks — sender-side auto-resend on `envelope.undeliverable`
 * (selectUndeliverableResend eligibility + one-attempt budget) and the
 * recipient-side destroyed-envelope counter (noteUndecryptableDrop).
 *
 * Bug: a message sent while the recipient was logged out was silently
 * destroyed on the recipient (identity churn → outer unwrap fail → ack
 * 'discarded') with no trace on either side. The fix (a) auto-resends
 * once from the sender, who still holds the plaintext, and (b) surfaces
 * a count banner on the recipient. These tests pin the decision logic.
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
  selectUndeliverableResend,
  MAX_AUTO_RESENDS_PER_MESSAGE,
  _resetUndeliverableResendBudget,
  _undeliverableResendBudgetSize,
} from '../runtime/undeliverableResend';
import {useMessengerStore} from '../store/messengerStore';
import type {LocalMessage, LocalConversation} from '../store/types';

const CONV = 'direct:bob';
const NOW = 1_780_000_000_000; // fixed clock for determinism

function msg(overrides: Partial<LocalMessage>): LocalMessage {
  return {
    id:              'm1',
    conversation_id: CONV,
    sender_id:       'self',
    type:            'text',
    content:         'hello bob',
    status:          'undelivered',
    is_encrypted:    true,
    created_at:      '2026-07-05T12:00:00.000Z',
    peer:            {userId: 'bob-uuid', deviceId: 1},
    envelope_id:     'env-dead',
    ...overrides,
  };
}

function conv(overrides: Partial<LocalConversation>): LocalConversation {
  return {
    id:            CONV,
    type:          'direct',
    participants:  ['self', 'bob-uuid'],
    unread_count:  0,
    is_muted:      false,
    created_at:    '2026-07-01T00:00:00.000Z',
    peer:          {userId: 'bob-uuid', deviceId: 1},
    session_state: 'established',
    ...overrides,
  } as LocalConversation;
}

function state(m: LocalMessage, c: LocalConversation | null): {
  messages:      Record<string, LocalMessage[]>;
  conversations: Record<string, LocalConversation>;
} {
  return {
    messages:      {[CONV]: [m]},
    conversations: c ? {[CONV]: c} : {},
  };
}

beforeEach(() => {
  _resetUndeliverableResendBudget();
});

describe('B-46 — selectUndeliverableResend eligibility', () => {
  test('eligible 1:1 undelivered text → resend plan with peer + conversation', () => {
    const d = selectUndeliverableResend(state(msg({}), conv({})), 'env-dead', NOW);
    expect(d.action).toBe('resend');
    if (d.action === 'resend') {
      expect(d.conversationId).toBe(CONV);
      expect(d.message.id).toBe('m1');
      expect(d.peer).toEqual({userId: 'bob-uuid', deviceId: 1});
      expect(d.expiresAtSec).toBeUndefined();
    }
  });

  test('unknown envelope id → skip not-found', () => {
    const d = selectUndeliverableResend(state(msg({}), conv({})), 'env-other', NOW);
    expect(d).toEqual({action: 'skip', reason: 'not-found'});
  });

  test('inbound row (sender not self) → skip', () => {
    const d = selectUndeliverableResend(state(msg({sender_id: 'bob-uuid'}), conv({})), 'env-dead', NOW);
    expect(d).toEqual({action: 'skip', reason: 'not-own-outbound'});
  });

  test('status read (receipt raced ahead) → skip; trust the stronger signal', () => {
    const d = selectUndeliverableResend(state(msg({status: 'read'}), conv({})), 'env-dead', NOW);
    expect(d).toEqual({action: 'skip', reason: 'status-read'});
  });

  test('media row → skip (re-encrypt not supported on this path)', () => {
    const d = selectUndeliverableResend(state(msg({type: 'image'}), conv({})), 'env-dead', NOW);
    expect(d).toEqual({action: 'skip', reason: 'non-text'});
  });

  // B-683 follow-up (founder: WhatsApp parity) — the historic group skip is
  // DELIBERATELY reversed. Its recorded reason ("cannot attribute the failing
  // member") was retired by the per-leg undeliverable_legs map, and the
  // all-legs flip rule means a group 'undelivered' row is one NOBODY holds —
  // an automatic resend cannot duplicate. Execution rides the manual chip's
  // F2 lane. This RE-ANCHORS the old pin; do not restore the blanket skip.
  test('group conversation undelivered text → resend-group plan (one bounded attempt)', () => {
    // Map-bearing on purpose: the safety premise ("undelivered = nobody
    // holds it") is only true for rows the all-legs predicate governs.
    const m = msg({envelope_ids: {bob: 'env-dead'}});
    const d = selectUndeliverableResend(state(m, conv({type: 'group'})), 'env-dead', NOW);
    expect(d.action).toBe('resend-group');
    if (d.action === 'resend-group') {
      expect(d.conversationId).toBe(CONV);
      expect(d.message.id).toBe('m1');
    }
  });

  test('MAPLESS group row → skip legacy-no-legs (critic D1 — the duplicate path)', () => {
    // A pre-B-187/legacy row has no envelope_ids, so applyEnvelopeUndeliverable's
    // scalar path flips it on a SINGLE leg's destroy — other members may HOLD
    // the message, and an automatic fresh-wire-id re-send would duplicate for
    // every holder. The manual chip (a human choice) stays the legacy lane.
    const d = selectUndeliverableResend(state(msg({}), conv({type: 'group'})), 'env-dead', NOW);
    expect(d).toEqual({action: 'skip', reason: 'legacy-no-legs'});
  });

  test('group: matches a NON-scalar leg id too (the B-143 lesson, again)', () => {
    // The all-dead flip usually completes on a later leg, whose id is NOT
    // the first-wins scalar — a scalar-only match made the auto-resend
    // depend on fan-out order.
    const m = msg({envelope_id: 'env-bob', envelope_ids: {bob: 'env-bob', carol: 'env-carol'}});
    const d = selectUndeliverableResend(state(m, conv({type: 'group'})), 'env-carol', NOW);
    expect(d.action).toBe('resend-group');
  });

  test('group media row → still skip (auto path is text-only, chip handles media)', () => {
    const d = selectUndeliverableResend(state(msg({type: 'image'}), conv({type: 'group'})), 'env-dead', NOW);
    expect(d).toEqual({action: 'skip', reason: 'non-text'});
  });

  test('group budget: one automatic attempt, then the manual chip owns it', () => {
    const s = state(msg({envelope_ids: {bob: 'env-dead'}}), conv({type: 'group'}));
    expect(selectUndeliverableResend(s, 'env-dead', NOW).action).toBe('resend-group');
    expect(selectUndeliverableResend(s, 'env-dead', NOW))
      .toEqual({action: 'skip', reason: 'budget-exhausted'});
  });

  test('group not at undelivered (partial failure keeps sent) → skip', () => {
    const d = selectUndeliverableResend(state(msg({status: 'sent'}), conv({type: 'group'})), 'env-dead', NOW);
    expect(d).toEqual({action: 'skip', reason: 'status-sent'});
  });

  test('missing conversation row → conservative skip', () => {
    const d = selectUndeliverableResend(state(msg({}), null), 'env-dead', NOW);
    expect(d).toEqual({action: 'skip', reason: 'no-conversation'});
  });

  test('disappearing message past its deadline → skip expired', () => {
    const d = selectUndeliverableResend(
      state(msg({expires_at: NOW - 1_000}), conv({})), 'env-dead', NOW);
    expect(d).toEqual({action: 'skip', reason: 'expired'});
  });

  test('disappearing message still alive → absolute deadline carried over in seconds', () => {
    const expiresMs = NOW + 90_000;
    const d = selectUndeliverableResend(
      state(msg({expires_at: expiresMs}), conv({})), 'env-dead', NOW);
    expect(d.action).toBe('resend');
    if (d.action === 'resend') {
      expect(d.expiresAtSec).toBe(Math.floor(expiresMs / 1000));
    }
  });

  test(`budget: only ${MAX_AUTO_RESENDS_PER_MESSAGE} automatic attempt(s) per message id`, () => {
    const s = state(msg({}), conv({}));
    expect(selectUndeliverableResend(s, 'env-dead', NOW).action).toBe('resend');
    // Same message re-reported undeliverable (the resend also died) —
    // no second automatic attempt; the manual retry chip takes over.
    expect(selectUndeliverableResend(s, 'env-dead', NOW))
      .toEqual({action: 'skip', reason: 'budget-exhausted'});
  });

  test('budget map is LRU-bounded', () => {
    for (let i = 0; i < 400; i++) {
      const m = msg({id: `m-${i}`, envelope_id: `env-${i}`});
      selectUndeliverableResend(state(m, conv({})), `env-${i}`, NOW);
    }
    expect(_undeliverableResendBudgetSize()).toBeLessThanOrEqual(256);
  });
});

describe('B-46 — noteUndecryptableDrop counter (recipient banner)', () => {
  test('counts distinct envelopes, dedups redelivery of the same one, clears on dismiss', () => {
    const st = useMessengerStore.getState();
    const before = useMessengerStore.getState().undecryptableDropCount;
    st.noteUndecryptableDrop('drop-env-1');
    st.noteUndecryptableDrop('drop-env-1'); // WS/drain race on same envelope
    st.noteUndecryptableDrop('drop-env-2');
    expect(useMessengerStore.getState().undecryptableDropCount).toBe(before + 2);
    st.clearUndecryptableDrops();
    expect(useMessengerStore.getState().undecryptableDropCount).toBe(0);
  });

  test('empty envelope id is ignored', () => {
    useMessengerStore.getState().clearUndecryptableDrops();
    useMessengerStore.getState().noteUndecryptableDrop('');
    expect(useMessengerStore.getState().undecryptableDropCount).toBe(0);
  });
});
