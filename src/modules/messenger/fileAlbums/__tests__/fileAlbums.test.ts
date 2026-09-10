/**
 * Albums — the rules that stop a folder feature from eating files.
 *
 * Founder 2026-08-08: create albums in Files and Vault, multi-select images and
 * move them into folders.
 *
 * The assertions that matter here are the destructive ones. An album owns no
 * bytes, so every operation must be provably non-destructive to the underlying
 * file — deleting an album unfiles, it does not delete; a torn assignment
 * surfaces as Unfiled rather than hiding a file from every view at once.
 */
import {
  EMPTY_ALBUM_STATE, MAX_ALBUM_NAME,
  createAlbum, renameAlbum, deleteAlbum, moveToAlbum,
  albumOf, itemsInAlbum, albumCounts, pruneAssignments, normaliseName,
  type AlbumState,
} from '../fileAlbums';

/** Build a state with albums a1..aN already created. */
function withAlbums(...names: string[]): AlbumState {
  let s = EMPTY_ALBUM_STATE;
  names.forEach((n, i) => { s = createAlbum(s, n, `a${i + 1}`, 1000 + i).state; });
  return s;
}

describe('createAlbum', () => {
  it('creates one', () => {
    const {state, error} = createAlbum(EMPTY_ALBUM_STATE, 'Site Recce', 'a1', 1234);
    expect(error).toBeNull();
    expect(state.albums).toEqual([{id: 'a1', name: 'Site Recce', createdAt: 1234}]);
  });

  it('trims and collapses whitespace', () => {
    const {state} = createAlbum(EMPTY_ALBUM_STATE, '  Site   Recce  ', 'a1', 1);
    expect(state.albums[0].name).toBe('Site Recce');
  });

  it('rejects an empty or whitespace-only name', () => {
    expect(createAlbum(EMPTY_ALBUM_STATE, '', 'a1', 1).error).toBe('empty');
    expect(createAlbum(EMPTY_ALBUM_STATE, '   ', 'a1', 1).error).toBe('empty');
    expect(createAlbum(EMPTY_ALBUM_STATE, '\n\t', 'a1', 1).error).toBe('empty');
  });

  it('rejects a duplicate name case-insensitively, and after normalising', () => {
    const s = withAlbums('Site Recce');
    expect(createAlbum(s, 'site recce', 'a2', 2).error).toBe('duplicate');
    expect(createAlbum(s, '  SITE   RECCE ', 'a2', 2).error).toBe('duplicate');
  });

  it('rejects an over-long name at the boundary', () => {
    const max = 'x'.repeat(MAX_ALBUM_NAME);
    expect(createAlbum(EMPTY_ALBUM_STATE, max, 'a1', 1).error).toBeNull();
    expect(createAlbum(EMPTY_ALBUM_STATE, max + 'y', 'a1', 1).error).toBe('too_long');
  });

  it('returns the state UNCHANGED on every rejection', () => {
    const s = withAlbums('Site Recce');
    for (const bad of ['', '   ', 'site recce', 'x'.repeat(MAX_ALBUM_NAME + 1)]) {
      expect(createAlbum(s, bad, 'a9', 9).state).toBe(s);
    }
  });
});

describe('renameAlbum', () => {
  it('renames', () => {
    const s = withAlbums('Old');
    const {state, error} = renameAlbum(s, 'a1', 'New');
    expect(error).toBeNull();
    expect(state.albums[0].name).toBe('New');
  });

  it('lets an album keep its own name (case/spacing change is not a duplicate)', () => {
    const s = withAlbums('Site Recce');
    expect(renameAlbum(s, 'a1', 'SITE RECCE').error).toBeNull();
    expect(renameAlbum(s, 'a1', ' Site  Recce ').error).toBeNull();
  });

  it('still rejects clashing with a DIFFERENT album', () => {
    const s = withAlbums('One', 'Two');
    expect(renameAlbum(s, 'a2', 'one').error).toBe('duplicate');
  });

  it('rejects an unknown album, empty and over-long names', () => {
    const s = withAlbums('One');
    expect(renameAlbum(s, 'nope', 'X').error).toBe('not_found');
    expect(renameAlbum(s, 'a1', '  ').error).toBe('empty');
    expect(renameAlbum(s, 'a1', 'x'.repeat(MAX_ALBUM_NAME + 1)).error).toBe('too_long');
  });

  it('keeps every assignment — renaming is not a move', () => {
    let s = withAlbums('One');
    s = moveToAlbum(s, ['f1', 'f2'], 'a1').state;
    const after = renameAlbum(s, 'a1', 'Renamed').state;
    expect(after.assignments).toEqual({f1: 'a1', f2: 'a1'});
  });
});

describe('deleteAlbum', () => {
  it('UNFILES its items — it must never look like a way to delete files', () => {
    let s = withAlbums('One', 'Two');
    s = moveToAlbum(s, ['f1', 'f2'], 'a1').state;
    s = moveToAlbum(s, ['f3'], 'a2').state;

    const {state, error} = deleteAlbum(s, 'a1');

    expect(error).toBeNull();
    expect(state.albums.map(a => a.id)).toEqual(['a2']);
    // f1/f2 are unfiled, NOT gone; f3 is untouched.
    expect(albumOf(state, 'f1')).toBeNull();
    expect(albumOf(state, 'f2')).toBeNull();
    expect(albumOf(state, 'f3')).toBe('a2');
    expect(itemsInAlbum(state, null, ['f1', 'f2', 'f3'])).toEqual(['f1', 'f2']);
  });

  it('rejects an unknown album without touching state', () => {
    const s = withAlbums('One');
    const {state, error} = deleteAlbum(s, 'nope');
    expect(error).toBe('not_found');
    expect(state).toBe(s);
  });
});

