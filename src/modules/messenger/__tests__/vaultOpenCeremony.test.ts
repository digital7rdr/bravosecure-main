/**
 * `vaultOps` — the ceremony around every vault byte, executed.
 *
 * `openVaultFileUri` had NEVER been run by a test (vaultOps lines 200-233 were
 * 0% covered), and neither had any failure arm of `moveBytesToVault` except the
 * company-file refusal. That is the wrong half to leave uncovered: the failure
 * arms ARE the gate.
 *
 * SECURITY — CLAUDE.md stop condition "File vault MFA gate or any download URL
 * issuance flow". The contract this file pins, taken from vaultOps' own header:
 *
 *   - The action token is the real gate. If it cannot be minted the operation
 *     FAILS CLOSED with an honest message and NOTHING moves — never a fake row
 *     (audit M-02/S1), never a download attempted anyway.
 *   - Every open is its OWN ceremony; proofs are single-use server-side, so
 *     there is nothing to cache and a second open must mint a second proof.
 *   - Missing biometric hardware is a fall-through to the server gate, NOT a
 *     bypass of it — the proof is still required and still carried.
 *   - A user CANCEL aborts before anything is minted or fetched.
 *
 * Every assertion is written so that weakening the gate turns it RED; none of
 * them can be satisfied by making the gate more permissive.
 */

const mockBio = {
  hasHardware:  jest.fn(async () => true),
  isEnrolled:   jest.fn(async () => true),
  authenticate: jest.fn(async (_o: unknown) => ({success: true} as {success: boolean})),
};
const mockMint = jest.fn(async (_purpose: string) => ({actionToken: 'proof-1'} as {actionToken: string} | null));
const mockKeysOpts: Array<{refreshToken?: () => Promise<void>; baseUrl?: string}> = [];
const mockUpload = jest.fn(async (_b: Uint8Array, _m: string, _p: string) =>
  ({objectKey: 'vault/u1/obj', keyB64: 'a2V5', ivB64: 'aXY=', size: 3, mimeType: 'application/pdf'}));
const mockDownload = jest.fn(async (_p: unknown) => new Uint8Array([7, 7, 7]));
const mockClientOpts: Array<{baseUrl: string; signalDeviceId: number}> = [];
const mockWriteTempBytes = jest.fn(async (_b: Uint8Array, _m: string, _hint: string) => 'file:///tmp/out.pdf');
const mockRefreshShared = jest.fn(async () => {});
const mockVaultState = {
  hasPin: jest.fn(() => true),
  addFile: jest.fn(),
  files: [] as unknown[],
};

jest.mock('@utils/constants', () => ({API_BASE_URL: 'https://auth.invalid', MSG_BASE_URL: 'https://msg.invalid'}));
jest.mock('expo-local-authentication', () => ({
  hasHardwareAsync:  () => mockBio.hasHardware(),
  isEnrolledAsync:   () => mockBio.isEnrolled(),
  authenticateAsync: (o: unknown) => mockBio.authenticate(o),
}));
jest.mock('@react-native-async-storage/async-storage', () => ({getItem: jest.fn(async () => 'jwt')}));
jest.mock('@/services/api', () => ({refreshAccessTokenShared: () => mockRefreshShared()}));
jest.mock('../transport/keysClient', () => ({
  KeysHttpClient: class {
    constructor(opts: {baseUrl?: string}) { mockKeysOpts.push(opts); }
    mintActionToken(purpose: string) { return mockMint(purpose); }
  },
}));
jest.mock('../vault/vaultClient', () => ({
  VaultClient: class {
    constructor(opts: {baseUrl: string; signalDeviceId: number}) { mockClientOpts.push(opts); }
    uploadEncrypted(b: Uint8Array, m: string, p: string) { return mockUpload(b, m, p); }
    downloadAndDecrypt(p: unknown) { return mockDownload(p); }
  },
}));
jest.mock('../vault/vaultStore', () => ({
  useVaultStore: {getState: () => mockVaultState},
}));
jest.mock('../store/messengerStore', () => ({
  useMessengerStore: {getState: () => ({deptGroupByChannel: {}, deptConversationIds: {}})},
}));
jest.mock('../media/mediaFiles', () => ({
  writeTempBytes: (b: Uint8Array, m: string, h: string) => mockWriteTempBytes(b, m, h),
}));

