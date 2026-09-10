/**
 * THE MANAGER ACCESS CONTRACT (founder-specified):
 *   "what module a manager can access, the owner decides. If the owner doesn't
 *    choose any then he will not have any module. And all the modules will have
 *    the same access as the owner."
 *
 * Two things had to be true for that, and neither was.
 *
 * 1. THE DISCRIMINATOR. Every client-side attempt to answer "is this account a
 *    delegated manager?" has been wrong, and each wrong answer was invisible
 *    because it was wrong in the safe direction (false → no filter).
 *      B-215 before: `account_kind === 'cpo' && is_org_manager`  — never true.
 *      B-215 after:  `account_kind === 'agency' && !!org`        — never true.
 *    Verified against production, both accounts of the reported org:
 *      owner  "Agent Due" → {account_kind:'agency', org: null}
 *      mgr    "CPO 1"     → {account_kind:'cpo',    org: 'Agent Due'}
 *    The second test is false for BOTH: a manager is a PROMOTED CPO, so
 *    `agents.managed_by_org_id` is set and ACCOUNT_KIND_SQL's deliberate cpo
 *    precedence pins account_kind='cpo'. Hence a server-computed `managed_org`,
 *    read straight off the org_members manager row. `is_org_manager` cannot
 *    serve — it is true for the owner too (that was B-210).
 *
 * 2. THE GRANT RULE. `permitted_modules` DEFAULTS to NULL, and one nullable
 *    column was carrying two questions — "is this a manager?" and "what were
 *    they granted?". Whichever way NULL was read, one of them broke:
 *      NULL→[]   (pre-f0d3a98) locked every unconfigured manager down;
 *      NULL kept (f0d3a98)     made "granted nothing" mean "granted everything".
 *    Splitting the questions settles it: `managed_org` answers the first, so
 *    NULL and [] can both mean the one thing the founder asked for — nothing.
 *
 * The old ALWAYS_VISIBLE_KEYS baseline (msg/intel/region) is GONE, so those
 * three are now grantable instead of hardcoded — see the invariant at the
 * bottom, which is what stops "not grantable" from ever becoming a dead end.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const R = process.cwd();
function code(rel: string[]): string {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of readFileSync(join(R, ...rel), 'utf8').split(/\r?\n/)) {
    const t = raw.trim();
    if (inBlock) { if (t.includes('*/')) {inBlock = false;} continue; }
    if (t.startsWith('/*') || t.startsWith('{/*')) { if (!t.includes('*/')) {inBlock = true;} continue; }
    if (t.startsWith('*') || t.startsWith('//')) {continue;}
    out.push(raw);
  }
  return out.join('\n');
}

const server  = code(['apps', 'auth-service', 'src', 'auth', 'account-kind.ts']);
const orgSvc  = code(['apps', 'auth-service', 'src', 'org', 'org-cpo.service.ts']);
const dash    = code(['src', 'screens', 'agent', 'AgentDashboardScreen.tsx']);
const permUi  = code(['src', 'screens', 'agent', 'ManagerPermissionsScreen.tsx']);

/** The client's rule, extracted so it can be asserted directly. */
function visibleFor(
  managedOrg: {id: string; name: string} | null,
  grants: string[] | null | undefined,
  rows: string[],
): string[] {
  const permitted = managedOrg ? new Set(grants ?? []) : null;
  return rows.filter(r => !permitted || permitted.has(r));
}

const ROWS = ['msg', 'intel', 'region', 'portal', 'roster', 'jobs', 'compliance'];
const ORG  = {id: 'org-1', name: 'Agent Due'};

describe('the owner decides, absolutely', () => {
  it('a manager the owner never configured (NULL) has NO modules', () => {
    // REVERSED from the previous revision of this file, which asserted NULL
    // meant unrestricted. That was my inference; the founder ruled the other
    // way — "if owner doesn't choose any then he will not have any module".
    expect(visibleFor(ORG, null, ROWS)).toEqual([]);
  });

  it('undefined grants are the same as none', () => {
    // A session cached before /auth/me carried the field.
    expect(visibleFor(ORG, undefined, ROWS)).toEqual([]);
  });

  it('an explicit empty array means granted nothing', () => {
    expect(visibleFor(ORG, [], ROWS)).toEqual([]);
  });

  it('a grant list shows EXACTLY those rows and nothing else', () => {
    // No baseline is added. Previously msg/intel/region rode along for free.
    expect(visibleFor(ORG, ['portal', 'roster'], ROWS)).toEqual(['portal', 'roster']);
  });

  it('the three ex-baseline modules are now grantable like any other', () => {
    expect(visibleFor(ORG, ['msg'], ROWS)).toEqual(['msg']);
  });

  it('a NON-manager is never filtered, whatever the grants field says', () => {
    // The owner, a plain CPO and an enterprise individual all have
    // managed_org === null and must see their full dashboard.
    expect(visibleFor(null, [], ROWS)).toEqual(ROWS);
    expect(visibleFor(null, null, ROWS)).toEqual(ROWS);
  });
});

