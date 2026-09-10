/**
 * B-696 Phase D — the E2E vault index blob sync (VAULT_DURABILITY_DESIGN §6).
 *
 * sqa.md bug register — this suite pins: B-696 (files-survive-reinstall half):
 * the HKDF('bravo-vault-index-v1') + AAD('vault-index', userId) crypto
 * contract against a REAL AES-GCM round trip, the 409 stale_seq adopt-ONCE
 * rule (I6 — never hammer), the lane being hard-OFF without a mirror key,
 * removal non-resurrection on merge, the M-02 keyless-row refusal, and the
 * no-plaintext-in-logs rule.
 */

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem:    async (k: string) => store.get(k) ?? null,
      setItem:    async (k: string, v: string) => { store.set(k, v); },
      removeItem: async (k: string) => { store.delete(k); },
      clear:      async () => { store.clear(); },
    },
  };
});

jest.mock('react-native-quick-crypto', () => {
  const nodeCrypto = jest.requireActual('node:crypto');
  return {
    __esModule: true,
    createHash: nodeCrypto.createHash,
    install:    () => {},
    createHmac: nodeCrypto.createHmac,
  };
});

// B-153 flake rule — a crypto-project suite that would transitively import
// @utils/constants must mock it.
jest.mock('@utils/constants', () => ({
  __esModule: true,
  MSG_BASE_URL: 'https://relay.test',
  API_BASE_URL: 'https://auth.test',
}));

const MASTER_RAW = Buffer.alloc(32, 7);
const mockLoadMirrorMasterKey = jest.fn(async () => MASTER_RAW.toString('base64'));
jest.mock('../runtime/keychain', () => ({
  __esModule: true,
  loadMirrorMasterKey: (...args: unknown[]) => mockLoadMirrorMasterKey(...args as []),
}));

const mockFetchWithRefresh = jest.fn();
jest.mock('@/services/api', () => ({
  __esModule: true,
  fetchWithRefresh: (...args: unknown[]) => mockFetchWithRefresh(...args),
}));

import {useVaultStore, type VaultFile} from '../vault/vaultStore';
import {
  armVaultIndexSync,
  disarmVaultIndexSync,
  maybeRestoreVaultIndex,
  __flushVaultIndexPushForTests,
  __vaultIndexSyncTestState,
} from '../vault/vaultIndexSync';
import {hkdf} from '@noble/hashes/hkdf.js';
import {sha256} from '@noble/hashes/sha2.js';
import {aesGcmEncrypt, aesGcmDecrypt, backupAad, importSubkey, toB64, fromB64} from '../backup/backupCrypto';

const OWNER = 'owner-a@example.com';
const UID   = 'auth-user-1';

const file = (objectKey: string, overrides: Partial<VaultFile> = {}): VaultFile => ({
  objectKey,
  keyB64:    `key-${objectKey}`,
  ivB64:     `iv-${objectKey}`,
  name:      `${objectKey}.bin`,
  size:      128,
  mimeType:  'application/octet-stream',
  createdAt: 1_000,
  ...overrides,
});

async function indexKey() {
  const derived = hkdf(sha256, new Uint8Array(MASTER_RAW), undefined,
    new TextEncoder().encode('bravo-vault-index-v1'), 32);
  return importSubkey(derived);
}

async function sealPayload(payload: unknown): Promise<string> {
  const key = await indexKey();
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return toB64(await aesGcmEncrypt(key, bytes, backupAad('vault-index', UID)));
}

type Call = {url: string; init?: {method?: string; body?: string}};
function calls(): Call[] {
  return mockFetchWithRefresh.mock.calls.map(c => ({url: c[0] as string, init: c[1] as Call['init']}));
}
function putCalls(): Call[] {
  return calls().filter(c => c.init?.method === 'POST');
}

function respondJson(status: number, body: unknown) {
  return {ok: status >= 200 && status < 300, status, json: async () => body};
}

const st = () => useVaultStore.getState();

beforeEach(() => {
  jest.clearAllMocks();
  disarmVaultIndexSync();
  st().reset();
  mockLoadMirrorMasterKey.mockResolvedValue(MASTER_RAW.toString('base64'));
});

