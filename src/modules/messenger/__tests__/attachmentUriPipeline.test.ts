/**
 * `media/useAttachmentUri.ts` — the RESOLVER half, executed.
 *
 * `attachmentUriPaging.test.tsx` (app project) renders the hook and pins the
 * B-296 message-swap reset. Nothing had ever executed the pipeline underneath
 * it: `resolveAttachmentFileUri` is also the entry point for the Files
 * multi-select share, so its four layers each carry a real bug history:
 *
 *   memo → single-flight (G4) → warm temp stat (G4) → gated cold pipeline
 *
 * What this suite pins:
 *   - the fast paths really are fast (a memo hit performs no stat; a warm stat
 *     performs no download) — that is the whole point of G4;
 *   - concurrent resolvers share ONE pipeline run, and a FAILED run does not
 *     poison the id for the retry;
 *   - MD-08's free-space probe runs BEFORE the network+decrypt spend, and
 *     classifies as 'no_space'. That ordering was previously pinned only by a
 *     source scan (`freeSpacePrecheck.test.ts`); here it is executed, so the
 *     assertion survives the code being reshaped;
 *   - MEDIA-25's concurrency cap actually caps, and — the subtle half — a
 *     failing pipeline RELEASES its slot instead of leaking it. Leak four and
 *     the media system deadlocks for the rest of the process lifetime.
 */


var mockFreeBytes: jest.Mock<Promise<number>, []>;

var mockGetRuntime: jest.Mock;

var mockStatTemp: jest.Mock;

var mockWriteTemp: jest.Mock;

// Both entry points, deliberately: `readFreeBytes` probes legacy first and
// falls back to the modern one, and it FAILS OPEN on a miss. Mocking only the
// legacy entry made these MD-08 assertions depend on which module resolved —
// when the legacy mock did not take effect the probe fell through to an empty
// stub, read null, and a "must reject" test saw a silent resolve. Same fix as
// freeSpacePrecheck.test.ts. The probe-explodes test below still exercises
// fail-open: a rejection from either path lands in the same catch.
jest.mock('expo-file-system/legacy', () => ({
  getFreeDiskStorageAsync: () => mockFreeBytes(),
}), {virtual: true});
jest.mock('expo-file-system', () => ({
  getFreeDiskStorageAsync: () => mockFreeBytes(),
}), {virtual: true});

// The runtime module pulls the store + crypto + keychain at import scope; the
// resolver only ever calls `downloadMedia` on it.
jest.mock('../runtime/runtime', () => ({
  getMessengerRuntime: (...args: unknown[]) => mockGetRuntime(...args),
}));

// mediaFiles is covered by its own suite against a fake FS; here it is the
// storage edge, so it is mocked.
jest.mock('../media/mediaFiles', () => ({
  statTempBytes:  (...args: unknown[]) => mockStatTemp(...args),
  writeTempBytes: (...args: unknown[]) => mockWriteTemp(...args),
}));

import {
  resolveAttachmentFileUri,
  seedResolvedAttachmentUri,
  _resetAttachmentUriCache,
  type AttachmentMessageLike,
} from '../media/useAttachmentUri';
import {classifyAttachmentError} from '../media/attachmentError';
import {NoFreeSpaceError} from '../media/freeSpace';

const GB = 1024 * 1024 * 1024;

function received(id: string, extra: Partial<AttachmentMessageLike> = {}): AttachmentMessageLike {
  return {
    id,
    media_object_key: `att/${id}`,
    media_key:        `key-${id}`,
    media_iv:         `iv-${id}`,
    media_mime:       'image/jpeg',
    ...extra,
  };
}

/** A promise whose settlement the test controls. */
function deferred<T>(): {promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return {promise, resolve, reject};
}

const flush = () => new Promise(r => setImmediate(r));

/**
 * `.catch(e => e as Error)` widens a waiter's settled value to `string | Error`,
 * so a waiter that RESOLVED to a uri — exactly the failure these single-flight
 * tests exist to catch — would read the same as one that rejected. Going through
 * here pins that the waiter really got the rejection before its message is read.
 */
function rejection(settled: string | Error): Error {
  expect(settled).toBeInstanceOf(Error);
  if (!(settled instanceof Error)) {throw new Error(`expected a rejection, got ${String(settled)}`);}
  return settled;
}

let downloadMedia: jest.Mock;

