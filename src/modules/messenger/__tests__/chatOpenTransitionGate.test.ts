/**
 * B-691 — chat-open side effects stay OUT of the open-animation window.
 *
 * Root cause (docs/qa/CHAT_OPEN_ANIMATION_LAG_2026-08-29.md): every ChatScreen
 * mount effect fired INSIDE the 220 ms native slide — the relay pull's decrypt
 * burst, the group roster sync, the notif dismiss, the markRead commit on a
 * 200 ms timer landing at the animation's tail, and setActive's unread-zeroing
 * re-render of the still-unfrozen list behind the slide. Measured signature:
 * B-279's 64/419 Slow-UI-thread frames with the GPU idle.
 *
 * The fix keys those effects on `useOpenTransitionGate` (transitionEnd +
 * fallback). This suite pins the WIRING; the gate's semantics are pinned
 * behaviourally in src/hooks/__tests__/useOpenTransitionGate.test.tsx, and the
 * skipUnreadClear store contract in conversationKeyspaceWrites.test.ts.
 *
 * ChatScreen mounts RN views, so the node project cannot import it — this is a
 * comment-stripped source scan. The files are CRLF: nothing here is
 * `\n`-anchored. Anchors sit INSIDE the executing closure (nearest preceding
 * `useEffect(() => {`), never a whole-file `indexOf` alone.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

function strip(rel: string[]): string {
  return readFileSync(join(process.cwd(), ...rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\/[^\r\n]*/g, '');
}

const chat  = strip(['src', 'screens', 'messenger', 'ChatScreen.tsx']);
const store = strip(['src', 'modules', 'messenger', 'store', 'messengerStore.ts']);
const hook  = strip(['src', 'hooks', 'useOpenTransitionGate.ts']);
const door  = strip(['src', 'screens', 'messenger', 'openConversation.ts']);
// B-703 MR-11 — the setActive pin/clear pair now lives here, shared by both
// chat surfaces; the B-691/F3 deferral is an opt-in flag it honours.
const active = strip(['src', 'hooks', 'useActiveConversation.ts']);

/**
 * The effect body that owns `anchor`: from the nearest PRECEDING
 * `useEffect(() => {` up to the anchor itself. Guards asserted in this slice
 * cannot be satisfied by a sibling effect's guard.
 */
function effectPrefix(src: string, anchor: string): string {
  const at = src.indexOf(anchor);
  expect(at).toBeGreaterThan(-1);
  const start = src.lastIndexOf('useEffect(() => {', at);
  expect(start).toBeGreaterThan(-1);
  return src.slice(start, at);
}

describe('B-691 — the gate is wired and the deferred effects key on it', () => {
  it('ChatScreen mounts the open-transition gate off its navigation prop', () => {
    expect(chat).toMatch(/useOpenTransitionGate\(navigation/);
  });

  it('the relay pull waits for the transition to end', () => {
    expect(effectPrefix(chat, 'const doPull')).toContain('if (!transitionDone) {return;}');
  });

  it('the group roster sync waits for the transition to end', () => {
    expect(effectPrefix(chat, 'conversationApi.listMine()')).toContain('!transitionDone');
  });

  it('the notification dismiss waits for the transition to end', () => {
    expect(effectPrefix(chat, 'dismissMessageNotif(conversationId)')).toContain('if (!transitionDone) {return;}');
  });

  it('the FIRST markRead timer arms only after the transition ends', () => {
    expect(effectPrefix(chat, 'runtime.markRead(conversationId)')).toContain('!transitionDone');
  });

  it('EXACTLY 5 effects carry transitionDone in their deps array', () => {
    // Critic finding 1: the guard-presence scans above cannot see a DELETED
    // dependency. Dropping `transitionDone` from an effect's deps keeps every
    // guard string in place while the effect runs once at mount, early-returns
    // and never re-fires on gate-open — markRead would then NEVER fire on a
    // quiet chat (lost blue ticks, the B-356 class) and the badge never clear.
    // Four here — notif dismiss, pull, listMine, markRead — plus the fifth,
    // the full-setActive, which B-703 MR-11 moved INTO `useActiveConversation`
    // (it re-pinned a released thread when its 400 ms fallback timer fired
    // after a Home press or a blur). The screen still feeds it the same gate;
    // the hook applies the same guard the pin does. Both halves asserted.
    const depsWithGate = chat.match(/\}, \[[^\]]*transitionDone[^\]]*\]\);/g) ?? [];
    expect(depsWithGate).toHaveLength(4);
    expect(chat).toMatch(/unreadClearReady:\s*transitionDone/);
    expect(active).toMatch(/\}, \[[^\]]*unreadClearReady[^\]]*\]\);/);
  });
});

