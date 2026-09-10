// Platform-agnostic messenger core. Mobile is the source of truth; ops-console
// re-imports from here. Anything that touches RN, op-sqlite, Keychain, or any
// other native module MUST stay in src/modules/messenger and be re-exported
// from there.

export * from './crypto/types';
export * from './crypto/errors';
export {SessionManager} from './crypto/sessionManager';
export {InMemoryProtocolStore} from './crypto/inMemoryStore';
export {
  installIdentity,
  buildOwnPreKeyBundle,
  // Audit P0-I1 — signed-prekey rotation primitives.
  shouldRotateSignedPreKey,
  rotateSignedPreKey,
  currentSignedPreKeyId,
  SIGNED_PRE_KEY_ROTATION_INTERVAL_MS,
  SIGNED_PRE_KEY_RETENTION_MS,
  type RotateSignedPreKeyResult,
} from './crypto/identity';
export {toBase64, fromBase64, addressKey} from './crypto/encoding';
export {
  sealPayload,
  unsealPayload,
  verifySealedAad,
  _getVersionRejectStats,
  SEALED_AAD_SKEW_MS,
  SEALED_AAD_FUTURE_MS,
  SEALED_AAD_MAX_AGE_MS,
  MENTIONS_MAX,
  MENTION_LABEL_MAX_CHARS,
  EDIT_BODY_MAX_CHARS,
  type SealedPayload,
  type SealedAttachment,
  type SealedMention,
  type SealedGroup,
  type SealedAad,
  type SealOptions,
  type VerifyAadParams,
} from './crypto/sealedSender';
export {
  wrapOuter,
  unwrapOuter,
  type WrapOuterParams,
  type UnwrapOuterParams,
  type UnwrappedOuter,
} from './crypto/outerEcies';
export {
  verifySenderCert,
  IdentityKeyMismatchError,
  type SenderCertClaims,
  type VerifyCertParams,
} from './crypto/senderCert';
export {
  signBundleBinding,
  verifyBundleBinding,
  bundleBindingSigningInput,
  BUNDLE_BINDING_VERSION,
  type BundleAuthoritySig,
  type VerifyBundleBindingParams,
} from './crypto/bundleBinding';
export {
  signCallOfferAuth,
  verifyCallOfferAuth,
  canonicalCallOfferAuthBytes,
  CALL_OFFER_AAD_SKEW_MS,
  type CallOfferAuth,
  type CallOfferAad,
  type CallOfferAuthAddress,
  type CallOfferAuthResult,
  type CallOfferAuthFailReason,
  type SignCallOfferAuthParams,
  type VerifyCallOfferAuthParams,
} from './crypto/callOfferAuth';
// Audit P1-C2 + P1-C3 — caller-identity binding for mid-call control
// frames (`call.answer` and `call.media-state`). Same XEd25519-over-
// identity-key pattern as S7 / callOfferAuth, with a per-kind body
// hash that binds the AAD to exactly one frame type.
export {
  signCallControlAuth,
  verifyCallControlAuth,
  callControlBodyHash,
  canonicalCallControlAuthBytes,
  CALL_CONTROL_AAD_SKEW_MS,
  type CallControlAuth,
  type CallControlAad,
  type CallControlAuthAddress,
  type CallControlAuthResult,
  type CallControlAuthFailReason,
  type CallControlKind,
  type SignCallControlAuthParams,
  type VerifyCallControlAuthParams,
} from './crypto/callControlAuth';
export {
  groupEncrypt,
  groupDecrypt,
  isGroupCiphertext,
  disposeGroupKey,
  disposeAllGroupKeys,
  type GroupCiphertext,
} from './crypto/groupCrypto';

export * from './groups/types';
export {
  broadcastToGroup,
  parseGroupMessage,
  applyAdminAction,
  makeNewGroup,
  makeAssignedGroup,
  deriveGroupId,
  verifyGroupIdDerivation,
  isGroupMember,
  genFreshGroupMasterKey,
  planRemoveAndRekey,
  planAddAndRekey,
  planLeaveAndRekey,
  deriveRekeyMasterKey,
  signGroupCreate,
  verifyGroupCreateSignature,
  canonicalCreateBytes,
  type BroadcastParams,
  type BroadcastResult,
  type ParseGroupResult,
} from './groups/groupClient';

