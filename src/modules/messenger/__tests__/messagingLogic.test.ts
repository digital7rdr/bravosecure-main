import {
  isGroupConversation,
  isDeviceLocalGroupId,
  reactionRecipients,
  typingAffectedConversationIds,
  typingConversationTag,
  DIRECT_CONVERSATION_KEY,
  readReceiptAccepted,
  readReceiptEnvelopeMatch,
  groupSendBlockedReason,
  isGroupKeyPendingError,
  GROUP_KEY_PENDING_SEND_ERROR,
  TypingWatchdog,
  TYPING_WATCHDOG_MS,
  type MessagingStateLike,
} from '@/modules/messenger/runtime/messagingLogic';

/**
 * Runtime decision logic extracted from productionRuntime so the audited
 * receive/send branches are testable without standing up the full
 * runtime. Covers the HIGH fixes (reaction fan-out, typing routing) and
 * the MEDIUM fixes (typing watchdog, group read-receipt ownership).
 */

const OWN = 'user-self';
const ALICE = 'user-alice';
const BOB = 'user-bob';
const EVE = 'user-eve';

function state(conversations: MessagingStateLike['conversations'], groups: MessagingStateLike['groups'] = {}): MessagingStateLike {
  return {conversations, groups};
}

describe('isGroupConversation', () => {
  it('is true for explicit group / ops_channel types', () => {
    expect(isGroupConversation(state({g: {type: 'group'}}), 'g')).toBe(true);
    expect(isGroupConversation(state({g: {type: 'ops_channel'}}), 'g')).toBe(true);
  });
  it('is true when a local GroupState exists', () => {
    expect(isGroupConversation(state({g: {}}, {g: {}}), 'g')).toBe(true);
  });
  it('is true when key material arrives before the conversation row hydrates', () => {
    // Why: the admin-create can land before /conversations/mine — dropping the
    // GroupState clause outright would break that path, so it must stay live
    // for untyped/absent rows.
    expect(isGroupConversation(state({}, {g: {}}), 'g')).toBe(true);
  });
  it('is false for a direct chat even with two participants', () => {
    expect(isGroupConversation(state({d: {type: 'direct', participants: [OWN, ALICE]}}), 'd')).toBe(false);
  });
  it('is FALSE for a direct chat holding stray group key material (B-124/B-125)', () => {
    // Escalating a 1:1 call files a throwaway 'Call' GroupState under the real
    // 1:1 id. Key-material presence must never reclassify a `direct` row, or
    // the send path fans out as a group and the participants guard destroys
    // the user's typed text.
    expect(isGroupConversation(
      state({d: {type: 'direct', participants: [OWN, ALICE]}}, {d: {}}),
      'd',
    )).toBe(false);
  });
  it('is FALSE for a direct chat with stray key material and a single participant', () => {
    // The B-124 ghost row shape: participants = [ownUserId] only.
    expect(isGroupConversation(state({d: {type: 'direct', participants: [OWN]}}, {d: {}}), 'd')).toBe(false);
  });
  it('is FALSE for a `direct:`-shaped id with a stray key and NO conversation row', () => {
    // The residual B-125 hole: a push-tap / cold-contact slot has no row yet, so
    // `type !== 'direct'` was vacuously true and the GroupState clause still won.
    // A direct-SHAPED id can never be a group regardless of what rows exist.
    expect(isGroupConversation(state({}, {[`direct:${ALICE}`]: {}}), `direct:${ALICE}`)).toBe(false);
  });
  it('is FALSE for a `direct:`-shaped id with a stray key and an UNTYPED row', () => {
    expect(isGroupConversation(
      state({[`direct:${ALICE}`]: {}}, {[`direct:${ALICE}`]: {}}),
      `direct:${ALICE}`,
    )).toBe(false);
  });
});

describe('isDeviceLocalGroupId (B-124 — id shape, the one predicate every consumer imports)', () => {
  it('is true for a `direct:`-shaped id', () => {
    expect(isDeviceLocalGroupId('direct:user-alice')).toBe(true);
  });
  it('is false for a 32-hex deriveGroupId output', () => {
    expect(isDeviceLocalGroupId('adhoc0c0ffee0c0ffee0c0ffee0c0ffee')).toBe(false);
  });
  it('is false for a server UUID', () => {
    expect(isDeviceLocalGroupId('8b1d4e2a-11ef-4c3b-9a7d-0f2e5c1a9b44')).toBe(false);
  });
  it('is false for empty / undefined-ish input', () => {
    expect(isDeviceLocalGroupId('')).toBe(false);
  });
  it('is true for an untyped row with >1 participant (legacy fallback)', () => {
    expect(isGroupConversation(state({g: {participants: [ALICE, BOB]}}), 'g')).toBe(true);
  });
});

