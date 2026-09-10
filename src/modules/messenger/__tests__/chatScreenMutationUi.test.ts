import {readFileSync} from 'node:fs';
import {join} from 'node:path';

/**
 * Static source scan of the edit / delete-for-everyone / mention UI in
 * `ChatScreen.tsx`.
 *
 * Why a scan: `ChatScreenInner` is ~1,700 lines with zero tests and commits
 * averaging 34 files (MESSAGE_LOOP §6 "Deferred / parked"), and it cannot be
 * mounted in the node project at all. The behavioural rules these features rest
 * on ARE tested — messageMutationGate, messageMutationApply, mentionText,
 * LinkifiedText.mentions — so what is left, and what only a scan can reach, is
 * whether the screen is wired to them and whether the destructive paths are
 * guarded before they fire.
 *
 * TRAPS this file is written around (each has cost this repo a session):
 *  - line endings. On a CRLF checkout a `\n`-anchored regex matches nothing and
 *    the test passes VACUOUSLY, so `source()` normalizes CRLF away and every
 *    assertion below reads the normalized text.
 *  - prose containing a banned word is the most common false result, so every
 *    absence assertion runs on COMMENT-STRIPPED source.
 */

const CHAT = join(process.cwd(), 'src', 'screens', 'messenger', 'ChatScreen.tsx');

// Why: the scan must read identically on a CRLF and an LF checkout — see the
// line-endings trap above. Normalizing here covers every assertion at once.
function normalizeEol(src: string): string {
  return src.replace(/\r\n/g, '\n');
}

function source(): string {
  return normalizeEol(readFileSync(CHAT, 'utf8'));
}

function code(): string {
  return source().replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\/[^\n]*/g, '');
}

describe('line endings cannot make this scan pass vacuously', () => {
  it('CRLF is normalized away, so a bare \\n anchor matches on either checkout', () => {
    expect(normalizeEol('a\r\nb')).toBe('a\nb');
    expect(source()).not.toContain('\r');
  });
});

