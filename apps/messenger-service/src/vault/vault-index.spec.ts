/**
 * B-696 Phase D — vault index blob endpoints (VAULT_DURABILITY_DESIGN §6).
 *
 * sqa.md bug register — this suite pins: B-696 (index-blob half): the
 * stale_seq 409 + currentSeq contract (the client's adopt-once depends on
 * it), owner scoping via claims.sub only, the size cap, the pre-migration
 * 503/null degradation, and the bytea round-trip.
 */
import {ConfigService} from '@nestjs/config';
import {HttpException} from '@nestjs/common';
import {VaultIndexService} from './vault-index.service';

const cfg = new ConfigService({
  backup: {supabaseUrl: 'https://example.supabase.co', supabaseServiceRoleKey: 'service-role'},
});

type Chain = {
  select: jest.Mock; eq: jest.Mock; maybeSingle: jest.Mock; upsert: jest.Mock;
};

function makeClient(read: {data?: unknown; error?: {message: string} | null}, writeError: {message: string} | null = null) {
  const chain: Chain = {
    select:      jest.fn(),
    eq:          jest.fn(),
    maybeSingle: jest.fn(),
    upsert:      jest.fn(),
  };
  chain.select.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  chain.maybeSingle.mockResolvedValue({data: read.data ?? null, error: read.error ?? null});
  chain.upsert.mockResolvedValue({error: writeError});
  const from = jest.fn(() => chain);
  return {client: {from} as unknown, from, chain};
}

function svcWith(client: unknown): VaultIndexService {
  const svc = new VaultIndexService(cfg);
  (svc as unknown as {client: unknown}).client = client;
  return svc;
}

const BLOB = Buffer.from('vault-index-ciphertext').toString('base64');

describe('VaultIndexService.put', () => {
  it('writes the blob as a bytea hex literal under the CALLER id, at the claimed seq', async () => {
    const {client, from, chain} = makeClient({data: null});
    const out = await svcWith(client).put('user-1', {blob: BLOB, seq: 1});
    expect(out).toEqual({ok: true, seq: 1});
    expect(from).toHaveBeenCalledWith('vault_index_blobs');
    const row = chain.upsert.mock.calls[0][0] as {user_id: string; blob: string; seq: number};
    expect(row.user_id).toBe('user-1');
    expect(row.seq).toBe(1);
    expect(row.blob).toBe('\\x' + Buffer.from(BLOB, 'base64').toString('hex'));
    expect(chain.upsert.mock.calls[0][1]).toEqual({onConflict: 'user_id'});
  });

  it('409 stale_seq WITH currentSeq when the stored seq is >= the claimed one', async () => {
    const {client} = makeClient({data: {seq: 7}});
    try {
      await svcWith(client).put('user-1', {blob: BLOB, seq: 7});
      throw new Error('should have thrown');
    } catch (e) {
      const he = e as HttpException;
      expect(he.getStatus()).toBe(409);
      expect(he.getResponse()).toEqual({error: 'stale_seq', currentSeq: 7});
    }
  });

  it('accepts a strictly newer seq over an existing row', async () => {
    const {client, chain} = makeClient({data: {seq: 7}});
    const out = await svcWith(client).put('user-1', {blob: BLOB, seq: 8});
    expect(out).toEqual({ok: true, seq: 8});
    expect(chain.upsert).toHaveBeenCalled();
  });

  it('refuses an empty blob and a negative seq', async () => {
    const {client} = makeClient({data: null});
    await expect(svcWith(client).put('user-1', {blob: '', seq: 1})).rejects.toThrow('invalid_blob');
    await expect(svcWith(client).put('user-1', {blob: BLOB, seq: -1})).rejects.toThrow('invalid_seq');
  });

  it('413 over the size cap', async () => {
    const {client} = makeClient({data: null});
    const huge = 'A'.repeat(VaultIndexService.MAX_BLOB_B64 + 4);
    try {
      await svcWith(client).put('user-1', {blob: huge, seq: 1});
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as HttpException).getStatus()).toBe(413);
    }
  });

  it('503 vault_index_disabled when the table is missing (pre-migration deploy)', async () => {
    const {client} = makeClient({error: {message: 'relation "public.vault_index_blobs" does not exist'}});
    try {
      await svcWith(client).put('user-1', {blob: BLOB, seq: 1});
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as HttpException).getStatus()).toBe(503);
    }
  });

  it('503 when the service has no Supabase config at all', async () => {
    const bare = new VaultIndexService(new ConfigService({backup: {}}));
    await expect(bare.put('user-1', {blob: BLOB, seq: 1})).rejects.toThrow('vault_index_disabled');
  });
});

describe('VaultIndexService.get', () => {
  it('round-trips the bytea hex form back to the uploaded base64', async () => {
    const hex = '\\x' + Buffer.from(BLOB, 'base64').toString('hex');
    const {client} = makeClient({data: {blob: hex, seq: 3}});
    expect(await svcWith(client).get('user-1')).toEqual({blob: BLOB, seq: 3});
  });

  it('null when nothing was ever uploaded, and on a pre-migration deploy', async () => {
    const {client} = makeClient({data: null});
    expect(await svcWith(client).get('user-1')).toBeNull();
    const missing = makeClient({error: {message: 'relation "public.vault_index_blobs" does not exist'}});
    expect(await svcWith(missing.client).get('user-1')).toBeNull();
  });
});
