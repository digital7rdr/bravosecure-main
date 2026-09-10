/**
 * F7 — "Members can react in #broadcast."
 *
 * PDF A9 / M9: in a read-only or #broadcast channel a member cannot post, reply
 * or call. `DepartmentChatScreen` gated the COMPOSER and `send()` on
 * `myRole === 'admin'` and stopped there, so `reactToMessage` — which calls
 * `rt.sendReaction`, a sealed-sender fan-out to every member, exactly like
 * `sendText` — put a viewer's reaction on the wire and every recipient rendered
 * it as a chip under the message. Swipe-to-reply had the same hole.
 *
 * WHY A SOURCE SCAN. `DepartmentChatScreen.tsx` cannot be imported by a test in
 * this repo (the messenger runtime, navigation, expo-linear-gradient, the API
 * layer, `getMessengerRuntime`), which is why every other invariant on this
 * screen — the "no call button in channel chat" rule included — is pinned the
 * same way.
 *
 * THE ASSERTIONS ARE AT THE DECISION SITE, not "the token appears in the file":
 * the guard must sit inside the named callback and BEFORE the write. A scan for
 * `myRole` anywhere in the file would stay green with the guard deleted, because
 * the composer still mentions it.
 *
 * Comments are stripped first — this screen's own prose explains the rule and
 * names both `sendReaction` and `myRole`.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const SCREEN = join(process.cwd(), 'src', 'screens', 'messenger', 'DepartmentChatScreen.tsx');

/** CRLF file — normalise, or a `\n`-anchored pattern matches nothing and the
 *  whole suite passes vacuously. */
function read(): string {
  return readFileSync(SCREEN, 'utf8').replace(/\r\n/g, '\n');
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .split('\n')
    .filter(l => !l.trim().startsWith('//'))
    .join('\n');
}

const CODE = stripComments(read());

/** The body of one `const <name> = useCallback(...)` declaration, so an
 *  assertion about one write path cannot be satisfied by a different one. */
function callbackBody(name: string): string {
  const start = CODE.indexOf(`const ${name} = useCallback(`);
  expect(start).toBeGreaterThan(-1);
  const next = CODE.indexOf('\n  const ', start + 1);
  return CODE.slice(start, next === -1 ? undefined : next);
}

describe('F7 — a viewer cannot write into a channel they cannot post in', () => {
  it('the scan is actually reading the screen (guards against an empty read)', () => {
    // If this file ever moves, every assertion below would pass vacuously.
    expect(CODE.length).toBeGreaterThan(10_000);
    expect(CODE).toContain('const send = useCallback(');
  });

  it('reactToMessage refuses BEFORE it reaches sendReaction', () => {
    const body = callbackBody('reactToMessage');
    const guardAt = body.search(/if \(myRole !== 'admin'\)\s*\{\s*return;?\s*\}/);
    const writeAt = body.indexOf('rt.sendReaction(');
    expect(guardAt).toBeGreaterThan(-1);
    expect(writeAt).toBeGreaterThan(-1);
    // Ordering is the whole point: a guard after the send is not a guard.
    expect(writeAt).toBeGreaterThan(guardAt);
  });

  it('reactToMessage re-derives when the role changes', () => {
    // A stale closure would hold `myRole` from the render in which the callback
    // was created, so a member downgraded to viewer while the thread is open
    // would keep the admin capture. Same reason `send` lists it.
    expect(callbackBody('reactToMessage')).toMatch(/\}, \[[^\]]*\bmyRole\b[^\]]*\]\);/);
  });

  it('startReply refuses too — A9 names reply alongside post', () => {
    const body = callbackBody('startReply');
    const guardAt = body.search(/if \(myRole !== 'admin'\)\s*\{\s*return;?\s*\}/);
    const writeAt = body.indexOf('setReplyTo(');
    expect(guardAt).toBeGreaterThan(-1);
    expect(writeAt).toBeGreaterThan(guardAt);
    expect(body).toMatch(/\}, \[[^\]]*\bmyRole\b[^\]]*\]\);/);
  });

  it('the reply gate is the CHOKE POINT, so the swipe gesture obeys it', () => {
    // SwipeToReplyRow calls startReply directly. Gating only the action-sheet
    // row would leave the gesture arming a reply bar with no composer under it.
    expect(CODE).toMatch(/<SwipeToReplyRow[^>]*onReply=\{\(\) => startReply\(m\)\}/);
  });

  it('the quick-reaction row is not offered to a viewer', () => {
    // Not the boundary (A4: never rely on a hidden control) — but a row of taps
    // that silently do nothing is exactly how the ungated version read as
    // working, so the affordance must follow the rule too.
    const rowAt = CODE.indexOf('styles.actionReactRow');
    expect(rowAt).toBeGreaterThan(-1);
    const before = CODE.slice(Math.max(0, rowAt - 400), rowAt);
    expect(before).toMatch(/myRole === 'admin' && \(/);
  });

  it('the EDIT branch refuses before sendMessageEdit, which returns early', () => {
    // The third sealed fan-out on this screen, and the one the first pass
    // missed: `send()` handles EDIT mode in a branch that `return`s BEFORE the
    // `myRole !== 'admin'` gate further down, so the gate below does not cover
    // it. Hiding the sheet's Edit row is not the boundary (A4), and the branch
    // is reachable anyway — an admin arms an edit, the focus-effect roster
    // refresh downgrades them to viewer, and the pending edit still ships.
    const body = callbackBody('send');
    const editAt  = body.indexOf('if (editing) {');
    const writeAt = body.indexOf('rt.sendMessageEdit(');
    expect(editAt).toBeGreaterThan(-1);
    expect(writeAt).toBeGreaterThan(editAt);
    // The guard must live INSIDE the edit branch, i.e. between the branch head
    // and the write — the shared gate lower down is unreachable from here.
    const branch = body.slice(editAt, writeAt);
    expect(branch).toMatch(/if \(myRole !== 'admin'\)\s*\{\s*return;?\s*\}/);
  });

  it('the send path still carries the rule it is the model for', () => {
    // If this ever changes, the reaction/reply gates above must change WITH it
    // — one rule, not three drifting copies (the repo's duplicate-copy class).
    expect(callbackBody('send')).toMatch(/if \(myRole !== 'admin'\) \{ setSending\(false\); return; \}/);
  });
});

