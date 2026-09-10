/**
 * Albums — user-created folders for organising Files and Vault items.
 *
 * Founder 2026-08-08: "Inside the Files and Vault we must be able to create
 * albums in order to organise all the images. So option to create album must
 * exist and option to select multiple images and move them into the folders."
 *
 * PURE decision layer, effects and storage injected — the same shape as
 * `screens/messenger/filesMultiSelect.ts`, so the rules are testable without
 * mounting RN and without a store.
 *
 * TWO INDEPENDENT SPACES, not one (founder decision 2026-08-08). Files albums
 * and Vault albums never mix:
 *
 *   - a Files album groups CHAT ATTACHMENTS, which still live in their
 *     conversations;
 *   - a Vault album groups VAULT OBJECTS, which are MFA-gated.
 *
 * Sharing one list would put two different security states inside one folder
 * and let a Files album name hint at vault contents. This module is the shared
 * LOGIC; the two callers own separate state. Vault album state deliberately
 * lives inside `vaultStore`'s persisted blob so `vaultStore.reset()` wipes the
 * album names with the file list — a separate store could outlive the wipe and
 * leave "Contracts" and "Licences" readable after the vault was cleared.
 *
 * An album NEVER owns bytes. It is an assignment from item id to album id, so
 * deleting an album cannot delete a file, and an item whose underlying file has
 * gone is simply an ORPHANED assignment — invisible, because every read here is
 * existence-aware (`itemsInAlbum`, `albumCounts` and `albumOf` all check the
 * live id set), and worth a few bytes.
 *
 * B-451 / B-452 — orphans are therefore collected by EVENT, at the moment a
 * file is knowingly destroyed (`move(ids, null)` at the delete site), never by
 * sweeping a view. See `pruneAssignments` for why a view may not authorise it.
 */

export interface Album {
  id:        string;
  name:      string;
  createdAt: number;
}

export interface AlbumState {
  albums: Album[];
  /** itemId → albumId. An id that is absent is UNFILED; that is the default. */
  assignments: Readonly<Record<string, string>>;
}

export const EMPTY_ALBUM_STATE: AlbumState = {albums: [], assignments: {}};

/** Long enough for "Site Recce — Jebel Ali, Feb", short enough to render. */
export const MAX_ALBUM_NAME = 40;

export type AlbumError =
  | 'empty'          // nothing but whitespace
  | 'too_long'
  | 'duplicate'      // case-insensitive clash with an existing album
  | 'not_found';

export interface AlbumResult {
  state: AlbumState;
  error: AlbumError | null;
}

const ok = (state: AlbumState): AlbumResult => ({state, error: null});
const fail = (state: AlbumState, error: AlbumError): AlbumResult => ({state, error});

/** Trim and collapse inner whitespace so " Site   Recce " and "Site Recce" clash. */
export function normaliseName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

function nameTaken(state: AlbumState, name: string, exceptId?: string): boolean {
  const key = name.toLowerCase();
  return state.albums.some(a => a.id !== exceptId && a.name.toLowerCase() === key);
}

/**
 * `id` and `now` are injected rather than generated here — this module stays
 * pure so the tests are deterministic, and `Date.now()`/random id generation
 * are the caller's business.
 */
export function createAlbum(state: AlbumState, rawName: string, id: string, now: number): AlbumResult {
  const name = normaliseName(rawName);
  if (!name) {return fail(state, 'empty');}
  if (name.length > MAX_ALBUM_NAME) {return fail(state, 'too_long');}
  if (nameTaken(state, name)) {return fail(state, 'duplicate');}
  return ok({...state, albums: [...state.albums, {id, name, createdAt: now}]});
}

export function renameAlbum(state: AlbumState, id: string, rawName: string): AlbumResult {
  const name = normaliseName(rawName);
  if (!state.albums.some(a => a.id === id)) {return fail(state, 'not_found');}
  if (!name) {return fail(state, 'empty');}
  if (name.length > MAX_ALBUM_NAME) {return fail(state, 'too_long');}
  // Renaming an album to the name it already has is a no-op, not a duplicate.
  if (nameTaken(state, name, id)) {return fail(state, 'duplicate');}
  return ok({...state, albums: state.albums.map(a => (a.id === id ? {...a, name} : a))});
}

