# iOS Push Handoff — background calls + notifications are dead until APNs is wired

**Date:** 2026-07-19
**Owner needed:** whoever has staging deploy access + Firebase Console access
**Note:** the tester has **neither** Firebase Console nor staging access — §5 _and_ §6 both
need to be done by the developer. Nothing here is actionable on the QA side.
**Severity:** P1 — no iOS call rings while backgrounded/killed; no iOS notifications at all
**Client code status:** ✅ complete, nothing to change

---

## 1. Symptom

Reported on device (iPhone 11, iOS, build `1.0.117 (145)` and the current cable-installed build):

- Swipe the app out of recent apps → **incoming call never rings**. WhatsApp does ring in the
  same state, so it is not an OS/device setting.
- **Notifications do not arrive at all**, foreground or background.

Android is unaffected — it rings and notifies normally.

## 2. Root cause

These are **two different pipelines**, both broken by the **same missing artifact**: the Apple
APNs auth key is not installed anywhere.

| Symptom                          | Pipeline                                  | Missing piece                                |
| -------------------------------- | ----------------------------------------- | -------------------------------------------- |
| No ring when backgrounded/killed | PushKit VoIP → `messenger-service` → APNs | `APNS_VOIP_*` env not set on the staging box |
| No notifications                 | FCM alert push → Firebase → APNs          | APNs key not uploaded to Firebase Console    |

Only an APNs **VoIP/PushKit** push can wake a suspended iOS app for a call. A normal FCM data
push cannot. And Firebase cannot deliver _any_ iOS notification until it holds the APNs key.

### Why the call path silently no-ops

`ensureApnsClient()` returns `null` when the env vars are absent, so `sendVoipApns` does
nothing and Android FCM continues to work — which is exactly the observed split.

`apps/messenger-service/src/push/push.service.ts:1222-1233`, and the code states the symptom
outright at line 1228:

> `iOS calls will not ring on backgrounded devices until this is wired.`

Look for this line in the messenger-service logs — it confirms the diagnosis:

```
push.voip.ios-skip — APNS_VOIP_* env not configured.
```

This was already filed as **IOSGV-3 (P1)** in `docs/audits/IOS_ANDROID_INTEROP_AUDIT_2026-07-19.md:94`.

## 3. What is already done — do NOT redo

The client is fully wired. No app-side change is required for this fix.

- `react-native-voip-push-notification@3.3.3` installed (`package.json:130`)
- `RUNTIME_ENABLED = true` (`src/modules/messenger/push/voipPush.ts:42`)
- `IOS_RUNTIME_ENABLED = true` (`src/modules/messenger/push/callKitBridge.ts:66`)
- `PKPushRegistry` + PushKit delegate methods injected on prebuild (`plugins/withVoipCallKit.js`)
- `FirebaseApp.configure()` injected — RNFB's own plugin silently stopped injecting it on
  Expo SDK 54 ("Unable to determine correct Firebase insertion point"), so Firebase never
  initialised; this is now handled in `withVoipCallKit.js`
- `GoogleService-Info.plist` `BUNDLE_ID` = `com.bravosecure.mobile` ✅ matches `app.json`
- Server-side APNs sender is complete and dormant on env only (`apnsClient.ts`)

## 4. The key — already verified

