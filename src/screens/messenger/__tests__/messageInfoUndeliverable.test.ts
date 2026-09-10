/**
 * B-683 follow-up (WhatsApp "Message info" parity) — the per-member info
 * sheet distinguishes a member whose device terminally DESTROYED its copy
 * ("Not delivered", alert icon) from one that simply has not acked yet
 * ("—"). Data source is the B-683 `undeliverable_legs` map; a
 * delivered/read receipt always wins over a stale failure record.
 *
 * Source scan — ChatScreen mounts heavy natives; the sheet's decision
 * logic is pinned at the source site (CRLF-safe, comment-stripped).
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'ChatScreen.tsx'),
  'utf8',
);

function stripLineComments(s: string): string {
  return s
    .split(/\r?\n/)
    .map(l => {
      const i = l.indexOf('//');
      return i === -1 ? l : l.slice(0, i);
    })
    .join('\n');
}

describe('B-683 follow-up — Message info shows Not delivered per member', () => {
  const start = SRC.indexOf('Message info: per-member read status');
  const end = SRC.indexOf('sheetCancel', start);
  const sheet = stripLineComments(SRC.slice(start, end));

  it('consults undeliverable_legs for the member row', () => {
    expect(start).toBeGreaterThan(-1);
    expect(sheet).toContain('liveInfoMsg.undeliverable_legs?.[uid]');
  });

  it('renders the Not delivered label and the alert icon color', () => {
    expect(sheet).toContain('Not delivered');
    expect(sheet).toContain('Bravo.alert');
  });

  it('a receipt wins over a stale failure record (guarded on !r)', () => {
    expect(sheet).toMatch(/!r \? liveInfoMsg\.undeliverable_legs\?\.\[uid\]/);
  });
});
