# Mission Ops Room — client invisibility, keyless members, delete-on-completion

**Date:** 2026-07-24 · **Status:** PLAN ONLY — no code changed this session
**Reported by founder:** (1) client never sees the mission messenger group after the
agency accepts + crews a bodyguard booking; (2) the agency's CPO manager HAS the
group but cannot message, voice-call, or video-call in it; (3) when the mission
completes the group must **DELETE itself for everyone** (founder explicitly said
_delete the whole group, not archive_).
**Constraint from founder:** use the existing messenger features only — seat/intent/
drain/self-heal/prune already exist; this plan only rewires them, no new crypto.
**sqa.md:** logged as **B-205** (regression test owed with the fix, per the B-143+ contract).

> ⚠️ Line numbers below were verified 2026-07-24 on `fix/messenger-audit-b121`
> @ `d78e06b`. They go stale fast — **re-grep the symbol, never trust a stamped line.**

---

## 0. TL;DR for the implementer

| #   | Symptom                                          | Root cause (short)                                                                                                                                                                                                                                                                                                                     | Fix (short)                                                                                                                                                                                                                           |
| --- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Client doesn't see the group                     | Client is seated only on FIRST room creation; `ensureRoomMembers` re-seats crew+managers but **never the client**, and the whole seating block is best-effort with no retry. Plus: the B-191/B-192 server fixes are **not deployed** to Contabo.                                                                                       | **Deploy first** (§5). Then: include the client in `ensureRoomMembers`, and give the client a `dispatch_room_intents` add-intent so key delivery is retried like the CPOs'.                                                           |
| 2   | CPO manager sees group, can't message/call/video | Manager is a **metadata** member (server roster) but **keyless** (`masterKeyB64` missing). The key only arrives when the agency _company_ device drains intents — and that drain runs from exactly ONE place (`AgentDashboardScreen` mount). The self-heal reshare silently drops requesters not yet in the owner's **crypto** roster. | Widen the drain triggers on the agency device; bridge inbound `key-request` → re-drain pending intents (server-authorized). Calls need **no separate fix** — every call guard is "no key ⇒ refuse", so they clear when the key lands. |
| 3   | Group must dissolve on completion                | Archive-on-completion (B-191) exists but is **undeployed**, and it archives — founder wants **hard delete**. A delete pattern already exists in `SettlementService`.                                                                                                                                                                   | Replace the archive call with a shared hard-delete (conversation + members + intents + broadcasts), called from all three completion paths; make the later settlement delete a no-op when the room is already gone.                   |

**Order of work:** §5 deploy-state probe → server fixes (S1–S4) → mobile fixes (M1–M2)
→ deploy → §7 verification loop.

---

## 1. How the flow works today (verified, file:line)

1. **Agency accepts the Lite offer** — `DispatchService.accept`
   (`apps/auth-service/src/dispatch/dispatch.service.ts:1082`) flips
   `DISPATCHING → CONFIRMED`. **No room exists yet** — the code comments that the
   Ops Room opens at crew-assign, where the mission row finally exists.
2. **Agency assigns crew** — `POST org/bookings/:bookingId/crew`
   (`apps/auth-service/src/org/org.controller.ts:93-101`) →
   `OrgMissionService.assignCrew` (`apps/auth-service/src/org/org-mission.service.ts:327`).
   After the mission txn commits, a **best-effort** block at `:498-542`:
   - `SystemMessengerService.createMissionOpsRoom`
     (`apps/auth-service/src/ops/system-messenger.service.ts:160-217`) creates the
     `conversations` row (kind `group`), seats **agency = admin, client = member**
     (`:181-185`), and writes the id to `missions.comms_channel_id` +
     `lite_bookings.conversation_id`. **Short-circuits if `comms_channel_id` is
     already set** (`:173-179`).
   - `ensureRoomMembers` (`system-messenger.service.ts:266-277`, called at
     `org-mission.service.ts:527-536`) seats **crew + active managers** as metadata
     members — _"METADATA ONLY — grants no group key"_. **The client is excluded.**
   - `enqueueRoomIntent` (`apps/auth-service/src/dispatch/dispatch-room-intents.service.ts:37-59`)
     queues one add-intent **per CPO/manager**. **The client gets no intent.**
     _(The seating + intent halves are the B-192 fix, landed `bd87f62` 2026-07-23 —
     flagged ⚠️ SERVER in sqa.md, i.e. dead until the Contabo redeploy.)_