**File:** `AuthKey_B9U74KX24U.p8` (currently in the tester's `~/Downloads`)

Verified live against Apple, not assumed:

| Probe                          | Result                     | Meaning                                         |
| ------------------------------ | -------------------------- | ----------------------------------------------- |
| `B9U74KX24U` → sandbox host    | `400 BadDeviceToken`       | **key is valid** (only the dummy token was bad) |
| `B9U74KX24U` → production host | `400 BadDeviceToken`       | valid on both environments                      |
| ASC key `S6379ZCA56` (control) | `403 InvalidProviderToken` | proves the probe discriminates                  |

So: key `B9U74KX24U`, Team ID `88X6H88A4R` — confirmed good.

> ⚠️ **Not proven:** the APNs _topic_. A control probe with the wrong topic
> (`com.bravosecure.app.voip`) also returned `BadDeviceToken`, because APNs cannot validate a
> topic against a dummy token. The topic must equal `<bundleId>.voip`
> (`apnsClient.ts:109`), and the app's bundle ID is `com.bravosecure.mobile` — so
> `com.bravosecure.mobile.voip` is correct by derivation, but only a real device token proves it.

> 🔐 The `.p8` is a **secret**. Keep it out of git. It is not currently in the repo — keep it
> that way.

---

## 5. Fix — Part A: notifications (Firebase Console, no deploy)

Do this first; it is the quickest win and needs no server access.

1. Firebase Console → project **`bravo-734da`** → ⚙ Project Settings → **Cloud Messaging**
2. Under **Apple app configuration** → app `com.bravosecure.mobile` → **APNs Auth Key** → Upload
3. Upload `AuthKey_B9U74KX24U.p8` with:
   - **Key ID:** `B9U74KX24U`
   - **Team ID:** `88X6H88A4R`

One APNs auth key covers both sandbox and production, so this does not need repeating per build.

## 6. Fix — Part B: background calls (staging box)

Staging box: `admin@94.136.184.52` (key `~/.ssh/bravo-staging.pem`).

⚠️ The compose file used by staging is **`docker-compose.staging.yml`, which exists only on the
box** — it is _not_ in the repo, and `scripts/deploy-staging.sh:44` explicitly excludes `.env*`
from sync. This edit must be made on the box directly; a repo change will not take effect.

### B1. Copy the key to the box

```bash
scp -i ~/.ssh/bravo-staging.pem \
    ~/Downloads/AuthKey_B9U74KX24U.p8 \
    admin@94.136.184.52:/tmp/

ssh -i ~/.ssh/bravo-staging.pem admin@94.136.184.52
sudo mkdir -p /etc/bravo
sudo mv /tmp/AuthKey_B9U74KX24U.p8 /etc/bravo/
sudo chmod 0444 /etc/bravo/AuthKey_B9U74KX24U.p8   # see the perms note in §7
```

### B2. Edit `~/bravo/docker-compose.staging.yml` → `messenger-service:`

```yaml
volumes:
  - /etc/bravo/AuthKey_B9U74KX24U.p8:/run/secrets/apns_voip.p8:ro
environment:
  APNS_VOIP_KEY_ID: 'B9U74KX24U'
  APNS_VOIP_TEAM_ID: '88X6H88A4R'
  APNS_VOIP_BUNDLE_ID: 'com.bravosecure.mobile'
  APNS_VOIP_KEY_PATH: '/run/secrets/apns_voip.p8'
  APNS_VOIP_SANDBOX: '1'
```

### B3. Restart and verify

```bash
cd ~/bravo
docker compose -f docker-compose.staging.yml up -d messenger-service
docker compose -f docker-compose.staging.yml logs --tail=200 messenger-service | grep push.voip
```

**Expected — success:**

```
push.voip.ios-init bundle=com.bravosecure.mobile keyId=B9U7… sandbox=true
```

**Still broken if you see** `push.voip.ios-skip` (env not picked up) or
`push.voip.ios-init-failed` (key unreadable — see §7).

---

## 7. Three traps that will waste your afternoon

1. **`APNS_VOIP_KEY_PATH` is the path _inside_ the container**, not on the host. Without the
   volume mount in B2 you get `ios-skip` with every variable apparently set correctly.

2. **File permissions.** If the container runs non-root, `chmod 0400` root-only passes the
   `fs.existsSync()` check and then fails the read — surfacing as `push.voip.ios-init-failed`,
   not `ios-skip`. `0444` avoids this on a private VPS; alternatively `chown` to the
   container UID.

3. **Sandbox vs production — one at a time.** `apnsClient.ts:89` has a single host flag, so the
   server can only serve one APNs environment at once:

   | Build                     | Entitlement                       | Token      | `APNS_VOIP_SANDBOX` |
   | ------------------------- | --------------------------------- | ---------- | ------------------- |
   | Cable-installed dev build | `aps-environment: development` \* | sandbox    | `1`                 |
   | TestFlight build 145      | `aps-environment: production`     | production | unset / `0`         |

   \* Verified via `codesign -d --entitlements`: the **Development provisioning profile
   overrides** `app.json`'s `"aps-environment": "production"`. So the cable-installed build is
   sandbox regardless of what `app.json` says. Testing both builds against one server setting
   is the single most likely way to conclude "it's still broken" when it isn't.

   A wrong environment shows as `push.voip.ios-bad-token … reason=BadDeviceToken`.

## 8. Stale documentation to correct

`docs/planning/REMAINING_TODO.md:761` says:

```
APNS_VOIP_BUNDLE_ID=com.bravosecure.app     # ❌ STALE
```

The bundle ID is now **`com.bravosecure.mobile`**. Since the topic derives as
`<bundleId>.voip`, copying the documented value produces `DeviceTokenNotForTopic` and reads
like a client bug. Same stale ID appears in `docs/planning/BATCH_FIX_AND_FEATURE_PLAN.md:2610`.

## 9. Sign-off checklist

- [ ] APNs key uploaded to Firebase Console (`bravo-734da`), Key ID + Team ID entered
- [ ] `.p8` on the box at `/etc/bravo/`, readable by the container, **not** in git
- [ ] `docker-compose.staging.yml` has the volume mount **and** all five env vars
- [ ] Logs show `push.voip.ios-init`, **not** `ios-skip` / `ios-init-failed`
- [ ] Device test: kill the app from recent apps → incoming call **rings via CallKit**
- [ ] Device test: notification arrives with the app backgrounded
- [ ] `APNS_VOIP_SANDBOX` flipped to match whichever build is under test
- [ ] Stale `com.bravosecure.app` corrected in the two planning docs (§8)

## 10. Out of scope

Unrelated open issue, tracked separately — do not conflate: **B-121**, iOS outbound video not
rendering on Android in group calls (audio is fine both ways; Android→iOS video is fine). A
candidate fix (single video encoding on iOS instead of 3-layer simulcast) is built and under
device verification.
