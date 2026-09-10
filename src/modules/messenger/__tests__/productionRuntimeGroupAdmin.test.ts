/**
 * productionRuntime — GROUP ADMINISTRATION, EXECUTED.
 *
 * create / rename / add / remove / leave. These are the multi-step, key-
 * rotating operations, so the properties worth pinning are not "did it call
 * something" but "what did the local crypto state become, and what could a
 * member actually decrypt afterwards":
 *
 *   P0-G3 — an add MUST chain a rekey. A bare `add` admits the new member at
 *           the current epoch with the current master key, which lets them
 *           decrypt every envelope still dwelling on the relay (30 days) and
 *           every sealed-archive row under that key.
 *   P0-G2 — a remove MUST rotate and MUST fail closed locally even when the
 *           rekey fan-out reached nobody; continuing on the old key would let
 *           the removed member keep reading.
 *   B-433 — a removal must also narrow the CONVERSATION row, not just crypto
 *           state: `rosterUserIds` is sticky across upserts, so a removed
 *           member survived there and got rung into the very call they had
 *           just been removed from.
 *   B-290 — a rename must reach the UI row; applying it to crypto state alone
 *           left it invisible because nothing renders `groups[id].name`.
 *
 * Harness rationale: see `productionRuntimeDirectSend.test.ts`.
 */

jest.mock('@bravo/messenger-core', () => {
  const actual = jest.requireActual('@bravo/messenger-core');
  const g = globalThis as unknown as {__prBus?: Record<string, unknown>};
  const bus = (g.__prBus = g.__prBus ?? {
    relaySends: [] as unknown[],
    bundles:    {} as Record<string, unknown>,
    relayThrow: null as string | null,
    onFrame:    null as unknown,
  }) as {
    relaySends: unknown[]; bundles: Record<string, unknown>;
    relayThrow: string | null; onFrame: unknown;
  };

  class FakeTransport {
    constructor(opts: {onFrame?: unknown}) { bus.onFrame = opts?.onFrame ?? null; }
    connect() { return Promise.resolve(); }
    disconnect() {}
    close() {}
    isConnected() { return true; }
    msSinceServerSignal() { return 0; }
    forceReconnect() { return Promise.resolve(); }
    send() { /* admin envelopes always go over HTTP */ }
  }
  class FakeKeys {
    uploadBundle() { return Promise.resolve({poolSize: 50, identityRotated: false}); }
    fetchPeerBundleWithPoolSize(userId: string) {
      const bundle = bus.bundles[userId];
      if (!bundle) { return Promise.reject(new Error(`no bundle for ${userId}`)); }
      return Promise.resolve({bundle, poolSize: 50});
    }
    fetchDevices() { return Promise.resolve([]); }
  }
  class FakeCertClient {}
  class FakeRelay {
    send(req: {recipient: {userId: string}}) {
      if (bus.relayThrow) { return Promise.reject(new Error(bus.relayThrow)); }
      bus.relaySends.push(req);
      return Promise.resolve({envelopeId: `env-${bus.relaySends.length}`, retractToken: 'rt'});
    }
    retract() { return Promise.resolve({retracted: true}); }
    pull() { return Promise.resolve({envelopes: []}); }
    ack() { return Promise.resolve({}); }
  }
  class FakeCertCache {
    get() { return Promise.resolve({cert: 'TEST-CERT', expiresAt: Math.floor(Date.now() / 1000) + 3600}); }
    getIssued() { return this.get(); }
  }
  class FakeRevoked { start() {} stop() {} isRevoked() { return false; } }
  class FakeUsers {}

  return {
    ...actual,
    TransportClient:   FakeTransport,
    KeysHttpClient:    FakeKeys,
    SenderCertClient:  FakeCertClient,
    RelayHttpClient:   FakeRelay,
    SenderCertCache:   FakeCertCache,
    RevokedJtiCache:   FakeRevoked,
    UsersHttpClient:   FakeUsers,
  };
});

import {makeNewGroup, type GroupState} from '@bravo/messenger-core';
import {
  installIdentity,
  buildOwnPreKeyBundle,
  SessionManager,
  unwrapOuter,
  unsealPayload,
  type CryptoStore,
} from '../crypto';
import {InMemoryProtocolStore} from '../crypto/inMemoryStore';
import {useMessengerStore} from '../store/messengerStore';
import type {MessengerRuntime} from '../runtime/runtime';

jest.setTimeout(300_000);

