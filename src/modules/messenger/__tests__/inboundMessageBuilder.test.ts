import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {
  buildInboundMessage,
  attachmentMessageType,
  attachmentMediaMeta,
  sentAtFromAad,
} from '../runtime/inboundMessageBuilder';

/**
 * S4 / W23 — ONE builder for every inbound message row.
 *
 * `doHandleIncoming` hand-rolled the same ~20-key LocalMessage literal four
 * times (drained-from-stash, legacy plaintext group, live sealed group, 1:1)
 * and they had already drifted — which is why group media rendered on the live
 * path long before the drained path. Now the lanes differ only by explicit
 * parameters. See docs/runbooks/MESSAGE_LOOP.md M8/S4.
 */

const PEER = {userId: 'peer-1', deviceId: 1};
const makeId = () => 'minted-id';

describe('buildInboundMessage', () => {
  it('prefers the sender-supplied clientMsgId — that is what collapses the group fan-out to ONE row', () => {
    const row = buildInboundMessage({
      env: {clientMsgId: 'client-1'}, conversationId: 'g1', peer: PEER,
      content: 'hi', createdAt: '2026-07-21T10:00:00.000Z', envelopeId: 'e1', makeId,
    } as never);
    expect(row.id).toBe('client-1');
  });

  it('mints an id only when the sender supplied none', () => {
    const row = buildInboundMessage({
      env: {}, conversationId: 'g1', peer: PEER,
      content: 'hi', createdAt: '2026-07-21T10:00:00.000Z', makeId,
    } as never);
    expect(row.id).toBe('minted-id');
  });

  it('every inbound row is delivered + encrypted and carries the peer', () => {
    const row = buildInboundMessage({
      env: {}, conversationId: 'g1', peer: PEER, content: 'hi',
      createdAt: '2026-07-21T10:00:00.000Z', envelopeId: 'e1', makeId,
    } as never);
    expect(row.status).toBe('delivered');
    expect(row.is_encrypted).toBe(true);
    expect(row.sender_id).toBe(PEER.userId);
    expect(row.envelope_id).toBe('e1');
    expect(row.conversation_id).toBe('g1');
  });

  it('carries the attachment key + IV so media survives a backup-restore (Round 8)', () => {
    const row = buildInboundMessage({
      env: {attachment: {mimeType: 'image/png', objectKey: 'r2/k', keyB64: 'K', ivB64: 'IV'}},
      conversationId: 'g1', peer: PEER, content: 'caption',
      createdAt: '2026-07-21T10:00:00.000Z', makeId,
    } as never);
    expect(row.type).toBe('image');
    expect(row.media_key).toBe('K');
    expect(row.media_iv).toBe('IV');
    expect(row.media_object_key).toBe('r2/k');
  });

  it('converts expiresAtSec to ms and passes reply metadata through', () => {
    const row = buildInboundMessage({
      env: {expiresAtSec: 1_800_000_000, replyTo: {msgId: 'm0', preview: 'prev'}},
      conversationId: 'g1', peer: PEER, content: 'hi',
      createdAt: '2026-07-21T10:00:00.000Z', makeId,
    } as never);
    expect(row.expires_at).toBe(1_800_000_000 * 1000);
    expect(row.reply_to_msg_id).toBe('m0');
    expect(row.reply_to_preview).toBe('prev');
  });
});

describe('attachment helpers', () => {
  it('derives type from kind first, then mime, else file', () => {
    expect(attachmentMessageType(null)).toBe('text');
    expect(attachmentMessageType({kind: 'audio'})).toBe('audio');
    expect(attachmentMessageType({mimeType: 'video/mp4'})).toBe('video');
    expect(attachmentMessageType({mimeType: 'application/pdf'})).toBe('file');
  });

  it('returns undefined media_meta when the sender shipped none (pre-metadata envelopes cost nothing)', () => {
    expect(attachmentMediaMeta(null)).toBeUndefined();
    expect(attachmentMediaMeta({})).toBeUndefined();
  });

  it('maps size to sizeBytes and keeps only supplied fields', () => {
    expect(attachmentMediaMeta({name: 'a.png', size: 12})).toEqual({name: 'a.png', sizeBytes: 12});
  });
});

describe('sentAtFromAad', () => {
  it('uses the sender authenticated seal timestamp so drained messages sort by SEND time', () => {
    expect(sentAtFromAad({ts: Date.parse('2026-07-21T09:00:00.000Z')}))
      .toBe('2026-07-21T09:00:00.000Z');
  });

  it('falls back to now only when the timestamp is absent', () => {
    expect(typeof sentAtFromAad(undefined)).toBe('string');
    expect(sentAtFromAad({})).toMatch(/^\d{4}-/);
  });
});

describe('S4 — the four inbound lanes do not re-inline their own row literal', () => {
  const RUNTIME = join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts');

  // S5 — lanes extracted out of doHandleIncoming. The S4 property is about the
  // receive PATH, not about one file: when the group-text lane moved to
  // applyGroupText.ts these two scans went red purely because they were reading
  // a filename. Dropping the assertions would have been the easy fix and would
  // have quietly retired MSG-09 for the lane that moved. Keep following the
  // code. Mirrors EXTRACTED_LANES in receivePersistenceInvariants.test.ts —
  // extend both when the next lane lands.
  const EXTRACTED_LANES = ['applyGroupText.ts', 'applyDirectText.ts', 'applyReactionLane.ts', 'applyGroupAdmin.ts'];

  function doHandleIncomingCode(): string {
    const src = readFileSync(RUNTIME, 'utf8');
    const start = src.indexOf('async function doHandleIncoming(');
    const end = src.indexOf('\nfunction applyReaction(', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const dir = join(process.cwd(), 'src', 'modules', 'messenger', 'runtime');
    const lanes = EXTRACTED_LANES.map(f => readFileSync(join(dir, f), 'utf8')).join('\n');
    return (src.slice(start, end) + '\n' + lanes)
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  }

  it('no hand-rolled `: LocalMessage = {` literal survives in doHandleIncoming', () => {
    // Re-inlining one is how the four copies drifted in the first place.
    expect(doHandleIncomingCode()).not.toMatch(/:\s*LocalMessage\s*=\s*\{/);
  });

  it('the receive lanes build through buildInboundMessage', () => {
    const calls = doHandleIncomingCode().match(/buildInboundMessage\(/g) ?? [];
    // legacy plaintext group + live sealed group + 1:1 (the drained lane lives
    // in replayGroupSealedDecode, outside this slice).
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  it('MSG-09: every lane stamps SEND time — none re-introduces a receive-time clock', () => {
    // The legacy plaintext lane used to stamp `new Date()`, so a message that
    // sat on the relay while the device was offline sorted to the BOTTOM of the
    // thread, below messages actually sent after it. All four lanes now derive
    // created_at from the authenticated aad.ts via sentAtFromAad.
    const code = doHandleIncomingCode();
    const createdAtArgs = code.match(/createdAt:\s*([^,\n]+)/g) ?? [];
    expect(createdAtArgs.length).toBeGreaterThanOrEqual(3);
    for (const arg of createdAtArgs) {
      expect(arg).toMatch(/sentAtFromAad\(/);
      expect(arg).not.toMatch(/new Date\(\)/);
    }
  });
});
