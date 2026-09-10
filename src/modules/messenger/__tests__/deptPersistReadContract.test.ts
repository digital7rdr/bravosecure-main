/**
 * F4 (adversarial review, 2026-08-04) — the KILLED-APP half of the department
 * notification-tap fix had no gate at all.
 *
 * `resolveDeptRouteForTap` falls back to `resolvePersistedDeptMaps()` when the
 * live store has not hydrated — which is the whole point of the cold-boot lane.
 * That function reads `state.vaultByOwner[<owner>].{deptConversationIds,
 * deptGroupByChannel}` out of the raw `messenger-store-v1` blob, and NOTHING
 * proved those keys are the ones `messengerStore`'s `partialize` actually
 * writes, in that place, under that owner key.
 *
 * PROVEN DECORATIVE. The only suite that exercises the cold-boot path
 * (`deptChannelNotifTap.test.ts`) `jest.mock`s `resolvePersistedDeptMaps` and
 * feeds it a hand-built answer, so it validates a payload the test invented
 * rather than one the app persists. Repointing `readOwnerSlice`'s dept read at
 * `parsed.state` instead of the owner's vault slice left the ENTIRE
 * messenger-crypto project green — 416 suites / 4203 tests — while every
 * killed-app department tap silently degraded back to ChatScreen, the exact bug
 * F4 exists to kill. (Same class as `tests-cannot-vouch-for-invented-payloads`.)
 *
 * So this suite pins the WRITER and the READER against each other: it takes the
 * store's REAL `partialize`, serialises it the way `createJSONStorage` does, and
 * reads it back through the REAL `resolvePersistedDeptMaps`. Either half moving
 * — a partialize that drops the keys, a reader that looks in the wrong object,
 * an owner-scoping change — fails here.
 */

const mockStore = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem:    async (k: string) => mockStore.get(k) ?? null,
    setItem:    async (k: string, v: string) => { mockStore.set(k, v); },
    removeItem: async (k: string) => { mockStore.delete(k); },
  },
}));

import {useMessengerStore} from '../store/messengerStore';
import {resolvePersistedDeptMaps} from '../push/mutedLookup';
import {resolveDeptConversation} from '../push/deptChannelTarget';

const OWNER = 'owner-a-uuid';
const OTHER = 'owner-b-uuid';
const CHANNEL = 'chan-hr';
const CONVO = 'conv-hr';
const REGISTRY_ONLY = 'conv-ops';

type Persist = {
  getOptions: () => {partialize?: (s: unknown) => unknown};
};

/**
 * Write the persisted blob the way the app really does: the store's own
 * `partialize` (NOT a hand-rolled object), wrapped in the `{state, version}`
 * envelope `createJSONStorage` produces. Bypasses the 500 ms debounced storage
 * adapter, which is a delivery detail — the SHAPE is what this pins.
 */
function flushRealPersist(): void {
  const persist = (useMessengerStore as unknown as {persist: Persist}).persist;
  const partialize = persist.getOptions().partialize;
  if (!partialize) { throw new Error('messengerStore lost its partialize'); }
  const state = partialize(useMessengerStore.getState());
  mockStore.set('messenger-store-v1', JSON.stringify({state, version: 0}));
}

beforeEach(() => {
  mockStore.clear();
  useMessengerStore.getState().reset();
});

