# SYNC-6 - Typing frames carry no conversation scope; one peer typing lights up every mutual conversation

## Verdict

**CONFIRMED** (mechanism exactly as described; line numbers drifted a little).

Evidence from the current tree:

1. `apps/messenger-service/src/gateway/messenger.gateway.ts:2182-2185` — the forwarded frame carries only sender address + state:
   ```ts
   this.hub.server
     ?.to(this.hub.deviceRoom(data.to))
     .volatile.emit('typing', {from, state: data.state} satisfies ServerTyping['data']);
   ```
2. `packages/messenger-core/src/transport/protocol.ts:502-505` (authoritative for mobile) — `ServerTyping.data = {from: SessionAddress; state: 'start' | 'stop'}`. No conversation field. Same in `apps/messenger-service/src/gateway/protocol.ts:495-498` and the mirror `src/modules/messenger/transport/protocol.ts:307-310`.
3. `src/modules/messenger/runtime/productionRuntime.ts:5203-5232` — the client's own comment states the defect: _"Typing frames carry only `from` (peer address) — no conversation id — so for 1:1 we map to `direct:<peerUserId>` and for groups we set the typing flag on every group whose participants include this sender."_
4. `src/modules/messenger/runtime/messagingLogic.ts:71-82` — the fan-out is unconditional:
   ```ts
   const out = new Set<string>([syntheticDirectId, canonicalDirectId]);
   for (const [convId, convo] of Object.entries(state.conversations)) {
     if ((convo?.participants ?? []).includes(senderUid)) {
       out.add(convId);
     }
   }
   ```
   Note the direct ids are added **unconditionally**, so a group-only typing burst also lights the 1:1 — the leak is bidirectional, not just DM→group.
5. It is user-visible with a **name** attached: `src/screens/messenger/ChatScreen.tsx:1166-1181` renders `"${names[0]} is typing"` from `typingUsers[conversationId]` (B-117), and `:311` renders the dots from `s.typing[conversationId]`.
6. The send side already fans one frame **per peer** for groups — `src/screens/messenger/ChatScreen.tsx:590-603` (`for (const peer of groupPeers) {runtime.sendTyping(peer, 'start');}`) — so a per-recipient scope token costs **zero extra frames**.

## Mechanism

1. Alice opens her 1:1 with Bob and types. `ChatScreen` (`:593`) calls `runtime.sendTyping({userId: bob, deviceId: 1}, 'start')`.
2. `productionRuntime.ts:3269-3273` emits `{event: 'typing', data: {to: bob, state: 'start'}}` over the WS.
3. The gateway (`handleTyping`, `:2163`) block-checks the pair and re-emits `{from: alice, state: 'start'}` into Bob's device room. Nothing identifies _which_ conversation.
4. Bob's `handleServerFrame` `case 'typing'` (`:5203`) computes `syntheticId = convoIdFor(from)` = `direct:alice`, `canonicalId = resolveDirect(store, alice)`, then calls `typingAffectedConversationIds(store, alice, syntheticId, canonicalId)`.
5. That helper returns the two direct ids **plus every conversation whose `participants` include Alice** — i.e. every mission group, ops channel and dept group Alice and Bob share.
6. `store.setTypingUser(convId, alice, true)` runs for each (`:5236`), so `typingUsers[<every shared group>]['alice'] = true`. If Bob happens to have any of those groups open, `ChatScreen` paints **"Alice is typing…"** in a group where she is not typing — and the same in reverse when she types in a group (both direct ids get set too).
7. The BS-TY2 watchdog (`messagingLogic.ts:97`, 8 s) and the server auto-stop (`TYPING_TIMEOUT_MS = 6_000`, `:97`) eventually clear it, and the matching `stop` frame clears all slots — so the false indicator is transient, not sticky. That is why this is P3, not P1.

## Fix

