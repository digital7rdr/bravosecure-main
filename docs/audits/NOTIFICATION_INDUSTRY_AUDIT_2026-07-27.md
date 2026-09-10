# Notification Stack vs Industry Standard — Audit 2026-07-27

**Ask (founder):** "audit the notification also with industry how they work — notification is our
most weak part."
**Method:** code inventory of `src/modules/messenger/push/**` + server `push.service.ts` (evidence
greps, this session) × industry baseline (Android 14–16 platform requirements, Google Play FSI
policy Jan-2025, MessagingStyle/conversation guidance, WhatsApp/Signal/Telegram observed
patterns). Folds in the 2026-07-09 deep audit (N-01..N-36) — this doc does NOT re-verify all 36;
it maps the INDUSTRY gap and rolls forward what is demonstrably fixed vs still open.
**Prior art:** `docs/audits/NOTIFICATION_AUDIT_2026-07-09.md`.

---

## 1. Where we already MATCH industry (verified in code this session)

| Capability                                 | Industry bar                                                       | Ours                                            | Evidence                                                                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------ | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Incoming-call system UI                    | Telecom **self-managed ConnectionService** (+ CallKit on iOS)      | ✅                                              | `callKitBridge.ts:262` `selfManaged: true`, `reportIncomingCall`                                                                                |
| Full-screen intent policy (Play, Jan-2025) | Guard with `canUseFullScreenIntent` + settings deep-link           | ✅                                              | `batteryOptimization.ts:83`, `NotificationReliabilityCard.tsx`                                                                                  |
| `POST_NOTIFICATIONS` runtime flow (A13+)   | Rationale-first request                                            | ✅                                              | `fcmBootstrap.ts:235–245`                                                                                                                       |
| Quick actions                              | Reply (RemoteInput) + Mark-read from the banner                    | ✅                                              | N-10 done — `backgroundMessageNotifier.ts:143 "actions: true"`, `pendingActions.ts` durable drain, hung-spinner clear `callNotification.ts:482` |
| Message preview quality                    | Sender name + decrypted preview, mention call-out                  | ✅                                              | "Telegram-style preview" N-10, "X mentioned you" `backgroundMessageNotifier.ts:249`                                                             |
| Wake delivery                              | FCM data + `priority=high` (Doze), collapse keys, notifee-id dedup | ✅                                              | server `push.service.ts:364–365`, `collapseKey: voip-wake:<callId>`                                                                             |
| Token lifecycle                            | `onTokenRefresh` → re-register both endpoints                      | ✅                                              | `fcmBootstrap.ts:11,84`                                                                                                                         |
| Channels                                   | Granular, user-controllable channels                               | ✅ (calls v1/v2, messages, server-wake classes) | `createChannel` sites; B-48 channel-existence gotcha handled (`callVibration.ts`)                                                               |
| OEM kill mitigation                        | Battery-optimization prompts, reliability self-check               | ✅                                              | `batteryOptimization.ts`, `NotificationReliabilityCard`                                                                                         |
| Ring-cancel parity                         | Cancel push clears a ring on killed devices                        | ✅                                              | P2-15 server spec; device-observed 2026-07-27 (card removed on host cancel)                                                                     |
| Lane redundancy                            | Push lane can rescue a lost socket lane                            | ✅ NEW today                                    | AC-3 foreground group-wake re-dispatch (v1.0.180 pending build)                                                                                 |

This is a genuinely strong base — "most weak part" is no longer true of the _transport_ layer.
The weakness is concentrated in the four gaps below.

---

## 2. The industry gaps (ordered by user-visible impact)

### GAP-1 — No conversation identity: MessagingStyle + shortcuts + LocusId ⚠️ the big one

Grep evidence: zero `MessagingStyle`/`setDynamicShortcuts`/`LocusId`/`shortcutId` in the app.
Industry (mandatory for the Android "conversation space" since A11, and what WhatsApp/Signal/
Telegram all do): message notifications use **MessagingStyle** with `Person` objects and reference
a **published conversation shortcut**. What we lose without it:

