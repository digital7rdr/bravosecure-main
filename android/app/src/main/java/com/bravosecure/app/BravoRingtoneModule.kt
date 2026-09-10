package com.bravosecure.app

import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Plays the DEVICE-DEFAULT ringtone (RingtoneManager.TYPE_RINGTONE) for an
 * incoming Bravo call — WhatsApp behavior. Exists because:
 *   1. The notifee channel `sound: 'default'` resolves to the default
 *      NOTIFICATION chime, not the user's ringtone (call-UI parity plan §4).
 *   2. Our Telecom ConnectionService is selfManaged, so Android never plays
 *      a system ringtone for us — the app owns ring audio.
 *
 * getName() MUST be "BravoRingtone" — NativeModules.BravoRingtone in
 * incomingRingtone.ts.
 *
 * Safety contract:
 *   - Never throws into JS (fire-and-forget void methods).
 *   - NATIVE auto-stop after timeoutMs: the killed-app headless JS context
 *     that started the ring can die before any stop() call arrives; a JS
 *     timer is not a reliable guardian. Must match the notification's
 *     `timeoutAfter` (PUSH-B5, 45s) so sound and card disappear together.
 *   - Respects ringer mode: silent/vibrate-only -> no playback (the
 *     notification channel's vibration pattern still runs).
 *   - Idempotent per callId; a new callId preempts the previous ring.
 */
class BravoRingtoneModule(private val reactCtx: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactCtx) {

  private var player: MediaPlayer? = null
  private var activeCallId: String? = null
  private var focusRequest: AudioFocusRequest? = null
  private val mainHandler = Handler(Looper.getMainLooper())
  private var autoStopRunnable: Runnable? = null

  override fun getName(): String = "BravoRingtone"

  @ReactMethod
  fun start(callId: String, timeoutMs: Double) {
    mainHandler.post {
      try {
        synchronized(this) {
          if (activeCallId == callId && player?.isPlaying == true) return@post
          stopLocked("preempted")

          val audio = reactCtx.getSystemService(android.content.Context.AUDIO_SERVICE) as AudioManager
          // Silent / vibrate-only: the channel vibration still fires; no sound.
          if (audio.ringerMode != AudioManager.RINGER_MODE_NORMAL) {
            Log.i(TAG, "start skipped ringerMode=${audio.ringerMode} call=$callId")
            return@post
          }

          val uri = RingtoneManager.getActualDefaultRingtoneUri(reactCtx, RingtoneManager.TYPE_RINGTONE)
            ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
            ?: run {
              Log.w(TAG, "no default ringtone uri — silent ring call=$callId")
              return@post
            }

          val attrs = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()

          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
              .setAudioAttributes(attrs)
              .build()
            audio.requestAudioFocus(req) // ring even if denied — matches OS dialer behavior
            focusRequest = req
          }

          val mp = MediaPlayer()
          mp.setAudioAttributes(attrs)
          mp.setDataSource(reactCtx, uri)
          mp.isLooping = true
          mp.setOnErrorListener { _, what, extra ->
            Log.w(TAG, "player error what=$what extra=$extra call=$callId")
            mainHandler.post { synchronized(this) { if (activeCallId == callId) stopLocked("player-error") } }
            true
          }
          mp.prepare()
          mp.start()
          player = mp
          activeCallId = callId

          // Belt-and-braces guardian — see class doc. stop() from JS is the
          // normal path; this catches a dead headless JS context.
          val guard = Runnable {
            synchronized(this) { if (activeCallId == callId) stopLocked("native-timeout") }
          }
          autoStopRunnable = guard
          mainHandler.postDelayed(guard, timeoutMs.toLong().coerceIn(1_000L, 120_000L))
          Log.i(TAG, "ring started call=$callId")
        }
      } catch (t: Throwable) {
        Log.e(TAG, "start failed", t)
        synchronized(this) { stopLocked("start-failed") }
      }
    }
  }

  /** callId=null (JS passes null for "stop whatever is ringing") stops unconditionally. */
  @ReactMethod
  fun stop(callId: String?) {
    mainHandler.post {
      try {
        synchronized(this) {
          if (callId != null && activeCallId != null && callId != activeCallId) return@post
          stopLocked("js-stop")
        }
      } catch (t: Throwable) {
        Log.w(TAG, "stop failed", t)
      }
    }
  }

  private fun stopLocked(reason: String) {
    autoStopRunnable?.let { mainHandler.removeCallbacks(it) }
    autoStopRunnable = null
    player?.let {
      try { if (it.isPlaying) it.stop() } catch (_: Throwable) {}
      try { it.release() } catch (_: Throwable) {}
      Log.i(TAG, "ring stopped reason=$reason call=$activeCallId")
    }
    player = null
    activeCallId = null
    focusRequest?.let { req ->
      try {
        val audio = reactCtx.getSystemService(android.content.Context.AUDIO_SERVICE) as AudioManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) audio.abandonAudioFocusRequest(req)
      } catch (_: Throwable) {}
    }
    focusRequest = null
  }

  override fun invalidate() {
    // React context teardown (app killed / reload) — never leave a looping
    // ringtone orphaned past the JS runtime.
    synchronized(this) { stopLocked("invalidate") }
    super.invalidate()
  }

  companion object { private const val TAG = "BravoRingtone" }
}
