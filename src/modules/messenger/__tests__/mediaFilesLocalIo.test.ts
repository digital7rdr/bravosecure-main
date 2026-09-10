/**
 * `media/mediaFiles.ts` — first EXECUTED coverage of the local-file bridge.
 *
 * This module is the only place plaintext attachment bytes touch the disk, so
 * its contracts are security contracts, not conveniences:
 *
 *   - the decrypted temp file must land in the app-PRIVATE cache dir, and a
 *     hostile message id must not be able to steer it anywhere else
 *     (`idHint` is sanitised to [A-Za-z0-9_-] and capped at 40 chars);
 *   - `deleteTempBytes` (audit MEDIA-A2) must purge the plaintext a burned
 *     disappearing message left behind — and must NOT purge a neighbour whose
 *     id merely starts with the same characters;
 *   - `deleteEphemeralSource` (B-149) is DELIBERATELY NARROW: it refuses any
 *     uri outside the app's own roots, because the obvious generalisation
 *     ("delete the asset after upload") would unlink the user's photo out of
 *     their gallery.
 *
 * The repo's shared `react-native-fs` stub rejects every call by design (it
 * exists to make modules importable), so this suite installs an in-file
 * in-memory fake — scoped to this file, never a `__mocks__` node-module
 * shadow — and drives the real module against it.
 */

// Hoisting: jest.mock is lifted above the imports, so the factory may only
// build the fake here and must dereference `mockFiles` / `mockDirs` lazily,
// at call time, once the body below has initialised them.

var mockFiles: Map<string, string>;

var mockDirs: Set<string>;

jest.mock('react-native-fs', () => {
  const CACHES = '/mock/caches';
  const entriesUnder = (dir: string) => {
    const out: Array<{name: string; path: string; isFile: () => boolean; isDirectory: () => boolean}> = [];
    const push = (path: string, isFile: boolean) => {
      if (!path.startsWith(`${dir}/`)) {return;}
      const name = path.slice(dir.length + 1);
      if (name.includes('/')) {return;}
      out.push({name, path, isFile: () => isFile, isDirectory: () => !isFile});
    };
    for (const path of mockFiles.keys()) {push(path, true);}
    for (const path of mockDirs) {push(path, false);}
    return out;
  };
  return {
    __esModule: true,
    default: {
      CachesDirectoryPath:    CACHES,
      DocumentDirectoryPath:  '/mock/documents',
      TemporaryDirectoryPath: '/mock/tmp',
      readFile: jest.fn(async (path: string, encoding: string) => {
        if (encoding !== 'base64') {throw new Error(`unexpected encoding: ${encoding}`);}
        const v = mockFiles.get(path);
        if (v === undefined) {throw new Error(`ENOENT: no such file ${path}`);}
        return v;
      }),
      writeFile: jest.fn(async (path: string, data: string, encoding: string) => {
        if (encoding !== 'base64') {throw new Error(`unexpected encoding: ${encoding}`);}
        mockFiles.set(path, data);
      }),
      exists:  jest.fn(async (path: string) => mockFiles.has(path)),
      unlink:  jest.fn(async (path: string) => {
        if (!mockFiles.has(path)) {throw new Error(`ENOENT: cannot unlink ${path}`);}
        mockFiles.delete(path);
      }),
      readDir: jest.fn(async (dir: string) => entriesUnder(dir)),
      stat:    jest.fn(async () => ({size: 0})),
      mkdir:   jest.fn(async () => undefined),
    },
  };
});

import RNFS from 'react-native-fs';

import {
  readUriBytes,
  writeTempBytes,
  statTempBytes,
  deleteTempBytes,
  deleteEphemeralSource,
} from '../media/mediaFiles';

const fs = RNFS as unknown as {
  readFile:  jest.Mock;
  writeFile: jest.Mock;
  exists:    jest.Mock;
  unlink:    jest.Mock;
  readDir:   jest.Mock;
};

const b64 = (bytes: number[]) => Buffer.from(bytes).toString('base64');

beforeEach(() => {
  mockFiles = new Map<string, string>();
  mockDirs  = new Set<string>();
  jest.clearAllMocks();
});

