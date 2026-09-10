/**
 * Albums — the wiring a unit test cannot reach.
 *
 * `fileAlbums.test.ts` pins the RULES and `vaultAlbumReset.test.ts` pins the
 * vault's storage coupling. Neither can see whether the two screens actually
 * call them, or whether the two album SPACES stayed apart once real screens
 * started importing them — which is the founder's decision most at risk from a
 * convenient import.
 *
 * Source scan, because both screens mount RN trees the node project cannot
 * build. Comments are stripped first: every rule below is also stated in prose
 * next to the code, and matching the prose would pass vacuously.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const FILES = join('src', 'screens', 'messenger', 'FilesScreen.tsx');
const VAULT = join('src', 'screens', 'messenger', 'VaultScreen.tsx');
const UI    = join('src', 'screens', 'messenger', 'albumUi.tsx');
// B-592 made the shared viewer the FOURTH album consumer (the post-move
// "which folder?" ask). It joined this scan the same day — a consumer these
// scans do not watch is the door the two spaces merge through.
const VIEWER = join('src', 'modules', 'messenger', 'ui', 'FileViewer.tsx');

/** Line-based strip — the house block-comment regex eats code holding `/*`. */
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
  it.each([FILES, VAULT, UI, VIEWER])('%s is non-trivial and LF-normalised', rel => {
    const src = codeOnly(rel);
    expect(src.length).toBeGreaterThan(2_000);
    expect(src).not.toContain('\r');
  });
});

describe('THE separation — Files albums and Vault albums never mix', () => {
  it('FilesScreen uses the Files album store and NEVER the vault album actions', () => {
    const src = codeOnly(FILES);
    expect(src).toMatch(/useFileAlbumStore/);
    expect(src).toMatch(/filesAlbumState/);
    // Reading vault FILES here is legitimate (the vault badge on each row).
    // Reading vault ALBUMS is not — it would merge the two spaces.
    //
    // Anchored on the vault store's SELECTOR shape, not on the bare word
    // `albumState`: FilesScreen has a local of its own, so the loose form
    // flagged correct code. Hence the deliberate `filesAlbumState` naming —
    // two different things should not share one identifier.
    expect(src).not.toMatch(/s\.albumState/);
    expect(src).not.toMatch(/VaultAlbum/);
  });

  it('VaultScreen uses the vault album state and NEVER the Files album store', () => {
    const src = codeOnly(VAULT);
    expect(src).toMatch(/s\.albumState/);
    expect(src).toMatch(/createVaultAlbum|renameVaultAlbum/);
    expect(src).not.toMatch(/useFileAlbumStore/);
  });

  it('FileViewer (B-592) files into the VAULT space and never the Files store', () => {
    // It moves a VAULT object it just created, so it must read the vault
    // space; a useFileAlbumStore import here would merge the two spaces from
    // a surface the original scans did not watch.
    const src = codeOnly(VIEWER);
    expect(src).toMatch(/s\.albumState/);
    expect(src).toMatch(/moveToVaultAlbum/);
    expect(src).not.toMatch(/useFileAlbumStore/);
  });

  it('the shared UI stays presentational — it reaches for NO store', () => {
    // The only thing keeping the two spaces apart is that each screen passes
    // its own state in. A store import here would merge them silently.
    const src = codeOnly(UI);
    expect(src).not.toMatch(/useFileAlbumStore|useVaultStore/);
    expect(src).not.toMatch(/AsyncStorage/);
  });
});

describe('albums are metadata — they never touch bytes or the MFA gate', () => {
  it('the album UI performs no vault, media or network operation', () => {
    const src = codeOnly(UI);
    for (const forbidden of [
      'moveBytesToVault', 'openVaultFileUri', 'readUriBytes',
      'removeFile', 'fetch(', 'download',
    ]) {
      expect(src).not.toContain(forbidden);
    }
  });

  it('the Files album action is wired to the album store, not to a batch effect', () => {
    const src = codeOnly(FILES);
    // The "Album" batch action must move METADATA. If it were ever pointed at
    // runBatchVaultMove/runBatchDelete it would move or destroy real files.
    const idx = src.indexOf('label="Album"');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 400);
    expect(block).toMatch(/setMovePicker\(true\)/);
    expect(block).not.toMatch(/runBatch/);
  });
});