beforeEach(() => {
  _resetAttachmentUriCache();
  mockFreeBytes = jest.fn<Promise<number>, []>().mockResolvedValue(8 * GB);
  downloadMedia = jest.fn(async () => new Uint8Array([1, 2, 3]));
  mockGetRuntime = jest.fn(async () => ({downloadMedia}));
  mockStatTemp   = jest.fn(async () => null);
  mockWriteTemp  = jest.fn(async (_bytes: Uint8Array, _mime: string, id: string) =>
    `file:///caches/bravo-media-${id}.jpg`);
});

describe('resolveAttachmentFileUri — the fast paths (media-parity G4)', () => {
  it('a memoised uri returns without a stat or a download', async () => {
    seedResolvedAttachmentUri('m1', 'file:///caches/bravo-media-m1.jpg');
    await expect(resolveAttachmentFileUri(received('m1')))
      .resolves.toBe('file:///caches/bravo-media-m1.jpg');
    expect(mockStatTemp).not.toHaveBeenCalled();
    expect(downloadMedia).not.toHaveBeenCalled();
  });

  it('a warm temp file returns without touching the network', async () => {
    mockStatTemp.mockResolvedValue('file:///caches/bravo-media-warm.jpg');
    await expect(resolveAttachmentFileUri(received('warm')))
      .resolves.toBe('file:///caches/bravo-media-warm.jpg');
    expect(mockGetRuntime).not.toHaveBeenCalled();
    expect(downloadMedia).not.toHaveBeenCalled();
  });

  it('the warm hit is memoised, so the SECOND open costs not even a stat', async () => {
    mockStatTemp.mockResolvedValue('file:///caches/bravo-media-warm2.jpg');
    await resolveAttachmentFileUri(received('warm2'));
    mockStatTemp.mockClear();
    await expect(resolveAttachmentFileUri(received('warm2')))
      .resolves.toBe('file:///caches/bravo-media-warm2.jpg');
    expect(mockStatTemp).not.toHaveBeenCalled();
  });

  it('the warm stat is keyed by mime + id (the temp filename identity)', async () => {
    await resolveAttachmentFileUri(received('keyed')).catch(() => undefined);
    expect(mockStatTemp).toHaveBeenCalledWith('image/jpeg', 'keyed');
  });

  it('a message with no declared mime falls back to application/octet-stream', async () => {
    const msg = received('nomime', {media_mime: undefined});
    await resolveAttachmentFileUri(msg);
    expect(mockStatTemp).toHaveBeenCalledWith('application/octet-stream', 'nomime');
    expect(mockWriteTemp).toHaveBeenCalledWith(expect.any(Uint8Array), 'application/octet-stream', 'nomime');
  });
});

describe('resolveAttachmentFileUri — the cold pipeline', () => {
  it('downloads with the key material off the row, then writes the temp file', async () => {
    const bytes = new Uint8Array([9, 8, 7, 6]);
    downloadMedia.mockResolvedValue(bytes);
    const uri = await resolveAttachmentFileUri(received('cold'));
    expect(downloadMedia).toHaveBeenCalledWith({
      objectKey: 'att/cold',
      keyB64:    'key-cold',
      ivB64:     'iv-cold',
    });
    expect(mockWriteTemp).toHaveBeenCalledWith(bytes, 'image/jpeg', 'cold');
    expect(uri).toBe('file:///caches/bravo-media-cold.jpg');
  });

  it('memoises the cold result — a re-open never re-downloads', async () => {
    await resolveAttachmentFileUri(received('once'));
    await resolveAttachmentFileUri(received('once'));
    expect(downloadMedia).toHaveBeenCalledTimes(1);
  });

  it('throws runtime_not_ready before any network when the runtime has not booted', async () => {
    mockGetRuntime.mockResolvedValue(null);
    await expect(resolveAttachmentFileUri(received('early'))).rejects.toThrow('runtime_not_ready');
    expect(mockWriteTemp).not.toHaveBeenCalled();
  });

  it('treats a runtime WITHOUT downloadMedia as not ready (no TypeError)', async () => {
    mockGetRuntime.mockResolvedValue({} as never);
    await expect(resolveAttachmentFileUri(received('halfboot'))).rejects.toThrow('runtime_not_ready');
  });

  it('a download failure is NOT memoised — the retry re-runs the pipeline', async () => {
    downloadMedia.mockRejectedValueOnce(new Error('Network request failed'));
    await expect(resolveAttachmentFileUri(received('retry'))).rejects.toThrow(/Network request failed/);
    downloadMedia.mockResolvedValueOnce(new Uint8Array([1]));
    await expect(resolveAttachmentFileUri(received('retry')))
      .resolves.toBe('file:///caches/bravo-media-retry.jpg');
    expect(downloadMedia).toHaveBeenCalledTimes(2);
  });

  it('a write failure propagates and stays retryable', async () => {
    mockWriteTemp.mockRejectedValueOnce(new Error('ENOSPC: no space left on device'));
    await expect(resolveAttachmentFileUri(received('wfail'))).rejects.toThrow(/ENOSPC/);
    mockWriteTemp.mockResolvedValueOnce('file:///caches/bravo-media-wfail.jpg');
    await expect(resolveAttachmentFileUri(received('wfail')))
      .resolves.toBe('file:///caches/bravo-media-wfail.jpg');
  });
});

