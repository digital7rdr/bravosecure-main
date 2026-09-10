/**
 * MS-10 — send-side payload caps (edge-case audit 2026-07-28).
 *
 * The WS gateway hard-refuses frames over ws.maxPayloadBytes (256 KiB,
 * apps/messenger-service/src/main.ts:38). Before these caps, an over-long
 * body sealed into a frame the transport refused — the send died with no
 * user-visible surface and no retry chip. The caps land the failure on an
 * honest `failed` bubble instead, BELOW the optimistic append (M3), through
 * the branch fail helpers (never a bare throw above the append).
 *
 * `productionRuntime.ts` cannot be imported by this Jest project, so these
 * are source scans. Repo traps handled: the file is CRLF (no `\n`-anchored
 * regexes), and comments are stripped so prose can never satisfy a code
 * assertion.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const RUNTIME = join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts');

function code(): string {
  return readFileSync(RUNTIME, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\r\n]*/g, '');
}

const APPEND = 'useMessengerStore.getState().appendMessage(conversationId, msg);';

describe('MS-10 — send-side payload caps', () => {
  it('the caps exist with sane values', () => {
    const src = code();
    const chars = /const MAX_MESSAGE_CHARS = ([\d_]+);/.exec(src);
    expect(chars).not.toBeNull();
    const n = Number(chars![1].replace(/_/g, ''));
    // Must stay well under ws.maxPayloadBytes after seal + base64 overhead,
    // but high enough that no real typed message ever hits it.
    expect(n).toBeGreaterThanOrEqual(10_000);
    expect(n).toBeLessThanOrEqual(200_000);
    expect(/const MAX_ATTACHMENT_BYTES = [\d_]+ \* 1024 \* 1024;/.test(src)).toBe(true);
  });

  it('M3 — the text cap sits BELOW the optimistic append on BOTH branches, through the fail helpers', () => {
    const src = code();
    const firstAppend = src.indexOf(APPEND);
    const secondAppend = src.indexOf(APPEND, firstAppend + 1);
    expect(firstAppend).toBeGreaterThan(-1);
    expect(secondAppend).toBeGreaterThan(firstAppend);
    const groupCap = src.indexOf('failGroupSend(`message too long');
    const directCap = src.indexOf('failDirectSend(`message too long');
    expect(groupCap).toBeGreaterThan(firstAppend);
    expect(directCap).toBeGreaterThan(secondAppend);
  });

  it('sendMedia refuses over-cap bytes below its append, before any upload starts', () => {
    const src = code();
    const mediaAppend = src.indexOf('useMessengerStore.getState().appendMessage(convId, {');
    const cap = src.indexOf('media.bytes.byteLength > MAX_ATTACHMENT_BYTES');
    const upload = src.indexOf('uploadEncrypted(');
    expect(mediaAppend).toBeGreaterThan(-1);
    expect(cap).toBeGreaterThan(mediaAppend);
    expect(upload).toBeGreaterThan(cap);
  });
});
