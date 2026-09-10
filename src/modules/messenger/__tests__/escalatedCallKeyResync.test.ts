/**
 * B-358 — 1:1 → group ESCALATION ("Add" in a 1:1 call): the added third member
 * rings, joins the SFU room, then dies at step 3b — "no group master key" —
 * while the HOST that minted the key declines their key-request with
 * "we hold no state for this group". Regular group calls and group-call Add
 * are fine (they speak the group's real, shared id); ONLY escalation fails.
 *
 * Proven on-device 2026-08-01 (vc238 [KEYDIAG] logs, group "kotiss"):
 *   joiner:  step=3b waiting under 'direct:<hostUid>'          ← probes the right slot
 *   joiner:  requested key for 'direct:<its OWN uid>'          ← asks under the WRONG id
 *   host:    decline — we hold no state for this group         ← raw groups[id] lookup
 *
 * Root cause: the B-124 root fix moved 'Call' states under their minted ids
 * with `resolveCallKeyGroupId` as the handle translation — and the epoch
 * lookup inside requestGroupKeyResyncImpl learned the translation, but TWO
 * other consumers never did (§5 caller-completeness miss):
 *   1. applyGroupAdmin's key-request SERVE branch kept the raw wire-id lookup,
 *      so a request naming any `direct:` handle is declined by the very device
 *      that minted the key;
 *   2. the joiner requests under `opts.conversationId` — the HOST's local slot
 *      name shipped verbatim in the ring, which on the joiner denotes itself —
 *      instead of the `direct:<host>` handle its own key-wait probes.
 *
 * The fix does NOT change the wire, the namespace, or any verification: the
 * roster gate here and the owner/signature/roster gates inside
 * reshareGroupKeyState all still run — against the state that actually holds
 * the key, resolved through the SAME registry every other B-124 consumer uses.
 */

const asyncStore: Record<string, string> = {};
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (k: string) => asyncStore[k] ?? null),
    setItem: jest.fn(async (k: string, v: string) => { asyncStore[k] = v; }),
    removeItem: jest.fn(async (k: string) => { delete asyncStore[k]; }),
  },
}));
// The key-request branch returns before any of these are reached — stub the
// heavy siblings so the node project never loads RN transitively.
jest.mock('../crypto/expectedSenderIdentity', () => ({resolveExpectedSenderIdentity: jest.fn()}));
jest.mock('../runtime/groupEventMessage', () => ({
  appendGroupPhotoChangedEvent: jest.fn(),
  appendMemberAddedEvent: jest.fn(),
  appendMemberRemovedEvent: jest.fn(),
}));
jest.mock('../runtime/applyGroupRename', () => ({applyGroupRenameToUi: jest.fn()}));
jest.mock('../runtime/decryptFailureSignal', () => ({noteDestroyedEnvelope: jest.fn()}));

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {applyGroupAdmin} from '../runtime/applyGroupAdmin';
import {setCallKeyMapping, _resetCallKeyRegistryForTests} from '../runtime/callKeyRegistry';
import type {GroupState} from '@bravo/messenger-core';

const HOST_UID  = 'host-uid-5b6bb831';
const JOINER    = 'joiner-uid-88d34848';
const MINTED_ID = 'a'.repeat(32);

function mintedState(members: string[]): GroupState {
  return {
    groupId: MINTED_ID,
    name: 'Call',
    owner: HOST_UID,
    members: Object.fromEntries(members.map(u => [u, {deviceId: 1, admin: u === HOST_UID, joinedAt: 1}])),
    masterKeyB64: 'bWFzdGVy',
    epoch: 1,
    createdAt: 1,
    updatedAt: 1,
  } as GroupState;
}

function run(requestedId: string, existing: GroupState | undefined, groups: Record<string, GroupState>) {
  return applyGroupAdmin(
    {
      action: {type: 'key-request', groupId: requestedId} as never,
      peer: {userId: JOINER, deviceId: 1},
      existing,
      envelopeId: 'env-1',
      wireGroupId: requestedId,
      senderIdentityKey: 'sender-ik',
    },
    {
      store: {groups, setGroupState: jest.fn()},
      getState: () => ({groups, conversations: {}, setGroupState: jest.fn(), setError: jest.fn()}),
      ownStore: {} as never,
      keys: null,
      peerIdentityCache: {} as never,
      ownUserId: HOST_UID,
      pendingAdminActions: null,
      emitGroupKeySignal: jest.fn(),
      crashLog: jest.fn(),
    },
  );
}

