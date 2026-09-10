/**
 * Group-call SFrame orchestrator. Platform-agnostic — lives in
 * messenger-core so the tests run in the proven Node env, and so
 * ops-console can use the same layer the day group calls land there.
 *
 * Owns one SframeSender per local producer (audio + video) and one
 * SframeReceiver per (participantTag, kind) inbound stream. The group
 * master key + epoch come from an injected `GroupKeySource` —
 * production callers wire it to `useMessengerStore.groups`, tests
 * supply an in-memory fake.
 *
 * Why this layer exists separately from useGroupCall.ts:
 *   - useGroupCall already pushes 1500 lines; the encryption seam
 *     needs its own surface so the integration is auditable in
 *     isolation.
 *   - The cipher must survive minimize→restore (the registry path).
 *     Holding sender/receiver state outside the React hook lifecycle
 *     means a remount doesn't drop the counter and force-resync with
 *     the SFU. Each instance is keyed by roomId.
 *
 * The SFU never sees the master key, the base key, or any per-frame
 * key. Every derivation happens on-device.
 */

import {
  SframeReceiver,
  SframeSender,
  deriveSframeBaseKey,
  type MediaKind,
} from './sframe';

export interface GroupKeySource {
  /** Current master key + epoch, or null if the group isn't known. */
  current(conversationId: string): {masterKeyB64: string; epoch: number} | null;
  /**
   * Subscribe to subsequent changes. The implementation MUST call the
   * listener every time the (masterKeyB64, epoch) tuple changes for
   * the given conversation. Returns an unsubscribe fn.
   */
  subscribe(
    conversationId: string,
    listener:       (next: {masterKeyB64: string; epoch: number}) => void,
  ): () => void;
}

export interface GroupCallEncryptionOptions {
  /** Conversation that owns the call. */
  conversationId: string;
  /** Local participant's SFU-assigned tag. */
  selfTag:        string;
  /** Where to fetch the master key from. No default — caller must wire it. */
  keySource:      GroupKeySource;
}

function receiverKey(participantTag: string, kind: MediaKind): string {
  return `${participantTag}::${kind}`;
}

export class GroupCallEncryption {
  private readonly conversationId: string;
  private readonly selfTag:        string;
  private readonly keySource:      GroupKeySource;
  private epoch     = -1;
  private baseKey:  Uint8Array | null = null;
  private masterKey: string | null    = null;
  private readonly senders   = new Map<MediaKind, SframeSender>();
  private readonly receivers = new Map<string, SframeReceiver>();
  private storeUnsub: (() => void) | null = null;
  private rotationInFlight: Promise<void> | null = null;

  constructor(opts: GroupCallEncryptionOptions) {
    this.conversationId = opts.conversationId;
    this.selfTag        = opts.selfTag;
    this.keySource      = opts.keySource;
  }

  /**
   * Initialise from the current group state. Throws if the group has
   * no master key (1:1 call routed through SFU, or unsynced group).
   * Callers MUST treat this throw as "refuse to start an unencrypted
   * group call" — never silently downgrade.
   */
  async init(): Promise<void> {
    const state = this.keySource.current(this.conversationId);
    if (!state) {
      throw new Error(
        `groupCallEncryption: no group key for conversation=${this.conversationId} — refuse to start unencrypted SFU call`,
      );
    }
    this.masterKey = state.masterKeyB64;
    this.epoch     = state.epoch;
    this.baseKey   = await deriveSframeBaseKey(state.masterKeyB64, state.epoch);

    this.storeUnsub = this.keySource.subscribe(this.conversationId, (next) => {
      if (next.masterKeyB64 === this.masterKey && next.epoch === this.epoch) {return;}
      // Track the chained promise itself — assigning `p.finally(...)`
      // and then comparing `this.rotationInFlight === p` would never
      // match (finally returns a fresh promise) and whenIdle() would
      // loop forever.
      const chained: Promise<void> = this.rotate(next.masterKeyB64, next.epoch).finally(() => {
        if (this.rotationInFlight === chained) {this.rotationInFlight = null;}
      });
      this.rotationInFlight = chained;
    });
  }

  isReady(): boolean { return this.baseKey !== null; }

  /**
   * Resolves when any in-flight rotation completes. Used by callers
   * that just bumped the group state and need to be sure the cipher
   * is on the new epoch before sending. Resolves immediately if no
   * rotation is pending.
   */
  async whenIdle(): Promise<void> {
    while (this.rotationInFlight) {
      await this.rotationInFlight;
    }
  }

  private async rotate(newMasterKeyB64: string, newEpoch: number): Promise<void> {
    if (newMasterKeyB64 === this.masterKey && newEpoch === this.epoch) {return;}
    this.masterKey = newMasterKeyB64;
    this.epoch     = newEpoch;
    this.baseKey   = await deriveSframeBaseKey(newMasterKeyB64, newEpoch);
    for (const s of this.senders.values()) {s.rotate(this.baseKey, newEpoch);}
    for (const r of this.receivers.values()) {r.rotate(this.baseKey, newEpoch);}
  }

  getOrCreateSender(kind: MediaKind): SframeSender {
    if (!this.baseKey) {
      throw new Error('groupCallEncryption: getOrCreateSender called before init()');
    }
    const existing = this.senders.get(kind);
    if (existing) {return existing;}
    const sender = new SframeSender({
      baseKey:        this.baseKey,
      epoch:          this.epoch,
      participantTag: this.selfTag,
      kind,
    });
    this.senders.set(kind, sender);
    return sender;
  }

  getOrCreateReceiver(participantTag: string, kind: MediaKind): SframeReceiver {
    if (!this.baseKey) {
      throw new Error('groupCallEncryption: getOrCreateReceiver called before init()');
    }
    const key = receiverKey(participantTag, kind);
    const existing = this.receivers.get(key);
    if (existing) {return existing;}
    const receiver = new SframeReceiver({
      baseKey:        this.baseKey,
      epoch:          this.epoch,
      participantTag,
      kind,
    });
    this.receivers.set(key, receiver);
    return receiver;
  }

  dropReceiver(participantTag: string, kind: MediaKind): void {
    this.receivers.delete(receiverKey(participantTag, kind));
  }

  dispose(): void {
    this.senders.clear();
    this.receivers.clear();
    this.baseKey   = null;
    this.masterKey = null;
    this.epoch     = -1;
    if (this.storeUnsub) {
      try {this.storeUnsub();} catch { /* ignore */ }
      this.storeUnsub = null;
    }
  }
}
