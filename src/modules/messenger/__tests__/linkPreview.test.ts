/**
 * Chat link previews — first coverage of ui/linkPreview.ts.
 *
 * The URL regex drives THREE live surfaces from one source (bubble link
 * spans via splitByUrls, the Links browser via allUrlsIn, the preview
 * card via firstUrlIn + getLinkPreview), so its edges are pinned here.
 * Two sharp edges are DOCUMENTED as current behaviour: the OG meta
 * regex only matches property-before-content attribute order (B-151),
 * and a transient fetch failure is cached as null for the app lifetime.
 */

import {
  allUrlsIn, firstUrlIn, getLinkPreview, splitByUrls,
  NEGATIVE_CACHE_MAX, negativeCacheSize,
} from '../ui/linkPreview';

describe('firstUrlIn', () => {
  it('finds the first http(s) URL', () => {
    expect(firstUrlIn('see https://a.example/x and http://b.example'))
      .toBe('https://a.example/x');
  });

  it('excludes trailing sentence punctuation', () => {
    expect(firstUrlIn('read https://a.example/page.')).toBe('https://a.example/page');
  });

  it('requires a scheme — bare domains are not linkified', () => {
    expect(firstUrlIn('visit example.com today')).toBeNull();
  });

  it.each([null, undefined, ''])('%p → null', t => {
    expect(firstUrlIn(t)).toBeNull();
  });
});

describe('allUrlsIn', () => {
  it('returns every URL in order', () => {
    expect(allUrlsIn('a https://one.example b http://two.example c'))
      .toEqual(['https://one.example', 'http://two.example']);
  });

  it('empty for plain text', () => {
    expect(allUrlsIn('no links here')).toEqual([]);
  });
});

describe('splitByUrls', () => {
  it('splits a mixed body into plain and url segments', () => {
    expect(splitByUrls('go to https://a.example/x now')).toEqual([
      {text: 'go to '},
      {text: 'https://a.example/x', url: 'https://a.example/x'},
      {text: ' now'},
    ]);
  });

  it('a url-only body yields a single tappable segment', () => {
    expect(splitByUrls('https://a.example')).toEqual([
      {text: 'https://a.example', url: 'https://a.example'},
    ]);
  });

  it('plain text passes through as one segment', () => {
    expect(splitByUrls('hello world')).toEqual([{text: 'hello world'}]);
  });

  it('two adjacent urls keep their separator text', () => {
    expect(splitByUrls('https://a.example https://b.example')).toEqual([
      {text: 'https://a.example', url: 'https://a.example'},
      {text: ' '},
      {text: 'https://b.example', url: 'https://b.example'},
    ]);
  });
});

