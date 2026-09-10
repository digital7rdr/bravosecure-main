/**
 * Signal resend protocol — SqlMessageStore.recentUndeliveredSelfText query.
 *
 * The resend handler re-transmits recent still-undelivered 1:1 TEXT messages to
 * a peer that signalled (via rehandshake) it rebuilt its session. This test
 * pins the query's filter: only our OWN (sender_id='self'), still-'sent'
 * (not delivered/read), TEXT (attachments excluded), within the recency window,
 * newest-first, capped — against an in-memory fake DbHandle (no op-sqlite).
 */
import {SqlMessageStore} from '../store/sqlMessageStore';

interface Row {
  id: string; conversation_id: string; sender_id: string; type: string;
  content: string | null; status: string; created_at: string;
  is_encrypted: number; peer_user_id: string; peer_device_id: number;
  media_mime: null; media_object_key: null; media_key: null; media_iv: null;
  envelope_id: null; retract_token: null; expires_at: number | null;
  reply_to_msg_id: null; reply_to_preview: null; reactions_json: null;
  call_meta_json: null; media_meta_json: null;
}

function makeRow(o: Partial<Row> & {id: string; created_at: string}): Row {
  return {
    conversation_id: 'c1', sender_id: 'self', type: 'text', content: 'hi',
    status: 'sent', is_encrypted: 1, peer_user_id: 'bob', peer_device_id: 1,
    media_mime: null, media_object_key: null, media_key: null, media_iv: null,
    envelope_id: null, retract_token: null, expires_at: null,
    reply_to_msg_id: null, reply_to_preview: null, reactions_json: null,
    call_meta_json: null, media_meta_json: null, ...o,
  };
}

function makeFakeDb(rows: Row[]) {
  return {
    execute: async (sql: string, params: unknown[]) => {
      if (
        /sender_id = 'self'/.test(sql) &&
        /status = 'sent'/.test(sql) &&
        /type = 'text'/.test(sql)
      ) {
        const [convoId, sinceIso, limit] = params as [string, string, number];
        const out = rows
          .filter(r =>
            r.conversation_id === convoId &&
            r.sender_id === 'self' &&
            r.status === 'sent' &&
            r.type === 'text' &&
            r.created_at >= sinceIso)
          .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
          .slice(0, limit);
        return {rows: out};
      }
      return {rows: []};
    },
  };
}

describe('SqlMessageStore.recentUndeliveredSelfText (resend protocol)', () => {
  const SINCE = '2026-07-04T00:00:00.000Z';
  const seed: Row[] = [
    makeRow({id: 'm-new-2', created_at: '2026-07-04T00:05:00.000Z'}),           // ✓ recent self sent text
    makeRow({id: 'm-new-1', created_at: '2026-07-04T00:02:00.000Z'}),           // ✓ recent self sent text
    makeRow({id: 'm-old',   created_at: '2026-07-03T23:00:00.000Z'}),           // ✗ before window
    makeRow({id: 'm-delivered', created_at: '2026-07-04T00:06:00.000Z', status: 'delivered'}), // ✗ already delivered
    makeRow({id: 'm-peer', created_at: '2026-07-04T00:07:00.000Z', sender_id: 'bob'}),          // ✗ inbound
    makeRow({id: 'm-image', created_at: '2026-07-04T00:08:00.000Z', type: 'image'}),            // ✗ attachment
    makeRow({id: 'm-other-convo', created_at: '2026-07-04T00:09:00.000Z', conversation_id: 'c2'}), // ✗ other convo
  ];

  it('returns only recent self-sent, still-sent, text messages, newest-first', async () => {
    const store = new SqlMessageStore(makeFakeDb(seed) as never);
    const result = await store.recentUndeliveredSelfText('c1', SINCE, 10);
    expect(result.map(m => m.id)).toEqual(['m-new-2', 'm-new-1']);
  });

  it('respects the limit cap', async () => {
    const store = new SqlMessageStore(makeFakeDb(seed) as never);
    const result = await store.recentUndeliveredSelfText('c1', SINCE, 1);
    expect(result.map(m => m.id)).toEqual(['m-new-2']);
  });

  it('returns empty when nothing qualifies', async () => {
    const store = new SqlMessageStore(makeFakeDb(seed) as never);
    const result = await store.recentUndeliveredSelfText('c1', '2026-07-05T00:00:00.000Z', 10);
    expect(result).toEqual([]);
  });
});
