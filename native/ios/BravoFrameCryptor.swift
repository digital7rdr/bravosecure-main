//
//  BravoFrameCryptor.swift — iOS twin of BravoFrameCryptorModule.kt (B-111-B).
//
//  Mirrors the Android module METHOD-FOR-METHOD (same names, argument order,
//  resolve/reject codes) so src/modules/messenger/webrtc/frameCryptorTransport.ts
//  needs zero platform branches. Source-of-truth for semantics:
//  android/app/src/main/java/com/bravosecure/app/BravoFrameCryptorModule.kt.
//
//  Depends on the WebRTC-SDK pod (module `WebRTC`, standard RTC* symbols —
//  LiveKit's cocoapods distribution ships UN-prefixed classes; only their
//  SPM xcframework uses LKRTC) pulled in by the @livekit/react-native-webrtc
//  fork (npm alias — see
//  docs/handoffs/IOS_FRAMECRYPTOR_B111B_IMPLEMENTATION_2026-07-18.md §1/§8).
//  FrameCryptor runs AES-256-GCM on encoded frames BEFORE SRTP, so the SFU
//  (which terminates DTLS-SRTP) only ever sees frame-ciphertext. The S6
//  refusal in useGroupCall stays authoritative: if this module is absent or
//  isAvailable() is false, group calls refuse to start — fail-closed.
//
//  This file lives in native/ios/ (checked in) and is COPIED into the
//  generated ios/ project by plugins/withBravoFrameCryptor.js at prebuild,
//  because ios/ is gitignored and regenerated.
//
import Foundation
import WebRTC
import React

@objc(BravoFrameCryptor)
class BravoFrameCryptor: NSObject {

  // RN bridge — injected by RCT_EXTERN_MODULE machinery.
  @objc var bridge: RCTBridge!

  // Registries — the ConcurrentHashMap twins. All mutations behind a serial
  // queue: RN promise blocks can land on arbitrary threads.
  private let lock = DispatchQueue(label: "com.bravosecure.framecryptor")
  private var keyProviders: [String: RTCFrameCryptorKeyProvider] = [:]
  private var cryptors: [String: RTCFrameCryptor] = [:]

  @objc static func requiresMainQueueSetup() -> Bool { false }

  // MARK: - isAvailable (blocking-synchronous, like the Kotlin
  // isBlockingSynchronousMethod). Kotlin probes Class.forName on the three
  // FrameCryptor classes; the ObjC runtime twin is NSClassFromString. The
  // compile-time `import WebRTC` already guarantees presence in a
  // correctly-built binary — the runtime probe is the belt-and-braces the
  // JS contract expects (false ⇒ S6 refuses, never a crash).
  @objc func isAvailable() -> NSNumber {
    // Why: probe ONLY the classes this module actually instantiates.
    // RTCFrameCryptorFactory was also required here, but no such class ships
    // in WebRTC-SDK 125.6422.07 (`nm` over WebRTC.framework finds zero symbol
    // and zero string matches) and nothing in this file ever references it.
    // That term therefore made the probe return false 100% of the time on
    // iOS, so isAvailable() reported unavailable and every group call hit the
    // B-111-A refusal. Fail-closed is unchanged: if either class below is
    // absent the probe still returns false and the S6 refusal still fires.
    let ok = NSClassFromString("RTCFrameCryptor") != nil
      && NSClassFromString("RTCFrameCryptorKeyProvider") != nil
    if !ok {
      NSLog("[BravoFrameCryptor] FrameCryptor classes not found — LiveKitWebRTC framework missing?")
    }
    return NSNumber(value: ok)
  }

  // MARK: - Key provider

  @objc func createKeyProvider(
    _ ratchetWindowSize: NSNumber,
    failureTolerance: NSNumber,
    keyRingSize: NSNumber,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    // EXACT Android parity (interop invariant — §3 of the plan):
    // salt "bravo-sframe-v1" UTF-8, sharedKeyMode=false, empty magic bytes,
    // discardFrameWhenCryptorNotReady=true.
    guard let salt = "bravo-sframe-v1".data(using: .utf8) else {
      reject("KP_CREATE_FAILED", "salt encoding failed", nil)
      return
    }
    let kp = RTCFrameCryptorKeyProvider(
      ratchetSalt: salt,
      ratchetWindowSize: ratchetWindowSize.int32Value,
      sharedKeyMode: false,
      uncryptedMagicBytes: Data(),
      failureTolerance: failureTolerance.int32Value,
      keyRingSize: keyRingSize.int32Value,
      discardFrameWhenCryptorNotReady: true
    )
    let id = UUID().uuidString
    lock.sync { keyProviders[id] = kp }
    resolve(id)
  }

  @objc func setKey(
    _ keyProviderId: String,
    participantId: String,
    index: NSNumber,
    keyBase64: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let kp = lock.sync(execute: { keyProviders[keyProviderId] }) else {
      reject("KP_NOT_FOUND", "key provider \(keyProviderId) not registered", nil)
      return
    }
    guard let key = Data(base64Encoded: keyBase64) else {
      reject("KP_BAD_KEY", "key was not valid base64", nil)
      return
    }
    guard key.count == 32 else {
      reject("KP_BAD_KEY", "expected 32-byte AES-256 key, got \(key.count)", nil)
      return
    }
    // ObjC setKey returns void (Android's returns Bool) — resolve true on
    // non-throwing completion so the JS contract (Promise<boolean>) holds.
    kp.setKey(key, with: index.int32Value, forParticipant: participantId)
    resolve(true)
  }

