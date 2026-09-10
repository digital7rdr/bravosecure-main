/**
 * TOFU send-gate state — tracks peers whose Signal identity (safety number)
 * CHANGED and hasn't yet been acknowledged by the user.
 *
 * Why a dedicated store (not messengerStore): the send-gate is opt-in and this
 * state is small + independent; keeping it out of the core store avoids touching
 * that store's delicate persist/partialize path. Persisted to AsyncStorage so a
 * pending acknowledgement survives an app restart (an unacknowledged key change
 * must not silently clear on relaunch).
 *
 * Behavior is FLAG-GATED at the call sites (EXPO_PUBLIC_STRICT_IDENTITY_SEND_GATE):
 *   - When the flag is OFF (default), the runtime still RECORDS changes (cheap,
 *     harmless) but the send path does NOT block — identical to today.
 *   - When ON, sendText refuses to send to a peer with a pending identity change
 *     until the user acknowledges (WhatsApp "safety number changed — tap to
 *     accept"). Default-off ⇒ enabling this is a deliberate, verifiable rollout.
 *
 * The in-memory Set is the synchronous read used on the hot send path; the
 * AsyncStorage copy is hydrated once on boot and written through on every
 * mutation.
 */

const STORAGE_KEY = 'messenger.peer-identity-acks.v1';

/** userId → epoch ms the change was first noted. */
let pending: Record<string, number> = {};
let hydrated = false;

/**
 * Persistence seam. Defaults to a LAZY AsyncStorage require (so the real
 * native module never loads at import time — important for the node test env),
 * and is overridable in tests via `_setPersistenceForTests`. Mirrors the
 * dependency-injection pattern voipWakeVerify uses for the same reason.
 */
interface AckPersistence {
  load(): Promise<string | null>;
  save(raw: string): Promise<void>;
}
let persistence: AckPersistence | null = null;
function getPersistence(): AckPersistence {
  if (persistence) {return persistence;}
  return {
    load: async () => {
      const AsyncStorage = (require('@react-native-async-storage/async-storage') as {default: {getItem(k: string): Promise<string | null>}}).default;
      return AsyncStorage.getItem(STORAGE_KEY);
    },
    save: async (raw: string) => {
      const AsyncStorage = (require('@react-native-async-storage/async-storage') as {default: {setItem(k: string, v: string): Promise<void>}}).default;
      await AsyncStorage.setItem(STORAGE_KEY, raw);
    },
  };
}

/** Test-only — inject an in-memory persistence (or null to restore default). */
export function _setPersistenceForTests(p: AckPersistence | null): void {
  persistence = p;
}

/**
 * Is the send-gate enabled? Default OFF so nothing changes until opted in.
 * Read via globalThis.process.env (not a literal `process.env.EXPO_PUBLIC_*`
 * member access) so babel-preset-expo doesn't statically rewrite it into a
 * `require('expo/virtual/env')` — matching voipWakeVerify, which keeps the flag
 * readable in the node test env.
 */
export function isIdentitySendGateEnabled(): boolean {
  const raw = (globalThis as {process?: {env?: Record<string, string | undefined>}})
    ?.process?.env?.EXPO_PUBLIC_STRICT_IDENTITY_SEND_GATE;
  return raw === 'true';
}

async function persist(): Promise<void> {
  try {
    await getPersistence().save(JSON.stringify(pending));
  } catch {
    /* best-effort — the in-memory copy remains authoritative for this session */
  }
}

/** Hydrate the in-memory map from disk once. Safe to call repeatedly. */
export async function hydratePeerIdentityAcks(): Promise<void> {
  if (hydrated) {return;}
  hydrated = true;
  try {
    const raw = await getPersistence().load();
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, number>;
      if (parsed && typeof parsed === 'object') {pending = parsed;}
    }
  } catch {
    /* corrupt/missing — start empty */
  }
}

/**
 * Record that a peer's identity changed and needs acknowledgement. Idempotent —
 * keeps the FIRST-noted timestamp so repeated rotations don't reset the clock.
 */
export async function notePeerIdentityChanged(userId: string): Promise<void> {
  if (!userId) {return;}
  if (pending[userId]) {return;}
  pending[userId] = Date.now();
  await persist();
}

/** Synchronous check for the hot send path (reads the in-memory map). */
export function hasPendingIdentityAck(userId: string): boolean {
  return !!userId && !!pending[userId];
}

/** Clear a peer's pending acknowledgement (user tapped "accept"/verified). */
export async function acknowledgePeerIdentity(userId: string): Promise<void> {
  if (!userId || !pending[userId]) {return;}
  delete pending[userId];
  await persist();
}

/** All peers with a pending identity acknowledgement (for UI badges/lists). */
export function listPendingIdentityAcks(): string[] {
  return Object.keys(pending);
}

/** Test-only reset. */
export function _resetPeerIdentityAcksForTests(): void {
  pending = {};
  hydrated = false;
}
