/**
 * sqa.md bug register — this suite pins: B-250.
 *
 * B-250 (dept chat: every send awaited a full listMembers round-trip before encrypting,
 * producing a visible send-button spinner) is pinned by "sending does not wait on a
 * round-trip" plus the freshness-window cases. The gate itself is still enforced on every
 * send — the re-check is bounded, not removed.
 */
/**
 * Two founder reports on the departmental thread.
 *
 * 1. "when try to send message the send button start to load and it take a
 *    little bit of time to send." Every send AWAITED
 *    `departmentApi.listMembers(channelId)` before it encrypted anything — a
 *    full round-trip on the critical path, re-fetching exactly what the focus
 *    effect had already loaded, purely to catch a member downgraded seconds
 *    earlier. It now re-checks only when the cached role has gone stale.
 *
 *    This is the ONLY gate on posting (group sends are E2EE and client-fanned
 *    out, so there is no server check), so it is not removed — it is bounded.
 *    The guarantee moves from "exact" to "never more than ROLE_FRESH_MS old",
 *    which is strictly TIGHTER than what the old code actually delivered: it
 *    already fell through to the cached role whenever the request failed, i.e.
 *    unbounded staleness offline.
 *
 * 2. "for other message to reply we need to swipe right and if we want reply
 *    our message we should be swipe left." Both threads swiped right for
 *    everything. The rule is applied to ChatScreen too, because departmental
 *    chat is required to behave identically to a messenger group.
 *
 * Static source scans: neither screen can be imported by the node project
 * (RN natives + expo-clipboard), same as the other scans in this folder.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

function code(...rel: string[]): string {
  const out: string[] = [];
  let inBlock = false;
  // CRLF files — split on both, or a \n-anchored scan matches nothing and
  // every assertion below passes vacuously.
  for (const raw of readFileSync(join(process.cwd(), ...rel), 'utf8').split(/\r?\n/)) {
    const t = raw.trim();
    if (inBlock) { if (t.includes('*/')) {inBlock = false;} continue; }
    if (t.startsWith('/*') || t.startsWith('{/*')) { if (!t.includes('*/')) {inBlock = true;} continue; }
    if (t.startsWith('*') || t.startsWith('//')) {continue;}
    out.push(raw);
  }
  return out.join('\n');
}

const DEPT = code('src', 'screens', 'messenger', 'DepartmentChatScreen.tsx');
const CHAT = code('src', 'screens', 'messenger', 'ChatScreen.tsx');

it('the scans are not vacuous', () => {
  // Comment-stripping + CRLF are the two ways this whole file silently passes.
  expect(DEPT.length).toBeGreaterThan(5000);
  expect(CHAT.length).toBeGreaterThan(5000);
  expect(DEPT).toContain('SwipeToReplyRow');
});

describe('sending does not wait on a round-trip', () => {
  const send = DEPT.slice(DEPT.indexOf('const send = useCallback'));
  const body = send.slice(0, send.indexOf('}, [draft'));

  it('the role re-check is behind a freshness window', () => {
    expect(body).toMatch(/if \(Date\.now\(\) - roleCheckedAt\.current > ROLE_FRESH_MS\) \{/);
    // The await still EXISTS — bounded, not deleted.
    expect(body).toMatch(/await departmentApi\.listMembers\(channelId\)/);
  });

  it('the gate itself is still enforced on every send', () => {
    // Whether or not the round-trip ran, a viewer never reaches the runtime.
    expect(body).toMatch(/if \(myRole !== 'admin'\) \{ setSending\(false\); return; \}/);
    expect(body.indexOf("myRole !== 'admin'")).toBeLessThan(body.indexOf('rt.sendText'));
  });

  it('a fresh check stamps the clock, so the next send can skip it', () => {
    expect(body).toMatch(/roleCheckedAt\.current = Date\.now\(\)/);
    // The focus effect stamps it too — that is what makes the FIRST send after
    // opening the channel instant.
    const focusStamp = DEPT.indexOf('roleCheckedAt.current = Date.now()');
    expect(focusStamp).toBeGreaterThan(-1);
    expect(focusStamp).toBeLessThan(DEPT.indexOf('const send = useCallback'));
  });

  it('the freshness window is a bounded, stated number', () => {
    const m = DEPT.match(/const ROLE_FRESH_MS = ([\d_]+);/);
    expect(m).not.toBeNull();
    expect(Number(m![1].replace(/_/g, ''))).toBeLessThanOrEqual(60_000);
  });
});

describe('reply swipe direction follows message ownership', () => {
  it('dept chat: the row takes `mine` and is given the real value', () => {
    expect(DEPT).toMatch(/function SwipeToReplyRow\(\{mine, onReply, children\}/);
    expect(DEPT).toMatch(/<SwipeToReplyRow mine=\{mine\} onReply=/);
  });

  for (const [name, src, own] of [['dept chat', DEPT, 'mine'], ['messenger thread', CHAT, 'sent']] as const) {
    describe(name, () => {
      it('own messages activate on a LEFT drag, others on a RIGHT drag', () => {
        expect(src).toMatch(new RegExp(`activeOffsetX=\\{${own} \\? -16 : 16\\}`));
        expect(src).toMatch(new RegExp(`failOffsetX=\\{${own} \\? 16 : -16\\}`));
      });

      it('the reply fires past the threshold in the matching direction', () => {
        expect(src).toMatch(new RegExp(
          `${own}\\s*\\n?\\s*\\? translationX < -SWIPE_REPLY_THRESHOLD\\s*\\n?\\s*: translationX >\\s*SWIPE_REPLY_THRESHOLD`,
        ));
      });

      it('the clamp lets the bubble travel in that direction only', () => {
        // Both ranges must flip together — a right-only clamp with a left
        // trigger springs back instantly and the gesture feels dead.
        expect(src).toMatch(new RegExp(`inputRange:\\s*${own} \\? \\[-120, 0\\] : \\[0, 120\\]`));
        expect(src).toMatch(new RegExp(`outputRange:\\s*${own} \\? \\[-120, 0\\] : \\[0, 120\\]`));
      });
    });
  }
});
