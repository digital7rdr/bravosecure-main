/**
 * BS-RECENTS — the Add-to-group / New-chat picker must offer people you
 * already chat with, and add-by-number in add-to-group mode.
 *
 * Founder report (2026-07-29, screenshots): a 1:1 peer reached via
 * "Message by Number" (not in the address book) never appeared in the
 * "Add to <group>" list, and there was no way to add by number.
 *
 * Pinned here (NewChatScreen mounts RN views — the node project cannot
 * import it, so this is a comment-stripped source scan; the file is CRLF,
 * nothing is `\n`-anchored):
 *  1. the recents source feeds the multi-select CONFIRM pass — rendering
 *     recents but not reading them at confirm time silently drops the
 *     selection, which is the trap this wiring invites;
 *  2. the by-number flow branches to addMemberToGroup in add-to-group mode
 *     instead of opening a 1:1 chat;
 *  3. RecentChatsSection renders independent of contact-discovery state —
 *     no permission/loading/error gating inside it — and sits in the tree;
 *  4. the recents derivation dedups against BOTH other people-sources and
 *     self (double rows are the duplicate-copy class);
 *  5. the by-number row copy is mode-aware ("Add by Number" while adding).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

function code(): string {
  return readFileSync(join(process.cwd(), 'src', 'screens', 'messenger', 'NewChatScreen.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\/[^\r\n]*/g, '');
}

describe('BS-RECENTS — picker offers existing chat peers + add-by-number', () => {
  it('the multi-select confirm pass reads the recents source', () => {
    const src = code();
    const at = src.indexOf('const rows = [');
    expect(at).toBeGreaterThan(-1);
    const gather = src.slice(at, at + 500);
    expect(gather).toMatch(/visibleMatches\.filter\(/);
    expect(gather).toMatch(/visibleRecents\.filter\(/);
    expect(gather).toMatch(/visibleDevContacts\.filter\(/);
  });

  it('by-number branches to addMemberToGroup in add-to-group mode', () => {
    const src = code();
    const at = src.indexOf('const startChatByNumber');
    expect(at).toBeGreaterThan(-1);
    const fn = src.slice(at, at + 3500);
    expect(fn).toMatch(/if \(addToGroupId\)/);
    expect(fn).toMatch(/await addMemberToGroup\(/);
  });

  it('RecentChatsSection is rendered and has no contact-discovery gating', () => {
    const src = code();
    expect(src).toMatch(/<RecentChatsSection/);
    const at = src.indexOf('function RecentChatsSection');
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf('function RealContactsSection'));
    expect(body.length).toBeGreaterThan(0);
    expect(body).not.toMatch(/permission/);
    expect(body).not.toMatch(/loading/);
  });

  it('recents dedup against contacts, dev contacts and self', () => {
    const src = code();
    const at = src.indexOf('recentDirectPeers(conversations');
    expect(at).toBeGreaterThan(-1);
    const call = src.slice(at, at + 400);
    expect(call).toMatch(/matches\.map\(m => m\.userId\)/);
    expect(call).toMatch(/devContacts\.map\(d => d\.userId\)/);
    expect(call).toMatch(/currentUser\?\.id/);
  });

  it('the by-number row copy is mode-aware', () => {
    const src = code();
    expect(src).toMatch(/addToGroupId \? 'Add by Number' : 'Message by Number'/);
  });
});
