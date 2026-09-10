/**
 * EXECUTABLE coverage for `runtime/runtime.ts` — the LOOPBACK runtime body and
 * the module-singleton lifecycle helpers.
 *
 * `runtimeBuildCache.test.ts` (P1-2) and `runtimeConfigGate.test.ts` (B-272)
 * both stub `../crypto` to `{}` and drive the PRODUCTION path only, so they
 * never get past the "no config" throw. Everything after that line — the whole
 * loopback runtime, the optimistic-bubble state machine in `sendText`, the echo
 * round-trip that proves the ratchet, the reaction/edit/delete stubs the UI
 * calls unconditionally, and the owner-key accessors the LOGOUT/WIPE path
 * depends on — had never been executed.
 *
 * This suite boots the real thing: real `InMemoryProtocolStore`, real
 * `installIdentity`, real libsignal X3DH + Double Ratchet, real Zustand store.
 * The only stub is AsyncStorage (the store's persistence edge).
 *
 * Why the loopback runtime is worth pinning at all: it is the dev harness that
 * every ChatScreen code path runs against, and it drives the SAME store actions
 * the production receive lane drives. A regression in `sendText`'s bubble
 * lifecycle here (append `sending` → ciphertext → `sent` → `delivered`, or
 * `failed` + setError + rethrow) is a regression in the contract ChatScreen is
 * written against.
 */

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem:    jest.fn(async () => null),
    setItem:    jest.fn(async () => {}),
    removeItem: jest.fn(async () => {}),
  },
}));

import {
  LOOPBACK_PEER,
  OWN_ADDRESS,
  _resetMessengerRuntime,
  _resetMessengerRuntimeKeepConfig,
  configureMessengerRuntime,
  getActiveOwnerKey,
  getMessengerRuntime,
  getOwnCryptoStore,
} from '../runtime/runtime';
import type {MessengerRuntime} from '../runtime/runtime';
import {useMessengerStore} from '../store/messengerStore';
import type {LocalMessage} from '../store/types';

const store = () => useMessengerStore.getState();
const rows = (cid: string): LocalMessage[] => store().messages[cid] ?? [];

/**
 * Poll for a delayed loopback effect (the 1:1 echo fires at +1500ms, group
 * echoes at +900ms then every +650ms). Polling rather than a flat sleep keeps
 * the suite fast AND keeps it honest under CI load, where a flat sleep sized
 * to the nominal delay is exactly how a timing flake gets shipped.
 */
async function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) {throw new Error('timed out waiting for a loopback echo');}
    await new Promise(r => setTimeout(r, 40));
  }
}

let runtime: MessengerRuntime;

beforeAll(async () => {
  _resetMessengerRuntime();
  runtime = await getMessengerRuntime('loopback-memory');
}, 60000);

afterAll(() => {
  _resetMessengerRuntime();
});

describe('booting the loopback runtime', () => {
  it('installs both identities, primes the echo conversation and flips the store ready', async () => {
    expect(runtime.mode).toBe('loopback-memory');
    expect(runtime.own).toBeDefined();
    // The echo peer is what actually PROVES the ratchet round-trip; without it
    // loopback would be a plaintext toy.
    expect(runtime.echoPeer).toBeDefined();
    expect(store().ready).toBe(true);

    const conv = store().conversations.loopback;
    expect(conv).toEqual(expect.objectContaining({
      id: 'loopback',
      type: 'direct',
      participants: [OWN_ADDRESS.userId, LOOPBACK_PEER.userId],
      peer: LOOPBACK_PEER,
      session_state: 'established',
    }));
  });

  it('caches the live CryptoStore for the backup capture/restore paths', () => {
    // Backup setup reads the identity bundle straight off this reference.
    expect(getOwnCryptoStore()).not.toBeNull();
  });

  it('returns the SAME singleton on a second call', async () => {
    await expect(getMessengerRuntime('loopback-memory')).resolves.toBe(runtime);
  });
});

