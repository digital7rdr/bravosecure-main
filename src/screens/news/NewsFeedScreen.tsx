import React, {useCallback, useRef, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView,
  TouchableOpacity, StatusBar, Linking, RefreshControl,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Imagery} from '@theme/imagery';
import ImageryBackdrop from '@components/ui/ImageryBackdrop';
import {Colors} from '@theme/index';
import LoadingView from '@components/LoadingView';
import {scaleTextStyles} from '@utils/scaling';
import {newsApi} from '@services/api';
import {goBackOnce} from '@navigation/tapGuard';
import {categoryLabel, countryLabel, loadNewsPrefs, type NewsPrefs} from '@modules/news/newsPrefs';
import {ShareNewsSheet, type ShareableNews} from '@modules/news/ShareNewsSheet';

// Chip filter: 'ALL', a country code ('c:AE'), or a category id ('k:business').
type Filter = string;

interface Article {
  id: string;
  featured: boolean;
  cat: string; catColor: string; region: string; regionColor: string;
  icon: string; iconColor: string;
  title: string; summary: string; url: string;
  source: string; time: string; publishedMs: number; filter: string;
}

const CAT_ICON: Record<string, {icon: string; color: string}> = {
  'top stories': {icon: 'newspaper-variant', color: '#374151'},
  'world':       {icon: 'earth',        color: '#164E63'},
  'business':    {icon: 'briefcase',    color: '#1D4ED8'},
  'finance':     {icon: 'bank',         color: '#374151'},
  'security':    {icon: 'shield-alert', color: '#7F1D1D'},
  'technology':  {icon: 'laptop',       color: '#164E63'},
  'energy':      {icon: 'lightning-bolt', color: '#92400E'},
  'defence':     {icon: 'shield-star',  color: '#7F1D1D'},
  'aviation':    {icon: 'airplane',     color: '#1D4ED8'},
  'real estate': {icon: 'city',         color: '#1D4ED8'},
};

// Compact chip text for country codes (badge text elsewhere stays the code).
const COUNTRY_CHIP: Record<string, string> = {GLOBAL: 'GLOBAL', AE: 'UAE', SA: 'KSA', GB: 'UK'};

function relativeTime(ms: number): string {
  if (!ms) {return '';}
  const delta = Date.now() - ms;
  if (!Number.isFinite(delta) || delta < 0) {return '';}
  const h = Math.floor(delta / 3_600_000);
  if (h < 1) {return 'just now';}
  if (h < 24) {return `${h} hr${h > 1 ? 's' : ''} ago`;}
  return `${Math.floor(h / 24)}d ago`;
}

// Map a /news/feed row into the card shape this screen renders.
function toArticle(r: Record<string, unknown>, i: number): Article {
  const cat = String(r.category ?? 'News');
  const region = String(r.region ?? 'GLOBAL').toUpperCase();
  const ci = CAT_ICON[cat.toLowerCase()] ?? {icon: 'newspaper-variant', color: '#374151'};
  const publishedMs = Date.parse(String(r.published_at ?? '')) || 0;
  return {
    id: String(r.id ?? `n${i}`),
    featured: i === 0,
    cat, catColor: '#2563EB', region, regionColor: '#60A5FA',
    icon: ci.icon, iconColor: ci.color,
    title: String(r.title ?? 'Untitled'),
    summary: String(r.summary ?? ''),
    url: typeof r.url === 'string' ? r.url : '',
    source: String(r.source ?? 'Bravo News'),
    time: relativeTime(publishedMs),
    publishedMs,
    filter: region,
  };
}

function openArticle(url: string): void {
  if (url) {Linking.openURL(url).catch(() => {});}
}

const BREAKING_WINDOW_MS = 3 * 3_600_000;

