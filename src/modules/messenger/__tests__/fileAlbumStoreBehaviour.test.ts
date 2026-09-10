/**
 * `fileAlbums/fileAlbumStore` — the FILES-tab album store, executed.
 *
 * The pure decision layer (`fileAlbums.ts`) has a good suite already; the STORE
 * around it was at 18% — `create`, `rename`, `remove`, `move`, `prune` and
 * `reset` had never run, and neither had the id generator.
 *
 * The store is where the pure rules meet three things a pure test cannot see:
 *
 *   1. ID GENERATION. The pure layer takes an injected id; the store mints one.
 *      Two albums created in the same millisecond must not collide, or one
 *      folder silently swallows the other's contents.
 *   2. THE ERROR PATH MUST NOT WRITE. `createAlbum` returns
 *      `{state, error}` where `state` is the UNCHANGED input on failure — the
 *      store has to notice the error and skip the `set`, and a store that wrote
 *      unconditionally would still return the right error while corrupting
 *      state.
 *   3. `prune`'s REFERENTIAL GUARD. It runs off the Files list on every pass, so
 *      a `set` when nothing changed re-renders that list forever. The module
 *      comment says exactly this; the guard is invisible to any state-value
 *      assertion, so it is pinned by counting store emissions.
 *
 * An album owns no bytes. Every destructive-looking operation below is asserted
 * to leave the item ids alone.
 */
jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem:    async (k: string) => store.get(k) ?? null,
      setItem:    async (k: string, v: string) => { store.set(k, v); },
      removeItem: async (k: string) => { store.delete(k); },
      clear:      async () => { store.clear(); },
      __dump:     () => Object.fromEntries(store),
    },
  };
});

import {useFileAlbumStore} from '../fileAlbums/fileAlbumStore';
import {albumOf, itemsInAlbum, albumCounts} from '../fileAlbums/fileAlbums';

const s = () => useFileAlbumStore.getState();

beforeEach(() => {
  s().reset();
});

describe('fileAlbumStore — creating folders', () => {
  it('creates an album and returns a usable id', () => {
    const {id, error} = s().create('Site Recce');
    expect(error).toBeNull();
    expect(id).toEqual(expect.any(String));
    expect(s().albums).toEqual([{id, name: 'Site Recce', createdAt: expect.any(Number)}]);
  });

  it('normalises the name it stores', () => {
    s().create('  Site   Recce  ');
    expect(s().albums[0].name).toBe('Site Recce');
  });

  /**
   * Ids are minted per-call from a timestamp plus randomness. Two creates in the
   * same millisecond are the realistic case (a user pasting two names, a seeded
   * import), and a collision would make two folders one.
   */
  it('mints a DISTINCT id for every album, even created in the same tick', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 200; i++) {ids.add(s().create(`Album ${i}`).id!);}
    expect(ids.size).toBe(200);
    expect([...ids].every(id => typeof id === 'string' && id.length > 0)).toBe(true);
  });

  it.each([
    ['an empty name', '', 'empty'],
    ['whitespace only', '   ', 'empty'],
    ['an over-long name', 'x'.repeat(41), 'too_long'],
  ])('refuses %s WITHOUT writing state', (_label, name, expected) => {
    s().create('Keeper');
    const before = s().albums;

    const {id, error} = s().create(name);
    expect(error).toBe(expected);
    expect(id).toBeNull();
    expect(s().albums).toBe(before);          // same reference: nothing was set
  });

  it('refuses a case-insensitive duplicate without writing state', () => {
    s().create('Contracts');
    const before = s().albums;

    const {id, error} = s().create('  contracts ');
    expect(error).toBe('duplicate');
    expect(id).toBeNull();
    expect(s().albums).toBe(before);
    expect(s().albums).toHaveLength(1);
  });
});

describe('fileAlbumStore — renaming', () => {
  it('renames in place, keeping the id and the filed items', () => {
    const id = s().create('Recce').id!;
    s().move(['m1', 'm2'], id);

    expect(s().rename(id, 'Site Recce')).toBeNull();
    expect(s().albums).toEqual([{id, name: 'Site Recce', createdAt: expect.any(Number)}]);
    expect(s().assignments).toEqual({m1: id, m2: id});
  });

  it('renaming an album to the name it already has is a no-op, not a duplicate', () => {
    const id = s().create('Recce').id!;
    expect(s().rename(id, 'Recce')).toBeNull();
    expect(s().albums[0].name).toBe('Recce');
  });

  it('refuses an unknown album and writes nothing', () => {
    s().create('Recce');
    const before = s().albums;
    expect(s().rename('alb_nope', 'Anything')).toBe('not_found');
    expect(s().albums).toBe(before);
  });

  it('refuses a clash with another album and leaves both names intact', () => {
    const a = s().create('Recce').id!;
    s().create('Contracts');
    expect(s().rename(a, 'contracts')).toBe('duplicate');
    expect(s().albums.map(x => x.name)).toEqual(['Recce', 'Contracts']);
  });

  it('refuses an empty rename', () => {
    const id = s().create('Recce').id!;
    expect(s().rename(id, '   ')).toBe('empty');
    expect(s().albums[0].name).toBe('Recce');
  });
});

