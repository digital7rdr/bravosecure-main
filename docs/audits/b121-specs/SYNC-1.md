# SYNC-1 - Group read ticks can never complete: author keeps only the first recipient's envelopeId

## Verdict

**CONFIRMED** (independently re-verified in the current tree; the audit's line numbers drift by
~10 lines but the mechanism is exact).

Evidence:

1. `src/modules/messenger/runtime/productionRuntime.ts:2688-2718` — the group fan-out tally keeps a
   single scalar and explicitly documents the gap:
   ```ts
   let firstEnvelopeId: string | undefined;
   ...
   //   recipient's id is enough for the tick to advance (readReceipt
   //   matches by group membership); full per-member info is a parity
   //   follow-up.
   if (!firstEnvelopeId && r.value.envelopeId) { firstEnvelopeId = r.value.envelopeId; }
   ...
   if (firstEnvelopeId) {
     useMessengerStore.getState().updateMessageEnvelopeId(conversationId, msgId, firstEnvelopeId);
   }
   ```
   The comment's claim ("readReceipt matches by group membership") is **false** — membership is only
   the _ownership_ predicate; the envelope-id gate runs first.
2. `src/modules/messenger/runtime/productionRuntime.ts:5181` — the receipt handler hard-gates on the
   scalar before the ownership check ever runs:
   ```ts
   if (!msg.envelope_id || !ids.has(msg.envelope_id)) {
     continue;
   }
   ```
3. `src/modules/messenger/store/messengerStore.ts:766-777` — B-116 requires **every** other
   participant:
   ```ts
   const required = isGroup ? (convo?.participants ?? []).filter(u => u && u !== ownUid) : null;
   ...
   const allRead = required ? required.every(u => m.receipts?.[u]?.status === 'read') : true;
   ```
   With ≥2 other members, at most 1 of `required` can ever be satisfied ⇒ `'read'` unreachable.
4. `src/modules/messenger/runtime/productionRuntime.ts:2650` — each fan-out leg genuinely mints a
   distinct id: `return {status: 'ok', userId, retractToken: r.retractToken, envelopeId: r.envelopeId};`
   (one `relay.send` per participant, so one relay-minted envelopeId per participant).
5. **Amplifier the audit missed** — `productionRuntime.ts:7495-7500` (outbox drain) calls
   `updateMessageEnvelopeId(row.conversationId, row.messageId, r.envelopeId)` with **no peer
   discrimination**, so a drained group row _overwrites_ the stored scalar with a later recipient's
   id. A group message with one deferred peer therefore ends up matching **that** peer's receipt and
   no longer matching `participants[0]`'s — the single acceptable receipt is not even stable.
6. **Second independent completion blocker (new, in-scope)** — `m.receipts` is **not persisted**.
   `src/modules/messenger/store/sqlMessageStore.ts:26-48` (`MessageRow`) and `:130-164` (`doUpsert`)
   have no receipts column, and `src/modules/messenger/crypto/db.ts:110-165` (messages DDL) has none
   either. Readers only emit a receipt once (`markRead` skips `msg.status === 'read'`), so if the
   author restarts before collecting all N-1 receipts, the accumulated set is lost forever and the
   tick is permanently stuck at `delivered` even after the envelope-id fix.

## Mechanism

1. Author sends to a group of 3 (`me`, `bob`, `carol`). `sendText` group path builds one shared
   `sealedBody`, then `participants.map(sendOne)` does a **separate** `relay.send` per peer
   (`productionRuntime.ts:2637-2650`). The relay mints an independent `envelopeId` per submit:
   `env-bob`, `env-carol`.
2. The tally loop keeps `firstEnvelopeId = env-bob` and calls `updateMessageEnvelopeId`, so the
   author's row has `envelope_id = 'env-bob'` and nothing about `env-carol`.
3. Bob opens the chat → `markRead` collects **his** inbound row's `envelope_id` (`env-bob`) and emits
   `read-receipt {to: author, envelopeIds: ['env-bob']}`.
