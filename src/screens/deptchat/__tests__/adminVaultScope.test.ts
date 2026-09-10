/**
 * F14 — DOCUMENTS: "the admin Vault is not admin-scoped."
 *
 * PDF A10 says an admin should see the ORGANISATION's evidence. Today an admin
 * sees exactly the member shelf, and this test pins that — with the reasons,
 * because two of them are architecture stop-conditions and the third is a server
 * change, so none of it could be fixed from the client screens.
 *
 * ── WHY THE SHELF IS MEMBER-SCOPED ─────────────────────────────────────────
 *
 * 1. THE LIST. `useCompanyShelf` -> `useCompanyChannels` calls
 *    `departmentApi.listChannels()`, whose SQL is
 *    `FROM department_channel_members m ... WHERE m.user_id = $1`
 *    (`apps/auth-service/src/department/department.service.ts`). It is a
 *    membership projection with no admin arm. `listCompanyFiles` then iterates
 *    THAT list — deliberately, so a channel the caller is not in has no path
 *    into the output at all.
 *
 * 2. THE KEYS. Even given a wider list, an admin could not OPEN the files. A
 *    channel attachment's per-file AES key travels inside the sealed group
 *    envelope, so only members of that channel's Signal group hold it. Handing
 *    an admin another channel's files means either distributing group keys to
 *    non-members or presigning another user's object — both named in CLAUDE.md's
 *    stop conditions, and the second re-opens the L15 IDOR that the
 *    `vault/<callerUserId>/` prefix check exists to close.
 *
 * 3. THE WINDOW. The shelf is a VIEW over the local message store, which
 *    hydrates ~200 messages per conversation, so even a member's own older
 *    evidence is missing. An organisation-wide archive cannot be a view over
 *    device-local messages at all.
 *
 * ── WHAT AN ACTUAL FIX NEEDS (none of it client-side) ──────────────────────
 *   a. a server endpoint listing org-wide channel/incident attachments for an
 *      org manager — `listOrgChannels` (GET /department/manage/channels) is the
 *      existing org-scoped precedent and already exists, so the LIST half is
 *      tractable;
 *   b. an owner/architecture decision on how an admin obtains decryption keys
 *      for a channel they are not in. The incident module already ships the only
 *      pattern that does not weaken the relay: `incidentApi.evidenceRecipients`
 *      + `storeAttachmentKeys` seal the per-file key to each authorised
 *      recipient's device (outer-ECIES), so "admins are recipients" could be
 *      expressed there without giving the server plaintext or group keys;
 *   c. a durable index (SQLCipher query over `media_object_key`) so the answer
 *      is not bounded by the hydration window.
 *
 * WHAT DID CHANGE: `VaultScreen`'s Company empty state now STATES the scope,
 * instead of leaving "Company Vault" to imply an org-wide archive.
 *
 * WHEN (a)-(c) LAND: flip the DOCUMENTS assertions below deliberately. Do not
 * delete them to make a run green.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

function code(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .split('\n')
    .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('--'))
    .join('\n');
}

const SHELF = code('src', 'modules', 'messenger', 'vault', 'useCompanyShelf.ts');
const BUILDER = code('src', 'modules', 'messenger', 'vault', 'companyShelf.ts');
const VAULT = code('src', 'screens', 'messenger', 'VaultScreen.tsx');
const DEPT_SVC = code('apps', 'auth-service', 'src', 'department', 'department.service.ts');

describe('F14 — the company shelf is membership-scoped, admin or not', () => {
  it('the scan is reading the real modules (guards against an empty read)', () => {
    expect(SHELF).toContain('useCompanyShelf');
    expect(BUILDER).toContain('listCompanyFiles');
    expect(VAULT).toContain('Company Vault');
  });

  /** DOCUMENTS F14 — the list has no admin arm. */
  it('DOCUMENTS F14: the shelf sources ONLY the membership-scoped channel list', () => {
    expect(SHELF).toMatch(/departmentApi\.listChannels\(\)/);
    // The org-scoped endpoint exists and is deliberately NOT used here yet.
    expect(SHELF).not.toMatch(/listManagedChannels|listOrgChannels/);
    // …and no role check widens it.
    expect(SHELF).not.toMatch(/is_org_manager|my_role|isAdmin/);
  });

  /** DOCUMENTS F14 — and the server endpoint it calls cannot widen either. */
  it('DOCUMENTS F14: listChannels is a membership projection server-side', () => {
    const fn = DEPT_SVC.slice(
      DEPT_SVC.indexOf('async listChannels('),
      DEPT_SVC.indexOf('async listMembers('),
    );
    expect(fn.length).toBeGreaterThan(200);
    expect(fn).toMatch(/FROM public\.department_channel_members m/);
    expect(fn).toMatch(/WHERE m\.user_id = \$1/);
  });

  it('the builder iterates the membership list rather than scanning messages', () => {
    // This is the structural guarantee that keeps the scope honest, and it is
    // ALSO why widening is a server change: the input decides the output.
    expect(BUILDER).toMatch(/for \(const ch of input\.channels \?\? \[\]\)/);
  });

  it('the Company empty state now states its real scope', () => {
    // The partial improvement that WAS shippable from the client: stop letting
    // a header reading "Company Vault" imply an organisation-wide archive.
    expect(VAULT).toMatch(/follows your own channel membership/);
    expect(VAULT).toMatch(/not an organisation-wide archive/);
  });
});