describe('the screens keep the derived state honest', () => {
  /**
   * B-451 / B-452 — DELIBERATE REVERSAL of the original pin.
   *
   * This used to require `prune(rows.map(r => r.id))` on every `rows` change.
   * That sweep DELETED every assignment outside the current view and persisted
   * it at once, and `rows` is never the whole album key space: empty before
   * SQLCipher hydration, capped at 200 messages per conversation, and filtered
   * to company conversations inside the workspace shell (fails closed to
   * empty). Focusing the Vault tab therefore unfiled every personal file —
   * "I moved four images and only one stuck", read by the founder as a copy.
   *
   * The replacement is event-driven: assignments go only for ids the screen
   * just deleted. An orphan is invisible (every read in `fileAlbums.ts` is
   * existence-aware) and costs bytes; a destroyed one is data loss.
   */
  it('B-451/B-452 — FilesScreen NEVER prunes assignments from a view of the rows', () => {
    const src = codeOnly(FILES);
    expect(src).not.toMatch(/prune\(rows\.map/);
    // Any shape of view-driven sweep, not just the one that shipped: the
    // defect is "the row list authorises a delete", however it is spelled.
    expect(src).not.toMatch(/\.prune\(/);
  });

  it('B-451/B-452 — it forgets assignments only for files it just DELETED', () => {
    const src = codeOnly(FILES);
    expect(src).toMatch(/const forgetAlbumAssignments = \(ids: readonly string\[\]\) =>/);
    // The unfile primitive touches exactly the ids handed to it.
    const at = src.indexOf('const forgetAlbumAssignments');
    expect(src.slice(at, at + 200)).toMatch(/move\(ids, null\)/);
    // Both delete lanes are wired: the batch bar and the single-file viewer.
    const del = src.indexOf('runBatchDelete(selectedRows');
    expect(del).toBeGreaterThan(-1);
    expect(src.slice(del, del + 400)).toMatch(/forgetAlbumAssignments\(selectedRows\.map\(r => r\.id\)\)/);
    expect(src).toMatch(/onDelete=\{t => \{ removeMessage\([\s\S]{0,60}forgetAlbumAssignments\(\[t\.id\]\)/);
  });

  /**
   * B-452 — the move must file the SELECTION, not the scope-filtered view of
   * it. `selectedRows` is `rows.filter(...)`, so a selected id that fell out of
   * the view between the tap and the move was silently skipped.
   */
  it('B-452 — both move sites file the full selection, not selectedRows', () => {
    const src = codeOnly(FILES);
    expect(src).not.toMatch(/move\(selectedRows\.map/);
    // Site 1 — the destination picker builds the payload from `selected`…
    const pick = src.slice(src.indexOf('onPick={albumId =>'), src.indexOf('onPick={albumId =>') + 900);
    expect(pick).toMatch(/const ids = Array\.from\(selected \?\? \[\]\)/);
    expect(pick).toMatch(/albumActions\(\)\.move\(ids, albumId\)/);
    // Site 2 — create-album-then-file, the same rule.
    const create = src.slice(src.indexOf('albumActions().create(name)'));
    expect(create).toMatch(/albumActions\(\)\.move\(Array\.from\(selected\), id\)/);
  });

  /**
   * B-452 — `move` returns an AlbumError. Discarding it meant a `not_found`
   * moved NOTHING while the sheet closed as though it had worked.
   */
  it('B-452 — a returned AlbumError is surfaced, not swallowed', () => {
    const src = codeOnly(FILES);
    const at = src.indexOf('onPick={albumId =>');
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, at + 900);
    expect(block).toMatch(/const error = albumActions\(\)\.move\(/);
    expect(block).toMatch(/if \(error\) \{[\s\S]{0,200}Alert\.alert\(/);
    // …and it must not fall through to clearing the selection on failure.
    expect(block).toMatch(/Alert\.alert\([\s\S]{0,200}return;/);
  });

  /**
   * B-451 — the founder saw "a copy" because nothing on the row ever changed.
   * The row subtitle is the CONVERSATION name; the album was invisible, so a
   * successful move was indistinguishable from a no-op.
   */
  it('B-451 — a row renders the album it is filed under', () => {
    const src = codeOnly(FILES);
    expect(src).toMatch(/albumOf\(filesAlbumState, f\.id\)/);
    // Resolved through the LIVE album list, so a deleted album shows nothing
    // rather than a dead id (matches itemsInAlbum's Unfiled rule).
    expect(src).toMatch(/albumNameById\.get\(albumOf\(/);
    expect(src).toMatch(/albumName \? <Text style=\{styles\.fileAlbum\}/);
  });

  /**
   * ONE authority for the selection. The move sheet counts and files `selected`
   * while the header counted `selectedRows` (`rows` filtered by the company
   * scope), so inside the workspace shell the toolbar said "1 SELECTED" and the
   * move acted on four — the user cannot tell which number is real.
   */
  it('the header count reads the SAME set the move sheet acts on', () => {
    const src = codeOnly(FILES);
    expect(src).toMatch(/\{selected\?\.size \?\? 0\} SELECTED/);
    expect(src).not.toMatch(/\{selectedRows\.length\} SELECTED/);
    // The sheet's own count is the same authority, so the two can never drift.
    expect(src).toMatch(/count=\{selected\?\.size \?\? 0\}/);
  });

  it('...and the byte-consuming actions deliberately stay on selectedRows', () => {
    // NOT an oversight: delete / share / move-to-vault read mediaObjectKey,
    // mediaKey, mediaIv and conversationId OFF THE ROW, so an id with no row in
    // view is genuinely not actionable by them. Pinned so a later "consistency"
    // sweep does not point them at `selected` and hand them id-only entries.
    const src = codeOnly(FILES);
    expect(src).toMatch(/runBatchVaultMove\(selectedRows/);
    expect(src).toMatch(/runBatchShare\(selectedRows/);
    expect(src).toMatch(/runBatchDelete\(selectedRows/);
  });

  /**
   * "+ New album" on the ALBUM BAR is a plain create. Only the move sheet's
   * create lane may file the live selection into the new album.
   */
  it('the create lane files the selection only when it came from the MOVE SHEET', () => {
    const src = codeOnly(FILES);
    // The origin is carried in state, never re-derived from `selected` — the
    // bar happens to be hidden in selection mode today, but that is a
    // RENDERING accident, not the rule.
    expect(src).toMatch(/onCreate=\{\(\) => setNamingAlbum\(\{mode: 'create', fileSelection: false\}\)\}/);
    expect(src).toMatch(/setNamingAlbum\(\{mode: 'create', fileSelection: true\}\)/);
    // …and the decision site actually consults it.
    const at = src.indexOf('albumActions().create(name)');
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, at + 500);
    expect(block).toMatch(/namingAlbum\?\.mode === 'create' && namingAlbum\.fileSelection/);
  });

  it('both screens fall back to All when the open album is deleted', () => {
    // Otherwise the list strands on an empty filter with no way back.
    for (const rel of [FILES, VAULT]) {
      const src = codeOnly(rel);
      expect(src).toMatch(/setAlbumFilter\(undefined\)/);
      expect(src).toMatch(/typeof albumFilter === 'string'/);
    }
  });

  it('VaultScreen filters BEFORE the type split, so all three sections agree', () => {
    const src = codeOnly(VAULT);
    const inAlbum = src.indexOf('const inAlbum');
    const images  = src.indexOf('const images    = inAlbum');
    expect(inAlbum).toBeGreaterThan(-1);
    expect(images).toBeGreaterThan(inAlbum);
    // The sections must read the FILTERED list, not the raw one.
    // `\s+` rather than literal runs of spaces: the alignment is cosmetic, and
    // pinning it would make a harmless reformat fail this gate.
    expect(src).toMatch(/const documents\s+= inAlbum\./);
    expect(src).toMatch(/const audios\s+= inAlbum\./);
  });

  it('the Vault album bar is Personal-shelf only', () => {
    // The Company shelf is scoped by server-side channel membership; a local
    // folder over it would imply an organisation the user does not control.
    const src = codeOnly(VAULT);
    const idx = src.indexOf('<AlbumBar');
    expect(idx).toBeGreaterThan(-1);
    expect(src.slice(Math.max(0, idx - 260), idx)).toMatch(/shelf === 'Personal'/);
  });
});

/**
 * B-708 — "Pls shift box higher. It covered by keyboard. Its on vault, image
 * upload, album creating." (founder, 2026-08-30)
 *
 * `NameAlbumModal` autofocuses its field, so the IME is up for the whole life
 * of the dialog — and the box was centred in the FULL window, which put Cancel
 * and Save behind the keyboard. All three album consumers (Files, Vault and the
 * shared FileViewer) render this one component, so the lift belongs here.
 */
describe('B-708 — the name dialog re-centres above the keyboard', () => {
  it('uses the app-wide keyboard rule, not a dp constant', () => {
    const src = codeOnly(UI);
    expect(src).toMatch(/from '@hooks\/useKeyboardLayout'/);
    expect(src).toMatch(/const \{overlap\} = useKeyboardLayout\(\)/);
  });

  it('the naming sheet itself carries the lift', () => {
    const src = codeOnly(UI);
    // On a centred backdrop the margin is part of the child's outer box, so
    // `justifyContent: 'center'` re-centres it in the space the IME leaves.
    // Applied to the SHEET, not the backdrop: the backdrop's `padding: 24`
    // would be overridden by an inline paddingBottom and the box would touch
    // the keyboard.
    expect(src).toMatch(/style=\{\[s\.sheet, overlap > 0 && \{marginBottom: overlap\}\]\}/);
  });

  it('never hand-rolls keyboard avoidance (B-184 ban list)', () => {
    const src = codeOnly(UI);
    expect(src).not.toMatch(/KeyboardAvoidingView/);
    expect(src).not.toMatch(/keyboardVerticalOffset/);
    expect(src).not.toMatch(/Keyboard\.addListener/);
    expect(src).not.toMatch(/kbHeight/);
  });
});
