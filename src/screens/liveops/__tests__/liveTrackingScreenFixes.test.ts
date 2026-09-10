/**
 * B-213 — three client-side LiveTrackingScreen bugs from the same founder
 * report:
 *
 *   1. The CHAT tab only printed "open it from the Messenger tab and look
 *      for Mission BS-XXXX" instead of actually opening the chat.
 *   2. The map had no way to see it full-screen.
 *   3. The "This isn't my guard" verify-guard card rode inside the
 *      ScrollView as the first item, so on scroll it sat flush against
 *      the fixed header with no consistent gap ("the button is up top,
 *      it should align below the menu bar").
 *
 * This screen can't be imported by the node `booking` project (WebView/
 * Mapbox/navigation), so the fix is pinned by reading the source — same
 * pattern as assignCrewFilter.test.ts / liveTrackerDockSend.test.ts.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const SCREEN = join(process.cwd(), 'src', 'screens', 'liveops', 'LiveTrackingScreen.tsx');

function source(): string {
  return readFileSync(SCREEN, 'utf8').replace(/\r\n/g, '\n');
}
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
/** The CHAT tab's content block, CODE only. */
function chatTabBody(): string {
  const src = stripComments(source());
  const start = src.indexOf("tab === 'chat' && (");
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('</ScrollView>', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('B-213 — LiveTrackingScreen CHAT tab opens the real chat (static source scan)', () => {
  it('navigates to MessengerTab > Chat instead of only printing instructions', () => {
    const body = chatTabBody();
    expect(body).toMatch(/navigation\.navigate\(\s*'MessengerTab'/);
    expect(body).toMatch(/screen:\s*'Chat'/);
  });

  it("passes initial:false (B-85 — load-bearing so back-from-Chat doesn't fall out of the tab)", () => {
    expect(chatTabBody()).toMatch(/initial:\s*false/);
  });

  it('passes the real conversationId, not a placeholder', () => {
    expect(chatTabBody()).toMatch(/conversationId:\s*convId/);
  });

  it('the composite Nav type can reach MessengerTab (CompositeNavigationProp + BottomTabNavigationProp)', () => {
    const src = stripComments(source());
    expect(src).toMatch(/CompositeNavigationProp</);
    expect(src).toMatch(/BottomTabNavigationProp<MainTabParamList>/);
  });
});

describe('B-213 — LiveTrackingScreen map can go full screen (static source scan)', () => {
  it('has an expand control that sets mapExpanded', () => {
    // B-214 — expand/collapse route through toggleMapExpanded (adds
    // map.retry() so the fullscreen WebView's live-data push actually
    // fires); see liveTrackingMapFixes.test.ts for that contract.
    const src = stripComments(source());
    expect(src).toMatch(/toggleMapExpanded\(true\)/);
  });

  it('has a fullscreen Modal gated on mapExpanded with a collapse control', () => {
    const src = stripComments(source());
    expect(src).toMatch(/<Modal visible=\{mapExpanded\}/);
    expect(src).toMatch(/toggleMapExpanded\(false\)/);
  });

  it('the fullscreen Modal and the collapsed box share one mapContent definition (never two live WebViews)', () => {
    const src = stripComments(source());
    const mapContentDefs = src.match(/const mapContent = /g) ?? [];
    expect(mapContentDefs.length).toBe(1);
    // Both consumers reference the shared constant, not a re-declared WebView.
    expect(src).toMatch(/\{mapContent\}[\s\S]*<\/Modal>|<Modal[\s\S]*\{mapContent\}/);
  });
});

describe("B-213 — LiveTrackingScreen 'This isn't my guard' card is pinned below the header (static source scan)", () => {
  it('VerifyGuardCard renders BEFORE the ScrollView opens, not as its first scrollable item', () => {
    const src = stripComments(source());
    const verifyIdx = src.indexOf('<VerifyGuardCard');
    const scrollIdx = src.indexOf('<ScrollView');
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(scrollIdx).toBeGreaterThan(-1);
    expect(verifyIdx).toBeLessThan(scrollIdx);
  });

  it('VerifyGuardCard is wrapped in a pinned container, not left bare against the header', () => {
    const src = stripComments(source());
    expect(src).toMatch(/verifyCardPinned/);
  });
});
