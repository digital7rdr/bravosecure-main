# OR-3 - Killed-app msg-wake never fetches content (by design) and the iOS banner lane is a total blackout

## Verdict

**CONFIRMED** — both halves. The Android half is real _and deliberate_; the iOS half is an
unqualified blackout that the server already pays for.

1. Killed-app msg-wake draws a banner and returns — no pull, no decrypt, no state change:
   `src/modules/messenger/push/fcmHeadless.ts:150-201`
   ```ts
   if (kind === 'msg-wake') {
     // ... We deliberately do
     // NOT boot the messenger runtime / libsignal / SQLCipher / WS here — that 2nd-VM contention is
     // why the headless task was removed. The decrypted content lands when the app foregrounds and
     // the WS reconnects; tapping this banner brings the app forward and the pull picks it up.
   ```
   and it ends `await showMessageNotif(...); ... return;` (`fcmHeadless.ts:195-200`). No
   `pullEnvelopes`, no store write. `index.js:42-47` confirms this is the handler registered at
   bundle entry (`handleHeadlessFcm` is SLIM BY DESIGN … `messaging().setBackgroundMessageHandler(handleHeadlessFcm)`).
2. The richer handler that _does_ pull (`fcmBootstrap.ts:1400-1612`, `await (rt as …).pullEnvelopes()`
   at `:1598`) is registered at **module top level of `fcmBootstrap.ts`**, and every reference to
   that module in the app tree is a lazy `require()` inside a function
   (`MainNavigator.tsx:480`, `authStore.ts:543`, `productionRuntime.ts:1161`; `authStore.ts:40` is
   `import type`). So in a truly-killed headless VM the module is never evaluated and the slim
   handler is the only one that runs. Confirmed defect.
3. iOS: the server ships the wake — `apps/messenger-service/src/push/push.service.ts:718-735`
   sends the same `{kind:'msg-wake'}` data block to `records.filter(r => r.platform === 'ios')`
   with `payload: {aps: {'content-available': 1}}`. The client then renders **nothing**:
   `src/modules/messenger/push/callNotification.ts:177` — `if (Platform.OS !== 'android') {return;}`
   is the first line of `showMessageNotif`. Same hard gate on `dismissMessageNotif` (`:255`),
   `startBackgroundMessageNotifier` (`backgroundMessageNotifier.ts:185`), and
   `installSlimNotifeeBgHandler` (`callNotification.ts:501`).
4. And even if the client drew, it could not: `fcmBootstrap.ts:204-208` —
   `console.log('[fcm] iOS permission prompt skipped (PushKit not yet wired)')`. The app never asks
   for UNUserNotificationCenter authorization, so any iOS alert is dropped by the OS.
5. iOS is a live target, not a stub: `app.json:14-30` sets `bundleIdentifier`,
   `"aps-environment": "production"` and `UIBackgroundModes: ["voip","audio","remote-notification"]`;
   `callKitBridge.ts:66` has `const IOS_RUNTIME_ENABLED = true`.

**The audit's primary proposed fix is REJECTED for this batch** (see §Fix / deferred). "Doze-budgeted
single-VM-guarded minimal pull" is the same class as OR-1, which the batch architecture analysis
graded NOT-COVERED (needs human approval), and it has a second, independent blocker the audit did
not consider (headless token refresh → the B-71 revocation-loop class). The audit's own fallback —
"at minimum close the iOS banner lane" — is what this spec implements, and it closes the iOS half
_completely_ (including force-quit, which no client-side fix can reach).

## Mechanism

**Android (killed), the "30 overnight messages" symptom:**

1. Peer sends. `EnvelopeController.send` accepts and fires
   `push.sendChatWake(recipient, {senderUserId})` (`envelope.controller.ts:101-105`).
2. `sendChatWake` coalesces: `push-chat-debounce:{recipient}:{sender}` NX with
   `CHAT_DEBOUNCE_SEC = 6` (`push.service.ts:114, 619`), plus one trailing wake at window end.
   A burst of N messages inside 6 s therefore produces **2** FCM sends, not N.
3. FCM applies `collapseKey: msg-wake:<conversationId||senderUserId||userId>`
   (`push.service.ts:696`). A Dozed/offline device holds at most **one undelivered wake per
   collapse key**; the rest are discarded by FCM. Overnight, 30 messages from 2 senders converge on
   ~2 surviving wakes.
