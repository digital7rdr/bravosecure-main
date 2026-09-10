package com.bravosecure.app

import android.util.Base64
import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.oney.WebRTCModule.WebRTCModule
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import org.webrtc.FrameCryptor
import org.webrtc.FrameCryptorAlgorithm
import org.webrtc.FrameCryptorFactory
import org.webrtc.FrameCryptorKeyProvider

// Why: restored 2026-06-07 by decompiling the v1.0.46 release APK — the
// original was never committed (android/ is gitignored) and was lost to a
// prebuild --clean. See docs/ARCHITECTURE_AMENDMENT_SFRAME.md for the design
// and src/modules/messenger/webrtc/frameCryptorTransport.ts for the JS side.
// Depends on the Bravo accessors patched into react-native-webrtc
// (patches/react-native-webrtc+124.0.7.patch): getRtpSenderById,
// getRtpReceiverById, getPeerConnectionFactory.
class BravoFrameCryptorModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  private val keyProviders = ConcurrentHashMap<String, FrameCryptorKeyProvider>()
  private val cryptors = ConcurrentHashMap<String, FrameCryptor>()

  override fun getName(): String = TAG

  @ReactMethod(isBlockingSynchronousMethod = true)
  fun isAvailable(): Boolean =
    try {
      Class.forName("org.webrtc.FrameCryptorFactory")
      Class.forName("org.webrtc.FrameCryptorKeyProvider")
      Class.forName("org.webrtc.FrameCryptor")
      true
    } catch (e: ClassNotFoundException) {
      Log.w(TAG, "FrameCryptor classes not found — libwebrtc patch not applied?")
      false
    }

  @ReactMethod
  fun createKeyProvider(
    ratchetWindowSize: Int,
    failureTolerance: Int,
    keyRingSize: Int,
    promise: Promise,
  ) {
    try {
      val salt = "bravo-sframe-v1".toByteArray(Charsets.UTF_8)
      val kp = FrameCryptorFactory.createFrameCryptorKeyProvider(
        false,
        salt,
        ratchetWindowSize,
        ByteArray(0),
        failureTolerance,
        keyRingSize,
        true,
      )
      val id = UUID.randomUUID().toString()
      keyProviders[id] = kp
      promise.resolve(id)
    } catch (t: Throwable) {
      Log.e(TAG, "createKeyProvider failed", t)
      promise.reject("KP_CREATE_FAILED", t.message, t)
    }
  }

  @ReactMethod
  fun setKey(
    keyProviderId: String,
    participantId: String,
    index: Int,
    keyBase64: String,
    promise: Promise,
  ) {
    val kp = keyProviders[keyProviderId]
    if (kp == null) {
      promise.reject("KP_NOT_FOUND", "key provider $keyProviderId not registered")
      return
    }
    val key = try {
      Base64.decode(keyBase64, Base64.NO_WRAP)
    } catch (e: IllegalArgumentException) {
      promise.reject("KP_BAD_KEY", "key was not valid base64", e)
      return
    }
    if (key.size != 32) {
      promise.reject("KP_BAD_KEY", "expected 32-byte AES-256 key, got ${key.size}")
      return
    }
    try {
      promise.resolve(kp.setKey(participantId, index, key))
    } catch (t: Throwable) {
      Log.e(TAG, "setKey failed", t)
      promise.reject("KP_SET_FAILED", t.message, t)
    }
  }

  @ReactMethod
  fun ratchetKey(
    keyProviderId: String,
    participantId: String,
    index: Int,
    promise: Promise,
  ) {
    val kp = keyProviders[keyProviderId]
    if (kp == null) {
      promise.reject("KP_NOT_FOUND", "key provider $keyProviderId not registered")
      return
    }
    try {
      val next = kp.ratchetKey(participantId, index)
      if (next == null) {
        promise.resolve(null)
      } else {
        promise.resolve(Base64.encodeToString(next, Base64.NO_WRAP))
      }
    } catch (t: Throwable) {
      Log.e(TAG, "ratchetKey failed", t)
      promise.reject("KP_RATCHET_FAILED", t.message, t)
    }
  }

  @ReactMethod
  fun attachSenderCryptor(
    keyProviderId: String,
    peerConnectionId: Int,
    senderId: String,
    participantId: String,
    promise: Promise,
  ) {
    val kp = keyProviders[keyProviderId]
    if (kp == null) {
      promise.reject("KP_NOT_FOUND", "key provider $keyProviderId not registered")
      return
    }
    val webrtc = reactApplicationContext.getNativeModule(WebRTCModule::class.java)
    if (webrtc == null) {
      promise.reject("WEBRTC_MODULE_MISSING", "WebRTCModule not available")
      return
    }
    val sender = webrtc.getRtpSenderById(peerConnectionId, senderId)
    if (sender == null) {
      promise.reject("SENDER_NOT_FOUND", "RtpSender $senderId not found on pc=$peerConnectionId")
      return
    }
    val factory = webrtc.peerConnectionFactory
    if (factory == null) {
      promise.reject("FACTORY_MISSING", "PeerConnectionFactory not initialised")
      return
    }
    try {
      val cryptor = FrameCryptorFactory.createFrameCryptorForRtpSender(
        factory,
        sender,
        participantId,
        FrameCryptorAlgorithm.AES_GCM,
        kp,
      )
      // Why: cryptors start disabled; the JS side enables only after the
      // participant key for the current epoch has been pushed via setKey.
      cryptor.setEnabled(false)
      val id = UUID.randomUUID().toString()
      cryptors[id] = cryptor
      promise.resolve(id)
    } catch (t: Throwable) {
      Log.e(TAG, "attachSenderCryptor failed", t)
      promise.reject("CRYPTOR_ATTACH_FAILED", t.message, t)
    }
  }

  @ReactMethod
  fun attachReceiverCryptor(
    keyProviderId: String,
    peerConnectionId: Int,
    receiverId: String,
    participantId: String,
    promise: Promise,
  ) {
    val kp = keyProviders[keyProviderId]
    if (kp == null) {
      promise.reject("KP_NOT_FOUND", "key provider $keyProviderId not registered")
      return
    }
    val webrtc = reactApplicationContext.getNativeModule(WebRTCModule::class.java)
    if (webrtc == null) {
      promise.reject("WEBRTC_MODULE_MISSING", "WebRTCModule not available")
      return
    }
    val receiver = webrtc.getRtpReceiverById(peerConnectionId, receiverId)
    if (receiver == null) {
      promise.reject("RECEIVER_NOT_FOUND", "RtpReceiver $receiverId not found on pc=$peerConnectionId")
      return
    }
    val factory = webrtc.peerConnectionFactory
    if (factory == null) {
      promise.reject("FACTORY_MISSING", "PeerConnectionFactory not initialised")
      return
    }
    try {
      val cryptor = FrameCryptorFactory.createFrameCryptorForRtpReceiver(
        factory,
        receiver,
        participantId,
        FrameCryptorAlgorithm.AES_GCM,
        kp,
      )
      cryptor.setEnabled(false)
      val id = UUID.randomUUID().toString()
      cryptors[id] = cryptor
      promise.resolve(id)
    } catch (t: Throwable) {
      Log.e(TAG, "attachReceiverCryptor failed", t)
      promise.reject("CRYPTOR_ATTACH_FAILED", t.message, t)
    }
  }

  @ReactMethod
  fun setCryptorEnabled(cryptorId: String, enabled: Boolean, promise: Promise) {
    val cryptor = cryptors[cryptorId]
    if (cryptor == null) {
      promise.reject("CRYPTOR_NOT_FOUND", "cryptor $cryptorId not registered")
      return
    }
    try {
      cryptor.setEnabled(enabled)
      promise.resolve(null)
    } catch (t: Throwable) {
      Log.e(TAG, "setCryptorEnabled failed", t)
      promise.reject("CRYPTOR_SET_ENABLED_FAILED", t.message, t)
    }
  }

  @ReactMethod
  fun setCryptorKeyIndex(cryptorId: String, index: Int, promise: Promise) {
    val cryptor = cryptors[cryptorId]
    if (cryptor == null) {
      promise.reject("CRYPTOR_NOT_FOUND", "cryptor $cryptorId not registered")
      return
    }
    try {
      cryptor.setKeyIndex(index)
      promise.resolve(null)
    } catch (t: Throwable) {
      Log.e(TAG, "setCryptorKeyIndex failed", t)
      promise.reject("CRYPTOR_SET_KEY_INDEX_FAILED", t.message, t)
    }
  }

  @ReactMethod
  fun disposeCryptor(cryptorId: String, promise: Promise) {
    val cryptor = cryptors.remove(cryptorId)
    if (cryptor == null) {
      promise.resolve(null)
      return
    }
    try {
      cryptor.dispose()
      promise.resolve(null)
    } catch (t: Throwable) {
      Log.e(TAG, "disposeCryptor failed", t)
      promise.reject("CRYPTOR_DISPOSE_FAILED", t.message, t)
    }
  }

  @ReactMethod
  fun disposeKeyProvider(keyProviderId: String, promise: Promise) {
    val kp = keyProviders.remove(keyProviderId)
    if (kp == null) {
      promise.resolve(null)
      return
    }
    try {
      kp.dispose()
      promise.resolve(null)
    } catch (t: Throwable) {
      Log.e(TAG, "disposeKeyProvider failed", t)
      promise.reject("KP_DISPOSE_FAILED", t.message, t)
    }
  }

  companion object {
    private const val TAG = "BravoFrameCryptor"
  }
}