3. **The key exists only after the agency device drains** —
   `drainDispatchRoomIntents` (`src/modules/messenger/orgWorkspace/dispatchRoomIntents.ts:28-95`)
   is called from **exactly one place**: `AgentDashboardScreen.tsx:204-206`, gated
   on `agent.type === 'company'`. It early-returns when there are zero pending
   intents (`:32`), bootstraps the group via `ensureAssignedGroup`
   (`src/modules/messenger/runtime/productionRuntime.ts:4401-4503`) with the
   **client as sole initial member** (`dispatchRoomIntents.ts:53`) — minting the
   master key (owner = agency) and fanning a signed `admin:create` (key inside)
   over pairwise Signal — then runs `addGroupMember` per intent (add + rekey) and
   acks. `ensureAssignedGroup` short-circuits once the agency holds the key
   (`:4404-4406`), so **the client's create fan-out is one-shot, never re-sent**.
4. **How members see the room** — two lanes:
   - Server reconciliation: `MessengerHomeScreen.tsx:168-250` upserts every
     conversation `listMine` returns (membership-joined,
     `apps/auth-service/src/conversations/conversations.service.ts:83-95`, filters
     `archived_at IS NULL`) and **prunes** any local UUID room the server stops
     returning (`:238-246`).
   - Crypto: the received `admin:create` / add-rekey installs `GroupState` and
     upserts the thread.
5. **Keyless member behaviour** — with no `masterKeyB64`: composer disabled
   (`ChatScreen.tsx:311-314` → `groupSendBlockedReason`,
   `src/modules/messenger/runtime/messagingLogic.ts:268-278`), text/media send
   fail-closed (`productionRuntime.ts:2875-2886`, `:3748-3758`), group call join
   refuses after a 25 s key wait (`src/modules/messenger/webrtc/useGroupCall.ts:1594-1635`),
   hosting a non-owned keyless group refuses (`ensureCallGroupKey`,
   `productionRuntime.ts:5114-5131`). Self-heal: `requestGroupKeyResyncImpl`
   (`productionRuntime.ts:2498-2538`, 20 s cooldown) → owner answers via
   `reshareGroupKeyState` (`:2370-2439`) — **but the roster gate at `:2388-2389`
   silently drops any requester not in the owner's crypto `members` map.** A
   manager whose add-intent never drained is exactly that requester: blocked
   forever, no error anywhere.
6. **Completion today** — `completeMissionCore`
   (`apps/auth-service/src/agents/agent.service.ts:1531`, archive at `:1596-1607`),
   ops-console complete (`apps/auth-service/src/ops/mission.service.ts:394-426`,
   archive `:413-415`), abort (`:606-608`) all set `archived_at` (B-191, also
   undeployed). Hard delete happens only ~3 days later in
   `SettlementService.settleEscrowRelease`
   (`apps/auth-service/src/settlement/settlement.service.ts:139-153`): SET NULL
   back-refs, then `DELETE FROM dispatch_room_intents / conversation_members /
system_broadcasts / conversations`.
7. **Facts that bound the design** (from the trace):
   - The relay and SFU are **group-blind** — no roster, no `registerGroup`, no
     membership check on send or call
     (`apps/messenger-service/src/relay/envelope.controller.ts:47-64`,
     `sfu/sfu.controller.ts:71`). Every block in symptom 2 is client-side key state.
   - There is **no disband/delete group wire message** — the only teardown
     control messages are per-member `remove` (admin) and self `leave`
     (`packages/messenger-core/src/groups/types.ts:99-138`). Thread removal on
     devices is driven purely by server-list reconciliation + prune.
   - `blockReasonForOutgoingCall` explicitly allows groups/ops_channels for agents
     (`src/modules/messenger/webrtc/callRoleGate.ts:20-29`) — the role gate is NOT
     the call blocker here.

---

## 2. Fix 1 — client never sees the group

### Diagnose first (5 min, read-only SQL on staging Postgres)

