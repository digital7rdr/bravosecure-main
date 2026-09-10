# B-32 — Call dies on foreground loss (screen-off / app-switch) — FIX HANDOFF

> **For the implementing Claude session.** This is a complete, self-contained spec.
> You should not need to re-investigate. Read it top to bottom, then implement §5–§6
> exactly. The investigation is done; the root cause is **proven**, not guessed.
>
> **Scope:** Android native only. **Additive**: 3 new Kotlin files + 1 one-line edit +
> `git add -f`. **No TypeScript / JS / wire / crypto / permission changes.** The entire
> JS + manifest + permission layer is already correct (§4). Touch nothing in §7's
> "DO NOT CHANGE" list. This keeps regression risk near zero.

---

## 1. TL;DR

When the call activity loses window focus (screen off, or the user switches apps), the
call dies — audio/video stops, the peer freezes/goes silent. There is **no foreground
service** keeping mic/camera capture alive.

The JS bridge `src/modules/messenger/runtime/callForegroundService.ts` looks up the native
module `NativeModules.BravoCallForeground` and **it does not exist** — so every
`startCallForegroundService()` call hits the `if (!native)` branch, logs
`[bravo.callfg] native module unavailable (iOS or unbuilt) — no-op`, and returns. On
Android 14+ (this build runs **targetSdk 36**), the OS suspends mic/camera capture for a
process that is not in the foreground and has no foreground service of the matching type →
the call's media stops.

**The fix is to implement the missing native pieces** so `BravoCallForeground` exists and
runs a real foreground service with `FOREGROUND_SERVICE_TYPE_MICROPHONE` (+ `CAMERA` for
video). The manifest already declares the service and all permissions; the JS already calls
start/stop at the right lifecycle points. You are filling a hole, not rewiring anything.

This is the **third recurrence** of the "native artifact referenced everywhere but never
committed because `android/` is gitignored" pattern (B-03 = `frameCryptorOrchestrator.ts`;
the FrameCryptor Kotlin module itself, restored 2026-06-07 by decompiling the APK). So
**you MUST `git add -f` the new files** (§6) or the next `expo prebuild --clean` deletes
them again.

---

## 2. Numbering note

The tester originally called this "B-24", but `sqa.md` already uses B-24 (ops approve
deadlock, FIXED). The log currently runs through **B-31**, so this is filed as **B-32**.

---

## 3. The bug

