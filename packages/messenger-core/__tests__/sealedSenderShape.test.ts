import {
  sealPayload,
  unsealPayload,
  _getVersionRejectStats,
  CryptoError,
} from '@bravo/messenger-core';
import type {SealedAttachment} from '../src/crypto/sealedSender';

/**
 * White-box branch/path/loop coverage for the sealed-sender envelope
 * shape logic: sealPayload (every optional field), unsealPayload (version
 * boundaries + per-version field strips + reject stats), and isSealedPayload
 * (every field-shape rejection). The crypto roundtrip + AAD semantics live
 * in sealedSender.test.ts; this file targets the pure shape surface.
 */

const ATT: SealedAttachment = {
  objectKey: 'att/abc',
  keyB64: 'a2V5',
  ivB64: 'aXY=',
  mimeType: 'image/jpeg',
  size: 123,
};

describe('sealPayload — optional field population', () => {
  it('throws when the cert is missing', () => {
    expect(() => sealPayload('', 'body')).toThrow(CryptoError);
    expect(() => sealPayload('', 'body')).toThrow(/missing sender cert/);
  });

  it('produces a minimal v3 envelope with only cert + body', () => {
    const p = unsealPayload(sealPayload('c.c.c', 'hi'));
    expect(p).toEqual({v: 3, cert: 'c.c.c', body: 'hi'});
  });

  it('round-trips every optional field', () => {
    const wire = sealPayload('c.c.c', 'hi', {
      attachment: ATT,
      expiresAtSec: 1_700_000_000,
      clientMsgId: 'm1',
      group: {groupId: 'g1', kind: 'admin', clientMsgId: 'gm1'},
      replyTo: {msgId: 'r1', preview: 'prev'},
      reaction: {targetMsgId: 't1', emoji: '👍', remove: true},
      control: 'rehandshake',
      groupCallPresence: {roomId: 'room', participantTag: 'tag', displayName: 'Al', callType: 'video'},
      aad: {to: {userId: 'bob', deviceId: 1}, ts: 1},
    });
    const p = unsealPayload(wire);
    expect(p.attachment).toEqual(ATT);
    expect(p.expiresAtSec).toBe(1_700_000_000);
    expect(p.clientMsgId).toBe('m1');
    expect(p.group).toEqual({groupId: 'g1', kind: 'admin', clientMsgId: 'gm1'});
    expect(p.replyTo).toEqual({msgId: 'r1', preview: 'prev'});
    expect(p.reaction).toEqual({targetMsgId: 't1', emoji: '👍', remove: true});
    expect(p.control).toBe('rehandshake');
    expect(p.groupCallPresence?.callType).toBe('video');
  });

  // Fix #2 regression — expiresAtSec: 0 is a legitimate value (epoch 1970),
  // not "absent". The gate is `typeof === 'number'`, so 0 must round-trip.
  it('preserves expiresAtSec === 0 (does not falsy-drop it)', () => {
    const p = unsealPayload(sealPayload('c.c.c', 'hi', {expiresAtSec: 0}));
    expect(p.expiresAtSec).toBe(0);
  });

  it('omits expiresAtSec when not supplied', () => {
    const p = unsealPayload(sealPayload('c.c.c', 'hi'));
    expect('expiresAtSec' in p).toBe(false);
  });
});

describe('unsealPayload — version handling', () => {
  it('rejects non-JSON input', () => {
    expect(() => unsealPayload('{not json')).toThrow(/not JSON/);
  });

  it('rejects a JSON value that is not an object', () => {
    expect(() => unsealPayload('"a string"')).toThrow(/shape invalid/);
    expect(() => unsealPayload('null')).toThrow(/shape invalid/);
  });

  // Loop/boundary testing on the accepted version range [MIN=1 .. MAX=3].
  it('accepts the minimum supported version (v=1)', () => {
    const p = unsealPayload(JSON.stringify({v: 1, cert: 'c', body: 'b'}));
    expect(p.v).toBe(1);
  });

  it('accepts the maximum supported version (v=3)', () => {
    const p = unsealPayload(JSON.stringify({v: 3, cert: 'c', body: 'b'}));
    expect(p.v).toBe(3);
  });

  it('rejects just below the minimum (v=0) and records reject stats', () => {
    const before = _getVersionRejectStats().count;
    expect(() => unsealPayload(JSON.stringify({v: 0, cert: 'c', body: 'b'}))).toThrow(
      /unsupported sealed version 0/,
    );
    const after = _getVersionRejectStats();
    expect(after.count).toBe(before + 1);
    expect(after.lastVersion).toBe(0);
    expect(after.lastAt).toBeGreaterThan(0);
  });

  it('rejects just above the maximum (v=4) and records reject stats', () => {
    const before = _getVersionRejectStats().count;
    expect(() => unsealPayload(JSON.stringify({v: 4, cert: 'c', body: 'b'}))).toThrow(
      /unsupported sealed version 4/,
    );
    const after = _getVersionRejectStats();
    expect(after.count).toBe(before + 1);
    expect(after.lastVersion).toBe(4);
  });

  // Per-version field strips.
  it('strips attachment + expiresAtSec from a v1 envelope', () => {
    const p = unsealPayload(
      JSON.stringify({v: 1, cert: 'c', body: 'b', attachment: ATT, expiresAtSec: 5}),
    );
    expect(p.attachment).toBeUndefined();
    expect(p.expiresAtSec).toBeUndefined();
  });

  it('keeps attachment + expiresAtSec on a v2 envelope but strips aad', () => {
    const p = unsealPayload(
      JSON.stringify({v: 2, cert: 'c', body: 'b', attachment: ATT, expiresAtSec: 5, aad: {to: {userId: 'x', deviceId: 1}, ts: 1}}),
    );
    expect(p.attachment).toEqual(ATT);
    expect(p.expiresAtSec).toBe(5);
    expect(p.aad).toBeUndefined();
  });
});

