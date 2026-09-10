/**
 * RT-3 (XO-1 + XO-2) — the drain's routing decision.
 *
 * `planOutboxDrain` replaced the inline branching in drainOutbox and MUST
 * reproduce the pre-existing SN-06/A4 semantics byte-for-byte — the SN-06
 * regression set below is the pin. The XO-1/XO-2 sets cover the two new
 * shapes: sealed 1:1/reaction rows that can now be re-minted after their cert
 * aged out, and deferred send-intents written when crypto prep failed offline.
 */

import {
  isDeferredDirect,
  isUnresealableDeferred,
  planOutboxDrain,
  buildDirectSealedOutboxPayload,
  buildReactionSealedOutboxPayload,
} from '../runtime/deferredOutbox';
import {OUTBOX_CERT_RESEAL_MARGIN_SEC} from '../runtime/outboxCertFreshness';

const NOW_MS  = 1_800_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);
const FRESH   = NOW_SEC + 3600;
const STALE   = NOW_SEC - 3600;

describe('isDeferredDirect', () => {
  it('is true for a direct deferred payload', () => {
    expect(isDeferredDirect({deferred: true, direct: true, body: 'hi', clientMsgId: 'm1'})).toBe(true);
  });
  it('is false for a group deferred payload', () => {
    expect(isDeferredDirect({deferred: true, sealedBody: 'sb', groupId: 'g1', kind: 'text', clientMsgId: 'm1'})).toBe(false);
  });
});

describe('isUnresealableDeferred', () => {
  it('is false for both well-formed deferred shapes', () => {
    expect(isUnresealableDeferred({deferred: true, direct: true, body: '', clientMsgId: 'm1'})).toBe(false);
    expect(isUnresealableDeferred({deferred: true, sealedBody: 'sb', groupId: 'g1', kind: 'text', clientMsgId: 'm1'})).toBe(false);
  });
  it('is true for a direct deferred row with no body (downgrade shape)', () => {
    expect(isUnresealableDeferred({deferred: true, direct: true} as never)).toBe(true);
  });
  it('is true for a bare deferred row with no group body', () => {
    expect(isUnresealableDeferred({deferred: true} as never)).toBe(true);
  });
  it('is false for a non-deferred payload', () => {
    expect(isUnresealableDeferred({outerSealed: 'X'} as never)).toBe(false);
  });
});

describe('planOutboxDrain — SN-06 regression set (must not change)', () => {
  it('ships a pre-SN-06 row with no certExpSec (upgrade safety)', () => {
    const plan = planOutboxDrain(JSON.stringify({outerSealed: 'X'}), NOW_MS);
    expect(plan).toEqual({mode: 'ship', outerSealed: 'X', expiresAtSec: undefined});
  });

  it('ships a sealed row with a comfortably-fresh cert', () => {
    const plan = planOutboxDrain(
      JSON.stringify({outerSealed: 'X', expiresAtSec: 123, certExpSec: FRESH}), NOW_MS);
    expect(plan).toEqual({mode: 'ship', outerSealed: 'X', expiresAtSec: 123});
  });

  it('re-seals a stale group row that carries its re-mint inputs', () => {
    const plan = planOutboxDrain(
      JSON.stringify({outerSealed: 'X', certExpSec: STALE, sealedBody: 'sb', groupId: 'g1', kind: 'text', clientMsgId: 'm1'}),
      NOW_MS);
    expect(plan.mode).toBe('reseal');
    if (plan.mode === 'reseal') {
      expect(plan.staleCert).toBe(true);
      expect(plan.payload.sealedBody).toBe('sb');
    }
  });

  it('fails loudly on a stale row with nothing to re-mint from', () => {
    const plan = planOutboxDrain(
      JSON.stringify({outerSealed: 'X', certExpSec: STALE}), NOW_MS);
    expect(plan).toEqual({mode: 'fail', reason: 'cert_expired_unresealable'});
  });

  it('treats the margin boundary as stale (re-seal, for a group shape)', () => {
    const plan = planOutboxDrain(
      JSON.stringify({
        outerSealed: 'X',
        certExpSec:  NOW_SEC + OUTBOX_CERT_RESEAL_MARGIN_SEC,
        sealedBody:  'sb',
        groupId:     'g1',
      }),
      NOW_MS);
    expect(plan.mode).toBe('reseal');
  });

  it('ships one second beyond the margin', () => {
    const plan = planOutboxDrain(
      JSON.stringify({outerSealed: 'X', certExpSec: NOW_SEC + OUTBOX_CERT_RESEAL_MARGIN_SEC + 1}),
      NOW_MS);
    expect(plan.mode).toBe('ship');
  });
});

