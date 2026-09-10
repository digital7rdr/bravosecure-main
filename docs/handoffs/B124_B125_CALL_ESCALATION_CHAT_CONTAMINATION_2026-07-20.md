# B-124 / B-125 — Call escalation contaminates the 1:1 thread

**Date:** 2026-07-20
**Reporter:** tester (device QA)
**Device:** Redmi Note 11 (`veux_global` / 2201116SG), ADB `043dd12e3dad`
**Build under test:** `com.bravosecure.app` **v1.0.118 (versionCode 146)**, installed 2026-07-20 19:38
**Branch analysed:** `fix/b121-b123-ios-group-video` (`cea64f8`)
**Status:** ROOT-CAUSED (code-confirmed) · device log confirmation OUTSTANDING · **no code changed**

---

## 0. TL;DR

Both reported problems are **one bug with two faces**.

Escalating a 1:1 call to a group call files a throwaway `'Call'` group key **under the
real 1:1 conversation's id**. From that moment the 1:1 chat is permanently
misclassified as a group, because the send path decides "is this a group?" by asking
"do I hold group key material at this id?" — a **crypto** question being used to answer
a **conversation-type** question.

The single deciding line:

```ts
// src/modules/messenger/runtime/productionRuntime.ts:2351-2356
const isGroup =
  opts.isGroup === true ||
  convo?.type === 'group' ||
  convo?.type === 'ops_channel' ||
  !!groupState || // ← THE SEAM
  (convo?.type !== 'direct' && (convo?.participants?.length ?? 0) > 1);
```

Note the asymmetry: the last clause is carefully guarded with `convo?.type !== 'direct'`.
**`!!groupState` is not.** A `type: 'direct'` row with a stray `'Call'` key is therefore
routed as a group forever.

|           | Symptom                                                             | Where it breaks                                                |
| --------- | ------------------------------------------------------------------- | -------------------------------------------------------------- |
| **B-124** | Duplicate / unwanted chat thread after escalation                   | misclassification on the **wire** (`:2473`, `:2539` → `:6586`) |
| **B-125** | Send fails, typed text vanishes, `group has no other participants…` | misclassification on the **membership read** (`:2394-2397`)    |

The two are linked: **B-124 creates the row that B-125 fails on.**

---

## 1. What the tester reported

1. In a 1:1 audio/video call with **piyaldeb**, invited a third person → call became a group
   call (only tester + piyaldeb actually present).
   - "the same chat duplicated because of the group call"
   - a group chat thread appeared that should not exist — _"if we do these there will be so
     many unnecessary group chat"_
2. In the piyaldeb chat, sending a message shows
   `group has no other participants — conversation may not be synced from /conversations/mine yet`
   and **the typed message disappears**. First seen after opening the chat from a
   **notification tap**; opening the app normally (after clearing recents) worked.
3. **Update mid-session:** the error now appears on a **normal open** too.
   → This is the decisive clue. It rules out a sync _race_ and proves **persistent state
   corruption**. See §4.3.

---

## 2. WHERE — the causal chain, cited

### 2.1 Escalation reuses the 1:1 conversation id (the seed)

```ts
// src/screens/messenger/CallScreen.tsx:1616
const groupConvoId = conversationId; // keep the bubble on the same chat
// :1627-1633 → navigation.replace('GroupCallScreen', {conversationId: groupConvoId, …})
```

The comment directly above (`:1610-1615`) claims a _synthetic_ id is used "so the SFU room
key doesn't collide with the underlying 1:1 conversation" — **the code does the opposite**.
That stale comment is itself a defect; it hides the bug from review.

`useGroupCall.ts:1543` passes that id to `ensureCallGroupKey`.

### 2.2 The ad-hoc key is minted and aliased onto chat-bearing ids

```ts
// src/modules/messenger/runtime/productionRuntime.ts:4408-4414
const state = makeNewGroup({name: 'Call', owner: ownAddress.userId, …});
```

Three filings, all `setGroupState` (key material only — correctly, **no** conversation row):

| Line         | Slot                                    | Note                                                                     |
| ------------ | --------------------------------------- | ------------------------------------------------------------------------ |
| `:4433`      | the minted 32-hex group id              | harmless                                                                 |
| `:4434`      | `direct:<own userId>`                   | **a slot that can never be a real chat — you have no 1:1 with yourself** |
| `:4442-4443` | **the originating 1:1 conversation id** | added by **B-106** (`b034b36`, 2026-07-18)                               |
| `:7017-7022` | receiver twin: `direct:<owner>`         | same class, on the peer's device                                         |