4. Author's handler: `ids = {'env-bob'}` → matches → `readReceiptAccepted` passes (bob ∈ participants)
   → `recordReadReceipts(..., 'bob')`. `m.receipts.bob = read`, but `required = ['bob','carol']`, so
   `allRead === false` ⇒ status stays `delivered`.
5. Carol opens the chat → emits `read-receipt {envelopeIds: ['env-carol']}`.
6. Author's handler: `ids = {'env-carol'}`, `msg.envelope_id === 'env-bob'` → `!ids.has(...)` →
   `continue`. Carol's receipt is **silently discarded**. `m.receipts.carol` is never written.
7. `allRead` can never become true. The bubble is pinned at single/double-tick forever for any group
   with ≥ 3 members (i.e. every real group — a 2-person "group" accidentally works because
   `required.length === 1`).
8. If any peer's live send failed and later drained, step 2's scalar is _replaced_ by that peer's id
   (evidence 5), so the one receipt that used to land stops landing.
9. Even in the degenerate 2-member group that works today, an app restart between the send and the
   receipt drops `m.receipts` (evidence 6), so a late receipt re-flips nothing (`recordReadReceipts`
   re-stamps and re-derives, so 2-member recovers; a 3-member never can because receipts arrive
   across restarts).

## Fix

Persist the **full recipient → envelopeId map** on the author's row and match receipts against the
entry minted for _that_ receipter. This is client-local: **zero wire change, zero server change, no
back-compat concern with older peers or older servers.**

> Note on the audit's alternative ("match receipts by `clientMsgId`"): reject it. It requires adding
> `clientMsgId` to the `read-receipt` WS frame, which hands the relay a correlator linking N
> different readers to one message — a group-membership signal on a lane that today carries only
> opaque per-recipient ids. That collides with the batch-endpoint constraint already ruled on for
> this batch ("the relay sees N unrelated ciphertexts" / "zero group awareness") and would need an
> architecture amendment. The local-map approach needs neither.

### F1. `src/modules/messenger/store/types.ts` — new optional field

Anchor (verbatim, in `interface LocalMessage`):

```ts
  /**
   * B-116 — per-member receipt attribution for OWN messages (WhatsApp
   * "Message info"): userId → {status, ts}. Populated from read-receipt
```

Insert **immediately before** that block:

```ts
  /**
   * SYNC-1 — recipient userId → the relay envelope id minted for THAT
   * recipient's copy. Group fan-out submits one envelope per member, so
   * the scalar `envelope_id` can only ever match participants[0]'s
   * receipt and B-116's "every participant has read" aggregate is
   * unreachable. Absent on 1:1 rows (the scalar is sufficient there).
   */
  envelope_ids?: Record<string, string>;
```

### F2. `src/modules/messenger/store/messengerStore.ts` — widen the existing setter

Reuse `updateMessageEnvelopeId` rather than adding a new action (project rule: reuse before
abstracting). Optional 4th arg = the recipient the id belongs to.

Anchor (interface, `:213-215`):

```ts
  /** Backfill the relay's envelope id on an outbound message after accept. */
  updateMessageEnvelopeId: (conversationId: string, messageId: string, envelopeId: string) => void;
```

Replacement:

```ts
  /**
   * Backfill the relay's envelope id on an outbound message after accept.
   * SYNC-1 — pass `recipientUserId` for group fan-out legs: the id is
   * recorded in the per-recipient map (so every member's read receipt can
   * be matched) and the scalar is only seeded, never overwritten.
   */
  updateMessageEnvelopeId: (
    conversationId: string,
    messageId: string,
    envelopeId: string,
    recipientUserId?: string,
  ) => void;
```

Anchor (implementation, `:795-800`):

```ts
    updateMessageEnvelopeId: (conversationId, messageId, envelopeId) =>
      set(s => {
        const msg = s.messages[conversationId]?.find(m => m.id === messageId);
        if (msg) {msg.envelope_id = envelopeId;}
        notifyBackupDirty(messageId);
      }),
```

Replacement:

