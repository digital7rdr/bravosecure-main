# GF-5 - Keyless ("syncing") member can send into a group with the inner envelope UNWRAPPED; fail closed instead

## Verdict

**CONFIRMED** (all three cited mechanisms reproduce in the current tree; line numbers drifted by ~1–5).

1. Send-side plaintext-inner fallback — `src/modules/messenger/runtime/productionRuntime.ts:2471-2482`:

   ```ts
   const masterKey = useMessengerStore.getState().groups[conversationId]?.masterKeyB64;
   const innerEnvelope = JSON.stringify({
     groupId: conversationId,
     kind: 'text',
     clientMsgId,
     body: text,
   });
   const sb = masterKey
     ? JSON.stringify(await groupEncrypt(masterKey, innerEnvelope))
     : innerEnvelope;
   ```

   `masterKey` is `undefined` **or `''`** for a keyless member (the persisted vault writes `masterKeyB64: ''` — `src/modules/messenger/store/messengerStore.ts:1218`), so the ternary takes the unwrapped branch and the group AES-GCM layer is skipped entirely.

2. Single-participant fan-out — `src/modules/messenger/runtime/groupConversationUpsert.ts:78` (`upsertKeylessGroupPlaceholder`) writes `participants: [peer.userId]`, and `productionRuntime.ts:2394-2396` derives the fan-out set from exactly that row:
   `const convoMemberIds = convo?.participants ?? []; const participants = convoMemberIds.filter(uid => uid && uid !== ownAddress.userId);`
   → the keyless member's message reaches **only the one peer whose stashed envelope created the placeholder**.

3. No composer gate — `src/screens/messenger/ChatScreen.tsx:1540/1556/1559` gate solely on `ready` (`= useMessengerStore(s => s.ready) && runtime !== null`, `src/modules/messenger/hooks/useMessenger.ts:32`), which is unrelated to group-key possession. ChatScreen already _knows_ the key is missing (`ChatScreen.tsx:393`: `if (isGroupConvo && !g?.masterKeyB64) { await rt.requestGroupKeyResync(...) }`) but does nothing to the composer.

4. The receive side already treats this as a downgrade: `packages/messenger-core/src/groups/groupClient.ts:351` returns `{ok:false, reason:'malformed'}` for a plaintext `kind:'text'` envelope (Audit P0-G2, default-closed — `LEGACY_GROUP_PLAINTEXT` at `:282` is opt-in via env and off). So today's keyless send is **rejected at the crypto layer and then rescued by the runtime's legacy fall-through** at `productionRuntime.ts:6773-6830`, which renders it via `unwrapPlaintextGroupInnerBody`. The security layer says "no"; the runtime says "render it anyway".

