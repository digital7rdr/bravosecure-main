/**
 * Scope v2 Phase 4 — "personal files and company files, never mixed", and
 * "company files inherit the channel's permissions".
 *
 * The reviewer's warning when Phase 3 closed:
 *
 *   "Phase 4's core rule has exactly the same geometry as 'pending means
 *    blank': it will be tempting to pin it by scanning the vault service for an
 *    `org_id` filter. That will pass the moment a second read path exists that
 *    resolves files without one. Enumerate every path that returns a file
 *    reference, and assert the scope at each decision site."
 *
 * So these are BEHAVIOURAL tests against the derivation itself, plus source
 * scans for the two absences a behavioural test cannot see (no path from the
 * raw message map; the two shelves never merged).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {listCompanyFiles, type CompanyShelfInput} from '../vault/companyShelf';
import type {LocalMessage} from '../store/types';

function att(over: Partial<LocalMessage> = {}): LocalMessage {
  return {
    id: 'm1', conversation_id: 'c1', sender_id: 'u2', content: '',
    is_encrypted: true, created_at: '2026-08-01T10:00:00.000Z',
    media_object_key: 'obj-1', media_key: 'k1', media_iv: 'iv1',
    media_mime: 'image/jpeg', media_meta: {name: 'plan.jpg', sizeBytes: 1234},
    ...over,
  } as unknown as LocalMessage;
}

const base: CompanyShelfInput = {
  channels: [{id: 'ch-1', name: 'Operations', group_conversation_id: 'conv-1'}],
  deptGroupByChannel: {},
  messages: {'conv-1': [att()]},
};

describe('the company shelf shows only files the member is entitled to', () => {
  it('lists an attachment from a channel the user is a member of', () => {
    const files = listCompanyFiles(base);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      objectKey: 'obj-1', name: 'plan.jpg', channelName: 'Operations', size: 1234,
    });
  });

  /**
   * THE SCOPE RULE. `messages` holds every conversation on the device,
   * including 1:1 chats and channels of other orgs that may still be resident
   * after a membership change. Only the channels the SERVER returned may
   * contribute.
   */
  it('ignores a conversation that is not in the caller\'s channel list', () => {
    const files = listCompanyFiles({
      ...base,
      messages: {
        'conv-1': [att()],
        // A department conversation the user is no longer a member of, still on
        // the device. Walking `messages` instead of the channel list would
        // surface it.
        'conv-other-org': [att({id: 'm9', media_object_key: 'obj-secret'})],
        // ...and an ordinary 1:1 chat.
        'conv-dm': [att({id: 'm8', media_object_key: 'obj-dm'})],
      },
    });
    expect(files.map(f => f.objectKey)).toEqual(['obj-1']);
  });

  it('a revoked membership removes its files, with no other change', () => {
    // The channel list is the server's membership answer. Losing the channel
    // must lose the files — no local cache keeps them visible.
    const files = listCompanyFiles({...base, channels: []});
    expect(files).toEqual([]);
  });

  it('resolves the conversation via deptGroupByChannel when the DTO omits it', () => {
    const files = listCompanyFiles({
      channels: [{id: 'ch-1', name: 'Operations'}],
      deptGroupByChannel: {'ch-1': 'conv-1'},
      messages: {'conv-1': [att()]},
    });
    expect(files.map(f => f.objectKey)).toEqual(['obj-1']);
  });

  it('a channel with no conversation yet contributes nothing, and does not throw', () => {
    expect(listCompanyFiles({
      channels: [{id: 'ch-unprovisioned', name: 'New'}],
      deptGroupByChannel: {},
      messages: {},
    })).toEqual([]);
  });

  /**
   * A row missing any of key / iv / object key is ciphertext nobody can open.
   * Listing it would put a permanently-broken file in front of the user.
   */
  it.each([
    ['no object key', {media_object_key: undefined}],
    ['no AES key', {media_key: undefined}],
    ['no IV', {media_iv: undefined}],
  ])('skips an attachment with %s', (_label, over) => {
    expect(listCompanyFiles({
      ...base, messages: {'conv-1': [att(over as Partial<LocalMessage>)]},
    })).toEqual([]);
  });

  it('skips plain text messages', () => {
    expect(listCompanyFiles({
      ...base,
      messages: {'conv-1': [att({
        media_object_key: undefined, media_key: undefined, media_iv: undefined,
        content: 'just a message',
      })]},
    })).toEqual([]);
  });

  it('deduplicates one file re-shared into two channels', () => {
    const files = listCompanyFiles({
      channels: [
        {id: 'ch-1', name: 'Operations', group_conversation_id: 'conv-1'},
        {id: 'ch-2', name: 'Board', group_conversation_id: 'conv-2'},
      ],
      deptGroupByChannel: {},
      messages: {
        'conv-1': [att()],
        'conv-2': [att({id: 'm2'})],   // same object key
      },
    });
    expect(files).toHaveLength(1);
  });

  it('orders newest first, so the list matches what the user just posted', () => {
    const files = listCompanyFiles({
      ...base,
      messages: {'conv-1': [
        att({id: 'old', media_object_key: 'o-old', created_at: '2026-01-01T00:00:00.000Z'}),
        att({id: 'new', media_object_key: 'o-new', created_at: '2026-08-02T00:00:00.000Z'}),
      ]},
    });
    expect(files.map(f => f.objectKey)).toEqual(['o-new', 'o-old']);
  });

  it('falls back to an honest name rather than exposing the object key', () => {
    const files = listCompanyFiles({
      ...base, messages: {'conv-1': [att({media_meta: undefined})]},
    });
    expect(files[0].name).toBe('Attachment.jpeg');
    expect(files[0].name).not.toContain('obj-1');
  });
});