afterEach(() => {
  disarmVaultIndexSync();
});

describe('push — crypto contract round trip', () => {
  it('publishes the flat index AES-GCM-sealed under the HKDF subkey with the userId AAD', async () => {
    st().adoptVaultOwner(OWNER);
    armVaultIndexSync(OWNER, UID);
    // GET (seq discovery) → empty; POST → ok.
    mockFetchWithRefresh
      .mockResolvedValueOnce(respondJson(200, null))
      .mockResolvedValueOnce(respondJson(200, {ok: true, seq: 1}));
    st().addFile(file('vault/a/1'));
    await __flushVaultIndexPushForTests();

    const put = putCalls()[0];
    expect(put.url).toBe('https://relay.test/vault-index');
    const body = JSON.parse(put.init!.body!) as {blob: string; seq: number};
    expect(body.seq).toBe(1);

    // Decrypt EXACTLY as a restoring device would.
    const key = await indexKey();
    const plain = await aesGcmDecrypt(key, fromB64(body.blob), backupAad('vault-index', UID));
    const payload = JSON.parse(new TextDecoder().decode(plain)) as {v: number; files: VaultFile[]};
    expect(payload.v).toBe(1);
    expect(payload.files.map(f => f.objectKey)).toEqual(['vault/a/1']);

    // …and the WRONG AAD (another user's id) must not decrypt it.
    await expect(aesGcmDecrypt(key, fromB64(body.blob), backupAad('vault-index', 'someone-else')))
      .rejects.toBeTruthy();
  });

  it('is hard-OFF without a mirror key — no network traffic at all', async () => {
    mockLoadMirrorMasterKey.mockResolvedValue(null as unknown as string);
    st().adoptVaultOwner(OWNER);
    armVaultIndexSync(OWNER, UID);
    st().addFile(file('vault/a/1'));
    await __flushVaultIndexPushForTests();
    expect(putCalls()).toHaveLength(0);
  });

  it('409 stale_seq: pull, merge, adopt currentSeq+1, retry ONCE — never a third attempt', async () => {
    st().adoptVaultOwner(OWNER);
    armVaultIndexSync(OWNER, UID);
    st().addFile(file('vault/a/1'));

    const remoteBlob = await sealPayload({
      v: 1,
      files: [file('vault/other-device/9')],
      albumState: {albums: [], assignments: {}},
    });
    mockFetchWithRefresh
      .mockResolvedValueOnce(respondJson(200, null))                          // seq discovery
      .mockResolvedValueOnce(respondJson(409, {error: 'stale_seq', currentSeq: 4})) // first put
      .mockResolvedValueOnce(respondJson(200, {blob: remoteBlob, seq: 4}))    // adopt pull
      .mockResolvedValueOnce(respondJson(409, {error: 'stale_seq', currentSeq: 6})); // retry put — still stale
    await __flushVaultIndexPushForTests();

    // Exactly TWO puts (original + one adopt retry), and the remote row merged.
    expect(putCalls()).toHaveLength(2);
    const second = JSON.parse(putCalls()[1].init!.body!) as {seq: number};
    expect(second.seq).toBe(5);   // adopted 4 → claimed 5
    expect(st().files.map(f => f.objectKey).sort()).toEqual(['vault/a/1', 'vault/other-device/9']);
    expect(__vaultIndexSyncTestState().lastKnownSeq).toBe(6);   // adopted, not hammered
  });
});

