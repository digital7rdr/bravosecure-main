# SRV-04 - handleSfuRing drops conversationId from the group VoIP wake (killed-app group Answer lands with conversationId='')

## Verdict

**CONFIRMED** — the parameter, the wire plumbing, and the tests exist; the single production call site
does not pass it.

- `apps/messenger-service/src/push/push.service.ts:966-972` — the parameter exists and is documented:
  `callKind?: 'voice' | 'video' | 'group-voice' | 'group-video',` then
  `// P1-BR-1 — group-ring conversationId so a killed-app Answer can route` / `conversationId?: string,`.
- Android wire plumbing exists: `push.service.ts:1077` — `...(conversationId ? {conversationId} : {}),`
  inside the data-only FCM block. iOS too: `push.service.ts:1115` passes `conversationId` into
  `sendVoipApns`, which emits it at `push.service.ts:1170`.
- The ONLY production caller of the group wake omits arg 6 —
  `apps/messenger-service/src/gateway/messenger.gateway.ts:1925-1928`:
  `void this.push.sendVoipWake(` / `uid, data.roomId, callerId, roomToken || undefined,` /
  `(data as {callType?: string}).callType === 'video' ? 'group-video' : 'group-voice',` /
  `).catch(() => { /* swallow */ });` — five args, no `data.conversationId`.
- The value is in hand at that line: it is a required field of the frame
  (`apps/messenger-service/src/sfu/sfu.types.ts:186-187` — `/** Conversation that owns this call … */
conversationId: string;`), the client always sends it (`src/modules/messenger/webrtc/useGroupCall.ts:2185,
3891, 3932`), and the same handler already uses it two lines below for the WS frame
  (`messenger.gateway.ts:1907`) and the Redis pending-ring / missed-marker
  (`messenger.gateway.ts:1940, 1951`).
- The tests for the push side already exist and pass with an explicit value —
  `apps/messenger-service/src/push/push-chat-wake.spec.ts:185`:
  `await push.sendVoipWake('u1', 'call-1', 'sender-a', 'room-tok', 'group-voice', 'grp:c-9');`
  So the feature is fully built and merely unwired; nothing about the fix is speculative.

## Mechanism

1. Host taps call in a group → client `POST /sfu/rooms`, joins, then emits `sfu.ring` with
   `{roomId, conversationId, callType, callerName, recipientUserIds}` (`useGroupCall.ts:2183-2189`).
2. `handleSfuRing` (`messenger.gateway.ts:1844`) host-checks, block-filters, mints a per-recipient
   room token, and for each target does three things:
   - emits `sfu.ring.incoming` **with** `conversationId` (line 1907) — correct;
   - queues `PendingGroupRing` + `MissedGroupCallMarker` **with** `conversationId` (lines 1940, 1951) — correct;
   - fires `sendVoipWake(...)` **without** `conversationId` (line 1925) — the defect.
3. For a target whose app is killed/Dozed, only path 3 reaches the device. `push.service.ts:1077`
   spreads `...(conversationId ? {conversationId} : {})` — `undefined` ⇒ the key is simply absent from
   the FCM `data` map (and from the APNs body at `:1170`).
4. Device side reads it defensively and gets `undefined`:
   - killed app: `src/modules/messenger/push/fcmHeadless.ts:132`
     `const conversationId = typeof data.conversationId === 'string' ? data.conversationId : undefined;`
     → `showIncomingCallNotif({… conversationId, …})` (`:134-142`) → notifee `data.conversationId` never set
     (`src/modules/messenger/push/callNotification.ts:367` — `if (p.conversationId) {data.conversationId = …}`).
   - backgrounded JS-alive app: same at `src/modules/messenger/push/fcmBootstrap.ts:1492`, cached into
     `incomingCallCache` (`:1493-1501`) with `conversationId: undefined`.
5. User taps Answer. Both answer paths substitute an empty string:
   - notifee tap → `fcmBootstrap.ts:1171` — `conversationId: data.conversationId ?? '',`
   - Telecom/CallKit Answer → `fcmBootstrap.ts:639` — `conversationId: payload.conversationId ?? '',`
     (inside `navigateToIncomingCall`) — so **both Android and iOS**, as the audit says.
