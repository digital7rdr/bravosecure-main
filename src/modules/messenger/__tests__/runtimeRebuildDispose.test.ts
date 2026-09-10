/**
 * AUDIT-2026-08-13 #11 — runtime rebuild must not leak the previous
 * SQLCipher handle or the previous socket.
 *
 * Before this landed, a rebuild (user switch via MainNavigator/signOut,
 * restore flow via _resetMessengerRuntimeKeepConfig) dropped the store
 * reference and NOTHING called `db.close()` — one leaked native SQLCipher
 * connection per rebuild (and per failed-build retry, the P1-2 offline
 * lane) — and only the signOut path closed the socket, so a
 * restore/user-switch rebuild left the old TransportClient
 * auto-reconnect-looping.
 *
 * `productionRuntime.ts` cannot be executed by this Jest project (native
 * imports), so its wiring is pinned by source scans. `runtime.ts` CAN be
 * executed behind the same mock set runtimeBuildCache/runtimeConfigGate
 * already use — and the DB half is behavior (WHICH handle, WHEN), so it
 * gets behavioral tests: rev-1 shipped a wrong-handle capture precisely
 * because it was pinned only statically (critic F1/F3).
 */
jest.mock('react-native', () => ({Platform: {OS: 'test'}}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem:    jest.fn(async () => null),
    setItem:    jest.fn(async () => {}),
    removeItem: jest.fn(async () => {}),
  },
}));
jest.mock('../runtime/keychain', () => ({getOrCreateDbKey: jest.fn(async () => 'deadbeefdeadbeefdeadbeefdeadbeef')}));
jest.mock('../crypto', () => ({}));
jest.mock('../crypto/db', () => ({openCryptoDb: jest.fn()}));
jest.mock('../crypto/sqlCipherStore', () => ({
  SqlCipherProtocolStore: class {
    db: unknown;
    constructor(db: unknown) { this.db = db; }
    getDb(): unknown { return this.db; }
  },
}));
jest.mock('../runtime/productionRuntime', () => ({buildProductionRuntime: jest.fn()}));
jest.mock('../runtime/receiveTransaction', () => ({
  runOnTxnChain: jest.fn(async (work: () => Promise<unknown>) => work()),
}));

import {readFileSync} from 'fs';
import {join} from 'path';

const RUNTIME_DIR = join(__dirname, '..', 'runtime');

// Conservative stripper: drops ONLY whole-line comments (trimmed line
// starting with //, /*, or *). Never touches trailing content, so an
// inline `//` inside a string cannot eat real code (the repo has lost a
// session to an over-eager stripper — see memory/source-scan notes).
function stripWholeLineComments(src: string): string {
  return src
    .split(/\r?\n/)
    .filter(l => {
      const t = l.trim();
      return !(t.startsWith('//') || t.startsWith('/*') || t.startsWith('*'));
    })
    .join('\n');
}

// Edge rev-1 killed both halves of this suite with a trailing-comment decoy
// (`void clearLiveTransport; // clearLiveTransport();`): the stripper only
// drops WHOLE-line comments, so substring assertions matched prose. A line
// that STARTS with the code (after trim) cannot be a trailing comment — and
// a real statement that starts with the call text IS the call.
function hasLineStartingWith(src: string, prefix: string): boolean {
  return src.split(/\r?\n/).some(l => l.trim().startsWith(prefix));
}

describe('AUDIT #11 — socket half: dispose closes + clears the live transport', () => {
  const src = readFileSync(join(RUNTIME_DIR, 'productionRuntime.ts'), 'utf8');

  it('disposeLiveRuntime calls clearLiveTransport() (site-anchored, code not prose)', () => {
    const start = src.indexOf('export function disposeLiveRuntime');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('export async function buildProductionRuntime', start);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    // The CALL at line start — a trailing-comment decoy cannot fake this.
    expect(hasLineStartingWith(body, 'clearLiveTransport();')).toBe(true);
    // …resolved from the registry module, where close() lives.
    expect(stripWholeLineComments(body)).toContain("require('./transportRegistry')");
  });
});

