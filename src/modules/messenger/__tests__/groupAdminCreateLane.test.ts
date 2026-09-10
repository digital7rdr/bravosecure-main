/**
 * EXECUTABLE coverage for the `create` half of `runtime/applyGroupAdmin.ts` —
 * the branch that INSTALLS a group's master key.
 *
 * Three CLAUDE.md stop-conditions meet in this branch (group master key
 * distribution, epoch handling, rekey-on-removal), and until now every rule in
 * it was pinned only by regex scans of the source text. A scan can prove a line
 * exists; it cannot prove the signature is actually checked, that the B-127
 * double lookup resolves the right slot, or that a drop is traceable.
 *
 * The signatures here are REAL: a libsignal identity keypair signs the create
 * with `signGroupCreate`, and the lane verifies it with the real
 * `verifyGroupCreateSignature`. A mocked verifier would make the forgery cases
 * below assert nothing at all.
 *
 * THE ONE TO READ FIRST — B-127. `args.existing` is resolved by the WIRE id
 * while the install writes `groups[action.state.groupId]` (the SIGNED id). An
 * attacker set the wire id to an unused value, so `existing` came back
 * undefined, EVERY guard was skipped, and a self-signed create overwrote a
 * victim group's owner, roster and master key at epoch 0. The lane must resolve
 * the gate's `existing` from the SIGNED id. That asymmetry looks redundant and
 * is the P0 fix — the `hijack` cases pin it.
 */

const asyncStore: Record<string, string> = {};
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem:    jest.fn(async (k: string) => asyncStore[k] ?? null),
    setItem:    jest.fn(async (k: string, v: string) => { asyncStore[k] = v; }),
    removeItem: jest.fn(async (k: string) => { delete asyncStore[k]; }),
  },
}));
jest.mock('../crypto/expectedSenderIdentity', () => ({resolveExpectedSenderIdentity: jest.fn()}));
jest.mock('../runtime/groupEventMessage', () => ({
  appendGroupPhotoChangedEvent: jest.fn(),
  appendMemberAddedEvent:       jest.fn(),
  appendMemberRemovedEvent:     jest.fn(),
}));
jest.mock('../runtime/applyGroupRename', () => ({applyGroupRenameToUi: jest.fn()}));
jest.mock('../runtime/applyMemberRemoval', () => ({applyMemberRemovalToUi: jest.fn()}));
jest.mock('../runtime/decryptFailureSignal', () => ({noteDestroyedEnvelope: jest.fn()}));
jest.mock('../runtime/groupConversationUpsert', () => ({
  upsertGroupConversationFromState: jest.fn(),
}));

import {KeyHelper} from '@privacyresearch/libsignal-protocol-typescript';
import {signGroupCreate, toBase64} from '@bravo/messenger-core';
import type {GroupState} from '@bravo/messenger-core';
import {
  applyGroupAdmin,
  isGroupKeySuperseded,
  markGroupKeySuperseded,
  __resetSupersededKeys,
} from '../runtime/applyGroupAdmin';
import type {GroupAdminDeps, GroupAdminOutcome} from '../runtime/applyGroupAdmin';
import {LeaveOnRelayError} from '../runtime/firstMessageRetryBudget';
import {noteDestroyedEnvelope} from '../runtime/decryptFailureSignal';
import {upsertGroupConversationFromState} from '../runtime/groupConversationUpsert';
import {resolveExpectedSenderIdentity} from '../crypto/expectedSenderIdentity';

const mockResolve = resolveExpectedSenderIdentity as jest.Mock;

const OWNER  = 'owner-uid';
const SELF   = 'self-uid';
const RELAY  = 'relayer-uid';
const ATTACK = 'attacker-uid';
const GID    = 'group-abcdef0123456789';
const KEY_A  = Buffer.alloc(32, 1).toString('base64');
const KEY_B  = Buffer.alloc(32, 2).toString('base64');

/** Identity keypairs: the genuine owner, and an attacker with a valid cert. */
let ownerIdB64: string;
let ownerPriv: ArrayBuffer;
let attackerIdB64: string;
let attackerPriv: ArrayBuffer;

beforeAll(async () => {
  const o = await KeyHelper.generateIdentityKeyPair();
  ownerIdB64 = toBase64(o.pubKey);
  ownerPriv  = o.privKey;
  const a = await KeyHelper.generateIdentityKeyPair();
  attackerIdB64 = toBase64(a.pubKey);
  attackerPriv  = a.privKey;
});