describe('reactionRecipients (BS-RX1 — group reaction fan-out)', () => {
  const peer = {userId: ALICE, deviceId: 1};

  it('returns just the peer for a direct chat', () => {
    const s = state({d: {type: 'direct', participants: [OWN, ALICE]}});
    expect(reactionRecipients(s, 'd', OWN, peer)).toEqual([{userId: ALICE, deviceId: 1}]);
  });

  it('fans out to EVERY group member except self', () => {
    const s = state({g: {type: 'group', participants: [OWN, ALICE, BOB]}});
    const out = reactionRecipients(s, 'g', OWN, peer);
    expect(out).toEqual([
      {userId: ALICE, deviceId: 1},
      {userId: BOB, deviceId: 1},
    ]);
    // The bug was that only ONE member received the reaction.
    expect(out.length).toBe(2);
  });

  it('falls back to the passed peer when a group has no resolved members yet', () => {
    const s = state({g: {type: 'group', participants: [OWN]}}); // only self
    expect(reactionRecipients(s, 'g', OWN, peer)).toEqual([peer]);
  });
});

describe('typingAffectedConversationIds (BS-TY1)', () => {
  it('includes synthetic + canonical direct ids, deduped', () => {
    const s = state({'uuid-1': {type: 'direct', participants: [OWN, ALICE]}});
    const out = typingAffectedConversationIds(s, ALICE, 'direct:user-alice', 'uuid-1');
    expect(out).toContain('direct:user-alice');
    expect(out).toContain('uuid-1');
  });

  it('collapses to one id when synthetic === canonical (no UUID row yet)', () => {
    const out = typingAffectedConversationIds(state({}), ALICE, 'direct:user-alice', 'direct:user-alice');
    expect(out).toEqual(['direct:user-alice']);
  });

  it('adds every group the sender participates in', () => {
    const s = state({
      'g1': {type: 'group', participants: [OWN, ALICE, BOB]},
      'g2': {type: 'group', participants: [OWN, BOB]}, // alice NOT a member
    });
    const out = typingAffectedConversationIds(s, ALICE, 'direct:user-alice', 'direct:user-alice');
    expect(out).toContain('g1');
    expect(out).not.toContain('g2');
  });
});

