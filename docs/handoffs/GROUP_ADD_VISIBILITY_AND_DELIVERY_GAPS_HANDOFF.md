# Handoff — Group-Add Visibility · Delivery-Failure Signalling · Dormant Relay Purge

> **Date:** 2026-07-03 · **HEAD at time of writing:** `10d694a` (v1.0.88, vc113) · **Status:** ✅ **IMPLEMENTED 2026-07-03** (same-day follow-up session) — see the addendum at the end of this file for what shipped, where, and what remains (device QA + production attestation).
>
> **Purpose:** this document is a _self-contained fix specification_. A future session should be able to implement all three fixes below **without re-exploring the codebase** — every root cause is cited to file:line with the relevant code quoted, and every fix lists the exact files, functions, and steps. Line numbers were verified against `10d694a`; if the file has drifted, search for the quoted code, not the line number.

---

## The three problems

| #   | Problem                                                                                                                                             | Severity | One-line root cause                                                                                                                                                                                                                                                                                                |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Added group member never sees the group appear in their Messages page (admin sees it instantly — WhatsApp shows it on both)                         | HIGH     | The ONLY writer of the member's conversation row is the E2EE `admin:create` envelope (`productionRuntime.ts:5887-5903`); `addGroupMember` records nothing server-side, a killed app never processes the wake, and the key-request self-heal is a catch-22 that needs the very conversation row that's missing (§2) |
| 2   | Sender sees ✓✓ on messages that were destroyed on receive (ack-drop == delivered), and receiver gets no "couldn't be decrypted" placeholder         | HIGH     | One wire signal (`ack`) means both "delete from relay" AND "delivered": the relay emits `envelope.delivered` unconditionally on ack (`envelope.service.ts:311-365`), every terminal decrypt-failure branch acks, and no failure branch ever inserts a message row (§3)                                             |
| 3   | `purgeStaleRecipientQueue` is dormant — server endpoint + client method + helper all exist, but nothing calls the helper after an identity rotation | MEDIUM   | Helper `ownIdentityRotation.purgeStaleRecipientQueue` is imported by nothing but its own test; and even with a call site it would fail — the keys-upload response discards `identityRotated`, and the mobile app has no flow to mint the required `X-Mfa-Proof` action token (§4)                                  |

---

## 1. System primer (read this first — shared context for all three fixes)

### 1.1 Architecture in ten lines

- Mobile app: React Native + Expo, messenger logic in `src/modules/messenger/`, the ~6000-line orchestrator is `src/modules/messenger/runtime/productionRuntime.ts`.
- Shared platform-agnostic crypto/transport: `packages/messenger-core/src/` (imported as `@bravo/messenger-core`). **The live transport client is `packages/messenger-core/src/transport/client.ts`** — `src/modules/messenger/transport/client.ts` is a DEAD file (imported nowhere; see RELAY-C1 in `docs/audits/MESSENGER_FULL_AUDIT_2026-07-02.md`).
- Relay backend: NestJS `apps/messenger-service` — HTTP relay under `src/relay/` (`envelope.controller.ts`, `envelope.service.ts`, `envelope.store.ts`), WS gateway `src/gateway/messenger.gateway.ts`. Envelopes are stored transiently (30-day max dwell) in Redis.
- E2EE: inner Double Ratchet (libsignal) + outer Sealed Sender v3 (ECIES + AES-GCM) — `packages/messenger-core/src/crypto/sealedSender.ts`, `outerEcies.ts`. The relay never sees plaintext or true sender identity.
- Groups use a **group master-key broadcast** model (sanctioned divergence from Signal Sender Keys): group state (masterKeyB64, members, epoch) is distributed via **pairwise** Signal sessions as signed admin actions (`create` / `add` / `remove`), handled by `group-create:recv` / admin-action handlers in `productionRuntime.ts`.
- Local store: SQLCipher SQLite + the Zustand store `src/modules/messenger/store/messengerStore.ts` (NOT `src/store/messengerStore.ts` — that is a legacy stub) whose `conversations` map + `conversationOrder` array drive the Messages page (`src/screens/messenger/MessengerHomeScreen.tsx`).

### 1.2 How a 1:1 message flows (the delivery/ack/receipt loop)

1. Sender seals: inner ratchet encrypt → `sealPayload` → outer ECIES wrap → `RelayEnvelope` (no sender on the wire).
2. Transport: WS `envelope.submit` when connected, else HTTP `POST /envelopes` (also used for **all group fan-out** and outbox drains).
3. Relay stores the envelope in the recipient's queue and fires a data-only FCM wake (`{kind:'msg-wake'}`). At HEAD both the WS path (`messenger.gateway.ts:920-922`) and the HTTP path (`envelope.controller.ts:85-96`, fixed in `4025d6c` on 2026-07-02) fire it — **verify the deployed Contabo container includes `4025d6c`**. The wake draws a banner but does NOT reliably cause envelope processing (killed app: banner only, `fcmHeadless.ts:82-99`).
4. Recipient receives it live over WS (`envelope.deliver`) or by draining (`GET /envelopes` pull) on connect/foreground.
5. Recipient processes it in `productionRuntime.ts` (`handleDeliver` / drain loop) and then **acks**: `relay.ack(envelopeId, ackToken)` → the relay **deletes** the envelope and emits `envelope.delivered` to the sender's sockets.
6. Sender's `envelopeDelivered.ts` handler matches `msg.envelope_id` and flips the bubble to ✓✓ `delivered`.

**The load-bearing conflation:** step 5's ack means "you may delete this from the relay" but step 6 interprets it as "the human's device successfully decrypted and stored it". Every failure path that acks (to avoid poison-pill redelivery loops) therefore _lies_ to the sender. That is Problem 2.

### 1.3 Known adjacent bugs that interact with these fixes (do NOT re-discover them)

| ID              | What                                                                                                                                                                                                                                                                                                                                                                                                                                              | Where documented                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **MSG-01 / A3** | ⚠️ **STALE on HEAD — already remediated.** The audit described a 15-min AAD window; at `10d694a` the stale bound is the 30-day relay dwell and the future bound is 24 h (`packages/messenger-core/src/crypto/sealedSender.ts:308,325,351`). The AAD-**reject** branch still exists for genuinely out-of-window / binding-failed envelopes and still commits + acks (see §3.3) — Problem 2 makes those losses _visible_. Do not re-fix the window. | `docs/audits/MESSENGER_FULL_AUDIT_2026-07-02.md` §MSG-01 (superseded) |
| **PUSH-B1**     | ⚠️ **FIXED in code at HEAD** (`4025d6c`, 2026-07-02): HTTP `POST /envelopes` now fires `sendChatWake` (`envelope.controller.ts:85-96`) like the WS handler (`messenger.gateway.ts:920-922`). **Verify the deployed `bravo-staging-msgr` container includes it.** Remaining real gap: the killed-app FCM handler draws a banner only, never pulls envelopes (`src/modules/messenger/push/fcmHeadless.ts:82-99`).                                   | same audit, §PUSH-B1 (partially superseded)                           |
| **B-42**        | `group-create:recv` epoch guard used to drop the key-bearing `create` when the member held a keyless state at ≥ epoch; fixed vc106 by gating the drop on `existing.masterKeyB64`. One historical cause of "added to a group but nothing shows".                                                                                                                                                                                                   | `sqa.md` B-42 (line ~921)                                             |
| **P1-T2**       | Server `purgeStaleRecipientQueue` deletes every queued envelope for the caller without verifying an identity rotation actually happened. Relevant when wiring Problem 3.                                                                                                                                                                                                                                                                          | `docs/audits/MESSAGING_AUDIT.md` P1-T2                                |
| **MSG-03**      | HTTP-sent messages never record `envelope_id` on the bubble → group ticks never advance. Touches the same receipt-matching code as Problem 2.                                                                                                                                                                                                                                                                                                     | full audit §MSG-03                                                    |

