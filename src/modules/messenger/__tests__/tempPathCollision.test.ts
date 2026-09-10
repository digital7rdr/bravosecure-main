/**
 * B-457 — the decrypted-plaintext temp cache served the WRONG FILE.
 *
 * `writeTempBytes(bytes, mime, idHint)` derived its filename by stripping the
 * idHint to `[a-zA-Z0-9_-]` and taking `.slice(0, 40)`. It then SKIPS the write
 * when the path already exists (a deliberate fast path), so any two idHints
 * that survive sanitisation with the same 40-char prefix resolve to one file
 * and every later caller gets the FIRST caller's plaintext back.
 *
 * The vault hits this every time. Server keys are `vault/<userId>/<uuid>`
 * (apps/messenger-service/src/vault/vault.service.ts:82) and vaultOps passes
 * `vault-<objectKey>` (vaultOps.ts:220), so the stem is
 * `vault-vault` (11 chars) + the 36-char owner uuid + the 36-char file uuid.
 * The 40-char budget is exhausted inside the OWNER id — the per-file uuid, the
 * only part that distinguishes one vault file from another, is truncated away
 * entirely. Every same-mime file in one user's vault becomes one temp path.
 *
 * `statTempBytes` (the warm path) and `deleteTempBytes` (the plaintext
 * cleanup, audit MEDIA-A2) build the SAME stem, so all three have to agree —
 * a fix that only touched the writer would leave stale plaintext undeleted.
 */

const mockFs = new Map<string, string>();

jest.mock('react-native-fs', () => ({
  __esModule: true,
  default: {
    CachesDirectoryPath:    '/caches',
    DocumentDirectoryPath:  '/docs',
    TemporaryDirectoryPath: '/tmp',
    exists:    async (p: string) => mockFs.has(p),
    writeFile: async (p: string, data: string) => { mockFs.set(p, data); },
    readFile:  async (p: string) => mockFs.get(p) ?? '',
    unlink:    async (p: string) => { mockFs.delete(p); },
    readDir:   async () => [...mockFs.keys()].map(p => ({
      path: p, name: p.slice(p.lastIndexOf('/') + 1), isFile: () => true,
    })),
  },
}));

import {writeTempBytes, statTempBytes, deleteTempBytes} from '../media/mediaFiles';

/** Exactly the shape vault.service.ts:82 mints. */
const OWNER = '4f2b9c81-7d3e-4a55-9b10-2c6e8f0a1d34';
const KEY_A = `vault/${OWNER}/8f3e5c2a-1b4d-4e6f-9a0b-1c2d3e4f5a6b`;
const KEY_B = `vault/${OWNER}/7d1a9b3c-2e5f-4071-8c3d-9e0f1a2b3c4d`;

const BYTES_A = new Uint8Array([1, 1, 1, 1]);
const BYTES_B = new Uint8Array([2, 2, 2, 2]);

beforeEach(() => { mockFs.clear(); });

describe('B-457 — distinct idHints never collide after sanitisation', () => {
  it('two vault files from the same owner get different temp paths', async () => {
    const a = await writeTempBytes(BYTES_A, 'image/jpeg', `vault-${KEY_A}`);
    const b = await writeTempBytes(BYTES_B, 'image/jpeg', `vault-${KEY_B}`);
    expect(a).not.toBe(b);
  });

  it('the second file does NOT get served the first file\'s bytes', async () => {
    await writeTempBytes(BYTES_A, 'image/jpeg', `vault-${KEY_A}`);
    const b = await writeTempBytes(BYTES_B, 'image/jpeg', `vault-${KEY_B}`);
    const stored = mockFs.get(b.replace('file://', ''));
    expect(stored).toBe(Buffer.from(BYTES_B).toString('base64'));
  });

  it('idHints differing only past char 40 still separate', async () => {
    const stem = 'x'.repeat(48);
    const a = await writeTempBytes(BYTES_A, 'application/pdf', `${stem}-one`);
    const b = await writeTempBytes(BYTES_B, 'application/pdf', `${stem}-two`);
    expect(a).not.toBe(b);
  });

  it('the same idHint still resolves to the same path (the cache still caches)', async () => {
    const a1 = await writeTempBytes(BYTES_A, 'image/png', `vault-${KEY_A}`);
    const a2 = await writeTempBytes(BYTES_A, 'image/png', `vault-${KEY_A}`);
    expect(a2).toBe(a1);
  });
});

describe('B-457 — the reader and the cleaner agree with the writer', () => {
  it('statTempBytes finds exactly the file writeTempBytes wrote, and not its neighbour', async () => {
    const a = await writeTempBytes(BYTES_A, 'image/jpeg', `vault-${KEY_A}`);
    expect(await statTempBytes('image/jpeg', `vault-${KEY_A}`)).toBe(a);
    expect(await statTempBytes('image/jpeg', `vault-${KEY_B}`)).toBeNull();
  });

  it('deleteTempBytes removes its own plaintext and leaves the neighbour alone', async () => {
    const a = await writeTempBytes(BYTES_A, 'image/jpeg', `vault-${KEY_A}`);
    const b = await writeTempBytes(BYTES_B, 'image/jpeg', `vault-${KEY_B}`);
    await deleteTempBytes(`vault-${KEY_A}`);
    expect(mockFs.has(a.replace('file://', ''))).toBe(false);
    expect(mockFs.has(b.replace('file://', ''))).toBe(true);
  });
});

describe('B-457 — filenames stay filesystem-safe and bounded', () => {
  it('never emits a path separator or other unsafe character in the stem', async () => {
    const uri = await writeTempBytes(BYTES_A, 'image/jpeg', '../../etc/pas swd:$(x)');
    const name = uri.slice(uri.lastIndexOf('/') + 1);
    expect(name).toMatch(/^bravo-media-[a-zA-Z0-9_-]+\.[a-z0-9]+$/);
  });

  it('an empty / fully-stripped idHint still produces a usable name', async () => {
    const uri = await writeTempBytes(BYTES_A, 'image/jpeg', '///');
    const name = uri.slice(uri.lastIndexOf('/') + 1);
    expect(name).toMatch(/^bravo-media-[a-zA-Z0-9_-]+\.jpg$/);
  });

  it('keeps roughly the previous length budget (no unbounded names)', async () => {
    const uri = await writeTempBytes(BYTES_A, 'image/jpeg', 'z'.repeat(400));
    const name = uri.slice(uri.lastIndexOf('/') + 1);
    expect(name.length).toBeLessThanOrEqual('bravo-media-'.length + 48 + '.jpeg'.length);
  });
});
