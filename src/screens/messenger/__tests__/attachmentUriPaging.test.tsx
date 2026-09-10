/**
 * B-296 — the image viewer paged to a new message and kept showing the old photo.
 *
 * Founder, after the blank was fixed: "i sweep but it stay at the saem image
 * now the blank is gone but it is not going left or right".
 *
 * `useAttachmentUri` seeds `uri`, `state` and `preferDirect` with `useState`
 * INITIALISERS and latches `startedRef` after the first load — all first-mount
 * only. That was correct while the sole caller was a message bubble, where one
 * hook instance sees exactly one message for its entire life. The full-screen
 * viewer pages between photos on a MOUNTED component, so the hook kept handing
 * back the FIRST photo's uri forever and `load()` early-returned on the latched
 * ref.
 *
 * This is a BEHAVIOURAL test, deliberately. The previous three bugs in this
 * feature were all shipped behind green source scans and unit tests that
 * invented their own inputs; the thing none of them did was re-render the hook
 * with a different message, which is the entire bug. So: render, change the
 * prop, assert what the caller actually receives.
 */
import {renderHook} from '@testing-library/react-native';

import {
  useAttachmentUri,
  seedResolvedAttachmentUri,
} from '@/modules/messenger/media/useAttachmentUri';

jest.mock('@utils/constants', () => ({API_BASE_URL: 'https://example.invalid'}));
// The hook imports the runtime at module scope, which reaches op-sqlite's native
// module. Stubbed at the native boundary rather than mocking the hook's own
// collaborators — every uri in these cases is memoised or a local pick, so the
// download path is never entered and stubbing it cannot mask the behaviour
// under test.
jest.mock('@op-engineering/op-sqlite', () => ({open: jest.fn()}));
// react-native-fs ships untranspiled Flow, which this project's transform does
// not process. Only reached by the download path, which these cases never take.
jest.mock('react-native-fs', () => ({
  exists: jest.fn(async () => false),
  stat: jest.fn(async () => ({size: 0})),
  writeFile: jest.fn(async () => undefined),
  unlink: jest.fn(async () => undefined),
  CachesDirectoryPath: '/tmp',
}));

type Msg = Parameters<typeof useAttachmentUri>[0];

/** A received photo: no local pick, so it resolves through the memo/download. */
function received(id: string): Msg {
  return {
    id,
    media_object_key: `obj-${id}`,
    media_key: 'k',
    media_iv: 'iv',
    media_mime: 'image/jpeg',
  } as unknown as Msg;
}

/** A photo the SENDER picked locally — served straight from media_url. */
function ownPick(id: string, uri: string): Msg {
  return {id, media_url: uri, media_mime: 'image/jpeg'} as unknown as Msg;
}

describe('B-296 — the hook must follow the message it is given', () => {
  it('THE BUG: swapping the message swaps the uri', () => {
    // Both photos are already decrypted — the normal case, because every photo
    // visible in the thread was resolved by its bubble. Paging between them must
    // be instant, and must actually CHANGE.
    seedResolvedAttachmentUri('p1', 'file:///tmp/p1.jpg');
    seedResolvedAttachmentUri('p2', 'file:///tmp/p2.jpg');

    // `auto: false` throughout: every uri here is already memoised, so no load
    // is needed, and leaving auto on would fire a download against a stubbed
    // runtime that never settles (it hung the suite, not the code).
    const {result, rerender} = renderHook(
      ({msg}: {msg: Msg}) => useAttachmentUri(msg, {auto: false}),
      {initialProps: {msg: received('p1')}},
    );
    expect(result.current.uri).toBe('file:///tmp/p1.jpg');

    rerender({msg: received('p2')});
    // Before the fix this stayed on p1 forever: same instance, so the useState
    // initialiser never re-ran and startedRef was still latched.
    expect(result.current.uri).toBe('file:///tmp/p2.jpg');

    // And back again — paging is bidirectional.
    rerender({msg: received('p1')});
    expect(result.current.uri).toBe('file:///tmp/p1.jpg');
  });

  it('reports NOT-ready for a message whose bytes are not resolved yet', () => {
    // The viewer relies on this to hold the previous photo instead of blanking.
    // If the hook wrongly reported the OLD uri as ready for the NEW message, the
    // viewer would latch that pair and show the wrong picture — which is exactly
    // what the founder saw.
    seedResolvedAttachmentUri('warm', 'file:///tmp/warm.jpg');
    const {result, rerender} = renderHook(
      ({msg}: {msg: Msg}) => useAttachmentUri(msg, {auto: false}),
      {initialProps: {msg: received('warm')}},
    );
    expect(result.current.uri).toBe('file:///tmp/warm.jpg');

    rerender({msg: received('cold-never-seen')});
    expect(result.current.uri).toBeNull();
    expect(result.current.state).not.toBe('ready');
  });

  it('follows a switch from a received photo to the sender own local pick', () => {
    // `preferDirect` is also seeded once. Without the reset, paging onto a photo
    // this device sent would keep serving the previous one.
    seedResolvedAttachmentUri('recv', 'file:///tmp/recv.jpg');
    const {result, rerender} = renderHook(
      ({msg}: {msg: Msg}) => useAttachmentUri(msg, {auto: false}),
      {initialProps: {msg: received('recv')}},
    );
    expect(result.current.uri).toBe('file:///tmp/recv.jpg');

    rerender({msg: ownPick('mine', 'file:///tmp/mine.jpg')});
    expect(result.current.uri).toBe('file:///tmp/mine.jpg');
  });

  it('and back from a local pick to a received photo', () => {
    seedResolvedAttachmentUri('recv2', 'file:///tmp/recv2.jpg');
    const {result, rerender} = renderHook(
      ({msg}: {msg: Msg}) => useAttachmentUri(msg, {auto: false}),
      {initialProps: {msg: ownPick('mine2', 'file:///tmp/mine2.jpg')}},
    );
    expect(result.current.uri).toBe('file:///tmp/mine2.jpg');

    rerender({msg: received('recv2')});
    expect(result.current.uri).toBe('file:///tmp/recv2.jpg');
  });

  it('re-rendering with the SAME message changes nothing', () => {
    // The reset must key on identity, not fire on every render — otherwise every
    // bubble re-render would drop a resolved uri and re-download.
    seedResolvedAttachmentUri('same', 'file:///tmp/same.jpg');
    const msg = received('same');
    const {result, rerender} = renderHook(
      ({m}: {m: Msg}) => useAttachmentUri(m, {auto: false}),
      {initialProps: {m: msg}},
    );
    const first = result.current.uri;
    rerender({m: msg});
    rerender({m: received('same')});   // new object, same id
    expect(result.current.uri).toBe(first);
    expect(result.current.state).toBe('ready');
  });

  it('a photo resolved LATER is picked up when paged back to', () => {
    // Mirrors the real sequence: page onto a cold photo, its bytes land while
    // the user looks at something else, page back — it must now be ready rather
    // than still reporting the stale null.
    const {result, rerender} = renderHook(
      ({msg}: {msg: Msg}) => useAttachmentUri(msg, {auto: false}),
      {initialProps: {msg: received('late')}},
    );
    expect(result.current.uri).toBeNull();

    seedResolvedAttachmentUri('late', 'file:///tmp/late.jpg');
    rerender({msg: received('late-other')});
    rerender({msg: received('late')});
    expect(result.current.uri).toBe('file:///tmp/late.jpg');
    expect(result.current.state).toBe('ready');
  });
});