describe('restore — pull and merge', () => {
  it('fills an EMPTY index from the server blob and records the seq', async () => {
    st().adoptVaultOwner(OWNER);
    armVaultIndexSync(OWNER, UID);
    mockFetchWithRefresh.mockReset();
    const blob = await sealPayload({
      v: 1,
      files: [file('vault/a/1'), file('vault/a/2')],
      albumState: {albums: [{id: 'alb1', name: 'Docs', createdAt: 1}], assignments: {'vault/a/1': 'alb1'}},
    });
    mockFetchWithRefresh.mockResolvedValueOnce(respondJson(200, {blob, seq: 3}));

    await maybeRestoreVaultIndex();

    expect(st().files.map(f => f.objectKey)).toEqual(['vault/a/1', 'vault/a/2']);
    expect(st().albumState.albums.map(a => a.name)).toEqual(['Docs']);
    expect(st().albumState.assignments['vault/a/1']).toBe('alb1');
    expect(__vaultIndexSyncTestState().lastKnownSeq).toBe(3);
  });

  it('no-ops when the local index already has rows (local wins)', async () => {
    st().adoptVaultOwner(OWNER);
    armVaultIndexSync(OWNER, UID);
    st().addFile(file('vault/a/1'));
    mockFetchWithRefresh.mockReset();
    await maybeRestoreVaultIndex();
    expect(mockFetchWithRefresh).not.toHaveBeenCalled();
  });

  it('a file removed THIS session is never resurrected by a later merge', async () => {
    st().adoptVaultOwner(OWNER);
    armVaultIndexSync(OWNER, UID);
    st().addFile(file('vault/a/1'));
    st().addFile(file('vault/a/2'));
    st().removeFile('vault/a/2');   // the subscription records the removal
    st().removeFile('vault/a/1');   // empty the index so the pull gate opens
    expect([...__vaultIndexSyncTestState().removedThisSession].sort())
      .toEqual(['vault/a/1', 'vault/a/2']);

    mockFetchWithRefresh.mockReset();
    const blob = await sealPayload({
      v: 1,
      files: [file('vault/a/2'), file('vault/fresh/3')],
      albumState: {albums: [], assignments: {}},
    });
    mockFetchWithRefresh.mockResolvedValueOnce(respondJson(200, {blob, seq: 9}));
    await maybeRestoreVaultIndex();

    expect(st().files.map(f => f.objectKey)).toEqual(['vault/fresh/3']);
  });
});

describe('mergeVaultIndex — the store-side rules', () => {
  it('refuses keyless rows (M-02), keeps local rows, prunes dead assignments', () => {
    st().adoptVaultOwner(OWNER);
    st().addFile(file('vault/a/1', {name: 'local-name.bin'}));
    const added = st().mergeVaultIndex({
      files: [
        file('vault/a/1', {name: 'remote-name.bin'}),          // dup — local wins
        {...file('vault/bad/2'), keyB64: ''},                   // keyless — refused
        file('vault/good/3'),
      ],
      albumState: {albums: [{id: 'alb1', name: 'Docs', createdAt: 1}], assignments: {'vault/gone/9': 'alb1'}},
    });
    expect(added).toBe(1);
    expect(st().files.map(f => f.objectKey).sort()).toEqual(['vault/a/1', 'vault/good/3']);
    expect(st().files.find(f => f.objectKey === 'vault/a/1')!.name).toBe('local-name.bin');
    expect(st().albumState.assignments['vault/gone/9']).toBeUndefined();
  });
});

describe('hygiene', () => {
  it('logs carry counts and seqs only — never names or key material', async () => {
    const logSpy = jest.spyOn(console, 'log');
    const warnSpy = jest.spyOn(console, 'warn');
    st().adoptVaultOwner(OWNER);
    armVaultIndexSync(OWNER, UID);
    mockFetchWithRefresh
      .mockResolvedValueOnce(respondJson(200, null))
      .mockResolvedValueOnce(respondJson(200, {ok: true, seq: 1}));
    st().addFile(file('vault/secret-passport-scan'));
    await __flushVaultIndexPushForTests();
    const all = [...logSpy.mock.calls, ...warnSpy.mock.calls].flat().map(String).join(' ');
    expect(all).not.toContain('secret-passport-scan');
    expect(all).not.toContain('key-vault');
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('sign-out disarm stops the lane cold — a stash swap publishes nothing', async () => {
    st().adoptVaultOwner(OWNER);
    armVaultIndexSync(OWNER, UID);
    disarmVaultIndexSync();
    st().addFile(file('vault/a/1'));
    st().stashAndClearOwner();
    await __flushVaultIndexPushForTests();
    expect(mockFetchWithRefresh).not.toHaveBeenCalled();
  });
});
