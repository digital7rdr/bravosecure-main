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
    if (intent?.action == ACTION_HANGUP) {
      // B-64: notification "Hang up" — tell JS (if alive) to end the call
      // properly (sends call.hangup / clears InCallManager), then clear the
      // FGS regardless so the notification can never outlive the user's
      // intent even when the JS runtime is gone.
      try {
        sendBroadcast(Intent(BROADCAST_HANGUP).setPackage(packageName))
      } catch (t: Throwable) {
        Log.w(TAG, "hangup broadcast failed", t)
      }
      stopForegroundCompat()
      stopSelf()
      return START_NOT_STICKY
    }

    val video = intent?.getBooleanExtra(EXTRA_VIDEO, false) ?: false
    val peer = intent?.getStringExtra(EXTRA_PEER) ?: "Bravo Secure"

    // B-70: phoneCall type (self-managed Telecom via CallKeep qualifies us)
    // restores the while-in-use mic/camera exemption when the FGS starts
    // from the background — the killed-app answer path starts exactly there.
    val type =
      if (video)
        ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL or
          ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
          ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
      else
        ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL or
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
   *
   * B-69/B-70: never typeless+stopSelf on a typed failure — that dropped the
   * camera-typed FGS mid-video (192→128 thrash) and left calls without
   * background survival. Instead walk a fallback ladder (full → drop
   * phoneCall → mic-only → typeless) and KEEP the service alive on the
   * strongest type that sticks; JS still owns stop().
   */
  private fun goForeground(notification: Notification, wantType: Int) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
      try {
        startForeground(NOTIF_ID, notification)
      } catch (t: Throwable) {
        Log.e(TAG, "startForeground failed (pre-R)", t)
        stopSelf()
      }
      return
    }
    val noPhone = wantType and ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL.inv()
    val ladder = linkedSetOf(wantType, noPhone, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
    for (type in ladder) {
      try {
        startForeground(NOTIF_ID, notification, type)
        Log.i(TAG, "startForeground ok type=$type (wanted=$wantType)")
        return
      } catch (t: Throwable) {
        Log.e(TAG, "typed startForeground failed type=$type; trying next", t)
      }
    }
    try {
      startForeground(NOTIF_ID, notification)
      Log.w(TAG, "startForeground degraded to typeless (no background mic/camera survival)")
    } catch (t: Throwable) {
      Log.e(TAG, "typeless startForeground failed; stopping", t)
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
      // Tag this as a call launch so MainActivity.applyCallLaunchFlagsIfNeeded
      // turns the screen on + renders OVER the keyguard when the user taps the
      // ongoing-call notification from a locked device. Without this extra the
      // flag check was always false (dead code) and the resumed call could
      // render behind the lock screen.
      putExtra(MainActivity.EXTRA_CALL_LAUNCH, true)
    }
    val contentPi = PendingIntent.getActivity(
      this,
      0,
      launch ?: Intent(),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    // B-64: an ongoing-call notification with no way to end the call is a
    // trap when the call UI is unreachable (auth gate / zombie 'connecting').
    val hangupPi = PendingIntent.getService(
      this,
      1,
      Intent(this, CallForegroundService::class.java).setAction(ACTION_HANGUP),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle(if (video) "Bravo Secure video call" else "Bravo Secure call")
      .setContentText(peer)
      .setSmallIcon(R.drawable.ic_stat_bravo) // monochrome status icon — the full-color launcher icon renders as a white blob
      .setOngoing(true)
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setContentIntent(contentPi)
      .addAction(0, "Hang up", hangupPi)
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
    const val ACTION_HANGUP = "com.bravosecure.app.CALL_FG_HANGUP"
    /** In-app broadcast consumed by BravoCallForegroundModule → JS DeviceEventEmitter. */
    const val BROADCAST_HANGUP = "com.bravosecure.app.CALL_FG_HANGUP_EVT"
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
