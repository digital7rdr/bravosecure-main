package com.bravosecure.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.util.Log
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * JS <-> native bridge for the ongoing-call foreground service (B-32).
 * getName() MUST be "BravoCallForeground" — it is the key the JS bridge
 * looks up: NativeModules.BravoCallForeground in callForegroundService.ts.
 *
 * Every method is fire-and-forget void — they match the JS bridge's
 * `start(opts) => void` / `stop() => void` / `bringCallUiToForeground() => void`
 * signatures (JS does not await).
 *
 * B-64: also relays the FGS notification's "Hang up" action to JS as the
 * "bravoCallFgHangup" device event so the runtime can end the call properly
 * (send call.hangup, stop InCallManager, clear registry state).
 */
class BravoCallForegroundModule(private val reactCtx: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactCtx) {

  private var hangupReceiver: BroadcastReceiver? = null

  override fun getName(): String = "BravoCallForeground"

  override fun initialize() {
    super.initialize()
    val receiver = object : BroadcastReceiver() {
      override fun onReceive(context: Context?, intent: Intent?) {
        if (intent?.action != CallForegroundService.BROADCAST_HANGUP) return
        try {
          if (reactCtx.hasActiveReactInstance()) {
            reactCtx
              .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
              .emit("bravoCallFgHangup", null)
          }
        } catch (t: Throwable) {
          Log.w("BravoCallForeground", "hangup event emit failed", t)
        }
      }
    }
    hangupReceiver = receiver
    ContextCompat.registerReceiver(
      reactCtx,
      receiver,
      IntentFilter(CallForegroundService.BROADCAST_HANGUP),
      ContextCompat.RECEIVER_NOT_EXPORTED,
    )
  }

  override fun invalidate() {
    hangupReceiver?.let {
      try { reactCtx.unregisterReceiver(it) } catch (_: Throwable) { /* already gone */ }
    }
    hangupReceiver = null
    super.invalidate()
  }

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

  @ReactMethod
  fun bringCallUiToForeground() {
    try {
      val launch = reactCtx.packageManager.getLaunchIntentForPackage(reactCtx.packageName)
      if (launch == null) {
        Log.w("BravoCallForeground", "bringCallUiToForeground: no launch intent")
        return
      }
      launch.addFlags(
        Intent.FLAG_ACTIVITY_NEW_TASK or
          Intent.FLAG_ACTIVITY_SINGLE_TOP or
          Intent.FLAG_ACTIVITY_CLEAR_TOP,
      )
      // Why: MainActivity.isCallLaunch keys show-over-keyguard / turn-screen-on
      // off this extra. CallKeep's backToForeground() sends a BARE launcher
      // intent, which makes isCallLaunch false and CLEARS those flags, leaving a
      // lock-screen answer behind the keyguard and the process out of the
      // foreground procstate the mic/camera FGS types require.
      launch.putExtra(MainActivity.EXTRA_CALL_LAUNCH, true)
      reactCtx.startActivity(launch)
      Log.i("BravoCallForeground", "bringCallUiToForeground: launch dispatched")
    } catch (t: Throwable) {
      Log.w("BravoCallForeground", "bringCallUiToForeground failed", t)
    }
  }
}