export default function NewsFeedScreen() {
  const insets = useSafeAreaInsets();
  // B-98b G1 — pushed from both NewsNavigator and MessengerNavigator with no
  // visible way back (header only had filter/RSS); goBack pops to the pusher.
  const navigation = useNavigation<{goBack: () => void; navigate: (r: 'NewsPreferences') => void}>();
  const [filter, setFilter] = useState<Filter>('ALL');
  const [breakingDismissed, setBreakingDismissed] = useState(false);
  const [articles, setArticles] = useState<Article[]>([]);
  const [prefs, setPrefs] = useState<NewsPrefs | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const prefsKeyRef = useRef('');
  // Founder 2026-08-05 — share a headline into a Bravo chat/group.
  const [shareItem, setShareItem] = useState<ShareableNews | null>(null);
  // B-656 - stable, so React.memo(ShareNewsSheet) can actually bail out.
  const closeShare = useCallback(() => setShareItem(null), []);
  const shareArticle = useCallback(
    (a: Article) => setShareItem({title: a.title, url: a.url, source: a.source}),
    [],
  );

  const fetchFeed = useCallback(async (p: NewsPrefs) => {
    try {
      const {data} = await newsApi.getFeed({
        countries: p.countries.join(','),
        categories: p.categories.join(','),
      });
      const rows = Array.isArray(data?.articles) ? data.articles : [];
      setArticles(rows.map(toArticle));
    } catch {
      setArticles([]);
    }
  }, []);

  // Reload prefs every time the screen gains focus — a save on the
  // Preferences screen must retune the feed on the way back.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void loadNewsPrefs().then(async p => {
        if (cancelled) {return;}
        const key = `${p.countries.join(',')}|${p.categories.join(',')}`;
        const changed = key !== prefsKeyRef.current;
        prefsKeyRef.current = key;
        setPrefs(p);
        if (changed) {
          setFilter('ALL');
          setLoading(true);
          await fetchFeed(p);
          if (!cancelled) {setLoading(false);}
        }
      });
      return () => { cancelled = true; };
    }, [fetchFeed]),
  );

  const onRefresh = useCallback(async () => {
    if (!prefs) {return;}
    setRefreshing(true);
    await fetchFeed(prefs);
    setRefreshing(false);
  }, [prefs, fetchFeed]);

  const chips: Array<{key: Filter; label: string}> = [
    {key: 'ALL', label: 'ALL'},
    ...(prefs?.countries ?? []).map(c => ({key: `c:${c}`, label: COUNTRY_CHIP[c] ?? c})),
    ...(prefs?.categories ?? []).map(k => ({key: `k:${k}`, label: k === 'top' ? 'TOP' : categoryLabel(k).toUpperCase()})),
  ];

  const visible = articles.filter(a => {
    if (filter === 'ALL') {return true;}
    if (filter.startsWith('c:')) {return a.region === filter.slice(2);}
    return a.cat === categoryLabel(filter.slice(2));
  });
  const featured = visible[0];
  const pool = visible.slice(1);
  const isAll = filter === 'ALL';
  const isCountry = filter.startsWith('c:');

  // ALL view: each chosen region headlines its top-2 stories (feed order is
  // freshness+rank, so the first two are the strongest proxy for most-read),
  // with VIEW ALL jumping into that region's full feed.
  const regionSections = isAll && prefs
    ? prefs.countries
        .map(code => ({
          code,
          label: code === 'GLOBAL' ? 'Global' : countryLabel(code),
          items: pool.filter(a => a.region === code).slice(0, 2),
        }))
        .filter(s => s.items.length > 0)
    : [];
  const sectionIds = new Set(regionSections.flatMap(s => s.items.map(a => a.id)));
  const remaining = isAll ? pool.filter(a => !sectionIds.has(a.id)) : pool;

  // Region view: everything about the country, grouped by the user's
  // categories (political, financial, security, …) in preference order.
  const catGroups = isCountry && prefs
    ? prefs.categories
        .map(k => ({label: categoryLabel(k), items: pool.filter(a => a.cat === categoryLabel(k))}))
        .filter(g => g.items.length > 0)
    : [];

  // Breaking strip = the newest story only while it is actually fresh.
  const newest = articles[0];
  const breaking = !breakingDismissed && newest && newest.publishedMs > 0 &&
    Date.now() - newest.publishedMs < BREAKING_WINDOW_MS ? newest : null;

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.headerBtn}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
          onPress={() => goBackOnce(navigation)}>
          <Icon name="chevron-left" size={22} color="#94A3B8" />
        </TouchableOpacity>
        <View style={{flex: 1, minWidth: 0, marginLeft: 10}}>
          <Text style={styles.headerSub}>Bravo News Channel</Text>
          <View style={styles.headerTitleRow}>
            <Text style={styles.headerTitle} numberOfLines={1}>Regional News Feed</Text>
            <View style={styles.liveBadge}>
              <View style={styles.liveDot} />
              <Text style={styles.liveBadgeText}>LIVE</Text>
            </View>
          </View>
        </View>
        <View style={styles.headerBtns}>
          <TouchableOpacity
            style={styles.headerBtn}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="News preferences"
            hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
            onPress={() => navigation.navigate('NewsPreferences')}>
            <Icon name="tune-variant" size={20} color="#94A3B8" />
          </TouchableOpacity>
        </View>
      </View>

      {/* NEWS FILTER moved to the News hub (founder 2026-08-09) — it now sits
          above both feed cards there, so preferences are set BEFORE choosing a
          feed rather than one level inside it. The header tune icon remains as
          the in-context shortcut. */}

      {/* Breaking ticker — only a genuinely fresh top story, never canned copy */}
      {breaking && (
        <View style={styles.breakingWrap}>
          <View style={styles.breakingInner}>
            <View style={styles.breakingBadge}>
              <Text style={styles.breakingBadgeText}>Breaking</Text>
            </View>
            <Text style={styles.breakingText} numberOfLines={1}>{breaking.title}</Text>
            <TouchableOpacity style={styles.breakingRead} activeOpacity={0.7} onPress={() => openArticle(breaking.url)}>
              <Text style={styles.breakingReadText}>Read →</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setBreakingDismissed(true)} activeOpacity={0.7}>
              <Icon name="close" size={16} color="#475569" />
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Filter chips — built from the saved country/category preferences */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false}
        style={styles.filterScroll} contentContainerStyle={styles.filterContent}>
        {chips.map(c => (
          <TouchableOpacity key={c.key}
            style={[styles.chip, filter === c.key && styles.chipActive]}
            onPress={() => setFilter(c.key)} activeOpacity={0.7}>
            <Text style={[styles.chipText, filter === c.key && styles.chipTextActive]}>{c.label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Feed */}
      <ScrollView style={styles.feedScroll} showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => { void onRefresh(); }}
            tintColor={Colors.primary} colors={[Colors.primary]} />
        }
        contentContainerStyle={[styles.content, {paddingBottom: insets.bottom + 88}]}>

        {loading && (
          <View style={{paddingVertical: 48, alignItems: 'center'}}>
            <LoadingView compact label="Loading news…" />
          </View>
        )}
        {!loading && visible.length === 0 && (
          <View style={{paddingVertical: 48, alignItems: 'center', gap: 8, paddingHorizontal: 32,
            borderRadius: 16, overflow: 'hidden', marginBottom: 16}}>
            <ImageryBackdrop source={Imagery.newsRegionalFeed} variant="hero" radius={16} />
            <Icon name="newspaper-variant-outline" size={34} color="#334155" />
            <Text style={{fontSize: 15, fontWeight: '700', color: '#F1F5F9'}}>No news yet</Text>
            <Text style={{fontSize: 12.5, color: '#64748B', textAlign: 'center'}}>
              Pull to refresh, or tune your countries and categories from the preferences button above.
            </Text>
          </View>
        )}

        {/* Featured hero card */}
        {featured && (
          <TouchableOpacity style={styles.heroCard} activeOpacity={0.9} onPress={() => openArticle(featured.url)}>
            <ImageryBackdrop source={Imagery.proRiskIntel} variant="hero" radius={16} />
            {/* Identity area — founder 2026-08-04: no link-preview photos (they
                resolved to aggregator logos, not real imagery). The designed
                category-icon ambient + badges carry the card instead. */}
            <View style={styles.heroImg}>
              <Icon name={featured.icon} size={80} color={featured.iconColor} style={styles.heroImgIcon} />
              <View style={styles.heroImgOverlay} />
              <View style={styles.heroBadges}>
                <View style={[styles.catBadge, {backgroundColor: featured.catColor + 'DD'}]}>
                  <Text style={styles.catBadgeText}>{featured.cat.toUpperCase()}</Text>
                </View>
                <View style={[styles.catBadge, {backgroundColor:'rgba(34,197,94,0.85)'}]}>
                  <Text style={styles.catBadgeText}>FEATURED</Text>
                </View>
              </View>
            </View>
            <View style={styles.heroBody}>
              <Text style={styles.heroTitle}>{featured.title}</Text>
              <View style={styles.heroMeta}>
                <Text style={styles.heroMetaText}>
                  <Text style={styles.heroSource}>{featured.source}</Text>
                  {featured.time ? ` · ${featured.time}` : ''}{' · '}{featured.region}
                </Text>
              </View>
              {!!featured.summary && (
                <Text style={styles.heroSummary} numberOfLines={2}>{featured.summary}</Text>
              )}
              {/* Founder 2026-08-05 — "all of them should have share option",
                  so the featured hero gets one too, not just the list rows. */}
              <View style={styles.heroActions}>
                <View style={styles.readBtn}>
                  <Text style={styles.readBtnText}>READ →</Text>
                </View>
                {featured.url ? (
                  <TouchableOpacity
                    style={styles.heroShareBtn}
                    onPress={() => shareArticle(featured)}
                    hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
                    accessibilityRole="button"
                    accessibilityLabel={`Share: ${featured.title}`}>
                    <Icon name="share-variant" size={14} color="#5B8DEF" />
                    <Text style={styles.heroShareText}>SHARE</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            </View>
          </TouchableOpacity>
        )}

        {/* ALL view — each chosen region headlines its top-2 stories */}
        {regionSections.map(s => (
          <View key={s.code} style={styles.regionSection}>
            <TouchableOpacity style={styles.regionHead} activeOpacity={0.7} onPress={() => setFilter(`c:${s.code}`)}>
              {s.code === 'GLOBAL' ? (
                <Icon name="earth" size={14} color="#60A5FA" />
              ) : (
                <View style={styles.regionHeadTag}>
                  <Text style={styles.regionHeadTagText}>{s.code}</Text>
                </View>
              )}
              <Text style={styles.regionHeadLabel} numberOfLines={1}>{s.label}</Text>
              <Text style={styles.regionHeadHint}>TOP STORIES</Text>
              <Text style={styles.viewAllText}>VIEW ALL →</Text>
            </TouchableOpacity>
            {s.items.map(article => <ArticleRow key={article.id} article={article} onShare={shareArticle} />)}
          </View>
        ))}
        {isAll && remaining.length > 0 && (
          <Text style={styles.flatListLabel}>ALL UPDATES</Text>
        )}

        {/* Region view — all of the country's news, grouped by category */}
        {catGroups.map(g => (
          <View key={g.label} style={styles.regionSection}>
            <Text style={styles.catGroupLabel}>{g.label}</Text>
            {g.items.map(article => <ArticleRow key={article.id} article={article} onShare={shareArticle} />)}
          </View>
        ))}

        {/* Flat list (ALL remainder / category filters) */}
        {!isCountry && remaining.map(article => <ArticleRow key={article.id} article={article} onShare={shareArticle} />)}
      </ScrollView>

      <ShareNewsSheet item={shareItem} onClose={closeShare} />
    </View>
  );
}

/**
 * B-655 — MEMOISED. `shareItem` state lives at the screen root, so tapping
 * Share re-renders `NewsFeedScreen`, and this feed is a plain `ScrollView` over
 * an uncapped `remaining` list — every article was mounted and every one
 * re-rendered, twice per share (open, then close), before the share sheet could
 * even mount. `onShare` is already a `useCallback` and `article` comes straight
 * out of the feed state, so the memo actually bails.
 *
 * ⚠️ Keep `onShare` referentially stable at the call site, or this memo is
 * decorative — a fresh closure per render defeats it entirely.
 */
const ArticleRow = React.memo(function ArticleRow({article, onShare}: {article: Article; onShare: (a: Article) => void}) {
  // Founder 2026-08-04 — no thumbnails (link previews resolved to aggregator
  // logos). The slimmer identity tile carries category + country instead, and
  // the freed width goes to the headline.
  return (
    <TouchableOpacity style={styles.articleCard} activeOpacity={0.9} onPress={() => openArticle(article.url)}>
      <View style={[styles.articleThumb, {backgroundColor: article.iconColor + '26'}]}>
        <Icon name={article.icon} size={22} color={article.iconColor} />
        <Text
          style={[styles.articleThumbRegion, {color: article.regionColor}]}
          numberOfLines={1}
          maxFontSizeMultiplier={1.1}>
          {article.region === 'GLOBAL' ? 'GLB' : article.region}
        </Text>
      </View>
      <View style={styles.articleInfo}>
        <Text style={[styles.articleCat, {color: article.regionColor}]} numberOfLines={1}>
          {article.cat}{article.time ? ` · ${article.time}` : ''}
        </Text>
        <Text style={styles.articleTitle} numberOfLines={2}>{article.title}</Text>
        <View style={styles.articleMeta}>
          <Text style={styles.articleSource} numberOfLines={1}>{article.source}</Text>
        </View>
      </View>
      <View style={styles.articleActions}>
        {/* Founder 2026-08-05 — share every headline into a Bravo chat or group.
            hitSlop because the glyph is small and sits beside the row's own
            press target; stopPropagation is implicit since this is a nested
            Touchable, but the explicit handler keeps "share" from also opening
            the article. */}
        {article.url ? (
          <TouchableOpacity
            onPress={() => onShare(article)}
            hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}
            accessibilityRole="button"
            accessibilityLabel={`Share: ${article.title}`}>
            <Icon name="share-variant" size={16} color="#5B8DEF" />
          </TouchableOpacity>
        ) : null}
        <Icon name="chevron-right" size={16} color="#475569" />
      </View>
    </TouchableOpacity>
  );
});

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex:1, backgroundColor:Colors.background},

  header: {flexDirection:'row', alignItems:'flex-start', justifyContent:'space-between', paddingHorizontal:16, paddingTop:6, paddingBottom:10, borderBottomWidth:1, borderBottomColor:'#1E2D45'},
  headerSub: {color:'#475569', fontSize:9, fontWeight:'800', letterSpacing:3, textTransform:'uppercase', marginBottom:2},
  headerTitleRow: {flexDirection:'row', alignItems:'center', gap:8},
  headerTitle: {flexShrink:1, minWidth:0, color:'#F1F5F9', fontSize:17, fontWeight:'800'},
  liveBadge: {flexShrink:0, flexDirection:'row', alignItems:'center', gap:4, paddingHorizontal:8, paddingVertical:3, borderRadius:99, backgroundColor:'rgba(34,197,94,0.12)', borderWidth:1, borderColor:'rgba(34,197,94,0.3)'},
  liveDot: {width:6, height:6, borderRadius:3, backgroundColor:'#22C55E'},
  liveBadgeText: {color:'#4ade80', fontSize:9, fontWeight:'800', letterSpacing:0.5},
  headerBtns: {flexDirection:'row', gap:4, marginTop:4},
  headerBtn: {width:36, height:36, borderRadius:18, alignItems:'center', justifyContent:'center'},


  breakingWrap: {paddingHorizontal:12, paddingVertical:8},
  breakingInner: {flexDirection:'row', alignItems:'center', gap:8, paddingHorizontal:12, paddingVertical:10, borderRadius:12, backgroundColor:'rgba(220,38,38,0.08)', borderWidth:1, borderColor:'rgba(220,38,38,0.2)', borderLeftWidth:3, borderLeftColor:'#DC2626'},
  breakingBadge: {backgroundColor:'#DC2626', borderRadius:4, paddingHorizontal:6, paddingVertical:2, flexShrink:0},
  breakingBadgeText: {color:'#FFF', fontSize:9, fontWeight:'800', letterSpacing:0.5, textTransform:'uppercase'},
  breakingText: {flex:1, color:'#E2E8F0', fontSize:12, fontWeight:'600'},
  breakingRead: {flexShrink:0},
  breakingReadText: {color:'#60A5FA', fontSize:12, fontWeight:'700'},

  // flexShrink:0 + feedScroll flex:1 — without them the column resolves the
  // feed's content-sized basis by shrinking BOTH scroll views, and the chip
  // strip loses most of its height (chips clipped mid-text, feed drawn over
  // them — founder screenshot on the unfolded Fold, B-348). The chip strip
  // must never shrink; the feed owns whatever height remains.
  filterScroll: {flexGrow:0, flexShrink:0},
  filterContent: {paddingHorizontal:12, paddingBottom:10, gap:8},
  feedScroll: {flex:1},
  chip: {paddingHorizontal:14, paddingVertical:5, borderRadius:99, borderWidth:1.5, borderColor:'#1E2D45'},
  chipActive: {backgroundColor:'rgba(37,99,235,0.15)', borderColor:Colors.primary},
  chipText: {color:'#64748B', fontSize:12, fontWeight:'700'},
  chipTextActive: {color:'#60A5FA'},

  // Capped + centered so unfolded/tablet widths don't stretch the column.
  content: {paddingHorizontal:12, paddingTop:4, gap:12, width:'100%', maxWidth:760, alignSelf:'center'},

  heroCard: {backgroundColor:'#0D1929', borderWidth:1, borderColor:'#1E2D45', borderRadius:16, overflow:'hidden'},
  heroImg: {height:180, backgroundColor:'#0D2240', alignItems:'center', justifyContent:'center', position:'relative', overflow:'hidden'},
  heroImgIcon: {opacity:0.12},
  heroImgOverlay: {position:'absolute', bottom:0, left:0, right:0, height:90, backgroundColor:'transparent'},
  heroBadges: {position:'absolute', top:12, left:12, flexDirection:'row', gap:6},
  catBadge: {paddingHorizontal:6, paddingVertical:2, borderRadius:4},
  catBadgeText: {color:'#FFF', fontSize:8, fontWeight:'800', letterSpacing:0.6, textTransform:'uppercase'},
  heroBody: {padding:14},
  heroTitle: {color:'#F1F5F9', fontSize:16, fontWeight:'800', lineHeight:22, marginBottom:6},
  heroMeta: {marginBottom:6},
  heroMetaText: {color:'#64748B', fontSize:10},
  heroSource: {color:'#94A3B8', fontWeight:'700'},
  heroSummary: {color:'#94A3B8', fontSize:12, lineHeight:18, marginBottom:10},
  readBtn: {alignSelf:'flex-start', paddingHorizontal:12, paddingVertical:6, borderRadius:8, backgroundColor:'rgba(37,99,235,0.15)', borderWidth:1, borderColor:'rgba(37,99,235,0.3)'},
  heroActions: {flexDirection:'row', alignItems:'center', gap:10},
  heroShareBtn: {flexDirection:'row', alignItems:'center', gap:6, paddingHorizontal:12, paddingVertical:6, borderRadius:8, borderWidth:1, borderColor:'rgba(91,141,239,0.35)'},
  heroShareText: {color:'#5B8DEF', fontSize:11, fontWeight:'800', letterSpacing:0.8},
  readBtnText: {color:'#60A5FA', fontSize:10, fontWeight:'800', letterSpacing:0.5},

  regionSection: {gap:10},
  regionHead: {flexDirection:'row', alignItems:'center', gap:8, paddingHorizontal:2, paddingTop:6},
  regionHeadTag: {paddingHorizontal:6, paddingVertical:2, borderRadius:4, borderWidth:1, borderColor:'rgba(37,99,235,0.3)', backgroundColor:'rgba(37,99,235,0.15)'},
  regionHeadTagText: {color:'#60A5FA', fontSize:10, fontWeight:'800'},
  regionHeadLabel: {color:'#F1F5F9', fontSize:13, fontWeight:'800', flexShrink:1},
  regionHeadHint: {color:'#475569', fontSize:9, fontWeight:'800', letterSpacing:1.5, flex:1},
  viewAllText: {color:'#60A5FA', fontSize:10, fontWeight:'800', letterSpacing:0.5},
  flatListLabel: {color:'#64748B', fontSize:10, fontWeight:'700', textTransform:'uppercase', letterSpacing:2, paddingHorizontal:2, paddingTop:6},
  catGroupLabel: {color:'#64748B', fontSize:10, fontWeight:'700', textTransform:'uppercase', letterSpacing:2, paddingHorizontal:2, paddingTop:6},

  // minHeight (not height) — fontScale 1.3 needs room for the 2-line title.
  articleCard: {flexDirection:'row', alignItems:'center', gap:12, backgroundColor:'#0D1929', borderWidth:1, borderColor:'#1E2D45', borderRadius:16, padding:10, minHeight:96},
  articleThumb: {width:56, alignSelf:'stretch', borderRadius:12, alignItems:'center', justifyContent:'center', gap:5, flexShrink:0},
  articleThumbRegion: {fontSize:9.5, fontWeight:'800', letterSpacing:0.8},
  articleInfo: {flex:1, justifyContent:'center'},
  articleCat: {fontSize:10, fontWeight:'700', textTransform:'uppercase', letterSpacing:0.5, marginBottom:4},
  articleTitle: {color:'#F1F5F9', fontSize:13, fontWeight:'700', lineHeight:18},
  articleMeta: {flexDirection:'row', marginTop:4},
  articleSource: {color:'#94A3B8', fontSize:10, fontWeight:'600', flexShrink:1},
  articleActions: {gap:10, flexShrink:0},
}));
