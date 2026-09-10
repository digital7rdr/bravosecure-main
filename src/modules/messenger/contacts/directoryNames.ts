/**
 * B-115 — session directory-name resolver.
 *
 * Anywhere the UI is about to render a raw-id fragment ("encrypted code":
 * `userId.slice(0,8)` etc.) it can consult `directoryNames` in the store
 * and call `ensureDirectoryNames([...])` for the misses — a debounced,
 * deduped, batched `/users/profiles` fetch that writes results into the
 * store map. Precedence is enforced by the CONSUMERS: user custom name >
 * address-book contact name > manual group-member override > directory
 * name (this module) > raw-id fragment (last resort, offline-safe).
 *
 * The module owns its own UsersHttpClient (same config the Home screen
 * uses) so free functions like ChatScreen's `resolveSenderName` can fire
 * a backfill without threading a client through props.
 */
import {UsersHttpClient} from '@bravo/messenger-core';
import {API_BASE_URL} from '@utils/constants';
import {useMessengerStore} from '../store/messengerStore';

let client: UsersHttpClient | null = null;
function getClient(): UsersHttpClient {
  if (!client) {
    const {tokenStore} = require('@services/api') as typeof import('@services/api');
    client = new UsersHttpClient({
      baseUrl:      API_BASE_URL,
      getToken:     () => tokenStore.get(),
      refreshToken: () => (require('@services/api') as typeof import('@services/api')).refreshAccessTokenShared(),
    });
  }
  return client;
}

/** Exposed for hooks that want the shared client (e.g. a global useRegisteredNames mount). */
export function getDirectoryUsersClient(): UsersHttpClient {
  return getClient();
}

// Session-scoped attempt cache: ids we already queried (resolved OR unknown)
// are never re-fetched, so a stranger not on the directory can't trigger a
// fetch per render.
const attempted = new Set<string>();
let pending = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_DEBOUNCE_MS = 300;
// AUDIT-2026-08-13 F7 — ids currently ON THE WIRE. `attempted` is only
// stamped after a flush RESOLVES, so between the flush draining
// `pending` and the response landing, a re-render's ensure() re-queued
// the same ids and fired a duplicate fetch. Failure still clears these,
// preserving the retry-on-recovery contract.
const inFlight = new Set<string>();

async function flush(): Promise<void> {
  const ids = Array.from(pending);
  pending = new Set();
  flushTimer = null;
  if (ids.length === 0) {return;}
  for (const id of ids) {inFlight.add(id);}
  try {
    const profiles = await getClient().getProfilesByIds(ids);
    for (const id of ids) {attempted.add(id);}
    const entries: Record<string, string> = {};
    // B-253 — the response has ALWAYS carried avatarUrl and this function has
    // always dropped it on the floor, so every surface except ChatInfoScreen
    // (which kept a private copy of the very same fetch) had no avatar source
    // and drew an initials disc for users who do have a photo. One request
    // resolves both; keep both.
    const avatars: Record<string, string | null> = {};
    for (const p of profiles) {
      if (p.displayName) {entries[p.userId] = p.displayName;}
      avatars[p.userId] = p.avatarUrl;
    }
    if (Object.keys(entries).length > 0) {
      useMessengerStore.getState().setDirectoryNames(entries);
    }
    if (Object.keys(avatars).length > 0) {
      useMessengerStore.getState().setDirectoryAvatars(avatars);
    }
  } catch {
    // Best-effort: leave ids un-attempted so a later call retries once
    // the network / token recovers.
  } finally {
    for (const id of ids) {inFlight.delete(id);}
  }
}

/**
 * Queue userIds for a batched directory lookup. Fire-and-forget — safe to
 * call from render-path helpers (the store update triggers a re-render
 * that picks the resolved name up).
 */
export function ensureDirectoryNames(userIds: string[]): void {
  for (const id of userIds) {
    if (!id || id === 'self') {continue;}
    // B-253 — the dedupe used to ALSO skip any id whose display name we
    // happened to know already (`directoryNames[id]`). Names arrive from
    // several places that carry no photo — group metadata, the address book,
    // manual overrides — so that short-circuit permanently starved the avatar
    // for exactly the users we know best. `attempted` is the real
    // once-per-session guard; it is set for every id in a flush whether or not
    // the profile resolved, so dropping the name check costs at most one extra
    // batched request and never loops.
    if (attempted.has(id) || pending.has(id) || inFlight.has(id)) {continue;}
    pending.add(id);
  }
  if (pending.size === 0) {return;}
  if (!flushTimer) {
    flushTimer = setTimeout(() => { void flush(); }, FLUSH_DEBOUNCE_MS);
  }
}

/** Test hook — clears session caches. */
export function _resetDirectoryNamesForTests(): void {
  attempted.clear();
  pending = new Set();
  inFlight.clear();
  if (flushTimer) {clearTimeout(flushTimer); flushTimer = null;}
  client = null;
}

// Why: B-304 — the 300ms debounce above outlives any suite that finishes
// faster than it, then fires after Jest tears the environment down and
// fails an unrelated bystander suite. `jest.setup.messenger-crypto.js`
// drains this registry in a global afterEach. Registering here, rather
// than having that setup file import this module, keeps the cost
// proportional: only a suite that actually loads directoryNames pays,
// instead of all 429 paying ~19s to pull in @utils/constants and
// messengerStore (measured — that tax starves safetyNumber.test.ts into
// a timeout). No-op outside that Jest project: nothing else defines the
// global.
(globalThis as {__bravoTestCleanups?: Set<() => void>}).__bravoTestCleanups
  ?.add(_resetDirectoryNamesForTests);
