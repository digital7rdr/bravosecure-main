/**
 * MSG-01 — group decrypt-failure with reason 'tamper' (master-key
 * divergence) must be RECOVERABLE, not a permanent silent drop.
 *
 * Context: the sender cert + sealed AAD are verified upstream, so a
 * `groupDecrypt` failure under our master key is almost always KEY
 * DIVERGENCE (a missed create/rekey fan-out or a stale epoch), not a
 * forgery. The relay already ACKed on delivery, so dropping it loses the
 * message. The fix (productionRuntime.ts group-receive `reason==='tamper'`
 * branch) stays fail-CLOSED — never renders the ciphertext — but durably
 * STASHes the envelope on the same pending queue as `no_key` and surfaces
 * a recoverable "re-syncing" indicator. The existing create/rekey drain
 * (`drainPendingGroup` -> `replayGroupSealedDecode`) then re-decrypts the
 * stashed envelope once the correct master key lands.
 *
 * These tests model that receive-side decision over the REAL
 * PendingGroupEnvelopeStore, the REAL messengerStore, and the REAL group
 * crypto, asserting:
 *   1. A wrong-key parse returns reason 'tamper' (never plaintext).
 *   2. The tamper envelope is STASHED (recoverable) + an indicator set,
 *      and is NOT appended/rendered.
 *   3. Re-parsing the stashed envelope with the CORRECT key succeeds —
 *      proving the stash is the recovery path (drain re-decrypts).
 *   4. A genuine wrong key keeps failing on re-parse (stays fail-closed).
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
import {PendingGroupEnvelopeStore} from '../store/pendingGroupEnvelopeStore';
import {useMessengerStore} from '../store/messengerStore';
import {selectKeyResyncCandidates} from '../runtime/groupConversationUpsert';

interface Row {
  envelope_id:    string;
  group_id:       string;
  peer_user_id:   string;
  peer_device_id: number;
  sealed_json:    string;
  received_at_ms: number;
  attempts:       number;
}

// Minimal SQLite mock — the subset of statements the store emits that
// this test exercises (stash + listForGroup). Mirrors the mock in
// pendingGroupEnvelopeStore.test.ts.
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
    if (/^SELECT COUNT\(\*\) AS n FROM pending_group_envelopes WHERE group_id = \?/.test(sql)) {
      const groupId = (params as unknown[])[0] as string;
      return {rows: [{n: rows.filter(r => r.group_id === groupId).length}]};
    }
    if (/^SELECT COUNT\(\*\) AS n FROM pending_group_envelopes/.test(sql)) {
      return {rows: [{n: rows.length}]};
    }
    return {rows: []};
  };
  return {db: {execute}, rows};
}

const GROUP_ID = 'g-msg01';
const PEER = {userId: 'alice', deviceId: 1};
const ENVELOPE_ID = 'env-tamper-1';

/**
 * Build a real master-key-wrapped group sealed payload, encrypted under
 * `keyB64`. Shape matches what broadcastToGroup produces (body is the
 * JSON of a GroupCiphertext; sealed.group carries the routing hint).
 */
async function makeWrappedGroupEnvelope(keyB64: string): Promise<SealedPayload> {
  const clientMsgId = 'cmid-1';
  const inner = JSON.stringify({groupId: GROUP_ID, kind: 'text', clientMsgId, body: 'ops brief at 14:00'});
  const wrapped = await groupEncrypt(keyB64, inner);
  return {
    body:  JSON.stringify(wrapped),
    group: {groupId: GROUP_ID, kind: 'text', clientMsgId},
  } as unknown as SealedPayload;
}

/**
 * Faithful replica of the runtime's group-receive `reason==='tamper'`
 * decision (productionRuntime.ts): on tamper with a stash store +
 * envelopeId, STASH + setError + return (do NOT append/render). Returns
 * the action taken so the test can assert fail-closed-yet-recoverable.
 */
async function handleTamperLikeRuntime(args: {
  parseReason: 'tamper';
  sealed: SealedPayload;
  envelopeId: string | undefined;
  pendingGroupEnvelopes: PendingGroupEnvelopeStore | null;
}): Promise<'stashed' | 'dropped'> {
  const {sealed, envelopeId, pendingGroupEnvelopes} = args;
  if (pendingGroupEnvelopes && envelopeId) {
    await pendingGroupEnvelopes.stash({
      envelopeId,
      groupId:      GROUP_ID,
      peerUserId:   PEER.userId,
      peerDeviceId: PEER.deviceId,
      sealed,
      receivedAtMs: Date.now(),
    });
    useMessengerStore.getState().setError("Couldn't decrypt one message — re-syncing");
    return 'stashed';
  }
  // Loopback fallback — fail-closed drop, still no render.
  useMessengerStore.getState().setError("Couldn't decrypt one message — re-syncing");
  return 'dropped';
}