Add an **opaque, per-recipient-pair conversation tag** (not the group id) to the typing frame, pass it through the relay untouched, and scope the client apply by it. Falls back to today's fan-out when the tag is absent, so old peers/servers keep working.

### Why a tag and not the raw `conversationId`

The batch architecture ruling for this finding is: _"ALLOWED-WITH-CONSTRAINT for 1:1 (opaque/per-pair id). FORBIDDEN / needs approval if the value is a group conversation id the relay can cluster on"_ — a raw group UUID on the wire hands the relay a stable cross-member group identifier, which contradicts `MESSENGER_BACKEND.md:162` ("Group membership | No") and `MESSENGER_SPEC_COVERAGE.md:69` ("zero group awareness"). **The audit's literal proposal ("optional conversationId on the typing frame") is therefore not implementable as written.** A tag bound to the `{sender, recipient}` pair is different for every recipient of the same group, so the relay cannot cluster it.

### 1. `packages/messenger-core/src/transport/protocol.ts` (authoritative shape for mobile)

Anchor:

```ts
export interface ClientTyping {
  event: 'typing';
  data: {to: SessionAddress; state: 'start' | 'stop'};
}
```

Replace with:

```ts
export interface ClientTyping {
  event: 'typing';
  data: {to: SessionAddress; state: 'start' | 'stop'; convTag?: string};
}
```

Anchor:

```ts
export interface ServerTyping {
  event: 'typing';
  data: {from: SessionAddress; state: 'start' | 'stop'};
}
```

Replace with:

```ts
/**
 * SYNC-6 — `convTag` is an OPAQUE 16-hex scope token bound to the
 * {sender, recipient} pair (see `typingConversationTag`). It is never the
 * group id: two members of the same group receive different tags, so the
 * relay cannot cluster it into a membership set. Absent = legacy peer.
 */
export interface ServerTyping {
  event: 'typing';
  data: {from: SessionAddress; state: 'start' | 'stop'; convTag?: string};
}
```

Mirror the same two `convTag?: string` additions verbatim (without the doc block) in:

- `apps/messenger-service/src/gateway/protocol.ts:278-284` (`ClientTyping`) and `:495-498` (`ServerTyping`)
- `src/modules/messenger/transport/protocol.ts:174-177` and `:307-310` (the file header explicitly requires same-commit sync)
- `apps/ops-console/src/lib/messenger/protocol.ts:36` / `:100` — optional, type parity only. Ops-console keys typing by **user**, not conversation (`apps/ops-console/src/lib/messenger/runtime.ts:740-746`), so it has no behaviour change; it sends no tag and mobile falls back for it.

### 2. `apps/messenger-service/src/gateway/messenger.gateway.ts` — pass through, never interpret

Anchor:

```ts
const from = {userId: ctx.claims.sub, deviceId: ctx.signalDeviceId};

// Typing indicators are volatile — skip the online probe and skip
// buffering. If the peer's socket has a full send queue we'd rather
// drop the frame than delay a real message behind it.
this.hub.server
  ?.to(this.hub.deviceRoom(data.to))
  .volatile.emit('typing', {from, state: data.state} satisfies ServerTyping['data']);

const key = typingKey(from, data.to);
```

Replace with:

```ts
const from = {userId: ctx.claims.sub, deviceId: ctx.signalDeviceId};
// Why: SYNC-6 — opaque client-side scope token. Forwarded verbatim,
// never parsed, stored or logged; a bad shape is dropped, not 400'd.
const convTag = sanitizeConvTag(data.convTag);

// Typing indicators are volatile — skip the online probe and skip
// buffering. If the peer's socket has a full send queue we'd rather
// drop the frame than delay a real message behind it.
this.hub.server
  ?.to(this.hub.deviceRoom(data.to))
  .volatile.emit('typing', typingFrame(from, data.state, convTag));

const key = typingKey(from, data.to, convTag);
```

Anchor (the auto-stop timer):

