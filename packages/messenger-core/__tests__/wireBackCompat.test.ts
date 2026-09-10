import {sealPayload, unsealPayload} from '@bravo/messenger-core';

/**
 * CROSS-VERSION wire compatibility: can a client built BEFORE a field existed
 * still decode an envelope that carries it?
 *
 * This is the gate that was missing, and its absence cost a real message.
 *
 * WHAT HAPPENED. `mentions` was added as a TOP-LEVEL SealedPayload field. The
 * shape guard rejects any key it does not know:
 *
 *     for (const k of Object.keys(o)) {
 *       if (!SEALED_PAYLOAD_KEYS.has(k)) {return false;}
 *     }
 *
 * An older client's Set has no `mentions`, so `unsealPayload` threw and the
 * receive txn destroyed the envelope. A mention-bearing group message sent from
 * the new build reached NOBODY on the old one; the same text without a mention
 * arrived fine.
 *
 * WHY THE EXISTING SUITE COULDN'T SEE IT. Every other test in this repo runs
 * ONE version of the code against ITSELF, so a new field is always in the
 * allow-list on both sides. `mentionEditDeleteWire.test.ts` even asserts that
 * unknown top-level keys are still rejected — it pinned the strictness and
 * never asked what a client WITHOUT the key does with it. Testing new code
 * against new code cannot, in principle, catch a forward-compatibility break.
 *
 * SO THIS FILE RE-IMPLEMENTS THE OLD VALIDATOR and decodes today's output with
 * it. The frozen copy below is the guard as it shipped, verbatim — do NOT
 * "update" it when a field is added. Updating it is the same mistake again: its
 * whole value is that it does NOT know about anything added since.
 *
 * THE RULE THIS ENFORCES: a new field must ride inside a container the old
 * guard type-checks but does not key-iterate (`group`, `replyTo`, `reaction`,
 * `attachment`), never at the top level and never inside `aad` — those two are
 * the only ones that reject unknown keys.
 */

/** The allow-list EXACTLY as it shipped before mentions/edit/deleteFor. FROZEN. */
const LEGACY_PAYLOAD_KEYS = new Set([
  'v', 'cert', 'body', 'attachment', 'expiresAtSec', 'clientMsgId',
  'group', 'replyTo', 'reaction', 'control', 'groupCallPresence', 'aad',
]);
const LEGACY_AAD_KEYS = new Set(['ts', 'to', 'sender', 'conversationId', 'groupId', 'epoch']);

/**
 * The legacy guard, reduced to the parts that decide accept/reject for our
 * envelopes: the two key-iterating gates plus the group type checks. Note what
 * it does NOT do — it never iterates the keys of `group`. That omission is the
 * entire compatibility mechanism.
 */
function legacyAccepts(wire: string): boolean {
  let o: Record<string, unknown>;
  try { o = JSON.parse(wire) as Record<string, unknown>; } catch { return false; }
  if (!o || typeof o !== 'object') {return false;}
  for (const k of Object.keys(o)) {
    if (!LEGACY_PAYLOAD_KEYS.has(k)) {return false;}
  }
  if (typeof o.v !== 'number')    {return false;}
  if (typeof o.cert !== 'string') {return false;}
  if (typeof o.body !== 'string') {return false;}
  if (o.group !== null && o.group !== undefined) {
    if (typeof o.group !== 'object') {return false;}
    const g = o.group as Record<string, unknown>;
    if (typeof g.groupId     !== 'string') {return false;}
    if (typeof g.kind        !== 'string') {return false;}
    if (g.kind !== 'text' && g.kind !== 'admin') {return false;}
    if (typeof g.clientMsgId !== 'string') {return false;}
  }
  if (o.aad !== null && o.aad !== undefined) {
    if (typeof o.aad !== 'object') {return false;}
    const a = o.aad as Record<string, unknown>;
    for (const k of Object.keys(a)) {
      if (!LEGACY_AAD_KEYS.has(k)) {return false;}
    }
  }
  return true;
}

const CERT = 'c.c.c';
const TO   = {userId: 'bob', deviceId: 1};
const MENTIONS = [{userId: 'u-alice', label: 'Alice'}];
const GROUP = {groupId: 'g1', kind: 'text' as const, clientMsgId: 'cm1'};

describe('the frozen legacy guard is a faithful stand-in', () => {
  it('accepts a plain message', () => {
    expect(legacyAccepts(sealPayload(CERT, 'hello', {aad: {to: TO, ts: 1}}))).toBe(true);
  });

  it('accepts a group message with a reply', () => {
    const wire = sealPayload(CERT, 'hi', {group: GROUP, replyTo: {msgId: 'm', preview: 'p'}});
    expect(legacyAccepts(wire)).toBe(true);
  });

  it('REPRODUCES the bug: a top-level unknown key is fatal to it', () => {
    // The control. If this ever passes, the stand-in has stopped modelling the
    // old client and every other assertion here is worthless.
    const wire = JSON.stringify({v: 3, cert: CERT, body: 'hi', mentions: MENTIONS});
    expect(legacyAccepts(wire)).toBe(false);
  });
});

