/**
 * B-31 — an undrained group envelope stash is replayed on boot once the master
 * key is restored from disk.
 *
 * A group text stashed (no_key/tamper) in a prior session is normally drained
 * by the admin create/rekey post-txn request; once that admin envelope is ACKed
 * off the relay it is never redelivered, so a stash row left undrained across a
 * restart has nothing to re-trigger it — the key is on disk and the message is
 * decryptable, yet it never renders. The boot key-restore path now re-runs the
 * existing per-row drain for every group whose key it just restored.
 *
 * `productionRuntime.ts` is too heavy to import in jest (every messenger test
 * uses replicas + the real stores/crypto), so these tests pin:
 *   1. the real, exported fail-closed selection (`selectGroupIdsToDrain`), and
 *   2. the recovery mechanism over the REAL PendingGroupEnvelopeStore + REAL
 *      group crypto — Scenario A (keyed group → stash re-decrypts) and
 *      Scenario B (keyless group → not selected, stash retained, fail-closed).
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
    },
  };
});

import {
  groupEncrypt,
  parseGroupMessage,
  genFreshGroupMasterKey,
  type SealedPayload,
} from '@bravo/messenger-core';
import {PendingGroupEnvelopeStore, PENDING_GROUP_MAX_ATTEMPTS} from '../store/pendingGroupEnvelopeStore';
import {useMessengerStore} from '../store/messengerStore';
import {
  selectGroupIdsToDrain,
  shouldBumpStashAttempt,
  ReplayNeedsKeyError,
} from '../runtime/bootGroupStashDrain';

interface Row {
  envelope_id:    string;
  group_id:       string;
  peer_user_id:   string;
  peer_device_id: number;
  sealed_json:    string;
  received_at_ms: number;
  attempts:       number;
}

// Minimal SQLite mock — the subset of statements PendingGroupEnvelopeStore
// emits that these tests exercise (stash + listForGroup). Mirrors the mock in
// tamperKeyDivergenceStash.test.ts / pendingGroupEnvelopeStore.test.ts.
function makeMockDb() {
  const rows: Row[] = [];
  const execute = async (sql: string, params?: unknown[]): Promise<{rows?: unknown[]; rowsAffected?: number}> => {
    if (/^INSERT OR REPLACE INTO pending_group_envelopes/.test(sql)) {
      const p = params as [string, string, string, number, string, number];
      const existing = rows.findIndex(r => r.envelope_id === p[0]);
      const row: Row = {
        envelope_id: p[0], group_id: p[1], peer_user_id: p[2],
        peer_device_id: p[3], sealed_json: p[4], received_at_ms: p[5], attempts: 0,
      };
      if (existing >= 0) {rows.splice(existing, 1, row);} else {rows.push(row);}
      return {rowsAffected: 1};
    }
    if (/^SELECT envelope_id, group_id/.test(sql)) {
      const groupId = (params as unknown[])[0] as string;
      const matched = rows
        .filter(r => r.group_id === groupId)
        .sort((a, b) => a.received_at_ms - b.received_at_ms);
      return {rows: matched.map(r => ({...r}))};
    }
    // GF-3 — bumpAttempts + targeted delete (the attempt-policy tests).
    if (/^UPDATE pending_group_envelopes/.test(sql)) {
      const envelopeId = (params as unknown[])[0] as string;
      const r = rows.find(x => x.envelope_id === envelopeId);
      if (r) {r.attempts += 1;}
      return {rowsAffected: r ? 1 : 0};
    }
    if (/^SELECT attempts FROM pending_group_envelopes/.test(sql)) {
      const envelopeId = (params as unknown[])[0] as string;
      const r = rows.find(x => x.envelope_id === envelopeId);
      return {rows: r ? [{attempts: r.attempts}] : []};
    }
    if (/^DELETE FROM pending_group_envelopes WHERE envelope_id = \?$/.test(sql)) {
      const envelopeId = (params as unknown[])[0] as string;
      const i = rows.findIndex(x => x.envelope_id === envelopeId);
      if (i >= 0) {rows.splice(i, 1);}
      return {rowsAffected: i >= 0 ? 1 : 0};
    }
    return {rows: []};
  };
  return {db: {execute}, rows};
}

const GROUP_A = 'g-keyed';
const GROUP_B = 'g-keyless';
const PEER = {userId: 'alice', deviceId: 1};

/** Real master-key-wrapped group sealed payload (shape matches broadcastToGroup). */
async function makeWrappedGroupEnvelope(groupId: string, keyB64: string): Promise<SealedPayload> {
  const clientMsgId = 'cmid-1';
  const inner = JSON.stringify({groupId, kind: 'text', clientMsgId, body: 'ops brief at 14:00'});
  const wrapped = await groupEncrypt(keyB64, inner);
  return {
    body:  JSON.stringify(wrapped),
    group: {groupId, kind: 'text', clientMsgId},
  } as unknown as SealedPayload;
}