describe('the server resolves both manager facts from ONE row', () => {
  it('managed_org — not permitted_modules — identifies a manager', () => {
    expect(server).toMatch(/export async function resolveManagerContext/);
    expect(server).toMatch(/managed_org: \{id: row\.org_id, name: row\.org_name \?\? ''\}/);
  });

  it('the owner can never read as their own delegated manager', () => {
    // Structural, not incidental: an owner has no org_members row at all, and
    // this guard keeps that true even if one is ever seeded.
    expect(server).toMatch(/om\.org_user_id <> \$1/);
  });

  it('it reads the MANAGER row, so a CPO-of-A/manager-of-B resolves to B', () => {
    // ACCOUNT_KIND_SQL collapses multi-org membership to the cpo row and would
    // report org A; this query is scoped to member_role='manager'.
    expect(server).toMatch(/om\.member_role = 'manager'/);
    expect(server).toMatch(/om\.status = 'active'/);
  });

  it('an unconfigured manager is reported as granted nothing', () => {
    expect(server).toMatch(/permitted_modules: row\.permitted_modules \?\? \[\]/);
  });

  it('a non-manager gets nulls, so the client skips filtering entirely', () => {
    expect(server).toMatch(/return \{managed_org: null, permitted_modules: null\}/);
  });

  it('/auth/me ships both fields', () => {
    const auth = code(['apps', 'auth-service', 'src', 'auth', 'auth.service.ts']);
    expect(auth).toMatch(/const \{managed_org, permitted_modules\} = await resolveManagerContext/);
    expect(auth).toMatch(/is_org_manager, managed_org, permitted_modules/);
  });
});

describe('the client wiring', () => {
  it('derives the manager flag from managed_org', () => {
    expect(dash).toMatch(/const managedOrg = user\?\.managed_org \?\? null;/);
    expect(dash).toMatch(/const isPromotedManager = !!managedOrg;/);
  });

  it('no superseded discriminator survives anywhere in the screen', () => {
    // Both wrong forms, so neither can be reintroduced by a merge.
    expect(dash).not.toMatch(/account_kind === 'cpo' && .*is_org_manager/);
    expect(dash).not.toMatch(/account_kind === 'agency' && !!user\?\.org/);
  });

  it('is declared ONCE and reused', () => {
    // It was hand-written in three places (org-data fetch, layout, filter) and
    // all three drifted to the same wrong test, so the manager failed every one
    // at once: no org data fetched, solo-CPO layout, no module filter.
    expect(dash.match(/const isPromotedManager =/g) ?? []).toHaveLength(1);
    expect(dash).toMatch(/const orgScoped = me\?\.agent\.type === 'company' \|\| isPromotedManager;/);
  });

  it('filters with no baseline bypass', () => {
    expect(dash).toMatch(/const canSee = \(key: string\) => !permittedModules \|\| permittedModules\.has\(key\);/);
    expect(dash).toMatch(/const visibleNavRows = navRows\.filter\(r => canSee\(r\.key\)\);/);
    expect(dash).not.toMatch(/ALWAYS_VISIBLE_KEYS/);
  });

  it('gates the NEXT ON OPS preview on the same grant as the Missions row', () => {
    // Else revoking Missions leaves the live board — client names and all — on
    // the manager's home screen.
    expect(dash).toMatch(/orgMissions && canSee\('jobs'\)/);
  });

  it('never offers Manager Permissions to a manager', () => {
    // Owner-only (D5) and enforced again server-side by setManagerPermissions;
    // a manager must not be able to widen their own grants.
    expect(dash).toMatch(/isOrg && !isPromotedManager \?/);
    expect(orgSvc).toMatch(/only_org_owner_can_change_permissions/);
  });
});

/**
 * THE TRANSPORT CHAIN. The first cut of this fix was correct on the server AND
 * correct on the screen, and changed nothing on the device: /auth/me's response
 * type didn't declare `managed_org`, the store never destructured it, and
 * `toUser` never mapped it — so `user.managed_org` was permanently undefined.
 * A field is only real if every link carries it.
 */
