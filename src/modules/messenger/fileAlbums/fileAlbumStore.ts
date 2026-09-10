/**
 * Album state for the FILES tab (chat attachments), persisted locally.
 *
 * Separate from the Vault's albums by design (founder 2026-08-08) — see the
 * docblock in `fileAlbums.ts`. Vault album state lives inside `vaultStore`'s
 * persisted blob instead of here, so `vaultStore.reset()` wipes vault album
 * NAMES along with the vault file list; a shared store would outlive that wipe
 * and leave "Contracts" and "Licences" readable after the vault was cleared.
 *
 * Holds assignments only, never bytes. The Files tab is a VIEW over messages,
 * so the file a row points at can vanish (message deleted, chat cleared,
 * disappearing message expired) without this store being told — which is why
 * every read goes through `fileAlbums.ts`'s existence-aware helpers and why
 * `prune` exists.
 */
import {create} from 'zustand';
import {persist, createJSONStorage} from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  EMPTY_ALBUM_STATE,
  createAlbum, renameAlbum, deleteAlbum, moveToAlbum, pruneAssignments,
  type AlbumState, type AlbumError,
} from './fileAlbums';

/**
 * Ids are generated here rather than in the pure layer so the rules stay
 * deterministic under test. Not security-relevant: an album id is a local
 * grouping key, never a token — `Math.random` is adequate and the timestamp
 * prefix keeps ids sortable and collision-resistant in practice.
 */
function newAlbumId(): string {
  return `alb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

interface FileAlbumActions {
  /** Returns the new album's id, or an error the caller renders inline. */
  create: (name: string) => {id: string | null; error: AlbumError | null};
  rename: (id: string, name: string) => AlbumError | null;
  /** Deletes the album and UNFILES its items. Never deletes a file. */
  remove: (id: string) => AlbumError | null;
  /** Move a multi-selection. `albumId: null` unfiles. */
  move: (itemIds: readonly string[], albumId: string | null) => AlbumError | null;
  /** Drop assignments whose message no longer exists. */
  prune: (existingItemIds: readonly string[]) => void;
  reset: () => void;
}

export const useFileAlbumStore = create<AlbumState & FileAlbumActions>()(
  persist(
    (set, get) => ({
      ...EMPTY_ALBUM_STATE,

      create: (name) => {
        const id = newAlbumId();
        const {state, error} = createAlbum(get(), name, id, Date.now());
        if (error) {return {id: null, error};}
        set({albums: state.albums, assignments: state.assignments});
        return {id, error: null};
      },

      rename: (id, name) => {
        const {state, error} = renameAlbum(get(), id, name);
        if (!error) {set({albums: state.albums, assignments: state.assignments});}
        return error;
      },

      remove: (id) => {
        const {state, error} = deleteAlbum(get(), id);
        if (!error) {set({albums: state.albums, assignments: state.assignments});}
        return error;
      },

      move: (itemIds, albumId) => {
        const {state, error} = moveToAlbum(get(), itemIds, albumId);
        if (!error) {set({albums: state.albums, assignments: state.assignments});}
        return error;
      },

      prune: (existingItemIds) => {
        const next = pruneAssignments(get(), existingItemIds);
        // Referential equality when nothing changed — this runs off the Files
        // list, so setting unconditionally would re-render it on every pass.
        if (next !== (get() as AlbumState)) {set({assignments: next.assignments});}
      },

      reset: () => set({...EMPTY_ALBUM_STATE}),
    }),
    {
      name: 'bravo-file-albums-v1',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: s => ({albums: s.albums, assignments: s.assignments}),
    },
  ),
);
