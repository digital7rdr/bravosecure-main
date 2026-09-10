import {readFileSync} from 'node:fs';
import {join} from 'node:path';

/**
 * B-354 — static source-scans for the presence-background contract.
 *
 * Founder repro: message a killed app → seconds later the sender sees the
 * recipient "Active now". Mechanism: the msg-wake headless drain boots the
 * FULL runtime; since the B-352 fresh-token handshake its socket connects
 * reliably, the gateway asserted 'online' on connect, and the client's
 * connected-replay announced lastActivity — which was initialised to a
 * hard-coded 'active'. Three rules keep the class dead:
 *
 *   1. `lastActivity` must be derived (backgroundBoot → 'away'; otherwise
 *      real AppState), never a bare 'active' literal.
 *   2. The headless config lane (configureRuntimeFromPersisted) must mark
 *      the runtime `backgroundBoot: true`, and the runtime must hand that
 *      to the transport as `background`.
 *   3. The gateway must (a) not assert 'online' for bg sockets and
 *      (b) ignore `presence` frames from them.
 *
 * The gateway has no handleConnection-level unit harness and none of these
 * files can be imported by the node jest project, so these are source scans
 * (same idiom as stashDrainGateParity). Files are CRLF — index-based
 * comment-stripped scans only, never `\n` anchors.
 */

const RUNTIME  = join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts');
const DRAIN    = join(process.cwd(), 'src', 'modules', 'messenger', 'push', 'headlessDrain.ts');
const GATEWAY  = join(process.cwd(), 'apps', 'messenger-service', 'src', 'gateway', 'messenger.gateway.ts');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('presence background contract (B-354)', () => {
  it('lastActivity is derived from backgroundBoot + AppState, never a bare active literal', () => {
    const src = stripComments(readFileSync(RUNTIME, 'utf8'));
    expect(src).toContain("let lastActivity: 'active' | 'away' = config.backgroundBoot ? 'away' : 'active';");
    // The interactive branch checks the REAL AppState at boot (a VM started
    // headless reports 'background' even before any transition event).
    const init = src.indexOf('let lastActivity:');
    const window = src.slice(init, init + 600);
    expect(window).toContain("currentState !== 'active'");
  });

  it('the runtime hands backgroundBoot to the transport as `background`', () => {
    const src = stripComments(readFileSync(RUNTIME, 'utf8'));
    expect(src).toContain('background:     config.backgroundBoot === true');
  });

  it('the headless config lane marks the runtime backgroundBoot: true', () => {
    const src = stripComments(readFileSync(DRAIN, 'utf8'));
    const call = src.indexOf('rt.configureMessengerRuntime({');
    expect(call).toBeGreaterThan(-1);
    const body = src.slice(call, src.indexOf('})', call));
    expect(body).toContain('backgroundBoot:   true');
  });

  it("the gateway's 'online' assert on connect is guarded on !ctx.presenceBg", () => {
    const src = stripComments(readFileSync(GATEWAY, 'utf8'));
    const setOnline = src.indexOf("await this.presence.set(claims.sub, 'online');");
    expect(setOnline).toBeGreaterThan(-1);
    // The guard must sit immediately around it.
    const before = src.slice(Math.max(0, setOnline - 300), setOnline);
    expect(before).toContain('if (!ctx.presenceBg) {');
    // And there is exactly ONE unconditional-looking set('online') — a second
    // unguarded copy would reintroduce the class.
    expect(src.indexOf("await this.presence.set(claims.sub, 'online');", setOnline + 1)).toBe(-1);
  });

  it('the gateway ignores presence frames from background sockets', () => {
    const src = stripComments(readFileSync(GATEWAY, 'utf8'));
    const handler = src.indexOf("this.rateGate(client, 'presence')");
    expect(handler).toBeGreaterThan(-1);
    const setCall = src.indexOf('await this.presence.set(ctx.claims.sub, next);', handler);
    expect(setCall).toBeGreaterThan(handler);
    const between = src.slice(handler, setCall);
    expect(between).toContain('if (ctx.presenceBg) return undefined;');
  });
});