4. Each surviving wake reaches the slim `handleHeadlessFcm`, which draws a generic banner keyed
   `bravo-msg-<conv>` / `bravo-msg-sender:<uid>` (`callNotification.ts:185-187`), suppressed further
   by the 10 s `shouldAlert` burst window (`:130-142`).
5. Nothing is pulled, nothing is written. Unread counts, chat-list previews and the launcher badge
   stay at last-foreground values until the app opens and the WS reconnect drain runs. **Exactly
   the reported "a few generic banners, state frozen till open".**

**iOS (any state), total blackout:**

1. Client registers its DATA token with `body: JSON.stringify({platform: Platform.OS, token})`
   (`fcmBootstrap.ts:1341`) → the record lands as `platform: 'ios'`.
2. Server sends the msg-wake over APNs `content-available: 1` (`push.service.ts:719-735`).
3. Silent push ⇒ **no OS-drawn UI by definition**. It only wakes JS.
4. If the app is backgrounded-but-resident, `setBackgroundMessageHandler` fires →
   `showMessageNotif` → `Platform.OS !== 'android'` → `return`. Zero banners.
5. If the app is **force-quit by the user**, iOS does not deliver `content-available` pushes at all.
   No JS runs, no handler fires, and there is nothing to draw. _No client-only fix can close this
   case_ — a visible `aps.alert` from the server is the only lane.
6. Either way, without `requestPermission()` the app has no notification authorization, so an alert
   would be dropped too.

## Fix

Two files. The whole change is: **the server draws the iOS banner (APNs alert), and the client asks
for the authorization that makes it visible.** The client deliberately keeps drawing nothing on
iOS, so there is exactly one banner in every app state.

### 1. `apps/messenger-service/src/push/push.service.ts` — visible alert on the iOS chat wake

Anchor (verbatim, inside `sendChatWake`):

```ts
          apns: {
            headers: {
              'apns-priority': '10',
              'apns-collapse-id': `msg-wake:${opts.conversationId || opts.senderUserId || userId}`,
            },
            payload: {aps: {'content-available': 1}},
          },
```

Replacement:

```ts
          apns: {
            headers: {
              'apns-priority': '10',
              'apns-collapse-id': `msg-wake:${opts.conversationId || opts.senderUserId || userId}`,
            },
            // OR-3 — `content-available` alone is a SILENT push: it draws no UI, and iOS does not
            // deliver it at all to a force-quit app. The client's notifee lane is Android-only
            // (callNotification.showMessageNotif), so an iOS device rendered nothing in every
            // state. Ship a visible alert alongside the wake. The strings are CONSTANTS — no
            // sender name, no conversation, no content — so the payload discloses nothing the
            // `data` block above does not already carry.
            payload: {
              aps: {
                'content-available': 1,
                alert: {title: 'Bravo Secure', body: 'New secure message'},
                sound: 'default',
                'thread-id': `msg-wake:${opts.conversationId || opts.senderUserId || userId}`,
              },
            },
          },
```

Back-compat: purely additive to the APNs payload; `data` is byte-identical, so Android is
untouched and any already-shipped iOS build gains a banner where it previously had none (it cannot
double-draw — its `showMessageNotif` returns early on iOS). Server deploys before clients, which is
the correct order here: the server change alone fixes every iOS install that has already granted
notification permission.

### 2. `src/modules/messenger/push/fcmBootstrap.ts` — request iOS notification authorization

Anchor (verbatim, inside `startFcmBootstrap`):

```ts
    } else {
      // Skip iOS permission prompt for now — VoIP on iOS needs PushKit
      // and the regular-APNs prompt would mis-train the user.
      console.log('[fcm] iOS permission prompt skipped (PushKit not yet wired)');
    }
```

Replacement:

```ts
    } else {
      await requestIosNotificationAuthorization();
    }
```

New exported helper, placed immediately above `startFcmBootstrap` (so the unit test has a seam and
the bootstrap body stays flat):