describe('sendText — the optimistic bubble lifecycle', () => {
  it('appends `sending`, then attaches ciphertext and advances to delivered', async () => {
    const cid = 'c-lifecycle';
    await runtime.sendText(cid, 'hello ratchet');

    const [msg] = rows(cid);
    expect(msg).toEqual(expect.objectContaining({
      conversation_id: cid,
      sender_id: 'self',
      type: 'text',
      content: 'hello ratchet',
      is_encrypted: true,
      peer: LOOPBACK_PEER,
    }));
    // `delivered` is only reachable because the ECHO PEER decrypted it — this
    // is an end-to-end ratchet proof, not a status assignment.
    expect(msg.status).toBe('delivered');
    expect(msg.ciphertext).toBeDefined();
  });

  it('carries ttlSeconds through as an absolute expires_at, and the reply quote', async () => {
    const cid = 'c-options';
    const before = Date.now();
    await runtime.sendText(cid, 'burn me', {
      ttlSeconds: 3600,
      replyTo: {messageId: 'target-id', preview: 'the quoted line'},
    });

    const [msg] = rows(cid);
    expect(msg.expires_at).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(msg.reply_to_msg_id).toBe('target-id');
    expect(msg.reply_to_preview).toBe('the quoted line');
  });

  it('accepts the legacy BARE-ADDRESS third argument as well as the options object', async () => {
    // Both shapes ship in the codebase; collapsing them would break loopback
    // callers silently (a SessionAddress has no `peer` field to read).
    const cid = 'c-legacy-shape';
    await runtime.sendText(cid, 'legacy call shape', LOOPBACK_PEER);

    expect(rows(cid)[0].peer).toEqual(LOOPBACK_PEER);
    expect(rows(cid)[0].status).toBe('delivered');
  });

  it('marks the bubble FAILED, surfaces the error and RETHROWS when encryption fails', async () => {
    // ChatScreen relies on all three: the durable failed bubble (tap-to-retry),
    // the error bar, and the throw that stops it clearing the composer.
    const cid = 'c-failure';
    const noSession = {userId: 'never-met-this-peer', deviceId: 1};

    await expect(runtime.sendText(cid, 'doomed', {peer: noSession})).rejects.toBeDefined();

    expect(rows(cid)[0].status).toBe('failed');
    expect(store().error).toBeTruthy();
    store().setError(null);
  });

  it('the loopback echo replies with the DECRYPTED plaintext after its delay', async () => {
    const cid = 'c-echo';
    await runtime.sendText(cid, 'ping');
    expect(rows(cid)).toHaveLength(1);

    await waitFor(() => rows(cid).length > 1);

    const reply = rows(cid)[1];
    expect(reply).toBeDefined();
    // The body came back through echoPeer.encrypt -> own.decrypt. If the
    // ratchet were broken this would be missing, not merely wrong.
    expect(reply.content).toBe('Echo: ping');
    expect(reply.sender_id).toBe(LOOPBACK_PEER.userId);
    expect(reply.status).toBe('delivered');
    expect(reply.ciphertext).toBeDefined();
  }, 20000);

  it('a GROUP conversation echoes once per other participant instead of the 1:1 auto-reply', async () => {
    const cid = 'c-group-echo';
    store().upsertConversation({
      id: cid,
      type: 'group',
      name: 'Team',
      participants: [OWN_ADDRESS.userId, 'member-a', 'member-b'],
      unread_count: 0,
      is_muted: false,
      created_at: new Date().toISOString(),
      peer: LOOPBACK_PEER,
      session_state: 'established',
    });

    await runtime.sendText(cid, 'roll call');
    await waitFor(() => rows(cid).length >= 3);

    const senders = rows(cid).map(m => m.sender_id);
    expect(senders).toContain('member-a');
    expect(senders).toContain('member-b');
    // The 1:1 auto-reply must NOT also fire, or a group would show a phantom
    // message from the echo peer.
    expect(senders).not.toContain(LOOPBACK_PEER.userId);
  }, 20000);
});

