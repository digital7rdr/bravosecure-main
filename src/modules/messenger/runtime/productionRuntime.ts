import {KeyHelper} from '@privacyresearch/libsignal-protocol-typescript';
import {beginArchiveReplay, endArchiveReplay, loadConversationTombstones} from '../backup/conversationTombstones';
import {
  SessionManager,
  installIdentity,
  buildOwnPreKeyBundle,
  // Audit P0-I1 — signed-prekey rotation primitives.
  shouldRotateSignedPreKey,
  rotateSignedPreKey,
  currentSignedPreKeyId,
  sealPayload,
  unsealPayload,
  verifySealedAad,
  verifySenderCert,
  wrapOuter,
  unwrapOuter,
  toBase64,
  fromBase64,
  computeSafetyNumber,
  type CryptoStore,
  type Ciphertext,
  type SessionAddress,
} from '../crypto';
import type {PreKeyBundle} from '@bravo/messenger-core';
// B-701 — send-side rotation flag: noted by the seal lane
// (recipientIdentityKeyB64Cached), consumed one-shot in
// ensureOutgoingSession's fast path.
import {takePeerRotationSuspected, notePeerRotationSuspected} from '../crypto/peerRotationFlag';
import {DecryptError, IdentityKeyMismatchError, parseGroupMessage, applyAdminAction, broadcastToGroup, makeNewGroup, makeAssignedGroup, signGroupCreate, groupEncrypt, disposeGroupKey, signCallOfferAuth as coreSignCallOfferAuth, isGroupMember, type CallOfferAuth, type GroupState, type GroupPhotoRef} from '@bravo/messenger-core';
import {
  rememberSuccessfulDecrypt, hasRecentSuccessfulDecrypt,
  shouldAttemptRebuild, markRebuildAttempt, clearRebuildAttempt,
  attachHealthStore,
} from './sessionWipeProtection';
import {unwrapPlaintextGroupInnerBody} from './groupInboundBody';
import {
  isRecoverableDecryptError,
  decideRecoveryDisposition,
  LeaveOnRelayError,
  clear as clearFirstMsgRetryBudget,
} from './firstMessageRetryBudget';
import {
  selectGroupIdsToDrain,
  shouldBumpStashAttempt,
  ReplayNeedsKeyError,
} from './bootGroupStashDrain';
import {selectUndeliverableResend} from './undeliverableResend';
import {shouldDrainOnServerSignal, DRAIN_STUCK_MS} from './sendRecoveryClock';
import {enqueueAck, flushAckQueue, disposeAckQueue} from '../transport/ackQueue';
import {PeerSessionHealthStore} from '../store/peerSessionHealthStore';
import {
  PendingGroupEnvelopeStore,
  PENDING_GROUP_MAX_ATTEMPTS,
} from '../store/pendingGroupEnvelopeStore';
import {
  PendingAdminActionStore,
  PENDING_ADMIN_MAX_ATTEMPTS,
} from '../store/pendingAdminActionStore';
import {
  TransportClient,
  RelayHttpClient,
  KeysHttpClient,
  SenderCertClient,
  SenderCertCache,
  RevokedJtiCache,
  UsersHttpClient,
  SERVER_SILENCE_DEAD_MS,
  type ServerFrame,
  type ServerEnvelopeAccepted,
  type ServerEnvelopeDeliver,
  type SealedPayload,
} from '@bravo/messenger-core';
import {ExpirySweeper} from './expirySweeper';
import {
  hydratePeerIdentityAcks,
  notePeerIdentityChanged,
  hasPendingIdentityAck,
  acknowledgePeerIdentity,
  isIdentitySendGateEnabled,
} from '../store/peerIdentityAckStore';
import {runWithRatchetTxn, runOnTxnChain, isTransientSqlError, chainPendingCount, onRollback, type TxnDbHandle} from './receiveTransaction';
import {tryAcquireEnvelope, releaseEnvelope, resetInflightRegistry, isEnvelopeInFlight} from './inflightEnvelopes';
import {isCallFrame, isGroupRingFrame} from './callFrameRouter';
import {applyEnvelopeDelivered} from './envelopeDelivered';
import {
  upsertKeylessGroupPlaceholder,
  resolveKeyRequestTargets,
  selectKeyResyncCandidates,
  selectCallContaminationCleanup,
} from './groupConversationUpsert';
import {
  noteDestroyedEnvelope,
  takeDestroyedEnvelope,
  insertDecryptFailurePlaceholder,
  reconcileRecoveredPlaceholder,
  applyEnvelopeUndeliverable,
} from './decryptFailureSignal';
import {ackDispositionFor} from './ackDisposition';
import {failedPullReport, pullReportFromIds, type RelayPullReport} from './relayPullReport';
// B-703 MR-12 — one gate for every outbox kick (six sites, one rule).
import {areMessagesHydrated, awaitMessagesHydrated, markMessagesHydrated, resetMessagesHydratedGate} from './messagesHydratedGate';
import {acceptedDuringAttempt, hasAcceptanceArtifact, snapshotAcceptance, wasSendAccepted} from './sendAcceptance';
import {shouldDropExpiredPayload} from './expiredEnvelopeGate';
import {reconcileHttpReceipts, resetReceiptReconcile} from './httpReceiptReconcile';
import {
  loadCallKeyRegistry,
  resolveCallKeyGroupId,
  setCallKeyMapping,
} from './callKeyRegistry';
import {
  TypingWatchdog,
  isGroupConversation,
  isDeviceLocalGroupId,
  reactionRecipients,
  typingConversationTag,
  typingAffectedConversationIds,
  readReceiptAccepted,
  readReceiptEnvelopeMatch,
  groupSendBlockedReason,
  isGroupKeyPendingError,
  GROUP_KEY_PENDING_SEND_ERROR,
  DIRECT_CONVERSATION_KEY,
  isCallGroupState,
  CALL_GROUP_NAME,
} from './messagingLogic';
import {directConvoAadId} from './aadBinding';
import {isDirectPrefixed, peerFromDirectSlot} from '../conversationIds';
import {admitSenderCert} from './senderCertAdmit';
import {gatewayErrorDisposition} from './gatewayErrorPolicy';
import {useMessengerStore, directConversationSlots, registerDraftSink, runWriteThroughSuppressed, isWriteThroughSuppressedNow} from '../store/messengerStore';
import {getReadReceiptsEnabledCached, loadReadReceiptsEnabled} from '../store/privacySettings';
import {isPeerBlocked, loadBlockedPeers, setBlockedPeers} from './blockedPeers';
import {isRestoreTombstoned, loadRestoreTombstones} from '../backup/restoreTombstones';
import {SqlMessageStore} from '../store/sqlMessageStore';
import {SqlOutboxStore, classifyOutboxFailure, isPermanentRelayRejection, type OutboxRow} from '../store/sqlOutboxStore';
import {
  planOutboxDrain,
  buildDirectSealedOutboxPayload,
  buildReactionSealedOutboxPayload,
  buildMutationSealedOutboxPayload,
  type DeferredDirectOutboxPayload,
  type DeferredGroupOutboxPayload,
  type MutationDirective,
  type ResealOutboxFn,
} from './deferredOutbox';
import {
  groupRowsByPeer,
  runOutboxLanes,
  OUTBOX_DRAIN_LANE_LIMIT,
} from './outboxLanes';
import {resolveResealAadTs} from './outboxResealTimestamp';
import {orderingCreatedAt} from './orderingClock';
import {
  applyReactionInWindow,
  applyReaction as applyReactionDurable,
  drainPendingReactionsFor,
  sweepPendingReactions,
  setPendingReactionStore,
} from './pendingReactionApply';
import {applyReactionLane, type ReactionLaneDeps} from './applyReactionLane';
import {
  applyMessageMutation,
  drainPendingMutationsFor,
  sweepPendingMutations,
  setPendingMutationStore,
} from './messageMutationApply';
import {canEditOwnMessage, canDeleteForEveryone} from './messageMutationGate';
import {reconcileMentions, expandAllMentions} from './mentionText';
import {PendingMutationStore} from '../store/pendingMutationStore';
import {applyDirectText} from './applyDirectText';
import {applyGroupText} from './applyGroupText';
import {applyGroupAdmin} from './applyGroupAdmin';
import {buildInboundMessage, mentionsFrom, REPLY_PREVIEW_MAX_CHARS, sentAtFromAad} from './inboundMessageBuilder';
import {mergeReaction} from './reactionMerge';
import {PendingReactionStore} from '../store/pendingReactionStore';
import {shouldStopDrain} from './outboxDrainBudget';
import {withRelaySendSlot, resetRelaySendPacer} from './relaySendPacer';
import {createRerunCoalescer, MAX_COALESCER_RERUNS, type CoalescerRunCtx} from './rerunCoalescer';
import {
  appendGroupPhotoChangedEvent,
  appendMemberAddedEvent,
  appendMemberRemovedEvent,
} from './groupEventMessage';
import {applyGroupRenameToUi} from './applyGroupRename';
import {applyMemberRemovalToUi} from './applyMemberRemoval';
import {normalizeGroupName} from './groupNameRules';
import {SeenEnvelopeStore} from '../store/seenEnvelopeStore';
import {SqlCipherProtocolStore} from '../crypto/sqlCipherStore';
import {resolveExpectedSenderIdentity} from '../crypto/expectedSenderIdentity';
import {
  peerIdentityCacheKey,
  recipientIdentityKeyB64,
  recipientIdentityKeyB64Cached,
  clearNegativeFetchCooldown,
  type PeerIdentityCache,
} from '../crypto/peerIdentityCache';
import {MediaBlobCache} from '../media/mediaBlobCache';
import {MediaClient} from '../media/mediaClient';
import {readUriBytes} from '../media/mediaFiles';
import {log as crashLog, recordError as crashRecord} from '../../observability/crashlytics';
import type {LocalMessage} from '../store/types';
import type {MessengerRuntime, SendTextOptions} from './runtime';

/**
 * B-703 MR-7 / MESSAGE_LOOP M9 — undo the in-memory half of a receive that
 * rolls back.
 *
 * The receive txn writes the row to Zustand and to SQL together, but a ROLLBACK
 * only takes the SQL half back. The bubble survives, the envelope is acked
 * `'discarded'`, the server emits `envelope.undeliverable`, and the sender's
 * zero-tap auto-resend (B-46 1:1 / B-683 §3b group) ships the same message
 * again under a fresh wire id — so the recipient reads it twice. That is the
 * duplicate the founder reports, and it needs no user action to happen.
 *
 * Registering a compensation is only safe when the append genuinely ADDED a
 * row, which is why both facts are needed:
 *   - `committedId === null` — `appendMessage` deliberately dropped it (dedup).
 *     Nothing was added; removing anything would be destroying someone else's
 *     row.
 *   - the row already existed under this id — the append UPDATED a row that was
 *     there before the txn, and a rollback must leave it exactly as it found it.
 * A fork (`committedId !== msg.id`, the content-divergent collision path) IS a
 * new row and is compensated under the id the store actually committed.
 *
 * Failing to register is the safe direction: it leaves today's behaviour.
 */
function receiveRowExists(conversationId: string, messageId: string): boolean {
  return !!useMessengerStore.getState().messages[conversationId]?.some(r => r.id === messageId);
}

function compensateReceiveAppend(
  conversationId: string,
  wireId: string,
  existedBefore: boolean,
  committedId: string | null,
): void {
  if (!committedId) {return;}
  if (existedBefore && committedId === wireId) {return;}
  onRollback(() => {
    try { useMessengerStore.getState().removeMessage(conversationId, committedId); }
    catch { /* store torn down — the rollback is best-effort by contract */ }
  });
}

/**
 * Production MessengerRuntime — wires all four pieces together:
 *
 *   1. Crypto (M0):     own SessionManager + SQLCipher/InMemory store
 *   2. Auth keys (M5):  upload own bundle, fetch peer bundles on demand
 *   3. Sealed sender:   cert from auth-service, cached + refreshed
 *   4. Transport (M2/3): WS for push + real-time deliver, HTTP for
 *                       submit fallback and reconnect batch pull
 *
 * The runtime is a singleton per-user-session. Swap modes by calling
 * `_resetMessengerRuntime()` (test utility) or tearing the app down.
 */

export interface ProductionConfig {
  authBaseUrl:          string;   // e.g. http://10.0.2.2:3001
  messengerBaseUrl:     string;   // e.g. http://10.0.2.2:3100
  wsUrl:                string;   // e.g. ws://10.0.2.2:3100/ws
  getToken:             () => Promise<string | null>;
  /**
   * Round 2 fix: optional refresh hook plumbed into every HTTP client
   * (Keys / SenderCert / Relay / Users) and the WS transport. Without
   * this, the access-token expires silently mid-session and the user
   * is stuck — every HTTP fetch 401s, the WS unauthorized close stops
   * retrying, and the next backup mirror flush silently dies. Should
   * point at `refreshAccessTokenShared` from `@/services/api`.
   */
  refreshToken?:        () => Promise<void>;
  signalDeviceId?:      number;   // default 1 (Phase-1 single-device)
  authorityPubKeyB64:   string;   // 32-byte Curve25519 pubkey, base64 — verifies XEd25519 sender certs
  /**
   * The logged-in user's userId — needed to build our own address and
   * to prevent us from fetching our own bundle by accident. This is
   * the auth-service UUID; it can rotate across re-registrations in
   * dev, so we don't use it for local persistence — see `ownerKey`.
   */
  ownUserId:            string;
  /**
   * Stable persistence key — typically the user's email or phone, the
   * same value used by `messengerStore.setOwner`. Used to scope the
   * SQLCipher DB filename and the keychain entry so messages survive
   * a re-register that mints a new ownUserId. Falls back to ownUserId
   * if not provided (matches Phase-1 behavior).
   */
  ownerKey?:            string;
  /**
   * B-354 — true when this runtime is being built with NO UI (the killed-app
   * headless drain / notification-action lane). Marks the WS socket as a
   * background connection (auth `bg:'1'`) so the gateway keeps it out of
   * user-visible presence, and forces the activity replay to 'away'. The
   * MainNavigator (interactive) config never sets this.
   */
  backgroundBoot?:      boolean;
}

export interface ProductionRuntimeDeps {
  ownStore: CryptoStore;
  config:   ProductionConfig;
}

// Audit S10 — sealed-sender AAD policy. The previous fail-open path
// at the receive site silently accepted ciphertexts that omitted the
// AAD block, defeating the replay-protection feature documented in
// the threat model. We now require AAD by default; the EXPO_PUBLIC_
// SEALED_AAD_LEGACY env var re-enables the legacy fail-open path for
// the rare case that an older sender is still in flight.
const SEALED_AAD_LEGACY: boolean = (() => {
  const raw = (globalThis as {process?: {env?: Record<string, string | undefined>}})
    ?.process?.env?.EXPO_PUBLIC_SEALED_AAD_LEGACY;
  return raw === 'true';
})();
if (SEALED_AAD_LEGACY && typeof console !== 'undefined') {

  console.warn('[productionRuntime] SEALED_AAD_LEGACY enabled — sealed envelopes without AAD will be accepted. This MUST be off in production.');
}

// Module-level handle for the AppState subscription tied to the live
// runtime. Set inside buildProductionRuntime, removed before a new
// runtime is built. Without this, every re-login would stack another
// listener and the next foreground transition would call connect() N
// times in a tight loop.
let liveAppStateSub: {remove?: () => void} | null = null;
// Heartbeat ping interval. Mirrors `liveAppStateSub` — without a
// module-level slot, every re-login (auth state flip, restore-from-
// backup) would build a NEW runtime + a NEW heartbeat interval while
// the previous interval kept hitting `transport.send()` on a dead
// transport. Over a dozen re-logins (common in dev) we'd accumulate
// dozens of timers all firing every 4s.
let liveHeartbeat: ReturnType<typeof setInterval> | null = null;
// Restore-after-reinstall fix #3 — replay handle for archived sealed
// envelopes. Set by buildProductionRuntime to a closure that funnels a
// synthetic ServerEnvelopeDeliver frame through the live `deps`. The
// restore screen calls this after restoreAllMessages to drain the
// server-side sealed_envelope_archive into the local store.
let liveReplayArchive:
  ((env: {envelopeId: string; outerSealed: string; timestampMs: number}) => Promise<void>)
  | null = null;
/**
 * Round 8 — defer the initial publishOwnBundle. Set to true by
 * BackupRestoreScreen via `setDeferBundlePublish(true)` BEFORE it
 * calls getMessengerRuntime, then back to false after restore completes
 * via `publishOwnBundleAfterRestore()`. Without this, the fresh
 * installIdentity bundle gets uploaded to auth-service and the server
 * detects "identity rotation" — wiping every OPK public the user's
 * peers hold sessions against.
 */
let deferBundlePublish = false;
let livePublishOwnBundle: (() => Promise<void>) | null = null;
export function setDeferBundlePublish(defer: boolean): void {
  deferBundlePublish = defer;
}
export async function publishOwnBundleAfterRestore(): Promise<void> {
  if (!livePublishOwnBundle) {
    console.warn('[bravo.runtime] publishOwnBundleAfterRestore — no live runtime yet');
    return;
  }
  await livePublishOwnBundle();
}
// Pending live runtime disposers — every subscribe()/setInterval()/
// setTimeout()/AppState-listener that the runtime owns adds its
// teardown fn here. _resetMessengerRuntime() unwinds them before
// constructing a new runtime so we never leak across rebuilds.
let liveDisposers: Array<() => void> = [];
// Live ExpirySweeper handle — must be `.stop()`-ed before installing
// a new one, otherwise the previous sweeper keeps firing against the
// previous user's store/db (already closed, so each sweep throws).
let liveSweeper: {stop: () => void} | null = null;
// BS-DISPOSE-LEAK — live RevokedJtiCache poll. Parked here so the NEXT
// disposeLiveRuntime() stops it; otherwise each logout→login leaks another
// 5-min revocation poll pinning the prior certClient/tokens in memory.
let liveRevokedJtiCache: {stop: () => void} | null = null;
/**
 * Round 6 / race fix — owner epoch. Every `buildProductionRuntime` call
 * bumps this counter and captures the value in its closures (transport
 * onFrame, onStateChange, AppState handler, coalescedDrain catch
 * blocks). Async work that fires AFTER a logout / user-switch checks
 * `myEpoch === currentOwnerEpoch` and bails when stale, so frames in
 * flight at the moment of signOut can never land on the new user's
 * store. signOut → disposeLiveRuntime sets currentOwnerEpoch to a
 * sentinel `-1` so even before the next `buildProductionRuntime` runs,
 * any in-flight closure sees a mismatch and aborts.
 *
 * Without this guard the failure mode is: User A logs out mid-receive;
 * User B logs in 100 ms later; an `envelope.deliver` frame for User A
 * was already in the socket.io receive queue and gets handled AFTER
 * User B's runtime has wired up the store — `useMessengerStore.getState()`
 * returns User B's state; `handleDeliver` writes A's plaintext into
 * B's `messages` map. Audit caught it as a MEDIUM, but the bug surface
 * is closer to HIGH: cross-user data bleed.
 */
let currentOwnerEpoch = 0;
/**
 * Highest epoch ever assigned. Strictly monotonic — never reset.
 * `currentOwnerEpoch` flips to NO_OWNER_EPOCH on dispose, but the next
 * `buildProductionRuntime` derives its epoch from `lastOwnerEpoch + 1`
 * so it can never collide with a value still captured by a stale
 * closure from a previous runtime.
 */
let lastOwnerEpoch = 0;
const NO_OWNER_EPOCH = -1;

/**
 * SN-03 — the WS send-ack watchdog must scale with the link, not fight it.
 *
 * The deadline was a hard-coded 5s. At 1-2s RTT (or with one TCP retransmit)
 * that fires on perfectly routine sends, and the old handler responded by
 * tearing the socket down — a ~4-RTT rehandshake that dropped every other
 * in-flight ack and armed their watchdogs in turn. On the slow links this
 * guard exists to protect, it produced sustained reconnect oscillation
 * instead of delivery (B-72: receiver WS flapping every 60-90s).
 *
 * 4x the measured RTT is the same budget socket.io's own ack timeout logic
 * assumes (~5 round trips). The floor preserves the original behaviour on
 * fast links; the ceiling keeps a genuinely dead socket from parking a
 * message in 'sending' for a minute before the HTTP fallback runs.
 */
// F-4 (B-693) — floor 5_000 → 2_500: the watchdog's only unconditional act is
// the HTTP fallback (dedup-safe server-side on (recipient, clientMsgId) —
// envelope.service names this exact WS-timeout/HTTP-retry pair); the socket
// teardown stays independently gated on SERVER_SILENCE_DEAD_MS + no-live-call,
// so the B-72 oscillation this floor once guarded against cannot return via
// this change. Slow links are covered by the 4×RTT term, which overtakes the
// floor above ~625 ms RTT. Known trade (doc F-4): a fallback-delivered send's
// ✓✓ arrives via the receipt poll, which F-5 now also fires on resume/open.
/**
 * B-715 — max envelopes in a drain page that still gets a per-envelope
 * `[LAGDIAG] [recv.drain]` line. A push-woken drain carries a handful and is the
 * case worth instrumenting; a first-boot bootstrap page carries up to 1000 and a
 * line each would drown the log that makes the rare case findable — which is the
 * documented reason the 'delivered' disposition was silent on this lane at all.
 */
const DRAIN_PROBE_MAX_PAGE = 10;

const WS_ACK_FLOOR_MS   = 2_500;
const WS_ACK_CEILING_MS = 20_000;
const WS_ACK_RTT_FACTOR = 4;

/**
 * MS-10 — send-side payload caps (edge-case audit 2026-07-28).
 *
 * The WS gateway hard-refuses frames over ws.maxPayloadBytes (256 KiB,
 * apps/messenger-service/src/main.ts). An uncapped body seals into a frame
 * the transport rejects with no client-side surface — the caps land the
 * failure on an honest `failed` bubble instead (below the append, M3).
 * 64k chars seals to well under the frame cap (WhatsApp parity). Media
 * bytes go straight to R2 (not the relay), so the attachment cap is
 * cost/UX policy, not a transport limit — raise it deliberately, not by
 * deleting the check.
 */
// AUDIT #17 — the AAD epoch-lag tolerance: a sender may be up to this many
// epochs behind the receiver before the envelope is rejected pre-crypto.
const AAD_EPOCH_LAG = 2;
const MAX_MESSAGE_CHARS = 65_536;
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

function wsAckDeadlineMs(): number {
  let rttMs: number | null = null;
  try {
    ({rttMs} = (require('./rttRegistry') as typeof import('./rttRegistry')).getRtt());
  } catch { /* registry unavailable (tests) — fall back to the floor */ }
  const scaled = (rttMs ?? 0) * WS_ACK_RTT_FACTOR;
  return Math.min(Math.max(WS_ACK_FLOOR_MS, scaled), WS_ACK_CEILING_MS);
}

// BS-TY2 — typing watchdog singleton. Forces a stranded "typing…" flag
// off if no `stop` frame / inbound message clears it within the window.
// The class lives in messagingLogic so it's unit-testable with fake
// timers; here we just hold one process-wide instance.
const typingWatchdog = new TypingWatchdog();

// P1-BR-4 (B-58) — live-call guard + resume decision shared by the
// AppState-'active' handler and the WS send-ack watchdog. Lives in
// callResumeGuard.ts so it's unit-testable without the runtime's native
// graph. See that module for the full rationale.
const {hasLiveCall, decideResumeAction} =
  require('./callResumeGuard') as typeof import('./callResumeGuard');

/**
 * Read the live owner epoch — exposed for tests and for cross-module
 * gates (e.g. callDispatcher / sfuDispatcher could subscribe later).
 */
export function getCurrentOwnerEpoch(): number {
  return currentOwnerEpoch;
}

/**
 * Restore-after-reinstall fix #3 — replay one archived sealed envelope
 * through the live runtime's deliver path. The archive replay path is
 * exposed publicly because the BackupRestoreScreen needs to drain the
 * server-side sealed_envelope_archive after the restore-from-mirror
 * step completes. Each replay walks the same unseal + decrypt + store
 * path as a live envelope.deliver, just sourced from a Supabase row
 * instead of Redis.
 *
 * Returns false if the runtime is not built yet (caller should boot
 * via getMessengerRuntime first) or if the runtime was torn down mid-
 * batch. The caller is responsible for batching + cursor tracking; we
 * intentionally keep the API per-envelope because the archive list
 * already includes the cursor (timestampMs) and surfacing a batched
 * "replayN" here would force the runtime to know about the archive
 * shape.
 */
export async function replayArchivedEnvelope(env: {
  envelopeId: string; outerSealed: string; timestampMs: number;
}): Promise<boolean> {
  if (!liveReplayArchive) {return false;}
  await liveReplayArchive(env);
  return true;
}

/**
 * Tear down the previous runtime's module-level handles. Called at
 * the top of buildProductionRuntime AND from _resetMessengerRuntime
 * (test utility / logout path).
 */
export function disposeLiveRuntime(): void {
  // Round 6 / race fix — flip the epoch to a sentinel BEFORE running
  // disposers. Any in-flight onFrame / onStateChange / coalescedDrain
  // callback that wakes up between now and the next runtime build will
  // observe `myEpoch !== currentOwnerEpoch` and bail. Disposers
  // themselves don't read the epoch (they only tear down their own
  // resources), but the asynchronous work they CANCEL might still
  // resolve after the cancellation took effect — those resolutions all
  // funnel through the closures that check the epoch.
  currentOwnerEpoch = NO_OWNER_EPOCH;
  // OM-03 — the receipt-probe memo (unknown ids, unsupported latch) is
  // per-session state; a user switch must not carry it across owners.
  try { resetReceiptReconcile(); } catch { /* best-effort */ }
  // B-703 MR-12 — the next owner's message map is not hydrated yet, so the
  // drain must gate again. Also releases anything parked on the old gate: a
  // waiter from the dying runtime should bail on its epoch re-check now rather
  // than sit until its timeout.
  try { resetMessagesHydratedGate(); } catch { /* best-effort */ }
  // B-126 — in-flight envelope holds belong to the disposed runtime's
  // frames; carrying them across a user switch would make the new
  // session skip (or stale-warn on) ids it never attempted.
  try { resetInflightRegistry(); } catch { /* best-effort */ }
  // AUDIT-2026-08-13 #11 — close the previous socket on EVERY rebuild, not
  // just signOut. clearLiveTransport() (the Round-2 primitive) closes the
  // client AND nulls the registry, so: no auto-reconnecting orphan socket
  // per restore/foreground rebuild (the server-side 'superseded' takeover
  // only rescues this once the NEW socket connects — an offline rebuild
  // left the old client reconnect-looping forever), and no stale-registry
  // window where a forceReconnect (fcmBootstrap) could clear closedByUser
  // and REOPEN the previous user's socket. Idempotent on the signOut path,
  // which still calls it directly.
  try {
    const {clearLiveTransport} = require('./transportRegistry') as
      typeof import('./transportRegistry');
    clearLiveTransport();
  } catch { /* registry not loaded yet — fine */ }
  // WI-5.7 (transport G6) — drop the dispatcher's session-scoped state on
  // EVERY disposal path, not just signOut: the epoch fence stops NEW frames,
  // but frames already queued pre-registration would otherwise drain into a
  // signalling registered by the NEXT session (restore rebuild / account
  // switch) for a reused callId. Preserves onIncoming + the offer verifier —
  // both are MainNavigator-owned and are NOT re-installed on a mid-session
  // rebuild (see clearCallDispatchTransients' doc).
  try {
    const {clearCallDispatchTransients} = require('../webrtc/callDispatcher') as
      typeof import('../webrtc/callDispatcher');
    clearCallDispatchTransients();
  } catch { /* dispatcher not loaded yet — fine */ }
  // Run disposers in reverse-install order — symmetry with how a
  // normal stack unwind would handle nested resources.
  for (let i = liveDisposers.length - 1; i >= 0; i--) {
    try { liveDisposers[i](); } catch { /* swallow — best-effort */ }
  }
  liveDisposers = [];
  if (liveHeartbeat) {
    clearInterval(liveHeartbeat);
    liveHeartbeat = null;
  }
  liveAppStateSub?.remove?.();
  liveAppStateSub = null;
  // Why: OR-1/GF-1 — the outbox kick throttle, the early re-drain timer and the
  // relay send budget are module-level, so they must not survive an epoch flip
  // into the next account's runtime.
  lastOutboxKickAt = 0;
  lastOutboxUnparkAt = 0;
  if (transientRedrainTimer) {
    try { clearTimeout(transientRedrainTimer); } catch { /* ignore */ }
    transientRedrainTimer = null;
  }
  resetRelaySendPacer();
  if (liveSweeper) {
    try { liveSweeper.stop(); } catch { /* ignore */ }
    liveSweeper = null;
  }
  // BS-DISPOSE-LEAK (F13) — stop the prior runtime's revocation poll.
  if (liveRevokedJtiCache) {
    try { liveRevokedJtiCache.stop(); } catch { /* ignore */ }
    liveRevokedJtiCache = null;
  }
  // BS-DISPOSE-LEAK (F14) — drop the module-level group-key self-heal signal
  // handler so a signOut-without-relogin can't pin the whole runtime graph
  // (SessionManager / SQLCipher handle / transport / caches) via its closure.
  try { setGroupKeySignalHandler(null); } catch { /* ignore */ }
  try { setResendSignalHandler(null); } catch { /* ignore */ }
  // Round 8 — drop the per-runtime publish-bundle handle so a stale
  // closure can't smuggle the previous user's keys + tokens to the
  // server after logout.
  livePublishOwnBundle = null;
  // Audit P0-S3 / P0-S5 — drop the group-master-key sink so a stray
  // late `setGroupState` (e.g. an in-flight admin envelope that lands
  // after logout) doesn't write under the previous user's wrap key
  // into the previous user's SQLCipher handle.
  try {
    const {clearGroupMasterKeySink} = require('../store/messengerStore') as
      typeof import('../store/messengerStore');
    clearGroupMasterKeySink();
  } catch { /* store not loaded yet — fine */ }
  // Phase-2 ratchet-snapshot — drop the scheduler's store handle so a
  // stray capture after logout can't read the previous user's sessions
  // or write under the next user's keychain entry.
  try {
    const {disarmRatchetSnapshotScheduler} = require('../backup/ratchetSnapshotScheduler') as
      typeof import('../backup/ratchetSnapshotScheduler');
    disarmRatchetSnapshotScheduler();
  } catch { /* scheduler not loaded — fine */ }
}

/**
 * Build a production runtime. Performs all side-effecting init:
 *   - installIdentity (idempotent — no-op if identity already in store)
 *   - publish own bundle to auth-service
 *   - prime sender-cert cache
 *   - open WS to messenger-service
 *   - on WS open: issue envelope.pull to catch up any pending messages
 */
export async function buildProductionRuntime(
  deps: ProductionRuntimeDeps,
): Promise<MessengerRuntime> {
  const {ownStore, config} = deps;
  const signalDeviceId = config.signalDeviceId ?? 1;
  const ownAddress: SessionAddress = {userId: config.ownUserId, deviceId: signalDeviceId};

  // Audit P1-T3 — hydrate the read-receipts privacy cache so the first
  // markRead after boot reads the user's stored choice rather than the
  // safe default. Best-effort: a failed load leaves the cache at the
  // default (true), which matches legacy behaviour.
  await loadReadReceiptsEnabled().catch(() => { /* fall through to default */ });

  // M-07 — hydrate the blocked-peer set so the FIRST inbound frame after boot
  // can drop a blocked peer's message synchronously. M-08 — hydrate the
  // restore-tombstone set so the sealed-archive replay (which runs right after
  // a restore) won't resurrect a message the user deleted before reinstalling.
  // Both best-effort: a failed load leaves an empty set (fail-open — never
  // drops a message we aren't sure about).
  // Audit P1-10 — scope the blocked-peer cache to THIS owner (email/phone or
  // uuid). A device-global cache let account B inherit account A's blocks and
  // silently drop the wrong user's messages; passing the owner both scopes the
  // storage key AND resets the in-memory set on an owner switch.
  await loadBlockedPeers(config.ownerKey ?? config.ownUserId).catch(() => { /* empty set */ });
  await loadRestoreTombstones(config.ownUserId).catch(() => { /* empty set */ });
  /**
   * B-594 — the CONVERSATION tombstones, beside the message ones and for the
   * same reason: both exist so a restore cannot hand back what the user
   * deleted, and both must be armed before any receive or restore path runs.
   *
   * Owner-keyed like the blocked-peer cache above (P1-10): a device-global set
   * would let account B inherit account A's deletions. The set is loaded, not
   * merely created — without this call the in-memory cache stays null,
   * `rememberDeletedConversation` no-ops, and the whole suppression is inert
   * (fail-open). Caught by the review round, not by a green suite: every gate
   * fails open by design, so an unwired load looks exactly like "nothing was
   * ever deleted".
   */
  await loadConversationTombstones(config.ownerKey ?? config.ownUserId)
    .catch(() => { /* empty set — fail-open, never hide a live conversation */ });
  // B-124 root fix — hydrate the origin→minted call-key map (ids only)
  // before any escalation/resync path can consult it.
  await loadCallKeyRegistry(config.ownerKey ?? config.ownUserId).catch(() => { /* empty map */ });

  await installIdentity(ownStore, {preKeyCount: 50});

  // Audit P0-I1 — rotate the signed pre-key when it's older than
  // SIGNED_PRE_KEY_ROTATION_INTERVAL_MS (30 days). Without rotation a
  // one-shot SQLCipher compromise (rooted device, ADB backup, lost-
  // and-recovered handset) yields the SPK private scalar and lets the
  // attacker passively decrypt every X3DH initial handshake message
  // ever sent to this user. Rotation bounds that damage to ~30 days.
  //
  // Failure here is non-fatal — a missed rotation leaves the user on a
  // still-valid (just older) SPK rather than breaking message receive
  // on boot. The next boot retries. The rotation runs BEFORE
  // publishOwnBundle so the upload carries the fresh SPK; the
  // upload itself reads `currentSignedPreKeyId(store)` so a rotation
  // that happens later in life (timer, app foreground) just needs to
  // trigger another publishOwnBundle to take effect server-side.
  try {
    if (await shouldRotateSignedPreKey(ownStore)) {
      const res = await rotateSignedPreKey(ownStore);
      console.log(
        '[bravo.crypto] signed pre-key rotated',
        `new=${res.newKeyId}`,
        `prev=${res.prevKeyId ?? '-'}`,
        `pruned=[${res.prunedKeyIds.join(',')}]`,
      );
    }
  } catch (e) {
    console.warn('[bravo.crypto] signed pre-key rotation skipped:', (e as Error).message);
  }

  const own = new SessionManager(ownStore);

  // Transport clients
  // Round 2 fix: pass `config.refreshToken` to every HTTP client so
  // their already-implemented 401-retry path actually fires. Without
  // this, X3DH bundle fetches, sender-cert refreshes, and HTTP relay
  // fallbacks all silently 401-loop after the access token expires.
  const keys = new KeysHttpClient({
    baseUrl:      config.authBaseUrl,
    getToken:     config.getToken,
    refreshToken: config.refreshToken,
    // Audit G-02 / P0-I2 (2026-07-02): ARM the authority bundle-binding check.
    // Previously the client was built without authorityPubKeyB64, so
    // verifyOrThrow early-returned and accepted ANY peer bundle — a
    // malicious/coerced keys-service could swap a peer's identity key during
    // X3DH (MITM) and the client trusted it. The deployed auth-service signs
    // every bundle binding over (userId, identityKey, signedPreKey) with the
    // authority key whose PUBLIC half is config.authorityPubKeyB64 (verified:
    // SENDER_CERT_PRIVATE_KEY_B64 is set on the server, and sender-cert
    // verification already uses this same public key end-to-end). requireBundle
    // binding:true (default) rejects an unsigned/stripped-sig bundle so a MITM
    // can't bypass by omitting the signature.
    authorityPubKeyB64:   config.authorityPubKeyB64,
    requireBundleBinding: true,
  });
  const certClient = new SenderCertClient({
    baseUrl:      config.authBaseUrl,
    getToken:     config.getToken,
    refreshToken: config.refreshToken,
  });
  const relay = new RelayHttpClient({
    baseUrl:        config.messengerBaseUrl,
    getToken:       config.getToken,
    refreshToken:   config.refreshToken,
    signalDeviceId,
    // Why: GF-1 — every submit in this runtime shares ONE server bucket
    // (RELAY-1's per-user 300/60s cap), so they must share one client budget or
    // a group fan-out 429s its own tail.
    sendGate:       withRelaySendSlot,
  });
  // Audit P0-V5 / row #3 (M2) — runtime-owned MediaClient instance
  // used only for grant registration on send. Upload/download flows
  // construct their own client (with attachment cache wired). The
  // grant-only client doesn't need a cache.
  const mediaClient = new MediaClient({
    baseUrl:        config.messengerBaseUrl,
    getToken:       config.getToken,
    signalDeviceId,
  });
  // Upload/download-capable client, wired to the persistent blob cache
  // (constructed later in this function — captured lazily so a second
  // view of an attachment skips the network round-trip). Distinct from
  // the grant-only `mediaClient` above which never needs the cache.
  let _uploadMediaClient: MediaClient | null = null;
  const getUploadMediaClient = (): MediaClient => {
    if (_uploadMediaClient) {return _uploadMediaClient;}
    _uploadMediaClient = new MediaClient({
      baseUrl:        config.messengerBaseUrl,
      getToken:       config.getToken,
      signalDeviceId,
      cache:          mediaCache ?? undefined,
    });
    return _uploadMediaClient;
  };

  // Sprint-6 backend hand-off — install the HTTP-backed snapshot
  // transport so `applyRatchetSnapshot` (post-restore) and any future
  // capture-cadence hook upload through real backend endpoints. Safe
  // pre-migration: `httpSnapshotTransport` swallows 503/404 and the
  // recovery path falls through to `no_snapshot` cleanly.
  try {
    const {setSnapshotTransport} = require('../backup/ratchetSnapshot') as typeof import('../backup/ratchetSnapshot');
    const {makeHttpSnapshotTransport} = require('../backup/httpSnapshotTransport') as typeof import('../backup/httpSnapshotTransport');
    setSnapshotTransport(makeHttpSnapshotTransport());
  } catch (e) {
    // Non-fatal — the previous in-memory transport (if any) remains
    // active and the restore path simply reports `no_transport`.
    console.warn('[bravo.runtime] snapshot transport install skipped:', (e as Error).message);
  }

  // Round 8 — defer the bundle upload when we're booting in the middle
  // of a restore-from-backup flow. The identity that installIdentity
  // just wrote is a FRESH random one — uploading it now (then having
  // restoreBackup overwrite local with the OLD identity moments later)
  // makes the server flag the user as having rotated their identity.
  // The auth-service rotation handler then WIPES every server-side
  // OPK public, which catastrophically breaks every peer who held a
  // session against the user's previous bundle. The restore screen
  // calls `publishOwnBundleAfterRestore` once it has installed the
  // recovered identity; that call is idempotent for the bundle and
  // brings the server back in sync with the locally-restored privates.
  // Audit P1-2 — the boot bundle upload is BEST-EFFORT. `keys.uploadBundle`
  // uses a bare fetch that throws offline (or on a transient auth-service
  // 5xx); an unguarded await here rejected the whole runtime build BEFORE
  // history hydration, and runtime.ts cached the rejected promise forever —
  // bricking the messenger (zero history, no sends) for the process lifetime.
  // On failure we log (id slices only) and arm a one-shot retry that the
  // onStateChange('connected') handler fires once the socket comes up.
  let bootBundlePublishPending = false;
  // Notif-latency E1 (docs/audits/NOTIF_TAP_TO_MESSAGE_LATENCY_2026-08-01.md)
  // — the boot bundle upload is FIRE-AND-FORGET. It was the only awaited
  // network roundtrip left between process start and setReady(true): on a
  // cold boot it sat ahead of SQLCipher hydration, so the chat surface
  // waited on an auth-service roundtrip before it could render messages
  // already on disk. Nothing downstream consumes its result — the upload was
  // ALREADY best-effort (P1-2, failure arms a reconnect retry); only the
  // rotation purge rode its completion, and that purge degrades to
  // 'unavailable' in production (no attestation provider) either way.
  let transportRef: TransportClient | null = null;
  const runBootBundlePublish = async (): Promise<void> => {
    try {
    const uploadRes = await publishOwnBundle(ownStore, keys, ownAddress);
    // Handoff §4.5-2/-3 — own-identity rotation detected by the server:
    // every envelope still queued on the relay was wrapped to the OLD
    // identity and is permanently undecryptable. Purge them in one server
    // call. Ordering: the purge now RACES the first drainRelay (the publish
    // no longer blocks boot); a lost race degrades to the documented
    // one-ack-drop-at-a-time fallback. Best-effort end to end: the
    // helper never throws, and a missing MFA proof (no attestation
    // provider yet — production) degrades to 'unavailable' (dead
    // envelopes then simply TTL out via the 30-day dwell, today's
    // behavior). Deliberately NOT wired into the restore-path republish
    // (publishOwnBundleAfterRestore) — a restored OLD identity returns
    // identityRotated=false anyway, and those envelopes are readable.
    if (uploadRes.identityRotated && uploadRes.previousIdentityKey) {
      try {
        const {purgeStaleRecipientQueue: purgeStaleQueue} =
          require('../crypto/ownIdentityRotation') as typeof import('../crypto/ownIdentityRotation');
        const proof = await keys.mintActionToken('recipient_purge');
        const outcome = await purgeStaleQueue(relay, uploadRes.previousIdentityKey, proof?.actionToken);
        console.log(`[bravo.runtime] identity rotated — stale-queue purge result=${outcome.result} count=${outcome.count ?? 0} reason=${outcome.reason ?? '-'}`);
      } catch (e) {
        console.warn('[bravo.runtime] stale-queue purge skipped:', asErrorMessage(e));
      }
    }
    } catch (e) {
      // P1-2 — best-effort: keep the runtime build alive so history hydrates
      // and sends work offline-queued; retry the upload once the socket
      // reconnects (armed below in onStateChange('connected')).
      console.warn('[bravo.runtime] boot bundle publish failed (will retry on reconnect):', asErrorMessage(e).slice(0, 80));
      bootBundlePublishPending = true;
      // The socket can finish connecting WHILE this publish is in flight —
      // that 'connected' transition already ran its one-shot retry check, so
      // kick the retry directly here (same shape as onStateChange). Guarded
      // defensively: on the boot path these helpers may not be initialised
      // yet, in which case the ordinary reconnect retry still covers it.
      try {
        if (isOurEpoch() && transportRef?.state === 'connected' && livePublishOwnBundle) {
          bootBundlePublishPending = false;
          void livePublishOwnBundle().catch(() => { bootBundlePublishPending = true; });
        }
      } catch { /* boot-phase race — the reconnect retry path covers it */ }
    }
  };
  if (!deferBundlePublish) {
    void runBootBundlePublish();
  } else {
    console.log('[bravo.runtime] deferBundlePublish=true — bundle upload deferred to post-restore');
  }

  // Sender cert cache — lazily fetches on first send.
  const ownIdentity = await ownStore.getIdentityKeyPair();
  const certCache = new SenderCertCache(certClient, signalDeviceId, toBase64(ownIdentity.pubKey));
  // Audit 1:1 P1-1 — sender-cert revocation polling. `verifySenderCert`
  // already accepts a `revokedJtis: ReadonlySet<string>`; the missing
  // producer is added here. Default 5-min cadence trims a leaked-cert
  // window from the cert TTL down to ~5 min (the audit's stated target).
  const revokedJtiCache = new RevokedJtiCache({
    client:  certClient,
    onError: e => console.warn('[bravo.runtime] revocation-list fetch failed:', e.message),
  });
  revokedJtiCache.start();

  // Tear down any prior runtime's module-level handles BEFORE we
  // construct new ones — without this the previous heartbeat /
  // appstate / subscriber keeps firing against a torn-down transport
  // and SQLCipher DB. (Idempotent — first run is a no-op.)
  disposeLiveRuntime();
  // BS-DISPOSE-LEAK (F13) — park THIS runtime's revocation poll AFTER the
  // prior-runtime teardown (which stopped the previous one), so the next
  // disposeLiveRuntime() stops this one too.
  liveRevokedJtiCache = revokedJtiCache;
  // Capture handles needed by publishOwnBundleAfterRestore so the
  // restore screen can re-run the upload with the recovered identity
  // without re-building the runtime.
  // Why: discards the rotation flag on purpose — the restore republish
  // presents the restored OLD identity, and the purge must never fire here.
  // ⚠️ MUST sit AFTER the disposeLiveRuntime() call above — dispose nulls
  // this module slot (Round 8), so the previous placement (before the
  // dispose) left it null for the runtime's entire life: the restore-screen
  // republish and the P1-2 reconnect retry both silently no-oped. Pinned by
  // notifLatencyBootInvariants.test.ts.
  livePublishOwnBundle = async (): Promise<void> => { await publishOwnBundle(ownStore, keys, ownAddress); };

  // Round 6 / race fix — bump owner epoch so async work spawned by
  // this runtime can prove "I am the live runtime" before mutating the
  // store. Epoch is strictly monotonic and never recycled: we track
  // the highest value ever seen via `lastOwnerEpoch` so even after a
  // dispose set `currentOwnerEpoch = NO_OWNER_EPOCH`, the next build
  // gets a value greater than every previous runtime's `myEpoch`. A
  // recycled epoch would create a false-negative bail: a stale closure
  // captured `myEpoch=N`, dispose set live to -1, new build assigned
  // live=N again → stale closure sees match → frame leaks through.
  lastOwnerEpoch += 1;
  currentOwnerEpoch = lastOwnerEpoch;
  const myEpoch = currentOwnerEpoch;
  const isOurEpoch = (): boolean => myEpoch === currentOwnerEpoch;

  // Audit P1-10 — reconcile the blocked-peer set from auth-service so blocks
  // are enforced after a reinstall / owner-switch WITHOUT the user visiting
  // the blocked-list screen. Best-effort + non-blocking (P1-2's lesson): a
  // fetch failure keeps the persisted local set and NEVER bricks the boot.
  // The epoch guard stops a late-resolving fetch from writing the previous
  // owner's list under the new owner's key after a fast account switch.
  void (async () => {
    try {
      const usersClient = new UsersHttpClient({
        baseUrl:      config.authBaseUrl,
        getToken:     config.getToken,
        refreshToken: config.refreshToken,
      });
      const blocked = await usersClient.listBlocked();
      if (!isOurEpoch()) {return;}
      await setBlockedPeers(blocked.map(b => b.userId));
    } catch { /* offline / backend down — keep the persisted local set */ }
  })();

  // Track pending client-side msgIds → messageId so envelope.accepted
  // can flip the local message's status.
  //
  // Fix #3: extended value type carries the WS-ack watchdog timer so
  // handleAccepted + httpFallback success can clear it; without that
  // the 5s timer fires AFTER we've already flipped to 'sent' and
  // forces a duplicate HTTP retry.
  //
  // Fix #8: bounded LRU. The Map was previously unbounded — long-
  // running session with thousands of failed sends would balloon. We
  // cap at MAX_PENDING and evict oldest on insert.
  // Audit P0-N4: `peer` is now required so handleAccepted can resolve
  // the per-peer outbox row (composite PK includes peer_user_id +
  // peer_device_id). For group sends the same clientMsgId maps to many
  // outbox rows; the WS path is 1:1 only so only one peer is recorded.
  const pendingByClientMsgId = new Map<string, {
    conversationId: string;
    messageId: string;
    peer: SessionAddress;
    ackTimer?: ReturnType<typeof setTimeout>;
  }>();
  const MAX_PENDING = 1000;
  const trackPending = (clientMsgId: string, entry: {
    conversationId: string;
    messageId: string;
    peer: SessionAddress;
    ackTimer?: ReturnType<typeof setTimeout>;
  }): void => {
    if (pendingByClientMsgId.size >= MAX_PENDING && !pendingByClientMsgId.has(clientMsgId)) {
      // Evict oldest. Map preserves insertion order so the first key
      // returned by `keys()` is the oldest.
      const oldest = pendingByClientMsgId.keys().next().value;
      if (oldest !== undefined) {
        const ev = pendingByClientMsgId.get(oldest);
        if (ev?.ackTimer) { clearTimeout(ev.ackTimer); }
        // Round 5 / Security S5 — surface an evicted-still-sending
        // entry as 'failed' so the user can retry. Previously the
        // message sat in 'sending' state forever (silent self-DoS),
        // which an attacker could weaponise: sustained fan-out at
        // > MAX_PENDING/sec evicts every legitimate pending entry,
        // and the user never sees an error to retry.
        if (ev) {
          void (async () => {
            try {
              // Why: B-317 — an entry can be LRU-evicted while its durable
              // outbox row is still queued (the row auto-sends on a later
              // drain). Red-flagging it violates the invariant stated at the
              // httpFallback queued path: a red bubble over a queued row
              // invites a re-typed duplicate the relay's (recipient,
              // clientMsgId) dedup cannot coalesce. Flip only when no row
              // remains to own the send.
              if (sqlOutbox) {
                const queued = await sqlOutbox.pendingMessageIds();
                if (queued.has(ev.messageId)) {
                  console.warn(`[messenger] LRU-evicted pending msg=${ev.messageId} — outbox row still queued, bubble stays 'sending'`);
                  return;
                }
              }
              const store = useMessengerStore.getState();
              const list = store.messages[ev.conversationId];
              const msg = list?.find(m => m.id === ev.messageId);
              // Only flip to failed if it's still in flight; an entry
              // that was already 'sent' (and just hadn't been cleared)
              // shouldn't be re-marked.
              if (msg && msg.status === 'sending') {
                store.updateMessageStatus(ev.conversationId, ev.messageId, 'failed');
                store.setError('A pending message timed out — please retry');
                console.warn(`[messenger] LRU-evicted pending msg=${ev.messageId} convo=${ev.conversationId} flipped to failed`);
              }
            } catch (e) {
              console.warn('[messenger] LRU-evict surface failed:', (e as Error).message);
            }
          })();
        }
        pendingByClientMsgId.delete(oldest);
      }
    }
    pendingByClientMsgId.set(clientMsgId, entry);
  };
  const clearPending = (clientMsgId: string): void => {
    const entry = pendingByClientMsgId.get(clientMsgId);
    if (entry?.ackTimer) { clearTimeout(entry.ackTimer); }
    pendingByClientMsgId.delete(clientMsgId);
  };

  // Fix #22: retry queue for failed SQLCipher upserts. Keyed
  // `${conversationId}:${messageId}`. Drained on next store change.
  //
  // Audit fix #39 — once the queue grows beyond UPSERT_BACKPRESSURE_THRESHOLD
  // we surface a sticky banner via store.error so the user knows their
  // local saves are falling behind. We do NOT await each upsert in the
  // hot store-subscriber path because that would block UI updates on
  // disk fsync; we DO surface the failure mode loudly so silent data
  // loss can't happen.
  const upsertRetryQueue = new Map<string, LocalMessage>();
  const UPSERT_BACKPRESSURE_THRESHOLD = 100;

  // Fix #4: drainRelay mutex. Coalesces WS-reconnect, AppState 'active'
  // foreground push, and ChatScreen pullEnvelopes() into ONE in-flight
  // call. Without this, three sources can fire concurrent pulls; the
  // server is idempotent on ack but the cost is needless network
  // chatter and triple-decryption of the same envelope.
  // OR-4: the mutex now carries a re-run latch (see rerunCoalescer.ts) so a
  // trigger landing mid-pass isn't absorbed into a pass already committed to
  // a dead route. This drain has NO periodic tick — a swallowed edge waited
  // for the next foreground/reconnect.

  // Audit P1-G2 — per-group mutex for multi-step admin operations.
  //
  // The original remove/rekey + add/rekey + leave/rekey flows are each
  // two broadcast envelopes (`{remove, rekey}`, `{add, rekey}`,
  // `{leave, rekey}`) with a `setGroupState(intermediate)` between
  // them. A concurrent `sendText` to the same group that lands in the
  // tick BETWEEN the two state writes encrypts under the
  // INTERMEDIATE-state master key (which is still the OLD key for
  // remove + leave, or the OLD key for add too) — that part is fine,
  // but the EPOCH stamped into the AAD reflects only step 1's advance
  // (E+1), not the post-rekey value (E+2). A receiver who has already
  // applied BOTH admin envelopes will reject the in-flight text with
  // `epoch_stale` (see P0-G1 in sealedSender). Result: silently
  // dropped messages during admin churn.
  //
  // Mutex per group: any admin op + any send for the same group are
  // serialised. Cross-group ops remain parallel. Held only for the
  // duration of the two-step plan, so the steady-state send path is
  // unaffected.
  const groupAdminLocks = new Map<string, Promise<unknown>>();
  const runWithGroupAdminLock = async <T>(groupId: string, work: () => Promise<T>): Promise<T> => {
    const prev = groupAdminLocks.get(groupId) ?? Promise.resolve();
    const next = prev.then(work, work);
    // Track the next promise so callers see linear ordering, but drop
    // the entry once it settles so the Map doesn't grow per group-op.
    groupAdminLocks.set(groupId, next);
    void next.finally(() => {
      if (groupAdminLocks.get(groupId) === next) {
        groupAdminLocks.delete(groupId);
      }
    });
    return next;
  };

  // Fix #11: short-lived peer identity-key cache. Without this, EVERY
  // outbound message hits /auth/keys/:userId which atomically pops a
  // one-time pre-key. Sending 50 messages exhausts a peer's OPK pool
  // (50 keys at install) in a single chat session.
  // Pool exhaustion → next X3DH stalls until the peer comes back
  // online to refill. TTL well under the cert-cache 60-min refresh
  // window. Contract (keying, TTL, server-only writes) lives in
  // crypto/peerIdentityCache.ts — AUDIT-2026-08-13 #5.
  const peerIdentityCache: PeerIdentityCache = new Map();

  // AUDIT #5 — identity-rotation recovery for a peer whose device destroyed
  // our envelope (B-46 auto-resend, B-122 manual retry). ONE shape, used by
  // both sites: evict BEFORE the refresh (a throw must leave no cached entry,
  // so the next resolve is server-authoritative), re-seed AFTER it from the
  // same authority-verified bundle the session was rebuilt from. The
  // post-await set makes the wrap-time read below a hit — sparing a second
  // destructive OPK pop per recovery — and narrows the residual race
  // (a slow SUCCESSFUL fetch from a concurrent lane landing after this set
  // last-writer-wins; near-always the same server state, and the Map can no
  // longer hold a fallback at all — the decrypt-error eviction heals the
  // improbable stale-server-read remainder).
  // The cooldown clear mirrors the wrapper's own clear-on-success: this fetch
  // just proved the keys-service reachable.
  const refreshPeerIdentityAndSession = async (peer: SessionAddress): Promise<void> => {
    peerIdentityCache.delete(peerIdentityCacheKey(peer));
    const idKey = await forceRefreshOutgoingSession(own, keys, peer, ownStore);
    peerIdentityCache.set(peerIdentityCacheKey(peer), {idKey, fetchedAt: Date.now()});
    clearNegativeFetchCooldown(peerIdentityCache, peer);
  };

  // A4 / RT-3 (XO-1+XO-2) — re-seal + ship an outbox row that has no shippable
  // bytes yet (a DEFERRED send intent) or whose stored sender cert has aged
  // out. Captures the runtime crypto context so drainOutbox (a module-level
  // function) can recover. Re-establishes the pairwise session and re-seals to
  // THIS peer under a FRESH sender cert, carrying the row's original compose
  // timestamp in aad.ts (OM-05, clamped to the accept window). Three row
  // shapes: 1:1 text/media (`direct` / `resealKind:'direct'`), reaction, and
  // group (the only shape before RT-3) — each AAD is verbatim its live send
  // path's. A throw (peer still unprovisioned) propagates to the drain's
  // recordAttempt/backoff. Declared at the factory top level so both the
  // reconnect handler and the boot/timer drains see it.
  const resealOutboxRow: ResealOutboxFn = async (row, payload) => {
    const peer: SessionAddress = {userId: row.peerUserId, deviceId: row.peerDeviceId};
    await ensureOutgoingSession(own, keys, peer, ownStore);
    const freshCert = await certCache.get();
    const cmid = payload.clientMsgId ?? row.clientMsgId;
    // Why: OM-05 — the receiver stamps created_at from aad.ts, so re-minting
    // "now" here reordered the message on that device only. Carry the compose
    // time the outbox row already holds (clamped to the accept window; never
    // widens verifySealedAad's bounds).
    const resealTs = resolveResealAadTs(row.createdAt);
    let sealed: string;
    if (payload.resealKind === 'direct' || payload.direct === true) {
      sealed = sealPayload(freshCert, payload.body ?? '', {
        expiresAtSec: payload.expiresAtSec,
        clientMsgId:  cmid,
        attachment:   payload.attachment,
        replyTo:      payload.replyTo,
        // MM-09 — mirror the live 1:1 seal: the flag must survive the drain
        // re-seal or a queued forward arrives unlabelled (B-144's lesson).
        isForwarded:  payload.isForwarded === true ? true : undefined,
        // WIRE-COMPAT: no top-level `mentions` here. Mentions are group-only
        // (the picker never opens in a 1:1), so a direct row cannot carry any —
        // and emitting the key at all would be destroyed by an older peer.
        aad: {
          to:             peer,
          ts:             resealTs,
          sender:         ownAddress,
          conversationId: directConvoAadId(ownAddress.userId, peer.userId),
        },
      });
    } else if (payload.resealKind === 'mutation') {
      // An edit / delete-for-everyone queued past the cert TTL. Same shape rule
      // as the reaction branch: the bare {to, ts} AAD is verbatim what the live
      // send stamps, and these render no bubble so OM-05's compose-time carry
      // does not apply.
      if (!payload.edit && !payload.deleteFor) {
        throw new Error('outbox_reseal_missing_mutation');
      }
      // WIRE-COMPAT: same carrier rule as the live send — inside `group` when
      // there is one, top-level only for a 1:1. A re-minted envelope must be
      // byte-shaped like the original or the drain re-introduces the bug for
      // exactly the rows most likely to be retried (B-144's lesson).
      sealed = sealPayload(freshCert, '', payload.group
        ? {
            group: {
              ...payload.group,
              ...(payload.edit      ? {edit:      payload.edit}      : {}),
              ...(payload.deleteFor ? {deleteFor: payload.deleteFor} : {}),
            },
            aad: {to: peer, ts: Date.now()},
          }
        : {
            ...(payload.edit      ? {edit:      payload.edit}      : {}),
            ...(payload.deleteFor ? {deleteFor: payload.deleteFor} : {}),
            aad: {to: peer, ts: Date.now()},
          });
    } else if (payload.resealKind === 'reaction') {
      if (!payload.reaction) {
        throw new Error('outbox_reseal_missing_reaction');
      }
      // Why: the bare {to, ts} AAD is verbatim the live sendReaction stamp —
      // "improving" it here would break the receiver's reaction expectations.
      // Reactions render no bubble, so OM-05's compose-time carry does not
      // apply — Date.now() is kept deliberately.
      sealed = sealPayload(freshCert, '', {
        reaction: payload.reaction,
        ...(payload.group ? {group: payload.group} : {}),
        aad: {to: peer, ts: Date.now()},
      });
    } else {
      if (payload.sealedBody === undefined || payload.groupId === undefined) {
        throw new Error('outbox_reseal_missing_group_body');
      }
      sealed = sealPayload(freshCert, payload.sealedBody, {
        expiresAtSec: payload.expiresAtSec,
        clientMsgId:  cmid,
        attachment:   payload.attachment,
        // B-144 — mirror the direct branch above. A group reply that was
        // queued offline (or whose cert aged out) is re-sealed here; without
        // this the drain shipped it stripped of its quote. Mentions ride along
        // for the identical reason.
        replyTo:      payload.replyTo,
        // WIRE-COMPAT: inside `group`, never top-level — see SealedGroup.
        group: {
          groupId: payload.groupId, kind: payload.kind ?? 'text', clientMsgId: cmid,
          ...(payload.mentions?.length ? {mentions: payload.mentions} : {}),
          ...(payload.isForwarded ? {isForwarded: true} : {}),
        },
        aad: {
          to:             peer,
          ts:             resealTs,
          sender:         ownAddress,
          conversationId: payload.groupId,
          groupId:        payload.groupId,
        },
      });
    }
    const ct = await own.encrypt(peer, sealed);
    const recipientIdKeyB64 = await recipientIdentityKeyB64Cached(ownStore, keys, peer, peerIdentityCache);
    const outerSealed = await wrapOuter({
      recipientIdentityKeyB64: recipientIdKeyB64,
      sender:                  ownAddress,
      ciphertext:              ct,
      cert:                    freshCert,
    });
    // Why: a deferred row was queued OFFLINE, so the live path's registerGrants
    // never ran for its attachment; without it the recipient 403s under strict
    // grant mode. Idempotent server-side (SADD), so re-sealed rows re-firing it
    // is harmless.
    if (payload.attachment?.objectKey) {
      try {
        await mediaClient.registerGrants(payload.attachment.objectKey, [peer.userId]);
      } catch (e) {
        console.warn('[messenger.media] registerGrants (outbox reseal) failed:', asErrorMessage(e));
      }
    }
    return {outerSealed, expiresAtSec: payload.expiresAtSec};
  };

  // B-46 — sender-side auto-resend on `envelope.undeliverable`. The
  // recipient's device destroyed our envelope (identity churn: they
  // reinstalled / cleared data / restored a fresh identity), but WE
  // still hold the plaintext. Eligibility + the one-attempt budget are
  // decided in undeliverableResend.ts; this closure executes the
  // recovery: overwrite the dead trusted identity + session with the
  // peer's CURRENT authority-signed bundle, re-seal the same row's
  // plaintext, and submit under a NEW clientMsgId (the old id is
  // dedup-claimed on the relay for the dwell window — reusing it would
  // coalesce into the destroyed envelope and silently drop). Ships via
  // HTTP relay for a deterministic accept (no WS ack race). Failures
  // leave the bubble at `undelivered` — the ChatScreen retry chip is
  // the manual fallback.
  const resendUndeliverable = (envelopeId: string): void => {
    void (async () => {
      if (!isOurEpoch()) {return;}
      const st = useMessengerStore.getState();
      const decision = selectUndeliverableResend(
        {messages: st.messages, conversations: st.conversations},
        envelopeId,
        Date.now(),
      );
      if (decision.action === 'skip') {
        // Reason codes only — never content.
        console.log(`[messenger] undeliverable-resend skip env=${envelopeId.slice(0, 8)} reason=${decision.reason}`);
        return;
      }
      if (decision.action === 'resend-group') {
        // B-683 follow-up — an all-legs-dead group row gets ONE automatic
        // attempt through the manual chip's exact lane: sendText with
        // existingMsgId rides F2 (fresh wire id + atomic artifact reset +
        // old-outbox purge), so this cannot duplicate for any member and
        // cannot re-red the bubble off stale round-1 verdicts. Mirrors
        // ChatScreen.retrySend's opts (reply preserved; TTL recomputed
        // from the original window, same as a chip tap).
        const gConvId = decision.conversationId;
        const gMsg = decision.message;
        try {
          useMessengerStore.getState().updateMessageStatus(gConvId, gMsg.id, 'sending');
          const gTtl = typeof gMsg.expires_at === 'number'
            ? Math.max(1, Math.round((gMsg.expires_at - Date.parse(gMsg.created_at)) / 1000))
            : undefined;
          await runtimeApi.sendText(gConvId, gMsg.content ?? '', {
            existingMsgId: gMsg.id,
            ttlSeconds:    gTtl,
            replyTo: gMsg.reply_to_msg_id && gMsg.reply_to_preview
              ? {messageId: gMsg.reply_to_msg_id, preview: gMsg.reply_to_preview}
              : undefined,
          });
          crashLog(`[messenger] undeliverable-resend group ok msg=${gMsg.id.slice(0, 8)} env=${envelopeId.slice(0, 8)}`);
        } catch (e) {
          // The group lane's own failure paths own the bubble state
          // (failGroupSend / deferred rows); the manual chip stays the
          // terminal fallback. Budget already consumed — no ping-pong.
          crashLog(`[messenger] undeliverable-resend group failed msg=${gMsg.id.slice(0, 8)} err=${asErrorMessage(e).slice(0, 80)}`);
        }
        return;
      }
      const {conversationId, message, peer, expiresAtSec} = decision;
      try {
        // The cached identity is what the DEAD wrap was built from — evict,
        // rebuild the session, re-seed from the fresh bundle (AUDIT #5).
        await refreshPeerIdentityAndSession(peer);
        const cert = await certCache.get();
        const newClientMsgId = makeId();
        const sealed = sealPayload(cert, message.content, {
          expiresAtSec,
          clientMsgId: newClientMsgId,
          replyTo: message.reply_to_msg_id
            ? {msgId: message.reply_to_msg_id, preview: (message.reply_to_preview ?? '').slice(0, 200)}
            : undefined,
          aad: {
            to:             peer,
            // OM-05 — carry the bubble's compose time (clamped) so the
            // recovered copy lands where the original belonged.
            ts:             resolveResealAadTs(Date.parse(message.created_at)),
            sender:         ownAddress,
            conversationId: directConvoAadId(ownAddress.userId, peer.userId),
          },
        });
        const ct = await own.encrypt(peer, sealed);
        const recipientIdKeyB64 = await recipientIdentityKeyB64Cached(ownStore, keys, peer, peerIdentityCache);
        const outerSealed = await wrapOuter({
          recipientIdentityKeyB64: recipientIdKeyB64,
          sender:                  ownAddress,
          ciphertext:              ct,
          cert,
        });
        // OM-03 — the auto-resend is an HTTP submit too; without a receipt
        // slot the recovered message would re-enter the stuck-at-one-tick
        // state this gate exists to kill.
        const r = await relay.send({recipient: peer, outerSealed, clientMsgId: newClientMsgId, expiresAtSec, receipt: true});
        if (!isOurEpoch()) {return;}
        const st2 = useMessengerStore.getState();
        if (r.envelopeId) {st2.updateMessageEnvelopeId(conversationId, message.id, r.envelopeId);}
        if (r.retractToken) {st2.updateMessageRetractToken(conversationId, message.id, r.retractToken);}
        st2.updateMessageStatus(conversationId, message.id, 'sent');
        crashLog(`[messenger] undeliverable-resend ok msg=${message.id.slice(0, 8)} env=${envelopeId.slice(0, 8)}->${(r.envelopeId ?? '').slice(0, 8)}`);
      } catch (e) {
        // Bubble stays `undelivered` (honest); budget already consumed so
        // a discard of a FAILED resend can't ping-pong.
        crashLog(`[messenger] undeliverable-resend failed msg=${message.id.slice(0, 8)} err=${asErrorMessage(e).slice(0, 80)}`);
      }
    })();
  };

  // Fix #7: track when we last received a pong so AppState 'active'
  // can skip the force-reconnect when the socket is genuinely live.
  let lastPongAt = 0;

  // Round 7 / presence audit fix #1 — track every userId we've asked
  // the server to watch. On socket reconnect, the server's `watch:<id>`
  // room membership is tied to the *socket id*, not our auth pid;
  // every fresh socket joins zero rooms and we'd see every contact go
  // offline forever after the first network blip. The runtime now owns
  // the source-of-truth subscription set and resubscribes on every
  // `connected` transition so watchers stay current across Doze, force
  // reconnect, server restart, supersession, etc.
  // Audit MSG-16 — REFCOUNTED presence subscriptions (userId → count). Home
  // subscribes a peer while its row is visible AND ChatScreen subscribes the
  // same peer on open; a flat Set meant closing the Chat (unsubscribe) removed
  // the shared entry, so the server dropped us from watch:<peer> and Home's
  // dot went dead until remount. Refcounting only releases the wire watch when
  // the LAST subscriber for that peer unsubscribes.
  const presenceSubscriptions = new Map<string, number>();
  // Audit MSG-06 — read receipts emitted while the socket was down were lost
  // forever (markRead flips the local bubble to 'read', which then skips it on
  // every future markRead, and the best-effort emit dropped silently). Queue
  // the (peer → envelopeIds) that couldn't be sent and flush on reconnect so
  // the sender eventually gets blue ticks.
  //
  // Audit P2-7 (2026-07-09) — the MSG-06 queue was memory-only (an app kill
  // while offline permanently lost the receipts — the bubble is already
  // 'read' so they are never re-collected) and was cleared even when the
  // flush emit threw. Mirror the queue to AsyncStorage per owner, remove an
  // entry only AFTER its emit succeeded, restore on boot, and flush on
  // reconnect AND app-foreground.
  const pendingReadReceipts = new Map<string, {peer: SessionAddress; envelopeIds: Set<string>}>();
  const pendingReadReceiptsKey = `messenger.pendingReadReceipts.v1.${config.ownerKey ?? config.ownUserId}`;
  const persistPendingReadReceipts = async (): Promise<void> => {
    try {
      const AsyncStorage = (require('@react-native-async-storage/async-storage') as
        {default: {setItem(k: string, v: string): Promise<void>; removeItem(k: string): Promise<void>}}).default;
      if (pendingReadReceipts.size === 0) {
        await AsyncStorage.removeItem(pendingReadReceiptsKey);
        return;
      }
      // Only envelope ids + peer addresses — never message content.
      const rows = [...pendingReadReceipts.values()]
        .map(s => ({peer: s.peer, envelopeIds: [...s.envelopeIds]}));
      await AsyncStorage.setItem(pendingReadReceiptsKey, JSON.stringify(rows));
    } catch { /* AsyncStorage unavailable (tests) — memory queue still works */ }
  };
  // Hoisted (function declaration) — referenced from the transport
  // onStateChange callback and the AppState handler; both fire only after
  // the factory finished constructing `transport`.
  function flushPendingReadReceipts(): void {
    if (pendingReadReceipts.size === 0) {return;}
    if (transport.state !== 'connected') {return;}
    let flushedAny = false;
    for (const [key, {peer, envelopeIds}] of [...pendingReadReceipts.entries()]) {
      try {
        transport.sendReadReceipt(peer, [...envelopeIds]);
        // Why: delete only after the emit didn't throw — a half-open socket
        // keeps the entry queued for the next reconnect/foreground flush.
        pendingReadReceipts.delete(key);
        flushedAny = true;
      } catch { /* socket race — entry stays queued */ }
    }
    if (flushedAny) {void persistPendingReadReceipts();}
  }
  // Round 7 / presence audit fix #2 — track our own activity state so
  // we can re-emit it on reconnect (otherwise we'd revert to plain
  // `online` after every blip even while the user is mid-conversation).
  // B-354 — the init must reflect REALITY, not assume 'active': this runtime
  // also boots inside the killed-app headless VM (AppState 'background'),
  // where the old unconditional 'active' made the connected-replay announce
  // "Active now" to every watcher while the user wasn't in the app at all.
  let lastActivity: 'active' | 'away' = config.backgroundBoot ? 'away' : 'active';
  if (!config.backgroundBoot) {
    try {
      const {AppState: bootAppState} = require('react-native') as typeof import('react-native');
      if (bootAppState.currentState !== 'active') {lastActivity = 'away';}
    } catch { /* non-RN context — keep the interactive default */ }
  }
  // Round 8 / presence false-active audit — reconnect bookkeeping.
  //   `wasDisconnected` flips true on the first `disconnected` state and
  //   gates the post-reconnect store-clear so the very first connect
  //   doesn't pointlessly flicker a fresh subscription set.
  //   `lastClearAtMs` debounces back-to-back clears so a flaky network's
  //   exponential-backoff cycle (1-30s) doesn't strobe presence dots —
  //   one clear per 3s window is enough; the next snapshot will repaint
  //   regardless.
  let wasDisconnected = false;
  let lastPresenceClearAtMs = 0;
  const PRESENCE_CLEAR_DEBOUNCE_MS = 3_000;

  // Pre-declare the durable-outbox handle in the runtime scope so the
  // transport's onFrame closure below can reference it without hitting
  // a TDZ error if a frame arrives between transport.connect() and the
  // later block that actually constructs the store. Constructed below
  // once the SQLCipher DB handle is available.
  let sqlOutbox: SqlOutboxStore | null = null;
  // OR-2 — throttle stamp for the server-signal-driven outbox drain.
  let lastSignalDrainAt = 0;

  // Why: transport.connect() fires at line ~791, but seven FrameDeps
  // (sqlMessages, seenEnvelopes, txnDb, sqlOutbox, pendingGroupEnvelopes,
  // pendingAdminActions, mediaCache) aren't constructed until lines
  // ~982-1012. Any envelope.deliver that arrives in that ~1-2s window
  // hits handleDeliver against null deps. The non-txn fallback path
  // *should* still ack — but if any subtle ordering throw fires (e.g.
  // libsignal needs txnDb to commit a session UPSERT and silently no-ops
  // when null, leaving the ratchet half-advanced), the envelope is
  // silently dropped without an ack. Buffer inbound frames here until
  // the deps init block flips depsReady=true; drain in FIFO order.
  let depsReady = false;
  const pendingFrames: ServerFrame[] = [];

  // Single dispatch helper — used by both the live `onFrame` callback
  // and the post-deps `drainPendingFrames` call. Hoisted via `function`
  // declaration so it's available inside the TransportClient closure.
  function dispatchFrame(frame: ServerFrame): void {
    void handleServerFrame(frame, {
      own, ownStore, pendingByClientMsgId, config, relay, keys, peerIdentityCache,
      rehandshakeNudge: (peer) => sendRehandshakeNudge({
        own, ownStore, keys, peer, ownAddress, certCache, transport, relay,
      }),
      // B-46 — auto-resend destroyed-on-recipient envelopes.
      resendUndeliverable,
      onPong: ts => { lastPongAt = ts; },
      outbox: sqlOutbox,
      // Audit P0-N14 — both writers share the same SQLCipher handle,
      // so handleIncoming can wrap the decrypt → upsert pair in a
      // single BEGIN IMMEDIATE / COMMIT.
      txnDb: ownStore instanceof SqlCipherProtocolStore ? ownStore.getDb() : null,
      sqlMessages,
      // Audit P0-N6 — persistent receive-side envelope-id dedup.
      seenEnvelopes,
      // Audit 1:1 P1-1 — cert revocation cache.
      revokedJtiCache,
      // Bug-hunt #3 — stash for pre-master-key group envelopes +
      // out-of-epoch admin actions.
      pendingGroupEnvelopes,
      pendingAdminActions,
    }).catch(e => {
      // Round 6 / race fix — re-check the epoch in the .catch
      // because handleServerFrame is async and could resolve AFTER
      // logout. Without this, an error mid-frame would set a banner
      // on the new user's store.
      if (!isOurEpoch()) {return;}
      // Bug-hunt — log every frame-processing failure so we can see
      // silent drops in JS console / Crashlytics. The catch handler
      // is the last line of defence; anything reaching here is a bug.
      console.warn('[messenger.dispatchFrame] event=' + (frame as {event: string}).event + ' err=' + asErrorMessage(e));
      if (isRecoverableFrameError(e)) {
        useMessengerStore.getState().setRecoveryBanner(asErrorMessage(e));
      } else {
        useMessengerStore.getState().setError(asErrorMessage(e));
      }
    });
  }

  function drainPendingFrames(): void {
    if (pendingFrames.length === 0) {return;}
    const toRun = pendingFrames.splice(0, pendingFrames.length);
    console.log('[messenger.boot] depsReady — draining ' + toRun.length + ' buffered frame(s)');
    for (const f of toRun) {
      try { dispatchFrame(f); } catch (e) {
        console.warn('[messenger.boot] drain-dispatch threw:', asErrorMessage(e));
      }
    }
  }

  // socket.io transport for push delivery + fast send. The server runs
  // socket.io 4.x with the Redis adapter, so any replica in the cluster
  // can service this connection.
  const transport = new TransportClient({
    url:            config.wsUrl,
    signalDeviceId,
    getToken:       config.getToken,
    refreshToken:   config.refreshToken,
    // B-354 — headless boots connect presence-invisible (see ProductionConfig).
    background:     config.backgroundBoot === true,
    // B-101 LC-1/LC-2 — lets the transport skip its (RN-frozen-while-
    // locked) reconnect timers and re-open immediately when a call is on
    // the line, without stampeding the gateway for ordinary traffic.
    hasLiveCall:    () => { try { return hasLiveCall(); } catch { return false; } },
    // OR-2 — an unacked outbound message earns the same timer-free reopen a
    // live call gets: its ack watchdog and the 60s outbox tick are both
    // frozen while the screen is locked.
    hasPendingOutbound: () => pendingByClientMsgId.size > 0,
    // OR-2 — the server's engine.io ping is the only clock that survives a
    // locked screen (B-100/B-101 proved it for auth renewal). Ride it for the
    // outbox drain too, throttled to SIGNAL_DRAIN_MIN_INTERVAL_MS since this
    // also fires on every application frame. drainOutbox is self-guarded and
    // dueRows() is empty on an idle tick.
    onServerSignal: () => {
      if (!isOurEpoch() || !sqlOutbox) {return;}
      const now = Date.now();
      if (!shouldDrainOnServerSignal(lastSignalDrainAt, now)) {return;}
      lastSignalDrainAt = now;
      void drainOutboxWhenReady(sqlOutbox, relay, isOurEpoch, resealOutboxRow)
        .catch(e => console.warn('[messenger.outbox] signal drain failed:', asErrorMessage(e)));
    },
    onFrame: frame => {
      // Round 6 / race fix — drop frames that arrive after our owner
      // epoch was bumped (logout / user-switch in flight). Without
      // this, a frame that was already in the socket.io receive queue
      // at signOut() can run through handleServerFrame AFTER the next
      // user's runtime has wired up the store, writing the prior
      // user's plaintext into the new user's `messages` map. Silent
      // drop is correct: the prior user's transport will be torn
      // down, and they'll re-pull on next login if anything was
      // mid-flight.
      if (!isOurEpoch()) {
        return;
      }
      // Why: buffer until SQLCipher-backed deps (sqlMessages,
      // seenEnvelopes, txnDb, etc.) are wired (see depsReady declaration
      // above). Call frames are exempt — they have their own dispatcher
      // that doesn't need these deps, and any delay would drop a ringing
      // call. Drain runs at end of SQLCipher init block.
      //
      // B-602 — group-call RING frames get the SAME exemption as 1:1 call
      // frames: dispatchGroupRingFrame only navigates / dedups / acks (no
      // SQLCipher deps), so buffering it behind the cold-boot hydrate made
      // the B-479 restore-mode park/ack lane wait out the whole SQLCipher
      // hydrate while 1:1 calls rang through. The epoch gate above still
      // runs first (an out-of-epoch ring is dropped, not exempted).
      // `sfu.ring.missed` is NOT a ring frame here — it writes a bubble and
      // stays buffered.
      if (
        !depsReady &&
        !isCallFrame((frame as {event: string}).event) &&
        !isGroupRingFrame((frame as {event: string}).event)
      ) {
        pendingFrames.push(frame);
        return;
      }
      dispatchFrame(frame);
    },
    onStateChange: state => {
      // Round 6 / race fix — drop state callbacks that fire after our
      // epoch was bumped. socket.io's disconnect can take a tick or
      // two to propagate; a `disconnected` callback that lands AFTER
      // logout would mistakenly flip the NEW user's connection state.
      if (!isOurEpoch()) {return;}
      // Mirror into the store so the chat header banner can observe it
      // through a Zustand selector (no prop-drilling through navigation).
      useMessengerStore.getState().setConnection(state);
      if (state === 'superseded') {
        // Single-device takeover (WhatsApp model): a newer login of this
        // account on ANOTHER device evicted this socket. Don't leave the
        // user on the soft "reopen to switch back" banner — the auth-service
        // now REVOKES this device's token on the new login, so "switch back"
        // would re-login here and ping-pong the new device off. Fully sign
        // out so this device drops to the login screen instead. Deferred +
        // lazy-required so we don't re-enter this very state callback while
        // signOut() tears the runtime + transport down; the epoch re-check
        // skips it if a legit user-switch already happened.
        setTimeout(() => {
          if (!isOurEpoch()) {return;}
          try {
            const {useAuthStore} = require('@/store/authStore') as typeof import('@/store/authStore');
            void useAuthStore.getState().signOut();
          } catch { /* best-effort — next /auth/me 401 still ends the session */ }
        }, 0);
        return;
      }
      if (state === 'disconnected') {
        // Mark that the next connect is a RE-connect, not a fresh boot
        // — gates the presence-clear below.
        wasDisconnected = true;
      }
      if (state === 'connected') {
        // Catch-up pull on (re)connect — in case the socket was offline
        // while envelopes piled up on the relay. Failures are silent —
        // a transient pull error must not red-banner the chat surface;
        // next AppState active / WS reconnect retries automatically.
        coalescedDrain().catch(e => {
          if (!isOurEpoch()) {return;}
          console.warn('[bravo.drainRelay] reconnect drain failed:', asErrorMessage(e));
        });
        // P1-2 — retry the boot bundle upload that failed offline. One-shot
        // per reconnect; re-arms on a repeated failure so a still-flaky
        // auth-service is retried on the next `connected` transition.
        if (bootBundlePublishPending && livePublishOwnBundle) {
          bootBundlePublishPending = false;
          void livePublishOwnBundle().catch(e => {
            if (!isOurEpoch()) {return;}
            console.warn('[bravo.runtime] reconnect bundle-publish retry failed:', asErrorMessage(e).slice(0, 80));
            bootBundlePublishPending = true;
          });
        }
        // Durable outbox replay — on every reconnect, re-ship anything
        // that piled up while the socket was down (or from a previous
        // crashed session). Best-effort: failures keep the row in the
        // outbox so the NEXT reconnect retries.
        // Why: OM-07 — a completed handshake PROVES reachability, so this is
        // also the moment to drop the escalating offline backoff; without the
        // un-park a row parked at the ladder ceiling (2 min) is skipped by this very drain.
        if (sqlOutbox) {
          kickAndDrainOutbox(sqlOutbox, relay, isOurEpoch, resealOutboxRow, {unpark: true});
        }
        // WI-6.6 — reconnect-with-live-1:1: one call.sync round-trip heals
        // every "zombie call UI" divergence (missed hangup, relay restart).
        // The probe keys the teardown on the call's own {callId, gen} and
        // keeps the call on any transport error — only an explicit
        // ended/unknown verdict ends it.
        if (hasLiveCall()) {
          try {
            const {runCallSyncProbe} = require('./callSyncProbe') as typeof import('./callSyncProbe');
            void runCallSyncProbe({
              emitWithAck: (ev, d, t) => transport.emitWithAck(ev, d, t),
            }).catch(() => { /* best-effort */ });
          } catch { /* probe module unavailable */ }
        }
        // OM-03 — collect delivery outcomes for envelopes submitted over
        // HTTP while this socket was down (the relay had no live socket to
        // push envelope.delivered to). Reuses the existing idempotent
        // handlers; a relay without the route latches polling off.
        void reconcileHttpReceipts({
          fetchReceipts: items => relay.receipts(items),
          isOurEpoch,
          onUndeliverable: resendUndeliverable,
        });
        // Self-heal — a reconnect is the natural moment for a member that
        // came back online (or just logged in) to ask the owner to
        // re-share the key for any group it has no master key for. The
        // helper is defined later in this factory but this closure only
        // fires after construction, so the reference is safe. Rate-limited
        // per group inside; best-effort.
        if (isOurEpoch()) {
          void requestGroupKeyResyncImpl().catch(() => { /* best-effort */ });
        }
        // Phase-2 ratchet-snapshot capture — a reconnect implies the
        // socket was down for a spell, during which the peer likely
        // advanced our ratchets via inbound. Request a (debounced)
        // capture so a reinstall right after wouldn't lose that delta.
        try {
          const {requestCapture} = require('../backup/ratchetSnapshotScheduler') as
            typeof import('../backup/ratchetSnapshotScheduler');
          void requestCapture().catch(() => { /* best-effort */ });
        } catch { /* scheduler not loaded yet — fine */ }
        // B-48 — push-token self-heal. The server may have reaped this
        // device's FCM token rows while we were offline/killed (dead-token
        // GC, logout tombstone from an account switch elsewhere); the
        // client-side `serverRegistered` flag can't see that. Re-assert
        // both /push/register* rows on every reconnect — throttled inside
        // (60s min interval), idempotent POSTs, best-effort.
        try {
          const {ensurePushRegistered} = require('../push/fcmBootstrap') as
            typeof import('../push/fcmBootstrap');
          void ensurePushRegistered().catch(() => { /* best-effort */ });
        } catch { /* push module not loaded (tests) — fine */ }
        // Round 8 / false-active audit fix #2 — flip subscribed peers
        // to `offline` BEFORE resubscribing on a real reconnect. While
        // the socket was down we received zero presence frames; any
        // peer who went offline mid-disconnect would otherwise stay
        // pinned at the last-known `online`/`active` value forever.
        // The server's `presence.subscribe` snapshot will repaint the
        // truly-online ones in ~1 RTT.
        //
        // Two guards keep this from flickering the UI:
        //   1. `wasDisconnected` — skip on the initial connect, where
        //      there's nothing stale to clear.
        //   2. `PRESENCE_CLEAR_DEBOUNCE_MS` — under poor networks
        //      socket.io retries every 1-5s; without debounce the
        //      chat-list dots would strobe through every backoff cycle.
        if (
          wasDisconnected
          && presenceSubscriptions.size > 0
          && Date.now() - lastPresenceClearAtMs > PRESENCE_CLEAR_DEBOUNCE_MS
        ) {
          try {
            useMessengerStore.getState().clearPresence([...presenceSubscriptions.keys()]);
            lastPresenceClearAtMs = Date.now();
          } catch { /* store may be mid-swap during owner switch */ }
        }
        wasDisconnected = false;
        // Round 7 / presence audit fix #1 — replay every presence
        // subscription so the new socket joins the right `watch:<id>`
        // rooms. Without this, watchers go silent after any blip.
        if (presenceSubscriptions.size > 0) {
          try {
            transport.subscribePresence([...presenceSubscriptions.keys()]);
          } catch { /* socket reconnect race — next state-change retries */ }
        }
        // Round 7 / presence audit fix #2 — re-assert our own activity
        // so peers see us light up immediately after a reconnect rather
        // than after the next AppState change.
        try {
          transport.setActivity(lastActivity);
          console.warn('[PRESDIAG] replay activity', lastActivity, config.backgroundBoot ? '(bg)' : '');
        } catch { /* socket race */ }
        // Audit MSG-06 / P2-7 — flush read receipts that couldn't be sent
        // while the socket was down. Entries are removed per-peer only
        // after their emit succeeded; failures stay queued (durably) for
        // the next reconnect/foreground flush.
        flushPendingReadReceipts();
      }
    },
  });
  // Notif-latency E1 — hand the boot bundle publish's failure path its
  // connected-check (see runBootBundlePublish above; assigned here because
  // the transport cannot exist before its own construction).
  transportRef = transport;

  // Audit P2-7 — restore the durable read-receipt queue from a previous
  // process (app killed while offline) and flush it once connected.
  void (async () => {
    try {
      const AsyncStorage = (require('@react-native-async-storage/async-storage') as
        {default: {getItem(k: string): Promise<string | null>}}).default;
      const raw = await AsyncStorage.getItem(pendingReadReceiptsKey);
      if (!raw || !isOurEpoch()) {return;}
      const rows = JSON.parse(raw) as Array<{peer: SessionAddress; envelopeIds: string[]}>;
      if (!Array.isArray(rows)) {return;}
      for (const r of rows) {
        if (!r?.peer?.userId || !Array.isArray(r.envelopeIds)) {continue;}
        const key = `${r.peer.userId}.${r.peer.deviceId}`;
        const slot = pendingReadReceipts.get(key) ?? {peer: r.peer, envelopeIds: new Set<string>()};
        for (const id of r.envelopeIds) {if (typeof id === 'string') {slot.envelopeIds.add(id);}}
        pendingReadReceipts.set(key, slot);
      }
      flushPendingReadReceipts();
    } catch { /* AsyncStorage unavailable / corrupt row — memory queue still works */ }
  })();

  // Fix #4: coalesce concurrent drains. WS reconnect, AppState 'active',
  // and ChatScreen.pullEnvelopes() can all race; without a mutex the
  // server logs three back-to-back GET /envelopes from the same device.
  // While inflight, every caller gets the same Promise.
  // Fix #5: paginate — keep pulling until the server has nothing left
  // (or 10 iterations as a hard cap; anything more is symptomatic of
  // an ack failure loop and we want to break out cleanly).
  // B-703 MR-1 — the last completed drain's report, plus a sequence stamp so a
  // caller can tell "my drain ran and reported this" from "coalescedDrain
  // resolved without draining" (the epoch bail). Never read without the stamp.
  let lastPullReport: RelayPullReport | null = null;
  let pullReportSeq = 0;
  const drainPump = createRerunCoalescer(async () => {
    // Re-check inside the async — between the synchronous gate in
    // coalescedDrain and the first await (and again on every latched
    // re-run), signOut could have flipped the epoch. Cheap.
    if (!isOurEpoch()) {return;}
    const report = await drainRelay(
      own, ownStore, relay, config, keys,
      (peer) => {
        if (!isOurEpoch()) {return;}
        void sendRehandshakeNudge({own, ownStore, keys, peer, ownAddress, certCache, transport, relay});
      },
      peerIdentityCache,
      // Audit P0-N14 — atomic ratchet+plaintext on the drain path too.
      ownStore instanceof SqlCipherProtocolStore ? ownStore.getDb() : null,
      sqlMessages,
      // Audit P0-N6 — dedup on the HTTP catch-up path too.
      seenEnvelopes,
      // Audit 1:1 P1-1 — cert revocation cache on the drain path too.
      revokedJtiCache,
      // Bug-hunt #3 — pending-stash threading on the drain path too.
      pendingGroupEnvelopes,
      pendingAdminActions,
    );
    lastPullReport = report;
    pullReportSeq += 1;
  });

  /**
   * FIX-05 — publish the catch-up phase for the UI.
   *
   * Deliberately from the ONE coalescer below rather than each of the five
   * drain trigger sites (WS connect, AppState active, ChatScreen focus,
   * notification tap, push wake) — the repo's most common bug shape is N
   * drifted copies of one behaviour.
   *
   * Never from a headless boot: that JS VM has no hydrated store (the
   * B-361/B-363 class), and writing into it there is how a background wake
   * corrupts what the foreground app renders on next launch.
   */
  const publishSyncState = (s: 'syncing' | 'synced'): void => {
    if (config.backgroundBoot) {return;}
    if (!isOurEpoch()) {return;}
    try { useMessengerStore.getState().setSyncState(s); } catch { /* store not ready */ }
  };

  const coalescedDrain = (): Promise<void> => {
    // Round 6 / race fix — bail before kicking off a drain when we're
    // no longer the live runtime. drainRelay walks the relay queue and
    // funnels each envelope through handleIncoming → store mutations,
    // any of which would land on the new user's store if our epoch is
    // stale. Gating here also means a stale caller can't arm the re-run
    // latch.
    if (!isOurEpoch()) {return Promise.resolve();}
    publishSyncState('syncing');
    // SRV-05 — push out any coalesced acks as soon as the drain settles so
    // the relay can prune promptly (the 200ms window is the fallback).
    // FIX-05 — `finally`, not `then`: drainRelay swallows its own errors, and a
    // phase that can stick on 'syncing' is worse than no phase at all.
    return drainPump().finally(() => {
      void flushAckQueue(relay);
      publishSyncState('synced');
    });
  };

  // Notif-latency F1 (docs/audits/NOTIF_TAP_TO_MESSAGE_LATENCY_2026-08-01.md)
  // — deliberately NOT awaited. connect() resolves after its token read (and,
  // since the E2 fix, a possible token-refresh roundtrip when the on-disk
  // token expired — i.e. every cold boot after hours killed), none of which
  // the SQLCipher hydration below needs. Awaiting it put that network wait
  // ahead of setReady(true), so the chat surface showed "Initializing secure
  // session…" for messages that were already on disk. Inbound frames that
  // land before depsReady are buffered (see onFrame) and drained after the
  // hydrate block, so nothing is lost either way. A rejection here (getToken
  // threw — AsyncStorage blip) used to REJECT the whole build and brick the
  // messenger for the process lifetime via runtime.ts's cached promise; now
  // it logs, and the AppState-active forceReconnect path recovers the socket.
  void transport.connect().catch(e =>
    console.warn('[bravo.runtime] boot transport connect failed:', asErrorMessage(e)));

  // Network-handover fix: subscribe to NetInfo so a Wi-Fi ↔ cellular
  // swap kicks the WS off the dead route inside ~1s instead of waiting
  // for socket.io's 25s heartbeat to notice. Symptom we're fixing: the
  // user's logcat (05-14 07:42:56) showed sockets destroyed at the OS
  // layer while the JS-side ws still believed itself connected — the
  // next `call.offer` queued forever because the underlying TCP was
  // dead. NetInfo fires immediately on the OS-level connectivity-change
  // broadcast (the same source ConnectivityService.broadcastDNS uses),
  // so we get the signal long before socket.io would.
  //
  // We unsubscribe at runtime teardown (epoch flip / logout); the
  // subscription lifetime is bound to this transport.
  let netInfoUnsub: (() => void) | null = null;
  // FIX-03 — last known radio state, so the AppState-'active' handler can
  // decide synchronously. NetInfo.fetch() is async and `decideResumeAction`
  // must answer in the same tick; the listener below keeps this current.
  // Defaults to true: never withhold a reconnect because we haven't heard yet.
  let netOnline = true;
  try {
    const NetInfo = (require('@react-native-community/netinfo') as typeof import('@react-native-community/netinfo')).default;
    let lastType: string | undefined;
    let lastReachable: boolean | null | undefined;
    netInfoUnsub = NetInfo.addEventListener((state) => {
      // Only act on actual transitions — NetInfo emits an initial
      // snapshot at subscribe time and a noisy stream of duplicates
      // during steady state.
      const changed =
        state.type !== lastType ||
        state.isInternetReachable !== lastReachable;
      lastType = state.type;
      lastReachable = state.isInternetReachable;
      if (!changed) {return;}
      if (state.isConnected && state.isInternetReachable !== false) {
        // Audit (FIX-03 round 2) — record the radio state BEFORE the early
        // returns below. `netOnline = true` used to sit after them, so a
        // positive event that early-returned on a fresh pong left the flag
        // stale-false and the next AppState resume parked a healthy network.
        netOnline = true;
        // Why: Android's NetInfo is chatty — `isInternetReachable` can
        // flap on captive-portal probes, transient DNS hiccups, and
        // 4G/5G band changes even on a steady connection. Every flap
        // used to fire notifyNetworkChange() → forceReconnect() which
        // destroys + rebuilds the WS, blowing away in-flight `envelope.send`
        // emits and forcing a fresh handshake. Skip the rebuild when
        // our server-pong is recent (≤10s): the socket is genuinely
        // alive and the OS-level connectivity-change is a false alarm.
        // Real handovers (Wi-Fi → cellular) drop pings so pong staleness
        // catches them within one heartbeat interval (25s).
        const pongFresh = transport.state === 'connected'
          && lastPongAt > 0
          && (Date.now() - lastPongAt) < 10_000;
        // B-101 LC-3 — the B-58 live-call guard belongs here too, but it
        // must decide SYNCHRONOUSLY. `pongFresh` is structurally
        // unreachable during a backgrounded call (the 4s heartbeat that
        // advances lastPongAt is a frozen timer while the screen is
        // locked), so every connectivity flap — including the
        // captive-portal false alarms described above — used to tear
        // down a healthy in-call socket, which the gateway reads as a
        // call drop (12s disconnect-bye / 10s SFU leave grace).
        //
        // The AppState-'active' twin answers this with a deferred
        // ping-probe, which is sound there because it only runs in the
        // foreground. Copying that here would be WRONG (review RT-1):
        // this handler's whole purpose is to fire in the background,
        // where the 3s verdict timer never runs — a genuinely dead
        // socket would then never be rebuilt at all. Instead judge
        // liveness from the transport's own inbound-signal clock, which
        // the server's ~25s heartbeat keeps advancing even while locked.
        if (pongFresh) {return;}
        if (hasLiveCall()) {
          const silentFor = transport.msSinceServerSignal();
          if (silentFor < SERVER_SILENCE_DEAD_MS) {
            // The server was heard from within one heartbeat window: the
            // socket is genuinely alive and this NetInfo event is noise.
            return;
          }
          // Silent past a full heartbeat — the route really is dead.
          // Fall through and rebuild immediately.
        }
        void transport.notifyNetworkChange().catch(() => { /* best-effort */ });
        // Why: OR-1 — this fires in the background too, where the AppState twin
        // never runs, and the HTTP relay path the drain uses does not need the
        // socket to have re-handshaked yet.
        if (sqlOutbox) {
          kickAndDrainOutbox(sqlOutbox, relay, isOurEpoch, resealOutboxRow);
        }
      } else if (state.isConnected && transport.isNetworkParked()) {
        // Audit (FIX-03 round 2) — the un-park escape hatch. On networks where
        // Android's connectivity validation never succeeds (the OS 204-probe
        // endpoint firewalled: corporate, hotel, some carriers),
        // `isInternetReachable` reports false INDEFINITELY, the positive branch
        // above never fires, and a parked transport stayed parked for the rest
        // of the process — a network class where the old B-14 ladder
        // reconnected fine. While PARKED, `isConnected` alone is enough to try:
        // the handshake itself is the reachability probe, and one failed
        // attempt just re-enters the (now unparked) normal backoff. Deliberately
        // gated on isNetworkParked() so ordinary reachability flaps on a live
        // socket keep their pre-FIX-03 meaning: noise.
        netOnline = true;
        void transport.notifyNetworkChange().catch(() => { /* best-effort */ });
      } else if (state.isConnected === false) {
        // FIX-03 — the radio is genuinely down. Before this branch existed the
        // client kept handshaking into the void at the 30s ceiling for as long
        // as the user stayed offline (spec §5: "stop/reduce retries when the
        // app is genuinely offline").
        //
        // Deliberately `=== false`, not falsy: `isInternetReachable === null`
        // means UNKNOWN, and every unknown must read as online — the whole
        // reason the positive branch above is so defensive is that this signal
        // lies. For the same reason a live call vetoes parking outright:
        // trusting one NetInfo blip over an in-flight call is a worse bug than
        // the battery drain this saves.
        netOnline = false;
        if (hasLiveCall()) {return;}
        transport.setNetworkDown();
      }
    });
  } catch (e) {
    // NetInfo missing (web / test) — skip the optimisation, transport
    // still has its own 25s heartbeat-based reconnect.
    console.warn('[productionRuntime] NetInfo subscribe failed:', (e as Error)?.message);
  }
  // Stash so teardown can release it.
  (transport as unknown as {_netInfoUnsub?: () => void})._netInfoUnsub = netInfoUnsub ?? undefined;

  // Restore-after-reinstall fix #3 — wire up the sealed-archive replay
  // closure now that all the deps exist. The closure feeds a synthetic
  // ServerEnvelopeDeliver through handleDeliver, which unseals + calls
  // handleIncoming + writes to the local store + acks the relay. The
  // archive replay does not call ack(envelopeId) because the IDs come
  // from the long-term Supabase mirror, not Redis — so handleDeliver's
  // ack is a no-op against an unknown id, which the relay's ack path
  // already handles idempotently. See sealed_envelope_archive.sql.
  liveReplayArchive = async (env) => {
    if (!isOurEpoch()) {return;}
    const fakeFrame: ServerEnvelopeDeliver = {
      event: 'envelope.deliver',
      data: {
        envelopeId:  env.envelopeId,
        outerSealed: env.outerSealed,
        timestamp:   env.timestampMs,
      },
    };
    // B-594 — bracket the replay so the receive path can tell it apart from a
    // genuinely live arrival. Everything below is deliberately identical to
    // the WS path (audit §12.4), which is exactly why the conversation
    // tombstone gate cannot infer it. `finally` so a throw cannot leave the
    // bracket set and make later LIVE messages read as replays.
    beginArchiveReplay();
    try {
    await handleDeliver(fakeFrame, {
      own, ownStore, pendingByClientMsgId, config, relay, keys, peerIdentityCache,
      // Audit §12.4 (2026-07-10) — the replay path previously stripped SIX
      // deps the live WS path carries, so replayed envelopes (a) skipped the
      // wasSeen gate and double-decrypted live-processed envelopes (Bad MAC
      // → spurious rehandshake resets of healthy sessions), (b) ack-dropped
      // keyless group envelopes instead of durably stashing them, (c)
      // dropped out-of-epoch admin actions, (d) lost the atomic
      // ratchet+plaintext receive txn (P0-N14), and (e) skipped sender-cert
      // revocation enforcement (P3-B-1). Thread them all, same as the live
      // dispatchFrame.
      txnDb: ownStore instanceof SqlCipherProtocolStore ? ownStore.getDb() : null,
      sqlMessages,
      seenEnvelopes,
      revokedJtiCache,
      pendingGroupEnvelopes,
      pendingAdminActions,
      rehandshakeNudge: async (peer) => {
        // Audit §12.4 — suppress replay-sourced Bad-MAC nudges for envelopes
        // the wasSeen gate would have caught (already processed live: the
        // message key is burned, the session is HEALTHY — a nudge would
        // reset it). Only genuinely-unseen replay failures still nudge.
        try {
          if (seenEnvelopes && await seenEnvelopes.wasSeen(env.envelopeId)) {return;}
        } catch { /* dedup-store hiccup — fall through to the nudge */ }
        await sendRehandshakeNudge({
          own, ownStore, keys, peer, ownAddress, certCache, transport, relay,
        });
      },
    });
    } finally {
      endArchiveReplay();
    }
  };
  liveDisposers.push(() => { liveReplayArchive = null; });

  // Publish the live socket so non-runtime surfaces (CallScreen,
  // useTransportRtt) can ride the same authenticated channel for
  // call.offer/answer/ice signalling and ping-pong RTT.

  const {setLiveTransport} = require('./transportRegistry') as typeof import('./transportRegistry');
  setLiveTransport(transport);

  // Foreground/background hook. On Android Doze and iOS background
  // suspend, the socket fd often gets torn down silently — socket.io's
  // own reconnect logic only fires when the OS lets it run again, which
  // can be many seconds after the user reopens the app. Eagerly
  // re-asserting the connection on AppState 'active' makes the
  // resume-from-lock-screen flow snappy and avoids the user staring at
  // a "Reconnecting…" banner that won't budge until the next heartbeat.

  const {AppState} = require('react-native') as typeof import('react-native');
  const appStateSub = AppState.addEventListener('change', (s: string) => {
    // Round 6 / race fix — disposeLiveRuntime removes this subscription
    // synchronously, but if a pending AppState change is already
    // queued in RN's event loop it could fire after dispose. Bail.
    if (!isOurEpoch()) {return;}
    if (s === 'active') {
      // Fix #7: skip force-reconnect when the socket is genuinely live.
      // Previously we ALWAYS tore the socket down on every foreground
      // transition — even a 2-second swipe-up-and-back would burn a
      // full handshake + replay. Use the heartbeat-pong recency to
      // decide: if we've heard from the server within 8s, the socket
      // is healthy and the Doze-thaw safety net isn't needed. If
      // the pong is older (or never observed), tear down + reconnect.
      const pongFresh = transport.state === 'connected'
        && (Date.now() - lastPongAt) < 8000
        && lastPongAt > 0;
      // FIX-03 — the resume decision used to read only the pong and the live
      // call, so a foreground with the radio still down went straight to
      // forceReconnect() and a doomed handshake. Consult the last NetInfo
      // verdict too; the same two rules as the listener apply — only an
      // explicit `isConnected === false` counts, and a live call vetoes.
      const parkForNetwork = !netOnline && !hasLiveCall();
      const resumeAction = parkForNetwork ? 'park' : decideResumeAction(pongFresh, hasLiveCall());
      // OR-6 — resume must kick the SEND side too. `drain`/`probe` mean the
      // socket never dropped, so the `connected` handler's outbox replay
      // (the only other non-timer kick) never fires and a due row waits up to
      // a full 60s outboxRetryTimer period. drainOutbox ships over HTTP, so it
      // works in all three branches; it self-coalesces and dueRows() filters on
      // next_retry_at, so an idle resume costs one empty SELECT. OR-1 upgrades
      // the raw kick to the throttled kick+drain so a row parked on the offline
      // backoff is pulled forward instead of waiting the backoff out.
      if (sqlOutbox) {
        kickAndDrainOutbox(sqlOutbox, relay, isOurEpoch, resealOutboxRow);
      }
      // F-5 (B-693) — resume polls the RECEIPT side too, for the same OR-6
      // reason as the outbox kick above: on a 'drain'/'probe' resume the
      // socket never dropped, so the 'connected' handler's receipt poll
      // (the only other non-timer site) never fires and a ✓✓ that settled
      // while backgrounded waited up to the full 60s timer. Single-flight
      // and 100-probe-capped inside; an idle resume costs one selector pass.
      void reconcileHttpReceipts({
        fetchReceipts: items => relay.receipts(items),
        isOurEpoch,
        onUndeliverable: resendUndeliverable,
      });
      if (resumeAction === 'park') {
        // Offline resume: keep the ladder parked (the listener already did it)
        // and skip the handshake. The outbox kick above still ran — it is HTTP
        // and self-throttling, and NetInfo may be wrong in the safe direction.
        transport.setNetworkDown();
        // Audit (FIX-03 round 2) — but do not TRUST the stale flag: `netOnline`
        // only updates on NetInfo EVENTS, and a network that returned while
        // the app was backgrounded may never emit one this process can see
        // (validation-blocked networks report isInternetReachable=false
        // forever). A foreground is the user actively asking for the app, so
        // spend one async fetch: isConnected → un-park and reconnect.
        try {
          const NetInfo = (require('@react-native-community/netinfo') as typeof import('@react-native-community/netinfo')).default;
          void NetInfo.fetch().then(net => {
            if (!isOurEpoch() || net.isConnected === false) {return;}
            netOnline = true;
            void transport.notifyNetworkChange().catch(() => { /* best-effort */ });
            coalescedDrain().catch(() => { /* silent */ });
          }).catch(() => { /* NetInfo blip — the next event owns it */ });
        } catch { /* NetInfo missing (web/test) */ }
      } else if (resumeAction === 'drain') {
        // Still kick a coalesced drain to catch any envelopes that
        // piled up while the app was background. Cheap; idempotent.
        coalescedDrain().catch(() => { /* silent */ });
      } else if (resumeAction === 'probe') {
        // P1-BR-4 (B-58) — a live call's foreground service kept the
        // socket alive even though the backgrounded heartbeat left the
        // pong stale. forceReconnect() here would disconnect() the healthy
        // socket, and the gateway then hangs up the peer with a
        // call.hangup{failed}. Instead PROBE: send one ping and only
        // rebuild if no pong arrives within ~3 s (a genuinely dead socket).
        const probeAt = Date.now();
        try { transport.send({event: 'ping', data: {ts: probeAt}}); } catch { /* not open */ }
        // WI-6.6 — resume-with-live-call: the socket may be healthy (FGS kept
        // it up) yet the CALL state diverged while backgrounded (missed
        // hangup). One call.sync settles it; keyed teardown, keep-on-error.
        try {
          const {runCallSyncProbe} = require('./callSyncProbe') as typeof import('./callSyncProbe');
          void runCallSyncProbe({
            emitWithAck: (ev, d, t) => transport.emitWithAck(ev, d, t),
          }).catch(() => { /* best-effort */ });
        } catch { /* probe module unavailable */ }
        setTimeout(() => {
          if (!isOurEpoch()) {return;}
          const pongLanded = lastPongAt >= probeAt;
          // Only tear down if the probe went unanswered AND the socket
          // isn't reporting connected — never rip a still-live call's
          // socket out from under it on the strength of a stale pong.
          if (!pongLanded && transport.state !== 'connected') {
            void transport.forceReconnect().catch(() => { /* surfaces via state machine */ });
          }
          coalescedDrain().catch(() => { /* silent */ });
        }, 3000);
        // Drain immediately too so queued envelopes aren't held for 3 s.
        coalescedDrain().catch(() => { /* silent */ });
      } else {
        void transport.forceReconnect().catch(() => { /* surfaces via state machine */ });
      }
      // Audit (FIX-14 round 2) — the stale-ring sweep's contract says "boot and
      // foreground", but the only call site was FCM bootstrap (= boot). An app
      // that stays alive but backgrounded — ring drawn, cancel push lost in
      // Doze — kept the dead ring until the next full process start, and the
      // foreground pass is the one where the in-memory tombstones are actually
      // populated. Fire-and-forget; Android-only inside; live call excluded.
      try {
        const {sweepStaleCallNotifications} = require('../push/callNotification') as typeof import('../push/callNotification');
        const {getActiveCall} = require('./callRegistry') as typeof import('./callRegistry');
        void sweepStaleCallNotifications({
          isLive: (cid) => getActiveCall()?.callId === cid,
        }).catch(() => { /* best-effort */ });
      } catch { /* notif module unavailable */ }
      // Audit P2-7 — foreground is a flush point for queued read receipts
      // (no-op when the socket isn't connected; the onStateChange
      // 'connected' branch flushes after the reconnect instead).
      flushPendingReadReceipts();
      // Round 7 / presence audit fix #2 — flip back to active on every
      // foreground transition so the user reports `active` to peers
      // for the entire time they're using the app, not just when they
      // happen to have a chat thread open. If the socket isn't ready
      // yet the onStateChange('connected') branch will replay this.
      lastActivity = 'active';
      try {
        transport.setActivity('active');
        console.warn('[PRESDIAG] sent activity=active (foreground)');
      } catch { /* socket not open */ }
    } else if (s === 'background' || s === 'inactive') {
      lastActivity = 'away';
      try {
        transport.setActivity('away');
        console.warn('[PRESDIAG] sent activity=away (background)');
      } catch { /* socket not open */ }
      // OR-2 — the last window before RN freezes the JS timer queue. A
      // message handed to the WS moments ago has only its (now suspended)
      // 5-20s ack watchdog and the 60s outbox tick to rescue it, so a
      // half-dead fd swallows it until unlock. Ship the durable outbox over
      // HTTP right now; the relay dedups on (recipient, clientMsgId), so a
      // WS ack that lands anyway costs nothing. 'inactive' is excluded — iOS
      // fires it for every notification banner and control-centre pull.
      if (s === 'background' && sqlOutbox) {
        void drainOutboxWhenReady(sqlOutbox, relay, isOurEpoch, resealOutboxRow)
          .catch(e => console.warn('[messenger.outbox] background drain failed:', asErrorMessage(e)));
        void flushAckQueue(relay);
      }
    }
  });
  // Park the subscription on a module-level slot so a future runtime
  // reset can dispose it — leaking listeners would re-fire on every
  // login and bombard the socket with redundant connect() calls.
  // Fix #1: also register on liveDisposers so the test/_reset path
  // unwinds it without needing to know about every individual slot.
  liveAppStateSub?.remove?.();
  liveAppStateSub = appStateSub;
  liveDisposers.push(() => { appStateSub.remove?.(); });

  // Heartbeat ping every 4s while the socket is open. The server's
  // pong handler echoes the original ts; the frame loop above turns
  // that into an RTT sample published to rttRegistry. We deliberately
  // don't bail on send failures — TransportClient buffers in
  // 'reconnecting' state and the next interval picks up cleanly.
  //
  // Park the handle on a module slot so disposeLiveRuntime() can
  // clear it on logout / runtime rebuild — otherwise the previous
  // interval keeps firing against a torn-down transport (Fix #1).
  // Bail on 'unauthorized' so we don't ping a dead socket forever
  // after the user signs out / token-revoke (Fix #20).
  if (liveHeartbeat) { clearInterval(liveHeartbeat); }
  liveHeartbeat = setInterval(() => {
    // Round 6 / race fix — even though disposeLiveRuntime clears this
    // interval, a final tick can fire between the schedule decision
    // and the clearInterval taking effect. Bail when our epoch is
    // stale so we don't ping a torn-down transport with a token that
    // belongs to the previous user.
    if (!isOurEpoch()) {return;}
    if (transport.state === 'unauthorized') { return; }
    try { transport.send({event: 'ping', data: {ts: Date.now()}}); } catch { /* not open */ }
    // Phase-2 ratchet-snapshot capture — piggy-back the heartbeat as the
    // capture cadence. requestCapture() self-debounces to one upload per
    // MIN_CAPTURE_INTERVAL_MS, so calling it every 4s is effectively a
    // ~5-min capture loop with no extra timer to manage / dispose.
    try {
      const {requestCapture} = require('../backup/ratchetSnapshotScheduler') as
        typeof import('../backup/ratchetSnapshotScheduler');
      void requestCapture().catch(() => { /* best-effort */ });
    } catch { /* scheduler not loaded — fine */ }
  }, 4000);

  // SQLCipher message store — spec compliance for §2.2 ("Message store:
  // SQLCipher-encrypted local SQLite database"). Only available when
  // ownStore is the production SqlCipherProtocolStore (loopback runs
  // entirely in memory and skips this path).
  let sqlMessages: SqlMessageStore | null = null;
  let seenEnvelopes: SeenEnvelopeStore | null = null;
  // Bug-hunt #1.B/C — persistent session-wipe-protection state. Lives
  // in the same SQLCipher DB so the in-process Map cache in
  // `sessionWipeProtection` can be lazily filled from disk on cold
  // start instead of evaporating with the process.
  let peerSessionHealth: PeerSessionHealthStore | null = null;
  // Bug-hunt #3 — durable stash for group envelopes that arrived before
  // we held the master key, and admin actions that arrived out-of-epoch
  // order. Both live in the same SQLCipher DB so stash writes can
  // commit atomically with the receive transaction.
  let pendingGroupEnvelopes: PendingGroupEnvelopeStore | null = null;
  let pendingAdminActions: PendingAdminActionStore | null = null;
  // Durable outbox is declared earlier in the function so the
  // transport's onFrame closure can capture it without TDZ; here we
  // just construct it once the SQLCipher DB is available below.
  // Persistent media blob cache — keyed by R2 object key, lives in the
  // same SQLCipher DB so disk forensics can't recover the encrypted
  // bytes without the keychain key. The expiry sweeper, retract path,
  // and conversation-clear handler purge entries here when their
  // backing message is removed.
  let mediaCache: MediaBlobCache | null = null;
  if (ownStore instanceof SqlCipherProtocolStore) {
    sqlMessages = new SqlMessageStore(ownStore.getDb());
    sqlOutbox   = new SqlOutboxStore(ownStore.getDb());
    mediaCache  = new MediaBlobCache(ownStore.getDb());
    // MI-06 — composer drafts: SQLCipher-backed sink (a draft is message
    // plaintext, so AsyncStorage is off-limits) + boot hydrate so drafts
    // survive restart. Sink cleared on dispose so a logout→login rebuild
    // can't write into the previous user's DB.
    {
      const draftsStore = sqlMessages;
      // F6 rev-3 (edge escalation) — a key the sink SAW during the boot
      // window (typed, or cleared after a type — a STANDALONE clear
      // early-returns in setDraft before the sink and is not recorded;
      // that ghost is transient and heals at the unmount flush — critic
      // rev-3) must beat the disk copy. A plain
      // live-wins merge cannot see a CLEAR: setDraft('') DELETES the store
      // key, so the disk copy filled the gap — and ChatScreen re-entry then
      // re-persisted the resurrected text, making the ghost PERMANENT.
      const touchedDuringBoot = new Set<string>();
      registerDraftSink({set: (cid, content) => {
        touchedDuringBoot.add(cid);
        return draftsStore.setDraft(cid, content);
      }});
      liveDisposers.push(() => registerDraftSink(null));
      draftsStore.loadDrafts()
        .then(drafts => {
          if (Object.keys(drafts).length > 0) {
            // AUDIT-2026-08-13 F6 — MERGE under the live state, never replace:
            // the load is async, so a draft the user is typing RIGHT NOW
            // (store-first, disk lagging) was wholesale-clobbered by the
            // stale disk copy on boot. Live keys win; disk fills only the
            // gaps the user has NOT touched this session.
            useMessengerStore.setState(s => {
              const fill: Record<string, string> = {};
              for (const [cid, content] of Object.entries(drafts)) {
                if (!touchedDuringBoot.has(cid)) {fill[cid] = content;}
              }
              return {drafts: {...fill, ...s.drafts}};
            });
          }
        })
        .catch(e => console.warn('[messenger.drafts] boot hydrate failed:', asErrorMessage(e)));
    }
    // Audit P0-N6 — persistent envelope-id dedup. Pruned to 35 days
    // on each boot so the table stays bounded.
    seenEnvelopes = new SeenEnvelopeStore(ownStore.getDb());
    seenEnvelopes.prune().catch(e =>
      console.warn('[messenger.seenEnvelopes] boot prune failed:', asErrorMessage(e)));
    // Bug-hunt #1 — warm the persistent peer-session-health store and
    // attach it to `sessionWipeProtection`. The warm is cheap (single
    // SELECT bounded by distinct-peer count); doing it once on boot
    // lets the synchronous hot path (`hasRecentSuccessfulDecrypt`,
    // `shouldAttemptRebuild`) consult the rows from before this restart
    // without an SQL round-trip per envelope. Failure here just leaves
    // the cold-start window open (the legacy behaviour) — don't block
    // boot on it.
    peerSessionHealth = new PeerSessionHealthStore(ownStore.getDb());
    try {
      await peerSessionHealth.warm();
      attachHealthStore(peerSessionHealth);
    } catch (e) {
      console.warn('[messenger.peerSessionHealth] boot warm failed:', asErrorMessage(e));
    }
    // TOFU send-gate — hydrate the persisted pending-identity-ack map so a
    // change noted in a prior session survives restart (no-op unless the gate
    // flag is enabled; hydration is cheap and fail-open).
    try { await hydratePeerIdentityAcks(); } catch { /* fail-open */ }
    // Bug-hunt #3 — pending-group-envelope + pending-admin-action stash.
    // Boot prune trims anything older than RETENTION_MS (7 days);
    // the matching relay copies have long since expired by then, so
    // these rows would never be drainable. Prune is fire-and-forget
    // so a slow DELETE doesn't block the receive path coming online.
    pendingGroupEnvelopes = new PendingGroupEnvelopeStore(ownStore.getDb());
    pendingAdminActions   = new PendingAdminActionStore(ownStore.getDb());
    pendingGroupEnvelopes.prune().catch(e =>
      console.warn('[messenger.pendingGroupEnvelopes] boot prune failed:', asErrorMessage(e)));
    pendingAdminActions.prune().catch(e =>
      console.warn('[messenger.pendingAdminActions] boot prune failed:', asErrorMessage(e)));
    // SYNC-7 — durable pending-reaction stash. Handle lives at module scope in
    // pendingReactionApply (the receive-path functions are module-level);
    // nulled on dispose so a logout→login rebuild can't write into the
    // previous user's DB. Boot: prune, then sweep any stash whose target
    // landed through a path with no drain hook (restore, older build).
    const reactionStash = new PendingReactionStore(ownStore.getDb());
    setPendingReactionStore(reactionStash);
    liveDisposers.push(() => setPendingReactionStore(null));
    // Same lifecycle for the edit / delete-for-everyone stash: an edit or a
    // delete is a pairwise control envelope that routinely overtakes the
    // master-key-encrypted text it targets, and the receive path ACKs it, so a
    // drop is permanent divergence. Handle nulled on dispose for the same
    // logout→login reason.
    const mutationStash = new PendingMutationStore(ownStore.getDb());
    setPendingMutationStore(mutationStash);
    liveDisposers.push(() => setPendingMutationStore(null));
    // SRV-05 — drop any coalesced acks still queued for this runtime's relay
    // client on logout/rebuild (a fresh client starts with a clean queue).
    liveDisposers.push(() => disposeAckQueue(relay));
    {
      const messagesForReactions = sqlMessages;
      void (async () => {
        try {
          await reactionStash.prune();
          await sweepPendingReactions(messagesForReactions);
        } catch (e) {
          console.warn('[messenger.pendingReactions] boot sweep failed:', asErrorMessage(e));
        }
        try {
          await mutationStash.prune();
          await sweepPendingMutations(messagesForReactions);
        } catch (e) {
          console.warn('[messenger.pendingMutations] boot sweep failed:', asErrorMessage(e));
        }
      })();
    }
    // B-124/B-125 — one-shot sweep of call-escalation contamination: the
    // shadow-minted `direct:<self>` duplicate, group-typed junk threads on
    // `direct:`-shaped ids, and 'Call' key aliases filed under chat-bearing
    // slots. Existing prunes can never reach these (ghost prune skips
    // non-group types; server reconciliation only touches dashed UUIDs; the
    // ad-hoc group has no server counterpart), so already-affected installs
    // stay broken without this. Runs at boot (no live call) — the next call
    // re-mints its key cleanly.
    try {
      const st = useMessengerStore.getState();
      const cleanup = selectCallContaminationCleanup(
        {conversations: st.conversations, groups: st.groups},
        ownAddress.userId,
      );
      for (const cid of cleanup.conversationIdsToRemove) {
        st.removeConversation(cid);
        if (sqlMessages) {
          sqlMessages.deleteByConversation(cid).catch(e =>
            console.warn('[messenger.cleanup] ghost message purge failed:', asErrorMessage(e)));
        }
        sqlOutbox.deleteByConversation(cid).catch(e =>
          console.warn('[messenger.cleanup] ghost outbox purge failed:', asErrorMessage(e)));
      }
      for (const gid of cleanup.groupAliasIdsToPurge) {
        st.removeGroupState(gid);
      }
      if (cleanup.conversationIdsToRemove.length > 0 || cleanup.groupAliasIdsToPurge.length > 0) {
        console.warn(
          `[messenger.cleanup] B-124 contamination purged conv=${cleanup.conversationIdsToRemove.length} aliases=${cleanup.groupAliasIdsToPurge.length}`,
        );
      }
    } catch (e) {
      console.warn('[messenger.cleanup] B-124 sweep failed:', asErrorMessage(e));
    }
    // B-703 MR-12 — the startup outbox drain USED TO KICK HERE, before the
    // hydrate below. It is fire-and-forget, so it raced hydration: the drain
    // writes its acceptance artifacts store-first (`updateMessageStatus('sent')`
    // and `updateMessageEnvelopeId`), and before hydration `s.messages` is
    // EMPTY, so both silently missed — while `markDelivered` durably deleted
    // the outbox row. The MSG-07 sweep then saw a hydrated 'sending' row with
    // no outbox row and no artifacts, and reded a message the relay had
    // accepted. It now kicks AFTER the hydrate + sweep (see below), which costs
    // one `loadRecent` of latency and removes the whole race.
    // F4 outbox-retry-reconnect-only — a periodic retry so a row whose
    // relay.send failed transiently (500/timeout) on a STABLE long-lived
    // socket isn't stuck for hours until the next reconnect. drainOutbox is
    // self-coalescing (drainOutboxPump) and dueRows() only returns rows past
    // next_retry_at, so an idle tick is a cheap no-op; isOurEpoch() bails after
    // a runtime rebuild. Parked on liveDisposers so the next disposeLiveRuntime
    // clears it (no leaked interval across logout→login). Capture the non-null
    // handle so the timer closure (which loses the control-flow narrowing)
    // still sees SqlOutboxStore.
    const outboxLive = sqlOutbox;
    const outboxRetryTimer = setInterval(() => {
      void drainOutboxWhenReady(outboxLive, relay, isOurEpoch, resealOutboxRow)
        .catch(e => console.warn('[messenger.outbox] drain failed:', asErrorMessage(e)));
      // OM-03 — same cadence as the drain: rows the drain just shipped over
      // HTTP get their receipt polled on the next tick. Self-coalescing
      // (inflight latch) + capped at 100 probes inside.
      void reconcileHttpReceipts({
        fetchReceipts: items => relay.receipts(items),
        isOurEpoch,
        onUndeliverable: resendUndeliverable,
      });
    }, 60_000);
    liveDisposers.push(() => { try { clearInterval(outboxRetryTimer); } catch { /* ignore */ } });
    // F-5 (B-693) — opening a conversation polls the receipt slots, so a
    // group ✓✓ settles when the user actually looks at the thread instead of
    // up to 60s later (DL-6: the poll's only sites were WS-connected + the
    // timer — never chat-open). Change-edge only (a re-render with the same
    // id is free), null (leaving) is skipped, and a 5s throttle keeps rapid
    // chat-hopping from stacking network calls; the reconcile is additionally
    // single-flight + 100-probe-capped inside. Reads ONE scalar off the state
    // — this is not a whole-map subscription (M1/M8 census).
    let receiptPollPrevConvId = useMessengerStore.getState().activeConversationId;
    let receiptPollLastAt = 0;
    const unsubReceiptPollOnOpen = useMessengerStore.subscribe(state => {
      const cur = state.activeConversationId;
      if (cur === receiptPollPrevConvId) {return;}
      receiptPollPrevConvId = cur;
      if (!cur || !isOurEpoch()) {return;}
      const now = Date.now();
      if (now - receiptPollLastAt < 5_000) {return;}
      receiptPollLastAt = now;
      // Critic P2-1 — this subscriber fires SYNCHRONOUSLY inside ChatScreen's
      // mount-time setActive commit, i.e. during the 220ms open slide B-691
      // just cleaned (reconcile's sync prefix scans every own-sent message).
      // A ✓✓ refresh is a post-open detail by definition: defer past the
      // slide + its 400ms fallback, and re-check the epoch at fire time.
      setTimeout(() => {
        if (!isOurEpoch()) {return;}
        void reconcileHttpReceipts({
          fetchReceipts: items => relay.receipts(items),
          isOurEpoch,
          onUndeliverable: resendUndeliverable,
        });
      }, 600);
    });
    liveDisposers.push(() => { try { unsubReceiptPollOnOpen(); } catch { /* ignore */ } });
    try {
      // Audit fix #16 — load only the most recent N rows per chat at
      // boot. The chat scroll-back path pages older messages in via
      // sqlMessages.loadOlder + store.prependOlderMessages.
      const {MAX_HYDRATE_PER_CONVO} = require('../store/messengerStore') as
        typeof import('../store/messengerStore');
      const persisted = await sqlMessages.loadRecent(MAX_HYDRATE_PER_CONVO);
      useMessengerStore.getState().hydrateMessages(persisted);
      // B-703 MR-12 — the map now holds this owner rows: release the drain gate.
      markMessagesHydrated();
      // Audit MSG-07 (2026-07-02): boot sweep — a hydrated bubble still in
      // 'sending' whose message has NO outbox row is unrecoverable (the
      // previous session died between append and enqueue, or the crypto
      // pipeline threw pre-enqueue on an older build). Flip it to 'failed' so
      // the user gets a retry chip instead of a forever-spinning tick. Rows
      // WITH an outbox entry are left alone — the startup drain re-ships them.
      // XO-5 — only PENDING rows count as "still in flight". A terminal
      // ('failed') row is never returned by dueRows, so a bubble whose only
      // rows are terminal must get the retry chip, not a clock that never
      // resolves.
      try {
        const outboxIds = await sqlOutbox.pendingMessageIds();
        const st = useMessengerStore.getState();
        for (const [cid, list] of Object.entries(st.messages)) {
          for (const m of list) {
            if (m.status === 'sending' && !outboxIds.has(m.id)) {
              // B-683/F4 — acceptance artifacts prove the relay took the
              // send (every lane writes the retract token BEFORE the
              // envelope id, so token-only is the reachable kill-window
              // residue). Those rows flip to 'sent' — receipts and
              // undeliverable verdicts then converge them honestly. Only a
              // row with no evidence of an accept gets the retry chip.
              // B-703 MR-4 moved this test into `sendAcceptance` so the send
              // path's identical question cannot drift from this one.
              st.updateMessageStatus(cid, m.id, hasAcceptanceArtifact(m) ? 'sent' : 'failed');
            }
          }
        }
      } catch (e) {
        console.warn('[messenger] MSG-07 sending-sweep failed:', asErrorMessage(e));
      }
    } catch (e) {
      // Hydration failure is non-fatal — UI still functions, the user
      // just doesn't see history. Surface so we can debug if it bites.
      console.warn('[messenger] SQL hydrate failed', e);
    }
    // B-703 MR-12 — idempotent second mark, covering the throw path above. A
    // failed hydrate must open the gate immediately: the store will not be
    // populated at all, so making every drain wait out the full bound buys
    // nothing and delays sending.
    markMessagesHydrated();
    // B-703 MR-12 — the startup outbox drain, moved down from above the
    // hydrate. If the previous session crashed between transport.send and
    // envelope.accepted, rows still live in the DB: replay them so the user
    // doesn't see a stuck single tick after a crash. Best-effort — if the
    // socket isn't connected yet the rows stay pending and the next
    // `socket.on('connected')` retries.
    //
    // OUTSIDE the try above on purpose: a hydration failure must not also
    // cancel the outbound catch-up. Still fire-and-forget, but now the store
    // holds the rows whose status and envelope id it is about to write, so its
    // acceptance artifacts land instead of silently missing.
    void drainOutboxWhenReady(sqlOutbox, relay, isOurEpoch, resealOutboxRow)
      .catch(e => console.warn('[messenger.outbox] drain failed:', asErrorMessage(e)));
    // Audit P0-S3 / P0-S5 — wire the GroupMasterKeyStore. Group master
    // keys no longer ride in plaintext AsyncStorage: they live in the
    // SQLCipher `group_master_keys` table, AES-GCM-wrapped under a
    // second keychain entry (`getOrCreateGroupWrapKey`). Warm the
    // in-memory `s.groups[*].masterKeyB64` slots from disk before the
    // first ChatScreen render so inbound group envelopes find the key
    // they need without the rehydration path falling into the no_key
    // stash branch (which is correct behaviour but adds round-trip
    // latency every cold boot).
    try {
      const {getOrCreateGroupWrapKey} = require('./keychain') as
        typeof import('./keychain');
      const {GroupMasterKeyStore} = require('../store/groupMasterKeyStore') as
        typeof import('../store/groupMasterKeyStore');
      const {registerGroupMasterKeySink} = require('../store/messengerStore') as
        typeof import('../store/messengerStore');
      const wrapOwnerKey = config.ownerKey ?? config.ownUserId;
      const wrapKeyB64 = await getOrCreateGroupWrapKey(wrapOwnerKey);
      const groupKeyStore = new GroupMasterKeyStore(ownStore.getDb(), wrapKeyB64);
      registerGroupMasterKeySink(groupKeyStore);
      // Warm the live store with every wrapped key already on disk so
      // group decrypt doesn't have to wait for a re-broadcast of an
      // admin envelope. Then opportunistically wrap any keys that are
      // currently in memory but missing from disk — handles upgrade
      // from a pre-P0-S3 install where the AsyncStorage vault still
      // carries plaintext masterKeyB64 values for already-joined groups.
      const wrapped = await groupKeyStore.loadAll();
      const live = useMessengerStore.getState().groups;
      const merged: Record<string, import('@bravo/messenger-core').GroupState> = {};
      const migratedToDisk: Array<{gid: string; mk: string}> = [];
      for (const [gid, gs] of Object.entries(live)) {
        const fromDisk = wrapped[gid];
        const hasInMem = !!gs.masterKeyB64;
        if (fromDisk) {
          merged[gid] = {...gs, masterKeyB64: fromDisk};
        } else if (hasInMem) {
          // Legacy in-memory key (from a pre-P0-S3 AsyncStorage row
          // that hadn't been stripped yet). Keep it live AND migrate
          // it to disk so the next cold boot doesn't need AsyncStorage
          // to hold it any more.
          merged[gid] = gs;
          migratedToDisk.push({gid, mk: gs.masterKeyB64});
        } else {
          merged[gid] = gs;
        }
      }
      useMessengerStore.setState({groups: merged});
      for (const {gid, mk} of migratedToDisk) {
        void groupKeyStore.setKey(gid, mk).catch(() => { /* best-effort */ });
      }
      // B-31 — drain group envelopes stashed (no_key/tamper) in a PRIOR
      // session for a group whose master key we just restored from disk. The
      // live drain only fires from an admin create/rekey post-txn request;
      // once that admin envelope is ACKed off the relay it is never
      // redelivered, so a stash row left undrained across a restart has nothing
      // to re-trigger it. Re-run the EXISTING per-row drain now that `merged`
      // carries the keys in memory (replayGroupSealedDecode reads the in-memory
      // masterKeyB64). NOT a key-distribution change: selectGroupIdsToDrain
      // only picks groups whose key is already on this device; a group with no
      // key stays fail-closed (Scenario B — owner-side resync is
      // architecture-gated, see sqa.md B-26(a)/B-13).
      const txnDbForDrain =
        ownStore instanceof SqlCipherProtocolStore ? ownStore.getDb() : null;
      // B-155 F3 — hand the stash replay to the first idle frame. Replaying a
      // stashed envelope runs the whole group crypto path, and this is pure
      // catch-up: it restores what is ALREADY on disk, so nothing is lost by
      // letting the first paint and the relay drain go first. It was already
      // fire-and-forget; deferring only changes when it competes for the JS
      // thread, not whether it runs.
      //
      // Deliberately NOT deferred (they stay inline, above): the B-124/B-125
      // contamination sweep — it deletes rows the user could otherwise tap
      // before it lands — and the seen-envelope / pending-stash prunes, which
      // are already fire-and-forget SQL DELETEs costing native time, not JS.
      deferToIdle(() => {
      // A deferred callback can fire after a logout or runtime rebuild, when
      // txnDb is closed and the store belongs to the next user.
      if (!isOurEpoch()) {return;}
      if (pendingGroupEnvelopes && txnDbForDrain && sqlMessages) {
        for (const gid of selectGroupIdsToDrain(merged)) {
          // GF-3 — the boot drain installs nothing new (it restores what was
          // already on disk), so it must never burn stash attempts: three
          // launches used to delete a diverged row — the only copy on Earth.
          // W25 — `.catch` FIRST, then `.then`. A failed drain observed nothing,
          // so it yields `false` and the divergence resync below is skipped —
          // same outcome as the previous then-catch order, but the rejection is
          // handled adjacent to the call rather than behind the `.then`.
          void drainPendingGroup(
            gid, config, txnDbForDrain, sqlMessages, seenEnvelopes,
            pendingGroupEnvelopes, pendingAdminActions,
            false,
          ).catch(err => {
            console.warn('[messenger] boot group-stash drain failed',
              gid.slice(0, 8), asErrorMessage(err));
            return false;
          }).then(stillKeyBlocked => {
            // GF-3 — we hold a key but the stash still won't open under it:
            // that is divergence. Ask once per boot (20s cooldown inside).
            if (stillKeyBlocked) {
              void requestGroupKeyResyncImpl(gid, undefined, {divergence: true})
                .catch(() => { /* best-effort */ });
            }
          });
        }
      }
      });
    } catch (e) {
      // Non-fatal — the runtime still works, group decrypt for newly
      // joined groups falls through to the existing pending-stash path.
      console.warn('[messenger] groupMasterKey store wire-up failed', e);
    }
    // Flip the gate: SQLCipher-backed deps are now wired. Live frames
    // from this point on go straight to dispatchFrame; any frame that
    // landed in the buffer between transport.connect() and here is
    // drained in FIFO order.
    depsReady = true;
    drainPendingFrames();
    // Phase-2 ratchet-snapshot capture — arm the scheduler now that the
    // SQLCipher store (which exposes listSessions) is open. Capture is
    // gated on the message mirror being enabled (active backup) and
    // self-debounces, so arming here is cheap. Triggered below on the
    // heartbeat timer + on every reconnect; disarmed in disposeLiveRuntime.
    try {
      const {armRatchetSnapshotScheduler} = require('../backup/ratchetSnapshotScheduler') as
        typeof import('../backup/ratchetSnapshotScheduler');
      armRatchetSnapshotScheduler(config.ownerKey ?? config.ownUserId, ownStore);
    } catch (e) {
      console.warn('[messenger] ratchet-snapshot scheduler arm failed:', asErrorMessage(e));
    }
    // Write-through mirror: every message-list change in Zustand is
    // diffed against the previous snapshot and persisted to SQLCipher.
    // This keeps the SQL store the durable source of truth without
    // touching every mutation site.
    //
    // Owner guard: this subscribe is owned by the per-user runtime
    // we're building right now. If the user switches accounts, the
    // store's _ownUserId flips before we get torn down — at which
    // point setOwner clears `s.messages` to {} for the incoming
    // user. Without the guard, the diff below sees "all conversations
    // removed" and DELETEs every row in THIS user's SQLCipher DB
    // before we close the connection. The guard scopes writes to the
    // owner that built this runtime, so a stale subscribe can't poison
    // the previous owner's DB.
    const subscribeOwner = config.ownerKey ?? config.ownUserId;
    let prev = useMessengerStore.getState().messages;
    // M-13 — captured once (not per-fire) so the hot subscriber can cheaply
    // check whether a restore is currently hydrating.
    const {isRestoreWriteThroughSuppressed} =
      require('../backup/restoreWriteThrough') as typeof import('../backup/restoreWriteThrough');
    // Fix #2: capture the unsubscribe so a runtime rebuild stops the
    // OLD subscriber before the new one starts. Without this, every
    // re-login stacks another diff loop — N subscribers all trying
    // to write each message change to N now-stale SQLCipher handles.
    const unsubscribeStore = useMessengerStore.subscribe((s) => {
      const next = s.messages;
      if (next === prev) {return;}
      // M-13 — during a restore's final hydrate, every restored row was
      // already durably written via SqlMessageStore.upsertBatch. Skip the
      // per-row write-through so we don't fire thousands of redundant
      // autocommit INSERTs (and trip the disk-pressure banner) right after
      // restore. Advance prev so post-restore mutations diff cleanly.
      if (isRestoreWriteThroughSuppressed()) {
        prev = next;
        return;
      }
      // AUDIT-2026-08-13 #13 — suppress the write-through for deltas the
      // receive txn produced ITSELF. The discriminator is a SYNC bracket
      // (`runWriteThroughSuppressed`) wrapped around the txn's row-append
      // sites — NOT a module-state check: `isInsideRatchetTxn()` is true
      // across the txn's await windows, where an interleaved USER SEND's
      // append would have been wrongly suppressed and its bubble lost on
      // restart (caught in self-review). Zustand fires this subscriber
      // synchronously on the mutator's stack, so the bracket is precise.
      // Why suppress at all: the txn persists its appended rows
      // EXPLICITLY (atomic with markSeen + the ratchet advance — the M9
      // pairing), while this subscriber's ASYNC upserts execute after
      // the txn settles — after a ROLLBACK they AUTOCOMMITTED orphan
      // rows whose ratchet and markSeen rolled back. Residue accepted:
      // in-txn PATCHES to rows that PRE-DATE this txn still ride
      // upsertCoalesced (idempotent re-application on redelivery —
      // benign). NARROWED (edge): a patch to a row appended in the SAME
      // txn can still resurrect it post-rollback via the ~50ms coalesced
      // flush (append bailed → prev holds it → the drain's reaction
      // patch diffs as an UPDATE) — registered residual, strictly better
      // than pre-fix (which orphaned the append itself, not just the
      // patch).
      // Statically imported (critic: this subscriber is B-279 hot-path —
      // no per-fire require). NOTE (critic charter 2): there are no
      // in-txn row REMOVALS today; if one ever exists, its media-blob +
      // temp-file cleanup below would be skipped by this bail — pair the
      // cleanup explicitly at that site.
      if (isWriteThroughSuppressedNow()) {
        prev = next;
        return;
      }
      // Bail if the active owner changed — this runtime is stale and
      // its sqlMessages handle is bound to the previous user's DB.
      const liveOwner = s._ownUserId;
      if (liveOwner && liveOwner !== subscribeOwner) {
        prev = next; // keep prev current so we don't double-react if we resume
        return;
      }
      const store = sqlMessages!;
      const cache = mediaCache;
      // Removed conversations — drop every persisted message AND every
      // cached attachment blob for the conversation. Without the cache
      // sweep here, "Clear chat" leaves the encrypted R2 bytes sitting
      // in SQLCipher even though the user can't see the bubbles anymore.
      for (const cid of Object.keys(prev)) {
        if (!(cid in next)) {
          for (const m of prev[cid] ?? []) {
            void store.remove(cid, m.id);
            if (cache && m.media_object_key) {
              void cache.remove(m.media_object_key).catch(() => { /* best-effort */ });
            }
            // Audit MEDIA-A2 — also delete the DECRYPTED plaintext cache file.
            if (m.media_object_key) {
              try { void (require('../media/mediaFiles') as typeof import('../media/mediaFiles')).deleteTempBytes(m.id); } catch { /* best-effort */ }
            }
          }
        }
      }
      for (const [cid, list] of Object.entries(next)) {
        const prevList = prev[cid] ?? [];
        // N-30 (M-14 residual) — skip conversations whose message list is
        // referentially unchanged. zustand+immer keep untouched lists
        // reference-stable, so appending one message to ONE conversation used
        // to still walk EVERY conversation (rebuilding a Map + Set each) on the
        // JS thread. A reconnect drain of N messages = N full-store walks; this
        // one check makes the write-through diff O(changed) instead of O(total).
        if (list === prevList) {continue;}
        const prevById = new Map(prevList.map(m => [m.id, m]));
        const nextIds = new Set<string>();
        for (const m of list) {
          nextIds.add(m.id);
          const before = prevById.get(m.id);
          if (before && before !== m) {
            // M-14 — row UPDATE (status flip, reaction, envelope-id backfill):
            // ship through the 50ms coalesced batch (one txn per burst,
            // latest-wins). Losing one on a crash only reverts a tick.
            store.upsertCoalesced(m);
            continue;
          }
          if (!before) {
            // Fix #22: top-level error boundary around the SQLCipher
            // write-through. A failed `upsert` previously rejected
            // unhandled — RN's promise-rejection handler then surfaced
            // as a yellowbox while the message stayed in memory only,
            // so on app restart the user "lost" the message. Track
            // failures in a retry queue and surface via store.error.
            store.upsert(m).catch(err => {
              // AUDIT #14 — an envelope-unique constraint failure is a
              // DUPLICATE, not a transient: that envelope's row already
              // exists. Retrying would loop forever and pin the
              // back-pressure banner. Drop with a breadcrumb instead.
              const emsg = asErrorMessage(err);
              if (/UNIQUE constraint failed/i.test(emsg) && /envelope/i.test(emsg)) {
                console.warn('[messenger] duplicate-envelope write-through dropped', cid, m.id);
                return;
              }
              upsertRetryQueue.set(`${cid}:${m.id}`, m);
              console.warn('[messenger] upsert failed; queued for retry', cid, m.id, asErrorMessage(err));
              // Audit fix #39 — escalate the message once we cross the
              // back-pressure threshold so the user can take action
              // (free disk space, force-restart, etc.) instead of
              // silently losing more writes.
              if (upsertRetryQueue.size > UPSERT_BACKPRESSURE_THRESHOLD) {
                useMessengerStore.getState().setError(
                  `Local save backlog ${upsertRetryQueue.size} — disk pressure or SQLCipher lock. Restart may help.`,
                );
              } else {
                useMessengerStore.getState().setError(
                  `Local save failed (${upsertRetryQueue.size} pending). Will retry on next change.`,
                );
              }
            });
          }
        }
        // Per-message removal — same as above, scoped to single bubbles
        // (covers retract, expiry sweeper, and "delete one message"
        // affordances). The sweeper has its own purgeBlob callback so
        // this branch fires for the non-sweep paths.
        for (const m of prevList) {
          if (!nextIds.has(m.id)) {
            void store.remove(cid, m.id);
            upsertRetryQueue.delete(`${cid}:${m.id}`);
            if (cache && m.media_object_key) {
              void cache.remove(m.media_object_key).catch(() => { /* best-effort */ });
            }
            // Audit MEDIA-A2 — delete the DECRYPTED plaintext cache file too
            // (covers retract, disappearing-expiry sweep, delete-one-message).
            if (m.media_object_key) {
              try { void (require('../media/mediaFiles') as typeof import('../media/mediaFiles')).deleteTempBytes(m.id); } catch { /* best-effort */ }
            }
          }
        }
      }
      // Drain the retry queue best-effort whenever the store changes —
      // hopefully the transient SQLCipher hiccup has passed by now.
      if (upsertRetryQueue.size > 0) {
        for (const [key, msg] of upsertRetryQueue) {
          store.upsert(msg).then(
            () => { upsertRetryQueue.delete(key); },
            () => { /* keep queued */ },
          );
        }
        if (upsertRetryQueue.size === 0) {
          // Clear the error banner once we've drained.
          const cur = useMessengerStore.getState().error;
          if (cur?.startsWith('Local save failed')) {
            useMessengerStore.getState().setError(null);
          }
        }
      }
      prev = next;
    });
    // Fix #2: register the disposer so logout / runtime-rebuild can
    // stop this subscriber before SQLCipher gets torn down.
    liveDisposers.push(unsubscribeStore);
  }

  // Idempotent safety net for the non-SqlCipher (loopback) branch and
  // any future code path that skips the SqlCipher init block: flipping
  // depsReady here guarantees buffered frames are drained even if
  // ownStore is not a SqlCipherProtocolStore. If already set above this
  // is a no-op; if not, this drains the buffer with deps still null
  // (matching legacy behaviour for loopback runs).
  if (!depsReady) {
    depsReady = true;
    drainPendingFrames();
  }

  // M7 + retract: kick off the disappearing-message sweeper. Runs
  // forever until _resetMessengerRuntime(). Sweeps once immediately
  // so any expired messages carried over from a previous session
  // are cleared. The retract callback purges sealed envelopes from
  // the relay queue when self messages expire — best-effort, the
  // server returns retracted:false without error if the recipient
  // already pulled. The purgeBlob callback drops cached attachment
  // ciphertext for messages that carried `media_object_key`, so an
  // expired voice note or photo can't outlive the chat bubble.
  const sweeper = new ExpirySweeper({
    retract:   async (token)     => { await relay.retract(token); },
    // A10 r2-media-never-purged — drop the LOCAL cache AND ask the server to
    // hard-delete the R2 object so a disappearing/retracted attachment's
    // ciphertext doesn't linger (re-downloadable with the in-band key inside
    // the 30-day grant window). The server purge is owner-checked: on the
    // SENDER's device it deletes; on a recipient's it 403s harmlessly. Both
    // legs best-effort — a failure just defers to the LRU / 30-day grant TTL.
    purgeBlob: async (objectKey) => {
      if (mediaCache) { try { await mediaCache.remove(objectKey); } catch { /* LRU catches it */ } }
      try { await mediaClient.purge(objectKey); } catch { /* non-owner 403 / offline — best-effort */ }
    },
  });
  sweeper.sweep();
  sweeper.start();
  // Fix #9: park the live sweeper instance on a module slot so the
  // next runtime build (logout / re-login / test reset) can call
  // .stop() before the new one is installed. Without this we'd run
  // two sweepers in parallel: the old one against the previous
  // user's (now-closed) DB, throwing once per second forever.
  liveSweeper = sweeper;

  useMessengerStore.getState().setReady(true);

  // ───────────────────────────────────────────────────────────────────
  // Self-heal group-key recovery engine (architecture-approved owner re-
  // share; reuses the proven `admin: create` unwrapped key carrier).
  //
  // Two halves:
  //   reshareGroupKeyState — OWNER re-DELIVERS the CURRENT key (no epoch
  //     bump) to specific members over their pairwise Signal session.
  //     Roster-gated to current members; owner-gated (only the owner can
  //     mint a verifying create signature); rate-limited per (group,peer).
  //   sendKeyRequest — a member that LOST the key asks the owner/admins to
  //     re-share it. Carries no key material; ships plaintext under the
  //     pairwise session like `create`. Rate-limited per group.
  //
  // Never logs key bytes. Never advances the epoch (a re-delivery of the
  // existing key must not disturb current holders). Never re-shares to a
  // non-member (forward-secrecy after removal is preserved).
  // ───────────────────────────────────────────────────────────────────
  const RESHARE_COOLDOWN_MS = 15 * 1000;
  const KEY_REQUEST_COOLDOWN_MS = 20 * 1000;
  const reshareAtByPeer = new Map<string, number>();
  const keyRequestSentAt = new Map<string, number>();
  // Why: these are cooldown ledgers — once an entry is older than the
  // cooldown it can never gate again, so it is pure garbage. Prune stale
  // entries when the map grows large to keep a long-lived session (many
  // groups/peers over weeks) from leaking memory. Cheap: only scans past
  // the size threshold, which a normal roster never reaches.
  const pruneCooldownMap = (m: Map<string, number>, maxAgeMs: number, now: number): void => {
    if (m.size < 512) {return;}
    for (const [k, t] of m) {
      if (now - t > maxAgeMs) {m.delete(k);}
    }
  };

  /**
   * GF-2 — durable delivery of ONE group key-material / admin envelope.
   *
   * Why: `transport.send` only throws when the socket is ALREADY closed
   * (messenger-core client.ts), so a half-dead fd buffered the frame while the
   * fan-out counted it delivered — a member silently forked off the group key
   * with nothing to replay it. Group TEXT already solved this: a per-peer
   * outbox row written before the submit, and HTTP where a 200 is a real
   * accept. Key material takes the identical path — same sealed pairwise
   * envelope, same relay endpoint, no new wire format and no server change
   * (NA-GATE-2, approved in the GF-2 shape).
   *
   * The row stores ONLY the ECIES-sealed outer envelope (never `sealedBody`),
   * so no group key is duplicated at rest beyond `group_master_keys` — which
   * is also why a stale-cert key row is DROPPED at drain rather than
   * re-minted (the GF-3 self-heal re-solicits the key instead).
   */
  const deliverGroupAdminEnvelope = async (args: {
    peer: SessionAddress;
    cert: string;
    certExpSec?: number;
    ct: Ciphertext;
    clientMsgId: string;
    groupId: string;
  }): Promise<void> => {
    const recipientIdKeyB64 = await recipientIdentityKeyB64Cached(
      ownStore, keys, args.peer, peerIdentityCache,
    );
    const outerSealed = await wrapOuter({
      recipientIdentityKeyB64: recipientIdKeyB64,
      sender:                  ownAddress,
      ciphertext:              args.ct,
      cert:                    args.cert,
    });
    if (sqlOutbox) {
      try {
        await sqlOutbox.enqueue({
          clientMsgId: args.clientMsgId,
          // Why: namespaced so "Clear chat" (deleteByConversation) can't drop
          // a pending key row, and so the drain's bubble updates never match.
          conversationId: `groupkey:${args.groupId}`,
          messageId: args.clientMsgId,
          peerUserId: args.peer.userId,
          peerDeviceId: args.peer.deviceId,
          payload: JSON.stringify({
            outerSealed,
            certExpSec: args.certExpSec,
            keyMaterial: true,
            urgent: false,
          }),
        });
      } catch (e) {
        console.warn('[group-admin.outbox] enqueue failed:', asErrorMessage(e));
      }
    }
    try {
      await relay.send({
        recipient: args.peer,
        outerSealed,
        clientMsgId: args.clientMsgId,
        urgent: false,
      });
      if (sqlOutbox) {
        sqlOutbox
          .markDelivered(args.clientMsgId, args.peer.userId, args.peer.deviceId)
          .catch(e => console.warn('[group-admin.outbox] markDelivered failed:', asErrorMessage(e)));
      }
    } catch (e) {
      if (sqlOutbox) {
        const f = classifyOutboxFailure(e);
        sqlOutbox
          .recordAttempt(args.clientMsgId, args.peer.userId, args.peer.deviceId, {
            unreachable: f.kind === 'unreachable',
            transient:   f.kind === 'server-transient',
            deferMs:     f.retryAfterMs,
            permanent:   isPermanentRelayRejection(e),
          })
          .catch(err =>
            console.warn('[group-admin.outbox] recordAttempt failed:', asErrorMessage(err)),
          );
      }
      throw e;
    }
  };

  const reshareGroupKeyState = async (
    state: GroupState,
    targetUserIds?: string[],
  ): Promise<number> => {
    // Audit G-05 (2026-07-02): the OWNER signs a fresh create; ANY other member
    // RELAYS the owner's persisted signature (state.creatorSigB64) so a keyless
    // peer can recover the key even when the owner is offline. A non-owner with
    // no persisted owner signature can't help (nothing to relay) — bail. The
    // receiver verifies the relayed signature against the owner's identity, so
    // this never lets a member forge a key.
    const isOwnerReshare = state.owner === ownAddress.userId;
    // [KEYDIAG] — every decline below was SILENT; the Kotiss group-call
    // failure (sqa.md 2026-08-01, "no group master key" after a 25 s wait
    // with zero log lines on any device) was un-attributable because this
    // whole serve lane logged nothing at warn level. Reasons only — ids are
    // sliced and key material is never logged.
    if (!isOwnerReshare && !state.creatorSigB64) {
      console.warn('[group-key-reshare:runtime] decline', state.groupId.slice(0, 12), '— non-owner with no persisted owner sig to relay');
      return 0;
    }
    // Roster-gate: never re-share to anyone who isn't a CURRENT member (and a
    // relayer must themselves be a member holding the key).
    if (!isOwnerReshare && !state.members[ownAddress.userId]) {
      console.warn('[group-key-reshare:runtime] decline', state.groupId.slice(0, 12), '— relayer not on own roster copy');
      return 0;
    }
    // Roster-gate: never re-share to anyone who isn't a CURRENT member.
    const now = Date.now();
    pruneCooldownMap(reshareAtByPeer, 10 * 60 * 1000, now);
    const targets = (targetUserIds ?? Object.keys(state.members))
      .filter(uid => uid && uid !== ownAddress.userId && !!state.members[uid])
      .filter(uid => {
        const k = `${state.groupId}:${uid}`;
        if (now - (reshareAtByPeer.get(k) ?? 0) < RESHARE_COOLDOWN_MS) {return false;}
        reshareAtByPeer.set(k, now);
        return true;
      });
    if (targets.length === 0) {
      console.warn('[group-key-reshare:runtime] decline', state.groupId.slice(0, 12), '— no eligible targets (requester off roster, or reshare cooldown)');
      return 0;
    }
    const issuedCert = await certCache.getIssued();
    const cert = issuedCert.cert;
    // G-05 — owner signs fresh; a member relays the persisted owner signature.
    let creatorSignature: string | undefined;
    if (isOwnerReshare) {
      const creatorIdentity = await ownStore.getIdentityKeyPair();
      creatorSignature = await signGroupCreate(creatorIdentity.privKey, state);
    } else {
      creatorSignature = state.creatorSigB64;
    }
    if (!creatorSignature) {
      console.warn('[group-key-reshare:runtime] decline', state.groupId.slice(0, 12), '— no creator sig on file');
      return 0;
    }
    let delivered = 0;
    try {
      await broadcastToGroup({
        group:   state,
        self:    ownAddress,
        cert,
        body:    '',
        admin:   {type: 'create', state, creatorSignature},
        session: own,
        only:    targets,
        ensureSession: async (peer) => {
          await ensureOutgoingSession(own, keys, peer, ownStore);
        },
        deliver: async (peer, ct, clientMsgId) => {
          try {
            await deliverGroupAdminEnvelope({
              peer, cert, certExpSec: issuedCert.expiresAt, ct, clientMsgId,
              groupId: state.groupId,
            });
            delivered += 1;
          } catch (e) {
            console.warn('[group-key-reshare:runtime] delivery failed', peer.userId, asErrorMessage(e));
          }
        },
      });
    } catch (e) {
      console.warn('[group-key-reshare:runtime] broadcast failed', asErrorMessage(e));
    }
    // [KEYDIAG] warn, not log — release builds strip log, and this line is the
    // ONLY serve-side evidence a key ever went out.
    console.warn('[group-key-reshare:runtime] re-shared key for', state.groupId.slice(0, 12), 'to', targets.length, 'member(s), delivered=', delivered);
    return delivered;
  };

  const sendKeyRequest = async (
    groupId: string,
    participantUserIds: string[],
    atEpochSeen?: number,
  ): Promise<number> => {
    const targets = Array.from(new Set(
      participantUserIds.filter(uid => uid && uid !== ownAddress.userId),
    ));
    if (targets.length === 0) {return 0;}
    const issuedCert = await certCache.getIssued();
    const cert = issuedCert.cert;
    // Synthetic state: a `key-request` carries NO key, so masterKeyB64 is
    // never read (skipGroupKey) and epoch=0 keeps it out of the AAD epoch
    // binding. members drive the fan-out; owner is unknown to us (that's
    // the whole point — whoever owns it will answer, others no-op).
    const synthetic: GroupState = {
      groupId,
      name:         '',
      owner:        '',
      members:      Object.fromEntries(targets.map(uid => [uid, {deviceId: 1, admin: false, joinedAt: 0}])),
      masterKeyB64: '',
      epoch:        0,
      createdAt:    0,
      updatedAt:    0,
    };
    let delivered = 0;
    try {
      await broadcastToGroup({
        group:   synthetic,
        self:    ownAddress,
        cert,
        body:    '',
        admin:   {type: 'key-request', groupId, atEpochSeen},
        session: own,
        ensureSession: async (peer) => {
          await ensureOutgoingSession(own, keys, peer, ownStore);
        },
        deliver: async (peer, ct, clientMsgId) => {
          try {
            await deliverGroupAdminEnvelope({
              peer, cert, certExpSec: issuedCert.expiresAt, ct, clientMsgId,
              groupId,
            });
            delivered += 1;
          } catch (e) {
            console.warn('[group-key-request:runtime] delivery failed', peer.userId, asErrorMessage(e));
          }
        },
      });
    } catch (e) {
      console.warn('[group-key-request:runtime] broadcast failed', asErrorMessage(e));
    }
    // [KEYDIAG] warn — the requester-side outcome line; delivered=0 with no
    // 'delivery failed' warn above means the target set itself was the problem.
    console.warn('[group-key-request:runtime] requested key for', groupId.slice(0, 12), 'from', targets.length, 'participant(s), delivered=', delivered);
    return delivered;
  };

  const requestGroupKeyResyncImpl = async (
    groupId?: string,
    fallbackPeer?: SessionAddress,
    opts?: {divergence?: boolean},
  ): Promise<void> => {
    const store = useMessengerStore.getState();
    const conversations = store.conversations;
    // Why: GF-3 — a divergence resync is raised because the key we HOLD failed
    // to decrypt (`tamper`), so the keyless-only filter used to drop exactly
    // the case that triggered it — the self-heal was dead code end-to-end.
    const candidateIds = selectKeyResyncCandidates({
      groups:     store.groups,
      conversations,
      groupId,
      divergence: opts?.divergence,
    });
    const now = Date.now();
    pruneCooldownMap(keyRequestSentAt, 10 * 60 * 1000, now);
    // [KEYDIAG] — an explicitly-requested group that produced no candidate is a
    // silent dead-end (state held but not keyless, or filtered out).
    if (groupId && candidateIds.length === 0) {
      console.warn('[group-key-request:runtime] no resync candidate for', groupId.slice(0, 12), '— state present or filtered');
    }
    for (const gid of candidateIds) {
      // Rate-limit per group so opening a chat repeatedly / reconnect
      // storms don't amplify into a request flood.
      if (now - (keyRequestSentAt.get(gid) ?? 0) < KEY_REQUEST_COOLDOWN_MS) {
        if (gid === groupId) {console.warn('[group-key-request:runtime] cooldown-suppressed for', gid.slice(0, 12));}
        continue;
      }
      const convo = conversations[gid];
      // Catch-22 fix (handoff §2.7-1) — with no conversation row (brand-new
      // member whose `create` never landed) fall back to the stashed
      // envelope's sender so the key-request can still reach a key holder.
      const participants = resolveKeyRequestTargets(
        convo?.participants,
        ownAddress.userId,
        gid === groupId ? fallbackPeer?.userId : undefined,
      );
      if (participants.length === 0) {
        if (gid === groupId) {console.warn('[group-key-request:runtime] no targets for', gid.slice(0, 12), '— no conversation row and no fallback peer');}
        continue;
      }
      keyRequestSentAt.set(gid, now);
      // B-124 root fix — an ad-hoc origin id resolves its epoch through the
      // callKeyRegistry (the state lives only under its minted id now).
      const mappedGid = resolveCallKeyGroupId(gid);
      const epochState = store.groups[gid] ?? (mappedGid ? store.groups[mappedGid] : undefined);
      try { await sendKeyRequest(gid, participants, epochState?.epoch); }
      catch (e) { console.warn('[group-key-request:runtime] resync failed for', gid.slice(0, 12), asErrorMessage(e)); }
    }
  };

  // Audit G-03 — a designated remaining admin rotates the group key AFTER a
  // peer voluntarily left, so the leaver (who keeps the old key) can't decrypt
  // post-leave messages. Mirrors removeGroupMember's rekey half, but the leaver
  // is already out of membership (the `leave` action removed them). AUDIT #1 —
  // the new key is FRESH-RANDOM (a derived key was computable by the leaver);
  // the anti-fork belt is DESIGNATION (exactly one admin fires this), and a
  // residual race is repaired by the OWNER's reshare (owner-only: a non-owner
  // reshare relays a stale creatorSig that fails verification post-rekey).
  // Broadcast under the CURRENT key that all remaining members still hold;
  // the leaver isn't in the fan-out set.
  const rekeyAfterLeaveImpl = async (groupId: string, leaverId: string): Promise<void> => {
    const store = useMessengerStore.getState();
    const cur = store.groups[groupId];
    if (!cur?.masterKeyB64) {return;}
    // Re-check admin rights on the live state (may have changed since the signal).
    if (!(cur.members[ownAddress.userId] as {admin?: boolean} | undefined)?.admin) {return;}
    if (cur.members[leaverId]) {return;} // leaver still present — the leave hasn't applied; bail
    // AUDIT #1 — fresh randomness: the departed LEAVER holds the previous
    // key, so the old deterministic derivation was computable by them
    // (see planRemoveAndRekey in messenger-core for the full block).
    // Designation (this branch fires for ONE designated admin only) is
    // the anti-fork belt here.
    const {genFreshGroupMasterKey} = require('@bravo/messenger-core') as typeof import('@bravo/messenger-core');
    const newMasterKeyB64 = genFreshGroupMasterKey();
    const rekeyAction = {type: 'rekey' as const, newMasterKeyB64, atEpoch: cur.epoch};
    const issuedCert = await certCache.getIssued();
    const cert = issuedCert.cert;
    const ensureSessionFn = async (peer: SessionAddress): Promise<void> => {
      await ensureOutgoingSession(own, keys, peer, ownStore);
    };
    const deliverFn = async (peer: SessionAddress, ct: Ciphertext, clientMsgId: string): Promise<void> => {
      await deliverGroupAdminEnvelope({
        peer, cert, certExpSec: issuedCert.expiresAt, ct, clientMsgId,
        groupId: cur.groupId,
      });
    };
    try {
      await broadcastToGroup({
        group: cur, self: ownAddress, cert, body: '', admin: rekeyAction,
        session: own, ensureSession: ensureSessionFn, deliver: deliverFn,
      });
    } catch (e) {
      console.warn('[group-leave-rekey:runtime] rekey broadcast failed:', asErrorMessage(e));
    }
    // Rotate locally regardless (fail-closed): our own future sends use the new
    // key; a member who missed the broadcast self-heals via key-request.
    const after = applyAdminAction(cur, rekeyAction, ownAddress.userId);
    if (after !== cur) {
      store.setGroupState(after);
      if (cur.masterKeyB64 !== after.masterKeyB64) {disposeGroupKey(cur.masterKeyB64);}
      console.log('[group-leave-rekey:runtime] rotated key after leave of', leaverId.slice(0, 8), 'group', groupId.slice(0, 12));
    }
  };

  // Register the receive-path signal handler (one runtime per process).
  // B-207 (M2) — debounce the key-request → intent re-drain bridge below so a
  // burst of non-member key-requests can't storm the drain (the drain also
  // coalesces internally; this bounds the sequential rate).
  let lastM2DrainAt = 0;
  setGroupKeySignalHandler((sig) => {
    if (sig.kind === 'reshare') {
      const state = useMessengerStore.getState().groups[sig.groupId];
      // Audit G-05 — the owner reshares (signs fresh); OR any member who holds
      // the key AND a persisted owner signature relays it (owner-offline
      // recovery). reshareGroupKeyState enforces both gates + the receiver
      // verifies against the owner's identity, so this can't forge a key.
      const canReshare = !!state?.masterKeyB64 &&
        (state.owner === ownAddress.userId ||
          (!!state.creatorSigB64 && !!state.members[ownAddress.userId]));
      if (state && canReshare) {
        // B-207 (M2) — if the requester is NOT yet in our crypto roster,
        // reshareGroupKeyState silently drops them (its roster gate, kept exactly
        // as-is). For a mission Ops Room that is a manager/CPO whose server
        // add-intent never drained — blocked forever with no error. Re-drain the
        // server-authorized intent queue so the pending add lands through the
        // already-trusted addGroupMember path (which delivers the key). This adds
        // NO new key-flow authority: the server intent queue stays the sole
        // authorization and the roster gate is untouched. B-416: the drain now
        // admits owner AND delegated-manager devices — the fork barrier is no
        // longer an identity self-gate but the drain's SERVER-SIDE ATOMIC
        // per-room claim (first admin wins, everyone else stands down on that
        // room), so firing it from this per-device handler still cannot mint a
        // fork anywhere.
        if (!state.members[sig.toUserId]) {
          const now = Date.now();
          if (now - lastM2DrainAt > 15_000) {
            lastM2DrainAt = now;
            const {drainDispatchRoomIntents} =
              require('../orgWorkspace/dispatchRoomIntents') as
                typeof import('../orgWorkspace/dispatchRoomIntents');
            void drainDispatchRoomIntents().catch(() => { /* best-effort retry trigger */ });
          }
        }
        void reshareGroupKeyState(state, [sig.toUserId]);
      }
    } else if (sig.kind === 'request') {
      void requestGroupKeyResyncImpl(sig.groupId, sig.fromPeer, {divergence: sig.divergence === true});
    } else if (sig.kind === 'leave-rekey') {
      void rekeyAfterLeaveImpl(sig.groupId, sig.leaverId);
    } else if (sig.kind === 'purge-self-removed') {
      // B-337 — an admin removed US from this group. Drop every local trace so
      // the group leaves the chat list AND a later re-add starts clean.
      //
      // Order matters: the store row first (that is what the chat list renders,
      // so the group disappears immediately), then the crypto state, then the
      // durable rows. Each step is independently guarded — a failure in one must
      // not leave the others undone, because a half-purge is what would show a
      // group with no key or a key with no group.
      const gid = sig.groupId;
      // B-339 — eject from a LIVE call for this group BEFORE pulling the rug.
      // The purge below evicts the group's master key (removeGroupState clears
      // the in-process keyCache, Audit P1-G5) and deletes the conversation row
      // GroupCallScreen renders from. If a removal lands mid-call, the member's
      // FrameCryptor loses its key and the screen loses its row — media dies
      // while the call surface stays up, i.e. STUCK in the call. Ending first
      // tears the SFU objects down and clears the registry, so they land back
      // on the chat list instead. Scoped to THIS group: ending an unrelated
      // call would be a worse bug than the one being fixed.
      try {
        const reg = require('./groupCallRegistry') as typeof import('./groupCallRegistry');
        const live = reg.getActiveGroupCall();
        if (live && live.conversationId === gid) {
          console.warn(`[CALLDIAG] [group-admin] removed mid-call — ending group call first (B-339) group=${gid.slice(0, 8)}`);
          void reg.endActiveGroupCall(live.roomId).catch(e =>
            console.warn('[group-admin] self-removed call eject failed:', asErrorMessage(e)));
        } else if (live) {
          // B-343 — the missing datum from the 2026-07-30 19:33 incident: the
          // eject silently skipped and we could not tell whether the registry
          // was empty or held a mismatched conversation. Name it.
          console.warn(`[CALLDIAG] [group-admin] B-339 eject skipped — live call convo=${live.conversationId.slice(0, 8)} ≠ purged group=${gid.slice(0, 8)}`);
        } else {
          console.warn(`[CALLDIAG] [group-admin] B-339 eject skipped — no live call at purge of group=${gid.slice(0, 8)}`);
        }
      } catch (e) {
        console.warn('[group-admin] self-removed call-eject probe failed:', asErrorMessage(e));
      }
      try {
        const st = useMessengerStore.getState();
        st.removeConversation(gid);
        // Not merely tidiness: leaving the master key behind lets any surviving
        // local ciphertext keep decrypting (the missionOpsRoomStaticScan M3
        // lesson). removeGroupState also evicts the key from the in-process cache.
        st.removeGroupState(gid);
      } catch (e) {
        console.warn('[group-admin] self-removed store purge failed:', asErrorMessage(e));
      }
      if (sqlMessages) {
        sqlMessages.deleteByConversation(gid).catch(e =>
          console.warn('[group-admin] self-removed message purge failed:', asErrorMessage(e)));
      }
      if (sqlOutbox) {
        // Our queued sends to a group we are no longer in can never be
        // delivered (members drop a non-member's envelope via P1-N4); leaving
        // them behind is pure retry noise against a group we cannot rejoin.
        sqlOutbox.deleteByConversation(gid).catch(e =>
          console.warn('[group-admin] self-removed outbox purge failed:', asErrorMessage(e)));
      }
      console.warn(`[CALLDIAG] [group-admin] purged self-removed group=${gid.slice(0, 8)} (B-337)`);
    }
  });

  // Signal resend protocol (flag-gated) — re-transmit recent still-undelivered
  // 1:1 TEXT messages to a peer who just told us (via rehandshake) they rebuilt
  // their session. Re-uses the SAME clientMsgId so the receiver dedups; bounded
  // window (10 min) + cap (10) + per-peer cooldown (60s) so it can't storm.
  const RESEND_COOLDOWN_MS = 60_000;
  const resendAtByPeer = new Map<string, number>();
  setResendSignalHandler((peer) => {
    void (async () => {
      try {
        if (!sqlMessages || !peer.userId) {return;}
        const now = Date.now();
        pruneCooldownMap(resendAtByPeer, 10 * 60 * 1000, now);
        if (now - (resendAtByPeer.get(peer.userId) ?? 0) < RESEND_COOLDOWN_MS) {return;}
        resendAtByPeer.set(peer.userId, now);

        const {resolveDirectConversationIdFromState} =
          require('../store/messengerStore') as typeof import('../store/messengerStore');
        const convoId = resolveDirectConversationIdFromState(useMessengerStore.getState(), peer.userId);
        const sinceIso = new Date(now - 10 * 60_000).toISOString();
        const rows = await sqlMessages.recentUndeliveredSelfText(convoId, sinceIso, 10);
        if (rows.length === 0) {return;}

        const cert = await certCache.get();
        await ensureOutgoingSession(own, keys, peer, ownStore);
        let resent = 0;
        for (const m of rows) {
          try {
            const sealed = sealPayload(cert, m.content, {
              clientMsgId:  m.id,
              expiresAtSec: m.expires_at ? Math.floor(m.expires_at / 1000) : undefined,
              replyTo:      m.reply_to_msg_id
                ? {msgId: m.reply_to_msg_id, preview: m.reply_to_preview ?? ''}
                : undefined,
              aad: {
                to:             peer,
                // OM-05 — replayed rows keep their compose time (clamped).
                ts:             resolveResealAadTs(Date.parse(m.created_at)),
                sender:         ownAddress,
                conversationId: directConvoAadId(ownAddress.userId, peer.userId),
              },
            });
            const ct = await own.encrypt(peer, sealed);
            const recipientIdKeyB64 = await recipientIdentityKeyB64Cached(
              ownStore, keys, peer, peerIdentityCache,
            );
            const outerSealed = await wrapOuter({
              recipientIdentityKeyB64: recipientIdKeyB64,
              sender:                  ownAddress,
              ciphertext:              ct,
              cert,
            });
            // Same clientMsgId → the receiver's store dedups (no duplicate
            // bubble); the relay dedups a genuine re-send under it too.
            try { transport.send({event: 'envelope.send', data: {to: peer, outerSealed, clientMsgId: m.id, urgent: false}}); }
            catch { await relay.send({recipient: peer, outerSealed, clientMsgId: m.id, urgent: false}); }
            resent += 1;
          } catch (e) {
            console.warn('[resend] retransmit failed id=' + m.id.slice(0, 8), asErrorMessage(e));
          }
        }
        console.log('[resend] re-transmitted ' + resent + '/' + rows.length + ' to ' + peer.userId.slice(0, 8));
      } catch (e) {
        console.warn('[resend] handler failed', asErrorMessage(e));
      }
    })();
  });

  // ONE fan-out for both edit and delete-for-everyone. They are structurally
  // identical — an empty-body control envelope carrying a directive plus the
  // group routing stamp — and the whole reason `applyReactionLane` exists is
  // that two hand-copied implementations of one job drift until the unwatched
  // one is missing a gate (B-128). Do not split this back into two.
  //
  // Deliberately verbatim from sendReaction: the same bare {to, ts} AAD
  // (widening it is a CLAUDE.md stop-condition), the same durable outbox row
  // (MSG-08 — a directive sent over a half-dead socket must survive to the
  // reconnect drain), the same urgent:false (P2-11 — these render no banner, so
  // a killed device must not be woken for them), the same best-effort
  // allSettled fan-out.
  const sendMutationDirective = async (args: {
    peer:           SessionAddress;
    conversationId: string;
    directive:      MutationDirective;
    tag:            'edit' | 'deleteAll';
  }): Promise<void> => {
    const {peer, conversationId, directive, tag} = args;
    if (!peer.userId) {return;}
    const issuedCert = await certCache.getIssued();
    const cert = issuedCert.cert;

    const mutState   = useMessengerStore.getState();
    const recipients = reactionRecipients(mutState, conversationId, ownAddress.userId, peer);
    const isGroup    = isGroupConversation(mutState, conversationId);

    const sendOne = async (to: SessionAddress): Promise<void> => {
      if (!to.userId) {return;}
      await ensureOutgoingSession(own, keys, to, ownStore);
      const clientMsgId = makeId();
      const groupStamp = isGroup
        ? {groupId: conversationId, kind: 'text' as const, clientMsgId}
        : undefined;
      // WIRE-COMPAT: in a GROUP the directive rides inside the `group` stamp,
      // which an older peer ignores instead of destroying the envelope. In a
      // 1:1 there is no `group` object and therefore no carrier, so it stays
      // top-level and an older peer WILL refuse it — bounded, because a
      // directive renders no bubble, so a refusal loses the edit/delete rather
      // than a user's message. See SealedGroup's header.
      const sealed = sealPayload(cert, '', groupStamp
        ? {
            group: {
              ...groupStamp,
              ...(directive.edit      ? {edit:      directive.edit}      : {}),
              ...(directive.deleteFor ? {deleteFor: directive.deleteFor} : {}),
            },
            aad: {to, ts: Date.now()},
          }
        : {
            ...(directive.edit      ? {edit:      directive.edit}      : {}),
            ...(directive.deleteFor ? {deleteFor: directive.deleteFor} : {}),
            aad: {to, ts: Date.now()},
          });
      const ct = await own.encrypt(to, sealed);
      const recipientIdKeyB64 = await recipientIdentityKeyB64Cached(
        ownStore, keys, to, peerIdentityCache,
      );
      const outerSealed = await wrapOuter({
        recipientIdentityKeyB64: recipientIdKeyB64,
        sender:                  ownAddress,
        ciphertext:              ct,
        cert,
      });
      if (sqlOutbox) {
        try {
          await sqlOutbox.enqueue({
            clientMsgId,
            conversationId,
            messageId:    clientMsgId,
            peerUserId:   to.userId,
            peerDeviceId: to.deviceId,
            payload:      JSON.stringify(buildMutationSealedOutboxPayload({
              outerSealed,
              certExpSec: issuedCert.expiresAt,
              mutation:   directive,
              group:      groupStamp,
              clientMsgId,
            })),
          });
        } catch { /* enqueue best-effort */ }
      }
      let httpDelivered = false;
      try {
        transport.send({
          event: 'envelope.send',
          data:  {to, outerSealed, clientMsgId, urgent: false},
        });
        // P2-11 parity — do NOT markDelivered on the fire-and-forget WS send.
        // That would drop the durable row before ANY ack, so a half-dead socket
        // (frame buffered, never shipped) silently loses the directive.
        trackPending(clientMsgId, {conversationId, messageId: clientMsgId, peer: to});
      } catch {
        try {
          await relay.send({recipient: to, outerSealed, clientMsgId, urgent: false});
          httpDelivered = true;
        } catch { /* socket down + HTTP failed — leave the row for drainOutbox */ }
      }
      if (httpDelivered && sqlOutbox) {
        sqlOutbox.markDelivered(clientMsgId, to.userId, to.deviceId)
          .catch(() => { /* best-effort */ });
      }
    };

    // Best-effort — one bad recipient (no session, OPK exhausted) must not stop
    // the directive reaching everyone else.
    await Promise.allSettled(recipients.map(sendOne));
    console.log(`[send.${tag}] fanned out to ${recipients.length} recipient(s)`);
  };

  // Named so media helpers (sendMedia) can call back into sendText
  // without re-implementing the send/fan-out/grant pipeline.
  const runtimeApi: MessengerRuntime = {
    mode: 'production',
    own,
    // Self-heal — let screens (group ChatScreen / DepartmentChatScreen) and
    // the WS reconnect path proactively ask the owner to re-share the key
    // for any group we belong to but have no master key for.
    requestGroupKeyResync: requestGroupKeyResyncImpl,
    sendText: async (conversationId, text, peerOrOpts) => {
      const opts: SendTextOptions = peerOrOpts && 'userId' in peerOrOpts
        ? {peer: peerOrOpts}
        : peerOrOpts ?? {};
      // Why: ChatScreen may pass either the synthetic `direct:<peer>`
      // (NewChat / push tap / incoming call entry points) OR the
      // server-UUID (Home list tap / /conversations/mine sync). The
      // inbound path canonicalises to server-UUID-when-available; do
      // the same here so outgoing bubbles land in the same slot the
      // ChatScreen subscribes to (when both rows exist). Skip groups
      // — those always carry a server-UUID conversationId already.
      if (isDirectPrefixed(conversationId)) {
        const {resolveDirectConversationIdFromState: resolve} =
          require('../store/messengerStore') as typeof import('../store/messengerStore');
        const peerUid = peerFromDirectSlot(conversationId);
        const canonical = resolve(useMessengerStore.getState(), peerUid);
        if (canonical !== conversationId) {
          console.log('[send.text.routing] canonicalised ' + conversationId.slice(0, 16) + ' -> ' + canonical.slice(0, 16));
          conversationId = canonical;
        }
      }
      const expiresAtSec = opts.ttlSeconds
        ? Math.floor(Date.now() / 1000) + opts.ttlSeconds
        : undefined;
      // Audit P1-1 — the sender-cert fetch (incl. its 30s negative cache on
      // reject) is deliberately NOT hoisted here. It used to run BEFORE both
      // optimistic appends, so an offline cert-fetch reject destroyed the
      // typed text before any bubble/outbox row existed. Each path below now
      // appends its bubble FIRST, then fetches the cert inside a guard that
      // flips the bubble to `failed` on reject (retry chip re-runs the send).
      const replyMeta = opts.replyTo
        // Why: a reply to an empty / media-only / disappeared message can land
        // here with `preview` undefined. Previously `.slice()` on undefined
        // crashed the send + surfaced the "Cannot read property 'slice' of
        // undefined" red banner on the chat surface. Coerce to '' so the
        // worst case is an empty preview, not a thrown frame.
        ? {msgId: opts.replyTo.messageId, preview: (opts.replyTo.preview ?? '').slice(0, REPLY_PREVIEW_MAX_CHARS)}
        : undefined;
      // MM-09 — normalised once, shipped on EVERY send site beside replyMeta
      // (the B-144 rule: a field missing from an outbox row is gone for good).
      const fwdFlag = opts.isForwarded === true ? true : undefined;
      // @-mentions travel with the body on EVERY send site, for the same reason
      // B-144 made replyTo do so: a group message queued offline is re-sealed
      // from its outbox row, and a field missing from that row is gone for good
      // — the recipient loses the highlight AND the "you were mentioned" push,
      // on exactly the sends most likely to be retried.
      //
      // Reconciled against the final body here rather than trusted from the
      // caller: mentioning someone and then deleting their name by hand must
      // not still ship them a mention.
      const mentionsMeta = opts.mentions?.length
        ? (() => {
            const clean = reconcileMentions(text, opts.mentions ?? []);
            // B-271 — expand `@all` HERE, after the last reconcile and before
            // anything reads the list. Order is load-bearing:
            // `reconcileMentions` keeps only mentions whose LABEL still appears
            // in the body, and after expansion the per-member labels do NOT
            // appear (the body says "@all"), so expanding any earlier would
            // have this very call strip every one of them back out. The
            // sentinel's own label IS "all", so it survives reconcile intact.
            //
            // Downstream never sees the sentinel: it gets the same per-member
            // list a manual selection would have produced, so the notification
            // fan-out, the mention highlight and edit-reconcile all work with
            // no @all awareness at all.
            const st = useMessengerStore.getState();
            const others = (st.conversations[conversationId]?.participants ?? [])
              .filter(u => u && u !== ownAddress.userId);
            const expanded = expandAllMentions(clean, others, uid =>
              st.groupMemberNames[conversationId]?.[uid] ??
              st.directoryNames[uid] ??
              uid.slice(0, 8),
            );
            return expanded.length ? expanded : undefined;
          })()
        : undefined;

      // Group fan-out: if the conversation is a multi-party group/ops
      // channel, encrypt + ship one envelope per other-member instead
      // of sending to a single peer. Stamping `sealed.group` makes the
      // receiver route the message into the mission group thread; without
      // it the recipient's runtime falls back to a 1:1 conversation
      // keyed on the sender, which is invisible to the mission dock.
      //
      // Detection sources (in order): explicit conversation type from
      // the dispatched mission record, presence of a local GroupState
      // (we received an admin-create at some point), or the legacy
      // `participants` list with > 1 member.
      const convo = useMessengerStore.getState().conversations[conversationId];
      // A direct conversation now stores both participants ([self, peer]),
      // so the legacy `participants.length > 1` fallback would mis-route
      // every 1:1 send into the group fan-out. Trust the explicit `type`
      // when set; the length-based fallback is only for legacy untyped rows.
      //
      // B-124/B-125 — key-material presence is a CRYPTO fact, not a
      // conversation-type fact, and must never overrule an explicit
      // `type: 'direct'` row: 1:1→group call escalation aliases a throwaway
      // 'Call' group key under the real 1:1 conversation id
      // (ensureCallGroupKey), which routed every later 1:1 send through the
      // group fan-out — group-stamping a device-local id on the wire
      // (duplicate/ghost threads on both ends, B-124) and deriving an empty
      // recipient list from the ghost row (send throw + text loss, B-125).
      // A 'Call'-named state is a transient call-key carrier, never a chat.
      // M2 — ONE topology rule. Do NOT re-inline this: the inline copy drifted
      // from messagingLogic and that drift IS B-124/B-125. isGroupConversation
      // additionally vetoes `direct:`-shaped ids, which the inline copy missed.
      const isGroup =
        opts.isGroup === true ||
        isGroupConversation(useMessengerStore.getState(), conversationId);

      // M3 — the TOFU send-gate used to sit HERE, above both branches' appends.
      // It now lives in the 1:1 branch below its append (see failDirectSend).

      // P2-12 — reuse the bubble sendMedia already appended (existingMsgId) so
      // status/outbox/reactions all key off the same id; otherwise mint a new one.
      // B-361 — stableMsgId keeps the append but pins the id, so a retried
      // notification-action reply dedupes onto its one bubble (see runtime.ts).
      const msgId = opts.existingMsgId ?? opts.stableMsgId ?? makeId();
      // BS-REACT-AUTHOR — the wire `clientMsgId` MUST equal the local bubble
      // `msgId` so reactions/replies others place (keyed by clientMsgId) land
      // on the AUTHOR's own message too. The group path previously minted a
      // separate clientMsgId, so a group author never saw reactions on their
      // own messages and reply-jump missed. The 1:1 path already does this.
      const clientMsgId = msgId;
      const sentAt = new Date().toISOString();
      // Why: B-318 — the wire ordering ts must be COMPOSE time. The 1:1 aad
      // previously stamped Date.now() inside sealPayload, AFTER cert fetch +
      // session ensure (network-blocking): under a burst, message A composed
      // first could seal with a LATER ts than B, and the receiver's
      // created_at splice rendered them inverted. The group branch already
      // stamps its sealedTs before per-peer work; this is the 1:1 mirror.
      const composedTsMs = Date.now();

      if (isGroup) {
        // SERVER IS AUTHORITATIVE for membership. We previously unioned
        // local GroupState.members with the server-fed conversation
        // participants — that let stale dev-contact entries (Alice/Bob
        // from earlier test runs) leak into the fan-out, causing every
        // mission-group send to also encrypt to a non-member. Only the
        // /conversations/mine response defines who is in the room.
        const convoMemberIds = convo?.participants ?? [];
        const participants = convoMemberIds.filter(uid => uid && uid !== ownAddress.userId);

        // P1-1/P2-12 — append the optimistic bubble BEFORE any guard or
        // network/crypto await so a failure leaves a durable `failed` bubble
        // the retry chip can act on instead of losing the text. B-125 — the
        // membership guards used to sit ABOVE this append, so their throws
        // destroyed the typed text with no bubble and no retry (ChatScreen
        // clears the composer before awaiting). `peer` points at any one
        // participant for legacy selectors; routing in the group path is by
        // clientMsgId + group id, not peer. When sendMedia hands an
        // `existingMsgId` the bubble was already appended before its upload,
        // so we skip the append here (no duplicate).
        const firstPeer: SessionAddress = {
          userId: participants[0] ?? convo?.peer?.userId ?? ownAddress.userId,
          deviceId: 1,
        };
        if (!opts.existingMsgId) {
          const msg: LocalMessage = {
            id: msgId,
            conversation_id: conversationId,
            sender_id: 'self',
            type: attachmentMessageType(opts.attachment),
            content: text,
            media_mime: opts.attachment?.mimeType,
            media_object_key: opts.attachment?.objectKey,
            // Round 8 — preserve the per-file AES key + IV on the local
            // row so backup mirroring (and on-device re-render) can
            // round-trip the attachment. Without this every attachment
            // becomes unrecoverable after a restore.
            media_key: opts.attachment?.keyB64,
            media_iv:  opts.attachment?.ivB64,
            media_meta: attachmentMediaMeta(opts.attachment),
            status: 'sending',
            is_encrypted: true,
            created_at: sentAt,
            peer: firstPeer,
            expires_at: expiresAtSec ? expiresAtSec * 1000 : undefined,
            reply_to_msg_id:  replyMeta?.msgId,
            reply_to_preview: replyMeta?.preview,
            mentions:         mentionsMeta,
            is_forwarded:     fwdFlag,
          };
          useMessengerStore.getState().appendMessage(conversationId, msg);
        }

        // B-125 — validate AFTER the bubble exists. Flip it to `failed` before
        // throwing so the text survives on screen behind a retry chip instead
        // of being destroyed (the composer is already cleared by the caller).
        // ONE named helper, not hand-copied flips: every validation exit on the
        // group path below the append must go through here, never a bare throw.
        const failGroupSend = (message: string): never => {
          useMessengerStore.getState().updateMessageStatus(conversationId, msgId, 'failed');
          throw new Error(message);
        };
        // B-125 — the old string blamed /conversations/mine, but the one known
        // way to reach this is a client-minted ghost row (call-key
        // contamination) that no sync can ever repair. Honest copy; the bubble
        // above stays as a retryable `failed`.
        if (participants.length === 0) {
          failGroupSend('This group has no other members to send to — if this is a 1:1 chat, use the contact’s main conversation.');
        }
        // Round 5 / Security S5 — cap recipient count per send. Without
        // this, a malicious admin could craft a 10k-member group and
        // any local send would fire 10k libsignal encrypt + HTTP
        // submissions in parallel, exhausting the pending LRU and
        // back-pressuring the WS / OPK pool. The cap is generous
        // (250) — well above the realistic group-size product spec
        // (Phase-1 informal cap is ~50) but low enough to keep the
        // worst-case fan-out bounded. Sends to larger groups are
        // refused outright with a clear error so the UI can show "too
        // large to send" instead of silently freezing the chat for
        // 30+ seconds.
        const MAX_GROUP_FANOUT = 250;
        if (participants.length > MAX_GROUP_FANOUT) {
          failGroupSend(`group too large to send (${participants.length} > ${MAX_GROUP_FANOUT} recipients)`);
        }
        if (text.length > MAX_MESSAGE_CHARS) {
          failGroupSend(`message too long to send (${text.length} > ${MAX_MESSAGE_CHARS} characters)`);
        }

        // B-683/F2 — B-122, group edition. The relay dedups on
        // (recipient, clientMsgId) with a memo that survives the envelope's
        // ack, so a tap-to-retry of a message the relay accepted once was a
        // silent no-op: 200, bubble back to 'sent', nothing delivered to
        // anyone. Re-send those under a FRESH wire id. Duplicate-safe
        // because the retry chip only shows for an all-legs-dead bubble
        // (recordUndeliverableLeg's total-failure predicate) — nobody holds
        // the round-1 message.
        // ACCEPTED TRADE (BS-REACT-AUTHOR): recipients key the retried
        // message by the NEW wire id while the author's bubble keeps msgId,
        // so a member's reaction/reply to the retried message misses the
        // author's own bubble — the same recorded trade as the 1:1 B-122
        // lane, bounded to the nobody-has-it population. Audit:
        // docs/audits/FEED_TICKER_FALSE_RETRY_AUDIT_2026-08-27.md §2.4 F2.
        let wireClientMsgId = clientMsgId;
        if (opts.existingMsgId) {
          const prior = useMessengerStore.getState()
            .messages[conversationId]?.find(m => m.id === msgId);
          const priorAccepted = !!(prior?.envelope_id ||
            (prior?.envelope_ids && Object.keys(prior.envelope_ids).length > 0));
          if (priorAccepted) {
            wireClientMsgId = makeId();
            // Round-1 artifacts must not survive: the retract slots are
            // FIRST-WINS, so a stale token would pair round-2 envelope ids
            // with a dead token and every receipt probe would answer
            // 'unknown' forever; the cleared scalar makes a late round-1
            // 'discarded' match nothing. The old outbox rows hold bytes the
            // relay already claimed — purge them so a drain can't re-ship a
            // guaranteed no-op under the old id next to the new fan-out.
            useMessengerStore.getState().resetWireArtifactsForResend(conversationId, msgId);
            if (sqlOutbox) {
              try { await sqlOutbox.deleteByClientMsgId(clientMsgId); }
              catch { /* best-effort */ }
            }
          }
        }

        // P2-4 — capture the master key + group-encrypt the body UNDER the
        // per-group admin lock. Without it, an old-key text racing a same-device
        // rekey encrypts under a key the rotated receivers have already dropped
        // → the message is permanently lost (`epoch_stale`/`no_key`). The lock
        // serialises this encrypt step with the two-step rekey plan so we always
        // read a CONSISTENT (masterKey) — never a torn intermediate.
        // Round 5 / Security S1 — the shared `sealedBody` (master-key-wrapped
        // inner envelope) is sealed PER-RECIPIENT inside sendOne (each peer's
        // `aad.to` binds their address); only the outer wrap repeats per peer.
        let cert: Awaited<ReturnType<typeof certCache.get>>;
        let sealedBody: string;
        let sealedTs: number;
        // SN-06 — persisted with the sealed row so the drain can tell a
        // still-valid envelope from one whose cert has aged out.
        let certExpSec: number;
        try {
          const prep = await runWithGroupAdminLock(conversationId, async () => {
            // Re-read the master key INSIDE the lock so a rekey that just
            // committed is reflected (fresh key, not the pre-lock snapshot).
            const masterKey = useMessengerStore.getState().groups[conversationId]?.masterKeyB64;
            // GF-5 — fail closed. The unwrapped fallback skipped the
            // documented group AES-GCM layer and only ever reached the single
            // placeholder participant a keyless row is seeded with; the
            // receive side already classifies that shape as a downgrade
            // (parseGroupMessage → 'malformed', Audit P0-G2). Note the
            // persisted vault writes masterKeyB64: '' — falsy check, not
            // undefined check, is load-bearing.
            if (!masterKey) {
              const pendingErr = GROUP_KEY_PENDING_SEND_ERROR;
              throw new Error(pendingErr);
            }
            const innerEnvelope = JSON.stringify({
              groupId:     conversationId,
              kind:        'text',
              clientMsgId: wireClientMsgId,
              body:        text,
            });
            const sb = JSON.stringify(await groupEncrypt(masterKey, innerEnvelope));
            return {sealedBody: sb, sealedTs: Date.now()};
          });
          sealedBody = prep.sealedBody;
          sealedTs = prep.sealedTs;
        } catch (e) {
          useMessengerStore.getState().updateMessageStatus(conversationId, msgId, 'failed');
          const isKeyPending = isGroupKeyPendingError;
          // GF-5 — fired OUTSIDE runWithGroupAdminLock (this catch is past it)
          // so the self-heal can never re-enter the lock it just released
          // (the B-75 self-deadlock shape). Rate-limited per group inside.
          if (isKeyPending(e)) {
            void requestGroupKeyResyncImpl(conversationId).catch(() => { /* best-effort */ });
          }
          throw e;
        }
        // XO-2 — the cert fetch now lives OUTSIDE the admin lock: it is pure
        // network, holds no group state, and the rekey serialisation must not
        // sit behind a slow fetch or a 30s negative-cache throw.
        try {
          const c = await certCache.getIssued();
          cert = c.cert;
          certExpSec = c.expiresAt;
        } catch (e) {
          // XO-2 — no sender cert (cold cache on an offline launch, or the 30s
          // negative window). The master-key-wrapped body already exists, so
          // persist one DEFERRED row per member — the same shape the A4
          // per-peer path writes — and leave the bubble 'sending'. The drain
          // re-mints a fresh cert + per-peer AAD and ships on reconnect.
          if (sqlOutbox) {
            const deferredPayload: DeferredGroupOutboxPayload = {
              deferred:   true,
              sealedBody,
              expiresAtSec,
              attachment: opts.attachment,
              groupId:    conversationId,
              kind:       'text',
              clientMsgId: wireClientMsgId,
              // B-144 — the drain re-seals from this row; drop it here and
              // the reply is gone no matter what resealOutboxRow does. Same
              // for mentions and the MM-09 forwarded flag.
              replyTo:    replyMeta,
              mentions:   mentionsMeta,
              isForwarded: fwdFlag,
            };
            const rowJson = JSON.stringify(deferredPayload);
            let deferredQueued = false;
            for (const userId of participants) {
              try {
                await sqlOutbox.enqueue({
                  clientMsgId:  wireClientMsgId,
                  conversationId,
                  messageId:    msgId,
                  peerUserId:   userId,
                  peerDeviceId: 1,
                  payload:      rowJson,
                });
                // Why: XO-5 — a SAME-id retry (no prior accept) collides with
                // its terminal row via INSERT OR IGNORE. Re-open it so a
                // queued deferred intent is drainable. Under a B-683 fresh
                // wire id this is a no-op (no rows carry the new id yet).
                if (opts.existingMsgId) {
                  await sqlOutbox.resetFailed(wireClientMsgId, userId, 1);
                }
                deferredQueued = true;
              } catch (enqErr) {
                console.warn('[messenger.outbox] group deferred enqueue failed:', asErrorMessage(enqErr));
              }
            }
            if (deferredQueued) {
              useMessengerStore.getState().updateMessageStatus(conversationId, msgId, 'sending');
              return;
            }
          }
          useMessengerStore.getState().updateMessageStatus(conversationId, msgId, 'failed');
          throw e;
        }

        // Fix #10: parallelise fan-out. Sequential `for…of await` made
        // a 20-member group take 20× one-RTT (≈8s on poor networks)
        // before the user saw 'sent'. allSettled lets every per-peer
        // send race in parallel; we tally fulfilled vs rejected after.
        // Each per-peer task is a self-contained promise so a single
        // peer's transient failure doesn't block the rest.
        // Fix #11: recipientIdentityKeyB64Cached avoids popping a
        // peer's OPK on every send. Pool exhaustion was draining
        // 50 keys in a single chat session.
        // Audit P0-N4: persist one outbox row per recipient BEFORE the
        // relay.send. A Doze kill mid-fanout used to silently lose every
        // un-shipped peer's envelope; drainOutbox now replays each row
        // on the next reconnect.
        const sendOne = async (userId: string): Promise<{
          status: 'ok'; userId: string; retractToken?: string; envelopeId?: string;
        }> => {
          const peer: SessionAddress = {userId, deviceId: 1};
          // A4 RC3-group-fanout-outbox-gap — if session establishment or the
          // seal/encrypt below throws (peer unprovisioned, OPK pool exhausted,
          // keys-service blip) we used to drop this member SILENTLY: the durable
          // enqueue happened AFTER encrypt, so a throw left no row to replay.
          // Wrap the pre-ship crypto and, on failure, persist a DEFERRED outbox
          // row carrying the plaintext send-intent so the next drain
          // re-establishes the session, re-seals (with a FRESH timestamp) and
          // ships — instead of permanently losing this recipient.
          let outerSealed: string;
          try {
          // [LAGDIAG] TEMPORARY (B-285) — stage timings for the 1:1 send. Numbers ONLY:
          // no envelope, ciphertext or key is referenced inside the log call, which
          // logAudit.test.ts forbids and which no probe is worth weakening.
          const tSes0 = Date.now();
          await ensureOutgoingSession(own, keys, peer, ownStore);
          const tSes1 = Date.now();
          // Round 5 / Security S1 — bind THIS recipient + timestamp
          // into the sealed envelope. Replay against another recipient
          // or stale session record is now detected at unseal time.
          const sealed = sealPayload(cert, sealedBody, {
            expiresAtSec,
            clientMsgId: wireClientMsgId,
            // GROUP MEDIA FIX — carry the attachment (objectKey + per-file
            // AES key + IV) in the sealed-sender payload, exactly like the
            // 1:1 path. Without this a group image/video/doc shipped a
            // text-only envelope, so recipients saw a caption with no media
            // (the per-file key never reached them). The attachment rides
            // inside the pairwise Signal + sealed-sender envelope (E2E; the
            // relay can't read it), matching the documented "key shipped
            // in-band inside the encrypted message envelope" model.
            attachment:  opts.attachment,
            // B-144 — carry the reply exactly like `attachment` above, and
            // for the same reason. Both ride INSIDE the pairwise Signal +
            // sealed-sender envelope (the relay cannot read either), and
            // `replyTo` is an existing SealedPayload field that
            // `isValidSealedPayload` already validates and that
            // `buildInboundMessage` has always read off the unwrapped
            // payload. Without it the group lane persisted the reply on the
            // AUTHOR's own bubble but shipped a plain message, so every
            // recipient lost the quote strip and reply-jump while the author
            // saw their own quote — which is why this survived manual
            // testing. AAD is deliberately untouched.
            replyTo:     replyMeta,
            // WIRE-COMPAT: mentions ride INSIDE `group`, never at the top
            // level. A top-level `mentions` key is rejected outright by any
            // client built before the field existed (isSealedPayload rejects
            // unknown top-level keys), which DESTROYED the message on arrival —
            // field-confirmed against a mixed fleet. The group branch of that
            // guard never iterates its keys, so an older peer ignores this and
            // renders plain text. See SealedGroup's header.
            //
            // Audit G-08 — stamp our current membership transcript hash so
            // recipients can detect a fork/equivocation (divergent admin
            // sequence) vs their own local transcript.
            group: {
              groupId: conversationId, kind: 'text', clientMsgId: wireClientMsgId,
              senderTranscriptHash: useMessengerStore.getState().groups[conversationId]?.transcriptHash,
              ...(mentionsMeta ? {mentions: mentionsMeta} : {}),
              // MM-09 — same carrier rule as mentions: inside `group`, never
              // a new top-level key (fatal to older peers).
              ...(fwdFlag ? {isForwarded: true} : {}),
            },
            // Audit P0-N2 — extend AAD with sender / conversation / group
            // so a captured group ciphertext can't be replayed into a
            // different thread or re-asserted under a stale group state.
            aad: {
              to:             peer,
              ts:             sealedTs,
              sender:         ownAddress,
              conversationId,
              groupId:        conversationId,
            },
          });
          const ct = await own.encrypt(peer, sealed);
          const tEnc1 = Date.now();
          const recipientIdKeyB64 = await recipientIdentityKeyB64Cached(ownStore, keys, peer, peerIdentityCache);
          const tIdk1 = Date.now();
          outerSealed = await wrapOuter({
            recipientIdentityKeyB64: recipientIdKeyB64,
            sender:                  ownAddress,
            ciphertext:              ct,
            // Audit P0-1 — bind the sender cert into the outer ECIES AAD
            // (Sealed Sender v2 / v3). Receiver verifies the cert
            // BEFORE calling own.decrypt, so a forged outer envelope
            // can no longer coerce the legacy DecryptError → closeSession
            // ratchet-wipe path.
            cert,
          });
          const tWrap1 = Date.now();
          // F-0 (B-693) — threshold 120 → 40 ms: at 120 the probe NEVER fired
          // on device (B-285) because each leg sat under it while their sum
          // did not. 40 ms still silences the warm-cache steady state.
          if (tWrap1 - tSes0 > 40) {
            console.warn(
              '[LAGDIAG] send1v1 session=' + (tSes1 - tSes0) +
              'ms ratchet=' + (tEnc1 - tSes1) +
              'ms idkey=' + (tIdk1 - tEnc1) +
              'ms sealedsender=' + (tWrap1 - tIdk1) +
              'ms total=' + (tWrap1 - tSes0) + 'ms',
            );
          }
          } catch (cryptoErr) {
            // A4 — session/seal/encrypt failed for THIS peer. Persist a durable
            // DEFERRED row so the drain re-seals + ships. The sealedBody (group
            // master-key-wrapped inner envelope) is reused; only the per-peer
            // outer sealed-sender wrap + AAD timestamp are re-minted at drain.
            if (sqlOutbox) {
              try {
                await sqlOutbox.enqueue({
                  clientMsgId:  wireClientMsgId,
                  conversationId,
                  messageId:    msgId,
                  peerUserId:   peer.userId,
                  peerDeviceId: peer.deviceId,
                  payload:      JSON.stringify({
                    deferred:   true,
                    sealedBody,
                    expiresAtSec,
                    attachment: opts.attachment,
                    groupId:    conversationId,
                    kind:       'text',
                    clientMsgId: wireClientMsgId,
                    // B-144 — same reason as the no-cert deferred row above.
                    replyTo:    replyMeta,
                    mentions:   mentionsMeta,
                    isForwarded: fwdFlag,
                  }),
                });
              } catch (enqErr) {
                console.warn('[messenger.outbox] group deferred enqueue failed:', asErrorMessage(enqErr));
              }
            }
            // Not delivered now; the drain owns the retry. Re-throw so the
            // allSettled tally counts this peer as not-delivered (the bubble
            // stays out of a false 'sent' when nobody received it live).
            throw cryptoErr;
          }
          // Audit P0-N4: enqueue per-peer outbox row before shipping so
          // a crash between here and the relay.send still leaves a
          // recoverable row. Composite PK (clientMsgId, peerUserId,
          // peerDeviceId) means all participants coexist in the table.
          if (sqlOutbox) {
            try {
              await sqlOutbox.enqueue({
                clientMsgId:  wireClientMsgId,
                conversationId,
                messageId:    msgId,
                peerUserId:   peer.userId,
                peerDeviceId: peer.deviceId,
                // SN-06 — carry the re-seal inputs alongside the sealed bytes.
                // A sender cert lives ~1h; a row queued through a longer
                // offline stretch used to be re-shipped verbatim with a dead
                // cert, which the recipient destroys BEFORE libsignal decrypt
                // (verifySenderCert runs first, +120s tolerance). The sender
                // meanwhile saw the relay's 200 and flipped the bubble to
                // 'sent'. Group rows have no undeliverable-resend path, so the
                // message was silently lost behind a delivered tick. These
                // fields let the drain re-mint a valid envelope instead — the
                // same shape (and the same function) the A4 deferred path
                // already uses.
                payload:      JSON.stringify({
                  outerSealed, expiresAtSec, certExpSec,
                  sealedBody,
                  attachment: opts.attachment,
                  groupId:    conversationId,
                  kind:       'text',
                  clientMsgId: wireClientMsgId,
                  // B-144 — SN-06 stale-cert re-mint reads these fields; the
                  // reply, the mentions and the forwarded flag must survive
                  // that path too.
                  replyTo:    replyMeta,
                  mentions:   mentionsMeta,
                  isForwarded: fwdFlag,
                }),
              });
              // Why: B-122 (XO-5, group edition) — a SAME-id retry (no prior
              // accept) collides with its terminal peer row via INSERT OR
              // IGNORE and the drain would never pick it up: a retried group
              // message whose live re-send also failed spun in 'sending'
              // forever. Re-open it, same as the 1:1 site. Under a B-683
              // fresh wire id this is a no-op (no rows carry the new id).
              if (opts.existingMsgId) {
                await sqlOutbox.resetFailed(wireClientMsgId, peer.userId, peer.deviceId);
              }
            } catch (e) {
              console.warn('[messenger.outbox] group enqueue failed:', asErrorMessage(e));
            }
          }
          // Group fan-out always uses HTTP. The WS path here used to
          // increment `delivered` on a pure transport.send() (no ack)
          // — half-dead sockets that buffered the frame but never
          // shipped it would fool us into flipping to 'sent' when
          // the peer never received anything. HTTP returns a real
          // 200 + retractToken, so we know the relay accepted it.
          try {
            const r = await relay.send({
              recipient:    peer,
              outerSealed,
              clientMsgId:  wireClientMsgId,
              expiresAtSec,
              // OM-03 — group fan-out is HTTP-submitted with no live-socket
              // submitter mapping, so the server can never push
              // envelope.delivered for this leg; the receipt-poll slot is
              // the only way this bubble ever leaves single-tick.
              receipt:      true,
            });
            // Delivered to relay — drop the outbox row so it isn't
            // replayed by the next reconnect drain.
            if (sqlOutbox) {
              sqlOutbox.markDelivered(wireClientMsgId, peer.userId, peer.deviceId).catch(e =>
                console.warn('[messenger.outbox] group markDelivered failed:', asErrorMessage(e)));
            }
            return {status: 'ok', userId, retractToken: r.retractToken, envelopeId: r.envelopeId};
          } catch (e) {
            // Transient failure — leave the row in the outbox; the next
            // reconnect drain will retry with backoff. recordAttempt
            // bumps the per-row counter so MAX_ATTEMPTS still trips —
            // except for unreachable-network failures (SN-04) and a relay that
            // answered "later" (XO-3: 5xx / its own 429 / no_token), which are
            // rescheduled without consuming the budget.
            //
            // Why: no `permanent` here — this site discards the result, so
            // terminating the row would strand the aggregate bubble in
            // 'sending' with a row dueRows never returns (XO-5).
            if (sqlOutbox) {
              const outbox = sqlOutbox;
              const f = classifyOutboxFailure(e);
              outbox.recordAttempt(wireClientMsgId, peer.userId, peer.deviceId, {
                unreachable: f.kind === 'unreachable',
                transient:   f.kind === 'server-transient',
                deferMs:     f.retryAfterMs,
              }).catch(err =>
                console.warn('[messenger.outbox] group recordAttempt failed:', asErrorMessage(err)));
              if (f.kind === 'server-transient') {
                scheduleTransientRedrain(outbox, relay, isOurEpoch, resealOutboxRow, f.retryAfterMs);
              }
            }
            throw e;
          }
        };
        // Audit P0-V5 / row #3 (M2) — register the attachment grant
        // set BEFORE fanout so a recipient who receives the sealed
        // envelope and immediately tries to download finds the grant
        // already populated. Awaiting AFTER fanout cannot close the
        // race — each peer has already raced their own download against
        // the SADD. One RTT to messenger-service before parallel
        // per-peer encrypt + WS submits. Errors are soft: message goes
        // through either way; only attachment download would 403 under
        // strict-mode if SADD failed. H5 note: passing FULL participants
        // (not just delivered) is intentional — failed peers can't
        // decrypt the envelope so a grant for them is harmless;
        // filtering would require a 2nd SADD post-fanout for no
        // security benefit.
        if (opts.attachment?.objectKey) {
          try {
            await mediaClient.registerGrants(opts.attachment.objectKey, participants);
          } catch (e) {
            console.warn('[messenger.media] registerGrants (group, pre-fanout) failed:', asErrorMessage(e));
          }
        }
        // F-0 (B-693) — DL-3 fan-out aggregate: member count + wave wall time.
        // Numbers and counts only (logAudit posture); ids at most.
        const tWave0 = Date.now();
        // F-2 (B-693, critic-reshaped) — STAGGERED LAUNCH, never gated waves.
        // A flat allSettled over N members queues every member's ratchet
        // encrypt + ECIES wrap + outbox writes as one contiguous microtask
        // train on this JS thread — a 30-member dept post starves rendering
        // for the whole fan-out (DL-3). The first cut chunked the WHOLE
        // sendOne (awaited each wave before launching the next) — REJECTED:
        // that gates wave w+1 on wave w's network SETTLE, so one slow leg
        // (cold-session prekey fetch, hung 20s POST) head-of-line-blocks
        // every later member's send AND delays their P0-N4 durable enqueue
        // by a network-bounded window (Doze-kill mid-stall = silent partial
        // loss behind a 'sent' bubble). This shape staggers only the LAUNCH:
        // a macrotask boundary between wave starts (setTimeout, not
        // Promise.resolve — a microtask yield hands nothing back to
        // rendering/touches) spaces the CPU bursts, while every leg's
        // network runs concurrently exactly as before — a slow leg delays
        // nobody but itself, and every enqueue lands CPU-bounded. Launch
        // order follows participant order, so the failures[] tally and the
        // per-recipient envelope/token maps below are unchanged.
        const GROUP_FANOUT_WAVE = 8;
        const sendPromises: Array<Promise<Awaited<ReturnType<typeof sendOne>>>> = [];
        for (let w = 0; w < participants.length; w += GROUP_FANOUT_WAVE) {
          const wave = participants.slice(w, w + GROUP_FANOUT_WAVE);
          for (const memberId of wave) {
            const leg = sendOne(memberId);
            // Why: the allSettled below attaches handlers only after EVERY
            // wave has launched — macrotask turns away. An early leg that
            // rejects inside that stagger window would fire the global
            // unhandled-rejection hook (red-box in dev, jest failure).
            // Attaching a no-op catch marks the leg handled NOW; allSettled
            // on the original promise still records the real rejection.
            leg.catch(() => { /* gathered by allSettled below */ });
            sendPromises.push(leg);
          }
          if (w + GROUP_FANOUT_WAVE < participants.length) {
            await new Promise<void>(resolve => setTimeout(resolve, 0));
          }
        }
        const results = await Promise.allSettled(sendPromises);
        const tWave1 = Date.now();
        let delivered = 0;
        const failures: string[] = [];
        let firstRetractToken: string | undefined;
        // SYNC-1 — one relay envelopeId per recipient. Keeping only the
        // first made every OTHER member's read receipt unmatchable, so the
        // B-116 "all participants read" aggregate could never complete.
        const envelopeIdByRecipient: Array<[string, string]> = [];
        // B-187 — per-recipient tokens, the pair to envelopeIdByRecipient:
        // without them the receipt poll can only probe the first leg.
        const retractTokenByRecipient: Array<[string, string]> = [];
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          if (r.status === 'fulfilled') {
            delivered += 1;
            if (!firstRetractToken && r.value.retractToken) {
              firstRetractToken = r.value.retractToken;
            }
            if (r.value.envelopeId) {
              envelopeIdByRecipient.push([r.value.userId, r.value.envelopeId]);
            }
            if (r.value.retractToken) {
              retractTokenByRecipient.push([r.value.userId, r.value.retractToken]);
            }
          } else {
            failures.push(`${participants[i]}: ${asErrorMessage(r.reason)}`);
          }
        }
        // F-0 (B-693) — one line per group/dept-channel send. The wave is
        // parallel at I/O but serial at CPU (N pairwise encrypts on this JS
        // thread), so waveMs vs members is THE DL-3 scaling number.
        console.warn(
          '[LAGDIAG] [send.group] members=' + participants.length +
          ' delivered=' + delivered +
          ' failed=' + failures.length +
          ' waveMs=' + (tWave1 - tWave0) +
          ' convo=' + conversationId.slice(0, 12),
        );
        if (firstRetractToken) {
          useMessengerStore.getState().updateMessageRetractToken(conversationId, msgId, firstRetractToken);
        }
        for (const [recipientUserId, token] of retractTokenByRecipient) {
          useMessengerStore
            .getState()
            .updateMessageRetractToken(conversationId, msgId, token, recipientUserId);
        }
        for (const [recipientUserId, envelopeId] of envelopeIdByRecipient) {
          useMessengerStore
            .getState()
            .updateMessageEnvelopeId(conversationId, msgId, envelopeId, recipientUserId);
        }

        if (delivered === 0) {
          // Why: a dept-channel admin posting where every member is offline
          // or unprovisioned (no published prekeys → ensureOutgoingSession
          // can't open a session, OR the relay was unreachable this instant)
          // must NOT lose the post. The bubble is already in the store and
          // mirrored to SQLCipher by the write-through subscriber, and every
          // peer we got far enough to encrypt for has a durable outbox row
          // (enqueued before relay.send) that the next reconnect drain
          // re-ships. Mirror the 1:1 offline-peer behaviour — keep the
          // message queued, don't hard-throw on "zero reachable right now".
          // The sealed-sender fan-out, sender-cert verification and
          // master-key wrap above are unchanged. (A group that was never
          // synced already threw earlier with "no other participants", so
          // that genuine "unknown/empty group" case still surfaces.)
          if (failures.length > 0) {
            console.warn('[group-send:runtime] no peer reachable this send; message queued for retry');
          }
          // Leave the bubble in its durable 'sending' state (re-assert so
          // the write-through subscriber re-persists the queued row).
          useMessengerStore.getState().updateMessageStatus(conversationId, msgId, 'sending');
          return;
        }
        useMessengerStore.getState().updateMessageStatus(conversationId, msgId, 'sent');
        return;
      }

      // ── 1:1 path ───────────────────────────────────────────────────
      // B-364 — derive the peer when the caller could not pass one (the
      // notification-action drain only has a conversation id): a still-
      // `direct:` id names its peer directly (canonicalisation above already
      // swapped it for the server-UUID when that row exists), and a UUID row
      // carries `peer`. Callers that DO pass a peer are untouched; this only
      // fires where the send previously threw "requires explicit peer
      // address" unconditionally (six queued replies looping on the Redmi,
      // 2026-08-01 13:33).
      const derivedPeer = ((): SessionAddress | undefined => {
        if (isDirectPrefixed(conversationId)) {
          const uid = peerFromDirectSlot(conversationId);
          return uid ? {userId: uid, deviceId: 1} : undefined;
        }
        const row = useMessengerStore.getState().conversations[conversationId];
        return row?.peer?.userId ? {userId: row.peer.userId, deviceId: row.peer.deviceId ?? 1} : undefined;
      })();
      const target = opts.peer ?? derivedPeer ?? {userId: '', deviceId: 1};

      // M-15 — build + append the optimistic bubble BEFORE any of the crypto
      // awaits below. A first-contact X3DH failure (ensureOutgoingSession
      // fetching a prekey bundle) or a seal/wrap throw used to propagate
      // BEFORE the bubble existed, so ChatScreen's catch only flashed an
      // error banner and the user's typed text was gone with no failed
      // bubble and no retry chip. The bubble/outbox `msg` does not depend on
      // the ciphertext, so it's safe to materialise it up front and flip it
      // to 'failed' if the pipeline throws.
      // P2-12 — sendMedia already appended this bubble before its upload and
      // hands its id via `existingMsgId`; skip the append so there's no dupe.
      if (!opts.existingMsgId) {
      const msg: LocalMessage = {
        id: msgId,
        conversation_id: conversationId,
        sender_id: 'self',
        // BS-SELF-MEDIA-TYPE — derive image/video/file/audio from the mime
        // (was hardcoded 'file'), so the SENDER's own 1:1 image shows a
        // thumbnail and their own voice note shows the audio player —
        // matching the recipient + the group-send path.
        type: attachmentMessageType(opts.attachment),
        content: text,
        media_mime: opts.attachment?.mimeType,
        media_object_key: opts.attachment?.objectKey,
        // Round 8 — see the group-send branch above. Without this the
        // 1:1 attachment rendering pipeline can't decrypt R2 ciphertext
        // after a backup-restore.
        media_key: opts.attachment?.keyB64,
        media_iv:  opts.attachment?.ivB64,
        media_meta: attachmentMediaMeta(opts.attachment),
        status: 'sending',
        is_encrypted: true,
        created_at: sentAt,
        peer: target,
        expires_at: expiresAtSec ? expiresAtSec * 1000 : undefined,
        reply_to_msg_id:  replyMeta?.msgId,
        reply_to_preview: replyMeta?.preview,
        mentions:         mentionsMeta,
        is_forwarded:     fwdFlag,
      };
      useMessengerStore.getState().appendMessage(conversationId, msg);
      }

      // M3/B-125 — mirror of the group branch's failGroupSend: flip the bubble
      // (whether just appended, or pre-existing on a retry via existingMsgId)
      // to `failed` BEFORE throwing, so the text survives on screen behind a
      // retry chip instead of being destroyed. Every validation exit on the
      // 1:1 path below the append must go through here, never a bare throw.
      const failDirectSend = (message: string): never => {
        useMessengerStore.getState().updateMessageStatus(conversationId, msgId, 'failed');
        throw new Error(message);
      };
      if (!target.userId) {
        failDirectSend('production mode requires explicit peer address');
      }
      if (text.length > MAX_MESSAGE_CHARS) {
        failDirectSend(`message too long to send (${text.length} > ${MAX_MESSAGE_CHARS} characters)`);
      }

      // TOFU send-gate (opt-in via EXPO_PUBLIC_STRICT_IDENTITY_SEND_GATE). When
      // enabled, refuse to send to a 1:1 peer whose identity changed until the
      // user acknowledges it (WhatsApp "safety number changed — tap to accept").
      //
      // M3 — this used to sit ABOVE the append, with a comment claiming that
      // placement kept a blocked send from "orphaning a stuck 'sending' row".
      // It did the opposite: ChatScreen clears the composer before awaiting, so
      // a silent `return` up there DESTROYED the user's typed text and left only
      // a banner. Exactly the B-125 shape, and latent the moment the flag is
      // enabled. Below the append and routed through failDirectSend, the text
      // survives as a `failed` bubble with a working retry chip — so once the
      // user accepts the new safety number, the retry sends the same message
      // instead of asking them to remember and retype it. B-122's separate
      // `existingMsgId` flip is subsumed: failDirectSend covers the retry case
      // too, so a double flip would be dead weight.
      //
      // Groups are not gated here (per-member TOFU is out of scope), which is
      // why this lives in the 1:1 branch rather than above the split.
      if (isIdentitySendGateEnabled()) {
        const gatePeerId =
          opts.peer?.userId ??
          (isDirectPrefixed(conversationId) ? peerFromDirectSlot(conversationId) : convo?.peer?.userId);
        if (gatePeerId && hasPendingIdentityAck(gatePeerId)) {
          try {
            useMessengerStore.getState().setError('This contact’s security code changed. Review and accept it before sending.');
          } catch { /* ignore */ }
          failDirectSend('identity change not yet acknowledged for this contact');
        }
      }

      // B-122 — the relay dedups on (recipient, clientMsgId) and answers the
      // ORIGINAL accept for a repeat submit, so a tap-to-retry of a message
      // the relay accepted once (envelope_id present — every 'undelivered'
      // bubble, plus a slow-network send misclassified as failed after its
      // accept actually landed) was a silent no-op: 200, bubble 'sent',
      // nothing delivered. Re-send those under a FRESH wire id — the bubble
      // id is unchanged; the same trade B-46's auto-resend already made. A
      // message the relay never accepted keeps the SAME id so a genuine
      // double-submit still coalesces.
      let wireClientMsgId = clientMsgId;
      if (opts.existingMsgId) {
        const prior = useMessengerStore.getState()
          .messages[conversationId]?.find(m => m.id === msgId);
        if (prior?.envelope_id) {
          wireClientMsgId = makeId();
          // The old row (if any) holds bytes the relay already claimed —
          // drop it so a later drain can't re-ship a guaranteed no-op.
          if (sqlOutbox) {
            try { await sqlOutbox.deleteByClientMsgId(clientMsgId); }
            catch { /* best-effort */ }
          }
        }
      }

      // Audit MSG-07 / M-15: the bubble is already on screen; a throw in the
      // crypto pipeline below (no session / prekey fetch, identity fetch
      // failure, seal or wrap error) flips it to 'failed' (retry chip re-runs
      // the whole path) instead of stranding it in 'sending' or losing the text.
      let outerSealed: Awaited<ReturnType<typeof wrapOuter>>;
      let cert: Awaited<ReturnType<typeof certCache.get>>;
      // XO-1 — persisted with the row so the drain can tell a still-valid
      // envelope from one whose cert has aged out (SN-06 parity for 1:1).
      let certExpSec: number;
      // F-0 (B-693) — 1:1 stage stamps. The B-285 group-side probe never
      // covered this lane; these fill the sender half of the §3c ledger.
      // Numbers only (logAudit posture). Zeroed legs = the try threw there.
      const tS0 = Date.now();
      let tCertS1 = 0; let tSesS1 = 0; let tEncS1 = 0; let tIdkS1 = 0; let tWrapS1 = 0;
      try {
        // P1-1 — fetch the sender cert INSIDE the try so an offline reject (or
        // its 30s negative cache) parks the already-appended bubble (deferred
        // row, or `failed`) instead of throwing before any bubble exists.
        const issued = await certCache.getIssued();
        cert       = issued.cert;
        certExpSec = issued.expiresAt;
        tCertS1 = Date.now();
        // B-122 — an 'undelivered' retry must not re-wrap against the DEAD
        // cached identity/session that got the original destroyed; rebuild
        // from the peer's CURRENT bundle (the same recovery B-46's
        // auto-resend performs).
        if (opts.freshSession) {
          await refreshPeerIdentityAndSession(target);
        } else {
          await ensureOutgoingSession(own, keys, target, ownStore);
        }
        tSesS1 = Date.now();
        // Round 5 / Security S1 — bind recipient + timestamp into the
        // sealed envelope so the receiver can detect replays against a
        // different recipient or stale session record.
        const sealed = sealPayload(cert, text, {
          attachment:   opts.attachment,
          expiresAtSec,
          clientMsgId:  wireClientMsgId,
          replyTo:      replyMeta,
          // MM-09 — 1:1 lane only: `isForwarded` IS a new top-level key, so a
          // peer on a build predating its allowlist entry rejects the payload
          // (same rollout class as `edit`/`deleteFor` when they shipped). The
          // group lane never emits it top-level — it rides inside `group`.
          isForwarded:  fwdFlag,
          // WIRE-COMPAT: no top-level `mentions`. Mentions are group-only, and
          // the key itself is fatal to an older peer — see SealedGroup.
          // Audit P0-N2 — extend AAD with sender + conversation so a 1:1
          // ciphertext can't be replayed into a group thread (recipient's
          // group state would reject mismatched conversationId).
          //
          // Audit P0-N2-follow-up — the AAD conversationId MUST be
          // symmetric across sender and receiver: Alice was stamping
          // `direct:bob` (her local UI key) while Bob computed
          // `direct:alice` (his local UI key), so verifySealedAad
          // rejected every 1:1 message with `conversation_mismatch`
          // and the sender saw "sent" while the receiver saw nothing.
          // `directConvoAadId(self, peer)` is order-independent so both
          // sides compute the same string.
          aad:          {
            to:             target,
            ts:             composedTsMs,
            sender:         ownAddress,
            conversationId: directConvoAadId(ownAddress.userId, target.userId),
          },
        });
        const ct = await own.encrypt(target, sealed);
        tEncS1 = Date.now();
        const recipientIdKeyB64 = await recipientIdentityKeyB64Cached(ownStore, keys, target, peerIdentityCache);
        tIdkS1 = Date.now();
        outerSealed = await wrapOuter({
          recipientIdentityKeyB64: recipientIdKeyB64,
          sender:                  ownAddress,
          ciphertext:              ct,
          cert, // P0-1: cert bound into outer AAD
        });
        tWrapS1 = Date.now();
      } catch (e) {
        // XO-2 — crypto prep failed (cold/negative-cached sender cert on an
        // offline launch, or session/seal/wrap). Persist the send INTENT so
        // the drain re-mints a fresh cert + session and ships when
        // connectivity returns, mirroring the A4 group deferred row. Only
        // fall back to `failed` when there is no durable queue to hand it to.
        let deferredQueued = false;
        if (sqlOutbox) {
          const deferredPayload: DeferredDirectOutboxPayload = {
            deferred:   true,
            direct:     true,
            body:       text,
            expiresAtSec,
            attachment: opts.attachment,
            replyTo:    replyMeta,
            mentions:   mentionsMeta,
            isForwarded: fwdFlag,
            clientMsgId: wireClientMsgId,
          };
          try {
            await sqlOutbox.enqueue({
              clientMsgId:  wireClientMsgId,
              conversationId,
              messageId:    msgId,
              peerUserId:   target.userId,
              peerDeviceId: target.deviceId,
              payload:      JSON.stringify(deferredPayload),
            });
            // Why: XO-5 — tap-to-retry reuses the clientMsgId, so the INSERT
            // OR IGNORE above no-ops over a terminal row. Re-open it so a
            // queued deferred intent is actually drainable.
            if (opts.existingMsgId) {
              await sqlOutbox.resetFailed(wireClientMsgId, target.userId, target.deviceId);
            }
            deferredQueued = true;
          } catch (enqErr) {
            console.warn('[messenger.outbox] direct deferred enqueue failed:', asErrorMessage(enqErr));
          }
        }
        if (deferredQueued) {
          useMessengerStore.getState().updateMessageStatus(conversationId, msgId, 'sending');
          return;
        }
        useMessengerStore.getState().updateMessageStatus(conversationId, msgId, 'failed');
        throw e;
      }
      // Audit P0-V5 / row #3 (M2) — register the 1:1 attachment grant
      // server-side BEFORE the WS submit so the recipient's download
      // attempt (which can race after their sealed-envelope receive)
      // finds the grant set already populated. Fire-and-forget
      // previously raced the recipient's fetch in strict mode. The
      // server adds the sender to the grant set automatically so we
      // only need to list the peer here. Soft fail: message still
      // goes out either way; only attachment download would 403
      // under strict mode if SADD failed.
      if (opts.attachment?.objectKey) {
        try {
          await mediaClient.registerGrants(opts.attachment.objectKey, [target.userId]);
        } catch (e) {
          console.warn('[messenger.media] registerGrants (1:1) failed:', asErrorMessage(e));
        }
      }
      // Durable outbox — persist the outgoing envelope to SQLCipher
      // BEFORE handing it to the WS transport. If the app dies between
      // here and the server's `envelope.accepted`, the row survives
      // and the next-launch / next-connect drain re-ships it. Closes
      // the "WhatsApp keeps it, we lose it" message-loss-on-Doze gap.
      // Best-effort: if the DB write fails (full disk, file lock), we
      // still attempt the WS send — degrades to the pre-outbox
      // behaviour rather than blocking the user.
      if (sqlOutbox) {
        try {
          await sqlOutbox.enqueue({
            clientMsgId:  wireClientMsgId,
            conversationId,
            messageId:    msgId,
            peerUserId:   target.userId,
            peerDeviceId: target.deviceId,
            // XO-1 — carry the re-seal inputs alongside the sealed bytes. A
            // sender cert lives ~1h; a row queued through a longer offline
            // stretch used to be re-shipped verbatim with a dead cert, which
            // the recipient destroys BEFORE libsignal decrypt while the relay
            // still answers 200 — silent loss behind a 'sent' tick. Same
            // shape (and same callback) the group SN-06 path already uses.
            payload:      JSON.stringify(buildDirectSealedOutboxPayload({
              outerSealed,
              expiresAtSec,
              certExpSec,
              body:       text,
              attachment: opts.attachment,
              replyTo:    replyMeta,
              mentions:   mentionsMeta,
              isForwarded: fwdFlag,
              clientMsgId: wireClientMsgId,
            })),
          });
          // Why: XO-5 — tap-to-retry re-sends under the SAME clientMsgId, so the
          // enqueue above is an INSERT OR IGNORE no-op and a row already at
          // 'failed' stays terminal. `queued` would then be true for a row
          // `dueRows` never returns and the bubble would spin in 'sending'
          // forever. Re-open it so "queued" really means drainable. No-op when
          // the row is pending or absent (resetFailed filters on status).
          if (opts.existingMsgId) {
            await sqlOutbox.resetFailed(wireClientMsgId, target.userId, target.deviceId);
          }
        } catch (e) {
          console.warn('[messenger.outbox] enqueue failed:', asErrorMessage(e));
        }
      }

      // F-0 (B-693) — the 1:1 stage line. `outbox` = attachment grants (when
      // any) + the awaited durable enqueue — the dead-phone plan F8 number.
      // ≥40 ms keeps the warm steady state quiet; [send.total] has the totals.
      {
        const tOb1 = Date.now();
        if (tWrapS1 > 0 && tOb1 - tS0 >= 40) {
          console.warn(
            '[LAGDIAG] [send.1v1] cert=' + (tCertS1 - tS0) +
            'ms session=' + (tSesS1 - tCertS1) +
            'ms ratchet=' + (tEncS1 - tSesS1) +
            'ms idkey=' + (tIdkS1 - tEncS1) +
            'ms wrap=' + (tWrapS1 - tIdkS1) +
            'ms outbox=' + (tOb1 - tWrapS1) +
            'ms total=' + (tOb1 - tS0) + 'ms',
          );
        }
      }

      // Don't flip to 'sent' yet — we haven't actually shipped it to
      // the relay. The WS send below is fire-and-forget (no ack here);
      // the real 'sent' transition happens on `envelope.accepted` from
      // the server (handleAccepted). The HTTP fallback IS sync, so we
      // can flip directly there. WhatsApp single-tick semantics:
      // "delivered to server", not "encrypted locally."
      // HTTP fallback closure — used when WS throws OR when WS send
      // succeeds but the server never ACKs within the watchdog.
      // B-703 MR-4 — capture acceptance ONCE, before this attempt ships
      // anything, so the fallback's catch can tell "the relay accepted THIS
      // attempt" from "this bubble already carried a previous attempt's
      // artifact" (the 1:1 retry lane keeps round-1 artifacts on purpose, so an
      // artifact alone proves nothing about this send).
      //
      // Taken HERE, not inside the closure: the accept can land between the
      // watchdog's pre-check and the retry actually starting, and a snapshot
      // taken at that point would already see it and conclude nothing changed.
      const acceptedBefore = snapshotAcceptance(
        useMessengerStore.getState().messages[conversationId]?.find(m => m.id === msgId),
      );
      const httpFallback = async (): Promise<void> => {
        try {
          const r = await relay.send({
            recipient:    target,
            outerSealed,
            clientMsgId:  wireClientMsgId,
            expiresAtSec,
            // OM-03 — no live socket for envelope.delivered on this lane;
            // park the anonymous receipt slot so the tick can still advance.
            receipt:      true,
          });
          if (r.retractToken) {
            useMessengerStore.getState().updateMessageRetractToken(conversationId, msgId, r.retractToken);
          }
          // Audit MSG-03 — record the envelopeId so a 1:1 message sent via the
          // HTTP fallback still advances to delivered/read (the WS-accepted
          // path sets it, but the HTTP leg previously dropped it).
          if (r.envelopeId) {
            useMessengerStore.getState().updateMessageEnvelopeId(conversationId, msgId, r.envelopeId);
          }
          useMessengerStore.getState().updateMessageStatus(conversationId, msgId, 'sent');
          // Resolve the pending so a late envelope.accepted (if any
          // arrives via the still-open WS) doesn't double-flip — and
          // critically, clear the ack-watchdog timer so it doesn't
          // fire AGAIN with a duplicate HTTP retry (Fix #3).
          clearPending(wireClientMsgId);
          // Durable outbox — relay confirmed, drop the row so it isn't
          // replayed on the next connect. Audit P0-N4: pass the peer
          // tuple since the PK is now composite.
          if (sqlOutbox) {
            sqlOutbox.markDelivered(wireClientMsgId, target.userId, target.deviceId).catch(e =>
              console.warn('[messenger.outbox] markDelivered failed:', asErrorMessage(e)));
          }
        } catch (e) {
          // Pop the pending entry (and its ack watchdog) either way so the LRU
          // doesn't accumulate dead entries (Fix #8).
          clearPending(wireClientMsgId);
          // B-703 MR-4 — the accept may have landed WHILE this retry was in
          // flight. The watchdog pre-checks "already sent?" BEFORE it starts,
          // but nothing re-checked after: handleAccepted flips 'sent', records
          // the envelope id and DELETES the outbox row, so recordAttempt below
          // finds no row, reports queued=false, and the stamp at the end of
          // this block overwrites an accepted status with a failed one on a
          // message the relay is holding (both are off-ladder, so status rank
          // does not protect it).
          // The retry chip then mints a FRESH wire id the relay's dedup cannot
          // coalesce, so the recipient gets it twice: one race, both symptoms.
          // Checked before recordAttempt so an accepted send never burns an
          // outbox attempt either.
          //
          // Scoped to THIS attempt (acceptedBefore, captured above the POST):
          // an artifact left by a PREVIOUS attempt proves nothing here. The 1:1
          // retry lane keeps round-1 artifacts, so on every undelivered retry —
          // B-122's whole population — an artifact-only test would swallow a
          // genuine round-2 failure and leave the bubble spinning with no chip,
          // no banner and no terminal outbox state. That loses the message; the
          // bug this guard exists for only loses a chip.
          const live = useMessengerStore.getState()
            .messages[conversationId]?.find(m => m.id === msgId);
          if (acceptedDuringAttempt(acceptedBefore, live)) {
            console.warn(
              '[bravo.send] HTTP retry failed but the relay accepted this attempt mid-flight — keeping status=' +
                String(live?.status) + ', clientMsgId=' + wireClientMsgId,
            );
            return;
          }
          // Why: XO-5 — the outbox owns the terminal decision. Don't delete the
          // row: the next connect-drain retries with backoff (SN-04 reschedules
          // an unreachable network without burning an attempt). While the row is
          // still queued the bubble MUST stay 'sending' — a red bubble over a row
          // that auto-sends later invites a re-typed duplicate, and a re-type
          // mints a fresh clientMsgId the relay's (recipient, clientMsgId) dedup
          // cannot coalesce. Mirrors the group path's delivered===0 branch, which
          // already returns instead of throwing.
          const f = classifyOutboxFailure(e);
          let queued = false;
          if (sqlOutbox) {
            const outbox = sqlOutbox;
            try {
              const res = await outbox.recordAttempt(wireClientMsgId, target.userId, target.deviceId, {
                unreachable: f.kind === 'unreachable',
                transient:   f.kind === 'server-transient',
                deferMs:     f.retryAfterMs,
                permanent:   isPermanentRelayRejection(e),
              });
              queued = res.queued;
            } catch (err) {
              console.warn('[messenger.outbox] recordAttempt failed:', asErrorMessage(err));
            }
            if (f.kind === 'server-transient') {
              scheduleTransientRedrain(outbox, relay, isOurEpoch, resealOutboxRow, f.retryAfterMs);
            }
          }
          if (queued) {
            console.warn(`[bravo.send] relay unavailable (${f.kind}/${f.status}) — queued for retry, clientMsgId=${wireClientMsgId}`);
            return;
          }
          useMessengerStore.getState().updateMessageStatus(conversationId, msgId, 'failed');
          throw e;
        }
      };

      try {
        transport.send({
          event: 'envelope.send',
          data: {
            to:           target,
            outerSealed,
            clientMsgId:  wireClientMsgId,
            expiresAtSec,
          },
        });
        // WS send didn't throw — but socket.io can buffer to a
        // half-dead fd (Doze just froze it, internal heartbeat
        // hasn't expired yet). Set a watchdog: if the server doesn't
        // ack via envelope.accepted within the ack deadline (2.5-20s,
        // RTT-scaled — F-4/B-693), retry over HTTP. Resolves the "single
        // tick but Sirajul never got it" pattern observed when sending
        // right after Doze unfreeze.
        // Fix #3: STORE the timer on the pending entry. handleAccepted
        // and httpFallback success now BOTH call clearPending which
        // clears the watchdog. Without that, a fast ack could leave
        // the watchdog armed; a deadline later it'd fire a duplicate HTTP
        // retry and the server would log a duplicate clientMsgId.
        const ackTimer = setTimeout(() => {
          const entry = pendingByClientMsgId.get(wireClientMsgId);
          if (!entry) {return;}                                    // already cleared
          const cur = useMessengerStore.getState().messages[conversationId]?.find(m => m.id === msgId);
          // B-703 MR-4 — the same question, asked through the shared rule: a row
          // already at 'delivered'/'read' is just as accepted as one at 'sent',
          // and re-submitting it over HTTP (possibly with a forceReconnect, the
          // B-72 churn cost) buys nothing.
          if (cur && wasSendAccepted(cur)) { clearPending(wireClientMsgId); return; }
          // SN-03 — the HTTP fallback always runs; the socket teardown does
          // NOT. A missed ack on a high-RTT link is far more often "slow"
          // than "dead", and forceReconnect() drops every OTHER pending ack
          // on the socket, arming their watchdogs too — the sustained
          // reconnect churn seen in B-72 (receiver WS flapping every 60-90s
          // with a pending-flush re-loop). Only tear down when the heartbeat
          // independently agrees the server has gone silent.
          const silentFor = (() => {
            try { return transport.msSinceServerSignal(); } catch { return 0; }
          })();
          const serverLooksDead = silentFor >= SERVER_SILENCE_DEAD_MS;
          console.warn(
            '[bravo.send] WS ack timeout — HTTP retry' +
              (serverLooksDead ? ' + forcing reconnect (server silent)' : ' (socket kept)') +
              ', clientMsgId=', wireClientMsgId,
          );
          try {
            // P1-BR-4 (B-58) — don't tear down the socket mid-call: the
            // gateway disconnect-bye would drop the peer's call. The HTTP
            // fallback below still delivers the message; a genuinely dead
            // socket is caught by the heartbeat / AppState-resume probe.
            if (serverLooksDead && !hasLiveCall()) {
              transport.forceReconnect().catch(() => { /* state machine surfaces */ });
            }
          } catch { /* ignore */ }
          void httpFallback().catch(e =>
            console.warn('[bravo.send] HTTP retry also failed:', asErrorMessage(e)));
        }, wsAckDeadlineMs());
        trackPending(wireClientMsgId, {conversationId, messageId: msgId, peer: target, ackTimer});
      } catch {
        // No timer to track in this path — fall straight to HTTP. We
        // still record the pending entry so handleAccepted (if a late
        // WS ack lands once the socket reopens) can resolve it.
        trackPending(wireClientMsgId, {conversationId, messageId: msgId, peer: target});
        await httpFallback();
      }

      // CRIT-7 multi-device fan-out (flag-gated, EXPO_PUBLIC_MULTI_DEVICE, off
      // by default). The send above reaches the peer's device 1 (today's exact
      // behavior). When enabled, ALSO deliver to the peer's OTHER devices so a
      // linked/second device isn't silently skipped. Fully additive + best-
      // effort: it runs AFTER the primary send, never blocks it, never touches
      // the local bubble/outbox, and a per-device failure is isolated. Same
      // clientMsgId ⇒ each device dedups; the primary device's own dedup is
      // unaffected. Default off ⇒ this block is skipped and the path is
      // byte-identical.
      if (isMultiDeviceEnabled() && keys) {
        void (async () => {
          try {
            const devices = await keys.fetchDevices(target.userId);
            for (const d of devices) {
              const dev = d.address;
              if (dev.deviceId === target.deviceId) {continue;} // primary already handled
              try {
                if (!(await own.hasSession(dev))) {await own.initOutgoingSession(d);}
                const sealedN = sealPayload(cert, text, {
                  attachment:   opts.attachment,
                  expiresAtSec,
                  clientMsgId:  wireClientMsgId,
                  replyTo:      replyMeta,
                  isForwarded:  fwdFlag,
                  // WIRE-COMPAT: no top-level `mentions` — see SealedGroup.
                  aad: {
                    to:             dev,
                    ts:             Date.now(),
                    sender:         ownAddress,
                    conversationId: directConvoAadId(ownAddress.userId, target.userId),
                  },
                });
                const ctN = await own.encrypt(dev, sealedN);
                const outerSealedN = await wrapOuter({
                  recipientIdentityKeyB64: d.identityKey,
                  sender:                  ownAddress,
                  ciphertext:              ctN,
                  cert,
                });
                try {
                  transport.send({event: 'envelope.send', data: {to: dev, outerSealed: outerSealedN, clientMsgId: wireClientMsgId, expiresAtSec}});
                } catch {
                  await relay.send({recipient: dev, outerSealed: outerSealedN, clientMsgId: wireClientMsgId, expiresAtSec});
                }
              } catch (e) {
                console.warn('[multi-device] fan-out to device ' + dev.deviceId + ' failed:', asErrorMessage(e));
              }
            }
          } catch (e) {
            console.warn('[multi-device] fetchDevices failed:', asErrorMessage(e));
          }
        })();
      }
    },
    sendMedia: async (conversationId, media, mediaOpts) => {
      // Resolve the canonical conversation id the same way sendText does
      // so the local bubble lands in the slot ChatScreen subscribes to.
      let convId = conversationId;
      if (isDirectPrefixed(convId)) {
        const {resolveDirectConversationIdFromState: resolve} =
          require('../store/messengerStore') as typeof import('../store/messengerStore');
        const peerUid = peerFromDirectSlot(convId);
        convId = resolve(useMessengerStore.getState(), peerUid);
      }

      // GF-5 — same fail-closed gate as sendText, but BEFORE the upload so a
      // keyless group send never burns an R2 object it can never ship (there
      // is no delete API).
      {
        const pendingErr = GROUP_KEY_PENDING_SEND_ERROR;
        const blocked = groupSendBlockedReason(
          useMessengerStore.getState(),
          convId,
          mediaOpts?.isGroup === true,
        );
        if (blocked) {
          void requestGroupKeyResyncImpl(convId).catch(() => { /* best-effort */ });
          throw new Error(pendingErr);
        }
      }

      // P2-12 — append an optimistic `sending` bubble BEFORE the upload so a
      // slow or failed upload leaves a durable on-screen row (visible + retryable)
      // instead of only a spinner + one-shot Alert. sendText later runs
      // crypto/outbox/fan-out against THIS bubble (via existingMsgId) rather than
      // minting a duplicate. `peer` is legacy for the group path (routing is by
      // clientMsgId + group id); a placeholder is fine when unknown.
      const msgId = makeId();
      const expiresAtMs = mediaOpts?.ttlSeconds ? Date.now() + mediaOpts.ttlSeconds * 1000 : undefined;
      // B-450 — the quote for a reply-with-attachment. The handoff below passes
      // `existingMsgId`, which makes sendText SKIP its own appendMessage, so this
      // append is the only chance the author's own bubble gets the quote strip.
      // Capped with the SAME constant sendText/planSend use — the wire copy is
      // capped there, and two different caps would render two different quotes.
      const replyMeta = mediaOpts?.replyTo
        ? {
            msgId:   mediaOpts.replyTo.messageId,
            preview: (mediaOpts.replyTo.preview ?? '').slice(0, REPLY_PREVIEW_MAX_CHARS),
          }
        : undefined;
      useMessengerStore.getState().appendMessage(convId, {
        id: msgId,
        conversation_id: convId,
        sender_id: 'self',
        type: media.kind,
        content: mediaOpts?.caption ?? '',
        media_mime: media.mimeType,
        media_meta: media.meta ? {...media.meta} : undefined,
        status: 'sending',
        is_encrypted: true,
        created_at: new Date().toISOString(),
        peer: mediaOpts?.peer ?? {userId: '', deviceId: 1},
        expires_at: expiresAtMs,
        reply_to_msg_id:  replyMeta?.msgId,
        reply_to_preview: replyMeta?.preview,
      });

      // MS-10 — refuse an over-cap attachment BEFORE burning an R2 object
      // (there is no delete API) and before minutes of doomed upload on
      // mobile data. The bubble above stays as an honest `failed` row.
      if (media.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
        useMessengerStore.getState().updateMessageStatus(convId, msgId, 'failed');
        throw new Error(
          `file too large to send (${Math.ceil(media.bytes.byteLength / (1024 * 1024))} MB > ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB)`,
        );
      }

      // 1. Encrypt + upload the ciphertext. The returned key/iv NEVER
      //    leave this device except inside the sealed envelope below.
      //    MX-09 — the bubble's determinate ring rides the transient
      //    per-message progress registry; ALWAYS cleared when the upload
      //    leaves flight (finally) so a failed row can't wear a stale ring.
      const {setUploadProgress} = require('../media/uploadProgress') as typeof import('../media/uploadProgress');
      let upload: Awaited<ReturnType<MediaClient['uploadEncrypted']>>;
      setUploadProgress(msgId, 0);
      try {
        upload = await getUploadMediaClient().uploadEncrypted(
          media.bytes, media.mimeType, f => setUploadProgress(msgId, f),
        );
      } catch (e) {
        // P2-12 — durable failed bubble on upload failure. NOTE the retry gap:
        // the plaintext bytes aren't persisted, so the retry chip can't re-upload
        // a failed-UPLOAD row (only a failed-SEND row whose object already exists).
        setUploadProgress(msgId, null);
        useMessengerStore.getState().updateMessageStatus(convId, msgId, 'failed');
        throw e;
      }
      // Why: the success-path clear happens AFTER patchMessageMedia below —
      // the uploading bubble is classified as media via the live progress
      // value, so clearing before the object key lands would flash it
      // through the text branch for a frame.

      // 2. Build the in-band attachment metadata (per-file key/iv + object key).
      const attachment = {
        objectKey: upload.objectKey,
        keyB64:    upload.keyB64,
        ivB64:     upload.ivB64,
        mimeType:  media.mimeType,
        size:      upload.size,
        // `kind` lets the receiver pick image/audio/video rendering even
        // though the wire `type` collapses to 'file'.
        kind:      media.kind,
        // Media-parity (2026-07-03) — optional display hints (filename,
        // dimensions, duration, tiny thumbnail). In-band like key/iv.
        ...(media.meta?.name       !== undefined ? {name:       media.meta.name} : {}),
        ...(media.meta?.width      !== undefined ? {width:      media.meta.width} : {}),
        ...(media.meta?.height     !== undefined ? {height:     media.meta.height} : {}),
        ...(media.meta?.durationMs !== undefined ? {durationMs: media.meta.durationMs} : {}),
        ...(media.meta?.thumbB64   !== undefined ? {thumbB64:   media.meta.thumbB64} : {}),
      } as import('../crypto').SealedAttachment;

      // 3. Stamp the object key + per-file key/iv onto the bubble so the row
      //    mirrored to SQLCipher can be re-rendered/forwarded post-restore.
      useMessengerStore.getState().patchMessageMedia(convId, msgId, {
        type:             attachmentMessageType(attachment),
        media_mime:       attachment.mimeType,
        media_object_key: attachment.objectKey,
        media_key:        attachment.keyB64,
        media_iv:         attachment.ivB64,
        media_meta:       attachmentMediaMeta(attachment),
      });
      setUploadProgress(msgId, null);

      // 4. Ship via the normal send path (crypto + durable outbox + per-recipient
      //    fan-out + grant registration). existingMsgId reuses the bubble above.
      try {
        await runtimeApi.sendText(convId, mediaOpts?.caption ?? '', {
          peer:          mediaOpts?.peer,
          isGroup:       mediaOpts?.isGroup,
          ttlSeconds:    mediaOpts?.ttlSeconds,
          attachment,
          // B-450 — one handoff serves BOTH lanes: sendText already ships the
          // quote on every direct site AND on the group OUTER seal + all three
          // group outbox writers (B-144), so a media reply in a group needs no
          // separate path. Passed raw; sendText applies the same cap.
          replyTo:       mediaOpts?.replyTo,
          existingMsgId: msgId,
        });
      } catch (e) {
        // The R2 object is uploaded and referenced by this (now `failed`) bubble,
        // so the retry chip re-ships it — we must NOT delete it. (An orphaned
        // object is only possible if the store patch above threw; the media client
        // exposes no delete API and an ungranted R2 object is undownloadable and
        // ages out via the bucket lifecycle — reported as a known gap.)
        useMessengerStore.getState().updateMessageStatus(convId, msgId, 'failed');
        throw e;
      }

      // Media-parity G6 (2026-07-03) — seed the sender's own decrypted temp file
      // keyed by the bubble id so rendering our own photo costs zero network and
      // zero decrypts (previously the sender re-downloaded its own R2 upload).
      try {
        const {writeTempBytes} = require('../media/mediaFiles') as typeof import('../media/mediaFiles');
        const {seedResolvedAttachmentUri} = require('../media/useAttachmentUri') as typeof import('../media/useAttachmentUri');
        const tempUri = await writeTempBytes(media.bytes, media.mimeType, msgId);
        seedResolvedAttachmentUri(msgId, tempUri);
      } catch { /* best-effort — the download path still works */ }
    },
    downloadMedia: async ({objectKey, keyB64, ivB64}) => {
      return getUploadMediaClient().downloadEncrypted({objectKey, keyB64, ivB64});
    },

    // ── Incident-evidence reuse seam (Dept Chat v2 · Step 10) ───────────────
    // Thin, additive exposure of the EXISTING media + sealed-sender primitives so
    // the Departmental incident flow can encrypt-upload a photo and seal its
    // per-file key to each manager (and the submitter) WITHOUT a chat message and
    // WITHOUT duplicating the crypto. None of the existing send/receive paths are
    // changed; these just wrap what sendMedia / the outer-ECIES wrap already do.
    uploadEvidence: async (bytes, mimeType) => {
      const up = await getUploadMediaClient().uploadEncrypted(bytes, mimeType);
      return {objectKey: up.objectKey, keyB64: up.keyB64, ivB64: up.ivB64, size: up.size};
    },
    grantMediaAccess: async (objectKey, recipientUserIds) => {
      await mediaClient.registerGrants(objectKey, recipientUserIds);
    },
    sealOuterTo: async (recipientUserId, recipientDeviceId, body) => {
      const peer: SessionAddress = {userId: recipientUserId, deviceId: recipientDeviceId};
      const recipientIdKeyB64 = await recipientIdentityKeyB64Cached(
        ownStore, keys, peer, peerIdentityCache,
      );
      const cert = await certCache.get();
      // Reuse the exact outer-ECIES wrap chat uses; the inner `ciphertext` carries
      // our small JSON ({keyB64, ivB64, mime}) instead of a Signal-session body.
      // `type` is an opaque tag here (no inner session decrypt happens).
      return wrapOuter({
        recipientIdentityKeyB64: recipientIdKeyB64,
        sender:                  ownAddress,
        ciphertext:              {type: 1, body} as Ciphertext,
        cert,
      });
    },
    openOuterAsSelf: async (outerSealedB64) => {
      const idk = await ownStore.getIdentityKeyPair();
      const u = await unwrapOuter({
        ownIdentityPrivKey: idk.privKey,
        ownIdentityPubKey:  idk.pubKey,
        outerSealedB64,
      });
      // v3 binds the sender cert into the GCM AAD — authenticate it before
      // trusting the unsealed payload (mirrors the receive path at line ~3539).
      if (u.senderCert) {
        await verifySenderCert({cert: u.senderCert, authorityPubKeyB64: config.authorityPubKeyB64});
      }
      return u.ciphertext.body;
    },
    processIncoming: async (_conversationId, peer, ct) => {
      // Conversation routing now derives from sealed.group.groupId
      // inside handleIncoming; the legacy parameter is ignored to
      // preserve the runtime interface.
      await handleIncoming(own, ownStore, peer, ct, config);
    },

    // ─── Presence + typing passthroughs ─────────────────────────────
    //
    // All four of these are best-effort: if the socket isn't open they
    // silently drop. Presence snapshots + typing auto-stop on the
    // server side mean a dropped frame will self-correct within seconds.

    subscribePresence: (userIds: string[]) => {
      // Round 7 / presence audit fix #1 — record the subscription
      // intent so we can replay it on reconnect. The wire emit is
      // idempotent server-side so duplicates from this set + a fresh
      // call are harmless.
      // Audit MSG-16 — increment the refcount per peer.
      for (const id of userIds) { presenceSubscriptions.set(id, (presenceSubscriptions.get(id) ?? 0) + 1); }
      try { transport.subscribePresence(userIds); } catch { /* socket not open */ }
    },

    unsubscribePresence: (userIds: string[]) => {
      // Audit MSG-16 — decrement the refcount; only RELEASE (wire-unsubscribe +
      // clearPresence) the peers whose count reached zero, so a Chat closing
      // doesn't blind Home's still-visible row for the same peer.
      const released: string[] = [];
      for (const id of userIds) {
        const next = (presenceSubscriptions.get(id) ?? 0) - 1;
        if (next <= 0) { presenceSubscriptions.delete(id); released.push(id); }
        else { presenceSubscriptions.set(id, next); }
      }
      if (released.length === 0) {return;}
      try { transport.unsubscribePresence(released); } catch { /* socket not open */ }
      // Round 8 / false-active audit fix #1 — purge the store entries
      // we just stopped tracking. Flip to `offline` rather than delete so
      // consumers reading `presence[uid].state` never handle `undefined`.
      try {
        useMessengerStore.getState().clearPresence(released);
      } catch { /* store may be mid-swap during owner switch */ }
    },

    setActivity: (state: 'active' | 'away') => {
      // Round 7 / presence audit fix #2 — remember the latest activity
      // so reconnect handlers can re-assert it without the caller
      // having to track their own state.
      lastActivity = state;
      try { transport.setActivity(state); } catch { /* socket not open */ }
    },

    sendTyping: (peer, state, conversationId) => {
      try {
        // SYNC-6 — attach the opaque per-{sender,recipient} scope tag so
        // the receiver lights exactly one thread. Legacy callers (no
        // conversationId) send the bare frame → receiver fan-out fallback.

        let convTag: string | undefined;
        if (conversationId && peer.userId) {
          const key = isGroupConversation(useMessengerStore.getState(), conversationId)
            ? conversationId
            : DIRECT_CONVERSATION_KEY;
          convTag = typingConversationTag(key, ownAddress.userId, peer.userId);
        }
        transport.send({event: 'typing', data: {to: peer, state, convTag}});
      } catch { /* socket not open */ }
    },

    sendReaction: async (peer, conversationId, targetMsgId, emoji, remove = false) => {
      if (!peer.userId) {return;}
      // XO-1 — expiry rides with each row so a reaction queued through a long
      // offline stretch is re-minted rather than destroyed on arrival.
      const issuedCert = await certCache.getIssued();
      const cert = issuedCert.cert;

      // BS-RX1 — fan a reaction out to EVERY group member, not just one.
      // Previously this sealed a single envelope to `peer`, so in a group
      // chat only one member ever saw the reaction and reaction chips
      // diverged per device. Mirror sendText's group detection +
      // server-authoritative participant list. For a direct chat the
      // recipient set is just [peer].

      const reactionState = useMessengerStore.getState();
      const recipients = reactionRecipients(
        reactionState, conversationId, ownAddress.userId, peer,
      );
      // Audit MSG-02 (2026-07-02): a reaction in a GROUP must carry the group
      // id so the recipient folds it onto the message under the GROUP
      // conversation. Without this the envelope had no `group` hint, so the
      // receiver routed it to the REACTOR's 1:1 slot and applyReaction never
      // found the target (it lives under the groupId slot) — reactions were
      // invisible to everyone but the reactor.
      const reactionIsGroup = isGroupConversation(reactionState, conversationId);

      // Seal + encrypt + send ONE envelope per recipient. aad.to binds
      // the specific recipient per-envelope (Security S1), so this is
      // done inside the loop, not hoisted.
      const sendOneReaction = async (to: SessionAddress): Promise<void> => {
        if (!to.userId) {return;}
        await ensureOutgoingSession(own, keys, to, ownStore);
        // Reactions ride an empty-body sealed envelope whose only payload
        // is the reaction directive. Peer's handleIncoming detects the
        // `reaction` field and folds it onto the target message rather
        // than appending a new bubble.
        const clientMsgId = makeId();
        const sealed = sealPayload(cert, '', {
          reaction: {targetMsgId, emoji, remove},
          // MSG-02 — stamp the group so the receiver routes applyReaction to
          // the group conversation, not the reactor's direct slot.
          ...(reactionIsGroup ? {group: {groupId: conversationId, kind: 'text' as const, clientMsgId}} : {}),
          aad: {to, ts: Date.now()},
        });
        const ct = await own.encrypt(to, sealed);
        const recipientIdKeyB64 = await recipientIdentityKeyB64Cached(ownStore, keys, to, peerIdentityCache);
        const outerSealed = await wrapOuter({
          recipientIdentityKeyB64: recipientIdKeyB64,
          sender:                  ownAddress,
          ciphertext:              ct,
          cert, // P0-1: cert bound into outer AAD
        });
        // Audit MSG-08 (2026-07-02): persist a durable outbox row so a
        // reaction sent while the socket is DOWN isn't lost (previously the
        // WS-throw fell to a swallowed relay.send with no retry — peers never
        // got it). messageId = clientMsgId (no bubble), so the drain's status
        // updates are harmless no-ops; reactions are idempotent on replay.
        if (sqlOutbox) {
          try {
            await sqlOutbox.enqueue({
              clientMsgId,
              conversationId,
              messageId:    clientMsgId,
              peerUserId:   to.userId,
              peerDeviceId: to.deviceId,
              // XO-1 — freshness metadata + the directive, so a stale-cert
              // row is re-minted at drain instead of destroyed on arrival.
              payload:      JSON.stringify(buildReactionSealedOutboxPayload({
                outerSealed,
                certExpSec: issuedCert.expiresAt,
                reaction:   {targetMsgId, emoji, remove},
                group:      reactionIsGroup
                  ? {groupId: conversationId, kind: 'text' as const, clientMsgId}
                  : undefined,
                clientMsgId,
              })),
            });
          } catch { /* enqueue best-effort */ }
        }
        let reactionDelivered = false;
        try {
          transport.send({
            event: 'envelope.send',
            data: {
              to:           to,
              outerSealed,
              clientMsgId,
              // P2-11 — reactions render nothing on the recipient; suppress the
              // killed-app FCM wake so a blocked/muted or dozing device isn't
              // rung by a phantom banner for a non-displayable envelope.
              urgent:       false,
            },
          });
          // P2-11 — do NOT markDelivered on the fire-and-forget WS send: that
          // dropped the durable outbox row before ANY ack, so a half-dead
          // socket (frame buffered, never shipped) silently lost the reaction.
          // Mirror the text path — register a pending entry so handleAccepted
          // deletes the row on the REAL `envelope.accepted`; if the ack never
          // comes, the outbox row survives and the reconnect drain replays it.
          trackPending(clientMsgId, {conversationId, messageId: clientMsgId, peer: to});
        } catch {
          try {
            await relay.send({
              recipient:    to,
              outerSealed,
              clientMsgId,
              urgent:       false,
            });
            reactionDelivered = true;   // HTTP 200 is a real ack
          } catch { /* socket down + HTTP failed — leave the row for drainOutbox */ }
        }
        // Clear the durable row only on a REAL ack (HTTP success here; the WS
        // path defers to handleAccepted). On failure the row stays and the
        // next reconnect drain replays it.
        if (reactionDelivered && sqlOutbox) {
          sqlOutbox.markDelivered(clientMsgId, to.userId, to.deviceId).catch(() => { /* best-effort */ });
        }
      };

      // Best-effort fan-out — one bad recipient (no session, OPK
      // exhausted) must not drop the reaction for everyone else.
      await Promise.allSettled(recipients.map(sendOneReaction));

      // Local echo — reflect the reaction on our side immediately so
      // UI doesn't have to wait for the server round-trip.
      // SYNC-7 — also persist it: updateMessageReactions is store-only, so
      // the sender's own reaction used to evaporate on the next cold boot.
      const store = useMessengerStore.getState();
      const list  = store.messages[conversationId];
      const msg   = list?.find(m => m.id === targetMsgId);
      if (msg) {
        const next = mergeReaction(msg.reactions, 'self', emoji, remove);
        store.updateMessageReactions(conversationId, msg.id, next);
        if (sqlMessages) {
          sqlMessages.upsertCoalesced({...msg, reactions: next});
        }
      }
    },

    sendMessageEdit: async (peer, conversationId, targetMsgId, body, mentions) => {
      const store  = useMessengerStore.getState();
      const target = store.messages[conversationId]?.find(m => m.id === targetMsgId);
      // Re-check the window and the authorship HERE, not just in the UI. An
      // action sheet left open past the deadline, or a stale render, must not
      // be able to ship a directive every recipient would refuse anyway.
      if (!target || !canEditOwnMessage(target)) {
        console.log('[send.edit] refused — not an editable own message');
        return;
      }
      const editedAt = Date.now();
      const clean    = reconcileMentions(body, mentions ?? []);
      await sendMutationDirective({
        peer, conversationId,
        directive: {edit: {targetMsgId, body, editedAt, ...(clean.length ? {mentions: clean} : {})}},
        tag: 'edit',
      });
      // Local echo AFTER the fan-out is queued, mirroring sendReaction: the
      // durable outbox rows are already written, so a crash here still delivers.
      store.applyMessageEdit(conversationId, targetMsgId, body, editedAt, clean);
      const patched = useMessengerStore.getState().messages[conversationId]
        ?.find(m => m.id === targetMsgId);
      if (patched && sqlMessages) {
        sqlMessages.upsertCoalesced(patched);
      }
    },

    sendDeleteForEveryone: async (peer, conversationId, targetMsgId) => {
      const store  = useMessengerStore.getState();
      const target = store.messages[conversationId]?.find(m => m.id === targetMsgId);
      if (!target || !canDeleteForEveryone(target)) {
        console.log('[send.deleteAll] refused — not a deletable own message');
        return;
      }
      // Capture before the tombstone strips them.
      const retractToken = target.retract_token;
      const objectKey    = target.media_object_key;

      await sendMutationDirective({
        peer, conversationId,
        directive: {deleteFor: {targetMsgId, deletedAt: Date.now()}},
        tag: 'deleteAll',
      });

      // Pull any copy still sitting on the relay. A recipient who has not yet
      // drained never receives the original at all, so they never need the
      // directive — this is the only leg that can beat a device that is simply
      // offline. Best-effort: the server answers retracted:false without error
      // once the recipient has pulled.
      if (retractToken) {
        relay.retract(retractToken).catch(() => { /* already pulled / offline */ });
      }
      // A10 parity with the expiry sweeper — drop the local cached ciphertext
      // AND ask the server to hard-delete the R2 object, so a retracted photo
      // is not still re-downloadable with the in-band key inside the 30-day
      // grant window. Owner-checked server-side; a recipient's call 403s
      // harmlessly.
      if (objectKey) {
        if (mediaCache) {
          mediaCache.remove(objectKey).catch(() => { /* LRU catches it */ });
        }
        mediaClient.purge(objectKey).catch(() => { /* non-owner 403 / offline */ });
      }

      store.applyDeleteForEveryone(conversationId, targetMsgId);
      const patched = useMessengerStore.getState().messages[conversationId]
        ?.find(m => m.id === targetMsgId);
      if (patched && sqlMessages) {
        sqlMessages.upsertCoalesced(patched);
      }
    },

    // Audit MSG-05 — drop the durable outbox rows for a message before a
    // tap-to-retry re-sends it under a fresh clientMsgId, so the original
    // envelope isn't ALSO shipped by the next reconnect drain (double delivery).
    discardOutboxForMessage: async (clientMsgId: string) => {
      if (!sqlOutbox) {return;}
      try { await sqlOutbox.deleteByClientMsgId(clientMsgId); }
      catch (e) { console.warn('[messenger.outbox] discardOutboxForMessage failed:', asErrorMessage(e)); }
    },

    // Audit P2-10 — drop EVERY outbox row for a conversation on "Clear chat"
    // so a still-queued (pending/failed) row isn't re-shipped by the next
    // reconnect drain after the user cleared the thread.
    discardOutboxForConversation: async (conversationId: string) => {
      if (!sqlOutbox) {return;}
      try { await sqlOutbox.deleteByConversation(conversationId); }
      catch (e) { console.warn('[messenger.outbox] discardOutboxForConversation failed:', asErrorMessage(e)); }
    },

    resetSessionWith: async (peer: SessionAddress) => {
      try { await own.closeSession(peer); } catch { /* best effort */ }
      const {bundle} = await keys.fetchPeerBundleWithPoolSize(peer.userId);
      await own.initOutgoingSession({
        ...bundle,
        address: {userId: peer.userId, deviceId: peer.deviceId},
      });
      // Reset the cooldown so a subsequent legitimate failure can
      // immediately attempt another rebuild instead of being silenced
      // by the rate limit.
      clearRebuildAttempt(peer);
    },

    getSafetyNumber: async (peer: SessionAddress) => {
      // Prefer the server-side bundle (source of truth post-rotation)
      // and fall back to the locally-cached identity key on transient
      // network failure. Either way, the returned code is over the
      // identity keys themselves — not the conversationId.
      const {idKey: peerKeyB64} = await recipientIdentityKeyB64(ownStore, keys, peer);
      const ownIdentityPair = await ownStore.getIdentityKeyPair();
      return computeSafetyNumber(ownIdentityPair.pubKey, fromBase64(peerKeyB64));
    },

    // Audit P0-I3 / P0-S6 / P0-1 — verification surface. Delegates to
    // the SqlCipher store; methods are no-ops when the store doesn't
    // expose them (e.g. an in-memory store under a test runtime).
    getPeerVerification: async (peer: SessionAddress) => {
      const sql = ownStore as unknown as {
        getPeerVerification?: (addr: string) => Promise<{verifiedAtMs: number; safetyNumberSha256: string} | null>;
      };
      if (!sql.getPeerVerification) {return null;}
      return await sql.getPeerVerification(`${peer.userId}.${peer.deviceId}`);
    },
    markPeerVerified: async (peer: SessionAddress, safetyNumber: string) => {
      const sql = ownStore as unknown as {
        markPeerVerified?: (addr: string, hashHex: string, ts?: number) => Promise<boolean>;
      };
      if (!sql.markPeerVerified) {return false;}
      // SHA-256 the user-confirmed string before persisting. The store
      // enforces 64-char lowercase hex; producing it here keeps the
      // raw safety number out of the trust row (the row only needs to
      // prove the user confirmed THIS specific number, not store it).
      const enc = new TextEncoder().encode(safetyNumber);
      const ab  = enc.buffer.slice(enc.byteOffset, enc.byteOffset + enc.byteLength) as ArrayBuffer;
      const digest = await crypto.subtle.digest('SHA-256', ab);
      const hex = Array.from(new Uint8Array(digest))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
      const ok = await sql.markPeerVerified(`${peer.userId}.${peer.deviceId}`, hex);
      // TOFU send-gate — verifying the safety number implies accepting the
      // (possibly changed) identity, so clear any pending acknowledgement.
      if (ok) { void acknowledgePeerIdentity(peer.userId); }
      return ok;
    },
    clearPeerVerification: async (peer: SessionAddress) => {
      const sql = ownStore as unknown as {
        clearPeerVerification?: (addr: string) => Promise<void>;
      };
      if (!sql.clearPeerVerification) {return;}
      await sql.clearPeerVerification(`${peer.userId}.${peer.deviceId}`);
    },
    /**
     * TOFU send-gate — acknowledge a peer's identity change WITHOUT full
     * safety-number verification (the lighter "accept" action). Clears the
     * pending gate so sends to this peer resume. No-op when the gate is off.
     */
    acknowledgePeerIdentityChange: async (userId: string) => {
      await acknowledgePeerIdentity(userId);
    },
    listIdentityRotations: async (peer: SessionAddress, limit = 50) => {
      const sql = ownStore as unknown as {
        listIdentityRotations?: (addr: string, limit?: number) => Promise<Array<{
          oldKeySha256: string; newKeySha256: string; observedAtMs: number;
        }>>;
      };
      if (!sql.listIdentityRotations) {return [];}
      return await sql.listIdentityRotations(`${peer.userId}.${peer.deviceId}`, limit);
    },

    broadcastGroupCallPresence: async (recipients, presence) => {
      if (!recipients.length) {return;}
      let cert: string;
      try { cert = await certCache.get(); } catch { return; }
      // Round 5 / Security S1 — `sealed` is now per-recipient so the aad
      // can bind the right address. The shared groupCallPresence body
      // is the same; only the outer wrap differs per peer.
      const presenceTs = Date.now();
      // One sealed envelope per recipient, sent through their pairwise
      // Signal session. Failures are logged per-recipient — the rest of
      // the fan-out continues.
      await Promise.all(recipients.map(async userId => {
        if (!userId || userId === ownAddress.userId) {return;}
        const peer: SessionAddress = {userId, deviceId: 1};
        try {
          await ensureOutgoingSession(own, keys, peer, ownStore);
          const sealed = sealPayload(cert, '', {
            groupCallPresence: presence,
            aad: {to: peer, ts: presenceTs},
          });
          const ct = await own.encrypt(peer, sealed);
          const recipientIdKeyB64 = await recipientIdentityKeyB64Cached(ownStore, keys, peer, peerIdentityCache);
          const outerSealed = await wrapOuter({
            recipientIdentityKeyB64: recipientIdKeyB64,
            sender:                  ownAddress,
            ciphertext:              ct,
            cert, // P0-1: cert bound into outer AAD
          });
          try {
            transport.send({
              event: 'envelope.send',
              data: {to: peer, outerSealed, clientMsgId: makeId(), urgent: false},
            });
          } catch {
            await relay.send({recipient: peer, outerSealed, clientMsgId: makeId(), urgent: false});
          }
        } catch (e) {
          console.warn('[messenger] presence broadcast failed', userId, (e as Error).message);
        }
      }));
    },

    createGroupChat: async ({name, members, allowZeroDelivered, allowSolo}) => {
      console.log('[group-create:runtime] start name=', JSON.stringify(name), 'inputMembers=', members);
      const others = Array.from(new Set(members.filter(uid => uid && uid !== ownAddress.userId)));
      console.log('[group-create:runtime] dedup+self-strip otherMembers=', others);
      // Founder QA 2026-08-08 — allowSolo: a dept channel's group may exist
      // with ONLY its admin. Nothing below needs a second member: the master
      // key is generated locally, the fan-out loop simply runs zero times
      // (allowZeroDelivered already tolerates that), and later members are
      // keyed in through the EXISTING add-intent/rekey path — key
      // distribution semantics are unchanged, there is just no one to
      // distribute to yet. Without this, every channel of a fresh workspace
      // showed "Inactive" and refused to open until the founder enrolled
      // someone — from a different screen.
      if (others.length === 0 && !allowSolo) {
        console.warn('[group-create:runtime] no other members — aborting');
        throw new Error('group needs at least one other member');
      }
      // 1. Build a fresh GroupState (new groupId + master key).
      const state = makeNewGroup({
        name,
        owner:         ownAddress.userId,
        ownerDeviceId: signalDeviceId,
        members:       others.map(userId => ({userId, deviceId: 1})),
      });
      const conversationId = state.groupId;
      console.log('[group-create:runtime] state built groupId=', state.groupId, 'masterKeyLen=', state.masterKeyB64.length);
      const store = useMessengerStore.getState();

      // 2. Local state — group + conversation row, set BEFORE the
      // network broadcast so the sender's UI shows the chat instantly
      // even if delivery to peers is slow / partial.
      store.setGroupState(state);
      store.upsertConversation({
        id:            conversationId,
        type:          'group',
        name,
        participants:  [ownAddress.userId, ...others],
        // B-247 part 2 — ordinary user-created groups were left out of the
        // first fix (only the mission Ops Room got a roster), so a call in a
        // normal group still rang only the creator's key-holders.
        rosterUserIds: [ownAddress.userId, ...others],
        unread_count:  0,
        is_muted:      false,
        created_at:    new Date().toISOString(),
        // `peer` is a carry-over from the direct-chat shape — for groups
        // we use the first member as the placeholder address (self for a
        // solo channel group). The real routing is per-member fan-out via
        // broadcastToGroup.
        peer:          {userId: others[0] ?? ownAddress.userId, deviceId: 1},
        session_state: 'fresh',
      });

      // 3. Fan out the admin `create` envelope to every other member
      // via their pairwise Signal session. Receivers' handleIncoming
      // sees `inner.kind === 'admin' + adminAction.type === 'create'`
      // and calls setGroupState + upsertConversation, so the group
      // appears in their inbox. The master key travels in the GroupState
      // payload (admin create is the ONE envelope sent without a
      // master-key wrap, since recipients don't have it yet).
      console.log('[group-create:runtime] local state set, starting fan-out to', others.length, 'member(s)');
      const issuedCert = await certCache.getIssued();
      const cert = issuedCert.cert;
      const sessionLike = own; // SessionManager
      // Round 5 / Security S4 — sign the create envelope with the
      // creator's identity priv key. Receivers verify against the
      // sender cert's senderIdentityKey to detect a cert-leak +
      // member-substitution attack. Identity-key sign is async (curve25519
      // wrapper); cache the result so the per-recipient deliver loop
      // doesn't re-sign N times for the same envelope.
      const creatorIdentity = await ownStore.getIdentityKeyPair();
      const creatorSignature = await signGroupCreate(creatorIdentity.privKey, state);
      let delivered = 0;
      const failures: string[] = [];
      try {
        const r = await broadcastToGroup({
          group:   state,
          self:    ownAddress,
          cert,
          body:    '', // admin envelopes carry zero body
          admin:   {type: 'create', state, creatorSignature},
          session: sessionLike,
          // Pre-encrypt hook: ensure the per-peer Signal session exists
          // before broadcastToGroup tries to encrypt. Critical for the
          // restore + clear-data path where the local store has the
          // identity but no session records yet — libsignal's
          // encrypt() throws "No record for U.D" without one.
          ensureSession: async (peer) => {
            const had = await own.hasSession(peer);
            console.log(`[group-create:runtime] hasSession(${peer.userId}/${peer.deviceId})=${had}`);
            // B-701 — unconditional: ensureOutgoingSession early-returns on a
            // live session, and only IT can consume the rotation flag.
            await ensureOutgoingSession(own, keys, peer, ownStore);
            if (!had) {console.log('[group-create:runtime] X3DH session built for', peer.userId);}
          },
          deliver: async (peer, ct, clientMsgId) => {
            console.log('[group-create:runtime] deliver →', peer.userId, '/', peer.deviceId);
            try {
              await deliverGroupAdminEnvelope({
                peer, cert, certExpSec: issuedCert.expiresAt, ct, clientMsgId,
                groupId: state.groupId,
              });
              delivered += 1;
            } catch (e) {
              const msg = asErrorMessage(e);
              failures.push(`${peer.userId}: ${msg}`);
              console.warn('[group-create:runtime] deliver FAILED to', peer.userId, '—', msg);
            }
          },
        });
        // r.recipients is the count broadcastToGroup ENQUEUED — actual
        // success comes from the delivered counter inside our deliver.
        void r;
      } catch (e) {
        failures.push(asErrorMessage(e));
      }
      console.log('[group-create:runtime] fan-out done delivered=', delivered, 'failures=', failures.length);
      if (delivered === 0) {
        // The local conversation/group state IS kept above — the user can re-share later.
        // D1-d — for dept-channel provisioning (allowZeroDelivered), a 0-delivered fan-out is
        // NOT a failure: the group is valid and must be registered with a STABLE id so it isn't
        // re-forked on every open. Members (who simply had no Signal keys yet) are keyed in later
        // via add-intents / self-heal. Other callers (1:1 group create) still throw as before.
        if (allowZeroDelivered) {
          console.warn('[group-create:runtime] 0 delivered — keeping group (allowZeroDelivered) conversationId=', conversationId);
          return {conversationId, groupId: state.groupId};
        }
        console.warn('[group-create:runtime] no recipients reached, throwing');
        throw new Error(`group create: no member could be reached (${failures.join('; ')})`);
      }
      console.log('[group-create:runtime] OK conversationId=', conversationId, 'groupId=', state.groupId);
      return {conversationId, groupId: state.groupId};
    },

    /**
     * MISSION-GROUP (batch area 5) — bootstrap the E2EE state for a group
     * whose id was ASSIGNED server-side (the mission Ops Room conversation
     * UUID), as opposed to createGroupChat's salt-derived id.
     *
     * Idempotent: if local GroupState already exists for `groupId` this is a
     * NO-OP — re-bootstrapping would mint a second master key and fork the
     * group (the multi-admin key-divergence the audits flagged). The agency
     * device (which owns the room) calls this from the dispatch-room-intent
     * drain BEFORE applying the queued CPO add-intents, so addGroupMember
     * finds a local group to rekey the CPO into instead of throwing
     * "unknown group" (which is why the add-intents sat `pending` forever).
     *
     * Mirrors createGroupChat's signed `create` fan-out, with two deltas:
     *   - the id is taken as given (makeAssignedGroup, no salt derivation);
     *   - zero/partial delivery does NOT throw — the local state must persist
     *     so the CPO adds proceed even if the initial member (client) is
     *     momentarily offline (they get the create on their next sync).
     */
    ensureAssignedGroup: async ({groupId, name, members}) => {
      return runWithGroupAdminLock(groupId, async () => {
        const store = useMessengerStore.getState();
        if (store.groups[groupId]?.masterKeyB64) {
          // Already bootstrapped on this device with a real key — never re-key.
          return {groupId, alreadyExisted: true};
        }
        // Audit G-06 (2026-07-02): before MINTING a fresh key for an
        // externally-assigned id (the mission Ops Room), try to RECOVER the
        // existing key. On a wiped/reinstalled owner device the local-existence
        // check above is empty, so the old code minted a NEW key over the SAME
        // conversationId — forking the room (members keyed under the original
        // key drop the new epoch-0 create via the G1 guard). Fire a key-request
        // to the members and wait briefly; if a reshare lands we adopt the
        // ORIGINAL key instead of forking. Best-effort: if nobody can reshare
        // (all offline, or the reshare is owner-gated and no other owner-device
        // is online — see G-05) we fall through to minting, which is the prior
        // behaviour. NOTE: full recovery for a reinstalled SOLE owner needs
        // either any-admin reshare (G-05) or owner-key backup-restore.
        const others0 = Array.from(new Set(members.filter(uid => uid && uid !== ownAddress.userId)));
        if (others0.length > 0) {
          try {
            await sendKeyRequest(groupId, others0, store.groups[groupId]?.epoch);
            const deadline = Date.now() + 2500;
            while (Date.now() < deadline) {
              await new Promise(r => setTimeout(r, 250));
              if (useMessengerStore.getState().groups[groupId]?.masterKeyB64) {
                console.log('[group-assign] G-06 recovered existing key for', groupId.slice(0, 12), '— not minting a fork');
                return {groupId, alreadyExisted: true};
              }
            }
          } catch (e) {
            console.warn('[group-assign] G-06 key-request pre-mint failed:', asErrorMessage(e));
          }
        }
        const others = others0;
        // 1. Build E2EE state with the externally-assigned id + fresh key.
        const state = makeAssignedGroup({
          groupId,
          name,
          owner:         ownAddress.userId,
          ownerDeviceId: signalDeviceId,
          members:       others.map(userId => ({userId, deviceId: 1})),
        });
        // 2. Local state first so the agency UI + the drain see it instantly
        //    even if the fan-out is slow/partial.
        store.setGroupState(state);
        store.upsertConversation({
          id:            groupId,
          type:          'group',
          name,
          participants:  [ownAddress.userId, ...others],
          // B-247 — participants is about to be narrowed to crypto
          // membership by resolveRosterOverwrite. Keep the TRUE roster
          // for the ring fan-out, which needs no key.
          rosterUserIds: [ownAddress.userId, ...others],
          unread_count:  0,
          is_muted:      false,
          created_at:    new Date().toISOString(),
          peer:          others[0] ? {userId: others[0], deviceId: 1} : {userId: ownAddress.userId, deviceId: signalDeviceId},
          session_state: 'fresh',
        });
        // 3. Fan out the signed admin `create` (carrying the master key) to
        //    the initial members over their pairwise Signal sessions —
        //    identical to createGroupChat. Tolerates zero/partial delivery.
        if (others.length > 0) {
          const issuedCert = await certCache.getIssued();
          const cert = issuedCert.cert;
          const sessionLike = own;
          const creatorIdentity = await ownStore.getIdentityKeyPair();
          const creatorSignature = await signGroupCreate(creatorIdentity.privKey, state);
          let delivered = 0;
          const failures: string[] = [];
          try {
            await broadcastToGroup({
              group:   state,
              self:    ownAddress,
              cert,
              body:    '',
              admin:   {type: 'create', state, creatorSignature},
              session: sessionLike,
              ensureSession: async (peer) => {
                await ensureOutgoingSession(own, keys, peer, ownStore);
              },
              deliver: async (peer, ct, clientMsgId) => {
                try {
                  await deliverGroupAdminEnvelope({
                    peer, cert, certExpSec: issuedCert.expiresAt, ct, clientMsgId,
                    groupId: state.groupId,
                  });
                  delivered += 1;
                } catch (e) {
                  failures.push(`${peer.userId}: ${asErrorMessage(e)}`);
                }
              },
            });
          } catch (e) {
            failures.push(asErrorMessage(e));
          }
          if (delivered === 0 && failures.length > 0) {
            console.warn('[ops-room:bootstrap] create fan-out reached no members (kept local state):', failures.join('; '));
          }
        }
        return {groupId, alreadyExisted: false};
      });
    },

    /**
     * Round 5 / Security S2 — remove a member AND rotate the master
     * key in the same operation. Two-step protocol on the wire:
     *
     *   1. Broadcast `admin: remove` at the current epoch. Recipients
     *      drop the user from their members map and bump epoch E→E+1.
     *      The removed member receives this same envelope and learns
     *      they were ousted (UI can then disable the chat).
     *   2. Broadcast `admin: rekey` at the post-remove epoch (E+1) with
     *      a fresh 32-byte master key. The inner body is master-key-
     *      wrapped under the OLD key so the removed member CAN decrypt
     *      it — they need to learn that the key changed so they don't
     *      keep trying to use the old one — but they do NOT learn the
     *      new key (the rekey body carries the new key in PLAINTEXT
     *      under the OLD master key, so the receiver applies it
     *      locally to bump their state to the new key). After this
     *      epoch every group message body is master-key-wrapped under
     *      the NEW key, which the removed member never sees, so they
     *      can no longer decrypt subsequent messages even passively.
     *
     * Order matters — step 2 fires only AFTER step 1's fan-out
     * resolves so remaining members have already advanced to E+1
     * locally and their parseGroupMessage masterKey lookup matches.
     */
    /**
     * B-289 — rename a group.
     *
     * The emitter the `rename` action never had. Deliberately the SIMPLEST of
     * the admin operations, and the differences from remove/add are all
     * subtractions rather than shortcuts:
     *
     *   - NO rekey. Membership is unchanged, so the master key still binds the
     *     same devices. Rotating a key because a display string changed would
     *     force a redistribution that can partially fail (see the rekey
     *     fan-out below) and buys nothing.
     *   - Fan-out is BEST-EFFORT. A name is not key material: a member who
     *     misses the envelope keeps the old label and re-syncs on their next
     *     group-state refresh. Compare `remove`, which throws at 0 peers
     *     because a missed removal is a security failure. So the local apply
     *     happens even when every peer is unreachable — the alternative is a
     *     rename that silently does nothing while offline.
     */
    renameGroup: async ({groupId, name}) => {
      return runWithGroupAdminLock(groupId, async () => {
        const store = useMessengerStore.getState();
        const cur = store.groups[groupId];
        if (!cur) {throw new Error(`renameGroup: unknown group ${groupId}`);}
        const meAsMember = cur.members[ownAddress.userId];
        if (!meAsMember?.admin) {throw new Error('only admins can rename this group');}
        const clean = normalizeGroupName(name);
        if (!clean) {throw new Error('group name cannot be empty');}
        if (clean === cur.name) {return {newEpoch: cur.epoch};}

        const action = {type: 'rename' as const, name: clean, atEpoch: cur.epoch};
        const issuedCert = await certCache.getIssued();
        const cert = issuedCert.cert;

        const failures: string[] = [];
        try {
          await broadcastToGroup({
            group:   cur,
            self:    ownAddress,
            cert,
            body:    '',
            admin:   action,
            session: own,
            ensureSession: async (peer: SessionAddress) => {
              await ensureOutgoingSession(own, keys, peer, ownStore);
            },
            deliver: async (peer, ct, clientMsgId) => {
              try {
                await deliverGroupAdminEnvelope({
                  peer, cert, certExpSec: issuedCert.expiresAt, ct, clientMsgId, groupId,
                });
              } catch (e) {
                failures.push(`${peer.userId}: ${asErrorMessage(e)}`);
              }
            },
          });
        } catch (e) {
          failures.push(asErrorMessage(e));
        }

        // Apply locally regardless of fan-out. `applyAdminAction` is the SAME
        // reducer every receiver runs, so our state cannot diverge in shape
        // from theirs — and it owns the epoch bump.
        const next = applyAdminAction(cur, action, ownAddress.userId);
        store.setGroupState(next);
        // B-290 — the SAME helper the receive path runs. Nothing reads
        // `groups[id].name` for display, so without this the rename applied to
        // crypto state and stayed invisible. Reads live store state: `store`
        // above was captured before the cert fetch and the fan-out, so it is
        // stale by now.
        applyGroupRenameToUi({
          groupId,
          newName:      clean,
          actorUserId:  ownAddress.userId,
          selfUserId:   ownAddress.userId,
          changedAtIso: new Date(next.updatedAt).toISOString(),
        });
        if (failures.length > 0) {
          console.warn(`[group-rename:runtime] ${failures.length} peer(s) missed the rename; they re-sync on next group-state refresh`);
        }
        return {newEpoch: next.epoch};
      });
    },

    /**
     * B-291 — set or clear the group picture.
     *
     * Shape follows `renameGroup` exactly (admin gate, per-group lock, signed
     * action, no rekey, best-effort fan-out) because it is the same class of
     * change: cosmetic group state that every member must converge on.
     *
     * The only extra step is encrypt-and-upload FIRST. That order matters: if
     * the upload fails we must not broadcast a reference to an object that does
     * not exist, or every member would show a permanently broken picture.
     */
    setGroupPhoto: async ({groupId, imageUri, mimeType}) => {
      return runWithGroupAdminLock(groupId, async () => {
        const store = useMessengerStore.getState();
        const cur = store.groups[groupId];
        if (!cur) {throw new Error(`setGroupPhoto: unknown group ${groupId}`);}
        if (!cur.members[ownAddress.userId]?.admin) {
          throw new Error('only admins can change the group photo');
        }

        // Upload BEFORE the broadcast — see the note above.
        let photo: GroupPhotoRef | null = null;
        if (imageUri) {
          const bytes = await readUriBytes(imageUri);
          const mime = mimeType ?? 'image/jpeg';
          const up = await getUploadMediaClient().uploadEncrypted(bytes, mime);
          // B-292 — GRANT the members download access, before anyone learns the
          // reference exists.
          //
          // Holding the decryption key is NOT sufficient: the media service
          // enforces a per-object grant list, so an ungranted member 403s at the
          // download and falls back to the initials disc forever. That is what
          // shipped in v1.0.172 — the admin could see the photo because the
          // uploader is implicitly allowed, and nobody else could. Every chat
          // attachment path already does this for exactly this reason.
          //
          // Order matters: granting AFTER the broadcast leaves a window where a
          // fast member applies the action, tries to fetch, 403s, and caches
          // nothing — the retry only comes on a later remount.
          try {
            await mediaClient.registerGrants(up.objectKey, Object.keys(cur.members));
          } catch (e) {
            // Fail LOUD rather than shipping a reference nobody can read.
            throw new Error(`group photo access grant failed: ${asErrorMessage(e)}`);
          }
          photo = {
            objectKey: up.objectKey,
            keyB64:    up.keyB64,
            ivB64:     up.ivB64,
            mimeType:  up.mimeType,
            size:      up.size,
            updatedAt: Date.now(),
          };
        }

        const action = {type: 'photo' as const, photo, atEpoch: cur.epoch};
        const issuedCert = await certCache.getIssued();
        const cert = issuedCert.cert;

        const failures: string[] = [];
        try {
          await broadcastToGroup({
            group:   cur,
            self:    ownAddress,
            cert,
            body:    '',
            admin:   action,
            session: own,
            ensureSession: async (peer: SessionAddress) => {
              await ensureOutgoingSession(own, keys, peer, ownStore);
            },
            deliver: async (peer, ct, clientMsgId) => {
              try {
                await deliverGroupAdminEnvelope({
                  peer, cert, certExpSec: issuedCert.expiresAt, ct, clientMsgId, groupId,
                });
              } catch (e) {
                failures.push(`${peer.userId}: ${asErrorMessage(e)}`);
              }
            },
          });
        } catch (e) {
          failures.push(asErrorMessage(e));
        }

        const next = applyAdminAction(cur, action, ownAddress.userId);
        useMessengerStore.getState().setGroupState(next);
        // Same deterministic id every receiver mints, so the thread reads
        // identically on every device instead of double-posting.
        appendGroupPhotoChangedEvent({
          groupId,
          actorUserId:  ownAddress.userId,
          cleared:      photo === null,
          changedAtIso: new Date(next.updatedAt).toISOString(),
          selfUserId:   ownAddress.userId,
        });
        if (failures.length > 0) {
          console.warn(`[group-photo:runtime] ${failures.length} peer(s) missed the photo; they re-sync on next group-state refresh`);
        }
        return {newEpoch: next.epoch};
      });
    },

    removeGroupMember: async ({groupId, removedUserId}) => {
      // Audit P1-G2 — serialise multi-step admin under a per-group lock.
      return runWithGroupAdminLock(groupId, async () => {
      const store = useMessengerStore.getState();
      const cur = store.groups[groupId];
      if (!cur) {throw new Error(`removeGroupMember: unknown group ${groupId}`);}
      // Authorisation: caller must be admin. We're "self" — same gate
      // that applyAdminAction enforces on the receiving side, mirrored
      // locally so a non-admin caller fails fast with a clear error
      // instead of a silent "no peer applied my action".
      const meAsMember = cur.members[ownAddress.userId];
      if (!meAsMember?.admin) {throw new Error('only admins can remove members');}
      if (removedUserId === ownAddress.userId) {
        throw new Error('cannot remove self via removeGroupMember');
      }
      if (!cur.members[removedUserId]) {
        throw new Error(`${removedUserId} is not a member of ${groupId}`);
      }

      const {planRemoveAndRekey} = require('@bravo/messenger-core') as
        typeof import('@bravo/messenger-core');
      const plan = planRemoveAndRekey(cur, removedUserId);

      const issuedCert = await certCache.getIssued();
      const cert = issuedCert.cert;
      const sessionLike = own;

      // Step 1: broadcast `remove` to ALL current members (incl. the
      // user being removed — they need to know they're out). The
      // existing master key is what's wrapping this admin body.
      let removeDelivered = 0;
      const removeFailures: string[] = [];
      const ensureSessionFn = async (peer: SessionAddress): Promise<void> => {
        await ensureOutgoingSession(own, keys, peer, ownStore);
      };
      const deliverFn = async (peer: SessionAddress, ct: Ciphertext, clientMsgId: string): Promise<void> => {
        try {
          await deliverGroupAdminEnvelope({
            peer, cert, certExpSec: issuedCert.expiresAt, ct, clientMsgId,
            groupId,
          });
        } catch (e) {
          throw new Error(asErrorMessage(e));
        }
      };
      try {
        await broadcastToGroup({
          group:         cur,
          self:          ownAddress,
          cert,
          body:          '',
          admin:         plan.remove,
          session:       sessionLike,
          ensureSession: ensureSessionFn,
          deliver: async (peer, ct, clientMsgId) => {
            try { await deliverFn(peer, ct, clientMsgId); removeDelivered += 1; }
            catch (e) { removeFailures.push(`${peer.userId}: ${asErrorMessage(e)}`); }
          },
        });
      } catch (e) {
        removeFailures.push(asErrorMessage(e));
      }
      if (removeDelivered === 0) {
        throw new Error(`remove member: no peer reached (${removeFailures.join('; ')})`);
      }

      // Apply step 1 to OUR local state so the rekey we ship next
      // wraps under the post-remove member set (the removed user is
      // already gone from `cur.members`).
      const stateAfterRemove = applyAdminAction(cur, plan.remove, ownAddress.userId);
      store.setGroupState(stateAfterRemove);
      // B-255 — leave a visible trace on the REMOVER's device. Receivers
      // append the identical row (same deterministic id) when they apply this
      // same `remove` action, so the thread reads the same on every device.
      appendMemberRemovedEvent({
        groupId,
        actorUserId:   ownAddress.userId,
        removedUserId: removedUserId,
        epoch:         stateAfterRemove.epoch,
        selfUserId:    ownAddress.userId,
      });
      /**
       * B-433 — and drop them from the CONVERSATION row, not just crypto state.
       *
       * THIS is the device in the founder's repro: the admin removes someone,
       * then taps Call. `computeRingSet` unions the row's `participants` and
       * `rosterUserIds` with live membership, and `rosterUserIds` is sticky
       * across upserts by design — so the removed user survived in the row and
       * was rung into the very call they had just been removed from. Same
       * helper the receive path uses; one rule, two callers.
       */
      /**
       * Gated on the action having actually applied, mirroring the receive
       * side's `next !== args.existing`. `plan` is built from the `cur`
       * snapshot taken before a cert fetch and a fan-out, so a concurrent
       * inbound admin action can advance the epoch and make this a no-op — in
       * which case `setGroupState` has just re-written `participants`
       * INCLUDING this member, and narrowing the row behind it would drop
       * them from send fan-out while they still hold the key.
       */
      if (stateAfterRemove !== cur) {
        applyMemberRemovalToUi({groupId, removedUserId});
      }

      // Step 2: broadcast `rekey` to the POST-remove member set. The
      // body is encrypted under the OLD master key (which the now-
      // removed user holds — but they no longer get a copy because we
      // fan out using the post-remove member list). The new key inside
      // the body becomes the active master key for everyone who
      // applies this admin action.
      // B-10 — fan out the rekey BEFORE we rotate locally so the host's
      // next message under the new epoch can't outrun the new-epoch key
      // on the remaining members. Wrapped in a retryable closure; the
      // envelope is wrapped under the OLD key (still active here).
      const rekeyFailures: string[] = [];
      const fanOutRekey = async (): Promise<number> => {
        let delivered = 0;
        try {
          await broadcastToGroup({
            group:         stateAfterRemove,
            self:          ownAddress,
            cert,
            body:          '',
            admin:         plan.rekey,
            session:       sessionLike,
            ensureSession: ensureSessionFn,
            deliver: async (peer, ct, clientMsgId) => {
              try { await deliverFn(peer, ct, clientMsgId); delivered += 1; }
              catch (e) { rekeyFailures.push(`${peer.userId}: ${asErrorMessage(e)}`); }
            },
          });
        } catch (e) {
          rekeyFailures.push(asErrorMessage(e));
        }
        return delivered;
      };
      let rekeyDelivered = await fanOutRekey();
      // B-10 — 0-peer redistribution: do NOT silently proceed. Retry once
      // before the new epoch takes effect, then surface if still 0.
      if (rekeyDelivered === 0) {
        rekeyDelivered = await fanOutRekey();
      }
      if (rekeyDelivered === 0) {
        store.setError('Group key update reached no members — they may miss new messages until they refetch');
        console.warn('[group-rekey:runtime] rekey fan-out delivered to 0 peers after retry; remaining members must refetch state');
      } else if (rekeyFailures.length > 0) {
        // A PARTIAL rekey was silent before this: `rekeyFailures` was collected
        // and then never read unless delivery hit exactly zero. So removing one
        // member from a four-person group, where the new key reached two of the
        // three remaining, left the third permanently unable to decrypt — with
        // no signal to anyone. From the user's side that reads as "the group
        // broke / the key is corrupted" right after a kick, which is precisely
        // the report. The local rotation below is fail-CLOSED and deliberate,
        // so the missed member cannot be repaired implicitly: say who missed it.
        const missed = rekeyFailures.map(f => f.split(':')[0]).join(', ');
        store.setError(
          `Group key update did not reach every member (${missed}) — they must reopen the group to resync.`,
        );
        console.warn(
          `[group-rekey:runtime] PARTIAL rekey: delivered=${rekeyDelivered} ` +
          `failed=${rekeyFailures.length} — ${rekeyFailures.join('; ')}`,
        );
      }
      // Even if rekey fan-out failed, locally rotate to the new key so
      // OUR future sends are encrypted under the new key. Any remaining
      // member who didn't receive the rekey envelope will fail to
      // decrypt our next group message and surface a "couldn't decrypt
      // one message" — at which point a manual rejoin / re-send
      // recovers them. This is a deliberate fail-CLOSED choice:
      // continuing to use the OLD key would let the removed member
      // keep reading; better to risk a missed message than a privacy
      // leak.
      const stateAfterRekey = applyAdminAction(stateAfterRemove, plan.rekey, ownAddress.userId);
      store.setGroupState(stateAfterRekey);

      // Audit P0-G2 — drop the OLD master key from the in-process key
      // cache the moment the new key takes effect locally. Without this,
      // the previous CryptoKey sits in keyCache for the entire process
      // lifetime, widening any pre-rekey replay window. Compare base64
      // strings — the key changes from `cur.masterKeyB64` to
      // `stateAfterRekey.masterKeyB64`; dispose only if they actually
      // differ (defensive — if the planner ever emits a no-op rekey,
      // don't evict a still-live key).
      if (cur.masterKeyB64 !== stateAfterRekey.masterKeyB64) {
        disposeGroupKey(cur.masterKeyB64);
      }

      return {newEpoch: stateAfterRekey.epoch};
      }); // runWithGroupAdminLock
    },

    // Audit P1-G4 — voluntary leave + rekey. Mirrors removeGroupMember but the
    // sender removes THEMSELVES (planLeaveAndRekey) and then EXITS the group
    // locally instead of adopting the new key. Best-effort fan-out; the local
    // exit always completes so a user is never stuck in a group they left.
    leaveGroup: async ({groupId}) => {
      return runWithGroupAdminLock(groupId, async () => {
      const store = useMessengerStore.getState();
      const cur = store.groups[groupId];
      if (!cur) {
        // Unknown group — nothing to broadcast; ensure we're out locally.
        store.removeGroupState(groupId);
        return {left: true};
      }
      const others = Object.keys(cur.members).filter(u => u && u !== ownAddress.userId);
      if (!cur.members[ownAddress.userId] || others.length === 0) {
        // Not a member, or the only member — no one to notify / rekey. Drop
        // locally (removeGroupState evicts the key from the cache too).
        store.removeGroupState(groupId);
        return {left: true};
      }

      const {planLeaveAndRekey} = require('@bravo/messenger-core') as
        typeof import('@bravo/messenger-core');
      // Broadcast ONLY the `leave` — NOT the chained rekey. The leaver cannot
      // authorize the post-leave rekey: once the `leave` removes them, the
      // remaining members reject any further admin action signed by a non-member
      // (the rekey would be a silent no-op). True forward-secrecy-on-leave
      // therefore needs a REMAINING admin to rekey after the leave (a separate
      // follow-up); this is the documented best-effort-cooperative-leaver model
      // — the leaver retains the OLD key but voluntarily exits and their client
      // honours it. Membership IS updated for everyone, which is the user-
      // visible behaviour ("X left the group").
      const plan = planLeaveAndRekey(cur, ownAddress.userId);

      const issuedCert = await certCache.getIssued();
      const cert = issuedCert.cert;
      const sessionLike = own;
      const ensureSessionFn = async (peer: SessionAddress): Promise<void> => {
        await ensureOutgoingSession(own, keys, peer, ownStore);
      };
      const deliverFn = async (peer: SessionAddress, ct: Ciphertext, clientMsgId: string): Promise<void> => {
        await deliverGroupAdminEnvelope({
          peer, cert, certExpSec: issuedCert.expiresAt, ct, clientMsgId,
          groupId,
        });
      };

      // Tell the CURRENT members we're leaving (they remove us + advance to
      // E+1). Wrapped under the CURRENT master key (all hold it). Best-effort.
      try {
        await broadcastToGroup({
          group: cur, self: ownAddress, cert, body: '', admin: plan.leave,
          session: sessionLike, ensureSession: ensureSessionFn,
          deliver: async (peer, ct, clientMsgId) => {
            try { await deliverFn(peer, ct, clientMsgId); } catch { /* best-effort — we leave regardless */ }
          },
        });
      } catch (e) {
        console.warn('[group-leave:runtime] leave broadcast failed:', asErrorMessage(e));
      }

      // We're OUT — drop the group entirely. removeGroupState evicts the old
      // key from the cache so nothing local can decrypt with it after exit.
      store.removeGroupState(groupId);
      return {left: true};
      }); // runWithGroupAdminLock
    },

    /**
     * Audit P0-G3 — atomic "add member + rekey" runtime wrapper.
     *
     * Mirrors removeGroupMember exactly: two-step plan, fan-out, local
     * state advance, key dispose. The ONLY sanctioned client-side path
     * to add a member; do not let UI invoke a bare `add` action.
     *
     * Why forward-secrecy matters here:
     *   - A naïve `add` admits the new member at the CURRENT epoch
     *     with the CURRENT master key. From that moment they can
     *     decrypt every queued envelope on the relay (up to 30-day
     *     dwell) AND every sealed-archive row written under the
     *     current key (up to 90-day TTL).
     *   - The chained rekey rotates the key the instant the new
     *     member is in the membership set. After this returns, the
     *     new member can decrypt messages sent under the new key but
     *     not anything from the prior epoch.
     */
    addGroupMember: async ({groupId, newMember}) => {
      // Audit P1-G2 — serialise multi-step admin under the per-group lock.
      return runWithGroupAdminLock(groupId, async () => {
      const store = useMessengerStore.getState();
      const cur = store.groups[groupId];
      if (!cur) {throw new Error(`addGroupMember: unknown group ${groupId}`);}
      // SN-08 — tag admin-path failures with a machine-readable `code` so the
      // UI can render human copy. The MESSAGE TEXT IS DELIBERATELY UNCHANGED:
      // membershipIntents.ts:81, conversationIntents.ts:70 and the drain tests
      // match /already a member of|is not a member of/ to settle benign no-op
      // intents, so rewording here would silently reintroduce the D2-g
      // infinite-retry churn.
      const meAsMember = cur.members[ownAddress.userId];
      if (!meAsMember?.admin) {
        throw Object.assign(new Error('only admins can add members'), {code: 'NOT_ADMIN'});
      }
      if (newMember.userId === ownAddress.userId) {
        throw Object.assign(new Error('cannot add self via addGroupMember'), {code: 'CANNOT_ADD_SELF'});
      }
      if (cur.members[newMember.userId]) {
        throw Object.assign(
          new Error(`${newMember.userId} is already a member of ${groupId}`),
          {code: 'ALREADY_MEMBER'},
        );
      }
      // group-grown-past-send-cap-bricks-sends — enforce the fan-out cap at ADD
      // time, not only on send. The send path refuses a group larger than
      // MAX_GROUP_FANOUT (250) with 'group too large to send'; without this gate
      // the 251st add succeeded and then BRICKED the chat (no message could be
      // sent). Reject the add instead so the group can never enter that state.
      // Must stay in lockstep with MAX_GROUP_FANOUT in the send path below.
      if (Object.keys(cur.members).length >= 250) {
        throw Object.assign(
          new Error('group is at the maximum size (250 members)'),
          {code: 'GROUP_FULL'},
        );
      }

      const {planAddAndRekey} = require('@bravo/messenger-core') as
        typeof import('@bravo/messenger-core');
      const plan = planAddAndRekey(cur, newMember);

      const issuedCert = await certCache.getIssued();
      const cert = issuedCert.cert;
      const sessionLike = own;

      const ensureSessionFn = async (peer: SessionAddress): Promise<void> => {
        await ensureOutgoingSession(own, keys, peer, ownStore);
      };
      const deliverFn = async (peer: SessionAddress, ct: Ciphertext, clientMsgId: string): Promise<void> => {
        try {
          await deliverGroupAdminEnvelope({
            peer, cert, certExpSec: issuedCert.expiresAt, ct, clientMsgId,
            groupId,
          });
        } catch (e) {
          throw new Error(asErrorMessage(e));
        }
      };

      // Step 1: broadcast `add` to the POST-add member set (existing
      // members + new member). The new member needs the add envelope
      // to learn they're in the group AND to apply the membership
      // update locally; existing members need it to advance their
      // local membership set so the subsequent rekey at epoch E+1
      // matches their `applyAdminAction` gate.
      //
      // The body is empty (admin envelopes carry the action, not a
      // text payload) and is master-key-wrapped under the CURRENT
      // key — which all post-add members hold (the new member just
      // received it via X3DH+session-establishment that the caller
      // is responsible for completing before invoking us).
      const stateForAddBroadcast: GroupState = {
        ...cur,
        members: {
          ...cur.members,
          [newMember.userId]: {
            deviceId: newMember.deviceId,
            admin:    false,
            joinedAt: Date.now(),
          },
        },
      };
      let addDelivered = 0;
      const addFailures: string[] = [];
      try {
        await broadcastToGroup({
          group:         stateForAddBroadcast,
          self:          ownAddress,
          cert,
          body:          '',
          admin:         plan.add,
          session:       sessionLike,
          ensureSession: ensureSessionFn,
          deliver: async (peer, ct, clientMsgId) => {
            try { await deliverFn(peer, ct, clientMsgId); addDelivered += 1; }
            catch (e) { addFailures.push(`${peer.userId}: ${asErrorMessage(e)}`); }
          },
        });
      } catch (e) {
        addFailures.push(asErrorMessage(e));
      }
      if (addDelivered === 0) {
        throw new Error(`add member: no peer reached (${addFailures.join('; ')})`);
      }

      // Apply step 1 to OUR local state so the rekey we ship next
      // matches the same epoch.
      const stateAfterAdd = applyAdminAction(cur, plan.add, ownAddress.userId);
      store.setGroupState(stateAfterAdd);
      // SN-11 — leave a visible trace on the ADDER's device. Receivers append
      // the identical row (same deterministic id) when they apply this same
      // `add` action, so the thread reads the same on every device.
      appendMemberAddedEvent({
        groupId,
        actorUserId: ownAddress.userId,
        addedUserId: newMember.userId,
        epoch:       stateAfterAdd.epoch,
        selfUserId:  ownAddress.userId,
      });
      // B-292 — a member added AFTER the group photo was set has no download
      // grant for it, so they would 403 and show the initials disc while
      // everyone else sees the picture. Same defect class as the one this bug
      // was, one step removed. Best-effort: the group photo is cosmetic, so a
      // failed grant must not abort an add that has already been broadcast.
      if (stateAfterAdd.photo?.objectKey) {
        try {
          await mediaClient.registerGrants(stateAfterAdd.photo.objectKey, [newMember.userId]);
        } catch (e) {
          console.warn('[group-photo:runtime] grant for new member failed; they will see the fallback disc:', asErrorMessage(e));
        }
      }

      // Step 2: broadcast `rekey` to the SAME post-add member set,
      // encrypted under the OLD master key (still active locally at
      // this point). All recipients hold the OLD key so they all
      // decrypt — they then rotate forward to the new key.
      // B-10 — fan out the rekey BEFORE we rotate locally so the host's
      // next message under the new epoch can't outrun the new-epoch key.
      // The envelope is wrapped under the OLD key (still active here);
      // recipients hold the OLD key, decrypt the rekey, then rotate
      // forward. Wrap in a retryable closure so a 0-peer fan-out can be
      // re-attempted before the new epoch goes live — same sealed fan-out,
      // no new wire format.
      const rekeyFailures: string[] = [];
      const fanOutRekey = async (): Promise<number> => {
        let delivered = 0;
        try {
          await broadcastToGroup({
            group:         stateAfterAdd,
            self:          ownAddress,
            cert,
            body:          '',
            admin:         plan.rekey,
            session:       sessionLike,
            ensureSession: ensureSessionFn,
            deliver: async (peer, ct, clientMsgId) => {
              try { await deliverFn(peer, ct, clientMsgId); delivered += 1; }
              catch (e) { rekeyFailures.push(`${peer.userId}: ${asErrorMessage(e)}`); }
            },
          });
        } catch (e) {
          rekeyFailures.push(asErrorMessage(e));
        }
        return delivered;
      };
      let rekeyDelivered = await fanOutRekey();
      // B-10 — 0-peer redistribution: do NOT silently proceed. Retry the
      // rekey fan-out once before the new epoch takes effect, then surface
      // if it still reached nobody.
      if (rekeyDelivered === 0) {
        rekeyDelivered = await fanOutRekey();
      }
      if (rekeyDelivered === 0) {
        store.setError('Group key update reached no members — they may miss new messages until they refetch');
        console.warn('[group-add-rekey:runtime] rekey fan-out delivered to 0 peers after retry; members must refetch state');
      } else if (rekeyFailures.length > 0) {
        // Same silent-partial gap as the REMOVE path: collected, never read
        // unless delivery was exactly zero. On add, a member who misses the new
        // epoch key stops being able to read the group from that point on.
        const missed = rekeyFailures.map(f => f.split(':')[0]).join(', ');
        store.setError(
          `Group key update did not reach every member (${missed}) — they must reopen the group to resync.`,
        );
        console.warn(
          `[group-add-rekey:runtime] PARTIAL rekey: delivered=${rekeyDelivered} ` +
          `failed=${rekeyFailures.length} — ${rekeyFailures.join('; ')}`,
        );
      }

      // Locally rotate to the new key regardless of fan-out — same
      // fail-CLOSED reasoning as removeAndRekey. If rekey fan-out
      // failed, peers will surface a decrypt error on our next
      // message and we recover via session-rebuild; preferable to
      // keeping the old key live and admitting the new member
      // (already in our state) to decrypt under it.
      const stateAfterRekey = applyAdminAction(stateAfterAdd, plan.rekey, ownAddress.userId);
      store.setGroupState(stateAfterRekey);

      // Audit P0-G2 — dispose the old key from the in-process cache.
      if (cur.masterKeyB64 !== stateAfterRekey.masterKeyB64) {
        disposeGroupKey(cur.masterKeyB64);
      }

      // RC1 FIX (the #1 structural break) — the `add` + `rekey` envelopes
      // above are BOTH master-key-wrapped, but the NEW member held no
      // prior key, so it can decrypt NEITHER and would be permanently
      // keyless (the old `planAddAndRekey` "new member unwraps the rekey"
      // premise was false). Deliver the post-rekey state to the new member
      // as an UNWRAPPED, signed `admin: create` over their pairwise
      // session — the one carrier a keyless member can read — so they
      // actually receive the CURRENT key. Forward-secrecy holds: the state
      // we ship is post-rekey (the NEW key only), so the new member still
      // cannot decrypt anything from before they joined. Owner-gated +
      // roster-gated inside reshareGroupKeyState (we are the owner here iff
      // we minted this group; for an assigned/ops group the owning device
      // is the one running addGroupMember). Best-effort: a failure here
      // self-heals via the member's key-request on next focus/reconnect.
      try {
        const keyed = await reshareGroupKeyState(stateAfterRekey, [newMember.userId]);
        if (keyed === 0) {
          /**
           * B-640 — THIS IS THE OPS-ROOM "Call failed" SUSPECT. Name the ids.
           *
           * `addGroupMember` RESOLVES here: zero inline key delivery only warns,
           * so the caller sees success. `dispatchRoomIntents` then acks the
           * add-intent on that success path — leaving the new member seated
           * server-side, `done` in the intent queue, and holding NO KEY. A
           * group call from that device then dies at the 25 s key gate and
           * renders the "Call failed" card, while every server-side probe looks
           * perfectly clean (members present, intents done) — which is exactly
           * what the 2026-08-23 investigation found and could not explain.
           *
           * The stated self-heal is NOT guaranteed: `reshareGroupKeyState`
           * drops a target that is not on the SERVER's roster copy, and the
           * serve gate needs owner-or-member — so if this fan-out reached only
           * the sender, that device is the sole possible server of the key
           * (the B-416 SPOF). For an agency-owned mission room that device may
           * never be online while the CPO is testing.
           *
           * ids ONLY — no key material, no epoch, no member set (logAudit).
           * Correlate with the `[dispatch-intents]` warn at the ack site.
           */
          console.warn(
            '[group-add-rekey:runtime] inline key delivery reached 0 recipients',
            'groupId=', groupId, 'memberUserId=', newMember.userId,
          );
        }
      } catch (e) {
        console.warn('[group-add-rekey:runtime] new-member key delivery failed', asErrorMessage(e));
      }
      // Media-parity M4 (2026-07-03) — download grants are a send-time
      // snapshot of the member set, so a member added later 403'd on
      // every pre-join attachment even though drain-on-add shows them
      // the bubbles. registerGrants is additive + owner-checked server-
      // side, so re-granting is safe — but only for objects WE uploaded
      // (a grant call on a peer's object would 403 not_object_owner).
      // Recent-100 cap bounds the burst; fire-and-forget per object.
      try {
        const rows = useMessengerStore.getState().messages[groupId] ?? [];
        const ownMedia = rows.filter(m => m.sender_id === 'self' && m.media_object_key).slice(-100);
        for (const m of ownMedia) {
          void mediaClient.registerGrants(m.media_object_key!, [newMember.userId])
            .catch(e => console.warn('[group-add:runtime] media re-grant failed:', asErrorMessage(e)));
        }
        if (ownMedia.length > 0) {
          console.log(`[group-add:runtime] re-granting ${ownMedia.length} media object(s) to new member ${newMember.userId.slice(0, 8)}`);
        }
      } catch { /* best-effort — pre-join media stays sender-resendable */ }

      return {newEpoch: stateAfterRekey.epoch};
      }); // runWithGroupAdminLock
    },

    // BS-CALL-ADHOC — establish a group master key for an ad-hoc/escalated
    // multi-party call. Reuses the EXACT proven sealed fan-out that
    // createGroupChat uses (makeNewGroup + broadcastToGroup admin/create);
    // no new crypto primitive. Fail-closed: throws if no key can be
    // established so the caller refuses the call rather than going plaintext.
    ensureCallGroupKey: async ({conversationId, recipientUserIds}) => {
      const store = useMessengerStore.getState();
      const others = Array.from(new Set(
        recipientUserIds.filter(uid => uid && uid !== ownAddress.userId),
      ));
      if (others.length === 0) {
        throw new Error('ensureCallGroupKey: no other participants — cannot key an ad-hoc call');
      }

      // B-124 root fix (handoff item 2) — ad-hoc call keys live ONLY under
      // their own minted 32-hex ids; the origin→minted link lives in the
      // callKeyRegistry. `groups[conversationId]` therefore holds a state
      // here only for REAL groups (the legacy resync path below), never a
      // 'Call' carrier.
      const mappedKeyId = resolveCallKeyGroupId(conversationId);
      const mapped = mappedKeyId ? store.groups[mappedKeyId] : undefined;

      // BS-CALL-KEY-RESYNC (registry edition): if THIS device minted a key
      // for this origin before, re-broadcast it to all current recipients —
      // reinstalled devices and fan-out misses receive the correct key at
      // call time. We never mint here — only distribute the existing one.
      //
      // GUARD (BS-CALL-OWNER): only a state we OWN can be re-broadcast (a
      // peer-owned mapping means the PEER hosted last — rebroadcasting it
      // would trip the receiver's owner===sender forgery guard and the key
      // would never land). GUARD (roster): a re-escalation that now rings
      // someone OUTSIDE the minted roster gets a FRESH mint below instead —
      // broadcastToGroup only reaches state.members, so resyncing the old
      // state would silently strand every new invitee keyless.
      if (
        mapped?.masterKeyB64 &&
        mapped.owner === ownAddress.userId &&
        others.every(uid => !!mapped.members[uid])
      ) {
        const issuedCert = await certCache.getIssued();
        const cert = issuedCert.cert;
        const creatorIdentity = await ownStore.getIdentityKeyPair();
        const creatorSignature = await signGroupCreate(creatorIdentity.privKey, mapped);
        let redelivered = 0;
        try {
          await broadcastToGroup({
            group:   mapped,
            self:    ownAddress,
            cert,
            body:    '',
            admin:   {type: 'create', state: mapped, creatorSignature},
            session: own,
            ensureSession: async (peer) => {
              await ensureOutgoingSession(own, keys, peer, ownStore);
            },
            deliver: async (peer, ct, clientMsgId) => {
              try {
                await deliverGroupAdminEnvelope({
                  peer, cert, certExpSec: issuedCert.expiresAt, ct, clientMsgId,
                  groupId: mapped.groupId,
                });
                redelivered += 1;
              } catch (e) {
                console.warn('[call-adhoc-key:runtime] resync delivery failed', peer.userId, asErrorMessage(e));
              }
            },
          });
        } catch (e) {
          console.warn('[call-adhoc-key:runtime] resync broadcast failed', asErrorMessage(e));
        }
        console.log('[call-adhoc-key:runtime] key resynced delivered=', redelivered, 'keyConvo=', mapped.groupId.slice(0, 12));
        // B-362r2 — the reuse lane returns HERE, so the self-handle mapping
        // added at the fresh-mint tail never ran on a re-escalation (every
        // real attempt after the first — the 13:59 repro declined again).
        // Map it on this lane too; recipients address the key as
        // `direct:<HOST>` regardless of which lane distributed it.
        setCallKeyMapping(`direct:${ownAddress.userId}`, mapped.groupId);
        console.warn('[call-adhoc-key:runtime] self-handle mapped for serve path:', `direct:${ownAddress.userId.slice(0, 8)}`, '->', mapped.groupId.slice(0, 12));
        return {keyConversationId: mapped.groupId};
      }

      // Legacy/real-group resync: a state stored AT the conversation id that
      // this device owns (the owner of a real named group re-distributing
      // its own key). Ad-hoc states never live here on fixed builds; the
      // boot sweep purged any pre-fix aliases.
      const existing = store.groups[conversationId];
      if (existing?.masterKeyB64 && existing.owner === ownAddress.userId) {
        const issuedCert = await certCache.getIssued();
        const cert = issuedCert.cert;
        const creatorIdentity = await ownStore.getIdentityKeyPair();
        const creatorSignature = await signGroupCreate(creatorIdentity.privKey, existing);
        let redelivered = 0;
        try {
          await broadcastToGroup({
            group:   existing,
            self:    ownAddress,
            cert,
            body:    '',
            admin:   {type: 'create', state: existing, creatorSignature},
            session: own,
            ensureSession: async (peer) => {
              await ensureOutgoingSession(own, keys, peer, ownStore);
            },
            deliver: async (peer, ct, clientMsgId) => {
              try {
                await deliverGroupAdminEnvelope({
                  peer, cert, certExpSec: issuedCert.expiresAt, ct, clientMsgId,
                  groupId: existing.groupId,
                });
                redelivered += 1;
              } catch (e) {
                console.warn('[call-adhoc-key:runtime] resync delivery failed', peer.userId, asErrorMessage(e));
              }
            },
          });
        } catch (e) {
          console.warn('[call-adhoc-key:runtime] resync broadcast failed', asErrorMessage(e));
        }
        console.log('[call-adhoc-key:runtime] key resynced delivered=', redelivered, 'keyConvo=', conversationId.slice(0, 12));
        return {keyConversationId: conversationId};
      }

      // GUARD (BS-CALL-REALGROUP-MINT / B-15): owner-poison protection.
      // The resync gate above failed, so we don't own the existing state.
      // If conversationId names a REAL named-server group (a stored
      // group/ops_channel row, OR a groups[] entry owned by someone else),
      // we MUST NOT fall through to the mint path: makeNewGroup +
      // setGroupState is a FULL OVERWRITE that would replace the real
      // group's state (owner, name, epoch, master key) with owner=self,
      // name='Call', epoch=0 and a fresh key, then fan that key out —
      // hijacking the real group. The real group's master key is only ever
      // distributed by its real owner via the normal group-create/rekey
      // path. So: reuse the stored real key as-is (no rotation, no
      // overwrite, no fan-out), or fail closed if we lack it.
      const convType = useMessengerStore.getState().conversations[conversationId]?.type;
      const isReal =
        !conversationId.startsWith('direct:') &&
        (convType === 'group' ||
          convType === 'ops_channel' ||
          !!(existing?.masterKeyB64 && existing.owner && existing.owner !== ownAddress.userId));
      if (isReal) {
        if (existing?.masterKeyB64) {
          // Reuse the real owner's distributed key verbatim. No mint, no
          // overwrite, no key fan-out — SFrame derives from the stored key.
          console.log('[call-adhoc-key:runtime] reusing real-group key (non-owner host) keyConvo=', conversationId.slice(0, 12));
          return {keyConversationId: conversationId};
        }
        // We lack the real group's key. Fail closed — never mint over a
        // group owned by another user. The caller (useGroupCall) treats a
        // throw as fail-closed and tears the call down.
        throw new Error('ensureCallGroupKey: missing real-group master key — refusing to mint over a group owned by another user');
      }

      // 1. Mint a fresh group (own master key) for the call participants.
      // #9 (M4-lite) — the ONE builder uses the ONE constant: this name IS
      // the wire discriminator every receiver classifies by.
      const state = makeNewGroup({
        name:          CALL_GROUP_NAME,
        owner:         ownAddress.userId,
        ownerDeviceId: signalDeviceId,
        members:       others.map(userId => ({userId, deviceId: 1})),
      });
      const keyConversationId = state.groupId;

      // 2. Store locally BEFORE fan-out (host can derive keys immediately).
      //    B-124 root fix (handoff item 2) — the state is filed ONLY under
      //    its own minted id. The old `direct:<own>` + originating-1:1
      //    aliases (B-106) are replaced by a callKeyRegistry link written
      //    after the fan-out succeeds: chat-bearing ids never hold a
      //    'Call' carrier again, which is what let the send path misroute
      //    the 1:1 as a group (B-124/B-125).
      //
      //    B-10 (do NOT poison the real group) still holds: nothing here
      //    ever writes over `groups[conversationId]` — for a REAL named
      //    group that slot keeps the real owner's state untouched.
      store.setGroupState(state);

      // 3. Distribute via the same sealed Signal fan-out as createGroupChat.
      const issuedCert = await certCache.getIssued();
      const cert = issuedCert.cert;
      const creatorIdentity = await ownStore.getIdentityKeyPair();
      const creatorSignature = await signGroupCreate(creatorIdentity.privKey, state);
      let delivered = 0;
      const failures: string[] = [];
      try {
        await broadcastToGroup({
          group:   state,
          self:    ownAddress,
          cert,
          body:    '',
          admin:   {type: 'create', state, creatorSignature},
          session: own,
          ensureSession: async (peer) => {
            await ensureOutgoingSession(own, keys, peer, ownStore);
          },
          deliver: async (peer, ct, clientMsgId) => {
            try {
              await deliverGroupAdminEnvelope({
                peer, cert, certExpSec: issuedCert.expiresAt, ct, clientMsgId,
                groupId: state.groupId,
              });
              delivered += 1;
            } catch (e) {
              failures.push(`${peer.userId}: ${asErrorMessage(e)}`);
            }
          },
        });
      } catch (e) {
        failures.push(asErrorMessage(e));
      }
      console.log('[call-adhoc-key:runtime] key distributed delivered=', delivered, 'failures=', failures.length, 'keyConvo=', keyConversationId);
      if (delivered === 0) {
        // Nobody got the key → they can't decrypt our media. Fail closed:
        // tear down the just-minted state and refuse. The registry link is
        // written only on success, so a previous good mapping survives.
        try { store.removeGroupState(keyConversationId); } catch { /* ignore */ }
        throw new Error(`ensureCallGroupKey: key reached no participants (${failures.join('; ')})`);
      }
      // B-124 root fix — file the origin→minted link (direct-shaped origins
      // only; real group ids never reach the mint path) and GC the 'Call'
      // state a previous escalation of this thread left behind (B-106's
      // per-escalation accumulation, now bounded at one per thread).
      if (conversationId !== state.groupId && (conversationId.startsWith('direct:') || convType === 'direct')) {
        const replaced = setCallKeyMapping(conversationId, state.groupId);
        if (replaced) {
          const stale = useMessengerStore.getState().groups[replaced];
          if (isCallGroupState(stale)) {
            try { useMessengerStore.getState().removeGroupState(replaced); } catch { /* ignore */ }
          }
        }
        // B-362 — every RECIPIENT addresses this call's key as
        // `direct:<HOST>` (the name==='Call' receive-side alias, and the
        // B-358 joiner requests under that same handle). The minting host
        // itself never held that mapping, so its key-request serve path
        // resolved the invitee's request to nothing and declined
        // "we hold no state for this group" — the invitee sat at "Joining…"
        // until the 25 s key timeout (device logs 2026-08-01 13:31:43).
        // A host runs one live escalated call at a time, so a plain
        // overwrite is correct on re-escalation; no GC here — the previous
        // minted state stays reachable through its own origin mapping.
        setCallKeyMapping(`direct:${ownAddress.userId}`, state.groupId);
        console.warn('[call-adhoc-key:runtime] self-handle mapped for serve path:', `direct:${ownAddress.userId.slice(0, 8)}`, '->', state.groupId.slice(0, 12));
      }
      return {keyConversationId};
    },

    markRead: (conversationId: string) => {
      // Collect inbound envelopes that haven't been receipted yet.
      // We group by peer because the WS frame is per-peer; in a 1:1
      // chat there's only one group, but a mission group has many.
      const store = useMessengerStore.getState();
      // B-18 — a 1:1 thread's messages can be split across the synthetic
      // `direct:<peer>` slot and a server-UUID row. ChatScreen merges both
      // for display, so mark-read must cover every slot for the peer or the
      // unread badge sticks on whichever slot the user didn't open.
      const slotIds = directConversationSlots(store, conversationId);
      // Audit P1-T3 — honour the user's "Send read receipts" privacy
      // setting. When off, we still flip the LOCAL bubble status so
      // the user's own UI advances past unread, but we MUST NOT
      // emit the WS frame that would tell the sender about it.
      const emitToSender = getReadReceiptsEnabledCached();
      const byPeer = new Map<string, {peer: SessionAddress; envelopeIds: string[]}>();
      for (const slotId of slotIds) {
        const list = store.messages[slotId] ?? [];
        // M-14 — flip the whole slot in ONE store commit; per-message flips
        // each ran the O(all-messages) write-through diff + one SQL txn.
        const flipIds: string[] = [];
        for (const msg of list) {
          if (msg.sender_id === 'self') {continue;}          // we don't receipt our own messages
          if (msg.status === 'read') {continue;}             // already receipted
          if (!msg.envelope_id) {continue;}                  // no id to reference
          const key = `${msg.peer.userId}.${msg.peer.deviceId}`;
          const slot = byPeer.get(key) ?? {peer: msg.peer, envelopeIds: []};
          slot.envelopeIds.push(msg.envelope_id);
          byPeer.set(key, slot);
          flipIds.push(msg.id);
        }
        if (flipIds.length > 0) {
          store.updateMessageStatusBulk(slotId, flipIds, 'read');
        }
      }
      if (!emitToSender) {return;}
      // Audit MSG-06 — if the socket is down, queue the receipt for the
      // reconnect flush instead of dropping it (the local bubble is already
      // 'read', so it will never be re-collected by a future markRead).
      // Audit P2-7 — also queue when the live emit THROWS (half-open
      // socket), and mirror the queue to AsyncStorage so an app kill while
      // offline doesn't permanently lose the receipts.
      const connected = transport.state === 'connected';
      let queuedAny = false;
      for (const {peer, envelopeIds} of byPeer.values()) {
        let sent = false;
        if (connected) {
          try {
            transport.sendReadReceipt(peer, envelopeIds);
            sent = true;
          } catch { /* half-open socket — queue below */ }
        }
        if (!sent) {
          const key = `${peer.userId}.${peer.deviceId}`;
          const slot = pendingReadReceipts.get(key) ?? {peer, envelopeIds: new Set<string>()};
          for (const id of envelopeIds) { slot.envelopeIds.add(id); }
          pendingReadReceipts.set(key, slot);
          queuedAny = true;
        }
      }
      if (queuedAny) {void persistPendingReadReceipts();}
    },

    pullEnvelopes: async (): Promise<RelayPullReport> => {
      // Force-pull the relay queue. ChatScreen calls this on mount and
      // on AppState=active so messages that piled up while the app was
      // frozen show up before the user sees a stale "no messages" view.
      // Fix #4: route through coalescedDrain so a parallel pull from
      // WS-reconnect / AppState-active doesn't fire a third concurrent
      // pull — the inflight Promise is shared.
      //
      // B-703 MR-1 — this still never THROWS (five UI/push callers rely on
      // that), but it now REPORTS. Swallowing the failure silently is what let
      // the killed-app wake retire its placeholder and show nothing for a
      // message it never actually fetched.
      const seqBefore = pullReportSeq;
      try {
        await coalescedDrain();
      } catch (e) {
        // Don't surface as a banner — drain failures are usually
        // transient (brief WS outage). Next AppState active or WS
        // reconnect will retry. Same reasoning as the silent unwrap-
        // fail handling in handleEnvelopeFrame.
        console.warn('[bravo.pullEnvelopes] drain failed:', asErrorMessage(e));
        return failedPullReport();
      }
      // A resolved coalescedDrain does NOT prove a drain ran: the epoch gate
      // returns an already-resolved promise when this runtime is no longer
      // live. Only a report minted by this call's pass may be trusted; a stale
      // one would claim success for a drain that never happened.
      if (pullReportSeq === seqBefore || !lastPullReport) {return failedPullReport();}
      return lastPullReport;
    },

    // B-703 MR-5 — the killed lane awaits this so the process cannot be frozen
    // with the ack POST still queued behind the 200 ms batcher. Never throws:
    // flushAckQueue already swallows per-batch failures (the relay redelivers),
    // and a caller that cannot ack must still finish its own work.
    flushAcks: async (): Promise<void> => {
      try {
        await flushAckQueue(relay);
      } catch (e) {
        console.warn('[bravo.flushAcks] ack flush failed:', asErrorMessage(e));
      }
    },

    loadLinkMessages: async (limit = 60, offset = 0) => {
      // Same guards as loadOlderMessages: no SQL store in loopback/failed
      // boot, and never read through a stale post-logout DB handle.
      if (!sqlMessages) {return [];}
      if (!isOurEpoch()) {return [];}
      try {
        return await sqlMessages.loadLinkMessages(limit, offset);
      } catch (e) {
        console.warn('[bravo.links] load failed:', asErrorMessage(e));
        return [];
      }
    },

    searchMessages: async (query: string, opts: {conversationIds: readonly string[]; limit?: number}) => {
      // Same guards as loadLinkMessages: no SQL store in loopback/failed boot,
      // and never read through a stale post-logout DB handle — a search is the
      // one read whose RESULT is rendered as somebody's message text, so a
      // handle belonging to the previous user is not a degraded answer, it is
      // the wrong person's plaintext.
      if (!sqlMessages) {return [];}
      if (!isOurEpoch()) {return [];}
      try {
        const hits = await sqlMessages.searchContent(query, {
          conversationIds: opts.conversationIds,
          limit: opts.limit ?? 30,
        });
        // Re-checked AFTER the await, for the same reason the guard exists
        // before it: a sign-out can land mid-read.
        return isOurEpoch() ? hits : [];
      } catch (e) {
        // NEVER the query or a body — both are plaintext (logAudit).
        console.warn('[bravo.msgsearch] failed:', asErrorMessage(e));
        return [];
      }
    },

    remapConversation: async (oldId: string, newId: string) => {
      // B-206 — an owner-reactivated department channel gets a fresh group id,
      // orphaning its plaintext history under the old id. Fold in-memory first
      // so the open thread updates instantly, then remap the durable rows so it
      // survives the next boot. Guarded like loadOlderMessages: no SQL store or
      // a stale owner epoch ⇒ skip the DB half (the fold already fixed the view).
      if (!oldId || !newId || oldId === newId) {return;}
      useMessengerStore.getState().migrateConversationMessages(oldId, newId);
      if (sqlMessages && isOurEpoch()) {
        try { await sqlMessages.remapConversation(oldId, newId); }
        catch (e) { console.warn('[bravo.remap] sql failed', oldId, newId, asErrorMessage(e)); }
      }
    },

    loadOlderMessages: async (conversationId: string, limit = 50) => {
      // Round 6 / perf — page older messages from SQLCipher into the
      // store. Boot loads `MAX_HYDRATE_PER_CONVO=200` most-recent rows
      // per chat; this method pulls the next page on scroll-back.
      //
      // No SQL store ⇒ caller is in loopback or the SQLCipher init
      // failed at boot. Either way there's nothing older to load.
      if (!sqlMessages) {return {loaded: 0, exhausted: true};}

      // Round 6 / race fix — bail when our owner epoch is stale. The
      // SQLCipher handle is bound to the previous user's DB; reading
      // through it after logout is at best garbage data on the new
      // user's UI, at worst a "store closed" throw.
      if (!isOurEpoch()) {return {loaded: 0, exhausted: true};}

      const store = useMessengerStore.getState();
      const list = store.messages[conversationId] ?? [];
      // Cursor: the OLDEST row currently in memory. If the conversation
      // has no in-memory rows there's nothing to anchor against — fall
      // back to "no more" rather than dump the whole table.
      if (list.length === 0) {return {loaded: 0, exhausted: true};}
      const oldest = list[0];
      const before = oldest.created_at;
      const beforeId = oldest.id;

      let older: LocalMessage[] = [];
      try {
        older = await sqlMessages.loadOlder(conversationId, before, beforeId, limit);
      } catch (e) {
        console.warn('[bravo.loadOlder] sql failed', conversationId, asErrorMessage(e));
        return {loaded: 0, exhausted: false};
      }

      // Re-check after the await — the user could have signed out
      // mid-read. Don't prepend onto the next user's store.
      if (!isOurEpoch()) {return {loaded: 0, exhausted: true};}

      if (older.length === 0) {return {loaded: 0, exhausted: true};}
      useMessengerStore.getState().prependOlderMessages(conversationId, older);
      // Exhausted iff we got fewer rows than requested (the SQL query
      // is `LIMIT limit`; a partial page means we hit the floor).
      return {loaded: older.length, exhausted: older.length < limit};
    },

    // Audit S7 — caller-identity binding for outgoing `call.offer`. The
    // CallController calls this AFTER createOffer succeeds but BEFORE
    // shipping the offer, so the cert + signature bind the exact frame
    // that goes on the wire. The cert is reused from the same cache the
    // text-send path uses; the signing key is the local Signal identity
    // priv key the cert attests.
    signCallOfferAuth: async ({callId, to, kind}): Promise<CallOfferAuth> => {
      const cert = await certCache.get();
      const ident = await ownStore.getIdentityKeyPair();
      return coreSignCallOfferAuth({
        cert,
        identityPrivKey: ident.privKey,
        callId,
        from: ownAddress,
        to,
        kind,
      });
    },

    // Audit P1-N7 — revoke our currently-cached sender cert on rotation.
    // Best-effort: if the auth-service endpoint isn't deployed yet the
    // call returns `backendMissing: true` and the local cache is still
    // invalidated so subsequent sends mint a fresh cert under the new
    // identity. Never throws — the rotation flow must proceed regardless.
    revokeOwnSenderCert: async (): Promise<{revoked: boolean; backendMissing: boolean}> => {
      try {
        return await certCache.revokeCurrentAndInvalidate();
      } catch {
        return {revoked: false, backendMissing: false};
      }
    },
  };
  // W2 (MESSENGER_STABILITY_PLAN) — send-path probes, WRAPPED at the API
  // boundary so the send pipeline's interior (the M-invariant surface) is
  // byte-identical. Two signals, both release-visible (console.warn):
  //
  //  [LAGDIAG] [send.total] — ONE line per send with total wall ms. The
  //  2026-07-26 per-stage probes fired only above 120ms PER STAGE, which is
  //  provably why the founder's ~150-280ms burst stalls logged nothing:
  //  eight sub-threshold stages sum invisibly. Total-per-send correlates
  //  directly against the [LAGDIAG] JS-thread stall timestamps.
  //
  //  [MSGSTAT] — the founder's reliability bar ("retry <1%, extreme cases
  //  only") as a readable number: sends/failures per minute. ACKs already
  //  surface per-envelope via the existing '[messenger.deliver] ACK ok'
  //  warns, so delivered-rate is derivable from the same logcat.
  //
  // Numbers and counts ONLY — no content, ids at most (logAudit posture).
  {
    const now = (): number =>
      (globalThis as {performance?: {now?: () => number}}).performance?.now?.() ?? Date.now();
    let statSent = 0;
    let statFailed = 0;
    let statWindowStart = 0;
    const origSendText = runtimeApi.sendText.bind(runtimeApi);
    runtimeApi.sendText = async (conversationId, text, peerOrOpts) => {
      const t0 = now();
      let ok = false;
      try {
        const r = await origSendText(conversationId, text, peerOrOpts);
        ok = true;
        return r;
      } finally {
        const ms = Math.round(now() - t0);
        statSent += 1;
        if (!ok) {statFailed += 1;}
        // ≥80ms: below that a send is imperceptible; above it, every send
        // in a burst compounds into the felt stall (measured 150-280ms/send).
        if (ms >= 80 || !ok) {
          console.warn(`[LAGDIAG] [send.total] ms=${ms} ok=${ok} convo=${conversationId.slice(0, 12)}`);
        }
        const t = now();
        if (statWindowStart === 0) {statWindowStart = t;}
        if (t - statWindowStart >= 60_000) {
          console.warn(`[MSGSTAT] window=60s sent=${statSent} failed=${statFailed}`);
          statSent = 0; statFailed = 0; statWindowStart = t;
        }
      }
    };
  }
  return runtimeApi;
}

// ─── helpers ─────────────────────────────────────────────────────────

/**
 * Map a sealed attachment to the local-row `type` that drives the
 * ChatScreen bubble renderer. Prefers the explicit `kind` hint; falls
 * back to sniffing the declared mime so older senders (no `kind`) still
 * render images/audio/video instead of a generic file bubble.
 */
function attachmentMessageType(
  attachment?: {mimeType?: string; kind?: string} | null,
): 'text' | 'image' | 'audio' | 'video' | 'file' {
  if (!attachment) {return 'text';}
  const k = attachment.kind;
  if (k === 'image' || k === 'audio' || k === 'video') {return k;}
  const mime = (attachment.mimeType ?? '').toLowerCase();
  if (mime.startsWith('image/')) {return 'image';}
  if (mime.startsWith('audio/')) {return 'audio';}
  if (mime.startsWith('video/')) {return 'video';}
  return 'file';
}

/**
 * Media-parity (2026-07-03) — map the sealed attachment's optional
 * display metadata onto the LocalMessage row (persisted as
 * media_meta_json, schema v13) so bubbles render instant previews with
 * the right aspect ratio, real filenames, and durations. Returns
 * undefined when the sender shipped none, so pre-metadata envelopes
 * cost nothing.
 */
function attachmentMediaMeta(att?: {
  name?:       string;
  width?:      number;
  height?:     number;
  durationMs?: number;
  thumbB64?:   string;
  size?:       number;
} | null): LocalMessage['media_meta'] {
  if (!att) {return undefined;}
  const {name, width, height, durationMs, thumbB64, size} = att;
  if (name === undefined && width === undefined && height === undefined &&
      durationMs === undefined && thumbB64 === undefined && !size) {
    return undefined;
  }
  return {
    ...(name       !== undefined ? {name} : {}),
    ...(width      !== undefined ? {width} : {}),
    ...(height     !== undefined ? {height} : {}),
    ...(durationMs !== undefined ? {durationMs} : {}),
    ...(thumbB64   !== undefined ? {thumbB64} : {}),
    ...(size ? {sizeBytes: size} : {}),
  };
}

async function publishOwnBundle(
  store: CryptoStore,
  keys: KeysHttpClient,
  ownAddress: SessionAddress,
): Promise<{identityRotated?: boolean; previousIdentityKey?: string}> {
  // Audit P0-I1 — the published SPK keyId is the latest stored, NOT a
  // hardcoded `1`. After a rotation `currentSignedPreKeyId` returns the
  // freshly-minted SPK so the upload carries the rotated key. Pre-
  // rotation installs continue to return 1 (the keyId installIdentity
  // wrote), so the upload shape is unchanged for unrotated users.
  const spkKeyId = await currentSignedPreKeyId(store);
  const bundle = await buildOwnPreKeyBundle(store, ownAddress, spkKeyId);
  // Gather the OPK pool we stored locally in installIdentity (keyIds 1..N).
  const opks: {keyId: number; publicKey: string}[] = [];
  for (let i = 1; i <= 50; i++) {
    const pk = await store.loadPreKey(i);
    if (pk) {opks.push({keyId: i, publicKey: toBase64(pk.pubKey)});}
  }
  const res = await keys.uploadBundle({
    registrationId:  bundle.registrationId,
    identityKey:     bundle.identityKey,
    signedPreKey:    bundle.signedPreKey,
    oneTimePreKeys:  opks,
  });
  // BE-2.1: if even after the upload the server says we're low,
  // replenish in background. Covers the edge case where we reinstall
  // and the server already handed out most of our pre-upload keys.
  if (res.poolSize !== null && res.poolSize !== undefined && res.poolSize < 10) {
    void maybeReplenishOwnOpks(store, keys).catch(() => { /* best-effort */ });
  }
  // Handoff §4.5-2 — thread the server-detected rotation out so the boot
  // call site can purge the relay's dead queue (envelopes wrapped to the
  // superseded identity can never decrypt — the priv key died with the
  // old install). Server-driven on purpose: a restore-from-backup
  // republish presents the restored OLD identity ⇒ identityRotated=false
  // ⇒ no purge (those envelopes ARE decryptable).
  return {identityRotated: res.identityRotated, previousIdentityKey: res.previousIdentityKey};
}

async function ensureOutgoingSession(
  own: SessionManager,
  keys: KeysHttpClient,
  peer: SessionAddress,
  ownStore?: CryptoStore,
): Promise<void> {
  if (await own.hasSession(peer)) {
    // B-701 — a cached session can outlive the peer's IDENTITY: their
    // reinstall regenerates it and the old private key dies with the old
    // install, so every message sealed into this ratchet is dead on
    // arrival. The seal lane (recipientIdentityKeyB64Cached, server-first
    // every ≤8 min) NOTES a suspicion when the server identity differs
    // from the trust row; consume it here ONE-SHOT and rebuild through
    // the B-46 core instead of returning the dead session. The fetch pays
    // one OPK — the X3DH rebuild needs a fresh bundle anyway — and stays
    // OUTSIDE the txn chain (M14 pair 2 / B-140: never hold the global
    // chain across a network round-trip).
    if (ownStore && takePeerRotationSuspected(peerIdentityCacheKey(peer))) {
      try {
        const {bundle, poolSize} = await keys.fetchPeerBundleWithPoolSize(peer.userId);
        await rebuildOutgoingSessionWithBundle(own, ownStore, peer, bundle);
        maybeReplenish(ownStore, keys, poolSize);
        console.warn(`[messenger.rotation] send-side session rebuild peer=${peer.userId.slice(0, 8)} (B-701)`);
      } catch (e) {
        // Offline probe must not EAT the suspicion — re-arm for the next send.
        notePeerRotationSuspected(peerIdentityCacheKey(peer));
        console.warn('[messenger.rotation] send-side rebuild failed - will retry:', asErrorMessage(e).slice(0, 80));
      }
    }
    return;
  }
  const {bundle, poolSize} = await keys.fetchPeerBundleWithPoolSize(peer.userId);
  // M14 pair 2 (B-140) — take the GLOBAL txn chain first. initOutgoingSession
  // grabs a session lock and then reaches the chain underneath via
  // saveIdentity, which is lock-order-inverted against the receive path (that
  // holds the chain and then awaits a session lock inside own.decrypt). Both
  // orders alive at once is the same AB-BA shape that produced B-130 — a
  // message burst silently stopped the receiver until restart, with nothing
  // thrown and nothing logged. Acquiring the chain up front means the nested
  // saveIdentity takes its already-on-chain branch and runs inline.
  //
  // The bundle FETCH deliberately stays OUTSIDE: holding the global chain
  // across a network round-trip would block every receive for its duration —
  // trading a deadlock for a stall, which is not an improvement.
  await runOnTxnChain(() => own.initOutgoingSession({
    ...bundle,
    address: {userId: peer.userId, deviceId: peer.deviceId},
  }), 'send:initOutgoingSession');
  maybeReplenish(ownStore, keys, poolSize);
}

/**
 * B-46 — send-side mirror of `refreshPeerIdentityIfRotated`: the peer's
 * identity changed (their device destroyed our envelope), so the local
 * trusted identity AND the Double-Ratchet session negotiated under it
 * are both dead. Fetch the authority-signed current bundle, overwrite
 * trust, drop the stale session, and run a fresh X3DH. Same trust model
 * as every first-contact send — keys-service is authoritative and the
 * bundle binding is authority-verified inside the client.
 */
async function forceRefreshOutgoingSession(
  own: SessionManager,
  keys: KeysHttpClient,
  peer: SessionAddress,
  ownStore: CryptoStore,
): Promise<string> {
  const {bundle, poolSize} = await keys.fetchPeerBundleWithPoolSize(peer.userId);
  await rebuildOutgoingSessionWithBundle(own, ownStore, peer, bundle);
  maybeReplenish(ownStore, keys, poolSize);
  // AUDIT #5 — hand the authority-verified identity to the caller so the
  // recovery lane can re-seed the peer-identity cache from THIS fetch instead
  // of popping a second OPK (and racing a fallback re-cache) to re-learn it.
  return bundle.identityKey;
}

/**
 * The B-46 rebuild CORE, shared by forceRefreshOutgoingSession (the receive-
 * recovery lane) and ensureOutgoingSession's B-701 send-side rotation
 * consumer. The bundle is fetched by the CALLER, outside the chain.
 */
async function rebuildOutgoingSessionWithBundle(
  own: SessionManager,
  ownStore: CryptoStore,
  peer: SessionAddress,
  bundle: PreKeyBundle,
): Promise<void> {
  const addrKey = `${peer.userId}.${peer.deviceId}`;
  // M14 pair 2 (B-140) — ONE chain acquisition covering the whole rebuild, and
  // AFTER the fetch. Two reasons it wraps all three steps rather than each:
  // splitting them across the chain would let a receive frame observe a
  // half-rotated peer (new identity saved, stale session still present), and
  // taking the session lock first inverts the order against the receive path
  // exactly as in ensureOutgoingSession above.
  await runOnTxnChain(async () => {
    await ownStore.saveIdentity(addrKey, fromBase64(bundle.identityKey));
    // BS-IDKEY (send side) — archive the stale session so libsignal
    // rebuilds from the fresh prekey bundle instead of encrypting into
    // the dead ratchet. Best-effort: no session row is a no-op.
    try { await ownStore.removeSession(addrKey); } catch { /* no session row — fine */ }
    await own.initOutgoingSession({
      ...bundle,
      address: {userId: peer.userId, deviceId: peer.deviceId},
    });
  }, 'send:forceRefreshOutgoingSession');
}

function maybeReplenish(
  ownStore: CryptoStore | undefined,
  keys: KeysHttpClient,
  poolSize: number | null | undefined,
): void {
  // BE-2.1: if the server says OUR peer's pool is low, we don't
  // replenish for them — but the same header is also set on OUR bundle
  // uploads. The caller triggers a self-refill via maybeReplenishOwnOpks
  // on upload response. This branch is reserved for future reciprocal
  // refill logic; keep the wire-up so `poolSize` is not lost.
  if (ownStore && poolSize !== null && poolSize !== undefined && poolSize < 10) {
    void maybeReplenishOwnOpks(ownStore, keys).catch(() => { /* best-effort */ });
  }
}

// recipientIdentityKeyB64 / recipientIdentityKeyB64Cached moved to
// crypto/peerIdentityCache.ts (AUDIT #5) so the cache-key contract and the
// server-only write rule are unit-testable — this file cannot be imported
// under jest.

/**
 * BE-2.1: top up our own one-time pre-key pool when the server
 * reports it's running low. Idempotent — server ignores duplicate
 * keyIds. Runs in background; caller never awaits.
 */
async function maybeReplenishOwnOpks(
  store: CryptoStore,
  keys: KeysHttpClient,
): Promise<void> {
  const REFILL_COUNT = 50;
  // A6 opk-refill-overwrites-live-prekeys — fill from ABOVE the highest
  // occupied keyId, never the first gap. OPKs are POPPED on use, leaving holes
  // in the low range while higher keyIds stay live; the old "first empty slot"
  // probe stopped at the first hole and then filled 50 contiguous ids straight
  // over those still-live higher keyIds, overwriting their private halves while
  // the server kept serving the old publics — so a cold-contact sender who had
  // popped one of them got a PreKeyWhisperMessage that failed X3DH (Bad MAC),
  // losing that contact's first message. The store exposes only loadPreKey, so
  // scan upward tracking the highest id that still exists; stop once we've seen
  // REFILL_COUNT consecutive empties — that confirmed-empty run IS where we
  // fill, so the fill range can never overlap an occupied (live) slot.
  let maxId = 0;
  let consecutiveEmpty = 0;
  let probe = 1;
  while (consecutiveEmpty < REFILL_COUNT) {
    if (await store.loadPreKey(probe)) {
      maxId = probe;
      consecutiveEmpty = 0;
    } else {
      consecutiveEmpty += 1;
    }
    probe += 1;
    if (probe > 1_000_000) {return;} // Defensive — runaway scan.
  }
  const nextId = maxId + 1;
  const fresh: {keyId: number; publicKey: string}[] = [];
  for (let i = 0; i < REFILL_COUNT; i++) {
    const pk = await KeyHelper.generatePreKey(nextId + i);
    await store.storePreKey(pk.keyId, pk.keyPair);
    fresh.push({keyId: pk.keyId, publicKey: toBase64(pk.keyPair.pubKey)});
  }
  const identity  = await store.getIdentityKeyPair();
  const regId     = await store.getLocalRegistrationId();
  // Audit P0-I1 — load the CURRENT signed pre-key, not a hardcoded `1`.
  // After a rotation the stored SPK lives under a higher keyId; the
  // legacy load would silently miss it and fail with "no signature."
  const spkKeyId  = await currentSignedPreKeyId(store);
  const signedSpk = await store.loadSignedPreKey(spkKeyId);
  if (!signedSpk?.signature) {return;}
  await keys.uploadBundle({
    registrationId: regId,
    identityKey:    toBase64(identity.pubKey),
    signedPreKey: {
      keyId:     spkKeyId,
      publicKey: toBase64(signedSpk.pubKey),
      signature: toBase64(signedSpk.signature),
    },
    oneTimePreKeys: fresh,
  });

  // Round 8 — re-mirror the identity backup so the freshly-generated
  // OPK private halves reach the user's encrypted backup. Previously
  // the identity bundle was uploaded ONCE at setup; every subsequent
  // OPK refill (every ~50 sent messages) widened the gap between
  // server-side OPK pool and the privates the user could recover from
  // backup. Result: peers using a post-setup OPK could not be
  // decrypted after restore.
  //
  // Best-effort: if the mirror isn't unlocked, skip silently — the
  // next setupBackup / restoreBackup will overwrite with a current
  // snapshot. Wrapped in a try so a failed re-mirror cannot propagate
  // back into the keys.uploadBundle path.
  try {
    const {refreshIdentityBackup} = require('../backup/identityBackup') as
      typeof import('../backup/identityBackup');
    await refreshIdentityBackup(store);
  } catch (e) {
    // Mirror not loaded, key not unlocked, or network blip — none of
    // these are fatal. The next refresh attempt will succeed.
    console.warn('[bravo.opk] identity-backup refresh skipped:', (e as Error).message);
  }
}

interface FrameDeps {
  own:                    SessionManager;
  ownStore:               CryptoStore;
  pendingByClientMsgId:   Map<string, {
    conversationId: string;
    messageId:      string;
    ackTimer?:      ReturnType<typeof setTimeout>;
    // Bug-hunt #2 — `handleAccepted` reads `entry.peer.userId` to
    // route the durable-outbox `markDelivered` call to the right
    // composite-key row. The runtime-side construction site (line
    // ~377) already populates this, but the type declaration was
    // missing the field, so any future construction site would
    // compile cleanly and NPE at runtime. Pinning here.
    peer:           SessionAddress;
  }>;
  config:                 ProductionConfig;
  relay:                  RelayHttpClient;
  keys:                   KeysHttpClient;
  /** Per-runtime peer identity-key cache — see Fix #11. */
  peerIdentityCache?:     PeerIdentityCache;
  /** Send a 'control: rehandshake' nudge — see sendRehandshakeNudge. */
  rehandshakeNudge:       (peer: SessionAddress) => Promise<void>;
  /**
   * B-46 — sender-side auto-resend when the recipient destroyed our
   * envelope (`envelope.undeliverable`). Optional: the archive-replay
   * dispatcher and loopback runtime don't wire it.
   */
  resendUndeliverable?:   (envelopeId: string) => void;
  /**
   * Pong observer — the AppState gating in Fix #7 needs the most
   * recent pong wall-clock to decide whether the socket is healthy
   * enough to skip the force-reconnect on resume.
   */
  onPong?:                (ts: number) => void;
  /**
   * Durable outbox — handleAccepted deletes the row when the relay
   * confirms acceptance. Optional because the loopback runtime (tests)
   * has no SQLCipher DB.
   */
  outbox?:                SqlOutboxStore | null;
  /**
   * Audit P0-N14 — atomic ratchet+plaintext receive.
   * Sharing the SQLCipher handle lets handleIncoming wrap libsignal's
   * session UPSERT and our plaintext UPSERT in a single BEGIN/COMMIT.
   * Both null on the loopback runtime (in-memory store, no SQLite).
   */
  txnDb?:                 TxnDbHandle | null;
  sqlMessages?:           SqlMessageStore | null;
  /**
   * Audit P0-N6 — persistent receive-side envelope-id dedup. Lives in
   * the same SQLCipher DB as sessions/messages so the markSeen INSERT
   * runs INSIDE the receive transaction. Null on the loopback runtime.
   */
  seenEnvelopes?:         SeenEnvelopeStore | null;
  /**
   * Audit 1:1 P1-1 — sender-cert revocation cache. When fresh, the set
   * is passed to `verifySenderCert` so a revoked jti hard-rejects.
   * When stale (poll has failed for > REVOCATION_FRESHNESS_MS) the
   * receive proceeds without consulting the set — better to accept a
   * possibly-revoked cert than to let an attacker disable revocation
   * enforcement by DoS'ing the revocation-list endpoint. Optional
   * because the loopback runtime + tests don't poll auth-service.
   */
  revokedJtiCache?:       RevokedJtiCache | null;
  /**
   * Bug-hunt #3 — durable stash for group envelopes that arrived
   * before we held the master key for their group (admin create or
   * rekey still in flight). The stash row writes INSIDE the receive
   * txn so the stash, the seen_envelopes row, and the relay ack
   * commit atomically. Null on the loopback runtime.
   */
  pendingGroupEnvelopes?: PendingGroupEnvelopeStore | null;
  /**
   * Bug-hunt #5 follow-through — durable stash for admin actions
   * that arrived out-of-epoch order. Drained on every admin commit
   * that advances local state.
   */
  pendingAdminActions?:   PendingAdminActionStore | null;
}

async function handleServerFrame(frame: ServerFrame, deps: FrameDeps): Promise<void> {
  // Call signalling: route call.offer / call.answer / call.ice /
  // call.hangup to the dispatcher first. If a registered signalling
  // claims the frame we're done; otherwise fall through to the
  // envelope/typing branches below so non-call frames still flow.

  const {dispatchCallFrame} = require('../webrtc/callDispatcher') as typeof import('../webrtc/callDispatcher');
  // Single source of truth for "which frames belong to the call
  // dispatcher" — see callFrameRouter.ts. Adding a new call.* event
  // requires updating that file AND adding a `case` in callDispatcher.
  if (isCallFrame((frame as {event: string}).event)) {
    dispatchCallFrame(frame);
    return;
  }
  // SFU group-call frames — sfu.new-producer / sfu.participant.* —
  // are not in the typed ServerFrame union (they're per-room and
  // dynamic). Route them through sfuDispatcher so the active
  // useGroupCall hook for this room receives them.

  const {dispatchSfuFrame, recordSfuObservedTag, SFU_FRAME_EVENTS} = require('../webrtc/sfuDispatcher') as typeof import('../webrtc/sfuDispatcher');
  if (SFU_FRAME_EVENTS.has((frame as {event: string}).event)) {
    // Audit P0-C3 — feed the per-room observed-tag set from the
    // authoritative SFU broadcasts BEFORE dispatching to the hook.
    // recordGroupCallIdentity rejects any sealed groupCallPresence
    // envelope whose participantTag the SFU has not announced for this
    // room, so a removed/non-member peer can no longer relabel a
    // legitimate member's tile. Runs here because the runtime sees every
    // SFU frame regardless of which useGroupCall handler (full or the
    // reduced restore-path one) is mounted.
    recordSfuObservedTag(frame as never);
    dispatchSfuFrame(frame as never);
    return;
  }
  // Group-call RING frames are global (recipient hasn't joined any room
  // yet, so sfuDispatcher's roomId routing wouldn't fire). Routed here
  // to the global ring handler installed by the navigation root.
  // sfu.muted / sfu.kicked are NOT global — they target a specific
  // already-joined room, so they fall through SFU_FRAME_EVENTS above.

  const {dispatchGroupRingFrame, GROUP_RING_FRAME_EVENTS, setGroupRingAckSender} =
    require('../webrtc/groupCallRingDispatcher') as typeof import('../webrtc/groupCallRingDispatcher');
  if (GROUP_RING_FRAME_EVENTS.has((frame as {event: string}).event)) {
    // B-479 — give the dispatcher a way to confirm a REPLAYED ring. The server
    // no longer deletes a queued ring the instant it replays it; it waits for
    // this ack, so a client that could not present the ring at that moment
    // (most sharply, a socket coming up mid backup-restore) gets it again on
    // the next reconnect instead of losing the call outright.
    setGroupRingAckSender((roomId, roomToken, ringId) => {
      // Resolved LAZILY from the registry rather than captured: the replay
      // arrives on a freshly-reconnected socket, and the transport object is
      // rebuilt across reconnects, so a captured handle would ack over a dead
      // one exactly when it matters.
      const {getLiveTransport} = require('./transportRegistry') as typeof import('./transportRegistry');
      const live = getLiveTransport();
      if (!live) {return;}
      // B-566 round 2 — ringId scopes the server-side settle to THE replayed
      // fan-out this ack owns (a newer queued ring survives a late ack).
      void live.emitWithAck('sfu.ring.ack', {roomId, roomToken, ringId}, 5_000)
        .catch(() => { /* unacked ⇒ the server replays it again. Safe to fail. */ });
    });
    dispatchGroupRingFrame(frame as never);
    return;
  }
  // Finding #8(a) / P2-BR-9 — a group call we were offline for. The server
  // now fans `sfu.ring.missed` on reconnect (analogue to the 1:1
  // `call.missed`); record a "Missed group call" bubble so the Calls log +
  // chat thread show it (WhatsApp parity). Stable id keyed by roomId keeps
  // appendMessage's dedup idempotent across a reconnect replay of the same
  // missed marker.
  if ((frame as {event: string}).event === 'sfu.ring.missed') {
    const d = (frame as {data?: {
      roomId?: string; conversationId?: string;
      callType?: 'voice' | 'video'; from?: {userId?: string; deviceId?: number}; at?: number;
    }}).data;
    if (d?.roomId && d.conversationId) {
      try {
        const {appendMissedGroupCallBubble} = require('../webrtc/useGroupCall') as typeof import('../webrtc/useGroupCall');
        appendMissedGroupCallBubble({
          conversationId: d.conversationId,
          callType:       d.callType === 'video' ? 'video' : 'voice',
          stableId:       `missed-group-${d.roomId}`,
          at:             d.at,
        });
      } catch { /* store / hook module unavailable (tests / early boot) */ }
    }
    return;
  }
  switch (frame.event) {
    case 'pong': {
      // Compute WebSocket round-trip from the timestamp we stamped on
      // the corresponding ping. Publishes into the rttRegistry so the
      // network-latency chip + any other subscribers can paint.
      const ts = frame.data?.ts;
      if (typeof ts === 'number') {

        const {publishRtt} = require('./rttRegistry') as typeof import('./rttRegistry');
        publishRtt(Math.max(0, Date.now() - ts));
      }
      // Fix #7: feed the AppState-resume gating with the most recent
      // pong wall-clock so foreground transitions can skip force-
      // reconnect when the socket is genuinely live.
      deps.onPong?.(Date.now());
      return;
    }
    case 'envelope.accepted':
      return handleAccepted(frame, deps);
    case 'envelope.deliver':
      return handleDeliver(frame, deps);
    case 'envelope.delivered': {
      // B-715 T12/T13 — the ✓✓ instant, previously silent on BOTH ends (the relay
      // logs only the failure of this emit, never its success). `flipped` is the
      // count of bubbles this frame actually advanced, so "the receipt arrived but
      // moved nothing" is distinguishable from "no receipt arrived" — two very
      // different bugs that looked identical in a log.
      const flipped = applyEnvelopeDelivered(frame.data.envelopeId);
      console.warn(
        `[LAGDIAG] [send.delivered] env=${frame.data.envelopeId.slice(0, 8)} flipped=${flipped ?? 0}`,
      );
      return;
    }
    case 'envelope.undeliverable':
      // Handoff §3.6(c) — the recipient acked with disposition
      // 'discarded' (decrypt failure destroyed the message). Flip the
      // bubble to `undelivered` instead of lying with ✓✓.
      applyEnvelopeUndeliverable(frame.data.envelopeId);
      // B-46 — we still hold the plaintext; try ONE automatic re-send
      // against the recipient's CURRENT identity (fresh bundle + X3DH).
      // Recovers messages destroyed by recipient identity churn
      // (reinstall / cleared data / failed restore) without user action.
      deps.resendUndeliverable?.(frame.data.envelopeId);
      return;
    case 'read-receipt': {
      // Peer reports they've read a set of our envelopes. Flip the
      // matching local messages to `read` so the chat shows the
      // double-tick. Match by envelope_id (set on outbound msg via
      // envelope.accepted's response). Best-effort — if we don't
      // recognise an id, the user already cleared that thread.
      //
      // Audit P0-E1 — ownership guard. Two cross-checks before flipping:
      //  (1) `msg.sender_id === 'self'` so a peer can't mark THEIR OWN
      //      message read on our behalf (would otherwise let Eve flip
      //      a message Bob sent us to "read" by guessing the envelope id).
      //  (2) `msg.peer.userId === frame.data.from.userId` so a peer can
      //      only receipt envelopes that travelled through THIS thread —
      //      Eve cannot guess a Bob↔Alice envelope id and confirm its
      //      existence on Alice's device by spoofing a read-receipt
      //      from her own thread.
      // The gateway stamps `from` from the authenticated socket context,
      // so the chain is authenticated end-to-end.
      const store = useMessengerStore.getState();
      const ids = new Set(frame.data.envelopeIds);
      const receipterUid = frame.data.from?.userId;
      if (!receipterUid) {return;}
      // BS-RR1 — ownership guard: the receipter must belong to the thread
      // the message lives in. For a direct chat that's the stored peer;
      // for a group, validate against the participant list (every outbound
      // group row stores peer = participants[0], so the old single-peer
      // match only ever accepted the first member's receipt). See
      // readReceiptAccepted for the full rationale.

      for (const [conversationId, list] of Object.entries(store.messages)) {
        // M-14 — batch all flips for this conversation into one commit.
        const flipIds: string[] = [];
        for (const msg of list) {
          // SYNC-1 — group rows carry one envelope id per recipient; match
          // against the id minted for THIS receipter (strict when the map
          // exists; scalar fallback for legacy/1:1 rows).
          if (!readReceiptEnvelopeMatch({
            envelopeId:  msg.envelope_id,
            envelopeIds: msg.envelope_ids,
            receipterUid,
            ids,
          })) {continue;}
          if (msg.status === 'read') {continue;}
          if (msg.sender_id !== 'self') {continue;}
          if (!readReceiptAccepted({
            state:             store,
            conversationId,
            receipterUid,
            messagePeerUserId: msg.peer?.userId,
          })) {continue;}
          flipIds.push(msg.id);
        }
        if (flipIds.length > 0) {
          // B-116 — attribute the receipt to WHO sent it and let the store
          // derive the scalar: direct rows flip 'read' as before; group
          // rows flip only when EVERY other participant has read
          // (WhatsApp semantics — first-receipt no longer blue-ticks).
          store.recordReadReceipts(conversationId, flipIds, receipterUid, Date.now());
        }
      }
      return;
    }
    case 'typing': {
      // Server forwards typing frames per signal-device; we treat "any
      // device of the peer is typing" as "the conversation is typing".
      // SYNC-6 — frames from an updated peer carry an opaque per-pair
      // `convTag` that resolves to exactly one thread. Tagless frames
      // (older peers / ops-console) still fan out to the direct slot +
      // every shared group, which is why one peer typing could paint
      // "typing…" in every mutual conversation.
      const store = useMessengerStore.getState();
      const senderUid = frame.data.from.userId;
      const isTyping  = frame.data.state === 'start';
      const syntheticId = convoIdFor(frame.data.from);
      // BS-TY1 — also resolve the CANONICAL direct conversation id. Once
      // /conversations/mine sync mints a server-UUID row for a 1:1, the
      // open ChatScreen is keyed by that UUID — but typing frames carry
      // only `from`, so without resolving to the canonical id the
      // indicator was set on `direct:<peer>` and the UUID-keyed screen
      // never lit up. The message receive path already routes through
      // this resolver; the typing path must too.
      const {resolveDirectConversationIdFromState: resolveDirect} =
        require('../store/messengerStore') as typeof import('../store/messengerStore');
      const canonicalId = resolveDirect(store, senderUid);

      // Collect every conversation id this typing frame affects — scoped
      // by the peer's opaque conversation tag when present (SYNC-6); a
      // tagless frame keeps the legacy fan-out.

      const affected = typingAffectedConversationIds(
        store,
        senderUid,
        syntheticId,
        canonicalId,
        frame.data.convTag,
        deps.config.ownUserId,
      );
      for (const convId of affected) {
        // B-117 — track WHO is typing (named group bubbles); the legacy
        // boolean aggregate is derived inside setTypingUser.
        store.setTypingUser(convId, senderUid, isTyping);
        // BS-TY2 — arm a watchdog on `start`, clear it on `stop`, so a
        // dropped `stop` frame can't strand the bubble "typing…" forever.
        // Keyed per (conversation, sender) so one member's expiry can't
        // clear another member's live indicator.
        const wdKey = `${convId}|${senderUid}`;
        if (isTyping) {
          typingWatchdog.arm(wdKey, () => {
            try { useMessengerStore.getState().setTypingUser(convId, senderUid, false); } catch { /* store gone */ }
          });
        } else {
          typingWatchdog.clear(wdKey);
        }
      }
      return;
    }
    case 'presence': {
      // Presence frames arrive both as unsolicited broadcasts (state
      // changes from watched users) and as snapshot emits right after
      // presence.subscribe. Either way we mirror the FULL state into
      // the store so the UI can distinguish `active` (green +
      // "Active now") vs `online` (green) vs `away` (amber). Round 7
      // presence audit fix #7 — previously we collapsed to a boolean
      // and `away` peers showed up as Online.
      // [PRESDIAG] — warn survives release stripping; without this line the
      // whole inbound presence pipeline is invisible on device (B-354 hunt).
      console.warn('[PRESDIAG] inbound', String(frame.data.userId).slice(0, 8), frame.data.state);
      useMessengerStore.getState().setPresence(
        frame.data.userId,
        frame.data.state,
        frame.data.lastSeenMs,
      );
      return;
    }
    case 'error': {
      // B-241 — route every gateway error frame through the shared disposition
      // policy instead of red-barring the chat for every code but 'superseded'.
      // A per-keystroke `rate_limited` typing throttle was leaving a persistent
      // red "Error: rate_limited: event typing rate-limited…" banner on the
      // chat; it (like 'superseded', a newer socket taking over) is benign flow
      // control and must never be shown.
      const code = frame.data.code;
      const disposition = gatewayErrorDisposition(code);
      if (disposition === 'silent') {
        console.log(`[messenger.gateway] ignored benign ${code} error frame`);
        return;
      }
      useMessengerStore.getState().setError(`${code}: ${frame.data.message}`);
      // Call-related errors (peer_offline / busy / declined) are transient — the
      // gateway already queues offline-callee offers and fires a VoIP push, so
      // the call WILL ring once the callee comes back online. Auto-clear after a
      // few seconds so it acts like a brief toast, not a persistent error. Don't
      // clobber a newer error that arrived in the meantime — match the prefix.
      if (disposition === 'auto-clear') {
        setTimeout(() => {
          const store = useMessengerStore.getState();
          if (store.error?.startsWith(code + ':')) {
            store.setError(null);
          }
        }, 3500);
      }
      return;
    }
  }
}

/**
 * Audit MEDIUM-2 (2026-07-02): per-group set of master keys that a same-epoch
 * owner-signed HEAL (G-04) has already SUPERSEDED. Enables a rollback guard:
 * because the G-04 heal accepts any owner-signed same-epoch create with a
 * different key, a malicious member could relay (via G-05) an OLDER captured
 * owner-create to roll a peer back to a key that was already replaced — there
 * is no ordering tiebreaker in the signed create bytes. A key here has been
 * provably retired at its epoch; re-installing it is always a downgrade, so we
 * refuse. Memory-only (per session): the precondition is a same-identity
 * same-epoch fork, and after a restart the group re-converges via self-heal,
 * so a persistent store is not warranted. Bounded per group.
 */
// S5 — the superseded-key ledger moved to runtime/applyGroupAdmin.ts with the
// admin lane it guards. It was duplicated here; two ledgers would each hold
// half the retired keys and the MEDIUM-2 rollback guard would pass a key the
// other copy had already retired.

function handleAccepted(frame: ServerEnvelopeAccepted, deps: FrameDeps): void {
  const entry = deps.pendingByClientMsgId.get(frame.data.clientMsgId);
  if (!entry) {return;}
  // Fix #3: cancel the WS-ack watchdog so it doesn't fire AFTER the
  // server accepted — without this clear, a 5s-late watchdog ran
  // forceReconnect + httpFallback against an envelope that was
  // already 'sent', triggering a duplicate POST /envelopes.
  if (entry.ackTimer) { clearTimeout(entry.ackTimer); }
  const store = useMessengerStore.getState();
  store.updateMessageStatus(entry.conversationId, entry.messageId, 'sent');
  store.updateMessageEnvelopeId(entry.conversationId, entry.messageId, frame.data.envelopeId);
  // B-715 T2b — THE JOIN. This is the only place on the sender where its local
  // `clientMsgId` and the relay's `envelopeId` exist together, and it printed
  // nothing — so the sender's `[LAGDIAG] [send.*]` lines carried no id at all and
  // could not be tied to the server's timeline or to the recipient's, which logs
  // `env=`. One line here makes a single message followable end to end.
  //
  // It is also the ✓ instant: `status: 'sent'` one line above is exactly what the
  // single tick renders, so this stamps T2b and the tick together and the
  // founder's "10:00:00 I see one tick" becomes a real, comparable timestamp.
  console.warn(
    `[LAGDIAG] [send.accepted] clientMsgId=${frame.data.clientMsgId.slice(0, 8)} env=${frame.data.envelopeId.slice(0, 8)}`,
  );
  if (frame.data.retractToken) {
    store.updateMessageRetractToken(entry.conversationId, entry.messageId, frame.data.retractToken);
  }
  deps.pendingByClientMsgId.delete(frame.data.clientMsgId);
  // Durable outbox — relay confirmed via WS; drop the row so the next
  // connect-drain doesn't replay it. Audit P0-N4: composite key resolves
  // to a single 1:1 row (the WS path never carries group sends).
  if (deps.outbox) {
    deps.outbox.markDelivered(frame.data.clientMsgId, entry.peer.userId, entry.peer.deviceId).catch(e =>
      console.warn('[messenger.outbox] markDelivered (WS path) failed:', asErrorMessage(e)));
  }
}

// L16 Envelope-dedup-TOCTOU — envelopes currently being decrypted. wasSeen()
// only reflects markSeen, which commits at the END of the receive txn, so two
// concurrent deliveries of the SAME envelope (relay re-push on reconnect racing
// a drainRelay catch-up, or two rapid reconnects) both pass the wasSeen gate
// and feed the SAME ciphertext to libsignal — one wins the ratchet, the other
// throws bad-MAC and shows a spurious 'message failed to decrypt' banner. The
// in-flight registry drops the concurrent duplicate; the persistent wasSeen()
// store still handles the SEQUENTIAL re-delivery case. B-126 — the registry
// evicts entries held past its stale deadline (a wedged receive frame never
// runs its finally), so redelivery cannot be silently skipped forever.
async function handleDeliver(frame: ServerEnvelopeDeliver, deps: FrameDeps): Promise<void> {
  const envId = frame.data.envelopeId;
  const hold = tryAcquireEnvelope(envId);
  if (hold === 'busy') {
    // A concurrent pass already owns this envelope; it will ack + render (or
    // leave it for the relay to re-push on failure). Dropping here avoids the
    // double-decrypt that burns the ratchet message-key twice.
    return;
  }
  try {
    await handleDeliverInner(frame, deps);
  } finally {
    releaseEnvelope(envId, hold);
  }
}
async function handleDeliverInner(frame: ServerEnvelopeDeliver, deps: FrameDeps): Promise<void> {
  // F-0 (B-693) — [recv.total]: the receive side had ZERO latency probes
  // while the send side has had [send.total] since B-285. One line per live
  // WS envelope (same volume precedent as the B-262 ACK line below). qdepth
  // is sampled at ARRIVAL, before this envelope's own chain frame enqueues.
  // Numbers and truncated ids only (logAudit posture).
  const tR0 = Date.now();
  const qdepth0 = chainPendingCount();
  let tUnwrapR1 = 0;
  let tCertR1 = 0;
  const recvPerf = {chainWaitMs: -1, txnMs: -1};
  // Audit P0-N6 — persistent receive-side dedup. The relay re-pushes
  // every pending envelope on every reconnect (flushPendingOnConnect),
  // and acks can be lost across socket drops or app crashes. Without
  // this gate, the SAME ciphertext would be fed to libsignal a second
  // time on the next connect; the ratchet has already burned the
  // message key, so the retry throws "bad MAC" and corrupts the
  // session. Check BEFORE unwrap/decrypt so we don't waste a cert/AAD
  // verify (and don't touch the ratchet at all).
  // Why: previously a throw from wasSeen() (SQLCipher not yet open on
  // fresh-install race, schema migration in progress, native bridge
  // intermittent failure) would propagate to the outer handleServerFrame
  // catch WITHOUT ever firing the ack. The relay would then re-deliver
  // the same envelope on every reconnect and the user's UI would never
  // render it (because handleIncoming also never ran). Wrap in try/catch
  // so a dedup-store hiccup degrades to "process the envelope normally"
  // — the worst case is a duplicate decrypt attempt, which downstream
  // libsignal already protects against via the message-key dedup.
  let alreadySeen = false;
  if (deps.seenEnvelopes) {
    try {
      alreadySeen = await deps.seenEnvelopes.wasSeen(frame.data.envelopeId);
    } catch (e) {
      crashLog(`[messenger] seenEnvelopes.wasSeen threw env=${(frame.data?.envelopeId ?? '?').slice(0, 8)} err=${asErrorMessage(e).slice(0, 120)}`);
      // Continue — better to re-decrypt than to silently strand the envelope.
    }
  }
  if (alreadySeen) {
    // Re-ack so the relay drops the row from its pending list.
    // Audit P0-N9 — pass the freshly-delivered ackToken so the relay
    // accepts the dedup re-ack even after strict mode flips.
    // Disposition 'delivered': seen ⇒ a prior receive txn committed
    // (rendered or durably stashed) — the device genuinely has it.
    enqueueAck(deps.relay, {envelopeId: frame.data.envelopeId, ackToken: frame.data.ackToken ?? '', disposition: 'delivered'});
    return;
  }
  // Sealed Sender v2: the sender's address travels INSIDE the outer
  // ECIES wrap, AES-GCM-bound to our own identity key. The relay no
  // longer carries any sender hint on the wire.
  let unwrapped;
  try {
    const ownIdentity = await deps.ownStore.getIdentityKeyPair();
    unwrapped = await unwrapOuter({
      ownIdentityPrivKey: ownIdentity.privKey,
      ownIdentityPubKey:  ownIdentity.pubKey,
      outerSealedB64:     frame.data.outerSealed,
    });
  } catch (e) {
    // AUDIT #11 rev-5 (edge) — this try covers a LIVE SQL read
    // (getIdentityKeyPair): a transient local failure (db_closed during a
    // rebuild's handle swap, BUSY, …) says nothing about the envelope,
    // and the 'discarded' ack below hard-deletes it from the relay.
    // Leave it: the rebuilt runtime's pull redelivers and it unwraps fine.
    if (isTransientSqlError(e)) {
      console.warn('[messenger] unwrap aborted by transient local failure — leaving on relay:', asErrorMessage(e));
      return;
    }
    // ONE bad envelope must not flash a global red banner — that surfaces
    // every time the relay redelivers a stale undecryptable row (e.g.
    // envelopes from a peer's previous identity, or queued messages from
    // before a key rotation). Log + ACK so the relay stops redelivering;
    // the user already sees the messages they CAN decrypt.
    // Diagnostic breadcrumb — silent-failure visibility for the
    // "I sent a message, peer never saw it" report. The console.warn
    // below only lands in dev/debug; production phones strip it. Wire
    // through Crashlytics so we can correlate with the user reports.
    crashLog(`[messenger] unwrap-failed envId=${frame.data.envelopeId.slice(0, 8)} err=${asErrorMessage(e).slice(0, 120)}`);
    crashRecord(e instanceof Error ? e : new Error(String(e)), {
      area: 'messenger.unwrap', envelopeId: frame.data.envelopeId.slice(0, 8),
    });
    console.warn('[messenger] envelope unwrap failed (will ack to drop):', asErrorMessage(e));
    // Fix #5 — count toward the "missing-ratchet" telemetry so the
    // restore summary can show how many messages were unrecoverable.
    try {
      const {noteUndecryptable} = require('../backup/sessionRatchetRecovery') as
        typeof import('../backup/sessionRatchetRecovery');
      noteUndecryptable(`deliver-unwrap:${asErrorMessage(e).slice(0, 40)}`);
    } catch { /* fine */ }
    // B-46 — sealed sender means the sender is unknowable here, so no
    // per-conversation placeholder is possible. Count the destruction
    // so MessengerHome can surface "N messages couldn't be decrypted"
    // instead of pure silence.
    try { useMessengerStore.getState().noteUndecryptableDrop(frame.data.envelopeId); } catch { /* store mid-swap — fine */ }
    // 'discarded' — outer unwrap failed; the message is destroyed and the
    // sender is unknown (inside the broken wrap), so no placeholder.
    enqueueAck(deps.relay, {envelopeId: frame.data.envelopeId, ackToken: frame.data.ackToken ?? '', disposition: 'discarded'});
    return;
  }
  tUnwrapR1 = Date.now();

  // Audit P0-1 — pre-decrypt cert verify for v3 wraps. The outer GCM tag
  // has already proved the cert bytes in the wire match the cert the
  // sender used to derive the AAD; here we additionally verify the
  // authority signature, expiry, and (when available) identity-key
  // continuity. If verification fails we DROP the envelope WITHOUT
  // calling own.decrypt — the legacy DecryptError → closeSession path
  // can no longer be coerced by a forged outer envelope.
  //
  // For v2 wraps (no cert in AAD) we fall through to the legacy flow;
  // the cert is still verified inside doHandleIncoming AFTER own.decrypt
  // (existing behaviour). v2 still has the P0-1 attack surface that the
  // sessionWipeProtection band-aid mitigates; v3 closes it at the root.
  // M5 — ONE sender-cert admission decision, shared with drainRelay. This used
  // to be a ~85-line inline copy; the HTTP path carried its own, and the two had
  // already drifted in logging, in the no-keys branch, and in which trust anchor
  // they consulted. Two copies of "is this sender who the authority says they
  // are" is the worst duplication in the file to own. Do NOT re-inline it.
  //
  // The helper DECIDES and never acks: the two paths ack differently (this one
  // returns, the drain `continue`s its loop), so burying a relay call inside a
  // decision function would hide an ack. It also brings M6 with it — a
  // clock-window failure is now leave-on-relay instead of ack-discard, so a
  // momentarily-skewed clock no longer destroys the message permanently.
  const certVerdict = await admitSenderCert(unwrapped, {
    ownStore:           deps.ownStore,
    keys:               deps.keys,
    peerIdentityCache:  deps.peerIdentityCache,
    authorityPubKeyB64: deps.config.authorityPubKeyB64,
    revokedJtis:        deps.revokedJtiCache?.isFresh() ? deps.revokedJtiCache.snapshot() : undefined,
    envelopeId:         frame.data.envelopeId,
    tag:                'ws',
  });
  if (certVerdict.kind === 'leave-on-relay') {return;}
  if (certVerdict.kind === 'ack-discard') {
    enqueueAck(deps.relay, {envelopeId: frame.data.envelopeId, ackToken: frame.data.ackToken ?? '', disposition: 'discarded'});
    return;
  }
  const trustedPeer = certVerdict.trustedPeer;
  tCertR1 = Date.now();

  // Audit 1:1 P1-4 — wrap handleIncoming so any non-rotation throw
  // ACK-drops the envelope. Previously a thrown error escaped to the
  // outer onFrame .catch, the ACK never ran, and the relay redelivered
  // the same broken envelope on every subsequent pull/reconnect — a
  // permanent loop visible only as the global recovery banner cycling.
  //
  // Audit 1:1 P1-5 — also handle `IdentityKeyMismatchError` here (was
  // wired only into `drainRelay`): refetch the keys bundle, save the
  // current identity, retry once. On `unavailable` (keys-service blip)
  // we leave the envelope on the relay so a future drain can retry.
  let handledOk = false;
  let leaveOnRelay = false;
  try {
    await handleIncoming(
      deps.own, deps.ownStore, trustedPeer, unwrapped.ciphertext,
      deps.config, frame.data.envelopeId, deps.keys, deps.rehandshakeNudge,
      deps.peerIdentityCache,
      // Audit P0-N14 — when both are present, handleIncoming wraps the
      // decrypt + message-row UPSERT in a single SQLite transaction.
      deps.txnDb ?? null, deps.sqlMessages ?? null,
      // Audit P0-N6 — markSeen runs INSIDE the same transaction so a
      // mid-flight crash can't leave the dedup row committed without
      // its plaintext counterpart (or vice versa).
      deps.seenEnvelopes ?? null,
      // Bug-hunt #3 — pending-stash threading.
      deps.pendingGroupEnvelopes ?? null,
      deps.pendingAdminActions ?? null,
      // OM-02 — the relay's accept timestamp (display-ordering clamp only).
      frame.data.timestamp,
      recvPerf, // F-0 (B-693) — chain-wait / in-txn split for [recv.total]
    );
    handledOk = true;
  } catch (e) {
    if (e instanceof LeaveOnRelayError) {
      // B-30 — first-message recovery asked to leave this envelope on the
      // relay for a bounded redelivery (the session rebuild was kicked off in
      // handleIncoming). Reuse the existing leaveOnRelay ack-skip below.
      leaveOnRelay = true;
    } else if (isTransientSqlError(e)) {
      // Audit P0-1(b) — transient LOCAL SQL failure (nested-txn collision,
      // SQLITE_BUSY/locked, disk I/O pressure). The receive txn rolled back
      // (no ratchet advance) and the relay still holds a deliverable copy,
      // so a local hiccup must NEVER ack-`discarded` (destroy) the message.
      // Skip the ack; the relay redelivers on the next drain/reconnect.
      crashLog(`[messenger] ws-handle transient-sql leave-on-relay env=${frame.data.envelopeId.slice(0, 8)} err=${asErrorMessage(e).slice(0, 120)}`);
      // B-126 — crashLog is Crashlytics-only; this class stranding messages
      // was completely invisible in logcat. warn survives release stripping.
      console.warn(`[messenger] ws transient-sql leave-on-relay env=${frame.data.envelopeId.slice(0, 8)}:`, asErrorMessage(e).slice(0, 120));
      leaveOnRelay = true;
    } else if (e instanceof IdentityKeyMismatchError && deps.keys) {
      const {refreshPeerIdentityIfRotated} = require('../crypto/peerIdentityRefresh') as
        typeof import('../crypto/peerIdentityRefresh');
      const outcome = await refreshPeerIdentityIfRotated(
        e.claims.senderUserId,
        e.claims.senderSignalDeviceId,
        e.claims.senderIdentityKey,
        deps.keys,
        deps.ownStore,
      );
      crashLog(`[messenger] ws-identity-rotation env=${frame.data.envelopeId.slice(0, 8)} outcome=${outcome.result} reason=${outcome.reason ?? '-'}`);
      if (outcome.result === 'refreshed' && outcome.sessionReset) { void notePeerIdentityChanged(e.claims.senderUserId); }
      if (outcome.result === 'refreshed') {
        try {deps.peerIdentityCache?.delete(peerIdentityCacheKey({userId: e.claims.senderUserId, deviceId: e.claims.senderSignalDeviceId}));} catch { /* ignore */ }
        // BS-IDKEY — surface the rotation (safety-number-changed model).
        if (outcome.sessionReset) {
          try {
            useMessengerStore.getState().setError(
              'A contact’s security code changed — their messages will resume on a new secure session.',
            );
          } catch { /* ignore */ }
        }
        try {
          await handleIncoming(
            deps.own, deps.ownStore, trustedPeer, unwrapped.ciphertext,
            deps.config, frame.data.envelopeId, deps.keys, deps.rehandshakeNudge,
            deps.peerIdentityCache,
            deps.txnDb ?? null, deps.sqlMessages ?? null,
            deps.seenEnvelopes ?? null,
            deps.pendingGroupEnvelopes ?? null,
            deps.pendingAdminActions ?? null,
            frame.data.timestamp,
            recvPerf, // F-0 (B-693) — retry overwrites; the line reports the pass that landed
          );
          handledOk = true;
        } catch (e2) {
          // BS-IDKEY — EXPECTED when sessionReset fired: this envelope was
          // sealed to the now-archived ratchet so it can't decrypt. Drop
          // it (ack below proceeds) — the session is reset, so subsequent
          // messages rebuild + deliver. A non-reset failure stays a soft
          // drop as before.
          if (outcome.sessionReset) {
            crashLog(`[messenger] ws rotation env=${frame.data.envelopeId.slice(0, 8)} dropped (sealed to archived ratchet) — session reset, future msgs ok`);
            // Destroyed (sealed to the archived ratchet) — honest disposition.
            noteDestroyedEnvelope({envelopeId: frame.data.envelopeId, reason: 'rotation-archived-ratchet'});
            handledOk = true;
          } else if (isTransientSqlError(e2)) {
            // Audit P0-1(b) — local storage hiccup on the retry too:
            // leave on relay, never destroy.
            crashLog(`[messenger] ws post-refresh transient-sql leave-on-relay env=${frame.data.envelopeId.slice(0, 8)}`);
            leaveOnRelay = true;
          } else {
            crashLog(`[messenger] ws post-refresh handle failed env=${frame.data.envelopeId.slice(0, 8)} err=${asErrorMessage(e2).slice(0, 120)}`);
          }
        }
      } else if (outcome.result === 'unavailable') {
        // keys-service blip — leave on relay for a future drain.
        leaveOnRelay = true;
      } else {
        // stale-cert / no-change — drop.
        crashLog(`[messenger] ws identity-mismatch dropped env=${frame.data.envelopeId.slice(0, 8)} reason=${outcome.reason ?? '?'}`);
      }
    } else {
      // Non-rotation failure (cert reject, AAD reject, bad MAC, etc.).
      // Drop the envelope so the relay stops redelivering. Same posture
      // as drainRelay's catch-all branch.
      crashLog(`[messenger] ws-handle-failed env=${frame.data.envelopeId.slice(0, 8)} err=${asErrorMessage(e).slice(0, 120)}`);
      // B-30 — telemetry parity with drainRelay's catch-all (the WS path was
      // blind to these drops on vc78). Count genuinely-unexpected throws that
      // reach the catch-all so they're diagnosable rather than silent.
      try {
        const {noteUndecryptable} = require('../backup/sessionRatchetRecovery') as
          typeof import('../backup/sessionRatchetRecovery');
        noteUndecryptable(`ws-handle:${asErrorMessage(e).slice(0, 40)}`);
      } catch { /* recovery module not loaded — fine */ }
    }
  }
  // F-0 (B-693) — the [recv.total] line. Fires once per live WS envelope,
  // AFTER the handle outcome is known and BEFORE the ack (so a wedged ack
  // path cannot eat the reading). Legs: unwrap (wasSeen + ECIES), cert
  // (authority verify), chainWait (queued behind the global txn chain),
  // txn (decrypt + persist, commit excluded — total minus the legs is the
  // commit + glue). qdepth = frames already on the chain at arrival.
  {
    const recvMs = Date.now() - tR0;
    console.warn(
      '[LAGDIAG] [recv.total] ms=' + recvMs +
      ' unwrap=' + (tUnwrapR1 > 0 ? tUnwrapR1 - tR0 : -1) +
      ' cert=' + (tCertR1 > 0 && tUnwrapR1 > 0 ? tCertR1 - tUnwrapR1 : -1) +
      ' chainWait=' + recvPerf.chainWaitMs +
      ' txn=' + recvPerf.txnMs +
      ' qdepth=' + qdepth0 +
      ' ok=' + handledOk +
      ' env=' + frame.data.envelopeId.slice(0, 8),
    );
  }
  // ACK only after we've successfully decrypted + stored, OR after we
  // decided to ack-drop (cert/AAD reject etc.). Audit P1-4 — never
  // skip the ACK on a verify failure, only on `unavailable` rotation
  // where the next drain will reasonably retry.
  if (!leaveOnRelay) {
    // Handoff §3.6(c) — ack-for-delete vs delivered-signal. `handledOk`
    // false (unrecoverable throw) or a destroyed-note from the deep path
    // (AAD reject / tamper-final / recovery give-up) means the message
    // will NEVER render here: ack 'discarded' so the relay emits
    // `envelope.undeliverable` instead of the ✓✓ `envelope.delivered`.
    // Stash branches leave no note — the device durably holds those, so
    // 'delivered' stays honest.
    const destroyedInfo = takeDestroyedEnvelope(frame.data.envelopeId);
    const disposition = ackDispositionFor(handledOk, !!destroyedInfo);
    try {
      enqueueAck(deps.relay, {envelopeId: frame.data.envelopeId, ackToken: frame.data.ackToken ?? '', disposition});
      // B-262 — warn, not log. An ack is the point of NO RETURN: the relay
      // hard-deletes the envelope, so a message that is acked and then not
      // rendered is gone from the server for good and only this line says
      // which branch took it. `console.log` is stripped from release builds
      // (babel transform-remove-console keeps error/warn only), so on the
      // 2026-07-26 loss the QA build carried no record at all — server
      // forensics could prove the envelope was acked and deleted, but not
      // whether the device claimed 'delivered' or 'discarded'. That one bit
      // is the difference between "stashed and never surfaced" and "terminal
      // decrypt failure whose auto-resend missed", and it cost the whole
      // diagnosis. One line per received envelope is a fair price.
      console.warn('[messenger.deliver] ACK ok envId=' + frame.data.envelopeId.slice(0, 8) + ' handled=' + handledOk + ' disposition=' + disposition);
    } catch (e) {
      // Non-fatal — the envelope will redeliver on next pull. But log it
      // so a silent ack failure (token race, 401, 429, network) is
      // visible in JS console / Crashlytics rather than vanishing into
      // the void.
      console.warn('[messenger.deliver] ACK FAILED envId=' + frame.data.envelopeId.slice(0, 8) + ' err=' + asErrorMessage(e));
    }
  } else {
    // Why: previously `leaveOnRelay=true` meant we INTENTIONALLY skip
    // the ack so the next reconnect re-fetches the envelope after the
    // keys-service blip clears. But if that blip is permanent (peer
    // identity genuinely changed and the registry never updates), the
    // envelope re-delivers forever and the receiver burns CPU on every
    // reconnect. Cap with a log so we can spot the case in field reports.
    console.warn('[messenger.deliver] leaveOnRelay=true — envelope will redeliver envId=' + frame.data.envelopeId.slice(0, 8));
  }
  void handledOk; // referenced for diagnostic if ever wired to telemetry
}

/**
 * Bug-hunt #1.A — signals from `doHandleIncoming` to the outer
 * `handleIncoming` wrapper that something needs to happen AFTER the
 * receive txn commits/rolls back. Previously these actions ran inside
 * the BEGIN IMMEDIATE block, which:
 *   1. held the SQLite write lock across multi-second HTTP round trips
 *      (self-DoS on each forged envelope),
 *   2. committed partial libsignal-store writes under the same txn as
 *      the ratchet that just threw,
 *   3. made the recovery untestable in isolation from the txn wrapper.
 *
 * `decrypt-recovery` carries the DecryptError rebuild dance
 * (closeSession + bundle fetch + initOutgoingSession + nudge).
 *
 * `drain-group` (bug-hunt #3.B) carries the pending-queue drain
 * triggered by an admin `create`/`rekey` that committed a new
 * masterKeyB64. The drain processes pending rows in their own per-row
 * txns so a malformed row can't roll back the admin commit.
 */
interface DecryptRecoveryRequest {
  kind:               'decrypt-recovery';
  peer:               SessionAddress;
  reason:             'protected' | 'rebuild' | 'cooldown';
}

interface DrainGroupRequest {
  kind:               'drain-group';
  groupId:            string;
}

/**
 * Self-heal — emitted by the receive path so the factory (which holds the
 * send stack) can act AFTER the receive txn commits, mirroring the
 * drain-group deferral.
 *
 *   reshare-group-key — WE are the owner and a member sent us a signed
 *                       `key-request`; re-DELIVER the current key to them
 *                       (no epoch bump, roster-gated).
 *   request-group-key — we received a group message we CANNOT decrypt
 *                       (no_key / key-divergence) for a group we belong
 *                       to; ask the owner/admins to re-share the key.
 */
interface ReshareGroupKeyRequest {
  kind:               'reshare-group-key';
  groupId:            string;
  toUserId:           string;
}
interface RequestGroupKeyRequest {
  kind:               'request-group-key';
  groupId:            string;
  /**
   * Sender address of the envelope that triggered the request, when
   * known. A brand-new member may hold NO conversations[groupId] row
   * yet (the owner's `create` never landed), and the resync handler's
   * participants normally come from that row — the very row only the
   * missing `create` would have written (handoff §2.5 Seam C). The
   * fallback lets the key-request target the stashed envelope's sender
   * directly instead of silently no-oping.
   */
  fromPeer?:          SessionAddress;
  /** GF-3 — raised by the `tamper` branch: we HOLD a key and it failed to
   *  decrypt. Lets the resync bypass its keyless-only candidate filter. */
  divergence?:        boolean;
}

/**
 * Signal resend protocol (flag-gated, EXPO_PUBLIC_RESEND_PROTOCOL, default off).
 * When WE receive a `rehandshake` control from a peer — which they send after
 * failing to decrypt something from us — that is a strong signal the peer lost
 * messages we sent. If the flag is on, re-transmit our recent still-undelivered
 * 1:1 messages to that peer over the now-healed session. Uses the EXISTING
 * rehandshake signal (no sealed-payload schema change) and re-sends with the
 * ORIGINAL clientMsgId so the receiver dedups (no duplicate bubble). Default off
 * ⇒ the receive path is byte-identical (the branch is skipped).
 */
interface ResendUndeliveredRequest {
  kind:               'resend-undelivered';
  peer:               SessionAddress;
}

type PostTxnRequest =
  | DecryptRecoveryRequest
  | DrainGroupRequest
  | ReshareGroupKeyRequest
  | RequestGroupKeyRequest
  | ResendUndeliveredRequest;

/** Is the resend protocol enabled? Default OFF. Read via globalThis to dodge the
 *  babel-preset-expo EXPO_PUBLIC static rewrite (keeps it readable in tests). */
function isResendProtocolEnabled(): boolean {
  const raw = (globalThis as {process?: {env?: Record<string, string | undefined>}})
    ?.process?.env?.EXPO_PUBLIC_RESEND_PROTOCOL;
  return raw === 'true';
}

/**
 * CRIT-7 multi-device fan-out. Default OFF. When enabled, a 1:1 send ALSO
 * delivers to the peer's devices beyond device 1 (a linked/second device is
 * otherwise silently skipped — the CRIT-7 data-loss gap). Additive to the
 * primary device-1 send; default off ⇒ send path byte-identical.
 */
function isMultiDeviceEnabled(): boolean {
  const raw = (globalThis as {process?: {env?: Record<string, string | undefined>}})
    ?.process?.env?.EXPO_PUBLIC_MULTI_DEVICE;
  return raw === 'true';
}

/**
 * Self-heal signal bus. The deep receive path (top-level functions that
 * only thread crypto-store params) emits group-key signals here; the
 * runtime factory — which owns the cert cache, transport, relay and
 * session manager needed to actually re-share / request a key — registers
 * the single handler at construction time. One runtime per app process, so
 * a module-level slot is sufficient; the loopback/test runtime never
 * registers one, so these signals are inert there.
 */
type GroupKeySignal =
  | {kind: 'reshare'; groupId: string; toUserId: string}
  | {kind: 'request'; groupId: string; fromPeer?: SessionAddress; divergence?: boolean}
  // Audit G-03 — a designated remaining admin rekeys after a peer voluntarily
  // LEFT, so the leaver (who keeps the old key) can't read post-leave messages
  // (forward secrecy). `leaverId` is needed because the leaver is already gone
  // from local membership by the time this fires.
  | {kind: 'leave-rekey'; groupId: string; leaverId: string}
  // B-337 — an admin removed US. Purge the group from this device: the
  // conversation row (else it lingers in the chat list), the persisted
  // transcript + outbox (else a later re-add replays the whole pre-removal
  // history — the relay never backfills, so that copy is purely local), and
  // the crypto state. Handled in the factory, which is the only scope holding
  // the message/outbox stores.
  | {kind: 'purge-self-removed'; groupId: string};
let groupKeySignalHandler: ((s: GroupKeySignal) => void) | null = null;
function setGroupKeySignalHandler(h: ((s: GroupKeySignal) => void) | null): void {
  groupKeySignalHandler = h;
}
function emitGroupKeySignal(s: GroupKeySignal): void {
  try { groupKeySignalHandler?.(s); } catch { /* never let self-heal dispatch break receive */ }
}

/**
 * Resend-protocol signal bus — same shape as the group-key bus. The receive
 * path emits a peer address; the factory (which owns transport/relay/cert/
 * session send stack) registers the handler that re-transmits undelivered 1:1
 * messages. Inert on the loopback/test runtime (no handler registered).
 */
let resendSignalHandler: ((peer: SessionAddress) => void) | null = null;
function setResendSignalHandler(h: ((peer: SessionAddress) => void) | null): void {
  resendSignalHandler = h;
}
function emitResendSignal(peer: SessionAddress): void {
  try { resendSignalHandler?.(peer); } catch { /* never let resend dispatch break receive */ }
}

async function handleIncoming(
  own: SessionManager,
  ownStore: CryptoStore,
  peer: SessionAddress,
  ct: Ciphertext,
  config: ProductionConfig,
  envelopeId?: string,
  keys?: KeysHttpClient,
  nudgeAfterRebuild?: (peer: SessionAddress) => void | Promise<void>,
  /**
   * Fix #11: when the peer rotates identity, libsignal throws
   * DecryptError on inbound. We then refetch + rebuild — but we
   * must also evict the stale entry from the per-runtime peer-
   * identity cache or our NEXT outbound to them would re-wrap
   * with the previous (rotated-out) identity.
   */
  peerIdentityCache?: PeerIdentityCache,
  /**
   * Audit P0-N14 — atomic ratchet+plaintext receive.
   * When both are provided, the decrypt → checks → message-row UPSERT
   * sequence runs inside a single `BEGIN IMMEDIATE` / `COMMIT` on the
   * shared SQLCipher handle. A throw anywhere in the window ROLLBACKs
   * the ratchet advance so the redelivered ciphertext decrypts cleanly
   * on retry instead of failing forever with "bad MAC". Both null on
   * the loopback runtime (in-memory store, no SQLite).
   */
  txnDb?: TxnDbHandle | null,
  sqlMessages?: SqlMessageStore | null,
  /**
   * Audit P0-N6 — when present, markSeen(envelopeId) runs inside the
   * receive transaction so the dedup gate commits atomically with the
   * ratchet advance + plaintext UPSERT.
   */
  seenEnvelopes?: SeenEnvelopeStore | null,
  /**
   * Bug-hunt #3 — pending stash for group envelopes that arrived
   * before the local master key (admin create/rekey still in flight)
   * and admin actions that arrived out-of-epoch order. Both stash
   * writes happen INSIDE the receive txn; the drain happens OUTSIDE
   * via the `drain-group` post-txn request.
   */
  pendingGroupEnvelopes?: PendingGroupEnvelopeStore | null,
  pendingAdminActions?: PendingAdminActionStore | null,
  /**
   * OM-02 — the relay's accept timestamp for this envelope
   * (`ServerEnvelopeDeliver.data.timestamp` / `RelayEnvelope.timestamp`).
   * Used ONLY to clamp the row's display `created_at`; never a crypto input.
   * Undefined on the loopback runtime, which falls back to the local clock.
   */
  serverTsMs?: number,
  /**
   * F-0 (B-693) — OPTIONAL out-param for the [recv.total] probe: the WS
   * caller learns how long this envelope waited for its chain slot vs how
   * long the in-txn work took. Diagnostics only — nothing branches on it,
   * and callers that omit it (drainRelay, loopback) are byte-unaffected.
   */
  perf?: {chainWaitMs: number; txnMs: number},
): Promise<void> {
  // Audit P0-N14 — wrap the WHOLE receive path in a transaction when
  // we have a SQLCipher handle. Inside, every `appendMessage` is
  // mirrored by a synchronous `sqlMessages.upsert` BEFORE we exit the
  // function, so the COMMIT flushes both the libsignal session UPSERT
  // and our plaintext row in one atomic step.
  //
  // On the loopback path (no txnDb / no sqlMessages) we fall through
  // to the legacy non-transactional behaviour — fine for tests where
  // the in-memory store has no notion of crash recovery.
  //
  // Bug-hunt #1.A / #3.B — doHandleIncoming MAY return a `PostTxnRequest`
  // when the inner path needs work that must happen AFTER the receive
  // txn commits. We catch it here, exit the txn cleanly, then dispatch.
  let post: PostTxnRequest | void;
  if (txnDb && sqlMessages) {
    const tQ0 = Date.now();
    post = await runWithRatchetTxn(txnDb, async (frame) => {
      const tW0 = Date.now();
      if (perf) {perf.chainWaitMs = tW0 - tQ0;}
      const r = await doHandleIncoming(
        own, ownStore, peer, ct, config, envelopeId, keys, nudgeAfterRebuild,
        peerIdentityCache, sqlMessages, seenEnvelopes ?? null,
        pendingGroupEnvelopes ?? null, pendingAdminActions ?? null,
        serverTsMs,
        frame, // AUDIT #12 — cooperative abort checkpoints inside the work
      );
      // Why: stamped INSIDE the closure so the number excludes the COMMIT —
      // total minus (chainWait + txn) at the caller isolates the commit cost.
      if (perf) {perf.txnMs = Date.now() - tW0;}
      return r;
    }, `recv:${envelopeId ? envelopeId.slice(0, 8) : '?'}`);
  } else {
    post = await doHandleIncoming(
      own, ownStore, peer, ct, config, envelopeId, keys, nudgeAfterRebuild,
      peerIdentityCache, null, null, null, null,
      serverTsMs,
    );
  }
  if (!post) {return;}
  if (post.kind === 'decrypt-recovery') {
    await runDecryptRecovery(post, own, keys, nudgeAfterRebuild);
    // B-30 — the legacy path ACK-deleted the triggering envelope here even
    // though it was never delivered, so the first message on a (re)established
    // session was permanently lost. For the rebuild/cooldown reasons, leave it
    // on the relay (bounded) so a redelivery can decrypt once the session is
    // rebuilt; the WS/drain caller turns LeaveOnRelayError into a skip-ack.
    // The P0-1 'protected' reason and the loopback (no-envelopeId) path stay
    // ACK-drop, and a give-up (cap/age reached) is counted for diagnosability.
    const disposition = decideRecoveryDisposition(post.reason, envelopeId);
    if (disposition === 'leave-on-relay' && envelopeId) {
      throw new LeaveOnRelayError(envelopeId);
    }
    if (envelopeId) {
      try {
        const {noteUndecryptable} = require('../backup/sessionRatchetRecovery') as
          typeof import('../backup/sessionRatchetRecovery');
        noteUndecryptable(`first-msg-${post.reason}`);
      } catch { /* recovery module not loaded — fine */ }
      // Handoff §3.6 — recovery gave up (cap/age/protected): the envelope
      // is about to be ACK-dropped, i.e. destroyed. Honest disposition.
      noteDestroyedEnvelope({envelopeId, reason: `first-msg-${post.reason}`, peer});
    }
    return;
  }
  if (post.kind === 'drain-group' && pendingGroupEnvelopes && txnDb && sqlMessages) {
    // Bug-hunt #3.B — fire-and-forget drain. Each pending row is
    // processed in its own fresh receive txn so a malformed row can't
    // poison the rest. `void` rather than `await` so the WS handler
    // isn't blocked on potentially many rows; subsequent inbound for
    // this group will already see the drained rows persisted.
    // W25 — this `.catch` was MISSING while its twin at the boot drain had one.
    // A `void`ed promise that rejects is an unhandled rejection: no diagnostic
    // at all, on the LIVE path that fires after every admin create/rekey — i.e.
    // the common one. Mirrors the boot handler exactly.
    void drainPendingGroup(
      post.groupId, config, txnDb, sqlMessages, seenEnvelopes ?? null,
      pendingGroupEnvelopes, pendingAdminActions ?? null,
      // GF-3 — this drain follows a create/rekey install: a NEW key just
      // landed, so a still-failing row may legitimately spend an attempt.
      true,
    ).catch(err =>
      console.warn('[messenger] live group-stash drain failed',
        post.groupId.slice(0, 8), asErrorMessage(err)));
  }
  // Self-heal — hand the group-key signals to the factory's registered
  // handler (which owns the send stack). Fire-and-forget; the handler
  // itself rate-limits and roster-gates.
  if (post.kind === 'reshare-group-key') {
    emitGroupKeySignal({kind: 'reshare', groupId: post.groupId, toUserId: post.toUserId});
  }
  if (post.kind === 'request-group-key') {
    emitGroupKeySignal({
      kind:       'request',
      groupId:    post.groupId,
      fromPeer:   post.fromPeer,
      divergence: post.divergence,
    });
  }
  if (post.kind === 'resend-undelivered') {
    emitResendSignal(post.peer);
  }
}

/**
 * Bug-hunt #1.A — runs after the receive txn has committed/rolled back.
 * Executes the legacy "wipe the session and rebuild from a fresh bundle"
 * dance with NO SQLite write lock held. Marks the rebuild cooldown only
 * after both the bundle fetch and `initOutgoingSession` succeed
 * (preserves the fix-#6 semantics).
 *
 * Bug-hunt #1.D — when `EXPO_PUBLIC_P01_PROOF_OF_LIFE=true`, before
 * destroying the session we fire a `rehandshake` control envelope to
 * the peer and wait briefly for any inbound activity. If the peer is
 * genuinely online and the session is healthy from their side, the
 * inbound clears the recovery banner via the normal success path and
 * we abort the wipe. This closes the residual P0-1 surface (cold-start
 * fresh contact, 24h+ silent peer) without changing the wire format.
 */
async function runDecryptRecovery(
  req: DecryptRecoveryRequest,
  own: SessionManager,
  keys?: KeysHttpClient,
  nudgeAfterRebuild?: (peer: SessionAddress) => void | Promise<void>,
): Promise<void> {
  if (req.reason !== 'rebuild') {return;}
  if (!keys) {return;}

  const PROOF_OF_LIFE_ENABLED =
    typeof process !== 'undefined' &&
    (process as {env?: {[k: string]: string | undefined}}).env?.EXPO_PUBLIC_P01_PROOF_OF_LIFE === 'true';
  // Bug-hunt #1.D — proof-of-life round-trip. Behind a feature flag so
  // the rollout can be staged; default off keeps the existing fast-path
  // behaviour. The wait is short (3s) so a non-responsive peer doesn't
  // delay legitimate rebuild — the rebuild branch still runs after the
  // wait elapses with no inbound seen.
  if (PROOF_OF_LIFE_ENABLED && nudgeAfterRebuild) {
    try {
      // Send the nudge using the CURRENT (about-to-be-destroyed) session.
      // If the session is genuinely live on the peer's side, they receive
      // the rehandshake and their normal response path lights up our
      // `rememberSuccessfulDecrypt`. Failure here (e.g. the session is
      // already burned on our side too) just falls through to rebuild.
      await Promise.resolve(nudgeAfterRebuild(req.peer)).catch(() => { /* ignore */ });
    } catch { /* ignore */ }
    const beforeWait = Date.now();
    await new Promise<void>(resolve => setTimeout(resolve, 3000));
    // If the peer responded during the wait, `rememberSuccessfulDecrypt`
    // would have stamped a fresh timestamp. Consult the same window
    // check we'd consult in the next inbound's catch block — if the
    // session is now "recent", abort the wipe.
    if (hasRecentSuccessfulDecrypt(req.peer)) {
      crashLog(`[P0-1-PoL] proof-of-life cleared rebuild for peer=${req.peer.userId.slice(0, 8)}/${req.peer.deviceId} waitMs=${Date.now() - beforeWait}`);
      return;
    }
  }

  // Why: closeSession + initOutgoingSession write libsignal session rows
  // on the same op-sqlite connection that other envelopes' BEGIN
  // IMMEDIATE may currently hold. Without serialization, a concurrent
  // receive triggers "cannot start a transaction within a transaction"
  // and recovery fails forever for the peer. Queue both writes on the
  // same txnChain as runWithRatchetTxn so they wait for any open
  // transaction to commit. The bundle FETCH is HTTP — no DB lock — so
  // we do it OUTSIDE the chain to keep the chain free.
  let bundle: Awaited<ReturnType<typeof keys.fetchPeerBundleWithPoolSize>>['bundle'];
  try {
    await runOnTxnChain(() => own.closeSession(req.peer), 'recovery:closeSession');
  } catch { /* best effort */ }
  try {
    bundle = (await keys.fetchPeerBundleWithPoolSize(req.peer.userId)).bundle;
    await runOnTxnChain(() => own.initOutgoingSession({
      ...bundle,
      address: {userId: req.peer.userId, deviceId: req.peer.deviceId},
    }), 'recovery:initSession');
    // Fix #6: stamp cooldown AFTER success only. A bundle-fetch failure
    // used to leave the peer locked in a 60s penalty box even though no
    // rebuild actually happened.
    markRebuildAttempt(req.peer);
    // Rehandshake nudge: send a tiny control envelope back so the
    // original sender's libsignal session-replaces on decrypt. Without
    // this, ops/sender stays stuck on the stale ratchet until they
    // happen to send again. Best-effort; failures don't block recovery.
    if (nudgeAfterRebuild) {void nudgeAfterRebuild(req.peer);}
  } catch (recoveryErr) {
    // Surface the swallowed failure — the manual reset is still the
    // safety net but at least we know which leg failed (bundle fetch,
    // init, or nudge). Cooldown intentionally NOT stamped: leave the
    // gate open for the next inbound.
    crashLog(`[messenger] recovery-failed peerPrefix=${req.peer.userId.slice(0, 8)} err=${(recoveryErr as Error).message.slice(0, 120)}`);
    crashRecord(recoveryErr instanceof Error ? recoveryErr : new Error(String(recoveryErr)), {
      area: 'messenger.identityRecovery', peerPrefix: req.peer.userId.slice(0, 8),
    });
    console.warn('[messenger] recovery failed', {
      peer: req.peer, error: (recoveryErr as Error).message,
    });
  }
}

/**
 * Bug-hunt #3.B — replay every pending envelope for a group whose
 * master key just landed. Each row is processed in its own fresh
 * receive txn so a single malformed row can't poison the rest.
 *
 * Per-row outcomes:
 *   - replay succeeds → row deleted.
 *   - replay throws (still no_key, tamper, parse error) → bump
 *     attempts; if at `PENDING_GROUP_MAX_ATTEMPTS`, drop the row.
 *
 * After draining the envelope queue, also runs the admin-action
 * drain (bug-hunt #3.D): a `create`/`rekey` that just committed
 * could be exactly the local-state advance some stashed admin
 * action was waiting for.
 */
async function drainPendingGroup(
  groupId: string,
  config: ProductionConfig,
  txnDb: TxnDbHandle,
  sqlMessages: SqlMessageStore,
  seenEnvelopes: SeenEnvelopeStore | null,
  pendingGroupEnvelopes: PendingGroupEnvelopeStore,
  pendingAdminActions: PendingAdminActionStore | null,
  /** GF-3 — true only when this drain follows a NEW key landing (create/rekey). */
  keyChanged: boolean,
): Promise<boolean> {
  // W25 — the guard lives INSIDE the function, not at the two call sites. Both
  // callers are fire-and-forget (`void drainPendingGroup(...)`), so putting it
  // at the call sites means writing it twice and the second copy drifting —
  // which is the failure mode behind B-124, B-128 and B-141 in this very file.
  //
  // Why it is needed: a burst of admin commits for one group (create then
  // rekey, or several adds) fires one drain per commit. Without the guard they
  // interleave over the SAME stash rows — every pass re-parses the same
  // envelopes under the group master key, and each loses the `delete` race, so
  // the work is duplicated for no benefit. The txn chain serialises the writes,
  // so this was wasted CPU rather than corruption; it is still worth not doing.
  if (drainsInFlight.has(groupId)) {
    // GF-3 — `false` (not "still key-blocked"): the drain already running owns
    // that verdict and will report it to its own caller. Claiming divergence
    // here would fire a duplicate key-resync off a drain we never observed.
    return false;
  }
  drainsInFlight.add(groupId);
  try {
    return await drainPendingGroupInner(
      groupId, config, txnDb, sqlMessages, seenEnvelopes,
      pendingGroupEnvelopes, pendingAdminActions, keyChanged,
    );
  } finally {
    // `finally`, never after the await: a throw would otherwise wedge this
    // groupId permanently and no stashed envelope for it would ever drain again
    // for the life of the process.
    drainsInFlight.delete(groupId);
  }
}

/** W25 — group ids with a drain currently running. See drainPendingGroup. */
const drainsInFlight = new Set<string>();

// B-213 — shared between the no_key stash (below) and the drain success
// clear (drainPendingGroupInner) so the two can never drift apart. The
// banner this feeds (chatStatusLabel) reads a single GLOBAL store.error
// field, not one scoped to the group that triggered it — see the clear
// site for why that global-ness needs an explicit clear once resolved.
const GROUP_KEY_PENDING_RECEIVE_ERROR =
  "Waiting for this group's encryption key — the message will appear once it syncs.";

// B-262a — the tamper/key-divergence sibling of the constant above, and it had
// the SAME defect B-213 fixed for that one: set inline as a bare string on the
// `tamper` stash path, matched by none of the three clear sites, therefore
// never cleared. Since `store.error` is a single GLOBAL field, a divergence in
// one group painted a red banner across every chat screen — including 1:1s
// with people who had nothing to do with it — and kept it there after the
// resync had already succeeded and the message had decoded. That is exactly
// how the founder came to report a group-key problem while looking at a 1:1
// (2026-07-26): the banner was stale and misattributed, and it sent the
// investigation at the wrong bug for an hour.
//
// Named so the stash site and the drain-success clear cannot drift, same
// discipline as its sibling.
const GROUP_KEY_DIVERGENCE_RECEIVE_ERROR =
  "Couldn't decrypt one message — re-syncing";

// B-262 — how long a key-blocked stash row may sit undecryptable before the
// drain surfaces a VISIBLE gap for it. A `needsKey` divergence row spends NO
// attempt on a boot drain (GF-3), so it hits the `continue` in the drain loop
// on every launch and can never reach the cap-drop: invisible for as long as
// it stays undecryptable. Jack's group-key-divergence message was exactly this
// row — ACKed `delivered`, hard-deleted off the relay at stash time, then never
// rendered. This bound is chosen deliberately BELOW the store's 30-day relay
// dwell / prune window (PENDING_GROUP_ENVELOPES_RETENTION_MS): the drain must
// surface the marker BEFORE `prune()` silently reaps the row, and it is well
// past the store's "recover well past a week" tail so a legitimately-late key
// still gets a couple of weeks to land and render the real message. We NEVER
// delete on the age path — GROUP-STASH-7DAY-PRUNE-PERMALOSS: deleting a stash
// row before the full dwell destroys a recoverable message (the relay copy is
// already gone). prune owns the terminal delete at 30 days.
const GROUP_STASH_UNRECOVERED_MS = 14 * 24 * 60 * 60 * 1000;

// B-262 — leave a persistent, recoverable "couldn't decrypt" gap in the group
// thread for a stashed envelope that can never surface (cap exhausted, or stuck
// key-blocked past GROUP_STASH_UNRECOVERED_MS). Mirrors the terminal
// tamper-DROP twin in doHandleIncoming (insertDecryptFailurePlaceholder +
// sqlMessages.upsert), so the two receiver-side visibility paths cannot drift.
// Block-suppressed (no resurrection for a blocked sender, like the tamper
// twin), idempotent (deduped by envelope id — safe to re-run on every drain),
// and fail-open (a placeholder failure must never abort the drain). The content
// is a fixed generic string — it NEVER renders the rejected ciphertext.
async function surfaceUnrecoveredStash(
  row:         {envelopeId: string; peerUserId: string; peerDeviceId: number},
  groupId:     string,
  sqlMessages: SqlMessageStore,
): Promise<void> {
  if (isPeerBlocked(row.peerUserId)) {return;}
  try {
    const placeholder = insertDecryptFailurePlaceholder({
      conversationId: groupId,
      peer:           {userId: row.peerUserId, deviceId: row.peerDeviceId},
      envelopeId:     row.envelopeId,
      reason:         'group-key-unrecovered',
    });
    if (placeholder) {await sqlMessages.upsert(placeholder);}
  } catch (e) {
    crashLog(`[group:drain] B-262 placeholder failed env=${row.envelopeId.slice(0, 8)} err=${asErrorMessage(e).slice(0, 80)}`);
  }
}

async function drainPendingGroupInner(
  groupId: string,
  config: ProductionConfig,
  txnDb: TxnDbHandle,
  sqlMessages: SqlMessageStore,
  seenEnvelopes: SeenEnvelopeStore | null,
  pendingGroupEnvelopes: PendingGroupEnvelopeStore,
  pendingAdminActions: PendingAdminActionStore | null,
  /** GF-3 — true only when this drain follows a NEW key landing (create/rekey). */
  keyChanged: boolean,
): Promise<boolean> {
  let rows;
  try {
    rows = await pendingGroupEnvelopes.listForGroup(groupId);
  } catch (e) {
    crashLog(`[group:drain] list failed groupId=${groupId.slice(0, 8)} err=${asErrorMessage(e).slice(0, 80)}`);
    return false;
  }
  if (rows.length > 0) {
    crashLog(`[group:drain] groupId=${groupId.slice(0, 8)} rows=${rows.length}`);
  }
  let stillKeyBlocked = false;
  for (const row of rows) {
    try {
      const sealed = JSON.parse(row.sealedJson) as ReturnType<typeof unsealPayload>;
      await replayGroupSealedDecode(
        sealed,
        {userId: row.peerUserId, deviceId: row.peerDeviceId},
        row.envelopeId,
        config,
        txnDb,
        sqlMessages,
        seenEnvelopes,
        row.receivedAtMs,
      );
      await pendingGroupEnvelopes.delete(row.envelopeId);
    } catch (e) {
      crashLog(
        `[group:drain] replay failed groupId=${groupId.slice(0, 8)} ` +
        `env=${row.envelopeId.slice(0, 8)} err=${asErrorMessage(e).slice(0, 80)}`,
      );
      // GF-3 — the boot drain replays against the SAME on-disk key every
      // launch, so a key-divergence row used to burn all three attempts in
      // three launches and be deleted — destroying the only surviving copy
      // (stashing ACKs the relay). Spend an attempt only when a new key
      // could not have fixed the failure, or when a new key actually landed.
      const needsKey = e instanceof ReplayNeedsKeyError;
      if (needsKey) {stillKeyBlocked = true;}
      // AUDIT #11 rev-5 (edge) — a transient local failure (db_closed,
      // BUSY) must not spend an attempt either: three of them deleted the
      // only surviving copy (stashing ACKed the relay). Note (critic): a
      // transient throw is a StoreError, never a ReplayNeedsKeyError, so
      // stillKeyBlocked stays false for that row and the B-213 banner
      // clears OPTIMISTICALLY — self-healing, the next drain re-derives
      // the true key state from the still-present rows.
      //
      // B-262 — a key-blocked row spends no attempt (line below `continue`s it),
      // so it can `continue` here on EVERY drain and never reach the cap-drop:
      // invisible until prune reaps it. Once it has sat undecryptable past the
      // recoverable window, surface a VISIBLE gap (placeholder-only — prune owns
      // the terminal delete at the dwell; deleting sooner destroys a recoverable
      // message, GROUP-STASH-7DAY-PRUNE-PERMALOSS). Gated on `needsKey` so a
      // transient-SQL hiccup on an old row does NOT cry "couldn't decrypt".
      if (needsKey && Date.now() - row.receivedAtMs >= GROUP_STASH_UNRECOVERED_MS) {
        await surfaceUnrecoveredStash(row, groupId, sqlMessages);
      }
      if (!shouldBumpStashAttempt({needsKey, keyChanged, transientSql: isTransientSqlError(e)})) {continue;}
      try {
        const attempts = await pendingGroupEnvelopes.bumpAttempts(row.envelopeId);
        if (attempts >= PENDING_GROUP_MAX_ATTEMPTS) {
          // B-262 — placeholder BEFORE the delete. A capped row burned real
          // attempts (incl. a post-key-arrival drain), so it is genuinely
          // undecryptable and deleting is right — but it must leave a VISIBLE,
          // recoverable gap, not vanish silently the way it did for B-262.
          await surfaceUnrecoveredStash(row, groupId, sqlMessages);
          await pendingGroupEnvelopes.delete(row.envelopeId);
        }
      } catch { /* swallow */ }
    }
  }
  // Bug-hunt #3.D — try replaying any stashed admin actions for this
  // group too. We just advanced local state; one of the stale-epoch
  // actions may now apply.
  if (pendingAdminActions) {
    await drainPendingAdminActions(groupId, pendingAdminActions);
  }
  // B-213 — this group actually had stashed rows and none are still
  // key-blocked, so whatever triggered the "waiting for this group's
  // encryption key" banner just resolved. store.error is a single GLOBAL
  // field (not scoped to groupId), so without this the banner can outlive
  // the sync it was warning about and sit on every chat screen — including
  // ones with nothing to do with this group — until some unrelated error
  // happens to overwrite it. Only clear it when it's still exactly this
  // message: a real, different error that landed in between must survive.
  // NOT gated on `rows.length > 0` any more. The condition that matters is
  // "this group is no longer key-blocked", and that is equally true when the
  // stash is EMPTY — which is the common case once the key has landed and
  // messages decode live. The old `rows.length > 0 &&` meant a device whose
  // stash had already drained (or was never populated) kept the red banner
  // forever while happily rendering messages underneath it: exactly the
  // reported CPO Ops Room screenshot. Only this device saw it, because only
  // this device had hit the no_key path.
  //
  // The string equality below is still what keeps this safe: a real, different
  // error that landed in between must survive, so we only ever clear OUR banner.
  if (!stillKeyBlocked) {
    const store = useMessengerStore.getState();
    // B-262a — clear the divergence banner on the same condition. A `tamper`
    // row is stashed on THIS queue and drains through THIS function, so
    // "no longer key-blocked" retires both banners or neither. Still an
    // equality check per variant: a different error that landed in between
    // must survive.
    if (
      store.error === GROUP_KEY_PENDING_RECEIVE_ERROR ||
      store.error === GROUP_KEY_DIVERGENCE_RECEIVE_ERROR
    ) {
      store.setError(null);
    }
  }
  return stillKeyBlocked;
}

/**
 * Bug-hunt #3.B — replay a stashed group sealed payload. We bypass
 * `own.decrypt` (the inner Signal ciphertext was already consumed
 * when the envelope first arrived — the per-message key has burned)
 * and re-run only the post-decrypt routing: parse the group payload
 * with the now-available master key, append the message row, and
 * mark the envelope-id seen.
 *
 * If the master key STILL doesn't decrypt the body (drain triggered
 * on the wrong group, or pending row references a yet-to-arrive
 * rekey), throw — the caller bumps attempts and eventually drops.
 */
async function replayGroupSealedDecode(
  sealed: ReturnType<typeof unsealPayload>,
  peer: SessionAddress,
  envelopeId: string,
  config: ProductionConfig,
  txnDb: TxnDbHandle,
  sqlMessages: SqlMessageStore,
  seenEnvelopes: SeenEnvelopeStore | null,
  /** OM-02 — upper bound on this envelope's real send time (stash receive time). */
  refTsMs: number,
): Promise<void> {
  if (!sealed.group) {throw new Error('replay: not a group envelope');}
  const store = useMessengerStore.getState();
  const existing = store.groups[sealed.group.groupId];
  const masterKey = existing?.masterKeyB64;
  if (!masterKey) {
    throw new ReplayNeedsKeyError('replay: master key still missing post-drain');
  }
  const parseResult = await parseGroupMessage(sealed, masterKey);
  if (!parseResult.ok) {
    // GF-3 — no_key/tamper are key-blocked (a later key install may fix
    // them); anything else is structural and must keep burning attempts.
    if (parseResult.reason === 'no_key' || parseResult.reason === 'tamper') {
      throw new ReplayNeedsKeyError(`replay: parse ${parseResult.reason}`);
    }
    throw new Error(`replay: parse ${parseResult.reason}`);
  }
  const inner = parseResult.envelope;
  if (inner.kind === 'admin') {
    // Admin replay through `setGroupState` is delicate (epoch
    // ordering, signature checks). Stashed admin actions are
    // handled by `drainPendingAdminActions` separately; if an
    // admin envelope ended up in the GROUP-envelope queue it was
    // already routed wrong. Drop the row by completing cleanly.
    return;
  }
  // Audit P1-N4 — same gate as the live path: a stashed text envelope
  // from a peer who isn't a member at the current epoch is dropped.
  // Covers the race where a removed peer's old envelope was stashed
  // pending key arrival and then drains after the remove lands.
  if (existing && !isGroupMember(existing, peer.userId)) {
    return;
  }
  // M15 (W8b) — the live path drops on three more conditions that this replay
  // never checked, so a stashed envelope could render when the same envelope
  // arriving live would not. All three use a plain `return`: drainPendingGroup
  // deletes the stash row only on a CLEAN return, whereas a throw is caught,
  // bumps `attempts`, and replays the whole decode PENDING_GROUP_MAX_ATTEMPTS
  // times before deleting the row anyway. A deliberate drop is not an error.
  //
  // Skipping the txn also skips its `markSeen`, which is fine: markSeen already
  // ran unconditionally inside the receive txn (P0-N6) when the envelope first
  // arrived and was stashed, so the in-txn call here is only defensive.
  //
  // Expiry and blocked are checked BEFORE the row is built — neither needs it,
  // so there is no reason to build a row we are about to discard.
  //
  // M7 — a disappearing message whose TTL ran out while it sat in the stash.
  // This fires MORE often here than on the live path, not less: an envelope is
  // only stashed because its key was missing, so it waits an unbounded time by
  // definition. A 5-minute message stashed for an hour is long dead on arrival.
  // B-316 — same skew-graced gate as the live path (M15 gate parity).
  if (shouldDropExpiredPayload(sealed.expiresAtSec, Date.now())) {
    return;
  }
  // P2-9 — mirrors the live group drop. Without this, blocking a peer did NOT
  // stop their already-stashed message: the next key arrival drained it straight
  // onto the user's screen.
  if (isPeerBlocked(peer.userId)) {
    return;
  }
  const conversationId = sealed.group.groupId;
  const groupMsg: LocalMessage = {
    id:               sealed.clientMsgId ?? makeId(),
    conversation_id:  conversationId,
    sender_id:        peer.userId,
    // GROUP MEDIA FIX — a media message that arrived before the key
    // (no_key) is stashed and drained here once the key lands; carry the
    // attachment so the drained row renders as media, not a bare caption.
    type:             attachmentMessageType(sealed.attachment),
    content:          inner.body,
    media_mime:       sealed.attachment?.mimeType,
    media_object_key: sealed.attachment?.objectKey,
    media_key:        sealed.attachment?.keyB64,
    media_iv:         sealed.attachment?.ivB64,
    media_meta:       attachmentMediaMeta(sealed.attachment),
    status:           'delivered',
    is_encrypted:     true,
    // L18 GROUP-DRAIN-RECEIVE-TIME-ORDERING — use the sender's SEAL timestamp
    // (aad.ts) as created_at, not the drain time. A stashed (no_key) envelope
    // drains long after it was sent; stamping "now" sorted it AFTER messages
    // actually sent later but decoded earlier. appendMessage splices an
    // out-of-order row into its chronological slot, so the right timestamp lands
    // it back in send-order. OM-02 clamps only the impossible FUTURE direction
    // (against the stash receive time) — the arbitrarily-old direction is the
    // whole point of L18 and stays untouched.
    created_at:       orderingCreatedAt((sealed.aad as {ts?: number} | undefined)?.ts, refTsMs),
    peer,
    envelope_id:      envelopeId,
    expires_at:       sealed.expiresAtSec ? sealed.expiresAtSec * 1000 : undefined,
    reply_to_msg_id:  sealed.replyTo?.msgId,
    reply_to_preview: sealed.replyTo?.preview,
    // Carrier first, top level second — ONE rule, shared with every other
    // inbound lane via the builder.
    mentions:         mentionsFrom(sealed as Parameters<typeof mentionsFrom>[0]),
    // MM-09 — same carrier-first rule as mentions.
    is_forwarded:     (sealed.group?.isForwarded === true || sealed.isForwarded === true) ? true : undefined,
  };
  // M-08 — the id is only known once the row is built, so this gate has to sit
  // below the literal. Don't let a stashed envelope resurrect a message the user
  // deleted before reinstalling. Still above the txn: dropping here avoids the
  // write entirely rather than appending and undoing it.
  if (isRestoreTombstoned(groupMsg.id)) {
    return;
  }
  // B-262 — this row RECOVERED. If the age-bound drain already left a give-up
  // placeholder for this envelope, it owns this envelope_id, and appendMessage
  // dedups on envelope_id (messengerStore :903) — so the real row below would be
  // DROPPED (committedId null → never persisted) and the caller then deletes the
  // last stash copy = the original B-262 loss, re-introduced. Drop the
  // placeholder FIRST so the real message appends cleanly and the stale gap
  // clears. Kept OUTSIDE the txn deliberately: removeMessage's SQLCipher
  // write-through delete + backup-removal tombstone run on the same removal path
  // expiry/delete-for-everyone use, and running it before the ratchet BEGIN
  // avoids interleaving an autocommit delete with this txn. No-op (and no
  // spurious tombstone) when no placeholder exists.
  reconcileRecoveredPlaceholder(conversationId, envelopeId);
  await runWithRatchetTxn(txnDb, async (frame) => {
    if (seenEnvelopes) {await seenEnvelopes.markSeen(envelopeId);}
    // AUDIT #12 — checkpoint after each awaited write: a force-advanced
    // frame must not keep writing into a later frame's transaction.
    frame.assertLive();
    // AUDIT #13 — sync-bracketed: the explicit upsert below owns durability.
    // Persist the row the store COMMITTED, never the pre-append object
    // (critic rev-3: appendMessage forks the id on a content-divergent
    // collision and returns null on a deliberate drop — the write-through's
    // redundant second write used to MASK a pre-append upsert here; the
    // bracket removed the mask, so the committed-id shape is load-bearing).
    const groupRowExisted = receiveRowExists(conversationId, groupMsg.id); // B-703 MR-7
    const committedId = runWriteThroughSuppressed(() => store.appendMessage(conversationId, groupMsg));
    compensateReceiveAppend(conversationId, groupMsg.id, groupRowExisted, committedId);
    if (committedId) {await sqlMessages.upsert({...groupMsg, id: committedId});}
    frame.assertLive();
    if (committedId) {
      // SYNC-7 — a reaction may have overtaken this very message; replay it in
      // the same txn so it commits atomically with its target — targeting the
      // COMMITTED id (a fork would have stranded the replay on the wrong id).
      await drainPendingReactionsFor(conversationId, committedId, sqlMessages);
      frame.assertLive();
      // ...and so may an edit or a delete-for-everyone. This is the exact case
      // that made the mutation stash necessary: the text was held back waiting
      // for the group key while the pairwise directive sailed through.
      await drainPendingMutationsFor(
        conversationId, committedId, sqlMessages,
        useMessengerStore.getState().groups[conversationId],
      );
    }
  }, `stashReplay:${envelopeId.slice(0, 8)}`);
  void config; // keep signature stable for future expansion
}

/**
 * Bug-hunt #3.D — replay every pending admin action for a group.
 * Re-runs `applyAdminAction`; if the action still no-ops (local
 * state still mismatched), bump attempts and drop after the cap.
 *
 * Runs OUTSIDE the receive txn — admin replay touches the Zustand
 * store, not SQLite, so there's no concurrency benefit to wrapping
 * it. Errors are swallowed per row so one bad action can't stop
 * the rest from replaying.
 */
async function drainPendingAdminActions(
  groupId: string,
  pendingAdminActions: PendingAdminActionStore,
): Promise<void> {
  let rows;
  try {
    rows = await pendingAdminActions.listForGroup(groupId);
  } catch (e) {
    crashLog(`[group:drain-admin] list failed groupId=${groupId.slice(0, 8)} err=${asErrorMessage(e).slice(0, 80)}`);
    return;
  }
  if (rows.length > 0) {
    crashLog(`[group:drain-admin] groupId=${groupId.slice(0, 8)} rows=${rows.length}`);
  }
  // pending-admin-drain-unsorted-epoch — apply stashed admin actions in
  // ASCENDING epoch order so ONE drain pass can advance the group state
  // monotonically. Out-of-order arrival used to try a higher-epoch action
  // first (applyAdminAction no-ops on epoch mismatch), apply the lower one,
  // then leave the now-applicable higher one for the NEXT drain trigger.
  // Pure scheduling: the per-action epoch + signature checks inside
  // applyAdminAction are unchanged and still gate every apply, so the sort can
  // never apply something the reducer would reject. Rows with no atEpoch
  // (e.g. a stray create) sort last — no worse than today (they just retry).
  const epochOf = (r: {actionJson: string}): number => {
    try {
      const a = JSON.parse(r.actionJson) as {atEpoch?: number};
      return typeof a.atEpoch === 'number' ? a.atEpoch : Number.MAX_SAFE_INTEGER;
    } catch { return Number.MAX_SAFE_INTEGER; }
  };
  const sortedRows = [...rows].sort((a, b) => epochOf(a) - epochOf(b));
  const store = useMessengerStore.getState();
  for (const row of sortedRows) {
    try {
      const existing = store.groups[row.groupId];
      if (!existing) {
        await pendingAdminActions.delete(row.id);
        continue;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const action = JSON.parse(row.actionJson) as any;
      const next = applyAdminAction(existing, action, row.senderUserId);
      if (next === existing) {
        // Still doesn't apply — bump attempts, drop after cap.
        const attempts = await pendingAdminActions.bumpAttempts(row.id);
        if (attempts >= PENDING_ADMIN_MAX_ATTEMPTS) {
          await pendingAdminActions.delete(row.id);
        }
        continue;
      }
      store.setGroupState(next);
      if (existing.masterKeyB64 !== next.masterKeyB64) {
        disposeGroupKey(existing.masterKeyB64);
      }
      await pendingAdminActions.delete(row.id);
    } catch (e) {
      crashLog(`[group:drain-admin] apply failed id=${row.id} err=${asErrorMessage(e).slice(0, 80)}`);
      // AUDIT #11 rev-5 (edge) — same GF-3 shape as the stash drain: a
      // transient local failure (db_closed, BUSY) must not spend one of the
      // row's bounded attempts — three of them dropped a membership/rekey
      // transition outright.
      if (isTransientSqlError(e)) {continue;}
      try {
        const attempts = await pendingAdminActions.bumpAttempts(row.id);
        if (attempts >= PENDING_ADMIN_MAX_ATTEMPTS) {
          await pendingAdminActions.delete(row.id);
        }
      } catch { /* swallow */ }
    }
  }
}

/**
 * S5 — one dependency wiring for both reaction call sites. Two separate literals
 * here would reintroduce, at the wiring layer, exactly the duplication the lane
 * merge just removed — which is how the group lane went without a membership
 * gate until B-128.
 *
 * M9 — `upsert` is the AWAITED single-row write, deliberately not
 * `upsertCoalesced`. Tier 1 is the one reaction path that was fire-and-forget;
 * tier 2 (`resolveDurably`) and `drainPendingReactionsFor` already await their
 * upserts on this same receive path, so awaiting here is not a new class of
 * cost — it is one extra single-row write, the same one the group-text and
 * 1:1-text lanes pay two lines away. What it buys is that the patched row is
 * durable ATOMICALLY with the relay ack instead of landing after it.
 */
function reactionLaneDeps(sqlMessages: SqlMessageStore | null): ReactionLaneDeps {
  return {
    isPeerBlocked,
    noteDestroyed: noteDestroyedEnvelope,
    applyReaction,
    upsert: sqlMessages ? (m) => sqlMessages.upsert(m) : null,
    log:    (m) => console.log(m),
    resolveDurably: (cid, uid, targetMsgId, emoji, remove, receivedAtMs) =>
      applyReactionDurable(cid, uid, targetMsgId, emoji, remove, sqlMessages, receivedAtMs),
  };
}

async function doHandleIncoming(
  own: SessionManager,
  ownStore: CryptoStore,
  peer: SessionAddress,
  ct: Ciphertext,
  config: ProductionConfig,
  envelopeId: string | undefined,
  keys: KeysHttpClient | undefined,
  nudgeAfterRebuild: ((peer: SessionAddress) => void | Promise<void>) | undefined,
  peerIdentityCache: PeerIdentityCache | undefined,
  sqlMessages: SqlMessageStore | null,
  seenEnvelopes: SeenEnvelopeStore | null,
  pendingGroupEnvelopes: PendingGroupEnvelopeStore | null,
  pendingAdminActions: PendingAdminActionStore | null,
  serverTsMs: number | undefined,
  // AUDIT #12 — present only when riding a runWithRatchetTxn frame (the
  // loopback path passes nothing). Checkpoints below stop a
  // force-advanced frame from writing into a later frame's transaction.
  frame?: import('./receiveTransaction').RatchetTxnFrame,
): Promise<void | PostTxnRequest> {
  console.log('[recv.enter] doHandleIncoming peer=' + peer.userId.slice(0, 8) + '/' + peer.deviceId + ' envId=' + (envelopeId ?? 'inline').slice(0, 8));
  // Bug-hunt #1.A — identity-rotation recovery is now SIGNALLED here
  // and EXECUTED by the outer `handleIncoming` AFTER the receive txn
  // commits. The old in-line dance (closeSession + bundle fetch +
  // initOutgoingSession) held the SQLite write lock across a network
  // round-trip, self-DoSing every concurrent receive. The function
  // returns a `DecryptRecoveryRequest` instead.
  let sealed: string;
  try {
    sealed = await own.decrypt(peer, ct);
  } catch (e) {
    // B-30 — recognize NoSessionError too (it was escaping to `throw e` below
    // → the catch-all ACK-dropped the first message on a fresh/lost session).
    // The classifier also name-matches the dual error-class copies.
    if (isRecoverableDecryptError(e)) {
      // Fix #11: invalidate the peer identity cache so the NEXT
      // outbound message re-fetches the (presumably rotated) key
      // instead of wrapping with the stale one we cached on a
      // prior success.
      peerIdentityCache?.delete(peerIdentityCacheKey(peer));
      // Audit P0-1 — defence against forged-outer-envelope ratchet
      // wipe. See `sessionWipeProtection` for the full rationale.
      if (hasRecentSuccessfulDecrypt(peer)) {
        crashLog(`[P0-1] suppressed session-wipe on DecryptError — recent legitimate activity from peer=${peer.userId.slice(0, 8)}/${peer.deviceId} (likely forged outer envelope)`);
        useMessengerStore.getState().setRecoveryBanner(
          'A message failed to decrypt. If you keep seeing this, ask the sender to reinstall.',
        );
        return {kind: 'decrypt-recovery', peer, reason: 'protected'};
      }
      // Fix #16: soft `recoveryBanner` slot — identity rotation is a
      // known recoverable case; don't stomp on a fatal banner.
      useMessengerStore.getState().setRecoveryBanner(
        'Lost session with sender (likely reinstall) — your next message will rebuild it.',
      );
      // Hand recovery to the outer wrapper. It runs after the receive
      // txn commits (empty — no rows were written in this branch) so
      // closeSession + bundle fetch + initOutgoingSession execute with
      // NO SQLite write lock held.
      if (keys && shouldAttemptRebuild(peer)) {
        return {kind: 'decrypt-recovery', peer, reason: 'rebuild'};
      }
      return {kind: 'decrypt-recovery', peer, reason: 'cooldown'};
    }
    throw e;
  }
  // Decrypt succeeded — clear the soft recovery banner (set above on
  // a prior failed envelope). Don't touch `error`; that's reserved
  // for fatal/sticky banners and may belong to a different subsystem.
  if (useMessengerStore.getState().recoveryBanner) {
    useMessengerStore.getState().setRecoveryBanner(null);
  }
  // Audit P0-1 — mark this peer's session as live. A subsequent
  // DecryptError within PROTECTED_SESSION_WINDOW_MS will be treated
  // as a likely forged-outer-envelope attack and the wipe-and-rebuild
  // path will refuse to run.
  rememberSuccessfulDecrypt(peer);
  // B-30 — this envelope finally decrypted; free its leave-on-relay budget
  // slot so the bounded retry counter doesn't linger until LRU eviction.
  if (envelopeId) {clearFirstMsgRetryBudget(envelopeId);}
  // AUDIT #12 — THE checkpoint: `own.decrypt` above is the long await
  // where field wedges park (B-126). If the watchdog force-advanced past
  // this frame while it was wedged there, every write below would land
  // inside a LATER frame's open transaction (committed by that frame's
  // COMMIT, attributed to nothing). Throws the transient
  // txn_frame_disowned → leave-on-relay → clean redelivery.
  frame?.assertLive();
  // Audit P0-N6 — the ratchet has advanced; mark this envelope-id seen
  // so a redelivery doesn't feed the same ciphertext back through
  // libsignal (which would throw "bad MAC" because the per-message key
  // has burned). The INSERT runs inside the receive transaction so any
  // throw downstream (cert/AAD reject, malformed payload) ROLLBACKs
  // BOTH the markSeen and the ratchet advance together.
  if (seenEnvelopes && envelopeId) {
    await seenEnvelopes.markSeen(envelopeId);
  }
  // Audit 1:1 P1-8 — wrap unsealPayload so a version-rejection emits a
  // crashLog breadcrumb. The thrown CryptoError is rethrown so the txn
  // rolls back (matching the existing fail-closed behaviour), but now
  // operators get a counter they can correlate with rollout-pinning
  // problems instead of just "messages stopped appearing".
  let unwrapped;
  try {
    unwrapped = unsealPayload(sealed);
  } catch (e) {
    if (e instanceof Error && /unsupported sealed version/.test(e.message)) {
      crashLog(`[messenger] unseal-version-reject env=${envelopeId?.slice(0, 8) ?? 'inline'} msg=${e.message}`);
    }
    throw e;
  }
  // Audit P0-8 — prefer the local trust row, fall back to the
  // authority-signed peer bundle on cold contact (P0-I2 attests it).
  // M5 — call the resolver unconditionally. `keys` is optional ON PURPOSE and
  // the resolver owns the "local trust row, else undefined" fallback; this site
  // used to hand-roll a second copy of that step, which is the same duplication
  // class as B-124. One implementation, one place.
  const expectedSenderIdentity =
    await resolveExpectedSenderIdentity(peer, ownStore, keys, peerIdentityCache);
  const claims = await verifySenderCert({
    cert:                unwrapped.cert,
    authorityPubKeyB64:  config.authorityPubKeyB64,
    expectedIdentityKey: expectedSenderIdentity,
  });
  if (claims.senderUserId !== peer.userId) {
    // Audit 1:1 P1-3 — must THROW so the receive txn rolls back the
    // ratchet advance. The original `return` exited cleanly inside the
    // BEGIN IMMEDIATE block, COMMITting the libsignal session UPSERT
    // even though we dropped the message. On the inevitable redelivery
    // libsignal then threw "bad MAC" against the now-burned message
    // key and the conversation got stuck. Throwing rolls the ratchet
    // back to its pre-decrypt state so the retry succeeds when (if
    // ever) a cert-matched envelope arrives.
    useMessengerStore.getState().setError('sender cert / hint mismatch');
    throw new Error('cert_peer_mismatch');
  }
  // Audit 1:1 P0-2 — deviceId pinning. The sender cert claims a specific
  // (userId, deviceId); the outer wrap names the same pair. Mismatch =
  // cross-device replay attempt; drop with rollback.
  if (claims.senderSignalDeviceId !== peer.deviceId) {
    useMessengerStore.getState().setError('sender cert / device-id mismatch');
    throw new Error('cert_device_mismatch');
  }
  // Round 5 / Security S1 — verify the AAD binding. We own the
  // receiver's identity so we can check `aad.to` matches. A mismatch
  // means the ciphertext was sealed for someone else and replayed to
  // us; a stale ts (older than the 30-day relay dwell — see MSG-01
  // below) means it can only be an expired/replayed envelope.
  //
  // Audit S10 — previously the call accepted any envelope WITHOUT an
  // AAD block (`{ok: true, aad: undefined}`), which silently disabled
  // the replay-protection feature. We now require an AAD by default,
  // with an env-var escape hatch (EXPO_PUBLIC_SEALED_AAD_LEGACY=true)
  // for the rare case that a server fleet still ships pre-S1 senders.
  // Audit P0-N2 — the extended AAD also binds sender + conversation +
  // group + epoch. We compute the receiver-side expected values here so
  // verifySealedAad can reject a cross-thread or cross-group replay.
  //
  // Audit P0-N2-follow-up — for 1:1 envelopes the AAD conversationId
  // is the SYMMETRIC id (`directConvoAadId(self, peer)`), NOT the
  // per-side UI key returned by `convoIdFor(peer)`. The UI key
  // continues to drive local thread routing below.
  const expectedConversationId = unwrapped.group?.groupId
    ?? directConvoAadId(config.ownUserId, peer.userId);
  // AUDIT-2026-08-13 #17 — surface the AAD epoch binding, LAGGED. The
  // lag exists because a receiver runs ahead of in-flight mail at every
  // rekey (op@E + rekey@E+1 = +2 per membership change), so a lag of 2
  // tolerates one in-flight op before the check even flags. The result
  // is ADVISORY ONLY (see the epoch_stale branch below — detection,
  // never destruction): aad.epoch is SENDER-authored and the core check
  // is opt-in both sides, so a malicious sender simply omits it — this
  // only catches stale-but-honest envelopes. The actual control against
  // a removed member is body-layer key rotation (P0-G2 old-key disposal
  // + fresh-random rekey, audit #1): an old-epoch body fails decrypt
  // closed at the current group key (tamper → stash + key-request).
  // Do not cite this as enforcement.
  const aadExpectedEpoch = (() => {
    const gid = unwrapped.group?.groupId;
    if (!gid) {return undefined;}
    const g = useMessengerStore.getState().groups[gid];
    if (!g || typeof g.epoch !== 'number') {return undefined;}
    return Math.max(0, g.epoch - AAD_EPOCH_LAG);
  })();
  const aadCheck = verifySealedAad({
    sealed:                 unwrapped,
    selfUserId:             config.ownUserId,
    selfDeviceId:           config.signalDeviceId ?? 1,
    requireAad:             !SEALED_AAD_LEGACY,
    expectedSender:         peer,
    expectedConversationId,
    expectedGroupId:        unwrapped.group?.groupId,
    expectedEpoch:          aadExpectedEpoch,
  });
  if (!aadCheck.ok && aadCheck.reason === 'epoch_stale') {
    // #17 edge-review E — epoch_stale is DETECTION, never destruction.
    // Every membership op advances the epoch by TWO (op@E + rekey@E+1),
    // so lag 2 covers exactly ONE op: mail legitimately in flight across
    // two quick admin changes arrives 3+ behind, and the destroy arm
    // below would permanently kill it with a placeholder while the
    // sender is told `undelivered`. Leave-on-relay is no better: the
    // sealed epoch never changes and local epoch only grows, so it
    // would redeliver-loop until the 30-day dwell. Continue instead:
    // the BODY layer is the real control (a genuinely old-epoch body
    // fails decrypt at the current group key → tamper → stash +
    // key-request, the pre-#17 lane; replay noise is bounded by the
    // key-request cooldown). epoch_stale is the LAST core check, so
    // reaching it means recipient/ts/sender/conversation/group all
    // passed — continuing masks nothing else.
    crashLog(`[messenger] aad-epoch-stale ADVISORY (continuing) peer=${peer.userId.slice(0, 8)} env=${envelopeId?.slice(0, 8) ?? 'inline'}`);
    console.warn(`[messenger] sealed aad epoch behind local (advisory) peer=${peer.userId.slice(0, 8)}`);
  } else if (!aadCheck.ok) {
    // Drop the envelope. Surface a soft warning so the user can see
    // when sealed-sender binding catches something — security audits
    // need this signal.
    crashLog(`[messenger] aad-rejected reason=${aadCheck.reason} peerPrefix=${peer.userId.slice(0, 8)} env=${envelopeId?.slice(0, 8) ?? 'inline'}`);
    console.warn(`[messenger] sealed aad rejected reason=${aadCheck.reason} from peer=${peer.userId}`);
    console.log('[recv.branch] AAD_REJECT reason=' + aadCheck.reason);
    // BS-AADCLOCK / MSG-01 — the AAD carries a signed timestamp. After the
    // MSG-01 fix the STALE bound is the 30-day relay dwell (not ±15min), so
    // the two reasons now mean different things:
    //   `future` — timestamp is ahead of now beyond the future-skew window
    //     (SEALED_AAD_FUTURE_MS = 24 h, sealedSender.ts — B-316 audit found
    //     older comments still claiming ±15 min). That IS a device-clock
    //     problem and is actionable.
    //   `stale`  — timestamp is older than the 30-day relay dwell, i.e. the
    //     relay could never have legitimately held it this long. That's an
    //     expired/replayed envelope, NOT a clock issue and NOT actionable —
    //     drop it silently like an already-expired message. (Legitimately
    //     delayed offline/backlog messages within 30 days now PASS, which is
    //     the whole point of MSG-01: they used to be silently destroyed.)
    const ts = (unwrapped.aad as {ts?: number} | undefined)?.ts;
    const deltaSec = typeof ts === 'number' ? Math.round((Date.now() - ts) / 1000) : null;
    if (aadCheck.reason === 'future') {
      crashLog(`[messenger] aad-clock-skew reason=future deltaSec=${deltaSec ?? '?'} peer=${peer.userId.slice(0, 8)} env=${envelopeId?.slice(0, 8) ?? 'inline'}`);
      // M6 / B-139 — a `future` AAD timestamp is a CLOCK problem, not a verdict
      // about the envelope: the sender sent something legitimate and this
      // device's clock disagrees. The clean return below COMMITs and acks
      // `discarded`, which DELETES the envelope off the relay — so the message
      // was destroyed and only the RECEIVER was told, via a banner asking them
      // to "resend" something the SENDER has no idea failed.
      //
      // Throw instead: LeaveOnRelayError rolls the txn back (ratchet advance
      // and markSeen with it) and both ack sites already honour it by skipping
      // the ack, so the relay redelivers and a later drain succeeds once the
      // clocks agree. Bounded by the relay's 30-day dwell, not a retry budget.
      //
      // `stale` must NOT do this: it means older than that same 30-day dwell
      // (expired/replayed), so leaving it on the relay would retry a dead
      // envelope forever. The two branches are deliberately not merged.
      //
      // The banner stays: it is genuinely actionable, and now it is a warning
      // rather than an epitaph.
      useMessengerStore.getState().setError(
        'A message is waiting because a device clock looks wrong. Turn on automatic date & time on both phones.',
      );
      if (envelopeId) {
        throw new LeaveOnRelayError(envelopeId);
      }
      // No envelopeId (inline/loopback decode) — nothing to redeliver, so fall
      // through to the existing destroy path rather than looping.
    } else if (aadCheck.reason === 'stale') {
      // Silent — >30 days old (expired off the relay / replay). No user banner.
      crashLog(`[messenger] aad-stale deltaSec=${deltaSec ?? '?'} peer=${peer.userId.slice(0, 8)} env=${envelopeId?.slice(0, 8) ?? 'inline'}`);
    } else {
      useMessengerStore.getState().setError(`Dropped one envelope (sealed-sender ${aadCheck.reason})`);
    }
    // Handoff §3.6 — this clean return COMMITS the txn (ratchet advance
    // kept) and the caller acks, so the message is DESTROYED. Tell the
    // ack site the truth (disposition 'discarded' → sender sees
    // `undelivered`, not ✓✓) and leave a persistent gap marker in the
    // thread — except for `stale` (>30d replay/expired: not a live
    // conversation event, a placeholder would be noise).
    if (envelopeId) {
      noteDestroyedEnvelope({envelopeId, reason: `aad:${aadCheck.reason}`, peer});
      // Audit P2-9 — a blocked peer's failure must not resurrect the thread
      // via the placeholder row (the destroyed-note above stays: honest ack).
      if (aadCheck.reason !== 'stale' && !isPeerBlocked(peer.userId)) {
        const failedConvoId = unwrapped.group?.groupId
          ?? (require('../store/messengerStore') as typeof import('../store/messengerStore'))
            .resolveDirectConversationIdFromState(useMessengerStore.getState(), peer.userId);
        const placeholder = insertDecryptFailurePlaceholder({
          conversationId: failedConvoId, peer, envelopeId, reason: `aad:${aadCheck.reason}`,
        });
        frame?.assertLive(); // #12 rev-2 — awaits precede; no stray placeholder in a later frame's txn
        if (placeholder && sqlMessages) {await sqlMessages.upsert(placeholder);}
      }
    }
    return;
  }
  // M7: if the payload is already expired by the time it arrives
  // (offline backlog catch-up), drop it without showing the user.
  // B-316 — expiresAtSec carries the SENDER's clock; the gate's skew grace
  // keeps a fast receiver clock from destroying short-TTL messages on arrival.
  if (shouldDropExpiredPayload(unwrapped.expiresAtSec, Date.now())) {
    console.warn(
      `[recv.branch] EXPIRED expiresAtSec=${unwrapped.expiresAtSec} ` +
      `expiredBySec=${Math.round(Date.now() / 1000 - (unwrapped.expiresAtSec ?? 0))}`,
    );
    return;
  }

  // Rehandshake nudge: receiver-issued control envelope. The very
  // act of decrypting it (a fresh PreKeyWhisperMessage) caused
  // libsignal to session-replace our broken ratchet record above.
  // Nothing else to do — drop without rendering.
  if (unwrapped.control === 'rehandshake') {
    console.log('[recv.branch] CONTROL_REHANDSHAKE');
    // Signal resend protocol (flag-gated) — the peer telling us they rebuilt
    // their session is a strong signal they couldn't decrypt messages we sent.
    // Defer a re-transmit of our recent undelivered 1:1 messages to after the
    // txn commits (the factory handler owns the send stack). Default off.
    if (isResendProtocolEnabled()) {
      return {kind: 'resend-undelivered', peer};
    }
    return;
  }

  // Group-call identity envelope — peer telling us "my opaque SFU
  // tag X belongs to display name Y". Feed the per-room identity
  // registry so the active GroupCallScreen labels tiles with real
  // names. Discard without rendering — never a chat bubble.
  if (unwrapped.groupCallPresence) {
    console.log('[recv.branch] GROUP_CALL_PRESENCE');

    const {recordGroupCallIdentity} = require('../webrtc/groupCallIdentityRegistry') as typeof import('../webrtc/groupCallIdentityRegistry');
    recordGroupCallIdentity(
      unwrapped.groupCallPresence.roomId,
      unwrapped.groupCallPresence.participantTag,
      unwrapped.groupCallPresence.displayName,
      peer.userId,
    );
    return;
  }

  // Route by sealed group.groupId when present (group broadcast), else
  // resolve the 1:1 conversation id. The sender chose the conversation;
  // trust the sealed payload, not the hint (which is only used for
  // routing decrypt).
  //
  // Why: MessengerHomeScreen syncs `/conversations/mine` and stores each
  // row under the server-issued UUID. ChatScreen then subscribes to
  // `s.messages[<server-UUID>]`. The legacy fallback `convoIdFor(peer)`
  // returns `direct:<peer.userId>` — a synthetic id that does NOT match
  // the server UUID. With the synthetic id, every inbound text landed
  // in a different `s.messages` slot than the one ChatScreen was
  // watching, so bubbles never appeared and the home list never
  // reordered. (Outgoing texts and call records were fine because their
  // call sites passed the server UUID explicitly.) Look up the existing
  // direct conversation by peer.userId first; only synthesise the
  // legacy key when no server row exists.
  // Why: ChatScreen's conversationId varies by entry point:
  //   - Home list tap → server-UUID from /conversations/mine
  //   - NewChat / push tap / incoming call → synthetic `direct:<peer>`
  // The typing handler at line ~2918 writes to BOTH the synthetic key
  // AND fans out to every conversation whose participants includes the
  // sender — that's why typing renders for chats opened either way.
  // appendMessage has no such fan-out: it writes to exactly one key.
  // If that key doesn't match what ChatScreen subscribes to, the bubble
  // is lost. Field evidence (Pixel v1.0.38): typing rendered but text
  // didn't, because the home-list tap had the user on the server-UUID
  // slot while inbound went to the synthetic. Resolve to the server-
  // UUID direct conversation when one exists; fall back to synthetic
  // only for cold contacts not yet synced via /conversations/mine.
  // See resolveDirectConversationIdFromState's docstring for why this
  // is centralised. The same resolver is used by sendText so inbound
  // and outbound agree on which slot ChatScreen subscribes to.
  let conversationId: string;
  // B-124 §3.2 — ROUTING ONLY. Never adopt a device-local (`direct:`-shaped)
  // group id from the wire. Such an id names a DIFFERENT person on every
  // device: when the peer stamps `direct:<host>` after a 1:1 call is escalated,
  // that string names the HOST HIMSELF on the host's device. The host holds a
  // call-key alias there, so it decrypted, appended, and shadow-created a second
  // chat row that the home list then relabelled with the peer's name — the
  // duplicate thread the reporter sees, on the caller's device specifically.
  //
  // Safe by construction: verifySealedAad already ran above and derived BOTH of
  // its expected values from this same wire id, so rewriting the local routing
  // variable below it cannot produce a conversation_mismatch. Key lookup for the
  // group-text path still uses `unwrapped.group.groupId` — the key really does
  // live at that id; only the ROW moves to the real 1:1 slot.
  if (unwrapped.group?.groupId && !isDeviceLocalGroupId(unwrapped.group.groupId)) {
    conversationId = unwrapped.group.groupId;
  } else {
    const {resolveDirectConversationIdFromState: resolve} =
      require('../store/messengerStore') as typeof import('../store/messengerStore');
    conversationId = resolve(useMessengerStore.getState(), peer.userId);
    console.log('[recv.text.routing] peer=' + peer.userId.slice(0, 8) + ' convoId=' + conversationId.slice(0, 16) + ' isServerUuid=' + !conversationId.startsWith('direct:'));
  }

  // Audit MSG-02 (2026-07-02): a reaction carrying a group stamp is a
  // 1:1-PAIRWISE-encrypted CONTROL envelope (empty body) with a group ROUTING
  // hint — NOT a group-master-key-encrypted message. Handle it HERE, before
  // the group-parse path below (which would feed the empty body to
  // parseGroupMessage and drop it). Route applyReaction to the group
  // conversation so the author + every member see the reaction (previously it
  // landed in the reactor's 1:1 slot and was invisible to everyone else).
  // An edit / delete-for-everyone carrying a group stamp is the same shape as a
  // group reaction: a 1:1-PAIRWISE-encrypted CONTROL envelope (empty body) with
  // a group ROUTING hint, NOT a group-master-key-encrypted message. It must be
  // handled HERE, above the group-parse path below, which would feed the empty
  // body to parseGroupMessage and drop it.
  // Read the wire-compat carrier FIRST, then the top level. Group directives
  // ride inside `group` so older peers ignore rather than destroy them; 1:1
  // directives have no carrier and stay top-level. Accepting both also means a
  // peer mid-rollout that still emits the top-level shape keeps working.
  const wireEdit      = unwrapped.group?.edit      ?? unwrapped.edit;
  const wireDeleteFor = unwrapped.group?.deleteFor ?? unwrapped.deleteFor;
  const isMutationEnvelope =
    wireEdit !== undefined || wireDeleteFor !== undefined;
  if (isMutationEnvelope && unwrapped.group?.groupId) {
    await runMutationEnvelope({
      conversationId: unwrapped.group.groupId,
      peer, unwrapped, envelopeId, sqlMessages,
      groupState: useMessengerStore.getState().groups[unwrapped.group.groupId],
    });
    return;
  }

  if (unwrapped.reaction && unwrapped.group?.groupId) {
    // Seam S5 — group and 1:1 reactions now share ONE lane
    // (runtime/applyReactionLane.ts). They were identical apart from the
    // membership gate, and that difference was drift, not design: the group
    // lane only gained the gate at B-128, as a P1 security fix. Topology is now
    // a parameter (pass groupState for a group reaction, omit for 1:1), so the
    // B-128 gate and the M-07 blocked gate are enforced once, not once-and-
    // forgotten. The lane also owns the M9 awaited in-txn upsert.
    await applyReactionLane(
      {
        conversationId: unwrapped.group.groupId, peer,
        reaction:       unwrapped.reaction,
        envelopeId,
        groupState:     useMessengerStore.getState().groups[unwrapped.group.groupId],
        receivedAtMs:   typeof unwrapped.aad?.ts === 'number' ? unwrapped.aad.ts : Date.now(),
      },
      reactionLaneDeps(sqlMessages),
    );
    return;
  }

  // Group path — admin messages mutate group state, text messages
  // get unwrapped from the inner GroupMessageEnvelope (and decrypted
  // with the group master key when the body was wrapped by a master-
  // key-aware client). Legacy plaintext envelopes (server-created
  // mission groups before any admin create has been distributed) are
  // accepted as-is.
  if (unwrapped.group) {
    const store = useMessengerStore.getState();
    const existing = store.groups[unwrapped.group.groupId];
    const masterKey = existing?.masterKeyB64;
    const parseResult = await parseGroupMessage(unwrapped, masterKey);

    // Audit fix #27 — discriminated-union return. Distinguish:
    //   no_key  → admin create/rekey not yet processed. Bug-hunt #3:
    //             stash the ciphertext in the pending queue (durable
    //             SQLCipher row) and ack the relay. The next
    //             `applyAdminAction(create|rekey)` that commits a new
    //             masterKeyB64 for this group drains the row. Without
    //             the stash, the legacy fall-through wrote a
    //             ciphertext-JSON bubble and acked, losing the message
    //             when the create/rekey arrived seconds later.
    //   tamper  → groupDecrypt under our master key failed. The cert
    //             chain + sealed AAD were already verified upstream, so
    //             this is almost always KEY DIVERGENCE (a missed
    //             create/rekey fan-out or a stale epoch), NOT a forgery.
    //             MSG-01: do NOT silently drop-and-ack as final — that
    //             loses the message (the relay already ACKed on
    //             delivery). Stay fail-CLOSED (never render the
    //             ciphertext) but durably STASH the envelope on the SAME
    //             pending queue as no_key, so the next legitimate
    //             create/rekey that updates groups[groupId].masterKeyB64
    //             drains + re-decrypts it. Surface a recoverable
    //             "re-syncing" indicator. Recovery is the existing
    //             drain: the host's next create/rekey re-broadcasts the
    //             current key via the sealed fan-out. A genuine tamper
    //             keeps failing on replay and is dropped after
    //             PENDING_GROUP_MAX_ATTEMPTS — still fail-closed.
    //   malformed/not_group → fall through to legacy plaintext path
    //             (server-created mission groups before key
    //             distribution, ops/agent flow — these envelopes
    //             genuinely ship plaintext bodies)
    if (!parseResult.ok) {
      if (parseResult.reason === 'tamper' && pendingGroupEnvelopes && envelopeId) {
        // MSG-01 — recoverable key-divergence. Stash (same shape as the
        // no_key branch) instead of dropping; the create/rekey drain
        // re-decrypts once the correct master key lands.
        // B-262 — this branch deliberately does NOT noteDestroyedEnvelope: the
        // envelope is durably stashed and expected to recover, so it keeps the
        // honest `delivered` disposition. That is also why the relay hard-deletes
        // the server copy here (the stash ACKs it). B-262's containment lives in
        // the drain instead (surfaceUnrecoveredStash): if this row never
        // recovers, a VISIBLE, recoverable gap is left before it is reaped, so it
        // can no longer be ACKed-delivered-then-invisible. B-262: the deeper cure
        // (don't hard-delete the server copy for a divergence stash) is arch-gated
        // — it changes relay dwell/ack semantics — so it is intentionally not done
        // here.
        // #12 rev-2 (edge, WORST uncovered pair) — the stash row becomes the
        // ONLY surviving copy (stashing ACKs the relay). A stray INSERT in a
        // later frame's rolled-back txn = the row vanishes AND the relay was
        // told it was handled: permanent group-message loss.
        frame?.assertLive();
        await pendingGroupEnvelopes.stash({
          envelopeId,
          groupId:      unwrapped.group.groupId,
          peerUserId:   peer.userId,
          peerDeviceId: peer.deviceId,
          sealed:       unwrapped,
          receivedAtMs: Date.now(),
        });
        crashLog(
          `[group:recv] tamper (key divergence) — stashed for groupId=${unwrapped.group.groupId.slice(0, 8)} ` +
          `env=${envelopeId.slice(0, 8)} (awaiting create/rekey resync)`,
        );
        useMessengerStore.getState().setError(GROUP_KEY_DIVERGENCE_RECEIVE_ERROR);
        // Handoff §2.7-2 — make the thread visible (syncing) even when the
        // owner's `create` never landed, and make the row-walking self-heal
        // triggers reachable for this group.
        upsertKeylessGroupPlaceholder(unwrapped.group.groupId, peer);
        // Self-heal — actively ask the owner to re-share the current key
        // (post-txn; rate-limited in the handler) instead of waiting
        // passively for an unrelated create/rekey that may never come.
        // `fromPeer` breaks the no-row catch-22 (§2.5 Seam C).
        // GF-3 — `divergence` lets the resync bypass its keyless-only gate:
        // we HOLD a key here and it is exactly the wrong one.
        return {kind: 'request-group-key', groupId: unwrapped.group.groupId, fromPeer: {userId: peer.userId, deviceId: peer.deviceId}, divergence: true};
      }
      if (parseResult.reason === 'tamper') {
        // MSG-01 — the inner group-message integrity check (HMAC over the
        // group master key) failed. The drop is INTENTIONAL and stays
        // (fail-closed, per the security contract) — we do NOT decrypt or
        // surface a possibly-forged body. But the OLD behaviour was a
        // silent drop: no notification, the sender looked unanswered, and
        // there was no diagnostic breadcrumb to correlate "X stopped
        // receiving from Y". We now (1) surface a clearer, actionable
        // message to the user and (2) emit a durable crashLog breadcrumb
        // tagging the peer + group so a desync (stale epoch / rolled key
        // after a reinstall) is traceable in release builds. We do NOT
        // auto-rekey here — forcing a group rekey on an integrity failure
        // is a key-distribution change that needs architecture sign-off
        // (and would be abusable as a rekey-amplification vector).
        console.warn('[group:recv] tamper detected — dropping envelope from', peer.userId);
        crashLog(
          `[group:recv] tamper DROP peer=${peer.userId.slice(0, 8)} ` +
          `group=${unwrapped.group.groupId.slice(0, 8)} ` +
          `env=${envelopeId?.slice(0, 8) ?? '-'}`,
        );
        useMessengerStore.getState().setError(
          'A group message failed its integrity check and was not shown. ' +
          'If this keeps happening, ask the sender to resend.',
        );
        // Handoff §3.6 — terminal drop (no stash): the message is
        // destroyed. Honest disposition for the sender + a persistent
        // gap marker in the group thread (content is generic — never
        // renders anything derived from the rejected ciphertext).
        if (envelopeId) {
          noteDestroyedEnvelope({envelopeId, reason: 'group-tamper', peer});
          // Audit P2-9 — no placeholder resurrection for blocked senders.
          if (!isPeerBlocked(peer.userId)) {
            const placeholder = insertDecryptFailurePlaceholder({
              conversationId: unwrapped.group.groupId, peer, envelopeId, reason: 'group-tamper',
            });
            frame?.assertLive(); // #12 rev-2
            if (placeholder && sqlMessages) {await sqlMessages.upsert(placeholder);}
          }
        }
        return;
      }
      if (parseResult.reason === 'no_key' && pendingGroupEnvelopes && envelopeId) {
        // Bug-hunt #3.A — durable stash. Runs INSIDE the receive txn so
        // the stash row, `seen_envelopes.markSeen` (already executed
        // above before the cert verify), and the relay ack commit
        // atomically. A crash between them would otherwise leave us
        // with a "seen" envelope-id but no row to drain — and the
        // relay's already going to redeliver, which the seen-gate
        // would then mistakenly drop.
        frame?.assertLive(); // #12 rev-2 — same only-surviving-copy stakes as the no-key stash
        await pendingGroupEnvelopes.stash({
          envelopeId,
          groupId:      unwrapped.group.groupId,
          peerUserId:   peer.userId,
          peerDeviceId: peer.deviceId,
          sealed:       unwrapped,
          receivedAtMs: Date.now(),
        });
        crashLog(
          `[group:recv] no_key — stashed for groupId=${unwrapped.group.groupId.slice(0, 8)} ` +
          `env=${envelopeId.slice(0, 8)} (pending admin create/rekey)`,
        );
        // B-26(b) — the stash above is correct (fail-closed: we don't hold
        // the master key, so we never render the ciphertext), but the OLD
        // path returned SILENTLY. An established member who has lost the
        // group key then saw a blank thread with no explanation — the
        // message sits in the durable stash until an admin create/rekey
        // re-seeds the key (which, for a member who never persisted it,
        // needs an owner-side resync — a key-distribution change requiring
        // architecture sign-off; see B-26(a)). Surface the same visible
        // notice channel the tamper branch uses so the gap is explained,
        // not blank. The drain (replayGroupSealedDecode) fills the bubble in
        // once the key arrives — drainPendingGroupInner clears this exact
        // string back to null once that group's stash actually resolves
        // (B-213; store.error is global, so an un-cleared clear left the
        // banner stuck on every chat screen long after the sync finished).
        useMessengerStore.getState().setError(GROUP_KEY_PENDING_RECEIVE_ERROR);
        // Handoff §2.7-2 — a brand-new member has no inbox row yet (its only
        // writer is the owner's `create`, which may be lost/in-flight). Show
        // the thread in a syncing state so the group isn't invisible AND the
        // row-walking self-heal triggers (WS-connect resync, ChatScreen-open
        // resync) become reachable.
        upsertKeylessGroupPlaceholder(unwrapped.group.groupId, peer);
        // Self-heal — actively request a re-share from the owner/admins
        // (post-txn; rate-limited). The owner re-DELIVERS the current key
        // over a fresh pairwise session and the stash drains.
        // `fromPeer` breaks the no-row catch-22 (§2.5 Seam C).
        return {kind: 'request-group-key', groupId: unwrapped.group.groupId, fromPeer: {userId: peer.userId, deviceId: peer.deviceId}};
      }
      // malformed / not_group / (no_key with no stash store on loopback
      // runtime) → legacy plaintext path. Older clients (ops console,
      // server-created mission groups before key distribution) ship
      // plaintext bodies here.
      //
      // B-25 — a sender lacking the group master key ships the inner
      // GroupMessageEnvelope as PLAINTEXT JSON (send path:
      // `sealedBody = masterKey ? groupEncrypt(...) : innerEnvelope`).
      // parseGroupMessage returns `malformed` for it (Audit P0-G2 rejects
      // unencrypted kind:text at the crypto layer), so it lands here with
      // `unwrapped.body` holding the whole inner-envelope JSON string.
      // Rendering it verbatim showed raw JSON in the bubble and leaked the
      // internal groupId/clientMsgId. unwrapPlaintextGroupInnerBody pulls the
      // inner `.body` for THIS group; a genuine bare-string plaintext body
      // (ops/mission) passes through unchanged. Presentation only — the
      // crypto gate already ran and is not weakened.
      //
      // Audit P1-4 (2026-07-09) — membership gate for the legacy/malformed
      // fall-through. The P1-N4 isGroupMember drop below only guards the
      // master-key-decrypted path; without this gate any authenticated
      // sender (incl. a member removed via remove+rekey) could seal a
      // plaintext/malformed group body and have it RENDER into the group
      // thread — auto-creating the group row on devices that never joined.
      // When we hold local GroupState, require current membership; when we
      // don't, require the EXISTING conversation row's participant list to
      // contain the sender. Never auto-create a group row from this branch.
      {
        const legacySenderAllowed = existing
          ? isGroupMember(existing, peer.userId)
          : ((store.conversations[conversationId]?.participants ?? []).includes(peer.userId));
        if (!legacySenderAllowed) {
          console.warn(`[group:recv] DROP legacy text — peer=${peer.userId.slice(0, 8)} not a member of groupId=${unwrapped.group.groupId.slice(0, 8)}`);
          crashLog(`[group:recv] P1-4 legacy nonmember DROP peer=${peer.userId.slice(0, 8)} group=${unwrapped.group.groupId.slice(0, 8)} env=${envelopeId?.slice(0, 8) ?? '-'}`);
          // Honest disposition — deliberately dropped, will never render.
          if (envelopeId) {
            noteDestroyedEnvelope({envelopeId, reason: 'group-nonmember-legacy', peer});
          }
          return;
        }
      }
      // Audit P2-9 — blocked group senders don't render via the legacy
      // branch either. Mirrors the 1:1 M-07 drop: crypto/ratchet handling
      // already completed identically, only the render is suppressed.
      if (isPeerBlocked(peer.userId)) {
        console.log('[group:recv.legacy.blocked] peer=' + peer.userId.slice(0, 8));
        return;
      }
      // S4 — built by the ONE shared builder, like every other inbound lane.
      //
      // MSG-09 — this lane used to stamp `new Date()`, i.e. RECEIVE time. A
      // legacy-plaintext message that sat on the relay while the device was
      // offline therefore sorted to the BOTTOM of the thread, below messages
      // actually sent after it. It now derives created_at from the sender's
      // authenticated aad.ts like the other lanes, future-clamped (OM-02).
      const legacyMsg: LocalMessage = buildInboundMessage({
        env:            unwrapped as Parameters<typeof buildInboundMessage>[0]['env'],
        conversationId,
        peer,
        content:        unwrapPlaintextGroupInnerBody(unwrapped.body, unwrapped.group.groupId),
        createdAt:      sentAtFromAad(unwrapped.aad as {ts?: number} | undefined, serverTsMs),
        envelopeId,
        makeId,
      });
      // M8/M12 — persist the row the store ACTUALLY committed, not the one we
      // handed it. appendMessage can fork the id on a content-divergent
      // collision (the id is sender-supplied) and returns null when it deduped.
      // Upserting the pre-append object stored `X` on disk while memory held
      // `X#n`, and re-persisted rows the store had deliberately dropped — the
      // memory/disk divergence that made deleted duplicates reappear on every
      // restart.
      const legacyRowExisted = receiveRowExists(conversationId, legacyMsg.id); // B-703 MR-7
      const committedLegacyId = runWriteThroughSuppressed(() => store.appendMessage(conversationId, legacyMsg)); // AUDIT #13
      compensateReceiveAppend(conversationId, legacyMsg.id, legacyRowExisted, committedLegacyId);
      // Audit P0-N14 — synchronous persist BEFORE we exit the txn,
      // so the COMMIT flushes ratchet + plaintext together.
      frame?.assertLive(); // #12 rev-2 — a stray drain DELETE loses or double-applies a reaction
      if (committedLegacyId && sqlMessages) {await sqlMessages.upsert({...legacyMsg, id: committedLegacyId});}
      // SYNC-7 — replay any reaction that overtook this message, onto the
      // COMMITTED id (critic: this lane was the last one draining on the
      // pre-append id — the drain-by-committed-id convention is what the
      // other three lanes established).
      if (committedLegacyId) {
        await drainPendingReactionsFor(conversationId, committedLegacyId, sqlMessages);
        await drainPendingMutationsFor(
          conversationId, committedLegacyId, sqlMessages,
          useMessengerStore.getState().groups[conversationId],
        );
      }
      return;
    }
    const inner = parseResult.envelope;

    // B-333 — this payload just DECODED under our master key, so this device
    // is provably not key-blocked: retire the global "waiting for the group's
    // encryption key" banner if it is still up. The drain-side clear
    // (B-213/B-262a) only runs when a drain RUNS — orderings where the key
    // lands without a subsequent observed drain (the drainsInFlight skip race,
    // or a no_key set landing after the drain's clear) left the banner stuck
    // over a thread that was rendering fine (founder screenshot 2026-07-29).
    // Equality-guarded per variant: a real, different error survives.
    {
      const errStore = useMessengerStore.getState();
      if (
        errStore.error === GROUP_KEY_PENDING_RECEIVE_ERROR ||
        errStore.error === GROUP_KEY_DIVERGENCE_RECEIVE_ERROR
      ) {
        errStore.setError(null);
      }
    }

    if (inner.kind === 'admin' && inner.adminAction) {
      // Seam S5 — the group ADMIN lane lives in runtime/applyGroupAdmin.ts. It
      // owns key-request self-heal, the B-127 create gate (decideGroupCreate),
      // epoch monotonicity, the G-04 same-epoch heal, the MEDIUM-2 superseded
      // ledger, add/remove/rekey/rename/leave, and the stash for out-of-epoch
      // actions. Do not re-inline it: this is the branch that installs group key
      // material, so a second copy of these rules is a security divergence.
      const adminOutcome = await applyGroupAdmin(
        {
          action:            inner.adminAction,
          peer,
          existing,
          envelopeId,
          wireGroupId:       unwrapped.group?.groupId,
          senderIdentityKey: claims.senderIdentityKey,
        },
        {
          store:               useMessengerStore.getState(),
          getState:            () => useMessengerStore.getState(),
          ownStore,
          keys:                keys ?? null,
          peerIdentityCache,
          ownUserId:           config.ownUserId,
          pendingAdminActions,
          emitGroupKeySignal,
          crashLog,
        },
      );
      // The outcome type already includes `void`, so this one statement covers
      // both "post-txn work to do" and "admin messages don't render in the chat
      // list" — no extra bare exit, which the M10/W20 census counts.
      return adminOutcome;
    }

    // Audit P1-N4 — drop text envelopes from senders that aren't
    // members of the group at the receiver's CURRENT epoch.
    //
    // A removed member still holds the prior master key on their
    // device; if they queue a text envelope before being removed and
    // it arrives after the remove+rekey lands locally, parseGroupMessage
    // will FAIL to decrypt (we already rotated the key) and we drop
    // via `reason: 'tamper'` above. But two race windows still leak:
    //
    //   (a) The remove hasn't been processed yet on this receiver —
    //       parseGroupMessage decrypts under the OLD key. Without this
    //       gate the removed peer's late text would still render.
    //   (b) The sender is racing the admin event from a peer that
    //       hasn't applied `remove` yet (out-of-order delivery) and is
    //       broadcasting under the still-valid old key.
    //
    // Either way: a `text` envelope from someone NOT in `existing.members`
    // (at our current epoch) should drop silently. The cert chain says
    // the peer is who they claim to be, but they aren't a member, so
    // the message has no place in the group thread.
    // Seam S5 — the live sealed group text lane lives in
    // runtime/applyGroupText.ts. It owns the P1-N4 membership gate (with the
    // W11 honest disposition so a non-member drop acks 'discarded' rather than
    // a false ✓✓), the G-08 transcript-divergence diagnostic, the M-08
    // tombstone gate, the P2-9 blocked gate, and the M8/M12 committed-row
    // persist. Do not re-inline it.
    const groupOutcome = await applyGroupText(
      {
        env:     unwrapped as Parameters<typeof applyGroupText>[0]['env'],
        conversationId, peer,
        content: inner.body,
        envelopeId,
        existing,
        // OM-02 — keep the future-clamp the inline lane had.
        refTsMs: serverTsMs,
      },
      {
        isPeerBlocked,
        isRestoreTombstoned,
        noteDestroyed: noteDestroyedEnvelope,
        // AUDIT #13 — sync-bracketed: the lane's explicit upsert owns durability.
        appendMessage: (cid, m) => {
          const had = receiveRowExists(cid, m.id); // B-703 MR-7
          const committed = runWriteThroughSuppressed(() => useMessengerStore.getState().appendMessage(cid, m));
          compensateReceiveAppend(cid, m.id, had, committed);
          return committed;
        },
        upsert:        sqlMessages ? (m: LocalMessage) => sqlMessages.upsert(m) : null,
        makeId,
        crashLog,
        log:           (m: string) => console.log(m),
      },
    );
    if (groupOutcome.kind === 'appended' && groupOutcome.committedId) {
      // SYNC-7 — replay any reaction that overtook this message (a reaction is
      // pairwise, no group key needed, so it routinely beats the group text).
      frame?.assertLive(); // #12 rev-2
      await drainPendingReactionsFor(conversationId, groupOutcome.committedId, sqlMessages);
      await drainPendingMutationsFor(
        conversationId, groupOutcome.committedId, sqlMessages,
        useMessengerStore.getState().groups[conversationId],
      );
    }
    return;
  }

  // 1:1 edit / delete-for-everyone. Same lane; no groupState, so the membership
  // gate is skipped — a 1:1 has no membership concept and its conversation id is
  // resolved FROM the peer, so a peer cannot address someone else's thread.
  if (isMutationEnvelope) {
    await runMutationEnvelope({conversationId, peer, unwrapped, envelopeId, sqlMessages});
    return;
  }

  // Reaction envelopes don't create a new message — they patch an
  // existing one's `reactions` map. Body is empty in this branch.
  if (unwrapped.reaction) {
    // Same shared lane; no groupState, so the membership gate is skipped — a
    // 1:1 has no membership concept and its conversation id is resolved FROM
    // the peer, so a peer cannot address someone else's thread.
    await applyReactionLane(
      {
        conversationId, peer,
        reaction:     unwrapped.reaction,
        envelopeId,
        receivedAtMs: typeof unwrapped.aad?.ts === 'number' ? unwrapped.aad.ts : Date.now(),
      },
      reactionLaneDeps(sqlMessages),
    );
    return;
  }

  // Seam S5 — the 1:1 text lane lives in runtime/applyDirectText.ts. It owns the
  // row build (via the ONE shared builder), the M-07 blocked gate, the M-08
  // restore-tombstone gate, and the M8/M12 rule that we persist the row the
  // store COMMITTED rather than the object we built. Do not re-inline it: four
  // hand-rolled copies of this literal are exactly how the lanes drifted.
  const directOutcome = await applyDirectText(
    {
      env:     unwrapped as Parameters<typeof applyDirectText>[0]['env'],
      conversationId, peer,
      content: unwrapped.body ?? '',
      envelopeId,
      // OM-02 — keep the future-clamp the inline lane had.
      refTsMs: serverTsMs,
    },
    {
      isPeerBlocked,
      isRestoreTombstoned,
      // AUDIT #13 — sync-bracketed: the lane's explicit upsert owns durability.
      appendMessage: (cid, m) => {
        const had = receiveRowExists(cid, m.id); // B-703 MR-7
        const committed = runWriteThroughSuppressed(() => useMessengerStore.getState().appendMessage(cid, m));
        compensateReceiveAppend(cid, m.id, had, committed);
        return committed;
      },
      upsert:        sqlMessages ? (m: LocalMessage) => sqlMessages.upsert(m) : null,
      makeId,
      log:           (m: string) => console.log(m),
    },
  );
  if (directOutcome.kind === 'appended' && directOutcome.committedId) {
    // SYNC-7 — replay any reaction that overtook this message.
    frame?.assertLive(); // #12 rev-2
    await drainPendingReactionsFor(conversationId, directOutcome.committedId, sqlMessages);
    // 1:1 — no groupState, so the replay skips the membership gate exactly as
    // the live 1:1 lane does.
    await drainPendingMutationsFor(conversationId, directOutcome.committedId, sqlMessages);
  }
}

/**
 * M9 — the reaction lane's TIER-1 hook: fold a reaction patch into the target
 * message in the hydrated store window and hand the caller the row that was
 * actually committed to the store.
 *
 * Returning the patched LocalMessage (rather than void) is what lets the lane
 * persist it INSIDE the receive txn. A void tier 1 reached SQLCipher only via
 * the deferred 50 ms write-through subscriber — i.e. AFTER the txn committed
 * and AFTER the relay was acked — so a crash, or the rollback of an unrelated
 * later write in the same tick, could lose a reaction the sender had already
 * been shown ✓✓ for.
 *
 * Null does NOT mean drop. SYNC-7's durable tiers 2 and 3 (on-disk lookup, then
 * the pending stash) are wired into the lane as `resolveDurably`; a reaction is
 * a pairwise envelope with no group-key dependency, so it routinely overtakes
 * the group text it points at, and the envelope is already acked by then.
 *
 * The body lives in ./pendingReactionApply so the durable composite and this
 * hook share ONE implementation of the window patch.
 */
function applyReaction(
  conversationId: string,
  fromUserId:     string,
  targetMsgId:    string,
  emoji:          string,
  remove:         boolean,
): LocalMessage | null {
  return applyReactionInWindow(conversationId, fromUserId, targetMsgId, emoji, remove);
}

/**
 * ONE receive lane for edit + delete-for-everyone, shared by the group-stamped
 * and 1:1 call sites.
 *
 * A single entry point is not tidiness — it is the M5 rule. The two receive
 * paths that each hand-rolled their own copy of the cert block drifted into
 * four separate divergences (W8, W21, W22, W22a) before they were merged, and
 * the group reaction lane went months without the membership gate its 1:1 twin
 * did not need. `mutationLaneWiring.test.ts` asserts by source scan that both
 * call sites go through here, because no unit test in the node project can
 * import this file.
 *
 * The gate, the three resolution tiers and the stash all live in
 * `messageMutationApply` / `messageMutationGate`, which ARE unit-tested. This
 * function only translates the wire envelope into that call and decides the ack.
 *
 * M9 — the in-window apply persists through `sqlMessages.upsert` INSIDE the
 * receive txn, awaited, so the row is durable before COMMIT and before the ack.
 * M10 — this is a bare-return lane: it COMMITS and ACKs. A drop therefore owes
 * `noteDestroyedEnvelope` so the sender is told `discarded` rather than shown a
 * false ✓✓ for a directive that will never take effect (W11's rule).
 */
async function runMutationEnvelope(args: {
  conversationId: string;
  peer:           SessionAddress;
  unwrapped:      {
    edit?:      SealedPayload['edit'];
    deleteFor?: SealedPayload['deleteFor'];
    /** The wire-compat carrier — group directives ride in here. */
    group?:     {edit?: SealedPayload['edit']; deleteFor?: SealedPayload['deleteFor']} | null;
    aad?:       {ts?: number};
  };
  envelopeId:     string | undefined;
  sqlMessages:    SqlMessageStore | null;
  groupState?:    GroupState | undefined;
}): Promise<void> {
  const {conversationId, peer, unwrapped, envelopeId, sqlMessages, groupState} = args;
  // Carrier first, top level second — see the matching read in doHandleIncoming.
  const edit = unwrapped.group?.edit      ?? unwrapped.edit;
  const del  = unwrapped.group?.deleteFor ?? unwrapped.deleteFor;
  // Both set is a malformed sender: the two directives contradict each other
  // and there is no defensible merge. The delete wins — it is the safer of the
  // two to honour, and honouring the edit would leave content the peer may
  // already have retracted on their own device.
  const directive = del
    ? {kind: 'delete' as const, deletedAt: del.deletedAt}
    : {
        kind:     'edit' as const,
        body:     edit?.body ?? '',
        editedAt: edit?.editedAt ?? Date.now(),
        mentions: edit?.mentions,
      };
  const targetMsgId = del?.targetMsgId ?? edit?.targetMsgId;
  if (!targetMsgId) {return;}

  const outcome = await applyMessageMutation({
    conversationId,
    targetMsgId,
    fromUserId: peer.userId,
    directive,
    groupState,
    sqlMessages,
    receivedAtMs: typeof unwrapped.aad?.ts === 'number' ? unwrapped.aad.ts : Date.now(),
  });

  if (outcome.kind === 'applied' && outcome.patched && outcome.wasInWindow && sqlMessages) {
    // M9 — persist the row the store COMMITTED, inside this txn. The tier-2
    // (on-disk) branch has already written its own row inside applyMessageMutation.
    await sqlMessages.upsert(outcome.patched);
  }
  if (outcome.kind === 'dropped' && envelopeId) {
    noteDestroyedEnvelope({
      envelopeId,
      conversationId,
      peer,
      reason: `mutation-${outcome.reason}`,
    });
  }
  console.log(
    `[recv.mutation] kind=${directive.kind} outcome=${outcome.kind}` +
    (outcome.kind === 'dropped' ? ` reason=${outcome.reason}` : '') +
    ` target=${targetMsgId.slice(0, 8)}`,
  );
}

/**
 * Replay every outbox row that's due for a retry. Called on every
 * `socket.on('connect')` and once at startup (in case the previous
 * session crashed mid-send). Uses the HTTP relay path because:
 *   - It's synchronous: success/failure is immediate, no 5s watchdog.
 *   - It returns a server-side dedupe-friendly retractToken.
 *   - The WS path was the one that originally lost the message; not
 *     ideal to retry through the same fragile channel.
 *
 * Concurrency: serialised — multiple connect events would otherwise
 * each kick off their own drain and race on the same row. A
 * module-level boolean is the right size for this.
 */
// Why: OR-1 — a connectivity/foreground signal is the moment the offline
// backoff becomes meaningless, but socket.io flaps several times per handover,
// so the un-park is throttled while the drain itself stays unthrottled.
const OUTBOX_KICK_MIN_INTERVAL_MS = 15_000;
let lastOutboxKickAt = 0;
// Why: OM-07 — the un-park carries its OWN budget. A completed WS handshake is
// the only real proof of reachability, and the AppState/NetInfo kick that
// precedes it by a second or two must not spend the un-park's allowance: with a
// saturated soft ladder every pending row is parked a ceiling-interval (2 min) out, so a denied
// un-park leaves the head of the queue stalled under a live socket. Both
// budgets keep the same interval, so a flap storm still costs at most one
// un-park + one kick per 15 s (OM-07 §Risk's "per-connect timestamp" gate).
let lastOutboxUnparkAt = 0;
function kickAndDrainOutbox(
  outbox: SqlOutboxStore,
  relay:  RelayHttpClient,
  isOurEpoch: () => boolean,
  reseal?: ResealOutboxFn,
  opts?: {unpark?: boolean},
): void {
  const drain = (): void => {
    void drainOutboxWhenReady(outbox, relay, isOurEpoch, reseal)
      .catch(e => console.warn('[messenger.outbox] drain failed:', asErrorMessage(e)));
  };
  const now = Date.now();
  const doUnpark = opts?.unpark === true && now - lastOutboxUnparkAt >= OUTBOX_KICK_MIN_INTERVAL_MS;
  const doKick = now - lastOutboxKickAt >= OUTBOX_KICK_MIN_INTERVAL_MS;
  if (!doUnpark && !doKick) {
    drain();
    return;
  }
  if (doUnpark) { lastOutboxUnparkAt = now; }
  if (doKick) { lastOutboxKickAt = now; }
  void (async () => {
    // Why: OM-07 — a completed handshake proves reachability, so drop the
    // escalating soft backoff too; a plain connectivity edge only un-parks.
    if (doUnpark) {
      try { await outbox.clearUnreachableBackoff(); }
      catch (e) { console.warn('[messenger.outbox] unpark failed:', asErrorMessage(e)); }
    }
    if (doKick) {
      try { await outbox.kickPending(); }
      catch (e) { console.warn('[messenger.outbox] kickPending failed:', asErrorMessage(e)); }
    }
  })().finally(drain);
}

// Why: GF-1/XO-3 — a throttled/5xx submit carries Retry-After (usually <10s)
// but the only automatic cadence is the 60s outbox tick. Book one early,
// self-guarded re-entry instead of stranding the tail for a full minute.
const TRANSIENT_REDRAIN_MIN_MS = 2_000;
const TRANSIENT_REDRAIN_MAX_MS = 60_000;
let transientRedrainTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleTransientRedrain(
  outbox: SqlOutboxStore,
  relay:  RelayHttpClient,
  isOurEpoch: () => boolean,
  reseal: ResealOutboxFn | undefined,
  retryAfterMs?: number,
): void {
  if (transientRedrainTimer) {return;}
  const base = retryAfterMs && retryAfterMs > 0 ? retryAfterMs : 10_000;
  const delay = Math.min(Math.max(base, TRANSIENT_REDRAIN_MIN_MS), TRANSIENT_REDRAIN_MAX_MS)
    + Math.floor(Math.random() * 1_000);
  transientRedrainTimer = setTimeout(() => {
    transientRedrainTimer = null;
    if (!isOurEpoch()) {return;}
    void drainOutboxWhenReady(outbox, relay, isOurEpoch, reseal)
      .catch(e => console.warn('[messenger.outbox] re-drain failed:', asErrorMessage(e)));
  }, delay);
}

interface DrainOutboxArgs {
  outbox: SqlOutboxStore;
  relay:  RelayHttpClient;
  isOurEpoch: () => boolean;
  reseal?: ResealOutboxFn;
}
// Why: the pump is module-level (as `drainOutboxInflight` was), so it must read
// the CURRENT runtime's stores at pass start — a latched re-run that fires after
// a logout→login must use the new SQLCipher handle, not the closed one.
// OR-2 — DRAIN_STUCK_MS upgrades the in-flight latch to wall-clock ownership:
// a relay POST whose fetchWithTimeout abort timer is frozen by a locked screen
// never settles, and a latched slot would swallow every later drain for the
// whole lock. drainOutboxPass heartbeats per row, so a long queue of
// slow-but-alive rows is never mistaken for a wedge.
let drainOutboxArgs: DrainOutboxArgs | null = null;
const drainOutboxPump = createRerunCoalescer(async (ctx) => {
  const a = drainOutboxArgs;
  if (!a?.isOurEpoch()) {return;}
  await drainOutboxPass(a.outbox, a.relay, a.isOurEpoch, a.reseal, ctx);
}, MAX_COALESCER_RERUNS, DRAIN_STUCK_MS);

function drainOutbox(
  outbox: SqlOutboxStore,
  relay:  RelayHttpClient,
  isOurEpoch: () => boolean,
  reseal?: ResealOutboxFn,
): Promise<void> {
  if (!isOurEpoch()) {return Promise.resolve();}
  drainOutboxArgs = {outbox, relay, isOurEpoch, reseal};
  return drainOutboxPump();
}

/**
 * B-703 MR-12 — every drain waits for the message map before it can ship.
 *
 * Moving the boot kick below the hydrate closed one door of six: the WS connect
 * starts long before the SQLCipher block, and the `connected` / NetInfo /
 * AppState / server-signal / background kicks all gate on `sqlOutbox` alone,
 * which exists BEFORE the hydrate. A handshake landing in that window ships a
 * row whose 'sent' and envelope-id writes hit an empty store while
 * markDelivered durably drops it — and the MSG-07 sweep reds it.
 *
 * Bounded and fail-open (see the gate module): sending must never be hostage to
 * a hung read.
 */
async function drainOutboxWhenReady(
  outbox: SqlOutboxStore,
  relay:  RelayHttpClient,
  isOurEpoch: () => boolean,
  reseal?: ResealOutboxFn,
): Promise<void> {
  if (!isOurEpoch()) {return;}
  if (!areMessagesHydrated()) {await awaitMessagesHydrated();}
  // Re-check: hydration can take seconds, and a logout inside that window must
  // not let a dead runtime ship on the new owner's socket.
  if (!isOurEpoch()) {return;}
  return drainOutbox(outbox, relay, isOurEpoch, reseal);
}

async function drainOutboxPass(
  outbox: SqlOutboxStore,
  relay:  RelayHttpClient,
  isOurEpoch: () => boolean,
  reseal?: ResealOutboxFn,
  /** OR-2 — liveness/ownership channel from the coalescer. */
  coalescerCtx?: CoalescerRunCtx,
): Promise<void> {
  const rows = await outbox.dueRows();
  if (rows.length === 0) {return;}
  // GF-6 — partition into per-recipient lanes so one black-holing peer's 20s
  // transport timeout no longer head-of-line-blocks every other recipient.
  // Lane key === the SessionManager ratchet-mutex key, so parallel lanes can
  // never contend on the same Double Ratchet chain; per-peer order preserved.
  const lanes = groupRowsByPeer(rows);
  console.log(`[messenger.outbox] draining ${rows.length} row(s) across ${lanes.length} peer lane(s)`);
  const startedAtMs = Date.now();
  let unreachableStreak = 0;
  let processed = 0;
  // Why: GF-6 — sibling group-fanout rows share a clientMsgId; with lanes they
  // can settle out of order, so a terminal-failure row must not downgrade a
  // bubble a sibling already shipped in THIS pass (L17).
  const shippedThisPass = new Set<string>();
  // RT-3 — the per-row work is ONE lambda (route → re-seal/ship → record);
  // RT-4's lane scheduler drives it without touching the logic.
  type ShipOutcome = 'ok' | 'skipped' | 'unreachable' | 'transient' | 'rejected';
  const shipRow = async (row: OutboxRow): Promise<ShipOutcome> => {
    // RT-3 — routing (parse + deferred/stale-cert/legacy branching) moved into
    // the pure, unit-testable planOutboxDrain; the semantics are unchanged.
    const plan = planOutboxDrain(row.payload);
    if (plan.mode === 'drop') {
      // Corrupt / shapeless / unresealable-downgrade row — drop it so the
      // drain doesn't loop forever on it. Surface in logs (ids only).
      console.warn(`[messenger.outbox] dropping ${plan.reason} row ${row.clientMsgId}`);
      if (plan.reason === 'unresealable') {
        // L17 — never DOWNGRADE a bubble that already reached a peer.
        const cur = useMessengerStore.getState()
          .messages[row.conversationId]?.find(m => m.id === row.messageId);
        if (cur?.status === 'sending') {
          useMessengerStore.getState().updateMessageStatus(
            row.conversationId, row.messageId, 'failed',
          );
        }
      }
      await outbox.markDelivered(row.clientMsgId, row.peerUserId, row.peerDeviceId);
      return 'skipped';
    }
    try {
      // A4/SN-06/RT-3 — a DEFERRED row has no shippable bytes yet, and a
      // stale-cert row must not ship a dead envelope: re-seal now (fresh
      // session + cert + AAD timestamp) via the injected crypto callback. If
      // the callback is absent (no crypto context) leave the row for a drain
      // that has it. A re-seal throw (peer STILL unprovisioned) falls to the
      // catch below → recordAttempt → next drain.
      let outerSealed: string;
      let expiresAtSec: number | undefined;
      let urgent: boolean | undefined;
      // GF-2 — key-material rows have no bubble and must skip the store
      // updates below (notifyBackupDirty on a synthetic id would hand the
      // mirror an unresolvable messageId → bogus tombstone).
      let keyMaterial = false;
      // SYNC-1 — a group row is one leg of a fan-out: its envelopeId must be
      // attributed to the row's recipient, never overwrite the scalar.
      let legIsGroup = false;
      if (plan.mode === 'fail') {
        // Stale cert and nothing to re-mint from (pre-RT-3 row). Shipping
        // would be the silent-loss-behind-a-tick SN-06 exists to kill: fail
        // loudly into the budgeted retry path instead.
        throw new Error(`outbox_${plan.reason}`);
      } else if (plan.mode === 'reseal') {
        if (!reseal) { return 'skipped'; }
        if (plan.staleCert) {
          // warn, not log: release builds strip console.log
          // (transform-remove-console excludes only error/warn), and a
          // re-mint is a rare, operationally significant event we need to be
          // able to confirm from a release logcat.
          console.warn(`[messenger.outbox] re-sealing stale-cert row ${row.clientMsgId}`);
        }
        const sealedNow = await reseal(
          {
            peerUserId:   row.peerUserId,
            peerDeviceId: row.peerDeviceId,
            clientMsgId:  row.clientMsgId,
            // OM-05 — the row's compose moment rides into the re-sealed aad.ts.
            createdAt:    row.createdAt,
          },
          plan.payload,
        );
        outerSealed  = sealedNow.outerSealed;
        expiresAtSec = sealedNow.expiresAtSec;
        legIsGroup   = typeof plan.payload.groupId === 'string';
      } else {
        outerSealed  = plan.outerSealed;
        expiresAtSec = plan.expiresAtSec;
        urgent       = plan.urgent;
        keyMaterial  = plan.keyMaterial === true;
        legIsGroup   = typeof plan.groupId === 'string';
      }
      const r = await relay.send({
        recipient:    {userId: row.peerUserId, deviceId: row.peerDeviceId},
        outerSealed,
        clientMsgId:  row.clientMsgId,
        expiresAtSec,
        // Why: undefined for every pre-existing text row → JSON drops the key
        // → the server DTO default applies → byte-identical legacy behaviour.
        urgent,
        // OM-03 — group fan-out is submitted over HTTP with no live-socket
        // submitter mapping, so `envelope.delivered` can NEVER reach the
        // sender for a group leg (server-side; see envelope.service.ts
        // OM-03 comment) — the receipt-poll slot is the ONLY path a group
        // bubble has to ever leave single-tick. Park it for every real leg;
        // key-material rows have no bubble to advance.
        receipt: !keyMaterial ? true : undefined,
      });
      if (keyMaterial) {
        // B-703 MR-6 — same rule as the message branch below: the send
        // succeeded, so a failure deleting the local row may not be
        // re-classified as a send failure. It matters MORE here: a key-material
        // row has no bubble to turn red, so a burnt retry budget is invisible
        // and ends with a member who never receives the group key.
        try {
          await outbox.markDelivered(row.clientMsgId, row.peerUserId, row.peerDeviceId);
        } catch (e) {
          console.warn('[messenger.outbox] markDelivered failed AFTER a successful send:', asErrorMessage(e));
          // ...and BACK THE ROW OFF. Swallowing alone left next_retry_at where it
          // was, so the row stayed due and re-shipped on every single drain pass
          // (60 s timer, every socket connect, every NetInfo up-edge) until the
          // delete finally worked. Past the cert reseal margin each pass also
          // costs a cert fetch and a REAL ratchet advance for that peer, all
          // invisible because the bubble already reads 'sent'. Soft, so it still
          // spends no budget.
          await outbox.recordAttempt(row.clientMsgId, row.peerUserId, row.peerDeviceId, {transient: true})
            .catch(() => { /* best-effort: the next pass retries either way */ });
        }
        shippedThisPass.add(row.clientMsgId);
        return 'ok';
      }
      // Success — flip UI + drop the row. updateMessageStatus is
      // idempotent if the original send already flipped to 'sent'
      // (e.g. WS path won the race).
      useMessengerStore.getState().updateMessageStatus(
        row.conversationId, row.messageId, 'sent',
      );
      if (r.retractToken) {
        // SYNC-1 — a GROUP row is one leg of a fan-out: attribute the token
        // to its recipient (store first-wins-keeps) so it stays paired with
        // whichever leg's envelope_id also won the scalar below.
        useMessengerStore.getState().updateMessageRetractToken(
          row.conversationId, row.messageId, r.retractToken,
          legIsGroup ? row.peerUserId : undefined,
        );
      }
      // Audit MSG-03 — record the envelopeId so delivered/read ticks fire
      // for outbox-drained (reconnect) sends too. SYNC-1 — a GROUP row is
      // one leg of a fan-out: attribute the id to its recipient instead of
      // overwriting the scalar another leg already seeded.
      if (r.envelopeId) {
        useMessengerStore.getState().updateMessageEnvelopeId(
          row.conversationId, row.messageId, r.envelopeId,
          legIsGroup ? row.peerUserId : undefined,
        );
      }
      // B-703 MR-6 — the SEND already succeeded. A failure deleting the local
      // row must not be re-classified as a send failure: inside the try it
      // charged an attempt against the retry budget, and with repeated database
      // trouble it could walk an already-delivered message all the way to a
      // terminal red chip. Leaving the row is harmless — the next drain
      // re-ships the SAME clientMsgId and the relay's dedup memo answers with
      // the original accept, so there is no second copy on the wire.
      try {
        await outbox.markDelivered(row.clientMsgId, row.peerUserId, row.peerDeviceId);
      } catch (e) {
        console.warn('[messenger.outbox] markDelivered failed AFTER a successful send:', asErrorMessage(e));
        // ...and BACK THE ROW OFF (see the key-material branch above): swallowing
        // alone left next_retry_at untouched, so the row stayed due and re-shipped
        // on every drain pass forever. Soft, so it still spends no budget.
        await outbox.recordAttempt(row.clientMsgId, row.peerUserId, row.peerDeviceId, {transient: true})
          .catch(() => { /* best-effort: the next pass retries either way */ });
      }
      shippedThisPass.add(row.clientMsgId);
      return 'ok';
    } catch (e) {
      // Why: SN-04 + XO-3 — neither an unreachable device nor a relay that
      // answered "later" (5xx, its own 429 throttle, or a missing access token)
      // may consume the retry budget; that budget is reserved for semantic
      // rejections a retry cannot fix.
      const f = classifyOutboxFailure(e);
      const {attempts, failed} = await outbox.recordAttempt(
        row.clientMsgId, row.peerUserId, row.peerDeviceId,
        {
          unreachable: f.kind === 'unreachable',
          transient:   f.kind === 'server-transient',
          deferMs:     f.retryAfterMs,
          permanent:   isPermanentRelayRejection(e),
        },
      );
      console.warn(`[messenger.outbox] retry failed clientMsgId=${row.clientMsgId} peer=${row.peerUserId}/${row.peerDeviceId} attempts=${attempts} class=${f.kind} status=${f.status} terminal=${failed}: ${asErrorMessage(e)}`);
      if (failed) {
        // L17 — don't DOWNGRADE a bubble that already reached at least one
        // peer. In a group, one permanently-unprovisioned member exhausting
        // MAX_ATTEMPTS must not flip the whole message to 'failed' when the
        // other members received it (the send path already set 'sent', or a
        // sibling peer-row drained to 'sent'). Only surface 'failed' when the
        // message never reached anyone — i.e. it is still 'sending'.
        const cur = useMessengerStore.getState()
          .messages[row.conversationId]?.find(m => m.id === row.messageId);
        if (!shippedThisPass.has(row.clientMsgId) && cur?.status === 'sending') {
          useMessengerStore.getState().updateMessageStatus(
            row.conversationId, row.messageId, 'failed',
          );
        }
      }
      if (f.kind === 'server-transient') {
        // Why: XO-3 — every remaining row hits the same wall (relay down, or
        // the per-user submit window is closed) and hammering deepens it. Stop
        // the sweep and re-enter when the server said we may resume.
        scheduleTransientRedrain(outbox, relay, isOurEpoch, reseal, f.retryAfterMs);
        return 'transient';
      }
      return f.kind === 'unreachable' ? 'unreachable' : 'rejected';
    }
  };
  let sweepAbortLogged = false;
  await runOutboxLanes(lanes, OUTBOX_DRAIN_LANE_LIMIT, async row => {
    if (!isOurEpoch()) {return 'stop';}
    // OR-2 — a superseded (stuck) drain stops here rather than racing the
    // drain that took its slot; each row refreshes the liveness stamp.
    if (coalescerCtx?.superseded()) {return 'stop';}
    coalescerCtx?.heartbeat();
    // Why: OM-07 — each send can hang for the full 20s transport deadline, so
    // an unbounded sweep holds the radio and restarts immediately. The budget
    // is shared across lanes; skipped rows keep their next_retry_at and are
    // still due on the next tick — nothing is lost.
    const stop = shouldStopDrain({startedAtMs, unreachableStreak});
    if (stop !== 'continue') {
      if (!sweepAbortLogged) {
        sweepAbortLogged = true;
        console.warn(`[messenger.outbox] sweep aborted (${stop}) after ${processed}/${rows.length} row(s)`);
      }
      return 'stop';
    }
    processed += 1;
    const outcome = await shipRow(row);
    if (outcome === 'transient') { return 'stop'; }
    if (outcome === 'unreachable') { unreachableStreak += 1; }
    else if (outcome !== 'skipped') { unreachableStreak = 0; }
    return 'continue';
  });
}

/**
 * B-155 F3 — run `fn` once the UI is idle rather than during boot.
 *
 * `runAfterInteractions` fires after any in-flight gesture/animation settles,
 * which at boot means the next frame. Used for one-shot catch-up work that is
 * already fire-and-forget, so that it competes with neither the first paint nor
 * the relay drain.
 *
 * Falls back to running INLINE when there is no RN runtime (loopback, node
 * tests). Deferred work must never silently vanish — a swallowed stash replay
 * would look exactly like message loss.
 */
function deferToIdle(fn: () => void): void {
  try {
    const {InteractionManager} = require('react-native') as typeof import('react-native');
    // `void` — runAfterInteractions returns a cancellable promise-like we
    // deliberately do not track: the callback owns its own error handling and
    // there is no caller to await it.
    void InteractionManager.runAfterInteractions(fn);
  } catch {
    fn();
  }
}

/**
 * B-155 — how long the drain may hold the JS thread before letting the UI run.
 * ~One 60fps frame: long enough that the yield overhead stays negligible on a
 * big page, short enough that a touch is never queued behind more than a frame
 * of crypto.
 */
const DRAIN_SLICE_MS = 12;

/**
 * B-155 — hand the JS thread back to the event loop for one macrotask.
 *
 * `setTimeout(0)` (not a bare `await`, not `Promise.resolve()`): only a
 * macrotask boundary lets React Native's pending touch/timer/layout callbacks
 * run. A microtask hop keeps the thread and changes nothing.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>(resolve => { setTimeout(resolve, 0); });
}

async function drainRelay(
  own: SessionManager,
  ownStore: CryptoStore,
  relay: RelayHttpClient,
  config: ProductionConfig,
  keys?: KeysHttpClient,
  nudgeAfterRebuild?: (peer: SessionAddress) => void | Promise<void>,
  /** Fix #11: passed through to handleIncoming for identity-cache eviction. */
  peerIdentityCache?: PeerIdentityCache,
  /** Audit P0-N14 — shared SQLCipher handle for atomic receive. */
  txnDb?: TxnDbHandle | null,
  sqlMessages?: SqlMessageStore | null,
  /** Audit P0-N6 — persistent receive-side dedup. */
  seenEnvelopes?: SeenEnvelopeStore | null,
  /** Audit 1:1 P1-1 — cert revocation cache. */
  revokedJtiCache?: RevokedJtiCache | null,
  /** Bug-hunt #3 — pending stash threaded through to handleIncoming. */
  pendingGroupEnvelopes?: PendingGroupEnvelopeStore | null,
  pendingAdminActions?: PendingAdminActionStore | null,
): Promise<RelayPullReport> {
  // Fix #5: paginate. The previous version pulled ONCE with limit=50
  // and returned even when the server still had a backlog (e.g. user
  // was offline for a week and 200 envelopes piled up). Loop until
  // the server returns an empty page, with a hard cap of 10 iters
  // (= 500 envelopes) to avoid runaway if ack is silently failing.
  //
  // Restore-after-reinstall fix #4 — on the very first drain after a
  // fresh install (the AsyncStorage `bravo.relay.bootstrap-done` flag
  // is unset for this owner), pull with `bootstrap=true` so the server
  // raises the per-call cap to relay.maxBootstrapLimit (default 1000)
  // instead of the steady-state 100. Closes the gap where a multi-week
  // backlog only delivered the most-recent slice on a reinstall.
  const HARD_CAP_ITERATIONS = 10;
  const ownIdentity = await ownStore.getIdentityKeyPair();

  let bootstrap = false;
  const bootstrapKey = `bravo.relay.bootstrap-done.${config.ownUserId}`;
  try {
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    const flag = await AsyncStorage.getItem(bootstrapKey);
    bootstrap = flag !== '1';
  } catch { /* AsyncStorage unavailable in tests — treat as not-bootstrap */ }

  // Why: B-315 — in-run paging cursor. The pull always started from the head,
  // and only an ack deletes: a head page stuck on leave-on-relay branches
  // starved every envelope behind it (the founder's "page made no progress"
  // capture). The cursor lets THIS run step past a stuck page; each new run
  // starts back at 0, so stuck envelopes are still retried on every drain.
  let cursorTs = 0;
  // B-703 MR-1 — drain-wide accounting so the caller can tell "ingested what it
  // pulled" from "left real envelopes behind". BY ID, not by count: a page that
  // does not fill its limit is re-pulled on the next iteration (the cursor
  // deliberately does not advance and acks flush on a timer), so counters would
  // inflate up to 10x and a re-acked envelope could mask a stuck one.
  // Accumulated once per page, below the envelope loop, so every exit path
  // (empty page, stuck page, hard cap) reports the same way.
  const pulledIds  = new Set<string>();
  const ackedIds   = new Set<string>();
  const skippedIds = new Set<string>();
  const drainTotals = async (): Promise<RelayPullReport> => {
    // A 'skipped' envelope was held by a CONCURRENT pass — but that pass owns
    // it only if it actually ingested it, and the WS lane has its own
    // leave-on-relay arms (first-message recovery, transient-sql). An envelope
    // that was skipped here and never marked seen was ingested by nobody, so it
    // must count as left behind or the wake reports a clean drain and goes
    // silent. Unknown (a throwing dedup read) resolves the same way: not seen.
    if (seenEnvelopes) {
      for (const id of skippedIds) {
        if (ackedIds.has(id)) {continue;}
        // Still held ⇒ that pass owns it and is mid-flight; `markSeen` has not
        // committed yet, so asking the dedup store here would demote a healthy
        // concurrent deliver and make the wake post a generic banner that then
        // gags the named one that pass is about to draw.
        if (isEnvelopeInFlight(id)) {continue;}
        // W8 / M5 D1 shape: the dedup read resolves into a local flag inside
        // the try, never inline in the `if`. A throw then degrades this one
        // envelope to "not ingested" instead of unwinding the whole report.
        let ingestedElsewhere = false;
        try {
          ingestedElsewhere = await seenEnvelopes.wasSeen(id);
        } catch (e) {
          crashLog(`[messenger] drain skip-recheck wasSeen threw env=${id.slice(0, 8)} err=${asErrorMessage(e).slice(0, 120)}`);
        }
        if (!ingestedElsewhere) {skippedIds.delete(id);}
      }
    }
    return pullReportFromIds({pulled: pulledIds, acked: ackedIds, skipped: skippedIds});
  };
  for (let iter = 0; iter < HARD_CAP_ITERATIONS; iter++) {
    const pageLimit = (bootstrap && iter === 0) ? 1000 : 50;
    const {envelopes} = await relay.pull({
      after:     cursorTs,
      limit:     pageLimit,
      bootstrap: bootstrap && iter === 0,
    });
    if (envelopes.length === 0) {
      // Mark bootstrap-done on the FIRST successful empty drain.
      if (bootstrap) {
        try {
          const AsyncStorage = require('@react-native-async-storage/async-storage').default;
          await AsyncStorage.setItem(bootstrapKey, '1');
        } catch { /* ignore */ }
      }
      return drainTotals();
    }
    // B-126 — per-page progress accounting: every enqueueAck counts (only
    // an ack changes what the next pull returns); skips and leave-on-relay
    // don't. A zero-progress page ends the drain loudly below.
    let pageProgressed = 0;
    let pageSkipped = 0;
    let sliceStartedAtMs = Date.now();
    for (const env of envelopes) {
      // B-155 — cooperative yield. Everything below (sealed-sender unwrap on
      // pure-JS curve25519, cert admission, the txn-chain-serialised libsignal
      // decrypt, the store commit) runs on the JS thread, and `await` only
      // creates MICROtask boundaries — RN's touch, timer and layout callbacks
      // are macrotasks, so they get no slot until the whole page is drained.
      // A first-boot page is up to 1000 envelopes and every reconnect page up
      // to 50 × 10, which is how a catch-up froze the UI for tens of seconds.
      //
      // Time-sliced rather than every-Nth: envelope cost varies by two orders
      // of magnitude (a `wasSeen` hit versus an X3DH session build), so a fixed
      // stride either over-yields on cheap pages or under-yields on expensive
      // ones. One macrotask hop per ~frame is the smallest thing that lets the
      // UI breathe.
      //
      // Placed at the TOP of the body, so it is OUTSIDE the in-flight hold
      // taken below, outside the receive transaction, and never between an
      // envelope's decrypt and its ack — ack/dwell semantics are untouched
      // (CLAUDE.md stop-condition). It adds no new epoch-flip window either:
      // the body already awaits the network and SQLCipher several times.
      if (Date.now() - sliceStartedAtMs >= DRAIN_SLICE_MS) {
        await yieldToEventLoop();
        sliceStartedAtMs = Date.now();
      }
      // W22a (M5 D2) — take the in-flight hold at the TOP of the body, where the
      // WS path already takes it (handleDeliver, its outermost wrapper). The
      // drain used to take it ~150 lines lower, AFTER unwrapOuter, AFTER the
      // wasSeen dedup and AFTER the whole v3 cert pre-verify block, so a WS
      // deliver and an HTTP drain of the same envelope could concurrently
      // unwrap, verify the cert and fire refreshPeerIdentityIfRotated — a
      // duplicate keys-service fetch and a duplicate identity write. Only
      // handleIncoming was serialised, so this was duplicated WORK, never a
      // double-ratchet and never message loss.
      //
      // Audit L16 (2026-07-02) is the reason the hold exists at all: the relay's
      // flushPendingOnConnect re-pushes queued envelopes over the WS at the SAME
      // time this HTTP drain runs, and both only consult the persistent
      // wasSeen() (which commits at the END of the receive txn).
      //
      // The ENTIRE body is wrapped in ONE try/finally rather than releasing at
      // each exit, and that is why this item was deferred three times: the
      // unwrap, dedup and cert blocks contain many `continue`s that previously
      // ran BEFORE the acquire and so owed no release. Hand-auditing them is how
      // you miss one, and a missed release strands the envelope until the
      // registry's stale deadline. A `continue` inside a `try` still runs the
      // `finally`, so one wrapper is exhaustive by construction.
      //
      // B-126 — the skip is COUNTED (it used to be a silent `continue`, which
      // hid the wedge entirely) and the registry evicts stale holds so a wedged
      // frame can't make redelivery a permanent no-op.
      // B-703 MR-1 — id accounting. Recorded here and in the `finally` below,
      // DERIVED from the same counters the page-progress rule already keeps, so
      // a new leave-on-relay branch lands in "left behind" by construction: a
      // branch that neither acks nor skips simply records nothing.
      pulledIds.add(env.envelopeId);
      const ackedBefore = pageProgressed;
      const drainHold = tryAcquireEnvelope(env.envelopeId);
      // The one body exit ABOVE the try/finally, so it records its own skip.
      if (drainHold === 'busy') { pageSkipped += 1; skippedIds.add(env.envelopeId); continue; }
      try {
      let unwrapped;
      try {
        unwrapped = await unwrapOuter({
          ownIdentityPrivKey: ownIdentity.privKey,
          ownIdentityPubKey:  ownIdentity.pubKey,
          outerSealedB64:     env.outerSealed,
        });
      } catch (e) {
        // Drop unrecoverable envelopes — happens if a v1 message somehow
        // lingered past the rollout window or another client minted with
        // the wrong recipient key. ACK so we don't loop on the next pull.
        //
        // Diagnostic breadcrumb — same site as handleDeliver's unwrap
        // failure but on the HTTP catch-up path; correlate the two
        // counters in Crashlytics to know whether drops are biased to
        // push-deliver vs pull-deliver.
        crashLog(`[messenger] drainRelay-unwrap-failed envId=${env.envelopeId.slice(0, 8)} err=${asErrorMessage(e).slice(0, 120)}`);
        console.warn('[messenger] drainRelay unwrap failed', asErrorMessage(e));
        // Fix #5 — count toward the "missing-ratchet" telemetry.
        try {
          const {noteUndecryptable} = require('../backup/sessionRatchetRecovery') as
            typeof import('../backup/sessionRatchetRecovery');
          noteUndecryptable(`drain-unwrap:${asErrorMessage(e).slice(0, 40)}`);
        } catch { /* module not loaded yet — fine */ }
        // B-46 — surface the silent destruction (sender unknowable —
        // sealed wrap — so a banner count is the disclosure ceiling).
        try { useMessengerStore.getState().noteUndecryptableDrop(env.envelopeId); } catch { /* store mid-swap — fine */ }
        // 'discarded' — destroyed, sender unknown (inside the broken wrap).
        enqueueAck(relay, {envelopeId: env.envelopeId, ackToken: env.ackToken ?? '', disposition: 'discarded'});
        pageProgressed += 1;
        continue;
      }
      // Audit P0-N6 — dedup gate on the HTTP catch-up path too. The
      // bootstrap drain (or the post-reconnect coalesced drain) is
      // exactly when the relay's flushPendingOnConnect re-pushes
      // every queued envelope, so without this we'd double-decrypt
      // the same ciphertext and corrupt the ratchet.
      // W8 (M5 D1) — the dedup READ must be fault-tolerant, exactly as the WS
      // path already makes it. A throw from wasSeen() (SQLCipher not yet open on
      // a fresh-install race, a migration in flight, a native-bridge blip) does
      // not skip one envelope here: it unwinds the envelope loop AND the page
      // loop, straight out of drainRelay into a warn-only .catch at the call
      // site. Every remaining envelope in the page — up to 1000 on bootstrap —
      // plus every later page is abandoned unacked and silent, on the exact path
      // a user hits after being offline.
      //
      // Degrading to "assume unseen and re-decrypt" is safe: libsignal's own
      // message-key dedup already covers a duplicate decrypt attempt, so the
      // worst case is wasted work rather than lost mail.
      let alreadySeen = false;
      if (seenEnvelopes) {
        try {
          alreadySeen = await seenEnvelopes.wasSeen(env.envelopeId);
        } catch (e) {
          crashLog(`[messenger] drain seenEnvelopes.wasSeen threw env=${(env.envelopeId ?? '?').slice(0, 8)} err=${asErrorMessage(e).slice(0, 120)}`);
        }
      }
      if (alreadySeen) {
        // Seen ⇒ a prior receive txn committed — honest 'delivered'.
        enqueueAck(relay, {envelopeId: env.envelopeId, ackToken: env.ackToken ?? '', disposition: 'delivered'});
        pageProgressed += 1;
        continue;
      }
      // Audit P0-1 — same pre-decrypt cert verify as the WS deliver path
      // (see handleDeliver). On v3 wraps the outer GCM tag already
      // proved the cert in the wire matches what the sender used to
      // derive the AAD; we additionally verify the authority signature
      // (and identity continuity when we have a trust anchor) BEFORE
      // any decrypt is attempted. A bad cert drops the envelope here
      // without exposing the closeSession path.
      // M5 — the SAME admission decision the WS path uses. This was a second
      // ~75-line copy that had already drifted from it. The helper decides; this
      // loop still owns its own ack style (`continue` + pageProgressed), which is
      // exactly why the helper never touches the relay itself.
      const drainCertVerdict = await admitSenderCert(unwrapped, {
        ownStore,
        keys,
        peerIdentityCache,
        authorityPubKeyB64: config.authorityPubKeyB64,
        revokedJtis:        revokedJtiCache?.isFresh() ? revokedJtiCache.snapshot() : undefined,
        envelopeId:         env.envelopeId,
        tag:                'drain',
      });
      if (drainCertVerdict.kind === 'leave-on-relay') {continue;}
      if (drainCertVerdict.kind === 'ack-discard') {
        enqueueAck(relay, {envelopeId: env.envelopeId, ackToken: env.ackToken ?? '', disposition: 'discarded'});
        pageProgressed += 1;
        continue;
      }
      const drainTrustedPeer = drainCertVerdict.trustedPeer;

      // P0-1 Layer A — wrap handleIncoming so a single bad envelope
      // can't kill the entire drain. The previous code let any throw
      // (including the recoverable `sender identity key mismatch`)
      // propagate up; the drain's outer catch then logged the failure
      // ONCE and abandoned every later envelope in the same page. With
      // 1000-envelope bootstrap pulls this was a guaranteed silent
      // truncation after any peer rotated identity. See bravo_log_5564
      // / 5554 (May 23) for the live repro.
      //
      // On `IdentityKeyMismatchError`: refetch the peer's bundle from
      // the keys-service. If keys-service confirms the cert's claimed
      // identity, update local trust + retry handleIncoming ONCE under
      // the refreshed key. Cap at one retry to avoid loops.
      // W22a — the in-flight hold that used to be taken here now covers the
      // whole loop body (see the top of the loop); this is just the decrypt.
      let handled = false;
      try {
        await handleIncoming(
          own, ownStore, drainTrustedPeer, unwrapped.ciphertext, config,
          env.envelopeId, keys, nudgeAfterRebuild, peerIdentityCache,
          txnDb ?? null, sqlMessages ?? null, seenEnvelopes ?? null,
          pendingGroupEnvelopes ?? null, pendingAdminActions ?? null,
          // OM-02 — the relay's accept timestamp (display-ordering clamp only).
          env.timestamp,
        );
        handled = true;
      } catch (e) {
        // B-30 — first-message recovery asked to leave this envelope on the
        // relay for a bounded redelivery; skip the ack below so the next pull
        // re-fetches it (the session rebuild was kicked off in handleIncoming).
        if (e instanceof LeaveOnRelayError) {
          console.warn(`[messenger] drain first-msg leave-on-relay env=${env.envelopeId.slice(0, 8)}`);
          continue;
        }
        // Audit P0-1(b) — transient LOCAL SQL failure (nested-txn collision,
        // SQLITE_BUSY/locked, disk I/O pressure): the receive txn rolled back
        // and the relay still holds the envelope, so skip the ack (the next
        // drain redelivers) instead of ack-`discarded` destroying it.
        if (isTransientSqlError(e)) {
          crashLog(`[messenger] drain transient-sql leave-on-relay env=${env.envelopeId.slice(0, 8)} err=${asErrorMessage(e).slice(0, 120)}`);
          continue;
        }
        // IdentityKeyMismatchError is imported at the top of the file
        // for the P0-1 pre-decrypt cert verify path; reuse the same
        // binding here instead of the legacy require.
        if (e instanceof IdentityKeyMismatchError) {
          const {refreshPeerIdentityIfRotated} = require('../crypto/peerIdentityRefresh') as
            typeof import('../crypto/peerIdentityRefresh');
          const outcome = await refreshPeerIdentityIfRotated(
            e.claims.senderUserId,
            e.claims.senderSignalDeviceId,
            e.claims.senderIdentityKey,
            keys,
            ownStore,
          );
          crashLog(`[messenger] drain-identity-rotation envId=${env.envelopeId.slice(0,8)} outcome=${outcome.result} reason=${outcome.reason ?? '-'}`);
          if (outcome.result === 'refreshed' && outcome.sessionReset) { void notePeerIdentityChanged(e.claims.senderUserId); }
          if (outcome.result === 'refreshed') {
            // Also evict the in-memory cache so subsequent sends use
            // the freshly-stored identity straight away.
            try {peerIdentityCache?.delete(peerIdentityCacheKey({userId: e.claims.senderUserId, deviceId: e.claims.senderSignalDeviceId}));} catch { /* ignore */ }
            // BS-IDKEY — surface the rotation to the user (Signal/WhatsApp
            // "safety number changed" model). The rotation is authority-
            // confirmed so we trust it, but the user should SEE that the
            // peer's keys changed rather than have it happen invisibly.
            if (outcome.sessionReset) {
              try {
                useMessengerStore.getState().setError(
                  'A contact’s security code changed — their messages will resume on a new secure session.',
                );
              } catch { /* ignore */ }
            }
            try {
              // Audit P0-1 — peer address comes from the now-refreshed
              // authority claims, not the inner forgeable `s` field.
              const refreshedPeer = {
                userId:   e.claims.senderUserId,
                deviceId: e.claims.senderSignalDeviceId,
              };
              await handleIncoming(
                own, ownStore, refreshedPeer, unwrapped.ciphertext, config,
                env.envelopeId, keys, nudgeAfterRebuild, peerIdentityCache,
                txnDb ?? null, sqlMessages ?? null, seenEnvelopes ?? null,
                pendingGroupEnvelopes ?? null, pendingAdminActions ?? null,
                env.timestamp,
              );
              handled = true;
            } catch (e2) {
              // BS-IDKEY — EXPECTED when sessionReset fired: the envelope
              // that carried the rotation was sealed to the now-archived
              // ratchet, so it cannot decrypt. That single message is lost
              // (one message, once per rotation) but the session is reset,
              // so every subsequent message rebuilds + delivers. Ack-drop
              // it (handled=true) so it doesn't wedge the drain or get
              // retried forever. A NON-reset post-refresh failure is a
              // genuine problem and stays a soft drop.
              if (outcome.sessionReset) {
                crashLog(`[messenger] drain rotation env=${env.envelopeId.slice(0,8)} dropped (sealed to archived ratchet) — session reset, future msgs ok`);
                // Destroyed (sealed to the archived ratchet) — honest disposition.
                noteDestroyedEnvelope({envelopeId: env.envelopeId, reason: 'rotation-archived-ratchet'});
                handled = true;
              } else if (isTransientSqlError(e2)) {
                // Audit P0-1(b) — local storage hiccup on the retry:
                // leave on relay, never destroy.
                crashLog(`[messenger] drain post-refresh transient-sql leave-on-relay env=${env.envelopeId.slice(0, 8)}`);
                continue;
              } else {
                console.warn('[messenger] drain post-refresh handle failed', asErrorMessage(e2));
                try {
                  const {noteUndecryptable} = require('../backup/sessionRatchetRecovery') as
                    typeof import('../backup/sessionRatchetRecovery');
                  noteUndecryptable(`drain-post-refresh:${asErrorMessage(e2).slice(0, 40)}`);
                } catch { /* ignore */ }
              }
            }
          } else if (outcome.result === 'unavailable') {
            // keys-service unreachable — leave the envelope on the
            // relay so a future drain can retry. Mark handled=false
            // (the ack below is skipped) and continue the loop.
            console.warn(`[messenger] drain identity-refresh unavailable env=${env.envelopeId.slice(0,8)} — leaving on relay for retry`);
            continue;
          } else {
            // stale-cert / no-change — drop the envelope.
            console.warn(`[messenger] drain identity-mismatch dropped env=${env.envelopeId.slice(0,8)} reason=${outcome.reason}`);
            try {
              const {noteUndecryptable} = require('../backup/sessionRatchetRecovery') as
                typeof import('../backup/sessionRatchetRecovery');
              noteUndecryptable(`drain-cert-mismatch:${outcome.reason ?? 'unknown'}`);
            } catch { /* ignore */ }
          }
        } else {
          // Non-rotation failure — log + count + ack-drop (matches
          // the prior catch-all behaviour for malformed AAD / bad MAC).
          crashLog(`[messenger] drain-handle-failed envId=${env.envelopeId.slice(0, 8)} err=${asErrorMessage(e).slice(0, 120)}`);
          console.warn('[messenger] drain handleIncoming failed', asErrorMessage(e));
          try {
            const {noteUndecryptable} = require('../backup/sessionRatchetRecovery') as
              typeof import('../backup/sessionRatchetRecovery');
            noteUndecryptable(`drain-handle:${asErrorMessage(e).slice(0, 40)}`);
          } catch { /* ignore */ }
        }
      }
      // Audit P0-N9 — present the possession-proof token from the pull
      // response. Server falls back to recipient-identity if absent
      // during the rollout window. ACK regardless of handled outcome
      // EXCEPT when refresh-and-retry deferred via `continue` above —
      // that branch skips ack so the relay re-delivers later.
      // Handoff §3.6(c) — same ack-outcome split as the WS path: an
      // unrecoverable failure (or a destroyed-note from the deep path)
      // acks 'discarded' so the sender's tick stays honest.
      {
        const destroyedInfo = takeDestroyedEnvelope(env.envelopeId);
        const disposition = ackDispositionFor(handled, !!destroyedInfo);
        // B-262 — this lane had NO record of the disposition at all. Warn only
        // on 'discarded': that is the destroy branch, the relay hard-deletes on
        // the ack, and the message is then unrecoverable. 'delivered' is left
        // silent here (unlike the WS path) because a first-boot bootstrap page
        // carries up to 1000 envelopes and a line each would drown the log
        // that is supposed to make the rare case findable.
        if (disposition === 'discarded') {
          console.warn('[messenger.drain] ACK discarded — envelope DESTROYED envId=' +
            env.envelopeId.slice(0, 8) + ' handled=' + handled);
        }
        // B-715 T9b/T11b — the push-woken lane had NO per-envelope evidence on the
        // success path, so the exact scenario under investigation (backgrounded
        // recipient, FCM-woken, message arrives via pull rather than the live
        // socket) produced nothing joinable to the server's `env=` lines. The WS
        // lane has had `[recv.total]` and `[messenger.deliver] ACK ok` for months;
        // this is the pull lane's equivalent.
        //
        // Gated on a SMALL page, which is what preserves the reason 'delivered'
        // was silent here: a first-boot bootstrap page carries up to 1000
        // envelopes and a line each would drown the log. A wake-driven drain
        // carries a handful — precisely the case worth a line each.
        else if (envelopes.length <= DRAIN_PROBE_MAX_PAGE) {
          console.warn('[LAGDIAG] [recv.drain] env=' + env.envelopeId.slice(0, 8) +
            ' handled=' + handled + ' page=' + envelopes.length);
        }
        enqueueAck(relay, {envelopeId: env.envelopeId, ackToken: env.ackToken ?? '', disposition});
        pageProgressed += 1;
      }
      } finally {
        // Audit L16 / W22a — released on EVERY exit: success, throw, or any of
        // the `continue`s in the unwrap, dedup, cert and handleIncoming blocks
        // above. `finally` runs before a `continue` transfers control, so the
        // hold never leaks. Token-keyed, so a zombie attempt cannot release a
        // hold a newer attempt owns (B-126). It is the FIRST statement here on
        // purpose: anything placed above it could throw — no `throw` keyword
        // required — and strand the envelope until the stale deadline.
        releaseEnvelope(env.envelopeId, drainHold);
        // B-703 MR-1 — then classify THIS envelope for the drain report. Only
        // the ack counter can move inside the try (`pageSkipped` belongs to the
        // busy early-out, which returns above this block), so an envelope that
        // did not ack is left-on-relay by construction — including one whose
        // lane threw.
        if (pageProgressed > ackedBefore) {ackedIds.add(env.envelopeId);}
      }
    }
    // B-126 — a page where NOTHING was acked (every envelope skipped as
    // in-flight or left on relay) would return IDENTICALLY on the next
    // pull. B-315 — instead of aborting the whole drain (which starved
    // everything behind the stuck head), advance the cursor past this
    // page and keep going. The stuck envelopes stay on the relay
    // (leave-on-relay semantics untouched) and are retried by the next
    // drain run, which starts back at cursor 0.
    if (pageProgressed === 0 && envelopes.length > 0) {
      let maxTs = cursorTs;
      for (const env of envelopes) {
        if (typeof env.timestamp === 'number' && env.timestamp > maxTs) {maxTs = env.timestamp;}
      }
      if (maxTs <= cursorTs) {
        // Malformed page (no usable timestamps) — the old abort remains
        // the safety net so this can never spin.
        console.warn(
          `[bravo.drainRelay] page made no progress (${envelopes.length} envelopes: ${pageSkipped} in-flight-skipped, rest left-on-relay) — cursor cannot advance, stopping this drain (B-126)`,
        );
        return drainTotals();
      }
      console.warn(
        `[bravo.drainRelay] page made no progress (${envelopes.length} envelopes: ${pageSkipped} in-flight-skipped, rest left-on-relay) — stepping past stuck head to ts=${maxTs} (B-315)`,
      );
      cursorTs = maxTs;
      continue;
    }
    // Round 8 — DO NOT mark bootstrap-done on a short page. Previously
    // this branch flipped the flag whenever envelopes.length < pageLimit,
    // which masquerades as "tail reached" but can also mean "page hit
    // a server-side cap mid-window" or "single-row delivery during
    // initial drain." Either case left the user permanently undershooting
    // on every subsequent reconnect (50-cap drains, multi-week backlog
    // never fully delivered). The empty-drain branch above is the only
    // reliable "we have everything" signal; just continue iterating
    // until we see one.
    if (envelopes.length < pageLimit) {
      // Don't return — let the next iteration confirm with an empty page.
      // The HARD_CAP_ITERATIONS bound still prevents runaway.
      continue;
    }
    // After a successful first iteration, drop bootstrap so subsequent
    // pages of the same drain use the steady-state cap.
    bootstrap = false;
  }
  // Diagnostic breadcrumb — hitting the cap means ack is silently
  // failing and the same envelopes keep coming back. Wire to telemetry
  // so we know when a user is stuck in a redelivery loop.
  crashLog(`[bravo.drainRelay] hard-cap iters=${HARD_CAP_ITERATIONS} (ack loop?)`);
  console.warn('[bravo.drainRelay] hit hard cap of', HARD_CAP_ITERATIONS, 'pages — bailing to avoid runaway');
  return drainTotals();
}

function convoIdFor(peer: SessionAddress): string {
  // Phase-1 convention: one 1:1 conversation per peer userId.
  // Local UI key — asymmetric by design (Alice sees `direct:bob`, Bob
  // sees `direct:alice`). For the AAD binding, use
  // `directConvoAadId(self, peer)` instead so both sides agree.
  return `direct:${peer.userId}`;
}

// S2 — `directConvoAadId` is imported from ./aadBinding. It used to be
// duplicated here verbatim; two copies of the AAD binding rule is the same
// class of defect as the two copies of the topology predicate (B-124), because
// the sender and receiver must derive the SAME string or every envelope fails
// `conversation_mismatch` and is acked-and-destroyed. Do not re-inline it.

function makeId(): string {
  const rand = new Uint8Array(8);
  crypto.getRandomValues(rand);
  return Array.from(rand, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Send a tiny `control: 'rehandshake'` envelope to `peer`. Triggered
 * by receive-side recovery after a `DecryptError` was caught and the
 * outgoing session was rebuilt. The recipient (original sender)
 * decrypts a fresh PreKeyWhisperMessage, libsignal session-replaces
 * its existing record on the way through, and the broken ratchet
 * is healed without user action. Best-effort: any failure here
 * just leaves the manual reset path as the fallback.
 */
async function sendRehandshakeNudge(args: {
  own:        SessionManager;
  ownStore:   CryptoStore;
  keys:       KeysHttpClient;
  peer:       SessionAddress;
  ownAddress: SessionAddress;
  certCache:  SenderCertCache;
  transport:  TransportClient;
  relay:      RelayHttpClient;
}): Promise<void> {
  try {
    const cert = await args.certCache.get();
    // Round 5 / Security S1 — bind recipient + ts.
    const sealed = sealPayload(cert, '', {
      control: 'rehandshake',
      aad: {to: args.peer, ts: Date.now()},
    });
    const ct = await args.own.encrypt(args.peer, sealed);
    const {idKey: recipientIdKeyB64} = await recipientIdentityKeyB64(args.ownStore, args.keys, args.peer);
    const outerSealed = await wrapOuter({
      recipientIdentityKeyB64: recipientIdKeyB64,
      sender:                  args.ownAddress,
      ciphertext:              ct,
      cert, // P0-1: cert bound into outer AAD
    });
    try {
      args.transport.send({
        event: 'envelope.send',
        data: {
          to:           args.peer,
          outerSealed,
          clientMsgId:  makeId(),
          urgent:       false,
        },
      });
    } catch {
      await args.relay.send({
        recipient:    args.peer,
        outerSealed,
        clientMsgId:  makeId(),
        urgent:       false,
      });
    }
  } catch { /* swallow — manual reset is the safety net */ }
}

// Per-peer cooldown for the bundle-refetch path triggered by
// DecryptError lives in `./sessionWipeProtection` so the in-process
// state and the SQLCipher-backed persistence share one source of truth.
// Bug-hunt #1.C: was previously a local unbounded Map (P1-7) — the
// centralised module bounds it via the persistent store row + the
// cache-warm fill on boot, and survives cold start.

// Audit P0-1 — protection state lives in `./sessionWipeProtection`.
// Extracted so the test suite can exercise the policy without pulling
// op-sqlite + the full production runtime into the messenger-crypto
// Jest project (which is node-env only).

function asErrorMessage(e: unknown): string {
  if (e instanceof Error) {return e.message;}
  return String(e);
}

/**
 * Fix #16: classify a frame-handler error as recoverable (soft
 * banner — the runtime is already self-healing) vs fatal (red
 * banner — user action may be required).
 *
 * Recoverable cases:
 *   - DecryptError: identity rotation already triggered rebuild path
 *   - 'fetch'/'network'/'timeout' substrings: transient network blips
 * Everything else (auth failures, contract violations, malformed
 * frames) goes to the fatal slot so the user actually sees them.
 */
function isRecoverableFrameError(e: unknown): boolean {
  if (e instanceof DecryptError) {return true;}
  const msg = asErrorMessage(e).toLowerCase();
  return msg.includes('network') || msg.includes('timeout') || msg.includes('aborted')
    || msg.includes('econn') || msg.includes('fetch failed');
}
