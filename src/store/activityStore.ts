import {create} from 'zustand';
import {persist} from 'zustand/middleware';
import {makeDebouncedJsonStorage} from './debouncedJsonStorage';

/**
 * activityStore (BUILD_RUNBOOK Step 18 / B2) — the durable, locally-persisted notifications
 * inbox that turns opaque FCM wakes into glanceable, actionable history. The push payload
 * stays content-free ({userId, eventClass, eventId}, P0-N8); on each wake the app fetches
 * detail from the existing JWT-gated endpoints and `append()`s a row here — exactly as chat
 * hydrates on a wake. Rows carry ONLY non-sensitive metadata (never a message body or key).
 *
 * Identity-scoped like the messenger store: `setOwner(key)` wipes the feed when a DIFFERENT
 * identity signs in on the same device, so one user never sees another's activity. Dedupe is
 * by `eventId` so a re-delivered wake doesn't double-row.
 */
export type ActivityClass = 'booking' | 'dispatch' | 'mission' | 'payout' | 'sos' | 'agent' | 'incident' | 'enterprise';

export interface ActivityRowData {
  /** eventId — the dedupe key (opaque id from the push wake). */
  id: string;
  eventClass: ActivityClass;
  /** Specific kind, e.g. 'dispatch-offer' | 'provider-accepted' | 'no-provider'. */
  kind: string;
  title: string;
  subtitle?: string;
  /** ISO timestamp the row was recorded. */
  ts: string;
  read: boolean;
  /** Deep-link targets (resolved by the Bell/row tap). */
  bookingId?: string;
  missionId?: string;
  /** vs2 item 16 — lets a bell row open the incident, not just a list. */
  incidentId?: string;
  /** vs2 edge A1/A2 — which org the row is about, so a multi-org tap scopes
   *  the workspace surface before the target screen reads. */
  orgId?: string;
  /** For an actionable offer row — drives the CountdownPill. */
  expiresAt?: string;
}

const MAX_ROWS = 200; // cap the local feed so it can't grow unbounded
// B-706 A-3 — how many dismissed ids we remember locally. Bounded because it is a
// belt-and-braces ledger: the server's `dismissed_at` is the durable authority, and this
// only has to outlive the window between an offline Clear and the dismiss POST landing.
const MAX_DISMISSED = 500;

/** What a caller supplies to append/appendMany: `ts` defaults to now, `read` to false. */
export type ActivityRowInput = Omit<ActivityRowData, 'ts' | 'read'> & {ts?: string; read?: boolean};

/** Sort key. An unparseable/absent `ts` sorts to the BOTTOM rather than poisoning the
 *  comparator with NaN (which would leave the array in an engine-defined order). */
function tsOrder(iso: string): number {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : -Infinity;
}

/**
 * B-706 A-1 — merge incoming rows into the feed, keeping it NEWEST-FIRST.
 *
 * The old shape was `[next, ...rows]` per row. The server backfill returns
 * `ORDER BY created_at DESC`, so prepending each row of that page REVERSED it and the
 * feed rendered oldest-first (the founder's screenshot: July rows on top, his newest 5
 * days old and below the fold). Ordering is now an invariant of the store, so it holds
 * for ANY insertion order — live FCM rows, a backfill page, or the two interleaved —
 * and every surface reading `rows` (screen, drawer, badge) agrees.
 *
 * Returns the SAME array reference when nothing actually changed, so the recurring
 * no-op re-append (A-2: the ms-truncated watermark re-delivers the newest row on every
 * sync) costs no re-render and no persist write.
 */