describe('getLinkPreview', () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    (global as {fetch: unknown}).fetch = fetchMock;
  });

  const htmlResponse = (html: string, ok = true) => ({
    ok,
    body: undefined,               // RN-style fetch: no stream, text() fallback
    text: async () => html,
  });

  it('rejects non-http(s) URLs without fetching', async () => {
    await expect(getLinkPreview('ftp://a.example')).resolves.toBeNull();
    // eslint-disable-next-line no-script-url -- deliberately hostile input
    await expect(getLinkPreview('javascript:alert(1)')).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('parses OG tags, decodes entities, and resolves a relative image', async () => {
    fetchMock.mockResolvedValueOnce(htmlResponse(`
      <html><head>
        <title>Fallback</title>
        <meta property="og:title" content="Tom &amp; Jerry" />
        <meta property="og:description" content="A &quot;classic&quot;" />
        <meta property="og:image" content="/img/cover.png" />
        <meta property="og:site_name" content="Example" />
      </head></html>`));
    await expect(getLinkPreview('https://ex1.example/page')).resolves.toEqual({
      url:         'https://ex1.example/page',
      title:       'Tom & Jerry',
      description: 'A "classic"',
      image:       'https://ex1.example/img/cover.png',
      siteName:    'Example',
    });
  });

  it('falls back to <title> then host when OG tags are absent', async () => {
    fetchMock.mockResolvedValueOnce(htmlResponse(
      '<html><head><title>Just a title</title></head></html>'));
    const p = await getLinkPreview('https://ex2.example/a');
    expect(p?.title).toBe('Just a title');
    expect(p?.siteName).toBe('ex2.example');
  });

  it('a non-200 yields null', async () => {
    fetchMock.mockResolvedValueOnce(htmlResponse('', false));
    await expect(getLinkPreview('https://ex3.example')).resolves.toBeNull();
  });

  it('B-151 FIXED: content-before-property meta tags are matched', async () => {
    // Real-world markup frequently emits <meta content="…" property="og:title">.
    // Attribute order is not significant in HTML, so both spellings must win.
    fetchMock.mockResolvedValueOnce(htmlResponse(`
      <html><head>
        <title>Fallback Title</title>
        <meta content="The Real Title" property="og:title" />
      </head></html>`));
    const p = await getLinkPreview('https://ex4.example');
    expect(p?.title).toBe('The Real Title');
  });

  it('B-151 FIXED: content-first works for description, image and site_name too', async () => {
    fetchMock.mockResolvedValueOnce(htmlResponse(`
      <html><head>
        <meta content="Desc here" property="og:description" />
        <meta content="/cover.png" property="og:image" />
        <meta content="SiteName" property="og:site_name" />
        <meta content="Title here" name="twitter:title" />
      </head></html>`));
    const p = await getLinkPreview('https://ex7.example/a');
    expect(p?.description).toBe('Desc here');
    expect(p?.image).toBe('https://ex7.example/cover.png');
    expect(p?.siteName).toBe('SiteName');
    expect(p?.title).toBe('Title here');
  });

  it('B-151: property-first markup still wins (no regression)', async () => {
    fetchMock.mockResolvedValueOnce(htmlResponse(`
      <html><head>
        <title>Fallback</title>
        <meta property="og:title" content="Property First" />
      </head></html>`));
    const p = await getLinkPreview('https://ex8.example');
    expect(p?.title).toBe('Property First');
  });

  // B-151 pinned "a transient failure is never PERMANENT". B-157 keeps that
  // invariant but adds a bounded negative TTL, so the original assertion
  // (retry on the very next call) is UPDATED DELIBERATELY rather than deleted:
  // retrying on every view meant scrolling an offline chat spawned one doomed
  // 5s-timeout fetch per link bubble per pass. The property that mattered —
  // the link recovers once the network does — is still asserted below.
  describe('B-157 — bounded negative caching', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(0);
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it('does NOT refetch a failed URL within the TTL window', async () => {
      fetchMock.mockRejectedValueOnce(new Error('offline'));
      await expect(getLinkPreview('https://ex5a.example')).resolves.toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      jest.setSystemTime(30_000); // still inside the 60s window
      await expect(getLinkPreview('https://ex5a.example')).resolves.toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1); // no second doomed fetch
    });

    it('B-151 invariant preserved: the failure is never permanent', async () => {
      fetchMock.mockRejectedValueOnce(new Error('offline'));
      await expect(getLinkPreview('https://ex5b.example')).resolves.toBeNull();

      jest.setSystemTime(61_000); // past the TTL — network may be back
      fetchMock.mockResolvedValueOnce(htmlResponse('<title>Now reachable</title>'));
      const second = await getLinkPreview('https://ex5b.example');
      expect(second?.title).toBe('Now reachable');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('a SUCCESS is still cached for the app lifetime (no TTL on the happy path)', async () => {
      fetchMock.mockResolvedValueOnce(htmlResponse('<title>stable</title>'));
      await getLinkPreview('https://ex5c.example');
      jest.setSystemTime(10 * 60_000);
      const again = await getLinkPreview('https://ex5c.example');
      expect(again?.title).toBe('stable');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('the negative map cannot grow without bound', async () => {
      // Every distinct failing URL used to be a permanent Map entry. A chat full
      // of dead links must not turn the negative cache into a leak.
      fetchMock.mockRejectedValue(new Error('offline'));
      for (let i = 0; i < 300; i++) {
        await getLinkPreview(`https://leak${i}.example`);
      }
      expect(negativeCacheSize()).toBeLessThanOrEqual(NEGATIVE_CACHE_MAX);
    });
  });

  it('B-151: concurrent callers still share ONE in-flight fetch', async () => {
    // The eviction must not cost the de-dupe that keeps a scrolling chat
    // from hammering the same host.
    fetchMock.mockResolvedValue(htmlResponse('<title>shared</title>'));
    const [a, b] = await Promise.all([
      getLinkPreview('https://ex9.example'),
      getLinkPreview('https://ex9.example'),
    ]);
    expect(a?.title).toBe('shared');
    expect(b?.title).toBe('shared');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('memoises per exact URL — one fetch for repeat calls', async () => {
    fetchMock.mockResolvedValue(htmlResponse('<title>t</title>'));
    await getLinkPreview('https://ex6.example');
    await getLinkPreview('https://ex6.example');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
