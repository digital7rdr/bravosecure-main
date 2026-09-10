import {Test, TestingModule} from '@nestjs/testing';
import {NotFoundException} from '@nestjs/common';
import {KeysService} from './keys.service';
import {DatabaseService} from '../database/database.service';
import {AuditService} from '../kafka/audit.service';
import {ConfigService} from '@nestjs/config';

const mockDb = {q: jest.fn(), qOne: jest.fn()};
const mockAudit = {emit: jest.fn()};
const mockConfig = {get: jest.fn().mockReturnValue('')}; // no authority key → skip binding sign

const BASE_IDENTITY = {
  registration_id: 1,
  identity_key: Buffer.from('ik'),
  signed_prekey_id: 1,
  signed_prekey: Buffer.from('spk'),
  signed_prekey_sig: Buffer.from('sig'),
};

describe('KeysService (per-device, B-18)', () => {
  let service: KeysService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockAudit.emit.mockResolvedValue(undefined);
    mockDb.q.mockResolvedValue([{cnt: '5'}]);
    mockDb.qOne.mockResolvedValue(null); // resolveSignalDeviceId → 1; prev identity → none
    mockConfig.get.mockReturnValue('');
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KeysService,
        {provide: DatabaseService, useValue: mockDb},
        {provide: AuditService, useValue: mockAudit},
        {provide: ConfigService, useValue: mockConfig},
      ],
    }).compile();
    service = module.get(KeysService);
  });

  const baseDto = {
    registrationId: 1,
    identityKey: Buffer.alloc(32).toString('base64'),
    signedPrekeyId: 1,
    signedPrekey: Buffer.alloc(32).toString('base64'),
    signedPrekeySig: Buffer.alloc(64).toString('base64'),
    oneTimePrekeys: [{keyId: 1, publicKey: Buffer.alloc(32).toString('base64')}],
  };

  describe('upload', () => {
    it('stores identity + OPKs and returns poolSize (defaults to signal device 1)', async () => {
      mockDb.q
        .mockResolvedValueOnce([])            // INSERT identity (upsert)
        .mockResolvedValueOnce([{cnt: '5'}])  // pool count (pre-cap)
        .mockResolvedValueOnce([])            // INSERT OPK
        .mockResolvedValueOnce([{cnt: '6'}]); // pool count (post)
      const result = await service.upload(baseDto as never, 'user-1', 'dev-1', '1.1.1.1');
      expect(result.oneTimeKeysStored).toBe(1);
      expect(result.poolSize).toBe(6);
      // Identity upsert binds the resolved signal device id (default 1) as the last param.
      const idInsert = mockDb.q.mock.calls.find(c => /INSERT INTO public\.signal_identities/i.test(String(c[0])));
      expect((idInsert![1] as unknown[])[6]).toBe(1);
    });

    it('uses per-device ON CONFLICT targets matching the table PKs', async () => {
      mockDb.q
        .mockResolvedValueOnce([]).mockResolvedValueOnce([{cnt: '0'}])
        .mockResolvedValueOnce([]).mockResolvedValueOnce([{cnt: '1'}]);
      await service.upload(baseDto as never, 'u1', 'd1', '1.1.1.1');
      const idInsert = mockDb.q.mock.calls.find(c => /INSERT INTO public\.signal_identities/i.test(String(c[0])));
      const opkInsert = mockDb.q.mock.calls.find(c => /INSERT INTO public\.signal_one_time_prekeys/i.test(String(c[0])));
      expect(String(idInsert![0])).toMatch(/ON CONFLICT \(user_id,device_id\)/);
      expect(String(opkInsert![0])).toMatch(/ON CONFLICT \(user_id,device_id,key_id\)/);
    });

    it('emits audit success on upload', async () => {
      mockDb.q
        .mockResolvedValueOnce([]).mockResolvedValueOnce([{cnt: '5'}])
        .mockResolvedValueOnce([]).mockResolvedValueOnce([{cnt: '6'}]);
      await service.upload(baseDto as never, 'u1', 'd1', '1.1.1.1');
      expect(mockAudit.emit).toHaveBeenCalledWith(
        expect.objectContaining({event_type: 'auth.keys.upload', outcome: 'success'}),
      );
    });

    it('wipes ONLY this device’s OPK pool on identity rotation', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({signal_device_id: 1})               // resolveSignalDeviceId
        .mockResolvedValueOnce({identity_key: Buffer.from('OLD')}); // prev identity (rotation)
      mockDb.q
        .mockResolvedValueOnce([])            // INSERT identity
        .mockResolvedValueOnce([])            // DELETE orphan OPKs
        .mockResolvedValueOnce([{cnt: '0'}])  // pool pre-cap
        .mockResolvedValueOnce([])            // INSERT OPK
        .mockResolvedValueOnce([{cnt: '1'}]); // pool post
      await service.upload(baseDto as never, 'u1', 'd1', '1.1.1.1');
      const del = mockDb.q.mock.calls.find(c => /DELETE FROM public\.signal_one_time_prekeys/i.test(String(c[0])));
      expect(del).toBeDefined();
      expect(del![1]).toEqual(['u1', 1]); // scoped to (user, device), not user-wide
    });

    it('hard-rejects a wrong-length identity key', async () => {
      const dto = {...baseDto, identityKey: Buffer.alloc(33).toString('base64')}; // 33 bytes, not 0x05-prefixed
      await expect(service.upload(dto as never, 'u1', 'd1', '1.1.1.1')).rejects.toThrow(/identity_key_wrong_length/);
    });

    // Handoff §4.5-1 — the client can't detect its own rotation (a fresh
    // install has no copy of the old identity), so the upload response
    // must carry the server's verdict + the superseded PUBLIC key the
    // relay purge endpoint needs.
    it('returns identityRotated + previousIdentityKey when the identity changed', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({signal_device_id: 1})               // resolveSignalDeviceId
        .mockResolvedValueOnce({identity_key: Buffer.from('OLD')}); // prev identity differs
      mockDb.q
        .mockResolvedValueOnce([])            // INSERT identity
        .mockResolvedValueOnce([])            // DELETE orphan OPKs
        .mockResolvedValueOnce([{cnt: '0'}])  // pool pre-cap
        .mockResolvedValueOnce([])            // INSERT OPK
        .mockResolvedValueOnce([{cnt: '1'}]); // pool post
      const res = await service.upload(baseDto as never, 'u1', 'd1', '1.1.1.1');
      expect(res.identityRotated).toBe(true);
      expect(res.previousIdentityKey).toBe(Buffer.from('OLD').toString('base64'));
    });

    // Audit Rev2 CLI-01 — an identity rotation is the silent-takeover
    // amplification for a stolen access token; it must emit a DISTINCT audit
    // event so it is detectable, not buried in a generic upload success.
    it('emits a distinct auth.keys.identity_rotated audit event on rotation', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({signal_device_id: 1})
        .mockResolvedValueOnce({identity_key: Buffer.from('OLD')}); // rotation
      mockDb.q
        .mockResolvedValueOnce([]).mockResolvedValueOnce([])
        .mockResolvedValueOnce([{cnt: '0'}]).mockResolvedValueOnce([])
        .mockResolvedValueOnce([{cnt: '1'}]);
      await service.upload(baseDto as never, 'u1', 'd1', '1.1.1.1');
      expect(mockAudit.emit).toHaveBeenCalledWith(
        expect.objectContaining({event_type: 'auth.keys.identity_rotated', outcome: 'success'}),
      );
    });

    it('does NOT emit the rotation event on a first upload', async () => {
      mockDb.q
        .mockResolvedValueOnce([]).mockResolvedValueOnce([{cnt: '5'}])
        .mockResolvedValueOnce([]).mockResolvedValueOnce([{cnt: '6'}]);
      await service.upload(baseDto as never, 'u1', 'd1', '1.1.1.1');
      expect(mockAudit.emit).not.toHaveBeenCalledWith(
        expect.objectContaining({event_type: 'auth.keys.identity_rotated'}),
      );
    });

    it('returns identityRotated=false and NO previousIdentityKey on first upload', async () => {
      mockDb.q
        .mockResolvedValueOnce([]).mockResolvedValueOnce([{cnt: '5'}])
        .mockResolvedValueOnce([]).mockResolvedValueOnce([{cnt: '6'}]);
      const res = await service.upload(baseDto as never, 'u1', 'd1', '1.1.1.1');
      expect(res.identityRotated).toBe(false);
      expect(res.previousIdentityKey).toBeUndefined();
    });

    it('returns identityRotated=false when the same identity is re-uploaded (restore path)', async () => {
      const sameKey = Buffer.from(baseDto.identityKey, 'base64');
      mockDb.qOne
        .mockResolvedValueOnce({signal_device_id: 1})     // resolveSignalDeviceId
        .mockResolvedValueOnce({identity_key: sameKey});  // prev identity IDENTICAL
      mockDb.q
        .mockResolvedValueOnce([]).mockResolvedValueOnce([{cnt: '5'}])
        .mockResolvedValueOnce([]).mockResolvedValueOnce([{cnt: '6'}]);
      const res = await service.upload(baseDto as never, 'u1', 'd1', '1.1.1.1');
      expect(res.identityRotated).toBe(false);
      expect(res.previousIdentityKey).toBeUndefined();
    });
  });

  describe('fetchBundle', () => {
    it('throws NotFound when the target has no device/keys', async () => {
      mockDb.qOne.mockResolvedValueOnce(null); // no primary device row
      await expect(service.fetchBundle('t', 'r', 'd', '1.1.1.1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns the primary device bundle with base64 keys + pops one OPK', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({device_id: 1})                              // primary device
        .mockResolvedValueOnce(BASE_IDENTITY)                               // identity for (user, dev)
        .mockResolvedValueOnce({key_id: 1, public_key: Buffer.from('opk')}); // OPK delete RETURNING
      mockDb.q.mockResolvedValueOnce([{cnt: '4'}]);                          // remaining pool
      const {bundle} = await service.fetchBundle('t', 'r', 'd', '1.1.1.1');
      expect(bundle.identityKey).toBe(Buffer.from('ik').toString('base64'));
      expect(bundle.oneTimePrekey).not.toBeNull();
      const del = mockDb.qOne.mock.calls.find(c => /DELETE FROM\s+public\.signal_one_time_prekeys/i.test(String(c[0])));
      expect(del).toBeDefined(); // single-use OPK consumption
      // Concurrency hardening — the OPK pop must lock+skip so two simultaneous
      // fetchers each claim a DISTINCT prekey instead of one degrading to
      // signed-prekey-only. Assert the SKIP LOCKED clause is present.
      expect(String(del?.[0])).toMatch(/FOR UPDATE SKIP LOCKED/i);
    });

    it('resolves the primary device by NEWEST identity (updated_at DESC), not oldest device id', async () => {
      // Regression: a single-device user that reinstalls gets a NEW higher
      // signal device id with a fresh identity, orphaning the old device-id
      // rows. Selecting the lowest device id returned a stale identity key,
      // so peers' outer-ECIES wrap bound the wrong recipient key → live
      // install hit "outer sealed authentication failed" and dropped every
      // sealed envelope (group-call keys included). The bundle endpoint must
      // return the CURRENT (most-recently-updated) device's identity.
      mockDb.qOne
        .mockResolvedValueOnce({device_id: 3})                               // primary device (newest)
        .mockResolvedValueOnce(BASE_IDENTITY)
        .mockResolvedValueOnce({key_id: 1, public_key: Buffer.from('opk')});
      mockDb.q.mockResolvedValueOnce([{cnt: '4'}]);
      await service.fetchBundle('t', 'r', 'd', '1.1.1.1');
      const primaryQuery = String(mockDb.qOne.mock.calls[0][0]);
      expect(primaryQuery).toMatch(/ORDER BY\s+updated_at\s+DESC/i);
      expect(primaryQuery).not.toMatch(/ORDER BY\s+device_id\s+ASC/i);
    });
  });
});
