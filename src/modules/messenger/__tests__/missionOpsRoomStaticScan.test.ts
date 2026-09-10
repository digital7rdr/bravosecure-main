/**
 * sqa.md bug register — this suite pins: B-208.
 *
 * B-208 (Ops Room deletion invisible without an app restart) is the SYNC-ON-FOCUS case:
 * MessengerHomeScreen's listMine sync+prune effect was a plain useEffect keyed on
 * [hydrated, runtime], so it fired once per COLD START. The screen stays mounted in the tab
 * navigator, so tab-switching never re-triggered it and a room deleted while the app stayed
 * open never disappeared. The server-side hard delete had already succeeded, verified by
 * direct DB query.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

/**
 * Static source-scan regression for B-207 (mission Ops Room) — M2 + M3 + the
 * mount-only-sync follow-up found in device QA the same day.
 *
 * Neither `productionRuntime.ts` nor `MessengerHomeScreen.tsx` can be imported by
 * the node `messenger-crypto` jest project (both pull in react-native), so the two
 * rules below are unreachable by a normal unit test — exactly the class the B-124
 * data-loss bug shipped through. Pin them by reading the source, the same way
 * messageTopologyInvariants.test.ts pins `sendText`.
 *
 *   M2 — when the room OWNER receives a `key-request` from a user NOT in its crypto
 *        roster, it must re-drain the server-authorized intent queue
 *        (`drainDispatchRoomIntents`) so a manager/CPO whose add-intent never landed
 *        gets keyed. The roster gate in `reshareGroupKeyState` stays UNTOUCHED — the
 *        fix is a new trigger, not a bypass — so the reshare call must still be there.
 *
 *   M3 — the MessengerHomeScreen prune of server-deleted rooms must ALSO evict the
 *        local group state (`removeGroupState`), not just `removeConversation`, or a
 *        hard-deleted Ops Room's master key lingers on-device.
 *
 *   SYNC-ON-FOCUS — the listMine sync+prune effect must re-run on every FOCUS of
 *        MessengerHomeScreen (`useFocusEffect`), not just on mount (`useEffect`). The
 *        screen stays mounted in the tab navigator, so a mount-only effect never
 *        re-fires on tab-switch: a founder device confirmed the server-side hard
 *        delete had succeeded (verified via direct DB query — conversation row gone,
 *        comms_channel_id + lite_bookings.conversation_id both NULL) while the app
 *        still showed the room, because the device simply never re-asked the server.
 *
 * These files are CRLF; comments are stripped before every assertion (prose that
 * names the symbol is the classic false-positive here). Do NOT relax this test — if
 * it fails, re-read docs/handoffs/MISSION_OPS_ROOM_FIX_PLAN_2026-07-24.md.
 */

const RUNTIME = join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts');
const HOME    = join(process.cwd(), 'src', 'screens', 'messenger', 'MessengerHomeScreen.tsx');
const DRAIN   = join(process.cwd(), 'src', 'modules', 'messenger', 'orgWorkspace', 'dispatchRoomIntents.ts');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** The `sig.kind === 'reshare'` branch of the group-key signal handler, CODE only. */
function reshareBranch(): string {
  const src = readFileSync(RUNTIME, 'utf8');
  const start = src.indexOf("sig.kind === 'reshare'");
  const end = src.indexOf("sig.kind === 'request'", start + 1);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return stripComments(src.slice(start, end));
}

/** The server-reconciliation prune loop of MessengerHomeScreen, CODE only. */
function pruneLoop(): string {
  const src = readFileSync(HOME, 'utf8');
  const start = src.indexOf('for (const localId of localIds)');
  expect(start).toBeGreaterThan(-1);
  // B-703 MR-14 re-point. This was a 1100-CHARACTER window, and the MR-14 age
  // guard's explanation pushed `removeGroupState` past the end of it — the scan
  // went red while the rule it owns was untouched. A character budget is not a
  // scope: any comment added inside the loop silently shrinks what is covered,
  // and the fix each time is a bigger number that pins less. Anchor on the
  // STRUCTURE instead — the catch that closes the effect body after the loop.
  const end = src.indexOf('} catch {', start);
  expect(end).toBeGreaterThan(start);
  return stripComments(src.slice(start, end));
}

