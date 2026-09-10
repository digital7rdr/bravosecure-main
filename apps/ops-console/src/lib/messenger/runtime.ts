/**
 * MessengerRuntime — boot, unlock, and pump the encrypted messenger
 * stack on the ops admin's browser. One instance per (userId, vault
 * key). Holds:
 *   - the IndexedDBProtocolStore
 *   - the SessionManager
 *   - the cached sender cert
 *   - a polling loop that pulls/decrypts envelopes from the relay
 *
 * Concurrency: not safe to instantiate twice for the same user. Use
 * the React provider in MessengerProvider.tsx as the singleton.
 */

import {
  SessionManager,
  installIdentity,
  sealPayload, unsealPayload, type SealedPayload,
  wrapOuter, unwrapOuter,
  verifySenderCert,
  verifySealedAad,
  groupDecrypt, isGroupCiphertext,
  disposeAllGroupKeys,
  RevokedJtiCache,
  SenderCertClient,
  toBase64,
  type ServerFrame,
  type SessionAddress,
} from '@bravo/messenger-core';
import {IndexedDBProtocolStore} from './protocolStore';
import {openMessengerDb, type MessengerDb} from './idb';
import {deriveKey, newSalt, wrapString, unwrapString, assertPassphraseStrength, type WrapKey} from './crypto';
import {
  enrollPasskey as webauthnEnrollPasskey,
  unlockWithPasskey as webauthnUnlockWithPasskey,
  importPasskeyDerivedKey,
  isPasskeySupported,
  type EnrolledPasskey,
} from './webauthnPrf';
import {DecryptError, WrongPassphraseError} from './errors';
import {exportPublicBundle} from './identityHelpers';
import {keysApi} from './keys';
import {relay, type StoredEnvelope} from './relay';
import {TransportClient} from './transport';
import {MessageStore, type StoredMessage} from './messageStore';
import {getMessengerTicket} from '@/lib/api';

const DEFAULT_DEVICE_ID = 1;
// Catch-up HTTP poll runs only as a fallback when the WS is offline —
// the steady-state delivery path is `envelope.deliver` over socket.io.
// Bumped from 3.5s → 15s because real-time arrives via WS now.
const RELAY_POLL_MS = 15_000;

// XEd25519 (Curve25519) sender-cert public key, base64. Pinned in the
// app bundle at build time. In dev it falls back to the checked-in
// keypair from apps/auth-service/.env so the console boots out-of-the-box.
// Why (OPS-MSG-04): a production build MUST supply the real authority key
// — silently trusting the well-known dev key would accept certs minted by
// anyone holding the dev private key, so we fail closed at load time.
const SENDER_CERT_PUBLIC_KEY_B64 = (() => {
  const configured = process.env.NEXT_PUBLIC_SENDER_CERT_PUBLIC_KEY_B64;
  if (configured) return configured;
  // Why (OPS-MSG-04): a production build should supply the real authority key.
  // We log LOUDLY rather than throw — this runs at module load in a file the
  // root layout imports, so throwing would take down the ENTIRE console, not
  // just the messenger. The dev-key fallback keeps the app usable while
  // surfacing the misconfiguration (and real prod certs won't verify against
  // the dev key, which is its own signal). Set the env var before trusting
  // production traffic.
  if (process.env.NODE_ENV === 'production' && typeof console !== 'undefined') {
    console.error(
      '[messenger] NEXT_PUBLIC_SENDER_CERT_PUBLIC_KEY_B64 is not set in a production build — falling back to the DEV authority key. Set the real key before trusting prod sender certs.',
    );
  }
  return '7uox+8+kRi7Sy3jb+ibmm+Dt2S/LPtSiT2hkF1GjjyQ=';
})();

// Audit OPS-MSG-06 — legacy v2 outer-wrap acceptance on receive. A v2
// wrap carries no sender cert, so a forged v2 envelope can reach
// session.decrypt and drive the DecryptError → session-reset recovery
// path (the vector v3's pre-decrypt cert verify closes). Ops only ever
// SENDS v3, so this defaults to accept (mirrors mobile's rollback-flag
// posture) and can be flipped closed once the fleet is fully v3 —
// NEXT_PUBLIC_ACCEPT_OUTER_V2=false then rejects v2 before decrypt.
const ACCEPT_OUTER_V2 = process.env.NEXT_PUBLIC_ACCEPT_OUTER_V2 !== 'false';

// Audit (ops parity, mobile S10/P0-N1) — sealed-sender AAD policy.
// Default fail-CLOSED: an inbound envelope without an AAD block is
// rejected. The escape hatch (NEXT_PUBLIC_SEALED_AAD_LEGACY=true) mirrors
// mobile's EXPO_PUBLIC_SEALED_AAD_LEGACY and exists only for an emergency
// rollback window where a pre-AAD sender is still in flight. Must be off
// in production.
const SEALED_AAD_LEGACY =
  process.env.NEXT_PUBLIC_SEALED_AAD_LEGACY === 'true';
if (SEALED_AAD_LEGACY && typeof console !== 'undefined') {
  console.warn('[messenger] NEXT_PUBLIC_SEALED_AAD_LEGACY=true — sealed envelopes without AAD will be accepted. This MUST be off in production.');
}

// Order-independent 1:1 conversation id for AAD binding — identical to
// the mobile `directConvoAadId` so both sides compute the same string
// (Audit P0-N2-follow-up). A 1:1 sender stamps aad.conversationId with
// this; the receiver recomputes it from (self, peer) and compares.
function directConvoAadId(a: string, b: string): string {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return `direct:${lo}|${hi}`;
}

// Rate-limit the bundle-refetch path triggered by DecryptError so an
// offline backlog of N stale envelopes from the same peer doesn't fire
// N bundle fetches against auth-service. Mirrors the mobile cooldown.
const REBUILD_COOLDOWN_MS = 60_000;
const lastRebuildAttempt = new Map<string, number>();
function shouldAttemptRebuild(peer: SessionAddress): boolean {
  const key = `${peer.userId}.${peer.deviceId}`;
  const now = Date.now();
  const prev = lastRebuildAttempt.get(key) ?? 0;
  if (now - prev < REBUILD_COOLDOWN_MS) return false;
  lastRebuildAttempt.set(key, now);
  return true;
}

// Honour both NEXT_PUBLIC_MESSENGER_BASE_URL (dev) and the shorter
// NEXT_PUBLIC_MSG_BASE_URL the staging compose sets — see relay.ts.
const RELAY_BASE =
  process.env.NEXT_PUBLIC_MESSENGER_BASE_URL ??
  process.env.NEXT_PUBLIC_MSG_BASE_URL ??
  'http://localhost:3100';
