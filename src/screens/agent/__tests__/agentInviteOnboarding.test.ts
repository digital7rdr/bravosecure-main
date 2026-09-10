/**
 * Static source-scan regression for Issue 34 (Testing Issues V2, PDF p.39) —
 * "Agent Onboarding Route Is Missing from Role Selection".
 *
 * ASSUMPTION ON THE RECORD (fix plan §10 Q1). AgentTypeSelectScreen carried an
 * explicit decision: officers "never self-register". The PDF asks for an Agent
 * route gated on a provider INVITATION CODE. Those reconcile — the provider is
 * still the only party that can mint a code, so it still decides who joins;
 * only the typing moves to the officer. The assertions below pin exactly that,
 * so the property survives someone later "simplifying" the flow.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = process.cwd();

function code(rel: string): string {
  const src = readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  const out: string[] = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (inBlock) { if (t.includes('*/')) {inBlock = false;} continue; }
    if (t.startsWith('/*') || t.startsWith('{/*')) { if (!t.includes('*/')) {inBlock = true;} continue; }
    if (t.startsWith('*') || t.startsWith('//')) {continue;}
    out.push(line.replace(/([^:'"`])\/\/.*$/, '$1'));
  }
  return out.join('\n');
}

const SELECT = 'src/screens/agent/AgentTypeSelectScreen.tsx';
const SCREEN = 'src/screens/agent/AgentInviteCodeScreen.tsx';
const SERVICE = 'apps/auth-service/src/org/org-cpo.service.ts';

describe('Issue 34 — the Agent route exists', () => {
  it('role selection offers an Agent option alongside the provider one', () => {
    const src = code(SELECT);
    expect(src).toMatch(/id: 'agent'/);
    expect(src).toMatch(/title: 'Agent'/);
    expect(src).toMatch(/next: 'AgentInviteCode'/);
    // The provider track is untouched.
    expect(src).toMatch(/id: 'agency'/);
  });

  it('the agent track goes to the code screen, NOT straight to POST /agents', () => {
    const src = code(SELECT);
    expect(src).toMatch(/if \(selected === 'agent'\) \{[\s\S]{0,120}navigate\('AgentInviteCode'\)/);
  });

  it('the screen is registered and typed', () => {
    expect(code('src/navigation/AgentNavigator.tsx')).toMatch(/name="AgentInviteCode"/);
    expect(code('src/navigation/types.ts')).toMatch(/AgentInviteCode: undefined;/);
  });

  it('the input accepts only identifier characters', () => {
    expect(code(SCREEN)).toMatch(/replace\(\/\[\^A-Z0-9-\]\/g, ''\)/);
  });

  it('the screen uses the app-wide keyboard rule', () => {
    const src = code(SCREEN);
    expect(src).toMatch(/useKeyboardLayout/);
    expect(src).not.toMatch(/KeyboardAvoidingView|keyboardVerticalOffset|kbHeight/);
  });
});

describe('Issue 34 — a code is the ONLY way onto a roster', () => {
  it('redemption resolves the org from the CODE, never from the request', () => {
    const src = code(SERVICE);
    const start = src.indexOf('async redeemInviteCode');
    expect(start).toBeGreaterThan(-1);
    const fn = src.slice(start, src.indexOf('\n  private async seedManagedAgent', start));
    // The caller supplies a code and nothing else — it cannot pick a roster.
    expect(fn).toMatch(/redeemInviteCode\(\s*\n?\s*userId: string, rawCode: string,/);
    expect(fn).toMatch(/RETURNING id, org_user_id, member_role, call_sign/);
  });

  it('the claim is SINGLE USE and race-safe', () => {
    const src = code(SERVICE);
    const fn = src.slice(src.indexOf('async redeemInviteCode'));
    // A conditional UPDATE, not a SELECT-then-UPDATE: two people racing one code
    // cannot both win.
    expect(fn).toMatch(/UPDATE provider_invite_codes[\s\S]{0,200}redeemed_at IS NULL AND revoked_at IS NULL/);
    expect(fn).toMatch(/expires_at IS NULL OR expires_at > NOW\(\)/);
  });

  it('unknown / expired / revoked / used all give ONE answer', () => {
    // Distinguishing them would let an officer probe which codes exist.
    const fn = code(SERVICE).slice(code(SERVICE).indexOf('async redeemInviteCode'));
    expect((fn.match(/invite_code_invalid/g) ?? []).length).toBe(1);
  });

  it('someone already on a roster cannot join a second one', () => {
    const fn = code(SERVICE).slice(code(SERVICE).indexOf('async redeemInviteCode'));
    expect(fn).toMatch(/already_on_a_roster/);
  });

  it('the route sits OUTSIDE OrgManagerGuard — the joiner is not yet a member', () => {
    const ctrl = code('apps/auth-service/src/org/org-invite.controller.ts');
    expect(ctrl).toMatch(/@UseGuards\(JwtAuthGuard\)/);
    expect(ctrl).not.toMatch(/OrgManagerGuard/);
    expect(code('apps/auth-service/src/org/org.module.ts')).toMatch(/OrgInviteController/);
  });
});

describe('Issue 34 — seeding is SHARED, not duplicated', () => {
  it('createCpo and redeem both call seedManagedAgent', () => {
    const src = code(SERVICE);
    expect((src.match(/this\.seedManagedAgent\(/g) ?? []).length).toBe(2);
  });

  it('the shared seed still inherits org coverage', () => {
    // mirrorAgentToPool REFUSES an agent with no coverage country, so dropping
    // this makes an invited officer permanently invisible to dispatch, silently.
    const src = code(SERVICE);
    const start = src.indexOf('private async seedManagedAgent');
    const fn = src.slice(start, src.indexOf('\n  private async runCreateManagedCpoTxn', start));
    expect(fn).toMatch(/INSERT INTO agent_profiles \(user_id, coverage\)/);
    // And every other thing an officer needs to exist.
    for (const t of ['INSERT INTO agents', 'agent_kyc_checks', 'agent_documents',
                     'agent_review_pipeline', 'agent_deployment_checks',
                     'INSERT INTO org_members', 'agent_audit']) {
      expect(fn).toContain(t);
    }
  });
});
