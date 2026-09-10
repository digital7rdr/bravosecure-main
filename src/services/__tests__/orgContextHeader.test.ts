/**
 * Channels vs2 item 4 — the client stamps WHICH organisation a request is about.
 *
 * Stamped in the shared request interceptor rather than per-screen, because a
 * screen forgetting is invisible: the request succeeds, just against the wrong
 * company. There is no error to notice.
 *
 * The header cannot widen access — the server treats it as a request and
 * narrows the caller's real memberships by it (`org-context.ts`,
 * `multiOrgContext.spec.ts`). What these pin is the CLIENT half: sent when a
 * workspace is selected, absent when none is, and never rewritten underneath an
 * in-flight request.
 */
const mockOrgParam = jest.fn<{orgId: string} | undefined, []>();

jest.mock('@utils/constants', () => ({API_BASE_URL: 'https://example.invalid'}));
jest.mock('@op-engineering/op-sqlite', () => ({open: jest.fn()}));
jest.mock('@store/activeWorkspace', () => ({activeWorkspaceOrgParam: () => mockOrgParam()}));

import {readFileSync} from 'fs';
import {join} from 'path';

import {orgContextHeaderFor, ORG_SCOPED_PREFIXES} from '../api';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

beforeEach(() => { jest.clearAllMocks(); });

describe('the org-context header', () => {
  it('carries the selected workspace', () => {
    mockOrgParam.mockReturnValue({orgId: ORG_A});
    expect(orgContextHeaderFor(undefined, '/org/workspace/settings')).toBe(ORG_A);
  });

  it('is ABSENT when no workspace is selected', () => {
    // Absent is meaningful: it tells the server "use my default", which is what
    // every build before this one did. An empty string would be a value the
    // server then has to special-case.
    mockOrgParam.mockReturnValue(undefined);
    expect(orgContextHeaderFor(undefined, '/org/workspace/settings')).toBeNull();
  });

  it('does NOT overwrite a context already on the request', () => {
    /**
     * THE RETRY CASE. A 401 refresh replays the original config, and the store
     * may have moved to another workspace in between. Re-stamping would land
     * the replay against a different company than the one the user was looking
     * at when they tapped — silently, because the request still succeeds.
     */
    mockOrgParam.mockReturnValue({orgId: ORG_B});
    expect(orgContextHeaderFor(ORG_A, '/org/workspace/settings')).toBeNull();
  });

  it('treats an empty existing value as "not set"', () => {
    // An empty header is not a context; falling through to the active
    // workspace is better than sending nothing at all.
    mockOrgParam.mockReturnValue({orgId: ORG_A});
    expect(orgContextHeaderFor('', '/org/workspace/settings')).toBe(ORG_A);
  });
});