For the reported booking/mission:

```sql
SELECT m.id, m.comms_channel_id, b.conversation_id, b.client_id
FROM missions m JOIN lite_bookings b ON b.id = m.booking_id
WHERE b.id = '<booking-id>';

SELECT user_id, role FROM conversation_members WHERE conversation_id = '<comms_channel_id>';
SELECT target_user_id, intent, status FROM dispatch_room_intents WHERE conversation_id = '<comms_channel_id>';
```

- **No client row in `conversation_members`** → server-side seating failed
  (short-circuited creation, best-effort block died, or pre-fix code deployed) —
  fixes S1+S2 below.
- **Client row exists but the client app still shows nothing** → client-side; check
  whether `listMine` returns the room for the client's JWT, then the
  `MessengerHomeScreen` upsert path. (A keyless room should still LIST — it shows
  with a disabled composer — so "not in the list at all" almost certainly means
  "not in `listMine`".)

### Fix (server, small)

- **S1 — seat the client on every crew-assign, not just first creation.**
  `org-mission.service.ts:527-536` builds
  `roomMembers = [...crewIds, ...managers]` — add `result.clientId` (it is already
  SELECTed at `:340-353`). `ensureRoomMembers` is idempotent
  (`ON CONFLICT DO NOTHING`-style seating), so this closes every "room existed
  before the client was seated" and "best-effort block failed once" hole.
- **S2 — give the client a retried key path: enqueue a client add-intent.**
  In the same loop that enqueues crew/manager intents
  (`org-mission.service.ts:537-539`), also enqueue `result.clientId`. Today the
  client's key delivery is a **one-shot** create fan-out from the agency device
  (§1.3); every other member has at-least-once delivery via the intent queue. With
  an intent, the existing drain (`dispatchRoomIntents.ts:62-93`) retries
  `addGroupMember(client)` until ack — no mobile change needed.
  - _Idempotence note:_ the drain may now `addGroupMember` a user who is already a
    crypto member (client was the initial member of `makeAssignedGroup`). Check
    `addGroupMember`/`planAddAndRekey` behaviour for an existing member — if it
    rekeys, that's harmless but noisy; prefer ack-without-rekey when
    `state.members[target]` already exists AND the state epoch has advanced past
    create. Keep it minimal; do not touch the rekey logic itself.

No client-app change is required for visibility: once seated, `listMine` returns
the room and the existing `MessengerHomeScreen` sweep upserts it; once the intent
drains, the existing add-rekey delivers the key.

---

## 3. Fix 2 — manager sees the group but can't message / call / video

The manager is seated (metadata) but keyless. Everything — composer, text, media,
voice, video — is the **same missing `masterKeyB64`** behind five independent
fail-closed guards (§1.5). Fix key delivery and all five clear at once.

### Diagnose first

- Same SQL as §2: does the manager have a `dispatch_room_intents` row, and is it
  `pending` or acked?
- If **pending** → the agency company device never drained (dashboard not opened /
  drain failed) → M1.
- If **acked** but the manager is still keyless → the add fan-out leg to the
  manager was lost after ack (offline > relay dwell, session failure) and the
  self-heal is being roster-dropped → M2.