```ts
    if (data.state === 'start') {
      const t = setTimeout(() => {
        this.hub.server
          ?.to(this.hub.deviceRoom(data.to))
          .volatile
          .emit('typing', {from, state: 'stop'} satisfies ServerTyping['data']);
        this.typingTimers.delete(key);
      }, TYPING_TIMEOUT_MS);
```

Replace with:

```ts
    if (data.state === 'start') {
      const t = setTimeout(() => {
        this.hub.server
          ?.to(this.hub.deviceRoom(data.to))
          .volatile
          .emit('typing', typingFrame(from, 'stop', convTag));
        this.typingTimers.delete(key);
      }, TYPING_TIMEOUT_MS);
```

Anchor (module-level helper):

```ts
function typingKey(
  from: {userId: string; deviceId: number},
  to: {userId: string; deviceId: number},
): string {
  return `${from.userId}:${from.deviceId}->${to.userId}:${to.deviceId}`;
}
```

Replace with:

```ts
function typingKey(
  from: {userId: string; deviceId: number},
  to: {userId: string; deviceId: number},
  convTag?: string,
): string {
  return `${from.userId}:${from.deviceId}->${to.userId}:${to.deviceId}|${convTag ?? ''}`;
}

/** SYNC-6 — accept only a 16-char lowercase hex tag; anything else is dropped. */
function sanitizeConvTag(raw: unknown): string | undefined {
  return typeof raw === 'string' && /^[0-9a-f]{16}$/.test(raw) ? raw : undefined;
}

function typingFrame(
  from: {userId: string; deviceId: number},
  state: 'start' | 'stop',
  convTag?: string,
): ServerTyping['data'] {
  return convTag ? {from, state, convTag} : {from, state};
}
```

`clearTypingTimersFrom` (`:2587`) matches on `startsWith(\`${userId}:${deviceId}->\`)`, which is unaffected by the appended `|<tag>` suffix — no edit needed. Keying the auto-stop timer by tag is deliberate: a user who types in a group and then in the 1:1 with the same peer now has two independent auto-stop timers instead of the second one silently cancelling the first.

**No storage, no Redis, no logging** of `convTag` — the frame stays exactly as ephemeral as today (`MESSENGER_SPEC_COVERAGE.md:77`).

### 3. `src/modules/messenger/runtime/messagingLogic.ts` — the tag function + scoped resolution

Anchor:

```ts
/**
 * BS-TY1 — the set of conversation ids a typing frame from `senderUid`
 * affects: the synthetic direct key, the canonical direct id (resolved
 * by the caller and passed in), and every group the sender participates
 * in. De-duplicated.
 */
export function typingAffectedConversationIds(
  state: MessagingStateLike,
  senderUid: string,
  syntheticDirectId: string,
  canonicalDirectId: string,
): string[] {
  const out = new Set<string>([syntheticDirectId, canonicalDirectId]);
  for (const [convId, convo] of Object.entries(state.conversations)) {
    if ((convo?.participants ?? []).includes(senderUid)) {
      out.add(convId);
    }
  }
  return Array.from(out);
}
```

Replace with:

