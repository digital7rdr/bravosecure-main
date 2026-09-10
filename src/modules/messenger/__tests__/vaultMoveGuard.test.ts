/**
 * Audit M-02 → B-86 — the vault "move" invariant, updated for the real
 * pipeline (2026-07-16).
 *
 * Old world: adding was hard-blocked because the viewer used to persist
 * VaultFile{keyB64:'', ivB64:'', uri:<plaintext temp>} — pretend
 * encryption. New world: `resolveVaultMoveAction` returns `add`, but the
 * fail-closed property MOVED, it did not disappear:
 *   1. vaultStore.addFile REFUSES any row without real key material —
 *      no caller can regress to pretend-encrypted rows.
 *   2. vaultOps.moveBytesToVault returns an honest failure (and writes
 *      nothing) when the MFA action token can't be minted — the server
 *      MfaGuard stays the gate.
 *   3. FileViewer still never touches addFile directly (static audit) —
 *      the ONLY add path is the vaultOps pipeline.
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

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {resolveVaultMoveAction} from '../ui/vaultMoveAction';
import {useVaultStore, type VaultFile} from '../vault/vaultStore';

const realRow = (over: Partial<VaultFile> = {}): VaultFile => ({
  objectKey: 'vault/3f7c1c9a',
  sourceKey: 'msg:msg-abc',
  keyB64:    'a2V5LWJ5dGVz',
  ivB64:     'aXYtYnl0ZXM=',
  name:      'photo.jpg',
  size:      100,
  mimeType:  'image/jpeg',
  createdAt: 1752600000000,
  ...over,
});

describe('resolveVaultMoveAction — B-86 semantics', () => {
  it('adds when the file has no vault row', () => {
    expect(resolveVaultMoveAction('msg-123', null)).toEqual({kind: 'add'});
  });

  it('removes by the MATCHED row objectKey (real rows use the server key)', () => {
    expect(resolveVaultMoveAction('msg-abc', 'vault/3f7c1c9a'))
      .toEqual({kind: 'remove', objectKey: 'vault/3f7c1c9a'});
  });

  it('removes legacy rows whose objectKey was the msg handle', () => {
    expect(resolveVaultMoveAction('msg-abc', 'msg:msg-abc'))
      .toEqual({kind: 'remove', objectKey: 'msg:msg-abc'});
  });
});

describe('vaultStore.addFile — M-02 fail-closed moved into the store', () => {
  beforeEach(() => {
    useVaultStore.getState().reset();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    (console.warn as jest.Mock).mockRestore();
  });

  it('REFUSES a row with empty key material', () => {
    useVaultStore.getState().addFile(realRow({keyB64: '', ivB64: ''}));
    expect(useVaultStore.getState().files).toEqual([]);
  });

  it('refuses a row with a missing objectKey', () => {
    useVaultStore.getState().addFile(realRow({objectKey: ''}));
    expect(useVaultStore.getState().files).toEqual([]);
  });

  it('accepts a real row exactly once (dedup by objectKey)', () => {
    useVaultStore.getState().addFile(realRow());
    useVaultStore.getState().addFile(realRow());
    expect(useVaultStore.getState().files).toHaveLength(1);
  });

  it('dedups re-adds of the same source even under a fresh server objectKey', () => {
    useVaultStore.getState().addFile(realRow());
    useVaultStore.getState().addFile(realRow({objectKey: 'vault/other'}));
    expect(useVaultStore.getState().files).toHaveLength(1);
  });

  it('dedups against a LEGACY row that used the msg handle as objectKey', () => {
    // Legacy rows predate the key-material guard — seed via state, the
    // way a persisted pre-B-86 index would rehydrate.
    useVaultStore.setState({files: [realRow({objectKey: 'msg:msg-abc', sourceKey: undefined, keyB64: 'x', ivB64: 'y'})]});
    useVaultStore.getState().addFile(realRow());
    expect(useVaultStore.getState().files).toHaveLength(1);
  });
});

describe('viewer vault path — remove clears the matched row', () => {
  beforeEach(() => {
    useVaultStore.getState().reset();
  });

  it('a remove action clears the row by its matched objectKey', () => {
    useVaultStore.getState().addFile(realRow());
    const row = useVaultStore.getState().files[0];
    const action = resolveVaultMoveAction('msg-abc', row.objectKey);
    expect(action.kind).toBe('remove');
    if (action.kind === 'remove') {
      useVaultStore.getState().removeFile(action.objectKey);
    }
    expect(useVaultStore.getState().files).toEqual([]);
  });
});

describe('FileViewer.tsx static source audit — M-02 regression lock', () => {
  const SRC = readFileSync(join(__dirname, '..', 'ui', 'FileViewer.tsx'), 'utf8');

  it('never calls the store addFile path directly (vaultOps is the only add pipeline)', () => {
    expect(SRC).not.toContain('addFile');
    expect(SRC).not.toContain('addToVault');
  });

  it('never constructs a pretend-encrypted VaultFile (empty key/iv)', () => {
    expect(SRC).not.toMatch(/keyB64:\s*''/);
    expect(SRC).not.toMatch(/ivB64:\s*''/);
  });

  it('routes the vault action through the guard + the MFA pipeline', () => {
    expect(SRC).toContain('resolveVaultMoveAction');
    expect(SRC).toContain('moveBytesToVault');
  });
});

describe('vaultOps.ts static source audit — fail-closed MFA wiring', () => {
  const SRC = readFileSync(join(__dirname, '..', 'vault', 'vaultOps.ts'), 'utf8');

  it('mints a vault-access action token and never fabricates a proof', () => {
    expect(SRC).toContain("mintActionToken('vault-access')");
    expect(SRC).not.toMatch(/X-Mfa-Proof.*=.*['"]/);
  });

  it('fails closed when the proof is unavailable', () => {
    expect(SRC).toContain("reason: 'mfa_unavailable'");
  });
});
