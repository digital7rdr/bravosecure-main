import {readFileSync} from 'node:fs';
import {join} from 'node:path';

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

import {useMessengerStore} from '@/modules/messenger/store/messengerStore';
import {isDeviceLocalGroupId} from '@/modules/messenger/runtime/messagingLogic';
import type {LocalMessage} from '@/modules/messenger/store/types';

/**
 * B-124 §3.2 — escalating a 1:1 call to a group call duplicated the chat ON THE
 * CALLER'S DEVICE.
 *
 * Reported again from the field after the first B-124 round, because that round
 * only closed the GROUP-typed junk thread (§3.1, upsertKeylessGroupPlaceholder)
 * and swept the DIRECT-typed duplicate at boot. Nothing stopped it being minted
 * again mid-session.
 *
 * The chain:
 *   1. Escalation files a throwaway 'Call' group key under `direct:<hostUserId>`.
 *   2. The peer then stamps that device-local id as `group.groupId` on the wire.
 *   3. On the HOST's device that string names the host HIMSELF.
 *   4. The host holds a key there, so it decrypts, appends, and appendMessage
 *      shadow-creates a row whose only participant is the host — which the home
 *      list relabels with the PEER's name.
 *   => two identically-titled chats, on the caller's device only.
 *
 * Two independent layers are pinned here. Either alone stops the duplicate; both
 * are kept because the first round proved a single layer plus a boot sweep was
 * not enough.
 */

const OWN = 'user-host';
const PEER = 'user-piyaldeb';

function inbound(id: string, from: string): LocalMessage {
  return {
    id,
    conversation_id: '',
    sender_id: from,
    type: 'text',
    content: 'hello',
    status: 'delivered',
    is_encrypted: true,
    created_at: new Date().toISOString(),
    peer: {userId: from, deviceId: 1},
  } as unknown as LocalMessage;
}

describe('B-124 §3.2 — layer 1: the store never mints a chat that names YOU', () => {
  beforeEach(() => {
    useMessengerStore.setState(s => ({
      ...s,
      conversations: {},
      conversationOrder: [],
      messages: {},
      groups: {},
      _ownUserId: OWN,
    }));
  });

  it('does NOT create a conversation row for `direct:<ownUserId>`', () => {
    useMessengerStore.getState().appendMessage(`direct:${OWN}`, inbound('m1', PEER));
    const after = useMessengerStore.getState();
    expect(after.conversations[`direct:${OWN}`]).toBeUndefined();
    expect(after.conversationOrder).not.toContain(`direct:${OWN}`);
  });

  it('does not leave a second row titled like the real chat', () => {
    // The real 1:1 exists; the escalation artefact must not become a twin.
    useMessengerStore.setState(s => ({
      ...s,
      conversations: {
        [`direct:${PEER}`]: {
          id: `direct:${PEER}`, type: 'direct',
          participants: [OWN, PEER], peer: {userId: PEER, deviceId: 1},
        },
      } as never,
      conversationOrder: [`direct:${PEER}`],
    }));
    useMessengerStore.getState().appendMessage(`direct:${OWN}`, inbound('m2', PEER));
    const rows = Object.keys(useMessengerStore.getState().conversations);
    expect(rows).toEqual([`direct:${PEER}`]);
  });

  it('REGRESSION: a normal cold-contact 1:1 IS still shadow-created', () => {
    // The guard must be narrow. `direct:<someone else>` is a legitimate
    // first-contact slot and must keep working, or inbound messages from new
    // contacts stop producing a thread at all.
    useMessengerStore.getState().appendMessage(`direct:${PEER}`, inbound('m3', PEER));
    expect(useMessengerStore.getState().conversations[`direct:${PEER}`]).toBeTruthy();
  });

  it('REGRESSION: own outbound messages never shadow-create anything', () => {
    const own = {...inbound('m4', PEER), sender_id: 'self'} as LocalMessage;
    useMessengerStore.getState().appendMessage(`direct:${OWN}`, own);
    expect(useMessengerStore.getState().conversations[`direct:${OWN}`]).toBeUndefined();
  });
});

describe('B-124 §3.2 — layer 2: the receive path never adopts a device-local wire id', () => {
  const SRC = readFileSync(
    join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts'),
    'utf8',
  );

  it('the routing branch guards the wire group id with isDeviceLocalGroupId', () => {
    // productionRuntime cannot be imported in jest, so this is a source scan.
    // It asserts the PROPERTY (the adoption is guarded), not any spelling of the
    // surrounding code.
    const i = SRC.indexOf('conversationId = unwrapped.group.groupId;');
    expect(i).toBeGreaterThan(-1);
    const guard = SRC.slice(Math.max(0, i - 400), i);
    expect(guard).toMatch(/isDeviceLocalGroupId\(unwrapped\.group\.groupId\)/);
  });

  it('the guard is a NEGATION — the id is adopted only when it is NOT device-local', () => {
    expect(SRC).toMatch(/unwrapped\.group\?\.groupId\s*&&\s*!isDeviceLocalGroupId\(/);
  });

  it('group KEY lookup still uses the wire id — only the ROW is re-routed', () => {
    // The key genuinely lives at the wire id. Re-routing key lookup as well
    // would break the ad-hoc call key and every escalated call.
    expect(SRC).toMatch(/store\.groups\[unwrapped\.group\.groupId\]|groups\[unwrapped\.group\.groupId\]/);
  });
});

describe('B-124 — the shared shape predicate both layers rely on', () => {
  it('treats a self-naming direct slot as device-local', () => {
    expect(isDeviceLocalGroupId(`direct:${OWN}`)).toBe(true);
  });
  it('does not treat a real derived group id as device-local', () => {
    expect(isDeviceLocalGroupId('adhoc0c0ffee0c0ffee0c0ffee0c0ffee')).toBe(false);
  });
  it('does not treat a server UUID (mission room) as device-local', () => {
    expect(isDeviceLocalGroupId('8b1d4e2a-11ef-4c3b-9a7d-0f2e5c1a9b44')).toBe(false);
  });
});
