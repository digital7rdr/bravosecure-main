/**
 * GF-5 — the send path must never ship an unwrapped inner
 * GroupMessageEnvelope. This pins the two halves that made the downgrade
 * reachable end to end:
 *
 *   1. The exact keyless-placeholder row shape ChatScreen renders is
 *      blocked by `groupSendBlockedReason` (composer + runtime share it).
 *   2. The wrapped shape round-trips under the master key, while the raw
 *      shape the old fallback produced is exactly what the receiver
 *      already refuses ('malformed', Audit P0-G2) — failing closed on
 *      send loses nothing that was working.
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
  sealPayload,
  unsealPayload,
} from '@bravo/messenger-core';
import {upsertKeylessGroupPlaceholder} from '../runtime/groupConversationUpsert';
import {groupSendBlockedReason, GROUP_KEY_PENDING_SEND_ERROR} from '../runtime/messagingLogic';
import {useMessengerStore} from '../store/messengerStore';

const GID = 'g-gf5';
const BOB = {userId: 'bob', deviceId: 1};

describe('GF-5 — keyless group send fails closed', () => {
  beforeEach(() => {
    useMessengerStore.getState().reset();
  });

  it('the keyless-placeholder row that reaches ChatScreen is blocked', () => {
    upsertKeylessGroupPlaceholder(GID, BOB);
    const s = useMessengerStore.getState();
    expect(s.conversations[GID]?.type).toBe('group');
    expect(groupSendBlockedReason(s, GID)).toBe('group_key_missing');
  });

  it('a keyed group is not blocked', () => {
    upsertKeylessGroupPlaceholder(GID, BOB);
    useMessengerStore.setState({
      groups: {[GID]: {groupId: GID, masterKeyB64: genFreshGroupMasterKey(), members: {}}},
    } as never);
    expect(groupSendBlockedReason(useMessengerStore.getState(), GID)).toBeNull();
  });

  it('wrapped body round-trips; the raw shape the old fallback shipped is refused', async () => {
    const masterKey = genFreshGroupMasterKey();
    const innerJson = JSON.stringify({groupId: GID, kind: 'text', clientMsgId: 'm1', body: 'hi'});

    const wrappedWire = sealPayload('cert.cert.cert', JSON.stringify(await groupEncrypt(masterKey, innerJson)), {
      group: {groupId: GID, kind: 'text', clientMsgId: 'm1'},
      aad:   {to: BOB, ts: Date.now()},
    });
    const wrapped = await parseGroupMessage(unsealPayload(wrappedWire), masterKey);
    expect(wrapped.ok).toBe(true);
    if (wrapped.ok) {expect(wrapped.envelope.body).toBe('hi');}

    // The pre-GF-5 keyless fallback: sealedBody = innerEnvelope (no group
    // AES-GCM layer). The receiver's crypto layer classifies it as a
    // downgrade — this is what the send path used to emit anyway.
    const rawWire = sealPayload('cert.cert.cert', innerJson, {
      group: {groupId: GID, kind: 'text', clientMsgId: 'm1'},
      aad:   {to: BOB, ts: Date.now()},
    });
    const raw = await parseGroupMessage(unsealPayload(rawWire), masterKey);
    expect(raw.ok).toBe(false);
    if (!raw.ok) {expect(raw.reason).toBe('malformed');}
  });

  it('the pending-key error copy is stable (surfaced verbatim to the user)', () => {
    expect(GROUP_KEY_PENDING_SEND_ERROR).toBe(
      'Waiting for this group’s encryption key — the message will send once the key syncs.',
    );
  });
});

/**
 * B-703 MR-9 — the SECOND surface. ChatScreen has gated its composer on this
 * rule since GF-5 landed; DepartmentChatScreen never did, so a channel whose
 * master key had not arrived took the post, appended a row, failed closed in
 * the runtime, flipped it 'failed' and threw — leaving an alert, a restored
 * draft the user re-types (a visible duplicate), and a dead bubble.
 *
 * ChatScreen mounts RN views so the node project cannot import either screen;
 * this is a comment-stripped, CRLF-safe source scan. Stripped LINE BY LINE,
 * never with a `/*...*​/` regex — these screens carry `/*` inside string and
 * regex literals, and the block stripper swallows real code from there to the
 * next terminator.
 */
describe('B-703 MR-9 — both chat surfaces gate the composer on the same rule', () => {
  const {readFileSync} = require('node:fs') as typeof import('node:fs');
  const {join} = require('node:path') as typeof import('node:path');
  const read = (f: string): string =>
    readFileSync(join(process.cwd(), 'src', 'screens', 'messenger', f), 'utf8')
      .split(/\r?\n/)
      .filter(l => !/^\s*(\/\/|\/\*|\*)/.test(l))
      .map(l => l.replace(/(^|[^:])\/\/.*$/, '$1'))
      .join('\n');

  const chat = read('ChatScreen.tsx');
  const dept = read('DepartmentChatScreen.tsx');

  it.each([['ChatScreen.tsx', () => chat], ['DepartmentChatScreen.tsx', () => dept]])(
    '%s derives the gate from groupSendBlockedReason, not its own check',
    (_f, src) => {
      expect(src()).toContain('groupSendBlockedReason(');
      expect(src()).toMatch(/groupKeyPending/);
    },
  );

  it('the department composer is DISABLED and says why', () => {
    expect(dept).toMatch(/editable=\{!groupKeyPending\}/);
    expect(dept).toMatch(/groupKeyPending[\s\S]{0,80}?'Waiting for the group key…'/);
  });

  it('...and both send lanes refuse, not just the input', () => {
    // The button and the keyboard submit both reach send() without touching the
    // TextInput, and the key can disappear between render and tap.
    const refusals = dept.match(/if \(groupKeyPending\) \{\s*\r?\n?\s*Alert\.alert\('Not ready yet', GROUP_KEY_PENDING_SEND_ERROR\);/g) ?? [];
    expect(refusals).toHaveLength(2); // text lane + attachment lane
  });
});
