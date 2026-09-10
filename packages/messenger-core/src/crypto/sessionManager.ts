import {
  SessionBuilder,
  SessionCipher,
  SignalProtocolAddress,
} from '@privacyresearch/libsignal-protocol-typescript';
import type {
  CryptoStore,
  Ciphertext,
  PreKeyBundle,
  SessionAddress,
} from './types';
import { CiphertextType } from './types';
import { fromBase64, toBase64, utf8ToBuffer, bufferToUtf8 } from './encoding';
import {
  DecryptError,
  IdentityMismatchError,
  NoSessionError,
} from './errors';

/**
 * High-level façade for the Signal session lifecycle. UI and network
 * code talk only to this class — they never touch SessionBuilder /
 * SessionCipher directly. Every call is bound to a specific peer
 * address so session state stays isolated per conversation.
 *
 * Audit fix #10 — per-address mutex.
 *
 *   The Double Ratchet is NOT thread-safe across concurrent encrypts
 *   to the same peer: each encrypt advances the sending chain, so two
 *   in-flight encrypts can both read the same chain-key, derive the
 *   same message key, and emit ciphertexts that decrypt to the same
 *   counter on the receiver. The receiver's libsignal then rejects one
 *   as a replay AND poisons the ratchet because the chain has moved
 *   on. Symptom: "Bad Mac" / "InvalidMessageException" on the next
 *   real message, with both sides stuck.
 *
 *   The hot path that produces this is group fan-out: `for (member of
 *   group.members) await own.encrypt(peer, sealed)` + a parallel
 *   inbound `envelope.deliver` from the same peer that takes a
 *   `decrypt` lock. We serialise every operation on the SAME peer
 *   address through a per-address Promise chain. Different peers
 *   still run in parallel; ops to ONE peer queue.
 */
export class SessionManager {
  constructor(private readonly store: CryptoStore) {}

  /**
   * Per-peer Promise chain. Key is `${userId}.${deviceId}`. Each
   * encrypt/decrypt/initOutgoingSession appends to the chain so the
   * next operation only starts after the previous resolves OR rejects.
   * `.catch(() => {})` keeps a rejected work item from poisoning later
   * lock-holders (the rejection is still surfaced to the original
   * caller via the awaited `next` promise).
   */
  private readonly locks = new Map<string, Promise<unknown>>();

  private addr(address: SessionAddress): SignalProtocolAddress {
    return new SignalProtocolAddress(address.userId, address.deviceId);
  }

  /**
   * Run `work` under the per-address lock. Returns `work`'s result.
   * Lock entries are cleaned up when their work resolves so the map
   * doesn't grow unbounded for long-tail addresses.
   */
  private async withLock<T>(address: SessionAddress, work: () => Promise<T>): Promise<T> {
    const key = `${address.userId}.${address.deviceId}`;
    const prev = this.locks.get(key) ?? Promise.resolve();
    // Chain on prev's settlement (success OR failure). The .catch on
    // prev's tail isolates future work from past failures.
    const next = prev.catch(() => undefined).then(() => work());
    this.locks.set(key, next);
    try {
      return await next;
    } finally {
      // Drop the slot only if we're still the head. A newer lock-
      // holder may have appended in the meantime; leave it untouched.
      if (this.locks.get(key) === next) {
        this.locks.delete(key);
      }
    }
  }

  async hasSession(address: SessionAddress): Promise<boolean> {
    const rec = await this.store.loadSession(this.addr(address).toString());
    // Audit fix #11 — loadSession is typed `Promise<string | undefined>`
    // (matches CryptoStore.loadSession). The historical `!== null && !==
    // undefined` was defensive against a now-removed null path; one
    // `!== undefined` is enough.
    return rec !== undefined;
  }

  /**
   * X3DH: consume a peer's PreKeyBundle and establish a new outbound
   * session. Subsequent encrypt() calls to this address will use the
   * Double Ratchet over that session. Safe to call more than once —
   * the library handles re-init by replacing the stored session.
   */
  async initOutgoingSession(bundle: PreKeyBundle): Promise<void> {
    return this.withLock(bundle.address, async () => {
      const builder = new SessionBuilder(
        this.store as never,
        this.addr(bundle.address),
      );
      const libBundle = {
        registrationId: bundle.registrationId,
        identityKey: fromBase64(bundle.identityKey),
        signedPreKey: {
          keyId: bundle.signedPreKey.keyId,
          publicKey: fromBase64(bundle.signedPreKey.publicKey),
          signature: fromBase64(bundle.signedPreKey.signature),
        },
        preKey: bundle.preKey
          ? {
              keyId: bundle.preKey.keyId,
              publicKey: fromBase64(bundle.preKey.publicKey),
            }
          : undefined,
      };
      try {
        await builder.processPreKey(libBundle);
      } catch (e) {
        if (isIdentityError(e)) {
          throw new IdentityMismatchError(
            this.addr(bundle.address).toString(),
            e,
          );
        }
        throw e;
      }
    });
  }

  /**
   * Encrypt a plaintext string for `address`. The first message after
   * initOutgoingSession returns type=PreKeyWhisper; all later messages
   * return type=Whisper. Callers relay both opaquely — the peer's
   * SessionCipher decides which decrypt path applies.
   */
  async encrypt(address: SessionAddress, plaintext: string): Promise<Ciphertext> {
    return this.withLock(address, async () => {
      const cipher = new SessionCipher(this.store as never, this.addr(address));
      const out = await cipher.encrypt(utf8ToBuffer(plaintext));
      if (out.body === null || out.body === undefined) {
        throw new Error('SessionCipher produced empty body');
      }
      const body =
        typeof out.body === 'string' ? out.body : toBase64(out.body as ArrayBuffer);
      return {
        type: out.type === 3 ? CiphertextType.PreKeyWhisper : CiphertextType.Whisper,
        body,
      };
    });
  }

  /**
   * Decrypt an incoming ciphertext. The caller is responsible for
   * persisting the plaintext (or discarding it, for disappearing
   * messages) — SessionManager does not cache cleartext anywhere.
   */
  async decrypt(address: SessionAddress, ct: Ciphertext): Promise<string> {
    return this.withLock(address, async () => {
      const cipher = new SessionCipher(this.store as never, this.addr(address));
      try {
        const buf =
          ct.type === CiphertextType.PreKeyWhisper
            ? await cipher.decryptPreKeyWhisperMessage(ct.body, 'binary')
            : await cipher.decryptWhisperMessage(ct.body, 'binary');
        return bufferToUtf8(buf);
      } catch (e) {
        if (isNoSessionError(e)) {
          throw new NoSessionError(this.addr(address).toString());
        }
        throw new DecryptError('decrypt failed', e);
      }
    });
  }

  async closeSession(address: SessionAddress): Promise<void> {
    // closeSession also goes through the lock — letting it race against
    // an in-flight encrypt would let the encrypt write the session row
    // back AFTER the close, leaving a stale ratchet behind.
    return this.withLock(address, async () => {
      await this.store.removeSession(this.addr(address).toString());
    });
  }
}

function isIdentityError(e: unknown): boolean {
  if (!e || typeof e !== 'object') {return false;}
  const name = (e as { name?: string }).name ?? '';
  const msg = (e as { message?: string }).message ?? '';
  return name === 'UntrustedIdentityKeyError' || /identity/i.test(msg);
}

function isNoSessionError(e: unknown): boolean {
  if (!e || typeof e !== 'object') {return false;}
  const msg = (e as { message?: string }).message ?? '';
  return /no session|no record/i.test(msg);
}