const API_BASE   = process.env.NEXT_PUBLIC_API_BASE_URL       ?? 'http://localhost:3001';
void RELAY_BASE; // used downstream — kept for future doc reference

export type DecryptedMessage = {
  envelopeId:     string;
  conversationId: string;        // groupId from sealed metadata, or ''
  senderUserId:   string;        // recovered from outer ECIES wrap + cert verification
  senderDeviceId: number;
  body:           string;
  clientMsgId?:   string;
  receivedAt:     number;
  expiresAtSec?:  number;
  isSystem?:      false;
};

interface InnerGroupEnvelope {
  groupId:     string;
  kind:        'text' | 'admin';
  clientMsgId: string;
  body:        string;
  adminAction?: {
    type:  'create' | 'rekey';
    state?: {
      groupId:      string;
      masterKeyB64: string;
      epoch:        number;
      [k: string]:  unknown;
    };
    newMasterKeyB64?: string;
    atEpoch?:         number;
  };
}

export type IncomingListener = (m: DecryptedMessage) => void;

/** Presence snapshot the UI subscribes to. */
export interface PresenceState {
  state:       'online' | 'active' | 'away' | 'offline';
  lastSeenMs?: number;
}
export type PresenceListener = (userId: string, snapshot: PresenceState) => void;

/** Typing indicator — `typing` is true while the peer is composing. */
export type TypingListener = (peerUserId: string, typing: boolean) => void;

/** Read-receipt — peer has acknowledged the listed envelope ids. */
export type ReadReceiptListener = (peerUserId: string, envelopeIds: string[]) => void;

/** Notification that the persisted history changed for a conversation. */
export type HistoryChangeListener = (conversationId: string) => void;

export class MessengerRuntime {
  private store!: IndexedDBProtocolStore;
  private session!: SessionManager;
  private db!: MessengerDb;
  private wrapKey!: WrapKey;
  private cachedCert: {cert: string; expiresAt: number} | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<IncomingListener>();
  private presenceListeners      = new Set<PresenceListener>();
  private typingListeners        = new Set<TypingListener>();
  private readReceiptListeners   = new Set<ReadReceiptListener>();
  private historyListeners       = new Set<HistoryChangeListener>();
  private cursor = 0;
  private sealedSendersByEnvelope = new Map<string, SessionAddress>();

  // Live presence + typing snapshots, keyed by userId. Listeners get
  // notified on every transition; consumers can also `getPresence()` /
  // `isTyping()` for an immediate read.
  private presenceByUser = new Map<string, PresenceState>();
  private typingByUser   = new Map<string, boolean>();

  // socket.io transport — created on `unlock`, connected by
  // `startListening`. Null in the brief window between unlock and the
  // first listen, and after `stopListening` tears it down.
  private transport: TransportClient | null = null;

  // Audit OPS-MSG-03 — sender-cert revocation poller. Started with the
  // dispatch loop, stopped on teardown. `verifySenderCert` consults its
  // fresh snapshot so a revoked cert is dropped within the poll window
  // instead of remaining valid for its full TTL. Mirrors mobile.
  private revokedJtiCache: RevokedJtiCache | null = null;

  // Persistent conversation history (vault-encrypted IDB). Components
  // hydrate via `loadConversation`; `recordOutbound` is called by the
  // panel after a successful broadcast.
  private messages!: MessageStore;
  /**
   * Recipient hint for read-receipts in 1:1 / mission-group threads.
   * The relay never knows who sent what, so we recover the peer
   * `SessionAddress` from the most recent inbound envelope on each
   * conversation. `markRead` looks the peer up here and fans the
   * receipt back to their connected sockets.
   */
  private envelopePeerByConvo = new Map<string, SessionAddress>();
  private envelopePeerById    = new Map<string, SessionAddress>();

  readonly self: SessionAddress;

  private constructor(public readonly userId: string) {
    this.self = {userId, deviceId: DEFAULT_DEVICE_ID};
  }

  /**
   * Open the IDB + verify (or create) the vault canary. Returns the
   * runtime ready for the caller to start the dispatch loop.
   *
   * `passphrase` derives the AES-GCM wrap key. On first run the canary
   * doesn't exist yet — we create one. On subsequent runs we decrypt
   * the canary; a GCM tag failure → WrongPassphraseError.
   */
  static async unlock(userId: string, passphrase: string): Promise<MessengerRuntime> {
    const r = new MessengerRuntime(userId);
    r.db = await openMessengerDb(userId);

    let vault = await r.db.get('vault', 1);
    if (!vault) {
      // Audit P0-W6 — setup path: refuse to mint a vault behind a
      // passphrase that fails the strength floor. Throws
      // WeakPassphraseError which the UI surfaces with a specific
      // reason ("too_short" / "too_simple") instead of the generic
      // "wrong passphrase" copy.
      assertPassphraseStrength(passphrase);
      const salt = newSalt();
      const wrapKey = await deriveKey(passphrase, salt);
      const canary = await wrapString(wrapKey, 'OK');
      await r.db.put('vault', {salt, canary, created_at: Date.now()}, 1);
      vault = await r.db.get('vault', 1);
      if (!vault) throw new Error('vault write failed');
      r.wrapKey = wrapKey;
    } else {
      // Audit P0-W6 — also gate unlock so a vault minted under the
      // legacy short-passphrase rules can't be re-opened without an
      // upgrade. The change-passphrase flow (see UI) is the path
      // forward; rejecting here surfaces the requirement.
      assertPassphraseStrength(passphrase);
      const wrapKey = await deriveKey(passphrase, vault.salt);
      // unwrapString throws WrongPassphraseError on tag failure.
      const canary = await unwrapString(wrapKey, vault.canary);
      if (canary !== 'OK') throw new WrongPassphraseError();
      r.wrapKey = wrapKey;
    }

    r.store = new IndexedDBProtocolStore(r.db, r.wrapKey);
    r.session = new SessionManager(r.store);
    r.messages = new MessageStore(r.db, r.wrapKey);
    return r;
  }

