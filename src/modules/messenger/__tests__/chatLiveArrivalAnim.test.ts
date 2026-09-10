/**
 * B-692 NL-7 — pipeline-delayed messages still animate in.
 *
 * The bubble entrance used to key ONLY on `created_at` being under 2 s old, so
 * anything delivered late (server wake debounce, drain, receive-chain backlog)
 * popped in with no animation — the in-chat half of "the notification thing
 * feels laggy". The fix: ChatScreen diffs the messages identity DURING render
 * and marks newly-appended ids in the live-arrival registry
 * (src/screens/messenger/liveArrivals.ts, behavioural suite
 * src/screens/messenger/__tests__/liveArrivals.test.ts); the bubble consults
 * it when it captures its entrance decision.
 *
 * ChatScreen mounts RN views, so the node project cannot import it — this is a
 * comment-stripped source scan (house rules: CRLF-safe, nothing \n-anchored,
 * anchors INSIDE the closure that executes, never a whole-file indexOf alone).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

function strip(rel: string[]): string {
  return readFileSync(join(process.cwd(), ...rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\/[^\r\n]*/g, '');
}

const chat = strip(['src', 'screens', 'messenger', 'ChatScreen.tsx']);

describe('B-692 NL-7 — the live-arrival wiring in ChatScreen', () => {
  it('the bubble entrance consults the registry INSIDE its first-render capture', () => {
    const at = chat.indexOf('const isFresh = useRef(');
    expect(at).toBeGreaterThan(-1);
    const init = chat.slice(at, chat.indexOf('.current;', at));
    expect(init).toContain('isLiveArrival(msg.id)');
    // The restore stagger and the recency fallback both survive.
    expect(init).toContain('isRestoreAnim');
    expect(init).toContain('msg.created_at');
  });

  it('newly-appended ids are marked DURING render, keyed on the messages identity', () => {
    const at = chat.indexOf('markLiveArrivals(fresh)');
    expect(at).toBeGreaterThan(-1);
    const memoStart = chat.lastIndexOf('useMemo(() => {', at);
    expect(memoStart).toBeGreaterThan(-1);
    // Critic F3 — anchor INSIDE the executing closure (the house lastIndexOf
    // trap): if the marking were moved into a useEffect, lastIndexOf would
    // find some UNRELATED earlier memo and this scan would pass vacuously —
    // unless we also require that no effect opener sits between the memo
    // opener and the mark, and none between the mark and its close.
    const between = chat.slice(memoStart, at);
    expect(between).not.toContain('useEffect(');
    // The marking memo closes on [messages] — an effect-timed mark would land
    // AFTER the new bubble's first render and the entrance would be lost.
    const memoClose = chat.indexOf('}, [messages]);', at);
    expect(memoClose).toBeGreaterThan(at);
    expect(chat.slice(at, memoClose)).not.toContain('useEffect(');
  });

  it('the baseline render marks nothing — opening history must not re-spring bubbles', () => {
    const at = chat.indexOf('markLiveArrivals(fresh)');
    const memoStart = chat.lastIndexOf('useMemo(() => {', at);
    const body = chat.slice(memoStart, at);
    // Same F3 hardening: the slice must be THIS closure, not an earlier memo.
    expect(body).not.toContain('useEffect(');
    expect(body).toContain('if (seen === null)');
    expect(body).toContain('seenMsgIdsRef.current = new Set(');
  });

  it('an in-place conversation switch re-baselines instead of animating the new thread', () => {
    const at = chat.indexOf('seenMsgConvRef.current !== conversationId');
    expect(at).toBeGreaterThan(-1);
    expect(chat.slice(at, at + 300)).toContain('seenMsgIdsRef.current = null');
  });

  it('the registry cap and TTL hold their contract values', () => {
    const reg = strip(['src', 'screens', 'messenger', 'liveArrivals.ts']);
    expect(reg).toMatch(/const LIVE_ARRIVAL_TTL_MS = 10_000\b/);
    expect(reg).toMatch(/const MAX_MARK_PER_COMMIT = 3\b/);
  });
});