describe('AUDIT #11 — DB half: capture seam + chain routing (static pins)', () => {
  const src = readFileSync(join(RUNTIME_DIR, 'runtime.ts'), 'utf8');
  const stripped = stripWholeLineComments(src);

  it('reset fns capture ONLY liveOwnStore — never cachedOwnStore (critic F1)', () => {
    // Exactly two liveOwnStore captures, each a real LINE-START statement…
    const lines = src.split(/\r?\n/).map(l => l.trim());
    const liveCaptures = lines.filter(l => l.startsWith('captureStoreForClose(liveOwnStore);')).length;
    expect(liveCaptures).toBe(2);
    // …and NO capture of cachedOwnStore anywhere: cachedOwnStore means
    // "most recently resolved, live or HALF-BUILT" — capturing it closed
    // the handle an in-flight build was about to serve traffic on.
    expect(stripped).not.toContain('captureStoreForClose(cachedOwnStore');
    for (const fn of ['_resetMessengerRuntime(): void {', '_resetMessengerRuntimeKeepConfig(): void {']) {
      const at = src.indexOf(fn);
      expect(`${fn} found: ${at > -1}`).toBe(`${fn} found: true`);
      const body = src.slice(at, at + 450);
      expect(hasLineStartingWith(body, 'captureStoreForClose(liveOwnStore);')).toBe(true);
      expect(hasLineStartingWith(body, 'liveOwnStore = null;')).toBe(true);
      const capture = body.indexOf('captureStoreForClose(liveOwnStore);');
      const clearLive = body.indexOf('liveOwnStore = null;');
      const drop = body.indexOf('cachedOwnStore = null;');
      expect(`${fn} capture<clear<drop: ${capture > -1 && capture < clearLive && clearLive < drop}`)
        .toBe(`${fn} capture<clear<drop: true`);
    }
  });

  it('a FAILED build captures its own handle (critic F2 — the P1-2 retry leak)', () => {
    // The catch lane captures the build closure's ownStore, precisely —
    // a real line-start statement, not a decoy.
    expect(hasLineStartingWith(src, 'captureStoreForClose(ownStore);')).toBe(true);
    // Site-anchor: the ownStore capture sits between the build await and
    // the success seam.
    const buildAt = stripped.indexOf('await buildProductionRuntime(');
    const failCap = stripped.indexOf('captureStoreForClose(ownStore);');
    const liveAt = stripped.indexOf('liveOwnStore = ownStore;');
    expect(buildAt).toBeGreaterThan(-1);
    expect(failCap).toBeGreaterThan(buildAt);
    expect(liveAt).toBeGreaterThan(failCap);
    expect(hasLineStartingWith(src, 'liveOwnStore = ownStore;')).toBe(true);
  });

  it('the close runs on the txn chain, AFTER a successful production build only', () => {
    // Chain routing with the label, at LINE START — edge rev-1 proved a
    // `close(); // runOnTxnChain(…)` decoy passed a substring assertion
    // while the close ran OFF the chain (the exact race the routing
    // prevents: terminal-classified closed-handle throw → envelope
    // destroyed).
    expect(hasLineStartingWith(src, "await runOnTxnChain(async () => { close(); }, 'db-close-prev');"))
      .toBe(true);
    // Scheduled exactly once, only after the build resolves (epoch flipped
    // by the dispose inside it) — never on the loopback branch.
    const lines = src.split(/\r?\n/).map(l => l.trim());
    const schedules = lines.filter(l => l.startsWith('schedulePendingDbClose();')).length;
    expect(schedules).toBe(1);
    const buildAt = stripped.indexOf('await buildProductionRuntime(');
    const schedAt = stripped.indexOf('schedulePendingDbClose();');
    expect(buildAt).toBeGreaterThan(-1);
    expect(schedAt).toBeGreaterThan(buildAt);
    const loopbackAt = stripped.indexOf('const ownStore: CryptoStore = await resolveOwnStore(mode);');
    expect(loopbackAt).toBeGreaterThan(-1);
    expect(schedAt).toBeLessThan(loopbackAt);
  });

  it('pending closes COMPOSE across captures; nulled only at schedule time', () => {
    const helper = stripped.slice(
      stripped.indexOf('function schedulePendingDbClose'),
      stripped.indexOf('export function configureMessengerRuntime'));
    expect(helper).toContain('pendingPrevDbClose = null;');
    const cap = stripped.slice(
      stripped.indexOf('function captureStoreForClose'),
      stripped.indexOf('function schedulePendingDbClose'));
    expect(cap).toContain('const prior = pendingPrevDbClose;');
    expect(cap.replace(/\s+/g, '')).toContain('try{prior?.();}catch');
  });
});

