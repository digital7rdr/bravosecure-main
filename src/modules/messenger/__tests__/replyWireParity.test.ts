/**
 * Reply metadata wire parity — direct vs group send lane (B-144).
 *
 * `sendText` persists `reply_to_msg_id`/`reply_to_preview` on the
 * sender's OWN bubble in both branches, but ships `replyTo` inside the
 * sealed payload only on the DIRECT lanes. The group lane omits it in
 * both layers (the group-encrypted inner envelope and the per-recipient
 * outer seal) and the deferred group outbox shape cannot even carry it —
 * so every group recipient renders a reply as a plain message: no quote
 * strip, no reply-jump. The author sees their local quote, which is
 * exactly why this never surfaced in manual testing.
 *
 * `productionRuntime.ts` cannot be imported by a node test (native
 * deps), so this pins the seam the same way messageTopologyInvariants
 * does — by reading the source. The DOCUMENTS cases assert the CURRENT
 * (buggy) shape; when B-144 is fixed, flip them to require `replyTo` in
 * the group layers instead.
 *
 * Behavioural rider: the receive side applies NO length cap to the
 * quoted preview (the sender caps at 200), pinned via
 * buildInboundMessage below (B-145).
 */

import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {buildInboundMessage, REPLY_PREVIEW_MAX_CHARS} from '../runtime/inboundMessageBuilder';

const RUNTIME = join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts');
const OUTBOX  = join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'deferredOutbox.ts');

