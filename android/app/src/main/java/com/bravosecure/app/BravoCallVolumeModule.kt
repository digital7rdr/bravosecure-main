package com.bravosecure.app

import android.content.Context
import android.media.AudioManager
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * B-425 — read/write the `STREAM_VOICE_CALL` volume index.
 *
 * Deliberately a DUMB accessor. All policy — when to raise, what floor, when
 * to stand down, what to restore — lives in `runtime/callVolumeFloor.ts` so it
 * is unit-testable without a device. Adding a "raise if low" convenience here
 * would put the same decision in two places, which is exactly how the
 * unwatched copy drifts in this repo.
 *
 * Why this exists at all: Android keeps a SEPARATE call-volume index per
 * output device, so a Bluetooth headset can carry its own remembered level
 * (measured: 7 of 15 on the founder's realme Buds) and re-apply it every time
 * audio routes to it. RN exposes no AudioManager volume API, and
 * react-native-incall-manager does not export one either.
 *
 * getName() MUST be "BravoCallVolume" — NativeModules.BravoCallVolume in
 * callVolumeFloor.ts.
 *
 * Safety contract:
 *   - Never throws into JS. `setVoiceCallVolume` is fire-and-forget void;
 *     `getVoiceCallVolume` rejects rather than crashing the call path.
 *   - Flag 0, never FLAG_SHOW_UI: a volume panel appearing on its own during
 *     a call would be its own bug.
 *   - The index is clamped to the device's own range, so a bad JS value can
 *     never push the stream out of bounds.
 */
class BravoCallVolumeModule(private val reactCtx: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactCtx) {

  override fun getName(): String = "BravoCallVolume"

  private fun audioManager(): AudioManager =
    reactCtx.getSystemService(Context.AUDIO_SERVICE) as AudioManager

  /** Resolves {current, max} for the ACTIVE output device's call stream. */
  @ReactMethod
  fun getVoiceCallVolume(promise: Promise) {
    try {
      val audio = audioManager()
      val map = Arguments.createMap()
      map.putInt("current", audio.getStreamVolume(AudioManager.STREAM_VOICE_CALL))
      map.putInt("max", audio.getStreamMaxVolume(AudioManager.STREAM_VOICE_CALL))
      promise.resolve(map)
    } catch (t: Throwable) {
      promise.reject("volume_read_failed", t)
    }
  }

  @ReactMethod
  fun setVoiceCallVolume(index: Double) {
    try {
      val audio = audioManager()
      val max = audio.getStreamMaxVolume(AudioManager.STREAM_VOICE_CALL)
      val min = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
        audio.getStreamMinVolume(AudioManager.STREAM_VOICE_CALL)
      } else {
        0
      }
      val clamped = index.toInt().coerceIn(min, max)
      audio.setStreamVolume(AudioManager.STREAM_VOICE_CALL, clamped, 0)
      Log.i(TAG, "setVoiceCallVolume($clamped) of $max")
    } catch (t: Throwable) {
      // A device that refuses the write (OEM policy, or not actually in a
      // call) must not break the call — the user's own level still applies.
      Log.w(TAG, "setVoiceCallVolume failed", t)
    }
  }

  companion object { private const val TAG = "BravoCallVolume" }
}
