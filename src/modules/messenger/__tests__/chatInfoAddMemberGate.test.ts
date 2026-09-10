import {readFileSync} from 'node:fs';
import {join} from 'node:path';

/**
 * B-222 — the "Add member" affordance was shown to EVERY group member and
 * dead-ended at a runtime alert.
 *
 * `ChatInfoScreen.tsx` hardcoded `const isAdmin = isGroup;` — i.e. "everyone in
 * a group is an admin" — while the REAL discriminator (`isGroupAdmin`, derived
 * from `groupState.members[me].admin`) gated only member REMOVAL. So every member
 * saw "Add member", tapped through to NewChatScreen, and got an `Alert` when
 * `productionRuntime.addGroupMember` threw `NOT_ADMIN`.
 *
 * This is the UI half of the B-221 finding: adds are admin-only at every
 * authoritative layer (send gate throws NOT_ADMIN, receiver `applyAdminAction`
 * silently no-ops a non-admin add, server `POST /conversations/:id/members`
 * requires admin). There was never a hole — only an affordance that lied.
 *
 * B-221 itself (a request/approval mechanism) is ARCH-GATED and deliberately
 * NOT implemented: master-key distribution is a CLAUDE.md stop-condition, and a
 * non-admin add path would have to rekey + `reshareGroupKeyState` only at
 * approval time or the invitee gets the master key before approval. The last
 * case below pins that no such path was smuggled in.
 *
 * `ChatInfoScreen.tsx` imports React Native, so this is a source scan. The file
 * is CRLF and its own fix comment quotes the banned `isAdmin = isGroup` form —
 * comments are stripped before every assertion (CLAUDE.md static-scan rules).
 */

const INFO = join(process.cwd(), 'src', 'screens', 'messenger', 'ChatInfoScreen.tsx');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function source(): string {
  return stripComments(readFileSync(INFO, 'utf8'));
}

describe('B-222 — Add member is gated on real group-admin, not on "is a group"', () => {
  it('isGroupAdmin is derived from the crypto roster admin flag', () => {
    // The authority is the E2EE group state, not a server role or a UI guess.
    expect(source()).toMatch(/const isGroupAdmin\s*=[\s\S]{0,160}?\.admin/);
  });

  it('isAdmin resolves to isGroupAdmin', () => {
    expect(source()).toMatch(/const isAdmin\s*=\s*isGroupAdmin\s*;/);
  });

  it('isAdmin is NOT hardcoded to isGroup (the regression)', () => {
    // `\b` matters: `isGroupAdmin` also starts with `isGroup`, and a naive
    // pattern would flag the CORRECT assignment as the bug.
    expect(source()).not.toMatch(/const isAdmin\s*=\s*isGroup\s*;/);
  });

  it('B-221 stays arch-gated: no add-request / approval path was introduced', () => {
    // A non-admin "request to add" would distribute the master key ahead of
    // approval unless rekey + reshare are deferred to approval time. That design
    // needs architecture sign-off (CLAUDE.md stop-condition — group master key
    // distribution). If this assertion ever fails, the sign-off must exist.
    expect(source()).not.toMatch(/add-request|awaiting_approval|requestAddMember/);
  });
});