describe('mentions must survive an OLD client', () => {
  it('a mention-bearing GROUP message is accepted by the legacy guard', () => {
    // The regression. Before the fix this produced a top-level `mentions` key
    // and the old client destroyed the message.
    const wire = sealPayload(CERT, 'hey @Alice', {
      group: {...GROUP, mentions: MENTIONS},
      aad:   {to: TO, ts: 1},
    });
    expect(legacyAccepts(wire)).toBe(true);
  });

  it('...and a CURRENT client still reads the mentions back', () => {
    const wire = sealPayload(CERT, 'hey @Alice', {group: {...GROUP, mentions: MENTIONS}});
    expect(unsealPayload(wire).group?.mentions).toEqual(MENTIONS);
  });

  it('the body reaches the old client intact — it just loses the highlight', () => {
    const wire = sealPayload(CERT, 'hey @Alice how are you', {group: {...GROUP, mentions: MENTIONS}});
    expect(legacyAccepts(wire)).toBe(true);
    expect((JSON.parse(wire) as {body: string}).body).toBe('hey @Alice how are you');
  });
});

describe('edit / delete-for-everyone must survive an OLD client in a GROUP', () => {
  const EDIT = {targetMsgId: 't1', body: 'fixed', editedAt: 1};
  const DEL  = {targetMsgId: 't1', deletedAt: 1};

  it('a group EDIT directive is accepted', () => {
    const wire = sealPayload(CERT, '', {group: {...GROUP, edit: EDIT}, aad: {to: TO, ts: 1}});
    expect(legacyAccepts(wire)).toBe(true);
    expect(unsealPayload(wire).group?.edit).toEqual(EDIT);
  });

  it('a group DELETE directive is accepted', () => {
    const wire = sealPayload(CERT, '', {group: {...GROUP, deleteFor: DEL}, aad: {to: TO, ts: 1}});
    expect(legacyAccepts(wire)).toBe(true);
    expect(unsealPayload(wire).group?.deleteFor).toEqual(DEL);
  });

  it('DOCUMENTS THE RESIDUAL GAP: a 1:1 directive has no carrier and IS refused', () => {
    // 1:1 has no `group` object, so there is nowhere compatible to put it. This
    // is accepted deliberately and is bounded: a directive renders no bubble,
    // so an old peer refusing it loses the edit/delete, never a user message.
    // If a carrier for 1:1 ever appears, flip this assertion — do not delete it.
    const wire = sealPayload(CERT, '', {edit: EDIT, aad: {to: TO, ts: 1}});
    expect(legacyAccepts(wire)).toBe(false);
  });
});

describe('the rule, stated as a test so the NEXT field obeys it', () => {
  it('nothing the send path emits today adds a top-level key the old guard rejects', () => {
    // Every shape a current client can put on the wire, decoded by the frozen
    // guard. A new field added at the top level fails here immediately.
    const shapes = [
      sealPayload(CERT, 'plain', {aad: {to: TO, ts: 1}}),
      sealPayload(CERT, 'media', {attachment: {objectKey: 'o', keyB64: 'k', ivB64: 'i', mimeType: 'image/jpeg', size: 1}}),
      sealPayload(CERT, 'reply', {replyTo: {msgId: 'm', preview: 'p'}}),
      sealPayload(CERT, '',      {reaction: {targetMsgId: 't', emoji: '👍'}}),
      sealPayload(CERT, 'grp',   {group: GROUP}),
      sealPayload(CERT, 'grp+m', {group: {...GROUP, mentions: MENTIONS}}),
      sealPayload(CERT, '',      {group: {...GROUP, edit: {targetMsgId: 't', body: 'b', editedAt: 1}}}),
      sealPayload(CERT, '',      {group: {...GROUP, deleteFor: {targetMsgId: 't', deletedAt: 1}}}),
      sealPayload(CERT, '',      {control: 'rehandshake'}),
    ];
    const refused = shapes.filter(w => !legacyAccepts(w));
    expect(refused).toEqual([]);
  });

  it('`aad` is the OTHER key-iterating gate — nothing may be added there either', () => {
    const wire = sealPayload(CERT, 'hi', {aad: {to: TO, ts: 1, sender: {userId: 'a', deviceId: 1}, conversationId: 'c'}});
    expect(legacyAccepts(wire)).toBe(true);
    // A hypothetical new AAD field would be fatal, exactly like a top-level one.
    const hostile = JSON.stringify({v: 3, cert: CERT, body: 'hi', aad: {to: TO, ts: 1, newField: 'x'}});
    expect(legacyAccepts(hostile)).toBe(false);
  });
});