  @objc func ratchetKey(
    _ keyProviderId: String,
    participantId: String,
    index: NSNumber,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let kp = lock.sync(execute: { keyProviders[keyProviderId] }) else {
      reject("KP_NOT_FOUND", "key provider \(keyProviderId) not registered", nil)
      return
    }
    let next = kp.ratchetKey(participantId, with: index.int32Value)
    if next.isEmpty {
      resolve(nil)
    } else {
      resolve(next.base64EncodedString())
    }
  }

  // MARK: - Cryptor attach (sender / receiver)

  @objc func attachSenderCryptor(
    _ keyProviderId: String,
    peerConnectionId: NSNumber,
    senderId: String,
    participantId: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    attachCryptor(
      keyProviderId: keyProviderId, peerConnectionId: peerConnectionId,
      trackPointId: senderId, participantId: participantId, isSender: true,
      resolve: resolve, reject: reject)
  }

  @objc func attachReceiverCryptor(
    _ keyProviderId: String,
    peerConnectionId: NSNumber,
    receiverId: String,
    participantId: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    attachCryptor(
      keyProviderId: keyProviderId, peerConnectionId: peerConnectionId,
      trackPointId: receiverId, participantId: participantId, isSender: false,
      resolve: resolve, reject: reject)
  }

  private func attachCryptor(
    keyProviderId: String,
    peerConnectionId: NSNumber,
    trackPointId: String,
    participantId: String,
    isSender: Bool,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let kp = lock.sync(execute: { keyProviders[keyProviderId] }) else {
      reject("KP_NOT_FOUND", "key provider \(keyProviderId) not registered", nil)
      return
    }
    // The fork's WebRTCModule (ObjC) owns the peerConnection map and the
    // factory. KVC keeps us independent of header visibility — the exact
    // mirror of the Android patch accessors without patching the fork.
    // (Plan §4; if a fork update renames these ivars the errors below fire
    // loudly instead of crashing.)
    guard let webrtc = bridge?.module(forName: "WebRTCModule") as? NSObject else {
      reject("WEBRTC_MODULE_MISSING", "WebRTCModule not available", nil)
      return
    }
    guard
      let pcMap = webrtc.value(forKey: "peerConnections") as? NSDictionary,
      let pc = pcMap[peerConnectionId] as? RTCPeerConnection
    else {
      reject(
        isSender ? "SENDER_NOT_FOUND" : "RECEIVER_NOT_FOUND",
        "peerConnection \(peerConnectionId) not found in WebRTCModule", nil)
      return
    }
    guard let factory = webrtc.value(forKey: "peerConnectionFactory") as? RTCPeerConnectionFactory else {
      reject("FACTORY_MISSING", "PeerConnectionFactory not initialised", nil)
      return
    }

    let cryptor: RTCFrameCryptor?
    if isSender {
      guard let sender = pc.senders.first(where: { $0.senderId == trackPointId }) else {
        reject("SENDER_NOT_FOUND", "RtpSender \(trackPointId) not found on pc=\(peerConnectionId)", nil)
        return
      }
      cryptor = RTCFrameCryptor(
        factory: factory, rtpSender: sender, participantId: participantId,
        algorithm: .aesGcm, keyProvider: kp)
    } else {
      guard let receiver = pc.receivers.first(where: { $0.receiverId == trackPointId }) else {
        reject("RECEIVER_NOT_FOUND", "RtpReceiver \(trackPointId) not found on pc=\(peerConnectionId)", nil)
        return
      }
      cryptor = RTCFrameCryptor(
        factory: factory, rtpReceiver: receiver, participantId: participantId,
        algorithm: .aesGcm, keyProvider: kp)
    }
    guard let built = cryptor else {
      reject("CRYPTOR_ATTACH_FAILED", "FrameCryptor init returned nil", nil)
      return
    }
    // Android parity: cryptors start DISABLED; JS enables only after the
    // participant key for the current epoch has been pushed via setKey.
    built.enabled = false
    let id = UUID().uuidString
    lock.sync { cryptors[id] = built }
    resolve(id)
  }

  // MARK: - Cryptor controls

  @objc func setCryptorEnabled(
    _ cryptorId: String,
    enabled: Bool,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let cryptor = lock.sync(execute: { cryptors[cryptorId] }) else {
      reject("CRYPTOR_NOT_FOUND", "cryptor \(cryptorId) not registered", nil)
      return
    }
    cryptor.enabled = enabled
    resolve(nil)
  }

  @objc func setCryptorKeyIndex(
    _ cryptorId: String,
    index: NSNumber,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let cryptor = lock.sync(execute: { cryptors[cryptorId] }) else {
      reject("CRYPTOR_NOT_FOUND", "cryptor \(cryptorId) not registered", nil)
      return
    }
    cryptor.keyIndex = index.int32Value
    resolve(nil)
  }

  // MARK: - Disposal (idempotent — resolve null when already gone, exactly
  // like the Kotlin module, because cleanup must succeed mid-teardown).

  @objc func disposeCryptor(
    _ cryptorId: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    let cryptor = lock.sync { cryptors.removeValue(forKey: cryptorId) }
    cryptor?.enabled = false
    resolve(nil)
  }

  @objc func disposeKeyProvider(
    _ keyProviderId: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    _ = lock.sync { keyProviders.removeValue(forKey: keyProviderId) }
    resolve(nil)
  }
}