describe('managed_org survives the trip from /auth/me to the screen', () => {
  const api   = code(['src', 'services', 'api.ts']);
  const store = code(['src', 'store', 'authStore.ts']);

  it('the /auth/me response type declares it', () => {
    const from = api.indexOf("}>('/auth/me')");
    expect(from).toBeGreaterThan(-1);
    expect(api.slice(api.lastIndexOf('authHttp.get<{', from), from))
      .toMatch(/managed_org\?: \{id: string; name: string\} \| null;/);
  });

  it('every /auth/me call site destructures it', () => {
    const calls = store.match(/const \{user, account_kind[^}]*\} = await authApi\.me\(\);/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const c of calls) { expect(c).toContain('managed_org'); }
  });

  it('every toUser call that has it passes it', () => {
    const calls = store.match(/toUser\(user, \{account_kind[^}]*\}\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const c of calls) { expect(c).toContain('managed_org'); }
  });

  it('toUser maps it onto the User model', () => {
    expect(store).toMatch(/managed_org: kind\?\.managed_org \?\? null,/);
  });

  it('a profile edit preserves the routing fields instead of wiping them', () => {
    // PATCH /auth/me returns only the user row. Rebuilding from it alone reset
    // account_kind/org/managed_org/auto_dispatch to their defaults, so changing
    // a photo or a name silently demoted a manager to the solo-CPO dashboard.
    expect(store).toMatch(/function routingOf\(u: User \| null\)/);
    expect(store).toMatch(/managed_org: u\.managed_org/);
    const updates = store.match(/authApi\.updateProfile\([\s\S]{0,120}?toUser\(user[^)]*\)/g) ?? [];
    expect(updates).toHaveLength(2);
    for (const u of updates) { expect(u).toContain('routingOf(s.user)'); }
  });
});

describe('a manager reads as a MANAGER, on the org they manage', () => {
  it('the header says Manager Dashboard', () => {
    expect(dash).toMatch(/isPromotedManager \? 'Manager Dashboard' : 'Agent Dashboard'/);
  });

  it('the name line says (Manager), not (AGENT)', () => {
    expect(dash).toMatch(/\$\{isPromotedManager \? 'Manager' : 'AGENT'\}/);
  });

  it('the org they manage is named on the card', () => {
    expect(dash).toMatch(/MANAGER · \$\{managedOrg\.name\.toUpperCase\(\)\}/);
  });
});

/**
 * THE INVARIANT that keeps the "no baseline" rule honest.
 *
 * With the always-visible bypass gone, a dashboard row whose key is missing
 * from MANAGER_MODULES is permanently unreachable: the manager can't see it and
 * the owner has no switch to turn it on. That is precisely the state msg/intel/
 * region were in. This is the test that stops the next row from landing there.
 */
describe('every dashboard row is grantable', () => {
  function keysIn(src: string, start: string, end: string): string[] {
    const from = src.indexOf(start);
    expect(from).toBeGreaterThan(-1);
    const block = src.slice(from, src.indexOf(end, from));
    return [...new Set([...block.matchAll(/\bkey: '([A-Za-z]+)'/g)].map(m => m[1]))];
  }

  // Owner-exclusive by design — never granted, never filtered.
  const OWNER_ONLY = new Set(['managerPerms']);

  // `] as const` occurs earlier in the file too, so the end MUST be searched
  // from the start of the block — an unanchored indexOf silently yielded an
  // empty slice, and an empty whitelist makes these assertions vacuous.
  const mmFrom = orgSvc.indexOf('MANAGER_MODULES = [');
  const grantable = new Set(
    (orgSvc.slice(mmFrom, orgSvc.indexOf('] as const', mmFrom))
      .match(/'([A-Za-z]+)'/g) ?? []).map(s => s.replace(/'/g, '')),
  );

  it('the whitelist actually parsed — these assertions are not vacuous', () => {
    expect(mmFrom).toBeGreaterThan(-1);
    expect(grantable.size).toBeGreaterThanOrEqual(10);
  });

  it('the server whitelist covers every dashboard nav row', () => {
    const rows = keysIn(dash, 'const navRows:', '\n  ];');
    expect(rows.length).toBeGreaterThan(5);
    const ungrantable = rows.filter(k => !OWNER_ONLY.has(k) && !grantable.has(k));
    expect(ungrantable).toEqual([]);
  });

  it('the permissions screen offers every whitelisted module', () => {
    const offered = new Set(keysIn(permUi, 'const MODULES:', '\n];'));
    expect([...grantable].filter(k => !offered.has(k))).toEqual([]);
  });

  it('and offers nothing the server would reject', () => {
    // setManagerPermissions throws unknown_module on anything not whitelisted,
    // so an extra row here would 400 on tap.
    const offered = keysIn(permUi, 'const MODULES:', '\n];');
    expect(offered.filter(k => !grantable.has(k))).toEqual([]);
  });
});
