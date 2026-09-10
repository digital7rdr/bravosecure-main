/**
 * MM-09 — "Forwarded" label wire parity (the B-144 lesson, applied at birth).
 *
 * The flag is display metadata riding the SEALED payload:
 *  - 1:1 lane: top-level `isForwarded` (a NEW top-level key — peers on builds
 *    predating its allowlist entry reject the payload; same rollout class as
 *    `edit`/`deleteFor` when they shipped).
 *  - group lane: INSIDE the `group` wire-compat carrier, never top-level —
 *    a top-level key is fatal to older peers (field-confirmed for mentions),
 *    while the carrier is ignored gracefully.
 *  - every outbox writer persists it and every drain re-seal re-emits it, so
 *    a forward queued offline still arrives labelled.
 *
 * `productionRuntime.ts` cannot be imported by a node test (native deps), so
 * the send-side is pinned by source scan exactly like replyWireParity.
 * Line-based/indexOf on purpose: these files are CRLF.
 */

import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {buildInboundMessage} from '../runtime/inboundMessageBuilder';
import {sealPayload} from '@bravo/messenger-core';

const RUNTIME = join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts');
const OUTBOX  = join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'deferredOutbox.ts');
const CHAT    = join(process.cwd(), 'src', 'screens', 'messenger', 'ChatScreen.tsx');

function runtimeSrc(): string { return readFileSync(RUNTIME, 'utf8'); }

function sendTextBody(): string {
  const src = runtimeSrc();
  const start = src.indexOf('sendText: async');
  const end = src.indexOf('sendMedia:', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('MM-09 — forwarded-flag wire parity (static source scan)', () => {
  it('census: every fwdFlag-carrying site in sendText is accounted for', () => {
    // 7 explicit sites: group no-cert deferred row, group crypto-fail deferred
    // row, group SN-06 stored-bytes row, direct live seal, direct deferred
    // row, direct sealed-outbox row, multi-device direct seal. The group LIVE
    // seal is the 8th — it rides the carrier spread asserted below. If a lane
    // is added or removed, RECLASSIFY here in the same commit — never just
    // bump the number.
    const sites = sendTextBody().match(/isForwarded:\s+fwdFlag/g) ?? [];
    expect(sites).toHaveLength(7);
  });

  it('the group LIVE seal rides the carrier, and no group lane emits a top-level key', () => {
    const body = sendTextBody();
    expect(body).toContain('...(fwdFlag ? {isForwarded: true} : {})');
  });

  it('BOTH local appends persist is_forwarded on the sender bubble', () => {
    const sites = sendTextBody().match(/is_forwarded:\s+fwdFlag/g) ?? [];
    expect(sites).toHaveLength(2);
  });

  it('the drain re-seal re-emits the flag on both branches (queued forwards stay labelled)', () => {
    const src = runtimeSrc();
    // Direct branch — top-level, exact-true normalised.
    expect(src).toContain('isForwarded:  payload.isForwarded === true ? true : undefined');
    // Group branch — inside the carrier.
    expect(src).toContain('...(payload.isForwarded ? {isForwarded: true} : {})');
  });

  it('every outbox shape can carry the flag (a row written without it loses it for good)', () => {
    const src = readFileSync(OUTBOX, 'utf8');
    const slice = (anchor: string): string => {
      const start = src.indexOf(anchor);
      expect(start).toBeGreaterThan(-1);
      return src.slice(start, src.indexOf('\n}', start));
    };
    expect(slice('export interface DeferredDirectOutboxPayload')).toContain('isForwarded');
    expect(slice('export interface DeferredGroupOutboxPayload')).toContain('isForwarded');
    expect(slice('export interface ResealableOutboxPayload')).toContain('isForwarded');
    expect(slice('export function buildDirectSealedOutboxPayload')).toContain('isForwarded');
  });
});

describe('MM-09 — sealed payload carries the flag (messenger-core)', () => {
  it('1:1: stamps only an exact true — false costs no bytes', () => {
    expect(JSON.parse(sealPayload('cert', 'hi', {isForwarded: true})).isForwarded).toBe(true);
    expect('isForwarded' in JSON.parse(sealPayload('cert', 'hi', {}))).toBe(false);
    expect('isForwarded' in JSON.parse(sealPayload('cert', 'hi', {isForwarded: false}))).toBe(false);
  });

  it('group: rides inside the carrier object verbatim', () => {
    const parsed = JSON.parse(sealPayload('cert', 'hi', {
      group: {groupId: 'g1', kind: 'text', clientMsgId: 'm1', isForwarded: true},
    }));
    expect(parsed.group.isForwarded).toBe(true);
    expect('isForwarded' in parsed).toBe(false);
  });
});

describe('MM-09 — inbound mapping (carrier first, top level second)', () => {
  const build = (env: Record<string, unknown>) => buildInboundMessage({
    env,
    conversationId: 'c1',
    peer: {userId: 'peer', deviceId: 1},
    content: 'hello',
    createdAt: '2026-07-28T10:00:00.000Z',
    envelopeId: 'env-1',
    makeId: () => 'mid-1',
  } as never);

  it('top-level true (1:1 lane) renders the chip', () => {
    expect(build({isForwarded: true}).is_forwarded).toBe(true);
  });

  it('carrier true (group lane) renders the chip', () => {
    expect(build({group: {isForwarded: true}}).is_forwarded).toBe(true);
  });

  it('absent stays absent — never a stored false', () => {
    expect(build({}).is_forwarded).toBeUndefined();
    expect(build({isForwarded: false}).is_forwarded).toBeUndefined();
  });
});

describe('MM-09 — ChatScreen forward flow ships the flag, not a body prefix', () => {
  const chat = readFileSync(CHAT, 'utf8');

  it('both production forward sends pass isForwarded: true', () => {
    const sites = chat.match(/isForwarded: true/g) ?? [];
    expect(sites.length).toBeGreaterThanOrEqual(2);
  });

  it('the local-fake branch stamps the row', () => {
    expect(chat).toMatch(/is_forwarded:\s+true,/);
  });

  it('the "↪ Forwarded" body-prefix hack is gone', () => {
    expect(chat).not.toContain('↪ Forwarded');
  });

  it('the bubble renders the chip off msg.is_forwarded', () => {
    expect(chat).toContain('msg.is_forwarded && (');
    expect(chat).toContain('>Forwarded</Text>');
  });
});