describe('readUriBytes', () => {
  it('decodes the picked file byte-for-byte', async () => {
    const bytes = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46];
    mockFiles.set('file:///pick/photo.jpg', b64(bytes));
    const out = await readUriBytes('file:///pick/photo.jpg');
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out)).toEqual(bytes);
  });

  it('reads an Android content:// SAF uri unchanged (no path munging)', async () => {
    // A plain fs-path read rejects content:// — the module must hand the uri to
    // RNFS verbatim and let it resolve the SAF document.
    const uri = 'content://com.android.providers.media.documents/document/image%3A42';
    mockFiles.set(uri, b64([1, 2, 3]));
    expect(Array.from(await readUriBytes(uri))).toEqual([1, 2, 3]);
    expect(fs.readFile).toHaveBeenCalledWith(uri, 'base64');
  });

  it('produces an empty array for a zero-byte file rather than throwing', async () => {
    mockFiles.set('file:///pick/empty.bin', '');
    expect((await readUriBytes('file:///pick/empty.bin')).byteLength).toBe(0);
  });

  it('propagates a read failure so the caller can classify it', async () => {
    await expect(readUriBytes('file:///pick/missing.jpg')).rejects.toThrow(/ENOENT/);
  });

  it('stays silent on a fast read (no [LAGDIAG] spam per attachment)', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mockFiles.set('file:///pick/fast.jpg', b64([1, 2, 3]));
      await readUriBytes('file:///pick/fast.jpg');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('the slow-read [LAGDIAG] line carries sizes and ms only — never the uri or bytes', async () => {
    // logAudit posture: a diagnostic added to chase B-285 must not become the
    // thing that leaks a filename or plaintext into logcat.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const now  = jest.spyOn(Date, 'now');
    try {
      now.mockReturnValueOnce(0).mockReturnValueOnce(400).mockReturnValueOnce(900);
      const secret = 'file:///pick/passport-scan.jpg';
      mockFiles.set(secret, b64([9, 9, 9, 9]));
      await readUriBytes(secret);
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0][0]);
      expect(line).toContain('[LAGDIAG] readUriBytes');
      expect(line).toContain('read=400ms');
      expect(line).toContain('b64decode=500ms');
      expect(line).not.toContain('passport');
      expect(line).not.toContain(b64([9, 9, 9, 9]));
    } finally {
      now.mockRestore();
      warn.mockRestore();
    }
  });
});