describe('moveToAlbum', () => {
  it('files several items at once — the multi-select case', () => {
    const s = withAlbums('One');
    const {state} = moveToAlbum(s, ['f1', 'f2', 'f3'], 'a1');
    expect(itemsInAlbum(state, 'a1', ['f1', 'f2', 'f3'])).toEqual(['f1', 'f2', 'f3']);
  });

  it('MOVES rather than copies — one album per item', () => {
    let s = withAlbums('One', 'Two');
    s = moveToAlbum(s, ['f1'], 'a1').state;
    s = moveToAlbum(s, ['f1'], 'a2').state;
    expect(albumOf(s, 'f1')).toBe('a2');
    expect(itemsInAlbum(s, 'a1', ['f1'])).toEqual([]);
  });

  it('unfiles with a null album', () => {
    let s = withAlbums('One');
    s = moveToAlbum(s, ['f1'], 'a1').state;
    s = moveToAlbum(s, ['f1'], null).state;
    expect(albumOf(s, 'f1')).toBeNull();
    // Unfiling DELETES the key rather than storing null, so the map does not
    // accumulate a tombstone per file the user ever touched.
    expect(Object.hasOwn(s.assignments, 'f1')).toBe(false);
  });

  it('rejects an unknown album without moving anything', () => {
    const s = withAlbums('One');
    const {state, error} = moveToAlbum(s, ['f1'], 'ghost');
    expect(error).toBe('not_found');
    expect(state).toBe(s);
  });

  it('an empty selection is a harmless no-op', () => {
    const s = withAlbums('One');
    expect(moveToAlbum(s, [], 'a1').error).toBeNull();
  });
});

describe('itemsInAlbum / albumCounts', () => {
  it('treats an assignment to a DELETED album as Unfiled, never as hidden', () => {
    // A torn state must surface the file somewhere. Filtering it out of both
    // the album view and Unfiled would make it invisible in every view at once.
    const s: AlbumState = {albums: [], assignments: {f1: 'gone'}};
    expect(itemsInAlbum(s, null, ['f1'])).toEqual(['f1']);
    expect(albumCounts(s, ['f1']).get(null)).toBe(1);
  });

  it('counts against items that EXIST, so a deleted file stops counting at once', () => {
    let s = withAlbums('One');
    s = moveToAlbum(s, ['f1', 'f2'], 'a1').state;
    // f2's message was deleted from the chat — the Files view no longer lists it.
    const counts = albumCounts(s, ['f1']);
    expect(counts.get('a1')).toBe(1);
    expect(counts.get(null)).toBe(0);
  });

  it('always reports every album, including empty ones', () => {
    const s = withAlbums('One', 'Two');
    const counts = albumCounts(s, []);
    expect(counts.get('a1')).toBe(0);
    expect(counts.get('a2')).toBe(0);
    expect(counts.get(null)).toBe(0);
  });

  it('preserves the caller ordering of items', () => {
    let s = withAlbums('One');
    s = moveToAlbum(s, ['f3', 'f1', 'f2'], 'a1').state;
    expect(itemsInAlbum(s, 'a1', ['f1', 'f2', 'f3'])).toEqual(['f1', 'f2', 'f3']);
  });
});

describe('pruneAssignments', () => {
  it('drops assignments whose file is gone', () => {
    let s = withAlbums('One');
    s = moveToAlbum(s, ['f1', 'f2', 'f3'], 'a1').state;
    const pruned = pruneAssignments(s, ['f1', 'f3']);
    expect(pruned.assignments).toEqual({f1: 'a1', f3: 'a1'});
  });

  it('keeps the albums themselves — an empty album is legitimate', () => {
    let s = withAlbums('One');
    s = moveToAlbum(s, ['f1'], 'a1').state;
    expect(pruneAssignments(s, []).albums.map(a => a.id)).toEqual(['a1']);
  });

  it('returns the SAME object when nothing changed', () => {
    // The Files tab is a view over messages, so this runs on every list
    // render; a fresh object each time would re-render the whole screen.
    let s = withAlbums('One');
    s = moveToAlbum(s, ['f1'], 'a1').state;
    expect(pruneAssignments(s, ['f1'])).toBe(s);
    expect(pruneAssignments(EMPTY_ALBUM_STATE, [])).toBe(EMPTY_ALBUM_STATE);
  });
});

describe('normaliseName', () => {
  it('is what makes the duplicate check meaningful', () => {
    expect(normaliseName('  a   b  ')).toBe('a b');
    expect(normaliseName('a\tb')).toBe('a b');
    expect(normaliseName('')).toBe('');
  });
});

describe('the state is never mutated in place', () => {
  it('leaves the input untouched for every operation', () => {
    let s = withAlbums('One', 'Two');
    s = moveToAlbum(s, ['f1'], 'a1').state;
    const snapshot = JSON.stringify(s);

    createAlbum(s, 'Three', 'a3', 3);
    renameAlbum(s, 'a1', 'Renamed');
    deleteAlbum(s, 'a1');
    moveToAlbum(s, ['f1'], 'a2');
    pruneAssignments(s, []);

    expect(JSON.stringify(s)).toBe(snapshot);
  });
});