```ts
/**
 * OR-3 — iOS message banners are drawn by APNs (`aps.alert`, see
 * push.service.sendChatWake) because a force-quit iOS app never runs JS. An
 * alert with no UNUserNotificationCenter authorization is dropped by the OS, so
 * this prompt is load-bearing for the whole iOS lane. It no longer competes with
 * PushKit: `voipPush.startVoipPushBootstrap` registers the VoIP token without a
 * runtime prompt, which is why the old "would mis-train the user" skip was safe
 * to remove. Idempotent — iOS shows the sheet once and afterwards resolves with
 * the standing status.
 */
export async function requestIosNotificationAuthorization(): Promise<number> {
  try {
    const status = await messaging().requestPermission();
    console.log('[fcm] iOS notification authorization =', status);
    return status;
  } catch (e) {
    console.warn('[fcm] iOS permission request failed:', (e as Error).message);
    return -1;
  }
}
```

`messaging` is already imported at `fcmBootstrap.ts:23`; `requestPermission()` is typed
`Promise<AuthorizationStatus>` (a numeric enum) in
`node_modules/@react-native-firebase/messaging/lib/index.d.ts:853`, so the `number` return needs no
new import. It is a documented no-op that resolves `AUTHORIZED` on Android (`:843`), but the call
stays inside the existing `else` branch so Android behaviour is provably unchanged.

### Explicitly NOT changed (and why) — this is the load-bearing design decision

Do **not** un-gate `showMessageNotif` (`callNotification.ts:177`),
`dismissMessageNotif` (`:255`), `startBackgroundMessageNotifier`
(`backgroundMessageNotifier.ts:185`) or `installSlimNotifeeBgHandler`
(`callNotification.ts:501`) for iOS in this change. If the client also drew, an
alive-but-backgrounded iOS device would show the APNs alert **and** a notifee banner with a
different identifier (`bravo-msg-<conv>` vs the APNs `apns-collapse-id`) — two banners for one
message, and the notifee one is unclearable from the server side. Keeping every client draw path
Android-only makes the invariant trivially checkable: **on iOS the banner is server-drawn, always,
exactly once.** The client still pulls and decrypts normally on foreground; only the _drawing_ is
delegated. Named/preview iOS banners are a follow-up that needs a Notification Service Extension
(see below), not a gate flip.

### Deferred (do NOT implement in this batch): the killed-app content pull

The audit's primary fix is blocked on two independent things:

- **Architecture gate.** The batch analysis graded the OR-1 proposal (background/2nd-process
  drain opening SQLCipher) **NOT-COVERED — needs human approval**, citing
  `SIGNAL_PROTOCOL_IMPLEMENTATION.md:66,436` ("registration removed because a 2nd JS VM fought the
  SQLCipher lock") and `MESSENGER_SPEC_COVERAGE.md:489` (killed-app wake is an explicit Phase-2
  deferral). "Persist sealed, decrypt on open" does not dodge this: persisting still needs a
  writable store in the headless VM, and if that store is SQLCipher it is the same contention, and
  if it is AsyncStorage it must be reconciled into the mirror ledger — which puts it under the
  `BACKUP_LOOP.md` I1–I9 single-writer invariants.
- **Auth, which the audit missed.** A pull needs a live access token. The stored token is 15-min TTL
  (`MESSENGER_BACKEND.md:204`, Redis jti allowlist), so an overnight-killed device must
  `refreshAccessTokenShared()` from the headless VM. A refresh issued by a second VM that races the
  foreground app is precisely the B-71 revocation-loop class (see `project_ops_console_signin_loop`).
  Any pull design must first specify single-flight refresh ownership across VMs.

Smallest correct follow-up increment, in order, each its own change:

1. **iOS named banners** — add a Notification Service Extension so `mutable-content: 1` lets the
   extension retitle the alert from the locally-persisted conversation slice. No JS VM, no
   SQLCipher, no double-draw. Closes the "generic banner" half on iOS properly.
2. **Cross-VM auth lease** — a single-flight refresh lease so a background actor can hold a valid
   token without racing the foreground. Prerequisite for anything else.
3. **Count-only headless probe** — `GET /envelopes?limit=…` is side-effect-free apart from
   `getOrMintAckToken` (`envelope.service.ts:296-299`); `.length` alone would let the banner say
   "N waiting" with no decrypt and no persist. Needs (2) and an architecture sign-off that a
   metadata-only headless probe is in-contract.

## Blast radius

- `PushService.sendChatWake` — the only edited server function. Callers:
  `EnvelopeController.send` (`envelope.controller.ts:102`), the WS gateway envelope path, and
  `scheduleTrailingChatWake` (`push.service.ts:778`). All three go through the same payload, so all
  three gain the iOS alert together — correct, and it is the trailing-wake path that carries the
  in-debounce-window messages.