### 1.4 Security stop-conditions that apply (from CLAUDE.md — do not violate)

- The relay must never learn plaintext, decrypt outcomes tied to content, or true sender identity (sealed sender). Any "decrypt failed" signal back to the sender must travel **inside** the normal E2EE channel, not as relay metadata.
- AAD binding / sealed-sender envelope shape / group epoch handling are **stop-conditions**: changes need architecture sign-off. The fixes below are designed to _avoid_ touching them; where an option would touch them it is explicitly marked **arch-gated**.
- Never log plaintext bodies or key material (`logAudit.test.ts` enforces).
- Do not add "skip verification" branches to `verifySenderCert` / `verifySealedAad` / epoch guards.

---

## 2. PROBLEM 1 — Added member never sees the group in their Messages page

### 2.0 Plain-English summary

When the admin adds someone to a group, the _only_ thing that can make the group appear on that person's phone is a single encrypted "here is the group" letter (`admin: create`) mailed through the relay. Nothing is written on the server that says "this user is in this group", so there is no second chance: if that one letter isn't opened _right then_ (phone offline, app killed, letter lost), the app has no other way to learn the group exists. Worse, the app's "ask someone to resend the group key" recovery can only address peers it finds **in the conversation row** — the very row the lost letter would have created. It's a locked mailbox whose only key was inside the mail.

### 2.1 Symptom & expected behavior

- Admin adds member B to group G from `ChatInfoScreen` ("Add member" row, `src/screens/messenger/ChatInfoScreen.tsx:481-494` → `NewChatScreen` in add-to-group mode).
- Admin's Messages page shows G immediately (admin already had the conversation row).
- Member B's Messages page (`MessengerHomeScreen`) shows **nothing** — no new conversation, no notification content — until some later event (app restart / foreground with reconnect), and in the delivery-failure case, **never**.
- WhatsApp parity: the group must appear on B's Messages page promptly after the add, even if B's app was killed, with a "you were added to G" notification.

### 2.2 What the Messages page renders from (why "no row" == invisible)

`src/screens/messenger/MessengerHomeScreen.tsx` renders purely from the Zustand store — no SQLite query, no "≥1 message" requirement, independent of the `groups` (crypto state) map:

```tsx
// MessengerHomeScreen.tsx:51-52, 214-219
const conversations     = useMessengerStore(s => s.conversations);
const conversationOrder = useMessengerStore(s => s.conversationOrder);
...
const ordered = useMemo<LocalConversation[]>(
  () => conversationOrder
    .map(id => conversations[id])
    .filter((c): c is LocalConversation => !!c && !deptGroupIds.has(c.id)),
  [conversationOrder, conversations, deptGroupIds],
);
```

Store: `src/modules/messenger/store/messengerStore.ts` — `upsertConversation` at `:368-372` (`s.conversations[c.id] = c; if (!existed) {s.conversationOrder.unshift(c.id);}`), zustand-`persist` backed. `GroupsScreen.tsx:108,143` renders from the same map.

On mount the screen syncs from `GET /conversations/mine` (`MessengerHomeScreen.tsx:124-179`) — but that can never surface a messenger group, because the server has no record of client-minted groups (§2.3c). The prune at `:167-175` only deletes UUID-shaped ids; client group ids are 32-hex-char hashes (`deriveGroupId`, `packages/messenger-core/src/groups/groupClient.ts:675-686`), so E2EE-only rows survive sync but can never be _created_ by it.

### 2.3 What the admin's `addGroupMember` actually does

`src/modules/messenger/runtime/productionRuntime.ts`, `addGroupMember` at **`:3337-3531`**, called from `NewChatScreen.tsx:193-196` (`runtime.addGroupMember({groupId, newMember: {userId, deviceId: 1}})`). Under `runWithGroupAdminLock` (`:3339`) it sends three E2EE envelope waves:

1. **`add` admin action** to the post-add member set (existing members AND new member), wrapped under the CURRENT (old) master key (`:3396-3440`). The new member **cannot decrypt this** (no key yet).
2. **`rekey` admin action** to the same set, wrapped under the OLD key (`:3447-3499`), then rotates the local state (`:3498-3499`). New member can't decrypt this either.
3. **The one that matters — "RC1"**: an UNWRAPPED, owner-signed `admin: create` carrying the post-rekey state (incl. the new master key) over the new member's **pairwise** Signal session (`:3506-3527`), via `reshareGroupKeyState` (`:1589-1663`, cooldown `RESHARE_COOLDOWN_MS = 15s` at `:1573`):

```ts
// productionRuntime.ts:3520-3527
try {
  const keyed = await reshareGroupKeyState(stateAfterRekey, [newMember.userId]);
  if (keyed === 0) {
    console.warn(
      '[group-add-rekey:runtime] new member did not receive the key inline; will self-heal via key-request',
    );
  }
} catch (e) {
  console.warn('[group-add-rekey:runtime] new-member key delivery failed', asErrorMessage(e));
}
```

The comment at `:3518-3519` ("a failure here self-heals via the member's key-request on next focus/reconnect") is **false** — see Cause (c) in §2.6.

**(c) Server-side: NOTHING.** `addGroupMember` makes zero HTTP calls to auth-service. The mobile client's only conversation endpoint is read-only (`src/services/api.ts:1563-1567`, `conversationApi.listMine → GET /conversations/mine`). The server _does_ have `POST /conversations/:id/members` (`apps/auth-service/src/conversations/conversations.controller.ts:47-54`) but the mobile app never calls it for messenger groups.

### 2.4 Transport & wake — why "offline at add-time" means "invisible until next app open"