describe('MSG-01 — tamper-from-key-divergence is stashed + recoverable, never silently dropped', () => {
  beforeEach(() => {
    useMessengerStore.getState().reset();
  });

  it('a wrong (diverged) master key yields reason "tamper", never plaintext', async () => {
    const senderKey  = genFreshGroupMasterKey();
    const ourKey     = genFreshGroupMasterKey(); // diverged
    expect(ourKey).not.toBe(senderKey);

    const sealed = await makeWrappedGroupEnvelope(senderKey);
    const res = await parseGroupMessage(sealed, ourKey);

    expect(res.ok).toBe(false);
    if (!res.ok) {expect(res.reason).toBe('tamper');}
  });

  it('stashes the tamper envelope + sets indicator, and does NOT render it', async () => {
    const senderKey = genFreshGroupMasterKey();
    const ourKey    = genFreshGroupMasterKey();
    const sealed    = await makeWrappedGroupEnvelope(senderKey);

    // Decrypt fails under our diverged key.
    const res = await parseGroupMessage(sealed, ourKey);
    expect(res.ok).toBe(false);

    const {db} = makeMockDb();
    const store = new PendingGroupEnvelopeStore(db as never);

    const action = await handleTamperLikeRuntime({
      parseReason: 'tamper',
      sealed,
      envelopeId: ENVELOPE_ID,
      pendingGroupEnvelopes: store,
    });

    // Recoverable: stashed, not permanently dropped.
    expect(action).toBe('stashed');
    const stashed = await store.listForGroup(GROUP_ID);
    expect(stashed.map(r => r.envelopeId)).toEqual([ENVELOPE_ID]);

    // User-visible recoverable indicator (not a hard "tampered — dropped").
    expect(useMessengerStore.getState().error).toBe("Couldn't decrypt one message — re-syncing");

    // Fail-CLOSED: the ciphertext was never appended/rendered anywhere.
    const allMessages = useMessengerStore.getState().messages[GROUP_ID] ?? [];
    expect(allMessages).toHaveLength(0);
  });

  it('the stashed envelope re-decrypts once the correct key lands (drain recovery path)', async () => {
    const masterKey = genFreshGroupMasterKey();
    const sealed    = await makeWrappedGroupEnvelope(masterKey);

    const {db} = makeMockDb();
    const store = new PendingGroupEnvelopeStore(db as never);

    // Arrived before we had the right key — parse with a diverged key → tamper, stash it.
    const diverged = genFreshGroupMasterKey();
    const res1 = await parseGroupMessage(sealed, diverged);
    expect(res1.ok).toBe(false);
    await handleTamperLikeRuntime({
      parseReason: 'tamper', sealed, envelopeId: ENVELOPE_ID, pendingGroupEnvelopes: store,
    });

    // create/rekey lands → the correct master key is now known. The drain
    // re-parses the SAME stashed sealed payload with the correct key.
    const [row] = await store.listForGroup(GROUP_ID);
    const replaySealed = JSON.parse(row.sealedJson) as SealedPayload;
    const res2 = await parseGroupMessage(replaySealed, masterKey);
    expect(res2.ok).toBe(true);
    if (res2.ok) {expect(res2.envelope.body).toBe('ops brief at 14:00');}
  });

  it('a genuinely wrong key keeps failing on re-parse — stays fail-closed', async () => {
    const senderKey = genFreshGroupMasterKey();
    const sealed    = await makeWrappedGroupEnvelope(senderKey);

    const {db} = makeMockDb();
    const store = new PendingGroupEnvelopeStore(db as never);
    await handleTamperLikeRuntime({
      parseReason: 'tamper', sealed, envelopeId: ENVELOPE_ID, pendingGroupEnvelopes: store,
    });

    // Drain fires but the key is STILL wrong (not the divergence we hoped
    // for) — re-parse fails again. Never yields plaintext; drain bumps
    // attempts and eventually drops, all fail-closed.
    const [row] = await store.listForGroup(GROUP_ID);
    const replaySealed = JSON.parse(row.sealedJson) as SealedPayload;
    const stillWrong = genFreshGroupMasterKey();
    const res = await parseGroupMessage(replaySealed, stillWrong);
    expect(res.ok).toBe(false);
    if (!res.ok) {expect(res.reason).toBe('tamper');}
  });
});

/**
 * B-26(b) — faithful replica of the runtime's group-receive
 * `reason==='no_key'` branch (productionRuntime.ts): STASH the envelope,
 * surface a visible "waiting for the group key" notice (so an established
 * member who has lost the key isn't left staring at a blank thread), and
 * return without rendering. Mirrors handleTamperLikeRuntime above. The
 * real recovery (re-seeding a key the member never persisted) is an
 * owner-side resync — a key-distribution change requiring architecture
 * sign-off — so the in-scope fix here is the visible-state surface only.
 */