describe('processIncoming — the seam the WS transport feeds in production', () => {
  it('decrypts a real ciphertext and appends it attributed to the peer', async () => {
    const cid = 'c-incoming';
    const ct = await runtime.echoPeer!.encrypt(OWN_ADDRESS, 'from the wire');

    await runtime.processIncoming(cid, LOOPBACK_PEER, ct);

    expect(rows(cid)[0]).toEqual(expect.objectContaining({
      content: 'from the wire',
      sender_id: LOOPBACK_PEER.userId,
      status: 'delivered',
      is_encrypted: true,
    }));
  });
});

describe('the mutation stubs the UI calls unconditionally', () => {
  it('sendReaction adds then removes the local `self` reaction', async () => {
    const cid = 'c-reactions';
    await runtime.sendText(cid, 'react to me');
    const id = rows(cid)[0].id;

    await runtime.sendReaction(LOOPBACK_PEER, cid, id, '🔥');
    expect(rows(cid)[0].reactions).toEqual({self: '🔥'});

    await runtime.sendReaction(LOOPBACK_PEER, cid, id, '🔥', true);
    expect(rows(cid)[0].reactions).toEqual({});
  });

  it('sendReaction is inert for an unknown conversation or an unknown message', async () => {
    await expect(runtime.sendReaction(LOOPBACK_PEER, 'no-such-convo', 'x', '👍')).resolves.toBeUndefined();
    const cid = 'c-reaction-miss';
    await runtime.sendText(cid, 'anchor');
    await runtime.sendReaction(LOOPBACK_PEER, cid, 'not-a-real-id', '👍');
    expect(rows(cid)[0].reactions).toBeUndefined();
  });

  it('sendMessageEdit patches only a message that exists', async () => {
    const cid = 'c-edit';
    await runtime.sendText(cid, 'original');
    const id = rows(cid)[0].id;

    await runtime.sendMessageEdit(LOOPBACK_PEER, cid, 'not-a-real-id', 'ghost edit');
    expect(rows(cid)[0].content).toBe('original');

    await runtime.sendMessageEdit(LOOPBACK_PEER, cid, id, 'edited body');
    expect(rows(cid)[0].content).toBe('edited body');
  });

  it('sendDeleteForEveryone tombstones only a message that exists', async () => {
    const cid = 'c-delete';
    await runtime.sendText(cid, 'delete me');
    const id = rows(cid)[0].id;

    await runtime.sendDeleteForEveryone(LOOPBACK_PEER, cid, 'not-a-real-id');
    expect(rows(cid)[0].content).toBe('delete me');

    await runtime.sendDeleteForEveryone(LOOPBACK_PEER, cid, id);
    expect(rows(cid)[0].content).not.toBe('delete me');
  });

  it('presence / typing / outbox / drain stubs are callable and never throw', async () => {
    // ChatScreen calls these transport-agnostically; a throw here crashes the
    // screen in dev mode.
    expect(() => {
      runtime.subscribePresence(['a']);
      runtime.unsubscribePresence(['a']);
      runtime.setActivity('active');
      runtime.sendTyping(LOOPBACK_PEER, 'start', 'c-x');
      runtime.markRead('c-x');
    }).not.toThrow();
    // B-703 MR-1 re-point: pullEnvelopes REPORTS instead of returning void, so
    // the killed-app lane can tell an ingested drain from a failed one. The
    // rule here is unchanged (callable, never throws); loopback has no relay,
    // so its report is an honest empty drain — never a 'failed' one.
    await expect(runtime.pullEnvelopes()).resolves.toEqual(
      {ok: true, pulled: 0, acked: 0, skipped: 0, leftOnRelay: 0},
    );
    await expect(runtime.discardOutboxForMessage('m1')).resolves.toBeUndefined();
    await expect(runtime.resetSessionWith(LOOPBACK_PEER)).resolves.toBeUndefined();
  });

  it('the ChatInfo verification surface returns inert defaults instead of throwing', async () => {
    await expect(runtime.getPeerVerification(LOOPBACK_PEER)).resolves.toBeNull();
    await expect(runtime.markPeerVerified(LOOPBACK_PEER, '123')).resolves.toBe(false);
    await expect(runtime.clearPeerVerification(LOOPBACK_PEER)).resolves.toBeUndefined();
    await expect(runtime.listIdentityRotations(LOOPBACK_PEER)).resolves.toEqual([]);
    await expect(runtime.broadcastGroupCallPresence([], {
      roomId: 'r', participantTag: 't', displayName: 'd', callType: 'voice',
    })).resolves.toBeUndefined();
  });
});

