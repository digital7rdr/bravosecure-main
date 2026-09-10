/**
 * B-458 — the vault showed only THREE images, forever.
 *
 * `VaultScreen` rendered `images.slice(0, 3)` under a header that proudly
 * printed the true count ("Images · 12"), and the one affordance that could
 * have reached the rest — a `viewAll` style — was defined and never rendered.
 * Documents and audio in the same screen have always listed in full, so this
 * was images-only: upload a fourth photo and it vanished from the vault with no
 * way to open, move or delete it.
 *
 * A source scan rather than a render: VaultScreen pulls in the image picker,
 * the document picker, RNFS, the entitlement store and the file viewer, none of
 * which mount in this project. The scan is only as good as its anchors, so it
 * asserts the DECISION SITE (what the grid maps over), not merely that some
 * token is absent from the file.
 *
 * Traps handled: the file is CRLF (normalised below) and the fix's own comment
 * quotes the banned `images.slice(0, 3)` verbatim — an unstripped scan would
 * read that prose as code and report a false failure.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = process.cwd();

function code(rel: string): string {
  const src = readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  const out: string[] = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (inBlock) { if (t.includes('*/')) {inBlock = false;} continue; }
    if (t.startsWith('/*') || t.startsWith('{/*')) { if (!t.includes('*/')) {inBlock = true;} continue; }
    if (t.startsWith('*') || t.startsWith('//')) {continue;}
    out.push(line.replace(/([^:'"`])\/\/.*$/, '$1'));
  }
  return out.join('\n');
}

const SCREEN = 'src/screens/messenger/VaultScreen.tsx';

describe('B-458 — every vault image is reachable', () => {
  it('the fix comment is stripped, so these assertions read code only', () => {
    // Guards the scan itself: if the stripper regressed, the quoted
    // `images.slice(0, 3)` in the fix's comment would survive and the absence
    // assertion below would fail for the wrong reason.
    expect(readFileSync(join(ROOT, SCREEN), 'utf8')).toContain('images.slice(0, 3)');
    expect(code(SCREEN)).not.toContain('images.slice(0, 3)');
  });

  it('the image grid is not truncated', () => {
    const src = code(SCREEN);
    expect(src).not.toMatch(/images\s*\.\s*slice\s*\(/);
    expect(src).not.toMatch(/\.slice\(0,\s*3\)/);
  });

  it('the grid maps over the WHOLE image list', () => {
    // The decision site. `chunkOf3` only reshapes into rows of three — every
    // element survives — which the next assertion pins.
    expect(code(SCREEN)).toMatch(/chunkOf3\(images\)\.map\(/);
  });

  it('chunkOf3 partitions without dropping anything', () => {
    const src = code(SCREEN);
    const fn = src.slice(src.indexOf('function chunkOf3'));
    // Steps of 3 from 0 with an inclusive slice — no cap, no early break.
    expect(fn).toMatch(/for \(let i = 0; i < items\.length; i \+= 3\)/);
    expect(fn).toMatch(/rows\.push\(items\.slice\(i, i \+ 3\)\)/);
  });

  it('the count in the header is the count on screen', () => {
    // The old header printed `images.length` above a 3-item grid, which is how
    // this stayed invisible for so long.
    expect(code(SCREEN)).toMatch(/Images · \{images\.length\}/);
  });

  it('no dead "view all" affordance is left behind', () => {
    // It was a defined-but-never-rendered style; with the full grid there is
    // nothing left for it to link to.
    expect(code(SCREEN)).not.toMatch(/\bviewAll\b/);
  });

  it('the row wrapper style exists so stacked rows are actually spaced', () => {
    expect(code(SCREEN)).toMatch(/imageRows:\s*\{/);
  });
});
