/**
 * messageMirror — the CONVERSATION lane (`mirrorConversation` /
 * `flushConversations`).
 *
 * The message lane has suites; this one had none, so the conversation row the
 * restore rebuilds every chat from — its kind, its member list, its mute/pin/
 * TTL/unread state, and the AES-GCM-wrapped `group_state` that carries the
 * GROUP MASTER KEY — was shaped entirely by untested code.
 *
 * Pinned here:
 *   • Audit P0-B5 — `group_state` leaves the device ENCRYPTED. The plaintext
 *     shape exposed groupId + members + the raw group master key in base64;
 *     anyone with DB read access could decrypt every message ever sent in the
 *     group. The wire row must contain no recognisable key bytes, and must
 *     round-trip through `decryptGroupStateBlob` under the master key.
 *   • M-3 — that blob is AAD-bound to (owner, conversation_id), so a server
 *     that swaps one conversation's group_state into another row is rejected.
 *   • A group_state encrypt failure DROPS the blob but still ships the row —
 *     one bad group must not stop the conversation mirror.
 *   • F11 — a retryable failure requeues the failed snapshot ONLY when nothing
 *     fresher arrived during the await; otherwise the stale state would ship
 *     and overwrite the newer one (a mute toggle / group rekey mid-flight).
 *   • The owner gate + the "mirror locked" gate apply to conversations too.
 */

jest.mock('react-native', () => ({
  __esModule: true,
  AppState: {addEventListener: jest.fn(() => ({remove: () => undefined}))},
}));

const mockPutConversations = jest.fn(async (_rows: unknown[]) => ({written: 0}));
jest.mock('../backup/backupClient', () => {
  class BackupError extends Error {
    kind: string;
    constructor(kind: string, message: string) { super(message); this.name = 'BackupError'; this.kind = kind; }
  }
  return {
    __esModule: true,
    BackupError,
    backupClient: {
      putMessages:      jest.fn(async () => ({written: 0})),
      putConversations: (rows: unknown[]) => mockPutConversations(rows),
    },
  };
});
jest.mock('../backup/mirrorLedger', () => ({
  __esModule: true,
  bumpFlushEpoch:         jest.fn(),
  recordFlushedVersions:  jest.fn(async () => undefined),
  setMerkleCommitPending: jest.fn(async () => undefined),
}));

import {
  setMirrorKey, setMirrorOwner, mirrorConversation, disposeMirror,
  drainMirrorOutbox, mirrorOutboxSize,
} from '../backup/messageMirror';
import {decryptGroupStateBlob} from '../backup/backupWireV3';
import {backupAad} from '../backup/backupCrypto';
import type {LocalConversation} from '../store/types';
import type {GroupState} from '@bravo/messenger-core';

const {BackupError} = require('../backup/backupClient') as {
  BackupError: new (kind: string, message: string) => Error;
};

const OWNER = 'owner-A';
const GROUP_MASTER_KEY_B64 = 'R1JPVVAtTUFTVEVSLUtFWS1ET05PVC1MRUFL';

interface ConvRow {
  conversation_id: string;
  kind: 'direct' | 'group' | 'system';
  name: string | null;
  members: Array<{userId: string; displayName?: string}>;
  last_message_at: string | null;
  is_muted: boolean;
  is_pinned: boolean;
  default_ttl_sec: number | null;
  unread_count: number;
  is_custom_name: boolean;
  group_state: Record<string, unknown> | null;
}

function conv(over: Partial<LocalConversation> = {}): LocalConversation {
  return {
    id: 'conv-1',
    type: 'direct',
    name: 'Bow Rani',
    participants: [],
    peer: {userId: 'peer-1', deviceId: 1},
    session_state: 'fresh',
    unread_count: 0,
    is_muted: false,
    created_at: new Date(1_700_000_000_000).toISOString(),
    ...over,
  } as unknown as LocalConversation;
}

function groupState(over: Partial<GroupState> = {}): GroupState {
  return {
    groupId:      'conv-g',
    name:         'Ops Room',
    owner:        OWNER,
    members:      {[OWNER]: {deviceId: 1, admin: true, joinedAt: 1}},
    masterKeyB64: GROUP_MASTER_KEY_B64,
    epoch:        7,
    createdAt:    1,
    updatedAt:    2,
    ...over,
  } as GroupState;
}

