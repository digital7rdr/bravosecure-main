import {
  sealPayload,
  unsealPayload,
  CryptoError,
  MENTIONS_MAX,
  MENTION_LABEL_MAX_CHARS,
  EDIT_BODY_MAX_CHARS,
} from '@bravo/messenger-core';
import type {SealedMention} from '../src/crypto/sealedSender';

/**
 * Wire contract for the three additive control fields: `mentions`, `edit`
 * and `deleteFor`.
 *
 * Why this file exists rather than more cases in sealedSenderShape.test.ts:
 * the sealed payload is the ONE place a hostile or non-conforming peer gets to
 * choose the shape of data that reaches the store, SQLCipher and every backup
 * mirror downstream. `replyTo.preview` (B-145) shipped unbounded on the receive
 * side for months precisely because the guard only type-checked it. Each of
 * these three fields gets the bound AND the unknown-key rejection here, at the
 * boundary, so nothing downstream has to re-validate.
 *
 * The AAD is deliberately NOT touched by any of this — these ride the same
 * `{to, ts}` stamp reactions use. Changing AAD binding is a CLAUDE.md
 * stop-condition; see messageMutationGate.ts for what carries the security
 * weight instead.
 */

const CERT = 'c.c.c';
const M: SealedMention[] = [{userId: 'u-alice', label: 'Alice'}];

/** Re-seal an arbitrary object as if a peer had produced it. */
function unsealRaw(o: unknown): ReturnType<typeof unsealPayload> {
  return unsealPayload(JSON.stringify(o));
}
const base = {v: 3, cert: CERT, body: ''};

describe('mentions — wire', () => {
  it('round-trips a mention list', () => {
    const p = unsealPayload(sealPayload(CERT, 'hey @Alice', {mentions: M}));
    expect(p.mentions).toEqual(M);
    expect(p.body).toBe('hey @Alice');
  });

  it('omits the field entirely for an empty list', () => {
    // An empty array would round-trip as a meaningful "mentions nobody" and
    // cost bytes on every single send.
    const p = unsealPayload(sealPayload(CERT, 'hi', {mentions: []}));
    expect(p.mentions).toBeUndefined();
    expect(Object.keys(p)).not.toContain('mentions');
  });

  it('rejects a non-array', () => {
    expect(() => unsealRaw({...base, mentions: {userId: 'u', label: 'l'}})).toThrow(CryptoError);
  });

  it('rejects entries missing userId or label, and non-string ones', () => {
    expect(() => unsealRaw({...base, mentions: [{label: 'Alice'}]})).toThrow(CryptoError);
    expect(() => unsealRaw({...base, mentions: [{userId: 'u-a'}]})).toThrow(CryptoError);
    expect(() => unsealRaw({...base, mentions: [{userId: 42, label: 'Alice'}]})).toThrow(CryptoError);
    expect(() => unsealRaw({...base, mentions: [{userId: 'u-a', label: 42}]})).toThrow(CryptoError);
  });

  it('rejects an empty userId — it can never resolve to a real member', () => {
    expect(() => unsealRaw({...base, mentions: [{userId: '', label: 'Alice'}]})).toThrow(CryptoError);
  });

  it('rejects unknown keys inside a mention entry', () => {
    expect(() => unsealRaw({...base, mentions: [{userId: 'u-a', label: 'A', evil: 1}]}))
      .toThrow(CryptoError);
  });

  it('bounds the list length', () => {
    const ok  = Array.from({length: MENTIONS_MAX}, (_, i) => ({userId: `u${i}`, label: `L${i}`}));
    const bad = [...ok, {userId: 'u-extra', label: 'X'}];
    expect(unsealRaw({...base, mentions: ok}).mentions).toHaveLength(MENTIONS_MAX);
    expect(() => unsealRaw({...base, mentions: bad})).toThrow(CryptoError);
  });

  it('bounds the label length', () => {
    const ok  = 'a'.repeat(MENTION_LABEL_MAX_CHARS);
    const bad = 'a'.repeat(MENTION_LABEL_MAX_CHARS + 1);
    expect(unsealRaw({...base, mentions: [{userId: 'u', label: ok}]}).mentions).toHaveLength(1);
    expect(() => unsealRaw({...base, mentions: [{userId: 'u', label: bad}]})).toThrow(CryptoError);
  });

  it('accepts an empty label — the sender may mention by id with no display name', () => {
    expect(unsealRaw({...base, mentions: [{userId: 'u', label: ''}]}).mentions)
      .toEqual([{userId: 'u', label: ''}]);
  });
});