describe('which requests carry it', () => {
  /**
   * THE SCOPING RULE. The first version stamped every authed request from a
   * store that is only cleared at sign-out, so an agency owner who had once
   * opened a client workspace carried that org id into the AGENCY product —
   * manager routes rendered the wrong company's data, and dispatch (which
   * scopes against the provider on the booking, not the header) compared two
   * orgs and 403'd. The agency's core lane was dead until sign-out.
   */
  /**
   * EVERY URL BELOW WAS COPIED OUT OF api.ts, not invented.
   *
   * The first version of this block asserted `/incident/queue` — a path this
   * app has never sent (the route is `/incidents/...`). It passed, and it was
   * proving that a fictional URL is stamped while every real incident request
   * went unscoped. Same class as the repo's standing rule: a test cannot vouch
   * for a payload it made up.
   */
  it.each([
    '/org/workspace/settings',
    '/org/employees',
    '/org/cpos',
    '/org/invites/redeem',
    'department/channels',
    '/department/manage/channels',
    '/enterprise/invites/me',
    '/attendance/org/pending',
    '/attendance/roster/month',
    '/incidents/queue',
    '/incidents/abc-123/status',
  ])('stamps the workspace surface: %s', url => {
    mockOrgParam.mockReturnValue({orgId: ORG_A});
    expect(orgContextHeaderFor(undefined, url)).toBe(ORG_A);
  });

  /**
   * The AGENCY product shares the `/org` prefix, which is why this list is
   * enumerated rather than prefix-matched. A workspace id leaking onto
   * `/org/summary` renders another company's numbers on the agency dashboard;
   * onto `/org/bookings/:id/crew` it fails the booking's provider scope check
   * and kills the crewing lane.
   */
  it.each([
    '/dispatch/offers/abc/accept',
    // Agency-only. Their sole callers are ManagerPermissionsScreen and
    // OrgHierarchyScreen, both in AgentNavigator — a workspace id on either is
    // another company's roster read, and on the PATCH, a write.
    '/org/managers',
    '/org/hierarchy',
    '/org/summary',
    '/org/missions',
    '/org/missions/completed',
    '/org/earnings',
    '/bookings/123',
    '/agents/me',
    '/auth/me',
  ])('leaves the rest of the product alone: %s', url => {
    mockOrgParam.mockReturnValue({orgId: ORG_A});
    expect(orgContextHeaderFor(undefined, url)).toBeNull();
  });

  it('does not match a path that merely STARTS with a scoped word', () => {
    mockOrgParam.mockReturnValue({orgId: ORG_A});
    // Without the boundary the allowlist grows silently every time someone
    // names a route with a shared prefix.
    expect(orgContextHeaderFor(undefined, '/organisations/list')).toBeNull();
    expect(orgContextHeaderFor(undefined, '/incidents-export')).toBeNull();
    expect(orgContextHeaderFor(undefined, '/org/workspaces-archive')).toBeNull();
  });

  it('every allowlisted prefix is a path this app actually sends', () => {
    /**
     * The guard against the invented-URL class coming back. Each entry must
     * appear as a real request path in api.ts — if someone adds a prefix from
     * memory, or a route is renamed underneath one, this goes red.
     */
    const src = readFileSync(join(__dirname, '..', 'api.ts'), 'utf8');
    // Read from the EXPORTED list, not a hand-copied one. A second copy is the
    // repo's most common bug shape, and here it would drift silently: the copy
    // would keep passing while the real allowlist grew an unsent prefix.
    expect(ORG_SCOPED_PREFIXES.length).toBeGreaterThan(0);
    for (const p of ORG_SCOPED_PREFIXES) {
      expect({prefix: p, sent: src.includes(`'/${p}`)}).toEqual({prefix: p, sent: true});
    }
  });

  it('is absent when the url is unknown', () => {
    mockOrgParam.mockReturnValue({orgId: ORG_A});
    // An interceptor with no url cannot prove the request is in scope, and the
    // fail-safe direction is to send nothing.
    expect(orgContextHeaderFor(undefined, undefined)).toBeNull();
  });
});

/**
 * THE WIRING. Everything above tests the pure function; none of it notices if
 * the interceptor stops calling it. Deleting the two lines in api.ts that stamp
 * the header leaves every other test in this file green with the feature
 * silently dead — so this scans the source.
 *
 * Line-based and comment-skipping rather than one regex over the whole file:
 * the house comment-stripper has eaten real code in this repo (see
 * sourceScanSafety), and these files are CRLF, so a newline-anchored pattern
 * would match nothing and pass VACUOUSLY.
 */
describe('the interceptor is actually wired', () => {
  const codeLines = (): string[] => {
    const src = readFileSync(join(__dirname, '..', 'api.ts'), 'utf8');
    return src.split(/\r?\n/).filter(l => {
      const t = l.trim();
      return t.length > 0 && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    });
  };

  it('calls orgContextHeaderFor with the request url', () => {
    // With the url dropped the function cannot scope, and every request goes
    // back to carrying the header — the agency-product breakage above.
    expect(codeLines().filter(l => /orgContextHeaderFor\(/.test(l) && /config\.url/.test(l)))
      .not.toHaveLength(0);
  });

  it('assigns the result to the X-Org-Context header', () => {
    expect(codeLines().filter(l => /headers\['X-Org-Context'\]\s*=/.test(l)))
      .not.toHaveLength(0);
  });

  it('guards the assignment, so a null context sends no header at all', () => {
    // A literal `null` serialises as the STRING "null" on some adapters, which
    // the server's UUID check rejects — a 403 on a request that should simply
    // have used the caller's default org.
    const lines = codeLines();
    const at = lines.findIndex(l => /headers\['X-Org-Context'\]\s*=/.test(l));
    expect(at).toBeGreaterThan(0);
    expect(lines.slice(Math.max(0, at - 2), at + 1).join(' ')).toMatch(/if\s*\(\s*orgCtx/);
  });
});
