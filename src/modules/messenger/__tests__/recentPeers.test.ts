/**
 * BS-RECENTS — recentDirectPeers: existing 1:1 chat peers become picker rows.
 *
 * The bug this feature closes: a peer reached via "Message by Number" is not
 * in the address book, so the Add-to-group / New-chat picker (whose only
 * source was contact discovery) could never list them.
 */
import {recentDirectPeers, type RecentPeerConversationLike} from '../contacts/recentPeers';

const direct = (
  uid: string,
  over: Partial<RecentPeerConversationLike> = {},
): RecentPeerConversationLike => ({
  type: 'direct',
  name: `Peer ${uid}`,
  peer: {userId: uid, deviceId: 1},
  created_at: '2026-07-01T00:00:00.000Z',
  ...over,
});

describe('recentDirectPeers', () => {
  it('lists a direct-chat peer who is NOT in contact discovery (the Ari2 case)', () => {
    const rows = recentDirectPeers({c1: direct('ari2', {name: 'Ari2'})}, []);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({userId: 'ari2', localName: 'Ari2', avatarUrl: null});
  });

  it('excludes peers another section already lists, and self', () => {
    const rows = recentDirectPeers(
      {a: direct('in-contacts'), b: direct('me'), c: direct('fresh')},
      ['in-contacts', 'me'],
    );
    expect(rows.map(r => r.userId)).toEqual(['fresh']);
  });

  it('ignores groups, rows without a peer, and undefined rows', () => {
    const rows = recentDirectPeers({
      g: {type: 'group', name: 'Kotiss'},
      p: {type: 'direct', name: 'No peer yet'},
      u: undefined,
      ok: direct('ok'),
    }, []);
    expect(rows.map(r => r.userId)).toEqual(['ok']);
  });

  it('dedups the BS-NC1 split-brain (synthetic + canonical row, same peer) to one row', () => {
    const rows = recentDirectPeers({
      'direct:x': direct('x', {name: undefined, created_at: '2026-07-02T00:00:00.000Z'}),
      'uuid-row': direct('x', {name: 'Named X', created_at: '2026-07-02T00:00:00.000Z'}),
    }, []);
    expect(rows).toHaveLength(1);
    expect(rows[0].localName).toBe('Named X');
  });

  it('sorts newest activity first, preferring last_message over created_at', () => {
    const rows = recentDirectPeers({
      old:  direct('old',  {created_at: '2026-07-01T00:00:00.000Z'}),
      hot:  direct('hot',  {created_at: '2026-06-01T00:00:00.000Z',
                            last_message: {created_at: '2026-07-28T00:00:00.000Z'}}),
      mid:  direct('mid',  {created_at: '2026-07-10T00:00:00.000Z'}),
    }, []);
    expect(rows.map(r => r.userId)).toEqual(['hot', 'mid', 'old']);
  });

  it('falls back name → phone → "Bravo contact" and always carries a string phoneE164', () => {
    const rows = recentDirectPeers({
      a: direct('a', {name: undefined, phoneE164: '+8801700000001'}),
      b: direct('b', {name: undefined, phoneE164: undefined}),
    }, []);
    const byId = Object.fromEntries(rows.map(r => [r.userId, r]));
    expect(byId.a.localName).toBe('+8801700000001');
    expect(byId.b.localName).toBe('Bravo contact');
    expect(byId.b.phoneE164).toBe('');
  });
});