- Android path in `sendChatWake` is a separate `sendEachForMulticast` call
  (`push.service.ts:666-711`) and is not touched. `push-events` / VoIP / call-cancel APNs payloads
  are separate methods and are not touched.
- `startFcmBootstrap` — the edit is inside the `Platform.OS !== 'android'` else-branch; the Android
  branch (POST_NOTIFICATIONS, `ensureMessagesChannel`, `ensureIncomingCallChannel`) is byte-identical.
  Callers: `MainNavigator.tsx:480` (mount) and re-entry through the `started`/`serverRegistered`
  gate at `:148-156`, which short-circuits before the permission block on repeat calls — so the
  prompt fires at most once per process.
- No schema change. No SQLCipher migration. No wire-format change to `data` (the FCM/APNs `data`
  block is unchanged, so the client parsers in `fcmHeadless.ts:150` and `fcmBootstrap.ts:1538` need
  no update and old clients are unaffected).
- **Overlapping findings:** OR-1 and OM-04 edit the same `fcmHeadless.ts` / `fcmBootstrap.ts`
  handler pair. This spec touches neither `handleHeadlessFcm` nor the `setBackgroundMessageHandler`
  body, so it should merge cleanly, but OR-1's own conclusion must stay consistent with the deferral
  written above — if OR-1 ships a headless pull, this spec's "client draws nothing on iOS" invariant
  must be re-checked against it. Nothing else in the batch edits `sendChatWake`.
- **What could regress:** (a) an iOS user who previously got zero notifications now gets a permission
  sheet at first login — a product-visible change, intended; (b) if any future change un-gates a
  client draw on iOS, double banners appear (locked by the test below); (c) APNs delivery for the
  chat lane runs through Firebase Admin, so it requires the APNs auth key to be configured in the
  Firebase project — if it is not, the alert silently no-ops exactly as the silent push does today
  (no new failure mode, but verify before claiming the fix works on device).

## Tests

**Server** — extend `apps/messenger-service/src/push/push-chat-wake.spec.ts` (jest, run from
`apps/messenger-service`). It already mocks `firebase-admin` and asserts payload shape, so the new
case slots in beside `P2-BR-4`. Widen the local `MulticastArg` type with
`apns?: {headers: Record<string,string>; payload: {aps: Record<string, unknown>}}`.

```ts
it('OR-3 — the iOS chat wake carries a VISIBLE alert (content-available alone never draws)', async () => {
  await push.registerDeviceToken({
    userId: 'u1',
    deviceId: 'd2',
    platform: 'ios',
    token: 'ios-tok-1',
    updatedAt: Date.now(),
  });
  sendEachForMulticast.mockResolvedValue({successCount: 1, responses: [{success: true}]});

  await push.sendChatWake('u1', {senderUserId: 'sender-a'});

  const iosCall = sendEachForMulticast.mock.calls
    .map(c => c[0] as MulticastArg)
    .find(a => a.tokens.includes('ios-tok-1'));
  expect(iosCall).toBeDefined();
  const aps = iosCall!.apns!.payload.aps as Record<string, unknown>;
  expect(aps['content-available']).toBe(1); // still wakes JS when resident
  expect(aps.alert).toEqual({title: 'Bravo Secure', body: 'New secure message'});
  // PERMANENT RULE — the alert is a CONSTANT: no sender, no conversation, no content.
  expect(JSON.stringify(aps)).not.toContain('sender-a');
  expect(Object.keys(iosCall!.data).sort()).toEqual(['conversationId', 'kind', 'senderUserId']);
});
```

**Client (new)** — `src/modules/messenger/__tests__/or3IosBannerLane.test.ts`, jest project
`messenger-crypto` (`npm run test:crypto`). Model the mocks on
`src/modules/messenger/__tests__/fcmHeadlessRouting.test.ts`, but with `Platform: {OS: 'ios'}`.
Two assertions — the design lock and the permission call.