```ts
/**
 * SYNC-6 — opaque scope token for a typing frame. Bound to the SORTED
 * {sender, recipient} pair, so the same group produces a different tag
 * for every recipient: the relay forwards it but cannot cluster it into
 * a membership set. 1:1 chats use the fixed `DIRECT_CONVERSATION_KEY`
 * because the two endpoints key the same thread by different ids
 * (`direct:<peer>` vs a server UUID).
 */
export const DIRECT_CONVERSATION_KEY = 'direct';
const TYPING_TAG_DOMAIN = 'BRAVO_TYPING_TAG_V1';

export function typingConversationTag(
  conversationKey: string,
  userIdA: string,
  userIdB: string,
): string {
  const pair = [userIdA, userIdB].sort().join('|');
  const digest = sha256(
    new TextEncoder().encode(`${TYPING_TAG_DOMAIN}|${conversationKey}|${pair}`),
  );
  let hex = '';
  for (let i = 0; i < 8; i++) {
    hex += digest[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * BS-TY1 + SYNC-6 — the set of conversation ids a typing frame from
 * `senderUid` affects.
 *
 * With a `convTag` (SYNC-6 peers) exactly ONE thread is resolved: the
 * direct pair, or the single group whose tag matches. An unmatchable tag
 * resolves to nothing — dropping an ephemeral indicator beats painting
 * "typing…" in the wrong chat.
 *
 * Without a tag (legacy peer / ops-console) the historical fan-out is
 * preserved: synthetic + canonical direct ids and every group the sender
 * participates in.
 */
export function typingAffectedConversationIds(
  state: MessagingStateLike,
  senderUid: string,
  syntheticDirectId: string,
  canonicalDirectId: string,
  convTag?: string,
  ownUserId?: string,
): string[] {
  const directIds = [syntheticDirectId, canonicalDirectId];
  if (convTag && ownUserId) {
    if (convTag === typingConversationTag(DIRECT_CONVERSATION_KEY, ownUserId, senderUid)) {
      return Array.from(new Set(directIds));
    }
    for (const [convId, convo] of Object.entries(state.conversations)) {
      if (!(convo?.participants ?? []).includes(senderUid)) {
        continue;
      }
      if (typingConversationTag(convId, ownUserId, senderUid) === convTag) {
        return [convId];
      }
    }
    return [];
  }
  const out = new Set<string>(directIds);
  for (const [convId, convo] of Object.entries(state.conversations)) {
    if ((convo?.participants ?? []).includes(senderUid)) {
      out.add(convId);
    }
  }
  return Array.from(out);
}
```

And at the top of the file, after the doc block:

```ts
import {sha256} from '@noble/hashes/sha2.js';
```

(`@noble/hashes ^2.2.0` is already a root dependency — `package.json:60` — and the `messenger-crypto` Jest project already whitelists it in `transformIgnorePatterns`. Same import form as `packages/messenger-core/src/groups/groupClient.ts:4`.)

### 4. `src/modules/messenger/runtime/productionRuntime.ts` — send side

Anchor:

```ts
    sendTyping: (peer, state) => {
      try {
        transport.send({event: 'typing', data: {to: peer, state}});
      } catch { /* socket not open */ }
    },
```

Replace with:

```ts
    sendTyping: (peer, state, conversationId) => {
      try {
        const {typingConversationTag, isGroupConversation, DIRECT_CONVERSATION_KEY} =
          require('./messagingLogic') as typeof import('./messagingLogic');
        let convTag: string | undefined;
        if (conversationId && peer.userId) {
          const key = isGroupConversation(useMessengerStore.getState(), conversationId)
            ? conversationId
            : DIRECT_CONVERSATION_KEY;
          convTag = typingConversationTag(key, ownAddress.userId, peer.userId);
        }
        transport.send({event: 'typing', data: {to: peer, state, convTag}});
      } catch { /* socket not open */ }
    },
```

(The lazy `require('./messagingLogic')` matches the established pattern at `:3285-3286` and `:5230-5231`.)

### 5. `src/modules/messenger/runtime/productionRuntime.ts` — receive side

Anchor:

```ts
const {typingAffectedConversationIds} =
  require('./messagingLogic') as typeof import('./messagingLogic');
const affected = typingAffectedConversationIds(store, senderUid, syntheticId, canonicalId);
```

Replace with:

```ts
const {typingAffectedConversationIds} =
  require('./messagingLogic') as typeof import('./messagingLogic');
// SYNC-6 — scope by the peer's opaque conversation tag when present;
// a tagless frame (legacy peer / ops-console) keeps the old fan-out.
const affected = typingAffectedConversationIds(
  store,
  senderUid,
  syntheticId,
  canonicalId,
  frame.data.convTag,
  deps.config.ownUserId,
);
```

Also retire the now-stale comment above it — replace