6. `IncomingGroupCallScreen` mounts with `conversationId === ''`
   (`src/screens/messenger/IncomingGroupCallScreen.tsx:50`). Consequences:
   - `const convoForRoom = useMessengerStore(s => s.conversations[conversationId]);` (`:148`) →
     `conversations['']` → `undefined` → `recipientUserIds = [fromUserId]` (`:149-150`), i.e. the roster
     collapses to "the host only".
   - `appendMissedGroupCallBubble({conversationId: '', callType})` on cancel / no-answer / roomMissing
     (`:101, 127, 167, 186, 219`) → the missed-group-call record is filed against a non-existent thread.
   - `navigation.replace('GroupCallScreen', {conversationId: '', …})` (`:194-208`).
7. Worst consequence — the SFrame key lookup fails for **real named groups**.
   `useGroupCall.ts:1467` reads `g[opts.conversationId]?.owner` → `undefined`;
   `:1482` `isAdHocCall = ''.startsWith('direct:')` → `false`;
   `:1490` `g['']?.masterKeyB64` → `undefined`; the only remaining slot is
   `directLookupId = 'direct:' + hostUserId` (`:1454`), where a **real** group key is never filed
   (`:1445-1446` — "real named group: filed ONLY under the real `conversationId` … NO `direct:<host>`
   alias is ever created"). So `resolveKeyId()` returns `undefined`, `hasKey()` is false, the joiner
   sits in the benign wait window and then fail-closes → "Call failed" ~25 s later. Ad-hoc escalated
   1:1 calls survive by accident because their key really does live under `direct:<host>`.
8. There is no self-heal: the WS `sfu.ring.incoming` replayed on reconnect
   (`messenger.gateway.ts:671-679`, correct `conversationId`) is suppressed by
   `MainNavigator.tsx:734` → `shouldNavigateForRing(...)`, which returns `false` when the current route
   is already `IncomingGroupCallScreen` with the same `roomId`
   (`src/modules/messenger/runtime/groupCallRegistry.ts:150-156`). The empty id is therefore permanent
   for the life of that call.

## Fix

One file, one statement. No client change, no schema change, no wire-format change (the field is
already defined, already emitted when present, already parsed by shipped clients).

### `apps/messenger-service/src/gateway/messenger.gateway.ts`

Anchor (verbatim, unique — the 1:1 site at `:1290` passes `data.to.userId`):

```ts
void this.push
  .sendVoipWake(
    uid,
    data.roomId,
    callerId,
    roomToken || undefined,
    (data as {callType?: string}).callType === 'video' ? 'group-video' : 'group-voice',
  )
  .catch(() => {
    /* swallow */
  });
```

Replacement:

```ts
void this.push
  .sendVoipWake(
    uid,
    data.roomId,
    callerId,
    roomToken || undefined,
    (data as {callType?: string}).callType === 'video' ? 'group-video' : 'group-voice',
    convHint,
  )
  .catch(() => {
    /* swallow */
  });
```

and, immediately above the `for (const uid of targets) {` loop (anchor:
`    for (const uid of targets) {`), insert the bound:

```ts
    // Why: SRV-04 — the wake's conversationId is client-supplied and lands in a
    // 4KB FCM/APNs payload; an oversize value would fail the whole wake (the WS
    // frame + pending-ring copies are unaffected). 128 chars matches the frame
    // bound used elsewhere in this gateway.
    const convHint =
      typeof data.conversationId === 'string' && data.conversationId.length > 0 && data.conversationId.length <= 128
        ? data.conversationId
        : undefined;

    for (const uid of targets) {
```

Notes on the guard: it is optional insurance, not the defect. Group conversation ids are server UUIDs
(or `direct:<uuid>`), far under 128; the same 128-char shape is already used at
`messenger.gateway.ts:2779` and a 64-char one at `:1029`. If a reviewer prefers the true one-liner,
`data.conversationId` may be passed directly — the failure mode it guards against (a malicious/buggy
host shipping a multi-KB `conversationId`, turning a currently-successful VoIP wake into a
`messaging/payload-size-limit-exceeded` per-message failure) is then live. It does **not** cause token
GC: `push.service.ts:1363-1364` only drops tokens on
`registration-token-not-registered` / `invalid-registration-token`.

### Back-compat

- **Old clients ← new server:** additive `data` key on FCM/APNs. Every shipped reader already handles
  it (`fcmHeadless.ts:132`, `fcmBootstrap.ts:1492`) and ignores it if not understood. The HMAC canonical
  form is unchanged (`kind|callId|nonce|exp`, `push.service.ts:1052`) — `conversationId` rides
  **unsigned**, exactly as `fromUserId`/`callKind`/`roomToken` do, so old APKs keep verifying. The
  existing regression test for this is `push-chat-wake.spec.ts:192-196`.
- **New clients ← old server:** unchanged behaviour (today's behaviour) — the `?? ''` fallbacks stay.
- **1:1 path:** untouched; `messenger.gateway.ts:1290` still passes 5 args, and
  `push-chat-wake.spec.ts:199-210` asserts `conversationId` is absent from the wire when omitted.
- No SQLCipher/outbox schema version bump (no client persistence touched), no Redis key or payload
  change (`PendingGroupRing`/`MissedGroupCallMarker` already carry `conversationId`).

### Architecture note (read before merging, but not a blocker)

Putting a group conversation id in an FCM/APNs `data` block widens what the push provider sees; the
architecture docs grade cleartext `conversationId` on FCM as "below the project's own opacity bar".
This exposure was already decided and implemented for exactly this purpose: `push.service.ts:957-972`
records the §5-parity relaxation of audit P1-N2 (Ranak-approved 2026-07-05) and the P1-BR-1
`conversationId` param, and `push-chat-wake.spec.ts:178` locks it in. This change activates an
approved-but-unwired field rather than introducing a new disclosure; the sealed-sender envelope shape,
sender-cert verification, AAD binding, group master-key distribution, epoch handling, dwell semantics
and the vault MFA gate are all untouched. If the architecture owner wants to revisit push-provider
visibility of group ids, the correct action is deleting the parameter everywhere (client + server +
tests), not leaving the ring half-wired.

## Blast radius

- **Changed:** `MessengerGateway.handleSfuRing` only. No signature change anywhere; `sendVoipWake`'s
  6th parameter is already optional and already typed.
- **Callers of `sendVoipWake`:** two production sites — `messenger.gateway.ts:1290` (1:1, unchanged)
  and `:1925` (this fix). Test doubles: `messenger.gateway.calls.spec.ts:51, 410-414`,
  `messenger.gateway.sfu-auth.spec.ts:52`. All are `jest.fn`/arrow mocks that tolerate an extra arg;
  only the assertion helper at `:411` needs updating to _observe_ it.
- **Downstream behaviour that changes (all improvements, all already-written code paths):**
  `fcmHeadless.ts:132` → `callNotification.showIncomingCallNotif` → notifee `data.conversationId`;
  `fcmBootstrap.ts:1492` → `incomingCallCache`; both answer navigations (`fcmBootstrap.ts:639, 1171`)
  now receive a real id; `IncomingGroupCallScreen` roster/missed-bubble/`GroupCallScreen` handoff;
  `useGroupCall` key-slot resolution.
- **Overlapping findings:** anything else editing `handleSfuRing` (ring/block/rate-limit work) or the
  group-ring VoIP wake — e.g. SRV-03 (connect-time drain of pending offers/rings) touches
  `deliverPendingGroupRing` in the same file but a different function, and SRV-02 (persisted ringing
  state) would touch the same loop. Sequence this one first; it is a 1-2 line diff.
- **What could regress:**
  1. `data.conversationId` is client-controlled; with the guard it cannot break the wake, without it
     an oversize value can (see above).
  2. Group decline from a killed app now sends a non-empty `conversationId` in `sfu.ring.decline`
     (`fcmBootstrap.ts:1071`). Check the server's decline handler tolerates a real id — it authorises
     on `roomToken` + roomId (`messenger.gateway.ts:1996+`), so this is a no-op, but assert it.
  3. Notifee ids are partly conversation-keyed (`callNotification.ts:185-186` for msg-wake, not for
     call-wake), so call-notif dedupe (`bravo-call-${callId}`) is unaffected — confirm no id collision.

## Tests

Jest project: the messenger-service suite (`cd apps/messenger-service && npm test`). Follow the
existing `apps/messenger-service/src/gateway/*.spec.ts` layout — no new file needed.

1. `apps/messenger-service/src/gateway/messenger.gateway.calls.spec.ts`
   - Extend the shared `makeGateway` recorder so the wake's conversation hint is observable:
     ```ts
     const wakes: Array<{uid: string; kind?: string; conversationId?: string}> = [];
     const push = {
       sendVoipWake: jest.fn(
         async (
           uid: string,
           _cid: string,
           _from: string,
           _tok?: string,
           kind?: string,
           conversationId?: string,
         ) => {
           wakes.push({uid, kind, conversationId});
           return {sent: 1, stubbed: false};
         },
       ),
       sendCallCancel: jest.fn(async () => 0),
     };
     ```
   - New `describe('SRV-04 — group VoIP wake carries the ring conversationId', …)`:
     - rings `{roomId: 'room-aaa', conversationId: 'conv-1', callType: 'video', callerName: 'Host',
recipientUserIds: ['user-ok']}` from the host → assert
       `expect(wakes).toEqual([{uid: 'user-ok', kind: 'group-video', conversationId: 'conv-1'}])`, and
       `expect(push.sendVoipWake.mock.calls[0][5]).toBe('conv-1')` (positional — this is the exact
       regression: an arity slip must fail).
     - assert parity with the WS frame: the emitted `sfu.ring.incoming` payload's `conversationId`
       equals the wake's 6th arg.
     - fan-out: two targets → both wakes carry `'conv-1'`.
     - guard (only if the 128-char bound is implemented): `conversationId: 'x'.repeat(200)` → wake's
       6th arg is `undefined` while the `sfu.ring.incoming` frame still carries the full value
       (the WS path is deliberately unchanged).
   - Regression guard for the 1:1 lane: the existing
     `expect(push.sendVoipWake).toHaveBeenCalledWith(PEER, 'call-0001', ME, undefined, 'video')`
     (`:96, 102, 106`) must stay green — `handleCallOffer` still passes 5 args.
2. `apps/messenger-service/src/push/push-chat-wake.spec.ts` — no change; `:178-210` already pin the
   wire shape and the unchanged HMAC canonical form. Re-run as the regression suite.
3. `apps/messenger-service/src/gateway/messenger.gateway.sfu-auth.spec.ts` — no change; re-run
   (host-check / cancel / decline gates must stay green).
4. Optional client-side coverage (jest project `app`): none of `fcmBootstrap`/`fcmHeadless` has an
   existing spec; do **not** add one here — it would be a new harness for a server-side one-liner.
   Cover it on-device instead (§ Risk).
5. Gates: `cd apps/messenger-service && npm test`, then repo-root `npm run typecheck`
   (baseline 47, must not increase). No crypto-suite impact, but `npm run test:crypto` is cheap
   insurance since the change sits next to the group-call key path.

## Risk

- **Reviewer suspicion #1 — arity.** The whole bug is a positional-argument slip in a 6-param
  function with 3 optional trailing params. A reviewer should insist on the _positional_ assertion
  (`mock.calls[0][5]`), not just a `toHaveBeenCalledWith(...)` that a future param insertion would
  silently satisfy. Consider that the real long-term fix is an options object for `sendVoipWake` —
  but that is a drive-by refactor with 2 production + 4 test call sites and is out of scope here.
- **Reviewer suspicion #2 — is this really enough?** It fixes the _push_ lane. It does not fix the
  suppression at `groupCallRegistry.shouldNavigateForRing` that makes a wrong `conversationId`
  unrecoverable even when the correct WS ring arrives seconds later. That latent hole survives this
  fix (it just stops being reachable via the wake). If a follow-up is wanted, the smallest correct
  increment is: when `shouldNavigateForRing` returns `false` because the same-room ring screen is
  already mounted, `setParams` the missing/empty `conversationId`/`roomToken` from the WS frame
  instead of dropping the frame entirely. That is a separate, client-side, testable change — file it,
  do not bundle it.
- **Reviewer suspicion #3 — privacy.** See the architecture note: this puts a group id on the FCM/APNs
  wire. Already approved and already implemented/tested in `push.service.ts`; but it _is_ the kind of
  line the architecture doc calls out, so it deserves an explicit "yes, still approved" rather than
  silent merge.
- **Reviewer suspicion #4 — untestable-by-unit-test payoff.** The user-visible win (killed-app Answer
  on a REAL named group actually keys the FrameCryptor instead of timing out at ~25 s) is only
  provable on device. Device probe: two accounts in a real named group (not an escalated 1:1), force-stop
  the callee app, host starts a group call, callee taps Answer from the lock screen → expect media,
  and expect `[bravo.groupcall.boot] step=3a` to resolve a key slot equal to the real conversation id,
  not a `direct:` alias. Verify the ad-hoc escalated-1:1 case still works (it passed _by accident_
  before this change and must keep passing after).
- **Deploy order.** Server-only; the server deploys ahead of clients by design and every shipped
  client already parses the field. No coordinated release needed.
