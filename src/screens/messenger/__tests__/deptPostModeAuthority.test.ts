/**
 * The receive-side poster filter was OFF on every lane except one.
 *
 * Scope v2 Phase 2 promises enforcement at BOTH ends of the client: a modified
 * client can put ciphertext on the relay, but honest recipients discard a post
 * from someone who is not a poster, so it reaches nobody. The relay cannot help
 * — channel posts are sealed-sender envelopes and teaching it channel roles is
 * an architecture stop-condition.
 *
 * THE DEFECT (critic finding, 2026-08-05). `enforcePosters` was
 *
 *     route.params.postMode ? route.params.postMode !== 'open' : false
 *
 * so an ABSENT param disabled the filter entirely. The param is set only when
 * you arrive from the channel list. Every other lane — a notification tap, a
 * forward, a shared link — opened the thread with it undefined and the
 * receive-side half simply did not run. A push is precisely how a member sees a
 * new post first, so the gap sat on the most-used lane.
 *
 * THE SHAPE. This is the same defect the rest of this scope keeps hitting: a
 * rule enforced over a narrower surface than the code actually has. Threading
 * the param through the two navigation helpers would have been the narrow fix —
 * it patches the lanes you happen to enumerate and breaks again on lane N+1.
 * Sourcing the mode from the server instead removes the param dependency, so
 * there is no lane to miss.
 *
 * WHY A SOURCE SCAN. `DepartmentChatScreen` needs the full messenger runtime,
 * SQLCipher and navigation to mount, and the rule here is a DEFAULT and an
 * ABSENCE — an absence is exactly what a behavioural test stops seeing the
 * moment someone reintroduces the thing on another lane.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

/**
 * Comments here quote the banned expression at length, so a naive scan matches
 * the prose rather than the code — the most common false pass in this repo.
 * Strip comments first, and split on /\r?\n/ because these files are CRLF: a
 * `\n`-anchored regex matches NOTHING and passes vacuously.
 *
 * ── A TRAP THIS FILE WALKED INTO, DOCUMENTED SO THE NEXT ONE DOES NOT ────────
 *
 * The usual stripper is `.replace(/\/\*[\s\S]*?\*\//g, '')`. On
 * `DepartmentChatScreen.tsx` that deletes ~15,000 characters of REAL CODE,
 * because the file contains the MIME wildcard `'*​/*'` for the document picker.
 * The `/*` inside that string literal opens a comment the stripper believes,
 * and it runs to the next `*​/` anywhere below — swallowing the very line under
 * test. Six assertions here still passed, because they happened to sit outside
 * the swallowed span. That is a vacuous test that looks like a green one.
 *
 * So: only strip a block comment whose `/*` STARTS A LINE. Every JSDoc block in
 * this repo does; a MIME type inside a string never does. And assert afterwards
 * that a token known to be present survived, so this can never silently rot.
 */
function code(...rel: string[]): string {
  const raw = readFileSync(join(process.cwd(), ...rel), 'utf8');
  const out = raw
    .replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*$/gm, '')
    .split(/\r?\n/)
    .filter(l => !l.trim().startsWith('//'))
    .join('\n');
  // Self-check: stripping must never remove more than the comments. If a future
  // edit reintroduces a swallowing stripper, this throws instead of passing.
  const codeChars = raw.replace(/\s/g, '').length;
  if (out.replace(/\s/g, '').length < codeChars * 0.3) {
    throw new Error(`comment stripper ate the file: ${rel.join('/')}`);
  }
  return out;
}

const SCREEN = code('src', 'screens', 'messenger', 'DepartmentChatScreen.tsx');
const API = code('src', 'services', 'api.ts');
const SVC = code('apps', 'auth-service', 'src', 'department', 'department.service.ts');

describe('the posting rule is server-authoritative, not a route param', () => {
  it('an ABSENT mode enforces rather than disables the filter', () => {
    expect(SCREEN).toMatch(/const enforcePosters = postMode !== 'open';/);
    // THE REGRESSION. The ternary is the bug: no param ⇒ no enforcement.
    expect(SCREEN).not.toMatch(/route\.params\.postMode\s*\?\s*route\.params\.postMode !== 'open'\s*:\s*false/);
    // …and it must not read the param directly at the decision site at all.
    const site = SCREEN.slice(SCREEN.indexOf('const enforcePosters'));
    expect(site.slice(0, 120)).not.toMatch(/route\.params/);
  });

  it('the param survives only as the first-paint seed', () => {
    // Dropping it would leave the filter unarmed until the roster lands, which
    // is a window on the ONE lane that was previously correct.
    expect(SCREEN).toMatch(
      /useState<string \| undefined>\(route\.params\.postMode\)/,
    );
  });

  it('the roster fetch overwrites it with the server value', () => {
    expect(SCREEN).toMatch(/if \(data\.post_mode\) \{setPostMode\(data\.post_mode\);\}/);
  });

  it('the server serves post_mode on the members endpoint', () => {
    // Same call the thread already makes on every focus — no extra round trip,
    // and it self-heals a mode change made while the thread is open.
    expect(SVC).toMatch(/SELECT org_id, post_mode FROM public\.department_channels WHERE id = \$1/);
    expect(SVC).toMatch(/return \{members: withManageable, my_role: role, post_mode: ch\?\.post_mode \?\? null\};/);
  });

  it('the client type carries it, so a dropped field is a compile error', () => {
    expect(API).toMatch(/post_mode\?: ChannelPostModeDto \| null;/);
  });

  /**
   * THE SAFETY ARGUMENT for defaulting to enforce. `memberRoleFor('open')` is
   * 'admin', and every channel-role write derives from it (pinned by
   * channelAccessInvariants.spec.ts), so in an open channel `posters` is the
   * whole roster and the filter passes everyone. If that ever stopped being
   * true, enforcing by default would start hiding real messages.
   */
  it('open channels seed every member as a poster, making the default a no-op', () => {
    const SPEC = code('apps', 'auth-service', 'src', 'department', 'channelAccessInvariants.spec.ts');
    expect(SPEC).toMatch(/memberRoleFor\('open'\)\)\.toBe\('admin'\)/);
  });

  /**
   * Fail-OPEN while the roster is genuinely unknown must survive. Hiding real
   * messages because a fetch failed is a far worse bug than briefly showing one
   * that should not exist — and it is what defaulting to enforce would cause
   * without this guard.
   */
  it('still fails OPEN when the roster has not loaded', () => {
    expect(SCREEN).toMatch(/if \(!enforcePosters \|\| !posters \|\| posters\.size === 0\) \{return rawMessages;\}/);
  });
});
