# GF-4 - Home sync overwrites group participants with the stale server roster on every non-adder device

## Verdict

**CONFIRMED** (mechanism confirmed; the audit's proposed fix is partly wrong — see §Fix).

Evidence from the current tree:

- `src/screens/messenger/MessengerHomeScreen.tsx:174-186` — the sync takes membership from the server only:
  `const serverMemberIds = c.members.map(m => m.userId);` … `const guard = resolveRosterOverwrite({hasPending: hasPendingRosterIntent(c.id), existingParticipants: existing?.participants, serverParticipants: serverMemberIds});` … `const participants = guard.participants;`
- `src/modules/messenger/runtime/pendingRosterIntents.ts:219-223` — the only escape hatch is `args.hasPending`; otherwise `return {skip: false, participants: args.serverParticipants};`.
- `pendingRosterIntents.ts:52-53` — `let cached: PendingRosterIntent[] | null = null; let cachedOwner: string | null = null;` backed by `AsyncStorage` (`KEY_PREFIX = 'messenger.pendingRosterIntents.v1.'`, line 40) → the queue only ever exists on the device that performed the add/remove. `hasPendingRosterIntent()` is therefore permanently `false` on every other member's device.
- The invariant being violated is stated in the store itself, `src/modules/messenger/store/messengerStore.ts:1048-1058`: “L9 send-recipients-decoupled-from-crypto-membership — keep the conversation's SEND recipient set (`convo.participants`) in lockstep with the crypto membership (`groupState.members`) … Without this an ADDED member received the key + admin events but no actual text messages (the fan-out targets participants, not members), and a REMOVED member kept being fanned out to.” — `gconvo.participants = Object.keys(state.members);`
- The receive path does commit crypto membership for non-adders: `src/modules/messenger/runtime/productionRuntime.ts:7112` `store.setGroupState(next);` after the verified admin `add` action. So participants ARE briefly correct on Bob's device — until the next Home sync clobbers them.
- Fan-out reads exactly the clobbered field: `productionRuntime.ts:2394-2398` — `const convoMemberIds = convo?.participants ?? []; const participants = convoMemberIds.filter(uid => uid && uid !== ownAddress.userId);`

## Mechanism

Group G = {Alice(admin), Bob}. Alice adds Carol.

1. Alice: `runtime.addGroupMember` → rekey → `setGroupState` → her `conversations[G].participants = [Alice, Bob, Carol]` (messengerStore.ts:1057). She then calls `writeServerRosterOrQueue` (`NewChatScreen.tsx:27`); if it fails (offline/5xx) it is queued in **her** AsyncStorage.
2. Bob receives the sealed admin `add` envelope, the reducer applies it, `store.setGroupState(next)` runs (productionRuntime.ts:7112) → Bob's `participants = [Alice, Bob, Carol]`. Bob also gets the new master key. Carol is fully live on Bob's device at this instant.
3. Bob's `MessengerHomeScreen` sync effect fires (mount, or runtime-ready flip — `useEffect(..., [hydrated, runtime])`, line 155/228). It calls `flushRosterIntents(ownId)` — Bob's queue is empty, nothing happens; Alice's pending intent is invisible to him.
4. `hasPendingRosterIntent(G)` → `false` on Bob (cache is his own, and empty) → `resolveRosterOverwrite` returns `participants: serverParticipants`.
5. `/conversations/mine` still returns `[Alice, Bob]` because Alice's roster write hasn't landed. `upsertConversation` is a **full replace** (`messengerStore.ts:438` `s.conversations[c.id] = c;`) → Bob's participants shrink to `[Alice, Bob]`.
6. Bob sends a message: `productionRuntime.ts:2394` fans out to `participants` minus self = `[Alice]`. **Carol never receives Bob's messages**, even though she holds the current epoch's master key and is a verified member of Bob's own `groups[G].members`.

The window is not bounded by "until Alice's write lands" in the worst case: it is unbounded whenever the roster write permanently fails, whenever the conversation is a locally-derived (non-UUID) group id — `isServerBackedConversationId` (line 48) makes the roster write a no-op `{skipped: true}` and **nothing is queued**, so a later /conversations/mine row for that id would shrink forever — and whenever the adder uninstalls/clears storage before flushing.

The symmetric direction is also broken today: after a **remove**, the non-adder's server-fed participants **resurrect** the removed member (server roster still lists them) until the adder's write lands, which is the P1-5 privacy defect the module's own header warns about ("resurrects a removed member (who then still receives fan-out media keys + download grants — a privacy defect)"), just on a device the guard was never able to protect.

## Fix

### Why the audit's literal fix (`union(server, Object.keys(groups[gid].members))`) is wrong

A union is not safe in the remove direction: for a **removed** member the server roster is the stale side, so `server ∪ crypto` re-adds them to Bob's fan-out and the media-regrant/download-grant surface — the exact defect `pendingRosterIntents.ts` was created to stop. A union also revives the pattern that was deliberately reverted at `productionRuntime.ts:2388-2393` ("SERVER IS AUTHORITATIVE for membership. We previously unioned local GroupState.members with the server-fed conversation participants — that let stale dev-contact entries … leak into the fan-out").

The correct rule is the one the store already enforces at every other write site: **when a local `GroupState` exists, the crypto membership IS the participant set** (messengerStore.ts:1057, `groupConversationUpsert.ts:34-38` `const memberIds = Object.keys(state.members); … participants: memberIds`). The Home sync is the only writer that violates it. Fall back to the server roster only when there is no crypto state (server-created rows we have not received a `create` for, direct chats, groups we have left — `leaveGroup` calls `store.removeGroupState(groupId)`, productionRuntime.ts:3988/3995/4051, so the pending-intent skip branch is unaffected).

This is strictly a strengthening: it fixes both the add (Carol excluded) and remove (removed member resurrected) directions on every device, without touching any key material, envelope, wire format, or server behavior.

---

### File 1 — `src/modules/messenger/runtime/pendingRosterIntents.ts`

**Anchor** (verbatim, end of file region):

```ts
export function resolveRosterOverwrite(args: {
  hasPending: boolean;
  existingParticipants: string[] | undefined;
  serverParticipants: string[];
}): {skip: boolean; participants: string[]} {
  if (args.hasPending) {
    if (!args.existingParticipants) {
      return {skip: true, participants: args.serverParticipants};
    }
    return {skip: false, participants: args.existingParticipants};
  }
  return {skip: false, participants: args.serverParticipants};
}
```

**Replacement** (also update the doc-comment directly above it — anchor `*   - no local row        → skip the upsert entirely (don't re-create a group` … keep it, append the new bullet):

```ts
/**
 * Home-sync guard decision. When a roster write is still pending for a
 * conversation the LOCAL participants are authoritative (the crypto change
 * already applied); the stale server roster must not overwrite them:
 *   - existing local row  → keep its participants (don't resurrect/drop a member)
 *   - no local row        → skip the upsert entirely (don't re-create a group
 *                            the user just left while its self-removal is pending)
 *
 * GF-4 — the pending queue is device-local (owner-scoped AsyncStorage), so it
 * only ever protects the device that made the change. On every OTHER member's
 * device the crypto membership (`groups[gid].members`, committed by the verified
 * admin envelope) is the source of truth for `convo.participants` — the same
 * invariant `setGroupState` enforces (L9). When we hold group state, use it; the
 * server roster is only a fallback for rows we have no crypto state for.
 */
export function resolveRosterOverwrite(args: {
  hasPending: boolean;
  existingParticipants: string[] | undefined;
  serverParticipants: string[];
  cryptoMembers?: string[];
}): {skip: boolean; participants: string[]} {
  if (args.hasPending) {
    if (!args.existingParticipants) {
      return {skip: true, participants: args.serverParticipants};
    }
    return {skip: false, participants: args.existingParticipants};
  }
  if (args.cryptoMembers && args.cryptoMembers.length > 0) {
    return {skip: false, participants: args.cryptoMembers};
  }
  return {skip: false, participants: args.serverParticipants};
}
```

Notes:

- `cryptoMembers` is optional → every existing caller/test compiles unchanged.
- The `length > 0` check means a degenerate/empty `members` map can never blank the roster.
- Ordering is deliberate: `hasPending` stays first so the "skip re-creating a left group" branch keeps working even in the tick where `groups[gid]` was already deleted.

### File 2 — `src/screens/messenger/MessengerHomeScreen.tsx`

**Anchor** (verbatim):

```ts
const guard = resolveRosterOverwrite({
  hasPending: hasPendingRosterIntent(c.id),
  existingParticipants: existing?.participants,
  serverParticipants: serverMemberIds,
});
```

**Replacement:**

```ts
// GF-4 — on a NON-adder device the pending-intent queue is always
// empty (it is owner-scoped AsyncStorage on the device that made the
// change), so the stale server roster used to shrink a just-added
// member back out of `participants` — the group fan-out set. Crypto
// membership wins whenever we hold group state.
const cryptoState = c.kind === 'direct' ? undefined : useMessengerStore.getState().groups[c.id];
const guard = resolveRosterOverwrite({
  hasPending: hasPendingRosterIntent(c.id),
  existingParticipants: existing?.participants,
  serverParticipants: serverMemberIds,
  cryptoMembers: cryptoState ? Object.keys(cryptoState.members) : undefined,
});
```

`useMessengerStore` is already imported (`MessengerHomeScreen.tsx:23`) and already read the same way two lines above (`const existing = useMessengerStore.getState().conversations[c.id];`). `c.kind` is `'direct' | 'group'` (services/api.ts:1778), so the direct-chat guard is exact.

### File 3 (optional, same class, 3 lines) — `src/screens/messenger/ChatScreen.tsx`

The group-hydration effect (`ChatScreen.tsx:415-450`) does the same server-authoritative mapping. It is gated on `have === false` (participants empty), so it can only fire when the local row has no membership — but a row created by the Home sync _before_ the `create` envelope landed will have a non-empty server roster and a later-arriving crypto state, and the effect re-runs on `conversation?.participants?.length`. Applying the same rule keeps the two sync paths from disagreeing:

**Anchor:**

```ts
const memberIds = row.members.map(m => m.userId);
```

**Replacement:**

```ts
const cryptoState = useMessengerStore.getState().groups[conversationId];
const memberIds =
  cryptoState && Object.keys(cryptoState.members).length > 0
    ? Object.keys(cryptoState.members)
    : row.members.map(m => m.userId);
```

If you want the absolutely minimal diff, ship files 1+2 only and log File 3 as a follow-up; it is not on the reported failure path.

### Schema / wire format

**None.** No SQLCipher table, no migration, no store `partialize` change, no envelope/DTO field, no server change. `groups[gid]` is already persisted by the existing zustand persist slice (with `masterKeyB64` stripped by partialize — `members` survives). Old clients are unaffected: this is a purely local read-preference change, and the server roster write path (`writeServerRosterOrQueue` → `conversationApi.addMember/removeMember`) is untouched, so server state still converges for clients that have not updated.

## Blast radius

- `resolveRosterOverwrite` — 1 production call site (`MessengerHomeScreen.tsx:180`) + 3 assertions in `src/modules/messenger/__tests__/pendingRosterIntents.test.ts:170-189`. New param is optional → no breakage.
- `conversations[gid].participants` consumers that change behavior:
  - `productionRuntime.ts:2394` group fan-out (the fix's target) and the 250-recipient cap at `:4105`/`:2399`.
  - `resolveKeyRequestTargets` (`groupConversationUpsert.ts:94-103`) — key-request targets now follow crypto membership; strictly better (a non-member can no longer be solicited).
  - Read-receipt "all others have read" derivation (`recordReadReceipts`, messengerStore.ts:210 doc) — a group whose server roster was inflated will now flip to `read` on the true member set. Intended.
  - Media re-grant on add (`productionRuntime.ts:4304`) — unchanged, keyed off the add action, not participants.
- `groups[]` is read, never written, by this change. No key material is read, moved, or logged (`masterKeyB64` is never touched — only `Object.keys(members)`), so `packages/messenger-core/__tests__/logAudit.test.ts` is unaffected.
- Overlapping findings: **GF-2/SYNC-2** (durable group key fan-out) and **GF-3** (decrypt-failure self-heal) touch the same admin-envelope receive path in `productionRuntime.ts` around `setGroupState`; this change does not edit that path, only the Home-sync reader, so the diffs should not collide. Anything else editing `MessengerHomeScreen.tsx`'s sync effect (roster/prune work) will conflict textually.
- What could regress:
  1. A device whose `groups[gid]` is **stale** (missed admin envelopes) now pins the stale roster instead of adopting the server's. Bounded: the missed admin envelopes are still on the relay (30-day dwell) and `setGroupState` re-syncs participants the moment they apply. Also, a member the local crypto state doesn't know about has no master key from our epoch, so fanning out to them was never useful.
  2. Server-side (ops/REST) membership changes on mission/ops rooms are now invisible to `participants` until an admin device drains the intent (`orgWorkspace/conversationIntents.ts:47-64` → `addGroupMember`/`removeGroupMember` → rekey → admin envelope). That is already the security model — until the rekey, the new member holds no key.
  3. Ad-hoc `'Call'` groups keep crypto state (`groups[gid].name === 'Call'`); they have no conversation row by design (`upsertKeylessGroupPlaceholder` bails, groupConversationUpsert.ts:73) and `/conversations/mine` does not return them, so they never reach this branch.

## Tests

Jest project: **`messenger-crypto`** (`src/modules/messenger/__tests__/**/*.test.ts` per package.json `projects`). Run `npm run test:crypto`.

### Extend `src/modules/messenger/__tests__/pendingRosterIntents.test.ts`

Inside the existing `describe('resolveRosterOverwrite (Home-sync guard)')` block:

```ts
it('GF-4 — crypto membership wins over a stale server roster (added member kept)', () => {
  expect(
    resolveRosterOverwrite({
      hasPending: false,
      existingParticipants: ['self', 'alice', 'carol'],
      serverParticipants: ['self', 'alice'],
      cryptoMembers: ['self', 'alice', 'carol'],
    }),
  ).toEqual({skip: false, participants: ['self', 'alice', 'carol']});
});

it('GF-4 — crypto membership wins over a stale server roster (removed member NOT resurrected)', () => {
  expect(
    resolveRosterOverwrite({
      hasPending: false,
      existingParticipants: ['self', 'alice'],
      serverParticipants: ['self', 'alice', 'removed'],
      cryptoMembers: ['self', 'alice'],
    }),
  ).toEqual({skip: false, participants: ['self', 'alice']});
});

it('GF-4 — falls back to the server roster with no local group state', () => {
  expect(
    resolveRosterOverwrite({
      hasPending: false,
      existingParticipants: ['self'],
      serverParticipants: ['self', 'x'],
      cryptoMembers: undefined,
    }),
  ).toEqual({skip: false, participants: ['self', 'x']});
});

it('GF-4 — an empty crypto member map never blanks the roster', () => {
  expect(
    resolveRosterOverwrite({
      hasPending: false,
      existingParticipants: ['self', 'x'],
      serverParticipants: ['self', 'x'],
      cryptoMembers: [],
    }),
  ).toEqual({skip: false, participants: ['self', 'x']});
});

it('GF-4 — a pending self-removal still skips re-creating the left group', () => {
  expect(
    resolveRosterOverwrite({
      hasPending: true,
      existingParticipants: undefined,
      serverParticipants: ['self', 'other'],
      cryptoMembers: undefined,
    }),
  ).toEqual({skip: true, participants: ['self', 'other']});
});
```

The three existing assertions at lines 171-188 must pass unchanged (proves the optional param is back-compatible).

### Regression suites

- `npm run test:crypto` (whole `messenger-crypto` project — includes `conversationIntents.test.ts`, the group admin/rekey suites, and `logAudit.test.ts`).
- `npm run typecheck` — must stay at/below the `.tsc-baseline.json` count (47).
- No `apps/messenger-service` change → its suite is not required, but it costs nothing to leave green.

### Device probe (state it explicitly if not run)

3 devices, group G: A(admin) + B. Put A in airplane mode **after** the local add of C lands (so A's roster write queues), confirm B receives the admin add, then background/foreground B (fires the Home sync) and send from B → C must receive it. Then bring A online, confirm `/conversations/mine` converges and nothing changes on B. Repeat for remove: C must stop receiving B's fan-out immediately, not after A's write lands.

## Risk

A reviewer should be suspicious of:

1. **Direction of authority.** This deliberately contradicts the comment at `productionRuntime.ts:2388` ("SERVER IS AUTHORITATIVE for membership"). The rebuttal is that `setGroupState` (messengerStore.ts:1057) and `upsertGroupConversationFromState` (groupConversationUpsert.ts:38) already make crypto membership authoritative for `participants` at every other write site — the Home sync is the outlier, and the 2388 comment is about a _union_ (which this spec rejects), not about crypto-only. If a reviewer disagrees, the fallback increment is: apply crypto membership only when it is a **superset** of the server roster (fixes the add case, leaves the remove case to the existing pending-intent guard) — smaller but only half the fix.
2. **Stale-crypto lock-in.** If a device permanently misses an admin `add` envelope (the GF-2/GF-3 failure class), it will now never learn the member from the server either. Confirm the relay-dwell/replay path (30-day dwell + `pendingAdminActions` stash at productionRuntime.ts:7103) actually re-applies, and consider whether GF-2's fix should land in the same wave.
3. **Direct chats.** Verify `c.kind === 'direct'` really excludes 1:1 rows; a stray `groups[<direct-uuid>]` (ad-hoc call state keyed on a conversation id — see the `'Call'` sentinel handling) must not become a direct chat's participant list.
4. **Ordering of the two branches.** `hasPending` is checked before `cryptoMembers` on purpose (leave/self-removal). Flipping them would re-create a left group.
5. **No security-check weakening.** Nothing here touches `verifySenderCert`, `verifySealedAad`, the B-42 epoch guard, group master-key distribution, or the admin-action authorisation reducer; membership still only changes via a verified admin envelope. The change is read-side only.
