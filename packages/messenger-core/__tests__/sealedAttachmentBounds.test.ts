/**
 * `isSealedPayload` — the attachment metadata block and the MM-09 forwarded flag.
 *
 * These are the two slices of the guard that NOTHING executed before this file.
 * `sealedSenderShape.test.ts` covers the five REQUIRED attachment fields
 * (objectKey/keyB64/ivB64/mimeType/size) and stops there; `mentionEditDeleteWire`
 * covers mentions/edit/deleteFor. The optional media-parity hints and
 * `isForwarded` had zero assertions in either project.
 *
 * They matter for two different reasons:
 *
 *  1. TYPE guards on the hints (`kind`, `name`, `width`, `height`, `durationMs`)
 *     are what stop a non-conforming peer reaching the renderer with, e.g.,
 *     `width: "wide"`. The source comment states the intent outright — "wrong-typed
 *     hints must fail validation up front, not crash the renderer".
 *  2. BOUNDS on `name` (256) and `thumbB64` (64 KB) are the only thing between a
 *     hostile sender and unbounded text going straight into the store, SQLCipher
 *     and every subsequent backup mirror. An off-by-one on either bound is
 *     invisible to every other suite.
 *
 * The `isForwarded` tests additionally pin the ASYMMETRY that the SealedGroup
 * doc-comment is built on: the top level rejects unknown keys, the `group`
 * carrier does not. A change that adds key-iteration to the group branch would
 * destroy messages on older peers — these tests go red for it.
 *
 * Every case drives the real `sealPayload` / `unsealPayload` — no source scanning.
 */

import {sealPayload, unsealPayload} from '../src/crypto/sealedSender';
import type {SealedAttachment} from '../src/crypto/sealedSender';

const ATT: SealedAttachment = {
  objectKey: 'r2/abc',
  keyB64:    'a2V5',
  ivB64:     'aXY=',
  mimeType:  'image/jpeg',
  size:      1024,
};

/** Build a wire string directly so we can inject shapes sealPayload's types forbid. */
function wire(extra: Record<string, unknown>): string {
  return JSON.stringify({v: 3, cert: 'c', body: 'b', ...extra});
}
const parse = (extra: Record<string, unknown>) => () => unsealPayload(wire(extra));

describe('attachment metadata — wrong-typed display hints are refused at the guard', () => {
  it('accepts an attachment carrying every optional hint at a legal type', () => {
    const out = unsealPayload(wire({
      attachment: {
        ...ATT,
        kind: 'image', name: 'brief.pdf', width: 1080, height: 1920,
        durationMs: 4500, thumbB64: 'AAAA',
      },
    }));
    expect(out.attachment).toMatchObject({
      kind: 'image', name: 'brief.pdf', width: 1080, height: 1920,
      durationMs: 4500, thumbB64: 'AAAA',
    });
  });

  it('accepts an attachment with NO optional hints (the pre-parity wire shape)', () => {
    expect(unsealPayload(wire({attachment: ATT})).attachment).toEqual(ATT);
  });

  it.each([
    ['kind as a number',        {kind: 3}],
    ['kind as an object',       {kind: {t: 'image'}}],
    ['name as a number',        {name: 42}],
    ['width as a string',       {width: '1080'}],
    ['height as a string',      {height: '1920'}],
    ['height as null',          {height: null}],
    ['durationMs as a string',  {durationMs: '4500'}],
    ['thumbB64 as a number',    {thumbB64: 12345}],
    ['thumbB64 as an object',   {thumbB64: {b: 'x'}}],
  ])('rejects the whole envelope when the attachment carries %s', (_label, patch) => {
    expect(parse({attachment: {...ATT, ...patch}})).toThrow(/shape invalid/);
  });

  it('treats an explicitly-undefined hint as absent, not as a wrong type', () => {
    // JSON.stringify drops undefined, so build the object post-parse-shape:
    // the guard's `!== undefined` checks must not fire on a missing key.
    const out = unsealPayload(wire({attachment: {...ATT, kind: undefined}}));
    expect(out.attachment?.kind).toBeUndefined();
  });
});

describe('attachment metadata — the two size bounds', () => {
  it('accepts a filename of exactly 256 chars and rejects 257 (off-by-one on `name`)', () => {
    expect(parse({attachment: {...ATT, name: 'n'.repeat(256)}})).not.toThrow();
    expect(parse({attachment: {...ATT, name: 'n'.repeat(257)}})).toThrow(/shape invalid/);
  });

  it('accepts a thumbnail of exactly 64 KB of base64 and rejects one byte more', () => {
    const cap = 64 * 1024;
    expect(parse({attachment: {...ATT, thumbB64: 't'.repeat(cap)}})).not.toThrow();
    expect(parse({attachment: {...ATT, thumbB64: 't'.repeat(cap + 1)}})).toThrow(/shape invalid/);
  });

  it('refuses a multi-megabyte "thumbnail" — the abuse case the bound exists for', () => {
    expect(parse({attachment: {...ATT, thumbB64: 't'.repeat(4 * 1024 * 1024)}}))
      .toThrow(/shape invalid/);
  });

  it('accepts an empty name and an empty thumb — absent-ish is not an error', () => {
    expect(parse({attachment: {...ATT, name: '', thumbB64: ''}})).not.toThrow();
  });
});