describe('safety number', () => {
  // The RENDERING of the 60-digit code is `computeSafetyNumber`'s own contract
  // and is pinned by `safetyNumber.test.ts` — it costs 5200 awaited SHA-256
  // iterations, so re-running it here would only buy a 30s+ suite. What is
  // untested elsewhere is the runtime's own guard around it.
  it('throws rather than inventing a number when the peer identity is unknown', async () => {
    await expect(runtime.getSafetyNumber({userId: 'stranger', deviceId: 1}))
      .rejects.toThrow(/peer identity unavailable/);
  });
});

describe('group creation stubs', () => {
  it('createGroupChat stashes a conversation whose participants include SELF', async () => {
    const {conversationId, groupId} = await runtime.createGroupChat({
      name: 'Dev Group', members: ['m1', 'm2'],
    });

    expect(conversationId).toBe(groupId);
    const conv = store().conversations[groupId];
    expect(conv).toEqual(expect.objectContaining({
      type: 'group',
      name: 'Dev Group',
      participants: [OWN_ADDRESS.userId, 'm1', 'm2'],
    }));
  });

  it('ensureAssignedGroup is idempotent and reports whether the row already existed', async () => {
    const gid = 'mission-ops-room-1';
    const first = await runtime.ensureAssignedGroup({groupId: gid, name: 'Ops', members: ['cpo-1']});
    expect(first).toEqual({groupId: gid, alreadyExisted: false});

    const second = await runtime.ensureAssignedGroup({groupId: gid, name: 'Renamed', members: []});
    expect(second).toEqual({groupId: gid, alreadyExisted: true});
    // Idempotent means it must NOT re-write the row under a new name.
    expect(store().conversations[gid].name).toBe('Ops');
  });

  it('falls back to SELF as the peer when a group is created with no members', async () => {
    const {groupId} = await runtime.createGroupChat({name: 'Solo', members: []});
    expect(store().conversations[groupId].peer).toEqual({userId: OWN_ADDRESS.userId, deviceId: 1});
  });
});

describe('the singleton + owner-key lifecycle the LOGOUT/WIPE path depends on', () => {
  const cfg = {ownerKey: 'owner@bravo.test', ownUserId: 'uuid-1'} as
    Parameters<typeof configureMessengerRuntime>[0];

  afterEach(() => { _resetMessengerRuntime(); });

  it('getActiveOwnerKey is null before configure, then prefers ownerKey over the UUID', () => {
    _resetMessengerRuntime();
    expect(getActiveOwnerKey()).toBeNull();

    configureMessengerRuntime(cfg);
    // The UUID rotates on every dev re-register; keying the SQLCipher file on
    // it would orphan the DB each time.
    expect(getActiveOwnerKey()).toBe('owner@bravo.test');
  });

  it('falls back to ownUserId when no ownerKey was supplied', () => {
    configureMessengerRuntime({ownUserId: 'uuid-only'} as Parameters<typeof configureMessengerRuntime>[0]);
    expect(getActiveOwnerKey()).toBe('uuid-only');
  });

  it('BS-RESTORE — _resetMessengerRuntimeKeepConfig drops the singleton but KEEPS the config', () => {
    // Using the full reset here nulled the config, so the immediate rebuild
    // threw "requires configureMessengerRuntime(cfg) first" and MessengerHome
    // painted a red error bar until a manual close+reopen.
    configureMessengerRuntime(cfg);
    _resetMessengerRuntimeKeepConfig();
    expect(getActiveOwnerKey()).toBe('owner@bravo.test');
    expect(getOwnCryptoStore()).toBeNull();

    _resetMessengerRuntime();
    expect(getActiveOwnerKey()).toBeNull();
  });
});