import {moveBytesToVault, openVaultFileUri, findVaultRow, __resetVaultCeremonyForTests} from '../vault/vaultOps';
import type {VaultFile} from '../vault/vaultStore';

const row = (over: Partial<VaultFile> = {}): VaultFile => ({
  objectKey: 'vault/u1/obj',
  sourceKey: 'msg:m1',
  keyB64:    'a2V5LWJ5dGVz',
  ivB64:     'aXYtYnl0ZXM=',
  name:      'orders.pdf',
  size:      12,
  mimeType:  'application/pdf',
  createdAt: 1_752_600_000_000,
  ...over,
});

const moveArgs = {
  sourceKey: 'msg:m1',
  name: 'orders.pdf',
  mimeType: 'application/pdf',
  bytes: new Uint8Array([1, 2, 3]),
  conversationId: null as string | null,
};

beforeEach(() => {
  jest.clearAllMocks();
  // B-700 — the presence window is module state; every test starts cold.
  __resetVaultCeremonyForTests();
  mockKeysOpts.length = 0;
  mockClientOpts.length = 0;
  mockBio.hasHardware.mockResolvedValue(true);
  mockBio.isEnrolled.mockResolvedValue(true);
  mockBio.authenticate.mockResolvedValue({success: true});
  mockMint.mockResolvedValue({actionToken: 'proof-1'});
  mockVaultState.hasPin.mockReturnValue(true);
  mockUpload.mockResolvedValue({objectKey: 'vault/u1/obj', keyB64: 'a2V5', ivB64: 'aXY=', size: 3, mimeType: 'application/pdf'});
  mockDownload.mockResolvedValue(new Uint8Array([7, 7, 7]));
});

