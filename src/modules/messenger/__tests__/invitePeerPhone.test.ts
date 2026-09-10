/**
 * B-338 — the mid-call "Add" sheet must show the person's real NUMBER, not a
 * raw account id.
 *
 * Founder report (2026-07-30): "when adding someone in the call, when we press
 * add it shows the name — that is fine. But along with it, it shows an
 * encrypted number; it should be showing the real number."
 *
 * The sheet rendered `{c.userId.slice(0, 12)}` under the name — the first 12
 * chars of the account UUID (`1350939f-8c7`), which reads as garbage. Chat Info
 * already had a private phone resolver for its "number under the name" row; the
 * invite sheet never used it. Fixed by extracting ONE shared resolver
 * (`resolvePeerPhone`) that both surfaces call.
 *
 * Pinned here: the resolver's rules (unit), plus a source scan proving the sheet
 * no longer prints the raw id and that Chat Info was migrated to the shared
 * helper rather than left as a second copy. Screens mount RN views so the node
 * project cannot import them; both files are CRLF, so nothing is `\n`-anchored.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {resolvePeerPhone} from '../contacts/peerPhone';

function strip(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\/[^\r\n]*/g, '');
}

const PEER = 'peer-uuid-1';

describe('resolvePeerPhone', () => {
  it('returns the E.164 captured on the direct conversation row', () => {
    const convs = {
      c1: {type: 'direct', peer: {userId: PEER}, phoneE164: '+8801700000001'},
    };
    expect(resolvePeerPhone(convs, PEER)).toBe('+8801700000001');
  });

  it('ignores GROUP rows even when they somehow carry a phone', () => {
    const convs = {
      g1: {type: 'group', peer: {userId: PEER}, phoneE164: '+8809999999999'},
    };
    expect(resolvePeerPhone(convs, PEER)).toBeUndefined();
  });

  it('ignores a direct row for a DIFFERENT peer', () => {
    const convs = {
      c1: {type: 'direct', peer: {userId: 'someone-else'}, phoneE164: '+8801700000002'},
    };
    expect(resolvePeerPhone(convs, PEER)).toBeUndefined();
  });

  it('skips a matching row that has no phone and keeps scanning', () => {
    const convs = {
      a: {type: 'direct', peer: {userId: PEER}},
      b: {type: 'direct', peer: {userId: PEER}, phoneE164: '+8801700000003'},
    };
    expect(resolvePeerPhone(convs, PEER)).toBe('+8801700000003');
  });

  it('prefers a dev-seeded number (test rigs never run contact discovery)', () => {
    expect(resolvePeerPhone({}, PEER, [{userId: PEER, phoneE164: '+971500000000'}]))
      .toBe('+971500000000');
  });

  it('returns undefined — never a fabricated value — when the number is unknown', () => {
    expect(resolvePeerPhone({}, PEER)).toBeUndefined();
    expect(resolvePeerPhone({}, '')).toBeUndefined();
    expect(resolvePeerPhone({u: undefined}, PEER)).toBeUndefined();
  });
});

describe('B-338 — the invite sheet stops printing the raw account id', () => {
  const sheet = (): string => {
    const s = strip('src', 'screens', 'messenger', 'GroupCallScreen.tsx');
    const at = s.indexOf('data={inviteCandidates}');
    expect(at).toBeGreaterThan(-1);
    return s.slice(at, at + 1600);
  };

  it('the row no longer renders userId.slice(...) as the subtitle', () => {
    // The exact shape this bug shipped as.
    expect(sheet()).not.toMatch(/\{c\.userId\.slice\(/);
  });

  it('the candidate carries a resolved phone the row can show', () => {
    const s = strip('src', 'screens', 'messenger', 'GroupCallScreen.tsx');
    expect(s).toMatch(/resolvePeerPhone\(/);
    expect(sheet()).toMatch(/phoneE164/);
  });
});

describe('B-338 — Chat Info uses the shared resolver, not a second copy', () => {
  it('ChatInfoScreen delegates to resolvePeerPhone', () => {
    const s = strip('src', 'screens', 'messenger', 'ChatInfoScreen.tsx');
    expect(s).toMatch(/resolvePeerPhone\(/);
    // A thin named binding may stay (several call sites use it); what must NOT
    // survive is a SECOND COPY of the lookup logic — the drift this fix closes.
    // The duplicate's signature shape: scan conversations for a direct row.
    expect(s).not.toMatch(/type === 'direct' && c\.peer\?\.userId === userId,?\s*\)\s*;?\s*return conv\?\.phoneE164/);
  });
});
