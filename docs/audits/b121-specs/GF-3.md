# GF-3 — Stale-key group self-heal is dead code, and the boot drain burns the stash while no new key ever arrives

## Verdict

**CONFIRMED** (both halves, in the current tree; audit line numbers drift by ~0-5 lines).

1. The resync impl skips exactly the divergence case that triggers it —
   `src/modules/messenger/runtime/productionRuntime.ts:2128-2133`:
   ```ts
   for (const gid of candidateIds) {
     // Already have the key — nothing to recover.
     if (store.groups[gid]?.masterKeyB64) {continue;}
   ```
   …and the same gate is applied again when building `candidateIds` (`:2122-2125`,
   `&& !store.groups[id]?.masterKeyB64`).
2. The trigger that this gate kills is the **tamper = key-divergence** branch —
   `productionRuntime.ts:6685`:
   `return {kind: 'request-group-key', groupId: unwrapped.group.groupId, fromPeer: {userId: peer.userId, deviceId: peer.deviceId}};`
   reached only after `parseResult.reason === 'tamper'` (`:6660`), i.e. **we hold a master key and it
   failed `groupDecrypt`**. Dispatch is intact (`:5962-5964` → `emitGroupKeySignal({kind:'request'…})` →
   `:2213-2214` → `requestGroupKeyResyncImpl(sig.groupId, sig.fromPeer)`), so the request reaches the
   impl and is then silently `continue`d. Dead code confirmed end-to-end.
3. The `no_key` sibling branch (`:6727-6771`) is unaffected (no key ⇒ passes the gate) — the defect is
   divergence-specific, which is why it survived the existing tests.