describe('openVaultFileUri — the MFA ceremony cannot be skipped', () => {
  it('mints a purpose-gated proof and hands exactly it to the download', async () => {
    mockMint.mockResolvedValue({actionToken: 'proof-open'});
    const res = await openVaultFileUri(row());

    expect(mockMint).toHaveBeenCalledWith('vault-access');
    expect(mockDownload).toHaveBeenCalledWith({
      objectKey: 'vault/u1/obj',
      keyB64:    'a2V5LWJ5dGVz',
      ivB64:     'aXYtYnl0ZXM=',
      mfaProof:  'proof-open',
    });
    expect(res).toEqual({ok: true, uri: 'file:///tmp/out.pdf'});
  });

  /**
   * THE gate. The server MfaGuard rejects the assert on a build with no real
   * attestation — the documented posture. The op must stop dead here: an
   * unproofed download attempt is the exact bypass this module exists to
   * prevent, and a cheerful `{ok:true}` would be worse than the failure.
   */
  it('a proof that cannot be minted STOPS the open — no download is attempted', async () => {
    mockMint.mockResolvedValue(null);
    const res = await openVaultFileUri(row());

    expect(res).toMatchObject({ok: false, reason: 'mfa_unavailable'});
    expect(mockDownload).not.toHaveBeenCalled();
    expect(mockWriteTempBytes).not.toHaveBeenCalled();
  });

  it('says the vault stayed closed rather than implying the file was opened', async () => {
    mockMint.mockResolvedValue(null);
    const res = await openVaultFileUri(row());
    expect(res.ok).toBe(false);
    if (!res.ok) {expect(res.message).toMatch(/NOT moved|stays closed/i);}
  });

  it('a user CANCEL aborts before any proof is minted or byte fetched', async () => {
    mockBio.authenticate.mockResolvedValue({success: false});
    const res = await openVaultFileUri(row());

    expect(res).toMatchObject({ok: false, reason: 'cancelled'});
    expect(mockMint).not.toHaveBeenCalled();
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('a legacy row with no key material is refused before the ceremony starts', async () => {
    const res = await openVaultFileUri(row({keyB64: ''}));
    expect(res).toMatchObject({ok: false, reason: 'transfer_failed'});
    if (!res.ok) {expect(res.message).toMatch(/legacy/i);}
    // Prompting for biometrics for a row that can never open is pure user abuse.
    expect(mockBio.authenticate).not.toHaveBeenCalled();
    expect(mockMint).not.toHaveBeenCalled();
  });

  it('is refused the same way when only the IV is missing', async () => {
    const res = await openVaultFileUri(row({ivB64: ''}));
    expect(res).toMatchObject({ok: false, reason: 'transfer_failed'});
    expect(mockDownload).not.toHaveBeenCalled();
  });

  /**
   * Proofs are single-use (server replay guard), so nothing may be cached
   * between opens. A client that reused the first proof would 401 on every
   * subsequent open in production while passing any single-open test.
   *
   * RE-POINTED for B-700 (founder 2026-08-29): the LOCAL prompt now has a
   * 5-minute presence window — one fingerprint covers a burst of moves/opens
   * — but the SERVER proof stays strictly per-operation. Caching the proof
   * is still the bug this test exists to catch.
   */
  it('EVERY open mints its OWN proof — but one presence window covers the burst (B-700)', async () => {
    mockMint
      .mockResolvedValueOnce({actionToken: 'proof-A'})
      .mockResolvedValueOnce({actionToken: 'proof-B'});

    await openVaultFileUri(row());
    await openVaultFileUri(row());

    expect(mockMint).toHaveBeenCalledTimes(2);
    // B-700 — the second op rides the first op's presence window.
    expect(mockBio.authenticate).toHaveBeenCalledTimes(1);
    expect(mockDownload.mock.calls.map(c => (c[0] as {mfaProof: string}).mfaProof))
      .toEqual(['proof-A', 'proof-B']);
  });

  it('B-700 — the presence window EXPIRES: 5 minutes later the prompt returns', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(1_700_000_000_000);
      await openVaultFileUri(row());
      expect(mockBio.authenticate).toHaveBeenCalledTimes(1);

      jest.setSystemTime(1_700_000_000_000 + 5 * 60 * 1000 + 1_000);
      await openVaultFileUri(row());
      expect(mockBio.authenticate).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('B-700 — a user CANCEL never arms the window: the next attempt prompts again', async () => {
    mockBio.authenticate.mockResolvedValueOnce({success: false});
    const refused = await openVaultFileUri(row());
    expect(refused).toMatchObject({ok: false, reason: 'cancelled'});

    mockBio.authenticate.mockResolvedValueOnce({success: true});
    const ok = await openVaultFileUri(row());
    expect(ok).toMatchObject({ok: true});
    expect(mockBio.authenticate).toHaveBeenCalledTimes(2);
  });

  it('B-700 — a live VaultLock unlock counts as presence (no double ceremony)', async () => {
    (mockVaultState as {isUnlocked?: () => boolean}).isUnlocked = () => true;
    try {
      await openVaultFileUri(row());
      expect(mockBio.authenticate).not.toHaveBeenCalled();
      expect(mockMint).toHaveBeenCalledWith('vault-access');   // the real gate still runs
    } finally {
      delete (mockVaultState as {isUnlocked?: () => boolean}).isUnlocked;
    }
  });

  /**
   * A device with no biometric hardware / no enrolment falls THROUGH to the
   * server gate — it does not walk around it. Turning this into an early
   * `{ok:true}` would make an unenrolled device the easiest way into the vault.
   */
  it('no biometric hardware still requires — and carries — the action token', async () => {
    mockBio.hasHardware.mockResolvedValue(false);
    const res = await openVaultFileUri(row());

    expect(mockBio.authenticate).not.toHaveBeenCalled();
    expect(mockMint).toHaveBeenCalledWith('vault-access');
    expect((mockDownload.mock.calls[0][0] as {mfaProof: string}).mfaProof).toBe('proof-1');
    expect(res).toMatchObject({ok: true});
  });

  it('an unenrolled device is treated the same way', async () => {
    mockBio.isEnrolled.mockResolvedValue(false);
    await openVaultFileUri(row());
    expect(mockBio.authenticate).not.toHaveBeenCalled();
    expect(mockMint).toHaveBeenCalled();
  });

  /**
   * Prompt INFRASTRUCTURE failure is not a user refusal — the comment says so
   * explicitly. It must not lock a legitimate user out of their own files, and
   * it must not skip the action token either.
   */
  it('a crashing biometric prompt is not read as a refusal, and still mints a proof', async () => {
    mockBio.authenticate.mockRejectedValue(new Error('KeyStore unavailable'));
    const res = await openVaultFileUri(row());
    expect(res).toMatchObject({ok: true});
    expect(mockMint).toHaveBeenCalledWith('vault-access');
  });

  it('writes the plaintext to a temp uri keyed by the object, not the file name', async () => {
    await openVaultFileUri(row({objectKey: 'vault/u1/xyz', mimeType: 'image/png', name: 'holiday.png'}));
    expect(mockWriteTempBytes).toHaveBeenCalledWith(
      new Uint8Array([7, 7, 7]), 'image/png', 'vault-vault/u1/xyz',
    );
  });

  it('surfaces the transfer error message instead of a generic failure', async () => {
    mockDownload.mockRejectedValue(new Error('attachment hmac mismatch (tampered or wrong key)'));
    const res = await openVaultFileUri(row());
    expect(res).toMatchObject({ok: false, reason: 'transfer_failed'});
    if (!res.ok) {expect(res.message).toMatch(/hmac mismatch/);}
  });

  it('falls back to an honest generic message for a non-Error throw', async () => {
    mockDownload.mockRejectedValue('boom');
    const res = await openVaultFileUri(row());
    expect(res).toMatchObject({ok: false, reason: 'transfer_failed', message: 'Vault download failed.'});
  });

  it('talks to the messenger service, as the single-device Phase-1 client', async () => {
    await openVaultFileUri(row());
    expect(mockClientOpts[0]).toMatchObject({baseUrl: 'https://msg.invalid', signalDeviceId: 1});
  });
});

describe('moveBytesToVault — nothing leaves the device until the gate says yes', () => {
  it('refuses without a vault PIN, before prompting or minting anything', async () => {
    mockVaultState.hasPin.mockReturnValue(false);
    const res = await moveBytesToVault({...moveArgs});

    expect(res).toMatchObject({ok: false, reason: 'no_pin'});
    if (!res.ok) {expect(res.message).toMatch(/PIN/i);}
    expect(mockBio.authenticate).not.toHaveBeenCalled();
    expect(mockMint).not.toHaveBeenCalled();
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('a cancelled prompt uploads nothing and indexes nothing', async () => {
    mockBio.authenticate.mockResolvedValue({success: false});
    const res = await moveBytesToVault({...moveArgs});

    expect(res).toMatchObject({ok: false, reason: 'cancelled'});
    expect(mockMint).not.toHaveBeenCalled();
    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockVaultState.addFile).not.toHaveBeenCalled();
  });

  it('an unmintable proof means the BYTES ARE NEVER UPLOADED', async () => {
    mockMint.mockResolvedValue(null);
    const res = await moveBytesToVault({...moveArgs});

    expect(res).toMatchObject({ok: false, reason: 'mfa_unavailable'});
    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockVaultState.addFile).not.toHaveBeenCalled();
  });

  it('threads the proof into the upload rather than uploading unproofed', async () => {
    mockMint.mockResolvedValue({actionToken: 'proof-move'});
    await moveBytesToVault({...moveArgs});
    expect(mockUpload).toHaveBeenCalledWith(moveArgs.bytes, 'application/pdf', 'proof-move');
  });

  /**
   * Audit M-02/S1 — never persist a row without real key material. A row whose
   * key is missing is a pretend-encrypted entry: it looks like a vaulted file in
   * the UI and can never be opened again.
   */
  it.each([
    ['key', {keyB64: ''}],
    ['iv', {ivB64: ''}],
    ['object key', {objectKey: ''}],
  ])('an upload that returns no %s indexes NOTHING', async (_label, missing) => {
    mockUpload.mockResolvedValue({
      objectKey: 'vault/u1/obj', keyB64: 'a2V5', ivB64: 'aXY=', size: 3, mimeType: 'application/pdf',
      ...missing,
    });
    const res = await moveBytesToVault({...moveArgs});

    expect(res).toMatchObject({ok: false, reason: 'transfer_failed'});
    if (!res.ok) {expect(res.message).toMatch(/no key material|nothing was saved/i);}
    expect(mockVaultState.addFile).not.toHaveBeenCalled();
  });

  it('a thrown upload is reported honestly and indexes nothing', async () => {
    mockUpload.mockRejectedValue(new Error('upload failed'));
    const res = await moveBytesToVault({...moveArgs});
    expect(res).toMatchObject({ok: false, reason: 'transfer_failed', message: 'upload failed'});
    expect(mockVaultState.addFile).not.toHaveBeenCalled();
  });

  it('a non-Error throw still fails closed with a generic message', async () => {
    mockUpload.mockRejectedValue({weird: true});
    const res = await moveBytesToVault({...moveArgs});
    expect(res).toMatchObject({ok: false, reason: 'transfer_failed', message: 'Vault upload failed.'});
    expect(mockVaultState.addFile).not.toHaveBeenCalled();
  });

  it('indexes the SERVER key material and object key on success, not the source handle', async () => {
    mockUpload.mockResolvedValue({objectKey: 'vault/u1/real', keyB64: 'REALKEY', ivB64: 'REALIV', size: 4096, mimeType: 'application/pdf'});
    const res = await moveBytesToVault({...moveArgs, name: 'rota.pdf', sourceKey: 'msg:m9'});

    // B-592 — the objectKey is returned so the viewer can offer "which album?"
    // for the row it just created without re-deriving it from the store.
    expect(res).toEqual({ok: true, objectKey: 'vault/u1/real'});
    expect(mockVaultState.addFile).toHaveBeenCalledWith({
      objectKey: 'vault/u1/real',
      sourceKey: 'msg:m9',
      keyB64:    'REALKEY',
      ivB64:     'REALIV',
      name:      'rota.pdf',
      size:      4096,
      mimeType:  'application/pdf',
      createdAt: expect.any(Number),
    });
  });

  it('mints the vault-access purpose against the AUTH service, not the relay', async () => {
    await moveBytesToVault({...moveArgs});
    expect(mockMint).toHaveBeenCalledWith('vault-access');
    expect(mockKeysOpts[0]).toMatchObject({baseUrl: 'https://auth.invalid'});
  });

  /**
   * The proof mint runs on an access token that may have expired while the user
   * was picking a file, so the keys client is handed the SHARED refresher. A
   * client wired without it turns every expired-token move into a permanent
   * "MFA unavailable" the user cannot clear except by restarting the app.
   */
  it('wires the shared token refresher into the proof mint', async () => {
    await moveBytesToVault({...moveArgs});
    const refresh = mockKeysOpts[0]?.refreshToken;
    expect(typeof refresh).toBe('function');
    await refresh!();
    expect(mockRefreshShared).toHaveBeenCalled();
  });
});

describe('findVaultRow — a file is recognised by either handle', () => {
  const files = [row({objectKey: 'vault/u1/a', sourceKey: 'msg:m1'}), row({objectKey: 'msg:m2', sourceKey: undefined})];

  it('matches a modern row by its source handle', () => {
    expect(findVaultRow(files, 'msg:m1')?.objectKey).toBe('vault/u1/a');
  });

  it('matches a legacy row that used the message handle AS the object key', () => {
    expect(findVaultRow(files, 'msg:m2')?.objectKey).toBe('msg:m2');
  });

  it('matches a modern row by its server object key too', () => {
    expect(findVaultRow(files, 'vault/u1/a')?.sourceKey).toBe('msg:m1');
  });

  it('returns null rather than undefined for an unknown handle', () => {
    expect(findVaultRow(files, 'msg:nope')).toBeNull();
    expect(findVaultRow([], 'msg:m1')).toBeNull();
  });
});
