/**
 * Departmental chat must carry EVERY messenger-group thread feature.
 *
 * Reported: "I want my department chat to be same as messenger group, all the
 * feature should be present, also the few we add also be there."
 *
 * It already had reply, reactions, copy, forward, delete, @mentions and
 * announcements. Missing: **Edit** and **Message info**. Both are ported here
 * against the SAME runtime call ChatScreen uses, so the wire directive is
 * identical for a department channel.
 *
 * Both screens mount RN + Modals and import expo-clipboard, which the node
 * project's transform cannot parse — hence a source scan. Line-based, because
 * these files are CRLF and a `\n`-anchored regex would pass vacuously.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const SCREENS = join(process.cwd(), 'src', 'screens', 'messenger');
const DEPT = join(SCREENS, 'DepartmentChatScreen.tsx');
const CHAT = join(SCREENS, 'ChatScreen.tsx');

function code(path: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const t = raw.trim();
    if (inBlock) { if (t.includes('*/')) {inBlock = false;} continue; }
    if (t.startsWith('/*') || t.startsWith('{/*')) { if (!t.includes('*/')) {inBlock = true;} continue; }
    if (t.startsWith('*') || t.startsWith('//')) {continue;}
    out.push(raw);
  }
  return out.join('\n');
}

describe('departmental chat has every messenger-group thread action', () => {
  const dept = code(DEPT);

  // The features that were already there — pinned so a refactor of the sheet
  // cannot quietly drop one while adding the new pair.
  it.each([
    ['Reply',        /sheetRowText}>Reply</],
    ['Copy',         /sheetRowText}>Copy</],
    ['Forward',      /sheetRowText}>Forward</],
    ['Delete',       /Delete \(this device\)/],
    ['reactions',    /reactToMessage\(actionMsg, emoji\)/],
  ])('still offers %s', (_label, re) => {
    expect(dept).toMatch(re as RegExp);
  });

  it('offers Edit', () => {
    expect(dept).toMatch(/sheetRowText}>Edit</);
    expect(dept).toMatch(/const startEdit = useCallback/);
  });

  it('offers Message info', () => {
    expect(dept).toMatch(/sheetRowText}>Message info</);
    expect(dept).toMatch(/const openInfo = useCallback/);
  });
});

