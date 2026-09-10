/**
 * B-703 MR-12 — the silent status-write miss, and the boot race that exploits it.
 *
 * `updateMessageStatus` and `updateMessageEnvelopeId` no-op when the row is not
 * in the store. That silence is what made a whole class of "tap to retry"
 * undebuggable: the startup outbox drain writes its acceptance artifacts
 * STORE-FIRST, so if it ships before hydration both writes vanish while
 * `markDelivered` durably deletes the outbox row — and the MSG-07 boot sweep
 * then sees a hydrated 'sending' row with no outbox row and no artifacts and
 * reds a message the relay accepted.
 *
 * Two halves, pinned here: the warn (promised by MESSAGE_LOOP W14 and never
 * landed, so none of this was ever visible in a device log) and the ordering
 * that removes the race.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {useMessengerStore, _resetStoreMissWarnsForTests} from '../store/messengerStore';
import type {LocalMessage} from '../store/types';

const RUNTIME = readFileSync(
  join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts'), 'utf8');

function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map(l => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

beforeEach(() => {
  useMessengerStore.setState({messages: {}, conversations: {}, groups: {}});
  _resetStoreMissWarnsForTests();
});

describe('a status write that misses says so', () => {
  it('warns with ids only when the row is not in the store', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      useMessengerStore.getState().updateMessageStatus('direct:peer-1', 'msg-abc', 'sent');
      const line = warn.mock.calls.flat().join(' ');
      expect(line).toContain('updateMessageStatus MISS');
      expect(line).toContain('msg-abc'.slice(0, 8));
      expect(line).toContain('sent');
    } finally { warn.mockRestore(); }
  });

  it('warns when the acceptance artifact misses — that is what the boot sweep reads', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      useMessengerStore.getState().updateMessageEnvelopeId('direct:peer-1', 'msg-abc', 'env-1');
      expect(warn.mock.calls.flat().join(' ')).toContain('updateMessageEnvelopeId MISS');
    } finally { warn.mockRestore(); }
  });

  it('stays quiet on a real hit — the warn must not become background noise', () => {
    const st = useMessengerStore.getState();
    st.appendMessage('direct:peer-1', {
      id: 'msg-abc', conversation_id: 'direct:peer-1', sender_id: 'self', type: 'text',
      content: 'hi', status: 'sending', is_encrypted: true,
      created_at: '2026-08-30T10:00:00.000Z', peer: {userId: 'peer-1', deviceId: 1},
    } as LocalMessage);

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      useMessengerStore.getState().updateMessageStatus('direct:peer-1', 'msg-abc', 'sent');
      useMessengerStore.getState().updateMessageEnvelopeId('direct:peer-1', 'msg-abc', 'env-1');
      expect(warn.mock.calls.flat().join(' ')).not.toContain('MISS');
    } finally { warn.mockRestore(); }

    const row = useMessengerStore.getState().messages['direct:peer-1'][0];
    expect(row.status).toBe('sent');
    expect(row.envelope_id).toBe('env-1');
  });

  it('is BOUNDED — reactions/edits/deletes legitimately have no bubble row', () => {
    // Those lanes register a messageId that is a synthetic wire id with no
    // store row on purpose, and every accepted control envelope misses twice
    // PER RECIPIENT LEG: one reaction in a 20-member channel is ~38 lines, in a
    // release build (only console.log is stripped). An unbounded warn would
    // drown the device logs this exists to improve.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (let i = 0; i < 200; i++) {
        useMessengerStore.getState().updateMessageStatus('direct:peer-1', `wire-${i}`, 'sent');
      }
      const lines = warn.mock.calls.flat().join('\n');
      expect(warn.mock.calls.length).toBeLessThan(40);
      expect(lines).toContain('further write-MISS lines suppressed');
    } finally { warn.mockRestore(); }
  });

  it('logs no message CONTENT (logAudit)', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      useMessengerStore.getState().updateMessageStatus('direct:peer-1', 'msg-abc', 'failed');
      const line = warn.mock.calls.flat().join(' ');
      expect(line).not.toMatch(/content|body|plaintext/i);
    } finally { warn.mockRestore(); }
  });
});

describe('the startup outbox drain runs AFTER hydration (MR-12)', () => {
  // The same call text appears at several unrelated kick sites (the connect
  // handler, the AppState-background handler), so a bare indexOf finds one of
  // those and proves nothing. Assert positionally against the boot sequence.
  const src = stripComments(RUNTIME);
  // Lower bound is where the RACE OPENS — the outbox being constructed — not
  // the B-124 sweep warn a few lines later. A kick reintroduced between the two
  // races identically and would have passed the earlier anchor.
  const outboxBuilt  = src.indexOf('sqlOutbox   = new SqlOutboxStore');
  const hydrate      = src.indexOf('hydrateMessages(persisted)');
  const hydrateCatch = src.indexOf("console.warn('[messenger] SQL hydrate failed'");

  it('does NOT kick between the outbox being built and the hydrate — that is the race', () => {
    expect(outboxBuilt).toBeGreaterThan(-1);
    expect(hydrate).toBeGreaterThan(outboxBuilt);
    // Above the hydrate the drain's store-first artifact writes land in an
    // EMPTY messages map, while markDelivered durably drops the outbox row —
    // and the MSG-07 sweep then reds a message the relay accepted.
    expect(src.slice(outboxBuilt, hydrate)).not.toContain('drainOutboxWhenReady(sqlOutbox');
  });

  it('kicks after the hydrate, and OUTSIDE its try so a hydrate failure cannot cancel catch-up', () => {
    expect(hydrateCatch).toBeGreaterThan(hydrate);
    // Bounded to the block that follows, so an unrelated kick later in this
    // 10k-line file cannot stand in for the boot one.
    const groupKeyWarm = src.indexOf('GroupMasterKeyStore', hydrateCatch);
    expect(groupKeyWarm).toBeGreaterThan(hydrateCatch);
    expect(src.slice(hydrateCatch, groupKeyWarm)).toContain('drainOutboxWhenReady(sqlOutbox');
  });
});
