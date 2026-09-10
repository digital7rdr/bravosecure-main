/**
 * B-256 — "after finishing the call from the app, the 'Bravo Secure video
 * call · Hang up' notification is still there".
 *
 * The stop had two independent ways to not happen:
 *
 *  1. It early-returned on a JS module flag (`if (!active) return`), so the
 *     native service was only ever told to stop when THIS module believed it
 *     was running. That belief is false after a JS reload, false if `start`
 *     threw after the notification was posted, and false whenever an earlier
 *     teardown path already cleared it. Any of those strands the notification
 *     with nothing left to dismiss it.
 *
 *  2. It was unarbitrated. One service, two call stacks — the same shape as
 *     the InCallManager session that B-243 fixed. The foreground service
 *     sitting directly below the audio session in BOTH registries kept the
 *     unconditional stop, so a stale 1:1 teardown ripped the notification off
 *     a live group call.
 */
const readFileSync = require('node:fs').readFileSync as typeof import('node:fs').readFileSync;
const join = require('node:path').join as typeof import('node:path').join;

function code(rel: string): string {
  const raw = readFileSync(join(process.cwd(), rel), 'utf8');
  const out: string[] = [];
  let inBlock = false;
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (inBlock) { if (t.includes('*/')) {inBlock = false;} continue; }
    if (t.startsWith('/*')) { if (!t.includes('*/')) {inBlock = true;} continue; }
    if (t.startsWith('*') || t.startsWith('//')) {continue;}
    out.push(line);
  }
  return out.join('\n');
}

const FGS = 'src/modules/messenger/runtime/callForegroundService.ts';

describe('the stop no longer trusts a stale JS flag', () => {
  it('does NOT early-return on `active`', () => {
    // This single condition is what left the notification up.
    const src = code(FGS);
    expect(src).not.toMatch(/if \(!native \|\| !active\) \{return;\}/);
    expect(src).toMatch(/export function stopCallForegroundService\(owner\?: 'direct' \| 'group'\): void \{[\s\S]{0,80}if \(!native\) \{return;\}/);
  });

  it('still reaches the native stop, which is the only thing that clears it', () => {
    expect(code(FGS)).toMatch(/native\.stop\(\);/);
  });

  it('keeps `active` as telemetry so isCallForegroundActive still answers', () => {
    const src = code(FGS);
    expect(src).toMatch(/active = false;/);
    expect(src).toMatch(/export function isCallForegroundActive\(\): boolean/);
  });
});

describe('the stop is arbitrated between the two call stacks', () => {
  it('skips while the OTHER stack still owns a live call', () => {
    const src = code(FGS);
    expect(src).toMatch(/if \(otherStackHasLiveCall\(owner\)\)/);
    expect(src).toMatch(/stop skipped/);
  });

  it('reuses the B-243 predicate rather than re-deriving ownership', () => {
    // Two answers to "is anyone else on a call?" in two files is how the audio
    // arbitration and the notification arbitration drift apart.
    expect(code(FGS)).toMatch(/require\('\.\/callAudioSession'\)/);
    expect(code('src/modules/messenger/runtime/callAudioSession.ts'))
      .toMatch(/export function otherStackHasLiveCall\(owner: Owner\): boolean/);
  });

  it('a failure to resolve the other stack still stops — the safer default', () => {
    // A stranded notification is worse than an early one: nothing else can
    // clear it, whereas a missing one is re-posted by the next call.
    const src = code(FGS);
    const block = src.slice(src.indexOf('if (owner) {'), src.indexOf('native.stop()'));
    expect(block).toMatch(/catch \{/);
  });

  it('an ownerless call force-stops, for a true app-teardown path', () => {
    expect(code(FGS)).toMatch(/if \(owner\) \{/);
  });
});

describe('every teardown path declares which stack it is', () => {
  const SITES: Array<[string, string, string]> = [
    ['1:1 registry',   'src/modules/messenger/runtime/callRegistry.ts',      "'direct'"],
    ['group registry', 'src/modules/messenger/runtime/groupCallRegistry.ts', "'group'"],
    ['1:1 screen',     'src/screens/messenger/CallScreen.tsx',               "'direct'"],
    ['group screen',   'src/screens/messenger/GroupCallScreen.tsx',          "'group'"],
  ];

  it.each(SITES)('%s passes %s', (_label, rel, owner) => {
    expect(code(rel)).toContain(`stopCallForegroundService(${owner})`);
  });

  it.each(SITES)('%s leaves no unarbitrated bare stop behind', (_label, rel) => {
    // One missed call site re-opens the cross-stack half of the bug.
    expect(code(rel)).not.toMatch(/stopCallForegroundService\(\);/);
  });
});