function mergeRows(
  current: ActivityRowData[],
  incoming: ActivityRowInput[],
  dismissed?: readonly string[],
): ActivityRowData[] {
  const byId = new Map<string, number>();
  for (let i = 0; i < current.length; i++) {byId.set(current[i].id, i);}
  const tombstoned = dismissed && dismissed.length > 0 ? new Set(dismissed) : null;

  let next: ActivityRowData[] | null = null; // copy-on-write
  let added = false;

  for (const row of incoming) {
    // B-706 A-3 — a row the user cleared must not be re-minted by a backfill. The server
    // filters `dismissed_at` too; this is the half that survives an OFFLINE clear, a
    // failed dismiss POST, and an old server. Suppression-only and ids-only, at the
    // upsert — never a delete of anything already stored.
    if (tombstoned?.has(row.id) && byId.get(row.id) === undefined) {continue;}
    const at = byId.get(row.id);
    if (at !== undefined) {
      // Dedupe by id — a re-delivered wake updates in place. `ts` and `read` are the
      // LOCAL truth: re-stamping ts would reshuffle the feed under the user, and
      // re-applying the server's `read:false` would un-read a row they just opened.
      const prev = (next ?? current)[at];
      const merged: ActivityRowData = {...prev, ...row, ts: prev.ts, read: prev.read};
      if (shallowSameRow(prev, merged)) {continue;}
      next = next ?? current.slice();
      next[at] = merged;
      continue;
    }
    next = next ?? current.slice();
    byId.set(row.id, next.length);
    next.push({read: false, ...row, ts: row.ts ?? new Date().toISOString()});
    added = true;
  }

  if (next === null) {return current;} // nothing changed — keep the reference

  // Sort is stable, so equal timestamps keep their relative order. The cap is applied
  // AFTER the sort: capping before it (the old code capped inside the prepend) would
  // evict by insertion order, which — with the page reversed — dropped the NEWEST rows.
  if (added) {next.sort((a, b) => tsOrder(b.ts) - tsOrder(a.ts));}
  return next.length > MAX_ROWS ? next.slice(0, MAX_ROWS) : next;
}

/** Append ids to the tombstone ledger, newest last, de-duped and FIFO-capped. */
function addDismissed(current: string[], ids: string[]): string[] {
  if (ids.length === 0) {return current;}
  const seen = new Set(current);
  const fresh = ids.filter(id => !seen.has(id));
  if (fresh.length === 0) {return current;}
  const next = current.concat(fresh);
  return next.length > MAX_DISMISSED ? next.slice(next.length - MAX_DISMISSED) : next;
}

function shallowSameRow(a: ActivityRowData, b: ActivityRowData): boolean {
  const ka = Object.keys(a) as Array<keyof ActivityRowData>;
  const kb = Object.keys(b) as Array<keyof ActivityRowData>;
  if (ka.length !== kb.length) {return false;}
  for (const k of ka) {if (a[k] !== b[k]) {return false;}}
  return true;
}

interface ActivityState {
  ownerKey: string | null;
  rows: ActivityRowData[];
  /** B-706 A-3 — ids the user cleared, consulted at the upsert so a backfill cannot
   *  re-mint them. Survives an offline Clear and a failed dismiss POST. */
  dismissedIds: string[];
  setOwner: (key: string | null) => void;
  append: (row: ActivityRowInput) => void;
  /** B-706 A-1 — batch form for the server backfill: ONE set() for a whole page
   *  instead of one per row (a 100-row sync fired 100 store commits, so every
   *  subscriber re-rendered 100 times and the debounced persist re-armed 100 times). */
  appendMany: (rows: ActivityRowInput[]) => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
  remove: (id: string) => void;
  /** The USER pressed Clear — records tombstones so a backfill cannot re-mint the rows. */
  clear: () => void;
  /**
   * Drop everything WITHOUT tombstoning — sign-out and identity wipes only.
   *
   * B-706: `clear()` grew tombstones, and sign-out called `clear()`. That would have made
   * a sign-out/sign-in on the SAME account suppress the user's entire history forever
   * (`setOwner` only wipes the ledger when the identity CHANGES). A privacy wipe is not a
   * user deletion, so it must not leave deletion state behind.
   */
  wipeLocal: () => void;
}