const ALICE = 'alice-user-id';
const BOB   = 'bob-user-id';
const CAROL = 'carol-user-id';
const DAVE  = 'dave-user-id';

type Bus = {
  relaySends: Array<{recipient: {userId: string; deviceId: number}; outerSealed: string}>;
  bundles: Record<string, unknown>;
  relayThrow: string | null;
  onFrame: ((f: unknown) => void) | null;
};
const bus = (): Bus => (globalThis as unknown as {__prBus: Bus}).__prBus;

let runtime: MessengerRuntime;
const peerStores: Record<string, CryptoStore> = {};

/**
 * The group-admin methods are OPTIONAL on `MessengerRuntime` (not every runtime
 * implements them), so every call site here would otherwise need a non-null
 * assertion. Assert presence ONCE per describe instead: the suite now also pins
 * that the PRODUCTION runtime exposes the method, and an interface/build change
 * that drops one fails with a readable message at the named op rather than
 * scattering type errors across every call.
 */
type GroupAdminOp = 'renameGroup' | 'removeGroupMember' | 'addGroupMember' | 'leaveGroup';

function requireRuntimeOp<K extends GroupAdminOp>(name: K): NonNullable<MessengerRuntime[K]> {
  const fn = runtime[name];
  expect(typeof fn).toBe('function');
  if (typeof fn !== 'function') {
    throw new Error(`productionRuntime does not implement ${name}; this suite pins it as present`);
  }
  // Why: the methods are arrow properties on the runtime literal (no `this`),
  // so an extracted reference behaves identically to `runtime.<name>(...)`.
  return fn;
}

/**
 * `runWithGroupAdminLock` evicts its Map entry with `void next.finally(...)`,
 * and `.finally()` propagates rejections — so every admin op that throws leaks
 * an unhandled rejection that Jest attributes to a RANDOM later test. The real
 * promise is awaited by the caller; only the eviction shim leaks, and React
 * Native merely warns. Jest's handler lives on the worker process, out of this
 * VM's reach, so the containment is to attach a no-op catch at creation time.
 */
async function withoutFinallyLeak<T>(work: () => Promise<T>): Promise<T> {
  const proto = Promise.prototype as unknown as {finally: unknown};
  const original = proto.finally;
  proto.finally = function patched(this: Promise<unknown>, cb?: () => void) {
    const derived = (original as (cb?: () => void) => Promise<unknown>).call(this, cb);
    void derived.catch(() => { /* eviction shim — the real promise is awaited */ });
    return derived;
  };
  try {
    return await work();
  } finally {
    proto.finally = original;
  }
}

/** Read the admin action a member's device would apply from an outbound envelope. */
async function adminActionSentTo(userId: string): Promise<Record<string, unknown>> {
  const leg = bus().relaySends.find(r => r.recipient.userId === userId);
  if (!leg) { throw new Error(`no envelope was sent to ${userId}`); }
  const id = await peerStores[userId].getIdentityKeyPair();
  const un = await unwrapOuter({
    ownIdentityPrivKey: id.privKey,
    ownIdentityPubKey:  id.pubKey,
    outerSealedB64:     leg.outerSealed,
  });
  const plain = await new SessionManager(peerStores[userId])
    .decrypt({userId: ALICE, deviceId: 1}, un.ciphertext);
  const sealed = unsealPayload(plain) as unknown as {body: string};
  // `create` and `key-request` ship the inner envelope UNWRAPPED under the
  // pairwise session (the recipient has no group key yet).
  return JSON.parse(sealed.body) as Record<string, unknown>;
}

const groupIn = (gid: string): GroupState | undefined =>
  useMessengerStore.getState().groups[gid];

/** Seed a real, admin-valid group with ALICE as owner. */
function seedGroup(members: string[]): GroupState {
  const state = makeNewGroup({
    name: 'Ops Room',
    owner: ALICE,
    ownerDeviceId: 1,
    members: members.map(userId => ({userId, deviceId: 1})),
  });
  const store = useMessengerStore.getState();
  store.setGroupState(state);
  store.upsertConversation({
    id: state.groupId,
    type: 'group',
    name: 'Ops Room',
    peer: {userId: members[0] ?? ALICE, deviceId: 1},
    participants:  [ALICE, ...members],
    rosterUserIds: [ALICE, ...members],
    session_state: 'established',
  } as never);
  return state;
}