  /**
   * Audit fix 4.7 — passkey-derived unlock.
   *
   * Opens the IDB, reads the vault row, and uses the WebAuthn PRF
   * extension to derive the AES-GCM wrap key from the operator's
   * authenticator (Touch ID / Windows Hello / hardware key). The
   * vault must already be enrolled (`passkey_credential_id` present);
   * see `enrollPasskey()` for first-time setup.
   *
   * Failure paths:
   *  - vault not yet created                 → throw vault_not_initialized
   *  - vault has no passkey enrollment       → throw passkey_not_enrolled
   *  - PRF unsupported by this authenticator → throw from webauthnPrf
   *  - canary GCM tag fails                  → WrongPassphraseError
   *    (same error class as the passphrase path so the UI can surface
   *    "wrong authenticator" the same way)
   */
  static async unlockWithPasskey(userId: string): Promise<MessengerRuntime> {
    if (!isPasskeySupported()) throw new Error('webauthn_not_supported');
    const r = new MessengerRuntime(userId);
    r.db = await openMessengerDb(userId);

    const vault = await r.db.get('vault', 1);
    if (!vault) throw new Error('vault_not_initialized');
    if (!vault.passkey_credential_id || !vault.passkey_prf_salt || !vault.passkey_canary) {
      throw new Error('passkey_not_enrolled');
    }

    const enrolled: EnrolledPasskey = {
      credentialId: vault.passkey_credential_id,
      prfSalt:      vault.passkey_prf_salt,
    };
    const secret = await webauthnUnlockWithPasskey(enrolled);
    const wrapKey = await importPasskeyDerivedKey(secret);

    // Verify the PRF-derived key matches the alternate canary. A failure
    // here means the authenticator gave us a different PRF response
    // (different credential? salt drift?) — treat as wrong-key.
    const canary = await unwrapString(wrapKey, vault.passkey_canary);
    if (canary !== 'OK') throw new WrongPassphraseError();

    r.wrapKey = wrapKey;
    r.store = new IndexedDBProtocolStore(r.db, r.wrapKey);
    r.session = new SessionManager(r.store);
    r.messages = new MessageStore(r.db, r.wrapKey);
    return r;
  }

  /**
   * Audit fix 4.7 — add a passkey enrollment to an already-unlocked vault.
   *
   * Runs registration + PRF eval against the operator's authenticator,
   * wraps a fresh canary with the PRF-derived key, and writes the
   * `passkey_credential_id + prf_salt + canary` back to the vault row.
   * The passphrase canary is left intact so the operator keeps a
   * recovery path if the authenticator is wiped.
   *
   * Caller must show consent UI before invoking this — the browser
   * `navigator.credentials.create()` prompt does pop user verification
   * but doesn't explain WHY, so the surrounding UI carries the copy.
   */
  async enrollPasskey(userDisplayName: string): Promise<void> {
    if (!this.db) throw new Error('runtime_not_initialized');
    if (!isPasskeySupported()) throw new Error('webauthn_not_supported');

    const {enrolled, secret} = await webauthnEnrollPasskey(this.userId, userDisplayName);
    const passkeyKey = await importPasskeyDerivedKey(secret);
    const passkeyCanary = await wrapString(passkeyKey, 'OK');

    const vault = await this.db.get('vault', 1);
    if (!vault) throw new Error('vault_not_initialized');
    await this.db.put('vault', {
      ...vault,
      passkey_credential_id: enrolled.credentialId,
      passkey_prf_salt:      enrolled.prfSalt,
      passkey_canary:        passkeyCanary,
    }, 1);
  }

  /**
   * Audit fix 4.7 — strip the passkey enrollment from the vault.
   * Used when an operator wants to rotate authenticators (enroll a
   * fresh device) or revoke a lost one. The passphrase canary stays
   * intact so the vault remains unlockable.
   */
  async revokePasskey(): Promise<void> {
    if (!this.db) throw new Error('runtime_not_initialized');
    const vault = await this.db.get('vault', 1);
    if (!vault) return;
    const next = {...vault};
    delete next.passkey_credential_id;
    delete next.passkey_prf_salt;
    delete next.passkey_canary;
    await this.db.put('vault', next, 1);
  }

  /** Audit fix 4.7 — is the current vault unlockable via passkey? */
  async isPasskeyEnrolled(): Promise<boolean> {
    if (!this.db) return false;
    const vault = await this.db.get('vault', 1);
    return Boolean(
      vault?.passkey_credential_id && vault?.passkey_prf_salt && vault?.passkey_canary,
    );
  }

  // ── Conversation history (IDB) ───────────────────────────────────

  /** Load every persisted message for a conversation, oldest first. */
  async loadConversation(conversationId: string): Promise<StoredMessage[]> {
    return this.messages.loadConversation(conversationId);
  }

  /**
   * Persist an outbound message we just broadcasted. The panel calls
   * this after `broadcastToGroup` so a tab reload retains the bubble.
   * Idempotent — re-calls overwrite the same primary key.
   */
  async recordOutbound(msg: {
    conversationId: string;
    id:             string;
    body:           string;
    sentAt:         number;
    clientMsgId:    string | null;
    envelopeIds:    string[];        // first id is canonical for receipt correlation
    status:         'sent' | 'failed';
  }): Promise<void> {
    await this.messages.upsert({
      conversationId: msg.conversationId,
      id:             msg.id,
      senderUserId:   this.userId,
      direction:      'out',
      body:           msg.body,
      sentAt:         msg.sentAt,
      envelopeId:     msg.envelopeIds[0] ?? null,
      clientMsgId:    msg.clientMsgId,
      status:         msg.status,
      reactions:      null,
      replyToId:      null,
    });
    this.notifyHistoryChange(msg.conversationId);
  }

  /**
   * Ensure a Signal identity exists locally and the public bundle is
   * uploaded to the auth-service. Idempotent — only does work on the
   * first run after install.
   */
  async ensureIdentityPublished(): Promise<void> {
    let installed = false;
    try { await this.store.getIdentityKeyPair(); }
    catch { installed = true; }
    if (installed) {
      await installIdentity(this.store);
    }
    // Always ensure the bundle is on the server. Cheap idempotent
    // upsert on the auth-service side. Skipped only if we just
    // confirmed we already have a posted bundle (tracked via meta).
    const flag = await this.store.getMeta('bundle_uploaded').catch(() => undefined);
    if (flag !== 'yes' || installed) {
      const bundle = await exportPublicBundle(this.store);
      await keysApi.upload(bundle);
      await this.store.setMeta('bundle_uploaded', 'yes');
    }
  }

  /**
   * Issue / refresh the short-lived sender cert. Callers don't usually
   * need to invoke this directly — sendToConversation() does it.
   */
  async getSenderCert(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.cachedCert && this.cachedCert.expiresAt - 60 > now) {
      return this.cachedCert.cert;
    }
    const id = await this.store.getIdentityKeyPair();
    const body = JSON.stringify({
      senderSignalDeviceId: this.self.deviceId,
      senderIdentityKey:    toBase64(id.pubKey),
    });
    const post = (ticket: string) => fetch(`${API_BASE}/sender-cert`, {
      method:  'POST',
      headers: {'Content-Type': 'application/json', Authorization: `Bearer ${ticket}`},
      body,
    });

