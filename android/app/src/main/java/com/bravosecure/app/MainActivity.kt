package com.bravosecure.app
import expo.modules.splashscreen.SplashScreenManager

import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.WindowManager

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

import expo.modules.ReactActivityDelegateWrapper

/**
 * NOTE: android/ is .gitignored — this file is force-added (git add -f), same
 * as CallForegroundService.kt. It defines EXTRA_CALL_LAUNCH, which the
 * (tracked) CallForegroundService references — leaving this file untracked
 * breaks compileReleaseKotlin on every fresh checkout (B-45 build fallout,
 * 2026-07-04). A `prebuild --clean` regenerates a vanilla MainActivity and
 * silently drops the call-launch handling below. Keep it tracked.
 */
class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // Set the theme to AppTheme BEFORE onCreate to support
    // coloring the background, status bar, and navigation bar.
    // This is required for expo-splash-screen.
    // setTheme(R.style.AppTheme);
    // @generated begin expo-splashscreen - expo prebuild (DO NOT MODIFY) sync-f3ff59a738c56c9a6119210cb55f0b613eb8b6af
    SplashScreenManager.registerOnActivity(this)
    // @generated end expo-splashscreen
    super.onCreate(null)
    applyCallLaunchFlagsIfNeeded(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    applyCallLaunchFlagsIfNeeded(intent)
  }

  /**
   * When launched from a call surface — a tap on the ongoing-call FGS
   * notification (which sets EXTRA_CALL_LAUNCH, see
   * CallForegroundService.buildNotification) OR notifee's full-screen /
   * press launch of an incoming-call ring — turn the screen on and render
   * over the keyguard so the call UI is usable on a locked device instead
   * of appearing behind the lock screen. On any NON-call launch we instead
   * clear those flags so the secure-app keyguard posture is restored after
   * the call (P3: the flags were previously never cleared).
   */
  private fun applyCallLaunchFlagsIfNeeded(intent: Intent?) {
    setCallLaunchFlags(isCallLaunch(intent))
  }

  /**
   * True when this launch is a call surface. Two triggers:
   *  - EXTRA_CALL_LAUNCH: the ongoing-call FGS notification tap.
   *  - notifee ring: notifee attaches the tapped/full-screen notification to
   *    the launch intent as the "notification" bundle extra, with the user data
   *    map nested under "data". An incoming-call ring sets data.kind to one of
   *    the call kinds (callNotification.ts CallNotifKind). Message / server
   *    wakes use other kinds and must NOT flip the keyguard posture.
   */
  private fun isCallLaunch(intent: Intent?): Boolean {
    if (intent == null) return false
    if (intent.getBooleanExtra(EXTRA_CALL_LAUNCH, false)) return true
    return try {
      val notif = intent.getBundleExtra(NOTIFEE_EXTRA_NOTIFICATION)
      val data = notif?.getBundle(NOTIFEE_EXTRA_DATA)
      val kind = data?.getString(NOTIFEE_KEY_KIND)
      kind != null && CALL_KINDS.contains(kind)
    } catch (t: Throwable) {
      // A malformed/foreign intent must never crash launch — just treat it as
      // a non-call launch.
      false
    }
  }

  private fun setCallLaunchFlags(enable: Boolean) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      setShowWhenLocked(enable)
      setTurnScreenOn(enable)
      if (enable) {
        val km = getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
        km.requestDismissKeyguard(this, null)
      }
    } else {
      @Suppress("DEPRECATION")
      val flags = WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
        WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
      if (enable) {
        @Suppress("DEPRECATION")
        window.addFlags(flags)
      } else {
        @Suppress("DEPRECATION")
        window.clearFlags(flags)
      }
    }
  }

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "main"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate {
    return ReactActivityDelegateWrapper(
          this,
          BuildConfig.IS_NEW_ARCHITECTURE_ENABLED,
          object : DefaultReactActivityDelegate(
              this,
              mainComponentName,
              fabricEnabled
          ){})
  }

  /**
    * Align the back button behavior with Android S
    * where moving root activities to background instead of finishing activities.
    * @see <a href="https://developer.android.com/reference/android/app/Activity#onBackPressed()">onBackPressed</a>
    */
  override fun invokeDefaultOnBackPressed() {
      if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.R) {
          if (!moveTaskToBack(false)) {
              // For non-root activities, use the default implementation to finish them.
              super.invokeDefaultOnBackPressed()
          }
          return
      }

      // Use the default back button implementation on Android S
      // because it's doing more than [Activity.moveTaskToBack] in fact.
      super.invokeDefaultOnBackPressed()
  }

  companion object {
    /** Set by call-surface launch intents (CallForegroundService content
     *  intent; full-screen ring) so the activity engages the lock-screen
     *  window flags above. Read via getBooleanExtra at onCreate/onNewIntent. */
    const val EXTRA_CALL_LAUNCH = "com.bravosecure.app.EXTRA_CALL_LAUNCH"

    /** notifee attaches the launched notification to the activity intent as a
     *  Bundle extra keyed "notification" (see notifee-core getInitialNotification,
     *  which reads the same extra); the JS `data` map is a nested Bundle. */
    private const val NOTIFEE_EXTRA_NOTIFICATION = "notification"
    private const val NOTIFEE_EXTRA_DATA = "data"
    private const val NOTIFEE_KEY_KIND = "kind"

    /** CallNotifKind values set by callNotification.ts showIncomingCallNotif —
     *  keep in sync. Message wakes ("msg-wake") / missed calls ("missed-call") /
     *  server wakes are deliberately NOT call launches. */
    private val CALL_KINDS = setOf("voice", "video", "group-voice", "group-video")
  }
}
