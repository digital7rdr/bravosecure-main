/**
 * Static source-scan regression for Issue 21 (Testing Issues V2, PDF p.26) —
 * "Multi-Image Vault Upload Saves Only One Selected File".
 *
 * Two independent causes of the same symptom, either of which alone loses files:
 *   - launchImageLibrary was called with `selectionLimit: 1`;
 *   - the handler read `res.assets?.[0]` and dropped the rest regardless.
 *
 * VaultScreen mounts RN + native pickers, so the rule is pinned by reading the
 * source rather than rendering it — same pattern as sendErrorText.test.ts.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const SCREEN = join(process.cwd(), 'src', 'screens', 'messenger', 'VaultScreen.tsx');

/**
 * CRLF-normalised, comments stripped. Two traps, both hit while writing this:
 *
 *  - These files are CRLF. A `\n`-anchored regex matches NOTHING and every
 *    assertion passes vacuously.
 *  - The usual `/\/\*[\s\S]*?\*\//g` block-comment strip is WRONG here: this
 *    screen contains the MIME wildcard `'*&#47;*'`, whose middle two characters
 *    are a literal `/` followed by `*`. The regex reads that as a block-comment
 *    OPEN and deletes everything up to the next `*&#47;` — silently swallowing
 *    the rest of pickDocument. So block comments are matched line-wise, only
 *    where one actually opens a line (JSDoc / banner), never mid-expression.
 */
function code(): string {
  const src = readFileSync(SCREEN, 'utf8').replace(/\r\n/g, '\n');
  const out: string[] = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    const trimmed = line.trim();
    if (inBlock) {
      if (trimmed.includes('*/')) {inBlock = false;}
      continue;
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) {inBlock = true;}
      continue;
    }
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) {continue;}
    // Trailing `//` comment. The guard char excludes `://` (URLs) and any `//`
    // that sits inside a quoted string.
    out.push(line.replace(/([^:'"`])\/\/.*$/, '$1'));
  }
  return out.join('\n');
}

/** The CODE body of a picker handler, up to its closing catch. */
function handler(name: string): string {
  const src = code();
  const start = src.indexOf(`const ${name} = async () => {`);
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('\n  };', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('Issue 21 — every selected vault file is uploaded', () => {
  it('the image picker is not capped at one selection', () => {
    const body = handler('pickImage');
    expect(body).not.toMatch(/selectionLimit:\s*1\b/);
    // 0 means unlimited in react-native-image-picker.
    expect(body).toMatch(/selectionLimit:\s*0\b/);
  });

  it('the image picker uploads EVERY asset, not just assets[0]', () => {
    const body = handler('pickImage');
    expect(body).not.toMatch(/res\.assets\?\.\[0\]/);
    expect(body).toContain('uploadManyToVault');
  });

  it('the document picker is multi-select too (PDF: "ten and mixed file types")', () => {
    const body = handler('pickDocument');
    expect(body).toMatch(/multiple:\s*true/);
    expect(body).not.toMatch(/res\.assets\?\.\[0\]/);
    expect(body).toContain('uploadManyToVault');
  });

  it('a batch gives each file a UNIQUE fallback name', () => {
    const src = code();
    // `photo.jpg` for every un-named pick would land as N identical rows.
    expect(src).not.toMatch(/\?\?\s*'photo\.jpg'/);
    expect(src).toMatch(/photo-\$\{i \+ 1\}\.jpg/);
    expect(src).toMatch(/document-\$\{i \+ 1\}/);
  });

  it('a batch gives each file a UNIQUE sourceKey', () => {
    const src = code();
    // Date.now() alone collides for files picked in the same millisecond.
    expect(src).not.toMatch(/sourceKey:\s*`local:\$\{Date\.now\(\)\}`/);
    expect(src).toMatch(/sourceKey:\s*`local:\$\{Date\.now\(\)\}:\$\{index\}`/);
  });

  it('one failure does not abort the batch, and failures are named individually', () => {
    const src = code();
    const start = src.indexOf('const uploadManyToVault');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n  };', start));
    // Collect-and-continue, never throw out of the loop.
    expect(body).toMatch(/failed\.push\(/);
    expect(body).toMatch(/for \(const \[i, asset\] of assets\.entries\(\)\)/);
    // The summary must list what was lost — "do not silently discard".
    expect(body).toMatch(/failed\.join\(/);
    expect(body).toMatch(/saved/);
  });

  it('per-file uploads report outcomes instead of firing one alert each', () => {
    const src = code();
    const start = src.indexOf('const uploadOneToVault');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('const uploadToVault', start));
    expect(body).not.toContain('Alert.alert');
    expect(body).toMatch(/return \{ok: true\}/);
  });

  it('single-file paths still alert on failure (no behaviour lost)', () => {
    const src = code();
    const start = src.indexOf('const uploadToVault');
    const body = src.slice(start, src.indexOf('const uploadManyToVault', start));
    expect(body).toContain("Alert.alert('Not saved to vault'");
  });
});