- **Title:** Call dies on foreground loss (screen-off / app-switch).
- **Layer:** Frontend / Android native.
- **Severity:** High (QA: new, failed 2/2).
- **Affects:** Every Android device, every call type — **1:1** (`CallScreen` / `useCall`)
  **and group** (`GroupCallScreen` / `useGroupCall`), voice and video. iOS is out of scope
  (separate CallKit background path; FrameCryptor isn't on iOS anyway).
- **Reproduce:**
  1. Start or accept any call (1:1 or group). Confirm it connects (audio both ways).
  2. Turn the screen off, **or** swipe to the home screen / another app.
  3. Wait ~10–30 s, return to the call.
  4. **Observed:** the call is dead — the peer was getting silence/frozen video while you
     were away; often the call has fully torn down. **Expected (WhatsApp/Signal parity):**
     the call keeps running in the background with a persistent "ongoing call" notification.

---

## 4. Root cause — evidence (already verified, do not re-run unless you want to)

**4.1 The JS bridge exists and is correctly wired** — `callForegroundService.ts` is called
from both call screens and stopped from the registries:

- `src/screens/messenger/CallScreen.tsx:806-807` → `startCallForegroundService(...)`
  (after permission is granted, foreground-service-first, before `InCallManager.start`).
- `src/screens/messenger/CallScreen.tsx:890-891` → `stopCallForegroundService()` on the
  real teardown branch (skipped on `keepAlive`/minimize and on the permission-dialog remount).
- `src/screens/messenger/GroupCallScreen.tsx:232-233` → `startCallForegroundService(...)`
  (gated on `micPermGranted`, which already includes CAMERA for video calls).
- `src/screens/messenger/GroupCallScreen.tsx:261` → `stopCallForegroundService()`.
- `src/modules/messenger/runtime/callRegistry.ts:198-199` and
  `groupCallRegistry.ts:178-179` → `stopCallForegroundService()` on hard-end (covers the
  floating-overlay "End" path that runs while `keepAlive` is true).

**4.2 The bridge no-ops because the native module is absent.**
`callForegroundService.ts:31-34`:

```ts
const native: CallForegroundNative | null =
  Platform.OS === 'android' && (NativeModules as Record<string, unknown>).BravoCallForeground
    ? (NativeModules as ...).BravoCallForeground
    : null;
```

`NativeModules.BravoCallForeground` is `undefined` at runtime → `native = null` →
`startCallForegroundService` returns after logging `native module unavailable … no-op`.

**4.3 The native module/service genuinely do not exist:**

- `grep -r 'CallForegroundService|BravoCallForeground' **/*.{kt,java}` → **No matches.**
- `android/app/src/main/java/com/bravosecure/app/` contains only: `MainActivity.kt`,
  `BravoFrameCryptorModule.kt`, `BravoFrameCryptorPackage.kt`, `MainApplication.kt`.
- `MainApplication.kt` registers only `add(BravoFrameCryptorPackage())` — **no**
  `BravoCallForegroundPackage`.
- `git log --all -- '**/CallForegroundService.kt'` → **empty** (never committed, any branch).
- `.gitignore:48` = `android/`. Only 4 android files are force-tracked
  (`AndroidManifest.xml`, the two FrameCryptor `.kt`, `MainApplication.kt`). The call FGS
  Kotlin was lost to a `prebuild --clean`, exactly as `BravoFrameCryptorModule.kt` notes for
  itself at its lines 17–20.

**4.4 The manifest + permissions are already in place** (`android/app/src/main/AndroidManifest.xml`):

- Permissions: `POST_NOTIFICATIONS`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MICROPHONE`,
  `FOREGROUND_SERVICE_CAMERA`, `WAKE_LOCK` — all present.
- Service declaration present:
  ```xml
  <service
      android:name=".CallForegroundService"
      android:exported="false"
      android:foregroundServiceType="microphone|camera"/>
  ```
  → the class name the Kotlin file must use is **`CallForegroundService`** in package
  **`com.bravosecure.app`** (so the manifest's `.CallForegroundService` resolves).

**4.5 Why the media dies (the Android mechanism).** From Android 11 (and hardened in
Android 14 / API 34, which this build targets at 36): an app that is **not in the
foreground** may access the microphone/camera **only** while a foreground service with the
matching `foregroundServiceType` (MICROPHONE / CAMERA) is running. With no such service,
when the activity loses window focus the capture tracks stop producing frames → the WebRTC
senders go silent/black → the call effectively dies. The foreground service also keeps the
process at foreground priority, which protects the signalling WebSocket from Doze. This is
exactly the "WhatsApp/Signal model" the existing `callForegroundService.ts` header comment
and the manifest comment describe.

> **Stale doc to fix while you're here (optional, doc-only):**
> `MESSENGER_AUDIT_FIXES.md:577` (P1-C1) says _"`startCallForegroundService` exported but
> never called"_. That's outdated — it **is** called (§4.1). The real defect is the missing
> native module. Update that row if you touch the file.

---

## 5. The fix — files to create / edit

Create three Kotlin files in `android/app/src/main/java/com/bravosecure/app/` and add one
line to `MainApplication.kt`. The code below is final — paste as-is. It uses only framework
APIs + `androidx.core` (`NotificationCompat`, `ContextCompat` — already on the classpath via
React Native) and guards every version-sensitive call.

### 5.1 NEW FILE — `CallForegroundService.kt`

```kotlin
package com.bravosecure.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat

/**
 * Ongoing-call foreground service. Holds FOREGROUND_SERVICE_TYPE_MICROPHONE
 * (+ CAMERA for video) so Android 11+/14+ does not suspend mic/camera capture
 * when the call activity loses window focus (screen off / app switch). B-32.
 *
 * Started/stopped from JS via BravoCallForegroundModule, which mirrors
 * src/modules/messenger/runtime/callForegroundService.ts.
 *
 * NOTE: android/ is .gitignored — this file is force-added (git add -f). A
 * `prebuild --clean` will delete it again if it is ever untracked (same fate
 * as BravoFrameCryptorModule.kt before 2026-06-07). Keep it tracked.
 */
class CallForegroundService : Service() {

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    ensureChannel(this)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      stopForegroundCompat()
      stopSelf()
      return START_NOT_STICKY
    }

    val video = intent?.getBooleanExtra(EXTRA_VIDEO, false) ?: false
    val peer = intent?.getStringExtra(EXTRA_PEER) ?: "Bravo Secure"

    val type =
      if (video)
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
          ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
      else
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE

    goForeground(buildNotification(peer, video), type)
    // START_NOT_STICKY: if the OS kills the process, do NOT resurrect the
    // service with a null intent — the call is gone, JS owns the lifecycle.
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    stopForegroundCompat()
    super.onDestroy()
  }

  /**
   * Post the foreground notification with the typed FGS. MUST satisfy the
   * startForegroundService() contract within ~5s or Android 12+ throws
   * ForegroundServiceDidNotStartInTimeException and crashes the process.
   * JS gates on RECORD_AUDIO (+ CAMERA for video) before calling start, so
   * the typed call should not throw; if it ever does (e.g. revoked perm),
   * post a typeless foreground to honor the contract, then stand down —
   * degrades to today's behaviour (no background survival), never a crash.
   */
  private fun goForeground(notification: Notification, type: Int) {
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        startForeground(NOTIF_ID, notification, type)
      } else {
        startForeground(NOTIF_ID, notification)
      }
      Log.i(TAG, "startForeground ok type=$type")
    } catch (t: Throwable) {
      Log.e(TAG, "typed startForeground failed; posting typeless then stopping", t)
      try { startForeground(NOTIF_ID, notification) } catch (_: Throwable) { /* ignore */ }
      stopForegroundCompat()
      stopSelf()
    }
  }

  private fun stopForegroundCompat() {
    try {
      // stopForeground(int) is API 24+ (minSdk here is 24). STOP_FOREGROUND_REMOVE
      // also dismisses the notification.
      stopForeground(STOP_FOREGROUND_REMOVE)
    } catch (t: Throwable) {
      Log.w(TAG, "stopForeground failed", t)
    }
  }

  private fun buildNotification(peer: String, video: Boolean): Notification {
    val launch = packageManager.getLaunchIntentForPackage(packageName)?.apply {
      flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
    }
    val contentPi = PendingIntent.getActivity(
      this,
      0,
      launch ?: Intent(),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle(if (video) "Bravo Secure video call" else "Bravo Secure call")
      .setContentText(peer)
      .setSmallIcon(applicationInfo.icon) // app icon — always a valid resource
      .setOngoing(true)
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setContentIntent(contentPi)
      .setSilent(true) // the ring/ringtone lives on bravo-incoming-call, not here
      .build()
  }

  companion object {
    const val TAG = "CallForegroundService"
    /** Dedicated channel — silent, separate from bravo-incoming-call (ring)
     *  and bravo-messages. Matches the "bravo-call-foreground" id referenced
     *  in the B-21 notes ("ongoing-call foreground-service channel"). */
    const val CHANNEL_ID = "bravo-call-foreground"
    const val NOTIF_ID = 70242
    const val ACTION_STOP = "com.bravosecure.app.CALL_FG_STOP"
    const val EXTRA_VIDEO = "video"
    const val EXTRA_PEER = "peer"

    /** Create the low-importance, silent channel. Idempotent. Safe to call
     *  from both the module (before startForegroundService) and the service
     *  (onCreate) — the channel must exist when the FGS notification posts. */
    fun ensureChannel(ctx: Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val mgr = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (mgr.getNotificationChannel(CHANNEL_ID) != null) return
      val ch = NotificationChannel(
        CHANNEL_ID,
        "Ongoing calls",
        NotificationManager.IMPORTANCE_LOW, // silent, no heads-up
      ).apply {
        description = "Keeps a call alive while the app is in the background"
        setShowBadge(false)
        setSound(null, null)
        enableVibration(false)
      }
      mgr.createNotificationChannel(ch)
    }
  }
}
```

### 5.2 NEW FILE — `BravoCallForegroundModule.kt`

```kotlin
package com.bravosecure.app