`:4442-4443` is guarded to direct-shaped slots only — which is precisely the problem: it
targets _exactly_ the ids that are real 1:1 chats.

### 2.3 The ghost-chat guards are real, but device-local

The `'Call'` ghost suppression **does work on the mint side** — this is _not_ a regression of
B-04/B-106:

- `productionRuntime.ts:7041` — `if (action.state.name !== 'Call') { upsert… }`
- `groupConversationUpsert.ts:73` — `if (store.groups[groupId]?.name === 'Call') {return;}`

But every guard reads `store.groups[<id>]?.name` — a **device-local** lookup — while the id it
guards (`group.groupId`) travels **across devices**. Once B-106 made those ids
device-_relative_, the sentinel dereferences a slot that doesn't exist on the receiving
device, reads `undefined !== 'Call'`, and falls through. **100% effective on the mint side,
0% effective on the wire side.**

### 2.4 Wire stamping and receiver routing

```ts
// productionRuntime.ts:2539
group: {groupId: conversationId, kind: 'text', clientMsgId, …}
// productionRuntime.ts:6585-6586 (receiver)
if (unwrapped.group?.groupId) { conversationId = unwrapped.group.groupId; }
```

The receiver routes **unconditionally** by the sender's device-local id.

---

## 3. B-124 — the duplicate / unwanted chat

### 3.1 The unwanted GROUP thread

When the stamped id names a slot the receiver has no row for, group decode fails `no_key`
(the receiver's `'Call'` key lives under `direct:<host>` / the minted id, never under the
sender's 1:1 id — `:6626-6628`). The stash branch then materialises a row:

`productionRuntime.ts:6766` → `groupConversationUpsert.ts:74-84`
→ `type:'group', name:'Group', participants:[peer.userId]`

A **group-typed junk thread carrying the 1:1's traffic**. Every escalation can add one.

### 3.2 The duplicated 1:1 — why it looks like the same chat twice

The mirror case, on the device that _does_ hold the key. The peer stamps
`group.groupId = 'direct:<hostUserId>'`; on the **host's** device that string names
**himself**. The host holds a key there (the `:4434` alias), so it decrypts and appends —
and `appendMessage` shadow-creates a conversation:

```ts
// src/modules/messenger/store/messengerStore.ts:582,592,637-649
if (!convo && conversationId.startsWith('direct:') && msg.peer && msg.sender_id !== 'self') {
  const peerId = conversationId.slice('direct:'.length);   // ← the HOST'S OWN userId
  convo = { type:'direct', name:`Bravo · ${shortId}`, participants:[peerId], peer: msg.peer, … };
```

The dedupe at `:594-599` looks for a direct row whose `peer.userId === peerId` — but `peerId`
is the host's _own_ id, so nothing matches and a **second row is minted**. Its `peer` field is
piyaldeb, so the home-list name resolution (`MessengerHomeScreen.tsx:113-116`, `:344`)
relabels the `Bravo · <hex>` placeholder with **piyaldeb's name**.

**Result: two rows, both titled "piyaldeb"** — one real, one holding the post-escalation
traffic. That is exactly _"the same chat duplicated because of the group call."_

### 3.3 Why it never goes away

- `messengerStore.ts:1322` — the ghost prune skips rows whose `type !== 'group'`; this ghost is `direct`.
- `MessengerHomeScreen.tsx:218-223` — the server-reconciliation prune only deletes **dashed-UUID** ids. `direct:<uuid>` and 32-hex ids never match.
- The ad-hoc group is **never registered server-side** (`ensureCallGroupKey` calls no `registerGroup`), so `/conversations/mine` can never reconcile it away.

---

## 4. B-125 — send fails and the message vanishes

### 4.1 The throw

```ts
// productionRuntime.ts:2394-2397
const convoMemberIds = convo?.participants ?? []; // ['<own userId>']
const participants = convoMemberIds.filter(uid => uid && uid !== ownAddress.userId); // → []
if (participants.length === 0) {
  throw new Error(
    'group has no other participants — conversation may not be synced from /conversations/mine yet',
  );
}
```

The ghost row's **only participant is the sender himself** (`messengerStore.ts:642`
writes `participants: [peerId]`, and here `peerId` _is_ the own id), so the self-filter
empties it.

**The error message is actively misleading.** It blames `/conversations/mine`, but this row
is client-minted and has no server counterpart — **no amount of syncing will ever repair it.**

### 4.2 Why the typed text disappears with no retry chip