describe('typingConversationTag (SYNC-6)', () => {
  it('is symmetric in the pair (both endpoints derive the same tag)', () => {
    expect(typingConversationTag('g1', OWN, ALICE)).toBe(typingConversationTag('g1', ALICE, OWN));
  });
  it('differs per recipient for the SAME group (relay cannot cluster)', () => {
    expect(typingConversationTag('g1', ALICE, OWN)).not.toBe(
      typingConversationTag('g1', ALICE, BOB),
    );
  });
  it('differs per conversation for the same pair', () => {
    expect(typingConversationTag('g1', OWN, ALICE)).not.toBe(
      typingConversationTag('g2', OWN, ALICE),
    );
    expect(typingConversationTag(DIRECT_CONVERSATION_KEY, OWN, ALICE)).not.toBe(
      typingConversationTag('g1', OWN, ALICE),
    );
  });
  it('is 16 lowercase hex chars (matches the gateway sanitizer)', () => {
    expect(typingConversationTag('g1', OWN, ALICE)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('typingAffectedConversationIds — SYNC-6 scoping', () => {
  const s = state({
    'uuid-1': {type: 'direct', participants: [OWN, ALICE]},
    g1: {type: 'group', participants: [OWN, ALICE, BOB]},
    g2: {type: 'group', participants: [OWN, ALICE]},
  });

  it('a DIRECT tag resolves to the direct ids only — no group bleed', () => {
    const tag = typingConversationTag(DIRECT_CONVERSATION_KEY, ALICE, OWN);
    const out = typingAffectedConversationIds(s, ALICE, 'direct:user-alice', 'uuid-1', tag, OWN);
    expect(out.sort()).toEqual(['direct:user-alice', 'uuid-1']);
    expect(out).not.toContain('g1');
  });

  it('a GROUP tag resolves to exactly that group — no direct/other-group bleed', () => {
    const tag = typingConversationTag('g1', ALICE, OWN);
    const out = typingAffectedConversationIds(s, ALICE, 'direct:user-alice', 'uuid-1', tag, OWN);
    expect(out).toEqual(['g1']);
  });

  it('an unresolvable tag resolves to nothing (drop beats mis-paint)', () => {
    const out = typingAffectedConversationIds(
      s,
      ALICE,
      'direct:user-alice',
      'uuid-1',
      '0123456789abcdef',
      OWN,
    );
    expect(out).toEqual([]);
  });

  it('no tag → legacy fan-out preserved (old peers)', () => {
    const out = typingAffectedConversationIds(s, ALICE, 'direct:user-alice', 'uuid-1');
    expect(out).toEqual(expect.arrayContaining(['direct:user-alice', 'uuid-1', 'g1', 'g2']));
  });

  it('no ownUserId → legacy fan-out (defensive)', () => {
    const out = typingAffectedConversationIds(
      s,
      ALICE,
      'direct:user-alice',
      'uuid-1',
      'deadbeefdeadbeef',
    );
    expect(out).toContain('g1');
  });
});

describe('readReceiptAccepted (BS-RR1 — group receipt ownership)', () => {
  it('direct: accepts only the stored peer', () => {
    const s = state({d: {type: 'direct', participants: [OWN, ALICE]}});
    expect(readReceiptAccepted({state: s, conversationId: 'd', receipterUid: ALICE, messagePeerUserId: ALICE})).toBe(true);
    expect(readReceiptAccepted({state: s, conversationId: 'd', receipterUid: EVE, messagePeerUserId: ALICE})).toBe(false);
  });

  it('group: accepts ANY member, not just participants[0] (the bug)', () => {
    const s = state({g: {type: 'group', participants: [OWN, ALICE, BOB]}});
    // Outbound group rows store peer = participants[0] (= OWN/ALICE placeholder),
    // but a receipt from BOB (not the first member) must still be accepted.
    expect(readReceiptAccepted({state: s, conversationId: 'g', receipterUid: BOB, messagePeerUserId: ALICE})).toBe(true);
    expect(readReceiptAccepted({state: s, conversationId: 'g', receipterUid: ALICE, messagePeerUserId: ALICE})).toBe(true);
  });

  it('group: rejects a non-member receipter', () => {
    const s = state({g: {type: 'group', participants: [OWN, ALICE, BOB]}});
    expect(readReceiptAccepted({state: s, conversationId: 'g', receipterUid: EVE, messagePeerUserId: ALICE})).toBe(false);
  });
});

describe('TypingWatchdog (BS-TY2)', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it('fires onExpire after the window when not cleared (dropped stop frame)', () => {
    const wd = new TypingWatchdog();
    const onExpire = jest.fn();
    wd.arm('c1', onExpire);
    expect(wd.isArmed('c1')).toBe(true);
    jest.advanceTimersByTime(TYPING_WATCHDOG_MS + 1);
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(wd.isArmed('c1')).toBe(false);
  });

  it('does NOT fire when cleared before the window (stop frame / message arrived)', () => {
    const wd = new TypingWatchdog();
    const onExpire = jest.fn();
    wd.arm('c1', onExpire);
    wd.clear('c1');
    jest.advanceTimersByTime(TYPING_WATCHDOG_MS + 1);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('re-arming resets the window (does not double-fire)', () => {
    const wd = new TypingWatchdog(1000);
    const onExpire = jest.fn();
    wd.arm('c1', onExpire);
    jest.advanceTimersByTime(600);
    wd.arm('c1', onExpire); // re-arm at 600ms
    jest.advanceTimersByTime(600); // 1200ms total, but only 600ms since re-arm
    expect(onExpire).not.toHaveBeenCalled();
    jest.advanceTimersByTime(500); // now 1100ms since re-arm
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('tracks timers per conversation independently', () => {
    const wd = new TypingWatchdog();
    const a = jest.fn(); const b = jest.fn();
    wd.arm('a', a);
    wd.arm('b', b);
    wd.clear('a');
    jest.advanceTimersByTime(TYPING_WATCHDOG_MS + 1);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });
});

describe('GF-5 — groupSendBlockedReason', () => {
  it('blocks a group conversation with no GroupState at all', () => {
    expect(groupSendBlockedReason(state({g: {type: 'group', participants: [ALICE]}}), 'g')).toBe(
      'group_key_missing',
    );
  });
  it('blocks when GroupState exists but masterKeyB64 is the persisted empty string', () => {
    // The AsyncStorage vault strips the key to '' — a `!== undefined` guard
    // here would re-open the unwrapped-inner downgrade.
    expect(groupSendBlockedReason(state({g: {type: 'group'}}, {g: {masterKeyB64: ''}}), 'g')).toBe(
      'group_key_missing',
    );
  });
  it('allows once a real master key is present', () => {
    expect(
      groupSendBlockedReason(state({g: {type: 'group'}}, {g: {masterKeyB64: 'a2V5'}}), 'g'),
    ).toBeNull();
  });
  it('never blocks a 1:1 chat', () => {
    expect(
      groupSendBlockedReason(state({d: {type: 'direct', participants: [OWN, ALICE]}}), 'd'),
    ).toBeNull();
  });
  it('blocks an ops_channel with no key', () => {
    expect(groupSendBlockedReason(state({g: {type: 'ops_channel'}}), 'g')).toBe(
      'group_key_missing',
    );
  });
  it('honours forceGroup for a row whose type has not synced yet', () => {
    expect(groupSendBlockedReason(state({g: {}}), 'g', true)).toBe('group_key_missing');
    expect(groupSendBlockedReason(state({g: {}}), 'g', false)).toBeNull();
  });
  it('isGroupKeyPendingError only matches the pending-key error', () => {
    expect(isGroupKeyPendingError(new Error(GROUP_KEY_PENDING_SEND_ERROR))).toBe(true);
    expect(isGroupKeyPendingError(new Error('group too large to send'))).toBe(false);
    expect(isGroupKeyPendingError('nope')).toBe(false);
  });
});

describe('readReceiptEnvelopeMatch (SYNC-1)', () => {
  const ids = new Set(['env-carol']);

  it('matches when the receipter map entry is in ids', () => {
    expect(readReceiptEnvelopeMatch({
      envelopeIds: {bob: 'env-bob', carol: 'env-carol'},
      receipterUid: 'carol', ids,
    })).toBe(true);
  });

  it("rejects another member's id (no cross-member confusion)", () => {
    expect(readReceiptEnvelopeMatch({
      envelopeIds: {bob: 'env-bob', carol: 'env-carol'},
      receipterUid: 'bob', ids,
    })).toBe(false);
  });

  it('map present but receipter absent (joined after send) → strict false', () => {
    expect(readReceiptEnvelopeMatch({
      envelopeId: 'env-carol',
      envelopeIds: {bob: 'env-bob'},
      receipterUid: 'carol', ids,
    })).toBe(false);
  });

  it('map absent → scalar fallback (legacy rows / 1:1)', () => {
    expect(readReceiptEnvelopeMatch({envelopeId: 'env-carol', receipterUid: 'carol', ids})).toBe(true);
    expect(readReceiptEnvelopeMatch({envelopeId: 'env-other', receipterUid: 'carol', ids})).toBe(false);
    expect(readReceiptEnvelopeMatch({receipterUid: 'carol', ids})).toBe(false);
  });
});

describe('B-124/B-125 — key material never overrules an explicit direct row', () => {
  it("a direct row with a stray 'Call' key alias stays a 1:1 (the escalation bug)", () => {
    expect(isGroupConversation(
      state({d: {type: 'direct', participants: [OWN, ALICE]}}, {d: {name: 'Call', masterKeyB64: 'k'}}),
      'd',
    )).toBe(false);
  });

  it('a direct row with ANY group state stays a 1:1 (type wins over crypto)', () => {
    expect(isGroupConversation(
      state({d: {type: 'direct', participants: [OWN, ALICE]}}, {d: {name: 'Team', masterKeyB64: 'k'}}),
      'd',
    )).toBe(false);
  });

  it("an untyped row with a 'Call'-named state is not a chat group", () => {
    expect(isGroupConversation(state({c: {}}, {c: {name: 'Call'}}), 'c')).toBe(false);
  });

  it('an untyped row with a real (non-Call) group state still counts (regression)', () => {
    expect(isGroupConversation(state({g: {}}, {g: {name: 'Team'}}), 'g')).toBe(true);
  });
});
