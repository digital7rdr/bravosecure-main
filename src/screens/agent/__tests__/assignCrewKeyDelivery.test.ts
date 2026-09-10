/**
 * Static source-scan regression for B-209 — instant key delivery on assign-crew.
 *
 * assignCrew (org-mission.service.ts) enqueues one dispatch_room_intents row per
 * client/crew/manager, but nothing DRAINS them except a later, separate visit to
 * AgentDashboard or Messenger (B-207 M1). The agency device that performs the
 * assign is the SAME device that must eventually drain — and it is already warm,
 * right here, at the moment the intents are created. Founder-reported: crews
 * assigned and left keyless (composer stuck "Syncing this group's encryption
 * key…") because nobody separately re-opened Messenger/Dashboard afterward, even
 * though this screen's own success copy claims the guards are "joining the Ops
 * Room" immediately.
 *
 * This screen can't be imported by the node `booking` project (navigation,
 * gradients, api layer), so the fix is pinned by reading the source — same
 * pattern as assignCrewFilter.test.ts.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const SCREEN = join(process.cwd(), 'src', 'screens', 'agent', 'OrgMissionsScreen.tsx');

function source(): string {
  return readFileSync(SCREEN, 'utf8').replace(/\r\n/g, '\n');
}
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
/** The body of confirm(), CODE only. */
function confirmBody(): string {
  const src = stripComments(source());
  const start = src.indexOf('const confirm = async () => {');
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('\n  };', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('B-209 — assign-crew triggers an immediate key-delivery drain (static source scan)', () => {
  it('imports drainDispatchRoomIntents', () => {
    expect(source()).toMatch(/import\s*\{\s*drainDispatchRoomIntents\s*\}\s*from\s*['"]@\/modules\/messenger\/orgWorkspace\/dispatchRoomIntents['"]/);
  });

  it('confirm() calls the drain AFTER assignCrew succeeds (same device, same session)', () => {
    const body = confirmBody();
    const assignAt = body.indexOf('orgApi.assignCrew(');
    const drainAt = body.indexOf('drainDispatchRoomIntents(');
    expect(assignAt).toBeGreaterThan(-1);
    expect(drainAt).toBeGreaterThan(assignAt);
  });

  it('the drain is fire-and-forget (does not block or fail the assign flow)', () => {
    // A drain failure must never surface as an "assign failed" error to the
    // agency — the intents stay pending and the existing fallback triggers
    // (dashboard mount, Messenger focus, key-request re-drain) retry it.
    expect(confirmBody()).toMatch(/void drainDispatchRoomIntents\(\)\.catch\(/);
  });
});