describe('writeTempBytes — the private-cache contract', () => {
  // B-457 — the stem is `<sanitised idHint, <=31 chars>-<16 hex of the FULL
  // hint>`. Asserting the hash literal would only re-pin the hash function, so
  // these tests assert the SHAPE plus the property the hash exists for
  // (injectivity, below). Keep it that way.
  const STEM = /^file:\/\/\/mock\/caches\/bravo-media-(.+)-[0-9a-f]{16}\.(\w+)$/;

  it('writes into the app cache dir and returns a file:// uri for it', async () => {
    const uri = await writeTempBytes(new Uint8Array([1, 2, 3, 4]), 'image/jpeg', 'msg-1');
    const m = STEM.exec(uri);
    expect(m).not.toBeNull();
    expect(m![1]).toBe('msg-1');
    expect(m![2]).toBe('jpg');
    expect(mockFiles.has(uri.replace('file://', ''))).toBe(true);
  });

  it('is INJECTIVE over the id — the B-457 wrong-file-serve fix', async () => {
    // Two hints that share the first 31 sanitised characters and differ only
    // past the truncation point. Before B-457 both resolved to ONE file and the
    // second caller was handed the first caller's decrypted plaintext.
    const base = 'vault-11111111-2222-3333-4444-5';
    const a = await writeTempBytes(new Uint8Array([1]), 'image/jpeg', `${base}aaaaaaaa`);
    const b = await writeTempBytes(new Uint8Array([2]), 'image/jpeg', `${base}bbbbbbbb`);
    expect(a).not.toBe(b);
  });

  it('round-trips through the module own reader (base64 encode/decode parity)', async () => {
    const bytes = new Uint8Array([0x00, 0x7f, 0x80, 0xff, 0x41, 0x42]);
    const uri = await writeTempBytes(bytes, 'application/pdf', 'msg-rt');
    expect(Array.from(await readUriBytes(uri.replace('file://', '')))).toEqual(Array.from(bytes));
  });

  it('reuses the existing file instead of re-encoding (G4 warm path)', async () => {
    const bytes = new Uint8Array([5, 6, 7]);
    const first  = await writeTempBytes(bytes, 'image/png', 'dup');
    const second = await writeTempBytes(bytes, 'image/png', 'dup');
    expect(second).toBe(first);
    expect(fs.writeFile).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['image/jpeg', '.jpg'],
    ['image/jpg',  '.jpg'],
    ['IMAGE/PNG',  '.png'],
    ['image/gif',  '.gif'],
    ['image/webp', '.webp'],
    ['video/mp4',  '.mp4'],
    ['video/quicktime', '.mov'],
    ['video/webm', '.webm'],
    ['video/3gpp', '.3gp'],
    ['audio/x-m4a', '.m4a'],
    ['audio/mpeg', '.mp3'],
    ['audio/ogg',  '.ogg'],
    ['audio/x-wav', '.wav'],
    ['audio/aac',  '.aac'],
    ['application/pdf', '.pdf'],
    ['text/plain', '.txt'],
    ['application/zip', '.zip'],
    ['application/msword', '.doc'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
    ['application/vnd.ms-excel', '.xls'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
    ['application/vnd.ms-powerpoint', '.ppt'],
    ['application/vnd.openxmlformats-officedocument.presentationml.presentation', '.pptx'],
  ])('mime %s picks the extension the OS decoder needs (%s)', async (mime, ext) => {
    const uri = await writeTempBytes(new Uint8Array([1]), mime, `ext-${ext.slice(1)}`);
    expect(uri.endsWith(ext)).toBe(true);
  });

  it('Media-parity M14: an unknown mime still gets an extension (.bin), never a bare file', async () => {
    // An extensionless temp file could not be opened by FileViewer/ACTION_VIEW
    // resolvers, which pick handlers by extension.
    for (const mime of ['application/x-made-up', '', 'application/octet-stream']) {
      const uri = await writeTempBytes(new Uint8Array([1]), mime, `unknown-${mime.length}`);
      expect(uri.endsWith('.bin')).toBe(true);
    }
  });

  it('a hostile message id cannot steer the write out of the cache dir', async () => {
    const uri = await writeTempBytes(new Uint8Array([1]), 'image/jpeg', '../../../data/data/other.app/x');
    expect(uri).not.toContain('..');
    expect(uri).not.toContain('/data/data/');
    expect(uri.startsWith('file:///mock/caches/bravo-media-')).toBe(true);
    const written = fs.writeFile.mock.calls[0][0] as string;
    expect(written.startsWith('/mock/caches/bravo-media-')).toBe(true);
  });

  it('strips separators and slashes out of the id (no nested paths)', async () => {
    const uri = await writeTempBytes(new Uint8Array([1]), 'image/jpeg', 'a/b\\c:d?e');
    expect(STEM.exec(uri)?.[1]).toBe('abcde');
    // The point of the sanitiser: nothing in the FILENAME that could escape
    // the cache dir. Scoped to the basename — `file://` legitimately has both
    // a colon and slashes.
    const basename = uri.replace('file:///mock/caches/', '');
    expect(basename).not.toMatch(/[\\/:?]/);
  });

  it('caps the readable part at 31 characters so the filename stays bounded', async () => {
    // 31 + '-' + 16 hex = 48, the same length budget the pre-B-457 rule had.
    const long = 'z'.repeat(120);
    const uri = await writeTempBytes(new Uint8Array([1]), 'image/jpeg', long);
    const m = STEM.exec(uri);
    expect(m![1]).toBe('z'.repeat(31));
    expect(`${m![1]}-`.length + 16).toBe(48);
  });

  it('falls back to "att" when the id sanitises to nothing', async () => {
    const uri = await writeTempBytes(new Uint8Array([1]), 'image/jpeg', '!!!@@@###');
    expect(STEM.exec(uri)?.[1]).toBe('att');
  });
});

describe('statTempBytes — G4 warm fast path', () => {
  it('returns the very uri writeTempBytes produced (same path formula)', async () => {
    const written = await writeTempBytes(new Uint8Array([1, 2]), 'image/jpeg', 'warm-1');
    await expect(statTempBytes('image/jpeg', 'warm-1')).resolves.toBe(written);
  });

  it('resolves null on a miss so the caller falls into the cold pipeline', async () => {
    await expect(statTempBytes('image/jpeg', 'never-written')).resolves.toBeNull();
  });

  it('a DIFFERENT mime is a miss — the extension is part of the identity', async () => {
    await writeTempBytes(new Uint8Array([1]), 'image/jpeg', 'mime-shift');
    await expect(statTempBytes('video/mp4', 'mime-shift')).resolves.toBeNull();
  });

  it('never touches bytes on a hit (no readFile)', async () => {
    await writeTempBytes(new Uint8Array([1, 2]), 'image/jpeg', 'warm-2');
    fs.readFile.mockClear();
    await statTempBytes('image/jpeg', 'warm-2');
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it('an exists() failure reads as a miss, never a throw', async () => {
    fs.exists.mockRejectedValueOnce(new Error('cache dir unreadable'));
    await expect(statTempBytes('image/jpeg', 'boom')).resolves.toBeNull();
  });
});

describe('deleteTempBytes — audit MEDIA-A2 (burned message must not leave plaintext)', () => {
  it('unlinks the decrypted temp file for that message id', async () => {
    const uri = await writeTempBytes(new Uint8Array([1, 2, 3]), 'image/jpeg', 'burn-me');
    await deleteTempBytes('burn-me');
    expect(mockFiles.has(uri.replace('file://', ''))).toBe(false);
  });

  it('does NOT collateral-delete a neighbour whose id merely shares the prefix', async () => {
    // 'abc' must not take out 'abcd'. Read the names back from the writer
    // rather than spelling them out — B-457 changed the formula once already,
    // and a hardcoded name turns this safety property into a string test.
    const abc  = await writeTempBytes(new Uint8Array([1]), 'image/jpeg', 'abc');
    const abcd = await writeTempBytes(new Uint8Array([2]), 'image/jpeg', 'abcd');
    await deleteTempBytes('abc');
    expect(mockFiles.has(abc.replace('file://', ''))).toBe(false);
    expect(mockFiles.has(abcd.replace('file://', ''))).toBe(true);
  });

  it('leaves unrelated cache files alone', async () => {
    await writeTempBytes(new Uint8Array([1]), 'image/jpeg', 'mine');
    mockFiles.set('/mock/caches/some-other-app-file.dat', 'zzz');
    await deleteTempBytes('mine');
    expect(mockFiles.has('/mock/caches/some-other-app-file.dat')).toBe(true);
  });

  it('deletes the extensionless variant too (exact prefix match)', async () => {
    mockFiles.set('/mock/caches/bravo-media-noext', 'zzz');
    await deleteTempBytes('noext');
    expect(mockFiles.has('/mock/caches/bravo-media-noext')).toBe(false);
  });

  it('deletes EVERY extension written for one id (mime changed between decrypts)', async () => {
    await writeTempBytes(new Uint8Array([1]), 'image/jpeg', 'multi');
    await writeTempBytes(new Uint8Array([1]), 'video/mp4',  'multi');
    await deleteTempBytes('multi');
    expect(mockFiles.has('/mock/caches/bravo-media-multi.jpg')).toBe(false);
    expect(mockFiles.has('/mock/caches/bravo-media-multi.mp4')).toBe(false);
  });

  it('skips directories (isFile() gate)', async () => {
    mockDirs.add('/mock/caches/bravo-media-dir.jpg');
    await deleteTempBytes('dir');
    expect(fs.unlink).not.toHaveBeenCalled();
  });

  it('sanitises the id the same way as the writer', async () => {
    await writeTempBytes(new Uint8Array([1]), 'image/jpeg', '../../evil');
    await deleteTempBytes('../../evil');
    expect(mockFiles.has('/mock/caches/bravo-media-evil.jpg')).toBe(false);
  });

  it('never throws when the cache dir is unreadable', async () => {
    fs.readDir.mockRejectedValueOnce(new Error('EACCES'));
    await expect(deleteTempBytes('whatever')).resolves.toBeUndefined();
  });

  it('one failing unlink does not abandon the others', async () => {
    await writeTempBytes(new Uint8Array([1]), 'image/jpeg', 'partial');
    await writeTempBytes(new Uint8Array([1]), 'video/mp4',  'partial');
    fs.unlink.mockImplementationOnce(async () => { throw new Error('EBUSY'); });
    await expect(deleteTempBytes('partial')).resolves.toBeUndefined();
    expect(fs.unlink).toHaveBeenCalledTimes(2);
  });
});

describe('deleteEphemeralSource — B-149 (delete OUR capture, never the user gallery)', () => {
  it('unlinks a recording the app itself wrote into its cache', async () => {
    mockFiles.set('/mock/caches/voice-note-1.m4a', 'zz');
    await deleteEphemeralSource('file:///mock/caches/voice-note-1.m4a');
    expect(mockFiles.has('/mock/caches/voice-note-1.m4a')).toBe(false);
  });

  it.each([
    ['/mock/documents/doc-capture.m4a'],
    ['/mock/tmp/tmp-capture.m4a'],
  ])('also owns %s', async (path) => {
    mockFiles.set(path, 'zz');
    await deleteEphemeralSource(`file://${path}`);
    expect(mockFiles.has(path)).toBe(false);
  });

  it('REFUSES a gallery pick outside the app roots — the user photo survives', async () => {
    const gallery = '/storage/emulated/0/DCIM/Camera/IMG_20260813.jpg';
    mockFiles.set(gallery, 'the users only copy');
    await deleteEphemeralSource(`file://${gallery}`);
    expect(fs.unlink).not.toHaveBeenCalled();
    expect(mockFiles.has(gallery)).toBe(true);
  });

  it('refuses a path that merely CONTAINS an owned root later in the string', async () => {
    const sneaky = '/storage/emulated/0/mock/caches/photo.jpg';
    mockFiles.set(sneaky, 'not ours');
    await deleteEphemeralSource(`file://${sneaky}`);
    expect(fs.unlink).not.toHaveBeenCalled();
    expect(mockFiles.has(sneaky)).toBe(true);
  });

  it('refuses a content:// uri (a SAF grant is never ours to delete)', async () => {
    await deleteEphemeralSource('content://media/external/images/media/42');
    expect(fs.unlink).not.toHaveBeenCalled();
  });

  it.each([['' ], ['/mock/caches/no-scheme.m4a'], ['http://example.invalid/x.m4a']])(
    'ignores a non-file uri (%s)', async (uri) => {
      await deleteEphemeralSource(uri);
      expect(fs.unlink).not.toHaveBeenCalled();
    });

  it('tolerates a null/undefined uri (optional-chained guard)', async () => {
    await expect(
      deleteEphemeralSource(undefined as unknown as string),
    ).resolves.toBeUndefined();
    expect(fs.unlink).not.toHaveBeenCalled();
  });

  it('percent-decodes the path before unlinking', async () => {
    mockFiles.set('/mock/caches/my voice note.m4a', 'zz');
    await deleteEphemeralSource('file:///mock/caches/my%20voice%20note.m4a');
    expect(mockFiles.has('/mock/caches/my voice note.m4a')).toBe(false);
  });

  it('a malformed percent-escape bails out instead of throwing', async () => {
    await expect(
      deleteEphemeralSource('file:///mock/caches/%E0%A4%A'),
    ).resolves.toBeUndefined();
    expect(fs.unlink).not.toHaveBeenCalled();
  });

  it('an unlink failure is swallowed (best-effort, never breaks the send)', async () => {
    fs.unlink.mockRejectedValueOnce(new Error('EBUSY'));
    await expect(
      deleteEphemeralSource('file:///mock/caches/locked.m4a'),
    ).resolves.toBeUndefined();
  });
});