function state(over: Partial<GroupState> = {}): GroupState {
  return {
    groupId:      GID,
    name:         'Ops Room',
    owner:        OWNER,
    members: {
      [OWNER]: {deviceId: 1, admin: true,  joinedAt: 1},
      [SELF]:  {deviceId: 1, admin: false, joinedAt: 2},
    },
    masterKeyB64: KEY_A,
    epoch:        0,
    createdAt:    1,
    updatedAt:    1,
    ...over,
  } as GroupState;
}

interface Harness {
  outcome: GroupAdminOutcome;
  setGroupState: jest.Mock;
  writes: GroupState[];
  setError: jest.Mock;
  groups: Record<string, GroupState>;
}

async function runCreate(opts: {
  incoming:      GroupState;
  signature?:    string;
  /** Who shipped the envelope. Defaults to the state's owner (self-signed). */
  senderId?:     string;
  senderIdentityKey?: string;
  /** Local state, keyed by its own groupId. */
  local?:        GroupState;
  /** Routing id — defaults to the SIGNED id. B-127 sets it to something else. */
  wireGroupId?:  string;
  conversations?: Record<string, {type?: string} | undefined>;
  keys?:         GroupAdminDeps['keys'];
  envelopeId?:   string | undefined;
}): Promise<Harness> {
  const groups: Record<string, GroupState> = opts.local ? {[opts.local.groupId]: opts.local} : {};
  const setGroupState = jest.fn((s: GroupState) => { groups[s.groupId] = s; });
  const setError = jest.fn();
  const wire = opts.wireGroupId ?? opts.incoming.groupId;
  const deps: GroupAdminDeps = {
    store: {groups, setGroupState},
    getState: () => ({groups, conversations: opts.conversations ?? {}, setGroupState, setError}),
    ownStore: {} as GroupAdminDeps['ownStore'],
    keys: opts.keys ?? null,
    peerIdentityCache: undefined as unknown as GroupAdminDeps['peerIdentityCache'],
    ownUserId: SELF,
    pendingAdminActions: null,
    emitGroupKeySignal: jest.fn(),
    crashLog: jest.fn(),
  };
  const outcome = await applyGroupAdmin(
    {
      action: {type: 'create', state: opts.incoming, creatorSignature: opts.signature},
      peer: {userId: opts.senderId ?? opts.incoming.owner, deviceId: 1},
      // The WIRE lookup, exactly as the caller does it.
      existing: groups[wire],
      envelopeId: 'envelopeId' in opts ? opts.envelopeId : 'env-abcdef0123',
      wireGroupId: wire,
      senderIdentityKey: opts.senderIdentityKey ?? ownerIdB64,
    },
    deps,
  );
  return {outcome, setGroupState, writes: setGroupState.mock.calls.map(c => c[0]), setError, groups};
}

let logSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  __resetSupersededKeys();
  mockResolve.mockReset();
  logSpy  = jest.spyOn(console, 'log').mockImplementation(() => {});
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
});

describe('owner-signed create — the happy path', () => {
  it('installs the state, persists the owner signature for later G-05 relay, and asks for a drain', async () => {
    const incoming = state();
    const sig = await signGroupCreate(ownerPriv, incoming);

    const h = await runCreate({incoming, signature: sig});

    expect(h.writes[0]).toEqual({...incoming, creatorSigB64: sig});
    // Without creatorSigB64 THIS member could never relay the owner's create
    // to a keyless peer while the owner is offline (G-05).
    expect(h.writes[0].creatorSigB64).toBe(sig);
    expect(upsertGroupConversationFromState).toHaveBeenCalledWith(incoming, OWNER);
    // A create is the first moment we hold the key — anything stashed under
    // no_key has to replay.
    expect(h.outcome).toEqual({kind: 'drain-group', groupId: GID});
  });

  it('a PRESENT-but-invalid signature is dropped and surfaced, and installs nothing', async () => {
    const incoming = state();
    // Signed correctly, then the roster was substituted.
    const sig = await signGroupCreate(ownerPriv, incoming);
    const tampered = state({
      members: {...incoming.members, [ATTACK]: {deviceId: 1, admin: true, joinedAt: 9}},
    } as Partial<GroupState>);

    const h = await runCreate({incoming: tampered, signature: sig});

    expect(h.setGroupState).not.toHaveBeenCalled();
    expect(h.setError).toHaveBeenCalledWith('Group create sig invalid — dropped');
    expect(h.outcome).toBeUndefined();
  });

  it('a MISSING signature is accepted only under the legacy-v1 rollout window', async () => {
    // No local key to protect ⇒ the gate is inert by design (B-41 bootstrap).
    const incoming = state();

    const h = await runCreate({incoming});

    expect(h.writes[0]).toEqual(incoming);       // no creatorSigB64 to persist
    expect(h.outcome).toEqual({kind: 'drain-group', groupId: GID});
    expect(warnSpy.mock.calls.flat().join(' ')).toContain('legacy unsigned create');
  });

  it('an unsigned create can NEVER overwrite live key material', async () => {
    const local = state({epoch: 3, masterKeyB64: KEY_A});
    const incoming = state({epoch: 4, masterKeyB64: KEY_B});

    const h = await runCreate({incoming, local});

    expect(h.setGroupState).not.toHaveBeenCalled();
    expect(noteDestroyedEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({reason: 'group-create-unsigned-over-live-key', conversationId: GID}),
    );
  });
});

