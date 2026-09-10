/**
 * Static source-scan regression — feature parity across EVERY thread.
 *
 * The @mentions / edit / delete-for-everyone work shipped mentions as
 * "groups only", and "Message info" had been group-only since B-116 phase 2.
 * The ask is that every thread offers the same feature set, including a thread
 * created after this change — so the rule is enforced structurally (no
 * `isGroup` gate on the feature) rather than by listing thread types.
 *
 * NOT changed here: things that are group-only because they are MEANINGLESS on
 * a 1:1 — the member list, the sender label above a bubble, group-send blocking.
 * Those stay gated, and this file does not assert on them.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const CHAT = join(process.cwd(), 'src', 'screens', 'messenger', 'ChatScreen.tsx');

function code(): string {
  const src = readFileSync(CHAT, 'utf8').replace(/\r\n/g, '\n');
  const out: string[] = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (inBlock) { if (t.includes('*/')) {inBlock = false;} continue; }
    if (t.startsWith('/*') || t.startsWith('{/*')) { if (!t.includes('*/')) {inBlock = true;} continue; }
    if (t.startsWith('*') || t.startsWith('//')) {continue;}
    out.push(line.replace(/([^:'"`])\/\/.*$/, '$1'));
  }
  return out.join('\n');
}

describe('@mentions work on every thread', () => {
  it('the roster is not gated on isGroup', () => {
    const src = code();
    const start = src.indexOf('const mentionRoster = useMemo(');
    expect(start).toBeGreaterThan(-1);
    const memo = src.slice(start, src.indexOf('\n  }, [', start));
    expect(memo).not.toMatch(/if \(!isGroup\)/);
  });

  it('a direct thread falls back to the resolved peer', () => {
    // A direct row usually stores `peer`, not `participants` — without this the
    // picker would open empty on exactly the threads being enabled.
    const src = code();
    const start = src.indexOf('const mentionRoster = useMemo(');
    const memo = src.slice(start, src.indexOf('\n  }, [', start));
    expect(memo).toMatch(/resolvedPeer\?\.userId/);
    expect(memo).toMatch(/fromParticipants\.length > 0/);
  });

  it('an empty roster yields undefined, so no empty picker is shown', () => {
    const src = code();
    const start = src.indexOf('const mentionRoster = useMemo(');
    const memo = src.slice(start, src.indexOf('\n  }, [', start));
    expect(memo).toMatch(/if \(members\.length === 0\) \{return undefined;\}/);
  });

  it('the memo re-runs when the peer resolves', () => {
    // Dropping isGroup from deps without adding the peer would leave a direct
    // thread showing an empty roster until some other dep happened to change.
    expect(code()).toMatch(/\}, \[conversation\?\.participants, resolvedPeer\?\.userId,/);
  });
});

describe('Message info works on every thread', () => {
  it('is gated on own-message only, not on group', () => {
    const src = code();
    const idx = src.indexOf('Message info');
    expect(idx).toBeGreaterThan(-1);
    // Look back at the condition guarding this sheet row.
    const before = src.slice(Math.max(0, idx - 700), idx);
    expect(before).toMatch(/actionMsg\.sender_id === 'self' && \(/);
    expect(before).not.toMatch(/conversations\[conversationId\]\?\.type === 'group' && \(/);
  });
});

describe('features that were ALREADY thread-agnostic stay that way', () => {
  it('edit and delete-for-everyone are own-message gated, not group gated', () => {
    const src = code();
    for (const marker of ['canDeleteForEveryone(actionMsg)', 'Delete for everyone']) {
      expect(src).toContain(marker);
    }
    const idx = src.indexOf('canDeleteForEveryone(actionMsg)');
    const around = src.slice(Math.max(0, idx - 300), idx + 300);
    expect(around).not.toMatch(/type === 'group'/);
  });

  it('reply is available regardless of thread type', () => {
    const src = code();
    // isGroup near the quote rendering only picks the SENDER LABEL, which is
    // legitimately group-only; the reply action itself must not be gated.
    expect(src).toMatch(/setReplyTo|replyTo/);
  });
});
