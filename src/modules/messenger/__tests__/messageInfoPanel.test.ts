/**
 * B-264 / B-265 — the "Message info" sheet, the one panel whose entire job is
 * delivery state, was the one place that never showed it properly.
 *
 * B-265 — it rendered from `infoMsg`, a SNAPSHOT captured when the sheet
 * opened. Every receipt that landed while it was on screen was invisible; you
 * had to close and reopen to see anything change.
 *
 * B-264 — it printed a time only for `status === 'read'`. A `delivered`
 * receipt collapsed to a bare dash, so a message that HAD reached someone's
 * device looked identical to one that had gone nowhere. And a DIRECT row
 * usually carries no `participants` array, so on a 1:1 the member list came out
 * empty and the sheet rendered a bare "Read by" heading with nothing under it.
 *
 * `messageInfoTime` is pure and unit-tested. The wiring lives in ChatScreen,
 * which the node project cannot mount, so it is pinned by a comment-stripped
 * source scan — the file is CRLF, so nothing here is `\n`-anchored.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {messageInfoTime} from '../ui/chatScreenLogic';

const CHAT = join(process.cwd(), 'src', 'screens', 'messenger', 'ChatScreen.tsx');

function code(): string {
  return readFileSync(CHAT, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\/[^\r\n]*/g, '');
}

describe('B-264 — messageInfoTime', () => {
  // Fixed instants so the day boundary is exercised without freezing the clock.
  const NOON = new Date(2026, 6, 26, 12, 0, 0).getTime();
  const EARLIER_TODAY = new Date(2026, 6, 26, 9, 17, 0).getTime();
  const YESTERDAY = new Date(2026, 6, 25, 15, 18, 0).getTime();

  it('a receipt from today shows the clock time alone', () => {
    const out = messageInfoTime(EARLIER_TODAY, NOON);
    expect(out).toMatch(/9[:.]17/);
    expect(out).not.toMatch(/Jul|26/);
  });

  it('an older receipt is DATED — a bare clock would read as today', () => {
    // The reason this helper exists rather than a raw toLocaleTimeString:
    // "3:18 pm" on a week-old message is not just vague, it is wrong.
    const out = messageInfoTime(YESTERDAY, NOON);
    expect(out).toMatch(/3[:.]18|15[:.]18/);
    expect(out).toMatch(/25/);
  });

  it('a missing or nonsense timestamp yields empty, never "Invalid Date"', () => {
    for (const bad of [undefined, 0, -1, NaN, Infinity]) {
      expect(messageInfoTime(bad as number | undefined, NOON)).toBe('');
    }
  });

  it('the boundary is the calendar DAY, not a 24-hour window', () => {
    // 23:59 yesterday is ~1 minute before 00:05 today, but it is still a
    // different day and must be dated.
    const lateYesterday = new Date(2026, 6, 25, 23, 59, 0).getTime();
    const earlyToday = new Date(2026, 6, 26, 0, 5, 0).getTime();
    expect(messageInfoTime(lateYesterday, earlyToday)).toMatch(/25/);
    expect(messageInfoTime(earlyToday, earlyToday)).not.toMatch(/25/);
  });
});

describe('B-265 — the sheet reads LIVE state, not a snapshot', () => {
  it('CONTROL: the scan sees the sheet', () => {
    expect(code()).toContain('liveInfoMsg');
  });

  it('the receipt lookup goes through the live row, not the captured one', () => {
    // The bug exactly: `infoMsg.receipts` is frozen at open time.
    const src = code();
    expect(src).not.toContain('infoMsg.receipts');
    expect(src).toContain('liveInfoMsg.receipts');
  });

  it('the live row is resolved from the store by message id', () => {
    const src = code();
    expect(src).toMatch(/useMessengerStore\(s => \{[\s\S]{0,400}?find\(m => m\.id === infoMsg\.id\)/);
  });

  it('a deleted row falls back to the snapshot instead of blanking the sheet', () => {
    expect(code()).toMatch(/find\(m => m\.id === infoMsg\.id\) \?\? infoMsg/);
  });
});

describe('B-264 — the sheet wiring', () => {
  it('a DELIVERED receipt gets a time, not a dash', () => {
    const src = code();
    expect(src).toContain('`Delivered ${at}`');
    expect(src).toContain('`Seen ${at}`');
  });

  it('the timestamp goes through the shared helper, not an inline formatter', () => {
    // Two copies of a time format is how the sheet and the bubble drift.
    const src = code();
    expect(src).toContain('messageInfoTime(r.ts)');
  });

  it('a 1:1 falls back to the thread peer when participants is absent', () => {
    // Direct rows usually have no participants array, which emptied the list
    // and left the sheet blank on every 1:1.
    const src = code();
    expect(src).toMatch(/rawMembers\.length > 0[\s\S]{0,160}peerUserId/);
  });
});
