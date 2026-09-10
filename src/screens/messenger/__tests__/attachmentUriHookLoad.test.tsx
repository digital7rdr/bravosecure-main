/**
 * `useAttachmentUri` — the LOADING state machine, rendered.
 *
 * `attachmentUriPaging.test.tsx` pins B-296 (the hook must follow the message
 * it is handed) and every case there is deliberately memoised, so `load()`
 * itself — idle → loading → ready | error, the reason codes the bubble prints,
 * and the MEDIA-A3 fallback — had never been executed by a test.
 *
 * MEDIA-A3 is the one worth the render: the SENDER's own bubble shows the
 * local pick (`media_url`) with no network. That uri dies — a content:// grant
 * is revoked after reboot, or the OS trims the cache — and before the fix the
 * sender's own attachment was permanently broken, because nothing ever
 * stopped trusting it. `onError()` must demote the pick and fall through to
 * the encrypted download.
 *
 * The runtime + mediaFiles are mocked at the module edge (native storage /
 * sockets); the hook, the resolver, the free-space probe and the error
 * classifier all run for real.
 */
import {renderHook, act, waitFor} from '@testing-library/react-native';

jest.mock('@utils/constants', () => ({API_BASE_URL: 'https://example.invalid'}));
jest.mock('expo-file-system/legacy', () => ({
  getFreeDiskStorageAsync: async () => 8 * 1024 * 1024 * 1024,
}));
jest.mock('expo-file-system', () => ({}));
jest.mock('@/modules/messenger/runtime/runtime', () => ({
  getMessengerRuntime: jest.fn(),
}));
jest.mock('@/modules/messenger/media/mediaFiles', () => ({
  statTempBytes:  jest.fn(),
  writeTempBytes: jest.fn(),
}));

import {
  useAttachmentUri,
  _resetAttachmentUriCache,
  type AttachmentMessageLike,
} from '@/modules/messenger/media/useAttachmentUri';
import {getMessengerRuntime} from '@/modules/messenger/runtime/runtime';
import {statTempBytes, writeTempBytes} from '@/modules/messenger/media/mediaFiles';
import {MediaHttpError} from '@/modules/messenger/media/mediaClient';
import {NoFreeSpaceError} from '@/modules/messenger/media/freeSpace';

const mockRuntime  = getMessengerRuntime as unknown as jest.Mock;
const mockStat     = statTempBytes as unknown as jest.Mock;
const mockWrite    = writeTempBytes as unknown as jest.Mock;
let downloadMedia: jest.Mock;

function received(id: string, extra: Partial<AttachmentMessageLike> = {}): AttachmentMessageLike {
  return {
    id,
    media_object_key: `att/${id}`,
    media_key:        `k-${id}`,
    media_iv:         `iv-${id}`,
    media_mime:       'image/jpeg',
    ...extra,
  };
}

beforeEach(() => {
  _resetAttachmentUriCache();
  downloadMedia = jest.fn(async () => new Uint8Array([1, 2, 3]));
  mockRuntime.mockReset().mockResolvedValue({downloadMedia});
  mockStat.mockReset().mockResolvedValue(null);
  mockWrite.mockReset().mockImplementation(
    async (_b: Uint8Array, _m: string, id: string) => `file:///caches/bravo-media-${id}.jpg`,
  );
});

describe('the load state machine', () => {
  it('auto:true runs the pipeline on mount and lands on ready', async () => {
    const {result} = renderHook(() => useAttachmentUri(received('auto'), {auto: true}));
    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(result.current.uri).toBe('file:///caches/bravo-media-auto.jpg');
    expect(result.current.errorReason).toBeNull();
    expect(downloadMedia).toHaveBeenCalledTimes(1);
  });

  /**
   * OBSERVED, and it contradicts the module header ("The hook is lazy by
   * default — pass `auto: true` to fetch on mount, or call `load()` on
   * demand"). The MEDIA-A3 fallback effect
   *
   *     if (!preferDirect && !uri && canDownload) {load();}
   *
   * cannot tell "the local pick just died" from "this message never had one",
   * so EVERY received attachment with key material auto-downloads on mount
   * regardless of `auto`. That is why the paging suite had to pass
   * `auto: false` AND pre-memoise every case — a download it did not want
   * started anyway and hung the suite.
   *
   * Pinned as-is because it is the shipped behaviour and the assertion below
   * is what a caller actually gets; not changed here (this is a coverage
   * task, and the effect is load-bearing for MEDIA-A3). If the laziness is
   * ever restored, this test goes red and should flip to the doc's contract.
   */
  it('a downloadable message loads on mount even WITHOUT auto (the doc says lazy; it is not)', async () => {
    const {result} = renderHook(() => useAttachmentUri(received('lazy')));
    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(downloadMedia).toHaveBeenCalledTimes(1);
  });

  it('a message with nothing to download DOES stay idle until asked', async () => {
    const msg = {id: 'idle-forever', media_mime: 'image/jpeg'} as AttachmentMessageLike;
    const {result} = renderHook(() => useAttachmentUri(msg));
    await act(async () => {});
    expect(result.current.state).toBe('idle');
    expect(result.current.uri).toBeNull();
    expect(mockRuntime).not.toHaveBeenCalled();
  });

  it('load() drives idle → loading → ready', async () => {
    const {result} = renderHook(() => useAttachmentUri(received('manual')));
    act(() => result.current.load());
    expect(result.current.state).toBe('loading');
    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(result.current.uri).toBe('file:///caches/bravo-media-manual.jpg');
  });

  it('a second load() while in flight does not start a second pipeline', async () => {
    const {result} = renderHook(() => useAttachmentUri(received('double')));
    act(() => { result.current.load(); result.current.load(); });
    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(downloadMedia).toHaveBeenCalledTimes(1);
  });

  it('a message with no key material is unavailable — and never touches the runtime', async () => {
    const msg = {id: 'bare', media_mime: 'image/jpeg'} as AttachmentMessageLike;
    const {result} = renderHook(() => useAttachmentUri(msg, {auto: true}));
    await waitFor(() => expect(result.current.state).toBe('error'));
    expect(result.current.errorReason).toBe('unavailable');
    expect(mockRuntime).not.toHaveBeenCalled();
  });

  it('a partially-populated row (key but no iv) is also unavailable, not a crash', async () => {
    const msg = received('partial', {media_iv: undefined});
    const {result} = renderHook(() => useAttachmentUri(msg, {auto: true}));
    await waitFor(() => expect(result.current.state).toBe('error'));
    expect(result.current.errorReason).toBe('unavailable');
  });
});