beforeAll(async () => {
  for (const uid of [BOB, CAROL, DAVE]) {
    const store = new InMemoryProtocolStore();
    await installIdentity(store, {preKeyCount: 8});
    peerStores[uid] = store;
    bus().bundles[uid] = await buildOwnPreKeyBundle(store, {userId: uid, deviceId: 1}, 1, 1);
  }

  const {buildProductionRuntime} = require('../runtime/productionRuntime') as
    typeof import('../runtime/productionRuntime');
  runtime = await buildProductionRuntime({
    ownStore: new InMemoryProtocolStore(),
    config: {
      authBaseUrl:        'http://auth.test',
      messengerBaseUrl:   'http://msg.test',
      wsUrl:              'ws://msg.test/ws',
      getToken:           async () => 'jwt',
      authorityPubKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      ownUserId:          ALICE,
      ownerKey:           'alice@test',
    },
  });
});

afterAll(() => {
  const {disposeLiveRuntime} = require('../runtime/productionRuntime') as
    typeof import('../runtime/productionRuntime');
  disposeLiveRuntime();
});

beforeEach(() => {
  bus().relaySends.length = 0;
  bus().relayThrow = null;
  useMessengerStore.setState({messages: {}, conversations: {}, groups: {}});
});

describe('createGroupChat', () => {
  it('mints local group + conversation state and fans a signed `create` to every other member', async () => {
    const {conversationId, groupId} = await runtime.createGroupChat({
      name: 'Ops Room', members: [BOB, CAROL],
    });
    expect(conversationId).toBe(groupId);

    const state = groupIn(groupId)!;
    expect(state.owner).toBe(ALICE);
    expect(state.members[ALICE].admin).toBe(true);
    expect(state.members[BOB].admin).toBe(false);
    expect(state.masterKeyB64).toHaveLength(44);   // 32 raw bytes, base64

    const convo = useMessengerStore.getState().conversations[conversationId]!;
    expect(convo.type).toBe('group');
    // B-247 part 2 — an ordinary user group needs a roster too, or a call in it
    // rings only the creator's key-holders.
    expect([...(convo.rosterUserIds ?? [])].sort()).toEqual([ALICE, BOB, CAROL].sort());

    expect(bus().relaySends.map(r => r.recipient.userId).sort()).toEqual([BOB, CAROL].sort());
    const inner = await adminActionSentTo(BOB);
    const action = inner.adminAction as {type: string; state: GroupState; creatorSignature: string};
    expect(inner.kind).toBe('admin');
    expect(action.type).toBe('create');
    // Round 5 / S4 — receivers verify this against the cert's identity key to
    // detect a cert-leak + member-substitution attack.
    expect(typeof action.creatorSignature).toBe('string');
    expect(action.creatorSignature.length).toBeGreaterThan(0);
    // `create` is the ONE envelope sent without a master-key wrap — the
    // recipient learns the key from it.
    expect(action.state.masterKeyB64).toBe(state.masterKeyB64);
  });

  it('strips self and de-duplicates the member list before deriving the group', async () => {
    const {groupId} = await runtime.createGroupChat({
      name: 'Dupes', members: [BOB, BOB, ALICE, CAROL],
    });
    expect(Object.keys(groupIn(groupId)!.members).sort()).toEqual([ALICE, BOB, CAROL].sort());
    expect(bus().relaySends).toHaveLength(2);
  });

  it('refuses a group with no other members unless allowSolo is set', async () => {
    await withoutFinallyLeak(async () => {
      await expect(runtime.createGroupChat({name: 'Just me', members: [ALICE]}))
        .rejects.toThrow(/group needs at least one other member/);
    });
    expect(bus().relaySends).toHaveLength(0);
  });

  it('allowSolo mints a valid admin-only channel group with zero fan-out', async () => {
    const {groupId} = await runtime.createGroupChat({
      name: 'Solo channel', members: [], allowSolo: true, allowZeroDelivered: true,
    });
    const state = groupIn(groupId)!;
    expect(Object.keys(state.members)).toEqual([ALICE]);
    expect(state.masterKeyB64).toHaveLength(44);
    expect(bus().relaySends).toHaveLength(0);
  });

  it('throws when NO member could be reached — but keeps the local state for a re-share', async () => {
    await withoutFinallyLeak(async () => {
      await expect(runtime.createGroupChat({name: 'Unreachable', members: ['ghost-1']}))
        .rejects.toThrow(/no member could be reached/);
    });
    // The group itself is valid; only delivery failed.
    const gids = Object.keys(useMessengerStore.getState().groups);
    expect(gids).toHaveLength(1);
    expect(groupIn(gids[0])!.members['ghost-1']).toBeDefined();
  });

  it('allowZeroDelivered keeps a STABLE id on a 0-delivered provisioning fan-out (D1-d)', async () => {
    const res = await runtime.createGroupChat({
      name: 'Dept', members: ['ghost-1'], allowZeroDelivered: true,
    });
    expect(res.conversationId).toBe(res.groupId);
    expect(groupIn(res.groupId)).toBeDefined();
  });
});