describe('fileAlbumStore — deleting an album never deletes files', () => {
  it('unfiles the album items and leaves every other album alone', () => {
    const a = s().create('Recce').id!;
    const b = s().create('Contracts').id!;
    s().move(['m1', 'm2'], a);
    s().move(['m3'], b);

    expect(s().remove(a)).toBeNull();

    expect(s().albums.map(x => x.id)).toEqual([b]);
    // m1/m2 are UNFILED — still listed, just not in a folder.
    expect(s().assignments).toEqual({m3: b});
    expect(itemsInAlbum(s(), null, ['m1', 'm2', 'm3'])).toEqual(['m1', 'm2']);
    expect(itemsInAlbum(s(), b, ['m1', 'm2', 'm3'])).toEqual(['m3']);
  });

  it('refuses an unknown album id', () => {
    s().create('Recce');
    expect(s().remove('alb_nope')).toBe('not_found');
    expect(s().albums).toHaveLength(1);
  });
});

describe('fileAlbumStore — moving a multi-selection', () => {
  it('files a whole selection at once', () => {
    const id = s().create('Recce').id!;
    expect(s().move(['m1', 'm2', 'm3'], id)).toBeNull();
    expect(s().assignments).toEqual({m1: id, m2: id, m3: id});
    expect(albumCounts(s(), ['m1', 'm2', 'm3']).get(id)).toBe(3);
  });

  it('moving to null UNFILES, it does not delete', () => {
    const id = s().create('Recce').id!;
    s().move(['m1', 'm2'], id);
    expect(s().move(['m1'], null)).toBeNull();

    expect(albumOf(s(), 'm1')).toBeNull();
    expect(albumOf(s(), 'm2')).toBe(id);
    expect(itemsInAlbum(s(), null, ['m1', 'm2'])).toEqual(['m1']);
  });

  it('one album per item — a second move REPLACES the first', () => {
    const a = s().create('Recce').id!;
    const b = s().create('Contracts').id!;
    s().move(['m1'], a);
    s().move(['m1'], b);

    expect(albumOf(s(), 'm1')).toBe(b);
    expect(albumCounts(s(), ['m1']).get(a)).toBe(0);
    expect(albumCounts(s(), ['m1']).get(b)).toBe(1);
  });

  it('refuses a move into an album that does not exist, writing nothing', () => {
    s().create('Recce');
    const before = s().assignments;
    expect(s().move(['m1'], 'alb_ghost')).toBe('not_found');
    expect(s().assignments).toBe(before);
    expect(albumOf(s(), 'm1')).toBeNull();
  });

  it('an empty selection is a harmless no-op', () => {
    const id = s().create('Recce').id!;
    expect(s().move([], id)).toBeNull();
    expect(s().assignments).toEqual({});
  });
});

describe('fileAlbumStore — prune keeps the map from growing forever', () => {
  it('drops assignments whose message is gone and keeps the rest', () => {
    const id = s().create('Recce').id!;
    s().move(['m1', 'm2', 'm3'], id);

    s().prune(['m1', 'm3']);          // m2's message was deleted / expired

    expect(s().assignments).toEqual({m1: id, m3: id});
  });

  /**
   * The guard the module comment is about. `prune` is called from the Files
   * list, so an unconditional `set` publishes a new object on every pass and
   * re-renders the list forever. Counting subscriber emissions is the only way
   * to see this — the state VALUE is identical either way.
   */
  it('does NOT publish an update when nothing changed', () => {
    const id = s().create('Recce').id!;
    s().move(['m1', 'm2'], id);

    const seen = jest.fn();
    const unsub = useFileAlbumStore.subscribe(seen);

    s().prune(['m1', 'm2']);
    expect(seen).not.toHaveBeenCalled();

    s().prune(['m1']);                 // now something really changed
    expect(seen).toHaveBeenCalledTimes(1);
    unsub();
  });

  it('pruning to nothing empties the map but keeps the folders', () => {
    const id = s().create('Recce').id!;
    s().move(['m1'], id);

    s().prune([]);

    expect(s().assignments).toEqual({});
    expect(s().albums.map(a => a.id)).toEqual([id]);
  });
});

describe('fileAlbumStore — reset and persistence', () => {
  it('reset clears albums and assignments together', () => {
    const id = s().create('Recce').id!;
    s().move(['m1'], id);

    s().reset();

    expect(s().albums).toEqual([]);
    expect(s().assignments).toEqual({});
  });

  /**
   * Folders have to survive a restart — they are the user's organisation of a
   * list they do not otherwise control. `partialize` is what decides that, and
   * dropping either field would lose every folder on the next launch.
   */
  it('persists albums AND assignments, so folders survive a restart', async () => {
    const id = s().create('Contracts').id!;
    s().move(['m1'], id);
    await Promise.resolve();

    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    const raw = await AsyncStorage.getItem('bravo-file-albums-v1');
    expect(raw).toBeTruthy();
    const persisted = JSON.parse(raw).state;
    expect(persisted.albums).toEqual([{id, name: 'Contracts', createdAt: expect.any(Number)}]);
    expect(persisted.assignments).toEqual({m1: id});
  });
});