/** The listMine sync+prune effect's opening hook call, CODE only. */
function syncEffectOpener(): string {
  const src = readFileSync(HOME, 'utf8');
  const start = src.indexOf('Sync conversations from the server');
  expect(start).toBeGreaterThan(-1);
  const bodyStart = src.indexOf('if (!hydrated || !runtime)', start);
  expect(bodyStart).toBeGreaterThan(start);
  return stripComments(src.slice(start, bodyStart));
}

/** The isOpsRoomKeyAuthority return formula (B-416's identity gate), CODE only. */
function authorityFormulaLine(): string {
  const src = readFileSync(DRAIN, 'utf8');
  // Line-based (the files are CRLF); the formula is the single return inside
  // isOpsRoomKeyAuthority that mentions account_kind.
  const line = src.split(/\r?\n/).find(l => l.includes('return') && l.includes('account_kind'));
  expect(line).toBeDefined();
  return stripComments(line ?? '');
}

/** drainOnce's body, CODE only (claim pass + bootstrap pass + intent loop). */
function drainOnceBody(): string {
  const src = readFileSync(DRAIN, 'utf8');
  const start = src.indexOf('async function drainOnce');
  expect(start).toBeGreaterThan(-1);
  return stripComments(src.slice(start));
}

/** The MessengerHomeScreen focus-drain gate line, CODE only. */
function homeDrainGateLine(): string {
  const src = readFileSync(HOME, 'utf8');
  const line = src.split(/\r?\n/).find(l => l.includes('const isOpsRoomAuthority ='));
  expect(line).toBeDefined();
  return stripComments(line ?? '');
}

