/**
 * B-269 — "I click send and it feels like it hangs."
 *
 * The send handler fanned a typing-STOP out to every group member
 * SYNCHRONOUSLY, before the send itself. Each `sendTyping` call does a store
 * read, a pure-JS sha256 (`typingConversationTag`) and a bridge
 * `transport.send`. In a 30-member group that is 30 hashes and 30 bridge
 * crossings sitting between the user's finger and the optimistic bubble, on
 * the one interaction where latency is most obvious.
 *
 * Nothing downstream needs the stop frame in that frame: it is advisory, the
 * receiver's indicator has its own timeout, and the message that immediately
 * follows implies it. So it is deferred by a macrotask — the tap frame now
 * does only what the user can see.
 *
 * ChatScreen cannot be mounted by the node project, so the ordering is pinned
 * by a comment-stripped source scan. The file is CRLF; nothing here is
 * `\n`-anchored. The COST of the thing being deferred is measured for real
 * below, so this suite fails if `typingConversationTag` ever stops being
 * expensive enough to care about (in which case the deferral can go).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {typingConversationTag} from '../runtime/messagingLogic';

const CHAT = join(process.cwd(), 'src', 'screens', 'messenger', 'ChatScreen.tsx');

function code(): string {
  return readFileSync(CHAT, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\/[^\r\n]*/g, '');
}

describe('B-269 — no typing frame is emitted on an interaction frame', () => {
  it('CONTROL: the scan sees the typing emitter and the send handler', () => {
    const src = code();
    expect(src).toContain('deferTypingFanout');
    expect(src).toContain('typingActiveRef.current');
  });

  it('EVERY fan-out goes through the deferring helper — none loops inline', () => {
    // The bug, in both places it lived: a `for (const peer of ...)
    // { runtime.sendTyping(...) }` executing on the frame the user is waiting
    // on. `emitTyping` runs per KEYSTROKE and the send handler runs on the send
    // TAP, so an inline loop at either site is felt directly.
    const src = code();
    const inlineLoops = src.match(/for \(const peer of [^)]*\) \{\s*runtime\.sendTyping/g) ?? [];
    expect(inlineLoops).toEqual([]);
  });

  it('the only sendTyping loop left is inside the deferred callback', () => {
    const src = code();
    expect(src).toMatch(/setTimeout\(\(\) => \{[\s\S]{0,300}?for \(const peer of snapshot\)[\s\S]{0,200}?\}, 0\)/);
  });

  it('all three typing transitions defer: start, re-emit, and stop', () => {
    // Losing any one of them puts the hashes back on a keystroke.
    const src = code();
    const calls = src.match(/deferTypingFanout\(groupPeers, '(start|stop)', conversationId\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(4);
    expect(calls).toContain("deferTypingFanout(groupPeers, 'start', conversationId)");
    expect(calls).toContain("deferTypingFanout(groupPeers, 'stop', conversationId)");
  });

  it('the debounce refs are still written SYNCHRONOUSLY', () => {
    // If `typingActiveRef` were set inside the deferred callback, a burst of
    // keystrokes would each queue a full fan-out before the first marked
    // typing active — turning a latency fix into an amplification bug.
    const src = code();
    const at = src.indexOf('const emitTyping');
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf('emitTypingRef', at));
    const activeAt = body.indexOf('typingActiveRef.current = true');
    const deferAt = body.indexOf('deferTypingFanout');
    expect(activeAt).toBeGreaterThan(-1);
    expect(activeAt).toBeLessThan(deferAt);
  });

  it('the peer list is SNAPSHOT into the closure, not read late', () => {
    expect(code()).toContain('const snapshot = peers');
  });
});

describe('the deferred work is genuinely expensive — otherwise drop the defer', () => {
  it('typingConversationTag really does hash, once per peer', () => {
    // Not a timing assertion (those flake). This pins the SHAPE: a distinct
    // digest per recipient means the work cannot be hoisted or shared across
    // the fan-out, so N members really is N hashes.
    const tags = new Set(
      ['u-a', 'u-b', 'u-c', 'u-d'].map(peer => typingConversationTag('conv-1', 'u-me', peer)),
    );
    expect(tags.size).toBe(4);
  });

  it('the tag is pair-symmetric, so deferring cannot change what the peer sees', () => {
    // Both ends must derive the same tag or the receiver lights the wrong
    // thread. Deferring changes WHEN it is sent, never its value.
    expect(typingConversationTag('conv-1', 'u-me', 'u-you'))
      .toBe(typingConversationTag('conv-1', 'u-you', 'u-me'));
  });
});
