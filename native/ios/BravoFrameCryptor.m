//
//  BravoFrameCryptor.m — RN bridge declarations for the Swift module
//  (B-111-B). Method names/signatures MUST stay in lockstep with both
//  BravoFrameCryptor.swift and the JS contract in
//  src/modules/messenger/webrtc/frameCryptorTransport.ts.
//
#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE (BravoFrameCryptor, NSObject)

RCT_EXTERN__BLOCKING_SYNCHRONOUS_METHOD(isAvailable)

RCT_EXTERN_METHOD(createKeyProvider:(nonnull NSNumber *)ratchetWindowSize
                  failureTolerance:(nonnull NSNumber *)failureTolerance
                  keyRingSize:(nonnull NSNumber *)keyRingSize
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(setKey:(NSString *)keyProviderId
                  participantId:(NSString *)participantId
                  index:(nonnull NSNumber *)index
                  keyBase64:(NSString *)keyBase64
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(ratchetKey:(NSString *)keyProviderId
                  participantId:(NSString *)participantId
                  index:(nonnull NSNumber *)index
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(attachSenderCryptor:(NSString *)keyProviderId
                  peerConnectionId:(nonnull NSNumber *)peerConnectionId
                  senderId:(NSString *)senderId
                  participantId:(NSString *)participantId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(attachReceiverCryptor:(NSString *)keyProviderId
                  peerConnectionId:(nonnull NSNumber *)peerConnectionId
                  receiverId:(NSString *)receiverId
                  participantId:(NSString *)participantId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(setCryptorEnabled:(NSString *)cryptorId
                  enabled:(BOOL)enabled
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(setCryptorKeyIndex:(NSString *)cryptorId
                  index:(nonnull NSNumber *)index
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(disposeCryptor:(NSString *)cryptorId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(disposeKeyProvider:(NSString *)keyProviderId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