5. Architecture backing for the fix direction (batch constraint #6, ALLOWED): `SIGNAL_PROTOCOL_IMPLEMENTATION.md:235` — "Plaintext group messages are rejected (downgrade-attack defense)"; `ARCHITECTURE_COMPLIANCE.md:70` — "Both mobile and ops-console wrap inner envelope bodies with the master key for non-admin sends." The current send path violates the second sentence.

## Mechanism

1. Alice is added to group G. The owner's signed `admin: create` (which carries the master key **and** the full roster) is lost/queued — the dominant case per `docs/handoffs/GROUP_ADD_VISIBILITY_AND_DELIVERY_GAPS_HANDOFF.md:195`.
2. A member's ordinary wrapped group text arrives first. `parseGroupMessage` returns `no_key` (`groupClient.ts:344`), so `productionRuntime.ts:6727` stashes it and calls `upsertKeylessGroupPlaceholder(groupId, peer)` → a conversation row exists with `type:'group'`, `name:'Group'`, **`participants: [thatOnePeer]`**, and `groups[G]` is either absent or `{masterKeyB64: ''}`.
3. The thread is now fully interactive on the Messages page. Alice opens it. `ready === true` (the runtime is up), so the composer is live and the send button is enabled.
4. Alice sends. `sendText` → `isGroup === true` (`convo.type === 'group'`, `:2352`) → `participants = ['thatOnePeer']` → passes the `length === 0` guard at `:2397`.
5. Under the group admin lock (`:2469`) `masterKey` is falsy → **`sealedBody = innerEnvelope`**, the raw JSON `{"groupId":"…","kind":"text","clientMsgId":"…","body":"<her text>"}`.
6. `sendOne` seals that string per-recipient (sealed-sender + pairwise Signal are intact) and ships it to the **one** peer. Everyone else in the group never receives the message and Alice sees a green "sent" tick.
7. On that one recipient: cert + sealed AAD verify, `parseGroupMessage` returns `malformed`, and the runtime's legacy branch (`:6773`) renders `unwrapPlaintextGroupInnerBody(unwrapped.body, groupId)` — i.e. a **plaintext-in-the-group-layer** message is accepted and displayed. This is exactly the downgrade P0-G2 was written to close (it only closed the crypto half; the runtime fall-through re-opens it), and it is what sqa.md B-22 documented as "by design".

Net effect: a message the user believes is delivered to the group and encrypted under the group key is (a) delivered to 1 of N members, (b) not protected by the group master-key layer at all, and (c) reliant on a legacy accept path that is also reachable by any cert-holding actor.

## Fix

Four small edits. No wire-format change, no schema change, no server change.

### 1. `src/modules/messenger/runtime/messagingLogic.ts` — new pure helper + the user-facing string

`src/modules/messenger/__tests__/**` runs under the `messenger-crypto` Jest project and **cannot import `productionRuntime`** (native modules) — that is why `messagingLogic.ts` and `groupConversationUpsert.ts` exist. Put the decision here so it is unit-testable, and so ChatScreen and the runtime share one rule.

**Anchor** (end of file, after `readReceiptAccepted`):

```ts
export function readReceiptAccepted(args: {
  state: MessagingStateLike;
  conversationId: string;
  receipterUid: string;
  messagePeerUserId?: string;
}): boolean {
  const {state, conversationId, receipterUid, messagePeerUserId} = args;
  if (isGroupConversation(state, conversationId)) {
    const members = state.conversations[conversationId]?.participants ?? [];
    return members.includes(receipterUid);
  }
  return messagePeerUserId === receipterUid;
}
```

**Append after it:**

```ts
/**
 * GF-5 — a group send is blocked until this device holds the group
 * master key. Without the key the send path used to ship the inner
 * GroupMessageEnvelope UNWRAPPED, which the receive side already
 * classifies as a downgrade (`parseGroupMessage` → 'malformed', Audit
 * P0-G2) and which reaches only the single placeholder participant a
 * keyless member's row was seeded with. `masterKeyB64` is persisted as
 * `''` in the AsyncStorage vault (the real key lives in SQLCipher and is
 * rehydrated during runtime init, before `ready` flips), so an empty
 * string counts as absent.
 *
 * `forceGroup` mirrors sendText's `opts.isGroup` / the ChatScreen route
 * param for rows whose `type` has not synced yet.
 */
export function groupSendBlockedReason(
  state: MessagingStateLike,
  conversationId: string,
  forceGroup = false,
): 'group_key_missing' | null {
  if (!forceGroup && !isGroupConversation(state, conversationId)) {
    return null;
  }
  const group = state.groups[conversationId] as {masterKeyB64?: string} | undefined;
  return group?.masterKeyB64 ? null : 'group_key_missing';
}

export const GROUP_KEY_PENDING_SEND_ERROR =
  'Waiting for this group’s encryption key — the message will send once the key syncs.';

export function isGroupKeyPendingError(e: unknown): boolean {
  return e instanceof Error && e.message === GROUP_KEY_PENDING_SEND_ERROR;
}
```

Note: `MessagingStateLike.groups` stays `Record<string, unknown | undefined>` (the cast is local) so no existing caller or test fixture changes.

### 2. `src/modules/messenger/runtime/productionRuntime.ts` — fail closed in the group send prep

**Anchor** (inside `sendText`, inside `runWithGroupAdminLock`):

```ts
const masterKey = useMessengerStore.getState().groups[conversationId]?.masterKeyB64;
const innerEnvelope = JSON.stringify({
  groupId: conversationId,
  kind: 'text',
  clientMsgId,
  body: text,
});
const sb = masterKey ? JSON.stringify(await groupEncrypt(masterKey, innerEnvelope)) : innerEnvelope;
```

**Replacement:**

```ts
const masterKey = useMessengerStore.getState().groups[conversationId]?.masterKeyB64;
// GF-5 — fail closed. The unwrapped fallback skipped the documented
// group AES-GCM layer and only ever reached the single placeholder
// participant a keyless row is seeded with.
if (!masterKey) {
  const {GROUP_KEY_PENDING_SEND_ERROR: pendingErr} =
    require('./messagingLogic') as typeof import('./messagingLogic');
  throw new Error(pendingErr);
}
const innerEnvelope = JSON.stringify({
  groupId: conversationId,
  kind: 'text',
  clientMsgId,
  body: text,
});
const sb = JSON.stringify(await groupEncrypt(masterKey, innerEnvelope));
```

(`require(...)` inside the runtime is the established pattern here — see `:283`, `:3286`, `:5177`.)

**Anchor** (the immediately following catch — flips the optimistic bubble to `failed`):

```ts
        } catch (e) {
          useMessengerStore.getState().updateMessageStatus(conversationId, msgId, 'failed');
          throw e;
        }
```

**Replacement:**

```ts
        } catch (e) {
          useMessengerStore.getState().updateMessageStatus(conversationId, msgId, 'failed');
          const {isGroupKeyPendingError: isKeyPending} =
            require('./messagingLogic') as typeof import('./messagingLogic');
          // Fired OUTSIDE runWithGroupAdminLock (this catch is past it) so the
          // self-heal can never re-enter the lock it just released.
          if (isKeyPending(e)) {
            void requestGroupKeyResyncImpl(conversationId).catch(() => { /* best-effort */ });
          }
          throw e;
        }
```

The optimistic bubble is appended **before** this block (`:2429`, the P1-1 invariant), so the user's text survives as a durable `failed` row with the existing retry chip. No outbox row exists yet at this point (rows are written inside `sendOne`), so nothing is queued and nothing leaks. `requestGroupKeyResyncImpl` is already rate-limited per group (`KEY_REQUEST_COOLDOWN_MS`, `:2133`) so a send-retry storm cannot amplify into a key-request flood — this is the same cooldown discipline the batch constraints require for GF-3.

### 3. `src/modules/messenger/runtime/productionRuntime.ts` — gate `sendMedia` **before** the upload

Without this, a keyless group media send encrypts + uploads the object to R2 and only then throws in `sendText`, orphaning a paid-for object (the file explicitly notes there is no delete API).

**Anchor** (top of `sendMedia`, right after the id canonicalisation and before the optimistic append):

```ts
// P2-12 — append an optimistic `sending` bubble BEFORE the upload so a
// slow or failed upload leaves a durable on-screen row (visible + retryable)
```

**Insert immediately above that comment:**

```ts
// GF-5 — same fail-closed gate as sendText, but BEFORE the upload so a
// keyless group send never burns an R2 object it can never ship.
{
  const {groupSendBlockedReason, GROUP_KEY_PENDING_SEND_ERROR: pendingErr} =
    require('./messagingLogic') as typeof import('./messagingLogic');
  const blocked = groupSendBlockedReason(
    useMessengerStore.getState(),
    convId,
    mediaOpts?.isGroup === true,
  );
  if (blocked) {
    void requestGroupKeyResyncImpl(convId).catch(() => {
      /* best-effort */
    });
    throw new Error(pendingErr);
  }
}
```

### 4. `src/screens/messenger/ChatScreen.tsx` — composer gate + honest status line

**(a) Anchor** (existing selector block):

```ts
const peerTyping = useMessengerStore(s => !!s.typing[conversationId]);
const connectionState = useMessengerStore(s => s.connection);
```

**Replacement:**

```ts
const peerTyping = useMessengerStore(s => !!s.typing[conversationId]);
const connectionState = useMessengerStore(s => s.connection);
// GF-5 — a group we belong to but hold no master key for cannot be sent
// into (the runtime fails closed). Same rule, one source: messagingLogic.
// Boolean selector → primitive equality, no useShallow needed. Group keys
// are rehydrated from SQLCipher during runtime init (productionRuntime
// :1670-1695) BEFORE `setReady(true)` (:1939), so this never flashes on a
// cold boot — `ready` is still false during that window.
const groupKeyPending = useMessengerStore(
  s => !!groupSendBlockedReason(s, conversationId, isGroup === true),
);
const composerEnabled = ready && !groupKeyPending;
```

with the import added next to the existing messenger imports:

```ts
import {groupSendBlockedReason} from '@/modules/messenger/runtime/messagingLogic';
```

**(b) Anchor** (`statusLabel`):

```ts
const statusLabel = useMemo(() => {
  if (error) {
    return `Error: ${error}`;
  }
  if (!ready) {
    return 'Initializing secure session…';
  }
  if (runtime?.mode === 'loopback-memory' || runtime?.mode === 'loopback-sqlcipher') {
    return 'LOOPBACK MODE — messages echo back to verify crypto';
  }
  return null;
}, [error, ready, runtime]);
```

**Replacement:**

```ts
const statusLabel = useMemo(() => {
  if (error) {
    return `Error: ${error}`;
  }
  if (!ready) {
    return 'Initializing secure session…';
  }
  if (groupKeyPending) {
    return 'Syncing this group’s encryption key — you can send once it arrives.';
  }
  if (runtime?.mode === 'loopback-memory' || runtime?.mode === 'loopback-sqlcipher') {
    return 'LOOPBACK MODE — messages echo back to verify crypto';
  }
  return null;
}, [error, ready, runtime, groupKeyPending]);
```

This reuses the existing `devBanner` slot (`ChatScreen.tsx:1395-1407`) — no new component, no new style, nothing to migrate under `DESIGN_REVIEW_LOOP.md` G8.

**(c) Anchor** (composer):

```ts
              placeholder={ready ? 'Type a secure message...' : 'Establishing session...'}
              placeholderTextColor="#7E8AA6"
              value={text}
              onChangeText={setText}
              editable={ready}
```

**Replacement:**

```ts
              placeholder={
                groupKeyPending ? 'Waiting for the group key…'
                : ready ? 'Type a secure message...'
                : 'Establishing session...'
              }
              placeholderTextColor="#7E8AA6"
              value={text}
              onChangeText={setText}
              editable={composerEnabled}
```

**(d) Anchor** (send button):

```ts
              style={[styles.sendBtn, (!ready || !text.trim()) && {opacity: 0.5}]}
              onPress={() => { void send(); }}
              activeOpacity={0.85}
              disabled={!ready || !text.trim()}>
```

**Replacement:**

```ts
              style={[styles.sendBtn, (!composerEnabled || !text.trim()) && {opacity: 0.5}]}
              onPress={() => { void send(); }}
              activeOpacity={0.85}
              disabled={!composerEnabled || !text.trim()}>
```

**(e)** In the attach button (`ChatScreen.tsx:1526-1531`) add the same gate so the media sheet cannot be opened into a keyless group:

```ts
          <TouchableOpacity
            style={[styles.attachBtn, !composerEnabled && {opacity: 0.5}]}
            activeOpacity={0.7}
            disabled={!composerEnabled}
            onPress={() => setAttachOpen(true)}>
```

The `VoiceNoteRecorder` branch renders when `text` is empty; because `editable` is false the user cannot type, so the mic is what they see — it routes through `enqueueMediaAssets` → `sendMedia`, which is gated by edit #3 and surfaces the banner + `Alert` already wired at `ChatScreen.tsx:994-995`. Leaving the recorder itself untouched keeps the diff minimal; the gate is enforced before any upload.

### Back-compat / wire

- **No wire field added or removed.** We simply stop emitting an envelope shape that the current receive side already classifies as `malformed`.
- **Old peers:** unaffected. They keep accepting plaintext group text through the legacy fall-through; we just never produce it. Server is untouched, so the deploy-server-before-clients ordering is a non-issue.
- **Key distribution is not affected:** `create` and `key-request` are fanned out by `broadcastToGroup` (`packages/messenger-core/src/groups/groupClient.ts:166` `skipGroupKey`), a completely different code path that `sendText` never enters. Batch constraint #6's only caveat ("do not fail `create`/`key-request` closed or key distribution deadlocks") is satisfied by construction.
- **No schema/migration.** No new persisted column, no SQLCipher version bump, no outbox payload shape change.

## Blast radius

**Files edited**

| File                                                 | Function                                                                               |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `src/modules/messenger/runtime/messagingLogic.ts`    | new `groupSendBlockedReason`, `GROUP_KEY_PENDING_SEND_ERROR`, `isGroupKeyPendingError` |
| `src/modules/messenger/runtime/productionRuntime.ts` | `sendText` (group prep block + its catch), `sendMedia` (pre-upload gate)               |
| `src/screens/messenger/ChatScreen.tsx`               | selectors, `statusLabel`, `TextInput`, send button, attach button                      |

**Callers that now inherit the fail-closed behaviour** (all reach `sendText`):

- `ChatScreen.tsx:676` normal send · `:744` `retrySend` · `:842/:863` forward-into-a-group
- `GroupCallScreen.tsx:1174/1185` in-call chat for a real `group`/`ops_channel`
- `DepartmentChatScreen.tsx:321` dept-chat send
- `productionRuntime.ts:3144` `sendMedia` → `sendText`

Each of these will now throw a plain-English error instead of shipping a downgraded envelope. All of them already have a catch: ChatScreen routes through `sendErrorText` (`src/screens/messenger/sendErrorText.ts:22`), which passes a human-readable message through unchanged (it only rewrites libsignal-internal text and redacts UUIDs) — so no new copy plumbing is needed. `GroupCallScreen.tsx:1207` and `DepartmentChatScreen` already catch and surface.

**Not touched (deliberately)**

- **Receive side.** The legacy plaintext accept path (`productionRuntime.ts:6773-6830` + `unwrapPlaintextGroupInnerBody`) stays, per the finding's own instruction and because real ops/mission rows still ride it. _Follow-up worth filing:_ once every client ships this fix, that branch is the last remaining group-layer downgrade surface — any cert-holding member can still push a plaintext body and have it render (subject to the P1-4 membership gate at `:6791`). Closing it is a separate, riskier change and should be its own finding.
- **`sendReaction`** (`productionRuntime.ts:3275`). Reactions ride an empty body with the directive in the sealed payload and are never master-key wrapped; gating them would be a behaviour change outside this finding. They do inherit the narrow `participants: [peer]` fan-out from the same placeholder row — that half belongs to GF-2/GF-3.
- **`broadcastToGroup`** — unchanged; admin `create`/`key-request` must stay unwrapped.

**Overlapping findings**

- **GF-1 / SRV-01** edit the same group fan-out loop in `sendText` (batch endpoint / throttle). Land GF-5 first: it is a ~10-line guard above their edit site.
- **GF-2 / SYNC-2** (durable group-key fan-out) and **GF-3** (self-heal on decrypt failure) both touch `requestGroupKeyResyncImpl` / `sendKeyRequest`, which this fix now calls from one more site. Keep the per-group cooldown intact — it is the shared amplification guard.
- **OM-05** edits the deferred-outbox re-seal in the same `sendText`/`drainOutbox` pair. No textual overlap with these anchors, but same file.
- **GF-2's** placeholder-roster repair, if it lands, makes the `participants: [peer]` half moot; GF-5 does not depend on it (the key-bearing `create`/reshare already rewrites the roster via `upsertGroupConversationFromState`).

**What could regress**

1. **A group whose key genuinely never arrives becomes unsendable** instead of "sends garbage to one person". That is the intended fail-closed posture, but it converts a silent-corruption bug into a visible dead-end. Mitigated by: the auto `requestGroupKeyResync` on every blocked attempt, the persistent banner, and the durable failed bubble + retry chip. If GF-2/GF-3 do **not** land, expect user reports of "can't send in this group" where they previously saw a one-way message.
2. **Cold boot / restore flash.** Ruled out by the ordering above (`setReady(true)` at `:1939` runs after the group-key warm at `:1670-1695`), but any future reordering of runtime init would reintroduce it — that ordering is now load-bearing and should be called out in review.
3. **Ad-hoc `'Call'` group states** aliased into `direct:*` slots (`productionRuntime.ts:4425-4440`) always carry a minted `masterKeyB64`, so escalated-call chat is unaffected. Worth a smoke check anyway.

## Tests

**`src/modules/messenger/__tests__/messagingLogic.test.ts`** (existing; Jest project `messenger-crypto`) — add:

```ts
describe('GF-5 — groupSendBlockedReason', () => {
  it('blocks a group conversation with no GroupState at all', () => {
    expect(groupSendBlockedReason(state({g: {type: 'group', participants: [ALICE]}}), 'g')).toBe(
      'group_key_missing',
    );
  });
  it('blocks when GroupState exists but masterKeyB64 is the persisted empty string', () => {
    expect(groupSendBlockedReason(state({g: {type: 'group'}}, {g: {masterKeyB64: ''}}), 'g')).toBe(
      'group_key_missing',
    );
  });
  it('allows once a real master key is present', () => {
    expect(
      groupSendBlockedReason(state({g: {type: 'group'}}, {g: {masterKeyB64: 'a2V5'}}), 'g'),
    ).toBeNull();
  });
  it('never blocks a 1:1 chat', () => {
    expect(
      groupSendBlockedReason(state({d: {type: 'direct', participants: [OWN, ALICE]}}), 'd'),
    ).toBeNull();
  });
  it('blocks an ops_channel with no key', () => {
    expect(groupSendBlockedReason(state({g: {type: 'ops_channel'}}), 'g')).toBe(
      'group_key_missing',
    );
  });
  it('honours forceGroup for a row whose type has not synced yet', () => {
    expect(groupSendBlockedReason(state({g: {}}), 'g', true)).toBe('group_key_missing');
    expect(groupSendBlockedReason(state({g: {}}), 'g', false)).toBeNull();
  });
  it('isGroupKeyPendingError only matches the pending-key error', () => {
    expect(isGroupKeyPendingError(new Error(GROUP_KEY_PENDING_SEND_ERROR))).toBe(true);
    expect(isGroupKeyPendingError(new Error('group too large to send'))).toBe(false);
    expect(isGroupKeyPendingError('nope')).toBe(false);
  });
});
```

**New: `src/modules/messenger/__tests__/groupSendKeyGate.test.ts`** (Jest project `messenger-crypto`) — regression-lock the _end state_ of the downgrade, mirroring `packages/messenger-core/__tests__/groupPlaintextReject.test.ts`:

```ts
/**
 * GF-5 — the send path must never ship an unwrapped inner
 * GroupMessageEnvelope. This pins the two halves that made the
 * downgrade reachable end to end.
 */
```

Assertions:

1. `upsertKeylessGroupPlaceholder(GID, {userId: BOB, deviceId: 1})` then `groupSendBlockedReason(store, GID)` → `'group_key_missing'` (proves the exact row shape that reaches ChatScreen is blocked). Reuse the AsyncStorage mock header from `groupConversationUpsert.test.ts`.
2. Round-trip: `groupEncrypt(masterKey, innerJson)` → `sealPayload` → `parseGroupMessage(sealed, masterKey)` → `{ok: true}`; the same `sealPayload` with the **raw** `innerJson` body → `{ok: false, reason: 'malformed'}` — i.e. the shape the old fallback produced is exactly what the receiver refuses, so failing closed on send loses nothing that was working.

**Existing suites to re-run (regression, per CLAUDE.md change-safety §2/§4):**

- `npm run test:crypto` — must stay green, in particular `packages/messenger-core/__tests__/groupPlaintextReject.test.ts`, `groupBroadcast.test.ts`, `src/modules/messenger/__tests__/groupConversationUpsert.test.ts`, `bootGroupStashDrain.test.ts`, `adhocCallKeyLookup.test.ts`, `groupCallKeyWait.test.ts`, `messagingLogic.test.ts`.
- `npm test -- --selectProjects=app` for `src/screens/messenger/__tests__/sendErrorText.test.ts` (the new message must pass through unmodified — add one case asserting `sendErrorText(new Error(GROUP_KEY_PENDING_SEND_ERROR), 'Send failed') === GROUP_KEY_PENDING_SEND_ERROR`).
- `npm run typecheck` — must not exceed the `.tsc-baseline.json` count (47).
- `packages/messenger-core/__tests__/logAudit.test.ts` — no new logging is added, but it runs as part of the crypto project anyway.

**Device smoke (the part unit tests cannot cover):** 3 BlueStacks instances per `sqa.md` Device & Identity Reference. Add member C to group G with C's app killed; boot C and open the group before the `create` lands → composer disabled + banner; confirm no envelope leaves C; then let the reshare land → composer unlocks, send reaches **all** members, and the bubble renders as text (not JSON) everywhere. Also verify an existing keyed group is unaffected (send/receive text + image) and that a 1:1 chat's composer never gates.

## Risk

- **Product decision, state it plainly:** this trades a silent-corruption path for a visible "you can't send yet" state. If group-key distribution is unreliable (which GF-2/GF-3 exist to fix), users who previously got a partially-working thread now get a hard block. I recommend landing GF-5 **with or after** GF-3's self-heal, and shipping the banner copy verbatim so the state is self-explanatory. The smallest correct increment is exactly what is specified here; do **not** try to solve it with a "queue the plaintext until the key arrives" store — that persists plaintext bodies in a new at-rest surface and is a much larger change than the failed-bubble-plus-retry-chip the codebase already has.
- **Reviewer should be suspicious of:** (a) `masterKeyB64 === ''` — the empty string is the _persisted_ form, so any guard written as `masterKey !== undefined` is wrong; (b) the runtime-init ordering (group-key warm before `setReady(true)`) that keeps the banner from flashing on cold boot; (c) placing the `requestGroupKeyResync` call _inside_ `runWithGroupAdminLock` — it must stay in the catch, past the lock (B-75 was a self-deadlock of exactly this shape); (d) anyone "fixing" the resulting dead-end by re-enabling `EXPO_PUBLIC_LEGACY_GROUP_PLAINTEXT` — that is the downgrade switch, not a workaround.
- **Not a security weakening anywhere:** no check is relaxed, no dev-skip branch is added, `verifySenderCert` / `verifySealedAad` / the P0-G2 gate / the B-42 epoch guard are untouched, and no new logging is introduced (no plaintext, no key bytes).
- **Left open on purpose:** the receive-side legacy plaintext accept path, and the `participants: [peer]` narrow fan-out on a keyless placeholder row. Both are real, both are adjacent, neither is GF-5's to close.