describe('F4 cold boot — the persisted dept maps the reader expects are the ones the writer emits', () => {
  it('round-trips the channel POINTER through the real partialize', async () => {
    const s = useMessengerStore.getState();
    s.setOwner(OWNER);
    s.setDeptChannelGroup(CHANNEL, CONVO);
    flushRealPersist();

    const maps = await resolvePersistedDeptMaps();

    expect(maps.deptGroupByChannel).toEqual({[CHANNEL]: CONVO});
    // The decision the tap actually makes, not just the map's presence.
    expect(resolveDeptConversation(CONVO, maps)).toEqual({channelId: CHANNEL, orgId: null});
  });

  /**
   * The state a real device is usually in: `armDeptConversationRegistry()` ran
   * at boot and filled the ADDITIVE registry from the server channel list, but
   * this device never opened the thread so there is no pointer row. Routing
   * this to Chat is the banned outcome — it must resolve DEPARTMENTAL with an
   * unknown channel id, which the caller degrades to the directory.
   */
  it('round-trips the ADDITIVE registry, which is all a never-opened channel has', async () => {
    const s = useMessengerStore.getState();
    s.setOwner(OWNER);
    s.rememberDeptConversation(REGISTRY_ONLY);
    flushRealPersist();

    const maps = await resolvePersistedDeptMaps();

    expect(maps.deptConversationIds?.[REGISTRY_ONLY]).toBe(true);
    expect(resolveDeptConversation(REGISTRY_ONLY, maps)).toEqual({channelId: null, orgId: null});
    expect(resolveDeptConversation(REGISTRY_ONLY, maps)).not.toBeNull();
  });

  /**
   * F9 — `vaultByOwner` holds every account that ever signed in on this device.
   * Reading the wrong slice would route THIS account's tap using ANOTHER
   * account's channels. `setOwner` snapshots the outgoing owner's live maps into
   * their vault entry, so this exercises the real two-account fold.
   */
  it('is scoped to the ACTIVE owner — another account\'s channels never answer', async () => {
    const s = useMessengerStore.getState();
    s.setOwner(OTHER);
    s.setDeptChannelGroup('chan-other', 'conv-other');
    useMessengerStore.getState().setOwner(OWNER);
    useMessengerStore.getState().setDeptChannelGroup(CHANNEL, CONVO);
    flushRealPersist();

    const maps = await resolvePersistedDeptMaps();

    expect(maps.deptGroupByChannel).toEqual({[CHANNEL]: CONVO});
    expect(resolveDeptConversation('conv-other', maps)).toBeNull();
  });

  it('an ordinary group in the same persisted slice keeps its Chat routing', async () => {
    const s = useMessengerStore.getState();
    s.setOwner(OWNER);
    s.setDeptChannelGroup(CHANNEL, CONVO);
    flushRealPersist();

    expect(resolveDeptConversation('g-ordinary', await resolvePersistedDeptMaps())).toBeNull();
  });

  it('degrades to empty maps (never throws) with no persisted blob at all', async () => {
    await expect(resolvePersistedDeptMaps()).resolves.toEqual({});
  });

  /**
   * Guards this suite against passing VACUOUSLY: if `flushRealPersist` ever
   * writes something the reader cannot parse, the assertions above would all
   * read `undefined` and `resolveDeptConversation` would return null — which
   * several of them already assert. Pin the envelope itself.
   */
  it('the blob really carries the owner-keyed vault slice (guards the fixture)', async () => {
    const s = useMessengerStore.getState();
    s.setOwner(OWNER);
    s.setDeptChannelGroup(CHANNEL, CONVO);
    flushRealPersist();

    const raw = mockStore.get('messenger-store-v1');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw as string) as {
      state?: {_ownUserId?: string; vaultByOwner?: Record<string, Record<string, unknown>>};
    };
    expect(parsed.state?._ownUserId).toBe(OWNER);
    expect(Object.keys(parsed.state?.vaultByOwner?.[OWNER] ?? {}))
      .toEqual(expect.arrayContaining(['deptGroupByChannel', 'deptConversationIds']));
  });
});

/**
 * Channels vs2 edge A9 — the ORG travels with the conversation, or Back lands
 * in a directory that disowns the thread the user is standing in.
 *
 * The wake structurally cannot carry it: a dept-message push is
 * `{kind, conversationId, senderUserId}` and messenger-service holds no org
 * membership data at all. `armDeptConversationRegistry` is the ONLY place the
 * client ever learns it — and only because that call is deliberately UNSCOPED.
 */
describe('edge A9 — the owning org survives the persist round-trip', () => {
  it('resolves the org when the registry learned it', () => {
    const maps = {
      deptConversationIds: {[CONVO]: true as const},
      deptGroupByChannel: {[CHANNEL]: CONVO},
      deptOrgByConversation: {[CONVO]: 'org-borealis'},
    };
    expect(resolveDeptConversation(CONVO, maps))
      .toEqual({channelId: CHANNEL, orgId: 'org-borealis'});
  });

  it('reads it from the ADDITIVE map, so a B-206 pointer remap cannot lose it', () => {
    // `deptGroupByChannel` is overwritten on a remap; `deptOrgByConversation`
    // is additive like `deptConversationIds`, which is why the org is read
    // from it rather than derived from the pointer.
    const maps = {
      deptConversationIds: {[CONVO]: true as const},
      deptGroupByChannel: {},                       // pointer remapped away
      deptOrgByConversation: {[CONVO]: 'org-borealis'},
    };
    expect(resolveDeptConversation(CONVO, maps))
      .toEqual({channelId: null, orgId: 'org-borealis'});
  });

  it('an org we never learned reads as null — today\'s behaviour, not a guess', () => {
    const maps = {
      deptConversationIds: {[CONVO]: true as const},
      deptGroupByChannel: {[CHANNEL]: CONVO},
    };
    expect(resolveDeptConversation(CONVO, maps)).toEqual({channelId: CHANNEL, orgId: null});
  });

  it('a NON-dept conversation still resolves to null overall', () => {
    // The org map must not accidentally make an ordinary group look dept.
    expect(resolveDeptConversation('some-1:1', {
      deptConversationIds: {}, deptGroupByChannel: {},
      deptOrgByConversation: {'some-1:1': 'org-x'},
    })).toBeNull();
  });
});