describe('Edit is wired to the same runtime directive ChatScreen uses', () => {
  const dept = code(DEPT);

  it('dispatches through runtime.sendMessageEdit', () => {
    expect(dept).toMatch(/rt\.sendMessageEdit\(/);
    // ChatScreen is the reference implementation; if that call is ever renamed
    // this catches the dept copy drifting rather than silently no-oping.
    expect(code(CHAT)).toMatch(/sendMessageEdit\(/);
  });

  it('the edit path returns BEFORE the normal post path', () => {
    // Falling through would post a duplicate message instead of patching.
    const send = dept.slice(dept.indexOf('const send = useCallback'));
    const editAt = send.indexOf('if (editing) {');
    const sendTextAt = send.indexOf('rt.sendText(');
    expect(editAt).toBeGreaterThan(-1);
    expect(sendTextAt).toBeGreaterThan(editAt);
    expect(send.slice(editAt, sendTextAt)).toMatch(/\breturn;/);
  });

  it('a no-op edit sends nothing', () => {
    expect(dept).toMatch(/if \(text === target\.original\) \{return;\}/);
  });

  it('editing clears any armed reply', () => {
    // A quote attached to an edit has no meaning on the wire — the directive
    // patches an existing row, it does not create one.
    const fn = dept.slice(dept.indexOf('const startEdit = useCallback'));
    expect(fn.slice(0, fn.indexOf('}, []);'))).toMatch(/setReplyTo\(null\)/);
  });

  it('the reply banner yields to the edit banner', () => {
    // Both render in the same slot; showing both would stack two bars and
    // imply the edit carries a quote.
    expect(dept).toMatch(/\{replyTo && !editing && \(/);
  });

  it('edit is offered only on your OWN text messages', () => {
    // You cannot edit someone else's row, and an edit directive carries a text
    // body so it cannot target media or a voice note.
    expect(dept).toMatch(
      /!!actionMsg\.content && \(actionMsg\.sender_id === 'self' \|\| actionMsg\.sender_id === myId\)/,
    );
  });

  it('there is a way OUT of edit mode', () => {
    // Without a cancel the composer silently patches an old row forever
    // instead of posting.
    expect(dept).toMatch(/const cancelEdit = useCallback/);
    expect(dept).toMatch(/onPress=\{cancelEdit\}/);
  });
});

describe('Message info reports receipts the same way ChatScreen does', () => {
  const dept = code(DEPT);

  it('excludes the author from the reader list', () => {
    // The receipts map is "who ELSE has seen this"; listing yourself gives a
    // permanent dash next to your own name — the same root cause as the
    // missing blue tick in 1:1.
    expect(dept).toMatch(/\.filter\(uid => uid && uid !== myId\)/);
  });

  it('distinguishes read from merely delivered', () => {
    expect(dept).toMatch(/r\?\.status === 'read'/);
    expect(dept).toMatch(/name=\{r\.read \? 'check-all' : 'check'\}/);
  });

  it('is offered only on messages you sent', () => {
    const sheet = dept.slice(dept.indexOf('sheetRowText}>Message info<') - 400);
    expect(sheet).toMatch(/sender_id === 'self' \|\| actionMsg\.sender_id === myId/);
  });

  it('resolves names from the channel roster, not raw ids', () => {
    expect(dept).toMatch(/memberNames\?\.\[uid\] \?\? uid\.slice\(0, 8\)/);
  });
});

/**
 * Direction is now OWNERSHIP-DEPENDENT (founder rule): swipe RIGHT to reply to
 * someone else's message, LEFT to reply to your own. The assertions below used
 * to pin right-only; the intent — one clamped direction, never an unclamped
 * drag that could read as a delete — is unchanged and still enforced, per
 * bubble. Full contract in screens/messenger/__tests__/deptChatSendAndSwipe.
 */
describe('swipe-to-reply, ported from the messenger thread', () => {
  const dept = code(DEPT);

  it('the message row is wrapped in the swipe handler, and knows whose it is', () => {
    expect(dept).toMatch(/<SwipeToReplyRow mine=\{mine\} onReply=\{\(\) => startReply\(m\)\}>/);
  });

  it('it is a component, not a hook in the .map()', () => {
    // The list is a .map(); hooks cannot live in a loop.
    expect(dept).toMatch(/function SwipeToReplyRow\(/);
  });

  it('it commits at the same threshold ChatScreen uses', () => {
    expect(dept).toMatch(/const SWIPE_REPLY_THRESHOLD = 60/);
    expect(dept).toMatch(/translationX >\s*SWIPE_REPLY_THRESHOLD/);
    expect(dept).toMatch(/translationX < -SWIPE_REPLY_THRESHOLD/);
  });

  it('ONE direction per bubble — the clamp pins the other at 0', () => {
    // An unclamped drag the other way would read as a delete gesture.
    expect(dept).toMatch(/inputRange:\s*mine \? \[-120, 0\] : \[0, 120\]/);
    expect(dept).toMatch(/outputRange:\s*mine \? \[-120, 0\] : \[0, 120\]/);
    expect(dept).toMatch(/failOffsetX=\{mine \? 16 : -16\}/);
  });

  it('vertical intent still belongs to the scroll view', () => {
    expect(dept).toMatch(/failOffsetY=\{\[-14, 14\]\}/);
  });

  it('it springs home on cancel as well as on release', () => {
    // A cancelled gesture that never springs back leaves the row shoved
    // sideways for the rest of the session (the B-242 class).
    expect(dept).toMatch(/GestureState\.CANCELLED \|\| state === GestureState\.FAILED/);
  });

  it('the callback is ref-mirrored so it cannot go stale', () => {
    expect(dept).toMatch(/onReplyRef\.current = onReply/);
  });
});
