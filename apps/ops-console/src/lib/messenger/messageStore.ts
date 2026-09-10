/**
 * Persistent conversation history for ops-console — IndexedDB mirror
 * of `src/modules/messenger/store/sqlMessageStore.ts` on mobile.
 *
 * Every body + reactions blob is wrapped with the vault key (the same
 * AES-GCM key that protects sessions/identity rows), so disk forensics
 * gives nothing without the passphrase. Reactions are folded onto the
 * row in place — we don't separate them into a side table because the
 * on-disk count stays small and the read path becomes trivial.
 *
 * The runtime owns a single instance per unlocked vault. Components
 * never touch this directly — they go through `MessengerRuntime`.
 */

import {wrapString, unwrapString, type WrapKey} from './crypto';
import type {MessengerDb} from './idb';

export interface StoredMessage {
  conversationId: string;
  id:             string;
  senderUserId:   string;
  direction:      'in' | 'out';
  body:           string;
  sentAt:         number;
  envelopeId:     string | null;
  clientMsgId:    string | null;
  status:         'sending' | 'sent' | 'delivered' | 'read' | 'failed';
  reactions:      Record<string, string> | null;
  replyToId:      string | null;
}

export class MessageStore {
  constructor(private readonly db: MessengerDb, private readonly key: WrapKey) {}

  private pk(conversationId: string, id: string): string {
    return `${conversationId}|${id}`;
  }

  /** Persist (or overwrite) a single message. Idempotent on (conversation_id, id). */
  async upsert(msg: StoredMessage): Promise<void> {
    const wrapped = await wrapString(this.key, msg.body);
    const reactionsWrapped = msg.reactions
      ? await wrapString(this.key, JSON.stringify(msg.reactions))
      : null;
    await this.db.put('messages', {
      pk:              this.pk(msg.conversationId, msg.id),
      conversation_id: msg.conversationId,
      id:              msg.id,
      sender_user_id:  msg.senderUserId,
      direction:       msg.direction,
      body:            wrapped,
      sent_at:         msg.sentAt,
      envelope_id:     msg.envelopeId,
      client_msg_id:   msg.clientMsgId,
      status:          msg.status,
      reactions_json:  reactionsWrapped,
      reply_to_id:     msg.replyToId,
    });
  }

  /** Patch fields on an existing row. No-op when the row is missing. */
  async patch(
    conversationId: string,
    id: string,
    fields: Partial<Pick<StoredMessage, 'status' | 'envelopeId' | 'clientMsgId' | 'reactions'>>,
  ): Promise<void> {
    const row = await this.db.get('messages', this.pk(conversationId, id));
    if (!row) return;
    if (fields.status      !== undefined) row.status        = fields.status;
    if (fields.envelopeId  !== undefined) row.envelope_id   = fields.envelopeId;
    if (fields.clientMsgId !== undefined) row.client_msg_id = fields.clientMsgId;
    if (fields.reactions   !== undefined) {
      row.reactions_json = fields.reactions
        ? await wrapString(this.key, JSON.stringify(fields.reactions))
        : null;
    }
    await this.db.put('messages', row);
  }

  async remove(conversationId: string, id: string): Promise<void> {
    await this.db.delete('messages', this.pk(conversationId, id));
  }

  /**
   * Hydrate every message in `conversationId`, sorted by send time.
   * The cursor scan uses the `pk` prefix; we don't need the secondary
   * index for a single-conversation read — the prefix-bounded range is
   * already O(log n + k) on the primary key.
   */
  async loadConversation(conversationId: string): Promise<StoredMessage[]> {
    const range = IDBKeyRange.bound(`${conversationId}|`, `${conversationId}|￿`);
    const rows = await this.db.getAll('messages', range);
    rows.sort((a, b) => a.sent_at - b.sent_at);
    const out: StoredMessage[] = [];
    for (const r of rows) {
      const body = await unwrapString(this.key, r.body);
      const reactions = r.reactions_json
        ? (JSON.parse(await unwrapString(this.key, r.reactions_json)) as Record<string, string>)
        : null;
      out.push({
        conversationId: r.conversation_id,
        id:             r.id,
        senderUserId:   r.sender_user_id,
        direction:      r.direction,
        body,
        sentAt:         r.sent_at,
        envelopeId:     r.envelope_id,
        clientMsgId:    r.client_msg_id,
        status:         r.status,
        reactions,
        replyToId:      r.reply_to_id,
      });
    }
    return out;
  }
}