import android.content.Intent
import android.util.Log
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap

/**
 * JS <-> native bridge for the ongoing-call foreground service (B-32).
 * getName() MUST be "BravoCallForeground" — it is the key the JS bridge
 * looks up: NativeModules.BravoCallForeground in callForegroundService.ts.
 *
 * Both methods are fire-and-forget void — they match the JS bridge's
 * `start(opts) => void` / `stop() => void` signatures (JS does not await).
 */
class BravoCallForegroundModule(private val reactCtx: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactCtx) {

  override fun getName(): String = "BravoCallForeground"

  @ReactMethod
  fun start(opts: ReadableMap) {
    val kind = if (opts.hasKey("kind")) opts.getString("kind") else "voice"
    val peer = if (opts.hasKey("peer")) opts.getString("peer") else null
    try {
      // Channel must exist BEFORE the service posts its FGS notification.
      CallForegroundService.ensureChannel(reactCtx)
      val intent = Intent(reactCtx, CallForegroundService::class.java).apply {
        putExtra(CallForegroundService.EXTRA_VIDEO, kind == "video")
        putExtra(CallForegroundService.EXTRA_PEER, peer ?: "Bravo Secure")
      }
      ContextCompat.startForegroundService(reactCtx, intent)
    } catch (t: Throwable) {
      // Never throw into JS — the call must proceed even if the FGS can't
      // start (matches the JS-side try/catch contract).
      Log.e("BravoCallForeground", "start failed", t)
    }
  }

