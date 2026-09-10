/**
 * RT-3 / XO-1 — the 1:1 and reaction enqueue sites must persist the cert
 * freshness metadata + re-mint inputs, or the drain classifies their rows
 * "fresh forever" and ships a dead cert (silent loss behind a 'sent' tick).
 *
 * productionRuntime.ts is not importable under Jest (native op-sqlite), so
 * the payloads are built by pure builders in deferredOutbox.ts and the sites
 * are pinned through them: whatever the builders emit is exactly what
 * `sqlOutbox.enqueue` stringifies.
 */

import {
  buildDirectSealedOutboxPayload,
  buildReactionSealedOutboxPayload,
  planOutboxDrain,
} from '../runtime/deferredOutbox';

const NOW_MS  = 1_800_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);

describe('XO-1 — 1:1 enqueue payload', () => {
  const payload = buildDirectSealedOutboxPayload({
    outerSealed:  'SEALED',
    expiresAtSec: NOW_SEC + 86_400,
    certExpSec:   NOW_SEC + 3600,
    body:         'hello',
    replyTo:      {msgId: 'r1', preview: 'earlier'},
    clientMsgId:  'm1',
  });

  it('carries the sealed bytes, freshness metadata and every re-mint input', () => {
    expect(payload).toMatchObject({
      outerSealed: 'SEALED',
      certExpSec:  NOW_SEC + 3600,
      resealKind:  'direct',
      body:        'hello',
      replyTo:     {msgId: 'r1', preview: 'earlier'},
      clientMsgId: 'm1',
    });
  });

  it('ships while the cert is fresh, re-seals once it ages out', () => {
    const raw = JSON.stringify(payload);
    expect(planOutboxDrain(raw, NOW_MS).mode).toBe('ship');
    // 2h later — past the ~1h cert TTL. The pre-RT-3 row shape shipped a dead
    // cert here; the new shape re-mints.
    const later = planOutboxDrain(raw, NOW_MS + 2 * 3600 * 1000);
    expect(later.mode).toBe('reseal');
  });

  it('keeps an empty media caption re-sealable', () => {
    const media = buildDirectSealedOutboxPayload({
      outerSealed: 'SEALED', certExpSec: NOW_SEC - 1, body: '', clientMsgId: 'm2',
    });
    expect(planOutboxDrain(JSON.stringify(media), NOW_MS).mode).toBe('reseal');
  });
});

describe('XO-1 — reaction enqueue payload', () => {
  it('carries the directive and re-seals after the cert ages out', () => {
    const payload = buildReactionSealedOutboxPayload({
      outerSealed: 'SEALED',
      certExpSec:  NOW_SEC + 3600,
      reaction:    {targetMsgId: 't1', emoji: '👍', remove: false},
      clientMsgId: 'm3',
    });
    expect(payload.resealKind).toBe('reaction');
    const raw = JSON.stringify(payload);
    expect(planOutboxDrain(raw, NOW_MS).mode).toBe('ship');
    expect(planOutboxDrain(raw, NOW_MS + 2 * 3600 * 1000).mode).toBe('reseal');
  });

  it('preserves the group stamp for group reactions and omits it for 1:1', () => {
    const grouped = buildReactionSealedOutboxPayload({
      outerSealed: 'S', certExpSec: NOW_SEC,
      reaction:    {targetMsgId: 't1', emoji: '👍'},
      group:       {groupId: 'g1', kind: 'text', clientMsgId: 'm4'},
      clientMsgId: 'm4',
    });
    expect(grouped.group).toEqual({groupId: 'g1', kind: 'text', clientMsgId: 'm4'});
    const direct = buildReactionSealedOutboxPayload({
      outerSealed: 'S', certExpSec: NOW_SEC,
      reaction:    {targetMsgId: 't1', emoji: '👍'},
      clientMsgId: 'm5',
    });
    // JSON round-trip drops the undefined key — the wire/DB shape stays clean.
    expect(JSON.parse(JSON.stringify(direct)).group).toBeUndefined();
  });
});

describe('downgrade safety', () => {
  it('an old build reading a new row still finds outerSealed + expiresAtSec', () => {
    const payload = buildDirectSealedOutboxPayload({
      outerSealed: 'SEALED', expiresAtSec: 42, certExpSec: NOW_SEC + 3600,
      body: 'x', clientMsgId: 'm6',
    });
    const legacyView = JSON.parse(JSON.stringify(payload)) as {outerSealed: string; expiresAtSec: number};
    expect(legacyView.outerSealed).toBe('SEALED');
    expect(legacyView.expiresAtSec).toBe(42);
  });
});
