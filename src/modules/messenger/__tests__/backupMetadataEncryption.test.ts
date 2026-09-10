/**
 * Audit P0-B4 + P0-B5 — encrypt outer-row metadata.
 *
 * The pre-fix mirror wire shape shipped `sender_id`, `recipient_id`,
 * `conversation_id`, `msg_type`, `msg_created_at` as plaintext columns
 * server-side, leaking the user's social graph (who they talk to, when,
 * in which conversation, the message kinds) to anyone with a DB
 * snapshot. The server has no operational need for these fields beyond
 * the upsert primary key (owner_user_id, message_id) and the paging
 * cursor (msg_created_at).
 *
 * Wire schema v3 — emitted when MESSAGE_BACKUP_VERSION === 3:
 *   • sender_id / recipient_id / msg_type / conversation_id  ─ replaced
 *     with the per-user opaque sentinel `BACKUP_METADATA_SENTINEL`. The
 *     real values are encrypted inside the per-row payload (subkey-
 *     wrapped under the master key).
 *   • envelope_meta.wrappedSubkey ─ unchanged.
 *   • ciphertext_type ─ 3 (was 2).
 *   • msg_created_at ─ unchanged in plaintext (server needs it for
 *     cursor paging). This is a deliberate residual leak per the
 *     audit's plaintext-cursor design — the alternative is server
 *     scanning every row on every restore.
 *
 * Restore path:
 *   • v3 row ─ ignore outer columns; trust the decrypted payload.
 *   • v2 row ─ legacy path; the existing flow already handles it.
 *   • v1 row ─ legacy direct-master wrap; existing flow still works.
 *
 * group_state on the conversations endpoint is encrypted under the
 * master key when wireVersion === 3 (P0-B5 sibling fix). Legacy plaintext
 * group_state continues to deserialize via the existing reader.
 */
import {
  MESSAGE_BACKUP_VERSION,
  BACKUP_METADATA_SENTINEL,
  serializeMessageForBackup,
  deserializeMessageFromBackup,
  encryptGroupStateBlob,
  decryptGroupStateBlob,
} from '../backup/backupWireV3';
import type {LocalMessage} from '../store/types';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined},
}));