```ts
    updateMessageEnvelopeId: (conversationId, messageId, envelopeId, recipientUserId) =>
      set(s => {
        const msg = s.messages[conversationId]?.find(m => m.id === messageId);
        if (!msg) {return;}
        if (recipientUserId) {
          if (!msg.envelope_ids) {msg.envelope_ids = {};}
          msg.envelope_ids[recipientUserId] = envelopeId;
          // Why: a later fan-out leg (or an outbox drain) must not clobber
          // the scalar the first leg seeded — SYNC-1.
          if (!msg.envelope_id) {msg.envelope_id = envelopeId;}
        } else {
          msg.envelope_id = envelopeId;
        }
        notifyBackupDirty(messageId);
      }),
```

### F3. `src/modules/messenger/runtime/messagingLogic.ts` — pure matcher (append at end of file)

Lives here (not in `productionRuntime.ts`) so it is testable under the `messenger-crypto` Jest
project, following the `envelopeDelivered.ts` / `readReceiptAccepted` precedent. Append after
`readReceiptAccepted`:

```ts
/**
 * SYNC-1 — does a read-receipt from `receipterUid` reference THIS
 * message? Group fan-out mints one relay envelope id per recipient, so
 * the author must match against the id minted for that specific member.
 *
 * Strict when the per-recipient map exists: a member may only receipt the
 * envelope addressed to them (a tightening of the P0-E1 ownership guard,
 * never a relaxation). Rows written before the map existed, and every 1:1
 * row, fall back to the scalar so in-flight messages keep ticking.
 */
export function readReceiptEnvelopeMatch(args: {
  envelopeId?: string;
  envelopeIds?: Record<string, string>;
  receipterUid: string;
  ids: ReadonlySet<string>;
}): boolean {
  const {envelopeId, envelopeIds, receipterUid, ids} = args;
  const forReceipter = envelopeIds?.[receipterUid];
  if (forReceipter) {
    return ids.has(forReceipter);
  }
  if (envelopeIds && Object.keys(envelopeIds).length > 0) {
    return false;
  }
  return !!envelopeId && ids.has(envelopeId);
}
```

### F4. `src/modules/messenger/runtime/productionRuntime.ts` — fan-out records every id

Anchor (`:2687-2718`):

```ts
        const results = await Promise.allSettled(participants.map(sendOne));
        let delivered = 0;
        const failures: string[] = [];
        let firstRetractToken: string | undefined;
        let firstEnvelopeId: string | undefined;
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          if (r.status === 'fulfilled') {
            delivered += 1;
            if (!firstRetractToken && r.value.retractToken) {
              firstRetractToken = r.value.retractToken;
            }
```

…through…

```ts
            if (!firstEnvelopeId && r.value.envelopeId) {
              firstEnvelopeId = r.value.envelopeId;
            }
          } else {
            failures.push(`${participants[i]}: ${asErrorMessage(r.reason)}`);
          }
        }
        if (firstRetractToken) {
          useMessengerStore.getState().updateMessageRetractToken(conversationId, msgId, firstRetractToken);
        }
        if (firstEnvelopeId) {
          useMessengerStore.getState().updateMessageEnvelopeId(conversationId, msgId, firstEnvelopeId);
        }
```