describe('B-127 — the gate must be consulted with the SIGNED id, not the wire id', () => {
  it('a self-signed create routed under an UNUSED wire id cannot roll a live group back', async () => {
    // The exact P0. The victim group is advanced and keyed; the attacker's
    // payload claims the same groupId at epoch 0 with their own owner + key,
    // but routes under an id nothing is filed under, so the WIRE lookup misses.
    const victim = state({epoch: 9, masterKeyB64: KEY_A, owner: OWNER});
    const hijack = state({epoch: 0, masterKeyB64: KEY_B, owner: ATTACK});
    const sig = await signGroupCreate(attackerPriv, hijack);

    const h = await runCreate({
      incoming: hijack,
      signature: sig,
      senderId: ATTACK,
      senderIdentityKey: attackerIdB64,   // a genuine cert for the attacker
      local: victim,
      wireGroupId: 'an-id-nothing-is-filed-under',
    });

    expect(h.setGroupState).not.toHaveBeenCalled();
    expect(h.groups[GID]).toBe(victim);   // owner, roster and key all intact
    expect(noteDestroyedEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({reason: 'group-create-stale-epoch'}),
    );
  });

  it('an owner swap at an ADVANCED epoch is refused (owner continuity)', async () => {
    const victim = state({epoch: 2, masterKeyB64: KEY_A, owner: OWNER});
    const hijack = state({epoch: 7, masterKeyB64: KEY_B, owner: ATTACK});
    const sig = await signGroupCreate(attackerPriv, hijack);

    const h = await runCreate({
      incoming: hijack, signature: sig, senderId: ATTACK, senderIdentityKey: attackerIdB64,
      local: victim, wireGroupId: 'unused-routing-id',
    });

    expect(h.setGroupState).not.toHaveBeenCalled();
    expect(noteDestroyedEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({reason: 'group-create-owner-changed'}),
    );
  });

  it('a wire/payload id split is reported but NEVER dropped on its own', async () => {
    // A planned call-key resync change splits these fields deliberately; a hard
    // drop here would kill every re-escalated call at the joiner's key gate.
    const incoming = state();
    const sig = await signGroupCreate(ownerPriv, incoming);

    const h = await runCreate({incoming, signature: sig, wireGroupId: 'different-routing-id'});

    expect(h.writes[0].groupId).toBe(GID);
    expect(warnSpy.mock.calls.flat().join(' ')).toContain('wire/payload group id mismatch');
  });
});