describe('B-358 — escalated-call key-request serve translation (host side)', () => {
  beforeEach(() => {
    _resetCallKeyRegistryForTests();
    Object.keys(asyncStore).forEach(k => { delete asyncStore[k]; });
    jest.clearAllMocks();
  });

  it('a key-request naming a registry HANDLE is served from the minted state (was: declined "no state")', async () => {
    const groups = {[MINTED_ID]: mintedState([HOST_UID, JOINER, 'third'])};
    setCallKeyMapping(`direct:${HOST_UID}`, MINTED_ID);

    const outcome = await run(`direct:${HOST_UID}`, undefined, groups);

    expect(outcome).toEqual({kind: 'reshare-group-key', groupId: MINTED_ID, toUserId: JOINER});
  });

  it('the roster gate survives the translation: a NON-member is still declined — and now triggers the B-365 roster resync', async () => {
    const groups = {[MINTED_ID]: mintedState([HOST_UID, 'someone-else'])};
    setCallKeyMapping(`direct:${HOST_UID}`, MINTED_ID);

    const outcome = await run(`direct:${HOST_UID}`, undefined, groups);

    // NEVER a reshare (the key must not leak to a non-member) — but a
    // roster-gated decline now asks the owner for the current signed state,
    // because OUR copy may be the stale one (Ariful↔Ae2 drift).
    expect(outcome).toEqual({kind: 'request-group-key', groupId: MINTED_ID, divergence: false});
  });

  it('an unmapped id with no state is declined exactly as before', async () => {
    const outcome = await run('direct:total-stranger', undefined, {});
    expect(outcome).toBeUndefined();
  });

  it('a direct wire-id hit (args.existing) still serves without touching the registry', async () => {
    const st = mintedState([HOST_UID, JOINER]);
    const outcome = await run(MINTED_ID, st, {[MINTED_ID]: st});
    expect(outcome).toEqual({kind: 'reshare-group-key', groupId: MINTED_ID, toUserId: JOINER});
  });

  // B-362r2 — the 2026-08-01 13:59 repro: the host's registry held NO
  // self-handle mapping at all (the mint-time write sat on the fresh-mint
  // path; the reuse lane returned early), and the first B-358 test only
  // passed because it SEEDED the mapping by hand. These cases run with an
  // EMPTY registry — the serve path must resolve `direct:<own uid>`
  // structurally from the ad-hoc state the host owns.
  it('with NO registry mapping, a request naming direct:<self> serves from the owned Call state containing the requester', async () => {
    const groups = {[MINTED_ID]: mintedState([HOST_UID, JOINER, 'third'])};
    const outcome = await run(`direct:${HOST_UID}`, undefined, groups);
    expect(outcome).toEqual({kind: 'reshare-group-key', groupId: MINTED_ID, toUserId: JOINER});
  });

  it('structural resolution prefers the NEWEST owned Call state holding the requester', async () => {
    const older = {...mintedState([HOST_UID, JOINER]), groupId: 'b'.repeat(32), updatedAt: 1};
    const newer = {...mintedState([HOST_UID, JOINER]), groupId: 'c'.repeat(32), updatedAt: 9};
    const outcome = await run(`direct:${HOST_UID}`, undefined, {[older.groupId]: older, [newer.groupId]: newer});
    expect(outcome).toEqual({kind: 'reshare-group-key', groupId: newer.groupId, toUserId: JOINER});
  });

  it('structural resolution never serves a NON-member, a keyless state, or a state we do not own', async () => {
    const notMember = {...mintedState([HOST_UID, 'someone-else']), groupId: 'd'.repeat(32)};
    const keyless   = {...mintedState([HOST_UID, JOINER]), groupId: 'e'.repeat(32), masterKeyB64: ''};
    const foreign   = {...mintedState([HOST_UID, JOINER]), groupId: 'f'.repeat(32), owner: 'someone-else'};
    const outcome = await run(`direct:${HOST_UID}`, undefined, {
      [notMember.groupId]: notMember, [keyless.groupId]: keyless, [foreign.groupId]: foreign,
    });
    expect(outcome).toBeUndefined();
  });

  it('a request naming a DIFFERENT user\'s direct handle is never resolved structurally', async () => {
    const groups = {[MINTED_ID]: mintedState([HOST_UID, JOINER])};
    const outcome = await run('direct:not-our-uid', undefined, groups);
    expect(outcome).toBeUndefined();
  });
});

describe('B-358 — joiner requests under the handle its own key-wait probes (source scan)', () => {
  it('the step-3b resync id prefers direct:<host> for an ad-hoc (direct:) call', () => {
    // The joiner used to pass opts.conversationId verbatim — the HOST's local
    // slot name from the ring, which on the joiner denotes ITSELF and on the
    // host (post-B-124) holds no state either. The request must name the same
    // id the wait's hasKey() probes: direct:<host> for ad-hoc calls, the real
    // conversation id otherwise.
    const src = readFileSync(
      join(process.cwd(), 'src', 'modules', 'messenger', 'webrtc', 'useGroupCall.ts'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    // Anchor on the JOINER's step-3b wait block — the file has an earlier
    // requestGroupKeyResync call site (the host-of-a-real-group step-3a heal)
    // where opts.conversationId is a REAL group id and correct verbatim.
    const anchor = src.indexOf('step=3b waiting for group master key');
    expect(anchor).toBeGreaterThan(-1);
    const kick = src.indexOf('requestGroupKeyResync(', anchor);
    expect(kick).toBeGreaterThan(anchor);
    const window = src.slice(anchor, kick + 120);
    expect(window).toContain('resyncId');
    expect(window).toMatch(/startsWith\('direct:'\)[\s\S]{0,160}?directLookupId/);
    expect(src.slice(kick, kick + 120)).toContain('resyncId');
  });
});