```ts
// Typing frames carry only `from` (peer address) — no conversation
// id — so for 1:1 we map to `direct:<peerUserId>` and for groups
// we set the typing flag on every group whose participants include
// this sender. Without the fan-out the mission-group ChatScreen
// would never light up because its conversation id is the group
// UUID, not the synthetic `direct:` key.
```

with

```ts
// SYNC-6 — frames from an updated peer carry an opaque per-pair
// `convTag` that resolves to exactly one thread. Tagless frames
// (older peers) still fan out to the direct slot + every shared
// group, which is why one peer typing could paint "typing…" in
// every mutual conversation.
```

`deps.config.ownUserId` is in scope inside `handleServerFrame(frame, deps)` (`ProductionConfig.ownUserId`, `:134`).

### 6. `src/modules/messenger/runtime/runtime.ts` — interface + loopback

Anchor:

```ts
  /** Emit a typing indicator to a specific peer (start / stop). */
  sendTyping(peer: SessionAddress, state: 'start' | 'stop'): void;
```

Replace with:

```ts
  /**
   * Emit a typing indicator to a specific peer (start / stop).
   * `conversationId` (SYNC-6) scopes the indicator to one thread on the
   * receiving side; omitting it degrades to the legacy fan-out.
   */
  sendTyping(peer: SessionAddress, state: 'start' | 'stop', conversationId?: string): void;
```

The loopback stub at `:605` (`sendTyping: () => { /* no-op */ }`) needs no change — extra optional params are assignable.

### 7. `src/screens/messenger/ChatScreen.tsx` — pass the conversation id at all five call sites

Anchors and replacements (`:593`, `:598`, `:601`, `:624`, `:670`):

```ts
for (const peer of groupPeers) {
  runtime.sendTyping(peer, 'start');
}
```

→ `for (const peer of groupPeers) {runtime.sendTyping(peer, 'start', conversationId);}` (both `start` sites)

```ts
for (const peer of groupPeers) {
  runtime.sendTyping(peer, 'stop');
}
```

→ `for (const peer of groupPeers) {runtime.sendTyping(peer, 'stop', conversationId);}` (the `:601` and `:670` sites)

```ts
try {
  outgoingRuntime.sendTyping(peer, 'stop');
} catch {
  /* ignore */
}
```

→ inside the `useEffect` at `:615-630`, snapshot the id alongside the peers so the cleanup uses the id of the chat being **left**:

```ts
const outgoingPeers = groupPeers;
const outgoingRuntime = runtime;
const outgoingConversationId = conversationId;
return () => {
  if (typingActiveRef.current && outgoingRuntime && outgoingPeers.length > 0) {
    for (const peer of outgoingPeers) {
      try {
        outgoingRuntime.sendTyping(peer, 'stop', outgoingConversationId);
      } catch {
        /* ignore */
      }
    }
  }
  typingActiveRef.current = false;
};
```

The `:593/:598/:601` effect already depends on `conversationId` transitively via `groupPeersKey`; `conversationId` is stable within a mount, so no dep-array change is required (the existing `eslint-disable-next-line react-hooks/exhaustive-deps` stays).

### Wire compatibility (server deploys first)

