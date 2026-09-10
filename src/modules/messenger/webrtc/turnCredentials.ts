/**
 * TURN credential cache + pre-warm (audit Step 2.1, B-601 / B-598).
 *
 * WHY: `GET /webrtc/turn-credentials` was fetched PER CallScreen mount and per
 * group boot, uncached, on the critical path — measured at 164/300/442 ms on
 * staging, i.e. 46–76 % of the caller's time-to-offer, and on the notification
 * answer lane it is what the controller waits for before it can exist. The
 * server issues 24-hour credentials and returns their `expiresAt`, so a single
 * fetch serves every call for the session; a `prewarmIceServers()` fired while
 * the phone is still ringing (or at boot / foreground / on the incoming frame)
 * makes the tap-time fetch a cache hit.
 *
 * This module is the SINGLE SOURCE of TURN creds for the 1:1 and group paths.
 * It has no React and no imports at module scope (lazy `require` for the api
 * layer, matching the repo's pattern, so it stays node-loadable by the
 * messenger-crypto Jest project and free of a circular import with the store).
 *
 * Contract, deliberately narrow:
 *  - `getIceServers({ceilingMs})` resolves cached creds while they are fresh
 *    (> FRESH_MARGIN_MS before `expiresAt`), else races a fresh fetch against
 *    `ceilingMs` and returns STUN-only if the fetch does not beat the ceiling.
 *    The fetch is SINGLE-FLIGHT and keeps running past a lost race, so the
 *    NEXT caller gets real creds even when this one fell back to STUN.
 *  - a STUN-only fallback is NEVER cached — the next call retries.
 *  - `prewarmIceServers()` is fire-and-forget (swallows errors).
 *  - `invalidateIceServers()` drops the cache AND fences any in-flight fetch
 *    (epoch guard) so a signOut / 401 cannot repopulate creds for a dead
 *    session.
 */
import type {IceServerConfig} from './types';

// Don't serve creds within 30 min of expiry: a call admitted just under the
// margin must not lose TURN mid-call when coturn starts rejecting the expired
// HMAC timestamp. Real creds are valid 24 h, so a refetch is nearly free.
const FRESH_MARGIN_MS = 30 * 60_000;
const PUBLIC_STUN = 'stun:stun.l.google.com:19302';
const stunOnly = (): IceServerConfig[] => [{urls: PUBLIC_STUN}]; // fresh array + element every call

interface CachedTurn { ice: IceServerConfig[]; expiresAtMs: number }

let cache: CachedTurn | null = null;
// The in-flight fetch is stamped with the epoch it STARTED under; a stale-epoch
// inflight (a fetch from a signed-out session) is never reused or cached.
let inflight: {epoch: number; p: Promise<CachedTurn>} | null = null;
// Bumped by invalidateIceServers(); a fetch only writes the cache / is reused
// if the epoch it started under is still current (signOut / 401 cannot
// resurrect a previous user's creds).
let epoch = 0;

function turnEndpoint(): string {
  const {MSG_BASE_URL} = require('@utils/constants') as typeof import('@utils/constants');
  return `${MSG_BASE_URL}/webrtc/turn-credentials`;
}

/** The raw fetch + parse, verbatim from the old CallScreen block (device-id header, fetchWithRefresh, STUN unshift). Throws on any failure. */
async function fetchRealCreds(): Promise<CachedTurn> {
  const startEpoch = epoch;
  // fetchWithRefresh drives the SAME single-flight /auth/refresh the axios
  // interceptor uses — a TURN fetch on a stale access token refreshes instead
  // of silently falling back to STUN (the original CallScreen rationale).
  const {fetchWithRefresh} = require('@/services/api') as typeof import('@/services/api');
  // The relay's JwtHttpGuard requires X-Signal-Device-Id (Phase-1 single
  // device → always "1"); omitting it produced the old `turn 400`.
  const res = await fetchWithRefresh(turnEndpoint(), {headers: {'X-Signal-Device-Id': '1'}});
  if (!res.ok) {throw new Error(`turn ${res.status}`);}
  const body = await res.json() as {urls: string[]; username: string; credential: string; expiresAt?: number};
  // Defensive STUN as a SEPARATE auth-free entry so the engine always gets
  // srflx even when TURN is bricked (the original CallScreen rationale).
  const hasStun = body.urls.some(u => u.startsWith('stun:') || u.startsWith('stuns:'));
  const ice: IceServerConfig[] = [{urls: body.urls, username: body.username, credential: body.credential}];
  if (!hasStun) {ice.unshift({urls: PUBLIC_STUN});}
  // `expiresAt` is unix SECONDS (turn.service issueCredentials). A server that
  // predates the field caches for a conservative 10 min — the real creds are
  // valid 24 h, so this only bounds how long we trust a value we can't date.
  const expiresAtMs = body.expiresAt ? body.expiresAt * 1000 : Date.now() + 10 * 60_000;
  const result: CachedTurn = {ice, expiresAtMs};
  if (epoch === startEpoch) {cache = result;}   // fence: signOut/invalidate during the fetch discards it
  return result;
}

function ensureInflight(): Promise<CachedTurn> {
  // A fetch started before an invalidate belongs to a dead session — never
  // reuse it (P1: signOut→signIn must not serve the previous user's creds).
  if (inflight && inflight.epoch !== epoch) {inflight = null;}
  if (!inflight) {
    const startEpoch = epoch;
    const p = fetchRealCreds().finally(() => {
      // Only the CURRENT inflight clears the slot — a stale fetch's finally
      // must not clobber a newer fetch started after an invalidate.
      if (inflight && inflight.p === p) {inflight = null;}
    });
    inflight = {epoch: startEpoch, p};
  }
  return inflight.p;
}

/**
 * Fresh cached creds, or a fetch bounded by `ceilingMs` (STUN-only on a miss).
 * The single-flight fetch survives a lost race and caches for the next caller.
 */
export async function getIceServers(opts: {ceilingMs: number}): Promise<IceServerConfig[]> {
  const now = Date.now();
  if (cache && cache.expiresAtMs - now > FRESH_MARGIN_MS) {return cache.ice;}
  const fetchP = ensureInflight();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ceiling = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`turn fetch ceiling (${opts.ceilingMs}ms) — STUN fallback`)), opts.ceilingMs);
  });
  try {
    const r = await Promise.race([fetchP, ceiling]);
    return r.ice;
  } catch (e) {
    // Ceiling hit or the fetch failed: STUN-only for THIS call (NOT cached — a
    // healthy in-flight fetch will still cache real creds for the next one).
    // Keep the diagnostic the old CallScreen block had (no creds, message only).
    console.warn('[turnCredentials] no TURN creds — STUN-only fallback (host/srflx via iceTransportPolicy=all):', (e as Error)?.message ?? e);
    return stunOnly();
  } finally {
    if (timer) {clearTimeout(timer);}
  }
}

/** Fire-and-forget warm-up: kick the fetch (or no-op on a fresh cache) so a later getIceServers is a hit. */
export function prewarmIceServers(): void {
  const now = Date.now();
  if (cache && cache.expiresAtMs - now > FRESH_MARGIN_MS) {return;}
  // Swallow: a warm-up must never surface an error or an unhandled rejection.
  void ensureInflight().catch(() => { /* the real call will retry + fall back to STUN */ });
}

/** Drop the cache and fence any in-flight fetch. Call on signOut and on a 401/403 that clears tokens. */
export function invalidateIceServers(): void {
  cache = null;
  epoch += 1;
}

/** Test seam. */
export function _resetTurnCredentialsForTest(): void {
  cache = null;
  inflight = null;
  epoch = 0;
}