function sendTextBody(): string {
  const src = readFileSync(RUNTIME, 'utf8');
  const start = src.indexOf('sendText: async');
  const end = src.indexOf('sendMedia:', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('B-144 — reply wire parity (static source scan)', () => {
  it('census: every reply-carrying site in sendText is accounted for', () => {
    // Ratchet, in the shape of the M10 exit census. 8 = the four DIRECT
    // lanes (live seal, deferred, sealed-outbox, multi-device) that always
    // had it, plus the four GROUP sites B-144 added (live seal + the three
    // outbox writers whose rows the drain re-seals from).
    // If a lane is added or removed, RECLASSIFY it here in the same
    // commit — never just bump the number to make this pass.
    const sites = sendTextBody().match(/replyTo:\s+replyMeta/g) ?? [];
    expect(sites).toHaveLength(8);
  });

  it('control: BOTH branches persist the reply on the sender\'s local bubble', () => {
    const sites = sendTextBody().match(/reply_to_msg_id/g) ?? [];
    expect(sites.length).toBeGreaterThanOrEqual(2);
  });

  it('B-450: sendMedia is a reply-carrying site the census above CANNOT see', () => {
    // RECLASSIFIED, not loosened. B-450 made `sendMedia` carry a quote too, so
    // the file now has a ninth reply-carrying site — but the census window ENDS
    // at `sendMedia:` by construction, so the count stayed 8 and would have
    // stayed 8 no matter what that lane did. Left at 8 deliberately: widening
    // the window would mix two different rules (sendText's per-lane fan-out
    // parity vs. sendMedia's single handoff) into one number.
    //
    // What makes the media lane safe is that it does NOT re-implement fan-out:
    // it hands `replyTo` to sendText, so all 8 sites above serve it unchanged,
    // group outer seal and outbox writers included. That handoff, and the
    // bubble stamp sendText skips when given `existingMsgId`, are pinned in
    // `mediaReplyAffordance.test.ts` (B-450).
    const src = readFileSync(RUNTIME, 'utf8');
    const media = src.slice(src.indexOf('sendMedia: async'), src.indexOf('downloadMedia: async'));
    expect(media).toMatch(/replyTo:\s+mediaOpts\?\.replyTo/);
    // The census's own regex must keep missing it — a `replyTo: replyMeta` here
    // would mean the media lane grew a fan-out of its own.
    expect(media.match(/replyTo:\s+replyMeta/g) ?? []).toHaveLength(0);
  });

  it('B-144 FIXED: the group outer seal ships replyTo', () => {
    // The fix rides the OUTER per-recipient seal, next to `attachment` —
    // both are inside the pairwise Signal envelope, and the receiver's
    // buildInboundMessage has always read `env.replyTo` off exactly this
    // object. That is why no inbound change was needed.
    const body = sendTextBody();
    const start = body.indexOf('sealPayload(cert, sealedBody, {');
    expect(start).toBeGreaterThan(-1);
    // 55 lines comfortably spans the whole options object (incl. aad).
    const window = body.slice(start).split('\n').slice(0, 55).join('\n');
    expect(window).toContain('attachment:');
    expect(window).toContain('aad:');
    expect(window).toMatch(/replyTo:\s+replyMeta/);
  });

  it('B-144 FIXED: the deferred GROUP outbox shape can carry a reply, like the DIRECT one', () => {
    const src = readFileSync(OUTBOX, 'utf8');
    const slice = (anchor: string): string => {
      const start = src.indexOf(anchor);
      expect(start).toBeGreaterThan(-1);
      return src.slice(start, src.indexOf('\n}', start));
    };
    expect(slice('export interface DeferredDirectOutboxPayload')).toContain('replyTo');
    expect(slice('export interface DeferredGroupOutboxPayload')).toContain('replyTo');
  });

  it('B-144 FIXED: every GROUP outbox writer persists replyTo for the drain', () => {
    // Three writers: the no-cert deferred row, the per-peer crypto-fail
    // deferred row, and the SN-06 stored-bytes row whose stale cert is
    // re-minted later. A row written without replyTo loses the quote no
    // matter what the reseal does, so each is checked individually rather
    // than by a count that a 4th writer could silently satisfy.
    const body = sendTextBody();
    // The three writers are precisely the sites that pass `sealedBody` as a
    // SHORTHAND property on its own line. The live seal passes it as an
    // ARGUMENT (`sealPayload(cert, sealedBody, {`) and the prep helper
    // returns `sealedBody: sb`, so neither is caught here.
    // Line-based on purpose: this file is CRLF, so a `\n`-anchored regex
    // silently matches nothing and the test would pass vacuously.
    const lines = body.split(/\r?\n/);
    const starts = lines
      .map((l, i) => (/^\s*sealedBody,\s*$/.test(l) ? i : -1))
      .filter(i => i >= 0);
    expect(starts).toHaveLength(3);
    for (const start of starts) {
      // The row literal is short; 20 lines covers it and its closing brace.
      const row = lines.slice(start, start + 20).join('\n');
      expect(row).toContain('groupId:');
      expect(row).toMatch(/replyTo:\s+replyMeta/);
    }
  });

  it('B-144 FIXED: the group RESEAL branch carries replyTo like the direct branch', () => {
    // resealOutboxRow is outside sendText — scan the whole file.
    const src = readFileSync(RUNTIME, 'utf8');
    const start = src.indexOf('sealPayload(freshCert, payload.sealedBody, {');
    expect(start).toBeGreaterThan(-1);
    const window = src.slice(start).split('\n').slice(0, 20).join('\n');
    expect(window).toMatch(/replyTo:\s+payload\.replyTo/);
  });

  it('B-144: the group inner envelope deliberately stays reply-free', () => {
    // The reply rides the OUTER seal, not the group-encrypted inner
    // envelope. Pinned so a later "fix" does not add a second copy and
    // create two sources of truth for one field.
    const body = sendTextBody();
    const start = body.indexOf('const innerEnvelope = JSON.stringify({');
    expect(start).toBeGreaterThan(-1);
    const block = body.slice(start, body.indexOf('});', start));
    expect(block).toContain('groupId:');
    expect(block).toContain('body:');
    expect(block).not.toContain('replyTo');
  });
});

describe('B-145 — inbound reply preview is capped at ingest', () => {
  const build = (preview?: string) => buildInboundMessage({
    env:            {clientMsgId: 'cm-1', replyTo: {msgId: 'orig-1', preview}},
    conversationId: 'c1',
    peer:           {userId: 'peer-1', deviceId: 1},
    content:        'a reply',
    createdAt:      new Date(1_753_248_000_000).toISOString(),
    envelopeId:     'env-1',
    makeId:         () => 'fallback-id',
  });

  it('B-145 FIXED: a 10k-char quoted preview is truncated to the cap', () => {
    const row = build('q'.repeat(10_000));
    expect(row.reply_to_msg_id).toBe('orig-1');
    expect(row.reply_to_preview).toHaveLength(REPLY_PREVIEW_MAX_CHARS);
  });

  it('a conforming preview is passed through untouched', () => {
    const row = build('the quoted text');
    expect(row.reply_to_preview).toBe('the quoted text');
  });

  it('a preview exactly at the cap is not truncated', () => {
    const row = build('x'.repeat(REPLY_PREVIEW_MAX_CHARS));
    expect(row.reply_to_preview).toHaveLength(REPLY_PREVIEW_MAX_CHARS);
  });

  it('an absent reply stays absent (no empty-string forgery)', () => {
    const row = buildInboundMessage({
      env:            {clientMsgId: 'cm-2'},
      conversationId: 'c1',
      peer:           {userId: 'peer-1', deviceId: 1},
      content:        'not a reply',
      createdAt:      new Date(1_753_248_000_000).toISOString(),
      envelopeId:     'env-2',
      makeId:         () => 'fallback-id',
    });
    expect(row.reply_to_msg_id).toBeUndefined();
    expect(row.reply_to_preview).toBeUndefined();
  });

  it('send and receive enforce the SAME cap (one constant, no drift)', () => {
    // planSend + productionRuntime both slice with this exact symbol;
    // a source scan keeps the magic number from reappearing.
    const planSrc = readFileSync(
      join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'planSend.ts'), 'utf8');
    expect(planSrc).toContain('REPLY_PREVIEW_MAX_CHARS');
    expect(planSrc).not.toMatch(/slice\(0,\s*200\)/);
    expect(sendTextBody()).not.toMatch(/slice\(0,\s*200\)/);
    expect(sendTextBody()).toContain('REPLY_PREVIEW_MAX_CHARS');
  });
});