describe('the action sheet offers the actions only when they are legal', () => {
  it('Edit is gated by canEditOwnMessage', () => {
    // Same predicate the runtime re-checks before shipping, so a row offered
    // here can never be refused there.
    expect(code()).toContain('canEditOwnMessage(actionMsg)');
  });

  it('Delete for everyone is gated by canDeleteForEveryone', () => {
    expect(code()).toContain('canDeleteForEveryone(actionMsg)');
  });

  it('both predicates come from the shared gate module, not re-derived locally', () => {
    // A hand-rolled `Date.now() - created < 15*60*1000` here would drift from
    // the runtime's copy, and the drift would show up as an action that is
    // offered and then silently refused.
    expect(source()).toContain("from '@/modules/messenger/runtime/messageMutationGate'");
    const c = code();
    expect(c).not.toMatch(/15\s*\*\s*60\s*\*\s*1000/);
    expect(c).not.toMatch(/48\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
  });

  it('delete-for-everyone CONFIRMS before it fires', () => {
    // It is not reversible; a mis-tap must not retract a message for a whole
    // group. DESIGN_REVIEW_LOOP §3.1 — confirmation on destructive actions.
    const c = code();
    const i = c.indexOf('const deleteForEveryone');
    expect(i).toBeGreaterThan(-1);
    const body = c.slice(i, i + 1400);
    expect(body).toContain('Alert.alert(');
    expect(body).toContain("style: 'destructive'");
    expect(body).toContain("{text: 'Cancel', style: 'cancel'}");
  });

  it('uses the branded alert, never react-native Alert (repo-wide rule)', () => {
    expect(source()).toContain("import {Alert} from '@utils/alert'");
  });

  it('delete-for-everyone drops the queued outbox row before retracting', () => {
    // A message the author is retracting must not still be shipped by the next
    // reconnect drain — P2-10's reasoning, one step earlier in the lifecycle.
    const c = code();
    const i = c.indexOf('const deleteForEveryone');
    expect(c.slice(i, i + 1400)).toContain('discardOutboxForMessage(msg.id)');
  });

  it('a TOMBSTONED message offers only "Delete for me"', () => {
    // Reply / copy / forward / edit / react on a retracted message would all
    // no-op; showing them is worse than hiding them.
    const c = code();
    expect(c).toContain('!actionMsg.deleted_for_all');
  });

  it('startReply refuses a tombstone — swipe-to-reply bypasses the sheet', () => {
    // The sheet hides Reply for a retracted row, but the swipe gesture calls
    // startReply directly; without this guard it arms a quote of deleted
    // content (WhatsApp blocks replying to a deleted message outright).
    const c = code();
    const i = c.indexOf('const startReply');
    expect(i).toBeGreaterThan(-1);
    const body = c.slice(i, i + 500);
    const guard = body.indexOf('if (msg.deleted_for_all) {return;}');
    const arm = body.indexOf('setReplyTo(');
    expect(guard).toBeGreaterThan(-1);
    expect(arm).toBeGreaterThan(guard);
  });
});

describe('the tombstone renders instead of the body, not alongside it', () => {
  it('the bubble body is an EARLY branch on deleted_for_all', () => {
    // Fail-closed: a future field added to the bubble must not render for a
    // retracted message by default.
    const c = code();
    expect(c).toContain('msg.deleted_for_all ? (');
  });

  it('reactions are suppressed on a tombstone', () => {
    expect(code()).toContain('!msg.deleted_for_all && msg.reactions');
  });

  it('the "edited" marker is suppressed on a tombstone', () => {
    expect(code()).toContain('msg.edited_at && !msg.deleted_for_all');
  });
});

describe('edit mode', () => {
  it('entering edit mode clears any armed reply', () => {
    // A quote attached to an EDIT has no meaning on the wire — the directive
    // patches an existing row rather than creating one.
    const c = code();
    const i = c.indexOf('const startEdit');
    expect(i).toBeGreaterThan(-1);
    expect(c.slice(i, i + 400)).toContain('setReplyTo(null)');
  });

  it('an unchanged body does NOT ship an edit', () => {
    // Otherwise every "cancel by sending the same text" bumps edited_at, marks
    // the message edited, and re-dirties the backup mirror for nothing.
    expect(code()).toContain('trimmed === target.original');
  });

  it('edit mode does not run the normal send pipeline', () => {
    // No bubble, no outbox row, no scroll-to-bottom: the patched row may be far
    // up the thread and jumping away from it is the wrong behaviour.
    const c = code();
    const i = c.indexOf('const send = async');
    const editBranch = c.slice(i, c.indexOf('const replySnapshot', i));
    expect(editBranch).toContain('sendMessageEdit(');
    expect(editBranch).toContain('return;');
  });

  it('the attach, timer and mic affordances are hidden while editing', () => {
    // Each would either fail on tap or silently change a delivered message's
    // burn deadline.
    const c = code();
    expect(c).toContain('{!isEditing && (');
    expect(c).toContain('hasText || justSent || isEditing ?');
  });
});

describe('mentions in the composer', () => {
  it('the picker is available on EVERY thread', () => {
    // REVERSED, deliberately. This originally asserted GROUP-ONLY, on the
    // reasoning that "in a 1:1 the message is already addressed to the only
    // other participant". The product owner has since required feature parity
    // across all threads — mentions, edit, delete-for-everyone and Message info
    // must behave identically in a 1:1, a group and a thread created tomorrow.
    // The 1:1 roster is simply the peer; see threadFeatureParity.test.ts.
    const c = code();
    const i = c.indexOf('const mentionRoster');
    expect(i).toBeGreaterThan(-1);
    const memo = c.slice(i, i + 600);
    expect(memo).not.toContain('if (!isGroup) {return undefined;}');
    // Still no empty picker: an unresolvable roster yields undefined.
    expect(memo).toContain('if (members.length === 0) {return undefined;}');
  });

  it('the roster excludes self', () => {
    const c = code();
    const i = c.indexOf('const mentionRoster');
    expect(c.slice(i, i + 500)).toContain('u !== selfUserId');
  });

  it('self is resolved from the AUTH uuid, not the vault owner key', () => {
    // `_ownUserId` is `email ?? phone ?? id`, so for any account with an email
    // it never equals a participants entry and "was I mentioned?" would be
    // structurally false — the same root cause as the missing group blue tick.
    expect(code()).toContain('s._ownAuthUserId ?? s._ownUserId');
  });

  it('mentions are reconciled against the final body on submit', () => {
    // Picking a name and then deleting it by hand must not still push
    // "you were mentioned".
    const c = code();
    const i = c.indexOf('const submit = ()');
    expect(c.slice(i, i + 700)).toContain('reconcileMentions(trimmed, picked)');
  });

  it('the picker list keeps the keyboard up while tapping a row', () => {
    // Without keyboardShouldPersistTaps the first tap only dismisses the IME
    // and the mention is never inserted.
    const c = code();
    const i = c.indexOf('styles.mentionSheet');
    expect(c.slice(i, i + 300)).toContain('keyboardShouldPersistTaps="always"');
  });

  it('the picker is height-capped and scrollable', () => {
    // A 30-member channel must not push the composer off-screen.
    expect(source()).toContain('mentionScroll:');
    expect(source()).toMatch(/mentionScroll:\s*\{maxHeight:\s*\d+\}/);
  });

  it('the mention rows meet the Android 48dp touch-target minimum', () => {
    const m = source().match(/mentionRow:\s*\{[^}]*(?:minHeight|height):\s*(\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(48);
  });
});

describe('the keyboard rule survives the new composer chrome (B-184)', () => {
  it('the inset moved to the composer COLUMN, above the picker and edit bar', () => {
    // Those two sit ABOVE the input. Leaving bottomPad on the input bar alone
    // would let the IME cover them.
    const c = code();
    expect(c).toContain('<View style={{paddingBottom: bottomPad(8)}}>');
  });

  it('still uses ONLY useKeyboardLayout — no hand-rolled avoidance', () => {
    // The banned list is enforced repo-wide by keyboardContract.test.ts; this
    // is a local guard so a regression is attributed to this screen.
    const c = code();
    expect(c).not.toContain('KeyboardAvoidingView');
    expect(c).not.toContain('keyboardVerticalOffset');
    expect(c).not.toMatch(/\bkbHeight\b/);
    expect(c).toContain('useKeyboardLayout()');
  });

  it('bottomPad appears exactly once — one element owns the inset', () => {
    // "THE BOTTOM-MOST ELEMENT OF A SURFACE OWNS THE KEYBOARD INSET." Two
    // consumers means two things react to the IME and one of them double-pads.
    expect((code().match(/bottomPad\(/g) ?? [])).toHaveLength(1);
  });
});
