import type {DbHandle} from '../crypto/db';

/**
 * Audit P0-S3 / P0-S5 — group master key persistence.
 *
 * Group master keys move OUT of the Zustand-backed AsyncStorage vault
 * (where they previously lived as plaintext base64 inside
 * `vaultByOwner[*].groups[*].masterKeyB64`) and INTO the SQLCipher DB.
 * Inside the DB they ride AES-256-GCM-encrypted under a per-user
 * wrap secret that lives in a SECOND keychain entry (separate from the
 * SQLCipher DB key — see `getOrCreateGroupWrapKey`).
 *
 * Threat model: an attacker now needs to extract BOTH the SQLCipher DB
 * key AND the group-wrap key from the OS keychain to recover a single
 * plaintext master key. The previous design held them in plaintext
 * AsyncStorage where any rooted-device dump, ADB backup, or file-vault
 * forensic tool could read them without any key extraction at all.
 */

const ALG = 'AES-GCM';
const IV_LEN = 12;

function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
  const atob = (globalThis as {atob?: (s: string) => string}).atob;
  if (!atob) {throw new Error('no base64 decoder available');}
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {out[i] = bin.charCodeAt(i);}
  return out;
}

function bytesToBase64(buf: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(buf).toString('base64');
  }
  const btoa = (globalThis as {btoa?: (s: string) => string}).btoa;
  if (!btoa) {throw new Error('no base64 encoder available');}
  let bin = '';
  for (const b of buf) {bin += String.fromCharCode(b);}
  return btoa(bin);
}

function toUint8Array(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) {return v;}
  if (v instanceof ArrayBuffer) {return new Uint8Array(v);}
  if (ArrayBuffer.isView(v)) {
    const view = v as ArrayBufferView;
    return new Uint8Array(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength);
  }
  throw new Error('expected BLOB, got ' + typeof v);
}

/**
 * WebCrypto across the Hermes / Node split is strict about BufferSource —
 * it rejects `Uint8Array<ArrayBufferLike>` when the underlying buffer is
 * even nominally typed as `ArrayBufferLike` rather than `ArrayBuffer`.
 * Copy the bytes into a fresh `ArrayBuffer` for every subtle.* call.
 */
function toAb(u: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(u.byteLength);
  new Uint8Array(out).set(u);
  return out;
}

async function importWrapKey(wrapKeyB64: string): Promise<CryptoKey> {
  const raw = base64ToBytes(wrapKeyB64);
  if (raw.length !== 32) {
    throw new Error('group wrap key must be 32 bytes (got ' + raw.length + ')');
  }
  return crypto.subtle.importKey('raw', toAb(raw), ALG, false, ['encrypt', 'decrypt']);
}

export class GroupMasterKeyStore {
  constructor(
    private readonly db: DbHandle,
    /**
     * Per-user wrap secret loaded once at runtime boot from the second
     * keychain entry. Held as a base64 string so this module doesn't
     * pin the raw bytes in JS heap across the whole session — we
     * re-import per call, which is sub-millisecond on WebCrypto.
     */
    private readonly wrapKeyB64: string,
  ) {}

  /**
   * Write (or overwrite) the wrapped master key for one group. Called
   * from the runtime's store-subscriber whenever Zustand's `s.groups`
   * mutates so the on-disk copy stays in sync with the in-memory state.
   * Idempotent: re-writing the same key yields a fresh GCM nonce + a
   * fresh ciphertext (so disk forensics can't even confirm "the key
   * didn't change" by comparing rows).
   */
  async setKey(groupId: string, masterKeyB64: string): Promise<void> {
    if (!groupId || !masterKeyB64) {return;}
    const masterBytes = base64ToBytes(masterKeyB64);
    const iv = new Uint8Array(IV_LEN);
    crypto.getRandomValues(iv);
    const wrap = await importWrapKey(this.wrapKeyB64);
    const wrapped = await crypto.subtle.encrypt({name: ALG, iv: toAb(iv)}, wrap, toAb(masterBytes));
    await this.db.execute(
      `INSERT OR REPLACE INTO group_master_keys
         (group_id, wrapped_key, iv, updated_at)
       VALUES (?, ?, ?, ?)`,
      [groupId, new Uint8Array(wrapped), iv, Date.now()],
    );
  }

  /**
   * Read + unwrap one group's master key. Returns undefined when:
   *   - no row exists (group not joined on this device),
   *   - the wrapped row exists but the GCM auth-tag check fails
   *     (wrap key was destroyed mid-life, or the row is corrupt).
   *
   * GCM failures are NEVER soft-recovered to a wrong-but-plausible
   * plaintext: AES-GCM either authenticates the ciphertext or throws.
   */
  async getKey(groupId: string): Promise<string | undefined> {
    if (!groupId) {return undefined;}
    const res = await this.db.execute(
      'SELECT wrapped_key, iv FROM group_master_keys WHERE group_id = ?',
      [groupId],
    );
    const rows = res.rows ?? [];
    if (!rows.length) {return undefined;}
    const r = rows[0] as {wrapped_key: unknown; iv: unknown};
    const wrapped = toUint8Array(r.wrapped_key);
    const iv = toUint8Array(r.iv);
    try {
      const wrap = await importWrapKey(this.wrapKeyB64);
      const plain = await crypto.subtle.decrypt({name: ALG, iv: toAb(iv)}, wrap, toAb(wrapped));
      return bytesToBase64(new Uint8Array(plain));
    } catch {
      return undefined;
    }
  }

  /**
   * Bulk-read every wrapped group key. Used by the runtime warm-up
   * path that runs after AsyncStorage rehydration but before the UI
   * renders the chat list — without it the in-memory `s.groups[*]`
   * would carry no masterKeyB64 (we strip it from the partialize
   * output, see messengerStore.ts) and inbound group envelopes would
   * fall into the no_key stash branch even though we have the key
   * on disk.
   */
  async loadAll(): Promise<Record<string, string>> {
    const res = await this.db.execute(
      'SELECT group_id, wrapped_key, iv FROM group_master_keys',
    );
    const rows = res.rows ?? [];
    const out: Record<string, string> = {};
    if (!rows.length) {return out;}
    const wrap = await importWrapKey(this.wrapKeyB64);
    for (const row of rows) {
      const r = row as {group_id: unknown; wrapped_key: unknown; iv: unknown};
      if (typeof r.group_id !== 'string') {continue;}
      try {
        const wrapped = toUint8Array(r.wrapped_key);
        const iv = toUint8Array(r.iv);
        const plain = await crypto.subtle.decrypt({name: ALG, iv: toAb(iv)}, wrap, toAb(wrapped));
        out[r.group_id] = bytesToBase64(new Uint8Array(plain));
      } catch {
        // Skip individual unwrap failures — one corrupt row should not
        // poison the whole load.
      }
    }
    return out;
  }

  /**
   * Drop one group's wrapped key (called when the user leaves the
   * group or is removed). The in-process `disposeGroupKey` runs
   * separately in messengerStore.removeGroupState.
   */
  async deleteKey(groupId: string): Promise<void> {
    if (!groupId) {return;}
    await this.db.execute(
      'DELETE FROM group_master_keys WHERE group_id = ?',
      [groupId],
    );
  }

  /**
   * Wipe every wrapped key. Used by the at-rest wipe path on logout
   * (P0-S1) immediately before the SQLCipher file itself is unlinked,
   * so an interrupted wipe can't leave wrapped rows pointing at a
   * destroyed wrap secret.
   */
  async deleteAll(): Promise<void> {
    await this.db.execute('DELETE FROM group_master_keys');
  }
}