Per-envelope delivery (both `addGroupMember`'s `deliverFn` `:3383-3390` and `reshareGroupKeyState` `:1651-1652`):

```ts
try {
  transport.send({event: 'envelope.send', data: {to: peer, outerSealed, clientMsgId}});
} catch {
  await relay.send({recipient: peer, outerSealed, clientMsgId});
}
```

(`TransportClient.send` throws synchronously when the socket isn't connected; the live copies are the messenger-core ones — `productionRuntime.ts:46-56` imports from `@bravo/messenger-core`.)

Relay side (`apps/messenger-service/src`):

- Recipient online → live `envelope.deliver` frame (`relay/envelope.service.ts:485,503`).
- Recipient offline → queued (30-day dwell), pushed on next WS connect via `flushPendingOnConnect` (`gateway/messenger.gateway.ts:609-640`).
- FCM wake fires on both WS (`messenger.gateway.ts:920-922`) and HTTP submit (`envelope.controller.ts:85-96`, `4025d6c` — **verify deployed**). It is data-only `{kind:'msg-wake', senderUserId}` (`push/push.service.ts:434-479`).
- **But the wake does not cause processing:** killed app → banner only, no pull, no runtime bootstrap (`src/modules/messenger/push/fcmHeadless.ts:82-99`); backgrounded app → banner + _best-effort_ `rt.pullEnvelopes()` that is frequently skipped (`src/modules/messenger/push/fcmBootstrap.ts:960-971`).

### 2.5 The receive-side seam — one writer, three ways to miss it

Incoming `admin: create` is handled in `doHandleIncoming`, admin branch `productionRuntime.ts:5707-5910`: owner-signature verify (`:5737-5788`), B-42 keyless-bootstrap epoch guard (`:5812-5815`, gated on `existing.masterKeyB64` — intact at HEAD), `store.setGroupState(...)` (`:5856-5858`), then **the only group-conversation-row writer on a receiving device**:

```ts
// productionRuntime.ts:5887-5903
if (action.state.name !== 'Call') {
  const memberIds = Object.keys(action.state.members);
  const otherMembers = memberIds.filter(uid => uid !== peer.userId);
  store.upsertConversation({
    id:            action.state.groupId,
    type:          'group',
    name:          action.state.name,
    participants:  memberIds,
    unread_count:  0,
    ...
  });
}
// :5910
return {kind: 'drain-group', groupId: action.state.groupId};
```

**Seam A — duplicate `create` can't repair a missing row.** The idempotent early-return precedes the upsert:

```ts
// productionRuntime.ts:5827-5829
if (existing && existing.masterKeyB64 && action.state.epoch === existing.epoch) {
  if (action.state.masterKeyB64 === existing.masterKeyB64) {
    return; // idempotent duplicate — nothing to do
  }
```

So a device that has `groups[gid]` (crypto state) but lost/never-wrote `conversations[gid]` can never be repaired by redelivery.

**Seam B — the `add`/`rekey` envelopes and ordinary group messages do NOT create a row.** They're master-key-wrapped; the keyless new member hits `no_key` → durable stash only (`productionRuntime.ts:5623-5660`, store `src/modules/messenger/store/pendingGroupEnvelopeStore.ts`). No `upsertConversation` in that branch — stashed envelopes are invisible on the Messages page.

**Seam C — the self-heal catch-22.** The stash branch returns `{kind: 'request-group-key'}` → post-txn signal (`:4914-4916`) → `requestGroupKeyResyncImpl` (`:1729-1753`), which derives its targets from the conversation row:

```ts
// productionRuntime.ts:1746-1748
const convo = conversations[gid];
const participants = (convo?.participants ?? []).filter(uid => uid && uid !== ownAddress.userId);
if (participants.length === 0) {
  continue;
}
```

No `conversations[gid]` row ⇒ no participants ⇒ **the key-request is never sent** — even though the stash branch knew the sender's address (`peer.userId`).

### 2.6 Root cause by scenario

| Scenario at add-time                                                                                                          | What happens                                                                                                                                                                                                    | Group visible when?                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| (a) Member foreground, socket live                                                                                            | `create` arrives as the 3rd live frame, row upserted                                                                                                                                                            | Immediately (works at HEAD). If "broken" was observed here, the socket was actually dead → behaves as (b)                        |
| (b) Member offline / app killed / backgrounded-dead-socket (**dominant case**)                                                | `create` queued on relay; FCM wake draws a banner only; nothing else can create the row (no server record, `/conversations/mine` returns nothing)                                                               | Next app open / foreground / WS reconnect (`coalescedDrain`, `productionRuntime.ts:859-867`, `:1104-1109`)                       |
| (c) Member online but `create` delivery failed (`keyed === 0` at `:3521-3524` — X3DH bundle fetch failure, transient network) | Self-heal is a catch-22 (Seam C); later group messages only stash `no_key` and fire the same dead-ended signal; boot drain skips keyless groups (`:1341`)                                                       | **Indefinitely** — until an owner-side event re-sends a `create` (e.g. a group call's `ensureCallGroupKey` resync, `:3560-3569`) |
| (d) Latent side-bugs                                                                                                          | Duplicate `create` can't repair a missing row (Seam A); `upsertConversation` fully replaces the row, so a later reshare-`create` resets `unread_count`/`last_message`/mute state for members who already had it | —                                                                                                                                |

### 2.7 Fix plan (ordered; 1–3 are client-only and ship together)

1. **Break the catch-22 (highest value, smallest diff).** In the `no_key` stash branch (`productionRuntime.ts:5623-5660`) the sender address IS known — extend the `request-group-key` post-txn signal to carry `peerUserId`/`peerDeviceId`, and in `requestGroupKeyResyncImpl` (`:1729-1753`) fall back to `sendKeyRequest(gid, [signalPeer])` when `conversations[gid]` is absent. `sendKeyRequest` (`:1666-1727`) already builds a synthetic state and needs only target userIds. The owner side already answers key-requests roster-gated (`:5715-5726`), and its `reshareGroupKeyState` `create` then installs both the crypto state and the conversation row.
2. **Placeholder row on stash (UI backstop).** In the same `no_key` branch, upsert a minimal placeholder conversation (`type:'group'`, generic name `'Group'` until the `create` lands, a `session_state:'pending-key'`-style marker), mirroring the shape at `:5887-5903`. This makes the thread visible in a "syncing" state AND makes the existing self-heal triggers reachable (WS-connect resync `:881-883`, ChatScreen-open resync `ChatScreen.tsx:314-319`).
3. **Make the duplicate-`create` early-return row-repairing.** At `:5827-5829`, before `return`, check `!useMessengerStore.getState().conversations[action.state.groupId]` and run the upsert block. Extract `:5887-5903` into a helper (e.g. `upsertGroupConversationFromState(state, peerUserId)`) reused by both paths.
4. **Give the offline/killed case a real backstop (choose one; (i) is recommended but arch-gated).** (i) Call the existing `POST /conversations/:id/members` (`conversations.controller.ts:47-54`) from `addGroupMember`, so `/conversations/mine` backfills the row at next app open — **this makes group membership server-visible metadata → needs architecture sign-off** against the sealed-sender metadata constraints (note: dept-chat already server-records membership via intents + `registerGroup`, `api.ts:1371`, so precedent exists). (ii) Teach the killed-app headless handler (`fcmHeadless.ts:82-99`) to run a minimal envelope pull — much bigger lift (headless runtime bootstrap was deliberately removed for stability; see PUSH-B3 note in the full audit). Also **verify the deployed messenger-service includes `4025d6c`** so the HTTP-submit path fires wakes at all.
5. **Preserve local fields on reshare-`create` upsert.** Merge `unread_count`/`is_muted`/`is_pinned`/`last_message` when the row exists (pattern already used at `MessengerHomeScreen.tsx:148-165`), fixing latent bug (d).

### 2.8 Tests

Run: `npm run test:crypto` (Jest project `messenger-crypto`; globs cover `src/modules/messenger/__tests__/**` + `packages/messenger-core/__tests__/**`, `package.json:189-196`).

- `packages/messenger-core/__tests__/groupSelfHeal.test.ts` — reshare/key-request engine; the catch-22 fix's home.
- `src/modules/messenger/__tests__/groupCreateEpochBootstrap.test.ts` — B-42 keyless epoch guard (must stay green — do NOT weaken the guard).
- `src/modules/messenger/__tests__/groupBroadcast.test.ts`, `pendingGroupEnvelopeStore.test.ts`, `bootGroupStashDrain.test.ts`, `tamperKeyDivergenceStash.test.ts` — fan-out + stash/drain machinery.
- ⚠️ `src/modules/messenger/__tests__/adhocCallKeyLookup.test.ts:84` asserts the `name !== 'Call'` upsert gate — extracting the upsert block (fix 3) may require updating it.
- New tests needed: (1) `no_key` stash with missing conversation row → key-request sent to the stash peer; (2) duplicate `create` with missing row → row repaired; (3) reshare-`create` on existing row preserves unread/mute; (4) placeholder row replaced (not duplicated) when the real `create` lands.

### 2.9 Device verification (3 accounts — see `sqa.md` Device & Identity Reference)

1. A adds B while B's app is **killed** → B gets a banner; on open, group visible on Messages page. 2. Repeat while B is **foreground** → group appears live. 3. Simulate delivery failure (airplane-mode B mid-add, or block the reshare) → B opens the group's first stashed message → placeholder thread visible → key-request fires → thread heals. 4. Regression: existing member's unread count / mute survives a reshare.

---

---

## 3. PROBLEM 2 — Ack-drop produces a false ✓✓ and no receiver placeholder

### 3.0 Plain-English summary

The relay's "ack" is one word being used for two different sentences. When the receiving phone acks an envelope it means "you can delete this from the relay now" — but the relay treats every ack as "the human received it" and lights up the sender's ✓✓. The receiving phone deliberately acks even when decryption _failed_ (otherwise the relay would redeliver the broken envelope forever), so a destroyed message and a delivered message look identical to the sender. And on the receiving side, failures write only telemetry — no "1 message couldn't be decrypted" bubble ever appears in the chat. Net effect: messages vanish without a trace, with a lying double-tick.

### 3.1 The one-signal conflation (root cause statement)

The protocol has **one signal where three are needed**:

1. **No ack-with-outcome distinction** — "delete this envelope" and "I have this message" are the same wire call (`POST /envelopes/:id/ack` / WS `envelope.ack`).
2. **No sender-directed decrypt-failure signal** — nothing analogous to `envelope.delivered` exists for "destroyed".
3. **No receiver-side placeholder** — failure branches write telemetry (`noteUndecryptable`, a counter + warn only, `src/modules/messenger/backup/sessionRatchetRecovery.ts:54-59`) and transient banner state, never a persistent per-conversation row.

The receiver acks failures **on purpose** (P1-4 posture): an unacked poison envelope is redelivered by `flushPendingOnConnect` on every connect (`messenger.gateway.ts:609-620`) — infinite redelivery loops were a real historical failure (see the BS-CERT-MISMATCH comment, `productionRuntime.ts:4542-4551`). So "stop acking failures" is NOT the fix; signalling honestly is.

### 3.2 Receiver: every terminal failure branch that still acks

Both inbound paths live in `src/modules/messenger/runtime/productionRuntime.ts` and end in the same `relay.ack()` (`packages/messenger-core/src/transport/relayClient.ts:106-112` — whose own header comment `relayClient.ts:16` states the contract the code violates: _"hard-delete on successful decrypt"_).

**WS path** — `handleDeliver` (`:4409`, dedup wrapper) → `handleDeliverInner` (`:4424-4719`):

| Branch                                                     | Where                                                             | Acks?                  |
| ---------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------- |
| Already-seen dedup                                         | `:4451-4456`                                                      | re-ACK (correct)       |
| Outer ECIES unwrap failure                                 | `:4469-4492`                                                      | **ACK-drop**           |
| v3 sender-cert pre-verify failure (stale cert)             | `:4579-4587`                                                      | **ACK-drop**           |
| Cert refresh `unavailable` (keys-service outage)           | `:4572-4576`, `:4672-4674`                                        | leave on relay (retry) |
| B-30 first-message `LeaveOnRelayError`                     | `:4622-4626` (thrown `:4884-4887`)                                | leave on relay (retry) |
| `handleIncoming` throw catch-all (cert reject, bad MAC, …) | `:4679-4692`                                                      | **ACK-drop**           |
| Terminal ack — fires regardless of `handledOk`             | `:4694-4708` (`if (!leaveOnRelay) { await deps.relay.ack(...) }`) | —                      |

**Inside `doHandleIncoming`** (wrapped in the SQLite receive txn via `runWithRatchetTxn`, `src/modules/messenger/runtime/receiveTransaction.ts:78-105`):

| Branch                                  | Where                                                                                        | Behavior                                                                                   |
| --------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Unrecoverable ratchet decrypt error     | `:5269-5304` (`throw e` at `:5304`)                                                          | txn rollback → catch-all → **ACK-drop**                                                    |
| Cert/peer or device-id mismatch         | `:5367-5375` (throw)                                                                         | rollback → **ACK-drop**                                                                    |
| **AAD-freshness / binding reject**      | `:5407-5438` — **clean `return`**, txn COMMITS (ratchet advance kept!), `handledOk=true`     | **ACK → ✓✓**; only a transient global `setError('Dropped one envelope (sealed-sender …)')` |
| Already-expired disappearing message    | `:5442-5445` (silent clean return)                                                           | **ACK → ✓✓**                                                                               |
| Group `tamper` → stash / `tamper` final | `:5575-5595` / `:5597-5621`                                                                  | commit + **ACK → ✓✓**, nothing renders                                                     |
| Group `no_key` → durable stash          | `:5623-5660`                                                                                 | commit + **ACK → ✓✓**, nothing renders                                                     |
| Happy path                              | 1:1 `:6100-6128` (`appendMessage` `:6123`, `sqlMessages.upsert` `:6128`); group `:6081-6083` | ACK is honest here                                                                         |

**HTTP drain path** — `drainRelay` (`:6301-6649`): unwrap failure ACK-drops (`:6377-6386`), seen-dedup re-ACKs (`:6393-6396`), cert pre-verify failure ACK-drops (`:6465-6476`), catch-all falls through (`:6601-6611`), terminal per-envelope ACK explicitly unconditional (`:6618-6624`: _"ACK regardless of handled outcome EXCEPT when refresh-and-retry deferred"_).

**Note on AAD-reject:** because the clean return COMMITS the ratchet advance, redelivery/archive replay of that ciphertext would bad-MAC — recovery-by-redelivery is not viable for committed-then-rejected envelopes. Only a receiver placeholder or a sender NACK can surface the loss.

### 3.3 Server: ack unconditionally emits `envelope.delivered`

`apps/messenger-service/src/relay/envelope.service.ts:311-365`:

```ts
async ack(caller: SessionAddress, envelopeId: string, ackToken?: string): Promise<void> {
  ...
  await this.store.ack(envelopeId, caller);          // hard-delete (envelope.store.ts:217-222)
  await this.store.deleteAckToken(envelopeId);
  // Audit P0-T6 — fire the sender-facing delivered notification.
  try {
    const submitter = await this.store.takeSubmitter(envelopeId);
    if (submitter) {
      this.hub.emitToDevice(submitter, 'envelope.delivered', {envelopeId});
      // Audit RELAY-C3 — queue for offline senders too
      try { await this.store.addPendingDelivered(submitter.userId, envelopeId); } catch {}
    }
  } catch (e) { ... }
}
```

Offline replay: `flushPendingDelivered` (`envelope.service.ts:372-381`) on every sender reconnect (`messenger.gateway.ts:518`) — the ✓✓ lie survives sender offline windows. Ack entry points: HTTP `POST /envelopes/:id/ack` (`envelope.controller.ts:148-163`) and WS `envelope.ack` (`messenger.gateway.ts:949-976`), both → the same `envelopes.ack()`. The `ackToken` (P0-N9) gates _who_ may ack, not _what ack means_. By sealed-sender design the relay cannot know whether decrypt succeeded — the receiver is the only party that can tell the truth.

**Scope note:** the submitter mapping is recorded only for **WS-submitted** envelopes (`messenger.gateway.ts:897-909`; the HTTP controller deliberately doesn't — `envelope.controller.ts:74-83`, `envelope.service.ts:214-223`). So the ✓✓ lie applies to 1:1 WS sends (the dominant path); group fan-out / HTTP-fallback sends never get `envelope.delivered` at all (their bubbles cap at 'sent' — that's MSG-03, a separate bug).

### 3.4 Sender: receipt → tick mapping

- Status enum: `src/types/index.ts:167` — `'sending' | 'sent' | 'delivered' | 'read' | 'failed'`.
- `sending → sent`: `handleAccepted` on `envelope.accepted` (`productionRuntime.ts:4376-4398`; stores `envelope_id` on the bubble at `:4386` — this is how `envelope.delivered` is later matched).
- `sent → delivered`: `envelope.delivered` frame (`:4211-4213`) → `applyEnvelopeDelivered` (`src/modules/messenger/runtime/envelopeDelivered.ts:35-49`): matches `msg.envelope_id === envelopeId`, `updateMessageStatus(conversationId, msg.id, 'delivered')`.
- `delivered → read`: read-receipt frame handler `:4214-4258`. Read receipts are only sent for **rendered** rows (`markRead`, `:3700-3738`) — so a destroyed message can show ✓✓ but never blue ✓✓, which is the observable tell of the lie.
- Store mutation: `messengerStore.ts:648-659`; tick icons: `src/screens/messenger/ChatScreen.tsx:2150-2161` (`'delivered' → check-all` gray, `'read' → check-all` glow).

### 3.5 Receiver placeholder — confirmed absent; the pattern to copy

No failure branch inserts a message row (verified across every branch in §3.2). The only UI-adjacent failure state:

- `setError(...)` — a single **global, transient** string slot; only chat-adjacent renderer is ChatScreen's status strip (`ChatScreen.tsx:896-903`, rendered `:1076-1084`); clobbered by any later error; not per-conversation; not persisted.
- `setRecoveryBanner(...)` (`messengerStore.ts:138,818`, set at `productionRuntime.ts:5285-5293`) — **has no UI consumer at all** (dead store state). Either render it or delete it as part of this fix.

**Closest existing pattern — the durable group stash** (copy this model):

- `src/modules/messenger/store/pendingGroupEnvelopeStore.ts` — SQLCipher table `{envelopeId, groupId, peer, sealedJson, receivedAtMs, attempts}`, bounds `MAX_PER_GROUP=256 / MAX_GLOBAL=2048 / RETENTION_MS=30d / MAX_ATTEMPTS=3` (`:55-58`); header (lines 17-25) documents the ownership handoff: _"ACK the relay (we own durability now)"_.
- Stash writes happen **inside the receive txn** (`productionRuntime.ts:5579-5586`, `:5631-5638`) so stash + `markSeen` + ACK stay consistent.
- Drain: `drainPendingGroup` (`:5029-5080`) → `replayGroupSealedDecode` (`:5094+`, appends + upserts at `:5164-5165`), triggered post-txn by admin create/rekey (`:4897-4907`) + boot (`src/modules/messenger/runtime/bootGroupStashDrain.ts`, wired `:1327-1348`).

### 3.6 Fix design — three options, recommended composite

**(a) Receiver-side placeholder rows — client-only, NOT architecture-gated. Do this first.**

- Insert a `LocalMessage` (reuse `type: 'system'`, already in the `MessageType` union at `src/types/index.ts:166`, or add a `decrypt_failed` marker field) with content like "1 message couldn't be decrypted", **deduped by `envelopeId`**, appended via `useMessengerStore.getState().appendMessage` + `sqlMessages.upsert` (mirror the 1:1 happy path `:6100-6128`).
- **Routing split:** AAD-reject / tamper / `no_key` failures happen _after_ unwrap — `peer`/`groupId` are known → insert into the real thread. Unwrap/cert failures don't know the conversation (sender is inside the broken wrap) → per-account surface only (synthetic "system" thread or badge).
- **Txn caveat:** branches that `throw` (cert mismatch `:5368`, bad MAC) roll the receive txn back — the placeholder upsert must run **after** rollback, e.g. thread a `{kind:'render-failure', peer?, envelopeId, reason}` request through the existing post-txn dispatch (`:4874-4916`).
- **Group stash upgrade:** stash branches insert a _pending_ placeholder ("waiting for this message") that `replayGroupSealedDecode` replaces (upsert by same message id) when the key arrives — WhatsApp parity.
- Sites to touch: `handleDeliverInner` `:4469-4492`, `:4585-4587`, `:4679-4692`; `doHandleIncoming` `:5407-5438`, `:5597-5621` (+stash `:5579`, `:5631` for pending placeholders); `drainRelay` `:6377-6386`, `:6465-6476`, `:6601-6611`. NO placeholder on leave-on-relay branches (they retry).

**(b) Encrypted decrypt-failure receipt (NACK) to the sender — sealed-sender-pure, PARTIALLY arch-gated.**

- Send a normal pairwise sealed envelope back to the sender with a new `control` value (send-side `sealPayload` control opt-in `packages/messenger-core/src/crypto/sealedSender.ts:291`; receive-side pattern: the `control === 'rehandshake'` branch `productionRuntime.ts:5451-5454`) carrying `{failedEnvelopeId, reason}` inside the ciphertext. Relay learns nothing.
- Sender: new status (e.g. `'undelivered'`) in `MessageStatus` (`src/types/index.ts:167`), `statusToIcon` case (`ChatScreen.tsx:2150`), and a guard in `applyEnvelopeDelivered` (`envelopeDelivered.ts:41`) so a late `envelope.delivered` can't overwrite it.
- **Gate:** adds a field to the inner sealed payload — inner (post-decrypt) not AAD/wire, but still touches "sealed-sender envelope shape" → get sign-off. **Catch:** unusable exactly where most needed (no session with sender / unwrap failure) — must be combined with (a).

**(c) Ack disposition: distinguish ack-for-delete from delivered — relay change, architecture-gated.**

- `POST /envelopes/:id/ack {ackToken, disposition: 'delivered' | 'discarded'}` (+ WS `ClientEnvelopeAck`, `packages/messenger-core/src/transport/protocol.ts:49`). `envelope.service.ts:311-365` deletes in both cases but emits `envelope.delivered` only for `'delivered'`; optionally a new `envelope.undeliverable {envelopeId}` frame (next to `ServerEnvelopeDelivered`, `protocol.ts:372`) with `addPendingDelivered`-style offline queueing. Client passes disposition from branch context at `:4700` and `:6624`; sender handles the new frame next to `:4211-4213`.
- **The gated part:** discloses a one-bit decrypt outcome per envelope to the relay (today all acks look identical). Precedent that softens it: plaintext `read-receipt` frames already disclose read-state per envelopeId to the gateway (`packages/messenger-core/src/transport/client.ts:311-316`). Architecture board's call.
- Rollout safety: missing `disposition` defaults to `'delivered'` (same pattern as `requireAckToken`, `envelope.service.ts:55-57`). Mirror any `protocol.ts` change in ops-console (it consumes `@bravo/messenger-core` with its own receive path).

**Recommended composite:** (a) immediately (client-only), + (c) for an honest sender tick (small, needs sign-off), with (b) as the sealed-sender-pure alternative to (c) if the one-bit leak is rejected. Also render-or-delete the dead `recoveryBanner` slot.

### 3.7 Tests

- Run: `npm run test:crypto`; server: `cd apps/messenger-service && npm test`.
- Extend: `src/modules/messenger/__tests__/envelopeDelivered.test.ts` (locks `sent→delivered`; new statuses/guards go here), `firstMessageDrop.test.ts` (the pattern for testing module-private receive orchestration — "pin the exported decision logic"), `tamperKeyDivergenceStash.test.ts`, `pendingGroupEnvelopeStore.test.ts`, `bootGroupStashDrain.test.ts`, `seenEnvelopeStore.test.ts`, `receiveTransaction.test.ts`, `sealedSender.test.ts` (both copies), `apps/messenger-service/src/relay/envelope.service.spec.ts` (ack hard-delete/ackToken/`deliveredNow` — extend for disposition).
- New tests a fix needs: (1) each terminal failure branch → exactly one placeholder row, deduped by envelopeId across WS + drain redelivery; none on leave-on-relay; (2) placeholder survives restart and is _replaced_ by the real message after a successful stash drain; (3) sender status never reaches `'delivered'` after a `discarded`/NACK, including the late-`envelope.delivered` race; (4) server: `ack(disposition:'discarded')` deletes without emitting `envelope.delivered`; missing disposition defaults to delivered; (5) `logAudit.test.ts` compliance — placeholder/NACK code must not log plaintext or key bytes.

---

---

## 4. PROBLEM 3 — `purgeStaleRecipientQueue` is dormant

### 4.0 Plain-English summary

When someone reinstalls the app, their phone gets a brand-new identity key and the old one is gone forever. Every message still queued for them on the relay was locked to the OLD key — those envelopes are now permanently unopenable garbage. A "sweep my dead mail" endpoint exists on the server, and the client code to call it exists too — but **nobody ever connected the wire**, so the garbage sits on the relay and the phone laboriously downloads, fails to open, and discards each piece one by one on every drain. Wiring it up also creates the natural hook for a "you may have missed messages sent before your reinstall" notice.

### 4.1 What already exists (verified at HEAD — do not rebuild any of this)

**Server endpoint** — `POST /envelopes/purge-stale-recipient`, `apps/messenger-service/src/relay/envelope.controller.ts:203-214`:

```ts
@UseGuards(RecipientPurgeGuard)
@Post('purge-stale-recipient')
@HttpCode(HttpStatus.OK)
async purgeStaleRecipient(@CurrentCaller() caller: CallerContext, @Body() dto: PurgeStaleRecipientDto) {
  return this.envelopes.purgeStaleRecipientQueue(
    {userId: caller.claims.sub, deviceId: caller.signalDeviceId},
    dto.supersededIdentity,
  );
}
```

- Guards: controller-level `JwtHttpGuard, UserThrottlerGuard` (`:51`); method-level `RecipientPurgeGuard` (`recipient-purge.guard.ts:42-58`) requires an `X-Mfa-Proof` **action token** — HS256, purpose `recipient_purge`, max age 300 s, audience `bravo-action`, signed with `JWT_ACTION_SECRET` (fail-closed if missing or equal to the access secret, `apps/messenger-service/src/auth/jwt.service.ts:42-60`), cross-checked `action.sub === caller.claims.sub` and `action.deviceId === caller.claims.deviceId` (`:63-69`).
- DTO: `{supersededIdentity: string}` (1–256 chars, `envelope.controller.ts:37-40`).
- Service `envelope.service.ts:425-440` → store `envelope.store.ts:496-523`: deletes the **entire** `pending:{userId}:{deviceId}` Redis ZSET plus each `env:{id}` / `ack_token:{id}` / `submitter:{id}`. **Scoped to the authenticated caller's own (userId, deviceId) queue** — cross-user deletion impossible (spec'd `envelope.service.spec.ts:629-645`). Idempotent. `supersededIdentity` is a possession-proof _hint only_ — the relay can't verify it (outerSealed is opaque; comments `envelope.store.ts:490-494`).
- ⚠️ Media blobs are NOT purged (separate `POST /media/purge`, `media.controller.ts:87`). The claim in `docs/audits/MESSAGING_AUDIT.md:1473` that the purge iterates envelopeIds into `deleteForEnvelope` is a **proposed remediation that was never implemented** — don't trust that doc line.

**Client method** — `packages/messenger-core/src/transport/relayClient.ts:158-168`:

```ts
async purgeStaleRecipientQueue(supersededIdentityB64: string, mfaProofToken?: string): Promise<{purged: number}> {
  return this.request<{purged: number}>('POST', '/envelopes/purge-stale-recipient',
    {supersededIdentity: supersededIdentityB64},
    mfaProofToken ? {'X-Mfa-Proof': mfaProofToken} : undefined);
}
```

⚠️ Only the **messenger-core** copy has this method; the mobile-local `src/modules/messenger/transport/relayClient.ts` does NOT. The runtime uses the messenger-core copy (`productionRuntime.ts:48-56` imports from `@bravo/messenger-core`, instantiated `:408-413`) — wire against that instance.

**Never-throws helper** — `src/modules/messenger/crypto/ownIdentityRotation.ts:64-84`: returns `{result:'purged', count}` / `no-op` (empty identity) / `backend-missing` (404) / `unavailable` (other HTTP/network). **The only importer in the entire repo is its own test** (`src/modules/messenger/__tests__/ownIdentityRotation.test.ts:16` — verified by repo-wide grep). Its header comment claiming the backend "isn't implemented yet" is stale — delete it when wiring.

### 4.2 Why the envelopes are permanently dead (which "rotation" this is)

The **own long-term Signal identity-key regeneration** — fresh install / clear-data where `installIdentity` mints a new keypair and the old private key is gone. NOT signed-prekey rotation, not registrationId per se, not the SQLCipher ownerKey. The outer Sealed-Sender ECIES wrap encrypts to the recipient's identity **public key** and binds it into the AAD (`envelope.store.ts:481-488` documents this), so after rotation every queued envelope fails `outer sealed authentication failed` forever.

Rotation happens at: `installIdentity()` (`packages/messenger-core/src/crypto/identity.ts:32-118`; regenerates at `:83-84` whenever the completion sentinel `:50-59` is missing), wired at `productionRuntime.ts:348`. It becomes server-visible at bundle publish (`productionRuntime.ts:465-469` → `publishOwnBundle` `:3866-3896` → `POST /auth/keys/upload`).

### 4.3 The three gaps (why a call site alone isn't enough)

1. **No call site** — nothing invokes the helper (§4.1).
2. **The client can't detect the rotation.** The server detects it — `apps/auth-service/src/keys/keys.service.ts:83-108` computes `identityRotated = !!prev && !prev.identity_key.equals(incomingIdKey)` and wipes old one-time prekeys — but the response discards it (`keys.service.ts:148`: `return {ok, oneTimeKeysStored, poolSize}`). A reinstalled client has no local copy of the old identity either, so it can neither know a rotation happened nor supply `supersededIdentity`.
3. **No MFA-proof mint flow on mobile.** The only action-token mint path is `POST /auth/biometric/assert` (`apps/auth-service/src/biometric/biometric.controller.ts:14-22` → `biometric.service.ts:38` `signActionToken({sub, deviceId, purpose})`, 5-min expiry). Good: `AssertDto.purpose` is free-form (`assert.dto.ts:6`) so `recipient_purge` works with **zero auth-service change**. Bad: repo-wide grep finds **no mobile code** calling `/auth/biometric/assert` or obtaining a Play Integrity `attestationToken`; TOTP verify does NOT mint action tokens. This client flow must be built (staging can use `BIOMETRIC_DEV_BYPASS`).

### 4.4 Current behavior without the call (the cost)

Dead envelopes are acked-and-dropped **one at a time** during drain — WS path `productionRuntime.ts:4469-4492` ("envelope unwrap failed (will ack to drop)"), HTTP path `:6368-6386` — each costing a pull slot + an unwrapOuter attempt + an ack round-trip. The bootstrap drain after reinstall pulls up to 1000 per page (`:6344-6349`), so the dead backlog is churned before any real message renders (slow first drain, repeated `outer sealed authentication failed` warnings, inflated `noteUndecryptable` counts). If the device never drains, the relay dwell TTLs them out after 30 days (`envelope.service.ts:39-41`; write-time TTL `:193`; 5-min orphan sweep cron `:465-476`). And per Problem 2, each of those senders saw ✓✓.

The purge cannot recover the messages (nothing can) — it removes them in one server call and creates the hook for a "you may have missed messages sent before your reinstall" notice.

### 4.5 Fix — exact wiring steps

1. **Auth-service (do first):** return the rotation signal from `POST /auth/keys/upload`. In `apps/auth-service/src/keys/keys.service.ts`, `identityRotated` is computed at `:88` and discarded; extend the return at `:148` to `{ok, oneTimeKeysStored, poolSize, identityRotated, previousIdentityKey?}` (`prev.identity_key` base64 — public key material, safe to return to the account owner). Mirror the field in the client DTO (`src/modules/messenger/transport/keysClient.ts:68-83`, `uploadBundle` return type).
2. **Call site:** in `buildProductionRuntime`, immediately after `await publishOwnBundle(ownStore, keys, ownAddress)` at `productionRuntime.ts:466` — thread the upload response out of `publishOwnBundle` (`:3884`); when `identityRotated === true`: mint the MFA proof, then `await purgeStaleRecipientQueue(relay, previousIdentityKey, actionToken)` using the `relay` from `:408`. This runs **before** the transport connects and the first `drainRelay` fires (connect callback `:952-964`), so the purge beats the churn. Best-effort by design — the helper never throws.
3. **Restore-path exclusion (critical):** `BackupRestoreScreen` defers the publish (`setDeferBundlePublish(true)`, `productionRuntime.ts:171-182`) and re-publishes the **restored OLD identity** via `publishOwnBundleAfterRestore()` — those queued envelopes ARE decryptable; purging would destroy real messages. The server-driven `identityRotated` flag handles this automatically (restored identity ⇒ `false`) — do NOT wire the purge on a client-side "fresh install" heuristic, and do not wire it unconditionally into `publishOwnBundleAfterRestore` (`:176-182`).
4. **MFA proof mint (the real new build):** client flow calling `POST /auth/biometric/assert` with purpose `recipient_purge` to obtain the 5-min action token. Deployment invariant: `JWT_ACTION_SECRET` must be identical across auth-service and messenger-service containers (same drift class that broke WS auth before — see `memory/messenger-ws-jwt-secret-drift`).
5. **Optional parity:** ops-console has the same dormancy (`apps/ops-console/src/lib/messenger/runtime.ts:389-405`, `installIdentity` at `:394`, never purges).

**Security notes:** scope is already locked server-side to the caller's own `(sub, X-Signal-Device-Id)` queue; do NOT weaken `RecipientPurgeGuard` (it exists because JWT-only auth let a stolen token wipe an inbox — guard header `:16-23`). Known accepted gap: the guard does no single-use jti check, so a proof could replay within its 5-min window (harmless — idempotent purge of own queue — but note it in the arch review). This touches relay envelope semantics + an MFA gate → **architecture sign-off required** per CLAUDE.md before shipping.

### 4.6 Tests

- **Server (exists, green):** `apps/messenger-service/src/relay/envelope.service.spec.ts:542-645` — purge count + empty pull, idempotency, per-device scope, aux-key cleanup, empty-hint rejection, cross-user isolation. Run `cd apps/messenger-service && npm test` (narrow: `npm test -- envelope.service`). **Missing:** no spec for `RecipientPurgeGuard` or the controller (missing/expired/mismatched proof paths untested).
- **Client (exists):** `src/modules/messenger/__tests__/ownIdentityRotation.test.ts` — all outcome modes. Run `npm run test:crypto`.
- **Missing / new:** `identityRotated` field test in `apps/auth-service/src/keys/keys.service.spec.ts`; transport-level test for `RelayHttpClient.purgeStaleRecipientQueue` in `packages/messenger-core/__tests__/`; runtime ordering test (publish → purge → first drain); restore-path test proving NO purge fires after `publishOwnBundleAfterRestore`.

---

---

## 5. Suggested fix order & cross-cutting regression guards

### 5.1 Order

| Wave | What                                                                                                                                                                                           | Why this order                                                                                     | Gate                   |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------- |
| 1    | Problem 1 fixes 1–3 (catch-22 key-request fallback, placeholder conversation on stash, duplicate-`create` row repair) + fix 5 (merge-not-replace upsert)                                       | Client-only, one APK, no protocol change, kills the worst user-visible symptom                     | tests + typecheck only |
| 2    | Problem 2 option (a) — receiver placeholder rows                                                                                                                                               | Client-only, shares the post-txn plumbing wave 1 touches (`:4874-4916`) — do in the same area pass | tests + typecheck      |
| 3    | Ops check: verify deployed `bravo-staging-msgr` includes `4025d6c` (`ssh admin@94.136.184.52`, `docker exec bravo-staging-msgr grep -rl "sendChatWake" dist/relay/` or check image build date) | Without it, all HTTP-submitted envelopes (groups, outbox) still send no wake in production         | ops only               |
| 4    | Problem 3 (purge wiring: auth-service `identityRotated` + call site + MFA mint)                                                                                                                | Needs an auth-service deploy + arch sign-off; independent of waves 1–2                             | **arch sign-off**      |
| 5    | Problem 2 option (c) ack-disposition (or (b) NACK) — honest sender tick                                                                                                                        | Protocol + relay change; present both options to architecture                                      | **arch sign-off**      |
| 6    | Problem 1 fix 4(i) — server-recorded membership backfill                                                                                                                                       | Metadata-posture decision; biggest structural fix for the offline-add case                         | **arch sign-off**      |

### 5.2 Regression guards (things a naive fix will break)

- **Do NOT weaken the B-42 epoch guard** (`productionRuntime.ts:5812-5815`) — the keyless-bootstrap relaxation is deliberately narrow (owner-signed, keyless-state only). `groupCreateEpochBootstrap.test.ts` pins it.
- **Do NOT stop acking failures** to "fix" Problem 2 — unacked poison envelopes redeliver on every connect (`flushPendingOnConnect`) and historically caused infinite loops (`productionRuntime.ts:4542-4551`). The B-30 `LeaveOnRelayError` and cert-refresh-`unavailable` branches are the only sanctioned no-ack paths.
- `adhocCallKeyLookup.test.ts:84` asserts the `name !== 'Call'` gate on the conversation upsert — ad-hoc call groups must NEVER get a Messages-page row. Keep the gate when extracting the upsert helper.
- `upsertConversation` full-replace semantics: fixing it to merge (Problem 1 fix 5) affects every caller — check `createGroupChat` (`:2824`), `ensureAssignedGroup` (`:2998`), dept-chat, and `MessengerHomeScreen` sync (`:148-165`).
- Placeholder rows must be excluded from backup/mirror pipelines or handled idempotently there (see `docs/audits/MSG_BACKUP_AUDIT_2026-07-02.md` — the mirror dedups by version; a placeholder later replaced by the real message must not strand a phantom row in `messages_backup`).
- Any `packages/messenger-core/src/transport/protocol.ts` change must be mirrored in ops-console (own receive path, consumes `@bravo/messenger-core`).
- `logAudit.test.ts` — no new log line may include plaintext, sealed payload contents, or key material (placeholder content strings are fine; the failed envelope's bytes are not).
- Dept-chat rides the same `addGroupMember` (`membershipIntents.ts:64-67`) — re-run `membershipIntents.test.ts` (both copies) and smoke a dept-channel add after wave 1.
- Change-safety gates per CLAUDE.md: `npm run test:crypto` → `npm run typecheck` (baseline 96) → `npm test`; messenger-service: `cd apps/messenger-service && npm test`. Manual smoke after wave 1–2: boot, 1:1 send/receive, group send/receive, add-member while recipient killed.

---

## 6. Command reference

```bash
# from repo root — mobile/messenger-core
npm run test:crypto        # messenger-crypto Jest project (fastest signal; ~1125 tests green baseline)
npm run typecheck          # mobile tsc — must NOT exceed .tsc-baseline.json (96)
npm test                   # full suite, run AFTER the targeted suites

# messenger-service (run inside apps/messenger-service)
npm test                   # gateway + relay unit tests
npm run start:dev

# device verify
npm run apk:staging        # staging APK (remember EXPO_PUBLIC_* staging env injection — see memory/release notes)
```

Staging backend: Contabo `94.136.184.52` (`ssh admin@94.136.184.52`), containers `bravo-staging-msgr` / auth via `docker compose -f docker-compose.staging.yml` — after redeploying only one service, check JWT secret alignment (known drift failure mode).

## 7. Implementation addendum (2026-07-03)

All three problems were implemented the same day by a follow-up session. Owner approval for the two
arch-gated items (ack-disposition one-bit disclosure; MFA-proof wiring) was given via the fix directive.

**Problem 1 (§2) — shipped, client-only:**

- New module `src/modules/messenger/runtime/groupConversationUpsert.ts` — `upsertGroupConversationFromState`
  (single writer, merge-not-replace: unread/mute/pin/custom-name/last_message survive a reshare),
  `upsertKeylessGroupPlaceholder` (visible "syncing" thread on `no_key`/`tamper` stash),
  `resolveKeyRequestTargets` (Seam-C catch-22 fallback to the stash sender).
- `productionRuntime.ts`: `request-group-key` post-txn signal + `GroupKeySignal` now carry `fromPeer`;
  `requestGroupKeyResyncImpl` takes a fallback peer; both stash branches upsert the placeholder + pass the
  sender; the duplicate-`create` early-return repairs a missing row from the locally-trusted state (§2.5 Seam A).
- Tests: `groupConversationUpsert.test.ts` (10).
- NOT implemented (still open, arch-gated): §2.7-4(i) server-recorded membership backfill.

**Problem 2 (§3) — shipped, client + relay (composite (a)+(c)):**

- New module `src/modules/messenger/runtime/decryptFailureSignal.ts` — destroyed-envelope note/take,
  `insertDecryptFailurePlaceholder` (persistent per-thread `system` row, deduped by envelopeId),
  `applyEnvelopeUndeliverable` (sender tick; overrides raced `delivered`, never regresses `read`).
- Receiver: AAD-reject (non-`stale`) and tamper-final branches insert placeholders inside the receive txn;
  recovery give-up + rotation-archived-ratchet drops are noted destroyed; every terminal-failure ack site in
  `handleDeliverInner` + `drainRelay` now sends `disposition: 'discarded'`; seen-dedup re-acks send 'delivered'.
- Protocol: `AckDisposition` + `ServerEnvelopeUndeliverable` in BOTH `packages/messenger-core/src/transport/protocol.ts`
  and `apps/messenger-service/src/gateway/protocol.ts`; `RelayHttpClient.ack(envelopeId, ackToken?, disposition?)`.
- Relay: `envelope.service.ack(..., disposition)` emits `envelope.undeliverable` (+ `undeliverable-pending:{userId}`
  offline queue in `envelope.store.ts`, replayed by `flushPendingDelivered`); HTTP + WS ack entry points sanitize the
  field (anything ≠ 'discarded' ⇒ 'delivered', so legacy clients are unchanged).
- Sender: `MessageStatus` gains `'undelivered'`; ChatScreen renders it as a red alert icon.
- Tests: `decryptFailureSignal.test.ts` (13) + 4 new cases in `envelope.service.spec.ts`.
- Known scope cuts: group/HTTP-submitted sends still have no submitter mapping (MSG-03 — no receipt of either kind);
  unwrap/cert failures (conversation unknown) get the honest disposition but no in-thread placeholder;
  recoverable group stashes intentionally stay 'delivered' (device durably holds them).

**Problem 3 (§4) — shipped end-to-end:**

- auth-service `keys.service.ts` upload response now returns `identityRotated` + `previousIdentityKey`
  (base64 public key, owner-only) — 3 new spec cases incl. the restore-path (same key ⇒ false).
- `keysClient.uploadBundle` return type mirrored in BOTH copies (messenger-core is the live one) +
  new `KeysHttpClient.mintActionToken(purpose)` → `POST /auth/biometric/assert`.
- `productionRuntime.ts` boot publish site: on `identityRotated`, mint the `recipient_purge` proof and call the
  Sprint-6 helper `ownIdentityRotation.purgeStaleRecipientQueue` BEFORE the transport connects/first drain.
  Restore path untouched (`publishOwnBundleAfterRestore` discards the flag; restored identity ⇒ rotated=false).
- ⚠️ Production limitation: mobile has no Play Integrity provider, so the mint only succeeds where
  `BIOMETRIC_DEV_BYPASS=true` (staging — verified set). In production the helper degrades to 'unavailable'
  (= today's behavior: dead envelopes TTL out). The server MFA gate was NOT weakened. Wiring a real
  attestation provider is the remaining follow-up.

**Deployed 2026-07-03:** both `bravo-staging-auth` + `bravo-staging-msgr` rebuilt from source and recreated
together (JWT secrets stay aligned); /ready 200 both; new code grep-verified inside both containers
(`undeliverable-pending`, `envelope.undeliverable`, `previousIdentityKey`). Rollback:
`~/src-bak-delivery-fixes-20260703.tgz` on the box. Wave-3 check: HTTP `sendChatWake` (4025d6c) confirmed
in the deployed controller.

**Gates at ship time:** mobile crypto 1177/1177, full suite 1482 pass, tsc 46 (baseline 49); messenger-service
181/181 + tsc clean; auth keys spec 11/11 (booking-flow/dispatch-room-intents have 3 pre-existing failures,
reproduced on pristine HEAD — unrelated, stale FSM-matrix tests). Ops-console tsc clean.

**Still pending:** multi-device QA (no device was attached): §2.9 device script, ✓✓→undelivered on a forced
decrypt failure, reinstall purge log (`stale-queue purge result=purged`), regression smoke on 1:1 + group send.

## 8. Related documents

- `docs/audits/MESSENGER_FULL_AUDIT_2026-07-02.md` — full 6-slice audit this handoff builds on (MSG-01..-10, PUSH-B1..B4, RELAY-C1).
- `docs/audits/MESSAGING_AUDIT.md` — relay/envelope P0/P1 catalogue (P1-T2 purge scoping).
- `docs/audits/MESSENGER_AUDIT_FIXES.md` — Sprint 6 built the client purge plumbing ("own-rotation purge stub").
- `docs/architecture/SIGNAL_PROTOCOL_IMPLEMENTATION.md` — protocol conformance map (delivery-ACK row cites the exact ack/receipt files).
- `sqa.md` — B-42 (epoch-guard bootstrap fix), device/identity reference for 3-device verification.
