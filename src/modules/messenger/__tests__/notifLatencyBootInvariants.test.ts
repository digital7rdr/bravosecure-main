import {readFileSync} from 'node:fs';
import {join} from 'node:path';

/**
 * Static source-scan for the notification-latency boot fixes
 * (docs/audits/NOTIF_TAP_TO_MESSAGE_LATENCY_2026-08-01.md, items E1/F1) plus
 * the dead-retry ordering bug found while landing them.
 *
 * The founder-reported symptom: tap a message notification (or open the app
 * after one), watch "Connecting… → Reconnecting…" for 5–10 s before the
 * message renders. Two of the causes lived in `buildProductionRuntime`'s
 * serial boot:
 *
 *   1. `publishOwnBundle` — an AWAITED network POST ahead of SQLCipher
 *      hydration. Messages already on disk waited on auth-service.
 *   2. `await transport.connect()` — after the E2 fix, connect() can spend a
 *      token-refresh roundtrip (every cold boot after hours killed), so
 *      awaiting it puts that roundtrip ahead of setReady(true) too.
 *
 * And the ordering bug: the build assigned `livePublishOwnBundle` BEFORE
 * calling `disposeLiveRuntime()`, which nulls that very slot — so the
 * restore-screen republish (`publishOwnBundleAfterRestore`) and the P1-2
 * reconnect bundle-publish retry were silent no-ops for every runtime built.
 *
 * `productionRuntime.ts` is ~8k lines and no test can import it, so these are
 * source scans, same idiom as stashDrainGateParity.test.ts. The file is CRLF —
 * every assertion here is index-based on comment-stripped source, never
 * `\n`-anchored. If one fails, do NOT relax it: re-establish the ordering (or
 * the fire-and-forget shape) instead.
 */

const RUNTIME = join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts');
const FCM_BOOTSTRAP = join(process.cwd(), 'src', 'modules', 'messenger', 'push', 'fcmBootstrap.ts');
const CHAT_SCREEN = join(process.cwd(), 'src', 'screens', 'messenger', 'ChatScreen.tsx');
const USE_MESSENGER = join(process.cwd(), 'src', 'modules', 'messenger', 'hooks', 'useMessenger.ts');

/** Strip comments so a scan sees CODE, not the prose that explains it. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** buildProductionRuntime onward, CODE only. */
function buildBody(): string {
  const src = stripComments(readFileSync(RUNTIME, 'utf8'));
  const start = src.indexOf('export async function buildProductionRuntime(');
  expect(start).toBeGreaterThan(-1);
  return src.slice(start);
}

describe('notif-latency boot invariants (E1/F1)', () => {
  it('the boot bundle publish is fire-and-forget — never awaited by the build', () => {
    const body = buildBody();
    // The helper exists and is kicked without an await; nothing may reintroduce
    // a blocking wait on it (that was the awaited-network-before-hydration bug).
    expect(body).toContain('void runBootBundlePublish()');
    expect(body).not.toContain('await runBootBundlePublish');
  });

  it('the build never awaits transport.connect() (hydration must not wait on the network)', () => {
    const body = buildBody();
    expect(body).toContain('void transport.connect()');
    expect(body).not.toContain('await transport.connect()');
  });

  it('a msg-wake tap NAVIGATES before the guess-route pull wait (C1 — never hold navigation)', () => {
    // The B-324 guess re-route waits up to GUESS_ROUTE_PULL_WAIT_MS (6 s) for
    // the tap-time pull. That wait used to sit ABOVE the navigate call, so the
    // user stared at the launch screen while it ran. The tap handler must
    // route to the best-known target first and only then refine.
    const src = stripComments(readFileSync(FCM_BOOTSTRAP, 'utf8'));
    const region = src.slice(src.indexOf('const pullSettled = startTapTimePull();'));
    const firstNav = region.indexOf('navigateToMessengerScreen(');
    const guessWait = region.indexOf('await resolveTapTargetAfterPull(');
    expect(firstNav).toBeGreaterThan(-1);
    expect(guessWait).toBeGreaterThan(-1);
    expect(firstNav).toBeLessThan(guessWait);
  });

  it("B-356 — ChatScreen's markRead guard blocks only on an OBSERVED background transition, never on stale currentState", () => {
    // A VM that FCM started headless reports AppState.currentState =
    // 'background' even while the user is looking at the notification-opened
    // chat, and no 'change' event has fired yet — the old bare
    // `AppState.currentState !== 'active'` guard silently swallowed the read
    // receipts for exactly that entry (sender never saw the blue tick until
    // the user re-entered the chat).
    const src = stripComments(readFileSync(CHAT_SCREEN, 'utf8'));
    expect(src).toContain("observed !== null ? observed === 'active' : true");
    // The old stale-prone guard must not come back inside the markRead timer.
    const timer = src.indexOf('runtime.markRead(conversationId)');
    expect(timer).toBeGreaterThan(-1);
    const window = src.slice(Math.max(0, timer - 800), timer);
    expect(window).not.toContain("AppState.currentState !== 'active'");
  });

  it('B-356 — useMessenger re-resolves the runtime when ready flips (never a one-shot)', () => {
    const src = stripComments(readFileSync(USE_MESSENGER, 'utf8'));
    const effect = src.indexOf('getMessengerRuntime()');
    expect(effect).toBeGreaterThan(-1);
    const tail = src.slice(effect, effect + 900);
    // The resolving effect's dep array must carry `ready` — `[]` made a
    // rejected early resolution leave `runtime` null for the whole mount.
    expect(tail).toContain('}, [ready, runtime]);');
  });

  it('livePublishOwnBundle is assigned AFTER disposeLiveRuntime() nulls the slot', () => {
    // dispose runs inside the build (tear down the PRIOR runtime's handles) and
    // sets `livePublishOwnBundle = null`. The build's own assignment must come
    // after that call, or the restore republish + the P1-2 reconnect retry are
    // dead for the runtime's whole life — which is exactly what shipped.
    const body = buildBody();
    const disposeCall = body.indexOf('disposeLiveRuntime();');
    const assignment = body.indexOf('livePublishOwnBundle = async');
    expect(disposeCall).toBeGreaterThan(-1);
    expect(assignment).toBeGreaterThan(-1);
    expect(assignment).toBeGreaterThan(disposeCall);
  });
});