describe('B-691/F3 — setActive splits: id immediately, unread clear deferred', () => {
  it('the FIRST pin lands the id WITHOUT the unread-zeroing commit', () => {
    // B-703 MR-11 re-point. The pin/clear pair moved out of ChatScreen's
    // mount-scoped effect into the shared `useActiveConversation` hook (a chat
    // left "active" under a pushed screen, or with the app backgrounded, was a
    // SILENCED chat). The B-691/F3 rule is unchanged and still opt-in here —
    // it just lives one call deep now, so BOTH halves are asserted: the screen
    // asks for the deferral, and the hook is what honours it.
    expect(chat).toMatch(/useActiveConversation\(conversationId, \{[\s\S]{0,160}?deferFirstUnreadClear:\s*true/);
    expect(active).toContain('skipUnreadClear ? {skipUnreadClear: true} : undefined');
    // ...and the deferral applies to the FIRST pin only: re-focusing must
    // clear what piled up while the user was away.
    expect(active).toContain('pin(deferFirstUnreadClear && firstPin)');
  });

  it('the gate opening runs the full (clearing) form — inside the hook, guarded', () => {
    // B-703 MR-11 re-point: this effect lives in `useActiveConversation` now,
    // where it can check the two facts the screen could not — still focused,
    // still foreground — because the gate's 400 ms fallback timer keeps running
    // through a Home press and through a blur, and a screen-side setActive on
    // it re-pinned a released thread or clobbered the chat now on screen.
    expect(active).toMatch(
      /if \(!conversationId \|\| !deferFirstUnreadClear \|\| !unreadClearReady\) \{return;\}[\s\S]{0,300}?pin\(false\);/,
    );
    expect(active).toContain('if (!focusedRef.current) {return;}');
    // B-356 — an OBSERVED transition, not the raw reading: that reading is
    // stale-'background' on a notification cold launch, and gating on it there
    // would leave the badge for the chat on screen uncleared.
    expect(active).toContain('if (confirmedBackgroundRef.current) {return;}');
    expect(active).not.toContain("AppState.currentState === 'background'");
  });

  it('the store honours skipUnreadClear ABOVE the first badge write, with the id already landed', () => {
    const sIdx = store.indexOf('setActiveConversation: (id, opts) =>');
    expect(sIdx).toBeGreaterThan(-1);
    const idIdx   = store.indexOf('s.activeConversationId = id', sIdx);
    const skipIdx = store.indexOf('opts?.skipUnreadClear', sIdx);
    const clearIdx = store.indexOf('unread_count = 0', sIdx);
    expect(idIdx).toBeGreaterThan(-1);
    expect(skipIdx).toBeGreaterThan(-1);
    expect(clearIdx).toBeGreaterThan(-1);
    expect(idIdx).toBeLessThan(skipIdx);
    expect(skipIdx).toBeLessThan(clearIdx);
  });
});

describe('B-691 — what must NOT happen', () => {
  it('CONTENT is never gated on the flag — the measured-2×-worse dead end', () => {
    // Deferring the list/JSX commit to post-transition split one commit into
    // two and DOUBLED jank (B-279 measurement). The gate is for side effects
    // only; no JSX subtree may key on it.
    expect(chat).not.toMatch(/\{transitionDone\s*&&/);
  });

  it('the gate hook itself never navigates', () => {
    expect(hook).not.toMatch(/\.navigate\(|goBack\(/);
  });

  it('the fallback keeps a gated effect delayed, never lost', () => {
    expect(hook).toContain("finish('fallback')");
    expect(hook).toContain('setTimeout');
  });

  it('ChatScreen may not neuter the fallback at the call site', () => {
    // Critic finding 2: `{fallbackMs: 0}` at the call site would reopen the
    // bug (gate opens immediately → effects back inside the animation) with
    // every other test green. The screen takes the hook's default, always.
    expect(chat).not.toContain('fallbackMs');
  });
});

describe('B-691/F4 — the tap→transitionEnd bracket', () => {
  it('the list-row door stamps the tap before navigating to Chat', () => {
    expect(door).toMatch(/markChatOpenTap\(target\.conversationId\);[\s\S]{0,300}?navigate\('Chat'/);
  });

  it('ChatScreen emits ONE [chat.open] warn with both spans, ids only', () => {
    expect(chat).toContain('[LAGDIAG] [chat.open]');
    expect(chat).toContain('mountToEnd=');
    expect(chat).toContain('tapToEnd=');
    // warn survives release stripping; log does not — the probe must be warn.
    const at = chat.indexOf('[LAGDIAG] [chat.open]');
    expect(chat.slice(Math.max(0, at - 120), at)).toContain('console.warn');
  });
});