1. `ChatScreen.tsx:650` snapshots `trimmed`; `:652` `setText('')`; `:657` `inputRef.current?.clear()` — the composer is destroyed **before** the await at `:676`.
2. The throw at `:2397` is **~50 lines above** the optimistic bubble append at `:2423-2447`. Nothing between `:2295` and `:2397` writes to the store, SQL, or the outbox.
3. The comment at `:2415-2417` states the append is deliberately hoisted _"BEFORE any network/crypto await"_ so a failure leaves a durable `failed` bubble — **but this synchronous guard sits above it**, reintroducing exactly the P1-1 data-loss class it was written to prevent.
4. `ChatScreen.tsx:684-685` only calls `setError(sendErrorText(e, 'Send failed'))`. `sendErrorText.ts:26` passes the raw string through verbatim — which is how the tester read it. No bubble exists, so the retry chip is inert (`ChatScreen.tsx:705` requires `status === 'failed' || 'undelivered'`).

**Net effect: text gone, one red banner, nothing to retry.**

### 4.3 Why notification-tap failed first, and normal open fails now

Not sync timing — `conversations` (participants included) are persisted and rehydrated
(`messengerStore.ts:1244-1249`, `:1281+`). It is **which row you land on**:

| Entry point                                        | Landing id                           | `participants`     | Outcome                                                                              |
| -------------------------------------------------- | ------------------------------------ | ------------------ | ------------------------------------------------------------------------------------ |
| Home-list tap on the **real** row                  | canonical UUID / `direct:<piyaldeb>` | `[self, piyaldeb]` | filter → 1 recipient → **send succeeds** (silently mis-routed through group fan-out) |
| **Notification tap** (`fcmBootstrap.ts:1007-1010`) | ghost `direct:<self>`                | `[self]`           | filter → 0 → **throw**                                                               |
| Home-list tap on the **ghost** row                 | ghost `direct:<self>`                | `[self]`           | filter → 0 → **throw**                                                               |

The banner is keyed on the messages slot the message actually landed in
(`backgroundMessageNotifier.ts:145,175`) — i.e. **the ghost**. That is why notification-tap
failed first.

And because §3.2's duplicate row is **titled "piyaldeb" and looks identical to the real one**,
the tester now hits the same failure from a normal open simply by tapping the wrong one of
the two identical rows. **This fully explains the mid-session update in §1.3** — and it is
strong independent corroboration that §3.2 really happened on this device.

---

## 5. WHEN — trigger conditions

**B-124** (all required):

1. Build contains `b034b36` (2026-07-18) for the `:4442-4443` alias. _(The `:4434` alias is older.)_ → **v1.0.118/vc146 qualifies.**
2. A live 1:1 call escalated via Add-Call, past the FrameCryptor gate (`CallScreen.tsx:1591-1600`) — so Android, not iOS on this build.
3. `ensureCallGroupKey` reaches the **mint** path: resync gate `:4340` fails and `isReal` `:4389-4393` is false (direct-shaped slot).
4. At least one message sent in that thread afterwards (in-call chat counts).

**B-125:**

1. The ghost `direct:<self>` row from B-124 exists with `participants: ['<own userId>']`.
2. `groups['direct:<own userId>']` holds the `'Call'` state — **persisted across app kills**.
3. Entry lands on that slot (banner tap, or tapping the duplicate row).
4. Fires on **first and every** send — deterministic, not a race. Survives kill/reinstall of state; only deleting the ghost row or the `groups` alias clears it.

---

## 6. WHY — the design gap

**B-124.** The codebase has exactly one marker for "this group is a transient call-key
carrier, not a chat": the literal string `name === 'Call'`. `GroupState`
(`packages/messenger-core/src/groups/types.ts:16-80`) has **no** `isCallGroup` / `ephemeral` /
`hidden` field. So every guard must do a device-local `store.groups[<id>]?.name` lookup, while
the thing being guarded travels across devices. B-106 then made those ids device-_relative_.
The moment an id crosses a device boundary the sentinel dereferences a slot that doesn't exist
locally and silently falls through. There is no server-side backstop because ad-hoc groups are
never registered.

**B-125.** `sendText` conflates _"we hold group key material at this id"_ with _"this
conversation is a group"_. `:2355` is a presence test on the **crypto map** used to select a
**transport topology** — and that topology then derives its recipient list from a completely
different source (`convo.participants`, `:2394`) with **no cross-check that the two agree**. A
row can therefore be group-_routed_ and 1:1-_populated_ simultaneously. Placing the guard
_above_ the optimistic append converts a recoverable routing error into **silent data loss**.

---

## 7. Evidence status — what is proven vs inferred

**Code-confirmed** (read at HEAD, adversarially re-verified by independent agents; 55-agent
trace, every claim re-checked against source, ~40% of first-pass claims refuted and dropped):