describe('the two shelves can never be merged', () => {
  const src = readFileSync(
    join(process.cwd(), 'src', 'modules', 'messenger', 'vault', 'companyShelf.ts'), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

  it('the company shelf never reads the personal vault store', () => {
    // If it imported the vault store it could concatenate the two lists, and
    // "never mixed" would depend on a caller remembering not to.
    expect(src).not.toMatch(/useVaultStore|vaultStore|VaultFile/);
  });

  it('the derivation iterates the CHANNEL LIST, never the raw message map', () => {
    // The decision site, not a token. Iterating `messages` would produce the
    // same rows today and widen silently the moment a non-member conversation
    // looked departmental.
    expect(src).toMatch(/for \(const ch of input\.channels/);
    // No path may start from the message map or the conversation map.
    expect(src).not.toMatch(/for\s*\(\s*const\s+\w+\s+of\s+Object\.(keys|values|entries)\(input\.messages/);
    expect(src).not.toMatch(/input\.conversations/);
  });

  it('a CompanyFile carries the provenance the refusal needs', () => {
    // NOTE the name change. This used to claim "a CompanyFile is not
    // structurally a VaultFile" — it IS assignable (it has every required
    // VaultFile property), so merging the arrays would compile and the test
    // only ever grepped for two field names. The real guarantees are the
    // disjoint inputs above and the `moveBytesToVault` choke point; what this
    // shape must actually provide is provenance.
    expect(src).toMatch(/channelId: string;/);
    expect(src).toMatch(/channelName: string;/);
    // conversationId is what the vault refusal is keyed on — without it the
    // company shelf's own viewer would fall back to `null` and be allowed.
    expect(src).toMatch(/conversationId: string;/);
  });

  it('the docblock does not re-assert the type-safety overclaim', () => {
    // The claim "there is no merged list to get the filter wrong on" was false
    // in two ways (Forward makes a legitimate personal copy; the types are
    // assignable). Keeping it out is part of the audit-S1 no-overclaim rule.
    expect(src).not.toMatch(/no merged list to get the filter wrong/);
  });
});
