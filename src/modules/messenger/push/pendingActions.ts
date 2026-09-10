/**
 * Durable "headless-deferred actions" queue.
 *
 * Why this exists (audit P1-9 + P1-BR-3):
 *   When Android LMK kills the process, a notification action (inline Reply,
 *   Mark-as-read, or a call Decline) relaunches only the SLIM bundle-entry
 *   notifee handler — the messenger runtime / WS are NOT up, so the action
 *   could previously do nothing (the typed reply was silently discarded; the
 *   caller kept ringing). This module persists such actions to AsyncStorage so
 *   they survive the headless VM and are drained once the runtime is ready
 *   (drain lives in fcmBootstrap: replies/reads go through the runtime outbox,
 *   declines go straight to the server endpoint below).
 *
 * Security: only conversation IDs / user IDs / call IDs are stored — NEVER key
 * material. The reply text IS user plaintext they explicitly typed to send, so
 * it lives here only until the outbox accepts it (cleared on success).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {MSG_BASE_URL} from '@utils/constants';
import {tokenVault} from '@services/tokenVault';

/** B-361 — `peerUserId` (the banner's senderUserId) lets the drain send a 1:1
 *  reply even when the conversation row hasn't hydrated/synced yet; without it
 *  the un-hydrated 1:1 path throws "production mode requires explicit peer
 *  address" forever and every retry stacked another failed bubble. */
export interface PendingReply   { t: 'reply';   id: string; convId: string; text: string; peerUserId?: string; ts: number; }
export interface PendingRead    { t: 'read';    id: string; convId: string; ts: number; }
export interface PendingDecline { t: 'decline'; id: string; callId: string; peerUserId?: string; kind?: 'direct' | 'group'; roomId?: string; ts: number; }
export type PendingAction = PendingReply | PendingRead | PendingDecline;

export type PendingActionInput =
  | Omit<PendingReply, 'id' | 'ts'>
  | Omit<PendingRead, 'id' | 'ts'>
  | Omit<PendingDecline, 'id' | 'ts'>;

const BASE_KEY     = 'bravo:pending-actions:v1';
const MAX_AGE_MS   = 7 * 24 * 60 * 60 * 1000; // stranded entries can't grow forever
const MAX_ENTRIES  = 200;

function keyFor(owner?: string): string {
  return `${BASE_KEY}:${owner?.length ? owner : '_global'}`;
}

async function readKey(key: string): Promise<PendingAction[]> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) {return [];}
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as PendingAction[]) : [];
  } catch { return []; }
}

async function writeKey(key: string, list: PendingAction[]): Promise<void> {
  try {
    if (!list.length) { await AsyncStorage.removeItem(key); return; }
    await AsyncStorage.setItem(key, JSON.stringify(list.slice(-MAX_ENTRIES)));
  } catch { /* durable-best-effort — a failed persist just means the action is lost */ }
}

/**
 * Persist an action. `owner` is the account UUID when resolvable (warm), else
 * omit and it lands in the `_global` bucket — the drain reads both.
 */
export async function enqueuePendingAction(a: PendingActionInput, owner?: string): Promise<void> {
  const key = keyFor(owner);
  const list = await readKey(key);
  const entry = {
    ...a,
    id: `${a.t}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
  } as PendingAction;
  list.push(entry);
  await writeKey(key, list);
}

/** A queued entry tagged with the storage bucket it came from (for removal). */
export type LoadedPendingAction = PendingAction & {__key: string};

/**
 * Load everything drainable for `owner` (its bucket + the `_global` bucket),
 * sweeping entries older than MAX_AGE_MS in passing so a permanently-undrainable
 * action can't strand the queue forever.
 */
export async function loadPendingActions(owner?: string): Promise<LoadedPendingAction[]> {
  const keys = owner?.length ? [keyFor(owner), keyFor(undefined)] : [keyFor(undefined)];
  const now = Date.now();
  const out: LoadedPendingAction[] = [];
  for (const key of keys) {
    const list = await readKey(key);
    const fresh = list.filter(e => now - (e.ts ?? 0) < MAX_AGE_MS);
    if (fresh.length !== list.length) { await writeKey(key, fresh); }
    for (const e of fresh) { out.push({...e, __key: key}); }
  }
  return out;
}

/** Remove a single drained entry (called only on successful dispatch). */
export async function removePendingAction(entry: LoadedPendingAction): Promise<void> {
  const list = await readKey(entry.__key);
  await writeKey(entry.__key, list.filter(e => e.id !== entry.id));
}

// ── Call-decline HTTP sender ────────────────────────────────────────────────
// Used both by the SLIM handler (immediate, headless) and by the drain (pending
// fallback). Reuses the same access-token + signal-device-id headers the push
// register path uses. Server contract: POST /calls/:callId/decline always 200,
// throttled 10/10s — we mirror a light client-side budget so a retry storm on a
// half-dead network can't hammer the box.
let declineWindow: number[] = [];
function throttleOk(): boolean {
  const now = Date.now();
  declineWindow = declineWindow.filter(t => now - t < 10_000);
  if (declineWindow.length >= 10) {return false;}
  declineWindow.push(now);
  return true;
}

export async function sendCallDecline(a: {
  callId: string;
  peerUserId?: string;
  kind?: 'direct' | 'group';
  roomId?: string;
}): Promise<boolean> {
  if (!a.callId) {return false;}
  if (!throttleOk()) {return false;} // over budget → leave queued, retry next drain
  try {
    const {refreshAccessTokenShared} = require('@services/api') as typeof import('@services/api');
    let access = await tokenVault.getAccess();
    if (!access) {
      try { await refreshAccessTokenShared(); } catch { /* fall through */ }
      access = await tokenVault.getAccess();
    }
    if (!access) {return false;}
    const body: Record<string, unknown> = {};
    if (a.peerUserId) {body.peerUserId = a.peerUserId;}
    if (a.kind)       {body.kind = a.kind;}
    if (a.roomId)     {body.roomId = a.roomId;}
    const res = await fetch(`${MSG_BASE_URL}/calls/${encodeURIComponent(a.callId)}/decline`, {
      method:  'POST',
      // signalDeviceId is hardcoded to 1 across the app (Phase-1 single-device).
      headers: {'Content-Type': 'application/json', 'Authorization': `Bearer ${access}`, 'X-Signal-Device-Id': '1'},
      body:    JSON.stringify(body),
    });
    return res.ok;
  } catch { return false; }
}

/** Test-only — reset the in-memory throttle window. */
export function _resetDeclineThrottleForTests(): void { declineWindow = []; }
