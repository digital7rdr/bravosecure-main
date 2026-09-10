/**
 * sqa.md bug register — this suite pins: B-411 (lane-wiring half).
 *
 * Source scan: every notification lane must compose its title through the
 * ONE rule (notifTitle.ts) — a lane quietly reverted to the raw persisted
 * `name` re-leaks the `Bravo · <hex>` placeholder on exactly one path,
 * which no unit test with a well-named fixture would notice.
 *
 * POSITIVE anchors only (per the repo's source-scan rules: absence
 * assertions over stripped comments have burned sessions; a reverted line
 * makes a positive pin fail loudly). Anchored on the shape the code uses.
 */
import * as fs from 'fs';
import * as path from 'path';

const read = (...segs: string[]): string =>
  fs.readFileSync(path.join(__dirname, '..', ...segs), 'utf8');

describe('B-411 — notification lanes route titles through the one rule', () => {
  it('killed/headless lane titles from bannerTitle, both branches', () => {
    const src = read('push', 'fcmHeadless.ts');
    expect(src).toMatch(/title = \(await resolveConversationMeta\(convId\)\)\?\.bannerTitle/);
    expect(src).toMatch(/title = resolved\?\.bannerTitle/);
  });

  it('warm notifier-down lane titles from bannerTitle', () => {
    const src = read('push', 'fcmBootstrap.ts');
    expect(src).toMatch(/title: resolved\?\.bannerTitle/);
  });

  it('store-notifier lane composes via resolveNotifTitle', () => {
    const src = read('push', 'backgroundMessageNotifier.ts');
    expect(src).toMatch(/resolveNotifTitle\(\{/);
    expect(src).toMatch(/from '\.\.\/contacts\/notifTitle'/);
  });

  it('the persisted-vault resolvers launder through resolveNotifTitle (call labels + tap params included)', () => {
    const src = read('push', 'mutedLookup.ts');
    const hits = src.match(/resolveNotifTitle\(\{/g) ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(2); // direct + meta resolvers
  });

  it('the placeholder minters stamp their provenance', () => {
    const src = read('store', 'messengerStore.ts');
    const stamps = src.match(/name_source: {3}'placeholder'|name_source: {4}'placeholder'/g) ?? [];
    expect(stamps.length).toBeGreaterThanOrEqual(2); // helper + inline shadow-create
  });

  it('openMemberChat never persists the display fallback — it seeds the healable placeholder shape (critic MAJOR-1)', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'screens', 'messenger', 'ChatInfoScreen.tsx'), 'utf8');
    // The guard: the 'Bravo user' label is display-only; the vault gets the
    // `Bravo · <hex>` form (which useRegisteredNames can upgrade) instead.
    expect(src).toMatch(/const isDisplayFallback = name === FALLBACK_MEMBER_LABEL/);
    expect(src).toMatch(/isDisplayFallback \? `Bravo · \$\{userId\.slice\(0, 8\)\}` : name/);
    expect(src).toMatch(/isDisplayFallback \? \{name_source: 'placeholder' as const\} : null/);
  });
});