describe('AUDIT #11 — restore-mode auto-busy survives the null-registry window (edge F4)', () => {
  it('the busy hangup WAITS for the rebuilt socket instead of ?.-dropping on null', () => {
    const nav = readFileSync(
      join(__dirname, '..', '..', '..', 'navigation', 'MainNavigator.tsx'), 'utf8');
    // The restore flow now nulls the registry for the rebuild window
    // (dispose → clearLiveTransport), which is EXACTLY when this busy
    // fires; a bare getLiveTransport()?.send silently dropped it and the
    // caller rang to the 30s timeout.
    expect(hasLineStartingWith(nav, 'void reg.waitForLiveTransport(8_000).then(t => {')).toBe(true);
    // The old drop shape must stay dead at this site: no bare
    // getLiveTransport()?.send of a call.hangup busy frame.
    const busyAt = nav.indexOf("reason: 'busy'");
    expect(busyAt).toBeGreaterThan(-1);
    const site = nav.slice(Math.max(0, busyAt - 600), busyAt);
    expect(site).not.toContain('getLiveTransport()?.send');
  });
});

describe('AUDIT #11 — DB-half lifecycle (behavioral — the real runtime.ts)', () => {
  type Handle = {execute: jest.Mock; close: jest.Mock};

  const rt = require('../runtime/runtime') as typeof import('../runtime/runtime');

  const dbMod = require('../crypto/db') as {openCryptoDb: jest.Mock};

  const prodMod = require('../runtime/productionRuntime') as {buildProductionRuntime: jest.Mock};

  const chainMod = require('../runtime/receiveTransaction') as {runOnTxnChain: jest.Mock};

  const CFG = {ownUserId: 'u1', ownerKey: 'owner-x'} as never;
  let handles: Handle[];

  const tick = () => new Promise<void>(res => setTimeout(res, 0));

  beforeEach(() => {
    handles = [];
    dbMod.openCryptoDb.mockImplementation(async () => {
      const h: Handle = {execute: jest.fn(async () => ({rows: []})), close: jest.fn()};
      handles.push(h);
      return h;
    });
    prodMod.buildProductionRuntime.mockReset();
    chainMod.runOnTxnChain.mockClear();
    rt._resetMessengerRuntime();
    // Drain any close carried over from the previous test's pending slot.
    jest.clearAllMocks?.();
  });

  it('happy rebuild: the PREVIOUS live handle closes exactly once, on the chain', async () => {
    prodMod.buildProductionRuntime.mockResolvedValue({} as never);
    rt.configureMessengerRuntime(CFG);
    await rt.getMessengerRuntime('production');           // B1 → h1 live
    rt._resetMessengerRuntime();                           // captures h1
    rt.configureMessengerRuntime(CFG);
    await rt.getMessengerRuntime('production');           // B2 → closes h1
    await tick();
    expect(handles).toHaveLength(2);
    expect(handles[0].close).toHaveBeenCalledTimes(1);
    expect(handles[1].close).not.toHaveBeenCalled();
    expect(chainMod.runOnTxnChain).toHaveBeenCalledWith(expect.any(Function), 'db-close-prev');
  });

  it('CRITIC F1 REGRESSION: a reset during an in-flight build must NOT capture that build\'s handle', async () => {
    prodMod.buildProductionRuntime.mockResolvedValueOnce({} as never);
    rt.configureMessengerRuntime(CFG);
    await rt.getMessengerRuntime('production');           // B1 → h1 live
    rt._resetMessengerRuntime();                           // captures h1

    let resolveB2: ((v: never) => void) | null = null;
    prodMod.buildProductionRuntime.mockImplementationOnce(
      () => new Promise(res => { resolveB2 = res as never; }));
    rt.configureMessengerRuntime(CFG);
    const p2 = rt.getMessengerRuntime('production');      // B2 parks mid-build
    await tick();                                          // h2 is open by now
    expect(handles).toHaveLength(2);

    rt._resetMessengerRuntime();                           // must capture NOTHING (h2 is half-built)
    rt.configureMessengerRuntime(CFG);
    prodMod.buildProductionRuntime.mockResolvedValueOnce({} as never);
    await rt.getMessengerRuntime('production');           // B3 → closes pending (h1 only)
    await tick();
    expect(handles[0].close).toHaveBeenCalledTimes(1);     // h1 closed
    expect(handles[1].close).not.toHaveBeenCalled();       // h2 NOT closed ← the rev-1 bug
    expect(handles[2].close).not.toHaveBeenCalled();       // h3 live

    resolveB2!({} as never);                               // B2 late-completes on h2
    await p2;
    await tick();
    expect(handles[1].close).not.toHaveBeenCalled();       // still open — it serves B2's caller
  });

  it('CRITIC rev-3 REGRESSION: an orphaned LATE build must not claim the seam (gen guard)', async () => {
    // Without the build generation, B2's late completion OVERWROTE
    // liveOwnStore (S3→S2): the next cycle then closed the ORPHAN's handle
    // and the LIVE one leaked — with the seam pointing at the wrong object
    // from then on.
    prodMod.buildProductionRuntime.mockResolvedValueOnce({} as never);
    rt.configureMessengerRuntime(CFG);
    await rt.getMessengerRuntime('production');           // B1 → h1 live
    rt._resetMessengerRuntime();                           // captures h1

    let resolveB2: ((v: never) => void) | null = null;
    prodMod.buildProductionRuntime.mockImplementationOnce(
      () => new Promise(res => { resolveB2 = res as never; }));
    rt.configureMessengerRuntime(CFG);
    const p2 = rt.getMessengerRuntime('production');      // B2 parks mid-build
    await tick();

    rt._resetMessengerRuntime();                           // orphans B2
    rt.configureMessengerRuntime(CFG);
    prodMod.buildProductionRuntime.mockResolvedValueOnce({} as never);
    await rt.getMessengerRuntime('production');           // B3 → live, closes h1
    await tick();

    resolveB2!({} as never);                               // B2 late-completes — may NOT claim
    await p2;
    await tick();

    rt._resetMessengerRuntime();                           // must capture h3 (the LIVE one)
    rt.configureMessengerRuntime(CFG);
    prodMod.buildProductionRuntime.mockResolvedValueOnce({} as never);
    await rt.getMessengerRuntime('production');           // B4 → closes h3
    await tick();

    expect(handles[0].close).toHaveBeenCalledTimes(1);     // h1: closed at B3
    expect(handles[1].close).not.toHaveBeenCalled();       // h2: orphan — leaks, never closed-while-live
    expect(handles[2].close).toHaveBeenCalledTimes(1);     // h3: the LIVE one, tracked and closed
    expect(handles[3].close).not.toHaveBeenCalled();       // h4: live now
  });

  it('CRITIC F2 REGRESSION: a failed build\'s handle closes after the next success (P1-2 retry lane)', async () => {
    rt.configureMessengerRuntime(CFG);
    prodMod.buildProductionRuntime.mockRejectedValueOnce(new Error('offline'));
    await expect(rt.getMessengerRuntime('production')).rejects.toThrow('offline'); // h1 opened, build died
    // P1-2: the rejected promise self-clears — the retry needs NO reset.
    prodMod.buildProductionRuntime.mockResolvedValueOnce({} as never);
    await rt.getMessengerRuntime('production');           // B2 → h2 live, closes h1
    await tick();
    expect(handles).toHaveLength(2);
    expect(handles[0].close).toHaveBeenCalledTimes(1);
    expect(handles[1].close).not.toHaveBeenCalled();
  });
});

describe('AUDIT #11 — clearLiveTransport behavioral contract (importable primitive)', () => {
  it('closes the prior client and nulls the slot', () => {
    jest.isolateModules(() => {

      const reg = require('../runtime/transportRegistry') as
        typeof import('../runtime/transportRegistry');
      const close = jest.fn();
      reg.setLiveTransport({close} as never);
      reg.clearLiveTransport();
      expect(close).toHaveBeenCalledTimes(1);
      expect(reg.getLiveTransport()).toBeNull();
    });
  });

  it('a close() that throws still leaves the slot null (tear-down must not wedge dispose)', () => {
    jest.isolateModules(() => {

      const reg = require('../runtime/transportRegistry') as
        typeof import('../runtime/transportRegistry');
      reg.setLiveTransport({close: () => { throw new Error('already down'); }} as never);
      expect(() => reg.clearLiveTransport()).not.toThrow();
      expect(reg.getLiveTransport()).toBeNull();
    });
  });
});
