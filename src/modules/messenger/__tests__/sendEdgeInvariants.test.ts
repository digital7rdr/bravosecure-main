/**
 * B-317 / B-318 — send-path edge invariants (W3 of
 * MESSENGER_STABILITY_PLAN_2026-07-28). Source scans: `productionRuntime.ts`
 * cannot be imported by the node project. CRLF-safe, comments stripped.
 *
 * B-317 — the pending-map LRU eviction used to flip a still-`sending` bubble
 * to `failed` + setError WITHOUT consulting the durable outbox. A queued row
 * auto-sends later; the red bubble invites a re-typed duplicate the relay's
 * (recipient, clientMsgId) dedup cannot coalesce — the exact invariant the
 * httpFallback queued path states. The evict must check the outbox first.
 *
 * B-318 — the 1:1 branch stamped `aad.ts` INSIDE sealPayload, AFTER
 * `certCache.getIssued()` + `ensureOutgoingSession` (both can block on the
 * network). Concurrent sends meant message A composed first could carry a
 * LATER wire ts than B; the receiver splices strictly on created_at and
 * renders them inverted. The GROUP branch already stamps its `sealedTs`
 * before all per-peer work — the 1:1 branch must stamp compose-time too.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const src = readFileSync(
  join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts'), 'utf8',
)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\r\n]*/g, '');

describe('B-317 — LRU eviction must not red-flag a message the outbox still owns', () => {
  function evictBlock(): string {
    const at = src.indexOf('const oldest = pendingByClientMsgId.keys().next().value;');
    expect(at).toBeGreaterThan(-1);
    const end = src.indexOf('pendingByClientMsgId.delete(oldest);', at);
    expect(end).toBeGreaterThan(at);
    return src.slice(at, end);
  }

  it('the evict consults the durable outbox before any failed flip', () => {
    const b = evictBlock();
    const check = b.indexOf('pendingMessageIds()');
    const flip = b.indexOf("'failed'");
    expect(check).toBeGreaterThan(-1);
    expect(flip).toBeGreaterThan(-1);
    expect(check).toBeLessThan(flip);
  });

  it('a queued row keeps the bubble sending (early return before the flip)', () => {
    const b = evictBlock();
    expect(b).toMatch(/outbox row still queued/);
  });

  it('the no-row flip itself is preserved (still guarded on status sending)', () => {
    const b = evictBlock();
    expect(b).toMatch(/msg\.status === 'sending'/);
    expect(b).toMatch(/updateMessageStatus\(ev\.conversationId, ev\.messageId, 'failed'\)/);
  });
});

describe('B-318 — 1:1 wire ts is stamped at compose time, not seal time', () => {
  it('composedTsMs is minted beside the msgId, before the branch split', () => {
    const mint = src.indexOf('const clientMsgId = msgId;');
    const stamp = src.indexOf('const composedTsMs = Date.now();');
    const branch = src.indexOf('if (isGroup) {', mint);
    expect(mint).toBeGreaterThan(-1);
    expect(stamp).toBeGreaterThan(-1);
    expect(branch).toBeGreaterThan(-1);
    expect(stamp).toBeGreaterThan(mint - 400);
    expect(stamp).toBeLessThan(branch);
  });

  it('the 1:1 sealPayload aad carries composedTsMs, never a fresh Date.now()', () => {
    // Anchor on the 1:1 aad literal — the only aad whose conversationId is
    // the symmetric direct id.
    const at = src.indexOf('conversationId: directConvoAadId(ownAddress.userId, target.userId)');
    expect(at).toBeGreaterThan(-1);
    const literal = src.slice(src.lastIndexOf('aad:', at), at);
    expect(literal).toMatch(/ts:\s+composedTsMs,/);
    expect(literal).not.toMatch(/ts:\s+Date\.now\(\),/);
  });
});