- no **Conversations section** placement in the shade (we rank as generic notifications);
- no per-conversation user controls (priority conversation, per-thread mute from the OS);
- no **bubbles** eligibility;
- no avatar-in-banner grouping semantics; Android Auto messaging surface also keyed off it.
  Notifee supports the full shape (`AndroidStyle.MESSAGING`, `person`, `shortcutId`). Client-only
  change, no server involvement. **Recommended first.**

### GAP-2 — No notification grouping/summary

Zero `groupSummary`/`groupId:` in `backgroundMessageNotifier.ts`/`callNotification.ts`. Ten
messages = ten stacked banners. Industry: one group per conversation + an app summary notification
(`setGroup`/`groupSummary`), so the shade shows "Bravo — 3 conversations, 12 messages". Small,
pairs naturally with GAP-1.

### GAP-3 — No durable notification center (N-18/N-19/N-20/N-26 — still open)

The 07-09 audit's biggest structural finding stands: events live in Redis ~5 min; a missed push is
permanently lost; the in-app bell/ActivityBell is dead code; ops-console and mobile bells count
different things. Industry (WhatsApp/Telegram): the SERVER is the inbox — push is only a hint;
the client reconciles on connect, so nothing is ever "missed", only late. This is the real
"notifications are unreliable" root: any dropped FCM message today is a permanent information
loss. Needs a server-side inbox table + client reconcile sweep + one shared unread model.
Biggest lift, biggest payoff.

### GAP-4 — Locked/pre-unlock delivery (minor, posture-consistent)

No direct-boot handling: before first unlock the SQLCipher store is unavailable and wakes can't
render a real preview. Signal's pattern: an encrypted-placeholder banner ("You may have new
messages"). Low frequency, but the silent variant reads as "notifications broken" to the user it
hits. Cheap: headless path posts a generic banner when the store is locked instead of skipping.

---

## 3. 07-09 audit rollforward (spot-verified, not exhaustive)

- **Fixed since:** N-07 (tap crash — B-54), N-10 (Telegram parity — actions/preview/mention now in
  code), N-01/N-02/N-03 class (call-wake reliability — B-100/B-101 JTI + `voipWakeVerify.ts` +
  missed-call TTL server spec), B-256 stranded call notification, B-257/258 CPO/agency tap drops,
  B-48 killed-app ring.
- **Still open:** the notification-center cluster (N-18/19/20/23/24/26 → GAP-3), N-21 (`incident`
  push class unhandled — re-verify against Dept-Chat v2 before working it), N-11 residual (group
  wake keying — `backgroundMessageNotifier.ts:17` comment says group wakes still land as generic
  sender-keyed banners = folds into GAP-1/GAP-2 work).

---

## 4. Recommended order

1. **GAP-1 + GAP-2 together** (client-only, ~one focused session): MessagingStyle + Person +
   published shortcuts + LocusId + per-conversation grouping/summary. Converts the shade
   experience to WhatsApp-class in one change. Pin with a `notifShape` test suite.
2. **GAP-4** (small): locked-store placeholder banner in the headless path.
3. **GAP-3** (server + client, its own project): durable inbox + reconcile + one unread model.
   Design doc first — touches relay retention posture (30-day dwell rules) and both bells.
4. Re-verify N-21 (incident class) — may already be covered by Dept-Chat v2 routes.

Sources: [Android — notifications & conversations](https://developer.android.com/social-and-messaging/guides/communication/notifications-conversations) ·
[Android — people & conversations](https://developer.android.com/develop/ui/views/notifications/conversations) ·
[Play — FSI & FGS requirements](https://support.google.com/googleplay/android-developer/answer/13392821) ·
[AOSP — FSI limits](https://source.android.com/docs/core/permissions/fsi-limits) ·
[Android 14 behavior changes](https://developer.android.com/about/versions/14/behavior-changes-14) ·
[Bubbles for conversations](https://developer.android.com/develop/ui/compose/notifications/bubbles)
