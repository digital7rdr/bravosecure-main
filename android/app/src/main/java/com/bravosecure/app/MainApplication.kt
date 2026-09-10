package com.bravosecure.app

import android.app.Application
import android.content.res.Configuration

import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.ReactHost
import com.facebook.react.common.ReleaseLevel
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint
import com.facebook.react.defaults.DefaultReactNativeHost

import expo.modules.ApplicationLifecycleDispatcher
import expo.modules.ReactNativeHostWrapper

import android.media.MediaRecorder
import com.oney.WebRTCModule.WebRTCModuleOptions
import org.webrtc.audio.JavaAudioDeviceModule

class MainApplication : Application(), ReactApplication {

  override val reactNativeHost: ReactNativeHost = ReactNativeHostWrapper(
      this,
      object : DefaultReactNativeHost(this) {
        override fun getPackages(): List<ReactPackage> =
            PackageList(this).packages.apply {
              // Packages that cannot be autolinked yet can be added manually here, for example:
              // add(MyReactNativePackage())
              add(BravoFrameCryptorPackage())
              add(BravoCallForegroundPackage())
              add(BravoRingtonePackage())
              add(BravoBatteryOptimizationPackage())
              add(BravoCallVolumePackage())
              add(BravoNetworkCountryPackage())
            }

          override fun getJSMainModuleName(): String = ".expo/.virtual-metro-entry"

          override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG

          override val isNewArchEnabled: Boolean = BuildConfig.IS_NEW_ARCHITECTURE_ENABLED
      }
  )

  override val reactHost: ReactHost
    get() = ReactNativeHostWrapper.createReactHost(applicationContext, reactNativeHost)

  override fun onCreate() {
    super.onCreate()
    DefaultNewArchitectureEntryPoint.releaseLevel = try {
      ReleaseLevel.valueOf(BuildConfig.REACT_NATIVE_RELEASE_LEVEL.uppercase())
    } catch (e: IllegalArgumentException) {
      ReleaseLevel.STABLE
    }
    configureWebRtcAudioProcessing()
    loadReactNative(this)
    ApplicationLifecycleDispatcher.onApplicationCreate(this)
  }

  /**
   * BS-CALL-AEC — run WebRTC's OWN echo canceller / noise suppressor instead of
   * the phone's built-in ones.
   *
   * Why: `WebRTCModule`'s constructor falls back to
   * `JavaAudioDeviceModule.builder(ctx).createAudioDeviceModule()` when nothing
   * has populated `WebRTCModuleOptions.audioDeviceModule` — and that builder
   * defaults BOTH hardware flags to "whatever the device advertises". Every
   * device that advertises one therefore takes this branch in libwebrtc:
   *
   *   WebRtcVoiceEngine::ApplyOptions
   *     if (adm()->BuiltInAECIsAvailable() && EnableBuiltInAEC(true) == 0)
   *         options.echo_cancellation = false;   // <-- AEC3 switched OFF
   *
   * i.e. the vendor DSP canceller replaces AEC3. On a Pixel 6a
   * (/vendor/etc/audio_effects.xml declares `aec`+`ns` via `offload_effect`,
   * auto-applied to every `voice_communication` input) that canceller is tuned
   * for the handset path — built-in mic against earpiece/loudspeaker, short
   * fixed delay. It cannot converge when the far end is played by a Bluetooth
   * CAR head unit, where the echo tail is 100-250 ms, so the mic ships the
   * caller's own voice straight back. It also half-duplexes: when it fails to
   * converge it falls back to gross suppression and ducks the near-end mic
   * whenever far-end audio is playing, which is the "receiver's voice is too
   * quiet" report.
   *
   * AEC3 has a multi-hundred-millisecond delay estimator built for exactly this
   * and proper double-talk handling. Passing `false` makes
   * `BuiltInAECIsAvailable()` report false (it returns the BUILDER flag, not the
   * device capability), so libwebrtc keeps `echo_cancellation = true` and runs
   * AEC3. `WebRtcAudioEffects` still opens a handle to the platform effect and
   * explicitly `setEnabled(false)`s it, so the two do NOT stack.
   *
   * The audio SOURCE stays VOICE_COMMUNICATION: that is what selects the HAL's
   * voice-tuned mic path, and it is load-bearing — do not "simplify" it to MIC.
   *
   * NOT a crypto/messaging surface: this object is an input to the same
   * `PeerConnectionFactory` that `BravoFrameCryptorModule` reads back, and it
   * carries no keys. SFrame/DTLS/SRTP are untouched.
   *
   * TO REVERT: delete this call. Verification anchor in logcat —
   *   `JavaAudioDeviceModule: Overriding default behavior; now using WebRTC AEC!`
   */
  private fun configureWebRtcAudioProcessing() {
    try {
      val options = WebRTCModuleOptions.getInstance()
      if (options.audioDeviceModule != null) {
        android.util.Log.i("BravoCallAudio", "AudioDeviceModule already configured — leaving it")
        return
      }
      options.audioDeviceModule = JavaAudioDeviceModule.builder(this)
          .setAudioSource(MediaRecorder.AudioSource.VOICE_COMMUNICATION)
          .setUseHardwareAcousticEchoCanceler(false)
          .setUseHardwareNoiseSuppressor(false)
          .createAudioDeviceModule()
      // Own log line, not org.webrtc's. `JavaAudioDeviceModule` announces the
      // override through `org.webrtc.Logging`, which routes to a JUL fallback
      // until the native library is loaded — and this runs in Application
      // .onCreate, BEFORE PeerConnectionFactory.initialize. So its output is an
      // unreliable witness here, and "no log" must not be read as "no override".
      // This line is the dependable one.
      android.util.Log.i("BravoCallAudio", "AudioDeviceModule installed: HW AEC=off HW NS=off source=VOICE_COMMUNICATION (B-420)")
    } catch (t: Throwable) {
      // A missing/renamed symbol must not brick app start — WebRTCModule then
      // builds its own default ADM and calling degrades to the old behaviour.
      android.util.Log.w("BravoCallAudio", "custom AudioDeviceModule unavailable; using platform defaults", t)
    }
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    ApplicationLifecycleDispatcher.onConfigurationChanged(this, newConfig)
  }
}