describe('G-05 — a MEMBER relaying the owner-signed create', () => {
  const relayed = () => state({epoch: 0});

  it('verifies against the OWNER identity, not the relayer, and accepts', async () => {
    const incoming = relayed();
    const sig = await signGroupCreate(ownerPriv, incoming);
    mockResolve.mockResolvedValue(ownerIdB64);

    const h = await runCreate({
      incoming, signature: sig, senderId: RELAY,
      senderIdentityKey: attackerIdB64,   // relayer's own identity — must be IGNORED
      keys: {} as GroupAdminDeps['keys'],
    });

    expect(mockResolve).toHaveBeenCalledWith(
      {userId: OWNER, deviceId: 1}, expect.anything(), expect.anything(), undefined,
    );
    expect(h.writes[0]).toEqual({...incoming, creatorSigB64: sig});
  });

  it('a relayer signing with their OWN key is refused', async () => {
    const incoming = relayed();
    const forged = await signGroupCreate(attackerPriv, incoming);
    mockResolve.mockResolvedValue(ownerIdB64);

    const h = await runCreate({
      incoming, signature: forged, senderId: RELAY, keys: {} as GroupAdminDeps['keys'],
    });

    expect(h.setGroupState).not.toHaveBeenCalled();
    expect(warnSpy.mock.calls.flat().join(' ')).toContain('owner-sig');
  });

  it('an UNSIGNED relay is refused even though an unsigned OWNER create would pass', async () => {
    // The asymmetry is deliberate: the legacy-v1 exemption belongs to the owner
    // path only, or "relay it for me" becomes a free forge.
    const incoming = relayed();
    mockResolve.mockResolvedValue(ownerIdB64);

    const h = await runCreate({
      incoming, senderId: RELAY, keys: {} as GroupAdminDeps['keys'],
    });

    expect(h.setGroupState).not.toHaveBeenCalled();
  });

  it('M10 — a THROWING owner-identity lookup leaves the envelope on the relay', async () => {
    // Committing here would ack away the one envelope a keyless member is
    // waiting for: an owner-signed group-key create, destroyed permanently.
    const incoming = relayed();
    const sig = await signGroupCreate(ownerPriv, incoming);
    mockResolve.mockRejectedValue(new Error('keys-service 503'));

    await expect(runCreate({
      incoming, signature: sig, senderId: RELAY, keys: {} as GroupAdminDeps['keys'],
    })).rejects.toBeInstanceOf(LeaveOnRelayError);
  });

  it('M10 — a PERMANENT lookup failure (no keys client at all) drops instead of looping', async () => {
    const incoming = relayed();
    const sig = await signGroupCreate(ownerPriv, incoming);

    const h = await runCreate({incoming, signature: sig, senderId: RELAY, keys: null});

    expect(h.setGroupState).not.toHaveBeenCalled();
    expect(h.outcome).toBeUndefined();
    expect(warnSpy.mock.calls.flat().join(' ')).toContain('owner identity unavailable');
  });

  it('a resolver that returns undefined WITHOUT throwing is permanent, not redeliverable', async () => {
    const incoming = relayed();
    const sig = await signGroupCreate(ownerPriv, incoming);
    mockResolve.mockResolvedValue(undefined);

    const h = await runCreate({
      incoming, signature: sig, senderId: RELAY, keys: {} as GroupAdminDeps['keys'],
    });

    expect(h.outcome).toBeUndefined();       // dropped, no LeaveOnRelayError
    expect(h.setGroupState).not.toHaveBeenCalled();
  });
});

describe('G-04 / MEDIUM-2 — same-epoch fork heal and its rollback guard', () => {
  it('a same-epoch owner-signed create with a DIFFERENT key converges and retires the old key', async () => {
    const local = state({epoch: 4, masterKeyB64: KEY_A});
    const incoming = state({epoch: 4, masterKeyB64: KEY_B});
    const sig = await signGroupCreate(ownerPriv, incoming);

    const h = await runCreate({incoming, signature: sig, local});

    expect(h.writes[0].masterKeyB64).toBe(KEY_B);
    // The ledger write is the whole rollback defence — losing it silently
    // disarms MEDIUM-2.
    expect(isGroupKeySuperseded(GID, KEY_A)).toBe(true);
  });

  it('a REPLAY of the retired key is refused after that heal', async () => {
    const local = state({epoch: 4, masterKeyB64: KEY_B});
    const rollback = state({epoch: 4, masterKeyB64: KEY_A});
    const sig = await signGroupCreate(ownerPriv, rollback);
    markGroupKeySuperseded(GID, KEY_A);

    const h = await runCreate({incoming: rollback, signature: sig, local});

    expect(h.setGroupState).not.toHaveBeenCalled();
    expect(noteDestroyedEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({reason: 'group-create-superseded-key'}),
    );
  });

  it('the superseded ledger is bounded and scoped per group', async () => {
    for (let i = 0; i < 40; i++) {markGroupKeySuperseded('g1', `key-${i}`);}
    expect(isGroupKeySuperseded('g1', 'key-39')).toBe(true);
    expect(isGroupKeySuperseded('g1', 'key-0')).toBe(false);   // evicted by the cap
    // A key retired in one group says nothing about another.
    expect(isGroupKeySuperseded('g2', 'key-39')).toBe(false);
  });
});

