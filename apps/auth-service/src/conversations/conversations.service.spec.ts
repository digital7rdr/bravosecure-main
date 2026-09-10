import {Test, TestingModule} from '@nestjs/testing';
import {ForbiddenException, NotFoundException} from '@nestjs/common';
import {ConversationsService} from './conversations.service';
import {DatabaseService} from '../database/database.service';

/**
 * RS-02 / RS-08 — the conversation membership seam:
 *   • add/remove now enqueue conversation_membership_intents so an admin
 *     DEVICE performs the real group rekey (server never holds the key);
 *   • the last-admin auto-promotion writes a visible ops_audit row.
 * Mocks are keyed on SQL substrings because the audit writes are
 * fire-and-forget and may interleave with the main flow.
 */

type Handler = (sql: string, params: unknown[]) => unknown;

const mockDb = {
  q: jest.fn(),
  qOne: jest.fn(),
};

function onQOne(route: Array<[RegExp, Handler]>) {
  mockDb.qOne.mockImplementation(async (sql: string, params: unknown[]) => {
    for (const [re, fn] of route) {
      if (re.test(sql)) return fn(sql, params);
    }
    return null;
  });
}

describe('ConversationsService (RS-02 intents + RS-08 autopromote audit)', () => {
  let service: ConversationsService;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockDb.q.mockResolvedValue([]);
    mockDb.qOne.mockResolvedValue(null);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConversationsService,
        {provide: DatabaseService, useValue: mockDb},
      ],
    }).compile();
    service = module.get(ConversationsService);
  });

  const intentInserts = () =>
    mockDb.q.mock.calls.filter(c => /INSERT INTO public\.conversation_membership_intents/i.test(String(c[0])));
  const auditInserts = () =>
    mockDb.q.mock.calls.filter(c => /INSERT INTO ops_audit/i.test(String(c[0])));

  describe('removeMember', () => {
    it('forbids a non-admin removing someone else (no delete, no intent)', async () => {
      onQOne([[/SELECT role FROM public\.conversation_members/i, () => ({role: 'member'})]]);
      await expect(service.removeMember('conv-1', 'me', 'other'))
        .rejects.toBeInstanceOf(ForbiddenException);
      expect(intentInserts()).toHaveLength(0);
    });

    it('enqueues a remove intent + audit row when an admin removes a member', async () => {
      onQOne([
        [/SELECT role FROM public\.conversation_members/i, () => ({role: 'admin'})],
        [/DELETE FROM public\.conversation_members/i, () => ({user_id: 'target-1'})],
        [/role = 'admin' LIMIT 1/i, () => ({user_id: 'me'})],  // an admin remains
      ]);
      await service.removeMember('conv-1', 'me', 'target-1');

      expect(intentInserts()).toHaveLength(1);
      expect(intentInserts()[0][1]).toEqual(['conv-1', 'target-1', 'remove', 'me']);
      // No autopromote when an admin remains.
      const promote = mockDb.q.mock.calls.find(c => /SET role = 'admin'/i.test(String(c[0])));
      expect(promote).toBeUndefined();

      await new Promise(r => setImmediate(r)); // let the fire-and-forget audit land
      const audit = auditInserts().find(c => (c[1] as unknown[])[3] === 'conversation.member.remove');
      expect(audit).toBeDefined();
    });

    it('does NOT enqueue an intent when the target was not a member (no-op delete)', async () => {
      onQOne([
        [/SELECT role FROM public\.conversation_members/i, () => ({role: 'admin'})],
        [/DELETE FROM public\.conversation_members/i, () => null],
        [/role = 'admin' LIMIT 1/i, () => ({user_id: 'me'})],
      ]);
      await service.removeMember('conv-1', 'me', 'stranger');
      expect(intentInserts()).toHaveLength(0);
    });

    it('self-leave is allowed for a plain member and enqueues the remove intent', async () => {
      onQOne([
        [/SELECT role FROM public\.conversation_members/i, () => ({role: 'member'})],
        [/DELETE FROM public\.conversation_members/i, () => ({user_id: 'me'})],
        [/role = 'admin' LIMIT 1/i, () => ({user_id: 'admin-1'})],
      ]);
      await service.removeMember('conv-1', 'me', 'me');
      expect(intentInserts()).toHaveLength(1);
      expect(intentInserts()[0][1]).toEqual(['conv-1', 'me', 'remove', 'me']);
    });

    it('last-admin leave promotes the oldest member AND writes the autopromote audit row (RS-08)', async () => {
      onQOne([
        [/SELECT role FROM public\.conversation_members/i, () => ({role: 'admin'})],
        [/DELETE FROM public\.conversation_members/i, () => ({user_id: 'me'})],
        [/role = 'admin' LIMIT 1/i, () => null],                       // no admin left
        [/ORDER BY joined_at ASC LIMIT 1/i, () => ({user_id: 'oldest'})],
      ]);
      await service.removeMember('conv-1', 'me', 'me');

      const promote = mockDb.q.mock.calls.find(c => /SET role = 'admin'/i.test(String(c[0])));
      expect(promote?.[1]).toEqual(['conv-1', 'oldest']);

      await new Promise(r => setImmediate(r));
      const audit = auditInserts().find(c => (c[1] as unknown[])[3] === 'conversation.admin.autopromote');
      expect(audit).toBeDefined();
      const meta = JSON.parse(String((audit![1] as unknown[])[5]));
      expect(meta).toEqual({promoted: 'oldest', after_leave_of: 'me'});
    });

    it('audit failure never breaks the removal (swallow-safe)', async () => {
      onQOne([
        [/SELECT role FROM public\.conversation_members/i, () => ({role: 'admin'})],
        [/DELETE FROM public\.conversation_members/i, () => ({user_id: 'x'})],
        [/role = 'admin' LIMIT 1/i, () => ({user_id: 'me'})],
        [/FROM public\.admin_users/i, () => { throw new Error('audit db down'); }],
      ]);
      await expect(service.removeMember('conv-1', 'me', 'x')).resolves.toBeUndefined();
    });
  });

  describe('addMember', () => {
    it('enqueues an add intent for a genuinely new member', async () => {
      onQOne([
        [/SELECT role FROM public\.conversation_members/i, () => ({role: 'admin'})],
        [/INSERT INTO public\.conversation_members/i, () => ({user_id: 'new-1'})],
        [/SELECT id, kind, title/i, () => ({id: 'conv-1', kind: 'group', title: null, created_at: 'x', created_by: 'me'})],
      ]);
      await service.addMember('conv-1', 'me', 'new-1');
      expect(intentInserts()).toHaveLength(1);
      expect(intentInserts()[0][1]).toEqual(['conv-1', 'new-1', 'add', 'me']);
    });

    it('skips the intent when the member already exists (ON CONFLICT no-op)', async () => {
      onQOne([
        [/SELECT role FROM public\.conversation_members/i, () => ({role: 'admin'})],
        [/INSERT INTO public\.conversation_members/i, () => null],
        [/SELECT id, kind, title/i, () => ({id: 'conv-1', kind: 'group', title: null, created_at: 'x', created_by: 'me'})],
      ]);
      await service.addMember('conv-1', 'me', 'already');
      expect(intentInserts()).toHaveLength(0);
    });
  });

  describe('membership intents (drain endpoints)', () => {
    it('lists only pending intents for conversations the caller administers', async () => {
      mockDb.q.mockResolvedValueOnce([{id: 'i1', conversation_id: 'c1', member_user_id: 'u1', action: 'remove', created_at: 'x'}]);
      const out = await service.listMembershipIntents('admin-1');
      expect(out).toHaveLength(1);
      const sql = String(mockDb.q.mock.calls[0][0]);
      expect(sql).toMatch(/m\.role = 'admin'/);
      expect(sql).toMatch(/i\.state = 'pending'/);
      expect(mockDb.q.mock.calls[0][1]).toEqual(['admin-1']);
    });

    it('ack requires the caller to be a conversation admin', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);
      await expect(service.ackMembershipIntent('not-admin', 'i1'))
        .rejects.toBeInstanceOf(NotFoundException);
    });

    it('ack settles the intent', async () => {
      mockDb.qOne.mockResolvedValueOnce({id: 'i1'});
      await expect(service.ackMembershipIntent('admin-1', 'i1')).resolves.toEqual({ok: true});
      const sql = String(mockDb.qOne.mock.calls[0][0]);
      expect(sql).toMatch(/SET state = 'done'/);
    });
  });
});