- the `!!groupState` seam and its missing `direct` guard (`:2351-2356`)
- all four alias writes and the absence of any cleanup path
- throw-before-append ordering and the composer clear
- device-local sentinel vs cross-device id
- prune paths that cannot reach the ghost

**Inferred, not yet device-proven (~90%):**

- that _this specific_ ghost row on _this_ device was minted by _this_ escalation.

**Why not proven:** v1.0.118 is a **release** build — RN strips `console.log`, so the
`[call-adhoc-key:runtime]` / `[group-create:recv]` traces never reach logcat. The on-device
file logger exists (`src/modules/observability/fileLog.ts`) but is build-flagged
`EXPO_PUBLIC_GROUPCALL_FILELOG=1`, which this build does **not** set — the trace file on the
device is stale (last write **2026-06-27**). The 1.34M-line logcat buffer contained **zero**
hits for `no other participants`, `group-send`, or `ensureCallGroupKey`.

Pulled trace (2026-06-27) does independently show the ad-hoc create loop —
group `4dfbbbed…` receiving repeated `create` actions at 17:49 / 17:50 / 17:55 / 17:59,
each `DROP stale/replayed create … epoch 0 <= local 0` — i.e. a fresh `'Call'` create per
call attempt, the same machinery, historically observed.

---

## 8. To confirm on device (next session)

**Fastest decisive probe — dump the store and look for the ghost row:**
find a `conversations` row with
`id = 'direct:<own userId>'`, `participants = ['<own userId>']`, `peer.userId = <piyaldeb>`,
and a matching `groups['direct:<own userId>'].name === 'Call'`.
That single row proves B-124 → B-125 end to end.

**To get JS traces, rebuild with the file logger on:**

```
EXPO_PUBLIC_GROUPCALL_FILELOG=1  (+ the usual EXPO_PUBLIC_* bake — see release-state memo)
adb pull /sdcard/Android/data/com.bravosecure.app/files/groupcall-trace.log
```

Then reproduce (escalate a 1:1 → send in that thread) and grep:

```
[add-call] escalate picked=…            # the conversationId handed to the group call
[call-adhoc-key:runtime] key distributed delivered=   # mint path ran
[call-adhoc-key:runtime] key resynced delivered=      # resync path (alias already present)
[send.text.routing] canonicalised …     # which slot the send resolved to
[group:recv] no_key — stashed for groupId=…           # ghost-row creation on the peer
[group-create:recv] CREATE for groupId=… name="Call"
```

**Open question worth checking (possible unreported bug):** if the host's slot is a shared
UUID, his group-stamped sends hit `no_key` on piyaldeb and are **stashed, not shown** — i.e.
silent inbound message loss adjacent to these two. Grep `[group:recv] no_key — stashed` on
piyaldeb's device.

---

## 9. Fix direction (NOT implemented — for the developer)

Per the SQA remit no code was changed. Recorded so the handoff is actionable:

1. **The seam** — `productionRuntime.ts:2355`: never let key-material presence alone imply
   "group". At minimum veto it for `convo?.type === 'direct'`, and/or exclude
   `groupState.name === 'Call'`. This one line neutralises B-125 and stops new contamination.
2. **The root** — stop aliasing call keys onto chat-bearing ids (`:4434`, `:4442-4443`).
   Give call-key groups their own namespace, or add a real `isCallGroup` flag to `GroupState`
   so the sentinel stops relying on a device-local name lookup of a cross-device id.
3. **The blast radius** — never stamp a _device-local_ id as `group.groupId` on the wire (`:2539`).
4. **The data loss** — move the participants guard **below** the optimistic append
   (`:2415-2447`) so a failed send leaves a retryable `failed` bubble instead of eating the text.
5. **Cleanup** — a migration to delete existing ghost rows; the current prunes
   (`messengerStore.ts:1322`, `MessengerHomeScreen.tsx:218-223`) cannot reach them, so already-
   affected users stay broken after any code fix.
6. Fix the misleading error string and the stale comment at `CallScreen.tsx:1610-1615`.

> ⚠️ Items 2–3 touch group master-key distribution and envelope shape → **architecture stop-condition** per `CLAUDE.md`. Verify against the System Architecture Documentation before implementing.

---

## 10. Impact

- **Data loss** — user-typed messages silently destroyed (B-125). Highest severity here.
- **Permanent** — survives app kill; no sync, prune, or repair path recovers it.
- **Self-amplifying** — each escalation can add another junk thread (B-124).
- **Confusing** — the duplicate is _indistinguishable_ from the real chat (same name), so the
  user cannot tell which one works.
- **Possible silent inbound loss** — §8, unconfirmed.