describe('Audit P0-B4/B5 — backup wire v3 metadata encryption', () => {
  const baseMsg: LocalMessage = {
    id:              'm-1',
    conversation_id: 'conv-direct-alice-bob',
    sender_id:       'user-alice',
    type:            'text',
    content:         'hello',
    status:          'sent',
    is_encrypted:    false,
    created_at:      '2026-01-15T10:00:00.000Z',
    peer:            {userId: 'user-bob', deviceId: 1},
  } as LocalMessage;

  it('MESSAGE_BACKUP_VERSION is 3', () => {
    expect(MESSAGE_BACKUP_VERSION).toBe(3);
  });

  it('BACKUP_METADATA_SENTINEL is a non-empty placeholder that NEVER matches a real id', () => {
    // The DB schema requires sender_id / msg_type to be NOT NULL — the
    // sentinel satisfies that without leaking anything user-identifying.
    expect(BACKUP_METADATA_SENTINEL.length).toBeGreaterThan(0);
    // Must be obviously not a UUID / not a message-type enum so a
    // post-mortem can tell at a glance the row is a v3 blind.
    expect(BACKUP_METADATA_SENTINEL).not.toMatch(/^[0-9a-f-]{8,}$/i);
    expect(['text', 'image', 'call', 'system', 'admin']).not.toContain(BACKUP_METADATA_SENTINEL);
  });

  it('serializeMessageForBackup emits sentinel-only outer columns', () => {
    const row = serializeMessageForBackup(baseMsg);
    expect(row.sender_id).toBe(BACKUP_METADATA_SENTINEL);
    expect(row.recipient_id).toBe(BACKUP_METADATA_SENTINEL);
    expect(row.msg_type).toBe(BACKUP_METADATA_SENTINEL);
    expect(row.conversation_id).toBe(BACKUP_METADATA_SENTINEL);
    expect(row.message_id).toBe('m-1');
    expect(row.msg_created_at).toBe('2026-01-15T10:00:00.000Z');
    expect(row.ciphertext_type).toBe(3);
  });

  it('serialized payload still carries the real values for restore', () => {
    const row = serializeMessageForBackup(baseMsg);
    // The payload is the JSON-stringified message — restore decrypts
    // and runs deserializeMessageFromBackup on it.
    const payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
    expect(payload.sender_id).toBe('user-alice');
    expect(payload.conversation_id).toBe('conv-direct-alice-bob');
    expect(payload.type).toBe('text');
    expect(payload.content).toBe('hello');
  });

  it('round-trips: serialize → deserialize gives back the original message', () => {
    const row = serializeMessageForBackup(baseMsg);
    const restored = deserializeMessageFromBackup({
      message_id:      row.message_id,
      msg_created_at:  row.msg_created_at,
      sender_id:       row.sender_id,
      recipient_id:    row.recipient_id,
      conversation_id: row.conversation_id,
      msg_type:        row.msg_type,
      ciphertext_type: row.ciphertext_type,
      payload:         JSON.parse(row.payloadJson),
    });
    expect(restored.sender_id).toBe(baseMsg.sender_id);
    expect(restored.conversation_id).toBe(baseMsg.conversation_id);
    expect(restored.type).toBe(baseMsg.type);
    expect(restored.content).toBe(baseMsg.content);
  });

  it('deserialize falls back to outer columns for legacy v1/v2 rows', () => {
    // Legacy row: outer columns are real, payload may not carry them.
    const restored = deserializeMessageFromBackup({
      message_id:      'legacy-1',
      msg_created_at:  '2025-01-01T00:00:00.000Z',
      sender_id:       'user-charlie',
      recipient_id:    'user-dave',
      conversation_id: 'conv-legacy',
      msg_type:        'text',
      ciphertext_type: 2,
      payload:         {content: 'legacy text'},
    });
    expect(restored.sender_id).toBe('user-charlie');
    expect(restored.conversation_id).toBe('conv-legacy');
    expect(restored.type).toBe('text');
  });

  it('group_state encryption round-trips (P0-B5)', async () => {
    const key = await crypto.subtle.generateKey({name: 'AES-GCM', length: 256}, true, ['encrypt', 'decrypt']);
    const plain = {
      groupId: 'g-1', name: 'Test Group', owner: 'user-alice',
      members: {'user-alice': {deviceId: 1, admin: true, joinedAt: 0}},
      masterKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      epoch: 0,
    };
    const encrypted = await encryptGroupStateBlob(key, plain);
    expect(encrypted).toHaveProperty('v', 3);
    expect(encrypted).toHaveProperty('blob');
    // The blob is base64; the master key MUST NOT appear in it.
    expect(typeof encrypted.blob).toBe('string');
    expect(encrypted.blob).not.toContain(plain.masterKeyB64);
    const decoded = await decryptGroupStateBlob(key, encrypted);
    expect(decoded.masterKeyB64).toBe(plain.masterKeyB64);
    expect(decoded.groupId).toBe('g-1');
    expect(decoded.members).toEqual(plain.members);
  });

  it('decryptGroupStateBlob passes through legacy plaintext object', async () => {
    const key = await crypto.subtle.generateKey({name: 'AES-GCM', length: 256}, true, ['encrypt', 'decrypt']);
    const legacy = {
      groupId: 'g-old', name: 'Old', owner: 'u', members: {},
      masterKeyB64: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA=', epoch: 0,
    };
    // No `v: 3` and no `blob` — legacy shape.
    const decoded = await decryptGroupStateBlob(key, legacy as unknown as {v: number; blob: string});
    expect(decoded.masterKeyB64).toBe(legacy.masterKeyB64);
    expect(decoded.groupId).toBe('g-old');
  });
});