describe('renameGroup', () => {
  let renameGroup: NonNullable<MessengerRuntime['renameGroup']>;
  beforeAll(() => { renameGroup = requireRuntimeOp('renameGroup'); });

  it('bumps the epoch and renames BOTH the crypto state and the UI row (B-290)', async () => {
    const state = seedGroup([BOB, CAROL]);
    const {newEpoch} = await renameGroup({groupId: state.groupId, name: '  Night Shift  '});

    expect(newEpoch).toBeGreaterThan(state.epoch);
    expect(groupIn(state.groupId)!.name).toBe('Night Shift');   // trimmed
    // Nothing renders `groups[id].name`, so a rename that stops at crypto
    // state is invisible to the user.
    expect(useMessengerStore.getState().conversations[state.groupId]!.name).toBe('Night Shift');
    expect(bus().relaySends.map(r => r.recipient.userId).sort()).toEqual([BOB, CAROL].sort());
  });

  it('is a no-op that skips the fan-out when the name is unchanged', async () => {
    const state = seedGroup([BOB]);
    const {newEpoch} = await renameGroup({groupId: state.groupId, name: 'Ops Room'});
    expect(newEpoch).toBe(state.epoch);
    expect(bus().relaySends).toHaveLength(0);
  });

  it('rejects an empty / whitespace-only name', async () => {
    const state = seedGroup([BOB]);
    await withoutFinallyLeak(async () => {
      await expect(renameGroup({groupId: state.groupId, name: '   '}))
        .rejects.toThrow(/group name cannot be empty/);
    });
    expect(groupIn(state.groupId)!.name).toBe('Ops Room');
  });

  it('rejects a rename by a non-admin member', async () => {
    const state = seedGroup([BOB]);
    // Demote self — mirrors the receive-side gate applyAdminAction enforces.
    useMessengerStore.getState().setGroupState({
      ...state,
      members: {...state.members, [ALICE]: {...state.members[ALICE], admin: false}},
    });
    await withoutFinallyLeak(async () => {
      await expect(renameGroup({groupId: state.groupId, name: 'Hijacked'}))
        .rejects.toThrow(/only admins can rename this group/);
    });
    expect(bus().relaySends).toHaveLength(0);
  });

  it('rejects a rename of an unknown group', async () => {
    await withoutFinallyLeak(async () => {
      await expect(renameGroup({groupId: 'no-such-group', name: 'X'}))
        .rejects.toThrow(/unknown group/);
    });
  });

  it('applies the rename locally even when every peer misses the fan-out', async () => {
    const state = seedGroup([BOB, CAROL]);
    bus().relayThrow = 'relay down';
    const {newEpoch} = await renameGroup({groupId: state.groupId, name: 'Offline Rename'});

    expect(newEpoch).toBeGreaterThan(state.epoch);
    expect(groupIn(state.groupId)!.name).toBe('Offline Rename');
  });
});