describe('resolveAttachmentFileUri — single-flight (G4)', () => {
  it('the bubble and the viewer share ONE pipeline run', async () => {
    const d = deferred<Uint8Array>();
    downloadMedia.mockReturnValue(d.promise);
    const a = resolveAttachmentFileUri(received('shared'));
    const b = resolveAttachmentFileUri(received('shared'));
    await flush();
    expect(downloadMedia).toHaveBeenCalledTimes(1);
    d.resolve(new Uint8Array([1]));
    expect(await a).toBe(await b);
  });

  it('both waiters see the SAME failure, and the id is clean afterwards', async () => {
    const d = deferred<Uint8Array>();
    downloadMedia.mockReturnValueOnce(d.promise);
    const a = resolveAttachmentFileUri(received('bothfail')).catch(e => e as Error);
    const b = resolveAttachmentFileUri(received('bothfail')).catch(e => e as Error);
    await flush();
    d.reject(new Error('boom'));
    expect(rejection(await a).message).toBe('boom');
    expect(rejection(await b).message).toBe('boom');
    // Clean afterwards: a third attempt actually retries.
    downloadMedia.mockResolvedValueOnce(new Uint8Array([1]));
    await expect(resolveAttachmentFileUri(received('bothfail'))).resolves.toContain('file://');
  });

  it('different message ids do NOT share a flight', async () => {
    await Promise.all([
      resolveAttachmentFileUri(received('id-a')),
      resolveAttachmentFileUri(received('id-b')),
    ]);
    expect(downloadMedia).toHaveBeenCalledTimes(2);
  });
});

describe('MD-08 — the free-space precheck runs BEFORE the spend', () => {
  it('a near-full disk rejects without a download, and classifies as no_space', async () => {
    mockFreeBytes.mockResolvedValue(1024);          // ~1 KB free
    const err = await resolveAttachmentFileUri(
      received('big', {media_meta: {sizeBytes: 40 * 1024 * 1024}}),
    ).catch(e => e as Error);
    expect(err).toBeInstanceOf(NoFreeSpaceError);
    expect(downloadMedia).not.toHaveBeenCalled();
    expect(classifyAttachmentError(err)).toBe('no_space');
  });

  it('the declared attachment size is what gets checked (not a fixed floor)', async () => {
    // 200 MB free clears the 50 MB headroom alone, but not a 300 MB video.
    mockFreeBytes.mockResolvedValue(200 * 1024 * 1024);
    await expect(resolveAttachmentFileUri(
      received('huge', {media_meta: {sizeBytes: 300 * 1024 * 1024}}),
    )).rejects.toBeInstanceOf(NoFreeSpaceError);
    await expect(resolveAttachmentFileUri(
      received('small', {media_meta: {sizeBytes: 2 * 1024 * 1024}}),
    )).resolves.toContain('file://');
  });

  it('FAILS OPEN: an unreadable probe must never block a download', async () => {
    mockFreeBytes.mockRejectedValue(new Error('probe exploded'));
    await expect(resolveAttachmentFileUri(received('failopen'))).resolves.toContain('file://');
    expect(downloadMedia).toHaveBeenCalledTimes(1);
  });

  it('a WARM file skips the probe entirely (no disk write is coming)', async () => {
    mockStatTemp.mockResolvedValue('file:///caches/bravo-media-nowrite.jpg');
    mockFreeBytes.mockResolvedValue(0);
    await expect(resolveAttachmentFileUri(received('nowrite'))).resolves.toContain('file://');
  });
});