describe('B-31 selectGroupIdsToDrain — fail-closed boot-drain selection', () => {
  it('selects only groups whose master key is already on the device', () => {
    expect(
      selectGroupIdsToDrain({
        [GROUP_A]: {masterKeyB64: 'a-key'},
        [GROUP_B]: {}, // Scenario B — key never persisted
      }),
    ).toEqual([GROUP_A]);
  });

  it('skips groups with an empty/undefined key (Scenario B stays fail-closed)', () => {
    expect(selectGroupIdsToDrain({[GROUP_B]: {masterKeyB64: ''}})).toEqual([]);
    expect(selectGroupIdsToDrain({[GROUP_B]: {}})).toEqual([]);
  });

  it('returns an empty list when there are no groups', () => {
    expect(selectGroupIdsToDrain({})).toEqual([]);
  });
});

describe('B-31 boot-drain recovery — keyed stash re-decrypts; keyless stays fail-closed', () => {
  beforeEach(() => {
    useMessengerStore.getState().reset();
  });

  it('Scenario A: a restored on-disk key makes the prior-session stash decryptable + selected', async () => {
    const masterKey = genFreshGroupMasterKey();
    const sealed = await makeWrappedGroupEnvelope(GROUP_A, masterKey);

    const {db} = makeMockDb();
    const store = new PendingGroupEnvelopeStore(db as never);
    // Stashed in a PRIOR session (it was no_key at the time).
    await store.stash({
      envelopeId: 'env-A', groupId: GROUP_A,
      peerUserId: PEER.userId, peerDeviceId: PEER.deviceId,
      sealed, receivedAtMs: 1,
    });

    // Boot restores the master key into the live store (the merge step).
    useMessengerStore.setState({
      groups: {[GROUP_A]: {groupId: GROUP_A, masterKeyB64: masterKey, members: {[PEER.userId]: {}}}},
    } as never);

    // The boot drain selects this group (its key is present)...
    expect(selectGroupIdsToDrain(useMessengerStore.getState().groups as never)).toContain(GROUP_A);

    // ...so the per-row drain re-parses the SAME stashed payload with the now-
    // present key and recovers the plaintext (what replayGroupSealedDecode does).
    const [row] = await store.listForGroup(GROUP_A);
    const res = await parseGroupMessage(JSON.parse(row.sealedJson) as SealedPayload, masterKey);
    expect(res.ok).toBe(true);
    if (res.ok) {expect(res.envelope.body).toBe('ops brief at 14:00');}
  });

  it('Scenario B: a group with no key on disk is NOT selected → stash retained, nothing rendered', async () => {
    const masterKey = genFreshGroupMasterKey();
    const sealed = await makeWrappedGroupEnvelope(GROUP_B, masterKey);

    const {db} = makeMockDb();
    const store = new PendingGroupEnvelopeStore(db as never);
    await store.stash({
      envelopeId: 'env-B', groupId: GROUP_B,
      peerUserId: PEER.userId, peerDeviceId: PEER.deviceId,
      sealed, receivedAtMs: 1,
    });

    // Boot restores groups, but this member never persisted GROUP_B's key.
    useMessengerStore.setState({
      groups: {[GROUP_B]: {groupId: GROUP_B, members: {}}},
    } as never);

    // Not selected — the owner-side resync for a truly-lost key is
    // architecture-gated and left untouched.
    expect(selectGroupIdsToDrain(useMessengerStore.getState().groups as never)).not.toContain(GROUP_B);

    // Stash retained for a future legitimate create/rekey; nothing rendered.
    const stashed = await store.listForGroup(GROUP_B);
    expect(stashed.map(r => r.envelopeId)).toEqual(['env-B']);
    expect(useMessengerStore.getState().messages[GROUP_B] ?? []).toHaveLength(0);
  });
});

