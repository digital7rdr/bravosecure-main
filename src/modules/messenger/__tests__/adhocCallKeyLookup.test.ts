/**
 * Regression — ad-hoc ('Call') group master-key id resolution.
 *
 * History: an escalated 1:1 call failed on the JOINER with
 * "FrameCryptorOrchestrator: no group master key" (build 67) because of
 * id mismatches on the asymmetric `direct:<x>` thread key; the fixes
 * aliased the minted 'Call' state under chat-bearing ids — and those
 * aliases became the seed of B-124/B-125 (a `type:'direct'` row with a
 * stray 'Call' key was group-routed forever).
 *
 * B-124 root fix (handoff item 2, founder-approved 2026-07-21): 'Call'
 * states live ONLY under their own minted 32-hex ids; the link from a
 * lookup handle (`direct:<host>` on the joiner, the origin 1:1 id on the
 * host) to the minted id lives in the callKeyRegistry. These tests
 * exercise the REAL registry module (not a mirrored copy) plus the
 * remaining pure guards:
 *
 *   - resolveGroupForCall: mapping-first resolution with raw-slot
 *     fallback (real groups have no mapping and pass through).
 *   - joiner slot resolution (B-10/B-13/B-15 semantics preserved).
 *   - resync owner + roster guards.
 *   - recv inbox-row guard (BS-CALL-GHOST) and mint guard (B-15).
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
  loadCallKeyRegistry,
  resolveCallKeyGroupId,
  setCallKeyMapping,
  deleteCallKeyMapping,
  resolveGroupForCall,
  _resetCallKeyRegistryForTests,
} from '../runtime/callKeyRegistry';
import {isCallGroupState} from '../runtime/messagingLogic';

type Groups = Record<string, {masterKeyB64?: string; owner?: string} | undefined>;

// Mirrors the joiner's key-slot resolution in useGroupCall.ts, with the
// registry indirection the hook now uses (slotHasKey → resolveGroupForCall).
function resolveKeyId(
  groups: Groups,
  opts: {conversationId: string; hostUserId?: string},
): string | undefined {
  const directLookupId = opts.hostUserId ? `direct:${opts.hostUserId}` : undefined;
  const slotHasKey = (id?: string): boolean =>
    !!id && !!resolveGroupForCall(groups, id)?.masterKeyB64;
  const groupOwner = groups[opts.conversationId]?.owner;
  const hostIsAdmin = !opts.hostUserId || !groupOwner || groupOwner === opts.hostUserId;
  const isAdHocCall = opts.conversationId.startsWith('direct:');
  if (!hostIsAdmin && isAdHocCall && directLookupId) {
    return slotHasKey(directLookupId) ? directLookupId : undefined;
  }
  if (slotHasKey(opts.conversationId)) {return opts.conversationId;}
  if (directLookupId && slotHasKey(directLookupId)) {return directLookupId;}
  return undefined;
}

// Mirrors the resync eligibility guard in ensureCallGroupKey: re-broadcast
// the mapped state only when we OWN it and its roster still covers every
// current recipient (a grown roster mints fresh instead — broadcastToGroup
// only reaches state.members, so resync would strand new invitees keyless).
function mayResyncMapped(
  mapped: {masterKeyB64?: string; owner?: string; members?: Record<string, unknown>} | undefined,
  ownUserId: string,
  others: string[],
): boolean {
  return !!mapped?.masterKeyB64
    && mapped.owner === ownUserId
    && others.every(uid => !!mapped.members?.[uid]);
}

// The recv-side inbox-row guard (BS-CALL-GHOST) — #9 (critic N4): was a
// hand-rolled MIRROR of the comparison (the test-fake-reimplements-the-
// decision trap: change CALL_GROUP_NAME and the mirror stays green while
// production moves). Unlike this file's other mirrors, the real
// predicate is importable at zero cost, so use it.
function shouldUpsertConversation(groupState: {name: string}): boolean {
  return !isCallGroupState(groupState);
}

// Mirrors the owner-poison guard (BS-CALL-REALGROUP-MINT / B-15).
type Conversations = Record<string, {type?: string}>;
function isRealGroupOwnedByOther(
  conversationId: string,
  conversations: Conversations,
  groups: Groups,
  ownUserId: string,
): boolean {
  if (conversationId.startsWith('direct:')) {return false;}
  const convType = conversations[conversationId]?.type;
  if (convType === 'group' || convType === 'ops_channel') {return true;}
  const g = groups[conversationId];
  return !!(g?.masterKeyB64 && g.owner && g.owner !== ownUserId);
}

const HOST = '5943a323-3136-47e4-acb5-30c26b7007e3';
const JOINER = '3165d0e1-0d3f-4d8c-be5d-a4b85d11b453';
const MINTED = 'be6161ba38320000aa55cc00dd11ee22';

beforeEach(async () => {
  const AsyncStorage =
    (require('@react-native-async-storage/async-storage') as {default: {clear: () => Promise<void>}}).default;
  await AsyncStorage.clear();
  _resetCallKeyRegistryForTests();
  await loadCallKeyRegistry('test-owner');
});

describe('callKeyRegistry — mapping semantics (B-124 root fix)', () => {
  it('maps an origin id to the minted id and resolves it back', () => {
    setCallKeyMapping(`direct:${HOST}`, MINTED);
    expect(resolveCallKeyGroupId(`direct:${HOST}`)).toBe(MINTED);
  });

  it('returns the PREVIOUS minted id when a mapping is replaced (GC hook)', () => {
    setCallKeyMapping(`direct:${HOST}`, MINTED);
    const replaced = setCallKeyMapping(`direct:${HOST}`, 'ffffffffffffffffffffffffffffffff');
    expect(replaced).toBe(MINTED);
  });

  it('re-filing the SAME minted id reports nothing to GC', () => {
    setCallKeyMapping(`direct:${HOST}`, MINTED);
    expect(setCallKeyMapping(`direct:${HOST}`, MINTED)).toBeUndefined();
  });

  it('REFUSES a direct:-shaped target — a chat id can never be a minted call id', () => {
    expect(setCallKeyMapping(`direct:${HOST}`, `direct:${JOINER}`)).toBeUndefined();
    expect(resolveCallKeyGroupId(`direct:${HOST}`)).toBeUndefined();
  });

  it('REFUSES a self-mapping', () => {
    setCallKeyMapping(MINTED, MINTED);
    expect(resolveCallKeyGroupId(MINTED)).toBeUndefined();
  });

  it('delete removes the link', () => {
    setCallKeyMapping(`direct:${HOST}`, MINTED);
    deleteCallKeyMapping(`direct:${HOST}`);
    expect(resolveCallKeyGroupId(`direct:${HOST}`)).toBeUndefined();
  });

  it('an owner switch resets the map (multi-account device)', async () => {
    setCallKeyMapping(`direct:${HOST}`, MINTED);
    await loadCallKeyRegistry('other-owner');
    expect(resolveCallKeyGroupId(`direct:${HOST}`)).toBeUndefined();
  });

  it('persists across a reload for the SAME owner', async () => {
    setCallKeyMapping(`direct:${HOST}`, MINTED);
    _resetCallKeyRegistryForTests();
    await loadCallKeyRegistry('test-owner');
    expect(resolveCallKeyGroupId(`direct:${HOST}`)).toBe(MINTED);
  });
});

describe('resolveGroupForCall — mapping-first with raw fallback', () => {
  it('resolves the MINTED state through a mapping', () => {
    setCallKeyMapping(`direct:${HOST}`, MINTED);
    const groups: Groups = {[MINTED]: {masterKeyB64: 'k', owner: HOST}};
    expect(resolveGroupForCall(groups, `direct:${HOST}`)).toBe(groups[MINTED]);
  });

  it('falls through to the raw slot when no mapping exists (real groups)', () => {
    const realConvo = '3cb79cb1f1b0e0be3ff9c2df76344a0f';
    const groups: Groups = {[realConvo]: {masterKeyB64: 'realK', owner: HOST}};
    expect(resolveGroupForCall(groups, realConvo)).toBe(groups[realConvo]);
  });

  it('falls through to the raw slot when the mapped state is keyless/gone', () => {
    setCallKeyMapping(`direct:${HOST}`, MINTED);
    const groups: Groups = {[`direct:${HOST}`]: {masterKeyB64: 'legacyAlias', owner: HOST}};
    expect(resolveGroupForCall(groups, `direct:${HOST}`)).toBe(groups[`direct:${HOST}`]);
  });

  it('returns undefined when neither mapped nor raw slot holds anything', () => {
    expect(resolveGroupForCall({}, `direct:${HOST}`)).toBeUndefined();
  });
});

describe('ad-hoc call key — joiner lookup id (registry edition)', () => {
  it('ad-hoc joiner resolves via the direct:<host> HANDLE mapped to the minted state', () => {
    // The receiver's create-recv files handle→minted in the registry; the
    // state itself lives only under MINTED. resolveKeyId returns the
    // HANDLE (the keySource indirects), never the joiner's own id.
    setCallKeyMapping(`direct:${HOST}`, MINTED);
    const groups: Groups = {[MINTED]: {masterKeyB64: 'k', owner: HOST}};
    const opts = {conversationId: `direct:${JOINER}`, hostUserId: HOST};
    expect(resolveKeyId(groups, opts)).toBe(`direct:${HOST}`);
    expect(resolveKeyId(groups, opts)).not.toBe(opts.conversationId);
  });

  it('BS-CALL-REALGROUP — real-group joiner resolves under the real conversationId even when hostUserId is set', () => {
    const realConvo = '3cb79cb1f1b0e0be3ff9c2df76344a0f';
    const opts = {conversationId: realConvo, hostUserId: HOST};
    const groups: Groups = {[realConvo]: {masterKeyB64: 'k', owner: HOST}};
    expect(resolveKeyId(groups, opts)).toBe(realConvo);
    expect(resolveKeyId(groups, opts)).not.toBe(`direct:${HOST}`);
  });

  it('fails closed (undefined) when NEITHER the mapping nor a raw slot holds a key', () => {
    const opts = {conversationId: '3cb79cb1f1b0e0be3ff9c2df76344a0f', hostUserId: HOST};
    expect(resolveKeyId({}, opts)).toBeUndefined();
    // A mapping to a state that never landed is not a match either.
    setCallKeyMapping(`direct:${HOST}`, MINTED);
    expect(resolveKeyId({}, opts)).toBeUndefined();
  });

  it('B-13 — non-OWNER host of a REAL group: joiner keys off the REAL conversationId, NOT an ad-hoc slot', () => {
    const realConvo = '3cb79cb1f1b0e0be3ff9c2df76344a0f';
    const ADMIN = 'fahim-owner-id';
    const opts = {conversationId: realConvo, hostUserId: HOST};
    const groups: Groups = {[realConvo]: {masterKeyB64: 'realAdminKey', owner: ADMIN}};
    expect(resolveKeyId(groups, opts)).toBe(realConvo);
  });

  it('B-13 — non-owner host, real group: a stray mapped ad-hoc key from an UNRELATED escalation is ignored', () => {
    setCallKeyMapping(`direct:${HOST}`, MINTED);
    const realConvo = '3cb79cb1f1b0e0be3ff9c2df76344a0f';
    const ADMIN = 'fahim-owner-id';
    const opts = {conversationId: realConvo, hostUserId: HOST};
    const groups: Groups = {
      [realConvo]: {masterKeyB64: 'realAdminKey', owner: ADMIN},
      [MINTED]:    {masterKeyB64: 'strayAdhocKey', owner: HOST},
    };
    expect(resolveKeyId(groups, opts)).toBe(realConvo);
  });

  it('B-10 — AD-HOC (direct:*) non-owner host: joiner keys off the direct:<host> handle, NOT a stale raw slot', () => {
    // Pre-fix builds could leave a stale state AT the direct:* conversation
    // id (owned by the other party ⇒ !hostIsAdmin). The forced branch must
    // pick the mapped fresh key, never the stale raw slot.
    setCallKeyMapping(`direct:${HOST}`, MINTED);
    const adhocConvo = `direct:${JOINER}`;
    const opts = {conversationId: adhocConvo, hostUserId: HOST};
    const groups: Groups = {
      [adhocConvo]: {masterKeyB64: 'staleKey', owner: JOINER},
      [MINTED]:     {masterKeyB64: 'adhocCallKey', owner: HOST},
    };
    expect(resolveKeyId(groups, opts)).toBe(`direct:${HOST}`);
    expect(resolveKeyId(groups, opts)).not.toBe(adhocConvo);
  });

  it('B-10 — AD-HOC non-owner host: joiner WAITS (undefined) while the create is in-flight', () => {
    const adhocConvo = `direct:${JOINER}`;
    const opts = {conversationId: adhocConvo, hostUserId: HOST};
    const groups: Groups = {[adhocConvo]: {masterKeyB64: 'staleKey', owner: JOINER}};
    expect(resolveKeyId(groups, opts)).toBeUndefined();
  });

  it('falls back to conversationId when hostUserId is absent (host path / real groups)', () => {
    const opts = {conversationId: 'group:abc123'};
    const groups: Groups = {'group:abc123': {masterKeyB64: 'k', owner: HOST}};
    expect(resolveKeyId(groups, opts)).toBe('group:abc123');
  });
});

describe('ad-hoc call key — resync guards (owner + roster)', () => {
  const members = {[HOST]: {}, [JOINER]: {}};

  it('re-broadcasts a mapped state the host OWNS whose roster covers the ring', () => {
    const mapped = {masterKeyB64: 'k', owner: HOST, members};
    expect(mayResyncMapped(mapped, HOST, [JOINER])).toBe(true);
  });

  it('REFUSES to re-broadcast a state owned by the OTHER party (forgery-guard drop)', () => {
    const stale = {masterKeyB64: 'k', owner: JOINER, members};
    expect(mayResyncMapped(stale, HOST, [JOINER])).toBe(false);
  });

  it('REFUSES resync when the ring includes someone OUTSIDE the minted roster (mint fresh instead)', () => {
    const mapped = {masterKeyB64: 'k', owner: HOST, members};
    expect(mayResyncMapped(mapped, HOST, [JOINER, 'new-invitee'])).toBe(false);
  });

  it('does not resync when there is no key at all', () => {
    expect(mayResyncMapped(undefined, HOST, [JOINER])).toBe(false);
    expect(mayResyncMapped({owner: HOST, members}, HOST, [JOINER])).toBe(false);
  });
});

describe('ad-hoc call key — recv inbox-row guard (BS-CALL-GHOST)', () => {
  it('does NOT upsert a conversation row for an ad-hoc "Call" group', () => {
    expect(shouldUpsertConversation({name: 'Call'})).toBe(false);
  });

  it('DOES upsert a conversation row for a real named group', () => {
    expect(shouldUpsertConversation({name: 'SQA - Fahim'})).toBe(true);
    expect(shouldUpsertConversation({name: 'Engineering'})).toBe(true);
  });

  it('guard is exact — "Call " / "Call Team" are real groups', () => {
    expect(shouldUpsertConversation({name: 'Call '})).toBe(true);
    expect(shouldUpsertConversation({name: 'Call Team'})).toBe(true);
  });
});

describe('ad-hoc call key — owner-poison mint guard (B-15)', () => {
  const realConvo = '3cb79cb1f1b0e0be3ff9c2df76344a0f';

  it('REFUSES to mint over a real group whose stored owner is the OTHER party', () => {
    const groups: Groups = {[realConvo]: {masterKeyB64: 'realK', owner: JOINER}};
    expect(isRealGroupOwnedByOther(realConvo, {}, groups, HOST)).toBe(true);
  });

  it('REFUSES to mint when the stored conversation row is a real group/ops_channel', () => {
    expect(isRealGroupOwnedByOther(realConvo, {[realConvo]: {type: 'group'}}, {}, HOST)).toBe(true);
    expect(isRealGroupOwnedByOther(realConvo, {[realConvo]: {type: 'ops_channel'}}, {}, HOST)).toBe(true);
  });

  it('ALLOWS minting for a direct:* ad-hoc (escalated 1:1) id', () => {
    const directId = `direct:${JOINER}`;
    const groups: Groups = {[directId]: {masterKeyB64: 'k', owner: JOINER}};
    expect(isRealGroupOwnedByOther(directId, {}, groups, HOST)).toBe(false);
  });

  it('a bare ad-hoc mint target (no conv row, no stale owner) is mintable', () => {
    expect(isRealGroupOwnedByOther(`direct:${JOINER}`, {}, {}, HOST)).toBe(false);
  });
});