describe('idempotent duplicate — repair the row, never re-install the wire copy', () => {
  it('repairs a lost inbox row from LOCAL state when the conversation row is missing', async () => {
    const local = state({epoch: 4, masterKeyB64: KEY_A, name: 'Local Name'});
    const incoming = state({epoch: 4, masterKeyB64: KEY_A, name: 'Wire Name'});
    const sig = await signGroupCreate(ownerPriv, incoming);

    const h = await runCreate({incoming, signature: sig, local, conversations: {}});

    // LOCALLY-trusted state only. `name` is UNSIGNED, attacker-chosen text —
    // repairing from the wire copy would let it be rewritten for free.
    expect(upsertGroupConversationFromState).toHaveBeenCalledWith(local, OWNER);
    expect(h.setGroupState).not.toHaveBeenCalled();
    expect(h.outcome).toBeUndefined();
  });

  it('does nothing when the conversation row already exists', async () => {
    const local = state({epoch: 4, masterKeyB64: KEY_A});
    const incoming = state({epoch: 4, masterKeyB64: KEY_A});
    const sig = await signGroupCreate(ownerPriv, incoming);

    await runCreate({
      incoming, signature: sig, local, conversations: {[GID]: {type: 'group'}},
    });

    expect(upsertGroupConversationFromState).not.toHaveBeenCalled();
  });

  it('B-365 — a same-epoch owner-signed roster SUPERSET is adopted instead of discarded', async () => {
    // A device that missed an `add` otherwise keeps its stale roster forever
    // and roster-gates every serve to the missing member.
    const local = state({epoch: 4, masterKeyB64: KEY_A});
    const grown = state({
      epoch: 4,
      masterKeyB64: KEY_A,
      members: {...state().members, 'late-joiner': {deviceId: 1, admin: false, joinedAt: 9}},
    } as Partial<GroupState>);
    const sig = await signGroupCreate(ownerPriv, grown);

    const h = await runCreate({incoming: grown, signature: sig, local});

    expect(h.writes[0].members['late-joiner']).toBeDefined();
    expect(warnSpy.mock.calls.flat().join(' ')).toContain('roster heal');
  });
});

describe("BS-CALL-ADHOC / BS-CALL-GHOST — a 'Call' group is a key carrier, not a chat", () => {
  it('files the key under the minted id AND aliases it to direct:<owner>, with NO inbox row', async () => {
    // Every escalated call mints a fresh 'Call' group; upserting them stacked a
    // permanent ghost "Call" chat per retry on the recipient.
    const incoming = state({name: 'Call'});
    const sig = await signGroupCreate(ownerPriv, incoming);

    const h = await runCreate({incoming, signature: sig});

    expect(h.writes.map(w => w.groupId)).toEqual([GID, `direct:${OWNER}`]);
    expect(h.writes[1].masterKeyB64).toBe(KEY_A);
    expect(upsertGroupConversationFromState).not.toHaveBeenCalled();
  });

  it('B-362r2 — a DUPLICATE call create still repairs the alias slot', async () => {
    // The joiner keys its FrameCryptor off `direct:<owner>`; a host re-broadcast
    // of a state we already hold landed on the repair path and used to skip the
    // alias, leaving the joiner probing an empty handle for 25s.
    const local = state({name: 'Call', epoch: 4, masterKeyB64: KEY_A});
    const incoming = state({name: 'Call', epoch: 4, masterKeyB64: KEY_A});
    const sig = await signGroupCreate(ownerPriv, incoming);

    const h = await runCreate({incoming, signature: sig, local});

    expect(h.writes).toHaveLength(1);
    expect(h.writes[0].groupId).toBe(`direct:${OWNER}`);
    expect(h.writes[0].masterKeyB64).toBe(KEY_A);
    // Still no inbox row for a call carrier.
    expect(upsertGroupConversationFromState).not.toHaveBeenCalled();
  });
});

describe('every drop is traceable', () => {
  it('reports the envelope id and the reason so a silent key loss can be diagnosed', async () => {
    const local = state({epoch: 9, masterKeyB64: KEY_A});
    const stale = state({epoch: 1, masterKeyB64: KEY_B});
    const sig = await signGroupCreate(ownerPriv, stale);

    await runCreate({incoming: stale, signature: sig, local});

    expect(noteDestroyedEnvelope).toHaveBeenCalledWith({
      envelopeId: 'env-abcdef0123',
      conversationId: GID,
      peer: {userId: OWNER, deviceId: 1},
      reason: 'group-create-stale-epoch',
    });
  });
});