  @ReactMethod
  fun stop() {
    try {
      // stopService triggers onDestroy -> stopForeground(REMOVE). Simpler and
      // free of background-start restrictions vs. delivering an ACTION_STOP.
      reactCtx.stopService(Intent(reactCtx, CallForegroundService::class.java))
    } catch (t: Throwable) {
      Log.w("BravoCallForeground", "stop failed", t)
    }
  }
}
```

### 5.3 NEW FILE — `BravoCallForegroundPackage.kt`

(Identical shape to `BravoFrameCryptorPackage.kt` — follow the existing convention.)

```kotlin
package com.bravosecure.app

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class BravoCallForegroundPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(BravoCallForegroundModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}
```

### 5.4 EDIT — `MainApplication.kt` (register the package)

Find (in `getPackages()`):

```kotlin
            PackageList(this).packages.apply {
              // Packages that cannot be autolinked yet can be added manually here, for example:
              // add(MyReactNativePackage())
              add(BravoFrameCryptorPackage())
            }
```

Change to:

```kotlin
            PackageList(this).packages.apply {
              // Packages that cannot be autolinked yet can be added manually here, for example:
              // add(MyReactNativePackage())
              add(BravoFrameCryptorPackage())
              add(BravoCallForegroundPackage())
            }
```

That is the **only** TypeScript/Kotlin edit. Same package `com.bravosecure.app`, so no import needed.

---

## 6. CRITICAL — keep the new files tracked (android/ is .gitignored)

`.gitignore:48` ignores `android/`. The three new files will be untracked and a future
`expo prebuild --clean` will delete them (this is precisely how the call FGS was lost in the
first place, and how `BravoFrameCryptorModule.kt` was lost before being restored). After
creating the files, force-add them:

```bash
git add -f android/app/src/main/java/com/bravosecure/app/CallForegroundService.kt
git add -f android/app/src/main/java/com/bravosecure/app/BravoCallForegroundModule.kt
git add -f android/app/src/main/java/com/bravosecure/app/BravoCallForegroundPackage.kt
git add    android/app/src/main/java/com/bravosecure/app/MainApplication.kt   # already tracked
git status   # confirm all four are staged
```

The manifest already has the `<service>` + permissions (force-tracked), so no manifest
change is needed. Do **not** run `expo prebuild --clean` as part of this work.

---

## 7. DO NOT CHANGE (guardrails — this is how we avoid creating another bug)

The whole point of this task: the JS/manifest/permission layer is already correct. Leave it
alone. Specifically **do not touch**:

1. `src/modules/messenger/runtime/callForegroundService.ts` — the bridge is correct; once
   the native module exists, `native` becomes non-null and it works unchanged.
2. The start/stop call sites in `CallScreen.tsx`, `GroupCallScreen.tsx`,
   `callRegistry.ts`, `groupCallRegistry.ts` — the lifecycle (start-after-permission,
   skip-stop on `keepAlive`/minimize, hard-stop on end) is already right.
3. The permission-gating effects (`permGranted`, `micPermGranted`, `btPermResolved`) — they
   already gate the FGS start so `startForeground(...MICROPHONE/CAMERA)` won't hit a
   SecurityException.
4. `AndroidManifest.xml` — service + types + permissions are present and correct.
5. **No new runtime permission prompts**, no minSdk/targetSdk change, no new Gradle deps.
6. **No** in-app behaviour changes to minimize / floating-overlay / `keepAlive` — they
   depend on `stopCallForegroundService()` being a clean no-op when appropriate, which still
   holds (now backed by a real `stopService`).
7. Do not touch the unrelated in-flight uncommitted work in the tree (B-30/B-31:
   `productionRuntime.ts`, `bootGroupStashDrain.ts`, `GroupCallScreen.tsx` group-text edits).
   Your change is disjoint — keep it that way.
8. iOS: leave it a no-op. Do not stub anything in `callForegroundService.ts` for iOS.

Also keep these correctness invariants that the §5 code already satisfies:

- `getName()` returns exactly `"BravoCallForeground"`.
- Class name is exactly `CallForegroundService` in package `com.bravosecure.app` (matches
  manifest `.CallForegroundService`).
- Notification channel `bravo-call-foreground` is **silent / IMPORTANCE_LOW** and **must
  not** collide with `bravo-incoming-call` (ring) or `bravo-messages`.
- `startForeground` is always satisfied (typeless fallback) so the
  startForegroundService contract can't crash the process.
- Voice call → `MICROPHONE` type only; video → `MICROPHONE | CAMERA`.

---

## 8. Build & device verification (the real test — Jest can't cover native)

This is a native change; CLAUDE.md's "direct test" can't be a Kotlin unit test (Jest is JS
only). Verification is a real Android build + ADB. State clearly in your report that the fix
is **device-verified** (or "device-verify pending" if you lack hardware), per the SQA
convention used by B-27..B-31.

1. **Build** a release/staging APK with the existing flow (`npm run apk:staging`, or the
   `release-apk.ps1` flow). Do **not** `prebuild --clean`.
2. **Confirm the module is registered (no more no-op):** during a call, logcat should show
   `[bravo.callfg] service started kind=… peer=…` — NOT `native module unavailable … no-op`.
   ```bash
   adb -s <serial> logcat | grep -E 'bravo.callfg|CallForegroundService'
   ```
3. **Confirm the FGS is actually running** while in a call:
   ```bash
   adb -s <serial> shell dumpsys activity services com.bravosecure.app | grep -i -A3 ForegroundService
   # expect: CallForegroundService listed, isForeground=true, foregroundServiceType includes microphone (and camera on video)
   ```
   And the persistent "Bravo Secure call" notification should be visible in the shade.
4. **Repro the bug is gone — the golden path:**
   - 1:1 voice: connect → screen off 30 s → screen on → audio never dropped.
   - 1:1 video: connect → switch to another app 30 s → return → both tiles still live.
   - Group voice + group video: same, via `GroupCallScreen`.
5. **Confirm clean teardown:** end the call → the FGS stops and the notification disappears
   (`stopForeground(REMOVE)`); `dumpsys` no longer lists it. Test the floating-overlay "End"
   path too (minimize the call, end from the overlay) — `groupCallRegistry`/`callRegistry`
   stop the service.
6. **Channel sanity:** `adb shell dumpsys notification | grep -A6 com.bravosecure.app`
   should show `bravo-call-foreground` (LOW, silent) distinct from `bravo-incoming-call`.

---

## 9. Error / edge paths to check (don't ship without these)

- **Permission denied:** deny mic (and camera on a video call). The call must not crash —
  the JS gate means `startCallForegroundService` is simply not called (or the typeless
  fallback fires); behaviour degrades to "no background survival", same as today. **No
  ForegroundServiceDidNotStartInTimeException, no SecurityException crash.**
- **Minimize / restore (keepAlive):** minimize a connected call → the FGS must keep running
  (CallScreen/GroupCallScreen cleanup returns early on `keepAlive`); restore → still alive.
- **Rapid hangup:** start then immediately hang up — no lingering notification, no orphaned
  service in `dumpsys`.
- **Incoming call accept remount:** Android's permission-dialog pause/resume remounts the
  call screen; the registry-keyed audio-session guard already prevents a double start/stop —
  confirm a single FGS instance (one notification), not two.
- **Doze / long call:** a multi-minute backgrounded call should survive (FGS holds
  foreground priority; `InCallManager` already holds the CPU wake-lock).

---

## 10. Gates (per CLAUDE.md change-safety)

- `npm run typecheck` (mobile) — must stay ≤ baseline (`.tsc-baseline.json`). This change is
  native-only, so the count should be **unchanged**.
- `cd apps/ops-console && npm run typecheck` — unaffected (don't bother unless you touched it).
- `npm run test:crypto` and full `npm test` — should be **unchanged** (no JS touched). Run
  the crypto suite as the standard regression signal; nothing here affects it.
- Android build must succeed (R8/dex) with the new package registered.
- Optional JS guard test (nice-to-have, not required): a unit test that mocks
  `NativeModules.BravoCallForeground = {start, stop}` and asserts
  `callForegroundService.startCallForegroundService(...)` calls `native.start` with
  `{kind, peer}` and flips `isCallForegroundActive()` to true. Pins the bridge contract so a
  future `getName()` rename is caught. (The real behaviour is still device-verified.)

---

## 11. Rollback

Pure addition. To revert: delete the three new `.kt` files, remove the single
`add(BravoCallForegroundPackage())` line from `MainApplication.kt`, rebuild. The bridge
returns to its no-op state — i.e. exactly today's (buggy) behaviour, no other side effects.

---

## 12. Optional follow-ups (explicitly OUT OF SCOPE here — do not bundle)

- A dedicated 24dp white-silhouette `@drawable/ic_stat_call` for the FGS notification small
  icon (instead of `applicationInfo.icon`). Cosmetic.
- An "End call" action button on the FGS notification (needs a BroadcastReceiver →
  `endActiveCall`/`endActiveGroupCall`). Useful, but adds surface area; ship the survival
  fix first.
- Investigate why `react-native-callkeep` `setup()` returns `false` on Android (noted in
  B-27). With the FGS in place it's a separate fallback path; not required for B-32.
- Update `MESSENGER_AUDIT_FIXES.md:577` (P1-C1) to reflect the real cause (§4 note).

---

## 13. One-paragraph summary to put in the commit / PR

> **fix(calls): implement the call foreground service so calls survive backgrounding (B-32).**
> `NativeModules.BravoCallForeground` was missing — the manifest declared
> `.CallForegroundService` and both call screens called the JS bridge, but the Kotlin service
>
> - native module/package were never committed (`android/` is gitignored; same class as B-03
>   / the FrameCryptor module). Without a typed foreground service, Android 14+ suspended
>   mic/camera capture on screen-off/app-switch and the call died. Adds
>   `CallForegroundService.kt` (FOREGROUND_SERVICE_TYPE_MICROPHONE [+CAMERA]),
>   `BravoCallForegroundModule.kt` (getName "BravoCallForeground"),
>   `BravoCallForegroundPackage.kt`, and registers the package in `MainApplication.kt`.
>   Force-added (`git add -f`) so prebuild --clean can't drop them. JS/manifest/permission
>   layers unchanged; device-verified 1:1 + group, voice + video, survive 30s background.