describe('shouldBumpStashAttempt (GF-3)', () => {
  it('the boot drain never burns an attempt on a key-blocked row', () => {
    // Three launches used to delete a diverged row — the only copy on Earth
    // (stashing ACKs the relay). The boot drain installs nothing new, so a
    // needs-key failure there must be free.
    expect(shouldBumpStashAttempt({needsKey: true, keyChanged: false, transientSql: false})).toBe(false);
  });

  it('a real key change still evicts genuine tamper after MAX_ATTEMPTS', () => {
    expect(shouldBumpStashAttempt({needsKey: true, keyChanged: true, transientSql: false})).toBe(true);
  });

  it('a structurally broken row is still evicted on every path', () => {
    expect(shouldBumpStashAttempt({needsKey: false, keyChanged: false, transientSql: false})).toBe(true);
    expect(shouldBumpStashAttempt({needsKey: false, keyChanged: true, transientSql: false})).toBe(true);
  });

  it('AUDIT #11 — a transient SQL failure NEVER spends an attempt, regardless of key state', () => {
    // db_closed (a rebuild handle swap) / BUSY say nothing about the row;
    // three of them deleted the only surviving copy (stashing ACKed the
    // relay). Overrides every other input.
    expect(shouldBumpStashAttempt({needsKey: false, keyChanged: false, transientSql: true})).toBe(false);
    expect(shouldBumpStashAttempt({needsKey: false, keyChanged: true,  transientSql: true})).toBe(false);
    expect(shouldBumpStashAttempt({needsKey: true,  keyChanged: true,  transientSql: true})).toBe(false);
    // …and absent/false leaves the GF-3 policy untouched.
    expect(shouldBumpStashAttempt({needsKey: false, keyChanged: false, transientSql: false})).toBe(true);
  });

  it('ReplayNeedsKeyError is distinguishable from a structural Error', () => {
    const e: unknown = new ReplayNeedsKeyError('replay: parse tamper');
    expect(e instanceof ReplayNeedsKeyError).toBe(true);
    expect(e instanceof Error).toBe(true);
    expect(new Error('replay: parse malformed') instanceof ReplayNeedsKeyError).toBe(false);
  });
});

describe('GF-3 — the stash survives repeated key-blocked boots (store-level)', () => {
  it('five key-blocked boots spend nothing; one real key change spends one attempt', async () => {
    const masterKey = genFreshGroupMasterKey();
    const sealed = await makeWrappedGroupEnvelope(GROUP_A, masterKey);
    const {db, rows} = makeMockDb();
    const store = new PendingGroupEnvelopeStore(db as never);
    await store.stash({
      envelopeId: 'env-P', groupId: GROUP_A,
      peerUserId: PEER.userId, peerDeviceId: PEER.deviceId,
      sealed, receivedAtMs: 1,
    });

    // Simulate the drain's catch for a key-blocked replay across 5 boots.
    for (let boot = 0; boot < 5; boot++) {
      const needsKey = true; // ReplayNeedsKeyError path
      if (shouldBumpStashAttempt({needsKey, keyChanged: false, transientSql: false})) {
        await store.bumpAttempts('env-P');
      }
    }
    expect(rows[0].attempts).toBe(0);
    expect((await store.listForGroup(GROUP_A)).map(r => r.envelopeId)).toEqual(['env-P']);

    // A create/rekey drain that STILL fails may spend — once per real change.
    if (shouldBumpStashAttempt({needsKey: true, keyChanged: true, transientSql: false})) {
      const attempts = await store.bumpAttempts('env-P');
      expect(attempts).toBe(1);
      expect(attempts).toBeLessThan(PENDING_GROUP_MAX_ATTEMPTS);
    }
    expect((await store.listForGroup(GROUP_A)).map(r => r.envelopeId)).toEqual(['env-P']);
  });
});