describe('MM-09 isForwarded — top level', () => {
  it('sealPayload stamps the flag only when it is literally true', () => {
    expect(JSON.parse(sealPayload('c', 'b', {isForwarded: true})).isForwarded).toBe(true);
    // false must not cost bytes on every send.
    expect('isForwarded' in JSON.parse(sealPayload('c', 'b', {isForwarded: false}))).toBe(false);
    expect('isForwarded' in JSON.parse(sealPayload('c', 'b', {}))).toBe(false);
  });

  it('round-trips true through seal → unseal', () => {
    expect(unsealPayload(sealPayload('c', 'b', {isForwarded: true})).isForwarded).toBe(true);
  });

  it('accepts an explicit false on the wire (a peer that stamps it unconditionally)', () => {
    expect(unsealPayload(wire({isForwarded: false})).isForwarded).toBe(false);
  });

  it.each([
    ['a string',  'true'],
    ['a number',  1],
    ['an object', {}],
    ['an array',  []],
  ])('rejects isForwarded as %s', (_label, value) => {
    expect(parse({isForwarded: value})).toThrow(/shape invalid/);
  });

  it('is in the top-level allowlist — an envelope carrying it is NOT destroyed', () => {
    // The whole reason MM-09 also lives on the group carrier: a key absent from
    // SEALED_PAYLOAD_KEYS makes the guard reject the entire envelope.
    expect(parse({isForwarded: true})).not.toThrow();
    expect(parse({wasForwarded: true})).toThrow(/shape invalid/);
  });
});

describe('MM-09 isForwarded — the group wire-compat carrier', () => {
  const GROUP = {groupId: 'g1', kind: 'text' as const, clientMsgId: 'm1'};

  it('round-trips on the group object', () => {
    const out = unsealPayload(wire({group: {...GROUP, isForwarded: true}}));
    expect(out.group?.isForwarded).toBe(true);
  });

  it('rejects a wrong-typed group.isForwarded', () => {
    expect(parse({group: {...GROUP, isForwarded: 'yes'}})).toThrow(/shape invalid/);
    expect(parse({group: {...GROUP, isForwarded: 1}})).toThrow(/shape invalid/);
  });

  it('IGNORES an unknown key inside `group` — degrading beats destroying', () => {
    // The group branch deliberately does NOT iterate keys. If someone adds that
    // iteration, every peer built before the next field lands starts DESTROYING
    // messages instead of rendering them plainly. This test is that tripwire.
    const out = unsealPayload(wire({
      group: {...GROUP, someFieldFromAFutureBuild: {nested: [1, 2, 3]}},
    }));
    expect(out.group?.groupId).toBe('g1');
    expect(out.body).toBe('b');
  });

  it('still type-checks the KNOWN group fields while ignoring unknown ones', () => {
    expect(parse({group: {...GROUP, kind: 'bogus', futureThing: 1}})).toThrow(/shape invalid/);
    expect(parse({group: {...GROUP, groupId: 7, futureThing: 1}})).toThrow(/shape invalid/);
  });

  it('carries isForwarded alongside mentions/edit without interference', () => {
    const out = unsealPayload(wire({
      group: {
        ...GROUP,
        isForwarded: true,
        mentions:    [{userId: 'u1', label: 'Ali'}],
        edit:        {targetMsgId: 't1', body: 'fixed', editedAt: 1},
      },
    }));
    expect(out.group?.isForwarded).toBe(true);
    expect(out.group?.mentions).toEqual([{userId: 'u1', label: 'Ali'}]);
    expect(out.group?.edit?.body).toBe('fixed');
  });
});

describe('sealPayload — the full option surface reaches the wire', () => {
  it('carries every optional field through seal → unseal in one envelope', () => {
    const sealed = sealPayload('cert-x', 'hello', {
      attachment:   {...ATT, name: 'doc.pdf', thumbB64: 'AA'},
      expiresAtSec: 0,
      clientMsgId:  'cm1',
      group:        {groupId: 'g', kind: 'text', clientMsgId: 'cm1', isForwarded: true},
      replyTo:      {msgId: 'r1', preview: 'prev'},
      isForwarded:  true,
      reaction:     {targetMsgId: 't', emoji: '👍', remove: true},
      mentions:     [{userId: 'u', label: 'U'}],
      edit:         {targetMsgId: 't', body: 'e', editedAt: 2},
      deleteFor:    {targetMsgId: 't', deletedAt: 3},
      control:      'rehandshake',
      groupCallPresence: {roomId: 'r', participantTag: 'p', displayName: 'D', callType: 'video'},
      aad:          {to: {userId: 'me', deviceId: 1}, ts: 1000},
    });
    const out = unsealPayload(sealed);
    expect(out.v).toBe(3);
    expect(out.expiresAtSec).toBe(0);
    expect(out.isForwarded).toBe(true);
    expect(out.group?.isForwarded).toBe(true);
    expect(out.attachment?.thumbB64).toBe('AA');
    expect(out.control).toBe('rehandshake');
    expect(out.groupCallPresence?.callType).toBe('video');
    expect(out.aad?.to.deviceId).toBe(1);
  });

  it('drops an empty mention list but keeps a populated one', () => {
    expect('mentions' in JSON.parse(sealPayload('c', 'b', {mentions: []}))).toBe(false);
    expect(JSON.parse(sealPayload('c', 'b', {mentions: [{userId: 'u', label: 'U'}]})).mentions)
      .toHaveLength(1);
  });
});