// Re-export transport/protocol selectively. `SessionAddress` and `Ciphertext`
// are also defined in crypto/types (kept structurally identical on purpose —
// see protocol.ts header). We export those from crypto/types only to avoid
// an ambiguous-re-export error.
export type {
  ClientPing,
  ClientAuthRefresh,
  ClientEnvelopeSend,
  ClientEnvelopeAck,
  ClientEnvelopePull,
  ClientCallOffer,
  ClientCallAnswer,
  ClientCallIce,
  ClientCallHangup,
  ClientCallMediaState,
  ClientCallReOffer,
  ClientCallReAnswer,
  ClientTyping,
  ClientReadReceipt,
  ClientPresence,
  ClientPresenceSubscribe,
  ClientPresenceUnsubscribe,
  ClientFrame,
  ServerPong,
  ServerEnvelopeAccepted,
  ServerEnvelopeDeliver,
  ServerError,
  ServerCallOffer,
  ServerCallAnswer,
  ServerCallIce,
  ServerCallHangup,
  ServerCallMediaState,
  ServerCallReOffer,
  ServerCallReAnswer,
  ServerTyping,
  ServerReadReceipt,
  ServerPresence,
  ServerFrame,
  CallId,
} from './transport/protocol';
export {
  WS_CLOSE_UNAUTHORIZED,
  WS_CLOSE_POLICY,
  WS_CLOSE_HEARTBEAT,
} from './transport/protocol';
export {
  TransportClient,
  SERVER_SILENCE_DEAD_MS,
  type TransportState,
  type TransportOptions,
} from './transport/client';
export {
  RelayHttpClient,
  RelayHttpError,
  type RelayEnvelope,
  type RelayHttpClientOptions,
  type RelayReceiptOutcome,
} from './transport/relayClient';
// OR-2 — exported so the client's DRAIN_STUCK_MS invariant test can pin
// "stuck window > one transport deadline" against the real constant.
// B-697 ROOT CAUSE (2026-08-29) — `fetchWithTimeout` itself was never
// exported here, only the constant beside it. The mobile keysClient imports
// it from THIS barrel, so its binding resolved to undefined and every method
// of that client threw `TypeError: fetchWithTimeout is not a function`
// before a byte reached the network — which mintActionToken swallowed into
// the "server declined the vault MFA challenge" dialog on every build. The
// TS2305 for it sat inside the tsc baseline allowance the whole time.
// Documented-then-flipped by transportKeysClientFetchBinding.test.ts.
export {TRANSPORT_TIMEOUT_MS, fetchWithTimeout, isTimeoutError} from './transport/fetchWithTimeout';
export {
  KeysHttpClient,
  KeysHttpError,
  type KeysHttpClientOptions,
} from './transport/keysClient';
export {
  SenderCertClient,
  SenderCertHttpError,
  type IssuedCert,
  type RevocationList,
  type SenderCertClientOptions,
} from './transport/senderCertClient';
export {
  UsersHttpClient,
  UsersHttpError,
  type DiscoveredContact,
  type UserProfile,
  type UsersHttpClientOptions,
  type Me,
  type BlockedUser,
} from './transport/usersClient';

export {SenderCertCache} from './runtime/certCache';
export {
  RevokedJtiCache,
  REVOCATION_FRESHNESS_MS,
  type RevokedJtiCacheOptions,
} from './runtime/revokedJtiCache';

export {
  SframeSender,
  SframeReceiver,
  ReplayWindow,
  deriveSframeBaseKey,
  parseFrameHeader,
  SFRAME_VERSION,
  SFRAME_HEADER_LEN,
  SFRAME_TAG_LEN,
  SFRAME_REPLAY_WINDOW_BITS,
  SFRAME_KIND_AUDIO,
  SFRAME_KIND_VIDEO,
  type MediaKind as SframeMediaKind,
  type ParsedFrameHeader,
} from './calls/sframe';
export {
  GroupCallEncryption,
  type GroupKeySource,
  type GroupCallEncryptionOptions,
} from './calls/groupCallEncryption';
// Native FrameCryptor key schedule (used by the mobile FrameCryptor
// orchestrator — see src/modules/messenger/webrtc/frameCryptorOrchestrator.ts).
export {
  deriveParticipantKey,
  epochToKeyIndex,
  KEY_RING_SIZE as FRAME_CRYPTOR_KEY_RING_SIZE,
} from './calls/frameCryptorKeys';
