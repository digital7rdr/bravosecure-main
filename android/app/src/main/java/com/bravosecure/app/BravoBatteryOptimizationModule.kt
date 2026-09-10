package com.bravosecure.app

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * P2-BR-1 (background-reliability audit 2026-07-10): Signal-style battery
 * optimization exemption + OEM auto-start deep links. Aggressive OEM power
 * managers (Transsion HiOS/XOS — the TECNO KM5 QA device — MIUI, ColorOS,
 * FuntouchOS, EMUI) force-stop a swiped-away/"cleaned" app, after which
 * Android delivers ZERO FCM: killed-app messages and call rings black out
 * until the user manually reopens the app. Exempting the app from battery
 * optimization (+ enabling OEM auto-start where such a screen exists) is the
 * documented mitigation (dontkillmyapp.com) and what WhatsApp/Signal do.
 *
 * getName() MUST be "BravoBatteryOptimization" — it is the key the JS wrapper
 * looks up: NativeModules.BravoBatteryOptimization in
 * src/modules/messenger/push/batteryOptimization.ts.
 *
 * NOTE: android/ is .gitignored — this file must be force-added (git add -f),
 * same as the other Bravo* modules, or compileReleaseKotlin breaks on a fresh
 * checkout (see MainActivity.kt header).
 */
class BravoBatteryOptimizationModule(private val reactCtx: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactCtx) {

  override fun getName(): String = "BravoBatteryOptimization"

  /** True when the app is already exempt from Doze/App-Standby restrictions. */
  @ReactMethod
  fun isIgnoringBatteryOptimizations(promise: Promise) {
    try {
      val pm = reactCtx.getSystemService(Context.POWER_SERVICE) as PowerManager
      promise.resolve(pm.isIgnoringBatteryOptimizations(reactCtx.packageName))
    } catch (t: Throwable) {
      promise.reject("battery_opt_check_failed", t)
    }
  }

  /**
   * Fire the system "Allow app to run in background?" dialog
   * (ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS with the package URI).
   * Resolves once the dialog is LAUNCHED — the grant result is not awaitable
   * without onActivityResult plumbing; JS re-checks
   * isIgnoringBatteryOptimizations on the next app-active transition.
   * Some OEMs strip the dialog: fall back to the system ignore-list screen.
   */
  @SuppressLint("BatteryLife") // Firebase App Distribution, not Play — see manifest comment
  @ReactMethod
  fun requestIgnoreBatteryOptimizations(promise: Promise) {
    try {
      val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
        .setData(Uri.parse("package:${reactCtx.packageName}"))
      launch(intent)
      promise.resolve(null)
    } catch (t: Throwable) {
      try {
        launch(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        promise.resolve(null)
      } catch (t2: Throwable) {
        promise.reject("battery_opt_request_failed", t2)
      }
    }
  }

  /**
   * Open the OEM auto-start / protected-apps screen where the user must
   * additionally whitelist Bravo. Tries each known candidate for the running
   * manufacturer; a missing/renamed activity just falls through to the next.
   * Resolves TRUE when an OEM screen opened, FALSE when it fell back to the
   * app-details settings page. Explicit-component startActivity is exempt
   * from Android 11+ package-visibility filtering, so no <queries> needed.
   */
  @ReactMethod
  fun openAutostartSettings(promise: Promise) {
    for (component in autostartCandidates()) {
      try {
        launch(Intent().setComponent(component))
        promise.resolve(true)
        return
      } catch (_: ActivityNotFoundException) {
        // candidate not present on this ROM — try the next one
      } catch (_: SecurityException) {
        // present but permission-guarded on this ROM — try the next one
      } catch (t: Throwable) {
        Log.w(TAG, "autostart candidate failed: ${component.flattenToShortString()}", t)
      }
    }
    try {
      launch(
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
          .setData(Uri.parse("package:${reactCtx.packageName}")),
      )
      promise.resolve(false)
    } catch (t: Throwable) {
      promise.reject("autostart_open_failed", t)
    }
  }

  /**
   * B-63: Android 14+ denies USE_FULL_SCREEN_INTENT by default for non-dialer
   * apps — the 2026-07-10 Pixel-7a ring posted with FSI_REQUESTED_BUT_DENIED
   * and the lock-screen call UI never showed. True pre-34 (grant implied by
   * the manifest permission).
   */
  @ReactMethod
  fun canUseFullScreenIntent(promise: Promise) {
    try {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        promise.resolve(true)
        return
      }
      val nm = reactCtx.getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
      promise.resolve(nm.canUseFullScreenIntent())
    } catch (t: Throwable) {
      promise.reject("fsi_check_failed", t)
    }
  }