async function handleNoKeyLikeRuntime(args: {
  sealed: SealedPayload;
  envelopeId: string | undefined;
  pendingGroupEnvelopes: PendingGroupEnvelopeStore | null;
}): Promise<'stashed' | 'dropped'> {
  const {sealed, envelopeId, pendingGroupEnvelopes} = args;
  if (pendingGroupEnvelopes && envelopeId) {
    await pendingGroupEnvelopes.stash({
      envelopeId,
      groupId:      GROUP_ID,
      peerUserId:   PEER.userId,
      peerDeviceId: PEER.deviceId,
      sealed,
      receivedAtMs: Date.now(),
    });
    useMessengerStore.getState().setError(
      "Waiting for this group's encryption key — the message will appear once it syncs.",
    );
    return 'stashed';
  }
  return 'dropped';
}

describe('B-26(b) — no_key group envelope surfaces a waiting notice, never blank, never rendered', () => {
  beforeEach(() => {
    useMessengerStore.getState().reset();
  });

  it('parseGroupMessage returns no_key when the recipient holds no master key', async () => {
    const senderKey = genFreshGroupMasterKey();
    const sealed    = await makeWrappedGroupEnvelope(senderKey);
    // No master key passed → encrypted-but-keyless → recoverable no_key.
    const res = await parseGroupMessage(sealed);
    expect(res.ok).toBe(false);
    if (!res.ok) {expect(res.reason).toBe('no_key');}
  });

  it('stashes the envelope + sets a visible waiting indicator, and renders nothing', async () => {
    const senderKey = genFreshGroupMasterKey();
    const sealed    = await makeWrappedGroupEnvelope(senderKey);

    const {db} = makeMockDb();
    const store = new PendingGroupEnvelopeStore(db as never);

    const action = await handleNoKeyLikeRuntime({
      sealed, envelopeId: ENVELOPE_ID, pendingGroupEnvelopes: store,
    });

    // Recoverable: stashed for the create/rekey drain, not dropped.
    expect(action).toBe('stashed');
    const stashed = await store.listForGroup(GROUP_ID);
    expect(stashed.map(r => r.envelopeId)).toEqual([ENVELOPE_ID]);

    // B-26(b) — a visible "waiting for key" state instead of a silent blank.
    expect(useMessengerStore.getState().error)
      .toBe("Waiting for this group's encryption key — the message will appear once it syncs.");

    // Fail-CLOSED: nothing rendered into the thread.
    const allMessages = useMessengerStore.getState().messages[GROUP_ID] ?? [];
    expect(allMessages).toHaveLength(0);
  });
});

describe('GF-3 — a divergence request survives the keyless resync gate and heals', () => {
  beforeEach(() => {
    useMessengerStore.getState().reset();
  });

  it('tamper → divergence-flagged request → candidate selected → same stash opens under the right key', async () => {
    const senderKey = genFreshGroupMasterKey();
    const ourKey    = genFreshGroupMasterKey(); // diverged
    const sealed    = await makeWrappedGroupEnvelope(senderKey);

    // 1. Wrong-key parse → tamper (the trigger).
    const res1 = await parseGroupMessage(sealed, ourKey);
    expect(res1.ok).toBe(false);
    if (!res1.ok) {expect(res1.reason).toBe('tamper');}

    // 2. The runtime's tamper branch stashes and raises a request that now
    //    carries divergence: true (productionRuntime tamper-stash return).
    const {db} = makeMockDb();
    const store = new PendingGroupEnvelopeStore(db as never);
    await handleTamperLikeRuntime({
      parseReason: 'tamper', sealed, envelopeId: ENVELOPE_ID, pendingGroupEnvelopes: store,
    });
    const request = {
      kind:       'request-group-key' as const,
      groupId:    GROUP_ID,
      fromPeer:   PEER,
      divergence: true,
    };

    // 3. The resync impl's candidate filter — WE HOLD A KEY (the wrong one).
    //    Without the flag this is dropped, which was the GF-3 dead code.
    const candidates = selectKeyResyncCandidates({
      groups:        {[GROUP_ID]: {masterKeyB64: ourKey}},
      conversations: {},
      groupId:       request.groupId,
      divergence:    request.divergence,
    });
    expect(candidates).toEqual([GROUP_ID]);

    // 4. The owner answers with the current key → the SAME stashed bytes
    //    open (the heal completes; the row is never attempt-burned away).
    const [row] = await store.listForGroup(GROUP_ID);
    const res2 = await parseGroupMessage(JSON.parse(row.sealedJson) as SealedPayload, senderKey);
    expect(res2.ok).toBe(true);
    if (res2.ok) {expect(res2.envelope.body).toBe('ops brief at 14:00');}
  });
});