    // Audit fix 0.4 — sender-cert lives on messenger-service. Use the
    // short-lived messenger ticket (NOT the long-lived ops session JWT
    // from localStorage; that's gone now).
    //
    // Auto-refresh the ticket once on 401 — covers `token_revoked` when the
    // cached ticket's session jti expired/rotated between sends (mirrors
    // relay.ts). Without this, a stale ticket surfaced "sender-cert 401:
    // token_revoked" to MissionGroupPanel and the message never sent.
    let res = await post(await getMessengerTicket());
    if (res.status === 401) {
      res = await post(await getMessengerTicket(true));
    }
    if (!res.ok) throw new Error(`sender-cert ${res.status}: ${await res.text()}`);
    const j = await res.json() as {cert: string; expiresAt: number};
    this.cachedCert = j;
    return j.cert;
  }

  // ── Inbound dispatch loop ─────────────────────────────────────────

  startListening(): void {
    // Open the WS first; on (re)connect we drain any HTTP backlog the
    // server queued while offline, then steady-state delivery rides
    // `envelope.deliver` frames over the socket.
    if (!this.transport) this.openTransport();

    // Audit OPS-MSG-03 — start polling the sender-cert revocation list.
    // The list endpoint is unauthenticated (jtis are not secrets) but we
    // still hand the client a token getter for symmetry. Fail-open inside
    // the cache: a flaky endpoint keeps the last good set rather than
    // degrading to accept/reject-all.
    if (!this.revokedJtiCache) {
      const certClient = new SenderCertClient({
        baseUrl:  API_BASE,
        getToken: async () => { try { return await getMessengerTicket(); } catch { return null; } },
        refreshToken: async () => { await getMessengerTicket(true); },
      });
      this.revokedJtiCache = new RevokedJtiCache({
        client:  certClient,
        onError: e => console.warn('[messenger] revocation poll failed', e.message),
      });
      this.revokedJtiCache.start();
    }

    // The HTTP poll is now a low-frequency safety net — the server
    // auto-flushes on connect and pushes via WS, so if anything piles
    // up (race during reconnect, dropped frame), this catches it.
    if (this.pollTimer) return;
    const tick = async () => {
      try { await this.pullOnce(); }
      catch (e) { console.warn('[messenger] pull error', e); }
      this.pollTimer = setTimeout(tick, RELAY_POLL_MS);
    };
    void tick();
  }

  stopListening(): void {
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
    if (this.transport) { this.transport.close(); this.transport = null; }
    if (this.revokedJtiCache) { this.revokedJtiCache.stop(); this.revokedJtiCache = null; }
    this.presenceByUser.clear();
    this.typingByUser.clear();
  }

  /**
   * Audit OPS-MSG-09 — non-destructive teardown for lock / sign-out.
   * Stops the pumps, closes the IDB handle, and drops the in-memory
   * group-key CryptoKey cache the shared package holds. Unlike `wipe()`
   * it leaves the encrypted database intact so the next unlock re-opens
   * it. Safe to call more than once.
   */
  close(): void {
    this.stopListening();
    try { this.db?.close(); } catch { /* already closed */ }
    try { disposeAllGroupKeys(); } catch { /* best effort */ }
  }

  /**
   * Fresh-only snapshot of revoked cert jtis. Returns undefined when the
   * cache has never succeeded or is older than REVOCATION_FRESHNESS_MS,
   * so a DoS on the revocation endpoint can't silently disable the guard
   * (verify proceeds without the stale set instead). Mirrors mobile.
   */
  private revokedSnapshot(): ReadonlySet<string> | undefined {
    const c = this.revokedJtiCache;
    return c && c.isFresh() ? c.snapshot() : undefined;
  }

  /**
   * Audit OPS-MSG-07 — resolve the identity key we expect a peer's
   * sender cert to carry. Prefers the locally-pinned key; on first
   * contact (no local row) fetches the peer bundle from keys-service so
   * a forged authority-signed cert can't bind a victim userId to an
   * attacker identity key. Best-effort: a bundle-fetch failure falls
   * back to authority-signature-only rather than dropping delivery.
   */
  private async resolveExpectedIdentity(peer: SessionAddress): Promise<string | undefined> {
    const local = await this.store.loadIdentityKey(`${peer.userId}.${peer.deviceId}`);
    if (local) return toBase64(local);
    try {
      const bundle = await keysApi.fetchBundle(peer.userId);
      return bundle.identityKey;
    } catch {
      return undefined;
    }
  }

  // ── Listener registrations ───────────────────────────────────────

  onIncoming(fn: IncomingListener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  /** Subscribe to presence transitions. Listener fires for snapshots + diffs. */
  onPresenceChange(fn: PresenceListener): () => void {
    this.presenceListeners.add(fn);
    // Replay current snapshots so newly-mounted UI doesn't have to wait
    // for the next transition to paint.
    for (const [uid, snap] of this.presenceByUser) fn(uid, snap);
    return () => { this.presenceListeners.delete(fn); };
  }

  /** Subscribe to typing-indicator changes. Listener fires for each transition. */
  onTypingChange(fn: TypingListener): () => void {
    this.typingListeners.add(fn);
    return () => { this.typingListeners.delete(fn); };
  }

  /** Subscribe to read-receipt frames. Useful for double-tick rendering. */
  onReadReceipt(fn: ReadReceiptListener): () => void {
    this.readReceiptListeners.add(fn);
    return () => { this.readReceiptListeners.delete(fn); };
  }

  /**
   * Fires whenever a conversation's persisted history changed (insert
   * or status patch). Hook consumers should re-fetch via
   * `loadConversation` — debouncing internally is the caller's
   * problem; this handler is best-effort.
   */
  onHistoryChange(fn: HistoryChangeListener): () => void {
    this.historyListeners.add(fn);
    return () => { this.historyListeners.delete(fn); };
  }

  private notifyHistoryChange(conversationId: string): void {
    for (const fn of this.historyListeners) fn(conversationId);
  }

  // ── Synchronous reads of cached state ────────────────────────────

  getPresence(userId: string): PresenceState | null {
    return this.presenceByUser.get(userId) ?? null;
  }

  isTyping(userId: string): boolean {
    return !!this.typingByUser.get(userId);
  }

  // ── Outbound presence / typing / receipts ────────────────────────

  /**
   * Subscribe to presence for a batch of users. The server emits a
   * one-shot snapshot for each id, then streams transitions until
   * `unsubscribePresence` is called. Idempotent.
   */
  subscribePresence(userIds: string[]): void {
    if (!this.transport || userIds.length === 0) return;
    try { this.transport.subscribePresence(userIds); } catch { /* not open yet */ }
  }

  unsubscribePresence(userIds: string[]): void {
    if (!this.transport || userIds.length === 0) return;
    try { this.transport.unsubscribePresence(userIds); } catch { /* not open */ }
  }

  /** Tell the server we're actively interacting (or backgrounded). */
  setActivity(state: 'active' | 'away'): void {
    if (!this.transport) return;
    try { this.transport.setActivity(state); } catch { /* not open */ }
  }

  /** Emit a typing indicator to one peer. Best-effort on closed sockets. */
  sendTyping(peer: SessionAddress, state: 'start' | 'stop'): void {
    if (!this.transport) return;
    this.transport.sendTyping(peer, state);
  }

  /**
   * Mark every unread inbound message in `conversationId` as read by
   * fanning a per-peer read-receipt back to their connected sockets.
   * Idempotent — already-receipted envelope ids are not retransmitted
   * because the caller maintains the unread set.
   */
  markRead(conversationId: string, envelopeIds: string[]): void {
    if (!this.transport || envelopeIds.length === 0) return;
    const peer = this.envelopePeerByConvo.get(conversationId);
    if (!peer) return; // No inbound from anyone yet — nothing to receipt to.
    this.transport.sendReadReceipt(peer, envelopeIds);
  }

  // ── Internal: open + manage the WS ───────────────────────────────

  private openTransport(): void {
    const wsBase = (
      process.env.NEXT_PUBLIC_MESSENGER_BASE_URL ??
      process.env.NEXT_PUBLIC_MSG_BASE_URL ??
      'http://localhost:3100'
    ).replace(/^http/, 'ws');
    this.transport = new TransportClient({
      url:            wsBase + '/ws',
      signalDeviceId: this.self.deviceId,
      // Audit fix 0.4 — socket.io WS upgrade is authenticated by the
      // short-lived messenger ticket. The transport's reconnect loop
      // calls getToken() before every retry, so we re-fetch the ticket
      // each time — covers the case where a ticket expired during a
      // long network outage.
      getToken:       async () => {
        try {
          return await getMessengerTicket();
        } catch {
          return null;
        }
      },
      onFrame: frame => {
        // Frames arrive on the websocket. Decrypt routes through the
        // same handleEnvelope as the HTTP path; presence/typing/read
        // get fanned into the local listener sets so React subscribers
        // re-render without polling.
        void this.dispatchFrame(frame).catch(e =>
          console.warn('[messenger] frame handler failed', e),
        );
      },
      onStateChange: state => {
        // Surface for UI debug. The provider can also subscribe via
        // a getter if it wants to render a connection banner.
        console.log('[messenger] WS state →', state);
      },
    });
    void this.transport.connect();
  }

  private async dispatchFrame(frame: ServerFrame): Promise<void> {
    switch (frame.event) {
      case 'pong': return;
      case 'envelope.deliver': {
        const data = frame.data;
        const env: StoredEnvelope = {
          envelopeId:    data.envelopeId,
          recipient:     this.self,
          outerSealed:   data.outerSealed,
          clientMsgId:   data.clientMsgId,
          timestamp:     data.timestamp,
          expiresAtSec:  data.expiresAtSec,
        };
        const decoded = await this.handleEnvelope(env);
        if (decoded) {
          for (const fn of this.listeners) fn(decoded);
        }
        // ACK over the same socket — server hard-deletes the queue row.
        if (this.transport) this.transport.ackEnvelope(data.envelopeId);
        if (data.timestamp > this.cursor) this.cursor = data.timestamp;
        return;
      }
      case 'envelope.accepted':
        // Outbound was accepted. Currently the panel doesn't track
        // pending outbound by clientMsgId — when we add optimistic
        // bubbles we'll fan to a listener here.
        return;
      case 'presence': {
        const snap: PresenceState = {
          state:      frame.data.state,
          lastSeenMs: frame.data.lastSeenMs,
        };
        this.presenceByUser.set(frame.data.userId, snap);
        for (const fn of this.presenceListeners) fn(frame.data.userId, snap);
        return;
      }
      case 'typing': {
        const peerUid = frame.data.from.userId;
        const typing  = frame.data.state === 'start';
        this.typingByUser.set(peerUid, typing);
        for (const fn of this.typingListeners) fn(peerUid, typing);
        return;
      }
      case 'read-receipt': {
        const peerUid = frame.data.from.userId;
        // Promote stored outbound rows to `read` so a reload still
        // shows the double-tick. Lookup is by envelope_id; no-op
        // when the message isn't ours (cross-device receipts the
        // server may forward in future).
        if (this.messages) {
          for (const envId of frame.data.envelopeIds) {
            void this.markStoredEnvelopeRead(envId);
          }
        }
        for (const fn of this.readReceiptListeners) fn(peerUid, frame.data.envelopeIds);
        return;
      }
      case 'error':
        if (frame.data.code === 'superseded') return; // benign — newer socket replaced this one
        console.warn('[messenger] server error', frame.data);
        return;
    }
  }

  private async pullOnce(): Promise<void> {
    const before = Date.now();
    let r: {envelopes: StoredEnvelope[]};
    try {
      r = await relay.pull(this.self.deviceId, this.cursor || undefined, 50);
    } catch (e) {
      console.error('[messenger] pull HTTP failed', e);
      throw e;
    }
    // Always log so we can verify the poll loop is alive even with 0
    // envelopes. Tag every line with "[messenger]" so DevTools filter
    // catches them.
    console.log(`[messenger] poll: ${r.envelopes.length} envelopes (cursor=${this.cursor}, deviceId=${this.self.deviceId}, ${Date.now() - before}ms)`);
    if (r.envelopes.length > 0) {
      console.log('[messenger] envelope details:', r.envelopes.map(e => ({
        id: e.envelopeId, ts: e.timestamp,
      })));
    }
    for (const env of r.envelopes) {
      const decoded = await this.handleEnvelope(env);
      if (decoded) {
        // Why (OPS-MSG-01): never log decrypted body content — envelope /
        // conversation ids only.
        console.log(`[messenger] dispatching to ${this.listeners.size} listeners`, {
          envelopeId: env.envelopeId, conversationId: decoded.conversationId,
        });
        for (const fn of this.listeners) fn(decoded);
      }
      try { await relay.ack(this.self.deviceId, env.envelopeId); } catch (e) { void e; }
      if (env.timestamp > this.cursor) this.cursor = env.timestamp;
    }
  }

  private async handleEnvelope(env: StoredEnvelope): Promise<DecryptedMessage | null> {
    // Sealed Sender v2/v3: unwrap the outer ECIES envelope to recover the
    // sender's address + libsignal SessionCipher input. The relay can
    // no longer hint at either.
    let sender: SessionAddress;
    let signalCt;
    let wireVersion: 2 | 3 = 2;
    let senderCert: string | undefined;
    try {
      const ownIdentity = await this.store.getIdentityKeyPair();
      const unwrapped = await unwrapOuter({
        ownIdentityPrivKey: ownIdentity.privKey,
        ownIdentityPubKey:  ownIdentity.pubKey,
        outerSealedB64:     env.outerSealed,
      });
      sender      = unwrapped.sender;
      signalCt    = unwrapped.ciphertext;
      wireVersion = unwrapped.wireVersion;
      senderCert  = unwrapped.senderCert;
    } catch (e) {
      console.warn('[messenger] outer unwrap failed', env.envelopeId, (e as Error).message);
      return null;
    }

    // Audit OPS-MSG-06 — optionally reject legacy v2 wraps before decrypt.
    // v2 has no cert to pre-verify, so a forged v2 envelope would otherwise
    // reach session.decrypt and could drive the session-reset recovery
    // path. Off by default (accept) to avoid dropping in-flight v2 traffic.
    if (wireVersion === 2 && !ACCEPT_OUTER_V2) {
      console.warn('[messenger] rejecting legacy v2 outer wrap (NEXT_PUBLIC_ACCEPT_OUTER_V2=false)', {
        envelopeId: env.envelopeId,
      });
      return null;
    }

    // Audit P0-1 (ops parity) — pre-decrypt cert verify for v3 wraps.
    // The outer GCM tag already proved the cert bytes on the wire are the
    // cert the sender used to derive the AAD; here we additionally verify
    // the authority signature + expiry + identity continuity. If it
    // fails we DROP the envelope WITHOUT calling session.decrypt — so a
    // forged outer envelope can no longer coerce the DecryptError →
    // closeSession ratchet-wipe recovery path below. The trusted peer
    // address comes from the authority-signed claims, NOT the inner
    // `sender` field (which is forgeable on v2 and only a breadcrumb on
    // v3). v2 wraps fall through to the legacy post-decrypt cert check.
    if (wireVersion === 3 && senderCert) {
      try {
        const claims = await verifySenderCert({
          cert:                senderCert,
          authorityPubKeyB64:  SENDER_CERT_PUBLIC_KEY_B64,
          expectedIdentityKey: await this.resolveExpectedIdentity(sender),
          revokedJtis:         this.revokedSnapshot(),
        });
        sender = {userId: claims.senderUserId, deviceId: claims.senderSignalDeviceId};
      } catch (e) {
        console.warn('[messenger] v3 cert pre-verify failed — dropping the envelope', {
          envelopeId: env.envelopeId, error: (e as Error).message,
        });
        return null;
      }
    }
    let plain: string;
    try {
      plain = await this.session.decrypt(sender, signalCt);
    } catch (e) {
      // Identity-rotation recovery: peer reinstalled, our ratchet is
      // bound to their previous identity. Close the dead session so
      // a future PreKeyWhisperMessage from them rebuilds it, and
      // proactively refetch their bundle + reinit our outgoing
      // session so OUR next message rebuilds their side too. Bounded
      // to one rebuild per peer per minute to avoid hammering the
      // bundle endpoint when an offline backlog drains all at once.
      if (e instanceof DecryptError) {
        console.warn('[messenger] DecryptError on inbound — running recovery', {
          envelopeId: env.envelopeId, sender, error: (e as Error).message,
        });
        // Close + rebuild only INSIDE the cooldown gate. Closing on every
        // failure (the previous behavior) wiped the freshly-rebuilt
        // session as soon as a second stale envelope from the same peer
        // arrived within 60s, leaving the receiver with no outgoing
        // session at all and nothing to nudge with.
        if (shouldAttemptRebuild(sender)) {
          try { await this.session.closeSession(sender); } catch { /* best effort */ }
          try {
            const bundle = await keysApi.fetchBundle(sender.userId);
            await this.session.initOutgoingSession({
              registrationId: bundle.registrationId,
              address:        sender,
              identityKey:    bundle.identityKey,
              signedPreKey:   {
                keyId:     bundle.signedPrekeyId,
                publicKey: bundle.signedPrekey,
                signature: bundle.signedPrekeySig,
              },
              preKey: bundle.oneTimePrekey
                ? {keyId: bundle.oneTimePrekey.keyId, publicKey: bundle.oneTimePrekey.publicKey}
                : undefined,
            });
            // Nudge the original sender so libsignal session-replaces
            // their record on decrypt (a fresh PreKeyWhisperMessage
            // does that transparently). Best-effort.
            void this.sendRehandshakeNudge(sender);
          } catch (recoveryErr) {
            // Surface the swallowed failure — the manual reset is still
            // the safety net but at least we know which leg failed.
            console.warn('[messenger] recovery failed', {
              sender, error: (recoveryErr as Error).message,
            });
          }
        }
      } else {
        console.warn('[messenger] could not open envelope', env.envelopeId, e);
      }
      return null;
    }
    let sealed: SealedPayload;
    try { sealed = unsealPayload(plain); }
    catch (e) { console.warn('[messenger] unseal failed', e); return null; }

    // Sealed-sender authenticity gate (spec §2.2). Sender cert is an
    // XEd25519-signed Bravo Sealed Cert minted by auth-service; the
    // outer ECIES wrap recovered the claimed sender address but the
    // cert is the cryptographic trust anchor. Cross-check the cert's
    // senderUserId against the wrap-recovered address; a mismatch means
    // someone re-bound a captured Signal ciphertext under a forged
    // outer wrap and gets dropped.
    //
    // For v3 wraps the cert was ALREADY authority-verified pre-decrypt
    // (above) and `sender` was set from its claims, so this re-verify is
    // belt-and-braces + the v2 trust anchor. The deviceId pinning catches
    // a cross-device replay where the cert names a different device than
    // the wrap.
    try {
      const claims = await verifySenderCert({
        cert:                sealed.cert,
        authorityPubKeyB64:  SENDER_CERT_PUBLIC_KEY_B64,
        expectedIdentityKey: await this.resolveExpectedIdentity(sender),
        revokedJtis:         this.revokedSnapshot(),
      });
      if (claims.senderUserId !== sender.userId) {
        console.warn('[messenger] sender cert / wrap mismatch — dropping', {
          envelopeId: env.envelopeId, certSub: claims.senderUserId, wrapSub: sender.userId,
        });
        return null;
      }
      // Audit P0-2 (ops parity) — deviceId pinning.
      if (claims.senderSignalDeviceId !== sender.deviceId) {
        console.warn('[messenger] sender cert / device-id mismatch — dropping', {
          envelopeId: env.envelopeId, certDev: claims.senderSignalDeviceId, wrapDev: sender.deviceId,
        });
        return null;
      }
    } catch (e) {
      console.warn('[messenger] sender cert verification failed — dropping', {
        envelopeId: env.envelopeId, error: (e as Error).message,
      });
      return null;
    }

    // Audit S1/S10/P0-N2 (ops parity) — verify the sealed AAD binding.
    // Mirrors the mobile receiver: confirm the envelope was sealed FOR US
    // (aad.to === self), is fresh (±skew), and — when the sender stamped
    // them — that sender + conversation/group match what we expect. This
    // is the replay-protection layer ops previously skipped entirely: it
    // catches a ciphertext captured off the wire and replayed to a
    // different recipient, a stale re-ship, or a cross-thread/cross-group
    // splice. For 1:1 the expected conversation id is the order-independent
    // directConvoAadId(self, peer); for groups it's the groupId.
    // Runs BEFORE the rehandshake short-circuit so a control envelope is
    // held to the same binding as a content one.
    const expectedConversationId = sealed.group?.groupId
      ?? directConvoAadId(this.self.userId, sender.userId);
    const aadCheck = verifySealedAad({
      sealed:                 sealed,
      selfUserId:             this.self.userId,
      selfDeviceId:           this.self.deviceId,
      requireAad:             !SEALED_AAD_LEGACY,
      expectedSender:         sender,
      expectedConversationId,
      expectedGroupId:        sealed.group?.groupId,
    });
    if (!aadCheck.ok) {
      console.warn('[messenger] sealed aad rejected — dropping', {
        envelopeId: env.envelopeId, reason: aadCheck.reason,
      });
      return null;
    }

    // Drop rehandshake nudges — libsignal already session-replaced
    // when it decrypted the PreKeyWhisperMessage above. Nothing else
    // to render. (AAD already verified above.)
    if (sealed.control === 'rehandshake') return null;

    // Group path — handle master-key-wrapped bodies + admin create
    // distribution. Mobile and ops use the same wire format; legacy
    // plaintext bodies still parse via the fallback at the bottom so
    // an older sender doesn't break us.
    if (sealed.group) {
      const groupId = sealed.group.groupId;
      const knownKey = await this.getGroupKey(groupId);

      let inner: InnerGroupEnvelope | null = null;
      let outer: unknown = null;
      try { outer = JSON.parse(sealed.body); } catch { /* not JSON */ }

      if (isGroupCiphertext(outer) && knownKey) {
        // Why (OPS-MSG-01): these two steps MUST NOT share a try block. If the
        // decrypt succeeds and the PARSE then fails, V8 puts a slice of the
        // offending string into the SyntaxError message — and that string is
        // decrypted group plaintext. Logging `e.message` from a combined catch
        // therefore leaks message content to the console on any malformed
        // payload. Decrypt errors are crypto errors and safe to log; parse
        // errors get a length only, never the error object.
        let plain: string | null = null;
        try {
          plain = await groupDecrypt(knownKey, outer);
        } catch (e) {
          console.warn('[messenger] group envelope could not be opened (key mismatch or tampered)', {
            envelopeId: env.envelopeId, groupId, error: (e as Error).message,
          });
        }
        if (plain !== null) {
          try {
            inner = JSON.parse(plain) as InnerGroupEnvelope;
          } catch {
            console.warn('[messenger] group inner payload is not valid JSON — dropping', {
              envelopeId: env.envelopeId, groupId, len: plain.length,
            });
          }
        }
      } else if (isGroupCiphertext(outer) && !knownKey) {
        console.warn('[messenger] group ciphertext received but master key missing — dropping', {
          envelopeId: env.envelopeId, groupId,
        });
      } else if (outer && typeof outer === 'object' && 'groupId' in (outer as object)) {
        inner = outer as InnerGroupEnvelope;
      } else {
        // Why (OPS-MSG-01): never log body content — the body preview
        // here was decrypted sealed-payload plaintext.
        console.warn('[messenger] group envelope body is neither ciphertext nor plain envelope', {
          envelopeId: env.envelopeId, groupId,
        });
      }

      if (inner && inner.kind === 'admin' && inner.adminAction) {
        // Distribute / store the master key from a `create` admin
        // payload. Last-writer-wins on race; ops admins should
        // coordinate out of band if they all try to bootstrap a
        // group simultaneously (Phase 1 single-creator assumption).
        const action = inner.adminAction;
        if (action.type === 'create' && action.state?.masterKeyB64) {
          await this.setGroupKey(groupId, action.state.masterKeyB64, action.state.epoch ?? 0);
        }
        if (action.type === 'rekey' && action.newMasterKeyB64) {
          await this.setGroupKey(groupId, action.newMasterKeyB64, action.atEpoch ?? 0);
        }
        return null; // admin frames don't render in the chat
      }

      const renderedBody = inner ? inner.body : sealed.body;
      // Remember which peer sent on which conversation so `markRead`
      // can fan a receipt back without the caller having to track it.
      this.envelopePeerByConvo.set(groupId, sender);
      this.envelopePeerById.set(env.envelopeId, sender);
      // Persist the inbound to IDB so a tab reload re-hydrates it.
      // upsert is idempotent on (conversationId, id); duplicate
      // deliveries won't double-count. Audit fix — AWAIT the write before
      // returning the decrypted message: a consumer that calls
      // loadConversation synchronously inside onIncoming would otherwise
      // race the unsettled write and miss the just-arrived row.
      await this.messages.upsert({
        conversationId: groupId,
        id:             env.envelopeId,
        senderUserId:   sender.userId,
        direction:      'in',
        body:           renderedBody,
        sentAt:         env.timestamp,
        envelopeId:     env.envelopeId,
        clientMsgId:    inner?.clientMsgId ?? sealed.group.clientMsgId ?? env.clientMsgId ?? null,
        status:         'delivered',
        reactions:      null,
        replyToId:      null,
      });
      this.notifyHistoryChange(groupId);
      return {
        envelopeId:     env.envelopeId,
        conversationId: groupId,
        senderUserId:   sender.userId,
        senderDeviceId: sender.deviceId,
        body:           renderedBody,
        clientMsgId:    inner?.clientMsgId ?? sealed.group.clientMsgId ?? env.clientMsgId,
        receivedAt:     env.timestamp,
        expiresAtSec:   sealed.expiresAtSec,
      };
    }

    // 1:1 path — sealed.group is narrowed to undefined here by the
    // `if (sealed.group)` block above (which always returns), so we
    // don't read it again. Conversation id is the empty string for
    // 1:1; markRead will fall back to a per-sender lookup keyed by
    // the empty conversation id, so we still record it.
    this.envelopePeerByConvo.set('', sender);
    this.envelopePeerById.set(env.envelopeId, sender);
    // Audit fix — AWAIT before returning (see group path above).
    await this.messages.upsert({
      conversationId: '',
      id:             env.envelopeId,
      senderUserId:   sender.userId,
      direction:      'in',
      body:           sealed.body,
      sentAt:         env.timestamp,
      envelopeId:     env.envelopeId,
      clientMsgId:    env.clientMsgId ?? null,
      status:         'delivered',
      reactions:      null,
      replyToId:      null,
    });
    this.notifyHistoryChange('');
    return {
      envelopeId:     env.envelopeId,
      conversationId: '',
      senderUserId:   sender.userId,
      senderDeviceId: sender.deviceId,
      body:           sealed.body,
      clientMsgId:    env.clientMsgId,
      receivedAt:     env.timestamp,
      expiresAtSec:   sealed.expiresAtSec,
    };
  }

  /**
   * Find a stored outbound row by envelope id and flip it to `read`.
   * Used to keep the double-tick state across tab reloads. Best-effort:
   * we have to scan the conversation index because envelope_id isn't
   * itself a primary key — N is small per conversation so the cost is
   * negligible compared to the IDB transaction itself.
   */
  private async markStoredEnvelopeRead(envelopeId: string): Promise<void> {
    const all = await this.db.getAll('messages');
    for (const r of all) {
      if (r.envelope_id === envelopeId && r.direction === 'out' && r.status !== 'read') {
        await this.messages.patch(r.conversation_id, r.id, {status: 'read'});
        this.notifyHistoryChange(r.conversation_id);
        return;
      }
    }
  }

  // ── Outbound ──────────────────────────────────────────────────────

  /** Used by groupClient.broadcastToGroup — exposed for the panel. */
  getSession(): SessionManager { return this.session; }

  /** Crypto store backing this runtime — needed by `broadcastToGroup` for the v2 outer wrap. */
  getStore(): IndexedDBProtocolStore { return this.store; }

  /**
   * Look up the AES-256-GCM master key for a group. Returns null when
   * we haven't received an admin `create` for this group yet — the
   * caller (typically MissionGroupPanel before its first send) should
   * generate one and broadcast it via `adminAction: {type: 'create'}`.
   */
  async getGroupKey(groupId: string): Promise<string | null> {
    const row = await this.db.get('group_keys', groupId);
    if (!row) return null;
    // Audit OPS-MSG-02 — the master key is vault-wrapped at rest like
    // every other secret in this store.
    if (row.master_key_wrapped) {
      try { return await unwrapString(this.wrapKey, row.master_key_wrapped); }
      catch { return null; }
    }
    // Legacy plaintext row (pre-OPS-MSG-02) — migrate it to wrapped on
    // first read so the cleartext key doesn't survive.
    if (row.master_key_b64) {
      await this.setGroupKey(groupId, row.master_key_b64, row.epoch ?? 0);
      return row.master_key_b64;
    }
    return null;
  }

  /**
   * Persist a group master key. Source can be a freshly-generated
   * key we're about to distribute (we're the creator) or one learned
   * from a peer's admin envelope. Idempotent — last writer wins
   * (Phase 1 single-creator assumption; rekey is handled identically).
   */
  async setGroupKey(groupId: string, masterKeyB64: string, epoch = 0): Promise<void> {
    // Audit OPS-MSG-02 — store the master key wrapped with the vault key.
    // Drops the legacy plaintext column so a migrated row keeps no
    // cleartext copy.
    const wrapped = await wrapString(this.wrapKey, masterKeyB64);
    await this.db.put('group_keys', {
      group_id:           groupId,
      master_key_wrapped: wrapped,
      epoch,
      updated_at:         Date.now(),
    });
  }

  // ── Utilities ─────────────────────────────────────────────────────

  /**
   * Send a `control: 'rehandshake'` envelope to `peer`. Used after
   * receive-side auto-rebuild to nudge the original sender so their
   * libsignal session-replaces on decrypt. Best-effort; failures
   * leave the manual reset path as the safety net.
   */
  private async sendRehandshakeNudge(peer: SessionAddress): Promise<void> {
    try {
      const cert = await this.getSenderCert();
      // Audit P0-1 / S1 (ops parity) — stamp the recipient+timestamp AAD
      // and bind the cert into the outer wrap (v3). A mobile recipient
      // verifies the AAD BEFORE the `control:'rehandshake'` short-circuit
      // and, with requireAad defaulting true, DROPS a nudge that carries
      // no aad — which would silently defeat the auto-heal. Stamping the
      // aad + cert makes the nudge land like a mobile-originated one.
      // Note: the ops-console local SealedAad carries {to, ts} only —
      // enough to satisfy a mobile receiver's requireAad + recipient +
      // freshness checks. The optional sender/conversation bindings are
      // skipped on the receiver when absent (same posture as the shared
      // package's group broadcast), so this interops cleanly.
      const sealed = sealPayload(cert, '', {
        control: 'rehandshake',
        aad: {to: peer, ts: Date.now()},
      });
      const ct = await this.session.encrypt(peer, sealed);
      const cached = await this.store.loadIdentityKey(`${peer.userId}.${peer.deviceId}`);
      let recipientIdentityKeyB64: string;
      if (cached) {
        recipientIdentityKeyB64 = toBase64(cached);
      } else {
        const bundle = await keysApi.fetchBundle(peer.userId);
        recipientIdentityKeyB64 = bundle.identityKey;
      }
      const outerSealed = await wrapOuter({
        recipientIdentityKeyB64,
        sender:     this.self,
        ciphertext: ct,
        cert,
      });
      await relay.send(this.self.deviceId, {
        recipient:    peer,
        outerSealed,
        clientMsgId:  genId(),
      });
    } catch { /* swallow — manual reset is the safety net */ }
  }

  /**
   * Manual recovery — close + refetch + reinitialise the Signal
   * session with `peer`. Called from the Mission Group panel's
   * "Reset session" affordance when a recipient stays in
   * "decrypt failed" state.
   */
  async resetSessionWith(peer: SessionAddress): Promise<void> {
    try { await this.session.closeSession(peer); } catch { /* best effort */ }
    const bundle = await keysApi.fetchBundle(peer.userId);
    await this.session.initOutgoingSession({
      registrationId: bundle.registrationId,
      address:        peer,
      identityKey:    bundle.identityKey,
      signedPreKey:   {
        keyId:     bundle.signedPrekeyId,
        publicKey: bundle.signedPrekey,
        signature: bundle.signedPrekeySig,
      },
      preKey: bundle.oneTimePrekey
        ? {keyId: bundle.oneTimePrekey.keyId, publicKey: bundle.oneTimePrekey.publicKey}
        : undefined,
    });
    lastRebuildAttempt.delete(`${peer.userId}.${peer.deviceId}`);
  }

  /** Wipe everything for this user — used by the "reset identity" flow. */
  async wipe(): Promise<void> {
    this.stopListening();
    this.db.close();
    await new Promise<void>((res, rej) => {
      const req = indexedDB.deleteDatabase(`bravo-messenger-${this.userId}`);
      req.onsuccess = () => res();
      req.onerror = () => rej(req.error);
      req.onblocked = () => res();
    });
  }
}

function genId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}