describe('B-207 — mission Ops Room invariants (static source scan)', () => {
  it('M2: an owner key-request from a NON-member re-drains the intent queue', () => {
    const branch = reshareBranch();
    expect(branch).toMatch(/!state\.members\[sig\.toUserId\]/);
    expect(branch).toMatch(/drainDispatchRoomIntents\(/);
  });

  it('M2: the reshare roster gate is NOT weakened (reshareGroupKeyState still called)', () => {
    // The fix adds a TRIGGER, never a bypass — the existing owner reshare (which
    // silently drops non-members via its own roster gate) must still run.
    expect(reshareBranch()).toMatch(/reshareGroupKeyState\(/);
  });

  it('M3: the prune evicts group state (removeGroupState), not only removeConversation', () => {
    const loop = pruneLoop();
    expect(loop).toMatch(/removeConversation\(/);
    expect(loop).toMatch(/removeGroupState\(/);
    // …and only when the pruned room actually holds group state.
    expect(loop).toMatch(/groups\[localId\]/);
  });

  it('SYNC-ON-FOCUS: the listMine sync+prune effect is wrapped in useFocusEffect, not a bare useEffect', () => {
    const opener = syncEffectOpener();
    expect(opener).toMatch(/useFocusEffect\(\s*useCallback\(/);
    // A bare `useEffect(` immediately opening this block is the exact regression —
    // it only ever fires once, so a server-side deletion never surfaces without a
    // full app restart. (useEffect calls ELSEWHERE in the file are fine; this
    // assertion only covers the slice from the "Sync conversations" comment to the
    // guard clause.)
    expect(opener).not.toMatch(/\buseEffect\(/);
  });

  it('B-210/B-416/B-417: the authority formula carries the legacy owner arm, the owns_agency fact AND managed_org — never `is_org_manager`', () => {
    const line = authorityFormulaLine();
    // Legacy owner arm: agency account with no org of its own — KEPT for
    // mixed versions (old server → owns_agency undefined → the un-joined
    // owner must keep working).
    expect(line).toMatch(/account_kind === 'agency'/);
    expect(line).toMatch(/!u\.org/);
    // B-417 owner arm: the server-computed direct fact. The legacy inference
    // rotted when Phase B let an owner join a workspace (org goes non-null);
    // removing this arm re-strands that persona.
    expect(line).toMatch(/owns_agency/);
    // Manager arm (B-416): managed_org is the discriminator — structurally
    // null for owners, present for delegated managers regardless of
    // account_kind (a promoted-CPO manager reads 'cpo').
    expect(line).toMatch(/managed_org/);
    // `is_org_manager` reads true for the owner AND a delegated manager
    // (resolveIsOrgManager's own documented contract) — keying the gate off
    // it silently blocked the real owner's drain on every trigger in
    // production (B-210). Do not reintroduce it here.
    expect(line).not.toMatch(/is_org_manager/);
  });

  it('B-416: MessengerHomeScreen gates its focus-drain through the SHARED predicate, not a re-derived local formula', () => {
    // Duplicate-copy class: the gate formula must live in ONE place
    // (isOpsRoomKeyAuthority) — a hand-rolled copy here is how N drifted
    // copies of one behaviour start.
    expect(homeDrainGateLine()).toMatch(/isOpsRoomKeyAuthority\(/);
  });

  it('B-416: drainOnce CLAIMS each room (claimRoomCrypto) BEFORE the bootstrap pass can mint (ensureAssignedGroup)', () => {
    const body = drainOnceBody();
    const claimAt = body.indexOf('claimRoomCrypto(');
    const mintAt = body.indexOf('.ensureAssignedGroup(');
    expect(claimAt).toBeGreaterThan(-1);
    expect(mintAt).toBeGreaterThan(-1);
    // The server-side atomic claim is what replaced the owner-only identity
    // gate as the B-35 single-mint fork barrier. Minting before (or without)
    // claiming re-opens the two-admins-race fork.
    expect(claimAt).toBeLessThan(mintAt);
  });

  it('B-416: the claim comparison stands down on a lost claim (claimed_by must be compared, not just called)', () => {
    // Guards the exact mutation that made the claim decorative: calling the
    // endpoint but adding every room to `mine` unconditionally.
    expect(drainOnceBody()).toMatch(/claimed_by === myUserId/);
  });

  it('B-416: dispatchRoomIntents.ts is the ONLY production call site that mints via runtime.ensureAssignedGroup', () => {
    // The single-authority claim only covers mints that go THROUGH the drain.
    // A second production call site would mint outside the claim and re-open
    // the fork. Definitions (`ensureAssignedGroup: async`, interface decls)
    // do not match the `.ensureAssignedGroup(` call shape.
    const offenders = sweep(/\.ensureAssignedGroup(\?\.)?\(/);
    expect(offenders).toEqual([DRAIN]);
  });

  it('B-416: makeAssignedGroup (the raw assigned-room MINT) is called only from the runtime implementations', () => {
    // Critic F-5 — `.ensureAssignedGroup(` is the runtime METHOD shape; the
    // underlying core mint `makeAssignedGroup` is exported from
    // @bravo/messenger-core, so a new caller could mint an Ops Room group
    // without going through the drain's claim at all. Pin its production
    // call sites to the runtime implementation (and the groupClient
    // definition/mirror modules, where it is declared/re-exported, which the
    // call-shape regex does not match anyway).
    const offenders = sweep(/(?<![.\w])makeAssignedGroup\(/);
    expect(offenders).toEqual([
      // The runtime's ensureAssignedGroup implementation — the one sanctioned mint.
      join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts'),
      // The core DEFINITION site (`export function makeAssignedGroup(`),
      // which the call-shape regex necessarily also matches.
      join(process.cwd(), 'packages', 'messenger-core', 'src', 'groups', 'groupClient.ts'),
    ]);
  });
});

/** Walk every production .ts/.tsx under the repo's THREE app roots (mobile,
 *  messenger-core, ops-console) and return files whose CODE matches. */
function sweep(callShape: RegExp): string[] {
  const {readdirSync, statSync} = require('node:fs') as typeof import('node:fs');
  const roots = [
    join(process.cwd(), 'src'),
    join(process.cwd(), 'packages', 'messenger-core', 'src'),
    join(process.cwd(), 'apps', 'ops-console', 'src'),
  ];
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name === '__tests__' || name === '__mocks__' || name === 'node_modules') {continue;}
        walk(p);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(name) || /\.test\./.test(name)) {continue;}
      const code = stripComments(readFileSync(p, 'utf8'));
      if (callShape.test(code)) {offenders.push(p);}
    }
  };
  roots.forEach(walk);
  return offenders;
}
