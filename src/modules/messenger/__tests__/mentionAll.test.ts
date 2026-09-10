/**
 * B-271 — `@all` in a group.
 * B-270 — the mention picker recomputed on every keystroke.
 *
 * `@all` is a SYNTHETIC roster entry with a sentinel userId, expanded to one
 * mention per member at send time. The ordering is the whole design:
 * `reconcileMentions` keeps only mentions whose LABEL still appears in the
 * body, and after expansion the per-member labels do NOT appear (the body says
 * "@all"), so expanding before that call would have it strip every one of them
 * back out. Expansion therefore happens AFTER the last reconcile, and nothing
 * downstream ever sees the sentinel.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {
  expandAllMentions, mentionAllCandidate, reconcileMentions,
  MENTION_ALL_ID, MENTION_ALL_LABEL,
} from '../runtime/mentionText';

const label = (uid: string): string => ({'u-a': 'Alice', 'u-b': 'Bob', 'u-c': 'Cara'} as Record<string, string>)[uid] ?? uid;

describe('B-271 — expandAllMentions', () => {
  it('replaces the sentinel with one mention per member', () => {
    const out = expandAllMentions([{userId: MENTION_ALL_ID, label: MENTION_ALL_LABEL}], ['u-a', 'u-b'], label);
    expect(out).toEqual([{userId: 'u-a', label: 'Alice'}, {userId: 'u-b', label: 'Bob'}]);
  });

  it('the sentinel NEVER survives to the wire', () => {
    // Downstream keys off userId. A sentinel that leaked would be treated as a
    // real recipient id by the notification fan-out.
    const out = expandAllMentions([{userId: MENTION_ALL_ID, label: 'all'}], ['u-a'], label);
    expect(out.some(m => m.userId === MENTION_ALL_ID)).toBe(false);
  });

  it('a list with no @all is returned untouched', () => {
    const mentions = [{userId: 'u-a', label: 'Alice'}];
    expect(expandAllMentions(mentions, ['u-a', 'u-b'], label)).toEqual(mentions);
  });

  it('@all plus an explicit mention does NOT ping that person twice', () => {
    const out = expandAllMentions(
      [{userId: 'u-b', label: 'Bob'}, {userId: MENTION_ALL_ID, label: 'all'}],
      ['u-a', 'u-b'], label,
    );
    expect(out.map(m => m.userId)).toEqual(['u-b', 'u-a']);
  });

  it('an empty roster yields no mentions rather than a lone sentinel', () => {
    expect(expandAllMentions([{userId: MENTION_ALL_ID, label: 'all'}], [], label)).toEqual([]);
  });

  it('the caller is responsible for excluding self — the helper trusts the list', () => {
    // Documented contract: passing self in would notify you about your own
    // message. Pinned so a future caller cannot assume the helper filters.
    const out = expandAllMentions([{userId: MENTION_ALL_ID, label: 'all'}], ['u-me'], () => 'Me');
    expect(out).toEqual([{userId: 'u-me', label: 'Me'}]);
  });
});

describe('B-271 — the reconcile ordering that makes it work', () => {
  it('the SENTINEL survives reconcile, because "@all" is in the body', () => {
    const picked = [{userId: MENTION_ALL_ID, label: MENTION_ALL_LABEL}];
    expect(reconcileMentions('hey @all standup now', picked)).toEqual(picked);
  });

  it('EXPANDED mentions would NOT survive reconcile — hence expand last', () => {
    // The trap, stated as a test. Expanding before the runtime's reconcile
    // silently drops every mention, and @all looks like it does nothing.
    const expanded = [{userId: 'u-a', label: 'Alice'}, {userId: 'u-b', label: 'Bob'}];
    expect(reconcileMentions('hey @all standup now', expanded)).toEqual([]);
  });

  it('the runtime expands AFTER its reconcile, not before', () => {
    const src = readFileSync(
      join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts'), 'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\r\n]*/g, '');
    const reconcileAt = src.indexOf('const clean = reconcileMentions(text');
    const expandAt = src.indexOf('expandAllMentions(clean');
    expect(reconcileAt).toBeGreaterThan(-1);
    expect(expandAt).toBeGreaterThan(reconcileAt);
  });
});

describe('B-271 — the picker offers @all in GROUPS only', () => {
  const src = readFileSync(
    join(process.cwd(), 'src', 'screens', 'messenger', 'ChatScreen.tsx'), 'utf8',
  ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '').replace(/\/\/[^\r\n]*/g, '');

  it('the synthetic entry is prepended, and gated on isGroup', () => {
    // In a 1:1 it is a synonym for the one other person — noise.
    expect(src).toContain('isGroup ? [mentionAllCandidate(), ...roster] : roster');
  });

  it('isGroup is a dependency of the roster memo', () => {
    // Otherwise a thread that resolves its group-ness late keeps a roster with
    // no @all for the rest of the visit.
    expect(src).toMatch(/directoryNamesForMentions, isGroup\]/);
  });

  it('mentionAllCandidate is stable in shape', () => {
    expect(mentionAllCandidate()).toEqual({userId: MENTION_ALL_ID, label: MENTION_ALL_LABEL});
  });
});

describe('B-270 — the picker no longer recomputes per keystroke', () => {
  const src = readFileSync(
    join(process.cwd(), 'src', 'screens', 'messenger', 'ChatScreen.tsx'), 'utf8',
  ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '').replace(/\/\/[^\r\n]*/g, '');

  it('both the token scan and the roster filter are memoised', () => {
    // They ran on every composer render — so every keystroke paid a body
    // rescan plus a full roster walk, and the fresh array identity repainted
    // the picker list even when the matches were identical.
    expect(src).toMatch(/const mentionToken = useMemo\(/);
    expect(src).toMatch(/const mentionMatches = useMemo\(/);
  });

  it('the caret is a dependency — moving the cursor must re-scan', () => {
    // `text` alone is not enough: moving into a different @token changes the
    // active query with no text change at all.
    expect(src).toMatch(/\[mentionRoster, text, caretPos\]/);
  });

  it('the empty case returns ONE frozen array, not a fresh [] per render', () => {
    expect(src).toContain('EMPTY_MENTIONS');
    expect(src).toMatch(/const EMPTY_MENTIONS[\s\S]{0,120}Object\.freeze\(\[\]\)/);
  });
});