describe('removeGroupMember', () => {
  let removeGroupMember: NonNullable<MessengerRuntime['removeGroupMember']>;
  beforeAll(() => { removeGroupMember = requireRuntimeOp('removeGroupMember'); });

  it('P0-G2 — rotates the master key and drops the member from crypto state', async () => {
    const state = seedGroup([BOB, CAROL]);
    const {newEpoch} = await removeGroupMember({
      groupId: state.groupId, removedUserId: CAROL,
    });

    const after = groupIn(state.groupId)!;
    expect(after.members[CAROL]).toBeUndefined();
    expect(after.members[BOB]).toBeDefined();
    // Forward secrecy: the removed member keeps the OLD key, so the group must
    // not still be using it.
    expect(after.masterKeyB64).not.toBe(state.masterKeyB64);
    // Two chained actions (remove, then rekey).
    expect(newEpoch).toBe(state.epoch + 2);
    expect(after.epoch).toBe(newEpoch);
  });

  it('B-433 — narrows the CONVERSATION row too, so the removed member cannot be rung', async () => {
    const state = seedGroup([BOB, CAROL]);
    await removeGroupMember({groupId: state.groupId, removedUserId: CAROL});

    const convo = useMessengerStore.getState().conversations[state.groupId]!;
    expect(convo.participants).not.toContain(CAROL);
    // `rosterUserIds` is sticky across upserts by design — THIS is the field
    // that survived the removal and rang the removed member back into the call.
    expect(convo.rosterUserIds ?? []).not.toContain(CAROL);
  });

  it('B-255 — leaves a visible member-removed row on the remover’s own device', async () => {
    const state = seedGroup([BOB, CAROL]);
    await removeGroupMember({groupId: state.groupId, removedUserId: CAROL});

    const rows = useMessengerStore.getState().messages[state.groupId] ?? [];
    // Receivers append the identical row (same deterministic id) when they
    // apply the same `remove`, so the thread must read the same on every
    // device — the event payload, not just "some system row", is the contract.
    const event = rows.find(m => m.event?.kind === 'member_removed');
    expect(event).toBeDefined();
    expect(event!.type).toBe('system');
    expect(event!.event).toEqual({
      kind: 'member_removed', actorUserId: ALICE, memberUserId: CAROL,
    });
    // Deterministic id ⇒ re-applying the same removal must not duplicate it.
    expect(rows.filter(m => m.id === event!.id)).toHaveLength(1);
  });

  it('tells the removed member they are out (the remove leg is sent to them too)', async () => {
    const state = seedGroup([BOB, CAROL]);
    await removeGroupMember({groupId: state.groupId, removedUserId: CAROL});

    const recipients = bus().relaySends.map(r => r.recipient.userId);
    expect(recipients).toContain(CAROL);
    // …but the follow-up rekey must NOT reach them: after the remove leg they
    // are out of the member set the rekey fans out to.
    expect(recipients.filter(u => u === CAROL)).toHaveLength(1);
    expect(recipients.filter(u => u === BOB)).toHaveLength(2);
  });

  it('rejects a removal by a non-admin', async () => {
    const state = seedGroup([BOB, CAROL]);
    useMessengerStore.getState().setGroupState({
      ...state,
      members: {...state.members, [ALICE]: {...state.members[ALICE], admin: false}},
    });
    await withoutFinallyLeak(async () => {
      await expect(removeGroupMember({groupId: state.groupId, removedUserId: CAROL}))
        .rejects.toThrow(/only admins can remove members/);
    });
    expect(groupIn(state.groupId)!.members[CAROL]).toBeDefined();
  });

  it('rejects removing self (that is what leaveGroup is for)', async () => {
    const state = seedGroup([BOB]);
    await withoutFinallyLeak(async () => {
      await expect(removeGroupMember({groupId: state.groupId, removedUserId: ALICE}))
        .rejects.toThrow(/cannot remove self/);
    });
    expect(groupIn(state.groupId)!.members[ALICE]).toBeDefined();
  });

  it('rejects removing someone who is not a member', async () => {
    const state = seedGroup([BOB]);
    await withoutFinallyLeak(async () => {
      await expect(removeGroupMember({groupId: state.groupId, removedUserId: DAVE}))
        .rejects.toThrow(/is not a member of/);
    });
  });

  it('refuses to rotate at all when the remove broadcast reached nobody', async () => {
    const state = seedGroup([BOB, CAROL]);
    bus().relayThrow = 'relay down';
    await withoutFinallyLeak(async () => {
      await expect(removeGroupMember({groupId: state.groupId, removedUserId: CAROL}))
        .rejects.toThrow(/no peer reached/);
    });
    // Nothing may have moved: a half-applied removal is worse than none.
    const after = groupIn(state.groupId)!;
    expect(after.masterKeyB64).toBe(state.masterKeyB64);
    expect(after.members[CAROL]).toBeDefined();
  });
});