- Rule out the build gate once: group call buttons dead with a **key present**
  means `frameCryptorOrchestratorAvailable()` is false on that build
  (`src/modules/messenger/webrtc/launchCall.ts:218-226` alerts "Group calls not
  available yet") — a different problem, not this plan.

### Fix (mobile, agency-device side — the room owner is the only key authority)

- **M1 — widen the drain triggers.** `drainDispatchRoomIntents` runs only on
  `AgentDashboardScreen` mount (`:204-206`). Add, for `agent.type === 'company'`
  only: (a) on messenger WS connect — hook where `requestGroupKeyResyncImpl` is
  already fired on connect (`productionRuntime.ts:1324`) or the runtime-ready
  callback the dashboard uses; (b) on `MessengerHomeScreen` focus. Both are plain
  imports of the existing exported function — no new mechanism. Keep the existing
  ack/pending retry semantics untouched.
- **M2 — bridge `key-request` → intent re-drain (do NOT weaken the roster gate).**
  Today an owner receiving a `key-request` from a non-crypto-member silently drops
  it (`reshareGroupKeyState` filter, `productionRuntime.ts:2388-2389`). Keep that
  filter exactly as is. Instead, in the signal handler where the owner decides
  `canReshare` (`productionRuntime.ts:2591-2609`), when the requester is NOT in
  `state.members`, fire `drainDispatchRoomIntents()` (debounced; company accounts
  only). The server intent queue stays the single source of authorization — the
  key still only flows through the already-trusted `addGroupMember` path for users
  the server seated. Result: a keyless manager's own 20 s-cooldown key-request
  becomes the retry trigger, even if the dashboard was never opened.
  - ⚠️ This touches group-key distribution **triggering** (not the crypto, not the
    gate). Per CLAUDE.md stop-conditions, get an architecture nod before
    implementing; the claim to defend is "no new key-flow authority — only a new
    trigger for an existing authorized flow".
- **Calls:** no separate work. `useGroupCall` already fires
  `requestGroupKeyResync` and waits 25 s (`:1594-1635`); with M1+M2 the key
  arrives and the join proceeds. Do not touch the fail-closed guards.

---

## 4. Fix 3 — DELETE the group when the mission completes (founder: not archive)

B-191 (undeployed) archives. Founder's instruction 2026-07-24: **delete the whole
group for everyone.** The delete pattern already exists — reuse it.

- **S3 — shared hard-delete primitive.** Lift the settlement delete block
  (`settlement.service.ts:139-153`) into `SystemMessengerService` (e.g.
  `deleteMissionRoom(conversationId, reason)`): SET NULL
  `lite_bookings.conversation_id` + `missions.comms_channel_id`, then delete
  `dispatch_room_intents`, `conversation_members`, `system_broadcasts`,
  `conversations` — in that order, one txn. Deleting the **intents is load-bearing**:
  a leftover pending add-intent would make a later agency drain re-mint a ghost
  room for a dead conversation.
- **S4 — call it at every completion boundary**, replacing the B-191 archive
  calls: `completeMissionCore` (`agent.service.ts:1596-1607`), ops-console
  `complete()` (`ops/mission.service.ts:413-415`), and abort (`:606-608`,
  reason-suffixed). Make `settleEscrowRelease` tolerate an already-deleted room
  (its SET NULL + deletes become no-ops). Decide consciously about
  `ops.service.ts` legacy `completeBooking` (`:1448-1477`) which today keeps the
  room visible to ops — with a hard delete that path should either adopt S3 or be
  left as-is and documented.
- **Propagation needs nothing new:** `listMine` stops returning the room (row
  gone), and the existing `MessengerHomeScreen` prune (`:238-246`) removes the
  local thread on **every member's** next sweep — client, agency, manager, CPO.
  Verify the prune also clears local crypto state
  (`removeGroupState`, `src/modules/messenger/store/messengerStore.ts:356`) — if
  it only calls `removeConversation` (`:300`), add the group-state cleanup on the
  prune path for UUID group rooms so the master key doesn't linger.
- **Known trade-offs to state in the PR** (founder decision, not blockers):
  - Deleting `system_broadcasts` + the room removes the ops/audit trail B-191
    deliberately kept, and closes the client↔agency channel during the 3-day
    dispute window (settlement's delete existed precisely because disputes may
    need it). If disputes matter, the dispute lane must live elsewhere.
  - There is **no crypto disband message** — devices offline at delete-time keep
    their local copy until their next reconciliation sweep. That is the same
    propagation model the archive used; adding a wire-level disband is
    arch-gated — do not invent one for this task.

---

## 5. Step 0 — deployment reality check (do this before touching code)

The whole B-186..B-198 + B-199..B-204 server batch is flagged **⚠️ SERVER —
needs the Contabo redeploy**, and CI deploy is dead (`CONTABO_SSH_KEY` secret
missing → `deploy-staging.yml` never fires; manual tar-over-ssh each time). If the
box still runs pre-`bd87f62` code, then TODAY: managers/CPOs have **no membership
row at all** and nothing archives on completion — i.e. two of the three reported
symptoms may be (partly) already-fixed-but-undeployed.

1. Probe the box (§2 SQL on a fresh test booking) — if `ensureRoomMembers` rows
   are absent, the deploy is owed.
2. Deploy auth-service via the established tar-over-ssh sync, then re-run the
   probe and a fresh booking round before writing any new code — re-test the three
   symptoms so the new work targets only what is still broken.

---

## 6. Work-item checklist (suggested commit order)

| ID  | Side   | Change                                                               | Files                                                                                     |
| --- | ------ | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| S0  | ops    | Deploy current auth-service to Contabo; re-verify symptoms           | —                                                                                         |
| S1  | server | Seat client in `ensureRoomMembers` set                               | `org-mission.service.ts` (~:527-536)                                                      |
| S2  | server | Enqueue client add-intent                                            | `org-mission.service.ts` (~:537-539); drain idempotence check in `dispatchRoomIntents.ts` |
| S3  | server | `deleteMissionRoom` shared primitive (from settlement block)         | `system-messenger.service.ts`, `settlement.service.ts`                                    |
| S4  | server | Replace archive with delete at all completion boundaries             | `agent.service.ts`, `ops/mission.service.ts`                                              |
| M1  | mobile | Drain on WS-connect + MessengerHome focus (company only)             | `dispatchRoomIntents.ts` callers, `AgentDashboardScreen.tsx`, `MessengerHomeScreen.tsx`   |
| M2  | mobile | key-request from non-member → debounced re-drain (⚠️ arch nod first) | `productionRuntime.ts` (~:2591-2609)                                                      |
| M3  | mobile | Prune path clears `GroupState` for deleted UUID rooms                | `MessengerHomeScreen.tsx` (~:238-246), `messengerStore.ts`                                |
| T1  | tests  | Regression tests for B-205 (see §7); auth-service specs for S1-S4    | —                                                                                         |

---

## 7. Verification loop (do not sign off without this)

This change sits inside the Lite booking module **and** the messenger folder —
both runbooks apply: `docs/runbooks/LITE_BOOKING_LOOP.md` (baseline before, §7
sign-off after) and the messenger regression gate.

- **Gates:** `npx jest --selectProjects messenger-crypto` — **twice** (B-126/B-153
  flake rule: one red run is not evidence); `npm test -- --selectProjects=booking`;
  auth-service `npm test` from `apps/auth-service`; both typecheck baselines
  (mobile ≤ 47, ops 0).
- **New tests owed (B-205, RED-first / DOCUMENTS-B-205 style):**
  - auth-service spec: crew-assign seats client+crew+managers AND enqueues a
    client intent; completion deletes conversation + members + intents +
    broadcasts; settlement no-ops on an already-deleted room.
  - messenger static/unit: drain triggered on key-request-from-non-member
    (M2), prune clears group state (M3).
- **Device matrix (BlueStacks 5555 client / 5565 agency / 5575 CPO-manager):**
  1. Client books → agency accepts → assigns crew.
  2. **All three** devices show the room in the messenger list (client included).
  3. Manager sends text ✓, voice note ✓, starts group voice call ✓, video ✓ —
     with the agency dashboard **never opened** after seating (proves M1/M2).
  4. Kill the agency app before crew-assign, reopen later → manager/client still
     converge to keyed (retried intents).
  5. CPO finishes the mission → room disappears on **all three** devices on next
     messenger-home visit; SQL shows conversations/members/intents rows GONE.
  6. Regression: 1:1 chat, an ordinary (non-mission) group, and a dept channel
     still send/call normally (the drain + prune changes must not touch them).
- **SQL probes** are in §2; re-run after each lane.

## 8. Security stop-conditions (from CLAUDE.md — verify before implementing)

- Do **not** weaken `reshareGroupKeyState`'s roster gate, `decideGroupCreate`, or
  any "no key ⇒ refuse" call guard — the fixes are new _triggers_ for existing
  authorized flows, never bypasses.
- No group key material may ever be held or logged server-side; the relay stays
  group-blind (no roster, no registerGroup).
- M2 (key-request → drain) and any idea of a wire-level disband touch group
  master-key distribution semantics → **arch-gated**: check the System
  Architecture Documentation / get an explicit nod before coding.
