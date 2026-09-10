/**
 * Static source-scan regression for B-212 — the AgentLiveTracker message dock.
 *
 * Founder report: typing into "Message ops or crew…" and hitting send redirected
 * to the Chat screen with the text merely PREFILLED (never sent — a second manual
 * tap was required), and the dock's call buttons did nothing for a CPO (silently
 * hopped to the Comms tab instead of starting the call — this screen's local
 * navigator doesn't register GroupCallScreen for CPO mode, the same reason
 * `openChat` already hops tabs there for reading).
 *
 * This screen can't be imported by the node `booking` project (WebView, Mapbox,
 * navigation) so the fix is pinned by reading the source — same pattern as
 * assignCrewFilter.test.ts / assignCrewKeyDelivery.test.ts.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const SCREEN = join(process.cwd(), 'src', 'screens', 'agent', 'AgentLiveTrackerScreen.tsx');

function source(): string {
  return readFileSync(SCREEN, 'utf8').replace(/\r\n/g, '\n');
}
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
/** The body of sendDraft(), CODE only. */
function sendDraftBody(): string {
  const src = stripComments(source());
  const start = src.indexOf('const sendDraft = () => {');
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('\n  };', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}
/** The body of onCall(), CODE only. */
function onCallBody(): string {
  const src = stripComments(source());
  const start = src.indexOf("const onCall = useCallback((callType: 'voice' | 'video') => {");
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('}, [commsChannelId]);', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('B-212 — live-tracker message dock sends + calls directly (static source scan)', () => {
  it('sendDraft() calls runtime.sendText directly — does NOT hand off to openChat', () => {
    const body = sendDraftBody();
    expect(body).toMatch(/runtime\.sendText\(/);
    expect(body).not.toMatch(/openChat\(/);
  });

  it('sendDraft() passes isGroup: true (the mission Ops Room is always a group)', () => {
    expect(sendDraftBody()).toMatch(/isGroup:\s*true/);
  });

  it('onCall() has no CPO-mode early-return that skips launchCall', () => {
    const body = onCallBody();
    // The old bug: `if (mode === 'cpo') { navX.navigate('CpoTabs', ...); return; }`
    // before launchCall ever ran, for every CPO tap of the call buttons.
    expect(body).not.toMatch(/mode === 'cpo'/);
    expect(body).toMatch(/launchCall\(/);
  });

  it('onCall() routes through the shell resolver on the app-root ref, not the screen-local nav', () => {
    // B-212's root-ref claim was TYPE-level and false at runtime for CPO
    // (CpoRootStack registers neither call screen), so B-414 moved the shim
    // onto the shell-aware resolver: agency keeps its flat root action, CPO
    // gains the CpoTabs→CpoComms nesting it actually needs. This pin is
    // STRONGER than the old raw-ref literal — a revert to either the local
    // nav or the bare root navigate goes red here.
    expect(onCallBody()).toMatch(/navigateToMessengerScreen\(navigationRef as never/);
    expect(onCallBody()).not.toMatch(/navigationRef\.navigate as unknown/);
  });
});

// ───────── B-658 — the CPO must reach the mission THREAD, and the dock must
// ───────── tell the truth about who is in it.

describe('B-658 — the mission comms dock', () => {
  /** The body of openChat(), CODE only. */
  function openChatBody(): string {
    const src = stripComments(source());
    const start = src.indexOf('const openChat = useCallback(');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('}, [mode,', start);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
  }

  it('openChat lands a CPO on the THREAD, not the chat list', () => {
    /**
     * The regression: the CPO branch was
     *   `navX.navigate('CpoTabs', {screen: 'CpoComms'}); return;`
     * — the conversation LIST, returning before the thread navigate. On the
     * agency dispatch lane the client IS already a member of this room, so
     * nothing blocked the message except that the one-tap route never arrived.
     * "The agent can't message the client" was literally true, as navigation.
     *
     * The premise was sound (Chat is not on the CpoRootStack hosting this
     * tracker, so a bare navigate no-ops) — the remedy was too blunt. Use the
     * same shell-aware resolver `onCall` already uses.
     */
    const body = openChatBody();
    expect(body).toMatch(/navigateToMessengerScreen\(navigationRef as never, 'Chat'/);
    expect(body).toMatch(/conversationId: commsChannelId/);
    // The dead-end, verbatim. A revert goes red here.
    expect(body).not.toMatch(/navX\.navigate\('CpoTabs', \{screen: 'CpoComms'\}\);\s*return;/);
  });

  it('the composer names the mission GROUP, not "ops or crew"', () => {
    /**
     * "Message ops or crew…" was wrong three ways: it implied a recipient
     * CHOICE the dock does not offer (one composer, one destination — the whole
     * room); it omitted the CLIENT, who IS a member on the agency dispatch lane
     * — telling a CPO the principal was absent while they read every word; and
     * it clipped.
     *
     * "Mission group" is the only phrasing true on BOTH live provisioning
     * lanes (agency: client+agency+managers+crew; ops-console: ops admin+crew),
     * because it names the container rather than the roster.
     */
    const src = stripComments(source());
    expect(src).toMatch(/placeholder="Message mission group…"/);
    expect(src).not.toMatch(/Message ops or crew/);
  });

  it('a send into a not-ready room tells the user instead of vanishing', () => {
    // It used to `return` silently, so a typed message disappeared with no
    // feedback and no send — indistinguishable from being ignored.
    const body = sendDraftBody();
    expect(body).toMatch(/if \(!commsChannelId \|\| !runtime\) \{/);
    expect(body).toMatch(/Alert\.alert\(/);
    // The draft must NOT be cleared on that branch, or the message is still lost.
    const notReady = body.slice(body.indexOf('if (!commsChannelId || !runtime)'));
    expect(notReady.slice(0, notReady.indexOf('}'))).not.toMatch(/setDraft\(''\)/);
  });
});