describe('planOutboxDrain — XO-1 stale sealed 1:1/reaction rows', () => {
  it('re-seals a stale direct row', () => {
    const plan = planOutboxDrain(
      JSON.stringify({outerSealed: 'X', certExpSec: STALE, resealKind: 'direct', body: 'hi', clientMsgId: 'm1'}),
      NOW_MS);
    expect(plan.mode).toBe('reseal');
    if (plan.mode === 'reseal') { expect(plan.staleCert).toBe(true); }
  });

  it("re-seals a stale direct row with an empty body (media caption is legitimately '')", () => {
    // A truthiness check here would silently drop every image send.
    const plan = planOutboxDrain(
      JSON.stringify({outerSealed: 'X', certExpSec: STALE, resealKind: 'direct', body: '', clientMsgId: 'm1'}),
      NOW_MS);
    expect(plan.mode).toBe('reseal');
  });

  it('re-seals a stale reaction row', () => {
    const plan = planOutboxDrain(
      JSON.stringify({
        outerSealed: 'X', certExpSec: STALE, resealKind: 'reaction',
        reaction: {targetMsgId: 't1', emoji: '👍'}, clientMsgId: 'm1',
      }),
      NOW_MS);
    expect(plan.mode).toBe('reseal');
  });

  it('fails loudly on a stale reaction row missing its directive', () => {
    const plan = planOutboxDrain(
      JSON.stringify({outerSealed: 'X', certExpSec: STALE, resealKind: 'reaction', clientMsgId: 'm1'}),
      NOW_MS);
    expect(plan).toEqual({mode: 'fail', reason: 'cert_expired_unresealable'});
  });

  it('ships fresh-cert rows of every shape', () => {
    for (const extra of [
      {resealKind: 'direct', body: 'hi'},
      {resealKind: 'reaction', reaction: {targetMsgId: 't1', emoji: '👍'}},
      {sealedBody: 'sb', groupId: 'g1'},
    ]) {
      const plan = planOutboxDrain(
        JSON.stringify({outerSealed: 'X', certExpSec: FRESH, ...extra}), NOW_MS);
      expect(plan.mode).toBe('ship');
    }
  });
});

describe('planOutboxDrain — XO-2 deferred send intents', () => {
  it('re-seals a direct deferred payload (not stale — there are no bytes yet)', () => {
    const plan = planOutboxDrain(
      JSON.stringify({deferred: true, direct: true, body: 'hi', clientMsgId: 'm1'}), NOW_MS);
    expect(plan.mode).toBe('reseal');
    if (plan.mode === 'reseal') {
      expect(plan.staleCert).toBe(false);
      expect(isDeferredDirect(plan.payload)).toBe(true);
    }
  });

  it('re-seals a group deferred payload (A4 regression)', () => {
    const plan = planOutboxDrain(
      JSON.stringify({deferred: true, sealedBody: 'sb', groupId: 'g1', kind: 'text', clientMsgId: 'm1'}),
      NOW_MS);
    expect(plan.mode).toBe('reseal');
    if (plan.mode === 'reseal') {
      expect(plan.staleCert).toBe(false);
      expect(isDeferredDirect(plan.payload)).toBe(false);
    }
  });

  it('drops unparseable and non-object payloads as corrupt', () => {
    expect(planOutboxDrain('{', NOW_MS)).toEqual({mode: 'drop', reason: 'corrupt'});
    expect(planOutboxDrain('null', NOW_MS)).toEqual({mode: 'drop', reason: 'corrupt'});
  });

  it('drops a shapeless payload as no_payload', () => {
    expect(planOutboxDrain('{}', NOW_MS)).toEqual({mode: 'drop', reason: 'no_payload'});
  });

  it('drops the downgrade shape (deferred direct with no body) as unresealable', () => {
    const plan = planOutboxDrain(JSON.stringify({deferred: true, direct: true}), NOW_MS);
    expect(plan).toEqual({mode: 'drop', reason: 'unresealable'});
  });
});

describe('planOutboxDrain — GF-2 key-material rows', () => {
  it('ships a fresh-cert key row with its flags intact', () => {
    const plan = planOutboxDrain(
      JSON.stringify({outerSealed: 'X', certExpSec: FRESH, keyMaterial: true, urgent: false}),
      NOW_MS);
    expect(plan).toEqual({
      mode: 'ship', outerSealed: 'X', expiresAtSec: undefined, keyMaterial: true, urgent: false,
    });
  });

  it('DROPS a stale-cert key row instead of re-minting or budget-burning', () => {
    // A key row deliberately persists no re-mintable body (the group key is
    // never duplicated at rest); the GF-3 self-heal re-solicits the key.
    const plan = planOutboxDrain(
      JSON.stringify({outerSealed: 'X', certExpSec: STALE, keyMaterial: true}),
      NOW_MS);
    expect(plan).toEqual({mode: 'drop', reason: 'stale_key_material'});
  });

  it('legacy text rows carry no urgent/keyMaterial flags on the ship action', () => {
    const plan = planOutboxDrain(JSON.stringify({outerSealed: 'X'}), NOW_MS);
    expect(plan.mode).toBe('ship');
    if (plan.mode === 'ship') {
      expect(plan.keyMaterial).toBeUndefined();
      expect(plan.urgent).toBeUndefined();
    }
  });
});

describe('log hygiene', () => {
  it('the routing module never logs (its inputs can carry plaintext bodies)', () => {
    for (const fn of [planOutboxDrain, isDeferredDirect, isUnresealableDeferred,
      buildDirectSealedOutboxPayload, buildReactionSealedOutboxPayload]) {
      expect(String(fn)).not.toMatch(/console\./);
    }
  });
});