  /**
   * B-63: open the per-app "Full screen notifications" grant screen
   * (ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT). Resolves TRUE when the FSI
   * screen opened, FALSE on the app-details fallback (pre-34 or stripped ROM).
   */
  @ReactMethod
  fun openFullScreenIntentSettings(promise: Promise) {
    try {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        promise.resolve(false)
        return
      }
      launch(
        Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT)
          .setData(Uri.parse("package:${reactCtx.packageName}")),
      )
      promise.resolve(true)
    } catch (t: Throwable) {
      try {
        launch(
          Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
            .setData(Uri.parse("package:${reactCtx.packageName}")),
        )
        promise.resolve(false)
      } catch (t2: Throwable) {
        promise.reject("fsi_open_failed", t2)
      }
    }
  }

  /**
   * CA-07: TRUE when Do Not Disturb is suppressing notifications
   * (interruption filter != ALL). DND silences message tones and call rings
   * even with every permission granted, which reads as "the app is broken" —
   * surface it as a reliability row instead. UNKNOWN resolves FALSE (fail
   * quiet: never nag off a signal we can't read).
   */
  @ReactMethod
  fun isDndEnabled(promise: Promise) {
    try {
      val nm = reactCtx.getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
      val filter = nm.currentInterruptionFilter
      promise.resolve(
        filter != android.app.NotificationManager.INTERRUPTION_FILTER_ALL &&
          filter != android.app.NotificationManager.INTERRUPTION_FILTER_UNKNOWN,
      )
    } catch (t: Throwable) {
      promise.reject("dnd_check_failed", t)
    }
  }

  /**
   * CA-07: open the system Do Not Disturb settings. String action (public on
   * API 23+) rather than the Settings constant so this compiles across SDK
   * levels; falls back to sound settings on ROMs that strip the screen.
   * Resolves TRUE when the DND screen opened, FALSE on the fallback.
   */
  @ReactMethod
  fun openDndSettings(promise: Promise) {
    try {
      launch(Intent("android.settings.ZEN_MODE_PRIORITY_SETTINGS"))
      promise.resolve(true)
    } catch (t: Throwable) {
      try {
        launch(Intent(Settings.ACTION_SOUND_SETTINGS))
        promise.resolve(false)
      } catch (t2: Throwable) {
        promise.reject("dnd_open_failed", t2)
      }
    }
  }

  private fun launch(intent: Intent) {
    val activity = reactCtx.currentActivity
    if (activity != null) {
      activity.startActivity(intent)
    } else {
      reactCtx.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
  }

  /**
   * Known OEM auto-start / protected-apps activities (component names per the
   * open-source autostarter catalogue + dontkillmyapp.com). Order matters:
   * newest screens first, legacy fallbacks after.
   */
  private fun autostartCandidates(): List<ComponentName> {
    val fingerprint = "${Build.MANUFACTURER} ${Build.BRAND}".lowercase()
    fun matches(vararg keys: String) = keys.any { fingerprint.contains(it) }
    return when {
      // Transsion HiOS / XOS / itelOS (TECNO, Infinix, itel) — Phone Master's
      // auto-boot manager. Package name varies by ROM generation.
      matches("tecno", "infinix", "itel", "transsion") -> listOf(
        ComponentName("com.transsion.phonemanager", "com.itel.autobootmanager.activity.AutoBootMgrActivity"),
        ComponentName("com.transsion.phonemaster", "com.cyin.himgr.autostart.AutoStartActivity"),
      )
      // MIUI (Xiaomi / Redmi / POCO)
      matches("xiaomi", "redmi", "poco") -> listOf(
        ComponentName("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"),
      )
      // ColorOS (OPPO / realme)
      matches("oppo", "realme") -> listOf(
        ComponentName("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity"),
        ComponentName("com.coloros.safecenter", "com.coloros.safecenter.startupapp.StartupAppListActivity"),
        ComponentName("com.oppo.safe", "com.oppo.safe.permission.startup.StartupAppListActivity"),
      )
      // FuntouchOS / OriginOS (vivo / iQOO)
      matches("vivo", "iqoo") -> listOf(
        ComponentName("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"),
        ComponentName("com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity"),
        ComponentName("com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager"),
      )
      // EMUI / MagicOS (Huawei / HONOR)
      matches("huawei", "honor") -> listOf(
        ComponentName("com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"),
        ComponentName("com.huawei.systemmanager", "com.huawei.systemmanager.appcontrol.activity.StartupAppControlActivity"),
        ComponentName("com.huawei.systemmanager", "com.huawei.systemmanager.optimize.process.ProtectActivity"),
      )
      else -> emptyList()
    }
  }

  companion object { private const val TAG = "BravoBatteryOpt" }
}
