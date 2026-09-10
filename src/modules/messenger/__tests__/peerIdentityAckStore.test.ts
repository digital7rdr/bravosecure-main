/**
 * TOFU send-gate store — tracks peers whose identity changed and needs an
 * explicit user acknowledgement before sends resume. The gate itself is opt-in
 * (EXPO_PUBLIC_STRICT_IDENTITY_SEND_GATE); this store is the persisted state it
 * reads. Contract:
 *   1. flag reflects the env var (default OFF)
 *   2. note → pending true; acknowledge → pending false
 *   3. note is idempotent (first-seen timestamp preserved)
 *   4. persisted across a reload (hydrate re-reads what note wrote)
 *
 * Uses the store's injectable persistence seam (an in-memory blob) so the test
 * never touches the real AsyncStorage native module.
 */
import {
  isIdentitySendGateEnabled,
  notePeerIdentityChanged,
  hasPendingIdentityAck,
  acknowledgePeerIdentity,
  listPendingIdentityAcks,
  hydratePeerIdentityAcks,
  _setPersistenceForTests,
  _resetPeerIdentityAcksForTests,
} from '../store/peerIdentityAckStore';

let disk: string | null = null;

// Access the env through an aliased object so babel-preset-expo doesn't rewrite
// a literal `process.env.EXPO_PUBLIC_*` member into a require('expo/virtual/env')
// (which is untransformed ESM and blows up the node test env).
const env = (globalThis as {process: {env: Record<string, string | undefined>}}).process.env;
const GATE = 'EXPO_PUBLIC_STRICT_IDENTITY_SEND_GATE';

beforeEach(() => {
  disk = null;
  _resetPeerIdentityAcksForTests();
  _setPersistenceForTests({
    load: async () => disk,
    save: async (raw: string) => { disk = raw; },
  });
  delete env[GATE];
});

afterAll(() => { _setPersistenceForTests(null); });

describe('peerIdentityAckStore (TOFU send-gate)', () => {
  it('gate flag defaults OFF and reflects the env var', () => {
    expect(isIdentitySendGateEnabled()).toBe(false);
    env[GATE] = 'true';
    expect(isIdentitySendGateEnabled()).toBe(true);
    env[GATE] = 'false';
    expect(isIdentitySendGateEnabled()).toBe(false);
  });

  it('note marks pending; acknowledge clears it', async () => {
    expect(hasPendingIdentityAck('alice')).toBe(false);
    await notePeerIdentityChanged('alice');
    expect(hasPendingIdentityAck('alice')).toBe(true);
    expect(listPendingIdentityAcks()).toEqual(['alice']);
    await acknowledgePeerIdentity('alice');
    expect(hasPendingIdentityAck('alice')).toBe(false);
    expect(listPendingIdentityAcks()).toEqual([]);
  });

  it('ignores empty user ids', async () => {
    await notePeerIdentityChanged('');
    expect(hasPendingIdentityAck('')).toBe(false);
    expect(listPendingIdentityAcks()).toEqual([]);
  });

  it('note is idempotent (keeps the first-seen timestamp)', async () => {
    await notePeerIdentityChanged('bob');
    const first = JSON.parse(disk!).bob;
    await notePeerIdentityChanged('bob');
    const second = JSON.parse(disk!).bob;
    expect(second).toBe(first);
  });

  it('persists across a reload — hydrate re-reads a prior note', async () => {
    await notePeerIdentityChanged('carol');
    // Simulate a fresh process: reset in-memory state (disk blob survives),
    // re-install the same persistence, then hydrate.
    _resetPeerIdentityAcksForTests();
    _setPersistenceForTests({ load: async () => disk, save: async (raw: string) => { disk = raw; } });
    expect(hasPendingIdentityAck('carol')).toBe(false); // not yet hydrated
    await hydratePeerIdentityAcks();
    expect(hasPendingIdentityAck('carol')).toBe(true);  // restored from disk
  });
});
