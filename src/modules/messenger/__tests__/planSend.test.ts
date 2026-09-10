import {planSend, normaliseSendOptions, type PlanSendDeps} from '../runtime/planSend';

/**
 * W27 — the pure send planner.
 *
 * `sendText` is 808 lines and lives in a file no test can import, so every rule
 * it applied before branching was pinned only by static source scans. These run
 * them. See docs/runbooks/MESSAGE_LOOP.md W27.
 */

const NOW = Date.parse('2026-07-22T10:00:00.000Z');

function mkDeps(over: Partial<PlanSendDeps> = {}): PlanSendDeps {
  return {
    resolveDirect:       (uid) => `direct:${uid}`,   // no server row by default
    isGroupConversation: () => false,
    makeId:              () => 'minted-id',
    now:                 () => NOW,
    ...over,
  };
}

describe('normaliseSendOptions — the legacy overload', () => {
  it('treats a bare peer as {peer}', () => {
    expect(normaliseSendOptions({userId: 'u1', deviceId: 1})).toEqual({peer: {userId: 'u1', deviceId: 1}});
  });

  it('passes an options object through, and undefined becomes {}', () => {
    expect(normaliseSendOptions({isGroup: true})).toEqual({isGroup: true});
    expect(normaliseSendOptions(undefined)).toEqual({});
  });
});

describe('planSend — canonicalisation', () => {
  it('rewrites a synthetic direct: id to the server UUID when one exists', () => {
    // The INBOUND path canonicalises the same way. If outbound disagreed, the
    // bubble would land in a slot ChatScreen is not subscribed to and simply
    // never appear.
    const plan = planSend('direct:bob', {}, mkDeps({resolveDirect: () => 'uuid-123'}));

    expect(plan.conversationId).toBe('uuid-123');
    expect(plan.canonicalisedFrom).toBe('direct:bob');
  });

  it('leaves the id alone when no server row exists, and reports no hop', () => {
    const plan = planSend('direct:bob', {}, mkDeps());

    expect(plan.conversationId).toBe('direct:bob');
    expect(plan.canonicalisedFrom).toBeUndefined();
  });

  it('never canonicalises a group id — groups always carry a server UUID', () => {
    let asked = 0;
    const plan = planSend('group-uuid', {}, mkDeps({
      resolveDirect: () => { asked++; return 'WRONG'; },
    }));

    expect(asked).toBe(0);
    expect(plan.conversationId).toBe('group-uuid');
  });

  it('resolves BEFORE deciding topology — order is load-bearing', () => {
    // Topology is looked up by id. Asking before canonicalisation would classify
    // the wrong slot.
    const seen: string[] = [];
    planSend('direct:bob', {}, mkDeps({
      resolveDirect:       () => 'uuid-123',
      isGroupConversation: (cid) => { seen.push(cid); return false; },
    }));

    expect(seen).toEqual(['uuid-123']);
  });
});

describe('planSend — topology (M1/M2)', () => {
  it('delegates to the shared rule', () => {
    const plan = planSend('c1', {}, mkDeps({isGroupConversation: () => true}));
    expect(plan.isGroup).toBe(true);
  });

  it('the caller hint can force a group', () => {
    // opts.isGroup is the one remaining override of the shared rule, which is
    // why the plan surfaces it explicitly rather than hiding it in a branch.
    const plan = planSend('c1', {isGroup: true}, mkDeps({isGroupConversation: () => false}));
    expect(plan.isGroup).toBe(true);
  });

  it('but a FALSE hint does not override a real group', () => {
    // `opts.isGroup === true` only — a stale `false` from a caller must not
    // downgrade a genuine group into a 1:1 send, which would fan out to one peer
    // and silently drop the rest of the members.
    const plan = planSend('c1', {isGroup: false}, mkDeps({isGroupConversation: () => true}));
    expect(plan.isGroup).toBe(true);
  });
});

describe('planSend — ids (BS-REACT-AUTHOR, P2-12)', () => {
  it('the wire clientMsgId EQUALS the local bubble msgId', () => {
    // Reactions and replies others place are keyed by clientMsgId. The group
    // path used to mint a separate one, so a group author never saw reactions
    // on their own messages and reply-jump missed.
    const plan = planSend('c1', {}, mkDeps());
    expect(plan.clientMsgId).toBe(plan.msgId);
  });

  it('reuses existingMsgId so a media caption keeps ONE bubble', () => {
    const plan = planSend('c1', {existingMsgId: 'media-1'}, mkDeps());
    expect(plan.msgId).toBe('media-1');
    expect(plan.clientMsgId).toBe('media-1');
  });

  it('mints only when the caller supplied none', () => {
    expect(planSend('c1', {}, mkDeps()).msgId).toBe('minted-id');
  });
});

describe('planSend — TTL and reply metadata', () => {
  it('converts ttlSeconds to an absolute epoch-second expiry', () => {
    const plan = planSend('c1', {ttlSeconds: 300}, mkDeps());
    expect(plan.expiresAtSec).toBe(Math.floor(NOW / 1000) + 300);
  });

  it('leaves expiry undefined when no TTL was set', () => {
    expect(planSend('c1', {}, mkDeps()).expiresAtSec).toBeUndefined();
  });

  it('tolerates a reply whose preview is missing', () => {
    // A reply to an empty / media-only / disappeared message arrives with
    // preview undefined. `.slice()` on that used to throw and surface a red
    // banner on the chat surface.
    const plan = planSend('c1', {replyTo: {messageId: 'm0'}} as never, mkDeps());
    expect(plan.replyMeta).toEqual({msgId: 'm0', preview: ''});
  });

  it('truncates a long preview to 200 chars', () => {
    const plan = planSend('c1', {replyTo: {messageId: 'm0', preview: 'x'.repeat(500)}} as never, mkDeps());
    expect(plan.replyMeta?.preview).toHaveLength(200);
  });
});

describe('planSend — purity', () => {
  it('is deterministic: same inputs, same plan', () => {
    const a = planSend('c1', {ttlSeconds: 60}, mkDeps());
    const b = planSend('c1', {ttlSeconds: 60}, mkDeps());
    expect(a).toEqual(b);
  });

  it('reads the clock only through the injected `now`', () => {
    // If it reached for Date.now() directly, sentAt would not track the
    // injection and this would fail.
    const plan = planSend('c1', {}, mkDeps({now: () => Date.parse('2020-01-01T00:00:00.000Z')}));
    expect(plan.sentAt).toBe('2020-01-01T00:00:00.000Z');
  });
});