describe('isSealedPayload — required field rejections', () => {
  it('rejects when v is not a number', () => {
    expect(() => unsealPayload(JSON.stringify({v: '3', cert: 'c', body: 'b'}))).toThrow(/shape invalid/);
  });
  it('rejects when cert is missing / not a string', () => {
    expect(() => unsealPayload(JSON.stringify({v: 3, body: 'b'}))).toThrow(/shape invalid/);
    expect(() => unsealPayload(JSON.stringify({v: 3, cert: 5, body: 'b'}))).toThrow(/shape invalid/);
  });
  it('rejects when body is missing / not a string', () => {
    expect(() => unsealPayload(JSON.stringify({v: 3, cert: 'c'}))).toThrow(/shape invalid/);
    expect(() => unsealPayload(JSON.stringify({v: 3, cert: 'c', body: 5}))).toThrow(/shape invalid/);
  });
});

describe('isSealedPayload — optional field shape rejections', () => {
  const bad = (extra: Record<string, unknown>) =>
    () => unsealPayload(JSON.stringify({v: 3, cert: 'c', body: 'b', ...extra}));

  it('attachment: non-object', () => expect(bad({attachment: 5})).toThrow(/shape invalid/));
  it('attachment: missing objectKey', () => expect(bad({attachment: {...ATT, objectKey: 5}})).toThrow(/shape invalid/));
  it('attachment: size not a number', () => expect(bad({attachment: {...ATT, size: '1'}})).toThrow(/shape invalid/));

  it('expiresAtSec: wrong type', () => expect(bad({expiresAtSec: 'soon'})).toThrow(/shape invalid/));
  it('clientMsgId: wrong type', () => expect(bad({clientMsgId: 5})).toThrow(/shape invalid/));

  it('group: non-object', () => expect(bad({group: 'g'})).toThrow(/shape invalid/));
  it('group: invalid kind', () => expect(bad({group: {groupId: 'g', kind: 'bogus', clientMsgId: 'm'}})).toThrow(/shape invalid/));
  it('group: missing clientMsgId', () => expect(bad({group: {groupId: 'g', kind: 'text'}})).toThrow(/shape invalid/));

  it('replyTo: non-object', () => expect(bad({replyTo: 1})).toThrow(/shape invalid/));
  it('replyTo: msgId not a string', () => expect(bad({replyTo: {msgId: 1, preview: 'p'}})).toThrow(/shape invalid/));

  it('reaction: non-object', () => expect(bad({reaction: 1})).toThrow(/shape invalid/));
  it('reaction: missing targetMsgId', () => expect(bad({reaction: {emoji: '👍'}})).toThrow(/shape invalid/));
  it('reaction: remove not boolean', () => expect(bad({reaction: {targetMsgId: 't', emoji: '👍', remove: 'yes'}})).toThrow(/shape invalid/));

  it('control: invalid value', () => expect(bad({control: 'other'})).toThrow(/shape invalid/));

  it('groupCallPresence: non-object', () => expect(bad({groupCallPresence: 1})).toThrow(/shape invalid/));
  it('groupCallPresence: invalid callType', () => expect(bad({groupCallPresence: {roomId: 'r', participantTag: 't', displayName: 'd', callType: 'hologram'}})).toThrow(/shape invalid/));

  it('aad: conversationId wrong type', () => expect(bad({aad: {to: {userId: 'b', deviceId: 1}, ts: 1, conversationId: 5}})).toThrow(/shape invalid/));
  it('aad: groupId wrong type', () => expect(bad({aad: {to: {userId: 'b', deviceId: 1}, ts: 1, groupId: 5}})).toThrow(/shape invalid/));
  it('aad: epoch wrong type', () => expect(bad({aad: {to: {userId: 'b', deviceId: 1}, ts: 1, epoch: 'x'}})).toThrow(/shape invalid/));

  it('accepts valid optional fields (positive control for the rejections above)', () => {
    expect(bad({attachment: ATT, clientMsgId: 'm', group: {groupId: 'g', kind: 'text', clientMsgId: 'm'}})).not.toThrow();
  });
});
