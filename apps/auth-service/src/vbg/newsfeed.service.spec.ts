import {NewsFeedService} from './newsfeed.service';

const rss = (items: Array<{title: string; link: string; source?: string; pubDate?: string}>) =>
  `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Google News</title>${
    items.map(i =>
      `<item><title>${i.title}</title><link>${i.link}</link>` +
      `${i.pubDate ? `<pubDate>${i.pubDate}</pubDate>` : ''}` +
      `${i.source ? `<source url="https://x.example">${i.source}</source>` : ''}</item>`,
    ).join('')
  }</channel></rss>`;

// The feed enforces a rolling 72h window against REAL time, so fixtures must
// be freshness-relative — a stamped date would rot out of the window and turn
// every assertion vacuous within three days of writing it.
const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toUTCString();
const agoIso = (hours: number) => {
  const d = new Date(Date.now() - hours * 3_600_000);
  d.setMilliseconds(0);
  return d.toISOString();
};

describe('NewsFeedService', () => {
  let svc: NewsFeedService;
  const fetchMock = jest.fn();

  beforeEach(() => {
    svc = new NewsFeedService();
    global.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockReset();
  });

  it('fetches open + curated RSS per (country, category) pair with the right shapes', async () => {
    fetchMock.mockResolvedValue({ok: true, text: async () => rss([])});

    await svc.feed('AE,GLOBAL', 'top,business');

    const urls = fetchMock.mock.calls.map(c => decodeURIComponent(c[0] as string));
    // 4 pairs × 2 halves (AE and GLOBAL are both covered by the OSINT directory).
    expect(urls).toHaveLength(8);
    // AE top = everything ABOUT the country (name-scoped search), NEVER the
    // edition headline feed — that carries the world stories its readers see.
    expect(urls.some(u => u.includes('/rss/search') && u.includes('"UAE" when:72h') && u.includes('gl=AE'))).toBe(true);
    expect(urls.some(u => u.startsWith('https://news.google.com/rss?'))).toBe(false);
    // GLOBAL top = WORLD topic on the US edition.
    expect(urls.some(u => u.includes('/topic/WORLD') && u.includes('gl=US'))).toBe(true);
    // AE business = search scoped to articles ABOUT the country, 72h-pinned.
    expect(urls.some(u => u.includes('/rss/search') && u.includes('"UAE"') && u.includes('(business OR economy OR trade)') && u.includes('gl=AE') && u.includes('when:72h'))).toBe(true);
    // GLOBAL business = curated BUSINESS topic.
    expect(urls.some(u => u.includes('/topic/BUSINESS') && u.includes('gl=US'))).toBe(true);
    // Curated halves: site:-scoped to the outlet directory AND country-scoped —
    // a country's papers must contribute only stories about that country.
    expect(urls.some(u => u.includes('site:gulfnews.com') && u.includes('"UAE"') && u.includes('gl=AE') && u.includes('when:72h'))).toBe(true);
    // GLOBAL curated carries no country clause.
    expect(urls.some(u => u.includes('site:reuters.com') && !u.includes('"') && u.includes('gl=US') && u.includes('when:72h'))).toBe(true);
  });

  it('tags region + category, strips the outlet suffix, sorts newest first, dedups', async () => {
    const aeTop = rss([
      {title: 'DIFC volume record - Gulf News', link: 'https://a/1', source: 'Gulf News', pubDate: ago(3)},
      {title: 'Old story - Gulf News', link: 'https://a/2', source: 'Gulf News', pubDate: ago(20)},
    ]);
    const saTop = rss([
      // Same headline as AE row 1 → deduped across pairs.
      {title: 'DIFC volume record - Arab News', link: 'https://b/1', source: 'Arab News', pubDate: ago(4)},
      {title: 'Aramco earnings beat - Arab News', link: 'https://b/2', source: 'Arab News', pubDate: ago(2)},
    ]);
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve({ok: true, text: async () => (url.includes('gl=AE') ? aeTop : saTop)}));

    const {articles} = await svc.feed('AE,SA', 'top');

    expect(articles).toHaveLength(3);
    expect(articles[0].title).toBe('Aramco earnings beat');       // newest first
    expect(articles[0].region).toBe('SA');
    expect(articles[0].category).toBe('Top Stories');
    expect(articles[0].source).toBe('Arab News');
    expect(articles[0].published_at).toBe(agoIso(2));
    expect(articles.filter(a => a.title === 'DIFC volume record')).toHaveLength(1);
    expect(articles.find(a => a.title === 'DIFC volume record')?.region).toBe('AE');
  });

  it('drops articles older than 72h — and undated ones, whose freshness cannot be proven', async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve({ok: true, text: async () => (url.includes('gl=AE') ? rss([
        {title: 'Fresh enough - Gulf News', link: 'https://a/1', source: 'Gulf News', pubDate: ago(71)},
        {title: 'Three days stale - Gulf News', link: 'https://a/2', source: 'Gulf News', pubDate: ago(80)},
        {title: 'Undated mystery - Gulf News', link: 'https://a/3', source: 'Gulf News'},
      ]) : rss([]))}));

    const {articles} = await svc.feed('AE', 'top');

    expect(articles.map(a => a.title)).toEqual(['Fresh enough']);
  });

  it('covers newly added countries: ZA search names South Africa + curated News24', async () => {
    fetchMock.mockResolvedValue({ok: true, text: async () => rss([])});

    await svc.feed('ZA', 'security');

    const urls = fetchMock.mock.calls.map(c => decodeURIComponent(c[0] as string));
    expect(urls.some(u => u.includes('"South Africa"') && u.includes('gl=ZA'))).toBe(true);
    // Curated half is BOTH outlet- and country-scoped (B-349).
    expect(urls.some(u => u.includes('site:news24.com') && u.includes('"South Africa"') && u.includes('gl=ZA'))).toBe(true);
  });

  it('caps the pair fan-out at 12 pairs (≤ 24 fetches with curated halves)', async () => {
    fetchMock.mockResolvedValue({ok: true, text: async () => rss([])});
    await svc.feed('AE,SA,QA,GB,US', 'top,business,finance,security,energy,aviation');
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(24);
  });

  it('drops unknown tokens and falls back to defaults on garbage input', async () => {
    fetchMock.mockResolvedValue({ok: true, text: async () => rss([])});
    await svc.feed('ZZZZ,<script>', 'nonsense');
    // Defaults: GLOBAL × top → the WORLD-topic fetch + the curated global half.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map(c => decodeURIComponent(c[0] as string));
    expect(urls.some(u => u.includes('/topic/WORLD'))).toBe(true);
    expect(urls.some(u => u.includes('site:reuters.com'))).toBe(true);
  });

  it('never throws: a failing pair degrades to the others', async () => {
    const saTop = rss([{title: 'Only story - Arab News', link: 'https://b/9', source: 'Arab News', pubDate: ago(1)}]);
    fetchMock.mockImplementation((url: string) =>
      url.includes('gl=AE')
        ? Promise.reject(new Error('timeout'))
        : Promise.resolve({ok: true, text: async () => saTop}));

    const {articles} = await svc.feed('AE,SA', 'top');
    expect(articles).toHaveLength(1);
    expect(articles[0].region).toBe('SA');
  });

  it('worldMap sweeps every continent with the requested category, cached per category', async () => {
    // Distinct titles per URL so cross-country dedupe keeps items apart.
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve({ok: true, text: async () => rss([
        {title: `Story ${url.slice(-24)} - S`, link: `https://x/${url.length}${url.slice(-8)}`, source: 'S', pubDate: ago(1)},
      ])}));

    const {articles} = await svc.worldMap('security');

    const urls = fetchMock.mock.calls.map(c => decodeURIComponent(c[0] as string));
    // Spread hits Africa, Asia, Europe, Americas, Oceania — category-scoped.
    for (const gl of ['gl=ZA', 'gl=NG', 'gl=JP', 'gl=ID', 'gl=DE', 'gl=BR', 'gl=AU']) {
      expect(urls.some(u => u.includes(gl))).toBe(true);
    }
    expect(urls.some(u => u.includes('(security OR crime OR police)'))).toBe(true);
    // Breadth: at least one story per spread country survives.
    expect(articles.length).toBeGreaterThanOrEqual(35);
    expect(new Set(articles.map(a => a.region)).size).toBeGreaterThanOrEqual(35);

    const calls = fetchMock.mock.calls.length;
    await svc.worldMap('security');
    expect(fetchMock.mock.calls.length).toBe(calls); // assembled sweep cached
  });

  it('caches per pair within the TTL — one upstream round for repeat feeds', async () => {
    fetchMock.mockResolvedValue({ok: true, text: async () => rss([])});
    await svc.feed('AE', 'top');
    const first = fetchMock.mock.calls.length;
    await svc.feed('AE', 'top');
    expect(fetchMock.mock.calls.length).toBe(first); // no new upstream fetches
    expect(first).toBe(2); // open + curated half, fetched once each
  });
});
