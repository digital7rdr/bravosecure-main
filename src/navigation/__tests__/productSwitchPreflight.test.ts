/**
 * Channels vs2 edge A5 — EVERY product switch goes through the one pre-flight.
 *
 * A product switch is not a navigation: `switchProduct` is a plain store write
 * and the client shell is keyed on `activeProduct`, so the remount is a raw
 * React unmount that never dispatches `beforeRemove`. Three things must happen
 * first — ask, warn if an unanswered group ring will die, and minimise a live
 * call so `FloatingCallOverlay` can keep it alive — and the VBG Home "Secure
 * Services" tile shipped with NONE of them, destroying a full-screen call with
 * no End button.
 *
 * A SOURCE SCAN, because no unit test mounts `VBGHomeScreen` and the fix is one
 * `onPress`. Reverting it to the bare `switchProduct(...)` it had at `83d73825`
 * would otherwise leave every gate in the repo green.
 *
 * ⚠️ Comments are STRIPPED before every assertion: the prose explaining this
 * fix names both `switchProduct` and `minimiseLiveCall` several times, and a
 * scan that counted those would pass on a file that had lost the code. Files
 * are CRLF, so nothing here is `\n`-anchored.
 */
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\/[^\r\n]*/g, '');
}

/** Every .ts/.tsx under src/, excluding tests. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === '__tests__' || name === '__mocks__') {continue;}
      sourceFiles(p, out);
    } else if (/\.tsx?$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

const SRC = join(process.cwd(), 'src');
const FILES = sourceFiles(SRC);

/** Files that CALL switchProduct (its own definition/re-export excluded). */
function callers(): string[] {
  return FILES.filter(f => {
    if (f.endsWith(join('store', 'productStore.ts'))) {return false;}
    return /(?<![\w.])switchProduct\s*\(/.test(stripComments(readFileSync(f, 'utf8')));
  });
}

describe('edge A5 — no product switch bypasses the pre-flight', () => {
  it('extraction sanity — the scan sees real files and a real caller', () => {
    // A regex that stopped matching would make every assertion below pass
    // vacuously on an empty set.
    expect(FILES.length).toBeGreaterThan(200);
    const hits = callers();
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some(f => f.endsWith(join('vbg', 'VBGHomeScreen.tsx')))).toBe(true);
  });

  it('every switchProduct caller also reaches the shared pre-flight', () => {
    // `confirmProductSwitch` performs the ask, the ring warning AND the
    // minimise; a caller that imports neither it nor `minimiseLiveCall` is
    // switching product bare — the A5 bug.
    const bare = callers().filter(f => {
      const code = stripComments(readFileSync(f, 'utf8'));
      return !/confirmProductSwitch/.test(code) && !/minimiseLiveCall/.test(code);
    });
    expect(bare.map(f => f.slice(SRC.length + 1))).toEqual([]);
  });

  it('the VBG tile specifically routes through confirmProductSwitch', () => {
    // Named, not just counted: this is the door the bug shipped on, and the
    // generic assertion above would still pass if the tile kept an unrelated
    // mention of the helper elsewhere in the file.
    const code = stripComments(
      readFileSync(join(SRC, 'screens', 'vbg', 'VBGHomeScreen.tsx'), 'utf8'));
    expect(code).toMatch(/confirmProductSwitch\(\s*['"]Secure Services['"]/);
    // …and does NOT call switchProduct outside that callback.
    const idxConfirm = code.indexOf('confirmProductSwitch(');
    const idxSwitch = code.indexOf('switchProduct(');
    expect(idxConfirm).toBeGreaterThan(-1);
    expect(idxSwitch).toBeGreaterThan(idxConfirm);
  });

  it('minimiseLiveCall has exactly ONE definition, and it is the shared one', () => {
    // It lived privately inside `SwitchDashboardSection`, which is precisely why
    // the VBG tile could not reuse it. A second copy would restart the drift.
    const defs = FILES.filter(f =>
      /(export\s+)?function\s+minimiseLiveCall\s*\(/.test(stripComments(readFileSync(f, 'utf8'))));
    expect(defs.map(f => f.slice(SRC.length + 1))).toEqual([join('navigation', 'productSwitch.ts')]);
  });

  it('the pre-flight warns about an unanswered group ring', () => {
    // `hasLiveCall()` is false while a group call is still RINGING, so the
    // minimise no-ops and the keyed remount destroys the ring with nothing to
    // restore. Blocking the switch would trap the user, so the cost is stated.
    const code = stripComments(
      readFileSync(join(SRC, 'navigation', 'productSwitch.ts'), 'utf8'));
    expect(code).toMatch(/peekPendingGroupRing/);
    expect(code).toMatch(/still ringing/i);
    // The minimise runs on CONFIRM, never before the user has answered.
    expect(code).toMatch(/\(\)\s*=>\s*\{\s*minimiseLiveCall\(\);\s*onConfirmed\(\);\s*\}/);
  });
});