/**
 * F7, ONE LAYER OUT — the posting rule is enforced by callbacks that live inside
 * `DepartmentChatScreen`. `ForwardList` lives in `ChatScreen` and writes into any
 * conversation the store holds, INCLUDING a department channel: the row is an
 * ordinary `type: 'group'` conversation, upserted by `DepartmentChatScreen`'s own
 * focus effect, and `sendText` derives `isGroup` from the store — so picking one
 * fanned a sealed envelope out to every member of a #broadcast channel with no
 * role check on the path.
 *
 * The picker cannot evaluate a channel role (no channel id, no roster), so the
 * fix is structural: departmental conversations are not offered as targets.
 */
describe('F7 — the forward picker is not a side door into a department channel', () => {
  const CHAT = stripComments(
    readFileSync(join(process.cwd(), 'src', 'screens', 'messenger', 'ChatScreen.tsx'), 'utf8')
      .replace(/\r\n/g, '\n'),
  );

  /** The `ForwardList` declaration body, so the assertion cannot be satisfied by
   *  an unrelated filter elsewhere in this 3800-line file. */
  function forwardListBody(): string {
    const start = CHAT.indexOf('export function ForwardList(');
    expect(start).toBeGreaterThan(-1);
    const end = CHAT.indexOf('\nexport {previewForReply};', start);
    return CHAT.slice(start, end === -1 ? start + 3000 : end);
  }

  it('asks the shared departmental resolver rather than re-testing the type', () => {
    // `type === 'group'` cannot tell a channel from an ordinary group — that is
    // the whole reason `deptChannelTarget` exists. A local re-implementation
    // would read only one of its two signals.
    expect(CHAT).toMatch(
      /import \{resolveDeptConversation\} from '@\/modules\/messenger\/push\/deptChannelTarget'/,
    );
  });

  it('excludes departmental conversations from the target rows', () => {
    const body = forwardListBody();
    const rowsAt = body.indexOf('const rows =');
    expect(rowsAt).toBeGreaterThan(-1);
    // The DECISION SITE: the filter that builds the offered rows, not merely the
    // symbol appearing somewhere in the function.
    const rows = body.slice(rowsAt, body.indexOf(';', rowsAt));
    expect(rows).toMatch(/!resolveDeptConversation\(/);
    // …and it must still exclude the conversation you are forwarding FROM.
    expect(rows).toMatch(/c\.id !== currentConvId/);
  });

  it('feeds the resolver BOTH registry signals', () => {
    // `deptGroupByChannel` alone is B-206-prunable; `deptConversationIds` alone
    // carries no channel id. Reading one is how a channel slips back in.
    const body = forwardListBody();
    expect(body).toMatch(/deptConversationIds/);
    expect(body).toMatch(/deptGroupByChannel/);
  });
});