async function makeKey(fill = 1): Promise<CryptoKey> {
  return (globalThis.crypto as Crypto).subtle.importKey(
    'raw', new Uint8Array(32).fill(fill), {name: 'AES-GCM'}, false, ['encrypt', 'decrypt'],
  );
}

const rowsOf = (call = 0): ConvRow[] => mockPutConversations.mock.calls[call][0] as ConvRow[];

describe('messageMirror — conversation lane', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    disposeMirror();
    mockPutConversations.mockImplementation(async () => ({written: 0}));
    setMirrorOwner(OWNER);
    setMirrorKey(await makeKey());
  });
  afterEach(() => { disposeMirror(); });

  it('ships a direct room with the peer as its single member and the UX state intact', async () => {
    mirrorConversation(OWNER, conv({
      is_muted: true, is_pinned: true, default_ttl_sec: 604800,
      unread_count: 4, is_custom_name: true,
      last_message_at: '2026-08-01T00:00:00.000Z',
    } as Partial<LocalConversation>));
    await drainMirrorOutbox();

    expect(rowsOf()).toEqual([{
      conversation_id: 'conv-1',
      kind:            'direct',
      name:            'Bow Rani',
      members:         [{userId: 'peer-1', displayName: 'Bow Rani'}],
      last_message_at: '2026-08-01T00:00:00.000Z',
      is_muted:        true,
      is_pinned:       true,
      default_ttl_sec: 604800,
      unread_count:    4,
      is_custom_name:  true,
      group_state:     null,
      // B-594 — a live mirror carries deleted:false so re-adding a deleted
      // room clears its stored delete flag (the lift).
      deleted:         false,
    }]);
  });

  it('derives group members from participants and never ships the "self" sentinel', async () => {
    mirrorConversation(OWNER, conv({
      id: 'conv-g', type: 'group', name: 'Ops Room',
      participants: ['self', 'u-1', '', 'u-2'] as unknown as string[],
    } as Partial<LocalConversation>));
    await drainMirrorOutbox();

    const row = rowsOf()[0];
    expect(row.kind).toBe('group');
    // 'self' is a store-local sentinel; shipping it would restore a member
    // literally named "self" on the next device.
    expect(row.members).toEqual([{userId: 'u-1'}, {userId: 'u-2'}]);
  });

  it('maps a system room to kind=system (not silently to direct)', async () => {
    mirrorConversation(OWNER, conv({
      id: 'conv-s', type: 'system' as unknown as LocalConversation['type'],
    } as Partial<LocalConversation>));
    await drainMirrorOutbox();

    expect(rowsOf()[0].kind).toBe('system');
  });

  it('P0-B5 — group_state is AES-GCM wrapped: the group master key never hits the wire', async () => {
    const key = await makeKey(9);
    setMirrorKey(key);
    mirrorConversation(
      OWNER,
      conv({id: 'conv-g', type: 'group', name: 'Ops Room', participants: ['u-1']} as Partial<LocalConversation>),
      groupState(),
    );
    await drainMirrorOutbox();

    const row = rowsOf()[0];
    expect(row.group_state).toMatchObject({v: 3, blob: expect.any(String)});
    // The whole serialized row must not carry the raw group master key, the
    // member map, or the group name in the clear.
    const onTheWire = JSON.stringify(row.group_state);
    expect(onTheWire).not.toContain(GROUP_MASTER_KEY_B64);
    expect(onTheWire).not.toContain('Ops Room');

    // …and it really is the group state, recoverable under the master key.
    const back = await decryptGroupStateBlob(
      key, row.group_state as Record<string, unknown>, backupAad('group', OWNER, 'conv-g'),
    );
    expect(back.masterKeyB64).toBe(GROUP_MASTER_KEY_B64);
    expect(back.epoch).toBe(7);
    expect(back.members).toEqual({[OWNER]: {deviceId: 1, admin: true, joinedAt: 1}});
  });

  it('M-3 — the group_state blob is bound to its conversation: a swapped row is rejected', async () => {
    const key = await makeKey(9);
    setMirrorKey(key);
    mirrorConversation(
      OWNER,
      conv({id: 'conv-g', type: 'group', participants: ['u-1']} as Partial<LocalConversation>),
      groupState(),
    );
    await drainMirrorOutbox();
    const blob = rowsOf()[0].group_state as Record<string, unknown>;

    // A server moving this blob into a DIFFERENT conversation's row fails the
    // correct-context AAD, and the no-AAD fallback fails too (the tag covers
    // the absent AAD) — so the swap cannot be laundered as a legacy blob.
    await expect(
      decryptGroupStateBlob(key, blob, backupAad('group', OWNER, 'some-other-conv')),
    ).rejects.toBeTruthy();
    // Cross-owner swap is rejected for the same reason.
    await expect(
      decryptGroupStateBlob(key, blob, backupAad('group', 'owner-B', 'conv-g')),
    ).rejects.toBeTruthy();
  });

  it('drops an unencryptable group_state but STILL ships the conversation row', async () => {
    // A key with no `encrypt` usage — the exact failure the catch guards.
    const decryptOnly = await (globalThis.crypto as Crypto).subtle.importKey(
      'raw', new Uint8Array(32).fill(4), {name: 'AES-GCM'}, false, ['decrypt'],
    );
    setMirrorKey(decryptOnly);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    mirrorConversation(
      OWNER,
      conv({id: 'conv-g', type: 'group', name: 'Ops Room', participants: ['u-1']} as Partial<LocalConversation>),
      groupState(),
    );
    await drainMirrorOutbox();

    const row = rowsOf()[0];
    expect(row.conversation_id).toBe('conv-g');
    expect(row.group_state).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('collapses repeated snapshots of one conversation to the LATEST before shipping', async () => {
    mirrorConversation(OWNER, conv({name: 'old'}));
    mirrorConversation(OWNER, conv({name: 'newer'}));
    mirrorConversation(OWNER, conv({name: 'newest', is_pinned: true} as Partial<LocalConversation>));
    expect(mirrorOutboxSize()).toBe(1);

    await drainMirrorOutbox();
    expect(rowsOf()).toHaveLength(1);
    expect(rowsOf()[0].name).toBe('newest');
    expect(rowsOf()[0].is_pinned).toBe(true);
  });

  it('requeues a retryable failure when nothing fresher arrived', async () => {
    mockPutConversations.mockImplementationOnce(async () => {
      throw new BackupError('network', 'offline');
    });
    mirrorConversation(OWNER, conv({name: 'v1'}));
    await drainMirrorOutbox();

    expect(mirrorOutboxSize()).toBe(1);
    await drainMirrorOutbox();
    expect(mockPutConversations).toHaveBeenCalledTimes(2);
    expect(rowsOf(1)[0].name).toBe('v1');
  });

  it('F11 — a failure must NOT clobber a fresher snapshot that landed mid-flight', async () => {
    let rejectUpload!: (e: Error) => void;
    let uploadStarted!: () => void;
    const started = new Promise<void>(r => { uploadStarted = r; });
    mockPutConversations.mockImplementationOnce(() => {
      uploadStarted();
      return new Promise((_res, rej) => { rejectUpload = rej; });
    });

    mirrorConversation(OWNER, conv({name: 'v1', is_muted: false}));
    const drain = drainMirrorOutbox();
    await started;
    // The user toggles mute while the stale upload is still in flight.
    mirrorConversation(OWNER, conv({name: 'v2', is_muted: true}));
    rejectUpload(new BackupError('network', 'offline'));
    await drain;

    await drainMirrorOutbox();
    const shipped = rowsOf(1);
    expect(shipped).toHaveLength(1);
    // Pre-F11 the stale v1 was re-set into the queue and overwrote v2.
    expect(shipped[0].name).toBe('v2');
    expect(shipped[0].is_muted).toBe(true);
  });

  it('does not retry a permanently-invalid conversation batch', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockPutConversations.mockImplementationOnce(async () => {
      throw new BackupError('invalid_request', 'bad_row');
    });
    mirrorConversation(OWNER, conv());
    await drainMirrorOutbox();

    // No requeue → no 5-8s re-POST loop of bytes the server will never accept.
    expect(mirrorOutboxSize()).toBe(0);
    warn.mockRestore();
  });

  it('never enqueues for a stale owner, a locked mirror, or an id-less row', async () => {
    mirrorConversation('owner-B', conv());
    expect(mirrorOutboxSize()).toBe(0);

    mirrorConversation(OWNER, conv({id: ''} as Partial<LocalConversation>));
    expect(mirrorOutboxSize()).toBe(0);

    setMirrorKey(null);
    mirrorConversation(OWNER, conv());
    expect(mirrorOutboxSize()).toBe(0);

    await drainMirrorOutbox();
    expect(mockPutConversations).not.toHaveBeenCalled();
  });
});