```ts
jest.mock('react-native', () => ({Platform: {OS: 'ios'}, NativeModules: {}}));
jest.mock('@notifee/react-native', () => ({
  __esModule: true,
  default: {
    displayNotification: jest.fn(async () => {}),
    cancelNotification: jest.fn(async () => {}),
    createChannel: jest.fn(async () => 'ch'),
    deleteChannel: jest.fn(async () => {}),
  },
  AndroidImportance: {HIGH: 4},
  AndroidCategory: {MESSAGE: 'msg'},
  AndroidVisibility: {PRIVATE: 0},
  AndroidStyle: {MESSAGING: 2},
  EventType: {PRESS: 1, ACTION_PRESS: 2},
}));

it('OR-3 — the killed-app iOS msg-wake draws NOTHING client-side (the APNs alert is the only lane)', async () => {
  const {handleHeadlessFcm} = require('../push/fcmHeadless');
  const notifee = require('@notifee/react-native').default;
  await handleHeadlessFcm({data: {kind: 'msg-wake', conversationId: 'c1'}} as never);
  // A client draw here would DOUBLE the server-drawn aps.alert with an id the
  // server cannot collapse or clear. Keep every draw path Android-only.
  expect(notifee.displayNotification).not.toHaveBeenCalled();
});
```

Plus a direct test of the new seam (mock `@react-native-firebase/messaging` so
`messaging().requestPermission` is a jest.fn resolving `1`):

```ts
it('OR-3 — iOS bootstrap requests notification authorization (an aps.alert without it is dropped)', async () => {
  const {requestIosNotificationAuthorization} = require('../push/fcmBootstrap');
  await expect(requestIosNotificationAuthorization()).resolves.toBe(1);
  expect(
    require('@react-native-firebase/messaging').default().requestPermission,
  ).toHaveBeenCalled();
});
```

**Regression:** `npm run test:crypto` (messenger-crypto project — `fcmHeadlessRouting.test.ts` and
`backgroundMessageNotifier.test.ts` must stay green, proving Android drawing is untouched);
`cd apps/messenger-service && npm test` (`push-chat-wake.spec.ts`, `push.service.spec.ts`,
`push-events.opacity.spec.ts`); `npm run typecheck` must not exceed the `.tsc-baseline.json`
count of 47.

**Device (state honestly if not run):** iOS TestFlight build — (1) first login shows the
notification sheet; (2) background the app, send from another device, banner appears; (3)
**force-quit** the app, send, banner still appears (this is the case the whole change exists for);
(4) Android regression — killed-app banner still fires exactly once and is not duplicated.

## Risk

- **The reviewer should be suspicious of scope.** This spec does NOT do what the audit's headline
  fix says. Read the deferred section: the pull is arch-gated _and_ has an auth blocker the audit
  did not name. If the reviewer wants the pull, it needs sign-off, not code.
- **Double-banner is the only way this fix can go wrong**, and it goes wrong silently (nobody
  reports "I got two notifications" as a bug). Verify every `Platform.OS !== 'android'` gate in
  `callNotification.ts` (lines 145, 177, 255, 286, 300, 340, 475, 501, 575) is still in place after
  the diff. If a later change un-gates one, the new client test fails — keep it.
- **`requestPermission()` on Android.** RNFirebase documents it as a no-op resolving `AUTHORIZED`,
  but the call sits inside the `else` branch so this is belt-and-braces; confirm the Android branch
  in `startFcmBootstrap` is untouched in the diff.
- **iOS DATA tokens may not exist yet in production.** The server comment at `push.service.ts:716`
  says "No-op until an iOS build actually registers DATA tokens." `registerToken`
  (`fcmBootstrap.ts:1341`) does post `platform: Platform.OS`, and `getToken()` on iOS succeeds
  without user permission (auto `registerForRemoteNotifications` yields an APNs token for silent
  pushes) — but this is an inference, not something I could execute. If iOS DATA tokens turn out to
  be absent, the server fix is inert and the real bug is one layer earlier in registration. Check
  Redis `push-token:` records for `platform:'ios'` before declaring OR-3 closed.
- **APNs key in Firebase.** The chat lane goes through `admin.messaging()`, not the direct
  `ApnsClient` used for VoIP (`push.service.ts:1203-1245`). Those are separately configured; VoIP
  working does not prove chat APNs works.
- **Not verified by me:** no iOS device or simulator in this environment, and the `ios/` directory
  is gitignored (`.gitignore:56`) so the generated project could not be inspected. Everything about
  iOS delivery semantics above is from the payload shapes in the tree plus platform behaviour, not
  from an observed run.