describe('media-parity M17 — the bubble must be able to say WHY', () => {
  it.each([
    ['403 (no grant)',      'forbidden',   () => new MediaHttpError(403, 'not_in_recipient_grant')],
    ['404 (swept off R2)',  'gone',        () => new MediaHttpError(404, 'NoSuchKey')],
    ['a dead network',      'offline',     () => new MediaHttpError(0, 'download network failure')],
    ['a full disk',         'no_space',    () => new NoFreeSpaceError(1, 0)],
    ['an unclassed 500',    'unavailable', () => new MediaHttpError(500, 'boom')],
  ])('%s → %s', async (_label, reason, mkError) => {
    downloadMedia.mockRejectedValue(mkError());
    const {result} = renderHook(() => useAttachmentUri(received(`cls-${reason}`), {auto: true}));
    await waitFor(() => expect(result.current.state).toBe('error'));
    expect(result.current.errorReason).toBe(reason);
    expect(result.current.uri).toBeNull();
  });

  it('a failed load is RETRYABLE — tap-to-retry actually re-runs the pipeline', async () => {
    downloadMedia.mockRejectedValueOnce(new MediaHttpError(0, 'download network failure'));
    const {result} = renderHook(() => useAttachmentUri(received('retryable')));
    act(() => result.current.load());
    await waitFor(() => expect(result.current.state).toBe('error'));
    expect(result.current.errorReason).toBe('offline');

    act(() => result.current.load());
    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(result.current.uri).toBe('file:///caches/bravo-media-retryable.jpg');
    expect(downloadMedia).toHaveBeenCalledTimes(2);
  });
});

describe('MEDIA-A3 — the sender own local pick', () => {
  const ownPick = (id: string) =>
    received(id, {media_url: 'content://media/external/images/media/77'});

  it('renders straight from the pick with no network at all', async () => {
    const {result} = renderHook(() => useAttachmentUri(ownPick('mine'), {auto: true}));
    expect(result.current.state).toBe('ready');
    expect(result.current.uri).toBe('content://media/external/images/media/77');
    await act(async () => {});
    expect(downloadMedia).not.toHaveBeenCalled();
  });

  it('load() is a no-op while the pick is still trusted', async () => {
    const {result} = renderHook(() => useAttachmentUri(ownPick('trusted')));
    act(() => result.current.load());
    await act(async () => {});
    expect(downloadMedia).not.toHaveBeenCalled();
    expect(result.current.uri).toBe('content://media/external/images/media/77');
  });

  it('THE BUG: a dead pick uri falls back to the encrypted download', async () => {
    // <Image> reported onError — the content:// grant died with the reboot.
    // Before MEDIA-A3 the sender's own photo stayed broken forever.
    const {result} = renderHook(() => useAttachmentUri(ownPick('revoked')));
    expect(result.current.uri).toBe('content://media/external/images/media/77');

    act(() => result.current.onError());
    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(result.current.uri).toBe('file:///caches/bravo-media-revoked.jpg');
    expect(downloadMedia).toHaveBeenCalledWith({
      objectKey: 'att/revoked', keyB64: 'k-revoked', ivB64: 'iv-revoked',
    });
  });

  it('a dead pick with NOTHING to download keeps showing the pick (no blanking)', async () => {
    // Nothing to fall back to: dropping the uri here would blank a bubble that
    // might still render, and would report a failure the user cannot act on.
    const msg = {id: 'nofallback', media_url: 'file:///tmp/local.jpg'} as AttachmentMessageLike;
    const {result} = renderHook(() => useAttachmentUri(msg));
    act(() => result.current.onError());
    await act(async () => {});
    expect(result.current.uri).toBe('file:///tmp/local.jpg');
    expect(result.current.state).toBe('ready');
  });

  it('the fallback survives a second onError (idempotent once demoted)', async () => {
    const {result} = renderHook(() => useAttachmentUri(ownPick('twice')));
    act(() => result.current.onError());
    await waitFor(() => expect(result.current.state).toBe('ready'));
    const settled = result.current.uri;
    act(() => result.current.onError());
    await act(async () => {});
    expect(result.current.uri).toBe(settled);
    expect(downloadMedia).toHaveBeenCalledTimes(1);
  });
});

describe('the warm path through the hook', () => {
  it('a decrypted temp file already on disk resolves without a download', async () => {
    mockStat.mockResolvedValue('file:///caches/bravo-media-warm.jpg');
    const {result} = renderHook(() => useAttachmentUri(received('warm'), {auto: true}));
    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(result.current.uri).toBe('file:///caches/bravo-media-warm.jpg');
    expect(downloadMedia).not.toHaveBeenCalled();
    expect(mockWrite).not.toHaveBeenCalled();
  });
});