Replacement for the whole span (keep `firstRetractToken` untouched; the retract token is
per-envelope and only the sender's own single-capability use is wired today):

```ts
const results = await Promise.allSettled(participants.map(sendOne));
let delivered = 0;
const failures: string[] = [];
let firstRetractToken: string | undefined;
// SYNC-1 — one relay envelopeId per recipient. Keeping only the
// first made every OTHER member's read receipt unmatchable, so the
// B-116 "all participants read" aggregate could never complete.
const envelopeIdByRecipient: Array<[string, string]> = [];
for (let i = 0; i < results.length; i++) {
  const r = results[i];
  if (r.status === 'fulfilled') {
    delivered += 1;
    if (!firstRetractToken && r.value.retractToken) {
      firstRetractToken = r.value.retractToken;
    }
    if (r.value.envelopeId) {
      envelopeIdByRecipient.push([r.value.userId, r.value.envelopeId]);
    }
  } else {
    failures.push(`${participants[i]}: ${asErrorMessage(r.reason)}`);
  }
}
if (firstRetractToken) {
  useMessengerStore.getState().updateMessageRetractToken(conversationId, msgId, firstRetractToken);
}
for (const [recipientUserId, envelopeId] of envelopeIdByRecipient) {
  useMessengerStore
    .getState()
    .updateMessageEnvelopeId(conversationId, msgId, envelopeId, recipientUserId);
}
```

(`sendOne` already returns `userId` — `productionRuntime.ts:2650`: `return {status: 'ok', userId,
retractToken: r.retractToken, envelopeId: r.envelopeId};` — so no change is needed there.)

### F5. `src/modules/messenger/runtime/productionRuntime.ts` — receipt handler uses the matcher

Anchor (`:5176-5195`):

```ts
      const {readReceiptAccepted} =
        require('./messagingLogic') as typeof import('./messagingLogic');
      for (const [conversationId, list] of Object.entries(store.messages)) {
        // M-14 — batch all flips for this conversation into one commit.
        const flipIds: string[] = [];
        for (const msg of list) {
          if (!msg.envelope_id || !ids.has(msg.envelope_id)) {continue;}
          if (msg.status === 'read') {continue;}
          if (msg.sender_id !== 'self') {continue;}
```

Replacement:

```ts
      const {readReceiptAccepted, readReceiptEnvelopeMatch} =
        require('./messagingLogic') as typeof import('./messagingLogic');
      for (const [conversationId, list] of Object.entries(store.messages)) {
        // M-14 — batch all flips for this conversation into one commit.
        const flipIds: string[] = [];
        for (const msg of list) {
          if (!readReceiptEnvelopeMatch({
            envelopeId:   msg.envelope_id,
            envelopeIds:  msg.envelope_ids,
            receipterUid,
            ids,
          })) {continue;}
          if (msg.status === 'read') {continue;}
          if (msg.sender_id !== 'self') {continue;}
```

The `readReceiptAccepted` ownership call below stays **exactly** as-is (P0-E1 / BS-RR1 unchanged).

### F6. `src/modules/messenger/runtime/productionRuntime.ts` — outbox drain attributes its id

Anchor (`:7492-7500`):

```ts
// Audit MSG-03 — record the envelopeId so delivered/read ticks fire
// for outbox-drained (reconnect) sends too.
if (r.envelopeId) {
  useMessengerStore
    .getState()
    .updateMessageEnvelopeId(row.conversationId, row.messageId, r.envelopeId);
}
```

Replacement (the group outbox payload carries `groupId` — see the enqueue at
`productionRuntime.ts:2620` `groupId: conversationId`; 1:1 payloads are `{outerSealed, expiresAtSec}`
with no `groupId`, so this discriminates without a schema change):

```ts
// Audit MSG-03 — record the envelopeId so delivered/read ticks fire
// for outbox-drained (reconnect) sends too. SYNC-1 — a GROUP row is
// one leg of a fan-out: attribute the id to its recipient instead of
// overwriting the scalar another leg already seeded.
if (r.envelopeId) {
  useMessengerStore
    .getState()
    .updateMessageEnvelopeId(
      row.conversationId,
      row.messageId,
      r.envelopeId,
      payload.groupId ? row.peerUserId : undefined,
    );
}
```

`payload` is already typed `{outerSealed?, expiresAtSec?, certExpSec?} & Partial<DeferredOutboxPayload>`
(`:7407`); confirm `DeferredOutboxPayload` declares `groupId?: string` — if it does not, widen the
local `payload` type annotation with `groupId?: string` rather than editing the shared type.

### F7. `src/modules/messenger/runtime/envelopeDelivered.ts` — same-class one-liner

Anchor:

```ts
  for (const [conversationId, list] of Object.entries(store.messages)) {
    for (const msg of list) {
      if (msg.envelope_id !== envelopeId) {continue;}
```

Replacement:

```ts
  for (const [conversationId, list] of Object.entries(store.messages)) {
    for (const msg of list) {
      // SYNC-1 — group rows carry one envelope id per recipient; a
      // delivered from ANY of them advances the bubble.
      const isMatch = msg.envelope_id === envelopeId ||
        Object.values(msg.envelope_ids ?? {}).includes(envelopeId);
      if (!isMatch) {continue;}
```

(No behavioural change today because SYNC-3 means HTTP-submitted envelopes never get an
`envelope.delivered` frame; include it so SYNC-3 does not have to re-open this file.)

### F8. Persistence — schema v15 (`envelope_ids_json` + `receipts_json`)

`receipts_json` is required for the fix to actually be observable: without it the accumulated
`m.receipts` map is lost on every restart and a 3+ member group still never reaches `read`
(evidence 6).

**`src/modules/messenger/crypto/db.ts`**

Anchor: `const SCHEMA_VERSION = 14;` → `const SCHEMA_VERSION = 15;`

Anchor (messages DDL):

```ts
     reactions_json   TEXT,
```

Replacement:

```ts
     reactions_json   TEXT,
     /**
      * SYNC-1 (schema v15). `envelope_ids_json`: JSON {recipientUserId ->
      * relay envelopeId} for group fan-out rows, so every member's read
      * receipt can be matched (a single scalar only ever matched the first
      * recipient). `receipts_json`: the B-116 per-member receipt map, which
      * was in-memory only — a restart wiped partial progress and the
      * "all participants read" aggregate could never complete because
      * readers emit a receipt exactly once.
      */
     envelope_ids_json TEXT,
     receipts_json     TEXT,
```

Anchor (idempotent ALTER, just below the DDL block):

```ts
  // Idempotent ALTER for installs predating schema v13.
  'ALTER TABLE messages ADD COLUMN media_meta_json TEXT',
```

Replacement:

```ts
  // Idempotent ALTER for installs predating schema v13.
  'ALTER TABLE messages ADD COLUMN media_meta_json TEXT',
  // Idempotent ALTER for installs predating schema v15 (SYNC-1).
  'ALTER TABLE messages ADD COLUMN envelope_ids_json TEXT',
  'ALTER TABLE messages ADD COLUMN receipts_json TEXT',
```

> Verify the DDL executor tolerates the "duplicate column" error the way the v13 line already
> relies on. If the v13 `ALTER` is only tolerated because of a surrounding try/catch, mirror that
> exact handling; do not introduce a new swallow-all.

Anchor (`runMigrations`, after the `fromVersion < 14` branch):

```ts
  if (fromVersion < 14) {
```

Add a new branch after that block closes:

```ts
if (fromVersion < 15) {
  // SYNC-1 — per-recipient envelope ids + durable B-116 receipt map.
  // Existing rows get NULL: they fall back to the scalar envelope_id
  // (unchanged behaviour) until the next send populates the map.
  for (const col of ['envelope_ids_json', 'receipts_json']) {
    try {
      await db.execute(`ALTER TABLE messages ADD COLUMN ${col} TEXT`);
    } catch (e) {
      const msg = (e as Error).message ?? '';
      if (!/duplicate column|already exists/i.test(msg)) {
        throw e;
      }
    }
  }
}
```

**`src/modules/messenger/store/sqlMessageStore.ts`**

Anchor (`MessageRow`):

```ts
  reactions_json:   string | null;
  call_meta_json:   string | null;
  media_meta_json:  string | null;
}
```

Replacement:

```ts
  reactions_json:   string | null;
  call_meta_json:   string | null;
  media_meta_json:  string | null;
  envelope_ids_json: string | null;
  receipts_json:     string | null;
}
```

Anchor (`doUpsert` head):

```ts
  private async doUpsert(msg: LocalMessage): Promise<void> {
    const reactions = msg.reactions ? JSON.stringify(msg.reactions) : null;
    const callMeta  = msg.call_meta ? JSON.stringify(msg.call_meta) : null;
    const mediaMeta = msg.media_meta ? JSON.stringify(msg.media_meta) : null;
```

Replacement:

```ts
  private async doUpsert(msg: LocalMessage): Promise<void> {
    const reactions = msg.reactions ? JSON.stringify(msg.reactions) : null;
    const callMeta  = msg.call_meta ? JSON.stringify(msg.call_meta) : null;
    const mediaMeta = msg.media_meta ? JSON.stringify(msg.media_meta) : null;
    const envIds    = msg.envelope_ids ? JSON.stringify(msg.envelope_ids) : null;
    const receipts  = msg.receipts ? JSON.stringify(msg.receipts) : null;
```

Anchor (column list + placeholders):

```ts
         expires_at, reply_to_msg_id, reply_to_preview, reactions_json, call_meta_json,
         media_meta_json
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
```

Replacement (note: **24** placeholders now):

```ts
         expires_at, reply_to_msg_id, reply_to_preview, reactions_json, call_meta_json,
         media_meta_json, envelope_ids_json, receipts_json
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
```

Anchor (bind array tail):

```ts
        reactions,
        callMeta,
        mediaMeta,
      ],
```

Replacement:

```ts
        reactions,
        callMeta,
        mediaMeta,
        envIds,
        receipts,
      ],
```

Anchor (`rowToMessage` tail):

```ts
    media_meta:       r.media_meta_json ? safeJsonMediaMeta(r.media_meta_json) : undefined,
  };
}
```

Replacement:

```ts
    media_meta:       r.media_meta_json ? safeJsonMediaMeta(r.media_meta_json) : undefined,
    envelope_ids:     r.envelope_ids_json ? safeJsonStringMap(r.envelope_ids_json) : undefined,
    receipts:         r.receipts_json ? safeJsonReceipts(r.receipts_json) : undefined,
  };
}
```

Add the two parsers next to the existing `safeJson` helpers (mirroring their shape exactly):

```ts
function safeJsonStringMap(s: string): Record<string, string> | undefined {
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, string>) : undefined;
  } catch {
    return undefined;
  }
}

function safeJsonReceipts(s: string): LocalMessage['receipts'] {
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === 'object' ? (v as LocalMessage['receipts']) : undefined;
  } catch {
    return undefined;
  }
}
```

`SELECT *` is used by every read path (`sqlMessageStore.ts:189, 224, 262, 288, 314`), so no query
edits are needed.

### F9. Backup mirror — deliberately UNCHANGED

Do **not** add `envelope_ids` / `receipts` to `src/modules/messenger/backup/backupWireV3.ts`
(`serializeMessagePayload`) or to `messageMirror.ts` (`serializeMessage`, `:763-790`). Rationale:
`versionHash` (`messageMirror.ts:434`) hashes `serializeMessage(msg)`, so touching that function
changes the version hash of **every** existing message and forces a full re-mirror on the next boot —
exactly the drift factory BACKUP_LOOP.md invariant I1 ("idle boots upload nothing") exists to
prevent. Tick metadata is device-local and already non-restorable (`receipts` has never been
mirrored). This keeps SYNC-1 entirely outside the backup blast radius.

### Wire / compatibility

No wire field added or changed. Client-only. Works against the currently deployed
`messenger-service`, and against peers on any older client build (their `read-receipt` frames are
byte-identical today and after the fix).

## Blast radius

**Files edited (7):**

- `src/modules/messenger/store/types.ts` — `LocalMessage.envelope_ids` (additive optional).
- `src/modules/messenger/store/messengerStore.ts` — `updateMessageEnvelopeId` signature + body.
- `src/modules/messenger/runtime/messagingLogic.ts` — new pure `readReceiptEnvelopeMatch`.
- `src/modules/messenger/runtime/productionRuntime.ts` — 3 spots: group fan-out tally (~2687),
  `read-receipt` frame case (~5176), outbox drain (~7492).
- `src/modules/messenger/runtime/envelopeDelivered.ts` — match helper.
- `src/modules/messenger/crypto/db.ts` — SCHEMA_VERSION 14→15, DDL, ALTERs, migration branch.
- `src/modules/messenger/store/sqlMessageStore.ts` — row type, upsert, rowToMessage, 2 parsers.

**Callers of the widened setter** (all 5 remain source-compatible — the new arg is optional):
`productionRuntime.ts:872` (undeliverable-resend, 1:1), `:2717` (group fan-out — **changed**),
`:2903` (1:1 HTTP fallback), `:5334` (`handleAccepted`, WS 1:1), `:7496` (outbox drain —
**changed**).

**Other readers of `envelope_id`** (unaffected — the scalar keeps its existing meaning):
`messengerStore.ts:461/464/547/607` (append/merge dedup), `productionRuntime.ts:4514` (`markRead`,
inbound rows only), `decryptFailureSignal.ts`, `undeliverableResend.ts`,
`backup/{backupWireV3,messageMirror,mirrorBootstrap,restoreMessages}.ts`.

**Persistence:** the Zustand→SQLCipher write-through subscriber (`productionRuntime.ts:1768-1820`)
diffs by object identity (`before !== m`), and immer produces a new object on the map mutation, so
the new field flows to `upsertCoalesced` automatically once the column exists.

**Overlapping findings:**

- **SYNC-3** (delivered receipts dead on HTTP lanes) edits `envelope.controller.ts` /
  `envelope.service.ts` / `messenger.gateway.ts` and would land on `envelopeDelivered.ts`. F7 is the
  client half; sequence SYNC-1 first or have SYNC-3 own F7.
- **GF-2 / SYNC-2** (durable group fan-out) rewrites the same `Promise.allSettled(participants.map(
sendOne))` tally block in `productionRuntime.ts`. **High textual conflict** — land SYNC-1 first
  (it is small and client-local) and rebase GF-2 onto it.
- Any finding that bumps `SCHEMA_VERSION` in `crypto/db.ts` conflicts on the constant + the
  `runMigrations` tail. Only one may claim v15.

**What could regress:**

- The 1:1 path if `recipientUserId` is ever passed on a non-group send — the scalar would stop being
  overwritten by the undeliverable-resend path (`:872`), which legitimately mints a _new_ envelope id
  for the same bubble. F6 gates on `payload.groupId`, and F4 is inside the group branch; do not widen.
- A `doUpsert` placeholder-count mismatch silently shifts every bound value. Count them.
- SQLCipher migration on a large messages table: two `ALTER TABLE ADD COLUMN` are O(1) metadata ops in
  SQLite, so no rewrite.

## Tests

Jest project: **`messenger-crypto`** (`npm run test:crypto`) — `testMatch` covers
`src/modules/messenger/__tests__/**/*.test.ts`.

1. **`src/modules/messenger/__tests__/messagingLogic.test.ts`** (existing; extend). Import
   `readReceiptEnvelopeMatch` alongside `readReceiptAccepted` and add
   `describe('readReceiptEnvelopeMatch (SYNC-1)')`:
   - map present, receipter's own id in `ids` → `true`.
   - map present, receipter's own id **not** in `ids` but _another member's_ id is → `false`
     (strictness / no cross-member confusion).
   - map present but receipter absent from it (joined after send) → `false`.
   - map absent, scalar in `ids` → `true` (legacy row / 1:1 back-compat).
   - map absent, no scalar → `false`.

2. **`src/modules/messenger/__tests__/groupReadReceipts.test.ts`** (existing; extend). The current
   helper `ownMsg(id, envelopeId)` sets only `envelope_id`. Add a sibling
   `ownGroupMsg(id, envelopeIds: Record<string,string>)` and a new case:
   - seed `envelope_ids: {bob: 'env-bob', carol: 'env-carol'}`; assert `recordReadReceipts` for bob
     then carol yields `status === 'read'` and both `receipts` entries — i.e. the B-116 aggregate is
     reachable (this is the regression that pins the finding).
   - assert `updateMessageEnvelopeId(cid, id, 'env-carol', 'carol')` does **not** overwrite an
     already-seeded `envelope_id` and **does** add the map entry.
   - assert `updateMessageEnvelopeId(cid, id, 'env-new')` (no recipient) still overwrites the scalar
     (1:1 undeliverable-resend behaviour preserved).

3. **New: `src/modules/messenger/__tests__/groupReceiptEnvelopeSet.test.ts`** — end-to-end-ish over
   the two pure units + the store, mirroring the mechanism above:
   - build a 3-member group row with a 2-entry `envelope_ids` map;
   - drive `readReceiptEnvelopeMatch` with `ids = {'env-carol'}, receipterUid = 'carol'` → true;
   - feed the resulting flip through `recordReadReceipts` for bob then carol;
   - assert final `status === 'read'`. Add the inverse assertion against a row carrying only the
     legacy scalar `'env-bob'` → carol's receipt does not match (documents the pre-fix behaviour).

4. **`src/modules/messenger/__tests__/envelopeDelivered.test.ts`** (existing; extend). Add: a row with
   `envelope_ids: {bob:'env-bob', carol:'env-carol'}` and `status: 'sent'` flips to `'delivered'` on
   `applyEnvelopeDelivered('env-carol')`; and the existing `read` / `sending` guards still hold.

5. **Persistence.** Look for an existing `sqlMessageStore` round-trip test
   (`src/modules/messenger/__tests__/sqlMessageStoreResend.test.ts` is the nearest neighbour and shows
   the DbHandle-mocking pattern). Add a case asserting `doUpsert` binds 24 values and that a row with
   `envelope_ids_json` / `receipts_json` round-trips through `rowToMessage` (including malformed JSON
   → `undefined`, matching the `safeJson` convention). If that file's harness cannot execute SQL, at
   minimum unit-test `safeJsonStringMap` / `safeJsonReceipts` and assert the placeholder count in the
   SQL string.

**Regression suites:** `npm run test:crypto` (mandatory — receipts/ticks live in it), then
`npm test`. `npm run typecheck` must stay ≤ 47 (`.tsc-baseline.json`); the change is additive optional
fields, so it should not move.

**Device probe (cannot be covered by Jest):** 3-device group (per `sqa.md` Device & Identity
Reference) — author sends, device B reads (expect no blue tick), device C reads (expect blue tick);
then repeat with the author force-killed between B and C to prove `receipts_json` persistence.
Also run the BACKUP_LOOP.md idle-boot silence probe once, to confirm the schema bump did not make the
mirror re-upload history.

## Risk

- **The "smallest fix" temptation is wrong.** Only changing the receipt matcher without F8's
  `receipts_json` leaves the finding half-fixed: the tick still cannot complete across an app
  restart, which is the common case for a group conversation. A reviewer should push back on any
  version of this that skips persistence.
- **Strictness change.** `readReceiptEnvelopeMatch` returns `false` when the map exists but lacks the
  receipter. That is a _tightening_ of P0-E1 (a member can only receipt the envelope minted for them),
  which is the correct direction, but it means a member who joins a group **after** a message was sent
  can never receipt it — and `recordReadReceipts` still derives `required` from the **live**
  participant list (`messengerStore.ts:766-770`), so such a message stays stuck at `delivered`.
  **This spec deliberately does NOT change `required`**: narrowing it to the actual recipient set
  would blue-tick a message that only reached 1 of 3 peers (a worse lie). The
  joined-after-send residual is pre-existing, out of SYNC-1's scope, and should be filed separately
  (proposal: snapshot the recipient set at send time and intersect with live participants, gated on
  "no outbox rows remain for this clientMsgId").
- **Partial-delivery honesty.** After the fix, a group message whose fan-out only reached 2 of 3 peers
  still requires all 3 receipts, so it correctly never blue-ticks until the outbox drain delivers the
  third — and F6 makes that drain register the third id. Verify F6's `payload.groupId` discriminator
  actually exists on group rows (`productionRuntime.ts:2620` and `:2585`) before merging; if a group
  enqueue path is missing `groupId`, that drain leg silently reverts to scalar-overwrite.
- **Placeholder drift** in `doUpsert` — 22 → 24 `?`. A miscount corrupts every message write and will
  not be caught by typecheck.
- **Schema-version collision** with any other v15 claimant in this batch.
- **No security surface is touched**: no change to `verifySenderCert`, `verifySealedAad`, AAD binding,
  envelope shape, retract tokens, dwell, group master key, or the vault MFA gate. The ownership guard
  `readReceiptAccepted` is called unchanged and still runs after the envelope match. Nothing new is
  logged (envelope ids are already logged in truncated form elsewhere; add no new log lines — the
  `logAudit.test.ts` gate applies).
