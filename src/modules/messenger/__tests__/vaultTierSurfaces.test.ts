/**
 * B-591 / B-592 — the SURFACE wiring a unit test cannot reach.
 *
 * `transportKeysHttpClient.test.ts` pins the denied-reason detection and
 * `vaultOpenCeremony.test.ts` pins vaultOps' mapping — but neither can see
 * whether the four vault surfaces actually ROUTE a `tier` refusal to the
 * upgrade prompt, or whether the viewer still offers the "which folder?" ask
 * after a move. Those live in RN screens the node project cannot mount, so the
 * pin is a source scan (comment-stripped, CRLF-normalised — the house rules).
 *
 * The bug class: B-591 shipped precisely because ONE surface (the batch lane)
 * kept its own opinion about what a refusal meant. Every surface is therefore
 * enumerated HERE, so a fifth caller of moveBytesToVault without tier routing
 * shows up as a missing line in this list, not as a founder report.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const FILE_VIEWER = join('src', 'modules', 'messenger', 'ui', 'FileViewer.tsx');
const FILES       = join('src', 'screens', 'messenger', 'FilesScreen.tsx');
const VAULT       = join('src', 'screens', 'messenger', 'VaultScreen.tsx');
const BATCH       = join('src', 'screens', 'messenger', 'filesMultiSelect.ts');

/** Line-based strip — prose beside the code states these rules too, and
 *  matching the prose would pass vacuously. */
function codeOnly(rel: string): string {
  const lines = readFileSync(join(process.cwd(), rel), 'utf8')
    .replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let inBlock = false;
  for (const raw of lines) {
    const t = raw.trim();
    if (inBlock) { if (t.includes('*/')) {inBlock = false;} continue; }
    if (t.startsWith('/*') || t.startsWith('{/*')) { if (!t.includes('*/')) {inBlock = true;} continue; }
    if (t.startsWith('//') || t.startsWith('*')) {continue;}
    out.push(raw);
  }
  return out.join('\n');
}

describe('the scan reads real code', () => {
  it.each([FILE_VIEWER, FILES, VAULT, BATCH])('%s is non-trivial', rel => {
    expect(codeOnly(rel).length).toBeGreaterThan(2_000);
  });
});

describe('B-591 — a tier refusal reaches the upgrade prompt on EVERY surface', () => {
  it('FileViewer routes reason "tier" to showTierUpgradePrompt', () => {
    const src = codeOnly(FILE_VIEWER);
    expect(src).toMatch(/res\.reason === 'tier'/);
    expect(src).toMatch(/showTierUpgradePrompt\('cloud-vault'/);
  });

  it('FilesScreen routes BOTH the single move and the batch fatal', () => {
    const src = codeOnly(FILES);
    expect(src).toMatch(/res\.reason === 'tier'/);
    expect(src).toMatch(/out\.fatalReason === 'tier'/);
  });

  it('VaultScreen routes its upload lanes (single AND multi-pick)', () => {
    const src = codeOnly(VAULT);
    expect(src).toMatch(/res\.reason === 'tier'/);
    // The multi-pick loop must ABORT on tier — one honest ask, never another
    // biometric ceremony for the rest of the batch.
    expect(src).toMatch(/tierBlocked/);
    expect(src).toMatch(/showTierUpgradePrompt\('cloud-vault'/);
  });

  it('the batch helper treats tier as BATCH-FATAL, like its own docblock rule', () => {
    const src = codeOnly(BATCH);
    // In the fatal branch — not merely mentioned somewhere in the file.
    expect(src).toMatch(/res\.reason === 'no_pin' \|\| res\.reason === 'mfa_unavailable' \|\| res\.reason === 'tier'/);
    expect(src).toMatch(/fatalReason/);
  });
});

describe('B-592 — the viewer still asks "which folder?" after a move', () => {
  it('a successful move hands its objectKey to the album sheet', () => {
    const src = codeOnly(FILE_VIEWER);
    expect(src).toMatch(/setAlbumFor\(res\.objectKey\)/);
    expect(src).toMatch(/MoveToAlbumSheet/);
  });
});
