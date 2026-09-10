/**
 * B-131 companion — the shared icon/colour mapping every tick-drawing surface
 * uses (ChatScreen's bubble, Departmental Chat's bubble). Was previously two
 * copies of this exact switch (one per screen); Departmental Chat's copy had
 * ALREADY drifted into a THIRD, worse shape — a hardcoded `check-all` that
 * ignored status entirely, showing "read by everyone" for an unsent message.
 * This pins the shared function so neither screen can drift again.
 */

import {tickIcon} from '../runtime/tickIcon';

const TOKENS = {mute: '#mute', read: '#read', alert: '#alert'};

describe('tickIcon — status → icon/colour, parameterised over caller tokens', () => {
  it.each<[string, {name: string; color: string}]>([
    ['sending',     {name: 'progress-clock', color: TOKENS.mute}],
    ['sent',        {name: 'check',          color: TOKENS.mute}],
    ['delivered',   {name: 'check-all',      color: TOKENS.mute}],
    ['read',        {name: 'check-all',      color: TOKENS.read}],
    ['failed',      {name: 'alert-circle',   color: TOKENS.alert}],
    ['undelivered', {name: 'alert-circle',   color: TOKENS.alert}],
  ])('status %s → %o', (status, expected) => {
    expect(tickIcon({sender_id: 'self', status}, TOKENS)).toEqual(expected);
  });

  it('an own message with no recognised status draws no tick', () => {
    expect(tickIcon({sender_id: 'self', status: 'archived'}, TOKENS)).toBeNull();
  });

  // The exact bug this module fixes: a message NOT sent by self (or with no
  // status yet, e.g. still rendering) must never show a tick, no matter what —
  // the old DepartmentChatScreen code showed check-all unconditionally for
  // "mine" messages regardless of this rule.
  it('never draws a tick for a message not sent by self', () => {
    expect(tickIcon({sender_id: 'peer-1', status: 'read'}, TOKENS)).toBeNull();
  });

  it('two callers with different token sets never see the other’s colours', () => {
    const chatTokens = {mute: '#111', read: '#7ED6FF', alert: '#FF5D5D'};
    const deptTokens  = {mute: '#222', read: '#5B8DEF', alert: '#F58B97'};
    expect(tickIcon({sender_id: 'self', status: 'read'}, chatTokens)?.color).toBe('#7ED6FF');
    expect(tickIcon({sender_id: 'self', status: 'read'}, deptTokens)?.color).toBe('#5B8DEF');
  });
});