describe('addGroupMember', () => {
  let addGroupMember: NonNullable<MessengerRuntime['addGroupMember']>;
  beforeAll(() => { addGroupMember = requireRuntimeOp('addGroupMember'); });

  it('P0-G3 — admits the member AND chains a rekey so they cannot read the prior epoch', async () => {
    const state = seedGroup([BOB]);
    const {newEpoch} = await addGroupMember({
      groupId: state.groupId, newMember: {userId: DAVE, deviceId: 1},
    });

    const after = groupIn(state.groupId)!;
    expect(after.members[DAVE]).toBeDefined();
    expect(after.members[DAVE].admin).toBe(false);
    // Without the chained rekey the new member could decrypt everything still
    // dwelling on the relay under the old key.
    expect(after.masterKeyB64).not.toBe(state.masterKeyB64);
    expect(newEpoch).toBe(state.epoch + 2);
  });

  it('sends the `add` to the POST-add member set, including the new member', async () => {
    const state = seedGroup([BOB]);
    await addGroupMember({groupId: state.groupId, newMember: {userId: DAVE, deviceId: 1}});
    expect(new Set(bus().relaySends.map(r => r.recipient.userId))).toEqual(new Set([BOB, DAVE]));
  });

  it('tags the non-admin refusal with code NOT_ADMIN', async () => {
    const state = seedGroup([BOB]);
    useMessengerStore.getState().setGroupState({
      ...state,
      members: {...state.members, [ALICE]: {...state.members[ALICE], admin: false}},
    });
    await withoutFinallyLeak(async () => {
      await expect(addGroupMember({groupId: state.groupId, newMember: {userId: DAVE, deviceId: 1}}))
        .rejects.toMatchObject({code: 'NOT_ADMIN'});
    });
  });

  it('tags a re-add of an existing member ALREADY_MEMBER, with wording the intent drain matches on', async () => {
    const state = seedGroup([BOB]);
    await withoutFinallyLeak(async () => {
      // The MESSAGE TEXT is load-bearing: membershipIntents matches
      // /already a member of/ to settle a benign no-op intent instead of
      // retrying it forever (D2-g).
      await expect(addGroupMember({groupId: state.groupId, newMember: {userId: BOB, deviceId: 1}}))
        .rejects.toThrow(/is already a member of/);
      await expect(addGroupMember({groupId: state.groupId, newMember: {userId: BOB, deviceId: 1}}))
        .rejects.toMatchObject({code: 'ALREADY_MEMBER'});
    });
    expect(bus().relaySends).toHaveLength(0);
  });

  it('tags adding self CANNOT_ADD_SELF', async () => {
    const state = seedGroup([BOB]);
    await withoutFinallyLeak(async () => {
      await expect(addGroupMember({groupId: state.groupId, newMember: {userId: ALICE, deviceId: 1}}))
        .rejects.toMatchObject({code: 'CANNOT_ADD_SELF'});
    });
  });

  it('refuses the 251st member so the group can never grow past what the send path can fan out', async () => {
    const state = seedGroup(Array.from({length: 249}, (_, i) => `member-${i}`));
    expect(Object.keys(state.members)).toHaveLength(250);
    await withoutFinallyLeak(async () => {
      await expect(addGroupMember({groupId: state.groupId, newMember: {userId: DAVE, deviceId: 1}}))
        .rejects.toMatchObject({code: 'GROUP_FULL'});
    });
    expect(groupIn(state.groupId)!.members[DAVE]).toBeUndefined();
  });

  it('rejects an add into an unknown group', async () => {
    await withoutFinallyLeak(async () => {
      await expect(addGroupMember({groupId: 'no-such-group', newMember: {userId: DAVE, deviceId: 1}}))
        .rejects.toThrow(/unknown group/);
    });
  });
});

describe('leaveGroup', () => {
  let leaveGroup: NonNullable<MessengerRuntime['leaveGroup']>;
  beforeAll(() => { leaveGroup = requireRuntimeOp('leaveGroup'); });

  it('broadcasts the leave and then drops the group locally', async () => {
    const state = seedGroup([BOB, CAROL]);
    const res = await leaveGroup({groupId: state.groupId});

    expect(res.left).toBe(true);
    expect(groupIn(state.groupId)).toBeUndefined();
    expect(bus().relaySends.map(r => r.recipient.userId).sort()).toEqual([BOB, CAROL].sort());
  });

  it('leaves locally even when the broadcast fails — a user is never stuck in a group', async () => {
    const state = seedGroup([BOB, CAROL]);
    bus().relayThrow = 'relay down';
    const res = await leaveGroup({groupId: state.groupId});

    expect(res.left).toBe(true);
    expect(groupIn(state.groupId)).toBeUndefined();
  });

  it('is a clean no-op for an unknown group', async () => {
    const res = await leaveGroup({groupId: 'no-such-group'});
    expect(res.left).toBe(true);
    expect(bus().relaySends).toHaveLength(0);
  });

  it('drops a solo group without broadcasting anything', async () => {
    const state = seedGroup([]);
    const res = await leaveGroup({groupId: state.groupId});

    expect(res.left).toBe(true);
    expect(groupIn(state.groupId)).toBeUndefined();
    expect(bus().relaySends).toHaveLength(0);
  });
});