| sender      | server  | receiver | behaviour                                                                                                                         |
| ----------- | ------- | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| new         | new     | new      | tag present → scoped to one thread (**fixed**)                                                                                    |
| new         | **old** | new      | old gateway rebuilds the frame as `{from, state}` and drops `convTag` → receiver falls back to legacy fan-out (today's behaviour) |
| new         | new     | **old**  | old client ignores the unknown `convTag` field → legacy fan-out                                                                   |
| **old**     | new     | new      | no `convTag` on the wire → `convTag === undefined` → legacy fan-out                                                               |
| ops-console | new     | new      | ops-console never sends a tag → legacy fan-out; ops-console's own receive path is per-user and unaffected                         |

No schema, no migration, no persisted state: `typing` / `typingUsers` are in-memory Zustand slices (`src/modules/messenger/store/messengerStore.ts:411`), never written to SQLCipher. There is no relay/Redis write and no DTO class for WS frames (the global `ValidationPipe` in `apps/messenger-service/src/main.ts:86` only fires on decorated DTO classes; `@MessageBody() data: ClientTyping['data']` erases to `Object`), so `forbidNonWhitelisted` cannot 400 the new field.

## Blast radius

**Files edited (8 + 1 optional):**

- `apps/messenger-service/src/gateway/messenger.gateway.ts` — `handleTyping`, `typingKey`, new `sanitizeConvTag` / `typingFrame`
- `apps/messenger-service/src/gateway/protocol.ts` — `ClientTyping`, `ServerTyping`
- `packages/messenger-core/src/transport/protocol.ts` — `ClientTyping`, `ServerTyping`
- `src/modules/messenger/transport/protocol.ts` — same two (mirror file; header mandates same-commit sync)
- `src/modules/messenger/runtime/messagingLogic.ts` — new `typingConversationTag`, `DIRECT_CONVERSATION_KEY`; `typingAffectedConversationIds` gains two optional params
- `src/modules/messenger/runtime/productionRuntime.ts` — `sendTyping` (`~:3269`) and `handleServerFrame` `case 'typing'` (`~:5203`)
- `src/modules/messenger/runtime/runtime.ts` — `MessengerRuntime.sendTyping` signature
- `src/screens/messenger/ChatScreen.tsx` — five `sendTyping` call sites + one closure snapshot
- (optional) `apps/ops-console/src/lib/messenger/protocol.ts` — type parity only

**Callers checked:** `sendTyping` has exactly two implementations (`productionRuntime.ts:3269`, loopback `runtime.ts:605`) and five call sites, all in `ChatScreen.tsx`. `typingAffectedConversationIds` has one production caller (`productionRuntime.ts:5232`) and one test file. `typingKey` and `clearTypingTimersFrom` are private to the gateway.

**Overlapping findings:** `productionRuntime.ts` is edited by nearly every finding in this batch — the conflict is file-level, not function-level (this touches only `sendTyping` and `case 'typing':`). `messenger.gateway.ts` is also edited by SRV-02 (ringing-state persistence), SRV-03 (connect-time offer drain) and SYNC-5 (`MISSED_CALL_MARKER_TTL_SEC`) — all in the call handlers, not `handleTyping`. `ChatScreen.tsx` overlaps with any UI-lane finding. `messagingLogic.ts` is otherwise untouched in this batch.

**What could regress:**

- Group typing stops rendering entirely if the tag is computed over a conversation key the two sides disagree on. Groups are keyed by the same server/group UUID on both devices (`ChatScreen` `route.params.conversationId` is the group id), so this holds — but a group row that has not yet synced into `state.conversations` on the receiver yields **no** indicator instead of a wrong one.
- 1:1 typing: sender uses `DIRECT_CONVERSATION_KEY`, receiver checks it first — insensitive to the `direct:<uid>` vs UUID mismatch (BS-TY1). Verify this specifically; it is the most-used path.
- BS-TY2 watchdog and the `stop` path are keyed per `(convId, senderUid)` and are unchanged; because scoped applies now touch one conversation, a stale `typingUsers` entry from a legacy-fanout `start` followed by a tagged `stop` is possible for ~8 s during a mixed-version rollout. The watchdog clears it — that is exactly what it exists for.
- The gateway auto-stop timer key changes shape (`…|<tag>`); `clearTypingTimersFrom` prefix matching still works, but a reviewer should confirm the disconnect sweep at `:780`.

## Tests

**`src/modules/messenger/__tests__/messagingLogic.test.ts`** (Jest project `messenger-crypto` — `npm run test:crypto`). Extend the existing `describe('typingAffectedConversationIds (BS-TY1)')` and add:

```ts
describe('typingConversationTag (SYNC-6)', () => {
  it('is symmetric in the pair (both endpoints derive the same tag)', () => {
    expect(typingConversationTag('g1', OWN, ALICE)).toBe(typingConversationTag('g1', ALICE, OWN));
  });
  it('differs per recipient for the SAME group (relay cannot cluster)', () => {
    expect(typingConversationTag('g1', ALICE, OWN)).not.toBe(
      typingConversationTag('g1', ALICE, BOB),
    );
  });
  it('differs per conversation for the same pair', () => {
    expect(typingConversationTag('g1', OWN, ALICE)).not.toBe(
      typingConversationTag('g2', OWN, ALICE),
    );
    expect(typingConversationTag(DIRECT_CONVERSATION_KEY, OWN, ALICE)).not.toBe(
      typingConversationTag('g1', OWN, ALICE),
    );
  });
  it('is 16 lowercase hex chars (matches the gateway sanitizer)', () => {
    expect(typingConversationTag('g1', OWN, ALICE)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('typingAffectedConversationIds — SYNC-6 scoping', () => {
  const s = state({
    'uuid-1': {type: 'direct', participants: [OWN, ALICE]},
    g1: {type: 'group', participants: [OWN, ALICE, BOB]},
    g2: {type: 'group', participants: [OWN, ALICE]},
  });

  it('a DIRECT tag resolves to the direct ids only — no group bleed', () => {
    const tag = typingConversationTag(DIRECT_CONVERSATION_KEY, ALICE, OWN);
    const out = typingAffectedConversationIds(s, ALICE, 'direct:user-alice', 'uuid-1', tag, OWN);
    expect(out.sort()).toEqual(['direct:user-alice', 'uuid-1']);
    expect(out).not.toContain('g1');
  });

  it('a GROUP tag resolves to exactly that group — no direct/other-group bleed', () => {
    const tag = typingConversationTag('g1', ALICE, OWN);
    const out = typingAffectedConversationIds(s, ALICE, 'direct:user-alice', 'uuid-1', tag, OWN);
    expect(out).toEqual(['g1']);
  });

  it('an unresolvable tag resolves to nothing (drop beats mis-paint)', () => {
    const out = typingAffectedConversationIds(
      s,
      ALICE,
      'direct:user-alice',
      'uuid-1',
      '0123456789abcdef',
      OWN,
    );
    expect(out).toEqual([]);
  });

  it('no tag → legacy fan-out preserved (old peers)', () => {
    const out = typingAffectedConversationIds(s, ALICE, 'direct:user-alice', 'uuid-1');
    expect(out).toEqual(expect.arrayContaining(['direct:user-alice', 'uuid-1', 'g1', 'g2']));
  });

  it('no ownUserId → legacy fan-out (defensive)', () => {
    const out = typingAffectedConversationIds(
      s,
      ALICE,
      'direct:user-alice',
      'uuid-1',
      'deadbeefdeadbeef',
    );
    expect(out).toContain('g1');
  });
});
```

Add `typingConversationTag` and `DIRECT_CONVERSATION_KEY` to the import block at `messagingLogic.test.ts:1-9`.

**New: `apps/messenger-service/src/gateway/messenger.gateway.typing.spec.ts`** (run with `cd apps/messenger-service && npm test`). Copy the prototype-invocation harness from `messenger.gateway.privacy.spec.ts:22-65` (`fakeClient` / `fakePrivacy` / `fakeHub` / `typingThis`) and assert:

- `handleTyping.call(self, {to: TO, state: 'start', convTag: 'a1b2c3d4e5f60718'}, fakeClient())` emits `{from: {userId: ME, deviceId: 7}, state: 'start', convTag: 'a1b2c3d4e5f60718'}`.
- A malformed tag (`'NOT-HEX'`, `'a1b2'`, `123`, `'A1B2C3D4E5F60718'` uppercase) is **dropped**, and the emitted frame is exactly `{from, state}` — no `convTag` key (`expect('convTag' in data).toBe(false)`).
- With `jest.useFakeTimers()`, a tagged `start` followed by `jest.advanceTimersByTime(6_000)` emits `{from, state: 'stop', convTag: <same tag>}`.
- Two `start`s from the same sender to the same peer with **different** tags arm **two** timers (`expect(self.typingTimers.size).toBe(2)`).
- Blocked pair still drops silently even with a tag (re-assert the M-07 invariant, no timer armed).

**Existing regression that must pass untouched:** `apps/messenger-service/src/gateway/messenger.gateway.privacy.spec.ts:79-85` asserts the exact frame `{from: {userId: ME, deviceId: 7}, state: 'stop'}` for a tagless call — this is the back-compat proof and must not be edited.

**Gates:** `npm run test:crypto` (direct + regression), `cd apps/messenger-service && npm test`, `npm test -- --selectProjects=app` (ChatScreen), `npm run typecheck` ≤ 47 (`.tsc-baseline.json`), `cd apps/ops-console && npm run typecheck` if the optional protocol mirror is touched.

**Device smoke (the only real proof):** device A opens the 1:1 with B and types; on B, open a **group** both share → must show no "typing…" and the 1:1 row must. Then A types in the group → B's group shows the named bubble and B's 1:1 stays silent. Then repeat with one device on the previous build to confirm the legacy fan-out still lights up (no regression to a hard-fail).

## Risk

1. **The audit's literal fix is not shippable.** "Optional conversationId on the typing frame" would put a raw group UUID on the wire, giving the relay a stable cross-member group identifier — forbidden by the batch architecture ruling and by `MESSENGER_SPEC_COVERAGE.md:69`. A reviewer should check that no code path ever puts `conversationId` itself into `data.convTag`.
2. **Residual metadata delta.** The relay can compute the _direct_ tag itself (it knows both user ids and the domain string), so a tag that differs from the direct tag tells it "these two share some other conversation". That is not new information: the send side **already** fans one typing frame per group member from one socket in the same burst (`ChatScreen.tsx:590-603`), so co-membership is already timing-correlatable today. The tag adds no clustering ability the relay lacks, and — unlike the raw id — is different for every recipient. If even that delta is unacceptable, the follow-up is to fold a coarse day-epoch into the tag domain (receiver checks day-1/day/day+1); it is strictly additive and does not change the wire shape.
3. **Fail-open vs fail-silent.** An unresolvable tag returns `[]`. If group rows land in `state.conversations` later than the first typing frame (fresh install, mid-sync), the indicator is silently missing for a few seconds. That is the intended trade, but a reviewer should confirm no other code depends on `typingAffectedConversationIds` always returning at least the direct ids.
4. **Mixed-version window.** During rollout a `start` may fan out (legacy sender) while the matching `stop` is scoped (updated sender), or vice-versa across an app upgrade mid-composition. The BS-TY2 8 s watchdog and the gateway's 6 s auto-stop bound this; nothing sticks.
5. **`sha256` on the receive hot path.** One hash per candidate conversation per typing frame. Frames are ≤1 per 5 s per peer per thread and the candidate set is filtered to conversations containing the sender, so this is negligible — but if a user has hundreds of shared groups a reviewer may want a small memo keyed by `(convId, senderUid)`.
6. **Not a security fix.** No `verifySenderCert` / `verifySealedAad` / block-gate / epoch behaviour is touched; the M-07 silent-drop stays ahead of the pass-through. The tag is never persisted, never logged, and never fed to the crypto layer, so the `logAudit` gate is unaffected — but confirm no `console.log` of the frame is added.
7. **Four protocol.ts copies.** Type drift here is silent by design (see the mirror file's own header). If only one copy is updated, the mobile build still compiles against `@bravo/messenger-core` and the bug appears "fixed" locally while the gateway strips the field. Verify all three required copies in the same commit.