export const useActivityStore = create<ActivityState>()(
  persist(
    (set, get) => ({
      ownerKey: null,
      rows: [],
      dismissedIds: [],

      setOwner: key => {
        const prev = get().ownerKey;
        if (prev && key && prev !== key) {
          // Different identity on this device — wipe the previous user's feed. The
          // tombstones go with it: they are that user's deletions, keyed by THEIR ids.
          set({ownerKey: key, rows: [], dismissedIds: []});
        } else {
          set({ownerKey: key ?? prev});
        }
      },

      append: row => {
        set(state => ({rows: mergeRows(state.rows, [row], state.dismissedIds)}));
      },

      appendMany: rows => {
        if (rows.length === 0) {return;}
        set(state => ({rows: mergeRows(state.rows, rows, state.dismissedIds)}));
      },

      // NAV-14 — idempotent: a repeat tap on an already-read row must not pay
      // the row map + persist cycle again (the drawer row has no disabled
      // state, so a rapid mash lands here N times).
      markRead: id => {
        if (!get().rows.some(r => r.id === id && !r.read)) {return;}
        set(state => ({rows: state.rows.map(r => (r.id === id ? {...r, read: true} : r))}));
      },
      markAllRead: () => {
        if (!get().rows.some(r => !r.read)) {return;}
        set(state => ({rows: state.rows.map(r => (r.read ? r : {...r, read: true}))}));
      },
      remove: id => set(state => ({
        rows: state.rows.filter(r => r.id !== id),
        dismissedIds: addDismissed(state.dismissedIds, [id]),
      })),
      // B-706 A-3 — Clear TOMBSTONES what it wipes. Without this the very next sync
      // re-appended the rows the user had just deleted (the A-2 watermark hands the
      // newest one back on every single sync), which is the founder's exact report.
      clear: () => set(state => ({
        rows: [],
        dismissedIds: addDismissed(state.dismissedIds, state.rows.map(r => r.id)),
      })),
      wipeLocal: () => set({rows: [], dismissedIds: []}),
    }),
    {
      name: 'bravo:activity',
      // NAV-14 (2026-08-26 rapid-use audit) — bare createJSONStorage ran a
      // synchronous ≤200-row JSON.stringify + AsyncStorage bridge call on
      // EVERY set() (the exact B-633 shape), paid per tap on a notification
      // row. Same debounced adapter as messengerStore; the ≤500 ms durability
      // window only risks a read-flag, which the server sync reconverges.
      storage: makeDebouncedJsonStorage(500, 'activityStore'),
      // Persist the feed + owner, not transient selectors.
      partialize: state => ({ownerKey: state.ownerKey, rows: state.rows, dismissedIds: state.dismissedIds}),
      // B-706 A-1 — every existing install has a feed persisted in the OLD scrambled
      // order. Sorting only on the next append would leave an upgrading user staring at
      // the same inverted list until a new notification happened to arrive, so re-sort
      // the hydrated slice once. Cheap (≤200 rows, one numeric compare) and idempotent.
      onRehydrateStorage: () => state => {
        if (!state || state.rows.length < 2) {return;}
        const sorted = state.rows.slice().sort((a, b) => tsOrder(b.ts) - tsOrder(a.ts));
        const changed = sorted.some((r, i) => r !== state.rows[i]);
        if (changed) {state.rows = sorted;}
      },
    },
  ),
);

/** Selector: unread count (kept out of state so it never goes stale). */
export function selectUnreadCount(state: {rows: ActivityRowData[]}): number {
  return state.rows.reduce((n, r) => n + (r.read ? 0 : 1), 0);
}

/** Imperative entry point for the push-wake path (and in-app events) to drop a row in
 *  without subscribing to the store. The wake handler fetches detail from the existing
 *  endpoints, then calls this — keeping the FCM payload itself opaque. */
export function recordActivity(row: Omit<ActivityRowInput, 'read'>): void {
  useActivityStore.getState().append(row);
}
