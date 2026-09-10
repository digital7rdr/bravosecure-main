/**
 * B-131 — the single tick rule, exhaustively pinned.
 *
 * `outgoingTick` is THE mapping every surface (chat bubble, list row) draws
 * delivery state from. conversationListTicks.test.ts pins the list-row
 * integration; this file pins the rule itself, including the edges nothing
 * else exercises: `null`, an unknown status, a missing status, and the
 * incoming-message veto that was half of the original B-131 report.
 */

import type {TickKind, TickMessageLike} from '../runtime/messageTicks';
import {outgoingTick} from '../runtime/messageTicks';

describe('outgoingTick — full status matrix for own messages', () => {
  it.each<[string, TickKind]>([
    ['sending', 'pending'],
    ['sent', 'single'],
    ['delivered', 'double'],
    ['read', 'double-read'],
    ['failed', 'failed'],
    ['undelivered', 'failed'],
  ])('status %s → %s', (status, expected) => {
    expect(outgoingTick({sender_id: 'self', status})).toBe(expected);
  });

  it('an unknown status draws no tick rather than guessing', () => {
    expect(outgoingTick({sender_id: 'self', status: 'archived'})).toBe('none');
  });

  it('a missing status draws no tick', () => {
    expect(outgoingTick({sender_id: 'self'})).toBe('none');
  });
});

describe('outgoingTick — the incoming-message veto (B-131)', () => {
  it.each<TickMessageLike>([
    {sender_id: 'peer-1', status: 'read'},
    {sender_id: '', status: 'delivered'},
    {status: 'read'},
  ])('never draws a tick for a message not sent by self: %o', msg => {
    expect(outgoingTick(msg)).toBe('none');
  });
});

describe('outgoingTick — absent message', () => {
  it('undefined → none', () => {
    expect(outgoingTick(undefined)).toBe('none');
  });

  it('null → none', () => {
    expect(outgoingTick(null)).toBe('none');
  });
});
