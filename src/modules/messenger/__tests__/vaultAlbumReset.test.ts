/**
 * Vault albums are wiped BY the vault wipe — not merely alongside it.
 *
 * Founder 2026-08-08 asked for albums in Files and Vault. The security-relevant
 * half is where the vault's album NAMES live. "Contracts", "Licences",
 * "Site Recce — Jebel Ali" are as disclosing as the filenames next to them, so
 * they belong inside `vaultStore`'s persisted blob and must die with
 * `reset()` — the "Forgot PIN" wipe. A separate album store would outlive that
 * wipe and leave the names readable on a device whose vault the user believes
 * they cleared.
 *
 * This is exactly the B-339 class the founder's standing rule names: for every
 * piece of state a change adds, enumerate what wipes it. Pinned here because no
 * screen test can see it and a source scan would only prove the field is listed.
 */
// The node project has no AsyncStorage; zustand's persist middleware writes on
// every set. Repo pattern (adhocCallKeyLookup.test.ts et al).
jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem:    async (k: string) => store.get(k) ?? null,
      setItem:    async (k: string, v: string) => { store.set(k, v); },
      removeItem: async (k: string) => { store.delete(k); },
      clear:      async () => { store.clear(); },
    },
  };
});

import {useVaultStore} from '../vault/vaultStore';

const KEY_A = 'vault/obj-a';
const KEY_B = 'vault/obj-b';

/** A VaultFile good enough for addFile's M-02 key-material check. */
function file(objectKey: string) {
  return {
    objectKey,
    keyB64:    'a2V5',
    ivB64:     'aXY=',
    name:      objectKey,
    size:      10,
    mimeType:  'image/jpeg',
    createdAt: 1,
  };
}

beforeEach(() => {
  useVaultStore.getState().reset();
});

describe('vault albums live and die with the vault', () => {
  it('creates an album and files vault objects into it', () => {
    const st = useVaultStore.getState();
    st.addFile(file(KEY_A));
    st.addFile(file(KEY_B));

    const {id, error} = useVaultStore.getState().createVaultAlbum('Contracts');
    expect(error).toBeNull();
    expect(id).not.toBeNull();

    expect(useVaultStore.getState().moveToVaultAlbum([KEY_A, KEY_B], id)).toBeNull();
    expect(useVaultStore.getState().albumState.assignments).toEqual({[KEY_A]: id, [KEY_B]: id});
  });

  it('reset() destroys the album NAMES, not just the files', () => {
    const st = useVaultStore.getState();
    st.addFile(file(KEY_A));
    const {id} = useVaultStore.getState().createVaultAlbum('Contracts');
    useVaultStore.getState().moveToVaultAlbum([KEY_A], id);

    // Sanity: the name really is in the store before the wipe, otherwise the
    // assertion below passes vacuously.
    expect(useVaultStore.getState().albumState.albums.map(a => a.name)).toEqual(['Contracts']);

    useVaultStore.getState().reset();

    const after = useVaultStore.getState();
    expect(after.files).toEqual([]);
    expect(after.albumState.albums).toEqual([]);
    expect(after.albumState.assignments).toEqual({});
    // The word must be gone from the state entirely.
    expect(JSON.stringify(after.albumState)).not.toContain('Contracts');
  });

  it('is PERSISTED beside files, so a restart cannot resurrect one without the other', () => {
    // Both are in `partialize`; asserting the pairing here means a future edit
    // that persists files but drops albums (or vice versa) fails.
    const persisted = (useVaultStore.persist.getOptions().partialize?.(
      useVaultStore.getState() as never,
    ) ?? {}) as Record<string, unknown>;
    expect(Object.keys(persisted)).toContain('files');
    expect(Object.keys(persisted)).toContain('albumState');
  });

  it('deleting a vault album UNFILES its objects — it never deletes a file', () => {
    const st = useVaultStore.getState();
    st.addFile(file(KEY_A));
    const {id} = useVaultStore.getState().createVaultAlbum('Licences');
    useVaultStore.getState().moveToVaultAlbum([KEY_A], id);

    expect(useVaultStore.getState().deleteVaultAlbum(id!)).toBeNull();

    const after = useVaultStore.getState();
    expect(after.albumState.albums).toEqual([]);
    expect(after.albumState.assignments).toEqual({});
    // THE FILE SURVIVES.
    expect(after.files.map(f => f.objectKey)).toEqual([KEY_A]);
  });

  it('removing a vault FILE drops its assignment, so counts cannot drift', () => {
    const st = useVaultStore.getState();
    st.addFile(file(KEY_A));
    st.addFile(file(KEY_B));
    const {id} = useVaultStore.getState().createVaultAlbum('Contracts');
    useVaultStore.getState().moveToVaultAlbum([KEY_A, KEY_B], id);

    useVaultStore.getState().removeFile(KEY_A);

    const after = useVaultStore.getState();
    expect(after.files.map(f => f.objectKey)).toEqual([KEY_B]);
    // A dead assignment here would persist forever and keep inflating the count.
    expect(after.albumState.assignments).toEqual({[KEY_B]: id});
  });

  it('rejects a duplicate album name case-insensitively', () => {
    useVaultStore.getState().createVaultAlbum('Contracts');
    expect(useVaultStore.getState().createVaultAlbum('contracts').error).toBe('duplicate');
    expect(useVaultStore.getState().albumState.albums).toHaveLength(1);
  });

  it('vault albums are a SEPARATE space from Files albums', () => {
    // Founder decision: the two never mix. Creating a vault album must not
    // touch the Files album store, or a Files album name could hint at vault
    // contents (and vice versa).
    const {useFileAlbumStore} = require('../fileAlbums/fileAlbumStore') as
      typeof import('../fileAlbums/fileAlbumStore');
    useFileAlbumStore.getState().reset();

    useVaultStore.getState().createVaultAlbum('Contracts');

    expect(useFileAlbumStore.getState().albums).toEqual([]);
  });
});
