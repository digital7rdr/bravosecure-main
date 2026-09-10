/**
 * Imagery registry pins (client beautification pass, 2026-08-25).
 *
 * The brand photos are GENERATED into `src/assets/imagery/` by
 * `scripts/optimize-imagery.py` and resolved through `src/theme/imagery.ts`.
 * Two ways that pairing rots silently, both of which ship a blank card rather
 * than a crash:
 *
 *   1. A registry key points at a file the pipeline no longer emits. Metro
 *      fails the bundle for a missing require, but only for the screens that
 *      actually import it — and a `--dev` bundle can still boot.
 *   2. The pipeline MANIFEST and the registry drift apart, so a newly added
 *      photo is generated but unreachable (or vice versa).
 *
 * Both are source scans on purpose: importing the registry here would pull 42
 * JPEGs through the asset transformer for no added signal.
 */
import fs from 'fs';
import path from 'path';

const REPO = path.resolve(__dirname, '..', '..', '..');
const REGISTRY = path.join(REPO, 'src', 'theme', 'imagery.ts');
const PIPELINE = path.join(REPO, 'scripts', 'optimize-imagery.py');
const ASSET_DIR = path.join(REPO, 'src', 'assets', 'imagery');

/** `key: require('../assets/imagery/file.jpg')` -> [key, file] */
function registryEntries(): Array<[string, string]> {
  const src = fs.readFileSync(REGISTRY, 'utf8');
  const out: Array<[string, string]> = [];
  // Lazy getters: `get key(): T { return require('../assets/imagery/x.jpg'); }`
  const re = /get\s+(\w+)\(\)[^{]*\{\s*return require\('\.\.\/assets\/imagery\/([^']+)'\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {out.push([m[1], m[2]]);}
  return out;
}

/** `"key": ("source.jpg", "role"),` -> [key, role] */
function manifestRoles(): Array<[string, string]> {
  const src = fs.readFileSync(PIPELINE, 'utf8');
  const body = src.slice(src.indexOf('MANIFEST = {'), src.indexOf('\ndef build'));
  const out: Array<[string, string]> = [];
  const re = /^\s*"(\w+)":\s*\("[^"]+",\s*"(\w+)"\)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {out.push([m[1], m[2]]);}
  return out;
}

/** JPEG intrinsic size, read from the SOF marker — no decoder needed. */
function jpegSize(file: string): {w: number; h: number} {
  const buf = fs.readFileSync(file);
  let i = 2; // skip SOI
  while (i < buf.length - 9) {
    if (buf[i] !== 0xff) {i++; continue;}
    const marker = buf[i + 1];
    // SOF0..SOF15, excluding DHT (c4), JPG (c8) and DAC (cc)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7)};
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  throw new Error('no SOF marker in ' + file);
}

/** `"key": ("source.jpg", "role"),` -> key */
function manifestKeys(): string[] {
  const src = fs.readFileSync(PIPELINE, 'utf8');
  const body = src.slice(src.indexOf('MANIFEST = {'), src.indexOf('\ndef build'));
  const out: string[] = [];
  const re = /^\s*"(\w+)":\s*\(/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {out.push(m[1]);}
  return out;
}

describe('imagery registry', () => {
  const entries = registryEntries();

  it('resolves at least the full brand set', () => {
    expect(entries.length).toBeGreaterThanOrEqual(40);
  });

  it('every registry key points at a file that exists on disk', () => {
    const missing = entries.filter(([, file]) => !fs.existsSync(path.join(ASSET_DIR, file)));
    expect(missing.map(([k, f]) => `${k} -> ${f}`)).toEqual([]);
  });

  it('registry keys and pipeline MANIFEST keys are the same set', () => {
    const reg = entries.map(([k]) => k).sort();
    const man = manifestKeys().sort();
    expect(reg).toEqual(man);
  });

  it('every asset is a .jpg — RN\'s default iOS loader cannot decode WebP', () => {
    const bad = entries.filter(([, file]) => !file.endsWith('.jpg'));
    expect(bad).toEqual([]);
    const strays = fs.existsSync(ASSET_DIR)
      ? fs.readdirSync(ASSET_DIR).filter(f => !f.endsWith('.jpg'))
      : [];
    expect(strays).toEqual([]);
  });

  /**
   * Founder drop 2026-08-31. The agent dashboard keeps its full-width nav rows
   * and the VBG quick actions are short half-width tiles, so their art is
   * PLATED by the pipeline (subject right-aligned on an obsidian canvas at the
   * role aspect) rather than cropped. Dropping that step is silent: `cover`
   * would band-crop a 2:1 drop into a 4.8:1 row and throw the subject away, and
   * the card would still render "a dark photo". So the emitted aspect is pinned.
   */
  it('plated roles are emitted at their card aspect', () => {
    const ASPECT: Record<string, number> = {row: 4.8, wide: 2.9};
    const off = manifestRoles()
      .filter(([, role]) => role in ASPECT)
      .map(([key, role]) => {
        const {w, h} = jpegSize(path.join(ASSET_DIR, `${key}.jpg`));
        return {key, role, aspect: w / h};
      })
      .filter(a => Math.abs(a.aspect - ASPECT[a.role]) > 0.05);
    expect(off).toEqual([]);
  });

  it('plated roles cover every art-bearing dashboard row and tile', () => {
    // A guard against the set silently shrinking back to nothing.
    const plated = manifestRoles().filter(([, r]) => r === 'row' || r === 'wide');
    expect(plated.length).toBeGreaterThanOrEqual(17);
  });

  it('keeps the bundled imagery inside a sane size budget', () => {
    // The raw drop is ~16 MB; the pipeline exists to land it around 2 MB. A
    // regression here means someone re-encoded at source resolution.
    const total = fs
      .readdirSync(ASSET_DIR)
      .reduce((n, f) => n + fs.statSync(path.join(ASSET_DIR, f)).size, 0);
    expect(total).toBeLessThan(4 * 1024 * 1024);
  });
});
