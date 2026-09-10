import {GoogleNewsService} from './googlenews.service';

// Minimal Google News RSS payload: two items (one a real incident, one benign),
// CDATA + entities + a wrapped <source>, plus an item missing a link (dropped).
const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Google News</title>
  <item>
    <title>Armed robbery at Dhaka jewellery shop &amp; two injured - The Daily Star</title>
    <link>https://thedailystar.net/news/robbery-1</link>
    <guid>g1</guid>
    <pubDate>Fri, 20 Jun 2026 05:18:16 GMT</pubDate>
    <source url="https://thedailystar.net">The Daily Star</source>
  </item>
  <item>
    <title><![CDATA[Dhaka stock market rally continues amid optimism - bdnews24]]></title>
    <link>https://bdnews24.com/business/rally-1</link>
    <pubDate>Fri, 20 Jun 2026 04:00:00 GMT</pubDate>
    <source url="https://bdnews24.com">bdnews24</source>
  </item>
  <item>
    <title>No link here - Outlet</title>
    <pubDate>Fri, 20 Jun 2026 03:00:00 GMT</pubDate>
  </item>
</channel></rss>`;

describe('GoogleNewsService', () => {
  let svc: GoogleNewsService;
  const fetchMock = jest.fn();

  beforeEach(() => {
    svc = new GoogleNewsService();
    global.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockReset();
  });

  it('parses RSS, classifies severity, and scopes the query by place + country edition', async () => {
    fetchMock.mockResolvedValueOnce({ok: true, text: async () => RSS});

    const items = await svc.threatsForArea(['Narayanganj', 'Dhaka'], 'BD');

    // The benign market-rally item is still returned (it's news), but classified
    // as 'information'; the robbery is 'critical'. The link-less item is dropped.
    expect(items).toHaveLength(2);
    const robbery = items.find(i => i.url === 'https://thedailystar.net/news/robbery-1');
    expect(robbery?.severity).toBe('critical');
    expect(robbery?.source).toBe('The Daily Star');
    expect(robbery?.title).toContain('Armed robbery'); // entity decoded, headline intact
    const rally = items.find(i => i.url === 'https://bdnews24.com/business/rally-1');
    expect(rally?.severity).toBe('information'); // SAFE_CONTEXT: stock market rally

    // Query scoped to the place names + the BD edition (hl/gl/ceid).
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('news.google.com/rss/search');
    expect(url).toContain('gl=BD');
    expect(url).toContain('ceid=BD:en');
    expect(decodeURIComponent(url)).toContain('"Narayanganj" OR "Dhaka"');
  });

  it('returns [] (never throws) when the place scope is empty', async () => {
    const items = await svc.threatsForArea([], 'BD');
    expect(items).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns [] on a non-OK response', async () => {
    fetchMock.mockResolvedValueOnce({ok: false, status: 429, text: async () => ''});
    const items = await svc.threatsForArea(['Dhaka'], 'BD');
    expect(items).toEqual([]);
  });

  it('caches per (country|place) within the TTL — one fetch for repeat calls', async () => {
    fetchMock.mockResolvedValue({ok: true, text: async () => RSS});
    await svc.threatsForArea(['Dhaka'], 'BD');
    await svc.threatsForArea(['Dhaka'], 'BD');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('curated-domain variant adds the site: clause, pins when:72h, and caches separately', async () => {
    fetchMock.mockResolvedValue({ok: true, text: async () => RSS});
    await svc.threatsForArea(['Dhaka'], 'BD');
    await svc.threatsForArea(['Dhaka'], 'BD', ['thedailystar.net', 'bdnews24.com']);
    // Different cache keys — the curated call must not serve the open result.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const open    = decodeURIComponent(fetchMock.mock.calls[0][0] as string);
    const curated = decodeURIComponent(fetchMock.mock.calls[1][0] as string);
    expect(open).not.toContain('site:');
    expect(open).toContain('when:72h');
    expect(curated).toContain('(site:thedailystar.net OR site:bdnews24.com)');
    expect(curated).toContain('when:72h');
  });
});