describe('MEDIA-25 — the concurrency gate', () => {
  it('caps cold pipelines at 4 and admits the next one as a slot frees', async () => {
    const gates = Array.from({length: 6}, () => deferred<Uint8Array>());
    let i = 0;
    downloadMedia.mockImplementation(() => gates[i++].promise);

    const runs = Array.from({length: 6}, (_, n) => resolveAttachmentFileUri(received(`gate-${n}`)));
    await flush(); await flush();
    expect(downloadMedia).toHaveBeenCalledTimes(4);

    gates[0].resolve(new Uint8Array([1]));
    await runs[0];
    await flush(); await flush();
    expect(downloadMedia).toHaveBeenCalledTimes(5);

    for (let n = 1; n < 6; n++) {gates[n].resolve(new Uint8Array([1]));}
    await Promise.all(runs);
    expect(downloadMedia).toHaveBeenCalledTimes(6);
  });

  it('a FAILING pipeline releases its slot (a leak would deadlock media forever)', async () => {
    downloadMedia.mockRejectedValue(new Error('Network request failed'));
    const failures = Array.from({length: 4}, (_, n) =>
      resolveAttachmentFileUri(received(`leak-${n}`)).catch(e => e as Error));
    await Promise.all(failures);

    downloadMedia.mockResolvedValue(new Uint8Array([1]));
    await expect(resolveAttachmentFileUri(received('after-leak'))).resolves.toContain('file://');
  });

  it('a free-space rejection also releases its slot', async () => {
    mockFreeBytes.mockResolvedValue(1);
    const rejects = Array.from({length: 4}, (_, n) =>
      resolveAttachmentFileUri(received(`nospace-${n}`)).catch(e => e as Error));
    await Promise.all(rejects);

    mockFreeBytes.mockResolvedValue(8 * GB);
    await expect(resolveAttachmentFileUri(received('after-nospace'))).resolves.toContain('file://');
  });

  it('warm hits are NOT queued behind the gate (re-opens stay instant)', async () => {
    // Four cold pipelines occupy every slot...
    const gates = Array.from({length: 4}, () => deferred<Uint8Array>());
    let i = 0;
    downloadMedia.mockImplementation(() => gates[i++].promise);
    const cold = Array.from({length: 4}, (_, n) => resolveAttachmentFileUri(received(`busy-${n}`)));
    await flush();

    // ...and a warm re-open still resolves immediately.
    mockStatTemp.mockResolvedValue('file:///caches/bravo-media-instant.jpg');
    await expect(resolveAttachmentFileUri(received('instant')))
      .resolves.toBe('file:///caches/bravo-media-instant.jpg');

    for (const g of gates) {g.resolve(new Uint8Array([1]));}
    await Promise.all(cold);
  });
});

describe('seedResolvedAttachmentUri — bounded memo (MAX_RESOLVED = 300)', () => {
  it('evicts the oldest entry once full instead of growing without limit', async () => {
    for (let n = 0; n < 300; n++) {seedResolvedAttachmentUri(`ev-${n}`, `file:///caches/ev-${n}.jpg`);}
    // Still memoised at the cap.
    await expect(resolveAttachmentFileUri(received('ev-0'))).resolves.toBe('file:///caches/ev-0.jpg');
    expect(mockStatTemp).not.toHaveBeenCalled();

    seedResolvedAttachmentUri('ev-300', 'file:///caches/ev-300.jpg');
    mockStatTemp.mockResolvedValue('file:///caches/refetched.jpg');
    // ev-0 was evicted — the resolver falls back to the warm stat.
    await expect(resolveAttachmentFileUri(received('ev-0'))).resolves.toBe('file:///caches/refetched.jpg');
    expect(mockStatTemp).toHaveBeenCalledTimes(1);
    // Eviction is oldest-first and ONE entry at a time — the youngest entries
    // are still memoised, so a full memo does not degrade into a cold cache.
    mockStatTemp.mockClear();
    await expect(resolveAttachmentFileUri(received('ev-299'))).resolves.toBe('file:///caches/ev-299.jpg');
    expect(mockStatTemp).not.toHaveBeenCalled();
  });

  it('re-seeding an EXISTING id at the cap updates in place and evicts nothing', async () => {
    for (let n = 0; n < 300; n++) {seedResolvedAttachmentUri(`re-${n}`, `file:///caches/re-${n}.jpg`);}
    seedResolvedAttachmentUri('re-5', 'file:///caches/re-5-v2.jpg');
    await expect(resolveAttachmentFileUri(received('re-5'))).resolves.toBe('file:///caches/re-5-v2.jpg');
    await expect(resolveAttachmentFileUri(received('re-0'))).resolves.toBe('file:///caches/re-0.jpg');
    expect(mockStatTemp).not.toHaveBeenCalled();
  });

  it('_resetAttachmentUriCache drops the memo (test isolation hook)', async () => {
    seedResolvedAttachmentUri('gone', 'file:///caches/gone.jpg');
    _resetAttachmentUriCache();
    mockStatTemp.mockResolvedValue(null);
    await resolveAttachmentFileUri(received('gone'));
    expect(downloadMedia).toHaveBeenCalledTimes(1);
  });
});
