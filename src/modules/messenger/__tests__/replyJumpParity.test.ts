/**
 * "When I reply a message, if I click on that message it should be kinda
 * highlighted like WhatsApp. If that replied message is a lot upper than the
 * view, the message view should go up when clicking on the reply message."
 *
 * ChatScreen already did this. DepartmentChatScreen did not — its reply quote
 * was an inert <View>, so tapping it did nothing.
 *
 * The two screens cannot share an implementation: ChatScreen is an inverted
 * FlatList and jumps by scrollToIndex; this screen is a plain ScrollView with
 * no index, so each row records its own y offset on layout and it scrolls to
 * that. Same behaviour, necessarily different mechanism.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const R = process.cwd();
function code(rel: string[]): string {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of readFileSync(join(R, ...rel), 'utf8').split(/\r?\n/)) {
    const t = raw.trim();
    if (inBlock) { if (t.includes('*/')) {inBlock = false;} continue; }
    if (t.startsWith('/*') || t.startsWith('{/*')) { if (!t.includes('*/')) {inBlock = true;} continue; }
    if (t.startsWith('*') || t.startsWith('//')) {continue;}
    out.push(raw);
  }
  return out.join('\n');
}

const dept = code(['src', 'screens', 'messenger', 'DepartmentChatScreen.tsx']);
const chat = code(['src', 'screens', 'messenger', 'ChatScreen.tsx']);

describe('tapping a reply quote jumps to the quoted message', () => {
  it('the quote is tappable, not an inert View', () => {
    expect(dept).toMatch(/onPress=\{\(\) => jumpToMessage\(m\.reply_to_msg_id!\)\}/);
  });

  it('rows record their own offset, since there is no index to scroll to', () => {
    expect(dept).toMatch(/onLayout=\{e => \{ msgOffsets\.current\[m\.id\] = e\.nativeEvent\.layout\.y; \}\}/);
    expect(dept).toMatch(/const msgOffsets = useRef<Record<string, number>>\(\{\}\)/);
  });

  it('it scrolls with lead-in, not flush to the top edge', () => {
    expect(dept).toMatch(/scrollTo\(\{y: Math\.max\(0, y - 90\), animated: true\}\)/);
  });

  it('it highlights EVEN IF no scroll was needed', () => {
    // A quoted message already on screen has nothing to scroll to, but the
    // user still needs to be shown which one it was — gating the highlight on
    // a successful scroll is the obvious wrong shortcut here.
    const fn = dept.slice(dept.indexOf('const jumpToMessage = useCallback'));
    const body = fn.slice(0, fn.indexOf('}, []);'));
    const scrollAt = body.indexOf('scrollRef.current?.scrollTo');
    const hlAt = body.indexOf('setHighlightedId(targetId)');
    expect(hlAt).toBeGreaterThan(scrollAt);
    // …and outside the `typeof y === 'number'` guard.
    expect(body.slice(scrollAt, hlAt)).toMatch(/\}/);
  });

  it('the highlight clears itself, and only if it is still ours', () => {
    // A second jump landing inside the timeout must not have its highlight
    // wiped by the FIRST jump's timer.
    expect(dept).toMatch(/setHighlightedId\(c => \(c === targetId \? null : c\)\)/);
  });

  it('the bubble actually renders the highlight', () => {
    expect(dept).toMatch(/highlightedId === m\.id && styles\.bubbleJumped/);
    expect(dept).toMatch(/bubbleJumped: \{backgroundColor: 'rgba\(91,141,239,0\.32\)'/);
  });

  it('ChatScreen still has its own equivalent', () => {
    // The parity reference. If this ever disappears the dept copy is no longer
    // matching anything.
    expect(chat).toMatch(/const jumpToMessage = /);
    expect(chat).toMatch(/setHighlightedId\(targetId\)/);
  });
});

describe('M12 fork fallback — a dedup-forked target (X → X#n) is still jumpable', () => {
  // appendMessage resolves an id collision by rewriting the row to `X#n`
  // (messengerStore M12), but the reply on the OTHER side still carries X —
  // so an exact-id findIndex can never land on the forked row. Reactions
  // already have a fallback (findReactionTarget); the jump needs one too.
  const fn = chat.slice(chat.indexOf('const jumpToMessage = '));
  const body = fn.slice(0, fn.indexOf('const jumpToMessageRef'));

  it('exact match is tried first, the fork fallback second', () => {
    const exact = body.indexOf('it.msg.id === target');
    const fork = body.indexOf("it.msg.id.startsWith(target + '#')");
    expect(exact).toBeGreaterThan(-1);
    expect(fork).toBeGreaterThan(exact);
  });

  it('the highlight uses the RESOLVED id, so the forked row still pulses', () => {
    // Highlighting the raw target would scroll correctly but pulse nothing:
    // the bubble comparator checks highlightedId === msg.id, and msg.id is
    // the forked value.
    expect(body).toMatch(/const targetId = /);
    expect(body).toContain('setHighlightedId(targetId)');
  });
});