describe('edit — wire', () => {
  const EDIT = {targetMsgId: 't1', body: 'fixed typo', editedAt: 1_700_000_000_000};

  it('round-trips, and carries its own mention list', () => {
    const p = unsealPayload(sealPayload(CERT, '', {edit: {...EDIT, mentions: M}}));
    expect(p.edit).toEqual({...EDIT, mentions: M});
  });

  it('round-trips without mentions', () => {
    expect(unsealPayload(sealPayload(CERT, '', {edit: EDIT})).edit).toEqual(EDIT);
  });

  it('accepts an empty new body — clearing the text is a legitimate edit', () => {
    expect(unsealRaw({...base, edit: {...EDIT, body: ''}}).edit?.body).toBe('');
  });

  it('rejects a missing or empty targetMsgId', () => {
    expect(() => unsealRaw({...base, edit: {body: 'x', editedAt: 1}})).toThrow(CryptoError);
    expect(() => unsealRaw({...base, edit: {...EDIT, targetMsgId: ''}})).toThrow(CryptoError);
  });

  it('rejects wrong-typed fields', () => {
    expect(() => unsealRaw({...base, edit: {...EDIT, body: 42}})).toThrow(CryptoError);
    expect(() => unsealRaw({...base, edit: {...EDIT, editedAt: 'now'}})).toThrow(CryptoError);
    expect(() => unsealRaw({...base, edit: {...EDIT, targetMsgId: 7}})).toThrow(CryptoError);
  });

  it('rejects a non-finite editedAt — it is an ordering key and NaN never orders', () => {
    // NaN survives `typeof === 'number'`, and every comparison against it is
    // false, so a NaN editedAt would defeat the monotonic guard that stops a
    // stale edit resurrecting a superseded body.
    expect(() => unsealRaw({...base, edit: {...EDIT, editedAt: Number.NaN}})).toThrow(CryptoError);
    expect(() => unsealRaw({...base, edit: {...EDIT, editedAt: Infinity}})).toThrow(CryptoError);
  });

  it('bounds the replacement body', () => {
    const bad = 'a'.repeat(EDIT_BODY_MAX_CHARS + 1);
    expect(unsealRaw({...base, edit: {...EDIT, body: 'a'.repeat(EDIT_BODY_MAX_CHARS)}}).edit).toBeDefined();
    expect(() => unsealRaw({...base, edit: {...EDIT, body: bad}})).toThrow(CryptoError);
  });

  it('rejects unknown keys inside edit', () => {
    expect(() => unsealRaw({...base, edit: {...EDIT, senderId: 'u-mallory'}})).toThrow(CryptoError);
  });

  it('validates a nested mention list with the same rules as a top-level one', () => {
    expect(() => unsealRaw({...base, edit: {...EDIT, mentions: [{userId: 'u'}]}})).toThrow(CryptoError);
    expect(() => unsealRaw({...base, edit: {...EDIT, mentions: 'Alice'}})).toThrow(CryptoError);
  });
});

describe('deleteFor — wire', () => {
  const DEL = {targetMsgId: 't1', deletedAt: 1_700_000_000_000};

  it('round-trips', () => {
    expect(unsealPayload(sealPayload(CERT, '', {deleteFor: DEL})).deleteFor).toEqual(DEL);
  });

  it('rejects a missing or empty targetMsgId', () => {
    expect(() => unsealRaw({...base, deleteFor: {deletedAt: 1}})).toThrow(CryptoError);
    expect(() => unsealRaw({...base, deleteFor: {...DEL, targetMsgId: ''}})).toThrow(CryptoError);
  });

  it('rejects wrong-typed or non-finite deletedAt', () => {
    expect(() => unsealRaw({...base, deleteFor: {...DEL, deletedAt: 'now'}})).toThrow(CryptoError);
    expect(() => unsealRaw({...base, deleteFor: {...DEL, deletedAt: Number.NaN}})).toThrow(CryptoError);
  });

  it('rejects unknown keys — notably a "scope" a peer might use to widen the blast radius', () => {
    expect(() => unsealRaw({...base, deleteFor: {...DEL, scope: 'conversation'}})).toThrow(CryptoError);
  });
});

describe('envelope-level shape', () => {
  it('still rejects an unknown TOP-LEVEL key after the three additions', () => {
    // The three new names must have been added to SEALED_PAYLOAD_KEYS without
    // the allow-list itself being loosened.
    expect(() => unsealRaw({...base, mentionz: []})).toThrow(CryptoError);
    expect(() => unsealRaw({...base, editt: {}})).toThrow(CryptoError);
  });

  it('does not touch the AAD block', () => {
    // Stop-condition guard: these envelopes seal with the SAME {to, ts} stamp
    // reactions use. If someone "improves" the binding here, the receiver's
    // expectations change and this goes red.
    const p = unsealPayload(sealPayload(CERT, '', {
      deleteFor: {targetMsgId: 't1', deletedAt: 5},
      aad: {to: {userId: 'bob', deviceId: 1}, ts: 5},
    }));
    expect(p.aad).toEqual({to: {userId: 'bob', deviceId: 1}, ts: 5});
  });

  it('carries all three alongside a group stamp without interference', () => {
    const p = unsealPayload(sealPayload(CERT, 'hi @Alice', {
      mentions: M,
      group: {groupId: 'g1', kind: 'text', clientMsgId: 'cm1'},
    }));
    expect(p.mentions).toEqual(M);
    expect(p.group?.groupId).toBe('g1');
  });
});