4. Stash-attempt burn confirmed: boot selects every group **that has a key** —
   `bootGroupStashDrain.ts:33-35` (`.filter(([, gs]) => !!gs.masterKeyB64)`) — and
   `drainPendingGroup` replays each row; a diverged row re-fails
   (`replayGroupSealedDecode` `:6162-6164` `throw new Error('replay: parse ' + reason)`), and the catch
   at `:6117-6122` does `bumpAttempts` → `if (attempts >= PENDING_GROUP_MAX_ATTEMPTS) delete`.
   `PENDING_GROUP_MAX_ATTEMPTS = 3` (`store/pendingGroupEnvelopeStore.ts:58`). Three launches ⇒ the
   only copy is destroyed (the relay copy was ACKed away at stash time — see that file's header).
5. Recovery _would_ work if the request were sent: the owner/relayer answers with a re-signed `create`
   at the same epoch and `:6970-7003` (Audit G-04 same-epoch heal) replaces the divergent key, then
   `:7053` returns `{kind:'drain-group'}` which drains the stash. So the only missing link is the
   request itself.

## Mechanism

1. Member M's group master key diverges from the sender's (missed `rekey` fan-out — the GF-2 class —
   or a same-epoch fork, B-35).
2. A group text arrives. `parseGroupMessage(sealed, ourStaleKey)` → `{ok:false, reason:'tamper'}`.
3. The receive path stashes the envelope in `pending_group_envelopes`, sets the "re-syncing" banner,
   and returns `{kind:'request-group-key', groupId, fromPeer}` (`:6660-6685`). The relay copy is ACKed
   — the stash row is now the **only** copy of that message on Earth.
4. `handleIncoming` emits `{kind:'request'}`; the factory handler calls `requestGroupKeyResyncImpl(gid, fromPeer)`.
5. `requestGroupKeyResyncImpl` sees `store.groups[gid].masterKeyB64` is present (it _is_ — it's just the
   wrong one) and `continue`s. **No `key-request` is ever sent.** No owner reshare, no `create`, no drain.
6. Every subsequent group message repeats steps 2-5: more stash rows, more banners, zero recovery.
7. On each app launch the boot key-restore path selects this group (it has _a_ key), replays every
   stashed row against the same stale key, each throws, each burns one attempt. **Launch 3 deletes the
   rows.** The messages are gone permanently and the thread has a silent, unexplained gap.
8. Composed with GF-2 (a rekey that never reaches M) the member is silent forever and the evidence is
   erased.

## Fix

Two independent, small changes plus one optional third. No wire-format change, no schema change, no
new server behaviour, no relaxation of any verify. The `key-request` remains signed, roster-gated on
the responder (`:6858-6866` + `reshareGroupKeyState` `:1984-1999`) and rate-limited by the existing
20 s per-group cooldown (`KEY_REQUEST_COOLDOWN_MS`, `:1959`) — matching the batch architecture
constraint for GF-3 (60 s/peer identity-rotation precedent).

### A. Let a _divergence_ resync through the keyless gate

**A1 — `src/modules/messenger/runtime/groupConversationUpsert.ts`** (new exported helper, placed
directly after `resolveKeyRequestTargets`; that function is the existing home for key-request policy).

Anchor (end of file):

```ts
export function resolveKeyRequestTargets(
  participants: string[] | undefined,
  ownUserId: string,
  fallbackPeerUserId?: string,
): string[] {
  const fromConvo = (participants ?? []).filter(uid => uid && uid !== ownUserId);
  if (fromConvo.length > 0) {
    return fromConvo;
  }
  if (fallbackPeerUserId && fallbackPeerUserId !== ownUserId) {
    return [fallbackPeerUserId];
  }
  return [];
}
```

Insert after it:

```ts
/**
 * GF-3 — which groups a key-resync sweep should ask about.
 *
 * The default sweep is keyless-only: holding a key means nothing to recover.
 * A DIVERGENCE resync is the exception — it is raised by the receive path
 * precisely because the key we hold FAILED to decrypt (`tamper`), so the
 * keyless filter would drop the only case that needed it.
 */
export function selectKeyResyncCandidates(args: {
  groups: Record<string, {masterKeyB64?: string} | undefined>;
  conversations: Record<string, {type?: string} | undefined>;
  groupId?: string;
  divergence?: boolean;
}): string[] {
  const {groups, conversations, groupId, divergence} = args;
  const ids = groupId
    ? [groupId]
    : Object.keys(conversations).filter(id => {
        const c = conversations[id];
        return c?.type === 'group' || c?.type === 'ops_channel';
      });
  return ids.filter(id => divergence === true || !groups[id]?.masterKeyB64);
}
```

**A2 — `productionRuntime.ts` import** (`:71-75`).

Anchor:

```ts
import {
  upsertGroupConversationFromState,
  upsertKeylessGroupPlaceholder,
  resolveKeyRequestTargets,
} from './groupConversationUpsert';
```

Replacement:

```ts
import {
  upsertGroupConversationFromState,
  upsertKeylessGroupPlaceholder,
  resolveKeyRequestTargets,
  selectKeyResyncCandidates,
} from './groupConversationUpsert';
```

**A3 — `productionRuntime.ts` resync impl** (`:2114-2133`).

Anchor:

```ts
  const requestGroupKeyResyncImpl = async (
    groupId?: string,
    fallbackPeer?: SessionAddress,
  ): Promise<void> => {
    const store = useMessengerStore.getState();
    const conversations = store.conversations;
    const candidateIds = groupId
      ? [groupId]
      : Object.keys(conversations).filter(id => {
          const c = conversations[id];
          return (c?.type === 'group' || c?.type === 'ops_channel') && !store.groups[id]?.masterKeyB64;
        });
    const now = Date.now();
    pruneCooldownMap(keyRequestSentAt, 10 * 60 * 1000, now);
    for (const gid of candidateIds) {
      // Already have the key — nothing to recover.
      if (store.groups[gid]?.masterKeyB64) {continue;}
      // Rate-limit per group so opening a chat repeatedly / reconnect
      // storms don't amplify into a request flood.
      if (now - (keyRequestSentAt.get(gid) ?? 0) < KEY_REQUEST_COOLDOWN_MS) {continue;}
```

Replacement:

```ts
  const requestGroupKeyResyncImpl = async (
    groupId?: string,
    fallbackPeer?: SessionAddress,
    opts?: {divergence?: boolean},
  ): Promise<void> => {
    const store = useMessengerStore.getState();
    const conversations = store.conversations;
    // Why: a divergence resync is raised because the key we HOLD failed to
    // decrypt, so the keyless-only filter used to drop it (GF-3 dead code).
    const candidateIds = selectKeyResyncCandidates({
      groups:        store.groups,
      conversations,
      groupId,
      divergence:    opts?.divergence,
    });
    const now = Date.now();
    pruneCooldownMap(keyRequestSentAt, 10 * 60 * 1000, now);
    for (const gid of candidateIds) {
      // Rate-limit per group so opening a chat repeatedly / reconnect
      // storms don't amplify into a request flood.
      if (now - (keyRequestSentAt.get(gid) ?? 0) < KEY_REQUEST_COOLDOWN_MS) {continue;}
```

Everything below (`resolveKeyRequestTargets`, `keyRequestSentAt.set`, `sendKeyRequest(gid, participants,
store.groups[gid]?.epoch)`) is unchanged. `atEpochSeen` now carries our stale epoch on the divergence
path, which is exactly the diagnostic the owner wants and is ignored by the reducer
(`groupClient.ts:453-460` — `key-request` is inert in `applyAdminAction`).

**A4 — carry the flag on the two internal buses** (`productionRuntime.ts`).

Anchor (`:5753-5766`, `RequestGroupKeyRequest`):

```ts
interface RequestGroupKeyRequest {
  kind:               'request-group-key';
  groupId:            string;
```

Replacement:

```ts
interface RequestGroupKeyRequest {
  kind:               'request-group-key';
  groupId:            string;
  /** GF-3 — raised by the `tamper` branch: we HOLD a key and it failed to
   *  decrypt. Lets the resync bypass its keyless-only candidate filter. */
  divergence?:        boolean;
```

Anchor (`:5819-5821`, `GroupKeySignal`):

```ts
  | {kind: 'request'; groupId: string; fromPeer?: SessionAddress}
```

Replacement:

```ts
  | {kind: 'request'; groupId: string; fromPeer?: SessionAddress; divergence?: boolean}
```

Anchor (`:5962-5964`):

```ts
if (post.kind === 'request-group-key') {
  emitGroupKeySignal({kind: 'request', groupId: post.groupId, fromPeer: post.fromPeer});
}
```

Replacement:

```ts
if (post.kind === 'request-group-key') {
  emitGroupKeySignal({
    kind: 'request',
    groupId: post.groupId,
    fromPeer: post.fromPeer,
    divergence: post.divergence,
  });
}
```

Anchor (`:2213-2214`):

```ts
    } else if (sig.kind === 'request') {
      void requestGroupKeyResyncImpl(sig.groupId, sig.fromPeer);
```

Replacement:

```ts
    } else if (sig.kind === 'request') {
      void requestGroupKeyResyncImpl(sig.groupId, sig.fromPeer, {divergence: sig.divergence === true});
```

**A5 — set the flag at the tamper site** (`productionRuntime.ts:6685`).

Anchor:

```ts
        return {kind: 'request-group-key', groupId: unwrapped.group.groupId, fromPeer: {userId: peer.userId, deviceId: peer.deviceId}};
      }
      if (parseResult.reason === 'tamper') {
```

Replacement:

```ts
        return {kind: 'request-group-key', groupId: unwrapped.group.groupId, fromPeer: {userId: peer.userId, deviceId: peer.deviceId}, divergence: true};
      }
      if (parseResult.reason === 'tamper') {
```

The `no_key` return at `:6771` is left untouched (no flag ⇒ today's behaviour).

### B. Stop burning stash attempts while no NEW key has arrived

Policy: an attempt is spent only when the replay failed for a reason a _new key_ could not have fixed
(structurally broken row), **or** when the drain was triggered by an actual key installation. The boot
drain installs nothing new — it restores what was already on disk — so it must never burn attempts.
The live drain sites are, by construction, post-key-change (`:7053` is after `setGroupState(create)`;
`:7162` is inside `if (existing.masterKeyB64 !== next.masterKeyB64)`), so genuine tamper is still
evicted after 3 real key changes: the fail-closed eviction semantics are preserved, only the
free-running boot burn is removed.

**B1 — `src/modules/messenger/runtime/bootGroupStashDrain.ts`** (append; this module already owns
drain policy and is already imported by `productionRuntime.ts:36`).

Anchor (end of file):

```ts
export function selectGroupIdsToDrain(groups: Record<string, {masterKeyB64?: string}>): string[] {
  return Object.entries(groups)
    .filter(([, gs]) => !!gs.masterKeyB64)
    .map(([gid]) => gid);
}
```

Insert after it:

```ts
/**
 * GF-3 — a replay that failed because the key we hold still can't open the
 * row (absent, or diverged). Recoverable: a later key install may fix it, so
 * the drain must not spend one of the row's bounded attempts on it.
 */
export class ReplayNeedsKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayNeedsKeyError';
  }
}

/**
 * GF-3 — attempt-spend policy for a failed stash replay.
 *
 * `PENDING_GROUP_MAX_ATTEMPTS` exists to evict a row that will never decrypt.
 * The boot drain re-runs against the SAME on-disk key every launch, so a
 * key-divergence row used to burn all three attempts in three launches and be
 * deleted — destroying the only surviving copy (stashing ACKs the relay).
 * Spend an attempt only when the failure is structural (no key could fix it)
 * or when this drain actually followed a NEW key landing.
 */
export function shouldBumpStashAttempt(args: {needsKey: boolean; keyChanged: boolean}): boolean {
  return !args.needsKey || args.keyChanged;
}
```

**B2 — `productionRuntime.ts` import** (`:36`).

Anchor:

```ts
import {selectGroupIdsToDrain} from './bootGroupStashDrain';
```

Replacement:

```ts
import {
  selectGroupIdsToDrain,
  shouldBumpStashAttempt,
  ReplayNeedsKeyError,
} from './bootGroupStashDrain';
```

**B3 — typed recoverable failure in `replayGroupSealedDecode`** (`:6156-6164`).

Anchor:

```ts
const masterKey = existing?.masterKeyB64;
if (!masterKey) {
  throw new Error('replay: master key still missing post-drain');
}
const parseResult = await parseGroupMessage(sealed, masterKey);
if (!parseResult.ok) {
  throw new Error(`replay: parse ${parseResult.reason}`);
}
```

Replacement:

```ts
const masterKey = existing?.masterKeyB64;
if (!masterKey) {
  throw new ReplayNeedsKeyError('replay: master key still missing post-drain');
}
const parseResult = await parseGroupMessage(sealed, masterKey);
if (!parseResult.ok) {
  if (parseResult.reason === 'no_key' || parseResult.reason === 'tamper') {
    throw new ReplayNeedsKeyError(`replay: parse ${parseResult.reason}`);
  }
  throw new Error(`replay: parse ${parseResult.reason}`);
}
```

**B4 — `drainPendingGroup` spends attempts conditionally, and reports whether rows are still
key-blocked** (`:6080-6131`).

Anchor (signature + catch):

```ts
async function drainPendingGroup(
  groupId: string,
  config: ProductionConfig,
  txnDb: TxnDbHandle,
  sqlMessages: SqlMessageStore,
  seenEnvelopes: SeenEnvelopeStore | null,
  pendingGroupEnvelopes: PendingGroupEnvelopeStore,
  pendingAdminActions: PendingAdminActionStore | null,
): Promise<void> {
```

Replacement:

```ts
async function drainPendingGroup(
  groupId: string,
  config: ProductionConfig,
  txnDb: TxnDbHandle,
  sqlMessages: SqlMessageStore,
  seenEnvelopes: SeenEnvelopeStore | null,
  pendingGroupEnvelopes: PendingGroupEnvelopeStore,
  pendingAdminActions: PendingAdminActionStore | null,
  keyChanged: boolean,
): Promise<boolean> {
```

Inside, after `if (rows.length > 0) {...}` add:

```ts
let stillKeyBlocked = false;
```

Anchor (catch body):

```ts
      try {
        const attempts = await pendingGroupEnvelopes.bumpAttempts(row.envelopeId);
        if (attempts >= PENDING_GROUP_MAX_ATTEMPTS) {
          await pendingGroupEnvelopes.delete(row.envelopeId);
        }
      } catch { /* swallow */ }
    }
  }
```

Replacement:

```ts
      const needsKey = e instanceof ReplayNeedsKeyError;
      if (needsKey) {stillKeyBlocked = true;}
      if (!shouldBumpStashAttempt({needsKey, keyChanged})) {continue;}
      try {
        const attempts = await pendingGroupEnvelopes.bumpAttempts(row.envelopeId);
        if (attempts >= PENDING_GROUP_MAX_ATTEMPTS) {
          await pendingGroupEnvelopes.delete(row.envelopeId);
        }
      } catch { /* swallow */ }
    }
  }
```

And change the tail `if (pendingAdminActions) {await drainPendingAdminActions(groupId, pendingAdminActions);}`
to be followed by `return stillKeyBlocked;` (also `return false;` on the early `list failed` bail at `:6094`).

**B5 — call sites.**

Post-txn drain (`:5951-5954`) — a create/rekey just installed a new key:

```ts
void drainPendingGroup(
  post.groupId,
  config,
  txnDb,
  sqlMessages,
  seenEnvelopes ?? null,
  pendingGroupEnvelopes,
  pendingAdminActions ?? null,
  true,
);
```

Boot drain (`:1712-1719`) — nothing new landed; also (optional, see Risk) kick a divergence resync for
a group whose rows are still key-blocked despite our holding a key:

```ts
for (const gid of selectGroupIdsToDrain(merged)) {
  void drainPendingGroup(
    gid,
    config,
    txnDbForDrain,
    sqlMessages,
    seenEnvelopes,
    pendingGroupEnvelopes,
    pendingAdminActions,
    false,
  )
    .then(stillKeyBlocked => {
      // GF-3 — we hold a key but the stash still won't open under it:
      // that is divergence. Ask once per boot (20s cooldown inside).
      if (stillKeyBlocked) {
        void requestGroupKeyResyncImpl(gid, undefined, {divergence: true}).catch(() => {
          /* best-effort */
        });
      }
    })
    .catch(err =>
      console.warn(
        '[messenger] boot group-stash drain failed',
        gid.slice(0, 8),
        asErrorMessage(err),
      ),
    );
}
```

`requestGroupKeyResyncImpl` is a `const` declared later in the same factory; the reference is safe
because the callback only runs after construction — the identical pattern and comment already exist at
`:1136-1144`.

### Back-compat / wire format

Nothing on the wire changes. `divergence` and `keyChanged` are process-internal. The emitted
`key-request` is byte-identical to today's (`{type:'key-request', groupId, atEpochSeen}`, unwrapped
under the pairwise session, signed transcript bytes at `groupClient.ts:411`), so old peers answer it
exactly as they answer a keyless member's request. No schema bump (`SCHEMA_VERSION` stays 14) — the
attempt policy is a decision, not a column. `requestGroupKeyResync` in `runtime.ts:370` keeps its
public one-argument signature; the third parameter is optional and only the internal signal handler
passes it, so `ChatScreen`, `DepartmentChatScreen`, `useGroupCall`, and the reconnect sweep are
untouched and keep today's keyless-only behaviour.

## Blast radius

- `productionRuntime.ts`: `requestGroupKeyResyncImpl` (callers: reconnect sweep `:1143`, signal handler
  `:2214`, `runtimeApi.requestGroupKeyResync` `:2294` → `ChatScreen.tsx:389-395`,
  `DepartmentChatScreen.tsx:258`, `useGroupCall.ts:1528/1569`) — all four external callers pass one
  argument and are behaviourally unchanged. `drainPendingGroup` (2 call sites, both updated),
  `replayGroupSealedDecode` (1 caller), `RequestGroupKeyRequest` / `GroupKeySignal` (module-local).
- `groupConversationUpsert.ts`, `bootGroupStashDrain.ts`: additive exports only.
- **Overlaps**: **GF-5** edits the same `if (!parseResult.ok)` block in `doHandleIncoming` (the
  plaintext-inner fall-through immediately below `:6772`) — same function, adjacent lines; sequence
  them. **GF-2/SYNC-2** (durable group-key fan-out) edits `sendKeyRequest`/`reshareGroupKeyState`/
  `broadcastToGroup` delivery in the same factory region `:1974-2148` — high textual conflict risk,
  and semantically complementary (GF-2 makes the answer durable, GF-3 makes the question get asked).
  Land GF-2 first if both are in flight.
- **Regression risks**: (a) more `key-request` traffic on genuinely-forked groups — bounded by the
  unchanged 20 s/group cooldown and by the responder's roster gate; (b) diverged stash rows now live
  up to the 30-day `RETENTION_MS` prune instead of dying in 3 launches — bounded by the existing
  256/group + 2048/global eviction caps in `pendingGroupEnvelopeStore.stash`; (c) `drainPendingGroup`'s
  return type change is `void`-consumed at the post-txn site, no behavioural effect there.
- Not touched: `verifySenderCert`, `verifySealedAad`, `parseGroupMessage`, the G-04/MEDIUM-2 rollback
  guards, epoch monotonicity, relay/server code, DB schema.

## Tests

Jest project `messenger-crypto` (`npm run test:crypto`). Follow the existing replica pattern —
`productionRuntime.ts` is never imported by tests; pure helpers + real stores/crypto are.

1. `src/modules/messenger/__tests__/groupConversationUpsert.test.ts` (extend; it already has the
   `resolveKeyRequestTargets` describe) — new `describe('selectKeyResyncCandidates (GF-3)')`:
   - keyless explicit group → `[gid]`; keyed explicit group, no flag → `[]` (pins today's contract);
   - **keyed explicit group with `divergence: true` → `[gid]`** (the regression that would re-kill the
     self-heal);
   - sweep with no `groupId` returns only `group`/`ops_channel` conversations that lack a key, and
     ignores `direct` rows;
   - `divergence: true` with no `groupId` does not widen the sweep beyond group-typed conversations.
2. `src/modules/messenger/__tests__/bootGroupStashDrain.test.ts` (extend) — new
   `describe('shouldBumpStashAttempt (GF-3)')`:
   - `{needsKey: true, keyChanged: false}` → `false` (boot drain never burns);
   - `{needsKey: true, keyChanged: true}` → `true` (a real key change still evicts genuine tamper);
   - `{needsKey: false, keyChanged: false}` → `true` (structurally broken row still evicted).
     Plus a store-level test over the REAL `PendingGroupEnvelopeStore` with the fuller mock DB from
     `pendingGroupEnvelopeStore.test.ts` (it handles `UPDATE … attempts` / `SELECT attempts`): stash one
     row, run the policy for 5 simulated boots → `attempts === 0` and the row still present; then one
     `keyChanged: true` pass → `attempts === 1`.
3. `src/modules/messenger/__tests__/tamperKeyDivergenceStash.test.ts` (extend) — the divergence
   round-trip using the real group crypto already set up there: wrong-key parse → `tamper` →
   the receive replica returns a request carrying `divergence: true`; assert
   `selectKeyResyncCandidates` selects the group even though `groups[gid].masterKeyB64` is set; then
   swap in the correct key and assert `parseGroupMessage` succeeds on the SAME stashed `sealed_json`
   (the heal completes rather than the row being deleted).
4. Regression suites to re-run: `npm run test:crypto` (whole `messenger-crypto` project — covers
   `groupSelfHeal.test.ts`, `groupRekeyConverge.test.ts`, `groupCreateEpochBootstrap.test.ts`,
   `pendingGroupEnvelopeStore.test.ts`, `bootGroupStashDrain.test.ts`), then `npm test`.
   `npm run typecheck` must stay ≤ 47 (`.tsc-baseline.json`).
5. Device smoke (state which you could not run): two devices in a group, force divergence by letting
   B miss a rekey (kill B during the rotation), then send from A → B shows "re-syncing", B emits one
   `key-request` (log `[group-key-request:runtime] requested key for …`), A reshares, B's stashed
   message renders. Then kill/relaunch B three times mid-divergence and confirm the row survives.

## Risk

- **The B5 boot-time divergence kick is the piece to scrutinise.** It is the only new _unsolicited_
  key-request source. It fires at most once per group per boot and is additionally gated by the 20 s
  cooldown, but a group with a permanently undecryptable row (genuine forgery from a member) will now
  emit one request per launch, forever, until the 30-day prune. If a reviewer is uncomfortable, drop
  B5 — A + B alone fully fix the finding (the receive path already re-triggers on the next inbound
  message); B5 only covers "the group went quiet after diverging".
- **Attempt semantics changed, not removed.** Verify against B4 that a _structural_ failure (JSON
  parse, `not a group envelope`, `malformed`) still burns attempts on every path, or a poison row
  becomes immortal within its cap.
- **Amplification.** Confirm `keyRequestSentAt.set(gid, now)` still runs before `sendKeyRequest` on the
  divergence path (it does — the removed `continue` was above the cooldown check, and the cooldown
  check is preserved verbatim). A hostile sender spraying junk group ciphertext can drive at most one
  fan-out per 20 s per group — the same ceiling the `no_key` path has had since it shipped.
- **No security gate is touched.** The tamper branch still never renders ciphertext; the responder side
  (`isGroupMember` gate at `:6865` + `reshareGroupKeyState` roster/owner/signature gates) is untouched,
  so this cannot become a way for a non-member to solicit a key. Epoch handling and the G-04/MEDIUM-2
  rollback guards are unmodified.
- **Longer stash residency** means group ciphertext for undecryptable rows sits on disk for up to
  30 days. It is SQLCipher-encrypted, capped, and matches the relay dwell that the file header already
  cites as the intended bound — but it is a (small) at-rest-footprint increase worth naming.
- Order-of-landing with GF-2 and GF-5 in the same functions; re-run the crypto suite after each merge,
  not just at the end.