/**
 * Delete the album and UNFILE its items. It must never look like a way to
 * delete files: the assignments go, the items stay and reappear as Unfiled.
 */
export function deleteAlbum(state: AlbumState, id: string): AlbumResult {
  if (!state.albums.some(a => a.id === id)) {return fail(state, 'not_found');}
  const assignments: Record<string, string> = {};
  for (const [itemId, albumId] of Object.entries(state.assignments)) {
    if (albumId !== id) {assignments[itemId] = albumId;}
  }
  return ok({albums: state.albums.filter(a => a.id !== id), assignments});
}

/**
 * File items into an album, or UNFILE them with `albumId = null`.
 *
 * One album per item — the founder asked for folders, and a file in two places
 * at once makes "move" ambiguous and counts double.
 */
export function moveToAlbum(
  state: AlbumState,
  itemIds: readonly string[],
  albumId: string | null,
): AlbumResult {
  if (albumId !== null && !state.albums.some(a => a.id === albumId)) {
    return fail(state, 'not_found');
  }
  const assignments = {...state.assignments};
  for (const itemId of itemIds) {
    if (albumId === null) {delete assignments[itemId];}
    else {assignments[itemId] = albumId;}
  }
  return ok({...state, assignments});
}

/** The album an item is filed under, or null when it is Unfiled. */
export function albumOf(state: AlbumState, itemId: string): string | null {
  return state.assignments[itemId] ?? null;
}

/**
 * Item ids in an album. `albumId = null` means UNFILED, which includes every
 * id whose assignment points at an album that no longer exists — otherwise a
 * torn state would hide files from every view at once.
 */
export function itemsInAlbum(
  state: AlbumState,
  albumId: string | null,
  allItemIds: readonly string[],
): string[] {
  const live = new Set(state.albums.map(a => a.id));
  return allItemIds.filter(id => {
    const assigned = state.assignments[id];
    const effective = assigned && live.has(assigned) ? assigned : null;
    return effective === albumId;
  });
}

/**
 * Counts for the album bar, plus the Unfiled bucket under the `null` key.
 * Counted against the items that ACTUALLY EXIST, so a deleted chat file stops
 * being counted immediately rather than when the next prune happens.
 */
export function albumCounts(
  state: AlbumState,
  allItemIds: readonly string[],
): Map<string | null, number> {
  const live = new Set(state.albums.map(a => a.id));
  const counts = new Map<string | null, number>();
  counts.set(null, 0);
  for (const a of state.albums) {counts.set(a.id, 0);}
  for (const id of allItemIds) {
    const assigned = state.assignments[id];
    const key = assigned && live.has(assigned) ? assigned : null;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Drop assignments whose item no longer exists.
 *
 * ONLY CALL THIS WITH THE COMPLETE KEY SPACE. `existingItemIds` is treated as
 * the whole truth — anything absent is DESTROYED and persisted immediately.
 *
 * B-451 / B-452: the Files tab used to call it with `rows`, which is a VIEW
 * over chat messages — empty on a cold boot before SQLCipher hydration, capped
 * at MAX_HYDRATE_PER_CONVO messages per conversation, and filtered to company
 * conversations inside the workspace shell. Every one of those wiped the user's
 * organisation. The Files lane no longer prunes at all; it unfiles by event at
 * the delete site instead, and lets orphans sit (every read here is
 * existence-aware, so an orphan is invisible).
 *
 * The remaining caller is `vaultStore`, where the vault's own `files` array IS
 * the complete key space by construction.
 */
export function pruneAssignments(state: AlbumState, existingItemIds: readonly string[]): AlbumState {
  const live = new Set(existingItemIds);
  const assignments: Record<string, string> = {};
  let changed = false;
  for (const [itemId, albumId] of Object.entries(state.assignments)) {
    if (live.has(itemId)) {assignments[itemId] = albumId;}
    else {changed = true;}
  }
  return changed ? {...state, assignments} : state;
}
